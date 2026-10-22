// Air Pen: write in the air with your index finger, on a screen or a projected wall.
//
// Coordinates: everything after the camera is in SCREEN space, normalized 0..1 (what the viewer sees).
// Uncalibrated, the camera image is mirrored like a selfie view. Calibrated (K), a 4-point
// perspective map turns camera positions into exact positions on the projected screen.

// ======================= settings =======================

// Pen colours are slots (blue, neutral, red, green, amber) so a stroke keeps its meaning when the board flips.
const THEMES = {
  light: { bg: '#ffffff', glow: 0, pens: ['#1a4fd6', '#1e2430', '#d93025', '#188038', '#b06000'] },
  dark: { bg: '#000000', glow: 14, pens: ['#8cc8ff', '#ffffff', '#ff8fa3', '#8ef0a8', '#ffd166'] }
};
const PEN_SIZES = [3, 5, 7, 10, 14];

// Line continuity
const LOST_GRACE_MS = 200;          // hand may vanish this long without resetting the cursor
const LOST_GRACE_WRITING_MS = 600;  // ...and this long while writing (0.3 s webcam dropout + time to re-find the hand)
const LOST_GRACE_PEN_MS = 300;      // pen mode: hiding the cap is how you lift the pen, so react faster
const PEN_DOWN_FRAMES = 3;          // pose must hold this many results to start writing
const PEN_UP_FRAMES = 5;            // ...and this many to stop, so a wobbly reading never breaks a letter
const MAX_JUMP = 0.2;               // fingertip jump (fraction of camera frame) in one result = misdetection
const MIN_STEP_PX = 2;              // smaller moves are ignored: removes micro-wobble from strokes

// Stabilizer ("lazy brush"): while writing, the pen trails the finger on an invisible string.
// Shake smaller than the string never moves the pen. Levels 1-5, change live with - and =.
const STRING_LENGTHS = [0.006, 0.010, 0.015, 0.021, 0.028]; // fraction of screen width

// Uncalibrated reach: this part of the camera view (mirrored) covers the whole screen, so you never
// have to push your hand to the frame edge, where part of it leaves the picture and tracking fails.
const REACH = { x0: 0.15, x1: 0.85, y0: 0.1, y1: 0.75 };

// Projector calibration targets, screen-normalized
const CAL_TARGETS = [[0.1, 0.1], [0.9, 0.1], [0.9, 0.9], [0.1, 0.9]];
const CAL_HOLD_MS = 1000;
const CAL_STILL = 0.012;

// ======================= saved preferences =======================

const prefs = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem('airpen-' + key);
      return v === null ? fallback : JSON.parse(v);
    } catch { return fallback; }
  },
  set(key, value) {
    try {
      if (value === null) localStorage.removeItem('airpen-' + key);
      else localStorage.setItem('airpen-' + key, JSON.stringify(value));
    } catch {}
  }
};

let themeName = new URLSearchParams(location.search).get('theme') || prefs.get('theme', 'light');
if (!THEMES[themeName]) themeName = 'light';
let steadiness = Math.min(5, Math.max(1, Number(prefs.get('steadiness', 2)) || 2));
let homography = prefs.get('homography', null);
let penMode = prefs.get('penMode', false);      // track a coloured pen cap instead of the index finger
// Cap colour { h: hue°, hTol: ±hue°, sMin, vMin }. Default: a blue cap. L re-learns it from your actual pen.
// A cap is bright and saturated; dark navy clothing is not, hence the brightness floor.
const BLUE_PEN = { h: 215, hTol: 25, sMin: 0.5, vMin: 0.45 };
let penColor = prefs.get('penColor', BLUE_PEN);
let penSlot = 0;
let sizeSlot = 3; // 10px: readable from the back of a room

// ======================= state =======================

const video = document.getElementById('video');
const camBox = document.getElementById('cam');
const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');

let strokes = [];
let currentStroke = [];
let writingOn = false;   // Shift / clicker toggles; while on, only the one-finger pose writes
let penGesture = false;  // hand is in the writing pose
let drawing = false;     // a stroke is in progress
let mouseDown = false;   // mouse mode only
let target = null;       // latest pen point, screen-normalized; null = no hand
let smoothX = null, smoothY = null; // pen position on screen (px)
let fingerX = null, fingerY = null; // smoothed fingertip (px); the pen trails it while writing
let lastSeen = 0;
let mode = 'loading';    // loading | camera | mouse | error
let calib = null;        // calibration in progress

const stats = { results: [], sendMs: 0, lostCount: 0, longestGapMs: 0, lostSince: null, gestureLifts: 0, lostLifts: 0 };

// ======================= smoothing =======================

// One Euro filter: strong smoothing when the hand moves slowly, light when fast. https://gery.casiez.net/1euro/
// minCutoff may be a function so the strength can change without a jump (light when pointing, strong when writing).
function oneEuro(minCutoff, beta, dCutoff = 1.0) {
  let x = null, dx = 0, last = 0;
  const alpha = (cutoff, dt) => 1 / (1 + 1 / (2 * Math.PI * cutoff * dt));
  const f = (v, now) => {
    if (x === null) { x = v; last = now; return v; }
    const dt = Math.max((now - last) / 1000, 1e-3);
    last = now;
    const ad = alpha(dCutoff, dt);
    dx = ad * ((v - x) / dt) + (1 - ad) * dx;
    const mc = typeof minCutoff === 'function' ? minCutoff() : minCutoff;
    const b = typeof beta === 'function' ? beta() : beta;
    const a = alpha(mc + b * Math.abs(dx), dt);
    x = a * v + (1 - a) * x;
    return x;
  };
  f.reset = () => { x = null; dx = 0; };
  return f;
}
// Pointing: light smoothing, the cursor stays on your fingertip. Writing: strong smoothing for clean letters.
const cutoff = () => (drawing ? 0.25 : 3.0);
const speedBoost = () => (drawing ? 0.005 : 0.02); // how much fast moves loosen the smoothing
const filterX = oneEuro(cutoff, speedBoost);
const filterY = oneEuro(cutoff, speedBoost);

