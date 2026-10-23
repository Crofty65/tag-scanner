// Bootstrap: rendering, event delegation, camera / Auto / wake-lock lifecycle, retry timers.

import * as S from './store.js';
import { state } from './store.js';
import { app, recentsView, currentTab, AUTO_TEXT } from './views.js';
import { startCamera, stopCamera, captureCrop, torchSupported, setTorch, createAutoDetector } from './camera.js';

const root = document.getElementById('app');

// One <video> for the app's lifetime, moved into each new Scan render so the stream never restarts.
const video = document.createElement('video');
Object.assign(video, { muted: true, playsInline: true, autoplay: true, className: 'video' });
video.setAttribute('playsinline', '');

// ── rendering ────────────────────────────────────────────────────────────

let lastScreen = null, deferred = false, queued = false;

const typing = () => {
  const a = document.activeElement;
  return a && root.contains(a) && a.matches('input[data-bind]');
};

function renderAll() {
  // Re-rendering a focused input breaks Android keyboard composition, so wait until it blurs.
  if (typing() && state.ui.screen === lastScreen) { deferred = true; return; }
  deferred = false;
  const main = root.querySelector('main');
  const keepScroll = state.ui.screen === lastScreen && main ? main.scrollTop : 0;
  root.innerHTML = app();
  const slot = root.querySelector('[data-video-slot]');
  if (slot) { slot.appendChild(video); video.play().catch(() => {}); }
  const nextMain = root.querySelector('main');
  if (nextMain) nextMain.scrollTop = keepScroll;
  lastScreen = state.ui.screen;
  syncLifecycle();
}

function render() {
  if (queued) return;
  queued = true;
  queueMicrotask(() => { queued = false; renderAll(); });
}
S.onChange(render);

function renderRecents() {
  const part = root.querySelector('[data-part="recents"]');
  if (part) part.innerHTML = recentsView();
  syncLifecycle();
}

// Small in-place updates while an input has focus.
function patchLive() {
  root.querySelectorAll('[data-live="tabname"]').forEach(el => { el.textContent = currentTab(); });
  const d = state.ui.draft;
  if (d) {
    const err = S.draftError(d);
    const box = root.querySelector('[data-live="draft-error"]');
    if (box) { box.textContent = err; box.hidden = !err; }
    const save = root.querySelector('[data-live="save"]');
    if (save) save.disabled = !!err;
  }
  if (state.ui.screen === 'setup') {
    const s = state.settings;
    const test = root.querySelector('[data-act="test-connection"]');
    if (test) test.disabled = !s.scriptUrl || !s.token;
    const next = root.querySelector('[data-act="setup-next"]');
    const connected = state.ui.ping.status === 'ok' || (state.ui.ping.status === 'idle' && !!s.sheetName);
    if (next && state.ui.setupStep === 1) next.disabled = !(connected && s.visionKey.trim());
  }
}

// ── camera, Auto, wake lock ──────────────────────────────────────────────

let cameraOn = false, cameraStarting = false, wakeLock = null;
const reticle = () => root.querySelector('[data-reticle]');

const canCapture = () => {
  const ui = state.ui;
  return cameraOn && !ui.busy && !ui.dupe && !ui.endConfirm && !ui.camError;
};

// Auto's label shows what it is waiting for; updated in place, ~8 times a second.
const debugAuto = location.search.includes('debug');
function onAutoStatus(status, n) {
  state.ui.autoStatus = status;
  const el = root.querySelector('[data-auto-label]');
  if (!el) return;
  el.textContent = AUTO_TEXT[status] + (debugAuto
    ? ` · shake ${n.shake.toFixed(1)} · moved ${n.moved.toFixed(1)} · tag ${Math.round(n.share * 100)}%` : '');
}

const auto = createAutoDetector(() => {
  if (!canCapture()) return false;
  doCapture();
  return true;
}, onAutoStatus);

function syncLifecycle() {
  const ui = state.ui;
  const onScan = ui.screen === 'scan' && document.visibilityState === 'visible';

  if (onScan && !cameraOn && !cameraStarting && !ui.camError) {
    cameraStarting = true;
    startCamera(video)
      .then(() => { cameraOn = true; ui.torchAvailable = torchSupported(); render(); })
      .catch(e => { ui.camError = cameraMessage(e); render(); })
      .finally(() => { cameraStarting = false; syncLifecycle(); });
  } else if (!onScan && cameraOn) {
    stopCamera(video);
    cameraOn = false; ui.torch = false;
  }

  if (onScan && !wakeLock && navigator.wakeLock) {
    navigator.wakeLock.request('screen').then(l => {
      wakeLock = l;
      l.addEventListener('release', () => { wakeLock = null; });
    }).catch(() => {});
  } else if (!onScan && wakeLock) {
    wakeLock.release().catch(() => {});
    wakeLock = null;
  }

  const autoOk = onScan && cameraOn && state.settings.mode === 'auto' && !ui.dupe && !ui.locOpen && !ui.endConfirm;
  if (autoOk && !auto.running) auto.start(video, reticle);
  else if (!autoOk && auto.running) auto.stop();
}

function cameraMessage(e) {
  if (!window.isSecureContext) return 'The camera needs HTTPS. Open the app from its https:// address.';
  if (e?.name === 'NotAllowedError') return 'Camera access was blocked. Allow it in the browser’s site settings.';
  if (e?.name === 'NotFoundError' || e?.name === 'OverconstrainedError') return 'No camera found on this device.';
  return 'Couldn’t start the camera. ' + (e?.message || '');
}

