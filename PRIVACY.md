# FanCheck Privacy Notes

FanCheck is designed around consent, minimization, and source transparency. This
document describes the current demo behavior for the Chrome extension, backend
analysis, site reports, and global data confidence.

## Page Text And Consent

- Page text is never sent automatically.
- Known-domain detection runs locally in the browser until the user chooses to
  check the page.
- Analysis sends a short redacted snippet only after explicit consent.
- Consent can be granted once, for one site, or globally.
- Users can revoke site-level and global consent from the extension popup.
- Declining consent means no page text is sent for analysis.

## Best-Effort Redaction

The extension redacts page text before sending it to the backend, but redaction
is best-effort and may miss personal details. Users should avoid running
analysis on pages that contain sensitive information they do not want processed.

Search context is minimized and should avoid names, emails, order IDs, seat
details, payment details, account information, full basket contents, and raw
checkout text.

## Third-Party AI Processing

Redacted snippets and minimized search context may be processed by Anthropic, a
third-party AI provider, for analysis and public Web Search grounding.

FanCheck calls Anthropic from the backend only. The Chrome extension must never
contain an Anthropic API key and must never call Anthropic directly.

## Storage And Caching

- Raw page snippets are not intentionally stored.
- Redacted snippets are not intentionally stored.
- Derived transaction analysis results and citation metadata may be cached for
  up to 24 hours.
- Global music-industry DataPoint confidence results may also be stored and
  refreshed on a 24-hour cadence.
- Stored analysis records contain only sanitized display-safe fields such as
  hostname, platform, purchase type, detected total, estimate summaries,
  warnings, alternatives, source-check status, cache status, and validated
  citation metadata.

## Site Reports

If the extension does not trigger, users can manually report a site as a
possible music transaction site.

Site reports send metadata only:

- URL without query string or fragment
- hostname
- page title
- optional user note
- local detection signals

Site reports do not send page text and do not trigger automatic analysis.
Reports are queued for vetting. Approved reports are candidates for future
host-permission or heuristic updates only.

URL, title, and note text can still reveal purchase intent. User notes should
not include names, emails, order IDs, seat details, payment details, account
details, or other sensitive information.

FanCheck may send site-report metadata to Anthropic for advisory triage. AI
triage does not automatically approve a site, enable analysis, change host
permissions, or trigger page analysis.

## Analysis Detail Pages

`/analysis/<analysis_id>` renders sanitized stored analysis fields and validated
source links. It must not render raw page snippets, redacted snippets, full
checkout URLs, query strings, order IDs, seat details, payment details, account
details, or full basket contents.

## Operational Metadata

FanCheck may log operational metadata such as timestamp, hostname, auth status,
result type, source-check status, cache status, latency, and error status.

FanCheck should not log raw page text or redacted snippets.
