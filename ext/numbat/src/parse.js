// Parser for Numbat-script.
//
// Consumes the token stream from tokenize.js and produces an AST. v0.2 covers
// the *declarative* subset that upstream .nbt files use:
//
//   - `use path::path`
//   - `dimension Name` / `dimension Name = expr`
//   - `unit name[: DimExpr] [= ValueExpr]`
//   - `let name[: DimExpr] = ValueExpr`
//   - leading decorators on each declaration (@name, @url, @aliases,
//     @metric_prefixes, @description, @example, ...)
//
// Expression grammar (lowest to highest precedence):
//   conversion: addExpr ('->' addExpr)*               # `to` is a synonym
//   addExpr:    mulExpr (('+' | '-') mulExpr)*
//   mulExpr:    implMul (('*' | '/') implMul)*
//   implMul:    power (power)*                        # implicit multiplication
//   power:      unary ('^' power)?                    # right-associative
//   unary:      '-' unary | primary
//   primary:    NUM | IDENT | '(' expr ')'
//
// AST nodes:
//   { type: 'Module', decls: [...] }
//   { type: 'UseStmt', path: ['core', 'dimensions'], decorators: [...] }
//   { type: 'DimensionDecl', name, expr|null, decorators }
//   { type: 'UnitDecl', name, dim|null, expr|null, decorators }
//   { type: 'LetDecl', name, dim|null, expr, decorators }
//   { type: 'Decorator', name, args: [...] }
//   { type: 'StrArg', value }
//   { type: 'NameArg', name, modifier|null }
//   { type: 'Num', value, raw }
//   { type: 'Ident', name }
//   { type: 'Binary', op, left, right }
//   { type: 'Unary', op, expr }
//   { type: 'Paren', expr }
//
// Statements other than the listed four (e.g., `fn`, `struct`, expression
// statements at top level) are rejected with a clear error in v0.2 — they
// arrive in v0.3+.

