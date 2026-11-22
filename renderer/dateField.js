"use strict";

// ---------------------------------------------------------------------------
// Date field — always dd/mm/yyyy
//
// A native <input type="date"> paints its day/month/year segments in the
// browser's UI locale, and a page cannot change that order (Chromium takes it
// from the OS/browser locale; Electron falls back to MM/DD/YYYY). The app
// therefore uses its own field: a text input the user types as dd/mm/yyyy,
// plus a small calendar popup that opens when ANY part of the field is
// clicked - not only the tiny calendar glyph on the right.
//
// The real value holder stays an `<input>` element (`hidden`), so the code
// that already reads `.value` keeps receiving the ISO "YYYY-MM-DD" string it
// sends to the server, and "change" events keep firing exactly as before.
// A `datetime-local` field gets a date part (dd/mm/yyyy) and a time part
// (HH:mm); its value stays "YYYY-MM-DDTHH:mm".
//
// Everything here is plain DOM/JS on purpose: the renderer files are classic
// scripts (no bundler), and Test/dateField.test.cjs runs the pure helpers in a
// vm.
// ---------------------------------------------------------------------------

const DATE_FIELD_PLACEHOLDER = "dd/mm/yyyy";

const DATE_FIELD_MONTHS = {
  bg: [
    "Януари",
    "Февруари",
    "Март",
    "Април",
    "Май",
    "Юни",
    "Юли",
    "Август",
    "Септември",
    "Октомври",
    "Ноември",
    "Декември",
  ],
  en: [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ],
};

// Monday first, the way the office reads a week.
const DATE_FIELD_WEEKDAYS = {
  bg: ["пн", "вт", "ср", "чт", "пт", "сб", "нд"],
  en: ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"],
};

const DATE_FIELD_TEXT = {
  bg: {
    today: "Днес",
    clear: "Изчисти",
    open: "Изберете дата",
    previous: "Предишен месец",
    next: "Следващ месец",
  },
  en: {
    today: "Today",
    clear: "Clear",
    open: "Choose a date",
    previous: "Previous month",
    next: "Next month",
  },
};

// The language chosen in the app (common.js keeps it in `currentLang`), with
// the page's own lang attribute as a fallback.
function dateFieldLang() {
  const lang =
    (typeof currentLang === "string" && currentLang) ||
    (typeof document !== "undefined" && document.documentElement
      ? document.documentElement.lang
      : "") ||
    "bg";
  return DATE_FIELD_MONTHS[lang] ? lang : "bg";
}

function dateFieldPad(n) {
  return String(n).padStart(2, "0");
}

// "YYYY-MM-DD" of a Date's LOCAL calendar day.
function dateFieldFromDate(d) {
  return `${d.getFullYear()}-${dateFieldPad(d.getMonth() + 1)}-${dateFieldPad(
    d.getDate()
  )}`;
}

// A real calendar day as "YYYY-MM-DD", or "". Accepts a Date, an ISO day and a
// stored DATETIME ("2026-10-01 00:00:00"), so every caller can pass what it has.
function dateFieldIso(value) {
  if (value === undefined || value === null || value === "") return "";
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? "" : dateFieldFromDate(value);
  }
  const m = String(value).trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return "";
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const da = Number(m[3]);
  const d = new Date(y, mo - 1, da);
  if (d.getFullYear() !== y || d.getMonth() !== mo - 1 || d.getDate() !== da) {
    return "";
  }
  return `${m[1]}-${m[2]}-${m[3]}`;
}

// "2026-10-01" -> "01/10/2026" (the app-wide date order).
function dateFieldDisplay(iso) {
  const value = dateFieldIso(iso);
  return value
    ? `${value.slice(8, 10)}/${value.slice(5, 7)}/${value.slice(0, 4)}`
    : "";
}


