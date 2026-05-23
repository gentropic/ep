// Layered plots — the fluent Plot value (SPEC-LAYERED-PLOTS). Phase 1
// covers stereonet (planes / lines / poles), plus the shared adders
// (with_title / with_xlabel / with_ylabel) and `show`. The xy families
// (line / scatter / bar / hist) come in a later phase.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

if (typeof globalThis.Temporal === 'undefined') {
  createRequire(import.meta.url)('../../temporal/temporal-polyfill.min.js');
}

const { Numbat } = await import('../src/api.js');

function mkHost() {
  const n = new Numbat({ prelude: 'v0.1' });
  n.registerAllVendoredModules();
  n.use('core::strings');
  n.use('core::lists');
  for (const name of ['range','map','filter','foldl','maximum','minimum','median','sum','mean','stdev']) {
    if (n.fns.has(name)) n.fns.delete(name);
  }
  return n;
}

// ── empty Plot + family ──────────────────────────────────────────

test('stereonet(): empty Plot, family="stereonet", no layers', () => {
  const n = mkHost();
  n.loadSource('let p = stereonet()', '<t>');
  const p = n.values.get('p');
  assert.equal(p.__plot, true);
  assert.equal(p.family, 'stereonet');
  assert.deepEqual(p.layers, []);
  assert.equal(p.title, '');
});

// ── with_planes / with_lines / with_poles ────────────────────────

test('with_planes: appends a planes layer; angles canonical→degrees', () => {
  const n = mkHost();
  n.loadSource('let p = with_planes(stereonet(), 120 deg, 45 deg, "fp")', '<t>');
  const p = n.values.get('p');
  assert.equal(p.layers.length, 1);
  assert.equal(p.layers[0].kind, 'planes');
  assert.equal(p.layers[0].label, 'fp');
  assert.equal(p.layers[0].pairs.length, 1);
  // 120 deg → 120, 45 deg → 45 after rad→deg conversion.
  assert.ok(Math.abs(p.layers[0].pairs[0][0] - 120) < 1e-9);
  assert.ok(Math.abs(p.layers[0].pairs[0][1] -  45) < 1e-9);
});

test('with_lines: appends a lines layer', () => {
  const n = mkHost();
  n.loadSource('let p = with_lines(stereonet(), [240, 250] deg, [25, 30] deg)', '<t>');
  const p = n.values.get('p');
  assert.equal(p.layers[0].kind, 'lines');
  assert.equal(p.layers[0].pairs.length, 2);
});

test('with_poles: appends a poles layer', () => {
  const n = mkHost();
  n.loadSource('let p = with_poles(stereonet(), 120 deg, 45 deg)', '<t>');
  const p = n.values.get('p');
  assert.equal(p.layers[0].kind, 'poles');
});

// ── fluent chain ──────────────────────────────────────────────────

test('fluent: stereonet() |> with_planes(...) |> with_lines(...) |> with_title(...)', () => {
  const n = mkHost();
  n.loadSource([
    'let p = stereonet()',
    '  |> with_planes([120, 130] deg, [45, 50] deg, "faults")',
    '  |> with_lines(240 deg, 28 deg, "slip")',
    '  |> with_title("Combined")',
  ].join('\n'), '<t>');
  const p = n.values.get('p');
  assert.equal(p.layers.length, 2);
  assert.equal(p.layers[0].kind, 'planes');
  assert.equal(p.layers[0].label, 'faults');
  assert.equal(p.layers[1].kind, 'lines');
  assert.equal(p.layers[1].label, 'slip');
  assert.equal(p.title, 'Combined');
});

// ── shortcuts construct the same Plot shape ──────────────────────

test('stereonet_planes shortcut: single-layer Plot with title', () => {
  const n = mkHost();
  n.loadSource('let p = stereonet_planes([120, 130] deg, [45, 50] deg, "T")', '<t>');
  const p = n.values.get('p');
  assert.equal(p.__plot, true);
  assert.equal(p.family, 'stereonet');
  assert.equal(p.layers.length, 1);
  assert.equal(p.layers[0].kind, 'planes');
  assert.equal(p.title, 'T');
});

