---
"@pi-obsidian/bridge": minor
---

Phase 1 release of the pi-obsidian bridge: a real-time WebSocket RPC between the
Pi agent and a resident Obsidian plugin.

- **Full UI action set:** `ui.notify`, `ui.status_bar.set/clear` (persistent
  widgets the plugin owns), `ui.open_note`, `ui.execute_command`.
- **Event channel:** `vault_changed`, `view_action`, `app_state` pushed from
  Obsidian to Pi in real time over the WebSocket.
- **Exported `createBridgeClient` helper:** typed one-line surface for Layer 3
  extensions (`bridge.ui.notify(...)`, `bridge.on("vault_changed", ...)`).
- **Gated `call_plugin`:** structured, named, whitelisted alternative to `eval`
  for calling any Obsidian plugin's API.
- **Minimal vault ops:** `read_note`, `write_note`, `search_notes`,
  `append_daily` (with README pointer to `@bacnh85/pi-obsidian` for heavy work).
- **Security:** action whitelist, path safety (`.pi/` and `.obsidian/`
  forbidden by default), pi-side confirmation for destructive actions, per-plugin
  confirmation for `call_plugin`.
- **Built-in bridge panel:** a resident Obsidian view for interaction without a
  terminal.
- Liveness via WebSocket connection state (no heartbeat polling); instant
  `BRIDGE_DOWN` on disconnect.
