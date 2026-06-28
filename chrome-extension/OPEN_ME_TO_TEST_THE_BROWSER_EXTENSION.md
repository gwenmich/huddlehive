# Open me to test the browser extension

This guide is for testing the FanCheck Chrome browser extension. You do not need
to write code.

FanCheck uses https://fancheck.onrender.com behind the scenes.

## Before you start

Use Google Chrome on a laptop or desktop.

If someone has just changed the extension code, you must reload the extension in
Chrome before testing again.

## Load FanCheck in Chrome

1. Open Chrome.
2. Type this into the address bar: `chrome://extensions`
3. Press Enter.
4. Turn on **Developer mode** in the top right.
5. Click **Load unpacked**.
6. Choose the `chrome-extension` folder from this project.

What you should see:

- A FanCheck card appears on the Chrome extensions page.
- The card should not show a red error.

## Pin FanCheck

1. Click the puzzle-piece icon in Chrome's toolbar.
2. Find FanCheck.
3. Click the pin icon.

What you should see:

- The FanCheck icon appears near the address bar.

## Open FanCheck for the first time

1. Click the FanCheck icon.
2. You may see a FanCheck permission message.
3. Click **Allow FanCheck** if you want FanCheck to appear on supported music
   purchase pages.
4. Click **Not now** if you do not want it to appear automatically.

What you should know:

- FanCheck checks pages locally in your browser first.
- FanCheck should not run the full analysis until you click
  **Analyse this purchase**.
- You can change permission later.
- You do not need to sign in to test basic analysis.

## Test on a supported music purchase page

Try a page that looks like a music ticket, resale ticket, or merch purchase
page. Good places to start:

- Ticketmaster
- AXS
- See Tickets
- DICE
- Eventim
- Skiddle
- WeGotTickets
- Bandcamp
- StubHub
- Viagogo

Best test pages are checkout, basket, cart, ticket, event, or merch pages.

What you should see:

- If FanCheck permission is enabled and the page looks like a supported music
  purchase page, FanCheck may appear at the point of purchase.
- It should not keep popping up again and again on the same page.
- It should not analyse the page until you click **Analyse this purchase**.

## Run an analysis

1. Open a music purchase page.
2. Click the FanCheck icon or use the FanCheck box if it appears on the page.
3. Click **Analyse this purchase**.

What you should see:

- The button may say it is analysing.
- FanCheck may show source-backed guidance.
- If sources are available, you may see **View sources and details**.

If it works:

- Click **View sources and details**.
- A FanCheck page should open with more detail.

If it fails:

- You should see: `FanCheck could not analyse this page yet.`
- You may see **Suggest this site**.

## Suggest a site

Use **Suggest this site** when FanCheck should work on a page but does not.

1. Click **Suggest this site**.
2. Add a short note if helpful.
3. Do not include personal, order, payment, or account details.
4. Send the suggestion.

What you should see:

- A thank-you message.
- FanCheck should not analyse the page just because you suggested it.

## Change FanCheck permission

Open the FanCheck popup and look for the privacy controls.

You can:

- Enable FanCheck
- Enable FanCheck for this site
- Revoke all permissions
- Revoke permissions for this site

What you should see:

- If permission is revoked, FanCheck should stop appearing automatically.
- Backend analysis should not run unless permission exists and you click
  **Analyse this purchase**.

## Reload after changes

If someone updates the extension code:

1. Go to `chrome://extensions`.
2. Find FanCheck.
3. Click the reload icon on the FanCheck card.
4. Refresh the page you are testing.

This fixes many "nothing changed" or "button does nothing" problems.

## Common problems

### The extension does not appear on the page

Try this:

1. Refresh the page.
2. Check that FanCheck permission is enabled.
3. Make sure the page looks like a checkout, basket, ticket, event, or merch
   page.
4. Open the FanCheck popup and click **Analyse this purchase** manually.

### Analyse this purchase takes a while

FanCheck may be checking current public sources. If the provider is slow,
FanCheck should fail gracefully instead of hanging forever.

If it keeps failing, ask whoever deployed the backend to check that Render has:

- `ANTHROPIC_API_KEY`
- `ANTHROPIC_MODEL`
- `ANTHROPIC_WEB_SEARCH_ENABLED=true`
- `ANTHROPIC_REQUEST_TIMEOUT_SECONDS=12`

### Analyse this purchase fails

This can happen when:

- the page does not look enough like a music purchase page,
- FanCheck permission is not enabled,
- current source checks are unavailable,
- the backend is still deploying,
- the page needs to be refreshed after reloading the extension.

Use **Suggest this site** if the page should be supported.

### Sign in does not work

You do not need to sign in for basic testing.

If you are testing account connection, check that the backend is live and then
try again.

### I changed something but Chrome still shows the old extension

Reload the extension in `chrome://extensions`, then refresh the page you are
testing.

Chrome often keeps old extension code until you reload it.

## Quick test checklist

- FanCheck loads without a red error in `chrome://extensions`.
- FanCheck can be pinned in Chrome.
- First open shows FanCheck permission.
- **Not now** stops automatic FanCheck surfacing.
- **Allow FanCheck** lets FanCheck appear on supported purchase pages.
- **Analyse this purchase** is the only thing that starts full analysis.
- Failed analysis shows `FanCheck could not analyse this page yet.`
- **Suggest this site** sends a suggestion, not an analysis.
- Revoking permission stops automatic FanCheck surfacing.
