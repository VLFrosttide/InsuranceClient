"use strict";

// Node test for the ADMIN-ONLY company bank account (Requests/Bank.js).
//
// What must hold:
//   - the monthly balance = cash kept at shift end + manual cash increases to
//     brokers - money handed over from the bank;
//   - a manual broker increase reaches the bank only at 00:00 the next day, so
//     today's increases are not in the current month's figure yet;
//   - every older month keeps its own closing balance in `history` (the month
//     starts fresh, nothing is discarded);
//   - only an admin may read the bank or record a hand-over from it;
//   - a bank hand-over needs a positive amount and a recipient.
//
// The REAL server file runs in a vm against an in-memory fake, like
// test/server/brokerHandover.test.cjs.
//
// Run with:  node test/server/bankAccount.test.cjs   (or: npm test)

const fs = require("fs");
const vm = require("vm");
const { serverFile } = require("../serverPath.cjs");

const BANK_JS = serverFile("Requests", "Bank.js");

let passed = 0;
let failed = 0;
async function check(name, fn) {
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
  if (a !== b) throw new Error((msg || "values differ") + ` (got ${a}, want ${b})`);
}
function ok(value, msg) {
  if (!value) throw new Error(msg || "expected a truthy value");
}

const flat = (s) => String(s).replace(/\s+/g, " ").trim();

// Fixed "now" so the month and the 00:00 cutoff are predictable.
const NOW = "2026-11-21 10:00:00";
const TODAY_START = "2026-11-21 00:00:00";

let db;
function resetDb() {
  db = {
    cashResets: [],
    brokerMovements: [],
    bankHandovers: [],
    nextId: 1,
    sql: [],
  };
}
resetDb();

function inRange(value, start, end) {
  return String(value) >= String(start) && String(value) < String(end);
}

async function query(sql, params = []) {
  const s = flat(sql);
  const p = params || [];
  db.sql.push(s);

  if (s.startsWith("CREATE TABLE IF NOT EXISTS bank_handovers")) {
    return [{}];
  }

  // --- the requested month's totals ---------------------------------------
  if (s.startsWith("SELECT Currency, ROUND(SUM(KeptAmount), 2) AS Total FROM cash_resets")) {
    const rows = db.cashResets.filter((r) => inRange(r.CreatedAt, p[0], p[1]));
    return [byCurrency(rows)];
  }
  if (
    s.startsWith("SELECT Currency, ROUND(SUM(Amount), 2) AS Total FROM broker_balance_movements") &&
    s.includes("Branch IS NOT NULL") &&
    !s.includes("DATE_FORMAT")
  ) {
    const rows = db.brokerMovements.filter(
      (r) =>
        r.Type === "increase" &&
        Number(r.Deleted) !== 1 &&
        Number(r.Amount) > 0 &&
        r.Branch &&
        inRange(r.CreatedAt, p[0], p[1]) &&
        String(r.CreatedAt) < p[2]
    );
    return [byCurrency(rows)];
  }
  if (
    s.startsWith("SELECT Currency, ROUND(SUM(Amount), 2) AS Total FROM bank_handovers") &&
    !s.includes("DATE_FORMAT")
  ) {
    const rows = db.bankHandovers.filter(
      (r) => Number(r.Deleted) !== 1 && inRange(r.CreatedAt, p[0], p[1])
    );
    return [byCurrency(rows)];
  }

  // --- month-by-month history ---------------------------------------------
  if (s.startsWith("SELECT DATE_FORMAT(CreatedAt, '%Y-%m') AS Month") && s.includes("FROM cash_resets")) {
    return [db.cashResets.map((r) => monthRow(r, r.KeptAmount))];
  }
  if (
    s.startsWith("SELECT DATE_FORMAT(CreatedAt, '%Y-%m') AS Month") &&
    s.includes("FROM broker_balance_movements")
  ) {
    const rows = db.brokerMovements
      .filter(
        (r) =>
          r.Type === "increase" &&
          Number(r.Deleted) !== 1 &&
          Number(r.Amount) > 0 &&
          r.Branch &&
          String(r.CreatedAt) < p[0]
      )
      .map((r) => monthRow(r, r.Amount));
    return [rows];
  }
  if (s.startsWith("SELECT DATE_FORMAT(CreatedAt, '%Y-%m') AS Month") && s.includes("FROM bank_handovers")) {
    return [
      db.bankHandovers
        .filter((r) => Number(r.Deleted) !== 1)
        .map((r) => monthRow(r, r.Amount)),
    ];
  }

  // --- the requested month's hand-over rows -------------------------------
  if (s.startsWith("SELECT id, Amount, Currency, Recipient, Reason, Author, CreatedAt FROM bank_handovers")) {
    return [
      db.bankHandovers.filter(
        (r) => Number(r.Deleted) !== 1 && inRange(r.CreatedAt, p[0], p[1])
      ),
    ];
  }

  if (s.startsWith("INSERT INTO bank_handovers")) {
    const row = {
      id: db.nextId++,
      Amount: p[0],
      Currency: p[1],
      Recipient: p[2],
      Reason: p[3],
      Author: p[4],
      CreatedAt: p[5],
      Deleted: 0,
    };
    db.bankHandovers.push(row);
    return [{ insertId: row.id }];
  }

  throw new Error("unexpected SQL in bank fake: " + s);
}

