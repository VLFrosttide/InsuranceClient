"use strict";

// Node test for the admin-only hover "X" delete: the renderTable action flag
// that draws it, and deleteCashTransaction, the Current cash ledger's delete
// (renderer/WorkPage/WorkPage.js).
//
// The "X" is an ordinary per-row action flagged `hover: true`: it renders as an
// icon button whose label becomes its tooltip / accessible name, and the CSS
// (.row-hover-x in app.css) keeps it invisible and unclickable until the row is
// hovered - so a destructive click is never one stray click away.
//
// WorkPage.js touches the DOM the moment it is loaded, so - like
// insuranceEditorRefresh.test.cjs - this test cuts those two functions out of
// the REAL file and runs them in a vm with `el` and the other helpers stubbed.
// If either is moved or renamed the markers below stop matching and the test
// fails loudly instead of silently testing nothing.
//
// Run with:  node Test/hoverDeleteAction.test.cjs   (or: npm test)

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const WORKPAGE_JS = path.join(ROOT, "renderer", "WorkPage", "WorkPage.js");
const src = fs.readFileSync(WORKPAGE_JS, "utf8");

// One function, from its first line to the first "}" at column 0 (WorkPage.js
// uses CRLF, hence the \r?).
function cutFunction(marker) {
  const start = src.indexOf(marker);
  if (start < 0) {
    console.error(`Could not locate ${marker} in WorkPage.js (moved?)`);
    process.exit(1);
  }
  const tail = src.slice(start);
  const closing = /\r?\n\}\r?\n/.exec(tail);
  if (!closing) {
    console.error("Could not find the end of " + marker);
    process.exit(1);
  }
  return tail.slice(0, closing.index + closing[0].length);
}

const block =
  cutFunction(
    "function renderTable(items, columns, actions, rowClass, onRowClick, options) {"
  ) +
  "\n" +
  cutFunction("async function deleteCashTransaction(tx, onDone) {");

// --- fakes -------------------------------------------------------------------
// A DOM node just rich enough for renderTable: children, classes, listeners and
// the attributes el() sets.
function makeNode(tag, text, attrs) {
  const node = {
    tag,
    text: text === undefined || text === null ? "" : String(text),
    children: [],
    listeners: {},
    className: (attrs && attrs.class) || "",
    attrs: Object.assign({}, attrs),
    appendChild(child) {
      node.children.push(child);
      return child;
    },
    append(...kids) {
      for (const kid of kids) node.children.push(kid);
    },
    addEventListener(event, fn) {
      (node.listeners[event] = node.listeners[event] || []).push(fn);
    },
    setAttribute(name, value) {
      node.attrs[name] = value;
    },
    // renderTable marks sortable headers with classList.add.
    classList: {
      add(name) {
        const list = node.className.split(/\s+/).filter(Boolean);
        if (!list.includes(name)) node.className = list.concat(name).join(" ");
      },
    },
    click() {
      for (const fn of node.listeners.click || []) {
        fn({ target: { closest: () => null } });
      }
    },
  };
  return node;
}

let apiCalls = [];
let toasts = [];
let confirmTexts = [];
let confirmAnswer = true;
let apiError = null;
let doneCalls = 0;
const CONFIRM_TEMPLATE = "confirm #{i} {t} {a} {c} {r}";
const FIXED_CREATED_AT = "2026-12-11 10:30:00";

const CTX = {
  console,
  el: makeNode,
  t: (key) => (key === "deleteTransactionConfirm" ? CONFIRM_TEMPLATE : key),
  money: (value) => `M(${value})`,
  confirm: (text) => {
    confirmTexts.push(text);
    return confirmAnswer;
  },
  api: async (url, opts) => {
    apiCalls.push({ url, opts });
    if (apiError) throw new Error(apiError);
    return {};
  },
  toast: (message, kind) => toasts.push(`${kind}: ${message}`),
  localDateTimeNow: () => FIXED_CREATED_AT,
};
vm.createContext(CTX);
vm.runInContext(block, CTX, { filename: "WorkPage.js#renderTable+deleteCashTransaction" });

