"use strict";

// Node test for the folding cards/sections of the Current cash tab
// (renderer/WorkPage/WorkPage.js + renderer/WorkPage/WorkPage.css).
//
// Changing the day (the picker or the one-day steps) or the branch rebuilds the
// whole tab. Every <details> used to be recreated closed, so a table the user
// had opened folded itself shut under them - and that was the only sign the data
// had been reloaded. The tab now:
//   - gives every fold a stable data-cash-fold key;
//   - remembers which folds were open in the view being replaced and re-opens
//     them on the rebuilt nodes, so only the figures inside change;
//   - flashes the reloaded headings and cards once (.cash-updated), a tiny
//     "the data inside changed" hint that moves nothing;
//   - opens a fresh visit (through runLoader) collapsed and without animation.
// The open-state helpers are lifted out of the real file and run in a vm
// against a tiny fake DOM, so the behaviour itself is exercised, not only the
// wiring.
//
// Run with:  node Test/currentCashFolds.test.cjs   (or: npm test)

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const WORKPAGE = fs.readFileSync(
  path.join(ROOT, "renderer", "WorkPage", "WorkPage.js"),
  "utf8"
);
const CSS = fs.readFileSync(
  path.join(ROOT, "renderer", "WorkPage", "WorkPage.css"),
  "utf8"
);
// Whitespace-insensitive copy (the file is stored with CRLF line endings).
const lf = WORKPAGE.replace(/\r\n/g, "\n");
const flat = lf.replace(/\s+/g, " ");

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
function eq(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error((msg || "values differ") + ` (got ${a}, want ${b})`);
}

// Slice one call/block of the real file: from its marker to the closing line.
function slice(startMarker, endPattern) {
  const start = lf.indexOf(startMarker);
  ok(start >= 0, `marker not found: ${startMarker}`);
  const rest = lf.slice(start);
  const end = rest.search(endPattern);
  ok(end > 0, `end not found after ${startMarker}`);
  return rest.slice(0, end);
}

console.log("Current cash - the folding cards survive a change of day");

check("both fold builders stamp a stable key", () => {
  ok(
    flat.includes(
      'if (foldKey) details.setAttribute("data-cash-fold", foldKey);'
    ),
    "collapsibleSection accepts a key"
  );
  ok(
    flat.includes(
      'if (options.foldKey) details.setAttribute("data-cash-fold", options.foldKey);'
    ),
    "foldedCard accepts a key"
  );
});

check("every folding card of the tab carries its own key", () => {
  const cards = [
    ["const handoverCard = foldedCard(", "handoverStats"],
    ["const drawersCard = foldedCard(", "drawers"],
    ["const dailyCard = foldedCard(", "dailyReport"],
  ];
  for (const [marker, key] of cards) {
    const block = slice(marker, /\n\s*\}\);/);
    ok(block.includes(`foldKey: "${key}"`), `${key} is keyed`);
  }
});

check("every ledger section carries its own key", () => {
  const sections = [
    ["const transactionsSection = collapsibleSection(", "transactions"],
    ["const cashInsurancesSection = collapsibleSection(", "cashInsurances"],
    ["const cardInsurancesSection = collapsibleSection(", "cardInsurances"],
    ["const brokerCashSection = collapsibleSection(", "brokerCash"],
    ["const expensesSection = collapsibleSection(", "expenses"],
    ["const resetsSection = collapsibleSection(", "resets"],
    ["handoverSection = collapsibleSection(", "handovers"],
    ["bankSection = collapsibleSection(", "bank"],
  ];
  for (const [marker, key] of sections) {
    const block = slice(marker, /\n\s*\);/);
    ok(
      new RegExp(`,\\s*"${key}"\\s*$`).test(block),
      `${key} is the last argument of its section`
    );
  }
});

// The whole body of the Current cash view (ends at the first closing brace in
// column 0, which is the one that closes the function).
function cashViewBody() {
  const start = lf.indexOf("async function currentCashView(");
  ok(start >= 0, "the Current cash view exists");
  const end = lf.indexOf("\n}\n", start);
  ok(end > start, "the view ends");
  return lf.slice(start, end);
}

check("the open folds are read before the old view is thrown away", () => {
  const view = cashViewBody();
  ok(view.includes("const openFolds = cashOpenFolds();"), "the folds are captured");
  ok(
    view.includes(
      'Content.querySelectorAll("details[data-cash-fold]").length > 0'
    ),
    "a rebuild is told apart from a fresh visit"
  );
  ok(
    view.indexOf("const openFolds") < view.indexOf("await api("),
    "captured before the first await, while the old view is still on screen"
  );
});

check("the rebuild re-opens them before it paints", () => {
  const view = cashViewBody();
  const restore = view.indexOf("applyCashFoldState(");
  const paint = view.indexOf("Content.replaceChildren(");
  ok(restore > 0, "the rebuilt nodes are patched");
  ok(paint > restore, "patched before the content is replaced");
  const args = view.slice(restore, view.indexOf(");", restore));
  for (const section of [
    "cardsRow",
    "transactionsSection",
    "cashInsurancesSection",
    "cardInsurancesSection",
    "brokerCashSection",
    "expensesSection",
    "handoverSection",
    "resetsSection",
    "bankSection",
  ]) {
    ok(args.includes(section), `${section} is reached`);
  }
  ok(args.includes("openFolds"), "the captured state is applied");
  ok(args.includes("refreshing"), "the flash is only asked for on a rebuild");
});

