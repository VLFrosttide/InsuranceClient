"use strict";

// Node test for the results screen of the "Reconcile daily report" tab
// (reconRenderResults in renderer/WorkPage/WorkPage.js).
//
// The screen has to keep four promises:
//   1. the rows missing from the database and the insurances missing from the
//      file are listed in SEPARATE tables (each with its own row count), never
//      mixed into one list;
//   2. every summary card that counts a table is a shortcut to it - click or
//      Enter/Space scrolls to that section;
//   3. an empty side is still shown, with its "no data" line, so the screen
//      always has the same three sections;
//   4. the duration, starting date, blanc and policy columns sort (by day
//      count and by real date, not by the "3M"/dd-mm-yyyy text), and no other
//      column does.
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
const START = "const reconTableSort = {";
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

// sortableTable()/sortTableRows()/tableSortValue(): also part of the same file
// and DOM-light, so the real sorting is used rather than a stand-in.
const SORT_START = "function tableSortValue(row, column) {";
const SORT_END = "\n// A collapsible table section";
const sortStart = src.indexOf(SORT_START);
const sortEnd = sortStart < 0 ? -1 : src.indexOf(SORT_END, sortStart);
if (sortStart < 0 || sortEnd < 0) {
  console.error("Could not locate sortableTable in WorkPage.js (moved?)");
  process.exit(1);
}
const sortBlock = src.slice(sortStart, sortEnd);

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
// `openInsuranceEditorForRow` is stubbed: the results screen only calls it when
// a row's hover Edit is clicked, and the check below records what it was given.
const editCalls = [];
const CTX = {
  document: { createElement: (tag) => new FakeNode(tag) },
  console,
  openInsuranceEditorForRow: (row, onDone) => editCalls.push({ row, onDone }),
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
  sortBlock + "\nglobalThis.sortableTable = sortableTable;",
  CTX,
  { filename: "WorkPage.js#sortableTable" }
);
vm.runInContext(
  block +
    "\nglobalThis.reconRenderResults = reconRenderResults;" +
    "\nglobalThis.reconTableSort = reconTableSort;",
  CTX,
  { filename: "WorkPage.js#reconcileResults" }
);

const { reconRenderResults, reconTableSort } = CTX;

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
      durationRaw: "3M",
      durationDays: 90,
      priceRaw: "0",
      price: 0,
    },
  ],
  missingFromFile: [
    {
      PolicyNumber: "26167777",
      BlancNumber: "153780",
      CarNumber: "34HYY133",
      StartDate: "2026-10-05",
      Duration: 90,
      Price: "45.5",
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
      duration: { file: "3M", db: "3M", mismatch: false },
      price: { file: "45.5", db: "45.5", mismatch: false },
    },
  ],
  creationFrom: "2026-10-05",
  creationTo: "2026-10-07",
  broker: "Euroins",
};

const emptyReport = {
  fileRowCount: 1,
  matched: 1,
  missingFromDb: [],
  missingFromFile: [],
  mismatches: [],
  creationFrom: "2026-10-05",
  creationTo: "2026-10-05",
  broker: "",
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
  eq(head.length, 8, "row + 7 compared columns");
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
    "reconcile.col.duration",
    "reconcile.col.price",
    // The hover "Edit insurance" column: these rows are policies of the
    // database, so each one can be corrected from here.
    "actions",
  ]);
});

check("a database row edits the insurance it is tied to", () => {
  editCalls.length = 0;
  const fileSection = byId(view, "recon-missing-file");
  const row = find(fileSection, (n) => n.tagName === "TR").find((tr) =>
    tr.children.some((c) => c.tagName === "TD")
  );
  const actionCell = row.children[row.children.length - 1];
  const button = find(actionCell, (n) => n.tagName === "BUTTON")[0];
  ok(button, "the row has an action button");
  ok(
    button.className.split(/\s+/).includes("row-hover-x"),
    "it is the hover icon: " + button.className
  );
  ok(
    button.className.split(/\s+/).includes("edit"),
    "styled as the edit (not the delete)"
  );
  eq(button.attributes.title, "editInsurance", "its tooltip names the action");
  button.dispatch("click");
  eq(editCalls.length, 1, "one editor is opened");
  eq(
    editCalls[0].row,
    report.missingFromFile[0],
    "the policy of THIS row is handed to the editor"
  );
});

