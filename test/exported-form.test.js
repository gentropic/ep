import { test } from 'node:test';
import assert from 'node:assert/strict';
import { programFromExportedHtml, isExportedForm } from '../src/js/exported-form.js';

const form = (state) => `<!DOCTYPE html><html><head></head><body><script>
/* MARKER:STATE_START */
const INITIAL_STATE = ${JSON.stringify(state, null, 2)};
/* MARKER:STATE_END */
'use strict';
</script></body></html>`;

test('reads name, lines and assets back out of an exported form', () => {
  const html = form({ name: 'weekend_hike', body: [{ src: '@input' }, { src: 'distance = 14 km' }, { src: '' }, { src: 'pace -> mph' }], ui: { formView: true }, assets: { data: { text: 'a,b\n1,2' } } });
  const p = programFromExportedHtml(html);
  assert.equal(p.name, 'weekend_hike');
  assert.deepEqual(p.lines, ['@input', 'distance = 14 km', '', 'pace -> mph']);
  assert.deepEqual(Object.keys(p.assets), ['data']);
});

test('plain .ep text and unrelated html are not exported forms', () => {
  assert.equal(isExportedForm('x = 1 m\n'), false);
  assert.equal(programFromExportedHtml('<html><body>hi</body></html>'), null);
  assert.equal(programFromExportedHtml(form({ name: 'x' })), null);   // no body array
});
