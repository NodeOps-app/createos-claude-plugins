<div align="center">

# CreateOS Claude Plugin Marketplace

**A [Claude Code](https://docs.claude.com/en/docs/claude-code) plugin marketplace for disposable sandbox compute.**

Run ad-hoc, heavy, or untrusted code **off your machine** in disposable [CreateOS](https://createos.sh) Sandboxes — straight from your Claude Code session.

[![Claude Code](https://img.shields.io/badge/Claude%20Code-plugin-6E56CF)](https://docs.claude.com/en/docs/claude-code)
[![CreateOS](https://img.shields.io/badge/CreateOS-Sandboxes-0EA5E9)](https://createos.sh)
[![Spawn](https://img.shields.io/badge/spawn-~25ms-22C55E)](https://createos.sh)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen)](#contributing)

</div>

---

## Why

Heavy builds, flaky test suites, and untrusted code don't belong on your laptop. `createos-sandbox` gives Claude a skill + slash commands that offload them to throwaway CreateOS Sandboxes that spawn in ~25 ms and self-destruct when done — so your machine stays free, your deps stay isolated, and untrusted code never touches local state.

- 🧨 **Disposable** — one-shot offload stages a dir, runs, pulls artifacts, then auto-destroys. Box-side changes never touch local unless you ask.
- ⚡ **Fast** — ~25 ms spawn; parallel fanout across N boxes for matrix builds and split test suites.
- 🔒 **Isolated** — untrusted code runs in a disposable Sandbox, not your shell. Egress can be locked to an exact allowlist.
- 🔁 **Live loops** — a reusable per-repo box with file sync, port tunnels, and public HTTPS expose for real dev sessions.

## Quick start

```bash
# 1. Add the marketplace + install the plugin
/plugin marketplace add NodeOps-app/createos-claude-plugins
/plugin install createos-sandbox@createos

# 2. Offload a heavy test run to a throwaway box (auto-destroys)
/createos-sandbox:offload . "npm ci && npm test"
```

The `createos` CLI **auto-installs** on first use. Sign in once with `createos login` (browser OAuth, run it in your own terminal) or `export CREATEOS_API_KEY=<key>`; check with `cos auth`. Prefer a local checkout? See [Install](#install).

## Plugins

| Plugin | What it does |
|---|---|
| [**createos-sandbox**](./createos-sandbox) | Offload, parallel fanout, scratch shell, reusable box with sync, port tunnel, public HTTPS expose, private-network clusters, BYO-S3 disk mounts, WireGuard VPN, and snapshot/fork — all driving the authed `createos` CLI. |

> The marketplace currently ships one plugin; more CreateOS plugins land here as siblings.

## Commands at a glance

| Command | What |
|---|---|
| `/createos-sandbox:offload <dir> <cmd>` | one-shot: stage → run → pull artifacts → destroy |
| `/createos-sandbox:fanout <dir> <cmd1> [cmd2 …]` | run each command in its own throwaway box, in parallel |
| `/createos-sandbox:shell` | instant throwaway interactive Linux (destroyed on exit) |
| `/createos-sandbox:up` · `run` · `sync` · `down` | reusable per-repo box + file sync for live dev loops |
| `/createos-sandbox:tunnel <port>` | forward a box port to `127.0.0.1` (private) |
| `/createos-sandbox:expose <port>` | public HTTPS URL for a box port |
| `/createos-sandbox:cluster …` | N boxes on one private network, name-addressable |
| `/createos-sandbox:disk …` | mount your own S3 bucket into the project box |
| `/createos-sandbox:vpn …` | WireGuard L3 into your private networks |
| `/createos-sandbox:fork` | snapshot the project box → independent clone |
| `/createos-sandbox:status` | show active box + sync + tunnels + cluster |

Full flags, networking guide, and heavy-build tips live in the [**plugin README**](./createos-sandbox/README.md).

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

**Dev (instant, no install):**
```bash
claude --plugin-dir /path/to/createos-claude-plugins/createos-sandbox
/reload-plugins      # after editing plugin files
```

## Requirements

- **[CreateOS](https://createos.sh) account** — the `createos` CLI auto-installs on first use. Opt out with `COS_NO_AUTOINSTALL=1`.
- **Sign-in** — `createos login` in your own terminal (interactive browser OAuth; Claude can't drive a TTY prompt), or `export CREATEOS_API_KEY=<key>` to skip the browser entirely. `cos auth` reports which is active.
- **Host tools:** `jq`, `tar`, `bash`, `base64`; `perl` for ANSI/path handling; `curl` for the one-time CLI install.

## Safety

- **One-way by default** — offload uploads and sync are laptop → box; box-side writes never flow back unless you opt in (`-2`).
- **Excludes** — `.git`, `node_modules`, `target`, `.venv`, and other regenerable dirs are stripped from uploads by default.
- **Scoped** — `cos` only ever touches boxes it created (`cos-*`) or the project box in its statefile. Your other sandboxes are never touched.
- **Quota** — 100 sandboxes/day, 2 running at once (external keys). Don't spin a fleet without budgeting.

## Repository layout

```
createos/                         # marketplace root
├─ .claude-plugin/
│  └─ marketplace.json            # marketplace manifest
└─ createos-sandbox/              # the plugin
   ├─ .claude-plugin/plugin.json
   ├─ commands/                   # slash commands
   ├─ skills/                     # the using-createos-sandbox skill
   ├─ hooks/                      # PreToolUse offload-hint
   ├─ scripts/cos                 # the CLI driver
   └─ README.md
```

## Claude Managed Agents

This plugin runs sandboxes from *inside* Claude Code, to move work off your machine. The mirror-image problem — letting [Claude Managed Agents](https://platform.claude.com/docs/en/managed-agents/overview) execute their tool calls inside a sandbox you control, as a self-hosted environment — is the SDK's job, not the plugin's. Reference implementations live in [`createos-sandbox-sdk/examples`](https://github.com/NodeOps-app/createos-sandbox-sdk/tree/main/examples):

| example | topology |
| --- | --- |
| `36-self-hosted-agent-worker` | one persistent sandbox running an always-on worker |
| `37-self-hosted-sandbox-per-session` | a fresh sandbox per session |

Anthropic keeps the agent loop and session state; the sandbox is the execution boundary, so agent code, files, and egress stay on your infrastructure.

## Contributing

Issues and PRs welcome. The plugin is a thin Claude Code surface over the [`createos`](https://createos.sh) CLI — most command logic lives in [`createos-sandbox/scripts/cos`](./createos-sandbox/scripts/cos). Keep the slash-command, skill, and CLI surfaces aligned.

## Links

- 🌐 [createos.sh](https://createos.sh) — CreateOS platform
- 📖 [Claude Code plugins](https://docs.claude.com/en/docs/claude-code) — how plugins & marketplaces work
- 📦 [Plugin README](./createos-sandbox/README.md) — full command & flag reference
- 🤖 [Managed Agents examples](https://github.com/NodeOps-app/createos-sandbox-sdk/tree/main/examples) — self-hosted environments on CreateOS sandboxes
