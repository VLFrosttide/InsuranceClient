"use strict";

// Pure, DOM-free helpers for the "Reconcile daily report" feature. Kept in a
// separate file so the exact same code can run in the browser (as a classic
// <script>) and in a Node test harness (via vm). See test/client/reconcile.test.cjs.
//
// Two daily-report layouts are supported:
//   - Full layout:  НОМЕР НА ПОЛИЦА / НОМЕР НА СТИКЕР / ВАЛИДЕН ОТ / ВАЛИДЕН ДО / ДКН
//   - Shift-log layout (e.g. "FINANSOV OTCHET" files):
//       № ПОЛИЦА / № БЛАНКА / ДАТА / СРОК / ДКН,
//     where the valid-until date is derived from ДАТА + a "СРОК" term code
//     such as "15D", "1M" or "3M". That same column is compared with the
//     policy's Duration (in days).
//
// The broker portal's "Export Excel" file (a real .xlsx the website builds with
// its xlsx.js) is accepted as well: it prints the policy's start date under a
// "Valid from" / "Създадена" / "Oluşturuldu" header, its term as "СРОК" /
// "Duration" / "Süre" in the same 15D/1M/3M shorthand, and its car number as
// "ДКН" / "Car number" / "Рег. номер" / "Plaka". The total and the per-price
// breakdown it appends below the list are skipped (see reconParseFileRows).
//
// The policy, sticker, car, duration and price columns also accept English
// headers ("Policy number", "Blanc Number", "Car number", "Duration", "Price",
// "Tarifa", … - the full list is RECON_COLUMNS), because some exports use the
// database field names instead of the Bulgarian ones. The reports also print
// transliterated labels - "DKN" for ДКН, "No, POLITSA" for the policy number
// and "No, BLANKA" for the blank - so those spellings are accepted too. Header
// matching ignores case, spaces and punctuation (reconHeaderKey), which is why
// "No, POLITSA", "No. POLITSA" and "No POLITSA" all mean the same header.
//
// Duration and price are optional: a report that does not print those columns
// still reconciles everything else, and the missing field is reported as not
// compared instead of flagging every row.
//
// Which columns a file must have follows the compare buttons (the ticked
// fields): a field that is switched off is no longer required, so a report
// without that column still reconciles the fields that are ticked
// (reconRequiredColumns, reconFindColumns). Ticked optional fields stay
// optional, so the layouts above keep working.
//
// The policy number in a report is printed with the office/series code
// "BG/02/FI" in front; that prefix is cut off before the numbers are compared
// (reconNormPolicy) and from the displayed value (reconStripPolicyPrefix).

const RECON_CYR_TO_LAT = {
  А: "A",
  В: "B",
  Е: "E",
  К: "K",
  М: "M",
  Н: "H",
  О: "O",
  Р: "P",
  С: "C",
  Т: "T",
  У: "Y",
  Х: "X",
};

// Trim, upper-case, drop whitespace and map Cyrillic look-alike letters to
// Latin so "СА 1234 АВ" and "CA1234AB" compare as equal.
function reconNormText(value) {
  if (value === undefined || value === null) return "";
  return String(value)
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "")
    .replace(/[АВЕКМНОРСТУХ]/g, (ch) => RECON_CYR_TO_LAT[ch]);
}

// Identifier (policy / sticker number): numeric ones ignore leading zeros,
// which Excel drops from numeric cells.
function reconNormId(value) {
  const s = reconNormText(value);
  return /^\d+$/.test(s) ? s.replace(/^0+(?=\d)/, "") : s;
}

// The daily reports print the policy number with the office/series code
// "BG/02/FI" in front (e.g. "BG/02/FI 26167659"), while the database stores
// only the number. That prefix is not part of the policy number, so it is cut
// off before the two are compared - otherwise every row is reported as missing
// from the database.
const RECON_POLICY_PREFIX = /^BG\/02\/FI[\s./_-]*/;
const RECON_POLICY_PREFIX_RAW = /^\s*BG\s*\/\s*02\s*\/\s*FI[\s./_-]*/i;

// The display value of a parsed row: the file's policy number without the
// report prefix, keeping its original formatting otherwise.
function reconStripPolicyPrefix(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim().replace(RECON_POLICY_PREFIX_RAW, "").trim();
}

