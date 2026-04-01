// Auth helper — multi-company aware
function _getSlot() {
  return sessionStorage.getItem('tf_slot') || null;
}
function getAuth() {
  const slot = _getSlot();
  if (!slot) return null;
  try { return JSON.parse(localStorage.getItem('tf_auth_' + slot)) || null; } catch(e) { return null; }
}
function setAuth(data) {
  const slot = data.username || 'default';
  sessionStorage.setItem('tf_slot', slot);
  localStorage.setItem('tf_auth_' + slot, JSON.stringify(data));
}
function clearAuth() {
  const slot = _getSlot();
  if (slot) localStorage.removeItem('tf_auth_' + slot);
  sessionStorage.removeItem('tf_slot');
}
async function apiFetch(url, options = {}) {
  const a = getAuth();
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (a && a.token) headers['Authorization'] = 'Bearer ' + a.token;
  return fetch(url, { ...options, headers });
}
async function apiUpload(url, formData) {
  const a = getAuth();
  const headers = {};
  if (a && a.token) headers['Authorization'] = 'Bearer ' + a.token;
  return fetch(url, { method: 'POST', headers, body: formData });
}
async function tfLogout() {
  try { await apiFetch('/api/logout', { method: 'POST' }); } catch(e) {}
  clearAuth();
  window.location.href = '/';
}
