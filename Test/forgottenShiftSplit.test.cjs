"use strict";

// Node test for the client side of the admin's "fix forgotten shift" action.
//
// The actual split is computed atomically by the server's
// POST /currentcash/reset-asof (covered by Test/currentCashAsOf.test.cjs).
// This test cuts the REAL request helpers out of WorkPage.js and checks that:
//   * the preview asks for a dry run at the midnight cutoff,
//   * applying sends the same cutoff without the dry-run flag,
//   * the cash / broker labels are formatted for the confirmation dialog.
//
// Run with:  node Test/forgottenShiftSplit.test.cjs   (or: npm test)

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const WORK_JS = path.join(
  __dirname,
  "..",
  "renderer",
  "WorkPage",
  "WorkPage.js"
);
const src = fs.readFileSync(WORK_JS, "utf8");
const START = "function fixShiftCashLabel(amounts) {";
const END = "\nfunction openForgottenShiftFix(";
const start = src.indexOf(START);
const end = src.indexOf(END, start);
if (start < 0 || end < 0) {
  console.error("Could not locate the forgotten-shift block in WorkPage.js");
  process.exit(1);
}
const block = src.slice(start, end);

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
    console.log("        " + (err && err.stack ? err.stack : err));
  }
}
function eq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${label}: expected ${e}, got ${a}`);
}

function buildContext(response = {}) {
  const calls = [];
  async function api(route, options = {}) {
    const body = options.body ? JSON.parse(options.body) : {};
    calls.push({ route, body });
    return response;
  }
  const CTX = {
    console,
    Math,
    Number,
    String,
    JSON,
    Promise,
    api,
    money: (value) =>
      Number.isFinite(Number(value)) ? Number(value).toFixed(2) : "0.00",
  };
  vm.createContext(CTX);
  vm.runInContext(
    block +
      "\nthis.__exports = { fixShiftCashLabel, previewForgottenShiftSplit, " +
      "applyForgottenShiftSplit };",
    CTX,
    { filename: "WorkPage.js" }
  );
  return { ...CTX.__exports, calls };
}

const PREVIEW = {
  kept: {
    cash: { EUR: 100, TRY: 10 },
    card: 40,
    brokerCash: { EUR: 20, TRY: 0 },
  },
  remaining: {
    cash: { EUR: 50, TRY: 2 },
    card: 5,
    brokerCash: { EUR: 15, TRY: 0 },
  },
  cutoff: "2026-11-13 23:59:59",
};

console.log("forgotten shift: client requests");

(async () => {
  await check("preview is a dry run at the midnight cutoff", async () => {
    const h = buildContext(PREVIEW);
    const data = await h.previewForgottenShiftSplit(
      "Branch A",
      "2026-11-13 23:59:59"
    );
    eq(h.calls.length, 1, "one request");
    eq(h.calls[0].route, "/currentcash/reset-asof", "as-of endpoint");
    eq(
      h.calls[0].body,
      {
        branch: "Branch A",
        Cutoff: "2026-11-13 23:59:59",
        DryRun: true,
      },
      "dry-run body"
    );
    eq(data, PREVIEW, "preview returned unchanged");
  });

  await check("apply uses the same cutoff without the dry-run flag", async () => {
    const applied = {
      ...PREVIEW,
      author: "admin1",
    };
    const h = buildContext(applied);
    const data = await h.applyForgottenShiftSplit(
      "Branch A",
      "2026-11-13 23:59:59"
    );
    eq(h.calls.length, 1, "one request");
    eq(h.calls[0].route, "/currentcash/reset-asof", "as-of endpoint");
    eq(
      h.calls[0].body,
      { branch: "Branch A", Cutoff: "2026-11-13 23:59:59" },
      "apply body"
    );
    eq(data, applied, "applied response returned");
  });

  await check("cash and broker amounts are labelled per currency", () => {
    const h = buildContext();
    eq(
      h.fixShiftCashLabel({ EUR: 100, TRY: 0 }),
      "100.00 EUR · 0.00 TRY",
      "both currencies"
    );
    eq(
      h.fixShiftCashLabel({ EUR: "15.5", TRY: "2.25" }),
      "15.50 EUR · 2.25 TRY",
      "decimals"
    );
    eq(h.fixShiftCashLabel({}), "0.00 EUR · 0.00 TRY", "missing values");
  });

  console.log(`\nforgottenShiftSplit: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
