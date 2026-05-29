// URL-based program sharing — adopts the @gcu/morsel Phase-1 grammar.
//
// Share URL:  <origin>/<path>#i:d<base64url(deflate-raw(text))>
// QR-bound:   <origin>/<path>#q:d<base45(deflate-raw(text))>
//
// Both forms decode to the same bytes; the `q:` form costs ~22% fewer
// bits in QR alphanumeric mode than the `i:` form in byte mode, which
// is meaningfully better for printable / scan-from-distance QRs.
//
// Legacy `?p=<base64url>` (ep's pre-morsel format) is still recognized
// on the load side so any old links keep working — see consumeMorsel
// in morsel.js for the shim.

import { state, evaluateAll } from './state.js';
import { renderChips, renderBody, renderResults } from './render.js';
import { uniqueProgramName, setCurrentProgramName, saveCurrentProgram } from './storage.js';
import { encodeQR, qrToSvg } from '../../ext/qrcode/dist/qrcode.js';
import { encodeInlineI, encodeInlineQ, hasMorselFragment, consumeMorsel, fragmentEncode } from './morsel.js';

export async function generateShareUrl(text) {
  const morsel = await encodeInlineI(text);
  // fragmentEncode is a no-op for base64url (`i:`) but uniform + safe.
  return location.origin + location.pathname + '#' + fragmentEncode(morsel);
}

export async function generateShareUrlForQR(text) {
  const morsel = await encodeInlineQ(text);
  // base45 (`q:`) can contain space and `%` — escape them so the
  // fragment round-trips through QR-scan → browser-navigation → boot.
  return location.origin + location.pathname + '#' + fragmentEncode(morsel);
}

// Boot-side compatibility re-exports — main.js still imports these names.
export function hasShareParam() { return hasMorselFragment(); }
export async function consumeShareParam() { return consumeMorsel(); }

// Render a URL (or any text) as an inline SVG QR code. Picks ECC level M
// for a balance of density and error tolerance. Returns an SVG string.
export function qrSvgFor(text, opts = {}) {
  const qr = encodeQR(text, { ecc: opts.ecc || 'M' });
  return qrToSvg(qr, {
    moduleSize: opts.moduleSize || 4,
    margin:     opts.margin     ?? 2,
    foreground: opts.foreground || 'currentColor',
    background: opts.background || 'none',
  });
}

// Load a shared program as a fresh storage slot named "shared", "shared_2", etc.
// Does NOT clobber any current program — the recipient keeps their own work.
export function adoptSharedProgram(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  while (lines.length > 1 && lines[lines.length - 1].trim() === '') lines.pop();
  state.body = lines.map(src => ({src}));
  state.ui.collapsedBlocks = [];
  const name = uniqueProgramName('shared');
  setCurrentProgramName(name);
  evaluateAll();
  renderChips();
  renderBody();
  renderResults();
  saveCurrentProgram({force: true});
}
