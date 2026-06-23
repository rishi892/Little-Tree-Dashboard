/**
 * Little Tree AR Dashboard — Review webhook (Google Apps Script)
 * ------------------------------------------------------------------
 * Collects feedback from the dashboard's "Review" widget into a Google Sheet,
 * saves uploaded/pasted screenshots to Drive, and lets the CFO mark reviews
 * "Resolved" (which then notifies the user who reported it).
 *
 * ONE-TIME SETUP
 * 1. Create a Google Sheet to collect reviews. Copy its ID from the URL
 *    (.../spreadsheets/d/<SHEET_ID>/edit#gid=<GID>) into SHEET_ID below.
 *    Also note the gid of the tab you want (usually 0 for the first sheet, but
 *    this script writes to a tab named "Reviews" — see its gid after first run).
 * 2. (Optional, for screenshots) Create a Drive folder, copy its ID into
 *    DRIVE_FOLDER_ID below.
 * 3. script.google.com → New project → paste this whole file.
 * 4. Deploy → New deployment → "Web app" → Execute as: Me, Who has access: Anyone
 *    → Deploy → authorize → copy the Web app URL (ends with /exec).
 * 5. Make the sheet readable by the dashboard: Share → "Anyone with the link →
 *    Viewer" (the dashboard reads it as CSV, like the data sheets).
 * 6. Wire both URLs into the dashboard build env (.env / Replit secrets):
 *      VITE_REVIEW_WEBHOOK = https://script.google.com/.../exec
 *      VITE_REVIEWS_CSV    = https://docs.google.com/spreadsheets/d/<SHEET_ID>/export?format=csv&gid=<REVIEWS_TAB_GID>
 */

var SHEET_ID = 'PUT_YOUR_GOOGLE_SHEET_ID_HERE';
var DRIVE_FOLDER_ID = 'PUT_A_DRIVE_FOLDER_ID_HERE'; // leave as-is to skip screenshots

var HEADERS = ['Id', 'Timestamp', 'User', 'Role', 'Page', 'Comment', 'Screenshot',
               'Status', 'Resolved by', 'Resolved at', 'Resolution note', 'User agent'];

function sheet_() {
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var sh = ss.getSheetByName('Reviews') || ss.insertSheet('Reviews');
  if (sh.getLastRow() === 0) sh.appendRow(HEADERS);
  return sh;
}

function doPost(e) {
  try {
    var data = JSON.parse(e.postData.contents);
    var sh = sheet_();

    // --- CFO marks a review resolved ---
    if (data.action === 'resolve') {
      var ids = sh.getRange(2, 1, Math.max(sh.getLastRow() - 1, 0), 1).getValues();
      for (var i = 0; i < ids.length; i++) {
        if (String(ids[i][0]) === String(data.id)) {
          var row = i + 2;
          sh.getRange(row, 8).setValue('Resolved');               // Status
          sh.getRange(row, 9).setValue(data.resolvedBy || '');     // Resolved by
          sh.getRange(row, 10).setValue(new Date());               // Resolved at
          sh.getRange(row, 11).setValue(data.note || '');          // Resolution note
          return ok_({ resolved: data.id });
        }
      }
      return ok_({ resolved: null, note: 'id not found' });
    }

    // --- new review submitted ---
    var shotUrl = '';
    if (data.screenshot && DRIVE_FOLDER_ID && DRIVE_FOLDER_ID.indexOf('PUT_') !== 0) {
      var m = String(data.screenshot).match(/^data:(image\/[\w.+-]+);base64,(.*)$/);
      if (m) {
        var blob = Utilities.newBlob(Utilities.base64Decode(m[2]), m[1], data.screenshotName || ('review-' + Date.now() + '.png'));
        var file = DriveApp.getFolderById(DRIVE_FOLDER_ID).createFile(blob);
        file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
        shotUrl = file.getUrl();
      }
    }
    sh.appendRow([
      data.id || Utilities.getUuid(),
      data.at ? new Date(data.at) : new Date(),
      data.user || '', data.role || '', data.page || '', data.comment || '',
      shotUrl, 'Under process', '', '', '', data.agent || ''
    ]);
    return ok_({ submitted: true });
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ ok: false, error: String(err) }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

function ok_(extra) {
  var out = { ok: true };
  for (var k in extra) out[k] = extra[k];
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}
