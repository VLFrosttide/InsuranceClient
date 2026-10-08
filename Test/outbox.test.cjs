"use strict";

// Node test for the offline outbox (/outbox.js) used to deliver new policies
// over slow / unstable / missing internet connections.
//
// Runs the REAL outbox module against a REAL local HTTP server that imitates
// POST /worker/insurances + GET /insurances and can be told to misbehave:
// be down, answer slowly, drop the connection after saving (lost response),
// answer 5xx, answer with a CDN HTML error page, reject (400/409) or 401.
//
// Run with:  node Test/outbox.test.cjs   (or: npm test)

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { pathToFileURL } = require("url");

const ROOT = path.join(__dirname, "..");

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log("  PASS  " + name);
  } catch (err) {
    failed++;
    console.log("  FAIL  " + name + "  -> " + (err && err.stack ? err.stack : err));
  }
}
function eq(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error((msg || "values differ") + ` (got ${a}, want ${b})`);
}
function ok(cond, msg) {
  if (!cond) throw new Error(msg || "expected truthy");
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(cond, timeoutMs = 4000, msg = "condition") {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await cond()) return;
    await sleep(20);
  }
  throw new Error(`timed out waiting for ${msg}`);
}

// --- fake API server ---------------------------------------------------------
// mode: "ok" | "slow" | "drop-after-save" | "500" | "cdn-html" | "400" | "401"
function createServer() {
  const state = { mode: "ok", validToken: "tok-1", db: [], posts: 0, gets: 0, slowMs: 0 };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      const send = (status, obj, type = "application/json") => {
        res.writeHead(status, { "Content-Type": type });
        res.end(typeof obj === "string" ? obj : JSON.stringify(obj));
      };
      const auth = req.headers.authorization || "";
      const url = new URL(req.url, "http://x");

      if (req.method === "GET" && url.pathname === "/insurances") {
        state.gets++;
        if (state.mode === "cdn-html") {
          return send(502, "<html><title>Bad gateway</title></html>", "text/html");
        }
        if (auth !== `Bearer ${state.validToken}`) return send(401, { error: "Invalid token" });
        const blanc = url.searchParams.get("blancNumber") || "";
        const author = url.searchParams.get("author") || "";
        return send(200, {
          insurances: state.db.filter(
            (r) => String(r.BlancNumber).includes(blanc) && (!author || r.Author === author)
          ),
        });
      }

      if (req.method === "POST" && url.pathname === "/worker/insurances") {
        state.posts++;
        if (state.mode === "cdn-html") {
          return send(503, "<html><title>Service Unavailable</title></html>", "text/html");
        }
        if (state.mode === "500") return send(500, { error: "Failed to create insurance" });
        if (state.mode === "401" || auth !== `Bearer ${state.validToken}`) {
          return send(401, { error: "Invalid token" });
        }
        let b;
        try {
          b = JSON.parse(body);
        } catch {
          return send(400, { error: "Bad JSON" });
        }
        if (state.mode === "400") return send(400, { error: "BlancNumber is required" });
        if (state.db.some((r) => String(r.BlancNumber) === String(b.BlancNumber))) {
          return send(409, { error: "Insurance with this BlancNumber already exists" });
        }
        // Saved on the server...
        state.db.push({
          BlancNumber: b.BlancNumber,
          Author: "worker1",
          files: (b.Attachments || []).length,
        });
        if (state.mode === "drop-after-save") {
          // ...but the answer never reaches the client (connection dies).
          req.socket.destroy();
          return;
        }
        if (state.mode === "slow") await sleep(state.slowMs);
        return send(201, { message: "Insurance created", blancNumber: b.BlancNumber });
      }
      send(404, { error: "Not found" });
    });
  });
  return { server, state };
}

function listen(server, port = 0) {
  return new Promise((resolve) =>
    server.listen(port, "127.0.0.1", () => resolve(server.address().port))
  );
}
function close(server) {
  return new Promise((resolve) => {
    if (server.closeAllConnections) server.closeAllConnections();
    server.close(() => resolve());
  });
}
// A port nothing listens on (connections are refused = server down).
async function deadPort() {
  const probe = http.createServer();
  const port = await listen(probe);
  await close(probe);
  return port;
}

const quietLog = { log() {}, warn() {}, error() {} };
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "outbox-test-"));
const filesIn = (dir) => fs.readdirSync(dir).filter((n) => !n.endsWith(".tmp"));

