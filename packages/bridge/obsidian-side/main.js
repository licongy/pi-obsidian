/*
 * pi-obsidian-bridge — Obsidian-side resident plugin.
 *
 * Hand-written, dependency-free, runs inside Obsidian (Electron). Uses Node
 * built-ins (http, crypto, fs, path) to run a tiny RFC 6455 WebSocket server and
 * write a discovery lockfile. The pi side connects and exchanges JSON-RPC 2.0
 * over the socket.
 *
 * This file must NOT `import "obsidian"` (ESM): Obsidian provides the `obsidian`
 * module at runtime via require(), exactly like built community plugins.
 *
 * Phase 1 capabilities:
 *   ping, ui.notify, ui.status_bar.{set,clear}, ui.open_note,
 *   ui.execute_command, read_note, write_note, search_notes,
 *   append_daily, call_plugin
 *   + event forwarding (vault_changed, app_state)
 *   + built-in bridge panel (view_action events)
 */
"use strict";

const { Plugin, ItemView, Notice } = require("obsidian");

const PROTOCOL_VERSION = 1;
const SERVER_VERSION = "pi-obsidian-bridge@0.1.0";
const HANDSHAKE_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const VIEW_TYPE_PI_PANEL = "pi-obsidian-panel";
const DEFAULT_MAX_BYTES = 100000;

/* ------------------------------------------------------------------ *
 * Minimal RFC 6455 server-side socket.
 * ------------------------------------------------------------------ */
class WSSocket {
  constructor(stream) {
    this.stream = stream;
    this.buf = Buffer.alloc(0);
    this.onmessage = null;
    this.onclose = null;
    this.closed = false;
    stream.on("data", (chunk) => this._onData(chunk));
    stream.on("close", () => this._handleClose());
    stream.on("error", () => {
      try {
        stream.destroy();
      } catch (_) {}
    });
  }

  _onData(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    while (this.buf.length >= 2) {
      if (!this._parseFrame()) break;
    }
  }

  _parseFrame() {
    const b = this.buf;
    const b0 = b[0];
    const b1 = b[1];
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let p = 2;
    if (len === 126) {
      if (b.length < 4) return false;
      len = b.readUInt16BE(2);
      p = 4;
    } else if (len === 127) {
      if (b.length < 10) return false;
      len = Number(b.readBigUInt64BE(2));
      p = 10;
    }
    let mask = null;
    if (masked) {
      if (b.length < p + 4) return false;
      mask = b.subarray(p, p + 4);
      p += 4;
    }
    if (b.length < p + len) return false;
    let payload = b.subarray(p, p + len);
    if (masked) {
      const un = Buffer.allocUnsafe(len);
      for (let k = 0; k < len; k++) un[k] = payload[k] ^ mask[k % 4];
      payload = un;
    }
    this.buf = b.subarray(p + len);

    if (opcode === 0x8) {
      this._handleClose();
    } else if (opcode === 0x9) {
      this._sendFrame(0x0a, payload);
    } else if (opcode === 0x0a) {
      // pong, ignore
    } else if (opcode === 0x1) {
      const text = payload.toString("utf8");
      if (this.onmessage) this.onmessage(text);
    }
    return true;
  }

  _sendFrame(opcode, payload) {
    if (this.closed) return;
    const pl = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, "utf8");
    let header;
    if (pl.length < 126) {
      header = Buffer.from([0x80 | opcode, pl.length]);
    } else if (pl.length < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(pl.length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(pl.length), 2);
    }
    try {
      this.stream.write(Buffer.concat([header, pl]));
    } catch (_) {}
  }

  send(text) {
    this._sendFrame(0x1, text);
  }

  _handleClose() {
    if (this.closed) return;
    this.closed = true;
    if (this.onclose) this.onclose();
    try {
      this.stream.destroy();
    } catch (_) {}
  }

  close() {
    this._sendFrame(0x8, Buffer.alloc(0));
    this._handleClose();
  }
}

/* ------------------------------------------------------------------ *
 * Built-in bridge panel — lets users without a terminal interact.
 * ------------------------------------------------------------------ */
class BridgePanelView extends ItemView {
  getViewType() {
    return VIEW_TYPE_PI_PANEL;
  }
  getDisplayText() {
    return "pi-obsidian panel";
  }
  getIcon() {
    return "dice";
  }

