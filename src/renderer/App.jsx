import React, { useState, useRef, useEffect, useCallback } from 'react'
import {
  renderLowerThird,
  renderPlayerCard,
  renderTitleSlate,
  renderOutroSlate,
  renderPlayerHighlight
} from './render.js'

const uid = () => Math.random().toString(36).slice(2, 10)
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))
const fmt = (s) => {
  if (!isFinite(s)) return '0:00'
  const m = Math.floor(s / 60)
  const sec = Math.floor(s % 60)
  return `${m}:${String(sec).padStart(2, '0')}`
}
// Tenths precision, e.g. 1:07.3
const fmt1 = (s) => {
  if (!isFinite(s)) return '0:00.0'
  const m = Math.floor(s / 60)
  const sec = s % 60
  return `${m}:${sec.toFixed(1).padStart(4, '0')}`
}

const INTRO_EFFECTS = [
  { value: 'none', label: 'None' },
  { value: 'freeze', label: 'Freeze-frame → play' },
  { value: 'zoom', label: 'Zoom punch-in' },
  { value: 'flash', label: 'Flash' }
]

const HIGHLIGHT_STYLES = [
  { value: 'spotlight', label: 'Spotlight (dim rest)' },
  { value: 'ring', label: 'Ring around him' },
  { value: 'arrow', label: 'Arrow pointing at him' }
]

const defaultProject = () => ({
  player: {
    name: '',
    number: '',
    position: '',
    gradYear: '',
    height: '',
    team: '',
    gpa: '',
    contact: '',
    accent: '#39d98a'
  },
  clips: [],
  intro: { enabled: true, durationSec: 4 },
  outro: { enabled: true, durationSec: 5 },
  music: null,
  export: { aspect: '16:9', resolution: 1080, fps: 30 }
})

const newClip = (src, name, meta) => ({
  id: uid(),
  src,
  name,
  duration: meta.duration || 0,
  width: meta.width || 0,
  height: meta.height || 0,
  fps: meta.fps || 30,
  inSec: 0,
  outSec: Math.min(meta.duration || 6, meta.duration || 6),
  slowmo: 1,
  crop: null, // {x,y,w,h} normalized
  intro: { type: 'none', durationSec: 0.8 },
  overlays: [],
  showPlayerCard: false,
  playerCardDuration: 3.5,
  highlight: { enabled: false, x: 0.5, y: 0.5, style: 'spotlight', size: 0.16, startSec: 0, durationSec: 1.5, freeze: true }
})

// Backfill any fields missing from an older saved clip so the UI never
// reads undefined nested objects.
function normalizeClip(c) {
  const d = newClip(c.src, c.name, c)
  return {
    ...d,
    ...c,
    intro: { ...d.intro, ...(c.intro || {}) },
    highlight: { ...d.highlight, ...(c.highlight || {}) },
    overlays: c.overlays || []
  }
}

