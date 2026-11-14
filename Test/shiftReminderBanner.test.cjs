"use strict";

// Node test for the end-of-shift reminder banner in renderer/common.js.
//
// This runs the REAL common.js + shiftReminder.js against a tiny fake DOM and
// a fake clock fixed at 23:50:
//   * the reminder is armed for 23:55 (five minutes before midnight),
//   * firing it renders the banner with a live countdown,
//   * it re-arms for the NEXT night (never 0 ms, which would loop),
//   * dismissing it silences the rest of the day,
//   * "Finish shift" on a form asks first, then queues the Current cash view.
//
// Run with:  node Test/shiftReminderBanner.test.cjs   (or: npm test)

const fs = require("fs");
const path = require("path");
const vm = require("vm");

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
    console.log("        " + (err && err.stack ? err.stack : err));
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

// --- fake DOM -----------------------------------------------------------------
function makeElement(tag) {
  const node = {
    tagName: String(tag || "").toUpperCase(),
    className: "",
    textContent: "",
    title: "",
    style: {},
    children: [],
    parentNode: null,
    attrs: {},
    listeners: {},
    appendChild(child) {
      child.parentNode = this;
      this.children.push(child);
      return child;
    },
    remove() {
      if (!this.parentNode) return;
      const siblings = this.parentNode.children;
      const idx = siblings.indexOf(this);
      if (idx !== -1) siblings.splice(idx, 1);
      this.parentNode = null;
    },
    replaceChildren(...nodes) {
      this.children = nodes;
      for (const child of nodes) child.parentNode = this;
    },
    setAttribute(name, value) {
      this.attrs[name] = String(value);
    },
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(this.attrs, name)
        ? this.attrs[name]
        : null;
    },
    addEventListener(type, fn) {
      if (!this.listeners[type]) this.listeners[type] = [];
      this.listeners[type].push(fn);
    },
    querySelector(selector) {
      if (!selector || selector[0] !== ".") return null;
      const wanted = selector.slice(1);
      const visit = (el) => {
        const classes = String(el.className || "").split(/\s+/);
        if (classes.includes(wanted)) return el;
        for (const child of el.children) {
          const found = visit(child);
          if (found) return found;
        }
        return null;
      };
      for (const child of this.children) {
        const found = visit(child);
        if (found) return found;
      }
      return null;
    },
    querySelectorAll() {
      return [];
    },
    focus() {},
  };
  node.classList = {
    add(...names) {
      const set = new Set(String(node.className || "").split(/\s+/).filter(Boolean));
      for (const name of names) set.add(name);
      node.className = Array.from(set).join(" ");
    },
    remove(...names) {
      const set = new Set(String(node.className || "").split(/\s+/).filter(Boolean));
      for (const name of names) set.delete(name);
      node.className = Array.from(set).join(" ");
    },
    toggle(name, force) {
      const set = new Set(String(node.className || "").split(/\s+/).filter(Boolean));
      const on = force === undefined ? !set.has(name) : Boolean(force);
      if (on) set.add(name);
      else set.delete(name);
      node.className = Array.from(set).join(" ");
      return on;
    },
    contains(name) {
      return String(node.className || "").split(/\s+/).includes(name);
    },
  };
  return node;
}

// --- fake clock ---------------------------------------------------------------
let NOW = new Date(2026, 10, 14, 23, 50, 0, 0).getTime(); // 14 Nov 2026, 23:50
class FakeDate extends Date {
  constructor(...args) {
    if (args.length === 0) super(NOW);
    else super(...args);
  }
  static now() {
    return NOW;
  }
}

// --- fake timers --------------------------------------------------------------
let nextTimerId = 1;
const timeouts = new Map();
function setTimeoutFake(fn, ms) {
  const id = nextTimerId++;
  timeouts.set(id, { fn, ms: Math.max(0, Number(ms) || 0) });
  return id;
}
function clearTimeoutFake(id) {
  timeouts.delete(id);
}

// --- harness ------------------------------------------------------------------
const body = makeElement("body");
const storage = new Map([
  ["lang", "bg"],
  ["token", "tok-worker"],
  ["role", "2"],
  ["username", "worker1"],
  ["branch", "ГКПП Лесово"],
]);
const localStorage = {
  getItem: (k) => (storage.has(k) ? storage.get(k) : null),
  setItem: (k, v) => storage.set(k, String(v)),
  removeItem: (k) => storage.delete(k),
};

let navigatedTo = null;
let confirmAnswer = false;
let confirmCalls = 0;

const documentStub = {
  readyState: "complete",
  documentElement: { lang: "bg" },
  body,
  createElement: makeElement,
  addEventListener: () => {},
  removeEventListener: () => {},
  querySelector: () => null,
  querySelectorAll: () => [],
};

