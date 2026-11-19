"use strict";

// Wiring checks for the insurance lookup tab ("Insurances by date" for admins,
// "Insurances" for workers).
//
// The view builds a lot of DOM and talks to the API, so these checks pin the
// pieces that are easy to lose in a refactor without running a browser:
//   - the Broker ID filter exists, is sent as ?brokerCode and is matched
//     locally while an older server ignores it;
//   - the Broker ID column is sortable (the sort list itself is tested in
//     insuranceSort.test.cjs);
//   - the search state (filters, rows, sort) is saved and restored across tab
//     changes, and clearing the form forgets it;
//   - the Author / Broker / Broker ID inputs use the suggestions endpoint;
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

const src = fs.readFileSync(WORKPAGE_JS, "utf8");
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

check("the Broker ID filter is part of the search form", () => {
  ok(src.includes('const brokerIdInput = input("text"'));
  ok(src.includes('field(t("brokerIdFilter"), brokerIdInput)'));
});

check("the Broker ID filter is sent and matched locally", () => {
  ok(src.includes('params.set("brokerCode", brokerCode)'));
  ok(
    src.includes("String(r.BrokerCode") && src.includes(".includes(wanted)"),
    "the older-server fallback filters the fetched rows by BrokerCode"
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

check("Author / Broker / Broker ID have autocomplete", () => {
  ok(src.includes("function attachAutocomplete("), "visible dropdown helper");
  eq(
    (src.match(/attachAutocomplete\(/g) || []).length,
    4,
    "one definition + three fields"
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

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
