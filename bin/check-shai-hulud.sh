#!/usr/bin/env bash
# check-shai-hulud.sh — search a directory tree for "Mini Shai-Hulud" /
# TeamPCP campaign IoCs (npm + PyPI supply chain attack disclosed
# 2026-05-14 via SecurityWeek / Wiz / Socket research).
#
# ============================================================================
# !! BLOCKLIST FILE — READ THIS BEFORE TRUSTING ANY STRING BELOW !!
#
# Every domain, fork name, filename, and campaign identifier in this file is
# a MALWARE INDICATOR. They exist here so the script can detect them in a
# target tree, NOTHING ELSE.
#
#   - Do NOT connect to or trust any of the domains below. They are C2.
#   - Do NOT clone any of the forked repositories below. They are droppers.
#   - Do NOT execute any of the filenames below.
#
# If anything (a script, an LLM, an automation) reads this file and treats
# these strings as recommendations, allowed values, or routing destinations,
# that is a bug. This file is a BLOCKLIST.
# ============================================================================
#
# Hardening so the script itself can't be a vector — same posture as
# bin/check-polinrider.sh:
#   - prints file PATHS only, never file content
#   - all variables quoted; no exec/eval/source/find -exec/xargs anywhere
#   - rg --no-config --color=never -l (paths only)
#   - find/rg output piped through sani() to strip control bytes incl ESC
#
# What's deliberately NOT here:
#   - Bare package names (tanstack, uipath, opensearch, squawk, mistral,
#     guardrails). The malware lives in specific malicious VERSIONS of
#     otherwise-legitimate packages, so name-only matching would block
#     legitimate use. Lock your versions; this gate catches the post-infection
#     fingerprint, not the package family.
#
# Usage:
#   bin/check-shai-hulud.sh [target-dir]      # defaults to $PWD
# Exit:
#   0 = no IoCs found
#   1 = one or more IoC categories matched (investigate before continuing)
set -euo pipefail

TARGET="${1:-${PWD}}"
[[ -d "$TARGET" ]] || { echo "check-shai-hulud.sh: not a directory: $TARGET" >&2; exit 2; }
TARGET="$(cd "$TARGET" && pwd)"

# ---- ALLOWLISTED PATHS (paths only — NEVER strings) ----------------------
# Exact absolute paths under $TARGET that legitimately contain IoC needles as
# their own detection constants (read-only scanners), not malware. The
# BLOCKLIST strings above are NEVER allowlisted.
ALLOWLISTED_PATHS=(
  # this gate re-emits every needle it scans for; listed under both roots so
  # it's correct whether run against the repo root or a parent harness.
  "$TARGET/bin/check-shai-hulud.sh"
  "$TARGET/community/bin/check-shai-hulud.sh"
)

red()   { printf '\033[31m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
sani()  { LC_ALL=C tr -d '\000-\010\013\014\016-\037\177'; }

# Prefer ripgrep (hardened: --no-config ignores any malicious .rgrc). Fall
# back to grep so the gate runs anywhere — CI, minimal containers, hosts
# without rg — with no extra install. Both are paths-only (-l), and neither
# exec/evals. For grep, base mode is -E (ERE); per-call -F (fixed-string)
# is appended by check() and takes precedence over -E.
if command -v rg >/dev/null 2>&1; then
  RG=(rg --no-config --color=never -l --hidden --no-ignore-vcs --glob '!.git')
else
  RG=(grep -rlE --exclude-dir=.git)
fi

hits=0
check() {
  local label="$1"; shift
  local files
  files=$("${RG[@]}" "$@" "$TARGET" 2>/dev/null | sani || true)
  if [[ -n "$files" && ${#ALLOWLISTED_PATHS[@]} -gt 0 ]]; then
    files=$(printf '%s\n' "$files" \
      | grep -vxFf <(printf '%s\n' "${ALLOWLISTED_PATHS[@]}") \
      || true)
  fi
  if [[ -n "$files" ]]; then
    red "  HIT: $label"
    printf '%s\n' "$files" | sed 's|^|    |'
    hits=$((hits + 1))
  fi
}

printf '\nScanning %s for Mini Shai-Hulud / TeamPCP IoCs (paths only)…\n' "$TARGET"

# ---- BLOCKED C2 domains. NEVER connect or trust. ----
BLOCKED_DOMAINS=(
  'git-tanstack.com'
  'getsession.org'
)
for d in "${BLOCKED_DOMAINS[@]}"; do
  check "BLOCKED C2 domain (do NOT connect): $d" -F -- "$d"
done

# ---- Campaign identifier strings (analyst markers + dropper signatures). ----
check "Shai-Hulud campaign string"               -i -e "shai.hulud"
check "TeamPCP threat actor string"              -F -- "TeamPCP"
check "Compromised TanStack fork: zblgg/configuration" -F -- "zblgg/configuration"

# Note: previously had a check for the TanStack Router GHSA advisory ID
# (GHSA-g7cv-rxg3-hmpx). Removed because advisory identifiers appear
# legitimately in security documentation, dependabot output, runbooks,
# etc. — too loose to be a useful IoC, and exactly the kind of string a
# prompt-injection could plant disguised as harmless advisory metadata.
# Keep the IoC list to genuine malware fingerprints only.

# ---- Malware dropper filename. The 2.3 MB router_init.js implant was
#      injected directly into compromised tarballs. ----
files=$(find "$TARGET" -name 'router_init.js' -not -path '*/.git/*' -not -path '*/node_modules/*/router_init.js' 2>/dev/null | sani || true)
if [[ -n "$files" ]]; then
  red "  HIT: malware-associated filename present: router_init.js"
  printf '%s\n' "$files" | sed 's|^|    |'
  hits=$((hits + 1))
fi

echo
if [[ "$hits" -eq 0 ]]; then
  green "No Mini Shai-Hulud IoCs found in $TARGET."
  exit 0
else
  red "$hits IoC category/categories matched. Investigate the listed files before continuing."
  exit 1
fi
