"use strict";

// Node test for the end-of-shift reminder timing and the admin's
// "forgotten shift" timestamp helpers (renderer/shiftReminder.js).
//
// The reminder fires at 23:55 local time and the admin may close a forgotten
// shift with an arbitrary (past) date + time, which the server stores as the
// reset's CreatedAt.
//
// Runs the REAL renderer file in a vm.
//
// Run with:  node Test/shiftReminder.test.cjs   (or: npm test)

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const CTX = { console, Date, Number, String, Math };
vm.createContext(CTX);
vm.runInContext(
  fs.readFileSync(path.join(__dirname, "..", "renderer", "shiftReminder.js"), "utf8") +
    // Top-level `const`s are lexical bindings in a vm context. Function
    // declarations become globals automatically; the constant is exported
    // explicitly so the test can read it.
    "\nthis.__leadMinutes = SHIFT_REMINDER_MINUTES_BEFORE_MIDNIGHT;",
  CTX,
  { filename: "shiftReminder.js" }
);
const {
  __leadMinutes: SHIFT_REMINDER_MINUTES_BEFORE_MIDNIGHT,
  shiftMsUntilMidnight,
  shiftReminderWindowOpen,
  shiftMsUntilReminder,
  shiftMsUntilNextReminder,
  shiftReminderDayKey,
  shiftReminderSecondsLeft,
  formatShiftCountdown,
  shiftEndOfDayTimestamp,
  shiftCashSplit,
  shiftCloseTimestamp,
  shiftCloseIsFuture,
} = CTX;

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
function ok(condition, label) {
  if (!condition) throw new Error(label);
}

const MIN = 60 * 1000;
const at = (h, m, s = 0) => new Date(2026, 10, 14, h, m, s, 0); // local time

console.log("shift reminder: five minutes before local midnight");

check("lead time is five minutes", () => {
  eq(SHIFT_REMINDER_MINUTES_BEFORE_MIDNIGHT, 5, "minutes");
});

check("ms until midnight", () => {
  eq(shiftMsUntilMidnight(at(23, 55)), 5 * MIN, "23:55");
  eq(shiftMsUntilMidnight(at(0, 0)), 24 * 60 * MIN, "00:00");
  eq(shiftMsUntilMidnight(at(12, 0)), 12 * 60 * MIN, "12:00");
});

check("the reminder window is 23:55-23:59:59 only", () => {
  eq(shiftReminderWindowOpen(at(23, 54, 59)), false, "just before");
  eq(shiftReminderWindowOpen(at(23, 55)), true, "at 23:55");
  eq(shiftReminderWindowOpen(at(23, 59, 59)), true, "last second");
  eq(shiftReminderWindowOpen(at(0, 0)), false, "midnight closes it");
  eq(shiftReminderWindowOpen(at(12, 0)), false, "midday");
});

check("ms until the reminder", () => {
  eq(shiftMsUntilReminder(at(22, 0)), 1 * 60 * MIN + 55 * MIN, "22:00");
  eq(shiftMsUntilReminder(at(23, 55)), 0, "inside the window");
  eq(shiftMsUntilReminder(at(23, 58)), 0, "later in the window");
  // Just after midnight the next reminder is today's 23:55, not last night's.
  eq(shiftMsUntilReminder(at(0, 1)), 23 * 60 * MIN + 54 * MIN, "00:01");
});

check("re-arming always targets a future 23:55 (never 0)", () => {
  eq(shiftMsUntilNextReminder(at(22, 0)), 1 * 60 * MIN + 55 * MIN, "22:00");
  eq(shiftMsUntilNextReminder(at(23, 55)), 24 * 60 * MIN, "at 23:55");
  eq(shiftMsUntilNextReminder(at(23, 58)), 23 * 60 * MIN + 57 * MIN, "23:58");
  eq(shiftMsUntilNextReminder(at(0, 1)), 23 * 60 * MIN + 54 * MIN, "00:01");
  ok(shiftMsUntilNextReminder(at(23, 55)) > 0, "no immediate re-fire");
});

