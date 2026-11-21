# Google Photos Range Tools

A Tampermonkey userscript that adds a full-screen tool to photos.google.com:

- Load photos and videos taken within a date range (Library, Archive, or both)
- Filter what you loaded by type (photos or videos) and by file extension (JPG, HEIC, PNG, MP4, …)
- Select them one by one, by shift-click range, by day, or all at once
- Add the selection to an existing album (own or shared) or to a new one
- Open an album to browse its contents, then remove selected items from it or move them to the trash
- Browse the grid at any tile size (64–600 px), square-cropped or original aspect ratio
- Open a viewer with zoom (wheel, buttons, keys) and pan; it loads higher resolutions as you zoom in
- Download originals of the selection, using the original filenames

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/).
2. Open the Tampermonkey dashboard → **+** (new script), replace the template with the contents of
   `google-photos-range-tools.user.js`, and save.
3. Open <https://photos.google.com>. Click **Range Tools** in the bottom-left corner
   (or use the Tampermonkey menu → *Open Range Tools*).

On Chrome, Tampermonkey needs "Allow User Scripts" enabled in the extension's details page.

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
