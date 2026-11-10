/**
 * Log Laser Run — Adobe Illustrator script.
 *
 * Scans the open laser run sheet for its part numbers, run number, date,
 * sheet quantity, customer and work order. Sheet color comes from the part
 * number prefix (4/04 Red, 14 Yellow, 24 Black, 34 White); sheet size and
 * laser machine come from the file name (LR-25223-8.5X24-T6 -> size 8.5X24,
 * Trotec laser #6). Shows a review dialog,
 * then sends everything to the Press Sheet Tracking spreadsheet's laser tab
 * via the Router Department web app (laserLog action).
 *
 * Install: File > Scripts > Other Script... and pick this file, or copy it to
 * Illustrator's Presets/Scripts folder so it appears in the Scripts menu.
 *
 * Requires Windows 10+ (uses the built-in curl.exe to reach Google over
 * HTTPS, since ExtendScript itself cannot).
 */

#target illustrator

var WEB_APP_URL = 'https://script.google.com/macros/s/AKfycbyO8LmIzyH1bw-axrpbrB98wsEVYZfCAJExR9vmBLoWcc9-WpvfsIhPW1FZ8Hl1dN1w3g/exec';

(function () {
  if (app.documents.length === 0) {
    alert('Open a laser run sheet first.');
    return;
  }
  var doc = app.activeDocument;

  /* ---------- gather every piece of text on the sheet ---------- */

  var lines = [];
  for (var i = 0; i < doc.textFrames.length; i++) {
    try { lines.push(doc.textFrames[i].contents); } catch (e) {}
  }
  var allText = lines.join('\n');

  /* ---------- part numbers ---------- */
  // Label part numbers look like 04-732-282397-H / 4-54-282367-J. The
  // three-numeric-segment shape (last segment 5-7 digits) can't collide with
  // dates (07-28-2026) or WO chains (WO-268622-268275). Duplicates are the
  // same label placed more than once, so keep a count per part.

  var partPattern = /\b(\d{1,3}-\d{1,4}-\d{5,7}(-[A-Z0-9]{1,4})?)\b/g;
  var partOrder = [], partQty = {}, m;
  while ((m = partPattern.exec(allText)) !== null) {
    var pn = m[1];
    if (partQty[pn] === undefined) { partQty[pn] = 0; partOrder.push(pn); }
    partQty[pn]++;
  }

  /* ---------- sheet color from the part number prefix ---------- */
  // The first group of the part number encodes the sheet stock. Values must
  // match the laser board's Sheet Type dropdown exactly.

  var COLOR_BY_PREFIX = {
    '4': 'Red with White text', '04': 'Red with White text',
    '14': 'Yellow with Black text',
    '24': 'Black with White text',
    '34': 'White with Black text'
  };
  var colorOrder = [], colorSeen = {};
  for (var cp = 0; cp < partOrder.length; cp++) {
    var color = COLOR_BY_PREFIX[partOrder[cp].split('-')[0]] || '';
    if (color && !colorSeen[color]) { colorSeen[color] = true; colorOrder.push(color); }
  }
  var sheetColor = colorOrder.join('/');   // mixed prefixes -> "Red/Yellow"

  /* ---------- run info from the footer text ---------- */

  function grab(re) { var r = allText.match(re); return r ? r[1] : ''; }

  var runNumber = grab(/Laser\s*Run\s*#?\s*(\d+)/i);
  var qtySheets = grab(/Qty\s*of\s*Sheets:?\s*(\d+)/i);
  var runDate   = grab(/Date:?\s*(\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4}|\d{4}-\d{2}-\d{2})/i);
  var workOrder = grab(/Work\s*Order\s*#?:?\s*([A-Za-z0-9-]+)/i);
  var customer  = grab(/Customer:?\s*([^\r\n]*?)\s*(?:Qty\s*of\s*Sheets|Work\s*Order|Date:|[\r\n]|$)/i);

  /* ---------- run #, size + machine from the file name ---------- */
  // LR-25223-8.5X24-T6 -> run 25223, size 8.5X24, machine T6.
  // The letter names the make: T# = Trotec, E# = Epilog.

  var baseName = String(doc.name).replace(/\.[^.]+$/, '');
  var sheetSize = '', laserMachine = '';
  var fileBits = baseName.split('-');
  if (fileBits.length >= 3 && /^LR$/i.test(fileBits[0])) {
    if (!runNumber) runNumber = fileBits[1].replace(/\D/g, '');
    if (/^[TE]\d+$/i.test(fileBits[fileBits.length - 1])) {
      laserMachine = fileBits[fileBits.length - 1].toUpperCase();
    }
    sheetSize = fileBits.slice(2, laserMachine ? fileBits.length - 1 : fileBits.length).join('-');
  }

  if (!runDate) {
    var now = new Date();
    runDate = (now.getMonth() + 1) + '-' + now.getDate() + '-' + now.getFullYear();
  }

  /* ---------- review dialog ---------- */

  var partLines = [];
  for (var p = 0; p < partOrder.length; p++) {
    partLines.push(partOrder[p] + '   x' + partQty[partOrder[p]]);
  }

  var dlg = new Window('dialog', 'Log Laser Run');
  dlg.orientation = 'column';
  dlg.alignChildren = 'fill';

  function field(label, value) {
    var g = dlg.add('group');
    g.add('statictext', undefined, label).preferredSize.width = 90;
    var e = g.add('edittext', undefined, value);
    e.preferredSize.width = 220;
    return e;
  }

  var fRun      = field('Laser Run #', runNumber);
  var fDate     = field('Date', runDate);
  var fSheets   = field('Sheets', qtySheets);
  var fColor    = field('Sheet color', sheetColor);
  var fSize     = field('Sheet size', sheetSize);
  var fMachine  = field('Laser (T#)', laserMachine);
  var fCustomer = field('Customer', customer);
  var fWO       = field('Work Order', workOrder);

  dlg.add('statictext', undefined, 'Part numbers found (' + partOrder.length + '):');
  var partsBox = dlg.add('edittext', undefined, partLines.join('\n'),
                         { multiline: true, readonly: true });
  partsBox.preferredSize = [320, Math.min(160, 24 + partLines.length * 16)];

  var btns = dlg.add('group');
  btns.alignment = 'right';
  btns.add('button', undefined, 'Cancel', { name: 'cancel' });
  btns.add('button', undefined, 'Send to Sheet', { name: 'ok' });

  if (dlg.show() !== 1) return;

  /* ---------- build the JSON payload ---------- */

  function esc(s) {
    s = String(s);
    var out = '';
    for (var c = 0; c < s.length; c++) {
      var ch = s.charAt(c), code = s.charCodeAt(c);
      if (ch === '"' || ch === '\\') out += '\\' + ch;
      else if (code < 32) out += '\\n';
      else out += ch;
    }
    return out;
  }

  var partsJson = [];
  for (var q = 0; q < partOrder.length; q++) {
    partsJson.push('{"pn":"' + esc(partOrder[q]) + '","qty":' + partQty[partOrder[q]] + '}');
  }
  var stamp = new Date();
  var sentAt = stamp.getFullYear() + '-' + (stamp.getMonth() + 1) + '-' + stamp.getDate() +
               ' ' + stamp.getHours() + ':' + (stamp.getMinutes() < 10 ? '0' : '') + stamp.getMinutes();

  var payload = '{"action":"laserLog","run":{' +
    '"runNumber":"' + esc(fRun.text) + '",' +
    '"date":"' + esc(fDate.text) + '",' +
    '"sheets":"' + esc(fSheets.text) + '",' +
    '"sheetType":"' + esc(fColor.text) + '",' +
    '"size":"' + esc(fSize.text) + '",' +
    '"machine":"' + esc(fMachine.text) + '",' +
    '"customer":"' + esc(fCustomer.text) + '",' +
    '"workOrder":"' + esc(fWO.text) + '",' +
    '"file":"' + esc(doc.name) + '",' +
    '"sentAt":"' + esc(sentAt) + '",' +
    '"parts":[' + partsJson.join(',') + ']}}';

  /* ---------- ship it with curl (hidden console via a VBS wrapper) ---------- */

  var work = new Folder(Folder.temp.fsName + '/LaserRunLog');
  if (!work.exists) work.create();

  function tempFile(name) {
    var f = new File(work.fsName + '/' + name);
    if (f.exists) f.remove();
    return f;
  }

  var payloadFile = tempFile('payload.json');
  var responseFile = tempFile('response.txt');
  var errorFile = tempFile('curl-error.txt');
  var doneFile = tempFile('done.txt');
  var batFile = tempFile('send.bat');
  var vbsFile = tempFile('send.vbs');

  payloadFile.encoding = 'UTF-8';
  payloadFile.open('w');
  payloadFile.write(payload);
  payloadFile.close();

  batFile.open('w');
  batFile.write('@echo off\r\n' +
    'curl -s -L -m 45 -H "Content-Type: text/plain" --data-binary @"' +
    payloadFile.fsName + '" "' + WEB_APP_URL + '" > "' + responseFile.fsName +
    '" 2> "' + errorFile.fsName + '"\r\n' +
    'echo %errorlevel% > "' + doneFile.fsName + '"\r\n');
  batFile.close();

  vbsFile.open('w');
  vbsFile.write('CreateObject("WScript.Shell").Run Chr(34) & "' +
    batFile.fsName + '" & Chr(34), 0, True\r\n');
  vbsFile.close();

  if (!vbsFile.execute()) {
    alert('Could not launch the uploader.\nPayload saved at:\n' + payloadFile.fsName);
    return;
  }

  var waited = 0;
  while (!doneFile.exists && waited < 50000) { $.sleep(400); waited += 400; }

  var response = '';
  if (responseFile.exists) {
    responseFile.open('r');
    response = responseFile.read();
    responseFile.close();
  }

  if (response.indexOf('"ok":true') >= 0) {
    var rowMatch = response.match(/"row":(\d+)/);
    var wasUpdate = response.indexOf('"updated":true') >= 0;
    var warnMatch = response.match(/"warnings":\[([^\]]*)\]/);
    alert('Run ' + fRun.text + ' logged to the laser sheet' +
          (rowMatch ? ' (row ' + rowMatch[1] + (wasUpdate ? ', updated' : ', new') + ')' : '') + '.\n' +
          partOrder.length + ' part number' + (partOrder.length === 1 ? '' : 's') + ' sent.' +
          (warnMatch ? '\n\nSkipped: ' + warnMatch[1].replace(/"/g, '') : ''));
  } else if (!doneFile.exists) {
    alert('Timed out waiting for the upload. Check your connection and try again.');
  } else {
    var errMatch = response.match(/"error":"([^"]*)"/);
    alert('Upload failed' + (errMatch ? ':\n' + errMatch[1] : '.') +
          (response ? '\n\nServer said:\n' + response.substring(0, 300) : '\nNo response from server.'));
  }
})();
