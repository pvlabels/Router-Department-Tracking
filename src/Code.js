/**
 * Router Department Tracking — Apps Script backend.
 *
 * Reads run history from the "Job Log" tab (read-only; all other pre-existing
 * tabs are ignored) and stores dashboard-managed job tracking in its own
 * "Dashboard Jobs" tab. Serves the dashboard page, a JSON read endpoint, and
 * a PIN-protected write API. Source of truth for code is the GitHub repo.
 */

var CONFIG = {
  // https://docs.google.com/spreadsheets/d/<SHEET_ID>/edit
  SHEET_ID: '1532iOs5fdQxJQyeQUatdDDq5jIEVKLYdYh-tRfXkXIc',

  // The only pre-existing tab the dashboard reads.
  LOG_SHEET_NAME: 'Job Log',

  // Tab owned by the dashboard for tracked-job config (auto-created).
  JOBS_SHEET_NAME: 'Dashboard Jobs',

  // Seeded into the Dashboard Jobs tab when it is first created.
  SEED_JOBS: [
    { name: 'PS-24x18-18x12.cnc', target: 96, startDate: '2026-07-10', pieces: [], active: true }
  ],

  // Cap on deduped runs returned to the browser (most recent win).
  MAX_RUNS: 2000,

  // "Live Production Copy" — schedule sheet that feeds the queue automatically.
  // B = Run #, C = Sheets, E = Status, G = Notes, I = Cutting Shapes.
  PROD_SHEET_ID: '1E0C4hanKBmYCrZw1V8DcknU60UxFtXAqMF48_XpDTik',
  PROD_SHEET_GID: 0,
  PROD_START_ROW: 2182,
  PROD_GO_STATUS: 'on-press',            // "we are a go" — adds to the queue
  PROD_PRINTED_STATUS: 'finished printing', // printed, still needs cutting — stays queued
  PROD_DONE_STATUS: 'finished cutting',  // removes from the queue
  PROD_MACHINE: 'multicam',              // column I must contain this (case-insensitive)
  PROD_SYNC_MINUTES: 2,                  // how often the schedule is re-read
  // Run 7881 is cut as TR-7881.cnc, so progress can be read straight from the
  // Job Log (numeric revisions like TR-7881-02.cnc are picked up automatically).
  PROD_CUT_PREFIX: 'TR-',
  PROD_CUT_EXT: '.cnc'
};

var JOBS_HEADER = ['Job Name', 'Sheets to Cut', 'Start Date', 'Active', 'Pieces (JSON)',
                   'Notes', 'Cut File', 'Source', 'Work Orders'];

// Google Sheets duration cells come back as Dates anchored to this epoch.
var DURATION_EPOCH = new Date(1899, 11, 30).getTime();

/* ---------- entry points ---------- */

