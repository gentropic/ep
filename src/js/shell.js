// The lead-acid shell door (SPEC-pocket §4.2). One place where ep touches
// the Android shell, feature-detected through the vendored shim
// (ext/leadacid/index.js → `shell`); on the web every function here falls
// back to the browser way and `shell.present` is simply false.
//
//   deliverFile  — exports. `<a download>` goes nowhere in a WebView and
//                  showSaveFilePicker is defined-but-aborting there, so
//                  inside the shell a file is streamed into Downloads
//                  (publishStream) and, on request, handed to the share
//                  sheet BY URI — never re-sent as bytes.
//   wireShellIntake — files and text shared INTO the app: .ep → open as a
//                  sheet; an exported form (.html) → its program; CSV →
//                  the attach flow; plain text → a sheet.

import { shell } from '../../ext/leadacid/index.js';
import { loadProgramText } from './io.js';
import { attachFromText } from './attach-dialog.js';
import { programFromExportedHtml, isExportedForm } from './exported-form.js';

export function shellPresent() {
  return !!(shell && shell.present);
}

function downloadBlob(text, name, mime) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 100);
}

// → { via: 'download' } on the web, { via: 'shell', uri } in the shell.
export async function deliverFile(name, text, mime, { share = false } = {}) {
  if (!shellPresent()) {
    downloadBlob(text, name, mime);
    return { via: 'download' };
  }
  const w = shell.publishStream(name, { collection: 'Downloads', mime });
  await w.write(text);
  await w.close();
  const r = await w.result;          // { uri, name, bytes }
  if (share) {
    // The chooser is the user's confirmation; a dismissed sheet is not an error.
    try { await shell.share(name, null, { mime, uri: r.uri }); } catch { /* dismissed */ }
  }
  return { via: 'shell', uri: r.uri };
}

// Open one shared thing. Exported for the drop / picker paths too, so a
// form dragged onto desktop ep opens the same way it does on the phone.
export async function openSharedText(text, name, mime) {
  const lower = String(name || '').toLowerCase();
  if (isExportedForm(text)) {
    const p = programFromExportedHtml(text);
    if (p) { loadProgramText(p.lines.join('\n'), p.name + '.ep'); return 'form'; }
  }
  if (lower.endsWith('.csv') || mime === 'text/csv') {
    await attachFromText(text, lower.replace(/\.csv$/, '') || 'data');
    return 'csv';
  }
  loadProgramText(text, name || 'shared.ep');
  return 'sheet';
}

export async function wireShellIntake() {
  if (!shellPresent() || typeof shell.intake !== 'function') return false;
  try {
    await shell.intake(async (item) => {
      try {
        if (item.kind === 'file' && item.blob) {
          const text = await item.blob.text();
          await openSharedText(text, item.name, item.mime);
        } else if (item.kind === 'text' && typeof item.text === 'string') {
          await openSharedText(item.text, 'shared.ep', 'text/plain');
        }
      } catch (e) { console.warn('ep: intake item failed:', e && e.message || e); }
    });
    return true;
  } catch (e) {
    // No intake plugin in this instrument — fine.
    return false;
  }
}
