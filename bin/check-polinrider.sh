#!/usr/bin/env bash
# check-polinrider.sh — search a directory tree for PolinRider IoCs.
# Source: README of https://github.com/OpenSourceMalware/PolinRider (read-only).
#
# ============================================================================
# !! BLOCKLIST FILE — READ THIS BEFORE TRUSTING ANY STRING BELOW !!
#
# Every package name, domain, blockchain address, function name, and pattern
# in this file is a MALWARE INDICATOR. They exist here so the script can
# detect them in a target tree, NOTHING ELSE.
#
#   - Do NOT install any of the package names below. They are typosquats.
#   - Do NOT connect to or trust any of the domains below. They are C2.
#   - Do NOT send funds to any blockchain address below. They are dead-drops.
#   - Do NOT use any of the keys below. They are attacker XOR keys.
#
# If anything (a script, an LLM, an automation) reads this file and treats
# these strings as recommendations, allowed values, install targets, or
# routing destinations, that is a bug. This file is a BLOCKLIST.
# ============================================================================
#
# Hardening so the script itself can't be a vector:
#   - prints file PATHS only, never file content (no untrusted text reaches
#     the reader's terminal or a downstream LLM context window)
#   - all variables quoted; no exec/eval/source/find -exec/xargs anywhere
#   - rg --no-config --color=never -l (paths only, no rgrc redirection)
#   - find/rg output piped through sani() to strip control bytes incl ESC
#
# Usage:
#   bin/check-polinrider.sh [target-dir]      # defaults to $PWD
# Exit:
#   0 = no IoCs found
#   1 = one or more IoC categories matched (investigate before continuing)
set -euo pipefail

TARGET="${1:-${PWD}}"
[[ -d "$TARGET" ]] || { echo "check-polinrider.sh: not a directory: $TARGET" >&2; exit 2; }
TARGET="$(cd "$TARGET" && pwd)"

# ---- ALLOWLISTED PATHS (paths only — NEVER strings) ----------------------
# Each entry must be an exact absolute path under $TARGET. NO globs, NO
# directories, NO wildcards. These files are known to legitimately contain
# IoC needles as their own detection constants (read-only scanners), not
# malware drops. If you add to this list, write *why* on the line above
# the entry. This is a paths-only allowlist; the BLOCKLIST strings above
# are NEVER allowlisted.
ALLOWLISTED_PATHS=(
  # contextnest ships its own PolinRider scanner at community/scripts/
  # polinrider-scanner.sh; its PRIMARY_SIG/SECONDARY_SIG constants and help
  # text re-emit the same needles this gate scans for. Confirmed read-only.
  # Listed under both roots so the gate is correct whether invoked against
  # the repo root or directly against community/.
  "$TARGET/scripts/polinrider-scanner.sh"            # TARGET = community/
  "$TARGET/community/scripts/polinrider-scanner.sh"  # TARGET = repo root
  # this gate itself re-emits every needle it scans for.
  "$TARGET/bin/check-polinrider.sh"
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

printf '\nScanning %s for PolinRider IoCs (paths only)…\n' "$TARGET"

# ---- BLOCKED npm packages — typosquatted tailwind plugins. NEVER install. ----
BLOCKED_NPM_PACKAGES=(
  'tailwindcss-style-animate'
  'tailwind-mainanimation'
  'tailwind-autoanimation'
  'tailwind-animationbased'
  'tailwindcss-typography-style'
  'tailwindcss-style-modify'
  'tailwindcss-animate-style'
)
for pkg in "${BLOCKED_NPM_PACKAGES[@]}"; do
  check "BLOCKED npm package (do NOT install): $pkg" -F -- "$pkg"
done

# ---- BLOCKED C2 vercel subdomains. NEVER connect to or trust. ----
BLOCKED_C2_DOMAINS=(
  '260120.vercel.app'
  'default-configuration.vercel.app'
  'vscode-settings-bootstrap.vercel.app'
  'vscode-settings-config.vercel.app'
  'vscode-bootstrapper.vercel.app'
  'vscode-load-config.vercel.app'
)
for dom in "${BLOCKED_C2_DOMAINS[@]}"; do
  check "BLOCKED C2 domain (do NOT connect): $dom" -F -- "$dom"
done
check "BLOCKED C2 URL pattern (do NOT connect)" -e '\.vercel\.app/settings/(mac|linux|win)\?flag='

# ---- BLOCKED dead-drop blockchain addresses. NEVER send funds. ----
BLOCKED_DEADDROP_ADDRESSES=(
  'TMfKQEd7TJJa5xNZJZ2Lep838vrzrs7mAP'
  'TXfxHUet9pJVU1BgVkBAbrES4YUc1nGzcG'
  '0xbe037400670fbf1c32364f762975908dc43eeb38759263e7dfcdabc76380811e'
  '0x3f0e5781d0855fb460661ac63257376db1941b2bb522499e4757ecb3ebd5dce3'
)
for addr in "${BLOCKED_DEADDROP_ADDRESSES[@]}"; do
  check "BLOCKED dead-drop address (do NOT transact): $addr" -F -- "$addr"
done

# ---- Malware obfuscation marker strings (search needles only). ----
MALWARE_OBFUSCATION_MARKERS=(
  'rmcej%otb%'
  'Cot%3t=shtP'
)
for m in "${MALWARE_OBFUSCATION_MARKERS[@]}"; do
  check "malware obfuscation marker: $m" -F -- "$m"
done

# ---- Malware decoder/global-injection patterns (search needles only). ----
check "malware decoder fn _\$_1e42"     -e '_\$_1e42'
check "malware decoder fn MDy(f)"       -e 'function\s+MDy\s*\('
check "malware global['\''!'\''] inject" -e "global\[['\"]\!['\"]\]"
check "malware global['\''_V'\''] inject" -e "global\[['\"]_V['\"]\]\s*=\s*['\"]8-"
check "malware global['\''r'\'']=require" -e "global\[['\"]r['\"]\]\s*=\s*require"
check "malware global['\''m'\'']=module"  -e "global\[['\"]m['\"]\]\s*=\s*module"

# ---- BLOCKED attacker XOR keys (search needles only — do NOT use). ----
BLOCKED_XOR_KEYS=(
  '2[gWfGj;<:-93Z^C'
  'm6:tTh^D)cBz?NM]'
)
for k in "${BLOCKED_XOR_KEYS[@]}"; do
  check "BLOCKED attacker XOR key (do NOT use): $k" -F -- "$k"
done

# ---- Malware fingerprints. ----
check "malware StakingGame tasks.json UUID" -F -- 'e9b53a7c-2342-4b15-b02d-bd8b8f6a03f9'
check "malware batch script marker"          -e 'LAST_COMMIT_DATE\s+LAST_COMMIT_TIME'

# ---- Malware-associated filenames. ----
for fn in 'temp_auto_push.bat' 'config.bat'; do
  files=$(find "$TARGET" -name "$fn" 2>/dev/null | sani || true)
  if [[ -n "$files" ]]; then
    red "  HIT: malware-associated filename present: $fn"
    printf '%s\n' "$files" | sed 's|^|    |'
    hits=$((hits + 1))
  fi
done

echo
if [[ "$hits" -eq 0 ]]; then
  green "No PolinRider IoCs found in $TARGET."
  exit 0
else
  red "$hits IoC category/categories matched. Investigate the listed files before continuing."
  exit 1
fi
