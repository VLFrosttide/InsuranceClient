"use strict";

// Node test for the presence heartbeat sent by the dashboard and the insurance
// form (renderer/WorkPage/WorkPage.js, renderer/AddInsurance/AddInsurance.js).
//
// A page reports its status on the shared email WebSocket. It used to send it
// ONLY when the value changed, so one lost frame - or an "online" reported by
// another session of the same worker (a dashboard page, a second PC) after the
// form reported "working" - left the worker shown as Online on the presence
// board for the whole time the walk-in form was open.
//
// Every page must therefore re-assert its current status on each presence tick.
// The server treats a repeated status as a heartbeat: it refreshes updatedAt
// and does NOT re-broadcast (Users/websocket.js, setWorkerPresence).
//
// Runs the REAL code: the presence blocks are cut out of the two renderer
// files (like the other renderer tests) and run in a vm with fake timers, a
// fake clock and a fake UnreadEmailSocket that records what is sent.
//
// Run with:  node Test/presenceSend.test.cjs   (or: npm test)

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const ADD_JS = path.join(ROOT, "renderer", "AddInsurance", "AddInsurance.js");
const WORK_JS = path.join(ROOT, "renderer", "WorkPage", "WorkPage.js");
const PRESENCE_JS = path.join(ROOT, "renderer", "presence.js");

function slice(src, startMarker, endMarker, file) {
  const start = src.indexOf(startMarker);
  const end = start < 0 ? -1 : src.indexOf(endMarker, start);
  if (start < 0 || end < 0) {
    throw new Error(`Could not locate the presence block in ${file} (moved?)`);
  }
  return src.slice(start, end);
}

const addSrc = fs.readFileSync(ADD_JS, "utf8");
const workSrc = fs.readFileSync(WORK_JS, "utf8");
const presenceLib = fs.readFileSync(PRESENCE_JS, "utf8");

// The form page: the walk-in branch of setupEmailSocket() + the whole
// "Worker presence" block (sendPresence / markActivity / setupPresenceSocket).
const addSocket = slice(
  addSrc,
  "function setupEmailSocket() {",
  "// The email this form was opened for",
  "AddInsurance.js"
);
const addPresence = slice(
  addSrc,
  "const PRESENCE_CHECK_MS = 15 * 1000;",
  'trimOnPaste(document.getElementById("CarNumberInput"));',
  "AddInsurance.js"
);

// The dashboard: its presence board + sendPresence / setupPresenceSocket.
const workPresence = slice(
  workSrc,
  "let presenceSocket = null;",
  "// Fetch broker pricing on page load (for clients/brokers)",
  "WorkPage.js"
);

let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    fn();
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
function ok(condition, label) {
  if (!condition) throw new Error(label);
}

const MIN = 60 * 1000;
const TICK_MS = 15 * 1000;

// A fresh page context. `role` decides which worker paths run; `emailSocket`
// mirrors the page: the form and the dashboard both reuse it for presence.
function createPage({ role = "2", withEmailSocket = true } = {}) {
  const state = {
    clock: 1_000_000,
    sent: [],
    intervals: [],
    activityHandlers: [],
    widgets: [],
    sockets: [],
  };

  class FakeSocket {
    constructor(handlers = {}) {
      this.handlers = handlers;
      this.ready = false;
      this.sent = [];
      state.sockets.push(this);
    }
    connect() {}
    isReady() {
      return this.ready;
    }
    send(obj) {
      this.sent.push(obj);
      state.sent.push(obj);
    }
    authOk() {
      this.ready = true;
      if (this.handlers.auth_ok) this.handlers.auth_ok({ type: "auth_ok" });
    }
  }

  const ctx = {
    console,
    Date: { now: () => state.clock },
    JSON,
    setInterval: (fn, ms) => {
      state.intervals.push({ fn, ms });
      return state.intervals.length;
    },
    clearInterval: () => {},
    setTimeout: () => 0,
    clearTimeout: () => {},
    PendingEmail: null,
    getRole: () => role,
    userRole: role,
    UnreadEmailSocket: FakeSocket,
    InsuranceForm: {
      addEventListener: () => {},
    },
    PresenceWidget: null,
    el: (tag, text, attrs) => {
      const node = {
        tag,
        text: text == null ? "" : String(text),
        className: (attrs && attrs.class) || "",
        title: "",
        children: [],
        appendChild(child) {
          this.children.push(child);
          return child;
        },
        replaceChildren() {
          this.children = [];
        },
      };
      return node;
    },
    t: (key) => {
      const bg = {
        "presence.none": "Няма онлайн служители",
        "presence.online": "Онлайн",
        "presence.working": "Работи",
        "presence.afk": "Отсъства",
      };
      return bg[key] || key;
    },
    trackUserActivity: (fn) => state.activityHandlers.push(fn),
    onOutboxState: () => {},
    syncOutboxEmails: () => {},
    resetOutboxEmailClaims: () => {},
    reportError: () => {},
    toast: () => {},
    translateError: (m) => m,
    window: {
      addEventListener: (type, fn) => state.activityHandlers.push(fn),
    },
    document: { addEventListener: () => {} },
    outboxEmailIds: () => new Set(),
    localStorage: { getItem: () => "x" },
    emailSocket: null,
  };
  ctx.window.document = ctx.document;
  ctx.PresenceWidget = ctx.el("div", null, {});
  ctx.PresenceWidget.replaceChildren = function () {
    this.children = [];
  };
  vm.createContext(ctx);

  return { ctx, state, FakeSocket, withEmailSocket };
}

