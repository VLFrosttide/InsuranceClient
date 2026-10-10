"use strict";

// Node test for the add-insurance form's read-only, auto-calculated price.
//
// The price on the creation form is no longer an input: it is a plain
// <output id="TotalPriceDisplay"> showing the tariff price for the selected
// vehicle type + duration plus the selected fees (+5 non-Turk, +2 card fee),
// and that calculated value is what gets saved.
//
// Like the other renderer tests, this cuts the REAL code out of
// renderer/AddInsurance/AddInsurance.js - the "Auto-fill price" block, from
// NON_TURK_FEE down to the initial loadPolicyPricing() call - and runs it in a
// vm with a fake `document`, `api`, `localStorage` and pricing cache.
//
// Run with:  node Test/addInsurancePrice.test.cjs   (or: npm test)

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const ADD_JS = path.join(ROOT, "renderer", "AddInsurance", "AddInsurance.js");
const ADD_HTML = path.join(ROOT, "renderer", "AddInsurance", "AddInsurance.html");

const START_MARKER = "const NON_TURK_FEE = 5;";
const END_RE = /\nloadPolicyPricing\(\);\r?\n/;

const src = fs.readFileSync(ADD_JS, "utf8");
const start = src.indexOf(START_MARKER);
const endMatch = start < 0 ? null : END_RE.exec(src.slice(start));
if (start < 0 || !endMatch) {
  console.error("Could not locate the price block in AddInsurance.js (moved?)");
  process.exit(1);
}
// Up to (and including) the initial loadPolicyPricing() call.
const block = src.slice(start, start + endMatch.index + endMatch[0].length);

// --- fakes -------------------------------------------------------------------
function fakeEl(props = {}) {
  const listeners = {};
  const classes = new Set();
  return {
    value: "",
    checked: false,
    disabled: false,
    textContent: "",
    ...props,
    classList: {
      toggle(name, on) {
        if (on) classes.add(name);
        else classes.delete(name);
      },
      contains: (name) => classes.has(name),
    },
    addEventListener(type, fn) {
      (listeners[type] = listeners[type] || []).push(fn);
    },
    async fire(type) {
      for (const fn of listeners[type] || []) await fn();
    },
  };
}

