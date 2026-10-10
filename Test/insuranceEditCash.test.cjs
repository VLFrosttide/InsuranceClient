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
// Price-delta adjustments the endpoint asks Brokers.js to make. A broker-funded
// policy's balance is the only record of its payment, so a corrected price has
// to move it too; asserting it separately keeps that visible.
const brokerDeltas = [];
let txCount = 0;
let txDepth = 0;
// When true the cash "reduce" stub fails the way the real one does when the
// drawer cannot fund the reversal of an old price.
let failReduce = false;

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
    decreaseBrokerForInsurance: async (conn, brokerId, price) => {
      brokerDeltas.push({ brokerId, delta: Number(price) });
      return Number(price);
    },
    restoreBrokerForAnnulment: async () => {},
    adjustBrokerForPriceChange: async (conn, brokerId, delta) => {
      brokerDeltas.push({ brokerId, delta });
      return delta;
    },
  },
  "../Mail/SendReply.js": { sendReply: async () => {} },
};

// The row the "SELECT * FROM insurance WHERE BlancNumber = ?" lookups return.
// The UPDATE applies its SET clause onto it, so the final SELECT (and therefore
// the JSON response) reflects what the endpoint wrote.
let row = null;
// Blank numbers already used by OTHER policies, so changing a policy's blank
// number to one of them is reported as a clash.
let takenBlancs = [];

