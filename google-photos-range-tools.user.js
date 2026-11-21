// ==UserScript==
// @name         Google Photos Range Tools
// @namespace    https://github.com/mangelino/google-photo-editor
// @license      MIT-0
// @version      0.3.0
// @description  Select Google Photos by date range or album, filter by type, add to or remove from albums, trash, zoom, and download originals.
// @homepageURL  https://github.com/mangelino/google-photo-editor
// @supportURL   https://github.com/mangelino/google-photo-editor/issues
// @updateURL    https://raw.githubusercontent.com/mangelino/google-photo-editor/main/google-photos-range-tools.user.js
// @downloadURL  https://raw.githubusercontent.com/mangelino/google-photo-editor/main/google-photos-range-tools.user.js
// @match        https://photos.google.com/*
// @run-at       document-idle
// @noframes
// @grant        GM_addStyle
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @sandbox      DOM
// @connect      googleusercontent.com
// @connect      usercontent.google.com
// @connect      photos.google.com
// ==/UserScript==

/*
 * Uses Google Photos' undocumented web RPC endpoint (batchexecute), the same
 * one photos.google.com uses. RPC ids and payload layouts follow
 * Google Photos Toolkit (https://github.com/xob0t/Google-Photos-Toolkit, MIT).
 * Google can change these without notice; if something breaks, the RPC layer
 * at the top of this file is the place to look.
 */

