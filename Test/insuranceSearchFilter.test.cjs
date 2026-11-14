"use strict";

// Node test for the GET /insurances search filters: the `broker` parameter
// (added for the "My insurances" lookup tab) and the `annulled` parameter
// (added for the "Annulled" filter).
//
// The route handler lives in InsuranceServer/Requests/TierEndpoints.js (see
// Test/serverPath.cjs). It is a CommonJS module that only needs `express` and a
// handful of sibling modules at load time, so this test loads the REAL file in
// a vm with those requires stubbed, registers the routes on a fake router, and
// then calls the /insurances handler directly with a fake req/res and a fake DB
// connection. The SQL and its bound parameters are captured, so the test
// asserts what the endpoint actually asks MySQL to do.
//
// The broker name is matched in JavaScript (not SQL) so it can be insensitive
// to the Cyrillic/Latin script difference: "Lesovo" finds policies stored under
// the "ГКПП Лесово" branch. The brokerNameMatches / transliterateBulgarian
// helpers are unit-tested directly here too.
//
// Run with:  node Test/insuranceSearchFilter.test.cjs   (or: npm test)

const fs = require("fs");
const vm = require("vm");
const { serverFile } = require("./serverPath.cjs");

const TIER_JS = serverFile("Requests", "TierEndpoints.js");

// --- fakes -------------------------------------------------------------------
const routes = [];
const queries = [];
// Rows the fake DB returns for the next query, so the handler's broker filter
// (which runs in JavaScript) can be exercised end-to-end.
let returnRows = [];

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
    getBrokerAllowNegativeBalance: async () => true,
  },
  "./PaymentSchedule.js": { getSchedule: async () => null },
  "../db/branches.js": { isBranchEnabled: async () => true },
  // The walk-in branch → broker mapping lives in BrokerInfo.BranchPricingKeys
  // (the branch names differ from the broker names). Mirrored here only so the
  // handler can be loaded; a drift guard below compares this copy with the real
  // file.
  "../db/BrokerInfo.js": {
    BranchPricingKeys: {
      "ГКПП Капитан Андреево": "KapAndreevo",
      "ГКПП Лесово": "Lesovo",
      "Офис Харманли": "Nikolay",
    },
  },
  "../Mail/SendReply.js": { sendReply: async () => {} },
  "../Mail/mailStore.js": { markAnswered: () => null },
  "../Mail/threadHistory.js": { fetchThreadConversation: async () => null },
};

// Rows the fake DB returns for the brokers lookup (the broker ID/code lookup).
// The endpoint asks for them by BrokerId (email policies) or by Name (walk-in
// policies of a border crossing).
let brokerRows = [];

