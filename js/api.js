/**
 * api.js — FanCheck API client
 * Wired to the exact endpoint spec from the backend team.
 */

const API_BASE = window.location.origin;

// ── Core fetch wrapper ────────────────────────────────────────────────
async function request(method, path, body = null) {
  const headers = { 'Content-Type': 'application/json' };

  const token = localStorage.getItem('hh_token');
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const options = { method, headers };
  if (body !== null) options.body = JSON.stringify(body);

  try {
    const res = await fetch(`${API_BASE}${path}`, options);
    let data = null;
    const ct = res.headers.get('Content-Type') || '';
    data = ct.includes('application/json') ? await res.json() : { message: await res.text() };
    return { ok: res.ok, status: res.status, data };
  } catch {
    return {
      ok: false,
      status: 0,
      data: { message: 'Cannot reach the server. Please try again in a moment.' },
    };
  }
}

// ── Auth ──────────────────────────────────────────────────────────────

/** POST /auth/register — returns { message } */
export async function register(email, password) {
  return request('POST', '/auth/register', { email, password });
}

/** POST /auth/login — returns { token } */
export async function login(email, password) {
  return request('POST', '/auth/login', { email, password });
}

/**
 * GET /auth/spotify
 * Auth required. This is a BROWSER REDIRECT, not a fetch call.
 * We append the token as a query param because a redirect
 * cannot carry an Authorization header.
 */
export function connectSpotify() {
  const token = localStorage.getItem('hh_token');
  window.location.href = `${API_BASE}/auth/spotify?token=${encodeURIComponent(token)}`;
}

// ── Report ────────────────────────────────────────────────────────────

/** GET /report — auth required — returns full report card JSON */
export async function getReport() {
  return request('GET', '/report');
}

// ── Token helpers ─────────────────────────────────────────────────────
export function saveToken(token) {
  localStorage.setItem('hh_token', token);
}

export function clearToken() {
  localStorage.removeItem('hh_token');
}

export function getToken() {
  return localStorage.getItem('hh_token');
}

export function isLoggedIn() {
  return Boolean(getToken());
}
