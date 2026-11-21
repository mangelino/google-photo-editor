// Tampermonkey adapter. STYLES is injected by the build.

GM_addStyle(STYLES);

const platform = {
  // Fetch with the user's cookies (GM_xmlhttpRequest bypasses CORS), then save via a blob link.
  async download({ url, fileName, fallbackName }) {
    const r = await new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        responseType: 'blob',
        timeout: 10 * 60 * 1000,
        onload: (res) => (res.status >= 200 && res.status < 300 ? resolve(res) : reject(new Error(`HTTP ${res.status}`))),
        onerror: () => reject(new Error('network error')),
        ontimeout: () => reject(new Error('timeout')),
      });
    });
    const header = (name) => {
      const m = new RegExp(`^${name}:\\s*(.*)$`, 'im').exec(r.responseHeaders || '');
      return m ? m[1].trim() : '';
    };
    const name = fileName || filenameFromDisposition(header('content-disposition')) || fallbackName(header('content-type'));
    const blobUrl = URL.createObjectURL(r.response);
    const a = document.createElement('a');
    a.href = blobUrl;
    a.download = name;
    a.style.display = 'none';
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(blobUrl), 60 * 1000);
  },

  onOpenRequest(open) {
    GM_registerMenuCommand('Open Light Table', open);
  },
};

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
