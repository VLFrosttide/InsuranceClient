"use strict";

// Node test for the EXPENSES section of the Current cash tab.
//
// An expense is money that left a branch's drawer as a SPEND: a manual
// "Expense" entry from the Current cash screen (rent, supplies, a payout ...).
// The very same ledger also holds the reductions the insurances routes write
// when a policy moves money - the refund of an annulled policy, the money a
// deletion gives back, the reversal of an edit or a price correction. Those
// lower the drawer as well, but they are policy movements, not money the branch
// spent, so they must never be counted as expenses. Money HANDED OVER to a
// person (Type = 'handover') is a third kind: it leaves the drawer too, but the
// branch did not spend it, so it is never an expense either.
//
// It loads the REAL server module (InsuranceServer/Requests/CurrentCash.js, see
// Test/serverPath.cjs) in a vm against an in-memory fake MySQL, so the
// assertions are about what the deployed code actually returns.
//
// Run with:  node Test/currentCashExpenses.test.cjs   (or: npm test)

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

const row = (id, type, amount, currency, reason, recipient = null) => ({
  id,
  Branch: "Офис Харманли",
  Type: type,
  Amount: amount,
  Currency: currency,
  Username: "worker1",
  Reason: reason,
  Recipient: recipient,
  CreatedAt: "2026-10-14 10:00:00",
});

(async () => {
  console.log("Current cash — expenses (manual reductions only)");

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

  check("only the manual reductions are expenses", () => {
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

  check("money handed over to a person is not an expense", () => {
    const rows = [
      row(1, "reduce", 20, "TRY", "Supplies"),
      // A hand-over takes money out of the drawer, but the branch did not spend
      // it, so it is its own ledger type and never an expense.
      row(2, "handover", 40, "EUR", "Runner to the safe", "Ivan"),
      row(3, "reduce", 5.55, "EUR", "Rent"),
    ];
    const split = CC.splitExpences(rows);
    eq(
      split.expences.map((r) => r.id),
      [1, 3],
      "the hand-over is left out"
    );
    eq(
      split.totalExpences,
      { EUR: 5.55, TRY: 20 },
      "and it is not part of the total either"
    );
  });

  check("the expenses total is per currency", () => {
    const split = CC.splitExpences([
      row(1, "reduce", 20, "TRY", "Supplies"),
      row(2, "reduce", 5.55, "EUR", "Rent"),
      row(3, "reduce", 4.45, "EUR", "Office coffee"),
      row(4, "reduce", 99, "EUR", "Annul 123456"),
    ]);
    eq(split.totalExpences, { EUR: 10, TRY: 20 }, "cents add up exactly");
  });

  check("a day without manual reductions has no expenses", () => {
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
    row(6, "handover", 40, "EUR", "Runner to the safe", "Ivan"),
  ];

  // Only the statements GET /currentcash issues are understood; anything else is
  // a hard error, so a changed query cannot silently slip through the test.
  const issuedSql = [];
  const makeDb = () => ({
    query: async (sql) => {
      const s = String(sql).replace(/\s+/g, " ").trim();
      issuedSql.push(s);
      if (s.startsWith("INSERT IGNORE INTO current_cash")) return [[]];
      if (s.startsWith("SELECT Currency, CurrentCash FROM current_cash")) {
        return [[{ Currency: "EUR", CurrentCash: 100 }]];
      }
      if (s.startsWith("SELECT CardBalance FROM branch_card_balance")) {
        return [[{ CardBalance: 0 }]];
      }
      if (
        s.startsWith(
          "SELECT ct.*, p.BlancNumber AS PolicyBlanc FROM cash_transactions ct"
        )
      ) {
        // No policy rows in these tests: every row was typed in by hand.
        return [ledgerRows.map((r) => ({ ...r, PolicyBlanc: null }))];
      }
      if (s.startsWith("SELECT * FROM cash_transactions")) return [ledgerRows];
      if (s.startsWith("SELECT * FROM cash_resets")) return [[]];
      if (s.startsWith("SELECT * FROM card_resets")) return [[]];
      if (s.startsWith("SELECT * FROM broker_cash_resets")) return [[]];
      if (s.startsWith("SELECT * FROM insurance")) return [[]];
      if (s.startsWith("SELECT i.*, b.Name AS BrokerName FROM insurance i")) {
        return [[]]; // no broker-funded policies on this day
      }
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

  await checkAsync("GET /currentcash lists the day's expenses", async () => {
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

  await checkAsync("policy movements are not drawer transactions", async () => {
    const res = await callCurrentCash({
      branch: "Офис Харманли",
      date: DAY,
      tzOffset: "180",
    });
    // The annulment and the deletion are bookkeeping of their policy (read live
    // from `insurance`), so only the manual movements and the hand-over are
    // listed - an edit never leaves a transaction behind either.
    eq(
      res.body.transactions.map((r) => r.id),
      [2, 3, 5, 6],
      "manual entries and the hand-over only"
    );
    eq(
      res.body.transactions.find((r) => r.id === 6).Recipient,
      "Ivan",
      "the hand-over names the person who took the money"
    );
  });

  // Regression: `insurance` has no `id` column (PRIMARY KEY is BlancNumber), so
  // ordering the card-insurance list by id made MySQL reject the whole Current
  // cash request with "Unknown column 'id' in 'ORDER BY'".
  await checkAsync("card insurance lookup sorts only by insurance columns", async () => {
    const res = await callCurrentCash({
      branch: "Офис Харманли",
      date: DAY,
      tzOffset: "180",
    });
    eq(res.code, 200, "status");
    const q = issuedSql.find(
      (sql) =>
        sql.startsWith("SELECT * FROM insurance") &&
        sql.includes("PaymentType = 'Card'")
    );
    ok(q, "card insurance lookup is issued");
    ok(
      /ORDER BY CreationDate DESC, BlancNumber DESC$/.test(q),
      "valid insurance ORDER BY: " + q
    );
    ok(!/ORDER BY [^`]*\bid\b/.test(q), "no unknown id column: " + q);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();

