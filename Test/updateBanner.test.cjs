"use strict";

// Node test for the auto-update banner in renderer/common.js.
//
// Runs the REAL common.js against a tiny fake DOM and a fake preload bridge:
//   * the state fetched on load brings the banner straight back after a page
//     change (the download itself lives in the main process),
//   * a known size paints the percentage and the width of the progress line,
//   * an unknown size sweeps instead of inventing a percentage,
//   * the finished download shows the "Restart now" / "Later" buttons,
//   * those buttons call the main process, and a refused restart re-enables
//     them instead of leaving the banner stuck,
//   * "Later" hides the banner again, and switching the language re-labels it.
//
// Run with:  node Test/updateBanner.test.cjs   (or: npm test)

const fs = require("fs");
const path = require("path");
const vm = require("vm");

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
    console.log("        " + (err && err.stack ? err.stack : err));
  }
}
function eq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${label}: expected ${e}, got ${a}`);
}
function ok(condition, label) {
  if (!condition) throw new Error(label);
}

// --- fake DOM -----------------------------------------------------------------
function makeClassList(node) {
  return {
    add(...names) {
      const set = new Set(String(node.className || "").split(/\s+/).filter(Boolean));
      for (const name of names) set.add(name);
      node.className = Array.from(set).join(" ");
    },
    remove(...names) {
      const set = new Set(String(node.className || "").split(/\s+/).filter(Boolean));
      for (const name of names) set.delete(name);
      node.className = Array.from(set).join(" ");
    },
    toggle(name, force) {
      const set = new Set(String(node.className || "").split(/\s+/).filter(Boolean));
      const on = force === undefined ? !set.has(name) : Boolean(force);
      if (on) set.add(name);
      else set.delete(name);
      node.className = Array.from(set).join(" ");
      return on;
    },
    contains(name) {
      return String(node.className || "").split(/\s+/).includes(name);
    },
  };
}

function makeElement(tag) {
  const node = {
    tagName: String(tag || "").toUpperCase(),
    className: "",
    textContent: "",
    title: "",
    disabled: false,
    style: {},
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
    replaceChildren(...nodes) {
      this.children = nodes;
      for (const child of nodes) child.parentNode = this;
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
    querySelector(selector) {
      if (!selector || selector[0] !== ".") return null;
      const wanted = selector.slice(1);
      const visit = (el) => {
        const classes = String(el.className || "").split(/\s+/);
        if (classes.includes(wanted)) return el;
        for (const child of el.children) {
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
    querySelectorAll() {
      return [];
    },
    focus() {},
  };
  node.classList = makeClassList(node);
  return node;
}

// --- harness ------------------------------------------------------------------
const body = makeElement("body");
const htmlRoot = { className: "", lang: "bg" };
htmlRoot.classList = makeClassList(htmlRoot);

const storage = new Map([["lang", "bg"]]);
const localStorage = {
  getItem: (k) => (storage.has(k) ? storage.get(k) : null),
  setItem: (k, v) => storage.set(k, String(v)),
  removeItem: (k) => storage.delete(k),
};

const documentStub = {
  readyState: "complete",
  documentElement: htmlRoot,
  body,
  createElement: makeElement,
  addEventListener: () => {},
  removeEventListener: () => {},
  querySelector: () => null,
  querySelectorAll: () => [],
};

// What the "main process" reports on load, plus counters for the two buttons.
const initialState = {
  phase: "downloading",
  version: "4.6.2",
  percent: 42,
  transferred: 420,
  total: 1000,
  bytesPerSecond: 500000,
};
let broadcast = null;
let installCalls = 0;
let installResult = { ok: true };
let dismissCalls = 0;

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
  window: {
    addEventListener: () => {},
    removeEventListener: () => {},
    bridge: {
      UpdateGetState: () => Promise.resolve(initialState),
      UpdateInstall: () => {
        installCalls++;
        return Promise.resolve(installResult);
      },
      UpdateDismiss: () => {
        dismissCalls++;
        return Promise.resolve({ ok: true });
      },
      OnUpdateState: (callback) => {
        broadcast = callback;
        return () => {};
      },
    },
  },
};
ctx.window.document = documentStub;

const renderer = path.join(__dirname, "..", "renderer");
vm.createContext(ctx);
vm.runInContext(
  fs.readFileSync(path.join(renderer, "common.js"), "utf8") +
    "\nthis.__exports = { applyUpdateBannerState, renderUpdateBanner, " +
    "updateBannerPercent, updateBannerVersion, setLang };",
  ctx,
  { filename: "common.js" }
);
const api = ctx.__exports;

const tick = () => new Promise((resolve) => setImmediate(resolve));

function banner() {
  return body.querySelector(".update-banner");
}
function bannerText() {
  const node = banner();
  ok(node, "banner exists");
  return node.querySelector(".update-banner-text").textContent;
}
function bannerFill() {
  const node = banner();
  ok(node, "banner exists");
  return node.querySelector(".update-banner-fill");
}
function bannerButtons() {
  const node = banner();
  ok(node, "banner exists");
  return node.querySelector(".update-banner-actions").children;
}


(async () => {
  await tick();

  console.log("update banner: download in progress");

  check("the state fetched on load brings the banner back after a page change", () => {
    const node = banner();
    ok(node, "banner rendered");
    ok(!node.classList.contains("hidden"), "visible");
    eq(node.classList.contains("downloading"), true, "downloading state");
    eq(htmlRoot.classList.contains("update-banner-open"), true, "page pushed down");
  });

  check("a known size shows the version and the percentage", () => {
    eq(bannerText(), "Изтегля се актуализация 4.6.2… 42%", "Bulgarian label");
    eq(bannerFill().style.width, "42%", "progress line width");
    eq(banner().classList.contains("indeterminate"), false, "not sweeping");
    eq(bannerButtons().length, 0, "no buttons while downloading");
  });

  check("the line keeps moving between updates (throttled percentages)", () => {
    broadcast({ ...initialState, percent: 43.4 });
    eq(bannerFill().style.width, "43%", "rounded width");
    broadcast({ ...initialState, percent: 43.6 });
    eq(bannerFill().style.width, "44%", "rounded up");
    eq(bannerText(), "Изтегля се актуализация 4.6.2… 44%", "label follows");
  });

  check("an unknown size sweeps instead of inventing a percentage", () => {
    broadcast({ phase: "downloading", version: "4.6.2", percent: null });
    eq(banner().classList.contains("indeterminate"), true, "sweeping");
    eq(bannerFill().style.width, "", "no fixed width");
    eq(bannerText(), "Изтегля се актуализация 4.6.2…", "label without percent");
  });

  console.log("update banner: download finished");

  check("the finished download turns the strip green and offers both choices", () => {
    broadcast({ phase: "ready", version: "4.6.2", percent: 100 });
    const node = banner();
    eq(node.classList.contains("ready"), true, "ready state");
    eq(node.classList.contains("indeterminate"), false, "not sweeping");
    eq(node.querySelector(".update-banner-icon").textContent, "✔", "tick icon");
    eq(bannerText(), "Актуализация 4.6.2 е готова за инсталиране", "title");
    eq(
      node.title,
      "Рестартирайте, за да я приложите сега, или тя ще се инсталира при затваряне на програмата.",
      "tooltip"
    );
    eq(bannerFill().style.width, "", "the CSS fills the line to 100 %");
    const buttons = bannerButtons();
    eq(buttons.length, 2, "two buttons");
    eq(buttons[0].textContent, "Рестартирай сега", "restart label");
    eq(buttons[1].textContent, "По-късно", "later label");
  });

  check("a progress update does not rebuild the buttons (no flicker)", () => {
    const before = bannerButtons()[0];
    broadcast({ phase: "ready", version: "4.6.2", percent: 100 });
    ok(bannerButtons()[0] === before, "same button node");
  });


  bannerButtons()[1].listeners.click[0]();
  await tick();
  check("\"Later\" asks the main process to hide the banner", () => {
    eq(dismissCalls, 1, "UpdateDismiss called");
  });

  check("the main process then hides it and frees the page", () => {
    broadcast({ phase: "idle" });
    eq(banner().classList.contains("hidden"), true, "hidden");
    eq(htmlRoot.classList.contains("update-banner-open"), false, "page released");
  });

  console.log("update banner: restarting");

  installResult = { ok: false, error: "demo" };
  broadcast({ phase: "ready", version: "4.6.2", percent: 100 });
  bannerButtons()[0].listeners.click[0]();
  await tick();
  check("a refused restart re-enables the buttons and says why", () => {
    eq(installCalls, 1, "UpdateInstall called");
    const buttons = bannerButtons();
    eq(buttons[0].disabled, false, "restart enabled again");
    eq(buttons[1].disabled, false, "later enabled again");
    eq(buttons[0].textContent, "Рестартирай сега", "original label restored");
    const toastNode = body.querySelector(".toast");
    ok(toastNode, "error toast shown");
    eq(
      toastNode.textContent,
      "Рестартирането не успя — затворете и отворете програмата ръчно, за да се приложи актуализацията.",
      "toast text"
    );
  });

  installResult = { ok: true };
  bannerButtons()[0].listeners.click[0]();
  await tick();
  check("a successful restart disables both buttons", () => {
    eq(installCalls, 2, "UpdateInstall called again");
    const buttons = bannerButtons();
    eq(buttons[0].disabled, true, "restart disabled");
    eq(buttons[1].disabled, true, "later disabled");
    eq(buttons[0].textContent, "Рестартиране…", "progress label");
  });

  console.log("update banner: language switch");

  check("switching the language re-labels the banner and its buttons", () => {
    api.setLang("en");
    eq(bannerText(), "Update 4.6.2 is ready to install", "English title");
    eq(
      bannerButtons().map((button) => button.textContent),
      ["Restart now", "Later"],
      "English buttons"
    );
    eq(
      banner().title,
      "Restart to apply it now, or it will be installed when the app is closed.",
      "English tooltip"
    );
  });

  check("a release without a version still reads correctly", () => {
    eq(api.updateBannerVersion({}), "a new version", "stand-in version");
    broadcast({ phase: "downloading", version: null, percent: null });
    eq(bannerText(), "Downloading update a new version…", "no literal {version}");
  });

  check("percentages are clamped and junk values are ignored", () => {
    eq(api.updateBannerPercent({ percent: 140 }), 100, "clamped above");
    eq(api.updateBannerPercent({ percent: -5 }), 0, "clamped below");
    eq(api.updateBannerPercent({ percent: "abc" }), null, "not a number");
    eq(api.updateBannerPercent({}), null, "missing");
  });

  if (failed) process.exit(1);
  console.log(`updateBanner: ${passed} passed, ${failed} failed`);
})();