const fakeDb = {
  query: async (sql, params) => {
    const flat = String(sql).replace(/\s+/g, " ").trim();
    queries.push({ sql: flat, params: params || [], inTx: txDepth > 0 });

    if (flat.startsWith("SELECT BlancNumber FROM insurance")) {
      const wanted = String((params || [])[0]);
      return [takenBlancs.includes(wanted) ? [{ BlancNumber: wanted }] : []];
    }

    if (flat.startsWith("SELECT * FROM insurance")) {
      return [row ? [{ ...row }] : []];
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
    : m.where === "total"
    ? `total/${m.source} ${m.type} ${m.amount} ${m.currency} @ ${m.branch} (${m.reason}) by ${m.username}`
    : `card ${m.type} ${m.amount} (${m.reason}) by ${m.username}`;

const BASE_ROW = {
  BlancNumber: "1234567",
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
  queries.length = 0;
  txCount = 0;
  failReduce = !!opts.failReduce;
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
  return {
    status: res.statusCode,
    body: res.body,
    movements: movements.map(describe),
    brokerDeltas: brokerDeltas.map((d) => `${d.delta} -> broker ${d.brokerId}`),
    updated: queries.filter((q) => q.sql.startsWith("UPDATE insurance SET")),
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

  await check("a new branch moves the money between the branch drawers", async () => {
    const r = await patch({ Branch: "ГКПП Лесово" });
    eq(
      r.movements,
      [
        "cash reduce 100 EUR @ Офис Харманли (Edit 1234567) by admin1",
        "cash increase 100 EUR @ ГКПП Лесово (1234567) by admin1",
      ],
      "movements"
    );
  });

  await check("a new currency moves the money between the currency balances", async () => {
    const r = await patch({ CurrencyType: "USD" });
    eq(
      r.movements,
      [
        "cash reduce 100 EUR @ Офис Харманли (Edit 1234567) by admin1",
        "cash increase 100 USD @ Офис Харманли (1234567) by admin1",
      ],
      "movements"
    );
  });

  await check("an annulled policy no longer contributes, so nothing moves", async () => {
    const r = await patch({ Price: 200 }, { row: { Annulled: 1 } });
    eq(r.status, 200, "status");
    eq(r.movements, [], "no movements expected");
    eq(r.row.Price, "200", "the correction itself is still stored");
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

  await check("a worker still cannot edit somebody else's policy", async () => {
    const r = await patch({ Price: 120 }, { role: 2, username: "someoneElse" });
    eq(r.status, 403, "status");
    eq(r.movements, [], "no movements expected");
    eq(r.updated.length, 0, "nothing written");
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
      [
        "total/Broker reduce 100 EUR @ Офис Харманли (Edit 1234567) by admin1",
        "total/Broker increase 100 EUR @ ГКПП Лесово (1234567) by admin1",
      ],
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

  await check("ticking the card fee on a card policy moves the card balance", async () => {
    const r = await patch(
      { PaymentType: "Card", CardFee: true, Price: 102 },
      { row: { PaymentType: "Card" } }
    );
    eq(r.row.CardFee, 1, "stored flag");
    eq(
      r.movements,
      [
        "card reduce 100 (Edit 1234567) by admin1",
        "total/Card reduce 100 EUR @ Офис Харманли (Edit 1234567) by admin1",
        "card increase 102 (1234567) by admin1",
        "total/Card increase 102 EUR @ Офис Харманли (1234567) by admin1",
      ],
      "movements"
    );
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
      //   CurrencyType, Duration, Broker, Branch, Otomobil, PaymentType,
      //   StartDate, BrokerId, NonTurk, CardFee
      // so PaymentType is index 11 and CardFee index 15.
      storedPayment: inserts.length ? inserts[0].params[11] : undefined,
      storedCardFee: inserts.length ? inserts[0].params[15] : undefined,
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
    eq(r.inserts[0].params[14], 0, "stored NonTurk");
  });

  await check("a walk-in keeps the non-Turk tax", async () => {
    const r = await create({ PaymentType: "Cash", EmailFrom: "", NonTurk: true });
    eq(r.status, 201, "status");
    eq(r.inserts[0].params[14], 1, "stored NonTurk");
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
    eq(r.storedCardFee, 1, "the card fee is kept for card walk-ins");
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
  // With the CreationDate column in the INSERT, Broker is the 9th bound value
  // (index 8) and BrokerId the 14th (index 13).
  // -------------------------------------------------------------------------
  await check("a walk-in records its branch as the broker", async () => {
    const r = await create({ PaymentType: "Cash", EmailFrom: "" });
    eq(r.status, 201, "status");
    eq(r.inserts[0].params[8], "Офис Харманли", "stored broker");
    eq(r.inserts[0].params[13], null, "BrokerId stays empty");
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
    eq(r.inserts[0].params[13], 7, "BrokerId");
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
  });

  await check("re-sending the same blank number is not an update of the key", async () => {
    takenBlancs = ["1234567"];
    const r = await patch({ BlancNumber: "1234567", PolicyNumber: "P-9" });
    takenBlancs = [];
    eq(r.status, 200, "status");
    const setClause = r.updated[0].sql.split(" WHERE ")[0];
    ok(!setClause.includes("BlancNumber"), "BlancNumber is not in the SET clause");
    eq(r.row.PolicyNumber, "P-9", "the other field was still saved");
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

  async function annul(body, rowOverrides = {}) {
    movements.length = 0;
    brokerDeltas.length = 0;
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
        user: { role: 1, username: "admin1" },
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
      // AnnulReason (who pays) and AnnulFee as written to the row.
      storedPayer: update ? update.params[0] : undefined,
      storedFee: update ? update.params[1] : undefined,
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

  await check("a policy already in effect costs 9 to annul", async () => {
    const r = await annul({ payer: "broker" }, { StartDate: dayOffset(-3) });
    eq(r.status, 200, "status");
    eq(r.body.fee, 9, "fee");
    eq(r.body.inEffect, true, "in effect");
    eq(r.body.refund, 91, "refund = price - fee");
    eq(r.storedPayer, "broker", "stored payer");
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

  await check("a client cannot dictate the fee", async () => {
    const r = await annul(
      { payer: "worker", fee: 0, AnnulFee: 0 },
      { StartDate: dayOffset(-1) }
    );
    eq(r.body.fee, 9, "fee comes from the start date only");
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

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