function reconNormPolicy(value) {
  // Normalise first: it upper-cases, strips whitespace and maps Cyrillic
  // look-alikes, so "bg / 02 / fi 26167659" reaches the prefix check in the
  // canonical form too.
  return reconNormId(reconNormText(value).replace(RECON_POLICY_PREFIX, ""));
}

function reconNormCar(value) {
  return reconNormText(value).replace(/[-_.]/g, "");
}

function reconHeaderKey(value) {
  return reconNormText(String(value ?? "").replace(/[^\p{L}\p{N}]/gu, ""));
}

// Alternate "valid until" source and the duration aliases: a term/duration
// column (e.g. "СРОК" with values like "15D", "1M", "3M") is used when the file
// has no explicit "ВАЛИДЕН ДО", and is also the column the duration compare
// reads. Declared before RECON_COLUMNS because the duration column reuses it.
// "SÜRE" / "Süre" is the Turkish label of the broker portal's Excel export.
const RECON_TERM_COLUMN = {
  key: "term",
  headers: ["СРОК", "SROK", "DURATION", "ТЕРМИН", "ПЕРИОД", "SÜRE", "Süre"],
};

const RECON_COLUMNS = [
  {
    key: "policy",
    header: "НОМЕР НА ПОЛИЦА",
    label: "reconcile.col.policy",
    source: "PolicyNumber",
    // Bulgarian and English spellings, both seen in the reports. Matching goes
    // through reconHeaderKey(), which drops case, spaces and punctuation, so
    // "Policy number", "PolicyNumber" and "POLICY-NUMBER" all land on the same
    // entry; the extra spellings are listed because they are exactly what the
    // files print (and the help table shows the list as documentation).
    headers: [
      "НОМЕР НА ПОЛИЦА",
      "№ ПОЛИЦА",
      "ПОЛИЦА",
      // Transliterated labels of the daily reports: "No, POLITSA" (and "№
      // POLITSA", which normalises to plain "POLITSA"), next to the English
      // spellings some exports use. The mixed "No." + Cyrillic spelling is its
      // own entry because reconNormText only maps the look-alike letters, so
      // "ПОЛИЦА" never becomes "POLITSA".
      "POLITSA",
      "No POLITSA",
      "No ПОЛИЦА",
      "Policy number",
      "PolicyNumber",
      "Policy",
      // "Policy #" from the broker portal's Excel export (en) and its Turkish
      // label ("Poliçe no").
      "Policy #",
      "Poliçe no",
      "Poliçe No",
    ],
  },
  {
    key: "blank",
    header: "НОМЕР НА СТИКЕР",
    label: "reconcile.col.blank",
    source: "BlancNumber",
    headers: [
      "НОМЕР НА СТИКЕР",
      "№ БЛАНКА",
      "БЛАНКА",
      "НОМЕР НА БЛАНКА",
      // Transliterated labels: "No, BLANKA" (and "№ BLANKA", which normalises
      // to plain "BLANKA"), plus the mixed "No." + Cyrillic spelling.
      "BLANKA",
      "No BLANKA",
      "No БЛАНКА",
      "Blanc",
      "Blanc Number",
      "BlancNumber",
      "Blank",
      "BlankNumber",
      "Number Blanc",
      "NumberBlanc",
      // Labels of the broker portal's Excel export: "Blanc #" (en), "Form no"
      // (tr). "Blank No." is the client's own insurance export.
      "Blanc #",
      "Form no",
      "Blank No.",
    ],
  },
  {
    key: "from",
    header: "ВАЛИДЕН ОТ",
    label: "reconcile.col.from",
    source: "StartDate",
    // The date the policy starts. Besides the daily reports' own labels this
    // accepts the broker portal's export ("Valid from" / "Създадена" /
    // "Oluşturuldu") and the client's own insurance export ("Created" /
    // "Създаден"), which print the policy's date in that column.
    headers: [
      "ВАЛИДЕН ОТ",
      "ДАТА",
      "Valid from",
      "Създадена",
      "Създаден",
      "Created",
      "Geçerlilik başlangıcı",
      "Oluşturuldu",
    ],
  },
  {
    key: "to",
    header: "ВАЛИДЕН ДО",
    label: "reconcile.col.to",
    optional: true,
    source: "StartDate + Duration",
    headers: ["ВАЛИДЕН ДО"],
  },
  {
    key: "car",
    header: "ДКН",
    label: "reconcile.col.car",
    source: "CarNumber",
    headers: [
      "ДКН",
      // Transliterated spelling of ДКН used by some exports.
      "DKN",
      "Car number",
      "Number Car",
      "Car Plate",
      "Plate number",
      "Number Plate",
      // The broker portal's export labels: "Рег. номер" (bg) and "Plaka" (tr);
      // "Номер на автомобил" is the client's own insurance export.
      "Рег. номер",
      "Plaka",
      "Номер на автомобил",
    ],
  },
  {
    key: "duration",
    header: "СРОК",
    label: "reconcile.col.duration",
    source: "Duration",
    // Optional: not every report prints the term. When the column is missing
    // the field is simply not compared for that report (reconFileFields), so an
    // older file does not fail or flag every row. The values are the same term
    // shorthands that derive "valid until": "15D" = 15 days, "3M" = 3 months.
    optional: true,
    headers: RECON_TERM_COLUMN.headers.slice(),
  },
  {
    key: "price",
    header: "ЦЕНА",
    label: "reconcile.col.price",
    source: "Price",
    // Optional as well: the daily report layouts in the field differ, and a
    // file without a price column still reconciles everything else. Only the
    // amount is compared - the currency type (the sheet's ЕВРО/ЛЕВА/… columns
    // or a "лв"/"EUR" suffix) never is.
    optional: true,
    headers: ["ЦЕНА", "PRICE", "ТАРИФА", "TARIFA", "TARIFF", "Fiyat"],
  },
];