const fakeDb = {
  query: async (sql, params) => {
    queries.push({ sql: String(sql), params: params || [] });
    if (/FROM brokers\b/.test(String(sql))) return [brokerRows];
    return [returnRows];
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

const brokerNameMatches = mod.exports.brokerNameMatches;
const transliterateBulgarian = mod.exports.transliterateBulgarian;
if (typeof brokerNameMatches !== "function") {
  console.error("brokerNameMatches is not exported - server file changed?");
  process.exit(1);
}

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
    eq(r.queried, true, "hits the database");
    ok(!r.sql.includes("Broker"), "broker is not a SQL condition: " + flat(r.sql));
  });

  await check("the broker query is a plain SELECT without a broker condition", async () => {
    const r = await search({ broker: "Euroins" });
    eq(
      flat(r.sql),
      "SELECT * FROM insurance WHERE Deleted = 0 ORDER BY CreationDate DESC",
      "sql"
    );
    eq(r.params, [], "no bound params");
  });

  await check("soft-deleted rows stay excluded when filtering by broker", async () => {
    const r = await search({ broker: "Euroins" });
    ok(flat(r.sql).includes("WHERE Deleted = 0"), flat(r.sql));
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
    ok(!r.sql.includes("Broker"), "broker is not a SQL condition");
    eq(r.params, ["worker1", "%B1234%"], "bound params in order");
  });

  await check("broker value is never concatenated into the SQL", async () => {
    const evil = "x'; DROP TABLE insurance; --";
    const r = await search({ broker: evil });
    ok(
      !r.sql.includes("DROP"),
      "SQL must not contain the raw value: " + flat(r.sql)
    );
    ok(
      !r.params.some((p) => String(p).includes("DROP")),
      "params must not carry the raw value"
    );
  });

  await check("requests without a broker leave the SQL unchanged", async () => {
    const r = await search({ author: "worker1" });
    ok(!r.sql.includes("Broker"), "unexpected condition: " + flat(r.sql));
    eq(r.params, ["worker1"], "bound params");
  });

  await check("broker filters the fetched rows (Latin → Cyrillic branch)", async () => {
    returnRows = [
      { Broker: "ГКПП Лесово", BlancNumber: "1" },
      { Broker: "Euroins", BlancNumber: "2" },
    ];
    const r = await search({ broker: "Lesovo" });
    eq(r.status, 200, "status");
    eq(r.body.insurances.map((i) => i.BlancNumber), ["1"], "only the Lesovo row");
  });

  await check("broker filters the fetched rows (abbreviated Latin)", async () => {
    returnRows = [
      { Broker: "ГКПП Капитан Андреево", BlancNumber: "1" },
      { Broker: "Euroins", BlancNumber: "2" },
    ];
    const r = await search({ broker: "kap andreevo" });
    eq(r.body.insurances.map((i) => i.BlancNumber), ["1"], "Kapitan Andreevo row");
  });

  // -------------------------------------------------------------------------
  // brokerNameMatches / transliterateBulgarian unit tests
  // -------------------------------------------------------------------------

  await check("transliterateBulgarian maps Cyrillic to Latin", () => {
    eq(transliterateBulgarian("ГКПП Лесово"), "gkpp lesovo");
    eq(transliterateBulgarian("Капитан Андреево"), "kapitan andreevo");
    eq(transliterateBulgarian("Euroins"), "euroins");
  });

  await check("brokerNameMatches is script- and case-insensitive", () => {
    ok(brokerNameMatches("ГКПП Лесово", "Lesovo"));
    ok(brokerNameMatches("ГКПП Лесово", "lesovo"));
    ok(brokerNameMatches("ГКПП Лесово", "Лесово"));
    ok(brokerNameMatches("Euroins", "Euro"));
    ok(brokerNameMatches("ГКПП Капитан Андреево", "kap andreevo"));
    ok(brokerNameMatches("ГКПП Капитан Андреево", "Kapitan Andreevo"));
  });

  await check("brokerNameMatches rejects non-matches", () => {
    ok(!brokerNameMatches("ГКПП Лесово", "Harmanli"));
    ok(!brokerNameMatches("", "Lesovo"));
    ok(!brokerNameMatches("Euroins", "   "));
  });

  // -------------------------------------------------------------------------
  // annulled - restrict the result to annulled policies only.
  // -------------------------------------------------------------------------

  await check("annulled=1 adds the Annulled = 1 condition", async () => {
    const r = await search({ annulled: "1" });
    eq(r.status, 200, "status");
    ok(flat(r.sql).includes("Annulled = 1"), flat(r.sql));
  });

  await check("annulled is a valid criterion on its own", async () => {
    const r = await search({ annulled: "1" });
    eq(r.status, 200, "status");
    eq(r.queried, true, "hits the database");
  });

  await check("annulled accepts true / yes as well", async () => {
    for (const v of ["true", "yes", "TRUE"]) {
      const r = await search({ author: "w", annulled: v });
      ok(flat(r.sql).includes("Annulled = 1"), `${v}: ` + flat(r.sql));
    }
  });

  await check("annulled=0 does not add the condition", async () => {
    const r = await search({ author: "w", annulled: "0" });
    eq(r.status, 200, "status");
    ok(!flat(r.sql).includes("Annulled"), flat(r.sql));
  });

  await check("annulled combines with the other filters", async () => {
    const r = await search({ date: "2026-10-01", annulled: "1" });
    eq(r.status, 200, "status");
    ok(flat(r.sql).includes("DATE(CreationDate) = DATE(?)"), "date condition");
    ok(flat(r.sql).includes("Annulled = 1"), "annulled condition");
    eq(r.params, ["2026-10-01"], "bound params");
  });

  await check("an empty request is still rejected", async () => {
    const r = await search({});
    eq(r.status, 400, "status");
    ok(r.queried === false, "must not hit the database");
    ok(
      String(r.body && r.body.error).includes("broker"),
      "error should list broker: " + JSON.stringify(r.body)
    );
    ok(
      String(r.body && r.body.error).includes("annulled"),
      "error should list annulled: " + JSON.stringify(r.body)
    );
    ok(
      String(r.body && r.body.error).includes("payment"),
      "error should list payment: " + JSON.stringify(r.body)
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
  // payment - restrict the result to a single payment type (Cash/Card/Broker).
  // -------------------------------------------------------------------------

  await check("payment=Cash alone is accepted as a search criterion", async () => {
    const r = await search({ payment: "Cash" });
    eq(r.status, 200, "status");
    eq(r.queried, true, "hits the database");
    ok(flat(r.sql).includes("PaymentType = ?"), flat(r.sql));
    eq(r.params, ["Cash"], "bound params");
  });

  await check("payment=Card and payment=Broker map to their literals", async () => {
    for (const v of ["Card", "Broker"]) {
      const r = await search({ payment: v });
      eq(r.status, 200, "status");
      ok(flat(r.sql).includes("PaymentType = ?"), `${v}: ` + flat(r.sql));
      eq(r.params, [v], `bound param for ${v}`);
    }
  });

  await check("payment is case-insensitive and normalised to the stored literal", async () => {
    for (const v of ["cash", "CASH", "Cash"]) {
      const r = await search({ payment: v });
      eq(r.params, ["Cash"], `${v}: ` + JSON.stringify(r.params));
    }
    const r = await search({ payment: "bRoKeR" });
    eq(r.params, ["Broker"], "broker: " + JSON.stringify(r.params));
  });

  await check("an unknown payment is rejected", async () => {
    const r = await search({ payment: "cheque" });
    eq(r.status, 400, "status");
    ok(r.queried === false, "must not hit the database");
    ok(
      String(r.body && r.body.error).includes("payment"),
      "error: " + JSON.stringify(r.body)
    );
  });

  await check("payment combines with the other filters", async () => {
    const r = await search({ date: "2026-10-01", payment: "Broker" });
    eq(r.status, 200, "status");
    ok(flat(r.sql).includes("DATE(CreationDate) = DATE(?)"), "date condition");
    ok(flat(r.sql).includes("PaymentType = ?"), "payment condition");
    eq(r.params, ["2026-10-01", "Broker"], "bound params in order");
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

  // -------------------------------------------------------------------------
  // Broker ID (BrokerCode) - the "ID" column of the lookup table and of the
  // Excel export.
  //
  // An email policy is linked to its broker through BrokerId. A walk-in policy
  // stores only the branch (Broker) and keeps BrokerId NULL, so a policy issued
  // at a border crossing gets the crossing's own broker ID - the crossings are
  // registered as brokers (Kapitan Andreevo 2.1, Lesovo 4.2). The Harmanli
  // office is not a broker, so its policies keep an empty ID.
  // -------------------------------------------------------------------------

  // Broker lookups the handler ran for the search that just finished.
  async function searchWithBrokers(query, user, rows, brokers) {
    returnRows = rows;
    brokerRows = brokers;
    const before = queries.length;
    const r = await search(query, user);
    r.brokerQueries = queries
      .slice(before)
      .filter((q) => /FROM brokers\b/.test(q.sql));
    return r;
  }

  await check(
    "a Kapitan Andreevo walk-in policy gets the crossing's broker ID",
    async () => {
      const r = await searchWithBrokers(
        { blancNumber: "1" },
        undefined,
        [
          {
            BlancNumber: "1",
            Branch: "ГКПП Капитан Андреево",
            Broker: "ГКПП Капитан Андреево",
            BrokerId: null,
          },
        ],
        [{ Name: "KapAndreevo", Code: "2.1" }]
      );
      eq(r.status, 200, "status");
      eq(r.body.insurances[0].BrokerCode, "2.1", "ID of Kapitan Andreevo");
      eq(r.brokerQueries.length, 1, "one broker lookup");
      ok(
        /FROM brokers WHERE Name IN/.test(flat(r.brokerQueries[0].sql)),
        "walk-ins are looked up by broker name: " + flat(r.brokerQueries[0].sql)
      );
      eq(r.brokerQueries[0].params, ["KapAndreevo"], "branch → broker name");
    }
  );

  await check("a Lesovo walk-in policy gets its crossing's broker ID", async () => {
    const r = await searchWithBrokers(
      { blancNumber: "2" },
      undefined,
      [
        {
          BlancNumber: "2",
          Branch: "ГКПП Лесово",
          Broker: "ГКПП Лесово",
          BrokerId: null,
        },
      ],
      [{ Name: "Lesovo", Code: "4.2" }]
    );
    eq(r.body.insurances[0].BrokerCode, "4.2", "ID of Lesovo");
  });

  await check("the walk-in broker name match ignores case", async () => {
    const r = await searchWithBrokers(
      { blancNumber: "3" },
      undefined,
      [
        {
          BlancNumber: "3",
          Branch: "ГКПП Капитан Андреево",
          Broker: "ГКПП Капитан Андреево",
          BrokerId: null,
        },
      ],
      [{ Name: "kapandreevo", Code: "2.1" }]
    );
    eq(r.body.insurances[0].BrokerCode, "2.1", "case-insensitive name");
  });

  await check("a branch that is not a broker keeps an empty ID", async () => {
    const r = await searchWithBrokers(
      { blancNumber: "4" },
      undefined,
      [
        {
          BlancNumber: "4",
          Branch: "Офис Харманли",
          Broker: "Офис Харманли",
          BrokerId: null,
        },
      ],
      []
    );
    eq(r.body.insurances[0].BrokerCode, "", "the office has no broker ID");
  });

  await check("an email policy still gets its broker's ID by BrokerId", async () => {
    const r = await searchWithBrokers(
      { blancNumber: "5" },
      undefined,
      [
        {
          BlancNumber: "5",
          Branch: "ГКПП Капитан Андреево",
          Broker: "Kamuran",
          BrokerId: 7,
        },
      ],
      [{ id: 7, Code: "1.9" }]
    );
    eq(r.body.insurances[0].BrokerCode, "1.9", "ID of the email broker");
    eq(r.brokerQueries.length, 1, "one broker lookup");
    ok(
      /FROM brokers WHERE id IN/.test(flat(r.brokerQueries[0].sql)),
      "by id: " + flat(r.brokerQueries[0].sql)
    );
    eq(r.brokerQueries[0].params, [7], "bound broker id");
  });

  await check("walk-in and email rows are resolved in one search", async () => {
    returnRows = [
      {
        BlancNumber: "1",
        Branch: "ГКПП Капитан Андреево",
        Broker: "ГКПП Капитан Андреево",
        BrokerId: null,
      },
      {
        BlancNumber: "2",
        Branch: "Офис Харманли",
        Broker: "Euroins",
        BrokerId: 9,
      },
    ];
    brokerRows = [];
    const before = queries.length;
    const res = await search({ date: "2026-10-01" });
    eq(res.status, 200, "status");
    const brokerQueries = queries
      .slice(before)
      .filter((q) => /FROM brokers\b/.test(q.sql));
    eq(
      brokerQueries.map((q) => (/WHERE id IN/.test(q.sql) ? "id" : "name")),
      ["id", "name"],
      "one lookup per kind of policy"
    );
  });

  await check("no broker lookup when no row can have an ID", async () => {
    returnRows = [{ BlancNumber: "1", Broker: "Euroins", BrokerId: null }];
    brokerRows = [];
    const before = queries.length;
    await search({ author: "worker1" });
    eq(
      queries.slice(before).filter((q) => /FROM brokers\b/.test(q.sql)).length,
      0,
      "no broker lookup"
    );
  });

  // The branch → broker-name map is defined once, in BrokerInfo.js. The copy in
  // this test only exists so the handler can be loaded; keep them in sync.
  await check("the walk-in branch map matches BrokerInfo.BranchPricingKeys", () => {
    const real = require(serverFile("db", "BrokerInfo.js"));
    eq(
      STUBS["../db/BrokerInfo.js"].BranchPricingKeys,
      real.BranchPricingKeys,
      "test stub is out of date"
    );
  });

  await check("walkInBrokerName resolves the branches", () => {
    const walkInBrokerName = mod.exports.walkInBrokerName;
    ok(typeof walkInBrokerName === "function", "walkInBrokerName is exported");
    eq(walkInBrokerName("ГКПП Капитан Андреево"), "KapAndreevo", "Kap Andreevo");
    eq(walkInBrokerName("  ГКПП Лесово  "), "Lesovo", "Lesovo (trimmed)");
    eq(walkInBrokerName("Офис Харманли"), "Nikolay", "Harmanli");
    eq(walkInBrokerName(""), "", "empty branch");
    eq(walkInBrokerName(null), "", "null branch");
    eq(walkInBrokerName("Непознат клон"), "", "unknown branch");
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();

