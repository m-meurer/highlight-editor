# Highlight Editor

A desktop app for building soccer recruiting highlight reels. Import game footage, trim each clip, mark the player, add slow motion, titles and music, and export one polished MP4 that's ready to send to coaches.

Runs on macOS and Windows. All video processing happens on your computer with a bundled copy of ffmpeg, so there's nothing else to install.

## Features

- **Clips:** import by drag and drop or File → Import Videos, trim in and out points, and drag clips in the sidebar to reorder them.
- **Player highlight:** a spotlight, ring or arrow on the player, with an optional freeze-frame while it's shown.
- **Effects:** slow motion (0.5x or 0.25x), punch-in crop and zoom, and intro effects (freeze, zoom, flash).
- **Text:** lower-third overlays, a player card, and title and outro slates built from the player profile.
- **Music:** a background track that fades out at the end of the reel, mixed under the game audio. Clips with no sound are fine.
- **Export:** 16:9 or 9:16 (vertical), at 720p or 1080p.
- **Projects:** saved as `.hlp` files. If clips have moved, the app asks you to relink them. Double-click a `.hlp` to open it in the installed app.

## Download and install

### Windows

1. Download `Highlight-Editor-Setup-<version>.exe`. Get it from the [Releases](https://github.com/m-meurer/highlight-editor/releases) page, or for an unreleased build, from the latest **Build Windows installer** run on the [Actions](https://github.com/m-meurer/highlight-editor/actions) tab under **Artifacts**.
2. Run it. The installer isn't code-signed yet, so Windows SmartScreen may say "Windows protected your PC". Click **More info**, then **Run anyway**.
3. Choose an install folder. The installer adds Start menu and desktop shortcuts and registers `.hlp` project files.

### macOS

There's no prebuilt Mac download yet. Build it from source (see below) with `npm run package:mac`, which creates a `.dmg` in `dist/`. The app isn't signed, so the first time you open it, right-click the app and choose **Open**.

## Keyboard shortcuts

These are in the File menu. On Windows, use Ctrl instead of ⌘.

| Action | Shortcut |
| --- | --- |
| New project | ⌘N |
| Open project | ⌘O |
| Save | ⌘S |
| Save as | ⇧⌘S |
| Import videos | ⌘I |
| Export reel | ⌘E |

## Development

You need Node.js 20 or later.

```bash
npm install      # also downloads ffmpeg for your platform
npm run dev      # run the app with hot reload
```

### Building installers

```bash
npm run package:mac   # macOS .dmg, run on a Mac
npm run package:win   # Windows installer, run on Windows
```

Build each installer on its own platform. `npm install` downloads the ffmpeg binary for the machine it runs on, so a build made on a Mac would ship the Mac ffmpeg inside the Windows installer.

The Windows installer is also built automatically by GitHub Actions ([`.github/workflows/build-windows.yml`](.github/workflows/build-windows.yml)):

- **Every pull request, or a manual run from the Actions tab:** the installer is uploaded as a downloadable artifact.
- **Pushing a version tag:** the installer is attached to a GitHub Release for that tag. To release, set `"version"` in `package.json`, commit, then run `git tag v0.2.0 && git push origin v0.2.0`.

### Project layout

| Path | What's there |
| --- | --- |
| `src/main/index.js` | Electron main process: window, menu, file dialogs, `.hlp` file opening, `media://` streaming |
| `src/main/exporter.js` | Export pipeline: per-clip ffmpeg encode, then concat and music mix |
| `src/main/ffmpeg.js` | ffprobe and thumbnail helpers |
| `src/preload/index.js` | The `window.api` bridge to the renderer |
| `src/renderer/App.jsx` | The UI (React) |
| `src/renderer/render.js` | Canvas-drawn overlays and slates |
| `build/` | App and `.hlp` document icons (SVG sources plus `.icns` and `.ico`) |
