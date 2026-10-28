"use strict";

// Node test for the "insurance duration label" helper in WorkPage.js.
//
// The Excel export turns a stored duration (in days) into the shift-log
// shorthand used across the app: 15 -> "15D", 30 -> "1M", 90 -> "3M".
// Anything else is exported as-is and empty values stay blank.
//
// Run with:  node Test/insuranceExportDuration.test.cjs   (or: npm test)

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const WORKPAGE_JS = path.join(ROOT, "renderer", "WorkPage", "WorkPage.js");

const src = fs.readFileSync(WORKPAGE_JS, "utf8");
const fn = /function insuranceDurationLabel\(duration\) \{[\s\S]*?\n\}/.exec(src);
if (!fn) {
  console.error("Could not find the end of insuranceDurationLabel");
  process.exit(1);
}

const CTX = {};
vm.createContext(CTX);
vm.runInContext(
  fn[0] + "\nglobalThis.insuranceDurationLabel = insuranceDurationLabel;",
  CTX,
  { filename: "WorkPage.js#insuranceDurationLabel" }
);
const insuranceDurationLabel = CTX.insuranceDurationLabel;

let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log("  PASS  " + name);
  } catch (err) {
    failed++;
    console.log("  FAIL  " + name + "  -> " + err.message);
  }
}
function eq(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b)
    throw new Error((msg || "values differ") + ` (got ${a}, want ${b})`);
}

(async () => {
  console.log("Insurance — export duration label (15D / 1M / 3M)");

  check("15 days -> 15D", () => eq(insuranceDurationLabel(15), "15D"));
  check("30 days -> 1M", () => eq(insuranceDurationLabel(30), "1M"));
  check("90 days -> 3M", () => eq(insuranceDurationLabel(90), "3M"));

  check("numeric strings map like numbers", () => {
    eq(insuranceDurationLabel("15"), "15D");
    eq(insuranceDurationLabel("30"), "1M");
    eq(insuranceDurationLabel("90"), "3M");
  });

  check("unknown durations are exported as-is", () => {
    eq(insuranceDurationLabel(365), "365");
    eq(insuranceDurationLabel("45"), "45");
  });

  check("empty values stay blank", () => {
    eq(insuranceDurationLabel(undefined), "");
    eq(insuranceDurationLabel(null), "");
    eq(insuranceDurationLabel(""), "");
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
