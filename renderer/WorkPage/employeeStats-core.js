"use strict";

// Pure, DOM-free helpers for the admin's "Employee statistics" tab. Kept in a
// separate file so the exact same code runs in the dashboard (as a classic
// <script>, before WorkPage.js) and in a Node test harness (via vm). See
// test/client/employeeStatistics.test.cjs.
//
// The tab answers "how many insurances did every employee write during each
// shift of a period, day shift vs night shift, and what is the average". The
// figures themselves come from the server (GET /reports/shifts in
// Requests/Reports.js); what lives here is only the period arithmetic and the
// validation of the two hours, so the screen and the server cannot disagree
// about which days a period covers.
//
// A shift is NOT a fixed slice of the clock: it is a STREAK of one employee's
// insurances. A pause longer than EMPLOYEE_STATS_DEFAULT_GAP_MINUTES between two
// of them starts a new shift, so a shift ends at its LAST insurance - around
// 19:30 or 07:30, but never exactly, which is the whole point. The two nominal
// times below (day 07:30-19:30, night the rest) only decide whether a streak
// counts as day or night, and the server labels each streak by the majority of
// its policies. A night streak that starts before the day shift is dated the
// previous day, so 03:00 on the 22nd belongs to the night of the 21st.
//
// Dates are plain "YYYY-MM-DD" strings, stepped with UTC arithmetic so a
// daylight-saving change can never move the period by a day.

const EMPLOYEE_STATS_DEFAULT_DAY_START = "07:30";
const EMPLOYEE_STATS_DEFAULT_NIGHT_START = "19:30";
const EMPLOYEE_STATS_DEFAULT_DAYS = 7;
// Minutes of silence that END a shift: a pause longer than this between two
// insurances of the same worker starts a new shift, so the previous shift ended
// at its last insurance. Same default as the server (6 hours).
const EMPLOYEE_STATS_DEFAULT_GAP_MINUTES = 360;
const EMPLOYEE_STATS_MIN_GAP_MINUTES = 15;
const EMPLOYEE_STATS_MAX_GAP_MINUTES = 1440;

const EMPLOYEE_STATS_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

// Parse "YYYY-MM-DD" into { y, m, d } (month 1-12), or null when it is not a
// real calendar date. A string that parses is re-checked through Date.UTC, so
// "2026-02-31" is rejected instead of silently becoming 3 March.
function employeeStatsParseDate(value) {
  const text = String(value === undefined || value === null ? "" : value).trim();
  const m = EMPLOYEE_STATS_DATE_RE.exec(text);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const stamp = new Date(Date.UTC(y, mo - 1, d));
  if (
    stamp.getUTCFullYear() !== y ||
    stamp.getUTCMonth() !== mo - 1 ||
    stamp.getUTCDate() !== d
  ) {
    return null;
  }
  return { y, m: mo, d };
}

// "YYYY-MM-DD" stepped by a whole number of days (UTC, so no DST surprises).
function employeeStatsAddDays(dateString, days) {
  const parsed = employeeStatsParseDate(dateString);
  if (!parsed) return "";
  const stamp = new Date(
    Date.UTC(parsed.y, parsed.m - 1, parsed.d + Number(days || 0))
  );
  const p = (n) => String(n).padStart(2, "0");
  return (
    stamp.getUTCFullYear() +
    "-" +
    p(stamp.getUTCMonth() + 1) +
    "-" +
    p(stamp.getUTCDate())
  );
}

// Number of calendar days in the inclusive [from, to] range (0 when the range
// is invalid or reversed).
function employeeStatsDayCount(from, to) {
  const a = employeeStatsParseDate(from);
  const b = employeeStatsParseDate(to);
  if (!a || !b) return 0;
  const start = Date.UTC(a.y, a.m - 1, a.d);
  const end = Date.UTC(b.y, b.m - 1, b.d);
  const days = Math.round((end - start) / 86400000) + 1;
  return days > 0 ? days : 0;
}

// The period the tab opens on: the last EMPLOYEE_STATS_DEFAULT_DAYS COMPLETE
// days, i.e. ending yesterday. Today's shift is still open, so counting it
// would always show a half-finished day.
function employeeStatsDefaultPeriod(today, days) {
  const span = Math.max(1, Number(days) || EMPLOYEE_STATS_DEFAULT_DAYS);
  const to = employeeStatsAddDays(today, -1);
  const from = employeeStatsAddDays(to, -(span - 1));
  return { from, to };
}

// A named period, relative to the given local day:
//   "last7"     the last 7 complete days (the default)
//   "yesterday" yesterday only
//   "month"     the 1st of this month up to today (today included: the admin
//               may well be watching the shift that is running now)
function employeeStatsPeriodPreset(preset, today) {
  if (preset === "yesterday") {
    const day = employeeStatsAddDays(today, -1);
    return { from: day, to: day };
  }
  if (preset === "month") {
    const parsed = employeeStatsParseDate(today);
    if (!parsed) return { from: "", to: "" };
    const p = (n) => String(n).padStart(2, "0");
    return { from: `${parsed.y}-${p(parsed.m)}-01`, to: today };
  }
  return employeeStatsDefaultPeriod(today);
}

