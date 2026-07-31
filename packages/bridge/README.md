# `@pi-obsidian/bridge`

> **Status: Phase 1 (`0.1.0`).** The bridge provides a real-time, two-way
> WebSocket channel between the pi agent and a resident Obsidian plugin: UI
> actions, persistent status-bar widgets, an event push channel, a structured
> `call_plugin` alternative to `eval`, and minimal vault operations. See
> [`docs/bridge.md`](../../docs/bridge.md) for the full design.

`@pi-obsidian/bridge` is a [pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) extension that gives the pi agent (and other pi extensions built on top) a **real-time, two-way channel** into a **long-lived Obsidian plugin**: fire UI notifications, hold persistent widgets, open notes, run commands, push events back to pi, and call Obsidian plugin APIs through a structured, whitelisted proxy.

The bridge is **infrastructure**: control stays on the pi side, persistent UI and execution stay on the Obsidian side, and a loopback WebSocket carrying JSON-RPC 2.0 connects the two with no perceptible latency.

## What makes this different from CLI+eval packages

CLI-based Obsidian packages (e.g. `@bacnh85/pi-obsidian`) are great for vault file operations. But they rely on `eval` for anything beyond file I/O — arbitrary in-process JS — which is structurally limited:

- **No persistent UI:** `eval` can't hold a status-bar element across calls; each `eval` stacks a new one and all are lost on reload.
- **No event push:** the CLI is pi→Obsidian only; there's no way for Obsidian to push events (vault changes, user interactions) back to pi.
- **No security boundary:** `eval` is unbounded RCE — fine for a single author, problematic as a platform multiple extensions build on.

The bridge solves all three: a **resident plugin** owns persistent UI and event subscriptions, a **WebSocket** provides real-time two-way communication, and `call_plugin` offers a **structured, named, whitelisted** alternative to `eval`.

## Install

```sh
pi install npm:@pi-obsidian/bridge
```

Then, once, inside the vault's Obsidian app:

1. Open **Settings → Community plugins**.
2. Enable **"pi-obsidian bridge"** (the extension injects it on first load).
3. Keep Obsidian open while using the bridge tools.

## Tools

### UI / interaction (the core value)

| Tool                           | params                    | Description                                              |
| ------------------------------ | ------------------------- | -------------------------------------------------------- |
| `obsidian.ui.notify`           | `{ message, timeoutMs? }` | Show a transient Obsidian `Notice`.                      |
| `obsidian.ui.status_bar.set`   | `{ key, text, cls? }`     | Create or update a **persistent** named status-bar item. |
| `obsidian.ui.status_bar.clear` | `{ key }`                 | Remove a named status-bar item.                          |
| `obsidian.ui.open_note`        | `{ path, newLeaf? }`      | Open a note in Obsidian's editor.                        |
| `obsidian.ui.execute_command`  | `{ commandId }`           | Execute an Obsidian command by ID.                       |

### Vault operations (optional, secondary)

For heavy vault work, pair with [`@bacnh85/pi-obsidian`](https://www.npmjs.com/package/@bacnh85/pi-obsidian) (Obsidian CLI). The bridge ships these for convenience:

| Tool                    | params                              | Destructive       |
| ----------------------- | ----------------------------------- | ----------------- |
| `obsidian.read_note`    | `{ path, maxBytes? }`               | no                |
| `obsidian.write_note`   | `{ path, content, createFolders? }` | **yes** (confirm) |
| `obsidian.search_notes` | `{ query, limit? }`                 | no                |
| `obsidian.append_daily` | `{ content, format? }`              | **yes** (confirm) |

### Plugin API call (config-gated)

| Tool                   | params                        | Description                                                                                              |
| ---------------------- | ----------------------------- | -------------------------------------------------------------------------------------------------------- |
| `obsidian.call_plugin` | `{ pluginId, method, args? }` | Call a named method on an Obsidian plugin's API. Structured, safe alternative to `eval`. Off by default. |

### Event channel

The bridge pushes events from Obsidian to pi in real time. Layer 3 extensions subscribe via the exported client:

```typescript
import { createBridgeClient } from "@pi-obsidian/bridge/client";

const bridge = createBridgeClient(pi);
bridge.on("vault_changed", (e) => {
  console.log("Vault changed:", e.path, e.change);
});
```

Event types: `vault_changed` (`{ path, change }`), `view_action` (`{ viewType, action, payload }`), `app_state` (`{ vault, online }`).

## Building on top (Layer 3)

Third-party extensions import the typed client for one-line access to the same channel:

```typescript
import { createBridgeClient } from "@pi-obsidian/bridge/client";

export default (pi) => {
  const bridge = createBridgeClient(pi);
  pi.on("turn_end", async (event, ctx) => {
    await bridge.ui.notify(`Turn complete. ${event.entries ?? ""}`);
    bridge.ui.status_bar.set("turn", "ready");
  });
  bridge.on("vault_changed", (e) => {
    bridge.ui.status_bar.set("last-change", e.path);
  });
};
```

Compare to the `eval` alternative: `bridge.ui.notify("cost $5")` is shorter, typed, shell-free, escaping-free, and PATH-independent.

## Configuration

Settings live in `.pi/settings.json` under `bridge`:

```json
{
  "bridge": {
    "allow": [
      "ping",
      "ui.notify",
      "ui.status_bar.set",
      "ui.status_bar.clear",
      "ui.open_note",
      "ui.execute_command",
      "read_note",
      "write_note",
      "search_notes",
      "append_daily"
    ],
    "confirmDestructive": true,
    "allowPluginCalls": false,
    "pluginWhitelist": [],
    "confirmPluginCalls": true,
    "forbidDotPi": true,
    "forbidObsidian": true,
    "allowedObsidianSubpaths": []
  }
}
```

To enable `call_plugin`:

```json
{
  "bridge": {
    "allowPluginCalls": true,
    "pluginWhitelist": ["dataview", "tasks"],
    "confirmPluginCalls": true
  }
}
```

## Built-in bridge panel

When the user has no terminal open (or Claudian UI is unavailable), click the dice ribbon icon in Obsidian to open the **pi-obsidian panel**. It shows bridge status and has a text input to send messages to the pi agent (pushed as `view_action` events).

## Debug

```sh
PI_OBSIDIAN_DEBUG=1 pi          # trace bridge connection + JSON-RPC on stderr
PI_OBSIDIAN_DEBUG=1 pi 2>debug.log
```

## Roadmap

- **Phase 2** (`0.2.0`): `ui.register_view` (Layer-3-authored custom views), session awareness, sticky-reconnect hardening.
- **Phase 3** (`0.3.0`): Layer 3 plugin bridges (`@pi-obsidian/dataview`, …), batch actions, streaming.
- **Phase 4** (`1.0.0`): test suite, community plugin directory, semver stability.

## License

[MIT](../../LICENSE)
