"use strict";

// Node test for the number-field helpers used on the add-insurance form
// (renderer/numberField.js): reading the policy number out of a policy PDF's
// file name and stripping whitespace out of autofilled/pasted numbers.
//
// Runs the REAL renderer file in a vm (it is a classic browser <script>),
// following the same pattern as emailThread.test.cjs.
//
// Run with:  node Test/numberField.test.cjs   (or: npm test)

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const CTX = {};
vm.createContext(CTX);
vm.runInContext(
  fs.readFileSync(path.join(ROOT, "renderer", "numberField.js"), "utf8"),
  CTX,
  { filename: "numberField.js" }
);
const { extractPolicyNumber, stripWhitespace } = CTX;

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
function eq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(`${label}: expected ${e}, got ${a}`);
  }
}

(async () => {
  // --- policy number --------------------------------------------------------
  // (the blank and car numbers are no longer read out of free text: an email's
  // subject/body made those guesses too easy to get wrong, so every number now
  // comes from the policy PDFs - see pdfFields.js and Test/pdfFields.test.cjs)

  check("policy number is read from a BG_02_ PDF filename (FI stripped)", () => {
    eq(extractPolicyNumber("BG_02_ FI26170121.pdf"), "26170121", "with space");
    eq(extractPolicyNumber("BG_02_FI26170121.pdf"), "26170121", "no space");
  });

  check("whitespace inside the number is removed, not the number cut", () => {
    eq(extractPolicyNumber("BG_02_ FI 26170121.pdf"), "26170121", "space before");
    eq(extractPolicyNumber("BG_02_ FI 26 170 121.pdf"), "26170121", "spaced groups");
    eq(extractPolicyNumber("BG_02_ FI  26\t170\n121 .pdf"), "26170121", "mixed");
  });

  check("policy number has no fixed length", () => {
    eq(extractPolicyNumber("BG_02_ FI123.pdf"), "123", "short");
    eq(extractPolicyNumber("BG_02_ FI1234567890.pdf"), "1234567890", "long");
    eq(extractPolicyNumber("BG_02_ FIXYZ.pdf"), "XYZ", "letters");
  });

  check("a non-matching filename yields no policy number", () => {
    eq(extractPolicyNumber("policy.pdf"), null, "plain");
    eq(extractPolicyNumber("BG_01_ FI26170121.pdf"), null, "wrong code");
    eq(extractPolicyNumber("BG_02_ 26167659.pdf"), null, "no FI marker");
    eq(extractPolicyNumber("BG_02_ FI26170121.txt"), null, "wrong extension");
    eq(extractPolicyNumber(""), null, "empty");
    eq(extractPolicyNumber(undefined), null, "undefined");
  });

  check("stripWhitespace removes leading, trailing and inner spaces", () => {
    eq(stripWhitespace("  54ZS584  "), "54ZS584", "outer");
    eq(stripWhitespace("54 ZS 584"), "54ZS584", "inner");
    eq(stripWhitespace("CB 1234 AB"), "CB1234AB", "car number");
    eq(stripWhitespace("12\t34\n56"), "123456", "tabs/newlines");
  });

  check("stripWhitespace is safe on non-strings", () => {
    eq(stripWhitespace(""), "", "empty");
    eq(stripWhitespace(undefined), "", "undefined");
    eq(stripWhitespace(null), "", "null");
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
