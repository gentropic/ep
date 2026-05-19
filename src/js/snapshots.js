// Snapshots panel — per-program version history (§7.4). Slide-in panel
// modeled on settings, opened from the program ctxmenu ("history"). Each
// row shows when the snapshot was taken + optional label + actions:
// restore (replaces program body with snapshot's), pin/unpin (excludes
// from retention pruning), delete.
//
// Restore is non-destructive: storage.restoreSnapshot() takes a
// "before restore" snapshot first, so the user can always undo by
// restoring that one.

import { listSnapshots, restoreSnapshot, pinSnapshot, deleteSnapshot, formatAgo } from './storage.js';
import { epConfirm } from './dialogs.js';

const snapPanel    = document.getElementById('snapshotsPanel');
const snapBackBtn  = document.getElementById('snapshotsBackBtn');
const snapTitle    = document.getElementById('snapshotsTitle');
const snapSubtitle = document.getElementById('snapshotsSubtitle');
const snapListEl   = document.getElementById('snapshotsList');

let _currentName = null;

export function openSnapshots(name) {
  // When the persistent desktop drawer is active, snapshots live as a
  // mode of the drawer itself (left rail) — not a slide-over panel.
  // Dispatch into drawer.js via a custom event so we don't need to
  // cross-import. The slide-over remains the mobile / non-persistent
  // experience.
  if (document.documentElement.classList.contains('ep-drawer-persistent')) {
    window.dispatchEvent(new CustomEvent('ep:open-snapshots-in-drawer', { detail: { name } }));
    return;
  }
  if (!snapPanel) return;
  _currentName = name;
  if (snapTitle) snapTitle.textContent = `history · ${name}`;
  renderSnapshots();
  snapPanel.classList.add('on');
  snapPanel.setAttribute('aria-hidden', 'false');
  // Close the drawer so the panel is the only visible surface.
  window.dispatchEvent(new CustomEvent('ep:close-drawer'));
}

export function closeSnapshots() {
  if (!snapPanel) return;
  snapPanel.classList.remove('on');
  snapPanel.setAttribute('aria-hidden', 'true');
  _currentName = null;
}

function renderSnapshots() {
  if (!snapListEl || !_currentName) return;
  const snaps = listSnapshots(_currentName);   // newest first
  snapListEl.innerHTML = '';
  if (snapSubtitle) {
    snapSubtitle.textContent = snaps.length
      ? `${snaps.length} snapshot${snaps.length === 1 ? '' : 's'}`
      : 'no snapshots yet';
  }
  if (!snaps.length) {
    const empty = document.createElement('div');
    empty.className = 'settings-row-hint';
    empty.style.padding = '14px';
    empty.textContent = 'Take one from the program menu ("snapshot now…") or wait — ep auto-snapshots each program the first time you load it in a session.';
    snapListEl.appendChild(empty);
    return;
  }
  for (const snap of snaps) {
    snapListEl.appendChild(renderSnapshotsRow(snap));
  }
}

function renderSnapshotsRow(snap) {
  const row = document.createElement('div');
  row.className = 'settings-row snapshot-row';

  const info = document.createElement('div');
  info.className = 'settings-row-label';
  const headline = document.createElement('div');
  headline.className = 'snapshot-headline';
  if (snap.label) {
    const lbl = document.createElement('span');
    lbl.className = 'snapshot-label';
    lbl.textContent = snap.label;
    headline.appendChild(lbl);
  } else {
    const auto = document.createElement('span');
    auto.className = 'snapshot-auto';
    auto.textContent = 'auto';
    headline.appendChild(auto);
  }
  if (snap.pinned) {
    const pin = document.createElement('span');
    pin.className = 'snapshot-pin-glyph';
    pin.textContent = '◆';
    pin.title = 'pinned (never auto-purged)';
    headline.appendChild(pin);
  }
  info.appendChild(headline);
  const meta = document.createElement('div');
  meta.className = 'settings-row-hint';
  const ago = formatAgo(snap.takenAt);
  const abs = new Date(snap.takenAt).toLocaleString();
  meta.textContent = `${ago} · ${abs} · ${snap.body.length} line${snap.body.length === 1 ? '' : 's'}`;
  info.appendChild(meta);

  const actions = document.createElement('div');
  actions.className = 'snapshot-actions';

  const restoreBtn = document.createElement('button');
  restoreBtn.className = 'settings-btn';
  restoreBtn.textContent = 'restore';
  restoreBtn.addEventListener('click', () => doRestore(snap));
  actions.appendChild(restoreBtn);

  const pinBtn = document.createElement('button');
  pinBtn.className = 'settings-btn';
  pinBtn.textContent = snap.pinned ? 'unpin' : 'pin';
  pinBtn.addEventListener('click', () => {
    pinSnapshot(_currentName, snap.id, !snap.pinned);
    renderSnapshots();
  });
  actions.appendChild(pinBtn);

  const delBtn = document.createElement('button');
  delBtn.className = 'settings-btn danger';
  delBtn.textContent = 'delete';
  delBtn.addEventListener('click', () => doDelete(snap));
  actions.appendChild(delBtn);

  row.appendChild(info);
  row.appendChild(actions);
  return row;
}

async function doRestore(snap) {
  const ok = await epConfirm({
    title: 'Restore snapshot?',
    message: snap.label
      ? `Replace the current program with the snapshot "${snap.label}"? Your current state will be saved as a "before restore" snapshot first.`
      : `Replace the current program with this snapshot? Your current state will be saved as a "before restore" snapshot first.`,
    okLabel: 'Restore',
  });
  if (!ok) return;
  restoreSnapshot(_currentName, snap.id);
  renderSnapshots();   // refresh — the auto pre-restore snap is now in the list
}

async function doDelete(snap) {
  const ok = await epConfirm({
    title: 'Delete snapshot?',
    message: snap.label
      ? `Delete the snapshot "${snap.label}"? This can't be undone.`
      : `Delete this snapshot? This can't be undone.`,
    okLabel: 'Delete',
    danger: true,
  });
  if (!ok) return;
  deleteSnapshot(_currentName, snap.id);
  renderSnapshots();
}

if (snapBackBtn) snapBackBtn.addEventListener('click', closeSnapshots);
window.addEventListener('keydown', e => {
  if (e.key === 'Escape' && snapPanel && snapPanel.classList.contains('on')) closeSnapshots();
});
// Re-renderSnapshots if storage changes underneath us (e.g., another tab edited).
window.addEventListener('ep:storage-changed', () => {
  if (snapPanel && snapPanel.classList.contains('on')) renderSnapshots();
});
