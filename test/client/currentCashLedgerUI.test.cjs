"use strict";

// Node test for the row-colouring helpers of the Current cash ledger
// (renderer/WorkPage/WorkPage.js).
//
// The ledger tables are tinted, so the rules behind the tints have to stay
// honest:
//   - an increase is green, a reduction (an expense) is red, money handed over
//     to a person is amber; an entry above the notable amount OF ITS CURRENCY is
//     tinted one step stronger, which is what makes a big increase or a big
//     expense stand out.
//     The limits mirror the exchange rate the branches use - 5 500 TRY is
//     100 EUR - so a lira movement is never flagged sooner than a euro one;
//   - a row whose reason carries words is nudged up, while a purely numerical
//     reason (a bare policy number, a date typed by hand) is dimmed instead.
// The helpers are pure, but they live in WorkPage.js, so the block is lifted
// out of the real file and run in a vm - like the other WorkPage tests.
//
// Run with:  node test/client/currentCashLedgerUI.test.cjs   (or: npm test)

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..", "..");
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
// The heading-count helpers label their counts through t(); the keys themselves
// are what these tests check, so the translator is a pass-through.
CTX.t = (key) => key;
vm.runInContext(
  block +
    "\nglobalThis.movementRowClass = movementRowClass;" +
    "\nglobalThis.reasonRowClass = reasonRowClass;" +
    "\nglobalThis.cashLedgerRowClass = cashLedgerRowClass;" +
    "\nglobalThis.amountCellClass = amountCellClass;" +
    "\nglobalThis.cashLedgerCountKind = cashLedgerCountKind;" +
    "\nglobalThis.cashLedgerTypeTiers = cashLedgerTypeTiers;" +
    "\nglobalThis.cashLedgerCountLabel = cashLedgerCountLabel;" +
    "\nglobalThis.cardPaymentStatusKind = cardPaymentStatusKind;" +
    "\nglobalThis.cardPaymentStatusTiers = cardPaymentStatusTiers;" +
    "\nglobalThis.cardPaymentStatusCountLabel = cardPaymentStatusCountLabel;" +
    "\nglobalThis.formatTierGroup = formatTierGroup;" +
    "\nglobalThis.compactMoney = compactMoney;",
  CTX,
  { filename: "WorkPage.js#cashLedgerTinting" }
);
const {
  movementRowClass,
  reasonRowClass,
  cashLedgerRowClass,
  amountCellClass,
  cashLedgerCountKind,
  cashLedgerTypeTiers,
  cashLedgerCountLabel,
  cardPaymentStatusKind,
  cardPaymentStatusTiers,
  cardPaymentStatusCountLabel,
  formatTierGroup,
  compactMoney,
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
    console.log("  FAIL  " + name + "  -> " + err.message);
  }
}
function eq(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b)
    throw new Error((msg || "values differ") + ` (got ${a}, want ${b})`);
}
function ok(value, msg) {
  if (!value) throw new Error(msg || "expected a truthy value");
}

console.log("Insurance — Current cash ledger row colouring");

