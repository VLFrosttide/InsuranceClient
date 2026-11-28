"use strict";

// Node test for the money side-effects of PATCH /insurances/:blancNumber.
//
// Editing the price, the payment type, the branch or the currency of an
// EXISTING policy has to move the money behind it as well: the policy's old
// contribution to current cash (PaymentType = "Cash") or to the card balance
// (PaymentType = "Card") is reversed and the new one is applied, in the same
// transaction as the row update. Without that, the balance shown in
// "Current cash" would silently drift away from the policies behind it every
// time an old policy is corrected.
//
// The same file covers the admin-only corrections added on top of that: the
// Author of a policy and its broker (BrokerId). A broker decides who pays, so
// reassigning one refunds the previous broker, charges the new one and switches
// the payment channel between current cash / the card balance and "Broker".
//
// Like insuranceSearchFilter.test.cjs, this loads the REAL server file
// (InsuranceServer/Requests/TierEndpoints.js, see Test/serverPath.cjs) in a vm
// with its requires stubbed, registers the routes on a fake router, and then
// calls the PATCH handler
// directly with a fake req/res and a fake DB. The cash/card helpers are stubbed
// with recorders, so the test asserts exactly which movements the endpoint asks
// for - and that nothing moves when nothing money-related changed.
//
// Run with:  node Test/insuranceEditCash.test.cjs   (or: npm test)

const fs = require("fs");
const vm = require("vm");
const { serverFile } = require("./serverPath.cjs");

const TIER_JS = serverFile("Requests", "TierEndpoints.js");

// --- fakes -------------------------------------------------------------------
const routes = [];
const queries = [];
const movements = [];
// Reason relabels the endpoint asks for: a blanc correction has to carry the
// drawer ledger (cash_transactions) and its Total cash mirror with it.
const renames = [];
// Price-delta adjustments the endpoint asks Brokers.js to make. A broker-funded
// policy's balance is the only record of its payment, so a corrected price has
// to move it too; asserting it separately keeps that visible.
const brokerDeltas = [];
// Amounts the endpoint restores to a broker's balance when a policy is
// annulled. Only the broker being at fault keeps part of the price back.
const brokerRestores = [];
// The options each restore was called with (e.g. reuseExisting on a fresh
// annulment of a policy whose refund row was morphed by an un-annul).
const brokerRestoreMeta = [];
// Amounts the endpoint takes back from a broker's balance when an annulled
// policy is un-annulled (restored). The refund row is morphed to 0 instead of a
// new charge movement being appended, so this is asserted on its own.
const brokerSettles = [];
let txCount = 0;
let txDepth = 0;
// When true the cash "reduce" stub fails the way the real one does when the
// drawer cannot fund the reversal of an old price.
let failReduce = false;
// When true the broker price-change stub fails like the real helper does for a
// policy that has no live sale row to fold the delta into.
let rejectMissingSaleRow = false;
// The broker "negative balance allowed" setting, as returned by the stubbed
// Brokers.js helper. Tests flip it to exercise the rejection gate.
let allowNegativeBalance = true;

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
  // The real kinds module (border / medical / civil), so the create, edit and
  // annul rules are exercised for real instead of being stubbed.
  "./InsuranceKinds.js": require(serverFile("Requests", "InsuranceKinds.js")),
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
    // The reasons a policy's own corrections carry; the insurance editor uses
    // them to carry the drawer ledger with a corrected blanc number.
    POLICY_MOVEMENT_REASON_PREFIXES: [
      "Annul ",
      "Delete ",
      "Restore ",
      "Edit ",
      "Price change ",
    ],
    recordCashMovement: async (
      conn,
      branch,
      username,
      type,
      amount,
      reason,
      currency,
      createdAt
    ) => {
      const decimal = checkPositive(amount, reason);
      if (type !== "increase" && type !== "reduce") {
        throw new Error("type must be 'increase' or 'reduce'");
      }
      if (failReduce && type === "reduce") {
        throw new Error("insufficient current cash for reduction");
      }
      movements.push({
        where: "cash",
        type,
        amount: decimal,
        currency: currency || "EUR",
        branch: String(branch || ""),
        username,
        reason: reason.trim(),
        createdAt: createdAt || null,
      });
      return decimal;
    },
    // Ledger-only cash movement: a back-dated correction that must NOT touch the
    // running drawer, only the cash_transactions ledger (each day has its own
    // drawer, so a cross-day annulment reduces the creation day's drawer).
    recordCashLedgerOnly: async (
      conn,
      branch,
      username,
      type,
      amount,
      reason,
      currency,
      createdAt
    ) => {
      const decimal = checkPositive(amount, reason);
      if (type !== "increase" && type !== "reduce") {
        throw new Error("type must be 'increase' or 'reduce'");
      }
      movements.push({
        where: "cash-ledger",
        type,
        amount: decimal,
        currency: currency || "EUR",
        branch: String(branch || ""),
        username,
        reason: reason.trim(),
        createdAt: createdAt || null,
      });
      return decimal;
    },
    // Total cash channel movements (Card / Broker). These never touch the cash
    // drawer - they only move the matching part of Total cash - so the test
    // records them separately from `where: "cash"`.
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
    // A branch move transfers the policy's money and re-branches its ledger rows
    // instead of writing a reduce+increase pair. Recorded as a single transfer.
    movePolicyBranch: async (conn, payment, m) => {
      movements.push({
        where: "transfer",
        payment,
        amount: m.amount,
        currency: m.currency || "EUR",
        from: String(m.fromBranch || ""),
        to: String(m.toBranch || ""),
        reason: String(m.reason || "").trim(),
      });
      return m.amount;
    },
  },
  "./CardPayments.js": {
    // The card balance is per branch: the real helpers take the branch first.
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
    // Only this sender is linked to a broker; any other address is unknown.
    // Like the real helper, a "Name <address>" header value is accepted.
    resolveBrokerByEmail: async (conn, email) => {
      const raw = String(email || "").trim();
      const m = raw.match(/<([^>]+)>/);
      const address = (m ? m[1] : raw).trim().toLowerCase();
      return address === "broker@example.com" ? { id: 7, name: "Euroins" } : null;
    },
    blancInBrokerBatches: async () => true,
    decreaseBrokerForInsurance: async (conn, brokerId, price) => {
      brokerDeltas.push({ brokerId, delta: Number(price) });
      return Number(price);
    },
    refreshBrokerBalance: async () => null,
    settleBrokerForUnannulment: async (conn, brokerId, blancNumber, amount) => {
      brokerSettles.push({ brokerId, blancNumber, amount: Number(amount) });
      brokerDeltas.push({ brokerId, delta: Number(amount) });
      return Number(amount);
    },
    restoreBrokerForAnnulment: async (conn, brokerId, price, meta = {}) => {
      brokerRestores.push({ brokerId, amount: Number(price) });
      brokerRestoreMeta.push(meta);
    },
    adjustBrokerForPriceChange: async (conn, brokerId, delta) => {
      if (rejectMissingSaleRow) {
        const err = new Error(
          "This insurance has no sale row in the broker history; repair its history before changing its price"
        );
        err.code = "NO_SALE_MOVEMENT";
        throw err;
      }
      brokerDeltas.push({ brokerId, delta });
      return delta;
    },
    resolveBrokerCutOff: async () => false,
    getBrokerAllowNegativeBalance: async () => allowNegativeBalance,
  },
  "./PaymentSchedule.js": { getSchedule: async () => null },
  "../db/branches.js": { isBranchEnabled: async () => true },
  "../Mail/SendReply.js": { sendReply: async () => {} },
  "../Mail/mailStore.js": { markAnswered: () => null },
  "../Mail/threadHistory.js": { fetchThreadConversation: async () => null },
};

// The row the "SELECT * FROM insurance WHERE BlancNumber = ?" lookups return.
// The UPDATE applies its SET clause onto it, so the final SELECT (and therefore
// the JSON response) reflects what the endpoint wrote.
let row = null;
// Blank numbers already used by OTHER policies, so changing a policy's blank
// number to one of them is reported as a clash.
let takenBlancs = [];
// Accounts the author lookup accepts (soft-deleted ones are absent, exactly
// like the real query) and the brokers the broker lookup can resolve.
let knownUsers = ["admin1", "worker1", "worker2"];
let knownBrokers = { 5: "Тест Брокер", 7: "Euroins" };

