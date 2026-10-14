"use strict";

// Node test for the broker email-card filter (InsuranceServer/Mail/brokerSenders.js).
//
// An email is only shown as a card when its sender is a known broker AND, when
// the admin has disabled negative-balance broker requests, the broker's balance
// is not negative.
//
// Run with:  node Test/brokerSenders.test.cjs   (or: npm test)

const fs = require("fs");
const vm = require("vm");
const { serverFile } = require("./serverPath.cjs");

const BROKER_SENDERS_JS = serverFile("Mail", "brokerSenders.js");

// The setting returned by the stubbed getBrokerAllowNegativeBalance helper.
let allowNegativeBalance = false;
// brokerId -> CashBalance for the stubbed balance lookup.
const balances = {};

const STUBS = {
  "../db/BrokerInfo.js": {
    BrokerData: { Alpha: ["alpha@example.com"] },
  },
  "./branchRouting.js": {
    extractAddress: (from) => {
      const text = String(from || "");
      const m = text.match(/<([^>]+)>/);
      return (m ? m[1] : text).trim().toLowerCase();
    },
  },
  "../Requests/Brokers.js": {
    resolveBrokerByEmail: async (conn, email) => {
      if (email === "alpha@example.com") return { id: 1, name: "Alpha" };
      return null;
    },
    getBrokerAllowNegativeBalance: async () => allowNegativeBalance,
  },
};

const fakeDb = {
  query: async (sql, params) => {
    const s = String(sql);
    if (s.startsWith("SELECT CashBalance FROM brokers WHERE id = ?")) {
      return [[{ CashBalance: balances[params[0]] ?? 0 }]];
    }
    throw new Error("unexpected SQL in test: " + s);
  },
};

const mod = { exports: {} };
const CTX = { console, module: mod, exports: mod.exports, Buffer, process };
CTX.require = (id) => {
  if (!Object.prototype.hasOwnProperty.call(STUBS, id)) {
    throw new Error("unexpected require in brokerSenders.js: " + id);
  }
  return STUBS[id];
};
vm.createContext(CTX);
vm.runInContext(fs.readFileSync(BROKER_SENDERS_JS, "utf8"), CTX, {
  filename: "Mail/brokerSenders.js",
});
const M = mod.exports;
M.setDb(fakeDb);

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
  if (a !== b) throw new Error(`${msg}: expected ${b}, got ${a}`);
}

(async () => {
  console.log("Broker email-card filter");

  await check("an unknown sender is hidden", async () => {
    eq(await M.shouldShowBrokerEmail("stranger@example.com"), false, "unknown");
  });

  await check("a known broker with a positive balance is shown", async () => {
    allowNegativeBalance = false;
    balances[1] = 10;
    eq(
      await M.shouldShowBrokerEmail("Alpha <alpha@example.com>"),
      true,
      "shown"
    );
  });

  await check("toggle off hides an email from a negative-balance broker", async () => {
    allowNegativeBalance = false;
    balances[1] = -5;
    eq(await M.shouldShowBrokerEmail("alpha@example.com"), false, "hidden");
  });

  await check("toggle on shows an email from a negative-balance broker", async () => {
    allowNegativeBalance = true;
    balances[1] = -5;
    eq(await M.shouldShowBrokerEmail("alpha@example.com"), true, "shown");
  });

  await check("a zero balance is not negative, so it is shown", async () => {
    allowNegativeBalance = false;
    balances[1] = 0;
    eq(await M.shouldShowBrokerEmail("alpha@example.com"), true, "shown");
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
