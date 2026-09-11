/**
 * Tool registration — CLI-only edition.
 *
 * Each of Pi's built-in tools is replaced with a sandbox-backed variant.
 * Each CreateOS capability is a focused, single-purpose tool following
 * Pi extension best practices (snake_case, named promptGuidelines).
 */

import { tmpdir } from "node:os";
import { isAbsolute } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createBashTool,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import * as cli from "./cli.ts";
import * as engine from "./sandbox-engine.ts";
import { type FindParams, runRemoteFind } from "./find-tool.ts";
import { fanoutScenarios, type FanoutScenario } from "./fanout.ts";
import { validateLocalSyncSource } from "./startup-sync.ts";
import { type GrepParams, runRemoteGrep } from "./grep-tool.ts";
import { createBashOps, createEditOps, createLsOps, createReadOps, createWriteOps } from "./ops.ts";
import { shortId } from "./util.ts";

export interface ToolSandbox {
  sandboxId: string;
  cwd: string;
}

interface ComputerActionParams {
  op: string;
  x?: number;
  y?: number;
  text?: string;
  keys?: string[];
  target?: string;
}

export function computerAction(params: ComputerActionParams): engine.ComputerOp {
  switch (params.op) {
    case "screen":
    case "cursor":
    case "windows":
      return { op: params.op };
    case "move":
      if (params.x === undefined || params.y === undefined) throw new Error("move needs x and y");
      return { op: "move", x: params.x, y: params.y };
    case "click":
      if ((params.x === undefined) !== (params.y === undefined))
        throw new Error("click needs both x and y, or neither");
      return { op: "click", x: params.x, y: params.y };
    case "type":
      if (params.text === undefined) throw new Error("type needs text");
      return { op: "type", text: params.text };
    case "key":
      if (!params.keys?.length) throw new Error("key needs a non-empty keys array");
      return { op: "key", keys: params.keys };
    case "open":
      if (!params.target) throw new Error("open needs a target");
      return { op: "open", target: params.target };
    default:
      throw new Error(`unknown desktop operation: ${params.op}`);
  }
}

