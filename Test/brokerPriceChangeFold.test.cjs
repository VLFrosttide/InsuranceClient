"use strict";

// Node test for BROKER PRICE CORRECTIONS: a price edit must NOT add a ledger
// row of its own. The change is folded into the policy's one SALE row
// (Type = "policy") - its Amount moves by the delta and its CreatedAt is left
// alone - so the balance history shows one direct sale per policy, at the
// price the policy ends up with, on the day it was created.
//
// That is what keeps a correction made today from changing TODAY'S balance in
// the history: the sale row lives on the policy's creation day.
//
// It also covers a policy whose sale row an admin had soft-deleted: the delta
// still folds into that hidden row (adding nothing visible and no extra row),
// instead of writing a "price_change" row that shows up because there is no
// live sale row to fold it into.
//
// The REAL server file (InsuranceServer/Requests/Brokers.js) runs in a vm with
// its requires stubbed, against an in-memory fake MySQL.
//
// Run with:  node Test/brokerPriceChangeFold.test.cjs   (or: npm test)

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
  if (a !== b) throw new Error((msg || "values differ") + ` (got ${a}, want ${b})`);
}
function ok(value, msg) {
  if (!value) throw new Error(msg || "expected a truthy value");
}

const flat = (s) => String(s).replace(/\s+/g, " ").trim();

// --- in-memory fake MySQL ----------------------------------------------------
let db;
function resetDb() {
  db = {
    brokers: [{ id: 25, CashBalance: -600 }],
    // The insurance row the correction belongs to. `SaleMovementId` is the
    // explicit link to its sale row (6 by default).
    policies: [
      {
        BlancNumber: "138786",
        BrokerId: 25,
        Price: 30,
        CreationDate: "2026-10-08 13:23:56",
        SaleMovementId: 6,
      },
    ],
    movements: [
      {
        id: 6,
        BrokerId: 25,
        Amount: -32,
        Type: "policy",
        Reason: "Insurance 138786",
        BlancNumber: "138786",
        CreatedAt: "2026-10-08 13:23:56",
        Deleted: 0,
      },
    ],
    nextMovement: 100,
    inserts: [],
  };
}

async function query(sql, params = []) {
  const s = flat(sql);
  const p = params || [];

  if (s === "SELECT id FROM brokers WHERE id = ?") {
    return [db.brokers.filter((b) => b.id === Number(p[0]))];
  }
  if (s === "UPDATE brokers SET CashBalance = CashBalance - ? WHERE id = ?") {
    const broker = db.brokers.find((b) => b.id === Number(p[1]));
    if (broker) {
      broker.CashBalance =
        Math.round((Number(broker.CashBalance) - Number(p[0])) * 100) / 100;
    }
    return [{ affectedRows: broker ? 1 : 0 }];
  }
  if (
    s.startsWith(
      "SELECT i.CreationDate, i.Price, i.SaleMovementId, m.id AS SaleId FROM insurance i LEFT JOIN broker_balance_movements m"
    )
  ) {
    const policy = db.policies.find(
      (x) =>
        String(x.BlancNumber) === String(p[0]) &&
        Number(x.BrokerId) === Number(p[1])
    );
    if (!policy) return [[]];
    const sale = db.movements.find(
      (m) =>
        Number(m.id) === Number(policy.SaleMovementId) &&
        m.Type === "policy" &&
        m.Deleted !== 1
    );
    return [
      [
        {
          CreationDate: policy.CreationDate,
          Price: policy.Price,
          SaleMovementId: policy.SaleMovementId,
          SaleId: sale ? sale.id : null,
          SaleAmount: sale ? sale.Amount : null,
        },
      ],
    ];
  }
  if (
    s.startsWith(
      "SELECT id FROM broker_balance_movements WHERE BrokerId = ? AND BlancNumber = ? AND Type = 'policy'"
    )
  ) {
    const rows = db.movements
      .filter(
        (m) =>
          Number(m.BrokerId) === Number(p[0]) &&
          String(m.BlancNumber ?? "") === String(p[1] ?? "") &&
          m.Type === "policy" &&
          m.Deleted !== 1
      )
      .sort((a, b) => a.id - b.id)
      .slice(0, 1)
      .map((m) => ({ id: m.id }));
    return [rows];
  }
  if (s === "UPDATE broker_balance_movements SET Amount = ROUND(Amount - ?, 2) WHERE id = ?") {
    const mov = db.movements.find((m) => Number(m.id) === Number(p[1]));
    if (mov) {
      mov.Amount = Math.round((Number(mov.Amount) - Number(p[0])) * 100) / 100;
    }
    return [{ affectedRows: mov ? 1 : 0 }];
  }
  if (s.startsWith("INSERT INTO broker_balance_movements")) {
    const id = db.nextMovement++;
    const row = {
      id,
      BrokerId: Number(p[0]),
      Amount: Number(p[1]),
      Type: p[2],
      Reason: p[3],
      Author: p[4],
      BlancNumber: p[5],
      CreatedAt: p[6],
      Deleted: 0,
    };
    db.movements.push(row);
    db.inserts.push(row);
    return [{ insertId: id }];
  }
  if (
    s.startsWith(
      "UPDATE insurance SET SaleMovementId = ? WHERE BlancNumber = ? AND BrokerId = ?"
    )
  ) {
    const policy = db.policies.find(
      (x) =>
        String(x.BlancNumber) === String(p[1]) &&
        Number(x.BrokerId) === Number(p[2])
    );
    if (policy) policy.SaleMovementId = Number(p[0]);
    return [{ affectedRows: policy ? 1 : 0 }];
  }
  throw new Error("unexpected SQL in test: " + s);
}

