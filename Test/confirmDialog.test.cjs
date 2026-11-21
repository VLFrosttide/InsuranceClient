"use strict";

// Node test for the themed confirmation dialog in renderer/common.js.
//
// The app used to ask through window.confirm(), which Electron draws as a
// bright OS window that ignores the dark theme. appConfirm() asks the same
// question in a card built from the app's own DOM (app.css styles it), and this
// test runs the REAL common.js against a tiny fake DOM to pin down:
//   * the card carries the question in the selected language,
//   * Cancel answers false and the confirm button answers true,
//   * a `danger` action paints the button (and the icon) in the danger colour,
//   * Escape cancels without the page's own Escape handler firing,
//   * a click on the backdrop cancels, a click on the card does not,
//   * a newer question replaces the open one (the older answers false),
//   * Cancel is focused first and the previous focus is handed back,
//   * EN and BG have the dialog strings and app.css has the styles.
//
// Run with:  node Test/confirmDialog.test.cjs   (or: npm test)

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const RENDERER = path.join(ROOT, "renderer");
const COMMON_JS = path.join(RENDERER, "common.js");
const APP_CSS = path.join(RENDERER, "app.css");

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log("  PASS  " + name);
  } catch (err) {
    failed++;
    console.log(
      "  FAIL  " + name + "  -> " + (err && err.message ? err.message : err)
    );
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

// --- fake DOM -----------------------------------------------------------------
function makeElement(tag) {
  const node = {
    tagName: String(tag || "").toUpperCase(),
    className: "",
    textContent: "",
    title: "",
    focusCalls: 0,
    children: [],
    parentNode: null,
    attrs: {},
    listeners: {},
    appendChild(child) {
      child.parentNode = this;
      this.children.push(child);
      return child;
    },
    remove() {
      if (!this.parentNode) return;
      const siblings = this.parentNode.children;
      const idx = siblings.indexOf(this);
      if (idx !== -1) siblings.splice(idx, 1);
      this.parentNode = null;
    },
    setAttribute(name, value) {
      this.attrs[name] = String(value);
    },
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(this.attrs, name)
        ? this.attrs[name]
        : null;
    },
    addEventListener(type, fn) {
      if (!this.listeners[type]) this.listeners[type] = [];
      this.listeners[type].push(fn);
    },
    // Clicks are how the test answers the dialog.
    click() {
      for (const fn of this.listeners.click || []) fn({ target: this });
    },
    focus() {
      this.focusCalls++;
    },
    querySelector(selector) {
      if (!selector || selector[0] !== ".") return null;
      const wanted = selector.slice(1);
      const visit = (node) => {
        const classes = String(node.className || "").split(/\s+/);
        if (classes.includes(wanted)) return node;
        for (const child of node.children) {
          const found = visit(child);
          if (found) return found;
        }
        return null;
      };
      for (const child of this.children) {
        const found = visit(child);
        if (found) return found;
      }
      return null;
    },
  };
  return node;
}

const body = makeElement("body");
const htmlRoot = makeElement("html");
htmlRoot.lang = "bg";

const storage = new Map([["lang", "bg"]]);
const localStorage = {
  getItem: (k) => (storage.has(k) ? storage.get(k) : null),
  setItem: (k, v) => storage.set(k, String(v)),
  removeItem: (k) => storage.delete(k),
};

// Escape is handled in the capture phase so the page's own Escape listener
// (which closes a dashboard modal) cannot fire behind the question. The stub
// keeps the capture flag to prove that.
const keyListeners = [];
const documentStub = {
  readyState: "complete",
  documentElement: htmlRoot,
  body,
  activeElement: null,
  createElement: makeElement,
  addEventListener(type, fn, capture) {
    if (type === "keydown") keyListeners.push({ fn, capture: Boolean(capture) });
  },
  removeEventListener(type, fn, capture) {
    if (type !== "keydown") return;
    const idx = keyListeners.findIndex(
      (l) => l.fn === fn && l.capture === Boolean(capture)
    );
    if (idx !== -1) keyListeners.splice(idx, 1);
  },
  querySelector: () => null,
  querySelectorAll: () => [],
  fireKeydown(event) {
    for (const l of keyListeners.filter((l) => l.capture)) l.fn(event);
    if (event.stopped) return;
    for (const l of keyListeners.filter((l) => !l.capture)) l.fn(event);
  },
};

const ctx = {
  console,
  Date,
  Math,
  Number,
  String,
  Boolean,
  Array,
  Object,
  Set,
  Map,
  Error,
  JSON,
  Promise,
  setTimeout: () => 0,
  clearTimeout: () => {},
  setInterval: () => 0,
  clearInterval: () => {},
  localStorage,
  location: { href: "" },
  document: documentStub,
  // No outbox / update bridge: those banners stay off in this harness.
  window: {
    addEventListener: () => {},
    removeEventListener: () => {},
    bridge: {},
  },
};
ctx.window.document = documentStub;

vm.createContext(ctx);
vm.runInContext(
  fs.readFileSync(COMMON_JS, "utf8") +
    "\nthis.__exports = { appConfirm, setLang };",
  ctx,
  { filename: "common.js" }
);
const api = ctx.__exports;

// Helpers over the rendered dialog.
function backdrop() {
  return body.querySelector(".confirm-backdrop");
}
function dialogParts() {
  const node = backdrop();
  ok(node, "dialog rendered");
  return {
    backdrop: node,
    card: node.querySelector(".confirm-dialog"),
    title: node.querySelector(".confirm-title"),
    message: node.querySelector(".confirm-message"),
    icon: node.querySelector(".confirm-icon"),
    buttons: node.querySelector(".confirm-actions").children,
  };
}

