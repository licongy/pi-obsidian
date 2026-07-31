# `@pi-obsidian/bridge`

> **Status: Phase 0 alpha (`0.1.0-alpha.1`).** This release proves the WebSocket
> pipe between the pi agent and a resident Obsidian plugin. It implements only
> `obsidian.ping` and `obsidian.ui.notify` end-to-end. The whitelist/security
> hardening, the event channel, the exported client helper surface, and
> `obsidian.call_plugin` arrive in Phase 1. See [`docs/bridge.md`](../../docs/bridge.md)
> for the full design.

`@pi-obsidian/bridge` is a [pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) extension that gives the pi agent (and other pi extensions built on top) a **real-time, two-way channel** into a **long-lived Obsidian plugin**: fire UI notifications, hold persistent widgets, run commands, push events back to pi, and call Obsidian plugin APIs through a structured, whitelisted proxy.

The bridge is **infrastructure**: control stays on the pi side, persistent UI and execution stay on the Obsidian side, and a loopback WebSocket carrying JSON-RPC 2.0 connects the two.

## Install (alpha)

```sh
pi install npm:@pi-obsidian/bridge
```

Then, once, inside the vault's Obsidian app:

1. Open **Settings → Community plugins**.
2. Enable **"pi-obsidian bridge"** (the extension injects it on first load).
3. Keep Obsidian open while using the bridge tools.

> The bridge also works without the Obsidian plugin enabled for the `ping`/`ui.notify`
> demo only if Obsidian is running and the plugin is enabled — the agent side
> connects to the plugin's WebSocket server discovered via `.pi/obsidian-bridge/ws.lock`.

## How it works

```
pi process (Node)  ──ws://127.0.0.1:<port>──>  Obsidian bridge plugin (Electron)
  bridge client (JSON-RPC 2.0)                  ws server + ws.lock + UI holders
        ▲                                                │
        └──── event notifications (vault/view/app) ──────┘
```

- The **plugin** starts a loopback WebSocket server on `onload` and writes a discovery lockfile (`.pi/obsidian-bridge/ws.lock`) containing the port and an auth token.
- The **pi side** reads the lockfile, connects with the auth header, and runs the JSON-RPC `initialize` handshake (protocol version + capabilities).
- Liveness is the **connection state** — no heartbeat polling.

## Phase 0 tools

| Tool                 | params                    | result                     |
| -------------------- | ------------------------- | -------------------------- |
| `obsidian.ping`      | `{}`                      | `{ pong, server, vault }`  |
| `obsidian.ui.notify` | `{ message, timeoutMs? }` | shows an Obsidian `Notice` |

## Debug

```sh
PI_OBSIDIAN_DEBUG=1 pi          # trace bridge connection + JSON-RPC on stderr
PI_OBSIDIAN_DEBUG=1 pi 2>debug.log
```

## Roadmap

- **Phase 1** (`0.1.0`): full UI action set (`ui.status_bar.*`, `ui.open_note`, `ui.execute_command`), the built-in bridge panel, the event channel, the exported `createBridgeClient` helper, gated `obsidian.call_plugin`, minimal vault ops, whitelist + path safety.
- **Phase 2** (`0.2.0`): `ui.register_view`, session awareness, sticky-reconnect hardening.
- **Phase 3** (`0.3.0`): Layer 3 plugin bridges (`@pi-obsidian/dataview`, …).
- **Phase 4** (`1.0.0`): test suite, community plugin directory, semver stability.

## License

[MIT](../../LICENSE)
