"""One runnable check per non-trivial branch. Run with pytest, or directly.

No mocking library: httpx.MockTransport is a real transport, so the client,
the JSend unwrapping, and the request bodies are all exercised for real. The
only seam is assigning ``backend._client`` before ``run()``, which ``_http()``
then returns as-is.
"""

from __future__ import annotations

import json
import os
import types

import httpx
import pytest
from lfx.utils.sandbox.base import SandboxUnavailableError

from langflow_sandbox_createos import (
    _ACCEPT_EXCEPTIONS_ENV,
    CreateOSBackend,
    _egress_for,
    create_backend,
)

SHAPES = [
    {"id": "s-1vcpu-256mb", "vcpu": 1, "mem_mib": 256},
    {"id": "s-2vcpu-2gb", "vcpu": 2, "mem_mib": 2048},
    {"id": "s-2vcpu-4gb", "vcpu": 2, "mem_mib": 4096},
    {"id": "s-4vcpu-16gb", "vcpu": 4, "mem_mib": 16384},
]


def _wire(exit_code: int = 0, stdout: str = "hi\n", stderr: str = "") -> tuple[CreateOSBackend, list]:
    """A backend whose client speaks to a recorded fake control plane."""
    calls: list[tuple[str, str, dict]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "PUT":
            body = {"raw": request.content.decode()}
        else:
            body = json.loads(request.content) if request.content else {}
        calls.append((request.method, request.url.path, {**body, "query": dict(request.url.params)}))
        if request.url.path == "/v1/whoami":
            return httpx.Response(200, json={"status": "success", "data": {"user_id": "u1"}})
        if request.url.path == "/v1/shapes":
            return httpx.Response(200, json={"status": "success", "data": {"data": SHAPES}})
        if request.url.path == "/v1/sandboxes" and request.method == "POST":
            return httpx.Response(200, json={"status": "success", "data": {"id": "sb-123"}})
        if request.url.path.endswith("/files"):
            return httpx.Response(200, json={"status": "success", "data": {}})
        if request.url.path.endswith("/exec"):
            return httpx.Response(
                200,
                json={
                    "status": "success",
                    "data": {"result": {"stdout": stdout, "stderr": stderr, "exit_code": exit_code}, "exec_ms": 12},
                },
            )
        if request.method == "DELETE":
            return httpx.Response(200, json={"status": "success", "data": {"status": "destroying"}})
        raise AssertionError(f"unexpected request: {request.method} {request.url}")

    backend = create_backend()
    backend._client = httpx.Client(transport=httpx.MockTransport(handler), base_url="https://api.test")
    return backend, calls


@pytest.fixture(autouse=True)
def _accept_egress_exceptions(monkeypatch):
    """Most tests want the link-local refusal out of the way."""
    monkeypatch.setenv(_ACCEPT_EXCEPTIONS_ENV, "true")
    monkeypatch.delenv("CREATEOS_SANDBOX_SHAPE", raising=False)


def test_egress_mapping():
    # Only two outcomes: address-based deny-all, or unrestricted. Hostname
    # rules are not enforced by CreateOS, so they never reach the wire.
    assert _egress_for(allow_network=False) == ["240.0.0.0/4"]
    assert _egress_for(allow_network=True) == ["*"]


def test_domain_allowlist_is_refused_not_silently_ignored(monkeypatch):
    """CreateOS accepts hostname egress rules and then does not enforce them.

    Verified live: a sandbox created with egress ['pypi.org','1.1.1.1:53']
    still reached example.com, while an address rule blocked it. Honouring the
    setting is impossible, so it must fail closed rather than run wide open.
    """
    monkeypatch.setenv("LANGFLOW_SANDBOX_ALLOW_NETWORK", "true")
    monkeypatch.setenv("LANGFLOW_SANDBOX_ALLOWED_DOMAINS", '["pypi.org"]')
    backend, calls = _wire()

    from lfx.utils.sandbox.base import _SandboxSettings

    import langflow_sandbox_createos as m

    monkeypatch.setattr(
        m, "_sandbox_settings", lambda: _SandboxSettings(allow_network=True, allowed_domains=("pypi.org",))
    )
    with pytest.raises(SandboxUnavailableError, match="does not enforce hostname-based egress"):
        backend.run("print(1)")
    # Refused before anything was created, so no VM is leaked by the refusal.
    assert not [p for method, p, _ in calls if method == "POST" and p == "/v1/sandboxes"]


def test_capabilities_do_not_claim_domain_allowlist():
    """The lfx policy gate trusts this field to decide whether an allowlist is honoured."""
    assert CreateOSBackend.capabilities().supports_domain_allowlist is False


def test_restricted_egress_refused_without_opt_in(monkeypatch):
    monkeypatch.delenv(_ACCEPT_EXCEPTIONS_ENV, raising=False)
    backend, _ = _wire()
    with pytest.raises(SandboxUnavailableError, match="169.254.0.0/16"):
        backend.run("print(1)")


def test_happy_path_creates_uploads_execs_and_destroys():
    backend, calls = _wire(stdout="hi\n")
    result = backend.run("print('hi')", env={"TOKEN": "s3cret"})

    assert result.success
    assert result.stdout == "hi\n"
    assert result.execution_time_ms is not None

    methods = [(method, path) for method, path, _ in calls]
    assert ("GET", "/v1/whoami") in methods
    assert ("POST", "/v1/sandboxes") in methods
    assert ("DELETE", "/v1/sandboxes/sb-123") in methods

    create = next(payload for method, path, payload in calls if path == "/v1/sandboxes" and method == "POST")
    # Default settings: no network -> the unroutable deny-all rule.
    assert create["egress"] == ["240.0.0.0/4"]
    # env is declared at CREATE; exec cannot introduce a new key.
    assert create["envs"] == {"TOKEN": "s3cret"}
    # sandbox_memory_mb (192) is a floor, not the VM size.
    assert create["shape"] == "s-2vcpu-4gb"
    assert create["auto_pause_after_seconds"] >= 60

    upload = next(payload for method, path, payload in calls if path.endswith("/files") and method == "PUT")
    assert upload["raw"] == "print('hi')"

    exec_call = next(payload for _, path, payload in calls if path.endswith("/exec"))
    assert exec_call["cmd"] == "timeout"
    assert exec_call["args"][:2] == ["--signal=KILL", "30"]
    assert exec_call["args"][2] == "python3"
    assert exec_call["args"][3] == upload["query"]["path"]


def test_guest_timeout_is_reported_as_a_timeout():
    backend, _ = _wire(exit_code=124, stdout="partial\n")
    result = backend.run("import time; time.sleep(999)")
    assert not result.success
    assert result.exit_code == -1
    assert "timed out" in result.error_message()
    # A timed-out run still returns what it printed.
    assert result.stdout == "partial\n"


def test_sandbox_is_destroyed_even_when_exec_fails():
    calls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(f"{request.method} {request.url.path}")
        if request.url.path == "/v1/whoami":
            return httpx.Response(200, json={"status": "success", "data": {}})
        if request.url.path == "/v1/shapes":
            return httpx.Response(200, json={"status": "success", "data": {"data": SHAPES}})
        if request.url.path == "/v1/sandboxes":
            return httpx.Response(200, json={"status": "success", "data": {"id": "sb-999"}})
        if request.url.path.endswith("/files"):
            return httpx.Response(200, json={"status": "success", "data": {}})
        if request.url.path.endswith("/exec"):
            return httpx.Response(503, text="no capacity")
        return httpx.Response(200, json={"status": "success", "data": {}})

    backend = create_backend()
    backend._client = httpx.Client(transport=httpx.MockTransport(handler), base_url="https://api.test")
    with pytest.raises(Exception, match="503"):
        backend.run("print(1)")
    assert "DELETE /v1/sandboxes/sb-999" in calls


def test_missing_api_key_fails_closed(monkeypatch):
    monkeypatch.delenv("CREATEOS_SANDBOX_API_KEY", raising=False)
    monkeypatch.delenv("CREATEOS_API_KEY", raising=False)
    with pytest.raises(SandboxUnavailableError, match="CREATEOS_SANDBOX_API_KEY"):
        create_backend().run("print(1)")


def test_pinned_shape_below_the_memory_floor_is_refused(monkeypatch):
    monkeypatch.setenv("CREATEOS_SANDBOX_SHAPE", "s-1vcpu-256mb")
    backend, _ = _wire()
    with pytest.raises(SandboxUnavailableError, match="LANGFLOW_SANDBOX_MEMORY_MB"):
        # Default sandbox_memory_mb is 192, so raise the floor above 256 MiB.
        backend._shape_for(1024)


def test_capabilities_are_declared_without_io():
    caps = CreateOSBackend.capabilities()
    assert caps.isolation == "hardware-virtualized"
    # Deny-all is enforced (address rule); the domain allowlist is not.
    assert caps.supports_deny_all_egress


if __name__ == "__main__":
    os.environ.setdefault("CREATEOS_SANDBOX_API_KEY", "test-key")
    raise SystemExit(pytest.main([__file__, "-q"]))


# --- component-side client -------------------------------------------------


def _client_against(rows):
    """A SandboxClient whose control plane returns `rows` from /v1/sandboxes."""
    from langflow_sandbox_createos._client import SandboxClient

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/v1/sandboxes" and request.method == "GET":
            return httpx.Response(200, json={"status": "success", "data": {"data": rows}})
        raise AssertionError(f"unexpected {request.method} {request.url}")

    client = SandboxClient()
    client._http = httpx.Client(transport=httpx.MockTransport(handler), base_url="https://api.test")
    return client


def test_find_by_name_is_the_session_registry():
    """Guest reuse keys off the control plane, not process state.

    self.ctx is scoped to one graph run, so it cannot carry a guest between
    two /build invocations — verified live before this was changed. A
    deterministic name plus the control plane's own uniqueness rule survives
    worker restarts instead.
    """
    rows = [
        {"name": "lf-c-aaa", "id": "sb-1", "status": "running"},
        {"name": "lf-c-bbb", "id": "sb-2", "status": "paused"},
        {"name": "lf-c-ccc", "id": "sb-3", "status": "destroyed"},
    ]
    client = _client_against(rows)
    assert client.find_by_name("lf-c-aaa")["id"] == "sb-1"
    # A paused guest is still ours to adopt; exec resumes it.
    assert client.find_by_name("lf-c-bbb")["id"] == "sb-2"
    # A destroyed one is not.
    assert client.find_by_name("lf-c-ccc") is None
    assert client.find_by_name("lf-c-nope") is None


def _component(**kwargs):
    """A CreateOS Sandbox component instance with a fake graph, for name tests."""
    from langflow_sandbox_createos.components.createos import CreateOSSandboxComponent

    defaults = {"python_code": "print(1)", "allow_network": False, "session_mode": "flow"}
    comp = CreateOSSandboxComponent(**{**defaults, **kwargs})
    return comp


def _name(monkeypatch, flow_id, comp_id, **kwargs):
    """The REAL _session_name(), not a reimplementation of it.

    Reimplementing the hash in the test is what made an earlier version of this
    file pass against the unfixed code — it could not observe the bug it was
    written for. A mutation check caught that; keep calling production code.

    ``graph`` is a read-only property on Component, so the class attribute is
    replaced for the duration of the test rather than assigned on the instance.
    """
    from langflow_sandbox_createos.components.createos import CreateOSSandboxComponent

    comp = _component(**kwargs)
    comp._id = comp_id
    monkeypatch.setattr(CreateOSSandboxComponent, "graph", types.SimpleNamespace(flow_id=flow_id), raising=False)
    return comp._session_name()


def test_session_name_is_stable_and_within_the_control_plane_cap(monkeypatch):
    """The name IS the key, so it must be deterministic and <= 22 characters."""
    a = _name(monkeypatch, "flow-1", "comp-1")
    assert a == _name(monkeypatch, "flow-1", "comp-1")  # stable across runs
    assert a != _name(monkeypatch, "flow-2", "comp-1")  # two flows never share a guest
    assert a != _name(monkeypatch, "flow-1", "comp-2")  # two components never share one
    assert len(a) <= 22, f"control plane rejects names over 22 chars: {a!r}"


def test_session_name_changes_with_the_network_policy(monkeypatch):
    """Turning Allow Network off must not adopt the guest built while it was on.

    The name is the registry, so if the policy is not part of the name a changed
    policy silently reuses the old, open guest and the setting appears to apply
    while doing nothing.
    """
    closed = _name(monkeypatch, "flow-1", "comp-1", allow_network=False)
    opened = _name(monkeypatch, "flow-1", "comp-1", allow_network=True)
    assert closed != opened, "a network-policy change must address a different guest"
    assert len(closed) <= 22 and len(opened) <= 22


def test_reuse_refuses_a_guest_whose_egress_drifted():
    """Even at a matching name, a guest enforcing a different policy is not ours."""
    comp = _component(allow_network=False)
    assert comp._policy_matches({"egress": ["240.0.0.0/4"]}) is True
    assert comp._policy_matches({"egress": ["*"]}) is False
    # Absent or empty means allow-all on the CreateOS side.
    assert comp._policy_matches({}) is False
    assert comp._policy_matches({"egress": []}) is False

    opened = _component(allow_network=True)
    assert opened._policy_matches({"egress": ["*"]}) is True
    assert opened._policy_matches({"egress": ["240.0.0.0/4"]}) is False


# --- regressions from the adversarial review -------------------------------


def test_download_refuses_to_buffer_more_than_the_cap():
    """The guest picks the archive size, so the cap must bind during transfer.

    Before this, `download` returned `response.content` — the whole
    guest-controlled blob was materialised in the Langflow worker and only then
    measured, so the extraction budget prevented nothing.
    """
    from langflow_sandbox_createos._client import SandboxClient

    big = b"x" * (2 * 1024 * 1024)

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=big)

    client = SandboxClient()
    client._http = httpx.Client(transport=httpx.MockTransport(handler), base_url="https://api.test")

    with pytest.raises(Exception, match="exceeds the"):
        client.download("sb-1", "/tmp/a.tgz", max_bytes=1024)

    # Under the cap it still works, and returns the bytes intact.
    assert client.download("sb-1", "/tmp/a.tgz", max_bytes=4 * 1024 * 1024) == big
    # No cap means no limit, for callers that genuinely want that.
    assert client.download("sb-1", "/tmp/a.tgz") == big


