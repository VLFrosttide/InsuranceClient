"use strict";

// Node test for the worker-facing "charge price" helper in WorkPage.js.
//
// The +2 card fee is a bank tax: it must be visible to the worker (so they know
// how much to charge the client) but never stored in the database. chargePrice()
// adds it on top of the stored Price for walk-in (broker-less) card payments
// only, and leaves every other price untouched.
//
// Run with:  node Test/insuranceChargePrice.test.cjs   (or: npm test)

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const WORKPAGE_JS = path.join(ROOT, "renderer", "WorkPage", "WorkPage.js");

const src = fs.readFileSync(WORKPAGE_JS, "utf8");
const START = "const CARD_FEE = 2;";
const start = src.indexOf(START);
if (start < 0) {
  console.error("Could not locate chargePrice in WorkPage.js (moved?)");
  process.exit(1);
}
const tail = src.slice(start);
const m = /function chargePrice\(item\) \{[\s\S]*?\n\}/.exec(tail);
if (!m) {
  console.error("Could not find the end of chargePrice");
  process.exit(1);
}
const block = "const CARD_FEE = 2;\n" + m[0];

const CTX = {};
vm.createContext(CTX);
vm.runInContext(block + "\nglobalThis.chargePrice = chargePrice;", CTX, {
  filename: "WorkPage.js#chargePrice",
});
const chargePrice = CTX.chargePrice;

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
  console.log("Insurance — worker charge price (+2 card fee, visual only)");

  check("a walk-in card policy adds the +2 bank fee", () => {
    eq(
      chargePrice({ Price: "45.00", PaymentType: "Card", BrokerId: null }),
      47,
      "45 + 2"
    );
  });

  check("a walk-in cash policy is unchanged", () => {
    eq(
      chargePrice({ Price: "45.00", PaymentType: "Cash", BrokerId: null }),
      45,
      "45"
    );
  });

  check("a broker (email) policy is never bumped, even if stored as Card", () => {
    eq(chargePrice({ Price: "45.00", PaymentType: "Card", BrokerId: 7 }), 45, "45");
  });

  check("decimal prices round to cents", () => {
    eq(
      chargePrice({ Price: "45.35", PaymentType: "Card", BrokerId: null }),
      47.35,
      "45.35 + 2"
    );
  });

  check("a missing price passes through as not-a-number", () => {
    const r = chargePrice({ Price: undefined, PaymentType: "Card", BrokerId: null });
    eq(Number.isFinite(r), false, "not finite");
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
