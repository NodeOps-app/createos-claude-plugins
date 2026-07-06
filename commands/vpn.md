---
description: WireGuard L3 VPN from THIS machine into your CreateOS private networks — reach every sandbox by name/IP as if local. Needs wg-quick + sudo; the connection blocks until Ctrl-C.
argument-hint: "[register <name> | up]"
allowed-tools: Bash
---

WireGuard VPN into your private networks (whole-network L3, vs `tunnel`'s single port). One-time setup: `cos vpn register <name>`. Then `cos vpn up` connects until Ctrl-C. Requires `wg-quick` installed and sudo for routes.

**`cos vpn up` blocks the shell until you disconnect** — run it yourself in a separate terminal (type `!cos vpn up` in the Claude prompt, or run it directly), not as a foreground agent command. `cos` needs `scripts/cos install` first, or invoke by full path (`!"$CLAUDE_PLUGIN_ROOT"/scripts/cos vpn up`).

!`test -n "$ARGUMENTS" && "${CLAUDE_PLUGIN_ROOT}/scripts/cos" vpn $ARGUMENTS || echo "Setup (once): cos vpn register <name>   Connect (blocks, needs sudo): cos vpn up   — run these in your own terminal, e.g. !cos vpn up"`

If setup output appears above, relay it. Do not launch the long-lived `cos vpn up` yourself — hand that command to the user.
