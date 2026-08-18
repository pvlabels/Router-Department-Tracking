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

  // The payload is expensive to build (three spreadsheets, six tabs), so one
  // build is shared by every open tab. FRESH_SECONDS is how long a build is
  // handed out without question; past that, the next request rebuilds it while
  // everyone else keeps getting the last good copy. CACHE_TTL is how long a
  // build stays usable as that fallback.
  PAYLOAD_FRESH_SECONDS: 90,
  PAYLOAD_CACHE_TTL: 900,

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
  PROD_CUT_EXT: '.cnc',

  // Production History: every MultiCam scheduled run from the board since this
  // date, mirrored into our own tab so Reports can show a full-year timeline
  // and customer/WO/part# attribution (the Job Log only has ~5 recent weeks and
  // no sheets/customer/WO). The board has no run durations, so hours still come
  // from the Job Log; history supplies run counts, sheet counts, and metadata.
  HISTORY_SHEET_NAME: 'Production History',
  HISTORY_SINCE: '2026-01-01',
  HISTORY_REFRESH_MINUTES: 60,

  // Laser run board (its own spreadsheet, hand-built). Two-row merged header:
  // Date | Laser Run # | Sheets | Sheet Type | Status | Rush | Time | Notes |
  // Part Numbers | DATA | RAW DATA (the last three titled on the lower band
  // row). The tab is found by scanning for the "Laser Run #" header. Rows are
  // upserted by the Illustrator "Log Laser Run" script via the laserLog action.
  LASER_SHEET_ID: '1E-ID5GrIyq9jZHDsCgAFt-8XkT2YohRjYdCI6b68GPU',
  // Status the floor sets when a run leaves the laser queue for the log.
  LASER_DONE_STATUS: 'Post Production',
  LASER_DEFAULT_STATUS: 'On Laser'
};

var JOBS_HEADER = ['Job Name', 'Sheets to Cut', 'Start Date', 'Active', 'Pieces (JSON)',
                   'Notes', 'Cut File', 'Source', 'Work Orders', 'Label', 'Status', 'Size', 'Qty'];
var HISTORY_HEADER = ['Run #', 'Date', 'Sheets', 'Notes', 'Work Orders', 'Size'];

// Google Sheets duration cells come back as Dates anchored to this epoch.
var DURATION_EPOCH = new Date(1899, 11, 30).getTime();

/* ---------- entry points ---------- */

