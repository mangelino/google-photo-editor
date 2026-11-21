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
