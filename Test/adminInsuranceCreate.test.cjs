"use strict";

// Node test: POST /admin/insurances creates back-dated policies and, when a
// broker is assigned, charges that broker's balance on the provided date.
//
// The admin form is a walk-in-like form that also lets the admin pick a broker
// and a creation date. This test loads the REAL server file
// (InsuranceServer/Requests/TierEndpoints.js, see Test/serverPath.cjs) in a vm
// with its requires stubbed, then drives the admin create handler directly and
// asserts:
//   - the insurance row is inserted with the provided CreationDate,
//   - a broker assignment stores BrokerId + Broker name + PaymentType "Broker"
//     and calls decreaseBrokerForInsurance with that broker and createdAt,
//   - a walk-in (no broker) stores the branch as the broker and never charges a
//     broker balance.
//
// Run with:  node Test/adminInsuranceCreate.test.cjs   (or: npm test)

const fs = require("fs");
const vm = require("vm");
const { serverFile } = require("./serverPath.cjs");

const TIER_JS = serverFile("Requests", "TierEndpoints.js");

// --- fakes -------------------------------------------------------------------
const routes = [];
const queries = [];
const brokerCharges = [];
const movements = [];

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
    toDecimal: (v) => {
      if (v === undefined || v === null || v === "") return null;
      const n =
        typeof v === "number" ? v : parseFloat(String(v).replace(",", "."));
      return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
    },
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
      movements.push({ channel: "Cash", type, createdAt });
    },
    recordChannelMovement: async (
      conn,
      branch,
      username,
      type,
      amount,
      reason,
      currency,
      source,
      createdAt
    ) => {
      movements.push({ channel: source, type, createdAt });
    },
    movePolicyBranch: async () => {},
  },
  "./CardPayments.js": {
    recordCardPayment: async () => {},
    reduceCardBalance: async () => {},
  },
  "./Brokers.js": {
    resolveBrokerByEmail: async () => null,
    decreaseBrokerForInsurance: async (conn, brokerId, price, meta) => {
      brokerCharges.push({ brokerId, price, meta });
    },
    restoreBrokerForAnnulment: async () => {},
    restoreBrokerForDeletion: async () => {},
    adjustBrokerForPriceChange: async () => {},
    getBrokerAllowNegativeBalance: async () => true,
    salePricingFor: async () => ({ pricing: {} }),
    loadOwnBrokerTariffs: async () => ({}),
    attachSubBrokerStatus: async () => {},
    computePolicyTariffPrice: () => null,
  },
  "./PaymentSchedule.js": { getSchedule: async () => null },
  "../Mail/SendReply.js": { sendReply: async () => {} },
};

const BROKER = { id: 5, Name: "Тест Брокер", ParentBrokerId: null };

const fakeDb = {
  query: async (sql, params) => {
    const s = String(sql);
    queries.push({ sql: s, params: params || [] });
    if (/^SELECT id, Name, ParentBrokerId FROM brokers WHERE id = \?/.test(s)) {
      const id = Number((params || [])[0]);
      return id === BROKER.id ? [[BROKER]] : [[]];
    }
    return [[]];
  },
  withTransaction: async (fn) => fn(fakeDb),
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

const { createTierRouter } = mod.exports;
if (typeof createTierRouter !== "function") {
  console.error("createTierRouter is not exported - server file changed?");
  process.exit(1);
}
createTierRouter(fakeDb);

const adminRoute = routes.find(
  (r) => r.method === "post" && r.path === "/admin/insurances"
);
if (!adminRoute) {
  console.error("POST /admin/insurances route was not registered");
  process.exit(1);
}
const adminHandler = adminRoute.handlers[adminRoute.handlers.length - 1];

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

// Column order of the INSERT:
//   Author, CreationDate, PolicyNumber, BlancNumber, CarNumber, Price,
//   CurrencyType, Duration, Broker, Branch, Otomobil, PaymentType,
//   StartDate, BrokerId, NonTurk, CardFee
async function create(body) {
  queries.length = 0;
  brokerCharges.length = 0;
  movements.length = 0;
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
  await adminHandler(
    {
      params: {},
      query: {},
      body: Object.assign(
        {
          BlancNumber: "123456",
          PolicyNumber: "12345678",
          CarNumber: "CA1234AB",
          Price: "45.00",
          CurrencyType: "EUR",
          Duration: 30,
          Branch: "Офис Харманли",
          Otomobil: "Automobile",
          PaymentType: "Cash",
        },
        body
      ),
      user: { role: 1, username: "admin1" },
    },
    res
  );
  const insert = queries.find((q) => q.sql.startsWith("INSERT INTO insurance"));
  return { status: res.statusCode, insert, body: res.body };
}

(async () => {
  console.log("POST /admin/insurances — admin back-fill create");

  await check("a broker-assigned policy stores broker + creation date and charges the broker", async () => {
    const r = await create({ BrokerId: 5, CreationDate: "2026-10-01 09:30:00" });
    eq(r.status, 201, "status");
    ok(r.insert, "insert issued");
    const p = r.insert.params;
    eq(p[1], "2026-10-01 09:30:00", "creation date");
    eq(p[8], BROKER.Name, "broker name");
    eq(p[11], "Broker", "payment type");
    eq(p[13], 5, "broker id");
    eq(brokerCharges.length, 1, "broker charged once");
    eq(brokerCharges[0].brokerId, 5, "charged broker");
    eq(brokerCharges[0].meta.createdAt, "2026-10-01 09:30:00", "movement date");
    eq(
      movements.map((m) => m.channel),
      ["Broker"],
      "money moves through the Broker channel"
    );
    eq(movements[0].createdAt, "2026-10-01 09:30:00", "channel movement date");
  });

  await check("a walk-in (no broker) stores the branch and never charges a broker", async () => {
    const r = await create({
      CreationDate: "2026-10-02 11:00:00",
      PaymentType: "Cash",
    });
    eq(r.status, 201, "status");
    const p = r.insert.params;
    eq(p[8], "Офис Харманли", "broker column is the branch");
    eq(p[11], "Cash", "payment type");
    eq(p[13], null, "no broker id");
    eq(brokerCharges.length, 0, "no broker charge");
    eq(movements.map((m) => m.channel), ["Cash"], "cash channel");
  });

  await check("an invalid broker id is rejected", async () => {
    const r = await create({ BrokerId: "abc" });
    eq(r.status, 400, "status");
  });

  await check("an unknown broker is rejected", async () => {
    const r = await create({ BrokerId: 999 });
    eq(r.status, 404, "status");
  });

  await check("a non-Turk fee on a broker policy is rejected", async () => {
    const r = await create({ BrokerId: 5, NonTurk: true });
    eq(r.status, 400, "status");
  });

  if (failed) {
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(1);
  }
  console.log(`\n${passed} passed, 0 failed`);
})();

