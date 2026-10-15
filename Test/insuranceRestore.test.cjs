"use strict";

// Node test for the money side-effects of POST /insurances/:blancNumber/restore.
//
// A soft-deleted policy is brought back exactly as it was when it was deleted,
// and the money the deletion removed is re-applied: the policy's contribution
// is added back to current cash / the card balance / the Broker part of Total
// cash, and a (non-annulled) broker policy is charged back to the broker's
// balance. The row's Deleted flag is cleared.
//
// Like insuranceSearchFilter.test.cjs / insuranceEditCash.test.cjs, this loads
// the REAL server file (InsuranceServer/Requests/TierEndpoints.js, see
// Test/serverPath.cjs) in a vm with its requires stubbed, registers the routes
// on a fake router, and then calls the restore handler directly with a fake
// req/res and a fake DB. The cash/card/broker helpers are stubbed with
// recorders so the test asserts exactly which movements the endpoint asks for.
//
// Run with:  node Test/insuranceRestore.test.cjs   (or: npm test)

const fs = require("fs");
const vm = require("vm");
const { serverFile } = require("./serverPath.cjs");

const TIER_JS = serverFile("Requests", "TierEndpoints.js");

// --- fakes -------------------------------------------------------------------
const routes = [];
const queries = [];
const movements = [];
// Charges the endpoint asks Brokers.js to make against a broker's balance.
const brokerCharges = [];
let txCount = 0;
let txDepth = 0;
// When true the SELECT lookup returns no row (insurance "not found").
let missing = false;

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

// Copy of the real helper (Requests/CurrentCash.js) so amounts are parsed the
// same way in the test as on the server.
function toDecimal(value) {
  if (value === undefined || value === null || value === "") return null;
  const n =
    typeof value === "number" ? value : parseFloat(String(value).replace(",", "."));
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100) / 100;
}

function checkPositive(amount, reason) {
  const decimal = toDecimal(amount);
  if (decimal === null || decimal <= 0) {
    throw new Error("amount must be a positive number");
  }
  if (typeof reason !== "string" || !reason.trim()) {
    throw new Error("reason is required");
  }
  return decimal;
}

const STUBS = {
  express: new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "Router") return () => fakeRouter;
        return () => (req, res, next) => (next ? next() : undefined);
      },
    }
  ),
  "./Auth.js": {
    requireAuth: () => (req, res, next) => next(),
    requireRole: () => (req, res, next) => next(),
    extractToken: () => "",
  },
  "./CurrentCash.js": {
    toDecimal,
    recordCashMovement: async (
      conn,
      branch,
      username,
      type,
      amount,
      reason,
      currency
    ) => {
      const decimal = checkPositive(amount, reason);
      if (type !== "increase" && type !== "reduce") {
        throw new Error("type must be 'increase' or 'reduce'");
      }
      movements.push({
        where: "cash",
        type,
        amount: decimal,
        currency: currency || "EUR",
        branch: String(branch || ""),
        username,
        reason: reason.trim(),
      });
      return decimal;
    },
    recordChannelMovement: async (
      conn,
      branch,
      username,
      type,
      amount,
      reason,
      currency,
      source
    ) => {
      const decimal = checkPositive(amount, reason);
      if (type !== "increase" && type !== "reduce") {
        throw new Error("type must be 'increase' or 'reduce'");
      }
      if (source !== "Card" && source !== "Broker") {
        throw new Error("source must be 'Card' or 'Broker'");
      }
      movements.push({
        where: "total",
        source,
        type,
        amount: decimal,
        currency: currency || "EUR",
        branch: String(branch || ""),
        username,
        reason: reason.trim(),
      });
      return decimal;
    },
  },
  "./CardPayments.js": {
    recordCardPayment: async (conn, branch, username, amount, reason) => {
      const decimal = checkPositive(amount, reason);
      movements.push({
        where: "card",
        type: "increase",
        amount: decimal,
        currency: "",
        branch,
        username,
        reason: reason.trim(),
      });
      return decimal;
    },
    reduceCardBalance: async (conn, branch, username, amount, reason) => {
      const decimal = checkPositive(amount, reason);
      movements.push({
        where: "card",
        type: "reduce",
        amount: decimal,
        currency: "",
        branch,
        username,
        reason: reason.trim(),
      });
      return decimal;
    },
  },
  "./Brokers.js": {
    resolveBrokerByEmail: async () => null,
    decreaseBrokerForInsurance: async (conn, brokerId, price) => {
      brokerCharges.push({ brokerId, amount: Number(price) });
      return Number(price);
    },
    restoreBrokerForAnnulment: async () => {},
    restoreBrokerForDeletion: async () => {},
    adjustBrokerForPriceChange: async () => {},
    resolveBrokerCutOff: async () => false,
    getBrokerAllowNegativeBalance: async () => true,
  },
  "./PaymentSchedule.js": { getSchedule: async () => null },
  "../Mail/SendReply.js": { sendReply: async () => {} },
};

