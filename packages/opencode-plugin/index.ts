/**
 * @createos/opencode — run OpenCode's tools inside a remote, ephemeral CreateOS Sandbox.
 *
 * CLI-only: every operation goes through `createos` CLI. No HTTP client,
 * no API key env vars — just `createos login` and go.
 */

import type { Plugin } from "@opencode-ai/plugin";
import * as cli from "./src/cli.ts";
import { createTools, type ToolSandbox } from "./src/tools.ts";
import { shortId } from "./src/util.ts";

interface ActiveSandbox {
  sandboxId: string;
  cwd: string;
}

export const CreateOSPlugin: Plugin = async ({ project, client, $, directory }) => {
  let active: ActiveSandbox | null = null;
  let initPromise: Promise<void> | null = null;
  const hostCwd = directory;

  await client.app.log({
    body: { service: "createos", level: "info", message: "Plugin initialized" },
  });

  if (process.env.CREATEOS_ENABLED === "false") {
    await client.app.log({
      body: { service: "createos", level: "info", message: "Disabled via CREATEOS_ENABLED=false" },
    });
    return {};
  }

  // Lazy sandbox init — triggered on first tool call
  async function ensureSandbox(): Promise<ActiveSandbox> {
    if (active) return active;

    if (!initPromise) {
      initPromise = (async () => {
        if (!(await cli.isCreateOSInstalled($))) {
          await client.app.log({
            body: { service: "createos", level: "info", message: "CLI not found — installing..." },
          });
          if (!(await cli.autoInstallCLI($))) {
            throw new Error(
              "Failed to install CreateOS CLI. Run: curl -sfL https://raw.githubusercontent.com/NodeOps-app/createos-cli/main/install.sh | sh",
            );
          }
        }

        if (!(await cli.isLoggedIn($))) {
          throw new Error("Not logged in to CreateOS. Run: createos login");
        }

        const shape = process.env.CREATEOS_SHAPE ?? "s-2vcpu-2gb";
        const rootfs = process.env.CREATEOS_ROOTFS;
        const networkFlag = process.env.CREATEOS_NETWORKS;
        const networks = networkFlag
          ? networkFlag
              .split(",")
              .map((n) => n.trim())
              .filter(Boolean)
          : undefined;

        await client.app.log({
          body: { service: "createos", level: "info", message: `Creating sandbox (${shape})...` },
        });

        const sandbox = await cli.createSandbox($, {
          shape,
          rootfs,
          ingress: true,
          networks,
          name: `opencode-${shortId(project?.id ?? "session")}`,
        });

        const cwd = "/root/workspace";
        await cli.sandboxExec($, sandbox.id, `mkdir -p ${cwd}`);

        active = { sandboxId: sandbox.id, cwd };

        await client.app.log({
          body: {
            service: "createos",
            level: "info",
            message: `Sandbox ready: ${shortId(sandbox.id)} (${shape})${sandbox.ingress_url_template ? ` · ingress: ${sandbox.ingress_url_template}` : ""}`,
          },
        });
      })();
    }

    await initPromise;
    if (!active) throw new Error("Sandbox initialization failed");
    return active;
  }

  // Build tools with lazy init wrapper
  const getActive = (): ToolSandbox | null => active;
  const baseTools = createTools($, getActive);

  const tools: Record<string, any> = {};
  for (const [name, def] of Object.entries(baseTools)) {
    const original = (def as any).execute;
    tools[name] = {
      ...def,
      execute: async (args: any, ctx: any) => {
        await ensureSandbox();
        return original(args, ctx);
      },
    };
  }

  return {
    "experimental.session.compacting": async (_input: any, output: any) => {
      if (!active) return;
      output.context.push(
        `## CreateOS Sandbox Environment\n` +
          `Sandbox: ${active.sandboxId}\n` +
          `Cwd: ${active.cwd}\n` +
          `Host dir: ${hostCwd}\n` +
          `All tools run remotely in this sandbox.\n` +
          `\n` +
          `Quick rules:\n` +
          `- Work with a finish line (a build, a test suite, a script) → sandbox_offload dir="${hostCwd}" command="…". ` +
          `ONE call: it creates the box, stages the dir, runs, and destroys the box. Do not hand-roll that out of ` +
          `sandbox_create + sandbox_exec — that drops egress restriction, the keepalive, and the guaranteed destroy.\n` +
          `- Several variants of that at once (shards, a config matrix) → sandbox_fanout\n` +
          `- "mount/sync this dir" → sandbox_sync local_dir="${hostCwd}" remote_dir="/root/project"\n` +
          `- Port access → sandbox_preview_url (public URL) > sandbox_tunnel (localhost) > device VPN (last resort)\n` +
          `- Multi-node → sandbox_network_create + sandbox_create with network + sandbox_exec on other sandboxes`,
      );
    },

    event: async ({ event }: { event: { type: string } }) => {
      if (event.type === "session.deleted" && active) {
        try {
          await cli.cleanupTempKey($);
        } catch {}
        try {
          await cli.destroySandbox($, active.sandboxId);
        } catch {}
        active = null;
      }
    },

    tool: tools,
  };
};
