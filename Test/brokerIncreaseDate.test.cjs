"use strict";

// Node test for BACKDATING A BROKER TOP-UP: an admin recording money the broker
// handed over on an earlier day (picked with a date picker in the Increase
// form), so that day's reports and the branch's Cash from Brokers include it.
//
// What must hold:
//   - POST /brokers/:id/increase accepts `date` ("YYYY-MM-DD") from an ADMIN and
//     stores the movement on that day, keeping the time of day it was entered;
//   - a worker may not backdate: `date` from anyone but an admin is refused and
//     nothing is recorded;
//   - a day that does not exist (2026-02-31) and a day in the future are
//     refused;
//   - a worker's ordinary top-up (no `date`) is still stamped with the time the
//     client sent, exactly as before;
//   - the Increase form in renderer/WorkPage/WorkPage.js shows the picker to
//     admins only, bounds it at today and turns the picked day into CreatedAt.
//
// The REAL server file runs in a vm against an in-memory fake, like
// Test/brokerHandover.test.cjs; the date helper is cut out of WorkPage.js.
//
// Run with:  node Test/brokerIncreaseDate.test.cjs   (or: npm test)

const fs = require("fs");
const path = require("path");
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
// 1) Brokers.js: POST /brokers/:id/increase with a chosen day
// ---------------------------------------------------------------------------
let db;
function resetDb() {
  db = {
    brokers: [
      { id: 1, Name: "Alpha", Code: "A1", CashBalance: 70, ParentBrokerId: null, CutOff: 0 },
    ],
    movements: [],
    nextMovement: 1,
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
  // The balance rebuild asks for the starting balance first; no row means the
  // incremental update stands (these tests cover the incremental path).
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
    // Faithful copy of CurrentCash.resolvePickedTime: the admin's 24-hour clock
    // that travels next to `date`.
    resolvePickedTime: (body) => {
      const b = body || {};
      const raw = b.time ?? b.Time;
      if (raw === undefined || raw === null || !String(raw).trim()) {
        return { time: "" };
      }
      const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(String(raw).trim());
      if (!m) return { error: "Time must be HH:mm" };
      const h = Number(m[1]);
      const mi = Number(m[2]);
      const s = m[3] === undefined ? 0 : Number(m[3]);
      if (h > 23 || mi > 59 || s > 59) return { error: "Time must be HH:mm" };
      const p = (n) => String(n).padStart(2, "0");
      return { time: `${p(h)}:${p(mi)}:${p(s)}` };
    },
  },
  "./PaymentSchedule.js": {
    getSchedule: () => ({ periodStart: "2026-11-01", days: 14 }),
  },
  // Payments live in their own table now; the stub writes the same ledger row so
  // the assertions on db.movements still hold.
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

const INCREASE = "/brokers/:id/increase";
const ADMIN = { username: "admin1", role: 1 };
const BRANCH = "Офис Харманли";


(async () => {
  console.log("broker top-up backdated by an admin (date picker)");

  await check("an admin can book a top-up on an earlier day", async () => {
    resetDb();
    const res = await callBroker("post", INCREASE, {
      params: { id: "1" },
      user: ADMIN,
      body: {
        amount: 40,
        currency: "EUR",
        reason: "Handed over last week",
        branch: BRANCH,
        date: "2026-10-01",
        CreatedAt: "2026-11-20 10:15:30",
        TzOffset: 120,
      },
    });
    eq(res.status, 200, "accepted");
    eq(db.brokers[0].CashBalance, 110, "70 + 40");
    eq(db.movements.length, 1, "one movement");
    const m = db.movements[0];
    eq(
      [m.Type, m.Amount, m.CreatedAt, m.Branch, m.Currency],
      ["increase", 40, "2026-10-01 10:15:30", BRANCH, "EUR"],
      "the picked day, with the time of day it was entered"
    );
  });

  await check("a worker cannot backdate a top-up", async () => {
    resetDb();
    const res = await callBroker("post", INCREASE, {
      params: { id: "1" },
      body: {
        amount: 40,
        currency: "EUR",
        reason: "Handed over last week",
        branch: BRANCH,
        date: "2026-10-01",
        CreatedAt: "2026-11-20 10:15:30",
      },
    });
    eq(res.status, 403, "refused");
    eq(
      res.body.error,
      "Only an admin can record an increase on an earlier date",
      "a clear reason"
    );
    eq(db.movements.length, 0, "nothing recorded");
    eq(db.brokers[0].CashBalance, 70, "balance untouched");
  });

  await check("a worker's ordinary top-up is still stamped with the time sent", async () => {
    resetDb();
    const res = await callBroker("post", INCREASE, {
      params: { id: "1" },
      body: {
        amount: 25,
        currency: "TRY",
        reason: "Branch top-up",
        branch: BRANCH,
        CreatedAt: "2026-11-20 09:05:00",
      },
    });
    eq(res.status, 200, "accepted");
    eq(db.movements[0].CreatedAt, "2026-11-20 09:05:00", "unchanged behaviour");
  });

  await check("the admin's own day is accepted too", async () => {
    resetDb();
    const today = clientLocalDateTime(0).slice(0, 10);
    const res = await callBroker("post", INCREASE, {
      params: { id: "1" },
      user: ADMIN,
      body: {
        amount: 10,
        currency: "EUR",
        reason: "Today's top-up",
        branch: BRANCH,
        date: today,
        CreatedAt: "2026-11-20 11:00:00",
        TzOffset: 0,
      },
    });
    eq(res.status, 200, "accepted");
    eq(db.movements[0].CreatedAt, `${today} 11:00:00`, "today is not a backdate");
  });

  await check("a day that does not exist is refused", async () => {
    resetDb();
    const res = await callBroker("post", INCREASE, {
      params: { id: "1" },
      user: ADMIN,
      body: {
        amount: 10,
        currency: "EUR",
        reason: "Typo",
        branch: BRANCH,
        date: "2026-02-31",
        CreatedAt: "2026-11-20 10:00:00",
        TzOffset: 0,
      },
    });
    eq([res.status, res.body.error], [400, "Date must be YYYY-MM-DD"], "refused");
    eq(db.movements.length, 0, "nothing recorded");
    eq(db.brokers[0].CashBalance, 70, "balance untouched");
  });

  await check("a day in the future is refused", async () => {
    resetDb();
    const tomorrow = dt(new Date(Date.now() + 86400000)).slice(0, 10);
    const res = await callBroker("post", INCREASE, {
      params: { id: "1" },
      user: ADMIN,
      body: {
        amount: 10,
        currency: "EUR",
        reason: "Not yet handed over",
        branch: BRANCH,
        date: tomorrow,
        CreatedAt: "2026-11-20 10:00:00",
        TzOffset: 0,
      },
    });
    eq([res.status, res.body.error], [400, "Date cannot be in the future"], "refused");
    eq(db.movements.length, 0, "nothing recorded");
  });

  await check("a hand-over honours the admin's date field too", async () => {
    resetDb();
    const res = await callBroker("post", "/brokers/:id/handover", {
      params: { id: "1" },
      user: ADMIN,
      body: {
        amount: 30,
        currency: "EUR",
        reason: "Owner collected",
        Recipient: "Owner",
        date: "2026-10-01",
        CreatedAt: "2026-11-20 12:00:00",
        TzOffset: 0,
      },
    });
    eq(res.status, 200, "accepted");
    eq(
      db.movements[0].CreatedAt,
      "2026-10-01 12:00:00",
      "the picked day becomes the hand-over's date"
    );
    eq(db.movements[0].Branch, null, "a hand-over still carries no branch");
  });

  await check("an admin can pick the time of day of a top-up too", async () => {
    resetDb();
    const res = await callBroker("post", INCREASE, {
      params: { id: "1" },
      user: ADMIN,
      body: {
        amount: 40,
        currency: "EUR",
        reason: "Handed over last week at lunch",
        branch: BRANCH,
        date: "2026-10-01",
        time: "13:45",
        CreatedAt: "2026-11-20 10:15:30",
        TzOffset: 120,
      },
    });
    eq(res.status, 200, "accepted");
    eq(
      db.movements[0].CreatedAt,
      "2026-10-01 13:45:00",
      "the picked day AND the 24-hour clock"
    );
    eq(db.brokers[0].CashBalance, 110, "the money still lands in the balance");
  });

  await check("a malformed clock is refused", async () => {
    for (const time of ["24:00", "12:75", "noon", "13:5"]) {
      resetDb();
      const res = await callBroker("post", INCREASE, {
        params: { id: "1" },
        user: ADMIN,
        body: {
          amount: 10,
          currency: "EUR",
          reason: "Typo",
          branch: BRANCH,
          date: "2026-10-01",
          time,
          CreatedAt: "2026-11-20 10:00:00",
          TzOffset: 0,
        },
      });
      eq([res.status, res.body.error], [400, "Time must be HH:mm"], time);
      eq(db.movements.length, 0, "nothing recorded for " + time);
      eq(db.brokers[0].CashBalance, 70, "balance untouched");
    }
  });

  await check("a hand-over keeps the admin's clock as well", async () => {
    resetDb();
    const res = await callBroker("post", "/brokers/:id/handover", {
      params: { id: "1" },
      user: ADMIN,
      body: {
        amount: 30,
        currency: "EUR",
        reason: "Owner collected",
        Recipient: "Owner",
        date: "2026-10-01",
        time: "07:05",
        CreatedAt: "2026-11-20 12:00:00",
        TzOffset: 0,
      },
    });
    eq(res.status, 200, "accepted");
    eq(
      db.movements[0].CreatedAt,
      "2026-10-01 07:05:00",
      "the hand-over is booked at the picked moment"
    );
    eq(db.movements[0].Branch, null, "a hand-over still carries no branch");
  });

  // -------------------------------------------------------------------------
  // 2) Client: the date-and-time picker of the Increase form
  // -------------------------------------------------------------------------
  const ROOT = path.join(__dirname, "..");
  const WORKPAGE_JS = path.join(ROOT, "renderer", "WorkPage", "WorkPage.js");
  const COMMON_JS = path.join(ROOT, "renderer", "common.js");
  const source = fs.readFileSync(WORKPAGE_JS, "utf8");
  const common = fs.readFileSync(COMMON_JS, "utf8");

  // One function, from its first line to the first "}" at column 0.
  function cutFunction(marker) {
    const start = source.indexOf(marker);
    if (start === -1) {
      console.error("Could not find in WorkPage.js: " + marker);
      process.exit(1);
    }
    const tail = source.slice(start);
    const closing = /\r?\n}\r?\n/.exec(tail);
    if (!closing) {
      console.error("Could not find the end of " + marker);
      process.exit(1);
    }
    return tail.slice(0, closing.index + closing[0].length);
  }

  await check("only an admin's increase/hand-over form gets the date-and-time picker, bounded at today", async () => {
    const block = cutFunction("function brokerAdjust(broker, kind) {");
    ok(
      block.includes(
        '(kind === "increase" || kind === "handover") && userRole === "1"'
      ),
      "admins only, for an increase and a hand-over"
    );
    ok(
      block.includes('key: "date"') && block.includes('type: "datetime-local"'),
      "a 24-hour date-and-time picker"
    );
    ok(block.includes("localDateTimeInputNow()"), "it opens on now");
    ok(block.includes("max: localDateString()"), "the future cannot be picked");
    ok(block.includes('t("increaseDate")'), "the increase label");
    ok(block.includes('t("handoverDate")'), "the hand-over label");
    ok(block.includes('t("increaseDateHint")'), "the increase explanation");
    ok(block.includes('t("handoverDateHint")'), "the hand-over explanation");
    ok(
      block.includes("payload.CreatedAt = brokerMovementCreatedAt("),
      "the picked day and clock become the movement's date"
    );
    ok(block.includes("payload.time = parts.time"), "the clock is sent as `time`");
    ok(block.includes("payload.TzOffset"), "the server is told the client's offset");
  });

  await check("the hand-over form asks who received the money", async () => {
    const block = cutFunction("function brokerAdjust(broker, kind) {");
    ok(
      block.includes('if (kind === "handover")') &&
        block.includes('key: "Recipient"') &&
        block.includes('t("handedTo")'),
      "a required Received by field on a broker hand-over"
    );
  });

  await check("buildForm passes a date field's min/max to the input", async () => {
    const block = cutFunction("function buildForm(spec, onSubmit, submitLabel) {");
    ok(block.includes("control.min = s.min;"), "min");
    ok(block.includes("control.max = s.max;"), "max");
  });

  await check("the picked day and clock become the movement's CreatedAt", async () => {
    const ctx = { console };
    vm.createContext(ctx);
    vm.runInContext(
      cutFunction("function localDateTimeNow(d = new Date()) {") +
        cutFunction("function brokerMovementCreatedAt(picked, now = new Date()) {"),
      ctx,
      { filename: "WorkPage.js#brokerMovementCreatedAt" }
    );
    const { brokerMovementCreatedAt } = ctx;
    const now = new Date(2026, 10, 20, 14, 5, 6); // 20 Nov 2026, 14:05:06 local
    eq(
      brokerMovementCreatedAt("2026-10-01", now),
      "2026-10-01 14:05:06",
      "a bare day keeps the current time of day"
    );
    eq(
      brokerMovementCreatedAt("2026-10-01T13:45", now),
      "2026-10-01 13:45:00",
      "the picked 24-hour clock is kept"
    );
    eq(
      brokerMovementCreatedAt("2026-10-01 07:05", now),
      "2026-10-01 07:05:00",
      "a space-separated clock is accepted too"
    );
    eq(
      brokerMovementCreatedAt("2026-11-20T23:59", now),
      "2026-11-20 23:59:00",
      "late evening stays on the 24-hour clock"
    );
    eq(
      brokerMovementCreatedAt("2026-11-20", now),
      "2026-11-20 14:05:06",
      "today is unchanged"
    );
    eq(brokerMovementCreatedAt("", now), "2026-11-20 14:05:06", "cleared means now");
    eq(
      brokerMovementCreatedAt(undefined, now),
      "2026-11-20 14:05:06",
      "missing means now"
    );
    eq(
      brokerMovementCreatedAt("01.10.2026", now),
      "2026-11-20 14:05:06",
      "a malformed day never reaches the server"
    );
  });

  await check("the labels exist in both languages", async () => {
    for (const key of ["increaseDate", "increaseDateHint"]) {
      eq(
        (common.match(new RegExp(`\\b${key}:`, "g")) || []).length,
        2,
        `${key} in EN and BG`
      );
    }
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
