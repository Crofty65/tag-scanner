// Network calls: Cloud Vision (text reading) and the Apps Script web app (sheet writes).
// Any failed request (no response, timeout, 5xx) is treated as "no signal" — navigator.onLine isn't reliable.

export class OfflineError extends Error {}
export class ApiError extends Error {}

async function request(url, init, timeoutMs = 20000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(url, { ...init, signal: ctl.signal });
  } catch (e) {
    throw new OfflineError(String(e));
  } finally {
    clearTimeout(t);
  }
  if (res.status >= 500) throw new OfflineError('HTTP ' + res.status);
  let body;
  try { body = await res.json(); } catch { throw new ApiError('Unexpected response (HTTP ' + res.status + ')'); }
  return { res, body };
}

export function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1]);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

export async function readText(blob, apiKey) {
  if (!apiKey) throw new ApiError('No Vision API key — add it in setup.');
  const content = await blobToBase64(blob);
  const { res, body } = await request('https://vision.googleapis.com/v1/images:annotate?key=' + encodeURIComponent(apiKey), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requests: [{ image: { content }, features: [{ type: 'DOCUMENT_TEXT_DETECTION' }] }] }),
  });
  if (!res.ok || body.error) throw new ApiError(body.error?.message || 'Vision HTTP ' + res.status);
  const r = body.responses?.[0] || {};
  if (r.error) throw new ApiError(r.error.message);
  return r;
}

// Apps Script doesn't answer CORS preflights, so send JSON as text/plain.
export async function sheetCall(settings, action, payload = {}) {
  if (!settings.scriptUrl) throw new ApiError('No Apps Script URL — add it in setup.');
  const { body } = await request(settings.scriptUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ token: settings.token, action, ...payload }),
  });
  if (!body.ok) throw new ApiError(body.error || 'Sheet error');
  return body;
}