(async () => {
  console.log("confirmation dialog: the question");

  await check("asks in the app's own card, not in the OS window", async () => {
    const answer = api.appConfirm("Да се изтрие ли застраховка 123456?");
    const { card, title, message, buttons } = dialogParts();

    eq(card.getAttribute("role"), "alertdialog", "announced as a dialog");
    eq(card.getAttribute("aria-modal"), "true", "modal for screen readers");
    eq(title.textContent, "Потвърждение", "Bulgarian title");
    eq(message.textContent, "Да се изтрие ли застраховка 123456?", "the question");
    eq(
      buttons.map((b) => b.textContent),
      ["Отмени", "Потвърди"],
      "Cancel / Confirm labels"
    );
    eq(buttons[1].className, "", "no danger colour on a safe question");

    buttons[0].click();
    eq(await answer, false, "Cancel answers false");
    eq(backdrop(), null, "the card is removed");
  });

  await check("the confirm button answers true", async () => {
    const answer = api.appConfirm("Да се изпрати ли този отговор?");
    dialogParts().buttons[1].click();
    eq(await answer, true, "Confirm answers true");
    eq(backdrop(), null, "the card is removed");
  });

  await check("a destructive action is painted in the danger colour", async () => {
    const answer = api.appConfirm("Да се изтрие ли брокер Euroins?", {
      danger: true,
      confirmLabel: "Изтрий",
    });
    const { icon, buttons } = dialogParts();
    eq(icon.className, "confirm-icon danger", "warning icon");
    eq(icon.textContent, "⚠", "warning glyph");
    eq(buttons[1].className, "danger", "red confirm button");
    eq(buttons[1].textContent, "Изтрий", "action-specific label");
    eq(buttons[0].className, "secondary", "Cancel stays neutral");

    buttons[1].click();
    eq(await answer, true, "confirmed");
  });

  await check("the texts follow the selected language", async () => {
    api.setLang("en");
    const answer = api.appConfirm("Delete insurance 123456?");
    const { title, buttons } = dialogParts();
    eq(title.textContent, "Please confirm", "English title");
    eq(
      buttons.map((b) => b.textContent),
      ["Cancel", "Confirm"],
      "English buttons"
    );
    buttons[0].click();
    await answer;
    api.setLang("bg");
  });

  console.log("confirmation dialog: dismissing it");

  await check("Escape cancels and never reaches the page behind", async () => {
    const answer = api.appConfirm("Да се изчисти ли формата?");
    let reachedPage = false;
    documentStub.addEventListener("keydown", () => {
      reachedPage = true;
    });

    const event = {
      key: "Escape",
      prevented: false,
      stopped: false,
      preventDefault() {
        this.prevented = true;
      },
      stopPropagation() {
        this.stopped = true;
      },
    };
    documentStub.fireKeydown(event);

    eq(event.prevented, true, "Escape is handled by the dialog");
    eq(event.stopped, true, "propagation stops at the dialog");
    eq(reachedPage, false, "a dashboard modal does not close behind it");
    eq(await answer, false, "Escape answers false");
    eq(backdrop(), null, "the card is removed");
    eq(keyListeners.length, 1, "only the page's own listener is left");
  });

  await check("a click on the backdrop cancels, inside the card does not", async () => {
    const answer = api.appConfirm("Да се откаже ли тази полица?");
    const { backdrop: shield, card } = dialogParts();

    card.click();
    ok(backdrop(), "still open after a click inside the card");

    shield.click();
    eq(await answer, false, "the backdrop cancels");
    eq(backdrop(), null, "the card is removed");
  });

  await check("a newer question replaces the open one", async () => {
    const first = api.appConfirm("Първи въпрос?");
    const second = api.appConfirm("Втори въпрос?");
    eq(await first, false, "the replaced question answers false");
    const { message, buttons } = dialogParts();
    eq(message.textContent, "Втори въпрос?", "only the newest is shown");
    eq(body.children.length, 1, "a single card");
    buttons[1].click();
    eq(await second, true, "the newest answers true");
  });

  console.log("confirmation dialog: focus");

  await check("Cancel is focused first and focus is handed back", async () => {
    const previous = makeElement("input");
    documentStub.activeElement = previous;

    const answer = api.appConfirm("Да се изчисти ли формата?");
    const { buttons } = dialogParts();
    eq(buttons[0].focusCalls, 1, "Cancel has focus, so Enter cannot delete");
    eq(buttons[1].focusCalls, 0, "the confirm button is not focused");

    buttons[1].click();
    eq(await answer, true, "confirmed");
    eq(previous.focusCalls, 1, "focus returned to the field");
    documentStub.activeElement = null;
  });

  console.log("confirmation dialog: wiring");

  await check("the dialog strings exist in EN and BG", () => {
    const common = fs.readFileSync(COMMON_JS, "utf8");
    for (const key of ["confirmTitle", "confirmOk", "confirmCancel"]) {
      eq(
        (common.match(new RegExp(`\\b${key}:`, "g")) || []).length,
        2,
        `${key} in EN and BG`
      );
    }
  });

  await check("app.css styles the dialog with the app theme", () => {
    const css = fs.readFileSync(APP_CSS, "utf8");
    for (const rule of [
      ".confirm-backdrop",
      ".confirm-dialog",
      ".confirm-icon.danger",
      ".confirm-message",
      ".confirm-actions",
    ]) {
      ok(css.includes(rule), `${rule} has a style`);
    }
  });

  if (failed) process.exit(1);
  console.log(`confirmDialog: ${passed} passed, ${failed} failed`);
})();



