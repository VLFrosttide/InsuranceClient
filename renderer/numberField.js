"use strict";

// Pure, DOM-free helpers for the number fields on the add-insurance form.
//
// Kept in a separate classic <script> (no DOM access) so the exact same code
// runs in the browser and in the Node test harness (Test/numberField.test.cjs),
// following the same pattern as emailThread.js / emailAge.js.

// Find the first standalone 6-digit number in a blob of text. A broker's email
// names the blank (бланка) number as a 6-digit value, while the policy number
// is 8 digits, so a digit run is only returned when it is exactly 6 digits and
// not part of a longer run (a policy number, a date, a phone fragment, ...).
//
//   extractBlankNumber("Policy CA1234AB blanc 149988")      -> "149988"
//   extractBlankNumber("BG/02/FI26170121/FA156089/54ZS584") -> "156089"
//   extractBlankNumber("nothing here")                       -> null
function extractBlankNumber(text) {
  const m = String(text || "").match(/(?<!\d)\d{6}(?!\d)/);
  return m ? m[0] : null;
}

// Extract the policy number from a policy PDF filename. The insurer names the
// PDF "BG_02_ FI<policy>.pdf": a "BG_02_ " prefix, then an "FI" marker, then
// the policy number, then the ".pdf" extension marks the end. The "FI" marker
// is stripped, and there is no fixed length, so everything between the marker
// and the ".pdf" is returned.
//
//   extractPolicyNumber("BG_02_ FI26170121.pdf") -> "26170121"
//   extractPolicyNumber("BG_02_FI12345.pdf")     -> "12345"
//   extractPolicyNumber("policy.pdf")            -> null
function extractPolicyNumber(filename) {
  const m = String(filename || "").match(/BG_02_\s*FI([^.]+)\.pdf$/i);
  return m ? m[1] : null;
}

// Find the first standalone 8-character alphanumeric token that contains at
// least one letter and at least one digit — the shape of a car (registration)
// number such as "CB1234AB" or "59ADJ391". Requiring both a letter and a digit
// keeps a pure 8-digit value (the policy number, "26167659") and a plain
// 8-letter word (e.g. "attached") from being mistaken for a car number.
//
//   extractCarNumber("Car CB1234AB blanc 149988")  -> "CB1234AB"
//   extractCarNumber("policy 26167659")             -> null (all digits)
//   extractCarNumber("attached document")           -> null (all letters)
function extractCarNumber(text) {
  const m = String(text || "").match(
    /(?<![A-Za-z0-9])(?=[A-Za-z0-9]{0,7}[A-Za-z])(?=[A-Za-z0-9]{0,7}[0-9])[A-Za-z0-9]{8}(?![A-Za-z0-9])/
  );
  return m ? m[0] : null;
}

// Remove every whitespace character (spaces, tabs, newlines, non-breaking
// spaces, ...) whether leading, trailing or in the middle, so pasting
// "54 ZS 584" or "  54ZS584  " lands as "54ZS584".
function stripWhitespace(value) {
  return String(value || "").replace(/\s+/g, "");
}