/** Serves the dashboard, or bare JSON for the GitHub Pages front-end (?format=json). */
function doGet(e) {
  if (e && e.parameter && e.parameter.format === 'json') {
    var out;
    try {
      // Served from the shared cache. "have" is the hash the caller already
      // holds, so a poll with nothing new to learn gets a few bytes back.
      out = servePayload(e.parameter.have);
    } catch (err) {
      // Errors are never cached — the next request gets a real attempt.
      out = JSON.stringify({ error: String((err && err.message) || err) });
    }
    return ContentService.createTextOutput(out)
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
    // Windows tools sometimes prepend a UTF-8 BOM, which JSON.parse rejects.
    payload = JSON.parse(String(e.postData.contents || '').replace(/^\uFEFF/, ''));
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

// Everything that changes what the board shows, so the cached payload has to
// go. Listed here rather than busted inside each branch, so a new action can't
// quietly forget to.
var MUTATING_ACTIONS = {
  saveJob: 1, stopJob: 1, reorderJobs: 1, setComplete: 1, backfillHistory: 1,
  laserLog: 1, laserDelete: 1, reorderLaser: 1, laserComplete: 1
};

function handleAction(p) {
  try {
    if (!p || !p.action) throw new Error('Missing action.');
    try {
      return dispatchAction(p);
    } finally {
      // Bust even when the action threw. A write that failed partway through
      // may still have changed the board, and a needless rebuild costs far
      // less than showing the floor a queue that has moved on without it.
      if (MUTATING_ACTIONS[p.action]) bustPayloadCache();
    }
  } catch (err) {
    return { error: String((err && err.message) || err) };
  }
}

function dispatchAction(p) {
  if (p.action === 'saveJob') return saveJob(p.job);
  if (p.action === 'stopJob') return stopJob(p.name);
  if (p.action === 'reorderJobs') return reorderJobs(p.order);
  if (p.action === 'setComplete') return setComplete(p.name, p.on, p.sheets);
  if (p.action === 'backfillHistory') return backfillProductionHistory();
  if (p.action === 'laserLog') return logLaserRun(p.run);
  if (p.action === 'laserDelete') return deleteLaserRun(p.runNumber);
  if (p.action === 'reorderLaser') return reorderLaser(p.order);
  if (p.action === 'laserComplete') return setLaserComplete(p.runNumber, p.on);
  throw new Error('Unknown action: ' + p.action);
}

/* ---------- payload cache ---------- */

/*
 * Building the payload means reading three spreadsheets and six tabs — around
 * seven seconds of script runtime. Paying that on every 60-second poll of every
 * open tab made the board's cost scale with how many people had it open, which
 * is what pushed it up against the daily Apps Script runtime quota.
 *
 * So one build is shared. It is handed out as-is while it is fresh; once it
 * ages past PAYLOAD_FRESH_SECONDS the next request through the door rebuilds it
 * while everyone else keeps getting the last good copy, so nobody waits behind
 * a rebuild. Writes drop the cache outright, so anything the floor does on the
 * board shows up on the very next poll.
 */

var CACHE_META_KEY = 'payload_meta';
var CACHE_CHUNK_PREFIX = 'payload_';
// CacheService caps one value at 100 KB. That limit is bytes and this is
// characters, so leave room for the multi-byte ones in customer and note text.
var CACHE_CHUNK_CHARS = 80000;

/** The cached build, or null if it is missing, expired or torn. */
function cacheReadPayload() {
  var meta = cacheReadMeta();
  if (!meta) return null;

  var keys = [];
  for (var i = 0; i < meta.chunks; i++) keys.push(CACHE_CHUNK_PREFIX + meta.hash + '_' + i);
  var got = CacheService.getScriptCache().getAll(keys);

  var parts = [];
  for (var j = 0; j < keys.length; j++) {
    var piece = got[keys[j]];
    if (piece === null || piece === undefined) return null;   // a chunk expired out from under us
    parts.push(piece);
  }
  var json = parts.join('');
  if (json.length !== meta.len) return null;                  // torn read — rebuild rather than serve half a board
  return { json: json, hash: meta.hash, builtAt: meta.builtAt };
}

function cacheReadMeta() {
  var raw;
  try { raw = CacheService.getScriptCache().get(CACHE_META_KEY); } catch (err) { return null; }
  var meta;
  try { meta = JSON.parse(raw || 'null'); } catch (err) { return null; }
  return (meta && meta.hash && meta.chunks) ? meta : null;
}

/**
 * Stores a build. Chunks are keyed by content hash, so a reader can never pair
 * the manifest of one build with the chunks of another.
 */
function cacheWritePayload(json, hash, builtAt, laserRows) {
  var cache = CacheService.getScriptCache();
  var chunks = {}, n = 0;
  for (var pos = 0; pos < json.length; pos += CACHE_CHUNK_CHARS) {
    chunks[CACHE_CHUNK_PREFIX + hash + '_' + n] = json.slice(pos, pos + CACHE_CHUNK_CHARS);
    n++;
  }
  // Chunks first — the manifest is what makes them findable, so it lands last.
  cache.putAll(chunks, CONFIG.PAYLOAD_CACHE_TTL);
  cache.put(CACHE_META_KEY,
    JSON.stringify({ hash: hash, chunks: n, len: json.length, builtAt: builtAt, laserRows: laserRows || 0 }),
    CONFIG.PAYLOAD_CACHE_TTL);
}

/**
 * Drops the manifest, which orphans the chunks — they expire on their own.
 * Cheaper than removing each one, and it cannot leave a half-removed build
 * behind for the next reader to trip over.
 */
function bustPayloadCache() {
  try { CacheService.getScriptCache().remove(CACHE_META_KEY); } catch (err) { /* non-fatal */ }
}

/** Hex MD5 of the payload body — the "is this still what you have?" token. */
function payloadHash(body) {
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, body, Utilities.Charset.UTF_8);
  var hex = '';
  for (var i = 0; i < bytes.length; i++) {
    var b = (bytes[i] + 256) % 256;
    hex += (b < 16 ? '0' : '') + b.toString(16);
  }
  return hex;
}

/**
 * Builds, hashes and caches the payload.
 *
 * The hash covers the board's contents only. builtAt deliberately sits outside
 * it: it changes on every single build, so hashing it would mean the hash never
 * matched and every poll would ship the whole payload regardless.
 */
function rebuildPayloadCache() {
  var data = buildData();
  var builtAt = new Date().toISOString();
  var body = JSON.stringify(data);
  var hash = payloadHash(body);
  var envelope = '{"hash":' + JSON.stringify(hash) + ',"builtAt":' + JSON.stringify(builtAt);
  var json = body.length > 2 ? envelope + ',' + body.slice(1) : envelope + '}';

  // A laser board that failed to read comes back empty — buildData swallows the
  // error so the router side still loads. Caching that would blank both laser
  // views until the entry aged out, so leave the last good build standing and
  // let the next rebuild try again.
  var rows = (data.laser || []).length;
  var meta = cacheReadMeta();
  if (rows > 0 || !meta || !meta.laserRows) cacheWritePayload(json, hash, builtAt, rows);

  return { json: json, hash: hash, builtAt: builtAt };
}

/** Seconds since a build was made. */
function payloadAge(builtAt) {
  var t = Date.parse(builtAt);
  return isNaN(t) ? Infinity : (Date.now() - t) / 1000;
}

/** The few dozen bytes a caller gets back when it already holds this build. */
function unchangedBody(hash, builtAt) {
  return '{"unchanged":true,"hash":' + JSON.stringify(hash)
       + ',"builtAt":' + JSON.stringify(builtAt) + '}';
}

/** Either the short answer or the whole board, depending on what the caller has. */
function answerFor(have, hit) {
  return (have && have === hit.hash) ? unchangedBody(hit.hash, hit.builtAt) : hit.json;
}

/**
 * The JSON endpoint's body, as a string — never parsed and re-stringified on
 * the way through, which is most of the point of caching the serialised form.
 */
function servePayload(have) {
  var meta = cacheReadMeta();

  if (meta && payloadAge(meta.builtAt) <= CONFIG.PAYLOAD_FRESH_SECONDS) {
    // By far the common case: a poll that already holds the current build. The
    // manifest alone answers it, so don't reassemble three-quarters of a
    // megabyte of chunks just to throw the result away.
    if (have && have === meta.hash) return unchangedBody(meta.hash, meta.builtAt);
    var hit = cacheReadPayload();
    if (hit) return answerFor(have, hit);

  } else if (meta) {
    // Stale. One caller refreshes it; everyone else carries on with the copy
    // already cached rather than queueing behind a seven-second rebuild.
    var lock = LockService.getScriptLock();
    if (lock.tryLock(0)) {
      try {
        return answerFor(have, rebuildPayloadCache());
      } catch (err) {
        /* fall through to whatever is still cached */
      } finally {
        lock.releaseLock();
      }
    }
    var stale = cacheReadPayload();
    if (stale) return answerFor(have, stale);
  }

  return answerFor(have, rebuildPayloadColdStart());
}

/**
 * Nothing cached at all — someone has to build it. The lock stops a cold start,
 * or a cache just busted by a write, from turning into every open tab building
 * the same payload at once.
 */
function rebuildPayloadColdStart() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(45000)) {
    var late = cacheReadPayload();
    if (late) return late;
    throw new Error('The board is rebuilding — try again in a moment.');
  }
  try {
    var already = cacheReadPayload();   // whoever held the lock has probably just built it
    if (already) return already;
    return rebuildPayloadCache();
  } finally {
    lock.releaseLock();
  }
}

