// Screen templates. Each returns an HTML string; app.js handles events via data-act / data-bind.

import { icon, corners } from './icons.js';
import {
  state, FIELD_NAME, money, clock, sheetTime, sessionScans, waiting, held, draftError, nextTabName,
} from './store.js';

export const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const plural = (n, one, many) => n + ' ' + (n === 1 ? one : many);

const seg = (act, opts, cur) => `<div class="seg seg-full">${opts.map(([v, label]) =>
  `<button class="seg-btn${v === cur ? ' on' : ''}" data-act="${act}" data-v="${v}">${label}</button>`).join('')}</div>`;

const primary = (label, act, attrs = '') =>
  `<button class="btn btn-primary blueprint btn-lg" data-act="${act}" ${attrs}>${corners()}${label}</button>`;

const currentTab = () => state.session ? state.session.tab : nextTabName();

// ── 1. Setup ─────────────────────────────────────────────────────────────

function setup() {
  const { setupStep: step, ping } = state.ui, s = state.settings;
  const connected = ping.status === 'ok' || (ping.status === 'idle' && !!s.sheetName);
  const nextDisabled = step === 1 && !(connected && s.visionKey.trim());
  let body = '';
  if (step === 1) {
    body = `
      <div><h2>Connect Google</h2><p class="lede">Scans are written as rows in a Google Sheet in your Drive. The app only gets access to the sheet you pick.</p></div>
      <div class="field"><label for="f-url">Apps Script web app URL</label><input id="f-url" class="input input-lg" type="url" inputmode="url" autocomplete="off" placeholder="https://script.google.com/macros/s/…/exec" data-bind="settings.scriptUrl" value="${esc(s.scriptUrl)}"></div>
      <div class="field"><label for="f-token">Token</label><input id="f-token" class="input input-lg" autocomplete="off" data-bind="settings.token" value="${esc(s.token)}"></div>
      <div class="field"><label for="f-key">Cloud Vision API key</label><input id="f-key" class="input input-lg" autocomplete="off" data-bind="settings.visionKey" value="${esc(s.visionKey)}"></div>
      ${connected
        ? `<div class="card blueprint">${corners()}<span class="card-kicker">Connected to</span><div class="row-between"><span class="card-title">${esc(s.sheetName)}</span><span class="tag tag-accent">Connected</span></div></div>`
        : primary(ping.status === 'testing' ? 'Testing…' : 'Test connection', 'test-connection', ping.status === 'testing' || !s.scriptUrl || !s.token ? 'disabled' : '')}
      ${ping.status === 'error' ? `<div class="error">${esc(ping.error)}</div>` : ''}
      ${connected && !s.visionKey.trim() ? `<div class="hint">Add the Vision API key to continue.</div>` : ''}`;
  } else if (step === 2) {
    body = `
      <div><h2>Choose a spreadsheet</h2><p class="lede">Each session adds a new tab to it.</p></div>
      <div class="radio-list">
        <label class="radio radio-row"><input type="radio" name="sheet" checked><span class="dot"></span>
          <span class="stack"><span class="strong">${esc(s.sheetName)}</span><span class="small muted">Attached to your Apps Script</span></span></label>
      </div>
      <div class="hint">To use a different spreadsheet, add the script to that sheet and paste its URL in step 1.</div>`;
  } else {
    body = `
      <div><h2>Session tabs</h2><p class="lede">A new tab is started each session. Pick how it's named.</p></div>
      ${seg('naming', [['date', 'Date'], ['store', 'Store'], ['both', 'Date + store']], s.naming)}
      <div class="field"><label for="f-store">Store</label><input id="f-store" class="input input-lg" inputmode="numeric" data-bind="settings.store" value="${esc(s.store)}"></div>
      <div class="blueprint first-tab">${corners()}
        <div class="kicker-muted">FIRST TAB</div>
        <div class="mono" data-live="tabname">${esc(currentTab())}</div>
        <div class="small muted-700">Item number · Description · Price · Location · Scanned at</div>
      </div>`;
  }
  return `
    <div class="page page-setup">
      <div class="steps">
        <div class="kicker">STEP ${step} OF 3</div>
        <div class="step-bars">${[1, 2, 3].map(i => `<span class="${i <= step ? 'on' : ''}"></span>`).join('')}</div>
      </div>
      ${body}
      <div class="grow"></div>
      <div class="btn-pair">
        <button class="btn btn-secondary btn-lg" data-act="setup-back" ${step === 1 ? 'disabled' : ''}>Back</button>
        ${primary(step === 3 ? 'Start scanning' : 'Continue', 'setup-next', nextDisabled ? 'disabled' : '')}
      </div>
    </div>`;
}