async function doCapture() {
  const ui = state.ui;
  if (!canCapture()) return;
  ui.busy = true; ui.flash = true;
  render();
  setTimeout(() => { ui.flash = false; render(); }, 160);
  try {
    const shot = await captureCrop(video, reticle());
    await S.captured(shot);
  } catch (e) {
    S.toast({ kind: 'held', title: 'Capture failed', sub: e.message });
  } finally {
    ui.busy = false;
    render();
  }
}

// ── events ───────────────────────────────────────────────────────────────

function go(screen) {
  const ui = state.ui;
  ui.screen = screen; ui.toast = null; ui.editId = null; ui.draft = null;
  render();
}

function askEnd(thenNew = false) {
  const ses = S.sessionScans();
  if (ses.some(x => x.status !== 'logged')) { state.ui.endConfirm = thenNew ? 'new' : 'end'; render(); }
  else finishEnd(thenNew);
}

async function finishEnd(thenNew) {
  await S.endSession();
  if (thenNew) { await S.startSession(); go('scan'); }
}

const actions = {
  go: v => go(v),
  'test-connection': () => S.testConnection(),
  'setup-back': () => { state.ui.setupStep = Math.max(1, state.ui.setupStep - 1); render(); },
  'setup-next': async () => {
    if (state.ui.setupStep < 3) { state.ui.setupStep++; render(); return; }
    await S.saveSettings({ setupDone: true });
    if (!state.session) await S.startSession();
    go('scan');
    S.flush();
  },
  'rerun-setup': () => { state.ui.setupStep = 1; state.ui.ping = { status: 'idle', error: '' }; go('setup'); },
  naming: v => S.saveSettings({ naming: v }),
  threshold: v => S.saveSettings({ threshold: Number(v) }),
  paused: async v => { await S.saveSettings({ paused: v === 'true' }); if (v !== 'true') S.flush(); },
  mode: v => S.saveSettings({ mode: v }),
  capture: () => doCapture(),
  torch: async () => {
    try { await setTorch(!state.ui.torch); state.ui.torch = !state.ui.torch; } catch { state.ui.torchAvailable = false; }
    render();
  },
  'retry-camera': () => { state.ui.camError = ''; render(); },
  dupe: v => S.dupeChoice(v),
  open: (v, id) => S.openEdit(id),
  'save-edit': () => S.saveEdit(),
  discard: () => S.discardEdit(),
  'ask-end': () => askEnd(false),
  'new-session-tab': () => askEnd(true),
  'cancel-end': () => { state.ui.endConfirm = false; render(); },
  'confirm-end': () => finishEnd(state.ui.endConfirm === 'new'),
  'new-session': async () => { await S.startSession(); go('scan'); },
};

root.addEventListener('click', e => {
  const el = e.target.closest('[data-act]');
  if (!el || el.disabled || el.getAttribute('aria-disabled') === 'true') return;
  const fn = actions[el.dataset.act];
  if (fn) fn(el.dataset.v, el.dataset.id);
});

// Picking a recent location: act on pointerdown so the input's blur doesn't close the list first.
root.addEventListener('pointerdown', e => {
  const el = e.target.closest('[data-act="pick-loc"]');
  if (!el) return;
  e.preventDefault();
  const v = el.dataset.v;
  S.setLoc(v);
  const input = root.querySelector('[data-loc]');
  if (input) { input.value = v; input.blur(); }
  state.ui.locOpen = false;
  renderRecents();
});

root.addEventListener('input', e => {
  const el = e.target, bind = el.dataset?.bind;
  if (!bind) return;
  const v = el.value;
  if (bind === 'loc') { S.setLoc(v); return; }
  const [scope, key] = bind.split('.');
  if (scope === 'draft') state.ui.draft[key] = v;
  if (scope === 'settings') {
    const patch = { [key]: v };
    if (key === 'scriptUrl' || key === 'token') { patch.sheetName = ''; state.ui.ping = { status: 'idle', error: '' }; }
    Object.assign(state.settings, patch);
    S.saveSettings(patch);   // renders, but deferred until the field blurs
  }
  patchLive();
});

root.addEventListener('focusin', e => {
  if (e.target.matches('[data-loc]')) { state.ui.locOpen = true; renderRecents(); }
});

root.addEventListener('focusout', e => {
  if (e.target.matches('[data-loc]')) {
    setTimeout(() => { state.ui.locOpen = false; renderRecents(); if (deferred) render(); }, 120);
  } else if (deferred) setTimeout(render, 0);
});

root.addEventListener('keydown', e => {
  if (e.key === 'Enter' && e.target.matches('input[data-bind]')) e.target.blur();
});

// ── retries & app visibility ─────────────────────────────────────────────

window.addEventListener('online', () => S.flush());
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') S.flush();
  else if (cameraOn) { stopCamera(video); cameraOn = false; state.ui.torch = false; }
  syncLifecycle();
  render();
});
setInterval(() => { if (S.hasOutbox()) S.flush(); }, 30000);

// Skipped on localhost so edits show up on reload; add ?sw to test it locally.
const isLocal = ['localhost', '127.0.0.1'].includes(location.hostname) && !location.search.includes('sw');
if ('serviceWorker' in navigator && !isLocal) navigator.serviceWorker.register('sw.js').catch(() => {});

// ── go ───────────────────────────────────────────────────────────────────

S.load().then(() => { renderAll(); S.flush(); }).catch(e => {
  root.innerHTML = `<div class="page"><h2>Couldn’t start</h2><p>${String(e)}</p></div>`;
});
