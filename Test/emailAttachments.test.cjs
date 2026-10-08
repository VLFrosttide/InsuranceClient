"use strict";

// Node test for which parts of an incoming broker email are shown to workers
// as attachments.
//
// Rule: EVERY file part is shown - PDFs, documents, images and graphics
// embedded in the HTML body (<img src="cid:...">). An earlier filter that hid
// cid:-referenced body graphics also hid real PDFs that mail clients reference
// from the body, so the filter was dropped.
//
// This loads the REAL server file (Test/srv/Mail_walkParts.js - the mirror of
// the deployed InsuranceServer/Mail/walkParts.js) and feeds it Gmail
// `format: "full"` payload shapes.
//
// Run with:  node Test/emailAttachments.test.cjs   (or: npm test)

const fs = require("fs");
const path = require("path");
const vm = require("vm");

// The client package is "type": "module", so the CommonJS server mirror cannot
// be require()d directly; run it in a vm with a CommonJS `module` instead.
const WALK_PARTS_JS = path.join(__dirname, "srv", "Mail_walkParts.js");
const CTX = { module: { exports: {} }, Buffer, console };
vm.createContext(CTX);
vm.runInContext(fs.readFileSync(WALK_PARTS_JS, "utf8"), CTX, {
  filename: "Mail_walkParts.js",
});
const walkParts = CTX.module.exports;
const { selectAttachments } = walkParts;

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
    console.log("  FAIL  " + name);
    console.log("        " + (err && err.message ? err.message : err));
  }
}
function assertEqual(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${label}: expected ${e}, got ${a}`);
}

// --- Gmail payload builders --------------------------------------------------
function b64url(text) {
  return Buffer.from(text, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}
function textPart(mimeType, text) {
  return { mimeType, filename: "", headers: [], body: { data: b64url(text) } };
}
function filePart(filename, mimeType, size, { cid, disposition } = {}) {
  const headers = [
    {
      name: "Content-Disposition",
      value: `${disposition || "attachment"}; filename="${filename}"`,
    },
  ];
  if (cid) headers.push({ name: "Content-ID", value: `<${cid}>` });
  return {
    mimeType,
    filename,
    headers,
    body: { attachmentId: `id-${filename}`, size },
  };
}
function shownFilenames(payload) {
  const bag = { textParts: [], htmlParts: [], attachmentParts: [] };
  walkParts(payload, "msg-1", bag);
  return selectAttachments(bag).map((a) => a.filename);
}

const SIGNATURE_HTML =
  "<p>Please issue the policy.</p><p>Regards</p>" +
  '<img src="cid:image001.png@01DB1234.ABCD5678" width="120">' +
  "<a href=\"#\"><img src='CID:image002.jpg@01DB1234.ABCD5678'></a>";
const LOGO1 = () =>
  filePart("image001.png", "image/png", 4200, {
    cid: "image001.png@01DB1234.ABCD5678",
    disposition: "inline",
  });
const LOGO2 = () =>
  filePart("image002.jpg", "image/jpeg", 2100, {
    cid: "image002.jpg@01DB1234.ABCD5678",
    disposition: "inline",
  });

// --- tests -------------------------------------------------------------------
console.log("email attachments: every file part is shown");

check("Outlook signature logos AND the real attachment are all shown", () => {
  const payload = {
    mimeType: "multipart/mixed",
    parts: [
      {
        mimeType: "multipart/related",
        parts: [
          {
            mimeType: "multipart/alternative",
            parts: [
              textPart("text/plain", "Please issue the policy."),
              textPart("text/html", SIGNATURE_HTML),
            ],
          },
          LOGO1(),
          LOGO2(),
        ],
      },
      filePart("talon.jpg", "image/jpeg", 850000),
    ],
  };
  assertEqual(
    shownFilenames(payload),
    ["image001.png", "image002.jpg", "talon.jpg"],
    "shown"
  );
});

check("a PDF referenced from the HTML body via cid: is shown", () => {
  // Apple/iOS Mail and Outlook display PDFs inline and reference them from
  // the body - they must never be filtered out.
  const payload = {
    mimeType: "multipart/mixed",
    parts: [
      textPart("text/html", '<p>Policy:</p><img src="cid:doc-1@mac">'),
      filePart("policy.pdf", "application/pdf", 250000, {
        cid: "doc-1@mac",
        disposition: "inline",
      }),
    ],
  };
  assertEqual(shownFilenames(payload), ["policy.pdf"], "shown");
});

check("a real attachment that carries a Content-ID is shown", () => {
  const payload = {
    mimeType: "multipart/mixed",
    parts: [
      textPart("text/html", SIGNATURE_HTML),
      LOGO1(),
      filePart("passport.pdf", "application/pdf", 300000, {
        cid: "F1E2D3C4@namprd.outlook.com",
      }),
    ],
  };
  assertEqual(
    shownFilenames(payload),
    ["image001.png", "passport.pdf"],
    "shown"
  );
});

check("an Apple Mail attachment marked 'inline' is still shown", () => {
  const payload = {
    mimeType: "multipart/mixed",
    parts: [
      textPart("text/plain", "See attached."),
      filePart("IMG_1234.jpg", "image/jpeg", 1200000, {
        disposition: "inline",
      }),
    ],
  };
  assertEqual(shownFilenames(payload), ["IMG_1234.jpg"], "shown");
});

check("an email with only body graphics shows them all", () => {
  const payload = {
    mimeType: "multipart/related",
    parts: [textPart("text/html", SIGNATURE_HTML), LOGO1(), LOGO2()],
  };
  assertEqual(
    shownFilenames(payload),
    ["image001.png", "image002.jpg"],
    "shown"
  );
});

check("photos pasted into the body are shown regardless of size", () => {
  const html =
    '<div>Talon:</div><img src="cid:photo-1@mobile">' +
    '<img src="cid:logo@mobile">';
  const payload = {
    mimeType: "multipart/related",
    parts: [
      textPart("text/html", html),
      filePart("photo.jpg", "image/jpeg", 150000, {
        cid: "photo-1@mobile",
        disposition: "inline",
      }),
      filePart("logo.png", "image/png", 5000, {
        cid: "logo@mobile",
        disposition: "inline",
      }),
    ],
  };
  assertEqual(shownFilenames(payload), ["photo.jpg", "logo.png"], "shown");
});

check("plain-text email with attachments is unaffected", () => {
  const payload = {
    mimeType: "multipart/mixed",
    parts: [
      textPart("text/plain", "Two files attached."),
      filePart("a.jpg", "image/jpeg", 50000),
      filePart("b.pdf", "application/pdf", 90000),
    ],
  };
  assertEqual(shownFilenames(payload), ["a.jpg", "b.pdf"], "shown");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

