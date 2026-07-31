# `@pi-obsidian/bridge` — Product Requirements Document

> Status: **Draft (pre-implementation), revised for WebSocket transport.** This
> document is the source of truth for the bridge package. The protocol below is
> the命门: review and freeze it before writing code.
>
> **Scope repositioning (this revision).** The bridge is **not** primarily a
> vault file reader/writer — that is a solved problem (Obsidian 1.12+ CLI and
> packages such as `@bacnh85/pi-obsidian` already cover it). The bridge exists to
> give the Pi agent and third-party Pi extensions a **stable, real-time, two-way
> channel into a long-lived Obsidian plugin** that owns persistent UI and
> Obsidian's in-process APIs. The differentiator is the **resident UI /
> interaction platform**, the **generic, structured (non-`eval`) plugin call**,
> and the **event push channel** — none of which any existing package provides.
> Vault file ops are kept as an _optional, secondary_ convenience, not the
> selling point.

## 1. Overview

`@pi-obsidian/bridge` is a Pi extension that gives the Pi coding agent (and any
other Pi extension built on top) the ability to drive a **long-lived Obsidian
plugin** over a **WebSocket RPC**: fire UI notifications, hold persistent
status-bar widgets, open notes, run commands, push events back to pi, and — as a
platform — call **any** Obsidian plugin API through a **structured, whitelisted
proxy**. It is **infrastructure**: control stays on the Pi side, persistent UI
state and execution stay on the Obsidian side, and a WebSocket carrying JSON-RPC
2.0 connects the two with no perceptible latency.

The goal is to let anyone build **Claudian → Pi → Obsidian** AI tooling on top of
a stable bridge, and to expose Obsidian's in-process capabilities (UI, commands,
Dataview, Tasks, vault events, …) to an agent that would otherwise be unable to
reach them — including scenarios where the user is **not** at a terminal and
Claudian's own UI/UX does not provide an interaction surface.

### Why this architecture (not an Obsidian-internal AI plugin, not `eval`)

Existing Obsidian AI plugins ship a _weak_ agent inside Obsidian. Existing Pi →
Obsidian packages reach the vault through the **Obsidian CLI + `eval`** — which
is arbitrary in-process JS: enough for stateless one-shots (`new Notice(...)`),
but structurally incapable of holding persistent UI across sessions, surviving
reloads, or offering a security boundary. This package inverts both: a _strong_
agent (pi) sits outside and drives a **resident plugin** that owns the lifecycle
of persistent UI and forwards events back in real time. The agent keeps pi's
tool system, context management, sub-agents, and trust model; Obsidian contributes
its UI, commands, and plugin APIs. The asymmetry in agent capability is the
differentiator; the **resident plugin** is what makes capabilities eval cannot
provide reachable.

### Three-layer architecture

```
┌──────────────────────────────────────────────────────────────┐
│  Layer 3: Plugin-specific bridges (separate Pi extensions)   │
│  ├─ @pi-obsidian/dataview — registers obsidian.dataview_*    │
│  ├─ @pi-obsidian/tasks — registers obsidian.tasks_*          │
│  ├─ @pi-obsidian/cost-tracker — status-bar cost widget       │
│  └─ ...other plugin bridges                                  │
│     Use Layer 2's exported client helper; NOT this package   │
├──────────────────────────────────────────────────────────────┤
│  Layer 2: Generic bridge proxy (THIS PACKAGE)                │
│  └─ Structured UI actions + obsidian.call_plugin             │
│     + event channel + exports createBridgeClient()           │
├──────────────────────────────────────────────────────────────┤
│  Layer 1: Transport protocol (THIS PACKAGE)                  │
│  └─ WebSocket + JSON-RPC 2.0, liveness, security, validation │
└──────────────────────────────────────────────────────────────┘
```

**This package implements Layer 1 and Layer 2 only.** Plugin-specific bridges
(Dataview, Tasks, a cost-tracker widget, etc.) are separate packages that build
on top via the exported client helper.

## 2. Goals & non-goals

**Goals**

- Provide a **real-time, two-way channel** (WebSocket) between Pi and a
  long-lived Obsidian plugin, with no perceptible latency and no reliance on
  Obsidian's file-watching for triggering.
- Let the Pi agent (and Layer 3 extensions) drive **persistent UI**: notices,
  status-bar widgets, opening notes, firing commands — state that survives
  `/new`, `/reload`, and Obsidian restarts because the plugin owns it.
- Push **events from Obsidian back to pi** (vault changes, view actions, app
  state) so agents can react without polling.
- Define a **versioned, stable bridge protocol** so third parties can build tools
  on top of it.
- Provide a **generic, structured plugin API call mechanism**
  (`obsidian.call_plugin`) — named, whitelisted, JSON-serializable — as a real
  alternative to unbounded `eval`.
- Export a **typed client helper** (`createBridgeClient`) so a Layer 3 author
  can do `bridge.ui.notify("cost $5")` in one line — shorter and safer than
  shelling out to `obsidian run "eval code=..."`.
- Require **no separately-published Obsidian plugin to be useful**: the package
  injects the bridge plugin on demand (a one-time enable by the user).
