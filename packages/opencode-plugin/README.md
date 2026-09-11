# @createos/opencode

OpenCode plugin that runs all tool calls inside a remote
[CreateOS Sandbox](https://createos.sh) while the agent runs locally.

Every operation shells out to the `createos` CLI, except computer-use — the CLI
has no `sandbox computer` command yet, so those calls go straight to the REST
API. Auth is handled by `createos login`.

```
OpenCode agent (local)  →  createos CLI  →  CreateOS API  →  Sandbox (remote VM)
```

## Install

### From npm (global — works from any project)

```bash
opencode plugin @createos/opencode --global
```

### Local development

Drop the plugin shim into your project:

```bash
mkdir -p .opencode/plugins
cat > .opencode/plugins/createos.ts << 'EOF'
export { CreateOSPlugin } from "../../packages/opencode-plugin/index.ts"
EOF
```

Then install dependencies in the package directory:

```bash
cd packages/opencode-plugin && bun install
```

## Prerequisites

1. **createos CLI** — auto-installed on first use, or manually:

   ```bash
   curl -sfL https://raw.githubusercontent.com/NodeOps-app/createos-cli/main/install.sh | sh
   ```

2. **Login** (one-time, browser OAuth):
   ```bash
   createos login
   ```

## How it works

1. Plugin loads and registers 38 `sandbox_*` tools
2. System prompt is injected into all agents telling them to use `sandbox_exec`
   for all shell commands instead of the built-in `bash` tool
3. On first tool call, a sandbox is created automatically
4. All subsequent `sandbox_exec` calls run inside that sandbox
5. Sandbox is destroyed when the session ends

## Configuration

Environment variables:

| Variable           | Default       | Description                          |
| ------------------ | ------------- | ------------------------------------ |
| `CREATEOS_ENABLED` | `true`        | Set to `false` to disable the plugin |
| `CREATEOS_SHAPE`   | `s-2vcpu-2gb` | Sandbox VM size                      |
| `CREATEOS_ROOTFS`  | `devbox:1`    | Base image for the sandbox           |

## Offloading vs. driving a box

Two shapes of work, two tools. Getting this wrong is the most common mistake:

| Work                                                         | Tool                                                      |
| ------------------------------------------------------------ | --------------------------------------------------------- |
| Has a finish line — a build, a test suite, a script          | `sandbox_offload` — one call, box destroyed afterwards    |
| Several variants of that at once — shards, a config matrix   | `sandbox_fanout` — one throwaway box per command          |
| Outlives one command — a dev server, a watcher, a session    | `sandbox_create` + `sandbox_exec`, then `sandbox_destroy` |

`sandbox_offload` is not a convenience wrapper over create + exec. It carries the
things a hand-rolled sequence silently drops: egress restricted to the domains a
build actually needs, a keepalive so a dropped stream does not kill a long build,
guaranteed destruction even when the command throws, and staging excludes that
keep `.git`, `node_modules`, `target` and large media off the wire.

## Tool inventory (38 tools)

### Offload engine

| Tool                 | Description                                                                  |
| -------------------- | ---------------------------------------------------------------------------- |
| `sandbox_offload`    | Stage a directory, run a command, pull artifacts, destroy the box            |
| `sandbox_fanout`     | Run each of several commands in its own throwaway box, in parallel           |

### Desktop / computer use

| Tool                 | Description                                                                  |
| -------------------- | ---------------------------------------------------------------------------- |
| `sandbox_desktop`    | Mint a live noVNC URL for a `desktop:1` box so the user can watch or drive it |
| `sandbox_computer`   | One computer-use action: screen, cursor, windows, move, click, type, key, open |
| `sandbox_screenshot` | Capture the desktop as a PNG and return its local path                        |


### Execute & Files

| Tool           | Description                                                            |
| -------------- | ---------------------------------------------------------------------- |
| `sandbox_exec` | Run a shell command inside the sandbox. **Use this for ALL commands.** |
| `sandbox_pull` | Read/download a file from the sandbox                                  |
| `sandbox_push` | Write/upload a file to the sandbox                                     |

### Sandbox lifecycle

| Tool              | Description                                      |
| ----------------- | ------------------------------------------------ |
| `sandbox_info`    | Status, IP, shape, region, ingress URL           |
| `sandbox_create`  | Create an additional sandbox (multi-node setups) |
| `sandbox_list`    | List all sandboxes                               |
| `sandbox_pause`   | Pause sandbox, saving state                      |
| `sandbox_resume`  | Resume a paused sandbox                          |
| `sandbox_fork`    | Clone a paused sandbox                           |
| `sandbox_destroy` | Permanently delete a sandbox                     |

### Config

| Tool                | Description                 |
| ------------------- | --------------------------- |
| `sandbox_ingress`   | Toggle public HTTPS URL     |
| `sandbox_firewall`  | Set egress firewall rules   |
| `sandbox_bandwidth` | Check bandwidth usage/quota |
| `sandbox_shapes`    | List available VM sizes     |
| `sandbox_images`    | List available base images  |

### Ports & connectivity

| Tool                  | Description                                       |
| --------------------- | ------------------------------------------------- |
| `sandbox_preview_url` | Get a public HTTPS URL for a port (preferred)     |
| `sandbox_tunnel`      | Forward a sandbox port to localhost               |
| `sandbox_sync`        | Bidirectional file sync between local and sandbox |

### Networks (multi-node)

| Tool                     | Description                         |
| ------------------------ | ----------------------------------- |
| `sandbox_network_create` | Create a private network            |
| `sandbox_network_list`   | List networks                       |
| `sandbox_network_show`   | Show network details and member IPs |
| `sandbox_network_attach` | Attach sandbox to a network         |
| `sandbox_network_detach` | Detach sandbox from a network       |
| `sandbox_network_delete` | Delete a network                    |

### Persistent storage (S3 disks)

| Tool                  | Description                               |
| --------------------- | ----------------------------------------- |
| `sandbox_disk_create` | Register an S3 bucket as a mountable disk |
| `sandbox_disk_list`   | List registered disks                     |
| `sandbox_disk_show`   | Show disk details                         |
| `sandbox_disk_delete` | Delete a disk registration                |
| `sandbox_disk_attach` | Mount a disk into a sandbox               |
| `sandbox_disk_detach` | Unmount a disk from a sandbox             |

### Device VPN (direct IP access)

| Tool                      | Description                                         |
| ------------------------- | --------------------------------------------------- |
| `sandbox_device_register` | One-time device registration                        |
| `sandbox_device_status`   | Check device registration status                    |
| `sandbox_device_attach`   | Attach device to a network                          |
| `sandbox_device_detach`   | Detach device from a network                        |
| `sandbox_vpn_up`          | Returns the `sudo` command for user to run manually |

## Differences from the Pi extension

This plugin ports the [Pi extension](../pi-extension) (`feat/pi` branch) to
OpenCode. The core sandbox tools and CLI wrappers are identical, but OpenCode's
plugin API has limitations:

| Capability       | Pi                                                     | OpenCode                                                            |
| ---------------- | ------------------------------------------------------ | ------------------------------------------------------------------- |
| Tool replacement | Replaces built-in `bash/read/write/edit` transparently | Cannot replace — uses system prompt to direct LLM to `sandbox_exec` |
| CLI flags        | `pi --createos`                                        | Not supported — use `CREATEOS_ENABLED` env var                      |
| TUI integration  | Status bar, notifications                              | Not available to plugins                                            |
| Slash commands   | `/sandbox`, `/network`, `/device`                      | Not supported                                                       |
| Global install   | `pi install npm:@createos/pi`                          | `opencode plugin @createos/opencode --global`                       |
| Shell access     | `pi.exec()`                                            | `child_process.execSync` (OpenCode's `$` had routing issues)        |

## Architecture

```
packages/opencode-plugin/
├── index.ts           # Plugin entry — exports CreateOSPlugin
├── package.json       # npm: @createos/opencode
├── README.md          # This file
├── tsconfig.json
└── src/
    ├── cli.ts             # All createos CLI wrappers (execSync-based)
    ├── sandbox-engine.ts  # copy — canonical lives in packages/shared/
    ├── tools.ts           # 38 tool definitions using tool() + tool.schema.*
    └── util.ts            # shellQuote, shortId, joinPath
```

## Shared engine

`src/sandbox-engine.ts` is a copy. The canonical file is
`packages/shared/sandbox-engine.ts`; `scripts/sync-shared.sh` writes the copies
and CI fails on drift, so edit the canonical one. It is a TypeScript port of the
`cos` bash driver that the Claude Code and Codex plugins run — the two are meant
to behave identically, so a change to one belongs in the other.

## License

Apache-2.0
