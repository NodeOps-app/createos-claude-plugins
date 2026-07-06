---
name: using-createos-sandbox
description: Use when you need to run code OFF the user's machine — heavy/long builds or test suites, untrusted or unknown code, a parallel test/config matrix across many boxes, an instant clean Linux to try a tool, a live dev-server/watcher Claude edits against, reaching a box-side service from localhost (port tunnel) or the public web (HTTPS expose), a multi-machine cluster on one private network, a WireGuard VPN into that network, or mounting an S3 bucket of data. Offloads to ephemeral CreateOS microVMs via the `cos` helper (stage → exec → pull → auto-destroy), plus fanout, a scratch shell, and an opt-in reusable box with sync, tunnel, expose, cluster, disk, vpn, and snapshot/fork.
---

# Using CreateOS Sandbox as remote compute

A CreateOS sandbox is a fast (~25 ms spawn) Firecracker microVM. Use it as throwaway Linux compute instead of running risky or heavy work on the user's laptop.

Driver: `cos`. It is **not on PATH** by default — run `${CLAUDE_PLUGIN_ROOT}/scripts/cos install` once (symlinks to `~/.local/bin/cos`), then use bare `cos`; otherwise call it by that full path. Wraps the authed `createos` CLI; needs `jq`, `tar`, `perl`, `curl`. If the `createos` CLI is missing, `cos` **auto-installs** it (official `install.sh`) on first use, then reminds the user to `createos login` (opt out with `COS_NO_AUTOINSTALL=1`).

## When to reach for it

| Situation | Why offload |
|---|---|
| **Untrusted / unknown code** — a snippet, a fresh npm/pip package, scraped code, a PoC exploit | Isolation. Escape blast-radius is one disposable VM, not the laptop. |
| **Heavy build or test suite** — big `make`, full test run, compile, benchmark | Keeps the laptop free; runs on a sized box (shapes are plan-gated — see Limits). |
| **Parallel/matrix work** — same job across N configs, test shards, batch | `fanout` — each command in its own throwaway box, concurrently, results collected. |
| **Quick scratch Linux** — try a CLI/tool/snippet on a clean box, no laptop mess | `shell` — instant keyless box, destroyed on exit (interactive; user runs it). |
| **Big data / weights / shared cache** — mount a dataset or artifact store | `disk` — BYO S3 bucket mounted into the box, survives box death. |
| **Clean-room repro** — "works on my machine" bugs, dependency conflicts | Fresh `devbox:1` rootfs every time, no host state. |
| **Live dev loop** — dev server / test watcher / REPL that reacts to edits | Opt-in reusable box + `sync` (one-way default; `-2` for two-way); Claude edits locally, the box reacts. |
| **Reach a box-side service** — dev server, DB, API you want on `localhost` or a public URL | `tunnel` (private → `127.0.0.1`) or `expose` (public HTTPS link). |
| **Multi-machine cluster** — distributed system, DB replication, p2p mesh, load test across N Linux hosts | `cluster up N` — boxes share one private net, reach each other by name. |
| **Matrix from warm state** — try N variants from one prepared box | `fork` the project box into independent snapshots. |

Do NOT offload trivial commands, anything needing the user's local secrets/SSH/cloud creds, or work that must touch the real local filesystem state.

## Pattern A — one-shot offload (default, safe)

Stage a directory, run, optionally pull artifacts back, **always auto-destroys**. Flags come **before** the `<dir> <cmd>` positionals.

```bash
# run a test suite off-machine (egress preset opens the registries it needs)
cos offload -p python-uv . 'uv sync --frozen --group dev && uv run pytest -q'

# Python+Rust (uv+maturin/pyo3): compose presets, exclude build dirs, pull artifacts
cos offload -p python-uv -p rust-cargo -x target -o dist . 'uv sync --frozen && uv run pytest -q'

# trusted heavy build, unrestricted egress + swap headroom
cos offload -E -w 4 . 'cargo build --release'

# untrusted script, egress locked to exactly what it needs
cos offload -e pypi.org -e files.pythonhosted.org ./suspect 'python3 main.py'
```

Flags: `-p <preset>` (egress preset, repeatable) · `-e <domain>` (one domain) · `-E` (unrestricted) · `-x <glob>` (extra upload exclude) · `-o <path>` (tar dir to pull back) · `-w <GB>` (swap) · `-K` (keep box on failure) · `-s/-r` (shape/rootfs).