const fakeDb = { query, withTransaction: async (fn) => fn(fakeDb) };

// --- load the real Brokers.js with its requires stubbed ----------------------
function parseClientDateTime(value) {
  if (typeof value !== "string") return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(
    value.trim()
  );
  if (!m) return null;
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

const noopHandler = (req, res, next) => next();
const fakeRouter = {
  get: () => {},
  post: () => {},
  put: () => {},
  patch: () => {},
  delete: () => {},
  use: () => {},
};

const STUBS = {
  express: { Router: () => fakeRouter },
  "./Auth.js": {
    requireAuth: () => noopHandler,
    requireRole: () => noopHandler,
  },
  "../db/BrokerInfo.js": { Pricing: {}, seedBrokerTariffsIfMissing: async () => 0 },
  "./CurrentCash.js": {
    toDecimal: (v) => (Number.isFinite(Number(v)) ? Number(v) : null),
    recordCashMovement: async () => {},
    normalizeCurrency: (c) => c || "EUR",
    normalizeBranch: (b) => b || "",
    clientLocalDateTime,
    parseClientDateTime,
    resolvePickedTime: () => ({ time: "" }),
  },
  "./PaymentSchedule.js": { getSchedule: () => ({}) },
  "../db/brokerPayments.js": {
    ensureBrokerPaymentsTable: async () => {},
    sumBrokerPayments: async () => 0,
    recordBrokerPayment: async () => ({ id: null, amount: 0 }),
    syncBrokerPaymentFromMovement: async () => {},
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

const rowById = (id) => db.movements.find((m) => m.id === Number(id));


(async () => {
  await check("a price correction folds into the live sale row", async () => {
    resetDb();
    const sale = rowById(6);
    const delta = await M.adjustBrokerForPriceChange(fakeDb, 25, 1, {
      reason: "Price change 138786",
      author: "admin",
      blancNumber: "138786",
      requireSaleRow: true,
    });
    eq(delta, 1, "the delta applied");
    eq(db.brokers[0].CashBalance, -601, "the broker is charged the difference");
    eq(db.movements.length, 1, "no extra ledger row");
    eq(db.inserts.length, 0, "nothing inserted");
    eq(sale.Amount, -33, "the sale row carries the new price");
    eq(sale.CreatedAt, "2026-10-08 13:23:56", "the sale keeps its creation date");
    eq(sale.Type, "policy", "the row is still the direct sale");
  });

  await check("a reduction moves the sale row back, on its creation date", async () => {
    resetDb();
    await M.adjustBrokerForPriceChange(fakeDb, 25, -5, {
      reason: "Price change 138786",
      author: "admin",
      blancNumber: "138786",
      requireSaleRow: true,
    });
    eq(db.brokers[0].CashBalance, -595, "the broker gets the difference back");
    eq(rowById(6).Amount, -27, "the sale row falls to the new price");
    eq(rowById(6).CreatedAt, "2026-10-08 13:23:56", "date untouched");
    eq(db.movements.length, 1, "still one row");
  });

  await check("a price correction is refused when the sale row is hidden", async () => {
    resetDb();
    // The state policies 138785 / 138786 were in: the admin had hidden the
    // sale row. A price edit must be refused, not given a second ledger row.
    db.movements[0].Deleted = 1;
    let err = null;
    try {
      await M.adjustBrokerForPriceChange(fakeDb, 25, 1, {
        reason: "Price change 138786",
        author: "admin",
        blancNumber: "138786",
        requireSaleRow: true,
      });
    } catch (e) {
      err = e;
    }
    ok(err && err.code === "NO_SALE_MOVEMENT", "the edit is refused");
    eq(db.brokers[0].CashBalance, -600, "no balance moved");
    eq(rowById(6).Amount, -32, "the hidden sale row is untouched");
    eq(db.inserts.length, 0, "nothing is written");
  });

  await check("a price correction with no sale row at all is refused", async () => {
    resetDb();
    db.movements = [];
    let err = null;
    try {
      await M.adjustBrokerForPriceChange(fakeDb, 25, 1, {
        reason: "Price change 138786",
        author: "admin",
        blancNumber: "138786",
        requireSaleRow: true,
      });
    } catch (e) {
      err = e;
    }
    ok(err && err.code === "NO_SALE_MOVEMENT", "the edit is refused");
    eq(db.inserts.length, 0, "no sale row is invented");
    eq(db.policies[0].SaleMovementId, 6, "the link is untouched");
    eq(db.brokers[0].CashBalance, -600, "no balance moved");
  });

  await check("a broker move with no sale row writes nothing", async () => {
    resetDb();
    db.movements = [];
    const delta = await M.adjustBrokerForPriceChange(fakeDb, 25, -30, {
      reason: "Broker change 138786",
      author: "admin",
      blancNumber: "138786",
    });
    eq(delta, -30, "the cancellation is applied");
    eq(db.brokers[0].CashBalance, -570, "the balance cancels the old sale");
    eq(db.inserts.length, 0, "no row is invented for the old broker");
  });

  await check("the linked sale is folded even after a blanc correction", async () => {
    resetDb();
    db.policies[0].BlancNumber = "138799"; // corrected blanc since creation
    db.movements[0].BlancNumber = "138786";
    await M.adjustBrokerForPriceChange(fakeDb, 25, 1, {
      reason: "Price change 138799",
      author: "admin",
      blancNumber: "138799",
    });
    eq(rowById(6).Amount, -33, "the linked row is folded");
    eq(db.inserts.length, 0, "no duplicate sale");
  });

  await check("a missing policy keeps the explicit delta row", async () => {
    resetDb();
    // A broker move with a blanc correction can look the old row up under a
    // number the insurance never had. There is no full price to write then.
    db.movements = [];
    db.policies[0].BrokerId = 99;
    await M.adjustBrokerForPriceChange(fakeDb, 25, 1, {
      reason: "Broker change 138799",
      author: "admin",
      blancNumber: "138799",
    });
    eq(db.inserts.length, 1, "one delta row written");
    eq(db.inserts[0].Type, "price_change", "typed as the legacy delta");
    eq(db.inserts[0].Amount, -1, "the delta itself");
  });

  await check("a zero delta changes nothing", async () => {
    resetDb();
    const delta = await M.adjustBrokerForPriceChange(fakeDb, 25, 0, {
      blancNumber: "138786",
    });
    eq(delta, 0, "nothing applied");
    eq(db.brokers[0].CashBalance, -600, "balance untouched");
    eq(rowById(6).Amount, -32, "sale untouched");
  });

  await check("an unknown broker is left alone", async () => {
    resetDb();
    const result = await M.adjustBrokerForPriceChange(fakeDb, 999, 1, {
      blancNumber: "138786",
    });
    eq(result, null, "null for a missing broker");
    eq(rowById(6).Amount, -32, "no row is touched");
  });

  console.log("");
  console.log(`${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();

