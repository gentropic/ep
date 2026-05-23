// Format a Quantity to a human-readable string. Honors the disp tag set by
// convertTo; otherwise auto-scales to the largest unit that lands in
// [1, 1000) (with relaxed fallbacks for extreme magnitudes).

import { dimEq, dimEmpty, dimFormat } from './dimensions.js';
import { DateTime } from './quantity.js';

export function format(q, registry, opts) {
  const { num, unit } = formatParts(q, registry, opts);
  return unit ? `${num} ${unit}` : num;
}

export function formatParts(q, registry, opts = {}) {
  const sig = opts.sig ?? 5;

  // A DateTime is a point in time, not a duration — render it as a
  // calendar date string, never an auto-scaled quantity.
  if (q instanceof DateTime) {
    return { num: formatDateTimeValue(q), unit: null };
  }

  // Explicit display unit. Two forms:
  //   - a string unit name (set by a `->` conversion) — resolved via
  //     the registry;
  //   - a pre-resolved { mul, name } object (set by a unit-loaded CSV
  //     column) — used directly, which also covers compound units like
  //     `g/t` that registry.resolve can't look up by name.
  // Checked BEFORE the dimensionless early-return: a dimensionless disp
  // (g/t, ppm, %) is the only thing that makes 1.62e-6 read as
  // "1.62 g/t".
  if (q.disp) {
    if (typeof q.disp === 'object') {
      return { num: formatNumber(q.value / q.disp.mul, sig), unit: q.disp.name };
    }
    const u = registry.resolve(q.disp);
    if (u && dimEq(u.dim, q.dim)) {
      return { num: formatNumber(q.value / u.mul, sig), unit: u.displayName };
    }
  }

  if (dimEmpty(q.dim)) return { num: formatNumber(q.value, sig), unit: null };

  const cands = registry.list(q.dim);
  if (!cands.length) return { num: formatNumber(q.value, sig), unit: `[${dimFormat(q.dim)}]` };

  cands.sort((a, b) => b.mul - a.mul);
  let best = null;
  // Prefer the largest unit whose scaled value lands in [1, 1000).
  for (const c of cands) {
    const s = q.value / c.mul;
    if (Math.abs(s) >= 1 && Math.abs(s) < 1000) { best = { entry: c, scaled: s }; break; }
  }
  // Relaxed: keep within a permissive window so 80,000 m³ stays in m³, not km³.
  if (!best) {
    for (const c of cands) {
      const s = q.value / c.mul;
      if (Math.abs(s) >= 0.01 && Math.abs(s) < 1e6) { best = { entry: c, scaled: s }; break; }
    }
  }
  // Last resort: closest to magnitude 1 on log scale. For q.value === 0
  // every candidate is equidistant (log of zero collapses to the
  // 1e-30 fallback), so the tiebreaker falls back to the unit nearest
  // mul=1 rather than whatever the descending-by-mul list happens to
  // land on (which would otherwise be Q-prefixed monstrosities like
  // "Qgregorian_year").
  if (!best) {
    if (q.value === 0) {
      cands.sort((a, b) =>
        Math.abs(Math.log10(a.mul)) - Math.abs(Math.log10(b.mul))
      );
    } else {
      cands.sort((a, b) => {
        const la = Math.abs(Math.log10(Math.abs(q.value / a.mul) || 1e-30));
        const lb = Math.abs(Math.log10(Math.abs(q.value / b.mul) || 1e-30));
        return la - lb;
      });
    }
    best = { entry: cands[0], scaled: q.value / cands[0].mul };
  }
  return { num: formatNumber(best.scaled, sig), unit: best.entry.displayName };
}

export function formatNumber(n, sig = 5) {
  if (!isFinite(n)) return String(n);
  if (n === 0) return '0';
  const abs = Math.abs(n);
  // Exponential digits track sig - 2 so 5 sig → "1.234e5" (legacy default).
  const expDigits = Math.max(0, sig - 2);
  if (abs < 1e-4 || abs >= 1e9) return n.toExponential(expDigits).replace('e+', 'e');
  const s = parseFloat(n.toPrecision(sig)).toString();
  if (Math.abs(parseFloat(s)) >= 1000) {
    const parts = s.split('.');
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return parts.join('.');
  }
  return s;
}

// ── Datetime formatting ──────────────────────────────────────────
// Lives here (not in load.js) because format.js is concatenated first
// and formatParts needs the strftime helper to render DateTime values.
// load.js imports formatDatetimeWith for BUILTIN_PROCS.format_datetime.