// --- the admin-only cash controls ------------------------------------------
check("admins are not offered End shift", () => {
  ok(
    /if \(!isAdmin\) \{\s*actions\.appendChild\(resetBtn\);/.test(src),
    "End shift is appended for workers only"
  );
});

check("hand-over statistics and the undo list are admin-only", () => {
  const gates = src.match(/if \(isAdmin && data\.handoverStats\)/g) || [];
  ok(
    gates.length >= 2,
    "the statistics card and the handed-over list are gated by isAdmin"
  );
  ok(
    src.includes("/currentcash/handover/${handover.id}/undo"),
    "the undo action calls the hand-over return endpoint"
  );
});

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

check("a hand-over has its own amber tint, not the expense red", () => {
  eq(movementRowClass("handover", 20, "EUR"), "row-handover", "20 handed over");
  eq(
    movementRowClass("handover", 150, "EUR"),
    "row-handover row-large-handover",
    "150 handed over is big"
  );
  eq(
    movementRowClass("handover", 6000, "TRY"),
    "row-handover row-large-handover",
    "6 000 TRY handed over is big"
  );
  eq(
    movementRowClass("handover", 5000, "TRY"),
    "row-handover",
    "5 000 TRY handed over is not big"
  );
});

check("an unknown movement type gets no tint", () => {
  eq(movementRowClass("something", 500, "EUR"), "", "unknown type");
});

check("money returned from a hand-over is green, like an increase", () => {
  eq(
    movementRowClass("handover_return", 20, "EUR"),
    "row-increase",
    "20 returned"
  );
  eq(
    movementRowClass("handover_return", 150, "EUR"),
    "row-increase row-large-increase",
    "150 returned is big"
  );
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

// --- per-type, per-price heading breakdown ---------------------------------
check("cash rows are grouped per type and price tier", () => {
  const txs = [
    { Type: "handover", Reason: "Ivan", Amount: 20, Currency: "EUR" },
    { Type: "increase", Reason: "123456", Amount: "40.00", Currency: "EUR" },
    { Type: "reduce", Reason: "Rent", Amount: 100, Currency: "EUR" },
    { Type: "increase", Reason: "654321", Amount: 40, Currency: "eur" },
    { Type: "increase", Reason: "111111", Amount: 25, Currency: "EUR" },
    { Type: "increase", Reason: "222222", Amount: 5500, Currency: "TRY" },
    { Type: "handover_return", Reason: "Ivan", Amount: 20, Currency: "EUR" },
  ];
  eq(
    cashLedgerTypeTiers(txs),
    [
      {
        kind: "increase",
        tiers: [
          { amount: 40, currency: "EUR", count: 2 },
          { amount: 25, currency: "EUR", count: 1 },
          { amount: 5500, currency: "TRY", count: 1 },
        ],
      },
      {
        kind: "reduce",
        tiers: [{ amount: 100, currency: "EUR", count: 1 }],
      },
      {
        kind: "handover",
        tiers: [{ amount: 20, currency: "EUR", count: 1 }],
      },
      {
        kind: "handover_return",
        tiers: [{ amount: 20, currency: "EUR", count: 1 }],
      },
    ],
    "each price counted within its type, biggest first"
  );
  eq(
    formatTierGroup(cashLedgerTypeTiers(txs)[0], cashLedgerCountLabel),
    "increase: 2× 40 EUR, 1× 25 EUR, 1× 5500 TRY",
    "the heading words the tiers as N× price currency"
  );
});

check("an annulment is counted apart, with its own price tiers", () => {
  eq(
    cashLedgerTypeTiers([
      { Type: "reduce", Reason: "Annul 123456", Amount: 45, Currency: "EUR" },
      { Type: "reduce", Reason: "Annul 777", Amount: 45, Currency: "EUR" },
      { Type: "reduce", Reason: "annul 42", Amount: 45, Currency: "EUR" },
      { Type: "reduce", Reason: "Rent", Amount: 100, Currency: "EUR" },
      { Type: "increase", Reason: "123456", Amount: 40, Currency: "EUR" },
    ]),
    [
      {
        kind: "increase",
        tiers: [{ amount: 40, currency: "EUR", count: 1 }],
      },
      {
        kind: "reduce",
        tiers: [{ amount: 100, currency: "EUR", count: 1 }],
      },
      {
        kind: "annul",
        tiers: [{ amount: 45, currency: "EUR", count: 3 }],
      },
    ],
    "the annuls get their own line and their own prices"
  );
  eq(
    formatTierGroup(
      { kind: "annul", tiers: [{ amount: 45, currency: "EUR", count: 7 }] },
      cashLedgerCountLabel
    ),
    "annulments: 7× 45 EUR",
    "7 annuls of 45 EUR read as one tier"
  );
  eq(
    cashLedgerCountKind({ Type: "reduce", Reason: "Annul" }),
    "annul",
    "the bare word"
  );
  eq(
    cashLedgerCountKind({ Type: "reduce", Reason: "Annulled 42" }),
    "reduce",
    "an ordinary word is not an annulment"
  );
  eq(
    cashLedgerCountKind({ Type: "reduce", Reason: "Rent" }),
    "reduce",
    "normal reason"
  );
  eq(cashLedgerCountLabel("annul"), "annulments", "an annul has its own label");
  eq(
    cashLedgerCountLabel("reduce"),
    "expense",
    "other types use the table label"
  );
});

check("an unknown or missing type never breaks a heading", () => {
  eq(cashLedgerTypeTiers(), [], "no list");
  eq(cashLedgerTypeTiers(null), [], "null list");
  eq(cashLedgerTypeTiers([{ Reason: "Rent" }]), [], "a row without a type");
  eq(
    cashLedgerTypeTiers([{ Type: "bonus", Amount: 15 }, { Type: "increase" }]),
    [
      {
        kind: "increase",
        tiers: [{ amount: 0, currency: "EUR", count: 1 }],
      },
      {
        kind: "bonus",
        tiers: [{ amount: 15, currency: "EUR", count: 1 }],
      },
    ],
    "a new type still gets a line, after the known ones"
  );
});

check("prices are shown short, without padded cents", () => {
  eq(compactMoney(40), "40", "a whole euro");
  eq(compactMoney("40.00"), "40", "a stored string");
  eq(compactMoney(25.5), "25.5", "half a euro");
  eq(compactMoney(12.75), "12.75", "cents");
  eq(compactMoney(undefined), "0", "a missing amount");
});

check("card payments are grouped per status and price, annulled apart", () => {
  const items = [
    { Annulled: 0, Price: "40.00", CurrencyType: "EUR" },
    { Annulled: 0, Price: 40, CurrencyType: "EUR" },
    { Annulled: 0, Price: 25, CurrencyType: "EUR" },
    { Annulled: 1, AnnulReason: "worker", Price: 45, CurrencyType: "EUR" },
    { Annulled: 1, AnnulReason: "broker", Price: 40, CurrencyType: "EUR" },
    { Annulled: 1, AnnulReason: "broker", Price: 40, CurrencyType: "EUR" },
    { Annulled: 1, Price: 45, CurrencyType: "EUR" },
  ];
  eq(
    cardPaymentStatusTiers(items),
    [
      {
        kind: "active",
        tiers: [
          { amount: 40, currency: "EUR", count: 2 },
          { amount: 25, currency: "EUR", count: 1 },
        ],
      },
      {
        kind: "annulled-worker",
        tiers: [{ amount: 45, currency: "EUR", count: 1 }],
      },
      {
        kind: "annulled-broker",
        tiers: [{ amount: 40, currency: "EUR", count: 2 }],
      },
      {
        kind: "annulled",
        tiers: [{ amount: 45, currency: "EUR", count: 1 }],
      },
    ],
    "each annulled type keeps its own prices"
  );
  eq(
    formatTierGroup(
      cardPaymentStatusTiers(items)[2],
      cardPaymentStatusCountLabel
    ),
    "annulled (annul.payer.broker): 2× 40 EUR",
    "an annulled type's heading"
  );
  eq(cardPaymentStatusKind(null), "", "no row");
  eq(cardPaymentStatusKind({ Deleted: 1 }), "deleted", "a deleted policy");
  eq(cardPaymentStatusCountLabel("active"), "active", "active label");
  eq(cardPaymentStatusCountLabel("annulled"), "annulled", "legacy annul label");
});

check("the tables' headings carry the price breakdown", () => {
  ok(
    /collapsibleSection\(\s*t\("transactions"\),[\s\S]{0,300}?cashLedgerTypeTiers\(data\.transactions\)/.test(
      src
    ),
    "the Transactions heading lists its prices per type"
  );
  ok(
    /collapsibleSection\(\s*t\("cardInsurances"\),[\s\S]{0,300}?cardPaymentStatusTiers\(data\.cardInsurances\)/.test(
      src
    ),
    "the Card payments heading lists its prices per status"
  );
  ok(
    /class: "collapsible-counts"/.test(src),
    "the breakdown is rendered inside the heading"
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
