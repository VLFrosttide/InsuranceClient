"use strict";

// Node test for the Reconcile tab's own controls (renderer/WorkPage/WorkPage.js):
//   - the collapsed "columns the daily report must have" help block;
//   - the compare-field toggle buttons;
//   - the localStorage round trip that remembers the choice between sessions.
//
// Like the other WorkPage tests, the real functions are lifted out of the real
// file and run in a vm against a minimal DOM, so what is tested is the code the
// client actually runs.

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..", "..");
const WORKPAGE = path.join(ROOT, "renderer", "WorkPage");

const src = fs
  .readFileSync(path.join(WORKPAGE, "WorkPage.js"), "utf8")
  .replace(/\r\n/g, "\n");
const appCss = fs.readFileSync(path.join(ROOT, "renderer", "app.css"), "utf8");
const workCss = fs.readFileSync(path.join(WORKPAGE, "WorkPage.css"), "utf8");

function cut(startMarker, endMarker) {
  const start = src.indexOf(startMarker);
  const end = start < 0 ? -1 : src.indexOf(endMarker, start);
  if (start < 0 || end < 0) {
    console.error(
      `Could not locate "${startMarker}" in WorkPage.js (moved? renamed?)`
    );
    process.exit(1);
  }
  return src.slice(start, end);
}

// The storage helpers, the help block and the toggle-button row, exactly as
// they appear between the in-memory report cache and the view itself.
const controlsBlock = cut(
  "// The compare-field choice lives in localStorage",
  "async function reconcileView() {"
);

