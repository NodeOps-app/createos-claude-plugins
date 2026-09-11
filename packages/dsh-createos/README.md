# dsh-createos

Run the DeepSeek Harness execution world in one CreateOS sandbox. The plugin provides both `ctx.fs` and `ctx.subprocess`, so existing Bash, file, LSP, and PTY consumers operate remotely without provider-specific tool forks.

## Requirements

- Node.js `^22.19` or `>=24`
- A CreateOS API key and compute shape
- A CreateOS image with GNU `base64`, `find`, `realpath`, and `stat`, plus `/bin/sh`
- Managed-process endpoints enabled on the CreateOS control plane and guest agent

Set the required environment variables before starting DSH:

```sh
export CREATEOS_SANDBOX_API_KEY='...'
export CREATEOS_SANDBOX_SHAPE='...'
# Optional:
export CREATEOS_SANDBOX_BASE_URL='https://your-createos-control-plane'
export CREATEOS_SANDBOX_ROOTFS='...'
```

## Quick start: Web

Install the bundle from this monorepo checkout into the Web profile:

```sh
dsh plugin --profile web add /path/to/createos-plugin/packages/dsh-createos
```

Configure a DSH model provider separately, set the CreateOS variables above, and start Web from the workspace path the remote tools should use:

```sh
cd /path/to/workspace
dsh web
```

The plugin creates one sandbox automatically during Web startup and creates the launch directory at the same absolute path inside it. Open `http://127.0.0.1:3080`, create a session for that workspace, and ask the agent to use Bash to run `hostname` and `uname -a`. A successful smoke test reports a Linux sandbox hostname rather than the Host machine's hostname.

The matching path starts empty: the plugin does not currently copy the Host workspace into the sandbox. Create or synchronize remote workspace contents before asking the agent to operate on an existing project. Selecting a different Web workspace also requires that absolute path to exist inside the sandbox.

Stop Web with `Ctrl+C`. Plugin teardown destroys the shared sandbox.

## Install

Install directly from this monorepo while developing:

```sh
dsh plugin --profile headless add /path/to/createos-plugin/packages/dsh-createos
```

After publication, install the package by registry name:

```sh
dsh plugin --profile headless add @nodeops-createos/dsh-createos
```

The package declares a `dsh.bundle` patch that replaces the local filesystem and subprocess providers together. The package can be published as `@nodeops-createos/dsh-createos` for registry installation.

See [How it works](docs/how-it-works.md) for the Web-to-sandbox request flow, service replacement, lifecycle, and API mapping.

## CreateOS API usage

Sandbox creation, destruction, file transfer, and one-shot commands use `@nodeops-createos/sandbox`. Persistent processes and terminals use these managed-process routes:

```text
POST   /v1/sandboxes/:id/processes
GET    /v1/sandboxes/:id/processes
GET    /v1/sandboxes/:id/processes/:process_id
GET    /v1/sandboxes/:id/processes/:process_id/connect
POST   /v1/sandboxes/:id/processes/:process_id/input
POST   /v1/sandboxes/:id/processes/:process_id/stdin/close
POST   /v1/sandboxes/:id/processes/:process_id/resize
POST   /v1/sandboxes/:id/processes/:process_id/signal
GET    /v1/sandboxes/:id/processes/:process_id/wait
DELETE /v1/sandboxes/:id/processes/:process_id
```

## Development

```sh
npm install
DSH_REPO=/path/to/deepseek-harness npm run check
```

The DSH packages are host peer dependencies. Until the complete DSH development dependency graph is published, `npm run check` links those peers from `DSH_REPO`; by default it looks for a sibling `deepseek-harness` checkout in both the historical standalone layout and this monorepo layout. The unit tests use fake CreateOS clients and do not require credentials. A live smoke test still requires a deployed control plane containing the managed-process API.

## Limitations

- The bundle disables host sandbox and permission-preset providers because they cannot constrain a remote kernel. The CreateOS sandbox is the isolation boundary.
- CreateOS retains a bounded managed-process output journal. Output that ages out before the harness consumes it cannot be reconstructed.
- Filesystem atomic writes require GNU userland behavior and a single filesystem for each destination and its temporary sibling.
- The provider does not expose CreateOS S3 mounts through a separate DSH filesystem namespace.
- Sandbox lifetime defaults to five minutes and destroys the shared execution world when it expires or the plugin unloads.

## License

MIT. This project includes code initially developed against DeepSeek Harness under its MIT license.
