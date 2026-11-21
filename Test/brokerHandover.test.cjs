"use strict";

// Node test for the BROKER HAND-OVER TO THE OWNER (a broker paying the owner
// directly, so the cash never reaches a branch).
//
// What must hold:
//   - the hand-over raises the broker's balance like a top-up and is written to
//     `broker_balance_movements` with Type = 'handover' and NO branch;
//   - it is a payment for the reports (GET /reports/cash-inflow sums 'increase'
//     and 'handover');
//   - it is NOT Cash from Brokers: getBrokerCash in Requests/CurrentCash.js
//     sums only 'increase' rows that carry a branch;
//   - it writes nothing to cash_transactions / total_cash_transactions;
//   - it cannot be corrected into an 'increase'/'reduce' or the other way
//     round (that would move money between the two ledgers).
//
// The REAL server files are loaded in a vm against in-memory fakes, like
// Test/brokerHistory.test.cjs and Test/cashHandover.test.cjs do.
//
// Run with:  node Test/brokerHandover.test.cjs   (or: npm test)

const fs = require("fs");
const vm = require("vm");
const { serverFile } = require("./serverPath.cjs");

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

// Local "YYYY-MM-DD HH:MM:SS", matching the server's DATETIME format.
function dt(d) {
  const p = (n) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  );
}
function parseClientDateTime(value) {
  if (typeof value !== "string") return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(value.trim());
  if (!m) return null;
  return `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}`;
}
function clientLocalDateTime(offsetMinutes) {
  const local = new Date(Date.now() + (Number(offsetMinutes) || 0) * 60000);
  return dt(local);
}

function loadModule(file, stubs) {
  const mod = { exports: {} };
  const CTX = { console, module: mod, exports: mod.exports, Buffer, process };
  CTX.require = (id) => {
    if (!Object.prototype.hasOwnProperty.call(stubs, id)) {
      throw new Error("unexpected require: " + id);
    }
    return stubs[id];
  };
  vm.createContext(CTX);
  vm.runInContext(fs.readFileSync(file, "utf8"), CTX, { filename: file });
  return mod.exports;
}

// ---------------------------------------------------------------------------
// 1) Brokers.js: POST /brokers/:id/handover and the history type guard
// ---------------------------------------------------------------------------
let db;
function resetDb() {
  db = {
    brokers: [
      { id: 1, Name: "Alpha", Code: "A1", CashBalance: 70, ParentBrokerId: null, CutOff: 0 },
      { id: 2, Name: "Beta", Code: "B1", CashBalance: 0, ParentBrokerId: null, CutOff: 0 },
    ],
    movements: [],
    nextMovement: 1,
    // Every statement the loaded code issues, so a test can prove that a
    // hand-over never touches the cash drawer tables.
    sql: [],
  };
}
resetDb();

async function brokerQuery(sql, params = []) {
  const s = flat(sql);
  const p = params || [];
  db.sql.push(s);

  if (s.startsWith("CREATE TABLE IF NOT EXISTS broker_balance_movements")) {
    return [{}];
  }
  // The balance rebuild asks whether the broker has a starting balance first; no
  // row means the incremental update stands, which is what these tests assert.
  if (s.startsWith("CREATE TABLE IF NOT EXISTS broker_starting_balances")) {
    return [{}];
  }
  if (s.startsWith("CREATE TABLE IF NOT EXISTS broker_payments")) {
    return [{}];
  }
  if (
    s.startsWith(
      "SELECT Amount FROM broker_starting_balances WHERE BrokerId = ?"
    )
  ) {
    return [[]];
  }
  if (
    s ===
    "SELECT id, Name, Code, CashBalance, ParentBrokerId, CutOff FROM brokers WHERE id = ?"
  ) {
    return [db.brokers.filter((b) => b.id === Number(p[0]))];
  }
  if (s.startsWith("UPDATE brokers SET CashBalance = CashBalance + ? WHERE id = ?")) {
    const broker = db.brokers.find((b) => b.id === Number(p[1]));
    if (broker) {
      broker.CashBalance =
        Math.round((Number(broker.CashBalance) + Number(p[0])) * 100) / 100;
    }
    return [{ affectedRows: broker ? 1 : 0 }];
  }
  if (s.startsWith("INSERT INTO broker_balance_movements")) {
    const cols = /\(([^)]+)\) VALUES/.exec(s)[1].split(",").map((x) => x.trim());
    const row = { id: db.nextMovement++, Deleted: 0, DeletedAt: null, DeletedBy: null };
    cols.forEach((col, i) => (row[col] = p[i]));
    db.movements.push(row);
    return [{ affectedRows: 1, insertId: row.id }];
  }
  if (
    s.startsWith(
      "SELECT id, BrokerId, Amount, Type, Reason, Author, BlancNumber"
    ) &&
    s.includes("FROM broker_balance_movements")
  ) {
    const row = db.movements.find(
      (m) =>
        m.id === Number(p[0]) &&
        m.BrokerId === Number(p[1]) &&
        Number(m.Deleted) !== 1
    );
    return [row ? [row] : []];
  }
  if (s.startsWith("UPDATE broker_balance_movements SET")) {
    const m = /^UPDATE broker_balance_movements SET (.+?) WHERE id = \?$/.exec(s);
    const cols = m[1].split(",").map((x) => x.trim().split(/\s+/)[0]);
    const mov = db.movements.find((x) => x.id === Number(p[p.length - 1]));
    if (mov) cols.forEach((col, i) => (mov[col] = p[i]));
    return [{ affectedRows: mov ? 1 : 0 }];
  }
  throw new Error("unexpected SQL in broker fake: " + s);
}

