// Format a Quantity to a human-readable string. Honors the disp tag set by
// convertTo; otherwise auto-scales to the largest unit that lands in
// [1, 1000) (with relaxed fallbacks for extreme magnitudes).

import { dimEq, dimEmpty, dimFormat } from './dimensions.js';

export function format(q, registry, opts) {
  const { num, unit } = formatParts(q, registry, opts);
  return unit ? `${num} ${unit}` : num;
}

export function formatParts(q, registry, opts = {}) {
  const sig = opts.sig ?? 5;
  if (dimEmpty(q.dim)) return { num: formatNumber(q.value, sig), unit: null };

  // Explicit display unit (from -> conversion) wins over auto-scale.
  if (q.disp) {
    const u = registry.resolve(q.disp);
    if (u && dimEq(u.dim, q.dim)) {
      return { num: formatNumber(q.value / u.mul, sig), unit: u.displayName };
    }
  }

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
  // Last resort: closest to magnitude 1 on log scale.
  if (!best) {
    cands.sort((a, b) => {
      const la = Math.abs(Math.log10(Math.abs(q.value / a.mul) || 1e-30));
      const lb = Math.abs(Math.log10(Math.abs(q.value / b.mul) || 1e-30));
      return la - lb;
    });
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
