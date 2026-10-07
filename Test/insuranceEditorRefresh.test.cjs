"use strict";

// Node test for the "edit an insurance" modal's refresh wiring.
//
// Correcting the price or the payment type of an old policy moves money on the
// server (current cash / card balance), so the list that offered the edit has to
// show the new values straight away instead of waiting for a manual reload.
// openInsuranceEditor therefore
//   - adopts the row the server returns after the PATCH (so a view rendering
//     from its local rows shows the new price/payment type immediately), and
//   - calls the `onDone` callback its caller passes - render() in "Insurances",
//     runSearch() in "Insurances by date" / "My insurances".
//
// openInsuranceEditor lives in renderer/WorkPage/WorkPage.js, which touches the
// DOM the moment it is loaded. So - like insuranceSort.test.cjs - this test cuts
// that ONE function out of the REAL file and runs it in a vm with the handful of
// helpers it uses (buildForm / openModal / closeModal / toast / t / api)
// stubbed. The production code is what gets exercised; if the function is ever
// moved or renamed the marker below stops matching and the test fails loudly
// instead of silently testing nothing.
//
// Run with:  node Test/insuranceEditorRefresh.test.cjs   (or: npm test)

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const WORKPAGE_JS = path.join(ROOT, "renderer", "WorkPage", "WorkPage.js");

const START_MARKER = "function openInsuranceEditor(insurance, onDone) {";

const src = fs.readFileSync(WORKPAGE_JS, "utf8");
const start = src.indexOf(START_MARKER);
if (start < 0) {
  console.error(
    "Could not locate openInsuranceEditor in WorkPage.js (renamed or moved?)"
  );
  process.exit(1);
}
// Everything inside the function is indented, so the first "}" at column 0
// after the marker is the one that closes it. (WorkPage.js uses CRLF, hence the
// \r? in the pattern.)
const tail = src.slice(start);
const closing = /\r?\n\}\r?\n/.exec(tail);
if (!closing) {
  console.error("Could not find the end of openInsuranceEditor");
  process.exit(1);
}
const block = tail.slice(0, closing.index + closing[0].length);

// --- fakes -------------------------------------------------------------------
let apiCalls = [];
let toasts = [];
let modalTitles = [];
let closedCount = 0;
let doneCalls = [];
let submitHandler = null;
let lastSpec = null;
// What the stubbed api() resolves/rejects with for the next save.
let apiResponse = null;
let apiError = null;

const CTX = {
  console,
  t: (key) => key,
  buildForm: (spec, onSubmit, submitLabel) => {
    lastSpec = spec;
    submitHandler = onSubmit;
    return { __form: true, submitLabel };
  },
  openModal: (title) => {
    modalTitles.push(title);
  },
  closeModal: () => {
    closedCount++;
  },
  toast: (message, kind) => {
    toasts.push(`${kind}: ${message}`);
  },
  api: async (url, opts) => {
    apiCalls.push({ url, opts });
    if (apiError) throw new Error(apiError);
    return apiResponse;
  },
};
vm.createContext(CTX);
vm.runInContext(block, CTX, { filename: "WorkPage.js#openInsuranceEditor" });

