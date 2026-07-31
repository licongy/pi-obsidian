import { WebSocket } from "ws";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { debug } from "./debug.js";
import { CLIENT_VERSION, PROTOCOL_VERSION, type InitializeResult } from "./ws-protocol.js";

export class BridgeError extends Error {
  readonly code: string;
  constructor(code: string, message?: string) {
    super(message || code);
    this.name = "BridgeError";
    this.code = code;
  }
}

export type BridgeStatus = "connecting" | "up" | "down";

export type BridgeEventType = "vault_changed" | "view_action" | "app_state" | "command_invoked";

export interface BridgeClient {
  readonly status: BridgeStatus;
  readonly capabilities: readonly string[];
  request<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T>;
  ui: {
    notify(message: string, timeoutMs?: number, type?: string): Promise<void>;
  };
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
      if (existsSync(path.join(dir, ".obsidian"))) return dir;
    } catch {
      // ignore stat errors, keep walking up
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return start;
}

export function createBridgeClient(_pi: ExtensionAPI): BridgeClient {
  const root = resolveVaultRoot(process.cwd());
  const lockPath = path.join(root, ".pi", "obsidian-bridge", "ws.lock");
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

  const client: BridgeClient = {
    get status() {
      return status;
    },
    get capabilities() {
      return capabilities;
    },
    request,
    ui: {
      notify(message, timeoutMs, type) {
        return request("ui.notify", { message, timeoutMs, type }).then(() => {
          return;
        });
      },
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
