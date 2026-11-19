"use strict";

// Node test for the UNDO of a cash hand-over and the hand-over statistics of
// the Current cash tab (Requests/CurrentCash.js).
//
// An admin can return (part of) money that was handed to a person. The money
// either goes back into the office drawer - available cash grows through a
// ledger row of Type 'handover_return' - or straight to the company bank, where
// no drawer is touched and only the handed-over total falls. The original
// hand-over stays in place, and `cash_handover_returns` records every return so
// the statistics can show handed over / returned / still out.
//
// Run with:  node Test/cashHandoverReturn.test.cjs   (or: npm test)

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
const roleChecks = [];

function loadCurrentCash(onRouter) {
  const mod = { exports: {} };
  const CTX = { console, module: mod, exports: mod.exports, Buffer, process };
  const router = onRouter ? onRouter() : fakeRouter;
  const stubs = {
    express: { Router: () => router },
    "./Auth.js": {
      requireAuth: () => (req, res, next) => next(),
      requireRole: (...roles) => {
        roleChecks.push(roles);
        return (req, res, next) => next();
      },
      extractToken: () => "",
    },
  };
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
const USER = "admin1";

const handover = (over = {}) =>
  Object.assign(
    {
      id: 7,
      Branch: BRANCH,
      Type: "handover",
      Amount: "40.00",
      Currency: "EUR",
      Username: "worker1",
      Reason: "Runner to the safe",
      Recipient: "Ivan",
      CreatedAt: "2026-11-16 18:30:00",
      Deleted: 0,
    },
    over
  );

// --- fake MySQL for a return ------------------------------------------------
function makeReturnDb({ cash = 100, returned = 0, rows = [] } = {}) {
  const state = { cash, returned };
  const sql = [];
  const ledger = []; // cash_transactions inserts
  const returns = []; // cash_handover_returns inserts
  const cashUpdates = [];

  const query = async (text, params = []) => {
    const s = String(text).replace(/\s+/g, " ").trim();
    const p = params || [];
    sql.push({ sql: s, params: p });

    if (s.startsWith("SELECT * FROM cash_transactions WHERE id = ?")) {
      return [rows];
    }
    if (
      s.startsWith(
        "SELECT COALESCE(SUM(Amount), 0) AS Returned FROM cash_handover_returns"
      )
    ) {
      return [[{ Returned: state.returned }]];
    }
    if (s.startsWith("INSERT IGNORE INTO current_cash")) return [[]];
    if (s.startsWith("SELECT CurrentCash FROM current_cash")) {
      return [[{ CurrentCash: state.cash }]];
    }
    if (s.startsWith("UPDATE current_cash SET CurrentCash = CurrentCash + ?")) {
      state.cash += Number(p[0]);
      cashUpdates.push({ type: "increase", amount: Number(p[0]) });
      return [{ affectedRows: 1 }];
    }
    if (s.startsWith("UPDATE current_cash SET CurrentCash = CurrentCash - ?")) {
      state.cash -= Number(p[0]);
      cashUpdates.push({ type: "reduce", amount: Number(p[0]) });
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
    if (s.startsWith("INSERT INTO cash_handover_returns")) {
      returns.push({
        HandoverType: p[0],
        CashTransactionId: p[1],
        BrokerMovementId: p[2],
        CashReturnTransactionId: p[3],
        Branch: p[4],
        BrokerId: p[5],
        Currency: p[6],
        Amount: p[7],
        Destination: p[8],
        Username: p[9],
        Reason: p[10],
        CreatedAt: p[11],
      });
      return [{ insertId: returns.length }];
    }
    throw new Error("fake DB: unhandled SQL -> " + s);
  };

  return {
    query,
    // The real connection helper commits on resolve and rolls back on throw.
    withTransaction: async (fn) => fn({ query }),
    state,
    sql,
    ledger,
    returns,
    cashUpdates,
  };
}
// --- fake MySQL for the statistics -----------------------------------------
function makeStatsDb({
  cashLive = [],
  cashDeleted = [],
  drawerReturns = [],
  bankReturns = [],
  brokerLive = [],
  brokerDeleted = [],
  handovers = [],
} = {}) {
  const query = async (text) => {
    const s = String(text).replace(/\s+/g, " ").trim();
    if (s.includes("LEFT JOIN") && s.includes("FROM cash_transactions h")) {
      return [handovers];
    }
    if (s.includes("FROM cash_handover_returns")) {
      if (s.includes("Destination = 'drawer'")) return [drawerReturns];
      return [bankReturns];
    }
    if (s.includes("FROM broker_balance_movements")) {
      if (s.includes("Deleted = 1")) return [brokerDeleted];
      return [brokerLive];
    }
    if (s.includes("FROM cash_transactions")) {
      if (s.includes("Deleted = 1")) return [cashDeleted];
      return [cashLive];
    }
    throw new Error("fake DB: unhandled SQL -> " + s);
  };
  return { query };
}


// --- call a route -------------------------------------------------------------
async function callRoute(
  method,
  routePath,
  db,
  { body, user = USER, params } = {}
) {
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
      params: params || { id: body && body.id },
      user: { username: user, role: "1" },
    },
    res
  );
  return res;
}

