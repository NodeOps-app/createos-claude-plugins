"""The ``createos`` sandbox backend for Langflow.

One throwaway CreateOS Firecracker microVM per execution, on the CreateOS
control plane, so the Langflow host needs no KVM/HVF device of its own.

Registered through the ``lfx.sandbox_backends`` entry point. Langflow imports
nothing here until an operator lists ``createos`` in
``LANGFLOW_SANDBOX_BACKEND_PLUGINS``.

Shape of one execution, mirroring the SDK's remote-code-execution example
(``createos-sandbox-sdk/examples/56-remote-code-execution``):

    POST   /v1/sandboxes                          create the VM
    PUT    /v1/sandboxes/{id}/files?path=...      upload the program
    POST   /v1/sandboxes/{id}/exec                run it, buffered
    DELETE /v1/sandboxes/{id}                     always, in a finally

Deliberately stateless: the merged lfx ``SandboxBackend`` protocol carries
only ``run(code, env) -> SandboxResult``, so guest reuse across executions and
artifact collection have nowhere to be returned and are not implemented.
"""

from __future__ import annotations

import os
import threading
import time
import uuid

import httpx
from lfx.log.logger import logger
from lfx.utils.sandbox.base import (
    _EXIT_CODE_TIMEOUT,
    Capabilities,
    SandboxExecutionError,
    SandboxResult,
    SandboxUnavailableError,
    _sandbox_settings,
)

__all__ = ["CreateOSBackend", "create_backend"]

BACKEND_NAME = "createos"

_DEFAULT_BASE_URL = "https://api.sb.createos.sh"
_DEFAULT_ROOTFS = "devbox:1"

# Langflow's sandbox_memory_mb default (192) is sized for exec-sandbox's local
# QEMU guest and is far too small for a fresh CreateOS guest importing numpy or
# pandas. A CreateOS shape also fixes vCPU, which sandbox_memory_mb cannot
# express at all, so the default is a named shape and sandbox_memory_mb only
# raises the floor. Pin an exact shape with CREATEOS_SANDBOX_SHAPE.
_DEFAULT_SHAPE = "s-2vcpu-4gb"
_DEFAULT_SHAPE_MEMORY_MIB = 4096

_GUEST_CODE_DIR = "/workspace"
_GUEST_PYTHON = "python3"

# CreateOS egress is allowlist-only and has no deny-all token: null, [], and
# ["*"] all mean allow-all. "No network" therefore has to be spelled as a rule
# set that parses cleanly and matches nothing, so the host installs the
# iptables chain and its default DROP applies to everything else. 240.0.0.0/4
# is IANA-reserved and unroutable, and it is a constant we control, so it can
# never reach the host's parse-failure path -- which falls back to allow-all
# rather than refusing.
_DENY_ALL_EGRESS = ("240.0.0.0/4",)

# CreateOS does NOT enforce hostname egress rules. Measured against the live
# control plane, one VM per rule form, probing an allowlisted host and a
# non-allowlisted one:
#
#   pypi.org              -> example.com reachable   (NOT enforced)
#   pypi.org:443          -> example.com reachable   (NOT enforced)
#   *.pypi.org, pypi.org  -> example.com reachable   (NOT enforced)
#   151.101.192.223:443   -> example.com BLOCKED     (enforced)
#   240.0.0.0/4           -> example.com BLOCKED     (enforced)
#
# The rules are stored and echoed back by the API either way, so a hostname
# allowlist looks accepted while restricting nothing. Only address-based rules
# reach the host's iptables/eBPF policy.
#
# Resolving the operator's domains to addresses here would NOT fix it and is
# deliberately not done: DNS answers rotate, the guest re-resolves on its own,
# and CDN addresses are shared -- allowlisting pypi.org's Fastly address would
# admit every other tenant on it. So the capability is declared False and a
# configured domain allowlist is refused (see _assert_policy_enforceable).
_DOMAIN_ALLOWLIST_UNSUPPORTED = (
    "CreateOS does not enforce hostname-based egress rules (verified live: a rule set of "
    "['pypi.org'] left example.com reachable, while an address rule blocked it). Langflow "
    "would be told the allowlist is in force while every destination stayed reachable"
)

