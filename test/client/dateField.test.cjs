"use strict";

// Node test for renderer/dateField.js — the app's dd/mm/yyyy date field.
//
// The native <input type="date"> cannot be made to show dd/mm/yyyy from the
// page (Chromium takes the segment order from the OS/browser locale), so the
// app uses its own text field + calendar. This test runs the REAL renderer
// file twice:
//   1. without a document, to check the pure helpers (parsing the typed text,
//      the dd/mm/yyyy display, the month grid, the datetime split);
//   2. against a tiny fake DOM, to check the field itself: the visible format,
//      the ISO value the rest of the app reads, typing, min/max, the calendar
//      opening on a click anywhere, picking a day and upgrading a native input
//      that is already in the page.
//
// Run with:  node test/client/dateField.test.cjs   (or: npm test)

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..", "..");
const SOURCE = fs.readFileSync(
  path.join(ROOT, "renderer", "dateField.js"),
  "utf8"
);

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
    console.log("        " + ((err && err.message) || err));
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

// ---------------------------------------------------------------------------
// 1) Pure helpers (no DOM)
// ---------------------------------------------------------------------------
const pure = {};
vm.createContext(pure);
vm.runInContext(SOURCE, pure, { filename: "renderer/dateField.js" });

check("a day is displayed as dd/mm/yyyy", () => {
  eq(pure.dateFieldDisplay("2026-10-01"), "01/10/2026", "day");
  eq(pure.dateFieldDisplay("2026-10-01 00:00:00"), "01/10/2026", "datetime");
  eq(pure.dateFieldDisplay(""), "", "empty");
  eq(pure.dateFieldDisplay("2026-02-31"), "", "impossible day");
});

check("typed text is read as dd/mm/yyyy (any separator, 8 digits too)", () => {
  eq(pure.dateFieldParseInput("01/10/2026"), "2026-10-01", "slashes");
  eq(pure.dateFieldParseInput("1/2/2026"), "2026-02-01", "short parts");
  eq(pure.dateFieldParseInput("01.10.2026"), "2026-10-01", "dots");
  eq(pure.dateFieldParseInput("01-10-2026"), "2026-10-01", "dashes");
  eq(pure.dateFieldParseInput("01102026"), "2026-10-01", "eight digits");
  eq(pure.dateFieldParseInput(""), "", "empty");
  eq(pure.dateFieldParseInput("31/02/2026"), null, "impossible day");
  eq(pure.dateFieldParseInput("2026-10-01"), null, "ISO is not typed input");
});

check("a datetime is split into its day and time", () => {
  eq(
    pure.dateFieldParseDateTime("2026-11-20T14:05"),
    { iso: "2026-11-20", time: "14:05" },
    "datetime-local"
  );
  eq(
    pure.dateFieldParseDateTime("2026-11-20 09:07:33"),
    { iso: "2026-11-20", time: "09:07" },
    "MySQL DATETIME"
  );
  eq(
    pure.dateFieldParseDateTime("2026-11-20"),
    { iso: "2026-11-20", time: "" },
    "day only"
  );
  eq(pure.dateFieldParseDateTime(""), { iso: "", time: "" }, "empty");
});

check("a time is normalised to HH:mm", () => {
  eq(pure.dateFieldTime("9:07"), "09:07", "one-digit hour");
  eq(pure.dateFieldTime("14:05:59"), "14:05", "seconds dropped");
  eq(pure.dateFieldTime("24:00"), "", "hour out of range");
  eq(pure.dateFieldTime("12:60"), "", "minute out of range");
  eq(pure.dateFieldTime(""), "", "empty");
});

check("the month grid is six Monday-first weeks", () => {
  const grid = pure.dateFieldMonthGrid("2026-11-20");
  eq(grid.length, 42, "42 cells");
  eq(grid[0], "2026-10-26", "starts on the Monday before the 1st");
  ok(grid.includes("2026-11-01"), "contains the 1st");
  ok(grid.includes("2026-11-30"), "contains the 30th");
  eq(new Date(`${grid[0]}T12:00:00`).getDay(), 1, "first cell is a Monday");
  eq(pure.dateFieldMonthGrid("2026-10-05")[0], "2026-09-28", "October grid");
});

check("the month label follows the chosen language", () => {
  pure.currentLang = "bg";
  eq(pure.dateFieldMonthLabel("2026-11-20"), "Ноември 2026", "Bulgarian");
  pure.currentLang = "en";
  eq(pure.dateFieldMonthLabel("2026-11-20"), "November 2026", "English");
  pure.currentLang = "bg";
});


