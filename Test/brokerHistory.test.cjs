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
    Deleted: extra.Deleted ? 1 : 0,
    DeletedAt: extra.DeletedAt === undefined ? null : extra.DeletedAt,
    DeletedBy: extra.DeletedBy === undefined ? null : extra.DeletedBy,
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

// Faithful copies of CurrentCash.js's exported helpers (Brokers.js now depends
// on them for stamping broker movements in the client's local time).
function parseClientDateTime(value) {
  if (typeof value !== "string") return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number);
  const t = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
  if (
    t.getUTCFullYear() !== y ||
    t.getUTCMonth() !== mo - 1 ||
    t.getUTCDate() !== d ||
    t.getUTCHours() !== h ||
    t.getUTCMinutes() !== mi ||
    t.getUTCSeconds() !== s
  ) {
    return null;
  }
  return `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}`;
}
function clientLocalDateTime(offsetMinutes, now = new Date()) {
  let offset = Number(offsetMinutes);
  if (!Number.isFinite(offset) || offset < -720 || offset > 840) offset = 0;
  const local = new Date(now.getTime() + Math.round(offset) * 60000);
  const p = (n) => String(n).padStart(2, "0");
  return (
    `${local.getUTCFullYear()}-${p(local.getUTCMonth() + 1)}-${p(local.getUTCDate())} ` +
    `${p(local.getUTCHours())}:${p(local.getUTCMinutes())}:${p(local.getUTCSeconds())}`
  );
}

