/**
 * dashboard.js — FanCheck report page
 * Fetches /report and renders all sections.
 */

import { getReport, connectSpotify, clearToken, isLoggedIn } from './api.js';

if (!isLoggedIn()) {
  clearToken();
  window.location.replace('../pages/auth.html?reason=session_expired');
}

const spotifyGate     = document.getElementById('spotify-gate');
const loadingState    = document.getElementById('loading-state');
const errorState      = document.getElementById('error-state');
const connectError    = document.getElementById('connect-error');
const connectErrorMsg = document.getElementById('connect-error-message');
const errorMsg        = document.getElementById('error-message');
const report          = document.getElementById('report');

const navEmail  = document.getElementById('nav-email');
const btnLogout = document.getElementById('btn-logout');

const statSubscription = document.getElementById('stat-subscription');
const statToArtists    = document.getElementById('stat-to-artists');
const statPercentage   = document.getElementById('stat-percentage');
const statTracks       = document.getElementById('stat-tracks');
const summaryPlan      = document.getElementById('summary-plan');

const artistsList = document.getElementById('artists-list');

const rateSpotify  = document.getElementById('rate-spotify');
const rateApple    = document.getElementById('rate-apple');
const rateTidal    = document.getElementById('rate-tidal');
const rateBandcamp = document.getElementById('rate-bandcamp');
const compareNote  = document.getElementById('compare-note');

function showOnly(el) {
  [spotifyGate, loadingState, errorState, connectError, report].forEach(section => {
    if (!section) return;
    if (section === el) section.removeAttribute('hidden');
    else section.setAttribute('hidden', '');
  });
}

btnLogout?.addEventListener('click', () => {
  clearToken();
  window.location.href = '../pages/auth.html';
});

document.getElementById('btn-spotify')?.addEventListener('click', connectSpotify);
document.getElementById('btn-spotify-retry')?.addEventListener('click', connectSpotify);
document.getElementById('btn-retry')?.addEventListener('click', loadReport);

const FALLBACK_IMG = `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='56' height='56' viewBox='0 0 56 56'%3E%3Crect width='56' height='56' fill='%231A1A1E'/%3E%3Ccircle cx='28' cy='22' r='9' fill='%232A2A32'/%3E%3Cellipse cx='28' cy='42' rx='14' ry='9' fill='%232A2A32'/%3E%3C/svg%3E`;

function formatNumber(n = 0) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(0) + 'K';
  return String(n);
}

function renderArtist(artist, index) {
  const li = document.createElement('li');
  li.className = 'artist-card';

  const imgSrc = artist.image || FALLBACK_IMG;

  let altLinks = '';
  const alternatives = artist.ethical_alternatives || {};

  if (alternatives.bandcamp) {
    altLinks += `<a href="${alternatives.bandcamp}" class="alt-link alt-bandcamp" target="_blank" rel="noopener">Bandcamp</a>`;
  }

  if (alternatives.official_site) {
    altLinks += `<a href="${alternatives.official_site}" class="alt-link alt-site" target="_blank" rel="noopener">Official site</a>`;
  }

  const altSection = altLinks
    ? `<footer class="artist-alts"><span class="artist-alts-label">Support them better:</span>${altLinks}</footer>`
    : '';

  li.innerHTML = `
    <span class="artist-rank" aria-hidden="true">${String(index + 1).padStart(2, '0')}</span>

    <img
      class="artist-img"
      src="${imgSrc}"
      alt="${artist.name || 'Artist'}"
      width="56"
      height="56"
      onerror="this.src='${FALLBACK_IMG}'"
    >

    <div class="artist-info">
      <a class="artist-name" href="${artist.spotify_url || '#'}" target="_blank" rel="noopener">
        ${artist.name || 'Unknown artist'}
      </a>

      <div class="artist-meta">
        <span class="artist-streams">${formatNumber(artist.estimated_streams_from_you || 0)} streams from you</span>
        <span class="artist-dot" aria-hidden="true">·</span>
        <span class="artist-popularity">Popularity ${artist.popularity_score ?? 0}/100</span>
      </div>
    </div>

    <output class="artist-earnings">
      <strong class="earnings-value">£${Number(artist.estimated_earnings_from_you_gbp || 0).toFixed(2)}</strong>
      <span class="earnings-label">earned from you</span>
    </output>

    ${altSection}
  `;

  return li;
}