// ---------------------------------------------------------------------------
// 2) The field itself, against a tiny fake DOM
// ---------------------------------------------------------------------------
function makeFakeDom() {
  class FakeEvent {
    constructor(type, opts) {
      this.type = type;
      this.bubbles = Boolean(opts && opts.bubbles);
      this.target = null;
      this.defaultPrevented = false;
    }
    preventDefault() {
      this.defaultPrevented = true;
    }
    stopPropagation() {
      // A real DOM event does not reach the ancestors after this call.
      this.propagationStopped = true;
    }
  }

  class Node {
    constructor(tag) {
      this.tagName = String(tag || "div").toUpperCase();
      this.children = [];
      this.parentNode = null;
      this.attributes = {};
      this.dataset = {};
      this.style = {};
      this.listeners = {};
      this.className = "";
      this.textContent = "";
      this.value = "";
      this.id = "";
      this.hidden = false;
      this.disabled = false;
      this.readOnly = false;
      this.type = "";
      const node = this;
      this.classList = {
        add(...names) {
          const set = new Set(
            String(node.className || "")
              .split(/\s+/)
              .filter(Boolean)
          );
          for (const name of names) set.add(name);
          node.className = Array.from(set).join(" ");
        },
        remove(...names) {
          const drop = new Set(names);
          node.className = String(node.className || "")
            .split(/\s+/)
            .filter((name) => name && !drop.has(name))
            .join(" ");
        },
        contains(name) {
          return String(node.className || "")
            .split(/\s+/)
            .includes(name);
        },
        toggle(name, force) {
          const has = this.contains(name);
          const on = force === undefined ? !has : Boolean(force);
          if (on) this.add(name);
          else this.remove(name);
          return on;
        },
      };
    }
    appendChild(child) {
      if (child.parentNode) child.parentNode.removeChild(child);
      child.parentNode = this;
      this.children.push(child);
      return child;
    }
    insertBefore(child, ref) {
      if (child.parentNode) child.parentNode.removeChild(child);
      const at = ref ? this.children.indexOf(ref) : -1;
      if (at === -1) this.children.push(child);
      else this.children.splice(at, 0, child);
      child.parentNode = this;
      return child;
    }
    removeChild(child) {
      const at = this.children.indexOf(child);
      if (at !== -1) this.children.splice(at, 1);
      child.parentNode = null;
      return child;
    }
    replaceChildren(...nodes) {
      for (const child of this.children.slice()) this.removeChild(child);
      for (const node of nodes) this.appendChild(node);
    }
    setAttribute(name, value) {
      this.attributes[name] = String(value);
      if (name === "class") this.className = String(value);
      if (name === "id") this.id = String(value);
    }
    getAttribute(name) {
      if (name in this.attributes) return this.attributes[name];
      return null;
    }
    addEventListener(type, fn) {
      if (!this.listeners[type]) this.listeners[type] = [];
      this.listeners[type].push(fn);
    }
    removeEventListener(type, fn) {
      const list = this.listeners[type] || [];
      const at = list.indexOf(fn);
      if (at !== -1) list.splice(at, 1);
    }
    dispatchEvent(event) {
      if (!event.target) event.target = this;
      let node = this;
      while (node) {
        for (const fn of (node.listeners[event.type] || []).slice()) {
          fn.call(node, event);
        }
        // Bubbling stops at the node whose listener called stopPropagation(),
        // exactly like a real DOM event.
        if (event.propagationStopped) break;
        node = node.parentNode;
      }
      return true;
    }
    contains(node) {
      for (let at = node; at; at = at.parentNode) if (at === this) return true;
      return false;
    }
    closest(selector) {
      const matches = (node) => {
        if (!node || !node.tagName) return false;
        if (selector === ".date-calendar-day") {
          return node.classList.contains("date-calendar-day");
        }
        if (selector === "label[for]") {
          return node.tagName === "LABEL" && node.getAttribute("for");
        }
        return false;
      };
      for (let at = this; at; at = at.parentNode) if (matches(at)) return at;
      return null;
    }
    focus() {
      this.focused = true;
    }
    getBoundingClientRect() {
      return {
        left: 10,
        top: 10,
        right: 210,
        bottom: 40,
        width: 200,
        height: 30,
      };
    }
    querySelectorAll(selector) {
      const parts = String(selector)
        .split(",")
        .map((part) => part.trim());
      const out = [];
      const walk = (node) => {
        for (const child of node.children) {
          const hit = parts.some((part) => {
            if (part.startsWith(".")) {
              return child.classList.contains(part.slice(1));
            }
            const m = /^([a-zA-Z0-9]*)\[([a-zA-Z-]+)="([^"]*)"\]$/.exec(part);
            if (!m) return false;
            const tag = m[1].toLowerCase();
            if (tag && child.tagName.toLowerCase() !== tag) return false;
            const attr = child.getAttribute(m[2]);
            const value = attr !== null ? attr : child[m[2]];
            return (
              String(value === undefined || value === null ? "" : value) === m[3]
            );
          });
          if (hit) out.push(child);
          walk(child);
        }
      };
      walk(this);
      return out;
    }
    get isConnected() {
      let root = this;
      while (root.parentNode) root = root.parentNode;
      return Boolean(root.isFakeDocument);
    }
  }

  const document = new Node("#document");
  document.isFakeDocument = true;
  document.readyState = "complete";
  document.documentElement = new Node("html");
  document.body = new Node("body");
  document.appendChild(document.body);
  document.createElement = (tag) => new Node(tag);
  document.getElementById = (id) => {
    let found = null;
    const walk = (node) => {
      for (const child of node.children) {
        if (child.id === id || child.getAttribute("id") === id) {
          found = child;
          return;
        }
        walk(child);
      }
    };
    walk(document);
    return found;
  };
  const window = {
    innerWidth: 1200,
    innerHeight: 800,
    addEventListener() {},
    removeEventListener() {},
  };
  return { document, window, Event: FakeEvent, Node };
}