/** Serves the dashboard, or bare JSON for the GitHub Pages front-end (?format=json). */
function doGet(e) {
  if (e && e.parameter && e.parameter.format === 'json') {
    var out;
    try {
      out = getData();
    } catch (err) {
      out = { error: String((err && err.message) || err) };
    }
    return ContentService.createTextOutput(JSON.stringify(out))
      .setMimeType(ContentService.MimeType.JSON);
  }
  return HtmlService.createTemplateFromFile('index')
    .evaluate()
    .setTitle('Router Department Tracking')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/** Write API. Body is JSON (sent as text/plain to avoid a CORS preflight). */
function doPost(e) {
  var payload = null;
  try {
    payload = JSON.parse(e.postData.contents);
  } catch (err) {
    payload = null;
  }
  return ContentService.createTextOutput(JSON.stringify(handleAction(payload)))
    .setMimeType(ContentService.MimeType.JSON);
}

/** Same write API for the Apps Script-served page (google.script.run). */
function apiCall(payload) {
  return handleAction(payload);
}

/* ---------- API routing ---------- */

function handleAction(p) {
  try {
    if (!p || !p.action) throw new Error('Missing action.');
    if (p.action === 'saveJob') return saveJob(p.job);
    if (p.action === 'stopJob') return stopJob(p.name);
    if (p.action === 'reorderJobs') return reorderJobs(p.order);
    if (p.action === 'setComplete') return setComplete(p.name, p.on);
    throw new Error('Unknown action: ' + p.action);
  } catch (err) {
    return { error: String((err && err.message) || err) };
  }
}

/* ---------- read ---------- */

function getData() {
  // Keep the queue in step with the production schedule (throttled, best-effort:
  // a schedule hiccup must never take the dashboard down).
  try { syncProductionThrottled(); } catch (err) { /* surfaced via syncStatus below */ }

  var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  var logSheet = ss.getSheetByName(CONFIG.LOG_SHEET_NAME);
  if (!logSheet) {
    throw new Error('Tab "' + CONFIG.LOG_SHEET_NAME + '" not found in the spreadsheet.');
  }

  var log = readLog(logSheet);
  return {
    runs: log.runs,
    daily: log.daily,
    machines: log.machines,
    jobs: readJobs(ss),
    updatedAt: new Date().toISOString()
  };
}

/**
 * Reads and dedupes the Job Log, returning:
 *   runs  — the most recent CONFIG.MAX_RUNS deduped runs (for job cards/table)
 *   daily — per-day, per-job aggregates over the ENTIRE log, so the Summary
 *           page stays accurate for month/year periods without shipping every
 *           row. Shape: { "YYYY-MM-DD": { "<job>": { r: runs, s: seconds } } }
 */
function readLog(sheet) {
  var values = sheet.getDataRange().getValues();
  if (values.length < 2) return { runs: [], daily: {} };
  var head = values[0].map(function (v) { return String(v).trim(); });
  var col = {
    start: head.indexOf('Start Time'),
    end: head.indexOf('End Time'),
    job: head.indexOf('Job Name'),
    total: head.indexOf('Total Time'),
    machine: head.indexOf('Machine'),
    status: head.indexOf('Status')
  };
  if (col.start < 0 || col.job < 0) {
    throw new Error('Tab "' + CONFIG.LOG_SHEET_NAME + '" is missing the "Start Time" / "Job Name" columns.');
  }

  // Dedupe double-logged runs (same job + start time), keeping the longer
  // entry. Durations are End − Start; the logger's Total Time column is
  // unreliable (sometimes written with a fixed +3h offset).
  var byKey = {};
  for (var r = 1; r < values.length; r++) {
    var row = values[r];
    var job = String(row[col.job] || '').trim();
    if (!job) continue;
    var start = row[col.start];
    if (!(start instanceof Date)) continue;

    var seconds = null;
    if (col.end >= 0 && row[col.end] instanceof Date) {
      seconds = Math.round((row[col.end].getTime() - start.getTime()) / 1000);
    }
    if (seconds === null || seconds < 0) {
      seconds = toSeconds(col.total >= 0 ? row[col.total] : null);
    }

    var key = job + '|' + start.getTime();
    if (!byKey[key] || (seconds || 0) > byKey[key].seconds) {
      byKey[key] = {
        start: start.toISOString(),
        job: job,
        seconds: seconds || 0,
        machine: col.machine >= 0 ? String(row[col.machine] || '') : '',
        status: col.status >= 0 ? String(row[col.status] || '') : '',
        _t: start.getTime(),
        _d: dayKeyLocal(start)
      };
    }
  }

  var all = Object.keys(byKey).map(function (k) { return byKey[k]; });
  all.sort(function (a, b) { return a._t - b._t; });

  // Full-history daily aggregates, nested by machine so the dashboard can
  // filter summaries to one machine: daily[day][machine][job] = {r, s}.
  var daily = {}, machineSet = {};
  all.forEach(function (run) {
    var mach = run.machine || 'Unknown';
    machineSet[mach] = true;
    var day = daily[run._d] || (daily[run._d] = {});
    var m = day[mach] || (day[mach] = {});
    var agg = m[run.job] || (m[run.job] = { r: 0, s: 0 });
    agg.r += 1;
    agg.s += run.seconds;
  });

  // Capped runs list for the cards/table.
  var runs = all.slice(all.length > CONFIG.MAX_RUNS ? all.length - CONFIG.MAX_RUNS : 0);
  runs.forEach(function (r) { delete r._t; delete r._d; });

  return { runs: runs, daily: daily, machines: Object.keys(machineSet).sort() };
}

/** Local-time YYYY-MM-DD for a Date (the spreadsheet's timezone). */
function dayKeyLocal(d) {
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

/* ---------- tracked-job storage ---------- */

function jobsSheet(ss) {
  var sheet = ss.getSheetByName(CONFIG.JOBS_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(CONFIG.JOBS_SHEET_NAME);
    sheet.getRange(1, 1, 1, JOBS_HEADER.length).setValues([JOBS_HEADER]).setFontWeight('bold');
    CONFIG.SEED_JOBS.forEach(function (j) {
      sheet.appendRow([j.name, j.target, j.startDate, j.active, JSON.stringify(j.pieces || [])]);
    });
    return sheet;
  }
  // Add any columns this version expects that the existing tab doesn't have yet.
  var width = Math.max(sheet.getLastColumn(), 1);
  var head = sheet.getRange(1, 1, 1, width).getValues()[0].map(function (v) { return String(v).trim(); });
  var grew = false;
  JOBS_HEADER.forEach(function (h) { if (head.indexOf(h) < 0) { head.push(h); grew = true; } });
  if (grew) sheet.getRange(1, 1, 1, head.length).setValues([head]).setFontWeight('bold');
  return sheet;
}

/** header name -> 0-based column index */
function jobsCols(sheet) {
  var width = Math.max(sheet.getLastColumn(), JOBS_HEADER.length);
  var head = sheet.getRange(1, 1, 1, width).getValues()[0];
  var map = {};
  head.forEach(function (h, i) { h = String(h).trim(); if (h) map[h] = i; });
  return map;
}

function readJobs(ss) {
  var sheet = jobsSheet(ss);
  var col = jobsCols(sheet);
  var values = sheet.getDataRange().getValues();
  var cell = function (row, header) {
    var i = col[header];
    return (i === undefined || i >= row.length) ? '' : row[i];
  };
  var jobs = [];
  for (var r = 1; r < values.length; r++) {
    var name = String(cell(values[r], 'Job Name') || '').trim();
    if (!name) continue;
    var startDate = cell(values[r], 'Start Date');
    var parsedPieces = parsePieces(cell(values[r], 'Pieces (JSON)'));
    var act = cell(values[r], 'Active');
    jobs.push({
      name: name,
      target: Number(cell(values[r], 'Sheets to Cut')) || 0,
      startDate: startDate instanceof Date
        ? startDate.getFullYear() + '-' + pad2(startDate.getMonth() + 1) + '-' + pad2(startDate.getDate())
        : String(startDate || ''),
      active: act === true || String(act).toLowerCase() === 'true',
      pieces: parsedPieces.pieces,
      baseSheets: parsedPieces.baseSheets,
      notes: String(cell(values[r], 'Notes') || '').trim(),
      cutFile: String(cell(values[r], 'Cut File') || '').trim(),
      source: String(cell(values[r], 'Source') || '').trim(),
      workOrders: String(cell(values[r], 'Work Orders') || '').trim()
    });
  }

  // Attach queue order + a stable color index (0–7) from Script Properties.
  // Backfill any job missing metadata (once) so legacy jobs get assigned.
  var meta = getJobMeta();
  var missing = jobs.filter(function (j) { return !meta[j.name]; });
  if (missing.length) {
    var lock = LockService.getScriptLock();
    if (lock.tryLock(5000)) {
      try {
        meta = getJobMeta();                              // re-read under lock
        var maxOrder = -1, used = {};
        for (var k in meta) { maxOrder = Math.max(maxOrder, meta[k].o); used[meta[k].c] = true; }
        jobs.forEach(function (j) {
          if (meta[j.name]) return;
          meta[j.name] = { o: ++maxOrder, c: nextColor(used) };
          used[meta[j.name].c] = true;
        });
        setJobMeta(meta);
      } finally {
        lock.releaseLock();
      }
    }
  }

  jobs.forEach(function (j) {
    var m = meta[j.name] || { o: 9999, c: 0 };
    j.order = m.o;
    j.color = m.c;
    j.finishedAt = m.f || '';     // set = job is done and belongs in the Finished log
    j.noAutoFinish = !!m.x;       // reopened by hand — don't auto-finish it again
  });
  jobs.sort(function (a, b) { return a.order - b.order; });
  return jobs;
}

/* ---- job metadata (queue order + color), stored in Script Properties ---- */

function getJobMeta() {
  var raw = PropertiesService.getScriptProperties().getProperty('JOB_META');
  if (!raw) return {};
  try { return JSON.parse(raw) || {}; } catch (err) { return {}; }
}
function setJobMeta(meta) {
  PropertiesService.getScriptProperties().setProperty('JOB_META', JSON.stringify(meta));
}
/** Lowest palette index 0–7 not already in `used`; wraps once all are taken. */
function nextColor(used) {
  for (var i = 0; i < 8; i++) { if (!used[i]) return i; }
  var n = 0; for (var k in used) n++;
  return n % 8;
}

/**
 * Parses the Pieces (JSON) cell, supporting both the legacy array form
 * [{size,qty}] and the current object form {pieces:[{size,qty,cut}], baseSheets}.
 * `cut` is the count of pieces already produced as of `baseSheets` sheets; the
 * per-sheet `qty` applies to sheets cut beyond that point (so updating the yield
 * mid-run never rewrites what was already cut).
 */
function parsePieces(cell) {
  var pieces = [], baseSheets = 0;
  try {
    var parsed = JSON.parse(String(cell || '[]'));
    if (Array.isArray(parsed)) {
      pieces = parsed;                                   // legacy
    } else if (parsed && Array.isArray(parsed.pieces)) {
      pieces = parsed.pieces;
      baseSheets = Number(parsed.baseSheets) || 0;
    }
  } catch (err) { pieces = []; }
  pieces = pieces.map(function (p) {
    return { size: String((p && p.size) || '').trim(), qty: Number(p && p.qty) || 0, cut: Math.max(0, Number(p && p.cut) || 0) };
  }).filter(function (p) { return p.size && p.qty > 0; });
  return { pieces: pieces, baseSheets: Math.max(0, baseSheets) };
}

function saveJob(job) {
  if (!job || !String(job.name || '').trim()) throw new Error('Job name is required.');
  var name = String(job.name).trim().slice(0, 200);
  var target = Math.round(Number(job.target));
  if (!(target > 0)) throw new Error('Sheets to cut must be a positive number.');
  var startDate = String(job.startDate || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate)) throw new Error('Start date must be YYYY-MM-DD.');
  var pieces = [];
  (Array.isArray(job.pieces) ? job.pieces : []).forEach(function (p) {
    var size = String((p && p.size) || '').trim().slice(0, 60);
    var qty = Math.round(Number(p && p.qty));
    var cut = Math.max(0, Math.round(Number(p && p.cut) || 0));
    if (size && qty > 0) pieces.push({ size: size, qty: qty, cut: cut });
  });
  // Sheets already cut when this yield takes effect; pieces cut before it are
  // preserved via each piece's `cut`, and `qty` applies only to sheets beyond it.
  var baseSheets = Math.max(0, Math.round(Number(job.baseSheets) || 0));

  var lock = LockService.getScriptLock();
  lock.waitLock(5000);
  try {
    var sheet = jobsSheet(SpreadsheetApp.openById(CONFIG.SHEET_ID));
    var col = jobsCols(sheet);
    var row = findJobRow(sheet, name);
    var fields = {
      'Job Name': name, 'Sheets to Cut': target, 'Start Date': startDate, 'Active': true,
      'Pieces (JSON)': JSON.stringify({ pieces: pieces, baseSheets: baseSheets })
    };
    // notes / cut file are optional and only overwritten when supplied
    if (job.notes !== undefined) fields['Notes'] = String(job.notes).slice(0, 500);
    if (job.cutFile !== undefined) fields['Cut File'] = String(job.cutFile).trim().slice(0, 200);
    writeJobFields(sheet, col, row, fields);
    // New job: assign a queue slot at the end and a distinct color.
    var meta = getJobMeta();
    if (!meta[name]) {
      var maxOrder = -1, used = {};
      for (var k in meta) { maxOrder = Math.max(maxOrder, meta[k].o); used[meta[k].c] = true; }
      meta[name] = { o: maxOrder + 1, c: nextColor(used) };
      setJobMeta(meta);
    }
  } finally {
    lock.releaseLock();
  }
  return { ok: true };
}

/** Adds or removes a job from the Weekly activity chart (stored in job meta). */
/** Rewrites queue order from an array of job names (index = position). */
function reorderJobs(order) {
  if (!Array.isArray(order)) throw new Error('order must be an array of job names.');
  var lock = LockService.getScriptLock();
  lock.waitLock(5000);
  try {
    var meta = getJobMeta();
    order.forEach(function (name, i) {
      name = String(name || '').trim();
      if (!name) return;
      if (!meta[name]) meta[name] = { o: i, c: nextColor({}) };
      else meta[name].o = i;
    });
    setJobMeta(meta);
  } finally {
    lock.releaseLock();
  }
  return { ok: true };
}

function stopJob(name) {
  name = String(name || '').trim();
  if (!name) throw new Error('Job name is required.');

  var lock = LockService.getScriptLock();
  lock.waitLock(5000);
  try {
    var sheet = jobsSheet(SpreadsheetApp.openById(CONFIG.SHEET_ID));
    var col = jobsCols(sheet);
    var row = findJobRow(sheet, name);
    if (!row) throw new Error('Job not found: ' + name);
    sheet.getRange(row, col['Active'] + 1).setValue(false);
  } finally {
    lock.releaseLock();
  }
  return { ok: true };
}

/* ---------- production schedule sync ---------- */

/**
 * Pulls the queue from the "Live Production Copy" schedule.
 *
 * A run joins the queue when it is a MultiCam job (col I) that has reached the
 * press — status (col E) "On-Press" or "Finished Printing", i.e. printing or
 * printed but not yet cut — and leaves when col E reads "Finished Cutting".
 * Title is the Run # (col B), sheet target is col C, notes are col G.
 *
 * Only rows from PROD_START_ROW down are considered, and only jobs this sync
 * created (Source = production) are ever touched — manual jobs are left alone.
 * A production job the user manually stops is not resurrected; it only returns
 * if it disappears and reappears in the schedule.
 */
function syncProductionQueue() {
  var added = 0, removed = 0, updated = 0;
  var prod = SpreadsheetApp.openById(CONFIG.PROD_SHEET_ID);
  var psheet = prod.getSheets().filter(function (s) { return s.getSheetId() === CONFIG.PROD_SHEET_GID; })[0]
            || prod.getSheets()[0];
  var last = psheet.getLastRow();
  if (last < CONFIG.PROD_START_ROW) return { added: 0, removed: 0, updated: 0 };
  // A..M — M (index 12) is Item 1's Part #, which carries the work order numbers
  var rows = psheet.getRange(CONFIG.PROD_START_ROW, 1, last - CONFIG.PROD_START_ROW + 1, 13).getValues();

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(8000)) return { skipped: 'busy' };
  try {
    var sheet = jobsSheet(SpreadsheetApp.openById(CONFIG.SHEET_ID));
    var col = jobsCols(sheet);
    var values = sheet.getDataRange().getValues();
    var existing = {};                                  // run # -> {row, active, source}
    for (var r = 1; r < values.length; r++) {
      var nm = String(values[r][col['Job Name']] || '').trim();
      if (!nm) continue;
      existing[nm] = {
        row: r + 1,
        active: values[r][col['Active']] === true || String(values[r][col['Active']]).toLowerCase() === 'true',
        source: String(values[r][col['Source']] || '').trim()
      };
    }

    rows.forEach(function (row) {
      var runNo = String(row[1] === null || row[1] === undefined ? '' : row[1]).trim();  // B
      if (!runNo) return;
      var shapes = String(row[8] || '').toLowerCase();                                    // I
      if (shapes.indexOf(CONFIG.PROD_MACHINE) < 0) return;                                // MultiCam only
      var status = String(row[4] || '').trim().toLowerCase();                             // E
      var have = existing[runNo];

      if (status === CONFIG.PROD_DONE_STATUS) {
        if (have && have.source === 'production' && have.active) {
          sheet.getRange(have.row, col['Active'] + 1).setValue(false);
          // The schedule finishing a run is a completion, not an abandonment —
          // stamp it so it shows up in the Finished log like a manual one.
          var doneMeta = getJobMeta();
          if (!doneMeta[runNo]) doneMeta[runNo] = { o: 9999, c: nextColor({}) };
          if (!doneMeta[runNo].f) { doneMeta[runNo].f = new Date().toISOString(); setJobMeta(doneMeta); }
          removed++;
        }
        return;
      }
      if (status !== CONFIG.PROD_GO_STATUS && status !== CONFIG.PROD_PRINTED_STATUS) return;

      var notes = String(row[6] || '').trim();                                            // G
      var workOrders = String(row[12] || '').trim();                                      // M
      var sheetsQty = Math.round(Number(row[2])) || 0;                                    // C
      var when = row[0] instanceof Date
        ? row[0].getFullYear() + '-' + pad2(row[0].getMonth() + 1) + '-' + pad2(row[0].getDate())
        : dayKeyLocal(new Date());                                                        // A

      var cutFile = CONFIG.PROD_CUT_PREFIX + runNo + CONFIG.PROD_CUT_EXT;

      if (!have) {
        writeJobFields(sheet, col, 0, {
          'Job Name': runNo, 'Sheets to Cut': sheetsQty, 'Start Date': when, 'Active': true,
          'Pieces (JSON)': JSON.stringify({ pieces: [], baseSheets: 0 }),
          'Notes': notes, 'Cut File': cutFile, 'Source': 'production', 'Work Orders': workOrders
        });
        var meta = getJobMeta();
        if (!meta[runNo]) {
          var maxOrder = -1, used = {};
          for (var k in meta) { maxOrder = Math.max(maxOrder, meta[k].o); used[meta[k].c] = true; }
          meta[runNo] = { o: maxOrder + 1, c: nextColor(used) };
          setJobMeta(meta);
        }
        added++;
      } else if (have.source === 'production') {
        // keep notes / target fresh, but never force a manually stopped job back on
        var cur = sheet.getRange(have.row, 1, 1, Math.max(sheet.getLastColumn(), JOBS_HEADER.length)).getValues()[0];
        var curCut = String(cur[col['Cut File']] || '').trim();
        if (String(cur[col['Notes']] || '') !== notes ||
            Number(cur[col['Sheets to Cut']]) !== sheetsQty || !curCut ||
            String(cur[col['Work Orders']] || '').trim() !== workOrders) {
          cur[col['Notes']] = notes;
          cur[col['Sheets to Cut']] = sheetsQty;
          cur[col['Work Orders']] = workOrders;
          if (!curCut) cur[col['Cut File']] = cutFile;   // backfill the cut-file link
          sheet.getRange(have.row, 1, 1, cur.length).setValues([cur]);
          updated++;
        }
      }
    });
  } finally {
    lock.releaseLock();
  }
  return { added: added, removed: removed, updated: updated };
}

