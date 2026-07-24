---
description: Resume the paused CreateOS project sandbox — restores disk, memory and running processes exactly as they were. Use after /createos-sandbox:pause or after the 30 m idle auto-pause kicked in.
allowed-tools: Bash
---

Bring the paused project box back. The snapshot restores exactly — files, installed dependencies, and processes that were running when it paused. End to end this takes a handful of seconds — measured at around 7 s — and longer if the snapshot has to be pulled to a different host than the one it was taken on.

!`"${CLAUDE_PLUGIN_ROOT}/scripts/cos" resume`

If the user had a file sync, a tunnel, or a public URL up before the pause, remind them to re-run `/createos-sandbox:sync`, `/createos-sandbox:tunnel`, or `/createos-sandbox:expose` — those do not survive a pause.
