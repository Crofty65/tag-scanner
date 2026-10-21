// App state, persistence and the scan → sheet pipeline (commit, outbox flush, updates, sessions).

import { kvGet, kvSet, scansAll, scanPut, scanDelete } from './db.js';
import { parseTag, weakestField } from './parse.js';
import { readText, sheetCall, OfflineError } from './net.js';

export const FIELD_NAME = { sku: 'Item number unclear', desc: 'Description unclear', price: 'Price unclear' };

const DEFAULT_SETTINGS = {
  scriptUrl: '', token: '', visionKey: '', sheetName: '', sheetUrl: '',
  naming: 'both', store: '', threshold: 80, mode: 'manual', paused: false, setupDone: false,
};

export const state = {
  settings: { ...DEFAULT_SETTINGS },
  session: null,        // { id, tab, startedAt }
  loc: '',
  recents: [],          // max 6, most recent first
  usedTabs: [],         // tab names already used by earlier sessions
  tabs: {},             // tab → { sheetId, url } from ensureTab
  summary: null,        // last Session ended summary
  scans: [],            // every scan still on the phone (all sessions)
  ui: {
    screen: 'setup', setupStep: 1, toast: null, dupe: null, endConfirm: false, locOpen: false,
    syncing: false, online: true, flash: false, editId: null, draft: null, busy: false,
    ping: { status: 'idle', error: '' }, camError: '', torch: false, torchAvailable: false,
    lastRead: null,
  },
};

let renderFn = () => {};
export const onChange = fn => { renderFn = fn; };
export const render = () => renderFn();

// ── helpers ──────────────────────────────────────────────────────────────