def test_download_rejects_an_oversized_declared_length_before_reading():
    """A content-length over budget should fail before the body is pulled."""
    from langflow_sandbox_createos._client import SandboxClient

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=b"y" * 5000, headers={"content-length": "5000"})

    client = SandboxClient()
    client._http = httpx.Client(transport=httpx.MockTransport(handler), base_url="https://api.test")
    with pytest.raises(Exception, match="exceeds the"):
        client.download("sb-1", "/tmp/a.tgz", max_bytes=100)


def test_executor_reads_inputs_from_initial_inputs():
    """Coordinator.stream always passes inputs=[] and puts them in runtime_options.

    Verified against lfx: `Coordinator.stream` calls `run(graph, inputs=[])` and
    documents that the streaming path reads `runtime_options["initial_inputs"]`.
    An executor reading only `unit.inputs` therefore runs EVERY streaming flow
    with no input.
    """
    from lfx.execution.types import Unit

    from langflow_sandbox_createos.executor import _serialize

    graph = {"data": {"nodes": [], "edges": []}}
    user_inputs = [{"input_value": "hello"}]

    spec = _serialize(Unit(graph=graph, inputs=[], runtime_options={"initial_inputs": user_inputs}))
    assert spec["inputs"] == user_inputs, "initial_inputs must become the guest's inputs"
    assert "initial_inputs" not in spec["runtime_options"], "should be normalized, not shipped twice"

    # A bare dict is accepted too, since callers are not consistent.
    spec = _serialize(Unit(graph=graph, inputs=[], runtime_options={"initial_inputs": {"a": 1}}))
    assert spec["inputs"] == [{"a": 1}]

    # The seam-level list still wins when a caller populates it.
    spec = _serialize(Unit(graph=graph, inputs=[{"seam": True}], runtime_options={"initial_inputs": user_inputs}))
    assert spec["inputs"] == [{"seam": True}]


