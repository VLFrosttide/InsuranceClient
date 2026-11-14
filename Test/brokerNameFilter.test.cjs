"use strict";

// Node test for the brokers table's Name-column filter:
//
//   1. brokerNameMatches / brokerRowMatchesNameFilter - the matching rules cut
//      out of renderer/WorkPage/WorkPage.js (script- and case-insensitive, so
//      "lesovo" finds "ГКПП Лесово"; an empty filter shows every row);
//   2. brokerNameFilterHeader - the REAL header component: the "Name" label
//      becomes an input when clicked and drives the filter through onChange.
//
// The DOM-touching code is cut out of WorkPage.js (which cannot be loaded
// directly) and run in a vm with `el` / `t` stubbed, like the other WorkPage
// tests do.
//
// Run with:  node Test/brokerNameFilter.test.cjs   (or: npm test)

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const WORKPAGE_JS = path.join(
  __dirname,
  "..",
  "renderer",
  "WorkPage",
  "WorkPage.js"
);
const source = fs.readFileSync(WORKPAGE_JS, "utf8");

function between(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  if (start === -1) {
    console.error("Could not find in WorkPage.js: " + startMarker);
    process.exit(1);
  }
  const end = source.indexOf(endMarker, start + startMarker.length);
  if (end === -1) {
    console.error("Could not find the end of: " + startMarker);
    process.exit(1);
  }
  return source.slice(start, end);
}

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

// The transliteration map + brokerNameMatches live together; cut the whole block.
const matchingBlock =
  between("const BROKER_CYR_TO_LAT = {", "async function adminInsurancesByDate(") +
  "\n" +
  cutFunction("function brokerRowMatchesNameFilter(name, query) {") +
  "\n" +
  cutFunction("function applyBrokerNameFilterToRows(rows, query) {");

// --- fake DOM just rich enough for brokerNameFilterHeader --------------------
function makeNode(tag, text, attrs) {
  const node = {
    tag,
    text: text === undefined || text === null ? "" : String(text),
    children: [],
    listeners: {},
    className: (attrs && attrs.class) || "",
    style: {},
    attrs: Object.assign({}, attrs),
    value: "",
    focused: false,
  };
  node.classList = {
    _tokens() {
      return node.className.split(/\s+/).filter(Boolean);
    },
    add(name) {
      if (!this._tokens().includes(name)) {
        node.className = this._tokens().concat(name).join(" ");
      }
    },
    remove(name) {
      node.className = this._tokens().filter((t) => t !== name).join(" ");
    },
    contains(name) {
      return this._tokens().includes(name);
    },
    toggle(name, on) {
      const want = on === undefined ? !this.contains(name) : Boolean(on);
      if (want) this.add(name);
      else this.remove(name);
      return want;
    },
  };
  node.appendChild = (child) => {
    node.children.push(child);
    return child;
  };
  node.setAttribute = (name, value) => {
    node.attrs[name] = value;
    if (name === "class") node.className = String(value);
  };
  node.addEventListener = (event, fn) => {
    (node.listeners[event] = node.listeners[event] || []).push(fn);
  };
  node.dispatch = (event, payload) => {
    for (const fn of node.listeners[event] || []) fn(payload || {});
  };
  node.focus = () => {
    node.focused = true;
  };
  node.blur = () => {
    node.focused = false;
    node.dispatch("blur");
  };
  return node;
}

const CTX = {
  console,
  el: makeNode,
  t: (key) => `T:${key}`,
};
vm.createContext(CTX);
vm.runInContext(
  [
    "let brokerNameFilter = '';",
    "let brokerNameFilterInputOpen = false;",
    matchingBlock,
    cutFunction("function brokerNameFilterHeader(onChange) {"),
    "globalThis.__filterState = function () {",
    "  return { query: brokerNameFilter, open: brokerNameFilterInputOpen };",
    "};",
    "globalThis.__resetFilter = function () {",
    "  brokerNameFilter = '';",
    "  brokerNameFilterInputOpen = false;",
    "};",
  ].join("\n"),
  CTX,
  { filename: "WorkPage.js#brokerNameFilter" }
);
const { brokerNameMatches, brokerRowMatchesNameFilter, brokerNameFilterHeader } =
  CTX;