/**
 * Object form of the payload, for the Apps Script-served page
 * (google.script.run). The GitHub Pages front end goes through doGet instead.
 */
function getData() {
  return JSON.parse(servePayload(null));
}

/* ---------- read ---------- */

/**
 * Builds the whole payload from scratch. Only ever reached through the cache,
 * so the throttled side work below now runs for one caller at a time instead of
 * once per open tab.
 */
function buildData() {
  // Keep the queue and the full-year history in step with the board (both
  // throttled, best-effort: a schedule hiccup must never take the dashboard down).
  try { syncProductionThrottled(); } catch (err) { /* non-fatal */ }
  try { backfillHistoryThrottled(); } catch (err) { /* non-fatal */ }

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
    history: readHistory(ss),
    // The laser board is a separate spreadsheet the floor edits by hand; if it
    // is unreachable the router dashboard must still load.
    laser: (function () {
      try { return readLaserBoard(); } catch (err) { return []; }
    })()
    // No timestamp here on purpose. Anything that changes on every build would
    // change the content hash with it, so "is this still what you have?" would
    // always answer no and every poll would ship the whole board. The cache
    // stamps builtAt outside the hashed body instead.
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
      workOrders: String(cell(values[r], 'Work Orders') || '').trim(),
      // Display-only override; the row is still keyed by the real file name.
      label: String(cell(values[r], 'Label') || '').trim(),
      // Latest production-schedule status (col E), for the queue's status badge.
      schedStatus: String(cell(values[r], 'Status') || '').trim(),
      // Item 1 size from the schedule (col N), shown in the queue run info.
      size: String(cell(values[r], 'Size') || '').trim(),
      // Quantity on the sheet from the schedule (col H).
      qty: String(cell(values[r], 'Qty') || '').trim()
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
    if (job.label !== undefined) fields['Label'] = String(job.label).trim().slice(0, 120);
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

/**
 * Marks a job finished (or reopens it).
 *
 * Finishing stamps a timestamp in job meta and deactivates the sheet row, which
 * is what moves the job out of the queue and into the Finished log. The stamp is
 * what separates "we cut it" from a job that was simply switched off. It also
 * retargets the job to the sheets actually cut, so the log reads 12/12 rather
 * than 12/40; the original target is kept in meta.t so Reopen can restore it.
 */
function setComplete(name, on, sheetsCut) {
  name = String(name || '').trim();
  if (!name) throw new Error('Job name is required.');
  var lock = LockService.getScriptLock();
  lock.waitLock(5000);
  try {
    var sheet = jobsSheet(SpreadsheetApp.openById(CONFIG.SHEET_ID));
    var col = jobsCols(sheet);
    var row = findJobRow(sheet, name);
    if (!row) throw new Error('Job not found: ' + name);
    sheet.getRange(row, col['Active'] + 1).setValue(!on);

    var meta = getJobMeta();
    if (!meta[name]) meta[name] = { o: 9999, c: nextColor({}) };
    var targetCell = sheet.getRange(row, col['Sheets to Cut'] + 1);

    if (on) {
      meta[name].f = new Date().toISOString();
      delete meta[name].x;
      var cut = Math.round(Number(sheetsCut));
      if (isFinite(cut) && cut >= 0) {
        if (meta[name].t === undefined) meta[name].t = Number(targetCell.getValue()) || 0;
        targetCell.setValue(cut);
      }
    } else {
      // Reopening sets the new target the caller asked for (sheets already cut
      // plus however many are being added). Falling back to the pre-completion
      // target keeps older callers working. Either way `x` suppresses the
      // target-reached rule, or the job would drop straight back into the log.
      delete meta[name].f;
      meta[name].x = true;
      var newTarget = Math.round(Number(sheetsCut));
      if (isFinite(newTarget) && newTarget > 0) targetCell.setValue(newTarget);
      else if (meta[name].t !== undefined) targetCell.setValue(meta[name].t);
      delete meta[name].t;
    }
    setJobMeta(meta);
  } finally {
    lock.releaseLock();
  }
  return { ok: true };
}

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

/* ---------- production history (full-year backfill for Reports) ---------- */

/** The dashboard-owned tab holding mirrored production runs (auto-created). */
function historySheet(ss) {
  var sheet = ss.getSheetByName(CONFIG.HISTORY_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(CONFIG.HISTORY_SHEET_NAME);
    sheet.getRange(1, 1, 1, HISTORY_HEADER.length).setValues([HISTORY_HEADER]).setFontWeight('bold');
  }
  return sheet;
}

/**
 * Rebuilds Production History from the board: every MultiCam run (col I) with a
 * sane date on/after HISTORY_SINCE, one row per run #. The board has no
 * durations, so no time is stored — Reports pair these with Job Log seconds by
 * run # for the hours view. Full rewrite each time; keyed by run # so it's
 * idempotent. Returns how many rows were written.
 */
function backfillProductionHistory() {
  // Take the lock before the expensive read, not after it: whoever loses the
  // race should walk away now rather than read the whole board and then queue
  // behind the winner for fifteen seconds.
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(0)) return { skipped: 'busy' };
  try {
    return rewriteProductionHistory();
  } finally {
    lock.releaseLock();
  }
}

