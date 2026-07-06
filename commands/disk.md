---
description: Manage BYO S3 bucket mounts for the CreateOS project box — register an S3 disk, attach/detach, list, remove. For datasets, model weights, or a shared build cache that survives box death.
argument-hint: "create <name> --bucket … | ls | attach <disk> <mount> | detach <disk> <mount> | rm <name>"
allowed-tools: Bash
---

Mount your own S3-compatible bucket into the project box. `create` registers a disk (`--bucket`/`--endpoint`/`--access-key`/`--secret-key`, `--path-style` for MinIO/R2); `attach <disk> <mount-path>` mounts it on the active box (`/createos-sandbox:up` first); `detach` unmounts (the bucket is untouched). Data stays in your account/region.

!`test -n "$ARGUMENTS" && "${CLAUDE_PLUGIN_ROOT}/scripts/cos" disk $ARGUMENTS || "${CLAUDE_PLUGIN_ROOT}/scripts/cos" disk`

Credentials are passed through to the `createos` CLI — use scoped, least-privilege S3 keys.
