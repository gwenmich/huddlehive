/**
 * dashboard.js — FanCheck report page
 * Fetches /report and renders all sections.
 */

import { getReport, connectSpotify, clearToken, isLoggedIn } from './api.js';

// ── Auth guard ────────────────────────────────────────────────────────
if (!isLoggedIn()) {
  window.location.replace('../pages/auth.html');
}

// ── Element references ────────────────────────────────────────────────
const spotifyGate  = document.getElementById('spotify-gate');
const loadingState = document.getElementById('loading-state');
const errorState   = document.getElementById('error-state');
const errorMsg     = document.getElementById('error-message');
const report       = document.getElementById('report');

// Nav
const navEmail   = document.getElementById('nav-email');
const btnLogout  = document.getElementById('btn-logout');

// Summary stats
const statSubscription = document.getElementById('stat-subscription');
const statToArtists    = document.getElementById('stat-to-artists');
const statPercentage   = document.getElementById('stat-percentage');
const statTracks       = document.getElementById('stat-tracks');
const summaryPlan      = document.getElementById('summary-plan');

// Artists list
const artistsList = document.getElementById('artists-list');

// Payout rates
const rateSpotify  = document.getElementById('rate-spotify');
const rateApple    = document.getElementById('rate-apple');
const rateTidal    = document.getElementById('rate-tidal');
const rateBandcamp = document.getElementById('rate-bandcamp');
const compareNote  = document.getElementById('compare-note');

// ── State helpers ─────────────────────────────────────────────────────
function showOnly(el) {
  [spotifyGate, loadingState, errorState, report].forEach(s => {
    if (s === el) s.removeAttribute('hidden');
    else s.setAttribute('hidden', '');
  });
}

// ── Logout ────────────────────────────────────────────────────────────
btnLogout.addEventListener('click', () => {
  clearToken();
  window.location.href = '../pages/auth.html';
});

// ── Spotify connect button ────────────────────────────────────────────
document.getElementById('btn-spotify').addEventListener('click', connectSpotify);

// ── Retry button ──────────────────────────────────────────────────────
document.getElementById('btn-retry').addEventListener('click', loadReport);

// ── Fallback artist image ─────────────────────────────────────────────
const FALLBACK_IMG = `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='56' height='56' viewBox='0 0 56 56'%3E%3Crect width='56' height='56' fill='%231A1A1E'/%3E%3Ccircle cx='28' cy='22' r='9' fill='%232A2A32'/%3E%3Cellipse cx='28' cy='42' rx='14' ry='9' fill='%232A2A32'/%3E%3C/svg%3E`;

// ── Artist card renderer ──────────────────────────────────────────────
function renderArtist(artist, index) {
  const li = document.createElement('li');
  li.className = 'artist-card';

  const imgSrc = artist.image || FALLBACK_IMG;

  // Build ethical alternatives links if they exist
  let altLinks = '';
  if (artist.ethical_alternatives) {
    const { bandcamp, official_site } = artist.ethical_alternatives;
    if (bandcamp) {
      altLinks += `<a href="${bandcamp}" class="alt-link alt-bandcamp" target="_blank" rel="noopener">Bandcamp</a>`;
    }
    if (official_site) {
      altLinks += `<a href="${official_site}" class="alt-link alt-site" target="_blank" rel="noopener">Official site</a>`;
    }
  }

  const altSection = altLinks
    ? `<footer class="artist-alts"><span class="artist-alts-label">Support them better:</span>${altLinks}</footer>`
    : '';

  li.innerHTML = `
    <span class="artist-rank" aria-hidden="true">${String(index + 1).padStart(2, '0')}</span>
    <img
      class="artist-img"
      src="${imgSrc}"
      alt="${artist.name}"
      width="56" height="56"
      onerror="this.src='${FALLBACK_IMG}'"
    >
    <div class="artist-info">
      <a
        class="artist-name"
        href="${artist.spotify_url}"
        target="_blank"
        rel="noopener"
      >${artist.name}</a>
      <div class="artist-meta">
        <span class="artist-streams">${formatNumber(artist.estimated_streams_from_you)} streams from you</span>
        <span class="artist-dot" aria-hidden="true">·</span>
        <span class="artist-popularity">Popularity ${artist.popularity_score}/100</span>
      </div>
    </div>
    <output class="artist-earnings">
      <strong class="earnings-value">£${artist.estimated_earnings_from_you_gbp.toFixed(2)}</strong>
      <span class="earnings-label">earned from you</span>
    </output>
    ${altSection}
  `;

  return li;
}

// ── Number formatter ──────────────────────────────────────────────────
function formatNumber(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000)     return (n / 1_000).toFixed(0) + 'K';
  return String(n);
}

