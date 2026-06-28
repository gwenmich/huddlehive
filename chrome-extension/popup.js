const DEFAULT_BACKEND_URL = 'https://fancheck.onrender.com';

const els = {
  connectionStatus: document.getElementById('connection-status'),
  statusMessage: document.getElementById('status-message'),
  checkPage: document.getElementById('check-page'),
  reportSite: document.getElementById('report-site'),
  reportNote: document.getElementById('report-note'),
  loginForm: document.getElementById('login-form'),
  email: document.getElementById('email'),
  password: document.getElementById('password'),
  disconnect: document.getElementById('disconnect'),
  backendUrl: document.getElementById('backend-url'),
  saveBackend: document.getElementById('save-backend'),
  region: document.getElementById('region'),
  savePreferences: document.getElementById('save-preferences'),
  consentStatus: document.getElementById('consent-status'),
  revokeGlobal: document.getElementById('revoke-global'),
  revokeSite: document.getElementById('revoke-site'),
  openFancheck: document.getElementById('open-fancheck'),
  openDetail: document.getElementById('open-detail')
};

let currentTab = null;
let currentState = null;

function setStatus(message, type = '') {
  els.statusMessage.textContent = message || '';
  els.statusMessage.className = `popup-status ${type}`.trim();
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

async function loadState() {
  currentTab = await chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => tab || null);
  const response = await sendBackground({ type: 'FC_GET_STATE' });
  if (!response?.ok) throw new Error(response?.error || 'Could not load extension state.');
  currentState = response.data;

  els.connectionStatus.textContent = currentState.connected ? 'Connected to FanCheck' : 'Not connected';
  els.backendUrl.value = currentState.backendUrl || DEFAULT_BACKEND_URL;
  els.region.value = currentState.preferences.region || 'UK';

  const preferred = new Set(currentState.preferences.preferredAlternativeTypes || []);
  document.querySelectorAll('input[name="alternative"]').forEach((input) => {
    input.checked = preferred.has(input.value);
  });

  const host = currentTab ? tabHostname(currentTab) : '';
  const siteConsent = host && currentState.domainConsent?.[host] === true;
  els.consentStatus.textContent = [
    currentState.globalConsent ? 'Global consent enabled' : 'Global consent off',
    host ? `${host}: ${siteConsent ? 'site consent enabled' : 'site consent off'}` : null
  ].filter(Boolean).join(' · ');
  els.revokeSite.disabled = !siteConsent;
  els.openDetail.disabled = !currentState.lastDetailUrl;
}

async function checkThisPage() {
  setStatus('Preparing page check...');
  const tab = await activeTab();
  await ensureContent(tab.id);
  const response = await chrome.tabs.sendMessage(tab.id, { type: 'FC_START_ANALYZE' });
  if (!response?.ok) {
    throw new Error(response?.error || response?.reason || 'Page check did not complete.');
  }
  setStatus('FanCheck overlay updated on this page.', 'success');
  await loadState();
}

async function reportThisSite() {
  setStatus('Reporting site...');
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
    throw new Error(response?.error || 'Could not report this site.');
  }
  const data = response.data || {};
  const triage = data.ai_recommendation ? ` AI triage: ${data.ai_recommendation}.` : '';
  setStatus(`${data.message || 'Thanks, we’ll review this site before enabling analysis.'}${triage}`, 'success');
  els.reportNote.value = '';
}

async function saveBackend() {
  const backendUrl = els.backendUrl.value.trim();
  const response = await sendBackground({ type: 'FC_SET_BACKEND_URL', backendUrl });
  if (!response?.ok) throw new Error(response?.error || 'Could not save backend URL.');
  setStatus('Backend URL saved.', 'success');
  await loadState();
}

async function savePreferences() {
  const preferredAlternativeTypes = Array.from(document.querySelectorAll('input[name="alternative"]:checked')).map((input) => input.value);
  const preferences = {
    region: els.region.value,
    preferredAlternativeTypes
  };
  const response = await sendBackground({ type: 'FC_SAVE_PREFERENCES', preferences });
  if (!response?.ok) throw new Error(response?.error || 'Could not save preferences.');
  setStatus('Preferences saved.', 'success');
  await loadState();
}

async function connectAccount(event) {
  event.preventDefault();
  const email = els.email.value.trim();
  const password = els.password.value;
  if (!email || !password) {
    throw new Error('Enter email and password.');
  }
  const response = await sendBackground({ type: 'FC_LOGIN', payload: { email, password } });
  if (!response?.ok) throw new Error(response?.error || 'Could not connect account.');
  els.password.value = '';
  setStatus('Connected to FanCheck.', 'success');
  await loadState();
}

async function disconnect() {
  const response = await sendBackground({ type: 'FC_LOGOUT' });
  if (!response?.ok) throw new Error(response?.error || 'Could not disconnect.');
  setStatus('Disconnected.', 'success');
  await loadState();
}

async function revokeGlobalConsent() {
  const response = await sendBackground({ type: 'FC_REVOKE_GLOBAL_CONSENT' });
  if (!response?.ok) throw new Error(response?.error || 'Could not revoke global consent.');
  setStatus('Global consent revoked.', 'success');
  await loadState();
}

async function revokeSiteConsent() {
  const host = currentTab ? tabHostname(currentTab) : '';
  if (!host) throw new Error('No current site to revoke.');
  const response = await sendBackground({ type: 'FC_REVOKE_SITE_CONSENT', hostname: host });
  if (!response?.ok) throw new Error(response?.error || 'Could not revoke site consent.');
  setStatus('Site consent revoked.', 'success');
  await loadState();
}

function wrap(handler) {
  return async (event) => {
    try {
      await handler(event);
    } catch (error) {
      setStatus(error.message || 'Something went wrong.', 'error');
    }
  };
}

els.checkPage.addEventListener('click', wrap(checkThisPage));
els.reportSite.addEventListener('click', wrap(reportThisSite));
els.saveBackend.addEventListener('click', wrap(saveBackend));
els.savePreferences.addEventListener('click', wrap(savePreferences));
els.loginForm.addEventListener('submit', wrap(connectAccount));
els.disconnect.addEventListener('click', wrap(disconnect));
els.revokeGlobal.addEventListener('click', wrap(revokeGlobalConsent));
els.revokeSite.addEventListener('click', wrap(revokeSiteConsent));
els.openFancheck.addEventListener('click', () => {
  const url = els.backendUrl.value.trim() || DEFAULT_BACKEND_URL;
  chrome.tabs.create({ url });
});
els.openDetail.addEventListener('click', wrap(async () => {
  const response = await sendBackground({ type: 'FC_GET_STATE' });
  const detailUrl = response?.data?.lastDetailUrl;
  if (!detailUrl) throw new Error('No source detail page yet.');
  chrome.tabs.create({ url: detailUrl });
}));

loadState().catch((error) => setStatus(error.message, 'error'));
