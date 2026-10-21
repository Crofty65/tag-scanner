// Price Tag Scanner — sheet backend. Bind to the target spreadsheet.
// Script property TOKEN must match the token entered in the app.
// Deploy as Web app: Execute as Me, access Anyone. Client sends POST, Content-Type: text/plain, JSON body.

const HEADERS = ['Item number', 'Description', 'Price', 'Location', 'Scanned at', 'Scan ID'];

function doPost(e) {
  try {
    const req = JSON.parse(e.postData.contents);
    if (req.token !== PropertiesService.getScriptProperties().getProperty('TOKEN')) return out({ ok: false, error: 'bad token' });
    const lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
      switch (req.action) {
        case 'ping': return out({ ok: true, spreadsheet: SpreadsheetApp.getActive().getName(), url: SpreadsheetApp.getActive().getUrl() });
        case 'ensureTab': return out(ensureTab(req.tab));
        case 'append': return out(append(req.tab, req.rows));
        case 'update': return out(update(req.tab, req.row));
        default: return out({ ok: false, error: 'unknown action' });
      }
    } finally { lock.releaseLock(); }
  } catch (err) {
    return out({ ok: false, error: String(err) });
  }
}

function out(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function ensureTab(name) {
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]).setFontWeight('bold');
    sh.setFrozenRows(1);
    sh.getRange('A:A').setNumberFormat('@');
    sh.getRange('C:C').setNumberFormat('0.00');
    sh.hideColumns(6);
  }
  return { ok: true, tab: name, sheetId: sh.getSheetId(), url: ss.getUrl() + '#gid=' + sh.getSheetId() };
}

function idIndex(sh) {
  const last = sh.getLastRow();
  const map = {};
  if (last < 2) return map;
  sh.getRange(2, 6, last - 1, 1).getValues().forEach((r, i) => { if (r[0]) map[r[0]] = i + 2; });
  return map;
}

// rows: [{ id, sku, desc, price, loc, scannedAt: 'yyyy-MM-dd HH:mm' }]
function append(tab, rows) {
  ensureTab(tab);
  const sh = SpreadsheetApp.getActive().getSheetByName(tab);
  const seen = idIndex(sh);
  const result = [];
  const fresh = [];
  rows.forEach(r => {
    if (seen[r.id]) result.push({ id: r.id, row: seen[r.id], duplicate: true });
    else fresh.push(r);
  });
  if (fresh.length) {
    const start = sh.getLastRow() + 1;
    sh.getRange(start, 1, fresh.length, HEADERS.length).setValues(
      fresh.map(r => [String(r.sku), r.desc, Number(r.price), r.loc, r.scannedAt, r.id]));
    fresh.forEach((r, i) => result.push({ id: r.id, row: start + i }));
  }
  return { ok: true, rows: result };
}

// row: { id, sku?, desc?, price?, loc?, scannedAt? }
function update(tab, row) {
  const sh = SpreadsheetApp.getActive().getSheetByName(tab);
  if (!sh) return { ok: false, error: 'no such tab' };
  const n = idIndex(sh)[row.id];
  if (!n) return { ok: false, error: 'row not found' };
  const cur = sh.getRange(n, 1, 1, HEADERS.length).getValues()[0];
  const next = [
    row.sku != null ? String(row.sku) : cur[0],
    row.desc != null ? row.desc : cur[1],
    row.price != null ? Number(row.price) : cur[2],
    row.loc != null ? row.loc : cur[3],
    row.scannedAt != null ? row.scannedAt : cur[4],
    cur[5],
  ];
  sh.getRange(n, 1, 1, HEADERS.length).setValues([next]);
  return { ok: true, row: n };
}
