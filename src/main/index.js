import { app, BrowserWindow, ipcMain, dialog, protocol, Menu } from 'electron'
import { join, extname } from 'path'
import { readFile, writeFile } from 'fs/promises'
import { existsSync, createReadStream, statSync } from 'fs'
import { Readable } from 'stream'
import { execFile } from 'child_process'
import { probeVideo, generateThumbnail } from './ffmpeg.js'
import { runExport, cancelExport } from './exporter.js'

const MIME = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg'
}

// Custom scheme so the renderer (served over http in dev) can load local files
// with HTTP range support, which the <video> element needs for scrubbing.
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'media',
    privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true, bypassCSP: true }
  }
])

let mainWindow = null

// Native menu bar. File menu items send a command to the renderer, which runs
// the same handlers as the toolbar buttons (so dirty-checks etc. still apply).
function sendMenuCommand(command, arg) {
  const win = BrowserWindow.getFocusedWindow() || mainWindow
  if (win) win.webContents.send('menu:command', command, arg)
}

// Opening a .hlp file from Finder / Explorer (double-click, "Open With", or
// dropping it on the dock icon). On macOS this arrives as 'open-file', possibly
// before the window exists; on Windows the path is in the command line.
// A path that arrives before the renderer is listening waits in pendingOpen
// until the renderer asks for it.
let pendingOpen = null
let rendererReady = false

function hlpPathFrom(argv) {
  return argv.slice(1).find((a) => a.toLowerCase().endsWith('.hlp') && existsSync(a)) || null
}

function openProjectFile(filePath) {
  if (!filePath) return
  if (mainWindow && rendererReady) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
    mainWindow.webContents.send('menu:command', 'openPath', filePath)
  } else {
    pendingOpen = filePath
    if (app.isReady() && !mainWindow) createWindow()
  }
}

app.on('open-file', (e, filePath) => {
  e.preventDefault()
  openProjectFile(filePath)
})

// One app instance: on Windows, double-clicking a .hlp while the app is open
// starts a second process, which hands its file to the first and exits.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', (_e, argv) => {
    const p = hlpPathFrom(argv)
    if (p) openProjectFile(p)
    else if (mainWindow) mainWindow.focus()
  })
  if (process.platform !== 'darwin') pendingOpen = hlpPathFrom(process.argv)
}

function buildMenu() {
  const isMac = process.platform === 'darwin'
  const item = (label, accelerator, command) => ({ label, accelerator, click: () => sendMenuCommand(command) })
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        item('New Project', 'CmdOrCtrl+N', 'new'),
        item('Open Project…', 'CmdOrCtrl+O', 'open'),
        { type: 'separator' },
        item('Save', 'CmdOrCtrl+S', 'save'),
        item('Save As…', 'Shift+CmdOrCtrl+S', 'saveAs'),
        { type: 'separator' },
        item('Import Videos…', 'CmdOrCtrl+I', 'import'),
        item('Choose Music…', null, 'music'),
        { type: 'separator' },
        item('Export Reel…', 'CmdOrCtrl+E', 'export'),
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' }
      ]
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

// macOS: re-register this copy of the app with LaunchServices on each launch,
// so Finder picks up the .hlp document icon and file type right after an
// install or update, without the user running lsregister by hand. Skipped in
// dev, and when macOS runs the app from a temporary "translocated" copy.
const LSREGISTER =
  '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister'

function registerWithLaunchServices() {
  if (process.platform !== 'darwin' || !app.isPackaged) return
  const bundle = join(app.getPath('exe'), '..', '..', '..')
  if (!bundle.endsWith('.app') || bundle.includes('/AppTranslocation/')) return
  execFile(LSREGISTER, ['-f', bundle], (err) => {
    if (err) console.warn('lsregister failed:', err.message)
  })
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    backgroundColor: '#0f1115',
    title: 'Highlight Editor',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  mainWindow.webContents.on('did-start-loading', () => {
    rendererReady = false
  })
  mainWindow.on('closed', () => {
    mainWindow = null
    rendererReady = false
  })
}

