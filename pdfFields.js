"use strict";
// Reading the policy / blank numbers out of the two PDFs the insurer prints.
//
// When a policy is processed, an external tool downloads two PDFs to the
// Desktop (see the Desktop PDF watcher in main.js):
//   - the policy itself, named "BG_02_ FI<policy>.pdf",
//   - the blank/sticker document, named after a random upload id.
// The add-insurance form is pre-filled from them:
//   - policy number: the "FI<policy>" part of the policy PDF's file name
//     (no PDF reading needed - the name already carries it),
//   - car (registration) number: the 8-character token that mixes letters and
//     digits and repeats, read from whichever of the two PDFs carries it,
//   - blank number: "Стикер" in the other PDF followed by a 6-digit value.
//
// The PDFs are printed from this app, so they can also be read back here. The
// text is extracted with a small built-in reader (below) instead of a PDF
// dependency: the files are simple, single-page, classic-xref PDFs whose text
// sits in form XObjects with ToUnicode maps, and keeping the reader in-house
// means no extra package to ship or keep updated.
//
// No Electron dependency (the caller passes bytes), so the module can be tested
// with plain Node (see Test/pdfFields.test.cjs).

import zlib from "node:zlib";

// ---------------------------------------------------------------------------
// PDF object table
// ---------------------------------------------------------------------------
// A PDF is a list of "<num> <gen> obj ... endobj" entries. Only the parts this
// reader needs are kept: each object's dictionary text and, when it has one,
// its raw stream bytes. Object and cross-reference streams (PDF 1.5+) are not
// used by these files, so a plain scan over the whole file is enough and the
// xref table never has to be resolved.
//
// The file is decoded as "latin1" for scanning, so one character is exactly one
// byte and string offsets are also byte offsets - the stream bytes are cut with
// those offsets straight out of the Buffer.
function inflateBytes(bytes) {
  // Some producers write a zlib stream, some a raw deflate stream.
  try {
    return zlib.inflateSync(bytes);
  } catch (err) {
    try {
      return zlib.inflateRawSync(bytes);
    } catch (err2) {
      return null;
    }
  }
}

export function pdfObjects(buffer) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  const source = bytes.toString("latin1");
  const objects = new Map();
  const header = /(\d+)\s+(\d+)\s+obj\b/g;
  let match;
  while ((match = header.exec(source))) {
    const number = Number(match[1]);
    const start = match.index + match[0].length;
    const endObject = source.indexOf("endobj", start);
    const objectEnd = endObject === -1 ? source.length : endObject;
    const streamAt = source.indexOf("stream", start);

    let dictEnd = objectEnd;
    let stream = null;
    if (streamAt !== -1 && streamAt < objectEnd) {
      dictEnd = streamAt;
      let dataStart = streamAt + "stream".length;
      // The keyword is followed by CRLF or LF before the data.
      if (source[dataStart] === "\r") dataStart += 1;
      if (source[dataStart] === "\n") dataStart += 1;
      const endStream = source.indexOf("endstream", dataStart);
      let dataEnd = endStream === -1 ? source.length : endStream;
      // ... and by an EOL after the data.
      if (dataEnd > dataStart && bytes[dataEnd - 1] === 0x0a) dataEnd -= 1;
      if (dataEnd > dataStart && bytes[dataEnd - 1] === 0x0d) dataEnd -= 1;
      stream = bytes.subarray(dataStart, dataEnd);
    }

    if (!objects.has(number)) {
      objects.set(number, { dict: source.slice(start, dictEnd), stream });
    }
    header.lastIndex = Math.max(header.lastIndex, objectEnd);
  }
  return objects;
}

// The bytes of an object's stream, decompressed when it is Flate-encoded.
// Streams that stay encoded (images, JPEG, ...) and objects without a stream
// return null, so callers can tell "no text here" from "empty text".
export function decodedStream(object) {
  if (!object || !object.stream) return null;
  if (/\/Filter\s*\/FlateDecode/.test(object.dict)) return inflateBytes(object.stream);
  if (/\/Filter/.test(object.dict)) return null;
  return object.stream;
}

