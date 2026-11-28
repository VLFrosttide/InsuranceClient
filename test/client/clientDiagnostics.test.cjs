"use strict";

// Node test: renderer/diag.js - the client-side failure recorder.
//
// Loads the REAL renderer script in a vm with a fake window/fetch, then checks
// what an intermittent 403 must leave behind:
//   - status, headers, block-page body, x-hcdn-request-id, timestamp and URL,
//   - the Authorization header redacted (the token must never be stored),
//   - the first successful request after the 403, paired with it,
//   - burst de-duplication (repeatCount) instead of a flood of reports,
//   - upload to POST /diag/client that acknowledges and clears the queue,
//   - no upload of signed-in reports when there is no token.
//
// Run with:  node test/client/clientDiagnostics.test.cjs

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const crypto = require("crypto");

const DIAG_JS = path.join(__dirname, "..", "..", "renderer", "diag.js");

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

function createLocalStorage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
    clear: () => map.clear(),
    _map: map,
  };
}

function createHarness() {
  const localStorage = createLocalStorage();
  const uploads = [];
  let responder = null;

  async function baseFetch(input, init) {
    const url = typeof input === "string" ? input : input && input.url;
    const method = String((init && init.method) || "GET").toUpperCase();
    if (url && url.endsWith("/diag/client")) {
      uploads.push({
        url,
        method,
        headers: (init && init.headers) || {},
        body: init && init.body ? JSON.parse(init.body) : null,
      });
      return new Response(JSON.stringify({ stored: 1 }), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    }
    return responder(url, method, init);
  }

  const documentStub = {
    title: "WorkPage",
    referrer: "",
    visibilityState: "visible",
    addEventListener: () => {},
    body: { appendChild: () => {} },
    querySelector: () => null,
  };
  const navigatorStub = {
    userAgent: "Insurance/4.6.3 Electron/40",
    platform: "Win32",
    language: "bg",
    languages: ["bg", "en"],
    onLine: true,
    hardwareConcurrency: 8,
    deviceMemory: 8,
  };

  const ctx = {
    console,
    Date,
    Math,
    JSON,
    Object,
    Array,
    String,
    Number,
    Boolean,
    Promise,
    Error,
    Map,
    Set,
    TextDecoder,
    Response,
    Headers,
    URL,
    Intl,
    fetch: baseFetch,
    performance: { now: () => 0 },
    setTimeout: () => 0,
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    location: {
      href: "file:///C:/app/renderer/WorkPage/WorkPage.html",
      pathname: "/C:/app/renderer/WorkPage/WorkPage.html",
      origin: "file://",
    },
    localStorage,
    navigator: navigatorStub,
    document: documentStub,
    crypto: { randomUUID: () => crypto.randomUUID() },
    API_BASE: "https://api.example.com",
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  ctx.window.addEventListener = () => {};
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(DIAG_JS, "utf8"), ctx, {
    filename: "renderer/diag.js",
  });

  async function waitFor(check, label, timeoutMs = 3000) {
    const started = Date.now();
    for (;;) {
      const value = await check();
      if (value) return value;
      if (Date.now() - started > timeoutMs) {
        throw new Error("timed out waiting for " + label);
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  function queue() {
    try {
      return JSON.parse(localStorage.getItem("clientDiagQueue") || "[]");
    } catch {
      return [];
    }
  }

  return {
    ctx,
    localStorage,
    uploads,
    queue,
    waitFor,
    setResponder(fn) {
      responder = fn;
    },
  };
}

async function main() {
  const h = createHarness();
  const { window } = h.ctx;
  ok(
    window.Diag && typeof window.Diag.flush === "function",
    "Diag global installed"
  );

  h.localStorage.setItem("token", "session-token-abc123");
  h.localStorage.setItem("username", "worker1");
  h.localStorage.setItem("role", "2");
  h.localStorage.setItem("branch", "ГКПП Капитан Андреево");

  // --- 1) A 403 is recorded with everything the PC can see ------------------
  const blockPage =
    "<html><head><title>403 Forbidden - Access denied</title></head>" +
    "<body>Request blocked by the hosting firewall. Incident 42.</body></html>";
  h.setResponder(
    () =>
      new Response(blockPage, {
        status: 403,
        statusText: "Forbidden",
        headers: {
          "content-type": "text/html; charset=utf-8",
          server: "hcdn",
          "x-hcdn-request-id": "req-abc-123",
          "cache-control": "no-store",
        },
      })
  );

  const res403 = await window.fetch(
    "https://api.example.com/insurances?author=me",
    {
      method: "GET",
      headers: {
        Authorization: "Bearer session-token-abc123",
        Accept: "application/json",
      },
    }
  );
  eq(res403.status, 403, "the caller still receives the 403 response");

  const first = await h.waitFor(() => h.queue()[0], "the 403 report");
  eq(first.kind, "failure", "kind");
  eq(first.status, 403, "status");
  eq(first.method, "GET", "method");
  eq(first.path, "/insurances?author=me", "path with query");
  eq(first.url, "https://api.example.com/insurances?author=me", "url");
  eq(first.requestId, "req-abc-123", "x-hcdn-request-id captured");
  eq(first.hasHcdnRequestId, true, "hasHcdnRequestId flag");
  eq(first.responseHeaders.server, "hcdn", "server header captured");
  ok(/403 Forbidden/.test(first.bodyTitle), "block-page title extracted");
  ok(/hosting firewall/.test(first.body), "response body captured");
  ok(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(first.capturedAt),
    "capturedAt is an ISO timestamp"
  );
  ok(
    /\[redacted len=\d+ fp=[0-9a-f]{8}\]/.test(
      first.requestHeaders.authorization
    ),
    "Authorization header redacted with a fingerprint"
  );
  eq(
    JSON.stringify(first).includes("session-token-abc123"),
    false,
    "the token never appears in the stored report"
  );
  eq(first.tokenPresent, true, "tokenPresent for a signed-in capture");
  ok(first.env && first.env.renderer, "environment snapshot attached");
  eq(first.repeatCount, 1, "first capture is not a repeat");

  // --- 2) The FIRST success after the 403 is stored and paired -------------
  h.setResponder(
    () =>
      new Response(JSON.stringify({ insurances: [] }), {
        status: 200,
        headers: { "content-type": "application/json", server: "hcdn" },
      })
  );
  await window.fetch("https://api.example.com/insurances?author=me", {
    method: "GET",
    headers: { Authorization: "Bearer session-token-abc123" },
  });
  const recovery = await h.waitFor(
    () => h.queue().find((entry) => entry.kind === "recovery"),
    "the recovery report"
  );
  eq(recovery.status, 200, "recovery status");
  eq(recovery.pairId, first.pairId, "recovery paired with the 403");
  ok(first.pairId, "the 403 carries a pair id");
  eq(recovery.samePath, true, "recovery is for the same path");
  eq(recovery.signature, null, "recoveries are not de-duplicated");

  // --- 3) A burst of identical 403s is one report with a counter ----------
  h.setResponder(
    () =>
      new Response("blocked", {
        status: 403,
        headers: {
          "content-type": "text/plain",
          "x-hcdn-request-id": "req-burst",
        },
      })
  );
  await window.fetch("https://api.example.com/currentcash?branch=b", {
    method: "GET",
  });
  await h.waitFor(
    () =>
      h.queue().filter((entry) => entry.path === "/currentcash?branch=b")
        .length,
    "first burst report"
  );
  await window.fetch("https://api.example.com/currentcash?branch=b", {
    method: "GET",
  });
  await window.fetch("https://api.example.com/currentcash?branch=b", {
    method: "GET",
  });
  const burst = await h.waitFor(() => {
    const entry = h.queue().find((e) => e.path === "/currentcash?branch=b");
    return entry && entry.repeatCount >= 3 ? entry : null;
  }, "repeatCount to reach 3");
  eq(
    h.queue().filter((entry) => entry.path === "/currentcash?branch=b").length,
    1,
    "three identical failures are stored once"
  );
  eq(burst.attempt, 3, "attempt counter follows the burst");

  // --- 4) Upload drains the queue after a successful connection -----------
  const before = h.queue().length;
  const result = await window.Diag.flush();
  ok(h.uploads.length >= 1, "POST /diag/client was attempted");
  const upload = h.uploads[h.uploads.length - 1];
  eq(upload.method, "POST", "upload method");
  eq(
    upload.headers.Authorization,
    "Bearer session-token-abc123",
    "upload carries the session token"
  );
  eq(upload.body.reports.length, before, "all queued reports uploaded");
  eq(result.uploaded, before, "flush reports the uploaded count");
  eq(h.queue().length, 0, "delivered reports removed from the local queue");

  // --- 5) Signed-in reports are NOT uploaded without a token --------------
  h.setResponder(
    () =>
      new Response("blocked", {
        status: 403,
        headers: { "content-type": "text/plain" },
      })
  );
  // Captured while signed in (tokenPresent: true)...
  await window.fetch("https://api.example.com/cardpayments", { method: "GET" });
  await h.waitFor(() => h.queue().length, "a new signed-in failure");
  // ...then the session disappears before it can be uploaded.
  h.localStorage.removeItem("token");
  const uploadsBefore = h.uploads.length;
  const skipped = await window.Diag.flush();
  eq(skipped.skipped, "no-token", "flush waits for a session");
  eq(h.uploads.length, uploadsBefore, "no upload without a token");
  eq(h.queue().length, 1, "the report stays queued");

  // --- 6) A report captured without a token may be uploaded anonymously ---
  const anonymous = {
    id: "anon-1",
    kind: "failure",
    capturedAt: new Date().toISOString(),
    capturedAtMs: Date.now(),
    status: 403,
    method: "POST",
    path: "/logme",
    url: "https://api.example.com/logme",
    tokenPresent: false,
    signature: "POST /logme 403",
    responseHeaders: { server: "hcdn" },
    requestHeaders: {},
  };
  h.localStorage.setItem(
    "clientDiagQueue",
    JSON.stringify([...h.queue(), anonymous])
  );
  const anonymousUpload = await window.Diag.flush();
  eq(anonymousUpload.uploaded, 1, "only the anonymous report is uploaded");
  eq(h.queue().length, 1, "the signed-in report is still waiting for a login");
  eq(
    h.uploads[h.uploads.length - 1].headers.Authorization,
    undefined,
    "anonymous upload sends no Authorization header"
  );

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
}

main().catch((err) => {
  console.error("Test failed:", err);
  process.exitCode = 1;
});

