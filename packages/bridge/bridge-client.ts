import { WebSocket } from "ws";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import nodePath from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { debug } from "./debug.js";
import {
  ACTIONS,
  CLIENT_VERSION,
  PROTOCOL_VERSION,
  type BridgeEventType,
  type InitializeResult,
} from "./ws-protocol.js";

export class BridgeError extends Error {
  readonly code: string;
  constructor(code: string, message?: string) {
    super(message || code);
    this.name = "BridgeError";
    this.code = code;
  }
}

export type BridgeStatus = "connecting" | "up" | "down";

/* ---- Action result shapes ---- */

export interface PingResult {
  pong: boolean;
  server: string;
  vault?: string;
}

export interface ReadNoteResult {
  content: string;
  stat: { size: number; mtime: number };
  truncated?: boolean;
}

export interface WriteNoteResult {
  path: string;
  created: boolean;
}

export interface SearchMatch {
  path: string;
  score: number;
  excerpt: string;
}

export interface SearchNotesResult {
  matches: SearchMatch[];
}

export interface AppendDailyResult {
  path: string;
}

export interface CallPluginResult {
  result: unknown;
}

/* ---- Typed client surface ---- */

export interface BridgeUI {
  notify(message: string, timeoutMs?: number, type?: string): Promise<void>;
  status_bar: {
    set(key: string, text: string, cls?: string): Promise<void>;
    clear(key: string): Promise<void>;
  };
  open_note(path: string, newLeaf?: boolean): Promise<void>;
  execute_command(commandId: string, args?: unknown[]): Promise<void>;
}

export interface BridgeVault {
  read_note(path: string, maxBytes?: number): Promise<ReadNoteResult>;
  write_note(
    path: string,
    content: string,
    opts?: { createFolders?: boolean },
  ): Promise<WriteNoteResult>;
  search_notes(query: string, limit?: number): Promise<SearchNotesResult>;
  append_daily(content: string, format?: string): Promise<AppendDailyResult>;
}

export interface BridgeCallPluginParams {
  pluginId: string;
  method: string;
  args?: unknown[];
  timeoutMs?: number;
}

export interface BridgeClient {
  readonly status: BridgeStatus;
  readonly capabilities: readonly string[];
  request<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T>;
  ui: BridgeUI;
  vault: BridgeVault;
  call_plugin(params: BridgeCallPluginParams): Promise<CallPluginResult>;
  on(event: BridgeEventType, handler: (payload: unknown) => void): void;
  off(event: BridgeEventType, handler: (payload: unknown) => void): void;
  reconnect(): void;
  dispose(): void;
}

const DEFAULT_TIMEOUT_MS = 30000;
const REPROBE_INTERVAL_MS = 3000;

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: BridgeError) => void;
  timer: ReturnType<typeof setTimeout>;
}

