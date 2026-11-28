"use strict";

// Node test for the autocomplete pool behind the insurance lookup filters.
//
// The pool prefers GET /insurances/suggestions, but must still work against an
// older server: it falls back to /brokers (both roles) and /admin/users
// (admins), and it learns authors/brokers from the rows of every search. This
// test loads the REAL helpers out of WorkPage.js in a vm with a fake `api`, so
// the fallback order and the merging rules are exercised without a browser.
//
// Run with:  node test/client/insuranceSuggestions.test.cjs   (or: npm test)

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..", "..");
const WORKPAGE_JS = path.join(ROOT, "renderer", "WorkPage", "WorkPage.js");

const src = fs.readFileSync(WORKPAGE_JS, "utf8");
const START = 'let insuranceSort = { key: null, dir: "desc" };';
const END = "\nasync function adminInsurancesByDate";
const start = src.indexOf(START);
const end = src.indexOf(END);
if (start < 0 || end < 0 || end <= start) {
  console.error(
    "Could not locate the insurance suggestion helpers in WorkPage.js (markers moved?)"
  );
  process.exit(1);
}

// A fresh vm per scenario: the suggestion pool is module state, so scenarios
// must not see each other's names.
function loadSuggestions(userRole, username, api) {
  // The fallback scenarios deliberately make the primary endpoint fail; keep
  // the expected `console.warn` calls out of the test output.
  const CTX = {
    console: { log: () => {}, warn: () => {}, error: console.error },
    userRole,
    username,
    api,
  };
  vm.createContext(CTX);
  vm.runInContext(
    src.slice(start, end) +
      "\n;globalThis.loadSuggestions = loadInsuranceFilterSuggestions;" +
      "globalThis.currentSuggestions = currentInsuranceSuggestions;" +
      "globalThis.mergeSuggestions = mergeInsuranceSuggestions;" +
      "globalThis.rememberRows = rememberInsuranceSuggestionsFromRows;",
    CTX,
    { filename: "WorkPage.js#insuranceSuggestions" }
  );
  return CTX;
}

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

(async () => {
  console.log("Insurance lookup — autocomplete suggestions");

  await check("the dedicated endpoint is used when it works", async () => {
    const calls = [];
    const ctx = loadSuggestions("2", "worker1", async (url) => {
      calls.push(url);
      return {
        authors: ["bob", "anna", "bob"],
        brokers: [{ Name: "Euroins", Code: "1.9" }],
      };
    });
    const data = await ctx.loadSuggestions();
    eq(calls, ["/insurances/suggestions"], "one request");
    eq(data.authors, ["anna", "bob", "worker1"], "deduplicated, sorted + the user");
    eq(data.brokers, [{ Name: "Euroins", Code: "1.9" }], "brokers");
  });

  await check("an older server falls back to brokers and admin users", async () => {
    const calls = [];
    const ctx = loadSuggestions("1", "admin1", async (url) => {
      calls.push(url);
      if (url === "/insurances/suggestions") throw new Error("404");
      if (url === "/brokers") {
        return { brokers: [{ Name: "Euroins", Code: "1.9" }] };
      }
      if (url === "/admin/users?includeDeleted=1") {
        return {
          users: [{ Username: "admin1" }, { Username: "worker1" }],
          deleted: [{ Username: "old-worker" }],
        };
      }
      throw new Error("unexpected " + url);
    });
    const data = await ctx.loadSuggestions();
    eq(
      calls,
      ["/insurances/suggestions", "/brokers", "/admin/users?includeDeleted=1"],
      "fallback order"
    );
    eq(
      data.authors,
      ["admin1", "old-worker", "worker1"],
      "authors from users + the signed-in account"
    );
    eq(data.brokers, [{ Name: "Euroins", Code: "1.9" }], "brokers");
  });

  await check("a worker never calls the admin-only users endpoint", async () => {
    const calls = [];
    const ctx = loadSuggestions("2", "worker1", async (url) => {
      calls.push(url);
      if (url === "/insurances/suggestions") throw new Error("404");
      if (url === "/brokers") {
        return { brokers: [{ Name: "Lesovo", Code: "4.2" }] };
      }
      throw new Error("unexpected " + url);
    });
    const data = await ctx.loadSuggestions();
    eq(calls, ["/insurances/suggestions", "/brokers"], "no users request");
    eq(data.authors, ["worker1"], "the signed-in user is always suggested");
    eq(data.brokers, [{ Name: "Lesovo", Code: "4.2" }], "brokers");
  });

  await check("search rows add authors and broker names for workers", async () => {
    const ctx = loadSuggestions("2", "worker1", async () => ({
      authors: [],
      brokers: [],
    }));
    await ctx.loadSuggestions();
    ctx.rememberRows([
      { Author: "colleague", Broker: "ГКПП Лесово", BrokerCode: "4.2" },
      { Author: "worker1", Broker: "Euroins", BrokerCode: "1.9" },
    ]);
    const data = ctx.currentSuggestions();
    eq(data.authors, ["colleague", "worker1"], "authors from the rows");
    ok(
      data.brokers.some((b) => b.Name === "ГКПП Лесово" && b.Code === "4.2"),
      "walk-in broker name and code"
    );
    ok(
      data.brokers.some((b) => b.Name === "Euroins" && b.Code === "1.9"),
      "email broker name and code"
    );
  });

  await check("a later code fills in a name first seen without one", async () => {
    const ctx = loadSuggestions("2", "worker1", async () => ({
      authors: [],
      brokers: [],
    }));
    ctx.mergeSuggestions([], [{ Name: "Lesovo", Code: "" }]);
    ctx.mergeSuggestions([], [{ Name: "Lesovo", Code: "4.2" }]);
    eq(
      ctx.currentSuggestions().brokers,
      [{ Name: "Lesovo", Code: "4.2" }],
      "the code is kept"
    );
  });

  await check("the pool is only loaded once per session", async () => {
    let calls = 0;
    const ctx = loadSuggestions("2", "worker1", async () => {
      calls++;
      return { authors: ["anna"], brokers: [] };
    });
    await ctx.loadSuggestions();
    await ctx.loadSuggestions();
    eq(calls, 1, "one request for two opens");
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
