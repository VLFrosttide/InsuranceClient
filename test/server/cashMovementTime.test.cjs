"use strict";

// Node test for the day and 24-hour clock an ADMIN picks when CREATING a
// manual cash movement in the Current cash tab ("Increase" and "Expense").
//
// What must hold:
//   - an admin may record an increase or an expense on an earlier day AND at
//     an earlier time (`date` + `time`, 24-hour clock); both the drawer ledger
//     and the Total cash ledger get the picked moment;
//   - a `date` from anyone but an admin is refused and nothing is written;
//   - a day that does not exist and a day in the future are refused;
//   - a malformed clock is refused;
//   - without `date` the client's CreatedAt is stored as before (a worker
//     always records "now").
//
// It loads the REAL server module (InsuranceServer/Requests/CurrentCash.js, see
// test/serverPath.cjs) in a vm against an in-memory fake MySQL.
//
// Run with:  node test/server/cashMovementTime.test.cjs   (or: npm test)

const fs = require("fs");
const vm = require("vm");

const { serverFile } = require("../serverPath.cjs");

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

const BRANCH = "Офис Харманли";
const USER = "worker1";
const ADMIN = { username: "admin1", role: 1 };

// --- fake MySQL --------------------------------------------------------------
// Only the statements a manual increase/reduce issues: the drawer update, the
// cash ledger row and the Total cash ledger row. Anything else is a hard error.
function makeDb({ cash = 100 } = {}) {
  const state = { cash };
  const cashRows = [];
  const totalRows = [];
  const sql = [];

  const query = async (text, params = []) => {
    const s = String(text).replace(/\s+/g, " ").trim();
    const p = params || [];
    sql.push({ sql: s, params: p });

    if (s.startsWith("INSERT IGNORE INTO current_cash")) return [[]];
    if (s.startsWith("SELECT CurrentCash FROM current_cash")) {
      return [[{ CurrentCash: state.cash }]];
    }
    if (s.startsWith("UPDATE current_cash SET CurrentCash = CurrentCash + ?")) {
      state.cash += Number(p[0]);
      return [{ affectedRows: 1 }];
    }
    if (s.startsWith("UPDATE current_cash SET CurrentCash = CurrentCash - ?")) {
      if (Number(p[0]) > state.cash) {
        throw new Error("insufficient current cash for reduction");
      }
      state.cash -= Number(p[0]);
      return [{ affectedRows: 1 }];
    }
    if (
      s.startsWith(
        "INSERT INTO cash_transactions (Branch, Type, Amount, Currency, Username, Reason, CreatedAt)"
      )
    ) {
      cashRows.push({
        Branch: p[0],
        Type: p[1],
        Amount: p[2],
        Currency: p[3],
        Username: p[4],
        Reason: p[5],
        CreatedAt: p[6],
      });
      return [{ insertId: cashRows.length }];
    }
    if (s.startsWith("INSERT INTO total_cash_transactions")) {
      totalRows.push({
        Branch: p[0],
        Type: p[1],
        Amount: p[2],
        Currency: p[3],
        Source: p[4],
        Username: p[5],
        Reason: p[6],
        CreatedAt: p[7],
      });
      return [{ insertId: totalRows.length }];
    }
    throw new Error("fake DB: unhandled SQL -> " + s);
  };

  return {
    query,
    withTransaction: async (fn) => fn({ query }),
    state,
    cashRows,
    totalRows,
    sql,
  };
}

// --- call a route -------------------------------------------------------------
async function callRoute(method, routePath, db, { body, user = USER } = {}) {
  const routes = [];
  const router = Object.assign({}, fakeRouter, {
    [method]: (p, ...h) => routes.push({ path: p, handler: h[h.length - 1] }),
  });
  loadCurrentCash(() => router).createCurrentCashRouter(db);
  const route = routes.find((r) => r.path === routePath);
  ok(route, `${method.toUpperCase()} ${routePath} registered`);
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
  await route.handler(
    {
      body,
      params: {},
      user: user && typeof user === "object" ? user : { username: user },
    },
    res
  );
  return res;
}

const callIncrease = (db, body, user = ADMIN) =>
  callRoute("post", "/currentcash/increase", db, { body, user });
const callReduce = (db, body, user = ADMIN) =>
  callRoute("post", "/currentcash/reduce", db, { body, user });

