/**
 * Live Dashboard — Apps Script backend.
 *
 * Serves the dashboard page and reads rows from the configured Google Sheet.
 * Deployed as a web app; source of truth is the GitHub repo (pushed via clasp).
 */

var CONFIG = {
  // The long ID from the sheet URL:
  // https://docs.google.com/spreadsheets/d/<SHEET_ID>/edit
  SHEET_ID: 'PASTE_YOUR_SHEET_ID_HERE',

  // Tab name to read. Leave '' to use the first tab.
  SHEET_NAME: '',

  // Cap on rows returned to the browser (most recent rows win).
  MAX_ROWS: 1000
};

/** Entry point for the web app. */
function doGet() {
  return HtmlService.createTemplateFromFile('index')
    .evaluate()
    .setTitle('Live Dashboard')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/**
 * Called from the browser via google.script.run.
 * Returns { headers, rows, sheetName, updatedAt } with all cells JSON-safe
 * (Dates become ISO strings — google.script.run cannot return Date objects).
 */
function getData() {
  if (CONFIG.SHEET_ID === 'PASTE_YOUR_SHEET_ID_HERE') {
    throw new Error('Setup needed: paste your spreadsheet ID into CONFIG.SHEET_ID in Code.js');
  }

  var ss = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  var sheet = CONFIG.SHEET_NAME
    ? ss.getSheetByName(CONFIG.SHEET_NAME)
    : ss.getSheets()[0];
  if (!sheet) {
    throw new Error('Sheet tab not found: "' + CONFIG.SHEET_NAME + '"');
  }

  var values = sheet.getDataRange().getValues();
  if (values.length === 0) {
    return { headers: [], rows: [], sheetName: sheet.getName(), updatedAt: new Date().toISOString() };
  }

  var headers = values[0].map(String);
  var rows = values.slice(1);
  if (rows.length > CONFIG.MAX_ROWS) {
    rows = rows.slice(rows.length - CONFIG.MAX_ROWS);
  }

  var safeRows = rows.map(function (row) {
    return row.map(function (cell) {
      if (cell instanceof Date) return cell.toISOString();
      return cell;
    });
  });

  return {
    headers: headers,
    rows: safeRows,
    sheetName: sheet.getName(),
    updatedAt: new Date().toISOString()
  };
}