// Builds a fresh form + context and runs the block in it. `pricing` is what
// GET /tariffs/policy-pricing returns (or an Error to make it fail).
async function setup({ pricing, cache = null } = {}) {
  const els = {
    NonTurkInput: fakeEl(),
    CardFeeInput: fakeEl({ disabled: true }),
    CashInput: fakeEl({ checked: true }),
    TotalPriceDisplay: fakeEl({ textContent: "" }),
    AutoTypeInput: fakeEl({ value: "Automobile" }),
    DurationInput: fakeEl({ value: "1 месец" }),
  };
  const pending = [];
  const CTX = {
    console: { warn: () => {}, log: console.log, error: console.error },
    URLSearchParams,
    document: { getElementById: (id) => els[id] || null },
    localStorage: { getItem: (k) => (k === "branch" ? "Офис Харманли" : null) },
    PendingEmail: null,
    DurationInput: els.DurationInput,
    getPricingCache: () => cache,
    // Held open until the test releases it, so the loading state is visible.
    api: () =>
      new Promise((resolve, reject) => {
        pending.push(() =>
          pricing instanceof Error ? reject(pricing) : resolve({ pricing })
        );
      }),
  };
  vm.createContext(CTX);
  // `let` bindings stay script-scoped, so expose the bits the test reads.
  vm.runInContext(
    block +
      "\n;globalThis.__loading = () => pricingLoading;" +
      "\nglobalThis.__total = () => currentTotalPrice();" +
      "\nglobalThis.__reload = () => loadPolicyPricing();",
    CTX,
    { filename: "AddInsurance.js#price" }
  );
  const loadingText = els.TotalPriceDisplay.textContent;
  pending.shift()();
  // Let the awaited api() promise settle.
  await new Promise((r) => setImmediate(r));
  return {
    els,
    CTX,
    loadingText,
    shown: () => els.TotalPriceDisplay.textContent,
    total: () => CTX.__total(),
    async select(id, value) {
      els[id].value = value;
      await els[id].fire("change");
    },
    async tick(id, checked) {
      els[id].checked = checked;
      await els[id].fire("change");
    },
  };
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

const PRICING = {
  Auto: { 15: 25, 30: 45, 90: 110 },
  Motor: { 15: 15, 30: 25.5, 90: 60 },
  Trailer: { 30: 20 },
};

(async () => {
  console.log("Add insurance — read-only calculated price");

  await check("the price is not an input on the form", async () => {
    const html = fs.readFileSync(ADD_HTML, "utf8");
    ok(!/id="TotalPriceInput"/.test(html), "the old price input is gone");
    const m = /<(\w+)\s[^>]*id="TotalPriceDisplay"[^>]*>/.exec(html);
    ok(m, "TotalPriceDisplay exists");
    ok(
      !["input", "select", "textarea"].includes(m[1].toLowerCase()),
      `price must not be editable (is <${m[1]}>)`
    );
    ok(!/contenteditable/i.test(m[0]), "not contenteditable");
    ok(!/FormInput/.test(m[0]), "not collected as a form input");
  });

  await check("shows … while the tariffs load, then the tariff price", async () => {
    const f = await setup({ pricing: PRICING });
    eq(f.loadingText, "…", "loading");
    eq(f.shown(), "45.00", "Auto / 30");
    eq(f.total(), 45, "saved price");
  });

  await check("changing vehicle type or duration recalculates", async () => {
    const f = await setup({ pricing: PRICING });
    await f.select("AutoTypeInput", "Motor");
    eq(f.shown(), "25.50", "Motor / 30");
    await f.select("DurationInput", "3 месеца");
    eq(f.shown(), "60.00", "Motor / 90");
    await f.select("DurationInput", "15 дена");
    eq(f.shown(), "15.00", "Motor / 15");
  });

  await check("the non-Turk fee adds 5", async () => {
    const f = await setup({ pricing: PRICING });
    await f.tick("NonTurkInput", true);
    eq(f.shown(), "50.00", "45 + 5");
    eq(f.total(), 50, "saved price");
    await f.tick("NonTurkInput", false);
    eq(f.shown(), "45.00", "back to 45");
  });

  await check("the card fee adds 2 and only applies when not paid in cash", async () => {
    const f = await setup({ pricing: PRICING });
    eq(f.els.CardFeeInput.disabled, true, "locked while cash");
    await f.tick("CashInput", false);
    eq(f.els.CardFeeInput.disabled, false, "unlocked for card");
    await f.tick("CardFeeInput", true);
    eq(f.shown(), "47.00", "45 + 2");
    await f.tick("CashInput", true);
    eq(f.els.CardFeeInput.checked, false, "cleared when back to cash");
    eq(f.shown(), "45.00", "fee removed");
  });

  await check("fees stay applied across a recalculation", async () => {
    const f = await setup({ pricing: PRICING });
    await f.tick("NonTurkInput", true);
    await f.select("DurationInput", "3 месеца");
    eq(f.shown(), "115.00", "110 + 5");
  });

  await check("no tariff for the combination shows n/a and has no price", async () => {
    const f = await setup({ pricing: PRICING });
    await f.select("AutoTypeInput", "Trailer");
    eq(f.shown(), "20.00", "Trailer / 30 exists");
    await f.select("DurationInput", "15 дена");
    eq(f.shown(), "n/a", "Trailer / 15 missing");
    ok(f.els.TotalPriceDisplay.classList.contains("price-unavailable"), "muted");
    eq(f.total(), null, "nothing can be saved");
  });

  await check("fees never turn n/a into a price", async () => {
    const f = await setup({ pricing: PRICING });
    await f.select("AutoTypeInput", "Bus");
    await f.tick("NonTurkInput", true);
    eq(f.shown(), "n/a", "still n/a");
    eq(f.total(), null, "still no price");
  });

  await check("a failed tariff request falls back to the cached pricing", async () => {
    const f = await setup({ pricing: new Error("offline"), cache: PRICING });
    eq(f.shown(), "45.00", "cached Auto / 30");
  });

  await check("no tariffs at all shows n/a", async () => {
    const f = await setup({ pricing: new Error("offline"), cache: null });
    eq(f.shown(), "n/a", "n/a");
    eq(f.total(), null, "no price");
  });

  await check("a zero tariff is a real price, not n/a", async () => {
    const f = await setup({ pricing: { Auto: { 30: 0 } } });
    eq(f.shown(), "0.00", "0");
    eq(f.total(), 0, "saved as 0");
  });

  await check("a reload keeps the last price on screen until the new one arrives", async () => {
    const f = await setup({ pricing: PRICING });
    f.CTX.__reload();
    eq(f.CTX.__loading(), true, "loading flag");
    eq(f.shown(), "45.00", "last price still shown");
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