// The row fields whose differences can be switched off in the comparison, in
// the order they are listed in the UI. Every one of them is compared by
// default; the chosen set is remembered in localStorage under
// RECON_COMPARE_STORAGE_KEY (see reconcileView in WorkPage.js), so a worker who
// never wants the car number checked switches it off once and for all.
const RECON_COMPARE_FIELDS = RECON_COLUMNS.map((c) => c.key);
const RECON_COMPARE_STORAGE_KEY = "reconcileCompareFields";

// The help text of the Reconcile tab: one entry per column the file must have,
// built from the very constants the parser uses so the documentation cannot
// drift away from the code that reads the spreadsheet.
function reconHintRows() {
  return RECON_COLUMNS.map((col) => ({
    key: col.key,
    label: col.label,
    source: col.source || "",
    // "Valid until" is satisfied either by an explicit end date or by a term
    // column ("СРОК" and friends): both spellings are listed as accepted.
    headers:
      col.key === "to"
        ? [...col.headers, ...RECON_TERM_COLUMN.headers]
        : col.headers.slice(),
  }));
}

function reconCompareFieldsDefault() {
  return RECON_COMPARE_FIELDS.slice();
}

// Read the stored choice. Accepts the JSON array written by the UI, an already
// parsed array, or a plain comma-separated list. Unknown keys are dropped and
// the result always comes back in the canonical order. A value that names no
// known field at all is treated as unreadable and falls back to "compare every
// field", so a corrupted or outdated value can never silently switch a check
// off; only a deliberately empty list means "compare nothing".
function reconParseCompareFields(raw) {
  if (raw === null || raw === undefined) return reconCompareFieldsDefault();
  let list = null;
  if (Array.isArray(raw)) {
    list = raw;
  } else {
    const text = String(raw).trim();
    if (!text) return reconCompareFieldsDefault();
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) list = parsed;
    } catch (err) {
      list = text.split(",");
    }
  }
  if (!Array.isArray(list)) return reconCompareFieldsDefault();
  const wanted = new Set(list.map((v) => String(v).trim().toLowerCase()));
  const picked = RECON_COMPARE_FIELDS.filter((key) => wanted.has(key));
  if (list.length > 0 && picked.length === 0) return reconCompareFieldsDefault();
  return picked;
}

// Turn one field on or off, returning a new list in the canonical order.
function reconToggleCompareField(fields, key, on) {
  if (!RECON_COMPARE_FIELDS.includes(key)) {
    return reconParseCompareFields(fields);
  }
  const next = new Set(reconParseCompareFields(fields));
  if (on) next.add(key);
  else next.delete(key);
  return RECON_COMPARE_FIELDS.filter((k) => next.has(k));
}