for (const name of ["renderTable", "deleteCashTransaction"]) {
  if (typeof CTX[name] !== "function") {
    console.error(name + " did not load - block markers changed?");
    process.exit(1);
  }
}
const { renderTable, deleteCashTransaction } = CTX;

// --- tiny assert helpers -----------------------------------------------------
let passed = 0;
let failed = 0;
async function check(name, fn) {
  try {
    await fn();
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
function ok(value, msg) {
  if (!value) throw new Error(msg || "expected a truthy value");
}

// Every button rendered in the body of a one-row table.
function bodyButtons(actions, options) {
  const table = renderTable(
    [{ id: 1, Type: "increase" }],
    [{ key: "Type" }],
    actions,
    null,
    null,
    options
  );
  const tbody = table.children[1];
  const row = tbody.children[0];
  const cell = row.children[row.children.length - 1];
  const wrap = cell.children[0];
  return { row, wrap, buttons: wrap.children };
}

(async () => {
  console.log("Insurance — hover X delete");

  // --- the hover action ------------------------------------------------------
  await check("a hover action renders as an X icon button", () => {
    const { buttons } = bodyButtons([
      { label: "Delete transaction", class: "danger", hover: true, onClick: () => {} },
    ]);
    eq(buttons.length, 1, "one button");
    eq(buttons[0].text, "×", "the icon is an X");
    ok(
      buttons[0].className.split(" ").includes("row-hover-x"),
      "class carries row-hover-x: " + buttons[0].className
    );
    ok(buttons[0].className.split(" ").includes("danger"), "keeps its class");
  });

  await check("the label becomes the tooltip and the accessible name", () => {
    const { buttons } = bodyButtons([
      { label: "Delete transaction", class: "danger", hover: true, onClick: () => {} },
    ]);
    eq(buttons[0].attrs.title, "Delete transaction", "title");
    eq(buttons[0].attrs["aria-label"], "Delete transaction", "aria-label");
    // It is a real button, not a link, so the row's own click handler ignores it.
    eq(buttons[0].tag, "button", "tag");
    eq(buttons[0].attrs.type, "button", "type");
  });

  await check("clicking the X runs the action for that row", () => {
    const clicked = [];
    const { buttons } = bodyButtons([
      {
        label: "Delete",
        class: "danger",
        hover: true,
        onClick: (item) => clicked.push(item.id),
      },
    ]);
    buttons[0].click();
    eq(clicked, [1], "called with the row");
  });

  await check("a normal action is untouched by the hover path", () => {
    const { buttons } = bodyButtons([
      { label: "Edit", class: "", onClick: () => {} },
    ]);
    eq(buttons[0].text, "Edit", "still shows its label");
    ok(
      !buttons[0].className.split(" ").includes("row-hover-x"),
      "not a hover X: " + buttons[0].className
    );
  });

  await check("edit and the X sit side by side", () => {
    const { buttons } = bodyButtons([
      { label: "Edit", class: "", onClick: () => {} },
      { label: "Delete", class: "danger", hover: true, onClick: () => {} },
    ]);
    eq(buttons.map((b) => b.text), ["Edit", "×"], "edit first, X last");
  });

  await check("revealActions fades the whole action cell until the row is hovered", () => {
    const plain = bodyButtons([
      { label: "Edit", class: "secondary", onClick: () => {} },
    ]);
    ok(
      !plain.wrap.className.split(" ").includes("row-hover-actions"),
      "off by default: " + plain.wrap.className
    );

    const revealed = bodyButtons(
      [{ label: "Edit", class: "secondary", onClick: () => {} }],
      { revealActions: true }
    );
    ok(
      revealed.wrap.className.split(" ").includes("row-hover-actions"),
      "carries row-hover-actions: " + revealed.wrap.className
    );
    ok(
      revealed.wrap.className.split(" ").includes("actions"),
      "keeps the actions class: " + revealed.wrap.className
    );
    eq(revealed.buttons.map((b) => b.text), ["Edit"], "the button itself is unchanged");
  });

  await check("a row with no actions gets no action cell", () => {
    const table = renderTable([{ id: 1 }], [{ key: "id" }], () => []);
    const row = table.children[1].children[0];
    eq(row.children.length, 1, "only the data cell");
  });

  // Some headers are more than a label: the brokers table's "Name" header is a
  // filter input (headerRender). Plain columns keep their text label.
  await check("a column can render its own header node", () => {
    const marker = makeNode("span", "Filter");
    const table = renderTable(
      [{ id: 1 }],
      [
        { key: "id", label: "Name", headerRender: () => marker },
        { key: "other", label: "Code" },
      ]
    );
    const headRow = table.children[0].children[0];
    eq(headRow.children[0].text, "", "no label text when a node is given");
    eq(headRow.children[0].children, [marker], "the node is inside the cell");
    eq(headRow.children[1].text, "Code", "a plain column keeps its label");
  });

  await check("a header node never replaces a sortable label", () => {
    const marker = makeNode("span", "Filter");
    let sorted = 0;
    const table = renderTable(
      [{ id: 1 }],
      [
        {
          key: "id",
          label: "Name",
          headerSuffix: " ▼",
          headerRender: () => marker,
          onHeaderClick: () => sorted++,
        },
      ]
    );
    const th = table.children[0].children[0].children[0];
    eq(th.text, "", "no label text");
    eq(th.children, [marker], "node kept");
    eq(th.className.split(" ").includes("sortable"), true, "still sortable");
    th.click();
    eq(sorted, 1, "the header click still sorts");
  });


  // --- the Current cash ledger delete ----------------------------------------
  const tx = {
    id: 42,
    Type: "increase",
    Amount: "50.00",
    Currency: "EUR",
    Reason: "Top up",
    Username: "worker1",
    Branch: "Офис Харманли",
  };

  await check("the confirm names the entry and asks first", async () => {
    apiCalls = [];
    toasts = [];
    confirmTexts = [];
    confirmAnswer = false;
    await deleteCashTransaction(tx, () => doneCalls++);
    eq(confirmTexts.length, 1, "one confirm");
    eq(
      confirmTexts[0],
      "confirm #42 increase M(50.00) EUR Top up",
      "id, type, amount, currency and reason are shown"
    );
    eq(apiCalls, [], "nothing is sent when the admin cancels");
  });

  await check("confirming soft-deletes the entry on the server", async () => {
    apiCalls = [];
    toasts = [];
    confirmTexts = [];
    confirmAnswer = true;
    doneCalls = 0;
    await deleteCashTransaction(tx, () => doneCalls++);

    eq(apiCalls.length, 1, "one request");
    eq(apiCalls[0].url, "/currentcash/transactions/42", "the entry's own URL");
    eq(apiCalls[0].opts.method, "DELETE", "method");
    eq(
      JSON.parse(apiCalls[0].opts.body),
      { CreatedAt: FIXED_CREATED_AT },
      "the client's local time is sent"
    );
    eq(toasts, ["success: transactionDeleted"], "toast");
    eq(doneCalls, 1, "the view refreshes");
  });

  await check("a rejected delete reports the error and does not refresh", async () => {
    apiCalls = [];
    toasts = [];
    confirmTexts = [];
    confirmAnswer = true;
    doneCalls = 0;
    apiError = "insufficient current cash for reduction";
    await deleteCashTransaction(tx, () => doneCalls++);
    apiError = null;

    eq(toasts, ["error: insufficient current cash for reduction"], "toast");
    eq(doneCalls, 0, "no refresh");
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();