const dom = makeFakeDom();
const ctx = {
  console,
  document: dom.document,
  window: dom.window,
  Event: dom.Event,
  currentLang: "en",
};
vm.createContext(ctx);
vm.runInContext(SOURCE, ctx, { filename: "renderer/dateField.js" });

function openPopup() {
  return (
    dom.document.body.children.find(
      (node) =>
        node.classList.contains("date-field-popup") && !node.hidden
    ) || null
  );
}

// A click outside every open field closes its calendar (the same path the app
// uses when the user clicks anywhere else on the page).
function closePopups() {
  dom.document.body.dispatchEvent(new dom.Event("mousedown", { bubbles: true }));
}


check("the field shows dd/mm/yyyy and answers with the ISO value", () => {
  const field = ctx.createDateField({ value: "2026-10-01" });
  eq(field.textInput.value, "01/10/2026", "visible text");
  eq(field.textInput.placeholder, "dd/mm/yyyy", "placeholder");
  eq(field.value, "2026-10-01", "ISO value");
  field.value = "2027-02-03";
  eq(field.textInput.value, "03/02/2027", "a write updates the text");
  eq(field.input.value, "2027-02-03", "hidden value");
  eq(field.input.type, "hidden", "the value holder is hidden");
  ok(field.focusTarget === field.input, "shared helpers read the hidden input");
});

check("typing dd/mm/yyyy commits the day and rejects impossible ones", () => {
  const field = ctx.createDateField({});
  let changes = 0;
  field.addEventListener("change", () => changes++);

  field.textInput.value = "01/10/2026";
  field.textInput.dispatchEvent(new dom.Event("blur"));
  eq(field.value, "2026-10-01", "typed day");
  eq(changes, 1, "one change event");

  field.textInput.value = "31/02/2026";
  field.textInput.dispatchEvent(new dom.Event("blur"));
  eq(field.value, "2026-10-01", "impossible day keeps the old value");
  eq(field.textInput.value, "01/10/2026", "the text is put back");
  eq(changes, 1, "no change event for a rejected day");

  field.textInput.value = "";
  field.textInput.dispatchEvent(new dom.Event("blur"));
  eq(field.value, "", "cleared");
  eq(changes, 2, "clearing is a change");
});

check("eight digits typed without separators become dd/mm/yyyy", () => {
  const field = ctx.createDateField({});
  field.textInput.value = "01102026";
  field.textInput.dispatchEvent(new dom.Event("input"));
  eq(field.textInput.value, "01/10/2026", "slashes inserted");
});

check("a day outside min/max is refused", () => {
  const field = ctx.createDateField({
    value: "2026-10-10",
    min: "2026-10-01",
    max: "2026-10-20",
  });
  field.textInput.value = "21/10/2026";
  field.textInput.dispatchEvent(new dom.Event("blur"));
  eq(field.value, "2026-10-10", "after max is refused");
  field.textInput.value = "30/09/2026";
  field.textInput.dispatchEvent(new dom.Event("blur"));
  eq(field.value, "2026-10-10", "before min is refused");
  field.textInput.value = "15/10/2026";
  field.textInput.dispatchEvent(new dom.Event("blur"));
  eq(field.value, "2026-10-15", "inside the bounds is accepted");
});