function buildFormPage() {
  const page = createPage();
  vm.runInContext(
    presenceLib + "\n" + addPresence + "\n" + addSocket,
    page.ctx,
    { filename: "AddInsurance.js#presence" }
  );
  return page;
}

function buildDashboardPage() {
  const page = createPage({ role: "2", withEmailSocket: true });
  vm.runInContext(presenceLib + "\n" + workPresence, page.ctx, {
    filename: "WorkPage.js#presence",
  });
  page.ctx.emailSocket = new page.FakeSocket({});
  page.ctx.emailSocket.ready = true;
  page.ctx.setupPresenceSocket();
  return page;
}

function tick(page) {
  const interval = page.state.intervals.find((i) => i.ms === TICK_MS);
  ok(interval, "a presence heartbeat interval is registered");
  interval.fn();
}

const presenceFrames = (page) =>
  page.state.sent.filter((m) => m && m.type === "presence");

console.log("presence: the page keeps re-asserting its status");

check("the walk-in form reports working when its socket authenticates", () => {
  const page = buildFormPage();
  page.ctx.setupEmailSocket();
  page.ctx.setupPresenceSocket();
  eq(page.state.sockets.length, 1, "one shared socket for the form");
  eq(page.state.sent, [], "nothing sent before the socket is ready");
  page.ctx.emailSocket.authOk();
  eq(
    presenceFrames(page),
    [{ type: "presence", status: "working" }],
    "working is reported on auth"
  );
});

check("the walk-in form re-asserts working on every heartbeat (regression)", () => {
  const page = buildFormPage();
  page.ctx.setupEmailSocket();
  page.ctx.setupPresenceSocket();
  page.ctx.emailSocket.authOk();
  page.state.sent.length = 0;

  tick(page);
  eq(
    presenceFrames(page),
    [{ type: "presence", status: "working" }],
    "a repeat of the same status is still sent"
  );
  page.state.sent.length = 0;
  page.state.clock += TICK_MS;
  tick(page);
  eq(
    presenceFrames(page),
    [{ type: "presence", status: "working" }],
    "and again on the next tick"
  );
});

check("an idle form turns afk on the heartbeat and activity restores working", () => {
  const page = buildFormPage();
  page.ctx.setupEmailSocket();
  page.ctx.setupPresenceSocket();
  page.ctx.emailSocket.authOk();
  page.state.sent.length = 0;

  page.state.clock += 5 * MIN + 1;
  tick(page);
  eq(
    presenceFrames(page),
    [{ type: "presence", status: "afk" }],
    "afk after more than five idle minutes"
  );

  page.state.sent.length = 0;
  page.state.clock += 1000;
  for (const fn of page.state.activityHandlers) fn();
  eq(
    presenceFrames(page),
    [{ type: "presence", status: "working" }],
    "the next interaction reports working again"
  );
});

check("the dashboard re-asserts online on every heartbeat", () => {
  const page = buildDashboardPage();
  tick(page);
  tick(page);
  eq(
    presenceFrames(page),
    [
      { type: "presence", status: "online" },
      { type: "presence", status: "online" },
    ],
    "online is re-sent on each tick"
  );
});

check("a status is not queued while the socket is down", () => {
  const page = buildFormPage();
  page.ctx.setupEmailSocket();
  page.ctx.setupPresenceSocket();
  page.ctx.sendPresence("working");
  eq(page.state.sent, [], "nothing is queued on a socket that is not ready");
  page.ctx.emailSocket.authOk();
  eq(
    presenceFrames(page),
    [{ type: "presence", status: "working" }],
    "the status is reported as soon as the socket is authenticated"
  );
});

check("the board shows the working worker as Работи with the orange dot", () => {
  const page = buildDashboardPage();
  page.ctx.renderPresence([
    { username: "DEQN", status: "working" },
    { username: "IVAILO", status: "online" },
  ]);
  const chips = page.ctx.PresenceWidget.children;
  eq(chips.length, 2, "one chip per worker");
  eq(chips[0].children[0].className, "presence-dot working", "orange dot");
  eq(chips[0].children[1].text, "DEQN", "name");
  eq(chips[0].children[2].text, "Работи", "status label");
  eq(chips[1].children[2].text, "Онлайн", "online label");
});

if (failed) process.exit(1);
console.log(`presence (send): ${passed} passed, ${failed} failed`);
