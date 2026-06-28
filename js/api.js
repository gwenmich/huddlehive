/**
 * api.js — FanCheck API client
 */
const API_BASE = "https://fancheck-wzpz.onrender.com";

// ── Core fetch wrapper ────────────────────────────────────────────────
async function request(method, path, body = null) {
  const headers = { 'Content-Type': 'application/json' };
  const token = localStorage.getItem('hh_token');
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const options = { method, headers };
  if (body !== null) options.body = JSON.stringify(body);

  try {
    const res = await fetch(`${API_BASE}${path}`, options);
    const ct  = res.headers.get('Content-Type') || '';
    const data = ct.includes('application/json') ? await res.json() : { message: await res.text() };
    if (!res.ok && data.error && !data.message) data.message = data.error;
    return { ok: res.ok, status: res.status, data };
  } catch {
    return { ok: false, status: 0, data: { message: 'Cannot reach the server. Make sure python3 app.py is running.' } };
  }
}

// ── Token helpers ─────────────────────────────────────────────────────
export function saveToken(t)  { localStorage.setItem('hh_token', t); }
export function clearToken()  { localStorage.removeItem('hh_token'); }
export function getToken()    { return localStorage.getItem('hh_token'); }

function getTokenExp(token) {
  try {
    const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g,'+').replace(/_/g,'/')));
    return payload.exp || null;
  } catch { return null; }
}

export function isTokenExpired(token) {
  if (!token) return true;
  const exp = getTokenExp(token);
  return !exp || (Date.now() / 1000) >= (exp - 60);
}

export function isLoggedIn() {
  const t = getToken();
  return Boolean(t) && !isTokenExpired(t);
}

// ── Auth ──────────────────────────────────────────────────────────────
export async function register(email, password) {
  return request('POST', '/auth/register', { email, password });
}

export async function login(email, password) {
  return request('POST', '/auth/login', { email, password });
}

// ── Spotify OAuth redirect ────────────────────────────────────────────
export function connectSpotify(event) {
  if (event) { event.preventDefault(); event.stopPropagation(); }

  const token = getToken();
  if (!token || isTokenExpired(token)) {
    clearToken();
    window.location.href = '../pages/auth.html?reason=session_expired';
    return;
  }

  const url = `${API_BASE}/auth/spotify?token=${encodeURIComponent(token)}&frontend_url=${encodeURIComponent(window.location.origin)}`;
  window.location.href = url;
}

// ── Report ────────────────────────────────────────────────────────────
export async function getReport() {
  return request('GET', '/report');
}