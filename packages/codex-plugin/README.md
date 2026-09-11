# createos-sandbox-codex

Codex plugin that runs ad-hoc, heavy, or untrusted code OFF your machine, in
disposable [CreateOS](https://createos.sh) Sandboxes.

Same engine as the Claude Code plugin: the `cos` bash driver, the
`using-createos-sandbox` skill, and a session-start hook that publishes the
driver's absolute path. `scripts/cos` and `skills/` are copies of
`packages/claude-code-plugin/` kept in sync by `scripts/sync-shared.sh`
(CI fails on drift) — edit the originals there, never these copies.

## Install

```bash
# 1. Add the marketplace
codex plugin marketplace add NodeOps-app/createos-plugin

# 2. Install the plugin
codex plugin add createos-sandbox-codex --marketplace createos
```

## Prerequisites

1. **createos CLI** — `cos` auto-installs it on first use, or manually:

   ```bash
   curl -sfL https://raw.githubusercontent.com/NodeOps-app/createos-cli/main/install.sh | sh
   ```

2. **Login** (one-time, in your own terminal — it opens a browser):

   ```bash
   createos login
   ```

   Or export `CREATEOS_API_KEY`. Never paste an API key into the agent chat.

3. `jq`, `tar`, `perl`, `curl` — `cos` needs them; the session-start hook is a
   no-op without `jq`.

## How it works

1. The session-start hook prints the driver's absolute path into Codex's context
   and states the verb rule (`offload` for work with a finish line, `up`/`run`
   for work that outlives one command).
2. A `pre-tool-use` hook watches shell calls and suggests offloading when it sees
   a heavy build or test. Advisory only — it never blocks. Silence with
   `COS_NO_HINT=1`.
3. The `using-createos-sandbox` skill carries the depth: egress restriction,
   networking, lifecycle, images.
4. Everything executes through `cos`, which wraps the authed `createos` CLI.

**Do not hand-roll offloads out of raw `createos sandbox create/push/exec`.**
That path looks equivalent and silently drops egress restriction, the keepalive
that survives a dropped stream on a long build, guaranteed auto-destroy, and the
auth preflight.

## Verbs

Run `cos help` for the full list.

| Verb                          | What                                                          |
| ----------------------------- | ------------------------------------------------------------- |
| `cos offload <dir> '<cmd>'`   | one-shot: stage → run (keepalive) → pull → destroy            |
| `cos fanout <dir> '<cmd>'...` | each command in its own throwaway box, in parallel            |
| `cos shell`                   | instant throwaway interactive Linux, destroyed on exit        |
| `cos up` / `run` / `down`     | reusable project box, one per git root                        |
| `cos sync`                    | background file sync into the project box                     |
| `cos pause` / `resume`        | park a warm box at zero compute cost, restore it intact       |
| `cos fork`                    | snapshot the project box into an independent clone            |
| `cos tunnel` / `expose`       | box port → `127.0.0.1`, or a public HTTPS URL                 |
| `cos cluster`                 | N boxes on one private network, addressable by name           |
| `cos disk`                    | BYO S3 bucket mounts                                          |
| `cos vpn`                     | WireGuard into your private networks                          |
| `cos template`                | build a custom rootfs from a Dockerfile                       |
| `cos desktop` / `computer`    | graphical box + noVNC URL; drive it by screenshot/click/type  |

## Architecture

```
packages/codex-plugin/
├── .codex-plugin/plugin.json    # Codex plugin manifest (name, version)
├── manifest.json                # Codex manifest — skills + hooks wiring
├── skills/using-createos-sandbox/
│   ├── SKILL.md                 # copy — canonical lives in claude-code-plugin
│   └── references/              # copies — offload-and-egress, networking, lifecycle-and-images
├── scripts/
│   ├── cos                      # copy — the driver
│   ├── offload-hint.sh          # copy — pre-tool-use nudge
│   └── session-start.sh         # codex-specific: resolves cos relative to itself
└── README.md
```

`scripts/session-start.sh` is the one file that is deliberately *not* a copy:
Codex sets no `CLAUDE_PLUGIN_ROOT`, so it resolves the driver relative to its own
location. The wire format is identical — Codex parses
`hookSpecificOutput.additionalContext` exactly like Claude Code does.

Symlinking the shared files instead of copying them does not work: the Codex
plugin installer copies regular files only, so a symlinked repo installs with no
driver and no skill, silently. Verified against codex-cli 0.153.4.

## Differences from the Pi and OpenCode plugins

| Capability       | Pi                            | OpenCode                             | Codex                                |
| ---------------- | ----------------------------- | ------------------------------------ | ------------------------------------ |
| Integration      | `pi.registerTool()`           | `tool()` in plugin                   | skill + hooks over the `cos` driver  |
| Custom tools     | 34 registered tools           | 38 registered tools                  | none — the agent's own shell         |
| Slash commands   | no                            | no                                   | no (Claude Code plugin has 20)       |
| Install          | `pi install npm:@createos/pi` | `opencode plugin @createos/opencode` | `codex plugin add createos-sandbox-codex --marketplace createos` |

## License

Apache-2.0