// ── 2. Scan ──────────────────────────────────────────────────────────────

function readingRows() {
  const r = state.ui.lastRead, th = state.settings.threshold;
  const rows = [['SKU', 'sku'], ['ITEM', 'desc'], ['PRICE', 'price']];
  return rows.map(([label, f]) => {
    const value = !r ? '—' : f === 'price' ? (r.price ? money(r.price) : '—') : (r[f] || '—');
    const conf = r ? r.conf[f] : null;
    const mark = !r ? '' : conf < th ? `<span class="tag tag-read">${conf}%</span>` : `<span class="ok">${icon('check', 16)}</span>`;
    return `<div class="read-row"><span class="read-label">${label}</span><span class="read-value">${esc(value)}</span>${mark}</div>`;
  }).join('');
}

function toastView() {
  const t = state.ui.toast;
  if (!t) return '';
  const ic = t.kind === 'held' ? icon('triangle-alert', 18) : icon('check', 18);
  return `<div class="toast toast-${t.kind}" role="status">${ic}<div class="toast-text"><div class="toast-title">${esc(t.title)}</div><div class="toast-sub">${esc(t.sub)}</div></div></div>`;
}

function dupeView() {
  const d = state.ui.dupe;
  if (!d) return '';
  const { rec, existing: ex } = d;
  const where = ex.row ? 'ROW ' + ex.row : 'WAITING';
  const changed = Number(ex.price) !== Number(rec.price);
  return `
    <div class="dialog-backdrop local">
      <div class="dialog blueprint" role="dialog" aria-modal="true">${corners()}
        <div><div class="card-kicker">Duplicate</div><div class="dialog-title">Already scanned this session</div></div>
        <div class="dupe-item"><span class="strong">${esc(rec.desc)}</span> <span class="muted">#${esc(rec.sku)}</span></div>
        <div class="dupe-grid">
          <div><span class="dupe-k">EARLIER · ${where}</span><span class="dupe-p">${money(ex.price)}</span><span class="dupe-m">${esc(ex.loc)} · ${clock(ex.scannedAt)}</span></div>
          <div><span class="dupe-k accent">THIS SCAN</span><span class="dupe-p">${money(rec.price)}</span><span class="dupe-m">${esc(rec.loc)} · now</span></div>
        </div>
        ${changed ? `<div class="note">Price differs from the earlier scan.</div>` : ''}
        <div class="stack gap8">
          ${primary('Update ' + (ex.row ? 'row ' + ex.row : 'waiting row'), 'dupe', 'data-v="update"')}
          <div class="grid2 gap8">
            <button class="btn btn-secondary btn-md" data-act="dupe" data-v="new">Log as new row</button>
            <button class="btn btn-secondary btn-md" data-act="dupe" data-v="skip">Skip</button>
          </div>
        </div>
      </div>
    </div>`;
}

export function recentsView() {
  if (!state.ui.locOpen || !state.recents.length) return '';
  const ses = sessionScans();
  return `<div class="recents">
    <div class="recents-head">RECENT LOCATIONS</div>
    ${state.recents.map(name => {
      const n = ses.filter(x => x.loc === name && x.status !== 'held').length;
      return `<button class="recent${name === state.loc ? ' current' : ''}" data-act="pick-loc" data-v="${esc(name)}">${icon('map-pin', 16)}<span class="grow">${esc(name)}</span><span class="small muted">${n ? n + ' scanned' : ''}</span></button>`;
    }).join('')}
  </div>`;
}