function isSpotifyConnectionProblem(status, data = {}) {
  const action = String(data.action || '').toLowerCase();
  const error = String(data.error || '').toLowerCase();
  const message = String(data.message || '').toLowerCase();

  return (
    status === 400 ||
    action.includes('connect_spotify') ||
    action.includes('reconnect_spotify') ||
    error.includes('spotify') ||
    message.includes('spotify') ||
    message.includes('not connected') ||
    message.includes('no token')
  );
}

async function loadReport() {
  const params = new URLSearchParams(window.location.search);

  if (params.get('spotify') === 'failed') {
    const description = params.get('spotify_error_description');
    const errorKey = params.get('spotify_error');

    if (connectErrorMsg) {
      connectErrorMsg.textContent =
        description || `Spotify connection failed: ${errorKey || 'unknown error'}`;
    }

    showOnly(connectError);
    history.replaceState({}, '', window.location.pathname);
    return;
  }

  if (params.get('spotify') === 'connected') {
    history.replaceState({}, '', window.location.pathname);
  }

  showOnly(loadingState);

  let response;

  try {
    response = await getReport();
  } catch (err) {
    if (errorMsg) {
      errorMsg.textContent = 'Could not load your report. Please try again.';
    }

    showOnly(errorState);
    return;
  }

  const { ok, status, data } = response;

  if (!ok) {
    if (isSpotifyConnectionProblem(status, data)) {
      showOnly(spotifyGate);
      return;
    }

    if (status === 401) {
      clearToken();
      window.location.href = '../pages/auth.html?reason=session_expired';
      return;
    }

    if (errorMsg) {
      errorMsg.textContent =
        data?.message || data?.error || `Something went wrong (${status}). Please try again.`;
    }

    showOnly(errorState);
    return;
  }

  if (navEmail) navEmail.textContent = data.user?.email || '';

  const s = data.summary || {};

  if (statSubscription) {
    statSubscription.textContent = `£${Number(s.yearly_spotify_subscription_gbp || 0).toFixed(2)}`;
  }

  if (statToArtists) {
    statToArtists.textContent = `£${Number(s.total_estimated_paid_to_artists_gbp || 0).toFixed(2)}`;
  }

  if (statPercentage) {
    statPercentage.textContent = s.percentage_reaching_artists || '0%';
  }

  if (statTracks) {
    statTracks.textContent = s.top_tracks_count || 0;
  }

  const plan = data.user?.spotify_plan || '';

  if (summaryPlan) {
    summaryPlan.textContent = plan
      ? `Spotify ${plan.charAt(0).toUpperCase() + plan.slice(1)} account · ${data.user?.spotify_display_name || ''}`
      : data.user?.spotify_display_name || '';
  }

  if (artistsList) {
    artistsList.innerHTML = '';

    if (Array.isArray(data.top_artists) && data.top_artists.length > 0) {
      data.top_artists.forEach((artist, i) => {
        artistsList.appendChild(renderArtist(artist, i));
      });
    } else {
      artistsList.innerHTML =
        '<li class="artists-empty">No artist data found — try listening to more music and reconnect!</li>';
    }
  }

  const p = data.payout_comparison || {};

  if (rateSpotify) {
    rateSpotify.innerHTML = `£${p.spotify_per_stream_gbp || '0.0000'}<small>/stream</small>`;
  }

  if (rateApple) {
    rateApple.innerHTML = `£${p.apple_music_per_stream_gbp || '0.0000'}<small>/stream</small>`;
  }

  if (rateTidal) {
    rateTidal.innerHTML = `£${p.tidal_per_stream_gbp || '0.0000'}<small>/stream</small>`;
  }

  if (rateBandcamp) {
    rateBandcamp.innerHTML = `${p.bandcamp_artist_cut_percent || 0}%<small>of sale to artist</small>`;
  }

  if (compareNote) {
    compareNote.textContent = p.note || '';
  }

  showOnly(report);
}

loadReport();