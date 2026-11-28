"use strict";

// Node test for the admin Profits tab (renderer/WorkPage/WorkPage.js).
//
// The tab is special because its inputs must never leave the computer: the
// Bulins prices and the per-policy profits live in localStorage and the report
// is summed in the browser from the policies /admin/insurances already returns.
// These checks pin:
//   - the settings round-trip (localStorage, defaults, a broken entry),
//   - Bulins payment = Bulins price - profit, profit = Price - Bulins payment,
//   - annulled, deleted and other-currency policies are left out,
//   - the daily / monthly / per-type / per-duration grouping and totals,
//   - the day/month/custom period stepping behind the arrow buttons,
//   - the tab is in the ADMIN navigation only and the section never uploads the
//     inputs (the single API call is the policy read).
//
// Run with:  node test/client/profitsReport.test.cjs   (or: npm test)

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..", "..");
const WORKPAGE_JS = path.join(ROOT, "renderer", "WorkPage", "WorkPage.js");
const COMMON_JS = path.join(ROOT, "renderer", "common.js");
const WORKPAGE_CSS = path.join(ROOT, "renderer", "WorkPage", "WorkPage.css");

const src = fs.readFileSync(WORKPAGE_JS, "utf8");
const common = fs.readFileSync(COMMON_JS, "utf8");
const css = fs.readFileSync(WORKPAGE_CSS, "utf8");

let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log("  PASS  " + name);
  } catch (err) {
    failed++;
    console.log("  FAIL  " + name + "  -> " + (err && err.message ? err.message : err));
  }
}
function ok(cond, msg) {
  if (!cond) throw new Error(msg || "expected truthy");
}
function eq(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error((msg || "values differ") + ` (got ${a}, want ${b})`);
}

// ---------------------------------------------------------------------------
// Load the real Profits section in a bare context (no DOM: the pure report
// helpers are what these checks exercise).
// ---------------------------------------------------------------------------
function sliceOf(text, startMarker, endMarker) {
  const start = text.indexOf(startMarker);
  ok(start >= 0, `marker not found: ${startMarker}`);
  const end = endMarker ? text.indexOf(endMarker, start) : -1;
  ok(end > start, `end marker not found: ${endMarker}`);
  return text.slice(start, end);
}
function slice(startMarker, endMarker) {
  return sliceOf(src, startMarker, endMarker);
}

const vehicleBlock = slice("function pricingVehicleKey(", "\n// MySQL flags arrive");
// The kind helpers decide which products belong in this (border tariff) report.
const kindsBlock = slice(
  'const BORDER_KIND = "border";',
  "// Duration dropdown options (values in days)"
);
// The Profits section runs from its local-storage key to the next admin
// section ("Employee statistics"), which now sits between it and the navigation
// setup. Keeping the boundary explicit means the checks below only ever count
// this section's own API calls.
const profitsBlock = slice(
  "const PROFIT_SETTINGS_KEY",
  "\n// Admin > Employee statistics"
);

const CTX = {
  // The real helpers the section calls (same code as the app, kept small).
  localDateString(d = new Date()) {
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  },
  nextLocalDate(dateString) {
    const [y, m, d] = dateString.split("-").map(Number);
    return CTX.localDateString(new Date(y, m - 1, d + 1));
  },
  previousLocalDate(dateString) {
    const [y, m, d] = dateString.split("-").map(Number);
    return CTX.localDateString(new Date(y, m - 1, d - 1));
  },
  t(key, fallback) {
    // One template with a placeholder, so the warning's {n} substitution is
    // exercised as well.
    if (key === "profits.unpriced") return "{n} unpriced policies";
    return fallback !== undefined ? fallback : key;
  },
  localStorage: null,
};
vm.createContext(CTX);
const store = new Map();
CTX.localStorage = {
  getItem: (key) => (store.has(key) ? store.get(key) : null),
  setItem: (key, value) => store.set(key, String(value)),
  removeItem: (key) => store.delete(key),
};
vm.runInContext(vehicleBlock + "\n" + kindsBlock + "\n" + profitsBlock, CTX, {
  filename: "WorkPage.js#profits",
});