function reconIsCompareFieldEnabled(fields, key) {
  return reconParseCompareFields(fields).includes(key);
}

// Whether a field is actually compared in a report: it must be switched on in
// the compare toggles AND the file must have its column. `fileFields` may be
// omitted (older cached reports), in which case only the toggles matter.
function reconIsCompareFieldChecked(compareFields, fileFields, key) {
  return (
    reconIsCompareFieldEnabled(compareFields, key) &&
    reconIsCompareFieldEnabled(fileFields, key)
  );
}

function reconPad(n) {
  return String(n).padStart(2, "0");
}

function reconYmd(y, m, d) {
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (
    dt.getUTCFullYear() !== y ||
    dt.getUTCMonth() !== m - 1 ||
    dt.getUTCDate() !== d
  ) {
    return "";
  }
  return `${y}-${reconPad(m)}-${reconPad(d)}`;
}

// Parse a cell from the file (Excel serial number or text) to "YYYY-MM-DD".
function reconFileDate(value) {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value === "number") {
    if (!(value > 0 && value < 2958466)) return "";
    const dt = new Date(Math.floor(value - 25569) * 86400000);
    return reconYmd(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
  }
  const s = String(value).trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return reconYmd(+m[1], +m[2], +m[3]);
  // Day-month-year (and month-day-year, but the files in the field are
  // day-first). Separators: ".", "/", "-" and "," (e.g. "05,10,2026").
  m = s.match(/^(\d{1,2})[.,/-](\d{1,2})[.,/-](\d{2,4})/);
  if (m) {
    let y = +m[3];
    if (y < 100) y += 2000;
    return reconYmd(y, +m[2], +m[1]);
  }
  return "";
}

// Convert a term/duration cell to a day count so the valid-until date can be
// derived when the file has no explicit "ВАЛИДЕН ДО" column. Handles the
// shift-log shorthands ("15D" -> 15, "1M" -> 30, "3M" -> 90, "1Y" -> 365) and
// plain numeric day counts. Returns null when the value is unrecognised.
function reconTermDays(value) {
  const s = String(value ?? "").trim().toUpperCase().replace(/\s+/g, "");
  if (!s) return null;
  let m = s.match(/^(\d+)D$/);
  if (m) return +m[1];
  m = s.match(/^(\d+)M$/);
  if (m) return +m[1] * 30;
  m = s.match(/^(\d+)Y$/);
  if (m) return +m[1] * 365;
  if (/^\d+$/.test(s)) return +s;
  return null;
}

// Turn a price cell into a number. Only the amount is read: currency words,
// codes and symbols ("лв", "EUR", "TL", "€", "₺") are dropped, because two
// prices are compared by their number and never by the currency type. The
// reports write prices as "1234.56", "1234,56" (decimal comma), "1.234,56" and
// "1 234,56". Returns null for an empty or unreadable cell, so a blank price
// never looks like a zero.
function reconPrice(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  let s = String(value).replace(/[^\d.,-]/g, "");
  // Currency text leaves stray punctuation behind ("45,50 лв." -> "45,50."),
  // so a separator at either end cannot be part of the number.
  s = s.replace(/^[.,]+|[.,]+$/g, "");
  if (!s || !/\d/.test(s)) return null;
  const lastDot = s.lastIndexOf(".");
  const lastComma = s.lastIndexOf(",");
  if (lastDot >= 0 && lastComma >= 0) {
    // Both separators present: the last one is the decimal separator and the
    // other one groups thousands ("1.234,56" and "1,234.56" both mean 1234.56).
    const decimal = lastDot > lastComma ? "." : ",";
    const thousands = decimal === "." ? "," : ".";
    s = s.split(thousands).join("");
    s = s.replace(decimal, ".");
  } else if (lastComma >= 0) {
    // A single comma is the decimal separator, as the Bulgarian files write it.
    s = s.replace(",", ".");
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

// Normalise a date coming from the server to a local "YYYY-MM-DD".
function reconDbDate(value) {
  if (!value) return "";
  const s = String(value).trim();
  const m =
    s.match(/^(\d{4})-(\d{2})-(\d{2})$/) ||
    s.match(/^(\d{4})-(\d{2})-(\d{2}) \d/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  const d = new Date(s);
  if (isNaN(d.getTime())) return "";
  return `${d.getFullYear()}-${reconPad(d.getMonth() + 1)}-${reconPad(
    d.getDate()
  )}`;
}

// The creation-date range of the report (the two date inputs of the Reconcile
// tab). The inputs already hold ISO dates, but a reversed pair is swapped
// instead of being taken literally: "07.10 - 05.10" then still covers both
// days instead of reporting every insurance as missing. An empty side leaves
// that end of the range open.
function reconDateRange(from, to) {
  const first = reconDbDate(from);
  const second = reconDbDate(to);
  if (first && second && first > second) {
    return { from: second, to: first };
  }
  return { from: first, to: second };
}

// Whether an insurance's creation date falls inside the range (both ends
// inclusive). A range with neither side filled in matches nothing, which is
// how clearing both date fields switches the "missing from file" check off.
function reconDateInRange(value, range) {
  const day = reconDbDate(value);
  if (!day) return false;
  const from = (range && range.from) || "";
  const to = (range && range.to) || "";
  if (!from && !to) return false;
  if (from && day < from) return false;
  if (to && day > to) return false;
  return true;
}

function reconAddDays(ymd, days) {
  const m = ymd.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m || !Number.isFinite(days)) return "";
  const dt = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3] + days));
  return reconYmd(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}

