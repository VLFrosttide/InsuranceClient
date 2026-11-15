"use strict";

// Node test for the results screen of the "Reconcile daily report" tab
// (reconRenderResults in renderer/WorkPage/WorkPage.js).
//
// The screen has to keep three promises:
//   1. the rows missing from the database and the insurances missing from the
//      file are listed in SEPARATE tables (each with its own row count), never
//      mixed into one list;
//   2. every summary card that counts a table is a shortcut to it - click or
//      Enter/Space scrolls to that section;
//   3. an empty side is still shown, with its "no data" line, so the screen
//      always has the same three sections.
//
// The function lives in WorkPage.js, so it is lifted out of the real file and
// run in a vm against a minimal DOM - like the other WorkPage tests.

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const WORKPAGE = path.join(ROOT, "renderer", "WorkPage");

const src = fs
  .readFileSync(path.join(WORKPAGE, "WorkPage.js"), "utf8")
  .replace(/\r\n/g, "\n");
const START = "function reconRenderResults(result) {";
const END = "\n// The last reconciled report, kept in memory.";
const start = src.indexOf(START);
const end = start < 0 ? -1 : src.indexOf(END, start);
if (start < 0 || end < 0) {
  console.error(
    "Could not locate reconRenderResults in WorkPage.js (moved? renamed?)"
  );
  process.exit(1);
}
const block = src.slice(start, end);

// renderTable() is part of the same file and only needs el()/t(), so the REAL
// implementation is used instead of a stand-in.
const TABLE_START =
  "function renderTable(items, columns, actions, rowClass, onRowClick, options) {";
const TABLE_END =
  "\n// ---------------------------------------------------------------------------\n// Sortable tables";
const tableStart = src.indexOf(TABLE_START);
const tableEnd =
  tableStart < 0 ? -1 : src.indexOf(TABLE_END, tableStart);
if (tableStart < 0 || tableEnd < 0) {
  console.error("Could not locate renderTable in WorkPage.js (moved?)");
  process.exit(1);
}
const tableBlock = src.slice(tableStart, tableEnd);

// --- minimal DOM ------------------------------------------------------------
class FakeNode {
  constructor(tag) {
    this.tagName = String(tag || "div").toUpperCase();
    this.children = [];
    this.attributes = {};
    this.listeners = {};
    this.className = "";
    this._text = "";
    this.scrollCalls = 0;
  }
  get textContent() {
    if (this.children.length === 0) return this._text;
    return this.children.map((c) => c.textContent).join("");
  }
  set textContent(v) {
    this._text = String(v);
    this.children.length = 0;
  }
  get classList() {
    const node = this;
    return {
      add: (...names) => {
        const set = new Set(node.className.split(/\s+/).filter(Boolean));
        names.forEach((n) => set.add(n));
        node.className = Array.from(set).join(" ");
      },
      remove: (...names) => {
        const drop = new Set(names);
        node.className = node.className
          .split(/\s+/)
          .filter((n) => n && !drop.has(n))
          .join(" ");
      },
      contains: (n) => node.className.split(/\s+/).includes(n),
    };
  }
  setAttribute(k, v) {
    this.attributes[k] = String(v);
  }
  getAttribute(k) {
    return this.attributes[k];
  }
  appendChild(child) {
    this.children.push(child);
    return child;
  }
  replaceChildren(...kids) {
    this.children = kids;
  }
  addEventListener(type, fn) {
    (this.listeners[type] = this.listeners[type] || []).push(fn);
  }
  dispatch(type, event = {}) {
    const list = this.listeners[type] || [];
    let prevented = false;
    const evt = {
      key: event.key,
      target: this,
      preventDefault: () => {
        prevented = true;
      },
    };
    list.forEach((fn) => fn(evt));
    return { prevented, handled: list.length > 0 };
  }
  scrollIntoView() {
    this.scrollCalls++;
  }
  // depth-first walk
  *walk() {
    for (const child of this.children) {
      yield child;
      yield* child.walk();
    }
  }
}

// The real `el()` from common.js: create an element, set its text and attrs.
const CTX = {
  document: { createElement: (tag) => new FakeNode(tag) },
  console,
};
vm.createContext(CTX);
vm.runInContext(
  // el() and t(): keep the translation keys readable in the assertions.
  `function el(tag, text, attrs) {
     const node = document.createElement(tag);
     if (text !== undefined && text !== null) node.textContent = text;
     if (attrs) {
       for (const key in attrs) {
         if (key === "class") node.className = attrs[key];
         else if (key === "type") node.type = attrs[key];
         else node.setAttribute(key, attrs[key]);
       }
     }
     return node;
   }
   function t(key) { return key; }`,
  CTX,
  { filename: "common.js#el" }
);
// The real pure reconcile helpers (RECON_COLUMNS, reconDbValues, ...).
vm.runInContext(
  fs.readFileSync(path.join(WORKPAGE, "reconcile-core.js"), "utf8"),
  CTX,
  { filename: "reconcile-core.js" }
);
vm.runInContext(
  tableBlock + "\nglobalThis.renderTable = renderTable;",
  CTX,
  { filename: "WorkPage.js#renderTable" }
);
vm.runInContext(
  block + "\nglobalThis.reconRenderResults = reconRenderResults;",
  CTX,
  { filename: "WorkPage.js#reconcileResults" }
);

