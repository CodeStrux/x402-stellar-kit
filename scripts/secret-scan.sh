#!/usr/bin/env bash
# Secret / provenance scanner. Zero dependencies — grep only.
#
#   scripts/secret-scan.sh            scan the whole working tree
#   scripts/secret-scan.sh --staged   scan only staged content (pre-commit hook)
#   scripts/secret-scan.sh --path DIR scan every file under DIR, ignoring git
#
# --path exists for one reason: dist/ is gitignored, so the two git-driven modes
# above cannot see it — yet dist/ is most of what `npm publish` ships. verify-pack.sh
# extracts the real tarball and points this at it. Nothing else scans those bytes.
#
# Repo posture is read from scripts/secret-scan.conf:
#   POSTURE=public   also bans private-infra provenance strings
#   POSTURE=private  credential patterns only (op:// references are legitimate here)
#
# A hit is a hard failure. If a hit is a false positive, fix the file or narrow the
# pattern in this script — never add a bypass flag.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(git -C "$HERE" rev-parse --show-toplevel)"
POSTURE=private
# shellcheck disable=SC1091
[ -f "$HERE/secret-scan.conf" ] && . "$HERE/secret-scan.conf"

STAGED=0
PATH_MODE=""
case "${1:-}" in
  --staged) STAGED=1 ;;
  --path)
    PATH_MODE="${2:-}"
    [ -n "$PATH_MODE" ] || { printf 'secret-scan: --path needs a directory\n' >&2; exit 1; }
    [ -d "$PATH_MODE" ] || { printf 'secret-scan: not a directory: %s\n' "$PATH_MODE" >&2; exit 1; }
    ROOT="$(cd "$PATH_MODE" && pwd)"
    ;;
  "") ;;
  *) printf 'secret-scan: unknown argument: %s\n' "$1" >&2; exit 1 ;;
esac

say() { printf '%s\n' "$*"; }
die() { printf 'secret-scan: %s\n' "$*" >&2; exit 1; }

# --- patterns -----------------------------------------------------------------
# Credential material. Banned in EVERY repo.
CRED_PATTERNS=(
  '\bS[A-Z2-7]{55}\b'                      # Stellar secret seed (strkey)
  '-----BEGIN [A-Z ]*PRIVATE KEY-----'     # PEM private key
  '\bAKIA[0-9A-Z]{16}\b'                   # AWS access key id
  '\bgh[pousr]_[A-Za-z0-9]{36,}'           # GitHub token
  '\bAIza[0-9A-Za-z_-]{35}\b'              # Google API key
  '\bops_[A-Za-z0-9]{40,}'                 # 1Password service-account token
  '\bsk-[A-Za-z0-9]{32,}'                  # OpenAI-style secret key
  '"private_key"[[:space:]]*:'             # GCP service-account JSON
)

# Private-infrastructure provenance. Banned in the PUBLIC repo only.
# Deliberately NOT a blanket ban on "codestrux": the org name is legitimate in a
# LICENSE, author field, or contact address. Only infra identifiers are banned.
PUBLIC_ONLY_PATTERNS=(
  'auth\.stratos\.talk'
  'pm-gateway'
  'op://'
  'PM_AGENT_'
  '274259173148'                           # GCP project number
  '[Pp]aramo'                              # private product name
  'projects/codestrux'                     # GCP resource path
  '--project[ =]+codestrux'                # gcloud invocation
  'pkg\.dev/codestrux'                     # Artifact Registry
  'GCP_PROJECT'
  'run\.app'                               # Cloud Run default hostnames
)

# --- file list ----------------------------------------------------------------
list_files() {
  if [ -n "$PATH_MODE" ]; then
    # Everything under the directory, including what git would have ignored —
    # that is the whole point of this mode.
    ( cd "$ROOT" && find . -type f -printf '%P\n' )
  elif [ "$STAGED" -eq 1 ]; then
    git -C "$ROOT" diff --cached --name-only --diff-filter=ACMR
  else
    # tracked AND untracked-but-not-ignored. `ls-files` alone sees only tracked
    # files, which is nearly nothing in a repo that has not been committed yet.
    git -C "$ROOT" ls-files --cached --others --exclude-standard
  fi
}

# Never scan the scanner itself (it necessarily contains every pattern).
SELF_REL="$(realpath --relative-to="$ROOT" "${BASH_SOURCE[0]}" 2>/dev/null || echo '')"

if [ -n "$PATH_MODE" ]; then
  # In --path mode dist/ is precisely what we came to read, so it is NOT excluded.
  mapfile -t FILES < <(list_files | grep -Ev -e '(^|/)node_modules/' || true)
else
  mapfile -t FILES < <(list_files | grep -Ev \
    -e '^(node_modules|dist|build|coverage|target|\.next)/' \
    -e '/(node_modules|dist|build|coverage|target|\.next)/' \
    -e "^${SELF_REL}$" \
    -e '^scripts/secret-scan\.(sh|conf)$' \
    || true)
fi

[ "${#FILES[@]}" -eq 0 ] && { say "secret-scan: nothing to scan"; exit 0; }

# --- scan ---------------------------------------------------------------------
#
# Content is STREAMED to grep, never held in a shell variable.
#
# `content="$(cat file)"` cannot survive a NUL byte — bash drops them and warns.
# Dropping a NUL does not merely truncate: it deletes the byte that was acting as
# a word boundary, so `x\0S...` becomes `xS...` and every `\b`-anchored pattern
# below stops matching. Measured, bash 5.3: a real strkey one NUL into a file
# scanned CLEAN through the variable and is FOUND through the stream. The `-a`
# flag exists for exactly the "a key hidden in a blob" case, and a command
# substitution was quietly taking it away.
hits=0

# Emits one file's content, from the index or from the filesystem.
emit() {
  if [ "$STAGED" -eq 1 ]; then
    git -C "$ROOT" show ":$1" 2>/dev/null || true
  else
    cat "$ROOT/$1" 2>/dev/null || true
  fi
}

scan() {
  local label="$1" pattern="$2" f
  for f in "${FILES[@]}"; do
    [ -f "$ROOT/$f" ] || continue
    # -a: scan binary content as text too — a key hidden in a blob still counts
    if emit "$f" | grep -aqE -- "$pattern"; then
      printf '\n  %s in %s\n' "$label" "$f" >&2
      emit "$f" | grep -anE -- "$pattern" | head -3 | cut -c1-120 | sed 's/^/    /' >&2
      hits=$((hits + 1))
    fi
  done
}

say "secret-scan: posture=$POSTURE files=${#FILES[@]} staged=$STAGED${PATH_MODE:+ path=$PATH_MODE}"

for p in "${CRED_PATTERNS[@]}"; do scan "CREDENTIAL" "$p"; done
if [ "$POSTURE" = "public" ]; then
  for p in "${PUBLIC_ONLY_PATTERNS[@]}"; do scan "PRIVATE-PROVENANCE" "$p"; done
fi

if [ "$hits" -gt 0 ]; then
  printf '\nsecret-scan: FAILED with %d finding(s). Nothing was committed.\n' "$hits" >&2
  exit 1
fi

say "secret-scan: clean"
