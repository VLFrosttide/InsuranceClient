"use strict";

// Node test for the TWO RECORDS OF CASH FLOW: current cash and total cash.
//
// Current cash is only the cash balance. Total cash is a strict superset of it:
// every type of payment (cash money, card payments and payments funded from a
// broker's balance) is counted in it. Total cash is NOT stored as an independent
// running total - `total_cash` holds only the CardPart and BrokerPart columns
// and the total is computed on every read as
//
//     TotalCash(branch, currency) = current_cash.CurrentCash
//                                 + total_cash.CardPart
//                                 + total_cash.BrokerPart
//
// Because the cash part is read live from `current_cash`, resetting the drawer -
// or clearing the card balance, which zeroes every CardPart - drags Total cash
// down with it. That identity is what this test pins down.
//
// It loads the REAL server modules (InsuranceServer/Requests/CurrentCash.js and
// InsuranceServer/Requests/CardPayments.js, see Test/serverPath.cjs) in a vm
// against an in-memory fake MySQL, so
// the assertions are about the balances the real SQL actually produces.
//
// Run with:  node Test/insuranceTotalCash.test.cjs   (or: npm test)

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const { serverFile } = require("./serverPath.cjs");
const CURRENCIES = ["EUR", "USD", "TRY"];

const round = (n) => Math.round(Number(n) * 100) / 100;
const ck = (branch, currency) => `${String(branch || "")}|${currency}`;

// --- in-memory fake MySQL ----------------------------------------------------
// Only the statements the cash modules issue are understood. Anything else is a
// hard error, so a changed query cannot silently slip through the test.
const tables = {
  current_cash: new Map(), // "branch|currency" -> number
  total_cash: new Map(), // "branch|currency" -> { CardPart, BrokerPart }
  cash_transactions: [],
  total_cash_transactions: [],
  cash_resets: [],
  card_resets: [],
  branch_card_balance: new Map(), // branch -> number
};
const cardOf = (branch) => tables.branch_card_balance.get(String(branch || "")) || 0;

function ensureCash(branch, currency) {
  const k = ck(branch, currency);
  if (!tables.current_cash.has(k)) tables.current_cash.set(k, 0);
}
function ensureTotal(branch, currency) {
  const k = ck(branch, currency);
  if (!tables.total_cash.has(k)) {
    tables.total_cash.set(k, { CardPart: 0, BrokerPart: 0 });
  }
}

const sqlLog = [];

