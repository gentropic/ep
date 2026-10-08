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
  // Structural geology — the phone as a compass-clinometer. Plane: lay the
  // back of the phone on the surface. Line: lay the long edge along the
  // lineation. All derived from the same fused rotation (attitudeFrom).
  dip:           { phys: 'rotation', unit: 'deg', web: 'orientation', pick: o => o.dip },
  dip_direction: { phys: 'rotation', unit: 'deg', web: 'orientation', pick: o => o.dipDirection },
  strike:        { phys: 'rotation', unit: 'deg', web: 'orientation', pick: o => o.strike },
  trend:         { phys: 'rotation', unit: 'deg', web: 'orientation', pick: o => o.trend },
  plunge:        { phys: 'rotation', unit: 'deg', web: 'orientation', pick: o => o.plunge },
  rake:          { phys: 'rotation', unit: 'deg', web: 'orientation', pick: o => o.rake },
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

// Capture (SPEC-pocket §4.3, "measure"): append readings to per-binding
// log lists in the sheet's source. `readings` is [{ name, text }] with
// text already formatted in the binding's unit ("171.3 deg"). For each
// one, a line `<name>_log = [ … ]` is extended in place if it exists,
// else created under a `# measurements` heading at the end. Pure: takes
// and returns the lines array. The log stays plain Numbat (a list), so
// `stereonet_planes(dd_log, dip_log)` and `len(dd_log)` just work.
export function captureEdits(lines, readings) {
  const out = lines.slice();
  const pending = [];
  for (const { name, text } of readings) {
    const re = new RegExp(`^(\\s*${name}_log\\s*=\\s*\\[)([^\\]]*)(\\].*)$`);
    let done = false;
    for (let i = 0; i < out.length; i++) {
      const m = re.exec(out[i]);
      if (!m) continue;
      const inner = m[2].trim();
      out[i] = m[1] + (inner ? inner + ', ' + text : text) + m[3];
      done = true;
      break;
    }
    if (!done) pending.push(`${name}_log = [${text}]`);
  }
  if (pending.length) {
    // Where the block goes: after the existing log lines under the
    // `# measurements` heading when there is one; otherwise right after
    // the last @sensor binding — BEFORE anything later that may already
    // use the logs (`stereonet_planes(dd_log, dip_log)` at the end of a
    // sheet must see them defined above it).
    const headingAt = out.findIndex(l => /^\s*#\s*measurements\b/i.test(l));
    let at;
    if (headingAt >= 0) {
      // past the heading's own comment lines and the logs already there
      at = headingAt + 1;
      while (at < out.length && /^\s*(#|[A-Za-z_][A-Za-z0-9_]*_log\s*=)/.test(out[at])) at++;
      out.splice(at, 0, ...pending);
    } else {
      let lastSensor = -1;
      for (let i = 0; i < out.length; i++) if (/^\s*@sensor\b/.test(out[i])) lastSensor = i + 1;   // the binding line below it
      at = lastSensor >= 0 ? Math.min(lastSensor + 1, out.length) : out.length;
      const block = ['', '# measurements', ...pending];
      if (at < out.length && out[at].trim() !== '') block.push('');
      out.splice(at, 0, ...block);
    }
  }
  return out;
}

// The day's measurements as CSV: one column per `<name>_log` list, one
// row per measurement index, the unit in the header (`dd_log (deg)`).
// `logs` is [{ name, unit, values: number[] }] with values already in
// the display unit; ragged lists leave cells empty. Plain numbers, no
// locale separators; RFC 4180 line ends.
export function measurementsCsv(logs) {
  const cols = (logs || []).filter(l => l && Array.isArray(l.values));
  if (!cols.length) return '';
  const esc = (s) => /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  const header = ['n', ...cols.map(l => esc(l.unit ? `${l.name} (${l.unit})` : l.name))];
  const rows = Math.max(...cols.map(l => l.values.length));
  const lines = [header.join(',')];
  for (let i = 0; i < rows; i++) {
    lines.push([String(i + 1), ...cols.map(l => (i < l.values.length && l.values[i] != null) ? esc(String(l.values[i])) : '')].join(','));
  }
  return lines.join('\r\n') + '\r\n';
}

// Compass heading from the W3C deviceorientation alpha: alpha grows
// counter-clockwise, headings grow clockwise.
export function headingFromAlpha(alpha) {
  if (typeof alpha !== 'number' || !isFinite(alpha)) return null;
  return ((360 - alpha) % 360 + 360) % 360;
}

// Structural attitude from a W3C orientation triple (degrees). The
// device→earth rotation is R = Rz(α)·Rx(β)·Ry(γ) with device axes x right,
// y top, z out of the screen and earth axes east, north, up (the W3C
// spec's own matrix; the lead-acid shim produces the same triple from
// the fused rotation vector).
//
//   plane (phone's back on the surface): the upward unit normal n is the
//   device z axis flipped up if needed; dip = acos(n·up); the horizontal
//   part of an upward normal points DOWN-dip, so dip direction =
//   atan2(n.east, n.north); strike = dip direction − 90 (right-hand rule:
//   dip to the right when looking along strike).
//   line (long edge along the lineation): the device y axis, taken at
//   its downward end; plunge = asin(−d.up); trend = atan2(d.east, d.north).
//   rake: the angle in the plane from the right-hand strike direction to
//   the line, 0–180°.
// Returns null when the triple is incomplete. Angles in degrees.
export function attitudeFrom(alpha, beta, gamma) {
  if (![alpha, beta, gamma].every(v => typeof v === 'number' && isFinite(v))) return null;
  const r = Math.PI / 180;
  const cA = Math.cos(alpha * r), sA = Math.sin(alpha * r);
  const cB = Math.cos(beta * r),  sB = Math.sin(beta * r);
  const cG = Math.cos(gamma * r), sG = Math.sin(gamma * r);
  // columns of R: device x, y, z expressed in (east, north, up)
  const y = [-sA * cB, cA * cB, sB];
  let   n = [cA * sG + sA * sB * cG, sA * sG - cA * sB * cG, cB * cG];
  if (n[2] < 0) n = n.map(v => -v);
  const az = (e, nn) => ((Math.atan2(e, nn) / r) % 360 + 360) % 360;
  const dip = Math.acos(Math.max(-1, Math.min(1, n[2]))) / r;
  const dipDirection = dip < 1e-6 ? 0 : az(n[0], n[1]);
  const strike = (dipDirection - 90 + 360) % 360;
  const d = y[2] > 0 ? y.map(v => -v) : y;              // downward end of the long edge
  const plunge = Math.asin(Math.max(-1, Math.min(1, -d[2]))) / r;
  const trend = az(d[0], d[1]);
  // rake: angle from the strike direction (horizontal, in the plane) to d
  const sr = strike * r;
  const s = [Math.sin(sr), Math.cos(sr), 0];
  const dot = Math.max(-1, Math.min(1, s[0] * d[0] + s[1] * d[1] + s[2] * d[2]));
  const rake = Math.acos(dot) / r;
  return { dip, dipDirection, strike, trend, plunge, rake };
}
