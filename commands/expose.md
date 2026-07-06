---
description: Give the active CreateOS project box a public HTTPS URL for one port. Stable link for the box's lifetime — good for sharing a live preview or webhook target.
argument-hint: "<port>"
allowed-tools: Bash
---

Enable public ingress and print the HTTPS URL for `<port>`. The service **must bind `0.0.0.0:<port>`** (not `127.0.0.1`) — ingress forwards to the box's external interface. The URL stays live while the box does. Revoke with `cos unexpose`. For a private, local-only link use `/createos-sandbox:tunnel`.

!`"${CLAUDE_PLUGIN_ROOT}/scripts/cos" expose $ARGUMENTS`

Report the URL above and flag to the user that **anyone with the link can reach it** — don't expose services that assume a private network.
