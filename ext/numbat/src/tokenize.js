// Tokenizer for Numbat-script.
//
// Emits a flat array of tokens with span info (line/col/offset) for error
// reporting. Keywords are split out from identifiers. Comments (`#` to EOL)
// are skipped. Unicode letters and a handful of symbol identifiers (`%`,
// `‰`, etc.) are accepted in identifier positions so upstream module aliases
// like `@aliases(%: short)` and Greek-letter constants tokenize cleanly.
//
// Numbers support digit separators (`1_800`) and scientific notation
// (`1.5e-3`). Number-and-unit adjacency (e.g. `5 m`) is NOT collapsed here —
// the parser treats adjacency as implicit multiplication.

export const KEYWORDS = new Set([
  'dimension', 'unit', 'let', 'fn', 'use',
  'if', 'then', 'else', 'where', 'and', 'or', 'not',
  'struct', 'to', 'per',
  'true', 'false',
  // Notably NOT a keyword: `mod` — upstream uses it as a regular fn name in
  // core::functions, so we keep it as an identifier. Numbat itself has no
  // infix `mod` operator (it's invoked as `mod(a, b)`).
]);

// Multi-character operators, sorted longest-first so the tokenizer prefers
// the longer match (`::` before `:`, `->` before `-`).
const MULTI_OPS = ['->', '::', '|>', '!=', '<=', '>=', '==', '&&', '||', '**'];

// Single-character operators / punctuation.
const SINGLE_OPS = '+-*/^=(){}[],:.<>!;';

const UNICODE_OP_ALIAS = {
  '→': '->',
  '×': '*',
  '÷': '/',
  '−': '-',
  '·': '*',
  '²': '^2',   // handled specially below — emits OP^ then NUM 2
  '³': '^3',
  'π': null,   // identifier, not operator
};

// Identifier-start: ASCII letter, underscore, `%`, `$`, or any non-ASCII
// codepoint. This makes Greek letters, currency symbols, and symbol-style
// aliases (`%`, `‰`, `°`, `$`) tokenizable without lookup tables. The
// parser/loader decides which are valid in context.
const isIdentStart = (c) =>
  (c >= 'a' && c <= 'z') ||
  (c >= 'A' && c <= 'Z') ||
  c === '_' ||
  c === '%' ||
  c === '$' ||
  c.charCodeAt(0) >= 0x80;

const isIdentCont = (c) =>
  // ² and ³ are unicode exponent shorthands handled by the special-case branch
  // below; they must NOT extend an identifier (so `m²` tokenizes as `m`, `^`,
  // `2` rather than as a single weird identifier `m²`).
  c !== '²' && c !== '³' &&
  (isIdentStart(c) || (c >= '0' && c <= '9'));

