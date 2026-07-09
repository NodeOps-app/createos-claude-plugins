---
description: Tear down the active CreateOS project sandbox — stop any background sync and destroy the box, clearing project state.
allowed-tools: Bash
---

Stop the sync (if running) and destroy the active project box.

A box adopted via `cos up -a` is never destroyed here — it is reported instead. Forks
survive too, and are named on teardown; `cos down -f` reaps them along with the box.

!`"${CLAUDE_PLUGIN_ROOT}/scripts/cos" down`

Confirm the box was destroyed above, and surface any adopted box or surviving fork the
output names — those are still running and still billing.
