# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Three confirmed audiences, in priority order:

- **Router operators** on the shop floor — check the cut queue to know what to run next on the MultiCam routers.
- **Department lead/manager** — plans and reorders the queue, tracks job progress and finish estimates, marks jobs complete.
- **Upper management** — consumes the Reports view (throughput, utilization, comparisons) rather than the live queue.

Viewed on **office desktops and phones/tablets** (confirmed). There is no wall-mounted shop-floor display; mobile usability matters because people check it while moving around.

## Product Purpose

A live, job-centric dashboard for the PV Labels router department. It reads the department's real machine log and production schedule and turns them into: a prioritized cut queue with per-job progress, finish-date estimates (with weekend what-if scenarios), a finished-jobs log, per-run summaries, and printable management reports.

Success (confirmed): **the floor always knows what to cut next**, and **management can see proven throughput** without anyone compiling numbers by hand.

## Positioning

Zero manual data entry. Everything derives from two sources the department already maintains: the MultiCam Job Log (machine-written) and the production schedule. The dashboard dedupes double-logged runs, works around known logger bugs, matches runs to jobs through the shop's file-versioning conventions (TR-N.cnc, PS-*, numeric version suffixes), and auto-queues scheduled multicam jobs — things a generic dashboard tool could not truthfully do.

## Operating Context

- PV Labels router department; jobs are cut from 4'×8' sheets on MultiCam routers.
- Data sources: "Press Sheet Tracking" spreadsheet (Job Log tab, machine-written) and the "Live Production Copy" schedule (auto-queues runs marked multicam; statuses Pre-Press → On-Press → Finished Printing → Finished Cutting).
- Shop schedule: Mon–Fri 6 AM–5 PM shifts; weekend what-if scenarios assume 8 h shifts.
- Terminology: a **Run #** is a numbered cut of an already-printed sheet into finished parts; every run file is either **SR-** (Short Run — stock items) or **TR-** (Today's Run — custom orders, TR-<run#>.cnc). **PS-** files cut the raw 4'×8' sheet down to a press sheet before printing. Also: work orders (WO-######), part numbers, sheets-to-cut targets, pieces per sheet.
- Reached via a public URL (GitHub Pages front end fetching Apps Script JSON); a desktop shortcut exists in the department.

## Capabilities and Constraints

- Single-page app: Dashboard (Job queue, Finished log, per-run Summary) + Reports (five report types, period/compare modes, print-to-PDF).
- Anyone with the URL can view **and edit** tracked jobs — deliberately no sign-in and no PIN (the company Workspace blocks Apps Script web apps, and floor friction outweighed lock-down).
- Run **durations exist only from Jun 17, 2026** (Job Log start). Runs/sheets history reaches back to Jan 2026 via a backfilled Production History tab. Reports must keep labeling hour-based figures as partial when a period predates Jun 17 — never present them as complete.
- The sheet's own Total Time column is untrustworthy (+3 h logger bug); durations are computed End − Start.
- The machine double-logs runs; the backend dedupes (keeps the longer entry).
- Deploys automatically on push to main (Apps Script + GitHub Pages). The repo is public: no real customer data may be committed beyond what the live page already exposes.

## Brand Commitments

- **Digital Department** identity: the DDT "D-toggle" logo (theme-aware inline SVG; master SVGs at `U:\projects\Digital-Department-Tools\Digital_Dept_Logo\`).
- **Geist UI** design system (user-pinned standing rule): Inter + Menlo mono, accent #0070f3, bordered cards, light/dark themes with a manual toggle that overrides the OS.
- Voice: plain shop-floor English; sentence case; numbers carry their source ("hours from the router log (Jun 17 on)").

## Evidence on Hand

- Live production data from the two spreadsheets (real runs, jobs, work orders, customers) — the dashboard is its own evidence; no marketing claims, testimonials, or invented benchmarks belong anywhere.
- Design handoff mockups exist locally (`Router Department Redesign/`, gitignored — screenshots contain real job names/WOs).

## Product Principles

1. **The floor's next action first.** Queue order, progress, and "what to cut next" outrank every other feature.
2. **Machine data over human memory.** Derive everything from the logs; correct known logger bugs in code rather than asking people to fix data.
3. **Defensible numbers.** Every figure states its source and coverage; partial data (pre–Jun 17 hours) is labeled, not hidden.
4. **Zero training, zero friction.** Public URL, no sign-in, one page, readable on a phone.
5. **Management-ready on demand.** Reports print clean and stand on their own without narration.

## Accessibility & Inclusion

No formal standard was established. Practical requirements: must stay readable and operable on phones (confirmed usage), in both light and dark themes.