export const AUTO_TEXT = { search: 'AUTO · HOLD STEADY ON A TAG', steady: 'AUTO · HOLD STILL…', next: 'AUTO · MOVE TO THE NEXT TAG' };

function scan() {
  const ui = state.ui, auto = state.settings.mode === 'auto';
  const ses = sessionScans();
  const logged = ses.filter(x => x.status === 'logged').length;
  const heldN = held().length, waitN = waiting().length;
  const showSync = (!ui.online && waitN > 0) || ui.syncing;
  return `
    <div class="scan">
      <div class="cam" data-cam>
        <div class="cam-slot" data-video-slot></div>
        ${ui.camError ? `<div class="cam-msg">${esc(ui.camError)}<button class="btn btn-secondary btn-md on-dark" data-act="retry-camera">Try again</button></div>` : ''}
        ${ui.flash ? '<div class="flash"></div>' : ''}
        <div class="cam-top">
          <button class="chip-dark" data-act="go" data-v="settings">${icon('table', 14)}<span>${esc(currentTab())}</span></button>
          <span class="grow"></span>
          ${ui.torchAvailable ? `<button class="chip-dark${ui.torch ? ' on' : ''}" data-act="torch" aria-label="Torch" aria-pressed="${ui.torch}">${icon('flashlight', 14)}</button>` : ''}
          ${showSync ? `<button class="chip-light" data-act="go" data-v="review">${icon('wifi-off', 14)}<span>${ui.syncing ? 'Sending ' + waitN + '…' : 'No signal · ' + waitN + ' waiting'}</span></button>` : ''}
        </div>
        <div class="reticle${auto ? ' auto' : ''}" data-reticle>
          ${auto ? `<span class="reticle-label" data-auto-label>${AUTO_TEXT[ui.autoStatus] || AUTO_TEXT.search}</span>` : ''}
          <i class="br-tl"></i><i class="br-tr"></i><i class="br-bl"></i><i class="br-br"></i>
        </div>
        ${toastView()}
        ${dupeView()}
        <div class="reading">
          <div class="reading-head">${ui.busy ? 'READING…' : 'READING'}</div>
          ${readingRows()}
        </div>
      </div>
      <div class="controls">
        <div data-part="recents">${recentsView()}</div>
        <label class="loc">
          <span class="loc-label">LOCATION</span>
          <span class="loc-box">${icon('map-pin', 16)}<input data-bind="loc" data-loc value="${esc(state.loc)}" placeholder="e.g. Fence" autocomplete="off" enterkeyhint="done"></span>
        </label>
        <div class="mode">
          <button class="${!auto ? 'on' : ''}" data-act="mode" data-v="manual">${icon('target', 18)}MANUAL</button>
          <button class="${auto ? 'on' : ''}" data-act="mode" data-v="auto">${icon('zap', 18)}AUTO</button>
        </div>
        <div class="shutter-row">
          <span></span>
          <button class="btn btn-primary blueprint shutter" data-act="capture" aria-label="Capture tag" ${ui.busy || ui.camError ? 'aria-disabled="true"' : ''}>${corners('color:var(--color-accent-300)')}${icon('scan-line', 30)}</button>
          <button class="counts" data-act="go" data-v="review">
            <span class="counts-main">${logged} <span class="counts-label">logged</span></span>
            <span class="counts-held${heldN ? ' has' : ''}">${heldN} to review</span>
          </button>
        </div>
      </div>
    </div>`;
}

// ── 3. Review ────────────────────────────────────────────────────────────

const metaTab = x => state.session && x.tab !== state.session.tab ? ' · ' + esc(x.tab) : '';

