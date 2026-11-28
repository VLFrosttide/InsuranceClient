"use strict";

// Node test for the admin's "Employee statistics" tab helpers
// (renderer/WorkPage/employeeStats-core.js): the period arithmetic, the shift
// window validation and the query the tab sends to GET /reports/shifts.
//
// The report figures themselves are computed by the server
// (Requests/Reports.js) and covered by the server's end-to-end suite; what is
// checked here is everything the PC decides on its own, so the screen and the
// server cannot disagree about which days a period covers or which hour starts
// the night shift.
//
// Run with:  node test/client/employeeStatistics.test.cjs   (or: npm test)

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..", "..");
const WORKPAGE = path.join(ROOT, "renderer", "WorkPage");

const CTX = { console };
vm.createContext(CTX);
vm.runInContext(
  fs.readFileSync(path.join(WORKPAGE, "employeeStats-core.js"), "utf8"),
  CTX,
  { filename: "employeeStats-core.js" }
);

const {
  employeeStatsParseDate,
  employeeStatsAddDays,
  employeeStatsDayCount,
  employeeStatsDefaultPeriod,
  employeeStatsPeriodPreset,
  employeeStatsShiftPeriod,
  employeeStatsParseTime,
  employeeStatsTimeLabel,
  employeeStatsResolveWindow,
  employeeStatsWindow,
  employeeStatsShiftSpan,
  employeeStatsQuery,
  employeeStatsAverage,
} = CTX;

