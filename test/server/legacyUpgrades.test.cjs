"use strict";

// Node test for the server's one-off upgrades
// (InsuranceServer/db/legacy-upgrades.js) and the read-only payments audit
// (InsuranceServer/db/check-broker-payments.js).
//
// These replaced the SQL files that used to live in this repository's
// `migrations/` folder, so what matters is that they keep the same rules:
//
//   - the TRY price raise touches only the known OLD prices (an admin's later
//     price is never reverted) and writes nothing without --apply;
//   - the number swap only takes rows whose PolicyNumber is 6 characters and
//     BlancNumber 8, refuses a blanc that is already in use, and relabels
//     `<blanc>`, `Edit <blanc>` and `Annul <blanc>` in both cash ledgers;
//   - the UTC -> local shift refuses to run twice (its backup tables are the
//     guard) and writes nothing without --apply;
//   - the payments audit keeps the balance formula the server recalculates with.
//
// Run with:  node test/server/legacyUpgrades.test.cjs   (or: npm test)

const { serverFile } = require("../serverPath.cjs");

const UPGRADES_JS = serverFile("db", "legacy-upgrades.js");
const PAYMENTS_JS = serverFile("db", "check-broker-payments.js");
const {
  nextTryPrice,
  raiseTurkishLiraTariffs,
  classifyNumberSwap,
  swapMisplacedNumbers,
  shiftLegacyTimestamps,
  normalizeHours,
  CASH_LEDGER_TABLES,
} = require(UPGRADES_JS);
const { formulaBalance, loadPaymentChecks } = require(PAYMENTS_JS);

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
const flat = (sql) => String(sql).replace(/\s+/g, " ").trim();

// A connection stub: every statement is matched by a handler and recorded, so a
// test can assert both the result and what was written.
function fakeConn(handlers = {}) {
  const log = [];
  const conn = {
    log,
    queries: () => log.map((q) => flat(q.sql)),
    wrote: (needle) =>
      log.some((q) => /^(INSERT|UPDATE|CREATE)/.test(flat(q.sql)) && flat(q.sql).includes(needle)),
    beginTransaction: async () => log.push({ sql: "BEGIN" }),
    commit: async () => log.push({ sql: "COMMIT" }),
    rollback: async () => log.push({ sql: "ROLLBACK" }),
    query: async (sql, params) => {
      log.push({ sql, params });
      for (const [needle, handler] of Object.entries(handlers)) {
        if (flat(sql).includes(needle)) return handler(params, sql);
      }
      return [{}];
    },
  };
  return conn;
}