export default function App() {
  const [project, setProject] = useState(defaultProject)
  const [selectedId, setSelectedId] = useState(null)
  const [tab, setTab] = useState('clip') // clip | player | reel
  const [exporting, setExporting] = useState(null) // {label, done, total, subPct}
  const [panelWidths, setPanelWidths] = useState(loadPanelWidths)
  const setPanelWidth = (side, w) => setPanelWidths((cur) => {
    const next = { ...cur, [side]: w }
    try { localStorage.setItem(PANEL_WIDTHS_KEY, JSON.stringify(next)) } catch {}
    return next
  })
  const exportingRef = useRef(null)
  exportingRef.current = exporting
  const [busy, setBusy] = useState('')
  const [projectPath, setProjectPath] = useState(null)
  const [playhead, setPlayhead] = useState(0) // preview playhead in source seconds
  const [dirty, setDirty] = useState(false)
  const [missing, setMissing] = useState({}) // { [src]: true } for clips whose file is gone
  const [thumbs, setThumbs] = useState({}) // { [clipId]: dataUrl } — not persisted
  const savedSnapshot = useRef(null) // serialized project as last saved/opened/new

  const selected = project.clips.find((c) => c.id === selectedId) || null

  // Dropping a file anywhere outside the clips sidebar would otherwise make Electron
  // navigate the window to that file and lose the project.
  useEffect(() => {
    const block = (e) => {
      if (e.defaultPrevented) return // the clips sidebar already accepted it
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'none'
    }
    window.addEventListener('dragover', block)
    window.addEventListener('drop', block)
    return () => {
      window.removeEventListener('dragover', block)
      window.removeEventListener('drop', block)
    }
  }, [])

  // Dirty = project differs from the last saved/loaded snapshot.
  useEffect(() => {
    const cur = JSON.stringify(project)
    if (savedSnapshot.current === null) {
      savedSnapshot.current = cur
      return
    }
    setDirty(cur !== savedSnapshot.current)
  }, [project])

  const markSaved = useCallback((p) => {
    savedSnapshot.current = JSON.stringify(p)
    setDirty(false)
  }, [])

  const toast = useCallback((msg) => {
    setBusy(msg)
    setTimeout(() => setBusy(''), 1600)
  }, [])

  const genThumb = useCallback(async (clip) => {
    const t = clip.inSec > 0.2 ? clip.inSec : Math.min(1, (clip.duration || 2) / 2)
    try {
      const url = await window.api.thumbnail(clip.src, t)
      setThumbs((m) => ({ ...m, [clip.id]: url }))
    } catch {
      /* ignore — clip still usable without a thumbnail */
    }
  }, [])

  const checkMissing = useCallback(async (clips) => {
    const paths = [...new Set(clips.map((c) => c.src))]
    if (!paths.length) return setMissing({})
    const present = await window.api.checkPaths(paths)
    const miss = {}
    for (const p of paths) if (!present[p]) miss[p] = true
    setMissing(miss)
  }, [])

  const updateProject = useCallback((patch) => {
    setProject((p) => ({ ...p, ...(typeof patch === 'function' ? patch(p) : patch) }))
  }, [])

  const updateClip = useCallback((id, patch) => {
    setProject((p) => ({
      ...p,
      clips: p.clips.map((c) => (c.id === id ? { ...c, ...(typeof patch === 'function' ? patch(c) : patch) } : c))
    }))
  }, [])

  async function importVideos() {
    const paths = await window.api.openVideos()
    await addVideoPaths(paths)
  }

  // Files dropped from Finder/Explorer onto the clips sidebar. Non-video files are skipped.
  async function importDroppedFiles(files) {
    const paths = []
    for (const f of files) {
      const path = window.api.getPathForFile(f)
      if (path && isVideoPath(path)) paths.push(path)
    }
    await addVideoPaths(paths)
  }

  async function addVideoPaths(paths) {
    if (!paths || !paths.length) return
    setBusy('Reading video files…')
    const added = []
    for (const path of paths) {
      try {
        const meta = await window.api.probe(path)
        const name = path.split(/[\\/]/).pop()
        added.push(newClip(path, name, meta))
      } catch (e) {
        console.error('probe failed', path, e)
      }
    }
    setBusy('')
    setProject((p) => ({ ...p, clips: [...p.clips, ...added] }))
    if (added.length && !selectedId) setSelectedId(added[0].id)
    added.forEach(genThumb)
  }

  function removeClip(id) {
    setProject((p) => ({ ...p, clips: p.clips.filter((c) => c.id !== id) }))
    if (selectedId === id) setSelectedId(null)
  }

  // Drag-to-reorder from the clips sidebar: move clip `id` so it lands at
  // position `toIndex` in the list as it was before the move.
  function reorderClip(id, toIndex) {
    setProject((p) => {
      const from = p.clips.findIndex((c) => c.id === id)
      if (from < 0) return p
      const to = toIndex > from ? toIndex - 1 : toIndex
      if (to === from) return p
      const clips = [...p.clips]
      const [moved] = clips.splice(from, 1)
      clips.splice(to, 0, moved)
      return { ...p, clips }
    })
  }

  async function chooseMusic() {
    const path = await window.api.openAudio()
    if (!path) return
    updateProject({ music: { path, name: path.split(/[\\/]/).pop(), volume: 0.3 } })
  }

  async function saveProject(forceDialog = false) {
    const json = JSON.stringify(project, null, 2)
    if (projectPath && !forceDialog) {
      await window.api.saveProjectTo(projectPath, json)
      markSaved(project)
      toast('Saved')
      return
    }
    const saved = await window.api.saveProject(json)
    if (saved) {
      setProjectPath(saved)
      markSaved(project)
      toast('Saved')
    }
  }

  // filePath: open that file directly (from Finder/Explorer); otherwise show the Open dialog.
  async function openProject(filePath) {
    if (dirty && !window.confirm('Discard unsaved changes to the current project?')) return
    let res
    try {
      res = await window.api.openProject(typeof filePath === 'string' ? filePath : undefined)
    } catch (e) {
      alert('Could not open project: ' + e.message)
      return
    }
    if (!res) return
    try {
      const loaded = JSON.parse(res.data)
      const base = defaultProject()
      const merged = { ...base, ...loaded }
      merged.clips = (loaded.clips || []).map((c) => normalizeClip(c))
      markSaved(merged)
      setProject(merged)
      setProjectPath(res.path)
      setSelectedId(merged.clips[0]?.id || null)
      setThumbs({})
      checkMissing(merged.clips)
      merged.clips.forEach(genThumb)
      // Refresh source dimensions so older projects pick up the rotation fix.
      merged.clips.forEach((c) => {
        window.api
          .probe(c.src)
          .then((meta) => {
            if (meta && meta.width && (meta.width !== c.width || meta.height !== c.height)) {
              updateClip(c.id, { width: meta.width, height: meta.height, fps: meta.fps || c.fps })
            }
          })
          .catch(() => {})
      })
    } catch (e) {
      alert('Could not open project: ' + e.message)
    }
  }

  function newProject() {
    if (dirty && !window.confirm('Discard unsaved changes and start a new project?')) return
    const fresh = defaultProject()
    markSaved(fresh)
    setProject(fresh)
    setProjectPath(null)
    setSelectedId(null)
    setMissing({})
  }

  async function relinkClip(clip) {
    const p = await window.api.relinkVideo(clip.name)
    if (!p) return
    try {
      const meta = await window.api.probe(p)
      updateClip(clip.id, {
        src: p,
        name: p.split(/[\\/]/).pop(),
        duration: meta.duration || clip.duration,
        width: meta.width || clip.width,
        height: meta.height || clip.height,
        fps: meta.fps || clip.fps,
        outSec: Math.min(clip.outSec, meta.duration || clip.outSec)
      })
      setMissing((m) => {
        const n = { ...m }
        delete n[clip.src]
        return n
      })
      genThumb({ ...clip, src: p })
    } catch (e) {
      alert('Could not read that file: ' + e.message)
    }
  }

  // Build the export spec: render slates + overlays to PNGs at canvas size.
  function buildSpec(outputPath) {
    const { aspect, resolution, fps } = project.export
    const h = resolution
    const w = aspect === '9:16' ? Math.round((h * 9) / 16 / 2) * 2 : Math.round((h * 16) / 9 / 2) * 2
    const accent = project.player.accent

    const clips = project.clips.map((c) => {
      const overlays = []
      const speed = c.slowmo && c.slowmo < 1 ? c.slowmo : 1
      const hlEnabled = c.highlight && c.highlight.enabled
      const hlDur = (c.highlight && c.highlight.durationSec) || 1.5
      const wantHlFreeze = hlEnabled && c.highlight.freeze
      // A start-of-clip intro freeze shifts everything after it. A highlight
      // freeze REPLACES an intro freeze so the two never stack.
      const introFreeze = c.intro && c.intro.type === 'freeze' ? c.intro.durationSec || 0.8 : 0
      const clipIntro = wantHlFreeze && introFreeze ? { type: 'none', durationSec: 0 } : c.intro
      const timelineOffset = wantHlFreeze && introFreeze ? 0 : introFreeze
      // Highlight start in the exported (post-slow-mo, post-intro) timeline.
      const hlStartOut = hlEnabled ? timelineOffset + (c.highlight.startSec || 0) / speed : 0
      // If "freeze while shown" is on, hold the frame at that time for the
      // highlight's duration — works anywhere in the clip, not just the start.
      const clipFreeze = wantHlFreeze ? { atSec: hlStartOut, durationSec: hlDur } : null
      // Player highlight sits behind text so it never covers the name card.
      if (hlEnabled) {
        const { cx, cy } = highlightPixel(c, w, h)
        overlays.push({
          pngDataUrl: renderPlayerHighlight({
            w,
            h,
            cx,
            cy,
            r: (c.highlight.size || 0.16) * h,
            style: c.highlight.style || 'spotlight',
            accent
          }),
          startSec: hlStartOut,
          endSec: hlStartOut + hlDur
        })
      }
      if (c.showPlayerCard && (project.player.name || project.player.number)) {
        overlays.push({
          pngDataUrl: renderPlayerCard({ w, h, player: project.player, accent }),
          startSec: 0,
          endSec: c.playerCardDuration || 3.5
        })
      }
      for (const o of c.overlays) {
        overlays.push({
          pngDataUrl: renderLowerThird({
            w,
            h,
            text: o.text,
            subtext: o.subtext,
            position: o.position || 'lower',
            accent
          }),
          startSec: o.startSec || 0,
          endSec: o.endSec != null ? o.endSec : undefined
        })
      }
      return {
        src: c.src,
        inSec: c.inSec,
        outSec: c.outSec,
        slowmo: c.slowmo,
        crop: c.crop,
        intro: clipIntro,
        freeze: clipFreeze,
        overlays
      }
    })

    const spec = {
      outputPath,
      aspect,
      resolution,
      fps,
      clips,
      player: project.player,
      intro: project.intro.enabled
        ? {
            enabled: true,
            durationSec: project.intro.durationSec,
            pngDataUrl: renderTitleSlate({ w, h, player: project.player, accent, title: '' })
          }
        : { enabled: false },
      outro: project.outro.enabled
        ? {
            enabled: true,
            durationSec: project.outro.durationSec,
            pngDataUrl: renderOutroSlate({ w, h, player: project.player, accent })
          }
        : { enabled: false },
      music: project.music
    }
    return spec
  }

  async function doExport() {
    if (!project.clips.length) {
      alert('Add at least one clip first.')
      return
    }
    const suggested = (project.player.name || 'highlight-reel').replace(/\s+/g, '-').toLowerCase() + '.mp4'
    const outputPath = await window.api.chooseExportPath(suggested)
    if (!outputPath) return
    const spec = buildSpec(outputPath)
    setExporting({ label: 'Starting…', done: 0, total: 1 })
    const off = window.api.onExportProgress((p) => setExporting(p))
    const res = await window.api.runExport(spec)
    off()
    setExporting(null)
    if (res.ok) {
      alert('Export complete:\n' + res.outputPath)
    } else if (res.canceled) {
      // silent
    } else {
      alert('Export failed:\n' + res.error)
    }
  }

  // File menu (native menu bar). Its shortcuts (Cmd/Ctrl+N, O, S, Shift+S, I,
  // E) replace the old keydown handler. A ref keeps the handlers current, since
  // they close over project state.
  const menuHandlers = useRef({})
  menuHandlers.current = {
    new: newProject,
    open: openProject,
    save: () => saveProject(false),
    saveAs: () => saveProject(true),
    import: importVideos,
    music: chooseMusic,
    export: doExport,
    openPath: (filePath) => openProject(filePath)
  }
  useEffect(() => {
    const off = window.api.onMenuCommand((command, arg) => {
      if (exportingRef.current) return // ignore while an export is running
      const fn = menuHandlers.current[command]
      if (fn) fn(arg)
    })
    // A .hlp double-clicked in Finder/Explorer before the window was ready.
    window.api.takePendingOpen().then((p) => {
      if (p) menuHandlers.current.openPath(p)
    })
    return off
  }, [])

  const reelSeconds = estimateReel(project)
  const projectName = projectPath ? projectPath.split(/[\\/]/).pop() : 'Untitled project'

  return (
    <div className="app">
      <TopBar
        onSave={() => saveProject(false)}
        onExport={doExport}
        busy={busy}
        reelSeconds={reelSeconds}
        projectName={projectName}
        dirty={dirty}
      />
      <div className="body" style={{ gridTemplateColumns: `${panelWidths.left}px 1fr ${panelWidths.right}px` }}>
        <LibraryPanel
          resizer={<PanelResizer side="left" width={panelWidths.left} onResize={(w) => setPanelWidth('left', w)} />}
          clips={project.clips}
          selectedId={selectedId}
          onSelect={setSelectedId}
          onRemove={removeClip}
          onReorder={reorderClip}
          onImport={importVideos}
          onDropFiles={importDroppedFiles}
          missing={missing}
          onRelink={relinkClip}
          thumbs={thumbs}
        />
        <PreviewPanel clip={selected} player={project.player} aspect={project.export.aspect} onUpdateClip={updateClip} onTime={setPlayhead} />
        <div className="inspector">
          <PanelResizer side="right" width={panelWidths.right} onResize={(w) => setPanelWidth('right', w)} />
          <div className="tabs">
            <button className={tab === 'clip' ? 'on' : ''} onClick={() => setTab('clip')}>Clip</button>
            <button className={tab === 'player' ? 'on' : ''} onClick={() => setTab('player')}>Player</button>
            <button className={tab === 'reel' ? 'on' : ''} onClick={() => setTab('reel')}>Reel &amp; Export</button>
          </div>
          <div className="tab-body">
            {tab === 'clip' && (
              <ClipInspector clip={selected} currentTime={playhead} playerName={project.player.name} onUpdate={(patch) => selected && updateClip(selected.id, patch)} />
            )}
            {tab === 'player' && (
              <PlayerForm player={project.player} onUpdate={(patch) => updateProject((p) => ({ player: { ...p.player, ...patch } }))} />
            )}
            {tab === 'reel' && (
              <ReelPanel
                project={project}
                onUpdate={updateProject}
                onChooseMusic={chooseMusic}
                onExport={doExport}
              />
            )}
          </div>
        </div>
      </div>
      {exporting && <ExportOverlay state={exporting} onCancel={() => window.api.cancelExport()} />}
      {busy && !exporting && <div className="toast">{busy}</div>}
    </div>
  )
}