async function query(sql, params = []) {
  const s = String(sql).replace(/\s+/g, " ").trim();
  sqlLog.push(s);
  const p = params || [];

  // --- current_cash ---------------------------------------------------------
  if (s.startsWith("INSERT IGNORE INTO current_cash")) {
    ensureCash(p[1], p[2]);
    return [[]];
  }
  if (s.startsWith("SELECT Currency, CurrentCash FROM current_cash")) {
    const rows = [];
    for (const cur of CURRENCIES) {
      const k = ck(p[1], cur);
      if (tables.current_cash.has(k)) {
        rows.push({ Currency: cur, CurrentCash: tables.current_cash.get(k) });
      }
    }
    return [rows];
  }
  if (s.startsWith("SELECT CurrentCash FROM current_cash")) {
    const k = ck(p[1], p[2]);
    return [
      [
        {
          CurrentCash: tables.current_cash.has(k)
            ? tables.current_cash.get(k)
            : 0,
        },
      ],
    ];
  }
  if (s.startsWith("UPDATE current_cash SET CurrentCash = CurrentCash + ?")) {
    ensureCash(p[2], p[3]);
    const k = ck(p[2], p[3]);
    tables.current_cash.set(k, round(tables.current_cash.get(k) + Number(p[0])));
    return [{ affectedRows: 1 }];
  }
  if (s.startsWith("UPDATE current_cash SET CurrentCash = CurrentCash - ?")) {
    ensureCash(p[2], p[3]);
    const k = ck(p[2], p[3]);
    tables.current_cash.set(k, round(tables.current_cash.get(k) - Number(p[0])));
    return [{ affectedRows: 1 }];
  }
  if (s.startsWith("UPDATE current_cash SET CurrentCash = 0")) {
    for (const cur of CURRENCIES) {
      const k = ck(p[1], cur);
      if (tables.current_cash.has(k)) tables.current_cash.set(k, 0);
    }
    return [{ affectedRows: 1 }];
  }
  if (s.startsWith("INSERT INTO cash_transactions")) {
    tables.cash_transactions.push({
      Branch: p[0],
      Type: p[1],
      Amount: p[2],
      Currency: p[3],
      Username: p[4],
      Reason: p[5],
    });
    return [{ insertId: tables.cash_transactions.length }];
  }
  if (s.startsWith("INSERT INTO cash_resets")) {
    tables.cash_resets.push({
      Branch: p[0],
      Username: p[1],
      Currency: p[2],
      KeptAmount: p[3],
    });
    return [{ insertId: tables.cash_resets.length }];
  }

  // --- total_cash -----------------------------------------------------------
  if (s.startsWith("INSERT IGNORE INTO total_cash")) {
    ensureTotal(p[1], p[2]);
    return [[]];
  }
  if (s.startsWith("SELECT Currency, CardPart, BrokerPart FROM total_cash")) {
    const rows = [];
    for (const cur of CURRENCIES) {
      const k = ck(p[1], cur);
      if (tables.total_cash.has(k)) {
        rows.push(Object.assign({ Currency: cur }, tables.total_cash.get(k)));
      }
    }
    return [rows];
  }
  const partMatch = s.match(
    /^UPDATE total_cash SET (CardPart|BrokerPart) = (CardPart|BrokerPart) \+ \? WHERE/
  );
  if (partMatch && partMatch[1] === partMatch[2]) {
    ensureTotal(p[2], p[3]);
    const row = tables.total_cash.get(ck(p[2], p[3]));
    row[partMatch[1]] = round(row[partMatch[1]] + Number(p[0]));
    return [{ affectedRows: 1 }];
  }
  if (s.startsWith("SELECT Branch, Currency, CardPart FROM total_cash")) {
    const rows = [];
    for (const [k, row] of tables.total_cash) {
      if (row.CardPart !== 0) {
        const bits = k.split("|");
        rows.push({ Branch: bits[0], Currency: bits[1], CardPart: row.CardPart });
      }
    }
    return [rows];
  }
  if (s.startsWith("SELECT Currency, CardPart FROM total_cash WHERE id = ? AND Branch = ? AND CardPart != 0")) {
    const rows = [];
    for (const cur of CURRENCIES) {
      const row = tables.total_cash.get(ck(p[1], cur));
      if (row && row.CardPart !== 0) rows.push({ Currency: cur, CardPart: row.CardPart });
    }
    return [rows];
  }
  if (s.startsWith("UPDATE total_cash SET CardPart = 0 WHERE id = ? AND Branch = ?")) {
    for (const cur of CURRENCIES) {
      const row = tables.total_cash.get(ck(p[1], cur));
      if (row) row.CardPart = 0;
    }
    return [{ affectedRows: 1 }];
  }
  if (s.startsWith("INSERT INTO total_cash_transactions")) {
    tables.total_cash_transactions.push({
      Branch: p[0],
      Type: p[1],
      Amount: p[2],
      Currency: p[3],
      Source: p[4],
      Username: p[5],
      Reason: p[6],
    });
    return [{ insertId: tables.total_cash_transactions.length }];
  }

  // --- branch_card_balance (card balance per branch) -------------------------
  if (s.includes("CardBalance FROM CardBalance") || s.includes("INTO CardBalance") ||
      s.startsWith("UPDATE CardBalance")) {
    throw new Error("the legacy global CardBalance must not be used: " + s);
  }
  if (s.startsWith("INSERT IGNORE INTO branch_card_balance")) {
    if (!tables.branch_card_balance.has(p[0])) tables.branch_card_balance.set(p[0], 0);
    return [[]];
  }
  if (s.startsWith("SELECT CardBalance FROM branch_card_balance WHERE Branch = ?")) {
    return [tables.branch_card_balance.has(p[0])
      ? [{ CardBalance: tables.branch_card_balance.get(p[0]) }]
      : []];
  }
  if (s.startsWith("SELECT Branch, CardBalance FROM branch_card_balance")) {
    return [[...tables.branch_card_balance.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([Branch, CardBalance]) => ({ Branch, CardBalance }))];
  }
  if (s.startsWith("UPDATE branch_card_balance SET CardBalance = CardBalance + ? WHERE Branch = ?")) {
    tables.branch_card_balance.set(p[1], round(cardOf(p[1]) + Number(p[0])));
    return [{ affectedRows: 1 }];
  }
  if (s.startsWith("UPDATE branch_card_balance SET CardBalance = 0 WHERE Branch = ?")) {
    tables.branch_card_balance.set(p[0], 0);
    return [{ affectedRows: 1 }];
  }
  if (s.startsWith("INSERT INTO card_resets (Branch, Username, KeptAmount)")) {
    tables.card_resets.push({ Branch: p[0], Username: p[1], KeptAmount: p[2] });
    return [{ insertId: tables.card_resets.length }];
  }

  throw new Error("fake DB: unhandled SQL -> " + s);
}

