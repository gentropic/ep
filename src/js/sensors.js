// Live sensor inputs (SPEC-pocket §4.3 / §4.4). Watches state.params for
// @sensor bindings, keeps one reader per physical stream, and writes the
// latest reading (canonical units) into state._live; a 2 Hz scheduler
// re-evaluates the sheet while anything is live. Two reader families:
//
//   shell — inside the lead-acid instrument: `shell.stream('sensor/stream?
//           types=…')`, the fused rotation vector turned into heading /
//           tilt / roll through the shim's orientationFromRotationVector.
//   web   — DeviceOrientation / DeviceMotion / Battery / the clock, where
//           a browser has them. Pressure, light and the magnetometer have
//           no usable web path → "unavailable", the default literal stands.
//
// Readers close when the page is hidden (battery; the shell closes push
// streams on onPause anyway) and reopen on the next evaluate once visible.
// `hold` freezes a binding at its last reading; the value stays in
// state._live so the sheet keeps computing with it.

import { state, evaluateAll } from './state.js';
import { renderResults, editorView, showToast } from './render.js';
import { resolveUnitExpression } from './evaluator.js';
import { getSetting } from './storage.js';
import { SENSOR_SOURCES, RingBuffer, trailingMean, headingFromAlpha, attitudeFrom, captureEdits } from './sensor-table.js';
import { shell, orientationFromRotationVector } from '../../ext/leadacid/index.js';

const REEVAL_MS = 500;            // ≤ 2 Hz re-evaluation while live
const BUFFER_CAP = 6000;          // 10 min at 10 Hz

const buffers = new Map();        // binding name → RingBuffer (canonical values)
const held = new Set();           // binding names frozen by the user / `hold`
const status = new Map();         // binding name → 'live' | 'held' | 'waiting' | 'unavailable'
const readers = new Map();        // phys → { close() }
const unitMul = new Map();        // source → canonical multiplier (resolved once)
let timer = null;
let dirty = false;
let hiddenPause = false;
const t0 = Date.now();

const mulFor = (source) => {
  if (!unitMul.has(source)) {
    try { unitMul.set(source, resolveUnitExpression(SENSOR_SOURCES[source].unit).mul); }
    catch { unitMul.set(source, 1); }
  }
  return unitMul.get(source);
};

// Which @sensor bindings the sheet declares right now, by source.
function wanted() {
  const out = [];
  for (const p of state.params || []) if (p.sensor && SENSOR_SOURCES[p.sensor.source]) out.push(p);
  return out;
}

// A normalised sample for a physical stream arrived: fan it out to every
// binding reading from that stream.
function onSample(phys, sample, tMs = Date.now()) {
  for (const p of wanted()) {
    const src = SENSOR_SOURCES[p.sensor.source];
    if (src.phys !== phys) continue;
    const raw = src.pick(sample);
    if (typeof raw !== 'number' || !isFinite(raw)) continue;
    const canonical = raw * mulFor(p.sensor.source);
    let buf = buffers.get(p.name);
    if (!buf) buffers.set(p.name, buf = new RingBuffer(BUFFER_CAP));
    buf.push(tMs, canonical);
    if (held.has(p.name)) { status.set(p.name, 'held'); continue; }
    const v = trailingMean(buf, tMs, p.sensor.avgS);
    state._live.set(p.name, { value: v, t: tMs });
    status.set(p.name, 'live');
    dirty = true;
  }
}

// One normalised rotation sample for every source that reads from the
// fused orientation: the phone-ish names and the structural attitude.
function rotationSample(alpha, beta, gamma) {
  const att = attitudeFrom(alpha, beta, gamma) || {};
  return { heading: headingFromAlpha(alpha), beta, gamma, ...att };
}

// ── readers ───────────────────────────────────────────────────────
function openShellReader(phys, rateHz) {
  const types = phys;
  let api = null, closed = false;
  shell.stream(`sensor/stream?types=${encodeURIComponent(types)}&rateHz=${Math.round(rateHz)}`).then(s => {
    if (closed) { s.close(); return; }
    api = s;
    s.on(phys, (d) => {
      const t = Date.now();
      if (phys === 'rotation') {
        const o = orientationFromRotationVector(d.v);
        if (!o) return;
        onSample('rotation', rotationSample(o.alpha, o.beta, o.gamma), t);
      } else {
        onSample(phys, Array.isArray(d.v) ? d.v : [d.v], t);
      }
    });
  }).catch(() => { markUnavailable(phys); });
  return { close() { closed = true; if (api) api.close(); } };
}