  async onOpen() {
    const container = this.containerEl.children[1];
    container.empty();
    container.addClass("pi-obsidian-panel");

    container.createEl("h2", { text: "pi-obsidian bridge" });

    const statusEl = container.createEl("p", {
      text: "Checking connection…",
      cls: "pi-obsidian-panel-status",
    });

    const updateStatus = () => {
      const count = this.app.plugins.plugins["pi-obsidian-bridge"]
        ? this.app.plugins.plugins["pi-obsidian-bridge"].socketCount()
        : 0;
      const port = this.app.plugins.plugins["pi-obsidian-bridge"]
        ? this.app.plugins.plugins["pi-obsidian-bridge"].port
        : null;
      statusEl.setText(
        `Bridge: ${port ? "up (port " + port + ", " + count + " client" + (count === 1 ? "" : "s") + ")" : "starting…"}`,
      );
    };
    updateStatus();
    this._statusInterval = setInterval(updateStatus, 2000);

    const sep = container.createEl("hr");
    sep.style.cssText =
      "border:none;border-top:1px solid var(--background-modifier-border);margin:12px 0;";

    container.createEl("p", {
      text: "Send a message to the pi agent:",
      cls: "pi-obsidian-panel-hint",
    });

    const inputEl = container.createEl("textarea", {
      attr: {
        rows: "3",
        placeholder: "Type a message or instruction…",
        style: "width:100%;resize:vertical;",
      },
    });

    const btnRow = container.createDiv({ cls: "pi-obsidian-panel-buttons" });
    btnRow.style.cssText = "display:flex;gap:8px;margin-top:8px;";

    const sendBtn = btnRow.createEl("button", { text: "Send to pi" });
    sendBtn.addEventListener("click", () => {
      const text = inputEl.value.trim();
      if (!text) return;
      const plugin = this.app.plugins.plugins["pi-obsidian-bridge"];
      if (plugin) {
        plugin._emitEvent("view_action", {
          viewType: VIEW_TYPE_PI_PANEL,
          action: "user_message",
          payload: { text },
        });
        new Notice("Sent to pi agent", 2000);
        inputEl.value = "";
      }
    });

    const notifyBtn = btnRow.createEl("button", { text: "Notify" });
    notifyBtn.addEventListener("click", () => {
      const text = inputEl.value.trim();
      if (!text) return;
      new Notice(text, 5000);
    });
  }

  async onClose() {
    if (this._statusInterval) {
      clearInterval(this._statusInterval);
      this._statusInterval = null;
    }
  }
}

/* ------------------------------------------------------------------ *
 * Main plugin
 * ------------------------------------------------------------------ */
class PiObsidianBridgePlugin extends Plugin {
  onload() {
    this.sockets = new Set();
    this.statusBarItems = new Map();
    this._eventRefs = [];
    this.startServer();

    this.registerView(VIEW_TYPE_PI_PANEL, (leaf) => new BridgePanelView(leaf));

    this.addRibbonIcon("dice", "pi-obsidian bridge", () => {
      this.app.workspace.getLeaf("tab").setViewState({
        type: VIEW_TYPE_PI_PANEL,
        active: true,
      });
    });

    // Forward vault events to connected pi clients.
    this._registerVaultEvent("create", "create");
    this._registerVaultEvent("modify", "modify");
    this._registerVaultEvent("delete", "delete");
  }

  socketCount() {
    return this.sockets.size;
  }

  _registerVaultEvent(eventName, changeLabel) {
    const ref = this.app.vault.on(eventName, (file) => {
      if (file && file.path) {
        this._emitEvent("vault_changed", { path: file.path, change: changeLabel });
      }
    });
    this._eventRefs.push(ref);
    this.registerEvent(ref);
  }

  _emitEvent(type, payload) {
    const notif = JSON.stringify({
      jsonrpc: "2.0",
      method: "event",
      params: { type, payload },
    });
    for (const s of this.sockets) {
      try {
        s.send(notif);
      } catch (_) {}
    }
  }

  startServer() {
    const http = require("http");
    const crypto = require("crypto");
    this.authToken = crypto.randomUUID();
    this.server = http.createServer((_req, res) => {
      res.writeHead(404);
      res.end();
    });
    this.server.on("upgrade", (req, socket) => this._onUpgrade(req, socket));
    this.server.on("error", (e) => {
      console.error("[pi-obsidian-bridge] server error", e);
    });
    this.server.listen(0, "127.0.0.1", () => {
      this.port = this.server.address().port;
      this._writeLock().catch((e) =>
        console.error("[pi-obsidian-bridge] lockfile write failed", e),
      );
      this._emitEvent("app_state", {
        vault: this._vaultName(),
        online: true,
      });
    });
  }

