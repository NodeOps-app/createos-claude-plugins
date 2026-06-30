---
description: One-shot offload to a disposable CreateOS sandbox — stage a dir, run a command, optionally pull artifacts back, auto-destroy. For heavy/untrusted/clean-room work.
argument-hint: "[-s shape] [-r rootfs] [-e egress] [-o out] <dir> <cmd>"
allowed-tools: Bash
---

Offload to a throwaway CreateOS microVM. Flags come before the `<dir> <cmd>` positionals. The box is always destroyed afterward.

!`"${CLAUDE_PLUGIN_ROOT}/scripts/cos" offload $ARGUMENTS`

Report the command's stdout and exit status above. If `-o` was given, note which artifacts were pulled back into the staged dir.