function review() {
  const ses = sessionScans();
  const hs = held(), ws = waiting().sort((a, b) => a.scannedAt - b.scannedAt);
  const logged = ses.filter(x => x.status === 'logged').sort((a, b) => b.row - a.row);
  const ui = state.ui;
  const queueNote = ui.syncing ? 'Sending…' : (ui.online ? (state.settings.paused ? 'Paused' : '') : 'No signal');
  return `
    <div class="page">
      <div>
        <div class="kicker">TAB · ${esc(currentTab())}</div>
        <h2 class="tight">Session review</h2>
        <div class="sub">${logged.length} rows on the sheet · ${hs.length} held · ${ws.length} waiting</div>
        <button class="btn btn-secondary btn-md full mt12" data-act="ask-end">End session</button>
      </div>
      ${hs.length ? `
        <div class="stack gap10">
          <h6 class="accent-700">Needs a look</h6>
          ${hs.map(s => `
            <button class="card blueprint held-card" data-act="open" data-id="${s.id}">${corners()}
              <div class="row-between baseline"><span class="card-kicker">${s.error ? 'Couldn’t read tag' : FIELD_NAME[s.flag?.field] || 'Check this read'}</span><span class="tag tag-accent">${s.flag?.conf ?? 0}%</span></div>
              <div class="row-between baseline"><span class="card-title">${esc(s.desc || 'Unknown item')}</span><span class="price-20">${money(s.price)}</span></div>
              <div class="card-meta"><span>#${esc(s.sku || '—')}</span><span>·</span><span>${esc(s.loc)}${metaTab(s)}</span></div>
            </button>`).join('')}
        </div>` : `<div class="empty">Nothing held. Every read went straight to the sheet.</div>`}
      ${ws.length ? `
        <div class="stack">
          <div class="row-between baseline mb6"><h6 class="muted-700">Waiting to send</h6><span class="small muted">${queueNote}</span></div>
          ${ws.map(s => `
            <div class="list-row dashed">
              <span class="muted">${icon('clock', 16)}</span>
              <span class="list-main"><span class="list-title">${esc(s.status === 'unread' ? 'Not read yet' : s.desc)}</span><span class="list-meta">#${esc(s.sku || '—')} · ${esc(s.loc)} · ${clock(s.scannedAt)}${metaTab(s)}</span></span>
              <span class="price-17 muted-700">${money(s.price)}</span>
            </div>`).join('')}
        </div>` : ''}
      <div class="stack">
        <h6 class="muted-700 mb6">On the sheet</h6>
        ${logged.length ? logged.map(s => `
          <button class="list-row" data-act="open" data-id="${s.id}">
            <span class="row-no">R${s.row}</span>
            <span class="list-main"><span class="list-title">${esc(s.desc)}</span><span class="list-meta">#${esc(s.sku)} · ${esc(s.loc)} · ${clock(s.scannedAt)}${s.dirty ? ' · update waiting' : ''}</span></span>
            <span class="price-17">${money(s.price)}</span>
          </button>`).join('') : '<div class="small muted">No rows yet.</div>'}
      </div>
    </div>`;
}

// ── 4. Edit ──────────────────────────────────────────────────────────────

let imgUrl = { id: null, url: null };
function imageUrl(r) {
  if (imgUrl.id === r.id) return imgUrl.url;
  if (imgUrl.url) URL.revokeObjectURL(imgUrl.url);
  imgUrl = { id: r.id, url: r.image ? URL.createObjectURL(r.image) : null };
  return imgUrl.url;
}

