#!/usr/bin/env bash
# SessionStart hook — publish the absolute path of the `cos` driver into context.
#
# Why this exists (ADR-0001): slash commands get ${CLAUDE_PLUGIN_ROOT} expanded at
# command-load time, but the Bash tool's environment does NOT carry that variable.
# So when the *skill* tells Claude to run "${CLAUDE_PLUGIN_ROOT}/scripts/cos", it
# expands to "/scripts/cos" and dies with exit 127 — and the observed failure mode
# is fail-OPEN: the agent hand-rolls the offload from raw `createos` primitives and
# silently loses egress restriction, keepalive, auto-destroy, and the auth preflight.
#
# Hooks *do* get CLAUDE_PLUGIN_ROOT, so resolving it here and stating the literal
# path is enough to close the gap with no filesystem mutation. Deleted alongside
# `cos` if the engine ever moves into createos-cli.
set -euo pipefail

root=${CLAUDE_PLUGIN_ROOT:-}
[ -n "$root" ] || exit 0
cos="$root/scripts/cos"

command -v jq >/dev/null 2>&1 || exit 0

# A missing or non-executable driver is exactly the case the fail-closed rule
# exists for, so it must still be stated — exiting quietly here would leave the
# agent with no driver AND no instruction, which is how the original fail-open
# happened. Say it plainly instead.
if [ ! -x "$cos" ]; then
  jq -nc --arg m "[createos-sandbox] The sandbox driver is MISSING or not executable at: $cos
Do not attempt sandbox work. Do NOT substitute raw \`createos sandbox\` primitives — that drops egress restriction, keepalive, auto-destroy and the auth preflight. Tell the user the plugin looks broken and stop." \
    '{hookSpecificOutput:{hookEventName:"SessionStart",additionalContext:$m}}'
  exit 0
fi

if command -v cos >/dev/null 2>&1; then
  where="\`cos\` is already on PATH — call it bare."
else
  where="\`cos\` is NOT on PATH. Call it by this absolute path, or run \`$cos install\` once to symlink it into ~/.local/bin."
fi

# The verb rule lives here, not only in the skill. Measured behaviour: on an
# autonomous "run this off my machine" task the model reaches straight for Bash
# and never invokes the skill, so SKILL.md's guidance is not in context when the
# decision is made. It then picks `up`+`run` and hand-rolls tar/base64 staging —
# work `offload` already does. These four lines are the ones that must always be
# present; everything else stays in the skill.
msg="[createos-sandbox] The sandbox driver is at: $cos
$where
Never expand \${CLAUDE_PLUGIN_ROOT} yourself in a Bash command — that variable is unset in the Bash tool environment and the path will resolve to /scripts/cos. If the driver cannot be run, stop and say so; do not substitute raw \`createos sandbox\` primitives, which drop egress restriction, keepalive, auto-destroy, and the auth preflight.

Picking the verb (get this right before running anything):
- Work with a finish line — run a test suite, a build, a script: \`cos offload <dir> '<cmd>'\`. ONE command. It creates the box, ships <dir> for you, runs, and destroys the box. Do NOT tar, base64, or push files in by hand, and do NOT use \`cos up\` for this.
- Work that must outlive one command — a dev server you'll hit repeatedly, a watcher, a multi-command session: \`cos up\`, then \`cos run\`, then \`cos pause\` or \`cos down\`.
- \`cos run\` takes the command as one plain string; there is no \`--\` separator. Run \`$cos help\` for the full verb list, and read the using-createos-sandbox skill before anything involving egress restriction, networking, or file sync."

jq -nc --arg m "$msg" '{hookSpecificOutput:{hookEventName:"SessionStart",additionalContext:$m}}'
