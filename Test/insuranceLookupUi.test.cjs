"use strict";

// Wiring checks for the insurance lookup tab ("Insurances by date" for admins,
// "Insurances" for workers).
//
// The view builds a lot of DOM and talks to the API, so these checks pin the
// pieces that are easy to lose in a refactor without running a browser:
//   - there is no separate Broker ID input: a broker ID typed in the Broker
//     field is matched locally as well, while an older server ignores it;
//   - the Broker ID column is sortable (the sort list itself is tested in
//     insuranceSort.test.cjs);
//   - the search state (filters, rows, sort) is saved and restored across tab
//     changes, and clearing the form forgets it;
//   - the Author / Broker inputs use the suggestions endpoint;
//   - a search shows a spinner while it runs, then says how many results came
//     back, that none did, or that the result is unchanged, with a short
//     result animation;
//   - the broker balance history renders the movement author.
//
// Run with:  node Test/insuranceLookupUi.test.cjs   (or: npm test)

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const WORKPAGE_JS = path.join(ROOT, "renderer", "WorkPage", "WorkPage.js");
const WORKPAGE_CSS = path.join(ROOT, "renderer", "WorkPage", "WorkPage.css");
const APP_CSS = path.join(ROOT, "renderer", "app.css");
const COMMON_JS = path.join(ROOT, "renderer", "common.js");

// Normalised to LF so the multi-line checks below match on every checkout
// (the renderer files are stored with CRLF).
const src = fs.readFileSync(WORKPAGE_JS, "utf8").replace(/\r\n/g, "\n");
const css = fs.readFileSync(WORKPAGE_CSS, "utf8");
const appCss = fs.readFileSync(APP_CSS, "utf8");
const common = fs.readFileSync(COMMON_JS, "utf8");

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
function ok(cond, msg) {
  if (!cond) throw new Error(msg || "expected truthy");
}
function eq(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b)
    throw new Error((msg || "values differ") + ` (got ${a}, want ${b})`);
}

console.log("Insurance lookup — Broker ID, autocomplete and persisted search");

check("there is no separate Broker ID input anymore", () => {
  ok(!src.includes('const brokerIdInput = input("text"'));
  ok(!src.includes('field(t("brokerIdFilter"), brokerIdInput)'));
  ok(src.includes('field(t("broker"), brokerInput)'), "the Broker field stays");
  ok(!src.includes('params.set("brokerCode"'), "no brokerCode request parameter");
});

check("a broker ID typed in the Broker field is matched locally", () => {
  ok(src.includes("function brokerCodeMatchesQuery(code, query) {"));
  ok(
    src.includes("brokerCodeMatchesQuery(r.BrokerCode, broker)"),
    "the older-server fallback matches the fetched rows by BrokerCode too"
  );
});

check("the Broker ID column is sortable", () => {
  ok(
    src.includes('key: "BrokerCode", label: t("brokerIdFilter"), ...sortHeader("BrokerCode")'),
    "BrokerCode column header has the sort handler"
  );
});

check("the search state is saved and restored across tab changes", () => {
  ok(src.includes("insuranceSearchStates.get(titleKey)"));
  ok(src.includes("insuranceSearchStates.set(titleKey"));
  ok(src.includes("insuranceSearchStates.delete(titleKey)"));
  ok(src.includes("if (hasSearched) renderResults();"));
  ok(
    src.includes("rows: lastRows") && src.includes("sort: { ...insuranceSort }"),
    "rows and sort are part of the snapshot"
  );
});

check("typing alone keeps the filters for the next visit", () => {
  ok(
    src.includes(
      '].forEach((inp) => inp.addEventListener("input", rememberSearch));'
    ),
    "text inputs remember their value without pressing Load"
  );
  ok(src.includes('paymentInput.addEventListener("change", rememberSearch)'));
  ok(src.includes('annulledInput.addEventListener("change", rememberSearch)'));
});

