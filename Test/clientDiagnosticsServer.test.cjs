"use strict";

// Node test: InsuranceServer/Requests/Diagnostics.js - the diagnostics intake
// and the admin-only inspection endpoints.
//
// Loads the REAL server file in a vm (see Test/serverPath.cjs) with express and
// Auth.js stubbed, then checks:
//   - POST /diag/client is registered and stores the client's fields,
//   - a signed-in report cannot be uploaded anonymously (401),
//   - an anonymous (failed-login) report can be, rate limited per IP,
//   - GET/DELETE /admin/diagnostics and GET /admin/diagnostics/context are
//     gated by requireRole(1) and return parsed JSON columns,
//   - the admin context reports the IP chain, auth policy and polling stats.
//
// Run with:  node Test/clientDiagnosticsServer.test.cjs

const fs = require("fs");
const vm = require("vm");
const { serverFile } = require("./serverPath.cjs");

const DIAG_SERVER_JS = serverFile("Requests", "Diagnostics.js");

const routes = [];
let roleChecks = [];

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
  express: {
    Router: () => fakeRouter,
  },
  "./Auth.js": {
    requireAuth: () => (req, res, next) => next(),
    requireRole: (...roles) => {
      roleChecks.push(roles);
      return (req, res, next) => next();
    },
    extractToken: (req) => {
      const header = req.headers && req.headers.authorization;
      if (!header || !String(header).startsWith("Bearer ")) return null;
      return String(header).slice("Bearer ".length).trim() || null;
    },
  },
};

// --- fake DB ----------------------------------------------------------------
const db = {
  inserts: [],
  deletes: [],
  listRows: [],
  checks: [],
  // The `app_settings` row behind the Diagnostics tab switch.
  settings: undefined,
};

function fakeQuery(sql, params = []) {
  const text = String(sql);
  db.checks.push({ sql: text, params });
  if (/FROM tokens t/.test(text)) {
    const token = params[0];
    return token === "admin-token"
      ? [[{ Username: "admin1", Role: 1 }]]
      : [[]];
  }
  if (/FROM app_settings/i.test(text)) {
    return db.settings === undefined ? [[]] : [[{ value: db.settings }]];
  }
  if (/INSERT INTO app_settings/i.test(text)) {
    db.settings = params[1];
    return [{ affectedRows: 1 }];
  }
  if (/^INSERT INTO client_diagnostics/i.test(text)) {
    const match = /\(([\s\S]*?)\)\s*VALUES/i.exec(text);
    const columns = match
      ? match[1].split(",").map((column) => column.trim())
      : [];
    const values = params[0] || [];
    const rows = values.map((tuple) => {
      const row = {};
      columns.forEach((column, index) => {
        row[column] = tuple[index];
      });
      return row;
    });
    db.inserts.push({ rows, columns });
    return [{ insertId: 41, affectedRows: rows.length }];
  }
  if (/^SELECT COUNT\(\*\) AS Total/i.test(text)) {
    return [
      [
        {
          Total: 3,
          Forbidden: 2,
          Recoveries: 1,
          WithRequestId: 2,
          Clients: 2,
        },
      ],
    ];
  }
  if (/FROM client_diagnostics[\s\S]*ORDER BY id DESC/i.test(text)) {
    return [db.listRows];
  }
  if (/^DELETE FROM client_diagnostics/i.test(text)) {
    db.deletes.push(params);
    return [{ affectedRows: params.length ? params[0].length : 7 }];
  }
  return [[]];
}

const fakeDb = { query: fakeQuery };

const mod = { exports: {} };
const CTX = {
  console,
  module: mod,
  exports: mod.exports,
  Buffer,
  process,
  URL,
  Date,
  JSON,
  Number,
  String,
  Object,
  Array,
  Boolean,
  Math,
  Set,
  Map,
  Promise,
};
CTX.require = (id) => {
  if (!Object.prototype.hasOwnProperty.call(STUBS, id)) {
    throw new Error("unexpected require in Diagnostics.js: " + id);
  }
  return STUBS[id];
};
vm.createContext(CTX);
vm.runInContext(fs.readFileSync(DIAG_SERVER_JS, "utf8"), CTX, {
  filename: "Requests/Diagnostics.js",
});

const { createDiagnosticsRouter } = mod.exports;
if (typeof createDiagnosticsRouter !== "function") {
  console.error("createDiagnosticsRouter is not exported - server file changed?");
  process.exit(1);
}