// ---------------------------------------------------------------------------
// Fonts
// ---------------------------------------------------------------------------
// A PDF string holds character codes, not characters. For the fonts used in
// these files (Identity-H CID fonts with Cyrillic text) the codes are two-byte
// glyph ids, which only the font's /ToUnicode CMap can turn into text. Simple
// one-byte fonts (WinAnsiEncoding) are read directly.
//
// The CMap lists pairs - "bfchar" one code at a time, "bfrange" a run of codes -
// and the code length comes from its "codespacerange".
function hexToText(hex) {
  const clean = String(hex || "").replace(/[^0-9A-Fa-f]/g, "");
  let text = "";
  for (let i = 0; i + 4 <= clean.length; i += 4) {
    text += String.fromCharCode(parseInt(clean.slice(i, i + 4), 16));
  }
  if (!text && clean.length === 2) text = String.fromCharCode(parseInt(clean, 16));
  return text;
}

export function parseToUnicode(text) {
  const map = new Map();
  let codeLength = 1;

  const space = String(text || "").match(/begincodespacerange([\s\S]*?)endcodespacerange/);
  if (space) {
    const hexes = space[1].match(/<([0-9A-Fa-f]+)>/g) || [];
    if (hexes.length) codeLength = hexes[0].replace(/[<>]/g, "").length / 2;
  }

  const sections =
    String(text || "").match(/beginbfchar[\s\S]*?endbfchar|beginbfrange[\s\S]*?endbfrange/g) || [];
  for (const section of sections) {
    if (section.startsWith("beginbfchar")) {
      const pair = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g;
      let hit;
      while ((hit = pair.exec(section))) {
        map.set(parseInt(hit[1], 16), hexToText(hit[2]));
      }
      continue;
    }
    const range = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(<[0-9A-Fa-f]+>|\[[^\]]*\])/g;
    let hit;
    while ((hit = range.exec(section))) {
      const low = parseInt(hit[1], 16);
      const high = parseInt(hit[2], 16);
      const target = hit[3];
      if (target.startsWith("[")) {
        const parts = target.match(/<([0-9A-Fa-f]+)>/g) || [];
        parts.forEach((part, index) => {
          if (low + index <= high) map.set(low + index, hexToText(part.replace(/[<>]/g, "")));
        });
        continue;
      }
      const base = target.replace(/[<>]/g, "");
      const first = parseInt(base.slice(-4), 16);
      for (let code = low; code <= high; code += 1) {
        map.set(code, String.fromCharCode(first + (code - low)));
      }
    }
  }
  return { map, codeLength: codeLength || 1 };
}

// A function that turns one PDF string's bytes into text for a font object.
export function fontDecoder(objects, fontNumber, cache) {
  const cached = cache && cache.get(fontNumber);
  if (cached) return cached;

  let decoder = null;
  const font = objects.get(fontNumber);
  if (font) {
    const toUnicodeRef = font.dict.match(/\/ToUnicode\s+(\d+)\s+\d+\s+R/);
    if (toUnicodeRef) {
      const cmap = decodedStream(objects.get(Number(toUnicodeRef[1])));
      if (cmap) {
        const { map, codeLength } = parseToUnicode(cmap.toString("latin1"));
        decoder = (bytes) => {
          let text = "";
          for (let i = 0; i + codeLength <= bytes.length; i += codeLength) {
            let code = 0;
            for (let k = 0; k < codeLength; k += 1) code = (code << 8) | bytes[i + k];
            text += map.get(code) || "";
          }
          return text;
        };
      }
    }
    if (!decoder) {
      // No map: a two-byte (Identity) font only yields its code numbers, a
      // one-byte font is read as written.
      const twoByte = /\/Subtype\s*\/Type0/.test(font.dict);
      decoder = (bytes) => {
        if (!twoByte) return bytes.toString("latin1");
        let text = "";
        for (let i = 0; i + 1 < bytes.length; i += 2) {
          text += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
        }
        return text;
      };
    }
  }
  if (!decoder) decoder = (bytes) => bytes.toString("latin1");
  if (cache) cache.set(fontNumber, decoder);
  return decoder;
}

