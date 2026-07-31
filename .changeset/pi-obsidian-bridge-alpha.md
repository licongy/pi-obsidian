---
"@pi-obsidian/bridge": minor
---

Initial alpha (Phase 0) of the pi-obsidian bridge: a WebSocket RPC between the pi
agent and a resident Obsidian plugin. Implements the `ping` and `ui.notify`
actions end-to-end, the `ws.lock` discovery/liveness handshake, and auto-injection
of the Obsidian-side plugin. Whitelist/security hardening, the event channel, the
exported `createBridgeClient` helper surface, and `call_plugin` are deferred to
Phase 1.