// --- tiny assert helpers -----------------------------------------------------
let passed = 0;
let failed = 0;
function eq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    passed++;
    console.log("  PASS  " + label);
  } else {
    failed++;
    console.error(`  FAIL  ${label}\n        expected ${e}\n        actual   ${a}`);
  }
}
function ok(value, label) {
  eq(!!value, true, label);
}

function makeRes() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
    setHeader(key, value) {
      this.headers[String(key).toLowerCase()] = value;
    },
    sendStatus(code) {
      this.statusCode = code;
      return this;
    },
  };
}

function makeReq({ method = "POST", headers = {}, body = {}, query = {} } = {}) {
  return {
    method,
    url: "/",
    originalUrl: "/",
    headers,
    body,
    query,
    socket: { remoteAddress: "10.0.0.9" },
  };
}

function findRoute(method, routePath) {
  return routes.find((route) => route.method === method && route.path === routePath);
}

function handlerOf(route) {
  return route.handlers[route.handlers.length - 1];
}

const clientIp = (req) => {
  const forwarded = req.headers["x-forwarded-for"];
  if (forwarded) return String(forwarded).split(",")[0].trim();
  return (req.socket && req.socket.remoteAddress) || null;
};

function report(overrides = {}) {
  return {
    id: "r-1",
    kind: "failure",
    capturedAt: "2026-11-16T12:34:56.789Z",
    capturedAtMs: 1763296496789,
    status: 403,
    method: "GET",
    path: "/insurances?author=me",
    url: "https://api.example.com/insurances?author=me",
    requestId: "req-123",
    hasHcdnRequestId: true,
    durationMs: 120,
    attempt: 1,
    repeatCount: 2,
    tokenPresent: true,
    responseHeaders: {
      "content-type": "text/html",
      server: "hcdn",
      "x-hcdn-request-id": "req-123",
    },
    requestHeaders: {
      authorization: "[redacted len=30 fp=deadbeef]",
    },
    body: "<html><title>403 Forbidden</title></html>",
    bodyKind: "html",
    bodyTitle: "403 Forbidden",
    env: {
      hostname: "PC-1",
      clientId: "client-1",
      publicIp: "203.0.113.5",
    },
    ...overrides,
  };
}

