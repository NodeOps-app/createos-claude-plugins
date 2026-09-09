"""Shared CreateOS control-plane access.

This package ships two surfaces — the ``lfx.sandbox_backends`` backend and the
``langflow.extensions`` components — and both talk to the same control plane.
The pieces that must not diverge live here:

* the credential and base-URL resolution, so one env var configures everything;
* :func:`redact`, so a reflected API key never reaches a traceback;
* :func:`unwrap`, whose error mapping is security-relevant — a rejected request
  or a bad credential FAILS CLOSED (``SandboxUnavailableError``) while only a
  429/5xx is reported as a transient infrastructure fault.

The backend keeps its own pooled client, preflight latch and shape cache; it
imports the primitives here rather than re-implementing them. Components use
:class:`SandboxClient`, which is a plain short-lived client with no process-wide
state — a component instance is per-run, so pooling would buy nothing.
"""

from __future__ import annotations

import os

import httpx
from lfx.utils.sandbox.base import SandboxExecutionError, SandboxUnavailableError

DEFAULT_BASE_URL = "https://api.sb.createos.sh"
DEFAULT_ROOTFS = "devbox:1"

# Control-plane calls are not the user's code, so they get a fixed budget.
CONTROL_TIMEOUT_SECONDS = 60
CONNECT_TIMEOUT_SECONDS = 10

_HTTP_TOO_MANY_REQUESTS = 429
_HTTP_SERVER_ERROR = 500


def env(name: str, default: str = "") -> str:
    """Read a stripped environment variable, falling back to ``default``."""
    return os.environ.get(name, "").strip() or default


def api_key() -> str:
    """The CreateOS credential, preferring the SDK's own variable name."""
    return env("CREATEOS_SANDBOX_API_KEY") or env("CREATEOS_API_KEY")


def base_url() -> str:
    """The control-plane endpoint."""
    return env("CREATEOS_SANDBOX_BASE_URL", DEFAULT_BASE_URL)


def redact(text: str) -> str:
    """Remove the API key from text that will reach an exception or a log.

    Response bodies are echoed into error messages, and a misconfigured or
    hostile endpoint could reflect the request headers back. The key must not
    travel into a traceback just because the server chose to repeat it.
    """
    key = api_key()
    return text.replace(key, "***") if key else text


def require_api_key() -> str:
    """Return the credential, or fail closed with an actionable message."""
    key = api_key()
    if not key:
        msg = (
            "CREATEOS_SANDBOX_API_KEY is not set. Get a key at "
            "https://createos.nodeops.network/profile. Refusing to run."
        )
        raise SandboxUnavailableError(msg)
    return key


def new_client(timeout_seconds: float = CONTROL_TIMEOUT_SECONDS) -> httpx.Client:
    """Build an authenticated client against the control plane."""
    return httpx.Client(
        base_url=base_url(),
        headers={"X-Api-Key": require_api_key()},
        timeout=httpx.Timeout(timeout_seconds, connect=CONNECT_TIMEOUT_SECONDS),
    )


def unwrap(response: httpx.Response) -> dict:
    """Return the ``data`` payload of a JSend envelope, or raise.

    Nothing here degrades to running the code anyway. A misconfiguration or a
    rejected request raises SandboxUnavailableError (fail closed); only 429 and
    5xx — which are retryable and not the operator's fault — are reported as
    SandboxExecutionError.
    """
    if response.status_code == httpx.codes.OK:
        try:
            body = response.json()
        except ValueError as exc:
            msg = "CreateOS returned a non-JSON response"
            raise SandboxExecutionError(msg) from exc
        if not isinstance(body, dict) or body.get("status") != "success":
            msg = f"CreateOS returned an unsuccessful envelope: {redact(repr(body))}"
            raise SandboxExecutionError(msg)
        data = body.get("data")
        return data if isinstance(data, dict) else {}

    detail = redact(response.text.strip()[:500])
    msg = f"CreateOS request failed ({response.status_code}): {detail}"
    if response.status_code == _HTTP_TOO_MANY_REQUESTS or response.status_code >= _HTTP_SERVER_ERROR:
        raise SandboxExecutionError(msg)
    raise SandboxUnavailableError(msg)


