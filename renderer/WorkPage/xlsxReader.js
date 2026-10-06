"use strict";

// Minimal, dependency-free .xlsx reader for the renderer process.
//
// An .xlsx file is a ZIP archive of XML documents. We read the ZIP central
// directory ourselves, inflate entries with the browser's built-in
// DecompressionStream, and parse the first worksheet with DOMParser.
//
// Exposes a single global: readXlsxFirstSheet(arrayBuffer) -> Promise<Array<Array<string|number>>>
// (rows of cell values; numbers stay numbers, everything else is a string).

async function xlsxInflateRaw(bytes) {
  const stream = new Blob([bytes])
    .stream()
    .pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function xlsxReadZipDirectory(buffer) {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  const decoder = new TextDecoder("utf-8");

  let eocd = -1;
  const lowest = Math.max(0, buffer.byteLength - 65557);
  for (let i = buffer.byteLength - 22; i >= lowest; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("Not a valid .xlsx file");

  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const entries = new Map();

  for (let i = 0; i < count; i++) {
    if (view.getUint32(p, true) !== 0x02014b50) break;
    const method = view.getUint16(p + 10, true);
    const compressedSize = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const localOffset = view.getUint32(p + 42, true);
    const name = decoder.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    entries.set(name, { method, compressedSize, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }

  async function read(name) {
    const entry = entries.get(name);
    if (!entry) return null;
    const lo = entry.localOffset;
    if (view.getUint32(lo, true) !== 0x04034b50) {
      throw new Error("Corrupted .xlsx file");
    }
    const start =
      lo + 30 + view.getUint16(lo + 26, true) + view.getUint16(lo + 28, true);
    const data = bytes.subarray(start, start + entry.compressedSize);
    if (entry.method === 0) return decoder.decode(data);
    if (entry.method === 8) return decoder.decode(await xlsxInflateRaw(data));
    throw new Error("Unsupported compression in .xlsx file");
  }

  return { read, has: (name) => entries.has(name) };
}

function xlsxParseXml(text) {
  const doc = new DOMParser().parseFromString(text, "application/xml");
  if (doc.getElementsByTagName("parsererror").length) {
    throw new Error("Corrupted .xlsx file");
  }
  return doc;
}

function xlsxByLocal(node, name) {
  return Array.from(node.getElementsByTagNameNS("*", name));
}

// Convert a column reference such as "AB12" to a zero-based column index.
function xlsxColumnIndex(ref) {
  const letters = (ref || "").replace(/[^A-Za-z]/g, "").toUpperCase();
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

async function readXlsxFirstSheet(buffer) {
  const zip = xlsxReadZipDirectory(buffer);

  // Shared strings table (optional).
  const shared = [];
  const sstText = await zip.read("xl/sharedStrings.xml");
  if (sstText) {
    const sstDoc = xlsxParseXml(sstText);
    for (const si of xlsxByLocal(sstDoc, "si")) {
      // Skip phonetic runs (rPh) so only the visible text is kept.
      let text = "";
      for (const tNode of xlsxByLocal(si, "t")) {
        if (tNode.parentNode && tNode.parentNode.localName === "rPh") continue;
        text += tNode.textContent;
      }
      shared.push(text);
    }
  }

  // Resolve the first worksheet path via workbook.xml + its relationships.
  let sheetPath = "xl/worksheets/sheet1.xml";
  const wbText = await zip.read("xl/workbook.xml");
  const relsText = await zip.read("xl/_rels/workbook.xml.rels");
  if (wbText && relsText) {
    const firstSheet = xlsxByLocal(xlsxParseXml(wbText), "sheet")[0];
    if (firstSheet) {
      const relId =
        firstSheet.getAttributeNS(
          "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
          "id"
        ) || firstSheet.getAttribute("r:id");
      const rel = xlsxByLocal(xlsxParseXml(relsText), "Relationship").find(
        (r) => r.getAttribute("Id") === relId
      );
      if (rel) {
        const target = rel.getAttribute("Target") || "";
        sheetPath = target.startsWith("/")
          ? target.slice(1)
          : `xl/${target.replace(/^\.\//, "")}`;
      }
    }
  }

  const sheetText = await zip.read(sheetPath);
  if (!sheetText) throw new Error("Worksheet not found in .xlsx file");
  const sheetDoc = xlsxParseXml(sheetText);

  const rows = [];
  for (const rowNode of xlsxByLocal(sheetDoc, "row")) {
    const rowIndex = Number(rowNode.getAttribute("r"));
    const cells = [];
    let nextCol = 0;
    for (const c of xlsxByLocal(rowNode, "c")) {
      const ref = c.getAttribute("r");
      const col = ref ? xlsxColumnIndex(ref) : nextCol;
      nextCol = col + 1;

      const type = c.getAttribute("t");
      const vNode = xlsxByLocal(c, "v")[0];
      let value = "";
      if (type === "inlineStr") {
        value = xlsxByLocal(c, "t")
          .map((n) => n.textContent)
          .join("");
      } else if (vNode) {
        const raw = vNode.textContent;
        if (type === "s") value = shared[Number(raw)] ?? "";
        else if (type === "str" || type === "e" || type === "b") value = raw;
        else {
          const num = Number(raw);
          value = raw !== "" && Number.isFinite(num) ? num : raw;
        }
      }
      cells[col] = value;
    }
    for (let i = 0; i < cells.length; i++) {
      if (cells[i] === undefined) cells[i] = "";
    }
    // Keep row positions stable so "row N" in reports matches Excel.
    const target =
      Number.isFinite(rowIndex) && rowIndex > 0 ? rowIndex - 1 : rows.length;
    while (rows.length < target) rows.push([]);
    rows[target] = cells;
  }
  return rows;
}
