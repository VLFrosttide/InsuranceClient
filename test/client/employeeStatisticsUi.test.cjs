"use strict";

// UI test for the admin's "Employee statistics" tab
// (renderer/WorkPage/WorkPage.js + employeeStats-core.js + common.js +
// WorkPage.html + WorkPage.css).
//
// The numbers themselves are the server's (GET /reports/shifts) and are tested
// there; here the wiring is checked: the tab exists for admins only, it asks the
// right endpoint, it keeps the day and the night shift apart, it shows the
// averages for each, and every label it prints has a translation in both
// languages.
//
// Run with:  node test/client/employeeStatisticsUi.test.cjs   (or: npm test)

const fs = require("fs");
const path = require("path");

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

const ROOT = path.join(__dirname, "..", "..");
const WORKPAGE_DIR = path.join(ROOT, "renderer", "WorkPage");
const WORKPAGE = fs.readFileSync(path.join(WORKPAGE_DIR, "WorkPage.js"), "utf8");
const CORE = fs.readFileSync(path.join(WORKPAGE_DIR, "employeeStats-core.js"), "utf8");
const HTML = fs.readFileSync(path.join(WORKPAGE_DIR, "WorkPage.html"), "utf8");
const CSS = fs.readFileSync(path.join(WORKPAGE_DIR, "WorkPage.css"), "utf8");
const COMMON = fs.readFileSync(path.join(ROOT, "renderer", "common.js"), "utf8");

// Whitespace-insensitive copies for regexes that span lines (the files are CRLF).
const flat = WORKPAGE.replace(/\s+/g, " ");
const flatCore = CORE.replace(/\s+/g, " ");

// The two language blocks of the I18N dictionary.
const enStart = COMMON.indexOf("  en: {");
const bgStart = COMMON.indexOf("  bg: {");
const dictEnd = COMMON.indexOf("\n};", bgStart);
const EN = COMMON.slice(enStart, bgStart);
const BG = COMMON.slice(bgStart, dictEnd);

console.log("Employee statistics tab");

check("only the admin navigation has the tab", () => {
  const defs = WORKPAGE.slice(WORKPAGE.indexOf("const NAV_DEFS = {"));
  const role1 = defs.slice(0, defs.indexOf("  2: ["));
  const role2 = defs.slice(defs.indexOf("  2: ["), defs.indexOf("  3: ["));
  const role3 = defs.slice(defs.indexOf("  3: ["));
  ok(
    role1.includes(
      '{ key: "nav.employeeStatistics", load: employeeStatisticsView }'
    ),
    "the admin tab is registered"
  );
  ok(!role2.includes("employeeStatistics"), "workers do not see it");
  ok(!role3.includes("employeeStatistics"), "clients do not see it");
});

check("the tab reads GET /reports/shifts with the picked period", () => {
  ok(
    flat.includes("await api(`/reports/shifts?${employeeStatsQuery(state)}`)"),
    "the report endpoint is called"
  );
  ok(flat.includes("function employeeStatisticsView()"), "the view exists");
  ok(
    flat.includes("employeeStatsPeriodPreset(preset, localDateString())"),
    "the presets are resolved against today"
  );
  ok(
    flat.includes("employeeStatsShiftPeriod("),
    "the step buttons move the period"
  );
  ok(
    flat.includes("employeeStatsResolveWindow("),
    "the shift settings are validated before a request"
  );
});

check("the day shift and the night shift are shown apart", () => {
  ok(flat.includes('t("employeeStats.dayShift")'), "day shift heading");
  ok(flat.includes('t("employeeStats.nightShift")'), "night shift heading");
  ok(flat.includes('t("employeeStats.bothShifts")'), "combined heading");
  ok(
    flat.includes('fmt(t("employeeStats.dayShift"), { window: dayWindow })'),
    "the day window is printed"
  );
  ok(
    flat.includes('fmt(t("employeeStats.nightShift"), { window: nightWindow })'),
    "the night window is printed"
  );
  ok(
    flat.includes(".filter((row) => row.shift === shift)"),
    "each table is filtered to its own shift"
  );
});