function openWebReader(phys) {
  const web = Object.values(SENSOR_SOURCES).find(s => s.phys === phys)?.web;
  if (phys === 'clock') {
    const id = setInterval(() => onSample('clock', [(Date.now() - t0) / 1000]), 1000);
    onSample('clock', [(Date.now() - t0) / 1000]);
    return { close() { clearInterval(id); } };
  }
  if (phys === 'battery') {
    let bat = null, id = null;
    if (navigator.getBattery) {
      navigator.getBattery().then(b => { bat = b; const tick = () => onSample('battery', [b.level * 100]); tick(); id = setInterval(tick, 5000); }).catch(() => markUnavailable(phys));
    } else markUnavailable(phys);
    return { close() { if (id) clearInterval(id); bat = null; } };
  }
  if (web === 'orientation' && 'DeviceOrientationEvent' in window) {
    // Both event names: Chromium fires `deviceorientationabsolute` (true
    // north) where it can and plain `deviceorientation` elsewhere; a
    // page that only listens to one stays silent on the other platform.
    // Once an absolute reading has arrived the relative one is ignored.
    let sawAbsolute = false;
    const h = (e) => {
      // Chromium fires one null absolute event on attach when no sensor
      // backs it — that must not latch the preference.
      if (e.alpha == null && e.beta == null) return;
      if (e.type === 'deviceorientationabsolute') sawAbsolute = true;
      else if (sawAbsolute) return;
      const s = rotationSample(e.alpha, e.beta, e.gamma);
      if (typeof e.webkitCompassHeading === 'number') s.heading = e.webkitCompassHeading;
      onSample('rotation', s);
    };
    window.addEventListener('deviceorientationabsolute', h);
    window.addEventListener('deviceorientation', h);
    // iOS asks for permission on a user gesture; without it the event is
    // simply silent and the binding stays "waiting".
    if (typeof DeviceOrientationEvent.requestPermission === 'function') {
      DeviceOrientationEvent.requestPermission().catch(() => {});
    }
    return { close() { window.removeEventListener('deviceorientationabsolute', h); window.removeEventListener('deviceorientation', h); } };
  }
  if (web === 'motion' && 'DeviceMotionEvent' in window) {
    const h = (e) => {
      const a = e.acceleration, g = e.accelerationIncludingGravity, r = e.rotationRate;
      if (phys === 'accel' && a && a.x != null) onSample('accel', [a.x, a.y, a.z]);
      if (phys === 'gravity' && g && a && g.x != null) onSample('gravity', [g.x - (a.x || 0), g.y - (a.y || 0), g.z - (a.z || 0)]);
      if (phys === 'gyro' && r && r.alpha != null) onSample('gyro', [r.beta, r.gamma, r.alpha].map(d => d * Math.PI / 180));
    };
    window.addEventListener('devicemotion', h);
    return { close() { window.removeEventListener('devicemotion', h); } };
  }
  if (web === 'magnetometer' && 'Magnetometer' in window) {
    try {
      const m = new window.Magnetometer({ frequency: 10 });
      m.addEventListener('reading', () => onSample('magnetic', [m.x, m.y, m.z]));
      m.addEventListener('error', () => markUnavailable(phys));
      m.start();
      return { close() { m.stop(); } };
    } catch { /* fall through */ }
  }
  if (web === 'ambient-light' && 'AmbientLightSensor' in window) {
    try {
      const s = new window.AmbientLightSensor({ frequency: 2 });
      s.addEventListener('reading', () => onSample('light', [s.illuminance]));
      s.addEventListener('error', () => markUnavailable(phys));
      s.start();
      return { close() { s.stop(); } };
    } catch { /* fall through */ }
  }
  markUnavailable(phys);
  return { close() {} };
}

function markUnavailable(phys) {
  for (const p of wanted()) {
    if (SENSOR_SOURCES[p.sensor.source].phys === phys && !state._live.has(p.name)) status.set(p.name, 'unavailable');
  }
}

function openReader(phys, rateHz) {
  // battery and the clock are page-side everywhere; the rest prefer the shell.
  if (phys === 'battery' || phys === 'clock') return openWebReader(phys);
  if (shell && shell.present) return openShellReader(phys, rateHz);
  return openWebReader(phys);
}

