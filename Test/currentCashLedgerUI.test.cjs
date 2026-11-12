"use strict";

// Node test for the row-colouring helpers of the Current cash ledger
// (renderer/WorkPage/WorkPage.js).
//
// The ledger tables are tinted, so the rules behind the tints have to stay
// honest:
//   - an increase is green, a reduction is red;
//   - a movement above the notable amount OF ITS CURRENCY is tinted one step
//     stronger, which is what makes a big increase or a big expense stand out.
//     The limits mirror the exchange rate the branches use - 5 500 TRY is
//     100 EUR - so a lira movement is never flagged sooner than a euro one;
//   - a row whose reason carries words is nudged up, while a purely numerical
//     reason (a bare policy number, a date typed by hand) is dimmed instead.
// The helpers are pure, but they live in WorkPage.js, so the block is lifted
// out of the real file and run in a vm - like the other WorkPage tests.
//
// Run with:  node Test/currentCashLedgerUI.test.cjs   (or: npm test)

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const WORKPAGE_JS = path.join(ROOT, "renderer", "WorkPage", "WorkPage.js");

const src = fs.readFileSync(WORKPAGE_JS, "utf8");
const START = "const NOTABLE_AMOUNT = 100;";
const END = "\nfunction openModal(";
const start = src.indexOf(START);
const end = start < 0 ? -1 : src.indexOf(END, start);
if (start < 0 || end < 0) {
  console.error(
    "Could not locate the cash ledger tinting helpers in WorkPage.js (moved?)"
  );
  process.exit(1);
}
const block = src.slice(start, end);

const CTX = {};
vm.createContext(CTX);
vm.runInContext(
  block +
    "\nglobalThis.movementRowClass = movementRowClass;" +
    "\nglobalThis.reasonRowClass = reasonRowClass;" +
    "\nglobalThis.cashLedgerRowClass = cashLedgerRowClass;" +
    "\nglobalThis.amountCellClass = amountCellClass;",
  CTX,
  { filename: "WorkPage.js#cashLedgerTinting" }
);
const { movementRowClass, reasonRowClass, cashLedgerRowClass, amountCellClass } =
  CTX;

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

console.log("Insurance — Current cash ledger row colouring");

// --- movement tints ---------------------------------------------------------
check("an ordinary increase is green only", () => {
  eq(movementRowClass("increase", 50, "EUR"), "row-increase", "50 in");
});

check("an ordinary reduction is red only", () => {
  eq(movementRowClass("reduce", 20, "EUR"), "row-reduce", "20 out");
});

check("exactly 100 EUR / 5 500 TRY is not yet a big movement", () => {
  eq(movementRowClass("increase", 100, "EUR"), "row-increase", "100 in EUR");
  eq(movementRowClass("reduce", 100, "EUR"), "row-reduce", "100 out EUR");
  eq(movementRowClass("increase", 5500, "TRY"), "row-increase", "5500 in TRY");
  eq(movementRowClass("reduce", 5500, "TRY"), "row-reduce", "5500 out TRY");
});

check("an increase above 100 EUR steps up", () => {
  eq(
    movementRowClass("increase", 100.01, "EUR"),
    "row-increase row-large-increase",
    "100.01 in EUR"
  );
});

check("an increase above 5 500 TRY steps up", () => {
  eq(
    movementRowClass("increase", 5500.01, "TRY"),
    "row-increase row-large-increase",
    "5500.01 in TRY"
  );
});

check("a reduction above 100 EUR steps up (a big expense)", () => {
  eq(
    movementRowClass("reduce", 150, "EUR"),
    "row-reduce row-large-reduce",
    "150 out EUR"
  );
});

check("a lira amount is judged in lira, not by its number", () => {
  // 250 EUR is big money, 250 TRY is small money.
  eq(
    movementRowClass("increase", 250, "EUR"),
    "row-increase row-large-increase",
    "250 EUR"
  );
  eq(movementRowClass("increase", 250, "TRY"), "row-increase", "250 TRY");
  eq(movementRowClass("reduce", 5000, "TRY"), "row-reduce", "5000 TRY");
  eq(
    movementRowClass("reduce", 6000, "TRY"),
    "row-reduce row-large-reduce",
    "6000 TRY"
  );
});