// The defaults and limits are `const` in the core file, so they are lexical
// bindings of the vm script rather than properties of the context object.
const EMPLOYEE_STATS_DEFAULT_DAY_START = vm.runInContext(
  "EMPLOYEE_STATS_DEFAULT_DAY_START",
  CTX
);
const EMPLOYEE_STATS_DEFAULT_NIGHT_START = vm.runInContext(
  "EMPLOYEE_STATS_DEFAULT_NIGHT_START",
  CTX
);
const EMPLOYEE_STATS_DEFAULT_GAP_MINUTES = vm.runInContext(
  "EMPLOYEE_STATS_DEFAULT_GAP_MINUTES",
  CTX
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

console.log("Employee statistics (shift report helpers)");

check("defaults are the 07:30-19:30 window, a shift ending after 360 min", () => {
  eq(EMPLOYEE_STATS_DEFAULT_DAY_START, "07:30");
  eq(EMPLOYEE_STATS_DEFAULT_NIGHT_START, "19:30");
  eq(EMPLOYEE_STATS_DEFAULT_GAP_MINUTES, 360);
  eq(employeeStatsWindow("07:30", "19:30"), "07:30-19:30");
  eq(employeeStatsWindow("19:30", "07:30"), "19:30-07:30");
  eq(employeeStatsWindow("06:30", "18:30"), "06:30-18:30");
});

check("times are read as HH:MM, half hours included", () => {
  eq(employeeStatsParseTime("07:30"), 450);
  eq(employeeStatsParseTime("19:30"), 1170);
  eq(employeeStatsParseTime("7:30"), 450);
  eq(employeeStatsParseTime("7"), 420);
  eq(employeeStatsParseTime("00:00"), 0);
  eq(employeeStatsParseTime("23:59"), 1439);
  eq(employeeStatsParseTime("24:00"), null, "hour 24");
  eq(employeeStatsParseTime("07:60"), null, "minute 60");
  eq(employeeStatsParseTime("07:3"), null, "one-digit minute");
  eq(employeeStatsParseTime(""), null);
  eq(employeeStatsParseTime(null), null);
  eq(employeeStatsTimeLabel(450), "07:30");
  eq(employeeStatsTimeLabel(0), "00:00");
  eq(employeeStatsTimeLabel(1170), "19:30");
});

check("parseDate accepts real dates and rejects impossible ones", () => {
  eq(employeeStatsParseDate("2026-11-28"), { y: 2026, m: 11, d: 28 });
  eq(employeeStatsParseDate(" 2026-01-01 "), { y: 2026, m: 1, d: 1 });
  eq(employeeStatsParseDate("2026-02-31"), null, "31 February");
  eq(employeeStatsParseDate("2026-13-01"), null, "month 13");
  eq(employeeStatsParseDate("28-11-2026"), null, "day first");
  eq(employeeStatsParseDate(""), null);
  eq(employeeStatsParseDate(null), null);
});

check("addDays crosses months, years and leap days", () => {
  eq(employeeStatsAddDays("2026-11-28", 1), "2026-11-29");
  eq(employeeStatsAddDays("2026-11-30", 1), "2026-12-01");
  eq(employeeStatsAddDays("2026-12-31", 1), "2027-01-01");
  eq(employeeStatsAddDays("2028-02-28", 1), "2028-02-29", "leap year");
  eq(employeeStatsAddDays("2026-01-01", -1), "2025-12-31");
  eq(employeeStatsAddDays("2026-11-28", 0), "2026-11-28");
  eq(employeeStatsAddDays("nope", 1), "", "invalid input");
});

check("dayCount counts both ends of the range", () => {
  eq(employeeStatsDayCount("2026-11-21", "2026-11-21"), 1);
  eq(employeeStatsDayCount("2026-11-21", "2026-11-27"), 7);
  eq(employeeStatsDayCount("2026-11-21", "2026-12-21"), 31);
  eq(employeeStatsDayCount("2026-11-27", "2026-11-21"), 0, "reversed");
  eq(employeeStatsDayCount("", ""), 0);
});

check("the tab opens on the last 7 complete days (yesterday included)", () => {
  eq(employeeStatsDefaultPeriod("2026-11-28"), {
    from: "2026-11-21",
    to: "2026-11-27",
  });
  eq(employeeStatsDefaultPeriod("2026-12-01"), {
    from: "2026-11-24",
    to: "2026-11-30",
  });
  eq(employeeStatsDefaultPeriod("2026-11-28", 14), {
    from: "2026-11-14",
    to: "2026-11-27",
  });
});

check("presets: yesterday, this month, last 7 days", () => {
  eq(employeeStatsPeriodPreset("yesterday", "2026-11-28"), {
    from: "2026-11-27",
    to: "2026-11-27",
  });
  eq(employeeStatsPeriodPreset("month", "2026-11-28"), {
    from: "2026-11-01",
    to: "2026-11-28",
  });
  eq(employeeStatsPeriodPreset("last7", "2026-11-28"), {
    from: "2026-11-21",
    to: "2026-11-27",
  });
  eq(employeeStatsPeriodPreset("something-else", "2026-11-28"), {
    from: "2026-11-21",
    to: "2026-11-27",
  });
});

check("stepping moves the whole period by its own length", () => {
  eq(employeeStatsShiftPeriod("2026-11-21", "2026-11-27", -1), {
    from: "2026-11-14",
    to: "2026-11-20",
  });
  eq(employeeStatsShiftPeriod("2026-11-21", "2026-11-27", 1), {
    from: "2026-11-28",
    to: "2026-12-04",
  });
  eq(employeeStatsShiftPeriod("2026-11-27", "2026-11-27", -1), {
    from: "2026-11-26",
    to: "2026-11-26",
  });
  eq(employeeStatsShiftPeriod("2026-11-01", "2026-11-30", 1), {
    from: "2026-12-01",
    to: "2026-12-30",
  });
});

check("the shift window is validated before anything is reloaded", () => {
  eq(employeeStatsResolveWindow("07:30", "19:30", 360), {
    dayStart: "07:30",
    nightStart: "19:30",
    dayStartMinutes: 450,
    nightStartMinutes: 1170,
    gapMinutes: 360,
  });
  eq(employeeStatsResolveWindow("7:30", "19:30", "120"), {
    dayStart: "07:30",
    nightStart: "19:30",
    dayStartMinutes: 450,
    nightStartMinutes: 1170,
    gapMinutes: 120,
  });
  // An emptied pause field is refused rather than silently read as the default.
  eq(employeeStatsResolveWindow("07:30", "19:30", ""), {
    errorKey: "employeeStats.badGap",
  });
  eq(employeeStatsResolveWindow("06:30", "18:30"), {
    dayStart: "06:30",
    nightStart: "18:30",
    dayStartMinutes: 390,
    nightStartMinutes: 1110,
    gapMinutes: 360,
  });
  eq(employeeStatsResolveWindow("", "19:30", 360), {
    errorKey: "employeeStats.badDayHour",
  });
  eq(employeeStatsResolveWindow("25:00", "19:30", 360), {
    errorKey: "employeeStats.badDayHour",
  });
  eq(employeeStatsResolveWindow("07:30", "x", 360), {
    errorKey: "employeeStats.badNightHour",
  });
  eq(employeeStatsResolveWindow("19:30", "19:30", 360), {
    errorKey: "employeeStats.sameHours",
  });
  eq(employeeStatsResolveWindow("19:30", "07:30", 360), {
    errorKey: "employeeStats.hourOrder",
  });
  eq(employeeStatsResolveWindow("07:30", "19:30", 5), {
    errorKey: "employeeStats.badGap",
  });
  eq(employeeStatsResolveWindow("07:30", "19:30", 1441), {
    errorKey: "employeeStats.badGap",
  });
  eq(employeeStatsResolveWindow("07:30", "19:30", "soon"), {
    errorKey: "employeeStats.badGap",
  });
});

check("a shift span is read from its first and last insurance", () => {
  eq(
    employeeStatsShiftSpan("2026-11-26 07:41:12", "2026-11-26 19:18:03"),
    "07:41-19:18"
  );
  eq(
    employeeStatsShiftSpan("2026-11-26 19:45:00", "2026-11-27 07:34:00"),
    "19:45-07:34 +1",
    "past midnight"
  );
  eq(employeeStatsShiftSpan("2026-11-26 07:41", "2026-11-26 19:18"), "07:41-19:18");
  eq(employeeStatsShiftSpan("", ""), "");
  eq(employeeStatsShiftSpan("2026-11-26 07:41:12", ""), "");
});

check("the report query carries the period, the times and the pause", () => {
  eq(
    employeeStatsQuery({
      from: "2026-11-21",
      to: "2026-11-27",
      dayStart: "07:30",
      nightStart: "19:30",
      gap: 360,
    }),
    "from=2026-11-21&to=2026-11-27&dayStart=07%3A30&nightStart=19%3A30&gap=360"
  );
  eq(
    employeeStatsQuery({
      from: "2026-01-01",
      to: "2026-01-02",
      dayStart: "06:30",
      nightStart: "18:30",
      gap: 120,
    }),
    "from=2026-01-01&to=2026-01-02&dayStart=06%3A30&nightStart=18%3A30&gap=120"
  );
});

check("averages always print two decimals", () => {
  eq(employeeStatsAverage(67.5), "67.50");
  eq(employeeStatsAverage(0), "0.00");
  eq(employeeStatsAverage("26.785"), "26.79");
  eq(employeeStatsAverage(null), "0.00");
  eq(employeeStatsAverage(undefined), "0.00");
  eq(employeeStatsAverage("nope"), "0.00");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed === 0 ? 0 : 1;