/** Runs the schedule sync at most once every PROD_SYNC_MINUTES. */
function syncProductionThrottled() {
  var props = PropertiesService.getScriptProperties();
  var lastRun = Number(props.getProperty('PROD_SYNC_AT') || 0);
  var now = Date.now();
  if (now - lastRun < CONFIG.PROD_SYNC_MINUTES * 60 * 1000) return null;
  props.setProperty('PROD_SYNC_AT', String(now));
  return syncProductionQueue();
}

/** Writes named fields to an existing row, or appends a new row. */
function writeJobFields(sheet, col, row, fields) {
  var width = Math.max(sheet.getLastColumn(), JOBS_HEADER.length);
  if (row) {
    var current = sheet.getRange(row, 1, 1, width).getValues()[0];
    for (var h in fields) { if (col[h] !== undefined) current[col[h]] = fields[h]; }
    sheet.getRange(row, 1, 1, width).setValues([current]);
  } else {
    var fresh = [];
    for (var i = 0; i < width; i++) fresh.push('');
    for (var k in fields) { if (col[k] !== undefined) fresh[col[k]] = fields[k]; }
    sheet.appendRow(fresh);
  }
}

function findJobRow(sheet, name) {
  var col = jobsCols(sheet);
  var nameIdx = col['Job Name'] === undefined ? 0 : col['Job Name'];
  var values = sheet.getDataRange().getValues();
  for (var r = 1; r < values.length; r++) {
    if (String(values[r][nameIdx] || '').trim() === name) return r + 1;
  }
  return 0;
}

/* ---------- helpers ---------- */

function pad2(n) { return (n < 10 ? '0' : '') + n; }

/** Duration cell → whole seconds. Handles Date-typed durations (including >24h), "h:mm:ss" strings, and day-fraction numbers. */
function toSeconds(v) {
  if (v instanceof Date) return Math.round((v.getTime() - DURATION_EPOCH) / 1000);
  if (typeof v === 'number' && isFinite(v)) return Math.round(v * 86400);
  if (typeof v === 'string') {
    var m = v.trim().match(/^(\d+):(\d{1,2})(?::(\d{1,2}))?$/);
    if (m) return (+m[1]) * 3600 + (+m[2]) * 60 + (+(m[3] || 0));
  }
  return null;
}