async function main() {
  createDiagnosticsRouter(fakeDb, {
    clientIp,
    recentRequests: () => [{ method: "GET", path: "/insurances", status: 403 }],
    recentFailures: () => [{ method: "GET", path: "/insurances", status: 403 }],
    pollingStats: () => [
      { ip: "203.0.113.5", method: "GET", path: "/ping", requestsPerMinute: 40 },
    ],
    trustProxy: () => false,
    now: () => 1763296496789,
  });

  // --- 1) Routes are registered -------------------------------------------
  ok(findRoute("post", "/diag/client"), "POST /diag/client registered");
  ok(findRoute("get", "/admin/diagnostics"), "GET /admin/diagnostics registered");
  ok(
    findRoute("delete", "/admin/diagnostics"),
    "DELETE /admin/diagnostics registered"
  );
  ok(
    findRoute("get", "/admin/diagnostics/context"),
    "GET /admin/diagnostics/context registered"
  );
  ok(
    findRoute("get", "/admin/diagnostics/settings"),
    "GET /admin/diagnostics/settings registered"
  );
  ok(
    findRoute("put", "/admin/diagnostics/settings"),
    "PUT /admin/diagnostics/settings registered"
  );
  eq(
    roleChecks.filter((roles) => roles.length === 1 && String(roles[0]) === "1")
      .length,
    5,
    "all five admin routes use requireRole(1)"
  );

  const upload = handlerOf(findRoute("post", "/diag/client"));
  const list = handlerOf(findRoute("get", "/admin/diagnostics"));
  const remove = handlerOf(findRoute("delete", "/admin/diagnostics"));
  const context = handlerOf(findRoute("get", "/admin/diagnostics/context"));
  const readSettings = handlerOf(findRoute("get", "/admin/diagnostics/settings"));
  const saveSettings = handlerOf(findRoute("put", "/admin/diagnostics/settings"));

  // --- 2) A signed-in upload is stored with every field -------------------
  let res = makeRes();
  await upload(
    makeReq({
      headers: {
        authorization: "Bearer admin-token",
        origin: "file://",
        "x-forwarded-for": "203.0.113.5, 10.0.0.1",
        "user-agent": "Insurance/4.6.3 Electron/40",
      },
      body: { clientId: "client-1", reports: [report()] },
    }),
    res
  );
  eq(res.statusCode, 201, "upload status");
  eq(res.body.stored, 1, "one report stored");
  eq(db.inserts.length, 1, "one INSERT executed");
  const stored = db.inserts[0].rows[0];
  eq(stored.Status, 403, "status stored");
  eq(stored.RequestId, "req-123", "request id stored");
  eq(stored.HasRequestId, 1, "HasRequestId flag");
  eq(stored.Kind, "failure", "kind stored");
  eq(stored.Username, "admin1", "username taken from the token");
  eq(stored.AuthState, "token", "auth state");
  eq(stored.UploadIp, "203.0.113.5", "upload IP from X-Forwarded-For");
  eq(
    stored.ForwardedFor,
    "203.0.113.5, 10.0.0.1",
    "full X-Forwarded-For preserved"
  );
  eq(stored.CapturedAtMs, 1763296496789, "captured timestamp (ms)");
  eq(stored.CapturedAt, "2025-11-16 12:34:56", "captured timestamp (UTC)");
  ok(/403 Forbidden/.test(stored.Body), "block-page body stored");
  ok(
    String(stored.Headers).includes("x-hcdn-request-id"),
    "headers stored as JSON"
  );
  eq(stored.ClientId, "client-1", "client id stored");
  eq(stored.RepeatCount, 2, "burst counter stored");
  ok(stored.UploadHeaders, "upload headers stored");
  eq(
    String(stored.UploadHeaders).includes("admin-token"),
    false,
    "the upload's Authorization header is redacted"
  );
  ok(
    String(stored.UploadHeaders).includes("[redacted len="),
    "upload Authorization header replaced by a length marker"
  );

  // --- 3) A signed-in report cannot be uploaded anonymously --------------
  res = makeRes();
  await upload(makeReq({ body: { reports: [report()] } }), res);
  eq(res.statusCode, 401, "anonymous upload of a signed-in report is refused");

  // --- 4) An anonymous report (failed login) is accepted ------------------
  res = makeRes();
  await upload(
    makeReq({
      headers: { "x-forwarded-for": "198.51.100.7" },
      body: {
        reports: [
          report({
            url: "https://api.example.com/logme",
            path: "/logme",
            method: "POST",
            tokenPresent: false,
            requestId: "",
            hasHcdnRequestId: false,
            responseHeaders: { server: "hcdn" },
            requestHeaders: { authorization: "Bearer leaked-token" },
            body: "<html><title>Blocked</title></html>",
          }),
        ],
      },
    }),
    res
  );
  eq(res.statusCode, 201, "anonymous login failure accepted");
  const anon = db.inserts[db.inserts.length - 1].rows[0];
  eq(anon.Username, null, "no username without a token");
  eq(anon.AuthState, "none", "auth state none");
  eq(anon.HasRequestId, 0, "no request id");
  eq(anon.UploadIp, "198.51.100.7", "anonymous upload IP");
  eq(
    String(anon.RequestHeaders).includes("leaked-token"),
    false,
    "a token in the captured request headers is redacted server-side"
  );

  // --- 5) Per-IP rate limit ----------------------------------------------
  const postCountBefore = routes.filter((route) => route.method === "post").length;
  createDiagnosticsRouter(fakeDb, {
    clientIp,
    now: () => 1763296496789,
  });
  const posts = routes.filter((route) => route.method === "post");
  eq(posts.length, postCountBefore + 1, "second router registered its intake");
  const limitedPost = handlerOf(posts[posts.length - 1]);

  const anonBody = { reports: [report({ tokenPresent: false })] };
  let lastStatus = 0;
  for (let i = 0; i < 30; i++) {
    const r = makeRes();
    await limitedPost(
      makeReq({ headers: { "x-forwarded-for": "192.0.2.77" }, body: anonBody }),
      r
    );
    lastStatus = r.statusCode;
  }
  eq(lastStatus, 201, "30 anonymous uploads per 10 min are allowed");
  res = makeRes();
  await limitedPost(
    makeReq({ headers: { "x-forwarded-for": "192.0.2.77" }, body: anonBody }),
    res
  );
  eq(res.statusCode, 429, "the 31st anonymous upload is rate limited");
  ok(res.headers["retry-after"], "Retry-After advertised");

  // --- 6) GET /admin/diagnostics -----------------------------------------
  db.listRows = [
    {
      id: 7,
      ReceivedAt: "2026-11-16 12:40:00",
      ClientId: "client-1",
      Username: "admin1",
      Kind: "failure",
      Status: 403,
      Method: "GET",
      Path: "/insurances",
      RequestId: "req-123",
      HasRequestId: 1,
      Headers: '{"server":"hcdn"}',
      RequestHeaders: '{"authorization":"[redacted]"}',
      Env: '{"hostname":"PC-1"}',
      Extra: '{"bodyKind":"html"}',
      UploadHeaders: '{"host":"api.example.com"}',
    },
  ];
  res = makeRes();
  await list(
    makeReq({ method: "GET", query: { status: "403", limit: "50" } }),
    res
  );
  eq(res.statusCode, 200, "list status");
  eq(res.body.count, 1, "one report returned");
  eq(res.body.summary.forbidden, 2, "summary counts");
  eq(res.body.reports[0].Headers.server, "hcdn", "headers parsed");
  eq(res.body.reports[0].Env.hostname, "PC-1", "env parsed");
  ok(
    db.checks.some(
      (check) =>
        /FROM client_diagnostics/.test(check.sql) &&
        check.params.includes(403) &&
        check.params.includes(50)
    ),
    "status filter and limit parameterised"
  );

  // --- 7) GET /admin/diagnostics/context ---------------------------------
  res = makeRes();
  await context(
    makeReq({
      method: "GET",
      headers: {
        authorization: "Bearer admin-token",
        origin: "file://",
        "x-forwarded-for": "203.0.113.5",
        "x-real-ip": "203.0.113.5",
      },
    }),
    res
  );
  eq(res.statusCode, 200, "context status");
  eq(res.body.request.ip, "203.0.113.5", "resolved IP");
  eq(res.body.request.forwardedFor, "203.0.113.5", "X-Forwarded-For shown");
  eq(res.body.accessControl.trustProxy, false, "trust proxy setting");
  eq(
    res.body.accessControl.ipAllowList,
    "none - no route filters by IP address",
    "IP policy reported"
  );
  eq(
    res.body.recent.polling[0].requestsPerMinute,
    40,
    "polling stats passed through"
  );
  ok(
    /redacted/.test(res.body.request.headers.authorization),
    "authorization redacted in the context"
  );

  // --- 8) DELETE /admin/diagnostics --------------------------------------
  res = makeRes();
  await remove(makeReq({ method: "DELETE", body: { all: true } }), res);
  eq(res.statusCode, 200, "delete status");
  eq(res.body.deleted, 7, "all reports deleted");
  res = makeRes();
  await remove(makeReq({ method: "DELETE", body: {} }), res);
  eq(res.statusCode, 400, "delete without ids or all is rejected");

  // --- 8) The Diagnostics tab switch ---------------------------------------
  // Default: shown, so an existing deployment keeps its tab.
  res = makeRes();
  await readSettings(makeReq(), res);
  eq(res.statusCode, 200, "settings status");
  eq(res.body, { enabled: true }, "shown by default");
  eq(db.checks[db.checks.length - 1].params, ["diagnostics_enabled"],
    "the shared app_settings key is read");

  res = makeRes();
  await saveSettings(
    makeReq({ method: "PUT", body: { enabled: false } }),
    res
  );
  eq(res.body, { enabled: false }, "saved off");
  eq(db.settings, "0", "stored as 0 in app_settings");

  res = makeRes();
  await readSettings(makeReq(), res);
  eq(res.body, { enabled: false }, "read back as hidden");

  res = makeRes();
  await saveSettings(makeReq({ method: "PUT", body: {} }), res);
  eq(res.statusCode, 400, "enabled is required");

  // --- 9) Gathering switched off: uploads are answered but not stored -------
  db.settings = "0";
  const insertsBefore = db.inserts.length;
  res = makeRes();
  await upload(
    makeReq({
      headers: { authorization: "Bearer admin-token" },
      body: { clientId: "c-1", reports: [report({ kind: "failure", status: 403 })] },
    }),
    res
  );
  eq(res.statusCode, 200, "the client still gets a success answer");
  eq(res.body, { stored: 0, disabled: true, clientId: "c-1" },
    "nothing is stored, and the client is told so");
  eq(db.inserts.length, insertsBefore, "no row was written");

  db.settings = "1";
  res = makeRes();
  await upload(
    makeReq({
      headers: { authorization: "Bearer admin-token" },
      body: { clientId: "c-1", reports: [report({ kind: "failure", status: 403 })] },
    }),
    res
  );
  eq(res.statusCode, 201, "switched back on, uploads are stored again");
  eq(db.inserts.length, insertsBefore + 1, "the row was written");

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
}

main().catch((err) => {
  console.error("Test failed:", err);
  process.exitCode = 1;
});