const fakeDb = {
  query,
  withTransaction: async (fn) => fn(fakeDb),
};

// --- load the real modules in a vm -------------------------------------------
const fakeRouter = {
  get: () => {},
  post: () => {},
  put: () => {},
  patch: () => {},
  delete: () => {},
  use: () => {},
};
const AUTH_STUB = {
  requireAuth: () => (req, res, next) => next(),
  requireRole: () => (req, res, next) => next(),
  extractToken: () => "",
};

function loadModule(file, extraStubs) {
  const mod = { exports: {} };
  const CTX = { console, module: mod, exports: mod.exports, Buffer, process };
  const stubs = Object.assign(
    {
      express: new Proxy(
        {},
        {
          get(_t, prop) {
            if (prop === "Router") return () => fakeRouter;
            return () => (req, res, next) => (next ? next() : undefined);
          },
        }
      ),
      "./Auth.js": AUTH_STUB,
    },
    extraStubs || {}
  );
  CTX.require = (id) => {
    if (!Object.prototype.hasOwnProperty.call(stubs, id)) {
      throw new Error(`unexpected require in ${file}: ` + id);
    }
    return stubs[id];
  };
  vm.createContext(CTX);
  vm.runInContext(fs.readFileSync(serverFile("Requests", file), "utf8"), CTX, {
    filename: file,
  });
  return mod.exports;
}

// CardPayments is loaded with the REAL CurrentCash exports, so card payments
// really go through the per-branch card balance helpers.
const CC = loadModule("CurrentCash.js");
const CP = loadModule("CardPayments.js", { "./CurrentCash.js": CC });

for (const [name, mod] of [
  ["CurrentCash", CC],
  ["CardPayments", CP],
]) {
  if (!mod || typeof mod !== "object") {
    console.error(`${name} module did not load - server file changed?`);
    process.exit(1);
  }
}

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
  if (a !== b) {
    throw new Error((msg || "values differ") + ` (got ${a}, want ${b})`);
  }
}
function ok(cond, msg) {
  if (!cond) throw new Error(msg || "expected truthy");
}

function resetTables() {
  tables.current_cash.clear();
  tables.total_cash.clear();
  tables.cash_transactions.length = 0;
  tables.total_cash_transactions.length = 0;
  tables.cash_resets.length = 0;
  tables.card_resets.length = 0;
  tables.branch_card_balance.clear();
  sqlLog.length = 0;
}

