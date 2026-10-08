// Read a program back out of an exported form (the viewer .html). The
// export bakes `const INITIAL_STATE = <JSON>;` between the STATE markers
// (export.js buildExportHtml), so an exported form shared back into ep —
// through the shell's intake, a file drop, or the picker — can be opened
// as a sheet again. Pure (no DOM); unit-tested.

const STATE_RE = /\/\* MARKER:STATE_START \*\/\s*const INITIAL_STATE = ([\s\S]*?);\s*\/\* MARKER:STATE_END \*\//;

export function isExportedForm(text) {
  return typeof text === 'string' && /MARKER:STATE_START/.test(text) && /<html/i.test(text);
}

// → { name, lines, assets } or null when the file isn't an ep export (or
// its state block isn't the JSON export.js writes).
export function programFromExportedHtml(html) {
  if (!isExportedForm(html)) return null;
  const m = STATE_RE.exec(html);
  if (!m) return null;
  let st;
  try { st = JSON.parse(m[1]); } catch { return null; }
  if (!st || !Array.isArray(st.body)) return null;
  const lines = st.body.map(r => (r && typeof r.src === 'string') ? r.src : '');
  return { name: typeof st.name === 'string' ? st.name : 'form', lines, assets: st.assets || {} };
}
