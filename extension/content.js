// Light Table for Google Photos, by Massimiliano Angelino. Made with Kiro (https://kiro.dev).
// GENERATED FILE: edit src/ and run `npm run build`.
(() => {
  'use strict';

  // Chrome extension adapter (content script). Styles come from styles.css via the manifest.

  const platform = {
    // chrome.downloads runs in the background worker; it sends the browser's cookies
    // and takes the filename from Content-Disposition when we don't know it.
    async download({ url, fileName }) {
      const res = await chrome.runtime.sendMessage({ type: 'download', url, fileName: fileName || null });
      if (!res?.ok) throw new Error(res?.error || 'download failed');
    },

    // Toolbar icon click -> background -> this tab.
    onOpenRequest(open) {
      chrome.runtime.onMessage.addListener((msg) => {
        if (msg?.type === 'open') open();
      });
    },
  };

  // Shared app code. Built into the userscript and the Chrome extension by
  // scripts/build.mjs, wrapped in an IIFE after a platform adapter that defines
  // `platform` (download, onOpenRequest).

  const W = window;
  const HOUR = 3600 * 1000;
  const TZ_MARGIN = 14 * HOUR; // max timezone offset; used to widen UTC search bounds
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---------------------------------------------------------------------------
  // RPC layer
  // ---------------------------------------------------------------------------

  // The script runs in Tampermonkey's isolated sandbox (page-context injection is
  // blocked by the page's Trusted Types policy), so window.WIZ_global_data is not
  // visible. Read the same values from the inline <script> that defines it.
  function readWizFromScripts() {
    const keys = ['SNlM0e', 'FdrFJe', 'cfb2h', 'eptZe', 'Dbw5Ud'];
    const g = {};
    for (const s of document.querySelectorAll('script:not([src])')) {
      const text = s.textContent;
      if (!text.includes('WIZ_global_data')) continue;
      for (const k of keys) {
        if (g[k]) continue;
        const m = new RegExp(`"${k}":"((?:[^"\\\\]|\\\\.)*)"`).exec(text);
        if (m) g[k] = JSON.parse(`"${m[1]}"`); // unescapes \u003d, \/ etc.
      }
    }
    return g;
  }

  let wizCache = null;
  function pageData() {
    const live = W.WIZ_global_data;
    const g = live && live.SNlM0e ? live : (wizCache ||= readWizFromScripts());
    if (!g.SNlM0e) {
      wizCache = null;
      throw new Error('Google Photos page data not found. Reload photos.google.com and make sure you are signed in.');
    }
    return { at: g.SNlM0e, fsid: g.FdrFJe, bl: g.cfb2h, path: g.eptZe || '/_/PhotosUi/', rapt: g.Dbw5Ud };
  }

  async function rpc(rpcid, data, { sourcePath = location.pathname, allowEmpty = false } = {}) {
    const g = pageData();
    const freq = JSON.stringify([[[rpcid, JSON.stringify(data), null, 'generic']]]);
    const body = `f.req=${encodeURIComponent(freq)}&at=${encodeURIComponent(g.at)}&`;
    const params = new URLSearchParams({
      rpcids: rpcid,
      'source-path': sourcePath,
      'f.sid': g.fsid,
      bl: g.bl,
      pageId: 'none',
      rt: 'c',
    });
    if (typeof g.rapt === 'string') params.set('rapt', g.rapt);
    const url = `https://photos.google.com${g.path}data/batchexecute?${params}`;

    let lastErr;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          credentials: 'include',
          headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' },
          body,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const text = await res.text();
        const line = text.split('\n').find((l) => l.includes('wrb.fr'));
        if (!line) throw new Error('unexpected response format');
        const envelope = JSON.parse(line);
        if (envelope?.[0]?.[2] == null) {
          if (allowEmpty && envelope?.[0]?.[0] === 'wrb.fr' && envelope[0][1] === rpcid && envelope[0][2] === null) return undefined;
          throw new Error('empty payload');
        }
        return JSON.parse(envelope[0][2]);
      } catch (e) {
        lastErr = e;
        if (attempt < 3) await sleep(1500 * attempt);
      }
    }
    throw new Error(`${rpcid} failed: ${lastErr.message}`);
  }

  function parseItem(d) {
    const last = d[d.length - 1];
    const ext = last && typeof last === 'object' && !Array.isArray(last) ? last : {};
    return {
      mediaKey: d[0],
      thumb: d[1]?.[0],
      width: d[1]?.[1] || 0,
      height: d[1]?.[2] || 0,
      timestamp: d[2], // UTC ms
      tz: d[4] || 0, // offset ms
      dedupKey: d[3],
      isVideo: !!ext['76647426'],
      duration: ext['76647426']?.[0] || 0, // ms
    };
  }

  // Timeline ordered by date taken, newest first. source: 1 library, 2 archive, 3 both.
  async function timelinePage(pageId, startTs, source) {
    const r = await rpc('lcxiM', [pageId, startTs, 500, null, 1, source]);
    return { items: (r?.[0] || []).map(parseItem), nextPageId: r?.[1] || null };
  }

  // fromLocal/toLocal are "wall clock" ms (Date.UTC of the chosen dates), compared
  // against each photo's own local time, which is what Google Photos displays.
  async function loadRange(fromLocal, toLocal, source, signal, onProgress) {
    const found = new Map();
    const seen = new Set();
    let pageId = null;
    let pages = 0;
    for (;;) {
      if (signal.aborted) throw new Error('Cancelled');
      const page = await timelinePage(pageId, pageId ? null : toLocal + TZ_MARGIN, source);
      pages++;
      let pastRange = false;
      let fresh = 0;
      for (const it of page.items) {
        if (!seen.has(it.mediaKey)) {
          seen.add(it.mediaKey);
          fresh++;
        }
        const local = it.timestamp + it.tz;
        if (local >= fromLocal && local <= toLocal) found.set(it.mediaKey, it);
        if (it.timestamp < fromLocal - TZ_MARGIN) pastRange = true;
      }
      onProgress(found.size, pages, page.items[page.items.length - 1]);
      // Stop at the range start, at the end of the timeline, or if paging stops making progress.
      if (pastRange || !page.nextPageId || page.nextPageId === pageId || fresh === 0) break;
      pageId = page.nextPageId;
    }
    return [...found.values()].sort((a, b) => b.timestamp - a.timestamp);
  }

  async function listAlbums() {
    const albums = [];
    let pageId = null;
    do {
      const r = await rpc('Z5xsfc', [pageId, null, null, null, 1, null, null, 100, [2], 5]);
      for (const a of r?.[0] || []) {
        const m = a[a.length - 1]?.['72930366'];
        albums.push({ mediaKey: a[0], title: m?.[1] || '(untitled)', count: m?.[3] ?? 0, shared: !!m?.[4] });
      }
      pageId = r?.[1] || null;
    } while (pageId);
    return albums;
  }

  // Bulk media info: adds fileName and size (bytes) to each item, 500 per request.
  async function fetchFileInfo(items, signal, onProgress) {
    const CHUNK = 500;
    const filler = [null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, [], null, null, null, null, null, null, null, null, null, null, []];
    for (let i = 0; i < items.length; i += CHUNK) {
      if (signal.aborted) throw new Error('Cancelled');
      const byKey = new Map(items.slice(i, i + CHUNK).map((it) => [it.mediaKey, it]));
      const keys = [...byKey.keys()].map((key) => [key]);
      const r = await rpc('EWgK9e', [[[keys], [filler]]]);
      if (signal.aborted) throw new Error('Cancelled');
      const updated = [];
      for (const d of r?.[0]?.[1] || []) {
        const it = byKey.get(d?.[0]);
        if (!it) continue;
        byKey.delete(it.mediaKey);
        it.fileName = d?.[1]?.[3] || null;
        it.size = d?.[1]?.[9] || null;
        updated.push(it);
      }
      onProgress(Math.min(i + CHUNK, items.length), items.length, updated);
    }
  }

  // Album contents. Item mediaKeys returned here are album-scoped: they are what
  // the remove-from-album RPCs expect.
  async function loadAlbum(album, signal, onProgress) {
    const items = new Map();
    let pageId = null;
    do {
      if (signal.aborted) throw new Error('Cancelled');
      const r = await rpc('snAcKc', [album.mediaKey, pageId, null, null]);
      for (const d of r?.[1] || []) {
        const it = parseItem(d);
        items.set(it.mediaKey, it);
      }
      const next = r?.[2] || null;
      pageId = next && next !== pageId ? next : null;
      onProgress(items.size);
    } while (pageId);
    return [...items.values()].sort((a, b) => b.timestamp - a.timestamp);
  }

  // Resolves with the items that were actually removed.
  async function removeFromAlbum(items, album, onProgress, signal) {
    if (album.shared) {
      // LjmOue rejects requests carrying several items (empty payload) but accepts
      // one item at a time, so send one request per item, a few in parallel.
      const filler = [[null, null, null, [null, [], []], null, null, null, null, null, null, null, null, null, []]];
      const removed = [];
      const errors = await runPool(items, 3, async (it) => {
        await rpc('LjmOue', [[album.mediaKey], [[it.mediaKey]], filler]);
        removed.push(it);
        onProgress(removed.length, items.length);
      }, signal);
      if (errors.length) console.warn('[gprt] shared album removal errors', errors);
      return removed;
    }
    const CHUNK = 250;
    for (let i = 0; i < items.length; i += CHUNK) {
      if (signal.aborted) return items.slice(0, i);
      await rpc('ycV3Nd', [items.slice(i, i + CHUNK).map((it) => it.mediaKey)]);
      onProgress(Math.min(i + CHUNK, items.length), items.length);
    }
    return items;
  }

  // Moves items to Google Photos' trash (restorable there for 60 days).
  async function moveToTrash(items, onProgress) {
    const CHUNK = 250;
    for (let i = 0; i < items.length; i += CHUNK) {
      const keys = items.slice(i, i + CHUNK).map((it) => it.dedupKey).filter(Boolean);
      if (keys.length) await rpc('XwAOJf', [null, 1, keys, 3]);
      onProgress(Math.min(i + CHUNK, items.length), items.length);
    }
  }

  async function createAlbum(name) {
    const r = await rpc('OXvT9d', [name, null, 2]);
    const key = r?.[0]?.[0];
    if (!key) throw new Error('Album creation returned no id');
    return key;
  }

  async function addToAlbum(mediaKeys, album, onProgress) {
    const CHUNK = 250;
    for (let i = 0; i < mediaKeys.length; i += CHUNK) {
      const chunk = mediaKeys.slice(i, i + CHUNK);
      if (album.shared) {
        await rpc('laUYf', [album.mediaKey, [2, null, chunk.map((k) => [[k]]), null, null, null, [1]]]);
      } else {
        await rpc('E1Cajb', [chunk, album.mediaKey]);
      }
      onProgress(Math.min(i + CHUNK, mediaKeys.length), mediaKeys.length);
    }
  }

  // ---------------------------------------------------------------------------
  // Image URLs and downloads
  // ---------------------------------------------------------------------------

  const aspect = (it) => (it.width && it.height ? it.width / it.height : 1);

  // URL whose shorter side is at least `px` (so it can fill a square tile).
  function coverUrl(it, px) {
    const ar = aspect(it);
    const w = ar >= 1 ? Math.round(px * ar) : px;
    const h = ar >= 1 ? px : Math.round(px / ar);
    return `${it.thumb}=w${w}-h${h}-k-no`;
  }

  // URL that fits within width `px`, keeping aspect ratio, capped at the original size.
  function widthUrl(it, px) {
    const w = it.width ? Math.min(px, it.width) : px;
    const h = Math.ceil(w / aspect(it));
    return `${it.thumb}=w${w}-h${h}-k-no`;
  }

  const originalUrl = (it) => `${it.thumb}=${it.isVideo ? 'dv' : 'd'}`;

  function fallbackName(it, contentType) {
    const extByType = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/heic': 'heic', 'image/webp': 'webp', 'image/gif': 'gif', 'video/mp4': 'mp4', 'video/quicktime': 'mov' };
    const ext = extByType[contentType.split(';')[0]] || (it.isVideo ? 'mp4' : 'jpg');
    const d = new Date(it.timestamp + it.tz).toISOString().replace(/[-:]/g, '').replace('T', '_').slice(0, 15);
    return `${d}_${it.mediaKey.slice(-8)}.${ext}`;
  }

  // Platform adapters (userscript / extension) implement the actual transfer.
  const downloadItem = (it) => platform.download({
    url: originalUrl(it),
    fileName: it.fileName,
    fallbackName: (contentType) => fallbackName(it, contentType),
  });

  async function runPool(items, concurrency, worker, signal) {
    let next = 0;
    const errors = [];
    const lanes = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (next < items.length && !signal.aborted) {
        const i = next++;
        try {
          await worker(items[i], i);
        } catch (e) {
          errors.push({ item: items[i], error: e });
        }
      }
    });
    await Promise.all(lanes);
    return errors;
  }

  // ---------------------------------------------------------------------------
  // DOM helpers (no innerHTML: photos.google.com enforces Trusted Types)
  // ---------------------------------------------------------------------------

  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style') Object.assign(el.style, v);
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'value') el.value = v;
      else if (k === 'checked') el.checked = !!v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const c of kids.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
    return el;
  }

  const pad = (n) => String(n).padStart(2, '0');
  const localDate = (it) => new Date(it.timestamp + it.tz); // read with getUTC* for the photo's local time
  const dayKey = (it) => {
    const d = localDate(it);
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  };
  const fmtDay = (key) =>
    new Date(`${key}T00:00:00Z`).toLocaleDateString(undefined, { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
  const fmtDateTime = (it) =>
    localDate(it).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' });
  const fmtDuration = (ms) => {
    const s = Math.round(ms / 1000);
    return `${Math.floor(s / 60)}:${pad(s % 60)}`;
  };
  const isoDay = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

  // ---------------------------------------------------------------------------
  // Styles
  // ---------------------------------------------------------------------------

  // ---------------------------------------------------------------------------
  // App state and UI
  // ---------------------------------------------------------------------------

  const S = {
    all: [], // everything loaded for the date range
    items: [], // after type/extension filters; this is what the grid shows
    filterType: 'all', // 'all' | 'photo' | 'video'
    grouping: false, // group shots taken close together
    groupGapSec: 3, // max seconds between consecutive shots in one group
    onlyGroups: false, // hide shots that are not part of a group
    hiddenExts: new Set(), // extensions unticked in the filter bar
    selected: new Set(), // mediaKeys
    lastClicked: null, // index for shift-click ranges
    size: 200,
    indices: new Map(),
    extensions: new Map(),
    readingInfo: false,
    albums: null,
    task: null, // AbortController of the running task
    viewer: null,
  };

  let root, grid, statusEl, selCountEl, btnAlbum, btnDownload, btnCancel, btnLoad, inFrom, inTo, inSource, filterBar, extChips;
  let sourceTitle, itemCount, gridSurface;
  let btnOpenAlbum, btnRemove, btnTrash, btnCompare, groupCountEl;

  const UNKNOWN_EXT = '(unknown)';
  function extOf(it) {
    const m = /\.([a-z0-9]+)$/i.exec(it.fileName || '');
    return m ? m[1].toLowerCase() : UNKNOWN_EXT;
  }

  // Splits items (newest first) into runs where each shot is at most gapMs from the previous one.
  function groupShots(items, gapMs) {
    const groups = [];
    let cur = null;
    for (const it of items) {
      const prev = cur?.[cur.length - 1];
      if (prev && prev.timestamp - it.timestamp <= gapMs && dayKey(prev) === dayKey(it)) cur.push(it);
      else groups.push((cur = [it]));
    }
    return groups;
  }

  function applyFilters() {
    S.items = S.all.filter((it) => {
      if (S.filterType === 'photo' && it.isVideo) return false;
      if (S.filterType === 'video' && !it.isVideo) return false;
      return !S.hiddenExts.has(extOf(it));
    });
    if (S.grouping && S.onlyGroups) {
      S.items = groupShots(S.items, S.groupGapSec * 1000).filter((g) => g.length > 1).flat();
    }
    // Keep only selections that are still visible, so album/download actions match what you see.
    S.indices = new Map(S.items.map((it, index) => [it.mediaKey, index]));
    for (const key of S.selected) if (!S.indices.has(key)) S.selected.delete(key);
    S.lastClicked = null;
    renderGrid();
    itemCount.textContent = `${S.items.length} of ${S.all.length} items`;
  }

  function buildExtChips() {
    const counts = S.extensions;
    const exts = [...counts.keys()].sort((a, b) => counts.get(b) - counts.get(a));
    S.hiddenExts = new Set([...S.hiddenExts].filter((e) => counts.has(e)));
    extChips.replaceChildren(...exts.map((ext) =>
      h('label', { class: 'gprt-chip' },
        h('input', {
          type: 'checkbox', disabled: S.readingInfo,
          checked: !S.hiddenExts.has(ext),
          onchange: (e) => { if (e.target.checked) S.hiddenExts.delete(ext); else S.hiddenExts.add(ext); applyFilters(); },
        }),
        ext === UNKNOWN_EXT ? ext : ext.toUpperCase(),
        h('small', {}, String(counts.get(ext))))));
    filterBar.style.display = S.all.length ? '' : 'none';
  }

  function countExtensions() {
    S.extensions.clear();
    for (const item of S.all) {
      const ext = extOf(item);
      S.extensions.set(ext, (S.extensions.get(ext) || 0) + 1);
    }
    buildExtChips();
  }

  function setStatus(msg, isError = false) {
    statusEl.textContent = msg;
    statusEl.classList.toggle('gprt-err', isError);
  }

  function setBusy(controller) {
    S.task = controller;
    const busy = !!controller;
    btnCancel.style.display = busy ? '' : 'none';
    btnLoad.disabled = busy;
    updateSelectionUi();
  }

  function buildApp() {
    const today = new Date();
    const monthAgo = new Date(today.getTime() - 30 * 24 * HOUR);
    inFrom = h('input', { type: 'date', value: isoDay(monthAgo) });
    inTo = h('input', { type: 'date', value: isoDay(today) });
    inSource = h('select', {},
      h('option', { value: '1' }, 'Library'),
      h('option', { value: '3' }, 'Library + Archive'),
      h('option', { value: '2' }, 'Archive only'));
    btnLoad = h('button', { class: 'gprt-primary', onclick: onLoad }, 'Load');
    btnCancel = h('button', { style: { display: 'none' }, onclick: () => S.task?.abort() }, 'Cancel');
    btnOpenAlbum = h('button', { onclick: onOpenAlbum, title: 'Load the contents of an album instead of a date range' }, 'Open album…');
    btnRemove = h('button', { onclick: removeSelectedFromAlbum }, 'Remove from album');
    btnTrash = h('button', { onclick: trashSelected, style: { color: '#ff8a80' } }, 'Move to trash');
    btnCompare = h('button', {
      title: 'Compare the first selected photo with the others side by side',
      onclick: () => openCompare(S.items.findIndex((it) => S.selected.has(it.mediaKey))),
    }, 'Compare');

    const sizeLabel = h('span', { class: 'gprt-zoom' }, `${S.size}px`);
    const sizeSlider = h('input', {
      type: 'range', min: '64', max: '600', step: '8', value: String(S.size),
      oninput: (e) => { setTileSize(+e.target.value); sizeLabel.textContent = `${S.size}px`; },
    });

    selCountEl = h('span', {}, '');
    btnAlbum = h('button', { onclick: openAlbumDialog }, 'Add to album…');
    btnDownload = h('button', { onclick: downloadSelected }, 'Download');

    statusEl = h('div', { class: 'gprt-status' }, 'Open an album or load a date range.');
    extChips = h('div', { class: 'gprt-group', style: { flexWrap: 'wrap' } });
    groupCountEl = h('small', { style: { color: '#999' } });
    const gapInput = h('input', {
      type: 'number', class: 'gprt-gap', min: '1', max: '3600', step: '1', value: String(S.groupGapSec),
      style: { width: '64px' }, title: 'Shots taken at most this many seconds apart are grouped',
      onchange: (e) => {
        const v = Math.round(+e.target.value);
        S.groupGapSec = Number.isFinite(v) ? Math.max(1, Math.min(3600, v)) : 3;
        e.target.value = String(S.groupGapSec);
        applyFilters();
      },
    });
    const groupOpts = h('span', { class: 'gprt-group', style: { display: 'none' } },
      'within', gapInput, 's',
      h('label', { class: 'gprt-group' },
        h('input', { type: 'checkbox', onchange: (e) => { S.onlyGroups = e.target.checked; applyFilters(); } }),
        'Only groups'),
      groupCountEl);
    filterBar = h('div', { class: 'gprt-bar', style: { display: 'none', paddingTop: '6px', paddingBottom: '6px' } },
      h('div', { class: 'gprt-group' }, 'Type',
        h('select', { onchange: (e) => { S.filterType = e.target.value; applyFilters(); } },
          h('option', { value: 'all' }, 'Photos + videos'),
          h('option', { value: 'photo' }, 'Photos only'),
          h('option', { value: 'video' }, 'Videos only'))),
      h('div', { class: 'gprt-group' },
        h('label', { class: 'gprt-group' },
          h('input', { type: 'checkbox', onchange: (e) => { S.grouping = e.target.checked; groupOpts.style.display = S.grouping ? '' : 'none'; applyFilters(); } }),
          'Group shots'),
        groupOpts),
      h('div', { class: 'gprt-group' }, 'Extensions', extChips));
    grid = h('div', { class: 'gprt-grid' }, h('div', { class: 'gprt-empty' }, 'No photos loaded.'));
    grid.addEventListener('wheel', (e) => {
      if (!e.ctrlKey && !e.metaKey) return; // ctrl/cmd + wheel resizes tiles
      e.preventDefault();
      const next = Math.max(64, Math.min(600, Math.round(S.size * Math.exp(-e.deltaY * 0.002))));
      sizeSlider.value = String(next);
      setTileSize(next);
      sizeLabel.textContent = `${S.size}px`;
    }, { passive: false });

    const dateFields = h('div', { class: 'gprt-source-fields', hidden: true },
      h('label', {}, 'From', inFrom), h('label', {}, 'To', inTo), inSource, btnLoad);
    const albumFields = h('div', { class: 'gprt-source-fields' }, btnOpenAlbum);
    const albumTab = h('button', { onclick: () => switchSource(true) }, 'Album');
    const dateTab = h('button', { onclick: () => switchSource(false) }, 'Date range');
    function switchSource(album) {
      albumFields.hidden = !album;
      dateFields.hidden = album;
      albumTab.setAttribute('aria-pressed', album);
      dateTab.setAttribute('aria-pressed', !album);
    }
    switchSource(true);

    sourceTitle = h('h1', {}, 'Photos');
    itemCount = h('div', { class: 'gprt-muted' }, '0 items');
    btnCompare.classList.add('gprt-primary');
    root = h('div', { class: 'gprt-root' },
      h('header', { class: 'gprt-top' },
        h('strong', {}, h('span', {}, '▣'), 'Light Table'),
        h('button', { onclick: closeApp, title: 'Close (Esc)', 'aria-label': 'Close Light Table' }, '✕')),
      h('div', { class: 'gprt-shell' },
        h('aside', { class: 'gprt-sidebar', 'aria-label': 'Browse controls' },
          h('h2', {}, 'Source'), h('div', { class: 'gprt-tabs' }, albumTab, dateTab),
          albumFields, dateFields, btnCancel,
          h('h2', {}, 'Filters'), filterBar),
        h('main', { class: 'gprt-gallery' },
          h('div', { class: 'gprt-gallery-head' },
            h('div', {}, sourceTitle, itemCount),
            h('label', { class: 'gprt-group' }, 'Tile size', sizeSlider, sizeLabel)),
          statusEl, grid,
          h('footer', { class: 'gprt-actions' }, selCountEl,
            h('button', { onclick: () => selectAll(true) }, 'Select all'),
            h('button', { onclick: () => selectAll(false) }, 'Clear'),
            h('div', { class: 'gprt-spacer' }), btnCompare, btnAlbum, btnDownload, btnRemove, btnTrash))));
    statusEl.setAttribute('role', 'status');
    grid.addEventListener('scroll', scheduleGridWindow, { passive: true });
    updateSelectionUi();
  }

  function openApp() {
    if (!root) buildApp();
    if (!root.isConnected) {
      document.body.append(root);
      gridObserver.observe(grid);
      renderGrid();
    }
    root.tabIndex = -1;
    root.focus();
    root.addEventListener('keydown', onKey, true);
  }

  function closeApp() {
    if (S.compare) closeCompare();
    if (S.viewer) closeViewer();
    gridObserver.disconnect();
    root?.remove();
    root?.removeEventListener('keydown', onKey, true);
  }

  // ---- Loading ----

  async function onLoad() {
    if (!inFrom.value || !inTo.value) return setStatus('Choose both dates.', true);
    const [fy, fm, fd] = inFrom.value.split('-').map(Number);
    const [ty, tm, td] = inTo.value.split('-').map(Number);
    const from = Date.UTC(fy, fm - 1, fd, 0, 0, 0, 0);
    const to = Date.UTC(ty, tm - 1, td, 23, 59, 59, 999);
    if (from > to) return setStatus('"From" is after "to".', true);

    await loadInto({ type: 'range', label: `between ${inFrom.value} and ${inTo.value}` }, (signal) =>
      loadRange(from, to, +inSource.value, signal, (count, pages, last) => {
        const at = last ? ` (scanning ${fmtDay(dayKey(last))})` : '';
        setStatus(`Loading… ${count} items found, ${pages} pages read${at}`);
      }));
  }

  async function onOpenAlbum() {
    const album = await pickAlbum('Open album');
    if (!album) return;
    await loadInto({ type: 'album', album, label: `in album "${album.title}"` }, (signal) =>
      loadAlbum(album, signal, (count) => setStatus(`Loading "${album.title}"… ${count} items`)));
  }

  async function loadInto(source, fetchItems) {
    if (S.task) return;
    const ctrl = new AbortController();
    setBusy(ctrl);
    setStatus('Loading…');
    try {
      const items = await fetchItems(ctrl.signal);
      if (ctrl.signal.aborted) throw new Error('Cancelled');
      closeCompare();
      closeViewer();
      S.source = source;
      sourceTitle.textContent = source.album?.title || 'Date range';
      S.all = items;
      S.selected.clear();
      S.hiddenExts.clear();
      S.readingInfo = items.length > 0;
      countExtensions();
      grid.scrollTop = 0;
      applyFilters();
      if (items.length) {
        // Let the contact sheet paint before issuing the first metadata request.
        await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
        await fetchFileInfo(items, ctrl.signal, (done, total, updated) => {
          for (const item of updated) {
            updateTileTitle(item);
            const ext = extOf(item);
            if (ext === UNKNOWN_EXT) continue;
            S.extensions.set(UNKNOWN_EXT, S.extensions.get(UNKNOWN_EXT) - 1);
            S.extensions.set(ext, (S.extensions.get(ext) || 0) + 1);
          }
          if (!S.extensions.get(UNKNOWN_EXT)) S.extensions.delete(UNKNOWN_EXT);
          buildExtChips();
          setStatus(`Reading file names… ${done}/${total}`);
        });
      }
      setStatus('');
    } catch (e) {
      setStatus(e.message, true);
    } finally {
      S.readingInfo = false;
      buildExtChips();
      setBusy(null);
    }
  }

  // ---- Grid ----

  function thumbBucket() {
    const need = S.size * (window.devicePixelRatio || 1);
    return [128, 192, 256, 384, 512, 768, 1024, 1536].find((b) => b >= need) || 1536;
  }

  const GRID_GAP = 4;
  const gridObserver = new ResizeObserver(() => scheduleGridWindow());
  const gridRows = [];
  const mountedRows = new Map();
  const mountedTiles = new Map();
  let gridSections = [];
  let gridFrame = 0;
  let gridWidth = 0;
  let tileEdge = 0;
  let layoutSize = 0;

  function renderGrid() {
    gridSections = [];
    const days = new Map();
    for (const item of S.items) {
      const key = dayKey(item);
      if (!days.has(key)) days.set(key, []);
      days.get(key).push(item);
    }
    let bursts = 0;
    for (const [day, items] of days) {
      gridSections.push({ label: fmtDay(day), items, day: true });
      let singles = [];
      if (S.grouping) {
        for (const group of groupShots(items, S.groupGapSec * 1000)) {
          if (group.length === 1) {
            singles.push(group[0]);
            continue;
          }
          if (singles.length) gridSections.push({ photos: singles });
          singles = [];
          bursts++;
          gridSections.push({ label: `${group.length} shots`, items: group }, { photos: group });
        }
      } else {
        singles = items;
      }
      if (singles.length) gridSections.push({ photos: singles });
    }
    groupCountEl.textContent = S.grouping ? `${bursts} group${bursts === 1 ? '' : 's'}` : '';
    mountedRows.clear();
    mountedTiles.clear();
    gridRows.length = 0;
    gridSurface = h('div', { class: 'gprt-grid-surface' });
    grid.replaceChildren(gridSections.length ? gridSurface : h('div', { class: 'gprt-empty' },
      S.all.length ? 'No items match the current filters.' : 'No photos loaded.'));
    gridWidth = 0;
    updateGridWindow();
    updateSelectionUi();
  }

  function scheduleGridWindow() {
    if (!gridFrame) gridFrame = requestAnimationFrame(() => {
      gridFrame = 0;
      updateGridWindow();
    });
  }

  function updateGridWindow() {
    if (!gridSections.length || !gridSurface.clientWidth || !grid.clientHeight) return;
    const width = gridSurface.clientWidth;
    if (width !== gridWidth || layoutSize !== S.size) {
      gridWidth = width;
      layoutSize = S.size;
      const columns = Math.max(1, Math.floor((width + GRID_GAP) / (S.size + GRID_GAP)));
      tileEdge = Math.min(S.size, width);
      gridRows.length = 0;
      let top = 0;
      const pushRow = (height, row) => {
        gridRows.push({ ...row, top, height });
        top += height + GRID_GAP;
      };
      for (const section of gridSections) {
        if (section.photos) {
          for (let start = 0; start < section.photos.length; start += columns) {
            pushRow(tileEdge, { photos: section.photos, start, end: Math.min(start + columns, section.photos.length) });
          }
        } else {
          pushRow(section.day ? 44 : 34, section);
        }
      }
      mountedRows.clear();
      mountedTiles.clear();
      gridSurface.replaceChildren();
      gridSurface.style.height = `${top}px`;
    }

    const overscan = Math.max(400, tileEdge * 2);
    const start = grid.scrollTop - overscan;
    const end = grid.scrollTop + grid.clientHeight + overscan;
    let low = 0;
    let high = gridRows.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      const row = gridRows[mid];
      if (row.top + row.height < start) low = mid + 1;
      else high = mid;
    }
    let last = low;
    while (last < gridRows.length && gridRows[last].top < end) last++;
    for (const [index, element] of mountedRows) {
      if (index >= low && index < last) continue;
      const row = gridRows[index];
      if (row.photos) {
        for (let i = row.start; i < row.end; i++) mountedTiles.delete(row.photos[i].mediaKey);
      }
      mountedRows.delete(index);
      if (element.contains(document.activeElement)) root.focus({ preventScroll: true });
      element.remove();
    }
    const bucket = thumbBucket();
    let next = null;
    for (let index = last - 1; index >= low; index--) {
      let element = mountedRows.get(index);
      if (!element) {
        const row = gridRows[index];
        element = h('div', { class: `gprt-window-row ${row.photos ? 'gprt-photo-row' : 'gprt-row-label'}`,
          style: { top: `${row.top}px`, height: `${row.height}px` } });
        if (row.photos) {
          for (let i = row.start; i < row.end; i++) {
            const item = row.photos[i];
            const tile = makeTile(item, S.indices.get(item.mediaKey), bucket);
            tile.style.width = `${tileEdge}px`;
            mountedTiles.set(item.mediaKey, tile);
            element.append(tile);
          }
        } else {
          element.append(h('strong', {}, row.label));
          if (row.day) element.append(h('small', {}, `${row.items.length} items`));
          element.append(h('button', { onclick: () => toggleGroup(row.items) }, row.day ? 'Select day' : 'Select burst'));
        }
        gridSurface.insertBefore(element, next);
        mountedRows.set(index, element);
      }
      next = element;
    }
  }

  function updateTileTitle(item) {
    const tile = mountedTiles.get(item.mediaKey);
    if (tile) {
      tile.title = tileTitle(item);
      tile.setAttribute('aria-label', tile.title);
    }
  }

  const tileTitle = (item) => [item.fileName, fmtDateTime(item)].filter(Boolean).join(' · ');

  function makeTile(it, idx, bucket) {
    const img = h('img', { loading: 'lazy', decoding: 'async', alt: '', src: coverUrl(it, bucket) });
    const title = tileTitle(it);
    const tile = h('button', { type: 'button', class: 'gprt-tile', 'aria-label': title, title },
      img,
      h('span', { class: 'gprt-check', title: 'Select', 'aria-hidden': 'true' }),
      it.isVideo ? h('span', { class: 'gprt-badge' }, `▶ ${fmtDuration(it.duration)}`) : null);
    syncTile(tile, it.mediaKey);
    tile.addEventListener('click', (e) => onTileClick(e, idx));
    return tile;
  }

  function onTileClick(e, idx) {
    const onCheck = e.target.classList.contains('gprt-check');
    if (e.shiftKey && S.lastClicked != null) {
      const [a, b] = [Math.min(S.lastClicked, idx), Math.max(S.lastClicked, idx)];
      for (let i = a; i <= b; i++) S.selected.add(S.items[i].mediaKey);
      S.lastClicked = idx;
      refreshTiles();
    } else if (onCheck || e.ctrlKey || e.metaKey || S.selected.size > 0) {
      toggleItem(idx);
    } else {
      openViewer(idx);
    }
  }

  function toggleItem(idx) {
    const key = S.items[idx].mediaKey;
    if (S.selected.has(key)) S.selected.delete(key);
    else S.selected.add(key);
    S.lastClicked = idx;
    syncTile(mountedTiles.get(key), key);
    updateSelectionUi();
  }

  function toggleGroup(items) {
    const allSelected = items.every((it) => S.selected.has(it.mediaKey));
    for (const it of items) {
      if (allSelected) S.selected.delete(it.mediaKey);
      else S.selected.add(it.mediaKey);
    }
    refreshTiles();
  }

  function selectAll(on) {
    if (on) S.items.forEach((it) => S.selected.add(it.mediaKey));
    else S.selected.clear();
    refreshTiles();
  }

  function syncTile(tile, key) {
    if (!tile) return;
    const selected = S.selected.has(key);
    tile.classList.toggle('gprt-sel', selected);
    tile.setAttribute('aria-pressed', selected);
  }

  function refreshTiles() {
    for (const [key, tile] of mountedTiles) syncTile(tile, key);
    updateSelectionUi();
  }

  function updateSelectionUi() {
    if (!root) return;
    const n = S.selected.size;
    selCountEl.textContent = `${n} selected`;
    btnAlbum.disabled = n === 0 || !!S.task;
    btnDownload.disabled = n === 0 || !!S.task;
    btnTrash.disabled = n === 0 || !!S.task;
    btnCompare.disabled = n === 0;
    btnRemove.disabled = n === 0 || !!S.task || S.source?.type !== 'album';
    btnOpenAlbum.disabled = !!S.task;
    root.classList.toggle('gprt-has-sel', n > 0);
  }

  function setTileSize(px) {
    if (S.size === px) return;
    S.size = px;
    scheduleGridWindow();
  }

  // ---- Albums ----

  function openAlbumDialog() {
    const keys = S.items.filter((it) => S.selected.has(it.mediaKey)).map((it) => it.mediaKey);
    let picked = null;
    const list = h('div', { class: 'gprt-albums' }, h('div', { class: 'gprt-empty' }, 'Loading albums…'));
    const filter = h('input', { type: 'text', placeholder: 'Filter albums', oninput: () => renderList() });
    const newName = h('input', { type: 'text', placeholder: 'Or create a new album: name', oninput: () => { picked = null; renderList(); sync(); } });
    const msg = h('div', { class: 'gprt-status', style: { border: '0', padding: '0' } });
    const btnAdd = h('button', { class: 'gprt-primary', onclick: doAdd }, 'Add');
    const btnClose = h('button', { onclick: () => bg.remove() }, 'Cancel');
    const bg = h('div', { class: 'gprt-modal-bg', onclick: (e) => { if (e.target === bg) bg.remove(); } },
      h('div', { class: 'gprt-modal' },
        h('h3', {}, `Add ${keys.length} item${keys.length === 1 ? '' : 's'} to album`),
        filter, list, newName, msg,
        h('div', { class: 'gprt-row', style: { justifyContent: 'flex-end' } },
          h('button', { onclick: () => { S.albums = null; fetchAlbums(); } }, 'Refresh'), btnClose, btnAdd)));
    root.append(bg);
    filter.focus();

    function sync() {
      btnAdd.disabled = !(picked || newName.value.trim());
    }

    function renderList() {
      if (!S.albums) return;
      const q = filter.value.trim().toLowerCase();
      const rows = S.albums
        .filter((a) => !q || a.title.toLowerCase().includes(q))
        .map((a) => h('div', {
          class: `gprt-album${picked === a ? ' gprt-picked' : ''}`,
          onclick: () => { picked = a; newName.value = ''; renderList(); sync(); },
          ondblclick: () => { picked = a; doAdd(); },
        }, a.title, h('small', {}, `${a.count}${a.shared ? ' · shared' : ''}`)));
      list.replaceChildren(...(rows.length ? rows : [h('div', { class: 'gprt-empty' }, 'No albums match.')]));
    }

    async function fetchAlbums() {
      list.replaceChildren(h('div', { class: 'gprt-empty' }, 'Loading albums…'));
      try {
        S.albums = S.albums || (await listAlbums());
        S.albums.sort((a, b) => a.title.localeCompare(b.title));
        renderList();
      } catch (e) {
        list.replaceChildren(h('div', { class: 'gprt-empty' }, e.message));
      }
    }

    async function doAdd() {
      const name = newName.value.trim();
      if (!picked && !name) return;
      btnAdd.disabled = true;
      btnClose.disabled = true;
      try {
        let album = picked;
        if (!album) {
          msg.textContent = `Creating "${name}"…`;
          album = { mediaKey: await createAlbum(name), title: name, shared: false };
        }
        await addToAlbum(keys, album, (done, total) => { msg.textContent = `Adding… ${done}/${total}`; });
        S.albums = null; // counts changed
        bg.remove();
        setStatus(`Added ${keys.length} items to "${album.title}".`);
      } catch (e) {
        msg.textContent = e.message;
        msg.classList.add('gprt-err');
        btnAdd.disabled = false;
        btnClose.disabled = false;
      }
    }

    sync();
    fetchAlbums();
  }

  // Modal list of albums; resolves with the chosen album or null.
  function pickAlbum(title) {
    return new Promise((resolve) => {
      const list = h('div', { class: 'gprt-albums' }, h('div', { class: 'gprt-empty' }, 'Loading albums…'));
      const filter = h('input', { type: 'text', placeholder: 'Filter albums', oninput: () => render() });
      const close = (album) => { bg.remove(); resolve(album); };
      const bg = h('div', { class: 'gprt-modal-bg', onclick: (e) => { if (e.target === bg) close(null); } },
        h('div', { class: 'gprt-modal' },
          h('h3', {}, title), filter, list,
          h('div', { class: 'gprt-row', style: { justifyContent: 'flex-end' } },
            h('button', { onclick: () => { S.albums = null; load(); } }, 'Refresh'),
            h('button', { onclick: () => close(null) }, 'Cancel'))));
      bg.addEventListener('gprt-dismiss', () => resolve(null)); // Esc
      root.append(bg);
      filter.focus();

      function render() {
        const q = filter.value.trim().toLowerCase();
        const rows = (S.albums || [])
          .filter((a) => !q || a.title.toLowerCase().includes(q))
          .map((a) => h('div', { class: 'gprt-album', onclick: () => close(a) },
            a.title, h('small', {}, `${a.count}${a.shared ? ' · shared' : ''}`)));
        list.replaceChildren(...(rows.length ? rows : [h('div', { class: 'gprt-empty' }, 'No albums match.')]));
      }

      async function load() {
        list.replaceChildren(h('div', { class: 'gprt-empty' }, 'Loading albums…'));
        try {
          S.albums = S.albums || (await listAlbums());
          S.albums.sort((a, b) => a.title.localeCompare(b.title));
          render();
        } catch (e) {
          list.replaceChildren(h('div', { class: 'gprt-empty' }, e.message));
        }
      }
      load();
    });
  }

  // ---- Remove from album / trash ----

  const selectedItems = () => S.items.filter((it) => S.selected.has(it.mediaKey));

  function dropFromView(items) {
    const gone = new Set(items.map((it) => it.mediaKey));
    S.all = S.all.filter((it) => !gone.has(it.mediaKey));
    for (const k of gone) S.selected.delete(k);
    countExtensions();
    applyFilters();
  }

  async function runAction(items, verb, action) {
    const ctrl = new AbortController();
    setBusy(ctrl);
    try {
      // An action may resolve with the subset it completed (partial failure or Cancel).
      const done = (await action((n, total) => setStatus(`${verb}… ${n}/${total}`), ctrl.signal)) || items;
      dropFromView(done);
      S.albums = null; // album counts changed
      if (done.length < items.length) {
        const why = ctrl.signal.aborted ? 'cancelled' : 'failed (details in console)';
        setStatus(`${verb}: ${done.length} of ${items.length} done, the rest ${why}. They are still selected.`, true);
        return false;
      }
      return true;
    } catch (e) {
      setStatus(`${verb} failed: ${e.message}. Reload the album to see its current state.`, true);
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function removeAlbumSelection(items, album, progress, signal) {
    const removed = [];
    const batchSize = 250;
    const sourcePath = `/album/${encodeURIComponent(album.mediaKey)}`;
    try {
      for (let start = 0; start < items.length && !signal.aborted; start += batchSize) {
        const batch = items.slice(start, start + batchSize);
        const result = await rpc('ycV3Nd', [batch.map((item) => item.mediaKey)], {
          sourcePath, allowEmpty: album.shared,
        });
        if (result === undefined) {
          // Keep the shared-album path available when this RPC returns no payload.
          const rest = await removeFromAlbum(items.slice(start), album,
            (count) => progress(start + count, items.length), signal);
          return removed.concat(rest);
        }
        removed.push(...batch);
        progress(removed.length, items.length);
      }
    } catch (error) {
      if (!removed.length) throw error;
      console.warn('[gprt] album removal stopped after a completed batch', error);
    }
    return removed;
  }

  async function removeSelectedFromAlbum() {
    const album = S.source?.album;
    const items = selectedItems();
    if (!album || !items.length) return;
    if (!confirm(`Remove ${items.length} item${items.length === 1 ? '' : 's'} from "${album.title}"?\n\nThe photos stay in your library.`)) return;
    if (await runAction(items, 'Removing from album', (p, signal) => removeAlbumSelection(items, album, p, signal))) {
      setStatus(`Removed ${items.length} items from "${album.title}". ${S.all.length} left.`);
    }
  }

  async function trashSelected() {
    const items = selectedItems();
    if (!items.length) return;
    const where = S.source?.type === 'album' ? ' It also removes them from every album, not just this one.' : '';
    if (!confirm(`Move ${items.length} item${items.length === 1 ? '' : 's'} to the Google Photos trash?\n\nThis deletes them from your library on all devices.${where} You can restore them from Trash for 60 days.`)) return;
    if (await runAction(items, 'Moving to trash', (p) => moveToTrash(items, p))) {
      setStatus(`Moved ${items.length} items to trash.`);
    }
  }

  // ---- Downloads ----

  async function downloadSelected() {
    const items = S.items.filter((it) => S.selected.has(it.mediaKey));
    if (items.length > 20 && !confirm(`Download ${items.length} original files? Your browser may ask to allow multiple downloads.`)) return;
    const ctrl = new AbortController();
    setBusy(ctrl);
    let done = 0;
    setStatus(`Downloading 0/${items.length}…`);
    const errors = await runPool(items, 3, async (it) => {
      await downloadItem(it);
      done++;
      setStatus(`Downloading ${done}/${items.length}…`);
    }, ctrl.signal);
    setBusy(null);
    const cancelled = ctrl.signal.aborted ? ' (cancelled)' : '';
    if (errors.length) {
      console.warn('[gprt] download errors', errors);
      setStatus(`Downloaded ${done}/${items.length}${cancelled}. ${errors.length} failed: ${errors[0].error.message} (details in console).`, true);
    } else {
      setStatus(`Downloaded ${done}/${items.length}${cancelled}.`);
    }
  }

  // ---------------------------------------------------------------------------
  // Viewer with zoom and pan
  // ---------------------------------------------------------------------------

  // A reused img can keep painting its previous resource until the new one loads.
  function replacePhotoImage(previous, url) {
    const next = h('img', { alt: '', draggable: 'false', src: url });
    previous.replaceWith(next);
    return next;
  }

  function openViewer(idx) {
    let img = h('img', { alt: '', draggable: 'false' });
    const stage = h('div', { class: 'gprt-stage' }, img);
    const zoomLabel = h('span', { class: 'gprt-zoom' }, '');
    const info = h('span', {}, '');
    const selBtn = h('button', { onclick: () => { toggleItem(V.idx); syncSel(); } }, '');
    const openLink = h('a', { target: '_blank', rel: 'noopener', style: { color: '#8ab4f8' } }, 'Open in Google Photos');
    const el = h('div', { class: 'gprt-viewer' },
      h('div', { class: 'gprt-bar' },
        h('button', { onclick: () => go(-1), title: 'Previous (←)' }, '‹'),
        h('button', { onclick: () => go(1), title: 'Next (→)' }, '›'),
        info,
        h('div', { class: 'gprt-spacer' }),
        h('div', { class: 'gprt-group' },
          h('button', { onclick: () => zoomBy(1 / 1.5), title: 'Zoom out (-)' }, '−'),
          zoomLabel,
          h('button', { onclick: () => zoomBy(1.5), title: 'Zoom in (+)' }, '+'),
          h('button', { onclick: () => fit(), title: 'Fit (0)' }, 'Fit'),
          h('button', { onclick: () => actualSize(), title: 'Actual pixels (1)' }, '100%')),
        selBtn,
        h('button', { onclick: () => openCompare(V.idx), title: 'Compare this photo side by side with others (C)' }, 'Compare'),
        h('button', { onclick: () => downloadItem(S.items[V.idx]).catch((e) => setStatus(e.message, true)) }, 'Download'),
        openLink,
        h('button', { onclick: closeViewer, title: 'Close (Esc)' }, '✕')),
      stage);
    stage.append(
      h('button', { class: 'gprt-nav', style: { left: '8px' }, onclick: () => go(-1) }, '‹'),
      h('button', { class: 'gprt-nav', style: { right: '8px' }, onclick: () => go(1) }, '›'));
    root.append(el);
    el.tabIndex = -1;
    el.focus();

    const V = { el, idx, z: 1, tx: 0, ty: 0, baseW: 0, baseH: 0, left: 0, top: 0, loadedW: 0, timer: 0, go, zoomBy, fit, actualSize, toggleSel: () => selBtn.click(), refreshSel: () => syncSel() };
    S.viewer = V;

    function item() {
      return S.items[V.idx];
    }

    function show() {
      const it = item();
      V.loadedW = 0;
      const tile = mountedTiles.get(it.mediaKey)?.firstElementChild;
      img = replacePhotoImage(img, tile?.currentSrc || coverUrl(it, 256));
      info.textContent = `${it.fileName ? `${it.fileName} · ` : ''}${fmtDateTime(it)} · ${it.width}×${it.height}${it.isVideo ? ` · video ${fmtDuration(it.duration)} (download to play)` : ''} · ${V.idx + 1}/${S.items.length}`;
      openLink.href = `https://photos.google.com/photo/${it.mediaKey}`;
      syncSel();
      fit();
    }

    function syncSel() {
      selBtn.textContent = S.selected.has(item().mediaKey) ? '✓ Selected' : 'Select';
    }

    function layout() {
      const r = stage.getBoundingClientRect();
      const ar = aspect(item());
      V.baseW = Math.min(r.width, r.height * ar);
      V.baseH = V.baseW / ar;
      V.left = (r.width - V.baseW) / 2;
      V.top = (r.height - V.baseH) / 2;
      V.stageW = r.width;
      V.stageH = r.height;
    }

    function clampPan() {
      const sw = V.baseW * V.z;
      const sh = V.baseH * V.z;
      V.tx = sw <= V.stageW ? (V.stageW - sw) / 2 - V.left : Math.min(-V.left, Math.max(V.stageW - sw - V.left, V.tx));
      V.ty = sh <= V.stageH ? (V.stageH - sh) / 2 - V.top : Math.min(-V.top, Math.max(V.stageH - sh - V.top, V.ty));
    }

    function apply() {
      clampPan();
      Object.assign(img.style, {
        width: `${V.baseW}px`, height: `${V.baseH}px`, left: `${V.left}px`, top: `${V.top}px`,
        transform: `translate(${V.tx}px, ${V.ty}px) scale(${V.z})`,
      });
      const it = item();
      zoomLabel.textContent = it.width ? `${Math.round((V.baseW * V.z * 100) / it.width)}%` : `${V.z.toFixed(1)}×`;
      clearTimeout(V.timer);
      V.timer = setTimeout(upgradeResolution, 120);
    }

    // Load a larger rendition once the displayed size exceeds what is loaded.
    function upgradeResolution() {
      const it = item();
      const need = Math.ceil(V.baseW * V.z * (window.devicePixelRatio || 1));
      const step = Math.ceil(need / 256) * 256;
      const target = it.width ? Math.min(step, it.width) : step;
      if (target <= V.loadedW) return;
      const preview = img;
      const hi = new Image();
      hi.onload = () => {
        if (S.viewer !== V || img !== preview || target <= V.loadedW) return;
        img.src = hi.src;
        V.loadedW = Math.max(V.loadedW, target);
      };
      hi.src = widthUrl(it, target);
    }

    function maxZoom() {
      const it = item();
      return Math.max(8, it.width ? (it.width / V.baseW) * 4 : 8);
    }

    function zoomAt(z2, sx, sy) {
      z2 = Math.max(1, Math.min(maxZoom(), z2));
      const ux = (sx - V.left - V.tx) / V.z;
      const uy = (sy - V.top - V.ty) / V.z;
      V.tx = sx - V.left - z2 * ux;
      V.ty = sy - V.top - z2 * uy;
      V.z = z2;
      apply();
    }

    function zoomBy(f) {
      zoomAt(V.z * f, V.stageW / 2, V.stageH / 2);
    }

    function fit() {
      layout();
      V.z = 1;
      V.tx = 0;
      V.ty = 0;
      apply();
    }

    function actualSize() {
      const it = item();
      if (it.width) zoomAt(it.width / V.baseW, V.stageW / 2, V.stageH / 2);
    }

    function go(d) {
      const n = V.idx + d;
      if (n < 0 || n >= S.items.length) return;
      V.idx = n;
      show();
    }

    stage.addEventListener('wheel', (e) => {
      e.preventDefault();
      const r = stage.getBoundingClientRect();
      zoomAt(V.z * Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top);
    }, { passive: false });

    stage.addEventListener('dblclick', (e) => {
      if (e.target !== img) return;
      const r = stage.getBoundingClientRect();
      const it = item();
      const full = it.width ? it.width / V.baseW : 2;
      if (V.z > 1.01) fit();
      else zoomAt(Math.max(full, 2), e.clientX - r.left, e.clientY - r.top);
    });

    let drag = null;
    stage.addEventListener('pointerdown', (e) => {
      if (e.target.tagName === 'BUTTON') return;
      drag = { x: e.clientX, y: e.clientY, tx: V.tx, ty: V.ty };
      stage.setPointerCapture(e.pointerId);
      stage.classList.add('gprt-drag');
    });
    stage.addEventListener('pointermove', (e) => {
      if (!drag) return;
      V.tx = drag.tx + e.clientX - drag.x;
      V.ty = drag.ty + e.clientY - drag.y;
      apply();
    });
    const endDrag = () => { drag = null; stage.classList.remove('gprt-drag'); };
    stage.addEventListener('pointerup', endDrag);
    stage.addEventListener('pointercancel', endDrag);

    V.onResize = () => {
      const z = V.z;
      layout();
      V.z = z;
      apply();
    };
    window.addEventListener('resize', V.onResize);

    show();
  }

  function closeViewer() {
    const V = S.viewer;
    if (!V) return;
    window.removeEventListener('resize', V.onResize);
    clearTimeout(V.timer);
    V.el.remove();
    S.viewer = null;
    root.focus();
  }

  // ---------------------------------------------------------------------------
  // X|Y comparison: X stays fixed on the left, Y is picked from a ribbon below.
  // Both panes share one zoom level and one pan position (in image coordinates),
  // so the same detail is shown side by side.
  // ---------------------------------------------------------------------------

  function compareCandidates(x, mode) {
    if (mode === 'selected') return S.items.filter((it) => it === x || S.selected.has(it.mediaKey));
    if (mode === 'group') return groupShots(S.items, S.groupGapSec * 1000).find((g) => g.includes(x)) || [x];
    return S.items;
  }

  function openCompare(xIdx) {
    const x0 = S.items[xIdx];
    if (!x0) return;
    const y0 = S.selected.size > 1 ? S.items.find((it) => it !== x0 && S.selected.has(it.mediaKey)) : null;
    const C = { x: x0, y: y0, mode: 'all', list: [], z: 1, cu: 0.5, cv: 0.5, timer: 0 };

    const zoomLabel = h('span', { class: 'gprt-zoom' });
    const modeSel = h('select', { title: 'Which photos the ribbon offers for Y', onchange: (e) => { C.mode = e.target.value; buildRibbon(); } },
      h('option', { value: 'group' }, `Same burst (≤${S.groupGapSec}s)`),
      h('option', { value: 'selected' }, 'Selected photos'),
      h('option', { value: 'all' }, 'All shown photos'));
    modeSel.value = C.mode;
    const RIBBON_STEP = 80;
    const ribbonTrack = h('div', { class: 'gprt-ribbon-track' });
    const ribbon = h('div', { class: 'gprt-ribbon', 'aria-label': 'Compare candidates' }, ribbonTrack);
    const ribbonNodes = new Map();
    let ribbonIndex, xPosition, yPosition;
    ribbon.addEventListener('scroll', renderRibbonWindow, { passive: true });
    const panes = [makePane('X'), makePane('Y')];
    const [PX, PY] = panes;

    const swapButton = h('button', { onclick: swap, title: 'Swap X and Y (S)' }, '⇄ Swap');
    const el = h('div', { class: 'gprt-viewer gprt-compare' },
      h('div', { class: 'gprt-bar' },
        h('strong', {}, 'Compare'),
        h('div', { class: 'gprt-group' }, 'Ribbon', modeSel),
        h('div', { class: 'gprt-spacer' }),
        h('div', { class: 'gprt-group' },
          h('button', { onclick: () => zoomBy(1 / 1.5), title: 'Zoom out (-)' }, '−'),
          zoomLabel,
          h('button', { onclick: () => zoomBy(1.5), title: 'Zoom in (+)' }, '+'),
          h('button', { onclick: () => fit(), title: 'Fit (0)' }, 'Fit'),
          h('button', { onclick: () => actualSize(), title: 'Actual pixels of X (1)' }, '100%')),
        swapButton,
        h('button', { onclick: closeCompare, title: 'Close (Esc)' }, '✕')),
      h('div', { class: 'gprt-panes' }, PX.el, PY.el),
      ribbon);
    root.append(el);
    el.tabIndex = -1;
    el.focus();
    S.compare = Object.assign(C, { el, go, swap, zoomBy, fit, actualSize, onResize, toggleSel: (which) => toggleSel(which === 'x' ? PX : PY) });
    window.addEventListener('resize', onResize);

    setPane(PX, C.x);
    buildRibbon();

    function makePane(label) {
      const img = h('img', { alt: '', draggable: 'false' });
      const info = h('span', { class: 'gprt-pane-info' });
      const sel = h('button', { onclick: () => { toggleSel(P); } });
      const stage = h('div', { class: 'gprt-stage' }, img, h('div', { class: `gprt-pane-label gprt-pane-${label.toLowerCase()}` }, label));
      const P = { label, el: null, img, info, sel, stage, it: null, loadedW: 0, baseW: 1, baseH: 1, left: 0, top: 0, W: 1, H: 1 };
      P.el = h('div', { class: 'gprt-pane' }, h('div', { class: 'gprt-pane-head' }, info, sel), stage);

      stage.addEventListener('wheel', (e) => {
        e.preventDefault();
        if (!P.it) return;
        const r = stage.getBoundingClientRect();
        zoomAt(P, C.z * Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top);
      }, { passive: false });
      stage.addEventListener('dblclick', (e) => {
        if (e.target !== P.img) return;
        const r = stage.getBoundingClientRect();
        if (C.z > 1.01) fit();
        else zoomAt(P, Math.max(P.it.width ? P.it.width / P.baseW : 2, 2), e.clientX - r.left, e.clientY - r.top);
      });
      let drag = null;
      stage.addEventListener('pointerdown', (e) => {
        if (!P.it) return;
        drag = { x: e.clientX, y: e.clientY, cu: C.cu, cv: C.cv };
        stage.setPointerCapture?.(e.pointerId);
        stage.classList.add('gprt-drag');
      });
      stage.addEventListener('pointermove', (e) => {
        if (!drag) return;
        C.cu = drag.cu - (e.clientX - drag.x) / (C.z * P.baseW);
        C.cv = drag.cv - (e.clientY - drag.y) / (C.z * P.baseH);
        apply();
      });
      const endDrag = () => { drag = null; stage.classList.remove('gprt-drag'); };
      stage.addEventListener('pointerup', endDrag);
      stage.addEventListener('pointercancel', endDrag);
      return P;
    }

    function setPane(P, it) {
      P.it = it;
      P.loadedW = 0;
      if (!it) {
        P.img = replacePhotoImage(P.img);
        P.img.style.display = 'none';
        P.info.textContent = 'Pick a photo from the ribbon below';
        P.sel.style.display = 'none';
        return;
      }
      const tile = mountedTiles.get(it.mediaKey)?.firstElementChild;
      P.img = replacePhotoImage(P.img, tile?.currentSrc || coverUrl(it, 256));
      P.info.textContent = `${it.fileName ? `${it.fileName} · ` : ''}${fmtDateTime(it)} · ${it.width}×${it.height}`;
      P.info.title = P.info.textContent;
      P.sel.style.display = '';
      syncSel(P);
      layout(P);
      apply();
    }

    function syncSel(P) {
      if (P.it) P.sel.textContent = S.selected.has(P.it.mediaKey) ? '✓ Selected' : 'Select';
    }

    function toggleSel(P) {
      if (!P.it) return;
      toggleItem(S.indices.get(P.it.mediaKey));
      syncSel(P);
      markThumb(ribbonIndex.get(P.it.mediaKey));
    }

    function layout(P) {
      const r = P.stage.getBoundingClientRect();
      const ar = aspect(P.it);
      P.W = r.width || 1;
      P.H = r.height || 1;
      P.baseW = Math.min(P.W, P.H * ar) || 1;
      P.baseH = P.baseW / ar;
      P.left = (P.W - P.baseW) / 2;
      P.top = (P.H - P.baseH) / 2;
    }

    // Keep the shared centre inside X's image so you can't pan into empty space.
    function clampCenter() {
      const hw = PX.W / (2 * C.z * PX.baseW);
      const hh = PX.H / (2 * C.z * PX.baseH);
      C.cu = hw >= 0.5 ? 0.5 : Math.min(1 - hw, Math.max(hw, C.cu));
      C.cv = hh >= 0.5 ? 0.5 : Math.min(1 - hh, Math.max(hh, C.cv));
    }

    function translate(P) {
      return [P.W / 2 - P.left - C.z * C.cu * P.baseW, P.H / 2 - P.top - C.z * C.cv * P.baseH];
    }

    function apply() {
      clampCenter();
      for (const P of panes) {
        if (!P.it) continue;
        const [tx, ty] = translate(P);
        Object.assign(P.img.style, {
          width: `${P.baseW}px`, height: `${P.baseH}px`, left: `${P.left}px`, top: `${P.top}px`,
          transform: `translate(${tx}px, ${ty}px) scale(${C.z})`,
        });
      }
      zoomLabel.textContent = C.x.width ? `${Math.round((PX.baseW * C.z * 100) / C.x.width)}%` : `${C.z.toFixed(1)}×`;
      clearTimeout(C.timer);
      C.timer = setTimeout(() => panes.forEach(upgrade), 120);
    }

    function upgrade(P) {
      const it = P.it;
      if (!it) return;
      const need = Math.ceil(P.baseW * C.z * (window.devicePixelRatio || 1));
      const step = Math.ceil(need / 256) * 256;
      const target = it.width ? Math.min(step, it.width) : step;
      if (target <= P.loadedW) return;
      const preview = P.img;
      const hi = new Image();
      hi.onload = () => {
        if (S.compare !== C || P.img !== preview || target <= P.loadedW) return;
        P.img.src = hi.src;
        P.loadedW = Math.max(P.loadedW, target);
      };
      hi.src = widthUrl(it, target);
    }

    function maxZoom() {
      return Math.max(8, C.x.width ? (C.x.width / PX.baseW) * 4 : 8);
    }

    // Zoom keeping the image point under (sx, sy) of pane P in place.
    function zoomAt(P, z2, sx, sy) {
      z2 = Math.max(1, Math.min(maxZoom(), z2));
      const [tx, ty] = translate(P);
      const ux = (sx - P.left - tx) / (C.z * P.baseW);
      const uy = (sy - P.top - ty) / (C.z * P.baseH);
      C.z = z2;
      C.cu = ux - (sx - P.W / 2) / (z2 * P.baseW);
      C.cv = uy - (sy - P.H / 2) / (z2 * P.baseH);
      apply();
    }

    function zoomBy(f) {
      zoomAt(PX, C.z * f, PX.W / 2, PX.H / 2);
    }

    function fit() {
      C.z = 1;
      C.cu = 0.5;
      C.cv = 0.5;
      apply();
    }

    function actualSize() {
      if (C.x.width) zoomAt(PX, C.x.width / PX.baseW, PX.W / 2, PX.H / 2);
    }

    function buildRibbon() {
      C.list = compareCandidates(C.x, C.mode);
      ribbonIndex = C.mode === 'all' ? S.indices : new Map(C.list.map((it, i) => [it.mediaKey, i]));
      xPosition = ribbonIndex.get(C.x.mediaKey);
      yPosition = C.y ? ribbonIndex.get(C.y.mediaKey) : undefined;
      if (yPosition === undefined) {
        yPosition = xPosition + 1 < C.list.length ? xPosition + 1 : xPosition - 1;
        C.y = C.list[yPosition] || null;
      }
      if (PY.it !== C.y) setPane(PY, C.y);
      swapButton.disabled = !C.y;
      ribbonNodes.clear();
      ribbonTrack.replaceChildren();
      ribbonTrack.style.width = `${C.list.length * RIBBON_STEP}px`;
      if (!C.y) ribbonTrack.append(h('span', { class: 'gprt-ribbon-empty' }, 'No other photos in this ribbon.'));
      revealCandidate(yPosition < 0 ? xPosition : yPosition);
    }

    function markThumb(position) {
      const thumb = ribbonNodes.get(position);
      if (!thumb) return;
      const item = C.list[position];
      const role = position === xPosition ? 'X' : position === yPosition ? 'Y' : '';
      const selected = S.selected.has(item.mediaKey);
      thumb.classList.toggle('gprt-is-x', role === 'X');
      thumb.classList.toggle('gprt-is-y', role === 'Y');
      thumb.classList.toggle('gprt-is-sel', selected);
      thumb.lastChild.textContent = role;
      thumb.setAttribute('aria-label', [tileTitle(item), role, selected ? 'Selected' : ''].filter(Boolean).join(' · '));
      thumb.setAttribute('aria-disabled', role === 'X');
    }

    function renderRibbonWindow() {
      const first = Math.max(0, Math.floor(ribbon.scrollLeft / RIBBON_STEP) - 3);
      const end = Math.min(C.list.length, Math.ceil((ribbon.scrollLeft + ribbon.clientWidth) / RIBBON_STEP) + 3);
      for (const [position, thumb] of ribbonNodes) {
        if (position >= first && position < end) continue;
        ribbonNodes.delete(position);
        if (thumb === document.activeElement) el.focus({ preventScroll: true });
        thumb.remove();
      }
      let next = null;
      for (let position = end - 1; position >= first; position--) {
        let thumb = ribbonNodes.get(position);
        if (!thumb) {
          const item = C.list[position];
          thumb = h('button', {
            type: 'button', class: 'gprt-rthumb', title: tileTitle(item),
            style: { left: `${position * RIBBON_STEP}px` },
            onclick: () => setY(position),
          }, h('img', { decoding: 'async', alt: '', src: coverUrl(item, 128) }),
          h('span', { class: 'gprt-rtag' }));
          ribbonTrack.insertBefore(thumb, next);
          ribbonNodes.set(position, thumb);
          markThumb(position);
        }
        next = thumb;
      }
    }

    function revealCandidate(position) {
      const left = position * RIBBON_STEP;
      if (left < ribbon.scrollLeft) ribbon.scrollLeft = left;
      else if (left + RIBBON_STEP > ribbon.scrollLeft + ribbon.clientWidth) {
        ribbon.scrollLeft = left + RIBBON_STEP - ribbon.clientWidth;
      }
      renderRibbonWindow();
    }

    function setY(position) {
      if (position === xPosition || position === yPosition || !C.list[position]) return;
      const previous = yPosition;
      yPosition = position;
      C.y = C.list[position];
      setPane(PY, C.y);
      markThumb(previous);
      markThumb(yPosition);
      revealCandidate(yPosition);
    }

    function go(direction) {
      if (!C.y) return;
      let position = yPosition + direction;
      if (position === xPosition) position += direction;
      setY(position);
    }

    function swap() {
      if (!C.y) return;
      [C.x, C.y] = [C.y, C.x];
      [xPosition, yPosition] = [yPosition, xPosition];
      setPane(PX, C.x);
      setPane(PY, C.y);
      markThumb(xPosition);
      markThumb(yPosition);
      revealCandidate(yPosition);
    }

    function onResize() {
      panes.forEach((P) => P.it && layout(P));
      apply();
      renderRibbonWindow();
    }
  }

  function closeCompare() {
    const C = S.compare;
    if (!C) return;
    window.removeEventListener('resize', C.onResize);
    clearTimeout(C.timer);
    C.el.remove();
    S.compare = null;
    (S.viewer?.el || root).focus();
    S.viewer?.refreshSel();
  }

  // ---------------------------------------------------------------------------
  // Keyboard (captured so Google Photos' own shortcuts don't fire underneath)
  // ---------------------------------------------------------------------------

  function onKey(e) {
    if (!root?.isConnected || (e.target instanceof Element && !root.contains(e.target) && e.target !== document.body)) return;
    e.stopImmediatePropagation();
    const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName);
    if (e.key === 'Escape') {
      e.preventDefault();
      const modal = root.querySelector('.gprt-modal-bg');
      if (modal) {
        modal.dispatchEvent(new CustomEvent('gprt-dismiss'));
        modal.remove();
      }
      else if (S.compare) closeCompare();
      else if (S.viewer) closeViewer();
      else closeApp();
      return;
    }
    if (typing) return;
    if ((S.compare || S.viewer) && (e.ctrlKey || e.metaKey || e.altKey)) return;
    const C = S.compare;
    if (C) {
      const compareActions = {
        ArrowLeft: () => C.go(-1),
        ArrowRight: () => C.go(1),
        '+': () => C.zoomBy(1.5),
        '=': () => C.zoomBy(1.5),
        '-': () => C.zoomBy(1 / 1.5),
        0: () => C.fit(),
        1: () => C.actualSize(),
        s: () => { if (!e.repeat) C.swap(); },
        x: () => { if (!e.repeat) C.toggleSel('x'); },
        y: () => { if (!e.repeat) C.toggleSel('y'); },
        ' ': () => { if (!e.repeat) C.toggleSel(e.shiftKey ? 'x' : 'y'); },
      };
      const fn = compareActions[e.key.toLowerCase()] || compareActions[e.key];
      if (fn) {
        e.preventDefault();
        fn();
      }
      return;
    }
    const V = S.viewer;
    if (!V) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        selectAll(true);
      }
      return;
    }
    const actions = {
      ArrowLeft: () => V.go(-1),
      ArrowRight: () => V.go(1),
      '+': () => V.zoomBy(1.5),
      '=': () => V.zoomBy(1.5),
      '-': () => V.zoomBy(1 / 1.5),
      0: () => V.fit(),
      1: () => V.actualSize(),
      ' ': () => { if (!e.repeat) V.toggleSel(); },
      x: () => { if (!e.repeat) V.toggleSel(); },
      Enter: () => {
        if (e.repeat) return;
        const item = S.items[V.idx];
        if (!S.selected.has(item.mediaKey)) V.toggleSel();
        V.go(1);
      },
      c: () => openCompare(V.idx),
    };
    const fn = actions[e.key.toLowerCase()] || actions[e.key];
    if (fn) {
      e.preventDefault();
      fn();
    }
  }

  // ---------------------------------------------------------------------------
  // Entry points
  // ---------------------------------------------------------------------------

  function ensureLauncher() {
    if (document.querySelector('.gprt-launch')) return;
    document.body.append(h('button', { class: 'gprt-launch', onclick: openApp, title: 'Light Table for Google Photos' }, 'Light Table'));
  }

  try {
    ensureLauncher();
    setInterval(ensureLauncher, 2000); // the page may re-render <body> children
    platform.onOpenRequest(openApp);
    console.info('[gprt] Light Table loaded');
  } catch (e) {
    console.error('[gprt] failed to start', e);
  }
})();
