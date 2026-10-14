"use strict";

// Node test for the broker BALANCE HISTORY endpoint (GET /brokers/:id/history).
// Loads the REAL server file (InsuranceServer/Requests/Brokers.js) in a vm with
// its requires stubbed, and drives the handler against an in-memory fake MySQL.

const fs = require("fs");
const vm = require("vm");
const { serverFile } = require("./serverPath.cjs");

const BROKERS_JS = serverFile("Requests", "Brokers.js");

let db;
function resetDb() {
  db = {
    brokers: [
      { id: 1, Name: "Alpha", CashBalance: 70 },
      { id: 2, Name: "Beta", CashBalance: 0 },
    ],
    movements: [],
    nextMovement: 1,
  };
}

const flat = (s) => String(s).replace(/\s+/g, " ").trim();

function addMovement(brokerId, amount, createdAt, extra = {}) {
  db.movements.push({
    id: db.nextMovement++,
    BrokerId: brokerId,
    Amount: amount,
    Type: extra.Type || "increase",
    Reason: extra.Reason || "",
    Author: extra.Author || "",
    BlancNumber: extra.BlancNumber === undefined ? null : extra.BlancNumber,
    CreatedAt: createdAt,
  });
}

// Local "YYYY-MM-DD HH:MM:SS", matching the server's DATETIME format.
function dt(d) {
  const p = (n) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  );
}

async function query(sql, params = []) {
  const s = flat(sql);
  const p = params || [];

  if (s.startsWith("CREATE TABLE IF NOT EXISTS broker_balance_movements")) {
    return [{}];
  }
  if (s.startsWith("SELECT id, Name, CashBalance FROM brokers WHERE id = ?")) {
    return [db.brokers.filter((b) => b.id === Number(p[0]))];
  }
  if (
    s.startsWith(
      "SELECT COUNT(*) AS total, COALESCE(SUM(Amount), 0) AS net FROM broker_balance_movements"
    )
  ) {
    const rows = db.movements.filter(
      (m) => m.BrokerId === Number(p[0]) && m.CreatedAt >= p[1] && m.CreatedAt < p[2]
    );
    return [[
      { total: rows.length, net: rows.reduce((sum, m) => sum + Number(m.Amount), 0) },
    ]];
  }
  if (s.startsWith("SELECT t.id, t.Type, t.Amount")) {
    const balance = Number(p[0]);
    const rows = db.movements
      .filter(
        (m) => m.BrokerId === Number(p[1]) && m.CreatedAt >= p[2] && m.CreatedAt < p[3]
      )
      .sort((a, b) =>
        a.CreatedAt === b.CreatedAt
          ? b.id - a.id
          : a.CreatedAt < b.CreatedAt
            ? 1
            : -1
      );
    let running = balance;
    const out = rows.map((m) => {
      const r = { ...m, BalanceAfter: running };
      running -= Number(m.Amount);
      return r;
    });
    return [out.slice(Number(p[5]), Number(p[5]) + Number(p[4]))];
  }
  throw new Error("unexpected SQL in test: " + s);
}

const fakeDb = { query, withTransaction: async (fn) => fn(fakeDb) };

const routes = [];
const recorder = (method) => (path, ...handlers) =>
  routes.push({ method, path, handler: handlers[handlers.length - 1] });
const fakeRouter = {
  get: recorder("get"),
  post: recorder("post"),
  put: recorder("put"),
  patch: recorder("patch"),
  delete: recorder("delete"),
  use: () => {},
};

const STUBS = {
  express: { Router: () => fakeRouter },
  "./Auth.js": {
    requireAuth: () => (req, res, next) => next(),
    requireRole: () => (req, res, next) => next(),
  },
  "../db/BrokerInfo.js": { Pricing: {}, seedBrokerTariffsIfMissing: async () => 0 },
  "./CurrentCash.js": {
    toDecimal: (v) => (Number.isFinite(Number(v)) ? Number(v) : null),
    recordCashMovement: async () => {},
    normalizeCurrency: (c) => c || "EUR",
    normalizeBranch: (b) => b || "",
  },
  "./PaymentSchedule.js": { getSchedule: () => ({}) },
};

const mod = { exports: {} };
const CTX = { console, module: mod, exports: mod.exports, Buffer, process };
CTX.require = (id) => {
  if (!Object.prototype.hasOwnProperty.call(STUBS, id)) {
    throw new Error("unexpected require in Brokers.js: " + id);
  }
  return STUBS[id];
};
vm.createContext(CTX);
vm.runInContext(fs.readFileSync(BROKERS_JS, "utf8"), CTX, {
  filename: "Requests/Brokers.js",
});
const M = mod.exports;
M.createBrokerRouter(fakeDb);

function route(method, p) {
  const r = routes.find((x) => x.method === method && x.path === p);
  if (!r) throw new Error(`route ${method.toUpperCase()} ${p} not registered`);
  return r.handler;
}

const plain = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

async function call(
  method,
  p,
  { params = {}, body = {}, query = {}, user = { username: "admin1", role: 1 } } = {}
) {
  const out = { status: 200, body: null };
  const res = {
    status(c) {
      out.status = c;
      return res;
    },
    json(b) {
      out.body = plain(b);
      return res;
    },
    send(b) {
      out.body = b;
      return res;
    },
    setHeader() {},
  };
  const req = { params, body, query, user };
  // Replicate requireBrokerView (middleware is not run when invoking the
  // stored handler directly): admins/workers see every broker, broker clients
  // only their own broker.
  const role = String(user.role);
  req.brokerScope =
    role === "1" || role === "2" ? null : user.brokerId ? Number(user.brokerId) : null;
  await route(method, p)(req, res);
  return out;
}

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`ok   ${name}`);
  } catch (err) {
    failed++;
    console.log(`FAIL ${name}`);
    console.log(String((err && err.stack) || err));
  }
}
function eq(actual, expected, msg) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${msg || "eq"} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
    );
  }
}
function ok(value, msg) {
  if (!value) throw new Error(`${msg || "ok"} — expected truthy, got ${value}`);
}

