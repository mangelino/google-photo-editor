# Light Table for Google Photos

A Tampermonkey userscript that adds a full-screen tool to photos.google.com:

- Load photos and videos taken within a date range (Library, Archive, or both)
- Filter what you loaded by type (photos or videos) and by file extension (JPG, HEIC, PNG, MP4, …)
- Group shots taken within N seconds of each other (bursts, retakes) and optionally show only those groups
- Select them one by one, by shift-click range, by day, or all at once
- Add the selection to an existing album (own or shared) or to a new one
- Open an album to browse its contents, then remove selected items from it or move them to the trash
- Browse the grid at any tile size (64–600 px), square-cropped or original aspect ratio
- Open a viewer with zoom (wheel, buttons, keys) and pan; it loads higher resolutions as you zoom in
- Download originals of the selection, using the original filenames

## Install

Two equivalent builds of the same code. Use one, not both, or you'll get two launchers.

### Option A: Tampermonkey userscript (auto-updates)

1. Install [Tampermonkey](https://www.tampermonkey.net/).
2. Open [the raw script](https://raw.githubusercontent.com/mangelino/light-table-for-google-photos/main/light-table-for-google-photos.user.js) and click **Install** in the Tampermonkey page that appears.
3. Open <https://photos.google.com>. Click **Light Table** in the bottom-left corner
   (or use the Tampermonkey menu → *Open Light Table*).

On Chrome, Tampermonkey needs "Allow User Scripts" enabled in the extension's details page.

Tampermonkey checks for a new version every 24 hours by default. To check right away: Tampermonkey dashboard →
*Utilities* → *Check for userscript updates*.

### Option B: Chrome extension (unpacked)

1. Download `light-table-extension-<version>.zip` from the [latest release](https://github.com/mangelino/light-table-for-google-photos/releases/latest)
   and unzip it into a folder you'll keep (Chrome loads the extension from there).
2. Open `chrome://extensions` (or `edge://extensions`), turn on **Developer mode** (top right), click
   **Load unpacked**, and pick the unzipped folder. (From a clone of this repo, pick `extension/`.)
3. Open <https://photos.google.com> and click **Light Table** in the bottom-left corner or the extension's toolbar icon.

Unpacked extensions don't update themselves: download the new zip, replace the folder's contents, and click the
reload icon on the extension's card.
The extension asks only for the `downloads` permission and runs only on photos.google.com.

## Development

All code lives in `src/`; `npm run build` generates both builds (Node 18+, no dependencies):

| File | Purpose |
|------|---------|
| `src/core.js` | The app: RPC layer, UI, viewer (shared) |
| `src/styles.css` | Styles (shared) |
| `src/platform.userscript.js` | Tampermonkey adapter: `GM_*` calls for styles, downloads, menu |
| `src/platform.extension.js` | Extension content-script adapter: messages the background worker |
| `src/extension.background.js` | Extension service worker: toolbar icon, `chrome.downloads` |
| `src/header.userscript.js` | Userscript metadata block |
| `scripts/build.mjs` | Writes `light-table-for-google-photos.user.js` (plus a copy at the old name `google-photos-range-tools.user.js` for pre-rename installs) and `extension/` |
| `scripts/make-icons.mjs` | Regenerates `src/icons/` (`npm run icons`) |

Don't edit the `.user.js` files or `extension/` by hand; they're generated and committed so both
install methods work straight from GitHub.

To release: bump `version` in `package.json` (it feeds the userscript `@version` and the manifest), run
`npm run build`, commit, push. Installed userscripts only update when the version goes up.
`npm run package` also writes the extension `.zip`; attach it to a GitHub release
(`gh release create v<version> light-table-extension-<version>.zip light-table-for-google-photos.user.js`).

## Use

| Where  | Action | How |
|--------|--------|-----|
| Grid   | Open viewer | Click a photo (when nothing is selected) |
| Grid   | Select | Click the circle, Ctrl/⌘-click, or click any photo once something is selected |
| Grid   | Select range | Shift-click |
| Grid   | Select a day | **Select day** next to the date header |
| Grid   | Resize tiles | Size slider, or Ctrl/⌘ + mouse wheel |
| Viewer | Zoom | Mouse wheel (zooms at the cursor), `+` / `-`, double-click |
| Viewer | Fit / actual pixels | `0` / `1`, or the **Fit** / **100%** buttons |
| Viewer | Pan | Drag |
| Viewer | Previous / next | `←` / `→` |
| Viewer | Toggle selection | `Space` or `x` |
| Any    | Close | `Esc` |

**Group shots** (filter bar) boxes together consecutive shots taken at most the chosen number of seconds apart
(default 3 s, up to 3600). Each group shows its shot count, time and span, plus a **Select** button. A typical burst
cleanup: tick **Only groups**, open the shots in the viewer to compare, select the ones you don't want, **Move to trash**.

**Remove from album** (shown only when an album is open) takes the items out of that album; they stay in your library.
**Move to trash** deletes the items from your library and from every album they are in. You can restore them from
Google Photos' Trash for 60 days. Both actions ask for confirmation first.

The zoom percentage in the viewer is relative to the original's pixels. 100% means one image pixel per screen pixel.

Dates are matched against each photo's own local time, the same date Google Photos shows.

## How it works and caveats

- The script calls the same internal endpoint photos.google.com uses
  (`/_/PhotosUi/data/batchexecute`), authenticated by your existing browser session. Nothing leaves your browser.
  The RPC ids come from [Google Photos Toolkit](https://github.com/xob0t/Google-Photos-Toolkit) (MIT).
- This API is undocumented. Google can change it at any time, which will break the script until the
  RPC layer at the top of the file is updated. Automating the web UI is also outside Google's terms of
  service. It is meant for occasional personal use on your own account.
- Videos are shown as thumbnails in the viewer; download them to play.
- Bulk downloads run three at a time. The browser may ask once to allow multiple downloads.

## License

[MIT-0](LICENSE). The RPC ids and payload layouts were worked out by [Google Photos Toolkit](https://github.com/xob0t/Google-Photos-Toolkit) (MIT).
