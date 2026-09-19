#!/usr/bin/env bash
# Run the frontend unit/integration suite from an ASCII-only copy of the
# sources. Reason: this checkout lives under a Cyrillic path
# (.../Документы/...) which the installed Vite version cannot load modules
# from ("Failed to load url ... Does the file exist?"). The copy is
# refreshed on every run, so tests always run against current sources.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
FRONTEND="$(cd "$HERE/.." && pwd)"
WORK=/tmp/rda-test-src
rm -rf "$WORK"
mkdir -p "$WORK"
cp -a "$FRONTEND/src" "$WORK/src"
# NOTE: the repo vitest.config.ts breaks module loading in this env — run
# config-free with CLI flags (tests use relative imports, no alias needed).
exec "$HERE/node_modules/.bin/vitest" run \
  --root "$WORK" \
  --environment happy-dom \
  --dir "$WORK/src" \
  "$@"
