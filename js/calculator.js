// ================================================
// calculator.js — real-time support calculator
// All calculations run client-side
// ================================================

// Payout rates (GBP, 2026 industry averages)
const RATES = {
    spotify:     0.0030,
    appleMusic:  0.0060,
    tidal:       0.0100,
    bandcamp:    0.82,   // % of purchase price
    merch:       0.88,   // % of spend
};

// ------------------------------------------------
// Read slider values
// ------------------------------------------------
function getValues() {
    return {
        streams:  parseFloat(document.getElementById('streams').value)      || 0,
        subCost:  parseFloat(document.getElementById('subscription').value) || 10.99,
        bandcamp: parseFloat(document.getElementById('bandcamp-spend').value) || 0,
        merch:    parseFloat(document.getElementById('merch-spend').value)  || 0,
    };
}

// ------------------------------------------------
// Calculate
// ------------------------------------------------
function calculate(v) {
    const streamEarning   = v.streams * RATES.spotify;
    const bandcampEarning = v.bandcamp * RATES.bandcamp;
    const merchEarning    = v.merch    * RATES.merch;
    const directEarning   = bandcampEarning + merchEarning;
    const totalEarning    = streamEarning + directEarning;

    const platformBreakdown = [
        { name: 'Spotify (current)',  earn: v.streams * RATES.spotify },
        { name: 'Apple Music',        earn: v.streams * RATES.appleMusic },
        { name: 'Tidal',              earn: v.streams * RATES.tidal },
    ];

    return { streamEarning, directEarning, totalEarning, platformBreakdown };
}

// ------------------------------------------------
// Render results
// ------------------------------------------------
function render() {
    const v   = getValues();
    const res = calculate(v);

    const fmt = (n) => `£${n.toFixed(2)}`;

    // Main result cards
    document.getElementById('stream-result').textContent = fmt(res.streamEarning);
    document.getElementById('direct-result').textContent = fmt(res.directEarning);
    document.getElementById('total-result').textContent  = fmt(res.totalEarning);

    // Platform breakdown
    const breakdownList = document.getElementById('breakdown-list');
    if (breakdownList) {
        breakdownList.innerHTML = res.platformBreakdown.map(p => `
            <li class="breakdown-item">
                <span class="breakdown-item-name">${p.name}</span>
                <output class="breakdown-item-earn">${fmt(p.earn)}</output>
            </li>
        `).join('');
    }

    // Yearly view
    const yearlyStreams = res.streamEarning * 12;
    const yearlyTotal   = res.totalEarning  * 12;
    const yearlyDiff    = (res.totalEarning - res.streamEarning) * 12;

    document.getElementById('yearly-streams').textContent = fmt(yearlyStreams);
    document.getElementById('yearly-total').textContent   = fmt(yearlyTotal);
    document.getElementById('yearly-diff').textContent    = `+${fmt(yearlyDiff)}`;

    // Update display values for sliders
    document.getElementById('streams-value').textContent      = Math.round(v.streams).toLocaleString();
    document.getElementById('subscription-value').textContent = `£${v.subCost.toFixed(2)}`;
    document.getElementById('bandcamp-value').textContent     = `£${v.bandcamp.toFixed(2)}`;
    document.getElementById('merch-value').textContent        = `£${v.merch.toFixed(2)}`;
}

// ------------------------------------------------
// Attach listeners to all range inputs
// ------------------------------------------------
document.querySelectorAll('input[type="range"]').forEach(input => {
    input.addEventListener('input', render);
});

// Initial render
render();