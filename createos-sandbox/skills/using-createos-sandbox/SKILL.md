---
name: using-createos-sandbox
description: Use when you need to run code OFF the user's machine — heavy/long builds or test suites, untrusted or unknown code, a parallel test/config matrix across many boxes, an instant clean Linux to try a tool, a live dev-server/watcher Claude edits against, reaching a box-side service from localhost (port tunnel) or sharing it on the public web (HTTPS preview URL), a multi-machine cluster on one private network, a WireGuard VPN into that network, or mounting an S3 bucket of data. Offloads to ephemeral CreateOS Sandboxes via the `cos` helper (stage → exec → pull → auto-destroy), plus fanout, a scratch shell, and an opt-in reusable box with sync, tunnel, expose, cluster, disk, vpn, pause/resume, custom images, and snapshot/fork.
---

# Using CreateOS Sandbox as remote compute

A CreateOS Sandbox is an isolated Linux box that goes from create to running your first command in roughly 200 ms. Use it as throwaway compute instead of running risky or heavy work on the user's laptop.

## Running the driver

Everything goes through `cos`. **A SessionStart hook prints its absolute path into your context at the start of the session — use that literal path.**

Do not write `${CLAUDE_PLUGIN_ROOT}` into a Bash command. That variable is set when slash commands are loaded but is **unset in the Bash tool's environment**, so the path collapses to `/scripts/cos` and dies with exit 127.

If you cannot locate or run `cos`, **stop and say so.** Do not fall back to composing the job out of raw `createos sandbox create/push/exec` calls. That path looks equivalent and is not: it silently drops egress restriction, the keepalive that survives a dropped stream on a long build, guaranteed auto-destroy, and the auth preflight — so a "successful" run can leave an unrestricted box billing with no isolation ever applied. A missing driver is a hard stop, not a reason to improvise.

`cos install` symlinks it into `~/.local/bin` if the user wants it on PATH permanently. It wraps the authed `createos` CLI and needs `jq`, `tar`, `perl`, and `curl`; if the `createos` CLI is missing it auto-installs it from the official script (opt out with `COS_NO_AUTOINSTALL=1`).

## Setup — check this once per session, before the first offload

```bash
cos auth
```

Healthy output names one of three credential sources: `CREATEOS_API_KEY`, a browser OAuth session, or an API token file. Anything else means not signed in.

**You cannot fix that yourself.** `createos login` is an interactive TTY prompt that opens a browser, and an agent shell has no TTY. Do not try to run it and do not work around it with `--token`. Relay the two options to the user:

