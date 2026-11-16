"use strict";

// Node test for config.js - the single place that names the API host.
//
// Guards the contract the rest of the app relies on: the renderer URLs, the
// Content-Security-Policy, the outbox allow-list and the strings handed to the
// preload script all derive from API_DOMAIN, so the host is written down once.
//
// Run with:  node Test/apiConfig.test.cjs   (or: npm test)

const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");

let passed = 0;
let failed = 0;

async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log("  PASS  " + name);
  } catch (err) {
    failed++;
    console.log("  FAIL  " + name);
    console.log("        " + (err && err.message ? err.message : err));
  }
}

function eq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${label}: expected ${e}, got ${a}`);
}

function ok(cond, label) {
  if (!cond) throw new Error(`${label}: expected truthy, got ${cond}`);
}

(async () => {
  const {
    API_DOMAIN,
    API_BASE,
    WS_URL,
    DEV_ORIGINS,
    ALLOWED_API_ORIGINS,
    CONTENT_SECURITY_POLICY,
    RENDERER_ARGS,
    API,
  } = await import(pathToFileURL(path.join(__dirname, "..", "config.js")).href);

  await check("names bulsig.online and derives the API/WebSocket URLs", () => {
    eq(API_DOMAIN, "bulsig.online", "domain");
    eq(API_BASE, "https://bulsig.online", "api base");
    eq(WS_URL, "wss://bulsig.online/ws", "ws url");
    eq(API.apiBase, API_BASE, "API object api base");
    eq(API.wsUrl, WS_URL, "API object ws url");
    eq(API.domain, API_DOMAIN, "API object domain");
  });

  await check("CSP allows the API host, its socket origin and the dev server", () => {
    ok(
      CONTENT_SECURITY_POLICY.includes(
        "connect-src 'self' https://bulsig.online wss://bulsig.online"
      ),
      "api + ws origin"
    );
    for (const origin of DEV_ORIGINS) {
      ok(CONTENT_SECURITY_POLICY.includes(origin), `dev origin ${origin}`);
      ok(
        CONTENT_SECURITY_POLICY.includes(origin.replace(/^http:/, "ws:")),
        `dev socket ${origin}`
      );
    }
    ok(/default-src 'self'/.test(CONTENT_SECURITY_POLICY), "default-src kept");
    ok(!/hostingersite/.test(CONTENT_SECURITY_POLICY), "no stale host in the policy");
    ok(CONTENT_SECURITY_POLICY.endsWith(";"), "policy terminated");
  });

  await check("outbox allow-list and preload arguments follow the host", () => {
    eq(ALLOWED_API_ORIGINS, ["https://bulsig.online", ...DEV_ORIGINS], "allowed origins");
    eq(API.allowedOrigins, ALLOWED_API_ORIGINS, "API object allowed origins");
    eq(
      RENDERER_ARGS,
      ["--api-base=https://bulsig.online", "--ws-url=wss://bulsig.online/ws"],
      "renderer args"
    );
  });

  await check("main.js, preload.js and common.js consume the shared config", () => {
    const read = (rel) => fs.readFileSync(path.join(__dirname, "..", rel), "utf8");

    const main = read("main.js");
    ok(main.includes('from "./config.js"'), "main imports config.js");
    ok(main.includes("contentSecurityPolicy: API.csp"), "CSP built from config");
    ok(main.includes("additionalArguments: API.rendererArgs"), "renderer args passed");
    ok(main.includes("new Set(API.allowedOrigins)"), "outbox follows config");

    const preload = read(path.join("renderer", "preload.js"));
    ok(preload.includes('ArgValue("--api-base=")'), "preload reads --api-base");
    ok(preload.includes("WsUrl: WS_URL"), "preload exposes WsUrl");

    const common = read(path.join("renderer", "common.js"));
    ok(common.includes("BridgeConfig.ApiBase"), "renderer uses the bridge value");
    ok(!common.includes("hostingersite"), "no stale host hardcoded");
  });

  await check("config.js is the only source of the domain", () => {
    const sources = [
      "main.js",
      "outbox.js",
      "bulins.js",
      "scans.js",
      path.join("renderer", "common.js"),
      path.join("renderer", "preload.js"),
      path.join("renderer", "diag.js"),
      path.join("renderer", "netMonitor.js"),
      path.join("renderer", "LoginPage", "logic.js"),
      path.join("renderer", "WorkPage", "WorkPage.js"),
    ];
    for (const rel of sources) {
      const text = fs.readFileSync(path.join(__dirname, "..", rel), "utf8");
      const hits = (text.match(/bulsig\.online/g) || []).length;
      const allowed = rel.endsWith("common.js") ? 2 : 0; // fallback constants only
      if (hits > allowed) {
        throw new Error(`${rel}: ${hits} hardcoded host(s), expected at most ${allowed}`);
      }
    }
  });

  if (failed > 0) {
    console.error(`\n${passed} passed, ${failed} failed`);
    process.exit(1);
  }
  console.log(`\n${passed} passed, ${failed} failed`);
})();
