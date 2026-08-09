#!/usr/bin/env bash
# Pack the package for real, then inspect the bytes a consumer would install.
#
#   scripts/verify-pack.sh
#
# Why this exists, when verify-dist.sh already runs:
#
#   dist/ is gitignored and shipped via package.json `files`. Every other control
#   in this repo reads the git worktree — secret-scan.sh explicitly excludes dist/
#   — so 68 of the 88 files in the published tarball had never been read by
#   anything. A sourcemap, a stray absolute path, or a key baked into a build
#   artifact would have shipped unexamined.
#
# Three checks, in order of what they catch:
#
#   1. The tarball packs at all, and contains every entry point package.json
#      advertises. A fresh clone with no build ships a package that resolves to
#      nothing; npm reports success.
#   2. The extracted contents pass the secret/provenance scan. This is the only
#      place dist/ is ever scanned. Note it scans the EXTRACTED files: grepping a
#      .tgz finds nothing, because the contents are compressed — measured, not
#      assumed.
#   3. The packed file list matches scripts/packed-files.txt exactly. `files` is
#      an allowlist of directories, so a new top-level file inside one of them
#      ships silently. This turns "what shipped" into a reviewable diff.
#
# verify-dist.sh is still the LOCAL guard: its mtime check is the only thing that
# catches "you edited a source and forgot to rebuild" on a laptop. It proves
# nothing in CI, where `npm run build` ran moments earlier, so CI runs this instead.
set -euo pipefail

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
cd "$ROOT"

MANIFEST="scripts/packed-files.txt"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

fail() { printf 'verify-pack: %s\n' "$*" >&2; exit 1; }

# --- 1. pack ------------------------------------------------------------------
# --ignore-scripts because .npmrc sets it anyway; being explicit means this
# behaves the same however it is invoked.
TARBALL="$(npm pack --ignore-scripts --pack-destination "$WORK" --silent)" \
  || fail "npm pack failed"
[ -f "$WORK/$TARBALL" ] || fail "npm pack reported '$TARBALL' but produced no such file"

tar -xzf "$WORK/$TARBALL" -C "$WORK" || fail "could not extract $TARBALL"
PKG="$WORK/package"
[ -d "$PKG" ] || fail "tarball has no package/ directory"

# Every entry point package.json advertises must be present in the tarball.
# Derived from package.json rather than hardcoded: an entry point added to
# `exports` and forgotten here would ship broken.
mapfile -t ENTRIES < <(node -e '
  const pkg = require("./package.json");
  const out = new Set();
  const walk = (v) => {
    if (typeof v === "string") out.add(v.replace(/^\.\//, ""));
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(pkg.exports ?? {});
  for (const k of ["main", "types"]) if (pkg[k]) out.add(pkg[k].replace(/^\.\//, ""));
  for (const p of out) console.log(p);
')
[ "${#ENTRIES[@]}" -gt 0 ] || fail "package.json advertises no entry points"

missing=0
for e in "${ENTRIES[@]}"; do
  [ -f "$PKG/$e" ] || { printf '  missing from tarball: %s\n' "$e" >&2; missing=$((missing + 1)); }
done
[ "$missing" -eq 0 ] || fail "$missing advertised entry point(s) are not in the tarball. Run: npm run build"

# --- 2. scan the extracted contents -------------------------------------------
./scripts/secret-scan.sh --path "$PKG" || fail "the published tarball contains a secret or private-infra string"

# --- 3. the packed file list is the one we reviewed ----------------------------
ACTUAL="$WORK/actual.txt"
( cd "$PKG" && find . -type f -printf '%P\n' ) | LC_ALL=C sort > "$ACTUAL"

if [ "${UPDATE_MANIFEST:-0}" = "1" ]; then
  cp "$ACTUAL" "$MANIFEST"
  printf 'verify-pack: wrote %s (%d files) — review the diff before committing\n' \
    "$MANIFEST" "$(wc -l < "$MANIFEST")"
  exit 0
fi

[ -f "$MANIFEST" ] || fail "$MANIFEST is missing. Generate it with: UPDATE_MANIFEST=1 $0"

if ! diff -u "$MANIFEST" "$ACTUAL" > "$WORK/diff.txt"; then
  printf 'verify-pack: the packed file list does not match %s\n' "$MANIFEST" >&2
  printf '  -  expected (committed)   +  actually packed\n\n' >&2
  sed -n '3,$p' "$WORK/diff.txt" | grep -E '^[+-]' | head -40 | sed 's/^/    /' >&2
  printf '\nIf the change is intended: UPDATE_MANIFEST=1 %s, then commit the diff.\n' "$0" >&2
  exit 1
fi

printf 'verify-pack: %s — %d files, %d entry points, scanned clean, manifest matches\n' \
  "$TARBALL" "$(wc -l < "$ACTUAL")" "${#ENTRIES[@]}"