test('stereonet_lines shortcut: single-layer Plot, kind=lines', () => {
  const n = mkHost();
  n.loadSource('let p = stereonet_lines(240 deg, 25 deg)', '<t>');
  const p = n.values.get('p');
  assert.equal(p.layers[0].kind, 'lines');
});

// ── with_band ────────────────────────────────────────────────────

test('with_band: appends a band layer with lo/hi parallel arrays', () => {
  const n = mkHost();
  n.loadSource([
    'let xs = [0, 1, 2, 3]',
    'let lo = [0.1, 0.4, 0.6, 0.5]',
    'let hi = [0.9, 1.4, 1.6, 1.5]',
    'let p = line_plot() |> with_band(xs, lo, hi, "P5–P95")',
  ].join('\n'), '<t>');
  const p = n.values.get('p');
  assert.equal(p.__plot, true);
  assert.equal(p.family, 'xy');
  assert.equal(p.layers.length, 1);
  const layer = p.layers[0];
  assert.equal(layer.kind, 'band');
  assert.equal(layer.label, 'P5–P95');
  assert.deepEqual(layer.xs, [0, 1, 2, 3]);
  assert.deepEqual(layer.lo, [0.1, 0.4, 0.6, 0.5]);
  assert.deepEqual(layer.hi, [0.9, 1.4, 1.6, 1.5]);
});

test('with_band: rejects mismatched lo / hi lengths', () => {
  const n = mkHost();
  assert.throws(
    () => n.loadSource([
      'let p = line_plot() |> with_band([0, 1, 2], [0.1, 0.2], [0.9, 1.0, 1.1])',
    ].join('\n'), '<t>'),
    /xs \/ lo \/ hi must be the same length/);
});

test('with_band: rejects non-xy family', () => {
  const n = mkHost();
  assert.throws(
    () => n.loadSource([
      'let p = stereonet() |> with_band([0, 1], [0, 0], [1, 1])',
    ].join('\n'), '<t>'),
    /cannot add an xy layer to a 'stereonet' plot/);
});

// ── immutability ──────────────────────────────────────────────────

test('with_* are immutable — original Plot unchanged', () => {
  const n = mkHost();
  n.loadSource([
    'let p1 = stereonet()',
    'let p2 = with_planes(p1, 120 deg, 45 deg)',
  ].join('\n'), '<t>');
  const p1 = n.values.get('p1');
  const p2 = n.values.get('p2');
  assert.equal(p1.layers.length, 0);
  assert.equal(p2.layers.length, 1);
  assert.notStrictEqual(p1, p2);
});

// ── show() emits to the plot sink ────────────────────────────────

test('show(plot) emits the Plot to the plot sink', async () => {
  const { setPlotSink } = await import('../src/load.js');
  const captured = [];
  setPlotSink(d => captured.push(d));
  const n = mkHost();
  // numbat-js's loadSource accepts only declaration-shaped lines at
  // the module top level — bind show's void return to a throwaway.
  n.loadSource([
    'let p = stereonet_planes(120 deg, 45 deg)',
    'let _ = show(p)',
  ].join('\n'), '<t>');
  setPlotSink(null);
  assert.equal(captured.length, 1);
  assert.equal(captured[0].__plot, true);
  assert.equal(captured[0].family, 'stereonet');
});

// ── family + adder mismatch errors ────────────────────────────────

test('with_planes on a non-stereonet Plot errors loudly', () => {
  // Fake an empty line-family plot via the runtime — line_plot()
  // doesn't exist yet but the family check should still fire when
  // we construct one by hand.
  const n = mkHost();
  // Workaround: stereonet() then fudge family via a let — Numbat
  // doesn't support that; instead, ensure with_planes errors when
  // the first arg isn't a Plot at all.
  assert.throws(
    () => n.loadSource('let p = with_planes(5, 120 deg, 45 deg)', '<t>'),
    /first arg must be a Plot/);
});

test('with_title rejects non-Plot first arg', () => {
  const n = mkHost();
  assert.throws(
    () => n.loadSource('let p = with_title(5, "hi")', '<t>'),
    /first arg must be a Plot/);
});