function rewriteProductionHistory() {
  var prod = SpreadsheetApp.openById(CONFIG.PROD_SHEET_ID);
  var psheet = prod.getSheets().filter(function (s) { return s.getSheetId() === CONFIG.PROD_SHEET_GID; })[0]
            || prod.getSheets()[0];
  var last = psheet.getLastRow();
  if (last < 2) return { rows: 0 };
  var vals = psheet.getRange(1, 1, last, 14).getValues();       // A..N
  var sm = String(CONFIG.HISTORY_SINCE).split('-');
  var since = new Date(+sm[0], +sm[1] - 1, +sm[2]);

  var byRun = {};                                               // run # -> row (later wins)
  for (var r = 1; r < vals.length; r++) {
    var row = vals[r], a = row[0];
    if (!(a instanceof Date) || a.getFullYear() < 2023 || a.getFullYear() > 2027) continue;  // skip typos
    if (a < since) continue;
    if (String(row[8] || '').toLowerCase().indexOf(CONFIG.PROD_MACHINE) < 0) continue;        // MultiCam only
    var runNo = String(row[1] == null ? '' : row[1]).trim();
    if (!runNo) continue;
    byRun[runNo] = [runNo,
      a.getFullYear() + '-' + pad2(a.getMonth() + 1) + '-' + pad2(a.getDate()),
      Math.round(Number(row[2])) || 0,                          // C sheets
      String(row[6] || '').trim(),                              // G notes (customer)
      String(row[12] || '').trim(),                             // M part #/WO
      String(row[13] || '').trim()];                            // N size
  }

  var out = Object.keys(byRun).map(function (k) { return byRun[k]; });
  out.sort(function (x, y) { return String(x[1]).localeCompare(String(y[1])); });

  var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  var sheet = historySheet(ss);
  if (sheet.getLastRow() > 1) sheet.getRange(2, 1, sheet.getLastRow() - 1, HISTORY_HEADER.length).clearContent();
  if (out.length) sheet.getRange(2, 1, out.length, HISTORY_HEADER.length).setValues(out);
  PropertiesService.getScriptProperties().setProperty('HISTORY_AT', String(Date.now()));
  return { rows: out.length };
}

