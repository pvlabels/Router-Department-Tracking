// Run with: node --test tests/performance.test.cjs
// Synthetic fixtures only: no customer or production data belongs in this repo.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const backendSource = fs.readFileSync(path.join(__dirname, '../src/Code.js'), 'utf8');
const pageSource = fs.readFileSync(path.join(__dirname, '../src/index.html'), 'utf8');
const frontendSource = pageSource.split('<script>')[1].split('// Paint the static chrome')[0];
function backend() {
  const ctx = vm.createContext({ Date, JSON });
  vm.runInContext(backendSource, ctx);
  return ctx;
}
function plain(value) { return JSON.parse(JSON.stringify(value)); }

test('indexed job totals preserve exact, revision, date, and full-history matching', () => {
  const ctx = backend();
  const names = ['TR-42.cnc', 'tr-42-02.CNC', 'TR-42-02-01.cnc', 'TR-420.cnc',
    'TR-42-fix.cnc', 'PS-24x18-18x12.cnc', 'PS-24x18-18x12-03.cnc', 'PS-24x18-18x12-EHOL-FIX.cnc'];
  const jobs = names.map((name, i) => ({ name: 'job-' + i, cutFile: name, startDate: '2026-06-17' }));
  jobs.push({ name: 'unmatched.cnc', startDate: '2026-01-01' });
  const runs = Array.from({ length: 12000 }, (_, i) => ({
    job: names[i % names.length], _t: new Date(2026, 5, 1 + i % 28).getTime(), seconds: i % 900
  }));
  const expected = {};
  for (const job of jobs) {
    const matched = runs.filter(r => r._t >= ctx.startDateMs(job.startDate)
      && ctx.runBelongsToJob(r.job, job.cutFile || job.name));
    expected[job.name] = { n: matched.length, s: matched.reduce((sum, r) => sum + r.seconds, 0) };
  }
  assert.deepEqual(plain(ctx.statsPerJob(runs, jobs)), expected);
  assert.deepEqual(plain(ctx.statsPerJob([], jobs)), Object.fromEntries(jobs.map(j => [j.name, { n: 0, s: 0 }])));
});

test('schedule sync reuses its bulk read and writes only changed production rows', () => {
  const ctx = backend();
  const col = Object.fromEntries(ctx.JOBS_HEADER.map((h, i) => [h, i]));
  const jobs = [Array.from(ctx.JOBS_HEADER)];
  const rows = [];
  for (let i = 0; i < 100; i++) {
    const num = String(100 + i);
    const job = Array(ctx.JOBS_HEADER.length).fill('');
    Object.entries({ 'Job Name': num, 'Sheets to Cut': 20, 'Active': false,
      'Cut File': 'TR-' + num + '.cnc', 'Source': 'production', 'Status': 'On-Press',
      'Notes': 'Example', 'Work Orders': 'WO-100', 'Size': '10x14', 'Qty': '2'
    }).forEach(([key, value]) => { job[col[key]] = value; });
    jobs.push(job);
    const row = Array(14).fill('');
    row[0] = new Date(2026, 5, 20); row[1] = num; row[2] = 20; row[4] = 'On-Press';
    row[6] = 'Example'; row[7] = '2'; row[8] = 'multicam'; row[12] = 'WO-100'; row[13] = '10x14';
    rows.push(row);
  }
  let reads = 0;
  const writes = [];
  const sheet = {
    getDataRange: () => ({ getValues: () => { reads++; return jobs.map(row => row.slice()); } }),
    getRange: (row, column, height, width) => ({
      getValues: () => { throw new Error('Unexpected per-job spreadsheet read'); },
      setValues: values => { writes.push({ row, column, height, width, values }); jobs[row - 1] = values[0].slice(); },
      setValue: value => { jobs[row - 1][column - 1] = value; }
    })
  };
  const schedule = { getSheetId: () => 0, getLastRow: () => ctx.CONFIG.PROD_START_ROW + rows.length - 1,
    getRange: () => ({ getValues: () => rows }) };
  ctx.SpreadsheetApp = { openById: () => ({ getSheets: () => [schedule] }) };
  ctx.LockService = { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) };
  ctx.jobsSheet = () => sheet;
  ctx.jobsCols = () => col;
  assert.deepEqual(plain(ctx.syncProductionQueue()), { added: 0, removed: 0, updated: 0 });
  assert.equal(reads, 1);
  assert.equal(writes.length, 0);
  rows[0][2] = 35;
  assert.deepEqual(plain(ctx.syncProductionQueue()), { added: 0, removed: 0, updated: 1 });
  assert.equal(writes.length, 1);
  assert.equal(writes[0].values[0][col['Sheets to Cut']], 35);
  assert.equal(writes[0].values[0][col.Active], false, 'manual stops stay stopped');
  // A repeated schedule run may complete first, then update its other fields.
  // Reusing the bulk read must not undo that earlier completion.
  jobs[1][col.Active] = true;
  const finished = rows[0].slice(); finished[4] = 'Finished Cutting';
  rows[0][2] = 40;
  rows.unshift(finished);
  let meta = {};
  ctx.getJobMeta = () => meta;
  ctx.setJobMeta = value => { meta = value; };
  ctx.syncProductionQueue();
  assert.equal(jobs[1][col.Active], false);
  assert.equal(jobs[1][col['Sheets to Cut']], 40);
});