(async () => {
  // ---------------------------------------------------------------- TRY prices

  await check("only the known old TRY prices are raised", () => {
    eq(nextTryPrice(30, 2000), 2050, "1 month: 2 000 -> 2 050");
    eq(nextTryPrice(90, "2200.00"), 2300, "3 months: 2 200 -> 2 300");
    eq(nextTryPrice(15, 1600), null, "15 days did not change");
    eq(nextTryPrice(30, 2050), null, "an already raised row is left alone");
    eq(nextTryPrice(30, 1700), null, "a price an admin set is never reverted");
    eq(nextTryPrice(45, 2000), null, "only the three Auto durations are involved");
  });

  await check("the TRY raise writes nothing without --apply", async () => {
    const conn = fakeConn({
      "FROM branch_tariffs": () => [
        [
          { id: 1, Branch: "Lesovo", Duration: 30, Price: "2000.00" },
          { id: 2, Branch: "Kapitan Andreevo", Duration: 30, Price: "1700.00" },
        ],
      ],
    });
    const raised = await raiseTurkishLiraTariffs(conn, { apply: false });
    eq(
      raised.map((r) => [r.Branch, r.from, r.to]),
      [["Lesovo", 2000, 2050]],
      "only the old price is reported"
    );
    ok(!conn.wrote("UPDATE branch_tariffs"), "no price was written");
  });

  await check("the TRY raise writes the new price with --apply", async () => {
    const conn = fakeConn({
      "FROM branch_tariffs": () => [
        [{ id: 7, Branch: "Lesovo", Duration: 90, Price: "2200.00" }],
      ],
      "UPDATE branch_tariffs": () => [{ affectedRows: 1 }],
    });
    const raised = await raiseTurkishLiraTariffs(conn, { apply: true });
    eq(raised.length, 1, "one row raised");
    const update = conn.log.find((q) => flat(q.sql).includes("UPDATE branch_tariffs"));
    eq(update.params, [2300, 7], "the new price is written on that row");
  });

  // --------------------------------------------------------------- number swap

  await check("a swapped row is recognised, a correct one is not", () => {
    const { swaps, collisions } = classifyNumberSwap(
      [
        { BlancNumber: "12345678", PolicyNumber: "123456" },
        { BlancNumber: "111111", PolicyNumber: "22222222" },
        { BlancNumber: "", PolicyNumber: "33333333" },
      ],
      new Set(["12345678", "111111"])
    );
    eq(swaps, [{ from: "12345678", to: "123456" }], "only the swapped row");
    eq(collisions, [], "nothing collides");
  });

  await check("a swap that would take a used blanc is refused", () => {
    const { swaps, collisions } = classifyNumberSwap(
      [{ BlancNumber: "12345678", PolicyNumber: "123456" }],
      new Set(["123456", "999999"])
    );
    eq(swaps, [], "nothing is swapped");
    eq(collisions.map((c) => c.to), ["123456"], "the collision is reported");
  });

  await check("the swap reports without --apply", async () => {
    const conn = fakeConn({
      CHAR_LENGTH: () => [[{ BlancNumber: "12345678", PolicyNumber: "123456" }]],
      "SELECT BlancNumber FROM insurance": () => [[{ BlancNumber: "12345678" }]],
    });
    const result = await swapMisplacedNumbers(conn, { apply: false });
    eq(result.swaps.length, 1, "the row is listed");
    eq(result.applied, false, "nothing was applied");
    ok(!conn.queries().includes("BEGIN"), "no transaction was opened");
  });

  await check("the swap writes the numbers and both cash ledgers with --apply", async () => {
    const conn = fakeConn({
      CHAR_LENGTH: () => [[{ BlancNumber: "12345678", PolicyNumber: "123456" }]],
      "SELECT BlancNumber FROM insurance": () => [[{ BlancNumber: "12345678" }]],
      "INSERT IGNORE INTO insurance_number_swap_backup": () => [{ affectedRows: 1 }],
      "UPDATE insurance i JOIN insurance_number_swap_backup": () => [
        { affectedRows: 1 },
      ],
      "UPDATE cash_transactions": (params) => [
        { affectedRows: params[1] === "12345678" ? 1 : 0 },
      ],
      "UPDATE total_cash_transactions": (params) => [
        { affectedRows: params[1] === "Edit 12345678" ? 2 : 0 },
      ],
    });
    const result = await swapMisplacedNumbers(conn, { apply: true });
    eq(result.applied, true, "the swap was applied");
    eq(result.cashRows, 1, "the drawer sale row was relabelled");
    eq(result.totalCashRows, 2, "the total-cash edit rows were relabelled");
    const backup = conn.log.find((q) =>
      flat(q.sql).includes("INSERT IGNORE INTO insurance_number_swap_backup")
    );
    eq(backup.params, ["12345678", "123456"], "the originals are kept");
    const reasons = conn.log
      .filter((q) => flat(q.sql).startsWith("UPDATE cash_transactions SET Reason"))
      .map((q) => q.params);
    eq(
      reasons,
      [
        ["123456", "12345678"],
        ["Edit 123456", "Edit 12345678"],
        ["Annul 123456", "Annul 12345678"],
      ],
      "the three reason shapes are rewritten"
    );
    ok(
      conn.queries().includes("COMMIT") && !conn.queries().includes("ROLLBACK"),
      "the transaction is committed"
    );
  });

  await check("a collision blocks the write", async () => {
    const conn = fakeConn({
      CHAR_LENGTH: () => [[{ BlancNumber: "12345678", PolicyNumber: "123456" }]],
      "SELECT BlancNumber FROM insurance": () => [[{ BlancNumber: "123456" }]],
    });
    const result = await swapMisplacedNumbers(conn, { apply: true });
    eq(result.collisions.length, 1, "the collision is reported");
    eq(result.applied, false, "nothing is written");
    ok(!conn.queries().includes("BEGIN"), "no transaction was opened");
  });

  // ------------------------------------------------------- UTC -> local shift

  await check("a shift refuses to run twice (its backup tables are the guard)", async () => {
    const conn = fakeConn({
      "information_schema.TABLES": (params) => [[{ TABLE_NAME: params[0] }]],
    });
    const result = await shiftLegacyTimestamps(conn, { apply: true, hours: 3 });
    eq(
      result.parts.map((p) => p.status.startsWith("already applied")),
      [true, true],
      "both parts are recognised as done"
    );
    eq(result.applied, false, "nothing was shifted");
    ok(!conn.wrote("CREATE TABLE"), "no backup is written again");
    ok(!conn.wrote("INTERVAL"), "no timestamp is touched");
  });

  await check("a shift reports what it would touch without --apply", async () => {
    const conn = fakeConn({
      "information_schema.TABLES": () => [[]],
      "COUNT(*) AS n FROM insurance": () => [[{ n: 12 }]],
      "COUNT(*) AS n FROM cash_transactions": () => [[{ n: 3 }]],
      "COUNT(*) AS n FROM cash_resets": () => [[{ n: 1 }]],
      "COUNT(*) AS n FROM card_resets": () => [[{ n: 2 }]],
      "COUNT(*) AS n FROM total_cash_transactions": () => [[{ n: 4 }]],
    });
    const result = await shiftLegacyTimestamps(conn, { apply: false, hours: 3 });
    eq(result.parts[0].rows, 12, "the insurance rows are counted");
    eq(
      result.parts[1].rows,
      {
        cash_transactions: 3,
        cash_resets: 1,
        card_resets: 2,
        total_cash_transactions: 4,
      },
      "every cash ledger is counted"
    );
    eq(result.applied, false, "nothing was written");
    ok(!conn.wrote("UPDATE"), "no row was shifted");
  });

  await check("a shift backs the rows up and moves them by the given hours", async () => {
    const conn = fakeConn({
      "information_schema.TABLES": () => [[]],
      "COUNT(*) AS n FROM insurance": () => [[{ n: 2 }]],
      "COUNT(*) AS n FROM cash_transactions": () => [[{ n: 0 }]],
      "COUNT(*) AS n FROM cash_resets": () => [[{ n: 0 }]],
      "COUNT(*) AS n FROM card_resets": () => [[{ n: 0 }]],
      "COUNT(*) AS n FROM total_cash_transactions": () => [[{ n: 0 }]],
      "INSERT INTO insurance_creationdate_backup": () => [{ affectedRows: 2 }],
      "UPDATE insurance SET CreationDate": () => [{ affectedRows: 2 }],
      "INSERT INTO cash_createdate_backup": () => [{ affectedRows: 0 }],
    });
    const result = await shiftLegacyTimestamps(conn, { apply: true, hours: "-3" });
    eq(result.hours, -3, "the hours are taken from the flag");
    eq(result.applied, true, "both parts were shifted");
    ok(
      conn.queries().some((sql) => sql.includes("INTERVAL -3 HOUR")),
      "the shift uses the requested number of hours"
    );
    const backups = conn.log
      .filter((q) => flat(q.sql).includes("INSERT INTO cash_createdate_backup"))
      .map((q) => q.params[0]);
    eq(backups, CASH_LEDGER_TABLES, "every cash ledger is backed up");
  });

  await check("only a plausible number of hours is accepted", () => {
    eq(normalizeHours(3), 3, "a plain number");
    eq(normalizeHours("3"), 3, "a flag value");
    eq(normalizeHours(-3), -3, "a negative shift");
    let threw = 0;
    for (const bad of [0, 24, -24, "abc", ""]) {
      try {
        normalizeHours(bad);
      } catch (err) {
        threw++;
      }
    }
    eq(threw, 5, "zero, out-of-range and non-numeric hours are refused");
  });

  // ------------------------------------------------------- balance audit

  await check("the balance formula is starting + payments - charges", () => {
    eq(
      formulaBalance({ startingBalance: 10, payments: 100, insuranceCharges: 60 }),
      50,
      "the four parts"
    );
    eq(formulaBalance({}), 0, "an empty broker is zero");
    eq(
      formulaBalance({ startingBalance: null, payments: 100, insuranceCharges: 60 }),
      40,
      "a missing starting balance counts as zero"
    );
    eq(
      formulaBalance({ payments: 33.33, insuranceCharges: 0.01 }),
      33.32,
      "money is rounded to cents"
    );
  });

  await check("the audit lists the brokers whose balance differs from the rule", async () => {
    const conn = fakeConn({
      "FROM broker_balance_movements GROUP BY Type": () => [
        [{ Type: "policy", RowCount: 3, DeletedCount: 0, LiveTotal: "-46", DeletedTotal: "0" }],
      ],
      "WHERE m.Type IN ('reduce', 'adjust')": () => [
        [
          {
            id: 5,
            BrokerId: 1,
            Broker: "A",
            CreatedAt: "2026-10-01 10:00:00",
            Type: "reduce",
            Amount: "-30.00",
            Reason: "old expense",
            Author: "admin",
            Deleted: 0,
          },
        ],
      ],
      "FROM broker_starting_balances": () => [[{ BrokerId: 1, Amount: "10.00" }]],
      "FROM brokers WHERE Deleted = 0": () => [
        [
          { id: 1, Name: "A", Code: "1", CashBalance: "999.00" },
          { id: 2, Name: "B", Code: "2", CashBalance: "0.00" },
        ],
      ],
      "Type IN ('increase', 'handover') GROUP BY BrokerId": () => [
        [{ BrokerId: 1, Paid: "100.00" }],
      ],
      "FROM insurance WHERE Deleted = 0 AND BrokerId IS NOT NULL": () => [
        [
          {
            BrokerId: 1,
            Price: "45.00",
            Annulled: 0,
            AnnulReason: null,
            AnnulFee: null,
            Deleted: 0,
          },
          {
            BrokerId: 1,
            Price: "1.00",
            Annulled: 1,
            AnnulReason: "broker",
            AnnulFee: "1.00",
            Deleted: 0,
          },
          {
            BrokerId: 1,
            Price: "9.00",
            Annulled: 1,
            AnnulReason: "worker",
            AnnulFee: "1.00",
            Deleted: 0,
          },
        ],
      ],
    });
    const report = await loadPaymentChecks(conn);
    eq(report.retiredRows.length, 1, "the retired row is listed");
    eq(report.matching, 1, "the broker that already matches is counted");
    eq(report.perBroker.length, 1, "only the differing broker is listed");
    eq(
      [
        report.perBroker[0].id,
        report.perBroker[0].startingBalance,
        report.perBroker[0].payments,
        report.perBroker[0].insuranceCharges,
        report.perBroker[0].calculated,
        report.perBroker[0].difference,
      ],
      [1, 10, 100, 46, 64, 935],
      "the rule ignores the reduce row and the worker-paid annulment"
    );
  });

  ok(UPGRADES_JS.endsWith("legacy-upgrades.js"), "the real server file is used");
  ok(PAYMENTS_JS.endsWith("check-broker-payments.js"), "the real audit file is used");
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed === 0 ? 0 : 1;
})();