// ---------------------------------------------------------------------------
// A tiny DOM, just enough for el()/renderTable()/the report builders. This runs
// the real rendering code, so a label or a column that stopped existing fails
// here instead of only in the app.
// ---------------------------------------------------------------------------
function makeElement(tag) {
  return {
    tagName: String(tag || "").toUpperCase(),
    className: "",
    textContent: "",
    title: "",
    hidden: false,
    disabled: false,
    value: "",
    children: [],
    attributes: {},
    dataset: {},
    appendChild(child) {
      this.children.push(child);
      return child;
    },
    replaceChildren(...nodes) {
      this.children = nodes.filter(Boolean);
    },
    setAttribute(name, value) {
      this.attributes[name] = String(value);
      if (name === "class") this.className = String(value);
    },
    getAttribute(name) {
      return this.attributes[name];
    },
    addEventListener() {},
    classList: { add() {}, remove() {}, toggle() {} },
    querySelector() {
      return null;
    },
  };
}
CTX.document = { createElement: makeElement };
CTX.input = (type, value) => {
  const node = makeElement("input");
  node.type = type || "text";
  if (value !== undefined && value !== null) node.value = value;
  return node;
};
CTX.formatDateOnly = (value) => {
  const day = CTX.profitDayOf(value);
  return day ? `${day.slice(8, 10)}-${day.slice(5, 7)}-${day.slice(0, 4)}` : "";
};
CTX.dateFieldMonthLabel = (iso) => {
  const day = CTX.profitDayOf(iso);
  return day ? `${day.slice(0, 7)}` : "";
};
CTX.fmt = (text, vars) =>
  String(text).replace(/\{(\w+)\}/g, (m, k) =>
    vars && vars[k] !== undefined ? String(vars[k]) : m
  );

const elBlock = sliceOf(
  common,
  "function el(tag, text, attrs) {",
  "\n// Password visibility toggle"
);
const moneyBlock = slice(
  "function money(value) {",
  "\n// The amount a worker should charge"
);
const renderTableBlock = slice("function renderTable(", "\n// Sortable tables");
vm.runInContext(
  [elBlock, moneyBlock, renderTableBlock].join("\n"),
  CTX,
  { filename: "WorkPage.js#render" }
);

function walk(node, visit) {
  if (!node) return;
  visit(node);
  for (const child of node.children || []) walk(child, visit);
}

// A policy row as /admin/insurances returns it (prices are strings).
function policy(overrides) {
  return {
    BlancNumber: "b",
    Price: "40.00",
    CurrencyType: "EUR",
    Otomobil: "Automobile",
    Duration: 15,
    CreationDate: "2026-11-02 10:00:00",
    Annulled: 0,
    Deleted: 0,
    ...overrides,
  };
}

console.log("Profits — local Bulins prices, profit report and period paging");

check("settings start empty and a typed value survives a reload", () => {
  store.clear();
  const empty = CTX.profitLoadSettings();
  eq(empty.currency, "EUR");
  eq(empty.bulins.Auto["15"], "");
  eq(empty.profit.Bus["90"], "");

  empty.bulins.Auto["15"] = "40,50";
  empty.profit.Motor["90"] = "3";
  empty.currency = "TRY";
  eq(CTX.profitSaveSettings(empty), true);

  const loaded = CTX.profitLoadSettings();
  eq(loaded.bulins.Auto["15"], "40,50", "the typed text is kept");
  eq(loaded.profit.Motor["90"], "3");
  eq(loaded.currency, "TRY");
  ok(CTX.profitSettingsHasValues(loaded), "a filled grid is recognised");
});

