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

test('pipe: x |> f(extra_args) prepends x as first arg', () => {
  const n = new Numbat({ prelude: 'none' });
  n.loadSource('fn add(a, b) = a + b');
  n.loadSource('let r = 10 |> add(5)');  // add(10, 5) = 15
  assert.equal(n.values.get('r').value, 15);
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