// Source seconds in the trimmed clip.
function clipTrimSeconds(clip) {
  return Math.max(0.1, (clip.outSec || 0) - (clip.inSec || 0))
}

// Map a highlight's normalized source-frame position to an output pixel,
// accounting for per-clip crop (punch-in) then scale-to-COVER + center-crop.
function highlightPixel(clip, canvasW, canvasH) {
  const hl = clip.highlight
  const crop = clip.crop
  let nx = hl.x
  let ny = hl.y
  if (crop) {
    nx = (hl.x - crop.x) / crop.w
    ny = (hl.y - crop.y) / crop.h
  }
  const regW = (clip.width || 16) * (crop ? crop.w : 1)
  const regH = (clip.height || 9) * (crop ? crop.h : 1)
  const scale = Math.max(canvasW / regW, canvasH / regH) // cover
  const dispW = regW * scale
  const dispH = regH * scale
  const offX = (dispW - canvasW) / 2 // center-crop overflow
  const offY = (dispH - canvasH) / 2
  return { cx: clamp(nx, 0, 1) * dispW - offX, cy: clamp(ny, 0, 1) * dispH - offY }
}

function estimateReel(project) {
  let t = 0
  if (project.intro.enabled) t += project.intro.durationSec
  for (const c of project.clips) {
    const base = Math.max(0.1, c.outSec - c.inSec)
    const d = base / (c.slowmo < 1 ? c.slowmo : 1)
    t += d + (c.intro?.type === 'freeze' ? c.intro.durationSec : 0)
  }
  if (project.outro.enabled) t += project.outro.durationSec
  return t
}

const IS_MAC = navigator.platform.startsWith('Mac')

// New, Open, Save As and Import live in the File menu (see src/main/index.js).
function TopBar({ onSave, onExport, reelSeconds, projectName, dirty }) {
  return (
    <div className="topbar">
      <div className="brand">⚽ Highlight Editor</div>
      <div className="project-name" title={projectName}>
        {projectName}{dirty ? ' •' : ''}
      </div>
      <div className="spacer" />
      <div className="reel-len">Reel ≈ {fmt(reelSeconds)}{reelSeconds > 150 ? ' ⚠ long' : ''}</div>
      <button onClick={onSave} title={IS_MAC ? 'Save (⌘S)' : 'Save (Ctrl+S)'}>Save</button>
      <button className="primary" onClick={onExport}>Export Reel</button>
    </div>
  )
}

