"use strict";

// Node test for the HAND OVER of the Current cash tab: money physically given
// to a person (a runner taking the takings to the safe, the owner collecting
// the day's cash ...).
//
// A hand-over is a reduction of the drawer that is NEITHER a sale NOR an
// expense, so it must:
//   - take the money out of current cash (Available cash);
//   - be written in the drawer's ledger as Type = 'handover' together with the
//     person who received it (`Recipient`), because the reason alone ("to the
//     safe") does not say who walked away with the money;
//   - write NOTHING to the Total cash ledger, so the day's Total daily cash is
//     untouched;
//   - never appear among the day's expenses (see test/server/currentCashExpenses.test.cjs).
//
// It loads the REAL server module (InsuranceServer/Requests/CurrentCash.js, see
// test/serverPath.cjs) in a vm against an in-memory fake MySQL that only
// understands the statements a hand-over may issue - anything else (e.g. a
// Total cash ledger insert) is a hard error.
//
// Run with:  node test/server/cashHandover.test.cjs   (or: npm test)

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

const BRANCH = "Офис Харманли";
const USER = "worker1";


// --- fake MySQL --------------------------------------------------------------
// Only the statements a hand-over (and the correction/deletion of one) needs. A
// Total cash insert would hit the "unhandled SQL" error, which is exactly what
// the test wants to catch.
function makeDb({ cash = 100, rows = [] } = {}) {
  const state = { cash };
  const ledger = []; // rows written to cash_transactions
  const updates = []; // UPDATE current_cash ...
  const sql = [];
  // Ledger rows already stored (for correcting/deleting one).
  const txRows = rows.map((r) => Object.assign({ Deleted: 0 }, r));

  const query = async (text, params = []) => {
    const s = String(text).replace(/\s+/g, " ").trim();
    const p = params || [];
    sql.push({ sql: s, params: p });

    if (s.startsWith("INSERT IGNORE INTO current_cash")) return [[]];
    if (s.startsWith("SELECT CurrentCash FROM current_cash")) {
      return [[{ CurrentCash: state.cash }]];
    }
    if (s.startsWith("UPDATE current_cash SET CurrentCash = CurrentCash - ?")) {
      if (Number(p[0]) > state.cash) {
        throw new Error("insufficient current cash for reduction");
      }
      state.cash -= Number(p[0]);
      updates.push({ type: "reduce", amount: Number(p[0]) });
      return [{ affectedRows: 1 }];
    }
    if (s.startsWith("UPDATE current_cash SET CurrentCash = CurrentCash + ?")) {
      state.cash += Number(p[0]);
      updates.push({ type: "increase", amount: Number(p[0]) });
      return [{ affectedRows: 1 }];
    }
    if (s.startsWith("SELECT * FROM cash_transactions WHERE id = ?")) {
      return [txRows.filter((r) => Number(r.id) === Number(p[0]))];
    }
    // A hand-over may already have been (partly) returned; this test starts
    // every row with no returns, so correcting/deleting it is still allowed.
    if (
      s.startsWith(
        "SELECT COALESCE(SUM(Amount), 0) AS Returned FROM cash_handover_returns"
      )
    ) {
      return [[{ Returned: 0 }]];
    }
    if (s.startsWith("UPDATE cash_transactions SET Type = ?")) {
      // Columns are read from the statement so an optional CreatedAt (an admin
      // moved the hand-over to another day) is applied too.
      const m = /^UPDATE cash_transactions SET (.+?) WHERE id = \?$/.exec(s);
      const cols = m[1].split(",").map((x) => x.trim().split(/\s+/)[0]);
      const row = txRows.find((r) => Number(r.id) === Number(p[p.length - 1]));
      if (!row) return [{ affectedRows: 0 }];
      cols.forEach((col, i) => (row[col] = p[i]));
      return [{ affectedRows: 1 }];
    }
    if (s.startsWith("UPDATE cash_transactions SET Deleted = 1")) {
      const row = txRows.find((r) => Number(r.id) === Number(p[2]));
      if (!row) return [{ affectedRows: 0 }];
      Object.assign(row, { Deleted: 1, DeletedAt: p[0], DeletedBy: p[1] });
      return [{ affectedRows: 1 }];
    }
    if (
      s.startsWith(
        "INSERT INTO cash_transactions (Branch, Type, Amount, Currency, Username, Reason, Recipient, CreatedAt)"
      )
    ) {
      ledger.push({
        Branch: p[0],
        Type: p[1],
        Amount: p[2],
        Currency: p[3],
        Username: p[4],
        Reason: p[5],
        Recipient: p[6],
        CreatedAt: p[7],
      });
      return [{ insertId: ledger.length }];
    }
    throw new Error("fake DB: unhandled SQL -> " + s);
  };

  return {
    query,
    withTransaction: async (fn) => fn({ query }),
    state,
    ledger,
    updates,
    sql,
    txRows,
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
      params: { id: body && body.id },
      user: user && typeof user === "object" ? user : { username: user },
    },
    res
  );
  return res;
}

