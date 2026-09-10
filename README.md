<div align="center">

# CreateOS Integrations

**[Claude Code](https://docs.claude.com/en/docs/claude-code), [Codex](https://github.com/openai/codex), [Pi](https://github.com/anthropics/pi), [OpenCode](https://opencode.ai) & DeepSeek Harness plugins for disposable sandbox compute.**

Run code **off your machine** in disposable [CreateOS](https://createos.sh) Sandboxes — from Claude Code, Codex, Pi, OpenCode, or DeepSeek Harness.

[![Claude Code](https://img.shields.io/badge/Claude%20Code-plugin-6E56CF)](https://docs.claude.com/en/docs/claude-code)
[![Pi](https://img.shields.io/badge/Pi-extension-F97316)](https://github.com/anthropics/pi)
[![Codex](https://img.shields.io/badge/Codex-plugin-10A37F)](https://github.com/openai/codex)
[![OpenCode](https://img.shields.io/badge/OpenCode-plugin-0EA5E9)](https://opencode.ai)
[![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-plugin-111827)](./packages/dsh-createos)
[![CreateOS](https://img.shields.io/badge/CreateOS-Sandboxes-0EA5E9)](https://createos.sh)
[![Spawn](https://img.shields.io/badge/create%20to%20first%20command-~200ms-22C55E)](https://createos.sh)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen)](#contributing)

</div>

---

## Why

Heavy builds, flaky test suites, and untrusted code don't belong on your laptop. `claude-code-plugin` gives Claude a skill + slash commands that offload them to throwaway CreateOS Sandboxes — created and running your first command in roughly 200 ms, self-destructing when done — so your machine stays free, your deps stay isolated, and untrusted code never touches local state.

- 🧨 **Disposable** — one-shot offload stages a dir, runs, pulls artifacts, then auto-destroys. Box-side changes never touch local unless you ask.
- ⚡ **Fast** — ~200 ms from create to first command; parallel fanout across N boxes for matrix builds and split test suites.
- 🔒 **Isolated** — untrusted code runs in a disposable Sandbox, not your shell. Egress can be locked to an exact allowlist.
- 🔁 **Live loops** — a reusable per-repo box with file sync, port tunnels, and public HTTPS expose for real dev sessions.
- 💤 **Cheap to keep** — `pause` snapshots a warm box (deps and all) at zero compute cost; `resume` brings it back in a handful of seconds.

## Quick start

**Claude Code:**

```bash
# 1. Add the marketplace + install the plugin
/plugin marketplace add NodeOps-app/createos-claude-plugins
/plugin install createos-sandbox@createos

# 2. Offload a heavy test run to a throwaway box (auto-destroys)
/createos-sandbox:offload . "npm ci && npm test"
```

**Pi:**

```bash
# 1. Install the extension from this repository
pi install git:github.com/NodeOps-app/createos-claude-plugins

# 2. Start Pi locally with CreateOS sandbox tools available
pi

# Optional: create a sandbox and route Pi's built-in tools into it
pi --inside-createos-sandbox

# Optional: copy this project to /root/workspace before sandbox-mode Pi starts
pi --inside-createos-sandbox --createos-sync-once

# Optional: continuously sync this project and /root/workspace in sandbox mode
pi --inside-createos-sandbox --createos-watch
```

**Codex:**

```bash
# 1. Add the marketplace
codex plugin marketplace add NodeOps-app/createos-claude-plugins

# 2. Install the plugin
codex plugin add @createos/codex@createos

# 3. Launch codex — the skill teaches createos CLI usage
codex
```

**OpenCode:**

```bash
# 1. Install the plugin
opencode plugin @createos/opencode --global

# 2. Launch opencode — sandbox tools are available automatically
opencode
```

**DeepSeek Harness:**

```bash
# 1. Install the bundle from this monorepo checkout
dsh plugin --profile web add /path/to/createos-claude-plugins/packages/dsh-createos

# 2. Configure CreateOS sandbox credentials
export CREATEOS_SANDBOX_API_KEY='...'
export CREATEOS_SANDBOX_SHAPE='s-2vcpu-2gb'

# 3. Start DSH Web from the workspace path the remote tools should use
dsh web
```

The Claude Code, Codex, Pi, and OpenCode integrations use the `createos` CLI, which **auto-installs** on first use. Sign in once with `createos login` (browser OAuth, run it in your own terminal) or `export CREATEOS_API_KEY=<key>`; check with `cos auth`. The DeepSeek Harness integration uses `@nodeops-createos/sandbox` and `CREATEOS_SANDBOX_*` environment variables. Prefer a local checkout? See [Install](#install).

## Packages

| Package                                                       | What it does                                                                                                                                                                                                                                                |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [**claude-code-plugin**](./packages/claude-code-plugin)       | Hooks-based Claude Code plugin — offload, parallel fanout, scratch shell, reusable box with sync, port tunnel, public HTTPS expose, private-network clusters, BYO-S3 disk mounts, WireGuard VPN, and snapshot/fork — all driving the authed `createos` CLI. |
| [**pi-extension**](./packages/pi-extension)                   | Pi coding agent extension with all 33 `sandbox_*` tools for lifecycle, configuration, port tunnels, file sync, private networks, persistent disks, and device VPN. Built-in tools route remotely only with `--inside-createos-sandbox`.                     |
| [**@createos/codex**](./packages/codex-plugin)                | Codex plugin — skill that teaches the `createos` CLI for sandbox lifecycle, networking, disks, and VPN.                                                                                                                                                     |
| [**@createos/opencode**](./packages/opencode-plugin)          | OpenCode plugin with 33 sandbox tools (`sandbox_exec`, `sandbox_push`, `sandbox_pull`, networks, disks, VPN, sync) and system prompt injection for sandbox-first workflows.                                                                                 |
| [**@nodeops-createos/dsh-createos**](./packages/dsh-createos) | DeepSeek Harness bundle that replaces `ctx.fs` and `ctx.subprocess` together, so Bash, file, LSP, and PTY consumers operate inside one CreateOS sandbox without provider-specific tool forks.                                                               |
| [**createos.sandbox**](./packages/herdr-plugin)               | Herdr plugin that runs Claude Code, Codex, OpenCode, Pi, or Cursor **inside** a CreateOS Sandbox and attaches its PTY to a Herdr pane. One pane maps to one sandbox, with filtered upload, two-way sync, patch apply back, and Herdr agent detection.        |
| [**langflow-sandbox-createos**](./packages/langflow-sandbox-createos) | Langflow integration (Python, pip) — three surfaces from one install: a **sandbox backend** hardening the Python Interpreter, a **CreateOS Sandbox component** with guest reuse and file return, and an **executor** that runs a whole flow graph in a microVM. A Langflow host with no KVM/HVF still gets hardware isolation.                                  |
| [**createos-orca-plugin**](https://github.com/NodeOps-app/createos-orca-plugin)| Orca VM recipe — runs a whole Orca workspace on a disposable microVM instead of your laptop. Lives in its own repository, because Orca installs a plugin from a repository root. Optionally installs Claude Code, Codex, Cursor, OpenCode, or Pi.           |
| [**@createos/n8n-nodes-createos**](https://github.com/NodeOps-app/n8n-nodes-createos)| n8n community node — create and manage sandboxes, run shell commands, transfer files, and manage templates, networks, and disks from n8n workflows. Lives in its own repository; talks to the REST API with a **CreateOS API** credential, not the CLI.                                          |

## Orca — run a workspace on a sandbox

Orca creates one disposable microVM per workspace and connects to it over SSH, so
builds, installs, and test runs stay off your laptop.

```bash
# 1. In Orca: Settings > Plugins > Install from git URL
https://github.com/NodeOps-app/createos-orca-plugin.git#v0.1.0

# 2. Create a workspace, and under "Run on" pick:
#    Per-Workspace Environment > CreateOS Sandbox
```

Pick which coding agents get installed with `CREATEOS_AGENTS`:

```bash
CREATEOS_AGENTS=claude,codex
```

Your project needs a git remote — Orca matches remote identity to confirm the
sandbox checkout is the same project. Suspend and resume are not supported yet.
Setup, configuration, limits, and troubleshooting live in the
[**createos-orca-plugin**](https://github.com/NodeOps-app/createos-orca-plugin).

## Claude Code — commands at a glance

| Command                                          | What                                                                    |
| ------------------------------------------------ | ----------------------------------------------------------------------- |
| `/createos-sandbox:offload <dir> <cmd>`          | one-shot: stage → run → pull artifacts → destroy                        |
| `/createos-sandbox:fanout <dir> <cmd1> [cmd2 …]` | run each command in its own throwaway box, in parallel                  |
| `/createos-sandbox:shell`                        | instant throwaway interactive Linux (destroyed on exit)                 |
| `/createos-sandbox:up` · `run` · `sync` · `down` | reusable per-repo box + file sync for live dev loops                    |
| `/createos-sandbox:tunnel <port>`                | forward a box port to `127.0.0.1` (private)                             |
| `/createos-sandbox:expose <port>`                | public HTTPS URL for a box port                                         |
| `/createos-sandbox:cluster …`                    | N boxes on one private network, name-addressable                        |
| `/createos-sandbox:disk …`                       | mount your own S3 bucket into the project box                           |
| `/createos-sandbox:vpn …`                        | WireGuard L3 into your private networks                                 |
| `/createos-sandbox:fork`                         | snapshot the project box → independent clone                            |
| `/createos-sandbox:pause` · `resume`             | park the warm box at zero compute cost, then restore it exactly         |
| `/createos-sandbox:template …`                   | build a custom image so boxes boot with the toolchain already installed |
| `/createos-sandbox:status`                       | show active box + sync + tunnels + cluster                              |

Full flags, networking guide, and heavy-build tips live in the [**Claude Code Plugin README**](./packages/claude-code-plugin/README.md).

## Pi — commands at a glance

Pi and built-in tools run locally by default. `--inside-createos-sandbox` routes built-ins (bash, read, write, edit, ls, find, grep) to a sandbox; all 33 sandbox lifecycle, networking, disk, and device-VPN tools remain available in either mode.

| Command                    | What                                  |
| -------------------------- | ------------------------------------- |
| `/sandbox`                 | Show sandbox status                   |
| `/network create <name>`   | Create a private network              |
| `/network ls`              | List your networks                    |
| `/network show <name>`     | Show network members + IPs            |
| `/network attach <name>`   | Join this sandbox to a network        |
| `/network detach <name>`   | Leave a network                       |
| `/network rm <name>`       | Delete a network                      |
| `/device status`           | Show registered devices               |
| `/device attach <network>` | Give your machine access to a network |
| `/device detach <network>` | Remove access                         |

### Flags

| Flag                          | Purpose                                |
| ----------------------------- | -------------------------------------- |
| `--inside-createos-sandbox`   | Run Pi inside a sandbox                |
| `--createos-shape <shape>`    | Sandbox shape (default: `s-2vcpu-2gb`) |
| `--createos-rootfs <name>`    | Base image or template                 |
| `--createos-network <name>`   | Network(s) to join at creation         |
| `--createos-sync-once`        | Copy project to `/root/workspace` once |
| `--createos-avoid-git-ignore` | Include Git-ignored files in that copy |
| `--createos-watch`            | Two-way project sync for this session  |

Use `--createos-sync-once`, `--createos-watch`, and other `--createos-*` flags with
`--inside-createos-sandbox`. The sync flags are mutually exclusive. The first preserves
sandbox-only files and excludes VCS metadata plus Git-ignored files by default;
`--createos-avoid-git-ignore` includes ignored files. The latter starts the existing two-way
sync. In sandbox mode, loaded Pi skill directories are mirrored before the first agent turn;
Pi credentials, settings, and sessions stay local.

Full tool inventory lives in the [**Pi Extension README**](./packages/pi-extension/README.md).

## OpenCode — tools at a glance (40)

| Category            | Tools                                                                                                                  |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| **Execute & Files** | `sandbox_exec`, `sandbox_pull`, `sandbox_push`                                                                         |
| **Lifecycle**       | `sandbox_create`, `sandbox_list`, `sandbox_info`, `sandbox_pause`, `sandbox_resume`, `sandbox_fork`, `sandbox_destroy` |
| **Config**          | `sandbox_ingress`, `sandbox_firewall`, `sandbox_bandwidth`, `sandbox_shapes`, `sandbox_images`                         |
| **Ports & Sync**    | `sandbox_preview_url`, `sandbox_tunnel`, `sandbox_sync`                                                                |
| **Networks**        | `sandbox_network_create/list/show/attach/detach/delete`                                                                |
| **Disks**           | `sandbox_disk_create/list/show/delete/attach/detach`                                                                   |
| **Device VPN**      | `sandbox_device_register/status/attach/detach`, `sandbox_vpn_up`                                                       |

Full reference in [opencode-plugin/README.md](./packages/opencode-plugin/README.md).

## DeepSeek Harness — execution world

The DSH bundle replaces the local filesystem and subprocess providers with CreateOS-backed providers over one shared sandbox. It uses the CreateOS SDK and managed-process API rather than the `createos` CLI.

| Surface          | What runs remotely                                 |
| ---------------- | -------------------------------------------------- |
| `ctx.fs`         | read, write, edit, glob, search, and atomic writes |
| `ctx.subprocess` | one-shot Bash commands and managed process waits   |
| PTY terminals    | persistent terminal sessions via managed PTYs      |

Full reference in [dsh-createos/README.md](./packages/dsh-createos/README.md).

## Install

**From GitHub (recommended):**

```
/plugin marketplace add NodeOps-app/createos-claude-plugins
/plugin install createos-sandbox@createos
```

**From a local checkout:**

```
git clone https://github.com/NodeOps-app/createos-claude-plugins
/plugin marketplace add /path/to/createos-claude-plugins
/plugin install createos-sandbox@createos
```

**DeepSeek Harness from a local checkout:**

```bash
dsh plugin --profile web add /path/to/createos-claude-plugins/packages/dsh-createos
```

**Dev (instant, no install):**

```bash
claude --plugin-dir /path/to/createos-claude-plugins/packages/claude-code-plugin
/reload-plugins      # after editing plugin files
```

## Requirements

- **[CreateOS](https://createos.sh) account** — the `createos` CLI auto-installs on first use. Opt out with `COS_NO_AUTOINSTALL=1`.
- **Sign-in** — `createos login` in your own terminal (interactive browser OAuth; Claude can't drive a TTY prompt), or `export CREATEOS_API_KEY=<key>` to skip the browser entirely. `cos auth` reports which is active.
- **DeepSeek Harness env:** `CREATEOS_SANDBOX_API_KEY` and `CREATEOS_SANDBOX_SHAPE`; optional `CREATEOS_SANDBOX_BASE_URL` and `CREATEOS_SANDBOX_ROOTFS`.
- **Host tools:** `jq`, `tar`, `bash`, `base64`; `perl` for ANSI/path handling; `curl` for the one-time CLI install.

## Safety

- **One-way by default** — offload uploads and sync are laptop → box; box-side writes never flow back unless you opt in (`-2`).
- **Excludes** — `.git`, `node_modules`, `target`, `.venv`, and other regenerable dirs are stripped from uploads by default.
- **Scoped** — `cos` only ever touches boxes it created (`cos-*`) or the project box in its statefile. Your other sandboxes are never touched.
- **Quota** — external keys have been observed to allow 2 boxes running at once, with a daily creation cap. This is observed behaviour, not published policy — budget `cluster` and `fanout` against it and expect excess jobs to queue rather than fail.

## Repository layout

```
createos-claude-plugins/              # marketplace root
├─ .claude-plugin/
│  └─ marketplace.json                # marketplace manifest
├─ packages/
│  ├─ claude-code-plugin/             # hooks-based Claude plugin
│  │  ├─ .claude-plugin/plugin.json
│  │  ├─ commands/                    # slash commands
│  │  ├─ skills/                      # the using-createos-sandbox skill + references/
│  │  ├─ hooks/                       # SessionStart driver-path + PreToolUse offload-hint
│  │  ├─ scripts/cos                  # the CLI driver
│  │  └─ README.md
│  ├─ pi-extension/                   # Pi extension (TypeScript)
│  │  ├─ index.ts                     # extension entry point
│  │  ├─ src/                         # tools, CLI wrappers, ops
│  │  └─ README.md
│  ├─ codex-plugin/                  # Codex plugin
│  │  ├─ manifest.json
│  │  ├─ scripts/cos, session-start.sh
│  │  ├─ skills/using-createos-sandbox/
│  │  └─ README.md
│  ├─ opencode-plugin/               # OpenCode plugin
│  │  ├─ index.ts                     # plugin entry (CreateOSPlugin)
│  │  ├─ src/cli.ts                   # createos CLI wrappers
│  │  ├─ src/tools.ts                 # 33 tool definitions
│  │  ├─ src/util.ts                  # shellQuote, shortId, joinPath
│  │  └─ README.md
│  ├─ dsh-createos/                  # DeepSeek Harness plugin
│  │  ├─ cordis.patch.yml             # DSH bundle patch
│  │  ├─ src/createos/                # sandbox owner + managed-process client
│  │  ├─ src/fs/                      # CreateOS-backed ctx.fs provider
│  │  ├─ src/subprocess/              # CreateOS-backed ctx.subprocess + PTY provider
│  │  └─ README.md
│  ├─ langflow-sandbox-createos/       # Langflow sandbox backend (Python, pip)
│  │  ├─ pyproject.toml                # lfx.sandbox_backends entry point
│  │  ├─ src/langflow_sandbox_createos/ # the backend
│  │  ├─ tests/test_backend.py         # httpx.MockTransport control plane
│  │  └─ README.md
│  └─ herdr-plugin/                  # Herdr plugin (TypeScript, run by bun)
│     ├─ herdr-plugin.toml            # actions, panes, build step
│     ├─ build.sh                     # writes run.sh with absolute bun/createos paths
│     ├─ src/main.ts                  # actions: start, attach, sync, apply, delete …
│     ├─ src/agents.ts                # the five agent installers
│     ├─ src/lib.ts                   # herdr + createos + pane state helpers
│     ├─ test/filter.test.ts          # upload filter tests
│     └─ README.md
├─ apps/                              # (future starter templates)
├─ docs/
│  └─ adr/                            # architecture decision records
└─ README.md
```

## Contributing

Issues and PRs welcome. The Claude Code, Codex, Pi, and OpenCode plugins are thin surfaces over the [`createos`](https://createos.sh) CLI; keep those command surfaces aligned. The DeepSeek Harness bundle uses the CreateOS SDK and managed-process API, so keep it aligned with the SDK and control-plane API.

## Links

- [createos.sh](https://createos.sh) — CreateOS platform
- [Claude Code plugins](https://docs.claude.com/en/docs/claude-code) — how plugins & marketplaces work
- [OpenCode plugins](https://opencode.ai/docs/plugins/) — OpenCode plugin docs
- [Claude Code plugin README](./packages/claude-code-plugin/README.md)
- [Pi extension README](./packages/pi-extension/README.md)
- [Codex plugin README](./packages/codex-plugin/README.md)
- [OpenCode plugin README](./packages/opencode-plugin/README.md)
- [DeepSeek Harness plugin README](./packages/dsh-createos/README.md)
- [Herdr plugin README](./packages/herdr-plugin/README.md)
- [Langflow sandbox backend README](./packages/langflow-sandbox-createos/README.md)
- [Herdr plugins](https://herdr.dev/docs/plugins/) — how Herdr plugins work
- [Orca plugin README](https://github.com/NodeOps-app/createos-orca-plugin#readme) — separate repository
- [n8n node README](https://github.com/NodeOps-app/n8n-nodes-createos#readme) — separate repository
