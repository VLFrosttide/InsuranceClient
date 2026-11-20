"use strict";

// Wiring checks for the day the Current cash tab remembers
// (renderer/WorkPage/WorkPage.js).
//
// Switching to another nav tab destroys the Current cash view and rebuilds it
// on return. Without a remembered day the tab jumped back to today, so anyone
// who had picked an earlier day lost it on every tab switch. These checks pin:
//   - the picked day is kept outside the DOM and is the default day of the
//     view, ahead of today;
//   - an explicitly requested day is remembered, while "today" is not stored,
//     so a tab left open past midnight still opens on the real today;
//   - the day picker reloads the view for the picked day (which is what stores
//     it), and has a one-day step button on each side so the history can be
//     walked without opening the calendar;
//   - every ledger row list - the handed-over cash included - is rendered below
//     the picker and shows the picked day;
//   - the end-of-shift reminder ignores the remembered day, because it is about
//     the shift running now.
//
// Run with:  node Test/currentCashDateState.test.cjs   (or: npm test)

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const WORKPAGE_JS = path.join(ROOT, "renderer", "WorkPage", "WorkPage.js");

const src = fs.readFileSync(WORKPAGE_JS, "utf8");

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
function ok(cond, msg) {
  if (!cond) throw new Error(msg || "expected truthy");
}
function eq(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b)
    throw new Error((msg || "values differ") + ` (got ${a}, want ${b})`);
}
// Slice the real file, so the checks exercise what the app ships.
function between(startMarker, endMarker) {
  const start = src.indexOf(startMarker);
  ok(start >= 0, `marker not found: ${startMarker}`);
  const end = endMarker ? src.indexOf(endMarker, start + startMarker.length) : -1;
  if (endMarker) ok(end > start, `end marker not found: ${endMarker}`);
  return endMarker ? src.slice(start, end) : src.slice(start);
}

console.log("Current cash — the picked day survives tab changes");

check("the picked day is kept outside the view", () => {
  ok(src.includes("let currentCashDate = null;"), "the state is declared");
  eq(
    (src.match(/let currentCashDate\b/g) || []).length,
    1,
    "declared exactly once"
  );
  ok(
    src.includes("let currentCashDate = null;"),
    "it starts empty, so the first visit opens on today"
  );
});

check("the view falls back to the remembered day before today", () => {
  const block = between(
    "async function currentCashView(",
    "\n  let allBranchNames = [];"
  );
  ok(
    block.includes("const today = localDateString(now);"),
    "today is built from local components"
  );
  ok(
    block.includes("const date = overrideDate || currentCashDate || today;"),
    "an explicitly requested day wins, then the remembered day, then today"
  );
  ok(
    block.includes(
      "currentCashDate = overrideDate === today ? null : overrideDate;"
    ),
    "an explicitly requested day is remembered (today is not)"
  );
});

check("the day picker reloads the view for the picked day", () => {
  const block = between(
    'const dateInput = input("date", date);',
    "const dateRow = el("
  );
  ok(block.includes("const picked = dateInput.value;"), "the field is read");
  ok(
    block.includes("currentCashView(branch, picked)"),
    "the view reloads for the picked day, which stores it"
  );
});

check("the day can be stepped one day back and forward", () => {
  const block = between(
    'const dateInput = input("date", date);',
    "const topNodes = [heading];"
  );
  ok(
    block.includes('const previousDayBtn = el("button"'),
    "a button on the left of the picker"
  );
  ok(
    block.includes('const nextDayBtn = el("button"'),
    "a button on the right of the picker"
  );
  ok(
    block.includes("stepToDay(previousLocalDate(dateInput.value || date))"),
    "the left button steps one day back from the shown day"
  );
  ok(
    block.includes("stepToDay(nextLocalDate(dateInput.value || date))"),
    "the right button steps one day forward from the shown day"
  );
  ok(
    block.includes("dateNav.appendChild(previousDayBtn)") &&
      block.includes("dateNav.appendChild(dateInput)") &&
      block.includes("dateNav.appendChild(nextDayBtn)"),
    "both buttons sit against the picker inside the same field"
  );
  eq(
    (block.match(/dateNav\.appendChild/g) || []).length,
    3,
    "the picker is flanked by exactly one button on each side"
  );
});

check("the handed-over cash list follows the picked day", () => {
  ok(
    // Whitespace-insensitive: the file is stored with CRLF line endings.
    src.replace(/\s+/g, " ").includes(
      "const outstandingHandovers = handoversOnDay( data.handoverStats.handovers, date )"
    ),
    "the section is filtered by the shown day"
  );
  const helper = between(
    "function handoversOnDay(",
    "\n// Make a Current cash balance card"
  );
  ok(
    helper.includes('.slice(0, 10) === date'),
    "CreatedAt is compared by its calendar day only"
  );
});

check("every ledger row list is below the day picker", () => {
  const view = src.indexOf("async function currentCashView(");
  ok(view >= 0, "the Current cash view exists");
  const start = src.indexOf("Content.replaceChildren(", view);
  ok(start >= 0, "the view renders its content");
  const block = src.slice(start, src.indexOf("\n}", start));
  const picker = block.indexOf("dateRow,");
  ok(picker >= 0, "the picker is rendered");
  for (const section of [
    "handoverSection",
    "transactionsSection",
    "expensesSection",
    "brokerCashSection",
    "cardInsurancesSection",
    "resetsSection",
  ]) {
    const at = block.indexOf(section);
    ok(at > picker, `${section} comes after the picker`);
  }
});

check("a tab change calls the view without a day", () => {
  const currentCashNav =
    src.match(/\{ key: "nav\.currentCash", load: currentCashView \}/g) || [];
  eq(currentCashNav.length, 2, "admin and worker both navigate to the view");
  ok(
    src.includes("runLoader(d.load)"),
    "the nav button runs the loader without arguments, so the remembered day is used"
  );
});

check("the end-of-shift reminder opens today", () => {
  const block = between(
    "window.__openCurrentCash = function",
    "runLoader(() => currentCashView());"
  );
  ok(
    block.includes("currentCashDate = null;"),
    "the remembered day is cleared before the reminder opens the tab"
  );
});

check("the saved-day view is still rebuilt for the picked day", () => {
  ok(
    src.includes(
      "currentCashView(name, date).catch((err) => toast(err.message, \"error\"))"
    ),
    "switching branch keeps the shown day"
  );
  ok(
    src.includes("currentCashView(branch, shiftDate);"),
    "the forgotten-shift fix shows the closed day"
  );
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
