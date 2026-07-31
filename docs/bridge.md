# `@pi-obsidian/bridge` — Product Requirements Document

> Status: **Draft (pre-implementation)**. This document is the source of truth for
> the bridge package. The protocol below is the命门: review and freeze it before
> writing code.

## 1. Overview

`@pi-obsidian/bridge` is a pi extension that gives the pi coding agent the ability
to read and write an Obsidian vault, and — as a platform — to call Obsidian plugin
APIs. It is **infrastructure**: control stays on the pi side, execution stays on
the Obsidian side, and a file-based RPC bridge connects the two.

The goal is to let anyone build **claudian → pi → obsidian** AI tooling on top of a
stable bridge, and to expose Obsidian's in-process capabilities (note operations,
Dataview, Tasks, Excalidraw, …) to an agent that would otherwise be unable to
reach them.

### Why this architecture (not an Obsidian-internal AI plugin)

Existing Obsidian AI plugins ship a _weak_ agent inside Obsidian. This package
inverts that: a _strong_ agent (pi) sits outside, and Obsidian becomes a
remote-controlled peripheral. The agent keeps pi's tool system, context management,
sub-agents, and trust model; Obsidian contributes its vault and plugin APIs. The
asymmetry in agent capability is the differentiator.

## 2. Goals & non-goals

**Goals**

- Let the pi agent perform structured read/write operations on an Obsidian vault.
- Be **Claudian-compatible but Claudian-independent**: works in any pi run whose
  `cwd` is an Obsidian vault root (Claudian satisfies this incidentally).
- Define a **versioned, stable bridge protocol** so third parties can build tools
  on top of it.
- Require **no separately-published Obsidian plugin to be useful**: the package
  can inject a tiny bridge plugin on demand (a one-time enable by the user).
- Integrate with pi's existing trust/permission model rather than inventing one.

**Non-goals (for v1)**

- No agent loop inside Obsidian.
- No arbitrary code execution from the agent (actions are structured vault ops).
- No UI/panel inside Obsidian (Claudian already provides the panel; the bridge is
  headless).
- No real-time bidirectional streaming (v1 is request/response).

## 3. Process model

- **pi** runs as an independent Node process (the pi CLI). It is the **control
  plane**: tools are registered here, the agent loop runs here, permissions are
  enforced here.
- **Obsidian** runs as an Electron app (the **execution plane**). A small Obsidian
  plugin loaded inside it performs the actual vault operations using the in-process
  `app.vault` / `app.vault.*` APIs.
- The two never share memory or modules. They communicate exclusively through
  files under `<vault>/.pi/obsidian-bridge/` (the **file RPC**).

```
 ┌─────────── pi process (Node) ───────────┐        ┌─────────── Obsidian (Electron) ──────────┐
 │  agent loop                             │        │  bridge plugin (onload → fs.watch)       │
 │  tools: obsidian.read_note, …           │        │  handleRequest → app.vault.*            │
 │  ┌─────────────────────────────────┐    │  files │  ┌──────────────────────────────────┐   │
 │  │ bridge client: write req, poll  │ ───┼───────►│  │ watcher: consume req, write res  │   │
 │  └─────────────────────────────────┘    │  .pi/  │  └──────────────────────────────────┘   │
 │       ▲                                 │  obs.  │        │                                 │
 │       └──── response ◄──────────────────┼────────┼────────┘                                 │
 └─────────────────────────────────────────┘        └─────────────────────────────────────────┘
```

`cwd` is the vault root (Claudian starts pi this way; any pi run inside a vault
does too). The bridge directory lives under the vault root.

## 4. File layout

All bridge state lives under the vault root:

```
.pi/obsidian-bridge/
  protocol-version          # single line, e.g. "1\n" — written by bridge on start
  bridge-info.json          # heartbeat / capability advertisement (see §6)
  requests/
    <reqId>.json            # pi writes; bridge deletes after handling
  responses/
    <reqId>.json            # bridge writes; pi deletes after consuming
  events/                   # (Phase 2) bridge → pi push channel
    <eventId>.json
```

`.pi/obsidian-bridge/` is a dedicated subtree. pi's own project files use
`.pi/settings.json`, `.pi/npm/`, `.pi/git/`; there is no collision.

## 5. Protocol v1

### 5.1 Request

```json
{
  "id": "req_01HMAAAAAAAA",
  "protocol": 1,
  "action": "read_note",
  "params": { "path": "Inbox/Note.md" },
  "createdAt": 1722000000000,
  "timeoutMs": 30000
}
```

