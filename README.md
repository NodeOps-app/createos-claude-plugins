# createos-sandbox — Claude Code plugin

Run ad-hoc, heavy, or untrusted code **off your machine** in disposable [CreateOS](https://createos.sh) Firecracker microVMs (~25 ms spawn). Gives Claude a skill + slash commands that drive the authed `createos` CLI.

Two patterns:

- **One-shot offload** (default, safe): stage a dir → exec → optionally pull artifacts → **auto-destroy**. One-way; box-side changes never touch local unless you ask.
- **Live session** (opt-in): a reusable per-repo box + one-way file sync (default; `-2` for two-way), so a dev-server/watcher inside the box reacts to your local edits.

## Requirements

- `createos` CLI, authenticated (`createos sandbox ls` works). **Auto-installs** if missing — `cos` runs the official one-liner (`curl -sfL …/install.sh | sh -`) on first use, then reminds you to `createos login`. Opt out with `COS_NO_AUTOINSTALL=1`; override the source with `COS_CLI_INSTALL_URL`.
- `jq`, `tar`, `bash`, `base64` — required host-side. `perl` for ANSI stripping / path resolution. `shasum` (falls back to `sha1sum`/`sha256sum`). `curl` only for the one-time CLI auto-install.

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
| `/createos-sandbox:fanout [-j N] [-p preset] [-x glob] <dir> <cmd1> [cmd2] …` | run each command in its own throwaway box, in parallel; collect results |
| `/createos-sandbox:shell [-s shape] [-r rootfs] [-e dom\|-p preset\|-E]` | instant throwaway interactive Linux (destroyed on exit; run via `!cos shell`; egress allowlisting like `offload`) |
| `/createos-sandbox:up [-s shape] [-r rootfs] [-n name] [-e dom\|-p preset\|-E]` | create/reuse the per-repo project box (egress allowlisting like `offload`) |
| `/createos-sandbox:run <cmd>` | exec in the project box (streamed, state persists) |
| `/createos-sandbox:sync [-2\|-M] [-x glob] <local-dir> [remote-dir]` | start file sync into the project box (background); default one-way, `-2` two-way, `-M` mirror, `-x` exclude |
| `/createos-sandbox:tunnel <remote> [local]` | forward a box port to `127.0.0.1` (background, private) |
| `/createos-sandbox:expose <port>` | public HTTPS URL for a box port (revoke with `/createos-sandbox:unexpose`) |
| `/createos-sandbox:unexpose` | revoke the public HTTPS URL / disable ingress |
| `/createos-sandbox:cluster up <N> \| run [<name\|idx>\|-a] <cmd> \| ls \| down` | N boxes on one private network, name-addressable |
| `/createos-sandbox:disk create \| ls \| show <name> \| attach <disk> <mount> \| detach \| rm` | BYO S3 bucket mounts on the project box |
| `/createos-sandbox:vpn [register <name> \| up]` | WireGuard L3 into your private networks (needs `wg-quick`) |
| `/createos-sandbox:fork` | snapshot the project box → independent clone |
| `/createos-sandbox:down` | stop sync/tunnels + destroy the project box (+ cluster) |
| `/createos-sandbox:status` | show active box + sync + tunnels + cluster |

Flags (`-s/-r/-e/-o`) come **before** the positionals.

### Networking (tunnel / expose / cluster / VPN)

- **`tunnel`** — reach a box-side service on your laptop. Run a dev server in the box, then `/createos-sandbox:tunnel 3000` → `http://127.0.0.1:3000`. Private, background, no public URL. Stopped by `down`.
- **`expose`** — public HTTPS link for a port (`<id>-<port>.app.sb.createos.sh`), stable for the box's lifetime. Service must bind `0.0.0.0`. Anyone with the link can reach it.
- **`cluster`** — multi-machine Linux in one private network: `cluster up 3` spins 3 boxes that reach each other by name (`curl http://cos-cl-<key>-2:8080`). `cluster run -a 'uname -a'` fans a command across all. For distributed-system / DB-replication / p2p / load-test repros. Counts against quota — keep N small.
- **`vpn`** — join your laptop to the whole private network over WireGuard (reach every sandbox by name/IP). One-time `cos vpn register <name>`, then `cos vpn up` (needs `wg-quick` + sudo, blocks until Ctrl-C — run it in your own terminal).
- **`fork`** — clone the warm project box from an identical snapshot for matrix/parallel experiments; the fork is independent and self-managed.

## Skill

`using-createos-sandbox` teaches Claude *when* to offload (untrusted code, heavy builds/tests, parallel/matrix work, clean-room repros, live dev loops) so it reaches for the sandbox on its own. It drives the same `scripts/cos` helper.

## Auto-suggest hook

A `PreToolUse(Bash)` hook (`scripts/offload-hint.sh`) watches for heavy build/test commands (`npm ci`, `make`, `pytest`, `go test`, `cargo build`, `pip install`, …) and adds a one-line nudge to consider `/createos-sandbox:offload`. It is **non-blocking** — the command still runs — and skips sandbox/git/docker commands. Silence it with `COS_NO_HINT=1`.

## Direct CLI (no Claude)

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
cos down                                             # stops sync/tunnels, destroys box + cluster
```

### Heavy builds (Python/Rust/compiled)

- **Egress defaults to a baseline allowlist** (github, npm, pypi, crates — covers most pip/uv, cargo, npm, git installs). `-p`/`-e` swap in an **exact** set instead: `-p python-uv` (astral.sh, pypi, pythonhosted), `-p rust-cargo` (crates.io ×3, rust-lang, **cdn.pyke.io** ← ort-sys/ONNX), `-p npm`, `-p github`. Compose them, add stragglers with `-e <host>`, or `-E` for unrestricted.
- **Keepalive**: long/quiet compiles no longer get killed by exec-stream idle resets — the command runs detached with a heartbeat and re-attaches if the stream drops; the build (and its cache) survives. `-K` keeps the box on a real failure so you can inspect.
- **Excludes**: `.git`/`target`/`node_modules`/`__pycache__`/`.venv`/media are excluded from the upload by default; `-x <glob>` adds more.
- **Shapes are plan-gated** — a too-big `-s` fails with a clean `Allowed: [...]` list (`createos sandbox shapes` to discover). `-w <GB>` *attempts* swap but `devbox:1` can't `swapon` today, so on a capped plan a torch/maturin build may OOM/ENOSPC — install only the extra/group you need rather than `--all-extras`.

## Safety

- **Sync modes:** `sync` defaults to **one-way** (laptop → box) — box-side writes never touch local. `.git` and big/regenerable dirs (`node_modules`, `target`, `.venv`, `__pycache__`, `dist`, `build`, …) are excluded by default — install deps *inside* the box (`cos run 'npm ci'`) rather than syncing them up. Same default excludes apply to `offload`/`fanout` uploads. `-2` opts into two-way (box writes flow back — use only when you need files back, never on a repo root casually); `-M` mirrors (deletes box-side extras); `-x <glob>` excludes paths. (`--mode`/`-x` need the current `createos` CLI; an old CLI falls back to two-way with a warning.) Prefer `offload -o` to pull artifacts.
- **Quota:** 100 sandboxes/day, 2 running at once (external keys). Don't spin a fleet without budgeting.
- **Scope:** `cos` only ever touches boxes it created (`cos-*`) or the project box in its statefile (`~/.cache/createos-sandbox/`). Your other sandboxes are never touched.
