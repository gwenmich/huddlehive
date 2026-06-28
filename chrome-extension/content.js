(() => {
  if (window.__fancheckContentLoaded) {
    return;
  }
  window.__fancheckContentLoaded = true;

  const OVERLAY_ID = 'fancheck-overlay';
  const CONSENT_ID = 'fancheck-consent-dialog';
  const MAX_TEXT_CHARS = 2000;
  const CONSENT_FLOW_VERSION = 2;

  const checkoutSignals = [
    'checkout', 'basket', 'cart', 'order total', 'payment', 'delivery',
    'billing', 'service fee', 'booking fee', 'facility fee', 'processing fee',
    'due today', 'place order', 'buy now', 'total'
  ];
  const ticketSignals = [
    'ticket', 'tickets', 'gig', 'concert', 'tour', 'venue', 'artist',
    'show date', 'admission', 'standing', 'seated'
  ];
  const merchSignals = [
    'merch', 'merchandise', 'vinyl', 'record', 'lp', 'cd', 'cassette',
    't-shirt', 'tee', 'hoodie', 'album', 'shipping', 'size', 'variant'
  ];
  const resaleHosts = ['viagogo.com', 'stubhub.com'];

  function text(value) {
    return String(value == null ? '' : value);
  }

  function lower(value) {
    return text(value).toLowerCase();
  }

  function hostname() {
    return window.location.hostname.replace(/^www\./, '').toLowerCase();
  }

  function safePageUrl(url) {
    try {
      const parsed = new URL(url);
      return `${parsed.protocol}//${parsed.host}${parsed.pathname || '/'}`;
    } catch {
      return '';
    }
  }

  function includesAny(haystack, needles) {
    return needles.some((needle) => haystack.includes(needle));
  }

  function countMatches(haystack, needles) {
    return needles.reduce((count, needle) => count + (haystack.includes(needle) ? 1 : 0), 0);
  }

  function detectKnownDomain() {
    const host = hostname();
    const domains = [
      'ticketmaster.com', 'ticketmaster.co.uk', 'axs.com', 'seetickets.com',
      'viagogo.com', 'stubhub.com', 'dice.fm', 'eventim.co.uk', 'skiddle.com',
      'wegottickets.com', 'bandcamp.com'
    ];
    return domains.find((domain) => host === domain || host.endsWith(`.${domain}`)) || null;
  }

  function detectPrices(root = document) {
    const selectors = [
      '[class*="price" i]', '[class*="total" i]', '[class*="amount" i]',
      '[class*="cost" i]', '[class*="fee" i]', '[class*="subtotal" i]',
      '[aria-label*="price" i]', '[aria-label*="total" i]',
      'span', 'div', 'p', 'strong', 'td'
    ];
    const regex = /(?:([£$€])\s?(\d{1,3}(?:,\d{3})*|\d+)(?:[.,](\d{2}))?)|(?:(\d{1,3}(?:,\d{3})*|\d+)(?:[.,](\d{2}))?\s?(GBP|USD|EUR))/gi;
    const seen = new Set();
    const candidates = [];
    const elements = Array.from(root.querySelectorAll(selectors.join(','))).slice(0, 600);

    for (const element of elements) {
      const content = text(element.innerText || element.textContent).replace(/\s+/g, ' ').trim();
      if (!content || content.length > 240) continue;

      let match;
      regex.lastIndex = 0;
      while ((match = regex.exec(content)) !== null) {
        const symbol = match[1];
        const numberPart = match[2] || match[4];
        const decimals = match[3] || match[5] || '00';
        const code = match[6];
        if (!numberPart) continue;

        const currency = symbol === '£' ? 'GBP' : symbol === '$' ? 'USD' : symbol === '€' ? 'EUR' : code;
        const amount = Number(`${numberPart.replace(/,/g, '')}.${decimals}`);
        if (!Number.isFinite(amount)) continue;

        const label = nearbyLabel(element, content);
        const key = `${amount}:${currency}:${label}`;
        if (seen.has(key)) continue;
        seen.add(key);
        candidates.push({ amount, currency, label, nearbyText: content.slice(0, 160) });
      }
    }

    return candidates
      .sort((a, b) => scorePriceCandidate(b) - scorePriceCandidate(a))
      .slice(0, 20);
  }

  function nearbyLabel(element, fallback) {
    const aria = element.getAttribute('aria-label');
    if (aria) return aria.slice(0, 80);
    const previous = element.previousElementSibling;
    if (previous) {
      const label = text(previous.innerText || previous.textContent).replace(/\s+/g, ' ').trim();
      if (label && label.length < 80) return label;
    }
    const words = fallback.split(/\s+/).slice(0, 8).join(' ');
    return words || 'Price';
  }

  function scorePriceCandidate(candidate) {
    const context = lower(`${candidate.label} ${candidate.nearbyText}`);
    let score = 0;
    if (context.includes('order total')) score += 12;
    if (context.includes('total')) score += 8;
    if (context.includes('due today')) score += 8;
    if (context.includes('subtotal')) score += 4;
    if (context.includes('fee')) score += 2;
    return score;
  }

  function scanPage() {
    const bodyText = text(document.body?.innerText || '');
    const pageUrl = safePageUrl(window.location.href);
    const pageText = lower(`${pageUrl} ${document.title} ${bodyText.slice(0, 8000)}`);
    const knownDomain = detectKnownDomain();
    const ticketWords = countMatches(pageText, ticketSignals);
    const merchWords = countMatches(pageText, merchSignals);
    const checkoutWords = countMatches(pageText, checkoutSignals);
    const detectedPrices = detectPrices();
    const purchaseTypeHint = merchWords > ticketWords ? 'merch' : ticketWords > 0 ? 'ticket' : 'unknown';
    const likelyPurchase = checkoutWords > 0 && (ticketWords > 0 || merchWords > 0 || detectedPrices.length > 0);
    const isSecondaryMarket = resaleHosts.some((domain) => hostname() === domain || hostname().endsWith(`.${domain}`));

    return {
      title: document.title || null,
      url: pageUrl,
      hostname: hostname(),
      knownDomain,
      likelyPurchase,
      purchaseTypeHint,
      isSecondaryMarket,
      detectedPrices,
      localSignals: {
        ticketWords,
        merchWords,
        checkoutWords,
        priceCandidates: detectedPrices.length
      },
      clientSignals: {
        knownDomain,
        pageTypeHint: checkoutWords > 0 ? 'checkout' : 'unknown',
        purchaseTypeHint,
        musicKeywords: [...ticketSignals, ...merchSignals].filter((word) => pageText.includes(word)).slice(0, 12)
      }
    };
  }

  function redactPageText() {
    let value = text(document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 10000);
    const replacements = [
      [/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[REDACTED_EMAIL]'],
      [/\+?\d[\d\s().-]{8,}\d/g, '[REDACTED_NUMBER]'],
      [/\b(?:\d[ -]*?){13,19}\b/g, '[REDACTED_CARD]'],
      [/\b(order|booking|confirmation|reference|account)\s*(id|number|no\.?|#)?\s*[:#-]?\s*[A-Z0-9-]{5,}\b/gi, '[REDACTED_ORDER]'],
      [/\b(section|seat|row)\s*[:#-]?\s*[A-Z0-9-]{1,12}\b/gi, '[REDACTED_SEAT]'],
      [/\b(card|cvv|cvc|expiry|password|account)\b[^.]{0,80}/gi, '[REDACTED_ACCOUNT_FIELD]']
    ];
    for (const [regex, replacement] of replacements) {
      value = value.replace(regex, replacement);
    }
    return value.slice(0, MAX_TEXT_CHARS);
  }

  async function storageGet(keys) {
    return chrome.storage.local.get(keys);
  }

  async function storageSet(values) {
    return chrome.storage.local.set(values);
  }

  async function storageRemove(keys) {
    return chrome.storage.local.remove(keys);
  }

  async function ensureConsentMigration(data = null) {
    const current = data || await storageGet([
      'fancheck_consent_flow_version',
      'fancheck_privacy_consent',
      'fancheck_privacy_consent_domains'
    ]);
    if (current.fancheck_consent_flow_version === CONSENT_FLOW_VERSION) {
      return current;
    }
    await storageRemove(['fancheck_privacy_consent', 'fancheck_privacy_consent_domains']);
    await storageSet({ fancheck_consent_flow_version: CONSENT_FLOW_VERSION });
    return { fancheck_consent_flow_version: CONSENT_FLOW_VERSION };
  }

  async function hasConsent(host) {
    const data = await ensureConsentMigration(await storageGet([
      'fancheck_consent_flow_version',
      'fancheck_privacy_consent',
      'fancheck_privacy_consent_domains'
    ]));
    if (data.fancheck_privacy_consent === true) return true;
    const domains = data.fancheck_privacy_consent_domains || {};
    return domains[host] === true;
  }

  async function requestConsent(host) {
    if (await hasConsent(host)) return true;

    return new Promise((resolve) => {
      document.getElementById(CONSENT_ID)?.remove();
      const dialog = document.createElement('div');
      dialog.id = CONSENT_ID;
      dialog.setAttribute('role', 'dialog');
      dialog.setAttribute('aria-modal', 'true');
      dialog.setAttribute('aria-label', 'FanCheck source check consent');

      const panel = document.createElement('div');
      panel.className = 'fancheck-consent-panel';

      const title = document.createElement('h2');
      title.textContent = 'Analyse this purchase?';
      const copy = document.createElement('p');
      copy.textContent = 'FanCheck can analyse this purchase against current public sources by sending a short redacted text snippet to your FanCheck backend. Redaction is best-effort and may not remove every personal detail. The backend may send the redacted snippet and minimized search context to Anthropic, a third-party AI provider, for analysis.';

      const actions = document.createElement('div');
      actions.className = 'fancheck-consent-actions';
      const buttons = [
        ['Allow for all sites', async () => {
          await storageSet({
            fancheck_privacy_consent: true,
            fancheck_consent_flow_version: CONSENT_FLOW_VERSION
          });
          return true;
        }],
        ['Allow for this site', async () => {
          const data = await storageGet(['fancheck_privacy_consent_domains']);
          const domains = data.fancheck_privacy_consent_domains || {};
          domains[host] = true;
          await storageSet({
            fancheck_privacy_consent_domains: domains,
            fancheck_consent_flow_version: CONSENT_FLOW_VERSION
          });
          return true;
        }],
        ['Not now', async () => false]
      ];

      for (const [label, handler] of buttons) {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = label;
        button.className = label === 'Not now' ? 'fancheck-btn fancheck-btn-secondary' : 'fancheck-btn fancheck-btn-primary';
        button.addEventListener('click', async () => {
          const allowed = await handler();
          dialog.remove();
          resolve(allowed);
        });
        actions.append(button);
      }

      panel.append(title, copy, actions);
      dialog.append(panel);
      document.documentElement.append(dialog);
      panel.querySelector('button')?.focus();
    });
  }

  function sendMessage(message) {
    return chrome.runtime.sendMessage(message);
  }

  async function analyzeCurrentPage(source = 'overlay', options = {}) {
    const scan = scanPage();
    const shouldRequestConsent = options.requestConsent !== false;
    const allowed = shouldRequestConsent ? await requestConsent(scan.hostname) : true;
    if (!allowed) {
      renderOverlay({ mode: 'local', scan, message: 'No page text was sent.' });
      return { ok: false, reason: 'consent_declined' };
    }

    renderOverlay({ mode: 'loading', scan, message: 'Checking current public sources...' });
    try {
      const response = await sendMessage({
        type: 'FC_ANALYZE_PAGE',
        payload: {
          title: scan.title,
          url: scan.url,
          redactedText: redactPageText(),
          detectedPrices: scan.detectedPrices,
          clientSignals: scan.clientSignals,
          source
        }
      });
      if (!response?.ok) throw new Error(response?.error || 'Source check failed.');
      renderOverlay({ mode: 'analysis', scan, analysis: response.data });
      return { ok: true, data: response.data };
    } catch (error) {
      renderOverlay({ mode: 'error', scan, message: 'Source check unavailable. Please try again later.' });
      return { ok: false, error: error.message };
    }
  }

  function renderOverlay(state) {
    document.getElementById(OVERLAY_ID)?.remove();
    const scan = state.scan || scanPage();
    const overlay = document.createElement('aside');
    overlay.id = OVERLAY_ID;
    overlay.setAttribute('role', 'complementary');
    overlay.setAttribute('aria-label', 'FanCheck music purchase transparency');
    overlay.className = 'fancheck-overlay';

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'fancheck-close';
    close.setAttribute('aria-label', 'Close FanCheck');
    close.textContent = '×';
    close.addEventListener('click', () => overlay.remove());

    const header = document.createElement('div');
    header.className = 'fancheck-header';
    const mark = document.createElement('img');
    mark.className = 'fancheck-logo';
    mark.src = chrome.runtime.getURL('icons/fancheck-logo.svg');
    mark.alt = '';
    mark.setAttribute('aria-hidden', 'true');
    const title = document.createElement('div');
    const titleName = document.createElement('strong');
    titleName.textContent = 'FanCheck';
    const titleSub = document.createElement('span');
    titleSub.textContent = 'Music purchase transparency';
    title.append(titleName, titleSub);
    header.append(mark, title);

    const body = document.createElement('div');
    body.className = 'fancheck-body';
    if (state.mode === 'analysis') {
      renderAnalysisBody(body, state.analysis, scan);
    } else {
      renderLocalBody(body, state, scan);
    }

    overlay.append(close, header, body);
    document.documentElement.append(overlay);
    avoidCheckoutOverlap(overlay);
    document.addEventListener('keydown', handleEscape, { once: true });
  }

  function renderLocalBody(body, state, scan) {
    const heading = document.createElement('h2');
    heading.textContent = state.mode === 'loading' ? 'Checking current public sources...' : 'Likely music purchase detected';
    const meta = document.createElement('p');
    meta.className = 'fancheck-muted';
    const price = scan.detectedPrices?.[0];
    meta.textContent = [
      scan.purchaseTypeHint && scan.purchaseTypeHint !== 'unknown' ? `Type: ${scan.purchaseTypeHint}` : null,
      price ? `Detected total: ${formatMoney(price.amount, price.currency)}` : null
    ].filter(Boolean).join(' · ') || 'FanCheck can check this page with current public sources.';
    body.append(heading, meta);

    if (scan.isSecondaryMarket) {
      body.append(warningBox('Secondary marketplaces may carry higher prices, additional fees, transfer restrictions, or event-entry risk. Check official sources first.'));
    }

    if (state.message) {
      const message = document.createElement('p');
      message.className = 'fancheck-muted';
      message.textContent = state.message;
      body.append(message);
    }

    if (state.mode !== 'loading') {
      const actions = document.createElement('div');
      actions.className = 'fancheck-actions';
      const check = document.createElement('button');
      check.type = 'button';
      check.className = 'fancheck-btn fancheck-btn-primary';
      check.textContent = 'Analyse this purchase';
      check.addEventListener('click', () => analyzeCurrentPage('overlay'));
      actions.append(check);
      body.append(actions);
    }

    const footer = document.createElement('p');
    footer.className = 'fancheck-footer';
    footer.textContent = 'We’ll ask before sending a redacted snippet.';
    body.append(footer);
  }

  function renderAnalysisBody(body, analysis, scan) {
    const result = analysis?.result || {};
    const summary = result.summary || {};
    const estimate = result.estimate || {};

    const heading = document.createElement('h2');
    heading.textContent = summary.purchase_type ? `Purchase type: ${summary.purchase_type}` : 'Source check complete';
    body.append(heading);

    const rows = document.createElement('div');
    rows.className = 'fancheck-rows';
    addRow(rows, 'Detected total', summary.detected_total?.formatted || (scan.detectedPrices?.[0] ? formatMoney(scan.detectedPrices[0].amount, scan.detectedPrices[0].currency) : 'Not detected'));
    addRow(rows, 'Source status', analysis.source_check_status || summary.source_check_status || 'unknown');
    if (analysis.cache_status && analysis.cache_status !== 'none') addRow(rows, 'Cache status', analysis.cache_status);
    body.append(rows);

    const pill = document.createElement('span');
    pill.className = `fancheck-pill fancheck-pill-${estimate.confidence || 'low'}`;
    pill.textContent = estimate.available ? `${estimate.confidence || 'low'} confidence` : 'No verified estimate';
    body.append(pill);

    const explanation = document.createElement('p');
    explanation.className = 'fancheck-muted';
    explanation.textContent = estimate.explanation || 'FanCheck did not find enough source-backed support for a numerical estimate.';
    body.append(explanation);

    for (const warning of result.warnings || []) {
      body.append(warningBox(warning.message));
    }
    if (scan.isSecondaryMarket && !(result.warnings || []).some((warning) => warning.type === 'resale')) {
      body.append(warningBox('Secondary marketplaces may carry higher prices, additional fees, transfer restrictions, or event-entry risk. Check official sources first.'));
    }

    if (Array.isArray(result.alternatives) && result.alternatives.length) {
      const list = document.createElement('div');
      list.className = 'fancheck-alternatives';
      const label = document.createElement('h3');
      label.textContent = 'Fairer alternatives';
      list.append(label);
      for (const alternative of result.alternatives.slice(0, 3)) {
        const item = document.createElement(alternative.url ? 'a' : 'div');
        item.className = 'fancheck-alt';
        if (alternative.url) {
          item.href = alternative.url;
          item.target = '_blank';
          item.rel = 'noopener';
        }
        const name = document.createElement('strong');
        name.textContent = alternative.name || 'Alternative';
        const note = document.createElement('span');
        note.textContent = alternative.note || '';
        item.append(name, note);
        list.append(item);
      }
      body.append(list);
    }

    if (analysis.detail_url) {
      const link = document.createElement('button');
      link.type = 'button';
      link.className = 'fancheck-btn fancheck-btn-primary fancheck-full';
      link.textContent = 'View sources and details';
      link.addEventListener('click', () => window.open(analysis.detail_url, '_blank', 'noopener'));
      body.append(link);
    }

    const footer = document.createElement('p');
    footer.className = 'fancheck-footer';
    footer.textContent = 'Estimates may vary by event, venue, delivery method, region, and seller. Not financial advice.';
    body.append(footer);
  }

  function addRow(container, label, value) {
    const row = document.createElement('div');
    row.className = 'fancheck-row';
    const left = document.createElement('span');
    left.textContent = label;
    const right = document.createElement('strong');
    right.textContent = value || 'Unknown';
    row.append(left, right);
    container.append(row);
  }

  function warningBox(message) {
    const box = document.createElement('div');
    box.className = 'fancheck-warning';
    box.textContent = message;
    return box;
  }

  function formatMoney(amount, currency) {
    if (!Number.isFinite(Number(amount))) return 'Not detected';
    try {
      return new Intl.NumberFormat(undefined, { style: 'currency', currency: currency || 'GBP' }).format(Number(amount));
    } catch {
      return `${Number(amount).toFixed(2)} ${currency || ''}`.trim();
    }
  }

  function avoidCheckoutOverlap(overlay) {
    const buttons = Array.from(document.querySelectorAll('button, [role="button"], input[type="submit"], a')).slice(-80);
    const checkoutButton = buttons.find((button) => /(checkout|pay|place order|buy now|continue|payment)/i.test(text(button.innerText || button.value || button.getAttribute('aria-label'))));
    if (!checkoutButton) return;
    const overlayRect = overlay.getBoundingClientRect();
    const buttonRect = checkoutButton.getBoundingClientRect();
    const overlap = !(overlayRect.right < buttonRect.left || overlayRect.left > buttonRect.right || overlayRect.bottom < buttonRect.top || overlayRect.top > buttonRect.bottom);
    if (overlap) overlay.classList.add('fancheck-compact');
  }

  function handleEscape(event) {
    if (event.key === 'Escape') {
      document.getElementById(OVERLAY_ID)?.remove();
      document.getElementById(CONSENT_ID)?.remove();
    } else {
      document.addEventListener('keydown', handleEscape, { once: true });
    }
  }

  let lastScanSignature = '';
  function maybeAutoDetect() {
    const scan = scanPage();
    const signature = `${scan.url}|${scan.likelyPurchase}|${scan.detectedPrices.length}`;
    if (signature === lastScanSignature) return;
    lastScanSignature = signature;
    if (scan.knownDomain && scan.likelyPurchase && !document.getElementById(OVERLAY_ID)) {
      renderOverlay({ mode: 'local', scan });
    }
  }

  function debounce(fn, delay) {
    let timer;
    return () => {
      clearTimeout(timer);
      timer = setTimeout(fn, delay);
    };
  }

  function watchUrlChanges() {
    for (const method of ['pushState', 'replaceState']) {
      const original = history[method];
      history[method] = function patchedHistoryMethod(...args) {
        const value = original.apply(this, args);
        window.dispatchEvent(new Event('fancheck:urlchange'));
        return value;
      };
    }
    window.addEventListener('popstate', () => window.dispatchEvent(new Event('fancheck:urlchange')));
    window.addEventListener('fancheck:urlchange', debounce(maybeAutoDetect, 500));
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'FC_PING') {
      sendResponse({ ok: true });
      return false;
    }
    if (message?.type === 'FC_SCAN_PAGE') {
      sendResponse({ ok: true, scan: scanPage() });
      return false;
    }
    if (message?.type === 'FC_START_ANALYZE') {
      analyzeCurrentPage('popup').then(sendResponse);
      return true;
    }
    if (message?.type === 'FC_START_ANALYZE_CONFIRMED') {
      analyzeCurrentPage('popup', { requestConsent: false }).then(sendResponse);
      return true;
    }
    if (message?.type === 'FC_RENDER_ANALYSIS') {
      renderOverlay({ mode: 'analysis', scan: scanPage(), analysis: message.analysis });
      sendResponse({ ok: true });
      return false;
    }
    return false;
  });

  window.FanCheckContent = { scanPage, renderOverlay, analyzeCurrentPage };

  if (detectKnownDomain()) {
    maybeAutoDetect();
    new MutationObserver(debounce(maybeAutoDetect, 700)).observe(document.documentElement, { childList: true, subtree: true });
    watchUrlChanges();
  }
})();
