#!/usr/bin/env bash
# Refuse to publish a tarball whose dist/ does not match src/.
#
#   scripts/verify-dist.sh
#
# `files` ships dist/, dist/ is gitignored, and .npmrc sets ignore-scripts=true.
# That last line is the trap: npm applies ignore-scripts to its OWN lifecycle
# scripts, so `npm publish` in this directory silently skips prepublishOnly.
# 0.1.0 shipped correct bytes only because a build happened to have run first.
# A guard that npm can skip is not a guard, so this one is run by a human as an
# explicit release step — and by CI, which has no reason to skip it.
#
# LIMITATION, stated rather than discovered later: staleness is judged by
# modification time. Anything that rewrites timestamps defeats it — a CI cache
# restoring dist/, or a fresh `git checkout` touching sources. It catches the
# realistic local failure (edit a source, forget to rebuild, publish), not every
# conceivable one. Always run it directly after `npm run build`.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(git -C "$HERE" rev-parse --show-toplevel)"
cd "$ROOT"

fail() { printf 'verify-dist: %s\n' "$*" >&2; exit 1; }

[ -d dist ] || fail "dist/ does not exist. Run: npm run build"

# --- every advertised entry point must actually resolve --------------------
# Read straight from package.json rather than restating the list here: an entry
# point added to `exports` and forgotten in this script would ship broken.
mapfile -t ENTRIES < <(
  node -e '
    const pkg = require("./package.json");
    const out = new Set();
    const walk = (value) => {
      if (typeof value === "string") { out.add(value); return; }
      if (value && typeof value === "object") Object.values(value).forEach(walk);
    };
    walk(pkg.exports ?? {});
    for (const key of ["main", "types"]) if (pkg[key]) out.add(pkg[key]);
    for (const path of out) console.log(path.replace(/^\.\//, ""));
  '
)

[ "${#ENTRIES[@]}" -gt 0 ] || fail "package.json advertises no entry points"

missing=0
for entry in "${ENTRIES[@]}"; do
  if [ ! -f "$entry" ]; then
    printf '  missing: %s\n' "$entry" >&2
    missing=$((missing + 1))
  fi
done
[ "$missing" -eq 0 ] || fail "$missing advertised entry point(s) are not in dist/. Run: npm run build"

# --- dist/ must be newer than every source that feeds it -------------------
# Existence alone proves nothing: a stale dist/ from three commits ago exists
# too, and that is precisely the bug this script is here to catch.
OLDEST_BUILT="$(find dist -type f \( -name '*.js' -o -name '*.d.ts' \) -printf '%T@ %p\n' \
  | sort -n | head -1)"
[ -n "$OLDEST_BUILT" ] || fail "dist/ contains no build output. Run: npm run build"
OLDEST_TIME="${OLDEST_BUILT%% *}"
OLDEST_FILE="${OLDEST_BUILT#* }"

STALE="$(find src mcp examples -type f -name '*.ts' -newermt "@${OLDEST_TIME}" -print 2>/dev/null || true)"
if [ -n "$STALE" ]; then
  printf 'verify-dist: these sources are newer than the build output %s:\n' "$OLDEST_FILE" >&2
  printf '%s\n' "$STALE" | sed 's/^/    /' >&2
  fail "dist/ is stale. Run: npm run build"
fi

printf 'verify-dist: %d entry points present, dist/ newer than every source\n' "${#ENTRIES[@]}"
