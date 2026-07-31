export { createBridgeClient, BridgeError } from "./bridge-client.js";
export type {
  BridgeClient,
  BridgeStatus,
  BridgeUI,
  BridgeVault,
  BridgeCallPluginParams,
  PingResult,
  ReadNoteResult,
  WriteNoteResult,
  SearchMatch,
  SearchNotesResult,
  AppendDailyResult,
  CallPluginResult,
} from "./bridge-client.js";
export { ACTIONS, PROTOCOL_VERSION, type ActionName, type BridgeEventType } from "./ws-protocol.js";
export { validateVaultPath, type PathSafetyConfig, type PathValidation } from "./path-safety.js";
export type { BridgeConfig } from "./config.js";