const pad = n => String(n).padStart(2, '0');
export const ymd = t => { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
export const sheetTime = t => { const d = new Date(t); return `${ymd(t)} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
export const clock = t => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
export const money = p => (p === '' || p == null) ? '—' : '$' + Number(p).toFixed(2);
const uuid = () => crypto.randomUUID();
const byTime = (a, b) => a.scannedAt - b.scannedAt;

export const sessionScans = () => state.scans.filter(x => state.session && x.sessionId === state.session.id);
export const waiting = () => state.scans.filter(x => x.status === 'queued' || x.status === 'unread');
export const held = () => state.scans.filter(x => x.status === 'held');

export function tabBase(naming, store, date) {
  const s = (store || '').trim() || '—';
  return { date, store: 'Store ' + s, both: date + ' · ' + s }[naming];
}

// Smallest " (n)" suffix whose name hasn't been used by an earlier session.
export function nextTabName(naming = state.settings.naming, store = state.settings.store) {
  const base = tabBase(naming, store, ymd(Date.now()));
  for (let n = 1; ; n++) {
    const name = n > 1 ? `${base} (${n})` : base;
    if (!state.usedTabs.includes(name)) return name;
  }
}

async function saveScan(scan) {
  const i = state.scans.findIndex(x => x.id === scan.id);
  if (i >= 0) state.scans[i] = scan; else state.scans.push(scan);
  await scanPut(scan);
}

async function removeScan(id) {
  state.scans = state.scans.filter(x => x.id !== id);
  await scanDelete(id);
}

let toastTimer;
export function toast(t, ms = 2200) {
  state.ui.toast = t;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { state.ui.toast = null; render(); }, ms);
  render();
}

function setOnline(v) {
  if (state.ui.online !== v) { state.ui.online = v; render(); }
}

// ── boot & settings ──────────────────────────────────────────────────────

export async function load() {
  state.settings = { ...DEFAULT_SETTINGS, ...(await kvGet('settings')) };
  state.session = (await kvGet('session')) || null;
  state.loc = (await kvGet('loc')) || '';
  state.recents = (await kvGet('recents')) || [];
  state.usedTabs = (await kvGet('usedTabs')) || [];
  state.tabs = (await kvGet('tabs')) || {};
  state.summary = (await kvGet('summary')) || null;
  state.scans = ((await scansAll()) || []).sort(byTime);
  if (!state.settings.setupDone) state.ui.screen = 'setup';
  else if (state.session) state.ui.screen = 'scan';
  else if (state.summary) state.ui.screen = 'ended';
  else { await startSession(); state.ui.screen = 'scan'; }
}

export async function saveSettings(patch) {
  Object.assign(state.settings, patch);
  await kvSet('settings', state.settings);
  // A session that hasn't written anything yet follows naming changes.
  if (state.session && ('naming' in patch || 'store' in patch) && !sessionScans().length) {
    state.session.tab = nextTabName();
    await kvSet('session', state.session);
  }
  render();
}

export async function setLoc(v) {
  state.loc = v;
  await kvSet('loc', v);
}

async function pushRecent(loc) {
  if (!loc || loc === '—') return;
  state.recents = [loc, ...state.recents.filter(x => x !== loc)].slice(0, 6);
  await kvSet('recents', state.recents);
}

export async function testConnection() {
  state.ui.ping = { status: 'testing', error: '' };
  render();
  try {
    const r = await sheetCall(state.settings, 'ping');
    await saveSettings({ sheetName: r.spreadsheet, sheetUrl: r.url });
    state.ui.ping = { status: 'ok', error: '' };
  } catch (e) {
    state.ui.ping = { status: 'error', error: e instanceof OfflineError ? 'Couldn’t reach the script. Check the URL and your signal.' : e.message };
  }
  render();
}

// ── sessions ─────────────────────────────────────────────────────────────

export async function startSession() {
  state.session = { id: uuid(), tab: nextTabName(), startedAt: Date.now() };
  state.summary = null;
  await kvSet('session', state.session);
  await kvSet('summary', null);
}

export async function endSession() {
  const s = state.session;
  for (const x of sessionScans().filter(x => x.status === 'held')) await removeScan(x.id);
  const kept = sessionScans().sort(byTime);
  const counts = {};
  kept.forEach(x => { counts[x.loc] = (counts[x.loc] || 0) + 1; });
  const queued = kept.filter(x => x.status !== 'logged').length;
  state.summary = {
    tab: s.tab,
    range: kept.length ? clock(kept[0].scannedAt) + ' – ' + clock(kept[kept.length - 1].scannedAt) : 'No scans',
    rows: kept.length - queued, queued,
    locs: Object.entries(counts).map(([name, n]) => ({ name, n })),
    url: state.tabs[s.tab]?.url || state.settings.sheetUrl,
  };
  if (kept.length && !state.usedTabs.includes(s.tab)) state.usedTabs.push(s.tab);
  state.session = null;
  state.ui.endConfirm = false;
  state.ui.screen = 'ended';
  await kvSet('usedTabs', state.usedTabs);
  await kvSet('session', null);
  await kvSet('summary', state.summary);
  render();
}

// ── capture → read → commit ──────────────────────────────────────────────

function applyParse(scan, parsed) {
  Object.assign(scan, { sku: parsed.sku, desc: parsed.desc, price: parsed.price, conf: parsed.conf });
  const weak = weakestField(parsed, state.settings.threshold);
  scan.flag = weak;
  scan.status = weak ? 'held' : 'queued';
  state.ui.lastRead = { ...parsed, threshold: state.settings.threshold };
}

export async function captured({ blob, height }) {
  const ses = state.session;
  const scan = {
    id: uuid(), sessionId: ses.id, tab: ses.tab, loc: state.loc.trim() || '—', scannedAt: Date.now(),
    image: blob, imgH: height, status: 'unread', sku: '', desc: '', price: '', conf: null, flag: null,
  };
  await pushRecent(scan.loc);
  if (!usedTabMarked(ses.tab)) { state.usedTabs.push(ses.tab); await kvSet('usedTabs', state.usedTabs); }

  let resp;
  try {
    resp = await readText(blob, state.settings.visionKey);
    setOnline(true);
  } catch (e) {
    if (e instanceof OfflineError) {
      setOnline(false);
      await saveScan(scan);
      toast({ kind: 'queued', title: 'Saved on phone', sub: 'Reads and sends when signal returns' });
    } else {
      Object.assign(scan, { status: 'held', flag: { field: 'sku', conf: 0 }, error: e.message });
      await saveScan(scan);
      toast({ kind: 'held', title: 'Held for review', sub: 'Couldn’t read tag · ' + e.message });
    }
    return;
  }

  applyParse(scan, parseTag(resp, height));
  if (scan.status === 'held') {
    await saveScan(scan);
    toast({ kind: 'held', title: 'Held for review', sub: FIELD_NAME[scan.flag.field] + ' · ' + scan.flag.conf + '%' });
    return;
  }
  const existing = sessionScans().find(x => x.sku === scan.sku && x.status !== 'held' && x.status !== 'unread');
  if (existing) {
    state.ui.dupe = { rec: scan, existing };
    state.ui.toast = null;
    render();
    return;
  }
  await commit(scan);
}

const usedTabMarked = tab => state.usedTabs.includes(tab);

async function commit(scan) {
  scan.status = 'queued';
  await saveScan(scan);
  render();
  await flush();
  const s = state.scans.find(x => x.id === scan.id);
  if (s?.status === 'logged') toast({ kind: 'logged', title: `Row ${s.row} · ${money(s.price)}`, sub: s.desc });
  else toast({ kind: 'queued', title: 'Saved on phone · ' + money(scan.price), sub: 'Sends when signal returns' });
}

export async function dupeChoice(choice) {
  const { rec, existing } = state.ui.dupe;
  state.ui.dupe = null;
  if (choice === 'skip') { render(); return; }
  if (choice === 'new') { await commit(rec); return; }
  // Update the earlier row with this scan's price, location and time.
  Object.assign(existing, { price: rec.price, loc: rec.loc, scannedAt: rec.scannedAt });
  if (existing.status === 'logged') existing.dirty = true;
  await saveScan(existing);
  render();
  await flush();
  toast({ kind: 'logged', title: (existing.row ? 'Row ' + existing.row : 'Waiting row') + ' updated · ' + money(rec.price), sub: rec.desc });
}

// ── edit / review ────────────────────────────────────────────────────────

export function openEdit(id) {
  const r = state.scans.find(x => x.id === id);
  if (!r) return;
  state.ui.editId = id;
  state.ui.draft = { sku: r.sku, desc: r.desc, price: r.price, loc: r.loc === '—' ? '' : r.loc };
  state.ui.screen = 'edit';
  render();
}

export function draftError(d) {
  if (!d) return '';
  if (!/^\d{4,8}$/.test(d.sku.trim())) return 'Item number should be 4–8 digits.';
  if (!/^\d+(\.\d{2})?$/.test(d.price.trim())) return 'Price should look like 19.99.';
  if (!d.desc.trim()) return 'Add a description.';
  return '';
}

export async function saveEdit() {
  const d = state.ui.draft, r = state.scans.find(x => x.id === state.ui.editId);
  if (!r || draftError(d)) return;
  Object.assign(r, { sku: d.sku.trim(), desc: d.desc.trim(), price: Number(d.price).toFixed(2), loc: d.loc.trim() || r.loc });
  if (r.status === 'held' || r.status === 'unread') { r.status = 'queued'; r.flag = null; r.error = undefined; }
  else if (r.status === 'logged') r.dirty = true;
  await saveScan(r);
  state.ui.screen = 'review'; state.ui.editId = null; state.ui.draft = null;
  render();
  flush();
}

export async function discardEdit() {
  const r = state.scans.find(x => x.id === state.ui.editId);
  if (r && r.status === 'held') await removeScan(r.id);
  state.ui.screen = 'review'; state.ui.editId = null; state.ui.draft = null;
  render();
}

// ── outbox ───────────────────────────────────────────────────────────────

let running = null, pending = null;

// Serialised: a call made while a flush is running waits for one more pass after it.
export function flush() {
  if (!running) { running = doFlush().finally(() => { running = null; }); return running; }
  if (!pending) pending = running.then(() => { pending = null; return flush(); });
  return pending;
}

async function ensureTab(tab) {
  if (state.tabs[tab]) return;
  const r = await sheetCall(state.settings, 'ensureTab', { tab });
  state.tabs[tab] = { sheetId: r.sheetId, url: r.url };
  await kvSet('tabs', state.tabs);
}

async function doFlush() {
  if (!state.settings.setupDone) return;
  const wasOffline = !state.ui.online;
  try {
    // 1. Read text for images captured with no signal. Uncertain ones go to review.
    for (const x of state.scans.filter(s => s.status === 'unread').sort(byTime)) {
      try {
        const resp = await readText(x.image, state.settings.visionKey);
        applyParse(x, parseTag(resp, x.imgH));
      } catch (e) {
        if (e instanceof OfflineError) throw e;
        Object.assign(x, { status: 'held', flag: { field: 'sku', conf: 0 }, error: e.message });
      }
      await saveScan(x);
      setOnline(true);
    }

    if (state.settings.paused) return;
    const queued = state.scans.filter(s => s.status === 'queued').sort(byTime);
    const dirty = state.scans.filter(s => s.status === 'logged' && s.dirty);
    if (!queued.length && !dirty.length) return;
    state.ui.syncing = true; render();

    // 2. Append the rest in scan order, one call per tab. The script skips Scan IDs it already has.
    let sent = 0;
    const tabs = [...new Set(queued.map(s => s.tab))];
    for (const tab of tabs) {
      await ensureTab(tab);
      const rows = queued.filter(s => s.tab === tab);
      const res = await sheetCall(state.settings, 'append', {
        tab, rows: rows.map(s => ({ id: s.id, sku: s.sku, desc: s.desc, price: s.price, loc: s.loc, scannedAt: sheetTime(s.scannedAt) })),
      });
      for (const r of res.rows) {
        const s = state.scans.find(x => x.id === r.id);
        if (!s) continue;
        Object.assign(s, { status: 'logged', row: r.row, image: null });
        await saveScan(s);
        sent++;
      }
    }

    // 3. Edits to rows already on the sheet.
    for (const s of dirty) {
      await sheetCall(state.settings, 'update', {
        tab: s.tab, row: { id: s.id, sku: s.sku, desc: s.desc, price: s.price, loc: s.loc, scannedAt: sheetTime(s.scannedAt) },
      });
      s.dirty = false;
      await saveScan(s);
    }
    setOnline(true);
    if (wasOffline && sent) toast({ kind: 'logged', title: sent + (sent === 1 ? ' row' : ' rows') + ' sent to sheet', sub: 'Signal is back' }, 3600);
  } catch (e) {
    if (e instanceof OfflineError) setOnline(false);
    else toast({ kind: 'held', title: 'Sheet error', sub: e.message }, 3600);
  } finally {
    state.ui.syncing = false;
    render();
  }
}

export const hasOutbox = () => state.scans.some(s => s.status === 'queued' || s.status === 'unread' || s.dirty);
