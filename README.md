# Router Department Tracking

A live dashboard for the MultiCam router department, reading straight from the
tracking spreadsheet. The source of truth lives in **GitHub** — every push to
`main` is synced to Apps Script (via [clasp](https://github.com/google/clasp))
and redeployed automatically by GitHub Actions.

**Dashboard: <https://pvlabels.github.io/Router-Department-Tracking/>**

The page is hosted on GitHub Pages and fetches data from an anonymous Apps
Script JSON endpoint (`doGet?format=json`). Viewers never open a
`script.google.com` URL, so Google Workspace policies that block Apps Script
apps for signed-in company accounts can't interfere. (The Apps Script-served
page at the `/exec` URL still works too, for signed-out visitors.)

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
| `src/Code.js` | Backend: serves the page, reads the run log + job progress from the Sheet |
| `src/index.html` | The dashboard UI — today/this-week tiles, job progress, runs-per-day chart, recent runs; auto-refreshes every 60 s |
| `src/appsscript.json` | Apps Script manifest (web app runs as you, access: only you) |
| `.clasp.json` | Links this repo to your Apps Script project (`scriptId`) |
| `.github/workflows/deploy.yml` | CI: pushes `src/` to Apps Script and redeploys on every push to `main` |

The backend finds the spreadsheet tabs by **header signature**, not by name or
position, so renaming/reordering tabs is safe:

- **Run log** — the tab whose header row has `Job Name` + `Start Time`
  (Date, Start/End Time, Job Name, Total Time, Machine, Status). Runs that are
  double-logged (same job + start time) are deduped, keeping the longer entry.
- **Job progress** — the tab with `Job File` + `Target Runs`
  (target/completed runs, %, avg run time, machine time left, est. finish).

Opening `src/index.html` directly in a browser shows the UI with mock data.

## One-time setup

The spreadsheet ID is already set in `CONFIG.SHEET_ID` in `src/Code.js`.

### 1. Create the Apps Script project (locally, once)

```sh
npm install -g @google/clasp@2.4.2
clasp login                      # opens a browser — sign in with your Google account
```

Then enable the Apps Script API for your account at
<https://script.google.com/home/usersettings> (one toggle), and from the repo
root:

```sh
clasp create --type webapp --title "Router Department Tracking" --rootDir src
clasp push -f
clasp open
```

`clasp create` fills in the real `scriptId` in `.clasp.json` — commit that
change. (If it also created a `src/appsscript.json` conflict prompt, keep the
one from this repo.)

### 2. Deploy the web app (once, in the editor)

In the Apps Script editor (`clasp open`):
**Deploy → New deployment → Web app** → Execute as **Me**, access **Only myself**
(or "Anyone" if others should see it) → **Deploy**.

- Copy the **web app URL** — that's your dashboard.
- Copy the **deployment ID** (starts with `AKfycb…`) — CI needs it to update
  this same deployment in place, so the URL never changes.

### 3. Wire up GitHub

In the repo (github.com/pvlabels/Router-Department-Tracking), add:

- **Secret** `CLASPRC_JSON` (Settings → Secrets and variables → Actions →
  *Secrets*): the full contents of your local `~/.clasprc.json` (created by
  `clasp login`). This is a credential — keep it a secret, never commit it.
- **Variable** `DEPLOYMENT_ID` (same page, *Variables* tab): the deployment ID
  from step 2.

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
