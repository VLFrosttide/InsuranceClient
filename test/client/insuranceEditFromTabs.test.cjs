"use strict";

// Node test for editing an INSURANCE from the rows of another tab: the broker
// balance history, the Current cash ledger and the Reconcile daily report
// (renderer/WorkPage/WorkPage.js).
//
// Each of those tables lists rows that belong to a policy. Their hover "Edit
// insurance" action has to correct the policy itself - never the ledger row -
// and it has to open the stored insurance the row is tied to, even when the row
// only carries its blanc number (a broker movement).
//
// The helpers are lifted out of the REAL file and run in a vm with `api`,
// `toast` and `openInsuranceEditorFor` stubbed; the call sites are checked in
// the source so a tab that forgets the action fails here.
//
// Run with:  node test/client/insuranceEditFromTabs.test.cjs   (or: npm test)

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..", "..");
const WORKPAGE_JS = path.join(ROOT, "renderer", "WorkPage", "WorkPage.js");
const APP_CSS = path.join(ROOT, "renderer", "app.css");
const src = fs.readFileSync(WORKPAGE_JS, "utf8");
const appCss = fs.readFileSync(APP_CSS, "utf8");

const START = "// Editing the insurance behind a row of another tab";
const END = "// `onDone` (optional) runs after a successful save so the calling view can";
const start = src.indexOf(START);
const end = start < 0 ? -1 : src.indexOf(END, start);
if (start < 0 || end < 0) {
  console.error("Could not locate the edit-from-a-row helpers in WorkPage.js (moved?)");
  process.exit(1);
}
const helperBlock = src.slice(src.lastIndexOf("\n// ---", start) + 1, end);

// --- stubs -------------------------------------------------------------------
let apiCalls = [];
let apiError = null;
let apiAnswer = { insurances: [] };
let toasts = [];
let opened = [];

const CTX = {
  // console.warn is used for the expected "lookup failed" fallback below.
  console: { log: console.log, warn: () => {}, error: console.error },
  api: async (url) => {
    apiCalls.push(url);
    if (apiError) throw new Error(apiError);
    return apiAnswer;
  },
  toast: (message, kind) => toasts.push(`${kind}: ${message}`),
  t: (key) => key,
  translateError: (message) => `translated(${message})`,
  openInsuranceEditorFor: async (insurance, onDone) => {
    opened.push({ insurance, onDone });
    return "opened";
  },
};
vm.createContext(CTX);
vm.runInContext(helperBlock, CTX, { filename: "WorkPage.js#editInsuranceFromRow" });

for (const name of [
  "insuranceByBlancNumber",
  "rowCarriesPolicy",
  "openInsuranceEditorForRow",
]) {
  if (typeof CTX[name] !== "function") {
    console.error(name + " did not load - block markers changed?");
    process.exit(1);
  }
}
const { insuranceByBlancNumber, rowCarriesPolicy, openInsuranceEditorForRow } =
  CTX;