check("a broken stored value falls back to clean settings", () => {
  store.clear();
  store.set("profitSettings.v1", "{not json");
  const loaded = CTX.profitLoadSettings();
  eq(loaded.bulins.Auto["15"], "");
  eq(loaded.currency, "EUR");

  store.set(
    "profitSettings.v1",
    JSON.stringify({ currency: "USD", bulins: { Auto: { 15: 12, Nope: 1 } } })
  );
  const cleaned = CTX.profitLoadSettings();
  eq(cleaned.currency, "EUR", "only the currencies the app knows");
  eq(cleaned.bulins.Auto["15"], "12");
  eq(cleaned.bulins.Nope, undefined, "unknown types are ignored");
});

check("prices accept a comma and ignore a currency sign", () => {
  eq(CTX.profitNumber(" 40,50 € "), 40.5);
  eq(CTX.profitNumber("181"), 181);
  eq(CTX.profitNumber("0"), 0);
  eq(Number.isNaN(CTX.profitNumber("")), true);
  eq(Number.isNaN(CTX.profitNumber("  ")), true);
});

check("Bulins payment = Bulins price - profit; profit = Price - payment", () => {
  const settings = CTX.profitDefaultSettings();
  settings.bulins.Auto["15"] = "40";
  settings.profit.Auto["15"] = "5";
  const amounts = CTX.profitPolicyAmounts(policy({}), settings);
  eq(amounts.type, "Auto");
  eq(amounts.durationKey, "15");
  eq(amounts.priced, true);
  eq(amounts.income, 40);
  eq(amounts.bulins, 35);
  eq(amounts.profit, 5);
});

check("a policy with no Bulins price is flagged, not guessed", () => {
  const settings = CTX.profitDefaultSettings();
  const amounts = CTX.profitPolicyAmounts(policy({}), settings);
  eq(amounts.priced, false);
  eq(amounts.bulins, 0);
  eq(amounts.profit, 40, "its income is counted as profit");
});

check("legacy types and durations land in the Other cells", () => {
  const settings = CTX.profitDefaultSettings();
  settings.bulins.Other.other = "20";
  settings.profit.Other.other = "2";
  const amounts = CTX.profitPolicyAmounts(
    policy({ Otomobil: "Boat", Duration: 365, Price: "20" }),
    settings
  );
  eq(amounts.type, "Other");
  eq(amounts.durationKey, "other");
  eq(amounts.bulins, 18);
  eq(amounts.profit, 2);

  // "Otomobil" is the legacy spelling of a car, so it uses the Auto cells.
  const legacy = CTX.profitPolicyAmounts(
    policy({ Otomobil: "Otomobil", Duration: 30 }),
    settings
  );
  eq(legacy.type, "Auto");
  eq(legacy.durationKey, "30");

  const motor = CTX.profitPolicyAmounts(
    policy({ Otomobil: "Motor", Duration: 30 }),
    settings
  );
  eq(motor.type, "Motor");
  eq(motor.durationKey, "30");
});

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------
function reportSettings() {
  const settings = CTX.profitDefaultSettings();
  settings.bulins.Auto["15"] = "40";
  settings.profit.Auto["15"] = "5";
  settings.bulins.Auto["90"] = "9";
  settings.profit.Auto["90"] = "0";
  settings.bulins.Motor["30"] = "30";
  settings.profit.Motor["30"] = "1";
  return settings;
}

const policies = [
  policy({ BlancNumber: "1", CreationDate: "2026-11-02 10:00:00" }),
  policy({ BlancNumber: "2", CreationDate: "2026-11-02 18:30:00" }),
  policy({
    BlancNumber: "3",
    Price: "9.00",
    Duration: 90,
    CreationDate: "2026-11-05 09:00:00",
  }),
  policy({
    BlancNumber: "4",
    Otomobil: "Motor",
    Duration: 30,
    Price: "31",
    CreationDate: "2026-11-05 12:00:00",
  }),
  // Left out of every figure below.
  policy({
    BlancNumber: "annulled",
    Annulled: 1,
    AnnulFee: 9,
    CreationDate: "2026-11-02 11:00:00",
  }),
  policy({ BlancNumber: "deleted", Deleted: "1", CreationDate: "2026-11-02 12:00:00" }),
  policy({ BlancNumber: "try", CurrencyType: "TRY", CreationDate: "2026-11-02 13:00:00" }),
  // Outside the reported period.
  policy({ BlancNumber: "old", CreationDate: "2026-10-30 08:00:00" }),
];