- Integrate with pi's existing trust/permission model rather than inventing one.

**Non-goals (for v1)**

- No agent loop inside Obsidian.
- No arbitrary code execution from the agent (`eval` is explicitly rejected;
  `call_plugin` is a structured, named call — see §7.4).
- No UI/panel _authored_ by Layer 3 inside Obsidian in v1 (a built-in bridge
  panel is provided; Layer-3-authored custom views are Phase 2).
- **No competition with CLI-based vault packages on file operations.** Heavy
  vault read/write/search is the job of `@bacnh85/pi-obsidian` etc.; the bridge
  ships a minimal vault op set only as a convenience that rides on the resident
  plugin.
- No real-time streaming of large payloads (v1 is request/response + small
  event notifications; batch/streaming is Phase 3).

## 3. Process model

- **pi** runs as an independent Node process (the Pi CLI). It is the **control
  plane**: tools are registered here, the agent loop runs here, permissions are
  enforced here.
- **Obsidian** runs as an Electron app (the **execution plane**). A small
  Obsidian plugin loaded inside it owns persistent UI elements and performs
  actions using in-process `app.vault` / `app.workspace` / `app.commands` /
  `app.plugins.plugins.*` APIs.
- The two never share memory or modules. They communicate over a **loopback
  WebSocket** carrying JSON-RPC 2.0. The plugin starts the server on `onload`; pi
  discovers it via a lockfile and connects.

```
 ┌─────────── Pi process (Node) ───────────┐         ┌─────────── Obsidian (Electron) ──────────┐
 │  agent loop                             │         │  bridge plugin (onload → ws server up)   │
 │  tools: obsidian.ui.notify, …           │         │  handlers → app.vault / Notice / cmds    │
 │  ┌─────────────────────────────────┐    │  ws://  │  ┌──────────────────────────────────┐    │
 │  │ bridge client: JSON-RPC over WS │ ───────────► │  │  action dispatcher + UI holders  │    │
 │  └─────────────────────────────────┘    │ 127.0.  │  └──────────────────────────────────┘    │
 │       ▲  + event subscriber             │ 0.1     │        │  vault.on('modify') etc.        │
 │       └──── event (notification) ◄──────┼─────────┼────────┘  → event notification           │
 └─────────────────────────────────────────┘         └──────────────────────────────────────────┘
            ▲                                            ▲
            │ reads ws.lock on connect                   │ writes ws.lock on onload
            └──────── .pi/obsidian-bridge/ws.lock ───────┘
```

`cwd` is the vault root (Claudian starts Pi this way; any Pi run inside a vault
does too). The lockfile lives under the vault root.

## 4. File layout

The only on-disk bridge state is a **discovery lockfile** (plus a small state
dir for future use). There are no `requests/`, `responses/`, or `events/`
directories — all traffic flows over the WebSocket.

```
.pi/obsidian-bridge/
  ws.lock        # written by the plugin on onload, removed on onunload
```

`ws.lock` content:

```json
{
  "pid": 12345,
  "port": 43210,
  "authToken": "550e8400-e29b-41d4-a716-446655440000",
  "pluginVersion": "0.1.0",
  "obsidianVersion": "1.7.5",
  "vault": "MyVault",
  "startedAt": 1722000000000
}
```

`.pi/obsidian-bridge/` is a dedicated subtree. pi's own project files use
`.pi/settings.json`, `.pi/npm/`, `.pi/git/`; there is no collision.

**Security note:** The `.pi/` directory (including the lockfile) must be
protected from agent access (§7.3). The lockfile contains an auth token; it is
read by the bridge client only, never exposed to the agent.

## 5. Protocol v1

### 5.1 Transport

- **WebSocket** on `ws://127.0.0.1:<port>/` (loopback only — never a non-local
  interface).
- **Framing:** JSON-RPC 2.0 in text frames. One message per frame.
- **Authentication:** required HTTP header `x-pi-obsidian-auth: <authToken>` on
  the WebSocket upgrade; mismatches are rejected before upgrade. The token is the
  `authToken` from `ws.lock`.
- **Direction:** the same connection carries both pi→plugin requests and
  plugin→Pi event notifications (JSON-RPC notifications, no `id`).

### 5.2 Handshake (`initialize`)

Pi connects and sends `initialize`; the plugin responds with its protocol
version and capabilities. This replaces the old `bridge-info.json` /
`protocol-version` files.

Pi → plugin:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "initialize",
  "params": { "protocol": 1, "client": "pi-bridge@0.1.0", "sessionId": "ses_01HMAAAAAAAA" }
}
```

plugin → pi:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "protocol": 1,
    "server": "pi-obsidian-bridge@0.1.0",
    "obsidianVersion": "1.7.5",
    "vault": "MyVault",
    "capabilities": [
      "ui.notify",
      "ui.status_bar.set",
      "ui.status_bar.clear",
      "ui.open_note",
      "ui.execute_command",
      "read_note",
      "write_note",
      "search_notes",
      "append_daily",
      "call_plugin"
    ]
  }
}
```

Pi then sends `{"jsonrpc":"2.0","method":"notifications/initialized"}`.