// What the user typed as a calendar day: dd/mm/yyyy (any of / - . as the
// separator, one or two digit day/month) or eight digits without separators.
// Returns "YYYY-MM-DD", "" for empty, or null when it is not a real day.
function dateFieldParseInput(text) {
  const s = String(text === undefined || text === null ? "" : text).trim();
  if (!s) return "";
  let y;
  let mo;
  let da;
  const m = /^(\d{1,2})\s*[./-]\s*(\d{1,2})\s*[./-]\s*(\d{4})$/.exec(s);
  if (m) {
    da = Number(m[1]);
    mo = Number(m[2]);
    y = Number(m[3]);
  } else {
    const digits = s.replace(/\D/g, "");
    if (digits.length !== 8) return null;
    da = Number(digits.slice(0, 2));
    mo = Number(digits.slice(2, 4));
    y = Number(digits.slice(4));
  }
  const d = new Date(y, mo - 1, da);
  if (d.getFullYear() !== y || d.getMonth() !== mo - 1 || d.getDate() !== da) {
    return null;
  }
  return `${y}-${dateFieldPad(mo)}-${dateFieldPad(da)}`;
}

// "HH:mm" of a stored time, or "" when it is not a valid time of day.
function dateFieldTime(value) {
  const m = String(value === undefined || value === null ? "" : value)
    .trim()
    .match(/^(\d{1,2}):(\d{2})/);
  if (!m) return "";
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 23 || mi > 59) return "";
  return `${dateFieldPad(h)}:${dateFieldPad(mi)}`;
}

// Split a stored datetime ("YYYY-MM-DDTHH:mm[:ss]", "YYYY-MM-DD HH:mm[:ss]")
// into its day and time. Anything else is treated as empty.
function dateFieldParseDateTime(value) {
  const s = String(value === undefined || value === null ? "" : value).trim();
  if (!s) return { iso: "", time: "" };
  const m = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{1,2}:\d{2})(?::\d{2})?)?$/.exec(s);
  if (!m) return { iso: "", time: "" };
  return { iso: dateFieldIso(m[1]), time: m[2] ? dateFieldTime(m[2]) : "" };
}

// The six Monday-first weeks (42 cells) covering the month `iso` falls in.
// Each cell is a real "YYYY-MM-DD"; the padding days of the neighbouring
// months are included so the grid never jumps around.
function dateFieldMonthGrid(iso) {
  const base = dateFieldIso(iso) || dateFieldFromDate(new Date());
  const y = Number(base.slice(0, 4));
  const mo = Number(base.slice(5, 7));
  const first = new Date(y, mo - 1, 1);
  // getDay(): Sunday = 0; shift so Monday is the first column.
  const start = new Date(y, mo - 1, 1 - ((first.getDay() + 6) % 7));
  const cells = [];
  for (let i = 0; i < 42; i++) {
    cells.push(
      dateFieldFromDate(
        new Date(start.getFullYear(), start.getMonth(), start.getDate() + i)
      )
    );
  }
  return cells;
}

// "Ноември 2026" / "November 2026" for the month `iso` falls in.
function dateFieldMonthLabel(iso) {
  const base = dateFieldIso(iso) || dateFieldFromDate(new Date());
  const names = DATE_FIELD_MONTHS[dateFieldLang()];
  return `${names[Number(base.slice(5, 7)) - 1]} ${base.slice(0, 4)}`;
}

// ---------------------------------------------------------------------------
// The field itself
// ---------------------------------------------------------------------------

// hidden value input -> controller, so a label's `for` and the static-page
// enhancement can find the field again.
const DATE_FIELD_CONTROLLERS =
  typeof WeakMap === "function" ? new WeakMap() : null;

function dateFieldController(node) {
  if (!node || !DATE_FIELD_CONTROLLERS) return null;
  if (DATE_FIELD_CONTROLLERS.has(node)) return DATE_FIELD_CONTROLLERS.get(node);
  // The wrapper may carry the generated id (a label can point at either).
  if (node.input && DATE_FIELD_CONTROLLERS.has(node.input)) {
    return DATE_FIELD_CONTROLLERS.get(node.input);
  }
  return null;
}

