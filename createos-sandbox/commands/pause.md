---
description: Pause the active CreateOS project sandbox — snapshots disk + memory to storage so a warm box (installed deps, running processes) costs nothing while idle. Resume brings it back intact.
allowed-tools: Bash
---

Park the project box instead of destroying it. Pause snapshots the full VM — disk, memory, running processes — and frees the host, so compute billing stops while everything survives. This is the cheap alternative to `/createos-sandbox:down`, which destroys the box and forces the next session to reinstall every dependency.

A live sync and any open tunnels are torn down first (a paused box serves no traffic); re-establish them after resume.

!`"${CLAUDE_PLUGIN_ROOT}/scripts/cos" pause`

Tell the user the box is parked and that `/createos-sandbox:resume` brings it back — same files, same deps, same disks.
