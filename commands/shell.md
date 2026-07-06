---
description: Spin up an instant throwaway CreateOS Linux box and drop into an interactive shell; the box is destroyed on exit. For a quick clean-room to poke at something without touching your laptop.
argument-hint: "[-s shape] [-r rootfs]"
allowed-tools: Bash
---

Instant scratch Linux (keyless). `cos shell` creates a disposable box, opens an interactive shell, and destroys it when you exit.

**Interactive — it takes over the terminal**, so it can't run as a foreground agent command. Run it yourself: type `!cos shell` in the Claude prompt (add flags like `-s s-2vcpu-2gb` as needed).

!`echo "Run interactively in your own terminal:  !cos shell   (flags: -s <shape> -r <rootfs>). It creates a throwaway box, opens a shell, and destroys it on exit."`
