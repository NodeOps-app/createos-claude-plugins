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
- **`/api/v1/run` reads `RunComplete.outputs` and nothing else.** `Graph.arun`
  goes through `Coordinator.run_to_completion`, which returns only that terminal
  field — the `StepResult` payload stream is never consulted. An executor that
  terminates with `RunComplete(outputs=[])` therefore returns `outputs: []` to
  every API caller while still running the flow correctly; measured live as
  2.9 s with full results (executor off) versus 21 s and nothing (executor on).
  The guest harvests its own vertices like `Graph._run` and ships `RunOutputs`
  back. Do not "simplify" that back to an empty terminal envelope.

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

<!-- MESH:START — generated by fc/scripts/gen-mesh.mjs from fc/mesh.json. Do not edit by hand. -->

## Cross-repo mesh — CreateOS Sandbox

**You are in `createos-plugin` — integrations monorepo — plugins for 8 agent hosts.** Most packages here are thin surfaces over the `createos` CLI, so `createos-cli` changes hit hardest. Two are not: `dsh-createos` pins the TypeScript SDK, and `langflow-sandbox-createos` calls the REST API directly — a wire change reaches those two without touching the CLI.

### The family

| repo | path | role | public? | ripples when you change |
| --- | --- | --- | --- | --- |
| **fc** | `../fc` | control plane — **source of truth** | 🔒 private | HTTP API, wire/JSON fields, error shapes, lifecycle/state, limits/quotas, behavior |
| **[fc-sdk](https://github.com/nodeops-app/fc-sdk)** | `../fc-sdk` | TypeScript SDK **+ `examples/`** | 🌐 public | public SDK methods, wire types, example apps |
| **[createos-go-sdk](https://github.com/NodeOps-app/createos-go-sdk)** | `../createos-go-sdk` | Go SDK | 🌐 public | public SDK methods, wire types, examples |
| **[createos-python-sdk](https://github.com/NodeOps-app/createos-python-sdk)** | `../createos-python-sdk` | Python SDK | 🌐 public | public SDK methods, wire types, examples |
| **[createos-cli](https://github.com/nodeops-app/createos-cli)** | `../createos-cli` | Go CLI (`createos`) | 🌐 public | commands, flags, help/UX text |
| **[createos-v2-landing](https://github.com/NodeOps-app/createos-v2-landing)** | `../createos-v2-landing` | public docs — `apps/docs/src/pages/Sandbox/` | 🌐 public | REST / SDK / CLI reference, concept and integration pages |
| **createos-plugin** ← you are here | this repo | integrations monorepo — plugins for 8 agent hosts | 🌐 public | skills, slash commands, hooks, tools |

### What counts as a shared surface

HTTP endpoint or method · wire or JSON field · error shape · sandbox lifecycle/state · limit or quota · CLI command or flag · public SDK method · documented behavior. A change confined to internals — refactor, private helper, test-only — is **not** a shared surface, so skip the mesh for it.

### Ripple order

`fc` (`openapi.yaml`) → the three SDKs → `createos-cli` → examples → public docs → integrations


Integrations do not all follow the same path — a CLI change reaches the shellers, a wire change reaches the other two directly:

| package | host | reaches CreateOS by | docs page |
| --- | --- | --- | --- |
| `claude-code-plugin` | Claude Code | shells out to `createos` CLI | `Integrations/Claude-Code` |
| `codex-plugin` | Codex | shells out to `createos` CLI | `Integrations/Codex` |
| `opencode-plugin` | OpenCode | shells out to `createos` CLI | `Integrations/OpenCode` |
| `pi-extension` | Pi | shells out to `createos` CLI | `Integrations/Pi` |
| `herdr-plugin` | Herdr | shells out to `createos` CLI | `Integrations/Herdr` |
| `orca-plugin` | Orca | pointer only — code lives in its own repo | `Integrations/Orca` |
| `dsh-createos` | DeepSeek Harness | imports the TypeScript SDK | `Integrations/DeepSeek-Harness` |
| `langflow-sandbox-createos` | Langflow | calls the REST API directly | **none yet** |
| `shared` | shared library | shells out to `createos` CLI | **none yet** |

### Frozen — do not update

- **website-04** (`../website-04`) — Superseded as the docs home by `createos-v2-landing`, which is what <https://createos.sh/docs> actually serves. Its `content/docs/Sandbox/` tree is a parallel copy that was still receiving updates — do not add to it, and do not treat it as the docs target.

### Protocol — run before you call a shared-surface change done

1. **Classify origin.** `fc` is upstream; SDKs, CLI, docs and integrations are downstream consumers. A downstream change that implies new server behavior goes to the user — never invent server behavior inside a client.
2. **Search every sibling** for the touched symbol, endpoint or flag with `rg`. If a sibling checkout is missing, say so rather than guessing.
3. **Build a status matrix** per sibling: `already-present` · `missing-needs-update` · `n/a`. Flag the already-present ones — never silently duplicate a change that is already there.
4. **The control plane is private.** If you do not have access to it, do not guess at server behavior and do not reconstruct its internals here — describe the change you need and hand it to someone who does. Respect each repo's own wording rules; `fc-sdk/AGENTS.md` forbids the word "VM".
5. **Report, don't edit.** This is a read-and-report protocol: do not change a sibling repo unless the user asks you to.

<!-- MESH:END -->

