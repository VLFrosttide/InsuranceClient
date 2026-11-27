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
//     broker balance,
//   - the kind of insurance (border / medical / civil) is optional and defaults
//     to border; an admin may create the admin-only medical and civil kinds and
//     an unknown kind is rejected without writing anything,
//   - a medical / civil policy may be created with blanks for the blanc, car and
//     policy numbers (a MED-… / CIV-… reference is made up for each blank
//     number), while border insurance still refuses a blank one.
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
const autoBatches = [];
let blancInBrokerBatchesResult = true;
// Set to a broker when the blanc is already inside ANOTHER broker's batches.
let otherBrokerWithBlanc = null;

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
    blancInBrokerBatches: async () => blancInBrokerBatchesResult,
    findOtherBrokerWithBlanc: async () => otherBrokerWithBlanc,
    // Called from the create transaction when the request carries the force
    // flag; the real helper only writes when the blanc is really outside.
    addAutoBlancBatch: async (conn, brokerId, blancNumber, author) => {
      autoBatches.push({ brokerId, blancNumber, author });
      return true;
    },
    decreaseBrokerForInsurance: async (conn, brokerId, price, meta) => {
      brokerCharges.push({ brokerId, price, meta });
    },
    // The balance is rebuilt from the insurances after each change; these tests
    // stub the broker layer, so the rebuild is a no-op here.
    refreshBrokerBalance: async () => null,
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
  "../db/branches.js": { isBranchEnabled: async () => true },
  "../Mail/SendReply.js": { sendReply: async () => {} },
  "../Mail/mailStore.js": { markAnswered: () => null },
  "../Mail/threadHistory.js": { fetchThreadConversation: async () => null },
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
//   CurrencyType, Duration, Broker, Branch, Otomobil, Kind, PaymentType,
//   StartDate, BrokerId, NonTurk, CardFee
async function create(body, opts) {
  queries.length = 0;
  brokerCharges.length = 0;
  movements.length = 0;
  autoBatches.length = 0;
  otherBrokerWithBlanc = (opts && opts.otherBrokerWithBlanc) || null;
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
    eq(p[12], "Broker", "payment type");
    eq(p[14], 5, "broker id");
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
    eq(p[12], "Cash", "payment type");
    eq(p[14], null, "no broker id");
    eq(brokerCharges.length, 0, "no broker charge");
    eq(movements.map((m) => m.channel), ["Cash"], "cash channel");
  });

  await check("a policy created without a kind is a border insurance", async () => {
    const r = await create({});
    eq(r.status, 201, "status");
    const p = r.insert.params;
    eq(p[11], "border", "stored kind");
    eq(r.body && r.body.kind, "border", "the answer names the kind");
  });

  await check("an admin can create medical and civil liability policies", async () => {
    // The kind arrives as the stored value or as either label, and is stored as
    // the value (Requests/InsuranceKinds.js).
    const medical = await create({ Kind: "medical" });
    eq(medical.status, 201, "medical status");
    eq(medical.insert.params[11], "medical", "stored medical kind");

    const civil = await create({ Kind: "Civil liability" });
    eq(civil.status, 201, "civil status");
    eq(civil.insert.params[11], "civil", "the English label is normalised");

    const bgLabel = await create({ InsuranceKind: "Медицинска застраховка" });
    eq(bgLabel.status, 201, "Bulgarian label status");
    eq(bgLabel.insert.params[11], "medical", "the Bulgarian label is normalised");
  });

  await check("medical and civil policies need no numbers - a reference is made", async () => {
    // The admin form leaves the blanc / car / policy numbers empty for these
    // hand-priced products. The blanc number is the primary key (and the edit /
    // annul / delete URL), so the server makes one up, prefixed with the kind.
    const medical = await create({
      Kind: "medical",
      BlancNumber: "",
      PolicyNumber: "",
      CarNumber: "",
      Price: "120.00",
    });
    eq(medical.status, 201, "medical status");
    const p = medical.insert.params;
    ok(/^MED-\d{14}-[A-Z0-9]{4}$/.test(p[3]), "blanc reference: " + p[3]);
    ok(/^MED-\d{14}-[A-Z0-9]{4}$/.test(p[2]), "policy reference: " + p[2]);
    ok(p[2] !== p[3], "the two references differ");
    eq(p[4], "", "no car number");
    eq(p[5], "120.00", "the typed price is kept");
    eq(medical.body.blancNumber, p[3], "the answer names the stored key");

    const civil = await create({
      Kind: "civil",
      BlancNumber: "   ",
      PolicyNumber: "",
      CarNumber: "",
      Price: "80.00",
    });
    eq(civil.status, 201, "civil status");
    ok(/^CIV-\d{14}-[A-Z0-9]{4}$/.test(civil.insert.params[3]), "civil reference");
  });

  await check("border insurance still requires its three numbers", async () => {
    for (const field of ["BlancNumber", "PolicyNumber", "CarNumber"]) {
      const r = await create({ [field]: "  " });
      eq(r.status, 400, field + " status");
      ok(
        String(r.body && r.body.error).startsWith(field + " is required"),
        field + " message: " + (r.body && r.body.error)
      );
      eq(r.insert, undefined, field + ": nothing is inserted");
    }
  });

  await check("an unknown kind is rejected and nothing is written", async () => {
    const r = await create({ Kind: "life" });
    eq(r.status, 400, "status");
    ok(
      String(r.body && r.body.error).startsWith("Kind must be one of"),
      "error message: " + (r.body && r.body.error)
    );
    eq(r.insert, undefined, "nothing is inserted");
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

  await check("a broker policy with a blanc outside the broker's batches is rejected unless forced", async () => {
    blancInBrokerBatchesResult = false;

    const rejected = await create({ BrokerId: 5 });
    eq(rejected.status, 422, "rejected status");
    eq(
      rejected.body && rejected.body.code,
      "BLANC_OUTSIDE_BROKER_BATCHES",
      "error code"
    );
    eq(
      rejected.body && rejected.body.error,
      "This blanc number is not in any of the broker's blanc batches",
      "error message"
    );
    eq(autoBatches.length, 0, "a rejected create adds no blanc to the batches");

    const forced = await create({
      BrokerId: 5,
      ForceOutsideBlancBatch: true,
    });
    eq(forced.status, 201, "forced status");
    ok(forced.insert, "forced insert issued");
    eq(
      autoBatches,
      [{ brokerId: 5, blancNumber: "123456", author: "admin1" }],
      "the forced blanc joins the broker's batches"
    );

    blancInBrokerBatchesResult = true;
  });

  await check("a blanc that belongs to another broker is refused, even when forced", async () => {
    blancInBrokerBatchesResult = false;
    const refused = await create(
      { BrokerId: 5, ForceOutsideBlancBatch: true },
      { otherBrokerWithBlanc: { id: 9, name: "Друг Брокер" } }
    );

    eq(refused.status, 422, "status");
    eq(
      refused.body && refused.body.code,
      "BLANC_BELONGS_TO_ANOTHER_BROKER",
      "error code"
    );
    ok(
      String(refused.body && refused.body.error).includes("Друг Брокер"),
      "the error names the broker: " + (refused.body && refused.body.error)
    );
    eq(refused.body.brokerId, 9, "the other broker's id");
    eq(refused.body.brokerName, "Друг Брокер", "the other broker's name");
    eq(refused.insert, undefined, "nothing is saved");
    eq(autoBatches.length, 0, "no batch is added");

    blancInBrokerBatchesResult = true;
  });

  if (failed) {
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(1);
  }
  console.log(`\n${passed} passed, 0 failed`);
})();

