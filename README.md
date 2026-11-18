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

1. Download `Highlight-Editor-Setup-<version>.exe` from the [latest release](https://github.com/m-meurer/highlight-editor/releases/latest).
2. Run it. The installer isn't code-signed yet, so Windows SmartScreen may say "Windows protected your PC". Click **More info**, then **Run anyway**.
3. Choose an install folder. The installer adds Start menu and desktop shortcuts and registers `.hlp` project files. It installs just for the current user, so it doesn't need an administrator password.

If Windows blocks it, or the account is managed by a parent, see [Troubleshooting installs](#troubleshooting-installs) at the bottom.

### macOS

Apple Silicon Macs (M1 or newer) only, for now.

1. Download `Highlight Editor-<version>-arm64.dmg` from the [latest release](https://github.com/m-meurer/highlight-editor/releases/latest).
2. Open the `.dmg` and drag **Highlight Editor** into **Applications**.

The app isn't signed by Apple, so macOS will refuse to open it the first time. See [Troubleshooting installs](#troubleshooting-installs) at the bottom for the steps.

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

GitHub Actions builds both installers automatically ([`.github/workflows/build.yml`](.github/workflows/build.yml)), each on its own OS:

- **Every pull request:** the installers are uploaded as downloadable artifacts on the run's page.
- **Publishing a release:** first set `"version"` in `package.json` and merge that. Then either push a tag (`git tag v0.2.0 && git push origin v0.2.0`), or go to **Actions → Build installers → Run workflow** and enter the tag name under **release**. The Windows `.exe` and Mac `.dmg` are attached to a GitHub Release with that name.

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

## Troubleshooting installs

Highlight Editor isn't signed with a paid Microsoft or Apple developer certificate yet. So both Windows and macOS treat it as an app from an unknown developer and add extra warnings before the first launch. The app is safe to run. These steps get you past the warnings. You only need them once, unless you install a new version.

### Windows

#### "Windows protected your PC" (SmartScreen)

1. On the blue window, click **More info**. The link is under the message text.
2. Click **Run anyway**.

If there's no **Run anyway** button, the file was probably marked as blocked when it was downloaded:

1. Right-click `Highlight-Editor-Setup-<version>.exe` and choose **Properties**.
2. On the **General** tab, at the bottom, tick **Unblock** and click **OK**.
3. Run the installer again.

#### "Smart App Control blocked an app that may be unsafe" (Windows 11)

Smart App Control blocks unsigned apps outright. It has no "run anyway" option.

1. Open **Settings → Privacy & security → Windows Security → App & browser control → Smart App Control settings**.
2. Set it to **Off**.
3. Run the installer again.

Turning Smart App Control off is a system-wide change, and on some versions of Windows 11 it can't be turned back on without resetting Windows. On a managed account, a parent should decide whether to do this.

#### "The app you're trying to install isn't a Microsoft-verified app"

Windows is set to allow apps from the Microsoft Store only.

1. Open **Settings → Apps → Advanced app settings**.
2. Change **Choose where to get apps** to **Anywhere**, or to **Anywhere, but let me know if there's a comparable app in the Microsoft Store**.
3. Run the installer again.

On a child account, this setting usually needs a parent or administrator to change it.

#### On an account managed by a parent (Microsoft Family Safety)

The installer puts the app in the child's own user folder (`%LOCALAPPDATA%\Programs`), so the child doesn't need an administrator password to install it. Family Safety can still block the app from running. If it does:

1. When the child opens Highlight Editor, Windows shows that the app is blocked. Choose **Ask a parent** (or **Ask for permission**) to send a request.
2. The parent approves it in the **Microsoft Family Safety** app on their phone, or at [family.microsoft.com](https://family.microsoft.com).
3. To allow it ahead of time, the parent opens Family Safety, selects the child, and goes to **Screen time → Apps and games** (or **Content filters → Apps and games**). From there they allow **Highlight Editor**. It only appears in the list after the child has tried to open it once.
4. If the child has screen-time limits, the app counts toward them like any other app. The parent can set its limit separately in the same place.

If Smart App Control or the Store-only setting above also applies, a parent needs to change those first, from their own administrator account.

#### If an export fails right after installing

Antivirus software sometimes checks `ffmpeg.exe` (the video engine bundled with the app) the first time it runs. Wait a minute and try the export again. If your antivirus quarantined the file, restore it and add the Highlight Editor install folder as an exception. By default that's `%LOCALAPPDATA%\Programs\Highlight Editor`.

### macOS

#### `.hlp` files show a blank or "?" icon

Finder caches file icons. After installing or updating the app, open Highlight Editor once, then run this in **Terminal** to refresh them:

```bash
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "/Applications/Highlight Editor.app" && killall Finder
```

#### First launch: "Highlight Editor cannot be opened because Apple cannot check it for malicious software"

On macOS 15 (Sequoia) and later:

1. Try to open Highlight Editor once and click **Done** (or **OK**) on the warning.
2. Open **System Settings → Privacy & Security**.
3. Scroll down to **Security**. You'll see a message that "Highlight Editor" was blocked. Click **Open Anyway**.
4. Enter an administrator name and password if asked, then click **Open Anyway** again.

On macOS 14 (Sonoma) and earlier, there's a shortcut: in Finder, go to **Applications**, right-click (or Control-click) **Highlight Editor**, choose **Open**, then click **Open** in the dialog. The steps for macOS 15 work on these versions too.

#### "Highlight Editor is damaged and can't be opened. You should move it to the Trash."

The app isn't actually damaged. macOS shows this for unsigned apps that were downloaded or copied from another Mac. Open **Terminal** (Applications → Utilities) and run:

```bash
xattr -dr com.apple.quarantine "/Applications/Highlight Editor.app"
```

Then open the app normally. If the app isn't in Applications, drag it from Finder into the Terminal window in place of the quoted path.

#### On an account managed by a parent (Screen Time)

- **Installing:** a standard (non-administrator) account may not be allowed to copy apps into the main **Applications** folder. Either a parent enters their administrator password when Finder asks, or the child can drag the app into the **Applications** folder inside their own home folder instead (create it if it isn't there).
- **First launch:** the **Open Anyway** step above asks for an administrator name and password, so a parent needs to type theirs. This is only needed once.
- **App limits and Downtime:** if Screen Time limits all apps, or uses **Downtime**, Highlight Editor is limited too. On the child's Mac, or from the parent's Mac or iPhone via Family Sharing, the parent opens **Screen Time**, selects the child, and adds **Highlight Editor** under **Always Allowed**. Or they can give it its own limit under **App Limits**. Otherwise the child can tap **Ask for More Time** when the limit appears.
- **Content & Privacy restrictions** can't block an app that wasn't installed from the App Store. If the app still won't open, check the steps above first.

#### If an export fails right after installing

The first time the app runs ffmpeg (the video engine bundled inside it), macOS may check it, which can take a few seconds. Try the export again. If you see a warning that ffmpeg "cannot be opened", run the `xattr` command above, which clears the flag on everything inside the app.

## License

Highlight Editor is licensed under the [PolyForm Noncommercial License 1.0.0](LICENSE). You're free to use it for personal and other noncommercial purposes, but you may not sell it or use it commercially.

Required Notice: Copyright (c) 2026 Matt (https://github.com/m-meurer)

This is a personal project, and outside contributions and pull requests aren't being accepted.
