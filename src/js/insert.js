// Smart insertion for the keyboard row, the unit sheet and the variable
// chips (SPEC-pocket §3.2). Pure: given the text before and after the
// cursor on the current line, a token and its kind, return how many
// trailing characters to delete before the cursor and what to insert.
// The DOM side (accessory.js insertSmart) applies the result to CM6 or a
// plain input. Kept free of DOM so it's unit-testable in Node.
//
// Kinds:
//   op     binary operator (+ − × ÷ =): trim trailing spaces, pad both
//          sides — unless the line is empty or ends with `(`, where a
//          leading space would be noise (`(-3`, `x = -3`).
//   pow    `^`: trim, no padding (`x^2`).
//   open   `(`: a space before it after a word (`sqrt (` is wrong, but
//          `3 (` is what Numbat implicit multiplication wants is not a
//          thing — keep `3 * (`): after a word char insert ` (`.
//   close  `)`: trim, no padding.
//   arrow  `->`, `to`, `|>`: trim, pad both sides.
//   fn     `sqrt(` etc.: a space after a word char, none otherwise.
//   unit   a unit name: a space after a number / word / `)`, none at line
//          start or after an operator — `3` + `km` → `3 km`, `3 ` + `km` →
//          `3 km` (no double space), `/` + `km` → `/ km` is handled by the
//          operator having padded itself already.
//   name   a variable chip: same rule as unit.
//   raw    verbatim.

// Where a token sits tight against what's before it: line start, or
// right after an opening bracket. Everywhere else one space separates.
const TIGHT = /(^|[(\[])$/;
// Where a binary operator is really unary (`x = -3`, `f(-2)`, `[-1`):
// one space before it (after `=` / `,`) but none after.
const UNARY_AFTER = /[=,]$/;

export function smartInsertion(before, after, token, kind) {
  const b = String(before || '');
  const trailingWs = b.length - b.replace(/[ \t]+$/, '').length;
  const trimmed = b.slice(0, b.length - trailingWs);
  const sep = TIGHT.test(trimmed) ? '' : ' ';
  switch (kind) {
    case 'op': {
      if (TIGHT.test(trimmed))       return { trim: trailingWs, text: token };
      if (UNARY_AFTER.test(trimmed)) return { trim: trailingWs, text: ' ' + token };
      return { trim: trailingWs, text: ' ' + token + ' ' };
    }
    case 'pow':   return { trim: trailingWs, text: '^' };
    case 'close': return { trim: trailingWs, text: ')' };
    case 'arrow': return { trim: trailingWs, text: ' ' + token + ' ' };
    case 'open':  return { trim: trailingWs, text: sep + '(' };
    case 'fn':
    case 'unit':
    case 'name':  return { trim: trailingWs, text: sep + token };
    default:      return { trim: 0, text: String(token) };
  }
}

// The keyboard-row / palette token table shape: [kind, label, text].
export const TOKEN_KIND = {
  '+': 'op', '−': 'op', '×': 'op', '÷': 'op', '=': 'op',
  '^': 'pow', '(': 'open', ')': 'close',
  '→': 'arrow', 'to': 'arrow', '|>': 'arrow',
};