function board(hash = 'example-hash') {
  return { hash, builtAt: new Date().toISOString(), runs: [], jobs: [], daily: {}, machines: [], laser: [], history: [] };
}
function frontend() {
  const elements = new Map(), storage = new Map(), timers = new Map(), requests = [];
  let timerId = 0, renders = 0;
  const ctx = vm.createContext({
    Date, JSON, AbortController, Number,
    location: { protocol: 'https:', hash: '' },
    localStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    document: { hidden: false, getElementById: id => {
      if (!elements.has(id)) elements.set(id, { className: '', textContent: '', innerHTML: '', style: {} });
      return elements.get(id);
    } },
    setTimeout: (fn, delay) => { timers.set(++timerId, { fn, delay }); return timerId; },
    clearTimeout: id => timers.delete(id),
    fetch: (url, options) => new Promise(resolve => requests.push({ url, options,
      reply: data => resolve({ ok: true, json: () => Promise.resolve(data) }) }))
  });
  vm.runInContext(frontendSource, ctx);
  ctx.render = () => { renders++; };
  const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
  const save = () => {
    for (const [id, task] of [...timers]) if (task.delay === 0) { timers.delete(id); task.fn(); }
  };
  return { ctx, storage, elements, requests, timers, flush, save, renders: () => renders };
}

test('refresh clicks coalesce and matching replies skip rendering', async () => {
  const f = frontend();
  f.ctx.load(); f.ctx.load(); f.ctx.autoRefresh();
  assert.equal(f.requests.length, 1);
  f.requests[0].reply(board()); await f.flush(); f.save();
  assert.equal(f.renders(), 1);
  f.ctx.load();
  assert.match(f.requests[1].url, /have=example-hash/);
  f.requests[1].reply({ unchanged: true, hash: 'example-hash', builtAt: new Date().toISOString() });
  await f.flush(); f.save();
  assert.equal(f.renders(), 1);
  assert.equal(f.ctx.activeLoad, null);
});

test('a recent saved board renders before the network and remains labeled as saved', () => {
  const f = frontend(), data = board();
  f.storage.set(f.ctx.SNAPSHOT_KEY, JSON.stringify(data));
  f.storage.set(f.ctx.SNAPSHOT_KEY + ':checked', JSON.stringify({ hash: data.hash, at: Date.now() }));
  f.ctx.restoreSnapshot(); f.ctx.load();
  assert.equal(f.renders(), 1);
  assert.equal(f.requests.length, 1);
  assert.match(f.elements.get('updated').textContent, /^saved /);
  assert.equal(f.elements.get('livedot').className, 'dot stale');
});

test('expired, mismatched, and corrupt snapshots fall back to the live load', () => {
  for (const variant of ['expired', 'mismatched', 'corrupt']) {
    const f = frontend(), data = board();
    f.storage.set(f.ctx.SNAPSHOT_KEY, variant === 'corrupt' ? '{' : JSON.stringify(data));
    f.storage.set(f.ctx.SNAPSHOT_KEY + ':checked', JSON.stringify({
      hash: variant === 'mismatched' ? 'wrong' : data.hash,
      at: Date.now() - (variant === 'expired' ? 16 * 60 * 1000 : 0)
    }));
    f.ctx.restoreSnapshot(); f.ctx.load();
    assert.equal(f.renders(), 0);
    assert.equal(f.requests.length, 1);
    assert.equal(f.ctx.dataHash, null);
  }
});

test('storage failures and failed refreshes preserve the loaded board', async () => {
  const f = frontend();
  f.ctx.localStorage.setItem = () => { throw new Error('Storage full'); };
  f.ctx.onData(board());
  assert.doesNotThrow(f.save);
  f.ctx.load();
  f.requests[0].reply({ error: 'Server unavailable' }); await f.flush();
  assert.equal(f.ctx.state.hash, 'example-hash');
  assert.match(f.elements.get('banner').innerHTML, /Showing data last checked/);
  assert.equal(f.ctx.activeLoad, null);
});

test('writes discard old in-flight reads and invalidate the saved board', async () => {
  const f = frontend();
  f.ctx.onData(board()); f.save();
  f.ctx.load();
  const oldRead = f.requests[0];
  let result;
  f.ctx.api({ action: 'saveJob', job: {} }, data => { result = data; });
  assert.equal(f.storage.has(f.ctx.SNAPSHOT_KEY), false);
  assert.equal(oldRead.options.signal.aborted, true);
  f.ctx.load();
  assert.equal(f.requests.length, 2, 'refresh waits for the write');
  oldRead.reply(board('old-response')); await f.flush();
  assert.equal(f.ctx.state.hash, 'example-hash');
  f.requests[1].reply({ ok: true }); await f.flush();
  assert.equal(result.ok, true);
  assert.equal(f.requests.length, 3);
  assert.doesNotMatch(f.requests[2].url, /have=/);
  f.requests[2].reply(board('new-response')); await f.flush(); f.save();
  assert.equal(JSON.parse(f.storage.get(f.ctx.SNAPSHOT_KEY)).hash, 'new-response');
});

test('timed-out reads can retry and cannot overwrite the retry', async () => {
  const f = frontend();
  f.ctx.load();
  [...f.timers.values()].find(t => t.delay === 60000).fn();
  assert.equal(f.ctx.activeLoad, null);
  f.ctx.load();
  f.requests[0].reply(board('timed-out')); await f.flush();
  assert.equal(f.ctx.dataHash, null);
  f.requests[1].reply(board('retry')); await f.flush();
  assert.equal(f.ctx.dataHash, 'retry');
});