function byCurrency(rows) {
  const totals = new Map();
  for (const row of rows) {
    const cur = String(row.Currency || "EUR").toUpperCase() === "TRY" ? "TRY" : "EUR";
    totals.set(cur, (totals.get(cur) || 0) + Number(row.Amount ?? row.KeptAmount ?? 0));
  }
  return [...totals.entries()].map(([Currency, Total]) => ({ Currency, Total }));
}

function monthRow(row, amount) {
  return {
    Month: String(row.CreatedAt).slice(0, 7),
    Currency: row.Currency || "EUR",
    Total: amount,
  };
}

const routes = [];
const roleCalls = [];
const fakeRouter = {
  get: (path, ...handlers) =>
    routes.push({ method: "get", path, handler: handlers[handlers.length - 1] }),
  post: (path, ...handlers) =>
    routes.push({ method: "post", path, handler: handlers[handlers.length - 1] }),
  patch: () => {},
  put: () => {},
  delete: () => {},
  use: () => {},
};

const STUBS = {
  express: { Router: () => fakeRouter },
  "./Auth.js": {
    requireAuth: () => (req, res, next) => next(),
    requireRole: (...roles) => {
      roleCalls.push(roles);
      return (req, res, next) => next();
    },
  },
  "./CurrentCash.js": {
    clientLocalDateTime: () => NOW,
    normalizeCurrency: (c) =>
      String(c || "").toUpperCase() === "TRY" ? "TRY" : "EUR",
    resolveRequestCreatedAt: (body) => ({
      createdAt: (body && body.CreatedAt) || NOW,
    }),
    toDecimal: (v) =>
      v === null || v === undefined || v === "" || !Number.isFinite(Number(v))
        ? null
        : Number(v),
  },
};

const mod = { exports: {} };
const CTX = { console, module: mod, exports: mod.exports, Buffer, process };
CTX.require = (id) => {
  if (!Object.prototype.hasOwnProperty.call(STUBS, id)) {
    throw new Error("unexpected require in Bank.js: " + id);
  }
  return STUBS[id];
};
vm.createContext(CTX);
vm.runInContext(fs.readFileSync(BANK_JS, "utf8"), CTX, { filename: BANK_JS });
const Bank = mod.exports;

const fakeDb = { query };
Bank.createBankRouter(fakeDb);

function route(method, path) {
  const r = routes.find((x) => x.method === method && x.path === path);
  if (!r) throw new Error(`route ${method.toUpperCase()} ${path} not registered`);
  return r.handler;
}

async function call(method, path, { body = {}, query = {}, user } = {}) {
  const out = { status: 200, body: null };
  const res = {
    status(c) {
      out.status = c;
      return res;
    },
    json(b) {
      out.body = b;
      return res;
    },
  };
  await route(method, path)(
    { params: {}, body, query, user: user || { username: "admin1", role: 1 } },
    res
  );
  return out;
}

