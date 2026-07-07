# CLAUDE.md — createos-plugin

Public Claude Code plugin: gives Claude a skill + slash commands that drive the
authed `createos` CLI to run ad-hoc / heavy / untrusted code in disposable
CreateOS sandboxes. Usage and install live in `README.md`; this file is the
cross-repo mesh guide.

## Cross-repo mesh — CreateOS Sandbox

**You are in `createos-plugin` — the public Claude Code plugin.** It shells out
to the `createos` CLI, so `createos-cli` command / flag changes hit hardest:
keep the skill + slash-command surfaces aligned with the CLI, and any behavior
claim aligned with `fc`. This repo is one of five in the product mesh.

### Repo map

| repo | path | role | public? | changes that ripple across the mesh |
|---|---|---|---|---|
| **fc** | `../fc` | control-plane — **source of truth** | 🔒 private | HTTP API, wire/JSON fields, error shapes, lifecycle/state, limits/quotas, behavior |
| **fc-sdk** | `../fc-sdk` | TypeScript SDK **+ `examples/`** | 🌐 public | public SDK methods, wire types, example apps |
| **createos-cli** | `../createos-cli` | Go CLI | 🌐 public | commands, flags, help/UX text |
| **website-04** | `../website-04` (`content/docs/Sandbox`) | public docs | 🌐 public | REST / SDK / CLI reference + concept pages |
| **createos-plugin** | `../createos-plugin` | Claude Code plugin over the `createos` CLI | 🌐 public | skills, slash commands, hooks |

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
