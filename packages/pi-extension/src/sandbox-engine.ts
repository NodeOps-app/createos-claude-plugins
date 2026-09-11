/**
 * sandbox-engine.ts — the `cos` driver's semantics, in TypeScript.
 *
 * CANONICAL COPY: packages/shared/sandbox-engine.ts. The copies under
 * packages/<plugin>/src/ are written by scripts/sync-shared.sh and CI fails on
 * drift — edit this file, then run the script.
 *
 * Why it exists: driving `createos sandbox create/push/exec/rm` directly looks
 * equivalent to an offload and is not. It drops egress restriction, the
 * keepalive that survives a dropped exec stream on a long build, guaranteed
 * auto-destroy, and the staging excludes that keep a 2 GB `.git` off the wire.
 * Ported from packages/claude-code-plugin/scripts/cos — keep the two in step.
 *
 * Self-contained on purpose: no harness imports, no dependencies, so the same
 * file drops into any TypeScript plugin.
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";

// ---------------------------------------------------------------------------
// Shared constants — mirrored from cos
// ---------------------------------------------------------------------------

/** Registries + CDNs a build of that ecosystem actually reaches. */
export const EGRESS_PRESETS: Record<string, string[]> = {
  "python-uv": ["astral.sh", "releases.astral.sh", "pypi.org", "files.pythonhosted.org"],
  "rust-cargo": [
    "crates.io",
    "static.crates.io",
    "index.crates.io",
    "static.rust-lang.org",
    "cdn.pyke.io",
  ],
  npm: ["registry.npmjs.org"],
  github: [
    "github.com",
    "objects.githubusercontent.com",
    "raw.githubusercontent.com",
    "codeload.github.com",
  ],
};

/** Never staged unless the caller asks: VCS metadata, build output, big media. */
export const DEFAULT_EXCLUDES = [
  ".git",
  "target",
  "node_modules",
  "__pycache__",
  ".venv",
  ".mypy_cache",
  ".pytest_cache",
  ".gradle",
  ".cargo/registry",
  "dist",
  "build",
  ".next",
  ".turbo",
  "*.gif",
  "*.mp4",
  "*.mov",
  "*.zst",
];

const CREATEOS_DIR = `${homedir()}/.createos`;
const REMOTE_RC = "/tmp/.cos-run.rc";
const REMOTE_PID = "/tmp/.cos-run.pid";
const REMOTE_LOG = "/tmp/.cos-run.log";

// ---------------------------------------------------------------------------
// Shell + CLI plumbing
// ---------------------------------------------------------------------------

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

