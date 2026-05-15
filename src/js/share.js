// URL-based program sharing. Encodes the current program as ?p=<encoded>
// so a link/QR fully restores it on the recipient side.
//
// Pipeline: text → UTF-8 bytes → deflate-raw (when CompressionStream is
// available; falls back to identity) → base64url. The decode side accepts
// both compressed and uncompressed payloads to keep old links working.
//
// We don't vendor lz-string because CompressionStream is now universal in
// evergreen browsers and our base64url alphabet is URL-safe by construction.
// QR rendering uses the vendored encoder in ext/qrcode/.

import { state, evaluateAll } from './state.js';
import { renderChips, renderBody, renderResults } from './render.js';
import { uniqueProgramName, setCurrentProgramName, saveCurrentProgram } from './storage.js';
import { encodeQR, qrToSvg } from '../../ext/qrcode/dist/qrcode.js';

const PARAM_KEY = 'p';

function bytesToB64Url(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64UrlToBytes(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function compressForUrl(text) {
  const bytes = new TextEncoder().encode(text);
  if (typeof CompressionStream === 'undefined') return bytesToB64Url(bytes);
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  const buf = new Uint8Array(await new Response(stream).arrayBuffer());
  return bytesToB64Url(buf);
}

export async function decompressFromUrl(encoded) {
  const bytes = b64UrlToBytes(encoded);
  if (typeof DecompressionStream !== 'undefined') {
    try {
      const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      const buf = await new Response(stream).arrayBuffer();
      return new TextDecoder().decode(buf);
    } catch {
      // Fall through — payload was likely produced by the no-CompressionStream branch
    }
  }
  return new TextDecoder().decode(bytes);
}

export async function generateShareUrl(text) {
  const encoded = await compressForUrl(text);
  return location.origin + location.pathname + '?' + PARAM_KEY + '=' + encoded;
}

// Boot-side: detect a share payload (synchronously) so the boot path can
// decide which branch to take without unconditionally awaiting.
export function hasShareParam() {
  return new URLSearchParams(location.search).has(PARAM_KEY);
}

// Decode the share payload from the URL and clear it from the address bar
// so a reload doesn't re-trigger the import. Returns the source text, or
// null if decoding failed.
export async function consumeShareParam() {
  const params = new URLSearchParams(location.search);
  const enc = params.get(PARAM_KEY);
  if (!enc) return null;
  let text = null;
  try { text = await decompressFromUrl(enc); }
  catch (e) { console.warn('share-url decode failed:', e); }
  history.replaceState(null, '', location.pathname);
  return text;
}

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
