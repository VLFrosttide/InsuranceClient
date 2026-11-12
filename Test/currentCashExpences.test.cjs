"use strict";

// Node test for the EXPENCES section of the Current cash tab.
//
// An expense is money that left a branch's drawer BY HAND: a manual "Reduce"
// from the Current cash screen (rent, supplies, a payout ...). The very same
// ledger also holds the reductions the insurances routes write when a policy
// moves money - the refund of an annulled policy, the money a deletion gives
// back, the reversal of an edit or a price correction. Those lower the drawer
// as well, but they are policy movements, not money the branch spent, so they
// must never be counted as expenses.
//
// It loads the REAL server module (InsuranceServer/Requests/CurrentCash.js, see
// Test/serverPath.cjs) in a vm against an in-memory fake MySQL, so the
// assertions are about what the deployed code actually returns.
//
// Run with:  node Test/currentCashExpences.test.cjs   (or: npm test)

const fs = require("fs");
const vm = require("vm");

const { serverFile } = require("./serverPath.cjs");

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
async function checkAsync(name, fn) {
  try {
    await fn();
    passed++;
    console.log("  PASS  " + name);
  } catch (err) {
    failed++;
    console.log("  FAIL  " + name + "  -> " + err.message);
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

// --- load the real module in a vm -------------------------------------------
const fakeRouter = {
  get: () => {},
  post: () => {},
  put: () => {},
  patch: () => {},
  delete: () => {},
  use: () => {},
};
const AUTH_STUB = {
  requireAuth: () => (req, res, next) => next(),
  requireRole: () => (req, res, next) => next(),
  extractToken: () => "",
};

// Loads the real CurrentCash.js with the stubbed router/Auth. `onRouter` lets a
// test capture the routes that get registered.
function loadCurrentCash(onRouter) {
  const mod = { exports: {} };
  const CTX = { console, module: mod, exports: mod.exports, Buffer, process };
  const router = onRouter ? onRouter() : fakeRouter;
  const stubs = { express: { Router: () => router }, "./Auth.js": AUTH_STUB };
  CTX.require = (id) => {
    if (!Object.prototype.hasOwnProperty.call(stubs, id)) {
      throw new Error("unexpected require in CurrentCash.js: " + id);
    }
    return stubs[id];
  };
  vm.createContext(CTX);
  vm.runInContext(
    fs.readFileSync(serverFile("Requests", "CurrentCash.js"), "utf8"),
    CTX,
    { filename: "CurrentCash.js" }
  );
  return mod.exports;
}

const CC = loadCurrentCash();

// The reasons the insurances routes write (Requests/TierEndpoints.js). None of
// them is money spent by the branch, so none is an expense.
const POLICY_REASONS = [
  "Annul 123456",
  "Annul 2026001234567",
  "Delete 654321",
  "Restore 654321",
  "Edit 1234567",
  "Price change 1234567",
];

const row = (id, type, amount, currency, reason) => ({
  id,
  Branch: "Офис Харманли",
  Type: type,
  Amount: amount,
  Currency: currency,
  Username: "worker1",
  Reason: reason,
  CreatedAt: "2026-10-14 10:00:00",
});

(async () => {
  console.log("Current cash — expences (manual reductions only)");

  check("every insurance-driven reduction is recognised", () => {
    for (const reason of POLICY_REASONS) {
      eq(CC.isPolicyMovementReason(reason), true, reason);
    }
  });

  check("a manually typed reason is an expense", () => {
    for (const reason of [
      "Аренда",
      "Rent for the office",
      "Supplies",
      "Salary 10.2026",
      "Чистачка",
      "payout",
    ]) {
      eq(CC.isPolicyMovementReason(reason), false, reason);
    }
  });

  check("a missing or malformed reason is never a policy movement", () => {
    eq(CC.isPolicyMovementReason(""), false, "empty");
    eq(CC.isPolicyMovementReason("   "), false, "blank");
    eq(CC.isPolicyMovementReason(undefined), false, "undefined");
    eq(CC.isPolicyMovementReason(null), false, "null");
    eq(CC.isPolicyMovementReason(42), false, "number");
  });

  check("only the manual reductions are expences", () => {
    const rows = [
      row(1, "reduce", 30, "EUR", "Annul 123456"),
      row(2, "reduce", 20, "TRY", "Supplies"),
      row(3, "increase", 50, "EUR", "Top up"),
      row(4, "reduce", 10, "EUR", "Delete 654321"),
      row(5, "reduce", 5.55, "EUR", "Rent"),
    ];
    const split = CC.splitExpences(rows);
    eq(
      split.expences.map((r) => r.id),
      [2, 5],
      "the annulment and the deletion are left out, an increase is not an expense"
    );
  });

  check("the expences total is per currency", () => {
    const split = CC.splitExpences([
      row(1, "reduce", 20, "TRY", "Supplies"),
      row(2, "reduce", 5.55, "EUR", "Rent"),
      row(3, "reduce", 4.45, "EUR", "Office coffee"),
      row(4, "reduce", 99, "EUR", "Annul 123456"),
    ]);
    eq(split.totalExpences, { EUR: 10, TRY: 20 }, "cents add up exactly");
  });

  check("a day without manual reductions has no expences", () => {
    const split = CC.splitExpences([
      row(1, "reduce", 30, "EUR", "Annul 123456"),
      row(2, "increase", 100, "EUR", "Opening"),
    ]);
    eq(split.expences, [], "nothing listed");
    eq(split.totalExpences, { EUR: 0, TRY: 0 }, "nothing counted");
  });

  check("nothing at all is fine too", () => {
    eq(CC.splitExpences(undefined).expences, [], "undefined");
    eq(CC.splitExpences([]).totalExpences, { EUR: 0, TRY: 0 }, "empty");
  });

  // --- the route the Current cash tab calls ---------------------------------
  const DAY = "2026-10-14";
  const ledgerRows = [
    row(1, "reduce", 30, "EUR", "Annul 123456"),
    row(2, "reduce", 20, "TRY", "Supplies"),
    row(3, "increase", 50, "EUR", "Top up"),
    row(4, "reduce", 10, "EUR", "Delete 654321"),
    row(5, "reduce", 5.55, "EUR", "Rent"),
  ];

  // Only the statements GET /currentcash issues are understood; anything else is
  // a hard error, so a changed query cannot silently slip through the test.
  const makeDb = () => ({
    query: async (sql) => {
      const s = String(sql).replace(/\s+/g, " ").trim();
      if (s.startsWith("INSERT IGNORE INTO current_cash")) return [[]];
      if (s.startsWith("SELECT Currency, CurrentCash FROM current_cash")) {
        return [[{ Currency: "EUR", CurrentCash: 100 }]];
      }
      if (s.startsWith("SELECT CardBalance FROM branch_card_balance")) {
        return [[{ CardBalance: 0 }]];
      }
      if (s.startsWith("SELECT * FROM cash_transactions")) return [ledgerRows];
      if (s.startsWith("SELECT * FROM cash_resets")) return [[]];
      if (s.startsWith("SELECT * FROM card_resets")) return [[]];
      if (s.startsWith("SELECT * FROM broker_cash_resets")) return [[]];
      if (s.startsWith("SELECT COALESCE(MAX(LastMovementId), 0) AS Marker")) {
        return [[{ Marker: 0 }]];
      }
      if (s.startsWith("SELECT m.Currency, ROUND(SUM(m.Amount), 2) AS Total")) {
        return [[]];
      }
      if (s.startsWith("SELECT m.id, m.BrokerId, b.Name AS BrokerName")) {
        return [[]]; // no broker top-ups on this day
      }
      throw new Error("fake DB: unhandled SQL -> " + s);
    },
  });

  const callCurrentCash = async (query) => {
    const routes = [];
    const router = Object.assign({}, fakeRouter, {
      get: (p, ...h) => routes.push({ path: p, handler: h[h.length - 1] }),
    });
    loadCurrentCash(() => router).createCurrentCashRouter(makeDb());
    const route = routes.find((r) => r.path === "/currentcash");
    ok(route, "GET /currentcash registered");
    const res = {
      code: 200,
      status(c) {
        this.code = c;
        return this;
      },
      json(b) {
        this.body = b;
        return this;
      },
    };
    await route.handler({ query, user: { username: "worker1" } }, res);
    return res;
  };

  await checkAsync("GET /currentcash lists the day's expences", async () => {
    const res = await callCurrentCash({
      branch: "Офис Харманли",
      date: DAY,
      tzOffset: "180",
    });
    eq(res.code, 200, "status");
    eq(
      res.body.expences.map((r) => r.id),
      [2, 5],
      "the manual reductions only"
    );
    eq(res.body.totalExpences, { EUR: 5.55, TRY: 20 }, "total per currency");
  });

  await checkAsync("the full ledger is still returned untouched", async () => {
    const res = await callCurrentCash({
      branch: "Офис Харманли",
      date: DAY,
      tzOffset: "180",
    });
    eq(
      res.body.transactions.map((r) => r.id),
      [1, 2, 3, 4, 5],
      "every entry, annulments and increases included"
    );
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();

