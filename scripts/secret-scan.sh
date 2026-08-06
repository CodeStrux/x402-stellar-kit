#!/usr/bin/env bash
# Secret / provenance scanner. Zero dependencies — grep only.
#
#   scripts/secret-scan.sh            scan the whole working tree
#   scripts/secret-scan.sh --staged   scan only staged content (pre-commit hook)
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
[ "${1:-}" = "--staged" ] && STAGED=1

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
  if [ "$STAGED" -eq 1 ]; then
    git -C "$ROOT" diff --cached --name-only --diff-filter=ACMR
  else
    # tracked AND untracked-but-not-ignored. `ls-files` alone sees only tracked
    # files, which is nearly nothing in a repo that has not been committed yet.
    git -C "$ROOT" ls-files --cached --others --exclude-standard
  fi
}

# Never scan the scanner itself (it necessarily contains every pattern).
SELF_REL="$(realpath --relative-to="$ROOT" "${BASH_SOURCE[0]}")"

mapfile -t FILES < <(list_files | grep -Ev \
  -e '^(node_modules|dist|build|coverage|target|\.next)/' \
  -e '/(node_modules|dist|build|coverage|target|\.next)/' \
  -e "^${SELF_REL}$" \
  -e '^scripts/secret-scan\.(sh|conf)$' \
  || true)

[ "${#FILES[@]}" -eq 0 ] && { say "secret-scan: nothing to scan"; exit 0; }

# --- scan ---------------------------------------------------------------------
hits=0
scan() {
  local label="$1" pattern="$2" f content
  for f in "${FILES[@]}"; do
    [ -f "$ROOT/$f" ] || continue
    if [ "$STAGED" -eq 1 ]; then
      content="$(git -C "$ROOT" show ":$f" 2>/dev/null || true)"
    else
      content="$(cat "$ROOT/$f" 2>/dev/null || true)"
    fi
    # -a: scan binary content as text too — a key hidden in a blob still counts
    if printf '%s' "$content" | grep -aqE -- "$pattern"; then
      printf '\n  %s in %s\n' "$label" "$f" >&2
      printf '%s' "$content" | grep -anE -- "$pattern" | head -3 | cut -c1-120 | sed 's/^/    /' >&2
      hits=$((hits + 1))
    fi
  done
}

say "secret-scan: posture=$POSTURE files=${#FILES[@]} staged=$STAGED"

for p in "${CRED_PATTERNS[@]}"; do scan "CREDENTIAL" "$p"; done
if [ "$POSTURE" = "public" ]; then
  for p in "${PUBLIC_ONLY_PATTERNS[@]}"; do scan "PRIVATE-PROVENANCE" "$p"; done
fi

if [ "$hits" -gt 0 ]; then
  printf '\nsecret-scan: FAILED with %d finding(s). Nothing was committed.\n' "$hits" >&2
  exit 1
fi

say "secret-scan: clean"
