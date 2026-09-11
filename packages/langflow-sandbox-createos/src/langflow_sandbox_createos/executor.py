"""The ``createos`` executor: run a whole flow graph inside a microVM.

Where the sandbox *backend* isolates one component's Python and the *component*
puts a sandbox on the canvas, this moves the entire graph off the Langflow host:
the flow is serialized, rebuilt inside a guest, and executed there, with its
per-vertex events streamed back.

WHAT THIS COVERS, precisely. ``lfx``'s ``Coordinator`` is consumed by
``lfx.run.base`` (the ``/api/v1/run`` endpoint), ``lfx.cli.common`` (the ``lfx``
CLI), ``lfx.base.flow_controls.loop_utils`` (Loop subgraphs) and
``Graph.arun``. It is NOT used by Langflow's UI build endpoint, which walks the
vertices itself and never enters ``Graph.arun``/``async_start`` (see the comment
at ``langflow/api/build.py`` around the flow-execution span). So selecting this
executor isolates API runs, CLI runs and Loop subgraphs; the playground still
runs in the server process. Do not describe it as "every flow runs in a VM".

TWO REQUIREMENTS ON THE GUEST IMAGE, both real:

1. ``lfx`` must be importable in the guest, at a version compatible with the
   host's serialized graph. Installing it per run costs far more than the run,
   so a template is the supported path (``CREATEOS_EXECUTOR_ROOTFS``); the
   fallback pip install exists to make the first experiment work, not for
   production.
2. Every component the flow uses must ALSO be installed in the guest. A flow
   using a bundle the guest lacks fails inside the guest, not here. This is the
   real operational constraint of remote execution and no amount of code on the
   host side removes it.

Inputs arrive as ``runtime_options["initial_inputs"]``, not ``unit.inputs``:
``Coordinator.stream`` calls ``run(graph, inputs=[])`` and says so in its own
docstring. Every streaming caller therefore hands over an EMPTY ``unit.inputs``,
and an executor that reads only that field runs every flow with no input at
all. ``_serialize`` normalizes the two into one list.

``StepResult.payload`` here is a JSON dict, not the in-process ``Vertex``
objects. That is explicitly allowed by the seam ("a sandboxed executor might
yield structured StepStarted / StepCompleted records"), but it does mean
consumers written against in-process payloads need to normalize. The seam's own
docs put that responsibility at the consumer site.
"""

from __future__ import annotations

import asyncio
import json
import uuid
from typing import TYPE_CHECKING, Any, ClassVar

from lfx.execution.executor import Executor
from lfx.execution.types import RunComplete, StepResult
from lfx.log.logger import logger
from lfx.utils.sandbox.base import SandboxExecutionError

from langflow_sandbox_createos._client import SandboxClient, env

if TYPE_CHECKING:
    from collections.abc import AsyncIterator

    from lfx.execution.types import Unit

EXECUTOR_KIND = "createos"

_GUEST_DIR = "/workspace/run"
_DENY_ALL_EGRESS = ["240.0.0.0/4"]
_DEFAULT_SHAPE = "s-4vcpu-8gb"
_DEFAULT_TIMEOUT_SECONDS = 600
_AUTO_PAUSE_FLOOR = 60
_AUTO_PAUSE_MARGIN = 120

# runtime_options the in-process executor understands that cannot cross a
# process boundary. Dropped deliberately rather than silently mangled: an
# EventManager is a live object with callbacks into this process, and a
# session id means nothing to a guest that has no session store.
_UNSHIPPABLE_OPTIONS = frozenset({"event_manager", "session_id", "_use_arun_legacy"})

