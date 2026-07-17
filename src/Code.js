/**
 * Router Department Tracking — Apps Script backend.
 *
 * Reads the MultiCam run log and job-progress tables from the tracking
 * spreadsheet and serves the dashboard. Source of truth is the GitHub repo
 * (pushed via clasp).
 */

var CONFIG = {
  // https://docs.google.com/spreadsheets/d/<SHEET_ID>/edit
  SHEET_ID: '1532iOs5fdQxJQyeQUatdDDq5jIEVKLYdYh-tRfXkXIc',

  // Cap on deduped runs returned to the browser (most recent win).
  MAX_RUNS: 1500
};

// Google Sheets duration cells come back as Dates anchored to this epoch.
var DURATION_EPOCH = new Date(1899, 11, 30).getTime();

/** Entry point for the web app. */
function doGet() {
  return HtmlService.createTemplateFromFile('index')
    .evaluate()
    .setTitle('Router Department Tracking')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/**
 * Called from the browser via google.script.run.
 * Locates the run-log and progress tabs by their header signatures (robust to
 * tab renames/reordering), dedupes double-logged runs (same job + start time
 * appears twice; keep the longer entry), and returns JSON-safe data.
 */
function getData() {
  var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  var logSheet = null, progressSheet = null;

  ss.getSheets().forEach(function (sh) {
    if (sh.getLastRow() < 1) return;
    var head = sh.getRange(1, 1, 1, Math.min(12, sh.getMaxColumns()))
      .getValues()[0].map(function (v) { return String(v).trim(); });
    if (!logSheet && head.indexOf('Job Name') >= 0 && head.indexOf('Start Time') >= 0) logSheet = sh;
    if (!progressSheet && head.indexOf('Job File') >= 0 && head.indexOf('Target Runs') >= 0) progressSheet = sh;
  });

  if (!logSheet) {
    throw new Error('Could not find the run-log tab (looking for headers "Job Name" + "Start Time").');
  }

  return {
    runs: readRuns(logSheet),
    progress: progressSheet ? readProgress(progressSheet) : [],
    updatedAt: new Date().toISOString()
  };
}

function readRuns(sheet) {
  var values = sheet.getDataRange().getValues();
  var head = values[0].map(function (v) { return String(v).trim(); });
  var col = {
    start: head.indexOf('Start Time'),
    end: head.indexOf('End Time'),
    job: head.indexOf('Job Name'),
    total: head.indexOf('Total Time'),
    machine: head.indexOf('Machine'),
    status: head.indexOf('Status')
  };

  // Dedupe: the log records each run twice (same job + start time); keep the
  // entry with the longer duration.
  var byKey = {};
  for (var r = 1; r < values.length; r++) {
    var row = values[r];
    var job = String(row[col.job] || '').trim();
    if (!job) continue;
    var start = row[col.start];
    if (!(start instanceof Date)) continue;

    var seconds = toSeconds(row[col.total]);
    if (seconds === null && row[col.end] instanceof Date) {
      seconds = Math.round((row[col.end].getTime() - start.getTime()) / 1000);
    }

    var key = job + '|' + start.getTime();
    if (!byKey[key] || (seconds || 0) > byKey[key].seconds) {
      byKey[key] = {
        start: start.toISOString(),
        job: job,
        seconds: seconds || 0,
        machine: col.machine >= 0 ? String(row[col.machine] || '') : '',
        status: col.status >= 0 ? String(row[col.status] || '') : '',
        _t: start.getTime()
      };
    }
  }

  var runs = Object.keys(byKey).map(function (k) { return byKey[k]; });
  runs.sort(function (a, b) { return a._t - b._t; });
  if (runs.length > CONFIG.MAX_RUNS) runs = runs.slice(runs.length - CONFIG.MAX_RUNS);
  runs.forEach(function (r) { delete r._t; });
  return runs;
}

function readProgress(sheet) {
  var values = sheet.getDataRange().getValues();
  var head = values[0].map(function (v) { return String(v).trim(); });
  var col = {
    job: head.indexOf('Job File'),
    startDate: head.indexOf('Start Date'),
    target: head.indexOf('Target Runs'),
    completed: head.indexOf('Completed'),
    pct: head.indexOf('%'),
    avg: head.indexOf('Avg Run Time'),
    left: head.indexOf('Machine Time Left'),
    finish: head.indexOf('Est. Finish')
  };

  var out = [];
  for (var r = 1; r < values.length; r++) {
    var row = values[r];
    var job = String(row[col.job] || '').trim();
    if (!job) continue;
    var pct = row[col.pct];
    if (typeof pct === 'number') pct = pct <= 1 ? pct * 100 : pct;
    else pct = parseFloat(String(pct).replace('%', '')) || null;

    out.push({
      job: job,
      target: Number(row[col.target]) || null,
      completed: Number(row[col.completed]) || 0,
      pct: pct,
      avgSeconds: toSeconds(row[col.avg]),
      leftSeconds: toSeconds(row[col.left]),
      estFinish: row[col.finish] instanceof Date
        ? row[col.finish].toISOString()
        : String(row[col.finish] || '')
    });
  }
  return out;
}

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