export function registerTools(pi: ExtensionAPI, getActive: () => ToolSandbox | null): void {
  const localCwd = process.cwd();
  const localBash = createBashTool(localCwd);
  const localRead = createReadTool(localCwd);
  const localWrite = createWriteTool(localCwd);
  const localEdit = createEditTool(localCwd);
  const localLs = createLsTool(localCwd);
  const localFind = createFindTool(localCwd);
  const localGrep = createGrepTool(localCwd);

  function requireSandbox(): ToolSandbox | null {
    const active = getActive();
    if (active) return active;
    if (pi.getFlag("inside-createos-sandbox") === true) {
      throw new Error(
        "CreateOS sandbox is unavailable — the tool was NOT run on your host. Restart Pi.",
      );
    }
    return null;
  }

  function sandboxTool<T extends { execute: (...args: never[]) => unknown }>(
    local: T,
    makeRemote: (s: ToolSandbox) => T,
  ): T {
    return {
      ...local,
      execute: (...args: Parameters<T["execute"]>) => {
        const active = requireSandbox();
        const tool = active ? makeRemote(active) : local;
        return tool.execute(...args);
      },
    } as T;
  }

  // --- Built-in tool replacements (bash, read, write, edit, ls, find, grep) ---

  pi.registerTool(
    sandboxTool(localBash, (s) =>
      createBashTool(s.cwd, { operations: createBashOps(pi, s.sandboxId) }),
    ),
  );
  pi.registerTool(
    sandboxTool(localRead, (s) =>
      createReadTool(s.cwd, { operations: createReadOps(pi, s.sandboxId) }),
    ),
  );
  pi.registerTool(
    sandboxTool(localWrite, (s) =>
      createWriteTool(s.cwd, { operations: createWriteOps(pi, s.sandboxId) }),
    ),
  );
  pi.registerTool(
    sandboxTool(localEdit, (s) =>
      createEditTool(s.cwd, { operations: createEditOps(pi, s.sandboxId) }),
    ),
  );
  pi.registerTool(
    sandboxTool(localLs, (s) => createLsTool(s.cwd, { operations: createLsOps(pi, s.sandboxId) })),
  );

  pi.registerTool({
    ...localFind,
    async execute(id, params, signal, onUpdate) {
      const active = requireSandbox();
      if (active) {
        if (signal?.aborted) throw new Error("aborted");
        return runRemoteFind(pi, active.sandboxId, active.cwd, params as FindParams);
      }
      return localFind.execute(id, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...localGrep,
    async execute(id, params, signal, onUpdate) {
      const active = requireSandbox();
      if (active) {
        if (signal?.aborted) throw new Error("aborted");
        return runRemoteGrep(pi, active.sandboxId, active.cwd, params as GrepParams);
      }
      return localGrep.execute(id, params, signal, onUpdate);
    },
  });

  // --- Scenario fan-out ---

  pi.registerTool({
    name: "sandbox_fanout",
    label: "Fan Out Scenarios",
    description:
      "Run named test or deployment scenarios in independent sandboxes. Each receives the local project source " +
      "without reimplementing it; public-service scenarios return verified HTTPS URLs.",
    promptSnippet: "Run multiple isolated project scenarios in parallel",
    promptGuidelines: [
      "Use sandbox_fanout for scenario-based testing, multiple configurations, or independent deployment variants.",
      "Each scenario copies the project source while honoring .gitignore; never recreate or simplify the application in shell commands.",
      "Use a scenario without port for a foreground test command. Set port for a server command; the tool starts it in tmux and returns only health-checked URLs.",
    ],
    parameters: Type.Object({
      scenarios: Type.Array(
        Type.Object({
          name: Type.String({ description: "Unique scenario name, used in the sandbox name" }),
          command: Type.String({ description: "Command to run from the copied project directory" }),
          environment: Type.Optional(
            Type.Array(
              Type.Object({
                name: Type.String({ description: "Environment variable name" }),
                value: Type.String({ description: "Environment variable value" }),
              }),
            ),
          ),
          port: Type.Optional(
            Type.Integer({
              minimum: 1,
              maximum: 65535,
              description: "Server port; omit for a foreground test",
            }),
          ),
          health_check_path: Type.Optional(
            Type.String({ description: "HTTP path to check (default: /)" }),
          ),
          health_check_contains: Type.Optional(
            Type.String({ description: "Expected text in a successful health response" }),
          ),
        }),
        { minItems: 1, maxItems: 25, description: "Independent scenarios to run" },
      ),
      source_dir: Type.Optional(
        Type.String({
          description: "Absolute local project directory (default: current directory)",
        }),
      ),
      name_prefix: Type.Optional(
        Type.String({ description: "Sandbox name prefix (default: scenario)" }),
      ),
      shape: Type.Optional(Type.String({ description: "Sandbox size (default: s-2vcpu-2gb)" })),
      rootfs: Type.Optional(Type.String({ description: "Base image or template" })),
    }),
    async execute(_id, params, signal) {
      const sourceDir = params.source_dir ?? localCwd;
      if (!isAbsolute(sourceDir)) throw new Error("source_dir must be an absolute path");
      const scenarios: FanoutScenario[] = params.scenarios.map((scenario) => ({
        name: scenario.name,
        command: scenario.command,
        environment: scenario.environment ?? [],
        port: scenario.port,
        healthCheckPath: scenario.health_check_path,
        healthCheckContains: scenario.health_check_contains,
      }));
      for (const scenario of scenarios) {
        for (const variable of scenario.environment) {
          if (!/^[A-Z_][A-Z0-9_]*$/.test(variable.name)) {
            throw new Error(`Invalid environment variable name: ${variable.name}`);
          }
        }
      }

      const results = await fanoutScenarios(
        pi,
        {
          sourceDir,
          namePrefix: params.name_prefix ?? "scenario",
          scenarios,
          shape: params.shape,
          rootfs: params.rootfs,
        },
        signal,
      );
      const lines = results.map((result) => {
        if (result.verified && result.url) return `✓ ${result.name} · ${result.url}`;
        if (result.verified) return `✓ ${result.name} · ${result.output ?? "passed"}`;
        return `✗ ${result.name} · ${result.error ?? "failed"}`;
      });
      return { content: [{ type: "text", text: lines.join("\n") }], details: { results } };
    },
  });

  // --- One-shot offload ---

  pi.registerTool({
    name: "sandbox_offload",
    label: "Offload To Throwaway Sandbox",
    description:
      "Run a command in a throwaway sandbox and destroy it: stage a local directory to /work, run the command " +
      "with a keepalive that survives a dropped stream, optionally pull artifacts back, then destroy the box. " +
      "The upload excludes .git, node_modules, target, virtualenvs and large media.",
    promptSnippet: "Run a build or test suite off this machine in a disposable sandbox",
    promptGuidelines: [
      "Prefer sandbox_offload over sandbox_create + sandbox_exec for anything that finishes on its own. Hand-rolling that sequence drops egress restriction, the keepalive, and the guaranteed destroy, so a 'successful' run can leave an unrestricted box billing.",
      "Set sandbox_offload's egress_presets to what the build actually fetches (python-uv, rust-cargo, npm, github). With nothing set the box can reach any host, which is the isolation this tool exists for.",
      "Give sandbox_offload shape s-2vcpu-2gb or swap_gb for compiled builds (cargo, torch, pip install); the default 1 GB box dies with OOM partway through and reads like a code failure.",
    ],
    parameters: Type.Object({
      command: Type.String({
        description: "Shell command to run, with /work as the working directory",
      }),
      dir: Type.Optional(
        Type.String({
          description: "Absolute local directory to stage (default: current directory)",
        }),
      ),
      shape: Type.Optional(Type.String({ description: "Sandbox size (default: s-1vcpu-1gb)" })),
      rootfs: Type.Optional(Type.String({ description: "Base image (default: devbox:1)" })),
      egress_presets: Type.Optional(
        Type.Array(Type.String(), {
          description:
            "Allow only what these ecosystems need: python-uv | rust-cargo | npm | github",
        }),
      ),
      egress: Type.Optional(
        Type.Array(Type.String(), {
          description: "Extra allowed domains; composes with egress_presets",
        }),
      ),
      egress_all: Type.Optional(
        Type.Boolean({ description: "Unrestricted egress — trusted code only" }),
      ),
      exclude: Type.Optional(Type.Array(Type.String(), { description: "Extra upload excludes" })),
      out: Type.Optional(
        Type.String({
          description: "Path under /work to pull back into dir when the command finishes",
        }),
      ),
      swap_gb: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: 64,
          description: "Swap to add before running — OOM headroom",
        }),
      ),
      keep_on_fail: Type.Optional(
        Type.Boolean({
          description: "Keep the box when the command exits non-zero, for debugging",
        }),
      ),
    }),
    async execute(_id, params) {
      const dir = params.dir ?? localCwd;
      if (!isAbsolute(dir)) throw new Error("dir must be an absolute path");
      const result = await engine.offload({
        dir,
        command: params.command,
        shape: params.shape,
        rootfs: params.rootfs,
        egress: params.egress,
        egressPresets: params.egress_presets,
        egressAll: params.egress_all,
        exclude: params.exclude,
        out: params.out,
        swapGB: params.swap_gb,
        keepOnFail: params.keep_on_fail,
      });
      const header = `sandbox ${result.sandboxId} — exit code ${result.exitCode ?? "unknown"}${
        result.kept ? " (box KEPT)" : " (box destroyed)"
      }`;
      const warnings = result.warnings.map((warning) => `warning: ${warning}`);
      const text = [header, ...warnings, "", result.log || "(no output)"].join("\n");
      return { content: [{ type: "text", text }], details: { result } };
    },
  });

  // --- Desktop / computer use ---

  function desktopTarget(params: { sandbox_id?: string; screen?: string }): {
    sandboxId: string;
    screen?: string;
  } {
    const sandboxId = params.sandbox_id ?? requireSandbox()?.sandboxId;
    if (!sandboxId) throw new Error("No active sandbox — run sandbox_desktop first");
    return { sandboxId, screen: params.screen };
  }

  const desktopParams = {
    sandbox_id: Type.Optional(
      Type.String({ description: "Sandbox to drive (default: the active one)" }),
    ),
    screen: Type.Optional(Type.String({ description: "Screen id (default: screen-0)" })),
  };

  pi.registerTool({
    name: "sandbox_desktop",
    label: "Open Sandbox Desktop",
    description:
      "Enable ingress on a sandbox, wait for its desktop stack to finish booting, and mint a live noVNC URL " +
      "for one screen. The sandbox must already have been created on a desktop image (rootfs desktop:1).",
    promptSnippet: "Get a browser URL for a sandbox's graphical desktop",
    promptGuidelines: [
      "Run sandbox_desktop before sandbox_computer or sandbox_screenshot — it waits for the desktop stack to come up.",
      "When handing over the URL from sandbox_desktop, tell the user that anyone holding the link can drive the desktop, and when the token expires.",
    ],
    parameters: Type.Object(desktopParams),
    async execute(_id, params) {
      const { sandboxId, screen } = desktopTarget(params);
      const { url, expiresAt } = await engine.desktopConnect(sandboxId, screen);
      return {
        content: [
          {
            type: "text",
            text:
              `Desktop URL: ${url}\n\nAnyone holding this link can drive the desktop, and the token ` +
              `expires ${expiresAt}. Re-running this tool mints a fresh link.`,
          },
        ],
        details: { url, expiresAt },
      };
    },
  });

  pi.registerTool({
    name: "sandbox_computer",
    label: "Control Sandbox Desktop",
    description:
      "Read a screen, cursor, or windows; move or click the mouse; type text; press keys; or open a URL " +
      "in a sandbox desktop. Run sandbox_desktop first. Coordinates are raw X11 pixels.",
    promptSnippet: "Control a sandbox desktop",
    parameters: Type.Object({
      ...desktopParams,
      op: Type.String({
        description: "screen | cursor | windows | move | click | type | key | open",
      }),
      x: Type.Optional(Type.Integer({ description: "X coordinate for move or click" })),
      y: Type.Optional(Type.Integer({ description: "Y coordinate for move or click" })),
      text: Type.Optional(Type.String({ description: "Text for type" })),
      keys: Type.Optional(
        Type.Array(Type.String(), { description: 'Key chord for key, e.g. ["ctrl", "l"]' }),
      ),
      target: Type.Optional(Type.String({ description: "URL or path for open" })),
    }),
    async execute(_id, params) {
      const { sandboxId, screen } = desktopTarget(params);
      const result = await engine.computer(sandboxId, computerAction(params), screen);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: { result },
      };
    },
  });

  pi.registerTool({
    name: "sandbox_screenshot",
    label: "Screenshot Sandbox Desktop",
    description:
      "Capture one screen of a sandbox desktop as a PNG on the local filesystem and return its path.",
    promptSnippet: "Capture the screen of a sandbox desktop",
    promptGuidelines: [
      "Call sandbox_screenshot before and after any desktop action you are unsure about, then read its returned path to see the image.",
    ],
    parameters: Type.Object({
      ...desktopParams,
      path: Type.Optional(
        Type.String({ description: "Absolute path to write the PNG to (default: a temp file)" }),
      ),
    }),
    async execute(_id, params) {
      const { sandboxId, screen } = desktopTarget(params);
      if (params.path && !isAbsolute(params.path)) throw new Error("path must be absolute");
      const out = params.path ?? `${tmpdir()}/createos-${shortId(sandboxId)}-${Date.now()}.png`;
      await engine.screenshot(sandboxId, out, screen);
      return {
        content: [
          {
            type: "text",
            text: `Screenshot written to ${out} — read that path to see the screen.`,
          },
        ],
        details: { path: out },
      };
    },
  });

  // --- Sandbox create ---

  pi.registerTool({
    name: "sandbox_create",
    label: "Create Sandbox",
    description: "Create a sandbox, optionally joined to networks so it can reach other sandboxes.",
    promptSnippet: "Create a new sandbox",
    promptGuidelines: [
      "Use sandbox_create with networks to make a connected multi-node cluster; use sandbox_network_attach to connect an existing sandbox later.",
    ],
    parameters: Type.Object({
      shape: Type.Optional(
        Type.String({
          description: "Sandbox size (default: s-2vcpu-2gb); see sandbox_shapes.",
        }),
      ),
      rootfs: Type.Optional(Type.String({ description: "Base image (default: devbox:1)" })),
      name: Type.Optional(Type.String({ description: "Friendly name for the sandbox" })),
      networks: Type.Optional(
        Type.Array(Type.String(), { description: "Network names to join at creation" }),
      ),
    }),
    async execute(_id, { shape, rootfs, name, networks }, signal) {
      if (signal?.aborted) throw new Error("aborted");
      try {
        const sb = await cli.createSandbox(pi, { shape, rootfs, name, networks, ingress: true });
        const lines = [
          `Sandbox created: ${sb.id}`,
          `IP: ${sb.ip ?? "pending"}`,
          `Shape: ${(sb as any).shape ?? shape ?? "s-2vcpu-2gb"}`,
        ];
        if (sb.ingress_url_template) lines.push(`Ingress: ${sb.ingress_url_template}`);
        if (networks?.length) lines.push(`Networks: ${networks.join(", ")}`);
        return { content: [{ type: "text", text: lines.join("\n") }], details: { sandbox: sb } };
      } catch (err) {
        throw new Error(errmsg(err));
      }
    },
  });

  // --- Sandbox exec (on any sandbox, not just the active one) ---

  pi.registerTool({
    name: "sandbox_exec",
    label: "Exec on Sandbox",
    description: "Run a command on a specific sandbox by ID.",
    promptSnippet: "Run a command on a specific sandbox",
    promptGuidelines: [
      "Use sandbox_exec for a named sandbox. In --inside-createos-sandbox mode, bash runs on the current sandbox; use sandbox_exec for any other sandbox.",
    ],
    parameters: Type.Object({
      sandbox_id: Type.String({ description: "ID of the target sandbox" }),
      command: Type.String({ description: "Shell command to run" }),
    }),
    async execute(_id, { sandbox_id, command }, signal) {
      if (signal?.aborted) throw new Error("aborted");
      try {
        const res = await cli.sandboxExec(pi, sandbox_id, command);
        return {
          content: [{ type: "text", text: res.stdout || "(no output)" }],
          details: { exit_code: res.exitCode },
        };
      } catch (err) {
        throw new Error(errmsg(err));
      }
    },
  });

  // --- Sandbox info ---

  pi.registerTool({
    name: "sandbox_info",
    label: "Sandbox Info",
    description: "Get a sandbox's status, IP, shape, region, and ingress URL.",
    promptSnippet: "Get sandbox details",
    parameters: Type.Object({
      sandbox_id: Type.Optional(Type.String({ description: "Sandbox ID (defaults to current)" })),
    }),
    async execute(_id, { sandbox_id }, signal) {
      if (signal?.aborted) throw new Error("aborted");
      const targetId = sandbox_id ?? getActive()?.sandboxId;
      if (!targetId) return txt("No sandbox active.");
      try {
        const info = await cli.getSandbox(pi, targetId);
        const lines = [
          `ID: ${info.id}`,
          `Status: ${info.status}`,
          `Name: ${info.name ?? "n/a"}`,
          `IP: ${info.ip ?? "n/a"}`,
          `Shape: ${(info as any).shape ?? "n/a"}`,
          `Region: ${info.region ?? "n/a"}`,
        ];
        if (info.ingress_url_template) lines.push(`Ingress: ${info.ingress_url_template}`);
        return { content: [{ type: "text", text: lines.join("\n") }], details: { sandbox: info } };
      } catch (err) {
        throw new Error(errmsg(err));
      }
    },
  });

  // --- Sandbox list ---

  pi.registerTool({
    name: "sandbox_list",
    label: "List Sandboxes",
    description: "List all sandboxes owned by the user, running and paused.",
    promptSnippet: "List all sandboxes",
    parameters: Type.Object({}),
    async execute(_id, _params, signal) {
      if (signal?.aborted) throw new Error("aborted");
      try {
        const sbs = await cli.listSandboxes(pi);
        if (sbs.length === 0) return txt("No sandboxes found.");
        const lines = sbs.map(
          (s) => `${s.id} · ${s.status} · ${s.name ?? ""}${s.ip ? ` · ${s.ip}` : ""}`,
        );
        return { content: [{ type: "text", text: lines.join("\n") }], details: { sandboxes: sbs } };
      } catch (err) {
        throw new Error(errmsg(err));
      }
    },
  });

  // --- Sandbox pause ---

  pi.registerTool({
    name: "sandbox_pause",
    label: "Pause Sandbox",
    description: "Pause a sandbox, saving its state. It stays unavailable until resumed.",
    promptSnippet: "Pause a sandbox",
    promptGuidelines: ["sandbox_pause on the active sandbox disconnects the current session."],
    parameters: Type.Object({
      sandbox_id: Type.Optional(Type.String({ description: "Sandbox ID (defaults to current)" })),
    }),
    async execute(_id, { sandbox_id }, signal) {
      if (signal?.aborted) throw new Error("aborted");
      const targetId = sandbox_id ?? getActive()?.sandboxId;
      if (!targetId) return txt("No sandbox to pause.");
      try {
        await cli.pauseSandbox(pi, targetId);
        return {
          ...txt(`Sandbox ${targetId} is pausing. It will be unavailable until resumed.`),
          terminate: true,
        };
      } catch (err) {
        throw new Error(errmsg(err));
      }
    },
  });

  // --- Sandbox resume ---

  pi.registerTool({
    name: "sandbox_resume",
    label: "Resume Sandbox",
    description: "Resume a paused sandbox.",
    promptSnippet: "Resume a paused sandbox",
    parameters: Type.Object({
      sandbox_id: Type.String({ description: "ID of the paused sandbox to resume" }),
    }),
    async execute(_id, { sandbox_id }, signal) {
      if (signal?.aborted) throw new Error("aborted");
      try {
        await cli.resumeSandbox(pi, sandbox_id);
        return txt(`Sandbox ${sandbox_id} is resuming.`);
      } catch (err) {
        throw new Error(errmsg(err));
      }
    },
  });

  // --- Sandbox fork ---

  pi.registerTool({
    name: "sandbox_fork",
    label: "Fork Sandbox",
    description:
      "Clone a sandbox into a new sandbox with the same state. The source must be paused first.",
    promptSnippet: "Fork a sandbox",
    parameters: Type.Object({
      sandbox_id: Type.Optional(
        Type.String({ description: "Sandbox ID to fork (defaults to current)" }),
      ),
      paused: Type.Optional(
        Type.Boolean({ description: "Keep the fork paused instead of auto-resuming" }),
      ),
    }),
    async execute(_id, { sandbox_id, paused }, signal) {
      if (signal?.aborted) throw new Error("aborted");
      const targetId = sandbox_id ?? getActive()?.sandboxId;
      if (!targetId) return txt("No sandbox to fork.");
      try {
        const forked = await cli.forkSandbox(pi, targetId, { paused });
        return {
          content: [
            {
              type: "text",
              text: `Forked into ${forked.id} (${forked.status}). IP: ${forked.ip ?? "pending"}`,
            },
          ],
          details: { sandbox: forked },
        };
      } catch (err) {
        throw new Error(errmsg(err));
      }
    },
  });

  // --- Sandbox destroy ---

  pi.registerTool({
    name: "sandbox_destroy",
    label: "Destroy Sandbox",
    description: "Permanently delete a sandbox. This cannot be undone.",
    promptSnippet: "Destroy a sandbox",
    parameters: Type.Object({
      sandbox_id: Type.String({ description: "ID of the sandbox to destroy" }),
    }),
    async execute(_id, { sandbox_id }, signal) {
      if (signal?.aborted) throw new Error("aborted");
      try {
        await cli.destroySandbox(pi, sandbox_id);
        return { ...txt(`Sandbox ${sandbox_id} destroyed.`), terminate: true };
      } catch (err) {
        throw new Error(errmsg(err));
      }
    },
  });

  // --- Sandbox ingress toggle ---

  pi.registerTool({
    name: "sandbox_ingress",
    label: "Toggle Ingress",
    description: "Enable or disable the public HTTPS URL for a sandbox.",
    promptSnippet: "Toggle public URL on/off",
    parameters: Type.Object({
      enabled: Type.Boolean({ description: "true to enable, false to disable" }),
      sandbox_id: Type.Optional(Type.String({ description: "Sandbox ID (defaults to current)" })),
    }),
    async execute(_id, { enabled, sandbox_id }, signal) {
      if (signal?.aborted) throw new Error("aborted");
      const targetId = sandbox_id ?? getActive()?.sandboxId;
      if (!targetId) return txt("No sandbox active.");
      try {
        await cli.editSandbox(pi, targetId, { ingress: enabled });
        if (enabled) {
          const info = await cli.getSandbox(pi, targetId);
          return txt(
            `Ingress enabled.${info.ingress_url_template ? ` URL: ${info.ingress_url_template}` : ""}`,
          );
        }
        return txt("Ingress disabled.");
      } catch (err) {
        throw new Error(errmsg(err));
      }
    },
  });

  // --- Sandbox firewall ---

  pi.registerTool({
    name: "sandbox_firewall",
    label: "Set Firewall",
    description:
      "Restrict which domains or IPs a sandbox can reach. Empty list allows all outbound traffic.",
    promptSnippet: "Set sandbox egress rules",
    parameters: Type.Object({
      rules: Type.Array(Type.String(), {
        description:
          'Allowed domains or IPs (e.g. ["pypi.org", "1.1.1.1:53"]). Empty array = allow all.',
      }),
      sandbox_id: Type.Optional(Type.String({ description: "Sandbox ID (defaults to current)" })),
    }),
    async execute(_id, { rules, sandbox_id }, signal) {
      if (signal?.aborted) throw new Error("aborted");
      const targetId = sandbox_id ?? getActive()?.sandboxId;
      if (!targetId) return txt("No sandbox active.");
      try {
        await cli.editSandbox(pi, targetId, { egress: rules });
        return txt(
          rules.length > 0
            ? `Firewall set: ${rules.join(", ")}`
            : "Firewall cleared — all outbound allowed.",
        );
      } catch (err) {
        throw new Error(errmsg(err));
      }
    },
  });

  // --- Sandbox bandwidth ---

  pi.registerTool({
    name: "sandbox_bandwidth",
    label: "Check Bandwidth",
    description: "Check bandwidth usage, quota, and cap status for a sandbox.",
    promptSnippet: "Check bandwidth usage",
    parameters: Type.Object({
      sandbox_id: Type.Optional(Type.String({ description: "Sandbox ID (defaults to current)" })),
    }),
    async execute(_id, { sandbox_id }, signal) {
      if (signal?.aborted) throw new Error("aborted");
      const targetId = sandbox_id ?? getActive()?.sandboxId;
      if (!targetId) return txt("No sandbox active.");
      try {
        const bw = await cli.getBandwidth(pi, targetId);
        return txt(
          `Bandwidth: ${fmtBytes(bw.used_bytes)} used of ${fmtBytes(bw.quota_bytes)} (${fmtBytes(bw.remaining_bytes)} remaining)${bw.capped ? " — CAPPED" : ""}`,
        );
      } catch (err) {
        throw new Error(errmsg(err));
      }
    },
  });

  // --- Sandbox shapes ---

  pi.registerTool({
    name: "sandbox_shapes",
    label: "List Shapes",
    description: "List available sandbox sizes (vCPU, RAM).",
    promptSnippet: "List available sandbox sizes",
    parameters: Type.Object({}),
    async execute(_id, _params, signal) {
      if (signal?.aborted) throw new Error("aborted");
      try {
        const shapes = await cli.listShapes(pi);
        const lines = shapes.map(
          (s: any) => `${s.name ?? s.id} · ${s.vcpu} vCPU · ${s.mem_mib} MB RAM`,
        );
        return { content: [{ type: "text", text: lines.join("\n") }], details: { shapes } };
      } catch (err) {
        throw new Error(errmsg(err));
      }
    },
  });

  // --- Sandbox images ---

  pi.registerTool({
    name: "sandbox_images",
    label: "List Images",
    description: "List available base images (rootfs) for sandbox creation.",
    promptSnippet: "List available sandbox base images",
    parameters: Type.Object({}),
    async execute(_id, _params, signal) {
      if (signal?.aborted) throw new Error("aborted");
      try {
        const rootfs = await cli.listRootfs(pi);
        return {
          content: [{ type: "text", text: JSON.stringify(rootfs, null, 2) }],
          details: { rootfs },
        };
      } catch (err) {
        throw new Error(errmsg(err));
      }
    },
  });

  // --- Preview URL ---

  pi.registerTool({
    name: "sandbox_preview_url",
    label: "Preview URL",
    description: "Get the public HTTPS URL for a port served inside the sandbox.",
    promptSnippet: "Get a public URL for a sandbox port",
    parameters: Type.Object({
      port: Type.Integer({
        minimum: 1,
        maximum: 65535,
        description: "The port the server listens on",
      }),
      sandbox_id: Type.Optional(Type.String({ description: "Sandbox ID (defaults to current)" })),
    }),
    async execute(_id, { port, sandbox_id }, signal) {
      if (signal?.aborted) throw new Error("aborted");
      const targetId = sandbox_id ?? requireSandbox()?.sandboxId;
      if (!targetId) return txt("No sandbox selected.");
      try {
        const info = await cli.getSandbox(pi, targetId);
        if (info.ingress_url_template) {
          return txt(
            `Preview URL for port ${port}: ${info.ingress_url_template.replace("<port>", String(port))}`,
          );
        }
        return txt("Ingress not enabled. Use sandbox_ingress to enable it first.");
      } catch (err) {
        throw new Error(errmsg(err));
      }
    },
  });

  // --- Tunnel (port forward) ---

  pi.registerTool({
    name: "sandbox_tunnel",
    label: "Port Forward",
    description: "Forward a sandbox port to localhost on the user's machine. No setup needed.",
    promptSnippet: "Forward a sandbox port to localhost",
    promptGuidelines: [
      "Prefer sandbox_tunnel over sandbox_device_attach for reaching a sandbox port — it needs no setup.",
    ],
    parameters: Type.Object({
      remote_port: Type.Integer({
        minimum: 1,
        maximum: 65535,
        description: "Port inside the sandbox",
      }),
      local_port: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: 65535,
          description: "Local port (defaults to remote_port)",
        }),
      ),
      sandbox_id: Type.Optional(Type.String({ description: "Sandbox ID (defaults to current)" })),
    }),
    async execute(_id, { remote_port, local_port, sandbox_id }, signal) {
      if (signal?.aborted) throw new Error("aborted");
      const targetId = sandbox_id ?? requireSandbox()?.sandboxId;
      if (!targetId) return txt("No sandbox selected.");
      try {
        const result = await cli.startTunnel(pi, targetId, remote_port, local_port);
        return txt(
          `Port forward started: localhost:${result.localPort} → sandbox:${remote_port}\nAccess at: http://localhost:${result.localPort}`,
        );
      } catch (err) {
        throw new Error(errmsg(err));
      }
    },
  });

  // --- Sync (directory mount) ---

  pi.registerTool({
    name: "sandbox_sync",
    label: "Sync Directory",
    description:
      "Mount, sync, or mirror a local directory into the sandbox. Two-way by default — changes on " +
      "either side propagate. Runs in the background until the session ends.",
    promptSnippet: "Mount/sync a local directory into the sandbox",
    promptGuidelines: [
      'Use sandbox_sync when the user says "mount", "sync", "mirror", or "upload directory".',
    ],
    parameters: Type.Object({
      local_dir: Type.String({ description: "Absolute path on the user's machine" }),
      remote_dir: Type.String({
        description: "Absolute path inside the sandbox (e.g. /root/project)",
      }),
      mode: Type.Optional(
        Type.String({
          description:
            'Sync mode: "two-way" (default), "one-way" (local wins), or "mirror" (local wins + deletes extras)',
        }),
      ),
      exclude: Type.Optional(
        Type.Array(Type.String(), {
          description: 'Glob patterns to exclude (e.g. ["node_modules", "*.log"])',
        }),
      ),
      sandbox_id: Type.Optional(Type.String({ description: "Sandbox ID (defaults to current)" })),
    }),
    async execute(_id, { local_dir, remote_dir, mode, exclude, sandbox_id }, signal) {
      if (signal?.aborted) throw new Error("aborted");
      const targetId = sandbox_id ?? requireSandbox()?.sandboxId;
      if (!targetId) return txt("No sandbox selected.");
      try {
        const source = await validateLocalSyncSource(local_dir);
        const result = await cli.startSync(pi, targetId, source, remote_dir, {
          mode,
          exclude,
        });
        return txt(
          `Sync started: ${local_dir} ↔ sandbox:${remote_dir}${mode ? ` (${mode})` : ""}\nChanges will propagate automatically. PID: ${result.pid}`,
        );
      } catch (err) {
        throw new Error(errmsg(err));
      }
    },
  });

  // --- Network tools ---

  pi.registerTool({
    name: "sandbox_network_create",
    label: "Create Network",
    description: "Create a private network for sandbox-to-sandbox communication.",
    promptSnippet: "Create a private network",
    parameters: Type.Object({
      name: Type.String({ description: "Network name" }),
    }),
    async execute(_id, { name }, signal) {
      if (signal?.aborted) throw new Error("aborted");
      try {
        const net = await cli.createNetwork(pi, name);
        return {
          content: [{ type: "text", text: `Network created: ${net.name} (${net.id})` }],
          details: { network: net },
        };
      } catch (err) {
        throw new Error(errmsg(err));
      }
    },
  });

  pi.registerTool({
    name: "sandbox_network_list",
    label: "List Networks",
    description: "List all private networks owned by the user.",
    promptSnippet: "List private networks",
    parameters: Type.Object({}),
    async execute(_id, _params, signal) {
      if (signal?.aborted) throw new Error("aborted");
      try {
        const nets = await cli.listNetworks(pi);
        if (nets.length === 0) return txt("No networks found.");
        const lines = nets.map((n) => `${n.name} (${n.id}) · ${n.member_count ?? 0} members`);
        return { content: [{ type: "text", text: lines.join("\n") }], details: { networks: nets } };
      } catch (err) {
        throw new Error(errmsg(err));
      }
    },
  });

  pi.registerTool({
    name: "sandbox_network_show",
    label: "Show Network",
    description: "Show network details, including member sandboxes and their IPs.",
    promptSnippet: "Show network members and their IPs",
    parameters: Type.Object({
      name: Type.String({ description: "Network name or id" }),
    }),
    async execute(_id, { name }, signal) {
      if (signal?.aborted) throw new Error("aborted");
      try {
        const net = await cli.getNetwork(pi, name);
        const lines = [`Network: ${net.name} (${net.id})`];
        if (net.members?.length) {
          lines.push("Members:");
          for (const m of net.members)
            lines.push(`  ${m.sandbox_id} · ${m.status} · ${m.ip}${m.name ? ` · ${m.name}` : ""}`);
        } else lines.push("No members");
        return { content: [{ type: "text", text: lines.join("\n") }], details: { network: net } };
      } catch (err) {
        throw new Error(errmsg(err));
      }
    },
  });

  pi.registerTool({
    name: "sandbox_network_attach",
    label: "Attach to Network",
    description: "Attach the current sandbox to a private network so it can reach other members.",
    promptSnippet: "Join a sandbox to a network",
    parameters: Type.Object({
      name: Type.String({ description: "Network name or id" }),
    }),
    async execute(_id, { name }, signal) {
      if (signal?.aborted) throw new Error("aborted");
      const active = requireSandbox();
      if (!active) return txt("No active sandbox.");
      try {
        await cli.attachNetwork(pi, active.sandboxId, name);
        return txt(`Attached sandbox to network "${name}".`);
      } catch (err) {
        throw new Error(errmsg(err));
      }
    },
  });

  pi.registerTool({
    name: "sandbox_network_detach",
    label: "Detach from Network",
    description: "Detach the current sandbox from a private network.",
    promptSnippet: "Remove a sandbox from a network",
    parameters: Type.Object({
      name: Type.String({ description: "Network name or id" }),
    }),
    async execute(_id, { name }, signal) {
      if (signal?.aborted) throw new Error("aborted");
      const active = requireSandbox();
      if (!active) return txt("No active sandbox.");
      try {
        await cli.detachNetwork(pi, active.sandboxId, name);
        return txt(`Detached sandbox from network "${name}".`);
      } catch (err) {
        throw new Error(errmsg(err));
      }
    },
  });

  pi.registerTool({
    name: "sandbox_network_delete",
    label: "Delete Network",
    description: "Delete a private network. Detach all sandboxes first — it must have no members.",
    promptSnippet: "Delete a network",
    parameters: Type.Object({
      name: Type.String({ description: "Network name or id" }),
    }),
    async execute(_id, { name }, signal) {
      if (signal?.aborted) throw new Error("aborted");
      try {
        await cli.deleteNetwork(pi, name);
        return txt(`Network "${name}" deleted.`);
      } catch (err) {
        throw new Error(errmsg(err));
      }
    },
  });

  // --- Disk tools ---

  pi.registerTool({
    name: "sandbox_disk_create",
    label: "Create Disk",
    description:
      "Register an S3-compatible bucket as a persistent disk that can be mounted into sandboxes. " +
      "The data survives sandbox destroy.",
    promptSnippet: "Register an S3 bucket as a mountable disk",
    parameters: Type.Object({
      name: Type.String({ description: "Disk name" }),
      bucket: Type.String({ description: "S3 bucket name" }),
      endpoint: Type.String({ description: "S3 endpoint URL (e.g. https://s3.amazonaws.com)" }),
      access_key: Type.String({ description: "Access key ID" }),
      secret_key: Type.String({ description: "Secret access key" }),
      region: Type.Optional(Type.String({ description: "AWS region (e.g. us-east-1)" })),
      path_style: Type.Optional(
        Type.Boolean({ description: "Use path-style URLs (needed for MinIO)" }),
      ),
    }),
    async execute(
      _id,
      { name, bucket, endpoint, access_key, secret_key, region, path_style },
      signal,
    ) {
      if (signal?.aborted) throw new Error("aborted");
      try {
        const disk = await cli.createDisk(pi, {
          name,
          bucket,
          endpoint,
          accessKey: access_key,
          secretKey: secret_key,
          region,
          pathStyle: path_style,
        });
        return {
          content: [{ type: "text", text: `Disk created: ${disk.name} (${disk.id})` }],
          details: { disk },
        };
      } catch (err) {
        throw new Error(errmsg(err));
      }
    },
  });

  pi.registerTool({
    name: "sandbox_disk_list",
    label: "List Disks",
    description: "List all S3 disks registered by the user.",
    promptSnippet: "List registered disks",
    parameters: Type.Object({}),
    async execute(_id, _params, signal) {
      if (signal?.aborted) throw new Error("aborted");
      try {
        const disks = await cli.listDisks(pi);
        if (disks.length === 0) return txt("No disks registered.");
        const lines = disks.map(
          (d) => `${d.name} (${d.id})${d.config?.bucket ? ` · bucket: ${d.config.bucket}` : ""}`,
        );
        return { content: [{ type: "text", text: lines.join("\n") }], details: { disks } };
      } catch (err) {
        throw new Error(errmsg(err));
      }
    },
  });

  pi.registerTool({
    name: "sandbox_disk_show",
    label: "Show Disk",
    description: "Show a registered disk's config and the sandboxes it is attached to.",
    promptSnippet: "Show disk details",
    parameters: Type.Object({
      name: Type.String({ description: "Disk name or id" }),
    }),
    async execute(_id, { name }, signal) {
      if (signal?.aborted) throw new Error("aborted");
      try {
        const disk = await cli.getDisk(pi, name);
        return {
          content: [{ type: "text", text: JSON.stringify(disk, null, 2) }],
          details: { disk },
        };
      } catch (err) {
        throw new Error(errmsg(err));
      }
    },
  });

  pi.registerTool({
    name: "sandbox_disk_delete",
    label: "Delete Disk",
    description: "Delete a disk registration. Detach it from all sandboxes first.",
    promptSnippet: "Delete a disk",
    parameters: Type.Object({
      name: Type.String({ description: "Disk name or id" }),
    }),
    async execute(_id, { name }, signal) {
      if (signal?.aborted) throw new Error("aborted");
      try {
        await cli.deleteDisk(pi, name);
        return txt(`Disk "${name}" deleted.`);
      } catch (err) {
        throw new Error(errmsg(err));
      }
    },
  });

  pi.registerTool({
    name: "sandbox_disk_attach",
    label: "Attach Disk",
    description: "Mount a registered disk into a running sandbox at a given path.",
    promptSnippet: "Mount a disk into a sandbox",
    parameters: Type.Object({
      disk_name: Type.String({ description: "Disk name or id" }),
      mount_path: Type.String({
        description: "Absolute mount path inside the sandbox (e.g. /mnt/data)",
      }),
      sandbox_id: Type.Optional(Type.String({ description: "Sandbox ID (defaults to current)" })),
    }),
    async execute(_id, { disk_name, mount_path, sandbox_id }, signal) {
      if (signal?.aborted) throw new Error("aborted");
      const targetId = sandbox_id ?? getActive()?.sandboxId;
      if (!targetId) return txt("No sandbox active.");
      try {
        await cli.attachDisk(pi, targetId, disk_name, mount_path);
        return txt(`Disk "${disk_name}" mounted at ${mount_path}`);
      } catch (err) {
        throw new Error(errmsg(err));
      }
    },
  });

  pi.registerTool({
    name: "sandbox_disk_detach",
    label: "Detach Disk",
    description: "Unmount a disk from a sandbox. The bucket data is untouched.",
    promptSnippet: "Unmount a disk from a sandbox",
    parameters: Type.Object({
      disk_name: Type.String({ description: "Disk name or id" }),
      mount_path: Type.String({ description: "Mount path to detach" }),
      sandbox_id: Type.Optional(Type.String({ description: "Sandbox ID (defaults to current)" })),
    }),
    async execute(_id, { disk_name, mount_path, sandbox_id }, signal) {
      if (signal?.aborted) throw new Error("aborted");
      const targetId = sandbox_id ?? getActive()?.sandboxId;
      if (!targetId) return txt("No sandbox active.");
      try {
        await cli.detachDisk(pi, targetId, disk_name, mount_path);
        return txt(`Disk "${disk_name}" detached from ${mount_path}`);
      } catch (err) {
        throw new Error(errmsg(err));
      }
    },
  });

  // --- Device tools ---

  pi.registerTool({
    name: "sandbox_device_register",
    label: "Register Device",
    description:
      "Register the user's machine as a device for direct access to sandbox networks. " +
      "One-time; needs wireguard-tools on the host.",
    promptSnippet: "Register this machine for direct sandbox access",
    promptGuidelines: [
      "Use sandbox_device_register before sandbox_device_attach or sandbox_vpn_up, and only if sandbox_device_status shows no device.",
    ],
    parameters: Type.Object({
      name: Type.Optional(Type.String({ description: "Device name (defaults to hostname)" })),
    }),
    async execute(_id, { name }, signal) {
      if (signal?.aborted) throw new Error("aborted");
      try {
        const devices = await cli.listDevices(pi);
        if (devices.length > 0) {
          return txt(
            `Device already registered: ${devices[0].name} (${devices[0].client_ip ?? "n/a"})`,
          );
        }
        const output = await cli.registerDevice(pi, name);
        return txt(output || "Device registered.");
      } catch (err) {
        throw new Error(errmsg(err));
      }
    },
  });

  pi.registerTool({
    name: "sandbox_device_status",
    label: "Device Status",
    description: "Check whether the user has a registered device for direct sandbox access.",
    promptSnippet: "Check device registration status",
    parameters: Type.Object({}),
    async execute(_id, _params, signal) {
      if (signal?.aborted) throw new Error("aborted");
      try {
        const devices = await cli.listDevices(pi);
        if (devices.length === 0) {
          return txt("No device registered. Use sandbox_device_register to register this machine.");
        }
        const lines = devices.map(
          (d) => `${d.name} · ${d.id ?? d.device_id} · IP: ${d.client_ip ?? "n/a"}`,
        );
        return {
          content: [{ type: "text", text: `Registered devices:\n${lines.join("\n")}` }],
          details: { devices },
        };
      } catch (err) {
        throw new Error(errmsg(err));
      }
    },
  });

  pi.registerTool({
    name: "sandbox_vpn_up",
    label: "Start VPN",
    description:
      "Return the command the user must run to start the VPN tunnel. It needs sudo and a separate " +
      "terminal, so this tool does not start the VPN itself.",
    promptSnippet: "Get the VPN start command for the user to run",
    parameters: Type.Object({}),
    async execute(_id, _params, signal) {
      if (signal?.aborted) throw new Error("aborted");
      try {
        const devices = await cli.listDevices(pi);
        if (devices.length === 0) {
          return txt("No device registered. Use sandbox_device_register first.");
        }
        return txt(
          "The user needs to run this command in a separate terminal (it requires sudo):\n\n  createos sb vpn up\n\nOnce connected, sandbox IPs are reachable directly.",
        );
      } catch (err) {
        throw new Error(errmsg(err));
      }
    },
  });

  pi.registerTool({
    name: "sandbox_device_attach",
    label: "Attach Device to Network",
    description: "Attach the user's device to a network so they can reach sandbox IPs directly.",
    promptSnippet: "Give user's machine direct access to a network",
    parameters: Type.Object({
      network: Type.String({ description: "Network name or id" }),
    }),
    async execute(_id, { network }, signal) {
      if (signal?.aborted) throw new Error("aborted");
      try {
        const devices = await cli.listDevices(pi);
        if (devices.length === 0)
          return txt("No device registered. Run: createos sb devices register");
        const devId = devices[0].id ?? devices[0].device_id!;
        await cli.attachDeviceToNetwork(pi, devId, network);
        return txt(
          `Device attached to network "${network}".\nRun \`createos sb vpn up\` to access sandbox IPs directly.`,
        );
      } catch (err) {
        throw new Error(errmsg(err));
      }
    },
  });

  pi.registerTool({
    name: "sandbox_device_detach",
    label: "Detach Device from Network",
    description: "Remove the user's device from a network.",
    promptSnippet: "Remove device access to a network",
    parameters: Type.Object({
      network: Type.String({ description: "Network name or id" }),
    }),
    async execute(_id, { network }, signal) {
      if (signal?.aborted) throw new Error("aborted");
      try {
        const devices = await cli.listDevices(pi);
        if (devices.length === 0) return txt("No device registered.");
        const devId = devices[0].id ?? devices[0].device_id!;
        await cli.detachDeviceFromNetwork(pi, devId, network);
        return txt(`Device detached from network "${network}".`);
      } catch (err) {
        throw new Error(errmsg(err));
      }
    },
  });

  // --- User bash routing ---

  pi.on("user_bash", () => {
    const active = getActive();
    if (active) return { operations: createBashOps(pi, active.sandboxId, active.cwd) };
    if (pi.getFlag("inside-createos-sandbox") === true) {
      return {
        result: {
          output:
            "CreateOS sandbox is unavailable — the command was NOT run on your host. Restart Pi.",
          exitCode: 1,
          cancelled: false,
          truncated: false,
        },
      };
    }
    return;
  });
}

// --- Helpers ---

function txt(text: string) {
  return { content: [{ type: "text" as const, text }], details: undefined };
}

function errmsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function fmtBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / 1024 ** i).toFixed(1)} ${units[i]}`;
}
