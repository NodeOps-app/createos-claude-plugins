---
description: Spin up an instant throwaway CreateOS Linux box and drop into an interactive shell; the box is destroyed on exit. For a quick clean-room to poke at something without touching your laptop.
argument-hint: "[-s shape] [-r rootfs] [-e dom|-p preset|-E]"
allowed-tools: Bash
---

Instant scratch Linux (keyless). `cos shell` creates a disposable box, opens an interactive shell, and destroys it when you exit. Egress defaults to the baseline allowlist (github, npm, pypi, crates); `-e <domain>`/`-p <preset>` swap in an exact set, or `-E` for unrestricted.

**Interactive — it takes over the terminal**, so it can't run as a foreground agent command. Run it yourself: type `!cos shell` in the Claude prompt (add flags like `-s s-2vcpu-2gb` or `-e`/`-p`/`-E` as needed) — `cos` needs `scripts/cos install` first, or invoke it by full path (`!"$CLAUDE_PLUGIN_ROOT"/scripts/cos shell`).

!`echo "Run interactively in your own terminal:  !cos shell   (flags: -s <shape> -r <rootfs> -e <dom>|-p <preset>|-E; default egress is the allowlist; needs 'scripts/cos install' first, or invoke by full path). It creates a throwaway box, opens a shell, and destroys it on exit."`