/** Refresh Production History at most once every HISTORY_REFRESH_MINUTES. */
function backfillHistoryThrottled() {
  var props = PropertiesService.getScriptProperties();
  var lastRun = Number(props.getProperty('HISTORY_AT') || 0);
  var now = Date.now();
  if (now - lastRun < CONFIG.HISTORY_REFRESH_MINUTES * 60 * 1000) return null;
  // Stamp before the work, the way the schedule sync does, so a throw can't
  // leave every following request retrying the whole rebuild. The stamp is
  // backdated so a genuine failure retries in a couple of minutes instead of
  // waiting out the full hour; success overwrites it with the real time.
  props.setProperty('HISTORY_AT', String(now - (CONFIG.HISTORY_REFRESH_MINUTES - 2) * 60 * 1000));
  return backfillProductionHistory();
}

/** Production History rows for the browser: {run, date, sheets, notes, workOrders}. */
function readHistory(ss) {
  var sheet = ss.getSheetByName(CONFIG.HISTORY_SHEET_NAME);
  if (!sheet || sheet.getLastRow() < 2) return [];
  var vals = sheet.getRange(2, 1, sheet.getLastRow() - 1, HISTORY_HEADER.length).getValues();
  var out = [];
  vals.forEach(function (row) {
    var run = String(row[0] || '').trim();
    if (!run) return;
    var d = row[1];
    var date = d instanceof Date ? (d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate())) : String(d || '');
    out.push({ run: run, date: date, sheets: Number(row[2]) || 0,
      notes: String(row[3] || '').trim(), workOrders: String(row[4] || '').trim(),
      size: String(row[5] || '').trim() });
  });
  return out;
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
  // A..N — M (index 12) is Item 1's Part #, N (index 13) is its size
  var rows = psheet.getRange(CONFIG.PROD_START_ROW, 1, last - CONFIG.PROD_START_ROW + 1, 14).getValues();

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
      var statusRaw = String(row[4] || '').trim();                                        // E (original case)
      var status = statusRaw.toLowerCase();
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
      var size = String(row[13] || '').trim();                                            // N (Item 1 size)
      var qty = String(row[7] === null || row[7] === undefined ? '' : row[7]).trim();     // H (quantity on the sheet)
      var sheetsQty = Math.round(Number(row[2])) || 0;                                    // C
      var when = row[0] instanceof Date
        ? row[0].getFullYear() + '-' + pad2(row[0].getMonth() + 1) + '-' + pad2(row[0].getDate())
        : dayKeyLocal(new Date());                                                        // A

      var cutFile = CONFIG.PROD_CUT_PREFIX + runNo + CONFIG.PROD_CUT_EXT;

      if (!have) {
        writeJobFields(sheet, col, 0, {
          'Job Name': runNo, 'Sheets to Cut': sheetsQty, 'Start Date': when, 'Active': true,
          'Pieces (JSON)': JSON.stringify({ pieces: [], baseSheets: 0 }),
          'Notes': notes, 'Cut File': cutFile, 'Source': 'production', 'Work Orders': workOrders,
          'Status': statusRaw, 'Size': size, 'Qty': qty
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
            String(cur[col['Work Orders']] || '').trim() !== workOrders ||
            String(cur[col['Status']] || '').trim() !== statusRaw ||
            String(cur[col['Size']] || '').trim() !== size ||
            String(cur[col['Qty']] || '').trim() !== qty) {
          cur[col['Notes']] = notes;
          cur[col['Sheets to Cut']] = sheetsQty;
          cur[col['Work Orders']] = workOrders;
          cur[col['Status']] = statusRaw;
          cur[col['Size']] = size;
          cur[col['Qty']] = qty;
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

/* ---------- laser run intake ---------- */

/** Finds the laser board tab bearing a "Laser Run #" header. */
function laserTarget() {
  var ss = SpreadsheetApp.openById(CONFIG.LASER_SHEET_ID);
  var sheets = ss.getSheets();
  for (var i = 0; i < sheets.length; i++) {
    var lay = laserLayout(sheets[i]);
    if (lay) return { sheet: sheets[i], lay: lay };
  }
  throw new Error('No tab with a "Laser Run #" header found on the laser board.');
}

/**
 * Finds a sheet's header row (the one containing "Laser Run #") and maps
 * lowercased header name -> 0-based column. The header is a vertically merged
 * band and some titles (Part Numbers / DATA / RAW DATA) sit on its lower row,
 * so every row of the band contributes to the map and the first data row
 * comes from the merge span. Returns null if this isn't the laser tab.
 */
function laserLayout(sheet) {
  var rows = Math.max(1, Math.min(sheet.getLastRow(), 10));
  var width = Math.max(sheet.getLastColumn(), 11);
  var values = sheet.getRange(1, 1, rows, width).getValues();
  function rowMap(row, map) {
    row.forEach(function (h, i) {
      h = String(h).trim().toLowerCase();
      if (h && map[h] === undefined) map[h] = i;
    });
    return map;
  }
  for (var r = 0; r < values.length; r++) {
    var probe = rowMap(values[r], {});
    if (probe['laser run #'] === undefined) continue;
    var merges = sheet.getRange(r + 1, probe['laser run #'] + 1).getMergedRanges();
    var span = merges.length ? merges[0].getNumRows() : 1;
    var map = {};
    for (var b = r; b < Math.min(r + span, values.length); b++) rowMap(values[b], map);
    return { col: map, headerRow: r + 1, dataRow: r + 1 + span };
  }
  return null;
}

/** "07-28-2026" / "07/28/2026" -> "2026-07-28"; ISO dates pass through. */
function laserDate(s) {
  s = String(s || '').trim();
  var us = s.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})$/);
  if (us) return us[3] + '-' + pad2(+us[1]) + '-' + pad2(+us[2]);
  return s;
}

