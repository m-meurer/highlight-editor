import { spawn } from 'child_process'
import { tmpdir } from 'os'
import { join } from 'path'
import { readFile, unlink } from 'fs/promises'
import ffmpegStatic from 'ffmpeg-static'
import ffprobeStatic from 'ffprobe-static'

// In a packaged app the binaries live in app.asar.unpacked, not inside the asar.
function unpacked(p) {
  return p ? p.replace('app.asar', 'app.asar.unpacked') : p
}

export const ffmpegPath = unpacked(ffmpegStatic)
export const ffprobePath = unpacked(ffprobeStatic.path)

export function probeVideo(filePath) {
  return new Promise((resolve, reject) => {
    // -show_streams gives width/height, r_frame_rate, tags.rotate and
    // side_data_list[].rotation, which we need to report DISPLAY dimensions
    // (ffmpeg and the browser both auto-rotate on decode).
    const args = ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', filePath]
    const proc = spawn(ffprobePath, args)
    let out = ''
    let err = ''
    proc.stdout.on('data', (d) => (out += d))
    proc.stderr.on('data', (d) => (err += d))
    proc.on('error', reject)
    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error(err || `ffprobe exited ${code}`))
      try {
        const json = JSON.parse(out)
        const video = (json.streams || []).find((s) => s.codec_type === 'video')
        let fps = 30
        if (video && video.r_frame_rate) {
          const [n, d] = video.r_frame_rate.split('/').map(Number)
          if (d) fps = n / d
        }

        // Detect rotation from tags or display-matrix side data.
        let rotation = 0
        if (video) {
          if (video.tags && video.tags.rotate != null) rotation = parseInt(video.tags.rotate, 10) || 0
          for (const sd of video.side_data_list || []) {
            if (sd.rotation != null) rotation = Math.round(sd.rotation)
          }
        }
        rotation = ((rotation % 360) + 360) % 360

        let width = video?.width || 0
        let height = video?.height || 0
        if (rotation === 90 || rotation === 270) [width, height] = [height, width]

        resolve({
          duration: parseFloat(json.format?.duration) || parseFloat(video?.duration) || 0,
          width,
          height,
          fps: Math.round(fps * 100) / 100
        })
      } catch (e) {
        reject(e)
      }
    })
  })
}

// Returns a base64 data URL for a single-frame thumbnail at the given time.
export async function generateThumbnail(filePath, timeSec) {
  const outPath = join(tmpdir(), `hl-thumb-${Date.now()}-${Math.random().toString(36).slice(2)}.jpg`)
  await new Promise((resolve, reject) => {
    const args = [
      '-ss', String(Math.max(0, timeSec)),
      '-i', filePath,
      '-frames:v', '1',
      '-vf', 'scale=320:-2',
      '-q:v', '4',
      '-y', outPath
    ]
    const proc = spawn(ffmpegPath, args)
    let err = ''
    proc.stderr.on('data', (d) => (err += d))
    proc.on('error', reject)
    proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err))))
  })
  try {
    const buf = await readFile(outPath)
    return `data:image/jpeg;base64,${buf.toString('base64')}`
  } finally {
    unlink(outPath).catch(() => {})
  }
}
