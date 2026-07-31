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
 */
"use strict";

const { Plugin } = require("obsidian");

const PROTOCOL_VERSION = 1;
const SERVER_VERSION = "pi-obsidian-bridge@0.1.0-alpha.1";
const HANDSHAKE_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/* ------------------------------------------------------------------ *
 * Minimal RFC 6455 server-side socket (unmasked server frames, masked
 * client frames). Handles text, close, and ping/pong; ignores
 * continuation/binary for the Phase 0 protocol subset.
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
      // close
      this._handleClose();
    } else if (opcode === 0x9) {
      // ping -> pong
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

class PiObsidianBridgePlugin extends Plugin {
  onload() {
    this.sockets = new Set();
    this.startServer();
    this.addRibbonIcon("dice", "pi-obsidian bridge", () => {
      new (require("obsidian").Notice)(
        `pi-obsidian bridge ${this.port ? "up on port " + this.port : "starting…"} (${this.socketCount()} client${this.socketCount() === 1 ? "" : "s"})`,
        4000,
      );
    });
  }

  socketCount() {
    return this.sockets.size;
  }

  startServer() {
    const http = require("http");
    const crypto = require("crypto");
    this.authToken = crypto.randomUUID();
    this.server = http.createServer((_req, res) => {
      res.writeHead(404);
      res.end();
    });
    this.server.on("upgrade", (req, socket, _head) => this._onUpgrade(req, socket));
    this.server.on("error", (e) => {
      console.error("[pi-obsidian-bridge] server error", e);
    });
    this.server.listen(0, "127.0.0.1", () => {
      this.port = this.server.address().port;
      this._writeLock().catch((e) =>
        console.error("[pi-obsidian-bridge] lockfile write failed", e),
      );
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
        capabilities: ["ping", "ui.notify"],
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

  async _dispatch(method, params) {
    if (method === "ping") {
      return { pong: true, server: SERVER_VERSION, vault: this._vaultName() };
    }
    if (method === "ui.notify") {
      const { Notice } = require("obsidian");
      const message = params && params.message != null ? String(params.message) : "";
      const timeoutMs = params && Number.isFinite(params.timeoutMs) ? params.timeoutMs : 5000;
      new Notice(message, timeoutMs);
      return {};
    }
    const err = new Error("ACTION_UNKNOWN: " + method);
    err.code = "ACTION_UNKNOWN";
    throw err;
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
      pluginVersion: "0.1.0-alpha.1",
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
    try {
      if (this.server) this.server.close();
    } catch (_e) {}
    for (const s of this.sockets) {
      try {
        s.close();
      } catch (_e) {}
    }
    this.sockets.clear();
    try {
      const fs = require("fs");
      const path = require("path");
      const base = this.app.vault.adapter.getBasePath();
      const dest = path.join(base, ".pi", "obsidian-bridge", "ws.lock");
      await fs.promises.unlink(dest).catch(() => {});
    } catch (_e) {}
  }
}

module.exports = PiObsidianBridgePlugin;