// The row the "SELECT * FROM insurance WHERE BlancNumber = ?" lookup returns.
// The UPDATE applies its SET clause onto it, so the final state reflects what
// the endpoint wrote.
let row = null;

const fakeDb = {
  query: async (sql, params) => {
    const flat = String(sql).replace(/\s+/g, " ").trim();
    queries.push({ sql: flat, params: params || [], inTx: txDepth > 0 });

    if (flat.startsWith("SELECT * FROM insurance")) {
      return [missing ? [] : row ? [{ ...row }] : []];
    }
    if (flat.startsWith("UPDATE insurance SET")) {
      const setPart = flat.slice(
        "UPDATE insurance SET".length,
        flat.indexOf(" WHERE ")
      );
      const columns = setPart.split(",").map((c) => c.trim().split("=")[0].trim());
      columns.forEach((column, i) => {
        row[column] = (params || [])[i];
      });
      return [{ affectedRows: 1 }];
    }
    return [[]];
  },
  withTransaction: async (fn) => {
    txCount++;
    txDepth++;
    try {
      return await fn(fakeDb);
    } finally {
      txDepth--;
    }
  },
};

const mod = { exports: {} };
const CTX = { console, module: mod, exports: mod.exports, Buffer, process };
CTX.require = (id) => {
  if (!Object.prototype.hasOwnProperty.call(STUBS, id)) {
    throw new Error("unexpected require in TierEndpoints.js: " + id);
  }
  return STUBS[id];
};
vm.createContext(CTX);
vm.runInContext(fs.readFileSync(TIER_JS, "utf8"), CTX, {
  filename: "Requests/TierEndpoints.js",
});

if (typeof mod.exports.createTierRouter !== "function") {
  console.error("createTierRouter is not exported - server file changed?");
  process.exit(1);
}
mod.exports.createTierRouter(fakeDb);

const route = routes.find(
  (r) => r.method === "post" && r.path === "/insurances/:blancNumber/restore"
);
if (!route) {
  console.error("POST /insurances/:blancNumber/restore was not registered");
  process.exit(1);
}
// Last handler = the route body (the earlier ones are the auth middlewares).
const handler = route.handlers[route.handlers.length - 1];

// --- tiny assert helpers -----------------------------------------------------
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

// One-line description of a movement, mirroring the ledgers the user sees.
const describe = (m) =>
  m.where === "cash"
    ? `cash ${m.type} ${m.amount} ${m.currency} @ ${m.branch} (${m.reason}) by ${m.username}`
    : m.where === "total"
    ? `total/${m.source} ${m.type} ${m.amount} ${m.currency} @ ${m.branch} (${m.reason}) by ${m.username}`
    : `card ${m.type} ${m.amount} (${m.reason}) by ${m.username}`;

const BASE_ROW = {
  BlancNumber: "1234567",
  PolicyNumber: "P-001",
  Price: "100.00",
  CurrencyType: "EUR",
  Branch: "Офис Харманли",
  PaymentType: "Cash",
  AnnulFee: 0,
  Annulled: 0,
  Deleted: 1,
  DeletedAt: null,
  DeletedBy: "admin1",
  BrokerId: null,
  Broker: "",
};

