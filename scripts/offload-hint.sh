#!/usr/bin/env bash
# PreToolUse(Bash) hook — non-blocking nudge to offload heavy builds/tests to a
# disposable CreateOS sandbox. Advisory only: it NEVER blocks the command, it just
# adds a one-line suggestion to context. Silence with COS_NO_HINT=1.
set -euo pipefail
[ -n "${COS_NO_HINT:-}" ] && exit 0
command -v jq >/dev/null 2>&1 || exit 0

input=$(cat)
cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // empty' 2>/dev/null || true)
[ -n "$cmd" ] || exit 0

# never nudge for sandbox/control/VCS commands themselves
case "$cmd" in
  *cos\ *|*createos\ *|*scratch\ *|*git\ *|*docker\ *) exit 0 ;;
esac

# heavy build/test signatures worth isolating off-machine
if printf '%s' "$cmd" | grep -Eq \
  '(^|[;&|[:space:]])(make|mvn|gradle|gradlew|bazel|tox|cmake|ctest)([[:space:]]|$)|npm[[:space:]](ci|install|run[[:space:]]build|test)|pnpm[[:space:]](i|install|run|test)|yarn[[:space:]](install|build|test)|pip[[:space:]]install|pytest|go[[:space:]]test|cargo[[:space:]](build|test)'; then
  msg='[createos-sandbox] Heavy build/test detected. Consider offloading to a throwaway sandbox to keep the laptop free and isolate deps: /createos-sandbox:offload . "<cmd>" (or scripts/cos offload). Proceed locally if it needs local state/secrets. Silence: COS_NO_HINT=1.'
  jq -nc --arg m "$msg" '{hookSpecificOutput:{hookEventName:"PreToolUse",additionalContext:$m}}'
fi
exit 0