# The program that runs inside the guest. Kept as a string rather than a file in
# the package so there is exactly one artifact to upload and no import path to
# arrange in the guest. It emits one JSON object per line so the host can parse
# a partial stream without waiting for the process to exit.
_GUEST_RUNNER = r'''
import asyncio, json, sys, traceback

def emit(obj):
    sys.stdout.write(json.dumps(obj, default=str) + "\n")
    sys.stdout.flush()

def describe(item):
    """Reduce an in-guest event to something JSON can carry."""
    vertex = getattr(item, "vertex", None)
    out = {"type": type(item).__name__}
    if vertex is not None:
        out["vertex_id"] = getattr(vertex, "id", None)
        built = getattr(vertex, "built_object", None)
        if built is not None:
            out["built"] = str(built)[:8000]
        out["valid"] = bool(getattr(vertex, "valid", True))
    for attr in ("valid", "params"):
        if hasattr(item, attr) and attr not in out:
            out[attr] = str(getattr(item, attr))[:2000]
    return out

async def main():
    spec = json.load(open("SPEC_PATH"))
    from lfx.graph.graph.base import Graph
    graph = Graph.from_payload(spec["graph"], flow_id=spec.get("flow_id") or "createos-run")

    inputs = spec.get("inputs") or []
    opts = spec.get("runtime_options") or {}
    kwargs = {}
    for name in ("max_iterations", "config"):
        if opts.get(name) is not None:
            kwargs[name] = opts[name]
    for name in ("reset_output_values", "fallback_to_env_vars"):
        if name in opts:
            kwargs[name] = bool(opts[name])
    emit({"t": "note", "inputs": len(inputs), "options": sorted(kwargs)})

    async for item in graph.async_start(inputs=inputs or None, **kwargs):
        emit({"t": "step", "event": describe(item)})

    # Final outputs, harvested exactly the way Graph._run does. Graph.arun --
    # and so /api/v1/run, the lfx CLI and Loop -- reads RunComplete.outputs, so
    # without this frame every API caller gets outputs: [] no matter what the
    # flow produced. Streaming components are NOT drained here (Graph._run does
    # that via consume_async_generator when stream is off); a flow whose output
    # is a live generator will report an empty result.
    wanted = opts.get("outputs") or []
    collected = []
    for vertex in graph.vertices:
        if not getattr(vertex, "built", False):
            continue
        if (not wanted and getattr(vertex, "is_output", False)) \
           or getattr(vertex, "display_name", None) in wanted or vertex.id in wanted:
            collected.append(vertex.result)

    from lfx.graph.schema import RunOutputs
    run_outputs = RunOutputs(inputs=inputs[0] if inputs else {}, outputs=collected)
    try:
        dumped = run_outputs.model_dump(mode="json")
    except Exception:
        # emit() stringifies what json cannot carry; a degraded result beats none.
        dumped = run_outputs.model_dump()
    emit({"t": "outputs", "run_outputs": [dumped]})
    emit({"t": "done"})

try:
    asyncio.run(main())
except Exception as exc:
    emit({"t": "fatal", "error": "%s: %s" % (type(exc).__name__, exc),
          "traceback": traceback.format_exc()[-4000:]})
    sys.exit(1)
'''


class CreateOSExecutor(Executor):
    """Runs a flow graph in a throwaway CreateOS microVM.

    Holds no per-run state: every ``execute`` call builds its own client and its
    own guest, which is what the seam requires of an executor shared across
    concurrent runs.
    """

    kind: ClassVar[str] = EXECUTOR_KIND

    async def execute(self, unit: Unit) -> AsyncIterator[StepResult | RunComplete]:
        """Serialize the graph, run it in a guest, and yield the event stream."""
        spec = _serialize(unit)
        client = await asyncio.to_thread(SandboxClient)
        sandbox_id: str | None = None
        try:
            sandbox_id = await asyncio.to_thread(_provision, client)
            await asyncio.to_thread(_stage, client, sandbox_id, spec)
            result = await asyncio.to_thread(_run, client, sandbox_id)

            fatal: dict[str, Any] | None = None
            run_outputs: list[Any] = []
            for line in (result.get("stdout") or "").splitlines():
                line = line.strip()
                if not line:
                    continue
                try:
                    record = json.loads(line)
                except ValueError:
                    # Guest code is free to print; anything that is not one of
                    # our frames is passed through as a log line rather than
                    # dropped, so a debugging print is not invisible.
                    yield StepResult(payload={"t": "stdout", "line": line[:2000]})
                    continue
                if record.get("t") == "fatal":
                    fatal = record
                    continue
                if record.get("t") == "done":
                    continue
                if record.get("t") == "outputs":
                    run_outputs = _rebuild_outputs(record.get("run_outputs") or [])
                    continue
                yield StepResult(payload=record)

            if fatal is not None:
                msg = f"Flow failed inside the CreateOS guest: {fatal.get('error')}"
                logger.debug("guest traceback:\n%s", fatal.get("traceback"))
                raise SandboxExecutionError(msg)
            if result.get("exit_code") not in (0, None):
                stderr = (result.get("stderr") or "").strip()[-2000:]
                msg = f"CreateOS guest exited {result.get('exit_code')}: {stderr}"
                raise SandboxExecutionError(msg)
        finally:
            # Runs on normal completion, on exception, AND when a consumer drops
            # the iterator mid-stream (aclose runs the generator's finalizer) —
            # which the seam requires so a dropped stream cannot leak a VM.
            if sandbox_id:
                await asyncio.to_thread(client.destroy, sandbox_id)
            await asyncio.to_thread(client.close)

        yield RunComplete(outputs=run_outputs)