function dateFieldNode(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

// A calendar popup lives on <body> so no table/modal can clip it. When the
// field that owns it was re-rendered away, the popup is dropped with it (the
// pages rebuild these fields on every reload, e.g. after a picked day).
function pruneDateFieldPopups() {
  if (typeof document === "undefined" || !document.body) return;
  for (const node of Array.from(
    document.querySelectorAll(".date-field-popup")
  )) {
    if (!node.fieldWrap || !node.fieldWrap.isConnected) {
      if (node.parentNode) node.parentNode.removeChild(node);
    }
  }
}

/**
 * Build a date field.
 *
 * The returned wrapper is what gets appended to the page. It carries the value
 * as an ISO string through `.value` (get/set), forwards `min`/`max`, and has a
 * `focusTarget` (the hidden value input) so shared helpers such as the form
 * builder in WorkPage.js read the ISO value, never the dd/mm/yyyy text.
 *
 * @param {{ mode?: "date"|"datetime", input?: HTMLInputElement,
 *           value?: string, min?: string, max?: string,
 *           id?: string, className?: string }} [options]
 */
function createDateField(options) {
  const opts = options || {};
  const mode = opts.mode === "datetime" ? "datetime" : "date";
  const labels = DATE_FIELD_TEXT[dateFieldLang()];

  // The value holder. When an existing input is upgraded, its id/classes stay
  // where the page expects to find them.
  const hidden = opts.input || document.createElement("input");
  const initialValue = opts.value !== undefined ? opts.value : hidden.value;
  if (hidden.type !== "hidden") hidden.type = "hidden";
  if (opts.id && !hidden.id) hidden.id = opts.id;
  if (opts.className && !hidden.className) hidden.className = opts.className;

  const wrap = dateFieldNode("span", "date-field");
  if (mode === "datetime") wrap.classList.add("date-field-datetime");

  const text = dateFieldNode("input", "date-field-text");
  text.type = "text";
  text.inputMode = "numeric";
  text.autocomplete = "off";
  text.spellcheck = false;
  text.placeholder = DATE_FIELD_PLACEHOLDER;
  text.setAttribute("aria-label", labels.open);

  const timeInput =
    mode === "datetime" ? dateFieldNode("input", "date-field-time") : null;
  if (timeInput) {
    timeInput.type = "text";
    timeInput.inputMode = "numeric";
    timeInput.autocomplete = "off";
    timeInput.spellcheck = false;
    timeInput.placeholder = "HH:mm";
    timeInput.setAttribute("aria-label", "HH:mm");
  }

  const clearBtn = dateFieldNode("button", "date-field-clear", "×");
  clearBtn.type = "button";
  clearBtn.hidden = true;
  clearBtn.setAttribute("aria-label", labels.clear);
  clearBtn.title = labels.clear;

  const toggle = dateFieldNode("button", "date-field-toggle", "📅");
  toggle.type = "button";
  toggle.setAttribute("aria-label", labels.open);
  toggle.title = labels.open;

  // The visible controls come first so a generic "focus the first input of the
  // modal" helper lands on the text field, never on the hidden value holder.
  wrap.appendChild(text);
  if (timeInput) wrap.appendChild(timeInput);
  wrap.appendChild(clearBtn);
  wrap.appendChild(toggle);
  wrap.appendChild(hidden);

  let iso = "";
  let time = "";
  let minIso = dateFieldIso(opts.min);
  let maxIso = dateFieldIso(opts.max);
  let disabled = Boolean(hidden.disabled);
  let readOnly = Boolean(opts.readOnly);
  let popup = null;
  let popupMonth = "";

  function emitChange() {
    // A native input fires "change" when the user commits a value; the code
    // that listens on the original element (or on the wrapper: the event
    // bubbles) keeps working unchanged.
    if (typeof Event === "function") {
      hidden.dispatchEvent(new Event("change", { bubbles: true }));
      hidden.dispatchEvent(new Event("input", { bubbles: true }));
    }
  }

  function withinLimits(day) {
    if (minIso && day < minIso) return false;
    if (maxIso && day > maxIso) return false;
    return true;
  }

  function syncDisplay() {
    text.value = iso ? dateFieldDisplay(iso) : "";
    if (timeInput) timeInput.value = iso ? time : "";
    clearBtn.hidden = !iso;
  }

  function setValue(value, dispatch) {
    let nextIso = "";
    let nextTime = "";
    if (mode === "datetime") {
      const parsed = dateFieldParseDateTime(value);
      nextIso = parsed.iso;
      nextTime = parsed.time;
    } else {
      nextIso = dateFieldIso(value);
    }
    const changed =
      nextIso !== iso || (mode === "datetime" && nextTime !== time);
    iso = nextIso;
    if (mode === "datetime") {
      // A new day without a time keeps the time already in the field; a fully
      // empty value clears both.
      time = iso ? nextTime || time || "00:00" : "";
    }
    syncDisplay();
    if (changed && dispatch) emitChange();
  }

  // `.value` on the hidden input is the ISO string the rest of the app reads
  // and writes; a programmatic write updates the visible text as well.
  Object.defineProperty(hidden, "value", {
    configurable: true,
    get() {
      if (mode === "datetime") return iso ? `${iso}T${time || "00:00"}` : "";
      return iso;
    },
    set(value) {
      setValue(value, false);
    },
  });
  // A label's `for` and AddInsurance's generic openDatePicker() helper expect
  // a focusable, picker-capable control; forward both to the visible field.
  Object.defineProperty(hidden, "focus", {
    configurable: true,
    value() {
      if (!disabled && !readOnly) text.focus();
    },
  });
  Object.defineProperty(hidden, "showPicker", {
    configurable: true,
    value() {
      openCalendar();
    },
  });
  Object.defineProperty(hidden, "click", {
    configurable: true,
    value() {
      openCalendar();
    },
  });

  Object.defineProperty(wrap, "value", {
    get() {
      return hidden.value;
    },
    set(value) {
      hidden.value = value;
    },
  });
  Object.defineProperty(wrap, "min", {
    get() {
      return minIso;
    },
    set(value) {
      minIso = dateFieldIso(value);
      if (popup && !popup.hidden) renderCalendar();
    },
  });
  Object.defineProperty(wrap, "max", {
    get() {
      return maxIso;
    },
    set(value) {
      maxIso = dateFieldIso(value);
      if (popup && !popup.hidden) renderCalendar();
    },
  });
  Object.defineProperty(wrap, "disabled", {
    get() {
      return disabled;
    },
    set(value) {
      setDisabled(value);
    },
  });
  Object.defineProperty(wrap, "readOnly", {
    get() {
      return readOnly;
    },
    set(value) {
      readOnly = Boolean(value);
      text.readOnly = readOnly;
      if (timeInput) timeInput.readOnly = readOnly;
    },
  });
  wrap.dataset.mode = mode;
  // Shared helpers (field(), buildForm()) follow this to the real control.
  wrap.focusTarget = hidden;

  // The holder is the element the page already had (an upgraded native input):
  // forward the properties such a field normally offers, so code that holds the
  // holder and code that holds the wrapper both work.
  for (const name of ["min", "max", "disabled", "readOnly"]) {
    Object.defineProperty(hidden, name, {
      configurable: true,
      get() {
        return wrap[name];
      },
      set(value) {
        wrap[name] = value;
      },
    });
  }

  function setDisabled(value) {
    disabled = Boolean(value);
    text.disabled = disabled;
    if (timeInput) timeInput.disabled = disabled;
    clearBtn.disabled = disabled;
    toggle.disabled = disabled;
    wrap.classList.toggle("is-disabled", disabled);
    if (disabled) closeCalendar();
  }

  function commitText() {
    const raw = text.value.trim();
    if (!raw) {
      if (iso) setValue("", true);
      else text.value = "";
      return;
    }
    // A real day inside the allowed range wins; otherwise put the last good
    // value back instead of silently sending something else.
    const parsed = dateFieldParseInput(raw);
    if (parsed && withinLimits(parsed)) {
      setValue(parsed, true);
      text.value = dateFieldDisplay(parsed);
      return;
    }
    // Not a real day (or outside min/max): put the last good value back
    // instead of silently sending something else.
    text.value = iso ? dateFieldDisplay(iso) : "";
  }

  function commitTime() {
    if (!timeInput) return;
    const raw = timeInput.value.trim();
    if (!raw) {
      timeInput.value = time;
      return;
    }
    const parsed = dateFieldTime(raw);
    if (!parsed) {
      timeInput.value = time;
      return;
    }
    if (parsed !== time) {
      time = parsed;
      timeInput.value = time;
      emitChange();
    }
  }

  // Typing may use any separator; the eight-digit form gets slashes inserted.
  text.addEventListener("input", () => {
    const raw = text.value;
    if (raw && /^\d+$/.test(raw)) {
      const digits = raw.slice(0, 8);
      let out = digits;
      if (digits.length > 4) {
        out = `${digits.slice(0, 2)}/${digits.slice(2, 4)}/${digits.slice(4)}`;
      } else if (digits.length > 2) {
        out = `${digits.slice(0, 2)}/${digits.slice(2)}`;
      }
      if (out !== raw) text.value = out;
    }
    closeCalendar();
  });
  text.addEventListener("change", commitText);
  text.addEventListener("blur", () => {
    commitText();
  });
  text.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      commitText();
      closeCalendar();
    } else if (event.key === "Escape") {
      closeCalendar();
    }
  });
  if (timeInput) {
    timeInput.addEventListener("change", commitTime);
    timeInput.addEventListener("blur", commitTime);
    timeInput.addEventListener("input", () => closeCalendar());
  }

  // Empty the field. The X beside the calendar button and the calendar's own
  // "Clear" footer both come through here, so they always behave the same.
  function clearValue() {
    setValue("", true);
    closeCalendar();
    if (!disabled && !readOnly) text.focus();
  }

  // Clicking ANY part of the field opens the calendar, not only the glyph.
  wrap.addEventListener("click", (event) => {
    if (disabled || readOnly) return;
    if (event.target === clearBtn) {
      event.preventDefault();
      clearValue();
      return;
    }
    if (event.target === timeInput) return; // the time part is typed
    event.preventDefault();
    openCalendar();
    text.focus();
  });
  // The X button clears the field itself. It stops the click so the field's
  // generic "open the calendar" handler (and any row/table click behind it)
  // never sees it - but it must do the clearing: stopping the event alone left
  // the button doing nothing at all.
  clearBtn.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (disabled || readOnly) return;
    clearValue();
  });

  if (readOnly) {
    text.readOnly = true;
    if (timeInput) timeInput.readOnly = true;
  }


  // --- calendar popup ------------------------------------------------------

  function buildCalendar() {
    const box = dateFieldNode("div", "date-field-popup");
    box.hidden = true;
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-label", labels.open);

    const head = dateFieldNode("div", "date-calendar-head");
    const prev = dateFieldNode("button", "date-calendar-nav", "‹");
    prev.type = "button";
    prev.title = labels.previous;
    prev.setAttribute("aria-label", labels.previous);
    const label = dateFieldNode("span", "date-calendar-label");
    const next = dateFieldNode("button", "date-calendar-nav", "›");
    next.type = "button";
    next.title = labels.next;
    next.setAttribute("aria-label", labels.next);
    head.appendChild(prev);
    head.appendChild(label);
    head.appendChild(next);

    const week = dateFieldNode("div", "date-calendar-week");
    for (const name of DATE_FIELD_WEEKDAYS[dateFieldLang()]) {
      week.appendChild(dateFieldNode("span", null, name));
    }

    const grid = dateFieldNode("div", "date-calendar-grid");

    const foot = dateFieldNode("div", "date-calendar-foot");
    const todayBtn = dateFieldNode("button", null, labels.today);
    todayBtn.type = "button";
    const clearFooter = dateFieldNode("button", null, labels.clear);
    clearFooter.type = "button";
    foot.appendChild(todayBtn);
    foot.appendChild(clearFooter);

    box.appendChild(head);
    box.appendChild(week);
    box.appendChild(grid);
    box.appendChild(foot);
    document.body.appendChild(box);

    prev.addEventListener("click", () => shiftMonth(-1));
    next.addEventListener("click", () => shiftMonth(1));
    todayBtn.addEventListener("click", () => {
      const today = dateFieldFromDate(new Date());
      if (!withinLimits(today)) return;
      setValue(mode === "datetime" ? `${today}T${time || "00:00"}` : today, true);
      closeCalendar();
    });
    clearFooter.addEventListener("click", () => clearValue());
    grid.addEventListener("click", (event) => {
      const day = event.target.closest
        ? event.target.closest(".date-calendar-day")
        : null;
      if (!day || day.disabled) return;
      const picked = day.getAttribute("data-iso");
      if (!picked) return;
      setValue(
        mode === "datetime" ? `${picked}T${time || "00:00"}` : picked,
        true
      );
      closeCalendar();
      text.focus();
    });

    popup = box;
    popup.labelNode = label;
    popup.gridNode = grid;
    popup.todayBtn = todayBtn;
  }

  function shiftMonth(delta) {
    const base = dateFieldIso(popupMonth) || dateFieldFromDate(new Date());
    const y = Number(base.slice(0, 4));
    const mo = Number(base.slice(5, 7)) - 1 + delta;
    const d = new Date(y, mo, 1);
    popupMonth = dateFieldFromDate(d);
    renderCalendar();
  }

  function renderCalendar() {
    if (!popup) return;
    const month = dateFieldIso(popupMonth) || dateFieldFromDate(new Date());
    const monthKey = month.slice(0, 7);
    const today = dateFieldFromDate(new Date());
    popup.labelNode.textContent = dateFieldMonthLabel(month);

    const grid = popup.gridNode;
    grid.replaceChildren();
    // "Today" is only offered while today is inside the field's bounds.
    if (popup.todayBtn) popup.todayBtn.disabled = !withinLimits(today);
    for (const day of dateFieldMonthGrid(month)) {
      const btn = dateFieldNode("button", "date-calendar-day", String(Number(day.slice(8, 10))));
      btn.type = "button";
      btn.setAttribute("data-iso", day);
      btn.title = dateFieldDisplay(day);
      if (day.slice(0, 7) !== monthKey) btn.classList.add("out");
      if (day === today) btn.classList.add("today");
      if (day === iso) btn.classList.add("selected");
      if (!withinLimits(day)) btn.disabled = true;
      grid.appendChild(btn);
    }
  }

  function positionCalendar() {
    if (!popup || popup.hidden) return;
    if (!wrap.isConnected) {
      closeCalendar();
      return;
    }
    const rect = text.getBoundingClientRect();
    const width = popup.offsetWidth || 250;
    const height = popup.offsetHeight || 300;
    const left = Math.min(
      Math.max(8, rect.left),
      Math.max(8, window.innerWidth - width - 8)
    );
    const below = rect.bottom + 4 + height <= window.innerHeight - 8;
    const top = below
      ? rect.bottom + 4
      : Math.max(8, rect.top - height - 4);
    popup.style.left = `${Math.round(left)}px`;
    popup.style.top = `${Math.round(top)}px`;
  }

  function onDocumentDown(event) {
    if (!popup || popup.hidden) return;
    if (popup.contains(event.target) || wrap.contains(event.target)) return;
    closeCalendar();
  }

  function onDocumentKey(event) {
    if (event.key === "Escape") closeCalendar();
  }

  function onViewportChange() {
    positionCalendar();
  }

  function openCalendar() {
    if (disabled || readOnly) return;
    pruneDateFieldPopups();
    if (!popup) buildCalendar();
    popup.fieldWrap = wrap;
    popupMonth = iso || dateFieldFromDate(new Date());
    popup.hidden = false;
    renderCalendar();
    positionCalendar();
    wrap.classList.add("is-open");
    document.addEventListener("mousedown", onDocumentDown, true);
    document.addEventListener("keydown", onDocumentKey, true);
    window.addEventListener("resize", onViewportChange);
    document.addEventListener("scroll", onViewportChange, true);
  }

  function closeCalendar() {
    if (!popup || popup.hidden) return;
    popup.hidden = true;
    wrap.classList.remove("is-open");
    document.removeEventListener("mousedown", onDocumentDown, true);
    document.removeEventListener("keydown", onDocumentKey, true);
    window.removeEventListener("resize", onViewportChange);
    document.removeEventListener("scroll", onViewportChange, true);
    // The field may have been replaced by the page while the calendar was open
    // (a picked day reloads the view): do not leave an orphan popup behind.
    if (!wrap.isConnected && popup.parentNode) {
      popup.parentNode.removeChild(popup);
      popup = null;
    }
  }

  setDisabled(disabled);
  setValue(initialValue, false);
  if (DATE_FIELD_CONTROLLERS) DATE_FIELD_CONTROLLERS.set(hidden, wrap);

  wrap.open = openCalendar;
  wrap.close = closeCalendar;
  wrap.focus = () => {
    if (!disabled && !readOnly) text.focus();
  };
  wrap.showPicker = openCalendar;
  wrap.input = hidden;
  wrap.textInput = text;
  return wrap;
}