check("income sums the prices, without annulled, deleted and other currencies", () => {
  const report = CTX.profitReport(
    policies,
    reportSettings(),
    "2026-11-01",
    "2026-11-30"
  );
  eq(report.currency, "EUR");
  eq(report.totals.policies, 4);
  eq(report.totals.income, 120);
  eq(report.totals.bulins, 108);
  eq(report.totals.profit, 12);
  eq(report.totals.unpriced, 0);
  eq(report.otherCurrency, 1, "the TRY policy is counted separately");
});

check("medical and civil liability policies are left out of the tariff report", () => {
  const report = CTX.profitReport(
    [
      policy({ BlancNumber: "border" }),
      policy({ BlancNumber: "med", Kind: "medical", Price: "500.00" }),
      policy({
        BlancNumber: "civil",
        Kind: "civil",
        Price: "300.00",
        CreationDate: "2026-11-02 11:00:00",
      }),
    ],
    reportSettings(),
    "2026-11-01",
    "2026-11-30"
  );
  eq(report.otherKind, 2, "the hand-priced policies are counted separately");
  eq(report.totals.policies, 1, "only border insurance is in the figures");
  eq(
    report.totals.income,
    40,
    "their hand-typed price is never measured against a border tariff"
  );
  const nodes = CTX.profitReportNodes(report);
  ok(
    nodes.some((node) => node.textContent === "profits.otherKind"),
    "the excluded hand-priced policies are mentioned"
  );
});

check("the daily report groups by calendar day", () => {
  const report = CTX.profitReport(
    policies,
    reportSettings(),
    "2026-11-01",
    "2026-11-30"
  );
  eq(report.days.length, 2);
  eq(report.days[0], {
    date: "2026-11-02",
    policies: 2,
    income: 80,
    bulins: 70,
    profit: 10,
    unpriced: 0,
  });
  eq(report.days[1], {
    date: "2026-11-05",
    policies: 2,
    income: 40,
    bulins: 38,
    profit: 2,
    unpriced: 0,
  });
  eq(report.bestDay.date, "2026-11-02");
  eq(report.bestDay.profit, 10);
});

check("the monthly report groups by calendar month", () => {
  const report = CTX.profitReport(
    policies,
    reportSettings(),
    "2026-10-01",
    "2026-12-31"
  );
  eq(report.months.length, 2);
  eq(report.months[0].month, "2026-10");
  eq(report.months[0].policies, 1);
  eq(report.months[0].income, 40);
  eq(report.months[1].month, "2026-11");
  eq(report.months[1].policies, 4);
  eq(report.months[1].profit, 12);
  eq(report.bestMonth.month, "2026-11");
});

check("the statistics split the same totals by type and duration", () => {
  const report = CTX.profitReport(
    policies,
    reportSettings(),
    "2026-11-01",
    "2026-11-30"
  );
  eq(report.types, [
    { type: "Auto", policies: 3, income: 89, bulins: 79, profit: 10, unpriced: 0 },
    { type: "Motor", policies: 1, income: 31, bulins: 29, profit: 2, unpriced: 0 },
  ]);
  eq(report.durations, [
    { duration: "15", policies: 2, income: 80, bulins: 70, profit: 10, unpriced: 0 },
    { duration: "30", policies: 1, income: 31, bulins: 29, profit: 2, unpriced: 0 },
    { duration: "90", policies: 1, income: 9, bulins: 9, profit: 0, unpriced: 0 },
  ]);
  eq(CTX.profitMargin(10, 89), "11.2%");
  eq(CTX.profitMargin(0, 0), "");
  eq(CTX.profitRound(2.345), 2.35);
});