// ---------------------------------------------------------------------------
// Resources
// ---------------------------------------------------------------------------
// A page (and a form XObject) names its fonts and nested forms in /Resources:
//   /Font << /Verdana 2 0 R >>      /XObject << /Fm0 7 0 R >>
// The dictionary may also be an indirect reference, and a form without its own
// /Resources uses the parent's.
function braceDict(dict, key) {
  // The "<<" ... ">>" group that follows "/key", either written inline or behind
  // a reference. Returns its inner text or its object number, null when absent.
  const at = dict.search(new RegExp("/" + key + "\\b"));
  if (at === -1) return null;
  const rest = dict.slice(at);
  const ref = rest.match(new RegExp("^/" + key + "\\s+(\\d+)\\s+\\d+\\s+R"));
  if (ref) return { ref: Number(ref[1]) };
  if (!new RegExp("^/" + key + "\\s*<<").test(rest)) return null;

  let depth = 0;
  let start = -1;
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === "<" && rest[i + 1] === "<") {
      depth += 1;
      if (depth === 1) start = i + 2;
      i += 1;
    } else if (rest[i] === ">" && rest[i + 1] === ">") {
      depth -= 1;
      i += 1;
      if (depth === 0) return { text: rest.slice(start, i - 1) };
    }
  }
  return null;
}

function resourceDict(objects, dict, key) {
  const found = dict ? braceDict(dict, key) : null;
  if (!found) return null;
  if (found.text !== undefined) return found.text;
  const target = objects.get(found.ref);
  return target ? target.dict : null;
}

// "/Name 12 0 R" pairs of a resource dictionary -> Map(name, object number).
function referencedNames(dict) {
  const map = new Map();
  if (!dict) return map;
  const pair = /\/([^\s/<>[\]()]+)\s+(\d+)\s+\d+\s+R/g;
  let hit;
  while ((hit = pair.exec(dict))) map.set(hit[1], Number(hit[2]));
  return map;
}

// ---------------------------------------------------------------------------
// Content streams
// ---------------------------------------------------------------------------
// A content stream is a list of operands and operators: "(text) Tj", "[ (a) -20
// (b) ] TJ", "/Verdana 9 Tf", "/Fm0 Do", "1 0 0 1 x y Tm". It is scanned into
// tokens first so strings keep their bytes (they may hold any value, including
// the bytes PDF uses for delimiters), then interpreted for its text.

const CONTENT_SPACE = new Set([" ", "\n", "\r", "\t", "\f", "\0"]);
const CONTENT_DELIMITERS = "()<>[]{}/%";

function unescapeLiteral(raw) {
  const bytes = [];
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (ch !== "\\") {
      bytes.push(raw.charCodeAt(i) & 0xff);
      continue;
    }
    i += 1;
    const next = raw[i];
    if (next === "n") bytes.push(10);
    else if (next === "r") bytes.push(13);
    else if (next === "t") bytes.push(9);
    else if (next === "b") bytes.push(8);
    else if (next === "f") bytes.push(12);
    else if (next === "(" || next === ")" || next === "\\") bytes.push(next.charCodeAt(0));
    else if (next >= "0" && next <= "7") {
      let octal = next;
      while (octal.length < 3 && raw[i + 1] >= "0" && raw[i + 1] <= "7") {
        i += 1;
        octal += raw[i];
      }
      bytes.push(parseInt(octal, 8) & 0xff);
    } else if (next === "\r") {
      if (raw[i + 1] === "\n") i += 1;
    } else if (next !== "\n" && next !== undefined) {
      bytes.push(next.charCodeAt(0) & 0xff);
    }
  }
  return Buffer.from(bytes);
}

