/* Laser Run Logger — panel logic. Scans via ExtendScript (host.jsx), posts
 * straight to the Router Department web app over HTTPS. */

var WEB_APP_URL = 'https://script.google.com/macros/s/AKfycbyO8LmIzyH1bw-axrpbrB98wsEVYZfCAJExR9vmBLoWcc9-WpvfsIhPW1FZ8Hl1dN1w3g/exec';

var FIELD_IDS = ['runNumber', 'date', 'sheets', 'sheetType', 'size', 'machine', 'customer', 'workOrder'];
var lastParts = [];   // [{pn, qty}] from the latest scan
var lastFile = '';

function $(id) { return document.getElementById(id); }

function setStatus(msg, cls) {
  var el = $('status');
  el.textContent = msg;
  el.className = cls || '';
}

function evalScript(script, cb) {
  window.__adobe_cep__.evalScript(script, cb);
}

function scan() {
  setStatus('Scanning document…', 'busy');
  evalScript('LRL_scan()', function (res) {
    var data;
    try { data = JSON.parse(res); } catch (e) {
      setStatus('Scan failed: ' + res, 'err');
      return;
    }
    if (data.error) {
      setStatus(data.error, 'err');
      return;
    }
    FIELD_IDS.forEach(function (id) { $(id).value = data[id] || ''; });
    lastParts = data.parts || [];
    lastFile = data.file || '';
    $('file').textContent = lastFile || 'Untitled document';
    $('partCount').textContent = lastParts.length;
    $('parts').value = lastParts.map(function (p) {
      return p.pn + '   x' + p.qty;
    }).join('\n');
    setStatus(lastParts.length
      ? 'Ready — check the fields, then Send to Sheet.'
      : 'No part numbers found on this document.', lastParts.length ? '' : 'err');
  });
}

function send() {
  var run = {};
  FIELD_IDS.forEach(function (id) { run[id] = $(id).value.trim(); });
  if (!run.runNumber.replace(/\D/g, '')) {
    setStatus('Laser run # is required.', 'err');
    return;
  }
  run.parts = lastParts;
  run.file = lastFile;
  var now = new Date();
  run.sentAt = now.getFullYear() + '-' + (now.getMonth() + 1) + '-' + now.getDate() +
    ' ' + now.getHours() + ':' + (now.getMinutes() < 10 ? '0' : '') + now.getMinutes();

  $('send').disabled = true;
  setStatus('Sending…', 'busy');

  var xhr = new XMLHttpRequest();
  xhr.open('POST', WEB_APP_URL, true);
  xhr.setRequestHeader('Content-Type', 'text/plain');
  xhr.timeout = 45000;
  xhr.onload = function () {
    $('send').disabled = false;
    var resp = {};
    try { resp = JSON.parse(xhr.responseText); } catch (e) {}
    if (resp.ok) {
      var msg = 'Run ' + resp.runNumber + ' logged (row ' + resp.row +
        (resp.updated ? ', updated' : ', new') + '). ' +
        lastParts.length + ' part number' + (lastParts.length === 1 ? '' : 's') + ' sent.';
      if (resp.warnings && resp.warnings.length) {
        msg += '\nSkipped: ' + resp.warnings.join('; ');
      }
      setStatus(msg, 'ok');
    } else {
      setStatus('Upload failed: ' + (resp.error || xhr.responseText.slice(0, 200) || 'no response'), 'err');
    }
  };
  xhr.onerror = function () {
    $('send').disabled = false;
    setStatus('Could not reach the server — check the internet connection.', 'err');
  };
  xhr.ontimeout = function () {
    $('send').disabled = false;
    setStatus('Timed out — check the connection and try again.', 'err');
  };
  xhr.send(JSON.stringify({ action: 'laserLog', run: run }));
}

$('rescan').addEventListener('click', scan);
$('send').addEventListener('click', send);

// Scan the active document when the panel opens. Rescan stays manual so a
// click back into the panel never wipes hand-corrected fields.
scan();
