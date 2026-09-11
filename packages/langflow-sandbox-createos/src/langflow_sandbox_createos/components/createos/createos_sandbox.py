"""The CreateOS Sandbox component: a microVM as a flow node.

Why this exists alongside the sandbox *backend* in this same package:

The ``lfx.sandbox_backends`` protocol was narrowed upstream to a stateless
``run(code, env) -> (stdout, stderr, exit_code)``. ``SessionKey`` and
``SandboxFile`` were removed from it, so a backend has nowhere to return a
reused guest or the files that guest wrote. A *component* has no such limit: it
declares its own inputs and outputs. So the two capabilities the protocol lost
come back here, without changing the protocol.

The backend and this component are complementary, not alternatives. The backend
silently hardens an existing flow's Python Interpreter node; this component is
for flows that want the sandbox itself — an arbitrary command, a guest that
survives between runs, files handed to the next node.
"""

from __future__ import annotations

import base64
import hashlib
import shlex
import uuid

from lfx.custom.custom_component.component import Component
from lfx.inputs.inputs import BoolInput, DropdownInput, IntInput, MultilineInput, StrInput
from lfx.schema.data import Data
from lfx.schema.dataframe import DataFrame
from lfx.template.field.base import Output
from lfx.utils.sandbox.base import SandboxExecutionError, SandboxUnavailableError

from langflow_sandbox_createos._client import SandboxClient, env

# Where guest code writes files it wants the flow to receive. A convention, not
# a mount: the guest may write anywhere, and only this directory is read back.
_ARTIFACT_DIR = "/workspace/artifacts"
_ARTIFACT_ARCHIVE = "/tmp/lf-artifacts.tar.gz"

# Total artifact bytes returned to the flow. Guest code chooses what it writes,
# so this is the cap that stops a runaway or hostile program pulling an
# unbounded payload into the Langflow process. Artifacts travel base64-encoded
# inside the component's output, so they are carried through the whole flow.
_MAX_ARTIFACT_BYTES = 5 * 1024 * 1024
_MAX_ARTIFACT_MEMBERS = 256

# Session guests are named so a human can find them in the CreateOS console,
# and so this component can find its own again on the next run.
_NAME_PREFIX = "lf-c-"
_NAME_HEX = 17

# Idle window for a guest this process fails to destroy. Must outlast one
# execution: the control plane touches the activity clock once, when /exec is
# accepted, so a quiet program looks idle and a short window would pause a
# healthy run.
_AUTO_PAUSE_FLOOR = 60
_AUTO_PAUSE_MARGIN = 120

# CreateOS egress is allowlist-only with no deny-all token: null, [] and ["*"]
# all mean allow-all. "No network" has to be spelled as a rule set that parses
# cleanly and matches nothing, so the host installs the chain and its default
# DROP applies to everything else. 240.0.0.0/4 is IANA-reserved and unroutable.
_DENY_ALL_EGRESS = ["240.0.0.0/4"]


