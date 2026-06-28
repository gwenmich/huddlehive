# FanCheck

FanCheck is a Flask app with JWT auth, Spotify reporting, a Chrome Manifest V3
extension, backend transaction analysis, missed-site reporting, and a global
music-industry data confidence layer.

## Local Backend Setup

1. Create and activate a virtual environment.
2. Install dependencies:

```bash
pip install -r requirements.txt
```

3. Copy `.env.example` to `.env` and fill in the values you need.
4. Run the Flask app:

```bash
python app.py
```

The local API runs on `http://localhost:5000` by default. For tests or isolated
local runs, set `DATABASE_URL` or `SQLALCHEMY_DATABASE_URI`; otherwise the app
uses `sqlite:///fancheck.db`.

## Render Setup

The production backend URL is:

```text
https://fancheck.onrender.com
```

Set these environment variables in Render:

```text
JWT_SECRET_KEY
SPOTIFY_CLIENT_ID
SPOTIFY_CLIENT_SECRET
SPOTIFY_REDIRECT_URI
ANTHROPIC_API_KEY
ANTHROPIC_MODEL
ANTHROPIC_WEB_SEARCH_ENABLED
ANTHROPIC_WEB_SEARCH_TOOL_VERSION
ANTHROPIC_WEB_SEARCH_MAX_USES
FAN_CHECK_DATA_CONFIDENCE_TIMEOUT_SECONDS
FAN_CHECK_SITE_REPORT_TRIAGE_ENABLED
FAN_CHECK_ALLOWED_EXTENSION_ORIGINS
FAN_CHECK_BASE_URL
DATABASE_URL
```

`ANTHROPIC_API_KEY` must only live on the backend. The Chrome extension calls
FanCheck endpoints and must never call Anthropic directly or contain an
Anthropic API key.

`FAN_CHECK_BASE_URL` should be `https://fancheck.onrender.com` in production so
analysis responses open the correct `/analysis/<analysis_id>` detail page.

`FAN_CHECK_ALLOWED_EXTENSION_ORIGINS` should be a comma-separated list of
published extension origins once the Chrome Web Store extension ID is known:

```text
chrome-extension://abcdefghijklmnopabcdefghijklmnop
```

When this variable is empty, local development allows `localhost`,
`127.0.0.1`, and unpacked Chrome extension origins.

## Loading The Chrome Extension

The extension lives in `chrome-extension/`.

To load it unpacked:

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Click “Load unpacked.”
4. Select the `chrome-extension/` directory.
5. Open the extension popup and confirm the backend URL. The default production
   URL is `https://fancheck.onrender.com`; local development can use
   `http://localhost:5000`.

The popup can connect a FanCheck account through the existing `/auth/login`
flow. The extension stores the returned JWT token in Chrome local storage. It
does not store the password.

## Host Permissions

The Manifest V3 extension does not request `<all_urls>`. It includes known
music transaction hosts such as Ticketmaster, AXS, See Tickets, DICE, Eventim,
Skiddle, WeGotTickets, Bandcamp, StubHub, and Viagogo, plus FanCheck backend
hosts.

Resale platforms are included because fans may encounter materially different
fees, markups, transfer restrictions, and entry-risk language on secondary
marketplaces. FanCheck should warn carefully without overclaiming: resale
warnings are contextual guidance, not a claim that every resale listing is bad
or invalid.

Known domains use local-only detection automatically. Page text is not sent just
because a known domain matches.

## Extension Workflows

### Manual “Analyse This Purchase”

The popup “Analyse this purchase” action uses `activeTab` and `chrome.scripting`
for a one-time scan of the current page. It asks for consent before sending a
short best-effort redacted snippet to `POST /extension/analyze`.

The consent flow supports:

- allow for all sites
- allow for this site
- not now

Users can revoke all source-check permissions or revoke permission for the
current site from the popup. Consent is separate from site suggestions.

### Manual “Suggest This Site”

If FanCheck cannot analyse a page yet, the popup offers “Suggest this site.”
This sends the site to FanCheck for future support review. `POST
/extension/site-reports` sends metadata only:

- URL without query string or fragment
- hostname
- page title
- optional user note
- local detection signals

Site reports are queued for vetting and are never analyzed automatically.
Approved site reports are candidates for future host-permission or heuristic
updates only. Approval does not trigger page analysis and does not grant host
permissions by itself.

Users should not put names, emails, order IDs, seat details, payment details, or
account information in report notes. URL, title, and note text can still reveal
purchase intent.

