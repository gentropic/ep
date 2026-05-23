// Guard test for the in-app docs table (src/js/docs.js).
//
// `DOC_GROUPS` lists the names that the in-drawer "docs" viewer renders,
// grouped under labels. Every name listed there must have a real entry in
// `DOCS` — without this guard, the renderer would render an item with no
// information (no signature, no description), and the autocomplete `info`
// panel for that name would come up empty. Drift here is otherwise silent.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { DOCS, DOC_GROUPS } = await import('../src/js/docs.js');

test('DOC_GROUPS: every listed name resolves to a DOCS entry', () => {
  const docsNames = new Set(Object.keys(DOCS));
  const missing = [];
  for (const g of DOC_GROUPS) {
    for (const n of g.names) {
      if (!docsNames.has(n)) missing.push(`${g.label} → ${n}`);
    }
  }
  assert.deepEqual(missing, [], 'phantom names in DOC_GROUPS: ' + missing.join(', '));
});