async function rejects(fn, message) {
  let err = null;
  try {
    await fn();
  } catch (e) {
    err = e.message;
  }
  eq(err, message);
}

(async () => {
  console.log("Current cash — hand over returns and statistics");

  await check("only a 'handover_return' type is a return", () => {
    eq(CC.isHandoverReturn("handover_return"), true, "handover_return");
    eq(CC.isHandoverReturn(" HANDOVER_RETURN "), true, "case-insensitive");
    eq(CC.isHandoverReturn("handover"), false, "a hand-over is not a return");
    eq(CC.isHandoverReturn("increase"), false, "an increase is not a return");
    eq(CC.isHandoverReturn(null), false, "null");
  });

  await check("a return to the drawer increases available cash", async () => {
    const db = makeReturnDb({ cash: 100 });
    const result = await CC.recordCashHandoverReturn(
      db,
      handover(),
      USER,
      15,
      "drawer",
      "  Runner brought it back  ",
      "2026-11-17 10:00:00"
    );
    eq(
      result,
      {
        id: 7,
        amount: 15,
        currency: "EUR",
        branch: BRANCH,
        destination: "drawer",
        returned: 15,
        remaining: 25,
        returnId: 1,
        returnTransactionId: 1,
      },
      "the response says how much is left"
    );
    eq(db.state.cash, 115, "the drawer grows");
    eq(db.ledger.length, 1, "one ledger row");
    eq(db.ledger[0].Type, "handover_return", "stored as a return");
    eq(db.ledger[0].Amount, 15, "amount");
    eq(
      db.ledger[0].Reason,
      "Return of hand over #7: Runner brought it back",
      "the reason names the hand-over and the note"
    );
    eq(db.returns[0].Destination, "drawer", "destination stored");
    eq(db.returns[0].CashReturnTransactionId, 1, "linked to the ledger row");
    eq(
      db.sql.filter((q) => /total_cash/i.test(q.sql)),
      [],
      "no Total cash rows"
    );
  });

  await check("a return to the bank touches no drawer", async () => {
    const db = makeReturnDb({ cash: 100 });
    const result = await CC.recordCashHandoverReturn(
      db,
      handover(),
      USER,
      40,
      "bank",
      "",
      "2026-11-17 11:00:00"
    );
    eq(db.state.cash, 100, "available cash unchanged");
    eq(db.cashUpdates, [], "no current_cash update");
    eq(db.ledger, [], "no cash ledger row");
    eq(db.returns[0].Destination, "bank", "destination stored");
    eq(db.returns[0].CashReturnTransactionId, null, "no ledger row to link");
    eq(result.remaining, 0, "nothing left");
  });


  await check(
    "a hand-over can only be returned up to what is still out",
    async () => {
      const db = makeReturnDb({ returned: 30 });
      await rejects(
        () =>
          CC.recordCashHandoverReturn(
            db,
            handover(),
            USER,
            15,
            "drawer",
            "",
            ""
          ),
        "amount exceeds the money still handed over"
      );
      eq(db.state.cash, 100, "the drawer is untouched");

      const applied = await CC.recordCashHandoverReturn(
        db,
        handover(),
        USER,
        10,
        "bank",
        "",
        ""
      );
      eq(applied.returned, 40, "already returned + this one");
      eq(applied.remaining, 0, "nothing left");

      await rejects(
        () =>
          CC.recordCashHandoverReturn(
            db,
            handover({ Amount: "30.00" }),
            USER,
            5,
            "bank",
            "",
            ""
          ),
        "the hand-over has already been fully returned"
      );
    }
  );

  await check("the destination and amount are validated", async () => {
    const db = makeReturnDb();
    await rejects(
      () =>
        CC.recordCashHandoverReturn(db, handover(), USER, 5, "safe", "", ""),
      "destination must be 'drawer' or 'bank'"
    );
    await rejects(
      () =>
        CC.recordCashHandoverReturn(db, handover(), USER, 0, "drawer", "", ""),
      "amount must be a positive number"
    );
    await rejects(
      () =>
        CC.recordCashHandoverReturn(
          db,
          handover({ Type: "increase" }),
          USER,
          5,
          "drawer",
          "",
          ""
        ),
      "transaction is not a hand-over"
    );
    await rejects(
      () =>
        CC.recordCashHandoverReturn(
          db,
          handover({ Deleted: 1 }),
          USER,
          5,
          "drawer",
          "",
          ""
        ),
      "a deleted hand-over cannot be returned"
    );
    eq(db.state.cash, 100, "nothing moved");
  });

  await check(
    "POST /currentcash/handover/:id/undo returns the money",
    async () => {
      const db = makeReturnDb({ cash: 60, rows: [handover()] });
      const res = await callRoute(
        "post",
        "/currentcash/handover/:id/undo",
        db,
        {
          body: {
            id: 7,
            Amount: 20,
            Destination: "drawer",
            Reason: "Runner brought half back",
            CreatedAt: "2026-11-17 12:00:00",
          },
        }
      );
      eq(res.code, 200, "returned");
      eq(res.body.amount, 20, "amount");
      eq(res.body.destination, "drawer", "destination");
      eq(res.body.remaining, 20, "remaining");
      eq(res.body.author, USER, "author");
      eq(db.state.cash, 80, "the drawer grows");
      eq(db.ledger[0].Type, "handover_return", "ledger row");
    }
  );


  await check(
    "the statistics split cash and broker hand-overs, returns and undos",
    async () => {
      const db = makeStatsDb({
        cashLive: [
          { Currency: "EUR", Total: 60 },
          { Currency: "TRY", Total: 1000 },
        ],
        cashDeleted: [{ Currency: "EUR", Total: 40 }],
        drawerReturns: [{ Currency: "EUR", Total: 10 }],
        bankReturns: [{ Currency: "TRY", Total: 200 }],
        brokerLive: [{ Currency: "EUR", Total: 50 }],
        brokerDeleted: [{ Currency: "EUR", Total: 5 }],
        handovers: [
          {
            id: 9,
            Branch: BRANCH,
            Amount: "60.00",
            Currency: "EUR",
            Username: "worker1",
            Reason: "Runner",
            Recipient: "Ivan",
            CreatedAt: "2026-11-16 10:00:00",
            Returned: "10.00",
          },
          {
            id: 8,
            Branch: BRANCH,
            Amount: "20.00",
            Currency: "EUR",
            Username: "worker1",
            Reason: "Runner",
            Recipient: "Maria",
            CreatedAt: "2026-11-15 10:00:00",
            Returned: "20.00",
          },
        ],
      });
      const stats = await CC.getHandoverStats(db);
      eq(stats.cash.handedOver, { EUR: 60, TRY: 1000 }, "cash handed over");
      eq(stats.cash.undone, { EUR: 40, TRY: 0 }, "cash undone");
      eq(stats.cash.returnedToDrawer, { EUR: 10, TRY: 0 }, "to drawer");
      eq(stats.cash.returnedToBank, { EUR: 0, TRY: 200 }, "to bank");
      eq(stats.cash.outstanding, { EUR: 50, TRY: 800 }, "still out");
      eq(stats.balance.handedOver, { EUR: 50, TRY: 0 }, "broker handed over");
      eq(stats.balance.undone, { EUR: 5, TRY: 0 }, "broker undone");
      eq(stats.balance.outstanding, { EUR: 50, TRY: 0 }, "broker still out");
      eq(stats.handovers.length, 1, "fully returned rows are left out");
      eq(
        stats.handovers[0],
        {
          id: 9,
          Branch: BRANCH,
          Amount: 60,
          Currency: "EUR",
          Username: "worker1",
          Reason: "Runner",
          Recipient: "Ivan",
          CreatedAt: "2026-11-16 10:00:00",
          Returned: 10,
          Remaining: 50,
        },
        "the list shows what is still out"
      );
    }
  );

  await check("a hand-over with returns cannot be deleted", async () => {
    const db = makeReturnDb({ returned: 5, rows: [handover()] });
    const res = await callRoute(
      "delete",
      "/currentcash/transactions/:id",
      db,
      { params: { id: 7 } }
    );
    eq(res.code, 400, "rejected");
    eq(
      res.body,
      { error: "a hand-over with returns cannot be deleted" },
      "a clear reason"
    );
    eq(db.cashUpdates, [], "the drawer is untouched");
    eq(
      db.sql.some((q) => q.sql.startsWith("UPDATE cash_transactions")),
      false,
      "nothing is flagged"
    );
  });

  await check("a hand-over return is locked", async () => {
    const db = makeReturnDb({
      rows: [handover({ Type: "handover_return", Recipient: null })],
    });
    const del = await callRoute(
      "delete",
      "/currentcash/transactions/:id",
      db,
      { params: { id: 7 } }
    );
    eq(del.code, 400, "delete rejected");
    eq(
      del.body,
      { error: "a hand-over return cannot be edited or deleted" },
      "a clear reason"
    );

    const patch = await callRoute(
      "patch",
      "/currentcash/transactions/:id",
      db,
      { params: { id: 7 }, body: { Amount: 10 } }
    );
    eq(patch.code, 400, "edit rejected");
    eq(
      patch.body,
      { error: "a hand-over return cannot be edited or deleted" },
      "a clear reason"
    );
  });

  await check(
    "the historical walk counts a returned hand-over as money in",
    async () => {
      let sawSql = "";
      const conn = {
        query: async (text) => {
          const s = String(text).replace(/\s+/g, " ").trim();
          if (
            s.startsWith(
              "SELECT Currency, CreatedAt FROM cash_resets"
            )
          ) {
            return [[]];
          }
          if (s.includes("FROM insurance")) {
            return [[{ Currency: "EUR", Total: 100 }]];
          }
          if (s.includes("FROM cash_transactions ct")) {
            sawSql = s;
            return [
              [
                {
                  Type: "handover",
                  Amount: 30,
                  Currency: "EUR",
                  Reason: "to the safe",
                  PolicyBlanc: null,
                },
                {
                  Type: "handover_return",
                  Amount: 15,
                  Currency: "EUR",
                  Reason: "Return 3",
                  PolicyBlanc: null,
                },
              ],
            ];
          }
          throw new Error("fake DB: unhandled SQL -> " + s);
        },
      };
      const balances = await CC.getAvailableCashAsOf(
        conn,
        BRANCH,
        "2026-11-18"
      );
      ok(
        sawSql.includes("LEFT JOIN insurance"),
        "the policy join keeps a policy's own rows out of the movements"
      );
      eq(
        balances,
        { EUR: 85, TRY: 0 },
        "100 cash - 30 handed over + 15 returned"
      );
    }
  );

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();