async function query(sql, params = []) {
  const s = flat(sql);
  const p = params || [];

  if (s.startsWith("CREATE TABLE IF NOT EXISTS broker_balance_movements")) {
    return [{}];
  }
  if (s.startsWith("SELECT id, Name, CashBalance, ParentBrokerId, CutOff FROM brokers WHERE id = ?")) {
    return [db.brokers.filter((b) => b.id === Number(p[0]))];
  }
  if (
    s.startsWith(
      "SELECT COUNT(*) AS total, COALESCE(SUM(Amount), 0) AS net FROM broker_balance_movements"
    )
  ) {
    const rows = db.movements.filter(
      (m) => m.BrokerId === Number(p[0]) && m.CreatedAt >= p[1] && m.CreatedAt < p[2] && m.Deleted !== 1
    );
    return [[
      { total: rows.length, net: rows.reduce((sum, m) => sum + Number(m.Amount), 0) },
    ]];
  }
  if (s.startsWith("SELECT t.id, t.Type, t.Amount")) {
    const balance = Number(p[0]);
    const rows = db.movements
      .filter(
        (m) => m.BrokerId === Number(p[1]) && m.CreatedAt >= p[2] && m.CreatedAt < p[3] && m.Deleted !== 1
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
  // --- admin edit / delete of a single movement (PATCH / DELETE history) -----
  if (s.startsWith("SELECT id, BrokerId, Amount, Type, Reason, Author, BlancNumber")) {
    const mov = db.movements.find(
      (m) => m.id === Number(p[0]) && m.BrokerId === Number(p[1]) && m.Deleted !== 1
    );
    return [mov ? [mov] : []];
  }
  if (s.startsWith("SELECT id, Amount, Deleted FROM broker_balance_movements")) {
    const mov = db.movements.find(
      (m) => m.id === Number(p[0]) && m.BrokerId === Number(p[1])
    );
    return [mov ? [{ id: mov.id, Amount: mov.Amount, Deleted: mov.Deleted }] : []];
  }
  if (
    s.startsWith(
      "SELECT id, Type, Amount, Reason, Author, BlancNumber, CreatedAt, DeletedAt, DeletedBy"
    )
  ) {
    const rows = db.movements
      .filter((m) => m.BrokerId === Number(p[0]) && m.Deleted === 1)
      .sort((a, b) =>
        a.CreatedAt === b.CreatedAt
          ? b.id - a.id
          : a.CreatedAt < b.CreatedAt
            ? 1
            : -1
      );
    return [rows];
  }
  if (s.startsWith("UPDATE broker_balance_movements SET")) {
    const m = /^UPDATE broker_balance_movements SET (.+?) WHERE id = \?$/.exec(s);
    const cols = m[1].split(",").map((x) => x.trim().split(/\s+/)[0]);
    const movementId = Number(p[p.length - 1]);
    const mov = db.movements.find((x) => x.id === movementId);
    if (mov) cols.forEach((col, i) => (mov[col] = p[i]));
    return [{ affectedRows: mov ? 1 : 0 }];
  }
  if (s.startsWith("UPDATE brokers SET CashBalance")) {
    const broker = db.brokers.find((b) => b.id === Number(p[1]));
    if (broker) {
      broker.CashBalance =
        Math.round((Number(broker.CashBalance) + Number(p[0])) * 100) / 100;
    }
    return [{ affectedRows: broker ? 1 : 0 }];
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
    clientLocalDateTime,
    parseClientDateTime,
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

    const tzOffset = String(-new Date().getTimezoneOffset());
    const r = await call("get", "/brokers/:id/history", {
      params: { id: "1" },
      query: { tzOffset },
    });
    eq(r.status, 200, "status");
    ok(r.body.since && r.body.until, "window bounds returned");
    eq(r.body.total, 1, "only the recent movement is inside the window");
    eq(r.body.movements[0].Amount, 10, "recent movement returned");
  });

  await check("history PATCH: invalid broker id is rejected", async () => {
    const r = await call("patch", "/brokers/:id/history/:movementId", {
      params: { id: "abc", movementId: "1" },
      body: { reason: "x" },
    });
    eq(r.status, 400, "status");
  });

  await check("history PATCH: invalid movement id is rejected", async () => {
    const r = await call("patch", "/brokers/:id/history/:movementId", {
      params: { id: "1", movementId: "nope" },
      body: { reason: "x" },
    });
    eq(r.status, 400, "status");
  });

  await check("history PATCH: unknown movement answers 404", async () => {
    resetDb();
    const r = await call("patch", "/brokers/:id/history/:movementId", {
      params: { id: "1", movementId: "999" },
      body: { reason: "x" },
    });
    eq(r.status, 404, "status");
  });

  await check("history PATCH: another broker's movement answers 404", async () => {
    resetDb();
    addMovement(2, 5, "2026-10-10 00:00:00");
    const r = await call("patch", "/brokers/:id/history/:movementId", {
      params: { id: "1", movementId: "1" },
      body: { reason: "x" },
    });
    eq(r.status, 404, "status");
  });

  await check("history PATCH: zero or non-numeric amount is rejected", async () => {
    resetDb();
    addMovement(1, 10, "2026-10-10 00:00:00");
    for (const bad of [0, "0", "abc", ""]) {
      const r = await call("patch", "/brokers/:id/history/:movementId", {
        params: { id: "1", movementId: "1" },
        body: { amount: bad },
      });
      eq(r.status, 400, `amount ${JSON.stringify(bad)}`);
    }
    eq(db.movements[0].Amount, 10, "movement untouched");
  });

  await check("history PATCH: an empty body is rejected", async () => {
    resetDb();
    addMovement(1, 10, "2026-10-10 00:00:00");
    const r = await call("patch", "/brokers/:id/history/:movementId", {
      params: { id: "1", movementId: "1" },
      body: {},
    });
    eq(r.status, 400, "status");
  });

  await check("history PATCH: amount change shifts the broker balance by the delta", async () => {
    resetDb();
    addMovement(1, -10, "2026-10-10 00:00:00", {
      Type: "policy",
      BlancNumber: "100001",
      Reason: "old",
    });
    const r = await call("patch", "/brokers/:id/history/:movementId", {
      params: { id: "1", movementId: "1" },
      body: { amount: -25, reason: "corrected", author: "admin1" },
    });
    eq(r.status, 200, "status");
    eq(r.body.message, "Movement updated", "message");
    eq(db.movements[0].Amount, -25, "stored amount");
    eq(db.movements[0].Reason, "corrected", "stored reason");
    eq(db.movements[0].Author, "admin1", "stored author");
    eq(db.movements[0].BlancNumber, "100001", "blanc number kept");
    // delta = -25 - (-10) = -15 → 70 - 15 = 55.
    eq(db.brokers[0].CashBalance, 55, "broker balance shifted by the delta");
    eq(r.body.broker.CashBalance, 55, "returned broker balance");
  });

  await check("history DELETE: soft-deletes the movement and reverses the balance", async () => {
    resetDb();
    addMovement(1, -10, "2026-10-10 00:00:00");
    const r = await call("delete", "/brokers/:id/history/:movementId", {
      params: { id: "1", movementId: "1" },
    });
    eq(r.status, 200, "status");
    eq(r.body.message, "Movement deleted", "message");
    eq(db.movements.length, 1, "row is kept, not physically removed");
    eq(db.movements[0].Deleted, 1, "flagged deleted");
    eq(db.movements[0].DeletedBy, "admin1", "deleted by recorded");
    ok(db.movements[0].DeletedAt, "deleted at recorded");
    // reversal = -(-10) = +10 → 70 + 10 = 80.
    eq(db.brokers[0].CashBalance, 80, "balance reversed");
    eq(r.body.broker.CashBalance, 80, "returned balance");
  });

  await check("history DELETE: a deleted movement cannot be deleted again", async () => {
    resetDb();
    addMovement(1, -10, "2026-10-10 00:00:00", { Deleted: true, DeletedBy: "admin1" });
    const r = await call("delete", "/brokers/:id/history/:movementId", {
      params: { id: "1", movementId: "1" },
    });
    eq(r.status, 400, "status");
    eq(r.body.error, "Movement already deleted", "error");
  });

  await check("history DELETE: unknown movement answers 404", async () => {
    resetDb();
    const r = await call("delete", "/brokers/:id/history/:movementId", {
      params: { id: "1", movementId: "123" },
    });
    eq(r.status, 404, "status");
  });

  await check("history restore: brings a deleted movement back and re-applies the balance", async () => {
    resetDb();
    addMovement(1, -10, "2026-10-10 00:00:00");
    await call("delete", "/brokers/:id/history/:movementId", {
      params: { id: "1", movementId: "1" },
    });
    eq(db.brokers[0].CashBalance, 80, "precondition: reversed");
    const r = await call("post", "/brokers/:id/history/:movementId/restore", {
      params: { id: "1", movementId: "1" },
    });
    eq(r.status, 200, "status");
    eq(r.body.message, "Movement restored", "message");
    eq(db.movements[0].Deleted, 0, "flag cleared");
    eq(db.movements[0].DeletedAt, null, "DeletedAt cleared");
    eq(db.movements[0].DeletedBy, null, "DeletedBy cleared");
    eq(db.brokers[0].CashBalance, 70, "balance re-applied");
    eq(r.body.broker.CashBalance, 70, "returned balance");
  });

  await check("history restore: a live movement cannot be restored", async () => {
    resetDb();
    addMovement(1, -10, "2026-10-10 00:00:00");
    const r = await call("post", "/brokers/:id/history/:movementId/restore", {
      params: { id: "1", movementId: "1" },
    });
    eq(r.status, 400, "status");
    eq(r.body.error, "Movement is not deleted", "error");
  });

  await check("history GET: soft-deleted movements are excluded from the live list", async () => {
    resetDb();
    addMovement(1, -10, "2026-10-10 00:00:00");
    addMovement(1, 20, "2026-10-12 00:00:00");
    db.movements[0].Deleted = 1;
    db.brokers[0].CashBalance = 80; // 70 + 10 reversed.
    const r = await call("get", "/brokers/:id/history", {
      params: { id: "1" },
      query: WINDOW,
    });
    eq(r.status, 200, "status");
    eq(r.body.total, 1, "only the live movement counts");
    eq(r.body.movements.length, 1, "only the live movement returned");
    eq(r.body.movements[0].Amount, 20, "live movement");
    eq(r.body.netChange, 20, "net excludes the deleted movement");
  });

  await check("history GET: an admin can list deleted movements with includeDeleted", async () => {
    resetDb();
    addMovement(1, -10, "2026-10-10 00:00:00");
    db.movements[0].Deleted = 1;
    db.movements[0].DeletedBy = "admin1";
    db.movements[0].DeletedAt = "2026-10-11 09:00:00";
    db.brokers[0].CashBalance = 80;
    const r = await call("get", "/brokers/:id/history", {
      params: { id: "1" },
      query: { ...WINDOW, includeDeleted: "1" },
    });
    eq(r.status, 200, "status");
    eq(r.body.includeDeleted, true, "flag echoed");
    eq(r.body.deleted.length, 1, "one deleted movement listed");
    eq(r.body.deleted[0].Amount, -10, "deleted amount");
    eq(r.body.deleted[0].DeletedBy, "admin1", "deleted by");
    eq(r.body.movements.length, 0, "live list still empty");
  });

  await check("history GET: includeDeleted is ignored for non-admins", async () => {
    resetDb();
    addMovement(1, -10, "2026-10-10 00:00:00");
    db.movements[0].Deleted = 1;
    db.brokers[0].CashBalance = 80;
    const r = await call("get", "/brokers/:id/history", {
      params: { id: "1" },
      query: { ...WINDOW, includeDeleted: "1" },
      user: { username: "worker1", role: 2 },
    });
    eq(r.status, 200, "status");
    eq(r.body.includeDeleted, false, "flag off for non-admin");
    eq(r.body.deleted.length, 0, "no deleted list for non-admin");
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();