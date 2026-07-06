---
description: One-shot offload to a disposable CreateOS sandbox — stage a dir, run a command (keepalive-protected), optionally pull artifacts, auto-destroy. For heavy/untrusted/clean-room builds and tests.
argument-hint: "[-p preset] [-e dom] [-E] [-x glob] [-o out] [-w GB] [-K] [-s shape] <dir> <cmd>"
allowed-tools: Bash
---

Offload to a throwaway CreateOS microVM. Flags precede `<dir> <cmd>`. Egress defaults to a baseline allowlist (github/npm/pypi/crates); `-p python-uv|rust-cargo|npm|github` swaps in an exact set (compose with `-e <dom>` for extras), or `-E` for unrestricted; `-x <glob>` adds upload excludes (`.git`/`target`/`node_modules`/… already excluded); `-o <dir>` pulls artifacts back; `-w <GB>` swap; `-K` keep box on failure. Long/quiet builds survive exec-stream drops (detached run + heartbeat + re-attach). Shapes are plan-gated.

!`test -n "$ARGUMENTS" && "${CLAUDE_PLUGIN_ROOT}/scripts/cos" offload $ARGUMENTS || "${CLAUDE_PLUGIN_ROOT}/scripts/cos" offload`

Report the command's stdout and exit status above. If `-o` was given, note which artifacts came back. If a locked-down build fails on a missing host, add it with `-e <host>` or the matching `-p` preset.