# -- helpers, all synchronous so they can be pushed to a thread ---------------


def _rebuild_outputs(raw: list[Any]) -> list[Any]:
    """Rebuild the guest's JSON back into ``RunOutputs`` objects.

    A row that will not validate is kept as the raw dict rather than dropped:
    a caller inspecting the payload is better served by unshaped data than by
    an empty list that looks like "the flow produced nothing".
    """
    from lfx.graph.schema import RunOutputs

    rebuilt: list[Any] = []
    for row in raw:
        try:
            rebuilt.append(RunOutputs.model_validate(row))
        except (TypeError, ValueError) as exc:
            logger.warning("createos executor could not rebuild RunOutputs: %s", exc)
            rebuilt.append(row)
    return rebuilt


def _serialize(unit: Unit) -> dict[str, Any]:
    """Turn a Unit into something a guest can rebuild.

    ``Graph.dump()`` returns ``{"data": {nodes, edges}, ...}`` and
    ``Graph.from_payload`` wants that inner ``data``, so the unwrapping happens
    here rather than in the guest.
    """
    graph = unit.graph
    if hasattr(graph, "dump"):
        dumped = graph.dump()
        payload = dumped.get("data", dumped) if isinstance(dumped, dict) else dumped
    elif isinstance(graph, dict):
        payload = graph.get("data", graph)
    else:
        msg = (
            f"The createos executor cannot serialize a graph of type {type(graph).__name__}. "
            "It expects an lfx Graph, or the flow payload itself."
        )
        raise SandboxExecutionError(msg)

    raw_options = dict(unit.runtime_options or {})
    dropped = sorted(set(raw_options) & _UNSHIPPABLE_OPTIONS)
    if dropped:
        logger.debug("createos executor dropped host-only runtime options: %s", dropped)
    options = {k: v for k, v in raw_options.items() if k not in _UNSHIPPABLE_OPTIONS}

    # THE inputs, not a nicety. Coordinator.stream() calls run(graph, inputs=[])
    # and documents that the streaming path reads its inputs from
    # runtime_options["initial_inputs"] rather than the seam-level list — so on
    # every streaming caller (/api/v1/run, the lfx CLI, Loop subgraphs)
    # unit.inputs is empty and this is where the user's inputs actually are.
    # Reading only unit.inputs silently ran every such flow with no input.
    inputs = list(unit.inputs or [])
    initial = options.pop("initial_inputs", None)
    if not inputs and initial:
        inputs = initial if isinstance(initial, list) else [initial]

    # Everything crossing the boundary must survive json.dumps. An option that
    # does not is dropped with a warning rather than raising: losing one tuning
    # knob is recoverable, failing the whole run over it is not.
    shippable = {}
    for key, value in options.items():
        try:
            json.dumps(value)
        except (TypeError, ValueError):
            logger.warning("createos executor dropped non-serializable runtime option %r", key)
            continue
        shippable[key] = value

    return {
        "graph": payload,
        "inputs": inputs,
        "runtime_options": shippable,
        "flow_id": getattr(unit.graph, "flow_id", None),
    }


