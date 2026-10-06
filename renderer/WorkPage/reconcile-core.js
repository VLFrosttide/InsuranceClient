"use strict";

// Pure, DOM-free helpers for the "Reconcile daily report" feature. Kept in a
// separate file so the exact same code can run in the browser (as a classic
// <script>) and in a Node test harness (via vm). See Test/reconcile.test.js.
//
// Two daily-report layouts are supported:
//   - Full layout:  НОМЕР НА ПОЛИЦА / НОМЕР НА СТИКЕР / ВАЛИДЕН ОТ / ВАЛИДЕН ДО / ДКН
//   - Shift-log layout (e.g. "FINANSOV OTCHET" files):
//       № ПОЛИЦА / № БЛАНКА / ДАТА / СРОК / ДКН,
//     where the valid-until date is derived from ДАТА + a "СРОК" term code
//     such as "15D", "1M" or "3M".

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

function reconNormCar(value) {
  return reconNormText(value).replace(/[-_.]/g, "");
}

function reconHeaderKey(value) {
  return reconNormText(String(value ?? "").replace(/[^\p{L}\p{N}]/gu, ""));
}

const RECON_COLUMNS = [
  { key: "policy", header: "НОМЕР НА ПОЛИЦА", label: "reconcile.col.policy", headers: ["НОМЕР НА ПОЛИЦА", "№ ПОЛИЦА", "ПОЛИЦА"] },
  { key: "blank", header: "НОМЕР НА СТИКЕР", label: "reconcile.col.blank", headers: ["НОМЕР НА СТИКЕР", "№ БЛАНКА", "БЛАНКА", "НОМЕР НА БЛАНКА"] },
  { key: "from", header: "ВАЛИДЕН ОТ", label: "reconcile.col.from", headers: ["ВАЛИДЕН ОТ", "ДАТА"] },
  { key: "to", header: "ВАЛИДЕН ДО", label: "reconcile.col.to", headers: ["ВАЛИДЕН ДО"], optional: true },
  { key: "car", header: "ДКН", label: "reconcile.col.car", headers: ["ДКН"] },
];

// Alternate "valid until" source: a term/duration column (e.g. "СРОК" with
// values like "15D", "1M", "3M") used when the file has no explicit "ВАЛИДЕН ДО".
const RECON_TERM_COLUMN = { key: "term", headers: ["СРОК", "ТЕРМИН", "ПЕРИОД"] };

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

function reconAddDays(ymd, days) {
  const m = ymd.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m || !Number.isFinite(days)) return "";
  const dt = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3] + days));
  return reconYmd(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}

function reconShowDate(ymd) {
  const m = (ymd || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : "";
}

function reconCellText(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

// Locate the header row and map each required column to its index. A column
// matches any of its accepted header spellings; "valid until" is satisfied by
// either an explicit "ВАЛИДЕН ДО" column or a term column ("СРОК" etc.).
function reconFindColumns(rows) {
  const limit = Math.min(rows.length, 50);
  const searchColumns = [...RECON_COLUMNS, RECON_TERM_COLUMN];
  let best = null;
  for (let r = 0; r < limit; r++) {
    const cells = rows[r] || [];
    const found = {};
    cells.forEach((cell, idx) => {
      const key = reconHeaderKey(cell);
      if (!key) return;
      for (const col of searchColumns) {
        if (found[col.key] !== undefined) continue;
        if (col.headers.some((h) => reconHeaderKey(h) === key)) {
          found[col.key] = idx;
        }
      }
    });
    const required = RECON_COLUMNS.filter((c) => !c.optional);
    const requiredFound = required.filter(
      (c) => found[c.key] !== undefined
    ).length;
    const toSatisfied = found.to !== undefined || found.term !== undefined;
    const score = requiredFound + (toSatisfied ? 1 : 0);
    const maxScore = required.length + 1;
    if (!best || score > best.score) best = { row: r, found, score };
    if (score === maxScore) break;
  }
  if (!best || best.score === 0) return { missing: RECON_COLUMNS };
  const missing = RECON_COLUMNS.filter((c) => {
    if (c.key === "to") {
      return best.found.to === undefined && best.found.term === undefined;
    }
    return !c.optional && best.found[c.key] === undefined;
  });
  return { headerRow: best.row, index: best.found, missing };
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

    const fromKey = reconFileDate(raw.from);
    let toRaw = reconCellText(raw.to);
    let toKey = reconFileDate(raw.to);
    if (!toKey && index.term !== undefined) {
      const termText = reconCellText(cells[index.term]);
      const days = reconTermDays(termText);
      if (days !== null && fromKey) {
        toKey = reconAddDays(fromKey, days);
        if (!toRaw) toRaw = termText;
      }
    }

    out.push({
      rowNo: r + 1,
      policy: reconCellText(raw.policy),
      blank: reconCellText(raw.blank),
      car: reconCellText(raw.car),
      fromRaw: reconCellText(raw.from),
      toRaw,
      fromKey,
      toKey,
    });
  }
  return out;
}

function reconDbValues(ins) {
  const start = reconDbDate(ins.StartDate);
  const duration = Number(ins.Duration);
  const end =
    start && ins.Duration !== null && ins.Duration !== undefined
      ? reconAddDays(start, duration)
      : "";
  return {
    policy: reconCellText(ins.PolicyNumber),
    blank: reconCellText(ins.BlancNumber),
    car: reconCellText(ins.CarNumber),
    fromKey: start,
    toKey: end,
  };
}

// Compare one file row with one insurance, returning per-field results.
function reconCompareRow(fileRow, ins) {
  const db = reconDbValues(ins);
  const fields = {
    policy: {
      file: fileRow.policy,
      db: db.policy,
      mismatch: reconNormId(fileRow.policy) !== reconNormId(db.policy),
    },
    blank: {
      file: fileRow.blank,
      db: db.blank,
      mismatch: reconNormId(fileRow.blank) !== reconNormId(db.blank),
    },
    from: {
      file: fileRow.fromKey ? reconShowDate(fileRow.fromKey) : fileRow.fromRaw,
      db: reconShowDate(db.fromKey),
      mismatch: !fileRow.fromKey || fileRow.fromKey !== db.fromKey,
    },
    to: {
      file: fileRow.toKey ? reconShowDate(fileRow.toKey) : fileRow.toRaw,
      db: reconShowDate(db.toKey),
      mismatch: !fileRow.toKey || fileRow.toKey !== db.toKey,
    },
    car: {
      file: fileRow.car,
      db: db.car,
      mismatch: reconNormCar(fileRow.car) !== reconNormCar(db.car),
    },
  };
  const count = Object.values(fields).filter((f) => f.mismatch).length;
  return { fields, count };
}