const BRANCH = "ÐžÑ„Ð¸Ñ Ð¥Ð°Ñ€Ð¼Ð°Ð½Ð»Ð¸";
const OTHER = "Ð“ÐšÐŸÐŸ Ð›ÐµÑÐ¾Ð²Ð¾";
const USER = "admin1";

// The identity the whole design rests on: Total cash is current cash plus the
// two stored parts, and a branch's card part accounts for exactly that
// branch's card balance.
async function assertSuperset(msg, branch = BRANCH) {
  const totals = await CC.getTotalCash(fakeDb, branch);
  const cash = await CC.getCurrentCash(fakeDb, branch);
  const parts = await CC.getTotalParts(fakeDb, branch);
  for (const cur of CURRENCIES) {
    const want = round(cash[cur] + parts[cur].CardPart + parts[cur].BrokerPart);
    eq(totals[cur], want, `${msg}: TotalCash[${cur}]`);
  }
  const cardSum = round(
    CURRENCIES.reduce((sum, cur) => sum + parts[cur].CardPart, 0)
  );
  eq(cardSum, round(cardOf(branch)), `${msg}: sum(CardPart) == branch card balance`);
}

// A card payment as TierEndpoints.movePolicyMoney records it: the branch's
// card balance + the branch's Card part of Total cash.
async function payByCard(branch, amount, reason) {
  await CP.recordCardPayment(fakeDb, branch, USER, amount, reason);
  await CC.recordChannelMovement(
    fakeDb, branch, USER, "increase", amount, reason, "EUR", "Card"
  );
}

const ledger = () =>
  tables.total_cash_transactions.map(
    (r) => `${r.Source} ${r.Type} ${r.Amount} ${r.Currency} @ ${r.Branch}`
  );

