# FanCheck

FanCheck is a Flask app with JWT auth, Spotify reporting, and backend support
for the FanCheck Chrome extension.

## Local Setup

1. Create a virtual environment.
2. Install dependencies:

```bash
pip install -r requirements.txt
```

3. Copy `.env.example` to `.env` and fill in the values you need.
4. Run the app:

```bash
python app.py
```

The local API runs on `http://localhost:5000` by default.

## Render Setup

The production app URL is:

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
```

`ANTHROPIC_API_KEY` must only live on the backend. The Chrome extension should
call FanCheck endpoints, never Anthropic directly.

`FAN_CHECK_ALLOWED_EXTENSION_ORIGINS` should be a comma-separated list of
published extension origins once the Chrome Web Store extension ID is known,
for example:

```text
chrome-extension://abcdefghijklmnopabcdefghijklmnop
```

When this variable is empty, local development allows `localhost`,
`127.0.0.1`, and unpacked Chrome extension origins. Production should set the
published extension origin explicitly.

## Chrome Extension Backend

The extension backend is implemented in `routes/extension.py`.

Endpoints:

- `POST /extension/analyze`: analyzes a consented, redacted music transaction
  page snippet.
- `GET /analysis/<analysis_id>`: renders a non-sensitive FanCheck detail page
  with estimates, warnings, alternatives, and source links.
- `POST /extension/site-reports`: queues a missed music transaction site for
  review without analyzing page text.
- `GET /extension/site-reports`: lists reports for a JWT-authenticated demo
  reviewer.
- `PATCH /extension/site-reports/<report_id>`: updates report status.

Site reports are queued for vetting and are never analyzed automatically.
Approved reports are only candidates for future host-permission or heuristic
updates.

When `FAN_CHECK_SITE_REPORT_TRIAGE_ENABLED` is true, FanCheck asks Anthropic for
an advisory recommendation using only report metadata: URL without query string,
hostname, page title, optional user note, and local detection signals. This
triage can suggest `approve_candidate`, `reject_candidate`, or `manual_review`,
but it never changes the report status automatically and never enables page
analysis by itself.

## Anthropic Web Search

FanCheck uses the official Anthropic Python SDK from the backend. The web search
tool version is configured by `ANTHROPIC_WEB_SEARCH_TOOL_VERSION`; check the
current Anthropic docs before changing it:

```text
https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool
```

The extension sends page text only after user consent and after client-side
redaction. FanCheck sends the redacted snippet plus minimized search context to
Anthropic. Search context should use platform, artist, venue, region, purchase
type, and generic fee terms. It must not include exact seat numbers, order IDs,
payment info, account info, full basket contents, or raw checkout text.

Source URLs suggested in Anthropic JSON are treated as untrusted until they
match actual Anthropic citation blocks. If citations are missing or web search
fails, FanCheck omits numerical estimates and shows qualitative guidance.

## Global Data Confidence

FanCheck also has a separate global data-confidence layer in
`data_confidence.py` and `data_routes.py`.

This layer researches recurring industry data points such as streaming payout
rates, Bandcamp revenue share, ticket fee ranges, secondary-market markup,
major-label royalty rates, and venue merch commission. It uses Anthropic Web
Search from the backend only, validates source URLs against actual citation
blocks, scores each figure with a five-part rubric, and stores only sanitized
derived results in the `DataPoint` table.

Endpoints:

- `GET /data/confidence`: returns all configured global data points with safe
  defaults for missing or stale records.
- `GET /data/confidence/<key>`: returns one global data point.
- `POST /data/confidence/refresh`: refreshes stale or selected records. Requires
  JWT auth. Send `{ "force": true }` to refresh even when records are fresh, or
  `{ "key": "venue_merch_commission" }` for one record. When no key is provided,
  the demo route refreshes one stale or missing record per request by default.
  A small `limit` value from 1 to 3 may be supplied for demo admin use.

`FAN_CHECK_DATA_CONFIDENCE_TIMEOUT_SECONDS` is optional and defaults to 45
seconds. If Anthropic Web Search does not return in time, FanCheck stores a safe
`INSUFFICIENT` result instead of blocking the server indefinitely. If a previous
valid DataPoint exists, a failed refresh keeps that older record rather than
overwriting it with an insufficient fallback.

Global DataPoint records are separate from transaction-specific extension
analysis. Both use a 24-hour freshness window for demo consistency, but the
transaction analysis cache must not be mixed with `DataPoint` records.
Transaction analysis may use global DataPoint values as background context only,
never as event-specific truth.

## Caching

The extension backend uses a 24-hour in-memory cache for derived analysis
results. The cache stores only non-sensitive output such as estimates, warnings,
alternatives, citations, confidence, and timestamps.

It does not cache raw page text or redacted snippets.

For production, replace the in-memory cache and rate limits with Redis,
database-backed storage, or provider/gateway limits.

## Analysis Detail Pages

`/analysis/<analysis_id>` renders only sanitized stored data:

- hostname
- platform name
- purchase type
- detected total
- estimate summary when source-backed
- confidence and cache/source status
- warnings
- alternatives
- citations

It must not display raw page snippets, full checkout URLs, query strings, order
IDs, seat details, payment details, account details, or full basket contents.

## Privacy

See `PRIVACY.md` for the user-facing disclosure around consent, redaction,
Anthropic processing, site reports, caching, and metadata logging.
