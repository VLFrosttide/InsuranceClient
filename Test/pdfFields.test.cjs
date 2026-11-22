"use strict";

// Node test for the policy / blank number reader (/pdfFields.js).
//
// Runs the REAL module against small PDFs built in the test: the reader's own
// parsing (objects, Flate streams, ToUnicode maps, form XObjects) and the field
// rules (policy number from the file name, 8-character car number, the repeated
// 6-digit blank number under "Стикер").
//
// Run with:  node Test/pdfFields.test.cjs   (or: npm test)

const path = require("path");
const zlib = require("zlib");
const { pathToFileURL } = require("url");

const ROOT = path.join(__dirname, "..");

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log("  PASS  " + name);
  } catch (err) {
    failed++;
    console.log("  FAIL  " + name);
    console.log("        " + (err && err.stack ? err.stack : err));
  }
}
function eq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${label || "values differ"}: expected ${e}, got ${a}`);
}

// ---------------------------------------------------------------------------
// Minimal PDF builder
// ---------------------------------------------------------------------------
// Only what the reader looks at is written: numbered objects, dictionaries and
// (optionally compressed) streams. No xref table - the reader scans for
// "<num> 0 obj", exactly like it does for a real file.
function buildPdf(objects) {
  const parts = ["%PDF-1.6\n"];
  for (const object of objects) {
    parts.push(`${object.number} 0 obj\n${object.dict}\n`);
    if (object.stream !== undefined) {
      const data = Buffer.isBuffer(object.stream)
        ? object.stream
        : Buffer.from(String(object.stream), "latin1");
      parts.push("stream\n");
      parts.push(data);
      parts.push("\nendstream\n");
    }
    parts.push("endobj\n");
  }
  parts.push("trailer\n<< /Root 1 0 R >>\n%%EOF\n");
  return Buffer.concat(parts.map((part) => (Buffer.isBuffer(part) ? part : Buffer.from(part, "latin1"))));
}

const flate = (text) => ({
  data: zlib.deflateSync(Buffer.from(text, "latin1")),
});

// A one-page PDF. `content` is the page's stream text, `extra` holds further
// objects (fonts, forms) already numbered from 10 up.
function pagePdf({ content, pageResources = "/Font << /F1 5 0 R >>", compressed = false, extra = [] }) {
  const data = compressed ? flate(content).data : Buffer.from(content, "latin1");
  const filter = compressed ? "/Filter /FlateDecode" : "";
  return buildPdf([
    { number: 1, dict: "<< /Type /Catalog /Pages 2 0 R >>" },
    { number: 2, dict: "<< /Type /Pages /Kids [3 0 R] /Count 1 >>" },
    {
      number: 3,
      dict: `<< /Type /Page /Parent 2 0 R /Resources << ${pageResources} >> /Contents 4 0 R >>`,
    },
    { number: 4, dict: `<< /Length ${data.length} ${filter} >>`, stream: data },
    { number: 5, dict: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>" },
    ...extra,
  ]);
}

(async () => {
  const pdf = await import(pathToFileURL(path.join(ROOT, "pdfFields.js")).href);
  const {
    carNumberFromText,
    pdfFields,
    pdfText,
    policyNumberFromFilename,
    policyNumberFromText,
    stickerNumberFromText,
  } = pdf;

  // --- reading the PDF ------------------------------------------------------

  await check("text is read from a page's content stream", () => {
    const bytes = pagePdf({ content: "BT /F1 9 Tf 10 10 Td (Policy 26192158) Tj ET" });
    const text = pdfText(bytes);
    if (!text.includes("Policy 26192158")) {
      throw new Error("page text missing: " + JSON.stringify(text));
    }
  });

  await check("a Flate-compressed content stream is decompressed", () => {
    const bytes = pagePdf({ content: "BT /F1 9 Tf (34CGR718) Tj ET", compressed: true });
    eq(pdfText(bytes).trim(), "34CGR718", "compressed text");
  });

  await check("text inside a form XObject is followed", () => {
    const form = flate("BT /F1 9 Tf (34CGR718) Tj ET");
    const bytes = pagePdf({
      content: "BT /F1 9 Tf (car) Tj ET /Fm1 Do",
      pageResources: "/Font << /F1 5 0 R >> /XObject << /Fm1 10 0 R >>",
      extra: [
        {
          number: 10,
          dict:
            "<< /Type /XObject /Subtype /Form /Resources << /Font << /F1 5 0 R >> >>" +
            ` /BBox [0 0 100 20] /Length ${form.data.length} /Filter /FlateDecode >>`,
          stream: form.data,
        },
      ],
    });
    const text = pdfText(bytes);
    if (!text.includes("car") || !text.includes("34CGR718")) {
      throw new Error("form text missing: " + JSON.stringify(text));
    }
  });

  await check("a two-byte Identity-H font is decoded through its ToUnicode map", () => {
    const cmap = [
      "/CIDInit /ProcSet findresource begin",
      "begincmap",
      "1 begincodespacerange",
      "<0000> <FFFF>",
      "endcodespacerange",
      "1 beginbfrange",
      "<0001> <0002> <0421>",
      "endbfrange",
      "1 beginbfchar",
      "<0003> <0438>",
      "endbfchar",
      "endcmap",
    ].join("\n");
    const cmapStream = flate(cmap);
    const bytes = pagePdf({
      content: "BT /F2 9 Tf <000100020003> Tj ET",
      pageResources: "/Font << /F1 5 0 R /F2 10 0 R >>",
      extra: [
        {
          number: 10,
          dict:
            "<< /Type /Font /Subtype /Type0 /BaseFont /Sub /Encoding /Identity-H" +
            " /DescendantFonts [11 0 R] /ToUnicode 12 0 R >>",
        },
        { number: 11, dict: "<< /Type /Font /Subtype /CIDFontType2 /BaseFont /Sub >>" },
        {
          number: 12,
          dict: `<< /Length ${cmapStream.data.length} /Filter /FlateDecode >>`,
          stream: cmapStream.data,
        },
      ],
    });
    eq(pdfText(bytes).trim(), "СТи", "decoded Cyrillic");
  });

  await check("a file that is not a PDF yields no text and no fields", () => {
    const junk = Buffer.from("this is not a pdf at all", "latin1");
    eq(pdfText(junk), "", "no text");
    eq(
      pdfFields(junk, "BG_02_FI12345678.pdf"),
      { policyNumber: "12345678", carNumber: null, blancNumber: null },
      "name only"
    );
    eq(
      pdfFields(junk, "random.pdf"),
      { policyNumber: null, carNumber: null, blancNumber: null },
      "nothing"
    );
  });

  // --- policy number --------------------------------------------------------

  await check("the policy number comes from the file name after FI", () => {
    eq(policyNumberFromFilename("BG_02_FI26192158.pdf"), "26192158", "no space");
    eq(policyNumberFromFilename("BG_02_ FI26192158.pdf"), "26192158", "with space");
    eq(policyNumberFromFilename("BG_02_  FI 26192158.pdf"), "26192158", "spaces around");
  });

  await check("a file name without the BG_02_FI marker has no policy number", () => {
    eq(policyNumberFromFilename("8a15af00-0007-432b.pdf"), null, "random name");
    eq(policyNumberFromFilename("policy.pdf"), null, "plain name");
    eq(policyNumberFromFilename(""), null, "empty");
    eq(policyNumberFromFilename(undefined), null, "undefined");
  });

  await check("the printed BG/02/FI value is a fallback for the policy number", () => {
    eq(policyNumberFromText("... BG/02/FI26192158 ..."), "26192158", "slash form");
    eq(policyNumberFromText("BG / 02 / FI 26192158"), "26192158", "spaced form");
    eq(policyNumberFromText("nothing here"), null, "absent");
  });


  // --- car number -----------------------------------------------------------

  await check("an 8-character plate with letters and digits is found", () => {
    eq(carNumberFromText("Турция 34CGR718 2026"), "34CGR718", "Turkish plate");
    eq(carNumberFromText("59ADJ391"), "59ADJ391", "digits and letters");
  });

  await check("the plate that repeats (a field printed three times) wins", () => {
    const text = "AVCILAR 2026 Honda 34CGR718 2026\n34CGR718\n34CGR718";
    eq(carNumberFromText(text), "34CGR718", "repeated");
    eq(carNumberFromText("AB12CD34 then AB12CD34 then XY99ZZ11"), "AB12CD34", "most frequent");
  });

  await check("digit-only and letter-only 8-character tokens are not plates", () => {
    eq(carNumberFromText("policy 26192158"), null, "all digits");
    eq(carNumberFromText("İSTANBUL AVCILAR"), null, "all letters");
    eq(carNumberFromText("premium price total"), null, "words");
  });

  await check("Cyrillic lookalike letters are put back to Latin", () => {
    eq(carNumberFromText("СВ1234АВ"), "CB1234AB", "Cyrillic plate");
  });

  await check("tokens of another length are not plates", () => {
    eq(carNumberFromText("C1234AB"), null, "7 characters");
    eq(carNumberFromText("ABCD12345"), null, "9 characters");
    eq(carNumberFromText(""), null, "empty");
  });

  // --- blank (sticker) number ----------------------------------------------

  await check("the repeated 6-digit value under Стикер is the blank number", () => {
    const text = "СТИКЕР\nЗастраховка:\n8,50\n175973\n21.11.2026\nBG/02/FI26192158\n175973\n175973\n";
    eq(stickerNumberFromText(text), "175973", "repeated value");
  });

  await check("without the Стикер label no blank number is returned", () => {
    eq(stickerNumberFromText("149988 149988 149988"), null, "no label");
    eq(stickerNumberFromText(""), null, "empty");
  });

  await check("a price glued to a decimal separator is not a blank number", () => {
    eq(stickerNumberFromText("СТИКЕР 175973 35,799999"), "175973", "skips price");
    eq(stickerNumberFromText("СТИКЕР 35,791234"), null, "only a price");
  });

  await check("a single unambiguous 6-digit value is used", () => {
    eq(stickerNumberFromText("СТИКЕР\n149988\n"), "149988", "one value");
  });

  await check("several different 6-digit values with no repeat are ambiguous", () => {
    eq(stickerNumberFromText("СТИКЕР 149988 264758"), null, "ambiguous");
  });

  await check("8-digit (policy) and 9-digit (company) runs are skipped", () => {
    eq(stickerNumberFromText("СТИКЕР 26192158 831830482 175973 175973"), "175973", "only the 6-digit one");
  });

  // --- whole-document rules -------------------------------------------------

  await check("the policy PDF gives the policy and car number, never a blank", () => {
    const bytes = pagePdf({ content: "BT /F1 9 Tf (Турция 34CGR718 175973 175973) Tj ET" });
    eq(
      pdfFields(bytes, "BG_02_ FI26192158.pdf"),
      { policyNumber: "26192158", carNumber: "34CGR718", blancNumber: null },
      "policy pdf"
    );
  });

  await check("the sticker PDF gives the blank number and the policy number", () => {
    // The page font here is one-byte (WinAnsi), so the label is written the
    // English way; the Cyrillic label a real sticker PDF carries is covered by
    // the Стикер checks above and by the Identity-H font check.
    const bytes = pagePdf({
      content: "BT /F1 9 Tf (STICKER BG/02/FI26192158 175973 175973) Tj ET",
    });
    eq(
      pdfFields(bytes, "8a15af00-0007-432b-826f-ec20ecc434d2.pdf"),
      { policyNumber: "26192158", carNumber: null, blancNumber: "175973" },
      "sticker pdf"
    );
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();

