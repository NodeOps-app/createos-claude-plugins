---
description: Bring up a graphical CreateOS box (desktop:1 — XFCE + Chrome) and print a live noVNC URL the user can open in a browser to watch or drive it.
argument-hint: "[-s shape] [-S screen-N]"
allowed-tools: Bash
---

Create or reuse the project box on the `desktop:1` rootfs, enable ingress, wait for the desktop stack to boot, and mint a noVNC URL. The box carries XFCE, Google Chrome, and `xdotool`/`wmctrl`/`scrot`/`xclip`, plus the Claude Code, Codex, Pi, OpenCode and Cursor CLIs preinstalled — so it doubles as a place to watch an agent CLI work on a real screen.

Use `/createos-sandbox:computer` to drive the same desktop yourself (screenshot, click, type).

!`"${CLAUDE_PLUGIN_ROOT}/scripts/cos" desktop $ARGUMENTS`

Report the URL above and tell the user two things plainly: **anyone with that link can drive the desktop**, and the token expires (the command prints when). Re-running this command mints a fresh link.

If it reports the project box is not a desktop image, do **not** destroy the box to fix it — say so and let the user decide, since `cos down` throws away whatever is on it.
