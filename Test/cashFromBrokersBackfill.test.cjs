"use strict";

// Node test for the one-time separation of historical broker top-ups from
// current cash (InsuranceServer/db/separateBrokerCash.js).
//
// Before "Cash from Brokers" existed, POST /brokers/:id/increase raised the
// broker's balance AND mirrored the same money into the branch's current cash, so
// it counted as Available cash. The migration
//
//   1. matches each such top-up to the cash row it was mirrored into,
//   2. gives the movement that row's Branch and Currency,
//   3. deletes the mirrored cash row,
//   4. shortens the resets that kept that money and records them as Cash from
//      Brokers resets,
//   5. takes what is left out of current_cash (never below zero).
//
// It loads the REAL server module against an in-memory fake MySQL, so the
// assertions are about the statements and amounts the deployed code writes.
//
// Run with:  node Test/cashFromBrokersBackfill.test.cjs   (or: npm test)

const { serverFile } = require("./serverPath.cjs");

const { separateBrokerCash, SETTING_NAME } = require(serverFile(
  "db",
  "separateBrokerCash.js"
));

const round = (n) => Math.round(Number(n) * 100) / 100;
const ck = (branch, currency) => `${String(branch || "")}|${currency}`;

// --- fake MySQL --------------------------------------------------------------
function makeDb() {
  const db = {
    settings: new Map(), // name -> value
    movements: [], // broker_balance_movements
    cashTransactions: [], // cash_transactions (the drawer ledger)
    cashResets: [], // cash_resets
    brokerCashResets: [], // broker_cash_resets
    currentCash: new Map(), // "branch|currency" -> number
    sqlLog: [],
  };

  db.movement = (extra = {}) => {
    const row = {
      id: db.movements.length + 1,
      BrokerId: 1,
      Amount: 100,
      Type: "increase",
      Reason: "top-up",
      Author: "admin1",
      BlancNumber: null,
      CreatedAt: "2026-10-20 10:00:00",
      Deleted: 0,
      Branch: null,
      Currency: "EUR",
    };
    Object.assign(row, extra);
    db.movements.push(row);
    return row;
  };

  db.cashRow = (extra = {}) => {
    const row = {
      id: db.cashTransactions.length + 1,
      Branch: "Branch A",
      Type: "increase",
      Amount: 100,
      Currency: "EUR",
      Username: "admin1",
      Reason: "top-up",
      CreatedAt: "2026-10-20 10:00:00",
    };
    Object.assign(row, extra);
    db.cashTransactions.push(row);
    return row;
  };

  db.reset = (extra = {}) => {
    const row = {
      id: db.cashResets.length + 1,
      Branch: "Branch A",
      Username: "admin2",
      Currency: "EUR",
      KeptAmount: 0,
      CreatedAt: "2026-10-20 18:00:00",
    };
    Object.assign(row, extra);
    db.cashResets.push(row);
    return row;
  };

  db.setCash = (branch, currency, amount) =>
    db.currentCash.set(ck(branch, currency), amount);
  db.cash = (branch, currency) => db.currentCash.get(ck(branch, currency)) || 0;

  db.query = async (sql, params = []) => {
    const s = String(sql).replace(/\s+/g, " ").trim();
    const p = params || [];
    db.sqlLog.push(s);

    if (s.startsWith("SELECT value FROM app_settings")) {
      return [db.settings.has(p[0]) ? [{ value: db.settings.get(p[0]) }] : []];
    }
    if (s.startsWith("INSERT INTO app_settings")) {
      db.settings.set(p[0], p[1]);
      return [{ affectedRows: 1 }];
    }
    // The two matching passes: the strict one also compares the reason.
    if (s.includes("JOIN cash_transactions t")) {
      const strict = /t\.Reason = m\.Reason/.test(s);
      const rows = [];
      for (const m of db.movements) {
        if (m.Type !== "increase" || m.Branch !== null) continue;
        if (Number(m.Deleted) !== 0 || !(Number(m.Amount) > 0)) continue;
        for (const t of db.cashTransactions) {
          if (t.Type !== "increase") continue;
          if (round(t.Amount) !== round(m.Amount)) continue;
          if (t.CreatedAt !== m.CreatedAt) continue;
          if (t.Username !== m.Author) continue;
          if (strict && t.Reason !== m.Reason) continue;
          rows.push({
            MovementId: m.id,
            Amount: m.Amount,
            CreatedAt: m.CreatedAt,
            CashId: t.id,
            Branch: t.Branch,
            Currency: t.Currency,
          });
        }
      }
      return [rows];
    }
    if (s.startsWith("UPDATE broker_balance_movements SET Branch = ?")) {
      const m = db.movements.find((row) => row.id === p[2]);
      if (m) {
        m.Branch = p[0];
        m.Currency = p[1];
      }
      return [{ affectedRows: m ? 1 : 0 }];
    }
    if (s.startsWith("DELETE FROM cash_transactions WHERE id IN")) {
      const ids = new Set(p[0]);
      const before = db.cashTransactions.length;
      db.cashTransactions = db.cashTransactions.filter((r) => !ids.has(r.id));
      return [{ affectedRows: before - db.cashTransactions.length }];
    }
    if (
      s.startsWith(
        "SELECT id, Username, KeptAmount, CreatedAt FROM cash_resets"
      )
    ) {
      return [
        db.cashResets
          .filter((r) => r.Branch === p[0] && r.Currency === p[1])
          .sort((a, b) =>
            a.CreatedAt === b.CreatedAt
              ? a.id - b.id
              : a.CreatedAt < b.CreatedAt
                ? -1
                : 1
          ),
      ];
    }
    if (s.startsWith("UPDATE cash_resets SET KeptAmount = ?")) {
      const r = db.cashResets.find((row) => row.id === p[1]);
      if (r) r.KeptAmount = p[0];
      return [{ affectedRows: r ? 1 : 0 }];
    }
    if (s.startsWith("INSERT INTO broker_cash_resets")) {
      db.brokerCashResets.push({
        Branch: p[0],
        Username: p[1],
        Currency: p[2],
        KeptAmount: p[3],
        LastMovementId: p[4],
        CreatedAt: p[5],
      });
      return [{ insertId: db.brokerCashResets.length }];
    }
    if (s.startsWith("SELECT CurrentCash FROM current_cash")) {
      return [[{ CurrentCash: db.cash(p[1], p[2]) }]];
    }
    if (s.startsWith("UPDATE current_cash SET CurrentCash = CurrentCash - ?")) {
      db.setCash(p[2], p[3], round(db.cash(p[2], p[3]) - Number(p[0])));
      return [{ affectedRows: 1 }];
    }
    throw new Error("fake DB: unhandled SQL -> " + s);
  };


  return db;
}