// ── sync with the sheet ───────────────────────────────────────────
export function syncSensors() {
  const want = wanted();
  const needPhys = new Map();      // phys → max rate asked
  for (const p of want) {
    const src = SENSOR_SOURCES[p.sensor.source];
    needPhys.set(src.phys, Math.max(needPhys.get(src.phys) || 0, p.sensor.rateHz || 10));
    if (p.sensor.hold && !held.has(p.name) && !status.has(p.name)) held.add(p.name);
    if (!status.has(p.name)) status.set(p.name, held.has(p.name) ? 'held' : 'waiting');
  }
  // drop state for bindings that no longer exist
  const names = new Set(want.map(p => p.name));
  for (const n of [...state._live.keys()]) if (!names.has(n)) { state._live.delete(n); buffers.delete(n); held.delete(n); status.delete(n); }
  // open / close readers
  if (!hiddenPause) {
    for (const [phys, rate] of needPhys) if (!readers.has(phys)) readers.set(phys, openReader(phys, rate));
  }
  for (const [phys, r] of [...readers]) if (!needPhys.has(phys) || hiddenPause) { r.close(); readers.delete(phys); }
  // scheduler
  if (needPhys.size && !timer) {
    timer = setInterval(() => {
      if (!dirty) return;
      dirty = false;
      // A phone at rest still streams samples; skip the re-evaluation
      // when no reading moved at the displayed precision — nothing on
      // screen would change.
      const key = liveKey();
      if (key === lastTickKey) return;
      lastTickKey = key;
      evaluateAll();
      renderResults();
    }, REEVAL_MS);
  } else if (!needPhys.size && timer) { clearInterval(timer); timer = null; }
}

let lastTickKey = '';
function liveKey() {
  const sig = Math.max(3, Math.min(10, getSetting('sigDigits', 4) | 0));
  const parts = [];
  for (const [name, r] of state._live) parts.push(name, held.has(name) ? 'h' : Number(r.value).toPrecision(sig));
  return parts.join('\u0001');
}

export function sensorStatus(name) { return status.get(name) || null; }

export function toggleSensorHold(name) {
  if (held.has(name)) { held.delete(name); status.set(name, state._live.has(name) ? 'live' : 'waiting'); }
  else { held.add(name); status.set(name, 'held'); }
  dirty = true;
  renderResults();
}

export function isSensorHeld(name) { return held.has(name); }

export function hasLiveSensors() { return !!(state._live && state._live.size); }

// Format a live binding's current value in its own display unit, as
// source text that parses back (`171.3 deg`, `1_013.2 hPa` — never a
// locale comma).
function readingText(name) {
  const q = state._scope && state._scope[name];
  if (!q || typeof q.value !== 'number') return null;
  let mul = 1, unit = '';
  const d = q.disp;
  if (d && typeof d === 'object') { mul = d.mul; unit = d.name; }
  else if (typeof d === 'string') { try { const s = resolveUnitExpression(d); mul = s.mul; unit = s.displayName; } catch { /* dimensionless fallback */ } }
  const sig = Math.max(3, Math.min(10, getSetting('sigDigits', 4) | 0));
  const n = Number((q.value / mul).toPrecision(sig));
  const num = String(n).replace(/,/g, '_');
  return unit ? `${num} ${unit}` : num;
}

// "measure": append every live reading to its `<name>_log` list in the
// sheet (sensor-table.js captureEdits). One editor transaction, so one
// undo step removes a bad capture. Returns the number of readings logged.
export function captureReadings() {
  const view = editorView();
  if (!view) return 0;
  const readings = [];
  for (const p of wanted()) {
    if (!state._live.has(p.name)) continue;
    const text = readingText(p.name);
    if (text) readings.push({ name: p.name, text });
  }
  if (!readings.length) return 0;
  const before = view.state.doc.toString();
  const after = captureEdits(before.split('\n'), readings).join('\n');
  if (after !== before) {
    view.dispatch({ changes: { from: 0, to: before.length, insert: after }, userEvent: 'input.capture' });
  }
  if (navigator.vibrate) { try { navigator.vibrate(25); } catch { /* no haptics */ } }
  // Say what happened: the log lines usually sit out of view (under the
  // sensor bindings, while the user watches a plot further down).
  const first = new RegExp(`^\\s*${readings[0].name}_log\\s*=\\s*\\[([^\\]]*)\\]`, 'm').exec(after);
  const n = first ? first[1].split(',').filter(s => s.trim()).length : 1;
  const names = readings.map(r => r.name + '_log');
  const list = names.length > 3 ? names.slice(0, 2).join(', ') + ` and ${names.length - 2} more` : names.join(', ');
  showToast(`measurement ${n} logged → ${list}`);
  return readings.length;
}

state._recordSource = (name, windowS) => {
  const buf = buffers.get(name);
  if (!buf) return [];
  return buf.since(Date.now() - windowS * 1000);
};

window.addEventListener('ep:evaluated', syncSensors);
document.addEventListener('visibilitychange', () => {
  hiddenPause = document.hidden;
  syncSensors();
});