// ── Main load function ────────────────────────────────────────────────
async function loadReport() {
  showOnly(loadingState);

  const { ok, status, data } = await getReport();

  // 401 = token expired or Spotify not connected yet
  if (status === 401 || status === 400) {
    showOnly(spotifyGate);
    return;
  }

  if (!ok) {
    // Check if Spotify isn't connected (backend may return a specific message)
    const msg = (data.message || '').toLowerCase();
    if (msg.includes('spotify') && (msg.includes('connect') || msg.includes('not linked') || msg.includes('not found'))) {
      showOnly(spotifyGate);
      return;
    }
    errorMsg.textContent = data.message || 'Something went wrong loading your report. Please try again.';
    showOnly(errorState);
    return;
  }

  // ── Populate nav ───────────────────────────────────────────────────
  navEmail.textContent = data.user?.email || '';

  // ── Summary stats ──────────────────────────────────────────────────
  const s = data.summary;
  statSubscription.textContent = `£${s.yearly_spotify_subscription_gbp.toFixed(2)}`;
  statToArtists.textContent    = `$${s.total_estimated_paid_to_artists_usd.toFixed(2)}`;
  statPercentage.textContent   = s.percentage_reaching_artists;
  statTracks.textContent       = s.top_tracks_count;

  const plan = data.user?.spotify_plan || '';
  summaryPlan.textContent = plan
    ? `Spotify ${plan.charAt(0).toUpperCase() + plan.slice(1)} account · ${data.user.spotify_display_name || ''}`
    : '';

  // ── Artists ────────────────────────────────────────────────────────
  artistsList.innerHTML = '';
  if (Array.isArray(data.top_artists) && data.top_artists.length > 0) {
    data.top_artists.forEach((artist, i) => {
      artistsList.appendChild(renderArtist(artist, i));
    });
  } else {
    artistsList.innerHTML = '<li class="artists-empty">No artist data found — try listening to more music and reconnect!</li>';
  }

  // ── Payout comparison ──────────────────────────────────────────────
  const p = data.payout_comparison;
  if (p) {
    rateSpotify.innerHTML  = `£${p.spotify_per_stream_gbp}<small>/stream</small>`;
    rateApple.innerHTML    = `£${p.apple_music_per_stream_gbp}<small>/stream</small>`;
    rateTidal.innerHTML    = `£${p.tidal_per_stream_gbp}<small>/stream</small>`;
    rateBandcamp.innerHTML = `${p.bandcamp_artist_cut_percent}%<small>of sale to artist</small>`;
    compareNote.textContent = p.note || '';
  }

  showOnly(report);
}

// ── Kick off ──────────────────────────────────────────────────────────
//loadReport();  ------- commented out to show dummy data below


function loadDummy() {
  const data = {
    user: {
      email: "example@example.com",
      spotify_display_name: "Jane",
      spotify_plan: "premium"
    },
    summary: {
      yearly_spotify_subscription_gbp: 143.88,
      total_estimated_paid_to_artists_gbp: 12.40,
      percentage_reaching_artists: "8.6%",
      top_tracks_count: 20
    },
    top_artists: [
      {
        name: "I Prevail",
        popularity_score: 72,
        estimated_streams_from_you: 720000,
        estimated_earnings_from_you_gbp: 2.52,
        image: null,
        spotify_url: "https://open.spotify.com/artist/0xRXCcSX89mBiTQGDiYQu3",
        ethical_alternatives: { bandcamp: "https://iprevail.bandcamp.com" }
      },
      {
        name: "Spiritbox",
        popularity_score: 68,
        estimated_streams_from_you: 680000,
        estimated_earnings_from_you_gbp: 2.38,
        image: null,
        spotify_url: "https://open.spotify.com/artist/4GW6PbJMCBQ6GDiGTgU9sB",
        ethical_alternatives: { bandcamp: "https://spiritbox.bandcamp.com" }
      },
      {
        name: "Bad Omens",
        popularity_score: 74,
        estimated_streams_from_you: 740000,
        estimated_earnings_from_you_gbp: 2.59,
        image: null,
        spotify_url: "https://open.spotify.com/artist/7z6G9RbDkTXBBaBfAf4QjS",
        ethical_alternatives: { official_site: "https://badomensmusic.com" }
      },
      {
        name: "Poppy",
        popularity_score: 65,
        estimated_streams_from_you: 650000,
        estimated_earnings_from_you_gbp: 2.28,
        image: null,
        spotify_url: "https://open.spotify.com/artist/1Tvfd1joSCMhkGBQbZEfwg",
        ethical_alternatives: { bandcamp: "https://iampoppy.bandcamp.com" }
      },
      {
        name: "Sleep Token",
        popularity_score: 80,
        estimated_streams_from_you: 800000,
        estimated_earnings_from_you_gbp: 2.80,
        image: null,
        spotify_url: "https://open.spotify.com/artist/0WwSkZ7LtFUFjGjMZBMt6T",
        ethical_alternatives: null
      }
    ],
    payout_comparison: {
      spotify_per_stream_gbp: 0.0035,
      apple_music_per_stream_gbp: 0.006,
      tidal_per_stream_gbp: 0.010,
      bandcamp_artist_cut_percent: 82,
      note: "UK rates based on 2026 industry averages. Actual payouts vary."
    }
  };

  // reuse all the existing render logic
  navEmail.textContent = data.user.email;

  const s = data.summary;
  statSubscription.textContent = `£${s.yearly_spotify_subscription_gbp.toFixed(2)}`;
  statToArtists.textContent    = `£${s.total_estimated_paid_to_artists_gbp.toFixed(2)}`;
  statPercentage.textContent   = s.percentage_reaching_artists;
  statTracks.textContent       = s.top_tracks_count;
  summaryPlan.textContent      = `Spotify Premium account · ${data.user.spotify_display_name}`;

  artistsList.innerHTML = '';
  data.top_artists.forEach((artist, i) => {
    artistsList.appendChild(renderArtist(artist, i));
  });

  const p = data.payout_comparison;
  rateSpotify.innerHTML  = `£${p.spotify_per_stream_gbp}<small>/stream</small>`;
  rateApple.innerHTML    = `£${p.apple_music_per_stream_gbp}<small>/stream</small>`;
  rateTidal.innerHTML    = `£${p.tidal_per_stream_gbp}<small>/stream</small>`;
  rateBandcamp.innerHTML = `${p.bandcamp_artist_cut_percent}%<small>of sale to artist</small>`;
  compareNote.textContent = p.note;

  showOnly(report);
}





// ── Kick off ──────────────────────────────────────────────────────────
loadDummy();


