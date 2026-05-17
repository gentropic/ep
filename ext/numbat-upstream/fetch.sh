#!/bin/sh
# Fetch the upstream numbat-wasm artifact for cross-validation tests.
# Dev-only — never required by runtime ep or by the default test suite.

set -e
cd "$(dirname "$0")"

base="https://numbat.dev/pkg"

echo "fetching numbat-wasm from $base"
curl -sfL "$base/numbat_wasm_bg.wasm" -o numbat_wasm_bg.wasm
curl -sfL "$base/numbat_wasm.js"      -o numbat_wasm.js

echo "fetched:"
ls -lh numbat_wasm_bg.wasm numbat_wasm.js 2>/dev/null || ls -la