# What CreateOS egress policy cannot reach. fc/internal/hosts/vm/egress.go
# unconditionally ACCEPTs the guest's own /31, all of 169.254.0.0/16, and the
# agent time servers before the final DROP. Verified live: under the deny-all
# policy above a guest still reached 169.254.169.254:80 and got HTTP 200 while
# a public address was blocked. The merged lfx Capabilities has no field for
# declaring such a hole, so this backend refuses restricted-egress runs itself
# unless the operator accepts it (see _assert_policy_enforceable).
_EGRESS_EXCEPTIONS = ("169.254.0.0/16 (link-local, carries the VM metadata service)",)
_ACCEPT_EXCEPTIONS_ENV = "LANGFLOW_SANDBOX_CREATEOS_ACCEPT_EGRESS_EXCEPTIONS"

# Control-plane calls (create, destroy, catalog, whoami) are not the user's
# code, so they get a fixed budget. Only exec is bounded by the configured
# sandbox timeout.
_CONTROL_TIMEOUT_SECONDS = 60
_CONNECT_TIMEOUT_SECONDS = 10

# Added to the guest wall clock before the HTTP read is abandoned, covering
# request transport and result marshalling. The guest's own `timeout` is the
# authoritative limit and VM teardown is what actually stops a runaway
# execution; this only decides when we stop waiting.
_EXEC_GRACE_SECONDS = 15

# Reclaim window for a VM this process failed to destroy. It MUST outlast the
# execution it protects: the control plane touches a sandbox's activity clock
# once, when /exec is accepted, so a quiet program (time.sleep(95)) looks idle
# and a backstop pinned at the 60s minimum would PAUSE a healthy execution and
# surface as a timeout.
_AUTO_PAUSE_MIN_SECONDS = 60
_AUTO_PAUSE_MARGIN_SECONDS = 120

# GNU timeout(1) reports a timed-out command as 124 whatever signal it sent.
_GUEST_TIMEOUT_EXIT_CODE = 124

# Control-plane name limit, found by running against the live API rather than
# by any local test. 19 hex characters leave 76 bits of collision margin.
_NAME_PREFIX = "lf-"
_NAME_HEX_CHARS = 19

_TRUTHY = frozenset({"1", "true", "yes", "on", "y", "t"})


def _env(name: str, default: str = "") -> str:
    return os.environ.get(name, "").strip() or default


def _api_key() -> str:
    return _env("CREATEOS_SANDBOX_API_KEY") or _env("CREATEOS_API_KEY")


def _auto_pause_seconds(timeout_seconds: int) -> int:
    """Idle window for the orphan backstop, always longer than one execution."""
    return max(_AUTO_PAUSE_MIN_SECONDS, timeout_seconds + _AUTO_PAUSE_MARGIN_SECONDS)


def _egress_for(allow_network: bool) -> list[str]:
    """Translate the operator's network policy into CreateOS egress rules.

    Only two outcomes, because only address-based rules are enforced: deny-all,
    or unrestricted. A domain allowlist never reaches here -- it is refused up
    front by :func:`_assert_policy_enforceable`.
    """
    if not allow_network:
        return list(_DENY_ALL_EGRESS)
    # CreateOS has no package-registry default of its own, so this really is
    # unrestricted. Documented in the README.
    return ["*"]


