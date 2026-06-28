# FanCheck Data Confidence Component

This component displays global music-industry data points such as streaming
payout estimates, platform revenue share, ticket fee ranges, resale markup, and
venue merch commission.

It must not present these values as event-specific truth. Transaction analysis
may use DataPoint values as background context only.

## Primary Figure Display

- Show `display.primary_figure` as the main value.
- Show `display.label` as the title.
- Show `unit` and `currency` only when they help clarify the value.
- If `confidence_band` is `INSUFFICIENT`, replace the primary value with
  “Insufficient source-backed data.”

## Confidence Pill

- Use `confidence_band` for the pill text: `HIGH`, `MEDIUM`, `LOW`, or
  `INSUFFICIENT`.
- Use `confidence_score` as secondary text, for example `72/100`.
- Suggested states:
  - `HIGH`: strong positive color.
  - `MEDIUM`: neutral or amber color.
  - `LOW`: warning color.
  - `INSUFFICIENT`: muted/disabled color.

## Tooltip

The confidence tooltip should summarize the five dimensions:

- Source Authority
- Recency
- Corroboration
- Specificity
- Methodology Transparency

Use `dimension_scores` for numeric scores and `dimension_evidence` for the
plain-language explanation. Do not invent additional rationale in the frontend.

## Methodology Drawer

The drawer should include:

- `methodology_notes`
- `last_updated`
- `freshness_window_hours` from the list endpoint when available.
- A reminder that these are global recurring industry data points, not a
  transaction-specific analysis.

## Source List

Render `sources` as a compact list with:

- `source_label`
- `source_domain`
- `source_type`
- `figure_reported`
- `publication_date` when known.
- `cited_excerpt`

Open `source_url` in a new tab with `rel="noopener"`.

Only display sources returned by the API. The backend already filters source
URLs against actual Anthropic Web Search citation blocks.

## Contradiction Display

If `contradictions` is present, show it in a clearly marked “Conflicting
sources” section. Keep the tone neutral; contradictory public estimates are a
normal part of music-industry data.

If `display.outside_expected_range` is true, show a separate caution that the
latest source-backed figure is outside FanCheck’s expected demo range and should
be interpreted carefully.

## Insufficient Data State

For `INSUFFICIENT`:

- Hide numerical styling.
- Show the reason from `methodology_notes`.
- Show source rows only if the API returned validated citations.
- Include the “Help us find a source” link.

## Help Us Find A Source

Link text:

```text
Help us find a source
```

For the demo, point this to the FanCheck app or feedback flow. The link should
include the DataPoint key as a query parameter when possible, for example:

```text
/pages/contact.html?topic=data-source&key=venue_merch_commission
```