/**
 * Upserts one laser run captured by the Illustrator script. Keyed by run
 * number so re-sending a corrected sheet updates the row instead of
 * duplicating it. Status / Rush / Time are left for the floor to manage;
 * everything extracted (part numbers, size, work order, ...) is kept intact
 * in Raw Data as JSON for the dashboard to consume later.
 */
function logLaserRun(run) {
  run = run || {};
  var runNo = String(run.runNumber || '').replace(/\D/g, '');
  if (!runNo) throw new Error('Laser run number is required.');

  var lock = LockService.getScriptLock();
  lock.waitLock(5000);
  try {
    var target = laserTarget();
    var sheet = target.sheet;
    var lay = target.lay;
    var col = lay.col;

    // Match an existing row by run #, else take the first row with an empty
    // run # cell. (getLastRow() is useless here: the board's pre-formatted
    // dropdowns/formulas make it read ~131 on an empty tab.)
    var last = Math.max(sheet.getLastRow(), lay.dataRow);
    var row = 0, firstEmpty = 0;
    if (col['laser run #'] !== undefined) {
      var runs = sheet.getRange(lay.dataRow, col['laser run #'] + 1, last - lay.dataRow + 1, 1).getValues();
      for (var i = 0; i < runs.length; i++) {
        var cellRun = String(runs[i][0]).replace(/\D/g, '');
        if (cellRun === runNo) { row = lay.dataRow + i; break; }
        if (!firstEmpty && !String(runs[i][0]).trim()) firstEmpty = lay.dataRow + i;
      }
    }
    var updated = row > 0;
    if (!row) row = firstEmpty || (last + 1);

    var parts = run.parts || [];           // [{pn, qty}] as laid out on the sheet
    var partList = [];
    for (var p = 0; p < parts.length; p++) {
      partList.push(String(parts[p].pn || '') + ' x' + (Number(parts[p].qty) || 1));
    }
    var machine = String(run.machine || ''); // "T6" = Trotec laser #6, from the file name
    var summary = [];
    if (machine) summary.push('laser=' + machine);
    if (run.size) summary.push('size=' + run.size);
    if (run.workOrder) summary.push('wo=' + run.workOrder);
    if (run.customer) summary.push('customer=' + run.customer);
    if (run.file) summary.push('file=' + run.file);
    var raw = {
      parts: parts,
      size: String(run.size || ''),
      machine: machine,
      workOrder: String(run.workOrder || ''),
      customer: String(run.customer || ''),
      file: String(run.file || ''),
      sentAt: String(run.sentAt || '')
    };
    var fields = {
      'date': laserDate(run.date),
      'laser run #': runNo,
      'sheets': Number(run.sheets) || '',
      'sheet type': String(run.sheetType || '').slice(0, 60),
      'part numbers': partList.join(', ').slice(0, 5000),
      'data': summary.join(' | ').slice(0, 1000),
      'raw data': JSON.stringify(raw).slice(0, 45000)
    };
    // Notes doubles as the customer field (same convention as the board);
    // "Various" is noise, and hand-typed notes are never overwritten.
    var customer = String(run.customer || '').trim();
    if (customer && !/^various$/i.test(customer) && col['notes'] !== undefined &&
        !String(sheet.getRange(row, col['notes'] + 1).getValue()).trim()) {
      fields['notes'] = customer.slice(0, 200);
    }

    // Write cell by cell: a data-validation rejection (e.g. an off-list Sheet
    // Type) must not sink the rest of the row, and cells the board computes
    // with formulas are never overwritten.
    var warnings = [];
    for (var h in fields) {
      if (col[h] === undefined) continue;
      var cell = sheet.getRange(row, col[h] + 1);
      if (cell.getFormula()) continue;
      try {
        cell.setValue(fields[h]);
      } catch (cellErr) {
        warnings.push(h + ': ' + String((cellErr && cellErr.message) || cellErr));
      }
    }

    var out = { ok: true, row: row, updated: updated, runNumber: runNo };
    if (warnings.length) out.warnings = warnings;
    return out;
  } finally {
    lock.releaseLock();
  }
}