def _assert_policy_enforceable(allow_network: bool, allowed_domains: tuple[str, ...]) -> None:
    """Refuse when the operator's network policy cannot actually be delivered.

    Two separate refusals, both fail-closed:

    * A domain allowlist is refused OUTRIGHT. ``capabilities()`` reports
      ``supports_domain_allowlist=False`` so the lfx dispatcher already refuses
      it, but this backend is also reachable directly, and a policy that
      silently does nothing is the one failure mode worth guarding twice.
    * Restricted egress is refused unless the operator accepts the link-local
      hole, because an operator who turned the network off did not ask for
      "off except one range". Upstream used to carry this as
      ``Capabilities.egress_exceptions`` plus a
      ``sandbox_accept_egress_exceptions`` setting; both were removed with the
      vendor-neutral refactor, so the backend enforces it itself.
    """
    if allowed_domains:
        msg = (
            f"LANGFLOW_SANDBOX_ALLOWED_DOMAINS={list(allowed_domains)!r} is set, but "
            f"{_DOMAIN_ALLOWLIST_UNSUPPORTED}. Use LANGFLOW_SANDBOX_ALLOW_NETWORK=false for "
            "no egress at all, which IS enforced. Refusing to run the code."
        )
        raise SandboxUnavailableError(msg)
    if allow_network:
        return
    if _env(_ACCEPT_EXCEPTIONS_ENV).lower() in _TRUTHY:
        return
    msg = (
        "The CreateOS sandbox cannot block every destination: "
        f"{', '.join(_EGRESS_EXCEPTIONS)} stays reachable whatever the egress policy says. "
        "Your settings restrict egress (LANGFLOW_SANDBOX_ALLOW_NETWORK=false). "
        f"Set {_ACCEPT_EXCEPTIONS_ENV}=true to run anyway. Refusing to run the code."
    )
    raise SandboxUnavailableError(msg)