check("clicking any part of the field opens the calendar", () => {
  closePopups();
  const field = ctx.createDateField({ value: "2026-11-20" });
  dom.document.body.appendChild(field);
  field.dispatchEvent(new dom.Event("click", { bubbles: true }));
  const popup = openPopup();
  ok(popup, "the calendar is on screen");
  const grid = popup.children.find((node) =>
    node.classList.contains("date-calendar-grid")
  );
  ok(grid, "a day grid is rendered");
  eq(grid.children.length, 42, "six weeks");
  ok(
    grid.children.some(
      (day) =>
        day.classList.contains("date-calendar-day") &&
        day.classList.contains("selected")
    ),
    "the current day is marked"
  );
});

check("picking a day sets the value and closes the calendar", () => {
  closePopups();
  const field = ctx.createDateField({ value: "2026-11-20" });
  dom.document.body.appendChild(field);
  let changes = 0;
  field.addEventListener("change", () => changes++);
  field.dispatchEvent(new dom.Event("click", { bubbles: true }));
  const popup = openPopup();
  const grid = popup.children.find((node) =>
    node.classList.contains("date-calendar-grid")
  );
  const day = grid.children.find(
    (node) => node.getAttribute("data-iso") === "2026-11-03"
  );
  ok(day, "the 3rd is on the grid");
  day.dispatchEvent(new dom.Event("click", { bubbles: true }));
  eq(field.value, "2026-11-03", "value");
  eq(field.textInput.value, "03/11/2026", "visible text");
  eq(changes, 1, "a change event fired");
  eq(openPopup(), null, "the calendar closed");
});


check("the clear button empties the field", () => {
  const field = ctx.createDateField({ value: "2026-11-20" });
  let changes = 0;
  field.addEventListener("change", () => changes++);
  const clear = field.children.find((node) =>
    node.classList.contains("date-field-clear")
  );
  ok(clear, "clear button");
  clear.dispatchEvent(new dom.Event("click", { bubbles: true }));
  eq(field.value, "", "value cleared");
  eq(field.textInput.value, "", "text cleared");
  eq(changes, 1, "a change event fired");
});

// The X sits inside the field, so it must clear on its own click: the field's
// generic "a click anywhere opens the calendar" handler never runs for it (it
// stops the click), and it must not pop the calendar open either.
check("the clear button works on its own and leaves the calendar shut", () => {
  closePopups();
  const field = ctx.createDateField({ value: "2026-11-20" });
  dom.document.body.appendChild(field);
  const clear = field.children.find((node) =>
    node.classList.contains("date-field-clear")
  );
  ok(clear, "clear button");
  clear.dispatchEvent(new dom.Event("click", { bubbles: true }));
  eq(field.value, "", "value cleared");
  eq(openPopup(), null, "the calendar was not opened");
  eq(clear.hidden, true, "the X hides itself once the field is empty");
});

check("the calendar's Clear footer empties the field too", () => {
  closePopups();
  const field = ctx.createDateField({ value: "2026-11-20" });
  dom.document.body.appendChild(field);
  field.dispatchEvent(new dom.Event("click", { bubbles: true }));
  const popup = openPopup();
  ok(popup, "the calendar is on screen");
  const foot = popup.children.find((node) =>
    node.classList.contains("date-calendar-foot")
  );
  ok(foot, "a footer with Today/Clear");
  const clearFooter = foot.children.find((node) => node.textContent === "Clear");
  ok(clearFooter, "the Clear button");
  clearFooter.dispatchEvent(new dom.Event("click", { bubbles: true }));
  eq(field.value, "", "value cleared");
  eq(field.textInput.value, "", "text cleared");
  eq(openPopup(), null, "the calendar closed");
});

check("a datetime field keeps the time and its datetime-local value", () => {
  const field = ctx.createDateField({
    mode: "datetime",
    value: "2026-11-20T14:05",
  });
  eq(field.textInput.value, "20/11/2026", "date part");
  const time = field.children.find((node) =>
    node.classList.contains("date-field-time")
  );
  eq(time.value, "14:05", "time part");
  eq(field.value, "2026-11-20T14:05", "value");

  field.value = "2026-12-01";
  eq(field.value, "2026-12-01T14:05", "a new day keeps the time");
  field.value = "";
  eq(field.value, "", "cleared");
  eq(field.textInput.value, "", "date text cleared");
  eq(time.value, "", "time cleared");
});

