// Embedded user-facing guide pages. Rendered in the drawer's docs mode
// above the function reference. Each GUIDE entry is a markdown body the
// tiny renderer below converts to DOM nodes.
//
// Numbat fundamentals pages are adapted from the upstream Numbat book
// (https://github.com/sharkdp/numbat, MIT/Apache-2.0). Attribution
// lives at the bottom of those pages.
//
// MARKER comments are NOT used inline; export.js detects the GUIDES
// array by name and replaces its contents at program-form export time.
// See `stripGuides()` over there.

/* MARKER:GUIDES_START */
export const GUIDES = [
  // ── Getting started ──────────────────────────────────────────────
  {
    slug: 'getting-started',
    title: 'Getting started',
    summary: 'Your first calculation in ep.',
    body: `
# Getting started

ep is a calculator that knows units. Type an expression and see the result in the gutter on the right.

\`\`\`
3 * 4 m
\`\`\`

The right column shows \`12 m\`. ep parsed the literal \`4 m\` as four meters, did the multiplication, and formatted the result.

You can bind names with \`=\`:

\`\`\`
length = 200 m
width  = 50 m
area   = length * width
\`\`\`

The third row shows \`10000 m²\` — ep tracks dimensions, so \`length\` times \`width\` gives an area, and the gutter renders the unit accordingly.

Comments use \`#\` or \`--\`. Both run to end of line.

## What's a chip?

A row tagged with \`@input\` (see the **Decorators** guide) becomes an editable *chip* at the top of the page. The chip is a friendlier way to change a single value than scrolling back to its line.

A row tagged with \`@output\` becomes a read-only chip at the bottom — the answers you care about, surfaced.

## Next

Read the **Decorators** guide to see how to turn a one-off calculation into a parameterized form.
`,
  },

  // ── Decorators ───────────────────────────────────────────────────
  {
    slug: 'decorators',
    title: 'Decorators',
    summary: '@input, @output, @options, @range — ep\'s form-builder layer.',
    body: `
# Decorators

Decorators are how ep turns ordinary Numbat code into an interactive form. They sit on the line *above* a binding and are real Numbat decorator syntax, so programs round-trip through upstream Numbat unchanged.

## @input

Marks the binding as a user-editable input — appears as a chip at the top of the page.

\`\`\`
@input
length = 200 m
\`\`\`

The chip shows the current value; tap it to change. Whatever you type re-evaluates the whole program.

## @output

Marks the binding as something to surface at the bottom of the page.

\`\`\`
@output
area = length * width
\`\`\`

Pass a unit to override how it's displayed:

\`\`\`
@output(kt)
tonnage = volume * density
\`\`\`

If the binding's dimension doesn't match the unit, ep traces back through the expression and tells you *which input* is the suspect.

## @options(...)

Restricts an input to a list of choices. The chip becomes a dropdown.

\`\`\`
@input
@options(granite, basalt, sandstone)
rock_type = granite
\`\`\`

## @range(min, max [, step])

Renders the input chip as a slider over the given numeric range.

\`\`\`
@input
@range(0, 1, 0.05)
cutoff_grade = 0.5
\`\`\`

## Decorator stacking

Multiple decorators on the same binding stack — put each on its own line just above the binding:

\`\`\`
@input
@output(L)
volume = 5 gal     # an input chip AND an output chip
\`\`\`
`,
  },

  // ── Broadcasting + masks ─────────────────────────────────────────
  {
    slug: 'broadcasting',
    title: 'Broadcasting + masks',
    summary: 'List arithmetic, comparison operators, and filtering.',
    body: `
# Broadcasting + masks

ep extends Numbat with element-wise list operations — numpy-shaped, but typed and dimension-aware.

## Arithmetic broadcasts

\`\`\`
xs = [1, 2, 3, 4, 5]

xs * 2          # [2, 4, 6, 8, 10]
xs + 10         # [11, 12, 13, 14, 15]
xs * xs         # [1, 4, 9, 16, 25]
sin(xs)         # element-wise sin
sqrt(xs)        # element-wise sqrt
\`\`\`

Rules:
* **List + List** (same length) → element-wise.
* **List + Scalar** or **Scalar + List** → broadcast the scalar.
* Length mismatch errors per-pair with a clear message.
* Dimensions still apply per-element: \`[1 m] + [2 kg]\` is a dim mismatch, just like scalars.

## Comparison broadcasts → masks

Comparison operators produce \`List<Bool>\` masks:

\`\`\`
xs > 3                  # [false, false, false, true, true]
(xs > 2) && (xs < 5)    # [false, false, true, true, false]
!(xs == 3)              # [true, true, false, true, true]
\`\`\`

\`==\` and \`!=\` between two lists stay structural (return \`true\`/\`false\` for the whole pair) so existing patterns like \`xs == []\` keep working.

## Filtering with masks

\`filter\` is overloaded — a function predicate keeps the original behavior; a mask the same length as xs picks elements:

\`\`\`
filter(xs > 3, xs)          # [4, 5]
filter(x => x > 3, xs)      # same — functional form still works
\`\`\`

## Mask reductions

\`\`\`
any(xs > 100)               # false (short-circuits)
all(xs > 0)                 # true  (short-circuits)
count(xs > 2)               # 3
\`\`\`

\`any\` and \`all\` short-circuit on the first determining element; \`count\` walks the full mask.
`,
  },

  // ── Plots ────────────────────────────────────────────────────────
  {
    slug: 'plots',
    title: 'Plots',
    summary: 'Inline canvas charts: plot, scatter, bar_chart, hist.',
    body: `
# Plots

Plotting procs render a canvas widget inline, below the calling line. Four kinds:

\`\`\`
xs = linspace(0, 4*pi, 200)

plot(xs, sin(xs), "x", "sin(x)", "Sine wave")
scatter(xs, sin(xs) + random_list(200) * 0.1)
bar_chart([3, 7, 2, 8, 5])
hist(random_list(1000))
\`\`\`

Trailing string args are optional: x-axis label, y-axis label, title — in that order. Leave them off for a chrome-light chart.

## Plots as @outputs

Add \`@output\` above a plot binding to surface a thumbnail in the outputs panel:

\`\`\`
@output
wave = plot(xs, sin(xs), "x", "sin(x)", "Sine wave")
\`\`\`

The thumbnail is symbolic — no axes, no labels — just the shape of the data. **Tap** it to enlarge into a centered modal with the full chrome. **Long-press** it to scroll the editor to the source row (with a brief flash).

## List constructors for plot inputs

* \`range(a, b)\` — inclusive integer range.
* \`arange(a, b, step?)\` — numpy-style, stop exclusive, step optional.
* \`linspace(a, b, n)\` — n evenly-spaced points; preserves units.
* \`zeros(n)\` / \`ones(n)\` — fixed-value lists.
* \`random_list(n)\` — n uniform samples on [0, 1).
`,
  },

  // ── Export ───────────────────────────────────────────────────────
  {
    slug: 'export',
    title: 'Export',
    summary: 'Share your calculation as a .ep file, a single-file form, a URL, or a QR.',
    body: `
# Export

ep's headline trick: every program can travel as a self-contained file. Open **Export** from the header (or \`Cmd/Ctrl+E\`).

## Formats

* **\`.ep\`** — your program's source as plain text. Tiny. Re-open in ep, or paste into Slack/email.
* **\`.html\` (form)** — a single HTML file with your program baked in as a form. The recipient opens it, fills in inputs, reads outputs. They don't need to know what ep is. The file has no service worker, no external requests — it works from a USB stick five years from now.
* **🔗 link** — your program lz-compressed into a URL like \`gentropic.org/ep/?p=...\`. Tap the link button to copy to clipboard. Mobile uses the OS share sheet when available.
* **QR** — same content as the link, encoded as an inline SVG QR code. Scan with a phone to load.

## What the form looks like

The exported \`.html\` opens directly in form mode — no editor, no drawer. Just the input chips, the output chips, and a "show source" link if the recipient is curious. Switching to source mode and back is a single tap.

The form has the same Switchboard styling as ep itself. It's tiny (a few hundred KB) and works offline.

## What gets carried

* The program source.
* Snapshot history (so the recipient sees the same versions you saw — optional, can be cleared first).
* This guide page does NOT travel with form-exports; the docs are stripped at export time so shared calculators don't carry unnecessary weight.
`,
  },

  // ── Form view ────────────────────────────────────────────────────
  {
    slug: 'form-view',
    title: 'Designer + Form views',
    summary: 'The two ways ep presents your program.',
    body: `
# Designer + Form views

ep has two visual modes for the same program.

## Designer

The default. You see the source body, the chips above and below, the right-side gutter with per-row results. This is where you *write* the calculation.

## Form

A simplified view — only the input chips, the output chips, and a "show source" toggle. No editor. This is what someone using the exported \`.html\` sees first.

Switch via the **FORM** button in the header. The toggle is also available in the form view to flip back to designer.

The form mode exists because most ep users are *recipients* of someone else's calculation, not authors of one. They want to plug in their numbers and read the answers. Hiding the source by default lowers the cognitive barrier; the toggle keeps the source one tap away for the curious.
`,
  },

  // ── Programs + persistence ───────────────────────────────────────
  {
    slug: 'programs',
    title: 'Programs + persistence',
    summary: 'How ep saves, lists, and restores your work.',
    body: `
# Programs + persistence

ep autosaves every edit to your browser's local storage (\`IndexedDB\`). No "save" button to remember.

## The drawer

Tap the hamburger (top-left, or \`Cmd/Ctrl+P\`) to open the drawer. Three tabs:

* **programs** — saved programs sorted by recency or alphabetically.
* **history** — snapshots of the current program (auto + manual).
* **docs** — this guide and the function reference.

## Snapshots

ep auto-snapshots the first time you open a program in a session, and before destructive actions (paste of 5+ lines, restore from another snapshot, clear). You can also snapshot manually from the drawer's history tab with an optional label.

Snapshots from the last 24 hours are all kept; older ones are pruned to the most recent 20 per program. **Pin** a snapshot to keep it forever.

## What's stored

* \`ep:programs\` — your program bodies + per-program metadata.
* \`ep:settings\` — drawer / display preferences.

Nothing leaves your browser. Even the QR/link share mechanism is client-side compression into a URL — no server.
`,
  },

  // ── Numbers + units (adapted from Numbat) ────────────────────────
  {
    slug: 'numbers-units',
    title: 'Numbers + units',
    summary: 'Literal numbers, unit literals, dimension arithmetic.',
    body: `
# Numbers + units

A number literal can be a plain decimal, scientific notation, or with thousands separators:

\`\`\`
3
3.14
6.022e23
1_000_000
\`\`\`

A unit follows the number to give it dimension:

\`\`\`
5 m              # five meters (length)
2.5 g/cm³        # density
60 mph           # speed
9.81 m/s²        # acceleration
\`\`\`

Units come with SI prefixes — \`km\`, \`ms\`, \`MJ\`, \`pF\` all just work — and ep ships a wide table of physical units (mass, length, time, current, temperature, derived units like \`pascal\`, \`watt\`, \`joule\`).

## Dimension arithmetic

Ep tracks dimensions automatically through arithmetic:

\`\`\`
length = 5 m
time   = 2 s
speed  = length / time     # 2.5 m/s — the dim is [length/time]
\`\`\`

You can't add quantities with different dimensions:

\`\`\`
5 m + 3 kg                 # error: dim mismatch [length] vs [mass]
\`\`\`

This catches a whole class of bugs that calculator-without-units programs let through.

## Annotation

You can annotate a binding with a dimension name to assert what you expect:

\`\`\`
speed : Velocity = length / time
\`\`\`

If the right-hand side's dimension doesn't match \`Velocity\`, you get an error.

---

*Adapted from the [Numbat](https://github.com/sharkdp/numbat) language documentation by David Peter, MIT/Apache-2.0.*
`,
  },

  // ── Dimensions (adapted from Numbat) ─────────────────────────────
  {
    slug: 'dimensions',
    title: 'Dimensions',
    summary: 'What dimensions are and how they propagate.',
    body: `
# Dimensions

A *dimension* is a kind of quantity — length, mass, time, charge — independent of any specific unit. Two quantities with the same dimension can be added or compared even if they were originally written in different units:

\`\`\`
3 m + 5 ft         # both are [length] — works
3 m + 5 kg         # different dimensions — error
\`\`\`

## Base dimensions

ep ships the SI base dimensions: \`Length\`, \`Mass\`, \`Time\`, \`Current\`, \`Temperature\`, \`AmountOfSubstance\`, \`LuminousIntensity\`. Plus a few common derived ones: \`Velocity\`, \`Acceleration\`, \`Energy\`, \`Power\`, \`Force\`, \`Pressure\`, \`Density\`, \`Frequency\`, \`Charge\`, \`Voltage\`, etc.

## How arithmetic propagates

* \`+\` and \`-\` require matching dimensions on both sides. Result has the same dimension.
* \`*\` and \`/\` combine dimensions: \`Length / Time = Velocity\`, \`Force * Length = Energy\`.
* \`^\` with an integer exponent raises the dimension: \`Length^3 = Volume\`.

Functions like \`sqrt\` and \`cbrt\` divide the dimension exponent: \`sqrt(16 m²) = 4 m\`, \`cbrt(27 m³) = 3 m\`.

\`sin\`, \`cos\`, \`exp\`, \`ln\` and other transcendentals require their argument to be dimensionless.

## Defining custom dimensions

Rare in everyday calculation, but available:

\`\`\`
dimension Reactivity = 1 / Time
\`\`\`

---

*Adapted from the [Numbat](https://github.com/sharkdp/numbat) language documentation by David Peter, MIT/Apache-2.0.*
`,
  },

  // ── Unit conversion ──────────────────────────────────────────────
  {
    slug: 'conversion',
    title: 'Unit conversion',
    summary: 'The to and -> arrows.',
    body: `
# Unit conversion

Express a quantity in a different unit of the same dimension with the \`to\` keyword (or the \`->\` arrow — they're the same thing):

\`\`\`
60 mph -> m/s          # 26.8224 m/s
60 mph to m/s          # same
3 ft -> cm             # 91.44 cm
1 kWh -> J             # 3600000 J
\`\`\`

The arrow is purely cosmetic — the underlying canonical value doesn't change, only how the result displays.

You can convert to compound units too:

\`\`\`
1 atm -> N/m²
2.7 g/cm³ -> kg/m³
\`\`\`

## Conversion vs annotation

There's a difference between *converting* and *asserting* a dimension:

\`\`\`
speed = 60 mph -> m/s           # converts to m/s for display
speed : Velocity = 60 mph       # asserts the dim is Velocity
\`\`\`

The first changes the display; the second checks the dimension matches and errors if not.

---

*Adapted from the [Numbat](https://github.com/sharkdp/numbat) language documentation by David Peter, MIT/Apache-2.0.*
`,
  },

  // ── Functions ────────────────────────────────────────────────────
  {
    slug: 'functions',
    title: 'Functions',
    summary: 'Defining your own fns + arrow-function lambdas.',
    body: `
# Functions

Define a named function with \`fn\`:

\`\`\`
fn area(side: Length) -> Length^2 = side * side

area(3 m)              # 9 m²
\`\`\`

Parameter and return types are optional but recommended — they catch dimension mismatches at the boundary.

## Dimension generics

Functions can be polymorphic over dimensions:

\`\`\`
fn square<D: Dim>(x: D) -> D^2 = x * x
\`\`\`

Now \`square(3 m)\` is \`9 m²\` and \`square(4 s)\` is \`16 s²\` — the same function works for any dimension.

## Where-clauses

Local bindings for a function body:

\`\`\`
fn quadratic(x: Scalar) -> Scalar =
  a * x^2 + b * x + c
  where a = 1
    and b = -3
    and c = 2
\`\`\`

## Arrow-function lambdas (ep extension)

For one-off helpers without naming them:

\`\`\`
filter(x => x > 0, [-2, 0, 3])      # [3]
map((x, y) => x + y * 2, ...)
\`\`\`

Upstream Numbat doesn't have lambdas yet; ep adds them as a small parser extension. Compatible with upstream if/when lambdas land there.

---

*"fn" + "where" semantics adapted from the [Numbat](https://github.com/sharkdp/numbat) language documentation by David Peter, MIT/Apache-2.0.*
`,
  },

  // ── Lists ────────────────────────────────────────────────────────
  {
    slug: 'lists',
    title: 'Lists',
    summary: 'List literals, indexing, and primitives.',
    body: `
# Lists

Lists are written with brackets:

\`\`\`
xs = [1, 2, 3]
ms = [1 m, 2 m, 3 m]   # list of Length
\`\`\`

All elements must share a type (and dimension, for quantities).

## Indexing + slicing

* \`element_at(i, xs)\` — 0-indexed lookup.
* \`head(xs)\`, \`tail(xs)\` — first element / rest of list.
* \`take(n, xs)\`, \`drop(n, xs)\` — slice from the start.
* \`reverse(xs)\` — reverse order.
* \`concat(xs, ys)\` — append.
* \`len(xs)\` — number of elements.
* \`is_empty(xs)\` — true if zero-length.

## Transformations

* \`map(fn, xs)\` — apply fn to each element. Often unnecessary; see **Broadcasting**.
* \`map2(fn, a, xs)\` — element-wise binary map.
* \`filter(pred_or_mask, xs)\` — keep matching elements; see **Broadcasting + masks**.
* \`foldl(fn, init, xs)\` — left fold.

## Constructors

* \`range(a, b)\` — inclusive integer range.
* \`arange(a, b, step?)\` — numpy-style.
* \`linspace(a, b, n)\` — n evenly-spaced; unit-preserving.
* \`zeros(n)\`, \`ones(n)\` — fixed-value lists.
* \`random_list(n)\` — n uniform [0, 1) samples.

Together with broadcasting and masks (see **Broadcasting + masks**), these cover most numpy-style workflows you'll do in a calculator notepad.
`,
  },

  // ── Strings ──────────────────────────────────────────────────────
  {
    slug: 'strings',
    title: 'Strings',
    summary: 'String literals and the helper procs.',
    body: `
# Strings

String literals use double quotes:

\`\`\`
name = "ore_body"
header = "tonnage [kt]"
\`\`\`

Strings are mostly used for plot labels and \`print()\`. ep doesn't have heavy string-processing ambitions.

## Helpers

* \`str_length(s)\` — character count.
* \`str_append(a, b)\` — concatenate.
* \`str_slice(s, from, to)\` — substring (0-indexed, end exclusive).
* \`str_contains(s, sub)\` — substring check, returns Bool.
* \`str_starts_with(s, p)\` / \`str_ends_with(s, p)\` — prefix/suffix check.
* \`str_replace(s, from, to)\` — substring replace.
* \`str_upper(s)\` / \`str_lower(s)\` — case conversion.
* \`to_string(q)\` — quantity to string with default formatting.
* \`chr(code)\` / \`ord(s)\` — character code conversion.

---

*Adapted from the [Numbat](https://github.com/sharkdp/numbat) language documentation by David Peter, MIT/Apache-2.0.*
`,
  },
];
/* MARKER:GUIDES_END */