const { reconRenderResults } = CTX;

// --- tiny assert helpers ----------------------------------------------------
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
function eq(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b)
    throw new Error((msg || "values differ") + ` (got ${a}, want ${b})`);
}
function ok(cond, msg) {
  if (!cond) throw new Error(msg || "expected truthy");
}

// Find nodes of the rendered tree.
const find = (root, pred) => Array.from(root.walk()).filter(pred);
const byId = (root, id) =>
  find(root, (n) => n.getAttribute && n.getAttribute("id") === id)[0];
const headings = (root) => find(root, (n) => n.tagName === "H3");
const tables = (root) => find(root, (n) => n.tagName === "TABLE");
const cards = (root) =>
  find(root, (n) => n.className && n.className.split(/\s+/).includes("stat-card"));
const cardByLabel = (root, label) =>
  cards(root).find((c) => c.children[0] && c.children[0].textContent === label);

// A report with rows on every side, shaped exactly like reconcileReport's
// return value.
const report = {
  fileRowCount: 3,
  matched: 1,
  missingFromDb: [
    {
      rowNo: 15,
      policy: "26167659",
      blank: "149988",
      car: "59ADJ391",
      fromRaw: "05.10.2026",
      toRaw: "3M",
      fromKey: "2026-10-05",
      toKey: "2027-01-03",
    },
  ],
  missingFromFile: [
    {
      PolicyNumber: "26167777",
      BlancNumber: "153780",
      CarNumber: "34HYY133",
      StartDate: "2026-10-05",
      Duration: 90,
    },
  ],
  mismatches: [
    {
      rowNo: 17,
      policy: { file: "26167686", db: "26167686", mismatch: false },
      blank: { file: "149990", db: "149990", mismatch: false },
      from: { file: "05.10.2026", db: "05.10.2026", mismatch: false },
      to: { file: "03.01.2027", db: "04.01.2027", mismatch: true },
      car: { file: "34PDP763", db: "34PDP763", mismatch: false },
    },
  ],
  dbDate: "2026-10-05",
};

const emptyReport = {
  fileRowCount: 1,
  matched: 1,
  missingFromDb: [],
  missingFromFile: [],
  mismatches: [],
  dbDate: "2026-10-05",
};

console.log("Reconcile daily report — results screen");

const view = reconRenderResults(report);

check("three separate sections are rendered", () => {
  ok(byId(view, "recon-missing-db"), "database section");
  ok(byId(view, "recon-missing-file"), "file section");
  ok(byId(view, "recon-mismatches"), "mismatch section");
});

check("each section holds only its own rows and its own table", () => {
  const dbSection = byId(view, "recon-missing-db");
  const fileSection = byId(view, "recon-missing-file");
  eq(tables(dbSection).length, 1, "one table for the database side");
  eq(tables(fileSection).length, 1, "one table for the file side");
  eq(
    headings(dbSection)[0].textContent,
    "reconcile.missingFromDb (1)",
    "database heading with its count"
  );
  eq(
    headings(fileSection)[0].textContent,
    "reconcile.missingFromFile (1)",
    "file heading with its count"
  );
  // The file row only appears in the database table ...
  ok(
    dbSection.textContent.includes("26167659"),
    "file row listed as missing from the database"
  );
  ok(
    !fileSection.textContent.includes("26167659"),
    "the two missing lists are not mixed"
  );
  // ... and the database insurance only in the file table.
  ok(
    fileSection.textContent.includes("26167777"),
    "database insurance listed as missing from the file"
  );
  ok(
    !dbSection.textContent.includes("26167777"),
    "the other direction stays out"
  );
});

check("the missing-from-database table keeps the file row number", () => {
  const dbSection = byId(view, "recon-missing-db");
  const head = find(dbSection, (n) => n.tagName === "TH").map(
    (n) => n.textContent
  );
  eq(head[0], "reconcile.row", "the first column is the file row");
  eq(head.length, 6, "row + 5 compared columns");
  ok(dbSection.textContent.includes("15"), "the source row number is shown");
});

