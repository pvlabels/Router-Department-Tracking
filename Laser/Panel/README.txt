LASER RUN LOGGER — Illustrator panel
=====================================

A dockable Illustrator panel that logs laser runs to the tracking board
with one click. Unlike the old script, it stays open — dock it once and
it's there every time Illustrator starts.

WHAT YOU NEED
-------------
  - Adobe Illustrator (2019 or newer)
  - Windows 10 or newer
  - Internet connection
No Google sign-in needed.

ONE-TIME INSTALL
----------------
  1. Unzip this folder anywhere.
  2. Double-click install.bat  (keep the com.pvlabels.laserlogger folder
     next to it). No admin rights needed.
  3. Restart Illustrator.
  4. Window > Extensions > Laser Run Logger.
  5. Drag the panel to dock it wherever you like — Illustrator remembers.

EVERY RUN
---------
  1. Open the laser run file (e.g. LR-25223-8.5X24-T6.ai).
  2. Click "Rescan" in the panel (it also scans automatically when the
     panel first opens).
  3. Check the fields — run #, date, sheets, color, size, laser, customer,
     work order, and every part number with its quantity.
     - Sheet color comes from the part number prefix:
       4/04 = Red with White text, 14 = Yellow with Black text,
       24 = Black with White text, 34 = White with Black text
     - Sheet size and laser # come from the file name.
  4. Fix anything that looks wrong, then click "Send to Sheet".
  5. Green message = logged. Re-sending the same run # updates its row —
     it never duplicates.

IF SOMETHING'S OFF
------------------
  - Panel not in the Extensions menu -> run install.bat again, restart
    Illustrator.
  - "No part numbers found" -> the text may be outlined; scan the working
    .ai file, not outlined art.
  - Red network error -> check the internet connection and hit Send again.