function policyReq(blanc, extra = {}) {
  return {
    path: "/worker/insurances",
    body: JSON.stringify({
      BlancNumber: blanc,
      CarNumber: "CA1234",
      Attachments: [{ filename: "a.pdf", mimeType: "application/pdf", base64: "JVBERi0x" }],
    }),
    token: "tok-1",
    username: "worker1",
    label: `${blanc} · CA1234`,
    kind: "insurance",
    verify: {
      path: `/insurances?blancNumber=${blanc}&author=worker1`,
      listKey: "insurances",
      match: { BlancNumber: blanc, Author: "worker1" },
    },
    ...extra,
  };
}

// Never let a stuck test hang `npm test`.
setTimeout(() => {
  console.error("outbox tests timed out");
  process.exit(1);
}, 60000).unref();

(async () => {
  const { Outbox, sameValue } = await import(
    pathToFileURL(path.join(ROOT, "outbox.js")).href
  );

  function makeOutbox(dir, port, opts = {}) {
    return new Outbox({
      dir,
      baseUrl: `http://127.0.0.1:${port}`,
      fetch: (url, init) => fetch(url, init),
      retryIntervalMs: 100,
      baseTimeoutMs: 400,
      verifyTimeoutMs: 400,
      log: quietLog,
      ...opts,
    });
  }

  console.log("outbox");

  await check("sameValue compares numbers and strings", () => {
    ok(sameValue("0123", 123));
    ok(sameValue(" 55 ", "55"));
    ok(!sameValue("", 0));
    ok(!sameValue("A1", "A2"));
  });

  await check("good connection: delivered immediately, nothing left on disk", async () => {
    const { server, state } = createServer();
    const port = await listen(server);
    const dir = tmpDir();
    const ob = makeOutbox(dir, port);
    await ob.init();
    const out = await ob.submit(policyReq("1001"), 2000);
    eq(out.status, "sent");
    eq(out.queued, false);
    eq(out.result.blancNumber, "1001");
    eq(state.db.length, 1);
    eq(ob.getState().unsentCount, 0);
    eq(filesIn(dir), [], "queue folder should be empty");
    ob.stop();
    await close(server);
  });

  await check("server down: stored on disk, returns 'queued' fast, delivered in order when back", async () => {
    const port = await deadPort();
    const dir = tmpDir();
    const ob = makeOutbox(dir, port);
    await ob.init();
    const started = Date.now();
    const out = await ob.submit(policyReq("2001"), 3000);
    ok(Date.now() - started < 1500, "submit must not block until the wait timeout");
    eq(out.queued, true);
    eq(out.status, "pending");
    eq(filesIn(dir).length, 2, "meta + body persisted");
    const bodyFile = filesIn(dir).find((n) => n.endsWith(".body.json"));
    ok(fs.readFileSync(path.join(dir, bodyFile), "utf8").includes("JVBERi0x"), "files stored");

    // The worker keeps working: a second policy while still offline.
    await ob.submit(policyReq("2002"), 200);
    eq(ob.getState().unsentCount, 2);

    // The connection comes back (server listening on the same port again).
    const { server, state } = createServer();
    await listen(server, port);
    await until(() => ob.getState().unsentCount === 0, 4000, "delivery after reconnect");
    eq(state.db.map((r) => r.BlancNumber), ["2001", "2002"], "delivered in order");
    eq(filesIn(dir), []);
    ob.stop();
    await close(server);
  });

  await check("lost response (saved, answer dropped): verified, NOT sent twice", async () => {
    const { server, state } = createServer();
    const port = await listen(server);
    const ob = makeOutbox(tmpDir(), port);
    await ob.init();
    state.mode = "drop-after-save";
    const out = await ob.submit(policyReq("3001"), 300);
    eq(out.queued, true);
    state.mode = "ok";
    await until(() => ob.getState().unsentCount === 0, 4000, "verification");
    eq(state.db.length, 1, "exactly one record on the server");
    eq(state.posts, 1, "the POST must not be repeated");
    ok(state.gets >= 1, "delivery was verified with a GET");
    ob.stop();
    await close(server);
  });

  await check("slow server beyond the timeout: verified, no duplicate", async () => {
    const { server, state } = createServer();
    const port = await listen(server);
    const ob = makeOutbox(tmpDir(), port, { baseTimeoutMs: 150 });
    await ob.init();
    state.mode = "slow";
    state.slowMs = 600; // saved at once, answer only after the client timeout
    const out = await ob.submit(policyReq("4001"), 1000);
    eq(out.queued, true);
    ok(/No answer/.test(out.error), "timeout reported: " + out.error);
    state.mode = "ok";
    await until(() => ob.getState().unsentCount === 0, 4000, "delivery");
    eq(state.db.length, 1);
    eq(state.posts, 1);
    ob.stop();
    await close(server);
  });

  await check("5xx and CDN HTML error pages are retried until they land", async () => {
    const { server, state } = createServer();
    const port = await listen(server);
    const ob = makeOutbox(tmpDir(), port);
    await ob.init();
    state.mode = "cdn-html";
    const out = await ob.submit(policyReq("5001"), 300);
    eq(out.queued, true);
    ok(/intermediary/.test(out.error), out.error);
    await sleep(250);
    // A gateway 5xx may come after the API saved the policy, so later
    // attempts first check with a GET (which also hits the CDN page here).
    ok(state.posts + state.gets >= 3, "kept retrying");
    eq(state.posts, 1, "not re-posted while the delivery check cannot run");
    state.mode = "500";
    await sleep(250);
    eq(ob.getState().unsentCount, 1);
    state.mode = "ok";
    await until(() => ob.getState().unsentCount === 0, 4000, "delivery");
    eq(state.db.length, 1, "500s were answered before saving: one record");
    ob.stop();
    await close(server);
  });

  await check("server rejects while the form waits: 'failed' returned, nothing queued", async () => {
    const { server, state } = createServer();
    const port = await listen(server);
    const dir = tmpDir();
    const ob = makeOutbox(dir, port);
    await ob.init();
    state.mode = "400";
    const out = await ob.submit(policyReq("6001"), 2000);
    eq(out.status, "failed");
    eq(out.queued, false);
    eq(out.httpStatus, 400);
    eq(ob.getState().items.length, 0, "the form keeps the data; no stale queue entry");
    eq(filesIn(dir), []);
    ob.stop();
    await close(server);
  });

  await check("queued policy later rejected: kept as failed, can be retried / discarded", async () => {
    const port = await deadPort();
    const dir = tmpDir();
    const ob = makeOutbox(dir, port);
    await ob.init();
    eq((await ob.submit(policyReq("7001"), 200)).queued, true);
    const { server, state } = createServer();
    state.mode = "400";
    await listen(server, port);
    await until(() => ob.getState().failedCount === 1, 4000, "rejection");
    const item = ob.getState().items[0];
    eq(item.status, "failed");
    ok(/BlancNumber/.test(item.lastError));
    await sleep(300);
    eq(state.posts, 1, "a rejected request is not retried automatically");

    state.mode = "ok";
    await ob.retry(item.id);
    await until(() => ob.getState().items.length === 0, 4000, "manual retry");
    eq(state.db.length, 1);

    state.mode = "400";
    await ob.enqueue(policyReq("7002"));
    await until(() => ob.getState().failedCount === 1, 4000, "second rejection");
    ok(await ob.discard(ob.getState().items[0].id));
    eq(ob.getState().items.length, 0);
    eq(filesIn(dir), []);
    ob.stop();
    await close(server);
  });

  await check("409 after an unanswered attempt (no check possible) counts as delivered", async () => {
    const { server, state } = createServer();
    const port = await listen(server);
    const ob = makeOutbox(tmpDir(), port);
    await ob.init();
    const req = policyReq("8001");
    req.verify = null; // rely on the server's own duplicate guard
    state.mode = "drop-after-save";
    await ob.submit(req, 300);
    state.mode = "ok";
    await until(() => ob.getState().items.length === 0, 4000, "duplicate guard");
    eq(state.db.length, 1);
    eq(state.posts, 2, "re-sent once, the server answered 409");
    ob.stop();
    await close(server);
  });

  await check("409 for a number owned by someone else stays a real error", async () => {
    const { server, state } = createServer();
    const port = await listen(server);
    const ob = makeOutbox(tmpDir(), port);
    await ob.init();
    state.db.push({ BlancNumber: "8501", Author: "other-worker" });
    state.mode = "500"; // first attempt: ambiguous
    await ob.submit(policyReq("8501"), 300);
    state.mode = "ok"; // check finds no record of worker1 -> send -> 409
    await until(() => ob.getState().failedCount === 1, 4000, "conflict");
    ok(/already exists/.test(ob.getState().items[0].lastError));
    ob.stop();
    await close(server);
  });

  await check("expired session (401): waits for a new login of the same user", async () => {
    const { server, state } = createServer();
    const port = await listen(server);
    const ob = makeOutbox(tmpDir(), port);
    await ob.init();
    state.validToken = "tok-2"; // tok-1 has expired
    const out = await ob.submit(policyReq("9001"), 2000);
    eq(out.status, "auth");
    eq(out.queued, true);
    await sleep(300);
    eq(state.posts, 1, "no hammering with a rejected token");
    await ob.updateToken("someone-else", "tok-2");
    await sleep(200);
    eq(ob.getState().items[0].status, "auth", "other users' tokens are never used");
    await ob.updateToken("worker1", "tok-2");
    await until(() => ob.getState().items.length === 0, 4000, "delivery after login");
    eq(state.db.length, 1);
    ob.stop();
    await close(server);
  });

  await check("survives an app restart (queue reloaded from disk)", async () => {
    const port = await deadPort();
    const dir = tmpDir();
    const ob1 = makeOutbox(dir, port);
    await ob1.init();
    await ob1.submit(policyReq("10001"), 200);
    await ob1.submit(policyReq("10002"), 200);
    ob1.stop(); // app closed while offline

    const { server, state } = createServer();
    await listen(server, port);
    const ob2 = makeOutbox(dir, port); // app started again, network back
    await ob2.init();
    await until(() => ob2.getState().items.length === 0, 4000, "delivery after restart");
    eq(state.db.map((r) => r.BlancNumber), ["10001", "10002"]);
    ob2.stop();
    await close(server);
  });

  await check("crash mid-send: the reloaded entry is verified before re-sending", async () => {
    const { server, state } = createServer();
    const port = await listen(server);
    const dir = tmpDir();
    const ob1 = makeOutbox(dir, port);
    await ob1.init();
    ob1.stop(); // no delivery loop
    const item = await ob1.enqueue(policyReq("11001"));
    // The app died while sending; the server had already saved it.
    const metaFile = path.join(dir, `${item.id}.meta.json`);
    const meta = JSON.parse(fs.readFileSync(metaFile, "utf8"));
    meta.status = "sending";
    fs.writeFileSync(metaFile, JSON.stringify(meta));
    state.db.push({ BlancNumber: "11001", Author: "worker1" });

    const ob2 = makeOutbox(dir, port);
    await ob2.init();
    await until(() => ob2.getState().items.length === 0, 4000, "recovery");
    eq(state.posts, 0, "not re-posted");
    eq(state.db.length, 1);
    ob2.stop();
    await close(server);
  });

  await check("email policy stays 'sent' (no files) until the email is completed", async () => {
    const { server } = createServer();
    const port = await listen(server);
    const dir = tmpDir();
    const ob = makeOutbox(dir, port);
    await ob.init();
    const out = await ob.submit(policyReq("12001", { messageId: "gmail-abc" }), 2000);
    eq(out.status, "sent");
    const items = ob.getState().items;
    eq(items.length, 1);
    eq(items[0].status, "sent");
    eq(ob.getState().unsentCount, 0, "a delivered item is not counted as queued");
    await until(
      () => filesIn(dir).filter((n) => n.endsWith(".body.json")).length === 0,
      2000,
      "files freed after delivery"
    );
    ok(await ob.acknowledge(items[0].id));
    eq(ob.getState().items.length, 0);
    eq(filesIn(dir), []);
    ob.stop();
    await close(server);
  });

  await check("late delivery of a queued policy is reported (onDelivered)", async () => {
    const port = await deadPort();
    const delivered = [];
    const ob = makeOutbox(tmpDir(), port, {
      onDelivered: (item, result) => delivered.push({ label: item.label, result }),
    });
    await ob.init();
    await ob.submit(policyReq("13001"), 200);
    const { server } = createServer();
    await listen(server, port);
    await until(() => delivered.length === 1, 4000, "onDelivered");
    eq(delivered[0].label, "13001 · CA1234");
    eq(delivered[0].result.blancNumber, "13001");
    ob.stop();
    await close(server);
  });

  await check("public state never exposes the token or the body", async () => {
    const port = await deadPort();
    const ob = makeOutbox(tmpDir(), port);
    await ob.init();
    await ob.submit(policyReq("14001"), 200);
    const json = JSON.stringify(ob.getState());
    ok(!json.includes("tok-1"), "token leaked");
    ok(!json.includes("JVBERi0x"), "body leaked");
    ob.stop();
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
