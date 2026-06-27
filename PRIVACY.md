# FanCheck Privacy Notes

FanCheck is designed to keep browser-extension analysis consent-based and
minimized.

## Page Analysis

- FanCheck does not automatically send page text to the backend.
- Page text is sent only after user consent.
- Sent text should be redacted by the extension first.
- Redaction is best-effort and may miss personal details.
- Redacted snippets and minimized search context may be processed by Anthropic,
  a third-party AI provider, for analysis and public web-search grounding.
- Search context should not include exact seat numbers, order IDs, names, email
  addresses, payment details, account information, exact basket contents, or raw
  checkout text.

## Storage

- Raw page snippets are not intentionally stored.
- Redacted snippets are not intentionally stored.
- Derived analysis results may be cached for up to 24 hours.
- Stored analysis records contain only sanitized display-safe fields such as
  platform, hostname, purchase type, detected total, estimate summaries,
  warnings, alternatives, cache status, and source citations.

## Site Reports

If the extension does not trigger, users can report a site as a possible music
transaction site.

Site reports send:

- URL without query string or fragment
- hostname
- page title
- optional user note
- local detection signals

Site reports do not send page text and do not trigger automatic analysis. URL,
title, and notes can still reveal purchase intent, so users should not include
personal, order, payment, or account details in report notes.

FanCheck may send site-report metadata to Anthropic for advisory triage. This
triage uses URL without query string, hostname, page title, optional user note,
and local detection signals only. AI triage does not automatically approve a
site, enable analysis, or change host permissions.

## Metadata

FanCheck may log operational metadata such as timestamp, hostname, auth status,
result type, source-check status, cache status, latency, and error status.

FanCheck should not log raw page text or redacted snippets.

## Consent

The extension should provide controls to grant or revoke site-level and global
analysis consent. Site reports are separate from analysis consent because they
do not send page text or trigger source-backed analysis.
