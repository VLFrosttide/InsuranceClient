"use strict";

// Node test: insurance creation dates are stamped in the worker's LOCAL time.
//
// The database server runs in UTC on the hosting, so the old `NOW()` stamped
// policies with UTC time - wrong by the local offset, and on the wrong day for
// policies created around midnight. The client now sends its UTC offset
// (TzOffset, minutes east of UTC) and the server builds the local wall-clock
// time from its own clock plus that offset.
//
// Like insuranceSearchFilter.test.cjs, this loads the REAL server file
// (Test/srv/Requests_TierEndpoints.js - the mirror of the deployed
// InsuranceServer/Requests/TierEndpoints.js) in a vm with its requires stubbed,
// then checks the clientLocalDateTime helper and the value bound by the
// POST /worker/insurances INSERT.
//
// Run with:  node Test/insuranceCreationDate.test.cjs   (or: npm test)

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const TIER_JS = path.join(ROOT, "Test", "srv", "Requests_TierEndpoints.js");

// --- fakes -------------------------------------------------------------------
const routes = [];
const queries = [];

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
    recordCashMovement: async () => {},
    recordChannelMovement: async () => {},
    toDecimal: (v) => (Number.isFinite(Number(v)) ? Number(v) : null),
  },
  "./CardPayments.js": {
    recordCardPayment: async () => {},
    reduceCardBalance: async () => {},
  },
  "./Brokers.js": {
    resolveBrokerByEmail: async () => null,
    decreaseBrokerForInsurance: async () => {},
    restoreBrokerForAnnulment: async () => {},
    adjustBrokerForPriceChange: async () => {},
  },
  "../Mail/SendReply.js": { sendReply: async () => {} },
};

const fakeDb = {
  query: async (sql, params) => {
    queries.push({ sql: String(sql), params: params || [] });
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
  filename: "Requests_TierEndpoints.js",
});

const { clientLocalDateTime, createTierRouter } = mod.exports;
if (typeof clientLocalDateTime !== "function") {
  console.error("clientLocalDateTime is not exported - server file changed?");
  process.exit(1);
}
createTierRouter(fakeDb);

const createRoute = routes.find(
  (r) => r.method === "post" && r.path === "/worker/insurances"
);
if (!createRoute) {
  console.error("POST /worker/insurances route was not registered");
  process.exit(1);
}
const createHandler = createRoute.handlers[createRoute.handlers.length - 1];

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

const DATETIME_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

// Creates a walk-in policy and returns the INSERT that was issued.
async function create(body) {
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
          PaymentType: "Cash",
          DisableReturnEmail: true,
        },
        body
      ),
      user: { role: 2, username: "worker1" },
    },
    res
  );
  const insert = queries.find((q) => q.sql.startsWith("INSERT INTO insurance"));
  return { status: res.statusCode, insert };
}

(async () => {
  console.log("Insurance creation date (local time) — tests");

  // 2026-10-07 21:30:15 UTC
  const INSTANT = new Date(Date.UTC(2026, 9, 7, 21, 30, 15));

  await check("UTC+3 (Bulgarian summer time) shifts the wall clock", () => {
    eq(clientLocalDateTime(180, INSTANT), "2026-10-08 00:30:15");
  });

  await check("UTC+2 (Bulgarian winter time)", () => {
    eq(clientLocalDateTime(120, INSTANT), "2026-10-07 23:30:15");
  });

  await check("negative offsets move the day back", () => {
    const early = new Date(Date.UTC(2026, 9, 8, 1, 5, 0));
    eq(clientLocalDateTime(-300, early), "2026-10-07 20:05:00");
  });

  await check("half-hour offsets are supported", () => {
    eq(clientLocalDateTime(330, INSTANT), "2026-10-08 03:00:15");
  });

  await check("month and year boundaries roll over", () => {
    const nye = new Date(Date.UTC(2026, 11, 31, 22, 0, 0));
    eq(clientLocalDateTime(180, nye), "2027-01-01 01:00:00");
  });

  await check("offset may arrive as a string (JSON/form value)", () => {
    eq(clientLocalDateTime("180", INSTANT), "2026-10-08 00:30:15");
  });

  await check("missing / invalid / out-of-range offsets fall back to UTC", () => {
    const utc = "2026-10-07 21:30:15";
    eq(clientLocalDateTime(undefined, INSTANT), utc, "undefined");
    eq(clientLocalDateTime(null, INSTANT), utc, "null");
    eq(clientLocalDateTime("abc", INSTANT), utc, "text");
    eq(clientLocalDateTime(NaN, INSTANT), utc, "NaN");
    eq(clientLocalDateTime(15 * 60, INSTANT), utc, "beyond UTC+14");
    eq(clientLocalDateTime(-13 * 60, INSTANT), utc, "beyond UTC-12");
  });

  await check("the INSERT no longer uses the database server's NOW()", async () => {
    const r = await create({ TzOffset: 180 });
    eq(r.status, 201, "status");
    ok(r.insert, "no INSERT issued");
    ok(!/NOW\(\)/i.test(r.insert.sql), "INSERT still uses NOW(): " + r.insert.sql);
    ok(/CreationDate\)/.test(r.insert.sql), "CreationDate column is last");
  });

  await check("CreationDate is bound as the client's local time", async () => {
    const offset = 180;
    const before = clientLocalDateTime(offset);
    const r = await create({ TzOffset: offset });
    const after = clientLocalDateTime(offset);
    const stored = r.insert.params[15];
    ok(DATETIME_RE.test(stored), "not a MySQL DATETIME: " + stored);
    // String compare works for this fixed-width format.
    ok(
      stored >= before && stored <= after,
      `stored ${stored} not within [${before}, ${after}]`
    );
  });

  await check("the other bound values keep their positions", async () => {
    const r = await create({ TzOffset: 180 });
    eq(r.insert.params.length, 16, "param count");
    eq(r.insert.params[0], "worker1", "Author");
    eq(r.insert.params[2], "7654321", "BlancNumber");
    eq(r.insert.params[10], "Cash", "PaymentType");
    eq(r.insert.params[14], 0, "CardFee");
  });

  await check("an older client without TzOffset still saves (as UTC)", async () => {
    const before = clientLocalDateTime(0);
    const r = await create({});
    const after = clientLocalDateTime(0);
    eq(r.status, 201, "status");
    const stored = r.insert.params[15];
    ok(stored >= before && stored <= after, `stored ${stored} not UTC`);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