const VIDEO_EXTS = ['mp4', 'mov', 'm4v', 'avi', 'mkv', 'webm']
function isVideoPath(path) {
  const ext = path.split('.').pop().toLowerCase()
  return VIDEO_EXTS.includes(ext)
}

// Sidebar widths: draggable dividers, remembered between launches.
const PANEL_WIDTHS_KEY = 'panelWidths'
const PANEL_LIMITS = { left: { def: 260, min: 200, max: 520 }, right: { def: 340, min: 300, max: 640 } }
const MIN_CENTER = 420 // keep the preview usable

function loadPanelWidths() {
  const w = { left: PANEL_LIMITS.left.def, right: PANEL_LIMITS.right.def }
  try {
    const saved = JSON.parse(localStorage.getItem(PANEL_WIDTHS_KEY) || '{}')
    for (const k of ['left', 'right']) if (typeof saved[k] === 'number') w[k] = saved[k]
  } catch {}
  return w
}

// A thin handle on a sidebar's inner edge. Drag to resize; double-click resets.
function PanelResizer({ side, width, onResize }) {
  const { def, min, max } = PANEL_LIMITS[side]
  function onPointerDown(e) {
    e.preventDefault()
    const startX = e.clientX
    const startW = width
    const body = e.currentTarget.closest('.body')
    const other = side === 'left' ? body.lastElementChild : body.firstElementChild
    const room = body.clientWidth - other.offsetWidth - MIN_CENTER
    const move = (ev) => {
      const dx = side === 'left' ? ev.clientX - startX : startX - ev.clientX
      onResize(Math.round(Math.max(min, Math.min(max, room, startW + dx))))
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      document.body.classList.remove('resizing')
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    document.body.classList.add('resizing')
  }
  return (
    <div
      className={'panel-resizer ' + side}
      onPointerDown={onPointerDown}
      onDoubleClick={() => onResize(def)}
      title="Drag to resize (double-click to reset)"
    />
  )
}

// Custom drag type for reordering, so it never looks like a Finder file drop
// (that check looks for 'Files' in dataTransfer.types).
const CLIP_DRAG_TYPE = 'application/x-highlight-clip'

function LibraryPanel({ resizer, clips, selectedId, onSelect, onRemove, onReorder, onImport, onDropFiles, missing, onRelink, thumbs }) {
  const [dropActive, setDropActive] = useState(false)
  const dragDepth = useRef(0) // dragenter/leave fire for every child element

  // Reorder state: which clip is being dragged, and where it would land
  // (index in the list; the line is drawn above that row, or below the last).
  const [draggingId, setDraggingId] = useState(null)
  const [dropIndex, setDropIndex] = useState(null)
  const isClipDrag = (e) => Array.from(e.dataTransfer?.types || []).includes(CLIP_DRAG_TYPE)

  const rowDragProps = (c, i) => ({
    draggable: true,
    onDragStart: (e) => {
      e.dataTransfer.setData(CLIP_DRAG_TYPE, c.id)
      e.dataTransfer.effectAllowed = 'move'
      setDraggingId(c.id)
    },
    onDragEnd: () => {
      setDraggingId(null)
      setDropIndex(null)
    },
    onDragOver: (e) => {
      if (!isClipDrag(e)) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
      const r = e.currentTarget.getBoundingClientRect()
      setDropIndex(e.clientY < r.top + r.height / 2 ? i : i + 1)
    }
  })

  // The drop itself is handled on the list, so dropping in the gap between
  // rows works too (it uses the last line position shown).
  const listDropProps = {
    onDragOver: (e) => {
      if (!isClipDrag(e)) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
    },
    onDrop: (e) => {
      if (!isClipDrag(e)) return
      e.preventDefault()
      const id = e.dataTransfer.getData(CLIP_DRAG_TYPE)
      if (id && dropIndex != null) onReorder(id, dropIndex)
      setDraggingId(null)
      setDropIndex(null)
    }
  }

  const hasFiles = (e) => Array.from(e.dataTransfer?.types || []).includes('Files')

  const dropProps = {
    onDragEnter: (e) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      dragDepth.current += 1
      setDropActive(true)
    },
    onDragOver: (e) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
    },
    onDragLeave: (e) => {
      if (!hasFiles(e)) return
      dragDepth.current = Math.max(0, dragDepth.current - 1)
      if (dragDepth.current === 0) setDropActive(false)
    },
    onDrop: (e) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      dragDepth.current = 0
      setDropActive(false)
      onDropFiles(Array.from(e.dataTransfer.files))
    }
  }

  return (
    <div className={'library' + (dropActive ? ' drop-active' : '')} {...dropProps}>
      {resizer}
      {dropActive && <div className="drop-overlay">Drop videos to add clips</div>}
      <div className="panel-title">Clips ({clips.length})</div>
      <div className="hint">Order = play order. Put your best clips first.</div>
      <div className="clip-list" {...listDropProps}>
        {clips.length === 0 && <div className="empty">Import or drag videos here to begin.</div>}
        {clips.map((c, i) => {
          const gone = missing && missing[c.src]
          return (
            <div
              key={c.id}
              className={
                'clip-row' +
                (c.id === selectedId ? ' sel' : '') +
                (gone ? ' gone' : '') +
                (c.id === draggingId ? ' dragging' : '') +
                (draggingId && dropIndex === i ? ' drop-before' : '') +
                (draggingId && dropIndex === clips.length && i === clips.length - 1 ? ' drop-after' : '')
              }
              onClick={() => onSelect(c.id)}
              {...rowDragProps(c, i)}
            >
              <div className="clip-order">
                <div className="clip-idx">{i + 1}</div>
                <div className="drag-handle" title="Drag to reorder">
                  <svg width="12" height="8" viewBox="0 0 12 8" aria-hidden="true">
                    {[2, 6, 10].map((x) => (
                      <g key={x}><circle cx={x} cy="2" r="1.2" /><circle cx={x} cy="6" r="1.2" /></g>
                    ))}
                  </svg>
                </div>
              </div>
              <div className="clip-thumb">
                {thumbs && thumbs[c.id] ? <img src={thumbs[c.id]} alt="" draggable={false} /> : <div className="thumb-ph" />}
              </div>
              <div className="clip-meta">
                <div className="clip-name" title={c.src}>{c.name}</div>
                {gone ? (
                  <div className="clip-sub warn">
                    ⚠ File not found —
                    <button className="link" onClick={(e) => { e.stopPropagation(); onRelink(c) }}>Relink…</button>
                  </div>
                ) : (
                  <div className="clip-sub">
                    {fmt(c.outSec - c.inSec)} {c.slowmo < 1 ? `• ${c.slowmo}x` : ''} {c.intro?.type !== 'none' ? `• ${c.intro.type}` : ''} {c.highlight?.enabled ? '• 🎯' : ''}
                  </div>
                )}
              </div>
              <div className="clip-actions" onClick={(e) => e.stopPropagation()}>
                <button title="Remove" onClick={() => onRemove(c.id)}>✕</button>
              </div>
            </div>
          )
        })}
      </div>
      <button className="add-clip" onClick={onImport}>+ Add clips</button>
    </div>
  )
}