- `id`: opaque, unique per request (ULID/UUID). Used as the filename stem.
- `protocol`: integer. pi refuses to send if the bridge advertised a different
  major version (→ `BRIDGE_PROTOCOL_MISMATCH`).
- `action`: one of the allowed action names (§8). Unknown → `ACTION_UNKNOWN`.
- `params`: action-specific object.
- `timeoutMs`: client-side deadline the bridge SHOULD honor.

### 5.2 Response

Success:

```json
{
  "id": "req_01HMAAAAAAAA",
  "protocol": 1,
  "ok": true,
  "result": { "content": "…", "stat": { "size": 123, "mtime": 1722000000000 } },
  "error": null,
  "finishedAt": 1722000000123
}
```

Failure:

```json
{
  "id": "req_01HMAAAAAAAA",
  "protocol": 1,
  "ok": false,
  "result": null,
  "error": { "code": "NOTE_NOT_FOUND", "message": "No note at Inbox/Missing.md" },
  "finishedAt": 1722000000123
}
```

### 5.3 Lifecycle

1. **pi** writes `requests/<id>.json` **atomically** (tmp file + `fs.rename`).
2. **bridge** detects the new file (via `fs.watch`, with a low-frequency poll
   backstop for reliability on some platforms) and reads it.
3. **bridge** validates `protocol`; if mismatched, responds with
   `BRIDGE_PROTOCOL_MISMATCH` and deletes the request.
4. **bridge** checks the action against its allowed set; unknown/disallowed →
   `ACTION_UNKNOWN` / `ACTION_NOT_ALLOWED`.
5. **bridge** executes the action against Obsidian APIs, then writes
   `responses/<id>.json` atomically.
6. **bridge** deletes `requests/<id>.json`.
7. **pi** observes `responses/<id>.json`, reads it, then deletes both the
   response and (defensively) the request if it still exists.

### 5.4 Timeouts & orphans

- **pi**: if `responses/<id>.json` does not appear within `timeoutMs`, pi deletes
  its own request file and fails the tool with `BRIDGE_TIMEOUT`. The orphaned
  response, if it later arrives, is harmless: pi no longer knows the `id`; the
  bridge should periodically sweep `responses/` for files older than a TTL and
  delete them.
- **bridge startup**: on `onload`, clear any stale files in `requests/` and
  `responses/` (there is no live pi session to honor them) — except while a
  reconnect protocol is finalized in Phase 2. v1 assumes single-session.

### 5.5 Atomicity

Every file write on both sides is **tmp + rename**. Neither side ever reads a
half-written file. Readers tolerate a missing file (treat as not-yet-ready or
already-consumed) rather than erroring.

## 6. Liveness & capability advertisement

`bridge-info.json` is rewritten by the bridge every ~5 s while Obsidian is open and
the plugin enabled:

```json
{
  "protocol": 1,
  "pluginVersion": "0.1.0",
  "obsidianVersion": "1.7.5",
  "vault": "MyVault",
  "capabilities": ["read_note", "write_note", "search_notes", "append_daily", "list_folders"],
  "lastSeenAt": 1722000000000,
  "status": "up"
}
```

