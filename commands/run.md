---
description: Run a command in the active CreateOS project sandbox (created by /createos-sandbox:up). Streamed output; box persists.
argument-hint: "<cmd>"
allowed-tools: Bash
---

Execute in the active project box (deps and files persist across runs).

!`"${CLAUDE_PLUGIN_ROOT}/scripts/cos" run $ARGUMENTS`

If this fails with "no active box", run `/createos-sandbox:up` first.
