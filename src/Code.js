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
  MAX_RUNS: 2000
};

var JOBS_HEADER = ['Job Name', 'Sheets to Cut', 'Start Date', 'Active', 'Pieces (JSON)'];

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

    if (p.action === 'setup') {
      // One-time: sets the edit PIN if none exists yet.
      var props = PropertiesService.getScriptProperties();
      if (props.getProperty('EDIT_KEY')) throw new Error('Edit PIN is already set.');
      if (!p.key || String(p.key).length < 4) throw new Error('PIN too short.');
      props.setProperty('EDIT_KEY', String(p.key));
      return { ok: true };
    }

    requireKey(p.key);
    if (p.action === 'saveJob') return saveJob(p.job);
    if (p.action === 'stopJob') return stopJob(p.name);
    throw new Error('Unknown action: ' + p.action);
  } catch (err) {
    return { error: String((err && err.message) || err) };
  }
}

function requireKey(key) {
  var stored = PropertiesService.getScriptProperties().getProperty('EDIT_KEY');
  if (!stored) throw new Error('Editing is not set up yet.');
  if (String(key || '') !== stored) throw new Error('Wrong edit PIN.');
}

/* ---------- read ---------- */

function getData() {
  var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  var logSheet = ss.getSheetByName(CONFIG.LOG_SHEET_NAME);
  if (!logSheet) {
    throw new Error('Tab "' + CONFIG.LOG_SHEET_NAME + '" not found in the spreadsheet.');
  }

  return {
    runs: readRuns(logSheet),
    jobs: readJobs(ss),
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

/* ---------- tracked-job storage ---------- */

function jobsSheet(ss) {
  var sheet = ss.getSheetByName(CONFIG.JOBS_SHEET_NAME);
  if (sheet) return sheet;
  sheet = ss.insertSheet(CONFIG.JOBS_SHEET_NAME);
  sheet.getRange(1, 1, 1, JOBS_HEADER.length).setValues([JOBS_HEADER]).setFontWeight('bold');
  CONFIG.SEED_JOBS.forEach(function (j) {
    sheet.appendRow([j.name, j.target, j.startDate, j.active, JSON.stringify(j.pieces || [])]);
  });
  return sheet;
}

function readJobs(ss) {
  var values = jobsSheet(ss).getDataRange().getValues();
  var jobs = [];
  for (var r = 1; r < values.length; r++) {
    var name = String(values[r][0] || '').trim();
    if (!name) continue;
    var startDate = values[r][2];
    var pieces = [];
    try {
      pieces = JSON.parse(String(values[r][4] || '[]'));
      if (!Array.isArray(pieces)) pieces = [];
    } catch (err) { pieces = []; }
    jobs.push({
      name: name,
      target: Number(values[r][1]) || 0,
      startDate: startDate instanceof Date
        ? startDate.getFullYear() + '-' + pad2(startDate.getMonth() + 1) + '-' + pad2(startDate.getDate())
        : String(startDate || ''),
      active: values[r][3] === true || String(values[r][3]).toLowerCase() === 'true',
      pieces: pieces
    });
  }
  return jobs;
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
    if (size && qty > 0) pieces.push({ size: size, qty: qty });
  });

  var lock = LockService.getScriptLock();
  lock.waitLock(5000);
  try {
    var sheet = jobsSheet(SpreadsheetApp.openById(CONFIG.SHEET_ID));
    var rowData = [name, target, startDate, true, JSON.stringify(pieces)];
    var row = findJobRow(sheet, name);
    if (row) {
      sheet.getRange(row, 1, 1, rowData.length).setValues([rowData]);
    } else {
      sheet.appendRow(rowData);
    }
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
    var row = findJobRow(sheet, name);
    if (!row) throw new Error('Job not found: ' + name);
    sheet.getRange(row, 4).setValue(false);
  } finally {
    lock.releaseLock();
  }
  return { ok: true };
}

function findJobRow(sheet, name) {
  var values = sheet.getDataRange().getValues();
  for (var r = 1; r < values.length; r++) {
    if (String(values[r][0] || '').trim() === name) return r + 1;
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