(async () => {
  console.log("Total cash â€” the second record of cash flow");

  await check("a fresh branch has zero current cash and zero total cash", async () => {
    resetTables();
    eq(
      await CC.getCurrentCash(fakeDb, BRANCH),
      { EUR: 0, USD: 0, TRY: 0 },
      "current cash"
    );
    eq(
      await CC.getTotalCash(fakeDb, BRANCH),
      { EUR: 0, USD: 0, TRY: 0 },
      "total cash"
    );
    await assertSuperset("fresh branch");
  });

  await check("cash money raises current cash AND total cash", async () => {
    resetTables();
    await CC.recordCashMovement(
      fakeDb,
      BRANCH,
      USER,
      "increase",
      50,
      "1234567",
      "EUR"
    );
    eq((await CC.getCurrentCash(fakeDb, BRANCH)).EUR, 50, "current cash");
    eq((await CC.getTotalCash(fakeDb, BRANCH)).EUR, 50, "total cash");
    eq(
      ledger(),
      ["Cash increase 50 EUR @ ÐžÑ„Ð¸Ñ Ð¥Ð°Ñ€Ð¼Ð°Ð½Ð»Ð¸"],
      "total cash ledger"
    );
    await assertSuperset("after a cash payment");
  });

  await check(
    "a broker-balance payment raises total cash but NOT current cash",
    async () => {
      resetTables();
      await CC.recordChannelMovement(
        fakeDb,
        BRANCH,
        USER,
        "increase",
        100,
        "1234567",
        "EUR",
        "Broker"
      );
      eq((await CC.getCurrentCash(fakeDb, BRANCH)).EUR, 0, "drawer untouched");
      eq((await CC.getTotalCash(fakeDb, BRANCH)).EUR, 100, "total cash counts it");
      eq(
        (await CC.getTotalParts(fakeDb, BRANCH)).EUR,
        { CardPart: 0, BrokerPart: 100 },
        "stored in BrokerPart"
      );
      eq(
        ledger(),
        ["Broker increase 100 EUR @ ÐžÑ„Ð¸Ñ Ð¥Ð°Ñ€Ð¼Ð°Ð½Ð»Ð¸"],
        "total cash ledger"
      );
      eq(
        tables.cash_transactions.length,
        0,
        "no entry in the current cash ledger"
      );
      await assertSuperset("after a broker payment");
    }
  );

  await check(
    "a card payment raises the card balance and total cash, not current cash",
    async () => {
      resetTables();
      await payByCard(BRANCH, 70, "1234567");
      eq(cardOf(BRANCH), 70, "the branch's card balance");
      eq((await CC.getCurrentCash(fakeDb, BRANCH)).EUR, 0, "drawer untouched");
      eq((await CC.getTotalCash(fakeDb, BRANCH)).EUR, 70, "total cash counts it");
      await assertSuperset("after a card payment");
    }
  );

  await check("all three payment types add up in total cash", async () => {
    resetTables();
    await CC.recordCashMovement(fakeDb, BRANCH, USER, "increase", 50, "A", "EUR");
    await payByCard(BRANCH, 70, "B");
    await CC.recordChannelMovement(
      fakeDb,
      BRANCH,
      USER,
      "increase",
      100,
      "C",
      "EUR",
      "Broker"
    );
    eq(
      (await CC.getCurrentCash(fakeDb, BRANCH)).EUR,
      50,
      "current cash = cash money only"
    );
    eq(
      (await CC.getTotalCash(fakeDb, BRANCH)).EUR,
      220,
      "total cash = all three types"
    );
    await assertSuperset("all three types");
  });

  await check("per-currency totals stay separate", async () => {
    resetTables();
    await CC.recordCashMovement(fakeDb, BRANCH, USER, "increase", 10, "A", "EUR");
    await CC.recordChannelMovement(
      fakeDb,
      BRANCH,
      USER,
      "increase",
      20,
      "B",
      "USD",
      "Broker"
    );
    eq(
      await CC.getTotalCash(fakeDb, BRANCH),
      { EUR: 10, USD: 20, TRY: 0 },
      "total cash per currency"
    );
    await assertSuperset("multi-currency");
  });

  await check("per-branch totals stay separate", async () => {
    resetTables();
    await CC.recordCashMovement(fakeDb, BRANCH, USER, "increase", 10, "A", "EUR");
    await CC.recordChannelMovement(
      fakeDb,
      "Ð“ÐšÐŸÐŸ Ð›ÐµÑÐ¾Ð²Ð¾",
      USER,
      "increase",
      20,
      "B",
      "EUR",
      "Broker"
    );
    eq((await CC.getTotalCash(fakeDb, BRANCH)).EUR, 10, "branch A");
    eq((await CC.getTotalCash(fakeDb, "Ð“ÐšÐŸÐŸ Ð›ÐµÑÐ¾Ð²Ð¾")).EUR, 20, "branch B");
  });

  await check("resetting current cash drags total cash down with it", async () => {
    resetTables();
    await CC.recordCashMovement(fakeDb, BRANCH, USER, "increase", 50, "A", "EUR");
    await CC.recordChannelMovement(
      fakeDb,
      BRANCH,
      USER,
      "increase",
      100,
      "B",
      "EUR",
      "Broker"
    );
    eq((await CC.getTotalCash(fakeDb, BRANCH)).EUR, 150, "before the reset");

    const kept = await CC.resetCurrentCash(fakeDb, BRANCH, USER);
    eq(kept.EUR, 50, "kept amount");
    eq((await CC.getCurrentCash(fakeDb, BRANCH)).EUR, 0, "drawer zeroed");
    eq(
      (await CC.getTotalCash(fakeDb, BRANCH)).EUR,
      100,
      "only the broker part survives"
    );
    ok(
      ledger().includes("Cash reduce 50 EUR @ ÐžÑ„Ð¸Ñ Ð¥Ð°Ñ€Ð¼Ð°Ð½Ð»Ð¸"),
      "the reset is recorded in the total cash ledger"
    );
    await assertSuperset("after a current cash reset");
  });

  await check("card payments are kept per branch", async () => {
    resetTables();
    await payByCard(BRANCH, 70, "A");
    await payByCard(OTHER, 30, "B");
    eq(cardOf(BRANCH), 70, "branch A");
    eq(cardOf(OTHER), 30, "branch B");
    const all = await CP.getCardPayments(fakeDb);
    eq(all.total, 100, "overview total");
    eq(all.branches.length, 2, "one row per branch");
    await assertSuperset("branch A", BRANCH);
    await assertSuperset("branch B", OTHER);
  });

  await check("Reset to 0 clears the branch's cash AND card balance", async () => {
    resetTables();
    await CC.recordCashMovement(fakeDb, BRANCH, USER, "increase", 50, "A", "EUR");
    await payByCard(BRANCH, 70, "B");
    await CC.recordChannelMovement(
      fakeDb, BRANCH, USER, "increase", 100, "C", "EUR", "Broker"
    );
    eq((await CC.getTotalCash(fakeDb, BRANCH)).EUR, 220, "before the reset");

    const kept = await CC.resetBranch(fakeDb, BRANCH, USER);
    eq(kept.cash.EUR, 50, "cash kept");
    eq(kept.card, 70, "card kept");
    eq((await CC.getCurrentCash(fakeDb, BRANCH)).EUR, 0, "drawer zeroed");
    eq(cardOf(BRANCH), 0, "card balance zeroed");
    eq(
      (await CC.getTotalParts(fakeDb, BRANCH)).EUR,
      { CardPart: 0, BrokerPart: 100 },
      "CardPart zeroed, BrokerPart untouched"
    );
    eq((await CC.getTotalCash(fakeDb, BRANCH)).EUR, 100, "only the broker part survives");
    eq(
      tables.card_resets,
      [{ Branch: BRANCH, Username: USER, KeptAmount: 70 }],
      "card reset recorded with its branch"
    );
    ok(
      ledger().includes("Card reduce 70 EUR @ ÐžÑ„Ð¸Ñ Ð¥Ð°Ñ€Ð¼Ð°Ð½Ð»Ð¸"),
      "the card clear is in the total cash ledger"
    );
    await assertSuperset("after Reset to 0");
  });

  await check("Reset to 0 never touches another branch", async () => {
    resetTables();
    await CC.recordCashMovement(fakeDb, OTHER, USER, "increase", 40, "A", "EUR");
    await payByCard(BRANCH, 70, "B");
    await payByCard(OTHER, 30, "C");

    await CC.resetBranch(fakeDb, BRANCH, USER);
    eq(cardOf(BRANCH), 0, "own card cleared");
    eq(cardOf(OTHER), 30, "other branch's card kept");
    eq((await CC.getCurrentCash(fakeDb, OTHER)).EUR, 40, "other branch's cash kept");
    eq((await CC.getTotalParts(fakeDb, OTHER)).EUR.CardPart, 30, "other CardPart kept");
    await assertSuperset("other branch", OTHER);
  });

  await check("a card refund comes out of the policy's own branch", async () => {
    resetTables();
    await payByCard(BRANCH, 70, "A");
    await payByCard(OTHER, 30, "B");
    await CP.reduceCardBalance(fakeDb, OTHER, USER, 20, "Annul B");
    eq(cardOf(BRANCH), 70, "branch A untouched");
    eq(cardOf(OTHER), 10, "branch B refunded");
  });

  await check("the card overview is read-only and admin-only", async () => {
    const routes = [];
    const roles = [];
    const router = Object.assign({}, fakeRouter, {
      get: (p, ...h) => routes.push({ method: "get", path: p }),
      post: (p, ...h) => routes.push({ method: "post", path: p }),
    });
    const RouterCP = loadModule("CardPayments.js", {
      "./CurrentCash.js": CC,
      express: { Router: () => router },
      "./Auth.js": {
        requireAuth: () => () => {},
        requireRole: (...r) => {
          roles.push(r.map(String));
          return () => {};
        },
      },
    });
    RouterCP.createCardPaymentsRouter(fakeDb);
    eq(routes, [{ method: "get", path: "/cardpayments" }], "only the overview route");
    eq(roles, [["1"]], "admins only");
    ok(!RouterCP.resetCardBalance, "no separate card clear is exported");
  });

  await check("reversing a broker payment takes it back out of total cash", async () => {
    resetTables();
    await CC.recordChannelMovement(
      fakeDb,
      BRANCH,
      USER,
      "increase",
      100,
      "A",
      "EUR",
      "Broker"
    );
    await CC.recordChannelMovement(
      fakeDb,
      BRANCH,
      USER,
      "reduce",
      100,
      "Annul A",
      "EUR",
      "Broker"
    );
    eq((await CC.getTotalCash(fakeDb, BRANCH)).EUR, 0, "total cash back to zero");
    eq((await CC.getCurrentCash(fakeDb, BRANCH)).EUR, 0, "the drawer never moved");
    await assertSuperset("after a reversal");
  });

  await check("a reversal may drive a part negative instead of failing", async () => {
    resetTables();
    // The branch was reset after the payment was taken, so the part is already 0.
    // Reversing must still work - it is never blocked by availability.
    await CC.recordChannelMovement(
      fakeDb,
      BRANCH,
      USER,
      "reduce",
      40,
      "Annul A",
      "EUR",
      "Broker"
    );
    eq(
      (await CC.getTotalParts(fakeDb, BRANCH)).EUR.BrokerPart,
      -40,
      "the part goes negative"
    );
    eq((await CC.getTotalCash(fakeDb, BRANCH)).EUR, -40, "total cash follows");
  });

  await check("the channel helpers reject bad input", async () => {
    resetTables();
    let threw = null;
    try {
      await CC.recordChannelMovement(
        fakeDb,
        BRANCH,
        USER,
        "increase",
        10,
        "A",
        "EUR",
        "Cash"
      );
    } catch (err) {
      threw = err.message;
    }
    eq(threw, "source must be 'Card' or 'Broker'", "Cash is not a channel here");

    threw = null;
    try {
      await CC.recordChannelMovement(
        fakeDb,
        BRANCH,
        USER,
        "increase",
        0,
        "A",
        "EUR",
        "Card"
      );
    } catch (err) {
      threw = err.message;
    }
    eq(threw, "amount must be a positive number", "zero is not a payment");

    threw = null;
    try {
      await CC.recordChannelMovement(
        fakeDb,
        BRANCH,
        USER,
        "increase",
        10,
        "   ",
        "EUR",
        "Card"
      );
    } catch (err) {
      threw = err.message;
    }
    eq(threw, "reason is required", "a movement needs a reason");

    eq(tables.total_cash_transactions.length, 0, "nothing was recorded");
  });

  await check("every cash movement also appears in the total cash ledger", async () => {
    resetTables();
    await CC.recordCashMovement(fakeDb, BRANCH, USER, "increase", 25, "top-up", "TRY");
    await CC.recordCashMovement(fakeDb, BRANCH, USER, "reduce", 5, "payout", "TRY");
    eq(
      ledger(),
      [
        "Cash increase 25 TRY @ ÐžÑ„Ð¸Ñ Ð¥Ð°Ñ€Ð¼Ð°Ð½Ð»Ð¸",
        "Cash reduce 5 TRY @ ÐžÑ„Ð¸Ñ Ð¥Ð°Ñ€Ð¼Ð°Ð½Ð»Ð¸",
      ],
      "the two records list the same movements"
    );
    eq(tables.cash_transactions.length, 2, "and so does the current cash ledger");
    await assertSuperset("after cash in and out");
  });

  // --- transaction history by day (one day at a time, default today) --------
  console.log("\nCurrent cash history â€” one day at a time");
  // 2026-10-10 01:30 UTC is already 04:30 on the 10th in UTC+3, but a client in
  // UTC-5 is still on the 9th.
  const NOW = new Date(Date.UTC(2026, 9, 10, 1, 30));

  await check("no date means the client's today", async () => {
    eq(
      CC.resolveHistoryDay("", 180, NOW),
      { date: "2026-10-10", nextDate: "2026-10-11" },
      "UTC+3 defaults to its today"
    );
    eq(CC.resolveHistoryDay(undefined, -300, NOW).date, "2026-10-09", "UTC-5");
    eq(CC.resolveHistoryDay(null, "junk", NOW).date, "2026-10-10", "bad offset -> UTC");
  });

  await check("any valid date can be picked, malformed ones are rejected", async () => {
    eq(
      CC.resolveHistoryDay("2026-10-09", 180, NOW),
      { date: "2026-10-09", nextDate: "2026-10-10" },
      "yesterday"
    );
    eq(CC.resolveHistoryDay("2025-01-15", 180, NOW).date, "2025-01-15", "long ago");
    eq(CC.resolveHistoryDay("2026-10-11", 180, NOW).date, "2026-10-11", "future");
    ok(CC.resolveHistoryDay("2026-02-31", 180, NOW).error, "impossible date rejected");
    ok(CC.resolveHistoryDay("10-10-2026", 180, NOW).error, "wrong format rejected");
  });

  await check("month and year boundaries", async () => {
    eq(CC.addDays("2026-03-01", -1), "2026-02-28", "end of February");
    eq(CC.addDays("2028-03-01", -1), "2028-02-29", "leap year");
    eq(CC.addDays("2026-12-31", 1), "2027-01-01", "new year");
  });

  await check("GET /currentcash returns only the requested day", async () => {
    const routes = [];
    const router = Object.assign({}, fakeRouter, {
      get: (p, ...h) => routes.push({ path: p, handler: h[h.length - 1] }),
    });
    const RouterCC = loadModule("CurrentCash.js", {
      express: { Router: () => router },
    });
    const seen = [];
    const db = {
      query: async (sql, params) => {
        const s = String(sql).replace(/\s+/g, " ").trim();
        if (
          (/^(SELECT|UPDATE|INSERT) .*current_cash /.test(s) ||
            /branch_card_balance/.test(s)) &&
          !/FROM cash_/.test(s)
        ) {
          return query(sql, params);
        }
        seen.push({ s, params });
        return [[{ id: seen.length }]];
      },
    };
    RouterCC.createCurrentCashRouter(db);
    const route = routes.find((r) => r.path === "/currentcash");
    ok(route, "route registered");

    const call = async (q) => {
      const res = {
        code: 200,
        status(c) {
          this.code = c;
          return this;
        },
        json(b) {
          this.body = b;
          return this;
        },
      };
      await route.handler({ query: q, user: { username: USER } }, res);
      return res;
    };

    resetTables();
    await payByCard(BRANCH, 70, "A");
    await payByCard(OTHER, 30, "B");
    const today = CC.clientLocalDate(0);
    let r = await call({ branch: BRANCH, tzOffset: "0" });
    eq(r.code, 200, "status");
    eq(r.body.date, today, "defaults to today");
    eq(r.body.cardBalance, 70, "only the requested branch's card balance");
    eq(seen.length, 2, "transactions + resets queried");
    for (const q of seen) {
      ok(/CreatedAt >= \? AND CreatedAt < \?/.test(q.s), "filtered by day: " + q.s);
      eq(q.params, [BRANCH, today, CC.addDays(today, 1)], "day bounds");
    }

    seen.length = 0;
    r = await call({ branch: BRANCH, tzOffset: "0", date: "2025-03-01" });
    eq(r.code, 200, "an old day is allowed");
    eq(r.body.date, "2025-03-01", "echoed date");
    eq(seen[0].params, [BRANCH, "2025-03-01", "2025-03-02"], "old day bounds");

    seen.length = 0;
    r = await call({ branch: BRANCH, tzOffset: "0", date: "not-a-date" });
    eq(r.code, 400, "malformed date rejected");
    eq(seen.length, 0, "no history query for a rejected date");
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();

