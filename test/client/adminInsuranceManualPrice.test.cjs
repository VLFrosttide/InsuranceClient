"use strict";

// Node test for the admin add-insurance form's price: border insurance is priced
// from the tariff grid, while medical insurance and civil liability have no
// tariff rows and are typed by hand (ManualPriceInput).
//
// The REAL price block of renderer/AdminInsurance/AdminInsurance.js is cut out
// and run in a vm with fake inputs, so the fee and visibility rules are checked
// against the shipping code:
//   - border: tariff + non-Turk fee (card fee stays visual-only),
//   - medical / civil: the typed amount is saved as-is (no tariff, no fees),
//   - an empty or unreadable hand-typed amount blocks the save,
//   - switching the kind shows the right price field and clears the fee toggles,
//   - only border insurance requires the blanc / car / policy numbers; a medical
//     or civil liability form demands none of them.
//
// Run with:  node test/client/adminInsuranceManualPrice.test.cjs   (or: npm test)

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..", "..");
const ADMIN_JS = path.join(
  ROOT,
  "renderer",
  "AdminInsurance",
  "AdminInsurance.js"
);

const START_MARKER = "const NON_TURK_FEE = 5;";
const END_MARKER = "// Kinds of insurance (border / medical / civil)";

const src = fs.readFileSync(ADMIN_JS, "utf8");
const start = src.indexOf(START_MARKER);
const end = start < 0 ? -1 : src.indexOf(END_MARKER, start);
if (start < 0 || end < 0) {
  console.error("Could not locate the price block in AdminInsurance.js (moved?)");
  process.exit(1);
}
const block = src.slice(start, end);

// --- fakes -------------------------------------------------------------------
function fakeField(hidden = false) {
  const classes = new Set(hidden ? ["hidden"] : []);
  return {
    classList: {
      toggle(name, on) {
        if (on) classes.add(name);
        else classes.delete(name);
      },
      contains: (name) => classes.has(name),
    },
    isHidden() {
      return classes.has("hidden");
    },
  };
}

function setup() {
  const kinds = { value: "border" };
  // The real syncKindPricing marks the three number fields required for border
  // insurance only (medical / civil may leave every one of them blank), so the
  // fake document answers for them.
  const numbers = {
    CarNumberInput: { required: true },
    PolicyNumberInput: { required: true },
    BlancNumberInput: { required: true },
  };
  const els = {
    KindInput: kinds,
    ManualPriceInput: { value: "" },
    TariffPriceField: fakeField(false),
    ManualPriceField: fakeField(true),
    TotalPriceDisplay: Object.assign(fakeField(false), { textContent: "" }),
    NonTurkInput: { checked: false },
    CardFeeInput: { checked: false, disabled: true },
    CashInput: { checked: true },
    AutoTypeInput: { value: "Automobile" },
    DurationInput: { value: "1 месец" },
    CurrencyInput: { value: "EUR" },
    BrokerSelect: { value: "" },
  };
  const state = { brokerSyncs: 0 };

  const CTX = {
    console: { warn: () => {}, log: () => {}, error: () => {} },
    URLSearchParams,
    document: { getElementById: (id) => numbers[id] || null },
    localStorage: { getItem: () => null },
    getPricingCache: () => null,
    defaultInsuranceKind: "border",
    // The real syncBrokerMode lives in the next block; its job here is only to
    // show the broker/payment state, so the test just records the call.
    syncBrokerMode: () => {
      state.brokerSyncs++;
    },
    api: async () => ({}),
    ...els,
  };
  vm.createContext(CTX);
  vm.runInContext(
    block +
      "\n;globalThis.__setTariff = (v) => { tariffPrice = v; };" +
      "\nglobalThis.__fill = () => autofillPrice();" +
      "\nglobalThis.__sync = () => syncKindPricing();" +
      "\nglobalThis.__base = () => currentBasePrice();" +
      "\nglobalThis.__total = () => currentTotalPrice();" +
      "\nglobalThis.__display = () => currentDisplayPrice();" +
      "\nglobalThis.__fees = () => currentFees();" +
      "\nglobalThis.__manual = () => usesManualPrice();" +
      "\nglobalThis.__details = () => requiresPolicyDetails();",
    CTX,
    { filename: "AdminInsurance.js#price" }
  );
  return { CTX, els, state, kinds, numbers };
}

