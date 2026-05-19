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

  // Span-combining helpers — attach a span to compound nodes that
  // covers the leftmost-child's start through the rightmost-child's
  // end. Lets error formatters caret the full source range of an
  // expression instead of just one operand.
  const spanOfN = (n) => n?.span ?? null;
  const combineSpans = (a, b) => {
    if (!a) return b;
    if (!b) return a;
    return { source: a.source, line: a.line, col: a.col, offset: a.offset, end: b.end ?? b.offset };
  };
  const mkBin = (op, left, right) => ({
    type: 'Binary', op, left, right,
    span: combineSpans(spanOfN(left), spanOfN(right)),
  });
  const mkUnary = (op, expr, headSpan) => ({
    type: 'Unary', op, expr,
    span: combineSpans(headSpan, spanOfN(expr)),
  });
  const mkParen = (expr, openSpan, closeSpan) => ({
    type: 'Paren', expr,
    span: combineSpans(openSpan, closeSpan ?? spanOfN(expr)),
  });
  const mkIf = (cond, thenB, elseB, headSpan) => ({
    type: 'If', cond, then: thenB, else: elseB,
    span: combineSpans(headSpan, spanOfN(elseB)),
  });
  const mkFactorial = (expr, bangSpan) => ({
    type: 'Factorial', expr,
    span: combineSpans(spanOfN(expr), bangSpan),
  });
  const mkField = (obj, name, nameSpan) => ({
    type: 'Field', obj, name,
    span: combineSpans(spanOfN(obj), nameSpan),
  });

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
      while (!atOp('>')) {
        generics.push(parseGenericParam());
        if (atOp(',')) eat();
        else break;
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
      while (!atOp('>')) {
        generics.push(parseGenericParam());
        if (atOp(',')) eat();
        else break;
      }
      if (!atOp('>')) throw err(peek(), `expected '>' to close generic parameters`);
      eat();
    }
    expectOp('(');
    const params = [];
    while (!atOp(')')) {
      params.push(parseFnParam());
      if (atOp(',')) eat();
      else break;
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
    // Default kind is 'Type' (unrestricted) — matches upstream Numbat.
    // `<T: Dim>` is the explicit Dim-restricted form. The typechecker
    // promotes Type-kinded generics to Dim lazily via constraints when
    // they appear in dim-arithmetic positions.
    let kind = 'Type';
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
  // `<...>` (captured as TypeApp) or function-type args `[(A) -> B]`
  // (captured as FnTypeAnno when the head is `Fn`). The angle-bracket
  // form is used for generic structs and List<D>; the bracket form is
  // used for first-class function types.
  function parseTypeExpr() {
    let t = parseAddExpr();
    while (atOp('<') || atOp('[')) {
      const open = peek().op;
      if (open === '<') {
        eat();
        const args = [];
        if (!atOp('>')) {
          args.push(parseTypeExpr());
          while (atOp(',')) { eat(); args.push(parseTypeExpr()); }
        }
        if (!atOp('>')) throw err(peek(), `expected '>' to close type-arg bracket`);
        eat();
        t = { type: 'TypeApp', base: t, args, span: t.span };
      } else {
        // `Fn[(A, B) -> C]` — parse the params + result properly.
        // Only recognized when the head is the identifier 'Fn'. For
        // anything else, fall back to the legacy "scan and discard"
        // behavior so non-Fn `[...]` annotations don't break parses.
        if (t.type === 'Ident' && t.name === 'Fn') {
          eat();   // consume '['
          expectOp('(');
          const params = [];
          if (!atOp(')')) {
            params.push(parseTypeExpr());
            while (atOp(',')) { eat(); params.push(parseTypeExpr()); }
          }
          expectOp(')');
          if (!atOp('->')) throw err(peek(), `expected '->' in Fn[...] type`);
          eat();
          const result = parseTypeExpr();
          if (!atOp(']')) throw err(peek(), `expected ']' to close Fn[...] type`);
          eat();
          t = { type: 'FnTypeAnno', params, result, span: t.span };
        } else {
          // Unknown `[...]` annotation — scan and discard.
          eat();
          let depth = 1;
          while (depth > 0 && peek()) {
            if (atOp('['))      { depth++; eat(); }
            else if (atOp(']')) { depth--; eat(); if (depth === 0) break; }
            else                { eat(); }
          }
          if (depth !== 0) throw err(peek(), `expected ']' to close type-arg bracket`);
        }
      }
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
    // Arrow-function lambda — single-param `x => body` form. The
    // multi-param `(x, y) => body` form is detected in parsePrimary
    // when it sees `(` (since `(x, y)` isn't a valid paren-expression
    // and would otherwise parse-fail). ep-flavored extension; upstream
    // Numbat doesn't currently have anonymous-fn syntax.
    if (peek() && peek().type === 'id' && peek(1) && peek(1).type === 'op' && peek(1).op === '=>') {
      const paramTok = eat();
      eat();  // '=>'
      const body = parseExpr();
      return { type: 'Lambda', params: [{ name: paramTok.name }], body, span: paramTok.span };
    }
    return parsePipe();
  }

  // Lookahead helper: from a `(` position, scan forward tracking paren
  // depth to find the matching `)`; return true iff `=>` follows it.
  // Used to disambiguate `(x, y) => body` (lambda) from `(x)` (paren-expr).
  function isParenLambdaAhead() {
    let depth = 0;
    let i = p;
    while (i < tokens.length) {
      const t = tokens[i];
      if (t.type === 'op' && t.op === '(') depth++;
      else if (t.type === 'op' && t.op === ')') {
        depth--;
        if (depth === 0) {
          const next = tokens[i + 1];
          return !!(next && next.type === 'op' && next.op === '=>');
        }
      }
      i++;
    }
    return false;
  }

  // Parse a multi-param lambda: positioned at the opening `(`.
  // Form: `(name [: TypeAnno], name [: TypeAnno], ...) => body`
  function parseParenLambda() {
    const openTok = eat();   // '('
    const params = [];
    while (!atOp(')')) {
      const nameTok = peek();
      if (!nameTok || nameTok.type !== 'id') {
        throw err(nameTok, 'expected lambda parameter name');
      }
      eat();
      const param = { name: nameTok.name };
      if (atOp(':')) {
        eat();
        param.type = parseTypeAnno();
      }
      params.push(param);
      if (atOp(',')) eat();
      else break;
    }
    expectOp(')');
    expectOp('=>');
    const body = parseExpr();
    return { type: 'Lambda', params, body, span: openTok.span };
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
    return mkIf(cond, thenBranch, elseBranch, spanOfN(cond));
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
      l = mkBin('||', l, parseAnd());
    }
    return l;
  }

  function parseAnd() {
    let l = parseCmp();
    while (atOp('&&')) {
      eat();
      l = mkBin('&&', l, parseCmp());
    }
    return l;
  }

  function parseCmp() {
    let l = parseConversion();
    while (peek() && peek().type === 'op' && CMP_OPS.has(peek().op)) {
      const op = eat().op;
      l = mkBin(op, l, parseConversion());
    }
    return l;
  }

  function parseConversion() {
    let l = parseAddExpr();
    while (atOp('->') || atKw('to')) {
      eat();
      const right = parseAddExpr();
      l = mkBin('->', l, right);
    }
    return l;
  }

  function parseAddExpr() {
    let l = parseMulExpr();
    while (atOp('+') || atOp('-')) {
      const op = eat().op;
      l = mkBin(op, l, parseMulExpr());
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
      l = mkBin(op, l, parseImplMul());
    }
    return l;
  }

  function parseImplMul() {
    let l = parsePower();
    while (isExprStart(peek())) {
      l = mkBin('*', l, parsePower());
    }
    return l;
  }

  function parsePower() {
    let base = parseUnary();
    // Postfix forms: field access `.name` and factorial `!`. Loop so chains
    // like `a.b.c!` work. `!` is its own AST node — NOT a Call to factorial —
    // so user-defined `fn factorial(n) = n!` doesn't recurse infinitely.
    while (atOp('.') || atOp('!')) {
      if (atOp('.')) {
        eat();
        const fnameTok = expectType('id', 'field name');
        base = mkField(base, fnameTok.name, fnameTok.span);
      } else {
        const bangTok = eat();
        base = mkFactorial(base, bangTok.span);
      }
    }
    if (atOp('^') || atOp('**')) {
      eat();
      const exp = parsePower();  // right-associative
      return mkBin('^', base, exp);
    }
    return base;
  }

  function parseUnary() {
    if (atOp('-')) {
      const tok = eat();
      return mkUnary('-', parseUnary(), tok.span);
    }
    // Prefix `!` is boolean NOT. (Postfix `!` factorial is handled in
    // parsePower, after the operand is consumed.)
    if (atOp('!')) {
      const tok = eat();
      return mkUnary('!', parseUnary(), tok.span);
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
        while (!atOp(')')) {
          args.push(parseExpr());
          if (atOp(',')) eat();
          else break;
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
          else break;
        }
        expectOp('}');
        return { type: 'StructInit', name: t.name, fields, span: t.span };
      }
      return { type: 'Ident', name: t.name, span: t.span };
    }
    if (t.type === 'op' && t.op === '(') {
      // Multi-param lambda: `(x, y) => body`. Detect via lookahead so
      // we don't try to parse `(x, y)` as a paren-expr first (the
      // comma would fail the regular expression grammar). Single-
      // param lambdas without parens land in parseExpr instead.
      if (isParenLambdaAhead()) {
        return parseParenLambda();
      }
      const openTok  = eat();
      const inner    = parseExpr();
      const closeTok = expectOp(')');
      return mkParen(inner, openTok.span, closeTok.span);
    }
    // List literal: `[a, b, c]`, or `[]` for empty. Trailing commas allowed.
    if (t.type === 'op' && t.op === '[') {
      eat();
      const items = [];
      while (!atOp(']')) {
        items.push(parseExpr());
        if (atOp(',')) eat();
        else break;
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
