import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DimRegistry } from '../src/dimensions.js';

test('defineBase: allocates lowercase axis from dimension name', () => {
  const r = new DimRegistry();
  r.defineBase('Length');
  assert.deepEqual(r.resolve('Length'), { length: 1 });

  r.defineBase('Mass');
  assert.deepEqual(r.resolve('Mass'), { mass: 1 });
});

test('defineDerived: stores a pre-computed dim vector', () => {
  const r = new DimRegistry();
  r.defineBase('Length');
  r.defineBase('Time');
  r.defineDerived('Velocity', { length: 1, time: -1 });
  assert.deepEqual(r.resolve('Velocity'), { length: 1, time: -1 });
});

test('resolve / has', () => {
  const r = new DimRegistry();
  r.defineBase('Length');
  assert.equal(r.has('Length'), true);
  assert.equal(r.has('Mass'), false);
  assert.equal(r.resolve('Length').length, 1);
  assert.equal(r.resolve('Mass'), null);
});

test('redeclaration throws', () => {
  const r = new DimRegistry();
  r.defineBase('Length');
  assert.throws(() => r.defineBase('Length'), /already defined/);
  assert.throws(() => r.defineDerived('Length', { mass: 1 }), /already defined/);
});

test('list: enumerates name+dim pairs', () => {
  const r = new DimRegistry();
  r.defineBase('Length');
  r.defineDerived('Area', { length: 2 });
  const list = r.list();
  assert.equal(list.length, 2);
  assert.equal(list[0].name, 'Length');
  assert.equal(list[1].name, 'Area');
  assert.deepEqual(list[1].dim, { length: 2 });
});
