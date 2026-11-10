# Laser run logging

`Log Laser Run.jsx` sends the open Illustrator run sheet's info to the
[laser run board](https://docs.google.com/spreadsheets/d/1E-ID5GrIyq9jZHDsCgAFt-8XkT2YohRjYdCI6b68GPU/edit).

## Use

1. Open the laser run file in Illustrator (e.g. `LR-25223-8.5X24-T6.ai`).
2. **File > Scripts > Other Script...** and pick `Log Laser Run.jsx`
   (or copy it into Illustrator's `Presets/Scripts` folder once so it shows up
   under File > Scripts permanently).
3. A dialog shows what it found — run #, date, sheets, color, customer, WO,
   and every part number on the sheet. Fix anything, then **Send to Sheet**.

## What it grabs

- **Part numbers** — every `04-732-282397-H`-style number in the artwork,
  with a count if the same label appears more than once.
- **Laser Run # / Date / Qty of Sheets / Customer / Work Order** — from the
  footer line on the sheet.
- **Sheet color** — from the part number prefix, using the board's dropdown
  values: `4`/`04` = Red with White text, `14` = Yellow with Black text,
  `24` = Black with White text, `34` = White with Black text.
- **Sheet size + laser machine** — from the file name:
  `LR-25223-8.5X24-T6` → size `8.5X24`, Trotec laser `T6`.

## Where it goes

One row per run on the laser board (re-sending the same run # updates its
row): Date | Laser Run # | Sheets | Sheet Type | ... | Part Numbers | DATA |
RAW DATA. Part Numbers is the readable list; DATA is a `laser=T6 | size=...`
summary; RAW DATA is the full JSON for the dashboard. Status / Rush / Time /
Notes are left for the floor, and cells the board computes with formulas are
never overwritten. A mislogged run can be cleared by POSTing
`{"action":"laserDelete","runNumber":"25223"}` to the web app.