/** Clears a mislogged laser run's row (formula cells are left alone). */
function deleteLaserRun(runNumber) {
  var runNo = String(runNumber || '').replace(/\D/g, '');
  if (!runNo) throw new Error('Laser run number is required.');
  var lock = LockService.getScriptLock();
  lock.waitLock(5000);
  try {
    var target = laserTarget();
    var sheet = target.sheet;
    var lay = target.lay;
    var col = lay.col;
    if (col['laser run #'] === undefined) throw new Error('No run # column.');

    var last = Math.max(sheet.getLastRow(), lay.dataRow);
    var runs = sheet.getRange(lay.dataRow, col['laser run #'] + 1, last - lay.dataRow + 1, 1).getValues();
    var row = 0;
    for (var i = 0; i < runs.length; i++) {
      if (String(runs[i][0]).replace(/\D/g, '') === runNo) { row = lay.dataRow + i; break; }
    }
    if (!row) return { ok: true, found: false, runNumber: runNo };

    for (var h in col) {
      var cell = sheet.getRange(row, col[h] + 1);
      if (!cell.getFormula()) cell.setValue('');
    }
    return { ok: true, found: true, row: row, runNumber: runNo };
  } finally {
    lock.releaseLock();
  }
}

/* ---------- laser queue order ----------
 * Cut priority the laser floor sets by dragging rows on the dashboard. It
 * belongs to the shop, not to one browser, so it lives in a Script Property
 * ({ "<run #>": position }) exactly like the router queue's JOB_META order.
 */

function getLaserOrder() {
  var raw = PropertiesService.getScriptProperties().getProperty('LASER_ORDER');
  if (!raw) return {};
  try { return JSON.parse(raw) || {}; } catch (err) { return {}; }
}

function reorderLaser(order) {
  if (!Array.isArray(order)) throw new Error('order must be an array of laser run numbers.');
  var lock = LockService.getScriptLock();
  lock.waitLock(5000);
  try {
    var map = {};
    order.forEach(function (run, i) {
      run = String(run || '').trim();
      if (run) map[run] = i;
    });
    PropertiesService.getScriptProperties().setProperty('LASER_ORDER', JSON.stringify(map));
  } finally {
    lock.releaseLock();
  }
  return { ok: true };
}

/* ---------- laser complete / reopen ----------
 * The board's Status column is the floor's source of truth, so completing a
 * run from the dashboard writes it there ("Post Production"), which is what
 * moves the run out of the Laser Queue and into the Laser Log. Reopening
 * restores whatever the status was before, remembered per run.
 */

function getLaserPrev() {
  var raw = PropertiesService.getScriptProperties().getProperty('LASER_PREV_STATUS');
  if (!raw) return {};
  try { return JSON.parse(raw) || {}; } catch (err) { return {}; }
}
function setLaserPrev(map) {
  PropertiesService.getScriptProperties().setProperty('LASER_PREV_STATUS', JSON.stringify(map));
}

/**
 * The value to write into a Status cell. If the column carries a dropdown,
 * return the option that matches `want` (ignoring case/spacing) so a strict
 * validation rule accepts the write instead of rejecting it.
 */
function laserStatusValue(cell, want) {
  var rule;
  try { rule = cell.getDataValidation(); } catch (err) { return want; }
  if (!rule) return want;

  var list = null;
  try {
    var vals = rule.getCriteriaValues();
    if (vals && vals.length) {
      if (Object.prototype.toString.call(vals[0]) === '[object Array]') list = vals[0];
      else if (vals[0] && typeof vals[0].getValues === 'function') {
        list = vals[0].getValues().map(function (r) { return r[0]; });
      }
    }
  } catch (err) { return want; }
  if (!list || !list.length) return want;

  var key = function (s) { return String(s).replace(/[^a-z0-9]/gi, '').toLowerCase(); };
  var wanted = key(want);
  for (var i = 0; i < list.length; i++) {
    if (key(list[i]) === wanted) return list[i];
  }
  return want;   // not offered by the dropdown — let the write fail loudly
}

