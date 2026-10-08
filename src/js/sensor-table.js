// `@sensor` source table and the pure helpers behind it (SPEC-pocket §4.3).
// No DOM, no shell: sensors.js owns the readers, the evaluator owns the
// dimension check, this file owns what a source IS.
//
// A source name maps to a physical stream (`phys`: the lead-acid sensor
// type, also the key readers are shared under), the unit the value is
// expressed in (resolved at runtime by the evaluator's registry, so dims
// follow ep's conventions automatically), how to pick the scalar out of
// that stream's sample, and which web API stands in when there is no
// shell (null = the default literal is used and the chip says
// "unavailable").
//
// Samples reach `pick` already normalised by sensors.js:
//   rotation → { heading, beta, gamma }   (degrees; heading clockwise from north)
//   accel / gravity / gyro / magnetic → [x, y, z]
//   pressure / light / battery / clock → [v]

const XYZ = (phys, unit, web) => ({
  [phys + '.x']: { phys, unit, web, pick: v => v[0] },
  [phys + '.y']: { phys, unit, web, pick: v => v[1] },
  [phys + '.z']: { phys, unit, web, pick: v => v[2] },
});

export const SENSOR_SOURCES = {
  pressure: { phys: 'pressure', unit: 'hPa', web: null,          pick: v => v[0] },
  heading:  { phys: 'rotation', unit: 'deg', web: 'orientation', pick: o => o.heading },
  tilt:     { phys: 'rotation', unit: 'deg', web: 'orientation', pick: o => o.beta },
  roll:     { phys: 'rotation', unit: 'deg', web: 'orientation', pick: o => o.gamma },
  accel:    { phys: 'accel',    unit: 'm/s^2', web: 'motion',    pick: v => Math.hypot(v[0], v[1], v[2]) },
  ...XYZ('accel', 'm/s^2', 'motion'),
  ...XYZ('gravity', 'm/s^2', 'motion'),
  ...XYZ('gyro', 'rad/s', 'motion'),
  mag:      { phys: 'magnetic', unit: 'µT', web: 'magnetometer', pick: v => Math.hypot(v[0], v[1], v[2]) },
  'mag.x':  { phys: 'magnetic', unit: 'µT', web: 'magnetometer', pick: v => v[0] },
  'mag.y':  { phys: 'magnetic', unit: 'µT', web: 'magnetometer', pick: v => v[1] },
  'mag.z':  { phys: 'magnetic', unit: 'µT', web: 'magnetometer', pick: v => v[2] },
  light:    { phys: 'light',    unit: 'lx',  web: 'ambient-light', pick: v => v[0] },
  battery:  { phys: 'battery',  unit: '%',   web: 'battery',     pick: v => v[0] },
  time:     { phys: 'clock',    unit: 's',   web: 'clock',       pick: v => v[0] },
};

export const SENSOR_DEFAULT_RATE_HZ = 10;

// `@sensor(source[, N Hz][, avg T][, hold])` → { source, rateHz, avgS, hold }
// or null when the source is unknown. Args arrive as the decorator's
// comma-split strings.
export function parseSensorArgs(args) {
  if (!Array.isArray(args) || !args.length) return null;
  const source = String(args[0]).trim();
  if (!SENSOR_SOURCES[source]) return null;
  const spec = { source, rateHz: SENSOR_DEFAULT_RATE_HZ, avgS: 0, hold: false };
  for (const raw of args.slice(1)) {
    const a = String(raw).trim();
    let m;
    if ((m = /^(\d+(?:\.\d+)?)\s*Hz$/i.exec(a)))                    spec.rateHz = Math.max(0.1, Math.min(100, parseFloat(m[1])));
    else if ((m = /^avg\s+(\d+(?:\.\d+)?)\s*(ms|s|min)$/i.exec(a))) spec.avgS = parseFloat(m[1]) * ({ ms: 0.001, s: 1, min: 60 })[m[2].toLowerCase()];
    else if (/^hold$/i.test(a))                                     spec.hold = true;
    // anything else is ignored rather than fatal — a typo shouldn't
    // kill a live reading
  }
  return spec;
}

// Bounded time series of { t (ms), v } with the oldest dropped first.
export class RingBuffer {
  constructor(capacity = 6000) { this.cap = capacity; this.items = []; }
  push(t, v) {
    this.items.push({ t, v });
    if (this.items.length > this.cap) this.items.splice(0, this.items.length - this.cap);
  }
  // values with t >= since (ms), oldest first
  since(sinceMs) {
    let i = this.items.length;
    while (i > 0 && this.items[i - 1].t >= sinceMs) i--;
    return this.items.slice(i).map(s => s.v);
  }
  get last() { return this.items.length ? this.items[this.items.length - 1] : null; }
  clear() { this.items = []; }
}

// Trailing mean over the last `windowS` seconds; the newest sample alone
// when the window is 0 or nothing falls inside it.
export function trailingMean(buffer, nowMs, windowS) {
  if (!buffer || !buffer.last) return null;
  if (!(windowS > 0)) return buffer.last.v;
  const vals = buffer.since(nowMs - windowS * 1000);
  if (!vals.length) return buffer.last.v;
  let s = 0;
  for (const v of vals) s += v;
  return s / vals.length;
}

// Compass heading from the W3C deviceorientation alpha: alpha grows
// counter-clockwise, headings grow clockwise.
export function headingFromAlpha(alpha) {
  if (typeof alpha !== 'number' || !isFinite(alpha)) return null;
  return ((360 - alpha) % 360 + 360) % 360;
}
