/**
 * BOTANY R&D LAB — Google Sheets sync endpoint
 * Paste this into Extensions → Apps Script of the "Botany R&D — Shot Log" spreadsheet,
 * then Deploy → New deployment → Web app → Execute as: Me, Access: Anyone.
 * Copy the /exec URL into the app's Settings → Google Sheet sync URL.
 */

const SHEET_NAME = "Shots";
const TOKEN = "botany"; // must match the app; change in both places if you want

const HEADERS = [
  "timestamp","date","time","barista","mode","machine","grinder","bean","roaster",
  "roast_date","days_off_roast","water_temp_c","grind","dose_g","yield_g","ratio","time_s",
  "verdict","rating","notes","session_id","shot_id"
];

function getSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) sh = ss.insertSheet(SHEET_NAME);
  if (sh.getLastRow() === 0) {
    sh.appendRow(HEADERS);
    sh.setFrozenRows(1);
    sh.getRange(1, 1, 1, HEADERS.length).setFontWeight("bold");
  }
  return sh;
}

function doPost(e) {
  const out = (obj) =>
    ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
  try {
    const body = JSON.parse(e.postData.contents || "{}");
    if (body.token !== TOKEN) return out({ ok: false, error: "bad token" });
    if (body.ping) return out({ ok: true, pong: true });

    const rows = body.rows || [];
    if (!rows.length) return out({ ok: true, appended: 0 });

    const sh = getSheet_();

    // de-dupe on shot_id (last column) so retries never double-log
    const lastCol = HEADERS.length;
    const existing = new Set(
      sh.getLastRow() > 1
        ? sh.getRange(2, lastCol, sh.getLastRow() - 1, 1).getValues().flat().map(String)
        : []
    );
    const fresh = rows.filter(r => !existing.has(String(r[lastCol - 1])));
    if (fresh.length) {
      sh.getRange(sh.getLastRow() + 1, 1, fresh.length, lastCol).setValues(fresh);
    }
    return out({ ok: true, appended: fresh.length, skipped: rows.length - fresh.length });
  } catch (err) {
    return out({ ok: false, error: String(err) });
  }
}

function doGet() {
  return ContentService.createTextOutput(
    JSON.stringify({ ok: true, service: "botany-lab", sheet: SHEET_NAME })
  ).setMimeType(ContentService.MimeType.JSON);
}