check("a tab switch starts from the loading line, so folds open fresh", () => {
  ok(
    /async function runLoader\(load\) \{\s*Content\.replaceChildren\(\s*el\("p", t\("loading"\)/.test(
      flat
    ),
    "the previous view is gone before the tab loader runs"
  );
});

check("the reload flashes once and respects reduced motion", () => {
  ok(CSS.includes(".collapsible-section.cash-updated > summary,"), "sections");
  ok(CSS.includes(".balance-card.cash-updated"), "cards");
  ok(
    /animation: cash-updated-flash 620ms ease-out;/.test(CSS),
    "a short, settling animation"
  );
  const frames = CSS.indexOf("@keyframes cash-updated-flash");
  ok(frames > 0, "the keyframes exist");
  const reduced = CSS.slice(
    CSS.indexOf("@media (prefers-reduced-motion: reduce)", frames)
  );
  ok(reduced.slice(0, 300).includes("animation: none;"), "off for reduced motion");
});

// --- behaviour: the real helpers against a tiny fake DOM --------------------
const helperStart = lf.indexOf("function cashOpenFolds()");
const helperEnd = lf.indexOf("\nasync function currentCashView(");
ok(
  helperStart > 0 && helperEnd > helperStart,
  "the fold-state helpers are locatable in WorkPage.js"
);
const helperSource = lf.slice(helperStart, helperEnd);

// Just enough DOM for the two helpers: children, <details open>, the
// data-cash-fold attribute, classList and the two selectors they use.
function makeNode(tag, options = {}) {
  const node = {
    tagName: String(tag).toUpperCase(),
    children: [],
    classes: new Set(options.classes || []),
    attrs: { ...(options.attrs || {}) },
    open: Boolean(options.open),
    setAttribute(name, value) {
      node.attrs[name] = String(value);
    },
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(node.attrs, name)
        ? node.attrs[name]
        : null;
    },
    appendChild(child) {
      node.children.push(child);
      return child;
    },
    classList: {
      add(name) {
        node.classes.add(name);
      },
      contains(name) {
        return node.classes.has(name);
      },
    },
    matches(selector) {
      if (selector === "details[data-cash-fold]") {
        return (
          node.tagName === "DETAILS" &&
          Object.prototype.hasOwnProperty.call(node.attrs, "data-cash-fold")
        );
      }
      if (selector === ".balance-card") return node.classes.has("balance-card");
      return false;
    },
    querySelectorAll(selector) {
      const found = [];
      const walk = (parent) => {
        for (const child of parent.children) {
          if (child.matches(selector)) found.push(child);
          walk(child);
        }
      };
      walk(node);
      return found;
    },
  };
  return node;
}
function fold(key, open, classes) {
  return makeNode("details", {
    open,
    attrs: { "data-cash-fold": key },
    classes: classes || [],
  });
}

const oldView = makeNode("div");
oldView.appendChild(fold("transactions", true));
oldView.appendChild(fold("resets", false));

const CTX = { Content: oldView };
vm.createContext(CTX);
vm.runInContext(
  helperSource +
    "\nglobalThis.cashOpenFolds = cashOpenFolds;" +
    "\nglobalThis.applyCashFoldState = applyCashFoldState;",
  CTX,
  { filename: "WorkPage.js#cashFoldState" }
);

check("only the folds left open are remembered", () => {
  eq([...CTX.cashOpenFolds()], ["transactions"], "the open table");
});

check("a rebuild re-opens them and flashes the reloaded figures", () => {
  const cards = makeNode("div", { classes: ["cash-cards"] });
  const available = makeNode("div", { classes: ["balance-card"] });
  const drawers = fold("drawers", false, ["balance-card"]);
  cards.appendChild(available);
  cards.appendChild(drawers);
  const transactions = fold("transactions", false);
  const resets = fold("resets", false);

  CTX.applyCashFoldState(
    [cards, transactions, resets],
    CTX.cashOpenFolds(),
    true
  );

  eq(transactions.open, true, "the open table stays open");
  eq(resets.open, false, "a closed table stays closed");
  eq(drawers.open, false, "a closed card stays folded");
  ok(available.classes.has("cash-updated"), "balance cards flash");
  ok(drawers.classes.has("cash-updated"), "folded cards flash");
  ok(transactions.classes.has("cash-updated"), "sections flash");
});

check("a fresh visit opens collapsed and does not animate", () => {
  const section = fold("transactions", false);
  const card = makeNode("div", { classes: ["balance-card"] });
  CTX.applyCashFoldState([section, card], new Set(), false);
  eq(section.open, false, "stays folded");
  eq(card.classes.has("cash-updated"), false, "no flash");
});

check("an empty view remembers nothing", () => {
  CTX.Content = makeNode("div");
  eq([...CTX.cashOpenFolds()], [], "nothing open");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