### Source Details

After an analysis, the overlay can open “View sources and details.” That opens
the FanCheck backend detail page at `/analysis/<analysis_id>`, which renders only
sanitized stored analysis fields and validated citation links.

## Backend Analysis

The extension backend is implemented in `routes/extension.py`.

Endpoints:

- `POST /extension/analyze`: analyzes a consented, redacted music transaction
  snippet.
- `GET /analysis/<analysis_id>`: renders a non-sensitive FanCheck detail page.
- `POST /extension/site-reports`: queues a missed music transaction site for
  review.
- `GET /extension/site-reports`: lists reports for a JWT-authenticated demo
  reviewer.
- `PATCH /extension/site-reports/<report_id>`: updates report status. The demo
  admin placeholder treats any valid JWT as a reviewer.

FanCheck sends minimized search context to Anthropic Web Search from the backend
only. Search context should use platform, artist, venue, region, purchase type,
and generic fee terms. It must not include exact seat numbers, order IDs,
payment info, account info, full basket contents, or raw checkout text.

Redaction is best-effort. The extension redacts before sending, but redaction
can miss personal details, so consent copy and privacy docs must make that clear.

## Anthropic Web Search And Citation Validation

FanCheck uses the official Anthropic Python SDK on the backend. The Web Search
tool version is configured by `ANTHROPIC_WEB_SEARCH_TOOL_VERSION`; check current
Anthropic docs before changing it:

```text
https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool
```

Anthropic JSON `source_url` values are treated as untrusted unless they match an
actual Anthropic citation block. If citations are missing, if a source URL does
not match, or if Web Search errors, FanCheck omits numerical estimates and
specific source-backed warnings.

## Caching

FanCheck uses a 24-hour freshness window for demo consistency.

- Transaction analysis uses a 24-hour in-memory cache for derived analysis
  output and citation metadata.
- Global `DataPoint` records are refreshed daily and stored separately in the
  database.

The transaction cache must not be mixed with `DataPoint` records. Transaction
analysis may use global DataPoint values as background context only, never as
event-specific truth.

Raw page snippets and redacted snippets are not intentionally stored or cached.

## Global Data Confidence

`data_confidence.py` and `data_routes.py` implement the global music-industry
data confidence layer. It researches recurring data points such as streaming
payout rates, Bandcamp revenue share, ticket fee ranges, resale markup,
major-label royalty rates, and venue merch commission.

Endpoints:

- `GET /data/confidence`
- `GET /data/confidence/<key>`
- `POST /data/confidence/refresh` with JWT

The refresh route uses Anthropic Web Search, validates every source URL against
actual citation blocks, applies a five-dimension 100-point rubric, and stores
only sanitized derived fields in the `DataPoint` table. Missing core citations
make the data point `INSUFFICIENT`.

`FAN_CHECK_DATA_CONFIDENCE_TIMEOUT_SECONDS` defaults to 45 seconds. If Web
Search is slow or unavailable, the route fails safely. If a prior valid
DataPoint exists, FanCheck keeps it instead of overwriting it with an
insufficient fallback.

## Privacy And Third-Party AI Disclosure

See `PRIVACY.md` for the user-facing disclosure. In short:

- page text is never sent automatically
- analysis sends redacted snippets only after consent
- site reports send metadata only
- redacted snippets and minimized search context may be processed by Anthropic
- derived transaction analysis and DataPoint results may be cached for 24 hours

## Tests

Backend regression tests live in `tests/` and use Python `unittest`.

```bash
python -m unittest discover -s tests
```

The tests cover extension analysis privacy/sanitization behavior, citation
validation, Web Search fallback handling, transaction cache behavior, site
report validation/dedupe/rate limiting/admin patching, and DataPoint scoring and
freshness behavior.

## Manual QA Checklist

- Known domains show local detection only; no page text is sent automatically.
- “Analyse this purchase” requires consent before backend analysis.
- Unknown-site “Analyse this purchase” works from the popup with `activeTab`.
- Failed analysis can reveal “Suggest this site,” which sends only URL/title/note/signals.
- Report confirmation copy says: “Thanks, we’ll review this site before enabling
  analysis.”
- Suggestion note length is capped and privacy helper copy warns against personal,
  order, payment, or account details.
- Overlay “View sources and details” opens the FanCheck `/analysis/<analysis_id>`
  page.
- Login stores the JWT token, not the password.
- Resale warnings appear on resale platforms without overclaiming.