// Final light smoothing of a finished stroke (ends stay put) so writing looks neat.
function smoothStroke(stroke) {
  for (let pass = 0; pass < 3; pass++) {
    for (let i = 1; i < stroke.length - 1; i++) {
      stroke[i] = {
        x: (stroke[i - 1].x + 2 * stroke[i].x + stroke[i + 1].x) / 4,
        y: (stroke[i - 1].y + 2 * stroke[i].y + stroke[i + 1].y) / 4
      };
    }
  }
}

function endStroke() {
  if (!drawing) return;
  if (currentStroke.length > 2) smoothStroke(currentStroke);
  drawing = false;
  inkDirty = true;
}

function resetPointer() {
  endStroke();
  smoothX = smoothY = fingerX = fingerY = null;
  filterX.reset();
  filterY.reset();
}

// ======================= projector calibration =======================

// 3x3 perspective map (h8 = 1) taking 4 src points onto 4 dst points; null if degenerate.
function solveHomography(src, dst) {
  const A = [], b = [];
  for (let k = 0; k < 4; k++) {
    const [x, y] = src[k], [u, v] = dst[k];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
  }
  for (let c = 0; c < 8; c++) { // Gauss-Jordan with partial pivoting
    let p = c;
    for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    if (Math.abs(A[p][c]) < 1e-9) return null;
    [A[c], A[p]] = [A[p], A[c]];
    [b[c], b[p]] = [b[p], b[c]];
    for (let r = 0; r < 8; r++) {
      if (r === c) continue;
      const f = A[r][c] / A[c][c];
      for (let k = c; k < 8; k++) A[r][k] -= f * A[c][k];
      b[r] -= f * b[c];
    }
  }
  return b.map((v, i) => v / A[i][i]).concat(1);
}

function applyHomography(h, x, y) {
  const w = h[6] * x + h[7] * y + h[8];
  return [(h[0] * x + h[1] * y + h[2]) / w, (h[3] * x + h[4] * y + h[5]) / w];
}

// Camera fingertip -> screen point.
function toScreen(tip) {
  if (!homography) { // mirror view, like a selfie camera, stretched from the comfortable middle of the frame
    const clamp = (v) => Math.min(1, Math.max(0, v));
    return {
      x: clamp((1 - tip.x - REACH.x0) / (REACH.x1 - REACH.x0)),
      y: clamp((tip.y - REACH.y0) / (REACH.y1 - REACH.y0))
    };
  }
  const [x, y] = applyHomography(homography, tip.x, tip.y);
  return { x, y };
}

function startCalibration() {
  if (mode !== 'camera') { toast('Calibration needs the camera'); return; }
  endStroke();
  calib = { i: 0, pts: [], anchor: null, since: 0, samples: [] };
  setStatus('calib', 'Calibrating', 'Touch each ring on the wall and hold still');
  ui.calib.classList.remove('hidden');
  updateCalibText(true);
}

function stopCalibration() {
  calib = null;
  ui.calib.classList.add('hidden');
  resetPointer();
}

function setHomography(h) {
  homography = h;
  prefs.set('homography', h);
  camBox.classList.toggle('mirror', !h);
}

function updateCalibText(handSeen) {
  ui.calibStep.textContent = calib.i + 1;
  ui.calibText.textContent = handSeen
    ? 'Touch the ring with your fingertip and hold still'
    : 'Point the webcam at the screen and show your hand';
}

function calibrationStep(tip, now) {
  updateCalibText(!!tip);
  if (!tip) { calib.anchor = null; return; }
  if (!calib.anchor || Math.hypot(tip.x - calib.anchor.x, tip.y - calib.anchor.y) > CAL_STILL) {
    calib.anchor = tip;
    calib.since = now;
    calib.samples = [];
  }
  calib.samples.push(tip);
  if (now - calib.since < CAL_HOLD_MS) return;
  const n = calib.samples.length;
  const avg = calib.samples.reduce((a, p) => [a[0] + p.x / n, a[1] + p.y / n], [0, 0]);
  // still at an earlier corner: wait for the finger to move to the new ring
  if (calib.pts.some((p) => Math.hypot(p[0] - avg[0], p[1] - avg[1]) < 0.05)) return;
  calib.pts.push(avg);
  calib.i++;
  calib.anchor = null;
  if (calib.i < CAL_TARGETS.length) { updateCalibText(true); return; }
  const h = solveHomography(calib.pts, CAL_TARGETS);
  stopCalibration();
  if (h) { setHomography(h); toast('Calibrated: ink now lands under your finger'); }
  else toast('Calibration failed: touch the four corners again (K)');
}

// ======================= gestures =======================

// How stretched a finger is: wrist->tip over wrist->middle joint (straight ~1.3+, curled ~0.7).
// 3D (uses the model's depth) so a finger pointing toward the camera still counts as up.
let camAspect = 16 / 9;
function stretch(lm, tip, pip) {
  const d = (i) => Math.hypot((lm[i].x - lm[0].x) * camAspect, lm[i].y - lm[0].y, (lm[i].z - lm[0].z) * camAspect);
  return d(tip) / d(pip);
}

