"use strict";

// Node test for the sortable insurance lookup table ("My insurances" for
// workers, "Insurances by date" for admins).
//
// The sorting helpers (insuranceSortValue / compareInsuranceValues /
// sortInsuranceRows) are pure, but they live in renderer/WorkPage/WorkPage.js,
// which touches the DOM the moment it is loaded. So this test cuts that block
// out of the REAL file — from the `let insuranceSort = ...` declaration up to
// the `adminInsurancesByDate` view that uses it — and runs it in a vm. The
// production code is what gets exercised; only its DOM-dependent surroundings
// are skipped. If the block is ever moved or renamed the markers below stop
// matching and the test fails loudly instead of silently testing nothing.
//
// Run with:  node Test/insuranceSort.test.cjs   (or: npm test)

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const WORKPAGE_JS = path.join(ROOT, "renderer", "WorkPage", "WorkPage.js");

const START_MARKER = 'let insuranceSort = { key: null, dir: "desc" };';
const END_MARKER = "\nasync function adminInsurancesByDate";

const src = fs.readFileSync(WORKPAGE_JS, "utf8");
const start = src.indexOf(START_MARKER);
const end = src.indexOf(END_MARKER);
if (start < 0 || end < 0 || end <= start) {
  console.error(
    "Could not locate the insurance sorting helpers in WorkPage.js " +
      "(markers moved?)"
  );
  process.exit(1);
}

// --- shared context (no DOM needed: the helpers are pure) --------------------
const CTX = { console };
vm.createContext(CTX);
vm.runInContext(
  // `const`/`let` stay inside the script scope, so the key list is published
  // explicitly (function declarations land on the context object by themselves).
  src.slice(start, end) + "\n;globalThis.SORT_KEYS = INSURANCE_SORT_KEYS;",
  CTX,
  { filename: "WorkPage.js#insuranceSort" }
);

const { sortInsuranceRows, insuranceSortValue } = CTX;
const SORT_KEYS = CTX.SORT_KEYS;

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
function ok(cond, msg) {
  if (!cond) throw new Error(msg || "expected truthy");
}

// Rows shaped exactly like the /insurances response (SELECT * FROM insurance).
// The array order is the server order: newest first.
const row = (
  BlancNumber,
  Price,
  CreationDate,
  Broker,
  Author,
  Annulled,
  PaymentType
) => ({ BlancNumber, Price, CreationDate, Broker, Author, Annulled, PaymentType });

const ROWS = [
  row("B1", 120.5, "2026-10-05T09:15:00.000Z", "Euroins", "Petko", 0, "Card"),
  row("B2", 9, "2026-10-04 18:40:00", "", "anna", 1, "Cash"),
  row("B3", 1500, "2026-10-03T07:05:00.000Z", "Булстрад", "Petko", 0, "Cash"),
  row("B4", 250, "2026-10-02T21:30:00.000Z", "Euroins", "Ivan", 0, "Card"),
  row("B5", 45, "2026-10-01T06:00:00.000Z", null, "anna", 1, "Cash"),
  row("B6", 9, "2026-09-30T12:00:00.000Z", "Армеец", "Boyan", 0, "Card"),
];

const ids = (rows) => rows.map((r) => r.BlancNumber);
const sorted = (key, dir, rows) =>
  ids(sortInsuranceRows(rows || ROWS, key, dir));

console.log("Insurance lookup sorting — tests");

check("every requested column is sortable", () => {
  eq(SORT_KEYS, [
    "Price",
    "CreationDate",
    "Broker",
    "Author",
    "Annulled",
    "PaymentType",
  ]);
});

check("no sort key keeps the server order (newest first)", () => {
  eq(sorted(null, "desc"), ["B1", "B2", "B3", "B4", "B5", "B6"]);
});

check("a column that is not sortable is ignored", () => {
  eq(sorted("CarNumber", "asc"), ["B1", "B2", "B3", "B4", "B5", "B6"]);
});

check("price sorts numerically, not as text", () => {
  // Lexicographic order would put 1500 before 250 and 9 last.
  eq(sorted("Price", "desc"), ["B3", "B4", "B1", "B5", "B2", "B6"]);
  eq(sorted("Price", "asc"), ["B2", "B6", "B5", "B1", "B4", "B3"]);
});