- **One-way**: local tree → box `/work`. Box-side changes don't touch local unless you pass `-o <path>`. `.git`, `target`, `node_modules`, `__pycache__`, `.venv`, media are excluded from the upload by default.
- **Survives long/quiet builds**: the command runs detached in-box with a 10 s heartbeat; if the exec stream drops mid-build it re-attaches (the build keeps running, cache intact) instead of dying. Exit code is preserved.
- **Egress defaults to a baseline allowlist** (github, npm, pypi, crates) — most installs need nothing extra. `-p`/`-e` swap in an **exact** set instead of the default (narrower, or covering a host outside the baseline): `python-uv` (astral.sh, pypi, pythonhosted), `rust-cargo` (crates.io ×3, rust-lang, **cdn.pyke.io** — ort-sys/ONNX), `npm`, `github`. Compose presets/domains to combine, or `-E` for unrestricted. A build that fails on a missing host needs it added via `-e <host>` (or the matching preset, or `-E`) — it is not reachable by default.
- Box is destroyed on success, failure, or interrupt — **unless** `-K` (keep on failure) or an infra/stream error, which keep it so the cache survives (`cos` prints the reconnect + destroy commands).

### Fanout — same input, many boxes, in parallel

For a test matrix / config sweep / batch where each job should be isolated, `fanout` stages `<dir>` once and runs each command in its own throwaway box concurrently, then summarizes per-job exit codes + log paths and destroys every box.

```bash
cos fanout -j 2 -p python-uv . 'pytest -q tests/unit' 'pytest -q tests/integration' 'ruff check'
```

- Default `-j 2` matches the external-key quota (2 running at once). Raise only if the plan allows — otherwise extra jobs just queue.
- Each job is **independent** (no shared network) — that's the difference from `cluster`. Same default upload excludes as `offload`.
- Each job is keepalive-protected (survives stream drops) with its own log; a single very long build is still better as one `offload`.

### Limits & heavy-build gotchas

- **Shapes are plan-gated.** External plans may cap small (e.g. `s-1vcpu-1gb` max). Picking a too-big `-s` fails fast with a clean `not allowed … Allowed: [...]` line — pick from that list. Discover allowed shapes with `createos sandbox shapes`.
- **Swap is best-effort.** `-w <GB>` tries to add a swapfile, but `devbox:1` currently can't `swapon` (stays 0 MB) — it warns and continues. On a capped plan there's no bigger box to fall back to, so a compiled-extension build (pyo3/maturin/torch) can OOM. Split the work: build the extension separately, or install only the extra/group you need.
- **Disk fills fast.** `pip install`/`uv sync` with `--all-extras` can pull CUDA/torch wheels (GBs) and hit `No space left on device` on a small box. Install only the needed extra/group; bump `--disk-mib` via the CLI if you control the plan.
- **`cdn.pyke.io`** is the non-obvious one: `ort-sys` (ONNX Runtime, pulled by many ML crates) downloads prebuilt binaries from it. It's already in the `rust-cargo` preset.

## Pattern B — reusable box + live session (opt-in)

For repeated runs against a warm box, or a dev-server/watcher Claude edits against. One active box per project (git root), tracked in a statefile.

```bash
cos up -s s-2vcpu-2gb              # create/reuse the project box
cos run 'npm ci'                   # warm it (deps persist across runs)
cos sync ~/app /work               # DEFAULT one-way (laptop→box); background (Mutagen)
cos run 'npm run dev &'            # start a watcher/server; it sees synced edits
# ... Claude edits files locally with normal tools; sync propagates them ...
cos status                         # show box + sync state (mode shown)
cos down                           # stop sync + destroy box
```

### Sync modes

`cos sync` defaults to **one-way (laptop → box)** — the safe direction for a dev loop: your edits propagate in, box-side writes never touch local. Opt into other modes only when needed:

| Flag | Mode | Behavior |
|---|---|---|
| *(default)* | `one-way` | laptop wins; box changes NOT pulled back. **No bleed-back.** |
| `-2` | `two-way` | bidirectional; box-side writes (build output, deps) **flow back** to the local dir |
| `-M` | `mirror` | one-way **and deletes** box-side files absent locally |
| `-x <glob>` | — | exclude paths (repeatable): `cos sync -x '*.log' -x node_modules ~/app /work` |

