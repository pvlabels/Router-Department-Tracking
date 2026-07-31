# Production Board

A live production board for the router and laser departments — what to cut
next, what got finished, and printable reports for management, driven by the
shop's own production data.

**Board: <https://pvlabels.github.io/Router-Department-Tracking/>**

## What it shows

### Dashboard

- **Metal Queue** — tracked router jobs as collapsible colored progress bars.
  Drag the handle to set cut priority; click a job for its full ticket (pace,
  pieces cut, estimated finish, weekend what-ifs, per-day strip). Search by
  part number or work order.
- **Metal Log** — jobs that finished, by day / week / month / year, each row
  expanding to the same ticket.
- **Laser Queue** — laser runs on the floor: the work orders and placards on
  each sheet, which laser it's running on, its stage (On Laser → On Router),
  and rush/next-day-air priority. Reorderable and searchable like the metal
  queue.
- **Laser Log** — completed laser runs over the same periods.
- **Summary** — runs, machine time, average per run, and idle time within
  scheduled Mon–Fri 6 AM–5 PM shifts, filterable by machine.

### Reports

Five report types — Size, Press Sheet, Customer, Stock Item, WO # — over any
period, measured by runs, sheets, or machine time. Compare a period against
the previous one, a custom range, or put several items head-to-head. Every
report prints clean as a PDF for handing over.

### How it works

A reference page covering the three cutting stages (full sheet → press sheet →
finished part), how to read a run filename, the standard press sheet sizes,
and how each field on a sheet label feeds the reports.

## What's here

| Path | Purpose |
|---|---|
| `src/index.html` | The entire front end — one page, no build step, light and dark themes |
| `src/Code.js` | Backend: reads the production data and serves the JSON the page fetches |

## Notes

- The board auto-refreshes every 60 seconds.
- Anyone with the link can view **and** edit tracked jobs — there is no
  sign-in, deliberately, so nobody on the floor is locked out. The page is
  public; keep the link to a trusted audience.
- Opening `src/index.html` directly in a browser shows the UI with mock data.
- Pushes to `main` deploy automatically.
