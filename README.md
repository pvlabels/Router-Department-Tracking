# Router Department Tracking

A live dashboard for the MultiCam router department, reading straight from the
tracking spreadsheet. The source of truth lives in **GitHub** — every push to
`main` is synced to Apps Script (via [clasp](https://github.com/google/clasp))
and redeployed automatically by GitHub Actions.

**Dashboard: <https://pvlabels.github.io/Router-Department-Tracking/>**

Visually themed with the [Hallmark](https://github.com/nutlope/hallmark) **Cobalt**
design skill: cool engineered paper, hairline-defined surfaces, one electric-cobalt
accent, Space Grotesk / Inter / JetBrains Mono, and the weekly chart rendered as a
single dark graphite band. Light and dark modes both supported.

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
| `src/Code.js` | Backend: reads the `Job Log` tab, stores tracked jobs in a `Dashboard Jobs` tab, serves the JSON read API and the PIN-protected write API |
| `src/index.html` | The dashboard UI — one page: a reorderable **Job queue** of collapsible colored progress bars (expand for finish estimates, pieces, weekend what-ifs), a **Weekly activity** chart (stacked runs/day by job), an inline **Summary** (Day/Week/Month/Year), and collapsible **Recent runs**; auto-refreshes every 60 s |
| `src/appsscript.json` | Apps Script manifest (anonymous web app, runs as the deploying account) |
| `.clasp.json` | Links this repo to the Apps Script project (`scriptId`) |
| `.github/workflows/deploy.yml` | CI: pushes `src/` to Apps Script, redeploys the web app, and publishes the page to GitHub Pages on every push to `main` |

Sheet usage:

- **`Job Log`** (read-only): Date, Start/End Time, Job Name, Total Time,
  Machine, Status. Double-logged runs (same job + start time) are deduped
  keeping the longer entry; durations are End − Start because the logger's
  Total Time column is unreliable (+3 h offset on recent rows).
- **`Dashboard Jobs`** (owned by the dashboard, auto-created): Job Name,
  Sheets to Cut, Start Date, Active, Pieces (JSON). Managed from the dashboard
  ("+ Track job" / Edit / Stop tracking) or by hand in Sheets. All other tabs
  are ignored.

Each tracked job is a collapsed colored progress bar in the **Job queue**;
click it to expand its full ticket (pace, pieces cut, estimated finish, weekend
what-ifs, per-day strip). Drag the ⠿ handle or use ▲▼ to reorder the queue into
cut priority — the order and each job's color persist server-side (in the Apps
Script project's properties) so everyone sees the same queue.

The inline **Summary** aggregates the log over a chosen day, week, month, or year
(with prev/next navigation): per-job runs, machine time, and average per run,
plus machine downtime — idle time within scheduled Mon–Fri 6 AM–5 PM shifts,
summed per day up to now. The read endpoint returns full-history per-day/per-machine/per-job
aggregates so month/year totals stay accurate beyond the capped run list.

The **machine dropdown** at the top filters the Summary and Recent runs to a
single machine or all machines (the Job queue always shows overall job progress,
since a job's target can span machines). Utilization and downtime scale by the
number of machines in scope. Weekend what-if finish estimates assume **8-hour**
weekend shifts; weekdays are the full 11-hour shift. The layout widens and the
type scales up on large monitors.

Anyone with the link can view **and** edit tracked jobs — there is no edit PIN.
(The page is public; keep it to a trusted audience.)

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