function PreviewPanel({ clip, player, aspect, onUpdateClip, onTime }) {
  const videoRef = useRef(null)
  const wrapRef = useRef(null)
  const [time, setTimeRaw] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [placing, setPlacing] = useState(false)
  const [zoomMode, setZoomMode] = useState(false)
  const [showZoom, setShowZoom] = useState(false) // preview the punch-in framing
  const [dragRect, setDragRect] = useState(null) // live rectangle while dragging (wrap px)
  const dragStart = useRef(null)
  const [contentRect, setContentRect] = useState(null)
  const [frozen, setFrozen] = useState(false) // showing the freeze pause in preview
  const freezeDoneRef = useRef(false)
  const freezeTimerRef = useRef(null)
  const playIntentRef = useRef(false)

  const setTime = (t) => {
    setTimeRaw(t)
    if (onTime) onTime(t)
  }

  const measure = useCallback(() => {
    const wrap = wrapRef.current
    const v = videoRef.current
    if (!wrap || !v || !v.videoWidth) return
    const wr = wrap.getBoundingClientRect()
    const vAspect = v.videoWidth / v.videoHeight
    const boxAspect = wr.width / wr.height
    let cw, ch
    if (vAspect > boxAspect) {
      cw = wr.width
      ch = cw / vAspect
    } else {
      ch = wr.height
      cw = ch * vAspect
    }
    setContentRect({ left: (wr.width - cw) / 2, top: (wr.height - ch) / 2, width: cw, height: ch })
  }, [])

  useEffect(() => {
    setPlaying(false)
    setPlacing(false)
    setZoomMode(false)
    setShowZoom(false)
    setDragRect(null)
    if (freezeTimerRef.current) clearTimeout(freezeTimerRef.current)
    freezeTimerRef.current = null
    freezeDoneRef.current = false
    playIntentRef.current = false
    setFrozen(false)
    if (videoRef.current) videoRef.current.currentTime = clip ? clip.inSec : 0
    setTime(clip ? clip.inSec : 0)
  }, [clip?.id])

  useEffect(() => () => { if (freezeTimerRef.current) clearTimeout(freezeTimerRef.current) }, [])

  // Re-measure whenever the preview area changes size: window resizes and
  // sidebar resizes both change it, but only the first fires 'resize'.
  const hasClip = !!clip
  useEffect(() => {
    const wrap = wrapRef.current
    if (!wrap) return
    const ro = new ResizeObserver(() => measure())
    ro.observe(wrap)
    return () => ro.disconnect()
  }, [measure, hasClip])

  if (!clip) {
    return (
      <div className="preview">
        <div className="preview-empty">Select a clip to preview and edit.</div>
      </div>
    )
  }

  const src = window.api.toMediaUrl(clip.src)
  const dur = clip.duration || 0
  const hl = clip.highlight

  // Seconds since this clip's trim-in — used to show overlays only during
  // their on-screen windows as you scrub, matching the exported result.
  const clipT = time - clip.inSec
  const hlStart = hl.startSec || 0
  // Match the export. With "freeze" on, the marker is shown only during the
  // held frame and is gone the moment motion resumes; while paused, it also
  // shows when you're parked on its start frame, so it can be placed. Without
  // freeze it stays up for durationSec of OUTPUT time, which is less source
  // time on a slowed-down clip (the preview plays at normal speed).
  const speed = clip.slowmo && clip.slowmo < 1 ? clip.slowmo : 1
  const atHlStart = clipT >= hlStart - 0.05 && clipT <= hlStart + 0.05
  const hlOn =
    hl.enabled &&
    (placing ||
      frozen ||
      (hl.freeze
        ? !playing && atHlStart
        : clipT >= hlStart - 0.05 && clipT <= hlStart + (hl.durationSec || 1.5) * speed))
  const cardOn =
    clip.showPlayerCard &&
    (player.name || player.number) &&
    clipT >= -0.05 &&
    clipT <= (clip.playerCardDuration || 3.5)

  const clearFreezeTimer = () => {
    if (freezeTimerRef.current) {
      clearTimeout(freezeTimerRef.current)
      freezeTimerRef.current = null
    }
    setFrozen(false)
  }

  const onTimeUpdate = () => {
    const v = videoRef.current
    if (!v) return
    setTime(v.currentTime)
    if (v.currentTime >= clip.outSec) {
      v.pause()
      setPlaying(false)
      return
    }
    // Simulate the export freeze: pause on the player when the marker appears.
    if (!v.paused && hl.enabled && hl.freeze && !freezeDoneRef.current) {
      if (v.currentTime - clip.inSec >= (hl.startSec || 0)) {
        freezeDoneRef.current = true
        v.pause()
        setFrozen(true)
        freezeTimerRef.current = setTimeout(() => {
          freezeTimerRef.current = null
          setFrozen(false)
          const vv = videoRef.current
          if (vv && playIntentRef.current && vv.currentTime < clip.outSec) vv.play()
        }, (hl.durationSec || 1.5) * 1000)
      }
    }
  }
  const togglePlay = () => {
    const v = videoRef.current
    if (!v) return
    if (v.paused && !frozen) {
      if (v.currentTime < clip.inSec || v.currentTime >= clip.outSec) v.currentTime = clip.inSec
      // Re-arm the freeze if we're starting before its trigger point.
      if (v.currentTime - clip.inSec < (hl.startSec || 0)) freezeDoneRef.current = false
      playIntentRef.current = true
      v.play()
      setPlaying(true)
    } else {
      clearFreezeTimer()
      playIntentRef.current = false
      v.pause()
      setPlaying(false)
    }
  }
  const seek = (t) => {
    const v = videoRef.current
    clearFreezeTimer()
    if (t - clip.inSec < (hl.startSec || 0)) freezeDoneRef.current = false
    if (v) v.currentTime = clamp(t, 0, dur)
    setTime(t)
  }

  const outAspect = aspect === '9:16' ? 9 / 16 : 16 / 9

  // Zoom-to-area: drag a box (constrained to the output shape) over the region.
  const onWrapMouseDown = (e) => {
    if (!zoomMode || !contentRect) return
    const wr = wrapRef.current.getBoundingClientRect()
    dragStart.current = { x: e.clientX - wr.left, y: e.clientY - wr.top }
    setDragRect(null)
  }
  const onWrapMouseMove = (e) => {
    if (!zoomMode || !dragStart.current) return
    const wr = wrapRef.current.getBoundingClientRect()
    const cx = e.clientX - wr.left
    const cy = e.clientY - wr.top
    let w = cx - dragStart.current.x
    const dir = cy - dragStart.current.y < 0 ? -1 : 1
    let h = (Math.abs(w) / outAspect) * dir // keep box at the export aspect ratio
    const rect = {
      left: w < 0 ? dragStart.current.x + w : dragStart.current.x,
      top: h < 0 ? dragStart.current.y + h : dragStart.current.y,
      width: Math.abs(w),
      height: Math.abs(h)
    }
    setDragRect(rect)
  }
  const onWrapMouseUp = () => {
    if (!zoomMode || !dragStart.current || !dragRect || !contentRect) {
      dragStart.current = null
      return
    }
    // Convert the drawn box (wrap px) to normalized source coords via the content rect.
    const nx = (dragRect.left - contentRect.left) / contentRect.width
    const ny = (dragRect.top - contentRect.top) / contentRect.height
    const nw = dragRect.width / contentRect.width
    const nh = dragRect.height / contentRect.height
    dragStart.current = null
    setDragRect(null)
    if (nw < 0.12 || nh < 0.12) return // too small — ignore
    onUpdateClip(clip.id, {
      crop: {
        x: clamp(nx, 0, 1 - nw),
        y: clamp(ny, 0, 1 - nh),
        w: clamp(nw, 0.1, 1),
        h: clamp(nh, 0.1, 1)
      }
    })
    setZoomMode(false)
  }

  const onVideoClick = (e) => {
    if (zoomMode) return
    if (!placing) return togglePlay()
    const wrap = wrapRef.current
    const rect = contentRect
    if (!wrap || !rect) return
    const wr = wrap.getBoundingClientRect()
    const fx = clamp((e.clientX - wr.left - rect.left) / rect.width, 0, 1)
    const fy = clamp((e.clientY - wr.top - rect.top) / rect.height, 0, 1)
    // If the zoomed framing is being previewed, the visible content is the
    // crop region, so map the click back through the crop to SOURCE coords.
    let nx = fx
    let ny = fy
    if (showZoom && clip.crop) {
      nx = clip.crop.x + fx * clip.crop.w
      ny = clip.crop.y + fy * clip.crop.h
    }
    onUpdateClip(clip.id, { highlight: { ...hl, enabled: true, x: nx, y: ny } })
    setPlacing(false)
  }

  // Punch-in framing preview: scale the video so the crop region fills its box.
  const zoomStyle = () => {
    if (!showZoom || !crop || !contentRect) return {}
    const sx = 1 / crop.w
    const sy = 1 / crop.h
    const tx = -crop.x * contentRect.width * sx
    const ty = -crop.y * contentRect.height * sy
    return { transform: `translate(${tx}px, ${ty}px) scale(${sx}, ${sy})`, transformOrigin: '0 0' }
  }

  const cropBoxStyle = () => {
    if (!contentRect) {
      return { left: `${crop.x * 100}%`, top: `${crop.y * 100}%`, width: `${crop.w * 100}%`, height: `${crop.h * 100}%` }
    }
    return {
      left: contentRect.left + crop.x * contentRect.width,
      top: contentRect.top + crop.y * contentRect.height,
      width: crop.w * contentRect.width,
      height: crop.h * contentRect.height
    }
  }

  // Marker position/size in preview pixels (falls back to % if unmeasured).
  // Mirrors the export mapping so what you see matches what renders.
  const markerStyle = () => {
    if (!contentRect) return { left: `${hl.x * 100}%`, top: `${hl.y * 100}%` }
    let fx = hl.x
    let fy = hl.y
    let d = hl.size * 2 * contentRect.height
    if (showZoom && clip.crop) {
      fx = (hl.x - clip.crop.x) / clip.crop.w
      fy = (hl.y - clip.crop.y) / clip.crop.h
      d = d / clip.crop.w // marker appears larger in the zoomed framing
    }
    return {
      left: contentRect.left + fx * contentRect.width - d / 2,
      top: contentRect.top + fy * contentRect.height - d / 2,
      width: d,
      height: d
    }
  }

  const crop = clip.crop
  return (
    <div className="preview">
      <div
        className={'video-wrap' + (placing || zoomMode ? ' placing' : '')}
        ref={wrapRef}
        onMouseDown={onWrapMouseDown}
        onMouseMove={onWrapMouseMove}
        onMouseUp={onWrapMouseUp}
        onMouseLeave={() => { dragStart.current = null; setDragRect(null) }}
      >
        <video
          ref={videoRef}
          src={src}
          style={zoomStyle()}
          onTimeUpdate={onTimeUpdate}
          onLoadedMetadata={() => {
            seek(clip.inSec)
            measure()
          }}
          onClick={onVideoClick}
        />
        {crop && !showZoom && <div className="crop-box" style={cropBoxStyle()} />}
        {hlOn && <div className={'hl-marker hl-' + hl.style} style={markerStyle()} />}
        {dragRect && (
          <div
            className="drag-rect"
            style={{ left: dragRect.left, top: dragRect.top, width: dragRect.width, height: dragRect.height }}
          />
        )}
        {placing && <div className="placing-hint">Click on {player.name || 'the player'}</div>}
        {zoomMode && !dragRect && <div className="placing-hint">Drag a box over the area to zoom into</div>}
        {frozen && <div className="freeze-badge">❚❚ Freeze — {(hl.durationSec || 1.5).toFixed(1)}s</div>}
        {cardOn && (
          <div className="ov-card">
            <span className="ov-accent" style={{ background: player.accent }} />
            <div>
              <div className="ov-name">{player.number ? `#${player.number} ` : ''}{player.name}</div>
              <div className="ov-sub">
                {[player.position, player.gradYear && `Class of ${player.gradYear}`, player.height].filter(Boolean).join('  •  ')}
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="transport">
        <button onClick={togglePlay}>{playing ? '⏸' : '▶'}</button>
        <span className="time">
          {fmt1(time)} / {fmt1(dur)}
          <span className="time-clip"> · {fmt1(clamp(clipT, 0, dur))} into clip</span>
        </span>
        <button className={placing ? 'on' : ''} onClick={() => { measure(); setPlacing((p) => !p); setZoomMode(false) }}>
          🎯 {hl.enabled ? 'Move highlight' : 'Mark player'}
        </button>
        <button className={zoomMode ? 'on' : ''} onClick={() => { setZoomMode((z) => !z); setPlacing(false) }}>
          🔍 Zoom to area
        </button>
        {clip.crop && (
          <button className={showZoom ? 'on' : ''} onClick={() => { setShowZoom((s) => !s); setZoomMode(false); setPlacing(false) }}>
            👁 {showZoom ? 'Show full frame' : 'Preview zoom'}
          </button>
        )}
        {clip.crop && <button title="Clear zoom" onClick={() => { onUpdateClip(clip.id, { crop: null }); setShowZoom(false) }}>Reset zoom</button>}
        <button onClick={() => onUpdateClip(clip.id, { inSec: clamp(time, 0, clip.outSec - 0.1) })}>Set In</button>
        <button onClick={() => onUpdateClip(clip.id, { outSec: clamp(time, clip.inSec + 0.1, dur) })}>Set Out</button>
      </div>

      <div className="scrubber">
        <input
          type="range"
          min={0}
          max={dur || 0}
          step={0.01}
          value={time}
          onChange={(e) => seek(parseFloat(e.target.value))}
        />
        <div
          className="trim-track"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect()
            seek(clamp((e.clientX - r.left) / r.width, 0, 1) * dur)
          }}
        >
          <div
            className="trim-range"
            style={{ left: `${(clip.inSec / dur) * 100}%`, width: `${((clip.outSec - clip.inSec) / dur) * 100}%` }}
          />
          <div className="playhead" style={{ left: `${(time / dur) * 100}%` }} />
        </div>
        <div className="trim-labels">
          <span>In {fmt1(clip.inSec)}</span>
          <span>Selected {fmt1(clip.outSec - clip.inSec)}</span>
          <span>Out {fmt1(clip.outSec)}</span>
        </div>
      </div>
    </div>
  )
}

