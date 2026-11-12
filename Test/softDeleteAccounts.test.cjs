"use strict";

// Node test for the reversible (soft) delete of brokers and users.
//
// Deleting either one must never remove the row: the server only tags it with
// Deleted/DeletedAt/DeletedBy, exactly like a soft-deleted insurance, and an
// admin restores it from the same screen. This test covers both halves:
//
//   1. the client actions (renderer/WorkPage/WorkPage.js): the confirm text, the
//      endpoint each one calls and the toast it shows - deleteUser/restoreUser
//      and deleteBroker/restoreBroker;
//   2. the server handlers (InsuranceServer/Requests/TierEndpoints.js, loaded in
//      a vm with its requires stubbed like the other server tests): the delete
//      updates the row instead of removing it, the restore clears the flags and
//      the users list hides deleted accounts unless ?includeDeleted=1.
//
// Run with:  node Test/softDeleteAccounts.test.cjs   (or: npm test)

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { serverFile } = require("./serverPath.cjs");

const ROOT = path.join(__dirname, "..");
const WORKPAGE_JS = path.join(ROOT, "renderer", "WorkPage", "WorkPage.js");
const TIER_JS = serverFile("Requests", "TierEndpoints.js");

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
function ok(value, msg) {
  if (!value) throw new Error(msg || "expected a truthy value");
}

// One function, from its first line to the first "}" at column 0 (WorkPage.js
// uses CRLF, hence the \r?).
function cutFunction(source, marker) {
  const start = source.indexOf(marker);
  if (start < 0) {
    throw new Error(`Could not locate ${marker} in WorkPage.js (moved?)`);
  }
  const tail = source.slice(start);
  const closing = /\r?\n\}\r?\n/.exec(tail);
  if (!closing) throw new Error("Could not find the end of " + marker);
  return tail.slice(0, closing.index + closing[0].length);
}

// ---------------------------------------------------------------------------
// 1) The client actions
// ---------------------------------------------------------------------------
const pageSource = fs.readFileSync(WORKPAGE_JS, "utf8");
const clientBlock = [
  "async function deleteUser(user, onDone) {",
  "async function restoreUser(user, onDone) {",
  "async function deleteBroker(broker, onDone) {",
  "async function restoreBroker(broker, onDone) {",
]
  .map((marker) => cutFunction(pageSource, marker))
  .join("\n");

let apiCalls = [];
let toasts = [];
let confirmTexts = [];
let confirmAnswer = true;
let apiError = null;
let doneCalls = 0;

// t() only has to pass the key through and keep the placeholders visible: the
// real wording lives in renderer/common.js.
const CONFIRM_KEYS = {
  deleteUserConfirm: "delete user {u}",
  restoreUserConfirm: "restore user {u}",
  deleteBrokerConfirm: "delete broker {b}",
  restoreBrokerConfirm: "restore broker {b}",
};

const clientCtx = {
  console,
  t: (key) => CONFIRM_KEYS[key] ?? key,
  confirm: (text) => {
    confirmTexts.push(text);
    return confirmAnswer;
  },
  api: async (url, opts) => {
    apiCalls.push({ url, opts });
    if (apiError) throw new Error(apiError);
    return {};
  },
  toast: (message, kind) => toasts.push(`${kind}: ${message}`),
};
vm.createContext(clientCtx);
vm.runInContext(clientBlock, clientCtx, {
  filename: "WorkPage.js#softDeleteActions",
});

for (const name of ["deleteUser", "restoreUser", "deleteBroker", "restoreBroker"]) {
  if (typeof clientCtx[name] !== "function") {
    console.error(name + " did not load - block markers changed?");
    process.exit(1);
  }
}
const { deleteUser, restoreUser, deleteBroker, restoreBroker } = clientCtx;

function reset() {
  apiCalls = [];
  toasts = [];
  confirmTexts = [];
  confirmAnswer = true;
  apiError = null;
  doneCalls = 0;
}