class SandboxClient:
    """A short-lived client for one component's worth of work.

    Deliberately not pooled and not a singleton: a component instance serves one
    run, and the control-plane calls it makes are few and fixed-budget. Use it
    as a context manager so the connection is always released.
    """

    def __init__(self, timeout_seconds: float = CONTROL_TIMEOUT_SECONDS) -> None:
        """Open an authenticated client. Raises if no credential is configured."""
        self._http = new_client(timeout_seconds)

    def close(self) -> None:
        """Release the HTTP connection."""
        self._http.close()

    # -- catalog ----------------------------------------------------------

    def shapes(self) -> list[dict]:
        """The shape catalog, smallest memory first."""
        data = unwrap(self._http.get("/v1/shapes"))
        rows = data.get("data") or []
        return sorted(
            (row for row in rows if isinstance(row, dict) and row.get("mem_mib")),
            key=lambda row: int(row["mem_mib"]),
        )

    # -- lifecycle --------------------------------------------------------

    def create(
        self,
        *,
        shape: str,
        name: str,
        egress: list[str],
        envs: dict[str, str] | None = None,
        auto_pause_seconds: int | None = None,
        ingress: bool = False,
        rootfs: str | None = None,
    ) -> dict:
        """Create a sandbox and return the control plane's record of it."""
        body: dict = {
            "shape": shape,
            "rootfs": rootfs or env("CREATEOS_SANDBOX_ROOTFS", DEFAULT_ROOTFS),
            "name": name,
            "egress": egress,
            "ingress_enabled": ingress,
        }
        if auto_pause_seconds is not None:
            body["auto_pause_after_seconds"] = auto_pause_seconds
        if envs:
            body["envs"] = {str(k): str(v) for k, v in envs.items()}
        created = unwrap(self._http.post("/v1/sandboxes", json=body))
        if not created.get("id"):
            msg = f"CreateOS did not return a sandbox id: {redact(repr(created))}"
            raise SandboxExecutionError(msg)
        return created

    def find_by_name(self, name: str) -> dict | None:
        """Return a live sandbox with this exact name, or None.

        The control plane refuses duplicate names among non-terminal sandboxes,
        so a deterministic name IS a registry: it survives worker restarts and
        needs no state on our side.
        """
        data = unwrap(self._http.get("/v1/sandboxes", params={"limit": 500}))
        for row in data.get("data") or []:
            if isinstance(row, dict) and row.get("name") == name and row.get("status") in {"running", "paused"}:
                return row
        return None

    def get(self, sandbox_id: str) -> dict:
        """Fetch a sandbox record."""
        return unwrap(self._http.get(f"/v1/sandboxes/{sandbox_id}"))

    def destroy(self, sandbox_id: str) -> None:
        """Best-effort teardown. Never raises — callers use it in a finally."""
        try:
            self._http.delete(f"/v1/sandboxes/{sandbox_id}", timeout=CONTROL_TIMEOUT_SECONDS)
        except Exception:  # noqa: BLE001 - cleanup must not mask the real error
            from lfx.log.logger import logger

            logger.warning("Could not destroy CreateOS sandbox %s", sandbox_id, exc_info=True)

    def set_ingress(self, sandbox_id: str, *, enabled: bool) -> None:
        """Toggle the public HTTPS URL for a sandbox."""
        unwrap(self._http.patch(f"/v1/sandboxes/{sandbox_id}", json={"ingress_enabled": enabled}))

    # -- files and execution ----------------------------------------------

    def upload(self, sandbox_id: str, path: str, content: bytes) -> None:
        """Write bytes into the guest. Parent directories are created for us."""
        unwrap(
            self._http.put(
                f"/v1/sandboxes/{sandbox_id}/files",
                params={"path": path},
                content=content,
                headers={"Content-Type": "application/octet-stream"},
            )
        )

    def download(self, sandbox_id: str, path: str, *, max_bytes: int | None = None) -> bytes:
        """Read a file back out of the guest, refusing to buffer more than ``max_bytes``.

        The cap is enforced DURING the transfer, not after it. The guest chooses
        what it writes, so a buffered read would let guest code decide how much
        of the Langflow worker's memory one download costs — a cap applied after
        ``response.content`` has already materialised prevents nothing.

        Stops reading and raises as soon as the limit is passed, so an oversized
        archive costs one chunk over the budget rather than its full size.
        """
        with self._http.stream("GET", f"/v1/sandboxes/{sandbox_id}/files", params={"path": path}) as response:
            if response.status_code != httpx.codes.OK:
                response.read()
                msg = f"Could not read {path} from the sandbox ({response.status_code})"
                raise SandboxExecutionError(msg)

            # Trust the declared length only to fail EARLY; it is guest-adjacent
            # and may be absent or wrong, so the running total below is the
            # authoritative check.
            declared = response.headers.get("content-length")
            if max_bytes is not None and declared and declared.isdigit() and int(declared) > max_bytes:
                msg = f"Refusing to download {path}: {int(declared)} bytes exceeds the {max_bytes} byte limit"
                raise SandboxExecutionError(msg)

            chunks: list[bytes] = []
            total = 0
            for chunk in response.iter_bytes():
                total += len(chunk)
                if max_bytes is not None and total > max_bytes:
                    msg = f"Refusing to download {path}: exceeds the {max_bytes} byte limit"
                    raise SandboxExecutionError(msg)
                chunks.append(chunk)
        return b"".join(chunks)

    def exec(
        self,
        sandbox_id: str,
        cmd: str,
        args: list[str],
        *,
        timeout_seconds: int,
        grace_seconds: int = 15,
    ) -> dict:
        """Run one command to completion and return ``{stdout, stderr, exit_code}``.

        The HTTP budget is the guest wall clock plus a transport margin; the
        caller is expected to enforce the real limit inside the guest (with
        ``timeout(1)``) and to destroy the VM regardless, which is what actually
        stops runaway code.
        """
        response = self._http.post(
            f"/v1/sandboxes/{sandbox_id}/exec",
            json={"cmd": cmd, "args": args},
            timeout=httpx.Timeout(timeout_seconds + grace_seconds, connect=CONNECT_TIMEOUT_SECONDS),
        )
        data = unwrap(response)
        result = data.get("result")
        if not isinstance(result, dict):
            msg = f"CreateOS exec returned no result: {redact(repr(data))}"
            raise SandboxExecutionError(msg)
        return result
