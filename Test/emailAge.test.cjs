"use strict";

// Node test for the email card age helpers (renderer/emailAge.js): arrival
// time (local time this PC first saw the email, persisted across reloads),
// waiting duration, the 10-minute overdue highlight and oldest-first
// ordering. Runs the REAL renderer file in a vm.
//
// Run with:  node Test/emailAge.test.cjs   (or: npm test)

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const CTX = { console, Date };
vm.createContext(CTX);
vm.runInContext(
  fs.readFileSync(path.join(__dirname, "..", "renderer", "emailAge.js"), "utf8"),
  CTX,
  { filename: "emailAge.js" }
);
const {
  emailFirstSeenMs,
  emailWaitingMinutes,
  isEmailOverdue,
  formatEmailArrival,
  compareEmailArrival,
} = CTX;

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

const MIN = 60 * 1000;
const NOW = new Date(2026, 9, 8, 14, 30, 0).getTime(); // 8 Oct 2026 14:30 local

// Minimal localStorage stand-in.
function memoryStorage(initial) {
  const data = Object.assign({}, initial);
  return {
    data,
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => {
      data[k] = String(v);
    },
  };
}
const KEY = "emailFirstSeen";
const stored = (storage) => JSON.parse(storage.data[KEY] || "{}");

check("first sighting records the current local time", () => {
  const storage = memoryStorage();
  eq(emailFirstSeenMs(storage, "m1", NOW), NOW, "arrival");
  eq(stored(storage), { m1: NOW }, "stored");
});

check("later sightings (e.g. after a page reload) keep the first time", () => {
  const storage = memoryStorage();
  emailFirstSeenMs(storage, "m1", NOW - 12 * MIN);
  eq(emailFirstSeenMs(storage, "m1", NOW), NOW - 12 * MIN, "arrival");
  eq(isEmailOverdue(emailFirstSeenMs(storage, "m1", NOW), NOW), true, "overdue");
});

check("each email has its own first-seen time", () => {
  const storage = memoryStorage();
  emailFirstSeenMs(storage, "a", NOW - 5 * MIN);
  emailFirstSeenMs(storage, "b", NOW - 1 * MIN);
  eq(stored(storage), { a: NOW - 5 * MIN, b: NOW - 1 * MIN }, "stored");
});

check("entries older than a week are pruned", () => {
  const old = NOW - 8 * 24 * 60 * MIN;
  const storage = memoryStorage({ [KEY]: JSON.stringify({ old, keep: NOW - MIN }) });
  emailFirstSeenMs(storage, "new", NOW);
  eq(stored(storage), { keep: NOW - MIN, new: NOW }, "stored");
});

check("corrupt storage or future times restart the count at now", () => {
  const bad = memoryStorage({ [KEY]: "not json" });
  eq(emailFirstSeenMs(bad, "m1", NOW), NOW, "corrupt");
  const future = memoryStorage({ [KEY]: JSON.stringify({ m1: NOW + 60 * MIN }) });
  eq(emailFirstSeenMs(future, "m1", NOW), NOW, "future");
  eq(stored(future), { m1: NOW }, "future stored");
});

check("a failing storage write still returns a time", () => {
  const storage = memoryStorage();
  storage.setItem = () => {
    throw new Error("quota");
  };
  const origWarn = console.warn;
  console.warn = () => {};
  try {
    eq(emailFirstSeenMs(storage, "m1", NOW), NOW, "arrival");
  } finally {
    console.warn = origWarn;
  }
});

check("waiting minutes are whole and never negative", () => {
  eq(emailWaitingMinutes(NOW - 30 * 1000, NOW), 0, "30 s");
  eq(emailWaitingMinutes(NOW - 9.9 * MIN, NOW), 9, "9.9 min");
  eq(emailWaitingMinutes(NOW + 2 * MIN, NOW), 0, "future");
});

check("overdue only after more than 10 minutes", () => {
  eq(isEmailOverdue(NOW - 9 * MIN, NOW), false, "9 min");
  eq(isEmailOverdue(NOW - 10 * MIN, NOW), false, "exactly 10 min");
  eq(isEmailOverdue(NOW - 10 * MIN - 1000, NOW), true, "10 min 1 s");
  eq(isEmailOverdue(NOW - 120 * MIN, NOW), true, "2 h");
});

check("arrival time shows HH:mm today and dd.mm HH:mm on older days", () => {
  eq(formatEmailArrival(new Date(2026, 9, 8, 9, 5).getTime(), NOW), "09:05", "today");
  eq(formatEmailArrival(new Date(2026, 9, 7, 23, 59).getTime(), NOW), "07.10 23:59", "yesterday");
});

check("cards sort oldest first", () => {
  const arrivals = [NOW - 1 * MIN, NOW - 30 * MIN, NOW - 5 * MIN];
  eq(arrivals.slice().sort(compareEmailArrival), [NOW - 30 * MIN, NOW - 5 * MIN, NOW - 1 * MIN], "order");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