// Calls POST /insurances/:blancNumber/restore against a freshly seeded row and
// returns the response plus every balance movement / broker charge it asked for.
async function restore(opts = {}) {
  movements.length = 0;
  brokerCharges.length = 0;
  queries.length = 0;
  txCount = 0;
  missing = !!opts.missing;
  row = { ...BASE_ROW, ...(opts.row || {}) };

  const res = {
    statusCode: 200,
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };

  await handler(
    {
      params: { blancNumber: row.BlancNumber },
      query: {},
      user: { role: 1, username: "admin1" },
    },
    res
  );

  return {
    status: res.statusCode,
    body: res.body,
    movements: movements.map(describe),
    brokerCharges: brokerCharges.map(
      (c) => `${c.amount} -> broker ${c.brokerId}`
    ),
    updated: queries
      .filter((q) => q.sql.startsWith("UPDATE insurance SET"))
      .map((q) => ({ params: q.params })),
    tx: txCount,
    row: { ...row },
  };
}

(async () => {
  console.log("POST /insurances/:blancNumber/restore — money side-effects");

  await check("restoring a live (non-deleted) policy is rejected", async () => {
    const r = await restore({ row: { Deleted: 0 } });
    eq(r.status, 400, "status");
    eq(r.body.error, "Insurance is not deleted", "message");
    eq(r.movements, [], "no movements expected");
    eq(r.brokerCharges, [], "no broker charge expected");
    eq(r.row.Deleted, 0, "the row is left live");
  });

  await check("restoring a missing policy returns 404", async () => {
    const r = await restore({ missing: true });
    eq(r.status, 404, "status");
    eq(r.body.error, "Insurance not found", "message");
    eq(r.movements, [], "no movements expected");
  });

  await check("a deleted cash policy re-adds its price to current cash", async () => {
    const r = await restore();
    eq(r.status, 200, "status");
    eq(
      r.movements,
      ["cash increase 100 EUR @ Офис Харманли (Restore 1234567) by admin1"],
      "movements"
    );
    eq(r.brokerCharges, [], "no broker charge expected");
    eq(r.row.Deleted, 0, "Deleted cleared");
    eq(r.row.DeletedAt, null, "DeletedAt cleared");
    eq(r.row.DeletedBy, null, "DeletedBy cleared");
    eq(r.body.restored, 100, "restored amount");
    eq(r.body.brokerCharge, 0, "broker charge amount");
  });

  await check("a deleted card policy re-adds its price to the card balance", async () => {
    const r = await restore({ row: { PaymentType: "Card" } });
    eq(
      r.movements,
      [
        "card increase 100 (Restore 1234567) by admin1",
        "total/Card increase 100 EUR @ Офис Харманли (Restore 1234567) by admin1",
      ],
      "movements"
    );
    eq(r.row.Deleted, 0, "Deleted cleared");
  });

  await check("an annulled policy re-adds only the kept annulment fee", async () => {
    const r = await restore({ row: { Annulled: 1, AnnulFee: 9 } });
    eq(
      r.movements,
      ["cash increase 9 EUR @ Офис Харманли (Restore 1234567) by admin1"],
      "movements"
    );
    eq(r.row.Deleted, 0, "Deleted cleared");
    eq(r.body.restored, 9, "restored amount");
  });

  await check("a broker policy re-adds Broker cash and re-charges the broker", async () => {
    const r = await restore({ row: { BrokerId: 7, Broker: "Euroins" } });
    eq(
      r.movements,
      [
        "total/Broker increase 100 EUR @ Офис Харманли (Restore 1234567) by admin1",
      ],
      "movements"
    );
    eq(r.brokerCharges, ["100 -> broker 7"], "broker is charged back");
    eq(r.body.brokerCharge, 100, "broker charge amount");
    eq(r.row.Deleted, 0, "Deleted cleared");
  });

  await check("an annulled broker policy is not charged back to the broker", async () => {
    const r = await restore({
      row: { BrokerId: 7, Broker: "Euroins", Annulled: 1, AnnulFee: 9 },
    });
    eq(
      r.movements,
      [
        "total/Broker increase 9 EUR @ Офис Харманли (Restore 1234567) by admin1",
      ],
      "movements"
    );
    eq(r.brokerCharges, [], "the broker is not charged again");
    eq(r.body.brokerCharge, 0, "broker charge amount");
    eq(r.row.Deleted, 0, "Deleted cleared");
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();