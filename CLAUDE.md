# CLAUDE.md — createos (marketplace)

Public Claude Code plugin **marketplace** (`createos`). Its one plugin,
`createos-sandbox` (in `createos-sandbox/`), gives Claude a skill + slash
commands that drive the authed `createos` CLI to run ad-hoc / heavy / untrusted
code in disposable CreateOS sandboxes. Marketplace index is the root `README.md`;
plugin usage/install live in `createos-sandbox/README.md`; this file is the
cross-repo mesh guide.

## Decisions

Architectural decisions live in `docs/adr/`. Read the relevant one before
reworking the thing it covers.

| ADR | Decision | Status |
|---|---|---|
| [0001](./docs/adr/0001-cos-bash-driver.md) | `cos`, a bash driver, as the plugin's execution engine — not the `createos` CLI directly | accepted, **under review** |

ADR-0001 is load-bearing for anyone touching `scripts/cos`, the skill, or the
slash commands. Two things it records that are easy to trip over:
`CLAUDE_PLUGIN_ROOT` is **unset in the Bash tool environment** (so a skill-issued
`${CLAUDE_PLUGIN_ROOT}/scripts/cos` resolves to `/scripts/cos` and dies), and a
missing driver makes Claude **fail open** — it hand-rolls the offload out of raw
CLI primitives and silently loses egress restriction, keepalive, auto-destroy,
and the auth preflight.

The ADR's interim mitigation is now shipped: `scripts/session-start.sh`
(`SessionStart` hook) publishes the driver's resolved absolute path into context
and states that a missing driver is a hard stop. Do not reintroduce
`${CLAUDE_PLUGIN_ROOT}` into skill prose or into any Bash command — it is valid
only in slash-command frontmatter. The standing recommendation to fold the engine
into `createos-cli` and keep this plugin thin is unaffected.

## Related tooling

**createos-sandbox-ghar** (`../createos-sandbox-ghar`) is a sibling public
automation surface over the same CreateOS Sandbox control plane — ephemeral
GitHub Actions self-hosted runners (one microVM per CI job) instead of this
repo's Claude Code IDE integration. Different trigger (`workflow_job`
webhook vs. IDE slash command / skill), different execution engine
(Cloudflare Worker + `createos-sandbox-sdk` vs. this repo's `cos` bash
driver + CLI), same underlying sandbox lifecycle. Not a mesh-protocol
member (see Cross-repo mesh below) — cross-reference only.

## Cross-repo mesh — CreateOS Sandbox

**You are in `createos` — the public Claude Code plugin marketplace; its
`createos-sandbox` plugin** shells out to the `createos` CLI, so `createos-cli`
command / flag changes hit hardest:
keep the skill + slash-command surfaces aligned with the CLI, and any behavior
claim aligned with `fc`. This repo is one of five in the product mesh.

### Repo map

| repo | path | role | public? | changes that ripple across the mesh |
|---|---|---|---|---|
| **fc** | `../fc` | control-plane — **source of truth** | 🔒 private | HTTP API, wire/JSON fields, error shapes, lifecycle/state, limits/quotas, behavior |
| **fc-sdk** | `../fc-sdk` | TypeScript SDK **+ `examples/`** | 🌐 public | public SDK methods, wire types, example apps |
| **createos-cli** | `../createos-cli` | Go CLI | 🌐 public | commands, flags, help/UX text |
| **website-04** | `../website-04` (`content/docs/Sandbox`) | public docs | 🌐 public | REST / SDK / CLI reference + concept pages |
| **createos** | `../createos-claude-plugins` | Claude Code plugin marketplace; `createos-sandbox` plugin over the `createos` CLI | 🌐 public | skills, slash commands, hooks |

### What counts as a shared surface

HTTP endpoint or method · wire or JSON field · error shape · sandbox
lifecycle/state · limit or quota · CLI command or flag · public SDK method ·
documented behavior. A change confined to internals — refactor, comment,
private helper, test-only — is **not** a shared surface, so skip the mesh for it.

### Protocol — run before finalizing a shared-surface change

1. **Classify origin.** `fc` is the source of truth; SDK / CLI / docs / plugin
   are downstream consumers. A downstream change that implies a backend change
   (new field, new endpoint) → surface it to the user; never invent server
   behavior inside a client.
2. **Search every sibling** for the touched symbol / endpoint / flag —
   `semble search` first, then `rg`.
3. **Build a status matrix** per sibling: `already-present` ·
   `missing-needs-update` · `n/a`. **Flag the already-present ones to the user**
   ("already exists in fc-sdk + docs"). Never silently duplicate a change that is
   already there — that is the whole point of this check.
4. **`fc` → any public repo is a leak-guard boundary (security).** Strip private
   implementation, security internals, infra, threat-model notes, and
   internal-only tooling (`fcctl`, host filesystem paths, mTLS/CA internals)
   before anything lands in a public repo. Respect each public repo's own wording
   rules (e.g. `fc-sdk/AGENTS.md` forbids the word "VM"). Report the proposed diff
   and **ask for approval before landing any public edit** — never auto-write
   across the boundary.
5. **Use the `sync-docs` skill** to execute SDK / CLI / website reconciliation
   against upstream `fc` where it applies.