function hexBytes(hex) {
  const clean = hex.replace(/[^0-9A-Fa-f]/g, "");
  return Buffer.from(clean.length % 2 ? clean + "0" : clean, "hex");
}

export function contentTokens(source) {
  const tokens = [];
  const text = String(source || "");
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (CONTENT_SPACE.has(ch)) {
      i += 1;
      continue;
    }
    if (ch === "%") {
      while (i < text.length && text[i] !== "\n" && text[i] !== "\r") i += 1;
      continue;
    }
    if (ch === "(") {
      let depth = 1;
      let raw = "";
      let j = i + 1;
      while (j < text.length && depth > 0) {
        const c = text[j];
        if (c === "\\") {
          raw += c + (text[j + 1] || "");
          j += 2;
          continue;
        }
        if (c === "(") depth += 1;
        else if (c === ")") {
          depth -= 1;
          if (depth === 0) break;
        }
        raw += c;
        j += 1;
      }
      tokens.push({ type: "string", bytes: unescapeLiteral(raw) });
      i = j + 1;
      continue;
    }
    if (ch === "<" && text[i + 1] === "<") {
      tokens.push({ type: "op", value: "<<" });
      i += 2;
      continue;
    }
    if (ch === ">" && text[i + 1] === ">") {
      tokens.push({ type: "op", value: ">>" });
      i += 2;
      continue;
    }
    if (ch === "<") {
      const end = text.indexOf(">", i + 1);
      tokens.push({
        type: "string",
        bytes: hexBytes(text.slice(i + 1, end === -1 ? text.length : end)),
      });
      i = (end === -1 ? text.length : end) + 1;
      continue;
    }
    if ("[]{})>".includes(ch)) {
      tokens.push({ type: "op", value: ch });
      i += 1;
      continue;
    }
    if (ch === "/") {
      let j = i + 1;
      let name = "";
      while (j < text.length && !CONTENT_SPACE.has(text[j]) && !CONTENT_DELIMITERS.includes(text[j])) {
        name += text[j];
        j += 1;
      }
      tokens.push({
        type: "name",
        value: name.replace(/#([0-9A-Fa-f]{2})/g, (m, h) => String.fromCharCode(parseInt(h, 16))),
      });
      i = j;
      continue;
    }
    let j = i;
    let word = "";
    while (j < text.length && !CONTENT_SPACE.has(text[j]) && !CONTENT_DELIMITERS.includes(text[j])) {
      word += text[j];
      j += 1;
    }
    if (!word) {
      i += 1;
      continue;
    }
    if (/^[-+]?(?:\d+\.?\d*|\.\d+)$/.test(word)) tokens.push({ type: "number", value: Number(word) });
    else tokens.push({ type: "op", value: word });
    i = j;
  }
  return tokens;
}