1. **Browser (recommended)** — they run `createos login` in their own terminal and pick "Sign in with browser".
2. **API key** — they `export CREATEOS_API_KEY=<key>` (from <https://createos.sh>) in the shell that launched Claude Code.

**Never ask the user to paste an API key into the conversation** — it lands in the transcript. Export or browser, nothing else.

Every `cos` command except `install` and `auth` runs this check first, so an unauthenticated box never gets tarballed and uploaded before failing.

## When to reach for it

| Situation | Why offload |
|---|---|
| **Untrusted / unknown code** — a snippet, a fresh npm/pip package, scraped code, a PoC exploit | Isolation. The blast radius is one disposable box, not the laptop. |
| **Heavy build or test suite** — big `make`, full test run, compile, benchmark | Keeps the laptop free; runs on a box sized for it. |
| **Parallel/matrix work** — same job across N configs, test shards, batch | `fanout` — each command in its own throwaway box, concurrently, results collected. |
| **Quick scratch Linux** — try a CLI/tool/snippet on a clean box | `shell` — instant keyless box, destroyed on exit (interactive; the user runs it). |
| **Clean-room repro** — "works on my machine" bugs, dependency conflicts | Fresh rootfs every time, no host state. |
| **Live dev loop** — dev server / test watcher / REPL that reacts to edits | Project box + `sync`; Claude edits locally, the box reacts. |
| **Reach a box-side service** — dev server, DB, API | `tunnel` (private, to `127.0.0.1`) or `expose` (public HTTPS link to share). |
| **Multi-machine** — distributed system, DB replication, p2p mesh, load test | `cluster up N` — boxes share one private net, reach each other by name. |
| **Same setup, many variants** — try N branches from one prepared box | `fork` the project box into independent clones. |
| **Repeated identical setup** — every offload starts with the same install prelude | `template` — bake the toolchain into an image once. |
| **Done for now, back tomorrow** — warm box you don't want to rebuild | `pause` — snapshot at zero compute cost, `resume` restores it exactly. |
| **Big data / weights / shared cache** | `disk` — BYO S3 bucket mounted into the box, survives box death. |

Do NOT offload trivial commands, anything needing the user's local secrets/SSH/cloud creds, or work that must touch real local filesystem state.

## Picking the verb — decide this before typing anything

Almost every task is one of two shapes, and picking the wrong one wastes a lot of motion:

- **"Run this and tell me the result"** — a test suite, a build, a script, anything with an end. → **`cos offload <dir> <cmd>`.** One command. It creates the box, ships the directory, runs, and destroys the box. Nothing to clean up.
- **"Keep a box around while I work"** — a dev server you'll hit repeatedly, a watcher reacting to edits, a session spanning many commands. → **`cos up`**, then `run`/`sync`, then `pause` or `down`.

If you find yourself doing any of the following, you have picked the wrong shape and should stop and use `offload` instead:

- running `cos up` for a task that has a clear finish line
- tarring, base64-encoding, or `push`-ing files into the box by hand — **`offload` stages the directory for you**, with sensible excludes, in the same command
- reaching for `cos status` to decide what to do first — for one-shot work there is nothing to check, just offload

`cos run` takes the command as one plain string. There is no `--` separator: `cos run 'npm ci && npm test'`.

## Pattern A — one-shot offload (the default, and the safe one)

Stage a directory, run, optionally pull artifacts back, **always auto-destroys**. Flags come **before** the `<dir> <cmd>` positionals.

```bash
# run a test suite off-machine (the preset opens the registries it needs)
cos offload -p python-uv . 'uv sync --frozen --group dev && uv run pytest -q'

# Python + Rust, compose presets, exclude build dirs, pull artifacts back
cos offload -p python-uv -p rust-cargo -x target -o dist . 'uv sync --frozen && uv run pytest -q'

# trusted heavy build, explicitly unrestricted egress
cos offload -E -s s-2vcpu-2gb . 'cargo build --release'

# untrusted script, outbound locked to exactly what it needs
cos offload -e pypi.org -e files.pythonhosted.org ./suspect 'python3 main.py'
```

Two things about this that are easy to get wrong:

- **Egress is unrestricted by default.** A fresh box can reach anything; `cos` prints a one-line notice. Restricting is opt-in with `-p <preset>` or `-e <domain>`. So "run this untrusted thing in a sandbox" is only half done until you pass one of those.
- **Uploads are one-way.** Box-side changes never touch the local tree unless you ask with `-o <path>`. `.git`, `node_modules`, `target`, `.venv` and friends are excluded from the upload by default — dependencies are meant to be built *inside* the box.

Long, quiet builds survive a dropped connection: the command runs detached with a heartbeat watcher that re-attaches if the stream dies. The real exit code is preserved.

For the full flag table, the egress presets, the enforcement caveats, fanout, and the OOM/disk/bandwidth traps on heavy builds → **`references/offload-and-egress.md`**.

### Fanout — same input, many boxes, in parallel

```bash
cos fanout -j 2 -p python-uv . 'pytest -q tests/unit' 'pytest -q tests/integration' 'ruff check'
```

Each job gets its own box with no shared network — that is what distinguishes it from `cluster`. `-j` defaults to 2 to match the concurrency external keys have been observed to allow; going higher just queues the extra jobs rather than failing.

## Pattern B — reusable project box (opt-in)

For repeated runs against a warm box, or a dev server Claude edits against. One box per git root, tracked in a statefile.

```bash
cos up -s s-2vcpu-2gb    # create/reuse this project's box
cos run 'npm ci'         # warm it — deps persist across runs
cos sync ~/app /work     # one-way by default (laptop → box), background
cos run 'npm run dev &'  # start a watcher; it sees synced edits
cos status               # box + sync + tunnels + forks
cos pause                # park it at zero compute cost
cos resume               # bring it back exactly as it was
cos down                 # stop sync + destroy the box
```

**`up` is for a box you intend to reuse and then tear down.** A bare "run this in a sandbox" is *not* Pattern B — use `cos offload` (one-shot, auto-destroys) or `cos shell`. Reaching for `up` to satisfy "create a sandbox" makes the box outlive the task, and a later `cos down` destroys it along with anything else sharing that statefile.

**Ending a session: prefer `pause` over `down`** when the box has a warm toolchain the user will want again. `down` destroys and the next session reinstalls everything; `pause` snapshots disk *and* memory, stops compute billing, and brings everything back on `resume` — measured end-to-end at around 6–8 s each way through the CLI. Use `down` when the work is genuinely finished.

If a box under this project's name is running but the statefile is gone (another checkout, another agent, created by hand), `up` **refuses** rather than adopting it — adopting silently would let a later `cos down` destroy a box this project never created. `cos up -a` adopts explicitly, and an adopted box is never destroyed by `cos down`.

### Sync modes

`cos sync` defaults to **one-way (laptop → box)** — the safe direction for a dev loop.

| Flag | Mode | Behavior |
|---|---|---|
| *(default)* | `one-way` | laptop wins; box changes NOT pulled back. **No bleed-back.** |
| `-2` | `two-way` | bidirectional; box-side writes (build output, deps) **flow back** to the local dir |
| `-M` | `mirror` | one-way **and deletes** box-side files absent locally |
| `-x <glob>` | — | exclude paths (repeatable) |

`.git` and the big regenerable dirs are excluded by default — build deps inside the box with `cos run 'npm ci'` rather than syncing them up. Only reach for `-2` when a box-side process genuinely produces files you need back locally, and never on the user's repo root without saying so first; prefer `offload -o` for pulling artifacts. The local dir must resolve under `$HOME` or `/tmp`. The first sync downloads its sync engine, so allow a minute before edits propagate.

## Pattern C — networking

```bash
cos run 'npm run dev &' && cos tunnel 3000   # private → http://127.0.0.1:3000
cos expose 8080                              # public HTTPS URL to share
cos unexpose                                 # revoke
cos cluster up 3                             # 3 boxes on one private net, name-addressable
cos cluster run -a 'uname -a'                # fan a command across every member
cos vpn register my-laptop && cos vpn up     # WireGuard L3 into the private network
```

- **`tunnel` is private, `expose` is public.** Prefer `tunnel` for dev loops. Use `expose` to share a preview with the team or to give a webhook a target.
- **An exposed service must bind `0.0.0.0:<port>`, not loopback** — ingress arrives on the box's interface. A loopback-bound server passes every in-box check and still returns nothing through the URL.
- **The expose URL is the credential.** No token, no auth layer — anyone with the link reaches the service. `cos unexpose` when the demo is done.
- **`cos vpn up` and `cos shell` block and need a real terminal** — hand them to the user (`!cos vpn up`) rather than launching them as agent commands.

For the DNS names cluster members resolve each other by, and the rest of the expose/tunnel/VPN detail → **`references/networking.md`**.

## Scratch box and data disks

```bash
cos shell                        # instant clean Linux, destroyed on exit — HAND THIS TO THE USER
cos disk create data --bucket my-bucket --endpoint https://s3.amazonaws.com \
  --access-key … --secret-key … [--region us-east-1] [--path-style]
cos disk attach data /mnt/data   # needs the project box; the bucket stays in the user's account
cos disk detach data /mnt/data   # unmount; bucket untouched
```

Disk data lives in the user's own S3 account and region. `--path-style` is needed for MinIO and R2. Prefer scoped, least-privilege keys, and prefer the CLI's interactive prompts over passing secrets as arguments — command lines are visible to other local users and land in shell history. Detaching only unmounts; it never deletes bucket data. Note that **a fork does not carry disk mounts** — re-attach on the clone.

## Lifecycle and cost

- Ephemeral boxes self-destroy. The project box carries a 30-minute idle auto-pause as a backstop, so a forgotten box parks itself instead of billing overnight. Raise it with `createos sandbox edit <id> --auto-pause 4h` when a box is serving an exposed URL people will hit intermittently — otherwise the demo will look dead between visitors.
- Finish a live session with `cos pause` (keeping the warm state) or `cos down` (done for good). Don't leave a running box behind either way.
- **Concurrency is limited** — external keys have been observed to allow 2 boxes running at once, with a daily creation cap. This is observed behaviour rather than published policy, so budget `cluster` and `fanout` against it and expect excess jobs to queue rather than fail.
- If a shape is rejected, the error names the allowed list — pick from it, or run `createos sandbox shapes`.
- Pre-existing boxes the user already runs are **not** yours. `cos` only ever destroys boxes it created itself; a box adopted with `cos up -a` survives `cos down`.
- CreateOS Sandbox is in alpha with no SLA. When a limit or a number matters to a decision, check it live rather than quoting it from here.

## References

Load these when the task actually needs the depth — the summaries above are enough for most work.

| File | Read it for |
|---|---|
| `references/offload-and-egress.md` | offload flag table, egress presets and how enforcement really behaves, fanout, upload excludes, heavy-build OOM/disk/bandwidth traps |
| `references/networking.md` | choosing between tunnel/expose/cluster/vpn, cluster DNS names, expose gotchas, WireGuard setup |
| `references/lifecycle-and-images.md` | pause/resume, auto-pause tuning, fork caveats, built-in rootfs vs custom templates, env vars, remote editor, self-terminating jobs, single-file transfer, measured timings |
