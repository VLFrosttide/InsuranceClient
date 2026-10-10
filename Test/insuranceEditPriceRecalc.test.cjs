"use strict";

// Node test for the "edit an insurance" modal's price recalculation.
//
// Changing the duration or the vehicle type of a policy in the edit modal has
// to recalculate its price from the tariffs (broker tariffs for email
// policies, branch walk-in tariffs for walk-ins) plus the policy's stored fees
// (+5 non-Turk, +2 card fee while paid by card).
//
// Like insuranceEditorRefresh.test.cjs this cuts the REAL code out of
// renderer/WorkPage/WorkPage.js - from the edit-price helpers down to the end
// of openInsuranceEditor - and runs it in a vm with buildForm / openModal /
// toast / t / api stubbed. buildForm is replaced with a tiny fake form whose
// controls are found through querySelector('[data-key="..."]'), the same way
// the production buildForm tags them.
//
// Run with:  node Test/insuranceEditPriceRecalc.test.cjs   (or: npm test)

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const WORKPAGE_JS = path.join(ROOT, "renderer", "WorkPage", "WorkPage.js");

const HELPERS_MARKER = "const EDIT_DURATION_OPTIONS = ";
const START_MARKER = "function openInsuranceEditor(insurance, onDone) {";

const src = fs.readFileSync(WORKPAGE_JS, "utf8");
const helpersStart = src.indexOf(HELPERS_MARKER);
const start = src.indexOf(START_MARKER);
if (helpersStart < 0 || start < 0 || helpersStart > start) {
  console.error("Could not locate the edit-price code in WorkPage.js (moved?)");
  process.exit(1);
}
const tail = src.slice(start);
const closing = /\r?\n\}\r?\n/.exec(tail);
if (!closing) {
  console.error("Could not find the end of openInsuranceEditor");
  process.exit(1);
}
const block =
  src.slice(helpersStart, start) +
  tail.slice(0, closing.index + closing[0].length);

// --- fakes -------------------------------------------------------------------
let apiCalls = [];
let toasts = [];
let lastForm = null;
let lastSpec = null;
// url -> response (object) or Error to throw.
let apiRoutes = {};

function fakeControl(spec) {
  const listeners = {};
  return {
    spec,
    value:
      spec.value === undefined || spec.value === null ? "" : String(spec.value),
    // Checkboxes carry their state in `checked`, like the real buildForm.
    checked: spec.type === "checkbox" ? !!spec.value : undefined,
    disabled: false,
    addEventListener(type, fn) {
      (listeners[type] = listeners[type] || []).push(fn);
    },
    async fire(type) {
      for (const fn of listeners[type] || []) await fn();
    },
  };
}

const CTX = {
  console,
  t: (key, fallback) => (fallback !== undefined ? fallback : key),
  buildForm: (spec) => {
    lastSpec = spec;
    const controls = {};
    for (const s of spec) controls[s.key] = fakeControl(s);
    lastForm = {
      controls,
      querySelector(sel) {
        const m = /^\[data-key="([^"]+)"\]$/.exec(sel);
        return m ? controls[m[1]] || null : null;
      },
    };
    return lastForm;
  },
  openModal: () => {},
  closeModal: () => {},
  toast: (message, kind) => toasts.push(`${kind}: ${message}`),
  api: async (url) => {
    apiCalls.push(url);
    const r = apiRoutes[url];
    if (r instanceof Error) throw r;
    if (r === undefined) throw new Error(`unexpected request ${url}`);
    return r;
  },
};
vm.createContext(CTX);
vm.runInContext(block, CTX, { filename: "WorkPage.js#editPriceRecalc" });

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

const BRANCH = "Офис Харманли";
const BRANCH_URL = `/tariffs/branch/${encodeURIComponent(BRANCH)}`;
const BRANCH_PRICING = {
  Auto: { 15: 25, 30: 45, 90: 110 },
  Motor: { 15: 15, 30: 25, 90: 60 },
  Bus: { 30: 70 },
  Trailer: { 30: 20 },
};
const BROKER_PRICING = { Auto: { 15: 20, 30: 40, 90: 100 }, Bus: { 30: 65 } };

const walkIn = (extra) => ({
  BlancNumber: "1234567",
  PolicyNumber: "P-001",
  Price: "45.00",
  CurrencyType: "EUR",
  Duration: 30,
  Branch: BRANCH,
  Otomobil: "Automobile",
  StartDate: "2026-10-01",
  PaymentType: "Cash",
  BrokerId: null,
  NonTurk: 0,
  CardFee: 0,
  Annulled: 0,
  ...extra,
});

function open(row) {
  apiCalls = [];
  toasts = [];
  apiRoutes = { [BRANCH_URL]: { branch: BRANCH, pricing: BRANCH_PRICING } };
  CTX.openInsuranceEditor(row);
  const c = lastForm.controls;
  return {
    c,
    async set(key, value) {
      c[key].value = String(value);
      await c[key].fire("change");
    },
  };
}