check("unpriced policies are counted and reported", () => {
  const settings = CTX.profitDefaultSettings();
  const report = CTX.profitReport([policy({})], settings, "2026-11-02", "2026-11-02");
  eq(report.totals.policies, 1);
  eq(report.totals.unpriced, 1);
  eq(report.totals.bulins, 0);
  eq(report.totals.profit, 40);
  eq(report.days[0].unpriced, 1);
});

// ---------------------------------------------------------------------------
// The period behind the two pickers and the arrow buttons
// ---------------------------------------------------------------------------
check("a month ends on its real last day", () => {
  eq(CTX.profitMonthStart("2026-11-19"), "2026-11-01");
  eq(CTX.profitMonthEnd("2026-11-19"), "2026-11-30");
  eq(CTX.profitMonthEnd("2026-02-10"), "2026-02-28");
  eq(CTX.profitMonthEnd("2028-02-10"), "2028-02-29", "a leap year");
  eq(CTX.profitMonthEnd("2026-12-05"), "2026-12-31");
});

check("a period is recognised as a day, a month or a custom range", () => {
  eq(CTX.profitRangeMode("2026-11-02", "2026-11-02"), "day");
  eq(CTX.profitRangeMode("2026-11-01", "2026-11-30"), "month");
  eq(CTX.profitRangeMode("2026-11-01", "2026-11-29"), "custom");
  eq(CTX.profitDaysBetween("2026-11-04", "2026-11-10"), 7);
});

check("the arrows step a day, a month or a whole custom range", () => {
  eq(CTX.profitShiftRange("2026-11-10", "2026-11-10", 1), {
    from: "2026-11-11",
    to: "2026-11-11",
  });
  eq(CTX.profitShiftRange("2026-11-10", "2026-11-10", -1), {
    from: "2026-11-09",
    to: "2026-11-09",
  });
  eq(CTX.profitShiftRange("2026-11-01", "2026-11-30", 1), {
    from: "2026-12-01",
    to: "2026-12-31",
  });
  eq(CTX.profitShiftRange("2026-12-01", "2026-12-31", 1), {
    from: "2027-01-01",
    to: "2027-01-31",
  });
  eq(CTX.profitShiftRange("2026-11-04", "2026-11-10", -1), {
    from: "2026-10-28",
    to: "2026-11-03",
  });
});

// ---------------------------------------------------------------------------
// Rendering (real builders + real renderTable, on the tiny DOM above)
// ---------------------------------------------------------------------------
check("the report renders four summary cards and four tables", () => {
  const report = CTX.profitReport(
    policies,
    reportSettings(),
    "2026-11-01",
    "2026-11-30"
  );
  const nodes = CTX.profitReportNodes(report);
  const grids = nodes.filter((node) => node.className === "stat-grid");
  eq(grids.length, 2, "summary cards + statistics cards");
  eq(grids[0].children.length, 4, "income, Bulins payment, profit, policies");
  eq(grids[0].children[0].children[0].textContent, "profits.totalIncome");
  eq(grids[0].children[1].children[0].textContent, "profits.bulinsPayment");
  eq(grids[0].children[2].children[0].textContent, "profits.profit");

  const tables = [];
  walk({ children: nodes }, (node) => {
    if (node.tagName === "TABLE") tables.push(node);
  });
  eq(tables.length, 4, "daily, monthly, by type, by duration");
  const dailyRows = tables[0].children[1].children;
  eq(dailyRows.length, 2, "the two selling days of the period");
  eq(dailyRows[0].children[1].textContent, 2, "two policies on 02-11");
  eq(dailyRows[0].children[4].textContent, "10.00", "profit on 02-11");
  const monthlyRows = tables[1].children[1].children;
  eq(monthlyRows.length, 1, "one month in the period");
  eq(monthlyRows[0].children[4].textContent, "12.00", "the month's profit");
  const typeRows = tables[2].children[1].children;
  eq(typeRows.length, 2, "Auto and Motor");
  eq(typeRows[0].children[0].textContent, "vehicle.Automobile");
  eq(typeRows[0].children[5].textContent, "11.2%", "Auto margin");
  ok(
    nodes.some((node) => node.textContent === "profits.otherCurrency"),
    "the excluded other-currency policy is mentioned"
  );
});

