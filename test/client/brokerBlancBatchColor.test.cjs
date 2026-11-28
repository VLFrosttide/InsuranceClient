"use strict";

// Node test for the pink "auto-added" blanc batches.
//
// When a policy is created anyway with a blanc that is in none of the broker's
// batches, the server adds that blanc to the broker's batches as its own
// one-number batch flagged AutoAdded. The client shows such batches in pink so
// they stand out:
//
//   * brokers table - only the auto-added range(s) are pink (blancBatchesLabel),
//   * "Blanc batches" modal - the whole row is tinted (batch-auto-row),
//   * app.css - the .batch-auto / tr.batch-auto-row td rules carry the colour.
//
// Editing such a batch's range clears the flag on the server (the admin adopts
// it), and a blanc that is already in ANOTHER broker's batches is refused with
// a message naming that broker (no "create anyway"). The last checks pin the
// translations of that refusal and the admin form's use of them.
//
// blancBatchesLabel is cut out of renderer/WorkPage/WorkPage.js (which cannot be
// loaded directly) and run in a vm with `el` / `t` stubbed, like the other
// WorkPage tests do.
//
// Run with:  node test/client/brokerBlancBatchColor.test.cjs   (or: npm test)

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..", "..");
const WORKPAGE_JS = path.join(ROOT, "renderer", "WorkPage", "WorkPage.js");
const APP_CSS = path.join(ROOT, "renderer", "app.css");
const source = fs.readFileSync(WORKPAGE_JS, "utf8");

// One function, from its first line to the first "}" at column 0 (CRLF file).
function cutFunction(marker) {
  const start = source.indexOf(marker);
  if (start === -1) {
    console.error("Could not find in WorkPage.js: " + marker);
    process.exit(1);
  }
  const tail = source.slice(start);
  const closing = /\r?\n}\r?\n/.exec(tail);
  if (!closing) {
    console.error("Could not find the end of " + marker);
    process.exit(1);
  }
  return tail.slice(0, closing.index + closing[0].length);
}

// --- fake DOM just rich enough for blancBatchesLabel ------------------------
function makeNode(tag, text, attrs) {
  const node = {
    tag,
    text: text === undefined || text === null ? "" : String(text),
    children: [],
    className: (attrs && attrs.class) || "",
    attrs: Object.assign({}, attrs),
  };
  node.appendChild = (child) => {
    node.children.push(child);
    return child;
  };
  // el("span", text) sets textContent; a re-assignment replaces the content.
  Object.defineProperty(node, "textContent", {
    get: () => node.text,
    set: (value) => {
      node.text = value === undefined || value === null ? "" : String(value);
      node.children = [];
    },
  });
  node.setAttribute = (name, value) => {
    node.attrs[name] = value;
    if (name === "class") node.className = String(value);
  };
  return node;
}

const CTX = {
  console,
  el: makeNode,
  t: (key) => `T:${key}`,
};
vm.createContext(CTX);
vm.runInContext(cutFunction("function blancBatchesLabel(batches) {"), CTX, {
  filename: "WorkPage.js#blancBatchesLabel",
});
const { blancBatchesLabel } = CTX;

// All text of a rendered label, read in document order.
function textOf(node) {
  return node.text + (node.children || []).map(textOf).join("");
}

// Every rendered range span (the class lives on the range, not the holder).
function rangeSpans(node) {
  return (node.children || []).filter((c) => /–/.test(c.text));
}

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
  if (a !== e) throw new Error(`${label}: expected ${e}, got ${a}`);
}
function ok(value, label) {
  if (!value) throw new Error(label || "expected a truthy value");
}

console.log("Brokers table - auto-added blanc batches are pink");

check("a broker without batches shows a dash", () => {
  eq(textOf(blancBatchesLabel([])), "-", "empty list");
  eq(textOf(blancBatchesLabel(undefined)), "-", "missing list");
  eq(blancBatchesLabel(null).children.length, 0, "nothing rendered");
});

check("handed-out batches are listed normally", () => {
  const label = blancBatchesLabel([
    { RangeStart: 100, RangeEnd: 199 },
    { RangeStart: 300, RangeEnd: 309 },
  ]);
  eq(textOf(label), "100–199, 300–309", "both ranges, comma separated");
  for (const span of rangeSpans(label)) {
    eq(span.className, "", "no pink class on a handed-out batch");
    eq(span.attrs.title, undefined, "no tooltip");
  }
});

check("an auto-added batch is pink and explains itself", () => {
  const label = blancBatchesLabel([
    { RangeStart: 100, RangeEnd: 199 },
    { RangeStart: 250, RangeEnd: 250, AutoAdded: true },
  ]);
  eq(textOf(label), "100–199, 250–250", "text includes the forced blanc");
  const spans = rangeSpans(label);
  eq(spans.length, 2, "two ranges");
  eq(spans[0].className, "", "the handed-out batch keeps the normal colour");
  eq(spans[1].className, "batch-auto", "the auto-added batch is pink");
  eq(spans[1].attrs.title, "T:autoBatchHint", "tooltip explains why it is pink");
});

check("AutoAdded is read as a flag, not as a range", () => {
  const label = blancBatchesLabel([
    { RangeStart: 500, RangeEnd: 500, AutoAdded: 1 },
  ]);
  eq(rangeSpans(label)[0].className, "batch-auto", "0/1 from MySQL");
  const plain = blancBatchesLabel([
    { RangeStart: 500, RangeEnd: 500, AutoAdded: 0 },
  ]);
  eq(rangeSpans(plain)[0].className, "", "0 is a handed-out batch");
});

check("the brokers table renders the label node (not plain text)", () => {
  ok(
    source.includes("render: (_v, b) => blancBatchesLabel(b.batches),"),
    "batches column uses render"
  );
  ok(
    source.includes('(b) => (b.AutoAdded ? "batch-auto-row" : "")'),
    "the batch list tints auto-added rows"
  );
});

check("the pink rules exist in app.css", () => {
  const css = fs.readFileSync(APP_CSS, "utf8");
  ok(/\.batch-auto\s*\{[^}]*color:\s*#ffb6c1/i.test(css), ".batch-auto text colour");
  ok(
    /tr\.batch-auto-row td\s*\{[^}]*background:/i.test(css),
    "tr.batch-auto-row td tint"
  );
});

// A blanc that is already in ANOTHER broker's batches is refused by the server
// with a message naming that broker; the forms must show it translated and
// must not offer "create anyway".
check("the other-broker refusal is translated with the broker name", () => {
  const common = fs.readFileSync(
    path.join(ROOT, "renderer", "common.js"),
    "utf8"
  );
  eq(
    (common.match(/"err\.blancBelongsToAnotherBroker"/g) || []).length,
    3,
    "both dictionaries and the translateError lookup"
  );
  ok(
    common.includes(
      "This blanc number belongs to another broker's blanc batches"
    ),
    "translateError recognises the server message"
  );
});

check("the admin form translates server errors", () => {
  const admin = fs.readFileSync(
    path.join(ROOT, "renderer", "AdminInsurance", "AdminInsurance.js"),
    "utf8"
  );
  ok(
    admin.includes("translateError(err && err.message"),
    "AdminInsurance.js calls translateError"
  );
  ok(
    /err(?:or)?\.code === BLANC_OUTSIDE_BROKER_BATCHES_CODE/.test(admin),
    "only the outside-the-batches error offers create anyway"
  );
  ok(
    !admin.includes("BLANC_BELONGS_TO_ANOTHER_BROKER"),
    "a blanc held by another broker is never force-created"
  );
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
