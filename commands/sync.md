---
description: Start a two-way file sync between a local dir and the active CreateOS project box (background). For live dev-server/watcher loops. WARNING — bidirectional.
argument-hint: "<local-dir> [remote-dir]"
allowed-tools: Bash
---

⚠ **Two-way Mutagen mirror.** Sandbox-side writes (`node_modules`, build output, `.git`) flow BACK into the local dir. Sync a scoped subdir, never a repo root full of artifacts. Confirm with the user before syncing anything they care about.

!`"${CLAUDE_PLUGIN_ROOT}/scripts/cos" sync $ARGUMENTS`

The sync runs in the background. Start a watcher/dev-server with `/createos-sandbox:run`, then edit files locally — changes propagate. Stop everything with `/createos-sandbox:down`.