(async () => {
  console.log("bank account: monthly balance, history and hand-overs");

  await check("only an admin may use the bank", async () => {
    eq(roleCalls, [[1]], "both routes require role 1");
    ok(
      routes.some((r) => r.method === "get" && r.path === "/bank"),
      "GET /bank registered"
    );
    ok(
      routes.some((r) => r.method === "post" && r.path === "/bank/handover"),
      "POST /bank/handover registered"
    );
  });


  await check("the current month is cash at shift end + broker increases - hand-overs", async () => {
    resetDb();
    db.cashResets.push(
      { Currency: "EUR", KeptAmount: 100, CreatedAt: "2026-11-05 23:50:00" },
      { Currency: "TRY", KeptAmount: 500, CreatedAt: "2026-11-06 00:10:00" },
      { Currency: "EUR", KeptAmount: 40, CreatedAt: "2026-10-31 23:50:00" }
    );
    db.brokerMovements.push(
      { Type: "increase", Amount: 30, Currency: "EUR", Branch: "A", CreatedAt: "2026-11-03 12:00:00", Deleted: 0 },
      // Today's increase is not at the bank until 00:00 tomorrow.
      { Type: "increase", Amount: 20, Currency: "EUR", Branch: "A", CreatedAt: "2026-11-21 09:00:00", Deleted: 0 },
      { Type: "increase", Amount: 10, Currency: "EUR", Branch: "A", CreatedAt: "2026-10-02 12:00:00", Deleted: 0 },
      { Type: "increase", Amount: 99, Currency: "EUR", Branch: null, CreatedAt: "2026-11-03 12:00:00", Deleted: 0 },
      { Type: "handover", Amount: 77, Currency: "EUR", Branch: null, CreatedAt: "2026-11-03 12:00:00", Deleted: 0 },
      { Type: "increase", Amount: 55, Currency: "EUR", Branch: "A", CreatedAt: "2026-11-03 12:00:00", Deleted: 1 }
    );
    db.bankHandovers.push(
      { Amount: 40, Currency: "EUR", Recipient: "Owner", CreatedAt: "2026-11-10 12:00:00", Deleted: 0 },
      { Amount: 5, Currency: "EUR", Recipient: "Owner", CreatedAt: "2026-10-05 12:00:00", Deleted: 0 }
    );

    const r = await call("get", "/bank", { query: { tzOffset: "0" } });
    eq(r.status, 200, "status");
    eq(r.body.month, "2026-11", "the current month");
    eq(r.body.cashKept, { EUR: 100, TRY: 500 }, "cash at shift end");
    eq(r.body.brokerIncreases, { EUR: 30, TRY: 0 }, "completed days only");
    eq(r.body.handedOver, { EUR: 40, TRY: 0 }, "this month's hand-overs");
    eq(r.body.balance, { EUR: 90, TRY: 500 }, "100 + 30 - 40, 500");
  });

  await check("older months keep their own closing balance", async () => {
    const r = await call("get", "/bank", { query: { tzOffset: "0" } });
    const october = (r.body.history || []).find((h) => h.Month === "2026-10");
    ok(october, "October is in the history");
    eq(october.CashKept, { EUR: 40, TRY: 0 }, "October cash at shift end");
    eq(october.BrokerIncreases, { EUR: 10, TRY: 0 }, "October broker increases");
    eq(october.HandedOver, { EUR: 5, TRY: 0 }, "October hand-overs");
    eq(october.Balance, { EUR: 45, TRY: 0 }, "40 + 10 - 5");
    const november = (r.body.history || []).find((h) => h.Month === "2026-11");
    eq(november.Balance, { EUR: 90, TRY: 500 }, "November closes as the report shows");
  });

  await check("a hand-over from the bank needs a positive amount and a recipient", async () => {
    resetDb();
    let r = await call("post", "/bank/handover", {
      body: { amount: 10, currency: "EUR", Recipient: "" },
    });
    eq([r.status, r.body.error], [400, "recipient is required"], "recipient");
    r = await call("post", "/bank/handover", {
      body: { amount: 0, currency: "EUR", Recipient: "Owner" },
    });
    eq([r.status, r.body.error], [400, "amount must be a positive number"], "amount");
    r = await call("post", "/bank/handover", {
      body: { amount: -5, currency: "EUR", Recipient: "Owner" },
    });
    eq(r.status, 400, "a negative amount is refused");
    eq(db.bankHandovers.length, 0, "nothing recorded");
  });

  await check("a valid bank hand-over is stored with the author and day", async () => {
    resetDb();
    const r = await call("post", "/bank/handover", {
      body: {
        amount: 12.34,
        currency: "try",
        Recipient: "Supplier",
        reason: "rent",
        CreatedAt: "2026-11-18 15:00:00",
      },
    });
    eq(r.status, 200, "status");
    eq(r.body.message, "Bank hand-over recorded", "message");
    eq(db.bankHandovers.length, 1, "stored");
    eq(
      [
        db.bankHandovers[0].Amount,
        db.bankHandovers[0].Currency,
        db.bankHandovers[0].Recipient,
        db.bankHandovers[0].Author,
        db.bankHandovers[0].CreatedAt,
      ],
      [12.34, "TRY", "Supplier", "admin1", "2026-11-18 15:00:00"],
      "the row"
    );
  });

  await check("monthBounds is the first day up to the first day of the next month", async () => {
    eq(
      Bank.monthBounds("2026-12"),
      ["2026-12-01 00:00:00", "2027-01-01 00:00:00"],
      "December rolls into January"
    );
    eq(
      Bank.monthBounds("2026-01"),
      ["2026-01-01 00:00:00", "2026-02-01 00:00:00"],
      "January"
    );
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();

