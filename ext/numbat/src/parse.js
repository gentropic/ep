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

const CMP_OPS = new Set(['==', '!=', '<', '<=', '>', '>=']);

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
        case 'fn':        return parseFn(decorators);
        case 'struct':    return parseStruct(decorators);
        default:
          throw err(t, `unsupported keyword '${t.name}' at top level (v0.5 handles: use, dimension, unit, let, fn, struct)`);
      }
    }
    throw err(t, `expected a declaration keyword (use / dimension / unit / let / fn / struct)`);
  }

  function parseStruct(decorators) {
    eat();  // 'struct'
    const nameTok = expectType('id', 'struct name');
    const generics = [];
    if (atOp('<')) {
      eat();
      if (!atOp('>')) {
        generics.push(parseGenericParam());
        while (atOp(',')) { eat(); generics.push(parseGenericParam()); }
      }
      if (!atOp('>')) throw err(peek(), `expected '>' to close struct generics`);
      eat();
    }
    expectOp('{');
    const fields = [];
    while (!atOp('}')) {
      const fname = expectType('id', 'field name');
      expectOp(':');
      const ftype = parseTypeExpr();
      fields.push({ name: fname.name, type: ftype });
      if (atOp(',')) eat();
    }
    expectOp('}');
    return { type: 'StructDecl', name: nameTok.name, generics, fields, decorators };
  }

  function parseFn(decorators) {
    eat();  // 'fn'
    const nameTok = expectType('id', 'function name');
    // Optional generic parameters: `<T: Dim, U: Dim>`. v0.4 supports the `Dim`
    // kind; other kinds are parsed and stored but raise an error if used.
    const generics = [];
    if (atOp('<')) {
      eat();
      if (!atOp('>')) {
        generics.push(parseGenericParam());
        while (atOp(',')) { eat(); generics.push(parseGenericParam()); }
      }
      if (!atOp('>')) throw err(peek(), `expected '>' to close generic parameters`);
      eat();
    }
    expectOp('(');
    const params = [];
    if (!atOp(')')) {
      params.push(parseFnParam());
      while (atOp(',')) { eat(); params.push(parseFnParam()); }
    }
    expectOp(')');
    // Optional return type. Uses parseTypeExpr (parseAddExpr + optional
    // generic-type-args `<...>`) — the latter handles upstream signatures
    // like `fn args() -> List<String>` whose generic args we ignore in v0.4.
    let returnType = null;
    if (atOp('->')) {
      eat();
      returnType = parseTypeExpr();
    }
    // The body is optional: a fn declared `fn abs<T: Dim>(x: T) -> T` (no `=`)
    // is an *extern* declaration — its implementation lives in the host (our
    // BUILTIN_FNS). Upstream uses this for math/list primitives.
    let body = null;
    if (atOp('=')) {
      eat();
      body = parseExpr();
    }
    // Optional `where` clauses: `fn foo(x) = z where y = x * x and z = y * y`.
    // Each clause is `name = expr`, joined by the keyword `and`. Clauses are
    // evaluated in source order; each can reference parameters and prior
    // clauses, and the body can reference all of them.
    let whereClauses = null;
    if (atKw('where')) {
      eat();
      whereClauses = [parseWhereClause()];
      while (atKw('and')) {
        eat();
        whereClauses.push(parseWhereClause());
      }
    }
    return { type: 'FnDecl', name: nameTok.name, generics, params, returnType, body, whereClauses, decorators };
  }

  function parseGenericParam() {
    const nameTok = expectType('id', 'generic parameter name');
    let kind = 'Dim';
    if (atOp(':')) {
      eat();
      const kindTok = expectType('id', "generic kind (e.g. 'Dim')");
      kind = kindTok.name;
    }
    return { name: nameTok.name, kind };
  }

  function parseWhereClause() {
    const nameTok = expectType('id', 'where-clause binding name');
    // Optional type annotation: `where unit_val: D = ...`. We parse and store
    // it for future type checking; v0.5 doesn't enforce it at runtime.
    let typeAnno = null;
    if (atOp(':')) { eat(); typeAnno = parseTypeExpr(); }
    expectOp('=');
    const expr = parseExpr();
    return { name: nameTok.name, typeAnno, expr };
  }

  function parseFnParam() {
    const nameTok = expectType('id', 'parameter name');
    let typeExpr = null;
    if (atOp(':')) { eat(); typeExpr = parseTypeExpr(); }
    return { name: nameTok.name, typeExpr };
  }

  // Type expression: parseAddExpr followed by optional generic-type-args
  // `<...>` or function-type args `[(A) -> B]`. v0.5 discards the contents —
  // structs will properly typecheck them in a later version. This lets us
  // parse upstream signatures using `List<String>`, `Fn[(X) -> Y]`, etc.,
  // without failing the file.
  function parseTypeExpr() {
    const t = parseAddExpr();
    while (atOp('<') || atOp('[')) {
      const open  = atOp('<') ? '<' : '[';
      const close = open === '<' ? '>' : ']';
      eat();
      let depth = 1;
      while (depth > 0 && peek()) {
        if (atOp(open))       { depth++; eat(); }
        else if (atOp(close)) { depth--; eat(); if (depth === 0) break; }
        else                  { eat(); }
      }
      if (depth !== 0) throw err(peek(), `expected '${close}' to close type-arg bracket`);
    }
    return t;
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
    if (atOp(':')) { eat(); dim = parseTypeExpr(); }
    if (atOp('=')) { eat(); expr = parseExpr(); }
    return { type: 'UnitDecl', name: nameTok.name, dim, expr, decorators };
  }

  function parseLet(decorators) {
    eat();  // 'let'
    const nameTok = expectType('id', 'binding name');
    // Type annotation may be a dimension or a non-dim type like
    // `Fn[(DateTime) -> DateTime]`. parseTypeExpr handles both.
    let dim = null;
    if (atOp(':')) { eat(); dim = parseTypeExpr(); }
    expectOp('=');
    const expr = parseExpr();
    return { type: 'LetDecl', name: nameTok.name, dim, expr, decorators };
  }

  // ── expressions ─────────────────────────────────────────────────

  function parseExpr() {
    if (atKw('if')) return parseIfExpr();
    return parsePipe();
  }

  // Pipe `|>`: `x |> f` → Call(f, [x]); `x |> f(args)` → Call(f, [x, ...args]).
  // Left-associative, looser than conversion (`pi/3 + pi |> cos` works).
  function parsePipe() {
    let l = parseOr();
    while (atOp('|>')) {
      eat();
      const right = parsePrimary();
      if (right.type === 'Ident') {
        l = { type: 'Call', name: right.name, args: [l] };
      } else if (right.type === 'Call') {
        l = { type: 'Call', name: right.name, args: [l, ...right.args] };
      } else {
        throw err(peek(), '|> RHS must be a function name or call');
      }
    }
    return l;
  }

  function parseIfExpr() {
    eat();  // 'if'
    const cond = parseExpr();
    if (!atKw('then')) throw err(peek(), `expected 'then' in if-expression`);
    eat();
    const thenBranch = parseExpr();
    if (!atKw('else')) throw err(peek(), `expected 'else' in if-expression`);
    eat();
    const elseBranch = parseExpr();
    return { type: 'If', cond, then: thenBranch, else: elseBranch };
  }

  // Precedence (lowest → highest, all left-associative except ^):
  //   if-then-else                          (top of parseExpr)
  //   pipe `|>`
  //   logical or `||`
  //   logical and `&&`
  //   comparison ==/!=/</<=/>/>=
  //   conversion `->` / `to`
  //   + / -
  //   * / /
  //   implicit multiplication
  //   power ^ (right-associative)
  //   unary -
  //   primary
  function parseOr() {
    let l = parseAnd();
    while (atOp('||')) {
      eat();
      l = { type: 'Binary', op: '||', left: l, right: parseAnd() };
    }
    return l;
  }

  function parseAnd() {
    let l = parseCmp();
    while (atOp('&&')) {
      eat();
      l = { type: 'Binary', op: '&&', left: l, right: parseCmp() };
    }
    return l;
  }

  function parseCmp() {
    let l = parseConversion();
    while (peek() && peek().type === 'op' && CMP_OPS.has(peek().op)) {
      const op = eat().op;
      l = { type: 'Binary', op, left: l, right: parseConversion() };
    }
    return l;
  }

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
    while (true) {
      let op;
      if (atOp('*') || atOp('/')) op = eat().op;
      else if (atKw('per'))       { eat(); op = '/'; }   // `meter per second`
      else break;
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
    let base = parseUnary();
    // Postfix forms: field access `.name` and factorial `!`. Loop so chains
    // like `a.b.c!` work.
    while (atOp('.') || atOp('!')) {
      if (atOp('.')) {
        eat();
        const fnameTok = expectType('id', 'field name');
        base = { type: 'Field', obj: base, name: fnameTok.name };
      } else {
        eat();
        base = { type: 'Call', name: 'factorial', args: [base] };
      }
    }
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
    // Prefix `!` is boolean NOT. (Postfix `!` factorial is handled in
    // parsePower, after the operand is consumed.)
    if (atOp('!')) {
      eat();
      return { type: 'Unary', op: '!', expr: parseUnary() };
    }
    return parsePrimary();
  }

  function parsePrimary() {
    const t = peek();
    if (!t) throw err(null, 'unexpected end of input in expression');
    if (t.type === 'kw' && (t.name === 'true' || t.name === 'false')) {
      eat();
      return { type: 'Bool', value: t.name === 'true' };
    }
    if (t.type === 'str') { eat(); return { type: 'Str', value: t.value }; }
    if (t.type === 'num') { eat(); return { type: 'Num', value: t.value, raw: t.raw }; }
    if (t.type === 'id')  {
      eat();
      // Function call: `name(args)` if `(` immediately follows.
      if (atOp('(')) {
        eat();
        const args = [];
        if (!atOp(')')) {
          args.push(parseExpr());
          while (atOp(',')) { eat(); args.push(parseExpr()); }
        }
        expectOp(')');
        return { type: 'Call', name: t.name, args, span: t.span };
      }
      // Struct construction: `Name { field: value, ... }`.
      if (atOp('{')) {
        eat();
        const fields = [];
        while (!atOp('}')) {
          const fname = expectType('id', 'field name');
          expectOp(':');
          const fval = parseExpr();
          fields.push({ name: fname.name, value: fval });
          if (atOp(',')) eat();
        }
        expectOp('}');
        return { type: 'StructInit', name: t.name, fields, span: t.span };
      }
      return { type: 'Ident', name: t.name, span: t.span };
    }
    if (t.type === 'op' && t.op === '(') {
      eat();
      const inner = parseExpr();
      expectOp(')');
      return { type: 'Paren', expr: inner };
    }
    // List literal: `[a, b, c]`, or `[]` for empty.
    if (t.type === 'op' && t.op === '[') {
      eat();
      const items = [];
      if (!atOp(']')) {
        items.push(parseExpr());
        while (atOp(',')) { eat(); items.push(parseExpr()); }
      }
      if (!atOp(']')) throw err(peek(), `expected ']' to close list literal`);
      eat();
      return { type: 'List', items, span: t.span };
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