check("the currency is matched case-insensitively", () => {
  eq(movementRowClass("increase", 1000, "try"), "row-increase", "1000 lower TRY");
  eq(
    movementRowClass("increase", 1000, "Try"),
    "row-increase",
    "1000 mixed TRY"
  );
});

check("a missing currency is treated as EUR", () => {
  eq(
    movementRowClass("increase", 250),
    "row-increase row-large-increase",
    "250, no currency"
  );
  eq(
    movementRowClass("increase", 250, null),
    "row-increase row-large-increase",
    "250, null currency"
  );
});

check("amounts are compared as numbers, not strings", () => {
  eq(
    movementRowClass("increase", "250.00", "EUR"),
    "row-increase row-large-increase",
    "a string amount"
  );
  eq(
    movementRowClass("increase", "6000", "TRY"),
    "row-increase row-large-increase",
    "a string lira amount"
  );
  eq(movementRowClass("increase", null, "EUR"), "row-increase", "no amount");
});

check("an unknown movement type gets no tint", () => {
  eq(movementRowClass("something", 500, "EUR"), "", "unknown type");
});

// --- reason tints -----------------------------------------------------------
check("a reason with words is emphasised", () => {
  eq(reasonRowClass("Rent for the office"), "row-text-reason", "latin text");
  eq(reasonRowClass("Наем за офиса"), "row-text-reason", "cyrillic text");
  eq(reasonRowClass("Annul 123456"), "row-text-reason", "text + number");
});

check("a purely numerical reason is dimmed", () => {
  eq(reasonRowClass("123456"), "row-numeric-reason", "a bare policy number");
  eq(reasonRowClass(" 123456 "), "row-numeric-reason", "padded number");
  eq(reasonRowClass("2026-05-10"), "row-numeric-reason", "a date");
  eq(reasonRowClass("12,50"), "row-numeric-reason", "an amount");
});

check("a missing reason stays neutral", () => {
  eq(reasonRowClass(""), "", "empty");
  eq(reasonRowClass("   "), "", "blank");
  eq(reasonRowClass(null), "", "null");
  eq(reasonRowClass(undefined), "", "undefined");
});

// --- combined row classes ---------------------------------------------------
check("movement and reason tints are combined", () => {
  eq(
    cashLedgerRowClass("increase", 250, "EUR", "Kasko, walk-in"),
    "row-increase row-large-increase row-text-reason",
    "big increase with text"
  );
  eq(
    cashLedgerRowClass("reduce", 20, "EUR", "123456"),
    "row-reduce row-numeric-reason",
    "small reduction with a number"
  );
  eq(
    cashLedgerRowClass("reduce", 300, "EUR", "Ремонт на касов апарат"),
    "row-reduce row-large-reduce row-text-reason",
    "big expense with text"
  );
  eq(
    cashLedgerRowClass("reduce", 5000, "TRY", "Наем за офиса"),
    "row-reduce row-text-reason",
    "a 5 000 TRY expense is not big"
  );
  eq(
    cashLedgerRowClass("reduce", 6000, "TRY", "Наем за офиса"),
    "row-reduce row-large-reduce row-text-reason",
    "a 6 000 TRY expense is big"
  );
});

// --- amount cell emphasis ---------------------------------------------------
check("the amount of a notable movement is emphasised", () => {
  eq(
    amountCellClass({ Amount: "150.00", Currency: "EUR" }),
    "amount-notable",
    "150 EUR"
  );
  eq(amountCellClass({ Amount: 100, Currency: "EUR" }), "", "exactly 100 EUR");
  eq(amountCellClass({ Amount: 99.99, Currency: "EUR" }), "", "99.99 EUR");
  eq(amountCellClass({ Amount: 5000, Currency: "TRY" }), "", "5 000 TRY");
  eq(
    amountCellClass({ Amount: 5500, Currency: "TRY" }),
    "",
    "exactly 5 500 TRY"
  );
  eq(
    amountCellClass({ Amount: 6000, Currency: "TRY" }),
    "amount-notable",
    "6 000 TRY"
  );
  eq(amountCellClass({ Amount: 150 }), "amount-notable", "no currency (EUR)");
  eq(amountCellClass(null), "", "no row");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
