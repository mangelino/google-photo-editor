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