// Walk one content stream, appending the text it draws. "Do" enters the form
// XObjects it names (the PDFs draw each field of the policy as a form), so the
// text is followed one level deeper instead of being missed.
function streamText(objects, bytes, resources, decoders, depth) {
  if (!bytes || depth > 8) return "";
  const fonts = referencedNames(resourceDict(objects, resources, "Font"));
  const xobjects = referencedNames(resourceDict(objects, resources, "XObject"));
  const tokens = contentTokens(bytes.toString("latin1"));
  const firstFont = fonts.size ? [...fonts.values()][0] : null;

  let text = "";
  let font = firstFont;
  let operands = [];
  let array = null; // collected "[" ... "]" while inside a TJ operand

  const write = (chunk) => {
    if (!chunk) return;
    text += chunk;
  };
  const newline = () => {
    if (text && !text.endsWith("\n")) text += "\n";
  };
  const decode = (bytesIn) => (font === null ? bytesIn.toString("latin1") : fontDecoder(objects, font, decoders)(bytesIn));

  for (const token of tokens) {
    if (token.type !== "op") {
      if (array) array.items.push(token);
      else operands.push(token);
      continue;
    }
    if (token.value === "[") {
      array = { type: "array", items: [] };
      continue;
    }
    if (token.value === "]") {
      if (array) operands.push(array);
      array = null;
      continue;
    }

    switch (token.value) {
      case "BT":
        newline();
        operands = [];
        break;
      case "Tf": {
        const name = operands.filter((t) => t.type === "name").pop();
        if (name && fonts.has(name.value)) font = fonts.get(name.value);
        operands = [];
        break;
      }
      case "Tj": {
        const string = operands.filter((t) => t.type === "string").pop();
        if (string) write(decode(string.bytes));
        operands = [];
        break;
      }
      case "TJ": {
        const list = operands.filter((t) => t.type === "array").pop();
        if (list) {
          for (const item of list.items) {
            if (item.type === "string") write(decode(item.bytes));
            // A wide negative gap is a word space; small ones are kerning.
            else if (item.type === "number" && item.value < -100) write(" ");
          }
        }
        operands = [];
        break;
      }
      case "'":
      case '"': {
        newline();
        const string = operands.filter((t) => t.type === "string").pop();
        if (string) write(decode(string.bytes));
        operands = [];
        break;
      }
      case "Td":
      case "TD":
      case "T*":
      case "Tm":
        // A new position on the page: keep the text readable line by line.
        newline();
        operands = [];
        break;
      case "Do": {
        const name = operands.filter((t) => t.type === "name").pop();
        const form = name ? objects.get(xobjects.get(name.value)) : null;
        if (form && /\/Subtype\s*\/Form/.test(form.dict)) {
          const own = resourceDict(objects, form.dict, "Resources") || resources;
          const inner = streamText(objects, decodedStream(form), own, decoders, depth + 1);
          // Each form is one field of the policy, so its text is kept apart
          // from its neighbours instead of running into them.
          if (inner) {
            newline();
            write(inner);
            newline();
          }
        }
        operands = [];
        break;
      }
      default:
        operands = [];
    }
  }
  return text;
}

// ---------------------------------------------------------------------------
// Page walk
// ---------------------------------------------------------------------------
// Only the page's own streams are used; its /Contents may be one stream or an
// array of them, and every text-bearing XObject is reached from there.
function pageObjectNumbers(objects) {
  const pages = [];
  for (const [number, object] of objects) {
    if (/\/Type\s*\/Page\b/.test(object.dict) && !/\/Type\s*\/Pages\b/.test(object.dict)) {
      pages.push(number);
    }
  }
  return pages;
}

function pageContentNumbers(dict) {
  const single = dict.match(/\/Contents\s+(\d+)\s+\d+\s+R/);
  if (single) return [Number(single[1])];
  const list = dict.match(/\/Contents\s*\[([\s\S]*?)\]/);
  if (!list) return [];
  return (list[1].match(/(\d+)\s+\d+\s+R/g) || []).map((ref) => Number(ref.match(/\d+/)[0]));
}

// All the text of a PDF, page after page, one line per text run.
export function pdfText(buffer) {
  let objects;
  try {
    objects = pdfObjects(buffer);
  } catch (err) {
    return "";
  }
  const decoders = new Map();
  let text = "";
  for (const pageNumber of pageObjectNumbers(objects)) {
    const page = objects.get(pageNumber);
    const resources = resourceDict(objects, page.dict, "Resources");
    for (const contentNumber of pageContentNumbers(page.dict)) {
      text += streamText(objects, decodedStream(objects.get(contentNumber)), resources, decoders, 0);
      text += "\n";
    }
  }
  return text;
}


// ---------------------------------------------------------------------------
// Fields
// ---------------------------------------------------------------------------
// The policy PDF is named "BG_02_ FI<policy>.pdf" by the insurer (the same
// shape the Desktop watcher already uses to tell the two PDFs apart), so its
// policy number needs no PDF reading at all.
export function policyPdfName(filename) {
  return /^BG_02_\s*FI/i.test(String(filename || ""));
}

