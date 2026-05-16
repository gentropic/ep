// Snapshot retention policy — pure function, no DOM or state deps so it
// can be unit-tested from Node. Kept separate from storage.js (which
// transitively imports DOM-touching modules) for the same reason.

const SNAPSHOT_RETAIN_MS  = 24 * 60 * 60 * 1000;   // 24h
const SNAPSHOT_RETAIN_OLD = 20;                    // beyond 24h

// Retain everything newer than 24h; from older entries, keep the
// most recent SNAPSHOT_RETAIN_OLD plus all pinned ones. Returns the
// retained list sorted by takenAt ascending so the "newest last"
// invariant holds.
export function pruneSnapshots(snaps) {
  const now = Date.now();
  const recent = snaps.filter(s => now - s.takenAt < SNAPSHOT_RETAIN_MS);
  const older  = snaps.filter(s => now - s.takenAt >= SNAPSHOT_RETAIN_MS);
  const olderPinned   = older.filter(s => s.pinned);
  const olderUnpinned = older.filter(s => !s.pinned)
                             .sort((a, b) => b.takenAt - a.takenAt)
                             .slice(0, SNAPSHOT_RETAIN_OLD);
  return [...olderPinned, ...olderUnpinned, ...recent]
    .sort((a, b) => a.takenAt - b.takenAt);
}