- `.git`/`.hg` **and big/regenerable dirs** (`node_modules`, `target`, `.venv`, `__pycache__`, `dist`, `build`, `.next`, …) are **excluded by default** — build deps *inside* the box (`cos run 'npm ci'`) instead of syncing them up. (Needs the current CLI's `--exclude`; an old CLI warns it's syncing everything.)
- Only reach for `-2` when a box-side process genuinely produces files you need back locally — and never on the user's repo root without saying so first. Prefer Pattern A (`offload -o`) for pulling artifacts.
- Local dir must be under `$HOME` or literal `/tmp` (`cos` wrapper guard; `/private/tmp/*` is rejected). First `sync` downloads Mutagen (~60–90 s before edits propagate); later syncs settle in seconds.
- Needs the new `createos` CLI for `--mode`/`-x`; on an old CLI `cos sync` warns and falls back to two-way.

## Pattern C — networking (reach the box, or wire boxes together)

All of these operate on the reusable project box (`cos up` first), except `cluster` which manages its own set. Tunnel/expose/cluster teardown is covered by `cos down`.

```bash
# reach a box-side service from your laptop (private, background — no public URL)
cos run 'npm run dev &'          # start the server in the box
cos tunnel 3000                  # → http://127.0.0.1:3000 (local port defaults to remote)
cos tunnel 5432 15432            # box:5432 → 127.0.0.1:15432

# public HTTPS URL for a port (stable for the box's lifetime; bind 0.0.0.0!)
cos expose 8080                  # prints https://<id>-8080.app.sb.createos.sh
cos unexpose                     # revoke

# multi-machine: N boxes on ONE private network, name-addressable
cos cluster up 3                 # cos-cl-<key>-1..3 all on cos-net-<key>
cos cluster run 1 'ip -4 addr'   # exec on member 1 (index, name, or -a for all)
cos cluster run -a 'uname -a'    # fan a command across every member
cos cluster ls                   # members + private IPs
cos cluster down                 # destroy members + delete the network

# WireGuard L3 VPN: laptop joins the whole private network (reach every box by name/IP)
cos vpn register my-laptop       # one-time per machine (no sudo)
cos vpn up                       # connect; needs wg-quick + sudo; blocks until Ctrl-C

# snapshot the warm project box into an independent clone (matrix/experiments)
cos fork                         # pauses briefly, forks, resumes; prints the new box id
```

- **tunnel vs expose**: `tunnel` is private (only your machine, via `127.0.0.1`), `expose` is a public HTTPS link anyone can hit. Prefer `tunnel` for dev loops; `expose` for sharing a preview or a webhook target. A service reached by `expose` **must bind `0.0.0.0:<port>`**, not loopback.
- **cluster**: peers resolve each other by their box name over the shared overlay network — no IP wrangling. Good for testing distributed systems, DB primaries/replicas, gossip/p2p, or load generators hitting a target box. Every box counts against the running quota (2 on external keys), so keep N small.
- **vpn**: whole-network L3, heavier than `tunnel` (single port). Needs `wg-quick` on the laptop and sudo for routes, and it blocks — hand `cos vpn up` to the **user** to run in their own terminal rather than launching it as an agent command. It refuses if a route conflicts (e.g. Tailscale on the same CGNAT range) instead of hijacking traffic.
- **fork**: the clone is independent and **not** tracked as the project box — destroy it yourself (`createos sandbox rm -y <id>`). Forking pauses the project box for ~a second, then resumes it.

## Scratch box & data disks

```bash
# instant clean Linux to poke at something — destroyed when the shell exits
cos shell                        # interactive + keyless; HAND THIS TO THE USER (!cos shell), it blocks
cos shell -s s-2vcpu-2gb

# mount your own S3 bucket into the project box (datasets, weights, shared build cache)
cos disk create data --bucket my-bucket --endpoint https://s3.amazonaws.com \
  --access-key AKIA... --secret-key ... [--region us-east-1] [--path-style]
cos disk attach data /mnt/data   # requires the project box (cos up); bucket stays in your account
cos disk detach data /mnt/data   # unmount; bucket untouched
cos disk ls
```

- **shell** is interactive — like `cos vpn up`, don't launch it as an agent command; hand `!cos shell` to the user. It self-destroys on exit.
- **disk** data lives in the user's own S3 account/region (residency-friendly); `--path-style` is needed for MinIO/R2. Prefer scoped, least-privilege keys. Detaching only unmounts — it never deletes bucket data.

## Lifecycle & cost

- Ephemeral boxes self-destroy; project boxes carry a 30 m idle auto-pause as a backstop.
- Always `cos down` when a live session is finished — don't leave boxes running.
- Quota: 100 sandboxes/day, 2 running at once on external keys. Don't spin a fleet without budgeting against that.
- Pre-existing boxes the user already runs are NOT yours — `cos` only ever touches boxes it created (tagged `cos-*`) or the project box in the statefile.
