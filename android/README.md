# ep on Android — the TWA (SPEC-pocket M2)

ep ships as a Trusted Web Activity: the APK is a signed wrapper that opens
`https://gentropic.org/ep/` in Chrome with no browser chrome. No native code; the
app updates whenever gentropic.org/ep deploys. Everything in this folder is config;
the generated Android project and every signing artefact stay out of git.

## What's here

| file | what |
|---|---|
| `twa-manifest.json` | Bubblewrap project config. `bubblewrap build` reads it. |
| `assetlinks.json` | Template for `https://gentropic.org/.well-known/assetlinks.json`. The fingerprint is a placeholder until the app has a signing key. |
| `listing.md` | Play listing text (title, short + full description, keywords). |

The web side is already in place: `manifest.webmanifest` (PNG icons at 192 and
512, any + maskable; standalone; `scope ./`), `sw.js` (cache-first shell, byte-diff
update) and `.nojekyll` so GitHub Pages serves everything verbatim. `npm run
check:install` checks the installability criteria statically.

## One-time setup (not done — needs a JDK and your key)

1. **Toolchain.** `winget install Microsoft.OpenJDK.17` and `npm i -g @bubblewrap/cli`.
   Bubblewrap will offer to download the Android SDK pieces it needs; the SDK at
   `%LOCALAPPDATA%\Android\Sdk` can be pointed at instead.
2. **Project.** From this folder: `bubblewrap init --manifest https://gentropic.org/ep/manifest.webmanifest`
   — answer with the values in `twa-manifest.json` (or let it read the file; `bubblewrap
   update` re-syncs from the web manifest later). It creates the Android project here.
3. **Key.** Bubblewrap creates `ep-release.keystore` when asked; alias `ep`. Back it up
   offline; it never enters git (`.gitignore` covers `android/*`). If you prefer the
   lead-acid approach, `keytool -genkeypair -v -keystore ep-release.keystore -alias ep
   -keyalg EC -groupname secp256r1 -validity 36500` (see `../lead-acid/docs/signing.md`).
4. **Build.** `bubblewrap build` → `app-release-signed.apk` + `app-release-bundle.aab`.
   `adb install app-release-signed.apk` on the S24+ for the internal test.
5. **Digital Asset Links.** The fingerprint that matters is the one Play signs with.
   Play Console → Setup → App signing → "SHA-256 certificate fingerprint". Put it in
   `assetlinks.json` and copy the file to
   `../gentropic.github.io/.well-known/assetlinks.json` (that repo is gentropic.org's
   root; `.well-known/` already exists there). For a sideloaded test build, use the
   local key's fingerprint instead: `keytool -list -v -keystore ep-release.keystore`.
   Until the link verifies, the TWA falls back to a Custom Tab **with a URL bar** — the
   one thing that would look un-GCU, so check before the listing goes up:
   `adb shell pm get-app-links org.gentropic.ep` must say `verified`.
6. **Listing.** `listing.md` + four screenshots (the worked example, a conversion, the
   typechecker catching `m + s`, the exported form). Data safety: a column of No.

## Release discipline

`node build.js` from a clean tree, so the version stamp in the artifact has no
`+dirty`; commit the artifact as its own "release build" commit; deploy; then
`bubblewrap build` against the live URL. The TWA never bundles `index.html` — the
web deploy is the release.
