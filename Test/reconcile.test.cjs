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
  reconRequiredColumns,
  reconCompareRow,
  reconTermDays,
  reconFileDate,
  reconDateRange,
  reconDateInRange,
  reconNormId,
  reconNormPolicy,
  reconNormCar,
  reconParseCompareFields,
  reconToggleCompareField,
  reconIsCompareFieldEnabled,
  reconIsCompareFieldChecked,
  reconFileFields,
  reconPrice,
  reconShowDuration,
  reconShowPrice,
  reconHintRows,
} = CTX;

// Top-level `const`s are not properties of the vm's global object, so the
// column/compare tables are read with an expression instead.
const {
  RECON_COMPARE_FIELDS,
  RECON_COMPARE_STORAGE_KEY,
  RECON_COLUMNS,
  RECON_TERM_COLUMN,
} = vm.runInContext(
  "({ RECON_COMPARE_FIELDS, RECON_COMPARE_STORAGE_KEY, RECON_COLUMNS, RECON_TERM_COLUMN })",
  CTX
);

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
    // "СРОК" is the duration column and also derives the end date; "ТАРИФА"
    // is the price column of this report layout.
    eq(cols.index, {
      from: 0,
      car: 1,
      policy: 2,
      blank: 3,
      duration: 4,
      price: 8,
    });
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
    // The term is kept as written and parsed into the day count the database
    // stores, and the "ТАРИФА" column is read as the price.
    eq(first.durationRaw, "3M");
    eq(first.durationDays, 90);
    eq(first.priceRaw, "0");
    eq(first.price, 0);
  });

  check("15D term derives valid-until (15 days)", () => {
    eq(fileRows[1].toKey, "2026-10-20");
    eq(fileRows[1].toRaw, "15D");
    eq(fileRows[1].durationDays, 15);
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

  check("a day count is written back as the report's shorthand", () => {
    eq(reconShowDuration(15), "15D");
    eq(reconShowDuration(30), "1M");
    eq(reconShowDuration(90), "3M");
    // Any other stored value keeps its day count.
    eq(reconShowDuration(45), "45D");
    eq(reconShowDuration(365), "365D");
    eq(reconShowDuration(null), "");
    eq(reconShowDuration(""), "");
    eq(reconShowDuration("xyz"), "");
  });

  check("price parsing accepts dot / comma decimals and currency text", () => {
    eq(reconPrice(45), 45);
    eq(reconPrice(45.5), 45.5);
    eq(reconPrice("45"), 45);
    eq(reconPrice("45.50"), 45.5);
    eq(reconPrice("45,50"), 45.5);
    eq(reconPrice("1 234,56"), 1234.56);
    eq(reconPrice("1.234,56"), 1234.56);
    eq(reconPrice("1,234.56"), 1234.56);
    eq(reconPrice("45,50 лв."), 45.5);
    eq(reconPrice("45,50 €"), 45.5);
    eq(reconPrice("45.50 TL"), 45.5);
    eq(reconPrice("45.50 EUR"), 45.5);
    eq(reconPrice("EUR 45.50"), 45.5);
    eq(reconPrice("-12,5"), -12.5);
    eq(reconPrice(0), 0, "a zero price is a real value");
    eq(reconPrice(""), null);
    eq(reconPrice("n/a"), null);
    eq(reconPrice(null), null);
  });

  check("a price is shown with at most two decimals", () => {
    eq(reconShowPrice("45,50"), "45.5");
    eq(reconShowPrice("45.567"), "45.57");
    eq(reconShowPrice(12), "12");
    eq(reconShowPrice(""), "");
    // Unreadable text is shown as written instead of being hidden.
    eq(reconShowPrice("n/a"), "n/a");
  });

  check("date parsing (comma, dot, ISO, Excel serial)", () => {
    eq(reconFileDate("05,10,2026"), "2026-10-05");
    eq(reconFileDate("05.10.2026"), "2026-10-05");
    eq(reconFileDate("05/10/26"), "2026-10-05");
    eq(reconFileDate("2026-10-05"), "2026-10-05");
    eq(reconFileDate(45600), "2024-11-04");
    eq(reconFileDate("garbage"), "");
  });

  check("a created-on range covers both ends, inclusive", () => {
    const range = reconDateRange("2026-10-05", "2026-10-07");
    eq(range, { from: "2026-10-05", to: "2026-10-07" });
    ok(reconDateInRange("2026-10-05", range), "first day");
    ok(reconDateInRange("2026-10-06", range), "day inside");
    ok(reconDateInRange("2026-10-06 09:14:00", range), "day inside, with time");
    ok(reconDateInRange("2026-10-07", range), "last day");
    ok(!reconDateInRange("2026-10-04", range), "before the range");
    ok(!reconDateInRange("2026-10-08", range), "after the range");
    ok(!reconDateInRange("", range), "no creation date");
  });

  check("one day is a range of one day", () => {
    const range = reconDateRange("2026-10-05", "2026-10-05");
    eq(range, { from: "2026-10-05", to: "2026-10-05" });
    ok(reconDateInRange("2026-10-05", range), "that day");
    ok(!reconDateInRange("2026-10-06", range), "the next day is outside");
  });

  check("a reversed range is swapped, not ignored", () => {
    // Both dates are typed in the wrong order: the same two days are checked.
    eq(reconDateRange("2026-10-07", "2026-10-05"), {
      from: "2026-10-05",
      to: "2026-10-07",
    });
  });

  check("one side may be left open", () => {
    const fromOnly = reconDateRange("2026-10-05", "");
    eq(fromOnly, { from: "2026-10-05", to: "" });
    ok(reconDateInRange("2027-01-01", fromOnly), "no upper bound");
    ok(!reconDateInRange("2026-10-04", fromOnly), "still bounded below");
    const toOnly = reconDateRange("", "2026-10-07");
    eq(toOnly, { from: "", to: "2026-10-07" });
    ok(reconDateInRange("2020-01-01", toOnly), "no lower bound");
    ok(!reconDateInRange("2026-10-08", toOnly), "still bounded above");
  });

  check("clearing both dates switches the check off", () => {
    const range = reconDateRange("", "");
    eq(range, { from: "", to: "" });
    ok(!reconDateInRange("2026-10-05", range), "nothing is in an empty range");
  });

  check("identifier normalisation ignores leading zeros", () => {
    eq(reconNormId("000789"), "789");
    eq(reconNormId(789), "789");
  });

  check("policy normalisation cuts the BG/02/FI report prefix", () => {
    eq(reconNormPolicy("BG/02/FI 26167659"), "26167659");
    eq(reconNormPolicy("bg/02/fi-000789"), "789");
    eq(reconNormPolicy("BG / 02 / FI 26167659"), "26167659");
    eq(reconNormPolicy("26167659"), "26167659");
    // Only the prefix is special: the policy itself must still match exactly.
    ok(reconNormPolicy("BG/02/FI 26167660") !== "26167659");
  });

  check("parsed file value drops the BG/02/FI report prefix", () => {
    const prefixedRows = [
      ["НОМЕР НА ПОЛИЦА", "НОМЕР НА СТИКЕР", "ВАЛИДЕН ОТ", "ВАЛИДЕН ДО", "ДКН"],
      ["BG/02/FI 26167659", "149988", "05.10.2026", "03.01.2027", "59ADJ391"],
    ];
    const cols = reconFindColumns(prefixedRows);
    const parsed = reconParseFileRows(
      prefixedRows,
      cols.headerRow,
      cols.index
    );
    eq(parsed[0].policy, "26167659");
  });

  check("prefixed file policy matches the database policy", () => {
    const ins = {
      PolicyNumber: "26167659",
      BlancNumber: "149988",
      CarNumber: "59ADJ391",
      StartDate: "2026-10-05",
      Duration: 90,
      Price: "0",
    };
    const prefixed = { ...fileRows[0], policy: "BG/02/FI 26167659" };
    eq(reconCompareRow(prefixed, ins).count, 0);
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

  check("English and transliterated headers are accepted for policy / blank / car", () => {
    // Every spelling RECON_COLUMNS advertises must really be matched, with the
    // other two columns using the canonical Bulgarian headers so only the alias
    // under test is exercised. Case, spaces and punctuation are normalised away,
    // so the reports' "No, POLITSA" / "No, BLANKA" labels and a few variants are
    // checked as well.
    const cases = {
      policy: [
        "Policy number",
        "PolicyNumber",
        "Policy",
        "policy_number",
        "POLICY-NUMBER",
        "POLITSA",
        "No POLITSA",
        "No, POLITSA",
        "No. POLITSA",
        "No ПОЛИЦА",
        "No. ПОЛИЦА",
      ],
      blank: [
        "Blanc",
        "Blanc Number",
        "BlancNumber",
        "Blank",
        "BlankNumber",
        "Number Blanc",
        "NumberBlanc",
        "blanc number",
        "BLANKA",
        "No BLANKA",
        "No, BLANKA",
        "No БЛАНКА",
        "No. БЛАНКА",
      ],
      car: [
        "Car number",
        "Number Car",
        "Car Plate",
        "Plate number",
        "Number Plate",
        "NumberPlate",
        "DKN",
        "dkn",
      ],
    };
    const canonical = {
      policy: "НОМЕР НА ПОЛИЦА",
      blank: "НОМЕР НА СТИКЕР",
      car: "ДКН",
    };
    for (const key of Object.keys(cases)) {
      for (const alias of cases[key]) {
        const headers = { ...canonical, [key]: alias };
        const englishRows = [
          ["ДАТА", headers.policy, headers.blank, headers.car, "СРОК"],
          ["05.10.2026", "BG/02/FI 26167659", "149988", "59ADJ391", "3M"],
        ];
        const cols = reconFindColumns(englishRows);
        const where = `${key} = "${alias}"`;
        eq(cols.missing, [], `missing columns for ${where}`);
        eq(
          cols.index,
          { from: 0, policy: 1, blank: 2, car: 3, duration: 4 },
          `column map for ${where}`
        );
        const parsed = reconParseFileRows(
          englishRows,
          cols.headerRow,
          cols.index
        );
        eq(
          [parsed[0].policy, parsed[0].blank, parsed[0].car],
          ["26167659", "149988", "59ADJ391"],
          `parsed values for ${where}`
        );
        eq(parsed[0].toKey, "2027-01-03", `term still derives the end date for ${where}`);
      }
    }
  });

  check("a report labelled with No, POLITSA / No, BLANKA / DKN reconciles", () => {
    // The transliterated daily-report layout: "No, POLITSA", "No, BLANKA" (with
    // a comma right after "No") and "DKN" instead of the Bulgarian labels.
    const translitRows = [
      ["No, POLITSA", "No, BLANKA", "ДАТА", "СРОК", "DKN", "ЦЕНА"],
      ["BG/02/FI 26167659", "149988", "05.10.2026", "3M", "59ADJ391", "45,50"],
    ];
    const cols = reconFindColumns(translitRows);
    eq(cols.missing, [], "the transliterated header row must be recognised");
    eq(cols.index, {
      policy: 0,
      blank: 1,
      from: 2,
      duration: 3,
      car: 4,
      price: 5,
    });
    const parsed = reconParseFileRows(translitRows, cols.headerRow, cols.index);
    eq(parsed.length, 1, "one data row");
    eq(
      [parsed[0].policy, parsed[0].blank, parsed[0].car],
      ["26167659", "149988", "59ADJ391"]
    );
    const ins = {
      PolicyNumber: "26167659",
      BlancNumber: "149988",
      CarNumber: "59ADJ391",
      StartDate: "2026-10-05",
      Duration: 90,
      Price: "45.5",
    };
    eq(reconCompareRow(parsed[0], ins).count, 0, "every field agrees");
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
      Price: "0",
    };
    eq(reconCompareRow(fileRows[0], ins).count, 0);
  });

  check("row comparison: duration compares in days (3M = 90D)", () => {
    const ins = {
      PolicyNumber: "26167659",
      BlancNumber: "149988",
      CarNumber: "59ADJ391",
      StartDate: "2026-10-05",
      Duration: 90,
      Price: "0",
    };
    const cmp = reconCompareRow(fileRows[0], ins);
    eq(cmp.fields.duration.file, "3M", "the file value stays as written");
    eq(cmp.fields.duration.db, "3M", "the database value uses the shorthand");
    eq(cmp.fields.duration.mismatch, false);
    // The 15D row agrees with a stored 15 days too, and disagrees with 30 (1M).
    const short = {
      PolicyNumber: fileRows[1].policy,
      BlancNumber: fileRows[1].blank,
      CarNumber: fileRows[1].car,
      StartDate: "2026-10-05",
      Duration: 15,
      Price: "0",
    };
    eq(reconCompareRow(fileRows[1], short).count, 0);
    const wrong = reconCompareRow(fileRows[1], { ...short, Duration: 30 });
    eq(wrong.fields.duration.mismatch, true);
    eq(wrong.fields.duration.file, "15D");
    eq(wrong.fields.duration.db, "1M");
  });

  check("row comparison: mismatching car is detected", () => {
    const ins = {
      PolicyNumber: "26167659",
      BlancNumber: "149988",
      CarNumber: "99XXX000",
      StartDate: "2026-10-05",
      Duration: 90,
      Price: "0",
    };
    const cmp = reconCompareRow(fileRows[0], ins);
    eq(cmp.count, 1);
    eq(cmp.fields.car.mismatch, true);
  });

  check("row comparison: a different duration is detected", () => {
    const ins = {
      PolicyNumber: "26167659",
      BlancNumber: "149988",
      CarNumber: "59ADJ391",
      StartDate: "2026-10-05",
      Duration: 15,
      Price: "0",
    };
    const cmp = reconCompareRow(fileRows[0], ins);
    // The stored duration 15 also moves the derived end date, so both fields
    // disagree with the file's 3M / 03.01.2027.
    eq(cmp.count, 2);
    eq(cmp.fields.duration.mismatch, true);
    eq(cmp.fields.duration.file, "3M");
    eq(cmp.fields.duration.db, "15D");
    eq(cmp.fields.to.mismatch, true);
  });

  check("row comparison: price compares as an amount", () => {
    const base = {
      PolicyNumber: "26167659",
      BlancNumber: "149988",
      CarNumber: "59ADJ391",
      StartDate: "2026-10-05",
      Duration: 90,
    };
    // The sample's ТАРИФА is 0, written in the file as a number.
    eq(reconCompareRow(fileRows[0], { ...base, Price: "0.00" }).count, 0);
    const cmp = reconCompareRow(fileRows[0], { ...base, Price: "45" });
    eq(cmp.count, 1);
    eq(cmp.fields.price.mismatch, true);
    eq(cmp.fields.price.file, "0");
    eq(cmp.fields.price.db, "45");
    // A price missing from the database counts as a difference, not as zero.
    eq(reconCompareRow(fileRows[0], { ...base, Price: null }).count, 1);
  });

  check("price is the number - the currency type never matters", () => {
    const ins = {
      PolicyNumber: "26167659",
      BlancNumber: "149988",
      CarNumber: "59ADJ391",
      StartDate: "2026-10-05",
      Duration: 90,
      Price: "45.5",
      // A different currency type on the policy must not be a difference.
      CurrencyType: "EUR",
    };
    const fileRow = { ...fileRows[0], priceRaw: "45,50 лв.", price: 45.5 };
    const cmp = reconCompareRow(fileRow, ins);
    eq(cmp.count, 0, "same amount, different currency wording");
    eq(cmp.fields.price.file, "45.5", "shown as the amount");
    eq(cmp.fields.price.db, "45.5");
    // A similar-looking but different amount is still caught.
    const off = reconCompareRow(
      { ...fileRow, priceRaw: "45,60 лв.", price: 45.6 },
      ins
    );
    eq(off.fields.price.mismatch, true);
  });

  check("currency columns next to the price are not the price", () => {
    // The daily reports carry ЕВРО / ЛЕВА / … columns beside the price. Only the
    // price column is read, and only its number is compared.
    const rows = [
      [
        "НОМЕР НА ПОЛИЦА",
        "НОМЕР НА СТИКЕР",
        "ВАЛИДЕН ОТ",
        "ВАЛИДЕН ДО",
        "ДКН",
        "ЦЕНА",
        "ЕВРО",
        "ЛЕВА",
      ],
      [
        "26167659",
        "149988",
        "01.01.2026",
        "31.01.2026",
        "59ADJ391",
        "45,50",
        10,
        90,
      ],
    ];
    const cols = reconFindColumns(rows);
    eq(cols.index.price, 5, "the ЦЕНА column is the price");
    const parsed = reconParseFileRows(rows, cols.headerRow, cols.index);
    eq(parsed[0].price, 45.5, "the currency columns do not become the price");
    const ins = {
      PolicyNumber: "26167659",
      BlancNumber: "149988",
      CarNumber: "59ADJ391",
      StartDate: "2026-01-01",
      Duration: 30,
      Price: "45.50",
      CurrencyType: "TRY",
    };
    eq(
      reconCompareRow(parsed[0], ins, null, reconFileFields(cols.index)).count,
      0,
      "the amount matches even though the currencies differ"
    );
  });

  // --- switching a field off -------------------------------------------------
  check("every field is compared by default", () => {
    eq(reconParseCompareFields(null), RECON_COMPARE_FIELDS);
    eq(reconParseCompareFields(""), RECON_COMPARE_FIELDS);
    // Unreadable or corrupted values must never switch a check off silently.
    eq(reconParseCompareFields("[not json"), RECON_COMPARE_FIELDS);
    eq(reconParseCompareFields("42"), RECON_COMPARE_FIELDS);
  });

  check("the stored choice is read in the canonical order", () => {
    eq(reconParseCompareFields('["car", "policy"]'), ["policy", "car"]);
    eq(reconParseCompareFields("policy, car"), ["policy", "car"]);
    // Unknown / misspelled keys are dropped, letter case is irrelevant.
    eq(reconParseCompareFields('["CAR","nope","Policy"]'), ["policy", "car"]);
    eq(reconParseCompareFields("[]"), []);
  });

  check("a field can be switched off and back on", () => {
    const off = reconToggleCompareField(RECON_COMPARE_FIELDS, "car", false);
    eq(off, ["policy", "blank", "from", "to", "duration", "price"]);
    eq(reconToggleCompareField(off, "car", true), RECON_COMPARE_FIELDS);
    eq(reconIsCompareFieldEnabled(off, "car"), false);
    eq(reconIsCompareFieldEnabled(off, "from"), true);
    // An unknown key cannot be added.
    eq(reconToggleCompareField(off, "nope", true), off);
  });

  check("a field switched off stops its difference from counting", () => {
    const ins = {
      PolicyNumber: "26167659",
      BlancNumber: "149988",
      CarNumber: "99XXX000",
      StartDate: "2026-10-05",
      Duration: 90,
      Price: "0",
    };
    const all = reconCompareRow(fileRows[0], ins);
    eq(all.count, 1);
    eq(all.fields.car.mismatch, true);

    const withoutCar = reconToggleCompareField(RECON_COMPARE_FIELDS, "car", false);
    const cmp = reconCompareRow(fileRows[0], ins, withoutCar);
    eq(cmp.count, 0, "the only difference was the car number");
    eq(cmp.fields.car.mismatch, false);
    eq(cmp.fields.car.ignored, true);
    eq(cmp.fields.car.file, "59ADJ391");
    eq(cmp.fields.car.db, "99XXX000");
    eq(cmp.fields.policy.ignored, false);
  });

  check("switching every field off makes any matched row agree", () => {
    const ins = {
      PolicyNumber: "26167659",
      BlancNumber: "000000",
      CarNumber: "99XXX000",
      StartDate: "2020-01-01",
      Duration: 15,
    };
    eq(reconCompareRow(fileRows[0], ins, []).count, 0);
    ok(reconCompareRow(fileRows[0], ins, []).fields.car.ignored, "car ignored");
  });

  // --- columns the file does not have ---------------------------------------
  check("a report without a price column does not compare prices", () => {
    const oldRows = [
      [
        "НОМЕР НА ПОЛИЦА",
        "НОМЕР НА СТИКЕР",
        "ВАЛИДЕН ОТ",
        "ВАЛИДЕН ДО",
        "ДКН",
        "СРОК",
      ],
      ["26167659", "149988", "05.10.2026", "03.01.2027", "59ADJ391", "3M"],
    ];
    const cols = reconFindColumns(oldRows);
    eq(cols.missing, []);
    eq(cols.index, {
      policy: 0,
      blank: 1,
      from: 2,
      to: 3,
      car: 4,
      duration: 5,
    });
    const fileFields = reconFileFields(cols.index);
    eq(fileFields, ["policy", "blank", "from", "to", "car", "duration"]);
    const parsed = reconParseFileRows(oldRows, cols.headerRow, cols.index);
    const ins = {
      PolicyNumber: "26167659",
      BlancNumber: "149988",
      CarNumber: "59ADJ391",
      StartDate: "2026-10-05",
      Duration: 90,
      Price: "45",
    };
    const cmp = reconCompareRow(parsed[0], ins, null, fileFields);
    eq(cmp.count, 0, "a missing column is not a difference on every row");
    eq(cmp.fields.price.ignored, true);
    eq(cmp.fields.price.file, "");
    eq(cmp.fields.duration.ignored, false);
    ok(!reconIsCompareFieldChecked(null, fileFields, "price"));
    ok(reconIsCompareFieldChecked(null, fileFields, "duration"));
  });

  check("a missing column behaves like a field switched off", () => {
    const fields = reconFileFields({
      policy: 0,
      blank: 1,
      from: 2,
      to: 3,
      car: 4,
    });
    ok(reconIsCompareFieldChecked(RECON_COMPARE_FIELDS, fields, "car"));
    ok(!reconIsCompareFieldChecked(RECON_COMPARE_FIELDS, fields, "price"));
    // The toggle and the file must both allow the field.
    ok(!reconIsCompareFieldChecked(["policy"], fields, "car"));
    // Without fileFields (a cached report from before) only the toggles matter.
    ok(reconIsCompareFieldChecked(RECON_COMPARE_FIELDS, undefined, "price"));
  });

  check("a term-only file still provides valid-until", () => {
    const termOnly = [
      ["ДАТА", "ДКН", "№ ПОЛИЦА", "№ БЛАНКА", "СРОК"],
      ["05.10.2026", "59ADJ391", "26167659", "149988", "3M"],
    ];
    const cols = reconFindColumns(termOnly);
    eq(cols.missing, [], "a term column satisfies valid-until");
    eq(cols.index, { from: 0, car: 1, policy: 2, blank: 3, duration: 4 });
    const parsed = reconParseFileRows(termOnly, cols.headerRow, cols.index);
    eq(parsed[0].toKey, "2027-01-03");
    eq(parsed[0].durationDays, 90);
    ok(
      reconFileFields(cols.index).includes("to"),
      "the derived end date counts as present"
    );
  });

  // --- which columns are required follows the ticked compare buttons --------
  check("only ticked compare fields are required", () => {
    eq(
      reconRequiredColumns().map((c) => c.key),
      ["policy", "blank", "from", "to", "car"],
      "with everything ticked the original requirements stay"
    );
    eq(
      reconRequiredColumns(["policy", "blank", "from", "to"]).map((c) => c.key),
      ["policy", "blank", "from", "to"],
      "an unticked car number is not required"
    );
    eq(
      reconRequiredColumns(["duration", "price"]).map((c) => c.key),
      [],
      "ticked optional fields stay optional"
    );
  });

  check("unticking a field lets a file without its column reconcile", () => {
    const noCar = [
      ["№ ПОЛИЦА", "№ БЛАНКА", "ДАТА", "СРОК"],
      ["26167659", "149988", "05.10.2026", "3M"],
    ];
    ok(
      reconFindColumns(noCar).missing.some((c) => c.key === "car"),
      "car is required while its button is ticked"
    );
    const cols = reconFindColumns(
      noCar,
      ["policy", "blank", "from", "to", "duration", "price"]
    );
    eq(cols.missing, [], "an unticked car number is not required");
    eq(cols.index, { policy: 0, blank: 1, from: 2, duration: 3 });

    const idsOnly = [
      ["№ ПОЛИЦА", "№ БЛАНКА"],
      ["26167659", "149988"],
    ];
    eq(
      reconFindColumns(idsOnly, ["policy", "blank"]).missing,
      [],
      "unticked date fields are not required either"
    );
    eq(
      reconFindColumns(idsOnly, ["policy", "blank", "duration", "price"]).missing,
      [],
      "duration/price stay optional even when ticked"
    );
  });

  // --- the "required columns" help ------------------------------------------
  check("the storage key names the compare fields", () => {
    eq(RECON_COMPARE_STORAGE_KEY, "reconcileCompareFields");
    eq(RECON_COMPARE_FIELDS, [
      "policy",
      "blank",
      "from",
      "to",
      "car",
      "duration",
      "price",
    ]);
  });

  check("the column hint lists exactly what the parser accepts", () => {
    const rows = reconHintRows();
    eq(
      rows.map((r) => r.key),
      RECON_COLUMNS.map((c) => c.key)
    );
    for (const row of rows) {
      const source = RECON_COLUMNS.find((c) => c.key === row.key);
      ok(row.headers.length > 0, "no headers listed for " + row.key);
      for (const header of source.headers) {
        ok(row.headers.includes(header), `${row.key} misses ${header}`);
      }
      eq(row.source, source.source, "database field for " + row.key);
    }
    // "Valid until" also accepts the term column, since the end date is then
    // derived from ДАТА + СРОК.
    const to = rows.find((r) => r.key === "to");
    for (const header of RECON_TERM_COLUMN.headers) {
      ok(to.headers.includes(header), `valid-until misses ${header}`);
    }
    eq(to.source, "StartDate + Duration");
    // The two new compare variables advertise every spelling they accept.
    const duration = rows.find((r) => r.key === "duration");
    for (const header of ["СРОК", "SROK", "DURATION"]) {
      ok(duration.headers.includes(header), `duration misses ${header}`);
    }
    eq(duration.source, "Duration");
    const price = rows.find((r) => r.key === "price");
    for (const header of ["ЦЕНА", "PRICE", "ТАРИФА", "TARIFA", "TARIFF"]) {
      ok(price.headers.includes(header), `price misses ${header}`);
    }
    eq(price.source, "Price");
    // Both are optional: a report without those columns still reconciles.
    for (const key of ["duration", "price"]) {
      eq(
        RECON_COLUMNS.find((c) => c.key === key).optional,
        true,
        key + " is optional"
      );
    }
  });

  // --- the broker portal's Excel export --------------------------------------
  check("the portal's export headers reconcile in all three languages", () => {
    // The website's "Export Excel" writes these header rows (i18n.js labels);
    // its date column holds the policy's start date and its term the 15D/1M/3M
    // shorthand, so a drop-in reconcile must line every column up.
    const layouts = {
      en: [
        "Policy #", "Blanc #", "Car number", "Duration", "Price", "Currency",
        "Valid from", "Status",
      ],
      bg: [
        "Полица №", "Бланка №", "Рег. номер", "Срок", "Цена", "Валута",
        "Валиден от", "Статус",
      ],
      tr: [
        "Poliçe no", "Form no", "Plaka", "Süre", "Fiyat", "Para birimi",
        "Geçerlilik başlangıcı", "Durum",
      ],
    };
    for (const [lang, headers] of Object.entries(layouts)) {
      const portalRows = [
        headers,
        ["26167659", "149988", "59ADJ391", "3M", 45, "EUR", "05.10.2026", ""],
      ];
      const cols = reconFindColumns(portalRows);
      eq(cols.missing, [], `missing columns for the ${lang} export`);
      eq(
        cols.index,
        { policy: 0, blank: 1, car: 2, duration: 3, price: 4, from: 6 },
        `column map for the ${lang} export`
      );
      const parsed = reconParseFileRows(
        portalRows,
        cols.headerRow,
        cols.index
      );
      eq(parsed.length, 1, `one data row for the ${lang} export`);
      eq(
        [parsed[0].policy, parsed[0].blank, parsed[0].car],
        ["26167659", "149988", "59ADJ391"],
        `parsed values for the ${lang} export`
      );
      // The portal writes dd.mm.yyyy and the term shorthand; both must come
      // back as the day and day-count the database stores.
      eq(parsed[0].fromKey, "2026-10-05", `start date for the ${lang} export`);
      eq(parsed[0].durationDays, 90, `term for the ${lang} export`);
      eq(parsed[0].price, 45, `price for the ${lang} export`);
      const ins = {
        PolicyNumber: "26167659",
        BlancNumber: "149988",
        CarNumber: "59ADJ391",
        StartDate: "2026-10-05",
        Duration: 90,
        Price: "45.00",
      };
      eq(reconCompareRow(parsed[0], ins).count, 0, `matches for ${lang}`);
    }
  });

  check("the export's total and breakdown lines are skipped", () => {
    // The website appends the total and the per-price breakdown below the
    // policies, all with their label in the policy column. Those rows carry no
    // digit in the policy, blank or car column, so they are summary rows - not
    // insurances missing from the database.
    const portalRows = [
      [
        "Policy #", "Blanc #", "Car number", "Duration", "Price", "Currency",
        "Valid from", "Status",
      ],
      ["26167659", "149988", "59ADJ391", "3M", 45, "EUR", "05.10.2026", ""],
      ["26200001", "150001", "CA1234AB", "1M", 19, "EUR", "06.10.2026", ""],
      ["Total", "", "", "", 64, "", "", ""],
      ["Policies by price", "", "", "", "", "", "", ""],
      ["1× 45 EUR", "", "", "", "", "", "", ""],
      ["1× 19 EUR", "", "", "", "", "", "", ""],
      ["Annulled policies by price", "", "", "", "", "", "", ""],
      ["1× 9 EUR", "", "", "", "", "", "", ""],
    ];
    const cols = reconFindColumns(portalRows);
    eq(cols.missing, [], "the export header row is recognised");
    const parsed = reconParseFileRows(portalRows, cols.headerRow, cols.index);
    eq(parsed.length, 2, "only the two policies are read");
    eq(
      parsed.map((r) => r.policy),
      ["26167659", "26200001"]
    );
  });

  check("a text-only footer row of a report is skipped too", () => {
    // Same rule for the old layouts: a totals line without any digit in its
    // identifying columns is not a policy.
    const reportRows = [
      ["НОМЕР НА ПОЛИЦА", "НОМЕР НА СТИКЕР", "ДАТА", "СРОК", "ДКН"],
      ["BG/02/FI 26167659", "149988", "05.10.2026", "3M", "59ADJ391"],
      ["ОБЩО", "", "", "", ""],
    ];
    const cols = reconFindColumns(reportRows);
    const parsed = reconParseFileRows(reportRows, cols.headerRow, cols.index);
    eq(parsed.length, 1, "the ОБЩО totals line is skipped");
    eq(parsed[0].policy, "26167659");
  });

  check("the client's own insurance export is reconcilable as well", () => {
    // The Insurances tab's "Export Excel" writes this header row (the en labels
    // of renderer/common.js). Its money price, term shorthand and Excel date
    // serials are exactly what the parser reads.
    const exportRows = [
      [
        "No.", "Blank No.", "Policy number", "Car number", "Kind", "Duration",
        "Price", "Currency", "Payment", "Broker", "Broker ID", "Author",
        "Created", "Status",
      ],
      [1, "149988", "26167659", "59ADJ391", "Border", "3M", 45, "EUR", "Cash",
        "Broker", "4.2", "worker", 46300, "Active"],
    ];
    const cols = reconFindColumns(exportRows);
    eq(cols.missing, [], "the client's export header row is recognised");
    eq(cols.index.policy, 2);
    eq(cols.index.blank, 1);
    eq(cols.index.car, 3);
    eq(cols.index.duration, 5);
    eq(cols.index.price, 6);
    eq(cols.index.from, 12);
    const parsed = reconParseFileRows(exportRows, cols.headerRow, cols.index);
    eq(parsed.length, 1);
    eq(parsed[0].policy, "26167659");
    eq(parsed[0].fromKey, "2026-10-05", "Excel serial date");
    eq(parsed[0].durationDays, 90);
    eq(parsed[0].price, 45);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error("Test run crashed:", err);
  process.exit(1);
});
