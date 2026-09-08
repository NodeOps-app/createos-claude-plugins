---
description: Drive the desktop in the active CreateOS box — screenshot, move/click, type, press keys, open a URL, list windows. Computer-use for a sandboxed Linux desktop.
argument-hint: "screenshot | screen | click <x> <y> | type <text> | key <k>... | open <url> | windows"
allowed-tools: Bash
---

Send one computer-use action to the desktop in the project box. Run `/createos-sandbox:desktop` first — it creates the graphical box and waits for the desktop to be ready.

!`"${CLAUDE_PLUGIN_ROOT}/scripts/cos" computer $ARGUMENTS`

Notes for acting on the result:

- `screenshot` writes a PNG and prints its path — **open that path with the Read tool** to actually see the screen. Take one before and after any action you are unsure about.
- Coordinates are raw X11 pixels of that screen. Get the bounds from `cos computer screen`; nothing scales them for you.
- A `409` means the desktop did not answer. It is fc's catch-all: the desktop may still be booting, or the action itself failed on a live desktop. Re-run `/createos-sandbox:desktop` (it polls for readiness) before assuming the box is broken.
- `cos computer help` lists every op, and `cos computer raw <METHOD> <path> [json]` reaches the endpoints not wrapped here (mouse drag/scroll, window focus/move/resize, clipboard, multi-screen).
