# createos-sandbox — Claude Code plugin

Run ad-hoc, heavy, or untrusted code **off your machine** in disposable [CreateOS](https://createos.sh) Firecracker microVMs (~25 ms spawn). Gives Claude a skill + slash commands that drive the authed `createos` CLI.

Two patterns:

- **One-shot offload** (default, safe): stage a dir → exec → optionally pull artifacts → **auto-destroy**. One-way; box-side changes never touch local unless you ask.
- **Live session** (opt-in): a reusable per-repo box + two-way file sync, so a dev-server/watcher inside the box reacts to your local edits.

## Requirements

- `createos` CLI on `PATH`, authenticated (`createos sandbox ls` works).
- `jq`, `tar`, `bash`.

## Install

**Dev (instant, no install):**
```bash
claude --plugin-dir /path/to/createos-sandbox-plugin
/reload-plugins      # after editing plugin files
```

**Persistent (local marketplace):**
```
/plugin marketplace add /path/to/createos-sandbox-plugin
/plugin install createos-sandbox@createos
```

## Slash commands

| Command | What |
|---|---|
| `/createos-sandbox:offload [-s shape] [-r rootfs] [-e egress] [-o out] <dir> <cmd>` | one-shot: stage → run → pull → destroy |
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
scripts/cos offload . 'pip install -r requirements.txt && pytest -q'
scripts/cos offload -s s-4vcpu-4gb -o dist . 'npm ci && npm run build'
scripts/cos up -s s-2vcpu-2gb && scripts/cos run 'npm ci' && scripts/cos sync ~/app /work
scripts/cos down
```

## Safety

- **Sync modes:** `sync` defaults to **one-way** (laptop → box) — box-side writes never touch local. `.git` is skipped by default. `-2` opts into two-way (box writes flow back — use only when you need files back, never on a repo root casually); `-M` mirrors (deletes box-side extras); `-x <glob>` excludes paths. (`--mode`/`-x` need the current `createos` CLI; an old CLI falls back to two-way with a warning.) Prefer `offload -o` to pull artifacts.
- **Quota:** 100 sandboxes/day, 2 running at once (external keys). Don't spin a fleet without budgeting.
- **Scope:** `cos` only ever touches boxes it created (`cos-*`) or the project box in its statefile (`~/.cache/createos-sandbox/`). Your other sandboxes are never touched.
