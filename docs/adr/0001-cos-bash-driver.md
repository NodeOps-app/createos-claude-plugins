# `cos`, a bash driver, as the plugin's execution engine

**Status:** accepted — under review, see [Revisiting](#revisiting)

The `createos-sandbox` plugin does not call the `createos` CLI directly. It ships `scripts/cos`, a 718-line portable bash driver, and every slash command and skill instruction goes through it. We chose this over calling `createos` directly (the CLI had no `offload`, `fanout`, keepalive, staging excludes, project-box state, or egress presets) and over building those into `createos-cli` first (a Go release cycle we did not want to block plugin iteration on), because a plugin-local bash script ships the moment the plugin ships and let us find the right agent-facing verbs by trial rather than by committee.

## Context

`createos sandbox` already exposes the primitives: `create`, `exec`, `push`, `pull`, `rm`, `sync`, `tunnel`, `fork`, `disk`, `network`, `firewall`, `shell`. It does not expose the *compositions* an agent needs. `cos` supplies exactly six things on top:

| `cos` adds | Why the primitives aren't enough |
|---|---|
| `offload` | stage → exec → pull → **auto-destroy** as one atomic verb; the safe default |
| `fanout` | N throwaway boxes in parallel, per-job logs + exit codes, concurrency cap |
| `run_keepalive` | `createos sandbox exec` drops its stream on long/quiet builds; this detaches, heartbeats, and re-attaches |
| staging + excludes | `push` has no ignore semantics, so `.git`/`node_modules`/`target` get uploaded by hand |
| project-box state | a reusable per-git-root box (`cos-proj-<12hex>`), so `up`/`run`/`sync`/`down` address "this repo's box" |
| egress presets | `firewall` is a raw primitive; `-p python-uv\|rust-cargo\|npm\|github` are the allowlists people actually want |

Everything else `cos` does is passthrough. The genuinely additive surface is small — and, notably, none of it is Claude-specific. `run_keepalive` is a correctness fix for `exec`; staging excludes are a correctness fix for `push`. Both currently exist only for plugin users.

## Consequences

**The driver must be located before it can be run, and that fails silently.** Slash commands invoke `"${CLAUDE_PLUGIN_ROOT}/scripts/cos"`, which Claude Code expands at command-load time — that path works. But `CLAUDE_PLUGIN_ROOT` is **unset in the Bash tool's environment**, so when the *skill* (rather than a slash command) tells Claude to run `${CLAUDE_PLUGIN_ROOT}/scripts/cos`, it expands to `/scripts/cos` and dies with exit 127. Autonomous use — the skill deciding on its own to offload, which is the plugin's entire reason to exist — hits this on every invocation.

**And it fails open, not closed.** Verified end-to-end on 2026-07-09 by running Claude Code against this plugin in tmux: on `/scripts/cos: no such file`, the agent concluded "cos not on PATH … Skill docs assume cos. Using createos directly", then hand-rolled the offload out of `create`/`push`/`exec`. In its own words: *"no egress restriction was applied … don't read this run as evidence the lockdown path works."* It left the box running and billing. Losing the wrapper means silently losing keepalive, egress restriction, auto-destroy, and the `ensure_auth` preflight — every safety property the wrapper exists to enforce. A missing driver should hard-stop, not degrade into a less safe path.

**A contributing footgun lives upstream.** `createos` exits **0** on an unknown subcommand and prints help. That masked the adapter failure for several turns, both for the agent under test and for the human reading over its shoulder. Worth fixing in `createos-cli` independent of anything here.

**Two implementations, two languages, one behaviour.** `ensure_auth` in `cos` reimplements `config.IsLoggedIn()` from `createos-cli` (env `CREATEOS_API_KEY` → `~/.createos/.token` → `~/.createos/.oauth`). The bash copy can drift from the Go original, and only the Go original is authoritative. The same is true of the shape/egress/exclude defaults.

**Security-sensitive logic in bash.** Staging, argument construction, and exec paths are all bash. Hardening this script has already cost a review pass over array expansion, bash 3.2 compatibility, exit-code extraction, and command injection via custom install URLs. In Go these are largely non-problems.

## Revisiting

The recommendation on record is to **fold the engine into `createos-cli` and keep the plugin thin**:

- **Move to `createos-cli` (Go):** `offload`, `fanout`, keepalive/re-attach, staging + excludes, project-box lifecycle (`up`/`run`/`down`/`status`, on top of the existing `.createos.json` + `FindProjectConfig` machinery), egress presets.
- **Keep in the plugin:** the skill (*when* to offload, what never to offload), the slash commands, the `offload-hint` hook, the agent-facing safety prose.

`cos` then shrinks to nothing and is deleted. The `CLAUDE_PLUGIN_ROOT` bootstrap problem disappears with it — the driver becomes `createos`, already on `PATH` — as does `ensure_auth`, since the CLI owns auth. Making `offload` a first-class CLI verb also fixes the deeper problem the test exposed: *any* capable agent handed only the primitives will compose them and get the safety properties wrong. The safe path has to be the obvious one.

Not yet decided, and deliberately not decided here:

- **`fc` exec semantics.** `run_keepalive` polls to detect a dropped exec stream. Whether that is the right shape in Go depends on what the control plane actually exposes for exec status. `fc` is the source of truth; a client must not invent server behaviour.
- **Migration shape.** Incremental (ship `createos sandbox offload` + keepalive, have `cos` delegate when present, then strip) rather than big-bang — the bash is battle-tested and the Go is not yet written.
- **Interim fix for `CLAUDE_PLUGIN_ROOT`.** A `SessionStart` hook can inject the resolved absolute path into context (hooks *do* get `CLAUDE_PLUGIN_ROOT`), with no filesystem mutation. It would be deleted alongside `cos`. Alternatives considered: having the hook run `cos install` (writes to `~/.local/bin` unasked), or teaching the skill to glob `~/.claude/plugins/cache/*/createos-sandbox/*/scripts/cos` (brittle — an internal Claude Code layout, and wrong for `--plugin-dir` dev installs).
