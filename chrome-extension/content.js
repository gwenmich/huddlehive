(() => {
  if (window.__fancheckContentLoaded) {
    return;
  }
  window.__fancheckContentLoaded = true;

  const OVERLAY_ID = 'fancheck-overlay';
  const CONSENT_ID = 'fancheck-consent-dialog';
  const MAX_TEXT_CHARS = 2000;
  const PREFLIGHT_TEXT_CHARS = 8000;
  const PREFLIGHT_VERSION = 1;
  const PREFLIGHT_PASS_SCORE = 60;
  const AUTO_SURFACE_COOLDOWN_MS = 30 * 60 * 1000;
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
  const musicMerchSignals = [
    'artist', 'band', 'musician', 'tour', 'concert', 'gig', 'venue',
    'album', 'vinyl', 'record', 'lp', 'cd', 'cassette', 'tracklist',
    'release', 'label', 'discography', 'festival', 'presale'
  ];
  const urlTransactionSignals = [
    'ticket', 'tickets', 'checkout', 'cart', 'basket', 'order', 'merch',
    'tour', 'event', 'resale'
  ];
  const negativeSignals = [
    'privacy', 'terms', 'help', 'support', 'faq', 'contact', 'account',
    'login', 'sign in', 'settings', 'news', 'blog', 'review'
  ];
  const hardNegativePaths = ['privacy', 'terms', 'help', 'support', 'faq'];
  const positivePreflightCategories = [
    'known_host', 'url_transaction', 'title_music', 'text_music',
    'text_transaction', 'price', 'music_merch'
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

  function addUnique(list, value) {
    const safe = text(value).replace(/[^a-z0-9_.:-]/gi, '_').slice(0, 80);
    if (safe && !list.includes(safe) && list.length < 20) list.push(safe);
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

  function bandForScore(score) {
    if (score >= 80) return 'HIGH';
    if (score >= 60) return 'MEDIUM';
    if (score >= 40) return 'LOW';
    return 'INSUFFICIENT';
  }

  function runPreflight({ pageUrl, bodyText, knownDomain, detectedPrices }) {
    const parsed = new URL(pageUrl || window.location.href);
    const path = lower(parsed.pathname || '/');
    const titleText = lower(document.title || '');
    const visibleText = lower(bodyText).slice(0, PREFLIGHT_TEXT_CHARS);
    const combined = `${path} ${titleText} ${visibleText}`;
    const categories = new Set();
    const signals = [];
    const reasons = [];
    let score = 0;

    if (knownDomain) {
      categories.add('known_host');
      addUnique(signals, 'known_host');
      score += 20;
    }
    if (includesAny(path, urlTransactionSignals)) {
      categories.add('url_transaction');
      addUnique(signals, 'url_transaction');
      score += 20;
    }
    if (includesAny(titleText, [...ticketSignals, ...musicMerchSignals])) {
      categories.add('title_music');
      addUnique(signals, 'title_music');
      score += 15;
    }
    if (includesAny(visibleText, ticketSignals) || includesAny(visibleText, musicMerchSignals)) {
      categories.add('text_music');
      addUnique(signals, 'text_music');
      score += 15;
    }
    if (includesAny(visibleText, checkoutSignals) || includesAny(visibleText, ['checkout', 'cart', 'basket', 'payment', 'order'])) {
      categories.add('text_transaction');
      addUnique(signals, 'text_transaction');
      score += 15;
    }
    if (detectedPrices.length > 0) {
      categories.add('price');
      addUnique(signals, 'price_detected');
      score += 20;
    }

    const merchCount = countMatches(combined, merchSignals);
    const musicMerchCount = countMatches(combined, musicMerchSignals);
    if (merchCount > 0 && musicMerchCount > 0) {
      categories.add('music_merch');
      addUnique(signals, 'music_merch');
      score += 15;
    } else if (merchCount > 0) {
      addUnique(reasons, 'generic_merch_without_music_context');
      score -= 10;
    }

    if (includesAny(path, hardNegativePaths)) {
      categories.add('negative_path');
      addUnique(signals, 'negative_path');
      score -= 80;
    } else if (includesAny(combined, negativeSignals)) {
      addUnique(reasons, 'negative_context');
      score -= 10;
    }

    const hasPurchaseSignal = categories.has('url_transaction') || categories.has('text_transaction');
    const hasMusicSignal = categories.has('title_music') || categories.has('text_music') || categories.has('music_merch');
    if (knownDomain && categories.has('price') && hasPurchaseSignal) {
      addUnique(signals, 'known_host_purchase_evidence');
      score += 15;
    } else if (knownDomain && categories.has('price') && hasMusicSignal) {
      addUnique(signals, 'known_host_music_purchase_evidence');
      score += 10;
    }

    const positiveCategories = [...categories].filter((category) => positivePreflightCategories.includes(category));
    const categoryCount = positiveCategories.length;
    score = Math.max(0, Math.min(100, score));
    const band = bandForScore(score);
    const knownHostReady = Boolean(
      knownDomain
      && categories.has('price')
      && (hasPurchaseSignal || hasMusicSignal)
      && score >= PREFLIGHT_PASS_SCORE
    );
    const unknownHostReady = Boolean(
      !knownDomain
      && categories.has('price')
      && hasPurchaseSignal
      && hasMusicSignal
      && score >= PREFLIGHT_PASS_SCORE
    );
    const shouldAnalyze = ['HIGH', 'MEDIUM'].includes(band) && categoryCount >= 2 && (knownHostReady || unknownHostReady);
    if (!shouldAnalyze) addUnique(reasons, 'preflight_failed');
    if (!knownDomain && categories.has('music_merch') && !(categories.has('price') && (categories.has('url_transaction') || categories.has('text_transaction')))) {
      addUnique(reasons, 'unknown_merch_missing_transaction_signal');
      return {
        version: PREFLIGHT_VERSION,
        score: Math.min(score, 59),
        band: bandForScore(Math.min(score, 59)),
        reasons,
        matchedSignals: signals,
        matchedSignalCategories: [...categories],
        shouldAnalyze: false
      };
    }

    return {
      version: PREFLIGHT_VERSION,
      score,
      band,
      reasons,
      matchedSignals: signals,
      matchedSignalCategories: [...categories],
      shouldAnalyze
    };
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
    const preflight = runPreflight({ pageUrl, bodyText, knownDomain, detectedPrices });
    const purchaseTypeHint = merchWords > ticketWords ? 'merch' : ticketWords > 0 ? 'ticket' : 'unknown';
    const likelyPurchase = preflight.shouldAnalyze;
    const isSecondaryMarket = resaleHosts.some((domain) => hostname() === domain || hostname().endsWith(`.${domain}`));

    return {
      title: document.title || null,
      url: pageUrl,
      hostname: hostname(),
      knownDomain,
      likelyPurchase,
      preflight,
      purchaseTypeHint,
      isSecondaryMarket,
      detectedPrices,
      localSignals: {
        ticketWords,
        merchWords,
        checkoutWords,
        priceCandidates: detectedPrices.length,
        preflightBand: preflight.band,
        preflightScore: preflight.score,
        preflightCategories: preflight.matchedSignalCategories
      },
      clientSignals: {
        knownDomain,
        pageTypeHint: checkoutWords > 0 ? 'checkout' : 'unknown',
        purchaseTypeHint,
        preflightBand: preflight.band,
        preflightCategories: preflight.matchedSignalCategories,
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

  async function consentState(host) {
    const data = await ensureConsentMigration(await storageGet([
      'fancheck_consent_flow_version',
      'fancheck_privacy_consent',
      'fancheck_privacy_consent_domains'
    ]));
    if (data.fancheck_privacy_consent === true) return { confirmed: true, scope: 'global', hostname: host };
    const domains = data.fancheck_privacy_consent_domains || {};
    if (domains[host] === true) return { confirmed: true, scope: 'site', hostname: host };
    return { confirmed: false, scope: null, hostname: host };
  }

  async function hasConsent(host) {
    return (await consentState(host)).confirmed;
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
      copy.textContent = 'FanCheck checks pages locally in your browser. If you click Analyse this purchase, FanCheck may send a redacted snippet to the backend and may use Anthropic. You can change permission later.';

      const actions = document.createElement('div');
      actions.className = 'fancheck-consent-actions';
      const buttons = [
        ['Allow FanCheck', async () => {
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
    if (!scan.preflight?.shouldAnalyze) {
      renderOverlay({ mode: 'error', scan, message: 'FanCheck could not analyse this page yet.' });
      return { ok: false, reason: 'preflight_failed', preflight: scan.preflight };
    }
    const shouldRequestConsent = options.requestConsent !== false;
    const allowed = shouldRequestConsent ? await requestConsent(scan.hostname) : true;
    const consent = await consentState(scan.hostname);
    if (!allowed || !consent.confirmed) {
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
          preflight: scan.preflight,
          consent,
          trigger: 'user_click',
          source
        }
      });
      if (!response?.ok) throw new Error(response?.error || 'Source check failed.');
      renderOverlay({ mode: 'analysis', scan, analysis: response.data });
      return { ok: true, data: response.data };
    } catch (error) {
      renderOverlay({ mode: 'error', scan, message: 'FanCheck could not analyse this page yet.' });
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
    footer.textContent = 'Analysis only runs when you choose it.';
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
  const autoSurfaceTimes = new Map();
  async function maybeAutoDetect() {
    const scan = scanPage();
    const consent = await consentState(scan.hostname);
    const signature = `${scan.url}|${scan.preflight?.band}|${scan.preflight?.score}|${scan.detectedPrices.length}|${consent.confirmed}`;
    if (signature === lastScanSignature) return;
    lastScanSignature = signature;
    const now = Date.now();
    const lastSurface = autoSurfaceTimes.get(signature) || 0;
    const cooledDown = now - lastSurface > AUTO_SURFACE_COOLDOWN_MS;
    if (scan.preflight?.shouldAnalyze && consent.confirmed && cooledDown && !document.getElementById(OVERLAY_ID)) {
      autoSurfaceTimes.set(signature, now);
      renderOverlay({ mode: 'local', scan });
    }
  }

  function debounce(fn, delay) {
    let timer;
    return () => {
      clearTimeout(timer);
      timer = setTimeout(() => Promise.resolve(fn()).catch(() => {}), delay);
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

  window.FanCheckContent = { scanPage, renderOverlay, analyzeCurrentPage, runPreflight };

  if (detectKnownDomain()) {
    maybeAutoDetect().catch(() => {});
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== 'local') return;
      if (changes.fancheck_privacy_consent || changes.fancheck_privacy_consent_domains) {
        maybeAutoDetect().catch(() => {});
      }
    });
    new MutationObserver(debounce(maybeAutoDetect, 700)).observe(document.documentElement, { childList: true, subtree: true });
    watchUrlChanges();
  }
})();