function resolveVaultRoot(start: string): string {
  let dir = start;
  for (;;) {
    try {
      if (existsSync(nodePath.join(dir, ".obsidian"))) return dir;
    } catch {
      // ignore stat errors, keep walking up
    }
    const parent = nodePath.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return start;
}

export function createBridgeClient(_pi: ExtensionAPI): BridgeClient {
  const root = resolveVaultRoot(process.cwd());
  const lockPath = nodePath.join(root, ".pi", "obsidian-bridge", "ws.lock");
  const bus = new EventEmitter();

  let status: BridgeStatus = "down";
  let capabilities: string[] = [];
  let ws: WebSocket | null = null;
  let nextId = 1;
  let reprobe: ReturnType<typeof setInterval> | null = null;
  const pending = new Map<number, Pending>();

  function failPending(code: string): void {
    for (const p of pending.values()) {
      clearTimeout(p.timer);
      p.reject(new BridgeError(code));
    }
    pending.clear();
  }

  function send(msg: unknown): void {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }

  function rawRequest(
    id: number,
    method: string,
    params: unknown,
    timeoutMs: number,
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (pending.delete(id)) reject(new BridgeError("BRIDGE_TIMEOUT"));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      send({ jsonrpc: "2.0", id, method, params: params ?? {} });
    });
  }

  function request<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T> {
    if (status !== "up") {
      return Promise.reject(new BridgeError("BRIDGE_DOWN"));
    }
    const id = nextId++;
    return rawRequest(id, method, params, timeoutMs ?? DEFAULT_TIMEOUT_MS) as Promise<T>;
  }

  function connect(): void {
    let lock: { port: number; authToken: string };
    try {
      lock = JSON.parse(readFileSync(lockPath, "utf8")) as {
        port: number;
        authToken: string;
      };
    } catch {
      status = "down";
      debug("ws.lock missing at", lockPath, "-> BRIDGE_DOWN");
      return;
    }
    if (!lock || typeof lock.port !== "number" || !lock.authToken) {
      status = "down";
      debug("ws.lock malformed -> BRIDGE_DOWN");
      return;
    }

    status = "connecting";
    const url = `ws://127.0.0.1:${lock.port}/`;
    const sock = new WebSocket(url, {
      headers: { "x-pi-obsidian-auth": lock.authToken },
    });
    ws = sock;

    sock.on("open", () => {
      rawRequest(
        0,
        "initialize",
        {
          protocol: PROTOCOL_VERSION,
          client: CLIENT_VERSION,
        },
        10000,
      )
        .then((res) => {
          const init = res as InitializeResult;
          if (!init || init.protocol !== PROTOCOL_VERSION) {
            debug("protocol mismatch:", init?.protocol);
            sock.close();
            return;
          }
          capabilities = init.capabilities || [];
          status = "up";
          debug("bridge up — capabilities:", capabilities.join(",") || "(none)");
        })
        .catch((e) => {
          debug("initialize failed:", e instanceof Error ? e.message : String(e));
          try {
            sock.close();
          } catch {
            // ignore
          }
        });
    });

    sock.on("message", (data) => {
      let msg: {
        jsonrpc?: string;
        id?: number | string;
        result?: unknown;
        error?: { data?: { code?: string }; message?: string };
        method?: string;
        params?: { type?: string; payload?: unknown };
      };
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (msg.id != null && (msg.result !== undefined || msg.error)) {
        const p = pending.get(msg.id as number);
        if (!p) return;
        pending.delete(msg.id as number);
        clearTimeout(p.timer);
        if (msg.error) {
          p.reject(new BridgeError(msg.error.data?.code || "BRIDGE_ERROR", msg.error.message));
        } else {
          p.resolve(msg.result);
        }
      } else if (msg.method === "event" && msg.params?.type) {
        bus.emit(msg.params.type, msg.params.payload);
      }
    });

    sock.on("close", () => {
      debug("bridge down (socket closed)");
      status = "down";
      ws = null;
      failPending("BRIDGE_DOWN");
    });

    sock.on("error", (e) => {
      debug("ws error:", e instanceof Error ? e.message : String(e));
    });
  }

  reprobe = setInterval(() => {
    if (status === "down") connect();
  }, REPROBE_INTERVAL_MS);

  connect();

  const ui: BridgeUI = {
    notify(message, timeoutMs, type) {
      return request(ACTIONS.UI_NOTIFY, { message, timeoutMs, type }, 5000).then(() => {
        return;
      });
    },
    status_bar: {
      set(key, text, cls) {
        return request(ACTIONS.UI_STATUS_BAR_SET, { key, text, cls }, 5000).then(() => {
          return;
        });
      },
      clear(key) {
        return request(ACTIONS.UI_STATUS_BAR_CLEAR, { key }, 5000).then(() => {
          return;
        });
      },
    },
    open_note(p, newLeaf) {
      return request(ACTIONS.UI_OPEN_NOTE, { path: p, newLeaf }, 5000).then(() => {
        return;
      });
    },
    execute_command(commandId, args) {
      return request(ACTIONS.UI_EXECUTE_COMMAND, { commandId, args }, 10000).then(() => {
        return;
      });
    },
  };

  const vault: BridgeVault = {
    read_note(p, maxBytes) {
      return request<ReadNoteResult>(ACTIONS.READ_NOTE, { path: p, maxBytes });
    },
    write_note(p, content, opts) {
      return request<WriteNoteResult>(ACTIONS.WRITE_NOTE, {
        path: p,
        content,
        createFolders: opts?.createFolders ?? true,
      });
    },
    search_notes(query, limit) {
      return request<SearchNotesResult>(ACTIONS.SEARCH_NOTES, { query, limit });
    },
    append_daily(content, format) {
      return request<AppendDailyResult>(ACTIONS.APPEND_DAILY, { content, format });
    },
  };

  const client: BridgeClient = {
    get status() {
      return status;
    },
    get capabilities() {
      return capabilities;
    },
    request,
    ui,
    vault,
    call_plugin(params) {
      return request<CallPluginResult>(
        ACTIONS.CALL_PLUGIN,
        params,
        params.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      );
    },
    on(event, handler) {
      bus.on(event, handler);
    },
    off(event, handler) {
      bus.off(event, handler);
    },
    reconnect() {
      if (ws) {
        try {
          ws.close();
        } catch {
          // ignore
        }
      }
      connect();
    },
    dispose() {
      if (reprobe) clearInterval(reprobe);
      reprobe = null;
      if (ws) {
        try {
          ws.close();
        } catch {
          // ignore
        }
      }
      ws = null;
      failPending("BRIDGE_DOWN");
      bus.removeAllListeners();
    },
  };

  return client;
}
