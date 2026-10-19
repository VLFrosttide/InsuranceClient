"use strict";

// Node test for the number-field helpers used on the add-insurance form
// (renderer/numberField.js): finding a 6-digit blank number in email text, and
// stripping whitespace out of pasted numbers.
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
const {
  extractBlankNumber,
  extractCarNumber,
  extractPolicyNumber,
  stripWhitespace,
} = CTX;

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
  check("a plain 6-digit number is found", () => {
    eq(extractBlankNumber("blanc 149988"), "149988", "value");
  });

  check("the first 6-digit number wins", () => {
    eq(extractBlankNumber("a 111222 then 333444"), "111222", "first");
  });

  check("a number surrounded by letters is found", () => {
    eq(extractBlankNumber("FA156089"), "156089", "letters around");
  });

  check("an 8-digit policy number is skipped (no 6-digit match)", () => {
    eq(extractBlankNumber("policy 26167659"), null, "no partial match");
  });

  check("a date-like run is not mistaken for the blank", () => {
    eq(extractBlankNumber("on 2026-10-05"), null, "no 6-digit run");
  });

  check("subject + body combined finds the number in either", () => {
    eq(extractBlankNumber("Policy CA1234AB\nblanc 149988"), "149988", "body");
    eq(extractBlankNumber("149988 - new policy\nplease issue"), "149988", "subject");
  });

  check("no 6-digit number returns null", () => {
    eq(extractBlankNumber("nothing but words 12 34"), null, "null");
    eq(extractBlankNumber(""), null, "empty");
    eq(extractBlankNumber(undefined), null, "undefined");
  });

  check("an 8-character alphanumeric car number is found", () => {
    eq(extractCarNumber("Car CB1234AB blanc 149988"), "CB1234AB", "value");
    eq(extractCarNumber("59ADJ391"), "59ADJ391", "digits and letters");
  });

  check("the first 8-character car number wins", () => {
    eq(extractCarNumber("CA1234AB then CB1234AB"), "CA1234AB", "first");
  });

  check("a pure 8-digit policy number is not a car number", () => {
    eq(extractCarNumber("policy 26167659"), null, "all digits");
  });

  check("a short or long token is not a car number", () => {
    eq(extractCarNumber("54ZS584"), null, "7 chars");
    eq(extractCarNumber("AB12345"), null, "7 chars");
    eq(extractCarNumber("ABCD12345"), null, "9 chars");
  });

  check("a lowercase car number still matches", () => {
    eq(extractCarNumber("car cb1234ab"), "cb1234ab", "lowercase");
  });

  check("no car-number token returns null", () => {
    eq(extractCarNumber("nothing here"), null, "null");
    eq(extractCarNumber(""), null, "empty");
    eq(extractCarNumber(undefined), null, "undefined");
  });

  check("policy number is read from a BG_02_ PDF filename (FI stripped)", () => {
    eq(extractPolicyNumber("BG_02_ FI26170121.pdf"), "26170121", "with space");
    eq(extractPolicyNumber("BG_02_FI26170121.pdf"), "26170121", "no space");
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