check("creation date sorts chronologically (ISO and MySQL strings)", () => {
  eq(sorted("CreationDate", "desc"), ["B1", "B2", "B3", "B4", "B5", "B6"]);
  eq(sorted("CreationDate", "asc"), ["B6", "B5", "B4", "B3", "B2", "B1"]);
});

check("status: annulled first on desc, active first on asc", () => {
  eq(sorted("Annulled", "desc"), ["B2", "B5", "B1", "B3", "B4", "B6"]);
  eq(sorted("Annulled", "asc"), ["B1", "B3", "B4", "B6", "B2", "B5"]);
});

check("payment type groups Card / Cash", () => {
  eq(sorted("PaymentType", "asc"), ["B1", "B4", "B6", "B2", "B3", "B5"]);
  eq(sorted("PaymentType", "desc"), ["B2", "B3", "B5", "B1", "B4", "B6"]);
});

check("author sorts alphabetically and case-insensitively", () => {
  eq(sorted("Author", "asc"), ["B2", "B5", "B6", "B4", "B1", "B3"]);
  eq(sorted("Author", "desc"), ["B1", "B3", "B4", "B6", "B2", "B5"]);
});

check("blank broker (walk-in policy) stays last in both directions", () => {
  const brokerRows = [
    { BlancNumber: "X1", Broker: "" },
    { BlancNumber: "X2", Broker: "Euroins" },
    { BlancNumber: "X3", Broker: null },
    { BlancNumber: "X4", Broker: "Armeets" },
    { BlancNumber: "X5", Broker: "Euroins" },
  ];
  eq(sorted("Broker", "asc", brokerRows), ["X4", "X2", "X5", "X1", "X3"]);
  eq(sorted("Broker", "desc", brokerRows), ["X2", "X5", "X4", "X1", "X3"]);
});

check("Cyrillic broker names sort by alphabet", () => {
  const cyr = [
    { BlancNumber: "C1", Broker: "Булстрад" },
    { BlancNumber: "C2", Broker: "Армеец" },
  ];
  eq(sorted("Broker", "asc", cyr), ["C2", "C1"]);
});

check("equal values keep the server order (stable sort)", () => {
  // B2 and B6 both cost 9 and B2 arrives first from the server.
  const asc = sorted("Price", "asc");
  ok(asc.indexOf("B2") < asc.indexOf("B6"), "B2 should stay before B6");
});

check("the fetched rows are never mutated in place", () => {
  const before = ids(ROWS);
  sortInsuranceRows(ROWS, "Price", "asc");
  eq(ids(ROWS), before);
});

check("missing input yields an empty list", () => {
  eq(sortInsuranceRows(undefined, "Price", "desc"), []);
  eq(sortInsuranceRows(null, "Price", "desc"), []);
});

check("cell values: numbers, timestamps, text and blanks", () => {
  eq(insuranceSortValue({ Price: "120.50" }, "Price"), 120.5);
  eq(insuranceSortValue({ Annulled: 0 }, "Annulled"), 0);
  eq(insuranceSortValue({ Annulled: "1" }, "Annulled"), 1);
  eq(insuranceSortValue({ PaymentType: "Cash" }, "PaymentType"), "Cash");
  eq(insuranceSortValue({ Broker: "" }, "Broker"), null);
  eq(insuranceSortValue({ Broker: null }, "Broker"), null);
  eq(insuranceSortValue({}, "Broker"), null);
  eq(insuranceSortValue({ Price: "abc" }, "Price"), null);
  const expected = new Date(2026, 9, 5, 9, 15).getTime();
  eq(
    insuranceSortValue(
      { CreationDate: "2026-10-05T09:15:00.000Z" },
      "CreationDate"
    ),
    expected,
    "ISO datetime"
  );
  eq(
    insuranceSortValue({ CreationDate: "2026-10-05 09:15:00" }, "CreationDate"),
    expected,
    "MySQL datetime"
  );
  eq(
    insuranceSortValue(
      { CreationDate: new Date(2026, 9, 5, 9, 15) },
      "CreationDate"
    ),
    expected,
    "Date object"
  );
  eq(insuranceSortValue({ CreationDate: "n/a" }, "CreationDate"), null);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