function setLaserComplete(runNumber, on) {
  var runNo = String(runNumber || '').replace(/\D/g, '');
  if (!runNo) throw new Error('Laser run number is required.');
  var lock = LockService.getScriptLock();
  lock.waitLock(5000);
  try {
    var target = laserTarget();
    var sheet = target.sheet, lay = target.lay, col = lay.col;
    if (col['status'] === undefined) throw new Error('The laser board has no Status column.');

    var last = Math.max(sheet.getLastRow(), lay.dataRow);
    var runs = sheet.getRange(lay.dataRow, col['laser run #'] + 1, last - lay.dataRow + 1, 1).getValues();
    var row = 0;
    for (var i = 0; i < runs.length; i++) {
      if (String(runs[i][0]).replace(/\D/g, '') === runNo) { row = lay.dataRow + i; break; }
    }
    if (!row) throw new Error('Laser run ' + runNo + ' is not on the board.');

    var cell = sheet.getRange(row, col['status'] + 1);
    if (cell.getFormula()) throw new Error('Run ' + runNo + '’s status is a formula — edit it on the board.');

    var prev = getLaserPrev(), want;
    if (on) {
      prev[runNo] = String(cell.getValue() || '').trim();
      want = laserStatusValue(cell, CONFIG.LASER_DONE_STATUS);
    } else {
      want = laserStatusValue(cell, prev[runNo] || CONFIG.LASER_DEFAULT_STATUS);
      delete prev[runNo];
    }

    try {
      cell.setValue(want);
    } catch (err) {
      throw new Error('The board rejected "' + want + '" in Status (row ' + row + '): '
        + String((err && err.message) || err));
    }
    setLaserPrev(prev);
    return { ok: true, runNumber: runNo, row: row, status: want };
  } finally {
    lock.releaseLock();
  }
}

/* ---------- laser board read (feeds the dashboard's laser cards) ---------- */

/**
 * Every logged laser run, newest data first as the board holds it. The floor
 * manages Status by hand ("On Laser" → "On Router" → "Post Production"), so
 * the dashboard reads it verbatim and decides queue-vs-log on the frontend.
 * RAW DATA carries the Illustrator capture (parts, size, machine, WO), which
 * is where the per-laser and part-number detail comes from.
 */
function readLaserBoard() {
  var target = laserTarget();
  var sheet = target.sheet, lay = target.lay, col = lay.col;
  var last = sheet.getLastRow();
  if (last < lay.dataRow) return [];

  var width = Math.max(sheet.getLastColumn(), 11);
  var values = sheet.getRange(lay.dataRow, 1, last - lay.dataRow + 1, width).getValues();
  var order = getLaserOrder();
  var cell = function (row, name) {
    var i = col[name];
    return i === undefined ? '' : row[i];
  };

  var out = [];
  for (var i = 0; i < values.length; i++) {
    var row = values[i];
    var runNo = String(cell(row, 'laser run #') || '').trim();
    if (!runNo) continue;                       // pre-formatted empty row

    // RAW DATA is the JSON the logger wrote; DATA is its human summary.
    var raw = {};
    try { raw = JSON.parse(String(cell(row, 'raw data') || '{}')) || {}; } catch (err) { raw = {}; }

    var when = cell(row, 'date');
    var sheetsVal = Number(cell(row, 'sheets'));

    // Machine codes name the laser: T# = Trotec, E# = Epilog. Older logger
    // builds only recognized T#, so an Epilog's code was left on the tail of
    // the size ("7.5x24-E3"). Split it back out so those runs still show a
    // laser and a clean sheet size.
    var size = String(raw.size || '').trim();
    var machine = String(raw.machine || '').trim().toUpperCase();
    var tail = /^(.*?)[-\s]*([TE]\s*\d+)$/i.exec(size);
    if (!machine && tail) {
      size = tail[1].replace(/[-\s]+$/, '');
      machine = tail[2].replace(/\s+/g, '').toUpperCase();
    }

    out.push({
      run: runNo,
      date: when instanceof Date ? Utilities.formatDate(when, Session.getScriptTimeZone(), 'yyyy-MM-dd')
                                 : String(when || '').trim(),
      sheets: isNaN(sheetsVal) ? 0 : sheetsVal,
      sheetType: String(cell(row, 'sheet type') || '').trim(),
      status: String(cell(row, 'status') || '').trim(),
      rush: String(cell(row, 'rush') || '').trim(),
      seconds: toSeconds(cell(row, 'time')),
      notes: String(cell(row, 'notes') || '').trim(),
      partsText: String(cell(row, 'part numbers') || '').trim(),
      parts: Array.isArray(raw.parts) ? raw.parts : [],
      size: size,
      machine: machine,                            // "T6" = Trotec 6, "E3" = Epilog 3
      customer: String(raw.customer || '').trim(),
      workOrder: String(raw.workOrder || '').trim(),
      loggedAt: String(raw.sentAt || '').trim(),
      order: order[runNo] === undefined ? null : order[runNo]
    });
  }
  return out;
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
