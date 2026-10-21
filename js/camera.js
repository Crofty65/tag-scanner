// Camera: rear stream, reticle crop, torch, and the Auto-capture steadiness detector.

let stream = null;
let track = null;

export async function startCamera(video) {
  if (stream) { video.srcObject = stream; await video.play().catch(() => {}); return; }
  stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } },
  });
  track = stream.getVideoTracks()[0];
  video.srcObject = stream;
  await video.play().catch(() => {});
}

export function stopCamera(video) {
  if (stream) stream.getTracks().forEach(t => t.stop());
  stream = null; track = null;
  if (video) video.srcObject = null;
}

export function torchSupported() {
  try { return !!track?.getCapabilities?.().torch; } catch { return false; }
}

export async function setTorch(on) {
  if (track) await track.applyConstraints({ advanced: [{ torch: on }] });
}

// Map the on-screen reticle to source-video pixels (video uses object-fit: cover).
function sourceRect(video, reticle) {
  const vr = video.getBoundingClientRect(), rr = reticle.getBoundingClientRect();
  const vw = video.videoWidth, vh = video.videoHeight;
  const scale = Math.max(vr.width / vw, vr.height / vh);
  const ox = (vr.width - vw * scale) / 2, oy = (vr.height - vh * scale) / 2;
  const sx = Math.max(0, (rr.left - vr.left - ox) / scale);
  const sy = Math.max(0, (rr.top - vr.top - oy) / scale);
  const sw = Math.min(vw - sx, rr.width / scale), sh = Math.min(vh - sy, rr.height / scale);
  return { sx, sy, sw, sh };
}

// Crop the frame to the reticle, ~1280px wide, JPEG q0.8.
export function captureCrop(video, reticle) {
  if (!video.videoWidth) return Promise.reject(new Error('Camera not ready'));
  const { sx, sy, sw, sh } = sourceRect(video, reticle);
  const scale = Math.min(1280 / sw, 2);
  const c = document.createElement('canvas');
  c.width = Math.round(sw * scale); c.height = Math.round(sh * scale);
  c.getContext('2d').drawImage(video, sx, sy, sw, sh, 0, 0, c.width, c.height);
  return new Promise((resolve, reject) =>
    c.toBlob(b => b ? resolve({ blob: b, width: c.width, height: c.height }) : reject(new Error('Capture failed')), 'image/jpeg', 0.8));
}

// Auto mode: sample ~8 fps into a 64×48 grayscale buffer. Fire when the frame has been
// still for ~600 ms and the reticle is mostly bright (a tag is present). After firing,
// re-arm only once the view changes a lot (user moved to the next tag).
const W = 64, H = 48;
const STILL = 6, MOVED = 22, BRIGHT = 130, STEADY_MS = 600;

export function createAutoDetector(onTrigger) {
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  let prev = null, ref = null, stillSince = 0, armed = true, timer = null;

  function sample(video, reticle) {
    if (!video.videoWidth) return;
    const { sx, sy, sw, sh } = sourceRect(video, reticle);
    ctx.drawImage(video, sx, sy, sw, sh, 0, 0, W, H);
    const px = ctx.getImageData(0, 0, W, H).data;
    const g = new Uint8Array(W * H);
    let sum = 0;
    for (let i = 0; i < g.length; i++) {
      g[i] = (px[i * 4] * 77 + px[i * 4 + 1] * 150 + px[i * 4 + 2] * 29) >> 8;
      sum += g[i];
    }
    const diff = (a, b) => { let d = 0; for (let i = 0; i < a.length; i++) d += Math.abs(a[i] - b[i]); return d / a.length; };
    const now = performance.now();
    if (!armed && ref && diff(g, ref) > MOVED) armed = true;
    if (prev && diff(g, prev) < STILL) { if (!stillSince) stillSince = now; } else stillSince = 0;
    prev = g;
    if (armed && stillSince && now - stillSince > STEADY_MS && sum / g.length > BRIGHT) {
      armed = false; ref = g; stillSince = 0;
      onTrigger();
    }
  }

  return {
    start(video, reticle) {
      if (timer) return;
      timer = setInterval(() => sample(video, reticle()), 125);
    },
    stop() { clearInterval(timer); timer = null; prev = null; stillSince = 0; },
    get running() { return !!timer; },
  };
}