function reconShowDate(ymd) {
  const m = (ymd || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  // Every date in the app is shown as dd-mm-yyyy.
  return m ? `${m[3]}-${m[2]}-${m[1]}` : "";
}

// A stored duration (in days) written the way the reports do: 30 -> "1M",
// 90 -> "3M", anything else in days ("15D", "365D"). Empty/invalid -> "".
function reconShowDuration(days) {
  if (days === undefined || days === null || days === "") return "";
  const n = Number(days);
  if (!Number.isFinite(n)) return "";
  if (n === 30) return "1M";
  if (n === 90) return "3M";
  return `${n}D`;
}

// A price for display: the parsed amount with at most two decimals, or the
// cell's own text when it cannot be read as a number (so nothing is hidden).
function reconShowPrice(value) {
  const n = reconPrice(value);
  return n === null ? reconCellText(value) : String(Math.round(n * 100) / 100);
}

function reconCellText(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

// The columns every report must have, given the fields the user is comparing:
// the required ones plus "valid until", which may come from the term/duration
// column instead of its own date column.
//
// A field whose compare button is unticked is not required: the file may omit
// its column, and the report must not reject it for a column that is not being
// looked at. The optional columns (duration, price) stay optional even when
// ticked, because not every report layout prints them; their differences are
// then reported as not compared (reconFileFields). With no argument every field
// counts as ticked, which keeps the original behaviour.
function reconRequiredColumns(compareFields) {
  return RECON_COLUMNS.filter(
    (c) =>
      reconIsCompareFieldEnabled(compareFields, c.key) &&
      (!c.optional || c.key === "to")
  );
}

// Locate the header row and map each required column to its index. A column
// matches any of its accepted header spellings; "valid until" is satisfied by
// either an explicit "ВАЛИДЕН ДО" column or the term/duration column ("СРОК"
// etc.), from which the end date is derived.
//
// `compareFields` (optional) is the set of fields ticked in the compare
// buttons. Only its columns are required - unticking a field lets a file
// without that column reconcile. Omitting it requires every field, as before.
function reconFindColumns(rows, compareFields) {
  const required = reconRequiredColumns(compareFields);
  const requiredKeys = required.map((c) => c.key);
  const requiredTo = requiredKeys.includes("to");
  const maxScore = required.length;
  const limit = Math.min(rows.length, 50);
  let best = null;
  for (let r = 0; r < limit; r++) {
    const cells = rows[r] || [];
    const found = {};
    cells.forEach((cell, idx) => {
      const key = reconHeaderKey(cell);
      if (!key) return;
      for (const col of RECON_COLUMNS) {
        if (found[col.key] !== undefined) continue;
        if (col.headers.some((h) => reconHeaderKey(h) === key)) {
          found[col.key] = idx;
        }
      }
    });
    const requiredFound = requiredKeys.filter(
      (key) => key !== "to" && found[key] !== undefined
    ).length;
    const toSatisfied = found.to !== undefined || found.duration !== undefined;
    const score = requiredFound + (requiredTo && toSatisfied ? 1 : 0);
    // Ties go to the row that recognises more columns in total, so the header
    // row is still found when only optional fields are required (or none).
    const totalFound = RECON_COLUMNS.filter(
      (c) => found[c.key] !== undefined
    ).length;
    if (
      !best ||
      score > best.score ||
      (score === best.score && totalFound > best.totalFound)
    ) {
      best = { row: r, found, score, totalFound };
    }
    if (score === maxScore && maxScore > 0) break;
  }
  // Nothing recognisable anywhere: report the columns the ticked fields need.
  if (!best || (maxScore > 0 && best.score === 0)) {
    return { missing: required };
  }
  const missing = required.filter((c) => {
    if (c.key === "to") {
      return best.found.to === undefined && best.found.duration === undefined;
    }
    return best.found[c.key] === undefined;
  });
  return { headerRow: best.row, index: best.found, missing };
}

// The fields the file actually provides. Optional columns (duration, price) may
// be missing from a given report, and a column the file does not have cannot be
// compared: reconcileReport passes this set on so such a field is reported as
// "not compared" instead of flagging every row (see reconCompareRow).
function reconFileFields(index) {
  const found = index || {};
  return RECON_COLUMNS.filter((col) => {
    if (found[col.key] !== undefined) return true;
    // The term column also derives the end date, so "valid until" is present
    // even when the file has no explicit ВАЛИДЕН ДО column.
    return col.key === "to" && found.duration !== undefined;
  }).map((col) => col.key);
}

// Whether a cell looks like a policy / sticker / car number. Such a number
// always holds a digit and is printed with letters, digits, spaces and a few
// separators ("BG/02/FI 26167659", "№ 123456", "CA 1234 AB"). The summary lines
// a report or an export prints below its list ("Total", "ОБЩО", "10× 19 EUR")
// have no digit at all or a character no identifier uses (the "×" of a
// "10× 19 EUR" line), which is how reconParseFileRows tells them apart.
const RECON_DIGIT = /\d/;
const RECON_NOT_ID_CHAR = /[^\p{L}\p{N} .\-_/#№*]/u;
function reconLooksLikeId(value) {
  const text = reconCellText(value);
  return RECON_DIGIT.test(text) && !RECON_NOT_ID_CHAR.test(text);
}

function reconParseFileRows(rows, headerRow, index) {
  const out = [];
  for (let r = headerRow + 1; r < rows.length; r++) {
    const cells = rows[r] || [];
    const raw = {};
    for (const col of RECON_COLUMNS) raw[col.key] = cells[index[col.key]];

    // Excel "Table" totals rows carry a literal "Total" label and mark the end
    // of the data; anything after is summary/reference material (cash totals,
    // broker lookup lists, …) that reuses the same columns.
    if (reconCellText(raw.from).toUpperCase() === "TOTAL") break;

    // A row with no policy / sticker / car number is not real insurance data,
    // even when a date column carries a filled-down formula value (common in
    // template tables whose whole column range is pre-filled).
    const empty =
      reconCellText(raw.policy) === "" &&
      reconCellText(raw.blank) === "" &&
      reconCellText(raw.car) === "";
    if (empty) continue;

    // The total and the per-price breakdown the broker portal's Excel export
    // appends below the policies are such summary rows too (their label sits in
    // the policy column, but it is no policy / sticker / car number): they must
    // not show up as insurances missing from the database.
    if (
      !reconLooksLikeId(raw.policy) &&
      !reconLooksLikeId(raw.blank) &&
      !reconLooksLikeId(raw.car)
    ) {
      continue;
    }

    const fromKey = reconFileDate(raw.from);
    const durationDays = reconTermDays(raw.duration);
    let toRaw = reconCellText(raw.to);
    let toKey = reconFileDate(raw.to);
    if (!toKey && durationDays !== null && fromKey) {
      toKey = reconAddDays(fromKey, durationDays);
      if (!toRaw) toRaw = reconCellText(raw.duration);
    }

    out.push({
      rowNo: r + 1,
      policy: reconStripPolicyPrefix(reconCellText(raw.policy)),
      blank: reconCellText(raw.blank),
      car: reconCellText(raw.car),
      fromRaw: reconCellText(raw.from),
      toRaw,
      fromKey,
      toKey,
      // Duration and price are kept raw for the display and parsed for the
      // compare: "3M" stays visible as the file wrote it, but compares as 90
      // days, and "45,50 лв." compares as 45.5.
      durationRaw: reconCellText(raw.duration),
      durationDays,
      priceRaw: reconCellText(raw.price),
      price: reconPrice(raw.price),
    });
  }
  return out;
}

function reconDbValues(ins) {
  const start = reconDbDate(ins.StartDate);
  const duration = Number(ins.Duration);
  const hasDuration = ins.Duration !== null && ins.Duration !== undefined;
  const end = start && hasDuration ? reconAddDays(start, duration) : "";
  return {
    policy: reconCellText(ins.PolicyNumber),
    blank: reconCellText(ins.BlancNumber),
    car: reconCellText(ins.CarNumber),
    fromKey: start,
    toKey: end,
    durationDays: hasDuration && Number.isFinite(duration) ? duration : null,
    price: reconPrice(ins.Price),
  };
}

// Compare one file row with one insurance, returning per-field results.
//
// `compareFields` (optional) is the set of fields to check (see
// RECON_COMPARE_FIELDS). A field that is switched off never counts as a
// mismatch and is flagged `ignored: true`, so the results screen can show its
// values for reference without highlighting them. Omitting the argument
// compares every field, which is the default.
//
// `fileFields` (optional) is the set of columns the file actually has (see
// reconFileFields). A field whose column is missing is ignored exactly like one
// switched off by hand - otherwise a report without a price column would flag
// every row.
function reconCompareRow(fileRow, ins, compareFields, fileFields) {
  const enabled = new Set(reconParseCompareFields(compareFields));
  const present =
    fileFields === undefined
      ? null
      : new Set(reconParseCompareFields(fileFields));
  const checked = (key) => enabled.has(key) && (!present || present.has(key));
  const db = reconDbValues(ins);
  const field = (key, fileValue, dbValue, equal) => ({
    file: fileValue,
    db: dbValue,
    mismatch: checked(key) && !equal,
    ignored: !checked(key),
  });
  const fields = {
    policy: field(
      "policy",
      fileRow.policy,
      db.policy,
      reconNormPolicy(fileRow.policy) === reconNormPolicy(db.policy)
    ),
    blank: field(
      "blank",
      fileRow.blank,
      db.blank,
      reconNormId(fileRow.blank) === reconNormId(db.blank)
    ),
    from: field(
      "from",
      fileRow.fromKey ? reconShowDate(fileRow.fromKey) : fileRow.fromRaw,
      reconShowDate(db.fromKey),
      !!fileRow.fromKey && fileRow.fromKey === db.fromKey
    ),
    to: field(
      "to",
      fileRow.toKey ? reconShowDate(fileRow.toKey) : fileRow.toRaw,
      reconShowDate(db.toKey),
      !!fileRow.toKey && fileRow.toKey === db.toKey
    ),
    car: field(
      "car",
      fileRow.car,
      db.car,
      reconNormCar(fileRow.car) === reconNormCar(db.car)
    ),
    // Duration compares in days: the file's term shorthand is parsed first, so
    // "3M" and a stored 90 agree.
    duration: field(
      "duration",
      fileRow.durationRaw || reconShowDuration(fileRow.durationDays),
      reconShowDuration(db.durationDays),
      fileRow.durationDays !== null &&
        fileRow.durationDays !== undefined &&
        db.durationDays !== null &&
        fileRow.durationDays === db.durationDays
    ),
    // Prices are compared as amounts: the currency (the sheet's ЕВРО/ЛЕВА/…
    // columns, a "лв"/"EUR" suffix or the policy's CurrencyType) is never part
    // of the comparison, only the number is. Rounded to cents, so "45,50" in
    // the file and "45.5" in the database agree.
    price: field(
      "price",
      reconShowPrice(fileRow.priceRaw),
      reconShowPrice(db.price),
      fileRow.price !== null &&
        fileRow.price !== undefined &&
        db.price !== null &&
        Math.abs(fileRow.price - db.price) < 0.005
    ),
  };
  const count = Object.values(fields).filter((f) => f.mismatch).length;
  return { fields, count };
}