const applyBrokerNameFilterToRows = CTX.applyBrokerNameFilterToRows;
const state = CTX.__filterState;

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

console.log("Brokers table - Name column filter");

// --- matching rules ----------------------------------------------------------
check("broker names match regardless of script and case", () => {
  ok(brokerNameMatches("ГКПП Лесово", "Lesovo"), "Latin query, Cyrillic name");
  ok(brokerNameMatches("ГКПП Лесово", "lesovo"), "lower case");
  ok(brokerNameMatches("ГКПП Лесово", "Лесово"), "Cyrillic query");
  ok(brokerNameMatches("Lesovo", "Лесово"), "Cyrillic query, Latin name");
  ok(brokerNameMatches("Euroins", "euro"), "partial word");
  ok(brokerNameMatches("ГКПП Капитан Андреево", "kap andreevo"), "two words");
});

check("broker names that do not match are rejected", () => {
  ok(!brokerNameMatches("ГКПП Лесово", "Harmanli"), "other name");
  ok(!brokerNameMatches("", "Lesovo"), "empty name");
  ok(!brokerNameMatches("Euroins", "   "), "blank query");
  ok(!brokerNameMatches("Euroins", "euro x"), "one word missing");
});

check("an empty filter keeps every row", () => {
  eq(brokerRowMatchesNameFilter("ГКПП Лесово", ""), true, "empty");
  eq(brokerRowMatchesNameFilter("ГКПП Лесово", "   "), true, "spaces");
  eq(brokerRowMatchesNameFilter("ГКПП Лесово", null), true, "null");
  eq(brokerRowMatchesNameFilter("ГКПП Лесово", undefined), true, "undefined");
});

check("a typed filter narrows the rows by name", () => {
  eq(brokerRowMatchesNameFilter("ГКПП Лесово", "lesovo"), true, "match");
  eq(brokerRowMatchesNameFilter("ГКПП Лесово", " harmanli "), false, "no match");
  eq(brokerRowMatchesNameFilter("", "a"), false, "empty name");
});

// --- hiding and showing the rendered rows ------------------------------------
function filterEntry(name) {
  return { name, row: makeNode("tr") };
}

check("an empty filter leaves every row visible", () => {
  const rows = [filterEntry("ГКПП Лесово"), filterEntry("Euroins")];
  eq(applyBrokerNameFilterToRows(rows, ""), 2, "all shown");
  for (const entry of rows) {
    eq(entry.row.classList.contains("broker-name-filtered-out"), false, "shown");
  }
});

check("a typed filter hides the rows that do not match", () => {
  const rows = [
    filterEntry("ГКПП Лесово"),
    filterEntry("Euroins"),
    filterEntry("ГКПП Капитан Андреево"),
  ];
  eq(applyBrokerNameFilterToRows(rows, "lesovo"), 1, "one match");
  eq(rows[0].row.classList.contains("broker-name-filtered-out"), false, "match kept");
  eq(rows[1].row.classList.contains("broker-name-filtered-out"), true, "hidden");
  eq(rows[2].row.classList.contains("broker-name-filtered-out"), true, "hidden");
});

check("rows come back when the filter is widened or cleared", () => {
  const rows = [filterEntry("ГКПП Лесово"), filterEntry("Euroins")];
  applyBrokerNameFilterToRows(rows, "lesovo");
  eq(rows[1].row.classList.contains("broker-name-filtered-out"), true, "hidden");
  eq(applyBrokerNameFilterToRows(rows, "euro"), 1, "other match");
  eq(rows[0].row.classList.contains("broker-name-filtered-out"), true, "hidden now");
  eq(rows[1].row.classList.contains("broker-name-filtered-out"), false, "shown now");
  eq(applyBrokerNameFilterToRows(rows, ""), 2, "all back");
  eq(rows[0].row.classList.contains("broker-name-filtered-out"), false, "shown");
});

check("no matches is reported as zero while the rows stay in the table", () => {
  const rows = [filterEntry("Euroins")];
  eq(applyBrokerNameFilterToRows(rows, "zzz"), 0, "none shown");
  eq(rows.length, 1, "the row is only hidden, never removed");
});