if (typeof CTX.openInsuranceEditor !== "function") {
  console.error("openInsuranceEditor did not load - block markers changed?");
  process.exit(1);
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

const storedRow = () => ({
  BlancNumber: "1234567",
  PolicyNumber: "P-001",
  Price: "100.00",
  CurrencyType: "EUR",
  Duration: 365,
  Branch: "Офис Харманли",
  Otomobil: "Лек автомобил",
  StartDate: "2026-10-01",
  PaymentType: "Cash",
  Annulled: 0,
});

// Opens the editor for a fresh row and returns everything the test needs: the
// row itself, the captured submit handler and the recorded onDone calls.
function open(row, response, onDone) {
  apiCalls = [];
  toasts = [];
  modalTitles = [];
  closedCount = 0;
  doneCalls = [];
  submitHandler = null;
  lastSpec = null;
  apiError = null;
  apiResponse =
    response === undefined
      ? { message: "Insurance updated", insurance: { ...row } }
      : response;

  const wrapped = onDone
    ? (data) => {
        doneCalls.push(data);
        onDone(data);
      }
    : undefined;
  CTX.openInsuranceEditor(row, wrapped);
  return {
    row,
    save: (payload) => submitHandler(payload),
    done: () => doneCalls,
    specValue: (key) => {
      const entry = (lastSpec || []).find((s) => s.key === key);
      return entry ? entry.value : undefined;
    },
  };
}

(async () => {
  console.log("openInsuranceEditor — refresh wiring");

  await check("the modal opens for the policy being edited", async () => {
    const e = open(storedRow());
    eq(modalTitles, ["editInsurance 1234567"], "modal title");
    ok(typeof e.save === "function", "a submit handler was registered");
  });

  await check("the form is pre-filled with the stored values", async () => {
    const e = open(storedRow());
    eq(e.specValue("Price"), "100.00", "price");
    eq(e.specValue("PaymentType"), "Cash", "payment type");
    eq(e.specValue("Branch"), "Офис Харманли", "branch");
    eq(e.specValue("CurrencyType"), "EUR", "currency");
  });

  await check("saving PATCHes the policy with the edited values", async () => {
    const e = open(storedRow());
    await e.save({ Price: 120, PaymentType: "Card" });
    eq(apiCalls.length, 1, "one request");
    eq(apiCalls[0].url, "/insurances/1234567", "endpoint");
    eq(apiCalls[0].opts.method, "PATCH", "method");
    eq(
      JSON.parse(apiCalls[0].opts.body),
      { Price: 120, PaymentType: "Card" },
      "body"
    );
  });

  await check("saving adopts the row the server returns", async () => {
    const row = storedRow();
    const e = open(row, {
      message: "Insurance updated",
      insurance: { ...row, Price: "120.00", PaymentType: "Card" },
    });
    await e.save({ Price: 120, PaymentType: "Card" });
    eq(e.row.Price, "120.00", "the row the table renders from has the new price");
    eq(e.row.PaymentType, "Card", "and the new payment type");
  });

  await check("saving asks the calling view to refresh", async () => {
    let refreshed = 0;
    const e = open(storedRow(), undefined, () => {
      refreshed++;
    });
    await e.save({ Price: 120 });
    eq(refreshed, 1, "onDone ran once");
    eq(e.done().length, 1, "and received the response");
    ok(e.done()[0] && e.done()[0].insurance, "response handed to onDone");
  });

  await check("saving closes the modal and reports success", async () => {
    const e = open(storedRow());
    await e.save({ Price: 120 });
    eq(closedCount, 1, "modal closed");
    eq(toasts, ["success: insuranceUpdated"], "toast");
  });

  await check("an older server that omits the row still refreshes the view", async () => {
    let refreshed = 0;
    const e = open(storedRow(), { message: "Insurance updated" }, () => {
      refreshed++;
    });
    await e.save({ Price: 120 });
    eq(e.row.Price, "100.00", "the local row is left as it was");
    eq(refreshed, 1, "so the view re-reads it from the server instead");
  });

  await check("the editor still works without a refresh callback", async () => {
    const e = open(storedRow());
    await e.save({ Price: 120 });
    eq(closedCount, 1, "modal closed");
    eq(e.done().length, 0, "nothing to call");
  });

  await check("a failed save leaves the modal open and does not refresh", async () => {
    let refreshed = 0;
    const e = open(storedRow(), undefined, () => {
      refreshed++;
    });
    apiError = "insufficient current cash for reduction";
    let threw = false;
    try {
      await e.save({ Price: 120 });
    } catch (err) {
      threw = true;
      eq(
        err.message,
        "insufficient current cash for reduction",
        "the server's reason must reach buildForm so it can toast it"
      );
    }
    ok(threw, "the failure must propagate to buildForm");
    eq(closedCount, 0, "the modal stays open");
    eq(refreshed, 0, "no refresh");
    eq(e.row.Price, "100.00", "the row is untouched");
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