// ---------------------------------------------------------------------------
// Upgrading the native fields already in the page
// ---------------------------------------------------------------------------

// Replace a native date input with the dd/mm/yyyy field. The original element
// is reused as the hidden value holder (same id, classes and name), so
// `document.getElementById(...)` and `getElementsByClassName("FormInput")`
// keep finding it and keep reading the ISO value.
function enhanceDateInput(input) {
  if (!input || !input.parentNode) return null;
  const existing = dateFieldController(input);
  if (existing) return existing;
  const parent = input.parentNode;
  const next = input.nextSibling;
  const field = createDateField({
    mode: input.type === "datetime-local" ? "datetime" : "date",
    input,
    value: input.value,
    min: input.getAttribute("min"),
    max: input.getAttribute("max"),
    id: input.id,
    className: input.className,
    readOnly: input.readOnly,
  });
  parent.insertBefore(field, next);
  return field;
}

// Every native date/datetime field under `root` (the whole page by default).
function enhanceDateInputs(root) {
  const scope = root || (typeof document !== "undefined" ? document : null);
  if (!scope || typeof scope.querySelectorAll !== "function") return;
  for (const input of Array.from(
    scope.querySelectorAll('input[type="date"], input[type="datetime-local"]')
  )) {
    enhanceDateInput(input);
  }
}

// A <label for="..."> pointing at the (now hidden) value holder focuses the
// visible text and opens the calendar, so clicking the caption works.
function dateFieldLabelClick(event) {
  const label =
    event.target && event.target.closest
      ? event.target.closest("label[for]")
      : null;
  if (!label) return;
  const target = document.getElementById(label.getAttribute("for"));
  const field = dateFieldController(target);
  if (!field) return;
  event.preventDefault();
  field.focus();
  field.open();
}

if (typeof document !== "undefined") {
  document.addEventListener("click", dateFieldLabelClick);
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => enhanceDateInputs());
  } else {
    enhanceDateInputs();
  }
}

