/**
 * OpenCode plugin tools — sandbox-specific tools for CreateOS.
 *
 * Unlike Pi (which replaced built-in tools), OpenCode plugins cannot override
 * built-ins. All tools use the `sandbox_` prefix and are explicitly sandbox-scoped.
 */

import { tool } from "@opencode-ai/plugin";
import * as cli from "./cli.ts";
import * as engine from "./sandbox-engine.ts";
import { shortId } from "./util.ts";
import { tmpdir } from "node:os";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ToolSandbox {
  sandboxId: string;
  cwd: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function requireSandbox(getActive: () => ToolSandbox | null): ToolSandbox {
  const active = getActive();
  if (!active) {
    throw new Error(
      "No active CreateOS sandbox. Please enable CreateOS first by creating or selecting a sandbox.",
    );
  }
  return active;
}

function fmtBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

export function createTools($: any, getActive: () => ToolSandbox | null) {
  return {
    // =====================================================================
    // Sandbox Tools
    // =====================================================================

    sandbox_create: tool({
      description:
        "Create a new CreateOS sandbox. Returns the sandbox ID, IP address, shape, and ingress URL once ready.",
      args: {
        shape: tool.schema
          .string()
          .optional()
          .describe("VM size/shape (e.g. 's-2vcpu-2gb'). Defaults to 's-2vcpu-2gb'."),
        rootfs: tool.schema.string().optional().describe("Base image name to use for the sandbox"),
        name: tool.schema.string().optional().describe("Human-readable name for the sandbox"),
        networks: tool.schema
          .array(tool.schema.string())
          .optional()
          .describe("Network names to attach to the sandbox at creation time"),
      },
      async execute(args) {
        const info = await cli.createSandbox($, {
          shape: args.shape,
          rootfs: args.rootfs,
          name: args.name,
          networks: args.networks,
        });
        const lines = [`Sandbox created.`, `  ID:     ${info.id}`, `  Status: ${info.status}`];
        if (info.ip) lines.push(`  IP:     ${info.ip}`);
        if ((info as any).shape) lines.push(`  Shape:  ${(info as any).shape}`);
        if (info.ingress_url_template) lines.push(`  Ingress: ${info.ingress_url_template}`);
        return lines.join("\n");
      },
    }),

    sandbox_exec: tool({
      description:
        "Run a shell command on a specific sandbox by ID. Use this when you need to target a sandbox that is not the currently active one.",
      args: {
        sandbox_id: tool.schema.string().describe("The sandbox ID to execute the command on"),
        command: tool.schema.string().describe("The shell command to run"),
      },
      async execute(args) {
        const result = await cli.sandboxExec($, args.sandbox_id, args.command);
        const parts: string[] = [];
        if (result.stdout.trim()) parts.push(result.stdout.trim());
        if (result.stderr.trim()) parts.push(`STDERR:\n${result.stderr.trim()}`);
        if (result.code !== 0) parts.push(`Exit code: ${result.code}`);
        return parts.join("\n") || "(no output)";
      },
    }),

    sandbox_info: tool({
      description:
        "Get detailed status information about a sandbox including its ID, status, name, IP address, shape, region, and ingress URL.",
      args: {
        sandbox_id: tool.schema
          .string()
          .optional()
          .describe("Sandbox ID to inspect. Defaults to the currently active sandbox."),
      },
      async execute(args) {
        const id = args.sandbox_id ?? requireSandbox(getActive).sandboxId;
        const info = await cli.getSandbox($, id);
        const lines = [`ID:      ${info.id}`, `Status:  ${info.status}`];
        if (info.name) lines.push(`Name:    ${info.name}`);
        if (info.ip) lines.push(`IP:      ${info.ip}`);
        if ((info as any).shape) lines.push(`Shape:   ${(info as any).shape}`);
        if (info.region) lines.push(`Region:  ${info.region}`);
        if (info.ingress_url_template) lines.push(`Ingress: ${info.ingress_url_template}`);
        return lines.join("\n");
      },
    }),

    sandbox_list: tool({
      description:
        "List all sandboxes in the current CreateOS account, including their IDs, names, and statuses.",
      args: {},
      async execute() {
        const sandboxes = await cli.listSandboxes($);
        if (sandboxes.length === 0) return "No sandboxes found.";
        return sandboxes
          .map((sb) => {
            const parts = [sb.id, sb.status];
            if (sb.name) parts.push(sb.name);
            if (sb.ip) parts.push(sb.ip);
            return parts.join("  ");
          })
          .join("\n");
      },
    }),

    sandbox_pause: tool({
      description:
        "Pause a running sandbox. The sandbox state is preserved and can be resumed later. Paused sandboxes do not consume compute resources.",
      args: {
        sandbox_id: tool.schema
          .string()
          .optional()
          .describe("Sandbox ID to pause. Defaults to the currently active sandbox."),
      },
      async execute(args) {
        const id = args.sandbox_id ?? requireSandbox(getActive).sandboxId;
        await cli.pauseSandbox($, id);
        return `Sandbox ${id} paused.`;
      },
    }),

    sandbox_resume: tool({
      description: "Resume a previously paused sandbox, restoring it to a running state.",
      args: {
        sandbox_id: tool.schema.string().describe("The sandbox ID to resume"),
      },
      async execute(args) {
        await cli.resumeSandbox($, args.sandbox_id);
        return `Sandbox ${args.sandbox_id} resumed.`;
      },
    }),

    sandbox_fork: tool({
      description:
        "Clone a paused sandbox into a new sandbox. The new sandbox is an exact copy of the original at the point it was paused.",
      args: {
        sandbox_id: tool.schema
          .string()
          .optional()
          .describe("Sandbox ID to fork. Defaults to the currently active sandbox."),
        paused: tool.schema
          .boolean()
          .optional()
          .describe(
            "If true, pause the source sandbox before forking (it must be paused to fork).",
          ),
      },
      async execute(args) {
        const id = args.sandbox_id ?? requireSandbox(getActive).sandboxId;
        if (args.paused) {
          await cli.pauseSandbox($, id);
        }
        const forked = await cli.forkSandbox($, id);
        return `Forked sandbox ${id} -> new sandbox ${forked.id} (status: ${forked.status})`;
      },
    }),

    sandbox_destroy: tool({
      description:
        "Permanently delete a sandbox. This is irreversible. All data in the sandbox will be lost.",
      args: {
        sandbox_id: tool.schema.string().describe("The sandbox ID to destroy"),
      },
      async execute(args) {
        await cli.destroySandbox($, args.sandbox_id);
        return `Sandbox ${args.sandbox_id} destroyed.`;
      },
    }),

    sandbox_ingress: tool({
      description:
        "Toggle public HTTPS ingress for a sandbox. When enabled, the sandbox gets a public URL that can be used to access services running inside it.",
      args: {
        enabled: tool.schema.boolean().describe("Set to true to enable ingress, false to disable"),
        sandbox_id: tool.schema
          .string()
          .optional()
          .describe("Sandbox ID to configure. Defaults to the currently active sandbox."),
      },
      async execute(args) {
        const id = args.sandbox_id ?? requireSandbox(getActive).sandboxId;
        await cli.editSandbox($, id, { ingress: args.enabled });
        if (args.enabled) {
          const info = await cli.getSandbox($, id);
          return `Ingress enabled for sandbox ${id}.${info.ingress_url_template ? `\nURL template: ${info.ingress_url_template}` : ""}`;
        }
        return `Ingress disabled for sandbox ${id}.`;
      },
    }),

    sandbox_firewall: tool({
      description:
        "Set egress firewall rules for a sandbox. Rules control which external destinations the sandbox can reach. Each rule is a string like 'allow tcp 443 example.com' or 'deny all'.",
      args: {
        rules: tool.schema
          .array(tool.schema.string())
          .describe("List of egress firewall rules to apply"),
        sandbox_id: tool.schema
          .string()
          .optional()
          .describe("Sandbox ID to configure. Defaults to the currently active sandbox."),
      },
      async execute(args) {
        const id = args.sandbox_id ?? requireSandbox(getActive).sandboxId;
        await cli.editSandbox($, id, { egress: args.rules });
        return `Egress rules updated for sandbox ${id}:\n${args.rules.map((r) => `  - ${r}`).join("\n")}`;
      },
    }),

    sandbox_bandwidth: tool({
      description:
        "Check bandwidth usage for a sandbox, showing bytes used, quota, remaining allowance, and whether the sandbox is bandwidth-capped.",
      args: {
        sandbox_id: tool.schema
          .string()
          .optional()
          .describe("Sandbox ID to check. Defaults to the currently active sandbox."),
      },
      async execute(args) {
        const id = args.sandbox_id ?? requireSandbox(getActive).sandboxId;
        const bw = (await cli.getBandwidth($, id)) as any;
        if (!bw) return `No bandwidth data available for sandbox ${id}.`;
        const used = bw.used_bytes ?? bw.used ?? 0;
        const quota = bw.quota_bytes ?? bw.quota ?? 0;
        const remaining = Math.max(0, quota - used);
        const capped = bw.capped ?? remaining <= 0;
        return [
          `Bandwidth for sandbox ${id}:`,
          `  Used:      ${fmtBytes(used)}`,
          `  Quota:     ${fmtBytes(quota)}`,
          `  Remaining: ${fmtBytes(remaining)}`,
          `  Capped:    ${capped ? "yes" : "no"}`,
        ].join("\n");
      },
    }),

    sandbox_shapes: tool({
      description:
        "List all available sandbox shapes (VM sizes). Shows the CPU, memory, and other resource specifications for each shape.",
      args: {},
      async execute() {
        const shapes = await cli.listShapes($);
        if (!shapes || shapes.length === 0) return "No shapes available.";
        return JSON.stringify(shapes, null, 2);
      },
    }),

    sandbox_images: tool({
      description:
        "List all available base images (rootfs) that can be used when creating a sandbox.",
      args: {},
      async execute() {
        const images = await cli.listRootfs($);
        if (!images || images.length === 0) return "No images available.";
        return JSON.stringify(images, null, 2);
      },
    }),

    sandbox_preview_url: tool({
      description:
        "Get the public HTTPS URL for a specific port on the active sandbox. Requires ingress to be enabled on the sandbox.",
      args: {
        port: tool.schema.number().describe("The port number to get the preview URL for"),
      },
      async execute(args) {
        const active = requireSandbox(getActive);
        const info = await cli.getSandbox($, active.sandboxId);
        if (!info.ingress_url_template) {
          return "Ingress is not enabled on this sandbox. Enable it first with sandbox_ingress.";
        }
        const url = info.ingress_url_template.replace("<port>", String(args.port));
        return `Preview URL for port ${args.port}: ${url}`;
      },
    }),

    sandbox_tunnel: tool({
      description:
        "Create a port-forwarding tunnel from the sandbox to localhost. Maps a remote port on the sandbox to a local port on the host machine.",
      args: {
        remote_port: tool.schema.number().describe("The port on the sandbox to forward"),
        local_port: tool.schema
          .number()
          .optional()
          .describe("The local port to listen on. Defaults to the same as remote_port."),
      },
      async execute(args) {
        const active = requireSandbox(getActive);
        const result = await cli.startTunnel(
          $,
          active.sandboxId,
          args.remote_port,
          args.local_port,
        );
        return `Tunnel established: localhost:${result.localPort} -> sandbox:${args.remote_port} (PID ${result.pid})`;
      },
    }),

    sandbox_sync: tool({
      description:
        "Start a bidirectional file sync session between a local directory and a directory inside the sandbox using mutagen.",
      args: {
        local_dir: tool.schema.string().describe("Local directory path to sync from"),
        remote_dir: tool.schema
          .string()
          .describe("Remote directory path inside the sandbox to sync to"),
        mode: tool.schema
          .string()
          .optional()
          .describe("Sync mode. Currently unused, reserved for future use."),
        exclude: tool.schema
          .array(tool.schema.string())
          .optional()
          .describe("List of glob patterns to exclude from sync (e.g. 'node_modules', '.git')"),
      },
      async execute(args) {
        const active = requireSandbox(getActive);
        const result = await cli.startSync($, active.sandboxId, args.local_dir, args.remote_dir, {
          mode: args.mode,
          exclude: args.exclude,
        });
        return `Sync started: ${args.local_dir} <-> sandbox:${args.remote_dir}${args.mode ? ` (${args.mode})` : ""}\nPID: ${result.pid}`;
      },
    }),

    // ----- Networks -----

    sandbox_network_create: tool({
      description:
        "Create a new private network that sandboxes can be attached to for secure inter-sandbox communication.",
      args: {
        name: tool.schema.string().describe("Name for the new network"),
      },
      async execute(args) {
        const net = await cli.createNetwork($, args.name);
        return `Network created.\n  ID:   ${net.id}\n  Name: ${net.name ?? args.name}`;
      },
    }),

    sandbox_network_list: tool({
      description: "List all private networks in the current CreateOS account.",
      args: {},
      async execute() {
        const nets = await cli.listNetworks($);
        if (nets.length === 0) return "No networks found.";
        return nets
          .map((n) => {
            const parts = [n.id];
            if (n.name) parts.push(n.name);
            return parts.join("  ");
          })
          .join("\n");
      },
    }),

    sandbox_network_show: tool({
      description:
        "Show detailed information about a specific network including its attached sandboxes.",
      args: {
        name: tool.schema.string().describe("Network name or ID to inspect"),
      },
      async execute(args) {
        const net = await cli.getNetwork($, args.name);
        return JSON.stringify(net, null, 2);
      },
    }),

    sandbox_network_attach: tool({
      description:
        "Attach the currently active sandbox to a private network, allowing it to communicate with other sandboxes on the same network.",
      args: {
        name: tool.schema.string().describe("Network name or ID to attach to"),
      },
      async execute(args) {
        const active = requireSandbox(getActive);
        await cli.attachNetwork($, active.sandboxId, args.name);
        return `Sandbox ${active.sandboxId} attached to network ${args.name}.`;
      },
    }),

    sandbox_network_detach: tool({
      description: "Detach the currently active sandbox from a private network.",
      args: {
        name: tool.schema.string().describe("Network name or ID to detach from"),
      },
      async execute(args) {
        const active = requireSandbox(getActive);
        await cli.detachNetwork($, active.sandboxId, args.name);
        return `Sandbox ${active.sandboxId} detached from network ${args.name}.`;
      },
    }),

    sandbox_network_delete: tool({
      description: "Delete a private network. All sandboxes must be detached first.",
      args: {
        name: tool.schema.string().describe("Network name or ID to delete"),
      },
      async execute(args) {
        await cli.deleteNetwork($, args.name);
        return `Network ${args.name} deleted.`;
      },
    }),

    // ----- Disks -----

    sandbox_disk_create: tool({
      description:
        "Register an S3-compatible disk that can be mounted into sandboxes. Requires S3 bucket credentials.",
      args: {
        name: tool.schema.string().describe("Name for the disk"),
        bucket: tool.schema.string().describe("S3 bucket name"),
        endpoint: tool.schema.string().describe("S3-compatible endpoint URL"),
        access_key: tool.schema.string().describe("S3 access key ID"),
        secret_key: tool.schema.string().describe("S3 secret access key"),
        region: tool.schema.string().optional().describe("S3 bucket region"),
        path_style: tool.schema
          .boolean()
          .optional()
          .describe("Use path-style S3 addressing instead of virtual-hosted"),
      },
      async execute(args) {
        const disk = await cli.createDisk($, {
          name: args.name,
          bucket: args.bucket,
          endpoint: args.endpoint,
          accessKey: args.access_key,
          secretKey: args.secret_key,
          region: args.region,
          pathStyle: args.path_style,
        });
        return `Disk created.\n  ID:   ${disk.id}\n  Name: ${disk.name ?? args.name}`;
      },
    }),

    sandbox_disk_list: tool({
      description: "List all registered disks in the current CreateOS account.",
      args: {},
      async execute() {
        const disks = await cli.listDisks($);
        if (disks.length === 0) return "No disks found.";
        return disks
          .map((d) => {
            const parts = [d.id];
            if (d.name) parts.push(d.name);
            return parts.join("  ");
          })
          .join("\n");
      },
    }),

    sandbox_disk_show: tool({
      description:
        "Show detailed information about a specific disk including its S3 configuration.",
      args: {
        name: tool.schema.string().describe("Disk name or ID to inspect"),
      },
      async execute(args) {
        const disk = await cli.getDisk($, args.name);
        return JSON.stringify(disk, null, 2);
      },
    }),

    sandbox_disk_delete: tool({
      description: "Delete a registered disk. The disk must be detached from all sandboxes first.",
      args: {
        name: tool.schema.string().describe("Disk name or ID to delete"),
      },
      async execute(args) {
        await cli.deleteDisk($, args.name);
        return `Disk ${args.name} deleted.`;
      },
    }),

    sandbox_disk_attach: tool({
      description: "Mount a registered disk into a sandbox at a specified path.",
      args: {
        disk_name: tool.schema.string().describe("Disk name or ID to mount"),
        mount_path: tool.schema
          .string()
          .describe("Filesystem path inside the sandbox where the disk will be mounted"),
        sandbox_id: tool.schema
          .string()
          .optional()
          .describe("Sandbox ID to mount the disk into. Defaults to the currently active sandbox."),
      },
      async execute(args) {
        const id = args.sandbox_id ?? requireSandbox(getActive).sandboxId;
        await cli.attachDisk($, id, args.disk_name, args.mount_path);
        return `Disk ${args.disk_name} mounted at ${args.mount_path} on sandbox ${id}.`;
      },
    }),

    sandbox_disk_detach: tool({
      description: "Unmount a disk from a sandbox.",
      args: {
        disk_name: tool.schema.string().describe("Disk name or ID to unmount"),
        mount_path: tool.schema.string().describe("The mount path to detach from"),
        sandbox_id: tool.schema
          .string()
          .optional()
          .describe("Sandbox ID to unmount from. Defaults to the currently active sandbox."),
      },
      async execute(args) {
        const id = args.sandbox_id ?? requireSandbox(getActive).sandboxId;
        await cli.detachDisk($, id, args.disk_name, args.mount_path);
        return `Disk ${args.disk_name} detached from ${args.mount_path} on sandbox ${id}.`;
      },
    }),

    // ----- Devices -----

    sandbox_device_register: tool({
      description:
        "Register the current machine as a device so it can join private networks alongside sandboxes via VPN.",
      args: {
        name: tool.schema.string().optional().describe("Human-readable name for the device"),
      },
      async execute(args) {
        // Check if already registered
        const existing = await cli.listDevices($);
        if (existing.length > 0) {
          return `Device already registered: ${existing[0].id}${existing[0].name ? ` (${existing[0].name})` : ""}`;
        }
        const output = await cli.registerDevice($, args.name);
        return output || "Device registered.";
      },
    }),

    sandbox_device_status: tool({
      description: "Check the registration and connection status of the current device.",
      args: {},
      async execute() {
        const devices = await cli.listDevices($);
        if (devices.length === 0) return "No device registered.";
        return devices
          .map((d) => {
            const parts = [d.id];
            if (d.name) parts.push(d.name);
            return parts.join("  ");
          })
          .join("\n");
      },
    }),

    sandbox_vpn_up: tool({
      description:
        "Get the command to bring up the VPN tunnel on this device. The VPN must be started manually by the user because it requires elevated privileges.",
      args: {},
      async execute() {
        return [
          "To start the VPN tunnel, run the following command in your terminal:",
          "",
          "  createos sb vpn up",
          "",
          "This requires sudo/admin privileges and must be run interactively.",
        ].join("\n");
      },
    }),

    sandbox_device_attach: tool({
      description:
        "Attach the current device to a private network, enabling VPN connectivity to sandboxes on that network.",
      args: {
        network: tool.schema.string().describe("Network name or ID to attach the device to"),
      },
      async execute(args) {
        const devices = await cli.listDevices($);
        if (devices.length === 0) {
          throw new Error("No device registered. Use sandbox_device_register first.");
        }
        const devId = devices[0].id ?? devices[0].device_id!;
        await cli.attachDeviceToNetwork($, devId, args.network);
        return `Device attached to network "${args.network}".\nRun \`createos sb vpn up\` to access sandbox IPs directly.`;
      },
    }),

    sandbox_device_detach: tool({
      description: "Detach the current device from a private network.",
      args: {
        network: tool.schema.string().describe("Network name or ID to detach the device from"),
      },
      async execute(args) {
        const devices = await cli.listDevices($);
        if (devices.length === 0) {
          throw new Error("No device registered. Use sandbox_device_register first.");
        }
        const devId = devices[0].id ?? devices[0].device_id!;
        await cli.detachDeviceFromNetwork($, devId, args.network);
        return `Device detached from network "${args.network}".`;
      },
    }),

    // =====================================================================
    // Offload engine — cos semantics (staging, egress, keepalive, auto-destroy)
    // =====================================================================

    sandbox_offload: tool({
      description:
        "Run a command in a THROWAWAY sandbox and destroy it: stage a local directory to /work, " +
        "run the command with a keepalive that survives a dropped stream, optionally pull artifacts " +
        "back, then destroy the box. Use this for work with a finish line — a build, a test suite, " +
        "a script. Prefer it over sandbox_create + sandbox_exec, which leaks boxes and drops egress " +
        "restriction. Big directories (.git, node_modules, target, venvs, media) are excluded from " +
        "the upload automatically.",
      args: {
        dir: tool.schema.string().describe("Local directory to stage into the box at /work"),
        command: tool.schema
          .string()
          .describe("Shell command to run, with /work as the working directory"),
        shape: tool.schema
          .string()
          .optional()
          .describe("VM size. Defaults to 's-1vcpu-1gb'; use 's-2vcpu-2gb' for compiled builds"),
        rootfs: tool.schema.string().optional().describe("Base image. Defaults to 'devbox:1'"),
        egress_presets: tool.schema
          .array(tool.schema.string())
          .optional()
          .describe("Allow only what these ecosystems need: python-uv | rust-cargo | npm | github"),
        egress: tool.schema
          .array(tool.schema.string())
          .optional()
          .describe("Extra domains the box may reach; composes with egress_presets"),
        egress_all: tool.schema
          .boolean()
          .optional()
          .describe(
            "Unrestricted egress. Only for code you trust — it removes the isolation this tool exists for",
          ),
        exclude: tool.schema
          .array(tool.schema.string())
          .optional()
          .describe("Extra upload excludes"),
        out: tool.schema
          .string()
          .optional()
          .describe("Path under /work to pull back into dir when the command finishes"),
        swap_gb: tool.schema
          .number()
          .optional()
          .describe("Swap to add before running — OOM headroom for compiled builds"),
        keep_on_fail: tool.schema
          .boolean()
          .optional()
          .describe("Keep the box when the command exits non-zero, for debugging"),
      },
      async execute(args) {
        const res = await engine.offload({
          dir: args.dir,
          command: args.command,
          shape: args.shape,
          rootfs: args.rootfs,
          egress: args.egress,
          egressPresets: args.egress_presets,
          egressAll: args.egress_all,
          exclude: args.exclude,
          out: args.out,
          swapGB: args.swap_gb,
          keepOnFail: args.keep_on_fail,
        });
        const lines = [
          `sandbox ${res.sandboxId} — exit code ${res.exitCode ?? "unknown"}${res.kept ? " (box KEPT)" : " (box destroyed)"}`,
        ];
        for (const w of res.warnings) lines.push(`warning: ${w}`);
        if (res.pulledArtifacts) lines.push(`pulled ${args.out} back into ${args.dir}`);
        lines.push("", res.log || "(no output)");
        return lines.join("\n");
      },
    }),

    sandbox_fanout: tool({
      description:
        "Run each command in its OWN throwaway sandbox, in parallel, from the same staged directory. " +
        "For test shards, config matrices, and batch jobs. Every box is destroyed when its command " +
        "finishes. Concurrency is capped because the control plane limits how many boxes may run at once.",
      args: {
        dir: tool.schema.string().describe("Local directory staged into every box at /work"),
        commands: tool.schema.array(tool.schema.string()).describe("One command per box"),
        jobs: tool.schema.number().optional().describe("Max boxes running at once. Defaults to 2"),
        shape: tool.schema.string().optional().describe("VM size for every box"),
        rootfs: tool.schema.string().optional().describe("Base image for every box"),
        egress_presets: tool.schema
          .array(tool.schema.string())
          .optional()
          .describe("python-uv | rust-cargo | npm | github"),
        egress: tool.schema
          .array(tool.schema.string())
          .optional()
          .describe("Extra allowed domains"),
        egress_all: tool.schema
          .boolean()
          .optional()
          .describe("Unrestricted egress — trusted code only"),
        exclude: tool.schema
          .array(tool.schema.string())
          .optional()
          .describe("Extra upload excludes"),
      },
      async execute(args) {
        const results = await engine.fanout({
          dir: args.dir,
          commands: args.commands,
          jobs: args.jobs,
          shape: args.shape,
          rootfs: args.rootfs,
          egress: args.egress,
          egressPresets: args.egress_presets,
          egressAll: args.egress_all,
          exclude: args.exclude,
        });
        return results
          .map((r) => {
            const box = r.sandboxId ? ` ${r.sandboxId}` : "";
            const head = `[exit ${r.exitCode ?? "unknown"}]${box}${r.kept ? " BOX KEPT" : ""} ${r.command}`;
            // A retained box is the one thing the caller must act on, so its id
            // and cleanup instructions cannot be dropped from the summary.
            const notes = r.warnings.map((w) => `warning: ${w}`);
            const tail = r.log.split("\n").slice(-20).join("\n");
            return [head, ...notes, tail].join("\n");
          })
          .join("\n\n---\n\n");
      },
    }),

    // =====================================================================
    // Desktop / computer use
    // =====================================================================

    sandbox_desktop: tool({
      description:
        "Mint a live noVNC URL for the graphical desktop in a sandbox, so the user can watch or drive " +
        "it in a browser. The sandbox must have been created on a desktop image (rootfs 'desktop:1'). " +
        "Enables ingress and waits for the desktop stack to finish booting.",
      args: {
        sandbox_id: tool.schema
          .string()
          .optional()
          .describe("Sandbox to connect to. Defaults to the active one"),
        screen: tool.schema.string().optional().describe("Screen id. Defaults to 'screen-0'"),
      },
      async execute(args) {
        const id = args.sandbox_id ?? requireSandbox(getActive).sandboxId;
        const { url, expiresAt } = await engine.desktopConnect(id, args.screen);
        return (
          `Desktop URL: ${url}\n\n` +
          `Anyone holding this link can drive the desktop, and the token expires ${expiresAt}. ` +
          `Re-running this tool mints a fresh link.`
        );
      },
    }),

    sandbox_computer: tool({
      description:
        "Send one computer-use action to the desktop in a sandbox — read the screen geometry, move or " +
        "click the mouse, type text, press a key chord, open a URL, or list windows. Run sandbox_desktop " +
        "first; it waits for the desktop to be ready. Coordinates are raw X11 pixels — read the bounds " +
        "from the 'screen' op rather than assuming them.",
      args: {
        op: tool.schema
          .enum(["screen", "cursor", "windows", "move", "click", "type", "key", "open"])
          .describe("The action to perform"),
        x: tool.schema.number().optional().describe("X coordinate, for move and click"),
        y: tool.schema.number().optional().describe("Y coordinate, for move and click"),
        text: tool.schema.string().optional().describe("Text to type, for the 'type' op"),
        keys: tool.schema
          .array(tool.schema.string())
          .optional()
          .describe("Key chord, e.g. ['ctrl','l']"),
        target: tool.schema.string().optional().describe("URL or path, for the 'open' op"),
        sandbox_id: tool.schema
          .string()
          .optional()
          .describe("Sandbox to drive. Defaults to the active one"),
        screen: tool.schema.string().optional().describe("Screen id. Defaults to 'screen-0'"),
      },
      async execute(args) {
        const id = args.sandbox_id ?? requireSandbox(getActive).sandboxId;
        let action: engine.ComputerOp;
        switch (args.op) {
          case "move":
            if (args.x === undefined || args.y === undefined) throw new Error("move needs x and y");
            action = { op: "move", x: args.x, y: args.y };
            break;
          case "click":
            action = { op: "click", x: args.x, y: args.y };
            break;
          case "type":
            if (args.text === undefined) throw new Error("type needs text");
            action = { op: "type", text: args.text };
            break;
          case "key":
            if (!args.keys?.length) throw new Error("key needs a non-empty keys array");
            action = { op: "key", keys: args.keys };
            break;
          case "open":
            if (!args.target) throw new Error("open needs a target");
            action = { op: "open", target: args.target };
            break;
          default:
            action = { op: args.op };
        }
        const res = await engine.computer(id, action, args.screen);
        return typeof res === "string" ? res : JSON.stringify(res, null, 2);
      },
    }),

    sandbox_screenshot: tool({
      description:
        "Capture the desktop in a sandbox as a PNG and return its local path. Read that path to " +
        "actually see the screen. Take one before and after any action you are unsure about — " +
        "nothing else confirms that a click landed where you meant.",
      args: {
        path: tool.schema
          .string()
          .optional()
          .describe("Where to write the PNG. Defaults to a temp file"),
        sandbox_id: tool.schema
          .string()
          .optional()
          .describe("Sandbox to capture. Defaults to the active one"),
        screen: tool.schema.string().optional().describe("Screen id. Defaults to 'screen-0'"),
      },
      async execute(args) {
        const id = args.sandbox_id ?? requireSandbox(getActive).sandboxId;
        const out = args.path ?? `${tmpdir()}/createos-${shortId(id)}-${Date.now()}.png`;
        await engine.screenshot(id, out, args.screen);
        return `Screenshot written to ${out} — read that path to see the screen.`;
      },
    }),
  };
}
