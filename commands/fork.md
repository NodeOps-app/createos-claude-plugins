---
description: Snapshot the active CreateOS project box and fork it into an independent clone (pauses briefly, then resumes). For matrix / parallel experiments from identical warm state.
allowed-tools: Bash
---

Pause the project box, fork its snapshot into a new independent sandbox (auto-resumes), then resume the project box. The clone starts from identical state and diverges from there. It is **not** tracked as the project box — manage it via the printed `exec`/`destroy` commands.

!`"${CLAUDE_PLUGIN_ROOT}/scripts/cos" fork`

Report the fork id above and remind the user to `createos sandbox rm -y <id>` when done — clones count against the 2-running quota.
