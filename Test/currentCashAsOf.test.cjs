"use strict";

// Node test for the server's as-of shift close
// (planBranchAsOf / applyBranchAsOf in InsuranceServer/Requests/CurrentCash.js).
//
// At midnight the branch hands over its current cash, card balance and Cash
// from Brokers. The split is computed from movement timestamps:
//   kept at the cutoff  -> recorded in the resets at the cutoff
//   recorded afterwards -> stays in the live balances
//
// The test loads the REAL server file against an in-memory fake MySQL.
//
// Run with:  node Test/currentCashAsOf.test.cjs   (or: npm test)

const { serverFile } = require("./serverPath.cjs");
const { planBranchAsOf, applyBranchAsOf } = require(
  serverFile("Requests", "CurrentCash.js")
);

const round = (n) => Math.round(Number(n) * 100) / 100;
const ck = (branch, currency) => `${String(branch || "")}|${currency}`;
const CUTOFF = "2026-11-13 23:59:59";

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log("  PASS  " + name);
  } catch (err) {
    failed++;
    console.log("  FAIL  " + name);
    console.log("        " + (err && err.stack ? err.stack : err));
  }
}
function eq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${label}: expected ${e}, got ${a}`);
}

function makeDb() {
  const db = {
    currentCash: new Map(),
    cashTransactions: [],
    cashResets: [],
    cardParts: new Map(),
    totalCashTransactions: [],
    cardResets: [],
    brokerMovements: [],
    brokerCashResets: [],
    branchCard: new Map(),
    sqlLog: [],
  };

  db.setCash = (branch, currency, amount) =>
    db.currentCash.set(ck(branch, currency), amount);
  db.cash = (branch, currency) =>
    db.currentCash.get(ck(branch, currency)) || 0;
  db.setCardPart = (branch, currency, amount) =>
    db.cardParts.set(ck(branch, currency), amount);
  db.cardPart = (branch, currency) =>
    db.cardParts.get(ck(branch, currency)) || 0;
  db.setCard = (branch, amount) => db.branchCard.set(branch, amount);
  db.card = (branch) => db.branchCard.get(branch) || 0;

  db.query = async (sql, params = []) => {
    const s = String(sql).replace(/\s+/g, " ").trim();
    const p = params || [];
    db.sqlLog.push(s);

    // Later resets check.
    if (s.startsWith("SELECT (SELECT COUNT(*) FROM cash_resets")) {
      const b = p[0];
      const cut = p[1];
      const count = (rows, branch) =>
        rows.filter((r) => r.Branch === branch && r.CreatedAt >= cut).length;
      return [
        [
          {
            CashResets: count(db.cashResets, b),
            CardResets: count(db.cardResets, b),
            BrokerResets: count(db.brokerCashResets, b),
          },
        ],
      ];
    }

    // Current cash row.
    if (s.startsWith("SELECT Currency, CurrentCash FROM current_cash")) {
      const b = p[1];
      const rows = ["EUR", "TRY"]
        .filter((c) => db.currentCash.has(ck(b, c)))
        .map((c) => ({ Currency: c, CurrentCash: db.cash(b, c) }));
      return [rows];
    }

    // Cash movements after the cutoff.
    if (
      s.startsWith("SELECT Currency, ROUND(SUM(CASE WHEN Type = 'increase'") &&
      s.includes("FROM cash_transactions")
    ) {
      const b = p[0];
      const cut = p[1];
      const totals = {};
      for (const row of db.cashTransactions) {
        if (row.Branch !== b || Number(row.Deleted) !== 0) continue;
        if (row.CreatedAt < cut) continue;
        totals[row.Currency] =
          (totals[row.Currency] || 0) +
          (row.Type === "increase" ? row.Amount : -row.Amount);
      }
      return [
        Object.entries(totals).map(([Currency, Net]) => ({
          Currency,
          Net: round(Net),
        })),
      ];
    }

    // Card parts.
    if (s.startsWith("SELECT Currency, CardPart FROM total_cash")) {
      const b = p[1];
      const rows = ["EUR", "TRY"]
        .filter((c) => db.cardParts.has(ck(b, c)))
        .map((c) => ({ Currency: c, CardPart: db.cardPart(b, c) }));
      return [rows];
    }

    // Card movements after the cutoff (total cash ledger, Source = Card).
    if (
      s.startsWith("SELECT Currency, ROUND(SUM(CASE WHEN Type = 'increase'") &&
      s.includes("FROM total_cash_transactions")
    ) {
      const b = p[0];
      const cut = p[1];
      const totals = {};
      for (const row of db.totalCashTransactions) {
        if (row.Branch !== b || row.Source !== "Card") continue;
        if (row.CreatedAt < cut) continue;
        totals[row.Currency] =
          (totals[row.Currency] || 0) +
          (row.Type === "increase" ? row.Amount : -row.Amount);
      }
      return [
        Object.entries(totals).map(([Currency, Net]) => ({
          Currency,
          Net: round(Net),
        })),
      ];
    }

    // Broker reset marker.
    if (s.startsWith("SELECT COALESCE(MAX(LastMovementId), 0) AS Marker")) {
      const branch = p[0];
      const rows = db.brokerCashResets.filter((r) => r.Branch === branch);
      const marker = rows.length
        ? Math.max(...rows.map((r) => Number(r.LastMovementId) || 0))
        : 0;
      return [[{ Marker: marker }]];
    }

    // Broker live / as-of / through.
    if (s.includes("FROM broker_balance_movements m")) {
      const branch = p[0];
      const afterId = Number(p[1]) || 0;
      const beforeCutoff = s.includes("m.CreatedAt < ?");
      const cut = beforeCutoff ? p[2] : null;
      const base = db.brokerMovements.filter(
        (m) =>
          m.Branch === branch &&
          Number(m.id) > afterId &&
          m.Type === "increase" &&
          Number(m.Deleted) === 0 &&
          Number(m.Amount) > 0 &&
          (!beforeCutoff || m.CreatedAt < cut)
      );
      if (s.includes("COALESCE(MAX(m.id), 0) AS ThroughId")) {
        const through = base.length
          ? Math.max(...base.map((m) => Number(m.id)))
          : 0;
        return [[{ ThroughId: through }]];
      }
      const totals = {};
      for (const m of base) {
        totals[m.Currency] = (totals[m.Currency] || 0) + Number(m.Amount);
      }
      return [
        Object.entries(totals).map(([Currency, Total]) => ({
          Currency,
          Total: round(Total),
        })),
      ];
    }

    // Apply writes ------------------------------------------------------------
    if (s.startsWith("INSERT IGNORE INTO current_cash")) {
      const branch = p[1];
      const currency = p[2];
      if (!db.currentCash.has(ck(branch, currency))) {
        db.setCash(branch, currency, 0);
      }
      return [{ affectedRows: 1 }];
    }
    if (s.startsWith("INSERT IGNORE INTO total_cash")) {
      const branch = p[1];
      const currency = p[2];
      if (!db.cardParts.has(ck(branch, currency))) {
        db.setCardPart(branch, currency, 0);
      }
      return [{ affectedRows: 1 }];
    }
    if (s.startsWith("INSERT IGNORE INTO branch_card_balance")) {
      const branch = p[0];
      if (!db.branchCard.has(branch)) db.setCard(branch, 0);
      return [{ affectedRows: 1 }];
    }
    if (s.startsWith("UPDATE current_cash SET CurrentCash = ?")) {
      const amount = p[0];
      const branch = p[2];
      const currency = p[3];
      db.setCash(branch, currency, Number(amount));
      return [{ affectedRows: 1 }];
    }
    if (s.startsWith("INSERT INTO cash_resets")) {
      db.cashResets.push({
        Branch: p[0],
        Username: p[1],
        Currency: p[2],
        KeptAmount: p[3],
        CreatedAt: p[4],
      });
      return [{ insertId: db.cashResets.length }];
    }
    if (s.startsWith("INSERT INTO total_cash_transactions")) {
      db.totalCashTransactions.push({
        Branch: p[0],
        Type: p[1],
        Amount: p[2],
        Currency: p[3],
        Source: p[4],
        Username: p[5],
        Reason: p[6],
        CreatedAt: p[7],
      });
      return [{ insertId: db.totalCashTransactions.length }];
    }
    if (s.startsWith("UPDATE total_cash SET CardPart = ?")) {
      const amount = p[0];
      const branch = p[2];
      const currency = p[3];
      db.setCardPart(branch, currency, Number(amount));
      return [{ affectedRows: 1 }];
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
    if (s.startsWith("UPDATE branch_card_balance SET CardBalance = ?")) {
      const amount = p[0];
      const branch = p[1];
      db.setCard(branch, Number(amount));
      return [{ affectedRows: 1 }];
    }
    if (s.startsWith("INSERT INTO card_resets")) {
      db.cardResets.push({
        Branch: p[0],
        Username: p[1],
        KeptAmount: p[2],
        CreatedAt: p[3],
      });
      return [{ insertId: db.cardResets.length }];
    }

    throw new Error("fake DB: unhandled SQL -> " + s);
  };

  return db;
}

function seed() {
  const db = makeDb();
  // Cash: 150 live, 50 recorded after midnight -> 100 kept, 50 stays.
  db.setCash("Branch A", "EUR", 150);
  db.setCash("Branch A", "TRY", 0);
  db.cashTransactions.push({
    id: 1,
    Branch: "Branch A",
    Type: "increase",
    Amount: 50,
    Currency: "EUR",
    Deleted: 0,
    CreatedAt: "2026-11-14 09:00:00",
  });

  // Card: 80 live, 30 recorded after midnight -> 50 kept, 30 stays.
  db.setCardPart("Branch A", "EUR", 80);
  db.setCardPart("Branch A", "TRY", 0);
  db.setCard("Branch A", 80);
  db.totalCashTransactions.push({
    id: 1,
    Branch: "Branch A",
    Type: "increase",
    Amount: 30,
    Currency: "EUR",
    Source: "Card",
    CreatedAt: "2026-11-14 10:00:00",
  });

  // Cash from brokers: 20 before midnight, 5 after -> 20 kept, 5 stays.
  db.brokerMovements.push({
    id: 1,
    Branch: "Branch A",
    Type: "increase",
    Amount: 20,
    Currency: "EUR",
    Deleted: 0,
    CreatedAt: "2026-11-13 12:00:00",
  });
  db.brokerMovements.push({
    id: 2,
    Branch: "Branch A",
    Type: "increase",
    Amount: 5,
    Currency: "EUR",
    Deleted: 0,
    CreatedAt: "2026-11-14 11:00:00",
  });
  return db;
}

console.log("current cash as-of: split cash, card and broker cash at midnight");

(async () => {
  await check("plan keeps midnight amounts and leaves later movements live", async () => {
    const db = seed();
    const plan = await planBranchAsOf(db, "Branch A", CUTOFF);
    eq(
      plan.kept,
      {
        cash: { EUR: 100, TRY: 0 },
        card: 50,
        brokerCash: { EUR: 20, TRY: 0 },
      },
      "kept"
    );
    eq(
      plan.remaining,
      {
        cash: { EUR: 50, TRY: 0 },
        card: 30,
        brokerCash: { EUR: 5, TRY: 0 },
      },
      "remaining"
    );
    eq(plan.brokerThrough, 1, "last pre-cutoff top-up");
    eq(db.cashResets.length, 0, "plan is read-only");
    eq(db.cardResets.length, 0, "no card reset written");
    eq(db.brokerCashResets.length, 0, "no broker reset written");
  });

  await check("apply writes the split balances and reset rows", async () => {
    const db = seed();
    const plan = await planBranchAsOf(db, "Branch A", CUTOFF);
    await applyBranchAsOf(db, "Branch A", "admin1", plan);

    eq(db.cash("Branch A", "EUR"), 50, "today's cash");
    eq(db.cash("Branch A", "TRY"), 0, "empty TRY drawer");
    eq(db.card("Branch A"), 30, "today's card balance");
    eq(db.cardPart("Branch A", "EUR"), 30, "today's card part");
    eq(
      db.brokerMovements
        .filter((m) => m.id > 1)
        .reduce((sum, m) => sum + m.Amount, 0),
      5,
      "today's Cash from Brokers remains"
    );

    eq(
      db.cashResets
        .filter((r) => r.Branch === "Branch A")
        .map((r) => [r.Currency, r.KeptAmount, r.CreatedAt]),
      [
        ["EUR", 100, CUTOFF],
        ["TRY", 0, CUTOFF],
      ],
      "cash reset rows"
    );
    eq(
      db.cardResets.map((r) => [r.KeptAmount, r.CreatedAt]),
      [[50, CUTOFF]],
      "card reset row"
    );
    eq(
      db.brokerCashResets.map((r) => [
        r.Currency,
        r.KeptAmount,
        r.LastMovementId,
        r.CreatedAt,
      ]),
      [["EUR", 20, 1, CUTOFF]],
      "broker cash reset row"
    );

    const total = db.totalCashTransactions.filter(
      (r) => r.CreatedAt === CUTOFF
    );
    eq(
      total.map((r) => [r.Type, r.Amount, r.Source, r.Currency]),
      [
        ["reduce", 100, "Cash", "EUR"],
        ["reduce", 50, "Card", "EUR"],
      ],
      "Total cash follows the handover"
    );
  });

  await check("refuses when a reset exists at or after the cutoff", async () => {
    const db = seed();
    db.cashResets.push({
      Branch: "Branch A",
      Currency: "EUR",
      KeptAmount: 10,
      CreatedAt: "2026-11-14 00:00:00",
    });
    const plan = await planBranchAsOf(db, "Branch A", CUTOFF);
    eq(
      plan.error,
      "A shift has already been closed at or after this cutoff",
      "refusal"
    );
  });

  await check("refuses when today's cash is below midnight", async () => {
    const db = seed();
    // 50 in but 100 out after midnight -> today's net is -50.
    db.cashTransactions.push({
      id: 2,
      Branch: "Branch A",
      Type: "reduce",
      Amount: 100,
      Currency: "EUR",
      Deleted: 0,
      CreatedAt: "2026-11-14 12:00:00",
    });
    const plan = await planBranchAsOf(db, "Branch A", CUTOFF);
    eq(
      plan.error,
      "Today's cash is below the midnight balance for EUR",
      "negative remaining cash"
    );
  });

  await check("refuses when the cutoff cash is negative", async () => {
    const db = seed();
    db.setCash("Branch A", "EUR", 20); // kept would be -30
    const plan = await planBranchAsOf(db, "Branch A", CUTOFF);
    eq(
      plan.error,
      "The cash balance at the cutoff is negative for EUR",
      "negative kept cash"
    );
  });

  console.log(`\ncurrentCashAsOf: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();

