"use strict";

// Node test for the total shown under the insurance lookup table ("Insurances
// by date" for admins, "Insurances" for workers).
//
// The total is the sum of the SHOWN policies, per currency. It is computed
// from the same rows the table renders (after the column sorting, which does
// not change the set) and each row contributes the amount its Price column
// shows: an active policy its stored price plus the visual-only +2 card fee for
// a walk-in card payment, and an annulled policy its annulment tax (the tax is
// the policy's price now), so the tax kept from annulled policies is part of
// the total. A row whose price the current user may not see (a worker never
// sees a broker/email price) contributes nothing, exactly like its blank Price
// cell.
//
// The helper lives in renderer/WorkPage/WorkPage.js, which touches the DOM as
// soon as it is loaded, so this test cuts the price helpers out of the REAL
// file and runs them in a vm. If the markers move the test fails loudly instead
// of silently testing nothing.
//
// Run with:  node Test/insuranceTotalShown.test.cjs   (or: npm test)

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const WORKPAGE_JS = path.join(ROOT, "renderer", "WorkPage", "WorkPage.js");
const COMMON_JS = path.join(ROOT, "renderer", "common.js");

const src = fs.readFileSync(WORKPAGE_JS, "utf8");

const START_MARKER = "const CARD_FEE = 2;";
const END_MARKER = "// Display label for a stored payment type";

const start = src.indexOf(START_MARKER);
const end = src.indexOf(END_MARKER);
if (start < 0 || end < 0 || end <= start) {
  console.error(
    "Could not locate the insurance price helpers in WorkPage.js (markers moved?)"
  );
  process.exit(1);
}

const CTX = { console };
vm.createContext(CTX);
vm.runInContext(src.slice(start, end), CTX, {
  filename: "WorkPage.js#insuranceTotals",
});

const { sumShownInsurancePrices } = CTX;
if (typeof sumShownInsurancePrices !== "function") {
  console.error("Could not publish the insurance price helper from the vm");
  process.exit(1);
}

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

console.log("Insurance totals - sum of the shown policies (annulled at tax)");

check("sums the active policies of one currency", () => {
  eq(
    sumShownInsurancePrices([
      { Price: "45.00", CurrencyType: "EUR" },
      { Price: "30.50", CurrencyType: "EUR" },
    ]),
    [{ currency: "EUR", amount: 75.5 }],
    "45 + 30.50"
  );
});

check("adds an annulled policy at its annulment tax", () => {
  eq(
    sumShownInsurancePrices([
      { Price: "45.00", CurrencyType: "EUR", Annulled: 0 },
      { Price: "100.00", CurrencyType: "EUR", Annulled: 1, AnnulFee: "9" },
      { Price: "20.00", CurrencyType: "EUR", Annulled: false },
    ]),
    [{ currency: "EUR", amount: 74 }],
    "45 + 9 tax + 20"
  );
});

check("an annulled walk-in card policy adds its tax without the +2 card fee", () => {
  eq(
    sumShownInsurancePrices([
      {
        Price: "9.00",
        AnnulFee: 9,
        Annulled: 1,
        PaymentType: "Card",
        BrokerId: null,
        CurrencyType: "EUR",
      },
    ]),
    [{ currency: "EUR", amount: 9 }],
    "9 tax, no +2"
  );
});


check("keeps EUR and TRY apart instead of adding them together", () => {
  eq(
    sumShownInsurancePrices([
      { Price: "50", CurrencyType: "TRY" },
      { Price: "40", CurrencyType: "EUR" },
      { Price: "10", CurrencyType: "TRY" },
    ]),
    [
      { currency: "EUR", amount: 40 },
      { currency: "TRY", amount: 60 },
    ],
    "per-currency totals, sorted by currency"
  );
});

check("adds the +2 card fee for a walk-in card policy", () => {
  eq(
    sumShownInsurancePrices([
      { Price: "45.00", PaymentType: "Card", BrokerId: null, CurrencyType: "EUR" },
    ]),
    [{ currency: "EUR", amount: 47 }],
    "45 + 2 bank fee"
  );
});

check("does not bump a broker (email) card policy", () => {
  eq(
    sumShownInsurancePrices([
      { Price: "45.00", PaymentType: "Card", BrokerId: 7, CurrencyType: "EUR" },
    ]),
    [{ currency: "EUR", amount: 45 }],
    "broker prices never get the +2"
  );
});

check("leaves out prices the current user may not see", () => {
  const canSee = (item) =>
    item.BrokerId === null || item.BrokerId === undefined || item.BrokerId === "";
  eq(
    sumShownInsurancePrices(
      [
        { Price: "45", BrokerId: null, CurrencyType: "EUR" },
        { Price: "100", BrokerId: 7, CurrencyType: "EUR" },
      ],
      canSee
    ),
    [{ currency: "EUR", amount: 45 }],
    "a worker's total has no broker price in it"
  );
});

check("counts a shown deleted policy and a deleted annulled tax", () => {
  eq(
    sumShownInsurancePrices([
      { Price: "10", CurrencyType: "EUR", Deleted: 1 },
      { Price: "5", CurrencyType: "EUR", Deleted: 1, Annulled: 1, AnnulFee: "2" },
    ]),
    [{ currency: "EUR", amount: 12 }],
    "10 standing + 2 tax"
  );
});

check("rounds in cents (0.1 + 0.2 = 0.3)", () => {
  eq(
    sumShownInsurancePrices([
      { Price: "0.10", CurrencyType: "EUR" },
      { Price: "0.20", CurrencyType: "EUR" },
    ]),
    [{ currency: "EUR", amount: 0.3 }],
    "no floating-point dust"
  );
});

check("falls back to EUR when a row has no currency", () => {
  eq(
    sumShownInsurancePrices([{ Price: "12" }]),
    [{ currency: "EUR", amount: 12 }],
    "missing CurrencyType is EUR"
  );
});

check("ignores rows whose price is not a number", () => {
  eq(
    sumShownInsurancePrices([
      { Price: "not a price", CurrencyType: "EUR" },
      { Price: "15", CurrencyType: "EUR" },
    ]),
    [{ currency: "EUR", amount: 15 }],
    "only the numeric price is counted"
  );
});

check("returns an empty list when there is nothing to sum", () => {
  eq(sumShownInsurancePrices([]), [], "no rows");
  eq(sumShownInsurancePrices(null), [], "not an array");
  eq(
    sumShownInsurancePrices([
      { Price: "45", CurrencyType: "EUR", Annulled: 1, AnnulFee: "9" },
    ]),
    [{ currency: "EUR", amount: 9 }],
    "an annulled row alone contributes its tax"
  );
});

// --- view wiring -------------------------------------------------------------
// The helper is only useful if the results table actually renders its value.
check("the insurance results render the total they computed", () => {
  if (!src.includes("sumShownInsurancePrices(sorted, canSeePrice)"))
    throw new Error("renderResults does not call the helper with canSeePrice");
  if (!src.includes('class: "row insurance-total-row"'))
    throw new Error("the total row is not rendered under the table");
  if (!src.includes('t("totalIncludingAnnulled")'))
    throw new Error("the total row has no translated label");
});

check("the total label is translated (EN and BG)", () => {
  const common = fs.readFileSync(COMMON_JS, "utf8");
  const hits = common.match(/totalIncludingAnnulled:/g) || [];
  if (hits.length < 2)
    throw new Error(
      `expected the label in both dictionaries, found ${hits.length}`
    );
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

