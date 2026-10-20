"use strict";

// Node test for WebSocket stability, reconnection, heartbeats, and slow-network
// resilience across Insurance (renderer/common.js) and InsuranceServer
// (Users/websocket.js, Mail/ProcessEmail.js).
//
// Run with:  node Test/websocket.test.cjs

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { EventEmitter } = require("events");
const { serverFile } = require("./serverPath.cjs");

let passed = 0;
let failed = 0;

async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log("  PASS  " + name);
  } catch (err) {
    failed++;
    console.log("  FAIL  " + name);
    console.log("        " + (err && err.message ? err.message : err));
  }
}

function eq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${label}: expected ${e}, got ${a}`);
}

function ok(cond, label) {
  if (!cond) throw new Error(`${label}: expected truthy, got ${cond}`);
}

function createClientHarness() {
  let now = 1_000_000;
  let nextTimerId = 1;
  const timers = new Map();
  const sockets = [];
  const windowListeners = new Map();
  const docListeners = new Map();
  const storage = new Map([
    ["token", "tok-worker"],
    ["branch", "ГКПП Лесово"],
    ["username", "worker1"],
    ["role", "2"],
  ]);

  function setTimer(fn, ms, interval) {
    const id = nextTimerId++;
    const delay = Math.max(0, Number(ms) || 0);
    timers.set(id, { fn, at: now + delay, interval: interval ? delay : 0 });
    return id;
  }

  function clearTimer(id) {
    timers.delete(id);
  }

  function advance(ms) {
    const target = now + ms;
    while (true) {
      let earliestId = null;
      let earliest = null;
      for (const [id, t] of timers.entries()) {
        if (t.at <= target && (!earliest || t.at < earliest.at)) {
          earliest = t;
          earliestId = id;
        }
      }
      if (!earliest) break;
      now = earliest.at;
      if (earliest.interval > 0) {
        earliest.at = now + earliest.interval;
      } else {
        timers.delete(earliestId);
      }
      earliest.fn();
    }
    now = target;
  }

  class FakeWebSocket {
    constructor(url) {
      this.url = url;
      this.readyState = FakeWebSocket.CONNECTING;
      this.sent = [];
      this.listeners = new Map();
      this.closed = false;
      sockets.push(this);
    }
    addEventListener(type, fn) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(fn);
    }
    emit(type, ev = {}) {
      for (const fn of this.listeners.get(type) || []) fn(ev);
    }
    send(data) {
      if (this.readyState !== FakeWebSocket.OPEN) {
        throw new Error("Socket not open");
      }
      this.sent.push(JSON.parse(data));
    }
    close() {
      if (this.closed) return;
      this.closed = true;
      this.readyState = FakeWebSocket.CLOSED;
      this.emit("close", { code: 1000, reason: "" });
    }
    serverOpen() {
      this.readyState = FakeWebSocket.OPEN;
      this.emit("open", {});
    }
    serverMessage(obj) {
      this.emit("message", { data: JSON.stringify(obj) });
    }
  }
  FakeWebSocket.CONNECTING = 0;
  FakeWebSocket.OPEN = 1;
  FakeWebSocket.CLOSING = 2;
  FakeWebSocket.CLOSED = 3;

  const localStorage = {
    getItem: (k) => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => storage.set(k, String(v)),
    removeItem: (k) => storage.delete(k),
  };

  const dummyEl = () => ({
    className: "",
    textContent: "",
    title: "",
    style: {},
    classList: {
      toggle: () => {},
      add: () => {},
      remove: () => {},
      contains: () => true,
    },
    setAttribute: () => {},
    getAttribute: () => null,
    appendChild: () => {},
    replaceChildren: () => {},
    addEventListener: () => {},
    remove: () => {},
    childNodes: [],
  });

  const ctx = {
    console: { log: () => {}, warn: () => {}, error: () => {} },
    URL,
    URLSearchParams,
    Date: { now: () => now },
    Math,
    Number,
    String,
    Boolean,
    Array,
    Object,
    Set,
    Map,
    Error,
    JSON,
    Promise,
    setTimeout: (fn, ms) => setTimer(fn, ms, false),
    clearTimeout: clearTimer,
    setInterval: (fn, ms) => setTimer(fn, ms, true),
    clearInterval: clearTimer,
    WebSocket: FakeWebSocket,
    localStorage,
    fetch: async () => ({ status: 200, ok: true, text: async () => "ok" }),
    location: { href: "" },
    window: {
      addEventListener: (name, fn) => {
        if (!windowListeners.has(name)) windowListeners.set(name, []);
        windowListeners.get(name).push(fn);
      },
      removeEventListener: (name, fn) => {
        const list = windowListeners.get(name) || [];
        const idx = list.indexOf(fn);
        if (idx !== -1) list.splice(idx, 1);
      },
      bridge: {
        LoadNewPage: () => {},
        WsHandshakeProbe: async () => null,
      },
    },
    document: {
      visibilityState: "visible",
      documentElement: { lang: "bg" },
      body: dummyEl(),
      querySelector: () => null,
      querySelectorAll: () => [],
      createElement: () => dummyEl(),
      addEventListener: (name, fn) => {
        if (!docListeners.has(name)) docListeners.set(name, []);
        docListeners.get(name).push(fn);
      },
      removeEventListener: (name, fn) => {
        const list = docListeners.get(name) || [];
        const idx = list.indexOf(fn);
        if (idx !== -1) list.splice(idx, 1);
      },
    },
  };
  ctx.window.document = ctx.document;

  const commonCode = fs.readFileSync(
    path.join(__dirname, "..", "renderer", "common.js"),
    "utf8"
  );
  vm.createContext(ctx);
  vm.runInContext(
    commonCode +
      "\nthis.__exports = { UnreadEmailSocket, normalizeWsUrl, queueDurableEmailWsAction, clearDurableEmailWsAction, loadDurableEmailWsActions };",
    ctx,
    { filename: "renderer/common.js" }
  );

  return {
    ...ctx.__exports,
    sockets,
    advance,
    storage,
    emitWindow: (name) => {
      for (const fn of windowListeners.get(name) || []) fn();
    },
  };
}

function createServerWsHarness({ dbQuery } = {}) {
  let now = 2_000_000;
  let nextTimerId = 1;
  const timers = new Map();

  function setTimer(fn, ms, interval) {
    const id = nextTimerId++;
    const delay = Math.max(0, Number(ms) || 0);
    const handle = { id, unref: () => handle };
    timers.set(id, { fn, at: now + delay, interval: interval ? delay : 0 });
    return handle;
  }

  function clearTimer(handle) {
    if (!handle) return;
    timers.delete(typeof handle === "object" ? handle.id : handle);
  }

  async function advance(ms) {
    for (let i = 0; i < 5; i++) await Promise.resolve();
    const target = now + ms;
    while (true) {
      let earliestId = null;
      let earliest = null;
      for (const [id, t] of timers.entries()) {
        if (t.at <= target && (!earliest || t.at < earliest.at)) {
          earliest = t;
          earliestId = id;
        }
      }
      if (!earliest) break;
      now = earliest.at;
      if (earliest.interval > 0) {
        earliest.at = now + earliest.interval;
      } else {
        timers.delete(earliestId);
      }
      await earliest.fn();
      for (let i = 0; i < 5; i++) await Promise.resolve();
    }
    now = target;
    for (let i = 0; i < 5; i++) await Promise.resolve();
  }

  class FakeServerClient extends EventEmitter {
    constructor() {
      super();
      this.readyState = 1;
      this.bufferedAmount = 0;
      this.sent = [];
      this.pings = 0;
      this.terminated = false;
      this.closedWith = null;
    }
    send(data) {
      this.sent.push(JSON.parse(data));
    }
    ping() {
      this.pings++;
    }
    terminate() {
      this.terminated = true;
      this.readyState = 3;
      this.emit("close");
    }
    close(code, reason) {
      this.closedWith = { code, reason };
      this.readyState = 3;
      this.emit("close");
    }
  }

  class FakeWSS extends EventEmitter {
    constructor(opts) {
      super();
      this.opts = opts;
      this.clients = new Set();
    }
    handleUpgrade(req, socket, head, cb) {
      const ws = new FakeServerClient();
      this.clients.add(ws);
      ws.on("close", () => this.clients.delete(ws));
      cb(ws);
    }
  }

  const emails = new Map();
  const claims = new Map();

  const fakeMailStore = {
    wasHandled: () => false,
    listGmail: () => [],
    get: (id) => emails.get(id) || null,
    listAll: () =>
      Array.from(emails.values()).filter((e) => !claims.has(e.messageId)),
    claim: (id, user) => {
      if (!emails.has(id)) return false;
      if (claims.has(id) && claims.get(id) !== user) return false;
      claims.set(id, user);
      return true;
    },
    unclaim: (id) => claims.delete(id),
    getClaimer: (id) => claims.get(id) || null,
    remove: (id) => {
      emails.delete(id);
      claims.delete(id);
    },
    touchReleased: () => {},
    syncReadState: async () => {},
  };

  const stubs = {
    ws: {
      WebSocketServer: FakeWSS,
      WebSocket: { OPEN: 1, CLOSED: 3 },
    },
    "../Mail/mailStore.js": fakeMailStore,
    "../Mail/branchRouting.js": { canSeeEmail: () => true },
    "../Mail/ProcessEmail.js": {
      ProcessEmail: async () => null,
      getAttachment: async () => null,
    },
  };

  const ctx = {
    module: { exports: {} },
    exports: {},
    require: (id) => {
      if (!Object.prototype.hasOwnProperty.call(stubs, id)) {
        throw new Error("Unexpected require: " + id);
      }
      return stubs[id];
    },
    process: { env: {} },
    console: { log: () => {}, warn: () => {}, error: () => {} },
    URL,
    Set,
    Map,
    Date: { now: () => now },
    setTimeout: (fn, ms) => setTimer(fn, ms, false),
    clearTimeout: clearTimer,
    setInterval: (fn, ms) => setTimer(fn, ms, true),
    clearInterval: clearTimer,
  };
  ctx.exports = ctx.module.exports;

  const wsServerCode = fs.readFileSync(
    serverFile("Users", "websocket.js"),
    "utf8"
  );
  vm.createContext(ctx);
  vm.runInContext(wsServerCode, ctx, { filename: "Users/websocket.js" });

  const serverEmitter = new EventEmitter();
  const db = {
    query:
      dbQuery ||
      (async (sql, [token]) => {
        if (token === "valid-worker-1") {
          return [[{ Username: "worker1", Role: 2 }]];
        }
        return [[]];
      }),
  };

  const wss = ctx.module.exports.initWsServer(serverEmitter, db);

  function connectClient() {
    let clientWs = null;
    wss.once("connection", (ws) => {
      clientWs = ws;
    });
    const fakeSocket = new EventEmitter();
    fakeSocket.write = () => {};
    fakeSocket.destroy = () => {};
    serverEmitter.emit("upgrade", { url: "/ws" }, fakeSocket, Buffer.alloc(0));
    return clientWs;
  }

  return { wss, connectClient, advance, emails, claims };
}

(async () => {
  console.log("WebSocket stability & slow-network resilience — tests");

  await check("handshake timeout aborts a socket wedged in CONNECTING", () => {
    const h = createClientHarness();
    const sock = new h.UnreadEmailSocket();
    sock.connect();
    eq(h.sockets.length, 1, "initial socket created");
    const ws1 = h.sockets[0];
    eq(ws1.readyState, 0, "still CONNECTING");

    h.advance(14000);
    ok(ws1.closed, "wedged CONNECTING socket was closed");
    eq(h.sockets.length, 2, "a fresh reconnect attempt was started");
    sock.close();
  });

  await check("auth timeout reconnects a socket that opens but never answers auth", () => {
    const h = createClientHarness();
    const sock = new h.UnreadEmailSocket();
    sock.connect();
    const ws1 = h.sockets[0];
    ws1.serverOpen();
    eq(ws1.sent.length, 1, "auth sent on open");
    eq(ws1.sent[0].type, "auth", "auth frame");

    h.advance(10500);
    ok(ws1.closed, "unauthenticated socket was closed on auth timeout");
    eq(h.sockets.length, 2, "reconnected immediately after auth timeout");
    sock.close();
  });

  await check("backoff is only reset after auth_ok, not on open alone", () => {
    const h = createClientHarness();
    const sock = new h.UnreadEmailSocket();
    sock.connect();
    h.sockets[0].serverOpen();
    h.sockets[0].close();
    ok(sock.reconnectDelay > 1000, "backoff increased when closed before auth_ok");

    h.advance(2500);
    eq(h.sockets.length, 2, "second attempt connected");
    h.sockets[1].serverOpen();
    h.sockets[1].serverMessage({ type: "auth_ok", username: "worker1" });
    eq(sock.reconnectDelay, 1000, "backoff reset to 1000ms once auth_ok arrives");
    sock.close();
  });

  await check("client heartbeat detects a half-open socket and reconnects", () => {
    const h = createClientHarness();
    const sock = new h.UnreadEmailSocket();
    sock.connect();
    const ws1 = h.sockets[0];
    ws1.serverOpen();
    ws1.serverMessage({ type: "auth_ok", username: "worker1" });

    h.advance(20000);
    const pings = ws1.sent.filter((m) => m.type === "ping");
    eq(pings.length, 1, "periodic ping sent at 20s");

    h.advance(3000);
    ws1.serverMessage({ type: "pong" });
    h.advance(8000);
    eq(h.sockets.length, 1, "socket kept open when pong received");

    h.advance(20000);
    eq(ws1.closed, true, "half-open socket closed after pong timeout");
    eq(h.sockets.length, 2, "fresh socket opened automatically");
    sock.close();
  });

  await check("incoming data messages satisfy the heartbeat even if pong is delayed", () => {
    const h = createClientHarness();
    const sock = new h.UnreadEmailSocket();
    sock.connect();
    const ws1 = h.sockets[0];
    ws1.serverOpen();
    ws1.serverMessage({ type: "auth_ok", username: "worker1" });

    h.advance(20000);
    h.advance(5000);
    ws1.serverMessage({ type: "new_email", data: { messageId: "m1" } });
    h.advance(6000);
    eq(ws1.closed, false, "socket kept open because data arrived after ping");
    eq(h.sockets.length, 1, "still on first socket");
    sock.close();
  });

  await check("browser online event immediately reconnects or probes existing socket", () => {
    const h = createClientHarness();
    const sock = new h.UnreadEmailSocket();
    sock.connect();
    h.sockets[0].close();
    h.emitWindow("online");
    eq(h.sockets.length, 2, "reconnected immediately on online event");

    const ws2 = h.sockets[1];
    ws2.serverOpen();
    ws2.serverMessage({ type: "auth_ok", username: "worker1" });
    const sentBefore = ws2.sent.length;
    h.emitWindow("online");
    eq(ws2.sent.length, sentBefore + 1, "online event on open socket sends immediate liveness ping");
    eq(ws2.sent[ws2.sent.length - 1].type, "ping", "sent ping");
    sock.close();
  });

  await check("normalizeWsUrl converts https/http redirect Location headers to wss/ws", () => {
    const h = createClientHarness();
    eq(
      h.normalizeWsUrl(
        "https://lavender-quail-935384.hostingersite.com/ws",
        "wss://lavender-quail-935384.hostingersite.com/ws"
      ),
      "wss://lavender-quail-935384.hostingersite.com/ws",
      "https -> wss"
    );
    const sock = new h.UnreadEmailSocket();
    sock.registerRedirect("https://lavender-quail-935384.hostingersite.com/ws");
    eq(sock.redirectSeen, 0, "self-redirect to https:// of same URL ignored");
    sock.close();
  });

  await check("durable email WS actions survive page unload and flush on next auth_ok", () => {
    const h = createClientHarness();
    h.queueDurableEmailWsAction({ type: "release_email", messageId: "msg-99" });
    eq(h.loadDurableEmailWsActions().length, 1, "action stored in localStorage");

    const sock = new h.UnreadEmailSocket();
    sock.connect();
    const ws1 = h.sockets[0];
    ws1.serverOpen();
    ws1.serverMessage({ type: "auth_ok", username: "worker1" });

    const released = ws1.sent.find(
      (m) => m.type === "release_email" && m.messageId === "msg-99"
    );
    ok(released, "durable release_email flushed on auth_ok");
    eq(h.loadDurableEmailWsActions().length, 0, "durable queue cleared after flush");
    sock.close();
  });

  await check("server auth DB error closes with 1013 instead of sending auth_error", async () => {
    const srv = createServerWsHarness({
      dbQuery: async () => {
        throw new Error("ETIMEDOUT MySQL");
      },
    });
    const client = srv.connectClient();
    client.emit("message", JSON.stringify({ type: "auth", token: "valid-worker-1" }));
    await srv.advance(10);

    const authErrors = client.sent.filter((m) => m.type === "auth_error");
    eq(authErrors.length, 0, "no auth_error sent on DB failure");
    eq(client.closedWith && client.closedWith.code, 1013, "closed with 1013 Try Again Later");
  });

  await check("server heartbeat spares a slow client whose outgoing attachment buffer is draining", async () => {
    const srv = createServerWsHarness();
    const client = srv.connectClient();
    client.emit("message", JSON.stringify({ type: "auth", token: "valid-worker-1" }));
    await srv.advance(10);

    client.bufferedAmount = 5_000_000;
    await srv.advance(30000);
    eq(client.terminated, false, "alive after first heartbeat tick");

    client.bufferedAmount = 2_500_000;
    await srv.advance(30000);
    eq(client.terminated, false, "spared while outgoing buffer is draining");

    client.bufferedAmount = 0;
    client.emit("message", JSON.stringify({ type: "ping", ts: 123 }));
    await srv.advance(30000);
    eq(client.terminated, false, "incoming message marked client alive");
  });

  await check("server per-message release timer resets when re-claimed and dropped again", async () => {
    const srv = createServerWsHarness();
    srv.emails.set("msg-1", {
      account: "Account1",
      messageId: "msg-1",
      subject: "Policy",
    });

    const c1 = srv.connectClient();
    c1.emit("message", JSON.stringify({ type: "auth", token: "valid-worker-1" }));
    await srv.advance(10);
    c1.emit("message", JSON.stringify({ type: "claim_email", messageId: "msg-1" }));
    await srv.advance(10);
    eq(srv.claims.get("msg-1"), "worker1", "claimed on c1");

    c1.terminate();
    await srv.advance(10000);
    eq(srv.claims.get("msg-1"), "worker1", "still reserved after 10s (within 15s grace)");

    const c2 = srv.connectClient();
    c2.emit("message", JSON.stringify({ type: "auth", token: "valid-worker-1" }));
    await srv.advance(10);
    c2.emit("message", JSON.stringify({ type: "claim_email", messageId: "msg-1" }));
    await srv.advance(2000);
    c2.terminate();

    await srv.advance(4000);
    eq(
      srv.claims.get("msg-1"),
      "worker1",
      "c1's old timer did not prematurely release c2's claim"
    );

    await srv.advance(12000);
    eq(srv.claims.get("msg-1") || null, null, "released after c2's full grace period");
  });

  if (failed > 0) {
    console.error(`\n${passed} passed, ${failed} failed`);
    process.exit(1);
  }
  console.log(`\n${passed} passed, ${failed} failed`);
})();