class CreateOSBackend:
    """One throwaway CreateOS microVM per execution.

    Process-wide singleton built lazily by the lfx registry. ``run`` is called
    from arbitrary threads, so the httpx client and the shape cache are guarded
    here.
    """

    name = BACKEND_NAME

    def __init__(self) -> None:
        """Initialize empty client, shape cache, and preflight latch."""
        self._lock = threading.Lock()
        self._client: httpx.Client | None = None
        self._shapes: tuple[tuple[int, str], ...] | None = None
        self._preflighted = False

    # -- protocol ---------------------------------------------------------

    @staticmethod
    def capabilities() -> Capabilities:
        """Declare what this backend enforces. Performs no I/O."""
        return Capabilities(
            isolation="hardware-virtualized",
            supports_deny_all_egress=True,
            # False on purpose: hostname rules are accepted by the API and then
            # not enforced. See _DOMAIN_ALLOWLIST_UNSUPPORTED. Declaring True
            # would make the lfx policy gate wave through an allowlist that
            # restricts nothing.
            supports_domain_allowlist=False,
        )

    def shutdown(self) -> None:
        """Close the pooled HTTP client. Safe to call repeatedly."""
        with self._lock:
            client, self._client = self._client, None
        if client is not None:
            try:
                client.close()
            except Exception:  # noqa: BLE001 - teardown must not raise
                logger.debug("Closing the CreateOS client failed", exc_info=True)

    def reset_after_fork(self) -> None:
        """Rebuild synchronization state in a freshly forked child.

        The mutex must be REPLACED: if another parent thread held it at fork
        time the child inherits it locked with no owner. The httpx client is
        dropped rather than closed -- its sockets belong to the parent, and
        closing them here would tear down connections the parent still uses.
        """
        self._lock = threading.Lock()
        self._client = None
        self._shapes = None
        self._preflighted = False

    def run(self, code: str, *, env: dict[str, str] | None = None) -> SandboxResult:
        """Run ``code`` to completion in a fresh CreateOS microVM.

        Raises:
            SandboxUnavailableError: Missing credential, rejected policy, or an
                unreachable control plane. Fails closed.
            SandboxExecutionError: The control plane failed mid-run.
        """
        settings = _sandbox_settings()
        allowed_domains = tuple(settings.allowed_domains)
        _assert_policy_enforceable(settings.allow_network, allowed_domains)

        self._preflight()
        shape = self._shape_for(settings.memory_mb)
        client = self._http()

        sandbox_id = None
        started = time.monotonic()
        try:
            sandbox_id = self._create(
                client,
                shape=shape,
                env=env or {},
                egress=_egress_for(settings.allow_network),
                auto_pause_seconds=_auto_pause_seconds(settings.timeout_seconds),
            )
            path = f"{_GUEST_CODE_DIR}/main_{uuid.uuid4().hex[:12]}.py"
            self._upload(client, sandbox_id, path, code)
            result = self._exec(client, sandbox_id, path, settings.timeout_seconds)
        finally:
            if sandbox_id is not None:
                self._destroy(client, sandbox_id)
        return SandboxResult(
            stdout=result[0],
            stderr=result[1],
            exit_code=result[2],
            execution_time_ms=int((time.monotonic() - started) * 1000),
        )

    # -- HTTP -------------------------------------------------------------

    def _http(self) -> httpx.Client:
        """Return the pooled client, creating it on first use."""
        with self._lock:
            if self._client is None or self._client.is_closed:
                key = _api_key()
                if not key:
                    msg = (
                        "LANGFLOW_SANDBOX_BACKEND=createos is configured but CREATEOS_SANDBOX_API_KEY "
                        "is not set. Get a key at https://createos.nodeops.network/profile. "
                        "Refusing to run the code."
                    )
                    raise SandboxUnavailableError(msg)
                self._client = httpx.Client(
                    base_url=_env("CREATEOS_SANDBOX_BASE_URL", _DEFAULT_BASE_URL),
                    headers={"X-Api-Key": key},
                    timeout=httpx.Timeout(_CONTROL_TIMEOUT_SECONDS, connect=_CONNECT_TIMEOUT_SECONDS),
                )
            return self._client

    @staticmethod
    def _redact(text: str) -> str:
        """Remove the API key from text that will reach an exception or a log.

        Response bodies are echoed into error messages, and a misconfigured or
        hostile endpoint could reflect the request headers back.
        """
        key = _api_key()
        return text.replace(key, "***") if key else text

    def _unwrap(self, response: httpx.Response) -> dict:
        """Return the ``data`` payload of a JSend envelope, or raise.

        Nothing here degrades to in-process execution. A misconfiguration or a
        rejected request raises SandboxUnavailableError (fail closed), while a
        transient control-plane fault raises SandboxExecutionError.
        """
        if response.status_code == httpx.codes.OK:
            try:
                body = response.json()
            except ValueError as exc:
                msg = "CreateOS returned a non-JSON response"
                raise SandboxExecutionError(msg) from exc
            if not isinstance(body, dict) or body.get("status") != "success":
                msg = f"CreateOS returned an unsuccessful envelope: {self._redact(repr(body))}"
                raise SandboxExecutionError(msg)
            data = body.get("data")
            return data if isinstance(data, dict) else {}

        detail = self._redact(response.text.strip()[:500])
        msg = f"CreateOS request failed ({response.status_code}): {detail}"
        # 429 and 5xx are worth retrying and are not the operator's fault.
        # Everything else means the request or the credential is wrong, which
        # must block execution rather than look like a flaky run.
        if response.status_code == httpx.codes.TOO_MANY_REQUESTS or response.status_code >= 500:
            raise SandboxExecutionError(msg)
        raise SandboxUnavailableError(msg)

    # -- preflight and catalog --------------------------------------------

    def _preflight(self) -> None:
        """Verify the credential once per process, failing closed."""
        if self._preflighted:
            return
        try:
            self._unwrap(self._http().get("/v1/whoami"))
        except httpx.HTTPError as exc:
            msg = f"CreateOS control plane is unreachable: {exc}. Refusing to run the code."
            raise SandboxUnavailableError(msg) from exc
        self._preflighted = True

    def _catalog(self) -> tuple[tuple[int, str], ...]:
        """The shape catalog as ``(mem_mib, shape_id)``, ascending.

        Fetched once per process, outside the mutex: the request carries a 60s
        budget and two racing callers simply fetch twice, which is cheaper than
        the contention.
        """
        with self._lock:
            cached = self._shapes
        if cached is not None:
            return cached

        try:
            data = self._unwrap(self._http().get("/v1/shapes"))
        except httpx.HTTPError as exc:
            msg = f"Could not read the CreateOS shape catalog: {exc}"
            raise SandboxUnavailableError(msg) from exc

        entries = []
        for shape in data.get("data", []):
            if not isinstance(shape, dict):
                continue
            mem_mib, shape_id = shape.get("mem_mib"), shape.get("id")
            if not mem_mib or not shape_id:
                continue
            try:
                entries.append((int(mem_mib), str(shape_id)))
            except (TypeError, ValueError):
                # A control-plane value, so untrusted. One unreadable entry
                # costs itself; raising here would reach the component as a
                # raw traceback instead of a mapped sandbox error.
                logger.debug("Skipping a CreateOS shape with an unreadable mem_mib", exc_info=True)

        with self._lock:
            if self._shapes is None:
                self._shapes = tuple(sorted(entries))
            return self._shapes

    def _shape_for(self, memory_mb: int) -> str:
        """Choose the VM shape for one execution.

        Never rounds DOWN: a shape with less memory than the operator
        configured would produce OOM kills that read as user-code bugs rather
        than as a misconfigured sandbox.
        """
        available = {shape_id: mem_mib for mem_mib, shape_id in self._catalog()}

        pinned = _env("CREATEOS_SANDBOX_SHAPE")
        if pinned:
            if available and pinned not in available:
                msg = (
                    f"CREATEOS_SANDBOX_SHAPE={pinned!r} is not in the CreateOS shape catalog "
                    f"({', '.join(sorted(available))}). Refusing to run the code."
                )
                raise SandboxUnavailableError(msg)
            if available.get(pinned, memory_mb) < memory_mb:
                msg = (
                    f"CREATEOS_SANDBOX_SHAPE={pinned!r} has {available[pinned]} MiB but "
                    f"LANGFLOW_SANDBOX_MEMORY_MB is {memory_mb}. Refusing to run the code."
                )
                raise SandboxUnavailableError(msg)
            return pinned

        floor = max(memory_mb, _DEFAULT_SHAPE_MEMORY_MIB)
        for mem_mib, shape_id in self._catalog():
            if mem_mib >= floor:
                return shape_id
        if available:
            msg = (
                f"No CreateOS shape offers the {floor} MiB required by LANGFLOW_SANDBOX_MEMORY_MB. "
                "Refusing to run the code."
            )
            raise SandboxUnavailableError(msg)
        return _DEFAULT_SHAPE

    # -- one execution ----------------------------------------------------

    def _create(
        self,
        client: httpx.Client,
        *,
        shape: str,
        env: dict[str, str],
        egress: list[str],
        auto_pause_seconds: int,
    ) -> str:
        """Create the guest and return its id.

        ``env`` is declared HERE rather than on the exec call: CreateOS rejects
        an exec whose ``env`` introduces a key the sandbox was not created with.
        """
        body = {
            "shape": shape,
            "rootfs": _env("CREATEOS_SANDBOX_ROOTFS", _DEFAULT_ROOTFS),
            # Fresh random name per create. DELETE only moves a sandbox to
            # `destroying`, and the control plane rejects a duplicate name
            # among non-terminal sandboxes, so a derived name would collide
            # with the corpse of its predecessor.
            "name": f"{_NAME_PREFIX}{uuid.uuid4().hex[:_NAME_HEX_CHARS]}",
            "egress": egress,
            "auto_pause_after_seconds": auto_pause_seconds,
        }
        if env:
            body["envs"] = {str(k): str(v) for k, v in env.items()}
        try:
            created = self._unwrap(client.post("/v1/sandboxes", json=body))
        except httpx.HTTPError as exc:
            msg = f"Could not create a CreateOS sandbox: {exc}"
            raise SandboxExecutionError(msg) from exc
        sandbox_id = created.get("id")
        if not sandbox_id:
            msg = f"CreateOS did not return a sandbox id: {self._redact(repr(created))}"
            raise SandboxExecutionError(msg)
        return str(sandbox_id)

    def _upload(self, client: httpx.Client, sandbox_id: str, path: str, code: str) -> None:
        """Write the program into the guest. Parent directories are created for us."""
        try:
            response = client.put(
                f"/v1/sandboxes/{sandbox_id}/files",
                params={"path": path},
                content=code.encode(),
                headers={"Content-Type": "application/octet-stream"},
            )
        except httpx.HTTPError as exc:
            msg = f"Could not upload code to the CreateOS sandbox: {exc}"
            raise SandboxExecutionError(msg) from exc
        self._unwrap(response)

    def _exec(self, client: httpx.Client, sandbox_id: str, path: str, timeout_seconds: int) -> tuple[str, str, int]:
        """Run the program and return ``(stdout, stderr, exit_code)``.

        Two independent limits, and conflating them is what lets an execution
        outlive its configured timeout. The guest's own ``timeout(1)`` is the
        wall clock the program gets, so a timed-out run still returns the
        output it produced. The HTTP read budget is only a backstop for a
        control plane that stops answering; the ``finally`` that destroys the
        VM is what actually stops runaway code either way.
        """
        body = {
            "cmd": "timeout",
            "args": ["--signal=KILL", str(timeout_seconds), _GUEST_PYTHON, path],
        }
        try:
            response = client.post(
                f"/v1/sandboxes/{sandbox_id}/exec",
                json=body,
                timeout=httpx.Timeout(timeout_seconds + _EXEC_GRACE_SECONDS, connect=_CONNECT_TIMEOUT_SECONDS),
            )
        except httpx.TimeoutException:
            # The VM is destroyed in the caller's finally, so the code is
            # stopped regardless. Report it as the timeout it is.
            return "", "", _EXIT_CODE_TIMEOUT
        except httpx.HTTPError as exc:
            msg = f"CreateOS exec failed: {exc}"
            raise SandboxExecutionError(msg) from exc

        data = self._unwrap(response)
        result = data.get("result")
        if not isinstance(result, dict):
            msg = f"CreateOS exec returned no result: {self._redact(repr(data))}"
            raise SandboxExecutionError(msg)
        exit_code = int(result.get("exit_code", 1))
        if exit_code == _GUEST_TIMEOUT_EXIT_CODE:
            # lfx renders -1 as "timed out (see LANGFLOW_SANDBOX_TIMEOUT_SECONDS)".
            exit_code = _EXIT_CODE_TIMEOUT
        return str(result.get("stdout", "")), str(result.get("stderr", "")), exit_code

    def _destroy(self, client: httpx.Client, sandbox_id: str) -> None:
        """Best-effort teardown. Never masks the error that got us here.

        A leaked VM is bounded by ``auto_pause_after_seconds``, so a failure to
        destroy is logged rather than raised -- raising from a ``finally``
        would replace the real execution error with a cleanup error.
        """
        try:
            client.delete(f"/v1/sandboxes/{sandbox_id}", timeout=_CONTROL_TIMEOUT_SECONDS)
        except Exception:  # noqa: BLE001 - cleanup must not mask the real error
            logger.warning("Could not destroy CreateOS sandbox %s", sandbox_id, exc_info=True)


def create_backend() -> CreateOSBackend:
    """Entry point: the zero-argument factory lfx's registry calls."""
    return CreateOSBackend()