export function tokenize(source, sourceName = '<input>') {
  const toks = [];
  let i = 0, line = 1, col = 1;

  const advance = (n = 1) => {
    for (let k = 0; k < n; k++) {
      if (source[i + k] === '\n') { line++; col = 1; }
      else col++;
    }
    i += n;
  };

  const here = () => ({ line, col, offset: i, source: sourceName });

  const emit = (type, fields, start) => {
    toks.push({ type, ...fields, span: { ...start, end: i } });
  };

  while (i < source.length) {
    const start = here();
    const c = source[i];

    // Whitespace
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { advance(); continue; }

    // Comments: # to end of line. Numbat uses `###` for section headers but
    // those are still just comments.
    if (c === '#') {
      while (i < source.length && source[i] !== '\n') advance();
      continue;
    }

    // Decorator: @identifier
    if (c === '@') {
      advance();
      const nameStart = i;
      while (i < source.length && isIdentCont(source[i])) advance();
      const name = source.slice(nameStart, i);
      if (!name) throw new Error(`${sourceName}:${start.line}:${start.col}: expected identifier after '@'`);
      emit('dec', { name }, start);
      continue;
    }

    // String literal
    if (c === '"') {
      advance();
      let value = '';
      while (i < source.length && source[i] !== '"') {
        if (source[i] === '\\' && i + 1 < source.length) {
          const esc = source[i + 1];
          value += esc === 'n' ? '\n'
                : esc === 't' ? '\t'
                : esc === 'r' ? '\r'
                : esc;
          advance(2);
        } else {
          value += source[i];
          advance();
        }
      }
      if (i >= source.length) throw new Error(`${sourceName}:${start.line}:${start.col}: unterminated string`);
      advance();  // consume closing quote
      emit('str', { value }, start);
      continue;
    }

    // Number literal — decimal (incl. underscore separators, scientific),
    // hexadecimal (0x), octal (0o), or binary (0b).
    if ((c >= '0' && c <= '9') || (c === '.' && source[i + 1] >= '0' && source[i + 1] <= '9')) {
      const numStart = i;
      // Radix-prefixed integers: `0x`, `0o`, `0b` (case-insensitive prefix).
      if (c === '0' && i + 1 < source.length) {
        const radixCh = source[i + 1];
        let radix = 0, allowed = null;
        if (radixCh === 'x' || radixCh === 'X') { radix = 16; allowed = /[0-9a-fA-F_]/; }
        else if (radixCh === 'o' || radixCh === 'O') { radix = 8;  allowed = /[0-7_]/;       }
        else if (radixCh === 'b' || radixCh === 'B') { radix = 2;  allowed = /[01_]/;        }
        if (radix) {
          advance(2);
          while (i < source.length && allowed.test(source[i])) advance();
          const raw = source.slice(numStart, i);
          const digits = raw.slice(2).replace(/_/g, '');
          if (!digits) throw new Error(`${sourceName}:${start.line}:${start.col}: empty radix literal`);
          emit('num', { value: parseInt(digits, radix), raw }, start);
          continue;
        }
      }
      let dot = false, eExp = false;
      while (i < source.length) {
        const ch = source[i];
        if (ch >= '0' && ch <= '9') advance();
        else if (ch === '_' && source[i + 1] >= '0' && source[i + 1] <= '9') advance();
        else if (ch === '.' && !dot && !eExp) { dot = true; advance(); }
        else if ((ch === 'e' || ch === 'E') && !eExp) {
          eExp = true; advance();
          if (source[i] === '+' || source[i] === '-') advance();
        } else break;
      }
      const raw = source.slice(numStart, i);
      const value = parseFloat(raw.replace(/_/g, ''));
      emit('num', { value, raw }, start);
      continue;
    }

    // Unicode exponents: ² → "^2", ³ → "^3"
    if (c === '²' || c === '³') {
      advance();
      emit('op', { op: '^' }, start);
      const numStart = here();
      emit('num', { value: c === '²' ? 2 : 3, raw: c }, numStart);
      continue;
    }

    // Multi-character operators
    let matched = false;
    for (const op of MULTI_OPS) {
      if (source.startsWith(op, i)) {
        advance(op.length);
        emit('op', { op }, start);
        matched = true;
        break;
      }
    }
    if (matched) continue;

    // Unicode operator aliases (single-char)
    if (UNICODE_OP_ALIAS[c] && UNICODE_OP_ALIAS[c] !== null) {
      const op = UNICODE_OP_ALIAS[c];
      advance();
      emit('op', { op }, start);
      continue;
    }

    // Identifier or keyword (must come AFTER unicode-op-alias check so π isn't
    // an op alias, but it IS an identifier — UNICODE_OP_ALIAS['π'] is null so
    // we fall through here).
    if (isIdentStart(c)) {
      const idStart = i;
      while (i < source.length && isIdentCont(source[i])) advance();
      const name = source.slice(idStart, i);
      emit(KEYWORDS.has(name) ? 'kw' : 'id', { name }, start);
      continue;
    }

    // Single-character operators
    if (SINGLE_OPS.includes(c)) {
      advance();
      emit('op', { op: c }, start);
      continue;
    }

    throw new Error(`${sourceName}:${start.line}:${start.col}: unexpected character ${JSON.stringify(c)}`);
  }

  return toks;
}
