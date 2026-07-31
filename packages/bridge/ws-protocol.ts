export const PROTOCOL_VERSION = 1;
export const CLIENT_VERSION = "pi-bridge@0.1.0-alpha.1";
export const SERVER_VERSION = "pi-obsidian-bridge@0.1.0-alpha.1";

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: unknown;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: { code?: string; [key: string]: unknown };
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string;
  result?: unknown;
  error?: JsonRpcError;
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

export interface InitializeParams {
  protocol: number;
  client: string;
  sessionId?: string;
}

export interface InitializeResult {
  protocol: number;
  server: string;
  obsidianVersion?: string;
  vault?: string;
  capabilities: string[];
}

export const ERROR_CODES = {
  BRIDGE_PROTOCOL_MISMATCH: -32001,
  BRIDGE_DOWN: -32002,
  BRIDGE_TIMEOUT: -32003,
  ACTION_UNKNOWN: -32010,
  ACTION_NOT_ALLOWED: -32011,
  NOTE_NOT_FOUND: -32020,
  PATH_INVALID: -32021,
  PATH_FORBIDDEN: -32022,
  PLUGIN_NOT_FOUND: -32030,
  METHOD_NOT_FOUND: -32031,
  PLUGIN_CALLS_DISABLED: -32032,
  VIEW_TYPE_UNKNOWN: -32040,
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;