  _onUpgrade(req, socket) {
    const auth = req.headers["x-pi-obsidian-auth"];
    if (auth !== this.authToken) {
      socket.destroy();
      return;
    }
    const key = req.headers["sec-websocket-key"];
    if (!key) {
      socket.destroy();
      return;
    }
    const accept = require("crypto")
      .createHash("sha1")
      .update(key + HANDSHAKE_GUID)
      .digest("base64");
    socket.write(
      [
        "HTTP/1.1 101 Switching Protocols",
        "Upgrade: websocket",
        "Connection: Upgrade",
        "Sec-WebSocket-Accept: " + accept,
        "",
        "",
      ].join("\r\n"),
    );
    const ws = new WSSocket(socket);
    ws.onmessage = (text) => {
      this._onMessage(ws, text).catch((e) =>
        console.error("[pi-obsidian-bridge] handler error", e),
      );
    };
    ws.onclose = () => this.sockets.delete(ws);
    this.sockets.add(ws);
  }

  async _onMessage(ws, text) {
    let msg;
    try {
      msg = JSON.parse(text);
    } catch (_e) {
      ws.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: "Parse error" },
        }),
      );
      return;
    }

    if (msg.method === "initialize") {
      const result = {
        protocol: PROTOCOL_VERSION,
        server: SERVER_VERSION,
        obsidianVersion: this._obsidianVersion(),
        vault: this._vaultName(),
        capabilities: [
          "ping",
          "ui.notify",
          "ui.status_bar.set",
          "ui.status_bar.clear",
          "ui.open_note",
          "ui.execute_command",
          "read_note",
          "write_note",
          "search_notes",
          "append_daily",
          "call_plugin",
        ],
      };
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
      return;
    }

    try {
      const result = await this._dispatch(msg.method, msg.params || {});
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
    } catch (e) {
      const code = (e && e.code) || "INTERNAL_ERROR";
      const message = code + ": " + (e && e.message ? e.message : "");
      ws.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: -32000, message, data: { code } },
        }),
      );
    }
  }

  /* ---- action dispatcher ---- */

  async _dispatch(method, params) {
    switch (method) {
      case "ping":
        return { pong: true, server: SERVER_VERSION, vault: this._vaultName() };

      case "ui.notify":
        return this._uiNotify(params);

      case "ui.status_bar.set":
        return this._statusBarSet(params);

      case "ui.status_bar.clear":
        return this._statusBarClear(params);

      case "ui.open_note":
        return this._openNote(params);

      case "ui.execute_command":
        return this._executeCommand(params);

      case "read_note":
        return this._readNote(params);

      case "write_note":
        return this._writeNote(params);

      case "search_notes":
        return this._searchNotes(params);

      case "append_daily":
        return this._appendDaily(params);

      case "call_plugin":
        return this._callPlugin(params);

      default: {
        const err = new Error("ACTION_UNKNOWN: " + method);
        err.code = "ACTION_UNKNOWN";
        throw err;
      }
    }
  }

  /* ---- UI actions ---- */

  _uiNotify(params) {
    const message = params && params.message != null ? String(params.message) : "";
    const timeoutMs = params && Number.isFinite(params.timeoutMs) ? params.timeoutMs : 5000;
    new Notice(message, timeoutMs);
    return {};
  }

  _statusBarSet(params) {
    const key = String(params.key || "default");
    const text = String(params.text ?? "");
    const cls = params.cls ? String(params.cls) : null;
    let el = this.statusBarItems.get(key);
    if (!el) {
      el = this.addStatusBarItem();
      this.statusBarItems.set(key, el);
    }
    el.empty();
    el.setText(text);
    if (cls) el.addClass(cls);
    return {};
  }

  _statusBarClear(params) {
    const key = String(params.key || "");
    const el = this.statusBarItems.get(key);
    if (el) {
      el.remove();
      this.statusBarItems.delete(key);
    }
    return {};
  }

  async _openNote(params) {
    const p = String(params.path || "");
    if (!p) throw this._err("PATH_INVALID", "empty path");
    await this.app.workspace.openLinkText(p, "", params.newLeaf === true);
    return {};
  }

  _executeCommand(params) {
    const id = String(params.commandId || "");
    if (!id) throw this._err("ACTION_UNKNOWN", "empty commandId");
    this.app.commands.executeCommandById(id);
    return {};
  }

  /* ---- vault actions ---- */

  async _readNote(params) {
    const p = String(params.path || "");
    if (!p) throw this._err("PATH_INVALID", "empty path");
    this._validatePath(p);
    const file = this.app.vault.getAbstractFileByPath(p);
    if (!file || !file.path) throw this._err("NOTE_NOT_FOUND", "No note at " + p);
    const content = await this.app.vault.cachedRead(file);
    const stat = {
      size: (file.stat && file.stat.size) || content.length,
      mtime: (file.stat && file.stat.mtime) || 0,
    };
    const maxBytes = params.maxBytes || DEFAULT_MAX_BYTES;
    if (content.length > maxBytes) {
      return {
        content: content.substring(0, maxBytes),
        stat,
        truncated: true,
      };
    }
    return { content, stat };
  }

  async _writeNote(params) {
    const p = String(params.path || "");
    if (!p) throw this._err("PATH_INVALID", "empty path");
    this._validatePath(p);
    const content = String(params.content ?? "");
    const file = this.app.vault.getAbstractFileByPath(p);
    if (file && file.path) {
      await this.app.vault.modify(file, content);
      return { path: p, created: false };
    }
    if (params.createFolders !== false) {
      const slash = p.lastIndexOf("/");
      if (slash > 0) {
        const folder = p.substring(0, slash);
        const existing = this.app.vault.getAbstractFileByPath(folder);
        if (!existing) {
          try {
            await this.app.vault.createFolder(folder);
          } catch (_e) {
            // folder may have been created concurrently
          }
        }
      }
    }
    await this.app.vault.create(p, content);
    return { path: p, created: true };
  }

  async _searchNotes(params) {
    const query = String(params.query || "").toLowerCase();
    if (!query) return { matches: [] };
    const limit = params.limit || 50;
    const files = this.app.vault.getMarkdownFiles();
    const matches = [];
    for (const file of files) {
      if (matches.length >= limit) break;
      const content = await this.app.vault.cachedRead(file);
      const idx = content.toLowerCase().indexOf(query);
      if (idx >= 0) {
        const start = Math.max(0, idx - 50);
        const end = Math.min(content.length, idx + query.length + 50);
        matches.push({
          path: file.path,
          score: 1,
          excerpt: content.substring(start, end).replace(/\n/g, " "),
        });
      }
    }
    return { matches };
  }

  async _appendDaily(params) {
    const content = String(params.content ?? "");
    const dailyPath = this._resolveDailyNotePath(params.format);
    const file = this.app.vault.getAbstractFileByPath(dailyPath);
    if (file && file.path) {
      const existing = await this.app.vault.cachedRead(file);
      const sep = existing && !existing.endsWith("\n") ? "\n" : "";
      await this.app.vault.modify(file, existing + sep + content);
    } else {
      const slash = dailyPath.lastIndexOf("/");
      if (slash > 0) {
        const folder = dailyPath.substring(0, slash);
        const existing = this.app.vault.getAbstractFileByPath(folder);
        if (!existing) {
          try {
            await this.app.vault.createFolder(folder);
          } catch (_e) {
            // ignore concurrent creation
          }
        }
      }
      await this.app.vault.create(dailyPath, content);
    }
    return { path: dailyPath };
  }

  /* ---- call_plugin ---- */

  async _callPlugin(params) {
    const pluginId = String(params.pluginId || "");
    const methodName = String(params.method || "");
    if (!pluginId || !methodName) throw this._err("ACTION_UNKNOWN", "pluginId and method required");
    const plugin = this.app.plugins.plugins[pluginId];
    if (!plugin) throw this._err("PLUGIN_NOT_FOUND", "Plugin not found: " + pluginId);
    const api = plugin.api || plugin;
    const method = api[methodName];
    if (typeof method !== "function")
      throw this._err("METHOD_NOT_FOUND", "Method not found: " + pluginId + "." + methodName);
    const args = Array.isArray(params.args) ? params.args : [];
    const result = await method.apply(api, args);
    return { result: this._sanitize(result) };
  }

  _sanitize(value) {
    if (value === undefined) return null;
    if (value === null) return null;
    if (typeof value === "function") return null;
    if (typeof value !== "object") return value;
    try {
      JSON.stringify(value);
      return value;
    } catch (_e) {
      return "[unserializable]";
    }
  }

  /* ---- daily notes config resolution (§9.4) ---- */

  _resolveDailyNotePath(formatOverride) {
    const fs = require("fs");
    const path = require("path");
    const base = this.app.vault.adapter.getBasePath();

    let format = "YYYY-MM-DD";
    let folder = "";

    if (formatOverride && typeof formatOverride === "string") {
      format = formatOverride;
    } else {
      // 1. Check if daily-notes core plugin is enabled.
      try {
        const corePlugins = JSON.parse(
          fs.readFileSync(path.join(base, ".obsidian", "core-plugins.json"), "utf8"),
        );
        const enabled =
          corePlugins && (corePlugins["daily-notes"] === true || corePlugins["daily-notes"]);
        if (!enabled) {
          // Fall back to default but still try reading config.
        }
      } catch (_e) {}

      // 2. Read Daily Notes plugin config.
      try {
        const data = JSON.parse(
          fs.readFileSync(
            path.join(base, ".obsidian", "plugins", "daily-notes", "data.json"),
            "utf8",
          ),
        );
        if (data.format && typeof data.format === "string") format = data.format;
        if (data.folder && typeof data.folder === "string") folder = data.folder;
      } catch (_e) {}
    }

    const dateStr = this._formatDate(new Date(), format);
    const filename = dateStr.endsWith(".md") ? dateStr : dateStr + ".md";
    return folder ? folder.replace(/\/+$/, "") + "/" + filename : filename;
  }

  _formatDate(date, format) {
    const pad = (n) => String(n).padStart(2, "0");
    const tokens = [
      ["YYYY", String(date.getFullYear())],
      ["YY", String(date.getFullYear()).slice(-2)],
      ["MM", pad(date.getMonth() + 1)],
      ["DD", pad(date.getDate())],
      ["HH", pad(date.getHours())],
      ["mm", pad(date.getMinutes())],
      ["ss", pad(date.getSeconds())],
    ];
    let result = format;
    // Replace longer tokens first to avoid partial overlaps.
    for (const [token, value] of tokens) {
      result = result.split(token).join(value);
    }
    return result;
  }

  /* ---- path validation (mirrors pi-side path-safety.ts) ---- */

  _validatePath(rawPath) {
    if (!rawPath || typeof rawPath !== "string" || rawPath.trim() === "")
      throw this._err("PATH_INVALID", "empty path");
    const path = require("path");
    if (path.isAbsolute(rawPath)) throw this._err("PATH_INVALID", "absolute path: " + rawPath);
    const base = this.app.vault.adapter.getBasePath();
    const resolved = path.resolve(base, rawPath);
    const rel = path.relative(base, resolved);
    if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel))
      throw this._err("PATH_INVALID", "traversal: " + rawPath);
    const normalized = rel.split(path.sep).join("/");
    const top = normalized.split("/")[0];
    if (top === ".pi") throw this._err("PATH_FORBIDDEN", ".pi/ is forbidden: " + rawPath);
    if (top === ".obsidian")
      throw this._err("PATH_FORBIDDEN", ".obsidian/ is forbidden: " + rawPath);
    return normalized;
  }

  /* ---- misc helpers ---- */

  _err(code, message) {
    const e = new Error(code + ": " + (message || code));
    e.code = code;
    return e;
  }

  _vaultName() {
    try {
      const base = this.app.vault.adapter.getBasePath();
      const parts = base.split(/[/\\]/).filter(Boolean);
      return parts[parts.length - 1] || "vault";
    } catch (_e) {
      return "vault";
    }
  }

  _obsidianVersion() {
    try {
      return this.app && this.app.version ? this.app.version : "unknown";
    } catch (_e) {
      return "unknown";
    }
  }

  async _writeLock() {
    const fs = require("fs");
    const path = require("path");
    const base = this.app.vault.adapter.getBasePath();
    const dir = path.join(base, ".pi", "obsidian-bridge");
    await fs.promises.mkdir(dir, { recursive: true });
    const lock = {
      pid: process.pid,
      port: this.port,
      authToken: this.authToken,
      pluginVersion: "0.1.0",
      obsidianVersion: this._obsidianVersion(),
      vault: this._vaultName(),
      startedAt: Date.now(),
    };
    const tmp = path.join(dir, ".ws.lock.tmp");
    const dest = path.join(dir, "ws.lock");
    await fs.promises.writeFile(tmp, JSON.stringify(lock, null, 2));
    await fs.promises.rename(tmp, dest);
  }

  async onunload() {
    this._emitEvent("app_state", { vault: this._vaultName(), online: false });

    // Remove persistent status bar items.
    for (const el of this.statusBarItems.values()) {
      try {
        el.remove();
      } catch (_) {}
    }
    this.statusBarItems.clear();

    try {
      if (this.server) this.server.close();
    } catch (_) {}
    for (const s of this.sockets) {
      try {
        s.close();
      } catch (_) {}
    }
    this.sockets.clear();

    try {
      const fs = require("fs");
      const path = require("path");
      const base = this.app.vault.adapter.getBasePath();
      const dest = path.join(base, ".pi", "obsidian-bridge", "ws.lock");
      await fs.promises.unlink(dest).catch(() => {});
    } catch (_) {}
  }
}

module.exports = PiObsidianBridgePlugin;
