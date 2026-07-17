/**
 * Router Department Tracking — Apps Script backend.
 *
 * Reads run history from the "Job Log" tab (only — all other tabs are
 * ignored) and serves the job-progress dashboard. Source of truth is the
 * GitHub repo (pushed via clasp).
 */

var CONFIG = {
  // https://docs.google.com/spreadsheets/d/<SHEET_ID>/edit
  SHEET_ID: '1532iOs5fdQxJQyeQUatdDDq5jIEVKLYdYh-tRfXkXIc',

  // The only tab the dashboard reads.
  LOG_SHEET_NAME: 'Job Log',

  // Jobs to track on the dashboard. Edit this list (and git push) when a new
  // job starts: name must match the Job Name column exactly; startDate is the
  // first day whose runs count toward the target.
  JOBS: [
    { name: 'PS-24x18-18x12.cnc', target: 96, startDate: '2026-07-10' }
  ],

  // Cap on deduped runs returned to the browser (most recent win).
  MAX_RUNS: 2000
};

// Google Sheets duration cells come back as Dates anchored to this epoch.
var DURATION_EPOCH = new Date(1899, 11, 30).getTime();

/** Entry point for the web app. Serves the dashboard, or bare JSON for the
 * GitHub Pages front-end (?format=json). */
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

/**
 * Returns the deduped run history from the Job Log tab plus the tracked-job
 * config. Runs that are double-logged (same job + start time) keep the longer
 * entry; durations are End − Start (the logger's Total Time column is
 * unreliable — sometimes written with a fixed +3h offset).
 */
function getData() {
  var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  var sheet = ss.getSheetByName(CONFIG.LOG_SHEET_NAME);
  if (!sheet) {
    throw new Error('Tab "' + CONFIG.LOG_SHEET_NAME + '" not found in the spreadsheet.');
  }

  return {
    runs: readRuns(sheet),
    jobs: CONFIG.JOBS,
    updatedAt: new Date().toISOString()
  };
}

function readRuns(sheet) {
  var values = sheet.getDataRange().getValues();
  if (values.length < 2) return [];
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