const ctx = {
  console,
  Date: FakeDate,
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
  setTimeout: setTimeoutFake,
  clearTimeout: clearTimeoutFake,
  setInterval: () => 0,
  clearInterval: () => {},
  localStorage,
  location: { href: "" },
  document: documentStub,
  window: {
    addEventListener: () => {},
    removeEventListener: () => {},
    confirm: () => {
      confirmCalls++;
      return confirmAnswer;
    },
    bridge: {
      LoadNewPage: (page) => {
        navigatedTo = page;
      },
    },
  },
};
ctx.window.document = documentStub;

const renderer = path.join(__dirname, "..", "renderer");
vm.createContext(ctx);
vm.runInContext(
  fs.readFileSync(path.join(renderer, "shiftReminder.js"), "utf8"),
  ctx,
  { filename: "shiftReminder.js" }
);
vm.runInContext(
  fs.readFileSync(path.join(renderer, "common.js"), "utf8") +
    "\nthis.__exports = { showShiftReminder, scheduleShiftReminder, hideShiftReminder, " +
    "openCurrentCashForShiftReminder, consumeShiftReminderPendingView };",
  ctx,
  { filename: "common.js" }
);
const api = ctx.__exports;

function onlyTimeout() {
  const entries = Array.from(timeouts.entries());
  eq(entries.length, 1, "exactly one timer armed");
  return entries[0];
}

console.log("shift reminder banner: five minutes before midnight");

check("armed for 23:55 when the page loads at 23:50", () => {
  const [, timer] = onlyTimeout();
  eq(timer.ms, 5 * 60 * 1000, "delay to 23:55");
});

let dismissButton = null;
check("firing renders the banner with a live countdown", () => {
  const [id, timer] = onlyTimeout();
  NOW = new Date(2026, 10, 14, 23, 55, 0, 0).getTime();
  timeouts.delete(id);
  timer.fn();

  const banner = body.querySelector(".shift-reminder");
  ok(banner, "banner rendered");
  const title = banner.querySelector(".shift-reminder-title");
  eq(title.textContent, "Смяната приключва след 5 минути", "Bulgarian title");
  const countdown = banner.querySelector(".shift-reminder-countdown");
  eq(countdown.textContent, "До полунощ: 5:00", "countdown");

  // The action buttons live in the last child group.
  const actions = banner.children[banner.children.length - 1];
  dismissButton = actions.children[actions.children.length - 1];
  eq(dismissButton.textContent, "Затвори", "dismiss label");
});

check("re-arms for tomorrow instead of firing again immediately", () => {
  const [, timer] = onlyTimeout();
  eq(timer.ms, 24 * 60 * 60 * 1000, "a full day to the next 23:55");
});

check("dismissing removes the banner and silences this day", () => {
  eq(confirmCalls, 0, "no confirm needed for dismiss");
  dismissButton.listeners.click[0]();
  eq(body.querySelector(".shift-reminder"), null, "banner removed");
  eq(
    storage.get("shiftReminderDismissedDay"),
    "2026-11-14",
    "day remembered"
  );
  // A reload in the same window must not show it again.
  api.showShiftReminder();
  eq(body.querySelector(".shift-reminder"), null, "stays hidden");
});

check("Finish shift on a form asks before leaving, then queues the view", () => {
  storage.delete("shiftReminderDismissedDay");
  api.showShiftReminder();
  const banner = body.querySelector(".shift-reminder");
  ok(banner, "banner shown again");

  confirmAnswer = false;
  api.openCurrentCashForShiftReminder();
  eq(confirmCalls, 1, "asked first");
  eq(navigatedTo, null, "cancel keeps the form");
  ok(body.querySelector(".shift-reminder"), "banner still visible after cancel");

  confirmAnswer = true;
  api.openCurrentCashForShiftReminder();
  eq(confirmCalls, 2, "asked again");
  eq(navigatedTo, "renderer/WorkPage/WorkPage.html", "dashboard loaded");
  eq(
    storage.get("shiftReminderOpenCurrentCash"),
    "1",
    "Current cash requested"
  );
  eq(body.querySelector(".shift-reminder"), null, "banner closed");
});

check("the dashboard consumes the request exactly once", () => {
  eq(api.consumeShiftReminderPendingView(), true, "first read");
  eq(storage.get("shiftReminderOpenCurrentCash"), undefined, "flag removed");
  eq(api.consumeShiftReminderPendingView(), false, "second read");
});

if (failed) process.exit(1);
console.log(`shiftReminderBanner: ${passed} passed, ${failed} failed`);
