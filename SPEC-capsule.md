# SPEC-capsule

**Package:** `@gcu/capsule`
**Status:** Draft v0.1
**Editor:** Arthur Endlein Correia
**Last revised:** 2026-05-16

## Abstract

`@gcu/capsule` defines a fragment-based content addressing layer for browser-native tools. It specifies a grammar for capsule strings, an encoding for fragment-carried content, a set of resolution schemes for external content (GitHub, gist, Zenodo, rentry, generic CORS-open URLs), and an extension mechanism for additional schemes. The primary consumer is the Auditable shell, which uses it to open notebooks from any supported capsule type without requiring dedicated infrastructure. Other GCU shells (Arborist, Coreshed, GCU Works tools) may adopt it for equivalent use cases, and non-notebook consumers — QR-carried restaurant menus, doorbell ping pages, lost-and-found tags, conference reference cards — use the same resolver to ferry self-contained payloads through a static bootloader.

The spec is deliberately narrow. It is not a transport, not a storage system, not an authenticity or versioning system. It is a string-to-bytes resolver with a shared grammar, designed to run in a browser with no non-optional dependencies. Payload interpretation — what the resolved bytes *mean*, how renderers are selected, how multiple content types share a single bootloader — is a consumer concern, addressed by sibling specs such as `SPEC-cradle.md`.

---

## Part I — Protocol

### 1. Goals and non-goals

#### 1.1 Goals

- Share computational artifacts (typically text source files) by URL, with no server infrastructure beyond the static shell.
- Support both *inline* sharing (content carried in the URL fragment) and *reference* sharing (fragment points to CORS-open external content).
- Define a stable string grammar such that a given capsule means the same thing forever.
- Run entirely in a modern browser using native APIs (`fetch`, `TextEncoder`, `CompressionStream`, `atob`/`btoa`). No mandatory WASM, no mandatory npm dependencies at runtime.
- Be extensible: third-party shells may register additional schemes without modifying the core.

#### 1.2 Non-goals

- Not a transport protocol. Resolution is best-effort over HTTP; network reliability is the caller's problem.
- Not a storage system. Durability is inherited from whatever host the capsule references.
- Not an authenticity or integrity system. A layer above may verify content; this spec does not.
- Not a versioning system for the content itself. Reference schemes may carry version hints (`@ref`, `:version`) but this is host-specific, not part of the capsule semantics.
- Not a privacy layer. Fragments avoid server round-trips *for resolution*, but fragments routinely leak via clipboard, browser history, screenshots, and copy-paste. Treat fragment contents as public-adjacent.
- Not a type system or renderer dispatcher. Resolved bytes are opaque to `@gcu/capsule`. Consumers needing to multiplex multiple payload kinds over a single bootloader (e.g., menu, doorbell, lost-and-found tag, and notebook payloads through one `/c#…` endpoint) layer a type-tag convention on top of the bytes returned by `resolve`. See `SPEC-cradle.md` for the canonical such layer.

### 2. Terminology

- **Shell** — a hosted application that uses `@gcu/capsule` to load content. Examples: Auditable, Arborist viewer.
- **Content** — the bytes being shared. For Auditable, this is typically the `.txt` source form of a notebook, but the spec treats content as opaque.
- **Capsule** — a string of the form `scheme ":" body` identifying how to obtain content.
- **Fragment** — the `#...` portion of a URL. When a fragment carries a capsule, the shell reads it on load.
- **Loader** — code implementing the resolution of one scheme.
- **Dispatcher** — the glue that selects a loader based on capsule scheme.
- **Inline capsule** — a capsule whose scheme is `inline`, carrying content directly.
- **Reference capsule** — any non-`inline` scheme, resolving to external content.

The words *must*, *should*, *may*, *must not*, and *should not* in this document follow the conventional interpretation (RFC 2119). Normative statements are those in sections 3–10 and 17. All other sections are informative.

### 3. Capsule grammar

A capsule is a string. Its ABNF is:

```
capsule       = scheme ":" body
scheme        = 1*( ALPHA / DIGIT / "-" )
body          = *PCHAR
PCHAR         = unreserved / pct-encoded / sub-delims / ":" / "@" / "/" / "?"
unreserved    = ALPHA / DIGIT / "-" / "." / "_" / "~"
pct-encoded   = "%" HEXDIG HEXDIG
sub-delims    = "!" / "$" / "&" / "'" / "(" / ")" / "*" / "+" / "," / ";" / "="
```

Capsules are case-sensitive. Scheme names are lowercase by convention; the dispatcher matches schemes case-sensitively and does not perform normalization.

A capsule appearing in a URL fragment is not further encoded: the fragment body is the capsule body directly. However, if the capsule contains characters that cannot appear in a URL fragment (controls, spaces, and characters outside the fragment production in RFC 3986), those characters must be percent-encoded. Loaders that accept URL-bearing bodies (e.g., `url:`) should expect percent-encoded input and decode accordingly.

#### 3.1 Reserved schemes

The following schemes are reserved by this specification and have defined semantics in §6 and §7:

| scheme    | kind      | status   |
|-----------|-----------|----------|
| `inline`  | inline    | required |
| `i`       | inline    | required |
| `q`       | inline    | required |
| `url`     | reference | required |
| `gh`      | reference | required |
| `gist`    | reference | required |
| `zenodo`  | reference | required |
| `doi`     | reference | required |
| `rentry`  | reference | required |

"Required" means a conforming `@gcu/capsule` implementation MUST include a loader for the scheme. Shells consuming `@gcu/capsule` MAY disable individual loaders at integration time (§13).

Scheme names beginning with `x-` are reserved for experimental use and MUST NOT be used in public share URLs intended to persist.

#### 3.2 Non-reserved schemes

Any other scheme is available for third-party use via the registration mechanism in §11. Third-party schemes MUST NOT shadow reserved schemes. To avoid collisions, third-party schemes SHOULD be prefixed with an identifying namespace when used in public URLs: `acme-notebook:foo`, not `notebook:foo`.

### 4. Fragment layout

A share URL has the form:

```
<shell-url>#<capsule>
```

Where `<shell-url>` is the absolute URL of a shell (e.g., `https://gentropic.org/auditable`) and `<capsule>` is a well-formed capsule per §3.

No part of the fragment other than the capsule is defined by this spec. Shells MAY use additional fragment syntax (for example, query-string-style parameters after a separator) for shell-specific state such as scroll position or active cell, but those MUST NOT collide with capsule syntax and SHOULD use a distinct leading character (e.g., `#<capsule>?cell=3`).

#### 4.1 Version negotiation

This spec's fragment layout is implicitly version 0. Future versions MAY introduce a version prefix of the form `v<n>:` *before* the capsule:

```
<shell-url>#v1:<capsule>
```

A v0 (unversioned) parser MUST treat a `v<n>:` prefix with `n > 0` as an unknown scheme and fail gracefully (§10.3). A v1+ parser MUST accept unversioned fragments as v0.

This conservative rule lets the v0 grammar ship without reserving a version marker now, while keeping the future migration path open. The specific semantics of any post-v0 version are out of scope for this spec.

### 5. Resolution algorithm

Given a fragment string `f`, the dispatcher:

1. Strip a leading `#` if present.
2. If `f` is empty, return *no capsule*.
3. Split `f` into `scheme` and `body` at the first `:`. If there is no `:`, return an error (`ENOSCHEME`).
4. Look up the loader for `scheme` in the registry.
5. If no loader is registered, return an error (`EUNKNOWN`).
6. Call the loader with `body` and a resolution context (§8). The loader returns a promise of bytes or an error.
7. Return the loader's result to the caller.

The caller (the shell) is responsible for interpreting bytes as content. `@gcu/capsule` does not parse, validate, or transform content.

### 6. Inline form

The `inline:` scheme carries content directly in the capsule body.