const WINDOW = { since: "2026-10-01", until: "2026-11-01" };
resetDb();

(async () => {
  await check("invalid broker id is rejected", async () => {
    const r = await call("get", "/brokers/:id/history", { params: { id: "abc" } });
    eq(r.status, 400, "status");
  });

  await check("unknown broker answers 404", async () => {
    const r = await call("get", "/brokers/:id/history", { params: { id: "999" } });
    eq(r.status, 404, "status");
  });

  await check("malformed date range is rejected", async () => {
    const r = await call("get", "/brokers/:id/history", {
      params: { id: "1" },
      query: { since: "not-a-date" },
    });
    eq(r.status, 400, "status");
  });

  await check("broker client cannot view another broker's history", async () => {
    const r = await call("get", "/brokers/:id/history", {
      params: { id: "1" },
      user: { username: "broker2", role: 3, brokerId: 2 },
    });
    eq(r.status, 403, "status");
  });

  await check("empty history returns an empty page", async () => {
    const r = await call("get", "/brokers/:id/history", {
      params: { id: "1" },
      query: WINDOW,
    });
    eq(r.status, 200, "status");
    eq(r.body.total, 0, "total");
    eq(r.body.totalPages, 1, "totalPages");
    eq(r.body.movements, [], "movements");
    eq(r.body.broker.Name, "Alpha", "broker name");
    eq(r.body.broker.CashBalance, 70, "broker balance");
  });

  await check("movements are newest first with a correct running balance", async () => {
    resetDb();
    addMovement(1, -10, "2026-10-05 10:00:00", { Type: "policy", BlancNumber: "100001" });
    addMovement(1, 100, "2026-10-10 12:00:00", { Type: "increase" });
    addMovement(1, -20, "2026-10-20 09:00:00", { Type: "policy", BlancNumber: "100002" });

    const r = await call("get", "/brokers/:id/history", {
      params: { id: "1" },
      query: WINDOW,
    });
    eq(r.status, 200, "status");
    eq(r.body.total, 3, "total");

    const ms = r.body.movements;
    eq(ms.length, 3, "3 movements");
    eq(ms[0].CreatedAt, "2026-10-20 09:00:00", "newest first");
    eq(ms[0].Amount, -20, "amount");
    eq(ms[0].BalanceAfter, 70, "running balance after newest");
    eq(ms[1].BalanceAfter, 90, "running balance after middle");
    eq(ms[2].BalanceAfter, -10, "running balance after oldest");
    eq(ms[2].BlancNumber, "100001", "policy carries its blanc number");
    eq(r.body.netChange, 70, "net change");
    eq(r.body.balanceAtStart, 0, "balance at window start");
  });

  await check("movements outside the requested window are ignored", async () => {
    resetDb();
    addMovement(1, 10, "2026-09-30 23:59:59");
    addMovement(1, 20, "2026-10-15 00:00:00");
    addMovement(1, 30, "2026-11-01 00:00:00");

    const r = await call("get", "/brokers/:id/history", {
      params: { id: "1" },
      query: WINDOW,
    });
    eq(r.body.total, 1, "only the in-window movement");
    eq(r.body.movements[0].Amount, 20, "in-window amount");
  });

  await check("pagination returns 40 per page by default", async () => {
    resetDb();
    for (let i = 0; i < 90; i++) addMovement(2, i + 1, dt(new Date(2026, 9, 1, 0, i, 0)));

    const page1 = await call("get", "/brokers/:id/history", {
      params: { id: "2" },
      query: WINDOW,
    });
    eq(page1.body.total, 90, "total");
    eq(page1.body.totalPages, 3, "3 pages");
    eq(page1.body.movements.length, 40, "40 on page 1");
    eq(page1.body.pageSize, 40, "default page size");

    const page3 = await call("get", "/brokers/:id/history", {
      params: { id: "2" },
      query: { ...WINDOW, page: "3" },
    });
    eq(page3.body.movements.length, 10, "10 on page 3");
  });

  await check("page size is clamped and an explicit page is honoured", async () => {
    resetDb();
    for (let i = 0; i < 90; i++) addMovement(2, i + 1, dt(new Date(2026, 9, 1, 0, i, 0)));
    const r = await call("get", "/brokers/:id/history", {
      params: { id: "2" },
      query: { ...WINDOW, page: "1", pageSize: "1000" },
    });
    eq(r.body.pageSize, 100, "clamped to 100");
    eq(r.body.totalPages, 1, "single page when clamped");
    eq(r.body.movements.length, 90, "all movements on one page");
  });

  await check("default window is the last 30 days", async () => {
    resetDb();
    addMovement(1, 10, dt(new Date(Date.now() - 1000)));
    addMovement(1, 99, dt(new Date(Date.now() - 40 * 86400000)));

    const r = await call("get", "/brokers/:id/history", { params: { id: "1" } });
    eq(r.status, 200, "status");
    ok(r.body.since && r.body.until, "window bounds returned");
    eq(r.body.total, 1, "only the recent movement is inside the window");
    eq(r.body.movements[0].Amount, 10, "recent movement returned");
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();