check("the averages are shown for each shift, each employee and each day", () => {
  for (const key of [
    "employeeStats.policies",
    "employeeStats.employees",
    "employeeStats.shifts",
    "employeeStats.avgPerShift",
    "employeeStats.avgPerWorker",
    "employeeStats.avgPerDay",
    "employeeStats.avgPerWorkerDay",
  ]) {
    ok(flat.includes(`t("${key}")`), key + " is used");
  }
  ok(flat.includes('t("employeeStats.perEmployee")'), "per-employee table");
  ok(flat.includes('t("employeeStats.perDay")'), "per-day table");
  ok(
    flat.includes('t("employeeStats.avgShiftColumn")') &&
      flat.includes('t("employeeStats.avgDayColumn")'),
    "the per-employee table has its average columns"
  );
  ok(flat.includes('t("employeeStats.empty")'), "an empty period says so");
});

check("the tables keep their sort order across a rebuild", () => {
  ok(flat.includes("const employeeStatsSort = {"), "sort state outside the render");
  ok(
    flat.includes("sort: employeeStatsSort.rows") &&
      flat.includes("sort: employeeStatsSort.employees") &&
      flat.includes("sort: employeeStatsSort.days"),
    "each table has its own sort state"
  );
});

check("every label has an English and a Bulgarian translation", () => {
  const keys = new Set();
  const re = /employeeStats\.[A-Za-z0-9]+/g;
  for (const text of [WORKPAGE, CORE]) {
    let m;
    while ((m = re.exec(text))) keys.add(m[0]);
  }
  keys.add("nav.employeeStatistics");
  ok(keys.size > 20, "the tab uses its own keys");
  for (const key of keys) {
    ok(EN.includes(`"${key}":`), `missing English translation for ${key}`);
    ok(BG.includes(`"${key}":`), `missing Bulgarian translation for ${key}`);
  }
});

check("the core helpers are loaded before the dashboard", () => {
  const coreTag = HTML.indexOf('src="employeeStats-core.js"');
  const pageTag = HTML.indexOf('src="WorkPage.js"');
  ok(coreTag !== -1, "the core script is included");
  ok(pageTag !== -1 && coreTag < pageTag, "the core script comes first");
});

check("the report has its own section spacing and reuses the panel styles", () => {
  ok(CSS.includes(".employee-report h3"), "the section headings are spaced");
  ok(flat.includes('el("div", null, { class: "employee-report" })'), "the host");
  ok(flat.includes('class: "stat-grid"'), "the average cards use the shared grid");
  ok(
    flat.includes('class: "profit-heading-row"') &&
      flat.includes('class: "profit-date-nav"'),
    "the controls reuse the Profits layout"
  );
});

check("the shift window is configurable and refused when impossible", () => {
  ok(flat.includes('t("employeeStats.shiftHours")'), "the hours card");
  ok(flat.includes('t("employeeStats.dayStart")'), "the day start field");
  ok(flat.includes('t("employeeStats.nightStart")'), "the night start field");
  ok(flat.includes('t("employeeStats.gap")'), "the pause that ends a shift");
  ok(
    flat.includes('input("time", state.dayStart)') &&
      flat.includes('input("time", state.nightStart)'),
    "the two times are time fields"
  );
  ok(
    flatCore.includes('errorKey: "employeeStats.hourOrder"'),
    "an impossible window has its own error"
  );
  ok(
    flatCore.includes('errorKey: "employeeStats.badGap"'),
    "an impossible pause has its own error"
  );
  ok(
    flat.includes("t(window.errorKey)"),
    "the error is translated before it is shown"
  );
});

// ---------------------------------------------------------------------------
// The report body itself, run for real: the two render functions are executed
// against a tiny DOM stub, so a typo or a wrong field is caught here instead of
// in the app.
// ---------------------------------------------------------------------------
console.log("\nEmployee statistics report body");

