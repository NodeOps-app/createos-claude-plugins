---
description: Start a background file sync between a local dir and the active CreateOS project box. Default one-way (laptop→box, safe). For live dev-server/watcher loops.
argument-hint: "[-2|-M] [-x glob] <local-dir> [remote-dir]"
allowed-tools: Bash
---

Default is **one-way** (laptop → box): your edits propagate in, box-side writes never touch local. `.git` is skipped automatically. Flags: `-2` two-way (box writes flow back), `-M` mirror (deletes box-side extras), `-x <glob>` exclude (repeatable). Flags precede the positionals. Only use `-2` when a box-side process produces files you need back — and confirm before two-waying the user's own files.

!`"${CLAUDE_PLUGIN_ROOT}/scripts/cos" sync $ARGUMENTS`

Runs in the background (first run downloads Mutagen, ~60–90 s). Start a watcher/dev-server with `/createos-sandbox:run`, then edit files locally — changes propagate. Stop everything with `/createos-sandbox:down`.