//   policyNumberFromFilename("BG_02_ FI26192158.pdf") -> "26192158"
//   policyNumberFromFilename("BG_02_FI26192158.pdf")  -> "26192158"
//   policyNumberFromFilename("3f2a-....pdf")          -> null
export function policyNumberFromFilename(filename) {
  const match = String(filename || "").match(/BG_02_\s*FI\s*([^.\\/]+?)\.pdf$/i);
  return match ? match[1].replace(/\s+/g, "") : null;
}

// Both PDFs print the policy number in full ("BG/02/FI26192158"), so the text
// is a fallback for when the policy PDF was renamed or is missing. The office
// code is cut off and only the number is kept.
export function policyNumberFromText(text) {
  const match = String(text || "").match(/BG\s*\/\s*02\s*\/\s*FI\s*([0-9A-Z]+)/i);
  return match ? match[1] : null;
}

// Bulgarian plates are written with letters that look like Cyrillic ones
// (С В Е К М Н О Р Т Х А). When the PDF's font maps them to Cyrillic this puts
// them back to the Latin letters the form and the database use.
const PLATE_LOOKALIKES = {
  А: "A", В: "B", С: "C", Е: "E", К: "K", М: "M", Н: "H",
  О: "O", Р: "P", Т: "T", У: "Y", Х: "X",
};

function latinPlate(token) {
  let out = "";
  for (const ch of token) {
    const upper = ch.toUpperCase();
    out += PLATE_LOOKALIKES[upper] || ch;
  }
  return out;
}

// The car (registration) number is an 8-character token mixing letters and
// digits, e.g. "34CGR718" (Turkish plate "34 CGR 718") or "59ADJ391". An
// all-digit run (the policy number, a date, a price) and an all-letter word
// (the city, the make) are never a plate.
//
// Every field is printed three times on these PDFs (the policy plus its two
// copies), so the token that repeats wins: that keeps a one-off 8-character
// word elsewhere on the page from being picked instead. A value that appears
// only once is used only when it is the sole candidate (a document that prints
// the field once), and never when the caller asks for a repeated value.
//
// The plate is sometimes drawn in groups ("34 HEP 488", "CA 1234 AB") instead
// of as one token; those groups are joined first, but only when the result has
// a plate shape, so an IBAN fragment joined the same way ("BG93 UBBS") cannot
// pass for a registration number.
//
//   carNumberFromText("Турция 34CGR718 2026 ... 34CGR718 ... 34CGR718") -> "34CGR718"
//   carNumberFromText("policy 26192158")                                -> null
const PLATE_GROUP_SHAPES = [
  /^\d{2}[A-Z]{2,3}\d{3,4}$/, // 34HEP488 / 34 HEP 488 (Turkish)
  /^[A-Z]{1,2}\d{4}[A-Z]{2}$/, // CA1234AB / CA 1234 AB (Bulgarian)
];

export function carNumberFromText(text, options) {
  const requireRepeat = Boolean(options && options.requireRepeat);
  const source = String(text || "");
  const candidates = new Map();

  const record = (raw, joined) => {
    const plate = latinPlate(raw).toUpperCase();
    if (!/^[A-Z0-9]{8}$/.test(plate)) return;
    if (!/[0-9]/.test(plate) || !/[A-Z]/.test(plate)) return;
    // A value joined from groups must look like a real plate; anything else
    // ("BG93 UBBS" from an IBAN) is dropped no matter how often it repeats.
    if (joined && !PLATE_GROUP_SHAPES.some((shape) => shape.test(plate))) return;
    const seen = candidates.get(plate);
    if (seen) seen.count += 1;
    else candidates.set(plate, { value: plate, count: 1 });
  };

  // The plate as one token: "34HEP488".
  const tokenPattern = /(?<![\p{L}\p{N}])[\p{L}\p{N}]{8}(?![\p{L}\p{N}])/gu;
  for (const match of source.matchAll(tokenPattern)) record(match[0], false);

  // The plate in up to three groups: "34 HEP 488", "34-HEP-488". The text is
  // split on whitespace and hyphens first, then every two or three neighbouring
  // groups are tried, so a group that starts one word earlier ("Турция 34 HEP")
  // cannot swallow the real one.
  const groups = source.split(/[\s\u00a0-]+/).filter(Boolean);
  for (let i = 0; i < groups.length; i += 1) {
    for (let take = 2; take <= 3 && i + take <= groups.length; take += 1) {
      const parts = groups.slice(i, i + take);
      if (parts.some((part) => !/^[\p{L}\p{N}]+$/u.test(part))) continue;
      const value = parts.join("");
      if (value.length !== 8) continue;
      record(value, true);
    }
  }

  let best = null;
  for (const candidate of candidates.values()) {
    // ">" keeps the first of two equally frequent tokens.
    if (!best || candidate.count > best.count) best = candidate;
  }
  if (!best) return null;
  if (best.count >= 2) return best.value;
  if (requireRepeat) return null;
  return candidates.size === 1 ? best.value : null;
}