function Field({ label, children }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  )
}

function ClipInspector({ clip, currentTime, playerName, onUpdate }) {
  if (!clip) return <div className="empty pad">Select a clip to edit its effects.</div>
  const crop = clip.crop
  const zoom = crop ? +(1 / crop.w).toFixed(2) : 1

  const setZoom = (z) => {
    if (z <= 1) return onUpdate({ crop: null })
    const w = 1 / z
    const hh = 1 / z
    const cur = clip.crop || { x: (1 - w) / 2, y: (1 - hh) / 2 }
    onUpdate({ crop: { w, h: hh, x: clamp(cur.x, 0, 1 - w), y: clamp(cur.y, 0, 1 - hh) } })
  }
  const setPan = (axis, val) => {
    if (!crop) return
    onUpdate({ crop: { ...crop, [axis]: clamp(val, 0, 1 - (axis === 'x' ? crop.w : crop.h)) } })
  }

  return (
    <div className="form">
      <Field label="Trim (seconds)">
        <div className="row">
          <input type="number" step="0.1" value={clip.inSec.toFixed(2)} onChange={(e) => onUpdate({ inSec: clamp(+e.target.value, 0, clip.outSec - 0.1) })} />
          <span className="dash">to</span>
          <input type="number" step="0.1" value={clip.outSec.toFixed(2)} onChange={(e) => onUpdate({ outSec: clamp(+e.target.value, clip.inSec + 0.1, clip.duration) })} />
        </div>
      </Field>

      <Field label="Intro effect (start of clip)">
        <select value={clip.intro.type} onChange={(e) => onUpdate({ intro: { ...clip.intro, type: e.target.value } })}>
          {INTRO_EFFECTS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </Field>
      {clip.intro.type !== 'none' && (
        <Field label={`Effect duration: ${clip.intro.durationSec.toFixed(1)}s`}>
          <input type="range" min="0.3" max="2.5" step="0.1" value={clip.intro.durationSec} onChange={(e) => onUpdate({ intro: { ...clip.intro, durationSec: +e.target.value } })} />
        </Field>
      )}

      <Field label="Speed">
        <div className="seg">
          {[1, 0.5, 0.25].map((s) => (
            <button key={s} className={clip.slowmo === s ? 'on' : ''} onClick={() => onUpdate({ slowmo: s })}>
              {s === 1 ? 'Normal' : `${s}x slow`}
            </button>
          ))}
        </div>
      </Field>

      <div className="divider" />
      <div className="subhead">Highlight the player</div>
      <label className="check">
        <input
          type="checkbox"
          checked={clip.highlight.enabled}
          onChange={(e) => onUpdate({ highlight: { ...clip.highlight, enabled: e.target.checked } })}
        />
        Highlight {playerName || 'the player'} on this clip
      </label>
      <div className="hint">Click <b>🎯 Mark player</b> on the preview, then click on him.</div>
      {clip.highlight.enabled && (
        <>
          <Field label="Style">
            <select value={clip.highlight.style} onChange={(e) => onUpdate({ highlight: { ...clip.highlight, style: e.target.value } })}>
              {HIGHLIGHT_STYLES.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </Field>
          <Field label={`Size: ${Math.round(clip.highlight.size * 100)}%`}>
            <input type="range" min="0.06" max="0.32" step="0.01" value={clip.highlight.size} onChange={(e) => onUpdate({ highlight: { ...clip.highlight, size: +e.target.value } })} />
          </Field>
          <Field label={`Appears at (seconds into clip, 0–${clipTrimSeconds(clip).toFixed(1)})`}>
            <div className="row">
              <input
                type="number"
                step="0.1"
                min="0"
                max={clipTrimSeconds(clip)}
                value={(clip.highlight.startSec || 0).toFixed(1)}
                onChange={(e) => onUpdate({ highlight: { ...clip.highlight, startSec: clamp(+e.target.value, 0, clipTrimSeconds(clip)) } })}
              />
              <span className="dash">s</span>
            </div>
            <input type="range" min="0" max={Math.max(0.5, clipTrimSeconds(clip))} step="0.1" value={clip.highlight.startSec || 0} onChange={(e) => onUpdate({ highlight: { ...clip.highlight, startSec: +e.target.value } })} />
          </Field>
          <button className="mini" onClick={() => onUpdate({ highlight: { ...clip.highlight, startSec: +clamp((currentTime || 0) - clip.inSec, 0, clipTrimSeconds(clip)).toFixed(2) } })}>
            Set to current playhead ({fmt1(clamp((currentTime || 0) - clip.inSec, 0, clipTrimSeconds(clip)))} into clip)
          </button>
          <Field label={`Hold on screen: ${clip.highlight.durationSec.toFixed(1)}s`}>
            <input type="range" min="0.5" max="4" step="0.1" value={clip.highlight.durationSec} onChange={(e) => onUpdate({ highlight: { ...clip.highlight, durationSec: +e.target.value } })} />
          </Field>
          <label className="check">
            <input type="checkbox" checked={clip.highlight.freeze} onChange={(e) => onUpdate({ highlight: { ...clip.highlight, freeze: e.target.checked } })} />
            Freeze the frame while shown (pause on him)
          </label>
          <div className="hint">{clip.highlight.freeze ? 'The clip pauses on him at that moment for the hold time, then plays on.' : 'The marker appears over live action — no pause.'}</div>
        </>
      )}

      <div className="divider" />
      <Field label={`Punch-in zoom: ${zoom.toFixed(2)}x`}>
        <input type="range" min="1" max="2.5" step="0.05" value={zoom} onChange={(e) => setZoom(+e.target.value)} />
      </Field>
      {crop && (
        <>
          <Field label="Pan horizontal">
            <input type="range" min="0" max={1 - crop.w} step="0.01" value={crop.x} onChange={(e) => setPan('x', +e.target.value)} />
          </Field>
          <Field label="Pan vertical">
            <input type="range" min="0" max={1 - crop.h} step="0.01" value={crop.y} onChange={(e) => setPan('y', +e.target.value)} />
          </Field>
        </>
      )}

      <div className="divider" />
      <label className="check">
        <input type="checkbox" checked={clip.showPlayerCard} onChange={(e) => onUpdate({ showPlayerCard: e.target.checked })} />
        Show player card at start of this clip
      </label>

      <div className="divider" />
      <div className="subhead">
        Text overlays
        <button className="mini" onClick={() => onUpdate({ overlays: [...clip.overlays, { id: uid(), text: 'New text', subtext: '', position: 'lower', startSec: 0, endSec: 3 }] })}>+ Add text</button>
      </div>
      {clip.overlays.length === 0 && <div className="hint">e.g. opponent, date, or play type.</div>}
      {clip.overlays.map((o, idx) => (
        <div key={o.id} className="overlay-edit">
          <input placeholder="Main text" value={o.text} onChange={(e) => onUpdate({ overlays: clip.overlays.map((x) => x.id === o.id ? { ...x, text: e.target.value } : x) })} />
          <input placeholder="Subtext (optional)" value={o.subtext} onChange={(e) => onUpdate({ overlays: clip.overlays.map((x) => x.id === o.id ? { ...x, subtext: e.target.value } : x) })} />
          <div className="row">
            <select value={o.position} onChange={(e) => onUpdate({ overlays: clip.overlays.map((x) => x.id === o.id ? { ...x, position: e.target.value } : x) })}>
              <option value="lower">Lower third</option>
              <option value="upper">Upper</option>
            </select>
            <input type="number" step="0.5" title="start s" value={o.startSec} onChange={(e) => onUpdate({ overlays: clip.overlays.map((x) => x.id === o.id ? { ...x, startSec: +e.target.value } : x) })} />
            <input type="number" step="0.5" title="end s" value={o.endSec} onChange={(e) => onUpdate({ overlays: clip.overlays.map((x) => x.id === o.id ? { ...x, endSec: +e.target.value } : x) })} />
            <button className="mini" onClick={() => onUpdate({ overlays: clip.overlays.filter((x) => x.id !== o.id) })}>✕</button>
          </div>
        </div>
      ))}
    </div>
  )
}

function PlayerForm({ player, onUpdate }) {
  const f = (k) => ({ value: player[k] || '', onChange: (e) => onUpdate({ [k]: e.target.value }) })
  return (
    <div className="form">
      <div className="hint">Used for the player card, intro title, and closing slate.</div>
      <Field label="Name"><input {...f('name')} placeholder="First Last" /></Field>
      <div className="row2">
        <Field label="Jersey #"><input {...f('number')} placeholder="7" /></Field>
        <Field label="Position"><input {...f('position')} placeholder="Forward" /></Field>
      </div>
      <div className="row2">
        <Field label="Grad year"><input {...f('gradYear')} placeholder="2027" /></Field>
        <Field label="Height"><input {...f('height')} placeholder={`5'11"`} /></Field>
      </div>
      <Field label="Team / club"><input {...f('team')} placeholder="Lincoln HS / FC United" /></Field>
      <div className="row2">
        <Field label="GPA (for outro)"><input {...f('gpa')} placeholder="3.8" /></Field>
        <Field label="Accent color"><input type="color" {...f('accent')} /></Field>
      </div>
      <Field label="Contact (for outro)"><input {...f('contact')} placeholder="email • phone • club coach" /></Field>
    </div>
  )
}

function ReelPanel({ project, onUpdate, onChooseMusic, onExport }) {
  const e = project.export
  return (
    <div className="form">
      <div className="subhead">Intro &amp; outro slates</div>
      <label className="check">
        <input type="checkbox" checked={project.intro.enabled} onChange={(ev) => onUpdate((p) => ({ intro: { ...p.intro, enabled: ev.target.checked } }))} />
        Title slate at start ({project.intro.durationSec}s)
      </label>
      {project.intro.enabled && (
        <input type="range" min="2" max="8" step="0.5" value={project.intro.durationSec} onChange={(ev) => onUpdate((p) => ({ intro: { ...p.intro, durationSec: +ev.target.value } }))} />
      )}
      <label className="check">
        <input type="checkbox" checked={project.outro.enabled} onChange={(ev) => onUpdate((p) => ({ outro: { ...p.outro, enabled: ev.target.checked } }))} />
        Closing slate with contact info ({project.outro.durationSec}s)
      </label>
      {project.outro.enabled && (
        <input type="range" min="2" max="8" step="0.5" value={project.outro.durationSec} onChange={(ev) => onUpdate((p) => ({ outro: { ...p.outro, durationSec: +ev.target.value } }))} />
      )}

      <div className="divider" />
      <div className="subhead">Background music</div>
      {project.music ? (
        <div className="music-row">
          <span title={project.music.name}>🎵 {project.music.name}</span>
          <button className="mini" onClick={() => onUpdate({ music: null })}>Remove</button>
        </div>
      ) : (
        <button onClick={onChooseMusic}>Choose music file…</button>
      )}
      {project.music && (
        <Field label={`Music volume: ${Math.round(project.music.volume * 100)}%`}>
          <input type="range" min="0" max="1" step="0.05" value={project.music.volume} onChange={(ev) => onUpdate((p) => ({ music: { ...p.music, volume: +ev.target.value } }))} />
        </Field>
      )}
      <div className="hint">Use royalty-free music if this will be posted publicly (YouTube/Hudl) to avoid takedowns.</div>

      <div className="divider" />
      <div className="subhead">Export settings</div>
      <Field label="Aspect ratio">
        <div className="seg">
          <button className={e.aspect === '16:9' ? 'on' : ''} onClick={() => onUpdate((p) => ({ export: { ...p.export, aspect: '16:9' } }))}>16:9 (Hudl/YouTube)</button>
          <button className={e.aspect === '9:16' ? 'on' : ''} onClick={() => onUpdate((p) => ({ export: { ...p.export, aspect: '9:16' } }))}>9:16 (Insta/TikTok)</button>
        </div>
      </Field>
      <Field label="Resolution">
        <div className="seg">
          {[720, 1080].map((r) => (
            <button key={r} className={e.resolution === r ? 'on' : ''} onClick={() => onUpdate((p) => ({ export: { ...p.export, resolution: r } }))}>{r}p</button>
          ))}
        </div>
      </Field>
      <button className="primary big" onClick={onExport}>Export Reel</button>
    </div>
  )
}

function ExportOverlay({ state, onCancel }) {
  const pct = state.total ? Math.round(((state.done + (state.subPct || 0)) / state.total) * 100) : 0
  return (
    <div className="modal">
      <div className="modal-card">
        <div className="modal-title">Exporting…</div>
        <div className="modal-label">{state.label}</div>
        <div className="progress"><div className="bar" style={{ width: `${pct}%` }} /></div>
        <div className="modal-pct">{pct}%</div>
        <button onClick={onCancel}>Cancel</button>
      </div>
    </div>
  )
}
