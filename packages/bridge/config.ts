import { readFileSync } from "node:fs";
import path from "node:path";
import { debug } from "./debug.js";

export interface BridgeConfig {
  allow: string[];
  confirmDestructive: boolean;
  allowPluginCalls: boolean;
  forbidDotPi: boolean;
  forbidObsidian: boolean;
}

const DEFAULTS: BridgeConfig = {
  allow: ["ping", "ui.notify"],
  confirmDestructive: true,
  allowPluginCalls: false,
  forbidDotPi: true,
  forbidObsidian: true,
};

export function loadConfig(cwd: string): BridgeConfig {
  try {
    const p = path.join(cwd, ".pi", "settings.json");
    const raw = readFileSync(p, "utf8");
    const settings = JSON.parse(raw) as { bridge?: Partial<BridgeConfig> };
    const b = settings?.bridge;
    if (b && typeof b === "object") {
      return { ...DEFAULTS, ...b };
    }
  } catch (e) {
    debug("config load skipped:", e instanceof Error ? e.message : String(e));
  }
  return { ...DEFAULTS };
}
