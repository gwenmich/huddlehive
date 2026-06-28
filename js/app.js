// ================================================
// api.js — shared API wrapper for FanCheck
// Backend base URL
// ================================================

const API_BASE = "http://127.0.0.1:5001";

// ------------------------------------------------
// Token helpers
// ------------------------------------------------
const Auth = {
    getToken:   ()       => localStorage.getItem('hh_token'),
    setToken:   (token)  => localStorage.setItem('hh_token', token),
    clearToken: ()       => localStorage.removeItem('hh_token'),
    isLoggedIn: ()       => !!localStorage.getItem('hh_token'),
};

// ------------------------------------------------
// Core fetch wrapper
// ------------------------------------------------
async function apiFetch(path, options = {}) {
    const token = Auth.getToken();

    const headers = {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(options.headers || {}),
    };

    const response = await fetch(`${API_BASE}${path}`, {
        ...options,
        headers,
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
        throw new Error(data.error || `Request failed (${response.status})`);
    }

    return data;
}

// ------------------------------------------------
// Auth endpoints — POST /auth/register, /auth/login
// ------------------------------------------------
const AuthAPI = {
    register: (email, password) =>
        apiFetch('/auth/register', {
            method: 'POST',
            body: JSON.stringify({ email, password }),
        }),

    login: (email, password) =>
        apiFetch('/auth/login', {
            method: 'POST',
            body: JSON.stringify({ email, password }),
        }),
};

// ------------------------------------------------
// Report endpoint — GET /report (JWT required)
// ------------------------------------------------
const ReportAPI = {
    get: () => apiFetch('/report'),
};

// ------------------------------------------------
// Spotify connect — GET /auth/spotify (JWT required)
// Redirects to Spotify OAuth
// ------------------------------------------------
const SpotifyAPI = {
    connect: () => {
        window.location.href = `${API_BASE}/auth/spotify`;
    },
};

// ------------------------------------------------
// Toast utility
// ------------------------------------------------
function showToast(message, type = '') {
    const toast = document.getElementById('toast');
    if (!toast) return;

    toast.textContent = message;
    toast.className = `toast ${type} show`;

    setTimeout(() => {
        toast.className = 'toast';
    }, 3200);
}

// ------------------------------------------------
// Redirect if not logged in
// ------------------------------------------------
function requireAuth() {
    if (!Auth.isLoggedIn()) {
        window.location.href = '/pages/auth.html';
    }
}
