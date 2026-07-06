---
description: Revoke the public HTTPS URL for the active CreateOS project box — disables ingress.
allowed-tools: Bash
---

Disable public ingress on the active project box. The `expose` URL stops resolving; the box itself keeps running.

!`"${CLAUDE_PLUGIN_ROOT}/scripts/cos" unexpose`

Report the result above to the user.
