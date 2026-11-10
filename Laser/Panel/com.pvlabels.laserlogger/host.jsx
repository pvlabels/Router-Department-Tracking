/**
 * Laser Run Logger — ExtendScript side of the CEP panel.
 *
 * LRL_scan() reads the open run sheet and returns everything as a JSON
 * string; the panel (index.html/main.js) shows it for review and does the
 * HTTPS POST itself, so no curl/temp files are involved.
 */

function LRL_esc(s) {
  s = String(s);
  var out = '';
  for (var c = 0; c < s.length; c++) {
    var ch = s.charAt(c), code = s.charCodeAt(c);
    if (ch === '"' || ch === '\\') out += '\\' + ch;
    else if (code < 32) out += ' ';
    else out += ch;
  }
  return out;
}

function LRL_scan() {
  try {
    if (app.documents.length === 0) return '{"error":"No document open."}';
    var doc = app.activeDocument;

    var lines = [];
    for (var i = 0; i < doc.textFrames.length; i++) {
      try { lines.push(doc.textFrames[i].contents); } catch (e) {}
    }
    var allText = lines.join('\n');

    // Label part numbers (04-732-282397-H style): three numeric segments, the
    // last 5-7 digits, so dates and WO chains can't collide. Duplicates are
    // the same label placed more than once -> qty.
    var partPattern = /\b(\d{1,3}-\d{1,4}-\d{5,7}(-[A-Z0-9]{1,4})?)\b/g;
    var partOrder = [], partQty = {}, m;
    while ((m = partPattern.exec(allText)) !== null) {
      var pn = m[1];
      if (partQty[pn] === undefined) { partQty[pn] = 0; partOrder.push(pn); }
      partQty[pn]++;
    }

    // Sheet color from the part number prefix; values must match the laser
    // board's Sheet Type dropdown exactly.
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

    function grab(re) { var r = allText.match(re); return r ? r[1] : ''; }
    var runNumber = grab(/Laser\s*Run\s*#?\s*(\d+)/i);
    var qtySheets = grab(/Qty\s*of\s*Sheets:?\s*(\d+)/i);
    var runDate   = grab(/Date:?\s*(\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4}|\d{4}-\d{2}-\d{2})/i);
    var workOrder = grab(/Work\s*Order\s*#?:?\s*([A-Za-z0-9-]+)/i);
    var customer  = grab(/Customer:?\s*([^\r\n]*?)\s*(?:Qty\s*of\s*Sheets|Work\s*Order|Date:|[\r\n]|$)/i);

    // Run #, size + machine from the file name: LR-25223-8.5X24-T6.
    var baseName = String(doc.name).replace(/\.[^.]+$/, '');
    var sheetSize = '', laserMachine = '';
    var fileBits = baseName.split('-');
    if (fileBits.length >= 3 && /^LR$/i.test(fileBits[0])) {
      if (!runNumber) runNumber = fileBits[1].replace(/\D/g, '');
      // T# = Trotec, E# = Epilog
      if (/^[TE]\d+$/i.test(fileBits[fileBits.length - 1])) {
        laserMachine = fileBits[fileBits.length - 1].toUpperCase();
      }
      sheetSize = fileBits.slice(2, laserMachine ? fileBits.length - 1 : fileBits.length).join('-');
    }

    if (!runDate) {
      var now = new Date();
      runDate = (now.getMonth() + 1) + '-' + now.getDate() + '-' + now.getFullYear();
    }

    var partsJson = [];
    for (var q = 0; q < partOrder.length; q++) {
      partsJson.push('{"pn":"' + LRL_esc(partOrder[q]) + '","qty":' + partQty[partOrder[q]] + '}');
    }

    return '{' +
      '"runNumber":"' + LRL_esc(runNumber) + '",' +
      '"date":"' + LRL_esc(runDate) + '",' +
      '"sheets":"' + LRL_esc(qtySheets) + '",' +
      '"sheetType":"' + LRL_esc(colorOrder.join('/')) + '",' +
      '"size":"' + LRL_esc(sheetSize) + '",' +
      '"machine":"' + LRL_esc(laserMachine) + '",' +
      '"customer":"' + LRL_esc(customer) + '",' +
      '"workOrder":"' + LRL_esc(workOrder) + '",' +
      '"file":"' + LRL_esc(doc.name) + '",' +
      '"parts":[' + partsJson.join(',') + ']}';
  } catch (err) {
    return '{"error":"' + LRL_esc(String(err)) + '"}';
  }
}
