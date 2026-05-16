// Pointer module tests. CompressionStream is available in Node 18+, so
// the full encode/decode round-trip is testable in the same runtime as
// the rest of the suite.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  encodeInlineI, encodeInlineQ, resolvePointer,
} from '../src/js/pointer.js';

test('pointer: encodeInlineI → resolvePointer round-trips', async () => {
  const text = 'hello world\n@input\nx = 5\n';
  const ptr = await encodeInlineI(text);
  assert.ok(ptr.startsWith('i:d'), 'i: compact-form prefix');
  const decoded = await resolvePointer(ptr);
  assert.equal(decoded, text);
});

test('pointer: encodeInlineQ → resolvePointer round-trips', async () => {
  const text = 'hello world\n@input\nx = 5\n';
  const ptr = await encodeInlineQ(text);
  assert.ok(ptr.startsWith('q:d'), 'q: QR-form prefix');
  const decoded = await resolvePointer(ptr);
  assert.equal(decoded, text);
});

test('pointer: long-form inline:deflate accepted', async () => {
  // Round-trip via i: form, then rewrite to long form and decode.
  const text = 'small thing';
  const compact = await encodeInlineI(text);
  const payload = compact.slice('i:d'.length);
  const longForm = 'inline:deflate:' + payload;
  const decoded = await resolvePointer(longForm);
  assert.equal(decoded, text);
});

test('pointer: leading # is stripped', async () => {
  const text = 'x = 1';
  const ptr = await encodeInlineI(text);
  const decoded = await resolvePointer('#' + ptr);
  assert.equal(decoded, text);
});

test('pointer: unknown scheme returns EUNKNOWN', async () => {
  await assert.rejects(
    () => resolvePointer('gh:user/repo:file.ep'),
    /EUNKNOWN/,
  );
});

test('pointer: pointer with no colon returns ENOSCHEME', async () => {
  await assert.rejects(
    () => resolvePointer('garbage-no-colon'),
    /ENOSCHEME/,
  );
});

test('pointer: same content yields equivalent decoded text across i/q forms', async () => {
  const text = '@input\ncore = NQ_core\n@output(kg)\nmass = sample_mass(core, 5 m, 2.7 g/cm3)\n';
  const i = await encodeInlineI(text);
  const q = await encodeInlineQ(text);
  const di = await resolvePointer(i);
  const dq = await resolvePointer(q);
  assert.equal(di, text);
  assert.equal(dq, text);
  assert.equal(di, dq);
});

test('pointer: brotli codec returns EUNSUPPORTEDCODEC', async () => {
  await assert.rejects(
    () => resolvePointer('i:bAAAA'),
    /EUNSUPPORTEDCODEC/,
  );
});
