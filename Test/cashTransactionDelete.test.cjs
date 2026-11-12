"use strict";

// Node test for DELETE /currentcash/transactions/:id - the admin-only "X" on a
// row of the Current cash screen's Transactions list.
//
// "Deleting" a ledger entry is a SOFT delete: the row stays in
// `cash_transactions`, flagged with Deleted/DeletedAt/DeletedBy, but it stops
// counting anywhere (the day's ledger, its expenses, the daily report's cash
// net and the historical balance walk). The money the entry moved is reversed
// on the drawer - an increase is taken back off, a reduction is put back in -
// and the same reversal is written to the Total cash ledger, so both records of
// cash flow keep listing the same movements.
//
// The route lives in InsuranceServer/Requests/CurrentCash.js (see
// Test/serverPath.cjs). This test loads the REAL file in a vm with only
// `express` and `./Auth.js` stubbed, registers the routes on a fake router and
// calls the DELETE handler directly with a fake req/res and an in-memory fake
// MySQL, so it asserts what the deployed code actually asks MySQL to do.
//
// Run with:  node Test/cashTransactionDelete.test.cjs   (or: npm test)

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

// --- load the real module ----------------------------------------------------
const routes = [];
// Every `requireRole(...)` call, so the admin-only gate of the DELETE route can
// be asserted by the roles it was registered with.
const roleChecks = [];

const recorder = (method) => (routePath, ...handlers) => {
  routes.push({ method, path: routePath, handlers });
};
const fakeRouter = {
  get: recorder("get"),
  post: recorder("post"),
  put: recorder("put"),
  patch: recorder("patch"),
  delete: recorder("delete"),
  use: () => {},
};

