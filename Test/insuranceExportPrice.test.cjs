"use strict";

// Node test for the "insurance export price" helper in WorkPage.js.
//
// The Excel export must sum annulled policies by their annulment fee (1 or 9)
// instead of their full price, because an annulled policy has been refunded
// (price - fee). Normal policies still export their charge price (stored price
// plus the visual-only +2 card fee for walk-in card payments).
//
// Run with:  node Test/insuranceExportPrice.test.cjs   (or: npm test)

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

const charge = /function chargePrice\(item\) \{[\s\S]*?\n\}/.exec(tail);
if (!charge) {
  console.error("Could not find the end of chargePrice");
  process.exit(1);
}
const exportPrice = /function insuranceExportPrice\(item\) \{[\s\S]*?\n\}/.exec(
  tail
);
if (!exportPrice) {
  console.error("Could not find the end of insuranceExportPrice");
  process.exit(1);
}

const block = "const CARD_FEE = 2;\n" + charge[0] + "\n" + exportPrice[0];

const CTX = {};
vm.createContext(CTX);
vm.runInContext(
  block + "\nglobalThis.insuranceExportPrice = insuranceExportPrice;",
  CTX,
  { filename: "WorkPage.js#insuranceExportPrice" }
);
const insuranceExportPrice = CTX.insuranceExportPrice;

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
  console.log("Insurance — export price (annulled contributes only the fee)");

  check("a normal walk-in card policy keeps the +2 bank fee", () => {
    eq(
      insuranceExportPrice({ Price: "45.00", PaymentType: "Card", BrokerId: null }),
      47,
      "45 + 2"
    );
  });

  check("a normal broker policy exports its stored price", () => {
    eq(
      insuranceExportPrice({ Price: "45.00", PaymentType: "Card", BrokerId: 7 }),
      45,
      "45"
    );
  });

  check("an annulled policy exports its 9 fee instead of the full price", () => {
    eq(
      insuranceExportPrice({ Price: "500.00", Annulled: 1, AnnulFee: 9 }),
      9,
      "9"
    );
  });

  check("an annulled policy exports its 1 fee instead of the full price", () => {
    eq(
      insuranceExportPrice({ Price: "500.00", Annulled: 1, AnnulFee: 1 }),
      1,
      "1"
    );
  });

  check("an annulled walk-in card policy does not add the +2 card fee", () => {
    eq(
      insuranceExportPrice({
        Price: "500.00",
        PaymentType: "Card",
        BrokerId: null,
        Annulled: 1,
        AnnulFee: 9,
      }),
      9,
      "9"
    );
  });

  check("an annulled policy without a stored fee exports 0", () => {
    eq(insuranceExportPrice({ Price: "500.00", Annulled: 1 }), 0, "0");
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
