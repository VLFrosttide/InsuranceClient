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
    // Live policies, used by the history endpoint to price each movement and to
    // tell whether its policy was annulled.
    policies: [],
    // Stored starting balances, one per broker id (the balance before the
    // broker's first insurance).
    startingBalances: {},
    // Money the broker paid, one row per payment (the balance formula reads
    // this table, never the ledger).
    payments: [],
    nextPayment: 1,
    nextMovement: 1,
  };
}

const flat = (s) => String(s).replace(/\s+/g, " ").trim();

function addMovement(brokerId, amount, createdAt, extra = {}) {
  const id = db.nextMovement++;
  db.movements.push({
    id,
    BrokerId: brokerId,
    Amount: amount,
    Type: extra.Type || "increase",
    Reason: extra.Reason || "",
    Recipient: extra.Recipient === undefined ? null : extra.Recipient,
    Author: extra.Author || "",
    BlancNumber: extra.BlancNumber === undefined ? null : extra.BlancNumber,
    CreatedAt: createdAt,
    Deleted: extra.Deleted ? 1 : 0,
    DeletedAt: extra.DeletedAt === undefined ? null : extra.DeletedAt,
    DeletedBy: extra.DeletedBy === undefined ? null : extra.DeletedBy,
    Branch: extra.Branch === undefined ? null : extra.Branch,
    Currency: extra.Currency || "EUR",
  });
  // The real server writes a payment to BOTH tables in the same transaction; the
  // balance formula only reads this one.
  const type = String(extra.Type || "increase").trim();
  if (type === "increase" || type === "handover") {
    db.payments.push({
      id: db.nextPayment++,
      BrokerId: brokerId,
      Amount: amount,
      Type: type,
      Reason: extra.Reason || "",
      Recipient: extra.Recipient === undefined ? null : extra.Recipient,
      Author: extra.Author || "",
      Branch: extra.Branch === undefined ? null : extra.Branch,
      Currency: extra.Currency || "EUR",
      CreatedAt: createdAt,
      MovementId: id,
      Deleted: extra.Deleted ? 1 : 0,
    });
  }
  return id;
}

function addPolicy(blancNumber, extra = {}) {
  db.policies.push({
    BlancNumber: blancNumber,
    Price: extra.Price === undefined ? null : extra.Price,
    OriginalPrice: extra.OriginalPrice === undefined ? null : extra.OriginalPrice,
    Annulled: extra.Annulled ? 1 : 0,
    AnnulReason: extra.AnnulReason === undefined ? null : extra.AnnulReason,
    AnnulFee: extra.AnnulFee === undefined ? null : extra.AnnulFee,
    BrokerId: extra.BrokerId === undefined ? null : extra.BrokerId,
    Deleted: extra.Deleted ? 1 : 0,
  });
}