function edit() {
  const r = state.scans.find(x => x.id === state.ui.editId);
  if (!r) return review();
  const d = state.ui.draft, isHeld = r.status === 'held';
  const err = draftError(d);
  const low = f => isHeld && r.flag?.field === f ? `<span class="tag tag-accent tag-tight">check · ${r.flag.conf}%</span>` : '';
  const url = imageUrl(r);
  return `
    <div class="page page-edit">
      <div class="edit-head">
        <button class="btn btn-ghost btn-icon44" data-act="go" data-v="review" aria-label="Back">${icon('chevron-left', 20)}</button>
        <span class="edit-title">${isHeld ? 'Check this read' : r.status === 'logged' ? 'Edit row ' + r.row : 'Edit waiting row'}</span>
      </div>
      <div class="edit-body">
        <div class="blueprint tag-img">${corners()}${url ? `<img src="${url}" alt="Captured tag">` : '<span class="small muted">Photo removed once the row was saved</span>'}</div>
        <div class="caption">Captured ${clock(r.scannedAt)}${url ? ' · photo kept until this row is saved' : ''}</div>
        ${r.error ? `<div class="error">${esc(r.error)}</div>` : ''}
        <div class="field"><label class="row-between"><span>Item number</span>${low('sku')}</label><input class="input input-lg" inputmode="numeric" data-bind="draft.sku" value="${esc(d.sku)}"></div>
        <div class="field"><label class="row-between"><span>Description</span>${low('desc')}</label><input class="input input-lg" data-bind="draft.desc" value="${esc(d.desc)}"></div>
        <div class="grid-110">
          <div class="field"><label class="row-between"><span>Price</span>${low('price')}</label><input class="input input-lg" inputmode="decimal" data-bind="draft.price" value="${esc(d.price)}"></div>
          <div class="field"><label>Location</label><input class="input input-lg" data-bind="draft.loc" value="${esc(d.loc)}"></div>
        </div>
        <div class="error" data-live="draft-error" ${err ? '' : 'hidden'}>${esc(err)}</div>
        <div class="btn-pair mt4">
          <button class="btn btn-secondary btn-lg" data-act="discard">${isHeld ? 'Discard' : 'Cancel'}</button>
          ${primary(isHeld ? 'Log to sheet' : 'Update row', 'save-edit', (err ? 'disabled ' : '') + 'data-live="save"')}
        </div>
      </div>
    </div>`;
}

// ── 5. Sheet (settings) ──────────────────────────────────────────────────

function sheet() {
  const s = state.settings;
  return `
    <div class="page gap22">
      <div><h2 class="tight">Sheet</h2><div class="sub">Where scans are written</div></div>
      <div class="card blueprint">${corners()}
        <span class="card-kicker">Google account</span>
        <div class="row-between"><span class="card-title">Apps Script web app</span><span class="tag tag-accent">Connected</span></div>
        <div class="row-between sheet-row">
          <div><div class="small muted">Spreadsheet</div><div class="strong">${esc(s.sheetName || '—')}</div></div>
          <button class="btn btn-ghost btn-h44" data-act="rerun-setup">Change</button>
        </div>
      </div>
      <div class="stack gap10">
        <h6>New tab each session, named by</h6>
        ${seg('naming', [['date', 'Date'], ['store', 'Store'], ['both', 'Date + store']], s.naming)}
        <div class="field"><label for="s-store">Store</label><input id="s-store" class="input input-lg" inputmode="numeric" data-bind="settings.store" value="${esc(s.store)}"></div>
        <div class="row-between text14"><span class="muted-700">Current tab</span><span class="mono" data-live="tabname">${esc(currentTab())}</span></div>
        <button class="btn btn-secondary btn-md" data-act="new-session-tab">Start new session tab</button>
      </div>
      <div class="stack gap6">
        <h6>Columns</h6>
        <table class="table"><tbody>
          ${[['A', 'Item number'], ['B', 'Description'], ['C', 'Price'], ['D', 'Location']].map(([c, n]) => `<tr><td class="col-letter">${c}</td><td>${n}</td></tr>`).join('')}
          <tr><td class="col-letter">E</td><td>Scanned at <span class="small muted">· ${sheetTime(Date.now())}</span></td></tr>
        </tbody></table>
      </div>
      <div class="stack gap10">
        <h6>Hold for review when a read is below</h6>
        ${seg('threshold', [[70, '70%'], [80, '80%'], [90, '90%']], s.threshold)}
        <div class="small muted">Higher holds more scans but catches more misreads.</div>
      </div>
      <div class="stack gap10">
        <h6>Sending</h6>
        ${seg('paused', [['false', 'Send right away'], ['true', 'Pause sending']], String(s.paused))}
        <div class="small muted">While paused, scans are read and kept on the phone, then sent in scan order when you resume. Each row keeps its scan time.</div>
      </div>
      <button class="btn btn-ghost btn-h44 self-start" data-act="rerun-setup">Run setup again</button>
    </div>`;
}

