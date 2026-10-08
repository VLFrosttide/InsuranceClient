"use strict";

// Node test for the "Insurances by date" Excel export.
//
// Runs the REAL renderer/WorkPage/xlsxWriter.js inside a vm, builds a workbook
// and reads it back with the REAL renderer/WorkPage/xlsxReader.js (the same
// reader the reconcile feature uses), so the produced file is checked to be a
// valid ZIP/OOXML workbook with the expected cells. The generated file is also
// written to the OS temp folder so it can be opened in Excel by hand.
//
// Run with:  node Test/insuranceExport.test.cjs   (or: npm test)

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { DOMParser } = require("@xmldom/xmldom");

const ROOT = path.join(__dirname, "..");
const WORKPAGE = path.join(ROOT, "renderer", "WorkPage");

const CTX = {
  DOMParser,
  Blob,
  DecompressionStream,
  Response,
  TextDecoder,
  TextEncoder,
  DataView,
  Uint8Array,
  Uint32Array,
  console,
};
vm.createContext(CTX);
for (const file of ["xlsxReader.js", "xlsxWriter.js"]) {
  const src = fs.readFileSync(path.join(WORKPAGE, file), "utf8");
  vm.runInContext(src, CTX, { filename: file });
}
const { buildXlsxFile, xlsxDateSerial, readXlsxFirstSheet } = CTX;

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

const toArrayBuffer = (u8) =>
  u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);

(async () => {
  console.log("Insurance Excel export — tests");

  const created = new Date(2026, 9, 5, 9, 15);
  const serial = xlsxDateSerial(created);
  const bytes = buildXlsxFile({
    sheetName: "Застраховки",
    columns: [
      { label: "№", width: 6 },
      { label: "Бланка №" },
      { label: "Цена" },
      { label: "Създадена" },
      { label: "Брокер" },
    ],
    rows: [
      [1, "0012345", { value: 120.5, style: "money" }, { value: serial, style: "date" }, "Евроинс & Co <x>"],
      [2, "B2", { value: 9, style: "money" }, "", ""],
      [3, "B3", "", { value: null, style: "date" }, null],
    ],
  });

  const outFile = path.join(
    require("os").tmpdir(),
    "insurances_export_sample.xlsx"
  );
  fs.writeFileSync(outFile, bytes);
  console.log("  sample written to " + outFile);

  await check("output starts with a ZIP local header", () => {
    eq([bytes[0], bytes[1], bytes[2], bytes[3]], [0x50, 0x4b, 0x03, 0x04]);
  });

  let rows;
  await check("the reader parses the generated workbook", async () => {
    rows = await readXlsxFirstSheet(toArrayBuffer(bytes));
    ok(Array.isArray(rows), "no rows");
    eq(rows.length, 4, "header + 3 data rows");
  });

  await check("header row holds the labels (Cyrillic preserved)", () => {
    eq(rows[0], ["№", "Бланка №", "Цена", "Създадена", "Брокер"]);
  });

  await check("row numbers, text with leading zeros, numbers, escaping", () => {
    eq(rows[1][0], 1);
    eq(rows[1][1], "0012345", "text cells keep leading zeros");
    eq(rows[1][2], 120.5);
    eq(rows[1][4], "Евроинс & Co <x>");
    eq(rows[2][0], 2);
    eq(rows[3][0], 3);
  });

  await check("dates are stored as Excel serials of the local time", () => {
    eq(rows[1][3], serial);
    // 2026-10-05 09:15 local -> 46300 + 9.25/24
    eq(Math.floor(serial), 46300);
    ok(Math.abs((serial % 1) - 9.25 / 24) < 1e-9, "time fraction");
  });

  await check("empty values produce empty cells", () => {
    eq(rows[2][3] ?? "", "");
    eq(rows[3][2] ?? "", "");
    eq(rows[3][3] ?? "", "");
  });

  await check("xlsxDateSerial rejects invalid dates", () => {
    eq(xlsxDateSerial(new Date("nope")), null);
    eq(xlsxDateSerial("2026-10-05"), null);
  });

  await check("an empty export still yields a readable workbook", async () => {
    const empty = buildXlsxFile({ sheetName: "", columns: [], rows: [] });
    const r = await readXlsxFirstSheet(toArrayBuffer(empty));
    ok(Array.isArray(r), "not parsed");
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