// Move a whole period by its own length (a single day moves one day). Used by
// the ‹ and › buttons, so stepping through periods feels the same whatever
// range is picked.
function employeeStatsShiftPeriod(from, to, direction) {
  const days = Math.max(1, employeeStatsDayCount(from, to));
  const step = (Number(direction) < 0 ? -1 : 1) * days;
  return {
    from: employeeStatsAddDays(from, step),
    to: employeeStatsAddDays(to, step),
  };
}

// "07:30" / "7:30" / "7" -> minutes of the day; null when it is not a time.
function employeeStatsParseTime(value) {
  const text = String(value === undefined || value === null ? "" : value).trim();
  const m = /^(\d{1,2})(?::(\d{2}))?$/.exec(text);
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = m[2] === undefined ? 0 : Number(m[2]);
  if (hour > 23 || minute > 59) return null;
  return hour * 60 + minute;
}

// Minutes of the day -> "07:30".
function employeeStatsTimeLabel(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

// The pause (in minutes) that ends a shift, or null when it is not usable.
function employeeStatsGapValue(raw) {
  const text = String(raw === undefined || raw === null ? "" : raw).trim();
  if (!/^\d{1,4}$/.test(text)) return null;
  const value = Number(text);
  if (value < EMPLOYEE_STATS_MIN_GAP_MINUTES) return null;
  if (value > EMPLOYEE_STATS_MAX_GAP_MINUTES) return null;
  return value;
}

// Validate the shift settings as they are typed: the two times that label a
// streak day or night, and the pause that ends a shift. Returns the normalised
// values, or an i18n KEY describing what is wrong (the caller translates it).
// The inputs are text, so a blank field is an error too - Number("") would
// otherwise quietly mean "midnight".
function employeeStatsResolveWindow(dayStart, nightStart, gap) {
  const start = employeeStatsParseTime(dayStart);
  const end = employeeStatsParseTime(nightStart);
  if (start === null) return { errorKey: "employeeStats.badDayHour" };
  if (end === null) return { errorKey: "employeeStats.badNightHour" };
  if (end === start) return { errorKey: "employeeStats.sameHours" };
  if (end < start) return { errorKey: "employeeStats.hourOrder" };
  const gapMinutes = employeeStatsGapValue(
    gap === undefined || gap === null ? EMPLOYEE_STATS_DEFAULT_GAP_MINUTES : gap
  );
  if (gapMinutes === null) return { errorKey: "employeeStats.badGap" };
  return {
    dayStart: employeeStatsTimeLabel(start),
    nightStart: employeeStatsTimeLabel(end),
    dayStartMinutes: start,
    nightStartMinutes: end,
    gapMinutes,
  };
}

// "07:30-19:30" - the nominal window, as a fallback for the server's own text.
function employeeStatsWindow(start, end) {
  const a = employeeStatsParseTime(start);
  const b = employeeStatsParseTime(end);
  if (a === null || b === null) {
    return `${String(start === undefined ? "" : start)}-${String(
      end === undefined ? "" : end
    )}`;
  }
  return `${employeeStatsTimeLabel(a)}-${employeeStatsTimeLabel(b)}`;
}

// The detected span of one shift, from the row's startedAt / endedAt
// ("YYYY-MM-DD HH:MM"): "07:41-19:18", or "19:41-07:12 +1" when it runs past
// midnight.
function employeeStatsShiftSpan(startedAt, endedAt) {
  const start = String(startedAt === undefined || startedAt === null ? "" : startedAt);
  const end = String(endedAt === undefined || endedAt === null ? "" : endedAt);
  if (start.length < 16 || end.length < 16) return "";
  const nextDay = end.slice(0, 10) !== start.slice(0, 10);
  return `${start.slice(11, 16)}-${end.slice(11, 16)}${nextDay ? " +1" : ""}`;
}

// Query string for GET /reports/shifts, from the tab's state
// ({ from, to, dayStart, nightStart, gap }).
function employeeStatsQuery(state) {
  const s = state || {};
  return (
    `from=${encodeURIComponent(s.from || "")}` +
    `&to=${encodeURIComponent(s.to || "")}` +
    `&dayStart=${encodeURIComponent(String(s.dayStart))}` +
    `&nightStart=${encodeURIComponent(String(s.nightStart))}` +
    `&gap=${encodeURIComponent(String(s.gap))}`
  );
}

// An average as it is shown: two decimals, never "NaN".
function employeeStatsAverage(value) {
  const n = Number(value);
  return (Number.isFinite(n) ? n : 0).toFixed(2);
}

