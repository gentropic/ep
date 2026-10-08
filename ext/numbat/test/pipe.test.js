import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Numbat } from '../src/api.js';

test('pipe: x |> f → f(x)', () => {
  const n = new Numbat({ prelude: 'none' });
  n.loadSource('let r = 9 |> sqrt');
  assert.equal(n.values.get('r').value, 3);
});

test('pipe: left-associative chain x |> f |> g → g(f(x))', () => {
  const n = new Numbat({ prelude: 'none' });
  n.loadSource('let r = 81 |> sqrt |> sqrt');  // sqrt(sqrt(81)) = sqrt(9) = 3
  assert.equal(n.values.get('r').value, 3);
});

test('pipe: x |> f(extra_args) appends x as the LAST arg (upstream order: xs |> map(f) is map(f, xs))', () => {
  const n = new Numbat({ prelude: 'none' });
  n.loadSource('fn sub(a, b) = a - b');
  n.loadSource('let r = 10 |> sub(5)');  // sub(5, 10) = -5
  assert.equal(n.values.get('r').value, -5);
});

test('pipe: looser than arithmetic (a + b |> f → f(a+b))', () => {
  const n = new Numbat({ prelude: 'none' });
  n.loadSource('let r = 4 + 5 |> sqrt');  // sqrt(9) = 3
  assert.equal(n.values.get('r').value, 3);
});

test('pipe: works with user-defined fn', () => {
  const n = new Numbat({ prelude: 'none' });
  n.loadSource('fn double(x) = 2 * x');
  n.loadSource('let r = 7 |> double');
  assert.equal(n.values.get('r').value, 14);
});

test('pipe: looser than conversion (`->`)', () => {
  const n = new Numbat({ prelude: 'none' });
  n.loadSource(`
    dimension Length
    @metric_prefixes
    @aliases(m: short)
    unit metre: Length
    fn negate(x) = -x
    let r = 3 km -> m |> negate
  `);
  // 3 km -> m gives Q(3000, length:1, disp:'m'); negate flips sign
  assert.equal(n.values.get('r').value, -3000);
});

test('pipe: the prelude list functions take the list last, so pipes read naturally', () => {
  const n = new Numbat({ prelude: 'v0.1' });
  n.registerAllVendoredModules();
  n.use('core::lists');
  n.loadSource('let a = [1, 2, 3] |> map(sqr)');
  assert.deepEqual(n.values.get('a').map(q => q.value), [1, 4, 9]);
  n.loadSource('let b = [1, 2] |> contains(2)');
  assert.equal(n.values.get('b'), true);
  // upstream's unique is written `xs |> _unique([])` — it only works with last-arg pipes
  n.loadSource('let c = unique([1, 1, 2, 3, 3])');
  assert.deepEqual(n.values.get('c').map(q => q.value), [1, 2, 3]);
});