function loadCurrentCash() {
  const mod = { exports: {} };
  const CTX = { console, module: mod, exports: mod.exports, Buffer, process };
  const stubs = {
    express: { Router: () => fakeRouter },
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

// The handlers close over the connection the router is built with, so every
// test builds a fresh router bound to its own fake DB. This also re-registers
// the routes (and re-runs their role gates).
function buildRouter(db) {
  routes.length = 0;
  const mod = loadCurrentCash();
  mod.createCurrentCashRouter(db);
  return mod;
}

// --- fake MySQL --------------------------------------------------------------
// Understands only the statements the DELETE route needs; anything else is a
// hard error, so a changed query cannot silently slip through the test.
function makeDb({ rows = [], balance = 0 } = {}) {
  const sql = []; // every statement, normalized + params
  const ledger = []; // rows written to total_cash_transactions
  const cashUpdates = []; // UPDATE current_cash ...
  const softDeletes = []; // UPDATE cash_transactions SET Deleted = ...
  const state = { balance, committed: false, rolledBack: false };

  const query = async (text, params = []) => {
    const s = String(text).replace(/\s+/g, " ").trim();
    sql.push({ sql: s, params });

    if (s.startsWith("SELECT * FROM cash_transactions")) return [[...rows]];
    if (s.startsWith("INSERT IGNORE INTO current_cash")) return [{}];
    if (s.startsWith("SELECT CurrentCash FROM current_cash")) {
      return [[{ CurrentCash: state.balance }]];
    }
    if (s.startsWith("UPDATE current_cash SET CurrentCash = CurrentCash +")) {
      state.balance += Number(params[0]);
      cashUpdates.push({ type: "increase", amount: Number(params[0]) });
      return [{}];
    }
    if (s.startsWith("UPDATE current_cash SET CurrentCash = CurrentCash -")) {
      if (Number(params[0]) > state.balance) {
        throw new Error("insufficient current cash for reduction");
      }
      state.balance -= Number(params[0]);
      cashUpdates.push({ type: "reduce", amount: Number(params[0]) });
      return [{}];
    }
    if (s.startsWith("INSERT IGNORE INTO total_cash")) return [{}];
    if (s.startsWith("INSERT INTO total_cash_transactions")) {
      ledger.push(params);
      return [{}];
    }
    if (s.startsWith("UPDATE cash_transactions SET Deleted = 1")) {
      softDeletes.push(params);
      return [{ affectedRows: 1 }];
    }
    throw new Error("fake DB: unhandled SQL -> " + s);
  };

  return {
    query,
    // The real connection helper commits on resolve and rolls back on throw.
    withTransaction: async (fn) => {
      try {
        const result = await fn({ query });
        state.committed = true;
        return result;
      } catch (err) {
        state.rolledBack = true;
        throw err;
      }
    },
    state,
    sql,
    ledger,
    cashUpdates,
    softDeletes,
  };
}

// --- call a route ------------------------------------------------------------
function route(method, path) {
  const found = routes.find((r) => r.method === method && r.path === path);
  ok(found, `${method.toUpperCase()} ${path} is registered`);
  return found;
}

async function callDelete(db, { id, body = {}, user = "admin1" } = {}) {
  buildRouter(db);
  const r = route("delete", "/currentcash/transactions/:id");
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
  await r.handlers[r.handlers.length - 1](
    { params: { id: String(id) }, body, user: { username: user } },
    res
  );
  return res;
}

const txRow = (over = {}) => ({
  id: 1,
  Branch: "Офис Харманли",
  Type: "increase",
  Amount: "50.00",
  Currency: "EUR",
  Username: "worker1",
  Reason: "Top up",
  CreatedAt: "2026-12-11 09:00:00",
  Deleted: 0,
  DeletedAt: null,
  DeletedBy: null,
  ...over,
});

(async () => {
  // --- the route itself ------------------------------------------------------
  check("DELETE /currentcash/transactions/:id is registered", () => {
    buildRouter({});
    const r = route("delete", "/currentcash/transactions/:id");
    eq(r.handlers.length, 3, "auth + role gate + handler");
  });

  check("the delete route is admin-only (role 1)", () => {
    buildRouter({});
    // The router is built once, in order: the shared cash role gate first, then
    // the admin gate of the DELETE route.
    eq(roleChecks[roleChecks.length - 1], [1], "requireRole(1)");
  });

  // --- deleting an increase takes the money back off the drawer ---------------
  await checkAsync("delete an increase: the drawer is reduced", async () => {
    const db = makeDb({ rows: [txRow()], balance: 50 });
    const res = await callDelete(db, {
      id: 1,
      body: { CreatedAt: "2026-12-11 10:30:00" },
    });

    eq(res.code, 200, "status");
    eq(res.body.reversed, 50, "reversed amount");
    eq(res.body.type, "reduce", "the reversal is a reduction");
    eq(res.body.currency, "EUR", "currency");
    eq(db.cashUpdates, [{ type: "reduce", amount: 50 }], "drawer reduced");
    eq(db.state.balance, 0, "balance after the deletion");
  });

  await checkAsync(
    "delete an increase: the Total cash ledger gets the reversal",
    async () => {
      const db = makeDb({ rows: [txRow()], balance: 50 });
      await callDelete(db, {
        id: 1,
        body: { CreatedAt: "2026-12-11 10:30:00" },
      });

      eq(db.ledger.length, 1, "one Total cash row");
      // (Branch, Type, Amount, Currency, Source, Username, Reason, CreatedAt)
      eq(db.ledger[0][0], "Офис Харманли", "branch");
      eq(db.ledger[0][1], "reduce", "type");
      eq(db.ledger[0][2], 50, "amount");
      eq(db.ledger[0][3], "EUR", "currency");
      eq(db.ledger[0][4], "Cash", "source");
      eq(db.ledger[0][5], "admin1", "admin who deleted it");
      eq(db.ledger[0][6], "Delete of cash transaction #1", "reason");
      eq(db.ledger[0][7], "2026-12-11 10:30:00", "client's local time");
    }
  );

  await checkAsync("delete: the row is soft-deleted, never removed", async () => {
    const db = makeDb({ rows: [txRow()], balance: 50 });
    await callDelete(db, { id: 1, body: { CreatedAt: "2026-12-11 10:30:00" } });

    eq(db.softDeletes.length, 1, "one UPDATE");
    eq(
      db.softDeletes[0],
      ["2026-12-11 10:30:00", "admin1", 1],
      "DeletedAt/DeletedBy/id"
    );
    ok(
      !db.sql.some((s) => /^DELETE FROM/i.test(s.sql)),
      "nothing is physically deleted"
    );
    eq(db.state.committed, true, "committed");
  });

  // --- deleting a reduction puts the money back -------------------------------
  await checkAsync("delete a reduction: the drawer gets the money back", async () => {
    const db = makeDb({
      rows: [txRow({ id: 7, Type: "reduce", Amount: "30.00", Reason: "Rent" })],
      balance: 100,
    });
    const res = await callDelete(db, {
      id: 7,
      body: { CreatedAt: "2026-12-11 11:00:00" },
    });

    eq(res.code, 200, "status");
    eq(res.body.type, "increase", "the reversal is an increase");
    eq(db.cashUpdates, [{ type: "increase", amount: 30 }], "drawer increased");
    eq(db.state.balance, 130, "balance after the deletion");
    eq(db.ledger[0][1], "increase", "Total cash reversal type");
    eq(db.ledger[0][6], "Delete of cash transaction #7", "reason names the row");
  });


  // --- guards -----------------------------------------------------------------
  await checkAsync("an unknown transaction is a 404 and moves nothing", async () => {
    const db = makeDb({ rows: [], balance: 100 });
    const res = await callDelete(db, { id: 999 });

    eq(res.code, 404, "status");
    eq(res.body, { error: "Transaction not found" }, "error");
    eq(db.cashUpdates, [], "no drawer movement");
    eq(db.softDeletes, [], "nothing flagged");
  });

  await checkAsync("a deleted transaction cannot be deleted twice", async () => {
    const db = makeDb({ rows: [txRow({ Deleted: 1 })], balance: 100 });
    const res = await callDelete(db, { id: 1 });

    eq(res.code, 400, "status");
    eq(res.body, { error: "Transaction already deleted" }, "error");
    eq(db.cashUpdates, [], "no drawer movement");
    eq(db.ledger, [], "no Total cash row");
  });

  await checkAsync("a reversal the drawer cannot fund changes nothing", async () => {
    const db = makeDb({ rows: [txRow()], balance: 10 });
    const res = await callDelete(db, { id: 1 });

    eq(res.code, 400, "status");
    eq(res.body, { error: "insufficient current cash for reduction" }, "error");
    eq(db.ledger, [], "no Total cash row");
    eq(db.softDeletes, [], "the row stays live");
    eq(db.state.rolledBack, true, "rolled back");
  });

  await checkAsync("a bad CreatedAt is rejected before any money moves", async () => {
    const db = makeDb({ rows: [txRow()], balance: 50 });
    const res = await callDelete(db, {
      id: 1,
      body: { CreatedAt: "11.12.2026" },
    });

    eq(res.code, 400, "status");
    eq(db.cashUpdates, [], "no drawer movement");
    eq(db.softDeletes, [], "nothing flagged");
  });

  // --- the correction route refuses a deleted row ------------------------------
  await checkAsync("PATCH refuses to correct a deleted entry", async () => {
    const db = makeDb({ rows: [txRow({ Deleted: 1 })] });
    buildRouter(db);
    const r = route("patch", "/currentcash/transactions/:id");
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
    await r.handlers[r.handlers.length - 1](
      {
        params: { id: "1" },
        body: { Amount: 60 },
        user: { username: "worker1" },
      },
      res
    );
    eq(res.code, 400, "status");
    eq(res.body, { error: "Transaction already deleted" }, "error");
  });

  // --- deleted rows are excluded from the reads --------------------------------
  await checkAsync("the historical balance walk ignores deleted entries", async () => {
    // getCurrentCashAsOf only needs current_cash and the two history queries.
    const conn = {
      query: async (text) => {
        const s = String(text).replace(/\s+/g, " ").trim();
        if (s.startsWith("INSERT IGNORE INTO current_cash")) return [{}];
        if (s.startsWith("SELECT Currency, CurrentCash FROM current_cash")) {
          return [[]];
        }
        if (s.startsWith("SELECT Currency, ROUND(SUM(CASE WHEN Type = 'increase'")) {
          ok(s.includes("Deleted = 0"), "the movements query skips deleted rows");
          return [[]];
        }
        if (s.startsWith("SELECT Currency, ROUND(SUM(KeptAmount)")) return [[]];
        throw new Error("fake DB: unhandled SQL -> " + s);
      },
    };
    const balances = await CC.getCurrentCashAsOf(
      conn,
      "Офис Харманли",
      "2026-12-12"
    );
    eq(balances, { EUR: 0, TRY: 0 }, "no movement counted");
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