class CreateOSSandboxComponent(Component):
    """Run a command or Python program inside a disposable Firecracker microVM."""

    display_name = "CreateOS Sandbox"
    description = "Run code or a shell command in an isolated microVM, and collect the files it writes."
    documentation = "https://github.com/NodeOps-app/createos-plugin"
    icon = "square-terminal"
    name = "CreateOSSandbox"

    inputs = [
        MultilineInput(
            name="python_code",
            display_name="Python Code",
            info=(
                "Python source to run in the sandbox. Ignored when Command is set. "
                "Write files to /workspace/artifacts to hand them to the next node."
            ),
            value="print('hello from a microVM')",
            input_types=["Message"],
            tool_mode=True,
        ),
        StrInput(
            name="command",
            display_name="Command",
            info=(
                "Run this shell command instead of the Python Code field — e.g. "
                "'pip install httpx && python3 -c \"import httpx; print(httpx.__version__)\"'."
            ),
            advanced=True,
        ),
        DropdownInput(
            name="session_mode",
            display_name="Guest Reuse",
            options=["off", "flow"],
            value="off",
            info=(
                "'off' gives every execution a fresh guest. 'flow' reuses one guest across "
                "executions of this component, so installed packages, files and state carry "
                "over — faster, but code from one run can read what an earlier run left behind."
            ),
        ),
        BoolInput(
            name="collect_artifacts",
            display_name="Return Files",
            value=False,
            info="Read /workspace/artifacts back after the run and emit it on the Files output.",
        ),
        BoolInput(
            name="allow_network",
            display_name="Allow Network",
            value=False,
            info=(
                "Off installs an unroutable egress allowlist, so the guest reaches nothing. "
                "On is UNRESTRICTED — CreateOS has no package-registry default, and hostname "
                "allowlists are not enforced by the platform."
            ),
        ),
        IntInput(
            name="timeout_seconds",
            display_name="Timeout (seconds)",
            value=60,
            range_spec=None,
            advanced=True,
            info="Wall clock the guest program gets, enforced inside the VM by timeout(1).",
        ),
        StrInput(
            name="shape",
            display_name="Shape",
            advanced=True,
            info="CreateOS shape id, e.g. s-2vcpu-4gb. Defaults to CREATEOS_SANDBOX_SHAPE, then s-2vcpu-4gb.",
        ),
    ]

    outputs = [
        Output(display_name="Results", name="results", method="run_sandbox"),
        Output(display_name="Files", name="files", method="collected_files", type_=DataFrame),
    ]

    # NOTE: no input may be named "code". Langflow reserves template["code"]
    # for a component's own source, so an input by that name is overwritten
    # with the snippet and the component fails to load.
    # Set by run_sandbox so the Files output does not create a second guest.
    _artifacts: list[Data] | None = None

    # -- helpers ----------------------------------------------------------

    def _shape(self) -> str:
        return self.shape or env("CREATEOS_SANDBOX_SHAPE", "s-2vcpu-4gb")

    def _egress(self) -> list[str]:
        # Mirrors the backend: only address-based rules are enforced by
        # CreateOS, so there are exactly two honest outcomes.
        return ["*"] if self.allow_network else list(_DENY_ALL_EGRESS)

    def _session_name(self) -> str:
        """The guest's name when reuse is on — deterministic, so it is the lookup key.

        Derived from the flow and the component id, so two components in one
        flow get separate guests and two flows never share one. The control
        plane caps a name at 22 characters and refuses duplicates among
        non-terminal sandboxes, which is exactly the registry semantics needed;
        keeping the mapping there rather than in this process means a restarted
        worker still finds its guest.

        Concurrency caveat, documented rather than defended: two workers running
        the same flow concurrently will adopt the SAME guest and share its
        filesystem. That is inherent to "reuse one machine", and it is why reuse
        is opt-in and off by default.
        """
        flow_id = getattr(getattr(self, "graph", None), "flow_id", None) or "noflow"
        # The egress policy is part of the identity, not just the flow and the
        # component. Without it, turning Allow Network off would adopt the guest
        # created while it was ON and run with the old, open policy — the
        # setting would appear to apply and silently do nothing. A changed
        # policy now simply addresses a different guest.
        policy = ",".join(self._egress())
        key = f"{flow_id}:{self._id}:{policy}"
        digest = hashlib.blake2s(key.encode(), digest_size=9).hexdigest()
        return f"{_NAME_PREFIX}{digest[:_NAME_HEX]}"

    def _policy_matches(self, record: dict) -> bool:
        """Does this live guest enforce exactly the egress this run asks for?

        Order-insensitive because the control plane is free to return the rules
        in any order; an absent or empty list means allow-all on the CreateOS
        side, which only matches a run that asked for allow-all.
        """
        live = record.get("egress") or ["*"]
        return sorted(str(rule) for rule in live) == sorted(self._egress())

    def _adopt_or_create(self, client: SandboxClient) -> tuple[str, bool]:
        """Return ``(sandbox_id, created)`` honouring the session mode.

        A reused guest is remembered on the component's vertex state rather than
        in a process-wide map: Langflow already scopes that per flow run chain,
        and a module-level cache would leak guests across flows and workers.
        """
        reuse = self.session_mode == "flow"
        name = self._session_name() if reuse else f"{_NAME_PREFIX}{uuid.uuid4().hex[:_NAME_HEX]}"
        auto_pause = max(_AUTO_PAUSE_FLOOR, int(self.timeout_seconds) + _AUTO_PAUSE_MARGIN)

        if reuse:
            existing = client.find_by_name(name)
            if existing and self._policy_matches(existing):
                self.log(f"Reusing guest {existing['id']} ({existing.get('status')})")
                return self._wake(client, existing), False
            if existing:
                # Belt to the name's braces: the name already encodes the policy,
                # so reaching here means the guest's egress drifted after
                # creation (changed through the API, say). Adopting it would
                # hand this run a network policy the operator did not ask for.
                msg = (
                    f"Refusing to reuse guest {existing['id']}: its egress is "
                    f"{existing.get('egress')!r} but this run requires {self._egress()!r}. "
                    "Destroy it, or turn Guest Reuse off."
                )
                raise SandboxUnavailableError(msg)

        try:
            created = client.create(
                shape=self._shape(),
                name=name,
                egress=self._egress(),
                auto_pause_seconds=auto_pause,
            )
        except SandboxUnavailableError:
            # A concurrent run of the same flow won the create; the control
            # plane refuses the duplicate name. Adopt the winner rather than
            # failing, which is the whole point of asking for reuse.
            if not reuse:
                raise
            existing = client.find_by_name(name)
            if not existing or not self._policy_matches(existing):
                raise
            return self._wake(client, existing), False
        return str(created["id"]), True

    def _wake(self, client: SandboxClient, record: dict) -> str:
        """Return an adopted guest's id, resuming it first if it idled out.

        Guests carry an auto-pause just above this component's own timeout, so
        any gap between two runs longer than that leaves the guest paused --
        which is the normal case for reuse, not an edge case. The control plane
        then rejects exec and file access with a 409, so the wake has to happen
        before the run, not be discovered by it.
        """
        sandbox_id = str(record["id"])
        if record.get("status") == "paused":
            self.log(f"Resuming paused guest {sandbox_id}")
            client.resume(sandbox_id)
        return sandbox_id

    def _guest_command(self, client: SandboxClient, sandbox_id: str) -> tuple[str, list[str]]:
        """Upload the program if needed and return the argv to run."""
        timeout = str(int(self.timeout_seconds))
        if self.command:
            inner = self.command
        else:
            path = f"/workspace/main_{uuid.uuid4().hex[:12]}.py"
            client.upload(sandbox_id, path, (self.python_code or "").encode())
            inner = f"python3 {shlex.quote(path)}"
        if self.collect_artifacts:
            # Create the directory before the program runs so guest code can
            # write into it without checking, and archive it afterwards. The
            # archive step never fails the run: an empty directory is normal.
            inner = (
                f"mkdir -p {_ARTIFACT_DIR}; {inner}; rc=$?; "
                f"tar -czf {_ARTIFACT_ARCHIVE} -C {_ARTIFACT_DIR} . 2>/dev/null || true; exit $rc"
            )
        return "timeout", ["--signal=KILL", timeout, "/bin/sh", "-c", inner]

    def _read_artifacts(self, client: SandboxClient, sandbox_id: str) -> list[Data]:
        """Pull /workspace/artifacts back as Data records, under a byte cap."""
        import io
        import tarfile

        try:
            # The transfer itself is capped, not just the extraction: the guest
            # decides how big this archive is.
            blob = client.download(sandbox_id, _ARTIFACT_ARCHIVE, max_bytes=_MAX_ARTIFACT_BYTES)
        except SandboxExecutionError:
            return []

        collected: list[Data] = []
        budget = _MAX_ARTIFACT_BYTES
        try:
            with tarfile.open(fileobj=io.BytesIO(blob), mode="r:gz") as archive:
                for member in archive:
                    if len(collected) >= _MAX_ARTIFACT_MEMBERS:
                        break
                    if not member.isfile() or member.size > budget:
                        continue
                    handle = archive.extractfile(member)
                    if handle is None:
                        continue
                    content = handle.read(budget)
                    budget -= len(content)
                    # Guest-controlled name: keep the basename only so nothing
                    # downstream can be pointed outside its own directory.
                    safe = member.name.lstrip("./").replace("..", "_")
                    try:
                        text = content.decode()
                        collected.append(Data(data={"path": safe, "text": text, "size": len(content)}))
                    except UnicodeDecodeError:
                        collected.append(
                            Data(
                                data={
                                    "path": safe,
                                    "base64": base64.b64encode(content).decode(),
                                    "size": len(content),
                                }
                            )
                        )
        except (tarfile.TarError, OSError):
            self.log("Could not read the artifact archive from the guest")
            return []
        return collected

    # -- outputs ----------------------------------------------------------

    def run_sandbox(self) -> Data:
        """Provision a guest, run the program, and return its outcome."""
        if not self.allow_network:
            # The host accepts link-local before the egress policy's final DROP,
            # so "no network" is not absolute. The backend surfaces this through
            # the same variable; keep the two consistent.
            accept = env("LANGFLOW_SANDBOX_CREATEOS_ACCEPT_EGRESS_EXCEPTIONS", "").lower()
            if accept not in {"1", "true", "yes", "on", "y", "t"}:
                msg = (
                    "Allow Network is off, but a CreateOS guest can always reach 169.254.0.0/16 "
                    "(link-local, carries the VM metadata service). Set "
                    "LANGFLOW_SANDBOX_CREATEOS_ACCEPT_EGRESS_EXCEPTIONS=true to accept that and run."
                )
                raise SandboxUnavailableError(msg)

        client = SandboxClient()
        sandbox_id: str | None = None
        created = False
        try:
            sandbox_id, created = self._adopt_or_create(client)
            cmd, args = self._guest_command(client, sandbox_id)
            result = client.exec(sandbox_id, cmd, args, timeout_seconds=int(self.timeout_seconds))
            exit_code = int(result.get("exit_code", 1))
            self._artifacts = self._read_artifacts(client, sandbox_id) if self.collect_artifacts else []
            payload = {
                "result": str(result.get("stdout", "")).strip(),
                "artifact_count": len(self._artifacts),
                "stderr": str(result.get("stderr", "")).strip(),
                "exit_code": exit_code,
                "sandbox_id": sandbox_id,
                "reused_guest": not created,
            }
            if exit_code == 124:
                payload["error"] = f"Timed out after {self.timeout_seconds}s"
            elif exit_code != 0:
                payload["error"] = payload["stderr"] or f"Exited with code {exit_code}"
            self.status = payload
        finally:
            # A session guest is deliberately left running for the next run; a
            # throwaway guest never outlives its execution.
            if sandbox_id and self.session_mode != "flow":
                client.destroy(sandbox_id)
            client.close()
        return Data(data=payload)

    def collected_files(self) -> DataFrame:
        """Files the guest wrote to /workspace/artifacts, one row each.

        Reads what ``run_sandbox`` already collected. Langflow may resolve
        outputs in either order, so this runs the execution itself if it has
        not happened yet rather than returning a misleading empty table.

        A DataFrame rather than ``list[Data]``: that is the shape Langflow
        renders as a table and passes to downstream loop/parse components.
        """
        if self._artifacts is None:
            self.run_sandbox()
        return DataFrame(data=self._artifacts or [])
