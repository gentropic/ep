// Struct declarations, construction, and field access (v0.5).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Numbat } from '../src/api.js';

test('struct decl: stored in env.structs', () => {
  const n = new Numbat({ prelude: 'none' });
  n.loadSource(`
    dimension Length
    struct Point {
      x: Length,
      y: Length,
    }
  `);
  const s = n.structs?.get('Point');
  assert.ok(s);
  assert.equal(s.name, 'Point');
  assert.equal(s.fields.length, 2);
  assert.deepEqual(s.fields.map(f => f.name), ['x', 'y']);
});

test('struct decl with generic parameter', () => {
  const n = new Numbat({ prelude: 'none' });
  n.loadSource(`
    struct Vec2<D: Dim> {
      x: D,
      y: D,
    }
  `);
  const s = n.structs.get('Vec2');
  assert.equal(s.generics.length, 1);
  assert.equal(s.generics[0].name, 'D');
});

test('struct construction yields tagged JS object', () => {
  const n = new Numbat({ prelude: 'none' });
  n.loadSource(`
    dimension Length
    @aliases(m: short)
    unit metre: Length
    struct Point { x: Length, y: Length }
    let p = Point { x: 3 m, y: 4 m }
  `);
  const p = n.values.get('p');
  assert.equal(p.__struct, 'Point');
  assert.equal(p.x.value, 3);
  assert.equal(p.y.value, 4);
});

test('field access on a struct', () => {
  const n = new Numbat({ prelude: 'none' });
  n.loadSource(`
    dimension Length
    @aliases(m: short)
    unit metre: Length
    struct Point { x: Length, y: Length }
    let p = Point { x: 3 m, y: 4 m }
    let height = p.y
  `);
  assert.equal(n.values.get('height').value, 4);
});

test('struct used in fn (Pythagorean magnitude)', () => {
  const n = new Numbat({ prelude: 'none' });
  n.loadSource(`
    dimension Length
    @aliases(m: short)
    unit metre: Length
    struct Vec2<D: Dim> { x: D, y: D }
    fn magnitude<D: Dim>(v: D) -> D = sqrt(v.x^2 + v.y^2)
    let mag = magnitude(Vec2 { x: 3 m, y: 4 m })
  `);
  const m = n.values.get('mag');
  assert.equal(m.value, 5);
  assert.deepEqual(m.dim, { length: 1 });
});

test('field access: unknown field throws', () => {
  const n = new Numbat({ prelude: 'none' });
  n.loadSource(`
    struct Point { x: Scalar }
    let p = Point { x: 1 }
  `);
  assert.throws(() => n.loadSource('let bad = p.y'), /field 'y' not in struct Point/);
});

test('field access on non-struct throws', () => {
  const n = new Numbat({ prelude: 'none' });
  // Use `true` since `5.foo` would be tokenized as `5.0` + `foo` (the
  // number lexer eats the dot before the field-access path sees it).
  assert.throws(() => n.loadSource('let x = true.foo'), /field access on non-struct/);
});

// ── trailing-comma tolerance (upstream style) ────────────────────

test('struct: trailing commas in fields', () => {
  const n = new Numbat({ prelude: 'none' });
  n.loadSource(`
    struct Element {
      name: String,
      atomic_number: Scalar,
      density: Scalar,
    }
  `);
  assert.ok(n.structs.get('Element'));
});

// ── field-access broadcasting (ep dataset extension) ─────────────

test('field broadcast: List<Struct>.field projects the column', () => {
  const n = new Numbat({ prelude: 'none' });
  n.loadSource(`
    struct Point { x: Scalar, y: Scalar }
    let ps = [Point { x: 1, y: 10 }, Point { x: 2, y: 20 }, Point { x: 3, y: 30 }]
    let xs = ps.x
    let ys = ps.y
  `);
  assert.deepEqual(n.values.get('xs').map(q => q.value), [1, 2, 3]);
  assert.deepEqual(n.values.get('ys').map(q => q.value), [10, 20, 30]);
});

test('field broadcast: empty list projects to empty list', () => {
  const n = new Numbat({ prelude: 'none' });
  n.loadSource(`
    struct Point { x: Scalar }
    let empty: List<Point> = []
    let xs = empty.x
  `);
  assert.deepEqual(n.values.get('xs'), []);
});

test('field broadcast: composes with arithmetic broadcasting', () => {
  const n = new Numbat({ prelude: 'none' });
  n.loadSource(`
    struct Row { grade: Scalar, tonnage: Scalar }
    let rows = [Row { grade: 2, tonnage: 100 }, Row { grade: 4, tonnage: 50 }]
    let metal = rows.grade * rows.tonnage
  `);
  assert.deepEqual(n.values.get('metal').map(q => q.value), [200, 200]);
});

test('field broadcast: unknown field on a list element throws', () => {
  const n = new Numbat({ prelude: 'none' });
  n.loadSource(`
    struct Point { x: Scalar }
    let ps = [Point { x: 1 }]
  `);
  assert.throws(() => n.loadSource('let bad = ps.y'), /field 'y' not in struct Point/);
});

test('field broadcast: non-struct list element throws', () => {
  const n = new Numbat({ prelude: 'none' });
  n.loadSource('let xs = [1, 2, 3]');
  assert.throws(() => n.loadSource('let bad = xs.foo'), /list element 0 is not a struct/);
});
