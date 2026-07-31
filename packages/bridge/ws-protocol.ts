export const PROTOCOL_VERSION = 1;
export const CLIENT_VERSION = "pi-bridge@0.1.0";
export const SERVER_VERSION = "pi-obsidian-bridge@0.1.0";

/* ---- Action names ---- */

export const ACTIONS = {
  PING: "ping",
  UI_NOTIFY: "ui.notify",
  UI_STATUS_BAR_SET: "ui.status_bar.set",
  UI_STATUS_BAR_CLEAR: "ui.status_bar.clear",
  UI_OPEN_NOTE: "ui.open_note",
  UI_EXECUTE_COMMAND: "ui.execute_command",
  READ_NOTE: "read_note",
  WRITE_NOTE: "write_note",
  SEARCH_NOTES: "search_notes",
  APPEND_DAILY: "append_daily",
  CALL_PLUGIN: "call_plugin",
} as const;

export type ActionName = (typeof ACTIONS)[keyof typeof ACTIONS];

/** Default whitelist for Phase 1 (call_plugin excluded — gated separately). */
export const DEFAULT_ALLOW: ActionName[] = [
  ACTIONS.PING,
  ACTIONS.UI_NOTIFY,
  ACTIONS.UI_STATUS_BAR_SET,
  ACTIONS.UI_STATUS_BAR_CLEAR,
  ACTIONS.UI_OPEN_NOTE,
  ACTIONS.UI_EXECUTE_COMMAND,
  ACTIONS.READ_NOTE,
  ACTIONS.WRITE_NOTE,
  ACTIONS.SEARCH_NOTES,
  ACTIONS.APPEND_DAILY,
];

/* ---- JSON-RPC message types ---- */

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

/* ---- Event types ---- */

export type BridgeEventType = "vault_changed" | "view_action" | "app_state" | "command_invoked";

export interface VaultChangedPayload {
  path: string;
  change: "create" | "modify" | "delete";
}

export interface ViewActionPayload {
  viewType: string;
  action: string;
  payload?: unknown;
}

export interface AppStatePayload {
  vault?: string;
  online: boolean;
}

/* ---- Error codes (JSON-RPC server-error range) ---- */

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