check("a native date input in the page is upgraded in place", () => {
  const form = dom.document.createElement("div");
  dom.document.body.appendChild(form);
  const input = dom.document.createElement("input");
  input.setAttribute("type", "date");
  input.setAttribute("id", "StartDateInput");
  input.setAttribute("class", "FormInput");
  input.value = "2026-10-05";
  form.appendChild(input);

  ctx.enhanceDateInputs(dom.document);

  const holder = dom.document.getElementById("StartDateInput");
  ok(holder, "the id still resolves");
  eq(holder.value, "2026-10-05", "the page still reads the ISO value");
  eq(holder.className, "FormInput", "classes stay on the value holder");
  const field = form.children[0];
  ok(field.classList.contains("date-field"), "the wrapper took its place");
  eq(field.textInput.value, "05/10/2026", "the visible text is dd/mm/yyyy");

  // A <label for="StartDateInput"> opens the calendar, like the field itself.
  const label = dom.document.createElement("label");
  label.setAttribute("for", "StartDateInput");
  dom.document.body.appendChild(label);
  label.dispatchEvent(new dom.Event("click", { bubbles: true }));
  ok(openPopup(), "the label opened the calendar");
});

// ---------------------------------------------------------------------------
// 3) Wiring: every page uses the field
// ---------------------------------------------------------------------------
function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");
}

check("the pages load dateField.js before their own script", () => {
  const pages = [
    ["renderer/WorkPage/WorkPage.html", "WorkPage.js"],
    ["renderer/AddInsurance/AddInsurance.html", "AddInsurance.js"],
    ["renderer/AdminInsurance/AdminInsurance.html", "AdminInsurance.js"],
  ];
  for (const [page, script] of pages) {
    const html = read(page);
    const field = html.indexOf('src="../dateField.js"');
    const own = html.indexOf(`src="${script}"`);
    ok(field >= 0, `${page} loads dateField.js`);
    ok(field < own, `${page} loads it before ${script}`);
  }
});

check("every date input built in WorkPage goes through the field", () => {
  const source = read("renderer/WorkPage/WorkPage.js");
  ok(
    source.includes('type === "date" || type === "datetime-local"'),
    "input() recognises both date types"
  );
  ok(
    source.includes("return createDateField({"),
    "it returns the dd/mm/yyyy field"
  );
  ok(
    /input\("date"/.test(source),
    "the page still asks for date fields through input()"
  );
  // No leftover raw native date control is created anywhere.
  ok(
    !source.includes('node.type = "date"') &&
      !source.includes('node.type = "datetime-local"'),
    "no raw native date input is built"
  );
});

check("the calendar buttons cannot submit the form they sit in", () => {
  const source = read("renderer/dateField.js");
  ok(source.includes('toggle.type = "button"'), "the calendar button");
  ok(source.includes('clearBtn.type = "button"'), "the clear button");
  ok(source.includes('const prev = dateFieldNode("button"'), "month back");
  ok(source.includes('const next = dateFieldNode("button"'), "month forward");
  ok(source.includes("todayBtn.type = \"button\""), "Today");
  ok(source.includes('clearFooter.type = "button"'), "Clear in the footer");
  for (const name of ["prev", "next", "todayBtn", "clearFooter"]) {
    ok(
      source.includes(`${name}.type = "button"`),
      `${name} is a plain button`
    );
  }
});

check("any click inside the field opens the calendar", () => {
  const source = read("renderer/dateField.js");
  ok(
    source.includes('wrap.addEventListener("click"'),
    "the whole field listens for a click"
  );
  ok(source.includes("openCalendar();"), "and opens the calendar");
  ok(
    source.includes('document.addEventListener("mousedown", onDocumentDown, true)'),
    "a click outside closes it"
  );
});

check("the field and its calendar are styled for the app's theme", () => {
  const css = read("renderer/app.css");
  for (const selector of [
    ".date-field {",
    ".date-field-popup {",
    ".date-calendar-grid {",
    ".date-calendar-day {",
    ".date-calendar-day.selected {",
  ]) {
    ok(css.includes(selector), selector);
  }
  ok(
    /\.date-field-popup \{[^}]*z-index: 3000;/.test(css),
    "the popup sits above the modal backdrop"
  );
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