def _provision(client: SandboxClient) -> str:
    """Create the guest that will run this flow."""
    timeout = _timeout_seconds()
    created = client.create(
        shape=env("CREATEOS_EXECUTOR_SHAPE", _DEFAULT_SHAPE),
        name=f"lf-x-{uuid.uuid4().hex[:17]}",
        # A flow talks to model providers and APIs, so egress-off is not a
        # usable default here the way it is for a bare snippet. The operator
        # narrows it with CREATEOS_EXECUTOR_EGRESS (address rules only —
        # CreateOS does not enforce hostname rules).
        egress=_egress(),
        auto_pause_seconds=max(_AUTO_PAUSE_FLOOR, timeout + _AUTO_PAUSE_MARGIN),
        rootfs=env("CREATEOS_EXECUTOR_ROOTFS") or None,
    )
    return str(created["id"])


def _egress() -> list[str]:
    raw = env("CREATEOS_EXECUTOR_EGRESS")
    if not raw:
        return ["*"]
    rules = [r.strip() for r in raw.split(",") if r.strip()]
    return rules or list(_DENY_ALL_EGRESS)


def _timeout_seconds() -> int:
    try:
        return max(1, int(env("CREATEOS_EXECUTOR_TIMEOUT_SECONDS", str(_DEFAULT_TIMEOUT_SECONDS))))
    except ValueError:
        return _DEFAULT_TIMEOUT_SECONDS


def _stage(client: SandboxClient, sandbox_id: str, spec: dict[str, Any]) -> None:
    """Upload the flow spec and the runner, and make sure lfx is importable."""
    spec_path = f"{_GUEST_DIR}/spec.json"
    client.upload(sandbox_id, spec_path, json.dumps(spec).encode())
    client.upload(
        sandbox_id,
        f"{_GUEST_DIR}/runner.py",
        _GUEST_RUNNER.replace("SPEC_PATH", spec_path).encode(),
    )

    probe = client.exec(sandbox_id, "python3", ["-c", "import lfx"], timeout_seconds=60)
    if probe.get("exit_code") == 0:
        return
    if env("CREATEOS_EXECUTOR_INSTALL_LFX", "").lower() not in {"1", "true", "yes", "on", "y", "t"}:
        msg = (
            "The CreateOS guest has no importable `lfx`. Point CREATEOS_EXECUTOR_ROOTFS at a "
            "template that has Langflow installed (the supported path), or set "
            "CREATEOS_EXECUTOR_INSTALL_LFX=true to pip install it per run, which is far slower "
            "than the flow itself."
        )
        raise SandboxExecutionError(msg)
    logger.warning("Installing lfx in the CreateOS guest per run — bake a template instead")
    version = env("CREATEOS_EXECUTOR_LFX_VERSION", _host_lfx_version())
    spec_arg = f"lfx=={version}" if version else "lfx"
    # Components carry their own dependencies — the built-in Python Interpreter
    # imports langchain_experimental, for instance — and `lfx` alone has none of
    # them. Measured live: without this the flow rebuilds fine in the guest and
    # then every vertex fails with an ImportError. A template remains the right
    # answer; this makes the fallback demonstrable.
    extra = env("CREATEOS_EXECUTOR_PIP", "")
    packages = " ".join([spec_arg, *extra.split()])
    install = client.exec(
        sandbox_id, "/bin/sh", ["-c", f"pip install --quiet {packages} 2>&1 | tail -5"], timeout_seconds=1800
    )
    if install.get("exit_code") != 0:
        msg = f"Could not install lfx in the guest: {(install.get('stdout') or '')[-500:]}"
        raise SandboxExecutionError(msg)


def _host_lfx_version() -> str:
    try:
        from importlib.metadata import version

        return version("lfx")
    except Exception:  # noqa: BLE001 - version pinning is best effort
        return ""


def _run(client: SandboxClient, sandbox_id: str) -> dict[str, Any]:
    """Execute the runner, bounded by the guest's own timeout(1)."""
    timeout = _timeout_seconds()
    return client.exec(
        sandbox_id,
        "timeout",
        ["--signal=KILL", str(timeout), "python3", f"{_GUEST_DIR}/runner.py"],
        timeout_seconds=timeout,
        grace_seconds=30,
    )


def create_executor() -> CreateOSExecutor:
    """Entry point: the zero-argument factory the executor registry calls."""
    return CreateOSExecutor()
