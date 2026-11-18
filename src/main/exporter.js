import { spawn } from 'child_process'
import { tmpdir } from 'os'
import { join } from 'path'
import { mkdtemp, writeFile, rm } from 'fs/promises'
import { ffmpegPath } from './ffmpeg.js'

let current = null // { procs: Set, canceled: bool }

export function cancelExport() {
  if (current) {
    current.canceled = true
    for (const p of current.procs) {
      try {
        p.kill('SIGKILL')
      } catch {}
    }
  }
}

function runFfmpeg(args, onStderr) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, args)
    if (current) current.procs.add(proc)
    let err = ''
    proc.stderr.on('data', (d) => {
      const s = d.toString()
      err += s
      if (onStderr) onStderr(s)
    })
    proc.on('error', reject)
    proc.on('close', (code) => {
      if (current) current.procs.delete(proc)
      if (code === 0) resolve()
      else if (current && current.canceled) reject(new Error('canceled'))
      else reject(new Error(err.split('\n').slice(-15).join('\n')))
    })
  })
}

// Canvas dimensions from aspect + target height.
function canvasSize(aspect, height) {
  const h = height || 1080
  if (aspect === '9:16') return { w: Math.round((h * 9) / 16 / 2) * 2, h }
  return { w: Math.round((h * 16) / 9 / 2) * 2, h }
}

// atempo only accepts 0.5..2.0, so chain factors for stronger slow-mo.
function atempoChain(speed) {
  if (speed >= 1) return `atempo=${speed}`
  const parts = []
  let s = speed
  while (s < 0.5) {
    parts.push('atempo=0.5')
    s /= 0.5
  }
  parts.push(`atempo=${s.toFixed(4)}`)
  return parts.join(',')
}

// Build the video filter chain for one normalized clip segment.
function buildClipVideoFilter(clip, canvas, fps) {
  const chain = []
  const c = clip.crop
  if (c && c.w > 0 && c.h > 0) {
    // Normalized crop (0..1) of the source -> punch-in on the player.
    chain.push(`crop=in_w*${c.w}:in_h*${c.h}:in_w*${c.x}:in_h*${c.y}`)
  }
  // Scale to COVER the canvas, then center-crop to exact size, so the frame is
  // always filled edge-to-edge (no letterbox/pillarbox bars) with no stretching.
  chain.push(`scale=${canvas.w}:${canvas.h}:force_original_aspect_ratio=increase`)
  chain.push(`crop=${canvas.w}:${canvas.h}`)
  chain.push('setsar=1')

  const speed = clip.slowmo && clip.slowmo < 1 ? clip.slowmo : 1
  if (speed < 1) chain.push(`setpts=${(1 / speed).toFixed(4)}*PTS`)

  chain.push(`fps=${fps}`)

  const intro = clip.intro || { type: 'none' }
  const d = intro.durationSec || 0.8
  if (intro.type === 'freeze') {
    chain.push(`tpad=start_duration=${d}:start_mode=clone`)
  } else if (intro.type === 'flash') {
    chain.push(`fade=t=in:st=0:d=${Math.min(0.4, d)}:color=white`)
  } else if (intro.type === 'zoom') {
    // Quick punch-in that eases back to 1x over the intro window.
    chain.push(
      `zoompan=z='if(lte(on,${Math.round(d * fps)}),1.25-0.25*on/${Math.round(d * fps)},1)':d=1:s=${canvas.w}x${canvas.h}:fps=${fps}`
    )
  } else if (intro.type === 'spotlight') {
    chain.push(`vignette=PI/4:enable='lte(t,${d})'`)
  }
  return chain.join(',')
}

async function overlaysToFiles(dir, overlays) {
  const files = []
  for (let i = 0; i < (overlays || []).length; i++) {
    const o = overlays[i]
    if (!o.pngDataUrl) continue
    const b64 = o.pngDataUrl.split(',')[1]
    const p = join(dir, `ovl-${i}.png`)
    await writeFile(p, Buffer.from(b64, 'base64'))
    files.push({ path: p, startSec: o.startSec || 0, endSec: o.endSec })
  }
  return files
}

