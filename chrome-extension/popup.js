const DEFAULT_BACKEND_URL = 'https://fancheck.onrender.com';

const els = {
  connectionStatus: document.getElementById('connection-status'),
  statusMessage: document.getElementById('status-message'),
  checkPage: document.getElementById('check-page'),
  actionStatus: document.getElementById('action-status'),
  popupConsentPanel: document.getElementById('popup-consent-panel'),
  allowAllSites: document.getElementById('allow-all-sites'),
  allowThisSite: document.getElementById('allow-this-site'),
  denyConsent: document.getElementById('deny-consent'),
  analysisFailure: document.getElementById('analysis-failure'),
  showSuggestSite: document.getElementById('show-suggest-site'),
  suggestSitePanel: document.getElementById('suggest-site-panel'),
  sendSuggestion: document.getElementById('send-suggestion'),
  reportNote: document.getElementById('report-note'),
  loginForm: document.getElementById('login-form'),
  email: document.getElementById('email'),
  password: document.getElementById('password'),
  accountSubmit: document.getElementById('account-submit'),
  modeSignin: document.getElementById('mode-signin'),
  modeRegister: document.getElementById('mode-register'),
  disconnect: document.getElementById('disconnect'),
  consentStatus: document.getElementById('consent-status'),
  revokeGlobal: document.getElementById('revoke-global'),
  revokeSite: document.getElementById('revoke-site'),
  openFancheck: document.getElementById('open-fancheck'),
  openDetail: document.getElementById('open-detail')
};

let currentTab = null;
let currentState = null;
let accountMode = 'signin';
let analysisTab = null;

function setStatus(message, type = '') {
  els.statusMessage.textContent = message || '';
  els.statusMessage.className = `popup-status ${type}`.trim();
}

function setActionStatus(message, type = '') {
  els.actionStatus.textContent = message || '';
  els.actionStatus.className = `popup-action-status ${type}`.trim();
}

function setBusy(isBusy, label) {
  els.accountSubmit.disabled = isBusy;
  els.checkPage.disabled = isBusy;
  els.sendSuggestion.disabled = isBusy;
  els.allowAllSites.disabled = isBusy;
  els.allowThisSite.disabled = isBusy;
  els.denyConsent.disabled = isBusy;
  if (label) setStatus(label);
}

function sendBackground(message) {
  return chrome.runtime.sendMessage(message);
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url || !/^https?:\/\//i.test(tab.url)) {
    throw new Error('Open an http or https page first.');
  }
  return tab;
}