- **pi liveness probe**: if `bridge-info.json` is missing, or
  `now - lastSeenAt > 15 s`, the bridge is **down**. Tools fail fast with
  `BRIDGE_DOWN` and an actionable message ("Open Obsidian and enable the bridge
  plugin"). No silent hang, no long poll.
- On shutdown (`onunload`) the bridge writes `status: "down"` (best-effort) and
  stops the heartbeat.

## 7. Security model

The bridge grants the agent **full vault read/write**. This is the central risk and
must be designed deliberately.

1. **Action whitelist.** Allowed actions are configurable (pi settings or the
   package's `pi.bridge` config). v1 default = the five core actions. Anything not
   whitelisted → `ACTION_NOT_ALLOWED`, never executed.
2. **Per-action confirmation.** Destructive actions (`write_note`, and any future
   delete/rename) require confirmation **before** the request is sent. In v1 the
   confirmation happens **pi-side** via `ctx.ui.confirm` for a consistent UX, with a
   setting to auto-approve. (Phase 2 may add Obsidian-side confirms too.)
3. **Path safety.** All paths are normalized and resolved against the vault root.
   Traversal (`..`) is rejected. By default, paths under `.obsidian/` and `.pi/`
   are forbidden (config can allow specific subpaths). Absolute paths rejected.
4. **No code execution.** Actions are structured vault operations only. No `eval`,
   no running of arbitrary JS, no `app.commands.executeCommandById` of arbitrary
   commands in v1 (the Phase 3 inter-plugin call is still a structured, named API
   call, not eval).
5. **Trust inheritance.** The bridge piggybacks on pi's project-trust model; it
   does not introduce a second trust gate, but it does require the bridge plugin
   to be explicitly enabled in Obsidian (a conscious user action).

## 8. Action & tool set

Each action maps 1:1 to a **pi tool** registered via `pi.registerTool()` (typebox
params). Tools are prefixed `obsidian.*`.

### v1 core (5)

| Tool                    | params                              | result                                    | Destructive       |
| ----------------------- | ----------------------------------- | ----------------------------------------- | ----------------- |
| `obsidian.read_note`    | `{ path }`                          | `{ content, stat }`                       | no                |
| `obsidian.write_note`   | `{ path, content, createFolders? }` | `{ path, created }`                       | **yes** (confirm) |
| `obsidian.search_notes` | `{ query, limit? }`                 | `{ matches: [{ path, score, excerpt }] }` | no                |
| `obsidian.append_daily` | `{ content, format? }`              | `{ path }`                                | **yes** (confirm) |
| `obsidian.list_folders` | `{ depth? }`                        | `{ folders: [...] }`                      | no                |

- `search_notes` v1 uses native vault scan + substring match; if the Omnisearch
  plugin is present, it MAY be used and advertised as a capability. Not a hard dep.
- `append_daily` resolves "today's daily note" via the core Daily Notes plugin
  config (format, folder, template). Fallback to `YYYY-MM-DD.md` at vault root.

### Future (not v1)

`obsidian.create_folder`, `obsidian.delete_note`, `obsidian.rename`, `obsidian.move`,
`obsidian.get_metadata` (frontmatter), `obsidian.call_plugin` (Phase 3, experimental).

## 9. The Obsidian-side micro-plugin

- **Plugin id:** `pi-obsidian-bridge`. **Name:** "pi-obsidian bridge".
- **Distribution (v1):** shipped **inside** the npm package at
  `obsidian-side/main.js` (plain hand-written JS, ~80 lines, **no build step**,
  matching the repo's source-first philosophy). The pi extension injects it on
  first load.
- **Injection:** on extension load, if
  `.obsidian/plugins/pi-obsidian-bridge/manifest.json` is missing, the extension
  writes `manifest.json` + `main.js` from package assets, then **notifies the user
  to enable it once** in Obsidian (Settings → Community plugins). It does not
  auto-enable (Obsidian has no supported API to force-enable a plugin).
- **`onload`:** ensure `requests/` + `responses/` dirs exist; write
  `protocol-version` + first `bridge-info.json`; start `fs.watch` on `requests/`
  (with a 2 s poll backstop); start the 5 s heartbeat interval; expose
  capabilities.
- **`onunload`:** clear watchers/intervals; write `bridge-info.json` with
  `status: "down"` (best-effort).
- **Handling:** for each request file, validate → resolve action → call Obsidian
  API → write response atomically → delete request. Errors are caught and returned
  as `error`, never thrown into Obsidian.
- **Official community plugin (Phase 4):** the same `main.js` is also published to
  the Obsidian community plugin directory for users who prefer the marketplace.

## 10. The pi-side package

- **Package:** `@pi-obsidian/bridge`. **Entry:** `index.ts` exporting the default
  factory `(pi: ExtensionAPI) => void | Promise<void>`.
- **On load:**
  1. Probe liveness (`bridge-info.json`); log status.
  2. Ensure the Obsidian-side plugin is injected (§9); notify if just injected.
  3. Read config (whitelist, confirm policy, path rules).
  4. Register one tool per whitelisted action.
- **Per tool:** validate params → path-safety check → optional `ctx.ui.confirm` for
  destructive → write request → await response (`fs.watch`/poll + `timeoutMs`) →
  return `result` to the agent (or an error string the agent can act on).
- **Degrade:** when `BRIDGE_DOWN`, tools return a clear, actionable error so the
  agent can inform the user rather than retry blindly.
- **Debug:** `PI_OBSIDIAN_DEBUG` env, stderr, tag `[pi-obsidian]` (same pattern as
  the sibling `@pi-claudian` repos).

## 11. Phasing plan

### Phase 0 — prove the pipe (internal alpha, `v0.1.0-alpha.1`)

- Freeze protocol v1 in this PRD.
- Obsidian micro-plugin: `onload`, `fs.watch`, heartbeat, handle **`ping`** and
  **`read_note`** only.
- pi side: inject plugin + liveness probe + register **`obsidian.ping`** and
  **`obsidian.read_note`** only.
- **Exit criteria:** a manual end-to-end round trip works (pi tool → file →
  Obsidian reads a note → file → pi gets content). No whitelist/security hardening
  yet. No release to npm beyond an alpha tag.

### Phase 1 — useful MVP (`v0.1.0`)

- All 5 core tools.
- Action whitelist, path safety, pi-side confirm for writes.
- Liveness probe + `BRIDGE_DOWN` degrade + all error codes.
- `PI_OBSIDIAN_DEBUG` tracing.
- README + install/enable instructions.
- Changeset + publish to npm as `@pi-obsidian/bridge@0.1.0`.

### Phase 2 — platform (`v0.2.0`)

- **Stabilize protocol v1** (no breaking changes after this without a v2).
- **Third-party author docs:** export a `bridge.request(action, params)` helper
  from the package so other pi extensions can issue bridge requests without
  reimplementing the client.
- **Event channel** (`events/`): bridge pushes unsolicited notifications
  (note created/modified/deleted, vault open/close) that other extensions/pi can
  subscribe to.
- Reconnect/session-awareness (handle Obsidian restart without losing in-flight
  intent where feasible).

### Phase 3 — extensibility (`v0.3.0`, experimental)

- `obsidian.call_plugin`: invoke named APIs of installed plugins (Dataview
  queries, Tasks, Excalidraw, …). Marked experimental; capability-advertised.
- Batch actions (multiple ops in one request) for efficiency.
- Streaming/pagination for large reads.

### Phase 4 — stable (`v1.0.0`)

- Test suite (protocol conformance, path safety, liveness).
- Publish the Obsidian-side plugin to the community plugin directory.
- Protocol v1 final; semver stability guarantee for the public `bridge.request`
  helper and the action schemas.

## 12. Package layout

```
packages/bridge/
  package.json          # @pi-obsidian/bridge; pi.extensions -> ./index.ts
  tsconfig.json
  index.ts              # pi-side factory + tool registration + bridge client
  bridge-client.ts      # request/response + liveness + atomic file helpers
  config.ts             # whitelist, path rules, confirm policy
  debug.ts              # PI_OBSIDIAN_DEBUG helper
  obsidian-side/
    manifest.json       # Obsidian plugin manifest (id: pi-obsidian-bridge)
    main.js            # hand-written plugin (onload/fs.watch/heartbeat/handle)
  README.md
  docs/                 # protocol reference (generated from this PRD's §5–6)
```

## 13. Open questions

- **Concurrent sessions:** v1 assumes one pi session per vault. Multi-session
  arbitration (which session owns requests) is deferred; document as a limitation.
- **Daily-notes source:** core Daily Notes vs Periodic Notes Notes plugin — v1
  reads core config, falls back to `YYYY-MM-DD.md`.
- **`fs.watch` reliability:** some platforms (network drives, some Linux inotify
  limits) miss events; the poll backstop is mandatory, not optional.
- **Large notes:** reading a 10 MB note over file RPC is fine; returning it through
  a tool result consumes agent context. v1 returns full content; Phase 3 adds
  range/stat-only reads.

## 14. Risks

1. **Security (highest):** full vault write in the agent's hands. Mitigated by §7
   but must be communicated loudly to users.
2. **Obsidian API churn:** internal plugin APIs are not stability-guaranteed; the
   Phase 3 inter-plugin calls can break on Obsidian upgrades. Best-effort + version
   gating.
3. **Liveness false negatives:** slow disks / paused apps can stall heartbeats.
   Tunable threshold (default 15 s) + clear `BRIDGE_DOWN` messaging.
4. **File-RPC latency:** adequate for interactive tool calls; not for bulk ops.
   Phase 3 batch/streaming addresses scale.
5. **Maintenance surface:** Obsidian-side plugin + protocol + pi client is a larger
   long-term commitment than a typical pi extension.

## 15. Success metrics (qualitative, v1)

- A user can `pi install npm:@pi-obsidian-bridge`, enable the injected plugin once,
  and have the agent read/search/append their vault within a single session.
- A third-party author can register an additional `obsidian.*` tool on top of the
  exported `bridge.request` helper with < 50 lines, without touching the protocol.
- `BRIDGE_DOWN` is always actionable (never a silent hang), and `BRIDGE_TIMEOUT` is
  rare under normal interactive use.