def test_executor_never_ships_host_only_or_unserializable_options():
    """An EventManager cannot cross the boundary, and must not break the run."""
    from lfx.execution.types import Unit

    from langflow_sandbox_createos.executor import _serialize

    class Live:
        pass

    spec = _serialize(
        Unit(
            graph={"data": {"nodes": [], "edges": []}},
            inputs=[],
            runtime_options={
                "event_manager": Live(),  # host-only, dropped by name
                "session_id": "abc",  # host-only, dropped by name
                "callback": Live(),  # not serializable, dropped by probe
                "max_iterations": 7,  # forwarded
                "fallback_to_env_vars": True,  # forwarded
            },
        )
    )
    assert spec["runtime_options"] == {"max_iterations": 7, "fallback_to_env_vars": True}
    json.dumps(spec)  # the whole spec must survive the wire


def test_executor_returns_the_guest_run_outputs_to_api_callers(monkeypatch):
    """Graph.arun -- and so /api/v1/run -- reads RunComplete.outputs.

    The executor streamed per-vertex events but terminated with
    RunComplete(outputs=[]), so every API run returned `outputs: []` however
    much the flow produced. Verified live against a real control plane: the
    same flow returned full results with the executor off and nothing with it
    on. The guest's final `outputs` frame must survive as RunOutputs.
    """
    import asyncio

    from lfx.execution.types import RunComplete, Unit

    from langflow_sandbox_createos import executor as ex

    stdout = "\n".join(
        json.dumps(frame)
        for frame in (
            {"t": "step", "event": {"type": "Vertex", "vertex_id": "ChatOutput-1"}},
            {"t": "outputs", "run_outputs": [{"inputs": {"input_value": "go"}, "outputs": []}]},
            {"t": "done"},
        )
    )

    monkeypatch.setattr(
        ex, "SandboxClient", lambda *_a, **_k: types.SimpleNamespace(destroy=lambda *_: None, close=lambda: None)
    )
    monkeypatch.setattr(ex, "_provision", lambda _client: "sb-test")
    monkeypatch.setattr(ex, "_stage", lambda *_a, **_k: None)
    monkeypatch.setattr(ex, "_run", lambda *_a, **_k: {"stdout": stdout, "exit_code": 0})

    async def drain():
        unit = Unit(graph={"data": {"nodes": [], "edges": []}}, inputs=[])
        return [item async for item in ex.CreateOSExecutor().execute(unit)]

    items = asyncio.run(drain())

    terminal = items[-1]
    assert isinstance(terminal, RunComplete), "the stream must end with RunComplete"
    assert len(terminal.outputs) == 1, "the guest's outputs frame must reach the caller"
    assert terminal.outputs[0].inputs == {"input_value": "go"}

    # The outputs frame is terminal bookkeeping, not a mid-run event.
    assert all(getattr(i, "payload", {}).get("t") != "outputs" for i in items[:-1])