- If the plugin advertises a different **major** `protocol`, Pi closes the
  socket and fails tools with `BRIDGE_PROTOCOL_MISMATCH`.
- `sessionId` is reserved for multi-session arbitration (Phase 2); v1 stores it
  on the connection but does not arbitrate.

### 5.3 Request / response (Pi → plugin)

Request (application action):

```json
{
  "jsonrpc": "2.0",
  "id": 7,
  "method": "ui.notify",
  "params": { "message": "cost $5", "timeoutMs": 5000 }
}
```

Success:

```json
{ "jsonrpc": "2.0", "id": 7, "result": {} }
```

Failure (JSON-RPC `error`; `code` is a transport-level integer,
`data.code` carries the application mnemonic):

```json
{
  "jsonrpc": "2.0",
  "id": 7,
  "error": {
    "code": -32000,
    "message": "NOTE_NOT_FOUND: No note at Inbox/Missing.md",
    "data": { "code": "NOTE_NOT_FOUND" }
  }
}
```

- Numeric `code` uses the JSON-RPC reserved server-error range
  `-32000..-32099` for application errors; standard JSON-RPC codes
  (`-32700` parse error, `-32600` invalid request, `-32601` method not found,
  `-32603` internal error) are used for protocol violations.
- The application mnemonic (`data.code`) is what the agent and Layer 3 code
  branch on (§5.5).

### 5.4 Event notifications (plugin → pi)

Unsolicited pushes use JSON-RPC **notifications** (no `id`, no response):

```json
{
  "jsonrpc": "2.0",
  "method": "event",
  "params": { "type": "vault_changed", "payload": { "path": "Inbox/Note.md", "change": "modify" } }
}
```

Event types (v1):

| `type`            | `payload`                                        | Source                              |
| ----------------- | ------------------------------------------------ | ----------------------------------- |
| `vault_changed`   | `{ path, change: "create"\|"modify"\|"delete" }` | plugin's own `vault.on(...)`        |
| `view_action`     | `{ viewType, action, payload }`                  | user interacting with a bridge view |
| `app_state`       | `{ vault, online: boolean }`                     | Obsidian open/close, vault switch   |
| `command_invoked` | `{ commandId }`                                  | a command Pi subscribed to          |

The pi-side client exposes these as an `EventEmitter` (`bridge.on("vault_changed", ...)`),
which Layer 3 extensions subscribe to (§12).

### 5.5 Error codes (application mnemonics)

| Code                       | Meaning                                                    |
| -------------------------- | ---------------------------------------------------------- |
| `BRIDGE_PROTOCOL_MISMATCH` | plugin advertised a different major protocol version       |
| `BRIDGE_DOWN`              | no connection (lockfile missing / connect failed / closed) |
| `BRIDGE_TIMEOUT`           | pi-side deadline (`timeoutMs`) elapsed before a response   |
| `ACTION_UNKNOWN`           | method is not a known action                               |
| `ACTION_NOT_ALLOWED`       | action not on the configured whitelist                     |
| `NOTE_NOT_FOUND`           | `read_note`/`write_note` target missing (where relevant)   |
| `PATH_INVALID`             | traversal (`..`) or absolute path                          |
| `PATH_FORBIDDEN`           | path under `.pi/` or (default) `.obsidian/`                |
| `PLUGIN_NOT_FOUND`         | `call_plugin`: `pluginId` not loaded                       |
| `METHOD_NOT_FOUND`         | `call_plugin`: method is not a function on the plugin API  |
| `PLUGIN_CALLS_DISABLED`    | `call_plugin` not enabled in config                        |
| `VIEW_TYPE_UNKNOWN`        | `ui.open_note`/view action: unknown view type              |

### 5.6 Lifecycle

1. **plugin `onload`** starts a loopback WS server on a free port and writes
   `ws.lock` atomically (tmp + `fs.rename`).
2. **Pi `onLoad`** reads `ws.lock` (poll for up to a short grace period if
   missing → otherwise `BRIDGE_DOWN`), connects with the auth header, and runs
   `initialize`.
3. **Request path:** Pi sends a JSON-RPC request; the plugin dispatches the
   action, executes it against Obsidian APIs, and returns the JSON-RPC response
   over the same socket.
4. **Event path:** the plugin subscribes to Obsidian events at `onload` and
   emits `event` notifications to Pi whenever they fire.
5. **plugin `onunload`** closes the server and deletes `ws.lock`. Pi detects the
   closed connection and marks the bridge `BRIDGE_DOWN`.
6. **Pi session change** (`/new`, `/reload`): the client performs a **sticky
   reconnect** — it remembers the lockfile target and reconnects to the same
   plugin if the lockfile is still valid (pattern borrowed from `@ldelossa/pi-ide`).

### 5.7 Timeouts & orphans

- Pi enforces `timeoutMs` per request (default 30 s; UI actions typically use
  < 1 s). On expiry Pi fails the call with `BRIDGE_TIMEOUT`; a late response, if
  it arrives, is dropped by id match.
- A dropped connection mid-request surfaces as `BRIDGE_DOWN`; Pi does not retry
  automatically except via the sticky-reconnect path on session change.

### 5.8 Atomicity