```
inline-body   = codec ":" payload
codec         = "raw" / "deflate" / "brotli" / "deflate-dict" "." dict-id
payload       = base64url
dict-id       = 1*( ALPHA / DIGIT / "-" )
base64url     = 1*( ALPHA / DIGIT / "-" / "_" ) [ 1*2("=") ]
```

Padding characters (`=`) are OPTIONAL on decode and SHOULD be omitted on encode. Implementations MUST accept both padded and unpadded base64url on input.

#### 6.1 Codecs

`raw` — The payload is base64url-encoded content bytes. No compression. Intended for content small enough that compression offers no benefit, or for diagnostics.

`deflate` — The payload is base64url-encoded deflate-raw (RFC 1951, no zlib or gzip wrapper) of the content bytes. Implementations MUST use `deflate-raw` specifically, not `deflate` or `gzip`, to avoid header overhead. Browser-native `CompressionStream("deflate-raw")` and `DecompressionStream("deflate-raw")` produce and consume this format directly.

`brotli` — The payload is base64url-encoded brotli (RFC 7932) of the content bytes. Brotli typically achieves 15–25% smaller output than deflate on text-heavy content, at the cost of slower encoding and narrower browser support: `CompressionStream("brotli")` and `DecompressionStream("brotli")` shipped in Safari 18.4 (April 2025) and subsequently in other major browsers; implementations targeting older browsers must polyfill or omit this codec. Brotli is OPTIONAL to implement. A conforming implementation that omits it MUST reject `brotli` payloads with `EUNSUPPORTEDCODEC`. Encoders SHOULD prefer `deflate` for share URLs intended to work in any modern browser, and `brotli` only when the encoder knows the consumer supports it (e.g., the bootloader's own runtime constraints).

`deflate-dict.<dict-id>` — Like `deflate`, but the decompressor is pre-seeded with a named dictionary identified by `dict-id`. Dictionary registration is implementation-defined; see §12. The dictionary used for decompression MUST be byte-identical to the one used for compression, or the content will decode incorrectly.

No other codecs are defined by this spec. Future codecs MAY be added via versioned specs (§4.1).

#### 6.2 Size considerations

Inline capsules are constrained by the URL length limits of the channel through which the share URL travels. Appendix C gives practical limits. Implementations generating inline capsules SHOULD estimate the encoded size against the target channel and warn or switch to a reference scheme if the result would exceed the channel's safe limit.

#### 6.3 Compact inline form (`i:` scheme)

The `i:` scheme is a space-efficient alias for `inline:`, intended for transmission channels with tight byte budgets such as QR codes. It expresses the same semantics with shorter framing.

```
i-body        = codec-char payload
codec-char    = "r" / "d" / "b"
payload       = base64url
```

The codec character maps to a long-form codec name:

| char | codec     | required to implement |
|------|-----------|-----------------------|
| `r`  | `raw`     | yes                   |
| `d`  | `deflate` | yes                   |
| `b`  | `brotli`  | no (per §6.1)         |

Codec characters not in this table are reserved for future use; implementations MUST reject unknown codec characters with `EUNSUPPORTEDCODEC`. The compact form does not express dictionary codecs (`deflate-dict.*`); content requiring a dictionary MUST use the long form.

The compact and long forms are semantically equivalent. `i:d<P>` MUST decode to the same bytes as `inline:deflate:<P>` given the same payload `P`. Implementations MUST accept both forms and MAY produce either; encoders targeting QR codes or other tight channels SHOULD prefer the compact form. The overhead reduction is 12 bytes per capsule (`inline:deflate:` vs `i:d`), which on typical text content at ~3× deflate ratio recovers roughly 36 bytes of source.

Examples:

```
i:r aGVsbG8gd29ybGQK
i:d K8lIVShKLS7JzEtXKE9VyMlPzy9SSCwoTlVIy0xNyUjNS9HLSc0tSS3SU0gCiuUnpuSl6OUpaFSz8nNL8nNTQfWlSgA
```

(The space after `r` / `d` is shown only for clarity in this document; the actual capsule concatenates the codec character directly with the base64url payload.)

#### 6.4 QR-optimized form (`q:` scheme)

The `q:` scheme is a third inline form, optimized specifically for QR codes by using base45 encoding (RFC 9285) rather than base64url. The improvement is substantial: base64url in QR byte mode costs 10.67 bits per encoded byte, while base45 in QR alphanumeric mode costs 8.31 bits per encoded byte — a **~22% reduction** in QR bit cost for the same payload. This is often the difference between a v15 QR (scans casually from a phone) and a v20+ QR (requires deliberate aim). For QR-bound content the savings compound across scan reliability, sticker size, and printability.

The `q:` scheme also supports dictionary-keyed deflate, which the `i:` scheme does not. Dictionaries dramatically reduce the encoded size of domain-specific content (menus, recipes, schedules) where the dictionary captures the format's common vocabulary.

```
q-body        = codec-spec payload
codec-spec    = codec-char [ "." dict-id "_" ]
codec-char    = "r" / "d" / "b"
dict-id       = 1*( ALPHA / DIGIT / "-" )
payload       = base45
```

The codec character maps as in §6.3:

| char | codec     | required to implement |
|------|-----------|-----------------------|
| `r`  | `raw`     | yes                   |
| `d`  | `deflate` | yes                   |
| `b`  | `brotli`  | no (per §6.1)         |

If the codec character is followed by `.<dict-id>_`, the deflate (or brotli) decompressor is pre-seeded with the dictionary identified by `dict-id`. The terminating underscore (`_`) is mandatory because `_` is not in the base45 alphabet and cannot occur in `dict-id` per the convention in §12.1; this unambiguously marks the boundary between framing and base45 payload. The brotli codec MAY accept `dict-id` once browsers expose dictionary support in `CompressionStream("brotli")`; until then, dictionary support is effectively `deflate`-only.

Examples:

```
q:r AAQEM4VLC                                        ; raw, base45-encoded
q:d 8N9C7%S7%RKUU8.S96$C%6FT2YK*K0EP-DAL3FNCF8L      ; deflate, base45
q:d.menu-ptbr_ +T3FOG7P-LJ6IFKM2X4VK9PD              ; deflate-dict.menu-ptbr, base45
```

(Spaces shown for readability; actual capsules concatenate without spaces.)

##### 6.4.1 Carrying a `q:` capsule in a URL fragment

The base45 alphabet (`0-9 A-Z space $ % * + - . / :`) contains **two** characters that are not legal in a URL fragment: the **space** and the **percent sign** (`%`). The space is not in the RFC 3986 fragment production at all; the `%` is legal *only* as the leader of a `%HH` percent-encoded triplet, so a literal `%` in a payload is ambiguous with percent-encoding. Every other base45 character (`$ * + - . / :` and alphanumerics) is fragment-legal and MUST NOT be altered. (Earlier drafts addressed only the space; the `%` case is normative as of this revision.)

When a `q:` capsule is placed in a URL fragment, an encoder MUST escape exactly these two characters, and a decoder MUST reverse exactly this escaping:

- escape `%` → `%25` **first**, then space → `%20` (the order matters: escaping space first would re-escape the `%` it introduces);
- decode with a **single left-to-right pass** that recognizes the two triplets `%25` → `%` and `%20` → space and copies every other character verbatim. A decoder MUST NOT use repeated global string replacement, and MUST NOT apply a general `decodeURIComponent`-style decode — either would corrupt a literal `%20` already present in the raw payload (which encodes to `%2520` and must round-trip back to `%20`, not to a space), and the latter would also mangle the fragment-legal `+`, `$`, `*`, `/` characters.

This escaping applies only to the URL-fragment transport. The capsule body itself (what a `resolve` implementation receives, and the bytes a QR encodes in alphanumeric mode) is the raw base45 with no escaping. A QR encoder MAY emit the raw base45 (including the literal space) directly in an alphanumeric segment; the escaping is required only where the capsule travels as URL text. `i:` and `inline:` (base64url) payloads contain neither character, so this transform is a no-op for them and MAY be applied uniformly to any capsule.

`q:` is semantically related to `i:` and the long-form `inline:` but is NOT byte-equivalent: the base encoding differs. The same content produces three valid capsules — `inline:deflate:<base64url>`, `i:d<base64url>`, `q:d<base45>` — that all decode to the same bytes. Encoders SHOULD prefer:

- `inline:` (long form) for human-readable share URLs, READMEs, documentation
- `i:` (compact form) for non-QR space-constrained channels (Twitter, Slack, short URLs)
- `q:` (QR form) when the share target is a QR code

Note that `q:` is the only inline form that supports `deflate-dict.*` in its compact grammar. If `i:` callers need dictionary support, they should use the long form `inline:deflate-dict.<dict-id>:<base64url>`.

### 7. Reference forms

Reference schemes resolve to content hosted elsewhere on the web. Each loader performs an HTTPS `fetch` for one or more URLs derived from the capsule body. All reserved reference schemes target hosts that return CORS `Access-Control-Allow-Origin: *` (or equivalent) as of the publication date of this spec; see Appendix A.

#### 7.1 `url:` — generic URL

```
url-body      = urlencoded-absolute-url
```

The body is a percent-encoded absolute HTTPS URL. The loader decodes the body and fetches the URL. This is the escape hatch for content hosted on any CORS-open server not covered by a named scheme.

Non-HTTPS schemes (`http:`, `file:`, etc.) MUST be rejected. The loader MUST NOT follow redirects that downgrade from HTTPS to HTTP.

Example:
```
url:https%3A%2F%2Fexample.cloudflarepages.dev%2Fnotebook.txt
```

Implementations MAY apply additional hostname restrictions (denylist or allowlist) at the integration layer.

#### 7.2 `gh:` — GitHub repository file

```
gh-body       = owner "/" repo [ "@" ref ] ":" path
```

- `owner` — GitHub user or organization
- `repo` — repository name
- `ref` — branch name, tag, or commit SHA; defaults to `HEAD` if omitted
- `path` — path to file within the repo

The loader fetches via either `raw.githubusercontent.com` or `cdn.jsdelivr.net/gh/...`. The default choice is the jsDelivr CDN for its stability and caching behavior; the loader MAY be configured at dispatcher construction to prefer the raw endpoint (§8.1).

Examples:
```
gh:endarthur/auditable@main:examples/regression.txt
gh:endarthur/auditable@a61399ed:examples/regression.txt
```

SHA pinning is RECOMMENDED for share URLs intended to persist, because branch capsules and tag names can be rewritten in ways that silently change the content a share URL resolves to.

#### 7.3 `gist:` — GitHub gist

```
gist-body     = id [ ":" file ]
id            = 1*HEXDIG
file          = 1*PCHAR
```

The loader fetches `https://api.github.com/gists/<id>` and returns either:

- the content of the named `file`, if `file` is provided and exists in the gist;
- the content of the first file whose name ends in a shell-supplied default extension, if `file` is omitted and a default is configured;
- the content of the first file in the gist otherwise.

If the gist API response indicates the file is truncated (`truncated: true`), the loader MUST fall back to fetching the file's `raw_url`.

Example:
```
gist:aa5a9e3f4fbc938ccf84fb5bfadd2b0d
gist:aa5a9e3f4fbc938ccf84fb5bfadd2b0d:experiment.txt
```

#### 7.4 `zenodo:` — Zenodo record

```
zenodo-body   = record-id [ ":" file ]
record-id     = 1*DIGIT
file          = 1*PCHAR
```

The loader fetches `https://zenodo.org/api/records/<record-id>` and then fetches the content of the specified file via that record's file-content endpoint (`https://zenodo.org/api/records/<id>/files/<file>/content`). Selection of the file when `file` is omitted follows the same rules as §7.3.

Zenodo supports both *concept DOIs* (which resolve to the latest version of a record) and *version DOIs* (which pin a specific deposit). When a capsule uses `zenodo:<record-id>`, the record ID may correspond to either; this is a property of how the record was deposited and is not encoded in the capsule. Callers concerned with pinning MUST use version-specific record IDs.

Example:
```
zenodo:8389279
zenodo:8389279:methods.txt
```

#### 7.5 `doi:` — DOI

```
doi-body      = doi-name [ "#" file ]
doi-name      = prefix "/" suffix
prefix        = "10." 1*DIGIT
suffix        = 1*PCHAR
```

The loader resolves the DOI via `https://doi.org/<doi-name>`, which returns an HTTP redirect to the hosting system. The loader follows the redirect and applies the appropriate downstream loader if the target host is recognized (currently Zenodo). For unrecognized hosts, the loader fails with `EUNSUPPORTEDDOI` and the caller may retry with `url:` if they know the host is CORS-open.

The `#file` suffix (note: `#` inside the capsule body, not a second URL fragment) is passed to the downstream loader as its file selector.

Example:
```
doi:10.5281/zenodo.8389279
doi:10.5281/zenodo.8389279#methods.txt
```

The DOI scheme is primarily intended for citation-shaped share URLs in academic contexts. For most use cases, resolving to Zenodo with `zenodo:` directly is equivalent and avoids the extra redirect hop.

#### 7.6 `rentry:` — rentry.co paste

```
rentry-body   = paste-id
paste-id      = 1*( ALPHA / DIGIT / "-" / "_" )
```

The loader fetches `https://rentry.co/<paste-id>/raw`.

Example:
```
rentry:my-notebook-x7
```

Rentry pastes are public. Implementations generating `rentry:` capsules SHOULD communicate this plainly to the user at the point of publication (§14).

### 8. Loader interface

A loader is an async function with the signature:

```ts
type Loader = (body: string, ctx: ResolutionContext) => Promise<Uint8Array>;
```

#### 8.1 Resolution context

```ts
interface ResolutionContext {
  // The origin the shell is running at. Loaders may use this to choose
  // between equivalent endpoints based on which ones are known to serve
  // the shell's origin.
  origin: string;

  // Per-loader options supplied at dispatcher construction time. Keyed by
  // scheme name. Opaque to the dispatcher.
  options: Record<string, unknown>;

  // A function loaders MAY call to delegate a different capsule through
  // the dispatcher. Used by `doi:` to hand off to `zenodo:` after the
  // DOI redirect resolves.
  resolve(capsule: string): Promise<Uint8Array>;

  // An AbortSignal for cancellation. Loaders SHOULD forward it to fetch.
  signal?: AbortSignal;
}
```

The `options` bag carries loader-specific configuration. For example, `{ gh: { endpoint: "raw" } }` selects the raw.githubusercontent.com endpoint for the `gh:` loader in preference to jsDelivr.

#### 8.2 Errors

Loaders MUST reject the returned promise with an error on any failure. The error `message` SHOULD begin with a short stable identifier (e.g., `EFETCH`, `ENOTFOUND`, `ETRUNCATED`) to allow shells to render informative UI. Suggested identifiers:

- `ENOSCHEME` — capsule did not contain a `:`
- `EUNKNOWN` — no loader registered for scheme
- `EFETCH` — network error
- `EHTTP:<status>` — HTTP error (e.g., `EHTTP:404`)
- `ENOTFOUND` — target resolved but file/record not found
- `EUNSUPPORTEDDOI` — DOI resolved to an unrecognized host
- `ETOOLARGE` — content exceeds a configured size limit
- `EDECODE` — content bytes could not be decoded per the codec
- `EUNSUPPORTEDCODEC` — inline codec is not implemented

Loaders MUST NOT throw synchronously except on programmer errors (bad argument types); all operational failures must surface as rejected promises.

#### 8.3 Caching

Loaders MAY implement in-memory caching keyed on the capsule body. Cached entries SHOULD respect standard HTTP caching semantics returned by the target; in particular, responses with `Cache-Control: no-store` MUST NOT be cached.

Cache lifetimes, eviction policy, and persistence across page loads are implementation-defined and out of scope for this spec.

### 9. Dispatcher

The dispatcher is the glue between the fragment and the loaders.

```ts
interface Dispatcher {
  register(scheme: string, loader: Loader): void;
  unregister(scheme: string): void;
  resolve(capsule: string, ctx?: Partial<ResolutionContext>): Promise<Uint8Array>;
}
```

`register` MUST overwrite any previously registered loader for the same scheme. This is intentional: it allows shells to supply a customized loader (e.g., a `gh:` loader that authenticates with a PAT for private repos) without forking the core.

`unregister` removes a loader; subsequent `resolve` calls for that scheme fail with `EUNKNOWN`.

`resolve` is the main entry point. It splits the capsule per §5, looks up the loader, constructs a full resolution context by merging supplied overrides with defaults (including a `resolve` back-reference for nested delegation), and invokes the loader.

A conforming `@gcu/capsule` package MUST export a function `createDispatcher(options?)` that returns a `Dispatcher` pre-registered with all required loaders (§3.1). Individual loaders MUST also be exported for standalone use and for tree-shaking by shells that want only a subset.

### 10. Encoding

This section describes the wire representation of inline capsules. Reference capsules have no additional encoding beyond the scheme-specific grammar in §7.

#### 10.1 Encoding inline content

To encode content `C` (bytes) with codec `deflate`:

1. Compress: `D = deflate-raw(C)`.
2. Base64url: `P = base64url-encode(D)` with no padding.
3. Construct capsule: `inline:deflate:<P>`.

Browser-native implementation:

```js
async function encodeInline(content) {
  const stream = new Blob([content]).stream()
    .pipeThrough(new CompressionStream("deflate-raw"));
  const compressed = new Uint8Array(await new Response(stream).arrayBuffer());
  const b64 = btoa(String.fromCharCode(...compressed))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `inline:deflate:${b64}`;
}
```

#### 10.2 Decoding inline content

To decode `inline:deflate:<P>`:

1. Base64url decode: `D = base64url-decode(P)`. Accept padded or unpadded input.
2. Inflate: `C = inflate-raw(D)`.
3. Return `C`.

Browser-native implementation:

```js
async function decodeInline(capsule) {
  const [, codec, payload] = capsule.match(/^inline:([^:]+):(.+)$/);
  if (codec !== "deflate") throw new Error("EUNSUPPORTEDCODEC");
  const b64 = payload.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4 ? b64 + "=".repeat(4 - (b64.length % 4)) : b64;
  const bytes = Uint8Array.from(atob(pad), c => c.charCodeAt(0));
  const stream = new Blob([bytes]).stream()
    .pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
```

#### 10.3 Fail-open behavior

Unknown schemes, unknown codecs, and malformed payloads MUST cause the dispatcher to reject with a classified error (§8.2). The shell handling that rejection MAY:

- initialize with empty content (the default for a shell with no fragment);
- surface an error to the user with the capsule string preserved so they can forward it to someone with a newer shell;
- attempt a fallback resolution (e.g., show a "try in updated shell" link).

Shells MUST NOT silently swallow capsule errors. A share URL that doesn't work is a worse user experience than a share URL that fails visibly.

### 11. Extensibility

Third-party loaders are registered via `Dispatcher.register`. A package defining a new loader SHOULD:

- Export the loader as a named export (`export const acmeLoader: Loader = ...`).
- Document the scheme name it expects to be registered under.
- Use a namespaced scheme name (e.g., `acme-notebook:`) for public URLs, reserving short single-word scheme names for `@gcu/capsule` itself and well-known public infrastructure.
- Clearly document any additional CORS requirements, authentication, or rate limits.

Shells MAY curate which loaders are enabled. A shell that declines to register `rentry:`, for example, will fail `EUNKNOWN` on rentry capsules; this is intentional and allows shells to constrain their own attack surface and reduce dependency on external services they do not wish to depend on.

### 12. Dictionaries

The `deflate-dict.<dict-id>` codec uses a pre-seeded dictionary for deflate. This improves compression ratio for content with high similarity to the dictionary, typically 30–50% over plain `deflate` on domain-specific content where the dictionary captures common vocabulary, structural framing, or directive keywords.

This spec does not define any standard dictionaries. A shell wishing to use dictionary compression MUST:

- Choose a `dict-id` identifying the dictionary content. The `dict-id` is opaque to `@gcu/capsule`; it is interpreted by the shell or consumer (e.g., `@gcu/cradle`) which maintains the dictionary registry.
- Ensure both encoder and decoder have access to byte-identical dictionary bytes.
- Ship the dictionary alongside the shell, or reference a stable public URL for it, such that decode is possible anywhere the shell runs.

Native `CompressionStream` and `DecompressionStream` currently do not expose a dictionary option in any shipping browser. Implementations supporting `deflate-dict.*` MUST therefore polyfill the dictionary path, typically via [pako](https://github.com/nodeca/pako) which exposes `inflateRaw(bytes, { dictionary: dictBytes })` and equivalent for deflate. The reference implementation pulls pako from a CDN; self-contained deploys may inline it.

Implementations MAY omit the `deflate-dict.*` codec entirely; a conforming implementation that omits it MUST reject such capsules with `EUNSUPPORTEDCODEC`. Implementations that target QR-bound content with locale-keyed dictionaries (the canonical case being `@gcu/cradle` menu payloads) SHOULD implement it.

When native browsers expose dictionary support in `CompressionStream` (the proposal is active in WICG), implementations SHOULD migrate to the native path and drop the polyfill.

#### 12.1 Dictionary identifier conventions

`dict-id` strings have no normative format, but the following conventions SHOULD be followed for interoperability:

- ASCII letters, digits, and `-` only. No `.` (used as the codec delimiter) and no `_` (reserved as a payload delimiter in the `q:` scheme, §6.4).
- Two-component form `<consumer>-<variant>` where `consumer` identifies the using project (`menu`, `recipe`, `schedule`, ...) and `variant` distinguishes sub-cases (`ptbr`, `enus`, `v2`, ...).
- Examples: `menu-ptbr`, `menu-enus`, `recipe-base`, `schedule-en`.

Consumers documenting registered dictionaries SHOULD list them in their own spec (e.g., `SPEC-menu.md`'s appendix), not here.

---

## Part II — Reference implementation

### 13. Package shape

The `@gcu/capsule` npm package has the following exports:

```
@gcu/capsule                -> createDispatcher, resolve (convenience),
                               encodeInline, decodeInline,
                               Dispatcher, Loader, ResolutionContext types
@gcu/capsule/loaders/inline -> inlineLoader
@gcu/capsule/loaders/url    -> urlLoader
@gcu/capsule/loaders/gh     -> ghLoader
@gcu/capsule/loaders/gist   -> gistLoader
@gcu/capsule/loaders/zenodo -> zenodoLoader
@gcu/capsule/loaders/doi    -> doiLoader
@gcu/capsule/loaders/rentry -> rentryLoader
@gcu/capsule/bundled        -> single-file ES module of all of the above
```

The package MUST be zero-runtime-dependency. All code MUST work in modern browsers (2023+) without transpilation, using only native Web Platform APIs.

The total unminified size of `@gcu/capsule/bundled` SHOULD be under 20 KB. The spec expects a reference implementation to come in around 8–12 KB.

### 14. Share-side API (encoding content → capsules)

Generating capsules is the inverse operation to resolution. The package also exports a share API:

```ts
interface ShareOptions {
  // Target channel size budget, in bytes of encoded capsule. If the
  // inline form would exceed this, the result is a publish plan instead.
  budget?: number;
  // Preferred publish target, if inline does not fit.
  publishTo?: "rentry" | "gist" | null;
  // Optional dictionary for deflate-dict.* codec.
  dictionary?: { id: string; bytes: Uint8Array };
}

type ShareResult =
  | { kind: "inline"; capsule: string; size: number }
  | { kind: "publish-plan"; target: string; reason: string; estimatedSize: number };

function makeShare(content: Uint8Array, opts?: ShareOptions): Promise<ShareResult>;
```

`makeShare` encodes `content` with the `deflate` codec, measures the result, and either returns an inline capsule or a plan for the caller to fulfill (e.g., by POSTing to rentry). The plan-based approach keeps the actual publish side-effect out of `@gcu/capsule` — the package never performs writes, only reads.

Writes (e.g., rentry POST, gist creation) are left to the shell or to companion packages (`@gcu/capsule-publish`, if it ever exists).

### 15. Badge protocol

A badge is a small SVG image intended to be embedded in READMEs, posted in tickets, or pasted into documentation, serving as a one-click "open in <shell>" affordance.

The badge URL scheme is purely a shell convention — `@gcu/capsule` does not host badges. The recommended pattern is:

```
[![Open in <Shell>](<badge-svg-url>)](<shell-url>#<capsule>)
```

Where `<badge-svg-url>` is a stable, CDN-cached URL. For Auditable specifically, the RECOMMENDED hosting is via an npm-published SVG asset served from jsDelivr:

```
https://cdn.jsdelivr.net/npm/<package>@<version>/badge.svg
```

This ensures the badge itself is immutably versioned and globally CDN-cached. Updating the badge design requires a package version bump; existing badges in existing READMEs remain valid at the pinned version they reference.

The badge SVG SHOULD:

- Be under 2 KB gzipped
- Render clearly at 20–28 px height
- Use the shell's typography and colors (for Auditable: Barlow, Switchboard accent system)
- Not depend on external font imports or remote CSS

### 16. Reference implementation sketch

The complete minimal dispatcher is under 150 lines. A sketch:

```ts
// @gcu/capsule/src/dispatcher.ts
export function createDispatcher(init: DispatcherOptions = {}): Dispatcher {
  const loaders = new Map<string, Loader>();
  const baseCtx = { origin: init.origin ?? location.origin, options: init.options ?? {} };

  const resolve: Dispatcher["resolve"] = async (capsule, ctxOverride = {}) => {
    const trimmed = capsule.startsWith("#") ? capsule.slice(1) : capsule;
    const idx = trimmed.indexOf(":");
    if (idx < 0) throw new Error("ENOSCHEME");
    const scheme = trimmed.slice(0, idx);
    const body = trimmed.slice(idx + 1);
    const loader = loaders.get(scheme);
    if (!loader) throw new Error("EUNKNOWN");
    const ctx: ResolutionContext = {
      ...baseCtx, ...ctxOverride,
      resolve: (p) => resolve(p, ctxOverride),
    };
    return loader(body, ctx);
  };

  const dispatcher: Dispatcher = {
    register: (scheme, loader) => void loaders.set(scheme, loader),
    unregister: (scheme) => void loaders.delete(scheme),
    resolve,
  };

  // Default registrations
  dispatcher.register("inline", inlineLoader);
  dispatcher.register("i", inlineLoader);
  dispatcher.register("q", qLoader);
  dispatcher.register("url", urlLoader);
  dispatcher.register("gh", ghLoader);
  dispatcher.register("gist", gistLoader);
  dispatcher.register("zenodo", zenodoLoader);
  dispatcher.register("doi", doiLoader);
  dispatcher.register("rentry", rentryLoader);

  return dispatcher;
}
```

Individual loaders are similarly small. `rentryLoader` is essentially one `fetch`; `gistLoader` is two. The `ghLoader` is perhaps the most complex at around 30 lines, because it chooses between jsDelivr and raw endpoints.

### 17. Conformance

A conforming implementation of `@gcu/capsule`:

- MUST provide `createDispatcher` exporting a `Dispatcher` as defined in §9.
- MUST register the loaders listed in §3.1 by default (including `inline`, `i`, and `q`).
- MUST implement the `inline:raw` and `inline:deflate` codecs, and their compact-form equivalents `i:r`, `i:d`, `q:r`, `q:d`.
- MUST treat `inline:`, `i:`, and `q:` as semantically equivalent: a payload encoded in one form MUST decode identically when re-expressed in another, modulo the difference in base alphabet.
- MAY implement the `inline:brotli` / `i:b` / `q:b` codec.
- SHOULD implement `inline:deflate-dict.*` and `q:d.<dict-id>_*` codecs if the implementation is intended for use with `@gcu/cradle` or other consumers using dictionary-keyed content.
- MUST reject unknown codecs and unknown compact-form codec characters with `EUNSUPPORTEDCODEC`.
- MUST handle the error classification in §8.2.
- MUST NOT perform writes (publish side effects) from a loader.
- MUST be implementable with at most one runtime dependency (pako, for `deflate-dict.*` support) on a modern browser. Implementations omitting dictionary support are zero-dependency.

---

## Part III — Shell integration

The remainder of the spec is informative. It describes how a shell (Auditable in the primary example) integrates `@gcu/capsule`, and gives guidance on UX for share generation.

### 18. Hydration lifecycle

A shell that loads content from a fragment follows this rough lifecycle:

1. **Boot.** The shell HTML loads. Runtime is initialized but no user content is yet rendered.
2. **Fragment inspection.** The shell reads `location.hash`. If non-empty, it calls `dispatcher.resolve(location.hash)`.
3. **Pre-hydration UI.** The shell displays a loading indicator while resolution is in flight. For inline capsules this is typically under 50 ms; for reference capsules it depends on the target host and may be multiple seconds.
4. **Hydration.** On successful resolution, the shell parses the bytes as content and initializes its editor state from them.
5. **Post-hydration.** The shell becomes interactive. By default the hydrated content is editable. The shell MAY choose to show provenance information (which capsule was loaded) in its UI.
6. **Error handling.** On failed resolution, the shell displays a classified error (§8.2) and falls back to an empty editor.

Shells SHOULD preserve the original fragment in the URL after hydration, so that the page can be bookmarked or shared onward. Modifying the fragment on user edits is optional and shell-specific (§19).

### 19. Edit state and history

Once hydrated content becomes editable, the question arises: what happens to the fragment?

Two reasonable policies:

**Policy A — Sticky source.** The fragment is never modified post-hydration. The URL continues to point to the original source. User edits exist only in the shell's in-memory state and are lost on reload. Re-sharing requires explicit re-publication through the share UI.

**Policy B — Live fragment.** The fragment is updated on every edit to an inline form representing the current editor state. The URL becomes self-describing; reload preserves edits. Practical only for small notebooks (inline form fits the channel budget).

Auditable SHOULD default to Policy A for reference capsules (where live update would constantly rewrite a `gh:`/`gist:` capsule into an `inline:` one, silently destroying the original attribution) and MAY offer Policy B as a setting for inline-loaded sessions.

Shells MUST NOT modify the fragment of a reference capsule to a different reference capsule without explicit user action. The provenance of a share URL is part of its contract with the user.

### 20. Share-modal UX

A shell generating share URLs SHOULD present a ladder of options, each more durable and more public than the last:

1. **Inline link** — fragment-carried. Private-adjacent (does not round-trip to a server for resolution). Size-limited by the channel.
2. **Publish to rentry** — public, durable, anonymous. No account needed. Must be labeled *public* in the UI at the moment of publication.
3. **Publish to gist** — public, versioned, requires GitHub auth. Better for content under iteration.
4. **Point to an existing repo file** — generate a `gh:` capsule to content the user has already committed elsewhere.
5. **Cite by DOI** — for content already deposited in Zenodo or equivalent. Generate a `doi:` capsule.

Each tier adds a property without invalidating the previous: public ← versioned ← cited. Share UIs SHOULD let the user move up the ladder without re-deriving the content; the content bytes are the same across tiers.

#### 20.1 Size indicator

For the inline tier, the share UI SHOULD show a live size estimate and an indicator of which channels the resulting URL fits in. A concrete proposal (informative):

```
[ inline link  ~2.4 KB  ✓ Twitter  ✓ Slack unfurl  ✓ QR v20  ✗ QR v15 ]
```

This makes the tradeoff legible. When the user's content grows past the inline-tier limit, the UI SHOULD automatically offer the next tier rather than silently producing a link that fails in some channels.

#### 20.2 Labeling publish tiers

Any publish operation (rentry, gist) is a state change visible to third parties. The UI MUST label it as such before the user commits, in language stronger than "save" or "share":

> Publishing to rentry.co will make this notebook **publicly readable** to anyone with the link. Rentry is a free, anonymous service run by volunteers — consider donating if you find it useful.

The exact wording is the shell's choice, but the essential components are: (a) the word *public*, (b) the name of the host, and (c) the action being irreversible in the sense that "unpublish" is a best-effort removal, not a recall.

### 21. Encryption (deferred, non-normative)

Encrypted content is out of scope for the initial spec. This section describes how encryption *would* integrate, so that the v0 grammar doesn't paint the design into a corner.

#### 21.1 Threat model sketch

Encryption protects against readers *of the capsule target* who do not have the key. It does not protect against readers who have the full share URL plus the key.

The typical case is: Alice wants to share an encrypted notebook with Bob via a link. Alice deposits ciphertext to a public host (rentry, gist). Alice generates a key and sends Bob the share URL, which carries the capsule (to ciphertext) plus the key (in fragment). Bob's browser fetches ciphertext, decrypts locally, hydrates. The server never sees plaintext.

Variants:

- **Key-in-fragment, ciphertext external.** Fragment = `v1:enc:<key>:<capsule-to-ciphertext>`. Ciphertext lives at a reference URL. Key lives in fragment, which is not server-logged.
- **Inline ciphertext, key-in-fragment.** Fragment = `v1:enc:<key>:<inline-ciphertext-capsule>`. Entirely self-contained. Useful when the caller wants zero external dependencies.
- **Key-wrapped by WebAuthn PRF.** The fragment carries a key wrapped by a per-device WebAuthn PRF output. Only someone with the registered authenticator can unwrap. Content is bound to a specific device or hardware key. Strong variant; requires prior authenticator enrollment.

#### 21.2 Fragment shape

A versioned-fragment `v1:enc:...` grammar is one way to introduce encryption without disturbing v0. Another is a new scheme `enc:` that wraps an inner capsule:

```
enc:<key-material>:<wrapped-capsule>
```

Where the loader decrypts the inner capsule's bytes after resolution. The `enc:` form is simpler but less structured; the `v1:enc:` form allows fuller key-agreement semantics.

Choice is deferred to the encryption spec (whenever it's written). The v0 grammar in §3 explicitly reserves the behavior that a capsule scheme `enc` is allocatable for this purpose.

#### 21.3 What v0 gets right for future encryption

- Fragment is the key-carrying channel: fragments are not server-logged, so a key in the fragment is not leaked to the capsule target.
- Loaders return bytes, not parsed content: an encryption layer can wrap any loader without the loader knowing about it.
- Dispatcher delegation (`ctx.resolve`): an `enc:` loader can resolve the inner capsule through the dispatcher, fetching ciphertext bytes, then decrypt and return plaintext bytes.

These three properties mean the current design is compatible with the likely encryption extensions. No changes to v0 are required.

#### 21.4 Worked example: anyone-can-send, only-owner-can-read

A complementary threat model to §21.1 arises when the *receiver* knows the key but the *sender* may be anyone. The motivating case is a QR-coded "ping me" or "leave a message" affordance attached to a physical object — a doorbell QR sticker, a lost-and-found tag on a bag, an anonymous feedback box at a workshop. The owner publishes a public key; senders use it to encrypt a short message that only the owner can read; the encrypted payload travels over an untrusted relay (e.g., ntfy.sh).

A natural envelope is libsodium's *sealed box* (`crypto_box_seal`), which provides anonymous public-key encryption: the sender does not need a long-term key, only the receiver's public key. The fragment of the bootloader URL carries the receiver's public key as configuration data (alongside the relay topic and any UI labels), not as a capsule per §3. The bootloader assembles the ciphertext and publishes it; the receiver's subscriber decrypts.

This is not strictly a `@gcu/capsule` concern — `capsule` resolves bytes; it does not transmit them, and the relay is wholly outside the resolver. But the design properties listed in §21.3 carry over: the fragment-as-non-server-logged-channel argument applies to public keys as to symmetric keys, and the bootloader is the natural assembly point. The encryption spec, when written, will define a normative envelope and a place for it in the capsule grammar; this section affirms that the current grammar accommodates such a use case without restructuring.

### 22. Security considerations

#### 22.1 Fragment privacy caveats

Fragments are not transmitted in HTTP requests, but they are:

- stored in browser history
- visible in the address bar
- copied to the clipboard when the user shares the URL
- embedded in screenshots and in URL-preview scrapers (some scrapers fetch the page and capture the resulting DOM, which may render fragment content)
- sent to the page via `history.state` and `location.hash`, and from there into JS that may exfiltrate them

A capsule in a fragment is therefore *not secret*. Treat fragment contents as public-adjacent. Encryption (§21) is the mechanism for actual secrecy.

#### 22.2 Malicious content

`@gcu/capsule` returns bytes. What the shell does with those bytes is the shell's responsibility. For Auditable specifically, the content may contain executable code (js cells, adder cells) that runs in the shell's origin with full access to shell APIs. Hydrating from an arbitrary capsule is equivalent in trust terms to opening a notebook file sent by an untrusted party.

Shells SHOULD display the capsule's provenance prominently (host, path) during pre-hydration, especially for reference capsules, and SHOULD provide the user a chance to inspect before executing.

Shells MAY sandbox untrusted hydration (iframe, Web Worker) depending on their use case. This is entirely outside `@gcu/capsule`'s concern.

#### 22.3 SSRF and host abuse

Browser `fetch` is subject to the same-origin policy and CORS. A malicious capsule cannot trigger requests to hosts that don't opt into CORS. This constrains what a hostile share URL can exfiltrate: at most, requests to CORS-open public hosts, none of which carry the user's cookies (since all fetches are cross-origin and credentialless by default in `@gcu/capsule` loaders).

Loaders MUST NOT opt into credentialed cross-origin fetches (`credentials: "include"`). They SHOULD use the default `credentials: "same-origin"` which degrades to anonymous for cross-origin requests.

Timing attacks against the fact that a capsule loaded successfully vs. failed are possible in theory (the attacker knows the user opened a share link because the attacker's server observes a fetch). In practice this only leaks which reference capsule was opened, which is visible in browser history anyway.

#### 22.4 Rate limit exhaustion

A malicious share URL could cause many fetches against a single third-party host. This is a denial-of-service against the host, not against the user. `@gcu/capsule` does not attempt to rate-limit at the client; hosts are expected to handle this themselves (GitHub API has rate limits, Zenodo has rate limits, etc.).

Shells that embed `@gcu/capsule` as a library (e.g., bulk notebook importers) SHOULD implement polite-crawling conventions against the reference hosts: serial rather than parallel requests when iterating, backoff on 429 responses, etc.

### 23. Interoperability with existing share flows

#### 23.1 Relationship to Colab, Binder, Observable, CodeSandbox

The badge + fragment pattern in this spec is deliberately similar to those used by Colab (`colab.research.google.com/github/...`), Binder (`mybinder.org/v2/gh/...`), Observable (`observablehq.com/d/...`), and CodeSandbox (`githubbox.com/...`). The key difference is that this spec is:

- **Shell-agnostic** — not tied to one hosted service
- **Host-agnostic** — the capsule namespace is not coupled to any one source host
- **Fragment-centered** — default privacy is higher because resolution doesn't require a server round-trip

It's explicitly valid (and RECOMMENDED) for Auditable to support those services' URL conventions as additional named schemes (`colab:`, `binder:`, etc.) if there's demand. This spec does not reserve those names.

#### 23.2 GitHub Linguist registration

For Auditable's `.txt` source form, GitHub Linguist registration is tracked separately from this spec. If and when a dedicated extension for Auditable notebooks is registered (`.auditable`, `.adt`, or similar), this spec's grammar is unaffected; content is opaque to capsules.

---

## Appendices

### Appendix A — CORS test matrix

The following results were obtained via `HEAD` or `GET` requests with `Origin: https://example.com` against each endpoint on 2026-04-22. Results may drift over time; implementations SHOULD verify current behavior before depending on new endpoints.

| host | endpoint pattern | CORS | notes |
|------|------------------|------|-------|
| GitHub | `raw.githubusercontent.com/<user>/<repo>/<ref>/<path>` | `*` | unlimited in practice |
| GitHub Pages | `<user>.github.io/<repo>/<path>` | `*` | Pages CDN |
| GitHub gist raw | `gist.githubusercontent.com/<user>/<id>/raw[/<sha>/<file>]` | `*` | SHA-pinnable |
| GitHub gist API | `api.github.com/gists/<id>` | `*` | 60/hr anon, 5000/hr authed |
| jsDelivr gh | `cdn.jsdelivr.net/gh/<user>/<repo>@<ref>/<path>` | `*` | ref-pinnable |
| jsDelivr npm | `cdn.jsdelivr.net/npm/<pkg>@<ver>/<path>` | `*` | immutable versions |
| unpkg | `unpkg.com/<pkg>@<ver>/<path>` | `*` | occasionally flaky |
| esm.sh | `esm.sh/<pkg>[@<ver>]` | `*` | also transforms |
| Zenodo API | `zenodo.org/api/records/<id>` | `*` | 100/min anon |
| Zenodo file | `zenodo.org/api/records/<id>/files/<key>/content` | `*` | follows rate limits |
| DOI | `doi.org/<doi>` | echoes origin | returns redirect |
| Hugging Face | `huggingface.co/datasets/<d>/resolve/<ref>/<path>` | echoes origin | LFS-backed |
| Arweave gateway | `arweave.net/<txid>` | `*` | permanent if paid |
| IPFS public gw | `ipfs.io/ipfs/<cid>` | `*` | slow, unreliable if unpinned |
| rentry | `rentry.co/<id>/raw` | `*` | anonymous, free |
| dpaste | `dpaste.org/<id>` | `*` | anonymous |
| Cloudflare Pages | `*.pages.dev` (configured) | `*` | default static config |
| Vercel static | `*.vercel.app` (configured) | `*` | default static config |

The following hosts were confirmed to **not** send CORS headers and cannot be fetched from a browser as of the same date:

GitLab raw (repos and snippets), Codeberg raw, SourceHut blob, pastebin.com, 0x0.st, paste.rs, ix.io, Dropbox direct links, Google Drive public links.

### Appendix B — Full grammar

```
capsule       = scheme ":" body

scheme        = 1*( ALPHA / DIGIT / "-" )
body          = scheme-specific

; inline scheme (§6)
inline-body   = codec ":" payload
codec         = "raw" / "deflate" / "brotli" / "deflate-dict" "." dict-id
payload       = base64url
dict-id       = 1*( ALPHA / DIGIT / "-" )
base64url     = 1*( ALPHA / DIGIT / "-" / "_" ) [ 1*2("=") ]

; compact inline scheme (§6.3)
i-body        = codec-char payload
codec-char    = "r" / "d" / "b"

; QR-optimized inline scheme (§6.4)
q-body        = codec-spec base45-payload
codec-spec    = codec-char [ "." dict-id "_" ]
dict-id       = 1*( ALPHA / DIGIT / "-" )
base45        = 1*( DIGIT / UPPER / " " / "$" / "%" / "*" / "+" / "-" / "." / "/" / ":" )
base45-payload = base45

; url scheme (§7.1)
url-body      = urlencoded-absolute-https-url

; gh scheme (§7.2)
gh-body       = owner "/" repo [ "@" ref ] ":" path
owner         = 1*( ALPHA / DIGIT / "-" )
repo          = 1*( ALPHA / DIGIT / "-" / "_" / "." )
ref           = 1*( ALPHA / DIGIT / "-" / "_" / "." / "/" )
path          = 1*PCHAR

; gist scheme (§7.3)
gist-body     = gist-id [ ":" file ]
gist-id       = 1*HEXDIG
file          = 1*PCHAR

; zenodo scheme (§7.4)
zenodo-body   = record-id [ ":" file ]
record-id     = 1*DIGIT

; doi scheme (§7.5)
doi-body      = doi-name [ "#" file ]
doi-name      = doi-prefix "/" doi-suffix
doi-prefix    = "10." 1*DIGIT
doi-suffix    = 1*PCHAR

; rentry scheme (§7.6)
rentry-body   = paste-id
paste-id      = 1*( ALPHA / DIGIT / "-" / "_" )

; PCHAR and related
PCHAR         = unreserved / pct-encoded / sub-delims / ":" / "@" / "/" / "?"
unreserved    = ALPHA / DIGIT / "-" / "." / "_" / "~"
pct-encoded   = "%" HEXDIG HEXDIG
sub-delims    = "!" / "$" / "&" / "'" / "(" / ")" / "*" / "+" / "," / ";" / "="
```

### Appendix C — Channel size reference

Practical URL-carrying capacity of common share channels, in bytes of encoded URL including scheme and host. Conservative values to aim for reliable delivery; actual limits may be higher in some cases.

| channel                 | safe limit | notes                                        |
|-------------------------|-----------:|----------------------------------------------|
| QR v15 (M EC)           |       ~500 | scan reliably with phone cameras             |
| QR v20 (M EC)           |       ~800 | larger but still scans reliably              |
| QR v25 (M EC)           |     ~1 200 | near-maximum reliable scan                   |
| Email body (safe)       |     ~2 000 | some gateways still reject longer            |
| Email body (typical)    |     ~8 000 | most modern clients and servers              |
| Twitter/X post          |     ~4 000 | char limit; URL counts in full               |
| Slack unfurl preview    |     ~4 000 | beyond this, preview skipped; link delivers  |
| Discord (normal)        |     ~2 000 | message char limit                           |
| Discord (Nitro)         |     ~4 000 | Nitro char limit                             |
| WhatsApp message        |       huge | practically unlimited                        |
| iMessage                |       huge | multi-MB                                     |
| Chrome/FF address bar   |    ~32 000 | some servers truncate lower                  |

Inline deflate-raw compression ratios on typical `.txt` source content for Auditable-shaped notebooks:

| content kind                      | ratio |
|-----------------------------------|------:|
| mostly markdown prose             | 5–8×  |
| mixed source (md + js + adder)    | 3–5×  |
| code-heavy                        | 3–4×  |
| already-minified code             | 2–3×  |
| contains pasted CSV/JSON blobs    | 1.5–2×|

As a rule of thumb, to fit channel `C` with safe capacity `K`, content size should be `< K × 3 × 3/4` (accounting for ~3× deflate and 4/3 base64url inflation), minus ~50 bytes of scheme and URL overhead.

### Appendix D — Test vectors

All vectors below have been verified to round-trip in Python 3 using `zlib.compressobj(..., wbits=-15)` for deflate-raw and `base64.urlsafe_b64encode` / a custom RFC 9285 base45 implementation.

#### D.1 Inline raw — `hello world\n`

Content (12 bytes): `hello world\n` (bytes: `68 65 6c 6c 6f 20 77 6f 72 6c 64 0a`)

Capsules (all decode to the same content bytes):

```
inline:raw:aGVsbG8gd29ybGQK
i:raGVsbG8gd29ybGQK
q:r+8D VD82EK4F.KE5TC
```

The `q:r` form contains a literal space character. When carried in a URL fragment, both space and `%` MUST be escaped per §6.4.1 (`%`→`%25` first, then space→`%20`, reversed by a single left-to-right pass). The raw base45 — what `resolve` receives and what a QR alphanumeric segment carries — is unescaped.

#### D.2 Inline deflate — `the quick brown fox`

Content (44 bytes): `the quick brown fox jumps over the lazy dog.`

Deflate-raw output (Python `zlib`, level 9, wbits=-15) is 45 bytes. The base-encoded forms:

- base64url (60 chars): `K8lIVSgszUzOVkgqyi_PU0jLr1DIKs0tKFbIL0stUigBSuckVlUqpOSn6wEA`
- base45    (68 chars): `4O5M69O35-.P$3QO599PPK9Q599F7MWDPA.PL45$DPUM9HHAF70.9T6-AQH5Z+S-VT00`

Capsules:

```
inline:deflate:K8lIVSgszUzOVkgqyi_PU0jLr1DIKs0tKFbIL0stUigBSuckVlUqpOSn6wEA
i:dK8lIVSgszUzOVkgqyi_PU0jLr1DIKs0tKFbIL0stUigBSuckVlUqpOSn6wEA
q:d4O5M69O35-.P$3QO599PPK9Q599F7MWDPA.PL45$DPUM9HHAF70.9T6-AQH5Z+S-VT00
```

The exact deflate output may vary slightly across implementations choosing different literals-vs-length-distance encodings. The spec requires round-trip fidelity, not byte-exact encoder output. The vectors above are the canonical Python `zlib` output and SHOULD round-trip in any conforming decoder.

#### D.3 Reference: gh

Capsule: `gh:endarthur/auditable@main:README.md`

Loader MUST fetch `https://cdn.jsdelivr.net/gh/endarthur/auditable@main/README.md` by default, or `https://raw.githubusercontent.com/endarthur/auditable/main/README.md` if configured for the raw endpoint.

#### D.4 Density comparison (informational)

For the D.2 content (44 bytes → 45 bytes deflate-raw):

| encoding   | length (chars) | QR mode       | bits per encoded byte |
|------------|----------------|---------------|------------------------|
| base64url  | 60             | byte          | 10.67                  |
| base45     | 68             | alphanumeric  | 8.31                   |

Base45 in QR alphanumeric mode is **~22% cheaper** in QR bit cost than base64url in byte mode, despite being longer in raw character count. The reverse holds in pure character-count channels (Twitter, SMS), where base64url's `~1.33 chars/byte` beats base45's `~1.50 chars/byte`. Encoders should pick the form matching the target channel.

#### D.5 Brotli codec (informational)

Content (44 bytes): `the quick brown fox jumps over the lazy dog.`

Either form (long or compact, base64url or base45) is acceptable:

```
inline:brotli:<base64url-of-brotli(content)>
i:b<base64url-of-brotli(content)>
q:b<base45-of-brotli(content)>
```

No fixed ciphertext is specified for this vector because brotli's output is more sensitive to encoder settings (window size, quality level) than deflate's. The spec requires round-trip fidelity: decoding any conforming brotli payload of this content MUST yield exactly the 44 input bytes. Implementations that omit the brotli codec MUST reject these capsules with `EUNSUPPORTEDCODEC`.

#### D.6 QR-scheme with dictionary

Content (the canonical Café da Esquina menu body from `SPEC-menu.md` Appendix A, prefixed with `!menu1+pt-BR\n` magic line, 332 bytes total) compressed with deflate-raw using the `menu-ptbr` dictionary, then base45-encoded, produces:

```
q:d.menu-ptbr_H%DZIPSKGEP2LFVM06WQ9TPKO C$EM0ON05WWMDP9IJ%0FECF381:8$S2VPN0BUF5D+0R4GH$WQIZQM9O$7LYCRSC9694*J5G9JLEU5O97WN4RBFCU/WEB4R$ O%336X4*LGN%O0AM1+1LXM*TP44HMC20YCWR9+H0THJ* 5J3W+%F /C:VCP30Q106LT8C0 IJ+62QT0HJGYM9F/NO+AMDUSU53LF4/HJ0B+A23X1- O2NSKJN7:CXDL6VV96N2NRQ94I18XDA8HOAJQ
```

This is a 287-byte capsule. Concatenated with `https://gentropic.org/c#` produces a 311-character URL that fits in a QR v15 with ECC M margin to spare. When placed in a URL fragment, the base45 payload's space and `%` characters MUST be escaped per §6.4.1; a QR encoder MAY instead carry the raw base45 in an alphanumeric segment, preserving both characters unescaped.

Compression performance for this vector: 332 bytes plaintext → 182 bytes deflate-dict → 273 bytes base45. Without dictionary deflate, plain `deflate` would yield ~265 bytes on this short corpus (the dictionary buys ~45% on menu-shaped content); with no compression, base45-encoded raw bytes would be ~498 chars.

### Appendix E — Changelog

- **v0.1** (2026-05-16) — Initial draft. Defines capsule grammar (`SCHEME:BODY` in URL fragment), resolution algorithm, dispatcher API, and loader interface. Three inline schemes: `inline:` (long form, base64url), `i:` (compact form, base64url, ~12 bytes less framing), `q:` (QR-optimized, base45, ~22% denser in QR bit cost, the only inline form supporting dictionary-keyed deflate). Six reference schemes: `url`, `gh`, `gist`, `zenodo`, `doi`, `rentry`. Three codecs: `raw`, `deflate` (raw, RFC 1951, no zlib wrapper), `brotli` (OPTIONAL, RFC 7932); plus `deflate-dict.<dict-id>` for dictionary-keyed deflate (REQUIRED to implement for consumers like `@gcu/cradle`, with pako as the polyfill until native browser support). All test vectors in Appendix D verified round-trip in Python 3 reference encoder. Encryption integration surface deferred (§21) but worked example in §21.4 confirms grammar accommodates the anyone-can-send / only-owner-can-read case (sealed-box envelope, QR-doorbell). Payload type discrimination and renderer dispatch are explicit non-goals; see `SPEC-cradle.md` for the canonical dispatch layer.

### Appendix F — Related work and inspiration

- **Colab, Binder, Observable, CodeSandbox** — badge-and-open-URL patterns for notebook sharing. This spec's badge conventions are directly inspired.
- **Data URIs** (RFC 2397) — inline content carrying; the `inline:raw` codec is essentially a URL-fragment-friendly alternative.
- **IPFS addressing** — content-addressed identity; considered and rejected for v0 as it requires dedicated gateway infrastructure and its permanence guarantees are weaker than they appear in practice.
- **OCI Artifacts** — another content-addressed ecosystem; out of scope.
- **DID** (Decentralized Identifiers) — formally broader than this spec; again, rejected for v0 due to the amount of ecosystem it drags in for little additional value at notebook-sharing scale.

### Appendix G — Deliberately not in this spec

- **Signing and verification.** Could be added as a wrapping scheme (`sig:<public-key>:<sig>:<inner-capsule>`). Non-trivial to get right; left for a dedicated spec.
- **Content-addressed identity.** A `cid:<hash>:<inner-capsule>` wrapper would let the dispatcher verify bytes against a hash post-fetch. Useful for tamper detection. Left for future work.
- **Search/discovery.** There is no registry of capsules, no federation, no listing. A capsule is only obtainable from whoever shared it with you.
- **Garbage collection.** Reference capsules break when their target is deleted; this spec does not mitigate. Shells MAY cache aggressively, but cache eviction is not specified.
- **Offline-first.** There is no provision for offline resolution beyond whatever the loader's cache (§8.3) happens to retain. Full offline support is a shell-level concern.
- **Payload type discrimination and renderer dispatch.** A bootloader serving multiple payload kinds (menus, doorbells, notebooks, lost-and-found tags, conference references) needs a way to inspect resolved bytes and pick a renderer. This is a consumer concern; the canonical layer is `@gcu/cradle`. See `SPEC-cradle.md`.

— end of spec —
