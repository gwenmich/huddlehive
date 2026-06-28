/**
 * auth.js — FanCheck authentication page
 * Tab switching, form validation, backend submission.
 */

import { login, register, saveToken, isLoggedIn } from './api.js';

// Redirect if already authenticated
if (isLoggedIn()) {
  window.location.replace('../pages/dashboard.html');
}

// ── Elements ─────────────────────────────────────────────────────────
const tabLogin  = document.getElementById('tab-login');
const tabSignup = document.getElementById('tab-signup');
const formLogin  = document.getElementById('form-login');
const formSignup = document.getElementById('form-signup');

// ── Tab switching ─────────────────────────────────────────────────────
function showTab(tab) {
  const isLogin = tab === 'login';

  tabLogin.setAttribute('aria-selected',  String(isLogin));
  tabSignup.setAttribute('aria-selected', String(!isLogin));

  if (isLogin) {
    formLogin.removeAttribute('hidden');
    formSignup.setAttribute('hidden', '');
  } else {
    formSignup.removeAttribute('hidden');
    formLogin.setAttribute('hidden', '');
  }

  history.replaceState(null, '', isLogin ? '#login' : '#signup');
  clearErrors();
}

tabLogin.addEventListener('click',  () => showTab('login'));
tabSignup.addEventListener('click', () => showTab('signup'));

// Initialise from URL hash (supports direct links to #signup)
showTab(window.location.hash === '#signup' ? 'signup' : 'login');

// ── Toast helper ──────────────────────────────────────────────────────
function showToast(message, type = 'error') {
  let toast = document.querySelector('.toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.className = 'toast';
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.className = `toast ${type}`;
  // Force reflow so the transition fires even when reusing the element
  void toast.offsetWidth;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 3500);
}

// ── Inline form error ─────────────────────────────────────────────────
function showError(formEl, message) {
  let errEl = formEl.querySelector('.form-error');
  if (!errEl) {
    errEl = document.createElement('p');
    errEl.className = 'form-error';
    errEl.setAttribute('role', 'alert');
    // Insert before the first field, after any existing content
    formEl.insertBefore(errEl, formEl.firstChild);
  }
  errEl.textContent = message;
  errEl.removeAttribute('hidden');
}

function clearErrors() {
  document.querySelectorAll('.form-error').forEach(el => {
    el.setAttribute('hidden', '');
    el.textContent = '';
  });
}

// ── Loading state ─────────────────────────────────────────────────────
function setLoading(btn, isLoading) {
  btn.disabled = isLoading;
  if (!btn.dataset.label) btn.dataset.label = btn.textContent;
  btn.textContent = isLoading ? 'Please wait…' : btn.dataset.label;
}

// ── Login ─────────────────────────────────────────────────────────────
formLogin.addEventListener('submit', async (e) => {
  e.preventDefault();
  clearErrors();

  const email    = formLogin.querySelector('[name="email"]').value.trim();
  const password = formLogin.querySelector('[name="password"]').value;
  const btn      = formLogin.querySelector('button[type="submit"]');

  if (!email || !password) {
    showError(formLogin, 'Please fill in both fields.');
    return;
  }

  setLoading(btn, true);
  const { ok, data } = await login(email, password);
  setLoading(btn, false);

  if (ok && data.token) {
    saveToken(data.token);
    window.location.href = '../pages/dashboard.html';
  } else {
    const message = data.message || data.error || 'Incorrect email or password.';
    showError(formLogin, message);
    showToast(message, 'error');
  }
});

// ── Register ──────────────────────────────────────────────────────────
formSignup.addEventListener('submit', async (e) => {
  e.preventDefault();
  clearErrors();

  const email    = formSignup.querySelector('[name="email"]').value.trim();
  const password = formSignup.querySelector('[name="password"]').value;
  const confirm  = formSignup.querySelector('[name="confirm-password"]').value;
  const btn      = formSignup.querySelector('button[type="submit"]');

  if (!email || !password || !confirm) {
    showError(formSignup, 'Please fill in all fields.');
    return;
  }
  if (password !== confirm) {
    showError(formSignup, 'Passwords do not match.');
    return;
  }
  if (password.length < 8) {
    showError(formSignup, 'Password must be at least 8 characters.');
    return;
  }

  setLoading(btn, true);
  const { ok, data } = await register(email, password);

  if (ok) {
    // Auto-login immediately after registration
    const loginResult = await login(email, password);
    setLoading(btn, false);
    if (loginResult.ok && loginResult.data.token) {
      saveToken(loginResult.data.token);
      window.location.href = '../pages/dashboard.html';
    } else {
      showTab('login');
      showToast('Account created — please log in.', 'success');
    }
  } else {
    setLoading(btn, false);
    const message = data.message || data.error || 'Registration failed. That email may already be in use.';
    showError(formSignup, message);
    showToast(message, 'error');
  }
});