// ── 6. Session ended ─────────────────────────────────────────────────────

function ended() {
  const sm = state.summary || { tab: '', range: '', rows: 0, queued: 0, locs: [] };
  return `
    <div class="page page-ended">
      <div><div class="kicker">TAB · ${esc(sm.tab)}</div><h2 class="tight">Session ended</h2><div class="sub">${esc(sm.range)}</div></div>
      <div class="stat-grid">
        <div><span class="stat">${sm.rows}</span><span class="small muted-700">rows on the sheet</span></div>
        <div><span class="stat">${sm.locs.length}</span><span class="small muted-700">locations</span></div>
      </div>
      ${sm.queued ? `<div class="note">${sm.queued} more will be sent when signal returns.</div>` : ''}
      <div class="stack">
        <h6 class="muted-700 mb6">By location</h6>
        ${sm.locs.map(l => `<div class="loc-row"><span>${esc(l.name)}</span><span class="muted-700">${plural(l.n, 'scan', 'scans')}</span></div>`).join('')}
      </div>
      <div class="grow"></div>
      <div class="stack gap10">
        ${sm.url ? `<a class="btn btn-secondary btn-lg" href="${esc(sm.url)}" target="_blank" rel="noopener">Open in Google Sheets</a>` : ''}
        ${primary('Start new session', 'new-session')}
      </div>
    </div>`;
}

// ── frame ────────────────────────────────────────────────────────────────

function endConfirm() {
  if (!state.ui.endConfirm) return '';
  const h = sessionScans().filter(x => x.status === 'held').length;
  const q = sessionScans().filter(x => x.status === 'queued' || x.status === 'unread').length;
  return `
    <div class="dialog-backdrop local z10">
      <div class="dialog blueprint" role="dialog" aria-modal="true">${corners()}
        <div class="dialog-title">End this session?</div>
        <div class="dialog-body stack gap6">
          ${h ? `<span>${h} held scan(s) haven't been logged and will be discarded.</span>` : ''}
          ${q ? `<span>${q} row(s) are waiting for signal. They'll still be sent to this tab.</span>` : ''}
        </div>
        <div class="grid-14 gap8">
          <button class="btn btn-secondary btn-md" data-act="cancel-end">Keep scanning</button>
          <button class="btn btn-primary blueprint btn-md" data-act="confirm-end">${corners()}End session</button>
        </div>
      </div>
    </div>`;
}

function nav() {
  const sc = state.ui.screen, h = held().length;
  const item = (s, ic, label, extra = '') =>
    `<button class="nav-btn${sc === s || (s === 'review' && sc === 'edit') ? ' on' : ''}" data-act="go" data-v="${s}">${icon(ic, 22)}${label}${extra}</button>`;
  return `<nav class="bottom-nav">
    ${item('scan', 'scan-line', 'Scan')}
    ${item('review', 'list-checks', 'Review', h ? `<span class="badge">${h}</span>` : '')}
    ${item('settings', 'table', 'Sheet')}
  </nav>`;
}

const SCREENS = { setup, scan, review, edit, settings: sheet, ended };

export function app() {
  const sc = state.ui.screen;
  const showNav = sc !== 'setup' && sc !== 'ended';
  return `<main class="screen ${sc === 'scan' ? 'dark' : ''}">${SCREENS[sc]()}</main>${showNav ? nav() : ''}${endConfirm()}`;
}

export { currentTab };