const callHandover = (db, body, user = USER) =>
  callRoute("post", "/currentcash/handover", db, { body, user });

(async () => {
  console.log("Current cash — hand over");

  await check("only a 'handover' type is a hand-over", () => {
    eq(CC.isCashHandover("handover"), true, "handover");
    eq(CC.isCashHandover("HANDOVER"), true, "case-insensitive");
    eq(CC.isCashHandover(" handover "), true, "padded");
    eq(CC.isCashHandover("reduce"), false, "an expense is not a hand-over");
    eq(CC.isCashHandover("increase"), false, "an increase is not a hand-over");
    eq(CC.isCashHandover(null), false, "null");
    eq(CC.isCashHandover(undefined), false, "undefined");
  });

  await check("a hand-over takes the money out of the drawer", async () => {
    const db = makeDb({ cash: 100 });
    const applied = await CC.recordCashHandover(
      db,
      BRANCH,
      USER,
      40,
      "Runner to the safe",
      "Ivan",
      "EUR",
      "2026-10-20 18:30:00"
    );

    eq(applied, 40, "the applied amount");
    eq(db.state.cash, 60, "the drawer drops");
    eq(db.updates, [{ type: "reduce", amount: 40 }], "a single reduction");
    eq(
      db.ledger,
      [
        {
          Branch: BRANCH,
          Type: "handover",
          Amount: 40,
          Currency: "EUR",
          Username: USER,
          Reason: "Runner to the safe",
          Recipient: "Ivan",
          CreatedAt: "2026-10-20 18:30:00",
        },
      ],
      "one ledger row, with the recipient and the client's CreatedAt"
    );
  });

  await check("a hand-over writes nothing to the Total cash ledger", async () => {
    const db = makeDb({ cash: 100 });
    await CC.recordCashHandover(
      db, BRANCH, USER, 40, "Runner to the safe", "Ivan", "EUR"
    );
    eq(
      db.sql.filter((q) => /total_cash/i.test(q.sql)),
      [],
      "no total_cash / total_cash_transactions statement at all"
    );
  });

  await check("the amount, currency, reason and recipient are normalised", async () => {
    const db = makeDb({ cash: 100 });
    await CC.recordCashHandover(
      db, BRANCH, USER, "12,50", "  Petty cash  ", "  Ivan  ", "try"
    );
    eq(db.ledger[0].Amount, 12.5, "a decimal comma becomes a number");
    eq(db.ledger[0].Currency, "TRY", "the currency is upper-cased");
    eq(db.ledger[0].Reason, "Petty cash", "the reason is trimmed");
    eq(db.ledger[0].Recipient, "Ivan", "the recipient is trimmed");
    eq(db.state.cash, 87.5, "the drawer drops by the rounded amount");
  });

  await check("a hand-over needs the person who took the money", async () => {
    for (const recipient of [undefined, null, "", "   "]) {
      const db = makeDb({ cash: 100 });
      let error = null;
      try {
        await CC.recordCashHandover(
          db, BRANCH, USER, 10, "Runner", recipient, "EUR"
        );
      } catch (err) {
        error = err.message;
      }
      eq(
        error,
        "recipient is required",
        "recipient: " + JSON.stringify(recipient)
      );
      eq(db.state.cash, 100, "the drawer is untouched");
      eq(db.ledger, [], "nothing is recorded");
    }
  });

  await check("the other fields are still required", async () => {
    const cases = [
      [{ amount: 0 }, "amount must be a positive number"],
      [{ amount: -5 }, "amount must be a positive number"],
      [{ amount: "abc" }, "amount must be a positive number"],
      [{ reason: "   " }, "reason is required"],
    ];
    for (const [override, expected] of cases) {
      const db = makeDb({ cash: 100 });
      let error = null;
      try {
        await CC.recordCashHandover(
          db,
          BRANCH,
          USER,
          override.amount === undefined ? 10 : override.amount,
          override.reason === undefined ? "Runner" : override.reason,
          "Ivan",
          "EUR"
        );
      } catch (err) {
        error = err.message;
      }
      eq(error, expected, "for " + JSON.stringify(override));
      eq(db.ledger, [], "nothing is recorded");
    }
  });

  await check("a hand-over cannot take out more than the drawer holds", async () => {
    const db = makeDb({ cash: 30 });
    let error = null;
    try {
      await CC.recordCashHandover(db, BRANCH, USER, 40, "Runner", "Ivan", "EUR");
    } catch (err) {
      error = err.message;
    }
    eq(error, "insufficient current cash for reduction", "rejected");
    eq(db.state.cash, 30, "the drawer is untouched");
    eq(db.ledger, [], "nothing is recorded");
  });

  // --- the route the Current cash tab calls ---------------------------------
  await check("POST /currentcash/handover records the hand-over", async () => {
    const db = makeDb({ cash: 100 });
    const res = await callHandover(db, {
      amount: 25,
      reason: "Courier to the bank",
      Recipient: " Maria ",
      currency: "EUR",
      branch: BRANCH,
      CreatedAt: "2026-10-20 18:30:00",
      tzOffset: "120",
    });
    eq(res.code, 201, "created");
    eq(
      res.body,
      {
        message: "Cash handed over",
        amount: 25,
        currency: "EUR",
        branch: BRANCH,
        author: USER,
        reason: "Courier to the bank",
        recipient: "Maria",
      },
      "the response names the person who took the money"
    );
    eq(db.state.cash, 75, "the drawer drops");
    eq(db.ledger[0].Type, "handover", "stored as a hand-over");
    eq(db.ledger[0].Recipient, "Maria", "with the recipient");
  });

  await check("the lowercase 'recipient' is accepted too", async () => {
    const db = makeDb({ cash: 100 });
    const res = await callHandover(db, {
      amount: 10,
      reason: "Runner",
      recipient: "Ivan",
      branch: BRANCH,
    });
    eq(res.code, 201, "created");
    eq(db.ledger[0].Recipient, "Ivan", "the recipient is stored");
  });

  await check("the route rejects a hand-over with no recipient", async () => {
    const db = makeDb({ cash: 100 });
    const res = await callHandover(db, {
      amount: 10,
      reason: "Runner",
      branch: BRANCH,
    });
    eq(res.code, 400, "bad request");
    eq(res.body, { error: "recipient is required" }, "a clear reason");
    eq(db.state.cash, 100, "the drawer is untouched");
    eq(db.ledger, [], "nothing is recorded");
  });

  await check("the route rejects more money than the drawer holds", async () => {
    const db = makeDb({ cash: 5 });
    const res = await callHandover(db, {
      amount: 10,
      reason: "Runner",
      Recipient: "Ivan",
      branch: BRANCH,
    });
    eq(res.code, 400, "bad request");
    eq(
      res.body,
      { error: "insufficient current cash for reduction" },
      "the real reason"
    );
    eq(db.ledger, [], "nothing is recorded");
  });

  await check("an admin can record a hand-over on an earlier day", async () => {
    const db = makeDb({ cash: 100 });
    const res = await callHandover(
      db,
      {
        amount: 10,
        reason: "Runner to the safe",
        Recipient: "Ivan",
        branch: BRANCH,
        CreatedAt: "2026-11-20 18:30:00",
        date: "2026-10-01",
        TzOffset: 0,
      },
      { username: "admin1", role: 1 }
    );
    eq(res.code, 201, "created");
    eq(
      db.ledger[0].CreatedAt,
      "2026-10-01 18:30:00",
      "the picked day keeps the time of day"
    );
    eq(db.state.cash, 90, "the live drawer still drops now");
  });

  await check("an admin can record the time of day of a hand-over", async () => {
    const db = makeDb({ cash: 100 });
    const res = await callHandover(
      db,
      {
        amount: 10,
        reason: "Runner to the safe",
        Recipient: "Ivan",
        branch: BRANCH,
        CreatedAt: "2026-11-20 18:30:00",
        date: "2026-10-01",
        time: "07:05",
        TzOffset: 0,
      },
      { username: "admin1", role: 1 }
    );
    eq(res.code, 201, "created");
    eq(
      db.ledger[0].CreatedAt,
      "2026-10-01 07:05:00",
      "the picked day AND 24-hour clock"
    );
    eq(db.state.cash, 90, "the live drawer still drops now");
  });

  await check("a malformed clock is refused and nothing is recorded", async () => {
    for (const time of ["24:00", "12:75", "lunch"]) {
      const db = makeDb({ cash: 100 });
      const res = await callHandover(
        db,
        {
          amount: 10,
          reason: "Runner to the safe",
          Recipient: "Ivan",
          branch: BRANCH,
          CreatedAt: "2026-11-20 18:30:00",
          date: "2026-10-01",
          time,
          TzOffset: 0,
        },
        { username: "admin1", role: 1 }
      );
      eq(res.code, 400, time);
      eq(res.body, { error: "Time must be HH:mm" }, "a clear reason for " + time);
      eq(db.ledger, [], "nothing recorded for " + time);
      eq(db.state.cash, 100, "the drawer is untouched");
    }
  });

  await check("a worker cannot date a hand-over", async () => {
    const db = makeDb({ cash: 100 });
    const res = await callHandover(db, {
      amount: 10,
      reason: "Runner to the safe",
      Recipient: "Ivan",
      branch: BRANCH,
      CreatedAt: "2026-11-20 18:30:00",
      date: "2026-10-01",
      TzOffset: 0,
    });
    eq(res.code, 403, "refused");
    eq(
      res.body,
      { error: "Only an admin can record a hand-over on an earlier date" },
      "a clear reason"
    );
    eq(db.state.cash, 100, "the drawer is untouched");
    eq(db.ledger, [], "nothing is recorded");
  });

  // --- correcting / deleting a hand-over -------------------------------------
  const handoverRow = (over = {}) =>
    Object.assign(
      {
        id: 7,
        Branch: BRANCH,
        Type: "handover",
        Amount: 40,
        Currency: "EUR",
        Username: USER,
        Reason: "Runner to the safe",
        Recipient: "Ivan",
        CreatedAt: "2026-10-20 18:30:00",
        Deleted: 0,
      },
      over
    );

  await check("a hand-over can be corrected without touching Total cash", async () => {
    const db = makeDb({ cash: 60, rows: [handoverRow()] });
    const res = await callRoute(
      "patch",
      "/currentcash/transactions/:id",
      db,
      {
        body: {
          id: 7,
          Amount: 45,
          Reason: "Courier to the bank",
          Recipient: "Maria",
          CreatedAt: "2026-10-20 19:00:00",
        },
      }
    );
    eq(res.code, 200, "updated");
    eq(db.state.cash, 55, "the drawer is corrected by reverse + re-apply");
    eq(
      db.sql.filter((q) => /total_cash/i.test(q.sql)),
      [],
      "a hand-over has no Total cash rows to correct"
    );
    eq(
      [
        db.txRows[0].Type,
        db.txRows[0].Amount,
        db.txRows[0].Reason,
        db.txRows[0].Recipient,
      ],
      ["handover", 45, "Courier to the bank", "Maria"],
      "the entry keeps its type and takes the new recipient"
    );
  });

  await check("an admin can change the day a hand-over is recorded on", async () => {
    const db = makeDb({
      cash: 60,
      // Recorded by a worker: the admin may still correct its date.
      rows: [handoverRow({ Username: "worker2" })],
    });
    const res = await callRoute(
      "patch",
      "/currentcash/transactions/:id",
      db,
      {
        body: {
          id: 7,
          Amount: 40,
          Reason: "Runner to the safe",
          Recipient: "Ivan",
          date: "2026-10-01",
          TzOffset: 0,
          CreatedAt: "2026-11-20 19:00:00",
        },
        user: { username: "admin1", role: 1 },
      }
    );
    eq(res.code, 200, "updated");
    eq(
      db.txRows[0].CreatedAt,
      "2026-10-01 18:30:00",
      "the day is corrected, the time of day is kept"
    );
    eq(db.state.cash, 60, "a date-only correction leaves the drawer as it was");
  });

  await check("an admin can correct the clock of a hand-over", async () => {
    const db = makeDb({
      cash: 60,
      // Recorded by a worker: the admin may still correct its moment.
      rows: [handoverRow({ Username: "worker2" })],
    });
    const res = await callRoute(
      "patch",
      "/currentcash/transactions/:id",
      db,
      {
        body: {
          id: 7,
          Amount: 40,
          Reason: "Runner to the safe",
          Recipient: "Ivan",
          date: "2026-10-01",
          time: "08:15",
          TzOffset: 0,
          CreatedAt: "2026-11-20 19:00:00",
        },
        user: { username: "admin1", role: 1 },
      }
    );
    eq(res.code, 200, "updated");
    eq(
      db.txRows[0].CreatedAt,
      "2026-10-01 08:15:00",
      "the day and the 24-hour clock are corrected"
    );
    eq(db.state.cash, 60, "a date-and-time correction leaves the drawer as it was");
  });

  await check("a malformed clock on a correction is refused", async () => {
    const db = makeDb({ cash: 60, rows: [handoverRow()] });
    const res = await callRoute("patch", "/currentcash/transactions/:id", db, {
      body: {
        id: 7,
        Amount: 40,
        Reason: "Runner",
        Recipient: "Ivan",
        date: "2026-10-01",
        time: "25:61",
        TzOffset: 0,
      },
      user: { username: "admin1", role: 1 },
    });
    eq(res.code, 400, "refused");
    eq(res.body, { error: "Time must be HH:mm" }, "a clear reason");
    eq(db.txRows[0].CreatedAt, "2026-10-20 18:30:00", "the moment is unchanged");
  });

  await check("a worker cannot change a hand-over's day", async () => {
    const db = makeDb({ cash: 60, rows: [handoverRow()] });
    const res = await callRoute("patch", "/currentcash/transactions/:id", db, {
      body: {
        id: 7,
        Amount: 40,
        Reason: "Runner",
        Recipient: "Ivan",
        date: "2026-10-01",
        TzOffset: 0,
      },
    });
    eq(res.code, 403, "refused");
    eq(
      res.body,
      { error: "Only an admin can change the date of a hand-over" },
      "a clear reason"
    );
    eq(db.txRows[0].CreatedAt, "2026-10-20 18:30:00", "the date is unchanged");
  });

  await check("only a hand-over can be moved to another day", async () => {
    const db = makeDb({
      cash: 60,
      rows: [
        handoverRow({
          Type: "reduce",
          Recipient: null,
          Reason: "Rent",
          Username: "admin1",
        }),
      ],
    });
    const res = await callRoute("patch", "/currentcash/transactions/:id", db, {
      body: {
        id: 7,
        Amount: 40,
        Reason: "Rent",
        date: "2026-10-01",
        TzOffset: 0,
      },
      user: { username: "admin1", role: 1 },
    });
    eq(res.code, 400, "refused");
    eq(
      res.body,
      { error: "only a hand-over can change its date" },
      "a clear reason"
    );
    eq(db.txRows[0].CreatedAt, "2026-10-20 18:30:00", "the date is unchanged");
  });

  await check(
    "a hand-over cannot be corrected into an expense or an increase",
    async () => {
      for (const type of ["reduce", "increase"]) {
        const db = makeDb({ cash: 60, rows: [handoverRow()] });
        const res = await callRoute(
          "patch",
          "/currentcash/transactions/:id",
          db,
          { body: { id: 7, Type: type, Amount: 40 } }
        );
        eq(res.code, 400, type + " rejected");
        eq(
          res.body.error,
          "a hand-over cannot be changed into an increase or an expense, or the other way round",
          "a clear reason"
        );
        eq(db.state.cash, 60, "the drawer is untouched");
        eq(db.txRows[0].Type, "handover", "the entry keeps its type");
      }
    }
  );

  await check("an expense cannot be corrected into a hand-over", async () => {
    const db = makeDb({
      cash: 60,
      rows: [handoverRow({ Type: "reduce", Recipient: null, Reason: "Rent" })],
    });
    const res = await callRoute("patch", "/currentcash/transactions/:id", db, {
      body: { id: 7, Type: "handover", Recipient: "Ivan" },
    });
    eq(res.code, 400, "rejected");
    eq(db.state.cash, 60, "the drawer is untouched");
    eq(db.txRows[0].Type, "reduce", "the entry stays an expense");
  });

  await check("a hand-over still needs a recipient when corrected", async () => {
    const db = makeDb({
      cash: 60,
      rows: [handoverRow({ Recipient: null })],
    });
    const res = await callRoute("patch", "/currentcash/transactions/:id", db, {
      body: { id: 7, Amount: 40, Reason: "Runner" },
    });
    eq(res.code, 400, "rejected");
    eq(res.body, { error: "recipient is required" }, "a clear reason");
    eq(db.state.cash, 60, "the drawer is untouched");
  });

  await check("deleting a hand-over puts the money back, without Total cash", async () => {
    const db = makeDb({ cash: 60, rows: [handoverRow()] });
    const res = await callRoute(
      "delete",
      "/currentcash/transactions/:id",
      db,
      { body: { id: 7, CreatedAt: "2026-10-20 20:00:00" } }
    );
    eq(res.code, 200, "deleted");
    eq(db.state.cash, 100, "the money is back in the drawer");
    eq(
      db.sql.filter((q) => /total_cash/i.test(q.sql)),
      [],
      "no Total cash reversal row"
    );
    eq(db.txRows[0].Deleted, 1, "the entry is soft-deleted");
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
