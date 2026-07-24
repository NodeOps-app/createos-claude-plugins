<div align="center">

# createos-sandbox

**Run ad-hoc, heavy, or untrusted code off your machine — from inside Claude Code.**

A [Claude Code](https://docs.claude.com/en/docs/claude-code) plugin that gives Claude a skill + 18 slash commands driving the authed [`createos`](https://createos.sh) CLI. Work runs in disposable [CreateOS](https://createos.sh) Sandboxes — roughly 200 ms from create to your first command — that self-destruct when done.

[![Claude Code](https://img.shields.io/badge/Claude%20Code-plugin-6E56CF)](https://docs.claude.com/en/docs/claude-code)
[![CreateOS](https://img.shields.io/badge/CreateOS-Sandboxes-0EA5E9)](https://createos.sh)
[![Version](https://img.shields.io/badge/version-0.5.0-blue)](./.claude-plugin/plugin.json)

</div>

---

## Contents

- [Why offload?](#why-offload)
- [How it works](#how-it-works)
- [Two patterns](#two-patterns)
- [Install](#install)
- [Requirements](#requirements)
- [Command reference](#command-reference)
  - [Offload — one-shot](#offload--one-shot)
  - [Fanout — parallel boxes](#fanout--parallel-boxes)
  - [Shell — throwaway Linux](#shell--throwaway-linux)
  - [Project box — live sessions](#project-box--live-sessions)
  - [Networking](#networking)
  - [Pause, resume, and custom images](#pause-resume-and-custom-images)
  - [Disks — BYO S3](#disks--byo-s3)
- [Egress control](#egress-control)
- [Heavy builds](#heavy-builds)
- [Uploads & excludes](#uploads--excludes)
- [Shapes](#shapes)
- [The skill](#the-skill)
- [Hooks](#hooks)
- [Direct CLI cookbook](#direct-cli-cookbook)
- [Safety & scope](#safety--scope)
- [Environment variables](#environment-variables)
- [Troubleshooting](#troubleshooting)

## Why offload?

Heavy builds, flaky test suites, and untrusted code don't belong on your laptop:

- **Untrusted code** — a dependency's post-install script or an AI-generated snippet runs in a disposable Sandbox, not your shell. Egress can be locked to an exact allowlist.
- **Heavy work** — `npm ci`, `cargo build`, `pytest`, `go test`, torch installs — keep your machine cool and free while a bigger box does the grind.
- **Parallel / matrix** — split a test suite or a version matrix across N isolated boxes at once.
- **Clean-room repros** — reproduce a bug on a pristine Linux box with nothing of yours leaking in.
- **Live dev loops** — a reusable per-repo box with file sync, so a dev server or watcher inside the box reacts to your local edits.

## How it works

```
Claude Code
   │  slash command (/createos-sandbox:offload …)   or   the skill decides to offload
   ▼
scripts/cos            ← this plugin's driver (a portable bash script)
   │  wraps + hardens
   ▼
createos CLI           ← authed control-plane client (auto-installs on first use)
   │
   ▼
CreateOS Sandbox               ← your code runs here, then the box is destroyed
```

The plugin is a **thin Claude-facing surface** over the `createos` CLI. It ships four things:

| Piece | Path | Role |
|---|---|---|
| **Slash commands** | `commands/*.md` | 18 commands (`offload`, `fanout`, `shell`, …), each a thin wrapper that calls `scripts/cos` |
| **Skill** | `skills/using-createos-sandbox/SKILL.md` + `references/` | teaches Claude *when* to reach for the sandbox on its own, with depth loaded on demand |
| **Hooks** | `hooks/hooks.json` + `scripts/` | `SessionStart` publishes the driver's absolute path; `PreToolUse(Bash)` nudges on heavy build/test commands |
| **Driver** | `scripts/cos` | the actual logic — staging, egress, keepalive, sync, networking, lifecycle, state |

Slash commands invoke `${CLAUDE_PLUGIN_ROOT}/scripts/cos`, which Claude Code expands when the command is loaded. **The Bash tool's own environment does not carry that variable**, so when the *skill* decides to offload on its own it needs a real path — that is what the `SessionStart` hook supplies. Without it the path collapses to `/scripts/cos`, and the observed failure mode is Claude quietly rebuilding the offload out of raw CLI primitives, losing egress restriction, keepalive, auto-destroy, and the auth preflight along the way. See [ADR-0001](../docs/adr/0001-cos-bash-driver.md).

## Two patterns

**1. One-shot offload** (default, safe)
Stage a dir → exec → optionally pull artifacts → **auto-destroy**. One-way: box-side changes never touch local unless you ask (`-o`). Best for builds, tests, and untrusted code.

**2. Live session** (opt-in)
A reusable per-repo box + one-way file sync (default; `-2` for two-way). A dev server or watcher inside the box reacts to your local edits. Best for interactive dev loops, long-running services, and networking.

## Install

**From the marketplace (recommended):**
```
/plugin marketplace add NodeOps-app/createos-claude-plugins
/plugin install createos-sandbox@createos
```

**Dev (instant, no install):**
```bash
claude --plugin-dir /path/to/createos-claude-plugins/createos-sandbox
/reload-plugins      # after editing plugin files
```

### Put `cos` on your PATH (optional but recommended)

`cos` is **not on `PATH`** by default. To use bare `cos` in your own terminal, run its installer once by absolute path:

```bash
/path/to/createos-claude-plugins/createos-sandbox/scripts/cos install   # symlinks to ~/.local/bin/cos
```

`${CLAUDE_PLUGIN_ROOT}` only expands inside slash-command frontmatter — it is **not** set in your shell, nor in Claude's Bash tool environment. Slash commands resolve the path for you; for autonomous skill use the `SessionStart` hook publishes it. Running `cos install` once removes the question entirely.

## Requirements

- **A [CreateOS](https://createos.sh) account.** The `createos` CLI **auto-installs** if missing — on first use `cos` runs the official one-liner (`curl -sfL …/install.sh | sh -`). Opt out with `COS_NO_AUTOINSTALL=1`; override the install source with `COS_CLI_INSTALL_URL`.
- **Sign in, one of two ways.** Verify either with `cos auth`.
  - **Browser (recommended)** — run `createos login` **in your own terminal** and pick "Sign in with browser". This is an interactive prompt, so Claude cannot run it for you; the OAuth session lands in `~/.createos/.oauth`.
  - **API key** — `export CREATEOS_API_KEY=<key>` (grab one from the [dashboard](https://createos.sh)). Set it and browser login is skipped entirely — the right choice for CI, headless boxes, and devcontainers. Export it in the shell that launches Claude Code; never paste it into a Claude conversation, where it would be written to the transcript.
- **Host tools:** `jq`, `tar`, `bash`, `base64` (required); `perl` (ANSI stripping / path resolution); `shasum` (falls back to `sha1sum`/`sha256sum`); `curl` (one-time CLI install only).
- **Optional per feature:** `wg-quick` + `sudo` for [`vpn`](#networking); the current `createos` CLI for sync `--mode`/`--exclude` (an old CLI falls back to two-way with a warning).

## Command reference

| Command | Summary |
|---|---|
| [`offload`](#offload--one-shot) `[flags] <dir> <cmd>` | one-shot: stage → run (keepalive) → pull → destroy |
| [`fanout`](#fanout--parallel-boxes) `[-j N] [flags] <dir> <cmd1> [cmd2] …` | run each command in its own throwaway box, in parallel |
| [`shell`](#shell--throwaway-linux) `[-s] [-r] [-e\|-p\|-E]` | instant throwaway interactive Linux (destroyed on exit) |
| [`up`](#project-box--live-sessions) `[-s] [-r] [-n] [-e\|-p\|-E]` | create/reuse the per-repo project box |
| [`run`](#project-box--live-sessions) `<cmd>` | exec in the project box (streamed, state persists) |
| [`sync`](#project-box--live-sessions) `[-2\|-M] [-x glob] <local-dir> [remote-dir]` | file sync into the project box (background) |
| [`tunnel`](#networking) `<remote> [local]` | forward a box port to `127.0.0.1` (private) |
| [`expose`](#networking) `<port>` | public HTTPS URL for a box port |
| [`unexpose`](#networking) | revoke the public URL / disable ingress |
| [`cluster`](#networking) `up <N> \| run […] <cmd> \| ls \| down` | N boxes on one private network, name-addressable |
| [`disk`](#disks--byo-s3) `create \| ls \| show \| attach \| detach \| rm` | BYO S3 bucket mounts on the project box |
| [`vpn`](#networking) `[register <name> \| up]` | WireGuard L3 into your private networks |
| [`fork`](#networking) | snapshot the project box → independent clone |
| [`pause`](#pause-resume-and-custom-images) · [`resume`](#pause-resume-and-custom-images) | park the warm project box at zero compute cost / restore it exactly |
| [`template`](#pause-resume-and-custom-images) `submit <name> [-f Dockerfile] \| ls \| show \| logs \| rm` | build a custom rootfs so boxes boot pre-provisioned |
| [`down`](#project-box--live-sessions) | stop sync/tunnels + destroy the project box (+ cluster) |
| [`status`](#project-box--live-sessions) | show active box + sync + tunnels + cluster |

> **Flag order:** flags (`-s/-r/-e/-p/-E/-o/-x/-w/-K`) come **before** the positional `<dir> <cmd>`.

### Offload — one-shot

The core command. Stages a directory into a fresh box, runs a command, optionally pulls artifacts back, then destroys the box.

```
/createos-sandbox:offload [-p preset] [-e dom] [-E] [-x glob] [-o out] [-w GB] [-K] [-s shape] [-r rootfs] <dir> <cmd>
```

| Flag | Meaning |
|---|---|
| `-s <shape>` | box size (default `s-1vcpu-1gb`; see [Shapes](#shapes)) |
| `-r <rootfs>` | root filesystem image (default `devbox:1`) |
| `-o <out>` | tar a box-side dir and pull it back to local |
| `-w <GB>` | attempt swap (see caveat under [Heavy builds](#heavy-builds)) |
| `-K` | keep the box on a real failure so you can inspect it |
| `-e <domain>` | allow one egress domain (repeatable) |
| `-p <preset>` | egress preset — `python-uv \| rust-cargo \| npm \| github` (repeatable, composes with `-e`) |
| `-E` | unrestricted egress (trusted offload) |
| `-x <glob>` | extra upload exclude (repeatable) |

```bash
# Run a test suite, pull nothing, box auto-destroys
/createos-sandbox:offload . "npm ci && npm test"

# Python build with locked egress, pull the dist/ folder back
/createos-sandbox:offload -p python-uv -o dist . "uv sync --frozen && uv run python -m build"
```

**Keepalive:** long or quiet compiles no longer die to exec-stream idle resets — the command runs detached with a heartbeat and re-attaches if the stream drops, so the build (and its cache) survives.

### Fanout — parallel boxes

Run each command in its **own** throwaway box, in parallel, then collect results. Ideal for splitting a test suite or a version matrix.

```
/createos-sandbox:fanout [-j N] [-p preset] [-s shape] [-r rootfs] [-e dom] [-E] [-x glob] <dir> <cmd1> [cmd2] …
```

- `-j N` — max concurrent boxes (**default 2**, the external-key running-quota). Other flags mirror `offload`.
- Exit codes are aggregated across boxes; each box is fully isolated from the others.

```bash
/createos-sandbox:fanout -j 2 -p python-uv . "pytest -q tests/a" "pytest -q tests/b" "pytest -q tests/c"
```

### Shell — throwaway Linux

An instant, interactive Linux box that is **destroyed on exit**.

```
/createos-sandbox:shell [-s shape] [-r rootfs] [-e dom | -p preset | -E]
```

> **Interactive — it takes over the terminal**, so it can't run as a foreground agent command. Run it yourself: type `!cos shell` in the Claude prompt (needs `cos install` first, or use the full path). Egress is unrestricted by default like `offload`; `-e`/`-p` restrict it.

### Project box — live sessions

A **reusable, per-repo** box addressed by your working directory. `up` creates it (or adopts an existing running one); `run` execs in it with persistent state; `sync` streams files in; `down` tears it all down.

```
/createos-sandbox:up   [-s shape] [-r rootfs] [-n name] [-e dom | -p preset | -E]
/createos-sandbox:run  <cmd>
/createos-sandbox:sync [-2 | -M] [-x glob] <local-dir> [remote-dir]
/createos-sandbox:down
/createos-sandbox:status
```

- **`up`** is idempotent — run it again on the same repo and it reuses the same box instead of creating a new one.
- **`run`** streams output and keeps box-side state between calls (installed deps, running processes).
- **`sync`** is **one-way by default** (laptop → box). `-2` = two-way (box writes flow back), `-M` = mirror (deletes box-side extras), `-x <glob>` = exclude. First run downloads Mutagen (~60–90 s before edits propagate). **Install deps *inside* the box** (`cos run 'npm ci'`) rather than syncing `node_modules` up — big/regenerable dirs are excluded by default.
- **`pause`/`resume`** park the box at zero compute cost and bring it back exactly — see [Pause, resume, and custom images](#pause-resume-and-custom-images). Prefer `pause` over `down` when the box has a warm toolchain you'll want again.
- **`down`** stops sync + tunnels and **destroys** the project box (and any cluster). The next session starts from scratch.
- **`status`** shows the active box + sync + tunnels + cluster.

```bash
/createos-sandbox:up
/createos-sandbox:run "npm ci"
/createos-sandbox:sync . /work       # local edits stream into /work
/createos-sandbox:run "npm run dev &"
/createos-sandbox:down
```

### Networking

| Command | What it gives you |
|---|---|
| **`tunnel <remote> [local]`** | Reach a box-side service on your laptop. Run a dev server in the box, then `tunnel 3000` → `http://127.0.0.1:3000`. Private, background, no public URL. Stopped by `down`. |
| **`expose <port>`** | A **public HTTPS** link for a port — `<id>-<port>.app.sb.createos.sh`, stable for the box's lifetime. The service must bind `0.0.0.0`. **Anyone with the link can reach it.** Revoke with `unexpose`. |
| **`unexpose`** | Revoke the public URL / disable ingress on the active box. |
| **`cluster up <N>`** | N boxes on one private network, reaching each other by **fully-qualified** name (`curl http://cos-cl-<key>-2.fc.local:8080` — the bare short name is NXDOMAIN). `cluster run -a '<cmd>'` fans a command across all; `cluster run <name\|idx> '<cmd>'` targets one. `cluster ls` / `cluster down` manage them. For distributed-system / DB-replication / p2p / load-test repros. **Counts against quota — keep N small.** |
| **`vpn register <name>`** then **`vpn up`** | Join your laptop to the whole private network over WireGuard (reach every sandbox by name/IP). `vpn up` needs `wg-quick` + `sudo` and **blocks until Ctrl-C** — run it in your own terminal (`!cos vpn up`). |
| **`fork`** | Snapshot the warm project box → an independent clone for matrix/parallel experiments. The fork is self-managed. |

### Pause, resume, and custom images

```
/createos-sandbox:pause
/createos-sandbox:resume
/createos-sandbox:template submit <name> [-f Dockerfile] | ls | show <name> | logs [-f] <name> | rm <name>
```

**`pause` is the cheap way to end a session.** It snapshots the whole box — disk, memory, and running processes — frees the host, and stops compute billing, so a box with a warm toolchain costs nothing while parked. `resume` restores it exactly — files, installed dependencies, and processes that were running when it paused. End to end through the CLI both operations land around 6–8 s (measured), and resume is slower when the snapshot has to be pulled to a different host than the one it was taken on. `down`, by contrast, destroys the box and forces the next session to reinstall everything.

`pause` stops the file sync and any tunnels first, since a paused box serves no traffic. Re-run `sync` / `tunnel` / `expose` after resuming. The project box also carries a 30-minute idle auto-pause as a backstop; raise it with `createos sandbox edit <id> --auto-pause 4h` when a box is serving an exposed URL that people will hit intermittently, or the demo will look dead between visitors.

**`template` bakes a toolchain into an image** so boxes boot pre-provisioned instead of running the same install prelude on every offload. The build service enforces constraints that would otherwise only surface as a rejection after upload, so `cos` preflights the Dockerfile locally: exactly one `FROM` (single-stage), an operator-allowlisted base written literally (no `ARG` substitution), **no `COPY`/`ADD`** (no build context is uploaded — fetch inside a `RUN`), and 64 KiB of source at most. Two builds run concurrently per account.

```bash
/createos-sandbox:template submit myimage -f Dockerfile
/createos-sandbox:up -r myimage          # or: offload -r myimage . "<cmd>"
```

A custom image is slow on its **first** boot on each host (that host has to fetch it) and fast on every boot after. The built-ins — `devbox:1`, `ubuntu:26.04`, `debian:13`, `alpine:3.20` — are kept warm and never pull; `createos sandbox rootfs` lists them.

### Disks — BYO S3

Mount **your own** S3 bucket into the project box.

```
/createos-sandbox:disk create <name> --bucket <b> --endpoint <url> --access-key <k> --secret-key <s>
/createos-sandbox:disk ls
/createos-sandbox:disk show <name>
/createos-sandbox:disk attach <disk> <mount>
/createos-sandbox:disk detach
/createos-sandbox:disk rm
```

```bash
/createos-sandbox:disk create data --bucket my-bucket --endpoint https://s3.amazonaws.com --access-key … --secret-key …
/createos-sandbox:disk attach data /mnt/data
```

## Egress control

**By default, egress is unrestricted** — the box can reach any host, and `cos` prints a one-line `⚠ egress UNRESTRICTED` notice. To isolate an untrusted build, **restrict** outbound to an exact set:

- `-e <domain>` — allow one domain (repeatable).
- `-p <preset>` — a curated bundle of the registries + CDNs a build actually reaches (repeatable, composes with `-e`).
- `-E` — force explicitly unrestricted (silences the warning for trusted offloads).

| Preset | Hosts allowed |
|---|---|
| `python-uv` | `astral.sh`, `releases.astral.sh`, `pypi.org`, `files.pythonhosted.org` |
| `rust-cargo` | `crates.io`, `static.crates.io`, `index.crates.io`, `static.rust-lang.org`, `cdn.pyke.io` |
| `npm` | `registry.npmjs.org` |
| `github` | `github.com`, `objects.githubusercontent.com`, `raw.githubusercontent.com`, `codeload.github.com` |

> `cdn.pyke.io` is included in `rust-cargo` because `ort-sys` (ONNX Runtime) fetches from it. Compose presets and add stragglers with `-e <host>`:
> ```bash
> /createos-sandbox:offload -p python-uv -p rust-cargo -e cdn.example.com . "…"
> ```

**How the allowlist is enforced.** Rules can be a domain, `*.domain`, an IP, a CIDR, or any of those with a `:port`, and the list is allow-only — there is no deny token, so every destination a job needs has to be enumerated. Enforcement is not uniform, and the difference matters when blocking exfiltration is the actual goal:

- **IP and CIDR rules apply immediately** and cannot be bypassed from inside the box.
- **Domain rules take roughly 30 seconds to apply** after being set, and are a strong control for HTTPS traffic but a weak one for cleartext HTTP.

So a domain allowlist is the right control for "this build should only reach pypi and crates.io", and IP/CIDR rules are the right control for an adversarial workload. DNS keeps resolving for blocked destinations — a blocked connection fails as a connection error (e.g. `curl` exit 35), not a name-resolution failure, so checking whether DNS works will mislead you when debugging.

## Heavy builds

- **Egress:** default unrestricted; use `-p`/`-e` to lock it down (see above).
- **Keepalive:** long/quiet compiles run detached with a heartbeat and survive stream drops. `-K` keeps the box on a real failure for inspection.
- **Excludes:** `.git`/`target`/`node_modules`/`__pycache__`/`.venv`/media are excluded from the upload by default; `-x <glob>` adds more.
- **Swap caveat:** `-w <GB>` *attempts* swap, but `devbox:1` can't `swapon` today — so a torch/maturin build on a small box may OOM/ENOSPC. Install only the extra/group you need (e.g. `uv sync --group dev`) rather than `--all-extras`.
- **Shape rejection:** a shape your account can't use fails with a clean `Allowed: [...]` list — pick from it.
- **Bandwidth:** each box starts with a fixed allowance for traffic it initiates (5 GiB by default). A large model download or `docker pull` can exhaust it, after which outbound traffic stops. Top it up additively via `createos sandbox edit <id>`; the exec, file-transfer, and tunnel channels stay reachable regardless.

## Uploads & excludes

Uploads (`offload`/`fanout`) and one-way `sync` skip big/regenerable dirs by default so you don't ship `node_modules` over the wire:

```
.git  target  node_modules  __pycache__  .venv  .mypy_cache  .pytest_cache
.gradle  .cargo/registry  dist  build  .next  .turbo  *.gif  *.mp4  *.mov  *.zst
```

Add more with `-x <glob>` (repeatable). Install dependencies **inside** the box (`cos run 'npm ci'`) rather than syncing them up.

## Shapes

- Default shape: **`s-1vcpu-1gb`**. Default rootfs: **`devbox:1`**.
- Pick a bigger box with `-s <shape>`. A shape your account can't use is rejected with an `Allowed: [...]` list — pick from it rather than guessing.
- Discover what you can boot: `createos sandbox shapes` (sizes) and `createos sandbox rootfs` (images).

## The skill

`using-createos-sandbox` teaches Claude *when* to offload — untrusted code, heavy builds/tests, parallel/matrix work, clean-room repros, live dev loops — so it reaches for the sandbox on its own instead of grinding on your laptop. It drives the same `scripts/cos` helper the slash commands use.

`SKILL.md` stays a decision surface; the depth lives in `skills/using-createos-sandbox/references/` and is loaded only when a task needs it:

| Reference | Covers |
|---|---|
| `offload-and-egress.md` | offload flag table, egress presets and enforcement caveats, fanout, upload excludes, heavy-build OOM/disk/bandwidth traps |
| `networking.md` | choosing between tunnel/expose/cluster/vpn, cluster DNS names, expose gotchas, WireGuard setup |
| `lifecycle-and-images.md` | pause/resume, auto-pause tuning, fork caveats, built-in rootfs vs custom templates, env vars, remote editor, self-terminating jobs, single-file transfer, measured timings |

## Hooks

- **`SessionStart`** (`scripts/session-start.sh`) publishes the driver's absolute path into Claude's context. This is what makes autonomous, skill-driven offload work at all — see [How it works](#how-it-works) and [ADR-0001](../docs/adr/0001-cos-bash-driver.md). It writes nothing to disk.
- **`PreToolUse(Bash)`** (`scripts/offload-hint.sh`) watches for heavy build/test commands (`npm ci`, `make`, `pytest`, `go test`, `cargo build`, `pip install`, …) and adds a one-line nudge to consider `/createos-sandbox:offload`. **The command still runs** — the hook only suggests — and it skips sandbox/git/docker commands. Silence it with `COS_NO_HINT=1`.

## Direct CLI cookbook

`cos` works standalone, no Claude required:

```bash
cos install                                   # symlink onto PATH (once); createos CLI auto-installs on first use
cos offload -p python-uv . 'uv sync --frozen --group dev && uv run pytest -q'
cos offload -p python-uv -p rust-cargo -x target -o dist . 'uv sync --frozen && uv run pytest -q'
cos up && cos run 'npm ci' && cos sync ~/app /work    # reusable box + one-way sync
cos fanout -j 2 -p python-uv . 'pytest tests/a' 'pytest tests/b'   # parallel, isolated boxes
cos shell                                            # instant throwaway Linux (destroyed on exit)
cos run 'npm run dev &' && cos tunnel 3000           # dev server → http://127.0.0.1:3000
cos expose 8080                                      # public HTTPS URL for port 8080
cos cluster up 3 && cos cluster run -a 'hostname'    # 3 boxes, one private net
cos disk create data --bucket my-b --endpoint https://s3.amazonaws.com --access-key … --secret-key …
cos disk attach data /mnt/data                       # mount S3 into the project box
cos fork                                             # snapshot → independent clone
cos template submit myimage -f Dockerfile            # bake a toolchain into a reusable image
cos pause                                            # park the warm box at zero compute cost
cos resume                                           # bring it back exactly as it was
cos down                                             # stops sync/tunnels, destroys box + cluster
```

## Safety & scope

- **One-way by default.** `sync` and offload uploads are laptop → box; box-side writes never touch local unless you opt into `-2` (two-way) or pull with `offload -o`. Use `-2` deliberately — never casually on a repo root. `-M` (mirror) additionally **deletes** box-side extras.
- **Scoped statefile.** `cos` only ever touches boxes it created (`cos-*`) or the project box recorded in its statefile. Your other sandboxes are never touched. State lives at `${COS_STATE_DIR:-${XDG_CACHE_HOME:-~/.cache}/createos-sandbox}/<project>.json` (plus a `.tunnels` sidecar).
- **Quota.** External keys have been observed to allow 2 boxes running at once, with a daily creation cap. Neither is published policy — treat them as observed behaviour, budget `cluster`/`fanout` against them, and expect excess jobs to queue rather than fail.
- **Ending a session.** `pause` keeps the box (and its warm state) at zero compute cost; `down` destroys it. Either is fine — leaving a box *running* is not.
- **Untrusted code.** Restrict egress (`-p`/`-e`) so a malicious dependency can't exfiltrate or phone home.

## Environment variables

| Variable | Effect |
|---|---|
| `CREATEOS_API_KEY` | sign in without browser login (CI / headless / devcontainers); verify with `cos auth` |
| `COS_NO_AUTOINSTALL=1` | don't auto-install the `createos` CLI |
| `COS_CLI_INSTALL_URL` | override the CLI install-script source |
| `COS_CLI` | use a specific `createos` binary instead of the one on `PATH` |
| `COS_STATE_DIR` | override the statefile directory (default `${XDG_CACHE_HOME:-~/.cache}/createos-sandbox`) |
| `COS_NO_HINT=1` | silence the auto-suggest hook |

## Troubleshooting

- **`cos: not signed in to CreateOS`** — run `createos login` in your own terminal (not via Claude — it needs a TTY), or `export CREATEOS_API_KEY=<key>`. Verify with `cos auth`.
- **`createos: command not found`** — the auto-install landed outside `PATH`; add `~/.local/bin` to it and retry.
- **`cos: command not found`** — run `cos install` by its full path (the `SessionStart` hook prints that path into Claude's context), or call `cos` by full path. Do not type `${CLAUDE_PLUGIN_ROOT}` into a Bash command — that variable is unset in the Bash tool's environment and the path resolves to `/scripts/cos`.
- **`/scripts/cos: no such file`** — same cause. Never work around it by rebuilding the offload from raw `createos sandbox create/push/exec`: that drops egress restriction, keepalive, auto-destroy, and the auth preflight.
- **Shape rejected** — run `createos sandbox shapes` and pick from the `Allowed: [...]` list in the error.
- **Box says paused / `cos run` refuses** — the 30 m idle auto-pause fired, or someone ran `pause`. `cos resume` brings it back; raise the timeout with `createos sandbox edit <id> --auto-pause 4h`.
- **Template build rejected** — `cos template submit` preflights single-stage/no-`COPY`/64 KiB locally; a rejection past that is usually a base image outside the operator allowlist.
- **Build can't reach a host** — you restricted egress; add the host with `-e <domain>` or the right `-p <preset>`.
- **`sync` copied `node_modules` anyway** — your `createos` CLI is old and lacks `--exclude`; upgrade it (`cos` warns when this happens).
- **Build OOM/ENOSPC on a small box** — bump `-s <shape>`; `-w` swap doesn't work on `devbox:1`. Install only the deps you need.
- **Public `expose` URL returns nothing** — the service must bind `0.0.0.0`, not `127.0.0.1`.

---

<div align="center">

Part of the [**createos**](../README.md) Claude Code plugin marketplace · [createos.sh](https://createos.sh)

</div>
