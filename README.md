# Price Tag Scanner

A phone-browser app (PWA) that photographs shelf price tags, reads the item number, description and price with Google Cloud Vision, and appends rows to a Google Sheet through an Apps Script. It is built from the design handoff (prototype 2a, layout 1a, Industry design system).

It has **no build step**. It is plain ES modules, HTML and CSS, so the folder can be hosted as it is.

## Layout

| Path | What it is |
|---|---|
| `index.html`, `manifest.webmanifest`, `sw.js`, `icons/` | App shell, PWA manifest, offline service worker |
| `css/industry.css` | Design-system tokens and components (copied unchanged from the handoff) |
| `css/app.css` | App layout and screen styles |
| `js/app.js` | Bootstrap: rendering, events, camera, Auto, wake lock, retry timers |
| `js/store.js` | State, IndexedDB persistence, capture → read → commit, outbox, sessions |
| `js/views.js` | Screen templates (Setup, Scan, Review, Edit, Sheet, Session ended) |
| `js/parse.js` | Vision response → `{ sku, desc, price, conf }` |
| `js/net.js` | Vision + Apps Script calls. Any failed request counts as "no signal". |
| `js/camera.js` | Rear camera, crop to the reticle, torch, Auto steadiness detector |
| `js/db.js` | Small IndexedDB wrapper |
| `apps-script/Code.gs` | Sheet backend (unchanged from the handoff) |
| `tests/parse.test.html` | Parser tests against a fixture shaped like `tag-sample.webp` |
| `serve.ps1` | Local static server for testing on a PC |

## One-time setup

1. **Sheet backend.** Open the spreadsheet → Extensions → Apps Script → paste `apps-script/Code.gs`. In Project Settings → Script properties, add `TOKEN` with a long random string. Deploy → New deployment → Web app, with *Execute as: Me* and *Who has access: Anyone*. Copy the `/exec` URL.
2. **Vision key.** In Google Cloud, enable the Cloud Vision API and create an API key. Restrict it to the Vision API and to your hosting domain as the HTTP referrer.
3. **Host it over HTTPS.** The camera requires HTTPS. For GitHub Pages, push this folder to a repo and enable Pages; Netlify drop also works.
4. Open the site on the phone. In setup, paste the URL, token and key, tap **Test connection**, then pick the tab naming. In Chrome, use ⋮ → *Add to Home screen* to install it.

## Running locally

```powershell
.\serve.ps1            # then open http://localhost:8080
```

`localhost` counts as a secure origin, so the camera works there on a PC with a webcam. Open `http://localhost:8080/tests/parse.test.html` to run the parser tests. The service worker is skipped on localhost so that edits show up on reload; add `?sw` to the URL to test it.

## Notes and known gaps

- **Scans read after signal returns skip the duplicate check.** No dialog can be shown for them at that point. Uncertain ones still go to *Needs a look*.
- **Tune Auto-capture on the phone.** The thresholds are constants at the bottom of `js/camera.js` (`STILL`, `MOVED`, `BRIGHT`, `STEADY_MS`), and they need adjusting against real tags and lighting.
- **The parser is tested only against a hand-built fixture.** Once the Vision key works, paste a real `images:annotate` response into `tests/parse.test.html` to check it.
- **The prototype's "Signal" simulator is replaced by a "Pause sending" toggle,** as the handoff suggested.
- The **Google account** card can't show an email address, because the Apps Script `ping` returns only the spreadsheet name and URL.