// --- tiny assert helpers ------------------------------------------------------
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
  if (a !== b) {
    throw new Error((msg || "values differ") + ` (got ${a}, want ${b})`);
  }
}
function ok(cond, msg) {
  if (!cond) throw new Error(msg || "expected truthy");
}

(async () => {
  console.log("Cash from brokers - separating historical broker top-ups");

  await check("a mirrored top-up becomes Cash from Brokers", async () => {
    const db = makeDb();
    db.movement({ Amount: 100 });
    db.cashRow({ Branch: "Branch A", Amount: 100, Currency: "EUR" });
    db.setCash("Branch A", "EUR", 100);

    const result = await separateBrokerCash(db, { now: new Date("2026-11-12T09:00:00Z") });

    eq(result.ran, true, "it ran");
    eq(result.pairs, 1, "one top-up separated");
    eq(result.groups, [
      {
        Branch: "Branch A",
        Currency: "EUR",
        Amount: 100,
        KeptByResets: 0,
        TakenFromDrawer: 100,
      },
    ], "summary");
    eq(db.movements[0].Branch, "Branch A", "the movement names the branch");
    eq(db.movements[0].Currency, "EUR", "and its currency");
    eq(db.cashTransactions, [], "the mirrored cash row is gone");
    eq(db.cash("Branch A", "EUR"), 0, "the drawer no longer holds it");
    eq(db.brokerCashResets, [], "no reset happened");
    ok(db.settings.has(SETTING_NAME), "the run is marked in app_settings");
  });


  await check("a later reset takes the money out of both balances", async () => {
    const db = makeDb();
    db.movement({ Amount: 100 });
    db.cashRow({ Branch: "Branch A", Amount: 100 });
    // The drawer was reset that evening with 100 in it (the broker money).
    db.reset({ Branch: "Branch A", Currency: "EUR", KeptAmount: 100, Username: "admin2" });
    db.setCash("Branch A", "EUR", 0);

    const result = await separateBrokerCash(db);

    eq(result.pairs, 1, "separated");
    eq(db.cashResets[0].KeptAmount, 0, "the cash reset no longer keeps it");
    eq(db.brokerCashResets, [
      {
        Branch: "Branch A",
        Username: "admin2",
        Currency: "EUR",
        KeptAmount: 100,
        LastMovementId: 1,
        CreatedAt: "2026-10-20 18:00:00",
      },
    ], "the same amount is kept as a Cash from Brokers reset");
    eq(db.cash("Branch A", "EUR"), 0, "the drawer was already empty");
    eq(result.groups[0].KeptByResets, 100, "summary: kept by resets");
    eq(result.groups[0].TakenFromDrawer, 0, "summary: nothing left in the drawer");
  });

  await check("the currency comes from the mirrored cash row", async () => {
    const db = makeDb();
    // Movements recorded before the change always store the default EUR, while
    // the money may have been handed over in lira.
    db.movement({ Amount: 200, Currency: "EUR" });
    db.cashRow({ Branch: "Branch A", Amount: 200, Currency: "TRY" });
    db.setCash("Branch A", "TRY", 200);

    await separateBrokerCash(db);

    eq(db.movements[0].Currency, "TRY", "the cash row's currency wins");
    eq(db.cash("Branch A", "TRY"), 0, "taken out of the TRY drawer");
    eq(db.cash("Branch A", "EUR"), 0, "the EUR drawer is untouched");
  });

  await check("only unmatched manual top-ups are separated", async () => {
    const db = makeDb();
    // A refund of an annulled policy raises the balance but is not money handed
    // over, so it has no branch and no mirrored cash row.
    db.movement({ Amount: 50, Type: "annulment", Reason: "Annul 123" });
    // A top-up whose movement was deleted in the broker's history.
    db.movement({ Amount: 30, Deleted: 1 });
    db.cashRow({ Branch: "Branch A", Amount: 30 });
    // A top-up that is already separated (it carries a branch).
    db.movement({ Amount: 40, Branch: "Branch B", Currency: "EUR" });
    // A top-up whose mirrored cash row was edited into another amount.
    db.movement({ Amount: 60 });
    // ... and the one the migration can match.
    db.movement({ Amount: 70 });
    db.cashRow({ Branch: "Branch A", Amount: 70 });

    const result = await separateBrokerCash(db);

    eq(result.pairs, 1, "one pair");
    eq(
      db.movements.map((m) => [m.Amount, m.Branch]),
      [[50, null], [30, null], [40, "Branch B"], [60, null], [70, "Branch A"]],
      "only the matched top-up is re-labelled"
    );
    eq(
      db.cashTransactions.map((r) => r.Amount),
      [30],
      "only the matched cash row is removed"
    );
  });

  await check("the drawer is never driven below zero", async () => {
    const db = makeDb();
    const warnings = [];
    db.movement({ Amount: 100 });
    db.cashRow({ Branch: "Branch A", Amount: 100 });
    // 60 of the broker money was already spent as cash.
    db.setCash("Branch A", "EUR", 40);

    const result = await separateBrokerCash(db, { log: (m) => warnings.push(m) });

    eq(db.cash("Branch A", "EUR"), 0, "clamped at zero");
    eq(result.groups[0].TakenFromDrawer, 40, "what was actually taken");
    eq(warnings.length, 1, "the shortfall is reported");
    ok(/already spent as cash/.test(warnings[0]), warnings[0]);
  });


  await check("a top-up and a cash row are paired only once", async () => {
    const db = makeDb();
    // Two identical top-ups (same amount, user, time and reason) mirrored into
    // two identical cash rows.
    db.movement({ Amount: 50 });
    db.movement({ Amount: 50 });
    db.cashRow({ Branch: "Branch A", Amount: 50 });
    db.cashRow({ Branch: "Branch A", Amount: 50 });
    db.setCash("Branch A", "EUR", 100);

    const result = await separateBrokerCash(db);

    eq(result.pairs, 2, "one cash row per top-up");
    eq(db.movements.map((m) => m.Branch), ["Branch A", "Branch A"], "both re-labelled");
    eq(db.cashTransactions, [], "both cash rows removed");
    eq(db.cash("Branch A", "EUR"), 0, "the drawer gives back exactly 100");
  });

  await check("an ambiguous amount is left alone", async () => {
    const db = makeDb();
    // Two top-ups of the same amount at the same second, but only one mirrored
    // cash row: it is not clear which one it belongs to, so neither is touched.
    db.movement({ Amount: 25, Reason: "first" });
    db.movement({ Amount: 25, Reason: "second" });
    db.cashRow({ Branch: "Branch A", Amount: 25, Reason: "original" });
    db.setCash("Branch A", "EUR", 25);

    const result = await separateBrokerCash(db);

    eq(result.pairs, 0, "nothing separated");
    eq(db.movements.map((m) => m.Branch), [null, null], "movements untouched");
    eq(db.cashTransactions.length, 1, "the cash row stays");
    eq(db.cash("Branch A", "EUR"), 25, "so does the drawer balance");
  });

  await check("an edited reason still matches when it is the only candidate", async () => {
    const db = makeDb();
    db.movement({ Amount: 80, Reason: "handed over at the office" });
    db.cashRow({ Branch: "Branch A", Amount: 80, Reason: "broker top-up" });
    db.setCash("Branch A", "EUR", 80);

    const result = await separateBrokerCash(db);

    eq(result.pairs, 1, "matched without the reason");
    eq(db.movements[0].Branch, "Branch A", "re-labelled");
    eq(db.cashTransactions, [], "mirrored row removed");
    eq(db.cash("Branch A", "EUR"), 0, "drawer cleared");
  });

  await check("it runs only once", async () => {
    const db = makeDb();
    db.movement({ Amount: 100 });
    db.cashRow({ Branch: "Branch A", Amount: 100 });
    db.setCash("Branch A", "EUR", 100);

    const first = await separateBrokerCash(db);
    eq(first.ran, true, "the first run separates");

    // A second top-up made after the change must never be touched by it.
    db.movement({ Amount: 10, Branch: "Branch B", Currency: "EUR" });
    const second = await separateBrokerCash(db);

    eq(second.ran, false, "the second run does nothing");
    eq(second.pairs, 0, "no pairs");
    eq(db.movements[1].Branch, "Branch B", "the new top-up keeps its branch");
    eq(db.settings.get(SETTING_NAME) !== undefined, true, "the marker stays");
  });

  await check("several branches are separated independently", async () => {
    const db = makeDb();
    db.movement({ Amount: 100, CreatedAt: "2026-10-20 10:00:00" });
    db.cashRow({ Branch: "Branch A", Amount: 100, CreatedAt: "2026-10-20 10:00:00" });
    db.movement({ Amount: 40, CreatedAt: "2026-10-20 11:00:00" });
    db.cashRow({ Branch: "Branch B", Amount: 40, CreatedAt: "2026-10-20 11:00:00" });
    db.reset({ Branch: "Branch B", Currency: "EUR", KeptAmount: 40 });
    db.setCash("Branch A", "EUR", 100);
    db.setCash("Branch B", "EUR", 0);

    const result = await separateBrokerCash(db);

    eq(result.pairs, 2, "both separated");
    eq(
      result.groups.map((g) => [g.Branch, g.Amount, g.TakenFromDrawer]),
      [["Branch A", 100, 100], ["Branch B", 40, 0]],
      "each branch keeps its own figures"
    );
    eq(db.cash("Branch A", "EUR"), 0, "Branch A's drawer cleared");
    eq(db.cashResets[0].KeptAmount, 0, "Branch B's reset shortened");
    eq(db.brokerCashResets.length, 1, "Branch B's reset recorded");
  });


  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();

