"use strict";

// Pure, DOM-free helpers for the number fields on the add-insurance form.
//
// Kept in a separate classic <script> (no DOM access) so the exact same code
// runs in the browser and in the Node test harness (test/client/numberField.test.cjs),
// following the same pattern as emailThread.js / emailAge.js.
//
// The numbers are read out of the policy PDFs (the Desktop watcher in main.js
// and pdfFields.js); nothing is read out of a broker's email any more.

// Extract the policy number from a policy PDF filename. The insurer names the
// PDF "BG_02_ FI<policy>.pdf": a "BG_02_ " prefix, then an "FI" marker, then
// the policy number, then the ".pdf" extension marks the end. The "FI" marker
// is stripped, and there is no fixed length, so everything between the marker
// and the ".pdf" is returned - as one complete value, with any whitespace the
// name happens to carry removed ("26 170 121" -> "26170121").
//
//   extractPolicyNumber("BG_02_ FI26170121.pdf")    -> "26170121"
//   extractPolicyNumber("BG_02_ FI 26 170 121.pdf") -> "26170121"
//   extractPolicyNumber("BG_02_FI12345.pdf")        -> "12345"
//   extractPolicyNumber("policy.pdf")               -> null
function extractPolicyNumber(filename) {
  const m = String(filename || "").match(/BG_02_\s*FI([^.]+)\.pdf$/i);
  return m ? stripWhitespace(m[1]) : null;
}

// Remove every whitespace character (spaces, tabs, newlines, non-breaking
// spaces, ...) whether leading, trailing or in the middle, so an autofilled or
// pasted "54 ZS 584" / "  54ZS584  " lands as "54ZS584" - the whole value,
// never a piece of it.
function stripWhitespace(value) {
  return String(value || "").replace(/\s+/g, "");
}