(async () => {
  console.log("Current cash — the day and 24-hour clock of a new movement");

  await check("an admin can book an increase on an earlier day at an earlier time", async () => {
    const db = makeDb({ cash: 100 });
    const res = await callIncrease(db, {
      amount: 40,
      currency: "EUR",
      reason: "Opening change",
      branch: BRANCH,
      date: "2026-10-01",
      time: "07:05",
      CreatedAt: "2026-11-20 18:30:00",
      TzOffset: 0,
    });
    eq(res.code, 201, "created");
    eq(
      db.cashRows[0].CreatedAt,
      "2026-10-01 07:05:00",
      "the drawer ledger takes the picked day and 24-hour clock"
    );
    eq(
      db.totalRows[0].CreatedAt,
      "2026-10-01 07:05:00",
      "the Total cash ledger takes the same moment"
    );
    eq(db.state.cash, 140, "the live drawer still takes the money now");
  });

  await check("an admin can book an expense on an earlier day at an earlier time", async () => {
    const db = makeDb({ cash: 100 });
    const res = await callReduce(db, {
      amount: 30,
      currency: "EUR",
      reason: "Rent",
      branch: BRANCH,
      date: "2026-10-02",
      time: "16:45",
      CreatedAt: "2026-11-20 18:30:00",
      TzOffset: 0,
    });
    eq(res.code, 201, "created");
    eq(
      db.cashRows[0].CreatedAt,
      "2026-10-02 16:45:00",
      "the expense is stamped with the picked day and clock"
    );
    eq(
      db.totalRows[0].CreatedAt,
      "2026-10-02 16:45:00",
      "and so is its Total cash row"
    );
    eq(db.state.cash, 70, "the live drawer still drops now");
  });

  await check("a picked day without a clock keeps the time that was sent", async () => {
    const db = makeDb({ cash: 100 });
    const res = await callIncrease(db, {
      amount: 10,
      currency: "EUR",
      reason: "Opening change",
      branch: BRANCH,
      date: "2026-10-01",
      CreatedAt: "2026-11-20 18:30:00",
      TzOffset: 0,
    });
    eq(res.code, 201, "created");
    eq(db.cashRows[0].CreatedAt, "2026-10-01 18:30:00", "the time is kept");
  });

  await check("without a picked moment a worker's movement is stored as sent", async () => {
    const db = makeDb({ cash: 100 });
    const res = await callIncrease(
      db,
      {
        amount: 10,
        currency: "EUR",
        reason: "Opening change",
        branch: BRANCH,
        CreatedAt: "2026-11-20 09:05:00",
      },
      USER
    );
    eq(res.code, 201, "created");
    eq(db.cashRows[0].CreatedAt, "2026-11-20 09:05:00", "unchanged behaviour");
  });

  await check("a worker cannot date an increase or an expense", async () => {
    for (const [call, noun] of [
      [callIncrease, "an increase"],
      [callReduce, "an expense"],
    ]) {
      const db = makeDb({ cash: 100 });
      const res = await call(
        db,
        {
          amount: 10,
          currency: "EUR",
          reason: "Typo",
          branch: BRANCH,
          date: "2026-10-01",
          time: "07:05",
          CreatedAt: "2026-11-20 18:30:00",
          TzOffset: 0,
        },
        USER
      );
      eq(res.code, 403, noun);
      eq(
        res.body,
        { error: `Only an admin can record ${noun} on an earlier date` },
        "a clear reason for " + noun
      );
      eq(db.cashRows, [], "nothing recorded for " + noun);
      eq(db.totalRows, [], "no Total cash row for " + noun);
      eq(db.state.cash, 100, "the drawer is untouched");
    }
  });

  await check("a malformed clock is refused", async () => {
    for (const time of ["24:00", "12:75", "noon"]) {
      const db = makeDb({ cash: 100 });
      const res = await callIncrease(db, {
        amount: 10,
        currency: "EUR",
        reason: "Opening change",
        branch: BRANCH,
        date: "2026-10-01",
        time,
        CreatedAt: "2026-11-20 18:30:00",
        TzOffset: 0,
      });
      eq(res.code, 400, time);
      eq(res.body, { error: "Time must be HH:mm" }, "a clear reason for " + time);
      eq(db.cashRows, [], "nothing recorded for " + time);
      eq(db.state.cash, 100, "the drawer is untouched");
    }
  });

  await check("a day that does not exist and a future day are refused", async () => {
    const db = makeDb({ cash: 100 });
    const bad = await callIncrease(db, {
      amount: 10,
      currency: "EUR",
      reason: "Typo",
      branch: BRANCH,
      date: "2026-02-31",
      CreatedAt: "2026-11-20 18:30:00",
      TzOffset: 0,
    });
    eq(bad.code, 400, "2026-02-31");
    eq(bad.body, { error: "Date must be YYYY-MM-DD" }, "a clear reason");
    eq(db.cashRows, [], "nothing recorded");

    const tomorrow = new Date(Date.now() + 86400000);
    const p = (n) => String(n).padStart(2, "0");
    const day = `${tomorrow.getFullYear()}-${p(tomorrow.getMonth() + 1)}-${p(
      tomorrow.getDate()
    )}`;
    const futureDb = makeDb({ cash: 100 });
    const future = await callIncrease(futureDb, {
      amount: 10,
      currency: "EUR",
      reason: "Not yet",
      branch: BRANCH,
      date: day,
      CreatedAt: "2026-11-20 18:30:00",
      TzOffset: 0,
    });
    eq(future.code, 400, "future day");
    eq(future.body, { error: "Date cannot be in the future" }, "a clear reason");
    eq(futureDb.cashRows, [], "nothing recorded");
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
