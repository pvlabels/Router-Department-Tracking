# Live Sheets Dashboard

A live dashboard served by **Google Apps Script**, reading straight from a Google
Sheet. The source of truth lives in **GitHub** — every push to `main` is synced to
Apps Script (via [clasp](https://github.com/google/clasp)) and redeployed
automatically by GitHub Actions.

```
Google Sheet ──(read server-side)──> Apps Script web app ──> browser dashboard
      ▲                                     ▲
      │                                     │ clasp push + deploy
   your data                        GitHub Actions (on push to main)
```

Because the Sheet is read server-side by Apps Script, nothing is published
publicly and no API keys appear in the client.

## What's here

| Path | Purpose |
|---|---|
| `src/Code.js` | Backend: serves the page, reads the Sheet (`CONFIG` at the top) |
| `src/index.html` | The dashboard UI — stat tiles, trend chart, table; auto-refreshes every 60 s |
| `src/appsscript.json` | Apps Script manifest (web app runs as you, access: only you) |
| `.clasp.json` | Links this repo to your Apps Script project (`scriptId`) |
| `.github/workflows/deploy.yml` | CI: pushes `src/` to Apps Script and redeploys on every push to `main` |

The dashboard auto-adapts to whatever the Sheet contains: row 1 is treated as
headers, the first column as the x-axis (dates are formatted), and numeric
columns become stat tiles + chart series (up to 4). Opening `src/index.html`
directly in a browser shows it with mock data.

## One-time setup

### 1. Point it at your Sheet

Copy the spreadsheet ID from the sheet URL
(`https://docs.google.com/spreadsheets/d/<THIS_PART>/edit`) and paste it into
`SHEET_ID` in `src/Code.js`. Optionally set `SHEET_NAME` to a specific tab.

### 2. Create the Apps Script project (locally, once)

```sh
npm install -g @google/clasp@2.4.2
clasp login                      # opens a browser — sign in with your Google account
```

Then enable the Apps Script API for your account at
<https://script.google.com/home/usersettings> (one toggle), and from the repo
root:

```sh
clasp create --type webapp --title "Live Dashboard" --rootDir src
clasp push -f
clasp open
```

`clasp create` fills in the real `scriptId` in `.clasp.json` — commit that
change. (If it also created a `src/appsscript.json` conflict prompt, keep the
one from this repo.)

### 3. Deploy the web app (once, in the editor)

In the Apps Script editor (`clasp open`):
**Deploy → New deployment → Web app** → Execute as **Me**, access **Only myself**
(or "Anyone" if others should see it) → **Deploy**.

- Copy the **web app URL** — that's your dashboard.
- Copy the **deployment ID** (starts with `AKfycb…`) — CI needs it to update
  this same deployment in place, so the URL never changes.

### 4. Wire up GitHub

Create a GitHub repo and push this project, then add:

- **Secret** `CLASPRC_JSON` (Settings → Secrets and variables → Actions →
  *Secrets*): the full contents of your local `~/.clasprc.json` (created by
  `clasp login`). This is a credential — keep it a secret, never commit it.
- **Variable** `DEPLOYMENT_ID` (same page, *Variables* tab): the deployment ID
  from step 3.

## Day-to-day

Edit anything under `src/`, push to `main` — GitHub Actions pushes the code to
Apps Script and redeploys. The dashboard URL never changes, and the page itself
re-fetches the Sheet every 60 seconds.

## Notes

- **Access control** lives in `src/appsscript.json` (`webapp.access`): `MYSELF`
  (default here), or `ANYONE` to share with anyone signed into Google. Widening
  access requires creating a new deployment version, which CI does on each push.
- Rows returned to the browser are capped at `CONFIG.MAX_ROWS` (1000) — the most
  recent rows win.
- If the `clasp login` token expires (rare, but it can), re-run `clasp login`
  locally and update the `CLASPRC_JSON` secret.
