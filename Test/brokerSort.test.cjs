"use strict";

// Node test for the brokers table sorting helpers (brokerSortValue /
// sortBrokerRows). The helpers are pure, but they live in
// renderer/WorkPage/WorkPage.js, which touches the DOM the moment it is loaded.
// So this test cuts that block out of the REAL file — from the
// `let brokerSort = ...` declaration up to the brokerHasNoEmail helper — and
// runs it in a vm. If the block is ever moved or renamed the markers below stop
// matching and the test fails loudly instead of silently testing nothing.
//
// Run with:  node Test/brokerSort.test.cjs   (or: npm test)

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const WORKPAGE_JS = path.join(ROOT, "renderer", "WorkPage", "WorkPage.js");

const START_MARKER = 'let brokerSort = { key: null, dir: "desc" };';
const END_MARKER = "\n// The whole row is flagged when the broker has no email.";

const src = fs.readFileSync(WORKPAGE_JS, "utf8");
const start = src.indexOf(START_MARKER);
const end = src.indexOf(END_MARKER);
if (start < 0 || end < 0 || end <= start) {
  console.error(
    "Could not locate the broker sorting helpers in WorkPage.js " +
      "(markers moved?)"
  );
  process.exit(1);
}

// --- shared context (no DOM needed: the helpers are pure) --------------------
const CTX = { console };
vm.createContext(CTX);
vm.runInContext(src.slice(start, end), CTX, {
  filename: "WorkPage.js#brokerSort",
});

const { sortBrokerRows, brokerSortValue } = CTX;

// --- tiny assert helper ------------------------------------------------------
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

// Rows shaped like the /brokers response. The array order is the server order.
const broker = (Name, Code, CashBalance, InactivePolicies) => ({
  Name,
  Code,
  CashBalance,
  InactivePolicies,
});

const rows = (list, key, dir) =>
  sortBrokerRows(list, key, dir).map((b) => b.Name);

// --- broker ID sorting -------------------------------------------------------
check("dotted IDs sort by value: 1.12 before 1.9", () => {
  const list = [
    broker("nine", "1.9", 0, 0),
    broker("twelve", "1.12", 0, 0),
  ];
  eq(rows(list, "Code", "asc"), ["twelve", "nine"]);
  eq(rows(list, "Code", "desc"), ["nine", "twelve"]);
});

check("comma IDs sort by value too: 1,12 before 1,9", () => {
  const list = [
    broker("nine", "1,9", 0, 0),
    broker("twelve", "1,12", 0, 0),
  ];
  eq(rows(list, "Code", "asc"), ["twelve", "nine"], "ascending");
  eq(rows(list, "Code", "desc"), ["nine", "twelve"], "descending");
});

check("a mix of dot and comma IDs sorts by the same value", () => {
  const list = [
    broker("comma-nine", "1,9", 0, 0),
    broker("dot-twelve", "1.12", 0, 0),
    broker("dot-two", "1.2", 0, 0),
    broker("whole-two", "2", 0, 0),
  ];
  eq(rows(list, "Code", "asc"), ["dot-twelve", "dot-two", "comma-nine", "whole-two"]);
  eq(rows(list, "Code", "desc"), ["whole-two", "comma-nine", "dot-two", "dot-twelve"]);
});

check("numeric IDs still sort numerically (2 before 10)", () => {
  const list = [
    broker("ten", "10", 0, 0),
    broker("two", "2", 0, 0),
  ];
  eq(rows(list, "Code", "asc"), ["two", "ten"]);
});

check("non-decimal IDs fall back to text order", () => {
  const list = [
    broker("a10", "A1.10", 0, 0),
    broker("a2", "A1.2", 0, 0),
  ];
  eq(rows(list, "Code", "asc"), ["a2", "a10"]);
});

check("brokers without an ID stay last in both directions", () => {
  const list = [
    broker("none", "", 0, 0),
    broker("nine", "1.9", 0, 0),
    broker("null", null, 0, 0),
    broker("twelve", "1.12", 0, 0),
  ];
  eq(rows(list, "Code", "asc"), ["twelve", "nine", "none", "null"]);
  eq(rows(list, "Code", "desc"), ["nine", "twelve", "none", "null"]);
});

// --- other columns -----------------------------------------------------------
check("balance sorts numerically", () => {
  const list = [
    broker("neg", "1", -5, 0),
    broker("big", "2", 100, 0),
    broker("zero", "3", 0, 0),
  ];
  eq(rows(list, "CashBalance", "desc"), ["big", "zero", "neg"]);
  eq(rows(list, "CashBalance", "asc"), ["neg", "zero", "big"]);
});

check("inactive policies sort numerically", () => {
  const list = [
    broker("forty", "1", 0, 40),
    broker("five", "2", 0, 5),
  ];
  eq(rows(list, "InactivePolicies", "asc"), ["five", "forty"]);
});

check("equal values keep the server order (stable sort)", () => {
  const list = [
    broker("first", "1.1", 0, 0),
    broker("second", "1.10", 0, 0),
  ];
  eq(rows(list, "Code", "asc"), ["first", "second"]);
});

check("the fetched rows are never mutated in place", () => {
  const list = [
    broker("nine", "1.9", 0, 0),
    broker("twelve", "1.12", 0, 0),
  ];
  sortBrokerRows(list, "Code", "asc");
  eq(list.map((b) => b.Name), ["nine", "twelve"]);
});

check("missing input yields an empty list", () => {
  eq(sortBrokerRows(undefined, "Code", "asc"), []);
  eq(sortBrokerRows(null, "Code", "asc"), []);
});

// --- extracted values --------------------------------------------------------
check("cell values: IDs, numbers and blanks", () => {
  eq(brokerSortValue("1.9", "Code"), 1.9);
  eq(brokerSortValue("1,9", "Code"), 1.9);
  eq(brokerSortValue("1,12", "Code"), 1.12);
  eq(brokerSortValue("2", "Code"), 2);
  eq(brokerSortValue("A1", "Code"), "A1");
  eq(brokerSortValue(-5, "CashBalance"), -5);
  eq(brokerSortValue("-5", "CashBalance"), -5);
  eq(brokerSortValue("", "Code"), null);
  eq(brokerSortValue(null, "Code"), null);
  eq(brokerSortValue(undefined, "Code"), null);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