// ---------------------------------------------------------------------------
// 2) The server handlers
// ---------------------------------------------------------------------------
const routes = [];
const queries = [];
const users = [
  {
    Username: "admin1",
    Role: 1,
    Balance: 0,
    Status: "active",
    BrokerId: null,
    Email: null,
    CreatedAt: "2026-01-02 09:00:00",
    Deleted: 0,
    DeletedAt: null,
    DeletedBy: null,
  },
  {
    Username: "worker1",
    Role: 2,
    Balance: 12,
    Status: "active",
    BrokerId: null,
    Email: null,
    CreatedAt: "2026-02-03 09:00:00",
    Deleted: 0,
    DeletedAt: null,
    DeletedBy: null,
  },
  {
    Username: "gone1",
    Role: 3,
    Balance: 0,
    Status: "active",
    BrokerId: 7,
    Email: "gone@example.com",
    CreatedAt: "2026-03-04 09:00:00",
    Deleted: 1,
    DeletedAt: "2026-12-05 11:22:33",
    DeletedBy: "admin1",
  },
];

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

const LIVE_COLUMNS = "Username, Role, Balance, Status";
const LIST_COLUMNS = "Username, Role, Balance, Status, BrokerId, Email, CreatedAt";
const DELETED_COLUMNS = `${LIST_COLUMNS}, DeletedAt, DeletedBy`;

const byName = (username) =>
  users.find((u) => u.Username === String(username)) || null;

// Put the fixtures back between checks: the delete/restore handlers change the
// same rows the list checks read.
function resetUsers() {
  users[1].Deleted = 0;
  users[1].DeletedAt = null;
  users[1].DeletedBy = null;
  users[2].Deleted = 1;
  users[2].DeletedAt = "2026-12-05 11:22:33";
  users[2].DeletedBy = "admin1";
}

const fakeDb = {
  query: async (sql, params) => {
    const s = String(sql).replace(/\s+/g, " ").trim();
    const p = params || [];
    queries.push({ sql: s, params: p });

    // fetchUser(): only a live account resolves.
    if (
      s === `SELECT ${LIVE_COLUMNS} FROM users WHERE Username = ? AND Deleted = 0`
    ) {
      const u = byName(p[0]);
      return [u && !u.Deleted ? [{ ...u }] : []];
    }
    // restore(): the lookup does see a deleted account ...
    if (s === `SELECT ${LIVE_COLUMNS}, Deleted FROM users WHERE Username = ?`) {
      const u = byName(p[0]);
      return [u ? [{ ...u }] : []];
    }
    // ... and this is the refreshed row after the flags were cleared.
    if (s === `SELECT ${LIVE_COLUMNS} FROM users WHERE Username = ?`) {
      const u = byName(p[0]);
      return [u && !u.Deleted ? [{ ...u }] : []];
    }
    // GET /admin/users (+ ?includeDeleted=1).
    if (
      s ===
      `SELECT ${LIST_COLUMNS} FROM users WHERE Deleted = 0 ORDER BY CreatedAt DESC, Username`
    ) {
      return [users.filter((u) => !u.Deleted).map((u) => ({ ...u }))];
    }
    if (
      s ===
      `SELECT ${DELETED_COLUMNS} FROM users WHERE Deleted = 1 ORDER BY DeletedAt DESC, Username`
    ) {
      return [users.filter((u) => u.Deleted).map((u) => ({ ...u }))];
    }
    if (s === "DELETE FROM tokens WHERE Username = ?") {
      return [{ affectedRows: 1 }];
    }
    if (
      s ===
      "UPDATE users SET Deleted = 1, DeletedAt = NOW(), DeletedBy = ? WHERE Username = ?"
    ) {
      const u = byName(p[1]);
      if (!u) return [{ affectedRows: 0 }];
      u.Deleted = 1;
      u.DeletedAt = "2026-12-11 10:30:00";
      u.DeletedBy = p[0];
      return [{ affectedRows: 1 }];
    }
    if (
      s ===
      "UPDATE users SET Deleted = 0, DeletedAt = NULL, DeletedBy = NULL WHERE Username = ?"
    ) {
      const u = byName(p[0]);
      if (!u) return [{ affectedRows: 0 }];
      u.Deleted = 0;
      u.DeletedAt = null;
      u.DeletedBy = null;
      return [{ affectedRows: 1 }];
    }
    throw new Error("unexpected SQL in test: " + s);
  },
  withTransaction: async (fn) => fn(fakeDb),
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
    recordCashMovement: async () => 0,
    recordCashLedgerOnly: async () => 0,
    recordChannelMovement: async () => 0,
    movePolicyBranch: async () => {},
    toDecimal: (v) =>
      v === null || v === undefined || v === "" ? null : Number(v),
  },
  "./CardPayments.js": {
    recordCardPayment: async () => 0,
    reduceCardBalance: async () => 0,
  },
  "./Brokers.js": {
    resolveBrokerByEmail: async () => null,
    blancInBrokerBatches: async () => true,
    decreaseBrokerForInsurance: async () => 0,
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
};

