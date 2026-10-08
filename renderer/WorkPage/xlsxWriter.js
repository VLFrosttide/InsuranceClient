"use strict";

// Minimal, dependency-free Excel (.xlsx) writer for the renderer process.
//
// Counterpart of xlsxReader.js: builds a single-sheet OOXML workbook (a ZIP
// archive of XML documents) entirely in memory. Entries are "stored" (not
// compressed), which every spreadsheet program accepts and keeps the code
// synchronous and small.
//
// Exposes two globals:
//   buildXlsxFile({ sheetName, columns, rows }) -> Uint8Array (the .xlsx bytes)
//     columns: [{ label: string, width?: number }]   (header row, bold + frozen)
//     rows:    [[cell, ...], ...] where a cell is
//                null/undefined/""                 -> empty cell
//                number                            -> numeric cell
//                string                            -> text cell
//                { value: number, style: "money" } -> number shown as 0.00
//                { value: number, style: "date" }  -> Excel date serial shown
//                                                     as dd.mm.yyyy hh:mm
//   xlsxDateSerial(date) -> number | null
//     Excel serial (days since 1899-12-30) of a Date's LOCAL wall-clock time.

const XLSX_STYLE = { header: 1, money: 2, date: 3 };

// --- ZIP (stored entries) ----------------------------------------------------

let xlsxCrcTable = null;
function xlsxCrc32(bytes) {
  if (!xlsxCrcTable) {
    xlsxCrcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      xlsxCrcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = xlsxCrcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function xlsxZip(files) {
  const encoder = new TextEncoder();
  const now = new Date();
  const dosTime =
    (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate =
    ((Math.max(now.getFullYear(), 1980) - 1980) << 9) |
    ((now.getMonth() + 1) << 5) |
    now.getDate();

  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const file of files) {
    const name = encoder.encode(file.name);
    const data = encoder.encode(file.content);
    const crc = xlsxCrc32(data);

    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true); // version needed
    lv.setUint16(6, 0x0800, true); // flags: UTF-8 names
    lv.setUint16(8, 0, true); // method: stored
    lv.setUint16(10, dosTime, true);
    lv.setUint16(12, dosDate, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, name.length, true);
    lv.setUint16(28, 0, true); // extra length
    local.set(name, 30);

    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true); // version made by
    cv.setUint16(6, 20, true); // version needed
    cv.setUint16(8, 0x0800, true); // flags: UTF-8 names
    cv.setUint16(10, 0, true); // method: stored
    cv.setUint16(12, dosTime, true);
    cv.setUint16(14, dosDate, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, name.length, true);
    // extra/comment length, disk start and attributes stay 0.
    cv.setUint32(42, offset, true);
    central.set(name, 46);

    locals.push(local, data);
    centrals.push(central);
    offset += local.length + data.length;
  }

  const centralSize = centrals.reduce((sum, c) => sum + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);

  const parts = [...locals, ...centrals, eocd];
  const out = new Uint8Array(parts.reduce((sum, p) => sum + p.length, 0));
  let p = 0;
  for (const part of parts) {
    out.set(part, p);
    p += part.length;
  }
  return out;
}

// --- XML / cell helpers --------------------------------------------------------

function xlsxEscape(value) {
  return (
    String(value)
      // Control characters are not allowed in XML 1.0.
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
  );
}

// Zero-based column index -> "A", "B", …, "Z", "AA", …
function xlsxColumnName(index) {
  let n = index + 1;
  let name = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    name = String.fromCharCode(65 + rem) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
}

// Excel sheet names: at most 31 characters, none of []:*?/\ and not blank.
function xlsxSheetName(name) {
  const clean = String(name || "")
    .replace(/[\[\]:*?\/\\]/g, " ")
    .trim()
    .slice(0, 31);
  return clean || "Sheet1";
}

function xlsxDateSerial(date) {
  // toString check instead of instanceof so Dates from another realm count.
  if (
    Object.prototype.toString.call(date) !== "[object Date]" ||
    !Number.isFinite(date.getTime())
  ) {
    return null;
  }
  const utc = Date.UTC(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
    date.getHours(),
    date.getMinutes(),
    date.getSeconds()
  );
  return (utc - Date.UTC(1899, 11, 30)) / 86400000;
}

function xlsxCell(ref, cell, defaultStyle) {
  if (cell === undefined || cell === null || cell === "") return "";
  let value = cell;
  let style = defaultStyle || 0;
  if (typeof cell === "object") {
    value = cell.value;
    style = XLSX_STYLE[cell.style] || style;
    if (value === undefined || value === null || value === "") return "";
  }
  const s = style ? ` s="${style}"` : "";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return "";
    return `<c r="${ref}"${s}><v>${value}</v></c>`;
  }
  return (
    `<c r="${ref}"${s} t="inlineStr"><is>` +
    `<t xml:space="preserve">${xlsxEscape(value)}</t></is></c>`
  );
}


// --- workbook ----------------------------------------------------------------