function hostTz() {
  // Mirrors load.js get_local_timezone — prefer Temporal's detection,
  // which is more reliable than Intl's in some runtimes.
  if (typeof globalThis.Temporal !== 'undefined') {
    try { return globalThis.Temporal.Now.timeZoneId(); } catch {}
  }
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; }
  catch { return 'UTC'; }
}

// Default rendering for a DateTime value. The clock part is shown only
// when the value isn't exactly midnight in its zone — so `today` reads
// "2026-05-20" while a precise instant reads "2026-05-20 14:32:09".
function formatDateTimeValue(q) {
  const tz = q.tz || hostTz();
  const hms = formatDatetimeWith('%H%M%S', q.value, tz);
  const fmt = hms === '000000' ? '%Y-%m-%d' : '%Y-%m-%d %H:%M:%S';
  return formatDatetimeWith(fmt, q.value, tz);
}

// strftime-ish formatter used by formatDateTimeValue and by
// BUILTIN_PROCS.format_datetime. Recognized tokens: %Y (4-digit year),
// %y (2-digit year), %m (zero-padded month), %d (zero-padded day),
// %H (24h zero-pad hour), %M (zero-pad minute), %S (zero-pad second),
// %B (full month name), %b (abbrev month name), %A (full weekday),
// %a (abbrev weekday), %j (day-of-year), %z (offset like +0100),
// %Z (TZ name). `%%` is a literal %. Unrecognized `%<x>` passes
// through as `%<x>`.
export function formatDatetimeWith(fmt, secs, tz) {
  let parts;
  if (typeof globalThis.Temporal !== 'undefined') {
    try {
      const inst = globalThis.Temporal.Instant.fromEpochMilliseconds(Math.round(secs * 1000));
      const zdt = inst.toZonedDateTimeISO(tz);
      parts = {
        Y: String(zdt.year).padStart(4, '0'),
        y: String(zdt.year % 100).padStart(2, '0'),
        m: String(zdt.month).padStart(2, '0'),
        d: String(zdt.day).padStart(2, '0'),
        H: String(zdt.hour).padStart(2, '0'),
        M: String(zdt.minute).padStart(2, '0'),
        S: String(zdt.second).padStart(2, '0'),
        j: String(zdt.dayOfYear).padStart(3, '0'),
        Z: tz,
        z: zdt.offset.replace(':', ''),
        A: intlFmt(zdt.epochMilliseconds, tz, { weekday: 'long' }),
        a: intlFmt(zdt.epochMilliseconds, tz, { weekday: 'short' }),
        B: intlFmt(zdt.epochMilliseconds, tz, { month: 'long' }),
        b: intlFmt(zdt.epochMilliseconds, tz, { month: 'short' }),
      };
    } catch { parts = null; }
  }
  if (!parts) {
    // Fallback via Date — UTC accurate, TZ-arg ignored. Use Intl for
    // weekday/month names so locale formatting works.
    const d = new Date(secs * 1000);
    parts = {
      Y: String(d.getUTCFullYear()).padStart(4, '0'),
      y: String(d.getUTCFullYear() % 100).padStart(2, '0'),
      m: String(d.getUTCMonth() + 1).padStart(2, '0'),
      d: String(d.getUTCDate()).padStart(2, '0'),
      H: String(d.getUTCHours()).padStart(2, '0'),
      M: String(d.getUTCMinutes()).padStart(2, '0'),
      S: String(d.getUTCSeconds()).padStart(2, '0'),
      j: String(Math.floor((d - new Date(Date.UTC(d.getUTCFullYear(), 0, 0))) / 86400000)).padStart(3, '0'),
      Z: 'UTC',
      z: '+0000',
      A: intlFmt(d.getTime(), 'UTC', { weekday: 'long' }),
      a: intlFmt(d.getTime(), 'UTC', { weekday: 'short' }),
      B: intlFmt(d.getTime(), 'UTC', { month: 'long' }),
      b: intlFmt(d.getTime(), 'UTC', { month: 'short' }),
    };
  }
  return fmt.replace(/%(.)/g, (_, c) => {
    if (c === '%') return '%';
    return parts[c] !== undefined ? parts[c] : '%' + c;
  });
}

function intlFmt(epochMs, tz, opts) {
  try {
    return new Intl.DateTimeFormat('en-US', { ...opts, timeZone: tz })
      .format(new Date(epochMs));
  } catch { return ''; }
}
