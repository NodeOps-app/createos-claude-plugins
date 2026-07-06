---
description: Run each of several commands in its OWN throwaway CreateOS box, in parallel (staged from a dir), collect per-job results, auto-destroy. For test shards, config matrices, batch jobs.
argument-hint: "[-j N] [-p preset] [-s shape] [-x glob] <dir> <cmd1> [cmd2] ..."
allowed-tools: Bash
---

Fan a set of commands across isolated throwaway boxes concurrently — each `<cmdN>` runs in its own box staged from `<dir>`, keepalive-protected. Per-job logs + exit codes are summarized at the end; every box auto-destroys. Default concurrency `-j 2` (external-key quota is 2 running at once) — raise only if your plan allows. Big dirs (`node_modules`/`target`/…) are excluded from the upload.

!`test -n "$ARGUMENTS" && "${CLAUDE_PLUGIN_ROOT}/scripts/cos" fanout $ARGUMENTS || "${CLAUDE_PLUGIN_ROOT}/scripts/cos" fanout`

Report each job's `rc` + log path above. This is distinct from `/createos-sandbox:cluster` (which networks boxes together) — fanout boxes are independent and never see each other.
