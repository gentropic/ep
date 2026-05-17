# temporal-polyfill (vendored)

`temporal-polyfill.min.js` is the global IIFE build of [temporal-polyfill](https://github.com/fullcalendar/temporal-polyfill), version pinned implicitly by the file's contents (re-run `build.js` or `curl` against jsDelivr to update).

**Why:** Safari 18.4+ and Node ≥24 don't ship `Temporal` natively as of mid-2026. ep uses Temporal for datetime parsing, formatting, and TZ-aware operations in the numbat-js evaluator; the polyfill stands in everywhere `globalThis.Temporal` is missing.

**Size:** ~57 KB raw, ~18 KB gzipped. Detection-and-define is conditional — modern browsers (Firefox 139+, Chrome shipping) skip the polyfill body.

**License:** MIT, by Adam Shaw / FullCalendar contributors.

**Refresh:**
```sh
curl -sL https://cdn.jsdelivr.net/npm/temporal-polyfill@latest/global.min.js \
  -o ext/temporal/temporal-polyfill.min.js
```