let penVotes = 0;
let middleUp = false; // hysteresis: flips only on a clear reading
let liftMark = null;  // stroke length when the hand began changing to "pause"
let liftPoint = null; // fingertip at that moment = where the letter really ends

function updatePen(lm) {
  const mid = stretch(lm, 12, 10);
  if (mid > 1.2) middleUp = true;
  else if (mid < 1.05) middleUp = false;
  const idx = stretch(lm, 8, 6);
  const wantDown = penGesture
    ? !middleUp && idx > 0.9   // writing: continue unless a second finger is clearly up or the index curls
    : !middleUp && idx > 1.1;  // not writing: start only on a clearly raised index
  if (wantDown === penGesture) { penVotes = 0; liftMark = null; return; }
  if (penVotes === 0 && penGesture && drawing) {
    liftMark = currentStroke.length;
    liftPoint = { x: fingerX, y: fingerY };
  }
  if (++penVotes < (penGesture ? PEN_UP_FRAMES : PEN_DOWN_FRAMES)) return;
  penGesture = wantDown;
  penVotes = 0;
  // Pen lifted: drop ink made while the fingers changed pose and end at the fingertip (no hooks).
  if (!penGesture && drawing && liftMark !== null) {
    stats.gestureLifts++;
    currentStroke.length = Math.max(1, liftMark);
    const prev = currentStroke[currentStroke.length - 1];
    if (liftPoint.x !== null && Math.hypot(liftPoint.x - prev.x, liftPoint.y - prev.y) >= MIN_STEP_PX) currentStroke.push(liftPoint);
  }
  liftMark = null;
}

// ======================= hand tracking =======================

let jumpSkips = 0, lastTip = null, lastTipAt = 0;

function onResults(results) {
  if (penMode) return; // pen mode does its own detection
  const lm = results.multiHandLandmarks && results.multiHandLandmarks[0];
  onTip(lm ? lm[8] : null, lm || null); // index fingertip only
}

// One tracked point per camera frame, from the finger (with its hand landmarks) or the pen cap.
function onTip(raw, lm) {
  const t = performance.now();
  stats.results.push(t);
  while (stats.results[0] < t - 1000) stats.results.shift();
  if (!raw && stats.lostSince === null) stats.lostSince = t;
  if (raw && stats.lostSince !== null) {
    stats.lostCount++;
    stats.longestGapMs = Math.max(stats.longestGapMs, t - stats.lostSince);
    stats.lostSince = null;
  }
  updateDiag();

  if (!raw) {
    drawSkeleton(null);
    target = null;
    if (calib) calibrationStep(null, t);
    else updateStatus(false);
    return;
  }

  // A point that teleports for 1-2 frames is a misdetection: skip it before it can move the pen
  // or vote on pen up/down. Compared only with this point's own position from just now.
  if (lastTip && t - lastTipAt < 150 && Math.hypot(raw.x - lastTip.x, raw.y - lastTip.y) > MAX_JUMP && jumpSkips < 2) {
    jumpSkips++;
    return;
  }
  jumpSkips = 0;
  lastTip = { x: raw.x, y: raw.y };
  lastTipAt = t;

  if (calib) { target = null; drawSkeleton(lm, lastTip); calibrationStep(lastTip, t); return; }
  if (lm) updatePen(lm);
  else penGesture = true; // pen mode: the cap is visible, so the pen can write
  updateStatus(true);
  drawSkeleton(lm, lastTip);
  target = toScreen(lastTip);
}

// ======================= pen tracking (coloured cap) =======================

// The camera frame is scaled down to this width for colour search: plenty for a cap, and fast.
const PEN_W = 480;
const penCanvas = document.createElement('canvas');
const penCtx = penCanvas.getContext('2d', { willReadFrequently: true });
let penMask = null, penSeen = null; // reused buffers
const PEN_MIN_PIXELS = 10;          // smaller blobs are noise
const PEN_MAX_SHARE = 0.02;         // bigger than 2% of the frame = clothing or a wall, not a pen cap
let teaching = false;               // colour-teach screen is open

// RGB (0-255) -> [hue 0-360, saturation 0-1, value 0-1]
function hsv(r, g, b) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return [h, max ? d / max : 0, max / 255];
}
const hueGap = (a, b) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };

function grabFrame(el) {
  const w = el.videoWidth || el.naturalWidth || el.width, h = el.videoHeight || el.naturalHeight || el.height;
  if (!w || !h) return null;
  const pw = PEN_W, ph = Math.round(PEN_W * h / w);
  if (penCanvas.width !== pw || penCanvas.height !== ph) { penCanvas.width = pw; penCanvas.height = ph; }
  penCtx.drawImage(el, 0, 0, pw, ph);
  return penCtx.getImageData(0, 0, pw, ph);
}

// All cap-sized patches of the learned colour, each with its centre (camera-normalized,
// sub-pixel: the average of its pixels).
function findBlobs(img, color) {
  const { width: w, height: h, data } = img;
  const n = w * h;
  if (!penMask || penMask.length !== n) { penMask = new Uint8Array(n); penSeen = new Int32Array(n); }
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const [hh, ss, vv] = hsv(data[j], data[j + 1], data[j + 2]);
    penMask[i] = ss >= color.sMin && vv >= color.vMin && hueGap(hh, color.h) <= color.hTol ? 1 : 0;
  }
  const blobs = [];
  const maxPixels = n * PEN_MAX_SHARE;
  const stack = penSeen; // reuse as an explicit stack for flood fill
  for (let i = 0; i < n; i++) {
    if (penMask[i] !== 1) continue;
    let top = 0, count = 0, sx = 0, sy = 0;
    stack[top++] = i;
    penMask[i] = 2;
    while (top) {
      const k = stack[--top], x = k % w, y = (k - x) / w;
      count++; sx += x; sy += y;
      if (x > 0 && penMask[k - 1] === 1) { penMask[k - 1] = 2; stack[top++] = k - 1; }
      if (x < w - 1 && penMask[k + 1] === 1) { penMask[k + 1] = 2; stack[top++] = k + 1; }
      if (y > 0 && penMask[k - w] === 1) { penMask[k - w] = 2; stack[top++] = k - w; }
      if (y < h - 1 && penMask[k + w] === 1) { penMask[k + w] = 2; stack[top++] = k + w; }
    }
    if (count < PEN_MIN_PIXELS || count > maxPixels) continue;
    blobs.push({ x: (sx / count + 0.5) / w, y: (sy / count + 0.5) / h, size: count });
  }
  return blobs;
}

