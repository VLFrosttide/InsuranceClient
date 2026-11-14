"use strict";

// Node test for the email-attachment progress estimate
// (renderer/attachmentProgress.js).
//
// The WebSocket delivers an attachment in one base64 message, so the bar is
// driven by a size-aware time estimate: it climbs towards 90% while the bytes
// are in flight, holds there, and only reaches 100% once the reply arrived.
// An unknown size yields `null` (the UI shows an indeterminate bar).
//
// Runs the REAL renderer file in a vm.
//
// Run with:  node Test/attachmentProgress.test.cjs   (or: npm test)

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const CTX = { console };
vm.createContext(CTX);
vm.runInContext(
  fs.readFileSync(
    path.join(__dirname, "..", "renderer", "attachmentProgress.js"),
    "utf8"
  ),
  CTX,
  { filename: "attachmentProgress.js" }
);
const { attachmentProgressPercent } = CTX;

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

console.log("attachment progress: estimated while downloading, 100 only when done");

check("unknown or zero size is indeterminate (null)", () => {
  eq(attachmentProgressPercent(undefined, 1000), null, "undefined");
  eq(attachmentProgressPercent(null, 1000), null, "null");
  eq(attachmentProgressPercent(0, 1000), null, "zero");
  eq(attachmentProgressPercent(-5, 1000), null, "negative");
  eq(attachmentProgressPercent("abc", 1000), null, "not a number");
});

check("just sent is 0%", () => {
  eq(attachmentProgressPercent(1024 * 1024, 0), 0, "no time passed");
  eq(attachmentProgressPercent(1024 * 1024, -10), 0, "negative elapsed");
});

check("the bar advances as the transfer takes longer", () => {
  const size = 1024 * 1024; // 1 MB -> ~5.3 s to reach 90%
  const early = attachmentProgressPercent(size, 500);
  const mid = attachmentProgressPercent(size, 2650);
  const late = attachmentProgressPercent(size, 4500);
  ok(early > 0 && early < 30, `early ${early} should be small`);
  ok(mid > early, "mid must exceed early");
  ok(late > mid, "late must exceed mid");
  ok(late < 90, `late ${late} must stay below the waiting cap`);
});

check("never passes 90% until the bytes arrive", () => {
  const size = 10 * 1024; // small file: estimate is a single second
  eq(attachmentProgressPercent(size, 1000), 90, "already over the estimate");
  eq(attachmentProgressPercent(size, 60 * 60 * 1000), 90, "an hour later");
  eq(attachmentProgressPercent(size, 60 * 60 * 1000, true), 100, "done");
});

check("done is always 100%, even without a size", () => {
  eq(attachmentProgressPercent(undefined, 0, true), 100, "unknown size");
  eq(attachmentProgressPercent(0, 10, true), 100, "zero size");
});

check("tiny files still get a readable, slow-moving bar", () => {
  // A 1 KB file would otherwise hit 90% in one animation frame.
  eq(attachmentProgressPercent(1024, 100), 11, "100 ms");
  eq(attachmentProgressPercent(1024, 400), 45, "400 ms");
  eq(attachmentProgressPercent(1024, 800), 90, "800 ms (minimum duration)");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
