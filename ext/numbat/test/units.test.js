import { test } from 'node:test';
import { Numbat } from '../src/api.js';
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
  r.define('meter', { dim: {length: 1}, shortAliases: ['m'], prefixSet: 'metric' });
  // Long-form prefixed names
  assert.equal(r.resolve('kilometer').mul, 1e3);
  assert.equal(r.resolve('millimeter').mul, 1e-3);
  // Short-form prefixed names (via shortAlias)
  assert.equal(r.resolve('km').mul, 1e3);
  assert.equal(r.resolve('mm').mul, 1e-3);
  assert.equal(r.resolve('cm').mul, 1e-2);
  assert.equal(r.resolve('Mm').mul, 1e6);  // megameter, not millimeter (case matters)
  // Display name carries the short prefix
  assert.equal(r.resolve('km').displayName, 'km');
});

test('metric prefix variants share dimension with base', () => {
  const r = new UnitRegistry();
  r.define('gram', { dim: {mass: 1}, shortAliases: ['g'], prefixSet: 'metric' });
  assert.deepEqual(r.resolve('kg').dim, {mass: 1});
  assert.deepEqual(r.resolve('mg').dim, {mass: 1});
});

test('list(filterDim): only matching units', () => {
  const r = new UnitRegistry();
  r.define('meter', { dim: {length: 1}, shortAliases: ['m'], prefixSet: 'metric' });
  r.define('gram',  { dim: {mass: 1},   shortAliases: ['g'], prefixSet: 'metric' });
  const lengths = r.list({length: 1});
  const masses = r.list({mass: 1});
  assert.ok(lengths.length >= 5);
  assert.ok(masses.length >= 5);
  for (const e of lengths) assert.deepEqual(e.dim, {length: 1});
  for (const e of masses) assert.deepEqual(e.dim, {mass: 1});
});

test('non-prefixed unit registers exactly one entry', () => {
  const r = new UnitRegistry();
  r.define('tonne', { dim: {mass: 1}, mul: 1e6, shortAliases: ['t'] });
  assert.deepEqual(r.resolve('tonne').mul, 1e6);
  assert.deepEqual(r.resolve('t').mul, 1e6);
  assert.equal(r.resolve('kilotonne'), null);  // no auto-prefix
});

test('aliases (long) and shortAliases (short) both get prefixed', () => {
  const r = new UnitRegistry();
  // Mimics upstream's @aliases(metres, meter, meters, m: short)
  r.define('metre', {
    dim: {length: 1},
    aliases: ['metres', 'meter', 'meters'],
    shortAliases: ['m'],
    prefixSet: 'metric',
  });
  // Base names (canonical + all aliases) at mul=1
  assert.equal(r.resolve('metre').mul, 1);
  assert.equal(r.resolve('metres').mul, 1);
  assert.equal(r.resolve('meter').mul, 1);
  assert.equal(r.resolve('meters').mul, 1);
  assert.equal(r.resolve('m').mul, 1);
  // Long prefix + canonical
  assert.equal(r.resolve('kilometre').mul, 1e3);
  // Long prefix + long aliases (US-spelling support)
  assert.equal(r.resolve('kilometer').mul,  1e3);
  assert.equal(r.resolve('kilometers').mul, 1e3);
  assert.equal(r.resolve('decimeter').mul,  1e-1);
  assert.equal(r.resolve('centimetre').mul, 1e-2);
  // Short prefix + short alias
  assert.equal(r.resolve('km').mul, 1e3);
  assert.equal(r.resolve('dm').mul, 1e-1);
});

test('first-come-first-served on alias conflicts', () => {
  const r = new UnitRegistry();
  r.define('aaa', { dim: {mass: 1}, mul: 100, displayName: 'aaa' });
  r.define('bbb', { dim: {length: 1}, mul: 200, displayName: 'bbb', aliases: ['aaa'] });
  // 'aaa' resolves to the first definition (mass), not the alias-clobber attempt
  assert.deepEqual(r.resolve('aaa').dim, {mass: 1});
});

test('bare identifier: a unit name shadowed by a builtin proc resolves as the unit', () => {
  // `min` is both the minute (unit) and ep's minimum (host proc). In bare
  // position it must be the unit — that's the only meaning upstream Numbat
  // has for it. Call syntax still reaches the proc.
  const nb = new Numbat();
  nb.loadSource('let t = 4 min');
  const t = nb.values.get('t');
  assert.deepEqual(t.dim, { time: 1 });
  assert.equal(t.value, 240);
  nb.loadSource('let m = min(3 m, 2 m)');
  assert.equal(nb.values.get('m').value, 2);
  nb.loadSource('let v = 3 km / 4 min');
  assert.deepEqual(nb.values.get('v').dim, { length: 1, time: -1 });
  assert.equal(nb.values.get('v').value, 12.5);
});

test('arithmetic on a function reference gives a named error, not a TypeError', () => {
  const nb = new Numbat();
  assert.throws(() => nb.loadSource('let x = 4 sqrt'), (e) => {
    assert.ok(!(e instanceof TypeError));
    assert.match(e.message, /'sqrt' is a function, not a value/);
    return true;
  });
});

test('-> compound unit target keeps a display tag the formatter honors', () => {
  const nb = new Numbat();
  nb.loadSource('let v = 3 km / 4 min -> km/h');
  const v = nb.values.get('v');
  assert.equal(v.value, 12.5);                              // canonical m/s untouched
  assert.deepEqual(nb.formatParts(v), { num: '45', unit: 'km/h' });
  nb.loadSource('let a = 9.81 m/s^2 -> ft/s^2');
  assert.equal(nb.formatParts(nb.values.get('a')).unit, 'ft/s²');
  nb.loadSource('let w = 2 kg * 9.81 m/s^2 -> kg*m/s^2');
  assert.equal(nb.formatParts(nb.values.get('w')).unit, 'kg·m/s²');
});
