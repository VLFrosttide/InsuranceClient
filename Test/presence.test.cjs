"use strict";

// Node test for the worker-presence status rule (renderer/presence.js).
//
// A worker is:
//   "online"  (green)  while active on the PC and not filling a form
//   "working" (orange) while active on an open insurance form
//   "afk"     (red)    after more than 5 minutes without any user activity
//
// Runs the REAL renderer file in a vm.
//
// Run with:  node Test/presence.test.cjs   (or: npm test)

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const CTX = { console, Date };
vm.createContext(CTX);
vm.runInContext(
  fs.readFileSync(path.join(__dirname, "..", "renderer", "presence.js"), "utf8"),
  CTX,
  { filename: "presence.js" }
);
const { presenceStatusFor } = CTX;

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
const NOW = new Date(2026, 9, 8, 14, 30, 0).getTime();

console.log("presence: online / working / afk");

check("active on the PC is online (green)", () => {
  eq(presenceStatusFor("online", NOW, NOW), "online", "at activity");
  eq(
    presenceStatusFor("online", NOW, NOW + 4 * MIN + 59 * 1000),
    "online",
    "just under 5 min"
  );
  eq(presenceStatusFor("online", NOW, NOW + 5 * MIN), "online", "exactly 5 min");
});

check("active on a form is working (orange)", () => {
  eq(presenceStatusFor("working", NOW, NOW), "working", "at activity");
  eq(presenceStatusFor("working", NOW, NOW + 5 * MIN), "working", "exactly 5 min");
});

check("more than 5 minutes without activity is afk (red)", () => {
  eq(
    presenceStatusFor("online", NOW, NOW + 5 * MIN + 1),
    "afk",
    "dashboard, just over 5 min"
  );
  eq(
    presenceStatusFor("working", NOW, NOW + 5 * MIN + 1),
    "afk",
    "form, just over 5 min"
  );
  eq(presenceStatusFor("working", NOW, NOW + 60 * MIN), "afk", "an hour");
});

check("activity resets the afk timer", () => {
  const resumed = NOW + 60 * MIN;
  eq(presenceStatusFor("online", resumed, resumed), "online", "dashboard, after returning");
  eq(presenceStatusFor("working", resumed, resumed), "working", "form, after returning");
  eq(presenceStatusFor("working", resumed, resumed + 5 * MIN), "working", "5 min after return");
  eq(
    presenceStatusFor("working", resumed, resumed + 5 * MIN + 1),
    "afk",
    "over 5 min after return"
  );
});

if (failed) process.exit(1);
console.log(`presence: ${passed} passed, ${failed} failed`);
