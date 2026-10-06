"use strict";

// Node test for the "Reconcile daily report" feature.
//
// It runs the REAL production code (renderer/WorkPage/reconcile-core.js for the
// logic and renderer/WorkPage/xlsxReader.js for Excel parsing) inside a vm with
// browser-API polyfills, then exercises every use case against the real sample
// file ("FINANSOV OTCHET VTORI KOMP. 05.10.2026.xlsm") copied into this folder.
//
// Run with:  node Test/reconcile.test.js   (or: npm test)

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { DOMParser } = require("@xmldom/xmldom");

const ROOT = path.join(__dirname, "..");
const WORKPAGE = path.join(ROOT, "renderer", "WorkPage");

function loadIntoContext(file) {
  const src = fs.readFileSync(path.join(WORKPAGE, file), "utf8");
  vm.runInContext(src, CTX, { filename: file });
}

// --- shared context with browser polyfills -----------------------------------
const CTX = {
  DOMParser,
  Blob,
  DecompressionStream,
  Response,
  TextDecoder,
  DataView,
  Uint8Array,
  console,
};
vm.createContext(CTX);

loadIntoContext("xlsxReader.js");
loadIntoContext("reconcile-core.js");

const readXlsxFirstSheet = CTX.readXlsxFirstSheet;
const {
  reconFindColumns,
  reconParseFileRows,
  reconCompareRow,
  reconTermDays,
  reconFileDate,
  reconNormId,
  reconNormCar,
} = CTX;

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
  if (a !== b) throw new Error((msg || "values differ") + ` (got ${a}, want ${b})`);
}
function ok(cond, msg) {
  if (!cond) throw new Error(msg || "expected truthy");
}

const SAMPLE = path.join(
  __dirname,
  "FINANSOV OTCHET VTORI KOMP. 05.10.2026.xlsm"
);