const mod = { exports: {} };
const serverCtx = { console, module: mod, exports: mod.exports, Buffer, process };
serverCtx.require = (id) => {
  if (!Object.prototype.hasOwnProperty.call(STUBS, id)) {
    throw new Error("unexpected require in TierEndpoints.js: " + id);
  }
  return STUBS[id];
};
vm.createContext(serverCtx);
vm.runInContext(fs.readFileSync(TIER_JS, "utf8"), serverCtx, {
  filename: "Requests/TierEndpoints.js",
});

if (typeof mod.exports.createTierRouter !== "function") {
  console.error("createTierRouter is not exported - server file changed?");
  process.exit(1);
}
mod.exports.createTierRouter(fakeDb);

function routeHandler(method, routePath) {
  const route = routes.find((r) => r.method === method && r.path === routePath);
  if (!route) {
    throw new Error(`${method.toUpperCase()} ${routePath} is not registered`);
  }
  // Last handler = the route body (the earlier ones are the auth middlewares).
  return route.handlers[route.handlers.length - 1];
}

async function call(method, routePath, opts = {}) {
  const res = {
    statusCode: 200,
    body: null,
    status(code) {
      res.statusCode = code;
      return res;
    },
    json(body) {
      res.body = body;
      return res;
    },
  };
  const req = {
    params: opts.params || {},
    query: opts.query || {},
    body: opts.body || {},
    user: opts.user || { username: "admin1", role: "1" },
  };
  await routeHandler(method, routePath)(req, res);
  return res;
}