(() => {
  'use strict';
  console.info('[gprt] starting');

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

  async function rpc(rpcid, data) {
    const g = pageData();
    const freq = JSON.stringify([[[rpcid, JSON.stringify(data), null, 'generic']]]);
    const body = `f.req=${encodeURIComponent(freq)}&at=${encodeURIComponent(g.at)}&`;
    const params = new URLSearchParams({
      rpcids: rpcid,
      'source-path': location.pathname,
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
        if (envelope?.[0]?.[2] == null) throw new Error('empty payload');
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
    const byKey = new Map(items.map((it) => [it.mediaKey, it]));
    const filler = [null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, [], null, null, null, null, null, null, null, null, null, null, []];
    for (let i = 0; i < items.length; i += CHUNK) {
      if (signal.aborted) throw new Error('Cancelled');
      const keys = items.slice(i, i + CHUNK).map((it) => [it.mediaKey]);
      const r = await rpc('EWgK9e', [[[keys], [filler]]]);
      for (const d of r?.[0]?.[1] || []) {
        const it = byKey.get(d?.[0]);
        if (!it) continue;
        it.fileName = d?.[1]?.[3] || null;
        it.size = d?.[1]?.[9] || null;
      }
      onProgress(Math.min(i + CHUNK, items.length), items.length);
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

  async function removeFromAlbum(items, album, onProgress) {
    const CHUNK = 250;
    for (let i = 0; i < items.length; i += CHUNK) {
      const keys = items.slice(i, i + CHUNK).map((it) => it.mediaKey);
      if (album.shared) {
        await rpc('LjmOue', [[album.mediaKey], [keys], [[null, null, null, [null, [], []], null, null, null, null, null, null, null, null, null, []]]]);
      } else {
        await rpc('ycV3Nd', [keys]);
      }
      onProgress(Math.min(i + CHUNK, items.length), items.length);
    }
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

  function gmGetBlob(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        responseType: 'blob',
        timeout: 10 * 60 * 1000,
        onload: (r) => (r.status >= 200 && r.status < 300 ? resolve(r) : reject(new Error(`HTTP ${r.status}`))),
        onerror: () => reject(new Error('network error')),
        ontimeout: () => reject(new Error('timeout')),
      });
    });
  }

  function headerValue(headers, name) {
    const m = new RegExp(`^${name}:\\s*(.*)$`, 'im').exec(headers || '');
    return m ? m[1].trim() : '';
  }

  function filenameFromDisposition(cd) {
    if (!cd) return null;
    const star = /filename\*\s*=\s*(?:UTF-8'')?([^;]+)/i.exec(cd);
    const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(cd);
    const raw = (star || plain)?.[1]?.trim();
    if (!raw) return null;
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }

  function fallbackName(it, contentType) {
    const extByType = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/heic': 'heic', 'image/webp': 'webp', 'image/gif': 'gif', 'video/mp4': 'mp4', 'video/quicktime': 'mov' };
    const ext = extByType[contentType.split(';')[0]] || (it.isVideo ? 'mp4' : 'jpg');
    const d = new Date(it.timestamp + it.tz).toISOString().replace(/[-:]/g, '').replace('T', '_').slice(0, 15);
    return `${d}_${it.mediaKey.slice(-8)}.${ext}`;
  }

  async function downloadItem(it) {
    const r = await gmGetBlob(originalUrl(it));
    const type = headerValue(r.responseHeaders, 'content-type');
    const name = it.fileName || filenameFromDisposition(headerValue(r.responseHeaders, 'content-disposition')) || fallbackName(it, type);
    const url = URL.createObjectURL(r.response);
    const a = h('a', { href: url, download: name, style: { display: 'none' } });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60 * 1000);
  }

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

  GM_addStyle(`
    .gprt-launch { position: fixed; left: 16px; bottom: 16px; z-index: 2147483000; padding: 10px 14px;
      border: 0; border-radius: 20px; background: #1a73e8; color: #fff; font: 500 14px/1 system-ui, sans-serif;
      box-shadow: 0 2px 8px rgba(0,0,0,.3); cursor: pointer; }
    .gprt-root { position: fixed; inset: 0; z-index: 2147483001; display: flex; flex-direction: column;
      background: #121212; color: #e8e8e8; font: 14px/1.4 system-ui, sans-serif; --sz: 200px; }
    .gprt-root * { box-sizing: border-box; }
    .gprt-root button, .gprt-root input, .gprt-root select { font: inherit; color: inherit; }
    .gprt-root button { background: #2a2a2a; border: 1px solid #3a3a3a; border-radius: 6px; padding: 5px 10px; cursor: pointer; }
    .gprt-root button:hover:not(:disabled) { background: #353535; }
    .gprt-root button:disabled { opacity: .45; cursor: default; }
    .gprt-root button.gprt-primary { background: #1a73e8; border-color: #1a73e8; color: #fff; }
    .gprt-root input[type=date], .gprt-root input[type=text], .gprt-root select {
      background: #1e1e1e; border: 1px solid #3a3a3a; border-radius: 6px; padding: 4px 6px; color-scheme: dark; }
    .gprt-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 14px; padding: 10px 14px; border-bottom: 1px solid #2a2a2a; }
    .gprt-group { display: flex; align-items: center; gap: 6px; }
    .gprt-spacer { flex: 1; }
    .gprt-status { padding: 4px 14px; min-height: 24px; color: #aaa; font-size: 13px; border-bottom: 1px solid #222; }
    .gprt-status.gprt-err { color: #ff8a80; }
    .gprt-chip { display: inline-flex; align-items: center; gap: 5px; padding: 2px 9px 2px 5px; border: 1px solid #3a3a3a;
      border-radius: 12px; cursor: pointer; user-select: none; }
    .gprt-chip small { color: #999; }
    .gprt-grid { flex: 1; overflow-y: auto; padding: 8px 14px 40px; }
    .gprt-day { margin-top: 14px; }
    .gprt-dayhead { display: flex; align-items: center; gap: 10px; margin-bottom: 6px; color: #ccc; font-weight: 500; }
    .gprt-dayhead button { padding: 2px 8px; font-size: 12px; }
    .gprt-tiles { display: flex; flex-wrap: wrap; gap: 4px; }
    .gprt-tile { position: relative; width: var(--sz); height: var(--sz); background: #222; overflow: hidden; cursor: zoom-in; border-radius: 2px; }
    .gprt-fit .gprt-tile { width: calc(var(--sz) * var(--ar)); }
    .gprt-tile img { width: 100%; height: 100%; object-fit: cover; display: block; transition: transform .12s; }
    .gprt-tile.gprt-sel img { transform: scale(.88); border-radius: 4px; }
    .gprt-tile.gprt-sel { background: #1a3a66; }
    .gprt-check { position: absolute; top: 6px; left: 6px; width: 22px; height: 22px; border-radius: 50%;
      border: 2px solid #fff; background: rgba(0,0,0,.25); opacity: 0; cursor: pointer; transition: opacity .1s; }
    .gprt-tile:hover .gprt-check, .gprt-has-sel .gprt-check, .gprt-tile.gprt-sel .gprt-check { opacity: 1; }
    .gprt-tile.gprt-sel .gprt-check { background: #1a73e8; border-color: #1a73e8; }
    .gprt-tile.gprt-sel .gprt-check::after { content: ''; position: absolute; left: 5px; top: 1px; width: 6px; height: 11px;
      border: solid #fff; border-width: 0 2px 2px 0; transform: rotate(45deg); }
    .gprt-badge { position: absolute; right: 6px; bottom: 6px; padding: 1px 5px; border-radius: 3px; background: rgba(0,0,0,.6); font-size: 12px; }
    .gprt-empty { padding: 60px 0; text-align: center; color: #888; }
    .gprt-viewer { position: absolute; inset: 0; z-index: 2; display: flex; flex-direction: column; background: #000; }
    .gprt-viewer .gprt-bar { background: #111; }
    .gprt-stage { position: relative; flex: 1; overflow: hidden; cursor: grab; touch-action: none; }
    .gprt-stage.gprt-drag { cursor: grabbing; }
    .gprt-stage img { position: absolute; transform-origin: 0 0; user-select: none; -webkit-user-drag: none; max-width: none; }
    .gprt-zoom { min-width: 56px; text-align: center; font-variant-numeric: tabular-nums; }
    .gprt-nav { position: absolute; top: 50%; transform: translateY(-50%); z-index: 1; width: 44px; height: 64px;
      background: rgba(30,30,30,.6) !important; border: 0 !important; font-size: 22px !important; }
    .gprt-modal-bg { position: absolute; inset: 0; z-index: 3; background: rgba(0,0,0,.6); display: flex; align-items: center; justify-content: center; }
    .gprt-modal { width: min(480px, 92vw); max-height: 80vh; display: flex; flex-direction: column; gap: 10px;
      background: #1e1e1e; border: 1px solid #333; border-radius: 10px; padding: 16px; }
    .gprt-modal h3 { margin: 0; font-size: 16px; }
    .gprt-albums { flex: 1; min-height: 120px; overflow-y: auto; border: 1px solid #333; border-radius: 6px; }
    .gprt-album { display: flex; justify-content: space-between; gap: 8px; padding: 7px 10px; cursor: pointer; }
    .gprt-album:hover { background: #2a2a2a; }
    .gprt-album.gprt-picked { background: #1a3a66; }
    .gprt-album small { color: #999; white-space: nowrap; }
    .gprt-row { display: flex; gap: 8px; align-items: center; }
    .gprt-row input[type=text] { flex: 1; }
  `);

  // ---------------------------------------------------------------------------
  // App state and UI
  // ---------------------------------------------------------------------------

  const S = {
    all: [], // everything loaded for the date range
    items: [], // after type/extension filters; this is what the grid shows
    filterType: 'all', // 'all' | 'photo' | 'video'
    hiddenExts: new Set(), // extensions unticked in the filter bar
    selected: new Set(), // mediaKeys
    lastClicked: null, // index for shift-click ranges
    size: 200,
    crop: true,
    albums: null,
    task: null, // AbortController of the running task
    viewer: null,
  };

  let root, grid, statusEl, selCountEl, btnAlbum, btnDownload, btnCancel, btnLoad, inFrom, inTo, inSource, filterBar, extChips;
  let btnOpenAlbum, btnRemove, btnTrash;

  const UNKNOWN_EXT = '(unknown)';
  function extOf(it) {
    const m = /\.([a-z0-9]+)$/i.exec(it.fileName || '');
    return m ? m[1].toLowerCase() : UNKNOWN_EXT;
  }

  function applyFilters() {
    S.items = S.all.filter((it) => {
      if (S.filterType === 'photo' && it.isVideo) return false;
      if (S.filterType === 'video' && !it.isVideo) return false;
      return !S.hiddenExts.has(extOf(it));
    });
    // Keep only selections that are still visible, so album/download actions match what you see.
    const visible = new Set(S.items.map((it) => it.mediaKey));
    for (const k of [...S.selected]) if (!visible.has(k)) S.selected.delete(k);
    S.lastClicked = null;
    renderGrid();
    if (S.all.length) setStatus(`Showing ${S.items.length} of ${S.all.length} items ${S.source?.label || ''}.`);
  }

  function buildExtChips() {
    const counts = new Map();
    for (const it of S.all) counts.set(extOf(it), (counts.get(extOf(it)) || 0) + 1);
    const exts = [...counts.keys()].sort((a, b) => counts.get(b) - counts.get(a));
    S.hiddenExts = new Set([...S.hiddenExts].filter((e) => counts.has(e)));
    extChips.replaceChildren(...exts.map((ext) =>
      h('label', { class: 'gprt-chip' },
        h('input', {
          type: 'checkbox',
          checked: !S.hiddenExts.has(ext),
          onchange: (e) => { if (e.target.checked) S.hiddenExts.delete(ext); else S.hiddenExts.add(ext); applyFilters(); },
        }),
        ext === UNKNOWN_EXT ? ext : ext.toUpperCase(),
        h('small', {}, String(counts.get(ext))))));
    filterBar.style.display = S.all.length ? '' : 'none';
  }

  function setAllExts(on) {
    S.hiddenExts = on ? new Set() : new Set(S.all.map(extOf));
    buildExtChips();
    applyFilters();
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
    btnRemove = h('button', { onclick: removeSelectedFromAlbum, style: { display: 'none' } }, 'Remove from album');
    btnTrash = h('button', { onclick: trashSelected, style: { color: '#ff8a80' } }, 'Move to trash');

    const sizeLabel = h('span', { class: 'gprt-zoom' }, `${S.size}px`);
    const sizeSlider = h('input', {
      type: 'range', min: '64', max: '600', step: '8', value: String(S.size),
      oninput: (e) => { setTileSize(+e.target.value); sizeLabel.textContent = `${S.size}px`; },
    });
    const cropBox = h('input', { type: 'checkbox', checked: S.crop, onchange: (e) => setCrop(e.target.checked) });

    selCountEl = h('span', {}, '');
    btnAlbum = h('button', { onclick: openAlbumDialog }, 'Add to album…');
    btnDownload = h('button', { onclick: downloadSelected }, 'Download');

    statusEl = h('div', { class: 'gprt-status' }, 'Pick a date range and press Load.');
    extChips = h('div', { class: 'gprt-group', style: { flexWrap: 'wrap' } });
    filterBar = h('div', { class: 'gprt-bar', style: { display: 'none', paddingTop: '6px', paddingBottom: '6px' } },
      h('div', { class: 'gprt-group' }, 'Type',
        h('select', { onchange: (e) => { S.filterType = e.target.value; applyFilters(); } },
          h('option', { value: 'all' }, 'Photos + videos'),
          h('option', { value: 'photo' }, 'Photos only'),
          h('option', { value: 'video' }, 'Videos only'))),
      h('div', { class: 'gprt-group' }, 'Extensions', extChips,
        h('button', { onclick: () => setAllExts(true) }, 'All'),
        h('button', { onclick: () => setAllExts(false) }, 'None')));
    grid = h('div', { class: 'gprt-grid' }, h('div', { class: 'gprt-empty' }, 'No photos loaded.'));
    grid.addEventListener('wheel', (e) => {
      if (!e.ctrlKey && !e.metaKey) return; // ctrl/cmd + wheel resizes tiles
      e.preventDefault();
      const next = Math.max(64, Math.min(600, Math.round(S.size * Math.exp(-e.deltaY * 0.002))));
      sizeSlider.value = String(next);
      setTileSize(next);
      sizeLabel.textContent = `${S.size}px`;
    }, { passive: false });

    root = h('div', { class: `gprt-root${S.crop ? '' : ' gprt-fit'}` },
      h('div', { class: 'gprt-bar' },
        h('div', { class: 'gprt-group' }, 'From', inFrom, 'to', inTo, inSource, btnLoad, 'or', btnOpenAlbum, btnCancel),
        h('div', { class: 'gprt-group' }, 'Size', sizeSlider, sizeLabel,
          h('label', { class: 'gprt-group' }, cropBox, 'Square')),
        h('div', { class: 'gprt-group' },
          h('button', { onclick: () => selectAll(true) }, 'Select all'),
          h('button', { onclick: () => selectAll(false) }, 'Clear'),
          selCountEl, btnAlbum, btnDownload, btnRemove, btnTrash),
        h('div', { class: 'gprt-spacer' }),
        h('button', { onclick: closeApp, title: 'Close (Esc)' }, '✕')),
      filterBar,
      statusEl,
      grid);
    root.style.setProperty('--sz', `${S.size}px`);
    updateSelectionUi();
  }

  function openApp() {
    if (!root) buildApp();
    if (!root.isConnected) document.body.append(root);
    window.addEventListener('keydown', onKey, true);
  }

  function closeApp() {
    if (S.viewer) closeViewer();
    root?.remove();
    window.removeEventListener('keydown', onKey, true);
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
    const ctrl = new AbortController();
    setBusy(ctrl);
    setStatus('Loading…');
    try {
      const items = await fetchItems(ctrl.signal);
      S.source = source;
      S.all = items;
      S.selected.clear();
      let infoError = null;
      if (items.length) {
        try {
          await fetchFileInfo(items, ctrl.signal, (done, total) => setStatus(`Reading file names… ${done}/${total}`));
        } catch (e) {
          if (ctrl.signal.aborted) throw e;
          infoError = e; // grid still works; extension filter shows "(unknown)"
          console.warn('[gprt] file info failed', e);
        }
      }
      buildExtChips();
      applyFilters();
      if (infoError) setStatus(`${items.length} items loaded, but file names could not be read (${infoError.message}). Extension filter unavailable.`, true);
    } catch (e) {
      setStatus(e.message, true);
    } finally {
      setBusy(null);
    }
  }

  // ---- Grid ----

  function thumbBucket() {
    const need = S.size * (window.devicePixelRatio || 1);
    return [128, 192, 256, 384, 512, 768, 1024, 1536].find((b) => b >= need) || 1536;
  }

  function renderGrid() {
    grid.replaceChildren();
    if (!S.items.length) {
      grid.append(h('div', { class: 'gprt-empty' }, S.all.length ? 'No items match the type/extension filter.' : S.source?.type === 'album' ? 'This album is empty.' : 'No photos in this range.'));
      return;
    }
    const bucket = thumbBucket();
    const days = new Map(); // dayKey -> [{ it, idx }], in display order
    S.items.forEach((it, idx) => {
      const key = dayKey(it);
      if (!days.has(key)) days.set(key, []);
      days.get(key).push({ it, idx });
    });
    for (const [key, entries] of days) {
      const dayItems = entries.map((e) => e.it);
      grid.append(h('div', { class: 'gprt-day' },
        h('div', { class: 'gprt-dayhead' }, fmtDay(key), h('small', {}, `${entries.length}`),
          h('button', { onclick: () => toggleGroup(dayItems) }, 'Select day')),
        h('div', { class: 'gprt-tiles' }, entries.map(({ it, idx }) => makeTile(it, idx, bucket)))));
    }
    updateSelectionUi();
  }

  function makeTile(it, idx, bucket) {
    const img = h('img', { loading: 'lazy', decoding: 'async', alt: '', src: coverUrl(it, bucket) });
    img.dataset.bucket = String(bucket);
    const tile = h('div', { class: 'gprt-tile', 'data-idx': String(idx), title: [it.fileName, fmtDateTime(it)].filter(Boolean).join(' · ') },
      img,
      h('div', { class: 'gprt-check', title: 'Select' }),
      it.isVideo ? h('div', { class: 'gprt-badge' }, `▶ ${fmtDuration(it.duration)}`) : null);
    tile.style.setProperty('--ar', aspect(it).toFixed(4));
    if (S.selected.has(it.mediaKey)) tile.classList.add('gprt-sel');
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
    grid.querySelector(`[data-idx="${idx}"]`)?.classList.toggle('gprt-sel', S.selected.has(key));
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

  function refreshTiles() {
    for (const tile of grid.querySelectorAll('.gprt-tile')) {
      tile.classList.toggle('gprt-sel', S.selected.has(S.items[+tile.dataset.idx].mediaKey));
    }
    updateSelectionUi();
  }

  function updateSelectionUi() {
    if (!root) return;
    const n = S.selected.size;
    selCountEl.textContent = `${n} selected`;
    btnAlbum.disabled = n === 0 || !!S.task;
    btnDownload.disabled = n === 0 || !!S.task;
    btnTrash.disabled = n === 0 || !!S.task;
    btnRemove.disabled = n === 0 || !!S.task;
    btnRemove.style.display = S.source?.type === 'album' ? '' : 'none';
    btnOpenAlbum.disabled = !!S.task;
    root.classList.toggle('gprt-has-sel', n > 0);
  }

  function setTileSize(px) {
    S.size = px;
    root.style.setProperty('--sz', `${px}px`);
    const bucket = thumbBucket();
    for (const img of grid.querySelectorAll('.gprt-tile img')) {
      if (+img.dataset.bucket >= bucket) continue; // only upgrade, never downgrade
      const it = S.items[+img.parentElement.dataset.idx];
      img.src = coverUrl(it, bucket);
      img.dataset.bucket = String(bucket);
    }
  }

  function setCrop(on) {
    S.crop = on;
    root.classList.toggle('gprt-fit', !on);
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
    buildExtChips();
    applyFilters();
  }

  async function runAction(items, verb, action) {
    const ctrl = new AbortController();
    setBusy(ctrl);
    try {
      await action((done, total) => setStatus(`${verb}… ${done}/${total}`));
      dropFromView(items);
      S.albums = null; // album counts changed
      return true;
    } catch (e) {
      setStatus(`${verb} failed: ${e.message}. Reload the album to see its current state.`, true);
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function removeSelectedFromAlbum() {
    const album = S.source?.album;
    const items = selectedItems();
    if (!album || !items.length) return;
    if (!confirm(`Remove ${items.length} item${items.length === 1 ? '' : 's'} from "${album.title}"?\n\nThe photos stay in your library.`)) return;
    if (await runAction(items, 'Removing from album', (p) => removeFromAlbum(items, album, p))) {
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

  function openViewer(idx) {
    const img = h('img', { alt: '', draggable: 'false' });
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
        h('button', { onclick: () => downloadItem(S.items[V.idx]).catch((e) => setStatus(e.message, true)) }, 'Download'),
        openLink,
        h('button', { onclick: closeViewer, title: 'Close (Esc)' }, '✕')),
      stage);
    stage.append(
      h('button', { class: 'gprt-nav', style: { left: '8px' }, onclick: () => go(-1) }, '‹'),
      h('button', { class: 'gprt-nav', style: { right: '8px' }, onclick: () => go(1) }, '›'));
    root.append(el);

    const V = { el, idx, z: 1, tx: 0, ty: 0, baseW: 0, baseH: 0, left: 0, top: 0, loadedW: 0, timer: 0, go, zoomBy, fit, actualSize, toggleSel: () => selBtn.click() };
    S.viewer = V;

    function item() {
      return S.items[V.idx];
    }

    function show() {
      const it = item();
      V.loadedW = 0;
      const tile = grid.querySelector(`[data-idx="${V.idx}"] img`);
      img.src = tile?.currentSrc || coverUrl(it, 256); // instant preview from the grid
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
      const forIdx = V.idx;
      const hi = new Image();
      hi.onload = () => {
        if (S.viewer !== V || V.idx !== forIdx) return;
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
  }

  // ---------------------------------------------------------------------------
  // Keyboard (captured so Google Photos' own shortcuts don't fire underneath)
  // ---------------------------------------------------------------------------

  function onKey(e) {
    if (!root?.isConnected) return;
    e.stopImmediatePropagation();
    const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName);
    if (e.key === 'Escape') {
      e.preventDefault();
      const modal = root.querySelector('.gprt-modal-bg');
      if (modal) {
        modal.dispatchEvent(new CustomEvent('gprt-dismiss'));
        modal.remove();
      }
      else if (S.viewer) closeViewer();
      else closeApp();
      return;
    }
    if (typing) return;
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
      ' ': () => V.toggleSel(),
      x: () => V.toggleSel(),
    };
    const fn = actions[e.key];
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
    document.body.append(h('button', { class: 'gprt-launch', onclick: openApp, title: 'Google Photos Range Tools' }, 'Range Tools'));
  }

  try {
    ensureLauncher();
    setInterval(ensureLauncher, 2000); // the page may re-render <body> children
    GM_registerMenuCommand('Open Range Tools', openApp);
    console.info('[gprt] Range Tools loaded');
  } catch (e) {
    console.error('[gprt] failed to start', e);
  }
})();