(async () => {
  console.log("openInsuranceEditor — price recalculation");

  await check("duration and vehicle type are dropdowns with the stored values", async () => {
    open(walkIn());
    const d = lastSpec.find((s) => s.key === "Duration");
    const v = lastSpec.find((s) => s.key === "Otomobil");
    eq(d.type, "select", "duration type");
    eq(d.options.map((o) => o.value), [15, 30, 90], "duration options");
    eq(d.value, 30, "duration value");
    eq(v.type, "select", "vehicle type");
    eq(v.options.map((o) => o.value), ["Automobile", "Motor", "Bus", "Trailer"]);
    eq(v.value, "Automobile", "vehicle value");
  });

  await check("unknown stored values are kept as extra options", async () => {
    open(walkIn({ Duration: 365, Otomobil: "Лек автомобил" }));
    const d = lastSpec.find((s) => s.key === "Duration");
    const v = lastSpec.find((s) => s.key === "Otomobil");
    eq(d.options[d.options.length - 1].value, 365, "365 kept");
    eq(v.options[v.options.length - 1].value, "Лек автомобил", "legacy kept");
  });

  await check("opening the editor does not touch the price or fetch tariffs", async () => {
    const e = open(walkIn({ Price: "50.00" }));
    eq(e.c.Price.value, "50.00", "price untouched");
    eq(apiCalls, [], "no requests yet");
  });

  await check("changing the duration recalculates from branch tariffs", async () => {
    const e = open(walkIn());
    await e.set("Duration", 90);
    eq(e.c.Price.value, "110.00", "Auto / 90");
    eq(apiCalls, [BRANCH_URL], "branch tariffs");
  });

  await check("changing the vehicle type recalculates the price", async () => {
    const e = open(walkIn());
    await e.set("Otomobil", "Motor");
    eq(e.c.Price.value, "25.00", "Motor / 30");
    await e.set("Duration", 15);
    eq(e.c.Price.value, "15.00", "Motor / 15");
    eq(apiCalls.length, 1, "tariffs fetched once per modal");
  });

  await check("the non-Turk fee is added on top", async () => {
    const e = open(walkIn({ NonTurk: 1 }));
    await e.set("Duration", 15);
    eq(e.c.Price.value, "30.00", "25 + 5");
  });

  await check("the card fee is added only while paid by card", async () => {
    const e = open(walkIn({ PaymentType: "Card", CardFee: 1 }));
    await e.set("Duration", 15);
    eq(e.c.Price.value, "27.00", "25 + 2");
    e.c.PaymentType.value = "Cash";
    await e.set("Duration", 30);
    eq(e.c.Price.value, "45.00", "no card fee for cash");
  });

  await check("email policies use the broker's tariffs", async () => {
    const e = open(walkIn({ BrokerId: 7, PaymentType: "Broker", CardFee: 1 }));
    apiRoutes["/tariffs/broker/7"] = { brokerId: 7, pricing: BROKER_PRICING };
    await e.set("Otomobil", "Bus");
    eq(e.c.Price.value, "65.00", "broker Bus / 30, no card fee");
    eq(apiCalls, ["/tariffs/broker/7"], "broker tariffs only");
  });

  await check("a broker without tariffs falls back to the branch tariffs", async () => {
    const e = open(walkIn({ BrokerId: 8, PaymentType: "Broker" }));
    apiRoutes["/tariffs/broker/8"] = { brokerId: 8, pricing: {} };
    await e.set("Duration", 90);
    eq(e.c.Price.value, "110.00", "branch Auto / 90");
  });

  await check("the edited branch decides which walk-in tariffs apply", async () => {
    const e = open(walkIn());
    const other = "Офис Лесово";
    const url = `/tariffs/branch/${encodeURIComponent(other)}`;
    apiRoutes[url] = { branch: other, pricing: { Auto: { 15: 30 } } };
    e.c.Branch.value = other;
    await e.set("Duration", 15);
    eq(e.c.Price.value, "30.00", "other branch's price");
  });

  await check("the chosen options are shown as checkboxes with their stored state", async () => {
    open(walkIn({ PaymentType: "Card", NonTurk: 1, CardFee: 1 }));
    const n = lastSpec.find((s) => s.key === "NonTurk");
    const c = lastSpec.find((s) => s.key === "CardFee");
    eq(n && n.type, "checkbox", "non-Turk checkbox");
    eq(n.value, true, "non-Turk ticked");
    eq(c && c.type, "checkbox", "card fee checkbox");
    eq(c.value, true, "card fee ticked");
    eq(lastForm.controls.CardFee.disabled, false, "card fee enabled for card");
  });

  await check("unticked options are shown unticked", async () => {
    open(walkIn());
    eq(lastSpec.find((s) => s.key === "NonTurk").value, false, "non-Turk");
    eq(lastSpec.find((s) => s.key === "CardFee").value, false, "card fee");
  });

  await check("a cash policy has its card fee box locked", async () => {
    const e = open(walkIn({ CardFee: 1 }));
    eq(e.c.CardFee.checked, false, "unticked");
    eq(e.c.CardFee.disabled, true, "disabled");
  });

  await check("email policies show neither the non-Turk nor the card fee option", async () => {
    open(walkIn({ BrokerId: 7, PaymentType: "Broker", NonTurk: 1 }));
    eq(lastSpec.some((s) => s.key === "NonTurk"), false, "no non-Turk");
    eq(lastSpec.some((s) => s.key === "CardFee"), false, "no card fee");
    eq(lastSpec.some((s) => s.key === "PaymentType"), false, "no payment type");
  });

  await check("an email policy's recalculated price never includes the non-Turk tax", async () => {
    const e = open(walkIn({ BrokerId: 7, PaymentType: "Broker", NonTurk: 1 }));
    apiRoutes["/tariffs/broker/7"] = { brokerId: 7, pricing: BROKER_PRICING };
    await e.set("Duration", 15);
    eq(e.c.Price.value, "20.00", "broker Auto / 15, no +5");
  });

  await check("ticking non-Turk adds 5 to the current price", async () => {
    const e = open(walkIn({ Price: "47.30" }));
    e.c.NonTurk.checked = true;
    await e.c.NonTurk.fire("change");
    eq(e.c.Price.value, "52.30", "hand-set price kept + 5");
    eq(apiCalls, [], "no tariffs needed");
  });

  await check("unticking non-Turk takes the 5 off again", async () => {
    const e = open(walkIn({ Price: "50.00", NonTurk: 1 }));
    e.c.NonTurk.checked = false;
    await e.c.NonTurk.fire("change");
    eq(e.c.Price.value, "45.00", "50 - 5");
  });

  await check("ticking / unticking the card fee moves the price by 2", async () => {
    const e = open(walkIn({ PaymentType: "Card" }));
    e.c.CardFee.checked = true;
    await e.c.CardFee.fire("change");
    eq(e.c.Price.value, "47.00", "45 + 2");
    e.c.CardFee.checked = false;
    await e.c.CardFee.fire("change");
    eq(e.c.Price.value, "45.00", "back to 45");
  });

  await check("switching a card policy with a card fee to cash drops the fee", async () => {
    const e = open(walkIn({ PaymentType: "Card", CardFee: 1, Price: "47.00" }));
    await e.set("PaymentType", "Cash");
    eq(e.c.CardFee.checked, false, "card fee cleared");
    eq(e.c.CardFee.disabled, true, "card fee locked");
    eq(e.c.Price.value, "45.00", "47 - 2");
  });

  await check("switching cash to card unlocks the card fee without adding it", async () => {
    const e = open(walkIn());
    await e.set("PaymentType", "Card");
    eq(e.c.CardFee.disabled, false, "unlocked");
    eq(e.c.Price.value, "45.00", "unchanged");
  });

  await check("a toggled option is used by the tariff recalculation", async () => {
    const e = open(walkIn({ PaymentType: "Card" }));
    e.c.NonTurk.checked = true;
    await e.c.NonTurk.fire("change");
    e.c.CardFee.checked = true;
    await e.c.CardFee.fire("change");
    eq(e.c.Price.value, "52.00", "45 + 5 + 2");
    await e.set("Duration", 15);
    eq(e.c.Price.value, "32.00", "25 + 5 + 2");
    // After a recalculation the fees are not applied twice.
    e.c.NonTurk.checked = false;
    await e.c.NonTurk.fire("change");
    eq(e.c.Price.value, "27.00", "25 + 2");
  });

  await check("an empty price is not turned into a bare fee", async () => {
    const e = open(walkIn({ Price: "" }));
    e.c.NonTurk.checked = true;
    await e.c.NonTurk.fire("change");
    eq(e.c.Price.value, "", "still empty");
  });

  await check("no tariff for the combination keeps the price and warns", async () => {
    const e = open(walkIn());
    await e.set("Otomobil", "Trailer");
    eq(e.c.Price.value, "20.00", "Trailer / 30 exists");
    await e.set("Duration", 90);
    eq(e.c.Price.value, "20.00", "Trailer / 90 missing: unchanged");
    eq(toasts, ["error: edit.priceUnavailable"], "warning toast");
  });

  await check("a failed tariff request keeps the price and reports it", async () => {
    const e = open(walkIn());
    apiRoutes[BRANCH_URL] = new Error("boom");
    await e.set("Duration", 90);
    eq(e.c.Price.value, "45.00", "unchanged");
    eq(toasts, ["error: edit.pricingLoadFailed"], "error toast");
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