check("the duration and price columns are shown on both sides", () => {
  // The file row keeps its "3M" as written; the database insurance shows the
  // stored duration in the same shorthand and its price.
  ok(byId(view, "recon-missing-db").textContent.includes("3M"), "file 3M");
  const fileSection = byId(view, "recon-missing-file");
  ok(fileSection.textContent.includes("3M"), "database duration as 3M");
  ok(fileSection.textContent.includes("45.5"), "database price");
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

// --- fields switched off in the compare checkboxes ---------------------------
check("a report that compared every field says nothing about skipping", () => {
  ok(!view.textContent.includes("reconcile.notCompared"), "no note");
  ok(
    !find(view, (n) => n.className.split(/\s+/).includes("cell-ignored")).length,
    "no dimmed cell"
  );
});

// The same row, but the car number was switched off. Its values are still
// listed (the field is not hidden), just not tinted or counted.
const withoutCar = {
  ...report,
  compareFields: ["policy", "blank", "from", "to"],
  mismatches: [
    {
      rowNo: 17,
      policy: { file: "26167686", db: "26167686", mismatch: false, ignored: false },
      blank: { file: "149990", db: "149990", mismatch: false, ignored: false },
      from: { file: "05.10.2026", db: "05.10.2026", mismatch: false, ignored: false },
      to: { file: "03.01.2027", db: "04.01.2027", mismatch: true, ignored: false },
      car: { file: "34PDP763", db: "99XXX000", mismatch: false, ignored: true },
      duration: { file: "3M", db: "3M", mismatch: false, ignored: true },
      price: { file: "45.5", db: "45.5", mismatch: false, ignored: true },
    },
  ],
};
const partialView = reconRenderResults(withoutCar);

check("the switched-off field is named under the summary", () => {
  ok(
    partialView.textContent.includes(
      "reconcile.notCompared: reconcile.col.car"
    ),
    "the note names the field"
  );
  ok(
    !partialView.textContent.includes("reconcile.col.policy, "),
    "checked fields are not listed"
  );
});

check("the switched-off field is dimmed, not flagged", () => {
  const section = byId(partialView, "recon-mismatches");
  const rows = find(section, (n) => n.tagName === "TR");
  // Row 0 is the header: rowNo, policy, blank, from, to, car, duration, price.
  const cells = rows[1].children.filter((n) => n.tagName === "TD");
  eq(cells.length, 8, "row number + seven fields");
  eq(cells[5].className, "cell-ignored", "car number is dimmed");
  eq(cells[4].className, "cell-mismatch", "valid-until is still flagged");
  eq(cells[5].textContent, "34PDP763", "the value is still shown");
});

check("a column the file does not have is named as not compared", () => {
  // A report without a price column: the field is ignored for that report, so
  // it is named under the summary and its cells are dimmed, not flagged.
  const noPriceColumn = reconRenderResults({
    ...report,
    fileFields: ["policy", "blank", "from", "to", "car", "duration"],
  });
  ok(
    noPriceColumn.textContent.includes(
      "reconcile.notCompared: reconcile.col.price"
    ),
    "price is named as not compared"
  );
  const section = byId(noPriceColumn, "recon-mismatches");
  const rows = find(section, (n) => n.tagName === "TR");
  const cells = rows[1].children.filter((n) => n.tagName === "TD");
  eq(cells[7].className, "cell-ignored", "price cell is dimmed");
  eq(cells[5].className, "", "the columns the file has stay compared");
});

check("an empty compare set compares nothing at all", () => {
  const allOff = reconRenderResults({ ...report, compareFields: [] });
  ok(
    allOff.textContent.includes(
      "reconcile.notCompared: reconcile.col.policy, reconcile.col.blank, reconcile.col.from, reconcile.col.to, reconcile.col.car, reconcile.col.duration, reconcile.col.price"
    ),
    "every field is named"
  );
  eq(
    find(allOff, (n) => n.className.split(/\s+/).includes("cell-mismatch"))
      .length,
    0,
    "nothing is highlighted"
  );
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

// --- sorting -----------------------------------------------------------------
// Three rows on each side, deliberately out of order, so a click has something
// to reorder. The values repeat the real shapes: file rows carry the parsed
// keys, database insurances the raw columns, mismatches { file, db } cells.
const sortReport = {
  fileRowCount: 3,
  matched: 0,
  missingFromDb: [
    {
      rowNo: 12,
      policy: "26167003",
      blank: "100003",
      car: "C3",
      fromRaw: "07.10.2026",
      fromKey: "2026-10-07",
      durationRaw: "15D",
      durationDays: 15,
      priceRaw: "10",
    },
    {
      rowNo: 10,
      policy: "26167001",
      blank: "100001",
      car: "C1",
      fromRaw: "05.10.2026",
      fromKey: "2026-10-05",
      durationRaw: "3M",
      durationDays: 90,
      priceRaw: "30",
    },
    {
      rowNo: 11,
      policy: "26167002",
      blank: "100002",
      car: "C2",
      fromRaw: "06.10.2026",
      fromKey: "2026-10-06",
      durationRaw: "1M",
      durationDays: 30,
      priceRaw: "20",
    },
  ],
  missingFromFile: [
    {
      PolicyNumber: "26168003",
      BlancNumber: "200003",
      CarNumber: "D3",
      StartDate: "2026-10-07",
      Duration: 15,
      Price: "10",
    },
    {
      PolicyNumber: "26168001",
      BlancNumber: "200001",
      CarNumber: "D1",
      StartDate: "2026-10-05",
      Duration: 90,
      Price: "30",
    },
    {
      PolicyNumber: "26168002",
      BlancNumber: "200002",
      CarNumber: "D2",
      StartDate: "2026-10-06",
      Duration: 30,
      Price: "20",
    },
  ],
  mismatches: [
    [12, "26167003", "100003", "07-10-2026", "15D"],
    [10, "26167001", "100001", "05-10-2026", "3M"],
    [11, "26167002", "100002", "06-10-2026", "1M"],
  ].map(([rowNo, policy, blank, from, duration]) => ({
    rowNo,
    policy: { file: policy, db: policy, mismatch: false },
    blank: { file: blank, db: blank, mismatch: false },
    from: { file: from, db: from, mismatch: false },
    to: { file: "", db: "", mismatch: false },
    car: { file: "", db: "", mismatch: false },
    duration: { file: duration, db: duration, mismatch: false },
    price: { file: "", db: "", mismatch: false },
  })),
  creationFrom: "2026-10-05",
  creationTo: "2026-10-07",
  broker: "",
};

// Every check starts from "no column sorted", so one click always means
// descending and the checks do not depend on each other.
function freshSortView() {
  for (const state of Object.values(reconTableSort)) {
    state.key = null;
    state.dir = "desc";
  }
  return reconRenderResults(sortReport);
}

const thByLabel = (section, label) =>
  find(section, (n) => n.tagName === "TH" && n.textContent.startsWith(label))[0];
const clickHeader = (section, label) =>
  thByLabel(section, label).dispatch("click");
const bodyRows = (section) =>
  find(section, (n) => n.tagName === "TR").filter((tr) =>
    tr.children.some((c) => c.tagName === "TD")
  );
const cellTexts = (section, index) =>
  bodyRows(section).map(
    (tr) => tr.children.filter((c) => c.tagName === "TD")[index].textContent
  );

const SORTABLE_LABELS = [
  "reconcile.col.policy",
  "reconcile.col.blank",
  "reconcile.col.from",
  "reconcile.col.duration",
];

check("only duration, starting date, blanc and policy are sortable", () => {
  const view = freshSortView();
  for (const id of [
    "recon-missing-db",
    "recon-missing-file",
    "recon-mismatches",
  ]) {
    const section = byId(view, id);
    const sortable = find(
      section,
      (n) => n.tagName === "TH" && n.className.split(/\s+/).includes("sortable")
    ).map((n) => n.textContent);
    eq(sortable, SORTABLE_LABELS, "sortable headers of " + id);
    // The file row number, valid-until, car and price keep the report order.
    for (const plain of [
      "reconcile.row",
      "reconcile.col.to",
      "reconcile.col.car",
      "reconcile.col.price",
    ]) {
      const th = thByLabel(section, plain);
      if (!th) continue;
      ok(
        !th.className.split(/\s+/).includes("sortable"),
        `${plain} is not sortable in ${id}`
      );
    }
  }
});

check("the duration header sorts by the day count, not the 3M/15D text", () => {
  const view = freshSortView();
  const section = byId(view, "recon-missing-db");
  clickHeader(section, "reconcile.col.duration");
  // 3M = 90 days, 1M = 30, 15D = 15: the first click puts the longest first.
  eq(cellTexts(section, 6), ["3M", "1M", "15D"], "descending by days");
  ok(
    thByLabel(section, "reconcile.col.duration").textContent.endsWith("▼"),
    "the active column shows its direction"
  );
  clickHeader(section, "reconcile.col.duration");
  eq(cellTexts(section, 6), ["15D", "1M", "3M"], "ascending by days");
  ok(
    thByLabel(section, "reconcile.col.duration").textContent.endsWith("▲"),
    "the arrow flips"
  );
});

check("the starting date sorts by date, not the dd-mm-yyyy text", () => {
  const view = freshSortView();
  const section = byId(view, "recon-missing-db");
  clickHeader(section, "reconcile.col.from");
  eq(
    cellTexts(section, 3),
    ["07-10-2026", "06-10-2026", "05-10-2026"],
    "newest first"
  );
  clickHeader(section, "reconcile.col.from");
  eq(
    cellTexts(section, 3),
    ["05-10-2026", "06-10-2026", "07-10-2026"],
    "oldest first"
  );
});

check("policy and blanc sort on the database side as well", () => {
  const view = freshSortView();
  const section = byId(view, "recon-missing-file");
  clickHeader(section, "reconcile.col.policy");
  eq(
    cellTexts(section, 0),
    ["26168003", "26168002", "26168001"],
    "policy desc"
  );
  // Switching column starts descending again.
  clickHeader(section, "reconcile.col.blank");
  eq(cellTexts(section, 1), ["200003", "200002", "200001"], "blanc desc");
  clickHeader(section, "reconcile.col.blank");
  eq(cellTexts(section, 1), ["200001", "200002", "200003"], "blanc asc");
});

check("the mismatch table sorts by its file values", () => {
  const view = freshSortView();
  const section = byId(view, "recon-mismatches");
  clickHeader(section, "reconcile.col.duration");
  eq(cellTexts(section, 6), ["3M", "1M", "15D"], "mismatch durations");
  clickHeader(section, "reconcile.col.from");
  eq(
    cellTexts(section, 3),
    ["07-10-2026", "06-10-2026", "05-10-2026"],
    "mismatch dates"
  );
});

check("a rebuilt screen keeps the chosen order", () => {
  freshSortView();
  const first = byId(reconRenderResults(sortReport), "recon-missing-db");
  clickHeader(first, "reconcile.col.duration");
  eq(cellTexts(first, 6), ["3M", "1M", "15D"], "sorted on the first build");
  // Back from another tab: the tab rebuilds the results from the cache, and
  // the order has to survive that.
  const rebuilt = byId(reconRenderResults(sortReport), "recon-missing-db");
  eq(cellTexts(rebuilt, 6), ["3M", "1M", "15D"], "order survives the rebuild");
  eq(reconTableSort.missingDb.key, "duration", "the state is the table's own");
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