// movementHasInsurance() is pure as well: cut it out with its type set.
const MOVE_START = "// Movement types the server writes FROM a policy";
const MOVE_END = "// Label for a broker balance movement type";
const moveStart = src.indexOf(MOVE_START);
const moveEnd = moveStart < 0 ? -1 : src.indexOf(MOVE_END, moveStart);
if (moveStart < 0 || moveEnd < 0) {
  console.error("Could not locate movementHasInsurance in WorkPage.js (moved?)");
  process.exit(1);
}
const moveCtx = { console };
vm.createContext(moveCtx);
vm.runInContext(src.slice(moveStart, moveEnd), moveCtx, {
  filename: "WorkPage.js#movementHasInsurance",
});
const { movementHasInsurance } = moveCtx;
if (typeof movementHasInsurance !== "function") {
  console.error("movementHasInsurance did not load - block markers changed?");
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
function ok(value, msg) {
  if (!value) throw new Error(msg || "expected a truthy value");
}
function reset() {
  apiCalls = [];
  apiError = null;
  apiAnswer = { insurances: [] };
  toasts = [];
  opened = [];
}

(async () => {
  console.log("Insurance — editing the policy from another tab's row");

  // --- the lookup ------------------------------------------------------------
  await check("the policy is looked up by its blanc number", async () => {
    reset();
    apiAnswer = { insurances: [{ BlancNumber: "149990", Price: 45 }] };
    const found = await insuranceByBlancNumber(" 149990 ");
    eq(apiCalls, ["/insurances?blancNumber=149990"], "one request, trimmed");
    eq(found.BlancNumber, "149990", "the stored policy");
  });

  await check("a partial blanc match is not mistaken for the row", async () => {
    reset();
    apiAnswer = {
      insurances: [{ BlancNumber: "1499901" }, { BlancNumber: "149990" }],
    };
    const found = await insuranceByBlancNumber("149990");
    eq(found.BlancNumber, "149990", "the exact blanc wins");
  });

  await check("a numeric blanc number still finds its policy", async () => {
    reset();
    // MySQL hands some columns back as numbers; the comparison is on text.
    apiAnswer = { insurances: [{ BlancNumber: 149990 }] };
    const found = await insuranceByBlancNumber("149990");
    eq(found.BlancNumber, 149990, "number and text agree");
  });

  await check("an empty blanc number is not looked up", async () => {
    reset();
    eq(await insuranceByBlancNumber("   "), null, "nothing is asked");
    eq(apiCalls, [], "no request");
  });

  // --- opening the editor ----------------------------------------------------
  await check("a broker movement opens the POLICY, not the movement", async () => {
    reset();
    const movement = {
      id: 7,
      Type: "policy",
      BlancNumber: "149990",
      Amount: -45,
      PolicyBrokerId: 2,
    };
    const policy = { BlancNumber: "149990", Price: 45, Branch: "ГКПП Лесово" };
    apiAnswer = { insurances: [policy] };
    const onDone = () => {};
    const result = await openInsuranceEditorForRow(movement, onDone);

    eq(apiCalls, ["/insurances?blancNumber=149990"], "the stored policy is read");
    eq(opened.length, 1, "the editor was opened once");
    eq(opened[0].insurance, policy, "with the stored policy");
    eq(opened[0].onDone, onDone, "the caller's refresh is passed on");
    eq(result, "opened", "the editor's promise is returned");
    eq(toasts, [], "no error");
  });

  await check("a row that already holds the policy still re-reads it", async () => {
    reset();
    const row = {
      BlancNumber: "149990",
      Kind: "border",
      Duration: 15,
      Price: 45,
    };
    const policy = { BlancNumber: "149990", Kind: "border", Duration: 30 };
    apiAnswer = { insurances: [policy] };
    await openInsuranceEditorForRow(row);
    eq(opened[0].insurance, policy, "the CURRENT stored row wins over the copy");
  });

  await check("a failed lookup still opens the row's own copy", async () => {
    reset();
    apiError = "socket hang up";
    const row = { BlancNumber: "149990", Kind: "border", Duration: 15 };
    await openInsuranceEditorForRow(row);
    eq(toasts, [], "no error is shown");
    eq(opened[0].insurance, row, "the local policy opens");
  });

  await check("a failed lookup of a bare movement reports the error", async () => {
    reset();
    apiError = "socket hang up";
    await openInsuranceEditorForRow({ id: 7, BlancNumber: "149990" });
    eq(opened, [], "nothing opens");
    eq(toasts, ["error: errorPrefix: translated(socket hang up)"], "toast");
  });

  await check("a policy missing from the database is reported", async () => {
    reset();
    apiAnswer = { insurances: [] };
    await openInsuranceEditorForRow({ id: 7, BlancNumber: "149990" });
    eq(opened, [], "nothing opens");
    eq(toasts, ["error: err.insuranceNotFound"], "toast");
  });

  await check("a row without a blanc number opens nothing", async () => {
    reset();
    await openInsuranceEditorForRow({ Type: "increase", Amount: 100 });
    eq(apiCalls, [], "no request");
    eq(opened, [], "no editor");
    eq(toasts, ["error: err.insuranceNotFound"], "toast");
  });

  await check("rowCarriesPolicy tells a policy from a bare ledger row", () => {
    ok(rowCarriesPolicy({ BlancNumber: "1", Kind: "border" }), "Kind");
    ok(rowCarriesPolicy({ BlancNumber: "1", Duration: 15 }), "Duration");
    ok(!rowCarriesPolicy({ BlancNumber: "1" }), "a bare blanc is not enough");
    ok(!rowCarriesPolicy({ Kind: "border" }), "no blanc, no policy");
    ok(!rowCarriesPolicy(null), "no row");
  });

  // --- which broker movements belong to a policy -----------------------------
  await check("a policy-derived movement has an insurance", () => {
    ok(
      movementHasInsurance({ Type: "policy", BlancNumber: "149990" }),
      "the sale row"
    );
    for (const type of ["price_change", "annulment", "deletion"]) {
      ok(
        movementHasInsurance({ Type: type, BlancNumber: "149990" }),
        type + " is policy-derived"
      );
    }
  });

  await check("a money row has no insurance", () => {
    ok(
      !movementHasInsurance({ Type: "increase", Amount: 100 }),
      "a top-up"
    );
    ok(!movementHasInsurance({ Type: "handover", Recipient: "Ivan" }), "hand-over");
    ok(!movementHasInsurance(null), "no movement");
  });

  await check("a live policy is enough, whatever the movement type", () => {
    // The server fills PolicyBrokerId from the insurance the row belongs to.
    ok(
      movementHasInsurance({
        Type: "adjust",
        BlancNumber: "149990",
        PolicyBrokerId: 2,
      }),
      "a manually typed blanc that resolves to a policy"
    );
    ok(
      !movementHasInsurance({ Type: "adjust", BlancNumber: "149990" }),
      "an unresolved blanc is left read-only"
    );
  });

  // --- the three tabs use it -------------------------------------------------
  await check("the broker history offers the hover Edit on a policy row", () => {
    const viewStart = src.indexOf("function renderBrokerHistory(");
    const viewEnd = src.indexOf(
      "// Restore a previously soft-deleted broker movement",
      viewStart
    );
    ok(viewStart >= 0 && viewEnd > viewStart, "renderBrokerHistory block");
    const block = src.slice(viewStart, viewEnd);
    ok(
      block.includes("if (movementHasInsurance(m))"),
      "only the rows of a policy get it"
    );
    ok(
      block.includes('label: t("editInsurance")') &&
        block.includes("hover: true") &&
        block.includes('icon: "✎"'),
      "a hover pencil labelled Edit insurance"
    );
    ok(
      block.includes("openInsuranceEditorForRow(m, refreshHistory)"),
      "it opens the policy and refreshes the history"
    );
    ok(
      block.includes("const refreshHistory = () =>") &&
        block.includes("brokerHistoryView(broker, page, date, includeDeleted)"),
      "the refresh re-reads the same page"
    );
    // Workers see the action as well: the movement's own admin actions stay
    // admin-only, but correcting the policy is what their row shows.
    ok(
      block.indexOf("if (movementHasInsurance(m))") <
        block.indexOf('if (userRole !== "1") return rowActions;'),
      "the insurance edit is added before the admin-only actions"
    );
  });

  await check("the Current cash ledger edits its policy rows", () => {
    const viewStart = src.indexOf("async function currentCashView(");
    ok(viewStart >= 0, "the Current cash view exists");
    const block = src.slice(viewStart, src.indexOf("\n}\n", viewStart));
    ok(
      block.includes("const policyRowActions = (policy) =>"),
      "one shared action builder"
    );
    ok(
      block.includes(
        "openInsuranceEditorForRow(policy, () => currentCashView(branch, date))"
      ),
      "the editor is opened for the policy row and the screen is rebuilt"
    );
    ok(
      block.includes('if (tx.Source === "insurance" && String(tx.BlancNumber ?? "").trim())') &&
        block.includes("rowActions.push(...policyRowActions(tx))"),
      "a policy row of the combined Transactions table gets it"
    );
    // The two policy lists (walk-in cash and card) get the same action.
    eq(
      (block.match(/^\s*policyRowActions,$/gm) || []).length,
      2,
      "the cash and card policy lists pass the action builder"
    );
    // The drawer's own rows keep their own Edit/Delete; a policy never gets the
    // transaction editor, which would send its money to the wrong place.
    ok(
      block.indexOf('if (tx.Source !== "cash") return rowActions;') >
        block.indexOf("rowActions.push(...policyRowActions(tx))"),
      "a policy row returns before the drawer actions"
    );
  });

  await check("the broker history has only the hover insurance editor", () => {
    const viewStart = src.indexOf("function renderBrokerHistory(");
    const viewEnd = src.indexOf(
      "// Restore a previously soft-deleted broker movement",
      viewStart
    );
    const block = src.slice(viewStart, viewEnd);
    ok(
      block.includes("openInsuranceEditorForRow(m, refreshHistory)"),
      "a policy row opens the policy editor on hover"
    );
    ok(
      !block.includes(
        "brokerHistoryEditForm(broker, m, page, date, includeDeleted)"
      ),
      "the always-visible movement Edit is gone"
    );
    ok(
      !/rowActions\.push\(\s*\{\s*label: t\("edit"\)/.test(block),
      "no non-hover Edit button is pushed for an admin"
    );
  });

  await check("the reconcile report keeps the matched policy on a mismatch", () => {
    ok(
      src.includes(
        "else mismatches.push({ rowNo: fileRow.rowNo, ...best.cmp.fields, insurance: best.ins });"
      ),
      "the mismatch carries the insurance it was compared with"
    );
  });

  await check("the reconcile results offer the hover Edit on their rows", () => {
    const viewStart = src.indexOf("const reconTableSort = {");
    const viewEnd = src.indexOf("\n// The last reconciled report, kept in memory.");
    ok(viewStart >= 0 && viewEnd > viewStart, "the results block");
    const block = src.slice(viewStart, viewEnd);
    ok(
      block.includes("function reconRenderResults(result, onInsuranceEdited)"),
      "the screen takes the refresh callback"
    );
    ok(
      block.includes(
        "openInsuranceEditorForRow(item.insurance, onInsuranceEdited)"
      ),
      "the row's own policy is edited, and the report is refreshed"
    );
    ok(
      block.includes("insurance: ins,"),
      "a policy missing from the file carries the insurance"
    );
    ok(
      block.includes("actionsFor(missingFileRows)") &&
        block.includes("actionsFor(result.mismatches)"),
      "both database tables pass the action"
    );
    ok(
      !block.includes("actionsFor(missingDbRows)") &&
        !block.includes("actionsFor(result.missingFromDb)"),
      "a row the database does not have stays read-only"
    );
  });

  await check("the reconcile tab re-runs the report after an edit", () => {
    const viewStart = src.indexOf("async function reconcileView() {");
    ok(viewStart >= 0, "reconcileView block");
    const block = src.slice(viewStart, src.indexOf("\n}\n", viewStart));
    ok(
      block.includes("const refreshReport = () =>"),
      "a refresh callback is built"
    );
    ok(
      block.includes("runReconcile(cached.file, runBtn)"),
      "it re-checks the same file"
    );
    eq(
      (
        block.match(
          /reconRenderResults\((?:reconcileCache\.report|report), refreshReport\)/g
        ) || []
      ).length,
      2,
      "the restored report and a fresh run both get it"
    );
  });

  await check("the hover pencil has its own hover colour", () => {
    ok(
      appCss.includes("button.row-hover-x.edit:hover") &&
        appCss.includes("color: var(--accent);"),
      "the edit icon hovers in the accent colour"
    );
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