check("the warning line appears only when a policy has no Bulins price", () => {
  const priced = CTX.profitReportNodes(
    CTX.profitReport(policies, reportSettings(), "2026-11-01", "2026-11-30")
  );
  ok(
    !priced.some((node) => node.className === "profit-warning"),
    "nothing to warn about"
  );
  const unpriced = CTX.profitReportNodes(
    CTX.profitReport([policy({})], CTX.profitDefaultSettings(), "2026-11-02", "2026-11-02")
  );
  const warning = unpriced.find((node) => node.className === "profit-warning");
  ok(warning, "the unpriced policy is called out");
  ok(
    String(warning.textContent).includes("1"),
    "the warning carries the count"
  );
});

check("the settings render one input per type and duration", () => {
  const grid = CTX.profitDefaultSettings().bulins;
  grid.Auto["15"] = "40";
  const block = CTX.profitSettingsTable("Bulins price", grid, () => {});
  const tables = [];
  walk(block, (node) => {
    if (node.tagName === "TABLE") tables.push(node);
  });
  eq(tables.length, 1, "one grid per table");
  const head = tables[0].children[0].children[0];
  eq(head.children.length, 5, "type + the four durations");
  eq(head.children[0].textContent, "profits.type");
  const rows = tables[0].children[1].children;
  eq(rows.length, 5, "Auto, Motor, Bus, Trailer, Other");
  eq(rows[0].children.length, 5, "a type cell + one cell per duration");
  eq(rows[0].children[0].textContent, "vehicle.Automobile");
  eq(rows[0].children[1].children[0].tagName, "INPUT");
  eq(rows[0].children[1].children[0].value, "40", "the typed value is shown");
  eq(rows[4].children[0].textContent, "profits.otherType");
});

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------
check("the tab is in the admin navigation only", () => {
  const nav = slice("const NAV_DEFS = {", "\n// Admin switch");
  const adminPart = nav.slice(0, nav.indexOf("2: ["));
  ok(
    adminPart.includes('{ key: "nav.profits", load: profitsView }'),
    "admin navigation has the Profits tab"
  );
  eq(
    (src.match(/key: "nav\.profits", load: profitsView/g) || []).length,
    1,
    "workers and clients do not get the tab"
  );
});

