"use strict";

// Node test for the password field built by buildForm() in
// renderer/WorkPage/WorkPage.js (the admin "new user" form).
//
// A password field is not a bare input any more: it carries the eye button that
// switches the field between masked and readable. That wrapper must not break
// what buildForm() does with a control -- the label has to point at the real
// input, and the submitted payload has to carry what was typed, not the
// wrapper's own (empty) value.
//
// The REAL files run in a vm: common.js for el()/setupPasswordToggle()/the eye
// icon, and the form helpers cut out of WorkPage.js.
//
// Fixture values are generated at run time on purpose. A literal
// username/password pair in the source reads as an embedded credential to
// secret scanners -- GitGuardian's generic "Username Password" and "Generic
// password" detectors flag `password` next to a quoted value, test file or not
// (a `.cjs` test file is not always recognised as test data). Do not paste a
// realistic pair back in here; build the value from `Date.now()` instead.
//
// Run with:  node Test/passwordField.test.cjs   (or: npm test)

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const COMMON_JS = path.join(ROOT, "renderer", "common.js");
const WORKPAGE_JS = path.join(ROOT, "renderer", "WorkPage", "WorkPage.js");

const src = fs.readFileSync(WORKPAGE_JS, "utf8");
const start = src.indexOf("let fieldIdCounter = 0;");
const end = src.indexOf("// Table helper");
if (start < 0 || end < 0 || end < start) {
  console.error("Could not locate the form helpers in WorkPage.js (moved?)");
  process.exit(1);
}
const formHelpers = src.slice(start, end);

// --- stub DOM -----------------------------------------------------------------
// Just enough of an element for el(), field(), buildForm() and the password
// toggle: attributes, classes, children, listeners and the few properties the
// form code touches.
function makeNode(tag) {
  const attrs = new Map();
  const listeners = new Map();
  const classes = new Set();
  const node = {
    tagName: String(tag || "div").toUpperCase(),
    children: [],
    dataset: {},
    textContent: "",
    value: "",
    placeholder: "",
    checked: false,
    disabled: false,
    id: "",
    title: "",
    type: "",
    html: "",
    classList: {
      add(...names) {
        names.forEach((n) => classes.add(n));
      },
      remove(...names) {
        names.forEach((n) => classes.delete(n));
      },
      contains: (name) => classes.has(name),
      toggle(name, force) {
        const on = force === undefined ? !classes.has(name) : !!force;
        if (on) classes.add(name);
        else classes.delete(name);
      },
    },
    setAttribute(name, value) {
      attrs.set(name, String(value));
    },
    getAttribute(name) {
      return attrs.has(name) ? attrs.get(name) : null;
    },
    removeAttribute(name) {
      attrs.delete(name);
    },
    appendChild(child) {
      node.children.push(child);
      return child;
    },
    addEventListener(type, fn) {
      listeners.set(type, fn);
    },
    dispatch(type, event) {
      const fn = listeners.get(type);
      if (fn) return fn(event || { preventDefault() {} });
      return undefined;
    },
    focus() {},
    select() {},
    get className() {
      return [...classes].join(" ");
    },
    set className(value) {
      classes.clear();
      String(value)
        .split(/\s+/)
        .filter(Boolean)
        .forEach((name) => classes.add(name));
    },
    get innerHTML() {
      return node.html;
    },
    set innerHTML(value) {
      node.html = String(value);
    },
  };
  return node;
}

const storage = new Map([["lang", "en"]]);
const document = {
  documentElement: { lang: "" },
  body: makeNode("body"),
  visibilityState: "visible",
  readyState: "complete",
  createElement: (tag) => makeNode(tag),
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener() {},
  removeEventListener() {},
};

const ctx = {
  console,
  document,
  localStorage: {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key),
    clear: () => storage.clear(),
  },
  addEventListener() {},
  removeEventListener() {},
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
};
ctx.window = ctx;
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(COMMON_JS, "utf8"), ctx, { filename: COMMON_JS });
vm.runInContext(formHelpers, ctx, { filename: "WorkPage.js#formHelpers" });

