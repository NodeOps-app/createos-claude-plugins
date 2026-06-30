# createos-sandbox — Claude Code plugin

Run ad-hoc, heavy, or untrusted code **off your machine** in disposable [CreateOS](https://createos.sh) Firecracker microVMs (~25 ms spawn). Gives Claude a skill + slash commands that drive the authed `createos` CLI.

Two patterns:

- **One-shot offload** (default, safe): stage a dir → exec → optionally pull artifacts → **auto-destroy**. One-way; box-side changes never touch local unless you ask.
- **Live session** (opt-in): a reusable per-repo box + two-way file sync, so a dev-server/watcher inside the box reacts to your local edits.

## Requirements

- `createos` CLI on `PATH`, authenticated (`createos sandbox ls` works).
- `jq`, `tar`, `perl`, `bash`.

`cos` itself is **not on PATH** by default — run `scripts/cos install` once (symlinks to `~/.local/bin/cos`) and use bare `cos`, or invoke it by full path (`${CLAUDE_PLUGIN_ROOT}/scripts/cos`).

## Install

**Dev (instant, no install):**
```bash
claude --plugin-dir /path/to/createos-plugin
/reload-plugins      # after editing plugin files
```

**Persistent (local marketplace):**
```
/plugin marketplace add /path/to/createos-plugin
/plugin install createos-sandbox@createos
```

## Slash commands

| Command | What |
|---|---|
| `/createos-sandbox:offload [-p preset] [-e dom] [-E] [-x glob] [-o out] [-w GB] [-K] [-s shape] <dir> <cmd>` | one-shot: stage → run (keepalive) → pull → destroy |
| `/createos-sandbox:up [-s shape] [-r rootfs] [-n name]` | create/reuse the per-repo project box |
| `/createos-sandbox:run <cmd>` | exec in the project box (streamed, state persists) |
| `/createos-sandbox:sync [-2\|-M] [-x glob] <local-dir> [remote-dir]` | start file sync into the project box (background); default one-way, `-2` two-way, `-M` mirror, `-x` exclude |
| `/createos-sandbox:down` | stop sync + destroy the project box |
| `/createos-sandbox:status` | show active box + sync state |

Flags (`-s/-r/-e/-o`) come **before** the positionals.

## Skill

`using-createos-sandbox` teaches Claude *when* to offload (untrusted code, heavy builds/tests, parallel/matrix work, clean-room repros, live dev loops) so it reaches for the sandbox on its own. It drives the same `scripts/cos` helper.

## Auto-suggest hook

A `PreToolUse(Bash)` hook (`scripts/offload-hint.sh`) watches for heavy build/test commands (`npm ci`, `make`, `pytest`, `go test`, `cargo build`, `pip install`, …) and adds a one-line nudge to consider `/createos-sandbox:offload`. It is **non-blocking** — the command still runs — and skips sandbox/git/docker commands. Silence it with `COS_NO_HINT=1`.

## Direct CLI (no Claude)

```bash
cos install                                   # symlink onto PATH (once)
cos offload -p python-uv . 'uv sync --frozen --group dev && uv run pytest -q'
cos offload -p python-uv -p rust-cargo -x target -o dist . 'uv sync --frozen && uv run pytest -q'
cos up && cos run 'npm ci' && cos sync ~/app /work    # reusable box + one-way sync
cos down
```

### Heavy builds (Python/Rust/compiled)

- **Egress presets** open the registries a build reaches: `-p python-uv` (astral.sh, pypi, pythonhosted), `-p rust-cargo` (crates.io ×3, rust-lang, **cdn.pyke.io** ← ort-sys/ONNX), `-p npm`, `-p github`. Compose them, add stragglers with `-e <host>`, or `-E` for unrestricted.
- **Keepalive**: long/quiet compiles no longer get killed by exec-stream idle resets — the command runs detached with a heartbeat and re-attaches if the stream drops; the build (and its cache) survives. `-K` keeps the box on a real failure so you can inspect.
- **Excludes**: `.git`/`target`/`node_modules`/`__pycache__`/`.venv`/media are excluded from the upload by default; `-x <glob>` adds more.
- **Shapes are plan-gated** — a too-big `-s` fails with a clean `Allowed: [...]` list (`createos sandbox shapes` to discover). `-w <GB>` *attempts* swap but `devbox:1` can't `swapon` today, so on a capped plan a torch/maturin build may OOM/ENOSPC — install only the extra/group you need rather than `--all-extras`.

## Safety

- **Sync modes:** `sync` defaults to **one-way** (laptop → box) — box-side writes never touch local. `.git` is skipped by default. `-2` opts into two-way (box writes flow back — use only when you need files back, never on a repo root casually); `-M` mirrors (deletes box-side extras); `-x <glob>` excludes paths. (`--mode`/`-x` need the current `createos` CLI; an old CLI falls back to two-way with a warning.) Prefer `offload -o` to pull artifacts.
- **Quota:** 100 sandboxes/day, 2 running at once (external keys). Don't spin a fleet without budgeting.
- **Scope:** `cos` only ever touches boxes it created (`cos-*`) or the project box in its statefile (`~/.cache/createos-sandbox/`). Your other sandboxes are never touched.
