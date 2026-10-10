"use strict";

// Node test for broker BLANC BATCHES.
//
// Admins hand blancs to a broker in batches (each a [RangeStart, RangeEnd]
// range) instead of a single range per broker, and the broker's inactive
// blancs are calculated from ALL of its batch ranges:
//
//     InactivePolicies = sum of (RangeEnd - RangeStart + 1)
//                      - blancs in those ranges used by a live insurance
//
// This loads the REAL server file (InsuranceServer/Requests/Brokers.js, see
// Test/serverPath.cjs) in a vm with its requires
// stubbed, registers the routes on a fake router, and drives the handlers
// against an in-memory fake MySQL that understands only the statements the
// batch code issues (anything else is a hard error).
//
// Run with:  node Test/brokerBlancBatches.test.cjs   (or: npm test)

const fs = require("fs");
const vm = require("vm");
const { serverFile } = require("./serverPath.cjs");

const BROKERS_JS = serverFile("Requests", "Brokers.js");

// --- in-memory fake MySQL ----------------------------------------------------
let db;
function resetDb() {
  db = {
    brokers: [
      { id: 1, Name: "Alpha", CashBalance: 0 },
      { id: 2, Name: "Beta", CashBalance: 0 },
    ],
    broker_emails: [],
    batches: [],
    insurance: [],
    nextBroker: 3,
    nextBatch: 1,
  };
}

const flat = (s) => String(s).replace(/\s+/g, " ").trim();

// Mirrors the SQL sub-query: distinct numeric blancs of non-deleted
// insurances (annulled ones keep their blanc used up).
function usedIn(batch) {
  const seen = new Set();
  for (const i of db.insurance) {
    const s = String(i.BlancNumber ?? "").trim();
    if (!/^[0-9]+$/.test(s) || i.Deleted) continue;
    const n = Number(s);
    if (n >= batch.RangeStart && n <= batch.RangeEnd) seen.add(n);
  }
  return seen.size;
}

const brokerById = (id) => db.brokers.filter((b) => b.id === Number(id));

async function query(sql, params = []) {
  const s = flat(sql);
  const p = params || [];

  if (s.startsWith("CREATE TABLE IF NOT EXISTS broker_blanc_batches")) {
    return [{}];
  }
  if (s.startsWith("SELECT id FROM brokers WHERE id = ?")) {
    return [brokerById(p[0]).map((b) => ({ id: b.id }))];
  }
  if (s.startsWith("SELECT id, Name, CashBalance FROM brokers WHERE id = ?")) {
    return [brokerById(p[0]).map((b) => ({ ...b }))];
  }
  if (s.startsWith("SELECT id, Name, CashBalance FROM brokers ORDER BY id")) {
    return [db.brokers.map((b) => ({ ...b }))];
  }
  if (s.startsWith("SELECT Email FROM broker_emails WHERE BrokerId = ?")) {
    return [db.broker_emails.filter((e) => e.BrokerId === Number(p[0]))];
  }
  if (s.startsWith("SELECT BrokerId, Email FROM broker_emails")) {
    return [db.broker_emails.slice()];
  }
  if (s.startsWith("SELECT COUNT(*) AS n FROM insurance WHERE BrokerId = ?")) {
    const n = db.insurance.filter((i) => i.BrokerId === Number(p[0])).length;
    return [[{ n }]];
  }
  if (/^SELECT BrokerId, COUNT\(\*\) AS n FROM insurance (WHERE Deleted = 0 )?GROUP BY/.test(s)) {
    return [[]];
  }
  if (s.startsWith("SELECT b.id, b.BrokerId, b.RangeStart, b.RangeEnd")) {
    if (!s.includes("i.Deleted = 0")) {
      throw new Error("used-blanc count must skip deleted policies");
    }
    if (s.includes("Annulled")) {
      throw new Error("annulled policies keep their blanc used up");
    }
    const one = s.includes("WHERE b.BrokerId = ?");
    const rows = db.batches
      .filter((b) => !one || b.BrokerId === Number(p[0]))
      .sort((a, b) => a.BrokerId - b.BrokerId || a.RangeStart - b.RangeStart)
      .map((b) => ({ ...b, Used: usedIn(b) }));
    return [rows];
  }
  if (s.startsWith("SELECT bb.id, bb.BrokerId, bb.RangeStart, bb.RangeEnd, br.Name")) {
    const [end, start] = p;
    const rows = db.batches
      .filter((b) => b.RangeStart <= end && b.RangeEnd >= start)
      .map((b) => ({ ...b, Name: (brokerById(b.BrokerId)[0] || {}).Name }));
    return [rows];
  }
  if (s.startsWith("SELECT BrokerId AS id FROM broker_blanc_batches")) {
    const rows = db.batches
      .filter((b) => b.RangeStart <= p[0] && b.RangeEnd >= p[1])
      .map((b) => ({ id: b.BrokerId }));
    return [rows];
  }
  if (s.startsWith("SELECT id FROM broker_blanc_batches WHERE id = ? AND BrokerId = ?")) {
    return [db.batches.filter((b) => b.id === p[0] && b.BrokerId === p[1])];
  }
  if (s.startsWith("INSERT INTO broker_blanc_batches")) {
    const id = db.nextBatch++;
    db.batches.push({
      id,
      BrokerId: p[0],
      RangeStart: p[1],
      RangeEnd: p[2],
      CreatedBy: p[3],
      CreatedAt: "2026-10-10 12:00:00",
    });
    return [{ insertId: id }];
  }
  if (s.startsWith("UPDATE broker_blanc_batches SET RangeStart = ?, RangeEnd = ? WHERE id = ?")) {
    const b = db.batches.find((x) => x.id === p[2]);
    b.RangeStart = p[0];
    b.RangeEnd = p[1];
    return [{ affectedRows: 1 }];
  }
  if (s.startsWith("DELETE FROM broker_blanc_batches WHERE id = ? AND BrokerId = ?")) {
    const before = db.batches.length;
    db.batches = db.batches.filter((b) => !(b.id === p[0] && b.BrokerId === p[1]));
    return [{ affectedRows: before - db.batches.length }];
  }
  if (s.startsWith("INSERT INTO brokers")) {
    const id = db.nextBroker++;
    db.brokers.push({ id, Name: p[0], CashBalance: p[1] });
    return [{ insertId: id }];
  }
  if (s.startsWith("INSERT INTO broker_emails")) {
    db.broker_emails.push({ BrokerId: p[0], Email: p[1] });
    return [{}];
  }
  if (/^UPDATE brokers SET CashBalance = CashBalance [-+] \? WHERE id = \?$/.test(s)) {
    return [{ affectedRows: 1 }];
  }
  throw new Error("unexpected SQL in test: " + s);
}

