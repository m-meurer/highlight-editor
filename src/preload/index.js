import { contextBridge, ipcRenderer, webUtils } from 'electron'

contextBridge.exposeInMainWorld('api', {
  openVideos: () => ipcRenderer.invoke('dialog:openVideos'),
  // Absolute path of a File from a drag-and-drop (File.path was removed in Electron 32).
  getPathForFile: (file) => webUtils.getPathForFile(file),
  openAudio: () => ipcRenderer.invoke('dialog:openAudio'),
  probe: (filePath) => ipcRenderer.invoke('media:probe', filePath),
  thumbnail: (filePath, timeSec) => ipcRenderer.invoke('media:thumbnail', filePath, timeSec),
  saveProject: (json) => ipcRenderer.invoke('project:save', json),
  saveProjectTo: (path, json) => ipcRenderer.invoke('project:saveTo', path, json),
  openProject: (path) => ipcRenderer.invoke('project:open', path),
  checkPaths: (paths) => ipcRenderer.invoke('media:checkPaths', paths),
  relinkVideo: (originalName) => ipcRenderer.invoke('media:relink', originalName),
  chooseExportPath: (name) => ipcRenderer.invoke('export:choosePath', name),
  runExport: (spec) => ipcRenderer.invoke('export:run', spec),
  cancelExport: () => ipcRenderer.invoke('export:cancel'),
  onExportProgress: (cb) => {
    const handler = (_e, p) => cb(p)
    ipcRenderer.on('export:progress', handler)
    return () => ipcRenderer.removeListener('export:progress', handler)
  },
  // File menu commands from the native menu bar: new, open, save, saveAs, import, music, export.
  onMenuCommand: (cb) => {
    const handler = (_e, command) => cb(command)
    ipcRenderer.on('menu:command', handler)
    return () => ipcRenderer.removeListener('menu:command', handler)
  },
  // Turn an absolute file path into a media:// URL the <video> tag can load.
  toMediaUrl: (filePath) => {
    let p = filePath.replace(/\\/g, '/')
    if (!p.startsWith('/')) p = '/' + p // Windows drive paths: /C:/videos/x.mp4
    return 'media://local' + encodeURI(p).replace(/#/g, '%23').replace(/\?/g, '%3F')
  }
})