const vm = require("vm");
const renderContext = () => {
  const ctx = { console };
  vm.createContext(ctx);
  vm.runInContext(CORE, ctx, { filename: "employeeStats-core.js" });
  const start = WORKPAGE.indexOf("const employeeStatsSort = {");
  const end = WORKPAGE.indexOf("\n// Navigation setup");
  ok(start > 0 && end > start, "the report section is found");
  vm.runInContext(WORKPAGE.slice(start, end), ctx, {
    filename: "WorkPage-employee-stats.js",
  });
  // The DOM/formatting helpers the two render functions use.
  vm.runInContext(
    `
    function el(tag, text, attrs) {
      const node = { tag, text: text === undefined || text === null ? "" : String(text), attrs: attrs || {}, children: [] };
      node.appendChild = (child) => { node.children.push(child); return child; };
      node.replaceChildren = (...kids) => { node.children = kids; };
      return node;
    }
    function t(key) {
      // The two shift headings carry the window, exactly like the translations.
      return key +
        (key === "employeeStats.dayShift" || key === "employeeStats.nightShift"
          ? " ({window})"
          : "");
    }
    function fmt(text, vars) {
      return String(text).replace(/\\{(\\w+)\\}/g, (m, k) =>
        vars && vars[k] !== undefined ? String(vars[k]) : m
      );
    }
    function formatDateOnly(value) { return String(value); }
    function sortableTable(items, columns, actions, rowClass, onRowClick, options) {
      return { tag: "table", items, columns, options };
    }
    `,
    ctx,
    { filename: "stubs.js" }
  );
  return ctx;
};

const renderText = (node) =>
  [node.text, ...(node.children || []).map(renderText)].join(" ");
const collect = (node, tag, out = []) => {
  if (node && node.tag === tag) out.push(node);
  for (const child of (node && node.children) || []) collect(child, tag, out);
  return out;
};



const bucket = (policies, workers, shifts, avgShift, avgWorker, avgDay, avgWorkerDay) => ({
  policies,
  workers,
  shifts,
  activeDays: policies ? 1 : 0,
  avgPoliciesPerShift: avgShift,
  avgPoliciesPerWorker: avgWorker,
  avgPoliciesPerDay: avgDay,
  avgPoliciesPerWorkerDay: avgWorkerDay,
});

const SAMPLE_REPORT = {
  from: "2026-11-21",
  to: "2026-11-27",
  days: 7,
  schedule: {
    day: { start: "07:30", end: "19:30", window: "07:30-19:30" },
    night: { start: "19:30", end: "07:30", window: "19:30-07:30" },
    maxGapMinutes: 360,
  },
  summary: {
    day: bucket(9, 2, 2, 4.5, 4.5, 1.29, 0.64),
    night: bucket(3, 1, 1, 3, 3, 0.43, 0.43),
    overall: bucket(12, 2, 3, 4, 6, 1.71, 0.86),
  },
  workers: [
    {
      worker: "worker",
      role: 2,
      day: { policies: 6, shifts: 1, activeDays: 1, avgPoliciesPerShift: 6, avgPoliciesPerDay: 0.86 },
      night: { policies: 3, shifts: 1, activeDays: 1, avgPoliciesPerShift: 3, avgPoliciesPerDay: 0.43 },
      total: { policies: 9, shifts: 2, activeDays: 2, avgPoliciesPerShift: 4.5, avgPoliciesPerDay: 1.29 },
    },
    {
      worker: "admin",
      role: 1,
      day: { policies: 3, shifts: 1, activeDays: 1, avgPoliciesPerShift: 3, avgPoliciesPerDay: 0.43 },
      night: { policies: 0, shifts: 0, activeDays: 0, avgPoliciesPerShift: 0, avgPoliciesPerDay: 0 },
      total: { policies: 3, shifts: 1, activeDays: 1, avgPoliciesPerShift: 3, avgPoliciesPerDay: 0.43 },
    },
  ],
  perDay: [
    { date: "2026-11-21", day: 0, night: 0, total: 0 },
    { date: "2026-11-26", day: 9, night: 3, total: 12 },
  ],
  rows: [
    {
      date: "2026-11-26",
      shift: "day",
      worker: "worker",
      role: 2,
      policies: 6,
      startedAt: "2026-11-26 07:41",
      endedAt: "2026-11-26 19:18",
    },
    {
      date: "2026-11-26",
      shift: "day",
      worker: "admin",
      role: 1,
      policies: 3,
      startedAt: "2026-11-26 08:05",
      endedAt: "2026-11-26 19:26",
    },
    {
      date: "2026-11-26",
      shift: "night",
      worker: "worker",
      role: 2,
      policies: 3,
      startedAt: "2026-11-26 19:45",
      endedAt: "2026-11-27 07:34",
    },
  ],
};

