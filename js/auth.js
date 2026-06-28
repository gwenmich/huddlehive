/**
 * auth.js — FanCheck login & register
 */
import { login, register, saveToken, isLoggedIn } from './api.js';

document.addEventListener('DOMContentLoaded', () => {

  // Already logged in → skip straight to dashboard
  if (isLoggedIn()) {
    window.location.replace('../pages/dashboard.html');
    return;
  }

  // Show a banner if we were sent here because the session expired
  const reason = new URLSearchParams(window.location.search).get('reason');
  if (reason) {
    const messages = {
      session_expired:  'Your session expired. Please log in again.',
      session_required: 'Please log in to continue.',
      invalid_token:    'Your login token was invalid. Please log in again.',
      user_not_found:   'Account not found. Please log in.',
    };
    const banner = document.getElementById('session-banner');
    if (banner) {
      banner.textContent = messages[reason] || 'Please log in to continue.';
      banner.removeAttribute('hidden');
    }
  }

  // If URL has #signup, switch to register tab immediately
  if (window.location.hash === '#signup') switchTab('signup');

  // Tab buttons
  document.getElementById('tab-login') ?.addEventListener('click', () => switchTab('login'));
  document.getElementById('tab-signup')?.addEventListener('click', () => switchTab('signup'));

  // Form submissions
  document.getElementById('form-login') ?.addEventListener('submit', handleLogin);
  document.getElementById('form-signup')?.addEventListener('submit', handleRegister);
});

// ── Tab switching ─────────────────────────────────────────────────────
function switchTab(tab) {
  const isLogin = tab === 'login';
  document.getElementById('form-login') ?.toggleAttribute('hidden', !isLogin);
  document.getElementById('form-signup')?.toggleAttribute('hidden',  isLogin);
  document.getElementById('tab-login') ?.setAttribute('aria-selected', String( isLogin));
  document.getElementById('tab-signup')?.setAttribute('aria-selected', String(!isLogin));
  clearError();
}

// ── Login ─────────────────────────────────────────────────────────────
async function handleLogin(e) {
  e.preventDefault();
  const email    = document.getElementById('login-email')   ?.value.trim();
  const password = document.getElementById('login-password')?.value;

  if (!email || !password) return showError('Please fill in your email and password.');

  setBusy('form-login', true, 'Logging in…');
  try {
    const { ok, data } = await login(email, password);
    if (ok && data.token) {
      saveToken(data.token);
      window.location.href = '../pages/dashboard.html';
    } else {
      showError(data.message || data.error || 'Login failed. Check your email and password.');
    }
  } catch {
    showError('Cannot reach the server. Make sure python3 app.py is running.');
  } finally {
    setBusy('form-login', false, 'Log in');
  }
}

// ── Register ──────────────────────────────────────────────────────────
async function handleRegister(e) {
  e.preventDefault();
  const email    = document.getElementById('signup-email')   ?.value.trim();
  const password = document.getElementById('signup-password')?.value;
  const confirm  = document.getElementById('signup-confirm') ?.value;

  if (!email || !password || !confirm) return showError('Please fill in all fields.');
  if (password.length < 8)             return showError('Password must be at least 8 characters.');
  if (password !== confirm)            return showError('Passwords do not match.');

  setBusy('form-signup', true, 'Creating account…');
  try {
    const { ok, data } = await register(email, password);
    if (ok) {
      // Auto-login immediately after registering
      const loginResult = await login(email, password);
      if (loginResult.ok && loginResult.data.token) {
        saveToken(loginResult.data.token);
        window.location.href = '../pages/dashboard.html';
      } else {
        // Registration worked but auto-login failed — just show login tab
        showError('Account created! Please log in.');
        switchTab('login');
        document.getElementById('login-email').value = email;
      }
    } else {
      showError(data.message || data.error || 'Registration failed. Try a different email.');
    }
  } catch {
    showError('Cannot reach the server. Make sure python3 app.py is running.');
  } finally {
    setBusy('form-signup', false, 'Create account');
  }
}

// ── Helpers ───────────────────────────────────────────────────────────
function showError(msg) {
  const el = document.getElementById('auth-error');
  if (el) { el.textContent = msg; el.removeAttribute('hidden'); }
}

function clearError() {
  const el = document.getElementById('auth-error');
  if (el) { el.textContent = ''; el.setAttribute('hidden', ''); }
}

function setBusy(formId, busy, label) {
  const btn = document.querySelector(`#${formId} button[type="submit"]`);
  if (btn) { btn.disabled = busy; btn.textContent = label; }
}