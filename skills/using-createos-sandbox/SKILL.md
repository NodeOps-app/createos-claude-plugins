---
name: using-createos-sandbox
description: Use when you need to run code OFF the user's machine — heavy/long builds or test suites, untrusted or unknown code, parallel workloads, anything needing a clean disposable Linux box, or a live dev-server/watcher Claude edits against. Offloads to an ephemeral CreateOS microVM via the `cos` helper (stage files → exec → pull artifacts → auto-destroy), with an opt-in reusable box + two-way sync for interactive sessions.
---

# Using CreateOS Sandbox as remote compute

A CreateOS sandbox is a fast (~25 ms spawn) Firecracker microVM. Use it as throwaway Linux compute instead of running risky or heavy work on the user's laptop.

Driver: `${CLAUDE_PLUGIN_ROOT}/scripts/cos` (wraps the authed `createos` CLI). `jq` required.

## When to reach for it

| Situation | Why offload |
|---|---|
| **Untrusted / unknown code** — a snippet, a fresh npm/pip package, scraped code, a PoC exploit | Isolation. Escape blast-radius is one disposable VM, not the laptop. |
| **Heavy build or test suite** — big `make`, full test run, compile, benchmark | Keeps the laptop free; runs on a sized box (`-s s-4vcpu-4gb`). |
| **Parallel/matrix work** — same job across N configs | Spin N boxes concurrently, each isolated. |
| **Clean-room repro** — "works on my machine" bugs, dependency conflicts | Fresh `devbox:1` rootfs every time, no host state. |
| **Live dev loop** — dev server / test watcher / REPL that reacts to edits | Opt-in reusable box + two-way `sync`; Claude edits locally, the box reacts. |

Do NOT offload trivial commands, anything needing the user's local secrets/SSH/cloud creds, or work that must touch the real local filesystem state.

## Pattern A — one-shot offload (default, safe)

Stage a directory, run, optionally pull artifacts back, **always auto-destroys**:

```bash
# run a test suite off-machine
cos offload . 'pip install -r requirements.txt && pytest -q'

# bigger box for a heavy build, pull the build output back into ./dist
# NOTE: flags (-s/-r/-e/-o) come BEFORE the <dir> <cmd> positionals
cos offload -s s-4vcpu-4gb -o dist . 'npm ci && npm run build'

# run an UNTRUSTED script with egress locked to nothing but what it needs
cos offload -e pypi.org -e files.pythonhosted.org ./suspect 'python3 main.py'
```

- One-way: local tree → box `/work`. Box-side changes do NOT touch local unless you pass `-o <path>` (tarred from `/work/<path>` back into the staged dir).
- Streams stdout/stderr live; exit code is preserved.
- Box is destroyed on success, failure, or interrupt.

For a quick no-files run, the standalone `scratch` wrapper (if installed) is fine; `cos offload <dir> <cmd>` is the with-files version.

## Pattern B — reusable box + live session (opt-in)

For repeated runs against a warm box, or a dev-server/watcher Claude edits against. One active box per project (git root), tracked in a statefile.

```bash
cos up -s s-2vcpu-2gb          # create/reuse the project box
cos run 'npm ci'               # warm it (deps persist across runs)
cos sync . /work               # ⚠ TWO-WAY mirror, background (Mutagen)
cos run 'npm run dev &'        # start a watcher/server; it sees synced edits
# ... Claude edits files locally with normal tools; sync propagates them ...
cos status                     # show box + sync state
cos down                       # stop sync + destroy box
```

### ⚠ Two-way sync footgun

`cos sync` is a **bidirectional** Mutagen mirror with no artifact filter. Sandbox-side writes (`node_modules`, build output, `.git`) **flow back into the local dir**. Before using it:

- Sync a **scoped subdir**, not a repo root full of artifacts you don't want mutated.
- Prefer Pattern A for anything batch — only reach for `sync` when a live process genuinely needs to react to edits.
- The user's repo is theirs: never start a two-way sync on it without saying so explicitly first.
- Local dir must be under `$HOME` or literal `/tmp` (CLI guard; `/private/tmp/*` is rejected). First `sync` downloads the Mutagen engine (~60–90 s before edits propagate); later syncs settle in seconds.

## Lifecycle & cost

- Ephemeral boxes self-destroy; project boxes carry a 30 m idle auto-pause as a backstop.
- Always `cos down` when a live session is finished — don't leave boxes running.
- Quota: 100 sandboxes/day, 2 running at once on external keys. Don't spin a fleet without budgeting against that.
- Pre-existing boxes the user already runs are NOT yours — `cos` only ever touches boxes it created (tagged `cos-*`) or the project box in the statefile.