// Pick the pen among the patches. Following the pen: only a patch close to where it just was, so it
// never jumps to another blue thing. Finding it: anything that has sat perfectly still for a while
// (a blue poster, a sticker, a bag) is part of the room and ignored; a hand-held pen is never that still.
const PEN_FOLLOW_RADIUS = 0.15; // fraction of the frame per result
const STILL_RADIUS = 0.004;     // a patch staying within this counts as not moving
const STILL_MS = 1500;          // still this long = part of the room
let stillSpots = [];            // { x, y, since, frame }
let penFrame = 0;

function findPen(img, color, near) {
  const now = performance.now();
  const blobs = findBlobs(img, color);
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  penFrame++;
  stillSpots = stillSpots.filter((sp) => penFrame - sp.frame <= 3); // forget a spot missing for 3 frames, however slow the frames
  for (const b of blobs) {
    let sp = stillSpots.find((q) => dist(b, q) < STILL_RADIUS);
    if (!sp) stillSpots.push(sp = { x: b.x, y: b.y, since: now, frame: penFrame });
    sp.frame = penFrame;
    b.age = now - sp.since; // how long this patch has stayed put
  }
  let pick = null;
  if (near) {
    for (const b of blobs) if (dist(b, near) < PEN_FOLLOW_RADIUS && (!pick || dist(b, near) < dist(pick, near))) pick = b;
  } else {
    for (const b of blobs) if (b.age < STILL_MS && (!pick || b.age < pick.age)) pick = b; // the most recently moved
  }
  return pick;
}

// Learn the cap colour from the centre box of the camera view.
const TEACH_BOX = 0.12; // box size as a fraction of the frame width
function learnPenColor(img) {
  const { width: w, height: h, data } = img;
  const half = Math.round(w * TEACH_BOX / 2), cx = w >> 1, cy = h >> 1;
  const px = [];
  for (let y = cy - half; y < cy + half; y++) for (let x = cx - half; x < cx + half; x++) {
    const j = (y * w + x) * 4;
    const c = hsv(data[j], data[j + 1], data[j + 2]);
    if (c[1] > 0.3 && c[2] > 0.2) px.push(c); // colourful pixels only
  }
  const total = 4 * half * half;
  if (px.length < total * 0.25) return { error: 'Not enough colour in the box. Hold the cap closer so it fills the box.' };
  // circular median hue: average the unit vectors, then use the gaps around it
  const ang = Math.atan2(px.reduce((a, c) => a + Math.sin(c[0] * Math.PI / 180), 0), px.reduce((a, c) => a + Math.cos(c[0] * Math.PI / 180), 0));
  const h0 = (ang * 180 / Math.PI + 360) % 360;
  const gaps = px.map((c) => hueGap(c[0], h0)).sort((a, b) => a - b);
  const sat = px.map((c) => c[1]).sort((a, b) => a - b), val = px.map((c) => c[2]).sort((a, b) => a - b);
  const color = {
    h: Math.round(h0),
    hTol: Math.round(Math.min(22, Math.max(10, gaps[Math.floor(gaps.length * 0.9)] * 1.5))),
    sMin: +Math.max(0.3, sat[Math.floor(sat.length * 0.1)] * 0.7).toFixed(2),
    vMin: +Math.max(0.2, val[Math.floor(val.length * 0.1)] * 0.6).toFixed(2)
  };
  const skinLike = color.h < 45 || color.h > 340;
  return { color, skinLike };
}

// Ink hues by slot (0 blue, 2 red, 3 green, 4 amber); slot 1 is neutral (black/white), which a pen colour never matches.
const INK_HUES = [222, null, 4, 140, 33];
function inkClashesWithPen(slot) {
  return penMode && penColor && INK_HUES[slot] !== null && hueGap(INK_HUES[slot], penColor.h) < penColor.hTol + 20;
}

function setPenMode(on) {
  penMode = on;
  syncDock();
  if (on && inkClashesWithPen(penSlot)) {
    penSlot = 1;
    syncDock();
    toast('Ink set to black: the camera must not confuse projected ink with your pen');
  }
  prefs.set('penMode', on);
  penGesture = false;
  resetPointer();
  drawSkeleton(null);
  ui.penBtn.setAttribute('aria-pressed', on);
  document.body.classList.toggle('pen-mode', on);
  if (on && !penColor) startTeaching();
  else if (!on || !ui.toast.classList.contains('show')) toast(on ? 'Pen mode: the pen writes while its cap is visible' : 'Finger mode');
  updateStatus(false);
}

function startTeaching() {
  if (mode !== 'camera') { toast('Pen mode needs the camera'); return; }
  teaching = true;
  camBox.classList.add('big', 'teaching');
  ui.teach.classList.remove('hidden');
  ui.teachMsg.textContent = 'Hold the coloured cap inside the box, then press Enter';
}