export function parse(tokens, sourceName = '<input>') {
  let p = 0;

  const peek = (offset = 0) => tokens[p + offset];
  const eat  = () => tokens[p++];
  const atOp = (op)   => peek() && peek().type === 'op' && peek().op === op;
  const atKw = (name) => peek() && peek().type === 'kw' && peek().name === name;
  const atType = (type) => peek() && peek().type === type;

  const err = (tok, msg) => {
    const span = tok?.span;
    const loc = span ? `${span.source ?? sourceName}:${span.line}:${span.col}` : `${sourceName}:?:?`;
    return new Error(`${loc}: ${msg}`);
  };
  const expectOp = (op) => {
    if (!atOp(op)) throw err(peek(), `expected '${op}'`);
    return eat();
  };
  const expectType = (type, what = type) => {
    if (!atType(type)) {
      const t = peek();
      const got = t ? `${t.type}${t.name ? ` '${t.name}'` : t.op ? ` '${t.op}'` : ''}` : 'end of input';
      throw err(t, `expected ${what}, got ${got}`);
    }
    return eat();
  };

  // ── declarations ────────────────────────────────────────────────

  const decls = [];
  while (p < tokens.length) {
    decls.push(parseDecl());
  }
  return { type: 'Module', decls, source: sourceName };

  function parseDecl() {
    const decorators = [];
    while (atType('dec')) decorators.push(parseDecorator());

    const t = peek();
    if (!t) throw err(null, 'unexpected end of input after decorators');
    if (t.type === 'kw') {
      switch (t.name) {
        case 'use':       return parseUse(decorators);
        case 'dimension': return parseDimension(decorators);
        case 'unit':      return parseUnit(decorators);
        case 'let':       return parseLet(decorators);
        default:
          throw err(t, `unsupported keyword '${t.name}' at top level (v0.2 handles: use, dimension, unit, let)`);
      }
    }
    throw err(t, `expected a declaration keyword (use / dimension / unit / let)`);
  }

  function parseDecorator() {
    const dec = eat();  // type 'dec'
    const args = [];
    if (atOp('(')) {
      eat();
      if (!atOp(')')) {
        args.push(parseDecoratorArg());
        while (atOp(',')) { eat(); args.push(parseDecoratorArg()); }
      }
      expectOp(')');
    }
    return { type: 'Decorator', name: dec.name, args, span: dec.span };
  }

  function parseDecoratorArg() {
    const t = peek();
    if (!t) throw err(null, 'unexpected end of input in decorator arg');
    if (t.type === 'str') {
      eat();
      return { type: 'StrArg', value: t.value };
    }
    if (t.type === 'id' || t.type === 'kw') {
      // Allow keywords as decorator-arg names too — they're string-ish here.
      eat();
      let modifier = null;
      if (atOp(':')) {
        eat();
        const m = expectType('id', "modifier (short/long/none)");
        modifier = m.name;
      }
      return { type: 'NameArg', name: t.name, modifier };
    }
    throw err(t, `expected string or identifier in decorator arg, got ${t.type}`);
  }

  function parseUse(decorators) {
    eat();  // 'use'
    const parts = [expectType('id', 'module path segment').name];
    while (atOp('::')) {
      eat();
      parts.push(expectType('id', 'module path segment').name);
    }
    return { type: 'UseStmt', path: parts, decorators };
  }

  function parseDimension(decorators) {
    eat();  // 'dimension'
    const nameTok = expectType('id', 'dimension name');
    // Upstream allows alternate definitions joined by `=`:
    //   `dimension Energy = Momentum^2 / Mass = Mass × Velocity^2 = Force × Length`
    // Each alternate must evaluate to the same dim (loader checks this).
    const exprs = [];
    while (atOp('=')) {
      eat();
      exprs.push(parseExpr());
    }
    return { type: 'DimensionDecl', name: nameTok.name, exprs, decorators };
  }

  function parseUnit(decorators) {
    eat();  // 'unit'
    const nameTok = expectType('id', 'unit name');
    let dim = null, expr = null;
    if (atOp(':')) { eat(); dim = parseExpr(); }
    if (atOp('=')) { eat(); expr = parseExpr(); }
    return { type: 'UnitDecl', name: nameTok.name, dim, expr, decorators };
  }

  function parseLet(decorators) {
    eat();  // 'let'
    const nameTok = expectType('id', 'binding name');
    let dim = null;
    if (atOp(':')) { eat(); dim = parseExpr(); }
    expectOp('=');
    const expr = parseExpr();
    return { type: 'LetDecl', name: nameTok.name, dim, expr, decorators };
  }

  // ── expressions ─────────────────────────────────────────────────

  function parseExpr() { return parseConversion(); }

  function parseConversion() {
    let l = parseAddExpr();
    while (atOp('->') || atKw('to')) {
      eat();
      const right = parseAddExpr();
      l = { type: 'Binary', op: '->', left: l, right };
    }
    return l;
  }

  function parseAddExpr() {
    let l = parseMulExpr();
    while (atOp('+') || atOp('-')) {
      const op = eat().op;
      l = { type: 'Binary', op, left: l, right: parseMulExpr() };
    }
    return l;
  }

  function parseMulExpr() {
    let l = parseImplMul();
    while (atOp('*') || atOp('/')) {
      const op = eat().op;
      l = { type: 'Binary', op, left: l, right: parseImplMul() };
    }
    return l;
  }

  function parseImplMul() {
    let l = parsePower();
    while (isExprStart(peek())) {
      l = { type: 'Binary', op: '*', left: l, right: parsePower() };
    }
    return l;
  }

  function parsePower() {
    const base = parseUnary();
    if (atOp('^') || atOp('**')) {
      eat();
      const exp = parsePower();  // right-associative
      return { type: 'Binary', op: '^', left: base, right: exp };
    }
    return base;
  }

  function parseUnary() {
    if (atOp('-')) {
      eat();
      return { type: 'Unary', op: '-', expr: parseUnary() };
    }
    return parsePrimary();
  }

  function parsePrimary() {
    const t = peek();
    if (!t) throw err(null, 'unexpected end of input in expression');
    if (t.type === 'num') { eat(); return { type: 'Num', value: t.value, raw: t.raw }; }
    if (t.type === 'id')  { eat(); return { type: 'Ident', name: t.name, span: t.span }; }
    if (t.type === 'op' && t.op === '(') {
      eat();
      const inner = parseExpr();
      expectOp(')');
      return { type: 'Paren', expr: inner };
    }
    throw err(t, `unexpected token in expression: ${t.type}${t.op ? ` '${t.op}'` : ''}${t.name ? ` '${t.name}'` : ''}`);
  }

  function isExprStart(t) {
    if (!t) return false;
    if (t.type === 'num' || t.type === 'id') return true;
    if (t.type === 'op' && t.op === '(') return true;
    return false;
  }
}
