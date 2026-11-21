// Light Table service worker.

const PHOTOS = 'https://photos.google.com/';

chrome.action.onClicked.addListener(async (tab) => {
  if (tab.url?.startsWith(PHOTOS)) {
    chrome.tabs.sendMessage(tab.id, { type: 'open' }).catch(() => {
      // Content script not there yet (tab opened before install): reload once.
      chrome.tabs.reload(tab.id);
    });
  } else {
    chrome.tabs.create({ url: PHOTOS });
  }
});

// Keep only characters that are valid in a filename on every OS.
const safeName = (name) => name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/^\.+/, '_').slice(0, 200);

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== 'download' || !sender.tab?.url?.startsWith(PHOTOS)) return false;
  let url;
  try {
    url = new URL(msg.url);
  } catch {
    sendResponse({ ok: false, error: 'invalid URL' });
    return false;
  }
  const host = url.hostname;
  if (url.protocol !== 'https:' || !(host.endsWith('.googleusercontent.com') || host.endsWith('.usercontent.google.com'))) {
    sendResponse({ ok: false, error: `refusing to download from ${host}` });
    return false;
  }
  const options = { url: url.href, conflictAction: 'uniquify' };
  if (msg.fileName) options.filename = safeName(msg.fileName);
  chrome.downloads.download(options).then(
    (id) => sendResponse(id ? { ok: true } : { ok: false, error: chrome.runtime.lastError?.message || 'download failed' }),
    (e) => sendResponse({ ok: false, error: e.message }),
  );
  return true; // async response
});