const bodyNodes = (ctx, report) =>
  vm.runInContext(
    "employeeStatisticsNodes(__report, __state)",
    Object.assign(ctx, {
      __report: report,
      __state: { from: "2026-11-21", to: "2026-11-27", dayStart: "07:30", nightStart: "19:30", gap: 360 },
    })
  );

check("the body renders every section with the server's figures", () => {
  const nodes = bodyNodes(renderContext(), SAMPLE_REPORT);
  const host = { tag: "div", text: "", attrs: {}, children: nodes };
  const text = renderText(host);
  for (const key of [
    "employeeStats.dayShift",
    "employeeStats.nightShift",
    "employeeStats.bothShifts",
    "employeeStats.perEmployee",
    "employeeStats.perDay",
    "employeeStats.footnote",
  ]) {
    ok(text.includes(key), key + " is rendered");
  }
  ok(
    text.includes("07:30-19:30") && text.includes("19:30-07:30"),
    "both shift windows are printed"
  );
  ok(text.includes("4.50"), "the per-shift average is formatted");
  ok(text.includes("0.86"), "the per-employee-day average is formatted");
  const tables = collect(host, "table");
  eq(tables.length, 4, "day, night, per employee and per day");
  eq(tables[0].items.length, 2, "the day table holds the day rows");
  eq(tables[1].items.length, 1, "the night table holds the night rows");
  eq(tables[1].items[0].shift, "night", "and only night rows");
  ok(
    tables[0].columns.some((c) => c.key === "span"),
    "the per-shift table shows the detected shift"
  );
  eq(
    tables[0].columns
      .find((c) => c.key === "span")
      .format(null, tables[0].items[0]),
    "07:41-19:18",
    "from the first to the last insurance"
  );
  eq(
    tables[1].columns
      .find((c) => c.key === "span")
      .format(null, tables[1].items[0]),
    "19:45-07:34 +1",
    "a night shift that runs past midnight"
  );
  eq(tables[2].items.length, 2, "the per-employee table");
  eq(tables[3].items.length, 2, "the per-day table");
  ok(
    tables[2].columns.some((c) => c.key === "avgShift") &&
      tables[2].columns.some((c) => c.key === "avgDay"),
    "the per-employee table keeps its average columns"
  );
});

check("a quiet period says so instead of printing empty tables", () => {
  const empty = {
    ...SAMPLE_REPORT,
    summary: {
      day: bucket(0, 0, 0, 0, 0, 0, 0),
      night: bucket(0, 0, 0, 0, 0, 0, 0),
      overall: bucket(0, 0, 0, 0, 0, 0, 0),
    },
    workers: [],
    rows: [],
    perDay: [{ date: "2026-11-21", day: 0, night: 0, total: 0 }],
  };
  const host = { tag: "div", text: "", attrs: {}, children: bodyNodes(renderContext(), empty) };
  ok(renderText(host).includes("employeeStats.empty"), "the empty message is shown");
  eq(collect(host, "table").length, 0, "no tables for an empty period");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed === 0 ? 0 : 1;

