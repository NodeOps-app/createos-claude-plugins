---
description: Create or reuse a persistent CreateOS project sandbox for this repo (one active box per git root). Warm box for repeated runs and live sync.
argument-hint: "[-s shape] [-r rootfs] [-n name] [-e dom|-p preset|-E]"
allowed-tools: Bash
---

Bring up (or reuse) the project sandbox. State is tracked per git root, so repeated runs reuse the same warm box. Egress defaults to the same baseline allowlist as `offload` (github/npm/pypi/crates); `-e <domain>` (repeatable) or `-p <preset>` (e.g. `python-uv`, `rust-cargo`, `npm`, `github`) swap in an exact set, or `-E` for unrestricted.

!`"${CLAUDE_PLUGIN_ROOT}/scripts/cos" up $ARGUMENTS`

Confirm the box id/shape above. Remember to `/createos-sandbox:down` when finished — a project box stays running (with a 30 m idle auto-pause backstop).