// --- minimal DOM ------------------------------------------------------------
class FakeNode {
  constructor(tag) {
    this.tagName = String(tag || "div").toUpperCase();
    this.children = [];
    this.attributes = {};
    this.listeners = {};
    this.className = "";
    this._text = "";
  }
  get textContent() {
    if (this.children.length === 0) return this._text;
    return this._text + this.children.map((c) => c.textContent).join("");
  }
  set textContent(v) {
    this._text = String(v);
    this.children.length = 0;
  }
  get classList() {
    const node = this;
    const read = () => new Set(node.className.split(/\s+/).filter(Boolean));
    const write = (set) => {
      node.className = Array.from(set).join(" ");
    };
    return {
      add: (...names) => {
        const set = read();
        names.forEach((n) => set.add(n));
        write(set);
      },
      remove: (...names) => {
        const set = read();
        names.forEach((n) => set.delete(n));
        write(set);
      },
      contains: (n) => read().has(n),
      // The toggle-button code paints its state with classList.toggle(name, on),
      // so the double implements the same contract (including the force flag).
      toggle: (n, force) => {
        const set = read();
        const on = force === undefined ? !set.has(n) : !!force;
        if (on) set.add(n);
        else set.delete(n);
        write(set);
        return on;
      },
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
  addEventListener(type, fn) {
    (this.listeners[type] = this.listeners[type] || []).push(fn);
  }
  dispatch(type, event = {}) {
    const list = this.listeners[type] || [];
    list.forEach((fn) => fn({ key: event.key, target: this }));
    return { handled: list.length > 0 };
  }
  *walk() {
    for (const child of this.children) {
      yield child;
      yield* child.walk();
    }
  }
}


// --- the fake store ---------------------------------------------------------
// Stands in for the window's localStorage: a Map with the same three methods,
// able to simulate a disabled/blocked store.
function makeStorage(initial) {
  const data = new Map(Object.entries(initial || {}));
  return {
    data,
    broken: false,
    getItem(key) {
      if (this.broken) throw new Error("storage unavailable");
      return data.has(key) ? data.get(key) : null;
    },
    setItem(key, value) {
      if (this.broken) throw new Error("storage unavailable");
      data.set(key, String(value));
    },
    removeItem(key) {
      data.delete(key);
    },
  };
}

const storage = makeStorage();

const CTX = {
  document: { createElement: (tag) => new FakeNode(tag) },
  localStorage: storage,
  // The storage helpers report a broken store through console.warn; silence
  // that one channel so the test output stays readable.
  console: { ...console, warn: () => {} },
};
vm.createContext(CTX);
vm.runInContext(
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
vm.runInContext(
  fs.readFileSync(path.join(WORKPAGE, "reconcile-core.js"), "utf8"),
  CTX,
  { filename: "reconcile-core.js" }
);
vm.runInContext(
  controlsBlock +
    "\nglobalThis.loadReconcileCompareFields = loadReconcileCompareFields;" +
    "\nglobalThis.saveReconcileCompareFields = saveReconcileCompareFields;" +
    "\nglobalThis.reconColumnHint = reconColumnHint;" +
    "\nglobalThis.reconCompareToggles = reconCompareToggles;" +
    "\nglobalThis.reconLoadingIndicator = reconLoadingIndicator;",
  CTX,
  { filename: "WorkPage.js#reconcileControls" }
);

const {
  loadReconcileCompareFields,
  saveReconcileCompareFields,
  reconColumnHint,
  reconCompareToggles,
  reconLoadingIndicator,
} = CTX;
const { RECON_COMPARE_FIELDS, RECON_COMPARE_STORAGE_KEY } = vm.runInContext(
  "({ RECON_COMPARE_FIELDS, RECON_COMPARE_STORAGE_KEY })",
  CTX
);

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

const find = (root, pred) => Array.from(root.walk()).filter(pred);
// One entry per compare toggle: the button, the field it stands for and whether
// it is currently on (aria-pressed, which is what assistive tech reads).
const boxesOf = (wrap) =>
  find(wrap, (n) => n.tagName === "BUTTON" && n.getAttribute("data-field")).map(
    (n) => ({
      field: n.getAttribute("data-field"),
      on: n.getAttribute("aria-pressed") === "true",
      node: n,
    })
  );

console.log("Reconcile daily report — help block and compare toggle buttons");

// --- the help block ---------------------------------------------------------
const hint = reconColumnHint();

check("the hint is a collapsed section, not a wall of text", () => {
  eq(hint.tagName, "DETAILS", "rendered as <details>");
  ok(hint.className.split(/\s+/).includes("collapsible-section"), "collapsible");
  ok(hint.className.split(/\s+/).includes("recon-hint"), "recon-hint class");
  ok(!hint.open, "starts closed");
  const summary = hint.children[0];
  eq(summary.tagName, "SUMMARY", "first child is the summary");
  eq(summary.textContent, "reconcile.hintTitle", "titled from translations");
});

check("the hint table has a row per required column", () => {
  const table = find(
    hint,
    (n) => n.className.split(/\s+/).includes("recon-hint-table")
  )[0];
  ok(table, "table rendered");
  const heads = table.children[0].children[0].children.map(
    (n) => n.textContent
  );
  eq(heads, [
    "reconcile.hintField",
    "reconcile.hintHeaders",
    "reconcile.hintComparedWith",
  ]);
  const rows = table.children[1].children;
  eq(rows.length, RECON_COMPARE_FIELDS.length, "one row per field");
  eq(
    rows.map((r) => r.children[0].textContent),
    [
      "reconcile.col.policy",
      "reconcile.col.blank",
      "reconcile.col.from",
      "reconcile.col.to",
      "reconcile.col.car",
      "reconcile.col.duration",
      "reconcile.col.price",
    ],
    "the parser's own order"
  );
  eq(
    rows.map((r) => r.children[2].textContent),
    [
      "PolicyNumber",
      "BlancNumber",
      "StartDate",
      "StartDate + Duration",
      "CarNumber",
      "Duration",
      "Price",
    ],
    "the database field each column is compared with"
  );
  ok(
    rows[0].children[1].textContent.includes("НОМЕР НА ПОЛИЦА"),
    "policy lists its accepted headers"
  );
  ok(
    rows[3].children[1].textContent.includes("СРОК"),
    "valid-until lists its term alternative"
  );
  ok(
    rows[5].children[1].textContent.includes("СРОК") &&
      rows[5].children[1].textContent.includes("DURATION"),
    "duration lists its accepted headers"
  );
  ok(
    rows[6].children[1].textContent.includes("ЦЕНА") &&
      rows[6].children[1].textContent.includes("ТАРИФА"),
    "price lists its accepted headers"
  );
});

check("the hint names both layouts and the date/prefix rules", () => {
  const texts = find(hint, (n) => n.tagName === "P").map((n) => n.textContent);
  for (const key of [
    "reconcile.hintIntro",
    "reconcile.hintRequired",
    "reconcile.hintLayouts",
    "reconcile.hintTerms",
    "reconcile.hintDates",
  ]) {
    ok(texts.includes(key), "explains " + key);
  }
});

// --- the compare toggle buttons ---------------------------------------------
let reported = null;
const toggles = reconCompareToggles(RECON_COMPARE_FIELDS, (next) => {
  reported = next;
});

check("there is one toggle button per field, all on by default", () => {
  eq(
    boxesOf(toggles).map((b) => b.field),
    RECON_COMPARE_FIELDS
  );
  ok(
    boxesOf(toggles).every((b) => b.on),
    "everything compared by default"
  );
  ok(
    boxesOf(toggles).every((b) => b.node.type === "button"),
    "real buttons, not checkboxes"
  );
  ok(
    boxesOf(toggles).every((b) => b.node.classList.contains("is-on")),
    "the on state is also a class, so the CSS can draw it"
  );
  eq(
    toggles.children[0].textContent,
    "reconcile.compareFields",
    "the row is labelled"
  );
});

check("clicking a button switches its field off and reports the rest", () => {
  const car = boxesOf(toggles).find((b) => b.field === "car");
  car.node.dispatch("click");
  eq(reported, ["policy", "blank", "from", "to", "duration", "price"]);
  eq(car.node.getAttribute("aria-pressed"), "false", "announced as unpressed");
  ok(!car.node.classList.contains("is-on"), "the pill drops its on class");
  ok(
    car.node.classList.contains("is-clicked"),
    "the click replays the pop animation"
  );
  const policy = boxesOf(toggles).find((b) => b.field === "policy");
  policy.node.dispatch("click");
  eq(reported, ["blank", "from", "to", "duration", "price"]);
});

check("clicking the same button again switches the field back on", () => {
  const blank = boxesOf(toggles).find((b) => b.field === "blank");
  blank.node.dispatch("click");
  eq(reported, ["from", "to", "duration", "price"]);
  blank.node.dispatch("click");
  eq(reported, ["blank", "from", "to", "duration", "price"]);
  eq(blank.node.getAttribute("aria-pressed"), "true", "back to pressed");
  ok(blank.node.classList.contains("is-on"), "and back to the on styling");
});

check("duration and price have their own toggle buttons", () => {
  const duration = boxesOf(toggles).find((b) => b.field === "duration");
  const price = boxesOf(toggles).find((b) => b.field === "price");
  ok(duration, "duration toggle");
  ok(price, "price toggle");
  eq(duration.node.children[1].textContent, "reconcile.col.duration");
  eq(price.node.children[1].textContent, "reconcile.col.price");
  price.node.dispatch("click");
  eq(reported, ["blank", "from", "to", "duration"]);
});

check("the buttons can be put back in step with a stored choice", () => {
  // Restoring a stored choice paints the state but must not replay the click
  // pop: only a real click should animate.
  const popped = boxesOf(toggles).map((b) =>
    b.node.classList.contains("is-clicked")
  );
  toggles.syncFields(["blank", "car"]);
  eq(
    boxesOf(toggles)
      .filter((b) => b.on)
      .map((b) => b.field),
    ["blank", "car"]
  );
  eq(
    boxesOf(toggles).map((b) => b.node.classList.contains("is-clicked")),
    popped,
    "no pop animation on restore"
  );
});

// --- localStorage -----------------------------------------------------------
check("nothing stored means everything is compared", () => {
  eq(storage.getItem(RECON_COMPARE_STORAGE_KEY), null, "store starts empty");
  eq(loadReconcileCompareFields(), RECON_COMPARE_FIELDS);
});

check("a switched-off field survives a restart", () => {
  saveReconcileCompareFields(["policy", "blank", "from", "to"]);
  eq(
    JSON.parse(storage.getItem(RECON_COMPARE_STORAGE_KEY)),
    ["policy", "blank", "from", "to"],
    "written as a JSON array"
  );
  // A fresh view reads it back: this is the "no re-clicking" part.
  eq(loadReconcileCompareFields(), ["policy", "blank", "from", "to"]);
});

check("a damaged stored value cannot hide differences", () => {
  storage.setItem(RECON_COMPARE_STORAGE_KEY, "{oops");
  eq(loadReconcileCompareFields(), RECON_COMPARE_FIELDS);
  storage.setItem(RECON_COMPARE_STORAGE_KEY, '["gone","renamed"]');
  eq(loadReconcileCompareFields(), RECON_COMPARE_FIELDS);
  storage.setItem(RECON_COMPARE_STORAGE_KEY, "car");
  eq(loadReconcileCompareFields(), ["car"]);
});

check("an unavailable store neither throws nor forgets", () => {
  storage.setItem(RECON_COMPARE_STORAGE_KEY, '["car"]');
  storage.broken = true;
  eq(loadReconcileCompareFields(), RECON_COMPARE_FIELDS, "read falls back");
  saveReconcileCompareFields(["policy"]); // must not throw
  storage.broken = false;
  eq(
    JSON.parse(storage.getItem(RECON_COMPARE_STORAGE_KEY)),
    ["car"],
    "the last good value is untouched"
  );
});

// --- the report's controls (source-level) ------------------------------------
// reconcileView itself builds DOM and talks to the API, so the two controls
// added to it are checked where they are wired up: the creation-date range and
// the broker filter with the lookup's own autocomplete.
check("the report is run over a date range, not one date", () => {
  ok(src.includes('field(t("reconcile.dbDate"), fromInput)'), "from field");
  ok(src.includes('field(t("reconcile.dbDateTo"), toInput)'), "to field");
  ok(
    src.includes("creationFrom: fromInput.value") &&
      src.includes("creationTo: toInput.value"),
    "the typed range is what is reconciled"
  );
  ok(
    src.includes("reconDateRange(creationFrom, creationTo)"),
    "the range is what the database list is filtered by"
  );
});

check("the report has a Broker field fed by the lookup's suggestions", () => {
  ok(src.includes('field(t("broker"), brokerInput)'), "broker field");
  ok(
    /attachAutocomplete\(\s*brokerInput,/.test(src),
    "autocomplete attached to the broker input"
  );
  ok(
    src.includes("currentInsuranceSuggestions().brokers") &&
      src.includes("loadInsuranceFilterSuggestions()"),
    "suggestions come from the shared broker pool"
  );
});

check("a successful upload animates the drag-and-drop field", () => {
  ok(
    src.includes("function noticeDropZone()") &&
      src.includes("noticeDropZone();"),
    "a valid file triggers the drop-zone animation"
  );
  ok(
    src.includes('dropZone.classList.add("drop-accepted")') &&
      src.includes('dropZone.classList.remove("drop-accepted")'),
    "the class is added and later cleared, so it can replay"
  );
  ok(!src.includes("noticeDropdowns"), "the dropdown pulse is gone");
  ok(!appCss.includes(".dropdown-notice"), "no leftover dropdown animation");
  ok(workCss.includes(".drop-zone.drop-accepted"), "the drop field is animated");
  ok(workCss.includes("@keyframes drop-zone-accepted"), "keyframes defined");
  ok(
    /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[^}]*\.drop-zone\.drop-accepted/.test(
      workCss
    ),
    "the animation respects reduced motion"
  );
});

// --- the "thinking" indicator ----------------------------------------------
const loading = reconLoadingIndicator();

check("a thinking animation shows while the report is reconciled", () => {
  eq(loading.className, "recon-loading");
  eq(loading.getAttribute("role"), "status", "announced as a status");
  eq(loading.getAttribute("aria-live"), "polite");
  const dots = loading.children.find((c) =>
    c.className.split(/\s+/).includes("recon-loading-dots")
  );
  ok(dots, "dots rendered");
  eq(dots.children.length, 3, "three animated dots");
  ok(
    dots.children.every((d) => d.tagName === "SPAN"),
    "each dot is an element the CSS can animate"
  );
  eq(loading.children[1].textContent, "loading", "text from translations");
  ok(
    src.includes("result.replaceChildren(reconLoadingIndicator())"),
    "shown while the run is in progress"
  );
  ok(
    src.includes('btn.setAttribute("aria-busy", "true")') &&
      src.includes('btn.removeAttribute("aria-busy")'),
    "the Run button is busy while it works"
  );
  ok(workCss.includes(".recon-loading-dots span"), "dots styled");
  ok(workCss.includes("@keyframes recon-loading-bounce"), "bounce keyframes");
  ok(
    /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[^}]*\.recon-loading/.test(
      workCss
    ),
    "the animation respects reduced motion"
  );
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