check("the missing-from-file table has no file row-number column", () => {
  const fileSection = byId(view, "recon-missing-file");
  const head = find(fileSection, (n) => n.tagName === "TH").map(
    (n) => n.textContent
  );
  eq(head, [
    "reconcile.col.policy",
    "reconcile.col.blank",
    "reconcile.col.from",
    "reconcile.col.to",
    "reconcile.col.car",
  ]);
});

check("the mismatch table still lists the differing cells", () => {
  const section = byId(view, "recon-mismatches");
  ok(
    section.textContent.includes("reconcile.fileValue: 03.01.2027"),
    "file value shown"
  );
  ok(
    section.textContent.includes("reconcile.dbValue: 04.01.2027"),
    "database value shown"
  );
  const cells = find(section, (n) =>
    n.className.split(/\s+/).includes("cell-mismatch")
  );
  eq(cells.length, 1, "only the differing cell is highlighted");
});

// --- the cards ---------------------------------------------------------------
check("every table card is a keyboard-reachable button", () => {
  for (const [label, targetId] of [
    ["reconcile.missingFromDb", "recon-missing-db"],
    ["reconcile.missingFromFile", "recon-missing-file"],
    ["reconcile.mismatches", "recon-mismatches"],
  ]) {
    const card = cardByLabel(view, label);
    ok(card, "card exists: " + label);
    ok(card.className.split(/\s+/).includes("clickable"), "clickable: " + label);
    eq(card.tabIndex, 0, "focusable: " + label);
    eq(card.getAttribute("role"), "button", "role: " + label);
    ok(byId(view, targetId), "target exists: " + targetId);
  }
});

check("clicking a card scrolls to its own table", () => {
  const pairs = [
    ["reconcile.missingFromDb", "recon-missing-db"],
    ["reconcile.missingFromFile", "recon-missing-file"],
    ["reconcile.mismatches", "recon-mismatches"],
  ];
  for (const [label, targetId] of pairs) {
    cardByLabel(view, label).dispatch("click");
    eq(byId(view, targetId).scrollCalls, 1, "scrolled to " + targetId);
    // Only the matching section moved.
    for (const other of pairs) {
      if (other[1] === targetId) continue;
      eq(byId(view, other[1]).scrollCalls, 0, "did not move " + other[1]);
    }
    // Reset for the next card.
    for (const other of pairs) byId(view, other[1]).scrollCalls = 0;
  }
});

check("Enter and Space scroll as well, other keys do not", () => {
  const card = cardByLabel(view, "reconcile.missingFromFile");
  const target = byId(view, "recon-missing-file");
  card.dispatch("keydown", { key: "a" });
  eq(target.scrollCalls, 0, "a letter key is ignored");
  card.dispatch("keydown", { key: "Enter" });
  eq(target.scrollCalls, 1, "Enter scrolls");
  const space = card.dispatch("keydown", { key: " " });
  eq(space.prevented, true, "Space does not scroll the page itself");
  eq(target.scrollCalls, 2, "Space scrolls");
});

check("the counts without a table stay inert", () => {
  for (const label of ["reconcile.fileRows", "reconcile.matched"]) {
    const card = cardByLabel(view, label);
    ok(card, "card exists: " + label);
    ok(!card.className.split(/\s+/).includes("clickable"), "inert: " + label);
    eq(card.dispatch("click").handled, false, "no click handler: " + label);
  }
});

check("the card figures are the row counts", () => {
  eq(cardByLabel(view, "reconcile.fileRows").children[1].textContent, "3");
  eq(cardByLabel(view, "reconcile.matched").children[1].textContent, "1");
  eq(cardByLabel(view, "reconcile.missingFromDb").children[1].textContent, "1");
  eq(
    cardByLabel(view, "reconcile.missingFromFile").children[1].textContent,
    "1"
  );
  eq(cardByLabel(view, "reconcile.mismatches").children[1].textContent, "1");
});

// --- empty sides -------------------------------------------------------------
const allGood = reconRenderResults(emptyReport);

check("a clean report still has all three sections, each empty", () => {
  for (const id of [
    "recon-missing-db",
    "recon-missing-file",
    "recon-mismatches",
  ]) {
    const section = byId(allGood, id);
    ok(section, "section exists: " + id);
    eq(tables(section).length, 0, "no table when empty: " + id);
    ok(section.textContent.includes("noData"), "says there is no data: " + id);
  }
});

check("a clean report says everything matches", () => {
  ok(allGood.textContent.includes("reconcile.allGood"), "all-good message");
  ok(!view.textContent.includes("reconcile.allGood"), "not on a dirty report");
});

check("the empty cards still jump to their (empty) sections", () => {
  const card = cardByLabel(allGood, "reconcile.missingFromDb");
  ok(card.className.split(/\s+/).includes("clickable"), "still clickable");
  card.dispatch("click");
  eq(byId(allGood, "recon-missing-db").scrollCalls, 1, "scrolled");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);