function shq(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/**
 * Runs under bash with `pipefail`, matching the `cos` driver's `set -euo pipefail`.
 *
 * This is load-bearing, not tidiness. Both pipelines here put `createos` on one
 * side of a pipe and `tar` on the other, and GNU tar writes a well-formed EMPTY
 * archive when the path it was asked for is missing — so the receiving tar
 * succeeds, the default /bin/sh pipeline reports the exit status of that last
 * command only, and a failed artifact pull reads as a successful one. The box
 * holding the only copy of the output then gets destroyed. Verified against a
 * live sandbox: remote `tar -c no-such-dir` exits 2, receiving tar exits 0.
 */
export function execShell(cmd: string, timeoutMs = 120_000): ExecResult {
  try {
    const stdout = execSync(`set -o pipefail; ${cmd}`, {
      shell: "/bin/bash",
      encoding: "utf-8",
      timeout: timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { code: 0, stdout, stderr: "" };
  } catch (err: any) {
    return {
      code: err.status ?? 1,
      stdout: err.stdout?.toString() ?? "",
      stderr: err.stderr?.toString() ?? "",
    };
  }
}

function cliCmd(args: string[]): string {
  return ["createos", ...args.map((a) => (a === "--" ? "--" : shq(a)))].join(" ");
}

function cli(args: string[], timeoutMs?: number): ExecResult {
  return execShell(cliCmd(args), timeoutMs);
}

/**
 * `createos login` is an interactive TTY prompt that opens a browser, so an
 * agent shell cannot fix a missing session itself. Fail with the two options a
 * user can actually act on rather than with a raw CLI error.
 */
export function assertAuth(): void {
  if (cli(["-o", "json", "sandbox", "shapes"]).code === 0) return;
  throw new Error(
    "Not signed in to CreateOS. Ask the user to either run `createos login` in their own " +
      "terminal (browser OAuth), or export CREATEOS_API_KEY in the shell that launched the " +
      "agent. Never ask them to paste an API key into the conversation.",
  );
}

const CLI_INSTALL_URL =
  "https://raw.githubusercontent.com/NodeOps-app/createos-cli/main/install.sh";

/** Install the createos CLI if it is missing. Opt out with COS_NO_AUTOINSTALL=1. */
export function ensureCLI(): boolean {
  if (cli(["version"]).code === 0) return true;
  if (process.env.COS_NO_AUTOINSTALL) return false;
  execShell(`curl -sfL ${shq(CLI_INSTALL_URL)} | sh -`, 300_000);
  return cli(["version"]).code === 0;
}

// ---------------------------------------------------------------------------
// Box lifecycle
// ---------------------------------------------------------------------------

export interface SandboxRow {
  id: string;
  name?: string;
  status?: string;
  [key: string]: unknown;
}

function listBoxes(): SandboxRow[] {
  const res = cli(["-o", "json", "sandbox", "ls"]);
  if (res.code !== 0) return [];
  try {
    const parsed = JSON.parse(res.stdout);
    return Array.isArray(parsed) ? parsed : (parsed.data ?? []);
  } catch {
    return [];
  }
}

export function boxStatus(id: string): string | undefined {
  return listBoxes().find((b) => b.id === id)?.status;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Poll until the box reports `running` — a race guard before the first push. */
export async function waitRunning(id: string, timeoutSec = 30): Promise<boolean> {
  for (let i = 0; i < timeoutSec; i++) {
    if (boxStatus(id) === "running") return true;
    await sleep(1000);
  }
  return false;
}

export interface EgressOptions {
  /** Explicit domains to allow. */
  egress?: string[];
  /** Preset names from EGRESS_PRESETS; composes with `egress`. */
  egressPresets?: string[];
  /** Unrestricted egress — only for a trusted offload. */
  egressAll?: boolean;
}

export function egressArgs(opts: EgressOptions): { args: string[]; warning?: string } {
  if (opts.egressAll) return { args: [], warning: undefined };
  const domains = [
    ...(opts.egress ?? []),
    ...(opts.egressPresets ?? []).flatMap((p) => {
      const preset = EGRESS_PRESETS[p];
      if (!preset) {
        throw new Error(
          `Unknown egress preset '${p}' — have: ${Object.keys(EGRESS_PRESETS).join(", ")}`,
        );
      }
      return preset;
    }),
  ];
  if (domains.length === 0) {
    return {
      args: [],
      warning:
        "egress UNRESTRICTED — the box can reach any host. Restrict it with egressPresets or egress.",
    };
  }
  return { args: domains.flatMap((d) => ["--egress", d]) };
}

export interface CreateBoxOptions extends EgressOptions {
  name: string;
  shape?: string;
  rootfs?: string;
  network?: string;
  /** Idle auto-pause backstop so a forgotten box parks itself. */
  autoPause?: string;
}

export function createBox(opts: CreateBoxOptions): { id: string; warning?: string } {
  const shape = opts.shape ?? "s-1vcpu-1gb";
  const rootfs = opts.rootfs ?? "devbox:1";
  const { args: eArgs, warning } = egressArgs(opts);

  const args = [
    "sandbox",
    "create",
    "--name",
    opts.name,
    "--shape",
    shape,
    "--rootfs",
    rootfs,
    "--auto-pause",
    opts.autoPause ?? "30m",
    ...(opts.network ? ["--network", opts.network] : []),
    ...eArgs,
  ];

  const res = execShell(`NO_COLOR=1 TERM=dumb ${cliCmd(args)}`);
  if (res.code !== 0) {
    const err = `${res.stdout}\n${res.stderr}`;
    // The CLI names the allowed shapes in the rejection; surfacing that list is
    // the difference between a fixable error and "create failed".
    const choices = /choices: ?\[([^\]]*)\]/.exec(err);
    if (choices) {
      throw new Error(
        `Shape '${shape}' is not allowed on this plan. Allowed: ${choices[1]} ` +
          `(list them with \`createos sandbox shapes\`)`,
      );
    }
    throw new Error(`Sandbox create failed: ${err.trim().split("\n").slice(-3).join(" ")}`);
  }

  const id = listBoxes().find((b) => b.name === opts.name)?.id;
  if (!id) throw new Error(`Created box '${opts.name}' but could not resolve its id`);
  return { id, warning };
}

/**
 * Destroying a box is the one step whose failure is invisible: the offload has
 * already produced its answer, so a swallowed error here reads as success while
 * the box keeps running and billing. Report it instead of discarding it.
 */
export function destroyBox(id: string): { ok: boolean; error?: string } {
  const res = cli(["sandbox", "rm", "-y", id]);
  if (res.code === 0) return { ok: true };
  return { ok: false, error: (res.stderr || res.stdout).trim().split("\n").slice(-1)[0] };
}

// ---------------------------------------------------------------------------
// Staging
// ---------------------------------------------------------------------------

/**
 * tar the directory straight into the box. The stream is piped, so a large tree
 * never lands on disk twice, and the excludes are applied before the bytes are
 * sent rather than after.
 */
export function stage(id: string, dir: string, extraExcludes: string[] = []): void {
  const excludes = [...DEFAULT_EXCLUDES, ...extraExcludes]
    .map((p) => `--exclude ${shq(p)}`)
    .join(" ");
  const push = execShell(
    `tar ${excludes} -c -C ${shq(dir)} . | ${cliCmd(["sandbox", "push", id, "-", "/work.tar"])}`,
    600_000,
  );
  if (push.code !== 0) {
    throw new Error(`Staging ${dir} failed: ${(push.stderr || push.stdout).trim()}`);
  }
  const extract = cli([
    "sandbox",
    "exec",
    id,
    "--",
    "bash",
    "-lc",
    "mkdir -p /work && tar -C /work -xf /work.tar && rm -f /work.tar",
  ]);
  if (extract.code !== 0) {
    throw new Error(`Extracting the staged archive failed: ${extract.stderr.trim()}`);
  }
}

/**
 * `out` is interpolated into a remote shell command UNQUOTED, because that is
 * what makes globs like `dist/*` work — the same trade the `cos` driver makes.
 * The local shell is never exposed (the whole remote script is one quoted argv
 * element), and the caller supplying `out` also supplies `command`, so remote
 * execution is already theirs by design. This guard is therefore defence in
 * depth rather than a boundary: it keeps a future caller that fixes `command`
 * but forwards `out` from handing over the box's shell, and it turns a path
 * with a space or a stray metacharacter into a clear error instead of a
 * baffling tar failure.
 */
const SAFE_OUT_PATH = /^[A-Za-z0-9._/*?[\]-]+$/;

export function assertSafeOutPath(out: string): void {
  if (!SAFE_OUT_PATH.test(out)) {
    throw new Error(
      `Refusing to pull '${out}': an artifact path may contain only letters, digits, ` +
        `. _ - / and the glob characters * ? [ ].`,
    );
  }
  if (out.startsWith("/") || out.split("/").includes("..")) {
    throw new Error(`Refusing to pull '${out}': the path must stay inside /work.`);
  }
}

/** Pull a path under /work back into the local directory. */
export function pullArtifacts(id: string, dir: string, out: string): boolean {
  assertSafeOutPath(out);
  // Probe first: pipefail catches the remote tar's failure, but an explicit
  // existence check is what makes the warning's "does /work/<out> exist?"
  // actually true, and it costs one exec.
  const probe = cli(["sandbox", "exec", id, "--", "bash", "-lc", `ls -d /work/${out}`]);
  if (probe.code !== 0) return false;
  const res = execShell(
    `${cliCmd(["sandbox", "exec", id, "--", "bash", "-lc", `cd /work && tar -c ${out}`])} | tar -x -C ${shq(dir)}`,
    600_000,
  );
  return res.code === 0;
}

// ---------------------------------------------------------------------------
// Keepalive exec
// ---------------------------------------------------------------------------

export interface KeepaliveResult {
  /** Real exit code of the command, or undefined when the box never reported one. */
  exitCode?: number;
  log: string;
  /** The command's process vanished without writing an exit code. */
  infraFailure: boolean;
}

/**
 * Run a command in the box so that it survives the exec stream dying.
 *
 * The command is detached under nohup and writes its exit code to a file; this
 * side only polls for that file. A dropped connection mid-build therefore costs
 * one poll, not the build — which is the entire reason offload does not just
 * call `createos sandbox exec` and read the pipe.
 */
export async function runKeepalive(
  id: string,
  command: string,
  workdir = "/work",
  opts: { pollMs?: number; timeoutMs?: number } = {},
): Promise<KeepaliveResult> {
  const pollMs = opts.pollMs ?? 5_000;
  const deadline = Date.now() + (opts.timeoutMs ?? 6 * 60 * 60 * 1000);
  const b64 = Buffer.from(command, "utf-8").toString("base64");

  const runner =
    `CMD=$(printf %s "$1" | base64 -d); cd "\${2:-$HOME}" 2>/dev/null || cd /; ` +
    `rm -f ${REMOTE_RC} ${REMOTE_PID}; ` +
    `nohup bash -c 'bash -lc "$0"; echo $? > ${REMOTE_RC}' "$CMD" > ${REMOTE_LOG} 2>&1 </dev/null & ` +
    `echo $! > ${REMOTE_PID}`;

  const started = cli(["sandbox", "exec", id, "--", "bash", "-lc", runner, "_", b64, workdir]);
  if (started.code !== 0) {
    throw new Error(`Failed to start the remote command: ${started.stderr.trim()}`);
  }

  while (Date.now() < deadline) {
    await sleep(pollMs);
    const rc = cli(["sandbox", "exec", id, "--", "bash", "-c", `cat ${REMOTE_RC} 2>/dev/null`]);
    const parsed = rc.stdout.replace(/\D/g, "").slice(0, 4);
    if (rc.code === 0 && parsed !== "") {
      return { exitCode: Number(parsed), log: tailLog(id), infraFailure: false };
    }
    const alive = cli([
      "sandbox",
      "exec",
      id,
      "--",
      "bash",
      "-lc",
      `p=$(cat ${REMOTE_PID} 2>/dev/null); { [ -n "$p" ] && kill -0 "$p" 2>/dev/null && echo ALIVE; } || echo DEAD`,
    ]);
    // A failed poll is not a dead build — the CLI call itself can drop. Only a
    // definite DEAD with no exit code means the process is gone.
    if (alive.code === 0 && alive.stdout.includes("DEAD")) {
      return { exitCode: undefined, log: tailLog(id), infraFailure: true };
    }
  }
  return { exitCode: undefined, log: tailLog(id), infraFailure: true };
}

function tailLog(id: string, lines = 200): string {
  const res = cli(["sandbox", "exec", id, "--", "bash", "-c", `tail -n ${lines} ${REMOTE_LOG}`]);
  return res.stdout.trimEnd();
}

// ---------------------------------------------------------------------------
// One-shot offload
// ---------------------------------------------------------------------------

export interface OffloadOptions extends EgressOptions {
  /** Local directory staged to /work in the box. */
  dir: string;
  command: string;
  shape?: string;
  rootfs?: string;
  /** Extra upload excludes on top of DEFAULT_EXCLUDES. */
  exclude?: string[];
  /** Path under /work to pull back into `dir` when the command finishes. */
  out?: string;
  /** GB of swap to add before running — OOM headroom for compiled builds. */
  swapGB?: number;
  /** Keep the box when the command exits non-zero, for debugging. */
  keepOnFail?: boolean;
  timeoutMs?: number;
}

export interface OffloadResult {
  sandboxId: string;
  exitCode?: number;
  log: string;
  /** The box was deliberately left running; the caller must say so. */
  kept: boolean;
  warnings: string[];
  pulledArtifacts?: boolean;
}

export interface RetentionState {
  sandboxId: string;
  /** The command's process vanished without writing an exit code. */
  infraFailure: boolean;
  exitCode?: number;
  keepOnFail?: boolean;
  /** An `out` was requested and the download did not succeed. */
  artifactPullFailed?: boolean;
  out?: string;
  dir?: string;
}

/**
 * Every reason the box must outlive the offload, as caller-facing text. An
 * empty list means it is safe to destroy — that is the ONLY thing that
 * authorises deletion.
 *
 * This is a pure function because it is the decision that loses data when it is
 * wrong: a box torn down after a failed download takes the only complete copy
 * of the build output with it, and no error is raised at the time.
 */
export function retentionReasons(state: RetentionState): string[] {
  const reasons: string[] = [];

  if (state.infraFailure) {
    reasons.push(
      `infra/stream failure — box ${state.sandboxId} kept so the build cache survives. ` +
        `Reconnect: createos sandbox exec --stream ${state.sandboxId} -- bash -lc 'tail -f ${REMOTE_LOG}'. ` +
        `Destroy: createos sandbox rm -y ${state.sandboxId}`,
    );
  } else if (state.exitCode !== 0 && state.keepOnFail) {
    reasons.push(
      `command exited ${state.exitCode} — box ${state.sandboxId} kept. ` +
        `Destroy: createos sandbox rm -y ${state.sandboxId}`,
    );
  }

  // Deliberately not an `else`: the output is still on the box whatever the
  // exit code was, and destroying it is unrecoverable.
  if (state.artifactPullFailed) {
    const out = state.out ?? "the requested path";
    reasons.push(
      `pull of '${out}' FAILED — artifacts were NOT retrieved, so box ${state.sandboxId} is KEPT ` +
        `rather than destroyed with the only copy on it. Check that /work/${out} exists, then retry: ` +
        `createos sandbox exec ${state.sandboxId} -- bash -lc 'cd /work && tar -c ${out}' | tar -x -C ${state.dir ?? "."}. ` +
        `Destroy when you have what you need: createos sandbox rm -y ${state.sandboxId}`,
    );
  }

  return reasons;
}

/**
 * A teardown that fails leaves the box running and billing, so it must reach
 * the caller as loudly as a retained box does — `kept` becomes true because the
 * box really is still there, whatever the caller asked for.
 */
export function cleanupFailureNote(sandboxId: string, error?: string): string {
  return (
    `cleanup FAILED — sandbox ${sandboxId} is STILL ALLOCATED and still costing. ` +
    `Destroy it by hand: createos sandbox rm -y ${sandboxId}` +
    (error ? ` (${error})` : "")
  );
}

/**
 * Stage → run (keepalive) → pull → destroy, in one call.
 *
 * The box is torn down on every path, including a throw — but only when
 * retentionReasons() says nothing needs it: an infra failure keeps the build
 * cache, `keepOnFail` keeps a failed run for debugging, and a failed artifact
 * pull keeps the only copy of the output. A teardown that itself fails is
 * reported rather than swallowed, since the box goes on billing either way.
 */
export async function offload(opts: OffloadOptions): Promise<OffloadResult> {
  assertAuth();
  const warnings: string[] = [];
  const shape = opts.shape ?? "s-1vcpu-1gb";

  // A compiled build on a 1 GB box dies with OOM or ENOSPC halfway through,
  // which reads as a code failure rather than an undersized box.
  const heavy = /cargo|maturin|torch|pip install|uv sync|uv run|pyo3/.test(opts.command);
  if (heavy && /256mb|512mb|-1gb/.test(shape) && !opts.swapGB) {
    warnings.push(
      `heavy build on a small box (${shape}) — risk of OOM/ENOSPC. Try shape 's-2vcpu-2gb' or swapGB: 4.`,
    );
  }

  const name = `cos-o-${process.pid}-${Math.floor(Math.random() * 32768)}`;
  const { id, warning } = createBox({ ...opts, name, shape });
  if (warning) warnings.push(warning);

  let kept = false;
  let result: OffloadResult | undefined;
  let thrown: unknown;

  try {
    if (!(await waitRunning(id))) throw new Error(`Box ${id} was not running after 30s`);
    stage(id, opts.dir, opts.exclude);
    if (opts.swapGB) setupSwap(id, opts.swapGB);

    const run = await runKeepalive(id, opts.command, "/work", { timeoutMs: opts.timeoutMs });

    let pulledArtifacts: boolean | undefined;
    if (opts.out) pulledArtifacts = pullArtifacts(id, opts.dir, opts.out);

    const reasons = retentionReasons({
      sandboxId: id,
      infraFailure: run.infraFailure,
      exitCode: run.exitCode,
      keepOnFail: opts.keepOnFail,
      artifactPullFailed: pulledArtifacts === false,
      out: opts.out,
      dir: opts.dir,
    });
    kept = reasons.length > 0;
    warnings.push(...reasons);

    result = {
      sandboxId: id,
      exitCode: run.exitCode,
      log: run.log,
      kept,
      warnings,
      pulledArtifacts,
    };
  } catch (error) {
    thrown = error;
  }

  // Not in `finally`: a failed teardown has to reach the caller, and swallowing
  // it there is exactly how a box keeps billing while the result says destroyed.
  if (!kept) {
    const destroyed = destroyBox(id);
    if (!destroyed.ok) {
      const note = cleanupFailureNote(id, destroyed.error);
      if (result) {
        result.kept = true;
        result.warnings.push(note);
      } else {
        thrown = new Error(
          `${thrown instanceof Error ? thrown.message : String(thrown)} — ${note}`,
        );
      }
    }
  }

  if (thrown) throw thrown;
  return result as OffloadResult;
}

function setupSwap(id: string, gb: number): void {
  if (!Number.isInteger(gb) || gb < 1 || gb > 64) {
    throw new Error(`swapGB must be a whole number of GB between 1 and 64, got ${gb}`);
  }
  cli([
    "sandbox",
    "exec",
    id,
    "--",
    "bash",
    "-lc",
    `swapon --show 2>/dev/null | grep -q /cos.swap && exit 0; ` +
      `( fallocate -l ${gb}G /cos.swap 2>/dev/null || dd if=/dev/zero of=/cos.swap bs=1M count=$(( ${gb}*1024 )) status=none 2>/dev/null ) ` +
      `&& chmod 600 /cos.swap && mkswap /cos.swap >/dev/null 2>&1 && swapon /cos.swap 2>/dev/null || true`,
  ]);
}

// ---------------------------------------------------------------------------
// Fanout
// ---------------------------------------------------------------------------

export interface FanoutOptions extends Omit<OffloadOptions, "command"> {
  commands: string[];
  /** Max boxes running at once. External keys have been observed to allow 2. */
  jobs?: number;
}

export interface FanoutResult extends OffloadResult {
  command: string;
}

/**
 * Run each command in its own throwaway box, `jobs` at a time.
 *
 * Concurrency is capped rather than unbounded because the control plane limits
 * how many boxes an account may run at once — an unbounded fan-out just
 * converts that limit into a pile of create failures.
 */
export async function fanout(opts: FanoutOptions): Promise<FanoutResult[]> {
  const jobs = Math.max(1, opts.jobs ?? 2);
  const queue = opts.commands.map((command, index) => ({ command, index }));
  const results: FanoutResult[] = Array.from({ length: opts.commands.length });

  async function worker(): Promise<void> {
    for (;;) {
      const item = queue.shift();
      if (!item) return;
      try {
        const res = await offload({ ...opts, command: item.command });
        results[item.index] = { ...res, command: item.command };
      } catch (err: any) {
        results[item.index] = {
          command: item.command,
          sandboxId: "",
          exitCode: undefined,
          log: String(err?.message ?? err),
          kept: false,
          warnings: ["offload threw before the command ran"],
        };
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(jobs, queue.length) }, worker));
  return results;
}

// ---------------------------------------------------------------------------
// Desktop / computer use
// ---------------------------------------------------------------------------

/**
 * `createos` has no computer or desktop command, so this is the only place the
 * engine talks to the REST API directly. When the CLI grows a `sandbox
 * computer` group, delete apiAuth()/api() and shell out like everything else.
 */
function apiBase(): string {
  return process.env.CREATEOS_SANDBOX_URL ?? "https://api.sb.createos.sh";
}

/**
 * Auth precedence MUST match the CLI's: an OAuth session wins, an api key is
 * the fallback. Inverting it authenticates these calls as a different identity
 * than every CLI-driven verb, and the symptom is a 404 on a box this process
 * just created — which reads like a missing box, not an auth mismatch.
 *
 * fc rejects `Bearer` on user-facing routes and rejects a JWT sent under
 * X-Api-Key, so the two headers are not interchangeable.
 */
function apiAuth(): Record<string, string> {
  const oauthPath = `${CREATEOS_DIR}/.oauth`;
  if (existsSync(oauthPath)) {
    try {
      const oauth = JSON.parse(readFileSync(oauthPath, "utf-8"));
      const expiresAt = Number(oauth.expires_at ?? 0);
      // No refresh implementation here on purpose: the CLI refreshes in its own
      // pre-flight and rewrites ~/.createos/.oauth, so poke it and re-read
      // rather than carrying a second, subtly different refresh.
      if (Date.now() / 1000 >= expiresAt - 60) {
        cli(["-o", "json", "sandbox", "ls"]);
      }
      const token = JSON.parse(readFileSync(oauthPath, "utf-8")).access_token;
      if (token) return { "X-Access-Token": token };
    } catch {
      // fall through to key-based auth
    }
  }
  if (process.env.CREATEOS_API_KEY) return { "X-Api-Key": process.env.CREATEOS_API_KEY };
  const tokenPath = `${CREATEOS_DIR}/.token`;
  if (existsSync(tokenPath)) {
    return { "X-Api-Key": readFileSync(tokenPath, "utf-8").trim() };
  }
  throw new Error("Not signed in — run `createos login` or export CREATEOS_API_KEY");
}

/**
 * Map the computer API's codes onto something actionable. Worth doing by hand:
 * `desktop_unavailable` is fc's catch-all for every X failure, so the raw
 * message never says whether the desktop is still booting or the action failed
 * on a live desktop.
 */
function apiError(status: number, body: string, what: string): Error {
  let message = "";
  try {
    const parsed = JSON.parse(body);
    message = parsed.message ?? parsed.error ?? "";
  } catch {
    /* body was not JSON */
  }
  switch (status) {
    case 401:
    case 403:
      return new Error(
        `Auth rejected (HTTP ${status}). The API key or browser session is invalid or expired — ` +
          `ask the user to re-run \`createos login\`, or export CREATEOS_API_KEY.`,
      );
    case 404:
      return new Error(
        `Not found (HTTP 404): ${message || what}. Either the box is gone, or it has no such ` +
          `screen — computer-use needs a desktop image (start one with the desktop tool).`,
      );
    case 409:
      return new Error(
        `The desktop did not answer (HTTP 409 ${message || "desktop_unavailable"}). fc returns ` +
          `this both while the desktop is still booting AND when an action fails on a live ` +
          `desktop, so do not read it as "the box is broken" — bring the desktop up first.`,
      );
    case 429:
      return new Error("Rate limited (429) — the control plane caps concurrent screenshots.");
    case 501:
      return new Error(
        "501 desktop_tools_unavailable — this rootfs has no desktop tools. Recreate the box on the desktop image.",
      );
    default:
      return new Error(`API error HTTP ${status} on ${what}${message ? `: ${message}` : ""}`);
  }
}

async function api(method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(`${apiBase()}${path}`, {
    method,
    headers: {
      ...apiAuth(),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw apiError(res.status, text, `${method} ${path}`);
  try {
    const parsed = JSON.parse(text);
    return parsed.data ?? parsed;
  } catch {
    return text;
  }
}

/**
 * The desktop stack (Xvfb → XFCE → x11vnc → websockify) starts AFTER the box
 * reports `running`, so every computer call 404s or 409s for the first while.
 * Neither fc nor the SDK polls for this, so every caller has to.
 */
export async function desktopWait(
  id: string,
  screen = "screen-0",
  timeoutSec = 120,
): Promise<void> {
  const deadline = Date.now() + timeoutSec * 1000;
  while (Date.now() < deadline) {
    const res = await fetch(
      `${apiBase()}/v1/sandboxes/${encodeURIComponent(id)}/computer/screen?screen_id=${encodeURIComponent(screen)}`,
      {
        headers: apiAuth(),
      },
    );
    if (res.ok) return;
    if ([401, 403, 501].includes(res.status)) {
      throw apiError(res.status, await res.text(), "desktop readiness");
    }
    await sleep(2000);
  }
  throw new Error(`The desktop did not come up within ${timeoutSec}s on ${id} (${screen})`);
}

/** Mint a live noVNC URL for a screen. Requires ingress to be on. */
export async function desktopConnect(
  id: string,
  screen = "screen-0",
): Promise<{ url: string; expiresAt: string }> {
  const enabled = cli(["sandbox", "edit", id, "--ingress", "on"]);
  if (enabled.code !== 0) throw new Error(`Failed to enable ingress on ${id}`);
  await desktopWait(id, screen);
  const conn = await api(
    "GET",
    `/v1/sandboxes/${encodeURIComponent(id)}/computer/screens/${encodeURIComponent(screen)}/connect`,
  );
  if (!conn?.url) {
    throw new Error(`connect returned no URL — fc only mints one when ingress is enabled on ${id}`);
  }
  return { url: conn.url, expiresAt: conn.expires_at ?? "unknown" };
}

export type ComputerOp =
  | { op: "screen" }
  | { op: "cursor" }
  | { op: "windows" }
  | { op: "move"; x: number; y: number }
  | { op: "click"; x?: number; y?: number }
  | { op: "type"; text: string }
  | { op: "key"; keys: string[] }
  | { op: "open"; target: string };

/** Send one computer-use action to the desktop in a box. */
export async function computer(id: string, action: ComputerOp, screen = "screen-0"): Promise<any> {
  const base = `/v1/sandboxes/${encodeURIComponent(id)}/computer`;
  const q = `screen_id=${encodeURIComponent(screen)}`;
  switch (action.op) {
    case "screen":
      return api("GET", `${base}/screen?${q}`);
    case "cursor":
      return api("GET", `${base}/cursor?${q}`);
    case "windows":
      return api("GET", `${base}/windows?${q}`);
    case "move":
      return api("POST", `${base}/mouse/move?${q}`, { x: action.x, y: action.y });
    case "click":
      return api(
        "POST",
        `${base}/mouse/click?${q}`,
        action.x === undefined ? {} : { x: action.x, y: action.y },
      );
    case "type":
      return api("POST", `${base}/keyboard/type?${q}`, { text: action.text });
    case "key":
      return api("POST", `${base}/keyboard/press?${q}`, { keys: action.keys });
    case "open":
      return api("POST", `${base}/open?${q}`, { target: action.target });
  }
}

/** Capture a screenshot to a local path. Returns that path. */
export async function screenshot(
  id: string,
  outPath: string,
  screen = "screen-0",
): Promise<string> {
  const res = await fetch(
    `${apiBase()}/v1/sandboxes/${encodeURIComponent(id)}/computer/screenshot?screen_id=${encodeURIComponent(screen)}`,
    {
      headers: apiAuth(),
    },
  );
  if (!res.ok) throw apiError(res.status, await res.text(), "screenshot");
  writeFileSync(outPath, Buffer.from(await res.arrayBuffer()));
  return outPath;
}
