---
name: using-createos-sandbox
description: Use when you need to run code OFF the user's machine — heavy/long builds or test suites, untrusted or unknown code, parallel workloads, anything needing a clean disposable Linux box, or a live dev-server/watcher Claude edits against. Offloads to an ephemeral CreateOS microVM via the `cos` helper (stage files → exec → pull artifacts → auto-destroy), with an opt-in reusable box + two-way sync for interactive sessions.
---

# Using CreateOS Sandbox as remote compute

A CreateOS sandbox is a fast (~25 ms spawn) Firecracker microVM. Use it as throwaway Linux compute instead of running risky or heavy work on the user's laptop.

Driver: `cos`. It is **not on PATH** by default — run `${CLAUDE_PLUGIN_ROOT}/scripts/cos install` once (symlinks to `~/.local/bin/cos`), then use bare `cos`; otherwise call it by that full path. Wraps the authed `createos` CLI; needs `jq`, `tar`, `perl`.

## When to reach for it

| Situation | Why offload |
|---|---|
| **Untrusted / unknown code** — a snippet, a fresh npm/pip package, scraped code, a PoC exploit | Isolation. Escape blast-radius is one disposable VM, not the laptop. |
| **Heavy build or test suite** — big `make`, full test run, compile, benchmark | Keeps the laptop free; runs on a sized box (shapes are plan-gated — see Limits). |
| **Parallel/matrix work** — same job across N configs | Spin N boxes concurrently, each isolated. |
| **Clean-room repro** — "works on my machine" bugs, dependency conflicts | Fresh `devbox:1` rootfs every time, no host state. |
| **Live dev loop** — dev server / test watcher / REPL that reacts to edits | Opt-in reusable box + two-way `sync`; Claude edits locally, the box reacts. |

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
- **Egress presets**: `python-uv` (astral.sh, pypi, pythonhosted), `rust-cargo` (crates.io ×3, rust-lang, **cdn.pyke.io** — ort-sys/ONNX), `npm`, `github`. Compose with `-e`. A locked-down build that fails on a missing host needs that host added.
- Box is destroyed on success, failure, or interrupt — **unless** `-K` (keep on failure) or an infra/stream error, which keep it so the cache survives (`cos` prints the reconnect + destroy commands).

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

- `.git`/`.hg` are **skipped by default** (the CLI ignores VCS dirs).
- Only reach for `-2` when a box-side process genuinely produces files you need back locally — and never on the user's repo root without saying so first. Prefer Pattern A (`offload -o`) for pulling artifacts.
- Local dir must be under `$HOME` or literal `/tmp` (CLI guard; `/private/tmp/*` is rejected). First `sync` downloads Mutagen (~60–90 s before edits propagate); later syncs settle in seconds.
- Needs the new `createos` CLI for `--mode`/`-x`; on an old CLI `cos sync` warns and falls back to two-way.

## Lifecycle & cost

- Ephemeral boxes self-destroy; project boxes carry a 30 m idle auto-pause as a backstop.
- Always `cos down` when a live session is finished — don't leave boxes running.
- Quota: 100 sandboxes/day, 2 running at once on external keys. Don't spin a fleet without budgeting against that.
- Pre-existing boxes the user already runs are NOT yours — `cos` only ever touches boxes it created (tagged `cos-*`) or the project box in the statefile.