// Insert a D-second held frame at output time T into video stream [base] -> [vfz].
function pushFreezeVideo(filters, T, D, fps) {
  const one = 1 / fps
  if (T <= one) {
    // Freeze at the very start: clone the first frame ahead of the clip.
    filters.push(`[base]tpad=start_duration=${D.toFixed(4)}:start_mode=clone[vfz]`)
    return 'vfz'
  }
  // Mid-clip: split around T, hold one frame, concat.
  const hold = `trim=${T.toFixed(4)}:${(T + one).toFixed(4)},setpts=PTS-STARTPTS,tpad=stop_duration=${D.toFixed(4)}:stop_mode=clone,trim=0:${D.toFixed(4)},setpts=PTS-STARTPTS`
  filters.push(`[base]split=3[bfa][bff][bfb]`)
  filters.push(`[bfa]trim=0:${T.toFixed(4)},setpts=PTS-STARTPTS[va]`)
  filters.push(`[bff]${hold}[vh]`)
  filters.push(`[bfb]trim=${T.toFixed(4)},setpts=PTS-STARTPTS[vb]`)
  filters.push(`[va][vh][vb]concat=n=3:v=1[vfz]`)
  return 'vfz'
}

// Insert D seconds of silence at time T into audio stream [a0] -> [afz].
function pushFreezeAudio(filters, T, D) {
  if (T <= 1e-3) {
    // Prepend D seconds of silence so audio stays aligned with the start freeze.
    filters.push(`[a0]adelay=${Math.round(D * 1000)}:all=1[afz]`)
    return 'afz'
  }
  filters.push(`aevalsrc=0:d=${D.toFixed(4)}:s=48000:channel_layout=stereo[asil]`)
  filters.push(`[a0]asplit=2[a0a][a0b]`)
  filters.push(`[a0a]atrim=0:${T.toFixed(4)},asetpts=PTS-STARTPTS[aa]`)
  filters.push(`[a0b]atrim=${T.toFixed(4)},asetpts=PTS-STARTPTS[ab]`)
  filters.push(`[aa][asil][ab]concat=n=3:v=0:a=1[afz]`)
  return 'afz'
}

// Encode one clip to a normalized segment file.
async function encodeClipSegment(clip, canvas, fps, dir, index, onStderr) {
  const outPath = join(dir, `seg-${String(index).padStart(3, '0')}.mp4`)
  const speed = clip.slowmo && clip.slowmo < 1 ? clip.slowmo : 1
  const trimDur = Math.max(0.1, (clip.outSec || 0) - (clip.inSec || 0))

  const overlayFiles = await overlaysToFiles(dir, clip.overlays)

  const inputs = ['-ss', String(clip.inSec || 0), '-t', String(trimDur), '-i', clip.src]
  for (const f of overlayFiles) inputs.push('-i', f.path)

  const filters = []
  filters.push(`[0:v]${buildClipVideoFilter(clip, canvas, fps)}[base]`)
  let lastVideo = 'base'

  // Optional freeze-frame held at output time T (e.g. to hold on the player
  // while the highlight marker is shown), inserted mid-clip.
  const freeze = clip.freeze && clip.freeze.durationSec > 0 ? clip.freeze : null
  if (freeze) {
    lastVideo = pushFreezeVideo(filters, Math.max(0, freeze.atSec || 0), freeze.durationSec, fps)
  }

  overlayFiles.forEach((f, i) => {
    const inLabel = `${i + 1}:v`
    const outLabel = `ov${i}`
    // Overlay input index = i+1. Timing is in output (post-slowmo) seconds.
    let enable = ''
    if (f.endSec != null) enable = `:enable='between(t,${f.startSec},${f.endSec})'`
    else if (f.startSec) enable = `:enable='gte(t,${f.startSec})'`
    filters.push(`[${lastVideo}][${inLabel}]overlay=(W-w)/2:(H-h)/2${enable}[${outLabel}]`)
    lastVideo = outLabel
  })

  // Audio: trim, adjust tempo for slow-mo, resample to a common format.
  const aChain = ['aresample=48000']
  if (speed < 1) aChain.unshift(atempoChain(speed))
  let audioOut = 'aout'
  if (freeze) {
    filters.push(`[0:a]${aChain.join(',')}[a0]`)
    audioOut = pushFreezeAudio(filters, Math.max(0, freeze.atSec || 0), freeze.durationSec)
  } else {
    filters.push(`[0:a]${aChain.join(',')}[aout]`)
  }

  const args = [
    ...inputs,
    '-filter_complex', filters.join(';'),
    '-map', `[${lastVideo}]`,
    '-map', `[${audioOut}]?`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2',
    '-r', String(fps),
    '-video_track_timescale', '90000',
    '-shortest',
    '-y', outPath
  ]
  await runFfmpeg(args, onStderr)
  return outPath
}

