import { readFileSync } from "node:fs";
import path from "node:fs";
import nodePath from "node:path";
import { debug } from "./debug.js";
import { ACTIONS, DEFAULT_ALLOW, type ActionName } from "./ws-protocol.js";

export interface BridgeConfig {
  /** Whitelisted actions. Tools are registered only for these. */
  allow: ActionName[];
  /** Whether to confirm before destructive actions (write_note, append_daily). */
  confirmDestructive: boolean;
  /** Master switch for call_plugin. When false the action is never registered. */
  allowPluginCalls: boolean;
  /** Per-plugin whitelist for call_plugin. Empty = all plugins allowed when enabled. */
  pluginWhitelist: string[];
  /** Whether to confirm before each call_plugin invocation. */
  confirmPluginCalls: boolean;
  /** Forbid paths under .pi/ (bridge state, pi files). */
  forbidDotPi: boolean;
  /** Forbid paths under .obsidian/ by default. */
  forbidObsidian: boolean;
  /** Specific .obsidian/ subpaths to allow (e.g. "snippets"). */
  allowedObsidianSubpaths: string[];
}

const DEFAULTS: BridgeConfig = {
  allow: [...DEFAULT_ALLOW],
  confirmDestructive: true,
  allowPluginCalls: false,
  pluginWhitelist: [],
  confirmPluginCalls: true,
  forbidDotPi: true,
  forbidObsidian: true,
  allowedObsidianSubpaths: [],
};

export function loadConfig(cwd: string): BridgeConfig {
  try {
    const p = nodePath.join(cwd, ".pi", "settings.json");
    const raw = readFileSync(p, "utf8");
    const settings = JSON.parse(raw) as { bridge?: Record<string, unknown> };
    const b = settings?.bridge;
    if (b && typeof b === "object") {
      const merged: BridgeConfig = { ...DEFAULTS };
      if (Array.isArray(b.allow)) {
        merged.allow = b.allow.filter(
          (a): a is ActionName => typeof a === "string" && a in ACTIONS,
        );
        if (merged.allow.length === 0) merged.allow = [...DEFAULT_ALLOW];
      }
      if (typeof b.confirmDestructive === "boolean")
        merged.confirmDestructive = b.confirmDestructive;
      if (typeof b.allowPluginCalls === "boolean") merged.allowPluginCalls = b.allowPluginCalls;
      if (Array.isArray(b.pluginWhitelist))
        merged.pluginWhitelist = b.pluginWhitelist.filter(
          (s): s is string => typeof s === "string",
        );
      if (typeof b.confirmPluginCalls === "boolean")
        merged.confirmPluginCalls = b.confirmPluginCalls;
      if (typeof b.forbidDotPi === "boolean") merged.forbidDotPi = b.forbidDotPi;
      if (typeof b.forbidObsidian === "boolean") merged.forbidObsidian = b.forbidObsidian;
      if (Array.isArray(b.allowedObsidianSubpaths))
        merged.allowedObsidianSubpaths = b.allowedObsidianSubpaths.filter(
          (s): s is string => typeof s === "string",
        );
      debug("config loaded from", p, JSON.stringify(merged));
      return merged;
    }
  } catch (e) {
    debug("config load skipped (using defaults):", e instanceof Error ? e.message : String(e));
  }
  return { ...DEFAULTS };
}