(async () => {
  console.log("Reconcile daily report — tests");

  let rows = null;
  check("sample .xlsm file is present", () => {
    ok(fs.existsSync(SAMPLE), "sample file missing from Test/");
  });

  // Load and parse the real sample file before running the checks that depend
  // on it (readXlsxFirstSheet is async because it inflates ZIP entries).
  {
    const buf = fs.readFileSync(SAMPLE);
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    rows = await readXlsxFirstSheet(ab);
  }
  check("readXlsxFirstSheet parses the macro-enabled .xlsm", () => {
    ok(Array.isArray(rows) && rows.length > 0, "no rows returned");
  });

  check("header row is detected (shift-log layout)", () => {
    const cols = reconFindColumns(rows);
    eq(cols.missing, [], "unexpected missing columns");
    eq(cols.headerRow, 13, "header row index");
    eq(cols.index, { from: 0, car: 1, policy: 2, blank: 3, term: 4 });
  });

  let fileRows;
  check("rows parse with no missing valid-from/until", () => {
    const cols = reconFindColumns(rows);
    fileRows = reconParseFileRows(rows, cols.headerRow, cols.index);
    ok(fileRows.length > 0, "no data rows");
    eq(fileRows.filter((r) => !r.fromKey || !r.toKey).length, 0);
  });

  check("row count matches the report's own policy total (81)", () => {
    eq(fileRows.length, 81, "unexpected row count");
  });

  check("first row values + term-derived valid-until (3M -> +90 days)", () => {
    const first = fileRows[0];
    eq(first.rowNo, 15);
    eq(first.policy, "26167659");
    eq(first.blank, "149988");
    eq(first.car, "59ADJ391");
    eq(first.fromKey, "2026-10-05");
    eq(first.toKey, "2027-01-03");
  });

  check("15D term derives valid-until (15 days)", () => {
    eq(fileRows[1].toKey, "2026-10-20");
    eq(fileRows[1].toRaw, "15D");
  });

  check("1M term derives valid-until (30 days)", () => {
    const row = fileRows.find((r) => r.toRaw === "1M");
    ok(row, "no 1M row");
    eq(row.toKey, "2026-11-04");
  });

  check("term shorthand -> day count", () => {
    eq(reconTermDays("15D"), 15);
    eq(reconTermDays("1M"), 30);
    eq(reconTermDays("3M"), 90);
    eq(reconTermDays("1Y"), 365);
    eq(reconTermDays("90"), 90);
    eq(reconTermDays("xyz"), null);
    eq(reconTermDays(""), null);
  });

  check("date parsing (comma, dot, ISO, Excel serial)", () => {
    eq(reconFileDate("05,10,2026"), "2026-10-05");
    eq(reconFileDate("05.10.2026"), "2026-10-05");
    eq(reconFileDate("05/10/26"), "2026-10-05");
    eq(reconFileDate("2026-10-05"), "2026-10-05");
    eq(reconFileDate(45600), "2024-11-04");
    eq(reconFileDate("garbage"), "");
  });

  check("identifier normalisation ignores leading zeros", () => {
    eq(reconNormId("000789"), "789");
    eq(reconNormId(789), "789");
  });

  check("car number normalisation maps Cyrillic look-alikes", () => {
    eq(reconNormCar("СА 1234 АВ"), "CA1234AB");
    eq(reconNormCar("CA1234AB"), "CA1234AB");
  });

  check("full layout (old header names) still works", () => {
    const oldRows = [
      ["НОМЕР НА ПОЛИЦА", "НОМЕР НА СТИКЕР", "ВАЛИДЕН ОТ", "ВАЛИДЕН ДО", "ДКН"],
      ["POL-1", "BLK-1", "01.01.2026", "31.01.2026", "CA1234AB"],
      ["POL-2", "BLK-2", 45600, 45630, "CA5678BC"],
    ];
    const cols = reconFindColumns(oldRows);
    eq(cols.missing, [], "old layout should not be missing columns");
    eq(cols.index, { policy: 0, blank: 1, from: 2, to: 3, car: 4 });
    const parsed = reconParseFileRows(oldRows, cols.headerRow, cols.index);
    eq(parsed.length, 2);
    eq(parsed[0].fromKey, "2026-01-01");
    eq(parsed[0].toKey, "2026-01-31");
    eq(parsed[1].fromKey, "2024-11-04");
    eq(parsed[1].toKey, "2024-12-04");
  });

  check("unknown file reports missing required columns", () => {
    const cols = reconFindColumns([["Foo", "Bar", "Baz"], ["1", "2", "3"]]);
    eq(
      (cols.missing || []).map((c) => c.header),
      ["НОМЕР НА ПОЛИЦА", "НОМЕР НА СТИКЕР", "ВАЛИДЕН ОТ", "ВАЛИДЕН ДО", "ДКН"]
    );
  });

  check("row comparison: exact match (0 mismatches)", () => {
    const ins = {
      PolicyNumber: "26167659",
      BlancNumber: "149988",
      CarNumber: "59ADJ391",
      StartDate: "2026-10-05",
      Duration: 90,
    };
    eq(reconCompareRow(fileRows[0], ins).count, 0);
  });

  check("row comparison: mismatching car is detected", () => {
    const ins = {
      PolicyNumber: "26167659",
      BlancNumber: "149988",
      CarNumber: "99XXX000",
      StartDate: "2026-10-05",
      Duration: 90,
    };
    const cmp = reconCompareRow(fileRows[0], ins);
    eq(cmp.count, 1);
    eq(cmp.fields.car.mismatch, true);
  });

  check("row comparison: duration mismatch is detected (15D vs 90)", () => {
    const ins = {
      PolicyNumber: "26167659",
      BlancNumber: "149988",
      CarNumber: "59ADJ391",
      StartDate: "2026-10-05",
      Duration: 15,
    };
    const cmp = reconCompareRow(fileRows[0], ins);
    eq(cmp.count, 1);
    eq(cmp.fields.to.mismatch, true);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error("Test run crashed:", err);
  process.exit(1);
});
