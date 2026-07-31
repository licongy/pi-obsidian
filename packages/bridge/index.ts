import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";
import {
  defineTool,
  type AgentToolResult,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { debug } from "./debug.js";
import { BridgeError, createBridgeClient, type BridgeClient } from "./bridge-client.js";
import { loadConfig, type BridgeConfig } from "./config.js";
import { validateVaultPath } from "./path-safety.js";
import { ACTIONS, SERVER_VERSION } from "./ws-protocol.js";

const PLUGIN_DIR_NAME = "pi-obsidian-bridge";

/* ---- helpers ---- */

function resolveVaultRoot(start: string): string {
  let dir = start;
  for (;;) {
    try {
      if (existsSync(nodePath.join(dir, ".obsidian"))) return dir;
    } catch {
      // ignore stat errors
    }
    const parent = nodePath.dirname(dir);
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
  const dir = nodePath.join(root, ".obsidian", "plugins", PLUGIN_DIR_NAME);
  const manifestPath = nodePath.join(dir, "manifest.json");
  try {
    if (existsSync(manifestPath)) {
      debug("plugin already present at", dir);
      return false;
    }
    mkdirSync(dir, { recursive: true });
    const here = nodePath.dirname(fileURLToPath(import.meta.url));
    writeFileSync(
      manifestPath,
      readFileSync(nodePath.join(here, "obsidian-side", "manifest.json")),
    );
    writeFileSync(
      nodePath.join(dir, "main.js"),
      readFileSync(nodePath.join(here, "obsidian-side", "main.js")),
    );
    debug("injected plugin to", dir);
    return true;
  } catch (e) {
    debug("plugin injection failed:", describeError(e));
    return false;
  }
}

async function confirm(
  ctx: ExtensionContext,
  cfg: BridgeConfig,
  title: string,
  message: string,
): Promise<boolean> {
  if (!cfg.confirmDestructive) return true;
  if (!ctx.hasUI) return true;
  return ctx.ui.confirm(title, message);
}

/* ---- tool registration ---- */

function registerPing(pi: ExtensionAPI, bridge: BridgeClient): void {
  pi.registerTool(
    defineTool({
      name: "obsidian.ping",
      label: "Obsidian bridge ping",
      description:
        "Check whether the pi-obsidian bridge is connected to a running Obsidian instance. Returns the bridge server version, vault name, and advertised capabilities. Non-destructive; use it to verify the bridge is up before calling other obsidian.* tools.",
      parameters: Type.Object({}),
      async execute() {
        try {
          const res = await bridge.request<{
            pong?: boolean;
            server?: string;
            vault?: string;
          }>(ACTIONS.PING, {}, 5000);
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
  pi.registerTool(
    defineTool({
      name: "obsidian.ui.notify",
      label: "Obsidian notice",
      description:
        "Show a transient notification (Obsidian Notice) to the user. Use after completing a task to surface a result, cost, or confirmation. Non-destructive.",
      promptGuidelines: [
        "Prefer obsidian.ui.notify to tell the user a task is done rather than ending the turn silently.",
      ],
      parameters: Type.Object({
        message: Type.String({
          description: "Message text to show in an Obsidian Notice.",
        }),
        timeoutMs: Type.Optional(
          Type.Number({
            description: "How long to show the notice, in milliseconds. Default 5000.",
          }),
        ),
      }),
      async execute(_id, params) {
        const message = String(params.message ?? "");
        const timeoutMs = typeof params.timeoutMs === "number" ? params.timeoutMs : 5000;
        try {
          await bridge.request(ACTIONS.UI_NOTIFY, { message, timeoutMs }, 5000);
          return toolText(`Shown in Obsidian: "${message}"`);
        } catch (e) {
          return toolText(`obsidian.ui.notify failed: ${describeError(e)}`);
        }
      },
    }),
  );
}

function registerStatusBarSet(pi: ExtensionAPI, bridge: BridgeClient): void {
  pi.registerTool(
    defineTool({
      name: "obsidian.ui.status_bar.set",
      label: "Obsidian status bar item",
      description:
        "Create or update a persistent named status bar item in Obsidian. The item survives across Pi sessions and Obsidian reloads because the bridge plugin owns it. Use for live indicators like cost tracking, session status, or build state. Non-destructive.",
      parameters: Type.Object({
        key: Type.String({
          description:
            "Stable identifier for this status bar item. Reusing a key updates the same item.",
        }),
        text: Type.String({
          description: "Text to display in the status bar item.",
        }),
        cls: Type.Optional(
          Type.String({
            description: "Optional CSS class to add to the item element.",
          }),
        ),
      }),
      async execute(_id, params) {
        try {
          await bridge.request(
            ACTIONS.UI_STATUS_BAR_SET,
            { key: params.key, text: params.text, cls: params.cls },
            5000,
          );
          return toolText(`Status bar item "${params.key}" set to: ${params.text}`);
        } catch (e) {
          return toolText(`obsidian.ui.status_bar.set failed: ${describeError(e)}`);
        }
      },
    }),
  );
}

function registerStatusBarClear(pi: ExtensionAPI, bridge: BridgeClient): void {
  pi.registerTool(
    defineTool({
      name: "obsidian.ui.status_bar.clear",
      label: "Obsidian status bar clear",
      description:
        "Remove a named status bar item previously created by obsidian.ui.status_bar.set. Non-destructive.",
      parameters: Type.Object({
        key: Type.String({
          description: "The key of the status bar item to remove.",
        }),
      }),
      async execute(_id, params) {
        try {
          await bridge.request(ACTIONS.UI_STATUS_BAR_CLEAR, { key: params.key }, 5000);
          return toolText(`Status bar item "${params.key}" cleared.`);
        } catch (e) {
          return toolText(`obsidian.ui.status_bar.clear failed: ${describeError(e)}`);
        }
      },
    }),
  );
}

function registerOpenNote(pi: ExtensionAPI, bridge: BridgeClient): void {
  pi.registerTool(
    defineTool({
      name: "obsidian.ui.open_note",
      label: "Obsidian open note",
      description:
        "Open a note in Obsidian's editor. Useful for directing the user's attention to a specific file after an operation. Non-destructive.",
      parameters: Type.Object({
        path: Type.String({
          description: "Vault-relative path of the note to open (e.g. 'Inbox/Note.md').",
        }),
        newLeaf: Type.Optional(
          Type.Boolean({
            description: "If true, open in a new tab. Default false (same tab).",
          }),
        ),
      }),
      async execute(_id, params) {
        try {
          await bridge.request(
            ACTIONS.UI_OPEN_NOTE,
            { path: params.path, newLeaf: params.newLeaf ?? false },
            5000,
          );
          return toolText(`Opened note in Obsidian: ${params.path}`);
        } catch (e) {
          return toolText(`obsidian.ui.open_note failed: ${describeError(e)}`);
        }
      },
    }),
  );
}

function registerExecuteCommand(pi: ExtensionAPI, bridge: BridgeClient): void {
  pi.registerTool(
    defineTool({
      name: "obsidian.ui.execute_command",
      label: "Obsidian execute command",
      description:
        "Execute an Obsidian command by its ID (e.g. 'editor:insert-link', 'app:go-back'). This is the structured way to trigger Obsidian UI actions without eval. Destructiveness depends on the command.",
      parameters: Type.Object({
        commandId: Type.String({
          description: "The Obsidian command ID to execute.",
        }),
      }),
      async execute(_id, params) {
        try {
          await bridge.request(ACTIONS.UI_EXECUTE_COMMAND, { commandId: params.commandId }, 10000);
          return toolText(`Executed Obsidian command: ${params.commandId}`);
        } catch (e) {
          return toolText(`obsidian.ui.execute_command failed: ${describeError(e)}`);
        }
      },
    }),
  );
}

function registerReadNote(pi: ExtensionAPI, bridge: BridgeClient, cfg: BridgeConfig): void {
  pi.registerTool(
    defineTool({
      name: "obsidian.read_note",
      label: "Obsidian read note",
      description:
        "Read the content of a note from the Obsidian vault. Non-destructive. For heavy vault operations consider pairing with @bacnh85/pi-obsidian.",
      parameters: Type.Object({
        path: Type.String({
          description: "Vault-relative path of the note (e.g. 'Inbox/Note.md').",
        }),
        maxBytes: Type.Optional(
          Type.Number({
            description:
              "Maximum bytes to read. Prevents context overflow on large notes. Default 100000.",
          }),
        ),
      }),
      async execute(_id, params) {
        const root = resolveVaultRoot(process.cwd());
        const check = validateVaultPath(params.path, root, cfg);
        if (!check.ok) return toolText(`obsidian.read_note failed: ${check.code}`);
        try {
          const res = await bridge.request<{
            content: string;
            stat: { size: number; mtime: number };
            truncated?: boolean;
          }>(ACTIONS.READ_NOTE, { path: check.normalized, maxBytes: params.maxBytes });
          return toolText(
            `--- ${check.normalized} (${res.stat.size} bytes${res.truncated ? ", truncated" : ""}) ---\n${res.content}`,
          );
        } catch (e) {
          return toolText(`obsidian.read_note failed: ${describeError(e)}`);
        }
      },
    }),
  );
}

function registerWriteNote(pi: ExtensionAPI, bridge: BridgeClient, cfg: BridgeConfig): void {
  pi.registerTool(
    defineTool({
      name: "obsidian.write_note",
      label: "Obsidian write note",
      description:
        "Create or overwrite a note in the Obsidian vault. Destructive: overwrites existing content. The user is asked to confirm before the write is sent.",
      parameters: Type.Object({
        path: Type.String({
          description: "Vault-relative path of the note (e.g. 'Projects/New.md').",
        }),
        content: Type.String({
          description: "Full content to write.",
        }),
        createFolders: Type.Optional(
          Type.Boolean({
            description: "If true (default), create parent folders as needed.",
          }),
        ),
      }),
      async execute(_id, params, _signal, _onUpdate, ctx) {
        const root = resolveVaultRoot(process.cwd());
        const check = validateVaultPath(params.path, root, cfg);
        if (!check.ok) return toolText(`obsidian.write_note failed: ${check.code}`);
        const ok = await confirm(
          ctx,
          cfg,
          "Obsidian write",
          `Write ${params.content.length} chars to ${check.normalized}?`,
        );
        if (!ok) return toolText("Cancelled by user.");
        try {
          const res = await bridge.request<{ path: string; created: boolean }>(ACTIONS.WRITE_NOTE, {
            path: check.normalized,
            content: params.content,
            createFolders: params.createFolders ?? true,
          });
          return toolText(`${res.created ? "Created" : "Updated"} note: ${res.path}`);
        } catch (e) {
          return toolText(`obsidian.write_note failed: ${describeError(e)}`);
        }
      },
    }),
  );
}

function registerSearchNotes(pi: ExtensionAPI, bridge: BridgeClient): void {
  pi.registerTool(
    defineTool({
      name: "obsidian.search_notes",
      label: "Obsidian search notes",
      description:
        "Search the Obsidian vault for notes containing a substring. Returns matching paths and excerpts. Non-destructive.",
      parameters: Type.Object({
        query: Type.String({
          description: "Substring to search for (case-insensitive).",
        }),
        limit: Type.Optional(
          Type.Number({
            description: "Maximum number of matches to return. Default 50.",
          }),
        ),
      }),
      async execute(_id, params) {
        try {
          const res = await bridge.request<{
            matches: { path: string; score: number; excerpt: string }[];
          }>(ACTIONS.SEARCH_NOTES, { query: params.query, limit: params.limit });
          if (res.matches.length === 0) {
            return toolText(`No notes found matching "${params.query}".`);
          }
          const lines = res.matches.map((m) => `  ${m.path}: …${m.excerpt}…`);
          return toolText(
            `Found ${res.matches.length} match(es) for "${params.query}":\n${lines.join("\n")}`,
          );
        } catch (e) {
          return toolText(`obsidian.search_notes failed: ${describeError(e)}`);
        }
      },
    }),
  );
}

function registerAppendDaily(pi: ExtensionAPI, bridge: BridgeClient, cfg: BridgeConfig): void {
  pi.registerTool(
    defineTool({
      name: "obsidian.append_daily",
      label: "Obsidian append to daily note",
      description:
        "Append text to today's daily note. Resolves the daily note path from the core Daily Notes plugin config, falling back to YYYY-MM-DD.md at vault root. Destructive: the user is asked to confirm.",
      parameters: Type.Object({
        content: Type.String({
          description: "Text to append to today's daily note.",
        }),
        format: Type.Optional(
          Type.String({
            description:
              "Override the date format (e.g. 'YYYY-MM-DD'). If omitted, reads from Daily Notes config.",
          }),
        ),
      }),
      async execute(_id, params, _signal, _onUpdate, ctx) {
        const ok = await confirm(
          ctx,
          cfg,
          "Obsidian append daily",
          `Append ${params.content.length} chars to today's daily note?`,
        );
        if (!ok) return toolText("Cancelled by user.");
        try {
          const res = await bridge.request<{ path: string }>(ACTIONS.APPEND_DAILY, {
            content: params.content,
            format: params.format,
          });
          return toolText(`Appended to daily note: ${res.path}`);
        } catch (e) {
          return toolText(`obsidian.append_daily failed: ${describeError(e)}`);
        }
      },
    }),
  );
}

function registerCallPlugin(pi: ExtensionAPI, bridge: BridgeClient, cfg: BridgeConfig): void {
  pi.registerTool(
    defineTool({
      name: "obsidian.call_plugin",
      label: "Obsidian call plugin API",
      description:
        "Call a named method on an Obsidian plugin's exposed API with JSON-serializable arguments. This is the structured, safe alternative to eval — only named methods are invoked, not arbitrary code. Requires call_plugin to be enabled in config.",
      parameters: Type.Object({
        pluginId: Type.String({
          description: "The Obsidian plugin ID (e.g. 'dataview', 'tasks').",
        }),
        method: Type.String({
          description: "The method name to call on the plugin's exposed API.",
        }),
        args: Type.Optional(
          Type.Array(Type.Unknown(), {
            description: "Arguments to pass (JSON-serializable array).",
          }),
        ),
      }),
      async execute(_id, params, _signal, _onUpdate, ctx) {
        if (cfg.pluginWhitelist.length > 0 && !cfg.pluginWhitelist.includes(params.pluginId)) {
          return toolText(
            `obsidian.call_plugin failed: plugin "${params.pluginId}" is not in the whitelist.`,
          );
        }
        if (cfg.confirmPluginCalls && ctx.hasUI) {
          const ok = await ctx.ui.confirm(
            "Obsidian plugin call",
            `Call ${params.pluginId}.${params.method}(${params.args ? params.args.length : 0} args)?`,
          );
          if (!ok) return toolText("Cancelled by user.");
        }
        try {
          const res = await bridge.request<{ result: unknown }>(ACTIONS.CALL_PLUGIN, {
            pluginId: params.pluginId,
            method: params.method,
            args: params.args || [],
          });
          return toolText(
            `call_plugin ${params.pluginId}.${params.method} result: ${JSON.stringify(res.result)}`,
          );
        } catch (e) {
          return toolText(`obsidian.call_plugin failed: ${describeError(e)}`);
        }
      },
    }),
  );
}

/* ---- factory ---- */

type ToolRegistrar = (pi: ExtensionAPI, bridge: BridgeClient, cfg: BridgeConfig) => void;

const REGISTRARS: Record<string, ToolRegistrar> = {
  [ACTIONS.PING]: (pi, bridge) => registerPing(pi, bridge),
  [ACTIONS.UI_NOTIFY]: (pi, bridge) => registerUiNotify(pi, bridge),
  [ACTIONS.UI_STATUS_BAR_SET]: (pi, bridge) => registerStatusBarSet(pi, bridge),
  [ACTIONS.UI_STATUS_BAR_CLEAR]: (pi, bridge) => registerStatusBarClear(pi, bridge),
  [ACTIONS.UI_OPEN_NOTE]: (pi, bridge) => registerOpenNote(pi, bridge),
  [ACTIONS.UI_EXECUTE_COMMAND]: (pi, bridge) => registerExecuteCommand(pi, bridge),
  [ACTIONS.READ_NOTE]: (pi, bridge, cfg) => registerReadNote(pi, bridge, cfg),
  [ACTIONS.WRITE_NOTE]: (pi, bridge, cfg) => registerWriteNote(pi, bridge, cfg),
  [ACTIONS.SEARCH_NOTES]: (pi, bridge) => registerSearchNotes(pi, bridge),
  [ACTIONS.APPEND_DAILY]: (pi, bridge, cfg) => registerAppendDaily(pi, bridge, cfg),
  [ACTIONS.CALL_PLUGIN]: (pi, bridge, cfg) => registerCallPlugin(pi, bridge, cfg),
};

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
            'pi-obsidian bridge plugin injected. Enable it once: Settings → Community plugins → "pi-obsidian bridge", then run obsidian.ping.',
            "info",
          );
        }
      } catch {
        // ignore
      }
    });
  }

  const registered: string[] = [];
  for (const action of cfg.allow) {
    const registrar = REGISTRARS[action];
    if (registrar) {
      registrar(pi, bridge, cfg);
      registered.push("obsidian." + action);
    }
  }

  if (cfg.allowPluginCalls) {
    registerCallPlugin(pi, bridge, cfg);
    registered.push("obsidian.call_plugin");
  }

  debug("registered tools:", registered.join(", "));
}