// Build a still-image slate (title or outro) into a segment of given duration.
async function encodeSlateSegment(slate, canvas, fps, dir, index) {
  const outPath = join(dir, `seg-${String(index).padStart(3, '0')}.mp4`)
  const dur = slate.durationSec || 4
  const bg = join(dir, `slate-${index}.png`)
  const b64 = slate.pngDataUrl.split(',')[1]
  await writeFile(bg, Buffer.from(b64, 'base64'))
  const args = [
    '-loop', '1', '-t', String(dur), '-i', bg,
    '-f', 'lavfi', '-t', String(dur), '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000',
    '-vf', `scale=${canvas.w}:${canvas.h},format=yuv420p,fps=${fps}`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18',
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2',
    '-r', String(fps),
    '-video_track_timescale', '90000',
    '-y', outPath
  ]
  await runFfmpeg(args)
  return outPath
}

export async function runExport(spec, onProgress) {
  current = { procs: new Set(), canceled: false }
  const dir = await mkdtemp(join(tmpdir(), 'hl-export-'))
  try {
    const canvas = canvasSize(spec.aspect, spec.resolution)
    const fps = spec.fps || 30
    const segments = []

    const tasks = []
    if (spec.intro && spec.intro.enabled && spec.intro.pngDataUrl)
      tasks.push({ kind: 'slate', data: spec.intro })
    for (const clip of spec.clips || []) tasks.push({ kind: 'clip', data: clip })
    if (spec.outro && spec.outro.enabled && spec.outro.pngDataUrl)
      tasks.push({ kind: 'slate', data: spec.outro })

    const total = tasks.length + 1 // + final concat/mux
    let done = 0
    let segIndex = 0

    for (const task of tasks) {
      if (current.canceled) throw new Error('canceled')
      onProgress({ phase: 'segment', label: task.kind === 'slate' ? 'Rendering slate' : 'Rendering clip', done, total })
      let seg
      if (task.kind === 'slate') seg = await encodeSlateSegment(task.data, canvas, fps, dir, segIndex++)
      else seg = await encodeClipSegment(task.data, canvas, fps, dir, segIndex++)
      segments.push(seg)
      done++
    }

    if (segments.length === 0) throw new Error('Nothing to export — add at least one clip.')

    // Concat via demuxer (all segments share identical codec params).
    const listPath = join(dir, 'concat.txt')
    await writeFile(listPath, segments.map((s) => `file '${s.replace(/'/g, "'\\''")}'`).join('\n'))

    onProgress({ phase: 'concat', label: 'Combining and adding music', done, total })

    const finalArgs = ['-f', 'concat', '-safe', '0', '-i', listPath]
    const hasMusic = spec.music && spec.music.path
    if (hasMusic) finalArgs.push('-i', spec.music.path)

    if (hasMusic) {
      const musicVol = spec.music.volume != null ? spec.music.volume : 0.3
      // Duck original audio up, music down; mix. Music trimmed to video length.
      finalArgs.push(
        '-filter_complex',
        `[0:a]volume=1.0[a0];[1:a]volume=${musicVol}[a1];[a0][a1]amix=inputs=2:duration=first:dropout_transition=0[aout]`,
        '-map', '0:v', '-map', '[aout]'
      )
    } else {
      finalArgs.push('-map', '0:v', '-map', '0:a?')
    }

    finalArgs.push(
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '192k',
      '-movflags', '+faststart',
      '-y', spec.outputPath
    )

    // Parse ffmpeg time= for finer progress during the final pass.
    const totalOutSec = estimateDuration(spec)
    await runFfmpeg(finalArgs, (s) => {
      const m = s.match(/time=(\d+):(\d+):(\d+\.\d+)/)
      if (m && totalOutSec > 0) {
        const t = (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3])
        onProgress({ phase: 'concat', label: 'Combining and adding music', done, total, subPct: Math.min(1, t / totalOutSec) })
      }
    })

    onProgress({ phase: 'done', label: 'Done', done: total, total })
    return { ok: true, outputPath: spec.outputPath }
  } catch (e) {
    if (current && current.canceled) return { ok: false, canceled: true }
    return { ok: false, error: String(e.message || e) }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
    current = null
  }
}

function estimateDuration(spec) {
  let t = 0
  if (spec.intro && spec.intro.enabled) t += spec.intro.durationSec || 4
  for (const c of spec.clips || []) {
    const base = Math.max(0.1, (c.outSec || 0) - (c.inSec || 0))
    const speed = c.slowmo && c.slowmo < 1 ? c.slowmo : 1
    let d = base / speed
    if (c.intro && c.intro.type === 'freeze') d += c.intro.durationSec || 0.8
    if (c.freeze && c.freeze.durationSec > 0) d += c.freeze.durationSec
    t += d
  }
  if (spec.outro && spec.outro.enabled) t += spec.outro.durationSec || 4
  return t
}
