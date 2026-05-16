// Snapshot retention policy is a pure function — easy to test without
// stubbing localStorage. The takeSnapshot / restoreSnapshot wrappers
// touch state.js (which needs INITIAL_STATE from the template), so we
// test pruneSnapshots in isolation here.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { pruneSnapshots } from '../src/js/snapshot-retention.js';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function snap(takenAt, opts = {}) {
  return {
    id: 'snap_' + takenAt,
    takenAt,
    label: opts.label || null,
    pinned: !!opts.pinned,
    body: [],
    scenarios: {},
    activeScenario: null,
    gutterUnits: {},
  };
}

test('prune: keeps everything from the last 24h', () => {
  const now = Date.now();
  const snaps = [];
  for (let i = 0; i < 30; i++) snaps.push(snap(now - i * 30 * 60 * 1000));
  const pruned = pruneSnapshots(snaps);
  assert.equal(pruned.length, 30);
});

test('prune: keeps last 20 unpinned older than 24h', () => {
  const now = Date.now();
  const snaps = [];
  for (let i = 1; i <= 50; i++) snaps.push(snap(now - i * DAY));
  const pruned = pruneSnapshots(snaps);
  assert.equal(pruned.length, 20);
});

test('prune: pinned snapshots survive retention regardless of age', () => {
  const now = Date.now();
  const snaps = [
    snap(now - 60 * DAY, { pinned: true,  label: 'milestone' }),
    snap(now - 90 * DAY, { pinned: true }),
  ];
  for (let i = 1; i <= 30; i++) snaps.push(snap(now - i * DAY));
  const pruned = pruneSnapshots(snaps);
  assert.equal(pruned.length, 22);
  assert.ok(pruned.find(s => s.label === 'milestone'));
});

test('prune: result is sorted by takenAt ascending (newest last)', () => {
  const now = Date.now();
  const snaps = [
    snap(now - 5 * DAY),
    snap(now - 1 * HOUR),
    snap(now - 30 * DAY),
    snap(now - 30 * 60 * 1000),
  ];
  const pruned = pruneSnapshots(snaps);
  for (let i = 1; i < pruned.length; i++) {
    assert.ok(pruned[i].takenAt >= pruned[i - 1].takenAt, 'monotonic');
  }
});

test('prune: empty array → empty array', () => {
  assert.deepEqual(pruneSnapshots([]), []);
});