// ── Tiny markdown renderer ────────────────────────────────────────
//
// Supports the ep-flavored subset:
//   # / ## / ### headings, paragraphs, ```fenced code```, inline `code`,
//   * bullet lists, **bold**, *italic*, [text](url) links, --- hr.
// Returns an array of DOM nodes — caller appends them into a container.
// Not a full CommonMark; if it can't parse a line, the line becomes plain
// text (safe fallback rather than throwing).
export function renderMarkdown(src) {
  const out = [];
  const lines = src.split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    // Fenced code block: ```… ``` block ends at the next ``` line.
    // Wrapped in a container that hosts a copy button — most useful
    // action on an in-guide snippet is "paste it into the editor and
    // see what it does."
    if (line.startsWith('```')) {
      const wrap = document.createElement('div');
      wrap.className = 'guide-code-wrap';
      const pre = document.createElement('pre');
      pre.className = 'guide-code';
      let j = i + 1;
      const buf = [];
      while (j < lines.length && !lines[j].startsWith('```')) {
        buf.push(lines[j]);
        j++;
      }
      const code = buf.join('\n');
      pre.textContent = code;
      const copyBtn = document.createElement('button');
      copyBtn.className = 'guide-code-copy';
      copyBtn.type = 'button';
      copyBtn.setAttribute('aria-label', 'copy snippet');
      copyBtn.textContent = 'copy';
      copyBtn.addEventListener('click', async () => {
        const fallback = () => {
          // execCommand path for non-secure contexts where
          // navigator.clipboard is unavailable (e.g. file://).
          const ta = document.createElement('textarea');
          ta.value = code;
          ta.style.position = 'fixed';
          ta.style.opacity = '0';
          document.body.appendChild(ta);
          ta.select();
          try { document.execCommand('copy'); } catch { /* swallow */ }
          ta.remove();
        };
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(code);
          } else {
            fallback();
          }
        } catch {
          fallback();
        }
        const prev = copyBtn.textContent;
        copyBtn.textContent = 'copied';
        copyBtn.classList.add('copied');
        setTimeout(() => {
          copyBtn.textContent = prev;
          copyBtn.classList.remove('copied');
        }, 1200);
      });
      wrap.appendChild(pre);
      wrap.appendChild(copyBtn);
      out.push(wrap);
      i = j + 1;
      continue;
    }
    // Headings.
    const h = line.match(/^(#{1,3})\s+(.*)$/);
    if (h) {
      const level = h[1].length;
      const el = document.createElement('h' + (level + 1)); // h2/h3/h4
      el.className = 'guide-h' + level;
      appendInline(el, h[2]);
      out.push(el);
      i++;
      continue;
    }
    // Horizontal rule.
    if (/^-{3,}\s*$/.test(line)) {
      out.push(document.createElement('hr'));
      i++;
      continue;
    }
    // Bullet list — consume contiguous "* " or "- " lines as one <ul>.
    if (/^[\*\-]\s+/.test(line)) {
      const ul = document.createElement('ul');
      ul.className = 'guide-ul';
      while (i < lines.length && /^[\*\-]\s+/.test(lines[i])) {
        const li = document.createElement('li');
        appendInline(li, lines[i].replace(/^[\*\-]\s+/, ''));
        ul.appendChild(li);
        i++;
      }
      out.push(ul);
      continue;
    }
    // Blank line — skip.
    if (line.trim() === '') {
      i++;
      continue;
    }
    // Paragraph — gather consecutive non-blank, non-fenced, non-header
    // lines into one <p>. Single newlines inside the paragraph collapse
    // to spaces (CommonMark convention).
    const para = [];
    while (i < lines.length) {
      const ln = lines[i];
      if (
        ln.trim() === '' ||
        ln.startsWith('```') ||
        /^#{1,3}\s+/.test(ln) ||
        /^[\*\-]\s+/.test(ln) ||
        /^-{3,}\s*$/.test(ln)
      ) break;
      para.push(ln);
      i++;
    }
    const p = document.createElement('p');
    p.className = 'guide-p';
    appendInline(p, para.join(' '));
    out.push(p);
  }
  return out;
}

// Inline parser — handles **bold**, *italic*, `code`, [text](url) within
// a chunk of text. Renders into the given container as a series of text
// nodes + small elements. Order of operations matters for the regexes;
// we walk the string once with a single combined regex.
function appendInline(container, text) {
  // Combined token regex. Group 1: code, 2: bold, 3: italic, 4+5: link.
  const re = /`([^`]+)`|\*\*([^*]+)\*\*|\*([^*]+)\*|\[([^\]]+)\]\(([^)]+)\)/g;
  let last = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) container.appendChild(document.createTextNode(text.slice(last, m.index)));
    if (m[1] !== undefined) {
      const code = document.createElement('code');
      code.className = 'guide-inline-code';
      code.textContent = m[1];
      container.appendChild(code);
    } else if (m[2] !== undefined) {
      const b = document.createElement('strong');
      b.textContent = m[2];
      container.appendChild(b);
    } else if (m[3] !== undefined) {
      const it = document.createElement('em');
      it.textContent = m[3];
      container.appendChild(it);
    } else if (m[4] !== undefined && m[5] !== undefined) {
      const a = document.createElement('a');
      a.href = m[5];
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = m[4];
      container.appendChild(a);
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) container.appendChild(document.createTextNode(text.slice(last)));
}