const brokerDb = { query: brokerQuery, withTransaction: async (fn) => fn(brokerDb) };

const brokerRoutes = [];
const recordBrokerRoute = (method) => (path, ...handlers) =>
  brokerRoutes.push({ method, path, handler: handlers[handlers.length - 1] });
const brokerRouter = {
  get: recordBrokerRoute("get"),
  post: recordBrokerRoute("post"),
  put: recordBrokerRoute("put"),
  patch: recordBrokerRoute("patch"),
  delete: recordBrokerRoute("delete"),
  use: () => {},
};

const BROKER_STUBS = {
  express: { Router: () => brokerRouter },
  "./Auth.js": {
    requireAuth: () => (req, res, next) => next(),
    requireRole: () => (req, res, next) => next(),
  },
  "../db/BrokerInfo.js": { Pricing: {}, seedBrokerTariffsIfMissing: async () => 0 },
  "./CurrentCash.js": {
    toDecimal: (v) =>
      v === null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v),
    normalizeCurrency: (c) => (String(c || "").toUpperCase() === "TRY" ? "TRY" : "EUR"),
    normalizeBranch: (b) => String(b || ""),
    clientLocalDateTime,
    parseClientDateTime,
  },
  "./PaymentSchedule.js": {
    getSchedule: () => ({ periodStart: "2026-11-01", days: 14 }),
  },
  // Money the broker paid now lives in its own table; the balance formula reads
  // it there instead of summing the history ledger. The fake writes the same
  // ledger row through conn.query, so the assertions on db.movements still hold.
  "../db/brokerPayments.js": {
    ensureBrokerPaymentsTable: async () => {},
    sumBrokerPayments: async () => 0,
    recordBrokerPayment: async (conn, brokerId, amount, type, meta = {}) => {
      const [r] = await conn.query(
        `INSERT INTO broker_balance_movements
           (BrokerId, Amount, Type, Reason, Recipient, Author, BlancNumber,
            CreatedAt, Branch, Currency)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          brokerId,
          amount,
          type,
          meta.reason || "",
          meta.recipient || null,
          meta.author || "",
          null,
          meta.createdAt || null,
          typeof meta.branch === "string" ? meta.branch : null,
          meta.currency || "EUR",
        ]
      );
      return { id: r && r.insertId, amount };
    },
    syncBrokerPaymentFromMovement: async () => {},
  },
};

const Brokers = loadModule(serverFile("Requests", "Brokers.js"), BROKER_STUBS);
Brokers.createBrokerRouter(brokerDb);

function brokerRoute(method, path) {
  const r = brokerRoutes.find((x) => x.method === method && x.path === path);
  if (!r) throw new Error(`route ${method.toUpperCase()} ${path} not registered`);
  return r.handler;
}

async function callBroker(method, path, { params = {}, body = {}, user } = {}) {
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
  await brokerRoute(method, path)(
    { params, body, query: {}, user: user || { username: "worker1", role: 2 } },
    res
  );
  return out;
}


// ---------------------------------------------------------------------------
// 2) CurrentCash.js: Cash from Brokers must ignore a hand-over
// ---------------------------------------------------------------------------
const cashStubs = {
  express: { Router: () => ({ get: () => {}, post: () => {}, patch: () => {}, delete: () => {}, use: () => {} }) },
  "./Auth.js": {
    requireAuth: () => (req, res, next) => next(),
    requireRole: () => (req, res, next) => next(),
  },
};
const Cash = loadModule(serverFile("Requests", "CurrentCash.js"), cashStubs);

const BRANCH = "Офис Харманли";
const cashLedger = [
  // A normal branch top-up: this IS Cash from Brokers.
  { id: 1, BrokerId: 1, Amount: 100, Type: "increase", Branch: BRANCH, Currency: "EUR", Deleted: 0 },
  // The owner took this one directly: it must not count.
  { id: 2, BrokerId: 1, Amount: 500, Type: "handover", Branch: null, Currency: "EUR", Deleted: 0 },
  // A surviving pre-split top-up without a branch is not Cash from Brokers either.
  { id: 3, BrokerId: 2, Amount: 40, Type: "increase", Branch: null, Currency: "EUR", Deleted: 0 },
];

const cashFake = {
  async query(sql, params = []) {
    const s = flat(sql);
    const p = params || [];
    if (s.startsWith("SELECT COALESCE(MAX(LastMovementId), 0) AS Marker FROM broker_cash_resets")) {
      eq(p[0], BRANCH, "the branch is normalised and passed");
      return [[{ Marker: 0 }]];
    }
    if (
      s.startsWith(
        "SELECT m.Currency, ROUND(SUM(m.Amount), 2) AS Total FROM broker_balance_movements m WHERE m.Type = 'increase'"
      )
    ) {
      const rows = cashLedger.filter(
        (m) =>
          m.Type === "increase" &&
          Number(m.Deleted) !== 1 &&
          Number(m.Amount) > 0 &&
          m.Branch === p[0] &&
          m.id > Number(p[1])
      );
      const byCurrency = {};
      for (const m of rows) {
        byCurrency[m.Currency] = (byCurrency[m.Currency] || 0) + Number(m.Amount);
      }
      return [Object.entries(byCurrency).map(([Currency, Total]) => ({ Currency, Total }))];
    }
    throw new Error("unexpected SQL in cash fake: " + s);
  },
};

// ---------------------------------------------------------------------------
// 3) Reports.js: the hand-over is a payment (cash inflow)
// ---------------------------------------------------------------------------
const reportStubs = {
  express: {
    Router: () => ({
      get: (path, ...handlers) => reportRoutes.push({ path, handler: handlers[handlers.length - 1] }),
      post: () => {},
      put: () => {},
      patch: () => {},
      delete: () => {},
      use: () => {},
    }),
  },
  "./Auth.js": {
    requireAuth: () => (req, res, next) => next(),
    requireRole: () => (req, res, next) => next(),
  },
  "./TierEndpoints.js": { brokerNameMatches: () => false },
};
const reportRoutes = [];
const Reports = loadModule(serverFile("Requests", "Reports.js"), reportStubs);

const reportLedger = [
  { BrokerId: 1, Amount: 100, Type: "increase", CreatedAt: "2026-11-10 10:00:00", Deleted: 0 },
  { BrokerId: 1, Amount: 500, Type: "handover", CreatedAt: "2026-11-11 10:00:00", Deleted: 0 },
  { BrokerId: 1, Amount: -50, Type: "reduce", CreatedAt: "2026-11-12 10:00:00", Deleted: 0 },
  { BrokerId: 2, Amount: 200, Type: "increase", CreatedAt: "2026-10-01 10:00:00", Deleted: 0 },
];
const reportInsurances = [
  { BrokerId: 1, Price: 900, Annulled: 0, AnnulFee: 0, CreationDate: "2026-11-09", Deleted: 0 },
];

const reportFake = {
  async query(sql, params = []) {
    const s = flat(sql);
    const p = params || [];
    if (s.startsWith("SELECT BrokerId AS brokerId, ROUND(SUM(Amount), 2) AS amount")) {
      const rows = reportLedger.filter(
        (m) =>
          (m.Type === "increase" || m.Type === "handover") &&
          Number(m.Amount) > 0 &&
          Number(m.Deleted) !== 1 &&
          m.CreatedAt >= p[0] &&
          m.CreatedAt < p[1]
      );
      const byBroker = {};
      for (const m of rows) byBroker[m.BrokerId] = (byBroker[m.BrokerId] || 0) + Number(m.Amount);
      return [Object.entries(byBroker).map(([brokerId, amount]) => ({ brokerId: Number(brokerId), amount }))];
    }
    if (
      (s.startsWith("SELECT BrokerId AS brokerId,") ||
        s.startsWith("SELECT i.BrokerId AS brokerId,")) &&
      s.includes("FROM insurance")
    ) {
      const rows = reportInsurances.filter(
        (r) => Number(r.Deleted) !== 1 && r.CreationDate >= p[0] && r.CreationDate < p[1]
      );
      const byBroker = {};
      for (const r of rows) {
        const net = Number(r.Annulled) === 1 ? Number(r.AnnulFee) || 0 : Number(r.Price) || 0;
        byBroker[r.BrokerId] = (byBroker[r.BrokerId] || 0) + net;
      }
      return [Object.entries(byBroker).map(([brokerId, totalOwed]) => ({ brokerId: Number(brokerId), totalOwed }))];
    }
    if (s.startsWith("SELECT BrokerId AS brokerId, ROUND(SUM(Amount), 2) AS balanceBefore")) {
      const byBroker = {};
      for (const m of reportLedger) {
        if (Number(m.Deleted) === 1 || !(m.CreatedAt < p[0])) continue;
        byBroker[m.BrokerId] = (byBroker[m.BrokerId] || 0) + Number(m.Amount);
      }
      return [Object.entries(byBroker).map(([brokerId, balanceBefore]) => ({ brokerId: Number(brokerId), balanceBefore }))];
    }
    if (s === "SELECT id, Name FROM brokers") {
      return [[{ id: 1, Name: "Alpha" }, { id: 2, Name: "Beta" }]];
    }
    throw new Error("unexpected SQL in reports fake: " + s);
  },
};
Reports.createReportsRouter(reportFake);


function reportRoute(path) {
  const r = reportRoutes.find((x) => x.path === path);
  if (!r) throw new Error(`report route ${path} not registered`);
  return r.handler;
}

async function callReport(path, query) {
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
  await reportRoute(path)({ query, user: { username: "admin1", role: 1 } }, res);
  return out;
}

const HANDOVER = "/brokers/:id/handover";
const PATCH_MOVEMENT = "/brokers/:id/history/:movementId";

(async () => {
  console.log("broker hand-over: a payment, never Cash from Brokers");

  await check("the hand-over raises the broker's balance and records the payment", async () => {
    resetDb();
    const res = await callBroker("post", HANDOVER, {
      params: { id: "1" },
      body: {
        amount: 50,
        currency: "TRY",
        reason: "Owner collected",
        Recipient: "  Owner  ",
        CreatedAt: "2026-11-16 12:30:00",
      },
    });
    eq(res.status, 200, "accepted");
    eq(db.brokers[0].CashBalance, 120, "70 + 50");
    eq(db.movements.length, 1, "one movement");
    const m = db.movements[0];
    eq(
      [m.Type, m.Amount, m.Reason, m.Recipient, m.Author],
      ["handover", 50, "Owner collected", "Owner", "worker1"],
      "stored movement"
    );
    eq(m.CreatedAt, "2026-11-16 12:30:00", "client's own time");
    eq([m.Branch, m.Currency], [null, "TRY"], "no branch, but the currency is kept");
  });

  await check("a hand-over writes nothing to the cash drawer ledgers", async () => {
    resetDb();
    await callBroker("post", HANDOVER, {
      params: { id: "1" },
      body: { amount: 50, reason: "Owner collected", Recipient: "Owner" },
    });
    eq(db.sql.filter((s) => /cash_transactions/i.test(s)), [], "no cash_transactions statement");
  });

  await check("a hand-over is rejected without a positive amount or a reason", async () => {
    for (const body of [
      { amount: 0, reason: "Owner", Recipient: "Owner" },
      { amount: -5, reason: "Owner", Recipient: "Owner" },
      { amount: "abc", reason: "Owner", Recipient: "Owner" },
    ]) {
      resetDb();
      const res = await callBroker("post", HANDOVER, { params: { id: "1" }, body });
      eq(res.status, 400, `rejected ${JSON.stringify(body)}`);
      eq(db.movements.length, 0, "nothing recorded");
      eq(db.brokers[0].CashBalance, 70, "balance untouched");
    }
    resetDb();
    const noReason = await callBroker("post", HANDOVER, {
      params: { id: "1" },
      body: { amount: 10, Recipient: "Owner" },
    });
    eq([noReason.status, noReason.body.error], [400, "reason is required"], "reason is required");
  });

  await check("a hand-over needs the person who received the money", async () => {
    for (const recipient of [undefined, null, "", "   "]) {
      resetDb();
      const body = { amount: 10, reason: "Owner collected" };
      if (recipient !== undefined) body.Recipient = recipient;
      const res = await callBroker("post", HANDOVER, { params: { id: "1" }, body });
      eq(res.status, 400, `rejected ${JSON.stringify(recipient)}`);
      eq(
        res.body,
        { error: "recipient is required" },
        "a clear reason"
      );
      eq(db.movements.length, 0, "nothing recorded");
      eq(db.brokers[0].CashBalance, 70, "balance untouched");
    }
  });

  await check("a hand-over with a malformed date is rejected", async () => {
    resetDb();
    const res = await callBroker("post", HANDOVER, {
      params: { id: "1" },
      body: {
        amount: 10,
        reason: "Owner",
        Recipient: "Owner",
        CreatedAt: "16.11.2026",
      },
    });
    eq(res.status, 400, "rejected");
    eq(db.movements.length, 0, "nothing recorded");
  });

  await check("a hand-over for an unknown broker answers 404", async () => {
    resetDb();
    const res = await callBroker("post", HANDOVER, {
      params: { id: "99" },
      body: { amount: 10, reason: "Owner", Recipient: "Owner" },
    });
    eq(res.status, 404, "not found");
    eq(db.movements.length, 0, "nothing recorded");
  });

  await check("Cash from Brokers counts top-ups only, never a hand-over", async () => {
    const totals = await Cash.getBrokerCash(cashFake, BRANCH);
    eq(totals, { EUR: 100, TRY: 0 }, "only the 100 EUR branch top-up");
  });

  await check("the cash-inflow report reads a hand-over as money paid", async () => {
    const res = await callReport("/reports/cash-inflow", {
      from: "2026-11-01",
      to: "2026-11-15",
    });
    eq(res.status, 200, "ok");
    const alpha = (res.body.brokers || []).find((b) => b.brokerId === 1);
    ok(alpha, "the broker appears in the report");
    eq(alpha.amount, 600, "100 top-up + 500 hand-over (the 50 reduce is not a payment)");
    eq(alpha.totalOwed, 900, "the period's policies");
    eq(alpha.weeklyBalance, 300, "900 owed - 600 paid");
  });


  await check("a hand-over cannot be corrected into an increase", async () => {
    resetDb();
    await callBroker("post", HANDOVER, {
      params: { id: "1" },
      body: { amount: 50, reason: "Owner collected", Recipient: "Owner" },
    });
    const id = String(db.movements[0].id);
    const res = await callBroker("patch", PATCH_MOVEMENT, {
      params: { id: "1", movementId: id },
      body: { Type: "increase" },
    });
    eq(res.status, 400, "rejected");
    eq(
      res.body.error,
      "a handover cannot be changed into an increase or an expense, or the other way round",
      "a clear reason"
    );
    eq(db.movements[0].Type, "handover", "the type is unchanged");
    eq(db.brokers[0].CashBalance, 120, "the balance is unchanged");
  });

  await check("an increase cannot be corrected into a hand-over", async () => {
    resetDb();
    db.movements.push({
      id: 1,
      BrokerId: 1,
      Amount: 80,
      Type: "increase",
      Reason: "Branch top-up",
      Author: "worker1",
      BlancNumber: null,
      Branch: BRANCH,
      Currency: "EUR",
      Deleted: 0,
    });
    db.nextMovement = 2;
    const res = await callBroker("patch", PATCH_MOVEMENT, {
      params: { id: "1", movementId: "1" },
      body: { Type: "handover" },
    });
    eq(res.status, 400, "rejected");
    eq(db.movements[0].Type, "increase", "the top-up stays a top-up");
  });

  await check("a hand-over can still be corrected in amount and reason", async () => {
    resetDb();
    await callBroker("post", HANDOVER, {
      params: { id: "1" },
      body: { amount: 50, reason: "Owner collected", Recipient: "Owner" },
    });
    const id = String(db.movements[0].id);
    const res = await callBroker("patch", PATCH_MOVEMENT, {
      params: { id: "1", movementId: id },
      body: { amount: 60, reason: "Owner collected (corrected)" },
    });
    eq(res.status, 200, "accepted");
    eq(db.movements[0].Amount, 60, "the movement is corrected");
    eq(db.brokers[0].CashBalance, 130, "70 + 60");
  });

  await check("an admin can date a hand-over on an earlier day", async () => {
    resetDb();
    const res = await callBroker("post", HANDOVER, {
      params: { id: "1" },
      user: { username: "admin1", role: 1 },
      body: {
        amount: 30,
        currency: "EUR",
        reason: "Owner collected last week",
        Recipient: "Owner",
        date: "2026-10-01",
        CreatedAt: "2026-11-20 12:30:00",
        TzOffset: 0,
      },
    });
    eq(res.status, 200, "accepted");
    eq(
      db.movements[0].CreatedAt,
      "2026-10-01 12:30:00",
      "the picked day keeps the time of day"
    );
  });

  await check("a worker cannot date a hand-over on an earlier day", async () => {
    resetDb();
    const res = await callBroker("post", HANDOVER, {
      params: { id: "1" },
      body: {
        amount: 30,
        reason: "Owner collected last week",
        Recipient: "Owner",
        date: "2026-10-01",
        CreatedAt: "2026-11-20 12:30:00",
        TzOffset: 0,
      },
    });
    eq(res.status, 403, "refused");
    eq(
      res.body.error,
      "Only an admin can record a hand-over on an earlier date",
      "a clear reason"
    );
    eq(db.movements.length, 0, "nothing recorded");
    eq(db.brokers[0].CashBalance, 70, "balance untouched");
  });

  await check("a hand-over's date and recipient can be corrected later", async () => {
    resetDb();
    await callBroker("post", HANDOVER, {
      params: { id: "1" },
      body: {
        amount: 50,
        reason: "Owner collected",
        Recipient: "Owner",
        CreatedAt: "2026-11-16 12:30:00",
      },
    });
    const id = String(db.movements[0].id);
    const res = await callBroker("patch", PATCH_MOVEMENT, {
      params: { id: "1", movementId: id },
      user: { username: "admin1", role: 1 },
      body: { Recipient: "Maria", date: "2026-10-02", TzOffset: 0 },
    });
    eq(res.status, 200, "accepted");
    eq(db.movements[0].Recipient, "Maria", "the recipient is corrected");
    eq(
      db.movements[0].CreatedAt,
      "2026-10-02 12:30:00",
      "the date is corrected, the time of day is kept"
    );
    eq(db.brokers[0].CashBalance, 120, "a cosmetic correction never moves money");
  });

  await check("a hand-over cannot lose its recipient when corrected", async () => {
    resetDb();
    await callBroker("post", HANDOVER, {
      params: { id: "1" },
      body: {
        amount: 50,
        reason: "Owner collected",
        Recipient: "Owner",
      },
    });
    const id = String(db.movements[0].id);
    const res = await callBroker("patch", PATCH_MOVEMENT, {
      params: { id: "1", movementId: id },
      body: { Recipient: "   " },
    });
    eq([res.status, res.body.error], [400, "recipient is required"], "refused");
    eq(db.movements[0].Recipient, "Owner", "the recipient is unchanged");
  });

  await check("only a hand-over can be moved to another date", async () => {
    resetDb();
    db.movements.push({
      id: 1,
      BrokerId: 1,
      Amount: 80,
      Type: "increase",
      Reason: "Branch top-up",
      Recipient: null,
      Author: "worker1",
      BlancNumber: null,
      CreatedAt: "2026-11-16 12:30:00",
      Branch: BRANCH,
      Currency: "EUR",
      Deleted: 0,
    });
    db.nextMovement = 2;
    const res = await callBroker("patch", PATCH_MOVEMENT, {
      params: { id: "1", movementId: "1" },
      user: { username: "admin1", role: 1 },
      body: { date: "2026-10-02", TzOffset: 0 },
    });
    eq([res.status, res.body.error], [400, "only a hand-over can change its date"], "refused");
    eq(db.movements[0].CreatedAt, "2026-11-16 12:30:00", "the date is unchanged");
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();

