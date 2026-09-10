# @createos/pi

Pi coding agent extension with [CreateOS Sandbox](https://nodeops.network/createos) tools. Pi runs locally by default; `--inside-createos-sandbox` routes its built-in tools to a remote sandbox.

## Setup

```bash
curl -sfL https://raw.githubusercontent.com/NodeOps-app/createos-cli/main/install.sh | sh -
# Install from the repository root. The root manifest exposes this extension.
pi install git:github.com/NodeOps-app/createos-plugin
createos login
```

The repository root forwards Pi's package entry point to this extension. No API keys, no env vars.

## Usage

```bash
# Pi and built-in tools stay local; sandbox_* tools remain available.
pi

# Create a sandbox and route Pi's built-in tools into it.
pi --inside-createos-sandbox
```

Sandbox lifecycle, networking, device access, and port-forwarding tools are available in both modes.

### Sandbox-mode flags

Use these with `--inside-createos-sandbox`:

| Flag                          | Purpose                                          |
| ----------------------------- | ------------------------------------------------ |
| `--inside-createos-sandbox`   | Run Pi inside a sandbox                          |
| `--createos-shape <shape>`    | Sandbox shape (default: `s-2vcpu-2gb`)           |
| `--createos-rootfs <name>`    | Base image or template                           |
| `--createos-network <name>`   | Network(s) to join at creation (comma-separated) |
| `--createos-sync-once`        | Copy the host project to `/root/workspace` first |
| `--createos-avoid-git-ignore` | Include files ignored by Git during that copy    |
| `--createos-watch`            | Keep the host project and sandbox in sync        |

`--createos-sync-once` and `--createos-watch` cannot be combined. The former copies
host files once, keeps sandbox-only files, and excludes VCS metadata plus Git-ignored
files by default. `--createos-avoid-git-ignore` includes Git-ignored files.
`--createos-watch` starts a two-way Mutagen sync for the session.

In sandbox mode, before the first agent turn, loaded Pi skill directories are mirrored to
their original absolute paths in the sandbox. Only the loaded skill directories and their
bundled files are copied; Pi credentials, settings, and sessions stay local.

### In-session commands

| Command                    | Description                           |
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

### Agent tools

The LLM agent always has `sandbox_*` tools to create and manage sandboxes, networks,
disks, port forwarding, and device VPN. Pi's built-in tools stay local unless sandbox mode is enabled.

### Offload work that finishes

For a build, a test suite, or a script, `sandbox_offload` does the whole thing in one call:
it stages the directory to a fresh box, runs the command under a keepalive that survives a
dropped stream, optionally pulls artifacts back, and destroys the box afterwards — even if
the command throws.

It is not a convenience wrapper over `sandbox_create` + `sandbox_exec`. Hand-rolling that
sequence drops egress restriction (`egress_presets: ["npm"]` limits the box to the registry
it actually needs), the keepalive, and the guaranteed destroy, so a "successful" run can
leave an unrestricted box billing. The upload already skips `.git`, `node_modules`,
`target`, virtualenvs and large media.

### Drive a graphical desktop

On a sandbox created with `rootfs: desktop:1`, `sandbox_desktop` mints a live noVNC link the
user can open in a browser. `sandbox_computer` drives the same screen from the agent side — read
screen bounds, move, click, type, press keys, open a URL, or list windows. Coordinates are raw
X11 pixels: use its `screen` operation rather than assuming a resolution. Use
`sandbox_screenshot` before and after anything you are unsure about.

### Fan out scenarios

For isolated configurations, tests, or deployment checks, ask Pi once:

> Run these scenarios against independent copies of the current project: unit tests, staging configuration, and production configuration. Preserve the tracked source. Return test results and only health-checked public URLs.

Pi uses `sandbox_fanout`: it archives the local project while honoring Git ignore rules, creates sandboxes in bounded parallelism, and runs each named scenario. A scenario without a port runs a foreground command such as a test suite. A scenario with a port runs its server in `tmux`, then receives a public HTTPS health check. Use scenario environment variables for configuration differences.

### Private networks

Sandboxes on the same network can reach each other by IP:

```bash
pi --inside-createos-sandbox --createos-network backend
```

## How it works

1. By default, Pi and its built-in tools run locally while sandbox tools stay available.
2. `pi --inside-createos-sandbox` checks that `createos` is installed and logged in, then creates a sandbox.
3. In sandbox mode, Pi tools (bash, read, write, edit, ls, find, grep) run through `createos sandbox exec` / `push` / `pull`.
4. Sandbox mode mirrors loaded Pi skill directories before the first agent turn.
5. In sandbox mode, `--createos-sync-once` copies the host project to `/root/workspace`; `--createos-watch` starts a two-way sync.
6. On exit, ephemeral sandbox-mode sessions destroy their sandbox; persisted sessions keep it for resume.

## Architecture

```text
Your machine                          CreateOS
┌──────────────────┐                  ┌─────────────────────┐
│  Pi agent (LLM)  │                  │  Sandbox             │
│                  │ ── createos ──▶  │  code execution      │
│   remote calls   │    CLI           │  file I/O            │
└──────────────────┘                  └─────────────────────┘
                                               │
                                               │ private network
                                               ▼
                                        Other sandboxes
                                        (same network)
```

Zero HTTP client code. Every operation is a `createos` CLI call.
