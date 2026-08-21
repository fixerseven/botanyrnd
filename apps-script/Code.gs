/**
 * BOTANY R&D LAB — Google Sheets sync endpoint  (v2: shots + shared library)
 * Paste into the "Botany Lab Sync" Apps Script project, then
 * Deploy → Manage deployments → edit → Version: New version → Deploy.
 * The /exec URL stays the same.
 */

const SPREADSHEET_ID = "1y8vjG8UYb2xlQ6WmzVQVdlhE17YeQny8EkXAVM33aOE"; // Botany R&D — Shot Log
const SHEET_NAME = "Shots";
const LIB_SHEET = "Library";
const TOKEN = "botany"; // must match the app; change in both places if you want

const HEADERS = [
  "timestamp","date","time","barista","mode","machine","grinder","bean","roaster",
  "roast_date","days_off_roast","water_temp_c","pressure_bar","grind","dose_g","yield_g",
  "ratio","time_s","infusion","verdict","rating","notes","session_id","shot_id"
];

function ss_() { return SpreadsheetApp.openById(SPREADSHEET_ID); }

function getSheet_() {
  let sh = ss_().getSheetByName(SHEET_NAME);
  if (!sh) sh = ss_().insertSheet(SHEET_NAME);
  if (sh.getLastRow() === 0) {
    sh.appendRow(HEADERS);
    sh.setFrozenRows(1);
    sh.getRange(1, 1, 1, HEADERS.length).setFontWeight("bold");
  } else if (sh.getRange(1, HEADERS.length).getValue() !== HEADERS[HEADERS.length - 1]) {
    // schema widened in a newer app version — refresh the header row
    sh.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]).setFontWeight("bold");
  }
  migrateRows_(sh);
  return sh;
}

/* Rows written by older app versions are narrower than the current header —
   realign them once so every column matches. shot_id is always the last cell. */
function migrateRows_(sh) {
  var lastRow = sh.getLastRow();
  if (lastRow < 2) return;
  var n = HEADERS.length;
  var rng = sh.getRange(2, 1, lastRow - 1, n);
  var vals = rng.getValues();
  var dirty = false;
  var fixed = vals.map(function (r) {
    if (String(r[n - 1]) !== "") return r;                       // already current shape
    if (String(r[n - 2]) !== "") {                                // pre-infusion era (23 cols)
      dirty = true;
      var a = r.slice(0, n - 1);
      return a.slice(0, 18).concat([""], a.slice(18));
    }
    if (String(r[n - 3]) !== "") {                                // pre-pressure era (22 cols)
      dirty = true;
      var b = r.slice(0, n - 2);
      b = b.slice(0, 12).concat([""], b.slice(12));
      return b.slice(0, 18).concat([""], b.slice(18));
    }
    return r;
  });
  if (dirty) rng.setValues(fixed);
}

/* ---------- shared library (beans / grinders / machines) ---------- */

function getLibSheet_() {
  let sh = ss_().getSheetByName(LIB_SHEET);
  if (!sh) {
    sh = ss_().insertSheet(LIB_SHEET);
    sh.appendRow(["kind", "id", "json", "updated"]);
    sh.setFrozenRows(1);
    sh.getRange(1, 1, 1, 4).setFontWeight("bold");
  }
  return sh;
}

function libAll_() {
  const sh = getLibSheet_();
  if (sh.getLastRow() < 2) return [];
  return sh.getRange(2, 1, sh.getLastRow() - 1, 4).getValues().map(function (r) {
    try {
      const o = JSON.parse(r[2]);
      o._kind = String(r[0]);
      o._updated = Number(r[3]) || 0;
      return o;
    } catch (err) { return null; }
  }).filter(Boolean);
}

function libUpsert_(items) {
  if (!items || !items.length) return;
  const lock = LockService.getScriptLock();
  lock.tryLock(8000);
  try {
    const sh = getLibSheet_();
    const last = sh.getLastRow();
    const index = {};
    if (last >= 2) {
      sh.getRange(2, 2, last - 1, 1).getValues().forEach(function (r, i) { index[String(r[0])] = i + 2; });
    }
    items.forEach(function (it) {
      if (!it || !it.id || !it._kind) return;
      const updated = Number(it._updated) || 0;
      const clean = {};
      Object.keys(it).forEach(function (k) { if (k !== "_kind" && k !== "_updated") clean[k] = it[k]; });
      const row = [it._kind, it.id, JSON.stringify(clean), updated];
      const at = index[String(it.id)];
      if (at) {
        if (updated > (Number(sh.getRange(at, 4).getValue()) || 0)) {
          sh.getRange(at, 1, 1, 4).setValues([row]);
        }
      } else {
        sh.appendRow(row);
      }
    });
  } finally {
    lock.releaseLock();
  }
}

/* ---------- endpoint ---------- */

function doPost(e) {
  const out = (obj) =>
    ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
  try {
    const body = JSON.parse(e.postData.contents || "{}");
    if (body.token !== TOKEN) return out({ ok: false, error: "bad token" });
    if (body.ping) return out({ ok: true, pong: true });

    // shared library: client pushes its items, gets the merged shop library back
    if (body.action === "lib_sync") {
      libUpsert_(body.items || []);
      return out({ ok: true, items: libAll_() });
    }

    // shot pull-sync: return rows newer than `since` so phones can show everyone's history
    if (body.action === "shots_pull") {
      const sh = getSheet_();
      const lastRow = sh.getLastRow();
      if (lastRow < 2) return out({ ok: true, rows: [] });
      const vals = sh.getRange(2, 1, lastRow - 1, HEADERS.length).getValues();
      const since = Number(body.since) || 0;
      const rows = [];
      for (var i = vals.length - 1; i >= 0 && rows.length < 500; i--) {
        const ts = new Date(vals[i][0]).getTime() || 0;
        if (ts > since) rows.push(vals[i]);
      }
      return out({ ok: true, rows: rows });
    }

    let rows = body.rows || [];
    if (!rows.length) return out({ ok: true, appended: 0 });

    // legacy app versions — pad older row shapes up to the current schema
    rows = rows.map(function (r) {
      if (r.length === HEADERS.length - 2) r = r.slice(0, 12).concat([""], r.slice(12)); // pre-pressure era
      if (r.length === HEADERS.length - 1) r = r.slice(0, 18).concat([""], r.slice(18)); // pre-infusion era
      return r;
    });

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
    JSON.stringify({ ok: true, service: "botany-lab", version: 4, sheet: SHEET_NAME })
  ).setMimeType(ContentService.MimeType.JSON);
}
