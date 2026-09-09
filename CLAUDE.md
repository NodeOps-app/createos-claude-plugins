# CLAUDE.md — createos (integrations)

Public plugin marketplace and integrations for CreateOS Sandbox. Six packages
ship host integrations that run ad-hoc / heavy / untrusted code in disposable
CreateOS sandboxes — five through the authed `createos` CLI, one (Langflow)
straight against the REST API:

| Package                          | IDE / host       | Path                           |
| -------------------------------- | ---------------- | ------------------------------ |
| `claude-code-plugin`             | Claude Code      | `packages/claude-code-plugin/` |
| `pi-extension`                   | Pi               | `packages/pi-extension/`       |
| `@createos/opencode`             | OpenCode         | `packages/opencode-plugin/`    |
| `@nodeops-createos/dsh-createos` | DeepSeek Harness | `packages/dsh-createos/`       |
| `createos.sandbox`               | Herdr            | `packages/herdr-plugin/`       |
| `langflow-sandbox-createos`      | Langflow         | `packages/langflow-sandbox-createos/` |

`langflow-sandbox-createos/` is the odd one out twice over: it is **Python**, not
TypeScript, and it does not drive the `createos` CLI — it talks to the control
plane's REST API directly with `httpx`, because it runs inside the Langflow
server process rather than beside an agent. Langflow needs no fork. Do not
"unify" it with the other packages: the `Capabilities` / `SandboxResult`
dataclasses it returns belong to `lfx`, and that coupling is the whole point.

It ships **three** Langflow entry points from one distribution, each opted into
separately:

| Entry point | Surface | Scope |
| ----------- | ------- | ----- |
| `lfx.sandbox_backends` | Python Interpreter's code runs in a microVM | allowlisted by the operator |
| `langflow.extensions` | a **CreateOS Sandbox** canvas component | auto-imported, inert until used |
| `lfx.executors` | a whole flow graph runs in a microVM | `/api/v1/run`, CLI, Loop — **not** the UI |

Two facts that cost real time to establish, both verified against a live
control plane rather than read from docs:

- **CreateOS does not enforce hostname egress rules.** IP and CIDR rules are
  enforced; `host`, `host:port` and `*.host` are accepted, stored, echoed back
  and ignored. The backend therefore declares
  `supports_domain_allowlist=False` and refuses a configured allowlist rather
  than pretending. Do not "fix" that by resolving domains to addresses — DNS
  rotates and CDN addresses are shared.
- **Langflow's UI build endpoint does not use the executor seam.** It walks
  vertices itself, so `LANGFLOW_EXECUTOR_KIND` never affects the playground.

Never name a component input `code`: Langflow reserves `template["code"]` for a
component's own source, and an input by that name silently replaces it.

`herdr-plugin/` targets [Herdr](https://herdr.dev), a terminal workspace
manager rather than a coding agent, so it inverts the shape of the others.
Instead of teaching an agent to use sandboxes, it puts the **agent itself**
inside a sandbox and attaches its PTY to a Herdr pane. It is TypeScript run by
`bun`, and it calls the `createos` CLI and the `herdr` CLI as subprocesses —
Herdr has no plugin SDK, its CLI is the whole plugin API. Read
`packages/herdr-plugin/README.md` before touching it.

The Orca integration is **not** in this repository. Orca installs a plugin by
cloning a whole repository and reading `orca-plugin.json` from its root, so a
subdirectory here cannot be installed by git URL. It lives at
[NodeOps-app/createos-orca-plugin](https://github.com/NodeOps-app/createos-orca-plugin);
`packages/orca-plugin/` keeps only a pointer README.

Do not "fix" this by symlinking a manifest to the root — Orca rejects symlinks
anywhere in plugin content, and this repository's root already carries symlinks
for the Pi extension.

Marketplace index is the root `README.md`; each package has its own `README.md`.

## Decisions

Architectural decisions live in `docs/adr/`. Read the relevant one before
reworking the thing it covers.

| ADR                                                    | Decision                                                                                 | Status                     |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------- | -------------------------- |
| [0001](./docs/adr/0001-cos-bash-driver.md)             | `cos`, a bash driver, as the plugin's execution engine — not the `createos` CLI directly | accepted, **under review** |
| [0003](./docs/adr/0003-pi-extension-prompt-surface.md) | pi-extension prompt surface: `promptGuidelines` only where they add signal               | accepted                   |
| [0004](./docs/adr/0004-herdr-plugin-shape.md)          | Herdr plugin: thin TypeScript over the `createos` CLI, not Rust and not a receipt harness | accepted                   |

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

**You are in `createos` — the public plugin marketplace; its plugins** shell
out to the `createos` CLI, so `createos-cli` command / flag changes hit hardest:
keep the skill + slash-command + tool surfaces aligned with the CLI, and any behavior
claim aligned with `fc`. This repo is one of five in the product mesh.

### Repo map

| repo             | path                                     | role                                                                               | public?    | changes that ripple across the mesh                                                |
| ---------------- | ---------------------------------------- | ---------------------------------------------------------------------------------- | ---------- | ---------------------------------------------------------------------------------- |
| **fc**           | `../fc`                                  | control-plane — **source of truth**                                                | 🔒 private | HTTP API, wire/JSON fields, error shapes, lifecycle/state, limits/quotas, behavior |
| **fc-sdk**       | `../fc-sdk`                              | TypeScript SDK **+ `examples/`**                                                   | 🌐 public  | public SDK methods, wire types, example apps                                       |
| **createos-cli** | `../createos-cli`                        | Go CLI                                                                             | 🌐 public  | commands, flags, help/UX text                                                      |
| **website-04**   | `../website-04` (`content/docs/Sandbox`) | public docs                                                                        | 🌐 public  | REST / SDK / CLI reference + concept pages                                         |
| **createos**     | `../createos-claude-plugins`             | Plugin marketplace; Claude Code, Pi, OpenCode integrations over the `createos` CLI | 🌐 public  | skills, slash commands, hooks, tools                                               |

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