const XLSX_XML_HEAD = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n`;
const XLSX_NS_MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const XLSX_NS_REL =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const XLSX_NS_PKG_REL =
  "http://schemas.openxmlformats.org/package/2006/relationships";

function buildXlsxFile({ sheetName, columns, rows } = {}) {
  const cols = Array.isArray(columns) ? columns : [];
  const body = Array.isArray(rows) ? rows : [];
  const name = xlsxSheetName(sheetName);
  const lastCol = xlsxColumnName(Math.max(cols.length, 1) - 1);
  const lastRow = body.length + 1;

  const sheetRows = [
    `<row r="1">` +
      cols
        .map((c, i) =>
          xlsxCell(`${xlsxColumnName(i)}1`, c.label ?? "", XLSX_STYLE.header)
        )
        .join("") +
      `</row>`,
  ];
  body.forEach((cells, r) => {
    const rowNo = r + 2;
    sheetRows.push(
      `<row r="${rowNo}">` +
        (cells || [])
          .map((cell, i) => xlsxCell(`${xlsxColumnName(i)}${rowNo}`, cell))
          .join("") +
        `</row>`
    );
  });

  const colsXml = cols.length
    ? `<cols>` +
      cols
        .map((c, i) => {
          const w = Number(c.width) > 0 ? Number(c.width) : 14;
          return `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`;
        })
        .join("") +
      `</cols>`
    : "";

  // Header row frozen + an auto-filter over the whole table.
  const sheetXml =
    XLSX_XML_HEAD +
    `<worksheet xmlns="${XLSX_NS_MAIN}" xmlns:r="${XLSX_NS_REL}">` +
    `<sheetViews><sheetView workbookViewId="0">` +
    `<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>` +
    `</sheetView></sheetViews>` +
    `<sheetFormatPr defaultRowHeight="15"/>` +
    colsXml +
    `<sheetData>${sheetRows.join("")}</sheetData>` +
    (cols.length ? `<autoFilter ref="A1:${lastCol}${lastRow}"/>` : "") +
    `</worksheet>`;

  const quotedName = `'${name.replace(/'/g, "''")}'`;
  const workbookXml =
    XLSX_XML_HEAD +
    `<workbook xmlns="${XLSX_NS_MAIN}" xmlns:r="${XLSX_NS_REL}">` +
    `<sheets><sheet name="${xlsxEscape(name)}" sheetId="1" r:id="rId1"/></sheets>` +
    (cols.length
      ? `<definedNames><definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">` +
        `${xlsxEscape(quotedName)}!$A$1:$${lastCol}$${lastRow}` +
        `</definedName></definedNames>`
      : "") +
    `</workbook>`;

  // cellXfs indexes must match XLSX_STYLE: 1 = bold header, 2 = "0.00",
  // 3 = "dd.mm.yyyy hh:mm".
  const stylesXml =
    XLSX_XML_HEAD +
    `<styleSheet xmlns="${XLSX_NS_MAIN}">` +
    `<numFmts count="1"><numFmt numFmtId="164" formatCode="dd.mm.yyyy hh:mm"/></numFmts>` +
    `<fonts count="2">` +
    `<font><sz val="11"/><name val="Calibri"/><family val="2"/></font>` +
    `<font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font>` +
    `</fonts>` +
    `<fills count="2"><fill><patternFill patternType="none"/></fill>` +
    `<fill><patternFill patternType="gray125"/></fill></fills>` +
    `<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>` +
    `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
    `<cellXfs count="4">` +
    `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>` +
    `<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>` +
    `<xf numFmtId="2" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>` +
    `<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>` +
    `</cellXfs>` +
    `<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>` +
    `</styleSheet>`;

  const ct = "application/vnd.openxmlformats-officedocument.spreadsheetml";
  const contentTypesXml =
    XLSX_XML_HEAD +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Override PartName="/xl/workbook.xml" ContentType="${ct}.sheet.main+xml"/>` +
    `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="${ct}.worksheet+xml"/>` +
    `<Override PartName="/xl/styles.xml" ContentType="${ct}.styles+xml"/>` +
    `</Types>`;

  const rootRelsXml =
    XLSX_XML_HEAD +
    `<Relationships xmlns="${XLSX_NS_PKG_REL}">` +
    `<Relationship Id="rId1" Type="${XLSX_NS_REL}/officeDocument" Target="xl/workbook.xml"/>` +
    `</Relationships>`;

  const workbookRelsXml =
    XLSX_XML_HEAD +
    `<Relationships xmlns="${XLSX_NS_PKG_REL}">` +
    `<Relationship Id="rId1" Type="${XLSX_NS_REL}/worksheet" Target="worksheets/sheet1.xml"/>` +
    `<Relationship Id="rId2" Type="${XLSX_NS_REL}/styles" Target="styles.xml"/>` +
    `</Relationships>`;

  return xlsxZip([
    { name: "[Content_Types].xml", content: contentTypesXml },
    { name: "_rels/.rels", content: rootRelsXml },
    { name: "xl/workbook.xml", content: workbookXml },
    { name: "xl/_rels/workbook.xml.rels", content: workbookRelsXml },
    { name: "xl/styles.xml", content: stylesXml },
    { name: "xl/worksheets/sheet1.xml", content: sheetXml },
  ]);
}