The only file write is `ws.lock`, done tmp + rename. There are no streamed
half-files to tolerate. Network framing is atomic by WebSocket message boundary.

## 6. Liveness & capability advertisement

Liveness is now a **connection property**, not a polled file — this is a primary
benefit of the WS transport.

- **Up:** the WS connection is open and `initialize` succeeded. Capabilities are
  the `capabilities` array from the init result (§5.2).
- **Down:** `ws.lock` is missing, the connect attempt fails, or the socket
  closes. Tools fail **immediately** with `BRIDGE_DOWN` and an actionable message
  ("Open Obsidian and enable the bridge plugin"). No 15 s heartbeat wait, no
  silent hang.
- On `onunload` the plugin closes the server and deletes `ws.lock`; the
  connection drop alone signals down (a `status:down` message is best-effort and
  redundant).

## 7. Security model

The bridge grants the agent **full vault read/write and UI/command access**.
This is the central risk and must be designed deliberately.

1. **Transport security.** WebSocket is loopback-only (`127.0.0.1`) and requires
   the `x-pi-obsidian-auth` header matching `ws.lock`'s random `authToken`. No
   remote interface is ever exposed.

2. **Action whitelist.** Allowed actions are configurable (Pi settings or the
   package's `pi.bridge` config). v1 default = the UI actions + minimal vault
   ops; `call_plugin` is **off by default**. Anything not whitelisted →
   `ACTION_NOT_ALLOWED`, never executed.

3. **Path safety.** All paths are normalized and resolved against the vault root.
   - Traversal (`..`) is rejected → `PATH_INVALID`.
   - Absolute paths are rejected → `PATH_INVALID`.
   - **`.pi/` directory is forbidden** → `PATH_FORBIDDEN`. The agent must not
     access bridge state or pi's own files through the bridge.
   - By default, paths under `.obsidian/` are forbidden (config can allow
     specific subpaths).

4. **No code execution — by contrast with `eval`.** Actions are structured,
   named calls. `call_plugin` (§8.3) invokes a **named method** on a plugin's
   API with JSON-serializable args — it is not `eval`. This is the security story
   that distinguishes the bridge from CLI+`eval` packages, and it is what makes
   the bridge suitable as a **platform** multiple extensions build on (each Layer
   3 extension gets a bounded surface, not unbounded RCE).

5. **Per-action confirmation.** Destructive actions (`write_note`, and any
   future delete/rename) require confirmation **before** the request is sent. In
   v1 confirmation happens **pi-side** via `ctx.ui.confirm` for a consistent UX,
   with a setting to auto-approve.

6. **Trust inheritance.** The bridge piggybacks on pi's project-trust model; it
   does not introduce a second trust gate, but it requires the bridge plugin to
   be explicitly enabled in Obsidian (a conscious user action).

## 8. Action & tool set

Each action maps 1:1 to a **Pi tool** registered via `pi.registerTool()` (typebox
params) when the LLM is expected to call it directly, and/or to a method on the
**exported client** (§10.3) when Layer 3 code calls it programmatically. Tools
are prefixed `obsidian.*`; client methods are grouped (`bridge.ui.*`,
`bridge.vault.*`, `bridge.call_plugin`).

### 8.1 UI / interaction actions (v1 — the core value)

These are the actions `eval` **cannot** reliably provide (persistent,
state-holding, cross-session) and that no existing package offers.

| Tool                           | params                           | result | Destructive | Notes                                                                      |
| ------------------------------ | -------------------------------- | ------ | ----------- | -------------------------------------------------------------------------- |
| `obsidian.ui.notify`           | `{ message, timeoutMs?, type? }` | `{}`   | no          | Fires an Obsidian `Notice`. Stateless one-shot.                            |
| `obsidian.ui.status_bar.set`   | `{ key, text, cls? }`            | `{}`   | no          | Creates-or-updates a **persistent** named status-bar item the plugin owns. |
| `obsidian.ui.status_bar.clear` | `{ key }`                        | `{}`   | no          | Removes a named status-bar item.                                           |
| `obsidian.ui.open_note`        | `{ path, newLeaf? }`             | `{}`   | no          | Opens a note in a leaf via `workspace.openLinkText`.                       |
| `obsidian.ui.execute_command`  | `{ commandId, args? }`           | `{}`   | varies      | Fires `commands.executeCommandById`.                                       |

The **persistent status-bar widget** is the canonical "eval cannot do this"
case: the element is created once in `onload` and held by the plugin; Pi only
sends "set this text" updates. `eval`-based approaches stack a new element on
every call and lose them on reload.

A **built-in bridge panel** (a single registered Obsidian view, "pi-obsidian
panel") lets a user without a terminal / without Claudian UI approve prompts or
trigger actions; user interactions there are pushed back as `view_action` events
(§5.4). Layer-3-authored custom views are Phase 2 (`ui.register_view`).

### 8.2 Minimal vault actions (v1 — optional, secondary)

Kept only because the plugin is resident anyway and these integrate with the
same path-safety / liveness model. **For heavy vault work, pair with
`@bacnh85/pi-obsidian` (Obsidian CLI); do not treat the bridge as a vault tool
competitor.**

| Tool                    | params                              | result                                    | Destructive       |
| ----------------------- | ----------------------------------- | ----------------------------------------- | ----------------- |
| `obsidian.read_note`    | `{ path, maxBytes? }`               | `{ content, stat, truncated? }`           | no                |
| `obsidian.write_note`   | `{ path, content, createFolders? }` | `{ path, created }`                       | **yes** (confirm) |
| `obsidian.search_notes` | `{ query, limit? }`                 | `{ matches: [{ path, score, excerpt }] }` | no                |
| `obsidian.append_daily` | `{ content, format? }`              | `{ path }`                                | **yes** (confirm) |

- `read_note` includes `maxBytes` to bound context; `truncated: true` if cut.
- `search_notes` v1 uses native vault scan + substring match; Omnisearch MAY be
  used and advertised as a capability if present (not a hard dep).
- `append_daily` resolves today's daily note via the core Daily Notes config,
  falling back to `YYYY-MM-DD.md` at vault root (§9.4).

### 8.3 Generic plugin API call (v1 — gated)

The key extensibility mechanism, and the structured alternative to `eval`.

| Tool                   | params                                    | result       | Destructive |
| ---------------------- | ----------------------------------------- | ------------ | ----------- |
| `obsidian.call_plugin` | `{ pluginId, method, args?, timeoutMs? }` | `{ result }` | varies      |

- `pluginId`: Obsidian plugin id (e.g. `"dataview"`, `"tasks"`).
- `method`: method name on the plugin's exposed API.
- `args`: JSON-serializable array. No functions, no DOM elements.

Execution (Obsidian side):

```javascript
const plugin = app.plugins.plugins[params.pluginId];
if (!plugin) throw new Error(`PLUGIN_NOT_FOUND: ${params.pluginId}`);
const api = plugin.api || plugin;
const method = api[params.method];
if (typeof method !== "function") {
  throw new Error(`METHOD_NOT_FOUND: ${params.pluginId}.${params.method}`);
}
const result = await method.apply(api, params.args || []);
```

`call_plugin` is **off by default**; enable via config (`allowPluginCalls: true`
or a per-plugin whitelist). When enabled, destructive operations show a
per-plugin confirmation prompt (configurable). All `args` must be
JSON-serializable.

Example (Layer 3 code):

```typescript
const dv = await bridge.call_plugin({
  pluginId: "dataview",
  method: "query",
  args: ["TABLE file.name FROM #project"],
});
```

### 8.4 Future actions (not v1)

- `ui.register_view` — Layer-3-authored custom views rendered inside Obsidian
  (Phase 2).
- `obsidian.create_folder`, `obsidian.delete_note`, `obsidian.rename`, `obsidian.move`
  (or defer entirely to `@bacnh85/pi-obsidian`).
- `obsidian.get_metadata`, `obsidian.get_backlinks` (via `metadataCache`).
- **Editor manipulation** (CodeMirror cursor/selection/insert) is **explicitly
  out of scope**: it is live-DOM and not cleanly serializable (§11.3). Use
  `ui.execute_command` workarounds where an Obsidian command exists.

## 9. The Obsidian-side micro-plugin

### 9.1 Plugin identity & distribution

- **Plugin id:** `pi-obsidian-bridge`. **Name:** "pi-obsidian bridge".
- **Distribution (v1):** shipped inside the npm package at
  `obsidian-side/main.js` (plain hand-written JS, **no build step**, matching the
  repo's source-first philosophy). The Pi extension injects it on first load.
- **Injection:** on extension load, if
  `.obsidian/plugins/pi-obsidian-bridge/manifest.json` is missing, the extension
  writes `manifest.json` + `main.js` from package assets, then notifies the user
  to enable it once (Settings → Community plugins). It does not auto-enable.

### 9.2 Manifest

```json
{
  "id": "pi-obsidian-bridge",
  "name": "pi-obsidian bridge",
  "version": "0.1.0",
  "minAppVersion": "1.4.0",
  "description": "Bridge for Pi coding agent to access Obsidian APIs over WebSocket",
  "author": "pi-obsidian",
  "isDesktopOnly": true
}
```

`isDesktopOnly: true` is required: the plugin uses Node.js APIs (`fs` for the
lockfile, `http`/`ws`-equivalent for the server). `authorUrl`/`fundingUrl` are
optional.

### 9.3 Lifecycle

**`onload`:**

1. Start a loopback WS server on a free port; generate a random `authToken`.
2. Ensure `.pi/obsidian-bridge/` exists; write `ws.lock` atomically.
3. Register persistent UI holders (status-bar item factory, the built-in panel
   view type).
4. Subscribe to Obsidian events to forward (`vault.on('create'/'modify'/'delete')`,
   `workspace.on(...)` for app state) → emit `event` notifications to connected
   clients.
5. Wire the action dispatcher (method → handler) for all advertised capabilities.

**`onunload`:**

1. Close the WS server; reject/close any open sockets.
2. Delete `ws.lock`.
3. Dispose persistent UI holders.

**Request handling (per JSON-RPC request):**

1. Authenticate (the upgrade already verified the token; per-message auth is
   implicit on the live socket).
2. Resolve `method` against the whitelist → `ACTION_UNKNOWN`/`ACTION_NOT_ALLOWED`.
3. For path-bearing actions, run path-safety checks (§7.3).
4. Execute via `app.vault` / `app.workspace` / `app.commands` /
   `app.plugins.plugins.*`, or the UI holders.
5. Return JSON-RPC `result` (or `error`). Errors are returned, never thrown into
   Obsidian.

### 9.4 Daily Notes config resolution

1. `.obsidian/core-plugins.json` — check if `daily-notes` is enabled.
2. `.obsidian/plugins/daily-notes/data.json` — read `format`, `folder`, `template`.
3. Fallback: `YYYY-MM-DD.md` at vault root.

### 9.5 Official community plugin (Phase 4)

The same `main.js` is also published to the Obsidian community plugin directory
for users who prefer the marketplace.

## 10. The pi-side package

### 10.1 Package identity

- **Package:** `@pi-obsidian/bridge`. **Entry:** `index.ts` exporting the default
  factory `(pi: ExtensionAPI) => void | Promise<void>`.
- **Public client:** `client.ts` re-exports `createBridgeClient` for Layer 3
  extensions (v1 — see §10.3).

### 10.2 On load

1. Read config (whitelist, confirm policy, path rules, plugin call permissions).
2. Read `ws.lock`; connect + `initialize`; probe liveness (connection state).
3. Ensure the Obsidian-side plugin is injected (§9.1); notify if just injected.
4. Register one tool per whitelisted action.

### 10.3 Exported client helper (v1)

The differentiator for Layer 3 adoption. A third-party extension imports the
typed client and gets one-line access to the same channel the LLM tools use:

```typescript
// @pi-obsidian/cost-tracker/index.ts
import { createBridgeClient } from "@pi-obsidian/bridge/client";

export default (pi) => {
  const bridge = createBridgeClient(pi);
  pi.on("turn:end", async (e) => {
    await bridge.ui.notify(`cost $${e.cost}`); // one line, typed
    bridge.ui.status_bar.set("cost", `$${e.cost}`); // persistent widget
  });
  bridge.on("vault_changed", (e) => {
    /* react in real time */
  });
};
```

Compare to the `eval` alternative the same author would otherwise write:

```typescript
import { execFile } from "node:child_process";
const notify = (m: string) =>
  execFile("obsidian", ["run", `eval code="new Notice('${m.replace(/'/g, "\\'")}', 5000)"`]);
```

The helper is **shorter, typed, shell- and escaping-free, PATH-independent, and
shares the bridge's security/liveness model.** This ergonomics gap is what makes
the bridge adoptable as a platform rather than losing to `eval` inertia.

The client surface:

```typescript
bridge.ui.notify(message, timeoutMs?, type?)
bridge.ui.status_bar.set(key, text, cls?)
bridge.ui.status_bar.clear(key)
bridge.ui.open_note(path, newLeaf?)
bridge.ui.execute_command(commandId, args?)
bridge.vault.read_note(path, maxBytes?)        // optional/secondary
bridge.vault.write_note(path, content, opts?)    // optional/secondary
bridge.call_plugin({ pluginId, method, args?, timeoutMs? })
bridge.on(eventType, handler)                     // vault_changed, view_action, app_state, command_invoked
bridge.request(action, params, timeoutMs?)        // escape hatch for raw actions
```

### 10.4 Per tool execution

1. Validate params → path-safety check.
2. Optional `ctx.ui.confirm` for destructive actions.
3. Send JSON-RPC request → await response (`timeoutMs`).
4. Return `result` to the agent (or an actionable error string).

### 10.5 Degrade gracefully

`BRIDGE_DOWN` returns a clear, actionable error so the agent can inform the user
rather than retry blindly.

### 10.6 Debug

`PI_OBSIDIAN_DEBUG` env, stderr, tag `[pi-obsidian]` (same pattern as sibling
`@pi-claudian` repos). Logs connection state, JSON-RPC traffic, event dispatch.

## 11. Transparent proxy feasibility

A key design question: can Pi get a "virtual `app` object" that feels like
programming inside Obsidian? The WS transport makes the proxyable subset
**real-time**; serializability is the remaining constraint.

### 11.1 Fully proxyable (JSON-serializable, request/response over WS)

| API                                           | Mechanism                    |
| --------------------------------------------- | ---------------------------- |
| `vault.read/create/modify/delete/rename`      | WS RPC                       |
| `vault.getMarkdownFiles/getAllLoadedFiles`    | Return path arrays           |
| `metadataCache.getFileCache/getCache`         | Return `CachedMetadata` JSON |
| `metadataCache.resolvedLinks/unresolvedLinks` | Return plain objects         |
| `workspace.getActiveFile/getLastOpenFiles`    | Return paths                 |
| `commands.executeCommandById`                 | `ui.execute_command`         |
| `app.isDarkMode/loadLocalStorage`             | Simple values                |
| UI notices / status-bar / open-note           | `ui.*` actions (persistent)  |

### 11.2 Proxyable with caveats

| API                                    | Caveat                                                                                                                                                                                     |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `vault.on('create'/'modify'/'delete')` | Now reliable **forwarded as events** over WS (originates inside Obsidian, where the watcher _is_ reliable; the unreliable case was external writes, which the bridge no longer depends on) |
| `metadataCache.on('changed')`          | Same — forwarded as events                                                                                                                                                                 |
| `workspace.getLeavesOfType`            | Serialize leaf IDs, view types, file paths                                                                                                                                                 |

### 11.3 Fundamentally unproxyable (out of scope)

| API                                     | Reason                                                                                 |
| --------------------------------------- | -------------------------------------------------------------------------------------- |
| `Editor` (CodeMirror)                   | Live DOM, cursor, selection — not serializable                                         |
| `WorkspaceLeaf.setViewState`            | Tied to live DOM and View instances                                                    |
| `MarkdownView` / any View (full render) | DOM rendering pipeline (Layer-3 `register_view` in Phase 2 addresses a bounded subset) |
| `keymap/Scope/hotkeyManager`            | Keyboard events, in-process only                                                       |
| `containerEl` / DOM elements            | HTML elements                                                                          |
| `secretStorage`                         | OS-level secure storage                                                                |

### 11.4 Conclusion

~70–80% of the Obsidian API can be transparently proxied; WS makes that subset
real-time. Editor manipulation and DOM access require structured actions or
`ui.execute_command` workarounds and are explicitly out of scope.

## 12. Inter-extension communication (Layer 3 usage)

### 12.1 Exported client helper (primary, v1)

Layer 3 extensions import `createBridgeClient` and call the typed surface (§10.3).
This is the recommended, supported path — no need to touch the raw protocol.

### 12.2 Tool interception (observation/modification)

```typescript
pi.on("tool_call", async (event, ctx) => {
  if (event.toolName === "obsidian.call_plugin") {
    // validate, log, or modify params
  }
});
```

### 12.3 LLM-mediated composition (simplest)

Layer 3 can also just register its own tool and return instructions for the LLM
to use `obsidian.call_plugin` (no programmatic bridge access required):

```typescript
pi.registerTool({
  name: "obsidian.dataview_query",
  description: "Execute a Dataview query",
  parameters: Type.Object({ query: Type.String() }),
  async execute(toolCallId, params) {
    return {
      content: [
        {
          type: "text",
          text: `Use obsidian.call_plugin with pluginId: "dataview", method: "query", args: ["${params.query}"]`,
        },
      ],
    };
  },
});
```

## 13. Claudian integration

Claudian is an Obsidian plugin that embeds Pi in a sidebar.

### 13.1 Pi → Claudian (data sync)

Existing `@pi-claudian/*` extensions write to `.claudian/sessions/`; Claudian
reads these on conversation open. The bridge's WS event channel can additionally
push a `claudian-refresh`-style signal.

### 13.2 Claudian → Pi (commands)

Claudian already sends commands to Pi via JSONL stdio RPC (per-turn), independent
of the bridge.

### 13.3 Pi → Claudian (UI notifications)

The bridge event channel (§5.4) carries push notifications. A co-resident
Claudian (Pi running inside Obsidian) can subscribe to the bridge's own events
or the bridge can emit an `app_state`/custom event Claudian watches.

> **Open question (§16):** when Pi runs inside Obsidian via Claudian, Pi and the
> bridge plugin share a process; the loopback WS still works but is arguably
> redundant. v1 keeps WS for a uniform control plane; a same-process fast path is
> a future optimization.

## 14. Phasing plan

### Phase 0 — prove the pipe (internal alpha, `v0.1.0-alpha.1`)

- Freeze protocol v1 in this PRD.
- Obsidian plugin: `onload`, WS server, `ws.lock`, `initialize` handshake,
  heartbeat-free liveness, handle **`ping`** and **`ui.notify`** only.
- Pi side: inject plugin + connect + `initialize` + liveness + register
  **`obsidian.ping`** and **`obsidian.ui.notify`** only.
- **Exit criteria:** a manual end-to-end round trip works (Pi tool → WS → plugin
  shows a Notice → response → pi). No whitelist/security hardening yet. Alpha tag
  only.

### Phase 1 — useful MVP (`v0.1.0`) — the real value

- **All UI actions** (`ui.notify`, `ui.status_bar.*`, `ui.open_note`,
  `ui.execute_command`) + the built-in bridge panel with `view_action` events.
- **Event channel** (`event` notifications): `vault_changed`, `view_action`,
  `app_state`, `command_invoked`.
- **Exported `createBridgeClient` helper** with the typed surface (§10.3).
- Generic `obsidian.call_plugin` action (config-gated).
- Minimal vault ops (`read_note`, `write_note`, `search_notes`, `append_daily`)
  as optional/secondary, with a README pointer to `@bacnh85/pi-obsidian` for heavy
  vault work.
- Action whitelist, path safety (incl. `.pi/` protection), pi-side confirm.
- Liveness via connection state + `BRIDGE_DOWN` degrade + all error codes.
- `PI_OBSIDIAN_DEBUG` tracing.
- README + install/enable instructions.
- Changeset + publish to npm as `@pi-obsidian/bridge@0.1.0`.

### Phase 2 — platform (`v0.2.0`)

- **Stabilize protocol v1** (no breaking changes after this without a v2).
- **`ui.register_view`** — Layer-3-authored custom views inside Obsidian.
- **Session awareness** — use `sessionId` for multi-session arbitration on a
  shared connection.
- Sticky-reconnect hardening + reconnection backoff.
- Claudian integration docs (event-channel watching for real-time sync).

### Phase 3 — ecosystem (`v0.3.0`)

- **Layer 3 plugin bridges:** `@pi-obsidian/dataview`, `@pi-obsidian/tasks`,
  `@pi-obsidian/cost-tracker`, etc. as separate packages.
- Batch actions (multiple ops in one request).
- Streaming/pagination for large reads.

### Phase 4 — stable (`v1.0.0`)

- Test suite (protocol conformance, path safety, liveness, reconnect).
- Publish the Obsidian-side plugin to the community plugin directory.
- Protocol v1 final; semver stability guarantee for the public
  `createBridgeClient` helper and the action schemas.

## 15. Package layout

```
packages/bridge/
  package.json          # @pi-obsidian/bridge; pi.extensions -> ./index.ts
  tsconfig.json
  index.ts              # pi-side factory: connect, liveness, tool registration
  bridge-client.ts      # createBridgeClient() + WS client + JSON-RPC + typed surface
  ws-protocol.ts        # JSON-RPC message types, error codes, handshake
  config.ts             # whitelist, path rules, confirm policy, plugin permissions
  debug.ts              # PI_OBSIDIAN_DEBUG helper
  client.ts             # public re-export of createBridgeClient for Layer 3 (v1)
  obsidian-side/
    manifest.json       # Obsidian plugin manifest (id: pi-obsidian-bridge)
    main.js             # hand-written plugin (onload/ws-server/lockfile/UI holders/handlers)
  README.md
  docs/                 # protocol reference

# Layer 3 packages (separate repos or same monorepo):
packages/dataview/      # @pi-obsidian/dataview — Dataview-specific tools
packages/tasks/         # @pi-obsidian/tasks — Tasks-specific tools
packages/cost-tracker/  # @pi-obsidian/cost-tracker — status-bar cost widget (reference Layer 3)
```

## 16. Open questions

- **Concurrent sessions:** v1 assumes one Pi session per connection. Multi-session
  arbitration (which session owns which requests/events) is deferred to Phase 2;
  `sessionId` is reserved.
- **Claudian co-residence:** when Pi runs inside Obsidian via Claudian, the
  loopback WS is arguably redundant (same process). v1 keeps it for a uniform
  control plane; a same-process fast path is a future optimization.
- **Port conflicts / discovery:** the plugin binds a free port and advertises it
  via `ws.lock`; Pi follows. Multiple vaults each get their own plugin/port.
  Reconnection backoff tuning is a Phase 2 concern.
- **Daily-notes source:** core Daily Notes vs Periodic Notes — v1 reads core
  config, falls back to `YYYY-MM-DD.md`.
- **Large notes:** `maxBytes` bounds context. Phase 3 adds range/stat-only reads.
- **Plugin API stability:** `app.plugins.plugins.*` is undocumented. The bridge
  isolates this risk; Layer 3 plugins bear compatibility for specific plugin APIs.

## 17. Risks

1. **Security (highest):** full vault write + UI/command access in the agent's
   hands. Mitigated by §7 (loopback+token, whitelist, path safety, no-`eval`
   stance, confirmation) but must be communicated loudly to users.
2. **Obsidian API churn:** internal plugin APIs are not stability-guaranteed;
   Phase 3 inter-plugin calls can break on Obsidian upgrades. The bridge is
   insulated; Layer 3 plugins absorb this risk.
3. **WS lifecycle:** port binding, lockfile staleness (orphaned lockfile after a
   crash), and reconnection. Mitigated by the `@ldelossa/pi-ide`-proven lockfile +
   sticky-reconnect pattern; stale-lockfile detection by PID liveness is a small
   added check.
4. **Latency:** WS gives low, stable latency — adequate for interactive UI and
   event pushes. Bulk ops remain Phase 3 (batch/streaming).
5. **Maintenance surface:** Obsidian-side plugin + protocol + Pi client is a
   larger long-term commitment than a typical Pi extension — but WS + lockfile is
   a well-trodden pattern (reused from pi-ide), reducing novel surface.

## 18. Success metrics (qualitative, v1)

- A user can `pi install npm:@pi-obsidian-bridge`, enable the injected plugin
  once, and have the agent notify them / hold a persistent status-bar widget /
  open a note within a single session — with **no perceptible latency**.
- `BRIDGE_DOWN` is **instant** (connection drop, not a 15 s wait) and always
  actionable; `BRIDGE_TIMEOUT` is rare under normal interactive use.
- A third-party author can register a Layer 3 extension that calls
  `bridge.ui.notify(...)` / holds a status-bar widget in **< 50 lines**, with the
  one-line call visibly shorter and safer than the `eval` equivalent.
- A Layer 3 plugin (e.g., `@pi-obsidian/dataview`) can be built on the exported
  client **without any changes to the bridge package** and without touching the
  protocol.
- A user without a terminal open can interact with the built-in bridge panel, and
  the resulting `view_action` event reaches the agent in real time.