check("Author / Broker have autocomplete", () => {
  ok(src.includes("function attachAutocomplete("), "visible dropdown helper");
  eq(
    (src.match(/attachAutocomplete\(/g) || []).length,
    4,
    "one definition + the lookup's two fields + the reconcile Broker field"
  );
  ok(src.includes('inputNode.addEventListener("focus", open)'));
  ok(src.includes("loadInsuranceFilterSuggestions"));
  ok(src.includes('api("/brokers")'), "older-server broker fallback");
  ok(
    src.includes('api("/admin/users?includeDeleted=1")'),
    "older-server author fallback"
  );
  ok(css.includes(".autocomplete-list"), "dropdown style");
});

check("the broker balance history shows the author", () => {
  const start = src.indexOf("function renderBrokerHistory(");
  const end = src.indexOf(
    "// Restore a previously soft-deleted broker movement",
    start
  );
  ok(start >= 0 && end > start, "renderBrokerHistory block not found");
  const block = src.slice(start, end);
  const hits = block.match(/key: "Author"/g) || [];
  eq(hits.length, 2, "live movements and deleted movements both show it");
});

check("the broker balance history tints annulled policies", () => {
  const start = src.indexOf("function renderBrokerHistory(");
  const end = src.indexOf(
    "// Restore a previously soft-deleted broker movement",
    start
  );
  ok(start >= 0 && end > start, "renderBrokerHistory block not found");
  const block = src.slice(start, end);
  // The server merges the sale and refund of an annulled policy into one row
  // whose Amount is the tax, so the page keeps its normal Amount column and
  // only adds the shared annulled row tint.
  ok(!block.includes('key: "PolicyPrice"'), "no separate price column is added");
  ok(
    block.includes("annulledRowClass({"),
    "annulled movements reuse the insurance tabs' row tint"
  );
  ok(
    block.includes("Annulled: m.PolicyAnnulled") &&
      block.includes("AnnulReason: m.PolicyAnnulReason"),
    "the tint knows the policy and who paid the tax"
  );
});

check("the lookup shows live search feedback", () => {
  ok(src.includes('setSearchStatus("searching", t("searching"))'));
  ok(src.includes('setSearchStatus("empty", t("searchNoResults"))'));
  ok(src.includes('setSearchStatus("done", t("searchUnchanged"))'));
  ok(src.includes('fmt(t("searchFound"), { n: rows.length })'));
  ok(src.includes("flashSearchResults();"), "the result container is animated");
  ok(
    src.includes("searchStatus,"),
    "the status line is rendered with the results"
  );
  ok(src.includes("apply.disabled = true;") && src.includes("apply.disabled = false;"));
});

check("the feedback has a spinner and short animations", () => {
  ok(css.includes(".search-spinner"), "spinner style");
  ok(css.includes("@keyframes search-spin"), "spin keyframes");
  ok(css.includes(".search-status-text"), "status text style");
  ok(css.includes(".search-result-flash"), "result flash style");
  ok(css.includes("prefers-reduced-motion"), "animations respect reduced motion");
});

check("the new labels exist in both languages", () => {
  eq((common.match(/brokerIdFilter:/g) || []).length, 2, "brokerIdFilter");
  for (const key of [
    "searching",
    "searchFound",
    "searchNoResults",
    "searchUnchanged",
  ]) {
    eq(
      (common.match(new RegExp(`\\b${key}:`, "g")) || []).length,
      2,
      `${key} in EN and BG`
    );
  }
});

check("the balance history shows the starting balance and lets an admin set it", () => {
  const start = src.indexOf("function renderBrokerHistory(");
  const end = src.indexOf(
    "// Restore a previously soft-deleted broker movement",
    start
  );
  ok(start >= 0 && end > start, "renderBrokerHistory block not found");
  const block = src.slice(start, end);
  ok(
    block.includes('t("startingBalance")') &&
      block.includes('t("startingBalanceNotSet")'),
    "the label and its value are rendered"
  );
  ok(
    block.includes("brokerStartingBalanceForm(broker, starting"),
    "clicking the value opens the editor"
  );
  ok(
    block.includes('t("startingBalanceDate")') &&
      block.includes("starting.date"),
    "the starting balance date is shown"
  );
  // The date is a plain calendar day: it is shown as dd-mm-yyyy, not as the
  // server's YYYY-MM-DD and without a time.
  ok(
    block.includes("formatDateOnly(starting.date)"),
    "the starting balance date uses the dd-mm-yyyy format"
  );
  // Only admins may change it; workers and broker clients just read it.
  ok(
    block.includes('if (userRole === "1")') &&
      block.indexOf('if (userRole === "1")') <
        block.indexOf("brokerStartingBalanceForm(broker, starting"),
    "the value is a link button for admins only"
  );
  ok(
    src.includes('api(`/brokers/${broker.id}/starting-balance`') &&
      src.includes('method: "PUT"'),
    "saving goes to PUT /brokers/:id/starting-balance"
  );
  for (const key of [
    "startingBalance",
    "startingBalanceNotSet",
    "startingBalanceDate",
    "startingBalanceHint",
    "startingBalanceSaved",
  ]) {
    eq(
      (common.match(new RegExp(`\\b${key}:`, "g")) || []).length,
      2,
      `${key} in EN and BG`
    );
  }
  // Next to the total of the shown movements stands the balance at the end of
  // the shown day, so the day's money and where the broker stood can be read
  // together.
  ok(
    block.includes('t("total")') &&
      block.includes('t("balanceAtDayEnd")') &&
      block.includes("money(balanceAtEnd)"),
    "the end-of-day balance sits next to the total"
  );
  for (const key of ["balanceAtDayEnd", "balanceAtDayEndHint"]) {
    eq(
      (common.match(new RegExp(`\\b${key}:`, "g")) || []).length,
      2,
      `${key} in EN and BG`
    );
  }
});

check("the history total sums the amounts on the shown page", () => {
  // The helper is pure, so it is cut out of the real WorkPage.js and run in a vm
  // (the file itself touches the DOM the moment it is loaded).
  const start = src.indexOf("function sumDisplayedBrokerAmounts(");
  const end = src.indexOf("// Pagination controls", start);
  ok(start >= 0 && end > start, "sumDisplayedBrokerAmounts block not found");
  const ctx = { console };
  vm.createContext(ctx);
  vm.runInContext(
    src.slice(start, end),
    ctx,
    { filename: "WorkPage.js#sumDisplayedBrokerAmounts" }
  );
  const sum = ctx.sumDisplayedBrokerAmounts;
  ok(typeof sum === "function", "the page-total helper is defined");

  eq(
    sum([{ Amount: 100 }, { Amount: -30.5 }, { Amount: "20" }]),
    89.5,
    "every amount on the page is summed"
  );
  eq(
    sum([{ Amount: 100 }, { Amount: -5, Retired: true }]),
    100,
    "retired rows stay out of the total (retiredMovementNote)"
  );
  eq(sum([]), 0, "an empty page totals 0");
  eq(sum(undefined), 0, "a missing page totals 0");

  // The total row is fed from the displayed page, not from the server's
  // netChange (which covers the whole scoped range, even with no date picked).
  const viewStart = src.indexOf("function renderBrokerHistory(");
  const viewEnd = src.indexOf(
    "// Restore a previously soft-deleted broker movement",
    viewStart
  );
  ok(viewStart >= 0 && viewEnd > viewStart, "renderBrokerHistory block not found");
  const block = src.slice(viewStart, viewEnd);
  ok(
    block.includes("sumDisplayedBrokerAmounts(data.movements)"),
    "the total is read off the shown movements"
  );
  ok(
    block.includes('`${t("total")}: ${signedMoney(pageTotal)}`'),
    "the total row shows the page sum"
  );
});

check("retired broker movements are tagged and stand out", () => {
  const start = src.indexOf("function renderBrokerHistory(");
  const end = src.indexOf(
    "// Restore a previously soft-deleted broker movement",
    start
  );
  ok(start >= 0 && end > start, "renderBrokerHistory block not found");
  const block = src.slice(start, end);
  ok(src.includes("function movementTypeCell("), "the Type cell helper exists");
  ok(block.includes("movementTypeCell(v, m)"), "the Type cell uses the helper");
  ok(block.includes("row-broker-retired"), "the retired row class is applied");
  ok(block.includes('t("retiredMovementNote")'), "the page explains the tag");
  ok(
    block.includes('t(m.Retired ? "deleteRetiredMovementConfirm" : "deleteMovementConfirm")'),
    "the delete confirmation explains that a retired row leaves the balance"
  );
  ok(
    src.includes('t(\n        movement && movement.Retired\n          ? "restoreRetiredMovementConfirm"'),
    "the restore confirmation mentions retired rows"
  );
  ok(appCss.includes(".movement-retired-tag"), "the tag has a style");
  ok(appCss.includes("tr.row-broker-retired"), "the row has a tint");
  ok(appCss.includes(".pagination.pagination-top"), "the top pager has a style");
});

check("the history pager sits above and below the table", () => {
  const start = src.indexOf("function renderBrokerHistory(");
  const end = src.indexOf(
    "// Restore a previously soft-deleted broker movement",
    start
  );
  ok(start >= 0 && end > start, "renderBrokerHistory block not found");
  const block = src.slice(start, end);
  ok(block.includes('buildPagers("pagination-top")'), "a pager above the table");
  ok(block.includes("...buildPagers()"), "a pager below the table");
  ok(
    block.indexOf('buildPagers("pagination-top")') < block.indexOf("table,"),
    "the top pager comes before the table"
  );
});

check("retired movement strings exist in EN and BG", () => {
  for (const key of [
    "retiredTag",
    "retiredTagHint",
    "retiredMovementNote",
    "deleteRetiredMovementConfirm",
    "restoreRetiredMovementConfirm",
  ]) {
    eq(
      (common.match(new RegExp(`\\b${key}:`, "g")) || []).length,
      2,
      `${key} in EN and BG`
    );
  }
});

check("dates are rendered as dd-mm-yyyy (with the time when there is one)", () => {
  const commonSrc = common.replace(/\r\n/g, "\n");
  function cutFunction(name) {
    const start = commonSrc.indexOf(`function ${name}(value) {`);
    const end = commonSrc.indexOf("\n}\n", start);
    ok(start >= 0 && end > start, `${name} is defined in common.js`);
    return commonSrc.slice(start, end + 3);
  }
  const dateOnly = new Function(
    `${cutFunction("formatDateOnly")}return formatDateOnly;`
  )();
  eq(dateOnly("2026-10-01"), "01-10-2026", "a stored calendar day");
  eq(
    dateOnly("2026-10-01 00:00:00"),
    "01-10-2026",
    "a stored DATETIME keeps its day"
  );
  eq(dateOnly("2005-01-09"), "09-01-2005", "the year is never truncated");
  eq(dateOnly(new Date(2026, 10, 20)), "20-11-2026", "a Date object");
  eq(dateOnly(""), "", "nothing to show");
  eq(dateOnly(null), "", "nothing to show for null");

  const dateTime = new Function(
    `${cutFunction("formatDateTime")}return formatDateTime;`
  )();
  eq(dateTime("2026-10-01 14:05:06"), "01-10-2026 14:05", "a DATETIME");
  eq(dateTime("2026-10-01T14:05:06"), "01-10-2026 14:05", "an ISO datetime");
  eq(
    dateTime(new Date(2026, 10, 20, 9, 7)),
    "20-11-2026 09:07",
    "a Date object"
  );
  eq(dateTime(""), "", "nothing to show");
});

check("the brokers table has no Reduce action any more", () => {
  // A balance is raised only by money the broker paid (Increase / Hand over)
  // and falls as policies are created; the old rows stay as history, so their
  // label must survive in both languages.
  ok(!src.includes('brokerAdjust(broker, "reduce")'), "no reduce button");
  ok(
    !src.includes("broker-adjust-reduce") && !css.includes("broker-adjust-reduce"),
    "no reduce button style either"
  );
  ok(
    src.includes('brokerAdjust(broker, "increase")') &&
      src.includes('brokerAdjust(broker, "handover")'),
    "top-ups and hand-overs stay"
  );
  eq(
    (common.match(/movement\.reduce/g) || []).length,
    2,
    "the reduce label is kept for historical rows (EN and BG)"
  );
});

check("a broker's balance cannot be typed in the edit form", () => {
  const start = src.indexOf("async function brokerEditForm(");
  const end = src.indexOf("// Compact", start);
  ok(start >= 0 && end > start, "brokerEditForm block not found");
  const block = src.slice(start, end);
  // The balance is calculated from the starting balance, the policies and the
  // payments, so the form no longer offers it (that field wrote an "adjust"
  // row). Creating a broker with a balance is still possible.
  ok(!block.includes('key: "CashBalance"'), "no balance field in the editor");
  ok(
    block.includes('key: "Name"') && block.includes('key: "emails"'),
    "name and emails are still editable"
  );
  ok(
    src.includes('key: "CashBalance",\n        label: t("startingBalance")'),
    "a new broker is created with a starting balance"
  );
});

check("a picked day steps the pager instead of disabling it", () => {
  ok(src.includes("function dayPagerControls(date, onDate)"), "day pager");
  // The date-scoped history is a single page, so the pager walks the calendar
  // day by day; the plain pagination stays for the whole history and for a day
  // that needs more than one page.
  ok(
    src.includes("dayPagerControls(date, (d) =>") &&
      src.includes("if (data.totalPages > 1)") &&
      src.includes("pagerControls(data.totalPages, page, (p) =>"),
    "the pager switches to day stepping when a date is picked"
  );
  ok(
    src.includes("onDate(previousLocalDate(date))") &&
      src.includes("onDate(nextLocalDate(date))"),
    "Previous / Next change the date"
  );
  ok(
    src.includes("next.disabled = date >= localDateString();"),
    "the walk stops at today"
  );
});

check("the table shows the policy's duration next to the numbers", () => {
  ok(
    src.includes('key: "Duration",\n            label: t("add.duration"),'),
    "Duration column with the shared label"
  );
  ok(
    src.includes("format: (v) => insuranceDurationLabel(v),"),
    "same 15D / 1M / 3M shorthand as the Excel export"
  );
  ok(
    src.includes('...sortHeader("Duration"),'),
    "the Duration header sorts the list"
  );
});

check("edit / annul only appear while a row is hovered", () => {
  ok(
    src.includes("{ revealActions: true }"),
    "the insurance table reveals its action buttons on hover"
  );
  ok(
    src.includes("openInsuranceEditorFor(i, () => runSearch())"),
    "the edit button opens the editor through the lookup-refreshing helper"
  );
});

check("admins can change the author and the broker of a policy", () => {
  ok(src.includes('key: "Author",\n      label: t("author"),'), "author field");
  ok(
    src.includes('key: "BrokerId",\n      label: t("broker"),'),
    "broker field"
  );
  ok(
    src.includes("function loadInsuranceEditLookups()") &&
      src.includes('api("/admin/users")'),
    "the author list comes from the accounts"
  );
  ok(
    src.includes("function editBrokerOptions(insurance)"),
    "the broker dropdown is built from the brokers list"
  );
  for (const key of [
    "onlyAdminAuthor",
    "onlyAdminBroker",
    "brokerChangeAnnulled",
    "authorRequired",
    "authorNotFound",
  ]) {
    eq(
      (common.match(new RegExp(`"err.${key}":`, "g")) || []).length,
      2,
      `${key} in EN and BG`
    );
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