const fakeDb = {
  query: async (sql, params) => {
    const flat = String(sql).replace(/\s+/g, " ").trim();
    queries.push({ sql: flat, params: params || [], inTx: txDepth > 0 });

    if (flat.startsWith("SELECT BlancNumber FROM insurance")) {
      const wanted = String((params || [])[0]);
      return [takenBlancs.includes(wanted) ? [{ BlancNumber: wanted }] : []];
    }

    // Admin-only author / broker corrections (see the checks at the end).
    if (flat.startsWith("SELECT Username FROM users")) {
      const wanted = String((params || [])[0]);
      return [knownUsers.includes(wanted) ? [{ Username: wanted }] : []];
    }
    if (flat.startsWith("SELECT id, Name FROM brokers")) {
      const id = Number((params || [])[0]);
      return [knownBrokers[id] ? [{ id, Name: knownBrokers[id] }] : []];
    }

    if (flat.startsWith("SELECT * FROM insurance")) {
      return [row ? [{ ...row }] : []];
    }
    // A blanc correction relabels the policy's drawer rows (see the comment at
    // the relabel in Requests/TierEndpoints.js).
    const rename = flat.match(
      /^UPDATE (cash_transactions|total_cash_transactions) SET Reason = \? WHERE Reason = \?$/
    );
    if (rename) {
      renames.push({ table: rename[1], from: params[1], to: params[0] });
      return [{ affectedRows: 1 }];
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
  (r) => r.method === "patch" && r.path === "/insurances/:blancNumber"
);
if (!route) {
  console.error("PATCH /insurances/:blancNumber was not registered");
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

// One-line description of a movement, so the assertions read like the ledgers
// the user sees in "Current cash" / "Total cash" / "Card".
const describe = (m) =>
  m.where === "cash"
    ? `cash ${m.type} ${m.amount} ${m.currency} @ ${m.branch} (${m.reason}) by ${m.username}`
    : m.where === "cash-ledger"
    ? `cash-ledger ${m.type} ${m.amount} ${m.currency} @ ${m.branch} (${m.reason}) by ${m.username}`
    : m.where === "total"
    ? `total/${m.source} ${m.type} ${m.amount} ${m.currency} @ ${m.branch} (${m.reason}) by ${m.username}`
    : m.where === "transfer"
    ? `transfer ${m.payment} ${m.amount} ${m.currency} @ ${m.from} -> ${m.to} (${m.reason})`
    : `card ${m.type} ${m.amount} (${m.reason}) by ${m.username}`;

// BASE_ROW's creation date is "today" (UTC, matching the annul handler's
// clientLocalDateTime fallback), so the default annul tests exercise the
// same-day path. Cross-day tests override it with a past date.
const _now = new Date();
const _p2 = (n) => String(n).padStart(2, "0");
const TODAY_DATETIME = `${_now.getUTCFullYear()}-${_p2(_now.getUTCMonth() + 1)}-${_p2(_now.getUTCDate())} 12:00:00`;

const BASE_ROW = {
  BlancNumber: "1234567",
  CreationDate: TODAY_DATETIME,
  PolicyNumber: "P-001",
  Price: "100.00",
  CurrencyType: "EUR",
  Branch: "Офис Харманли",
  Otomobil: "Лек автомобил",
  PaymentType: "Cash",
  Duration: 365,
  StartDate: "2026-10-01",
  NonTurk: 0,
  CardFee: 0,
  Annulled: 0,
  Deleted: 0,
  Author: "worker1",
  Broker: "Euroins",
};

// Calls PATCH /insurances/:blancNumber with `body` against a freshly seeded row
// and returns the response plus every balance movement it asked for.
async function patch(body, opts = {}) {
  movements.length = 0;
  brokerDeltas.length = 0;
  brokerRestores.length = 0;
  brokerRestoreMeta.length = 0;
  brokerSettles.length = 0;
  queries.length = 0;
  renames.length = 0;
  txCount = 0;
  failReduce = !!opts.failReduce;
  rejectMissingSaleRow = !!opts.rejectMissingSaleRow;
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
      body,
      user: { role: opts.role || 1, username: opts.username || "admin1" },
    },
    res
  );

  failReduce = false;
  rejectMissingSaleRow = false;
  return {
    status: res.statusCode,
    body: res.body,
    movements: movements.map(describe),
    brokerDeltas: brokerDeltas.map((d) => `${d.delta} -> broker ${d.brokerId}`),
    brokerRestores: brokerRestores.map(
      (r) => `${r.amount} -> broker ${r.brokerId}`
    ),
    brokerSettles: brokerSettles.map(
      (s) => `${s.amount} -> broker ${s.brokerId} (${s.blancNumber})`
    ),
    updated: queries.filter((q) => q.sql.startsWith("UPDATE insurance SET")),
    renames: renames.map((r) => `${r.table}: ${r.from} -> ${r.to}`),
    tx: txCount,
    row: { ...row },
  };
}

(async () => {
  console.log("PATCH /insurances/:blancNumber — money side-effects");

  await check("correcting the price of a cash policy moves current cash", async () => {
    const r = await patch({ Price: 120 });
    eq(r.status, 200, "status");
    eq(
      r.movements,
      [
        "cash reduce 100 EUR @ Офис Харманли (Edit 1234567) by admin1",
        "cash increase 120 EUR @ Офис Харманли (1234567) by admin1",
      ],
      "movements"
    );
    eq(r.row.Price, "120", "stored price");
  });

  await check("a lower price takes the difference back out of the drawer", async () => {
    const r = await patch({ Price: 10 });
    eq(
      r.movements,
      [
        "cash reduce 100 EUR @ Офис Харманли (Edit 1234567) by admin1",
        "cash increase 10 EUR @ Офис Харманли (1234567) by admin1",
      ],
      "movements"
    );
  });

  await check("a field that is not about money leaves the balances alone", async () => {
    const r = await patch({ PolicyNumber: "P-002", Otomobil: "Камион" });
    eq(r.status, 200, "status");
    eq(r.movements, [], "no movements expected");
    eq(r.row.PolicyNumber, "P-002", "stored policy number");
    eq(r.updated.length, 1, "the row was still updated");
  });

  await check("re-saving the same price and payment type moves nothing", async () => {
    const r = await patch({
      Price: 100,
      PaymentType: "Cash",
      Branch: "Офис Харманли",
      CurrencyType: "EUR",
    });
    eq(r.status, 200, "status");
    eq(r.movements, [], "no movements expected");
    eq(r.updated.length, 1, "the row was still updated");
  });

  await check("a medical policy may be saved without border numbers", async () => {
    // The add form leaves the blanc / car numbers empty for a hand-priced
    // product; the editor must not refuse the same blanks. A blank blanc keeps
    // the stored key instead of clearing the primary key.
    const r = await patch(
      { Kind: "medical", BlancNumber: "", PolicyNumber: "", CarNumber: "", Price: 120 },
      {
        row: {
          Kind: "medical",
          BlancNumber: "MED-20261127141530-4F2A",
          PolicyNumber: "MED-20261127141530-9B3C",
          CarNumber: "",
          BrokerId: null,
        },
      }
    );
    eq(r.status, 200, "status");
    eq(r.row.Kind, "medical", "kind saved");
    eq(r.row.CarNumber, "", "the car number stays blank");
    ok(
      !r.updated.some((q) =>
        q.sql.slice(0, q.sql.indexOf(" WHERE ")).includes("BlancNumber = ?")
      ),
      "the stored blanc number (the key) is kept"
    );
    ok(
      !r.updated.some((q) =>
        q.sql.slice(0, q.sql.indexOf(" WHERE ")).includes("PolicyNumber = ?")
      ),
      "the stored policy reference is kept"
    );
  });

  await check("a border policy still refuses a blank car number", async () => {
    const r = await patch({ CarNumber: "  " });
    eq(r.status, 400, "status");
    eq(r.body.error, "CarNumber is required", "message");
    eq(r.row.CarNumber, undefined, "nothing changed");
  });

  await check("switching Cash -> Card moves the money into the card balance", async () => {
    const r = await patch({ PaymentType: "Card" });
    eq(
      r.movements,
      [
        "cash reduce 100 EUR @ Офис Харманли (Edit 1234567) by admin1",
        "card increase 100 (1234567) by admin1",
        "total/Card increase 100 EUR @ Офис Харманли (1234567) by admin1",
      ],
      "movements"
    );
    eq(r.row.PaymentType, "Card", "stored payment type");
  });

  await check("switching Card -> Cash moves the money into the drawer", async () => {
    const r = await patch({ PaymentType: "Cash" }, { row: { PaymentType: "Card" } });
    eq(
      r.movements,
      [
        "card reduce 100 (Edit 1234567) by admin1",
        "total/Card reduce 100 EUR @ Офис Харманли (Edit 1234567) by admin1",
        "cash increase 100 EUR @ Офис Харманли (1234567) by admin1",
      ],
      "movements"
    );
  });

  await check("price and payment type can change in the same edit", async () => {
    const r = await patch({ Price: 80, PaymentType: "Card" });
    eq(
      r.movements,
      [
        "cash reduce 100 EUR @ Офис Харманли (Edit 1234567) by admin1",
        "card increase 80 (1234567) by admin1",
        "total/Card increase 80 EUR @ Офис Харманли (1234567) by admin1",
      ],
      "movements"
    );
  });

  await check("a new branch re-branches the policy and transfers its money", async () => {
    const r = await patch({ Branch: "ГКПП Лесово" });
    eq(
      r.movements,
      ["transfer Cash 100 EUR @ Офис Харманли -> ГКПП Лесово (1234567)"],
      "movements"
    );
  });

  await check("a branch move and a price change can happen in one edit", async () => {
    const r = await patch({ Branch: "ГКПП Лесово", Price: 120 });
    eq(
      r.movements,
      [
        "transfer Cash 100 EUR @ Офис Харманли -> ГКПП Лесово (1234567)",
        "cash reduce 100 EUR @ ГКПП Лесово (Edit 1234567) by admin1",
        "cash increase 120 EUR @ ГКПП Лесово (1234567) by admin1",
      ],
      "movements"
    );
    eq(r.row.Branch, "ГКПП Лесово", "stored branch");
    eq(r.row.Price, "120", "stored price");
  });

  await check("a new currency moves the money between the currency balances", async () => {
    const r = await patch(
      { CurrencyType: "TRY" },
      { row: { Branch: "ГКПП Лесово", Otomobil: "Otomobil" } }
    );
    eq(r.status, 200, "status");
    eq(
      r.movements,
      [
        "cash reduce 100 EUR @ ГКПП Лесово (Edit 1234567) by admin1",
        "cash increase 100 TRY @ ГКПП Лесово (1234567) by admin1",
      ],
      "movements"
    );
    eq(r.row.CurrencyType, "TRY", "stored currency");
  });

  await check("the price of an annulled policy is its tax, not a separate field", async () => {
    // A converted row stores the tax in Price and the sale price in
    // OriginalPrice. Price is not edited directly (the client keeps it
    // read-only; the Fee field changes both), so a body carrying only Price
    // has nothing to update and must not move money.
    const r = await patch(
      { Price: 200 },
      {
        row: {
          Annulled: 1,
          AnnulReason: "worker",
          AnnulFee: 9,
          Price: 9,
          OriginalPrice: 100,
        },
      }
    );
    eq(r.status, 400, "nothing to update");
    eq(r.body, { error: "Nothing to update" }, "error");
    eq(r.movements, [], "no movements");
    eq(r.row.Price, 9, "the tax stays the price");
    eq(r.row.AnnulFee, 9, "and the fee is unchanged");
  });

  await check("the user making the edit is recorded on both movements", async () => {
    const r = await patch({ Price: 130 }, { role: 2, username: "worker1" });
    eq(
      r.movements,
      [
        "cash reduce 100 EUR @ Офис Харманли (Edit 1234567) by worker1",
        "cash increase 130 EUR @ Офис Харманли (1234567) by worker1",
      ],
      "movements"
    );
  });

  await check("lowercase body keys move the money too", async () => {
    const r = await patch({ price: 140, paymentType: "Card" });
    eq(
      r.movements,
      [
        "cash reduce 100 EUR @ Офис Харманли (Edit 1234567) by admin1",
        "card increase 140 (1234567) by admin1",
        "total/Card increase 140 EUR @ Офис Харманли (1234567) by admin1",
      ],
      "movements"
    );
  });

  await check("the row update and the movements share one transaction", async () => {
    const r = await patch({ Price: 120 });
    eq(r.tx, 1, "exactly one transaction");
    eq(r.updated.length, 1, "one UPDATE");
    ok(r.updated[0].inTx, "the UPDATE must run inside the transaction");
  });

  await check("an unfunded reversal fails the whole edit", async () => {
    const r = await patch({ Price: 120 }, { failReduce: true });
    eq(r.status, 400, "status");
    ok(
      String(r.body && r.body.error).includes("insufficient"),
      "the error should say the drawer is short: " + JSON.stringify(r.body)
    );
    eq(r.updated.length, 0, "the row must not change when the money cannot move");
    eq(r.row.Price, "100.00", "price unchanged");
    eq(r.movements, [], "nothing may survive the rollback");
  });

  await check("a worker can edit somebody else's policy too", async () => {
    const r = await patch({ Price: 120 }, { role: 2, username: "someoneElse" });
    eq(r.status, 200, "status");
    eq(
      r.movements,
      [
        "cash reduce 100 EUR @ Офис Харманли (Edit 1234567) by someoneElse",
        "cash increase 120 EUR @ Офис Харманли (1234567) by someoneElse",
      ],
      "movements"
    );
    eq(r.row.Price, "120", "stored price");
  });

  await check("an empty edit is rejected before any money moves", async () => {
    const r = await patch({});
    eq(r.status, 400, "status");
    eq(r.movements, [], "no movements expected");
    eq(r.tx, 0, "no transaction");
    eq(r.updated.length, 0, "nothing written");
  });

  // -------------------------------------------------------------------------
  // Broker-funded (email) policies.
  //
  // An insurance created from a broker's email is paid out of that broker's
  // balance, so its money must NEVER go through the cash drawer: reversing and
  // re-applying its contribution happens on the Broker channel of Total cash,
  // and the broker's own balance follows the corrected price.
  // -------------------------------------------------------------------------
  const BROKER_ROW = { BrokerId: 7, PaymentType: "Broker" };

  await check("a broker-funded policy never touches current cash", async () => {
    const r = await patch({ Price: 120 }, { row: BROKER_ROW });
    eq(r.status, 200, "status");
    eq(
      r.movements,
      [
        "total/Broker reduce 100 EUR @ Офис Харманли (Edit 1234567) by admin1",
        "total/Broker increase 120 EUR @ Офис Харманли (1234567) by admin1",
      ],
      "movements"
    );
    ok(
      !r.movements.some((m) => m.startsWith("cash ")),
      "current cash must stay untouched for an email payment"
    );
  });

  await check("a price correction re-syncs the broker's own balance", async () => {
    const r = await patch({ Price: 120 }, { row: BROKER_ROW });
    eq(r.brokerDeltas, ["20 -> broker 7"], "the broker is charged the difference");
  });

  await check("a price correction without a sale row is refused", async () => {
    const r = await patch(
      { Price: 120 },
      { row: BROKER_ROW, rejectMissingSaleRow: true }
    );
    eq(r.status, 409, "the edit is rejected");
    ok(
      String(r.body && r.body.error).includes("no sale row"),
      "the error explains the missing sale row"
    );
    eq(
      r.updated.length,
      0,
      "the insurance row is not written (the transaction rolled back)"
    );
  });

  await check("a lower price refunds the difference to the broker", async () => {
    const r = await patch({ Price: 70 }, { row: BROKER_ROW });
    eq(r.brokerDeltas, ["-30 -> broker 7"], "the broker gets the difference back");
  });

  await check("re-saving the same price does not move the broker balance", async () => {
    const r = await patch({ Price: 100 }, { row: BROKER_ROW });
    eq(r.movements, [], "no ledger movements");
    eq(r.brokerDeltas, [], "no balance adjustment");
  });

  await check("a non-money edit on a broker-funded policy moves nothing", async () => {
    const r = await patch({ Otomobil: "Камион" }, { row: BROKER_ROW });
    eq(r.movements, [], "no movements expected");
    eq(r.brokerDeltas, [], "no balance adjustment");
  });

  for (const payment of ["Card", "Cash"]) {
    await check(`an email policy cannot be switched to ${payment}`, async () => {
      const r = await patch({ PaymentType: payment }, { row: BROKER_ROW });
      eq(r.status, 400, "status");
      eq(
        r.body,
        { error: "Email policies are paid from the broker balance only" },
        "error"
      );
      eq(r.movements, [], "no money moves");
      eq(r.brokerDeltas, [], "the broker balance stays");
      eq(r.updated.length, 0, "the row is not written");
      eq(r.row.PaymentType, "Broker", "still broker-paid");
    });
  }

  await check("re-sending Broker on an email policy is allowed", async () => {
    const r = await patch({ PaymentType: "Broker", Price: 120 }, { row: BROKER_ROW });
    eq(r.status, 200, "status");
    eq(r.row.PaymentType, "Broker", "stored payment type");
    eq(r.brokerDeltas, ["20 -> broker 7"], "price change still applied");
  });

  await check("a legacy email row stored as Cash is relabelled Broker", async () => {
    // Before the Broker type existed, email policies were stored as "Cash"
    // while already being funded by the broker balance.
    const r = await patch(
      { Price: 120, Otomobil: "Камион" },
      { row: { BrokerId: 7, PaymentType: "Cash" } }
    );
    eq(r.status, 200, "status");
    eq(
      r.movements,
      [
        "total/Broker reduce 100 EUR @ Офис Харманли (Edit 1234567) by admin1",
        "total/Broker increase 120 EUR @ Офис Харманли (1234567) by admin1",
      ],
      "treated as a broker payment, never as drawer cash"
    );
  });

  await check("a legacy email row stored as Card is treated as Broker", async () => {
    // Email cards are broker-balance ONLY: the card balance is never moved
    // by an email policy, whatever PaymentType an old row carries.
    const r = await patch(
      { Price: 120 },
      { row: { BrokerId: 7, PaymentType: "Card" } }
    );
    eq(r.status, 200, "status");
    eq(
      r.movements,
      [
        "total/Broker reduce 100 EUR @ Офис Харманли (Edit 1234567) by admin1",
        "total/Broker increase 120 EUR @ Офис Харманли (1234567) by admin1",
      ],
      "only the Broker channel moves"
    );
    ok(
      !r.movements.some((m) => m.startsWith("cash ") || m.startsWith("card ")),
      "neither current cash nor the card balance is touched"
    );
    eq(r.brokerDeltas, ["20 -> broker 7"], "the broker balance follows the price");
  });

  await check("a walk-in cannot be switched to Broker", async () => {
    const r = await patch({ PaymentType: "Broker" }, { row: { BrokerId: null } });
    eq(r.status, 400, "status");
    eq(
      r.body,
      { error: "Only email policies can be paid from a broker balance" },
      "error"
    );
    eq(r.updated.length, 0, "the row is not written");
  });

  await check("walk-in policies can still be switched to Card", async () => {
    const r = await patch({ PaymentType: "Card" }, { row: { BrokerId: null } });
    eq(r.status, 200, "status");
    eq(r.row.PaymentType, "Card", "stored payment type");
  });

  await check("a new branch moves a broker-funded entry between branches", async () => {
    const r = await patch({ Branch: "ГКПП Лесово" }, { row: BROKER_ROW });
    eq(
      r.movements,
      ["transfer Broker 100 EUR @ Офис Харманли -> ГКПП Лесово (1234567)"],
      "movements"
    );
    ok(
      !r.movements.some((m) => m.startsWith("cash ")),
      "current cash must stay untouched"
    );
  });

  await check("an empty drawer cannot block a broker-funded edit", async () => {
    // Nothing is taken out of the cash drawer here, so the edit must succeed
    // even when a cash reduction would have failed for lack of funds.
    const r = await patch({ Price: 120 }, { row: BROKER_ROW, failReduce: true });
    eq(r.status, 200, "status");
    eq(r.row.Price, "120", "the correction is stored");
    eq(r.brokerDeltas, ["20 -> broker 7"], "the balance still follows the price");
  });

  await check("a policy without a broker link stays a normal cash payment", async () => {
    const r = await patch({ Price: 120 }, { row: { BrokerId: null } });
    eq(
      r.movements,
      [
        "cash reduce 100 EUR @ Офис Харманли (Edit 1234567) by admin1",
        "cash increase 120 EUR @ Офис Харманли (1234567) by admin1",
      ],
      "movements"
    );
    eq(r.brokerDeltas, [], "no balance adjustment");
  });

  // -------------------------------------------------------------------------
  // Editing the options chosen at creation (non-Turk / card payment fee).
  // The edit modal adds/removes the fee from the price it sends, so the money
  // follows the new price through the usual reverse + re-apply.
  // -------------------------------------------------------------------------
  await check("ticking non-Turk stores the flag and adds the fee to the drawer", async () => {
    const r = await patch({ NonTurk: true, Price: 105 });
    eq(r.status, 200, "status");
    eq(r.row.NonTurk, 1, "stored flag");
    eq(
      r.movements,
      [
        "cash reduce 100 EUR @ Офис Харманли (Edit 1234567) by admin1",
        "cash increase 105 EUR @ Офис Харманли (1234567) by admin1",
      ],
      "movements"
    );
  });

  await check("unticking non-Turk stores the flag and takes the fee back", async () => {
    const r = await patch({ NonTurk: false, Price: 95 }, { row: { NonTurk: 1 } });
    eq(r.row.NonTurk, 0, "stored flag");
    eq(
      r.movements,
      [
        "cash reduce 100 EUR @ Офис Харманли (Edit 1234567) by admin1",
        "cash increase 95 EUR @ Офис Харманли (1234567) by admin1",
      ],
      "movements"
    );
  });

  await check("re-sending unchanged options moves nothing", async () => {
    const r = await patch({ NonTurk: false, CardFee: false, Price: 100 });
    eq(r.status, 200, "status");
    eq(r.movements, [], "no movements expected");
  });

  await check("card fee is never stored on a card policy", async () => {
    const r = await patch(
      { PaymentType: "Card", CardFee: true, Price: 100 },
      { row: { PaymentType: "Card" } }
    );
    eq(r.row.CardFee, 0, "stored flag stays 0");
    eq(r.movements, [], "no movements expected");
  });

  await check("a card fee is never stored for a cash payment", async () => {
    const r = await patch({ PaymentType: "Cash", CardFee: true });
    eq(r.row.CardFee, 0, "stored flag");
  });

  await check("an email policy cannot be flagged non-Turk", async () => {
    for (const v of [true, 1, "1", "true"]) {
      const r = await patch({ NonTurk: v, Price: 105 }, { row: BROKER_ROW });
      eq(r.status, 400, `status for ${JSON.stringify(v)}`);
      eq(
        r.body,
        { error: "The non-Turk tax only applies to walk-in policies" },
        "error"
      );
      eq(r.updated.length, 0, "nothing is updated");
      eq(r.movements, [], "no money moves");
      eq(r.brokerDeltas, [], "the broker is not charged");
    }
  });

  await check("a legacy non-Turk flag on an email policy can be cleared", async () => {
    const r = await patch(
      { NonTurk: false, Price: 95 },
      { row: { ...BROKER_ROW, NonTurk: 1 } }
    );
    eq(r.status, 200, "status");
    eq(r.row.NonTurk, 0, "flag cleared");
    eq(r.brokerDeltas, ["-5 -> broker 7"], "the broker gets the 5 back");
  });

  await check("an email policy edit without NonTurk is unaffected", async () => {
    const r = await patch({ Price: 120 }, { row: { ...BROKER_ROW, NonTurk: 1 } });
    eq(r.status, 200, "status");
  });

  // -------------------------------------------------------------------------
  // POST /worker/insurances - card payments are only for walk-ins.
  // -------------------------------------------------------------------------
  const createRoute = routes.find(
    (r) => r.method === "post" && r.path === "/worker/insurances"
  );
  const createHandler = createRoute.handlers[createRoute.handlers.length - 1];

  async function create(body) {
    movements.length = 0;
    brokerDeltas.length = 0;
    queries.length = 0;
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
    await createHandler(
      {
        params: {},
        query: {},
        body: Object.assign(
          {
            BlancNumber: "7654321",
            PolicyNumber: "P-9",
            CarNumber: "CA1234AB",
            Price: 50,
            CurrencyType: "EUR",
            Duration: 30,
            Branch: "Офис Харманли",
            Otomobil: "Лек автомобил",
            DisableReturnEmail: true,
          },
          body
        ),
        user: { role: 2, username: "worker1" },
      },
      res
    );
    const inserts = queries.filter((q) =>
      q.sql.startsWith("INSERT INTO insurance")
    );
    return {
      status: res.statusCode,
      body: res.body,
      movements: movements.map(describe),
      brokerDeltas: brokerDeltas.map((d) => `${d.delta} -> broker ${d.brokerId}`),
      inserts,
      // Column order of the real INSERT:
      //   Author, CreationDate, PolicyNumber, BlancNumber, CarNumber, Price,
      //   CurrencyType, Duration, Broker, Branch, Otomobil, Kind, PaymentType,
      //   StartDate, BrokerId, NonTurk, CardFee
      // so PaymentType is index 12 and CardFee index 16.
      storedPayment: inserts.length ? inserts[0].params[12] : undefined,
      storedCardFee: inserts.length ? inserts[0].params[16] : undefined,
    };
  }

  await check("car, policy and blank number are required for walk-ins and email cards", async () => {
    const email = { PaymentType: "Broker", EmailFrom: "Broker <broker@example.com>" };
    const walkIn = { PaymentType: "Cash" };
    const cases = [
      ["BlancNumber", "BlancNumber is required"],
      ["CarNumber", "CarNumber is required"],
      ["PolicyNumber", "PolicyNumber is required"],
    ];
    for (const [mode, extra] of [["walk-in", walkIn], ["email", email]]) {
      for (const [field, error] of cases) {
        for (const blank of ["", "   ", undefined]) {
          const r = await create({ ...extra, [field]: blank });
          const what = `${mode} with ${field}=${JSON.stringify(blank)}`;
          eq(r.status, 400, `status for ${what}`);
          eq(r.body, { error }, `error for ${what}`);
          eq(r.inserts.length, 0, `nothing inserted for ${what}`);
          eq(r.movements, [], `no money moved for ${what}`);
          eq(r.brokerDeltas, [], `broker untouched for ${what}`);
        }
      }
    }
  });

  await check("a walk-in with all three numbers is created", async () => {
    const r = await create({ PaymentType: "Cash" });
    eq(r.status, 201, "status");
    eq(r.inserts.length, 1, "one insert");
  });

  await check("an email policy is stored as Broker and only charges the broker", async () => {
    const r = await create({
      PaymentType: "Broker",
      EmailFrom: "Broker <broker@example.com>",
    });
    eq(r.status, 201, "status");
    eq(r.storedPayment, "Broker", "stored payment type");
    eq(
      r.movements,
      ["total/Broker increase 50 EUR @ Офис Харманли (7654321) by worker1"],
      "only the Broker channel of Total cash moves"
    );
    ok(
      !r.movements.some((m) => m.startsWith("cash ") || m.startsWith("card ")),
      "neither current cash nor the card balance is touched"
    );
    eq(r.brokerDeltas, ["50 -> broker 7"], "the broker balance pays for it");
  });

  await check("a broker request is rejected when negative balance is disabled", async () => {
    allowNegativeBalance = false;
    try {
      const r = await create({
        PaymentType: "Broker",
        EmailFrom: "Broker <broker@example.com>",
        Price: 50,
      });
      eq(r.status, 400, "status");
      eq(
        r.body,
        { error: "Broker request rejected: negative balance not allowed" },
        "error"
      );
      eq(r.inserts.length, 0, "nothing inserted");
      eq(r.movements, [], "no money moved");
      eq(r.brokerDeltas, [], "broker untouched");
    } finally {
      allowNegativeBalance = true;
    }
  });

  await check("creating an email policy paid by card is rejected", async () => {
    const r = await create({
      PaymentType: "Card",
      CardFee: true,
      EmailFrom: "broker@example.com",
    });
    eq(r.status, 400, "status");
    eq(
      r.body,
      { error: "Email policies are paid from the broker balance only" },
      "error"
    );
    eq(r.inserts.length, 0, "nothing is inserted");
    eq(r.movements, [], "no money moves");
    eq(r.brokerDeltas, [], "the broker is not charged");
  });

  await check("a legacy Cash flag on an email policy is stored as Broker", async () => {
    // Older clients still send `Cash: true` for email policies; that is not a
    // cash payment - it is coerced to the broker balance.
    const r = await create({ Cash: true, EmailFrom: "broker@example.com" });
    eq(r.status, 201, "status");
    eq(r.storedPayment, "Broker", "stored payment type");
    ok(
      !r.movements.some((m) => m.startsWith("cash ")),
      "current cash is never touched"
    );
    eq(r.brokerDeltas, ["50 -> broker 7"], "the broker balance pays for it");
  });

  await check("creating an email policy with the non-Turk tax is rejected", async () => {
    const r = await create({
      PaymentType: "Broker",
      EmailFrom: "Broker <broker@example.com>",
      NonTurk: true,
    });
    eq(r.status, 400, "status");
    eq(
      r.body,
      { error: "The non-Turk tax only applies to walk-in policies" },
      "error"
    );
    eq(r.inserts.length, 0, "nothing is inserted");
    eq(r.movements, [], "no money moves");
    eq(r.brokerDeltas, [], "the broker is not charged");
  });

  await check("an email policy with NonTurk=false is still created", async () => {
    const r = await create({
      PaymentType: "Broker",
      EmailFrom: "broker@example.com",
      NonTurk: false,
    });
    eq(r.status, 201, "status");
    eq(r.inserts[0].params[15], 0, "stored NonTurk");
  });

  await check("a walk-in keeps the non-Turk tax", async () => {
    const r = await create({ PaymentType: "Cash", EmailFrom: "", NonTurk: true });
    eq(r.status, 201, "status");
    eq(r.inserts[0].params[15], 1, "stored NonTurk");
  });

  await check("an email from an unknown sender is rejected", async () => {
    const r = await create({
      PaymentType: "Broker",
      EmailFrom: "stranger@example.com",
    });
    eq(r.status, 400, "status");
    eq(
      r.body,
      { error: "The email sender is not linked to a broker" },
      "error"
    );
    eq(r.inserts.length, 0, "nothing is inserted");
    eq(r.movements, [], "no money moves");
  });

  await check("a walk-in cannot be paid from a broker balance", async () => {
    const r = await create({ PaymentType: "Broker", EmailFrom: "" });
    eq(r.status, 400, "status");
    eq(
      r.body,
      { error: "Only email policies can be paid from a broker balance" },
      "error"
    );
    eq(r.inserts.length, 0, "nothing is inserted");
  });

  await check("a walk-in paid in cash still goes to current cash", async () => {
    const r = await create({ PaymentType: "Cash", EmailFrom: "" });
    eq(r.status, 201, "status");
    eq(r.storedPayment, "Cash", "stored payment type");
    eq(
      r.movements,
      ["cash increase 50 EUR @ Офис Харманли (7654321) by worker1"],
      "cash movement"
    );
    eq(r.brokerDeltas, [], "no broker involved");
  });

  await check("creating a walk-in policy paid by card is still accepted", async () => {
    const r = await create({ Cash: false, CardFee: true, EmailFrom: "" });
    eq(r.status, 201, "status");
    eq(r.storedPayment, "Card", "stored payment type");
    eq(r.storedCardFee, 0, "the card fee is visual only and never stored");
    eq(
      r.movements,
      [
        "card increase 50 (7654321) by worker1",
        "total/Card increase 50 EUR @ Офис Харманли (7654321) by worker1",
      ],
      "card movements"
    );
  });

  // -------------------------------------------------------------------------
  // Walk-ins record their branch as the broker.
  //
  // With the CreationDate and Kind columns in the INSERT, Broker is the 9th
  // bound value (index 8) and BrokerId the 15th (index 14).
  // -------------------------------------------------------------------------
  await check("a walk-in records its branch as the broker", async () => {
    const r = await create({ PaymentType: "Cash", EmailFrom: "" });
    eq(r.status, 201, "status");
    eq(r.inserts[0].params[8], "Офис Харманли", "stored broker");
    eq(
      r.inserts[0].params[11],
      "border",
      "the worker form only sells border insurance"
    );
    eq(r.inserts[0].params[14], null, "BrokerId stays empty");
    eq(r.brokerDeltas, [], "no broker balance is charged");
  });

  await check("a card walk-in also records its branch as the broker", async () => {
    const r = await create({ Cash: false, EmailFrom: "", Branch: "ГКПП Лесово" });
    eq(r.status, 201, "status");
    eq(r.inserts[0].params[8], "ГКПП Лесово", "stored broker");
    eq(r.storedPayment, "Card", "still a card payment");
  });

  await check("an email policy keeps the real broker's name", async () => {
    const r = await create({
      PaymentType: "Broker",
      EmailFrom: "broker@example.com",
    });
    eq(r.status, 201, "status");
    eq(r.inserts[0].params[8], "Euroins", "stored broker");
    eq(r.inserts[0].params[14], 7, "BrokerId");
  });

  await check("moving a walk-in to another branch moves its broker too", async () => {
    const r = await patch(
      { Branch: "ГКПП Лесово" },
      { row: { BrokerId: null, Broker: "Офис Харманли" } }
    );
    eq(r.status, 200, "status");
    eq(r.row.Branch, "ГКПП Лесово", "stored branch");
    eq(r.row.Broker, "ГКПП Лесово", "stored broker follows the branch");
  });

  await check("an older walk-in without a broker gets the new branch", async () => {
    const r = await patch(
      { Branch: "ГКПП Лесово" },
      { row: { BrokerId: null, Broker: "" } }
    );
    eq(r.row.Broker, "ГКПП Лесово", "stored broker");
  });

  await check("moving an email policy to another branch keeps its broker", async () => {
    const r = await patch({ Branch: "ГКПП Лесово" }, { row: BROKER_ROW });
    eq(r.status, 200, "status");
    eq(r.row.Broker, "Euroins", "the real broker is kept");
  });

  await check("a walk-in with a hand-typed broker keeps it on branch change", async () => {
    const r = await patch(
      { Branch: "ГКПП Лесово" },
      { row: { BrokerId: null, Broker: "Euroins" } }
    );
    eq(r.row.Broker, "Euroins", "the legacy broker is kept");
  });

  // -------------------------------------------------------------------------
  // Blank number / car number corrections.
  // -------------------------------------------------------------------------
  await check("the car number can be corrected without moving money", async () => {
    const r = await patch({ CarNumber: "  CB1234AB " });
    eq(r.status, 200, "status");
    eq(r.row.CarNumber, "CB1234AB", "stored (trimmed) car number");
    eq(r.movements, [], "no movements expected");
  });

  await check("an empty car number is rejected", async () => {
    const r = await patch({ CarNumber: "   " }, { row: { CarNumber: "X1" } });
    eq(r.status, 400, "status");
    eq(r.body, { error: "CarNumber is required" }, "error");
    eq(r.updated.length, 0, "nothing was written");
  });

  await check("the blank number can be changed to an unused one", async () => {
    takenBlancs = [];
    const r = await patch({ BlancNumber: " 7654321 " });
    eq(r.status, 200, "status");
    eq(r.row.BlancNumber, "7654321", "stored blank number");
    eq(r.updated.length, 1, "one update");
    eq(
      r.updated[0].params[r.updated[0].params.length - 1],
      "1234567",
      "the row is located by its OLD blank number"
    );
    eq(r.body.insurance.BlancNumber, "7654321", "response carries the new number");
    eq(r.movements, [], "no movements expected");
    // The drawer ledger follows the corrected number, in BOTH of its ledgers:
    // the sale row (Reason = the old blanc) and every correction row of the
    // policy. A row left under the old number belongs to no policy, so the
    // derived drawer reads it as money typed in by hand and counts the policy
    // twice (see getAvailableCashAsOf / getDayCash in CurrentCash.js).
    eq(
      r.renames,
      [
        "cash_transactions: 1234567 -> 7654321",
        "cash_transactions: Annul 1234567 -> Annul 7654321",
        "cash_transactions: Delete 1234567 -> Delete 7654321",
        "cash_transactions: Restore 1234567 -> Restore 7654321",
        "cash_transactions: Edit 1234567 -> Edit 7654321",
        "cash_transactions: Price change 1234567 -> Price change 7654321",
        "total_cash_transactions: 1234567 -> 7654321",
        "total_cash_transactions: Annul 1234567 -> Annul 7654321",
        "total_cash_transactions: Delete 1234567 -> Delete 7654321",
        "total_cash_transactions: Restore 1234567 -> Restore 7654321",
        "total_cash_transactions: Edit 1234567 -> Edit 7654321",
        "total_cash_transactions: Price change 1234567 -> Price change 7654321",
      ],
      "the drawer ledger follows the new number"
    );
  });

  await check("re-sending the same blank number is not an update of the key", async () => {
    takenBlancs = ["1234567"];
    const r = await patch({ BlancNumber: "1234567", PolicyNumber: "P-9" });
    takenBlancs = [];
    eq(r.status, 200, "status");
    const setClause = r.updated[0].sql.split(" WHERE ")[0];
    ok(!setClause.includes("BlancNumber"), "BlancNumber is not in the SET clause");
    eq(r.row.PolicyNumber, "P-9", "the other field was still saved");
    eq(r.renames, [], "no ledger relabel when the number did not change");
  });

  await check("a blank number already used by another policy is rejected", async () => {
    takenBlancs = ["999"];
    const r = await patch({ BlancNumber: "999", Price: 150 });
    takenBlancs = [];
    eq(r.status, 409, "status");
    eq(
      r.body,
      { error: "Insurance with this BlancNumber already exists" },
      "error"
    );
    eq(r.updated.length, 0, "nothing was written");
    eq(r.movements, [], "no money moved");
  });

  await check("an empty blank number is rejected", async () => {
    const r = await patch({ BlancNumber: "" });
    eq(r.status, 400, "status");
    eq(r.body, { error: "BlancNumber is required" }, "error");
    eq(r.updated.length, 0, "nothing was written");
  });

  await check("a new blank number with a new price books the money under it", async () => {
    takenBlancs = [];
    const r = await patch({ BlancNumber: "555", Price: 120 });
    eq(r.status, 200, "status");
    eq(
      r.movements,
      [
        "cash reduce 100 EUR @ Офис Харманли (Edit 1234567) by admin1",
        "cash increase 120 EUR @ Офис Харманли (555) by admin1",
      ],
      "movements"
    );
  });

  // -------------------------------------------------------------------------
  // POST /insurances/:blancNumber/annul - the annulment fee.
  //
  // The caller chooses WHO pays the fee (broker or worker). The fee itself is
  // 1 when the policy has not started yet and 9 when it is already in effect,
  // decided by comparing now with the policy's start date.
  // -------------------------------------------------------------------------
  const annulRoute = routes.find(
    (r) => r.method === "post" && r.path === "/insurances/:blancNumber/annul"
  );
  const annulHandler = annulRoute.handlers[annulRoute.handlers.length - 1];

  // YYYY-MM-DD for today shifted by `days`, in local time like the server.
  const dayOffset = (days) => {
    const d = new Date();
    d.setDate(d.getDate() + days);
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  };

  async function annul(body, rowOverrides = {}, opts = {}) {
    movements.length = 0;
    brokerDeltas.length = 0;
    brokerRestores.length = 0;
    brokerRestoreMeta.length = 0;
    brokerSettles.length = 0;
    queries.length = 0;
    row = { ...BASE_ROW, ...rowOverrides };
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
    await annulHandler(
      {
        params: { blancNumber: row.BlancNumber },
        query: {},
        body,
        user: { role: opts.role || 1, username: opts.username || "admin1" },
      },
      res
    );
    const update = queries.find((q) =>
      q.sql.startsWith("UPDATE insurance SET Annulled = 1")
    );
    return {
      status: res.statusCode,
      body: res.body,
      movements: movements.map(describe),
      brokerRestores: brokerRestores.map(
        (r) => `${r.amount} -> broker ${r.brokerId}`
      ),
      // The options the restore was called with (e.g. reuseExisting).
      restoreMeta: brokerRestoreMeta.map((m) => ({ ...m })),
      // AnnulReason (who pays), AnnulFee, OriginalPrice and the new Price as
      // written to the row. Price is the tax once annulled.
      storedPayer: update ? update.params[0] : undefined,
      storedFee: update ? update.params[1] : undefined,
      storedOriginalPrice: update ? update.params[2] : undefined,
      storedPrice: update ? update.params[3] : undefined,
    };
  }

  await check("a policy that has not started yet costs 1 to annul", async () => {
    const r = await annul({ payer: "worker" }, { StartDate: dayOffset(3) });
    eq(r.status, 200, "status");
    eq(r.body.fee, 1, "fee");
    eq(r.body.inEffect, false, "not in effect");
    eq(r.body.refund, 99, "refund = price - fee");
    eq(r.storedFee, 1, "stored fee");
    eq(r.storedPayer, "worker", "stored payer");
    eq(
      r.movements,
      ["cash reduce 99 EUR @ Офис Харманли (Annul 1234567) by admin1"],
      "refund leaves the drawer"
    );
  });

  await check("annulling a cash policy refunds on its creation date", async () => {
    const created = "2020-01-01 10:00:00";
    const r = await annul(
      { payer: "worker" },
      { StartDate: dayOffset(3), CreationDate: created }
    );
    eq(r.status, 200, "status");
    eq(movements.length, 1, "one cash movement");
    eq(movements[0].where, "cash-ledger", "back-dated refund never touches the drawer");
    eq(movements[0].type, "reduce", "refund direction");
    eq(movements[0].createdAt, created, "refund stamped with the creation date");
  });

  await check("a same-day cash annulment still moves the drawer", async () => {
    const created = "2020-01-01 10:00:00";
    const r = await annul(
      { payer: "worker", CreatedAt: "2020-01-01 11:00:00" },
      { StartDate: dayOffset(3), CreationDate: created }
    );
    eq(r.status, 200, "status");
    eq(movements.length, 1, "one cash movement");
    eq(movements[0].where, "cash", "same-day refund touches the drawer");
    eq(movements[0].type, "reduce", "refund direction");
    eq(movements[0].createdAt, created, "refund stamped with the creation date");
  });

  await check("a policy already in effect costs 9 to annul", async () => {
    const r = await annul({ payer: "broker" }, { StartDate: dayOffset(-3) });
    eq(r.status, 200, "status");
    eq(r.body.fee, 9, "fee");
    eq(r.body.inEffect, true, "in effect");
    eq(r.body.refund, 91, "refund = price - fee");
    eq(r.storedPayer, "broker", "stored payer");
    eq(r.storedOriginalPrice, 100, "the sale price is kept");
    eq(r.storedPrice, 9, "the tax becomes the new price");
  });

  await check("a policy starting today is already in effect", async () => {
    const r = await annul({ payer: "worker" }, { StartDate: dayOffset(0) });
    eq(r.body.fee, 9, "fee");
  });

  await check("a Date start value (as mysql2 returns it) is understood", async () => {
    const future = new Date();
    future.setDate(future.getDate() + 5);
    const r = await annul({ payer: "worker" }, { StartDate: future });
    eq(r.body.fee, 1, "fee");
  });

  await check("a policy without a start date is treated as in effect", async () => {
    const r = await annul({ payer: "worker" }, { StartDate: null });
    eq(r.body.fee, 9, "fee");
  });

  await check("the fee does not depend on who pays it", async () => {
    const a = await annul({ payer: "broker" }, { StartDate: dayOffset(2) });
    const b = await annul({ payer: "worker" }, { StartDate: dayOffset(2) });
    eq(a.body.fee, b.body.fee, "same fee");
  });

  await check("a worker cannot dictate the fee", async () => {
    const r = await annul(
      { payer: "worker", fee: 0, AnnulFee: 0 },
      { StartDate: dayOffset(-1) },
      { role: 2, username: "worker1" }
    );
    eq(r.body.fee, 9, "fee comes from the start date only");
  });

  await check("an admin can dictate the fee", async () => {
    const r = await annul(
      { payer: "worker", fee: 5 },
      { StartDate: dayOffset(-1) }
    );
    eq(r.status, 200, "status");
    eq(r.body.fee, 5, "the admin's fee is used");
    eq(r.body.refund, 95, "refund = price - manual fee");
    eq(r.storedFee, 5, "stored fee");
  });

  await check("an admin's fee is ignored for a no-fault annulment", async () => {
    const r = await annul(
      { payer: "none", fee: 5 },
      { StartDate: dayOffset(-1) }
    );
    eq(r.body.fee, 0, "no fault is always free");
    eq(r.body.refund, 100, "full refund");
    eq(r.storedFee, 0, "stored fee");
  });

  await check("a negative fee is rejected", async () => {
    const r = await annul(
      { payer: "worker", fee: -2 },
      { StartDate: dayOffset(-1) }
    );
    eq(r.status, 400, "status");
    eq(r.body, { error: "fee must be a non-negative number" }, "error");
    eq(r.movements, [], "no money moves");
  });

  await check("no fault charges no fee, even when already in effect", async () => {
    for (const start of [dayOffset(-3), dayOffset(3), null]) {
      const r = await annul({ payer: "none" }, { StartDate: start });
      eq(r.status, 200, `status for start ${start}`);
      eq(r.body.fee, 0, "fee");
      eq(r.body.refund, 100, "the full price is refunded");
      eq(r.storedFee, 0, "stored fee");
      eq(r.storedPayer, "none", "stored payer");
    }
  });

  await check("no fault on a cash policy refunds the full price from the drawer", async () => {
    const r = await annul({ payer: "none" }, { StartDate: dayOffset(-1) });
    eq(
      r.movements,
      ["cash reduce 100 EUR @ Офис Харманли (Annul 1234567) by admin1"],
      "full refund"
    );
  });

  await check("the payer must be broker, worker or none", async () => {
    for (const payer of ["", "client", "admin"]) {
      const r = await annul({ payer }, { StartDate: dayOffset(1) });
      eq(r.status, 400, `status for '${payer}'`);
      eq(
        r.body,
        { error: "payer must be one of 'broker', 'worker' or 'none'" },
        "error"
      );
      eq(r.movements, [], "no money moves");
    }
  });

  await check("an older client sending `reason` still works", async () => {
    const r = await annul({ reason: "Broker" }, { StartDate: dayOffset(1) });
    eq(r.status, 200, "status");
    eq(r.storedPayer, "broker", "reason is read as the payer");
    eq(r.body.fee, 1, "fee");
  });

  await check("annulling an email policy refunds through the Broker channel only", async () => {
    const r = await annul(
      { payer: "broker" },
      { StartDate: dayOffset(-1), BrokerId: 7, PaymentType: "Broker" }
    );
    eq(r.status, 200, "status");
    eq(
      r.movements,
      ["total/Broker reduce 91 EUR @ Офис Харманли (Annul 1234567) by admin1"],
      "no current cash or card movement"
    );
  });

  await check("a broker at fault only gets the partial refund back", async () => {
    const r = await annul(
      { payer: "broker" },
      { StartDate: dayOffset(-1), BrokerId: 7, PaymentType: "Broker" }
    );
    eq(r.status, 200, "status");
    eq(r.brokerRestores, ["91 -> broker 7"], "price - fee returns to the broker");
  });

  await check("a worker at fault still refunds the full price to the broker", async () => {
    const r = await annul(
      { payer: "worker" },
      { StartDate: dayOffset(-1), BrokerId: 7, PaymentType: "Broker" }
    );
    eq(r.status, 200, "status");
    eq(r.brokerRestores, ["100 -> broker 7"], "the full price returns to the broker");
    eq(
      r.restoreMeta[0] && r.restoreMeta[0].reuseExisting,
      true,
      "a fresh annulment reuses the policy's refund row instead of adding one"
    );
  });

  await check("no fault refunds the full price to the broker", async () => {
    const r = await annul(
      { payer: "none" },
      { StartDate: dayOffset(-1), BrokerId: 7, PaymentType: "Broker" }
    );
    eq(r.status, 200, "status");
    eq(r.brokerRestores, ["100 -> broker 7"], "the full price returns to the broker");
  });

  // -------------------------------------------------------------------------
  // Admin changing the fault of an already-annulled insurance.
  // -------------------------------------------------------------------------
  await check("an admin can change fault from broker to worker on an annulled broker policy", async () => {
    const r = await patch(
      { AnnulReason: "worker" },
      {
        row: {
          Annulled: 1,
          AnnulReason: "broker",
          AnnulFee: 9,
          StartDate: dayOffset(-1),
          BrokerId: 7,
          PaymentType: "Broker",
        },
      }
    );
    eq(r.status, 200, "status");
    eq(r.row.AnnulReason, "worker", "stored AnnulReason");
    eq(r.row.AnnulFee, 9, "fee stays 9");
    eq(r.movements, [], "channel movement unchanged (still 9 kept)");
    eq(r.brokerRestores, ["9 -> broker 7"], "broker gets the kept 9 fee back");
  });

  await check("an admin can change fault from worker to broker on an annulled broker policy", async () => {
    const r = await patch(
      { AnnulReason: "broker" },
      {
        row: {
          Annulled: 1,
          AnnulReason: "worker",
          AnnulFee: 9,
          StartDate: dayOffset(-1),
          BrokerId: 7,
          PaymentType: "Broker",
        },
      }
    );
    eq(r.status, 200, "status");
    eq(r.row.AnnulReason, "broker", "stored AnnulReason");
    eq(r.row.AnnulFee, 9, "fee stays 9");
    eq(r.movements, [], "channel movement unchanged");
    eq(r.brokerRestores, ["-9 -> broker 7"], "broker is now charged the 9 fee");
  });

  await check("an admin changing fault to none refunds the kept fee from the channel", async () => {
    const r = await patch(
      { AnnulReason: "none" },
      {
        row: {
          Annulled: 1,
          AnnulReason: "worker",
          AnnulFee: 9,
          StartDate: dayOffset(-1),
          PaymentType: "Cash",
        },
      }
    );
    eq(r.status, 200, "status");
    eq(r.row.AnnulReason, "none", "stored AnnulReason");
    eq(r.row.AnnulFee, 0, "fee becomes 0");
    eq(
      r.movements,
      ["cash reduce 9 EUR @ Офис Харманли (Annul 1234567) by admin1"],
      "the kept 9 is refunded out of the drawer"
    );
  });

  await check("an admin changing fault from none to broker charges the fee back", async () => {
    const r = await patch(
      { AnnulReason: "broker" },
      {
        row: {
          Annulled: 1,
          AnnulReason: "none",
          AnnulFee: 0,
          StartDate: dayOffset(-1),
          BrokerId: 7,
          PaymentType: "Broker",
        },
      }
    );
    eq(r.status, 200, "status");
    eq(r.row.AnnulReason, "broker", "stored AnnulReason");
    eq(r.row.AnnulFee, 9, "fee becomes 9");
    eq(
      r.movements,
      ["total/Broker increase 9 EUR @ Офис Харманли (Annul 1234567) by admin1"],
      "the 9 fee is put back into the Broker channel"
    );
    eq(r.brokerRestores, ["-9 -> broker 7"], "broker is charged the 9 fee");
  });

  await check("a worker cannot change the fault of an annulled insurance", async () => {
    const rPatch = await patch(
      { AnnulReason: "none" },
      {
        role: 2,
        username: "worker1",
        row: { Annulled: 1, AnnulReason: "worker", AnnulFee: 9 },
      }
    );
    eq(rPatch.status, 403, "PATCH rejected for worker");
    eq(rPatch.movements, [], "no movements");

    const rAnnul = await annul(
      { payer: "none" },
      { Annulled: 1, AnnulReason: "worker", AnnulFee: 9 },
      { role: 2, username: "worker1" }
    );
    eq(rAnnul.status, 400, "POST /annul rejected for worker on annulled row");
    eq(rAnnul.body, { error: "Insurance already annulled" }, "error");
    eq(rAnnul.movements, [], "no movements");
  });

  await check("an admin can change the fee of an annulled insurance", async () => {
    const r = await patch(
      { AnnulFee: 5 },
      {
        row: {
          Annulled: 1,
          AnnulReason: "worker",
          AnnulFee: 9,
          Price: 9,
          OriginalPrice: 100,
          StartDate: dayOffset(-1),
          PaymentType: "Cash",
        },
      }
    );
    eq(r.status, 200, "status");
    eq(r.row.AnnulReason, "worker", "payer unchanged");
    eq(r.row.AnnulFee, 5, "stored fee");
    eq(r.row.Price, 5, "the tax is the new price");
    eq(
      r.movements,
      ["cash reduce 4 EUR @ Офис Харманли (Annul 1234567) by admin1"],
      "the 4 difference is refunded out of the drawer"
    );
  });

  await check("raising a zero fee without changing the fault takes effect", async () => {
    const r = await patch(
      { AnnulReason: "worker", AnnulFee: 1 },
      {
        row: {
          Annulled: 1,
          AnnulReason: "worker",
          AnnulFee: 0,
          Price: 0,
          OriginalPrice: 25,
          StartDate: dayOffset(-1),
          PaymentType: "Cash",
        },
      }
    );
    eq(r.status, 200, "status");
    eq(r.row.AnnulReason, "worker", "payer unchanged");
    eq(r.row.AnnulFee, 1, "the fee is raised");
    eq(r.row.Price, 1, "Price mirrors the fee");
    eq(
      r.movements,
      ["cash increase 1 EUR @ Офис Харманли (Annul 1234567) by admin1"],
      "the refund is 1 lower, so 1 comes back into the drawer"
    );
  });

  await check("raising a zero fee on a broker policy charges the broker", async () => {
    const r = await patch(
      { AnnulReason: "broker", AnnulFee: 9 },
      {
        row: {
          Annulled: 1,
          AnnulReason: "broker",
          AnnulFee: 0,
          Price: 0,
          OriginalPrice: 100,
          StartDate: dayOffset(-1),
          BrokerId: 7,
          PaymentType: "Broker",
        },
      }
    );
    eq(r.status, 200, "status");
    eq(r.row.AnnulFee, 9, "the fee is raised");
    eq(r.row.Price, 9, "Price mirrors the fee");
    eq(
      r.movements,
      ["total/Broker increase 9 EUR @ Офис Харманли (Annul 1234567) by admin1"],
      "the 9 fee is put back into the Broker channel"
    );
    eq(r.brokerRestores, ["-9 -> broker 7"], "the broker is charged the 9 fee");
  });

  await check("raising a zero fee while the fault is none is refused", async () => {
    const r = await patch(
      { AnnulReason: "none", AnnulFee: 9 },
      {
        row: {
          Annulled: 1,
          AnnulReason: "none",
          AnnulFee: 0,
          Price: 0,
          OriginalPrice: 25,
          StartDate: dayOffset(-1),
          PaymentType: "Cash",
        },
      }
    );
    eq(r.status, 400, "status");
    ok(
      String(r.body && r.body.error).includes("no-fault"),
      "the error explains that no fault means no fee"
    );
    eq(r.row.AnnulFee, 0, "the stored fee is untouched");
    eq(r.movements, [], "no money moves");
  });

  await check("a worker cannot change the fee of an annulled insurance", async () => {
    const r = await patch(
      { AnnulFee: 5 },
      {
        role: 2,
        username: "worker1",
        row: { Annulled: 1, AnnulReason: "worker", AnnulFee: 9 },
      }
    );
    eq(r.status, 403, "PATCH rejected for worker");
    eq(r.movements, [], "no movements");
  });

  await check("a zero fee survives a later save of the annulled policy", async () => {
    // The edit form always sends the fault dropdown (only an UNCHANGED fee is
    // left out of the payload), so every later save of an annulled policy goes
    // through the fee logic again. A fee the admin already set to 0 IS the
    // stored fee and must be kept - not re-decided to 9/1 just because the
    // policy is saved again (e.g. to correct its car number).
    const r = await patch(
      { AnnulReason: "worker", Price: 0, CarNumber: "CB1234AB" },
      {
        row: {
          Annulled: 1,
          AnnulReason: "worker",
          AnnulFee: 0,
          Price: 0,
          OriginalPrice: 25,
          StartDate: dayOffset(-1),
          PaymentType: "Cash",
        },
      }
    );
    eq(r.status, 200, "status");
    eq(r.row.AnnulFee, 0, "the fee stays 0");
    eq(r.row.Price, 0, "the tax in Price stays 0");
    eq(r.row.CarNumber, "CB1234AB", "the other field was still saved");
    eq(r.movements, [], "no money moves");
  });

  await check("re-sending an unchanged zero fee keeps it at zero", async () => {
    const r = await patch(
      { AnnulReason: "worker", AnnulFee: 0 },
      {
        row: {
          Annulled: 1,
          AnnulReason: "worker",
          AnnulFee: 0,
          Price: 0,
          OriginalPrice: 25,
          StartDate: dayOffset(-1),
          PaymentType: "Cash",
        },
      }
    );
    eq(r.status, 200, "status");
    eq(r.row.AnnulFee, 0, "the fee stays 0");
    eq(r.movements, [], "no money moves");
  });

  await check("correcting the start date still re-decides the fee", async () => {
    // Only an unchanged date keeps a stored fee; moving it re-decides the fee
    // from the corrected date, which is the documented server behaviour.
    const r = await patch(
      { AnnulReason: "worker", StartDate: dayOffset(-1) },
      {
        row: {
          Annulled: 1,
          AnnulReason: "worker",
          AnnulFee: 0,
          Price: 0,
          OriginalPrice: 25,
          StartDate: dayOffset(3),
          PaymentType: "Cash",
        },
      }
    );
    eq(r.status, 200, "status");
    eq(r.row.AnnulFee, 9, "the fee follows the corrected start date");
  });

  await check("a negative fee is rejected on PATCH", async () => {
    const r = await patch(
      { AnnulFee: -1 },
      { row: { Annulled: 1, AnnulReason: "worker", AnnulFee: 9 } }
    );
    eq(r.status, 400, "status");
    eq(r.body, { error: "fee must be a non-negative number" }, "error");
    eq(r.movements, [], "no money moves");
  });

  await check("an annulment computes the refund from OriginalPrice, not the tax in Price", async () => {
    // A converted row: Price already holds the previous tax (9), the sale
    // price lives in OriginalPrice (100). Changing the fee to 5 must refund
    // 100 - 5 and keep Price in step with the new tax.
    const r = await annul(
      { payer: "worker", fee: 5 },
      {
        Annulled: 1,
        AnnulReason: "worker",
        AnnulFee: 9,
        Price: 9,
        OriginalPrice: 100,
        StartDate: dayOffset(-1),
      }
    );
    eq(r.status, 200, "status");
    eq(r.body.refund, 95, "refund = original price - new fee");
    eq(r.storedOriginalPrice, 100, "the sale price is preserved");
    eq(r.storedPrice, 5, "the new tax is the price");
    eq(
      r.movements,
      ["cash reduce 4 EUR @ Офис Харманли (Annul 1234567) by admin1"],
      "the 4 difference leaves the drawer"
    );
  });

  await check("an admin can also update fault via POST /insurances/:blancNumber/annul", async () => {
    const r = await annul(
      { payer: "none" },
      {
        Annulled: 1,
        AnnulReason: "broker",
        AnnulFee: 9,
        StartDate: dayOffset(-1),
        BrokerId: 7,
        PaymentType: "Broker",
      }
    );
    eq(r.status, 200, "status");
    eq(r.storedPayer, "none", "stored payer");
    eq(r.storedFee, 0, "stored fee");
    eq(
      r.movements,
      ["total/Broker reduce 9 EUR @ Офис Харманли (Annul 1234567) by admin1"],
      "channel movement"
    );
    eq(r.brokerRestores, ["9 -> broker 7"], "broker gets 9 back");
  });

  // -------------------------------------------------------------------------
  // Admin un-annulling (restoring) an already-annulled insurance.
  // -------------------------------------------------------------------------
  await check("un-annulling a cash policy puts the refund back in the drawer", async () => {
    const r = await patch(
      { Annulled: false },
      {
        row: {
          Annulled: 1,
          AnnulReason: "worker",
          AnnulFee: 9,
          Price: 9,
          OriginalPrice: 100,
          StartDate: dayOffset(-1),
          PaymentType: "Cash",
        },
      }
    );
    eq(r.status, 200, "status");
    eq(r.row.Annulled, 0, "annulled flag cleared");
    eq(r.row.AnnulReason, null, "annul reason cleared");
    eq(r.row.AnnulFee, null, "annul fee cleared");
    eq(r.row.Price, 100, "the sale price is back in Price");
    eq(r.row.OriginalPrice, null, "and the saved original is cleared");
    eq(
      r.movements,
      ["cash increase 91 EUR @ Офис Харманли (Restore 1234567) by admin1"],
      "the 91 refund goes back into the drawer"
    );
  });

  await check("un-annulling a broker policy recharges the broker and the Broker channel", async () => {
    const r = await patch(
      { Annulled: false },
      {
        row: {
          Annulled: 1,
          AnnulReason: "worker",
          AnnulFee: 9,
          Price: 9,
          OriginalPrice: 100,
          StartDate: dayOffset(-1),
          BrokerId: 7,
          PaymentType: "Broker",
        },
      }
    );
    eq(r.status, 200, "status");
    eq(r.row.Annulled, 0, "annulled flag cleared");
    eq(
      r.movements,
      ["total/Broker increase 91 EUR @ Офис Харманли (Restore 1234567) by admin1"],
      "the refund returns to the Broker channel"
    );
    eq(r.brokerDeltas, ["100 -> broker 7"], "the broker is recharged the full price");
    eq(
      r.brokerSettles,
      ["100 -> broker 7 (1234567)"],
      "the recharge morphs the existing refund row instead of adding a policy row"
    );
    // No broker-ledger charge movement is appended: the refund row is the one
    // record that changes (Amount 0), so there is nothing else to write.
    eq(
      brokerDeltas.length,
      1,
      "one balance change, not a refund plus a re-charge"
    );
  });

  await check("un-annulling a broker-at-fault policy recharges only the partial refund", async () => {
    const r = await patch(
      { Annulled: false },
      {
        row: {
          Annulled: 1,
          AnnulReason: "broker",
          AnnulFee: 9,
          StartDate: dayOffset(-1),
          BrokerId: 7,
          PaymentType: "Broker",
        },
      }
    );
    eq(r.status, 200, "status");
    eq(
      r.brokerDeltas,
      ["91 -> broker 7"],
      "the broker is recharged the partial refund it received"
    );
    eq(
      r.brokerSettles,
      ["91 -> broker 7 (1234567)"],
      "the partial refund row is morphed to 0"
    );
  });

  await check("un-annulling a card policy re-adds the card and total/Card balances", async () => {
    const r = await patch(
      { Annulled: false },
      {
        row: {
          Annulled: 1,
          AnnulReason: "worker",
          AnnulFee: 9,
          StartDate: dayOffset(-1),
          PaymentType: "Card",
        },
      }
    );
    eq(r.status, 200, "status");
    eq(
      r.movements,
      [
        "card increase 91 (Restore 1234567) by admin1",
        "total/Card increase 91 EUR @ Офис Харманли (Restore 1234567) by admin1",
      ],
      "card and total/Card movements"
    );
  });

  await check("a worker cannot un-annul an insurance", async () => {
    const r = await patch(
      { Annulled: false },
      {
        role: 2,
        username: "worker1",
        row: { Annulled: 1, AnnulReason: "worker", AnnulFee: 9 },
      }
    );
    eq(r.status, 403, "status");
    eq(r.body, { error: "Only admins can restore an annulled insurance" }, "error");
    eq(r.movements, [], "no money moves");
  });

  await check("un-annulling a policy that is not annulled is rejected", async () => {
    const r = await patch({ Annulled: false }, { row: { Annulled: 0 } });
    eq(r.status, 400, "status");
    eq(r.body, { error: "Insurance is not annulled" }, "error");
    eq(r.movements, [], "no money moves");
  });

  // ---------------------------------------------------------------------------
  // Admin-only author / broker corrections
  // ---------------------------------------------------------------------------
  // The author is a plain column; the broker decides who pays for the policy,
  // so moving a policy between brokers has to refund the old broker and charge
  // the new one (and switch the payment channel of a walk-in).

  await check("an admin can change the author of a policy", async () => {
    const r = await patch({ Author: "worker2" });
    eq(r.status, 200, "status");
    eq(r.row.Author, "worker2", "stored author");
    eq(r.movements, [], "no money moves");
    eq(r.brokerDeltas, [], "no broker is touched");
  });

  await check("an unchanged author is never re-validated", async () => {
    // The account behind an old policy may be gone; re-saving the policy must
    // still work because nothing is being changed.
    const previous = knownUsers;
    knownUsers = ["admin1", "worker2"];
    try {
      const r = await patch({ Author: "worker1", PolicyNumber: "P-002" });
      eq(r.status, 200, "status");
      eq(r.row.PolicyNumber, "P-002", "the other field was saved");
      eq(r.row.Author, "worker1", "the author is untouched");
    } finally {
      knownUsers = previous;
    }
  });

  await check("an unknown author is rejected", async () => {
    const r = await patch({ Author: "nobody" });
    eq(r.status, 404, "status");
    eq(r.body, { error: "Author not found" }, "error");
    eq(r.movements, [], "no money moves");
  });

  await check("a worker cannot change the author or the broker", async () => {
    const author = await patch({ Author: "worker2" }, { role: 2 });
    eq(author.status, 403, "author status");
    eq(
      author.body,
      { error: "Only admins can change the author of an insurance" },
      "author error"
    );
    const broker = await patch({ BrokerId: 5 }, { role: 2 });
    eq(broker.status, 403, "broker status");
    eq(
      broker.body,
      { error: "Only admins can change the broker of an insurance" },
      "broker error"
    );
    eq(broker.movements, [], "no money moves");
  });

  await check("assigning a broker turns the walk-in into a broker policy", async () => {
    const r = await patch(
      { BrokerId: 5, PaymentType: "Cash" },
      { row: { BrokerId: null, Broker: "Офис Харманли", PaymentType: "Cash" } }
    );
    eq(r.status, 200, "status");
    eq(r.row.BrokerId, 5, "stored broker id");
    eq(r.row.Broker, "Тест Брокер", "stored broker name");
    eq(r.row.PaymentType, "Broker", "the broker is the payer now");
    eq(
      r.movements,
      [
        "cash reduce 100 EUR @ Офис Харманли (Edit 1234567) by admin1",
        "total/Broker increase 100 EUR @ Офис Харманли (1234567) by admin1",
      ],
      "the cash drawer is refunded and the Broker channel takes over"
    );
    eq(r.brokerDeltas, ["100 -> broker 5"], "the new broker is charged");
  });

  await check("moving a broker policy keeps the Broker channel and moves the balances", async () => {
    const r = await patch(
      { BrokerId: 5 },
      { row: { BrokerId: 7, Broker: "Euroins", PaymentType: "Broker" } }
    );
    eq(r.status, 200, "status");
    eq(r.row.BrokerId, 5, "stored broker id");
    eq(r.row.Broker, "Тест Брокер", "stored broker name");
    eq(r.row.PaymentType, "Broker", "payment type unchanged");
    eq(r.movements, [], "the channel and the amount did not change");
    eq(
      r.brokerDeltas,
      ["-100 -> broker 7", "100 -> broker 5"],
      "the old broker is refunded, the new one charged"
    );
  });

  await check("clearing the broker turns the policy back into a walk-in", async () => {
    const r = await patch(
      { BrokerId: "" },
      { row: { BrokerId: 7, Broker: "Euroins", PaymentType: "Broker" } }
    );
    eq(r.status, 200, "status");
    eq(r.row.BrokerId, null, "no broker id");
    eq(r.row.Broker, "Офис Харманли", "the branch is the walk-in's broker");
    eq(r.row.PaymentType, "Cash", "back in the cash drawer");
    eq(
      r.movements,
      [
        "total/Broker reduce 100 EUR @ Офис Харманли (Edit 1234567) by admin1",
        "cash increase 100 EUR @ Офис Харманли (1234567) by admin1",
      ],
      "the Broker channel gives the money back to the drawer"
    );
    eq(r.brokerDeltas, ["-100 -> broker 7"], "the old broker is refunded");
  });

  await check("an unchanged broker never moves money", async () => {
    const r = await patch(
      { BrokerId: "7", PolicyNumber: "P-002" },
      { row: { BrokerId: 7, Broker: "Euroins", PaymentType: "Broker" } }
    );
    eq(r.status, 200, "status");
    eq(r.row.PolicyNumber, "P-002", "the other field was saved");
    eq(r.movements, [], "no channel movement");
    eq(r.brokerDeltas, [], "no broker movement");
  });

  await check("an unknown broker is rejected", async () => {
    const r = await patch({ BrokerId: 999 });
    eq(r.status, 404, "status");
    eq(r.body, { error: "Broker not found" }, "error");
    eq(r.movements, [], "no money moves");
  });

  await check("the broker of an annulled policy cannot be changed", async () => {
    const r = await patch(
      { BrokerId: 5 },
      {
        row: {
          BrokerId: 7,
          Broker: "Euroins",
          PaymentType: "Broker",
          Annulled: 1,
          AnnulReason: "worker",
          AnnulFee: 9,
          Price: "9.00",
          OriginalPrice: "100.00",
        },
      }
    );
    eq(r.status, 400, "status");
    eq(
      r.body,
      { error: "Cannot change the broker of an annulled insurance" },
      "error"
    );
    eq(r.movements, [], "no money moves");
  });

  await check("a non-Turk walk-in cannot become a broker policy while the tax is on", async () => {
    const rejected = await patch(
      { BrokerId: 5, NonTurk: true },
      { row: { BrokerId: null, NonTurk: 1 } }
    );
    eq(rejected.status, 400, "status");
    eq(
      rejected.body,
      { error: "The non-Turk tax only applies to walk-in policies" },
      "error"
    );
    eq(rejected.brokerDeltas, [], "no broker is charged");

    // Unticking it in the same save is the documented way to move the policy.
    const accepted = await patch(
      { BrokerId: 5, NonTurk: false },
      { row: { BrokerId: null, NonTurk: 1 } }
    );
    eq(accepted.status, 200, "status");
    eq(accepted.row.NonTurk, 0, "the tax flag is cleared");
    eq(accepted.row.PaymentType, "Broker", "the broker pays");
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
