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

const ROOT = path.join(__dirname, "..");
const WORKPAGE_JS = path.join(ROOT, "renderer", "WorkPage", "WorkPage.js");
const WORKPAGE_CSS = path.join(ROOT, "renderer", "WorkPage", "WorkPage.css");
const COMMON_JS = path.join(ROOT, "renderer", "common.js");

// Normalised to LF so the multi-line checks below match on every checkout
// (the renderer files are stored with CRLF).
const src = fs.readFileSync(WORKPAGE_JS, "utf8").replace(/\r\n/g, "\n");
const css = fs.readFileSync(WORKPAGE_CSS, "utf8");
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
    3,
    "one definition + two fields"
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