// The LEFT JOIN insurance fields the real query selects for one movement.
function policyFields(blancNumber) {
  const key = String(blancNumber ?? "").trim();
  const policy = key
    ? db.policies.find(
        (p) => String(p.BlancNumber) === key && p.Deleted !== 1
      )
    : null;
  if (!policy) {
    return {
      PolicyAnnulled: null,
      PolicyAnnulReason: null,
      PolicyBrokerId: null,
    };
  }
  return {
    PolicyAnnulled: policy.Annulled,
    PolicyAnnulReason: policy.AnnulReason,
    PolicyBrokerId: policy.BrokerId,
  };
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
  if (s.startsWith("CREATE TABLE IF NOT EXISTS broker_starting_balances")) {
    return [{}];
  }
  if (
    s.startsWith(
      "SELECT Amount, EffectiveDate, UpdatedBy, UpdatedAt FROM broker_starting_balances WHERE BrokerId = ?"
    )
  ) {
    const row = db.startingBalances[String(Number(p[0]))];
    return [row ? [row] : []];
  }
  if (s.startsWith("INSERT INTO broker_starting_balances")) {
    const [brokerId, amount, effectiveDate, updatedBy] = p;
    db.startingBalances[String(Number(brokerId))] = {
      Amount: Number(amount),
      EffectiveDate: effectiveDate,
      UpdatedBy: updatedBy,
      UpdatedAt: "2026-11-20 10:00:00",
    };
    return [{ affectedRows: 1 }];
  }
  // The recalculation reads the source data: every live insurance of the broker
  // (an annulled one at its tax) ...
  if (s.startsWith("SELECT COALESCE(SUM(") && s.includes("AS Charged")) {
    const rows = db.policies.filter(
      (x) => Number(x.BrokerId) === Number(p[0]) && x.Deleted !== 1
    );
    const charged = rows.reduce((sum, x) => {
      const price = Number(x.Price) || 0;
      if (!x.Annulled) return sum + price;
      // An annulled policy is charged its tax only when the broker paid it; a
      // worker/no-fault annulment refunded the full price.
      if (String(x.AnnulReason || "").trim().toLowerCase() !== "broker") {
        return sum;
      }
      const fee =
        x.AnnulFee === null || x.AnnulFee === undefined ? null : Number(x.AnnulFee);
      return sum + (fee === null ? price : fee);
    }, 0);
    return [[{ Charged: charged }]];
  }
  // ... plus the payments only (top-ups and hand-overs; a reduce or an adjust
  // row is not money the broker paid).
  if (s.startsWith("SELECT COALESCE(SUM(Amount), 0) AS Paid")) {
    const rows = db.movements.filter(
      (m) =>
        m.BrokerId === Number(p[0]) &&
        m.Deleted !== 1 &&
        ["increase", "handover"].includes(String(m.Type || "").trim())
    );
    return [[{ Paid: rows.reduce((sum, m) => sum + Number(m.Amount), 0) }]];
  }
  if (s.startsWith("SELECT id, Name, Code, CashBalance, ParentBrokerId, CutOff FROM brokers WHERE id = ?")) {
    return [db.brokers.filter((b) => b.id === Number(p[0]))];
  }
  if (
    s.startsWith(
      "SELECT MIN(CreatedAt) AS FirstMovement FROM broker_balance_movements"
    )
  ) {
    const rows = db.movements
      .filter((m) => m.BrokerId === Number(p[0]) && m.Deleted !== 1)
      .sort((a, b) =>
        a.CreatedAt < b.CreatedAt ? -1 : a.CreatedAt > b.CreatedAt ? 1 : 0
      );
    return [[{ FirstMovement: rows.length ? rows[0].CreatedAt : null }]];
  }
  if (
    s.startsWith(
      "SELECT COALESCE(SUM(Amount), 0) AS net FROM broker_balance_movements WHERE BrokerId = ? AND CreatedAt >= ? AND Deleted = 0"
    )
  ) {
    const rows = db.movements.filter(
      (m) =>
        m.BrokerId === Number(p[0]) && m.CreatedAt >= p[1] && m.Deleted !== 1
    );
    return [[
      { net: rows.reduce((sum, m) => sum + Number(m.Amount), 0) },
    ]];
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
  if (s.startsWith("SELECT m.id, m.Type, m.Amount, m.Reason, m.Author")) {
    // The history endpoint reads the whole live ledger (it merges annulled
    // policies before filtering/paginating), so no date window or LIMIT here.
    const rows = db.movements
      .filter((m) => m.BrokerId === Number(p[0]) && m.Deleted !== 1)
      .sort((a, b) =>
        a.CreatedAt === b.CreatedAt
          ? b.id - a.id
          : a.CreatedAt < b.CreatedAt
            ? 1
            : -1
      )
      .map((m) => ({ ...m, ...policyFields(m.BlancNumber) }));
    return [rows];
  }
  // --- admin edit / delete of a single movement (PATCH / DELETE history) -----
  if (s.startsWith("SELECT id, BrokerId, Amount, Type, Reason, Author, BlancNumber")) {
    const mov = db.movements.find(
      (m) => m.id === Number(p[0]) && m.BrokerId === Number(p[1]) && m.Deleted !== 1
    );
    return [mov ? [mov] : []];
  }
  if (s.startsWith("SELECT id, Amount, Type, Deleted FROM broker_balance_movements")) {
    const mov = db.movements.find(
      (m) => m.id === Number(p[0]) && m.BrokerId === Number(p[1])
    );
    return [
      mov
        ? [{ id: mov.id, Amount: mov.Amount, Type: mov.Type, Deleted: mov.Deleted }]
        : [],
    ];
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
  if (s.startsWith("UPDATE brokers SET CashBalance = ? WHERE id = ?")) {
    const broker = db.brokers.find((b) => b.id === Number(p[1]));
    if (broker) broker.CashBalance = Math.round(Number(p[0]) * 100) / 100;
    return [{ affectedRows: broker ? 1 : 0 }];
  }
  if (s.startsWith("UPDATE brokers SET CashBalance")) {
    const broker = db.brokers.find((b) => b.id === Number(p[1]));
    if (broker) {
      broker.CashBalance =
        Math.round((Number(broker.CashBalance) + Number(p[0])) * 100) / 100;
    }
    return [{ affectedRows: broker ? 1 : 0 }];
  }
  if (
    s.startsWith(
      "SELECT BlancNumber, Duration, Otomobil, PaymentType, NonTurk, CardFee, Annulled, AnnulReason, AnnulFee, CreationDate FROM insurance"
    )
  ) {
    // The sub-broker display data reads its own policies (display prices only).
    return [
      db.policies.filter(
        (x) => Number(x.BrokerId) === Number(p[0]) && x.Deleted !== 1
      ),
    ];
  }
  if (
    s === "SELECT BlancNumber FROM insurance WHERE BrokerId = ? AND Deleted = 0"
  ) {
    // The history keeps only the rows of policies that still exist for the
    // broker (a deleted or moved-away policy takes its charge history with it).
    // A test that records only movements (no policy rows) keeps them: the old
    // ledger is then the only source of blanc numbers.
    const policies = db.policies
      .filter((x) => Number(x.BrokerId) === Number(p[0]) && x.Deleted !== 1)
      .map((x) => ({ BlancNumber: x.BlancNumber }));
    if (policies.length) return [policies];
    return [
      db.movements
        .filter((m) => Number(m.BrokerId) === Number(p[0]) && m.BlancNumber)
        .map((m) => ({ BlancNumber: m.BlancNumber })),
    ];
  }
  if (
    s.startsWith(
      "SELECT COALESCE(SUM(m.Amount), 0) AS Voided FROM broker_balance_movements m JOIN insurance i"
    )
  ) {
    // Policy rows an admin soft-deleted (VOIDs) of a live policy.
    const live = new Set(
      db.policies
        .filter((x) => Number(x.BrokerId) === Number(p[0]) && x.Deleted !== 1)
        .map((x) => String(x.BlancNumber ?? "").trim())
    );
    const rows = db.movements.filter(
      (m) =>
        Number(m.BrokerId) === Number(p[0]) &&
        Number(m.Deleted) === 1 &&
        ["policy", "price_change", "annulment", "deletion"].includes(
          String(m.Type || "").trim()
        ) &&
        live.has(String(m.BlancNumber ?? "").trim())
    );
    return [[{ Voided: rows.reduce((sum, m) => sum + Number(m.Amount || 0), 0) }]];
  }
  if (
    s.startsWith(
      "SELECT Type, Amount FROM broker_balance_movements WHERE BrokerId = ? AND Deleted = 0 AND Type NOT IN"
    )
  ) {
    const rows = db.movements.filter(
      (m) =>
        m.BrokerId === Number(p[0]) &&
        m.Deleted !== 1 &&
        !["policy", "annulment", "price_change", "deletion", "reduce", "adjust"].includes(
          String(m.Type || "").trim()
        )
    );
    return [rows];
  }
  if (
    s.startsWith(
      "SELECT Amount FROM broker_starting_balances WHERE BrokerId = ?"
    )
  ) {
    const row = db.startingBalances[String(Number(p[0]))];
    return [row ? [{ Amount: row.Amount }] : []];
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
  // The real db/brokerPayments.js, against this fake database: the balance
  // formula reads ONLY these rows for money the broker paid.
  "../db/brokerPayments.js": {
    ensureBrokerPaymentsTable: async () => {},
    sumBrokerPayments: async (_conn, brokerId) => {
      const rows = db.payments.filter(
        (p) =>
          Number(p.BrokerId) === Number(brokerId) &&
          p.Deleted !== 1 &&
          ["increase", "handover"].includes(String(p.Type || "").trim())
      );
      return (
        Math.round(rows.reduce((sum, p) => sum + Number(p.Amount), 0) * 100) /
        100
      );
    },
    recordBrokerPayment: async (_conn, brokerId, amount, type, meta = {}) => {
      const movementId = addMovement(brokerId, amount, meta.createdAt || "", {
        Type: type,
        Reason: meta.reason,
        Author: meta.author,
        Branch: meta.branch,
        Currency: meta.currency,
      });
      return { id: movementId, amount };
    },
    syncBrokerPaymentFromMovement: async (_conn, change = {}) => {
      const row = db.payments.find(
        (p) => Number(p.MovementId) === Number(change.movementId)
      );
      const type = String(change.type || "").trim();
      const isPayment = type === "increase" || type === "handover";
      if (!row) {
        if (!isPayment) return;
        db.payments.push({
          id: db.nextPayment++,
          BrokerId: Number(change.brokerId),
          Amount: Number(change.amount) || 0,
          Type: type,
          Reason: change.reason || "",
          Recipient: change.recipient === undefined ? null : change.recipient,
          Author: change.author || "",
          Branch: change.branch === undefined ? null : change.branch,
          Currency: change.currency || "EUR",
          CreatedAt: change.createdAt || "",
          MovementId: Number(change.movementId),
          Deleted: change.deleted ? 1 : 0,
        });
        return;
      }
      if (!isPayment) {
        row.Deleted = 1;
        return;
      }
      row.Amount = Number(change.amount) || 0;
      row.Type = type;
      if (change.reason !== undefined) row.Reason = change.reason;
      if (change.recipient !== undefined) row.Recipient = change.recipient;
      if (change.author !== undefined) row.Author = change.author;
      if (change.createdAt !== undefined) row.CreatedAt = change.createdAt;
      row.Deleted = change.deleted ? 1 : 0;
    },
  },
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
const STARTING_BALANCE = "/brokers/:id/starting-balance";
resetDb();

(async () => {
  await check("the history query joins the live policy and merges its annulment", async () => {
    const src = fs.readFileSync(BROKERS_JS, "utf8");
    ok(
      src.includes("LEFT JOIN insurance i") &&
        src.includes("i.Annulled AS PolicyAnnulled") &&
        src.includes("i.AnnulReason AS PolicyAnnulReason") &&
        src.includes("i.BrokerId AS PolicyBrokerId"),
      "the movements query joins the policy state and owner"
    );
    ok(
      src.includes("hiddenMovements") &&
        src.includes('=== "annulment"') &&
        src.includes('=== "price_change"') &&
        src.includes('"broker change"'),
      "price edits and the refund are folded, and moved-away policies are dropped"
    );
  });

  await check("a broker balance can no longer be reduced by hand", async () => {
    const src = fs.readFileSync(BROKERS_JS, "utf8");
    // The route is gone; only the explanation stays. Old "reduce" rows are
    // history: they are never deleted and the recalculation ignores them.
    ok(
      !src.includes('"/brokers/:id/reduce"'),
      "the reduce route is not registered"
    );
    ok(
      src.includes("There is deliberately NO POST /brokers/:id/reduce"),
      "the removal is documented"
    );
    ok(
      src.includes("AND Type IN ('increase', 'handover')"),
      "only increases and hand-overs count as payments"
    );
  });

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
    eq(r.body.balanceAtEnd, 70, "the window ends with the current balance");
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
    eq(r.body.balanceAtEnd, 70, "balance at the window end");
  });

  await check("the history returns who received a hand-over", async () => {
    resetDb();
    addMovement(1, 50, "2026-10-15 10:00:00", {
      Type: "handover",
      Recipient: "Owner",
    });

    const r = await call("get", "/brokers/:id/history", {
      params: { id: "1" },
      query: WINDOW,
    });
    eq(r.status, 200, "status");
    eq(r.body.movements.length, 1, "one movement");
    eq(r.body.movements[0].Recipient, "Owner", "the recipient is returned");
  });

  await check("an annulled policy's sale shows its tax and its refund row disappears", async () => {
    resetDb();
    addPolicy("100001", { Price: 35 });
    addPolicy("100002", {
      Price: 9,
      OriginalPrice: 35,
      Annulled: 1,
      AnnulReason: "broker",
      AnnulFee: 9,
    });
    addMovement(1, -35, "2026-10-05 10:00:00", {
      Type: "policy",
      BlancNumber: "100001",
    });
    addMovement(1, -35, "2026-10-06 10:00:00", {
      Type: "policy",
      BlancNumber: "100002",
    });
    addMovement(1, 26, "2026-10-07 10:00:00", {
      Type: "annulment",
      BlancNumber: "100002",
    });
    addMovement(1, -20, "2026-10-08 10:00:00", {
      Type: "policy",
      BlancNumber: "100003",
    });
    addMovement(1, 50, "2026-10-09 10:00:00", { Type: "increase" });

    const r = await call("get", "/brokers/:id/history", {
      params: { id: "1" },
      query: WINDOW,
    });
    eq(r.status, 200, "status");
    eq(r.body.total, 4, "the refund row is not a separate movement");
    ok(
      !r.body.movements.some((m) => m.Type === "annulment"),
      "the refund row disappeared"
    );

    const byBlanc = (blanc) =>
      r.body.movements.filter((m) => m.BlancNumber === blanc);

    const active = byBlanc("100001")[0];
    eq(active.Amount, -35, "an active policy keeps its sale price");
    eq(active.PolicyAnnulled, false, "an active policy is not annulled");

    const annulled = byBlanc("100002");
    eq(annulled.length, 1, "sale and refund are one row");
    eq(annulled[0].Amount, -9, "that row shows the annulment tax");
    eq(annulled[0].PolicyAnnulled, true, "the annulled flag is carried");
    eq(annulled[0].PolicyAnnulReason, "broker", "who paid the tax is carried");

    const orphan = byBlanc("100003")[0];
    eq(orphan.Amount, -20, "a movement with no live policy is untouched");
    eq(orphan.PolicyAnnulled, false, "and is not annulled");

    const manual = r.body.movements.find((m) => m.Type === "increase");
    eq(manual.Amount, 50, "a manual increase is untouched");
    eq(manual.PolicyAnnulled, false, "a manual increase is not annulled");

    // Merging preserves the money: -35 - 35 + 26 - 20 + 50 = -14.
    eq(r.body.netChange, -14, "net change is unchanged by the merge");
    eq(r.body.balanceAtEnd, 70, "the end balance is unchanged");
    eq(r.body.balanceAtStart, 84, "the start balance matches the displayed rows");
    eq(annulled[0].BalanceAfter, 40, "the running balance uses the tax row");
  });

  await check("a price edit silently changes the sale row", async () => {
    resetDb();
    addPolicy("100010", { Price: 35, Annulled: 0 });
    addMovement(1, -30, "2026-10-05 10:00:00", {
      Type: "policy",
      BlancNumber: "100010",
    });
    addMovement(1, -5, "2026-10-06 10:00:00", {
      Type: "price_change",
      BlancNumber: "100010",
    });

    const r = await call("get", "/brokers/:id/history", {
      params: { id: "1" },
      query: WINDOW,
    });
    eq(r.body.total, 1, "the price edit is not a separate row");
    eq(r.body.movements[0].Type, "policy", "the original sale row stays");
    eq(r.body.movements[0].Amount, -35, "it now shows the new price");
    eq(r.body.movements[0].PolicyAnnulled, false, "the policy is not annulled");
    eq(r.body.netChange, -35, "the money is unchanged");
  });

  await check("a price decrease is folded into the sale too", async () => {
    resetDb();
    addPolicy("100011", { Price: 30, Annulled: 0 });
    addMovement(1, -35, "2026-10-05 10:00:00", {
      Type: "policy",
      BlancNumber: "100011",
    });
    addMovement(1, 5, "2026-10-06 10:00:00", {
      Type: "price_change",
      BlancNumber: "100011",
    });

    const r = await call("get", "/brokers/:id/history", {
      params: { id: "1" },
      query: WINDOW,
    });
    eq(r.body.total, 1, "one sale row");
    eq(r.body.movements[0].Amount, -30, "the sale row shows the lower price");
  });

  await check("a price edit followed by an annulment leaves one tax row", async () => {
    resetDb();
    addPolicy("100012", {
      Price: 9,
      OriginalPrice: 35,
      Annulled: 1,
      AnnulReason: "broker",
      AnnulFee: 9,
    });
    addMovement(1, -30, "2026-10-05 10:00:00", {
      Type: "policy",
      BlancNumber: "100012",
    });
    addMovement(1, -5, "2026-10-06 10:00:00", {
      Type: "price_change",
      BlancNumber: "100012",
    });
    addMovement(1, 26, "2026-10-07 10:00:00", {
      Type: "annulment",
      BlancNumber: "100012",
    });

    const r = await call("get", "/brokers/:id/history", {
      params: { id: "1" },
      query: WINDOW,
    });
    eq(r.body.total, 1, "one row for the insurance");
    eq(r.body.movements[0].Type, "policy", "the sale row stays");
    eq(r.body.movements[0].Amount, -9, "it shows the tax after the price edit");
    eq(r.body.movements[0].PolicyAnnulled, true, "it is tinted as annulled");
    eq(r.body.netChange, -9, "the tax is the only remaining charge");
  });

  await check("a policy moved to another broker disappears from the old broker", async () => {
    resetDb();
    // The policy now belongs to broker 2; broker 1 only holds the historical
    // sale and the cancellation written by the move.
    addPolicy("100013", { Price: 35, Annulled: 0, BrokerId: 2 });
    addMovement(1, -30, "2026-10-05 10:00:00", {
      Type: "policy",
      BlancNumber: "100013",
      Reason: "100013",
    });
    addMovement(1, -5, "2026-10-06 10:00:00", {
      Type: "price_change",
      BlancNumber: "100013",
      Reason: "Price change 100013",
    });
    addMovement(1, 35, "2026-10-07 10:00:00", {
      Type: "price_change",
      BlancNumber: "100013",
      Reason: "Broker change 100013",
    });

    const r = await call("get", "/brokers/:id/history", {
      params: { id: "1" },
      query: WINDOW,
    });
    eq(r.status, 200, "status");
    eq(r.body.total, 0, "the moved policy leaves no row behind");
    eq(r.body.movements, [], "neither the sale nor the cancellation is shown");
    eq(r.body.netChange, 0, "the pair nets to nothing");
    eq(r.body.balanceAtEnd, 70, "the end balance is unchanged");
    eq(r.body.balanceAtStart, 70, "and the whole window is unaffected");
  });

  await check("a policy moved back to the broker keeps its new charge", async () => {
    resetDb();
    addPolicy("100014", { Price: 35, Annulled: 0, BrokerId: 1 });
    addMovement(1, -30, "2026-10-05 10:00:00", {
      Type: "policy",
      BlancNumber: "100014",
      Reason: "100014",
    });
    addMovement(1, 30, "2026-10-06 10:00:00", {
      Type: "price_change",
      BlancNumber: "100014",
      Reason: "Broker change 100014",
    });
    addMovement(1, -35, "2026-10-07 10:00:00", {
      Type: "policy",
      BlancNumber: "100014",
      Reason: "100014",
    });

    const r = await call("get", "/brokers/:id/history", {
      params: { id: "1" },
      query: WINDOW,
    });
    eq(r.body.total, 2, "the old sale and the new charge are both here");
    eq(r.body.movements[0].Amount, -35, "the policy is charged at the broker again");
    eq(r.body.movements[1].Amount, 0, "the old side of the move nets to nothing");
    eq(r.body.netChange, -35, "the current charge survives");
  });

  await check("a worker-paid tax merges to a zero-cost sale row", async () => {
    resetDb();
    addPolicy("100004", {
      Price: 35,
      Annulled: 1,
      AnnulReason: "worker",
      AnnulFee: 9,
    });
    addMovement(1, -35, "2026-10-05 10:00:00", {
      Type: "policy",
      BlancNumber: "100004",
    });
    addMovement(1, 35, "2026-10-06 10:00:00", {
      Type: "annulment",
      BlancNumber: "100004",
    });

    const r = await call("get", "/brokers/:id/history", {
      params: { id: "1" },
      query: WINDOW,
    });
    eq(r.body.total, 1, "one merged row");
    eq(r.body.movements[0].Type, "policy", "the sale row stays");
    eq(r.body.movements[0].Amount, 0, "the broker paid no tax");
    eq(r.body.movements[0].PolicyAnnulled, true, "it is still annulled");
    eq(r.body.movements[0].PolicyAnnulReason, "worker", "the worker paid it");
    eq(r.body.netChange, 0, "no net charge");
  });

  await check("a restored policy keeps its historical sale and refund rows", async () => {
    resetDb();
    addPolicy("100005", { Price: 35, Annulled: 0 });
    addMovement(1, -35, "2026-10-05 10:00:00", {
      Type: "policy",
      BlancNumber: "100005",
    });
    addMovement(1, 35, "2026-10-06 10:00:00", {
      Type: "annulment",
      BlancNumber: "100005",
    });

    const r = await call("get", "/brokers/:id/history", {
      params: { id: "1" },
      query: WINDOW,
    });
    eq(r.body.total, 2, "both raw rows are still listed");
    eq(r.body.movements[0].Type, "annulment", "the refund row is kept");
    eq(r.body.movements[1].Amount, -35, "the sale is not changed");
    eq(r.body.movements[1].PolicyAnnulled, false, "the policy is active again");
  });

  await check("a deleted refund row is not merged", async () => {
    resetDb();
    addPolicy("100006", {
      Price: 9,
      OriginalPrice: 35,
      Annulled: 1,
      AnnulReason: "broker",
      AnnulFee: 9,
    });
    addMovement(1, -35, "2026-10-05 10:00:00", {
      Type: "policy",
      BlancNumber: "100006",
    });
    addMovement(1, 26, "2026-10-06 10:00:00", {
      Type: "annulment",
      BlancNumber: "100006",
      Deleted: true,
    });

    const r = await call("get", "/brokers/:id/history", {
      params: { id: "1" },
      query: WINDOW,
    });
    eq(r.body.total, 1, "only the live sale row");
    eq(r.body.movements[0].Amount, -35, "the deleted refund does not change it");
    eq(r.body.movements[0].PolicyAnnulled, true, "the policy is still annulled");
  });

  await check("a window holding only the refund still shows the tax balance", async () => {
    resetDb();
    db.brokers[0].CashBalance = -9;
    addPolicy("100007", {
      Price: 9,
      OriginalPrice: 35,
      Annulled: 1,
      AnnulReason: "broker",
      AnnulFee: 9,
    });
    addMovement(1, -35, "2026-09-01 10:00:00", {
      Type: "policy",
      BlancNumber: "100007",
    });
    addMovement(1, 26, "2026-10-10 10:00:00", {
      Type: "annulment",
      BlancNumber: "100007",
    });

    const r = await call("get", "/brokers/:id/history", {
      params: { id: "1" },
      query: WINDOW,
    });
    eq(r.body.total, 0, "the hidden refund leaves no row in this window");
    eq(r.body.netChange, 0, "an annulment is not a new money movement");
    eq(r.body.balanceAtEnd, -9, "the effective balance already includes the tax");
    eq(r.body.balanceAtStart, -9, "and did before the annulment too");
  });

  await check("merged rows are counted for pagination", async () => {
    resetDb();
    for (let i = 0; i < 30; i++) {
      const blanc = String(200000 + i);
      addPolicy(blanc, {
        Price: 2,
        OriginalPrice: 10,
        Annulled: 1,
        AnnulReason: "broker",
        AnnulFee: 2,
      });
      addMovement(1, -10, dt(new Date(2026, 9, 1, 0, i, 0)), {
        Type: "policy",
        BlancNumber: blanc,
      });
      addMovement(1, 8, dt(new Date(2026, 9, 2, 0, i, 0)), {
        Type: "annulment",
        BlancNumber: blanc,
      });
    }
    for (let i = 0; i < 15; i++) {
      addMovement(1, 1, dt(new Date(2026, 9, 3, 0, i, 0)), {
        Type: "increase",
      });
    }

    const page1 = await call("get", "/brokers/:id/history", {
      params: { id: "1" },
      query: WINDOW,
    });
    eq(page1.body.total, 45, "30 merged policies + 15 manual rows");
    eq(page1.body.totalPages, 2, "merged rows fit two pages");
    eq(page1.body.movements.length, 40, "page 1 is full");
    ok(
      !page1.body.movements.some((m) => m.Type === "annulment"),
      "no refund rows are counted"
    );

    const page2 = await call("get", "/brokers/:id/history", {
      params: { id: "1" },
      query: { ...WINDOW, page: "2" },
    });
    eq(page2.body.movements.length, 5, "page 2 has the rest");
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

  await check("default window covers the whole history", async () => {
    resetDb();
    const recent = dt(new Date(Date.now() - 1000));
    const old = dt(new Date(Date.now() - 400 * 86400000));
    addMovement(1, 10, recent);
    addMovement(1, 99, old);

    const tzOffset = String(-new Date().getTimezoneOffset());
    const r = await call("get", "/brokers/:id/history", {
      params: { id: "1" },
      query: { tzOffset },
    });
    eq(r.status, 200, "status");
    ok(r.body.since && r.body.until, "window bounds returned");
    eq(r.body.total, 2, "a movement from over a year back is inside the default window");
    eq(r.body.movements[0].Amount, 10, "recent movement returned");
    eq(r.body.movements[1].Amount, 99, "oldest movement returned");
    eq(r.body.since, old, "the window starts at the first movement");
  });

  await check("a past window shows the balance the broker had then", async () => {
    resetDb();
    addMovement(1, -10, "2026-10-05 10:00:00", { Type: "policy" });
    addMovement(1, 100, "2026-10-10 12:00:00", { Type: "increase" });
    addMovement(1, -20, "2026-10-20 09:00:00", { Type: "policy" });
    addMovement(1, 100, "2026-11-10 09:00:00", { Type: "increase" });
    db.brokers[0].CashBalance = 170; // 70 after October + 100 in November.

    const r = await call("get", "/brokers/:id/history", {
      params: { id: "1" },
      query: { since: "2026-10-01", until: "2026-10-16" },
    });
    eq(r.status, 200, "status");
    eq(r.body.total, 2, "only the movements up to the window end");
    eq(r.body.balanceAtEnd, 90, "balance at the end of the past window");
    eq(r.body.balanceAtStart, 0, "balance before the past window");
    eq(r.body.movements[0].BalanceAfter, 90, "running balance after the newest");
    eq(r.body.movements[1].BalanceAfter, -10, "running balance after the oldest");
    eq(r.body.broker.CashBalance, 170, "the current balance is untouched");
  });

  await check("walking the date back changes the displayed balance", async () => {
    resetDb();
    addMovement(1, 100, "2026-09-01 10:00:00", { Type: "increase" });
    addMovement(1, -30, "2026-09-15 10:00:00", { Type: "policy" });
    db.brokers[0].CashBalance = 70;

    const firstDay = await call("get", "/brokers/:id/history", {
      params: { id: "1" },
      query: { since: "2026-09-01", until: "2026-09-02" },
    });
    const laterDay = await call("get", "/brokers/:id/history", {
      params: { id: "1" },
      query: { since: "2026-09-15", until: "2026-09-16" },
    });
    eq(firstDay.body.balanceAtEnd, 100, "balance after the first day");
    eq(laterDay.body.balanceAtEnd, 70, "balance after the later day");
    ok(
      firstDay.body.balanceAtEnd !== laterDay.body.balanceAtEnd,
      "each day keeps its own balance"
    );
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

  await check("history PATCH: a retired row does not move the balance", async () => {
    resetDb();
    addMovement(1, -10, "2026-10-10 00:00:00", { Type: "reduce" });
    const r = await call("patch", "/brokers/:id/history/:movementId", {
      params: { id: "1", movementId: "1" },
      body: { amount: -25, reason: "corrected" },
    });
    eq(r.status, 200, "status");
    eq(db.movements[0].Amount, -25, "stored amount");
    eq(db.brokers[0].CashBalance, 70, "retired rows never shift the balance");
    eq(r.body.broker.CashBalance, 70, "returned balance unchanged");
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

  await check("history DELETE: a retired movement leaves the balance alone", async () => {
    resetDb();
    addMovement(1, -10, "2026-10-10 00:00:00", { Type: "reduce" });
    const r = await call("delete", "/brokers/:id/history/:movementId", {
      params: { id: "1", movementId: "1" },
    });
    eq(r.status, 200, "status");
    eq(db.movements[0].Deleted, 1, "flagged deleted");
    eq(db.brokers[0].CashBalance, 70, "retired rows are not reversed");
    eq(r.body.broker.CashBalance, 70, "returned balance unchanged");

    const restored = await call(
      "post",
      "/brokers/:id/history/:movementId/restore",
      { params: { id: "1", movementId: "1" } }
    );
    eq(restored.status, 200, "restore status");
    eq(db.movements[0].Deleted, 0, "flag cleared");
    eq(db.brokers[0].CashBalance, 70, "restore does not re-apply it either");
  });

  await check("history GET: retired rows are tagged and do not move the balance", async () => {
    resetDb();
    addMovement(1, 10, "2026-10-10 00:00:00", { Type: "increase" });
    addMovement(1, -5, "2026-10-11 00:00:00", { Type: "reduce" });
    addMovement(1, 3, "2026-10-12 00:00:00", { Type: "adjust" });

    const r = await call("get", "/brokers/:id/history", {
      params: { id: "1" },
      query: WINDOW,
    });
    eq(r.status, 200, "status");
    const byType = Object.fromEntries(
      r.body.movements.map((m) => [m.Type, m])
    );
    eq(byType.adjust.Retired, true, "adjust is retired");
    eq(byType.reduce.Retired, true, "reduce is retired");
    eq(byType.increase.Retired, false, "increase is live");
    eq(byType.reduce.Amount, -5, "the original amount is still shown");
    eq(r.body.netChange, 10, "only the increase counts");
    eq(r.body.movements[0].BalanceAfter, 70, "the newest retired row leaves the balance");
  });

  await check("history GET: a deleted retired row is tagged too", async () => {
    resetDb();
    addMovement(1, -10, "2026-10-10 00:00:00", {
      Type: "adjust",
      Deleted: true,
      DeletedBy: "admin1",
    });
    const r = await call("get", "/brokers/:id/history", {
      params: { id: "1" },
      query: { ...WINDOW, includeDeleted: "1" },
    });
    eq(r.status, 200, "status");
    eq(r.body.deleted[0].Retired, true, "the deleted list carries the tag");
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

  // --- starting balance (the balance before the first insurance) -------------

  await check("history GET: a broker without a starting balance reports null", async () => {
    resetDb();
    const r = await call("get", "/brokers/:id/history", {
      params: { id: "1" },
      query: WINDOW,
    });
    eq(r.status, 200, "status");
    eq(r.body.startingBalance, null, "nothing stored yet");
  });

  await check("starting balance: saving it recalculates the broker balance", async () => {
    resetDb();
    // Live insurances: one active at 30, one annulled with the worker paying its
    // 9 tax. The broker was refunded the full price of the annulled one, so only
    // the active policy is charged.
    addPolicy("100001", { Price: 30, BrokerId: 1 });
    addPolicy("100002", {
      Price: 9,
      OriginalPrice: 40,
      AnnulFee: 9,
      Annulled: true,
      AnnulReason: "worker",
      BrokerId: 1,
    });
    // Manual money: a top-up of 100 and a hand-over of 40.
    addMovement(1, 100, "2026-10-10 12:00:00", { Type: "increase" });
    addMovement(1, 40, "2026-10-11 12:00:00", { Type: "handover" });
    // A reduction and an admin correction are NOT payments: they must not move
    // the recalculated balance (both types are retired).
    addMovement(1, -25, "2026-10-12 12:00:00", { Type: "reduce" });
    addMovement(1, 15, "2026-10-13 12:00:00", { Type: "adjust" });
    // Policy-derived rows are ignored: the insurances above are the truth.
    addMovement(1, -30, "2026-10-05 10:00:00", {
      Type: "policy",
      BlancNumber: "100001",
    });
    addMovement(1, -40, "2026-10-06 10:00:00", {
      Type: "policy",
      BlancNumber: "100002",
    });
    addMovement(1, 40, "2026-10-07 10:00:00", {
      Type: "annulment",
      BlancNumber: "100002",
    });
    // Another broker's policy never counts here.
    addPolicy("200001", { Price: 500, BrokerId: 2 });

    const r = await call("put", STARTING_BALANCE, {
      params: { id: "1" },
      body: { amount: 50, date: "2026-10-01" },
    });
    eq(r.status, 200, "status");
    eq(r.body.message, "Starting balance saved", "message");
    eq(r.body.startingBalance.amount, 50, "stored amount");
    eq(r.body.startingBalance.date, "2026-10-01", "stored date");
    eq(r.body.insuranceCharges, 30, "only the active price; the worker paid the tax");
    eq(r.body.payments, 140, "only the top-up and the hand-over count");
    eq(r.body.broker.CashBalance, 160, "50 + 140 - 30");
    eq(db.brokers[0].CashBalance, 160, "the balance is stored");

    // The history reads forward from the same starting balance and ignores the
    // retired reduce/adjust rows, so both screens agree.
    const h = await call("get", "/brokers/:id/history", {
      params: { id: "1" },
      query: WINDOW,
    });
    eq(h.status, 200, "history status");
    eq(h.body.balanceAtEnd, 160, "history agrees with the recalculated balance");
    eq(h.body.netChange, 110, "-30 active -40 +40 refunded +100 +40");
    eq(
      h.body.movements.filter((m) => m.Retired).map((m) => m.Type).sort(),
      ["adjust", "reduce"],
      "retired rows are tagged in the history"
    );
  });

  await check("starting balance: a broker-paid annulment fee is still charged", async () => {
    resetDb();
    addPolicy("100001", {
      Price: 9,
      OriginalPrice: 40,
      AnnulFee: 9,
      Annulled: true,
      AnnulReason: "broker",
      BrokerId: 1,
    });
    addPolicy("100002", {
      Price: 9,
      OriginalPrice: 40,
      AnnulFee: 9,
      Annulled: true,
      AnnulReason: "worker",
      BrokerId: 1,
    });
    addMovement(1, 100, "2026-10-10 12:00:00", { Type: "increase" });
    addMovement(1, -40, "2026-10-06 10:00:00", {
      Type: "policy",
      BlancNumber: "100001",
    });
    addMovement(1, 31, "2026-10-07 10:00:00", {
      Type: "annulment",
      BlancNumber: "100001",
    });
    addMovement(1, -40, "2026-10-08 10:00:00", {
      Type: "policy",
      BlancNumber: "100002",
    });
    addMovement(1, 40, "2026-10-09 10:00:00", {
      Type: "annulment",
      BlancNumber: "100002",
    });

    const r = await call("put", STARTING_BALANCE, {
      params: { id: "1" },
      body: { amount: 0, date: "2026-10-01" },
    });
    eq(r.status, 200, "status");
    eq(r.body.insuranceCharges, 9, "only the broker-fault tax is charged");
    eq(r.body.payments, 100, "the top-up");
    eq(r.body.broker.CashBalance, 91, "100 - 9");
    eq(db.brokers[0].CashBalance, 91, "the balance is stored");
  });

  await check("starting balance: the stored value is shown in the history", async () => {
    resetDb();
    addPolicy("100001", { Price: 25, BrokerId: 1 });
    await call("put", STARTING_BALANCE, {
      params: { id: "1" },
      body: { amount: 10, date: "2026-09-30" },
    });
    const r = await call("get", "/brokers/:id/history", {
      params: { id: "1" },
      query: WINDOW,
    });
    eq(r.status, 200, "status");
    eq(r.body.startingBalance.amount, 10, "amount");
    eq(r.body.startingBalance.date, "2026-09-30", "date");
    eq(r.body.startingBalance.updatedBy, "admin1", "author");
    eq(r.body.broker.CashBalance, -15, "10 - 25");
  });

  await check("starting balance: saving again replaces it", async () => {
    resetDb();
    addPolicy("100001", { Price: 25, BrokerId: 1 });
    await call("put", STARTING_BALANCE, {
      params: { id: "1" },
      body: { amount: 10, date: "2026-09-30" },
    });
    const r = await call("put", STARTING_BALANCE, {
      params: { id: "1" },
      body: { amount: 100, date: "2026-10-02" },
    });
    eq(r.status, 200, "status");
    eq(r.body.startingBalance.amount, 100, "new amount");
    eq(r.body.startingBalance.date, "2026-10-02", "new date");
    eq(r.body.broker.CashBalance, 75, "100 - 25");
    eq(Object.keys(db.startingBalances).length, 1, "one row per broker");
  });

  await check("starting balance: the history always shows the stored balance", async () => {
    resetDb();
    addPolicy("100001", { Price: 30, BrokerId: 1 });
    addPolicy("100002", { Price: 20, BrokerId: 1 });
    addMovement(1, -30, "2026-10-02 10:00:00", {
      Type: "policy",
      BlancNumber: "100001",
    });
    addMovement(1, -20, "2026-10-03 10:00:00", {
      Type: "policy",
      BlancNumber: "100002",
    });
    addMovement(1, 100, "2026-10-04 10:00:00", { Type: "increase" });

    await call("put", STARTING_BALANCE, {
      params: { id: "1" },
      body: { amount: 200, date: "2026-09-30" },
    });
    // A hand-fixed balance that no longer follows the ledger must still be the
    // figure the history shows: the stored balance is the single source of
    // truth (the server rebuilds it from the insurances + the payments), and the
    // ledger is only the who-did-what list. This is what keeps the Brokers tab
    // and this page from ever disagreeing.
    db.brokers[0].CashBalance = 999;

    const r = await call("get", "/brokers/:id/history", {
      params: { id: "1" },
      query: WINDOW,
    });
    eq(r.status, 200, "status");
    const ms = r.body.movements; // newest first: top-up, then the two sales
    eq(ms[0].Amount, 100, "the newest row is the top-up");
    eq(ms[0].BalanceAfter, 999, "the newest row shows the stored balance");
    eq(ms[1].BalanceAfter, 899, "999 - 100 after the newer sale");
    eq(ms[2].BalanceAfter, 919, "and + 20 back before it");
    eq(r.body.netChange, 50, "net change of the shown movements");
    eq(r.body.balanceAtEnd, 999, "the page ends on the stored balance");
    eq(r.body.balanceAtStart, 949, "and starts at the stored balance - net");
    eq(r.body.broker.CashBalance, 999, "the stored balance is reported as is");
  });

  await check("starting balance: a corrected starting balance moves every row", async () => {
    resetDb();
    addPolicy("100001", { Price: 40, BrokerId: 1 });
    addMovement(1, -40, "2026-10-05 10:00:00", {
      Type: "policy",
      BlancNumber: "100001",
    });
    addMovement(1, 10, "2026-10-06 10:00:00", { Type: "increase" });

    await call("put", STARTING_BALANCE, {
      params: { id: "1" },
      body: { amount: 100, date: "2026-10-01" },
    });
    const before = await call("get", "/brokers/:id/history", {
      params: { id: "1" },
      query: WINDOW,
    });
    await call("put", STARTING_BALANCE, {
      params: { id: "1" },
      body: { amount: 600, date: "2026-10-01" },
    });
    const after = await call("get", "/brokers/:id/history", {
      params: { id: "1" },
      query: WINDOW,
    });

    eq(after.body.startingBalance.amount, 600, "the new figure is stored");
    eq(after.body.movements.length, before.body.movements.length, "same rows");
    for (let i = 0; i < before.body.movements.length; i++) {
      eq(
        after.body.movements[i].BalanceAfter,
        before.body.movements[i].BalanceAfter + 500,
        `row ${i} moved with the starting balance`
      );
    }
    eq(after.body.balanceAtEnd, 570, "600 + 10 - 40");
  });

  await check("starting balance: a past window also follows it", async () => {
    resetDb();
    addPolicy("100001", { Price: 30, BrokerId: 1 });
    addMovement(1, -30, "2026-10-05 10:00:00", {
      Type: "policy",
      BlancNumber: "100001",
    });
    addMovement(1, 50, "2026-10-20 10:00:00", { Type: "increase" });
    await call("put", STARTING_BALANCE, {
      params: { id: "1" },
      body: { amount: 100, date: "2026-10-01" },
    });

    const r = await call("get", "/brokers/:id/history", {
      params: { id: "1" },
      query: { since: "2026-10-01", until: "2026-10-10" },
    });
    eq(r.body.total, 1, "only the October 5 policy is in the window");
    eq(r.body.balanceAtStart, 100, "the window starts at the starting balance");
    eq(r.body.balanceAtEnd, 70, "100 - 30 at the end of the window");
    eq(r.body.movements[0].BalanceAfter, 70, "the insurance shows its own balance");
  });

  await check("a sub-broker's displayed balance includes its starting balance", async () => {
    resetDb();
    // A tariff-priced policy (40 EUR) and a 25 EUR top-up on top of a starting
    // balance of 100: the display balance must start from that 100.
    db.policies.push({
      BlancNumber: "300001",
      BrokerId: 1,
      Otomobil: "Automobile",
      Duration: "1 year",
      NonTurk: 0,
      Annulled: 0,
      Deleted: 0,
    });
    addMovement(1, 25, "2026-10-05 10:00:00", { Type: "increase" });
    // A retired reduce row is history only: it must not change the display
    // balance, but its amount is still shown in the ledger.
    addMovement(1, -10, "2026-10-06 10:00:00", { Type: "reduce" });
    db.startingBalances["1"] = {
      Amount: 100,
      EffectiveDate: "2026-10-01",
      UpdatedBy: "admin1",
      UpdatedAt: "2026-11-20 10:00:00",
    };

    const disp = await M.computeSubBrokerDisplayData(fakeDb, 1, {
      Auto: { "365": 40 },
    });
    eq(disp.displayCashBalance, 85, "100 starting + 25 top-up - 40 policy");
    eq(
      disp.mapMovementAmount({ Type: "policy", BlancNumber: "300001" }),
      -40,
      "the policy row is priced from the tariff"
    );
    eq(
      disp.mapMovementAmount({ Type: "reduce", Amount: -10 }),
      -10,
      "a retired row keeps its ledger amount for display"
    );
  });

  await check("starting balance: a deleted insurance is not charged", async () => {
    resetDb();
    addPolicy("100001", { Price: 25, BrokerId: 1 });
    addPolicy("100002", { Price: 40, BrokerId: 1, Deleted: true });
    const r = await call("put", STARTING_BALANCE, {
      params: { id: "1" },
      body: { amount: 0, date: "2026-10-01" },
    });
    eq(r.status, 200, "status");
    eq(r.body.insuranceCharges, 25, "only the live policy counts");
    eq(r.body.broker.CashBalance, -25, "0 - 25");
  });

  await check("starting balance: a missing amount is rejected", async () => {
    resetDb();
    const r = await call("put", STARTING_BALANCE, {
      params: { id: "1" },
      body: {},
    });
    eq(r.status, 400, "status");
    eq(r.body.error, "Amount must be a number", "error");
  });

  await check("starting balance: a malformed date is rejected", async () => {
    resetDb();
    for (const date of ["20-10-2026", "2026-02-31"]) {
      const r = await call("put", STARTING_BALANCE, {
        params: { id: "1" },
        body: { amount: 10, date },
      });
      eq(r.status, 400, `status for ${date}`);
      eq(r.body.error, "Date must be YYYY-MM-DD", `error for ${date}`);
    }
    eq(db.startingBalances[1], undefined, "nothing was stored");
  });

  await check("starting balance: an invalid broker id is rejected", async () => {
    const r = await call("put", STARTING_BALANCE, {
      params: { id: "abc" },
      body: { amount: 10 },
    });
    eq(r.status, 400, "status");
    eq(r.body.error, "Invalid broker id", "error");
  });

  await check("starting balance: an unknown broker answers 404", async () => {
    resetDb();
    const r = await call("put", STARTING_BALANCE, {
      params: { id: "999" },
      body: { amount: 10 },
    });
    eq(r.status, 404, "status");
    eq(r.body.error, "Broker not found", "error");
  });

  // --- the balance comes from the insurance table + broker_payments ----------

  await check("a payment corrected in the history moves the payments table too", async () => {
    resetDb();
    addMovement(1, 100, "2026-10-02 10:00:00", { Type: "increase" });
    await call("put", STARTING_BALANCE, {
      params: { id: "1" },
      body: { amount: 0, date: "2026-10-01" },
    });
    eq(db.brokers[0].CashBalance, 100, "the payment is the whole balance");

    const r = await call("patch", "/brokers/:id/history/:movementId", {
      params: { id: "1", movementId: "1" },
      body: { amount: 150 },
    });
    eq(r.status, 200, "status");
    eq(db.payments[0].Amount, 150, "the money table is corrected too");
    eq(db.brokers[0].CashBalance, 150, "and the rebuilt balance follows");
  });

  await check("a hand-over's corrected date and recipient reach the payments table", async () => {
    resetDb();
    addMovement(1, 50, "2026-10-10 12:00:00", {
      Type: "handover",
      Recipient: "Owner",
    });

    const r = await call("patch", "/brokers/:id/history/:movementId", {
      params: { id: "1", movementId: "1" },
      body: { date: "2026-10-02", Recipient: "Maria", TzOffset: 0 },
    });
    eq(r.status, 200, "status");
    eq(db.movements[0].Recipient, "Maria", "the ledger takes the recipient");
    eq(db.movements[0].CreatedAt, "2026-10-02 12:00:00", "the ledger takes the day");
    eq(db.payments[0].Recipient, "Maria", "the payments table takes the recipient");
    eq(db.payments[0].CreatedAt, "2026-10-02 12:00:00", "the payments table takes the day");
    eq(db.brokers[0].CashBalance, 70, "money is unchanged");
  });

  await check("a policy movement correction cannot move a rebuilt balance", async () => {
    resetDb();
    addPolicy("100001", { Price: 30, BrokerId: 1 });
    addMovement(1, -30, "2026-10-02 10:00:00", {
      Type: "policy",
      BlancNumber: "100001",
    });
    await call("put", STARTING_BALANCE, {
      params: { id: "1" },
      body: { amount: 0, date: "2026-10-01" },
    });
    eq(db.brokers[0].CashBalance, -30, "0 - 30");

    const r = await call("patch", "/brokers/:id/history/:movementId", {
      params: { id: "1", movementId: "1" },
      body: { amount: -50 },
    });
    eq(r.status, 200, "status");
    eq(db.movements[0].Amount, -50, "the history row keeps the correction");
    eq(
      db.brokers[0].CashBalance,
      -30,
      "the insurance row is the truth, so the balance is rebuilt from its price"
    );
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();