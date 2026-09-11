# langflow-sandbox-createos

Three ways to run [Langflow](https://github.com/langflow-ai/langflow) work inside
disposable [CreateOS](https://createos.sh) Firecracker microVMs. One `pip
install` ships all three; each is opted into separately.

| Surface | Entry point | What moves into a microVM | Enable with |
|---|---|---|---|
| **Sandbox backend** | `lfx.sandbox_backends` | The **Python Interpreter** component's code | `LANGFLOW_SANDBOX_BACKEND=createos` (+ allowlist) |
| **Components** | `langflow.extensions` | Whatever you put in a **CreateOS Sandbox** node | drag it onto the canvas |
| **Executor** | `lfx.executors` | An entire flow graph | `LANGFLOW_EXECUTOR_KIND=createos` |

They are complementary. The backend hardens an existing flow silently; the
component makes the sandbox a thing you build *with*; the executor moves the
whole graph off the host.

One throwaway VM per execution, on the CreateOS control plane — so the Langflow
host needs no KVM/HVF device of its own. This is what makes hardware-isolated
code execution possible on managed platforms, containers without
`/dev/kvm`, and Apple Silicon CI.

| | `none` (default) | `exec-sandbox` (built in) | `createos` (this package) |
|---|---|---|---|
| Where code runs | Langflow process | QEMU microVM on the Langflow host | Firecracker microVM on CreateOS |
| Needs a local hypervisor | — | yes (KVM / HVF) | **no** |
| Isolation | none | hardware-virtualized | hardware-virtualized |
| Cold start | — | seconds (image download on first run) | ~200 ms create-to-first-command |

## Install

```sh
pip install langflow-sandbox-createos
```

## Enable

```sh
# 1. Trust the plugin. Empty by default; nothing is imported until it is listed.
export LANGFLOW_SANDBOX_BACKEND_PLUGINS=createos
# 2. Select it.
export LANGFLOW_SANDBOX_BACKEND=createos
# 3. Credential. Get one at https://createos.nodeops.network/profile
export CREATEOS_SANDBOX_API_KEY='...'
```

Both variables are needed. `LANGFLOW_SANDBOX_BACKEND_PLUGINS` is Langflow's
trust gate — loading a plugin imports its code into the Langflow process, on the
path that decides whether user code is isolated, so discovery is never
automatic. See [Sandbox backends](https://docs.langflow.org/sandbox-backends).

A configured sandbox that cannot be used **fails closed**. It never falls back
to in-process `exec`.

## Configuration

Langflow's own settings apply unchanged:

| Variable | Default | Effect here |
|---|---|---|
| `LANGFLOW_SANDBOX_TIMEOUT_SECONDS` | `30` | Wall clock the guest program gets, enforced in-VM by `timeout(1)` |
| `LANGFLOW_SANDBOX_MEMORY_MB` | `192` | A **floor**, not the VM size — see *Shapes* below |
| `LANGFLOW_SANDBOX_ALLOW_NETWORK` | `false` | `false` installs an unroutable egress allowlist; `true` with no domains is **unrestricted** |
| `LANGFLOW_SANDBOX_ALLOWED_DOMAINS` | empty | **Not supported — refused.** CreateOS does not enforce hostname rules; see below |

Plus this package's own:

| Variable | Default | Effect |
|---|---|---|
| `CREATEOS_SANDBOX_API_KEY` | — | **Required.** Falls back to `CREATEOS_API_KEY` |
| `CREATEOS_SANDBOX_BASE_URL` | `https://api.sb.createos.sh` | Control-plane endpoint |
| `CREATEOS_SANDBOX_ROOTFS` | `devbox:1` | Guest image |
| `CREATEOS_SANDBOX_SHAPE` | auto | Pin an exact shape (`GET /v1/shapes`) |
| `LANGFLOW_SANDBOX_CREATEOS_ACCEPT_EGRESS_EXCEPTIONS` | `false` | Required to run with restricted egress — read the next section first |

### Shapes

A CreateOS shape fixes vCPU **and** memory together, which
`LANGFLOW_SANDBOX_MEMORY_MB` cannot express. Langflow's default of 192 MB is
sized for `exec-sandbox`'s local QEMU guest and is far too small for a fresh
CreateOS guest importing numpy or pandas.

So `LANGFLOW_SANDBOX_MEMORY_MB` acts only as a floor: the smallest catalog shape
with at least `max(LANGFLOW_SANDBOX_MEMORY_MB, 4096)` MiB is chosen. It never
rounds down — a shape below the configured memory would produce OOM kills that
read as user-code bugs rather than as a misconfigured sandbox. Pin an exact
shape with `CREATEOS_SANDBOX_SHAPE`.

## Network semantics differ from `exec-sandbox` — read this

Three differences, all of them load-bearing:

1. **`LANGFLOW_SANDBOX_ALLOW_NETWORK=true` grants unrestricted egress.**
   `exec-sandbox` keeps a package-registry-only default; CreateOS has no
   equivalent built-in list, and (see 2) you cannot narrow it by domain.

2. **`LANGFLOW_SANDBOX_ALLOWED_DOMAINS` is refused, not honoured.** CreateOS
   does not enforce hostname egress rules. The API accepts them and echoes them
   back, so the allowlist *looks* applied while restricting nothing. Measured
   against the live control plane, one VM per rule form, probing an allowlisted
   host and a non-allowlisted one:

   | Rule sent | `pypi.org` | `example.com` (not listed) | Enforced |
   |---|---|---|---|
   | `pypi.org` | reachable | **reachable** | no |
   | `pypi.org:443` | reachable | **reachable** | no |
   | `*.pypi.org`, `pypi.org` | reachable | **reachable** | no |
   | `151.101.192.223:443` | reachable | blocked | yes |
   | `240.0.0.0/4` | blocked | blocked | yes |

   Only address-based rules reach the host's iptables/eBPF policy. So
   `capabilities()` reports `supports_domain_allowlist=False`, Langflow's policy
   gate refuses the run, and the backend refuses it again itself. Resolving your
   domains to addresses would not be a fix — DNS answers rotate, the guest
   re-resolves independently, and CDN addresses are shared, so allowlisting
   pypi.org's Fastly address would admit every other tenant on it.

   For a restricted network, use `LANGFLOW_SANDBOX_ALLOW_NETWORK=false`, which
   **is** enforced. If you need a real domain allowlist today, use
   `exec-sandbox`, which filters DNS inside the guest.

3. **`169.254.0.0/16` is always reachable.** The CreateOS host accepts
   link-local before the policy's final DROP, and that range carries the VM
   metadata service. Verified live: under the deny-all policy a guest reached
   `169.254.169.254:80` and got HTTP 200 while a public address was blocked.

Because of (3), this backend **refuses** any run with egress turned off
(`LANGFLOW_SANDBOX_ALLOW_NETWORK=false`) unless you set:

```sh
export LANGFLOW_SANDBOX_CREATEOS_ACCEPT_EGRESS_EXCEPTIONS=true
```

An operator who turned the network off did not ask for "off except one range",
so the refusal is the honest default. Langflow's own `Capabilities` has no field
for declaring such a hole, so the backend enforces it itself.

## The CreateOS Sandbox component

A microVM as a flow node — an arbitrary command or Python program, with two
things the sandbox *backend* protocol cannot express:

- **Guest reuse** (`Guest Reuse: flow`) — one guest survives across executions of
  the flow, so installed packages and files carry over. Verified: three runs,
  one guest, `RUN_COUNT 1 → 2 → 3`. The guest's *name* is the registry (derived
  from flow id + component id), so reuse survives a worker restart and needs no
  state in the Langflow process.
- **Returned files** (`Return Files`) — anything the guest writes to
  `/workspace/artifacts` comes back on the **Files** output as a DataFrame, one
  row per file. The 5 MiB cap binds **during** the transfer, not after it: the
  guest chooses the archive size, so a limit applied to an already-buffered
  download would not stop guest code deciding how much of the worker's memory
  one run costs.

Three things to know before you turn reuse on:

- A reused guest **outlives the flow run** by design. `auto_pause` bounds the
  cost but does not delete it — reap `lf-c-*` sandboxes on whatever schedule
  suits you.
- **A guest that idled out is resumed, not adopted paused.** `auto_pause` sits
  just above this component's timeout, so any gap between runs longer than that
  leaves the guest paused — the normal case for reuse, not an edge case. The
  control plane rejects exec and file access on a paused sandbox with
  `409 sandbox is paused; resume it before accessing files`, so the component
  resumes it and waits for `running` before the run starts.
- Two workers running the same flow concurrently adopt the **same** guest and
  share its filesystem. That is inherent to "reuse one machine", and it is why
  reuse is off by default.
- **Changing Allow Network gets you a different guest, on purpose.** The
  network policy is part of the guest's identity, so a run that turns egress off
  can never adopt the guest created while it was on. Without that, the setting
  would appear to apply and silently do nothing. The old guest is left behind to
  auto-pause; reap it if you care. A guest whose egress drifted after creation
  is refused outright rather than reused.

## The whole-flow executor

`LANGFLOW_EXECUTOR_KIND=createos` serializes the graph, rebuilds it inside a
guest with `Graph.from_payload`, runs it there, and streams per-vertex events
back.

**Read this before enabling it — it does not cover the UI.** `lfx`'s
`Coordinator` is used by `/api/v1/run`, the `lfx` CLI, Loop subgraphs and
`Graph.arun`. Langflow's UI build endpoint walks the vertices itself and never
enters that path, so the playground still executes in the server process.

| Variable | Default | Effect |
|---|---|---|
| `CREATEOS_EXECUTOR_ROOTFS` | image default | **The supported path.** A template with Langflow and your components installed |
| `CREATEOS_EXECUTOR_SHAPE` | `s-4vcpu-8gb` | Guest size |
| `CREATEOS_EXECUTOR_TIMEOUT_SECONDS` | `600` | Wall clock, enforced in-guest by `timeout(1)` |
| `CREATEOS_EXECUTOR_EGRESS` | `*` | Comma-separated **address** rules. Defaults open because flows call model providers |
| `CREATEOS_EXECUTOR_INSTALL_LFX` | `false` | Per-run `pip install` fallback — for a first experiment, not production |
| `CREATEOS_EXECUTOR_PIP` | empty | Extra packages for that fallback |

**The guest needs every dependency your components use.** Measured: with bare
`lfx` in the guest, a Python Interpreter flow rebuilds correctly and then every
vertex fails with `No module named 'langchain_experimental'`. Bake a template.

Caller inputs arrive as `runtime_options["initial_inputs"]`, not `unit.inputs` —
`Coordinator.stream` passes `inputs=[]` and documents this. An executor reading
only the seam-level list runs every streaming flow with no input at all; this one
normalizes the two. `max_iterations`, `config`, `reset_output_values` and
`fallback_to_env_vars` are forwarded to `async_start`; `event_manager` and
`session_id` cannot cross a process boundary and are dropped with a debug log.

`StepResult.payload` is a JSON dict here, not the in-process `Vertex` objects.
The seam allows executor-defined payloads and pushes normalization to the
consumer, so anything reading payloads expecting in-process shapes needs
adapting.

**Final outputs come from `RunComplete.outputs`, not from the payload stream.**
`Graph.arun` — and so `/api/v1/run` — reads only that terminal field, via
`Coordinator.run_to_completion`. The guest therefore harvests its own vertices
exactly the way `Graph._run` does (built vertices whose id or display name the
caller asked for, or every `is_output` vertex when it asked for none) and ships
the resulting `RunOutputs` back to be rebuilt on the host. Terminating with an
empty list instead returns `outputs: []` to every API caller no matter what the
flow produced. The exception is a component whose output is a live generator:
`Graph._run` drains those with `consume_async_generator` and the guest does not,
so it reports an empty result.

## What it does not do

The merged `lfx` `SandboxBackend` protocol carries only
`run(code, env) -> SandboxResult`. `SessionKey` and `SandboxFile` were removed
from it, so **the backend** cannot reuse a guest or return files.

Those two capabilities are not lost — they moved. The **component** above does
both, because a component declares its own inputs and outputs and is not bound
by the backend protocol. Restoring them *in the backend* still needs an upstream
change.

## How one execution works

```
POST   /v1/sandboxes                       shape + rootfs + envs + egress + auto-pause backstop
PUT    /v1/sandboxes/{id}/files?path=...   the program
POST   /v1/sandboxes/{id}/exec             timeout --signal=KILL <n> python3 <path>
DELETE /v1/sandboxes/{id}                  always, in a finally
```

The guest's own `timeout(1)` is the authoritative wall clock, so a timed-out run
still returns the output it produced. The HTTP read budget is only a backstop
for a control plane that stops answering, and destroying the VM is what actually
stops runaway code either way. A VM this process fails to destroy is bounded by
`auto_pause_after_seconds`, always set longer than one execution.

## Development

```sh
uv venv && uv pip install -e . pytest
CREATEOS_SANDBOX_API_KEY=test-key .venv/bin/python -m pytest tests/ -q
```

Tests use `httpx.MockTransport` against a recorded fake control plane — no
mocking library, and no live sandbox, so they need no credential and are safe on
pull requests from forks.

That also bounds what they can catch. Every defect listed in this README —
unenforced hostname egress, the reserved `code` input name, `self.ctx` not
outliving a graph run, the guest needing your components' dependencies — was
found by running against a live control plane and would have passed CI. Run the
live checks by hand before a behaviour-changing release.

## Releasing

CI lints, tests on Python 3.10 and 3.12, and builds the wheel on every PR.
Tagging `langflow-sandbox-createos-v<version>` publishes to PyPI through
Trusted Publishing (OIDC — no API token in repository secrets).

See [RELEASING.md](./RELEASING.md) for the one-time PyPI publisher setup and the
release steps.

## License

MIT