// The blank (бланка) number is printed as "Стикер" followed by a 6-digit value,
// three times on the sticker document. The values are drawn after all labels,
// so the number cannot be read straight after the word; instead the 6-digit
// values are counted and the repeated one is taken. A value glued to a decimal
// separator ("35,799999") is a price, not a blank, and is skipped.
//
//   stickerNumberFromText("СТИКЕР ... 175973 ... 175973 ... 175973") -> "175973"
//   stickerNumberFromText("policy 26192158")                        -> null
export function stickerNumberFromText(text) {
  const source = String(text || "");
  // Only the sticker document carries this label; without it a 6-digit value
  // (an invoice row, an account fragment) could belong to anything.
  if (!/стикер|sticker/i.test(source)) return null;

  const candidates = new Map();
  const valuePattern = /(?<![0-9.,])[0-9]{6}(?![0-9]|[.,][0-9])/g;
  for (const match of source.matchAll(valuePattern)) {
    const seen = candidates.get(match[0]);
    if (seen) seen.count += 1;
    else candidates.set(match[0], { value: match[0], count: 1 });
  }

  let best = null;
  for (const candidate of candidates.values()) {
    if (!best || candidate.count > best.count) best = candidate;
  }
  if (!best) return null;
  // A single 6-digit value on the whole document is unambiguous; with several
  // different ones (none repeating) there is no way to tell which is the blank.
  if (best.count >= 2) return best.value;
  return candidates.size === 1 ? best.value : null;
}

// Every value handed to the form is one complete number with no whitespace in
// it. The documents print numbers in groups ("34 HEP 488", "26 192 158") and a
// file name may carry stray spaces; a form field must hold the whole value
// joined together - never a piece of it and never anything separated by spaces.
function fieldValue(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).replace(/\s+/g, "");
  return text || null;
}

// Everything the form can be pre-filled with from one downloaded PDF. The
// policy number comes from the policy PDF's file name (or the printed text),
// the blank number from the sticker PDF, and the car number from whichever of
// the two PDFs carries it: some products print it on the policy document, the
// other file on others, so both are read. The sticker document only gives a car
// number when the value repeats (the plate is printed three times), so a random
// 8-character code on the payment slip cannot win over the real plate.
export function pdfFields(buffer, filename) {
  let text = "";
  try {
    text = pdfText(buffer);
  } catch (err) {
    // A PDF that cannot be read must never stop the upload or the print.
    text = "";
  }

  const isPolicyPdf = policyPdfName(filename);
  const carNumber = isPolicyPdf
    ? carNumberFromText(text)
    : carNumberFromText(text, { requireRepeat: true });

  if (isPolicyPdf) {
    return {
      policyNumber: fieldValue(
        policyNumberFromFilename(filename) || policyNumberFromText(text)
      ),
      carNumber: fieldValue(carNumber),
      blancNumber: null,
    };
  }
  return {
    policyNumber: fieldValue(policyNumberFromText(text)),
    carNumber: fieldValue(carNumber),
    blancNumber: fieldValue(stickerNumberFromText(text)),
  };
}