check("the inputs are stored locally and never uploaded", () => {
  eq(
    (src.match(/const PROFIT_SETTINGS_KEY = "profitSettings\.v1";/g) || []).length,
    1,
    "one localStorage key, declared once"
  );
  ok(
    profitsBlock.includes("localStorage.setItem(PROFIT_SETTINGS_KEY"),
    "the settings are written to localStorage"
  );
  ok(
    profitsBlock.includes("localStorage.getItem(PROFIT_SETTINGS_KEY"),
    "and read back from it"
  );
  eq(
    (profitsBlock.match(/api\(/g) || []).length,
    1,
    "the section makes exactly one API call"
  );
  ok(
    profitsBlock.includes('api("/admin/insurances")'),
    "and that call only reads the policies"
  );
  ok(!profitsBlock.includes("fetch("), "nothing is posted anywhere");
  ok(
    profitsBlock.includes("the local inputs (never uploaded)"),
    "the inputs are marked as local-only"
  );
});

check("typing changes the working copy; Calculate saves and recalculates", () => {
  const view = slice("async function profitsView(", "\n// Navigation setup");
  const storeAt = view.indexOf("function storeValue(table, type, key, value) {");
  ok(storeAt >= 0, "storeValue exists");
  const storeBody = view.slice(storeAt, view.indexOf("\n  }", storeAt));
  ok(!storeBody.includes("profitSaveSettings"), "a keystroke does not save");
  ok(!storeBody.includes("renderReport"), "a keystroke does not recalculate");
  ok(storeBody.includes("markDirty()"), "a keystroke marks the inputs unsaved");

  const calcAt = view.indexOf("function runCalculation() {");
  ok(calcAt >= 0, "runCalculation exists");
  const calcBody = view.slice(calcAt, view.indexOf("\n  }", calcAt));
  ok(
    calcBody.includes("profitSaveSettings(settings)"),
    "Calculate saves the inputs"
  );
  ok(calcBody.includes("renderReport()"), "Calculate refreshes the report");
  ok(
    view.includes('calculateBtn.addEventListener("click", runCalculation)'),
    "the Calculate button runs it"
  );
  ok(
    view.includes(
      't(profitSettingsDirty ? "profits.unsaved" : "profits.saved")'
    ),
    "the status starts from the saved/unsaved flag"
  );
  ok(
    view.includes('t("profits.calculate")'),
    "the button is labelled"
  );
});

check("the view keeps both pickers and an arrow on each side", () => {
  const view = slice("async function profitsView(", "\n// Navigation setup");
  ok(view.includes('const fromInput = input("date", period.from)'), "From picker");
  ok(view.includes('const toInput = input("date", period.to)'), "To picker");
  ok(view.includes('field(t("profits.from"), fromInput)'), "From is labelled");
  ok(view.includes('field(t("profits.to"), toInput)'), "To is labelled");
  ok(
    view.includes('previousBtn.addEventListener("click", () => step(-1))'),
    "left arrow"
  );
  ok(view.includes('nextBtn.addEventListener("click", () => step(1))'), "right arrow");
  ok(view.includes("profitShiftRange("), "the arrows move the whole period");
  const prevAt = view.indexOf("dateNav.appendChild(previousBtn)");
  const fromAt = view.indexOf('dateNav.appendChild(field(t("profits.from")');
  const toAt = view.indexOf('dateNav.appendChild(field(t("profits.to")');
  const nextAt = view.indexOf("dateNav.appendChild(nextBtn)");
  ok(prevAt > 0 && prevAt < fromAt && fromAt < toAt && toAt < nextAt,
    "left arrow, From, To, right arrow");
  ok(
    view.indexOf("headingRow.appendChild(periodBox)") > 0,
    "the period controls sit in the header row (top right)"
  );
  ok(
    view.includes("profitsView().catch((err) => toast(err.message"),
    "a period change rebuilds the view"
  );
});

check("every label exists in both languages and the styles are shipped", () => {
  for (const key of [
    "nav.profits",
    "profits.localOnly",
    "profits.settings",
    "profits.bulinsTable",
    "profits.profitTable",
    "profits.totalIncome",
    "profits.bulinsPayment",
    "profits.profit",
    "profits.dailyReport",
    "profits.monthlyReport",
    "profits.statistics",
    "profits.unpriced",
    "profits.otherCurrency",
    "profits.calculate",
    "profits.unsaved",
    "profits.resetConfirm",
  ]) {
    const pattern = new RegExp(`"${key.replace(/\./g, "\\.")}":`, "g");
    eq((common.match(pattern) || []).length, 2, `${key} has an EN and a BG string`);
  }
  for (const rule of [
    ".profit-heading-row",
    ".profit-period",
    ".profit-date-nav",
    ".profit-settings-card",
    ".profit-input-table",
  ]) {
    ok(css.includes(rule), `${rule} is styled`);
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