check("countdown seconds and formatting", () => {
  eq(shiftReminderSecondsLeft(at(23, 55)), 300, "5 minutes");
  eq(shiftReminderSecondsLeft(at(23, 59, 1)), 59, "59 seconds");
  eq(shiftReminderSecondsLeft(at(23, 50)), 0, "outside the window");
  eq(shiftReminderSecondsLeft(at(0, 0, 1)), 0, "after midnight");

  eq(formatShiftCountdown(300), "5:00", "five minutes");
  eq(formatShiftCountdown(59), "0:59", "one minute");
  eq(formatShiftCountdown(0), "0:00", "zero");
  eq(formatShiftCountdown(-5), "0:00", "negative");
  eq(formatShiftCountdown(undefined), "0:00", "undefined");
});

check("day key is the local calendar day", () => {
  eq(shiftReminderDayKey(at(23, 58)), "2026-11-14", "late evening");
  eq(shiftReminderDayKey(new Date(2026, 0, 1, 0, 30)), "2026-01-01", "new year");
});

console.log("\nforgotten shift: midnight timestamps");

check("date + time become a MySQL DATETIME", () => {
  eq(
    shiftCloseTimestamp("2026-11-13", "23:59"),
    "2026-11-13 23:59:00",
    "date and time"
  );
  eq(
    shiftCloseTimestamp("2026-11-13", "7:05"),
    "2026-11-13 07:05:00",
    "single-digit hour is padded"
  );
  eq(
    shiftCloseTimestamp("2026-11-13", "23:59:30"),
    "2026-11-13 23:59:30",
    "seconds kept"
  );
});

check("invalid date or time is rejected", () => {
  eq(shiftCloseTimestamp("", "23:59"), null, "missing date");
  eq(shiftCloseTimestamp("2026-11-13", ""), null, "missing time");
  eq(shiftCloseTimestamp("13.11.2026", "23:59"), null, "wrong date format");
  eq(shiftCloseTimestamp("2026-02-31", "23:59"), null, "impossible day");
  eq(shiftCloseTimestamp("2026-11-13", "24:00"), null, "hour out of range");
  eq(shiftCloseTimestamp("2026-11-13", "23:60"), null, "minute out of range");
  eq(shiftCloseTimestamp("2026-11-13", "23:59:60"), null, "second out of range");
});

check("a future shift end is refused", () => {
  const now = at(10, 0);
  eq(shiftCloseIsFuture("2026-11-13 23:59:00", now), false, "yesterday");
  eq(shiftCloseIsFuture("2026-11-14 09:59:00", now), false, "earlier today");
  eq(shiftCloseIsFuture("2026-11-14 10:01:00", now), true, "later today");
  eq(shiftCloseIsFuture("2026-11-15 00:00:00", now), true, "tomorrow");
  eq(shiftCloseIsFuture("not a date", now), false, "unparseable");
});

check("the shift closes at the last second of the selected day", () => {
  eq(
    shiftEndOfDayTimestamp("2026-11-13"),
    "2026-11-13 23:59:59",
    "13th ends at midnight"
  );
  eq(
    shiftEndOfDayTimestamp("2026-12-31"),
    "2026-12-31 23:59:59",
    "year end stays on the 31st"
  );
  eq(shiftEndOfDayTimestamp("2026-02-31"), null, "impossible date");
  eq(shiftEndOfDayTimestamp(""), null, "missing date");
});

console.log("\nforgotten shift: drawer split at midnight");

check("the drawer is split into the closed shift and today's cash", () => {
  eq(shiftCashSplit(150, 100), {
    ok: true,
    live: 150,
    kept: 100,
    today: 50,
  }, "150 now, 100 at midnight -> 50 stays today");
  eq(shiftCashSplit(100, 100), {
    ok: true,
    live: 100,
    kept: 100,
    today: 0,
  }, "nothing recorded after midnight");
  eq(shiftCashSplit("250.50", "100.25"), {
    ok: true,
    live: 250.5,
    kept: 100.25,
    today: 150.25,
  }, "decimals are preserved");
});

check("a drawer below the midnight balance is not split", () => {
  const split = shiftCashSplit(90, 100);
  eq(split.ok, false, "not splittable");
  eq(split.kept, 100, "midnight amount");
  eq(split.today, -10, "negative today");
});

check("missing or negative values do not break the split", () => {
  eq(shiftCashSplit(undefined, 100), {
    ok: false,
    live: 0,
    kept: 100,
    today: -100,
  }, "no live balance");
  eq(shiftCashSplit(50, -10), {
    ok: true,
    live: 50,
    kept: 0,
    today: 50,
  }, "negative midnight balance is treated as zero");
});

if (failed) process.exit(1);
console.log(`shiftReminder: ${passed} passed, ${failed} failed`);
