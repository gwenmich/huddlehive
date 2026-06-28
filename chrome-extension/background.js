const DEFAULT_BACKEND_URL = 'https://fancheck.onrender.com';

chrome.runtime.onInstalled.addListener(async () => {
  const data = await chrome.storage.local.get(['fancheck_backend_url']);
  if (!data.fancheck_backend_url) {
    await chrome.storage.local.set({ fancheck_backend_url: DEFAULT_BACKEND_URL });
  }
});

async function getBackendUrl() {
  const data = await chrome.storage.local.get(['fancheck_backend_url']);
  return (data.fancheck_backend_url || DEFAULT_BACKEND_URL).replace(/\/+$/, '');
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
  const data = await chrome.storage.local.get(['fancheck_preferences']);
  return fancheckFetch('/extension/analyze', {
    method: 'POST',
    body: JSON.stringify({
      ...payload,
      preferences: data.fancheck_preferences || {}
    })
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

async function getState() {
  const data = await chrome.storage.local.get([
    'fancheck_token',
    'fancheck_backend_url',
    'fancheck_privacy_consent',
    'fancheck_privacy_consent_domains',
    'fancheck_preferences',
    'fancheck_last_detail_url'
  ]);
  return {
    connected: Boolean(data.fancheck_token),
    backendUrl: data.fancheck_backend_url || DEFAULT_BACKEND_URL,
    globalConsent: data.fancheck_privacy_consent === true,
    domainConsent: data.fancheck_privacy_consent_domains || {},
    preferences: data.fancheck_preferences || {},
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
        const backendUrl = String(message.backendUrl || '').trim().replace(/\/+$/, '');
        if (!/^https?:\/\/.+/i.test(backendUrl)) {
          throw new Error('Backend URL must start with http:// or https://.');
        }
        await chrome.storage.local.set({ fancheck_backend_url: backendUrl });
        sendResponse({ ok: true, data: { backendUrl } });
        return;
      }
      if (message?.type === 'FC_SAVE_PREFERENCES') {
        await chrome.storage.local.set({ fancheck_preferences: message.preferences || {} });
        sendResponse({ ok: true });
        return;
      }
      if (message?.type === 'FC_REVOKE_GLOBAL_CONSENT') {
        await chrome.storage.local.remove(['fancheck_privacy_consent']);
        sendResponse({ ok: true });
        return;
      }
      if (message?.type === 'FC_REVOKE_SITE_CONSENT') {
        const data = await chrome.storage.local.get(['fancheck_privacy_consent_domains']);
        const domains = data.fancheck_privacy_consent_domains || {};
        delete domains[message.hostname];
        await chrome.storage.local.set({ fancheck_privacy_consent_domains: domains });
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