def test_resume_waits_for_a_paused_guest_to_come_back(monkeypatch):
    """A resumed sandbox is not immediately usable.

    find_by_name adopts paused guests on purpose, but the control plane rejects
    exec and file access on one with `409 sandbox is paused; resume it before
    accessing files` -- seen live, mid-demo, on the second run of a reuse flow.
    `resume` returns while the guest is still "resuming", so the client must
    wait for "running" before handing the id back.
    """
    monkeypatch.setenv("CREATEOS_SANDBOX_API_KEY", "test-key")

    from langflow_sandbox_createos._client import SandboxClient

    seen: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(f"{request.method} {request.url.path}")
        if request.method == "POST":
            body = {"id": "sb-1", "status": "resuming"}
        else:
            # Still waking on the first poll, up on the second.
            polls = sum(1 for s in seen if s.startswith("GET"))
            body = {"id": "sb-1", "status": "running" if polls > 1 else "resuming"}
        return httpx.Response(200, json={"status": "success", "data": body})

    client = SandboxClient()
    client._http = httpx.Client(transport=httpx.MockTransport(handler), base_url="https://api.test")

    record = client.resume("sb-1", timeout_seconds=10)

    assert record["status"] == "running", "must not return a still-resuming guest"
    assert seen[0] == "POST /v1/sandboxes/sb-1/resume"
    assert any(s.startswith("GET") for s in seen), "must poll until the guest is running"


def test_resume_gives_up_rather_than_hanging(monkeypatch):
    """A guest that never comes back must fail the run, not block it forever."""
    from langflow_sandbox_createos._client import SandboxClient

    monkeypatch.setenv("CREATEOS_SANDBOX_API_KEY", "test-key")

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"status": "success", "data": {"id": "sb-1", "status": "resuming"}})

    client = SandboxClient()
    client._http = httpx.Client(transport=httpx.MockTransport(handler), base_url="https://api.test")

    with pytest.raises(Exception, match="did not resume"):
        client.resume("sb-1", timeout_seconds=0)
