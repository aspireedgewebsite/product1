// Shared helpers for all pages.
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const inr = (n) => '₹' + (+n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const store = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} }, del: (k) => { try { localStorage.removeItem(k); } catch {} } };
let token = store.get('rbs_token');

function toast(msg, ms = 2600) {
  let t = $('#toast'); if (!t) { t = document.createElement('div'); t.id = 'toast'; document.body.append(t); }
  t.textContent = msg; t.classList.add('on'); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('on'), ms);
}
class NetError extends Error {}
async function api(method, url, body) {
  let r;
  try { r = await fetch('/api' + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }); }
  catch { throw new NetError('You appear to be offline'); }
  const ct = r.headers.get('content-type') || '';
  const data = ct.includes('json') ? await r.json() : await r.text();
  if (r.status === 401 && token) { store.del('rbs_token'); location.href = '/'; }
  if (!r.ok) { const e = new Error(data.error || 'Request failed'); e.status = r.status; e.data = data; throw e; }
  return data;
}
const get = (u) => api('GET', u), post = (u, b = {}) => api('POST', u, b), put = (u, b) => api('PUT', u, b), del = (u) => api('DELETE', u);
const guard = (fn) => async (...a) => { try { return await fn(...a); } catch (e) { toast(e.message); } };
function logout() { store.del('rbs_token'); location.href = '/'; }
function modal(html, onMount) {
  const m = document.createElement('div'); m.className = 'modal'; m.innerHTML = `<div class="card">${html}</div>`;
  m.addEventListener('mousedown', (e) => { if (e.target === m) m.remove(); }); document.body.append(m); onMount && onMount(m); return m;
}
function download(url, name) { // authenticated file download
  fetch('/api' + url, { headers: { Authorization: 'Bearer ' + token } }).then((r) => r.blob()).then((b) => { const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = name; a.click(); });
}
function openPrint(url) { // authenticated print page opened in a new tab via blob
  fetch('/api' + url, { headers: { Authorization: 'Bearer ' + token } }).then((r) => r.text()).then((h) => { const w = window.open('', '_blank'); if (w) { w.document.write(h); w.document.close(); } });
}
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('/sw.js').catch(() => {});