function tabHostname(tab) {
  try {
    return new URL(tab.url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
}

function hasConsentForTab(tab) {
  const host = tabHostname(tab);
  return Boolean(currentState?.globalConsent || (host && currentState?.domainConsent?.[host] === true));
}

async function ensureContent(tabId) {
  try {
    const ping = await chrome.tabs.sendMessage(tabId, { type: 'FC_PING' });
    if (ping?.ok) return;
  } catch {
    // Inject below.
  }

  await chrome.scripting.insertCSS({ target: { tabId }, files: ['styles.css'] });
  await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
}

async function scanCurrentTab() {
  const tab = await activeTab();
  await ensureContent(tab.id);
  const response = await chrome.tabs.sendMessage(tab.id, { type: 'FC_SCAN_PAGE' });
  if (!response?.ok) {
    throw new Error('Could not scan this page.');
  }
  return { tab, scan: response.scan };
}

function setAccountMode(mode) {
  accountMode = mode;
  const isRegister = mode === 'register';
  els.modeSignin.classList.toggle('active', !isRegister);
  els.modeRegister.classList.toggle('active', isRegister);
  els.modeSignin.setAttribute('aria-pressed', String(!isRegister));
  els.modeRegister.setAttribute('aria-pressed', String(isRegister));
  els.accountSubmit.textContent = isRegister ? 'Create account' : 'Sign in';
  els.password.autocomplete = isRegister ? 'new-password' : 'current-password';
  setStatus('');
}

function renderConsentState() {
  const host = currentTab ? tabHostname(currentTab) : '';
  const siteConsent = host && currentState?.domainConsent?.[host] === true;
  if (currentState?.globalConsent) {
    els.consentStatus.textContent = 'Source checks: allowed for all sites';
  } else if (siteConsent) {
    els.consentStatus.textContent = `Source checks: allowed for ${host}`;
  } else {
    els.consentStatus.textContent = 'Source checks: ask first';
  }
  els.revokeGlobal.disabled = !currentState?.globalConsent && !Object.keys(currentState?.domainConsent || {}).length;
  els.revokeSite.disabled = !siteConsent;
}

async function loadState() {
  currentTab = await chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => tab || null);
  const response = await sendBackground({ type: 'FC_GET_STATE' });
  if (!response?.ok) throw new Error(response?.error || 'Could not load extension state.');
  currentState = response.data;

  els.connectionStatus.textContent = currentState.connected ? 'Connected to FanCheck' : 'Not connected';
  els.disconnect.disabled = !currentState.connected;
  els.openDetail.disabled = !currentState.lastDetailUrl;
  renderConsentState();
}

async function analyseThisPurchase() {
  setStatus('');
  setActionStatus('Preparing source check...');
  els.analysisFailure.hidden = true;
  els.suggestSitePanel.hidden = true;
  els.popupConsentPanel.hidden = true;
  const tab = await activeTab();
  analysisTab = tab;

  if (!hasConsentForTab(tab)) {
    els.popupConsentPanel.hidden = false;
    setActionStatus('Choose whether FanCheck can send a redacted snippet for this page.');
    return;
  }

  await runConfirmedAnalysis(tab);
}

async function runConfirmedAnalysis(tab) {
  const originalLabel = els.checkPage.textContent;
  setBusy(true);
  els.checkPage.textContent = 'Analysing...';
  setActionStatus('Analysing with current public sources...');
  try {
    await ensureContent(tab.id);
    const response = await chrome.tabs.sendMessage(tab.id, { type: 'FC_START_ANALYZE_CONFIRMED' });
    if (!response?.ok) {
      els.analysisFailure.hidden = false;
      setActionStatus('FanCheck could not analyse this page yet.', 'error');
      return;
    }
    setActionStatus('FanCheck overlay updated on this page.', 'success');
    await loadState();
  } catch (error) {
    els.analysisFailure.hidden = false;
    setActionStatus('FanCheck could not analyse this page yet.', 'error');
    setStatus(error.message || 'Source check failed.', 'error');
  } finally {
    setBusy(false);
    els.checkPage.textContent = originalLabel;
  }
}

function showSuggestionPanel() {
  els.suggestSitePanel.hidden = false;
  els.reportNote.focus();
  setStatus('');
}

async function grantConsent(scope) {
  const tab = analysisTab || await activeTab();
  const host = tabHostname(tab);
  if (!host) throw new Error('Open an http or https page first.');
  const message = scope === 'global'
    ? { type: 'FC_GRANT_GLOBAL_CONSENT' }
    : { type: 'FC_GRANT_SITE_CONSENT', hostname: host };
  const response = await sendBackground(message);
  if (!response?.ok) throw new Error(response?.error || 'Could not save permission.');
  els.popupConsentPanel.hidden = true;
  await loadState();
  await runConfirmedAnalysis(tab);
}

async function denyConsent() {
  els.popupConsentPanel.hidden = true;
  setActionStatus('No page text was sent.', 'success');
  await loadState();
}

async function sendSiteSuggestion() {
  setStatus('Sending suggestion...');
  const { scan } = await scanCurrentTab();
  const note = els.reportNote.value.trim().slice(0, 500);
  const response = await sendBackground({
    type: 'FC_REPORT_SITE',
    payload: {
      url: scan.url,
      hostname: scan.hostname,
      page_title: scan.title,
      user_note: note || null,
      local_signals: scan.localSignals || {}
    }
  });
  if (!response?.ok) {
    throw new Error(response?.error || 'Could not send this suggestion.');
  }
  const data = response.data || {};
  setStatus(data.message || 'Thanks, we’ll review this site before enabling analysis.', 'success');
  els.reportNote.value = '';
  els.suggestSitePanel.hidden = true;
}

async function connectAccount(event) {
  event.preventDefault();
  const email = els.email.value.trim();
  const password = els.password.value;
  if (!email || !password) {
    throw new Error('Enter email and password.');
  }

  setBusy(true, accountMode === 'register' ? 'Creating account...' : 'Signing in...');
  try {
    const message = accountMode === 'register'
      ? { type: 'FC_REGISTER', payload: { email, password } }
      : { type: 'FC_LOGIN', payload: { email, password } };
    const response = await sendBackground(message);
    if (!response?.ok) throw new Error(response?.error || 'Could not connect account.');
    setStatus(accountMode === 'register' ? 'Account created and connected.' : 'Connected to FanCheck.', 'success');
    await loadState();
  } finally {
    els.password.value = '';
    setBusy(false);
  }
}

async function disconnect() {
  const response = await sendBackground({ type: 'FC_LOGOUT' });
  if (!response?.ok) throw new Error(response?.error || 'Could not disconnect.');
  setStatus('Disconnected.', 'success');
  await loadState();
}

async function revokeGlobalConsent() {
  const response = await sendBackground({ type: 'FC_REVOKE_GLOBAL_CONSENT' });
  if (!response?.ok) throw new Error(response?.error || 'Could not revoke permissions.');
  setStatus('Source-check permissions revoked.', 'success');
  await loadState();
}

async function revokeSiteConsent() {
  const host = currentTab ? tabHostname(currentTab) : '';
  if (!host) throw new Error('No current site to revoke.');
  const response = await sendBackground({ type: 'FC_REVOKE_SITE_CONSENT', hostname: host });
  if (!response?.ok) throw new Error(response?.error || 'Could not revoke permissions for this site.');
  setStatus('Site permission revoked.', 'success');
  await loadState();
}

function wrap(handler) {
  return async (event) => {
    try {
      await handler(event);
    } catch (error) {
      setActionStatus(error.message || 'Something went wrong.', 'error');
      setStatus(error.message || 'Something went wrong.', 'error');
    }
  };
}

els.checkPage.addEventListener('click', wrap(analyseThisPurchase));
els.allowAllSites.addEventListener('click', wrap(() => grantConsent('global')));
els.allowThisSite.addEventListener('click', wrap(() => grantConsent('site')));
els.denyConsent.addEventListener('click', wrap(denyConsent));
els.showSuggestSite.addEventListener('click', showSuggestionPanel);
els.sendSuggestion.addEventListener('click', wrap(sendSiteSuggestion));
els.modeSignin.addEventListener('click', () => setAccountMode('signin'));
els.modeRegister.addEventListener('click', () => setAccountMode('register'));
els.loginForm.addEventListener('submit', wrap(connectAccount));
els.disconnect.addEventListener('click', wrap(disconnect));
els.revokeGlobal.addEventListener('click', wrap(revokeGlobalConsent));
els.revokeSite.addEventListener('click', wrap(revokeSiteConsent));
els.openFancheck.addEventListener('click', () => {
  chrome.tabs.create({ url: DEFAULT_BACKEND_URL });
});
els.openDetail.addEventListener('click', wrap(async () => {
  const response = await sendBackground({ type: 'FC_GET_STATE' });
  const detailUrl = response?.data?.lastDetailUrl;
  if (!detailUrl) throw new Error('No source detail page yet.');
  chrome.tabs.create({ url: detailUrl });
}));

setAccountMode('signin');
loadState().catch((error) => setStatus(error.message, 'error'));
