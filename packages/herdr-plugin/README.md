# CreateOS Sandbox for Herdr

Run a coding agent inside a CreateOS Sandbox microVM, and drive it from a
[Herdr](https://herdr.dev) pane. One pane maps to one sandbox.

Herdr stays the local control room. The pane is a local terminal attached to a
managed PTY inside the sandbox. Your keystrokes go into the microVM. The agent's
terminal output comes back. Herdr classifies the pane as working, waiting, or
idle, because the plugin sets `HERDR_AGENT` on the pane.

```text
Herdr pane  ──►  createos sandbox process attach  ──►  PTY in the microVM
                                                        └── claude / codex /
                                                            opencode / pi /
                                                            cursor-agent
```

## Agents

| `agent` value | Agent       | Installed with                                                    |
| ------------- | ----------- | ----------------------------------------------------------------- |
| `claude-code` | Claude Code | `curl -fsSL https://claude.ai/install.sh \| bash`                  |
| `codex`       | Codex       | `curl -fsSL https://chatgpt.com/codex/install.sh \| sh`            |
| `opencode`    | OpenCode    | `curl -fsSL https://opencode.ai/install \| bash`                   |
| `pi`          | Pi          | `curl -fsSL https://pi.dev/install.sh \| sh`                       |
| `cursor`      | Cursor      | `curl https://cursor.com/install -fsS \| bash`                     |
| `shell`       | none        | opens a plain login shell                                          |

Each installer is the official one. The plugin runs it inside the sandbox, then
resolves the binary with `command -v` and fails if the binary is missing.

## Requirements

- macOS or Linux
- Herdr 0.7.5 or newer
- [Bun](https://bun.sh)
- A CreateOS account. `build.sh` installs the CLI for you. Sign in once with
  `createos login`.
- A Git worktree. The plugin uploads what Git tracks.

`build.sh` runs the official installer every time:

```bash
curl -sfL https://raw.githubusercontent.com/NodeOps-app/createos-cli/main/install.sh | sh -
```

The installer verifies a checksum, and it upgrades an existing CLI in place. Set
`CREATEOS_INSTALL_URL` to point at a different installer. If `curl` is missing,
`build.sh` skips the install and uses any CLI already on the machine.

Warning: the installer replaces the `createos` binary. If you build the CLI from
source, back up your binary before you run `build.sh`.

## Install

One command does every step. It checks the prerequisites, installs the plugin,
writes its configuration, and binds its keys.

```bash
createos sandbox setup herdr
```

Check first, change nothing:

```bash
createos sandbox setup herdr --doctor
```

Pick the agent and the sandbox size while you install:

```bash
createos sandbox setup herdr --agent codex --shape s-4vcpu-8gb
```

| Flag                  | What it does                                                  |
| --------------------- | ------------------------------------------------------------- |
| `--doctor`            | Report the prerequisites and stop.                             |
| `--local <path>`      | Link a local checkout instead of installing from GitHub.       |
| `--agent <kind>`      | `claude-code`, `codex`, `opencode`, `pi`, `cursor`, `shell`.    |
| `--shape`, `--rootfs` | Sandbox size and image.                                        |
| `--auto-pause`        | Pause a sandbox after this long with no activity.              |
| `--remote-root`       | Where the worktree lands inside the sandbox.                   |
| `--no-keys`           | Leave your `config.toml` alone.                                |
| `--force`             | Replace an existing plugin `config.json`.                      |

The command backs up `config.toml` before it adds keys, adds only the bindings
you do not already have, and never touches an existing plugin `config.json`
unless you pass `--force`. Undo the keys with `herdr config reset-keys`.

### By hand

```bash
herdr plugin install NodeOps-app/createos-plugin/packages/herdr-plugin
```

For local development, link the directory and run the build step yourself.
`herdr plugin link` does not run build commands.

```bash
herdr plugin link /path/to/packages/herdr-plugin
sh /path/to/packages/herdr-plugin/build.sh
herdr plugin action list --plugin createos.sandbox
```

`build.sh` installs or upgrades the `createos` CLI, then writes `run.sh` with the
absolute paths to `bun` and `createos`. Herdr runs plugin commands as a bare
argv, with no shell expansion and an unreliable `PATH`.

Verified on 2026-08-25 in a clean sandbox. With no CLI present, `build.sh`
installed `createos v0.0.24` to `/usr/local/bin` and wrote that path into
`run.sh`. A second run upgraded in place and exited 0.

## Keybindings

`createos sandbox setup herdr` writes these for you. This section is for anyone
who used `--no-keys`, or who wants different keys.

Herdr ignores keys declared in a plugin manifest. Add them to
`~/.config/herdr/config.toml`, then run `herdr config check` and
`herdr server reload-config`.

```toml
[[keys.command]]
key = "prefix+shift+s"
type = "plugin_action"
command = "createos.sandbox.start"
description = "start an agent in a new CreateOS sandbox"

[[keys.command]]
key = "prefix+shift+a"
type = "plugin_action"
command = "createos.sandbox.apply"
description = "apply sandbox changes locally"

[[keys.command]]
key = "prefix+shift+c"
type = "plugin_action"
command = "createos.sandbox.attach"
description = "reattach the agent to this pane"
```

## Actions

| Action    | What it does                                                                                                  |
| --------- | ------------------------------------------------------------------------------------------------------------- |
| `start`   | Creates a sandbox, uploads the worktree, installs the agent, splits the pane, and attaches the agent PTY.       |
| `attach`  | Resumes the sandbox if paused, starts the agent again if its process died, and reattaches it to the pane.       |
| `sync`    | Opens a pane that runs `createos sandbox sync --mode two-way` until you stop it.                                |
| `apply`   | Exports a Git patch from the sandbox and applies it locally, after `git apply --check` passes.                  |
| `pause`   | Snapshots the sandbox. See the known problem below.                                                             |
| `resume`  | Brings a paused sandbox back.                                                                                   |
| `info`    | Prints the agent, sandbox, status, and paths mapped to the pane.                                                |
| `delete`  | Permanently deletes the sandbox. Invoke it twice within 60 seconds to confirm.                                  |
| `boxes`   | An overlay pane that refreshes `createos sandbox list` every 5 seconds.                                         |

`apply` is incremental. It commits a baseline in the sandbox after each apply,
so the next apply carries only newer work. A second apply with no new work
reports `no-changes`.

Every action prints one machine-readable result line, on success and on failure:

```text
CREATEOS_HERDR_RESULT: {"schemaVersion":1,"action":"apply","ok":true,"result":"applied","bytes":237}
```

The line is printed when the action finishes, so it is the last such line in the
log, not always the first line of output. `start` streams the agent installer
output before it. The `boxes` pane runs until you close it and prints no result.

Herdr runs actions asynchronously. Poll the outcome with
`herdr plugin log list --plugin createos.sandbox`.

## Configuration

```bash
herdr plugin config-dir createos.sandbox
```

Create `config.json` there. Every key is optional.

```json
{
  "agent": "claude-code",
  "shape": "s-2vcpu-4gb",
  "rootfs": "devbox:1",
  "autoPause": "30m",
  "remoteRoot": "/workspace",
  "egress": ["registry.npmjs.org", "github.com"],
  "excludes": ["fixtures/", "*.mp4"],
  "syncExcludes": [".git", "node_modules"]
}
```

An unknown key is an error, so a typo cannot silently disable a safety setting.

`egress` locks the sandbox to the listed hosts. An empty list lets the sandbox
reach anything. `excludes` accepts an exact repository-relative path, a
directory prefix that ends with `/`, or an extension such as `*.mp4`.

Do not put tokens in this file. Authenticate the agent inside its own sandbox,
in the pane, the first time you start it.

## What the plugin uploads

The candidate list is `git ls-files --cached --others --exclude-standard`. Four
filters then run over it, in this order:

1. **Submodules.** Every gitlink is dropped, with everything under it. Git
   reports a submodule as one bare directory name, so a name-based filter would
   never see the files inside it.
2. **Your `excludes`.** Checked first, so nothing below can override them.
3. **The deny-list.** `.env` and `.env.*` (except `.env.example`, `.env.sample`,
   `.env.template`), `.ssh/`, `.aws/`, `.gnupg/`, `.kube/`, `.config/gcloud/`,
   `.docker/config.json`, `.netrc`, `.npmrc`, `.pypirc`, `.envrc`,
   `.git-credentials`, `id_rsa`, `id_dsa`, `id_ecdsa`, `id_ed25519`, `*.pem`,
   `*.key`, `*.p12`, `*.pfx`, `*.keystore`, `*.jks`, `credentials`,
   `credentials.json`, `.terraform/`, `*.tfstate`.
4. **`git check-ignore --no-index`.** This judges tracked files by the ignore
   rules too. A credential committed once and ignored later is still dropped.

The archive is then built with `tar --no-recursion` from an explicit file list,
so no directory entry can pull in a file the filters never saw.

The upload is a filtered snapshot, not a mount. Host agent credentials are
never copied into the sandbox.

This is a deny-list, not proof. It stops the credential shapes named above. It
does not detect a secret inside an ordinary source file. Treat the sandbox as
holding a copy of your working tree.

## Known problems

- `createos sandbox pause` and `resume` fail with `Content-Length is required`
  on CLI v0.0.24 and earlier. The cause is a missing request body in the CLI's
  own lifecycle helper, not a server fault and not this plugin. Both actions are
  correct and work on a fixed CLI. Use `autoPause` until you have one, because
  it is applied at create time.
- On an account holding thousands of sandboxes, the CLI resolves a sandbox by
  scanning only the first 200 rows it lists, so a sandbox outside that page is
  reported as missing even when addressed by full ID. Every action here can hit
  that. It is a CLI limit, not a plugin one.
- Herdr restores panes after a restart, but not the processes inside them. The
  sandbox and the mapping survive. Use `attach` to reconnect.
- `sync` needs an SSH key in the sandbox and downloads Mutagen on first use.
  `start` does not need either.
- The plugin does not follow a pane that moves to another workspace, because the
  mapping is keyed by pane ID.

## Verified

Run the filter tests with `bun test`. They cover the deny-list, the
example-file exception, exclude precedence, and the submodule rule against a
real Git fixture.

Measured live on Herdr 0.8.2 and CreateOS CLI v0.0.24, with Claude Code 2.1.245:

- `start` created the sandbox, uploaded the worktree, installed the agent, and
  opened the pane. `herdr agent list` reported `agent: claude`,
  `agent_status: idle`. A `.env` tracked by Git was not uploaded.
- `apply` moved sandbox edits into the local worktree. The next `apply`
  reported `no-changes`.
- A `start` whose agent install failed under a restrictive `egress` deleted its
  own sandbox. The sandbox count was unchanged, and the sandbox showed
  `destroyed`.
- A `remoteRoot` carrying `'; touch /tmp/PWNED; #` was refused before anything
  was created. No file was written.
- `delete` refused the first invocation and deleted the sandbox on the second.
- All five agent installers resolved their binary inside a sandbox.
- `build.sh` installed `createos v0.0.24` in a clean sandbox, then upgraded in
  place on a second run.
- `createos sandbox setup herdr --local … --agent codex` ran against an isolated
  `HOME`: it linked the plugin, ran the build step, wrote `config.json`, added 6
  keybindings, and backed up `config.toml`. `herdr config check` reported `ok`.
  A second run added nothing and kept the existing config.
