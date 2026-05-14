import { test } from 'node:test';
import assert from 'node:assert/strict';
import { UnitRegistry } from '../src/units.js';

test('define + resolve: canonical name and aliases', () => {
  const r = new UnitRegistry();
  r.define('meter', { dim: {length: 1}, displayName: 'm', aliases: ['m'] });
  assert.deepEqual(r.resolve('meter'), {mul: 1, dim: {length: 1}, displayName: 'm', fullName: 'meter'});
  assert.deepEqual(r.resolve('m'),     {mul: 1, dim: {length: 1}, displayName: 'm', fullName: 'meter'});
  assert.equal(r.resolve('foo'), null);
});

test('has() reports membership for canonical and aliases', () => {
  const r = new UnitRegistry();
  r.define('gram', { dim: {mass: 1}, displayName: 'g', aliases: ['g'] });
  assert.equal(r.has('gram'), true);
  assert.equal(r.has('g'),    true);
  assert.equal(r.has('mass'), false);
});

test('metric prefix expansion generates expected variants', () => {
  const r = new UnitRegistry();
  r.define('meter', { dim: {length: 1}, displayName: 'm', aliases: ['m'], prefixSet: 'metric' });
  // Long-form prefixed names
  assert.equal(r.resolve('kilometer').mul, 1e3);
  assert.equal(r.resolve('millimeter').mul, 1e-3);
  // Short-form prefixed names (via alias)
  assert.equal(r.resolve('km').mul, 1e3);
  assert.equal(r.resolve('mm').mul, 1e-3);
  assert.equal(r.resolve('cm').mul, 1e-2);
  assert.equal(r.resolve('Mm').mul, 1e6);  // megameter, not millimeter (case matters)
  // Display name carries the short prefix
  assert.equal(r.resolve('km').displayName, 'km');
});

test('metric prefix variants share dimension with base', () => {
  const r = new UnitRegistry();
  r.define('gram', { dim: {mass: 1}, displayName: 'g', aliases: ['g'], prefixSet: 'metric' });
  assert.deepEqual(r.resolve('kg').dim, {mass: 1});
  assert.deepEqual(r.resolve('mg').dim, {mass: 1});
});

test('list(filterDim): only matching units', () => {
  const r = new UnitRegistry();
  r.define('meter', { dim: {length: 1}, displayName: 'm', aliases: ['m'], prefixSet: 'metric' });
  r.define('gram',  { dim: {mass: 1},   displayName: 'g', aliases: ['g'], prefixSet: 'metric' });
  const lengths = r.list({length: 1});
  const masses = r.list({mass: 1});
  assert.ok(lengths.length >= 5);
  assert.ok(masses.length >= 5);
  for (const e of lengths) assert.deepEqual(e.dim, {length: 1});
  for (const e of masses) assert.deepEqual(e.dim, {mass: 1});
});

test('non-prefixed unit registers exactly one entry', () => {
  const r = new UnitRegistry();
  r.define('tonne', { dim: {mass: 1}, mul: 1e6, displayName: 't', aliases: ['t'] });
  assert.deepEqual(r.resolve('tonne').mul, 1e6);
  assert.deepEqual(r.resolve('t').mul, 1e6);
  assert.equal(r.resolve('kilotonne'), null);  // no auto-prefix
});

test('first-come-first-served on alias conflicts', () => {
  const r = new UnitRegistry();
  r.define('aaa', { dim: {mass: 1}, mul: 100, displayName: 'aaa' });
  r.define('bbb', { dim: {length: 1}, mul: 200, displayName: 'bbb', aliases: ['aaa'] });
  // 'aaa' resolves to the first definition (mass), not the alias-clobber attempt
  assert.deepEqual(r.resolve('aaa').dim, {mass: 1});
});