const fakeDb = { query, withTransaction: async (fn) => fn(fakeDb) };

// --- load the real router ----------------------------------------------------
const routes = [];
const recorder = (method) => (routePath, ...handlers) => {
  routes.push({
    method,
    path: routePath,
    handler: handlers[handlers.length - 1],
  });
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
  express: { Router: () => fakeRouter },
  "./Auth.js": {
    requireAuth: () => (req, res, next) => next(),
    requireRole: () => (req, res, next) => next(),
  },
  "../db/BrokerInfo.js": {
    Pricing: {},
    seedBrokerTariffsIfMissing: async () => 0,
  },
  "./CurrentCash.js": {
    toDecimal: (v) => (Number.isFinite(Number(v)) ? Number(v) : null),
    recordCashMovement: async () => {},
    normalizeCurrency: (c) => c || "EUR",
    normalizeBranch: (b) => b || "",
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
if (typeof M.createBrokerRouter !== "function") {
  console.error("createBrokerRouter is not exported - server file changed?");
  process.exit(1);
}
M.createBrokerRouter(fakeDb);

function route(method, p) {
  const r = routes.find((x) => x.method === method && x.path === p);
  if (!r) throw new Error(`route ${method.toUpperCase()} ${p} not registered`);
  return r.handler;
}

// Objects built inside the vm come from another realm, so responses are
// round-tripped through JSON before comparing.
const plain = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

async function call(method, p, { params = {}, body = {}, query = {} } = {}) {
  const out = { status: 200, body: null };
  const res = {
    status(c) {
      out.status = c;
      return res;
    },
    json(b) {
      out.body = plain(b);
      return res;
    },
    send(b) {
      out.body = b;
      return res;
    },
    setHeader() {},
  };
  await route(method, p)(
    { params, body, query, user: { username: "admin1", role: 1 } },
    res
  );
  return out;
}

// --- tiny assert helpers -----------------------------------------------------
let passed = 0;
let failed = 0;
async function check(name, fn) {
  resetDb();
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
  const a = JSON.stringify(plain(actual));
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${msg}: expected ${b}, got ${a}`);
}
function ok(cond, msg) {
  if (!cond) throw new Error(msg);
}

const addBatch = (id, RangeStart, RangeEnd) =>
  call("post", "/brokers/:id/batches", {
    params: { id: String(id) },
    body: { RangeStart, RangeEnd },
  });
const brokerOf = async (id) =>
  (await call("get", "/brokers")).body.brokers.find((b) => b.id === id);


(async () => {
  console.log("Broker blanc batches");

  await check("parseBlancBatch validates the start and end numbers", async () => {
    eq(M.parseBlancBatch({ RangeStart: "100", RangeEnd: "199" }).ok, true, "valid");
    eq(M.parseBlancBatch({ RangeStart: 5, RangeEnd: 5 }).RangeEnd, 5, "one blanc");
    eq(M.parseBlancBatch({ RangeStart: "", RangeEnd: "9" }).ok, false, "no start");
    eq(M.parseBlancBatch({ RangeStart: "9", RangeEnd: "1" }).ok, false, "end<start");
    eq(M.parseBlancBatch({ RangeStart: "-1", RangeEnd: "5" }).ok, false, "negative");
    eq(M.parseBlancBatch({ RangeStart: "1.5", RangeEnd: "5" }).ok, false, "decimal");
  });

  await check("inactive blancs are summed over all batch ranges", async () => {
    const s = M.summarizeBlancBatches([
      { id: 1, BrokerId: 1, RangeStart: 100, RangeEnd: 199, Used: 10 },
      { id: 2, BrokerId: 1, RangeStart: 500, RangeEnd: 549, Used: 0 },
      { id: 3, BrokerId: 2, RangeStart: 1000, RangeEnd: 1009, Used: 10 },
    ]);
    const a = s.get(1);
    eq([a.BlancTotal, a.BlancUsed, a.InactivePolicies], [150, 10, 140], "broker 1");
    eq(a.batches.map((b) => b.Inactive), [90, 50], "per batch");
    eq(s.get(2).InactivePolicies, 0, "broker 2 fully used");
  });

  await check("a broker without batches has 0 inactive blancs", async () => {
    const b = M.applyBlancSummary({ id: 7, InactivePolicies: 55 }, new Map());
    eq([b.batches.length, b.InactivePolicies], [0, 0], "old stored value ignored");
  });

  await check("admins add several batches; inactive is calculated", async () => {
    eq((await addBatch(1, 100, 199)).status, 201, "first batch");
    const r = await addBatch(1, 300, 349);
    eq(r.status, 201, "second batch");
    eq(r.body.broker.InactivePolicies, 150, "100 + 50 blancs");
    eq(r.body.broker.batches.length, 2, "two batches");

    db.insurance.push(
      { BlancNumber: "105", Deleted: 0, Annulled: 0 },
      { BlancNumber: " 320 ", Deleted: 0, Annulled: 0 },
      { BlancNumber: "330", Deleted: 0, Annulled: 1 }, // annulled -> stays used
      { BlancNumber: "331", Deleted: 1, Annulled: 0 }, // deleted -> back
      { BlancNumber: "999", Deleted: 0, Annulled: 0 } // outside every batch
    );
    const alpha = await brokerOf(1);
    eq(
      [alpha.BlancTotal, alpha.BlancUsed, alpha.InactivePolicies],
      [150, 3, 147],
      "alpha"
    );
    eq((await brokerOf(2)).InactivePolicies, 0, "beta has no batches");
  });

  await check("several batches can be added in one request", async () => {
    const r = await call("post", "/brokers/:id/batches", {
      params: { id: "1" },
      body: {
        batches: [
          { RangeStart: 1, RangeEnd: 10 },
          { RangeStart: 20, RangeEnd: 29 },
        ],
      },
    });
    eq(r.status, 201, "status");
    eq(r.body.broker.InactivePolicies, 20, "10 + 10");
  });

  await check("overlapping batches are rejected", async () => {
    await addBatch(1, 100, 199);
    eq((await addBatch(1, 150, 250)).status, 409, "overlaps own batch");
    const other = await addBatch(2, 199, 199);
    eq(other.status, 409, "overlaps another broker's batch");
    ok(String(other.body.error).includes("Alpha"), "names owner: " + other.body.error);
    const inside = await call("post", "/brokers/:id/batches", {
      params: { id: "2" },
      body: {
        batches: [
          { RangeStart: 1, RangeEnd: 10 },
          { RangeStart: 5, RangeEnd: 15 },
        ],
      },
    });
    eq(inside.status, 409, "overlap inside one request");
    eq(db.batches.length, 1, "nothing extra stored");
    eq((await addBatch(2, 200, 299)).status, 201, "adjacent range is fine");
  });

  await check("invalid batch input is rejected", async () => {
    eq((await addBatch(1, "", 5)).status, 400, "missing start");
    eq((await addBatch(1, 9, 1)).status, 400, "end < start");
    eq((await addBatch(99, 1, 5)).status, 404, "unknown broker");
    eq(db.batches.length, 0, "nothing stored");
  });


  await check("editing a batch recalculates and may not overlap", async () => {
    await addBatch(1, 100, 199);
    await addBatch(1, 300, 399);
    const id = String(db.batches[0].id);
    const grow = await call("patch", "/brokers/:id/batches/:batchId", {
      params: { id: "1", batchId: id },
      body: { RangeStart: 100, RangeEnd: 249 },
    });
    eq(grow.status, 200, "own range may change");
    eq(grow.body.broker.InactivePolicies, 250, "150 + 100");
    const clash = await call("patch", "/brokers/:id/batches/:batchId", {
      params: { id: "1", batchId: id },
      body: { RangeStart: 100, RangeEnd: 300 },
    });
    eq(clash.status, 409, "clash with the second batch");
    const wrong = await call("patch", "/brokers/:id/batches/:batchId", {
      params: { id: "2", batchId: id },
      body: { RangeStart: 1, RangeEnd: 2 },
    });
    eq(wrong.status, 404, "batch of another broker");
  });

  await check("deleting a batch removes its blancs from inactive", async () => {
    await addBatch(1, 100, 199);
    await addBatch(1, 300, 309);
    const r = await call("delete", "/brokers/:id/batches/:batchId", {
      params: { id: "1", batchId: String(db.batches[0].id) },
    });
    eq(r.status, 200, "status");
    eq(r.body.broker.InactivePolicies, 10, "only the second batch left");
  });

  await check("GET /brokers/:id/batches returns batches and totals", async () => {
    await addBatch(1, 100, 109);
    db.insurance.push({ BlancNumber: "101", Deleted: 0, Annulled: 0 });
    const r = await call("get", "/brokers/:id/batches", { params: { id: "1" } });
    eq(
      [r.body.BlancTotal, r.body.BlancUsed, r.body.InactivePolicies],
      [10, 1, 9],
      "totals"
    );
    eq(r.body.batches[0].Used, 1, "per-batch used");
  });

  await check("creating a broker accepts batches, or none", async () => {
    const r = await call("post", "/brokers", {
      body: {
        Name: "Gamma",
        batches: [
          { RangeStart: 1, RangeEnd: 50 },
          { RangeStart: 60, RangeEnd: 69 },
        ],
      },
    });
    eq(r.status, 201, "status");
    eq(r.body.broker.InactivePolicies, 60, "50 + 10");
    const none = await call("post", "/brokers", { body: { Name: "Delta" } });
    eq([none.status, none.body.broker.InactivePolicies], [201, 0], "no batches");
    const legacy = await call("post", "/brokers", {
      body: { Name: "Eps", PolicyRangeStart: 500, PolicyRangeEnd: 509 },
    });
    eq(legacy.body.broker.batches.length, 1, "old single range -> one batch");
    const clash = await call("post", "/brokers", {
      body: { Name: "Zeta", batches: [{ RangeStart: 40, RangeEnd: 45 }] },
    });
    eq(clash.status, 409, "overlap rejected");
    ok(!db.brokers.some((b) => b.Name === "Zeta"), "broker not created");
  });

  await check("PATCH /brokers/:id can no longer set the counter", async () => {
    const r = await call("patch", "/brokers/:id", {
      params: { id: "1" },
      body: { InactivePolicies: 500 },
    });
    eq(r.status, 400, "nothing to update");
  });

  await check("insurance create / annul / delete only move the balance", async () => {
    eq(await M.decreaseBrokerForInsurance(fakeDb, 1, 30), 30, "charge");
    eq(await M.restoreBrokerForAnnulment(fakeDb, 1, 30), 30, "annul refund");
    eq(await M.restoreBrokerForDeletion(fakeDb, 1, 30), 30, "delete refund");
    eq(await M.restoreBrokerForDeletion(fakeDb, 1, 0), 0, "delete after annul");
  });

  await check("deleting a policy gives its blanc back, annulling does not", async () => {
    await addBatch(1, 100, 109);
    db.insurance.push({ BlancNumber: "101", Deleted: 0, Annulled: 0 });
    eq((await brokerOf(1)).InactivePolicies, 9, "after create");
    db.insurance[0].Annulled = 1;
    eq((await brokerOf(1)).InactivePolicies, 9, "annul keeps it used");
    db.insurance[0].Deleted = 1;
    eq((await brokerOf(1)).InactivePolicies, 10, "delete gives it back");
  });

  await check("a blanc number resolves to the broker holding it", async () => {
    await addBatch(1, 100, 199);
    await addBatch(2, 700, 799);
    eq(await M.resolveBrokerId(fakeDb, { blancNumber: "750" }), 2, "2nd broker");
    eq(await M.resolveBrokerId(fakeDb, { blancNumber: "150" }), 1, "1st broker");
  });

  await check("CSV export lists every batch", async () => {
    await addBatch(1, 100, 199);
    await addBatch(1, 300, 309);
    const r = await call("get", "/brokers/export", { query: { format: "csv" } });
    const lines = String(r.body).split("\n");
    ok(lines[0].includes("BlancBatches"), lines[0]);
    ok(lines[1].includes('"100-199;300-309",110,0,110'), lines[1]);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();

