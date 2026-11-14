"use strict";

// Node test for the reachability monitor (renderer/netMonitor.js).
//
// The monitor decides what the worker is told about their connection while a
// login is running, so its verdicts matter: on a jittery link /ping answers
// slowly and fails now and then while the server is in fact serving requests -
// and logging people in. Calling that "Offline" is what makes a successful
// login look like a refused one, so:
//   * a slow answer is "slow", not "offline";
//   * a single failed probe keeps the previous verdict;
//   * only `offlineAfterFailures` consecutive failures turn it red;
//   * the next success clears the outage.
//
// Runs the REAL renderer file in a vm with a stub fetch, the same approach as
// the other renderer tests.
//
// Run with:  node Test/netMonitor.test.cjs   (or: npm test)

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const NET_MONITOR = path.join(__dirname, "..", "renderer", "netMonitor.js");

function log(line) {
  fs.writeSync(1, line + "\n");
}

let passed = 0;
let failed = 0;
function check(name, fn) {
  return (async () => {
    try {
      await fn();
      passed++;
      log("  PASS  " + name);
    } catch (err) {
      failed++;
      log("  FAIL  " + name);
      log("        " + (err && err.message ? err.message : err));
    }
  })();
}
function eq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${label}: expected ${e}, got ${a}`);
}
function ok(value, label) {
  if (!value) throw new Error(label || "expected a truthy value");
}
function settle() {
  return new Promise((resolve) => setImmediate(resolve));
}
async function settleDeep() {
  for (let i = 0; i < 8; i++) await settle();
}

// One monitor instance over a queue of answers. `answers` are functions
// returning the promise for one /ping.
function createMonitor(answers, options = {}) {
  const requests = [];
  const ctx = {
    API_BASE: "https://example.test",
    console: { log() {}, warn() {}, error() {}, info() {} },
    AbortController,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    fetch(url) {
      requests.push(String(url));
      const next = answers.shift();
      if (!next) throw new Error("no answer queued for this probe");
      return next();
    },
    addEventListener() {},
    removeEventListener() {},
    document: {
      visibilityState: "visible",
      addEventListener() {},
      removeEventListener() {},
    },
  };
  ctx.window = ctx;

  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(NET_MONITOR, "utf8"), ctx, {
    filename: "renderer/netMonitor.js",
  });
  const monitor = vm.runInContext(
    "startNetMonitor(" +
      JSON.stringify({
        apiBase: "https://example.test",
        // Long interval: every probe in this test is driven by hand.
        intervalMs: 10 * 60 * 1000,
        timeoutMs: 2000,
        slowMs: options.slowMs !== undefined ? options.slowMs : 4000,
      }) +
      ")",
    ctx
  );
  return { monitor, requests };
}

const ANSWER = {
  ok: () => Promise.resolve({ ok: true, status: 200 }),
  slow: () =>
    new Promise((resolve) => setTimeout(() => resolve({ ok: true, status: 200 }), 5)),
  fail: () => Promise.reject(new TypeError("Failed to fetch")),
  timeout: () =>
    new Promise((_, reject) => {
      const err = new Error("aborted");
      err.name = "AbortError";
      reject(err);
    }),
};


async function main() {
  log("Insurance — network monitor");

  await check("the first probe reports the server as reachable", async () => {
    const { monitor, requests } = createMonitor([ANSWER.ok]);
    await settleDeep();
    eq(monitor.getState().status, "online", "status");
    eq(monitor.getState().consecutiveFailures, 0, "no failures");
    ok(requests[0].endsWith("/ping"), "the probe hits /ping");
    monitor.stop();
  });

  await check("a slow answer is reported as slow, not as an outage", async () => {
    const { monitor } = createMonitor([ANSWER.slow], { slowMs: 1 });
    await new Promise((resolve) => setTimeout(resolve, 25)); // let the 5 ms body land
    await settleDeep();
    const state = monitor.getState();
    eq(state.status, "online", "still online");
    eq(state.slow, true, "flagged as slow");
    ok(state.latencyMs >= 5, `latency measured (${state.latencyMs})`);
    monitor.stop();
  });

  await check("one failed probe does not turn a working link red", async () => {
    const { monitor } = createMonitor([ANSWER.ok, ANSWER.fail]);
    await settleDeep();
    eq(monitor.getState().status, "online", "online after the first probe");

    await monitor.check();
    await settleDeep();
    const state = monitor.getState();
    eq(state.status, "online", "the previous verdict is kept");
    eq(state.consecutiveFailures, 1, "the failure is counted");
    eq(state.lastError, "Failed to fetch", "the reason is kept");
    monitor.stop();
  });

  await check("two failures in a row mean the server is unreachable", async () => {
    const { monitor } = createMonitor([ANSWER.ok, ANSWER.fail, ANSWER.timeout]);
    await settleDeep();
    await monitor.check();
    await settleDeep();
    eq(monitor.getState().status, "online", "still online after one failure");

    await monitor.check();
    await settleDeep();
    const state = monitor.getState();
    eq(state.status, "offline", "offline after two");
    eq(state.consecutiveFailures, 2, "two failures");
    eq(state.lastError, "timeout", "a timeout is named as such");
    monitor.stop();
  });

  await check("a success clears the outage and the counter", async () => {
    const { monitor } = createMonitor([ANSWER.fail, ANSWER.fail, ANSWER.ok]);
    await settleDeep();
    await monitor.check();
    await settleDeep();
    eq(monitor.getState().status, "offline", "offline first");

    await monitor.check();
    await settleDeep();
    const state = monitor.getState();
    eq(state.status, "online", "back online");
    eq(state.consecutiveFailures, 0, "counter cleared");
    eq(state.slow, false, "not slow");
    monitor.stop();
  });

  log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main();
