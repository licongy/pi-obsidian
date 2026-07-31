import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  defineTool,
  type AgentToolResult,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { debug } from "./debug.js";
import { BridgeError, createBridgeClient, type BridgeClient } from "./bridge-client.js";
import { loadConfig } from "./config.js";
import { SERVER_VERSION } from "./ws-protocol.js";

const PLUGIN_DIR_NAME = "pi-obsidian-bridge";

function resolveVaultRoot(start: string): string {
  let dir = start;
  for (;;) {
    try {
      if (existsSync(path.join(dir, ".obsidian"))) return dir;
    } catch {
      // ignore stat errors
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return start;
}

function toolText(text: string): AgentToolResult<Record<string, never>> {
  return { content: [{ type: "text", text }], details: {} };
}

function describeError(e: unknown): string {
  if (e instanceof BridgeError) return `${e.code}: ${e.message || e.code}`;
  return e instanceof Error ? e.message : String(e);
}

function ensurePluginInjected(pi: ExtensionAPI): boolean {
  const root = resolveVaultRoot(process.cwd());
  const dir = path.join(root, ".obsidian", "plugins", PLUGIN_DIR_NAME);
  const manifestPath = path.join(dir, "manifest.json");
  try {
    if (existsSync(manifestPath)) {
      debug("plugin already present at", dir);
      return false;
    }
    mkdirSync(dir, { recursive: true });
    const here = path.dirname(fileURLToPath(import.meta.url));
    writeFileSync(manifestPath, readFileSync(path.join(here, "obsidian-side", "manifest.json")));
    writeFileSync(
      path.join(dir, "main.js"),
      readFileSync(path.join(here, "obsidian-side", "main.js")),
    );
    debug("injected plugin to", dir);
    return true;
  } catch (e) {
    debug("plugin injection failed:", describeError(e));
    return false;
  }
}

function registerPing(pi: ExtensionAPI, bridge: BridgeClient): void {
  const parameters = Type.Object({});
  pi.registerTool(
    defineTool({
      name: "obsidian.ping",
      label: "Obsidian bridge ping",
      description:
        "Check whether the pi-obsidian bridge is connected to a running Obsidian instance. Returns the bridge server version, vault name, and advertised capabilities. Non-destructive; use it to verify the bridge is up before calling other obsidian.* tools.",
      parameters,
      async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
        try {
          const res = (await bridge.request<{
            pong?: boolean;
            server?: string;
            vault?: string;
          }>("ping", {}, 5000)) as { pong?: boolean; server?: string; vault?: string };
          return toolText(
            `pong — bridge up. server=${res.server || SERVER_VERSION} vault=${res.vault || "?"} capabilities=[${bridge.capabilities.join(",")}]`,
          );
        } catch (e) {
          return toolText(`obsidian.ping failed: ${describeError(e)}`);
        }
      },
    }),
  );
}

function registerUiNotify(pi: ExtensionAPI, bridge: BridgeClient): void {
  const parameters = Type.Object({
    message: Type.String({
      description: "Message text to show in an Obsidian Notice.",
    }),
    timeoutMs: Type.Optional(
      Type.Number({
        description: "How long to show the notice, in milliseconds. Default 5000.",
      }),
    ),
  });
  pi.registerTool(
    defineTool({
      name: "obsidian.ui.notify",
      label: "Obsidian notice",
      description:
        "Show a transient notification (Obsidian Notice) to the user. Use after completing a task to surface a result, cost, or confirmation. Non-destructive.",
      promptGuidelines: [
        "Prefer obsidian.ui.notify to tell the user a task is done rather than ending the turn silently.",
      ],
      parameters,
      async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
        const message = String(params.message ?? "");
        const timeoutMs = typeof params.timeoutMs === "number" ? params.timeoutMs : 5000;
        try {
          await bridge.request("ui.notify", { message, timeoutMs }, 5000);
          return toolText(`Shown in Obsidian: "${message}"`);
        } catch (e) {
          return toolText(`obsidian.ui.notify failed: ${describeError(e)}`);
        }
      },
    }),
  );
}

export default function bridgeExtension(pi: ExtensionAPI): void {
  const cfg = loadConfig(process.cwd());
  debug("config:", JSON.stringify(cfg));

  const bridge = createBridgeClient(pi);

  pi.on("session_shutdown", () => {
    try {
      bridge.dispose();
    } catch {
      // ignore
    }
  });

  const justInjected = ensurePluginInjected(pi);
  if (justInjected) {
    pi.on("session_start", (_event, ctx) => {
      try {
        if (ctx.hasUI) {
          ctx.ui.notify(
            'pi-obsidian bridge plugin injected. Enable it once: Settings -> Community plugins -> "pi-obsidian bridge", then run obsidian.ping.',
            "info",
          );
        }
      } catch {
        // ignore
      }
    });
  }

  registerPing(pi, bridge);
  registerUiNotify(pi, bridge);

  debug("registered tools: obsidian.ping, obsidian.ui.notify");
}