check("malformed row lists are tolerated", () => {
  eq(applyBrokerNameFilterToRows(null, "x"), 0, "null");
  eq(applyBrokerNameFilterToRows([null, {}, { row: null }], "x"), 0, "bad entries");
});

// --- the header component ----------------------------------------------------
// Every header test starts from an empty filter, so the shared state cannot
// leak between checks.
function freshHeader(onChange) {
  CTX.__resetFilter();
  return brokerNameFilterHeader(onChange);
}

function parts(header) {
  const label = header.children[0];
  const field = header.children[1];
  const searchInput = field.children[0];
  const clearBtn = field.children[1];
  return { label, field, searchInput, clearBtn };
}

check("the header starts as the plain Name label", () => {
  const header = freshHeader(() => {});
  const { label, searchInput, clearBtn } = parts(header);
  eq(label.text, "T:name", "label");
  eq(label.attrs.title, "T:brokerNameFilterHint", "tooltip");
  eq(header.className.includes("open"), false, "input hidden");
  eq(searchInput.value, "", "empty input");
  eq(searchInput.attrs.placeholder, "T:brokerNameFilterPlaceholder", "placeholder");
  eq(clearBtn.style.display, "none", "clear hidden");
});

check("clicking the label turns the header into an input", () => {
  const header = freshHeader(() => {});
  const { label, searchInput } = parts(header);
  label.dispatch("click");
  ok(header.className.includes("open"), "input shown");
  ok(searchInput.focused, "input focused");
  eq(state().open, true, "open state remembered");
});

check("typing updates the filter and calls onChange", () => {
  let calls = 0;
  const header = freshHeader(() => calls++);
  const { label, searchInput, clearBtn } = parts(header);
  label.dispatch("click");
  searchInput.value = "les";
  searchInput.dispatch("input");
  eq(state().query, "les", "query");
  eq(calls, 1, "onChange calls");
  eq(clearBtn.style.display, "", "clear shown");
});

check("the ✕ clears the filter and keeps the input ready", () => {
  let calls = 0;
  const header = freshHeader(() => calls++);
  const { searchInput, clearBtn } = parts(header);
  searchInput.value = "les";
  searchInput.dispatch("input");
  clearBtn.dispatch("click");
  eq(state().query, "", "query cleared");
  eq(calls, 2, "onChange calls");
  eq(searchInput.value, "", "input cleared");
  eq(clearBtn.style.display, "none", "clear hidden");
  ok(searchInput.focused, "input still focused");
});

check("Escape clears the filter and restores the label", () => {
  const header = freshHeader(() => {});
  const { label, searchInput } = parts(header);
  label.dispatch("click");
  searchInput.value = "euro";
  searchInput.dispatch("input");
  let prevented = false;
  searchInput.dispatch("keydown", {
    key: "Escape",
    preventDefault: () => {
      prevented = true;
    },
  });
  eq(state().query, "", "query cleared");
  eq(state().open, false, "closed");
  ok(prevented, "default prevented");
  eq(header.className.includes("open"), false, "label back");
});

check("other keys leave the filter alone", () => {
  const header = freshHeader(() => {});
  const { searchInput } = parts(header);
  searchInput.value = "euro";
  searchInput.dispatch("input");
  searchInput.dispatch("keydown", { key: "Enter", preventDefault: () => {} });
  eq(state().query, "euro", "query kept");
});

check("leaving an empty field restores the label", () => {
  const header = freshHeader(() => {});
  const { label, searchInput } = parts(header);
  label.dispatch("click");
  searchInput.blur();
  eq(state().open, false, "closed");
  eq(header.className.includes("open"), false, "label back");
});

check("a rebuilt header keeps the active query open", () => {
  const first = freshHeader(() => {});
  const firstParts = parts(first);
  firstParts.searchInput.value = "euro";
  firstParts.searchInput.dispatch("input");

  const rebuilt = brokerNameFilterHeader(() => {});
  const rebuiltParts = parts(rebuilt);
  eq(rebuiltParts.searchInput.value, "euro", "query restored");
  ok(rebuilt.className.includes("open"), "input shown");
  eq(rebuiltParts.clearBtn.style.display, "", "clear shown");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
