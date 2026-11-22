"use strict";

// UI test: every checkbox is presented as the same pill toggle used by the
// reconcile daily report's compare fields (renderer/app.css + WorkPage.js +
// the Add Insurance forms).
//
// Run with:  node Test/checkboxToggleUi.test.cjs   (or: npm test)

const fs = require("fs");
const path = require("path");

let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log("  PASS  " + name);
  } catch (err) {
    failed++;
    console.log("  FAIL  " + name + "  -> " + err.message);
  }
}
function ok(value, msg) {
  if (!value) throw new Error(msg || "expected a truthy value");
}

const ROOT = path.join(__dirname, "..");
const read = (...parts) =>
  fs.readFileSync(path.join(ROOT, ...parts), "utf8");
const APP_CSS = read("renderer", "app.css");
const WORKPAGE = read("renderer", "WorkPage", "WorkPage.js");
const WORKPAGE_CSS = read("renderer", "WorkPage", "WorkPage.css");
const ADD_HTML = read("renderer", "AddInsurance", "AddInsurance.html");
const ADMIN_HTML = read("renderer", "AdminInsurance", "AdminInsurance.html");
const flat = (text) => text.replace(/\s+/g, " ");

console.log("Every checkbox uses the reconcile pill toggle style");

check("the shared checkbox is a pill with a round tick", () => {
  ok(
    /input\[type="checkbox"\]\s*\{[\s\S]*?appearance:\s*none/.test(APP_CSS),
    "the native box is repainted"
  );
  ok(
    /input\[type="checkbox"\][\s\S]*?background-image:\s*url\("data:image\/svg\+xml/.test(
      APP_CSS
    ),
    "a check mark is drawn"
  );
  ok(/\.checkbox-toggle\s*\{/.test(APP_CSS), "the pill class exists");
  ok(
    /\.checkbox-toggle:has\(input\[type="checkbox"\]:checked\)/.test(APP_CSS),
    "the on state follows the native checked flag"
  );
  ok(
    /border-radius:\s*999px/.test(APP_CSS) &&
      /rgba\(79, 140, 255, 0\.16\)/.test(APP_CSS),
    "it uses the reconcile pill shape and accent tint"
  );
});

check("buildForm renders checkbox specs as the pill", () => {
  ok(
    /function checkboxToggle\(labelText, checked, existingInput\)/.test(
      WORKPAGE
    ),
    "the helper exists"
  );
  ok(
    flat(WORKPAGE).includes(
      "holder.appendChild(checkboxToggle(s.label, null, control))"
    ),
    "buildForm wraps the checkbox"
  );
  ok(
    flat(WORKPAGE).includes('const holder = el("div", null, { class: "field" })'),
    "the modal spacing holder is kept"
  );
});

check("the broker and diagnostics checkboxes use the pill", () => {
  ok(
    flat(WORKPAGE).includes("checkboxToggle( t(\"brokerAllowNegative\")"),
    "the broker negative-balance toggle"
  );
  ok(
    flat(WORKPAGE).includes("toggle.classList.add(\"broker-toggle\")"),
    "it keeps its toolbar placement"
  );
  ok(
    flat(WORKPAGE).includes("checkboxToggle( t(\"diag.collectToggle\")"),
    "the diagnostics collect toggle"
  );
  ok(
    !flat(WORKPAGE).includes(
      'const collectToggle = input("checkbox")'
    ),
    "the diagnostics toggle no longer builds a bare checkbox"
  );
});

check("the lookup filters and broker history use the pill", () => {
  // "Insurances by date" filters: the annulled and include-deleted flags were
  // built with field() (caption ABOVE a bare tick); they must be the same pill
  // as every other checkbox.
  ok(
    flat(WORKPAGE).includes(
      'checkboxToggle(t("annulledFilter"), null, annulledInput)'
    ),
    "the annulled filter is a pill"
  );
  ok(
    flat(WORKPAGE).includes(
      'checkboxToggle(t("includeDeleted"), null, includeDeletedInput)'
    ),
    "the include-deleted filter is a pill (lookup + balance history)"
  );
  ok(
    !flat(WORKPAGE).includes('field(t("annulledFilter"), annulledInput)'),
    "no lookup checkbox is left in a bare field"
  );
  ok(
    !flat(WORKPAGE).includes('field(t("includeDeleted"), includeDeletedInput)'),
    "no include-deleted checkbox is left in a bare field"
  );
});

check("both add-insurance forms use the pill class", () => {
  ok(
    (ADD_HTML.match(/<label class="checkbox-toggle">/g) || []).length === 3,
    "Add Insurance has three pill labels"
  );
  ok(
    (ADMIN_HTML.match(/<label class="checkbox-toggle">/g) || []).length === 3,
    "Admin Insurance has three pill labels"
  );
  ok(
    !/<label>\s*\n\s*<input[^>]*type="checkbox"/.test(ADD_HTML),
    "no Add Insurance checkbox is left in a bare label"
  );
  ok(
    !/<label>\s*\n\s*<input[^>]*type="checkbox"/.test(ADMIN_HTML),
    "no Admin Insurance checkbox is left in a bare label"
  );
});

check("the broker toolbar no longer overrides the pill colours", () => {
  ok(
    !/\.broker-toggle\s*\{[\s\S]*?color:\s*var\(--text\)/.test(WORKPAGE_CSS),
    "the old text colour is gone"
  );
  ok(
    !/\.broker-toggle input\[type="checkbox"\]/.test(WORKPAGE_CSS),
    "the old native accent rule is gone"
  );
});

check("the reconcile compare toggles stay real buttons", () => {
  ok(
    flat(WORKPAGE).includes('const btn = el("button", null, { class: "recon-toggle", type: "button" })'),
    "the reconcile toggles are unchanged"
  );
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