function stopTeaching() {
  teaching = false;
  camBox.classList.remove('big', 'teaching');
  ui.teach.classList.add('hidden');
}

function captureTeach() {
  const img = grabFrame(video);
  if (!img) return;
  const r = learnPenColor(img);
  if (r.error) { ui.teachMsg.textContent = r.error; return; }
  penColor = r.color;
  prefs.set('penColor', penColor);
  stopTeaching();
  if (!penMode) setPenMode(true);
  toast(r.skinLike ? 'Learned. This colour is close to skin: a blue, green or pink cap tracks better' : 'Learned your pen colour');
}

function detectPen(el) {
  const img = grabFrame(el);
  if (!img) return;
  if (teaching) { drawTeachBox(); return; }
  const near = lastTip && performance.now() - lastTipAt < 300 ? lastTip : null;
  const p = penColor && findPen(img, penColor, near);
  onTip(p ? { x: p.x, y: p.y } : null, null);
}

const hands = new Hands({
  // pinned version: a library update can't break the demo
  locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4.1675469240/${file}`
});
hands.setOptions({
  maxNumHands: 1,
  modelComplexity: 1,
  minDetectionConfidence: 0.5,
  minTrackingConfidence: 0.3 // keep following through blurry frames instead of a slow full re-search
});
hands.onResults(onResults);

let lastSendAt = 0;
function track(el) {
  let busy = false;
  async function send() {
    if (busy) return;
    busy = true;
    lastSendAt = performance.now();
    try {
      if (el.readyState >= 2 || el.naturalWidth) {
        const w = el.videoWidth || el.naturalWidth, h = el.videoHeight || el.naturalHeight;
        if (w && h && camAspect !== w / h) { camAspect = w / h; camBox.style.aspectRatio = `${w} / ${h}`; }
        const t0 = performance.now();
        if (penMode || teaching) detectPen(el);
        else await hands.send({ image: el });
        stats.sendMs = stats.sendMs * 0.9 + (performance.now() - t0) * 0.1;
      }
    } catch (err) {
      console.error('Hand tracking error:', err); // keep going: one bad frame must not stop tracking
      setStatus('error', 'Tracking error', String(err.message || err));
    }
    busy = false;
  }
  if (el.requestVideoFrameCallback) {
    const onFrame = async () => { await send(); el.requestVideoFrameCallback(onFrame); };
    el.requestVideoFrameCallback(onFrame); // once per new camera frame, never the same frame twice
  }
  // Watchdog: frame callbacks need the page to repaint. Chrome on Windows can wrongly treat a
  // fullscreen window on a second monitor (the projector) as covered and stop repainting it.
  setInterval(() => { if (performance.now() - lastSendAt > 150) send(); }, 50);
}

// ======================= live hand skeleton (camera preview) =======================

const BONES = [[0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16], [13, 17], [0, 17], [17, 18], [18, 19], [19, 20]];
const skel = document.getElementById('skeleton');
const skelCtx = skel.getContext('2d');

function drawSkeleton(lm, tip) {
  const w = skel.clientWidth, h = skel.clientHeight;
  if (!w) return; // preview hidden
  if (skel.width !== w * devicePixelRatio) { skel.width = w * devicePixelRatio; skel.height = h * devicePixelRatio; }
  const c = skelCtx, k = devicePixelRatio;
  c.clearRect(0, 0, skel.width, skel.height);
  if (!lm && tip) { // pen mode: ring around the tracked cap
    c.lineWidth = 3 * k;
    c.strokeStyle = penGesture && writingOn ? '#d93025' : '#12a150'; // not blue: it can be projected
    c.beginPath(); c.arc(tip.x * skel.width, tip.y * skel.height, 10 * k, 0, Math.PI * 2); c.stroke();
    return;
  }
  if (!lm) return;
  const color = penGesture && writingOn ? '#1a4fd6' : '#12a150';
  c.lineWidth = 2.5 * k;
  c.strokeStyle = color;
  c.beginPath();
  for (const [a, b] of BONES) { c.moveTo(lm[a].x * skel.width, lm[a].y * skel.height); c.lineTo(lm[b].x * skel.width, lm[b].y * skel.height); }
  c.stroke();
  c.fillStyle = '#ffffff';
  for (const p of lm) { c.beginPath(); c.arc(p.x * skel.width, p.y * skel.height, 2.5 * k, 0, Math.PI * 2); c.fill(); }
  c.fillStyle = color; // the pen point
  c.beginPath(); c.arc(lm[8].x * skel.width, lm[8].y * skel.height, 6 * k, 0, Math.PI * 2); c.fill();
}

function drawTeachBox() {
  const w = skel.clientWidth, h = skel.clientHeight;
  if (!w) return;
  if (skel.width !== w * devicePixelRatio) { skel.width = w * devicePixelRatio; skel.height = h * devicePixelRatio; }
  const side = skel.width * TEACH_BOX;
  skelCtx.clearRect(0, 0, skel.width, skel.height);
  skelCtx.lineWidth = 3 * devicePixelRatio;
  skelCtx.strokeStyle = '#ffffff';
  skelCtx.strokeRect((skel.width - side) / 2, (skel.height - side) / 2, side, side);
}

// ======================= drawing =======================

// Finished strokes are drawn once into this layer and reused, so a full board stays fast.
const ink = document.createElement('canvas');
const inkCtx = ink.getContext('2d');
let inkDirty = true;

function resizeCanvas() {
  const ow = canvas.width || innerWidth, oh = canvas.height || innerHeight;
  canvas.width = innerWidth;
  canvas.height = innerHeight;
  for (const s of strokes) for (const p of s) { p.x *= canvas.width / ow; p.y *= canvas.height / oh; }
  inkDirty = true;
  resetPointer();
}

function strokePath(c, stroke, theme) {
  c.shadowColor = c.strokeStyle = theme.pens[stroke.pen];
  c.shadowBlur = theme.glow;
  c.lineWidth = stroke.size;
  c.lineCap = 'round';
  c.lineJoin = 'round';
  c.beginPath();
  c.moveTo(stroke[0].x, stroke[0].y);
  for (let i = 1; i < stroke.length - 1; i++) { // curve through midpoints: smooth, not zig-zag
    c.quadraticCurveTo(stroke[i].x, stroke[i].y, (stroke[i].x + stroke[i + 1].x) / 2, (stroke[i].y + stroke[i + 1].y) / 2);
  }
  const last = stroke[stroke.length - 1];
  c.lineTo(last.x, last.y);
  c.stroke();
}

function drawStrokes(theme) {
  if (inkDirty) {
    ink.width = canvas.width;
    ink.height = canvas.height; // also clears
    for (const s of strokes) if (!(drawing && s === currentStroke)) strokePath(inkCtx, s, theme);
    inkDirty = false;
  }
  ctx.shadowBlur = 0;
  ctx.drawImage(ink, 0, 0);
  if (drawing && currentStroke.length) strokePath(ctx, currentStroke, theme);
}

// Hollow ring = hovering, filled dot = writing, in the current ink and size.
function drawCursor(theme) {
  const color = theme.pens[penSlot];
  ctx.beginPath();
  ctx.arc(smoothX, smoothY, PEN_SIZES[sizeSlot] / 2 + (drawing ? 1 : 6), 0, Math.PI * 2);
  ctx.shadowColor = color;
  ctx.shadowBlur = theme.glow;
  if (drawing) { ctx.fillStyle = color; ctx.fill(); }
  else { ctx.strokeStyle = color; ctx.lineWidth = 2.5; ctx.stroke(); }
  ctx.shadowBlur = 0;
}

function drawCalibTarget(theme) {
  const [sx, sy] = CAL_TARGETS[calib.i];
  const x = sx * canvas.width, y = sy * canvas.height, r = Math.max(26, canvas.width * 0.018);
  ctx.strokeStyle = theme.pens[penMode ? 1 : 0]; // never pen-coloured: the camera is looking at it
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.moveTo(x - r * 1.6, y); ctx.lineTo(x + r * 1.6, y);
  ctx.moveTo(x, y - r * 1.6); ctx.lineTo(x, y + r * 1.6);
  ctx.stroke();
  if (calib.anchor) { // hold progress
    const p = Math.min(1, (performance.now() - calib.since) / CAL_HOLD_MS);
    ctx.lineWidth = 9;
    ctx.beginPath();
    ctx.arc(x, y, r, -Math.PI / 2, -Math.PI / 2 + p * Math.PI * 2);
    ctx.stroke();
  }
}

// point: screen-normalized {x, y}, or null when no hand
function render(point) {
  const theme = THEMES[themeName];
  const now = performance.now();
  ctx.shadowBlur = 0;
  ctx.fillStyle = theme.bg;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  drawStrokes(theme);
  if (calib) { drawCalibTarget(theme); return; }

  if (!point) {
    const grace = !drawing ? LOST_GRACE_MS : penMode ? LOST_GRACE_PEN_MS : LOST_GRACE_WRITING_MS;
    if (smoothX !== null && now - lastSeen < grace) {
      drawCursor(theme); // brief dropout: hold the pen, keep the line going
    } else if (smoothX !== null) {
      if (drawing && penMode) {
        // pen mode: hiding the cap is the intended lift. End the letter where the cap was last seen,
        // not where the trailing pen had got to.
        stats.gestureLifts++;
        const prev = currentStroke[currentStroke.length - 1];
        if (fingerX !== null && (!prev || Math.hypot(fingerX - prev.x, fingerY - prev.y) >= MIN_STEP_PX)) currentStroke.push({ x: fingerX, y: fingerY });
      } else if (drawing) stats.lostLifts++;
      penGesture = false;
      penVotes = 0;
      resetPointer();
    }
    return;
  }
  lastSeen = now;

  const fx = filterX(point.x * canvas.width, now);
  const fy = filterY(point.y * canvas.height, now);
  fingerX = fx;
  fingerY = fy;
  if (smoothX === null || !drawing) {
    smoothX = fx; // not writing: cursor sits right on the fingertip
    smoothY = fy;
  } else {
    const dist = Math.hypot(fx - smoothX, fy - smoothY);
    const string = STRING_LENGTHS[steadiness - 1] * canvas.width;
    if (dist > string) { // writing: the pen moves only when the finger pulls the string tight
      smoothX += (fx - smoothX) * (1 - string / dist);
      smoothY += (fy - smoothY) * (1 - string / dist);
    }
  }

  if (mouseDown || (writingOn && penGesture)) {
    if (!drawing) {
      drawing = true;
      currentStroke = [];
      currentStroke.pen = penSlot;
      currentStroke.size = PEN_SIZES[sizeSlot];
      strokes.push(currentStroke);
    }
    const prev = currentStroke[currentStroke.length - 1];
    if (!prev || Math.hypot(smoothX - prev.x, smoothY - prev.y) >= MIN_STEP_PX) currentStroke.push({ x: smoothX, y: smoothY });
  } else {
    endStroke();
  }
  drawCursor(theme);
}

// Redraw every screen frame (smooth motion between hand-model results), plus a timer
// fallback for when the browser stops repainting (see the tracking watchdog).
let lastRenderAt = 0;
(function frame() {
  lastRenderAt = performance.now();
  render(target);
  requestAnimationFrame(frame);
})();
setInterval(() => {
  if (performance.now() - lastRenderAt > 100) { lastRenderAt = performance.now(); render(target); }
}, 33);

// ======================= actions =======================

function setWriting(on) {
  writingOn = on;
  if (!on) endStroke();
  ui.writeBtn.setAttribute('aria-pressed', on);
  ui.writeLabel.textContent = on ? 'Writing on' : 'Start writing';
  updateStatus(target !== null);
}

function undo() { endStroke(); if (strokes.pop()) inkDirty = true; }
function clearBoard() { strokes = []; currentStroke = []; drawing = false; inkDirty = true; toast('Board cleared'); }
function setPen(slot) {
  penSlot = slot;
  syncDock();
  if (inkClashesWithPen(slot) && homography) toast('Careful: this ink is close to your pen colour, the camera may mistake it for the pen');
}
function setSize(slot) { sizeSlot = Math.min(PEN_SIZES.length - 1, Math.max(0, slot)); syncDock(); }

function setSteadiness(level) {
  steadiness = Math.min(5, Math.max(1, level));
  prefs.set('steadiness', steadiness);
  toast(`Steadiness ${steadiness} of 5`);
}

function setTheme(name) {
  themeName = name;
  document.documentElement.dataset.theme = name;
  prefs.set('theme', name);
  inkDirty = true;
  syncDock();
}

function saveImage() {
  const theme = THEMES[themeName];
  const out = document.createElement('canvas');
  out.width = canvas.width;
  out.height = canvas.height;
  const c = out.getContext('2d');
  c.fillStyle = theme.bg;
  c.fillRect(0, 0, out.width, out.height);
  for (const s of strokes) strokePath(c, s, theme);
  const a = document.createElement('a');
  const d = new Date(), pad = (n) => String(n).padStart(2, '0');
  a.download = `air-pen-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.png`;
  a.href = out.toDataURL('image/png');
  a.click();
  toast('Saved image');
}

async function toggleFullscreen() {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen();
  } catch (err) { console.error('Fullscreen failed:', err); }
}

// ======================= interface =======================

const $ = (id) => document.getElementById(id);
const ui = {
  status: $('status'), title: $('status-title'), detail: $('status-detail'), diag: $('diag'),
  writeBtn: $('btn-write'), writeLabel: $('btn-write-label'), sizeDot: $('size-dot'),
  toast: $('toast'), calib: $('calib'), calibText: $('calib-text'), calibStep: $('calib-step'),
  welcome: $('welcome'), penBtn: $('btn-pen'), teach: $('teach'), teachMsg: $('teach-msg')
};

function setStatus(state, title, detail) {
  if (ui.status.dataset.state !== state) ui.status.dataset.state = state;
  if (ui.title.textContent !== title) ui.title.textContent = title;
  if (ui.detail.textContent !== detail) ui.detail.textContent = detail;
}

function updateStatus(handSeen) {
  if (calib) return;
  if (mode === 'mouse') return setStatus('mouse', 'Mouse mode', 'No camera found. Hold the mouse button to draw.');
  if (mode !== 'camera') return;
  if (penMode) {
    if (teaching) return setStatus('calib', 'Teach the pen', 'Hold the cap in the box and press Enter');
    if (!handSeen) return setStatus('nohand', 'No pen', 'Show the coloured cap to the camera');
    if (!writingOn) return setStatus('pen-off', 'Pen found, writing is off', 'Press Shift (or Page Down) to start');
    return setStatus('pen-writing', 'Writing with the pen', 'Hide or turn the cap, or press Shift, to lift');
  }
  if (!handSeen) return setStatus('nohand', 'No hand', 'Hold one hand up where the camera can see it');
  if (!writingOn) return setStatus('off', 'Writing is off', 'Press Shift (or Page Down) to start');
  if (penGesture) return setStatus('writing', 'Writing', 'Raise your middle finger to lift the pen');
  setStatus('ready', 'Pen lifted', 'Point with one finger to write');
}

let toastTimer = 0;
function toast(text) {
  ui.toast.textContent = text;
  ui.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ui.toast.classList.remove('show'), 1600);
}

function syncDock() {
  const pens = THEMES[themeName].pens;
  document.querySelectorAll('.swatch').forEach((b) => {
    const i = Number(b.dataset.pen);
    b.style.setProperty('--c', pens[i]);
    b.setAttribute('aria-checked', i === penSlot);
    b.classList.toggle('clash', inkClashesWithPen(i)); // faded so the camera can't take it for the pen
  });
  const px = PEN_SIZES[sizeSlot];
  ui.sizeDot.style.setProperty('--s', px + 'px');
  ui.sizeDot.style.setProperty('--pen', pens[penSlot]);
  ui.sizeDot.title = `Pen size ${px}px`;
}

function updateDiag() {
  if (ui.diag.classList.contains('hidden')) return;
  const rows = [
    ['Hand model', `${stats.results.length} fps`],
    ['Per frame', `${Math.round(stats.sendMs)} ms`],
    ['Hand lost', `${stats.lostCount}× (longest ${(stats.longestGapMs / 1000).toFixed(1)} s)`],
    ['Lines ended by gesture', stats.gestureLifts],
    ['Lines broken by lost hand', stats.lostLifts],
    ['Steadiness', `${steadiness} of 5`],
    ['Projector', homography ? 'calibrated' : 'not calibrated'],
    ['Tracking', penMode ? (penColor ? `pen cap (hue ${penColor.h}°)` : 'pen, colour not learned') : 'index finger']
  ];
  ui.diag.innerHTML = '<dl style="display:contents">' + rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('') + '</dl>';
}

function showWelcome(show) {
  ui.welcome.classList.toggle('hidden', !show);
  if (show) $('welcome-go').focus();
  else prefs.set('welcomed', true);
}

// Dock buttons: blur after click so Space/Enter go to the board shortcuts, not the button.
const click = (id, fn) => $(id).addEventListener('click', (e) => { fn(); e.currentTarget.blur(); });
click('btn-write', () => setWriting(!writingOn));
click('size-down', () => setSize(sizeSlot - 1));
click('size-up', () => setSize(sizeSlot + 1));
click('btn-undo', undo);
click('btn-clear', clearBoard);
click('btn-save', saveImage);
click('btn-theme', () => setTheme(themeName === 'dark' ? 'light' : 'dark'));
click('btn-calib', startCalibration);
click('btn-full', toggleFullscreen);
click('btn-help', () => showWelcome(true));
click('btn-pen', () => setPenMode(!penMode));
click('teach-go', captureTeach);
click('teach-cancel', () => { stopTeaching(); if (!penColor) setPenMode(false); });
click('welcome-go', () => showWelcome(false));
document.querySelectorAll('.swatch').forEach((b) => b.addEventListener('click', () => { setPen(Number(b.dataset.pen)); b.blur(); }));

window.addEventListener('keydown', (e) => {
  const key = e.key.toLowerCase();
  if (!ui.welcome.classList.contains('hidden')) {
    if (key === 'enter' || key === 'escape') { e.preventDefault(); showWelcome(false); }
    return;
  }
  if (teaching) {
    if (key === 'enter') { e.preventDefault(); captureTeach(); }
    else if (key === 'escape') { stopTeaching(); if (!penColor) setPenMode(false); }
    return;
  }
  // writing on/off: Shift, or a presentation clicker (Page Down / Page Up) when you're at the wall
  if ((e.key === 'Shift' || e.code === 'ShiftLeft' || e.code === 'ShiftRight' || e.key === 'PageDown' || e.key === 'PageUp') && !e.repeat) {
    e.preventDefault();
    setWriting(!writingOn);
    return;
  }
  if (e.code === 'Space') { e.preventDefault(); if (!e.repeat) clearBoard(); return; }
  if (e.repeat || e.altKey || e.metaKey || (e.ctrlKey && key !== 'z')) return;
  if (key === 'z') { e.preventDefault(); undo(); }
  else if (key === 'c') setPen((penSlot + 1) % THEMES.light.pens.length);
  else if (key >= '1' && key <= '5') setPen(Number(key) - 1);
  else if (key === '[') setSize(sizeSlot - 1);
  else if (key === ']') setSize(sizeSlot + 1);
  else if (key === '-' || key === '_') setSteadiness(steadiness - 1);
  else if (key === '=' || key === '+') setSteadiness(steadiness + 1);
  else if (key === 's') saveImage();
  else if (key === 't') setTheme(themeName === 'dark' ? 'light' : 'dark');
  else if (key === 'f') toggleFullscreen();
  else if (key === 'h') document.body.classList.toggle('ui-off'); // clean board for the audience
  else if (key === 'd') { ui.diag.classList.toggle('hidden'); updateDiag(); }
  else if (key === 'k') startCalibration();
  else if (key === 'p') setPenMode(!penMode);
  else if (key === 'l') startTeaching(); // learn (re-teach) the pen colour
  else if (key === 'v') camBox.classList.toggle('big'); // big live camera view with the tracked hand
  else if (key === 'escape') {
    if (calib) stopCalibration();
    else if (homography) { setHomography(null); toast('Calibration removed'); }
  }
});
window.addEventListener('blur', endStroke);
window.addEventListener('resize', resizeCanvas);

// ======================= start =======================

function useMouse() {
  mode = 'mouse';
  canvas.addEventListener('pointerdown', () => { mouseDown = true; });
  window.addEventListener('pointerup', () => { mouseDown = false; endStroke(); });
  window.addEventListener('pointermove', (e) => { target = { x: e.clientX / innerWidth, y: e.clientY / innerHeight }; });
  updateStatus(false);
}

async function start() {
  setStatus('loading', 'Starting', 'Loading the hand model');
  // ?src=<image or video URL>: run tracking on that file instead of the webcam (testing)
  const src = new URLSearchParams(location.search).get('src');
  try {
    if (src) {
      const el = /\.(jpe?g|png|webp|gif)(\?|$)/i.test(src) ? new Image() : video;
      el.crossOrigin = 'anonymous';
      el.src = src;
      if (el === video) { video.loop = true; await video.play(); camBox.classList.add('on'); }
      mode = 'camera';
      track(el);
      return;
    }
    video.srcObject = await navigator.mediaDevices.getUserMedia({
      // 60 fps when possible: shorter exposure = less motion blur = steadier tracking
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 60 } }
    });
    await video.play();
    camBox.classList.add('on');
    mode = 'camera';
    setStatus('loading', 'Starting', 'Loading the hand model');
    track(video);
  } catch (err) {
    console.warn('Camera unavailable, using mouse instead:', err);
    useMouse();
  }
}

document.documentElement.dataset.theme = themeName;
camBox.classList.toggle('mirror', !homography);
resizeCanvas();
syncDock();
if (inkClashesWithPen(penSlot)) penSlot = 1; // restored pen mode: start with ink the camera can't confuse
syncDock();
ui.penBtn.setAttribute('aria-pressed', penMode);
document.body.classList.toggle('pen-mode', penMode);
if (!prefs.get('welcomed', false)) showWelcome(true);
start();
