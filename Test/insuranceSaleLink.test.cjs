"use strict";

// Node test for the structural link between a policy and the history row of its
// SALE (insurance.SaleMovementId).
//
// Why it exists: the balance history pairs a ledger row with a policy by
// BlancNumber, and a policy's charge row keeps the number it was written with.
// A blanc correction made by an old server left the sale attached to a number no
// policy carried, and the history page hid the charge - the insurance existed and
// the broker was charged, but that day's history showed nothing (that is the
// 169979 / 776247 case). The link makes the pairing independent of the number:
//
//   - decreasing a broker for an insurance writes the `policy` row AND stores
//     its id on the insurance row, in the same call;
//   - a zero charge writes no row and links nothing;
//   - the history endpoint keeps a linked row even when its BlancNumber is stale
//     (Test/brokerHistory.test.cjs asserts that side).
//
// The REAL server file runs in a vm with its requires stubbed, like
// Test/brokerHistory.test.cjs.
//
// Run with:  node Test/insuranceSaleLink.test.cjs   (or: npm test)

const fs = require("fs");
const vm = require("vm");
const { serverFile } = require("./serverPath.cjs");

const BROKERS_JS = serverFile("Requests", "Brokers.js");

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
function ok(cond, msg) {
  if (!cond) throw new Error(msg || "expected truthy");
}

// Fake connection: records every statement, answers the ones the write path
// reads and returns an insert id for the movement row.
function makeConn() {
  const queries = [];
  return {
    queries,
    query: async (sql, params = []) => {
      const s = String(sql).replace(/\s+/g, " ").trim();
      queries.push({ sql: s, params: params || [] });
      if (s === "SELECT id FROM brokers WHERE id = ?") {
        return [Number(params[0]) === 35 ? [{ id: 35 }] : []];
      }
      if (s.startsWith("INSERT INTO broker_balance_movements")) {
        return [{ insertId: 77, affectedRows: 1 }];
      }
      return [{ affectedRows: 1 }];
    },
  };
}

const STUBS = {
  express: {
    Router: () => ({
      get() {},
      post() {},
      put() {},
      patch() {},
      delete() {},
      use() {},
    }),
  },
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
    clientLocalDateTime: () => "2026-10-21 13:21:14",
    parseClientDateTime: (v) => (typeof v === "string" ? v : null),
    resolvePickedTime: () => ({ time: "" }),
  },
  "./PaymentSchedule.js": { getSchedule: () => ({}) },
  "../db/brokerPayments.js": {
    ensureBrokerPaymentsTable: async () => {},
    recordBrokerPayment: async () => ({ id: null, amount: 0 }),
    syncBrokerPaymentFromMovement: async () => {},
    sumBrokerPayments: async () => 0,
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

(async () => {
  await check("a sale writes its history row and links the policy to it", async () => {
    const conn = makeConn();
    const result = await M.decreaseBrokerForInsurance(conn, 35, 45, {
      reason: "169979",
      author: "PLAMEN",
      blancNumber: "169979",
      createdAt: "2026-10-21 13:21:14",
    });

    eq(result, { amount: 45, movementId: 77 }, "the charge and its row id");

    const insert = conn.queries.find((q) =>
      q.sql.startsWith("INSERT INTO broker_balance_movements")
    );
    ok(insert, "the movement row is written");
    eq(
      insert.params,
      [35, -45, "policy", "169979", "PLAMEN", "169979", "2026-10-21 13:21:14"],
      "broker, amount, type, reason, author, blanc, time"
    );

    const link = conn.queries.find((q) =>
      q.sql.startsWith("UPDATE insurance SET SaleMovementId = ?")
    );
    ok(link, "the policy is linked to that row");
    eq(
      link.params,
      [77, "169979", 35],
      "the link stores the row id for that broker and blanc"
    );
  });

  await check("a zero charge writes no row and links nothing", async () => {
    const conn = makeConn();
    const result = await M.decreaseBrokerForInsurance(conn, 35, 0, {
      reason: "169979",
      author: "PLAMEN",
      blancNumber: "169979",
      createdAt: "2026-10-21 13:21:14",
    });

    eq(result, { amount: 0, movementId: null }, "nothing charged");
    ok(
      !conn.queries.some((q) =>
        q.sql.startsWith("INSERT INTO broker_balance_movements")
      ),
      "no movement row for zero money"
    );
    ok(
      !conn.queries.some((q) =>
        q.sql.startsWith("UPDATE insurance SET SaleMovementId = ?")
      ),
      "no link for a policy with no sale row"
    );
  });

  await check("recordBrokerMovement reports the id it wrote", async () => {
    const conn = makeConn();
    const mov = await M.recordBrokerMovement(conn, 35, 20, "increase", {
      reason: "top up",
      author: "admin",
    });
    eq(mov, { id: 77, amount: 20 }, "id and amount");
    eq(
      await M.recordBrokerMovement(conn, 35, 0, "increase", {}),
      { id: null, amount: 0 },
      "a zero movement is skipped"
    );
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed === 0 ? 0 : 1;
})();

