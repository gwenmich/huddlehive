const DEFAULT_BACKEND_URL = 'https://fancheck.onrender.com';
const CONSENT_FLOW_VERSION = 2;

chrome.runtime.onInstalled.addListener(async () => {
  await chrome.storage.local.remove(['fancheck_backend_url']);
  await ensureConsentMigration();
});

async function getBackendUrl() {
  return DEFAULT_BACKEND_URL;
}

async function authHeaders() {
  const data = await chrome.storage.local.get(['fancheck_token']);
  return data.fancheck_token ? { Authorization: `Bearer ${data.fancheck_token}` } : {};
}

async function fancheckFetch(path, options = {}) {
  const backendUrl = await getBackendUrl();
  const headers = {
    'Content-Type': 'application/json',
    ...(await authHeaders()),
    ...(options.headers || {})
  };
  const response = await fetch(`${backendUrl}${path}`, { ...options, headers });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || data.message || `Request failed (${response.status})`);
  }
  return data;
}

async function analyzePage(payload) {
  return fancheckFetch('/extension/analyze', {
    method: 'POST',
    body: JSON.stringify(payload)
  });
}

async function reportSite(payload) {
  return fancheckFetch('/extension/site-reports', {
    method: 'POST',
    body: JSON.stringify(payload)
  });
}

async function login(payload) {
  const data = await fancheckFetch('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: payload.email, password: payload.password })
  });
  if (!data.token) {
    throw new Error('Login did not return a token.');
  }
  await chrome.storage.local.set({ fancheck_token: data.token });
  return { connected: true };
}

async function register(payload) {
  await fancheckFetch('/auth/register', {
    method: 'POST',
    body: JSON.stringify({ email: payload.email, password: payload.password })
  });
  return login(payload);
}

async function ensureConsentMigration(data = null) {
  const current = data || await chrome.storage.local.get([
    'fancheck_consent_flow_version',
    'fancheck_privacy_consent',
    'fancheck_privacy_consent_domains'
  ]);
  if (current.fancheck_consent_flow_version === CONSENT_FLOW_VERSION) {
    return current;
  }
  await chrome.storage.local.remove(['fancheck_privacy_consent', 'fancheck_privacy_consent_domains']);
  await chrome.storage.local.set({ fancheck_consent_flow_version: CONSENT_FLOW_VERSION });
  return { fancheck_consent_flow_version: CONSENT_FLOW_VERSION };
}

async function getState() {
  const data = await chrome.storage.local.get([
    'fancheck_token',
    'fancheck_consent_flow_version',
    'fancheck_privacy_consent',
    'fancheck_privacy_consent_domains',
    'fancheck_last_detail_url'
  ]);
  const migrated = await ensureConsentMigration(data);
  return {
    connected: Boolean(data.fancheck_token),
    backendUrl: DEFAULT_BACKEND_URL,
    globalConsent: migrated.fancheck_privacy_consent === true,
    domainConsent: migrated.fancheck_privacy_consent_domains || {},
    lastDetailUrl: data.fancheck_last_detail_url || null
  };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    try {
      if (message?.type === 'FC_ANALYZE_PAGE') {
        const data = await analyzePage(message.payload || {});
        if (data.detail_url) {
          await chrome.storage.local.set({ fancheck_last_detail_url: data.detail_url });
        }
        sendResponse({ ok: true, data });
        return;
      }
      if (message?.type === 'FC_REPORT_SITE') {
        const data = await reportSite(message.payload || {});
        sendResponse({ ok: true, data });
        return;
      }
      if (message?.type === 'FC_LOGIN') {
        const data = await login(message.payload || {});
        sendResponse({ ok: true, data });
        return;
      }
      if (message?.type === 'FC_REGISTER') {
        const data = await register(message.payload || {});
        sendResponse({ ok: true, data });
        return;
      }
      if (message?.type === 'FC_LOGOUT') {
        await chrome.storage.local.remove(['fancheck_token']);
        sendResponse({ ok: true });
        return;
      }
      if (message?.type === 'FC_GET_STATE') {
        sendResponse({ ok: true, data: await getState() });
        return;
      }
      if (message?.type === 'FC_SET_BACKEND_URL') {
        sendResponse({ ok: true, data: { backendUrl: DEFAULT_BACKEND_URL } });
        return;
      }
      if (message?.type === 'FC_REVOKE_GLOBAL_CONSENT') {
        await chrome.storage.local.remove(['fancheck_privacy_consent', 'fancheck_privacy_consent_domains']);
        await chrome.storage.local.set({ fancheck_consent_flow_version: CONSENT_FLOW_VERSION });
        sendResponse({ ok: true });
        return;
      }
      if (message?.type === 'FC_REVOKE_SITE_CONSENT') {
        const data = await chrome.storage.local.get(['fancheck_privacy_consent_domains']);
        const domains = data.fancheck_privacy_consent_domains || {};
        delete domains[message.hostname];
        await chrome.storage.local.set({
          fancheck_privacy_consent_domains: domains,
          fancheck_consent_flow_version: CONSENT_FLOW_VERSION
        });
        sendResponse({ ok: true });
        return;
      }
      sendResponse({ ok: false, error: 'Unknown FanCheck message.' });
    } catch (error) {
      sendResponse({ ok: false, error: error.message || 'FanCheck request failed.' });
    }
  })();
  return true;
});
