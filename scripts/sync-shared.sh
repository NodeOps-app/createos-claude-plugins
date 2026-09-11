#!/usr/bin/env bash
# Copy shared sources into the packages that ship them.
#
# Two canonical trees:
#   packages/claude-code-plugin/  — the `cos` bash driver, the skill, the hooks
#   packages/shared/              — sandbox-engine.ts, the same semantics in TS
#
# Symlinks would be the obvious answer and do not work: the Codex plugin
# installer copies regular files only, so a symlinked repo installs with no
# driver and no skill at all — silently. Verified against codex-cli 0.153.4.
# Hence real copies, plus `--check` in CI so they cannot drift the way codex's
# SKILL.md drifted 77 lines behind.
#
# Usage: scripts/sync-shared.sh [--check]
set -euo pipefail

cd "$(dirname "$0")/.."

# Each entry is "<source path>:<destination path>".
PAIRS=(
  "packages/claude-code-plugin/scripts/cos:packages/codex-plugin/scripts/cos"
  "packages/claude-code-plugin/scripts/offload-hint.sh:packages/codex-plugin/scripts/offload-hint.sh"
  "packages/claude-code-plugin/skills/using-createos-sandbox/SKILL.md:packages/codex-plugin/skills/using-createos-sandbox/SKILL.md"
  "packages/claude-code-plugin/skills/using-createos-sandbox/references/lifecycle-and-images.md:packages/codex-plugin/skills/using-createos-sandbox/references/lifecycle-and-images.md"
  "packages/claude-code-plugin/skills/using-createos-sandbox/references/networking.md:packages/codex-plugin/skills/using-createos-sandbox/references/networking.md"
  "packages/claude-code-plugin/skills/using-createos-sandbox/references/offload-and-egress.md:packages/codex-plugin/skills/using-createos-sandbox/references/offload-and-egress.md"
  "packages/shared/sandbox-engine.ts:packages/opencode-plugin/src/sandbox-engine.ts"
  "packages/shared/sandbox-engine.ts:packages/pi-extension/src/sandbox-engine.ts"
)

check=0
[ "${1:-}" = "--check" ] && check=1
drift=0

for pair in "${PAIRS[@]}"; do
  src=${pair%%:*}
  dst=${pair#*:}
  [ -f "$src" ] || { echo "missing source: $src" >&2; exit 1; }
  if [ "$check" = 1 ]; then
    if ! diff -q "$src" "$dst" >/dev/null 2>&1; then
      echo "DRIFT: $dst differs from $src"
      drift=1
    fi
  else
    mkdir -p "$(dirname "$dst")"
    cp "$src" "$dst"
    [ -x "$src" ] && chmod +x "$dst"
  fi
done

if [ "$check" = 1 ]; then
  if [ "$drift" = 0 ]; then
    echo "shared files in sync (${#PAIRS[@]} copies)"
  else
    echo "run scripts/sync-shared.sh to fix" >&2
    exit 1
  fi
else
  echo "synced ${#PAIRS[@]} copies"
fi
