---
description: Build a custom sandbox image (rootfs) from a Dockerfile so boxes boot with the toolchain already installed, instead of reinstalling dependencies on every offload. Also lists, inspects, and removes templates.
argument-hint: "submit <name> [-f Dockerfile] | ls | show <name> | logs [-f] <name> | rm <name>"
allowed-tools: Bash
---

Bake a toolchain into a reusable image. When the same `apt-get install` / `pip install` prelude runs at the start of every offload, moving it into a template turns minutes of setup per run into a boot.

The build service enforces constraints that only surface as a rejection after upload, so `cos` preflights the Dockerfile locally first: exactly one `FROM` (single-stage), an operator-allowlisted base image written literally (no `ARG` substitution), **no `COPY` or `ADD`** (no build context is uploaded — fetch inside a `RUN`), and 64 KiB of source at most. Two builds run concurrently per account.

!`"${CLAUDE_PLUGIN_ROOT}/scripts/cos" template $ARGUMENTS`

Once the template reports `ready`, boot from it with `cos up -r <name>` or `cos offload -r <name> . '<cmd>'`. Note that a custom image is slow on its first boot on each host (the image has to be fetched) and fast afterwards, whereas the built-ins (`devbox:1`, `ubuntu:26.04`, `debian:13`, `alpine:3.20`) are kept warm and never pull.