// --- tiny assert helpers -----------------------------------------------------
let passed = 0;
let failed = 0;
async function check(name, fn) {
  try {
    await fn();
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
function ok(cond, msg) {
  if (!cond) throw new Error(msg || "expected truthy");
}
(async () => {
  console.log("Admin add-insurance form — how the price is worked out");

  await check("border insurance is priced from the tariff (+ non-Turk fee)", () => {
    const { CTX, els } = setup();
    CTX.__setTariff(20);
    eq(CTX.__manual(), false, "border is tariff-priced");
    eq(CTX.__base(), 20, "base price");
    eq(CTX.__total(), 20, "total without fees");
    els.NonTurkInput.checked = true;
    eq(CTX.__fees(), 5, "non-Turk fee");
    eq(CTX.__total(), 25, "total with the non-Turk fee");
    // The card fee is only displayed: it is never part of the saved price.
    els.CardFeeInput.checked = true;
    eq(CTX.__display(), 27, "the card fee is only displayed");
    eq(CTX.__total(), 25, "and never saved");
  });

  await check("the non-Turk fee follows the currency", () => {
    const { CTX, els } = setup();
    CTX.__setTariff(20);
    els.NonTurkInput.checked = true;
    els.CurrencyInput.value = "TRY";
    eq(CTX.__fees(), 200, "TRY fee");
    eq(CTX.__total(), 220, "total in TRY");
  });

  await check("a medical policy saves the typed amount, not the tariff", () => {
    const { CTX, els, kinds } = setup();
    kinds.value = "medical";
    CTX.__setTariff(20); // an unrelated grid row is still in memory
    els.ManualPriceInput.value = "100";
    eq(CTX.__manual(), true, "medical is hand-priced");
    eq(CTX.__base(), 100, "the typed amount wins");
    eq(CTX.__total(), 100, "total is the typed amount");
    els.NonTurkInput.checked = true;
    eq(CTX.__fees(), 0, "no tariff fees on a hand-priced policy");
    eq(CTX.__total(), 100, "the fee changes nothing");
  });

  await check("a civil liability policy is hand-priced too", () => {
    const { CTX, els, kinds } = setup();
    kinds.value = "civil";
    els.ManualPriceInput.value = "250.5";
    eq(CTX.__base(), 250.5, "the typed amount");
    eq(CTX.__total(), 250.5, "total");
  });

  await check("a comma decimal separator is accepted", () => {
    const { CTX, els, kinds } = setup();
    kinds.value = "medical";
    els.ManualPriceInput.value = "12,50";
    eq(CTX.__base(), 12.5, "comma read as a decimal point");
  });

  await check("zero is a real price, an empty or unreadable one is not", () => {
    const { CTX, els, kinds } = setup();
    kinds.value = "medical";
    els.ManualPriceInput.value = "";
    eq(CTX.__total(), null, "empty blocks the save");
    els.ManualPriceInput.value = "abc";
    eq(CTX.__total(), null, "not a number");
    els.ManualPriceInput.value = "0";
    eq(CTX.__total(), 0, "a free policy is allowed");
  });

  await check("a border policy without a tariff row cannot be saved", () => {
    const { CTX } = setup();
    eq(CTX.__total(), null, "no tariff price yet");
  });

  await check("switching to medical shows the hand-typed field and clears fees", () => {
    const { CTX, els, kinds, state } = setup();
    els.NonTurkInput.checked = true;
    els.CardFeeInput.checked = true;
    kinds.value = "medical";
    const before = state.brokerSyncs;
    CTX.__sync();
    ok(els.TariffPriceField.isHidden(), "the tariff output is hidden");
    ok(!els.ManualPriceField.isHidden(), "the hand-typed input is shown");
    eq(els.NonTurkInput.checked, false, "non-Turk is cleared");
    eq(els.CardFeeInput.checked, false, "card fee is cleared");
    ok(state.brokerSyncs > before, "the broker/payment state is refreshed");
  });

  await check("switching back to border shows the tariff output again", () => {
    const { CTX, els, kinds } = setup();
    kinds.value = "medical";
    CTX.__sync();
    kinds.value = "border";
    CTX.__sync();
    ok(!els.TariffPriceField.isHidden(), "the tariff output is back");
    ok(els.ManualPriceField.isHidden(), "the hand-typed input is hidden");
    eq(CTX.__manual(), false, "border uses the grid");
  });

  await check("only border insurance demands the numbers", () => {
    const { CTX, kinds, numbers } = setup();
    const required = () => Object.values(numbers).map((el) => el.required);
    kinds.value = "border";
    CTX.__sync();
    eq(CTX.__details(), true, "border carries the border-form details");
    eq(required(), [true, true, true], "all three numbers are required");
    kinds.value = "medical";
    eq(CTX.__details(), false, "medical has no border-form details");
    CTX.__sync();
    eq(required(), [false, false, false], "a medical policy demands none");
    kinds.value = "civil";
    CTX.__sync();
    eq(required(), [false, false, false], "nor does civil liability");
    kinds.value = "border";
    CTX.__sync();
    eq(required(), [true, true, true], "border asks for them again");
  });

  if (failed) {
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(1);
  }
  console.log(`\n${passed} passed, 0 failed`);
})();