(async () => {
  console.log("Brokers + users - hover X, reversible soft delete");

  // --- the client actions ----------------------------------------------------
  const user = { Username: "worker1" };
  const broker = { id: 7, Name: "Euroins" };

  await check("deleting a user asks first, naming the account", async () => {
    reset();
    confirmAnswer = false;
    await deleteUser(user, () => doneCalls++);
    eq(confirmTexts, ["delete user worker1"], "confirm text");
    eq(apiCalls, [], "nothing is sent when the admin cancels");
    eq(doneCalls, 0, "no refresh");
  });

  await check("deleting a user soft-deletes it on the server", async () => {
    reset();
    await deleteUser(user, () => doneCalls++);
    eq(apiCalls.length, 1, "one request");
    eq(apiCalls[0].url, "/admin/users/worker1/delete", "the delete endpoint");
    eq(apiCalls[0].opts.method, "POST", "method");
    eq(toasts, ["success: userDeleted"], "toast");
    eq(doneCalls, 1, "the view refreshes");
  });

  await check("restoring a user posts to /restore", async () => {
    reset();
    await restoreUser(user, () => doneCalls++);
    eq(confirmTexts, ["restore user worker1"], "confirm text");
    eq(apiCalls[0].url, "/admin/users/worker1/restore", "the restore endpoint");
    eq(apiCalls[0].opts.method, "POST", "method");
    eq(toasts, ["success: userRestored"], "toast");
    eq(doneCalls, 1, "the view refreshes");
  });

  await check("deleting a broker asks first and sends DELETE", async () => {
    reset();
    await deleteBroker(broker, () => doneCalls++);
    eq(confirmTexts, ["delete broker Euroins"], "confirm text");
    eq(apiCalls.length, 1, "one request");
    eq(apiCalls[0].url, "/brokers/7", "the broker's own URL");
    eq(apiCalls[0].opts.method, "DELETE", "method");
    eq(toasts, ["success: brokerDeleted"], "toast");
    eq(doneCalls, 1, "the view refreshes");
  });

  await check("restoring a broker posts to /restore", async () => {
    reset();
    await restoreBroker(broker, () => doneCalls++);
    eq(confirmTexts, ["restore broker Euroins"], "confirm text");
    eq(apiCalls[0].url, "/brokers/7/restore", "the restore endpoint");
    eq(apiCalls[0].opts.method, "POST", "method");
    eq(toasts, ["success: brokerRestored"], "toast");
  });

  await check("a rejected action reports the error and does not refresh", async () => {
    reset();
    apiError = "User not found";
    await deleteUser(user, () => doneCalls++);
    eq(toasts, ["error: User not found"], "toast");
    eq(doneCalls, 0, "no refresh");
  });

  // --- the server handlers ---------------------------------------------------
  await check("POST /admin/users/:username/delete only tags the row", async () => {
    queries.length = 0;
    resetUsers();
    const r = await call("post", "/admin/users/:username/delete", {
      params: { username: "worker1" },
    });

    eq(r.statusCode, 200, "status");
    eq(r.body.deleted, true, "reports a soft delete");
    eq(byName("worker1").Deleted, 1, "the row is flagged");
    eq(byName("worker1").DeletedBy, "admin1", "who deleted it");
    ok(byName("worker1").DeletedAt, "when it was deleted");
    eq(users.length, 3, "the row is still there");
    eq(
      queries.filter((q) => /^DELETE FROM users\b/.test(q.sql)),
      [],
      "the row is never removed"
    );
    ok(
      queries.some((q) => q.sql === "DELETE FROM tokens WHERE Username = ?"),
      "its sessions are dropped"
    );
  });

  await check("POST /admin/users/:username/delete refuses an admin", async () => {
    queries.length = 0;
    resetUsers();
    const r = await call("post", "/admin/users/:username/delete", {
      params: { username: "admin1" },
      user: { username: "other", role: "1" },
    });
    eq(r.statusCode, 403, "forbidden");
    eq(byName("admin1").Deleted, 0, "untouched");
  });

  await check("POST /admin/users/:username/delete ignores a deleted account", async () => {
    resetUsers();
    const r = await call("post", "/admin/users/:username/delete", {
      params: { username: "gone1" },
    });
    eq(r.statusCode, 404, "a twice-deleted account is not found");
  });

  await check("POST /admin/users/:username/restore clears the flags", async () => {
    queries.length = 0;
    resetUsers();
    const r = await call("post", "/admin/users/:username/restore", {
      params: { username: "gone1" },
    });

    eq(r.statusCode, 200, "status");
    eq(r.body.message, "User restored", "message");
    eq(byName("gone1").Deleted, 0, "the flag is cleared");
    eq(byName("gone1").DeletedAt, null, "DeletedAt cleared");
    eq(byName("gone1").DeletedBy, null, "DeletedBy cleared");
    eq(r.body.user.Username, "gone1", "the refreshed account comes back");
  });

  await check("POST /admin/users/:username/restore rejects a live account", async () => {
    resetUsers();
    const r = await call("post", "/admin/users/:username/restore", {
      params: { username: "worker1" },
    });
    eq(r.statusCode, 400, "bad request");
    eq(r.body.error, "User is not deleted", "message");
  });

  await check("GET /admin/users hides deleted accounts", async () => {
    resetUsers();
    const r = await call("get", "/admin/users");
    eq(r.statusCode, 200, "status");
    eq(
      r.body.users.map((u) => u.Username),
      ["admin1", "worker1"],
      "only the live accounts"
    );
    eq(r.body.deleted, [], "nothing is asked for");
  });

  await check("GET /admin/users?includeDeleted=1 lists them separately", async () => {
    resetUsers();
    const r = await call("get", "/admin/users", {
      query: { includeDeleted: "1" },
    });
    eq(
      r.body.users.map((u) => u.Username),
      ["admin1", "worker1"],
      "the live list is unchanged"
    );
    eq(
      r.body.deleted.map((u) => u.Username),
      ["gone1"],
      "the deleted list is separate"
    );
    ok(r.body.deleted[0].DeletedAt, "it says when");
    eq(r.body.deleted[0].DeletedBy, "admin1", "and by whom");
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