// --- tiny assert helpers ------------------------------------------------------
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
  if (a !== b) throw new Error(`${msg || "values differ"} (got ${a}, want ${b})`);
}
function ok(value, msg) {
  if (!value) throw new Error(msg || "expected a truthy value");
}
function walk(node, visit) {
  visit(node);
  (node.children || []).forEach((child) => walk(child, visit));
}
function byClass(node, className) {
  const out = [];
  walk(node, (n) => {
    if (n.classList && n.classList.contains(className)) out.push(n);
  });
  return out;
}
function byType(node, type) {
  const out = [];
  walk(node, (n) => {
    if (n.tagName === "INPUT" && n.type === type) out.push(n);
  });
  return out;
}
const settle = () => new Promise((resolve) => setImmediate(resolve));

// A form with a username and a password, built the way registerUserForm() does.
function passwordForm(submitted) {
  return vm.runInContext("buildForm", ctx)(
    [
      { key: "username", label: "Username", value: "" },
      { key: "password", label: "Password", type: "password", value: "" },
    ],
    async (payload) => submitted.push(payload),
    "Create"
  );
}

async function main() {
  console.log("Insurance — password field with the visibility toggle");

  const submitted = [];
  const form = passwordForm(submitted);
  const rows = byClass(form, "password-row");
  const toggles = byClass(form, "pw-toggle");
  const passInput = byType(form, "password")[0];

  await check("a password spec becomes a field holding input + eye button", () => {
    eq(rows.length, 1, "one .password-row wrapper");
    eq(toggles.length, 1, "one eye button");
    ok(passInput, "the password input exists");
    eq(rows[0].children.length, 2, "the wrapper holds the input and the button");
    eq(rows[0].children[0], passInput, "the input comes first");
    eq(rows[0].children[1], toggles[0], "the eye sits after the field");
    ok(
      /class="pw-eye-slash"/.test(toggles[0].innerHTML),
      "the eye carries the state slash"
    );
    eq(toggles[0].type, "button", "the eye must not submit the form");
    eq(toggles[0].getAttribute("aria-pressed"), "false", "starts masked");
    eq(toggles[0].title, "Show password", "label offers to show the password");
  });

  await check("the label points at the input, not at the wrapper", () => {
    const passField = form.children.find((control) =>
      control.children.includes(rows[0])
    );
    ok(passField, "the password field has a wrapper around the row");
    const caption = passField.children[0];
    eq(caption.tagName, "LABEL", "the field starts with its caption");
    ok(passInput.id, "the input got an id");
    eq(
      caption.getAttribute("for"),
      passInput.id,
      "clicking the caption focuses the password input"
    );
    eq(rows[0].id, "", "the wrapper must not steal the label target id");
  });

  await check("the eye switches the field between masked and readable", () => {
    eq(passInput.type, "password", "starts masked");
    toggles[0].dispatch("click");
    eq(passInput.type, "text", "revealed");
    eq(toggles[0].getAttribute("aria-pressed"), "true", "eye reports readable");
    eq(toggles[0].title, "Hide password", "the label offers to hide it");
    toggles[0].dispatch("click");
    eq(passInput.type, "password", "masked again");
    eq(toggles[0].getAttribute("aria-pressed"), "false", "eye reports hidden");
  });

  await check(
    "submitting sends what was typed, not the wrapper",
    async () => {
      // Generated per run on purpose (see the note at the top of the file): the
      // source must not contain a literal username + password pair, and a fresh
      // value also proves the payload carries what was typed rather than a
      // default the form filled in.
      const stamp = `${Date.now()}-${process.pid}`;
      const typedUser = `tester-${stamp}`;
      const typedValue = `typed-${stamp}`;
      byType(form, "text")[0].value = typedUser;
      passInput.value = typedValue;
      form.dispatch("submit");
      await settle();
      eq(submitted.length, 1, "the form submitted");
      eq(submitted[0].username, typedUser, "the username is sent");
      eq(submitted[0].password, typedValue, "the typed value is sent");
    }
  );

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main();
