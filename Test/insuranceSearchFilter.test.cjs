"use strict";

// Node test for the GET /insurances search filters, focused on the new
// `broker` parameter added for the "My insurances" lookup tab.
//
// The route handler lives in InsuranceServer/Requests/TierEndpoints.js (see
// Test/serverPath.cjs). It is a CommonJS module that only needs `express`
// and a handful of sibling modules at load time, so this test loads the REAL
// file in a vm with those requires stubbed, registers the routes on a fake
// router, and then calls the /insurances handler directly with a fake req/res
// and a fake DB connection. The SQL and its bound parameters are captured, so
// the test asserts what the endpoint actually asks MySQL to do - including that
// `broker` becomes a parameterised `Broker LIKE ?` (never string-concatenated)
// and that it counts as a valid search criterion on its own.
//
// Run with:  node Test/insuranceSearchFilter.test.cjs   (or: npm test)

const fs = require("fs");
const vm = require("vm");
const { serverFile } = require("./serverPath.cjs");

const TIER_JS = serverFile("Requests", "TierEndpoints.js");

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
  filename: "Requests/TierEndpoints.js",
});

if (typeof mod.exports.createTierRouter !== "function") {
  console.error("createTierRouter is not exported - server file changed?");
  process.exit(1);
}
mod.exports.createTierRouter(fakeDb);

const route = routes.find(
  (r) => r.method === "get" && r.path === "/insurances"
);
if (!route) {
  console.error("GET /insurances route was not registered");
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
const flat = (sql) => sql.replace(/\s+/g, " ").trim();

// Calls GET /insurances as a logged-in worker and returns the response together
// with the SQL (and bound parameters) the handler asked the database to run.
async function search(query, user = { role: 2, username: "worker1" }) {
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
  const before = queries.length;
  await handler(
    { query, params: {}, body: {}, user },
    res
  );
  const q = queries.length > before ? queries[queries.length - 1] : null;
  return {
    status: res.statusCode,
    body: res.body,
    sql: q ? q.sql : "",
    params: q ? q.params : [],
    queried: queries.length > before,
  };
}
(async () => {
  console.log("GET /insurances search filters — tests");

  await check("broker alone is accepted as a search criterion", async () => {
    const r = await search({ broker: "Euroins" });
    eq(r.status, 200, "status");
    ok(
      r.sql.includes("Broker LIKE ?"),
      "missing Broker condition: " + flat(r.sql)
    );
    eq(r.params, ["%Euroins%"], "bound params");
  });

  await check("broker matches partially (substring)", async () => {
    const r = await search({ broker: "Euro" });
    eq(r.params, ["%Euro%"], "bound params");
  });

  await check("broker value is trimmed before it is bound", async () => {
    const r = await search({ broker: "  Armeets " });
    eq(r.params, ["%Armeets%"], "bound params");
  });

  await check("soft-deleted rows stay excluded when filtering by broker", async () => {
    const r = await search({ broker: "Euroins" });
    eq(
      flat(r.sql),
      "SELECT * FROM insurance WHERE Deleted = 0 AND Broker LIKE ? ORDER BY CreationDate DESC",
      "sql"
    );
  });

  await check("broker combines with the other filters", async () => {
    const r = await search({
      author: "worker1",
      carNumber: "B1234",
      broker: "Euro",
    });
    eq(r.status, 200, "status");
    ok(flat(r.sql).includes("Author = ?"), "author condition");
    ok(flat(r.sql).includes("CarNumber LIKE ?"), "car number condition");
    ok(flat(r.sql).includes("Broker LIKE ?"), "broker condition");
    eq(r.params, ["worker1", "%B1234%", "%Euro%"], "bound params in order");
  });

  await check("broker value is bound, never concatenated into the SQL", async () => {
    const evil = "x'; DROP TABLE insurance; --";
    const r = await search({ broker: evil });
    eq(r.params, [`%${evil}%`], "bound params");
    ok(
      !r.sql.includes("DROP"),
      "SQL must not contain the raw value: " + flat(r.sql)
    );
  });

  await check("requests without a broker leave the SQL unchanged", async () => {
    const r = await search({ author: "worker1" });
    ok(!r.sql.includes("Broker"), "unexpected condition: " + flat(r.sql));
    eq(r.params, ["worker1"], "bound params");
  });

  await check("an empty request is still rejected", async () => {
    const r = await search({});
    eq(r.status, 400, "status");
    ok(r.queried === false, "must not hit the database");
    ok(
      String(r.body && r.body.error).includes("broker"),
      "error should list broker: " + JSON.stringify(r.body)
    );
  });

  await check("a blank broker is not a criterion", async () => {
    const r = await search({ broker: "   " });
    eq(r.status, 400, "status");
    ok(r.queried === false, "must not hit the database");
  });

  await check("date format is still validated next to broker", async () => {
    const r = await search({ broker: "Euro", date: "05.10.2026" });
    eq(r.status, 400, "status");
    ok(
      String(r.body && r.body.error).includes("YYYY-MM-DD"),
      "error: " + JSON.stringify(r.body)
    );
  });

  // -------------------------------------------------------------------------
  // includeDeleted - admins can look up soft-deleted insurances.
  // -------------------------------------------------------------------------
  const ADMIN = { role: 1, username: "admin1" };

  await check("an admin with includeDeleted=1 also gets deleted rows", async () => {
    const r = await search({ blancNumber: "123", includeDeleted: "1" }, ADMIN);
    eq(r.status, 200, "status");
    eq(
      flat(r.sql),
      "SELECT * FROM insurance WHERE 1 = 1 AND BlancNumber LIKE ? ORDER BY CreationDate DESC",
      "sql"
    );
    eq(r.params, ["%123%"], "bound params");
  });

  await check("includeDeleted accepts true / yes as well", async () => {
    for (const v of ["true", "yes", "TRUE"]) {
      const r = await search({ author: "w", includeDeleted: v }, ADMIN);
      ok(!r.sql.includes("Deleted = 0"), `${v}: ` + flat(r.sql));
    }
  });

  await check("an admin without the flag still gets only live rows", async () => {
    const r = await search({ blancNumber: "123" }, ADMIN);
    ok(flat(r.sql).includes("WHERE Deleted = 0"), flat(r.sql));
  });

  await check("an admin with includeDeleted=0 gets only live rows", async () => {
    const r = await search({ blancNumber: "123", includeDeleted: "0" }, ADMIN);
    ok(flat(r.sql).includes("WHERE Deleted = 0"), flat(r.sql));
  });

  await check("a worker can never see deleted rows, even with the flag", async () => {
    const r = await search({ blancNumber: "123", includeDeleted: "1" });
    eq(r.status, 200, "status");
    ok(flat(r.sql).includes("WHERE Deleted = 0"), flat(r.sql));
  });

  await check("includeDeleted alone is not a search criterion", async () => {
    const r = await search({ includeDeleted: "1" }, ADMIN);
    eq(r.status, 400, "status");
    ok(r.queried === false, "must not hit the database");
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();