app.whenReady().then(() => {
  registerWithLaunchServices()

  // media://<absolute-file-path> -> stream from disk WITH HTTP range support,
  // which the <video> element needs to seek/jump to arbitrary positions.
  protocol.handle('media', (request) => {
    let filePath = decodeURIComponent(new URL(request.url).pathname)
    if (/^\/[A-Za-z]:\//.test(filePath)) filePath = filePath.slice(1) // Windows drive path

    let stat
    try {
      stat = statSync(filePath)
    } catch {
      return new Response('Not found', { status: 404 })
    }
    const total = stat.size
    const type = MIME[extname(filePath).toLowerCase()] || 'application/octet-stream'
    const range = request.headers.get('Range')

    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range)
      let start = m && m[1] ? parseInt(m[1], 10) : 0
      let end = m && m[2] ? parseInt(m[2], 10) : total - 1
      if (isNaN(start) || start < 0) start = 0
      if (isNaN(end) || end >= total) end = total - 1
      if (start > end) start = 0
      const stream = createReadStream(filePath, { start, end })
      return new Response(Readable.toWeb(stream), {
        status: 206,
        headers: {
          'Content-Type': type,
          'Content-Length': String(end - start + 1),
          'Content-Range': `bytes ${start}-${end}/${total}`,
          'Accept-Ranges': 'bytes'
        }
      })
    }

    return new Response(Readable.toWeb(createReadStream(filePath)), {
      status: 200,
      headers: { 'Content-Type': type, 'Content-Length': String(total), 'Accept-Ranges': 'bytes' }
    })
  })

  registerIpc()
  buildMenu()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

function registerIpc() {
  ipcMain.handle('dialog:openVideos', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Import video files',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Video', extensions: ['mp4', 'mov', 'm4v', 'avi', 'mkv', 'webm'] },
        { name: 'All Files', extensions: ['*'] }
      ]
    })
    if (result.canceled) return []
    return result.filePaths
  })

  ipcMain.handle('dialog:openAudio', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose background music',
      properties: ['openFile'],
      filters: [{ name: 'Audio', extensions: ['mp3', 'm4a', 'aac', 'wav', 'ogg'] }]
    })
    if (result.canceled) return null
    return result.filePaths[0]
  })

  ipcMain.handle('media:probe', async (_e, filePath) => probeVideo(filePath))

  ipcMain.handle('media:thumbnail', async (_e, filePath, timeSec) =>
    generateThumbnail(filePath, timeSec)
  )

  ipcMain.handle('project:save', async (_e, projectJson) => {
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Save project',
      defaultPath: 'highlight-reel.hlp',
      filters: [{ name: 'Highlight Project', extensions: ['hlp'] }]
    })
    if (result.canceled) return null
    await writeFile(result.filePath, projectJson, 'utf-8')
    return result.filePath
  })

  // Save straight to a known path (no dialog) once the project has a home.
  ipcMain.handle('project:saveTo', async (_e, filePath, projectJson) => {
    await writeFile(filePath, projectJson, 'utf-8')
    return filePath
  })

  // The renderer calls this once it is listening for menu commands.
  ipcMain.handle('project:takePendingOpen', () => {
    rendererReady = true
    const p = pendingOpen
    pendingOpen = null
    return p
  })

  ipcMain.handle('project:open', async (_e, filePathArg) => {
    let filePath = filePathArg
    if (!filePath) {
      const result = await dialog.showOpenDialog(mainWindow, {
        title: 'Open project',
        properties: ['openFile'],
        filters: [{ name: 'Highlight Project', extensions: ['hlp'] }]
      })
      if (result.canceled) return null
      filePath = result.filePaths[0]
    }
    const data = await readFile(filePath, 'utf-8')
    return { path: filePath, data }
  })

  // Which of these source video paths still exist on disk?
  ipcMain.handle('media:checkPaths', async (_e, paths) => {
    const missing = {}
    for (const p of paths || []) missing[p] = existsSync(p)
    return missing
  })

  // Let the user point a moved/renamed clip at its new location.
  ipcMain.handle('media:relink', async (_e, originalName) => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: `Locate ${originalName || 'video'}`,
      properties: ['openFile'],
      filters: [{ name: 'Video', extensions: ['mp4', 'mov', 'm4v', 'avi', 'mkv', 'webm'] }]
    })
    if (result.canceled) return null
    return result.filePaths[0]
  })

  ipcMain.handle('export:choosePath', async (_e, suggestedName) => {
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Export highlight reel',
      defaultPath: suggestedName || 'highlight-reel.mp4',
      filters: [{ name: 'MP4 Video', extensions: ['mp4'] }]
    })
    if (result.canceled) return null
    return result.filePath
  })

  ipcMain.handle('export:run', async (_e, spec) => {
    return runExport(spec, (progress) => {
      if (mainWindow) mainWindow.webContents.send('export:progress', progress)
    })
  })

  ipcMain.handle('export:cancel', async () => {
    cancelExport()
    return true
  })
}
