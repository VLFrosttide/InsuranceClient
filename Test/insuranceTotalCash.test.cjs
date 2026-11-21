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
const CURRENCIES = ["EUR", "TRY"];

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
  // Cash from brokers: the broker balance ledger and its resets (see
  // "Cash from brokers, per branch" in Requests/CurrentCash.js).
  broker_movements: [],
  broker_cash_resets: [],
  // Policies. The Current cash figures are derived from them: the cash drawer,
  // the day's channels and the day's total insurance money.
  insurance: [],
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
  if (
    s.startsWith(
      "INSERT INTO cash_transactions (Branch, Type, Amount, Currency, Username, Reason, Recipient, CreatedAt)"
    )
  ) {
    // A hand-over: it also names the person who took the money.
    tables.cash_transactions.push({
      id: tables.cash_transactions.length + 1,
      Branch: p[0],
      Type: p[1],
      Amount: p[2],
      Currency: p[3],
      Username: p[4],
      Reason: p[5],
      Recipient: p[6],
      CreatedAt: p[7],
      Deleted: 0,
    });
    return [{ insertId: tables.cash_transactions.length }];
  }
  if (s.startsWith("INSERT INTO cash_transactions")) {
    tables.cash_transactions.push({
      id: tables.cash_transactions.length + 1,
      Branch: p[0],
      Type: p[1],
      Amount: p[2],
      Currency: p[3],
      Username: p[4],
      Reason: p[5],
      CreatedAt: p[6],
      Deleted: 0,
    });
    return [{ insertId: tables.cash_transactions.length }];
  }
  if (s.startsWith("INSERT INTO cash_resets")) {
    tables.cash_resets.push({
      Branch: p[0],
      Username: p[1],
      Currency: p[2],
      KeptAmount: p[3],
      CreatedAt: p[4],
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
      CreatedAt: p[7],
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
  if (s.startsWith("INSERT INTO card_resets (Branch, Username, KeptAmount")) {
    tables.card_resets.push({
      Branch: p[0],
      Username: p[1],
      KeptAmount: p[2],
      CreatedAt: p[3],
    });
    return [{ insertId: tables.card_resets.length }];
  }

  // --- day listings for the Current cash tab --------------------------------
  // Soft-deleted ledger rows are kept in the table but never listed. The join
  // tells the endpoint which rows belong to a policy (their reason is the
  // policy's blanc number), so their corrections can be kept out of the
  // Transactions table.
  if (
    s.startsWith(
      "SELECT ct.*, p.BlancNumber AS PolicyBlanc FROM cash_transactions ct LEFT JOIN insurance p"
    )
  ) {
    return [
      tables.cash_transactions
        .filter(
          (r) =>
            r.Branch === p[0] &&
            !r.Deleted &&
            r.CreatedAt >= p[1] &&
            r.CreatedAt < p[2]
        )
        .map((r) => {
          const policy = tables.insurance.find((i) => i.BlancNumber === r.Reason);
          return { ...r, PolicyBlanc: policy ? policy.BlancNumber : null };
        }),
    ];
  }
  if (s.startsWith("SELECT * FROM cash_transactions WHERE Branch = ? AND Deleted = 0 AND CreatedAt >= ?")) {
    return [tables.cash_transactions.filter(
      (r) =>
        r.Branch === p[0] &&
        !r.Deleted &&
        r.CreatedAt >= p[1] &&
        r.CreatedAt < p[2]
    )];
  }
  // The last reset per currency before a given day: the base of the derived
  // drawer balance.
  if (
    s.startsWith(
      "SELECT Currency, CreatedAt FROM cash_resets WHERE Branch = ? AND CreatedAt < ?"
    )
  ) {
    return [
      tables.cash_resets
        .filter((r) => r.Branch === p[0] && r.CreatedAt < p[1])
        .sort((a, b) => String(a.CreatedAt).localeCompare(String(b.CreatedAt))),
    ];
  }
  if (s.startsWith("SELECT * FROM cash_resets WHERE Branch = ? AND CreatedAt >= ?")) {
    return [tables.cash_resets.filter(
      (r) => r.Branch === p[0] && r.CreatedAt >= p[1] && r.CreatedAt < p[2]
    )];
  }
  if (s.startsWith("SELECT * FROM card_resets WHERE Branch = ? AND CreatedAt >= ?")) {
    return [tables.card_resets.filter(
      (r) => r.Branch === p[0] && r.CreatedAt >= p[1] && r.CreatedAt < p[2]
    )];
  }
  if (s.startsWith("SELECT * FROM broker_cash_resets WHERE Branch = ? AND CreatedAt >= ?")) {
    return [tables.broker_cash_resets.filter(
      (r) => r.Branch === p[0] && r.CreatedAt >= p[1] && r.CreatedAt < p[2]
    )];
  }

  // --- broker balance ledger + cash from brokers ------------------------------
  // A top-up, as Brokers.js's recordBrokerMovement writes it: an "increase"
  // carrying the branch that took the money and its currency.
  if (s.startsWith("INSERT INTO broker_balance_movements")) {
    tables.broker_movements.push({
      id: tables.broker_movements.length + 1,
      BrokerId: p[0],
      Amount: p[1],
      Type: p[2],
      Reason: p[3],
      Author: p[4],
      BlancNumber: p[5],
      CreatedAt: p[6],
      Branch: p[7] === undefined ? null : p[7],
      Currency: p[8] === undefined ? "EUR" : p[8],
      Deleted: 0,
    });
    return [{ insertId: tables.broker_movements.length }];
  }
  if (
    s.startsWith(
      "SELECT COALESCE(MAX(LastMovementId), 0) AS Marker FROM broker_cash_resets"
    )
  ) {
    const rows = tables.broker_cash_resets.filter((r) => r.Branch === p[0]);
    return [[{ Marker: rows.reduce((m, r) => Math.max(m, r.LastMovementId), 0) }]];
  }
  if (s.startsWith("SELECT COALESCE(MAX(id), 0) AS LastId")) {
    const last = tables.broker_movements.reduce((m, r) => Math.max(m, r.id), 0);
    return [[{ LastId: last }]];
  }
  if (s.startsWith("SELECT m.Currency, ROUND(SUM(m.Amount), 2) AS Total")) {
    const totals = {};
    const isTopUp = (m) =>
      m.Type === "increase" && m.Deleted === 0 && Number(m.Amount) > 0;
    // The daily report windows by CreatedAt (and optionally by branch).
    if (s.includes("m.CreatedAt >= ? AND m.CreatedAt < ?")) {
      const [from, to, only] = p;
      for (const m of tables.broker_movements) {
        if (!isTopUp(m) || m.Branch === null) continue;
        if (m.CreatedAt < from || m.CreatedAt >= to) continue;
        if (only !== undefined && m.Branch !== only) continue;
        totals[m.Currency] = round((totals[m.Currency] || 0) + Number(m.Amount));
      }
      return [Object.entries(totals).map(([Currency, Total]) => ({ Currency, Total }))];
    }
    // The branch's live balance windows by movement id (reset marker).
    const bounded = s.includes("AND m.id <= ?");
    const after = Number(p[1]);
    const through = bounded ? Number(p[2]) : Infinity;
    for (const m of tables.broker_movements) {
      if (!isTopUp(m) || m.Branch !== p[0]) continue;
      if (m.id <= after || m.id > through) continue;
      if (bounded && p[3] !== undefined && m.Currency !== p[3]) continue;
      totals[m.Currency] = round((totals[m.Currency] || 0) + Number(m.Amount));
    }
    return [Object.entries(totals).map(([Currency, Total]) => ({ Currency, Total }))];
  }
  if (s.startsWith("SELECT m.id, m.BrokerId, b.Name AS BrokerName")) {
    // The day's top-ups of one branch, newest first.
    const rows = tables.broker_movements
      .filter(
        (m) =>
          m.Type === "increase" &&
          m.Deleted === 0 &&
          Number(m.Amount) > 0 &&
          m.Branch === p[0] &&
          m.CreatedAt >= p[1] &&
          m.CreatedAt < p[2]
      )
      .sort((a, b) => b.id - a.id)
      .map((m) => ({
        id: m.id,
        BrokerId: m.BrokerId,
        BrokerName: m.BrokerName || `Broker ${m.BrokerId}`,
        Amount: m.Amount,
        Currency: m.Currency,
        Username: m.Author,
        Reason: m.Reason,
        CreatedAt: m.CreatedAt,
      }));
    return [rows];
  }
  if (s.startsWith("INSERT INTO broker_cash_resets")) {
    tables.broker_cash_resets.push({
      Branch: p[0],
      Username: p[1],
      Currency: p[2],
      KeptAmount: p[3],
      LastMovementId: p[4],
      CreatedAt: p[5],
    });
    return [{ insertId: tables.broker_cash_resets.length }];
  }

  // --- re-branching (movePolicyBranch) ----------------------------------------
  // p = [to, from, reason, "Edit reason", "Annul reason", "Delete reason", "Restore reason"]
  if (s.startsWith("UPDATE cash_transactions SET Branch")) {
    const [to, from, ...reasons] = p;
    for (const row of tables.cash_transactions) {
      if (row.Branch === from && reasons.includes(row.Reason)) row.Branch = to;
    }
    return [{ affectedRows: 1 }];
  }
  if (s.startsWith("UPDATE total_cash_transactions SET Branch")) {
    const [to, from, ...reasons] = p;
    for (const row of tables.total_cash_transactions) {
      if (row.Branch === from && reasons.includes(row.Reason)) row.Branch = to;
    }
    return [{ affectedRows: 1 }];
  }

  // The drawer movements the derived balance sums: one window per currency, and
  // the policy a row belongs to (if any) joined through its reason.
  if (
    s.startsWith(
      "SELECT ct.Type, ct.Amount, ct.Currency, ct.Reason, p.BlancNumber AS PolicyBlanc"
    )
  ) {
    const branch = p[0];
    const windows = new Map();
    for (let i = 1; i + 1 < p.length; i += 2) {
      windows.set(String(p[i]).toUpperCase(), p[i + 1]);
    }
    const nextDate = p[p.length - 1];
    return [
      tables.cash_transactions
        .filter((r) => {
          if (r.Branch !== branch || r.Deleted) return false;
          if (r.CreatedAt >= nextDate) return false;
          const start = windows.get(String(r.Currency).toUpperCase());
          return start !== undefined && r.CreatedAt >= start;
        })
        .map((r) => {
          const policy = tables.insurance.find((i) => i.BlancNumber === r.Reason);
          return { ...r, PolicyBlanc: policy ? policy.BlancNumber : null };
        }),
    ];
  }

  // --- insurance money ------------------------------------------------------
  // Both the derived drawer balance (one currency at a time, from the branch's
  // last reset) and the daily report (per branch, per channel) are computed
  // from the policies themselves, so the fake sums the seeded rows the same way
  // MySQL would.
  if (s.includes("COUNT(*) AS total")) {
    return [[{ total: 0, broker: 0, walkIn: 0 }]];
  }
  if (s.includes("MIN(CAST(PolicyNumber AS UNSIGNED))")) {
    return [[{ firstPolicy: null, lastPolicy: null }]];
  }
  if (s.includes("FROM insurance")) {
    const amountOf = (i) =>
      Number(i.Annulled) ? Number(i.AnnulFee) || 0 : Number(i.Price) || 0;
    const currencyOf = (v) => String(v || "EUR").toUpperCase();
    const live = tables.insurance.filter((i) => !i.Deleted);
    const totals = new Map();

    if (s.includes("GROUP BY CurrencyType")) {
      // Derived drawer balance: one row per currency, with its own window.
      // p = [branch, cur1, start1, cur2, start2, ..., nextDate]
      const branch = p[0];
      const windows = new Map();
      for (let i = 1; i + 1 < p.length; i += 2) {
        windows.set(currencyOf(p[i]), p[i + 1]);
      }
      const nextDate = p[p.length - 1];
      for (const i of live) {
        if (i.Branch !== branch) continue;
        if (i.BrokerId !== null && i.BrokerId !== undefined) continue;
        if (String(i.PaymentType) !== "Cash") continue;
        const cur = currencyOf(i.CurrencyType);
        const start = windows.get(cur);
        if (start === undefined) continue;
        if (i.CreationDate < start || i.CreationDate >= nextDate) continue;
        totals.set(cur, round((totals.get(cur) || 0) + amountOf(i)));
      }
      return [
        [...totals].map(([Currency, Total]) => ({ Currency, Total })),
      ];
    }

    // Daily report: the four channel queries, scoped to a branch when the
    // trailing parameter is present.
    const scoped = s.includes("AND Branch = ?");
    const only = scoped ? p[p.length - 1] : null;
    const [from, to] = p;
    let filter = () => true;
    if (s.includes("PaymentType = 'Cash'")) {
      filter = (i) =>
        (i.BrokerId === null || i.BrokerId === undefined) &&
        String(i.PaymentType) === "Cash";
    } else if (s.includes("PaymentType = 'Card'")) {
      filter = (i) =>
        (i.BrokerId === null || i.BrokerId === undefined) &&
        String(i.PaymentType) === "Card";
    } else if (s.includes("BrokerId IS NOT NULL")) {
      filter = (i) => i.BrokerId !== null && i.BrokerId !== undefined;
    }
    for (const i of live) {
      if (!filter(i)) continue;
      if (scoped && i.Branch !== only) continue;
      if (i.CreationDate < from || i.CreationDate >= to) continue;
      const key = `${i.Branch || ""}|${currencyOf(i.CurrencyType)}`;
      totals.set(key, round((totals.get(key) || 0) + amountOf(i)));
    }
    return [
      [...totals].map(([key, Net]) => {
        const [Branch, Currency] = key.split("|");
        return { Branch, Currency, Net };
      }),
    ];
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
  tables.broker_movements.length = 0;
  tables.broker_cash_resets.length = 0;
  tables.insurance.length = 0;
  sqlLog.length = 0;
}

// A broker top-up as Brokers.js records it: an "increase" of the broker's
// balance carrying the branch that took the money. `extra` overrides the type,
// the deletion flag, the branch or the amount.
function brokerTopUp(branch, amount, currency = "EUR", extra = {}) {
  tables.broker_movements.push({
    id: tables.broker_movements.length + 1,
    BrokerId: 1,
    Amount: amount,
    Type: extra.Type || "increase",
    Reason: extra.Reason || "top-up",
    Author: extra.Author || USER,
    BlancNumber: null,
    CreatedAt: extra.CreatedAt || "2026-10-20 10:00:00",
    Branch: extra.Branch === undefined ? branch : extra.Branch,
    Currency: currency,
    Deleted: extra.Deleted ? 1 : 0,
  });
}

const BRANCH = "Офис Харманли";
const OTHER = "ГКПП Лесово";
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
  console.log("Total cash — the second record of cash flow");

  await check("a fresh branch has zero current cash and zero total cash", async () => {
    resetTables();
    eq(
      await CC.getCurrentCash(fakeDb, BRANCH),
      { EUR: 0, TRY: 0 },
      "current cash"
    );
    eq(
      await CC.getTotalCash(fakeDb, BRANCH),
      { EUR: 0, TRY: 0 },
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
      ["Cash increase 50 EUR @ Офис Харманли"],
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
        ["Broker increase 100 EUR @ Офис Харманли"],
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
      "TRY",
      "Broker"
    );
    eq(
      await CC.getTotalCash(fakeDb, BRANCH),
      { EUR: 10, TRY: 20 },
      "total cash per currency"
    );
    await assertSuperset("multi-currency");
  });

  await check("per-branch totals stay separate", async () => {
    resetTables();
    await CC.recordCashMovement(fakeDb, BRANCH, USER, "increase", 10, "A", "EUR");
    await CC.recordChannelMovement(
      fakeDb,
      "ГКПП Лесово",
      USER,
      "increase",
      20,
      "B",
      "EUR",
      "Broker"
    );
    eq((await CC.getTotalCash(fakeDb, BRANCH)).EUR, 10, "branch A");
    eq((await CC.getTotalCash(fakeDb, "ГКПП Лесово")).EUR, 20, "branch B");
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
      ledger().includes("Cash reduce 50 EUR @ Офис Харманли"),
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
      tables.card_resets.map((r) => ({
        Branch: r.Branch,
        Username: r.Username,
        KeptAmount: r.KeptAmount,
      })),
      [{ Branch: BRANCH, Username: USER, KeptAmount: 70 }],
      "card reset recorded with its branch"
    );
    ok(
      ledger().includes("Card reduce 70 EUR @ Офис Харманли"),
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
        "Cash increase 25 TRY @ Офис Харманли",
        "Cash reduce 5 TRY @ Офис Харманли",
      ],
      "the two records list the same movements"
    );
    eq(tables.cash_transactions.length, 2, "and so does the current cash ledger");
    await assertSuperset("after cash in and out");
  });

  // --- transaction history by day (one day at a time, default today) --------
  console.log("\nCurrent cash history — one day at a time");
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

  await check("getAvailableCashAsOf derives the drawer from the policies", async () => {
    // The drawer is derived, not walked back: the kept amount of the last reset
    // plus the cash policies of the shift plus the manual movements. The sale
    // rows carry the blanc number and the card policy touches no drawer, so
    // neither may be counted twice.
    resetTables();
    tables.insurance.push(
      {
        BlancNumber: "A1",
        Branch: BRANCH,
        PaymentType: "Cash",
        Price: "100.00",
        CurrencyType: "EUR",
        CreationDate: "2026-10-14 09:00:00",
        Annulled: 0,
        Deleted: 0,
        BrokerId: null,
      },
      {
        BlancNumber: "A2",
        Branch: BRANCH,
        PaymentType: "Cash",
        Price: "200.00",
        CurrencyType: "TRY",
        CreationDate: "2026-10-14 10:00:00",
        Annulled: 0,
        Deleted: 0,
        BrokerId: null,
      },
      {
        BlancNumber: "A3",
        Branch: BRANCH,
        PaymentType: "Card",
        Price: "50.00",
        CurrencyType: "EUR",
        CreationDate: "2026-10-14 11:00:00",
        Annulled: 0,
        Deleted: 0,
        BrokerId: null,
      },
      // Created before the shift's reset, so its money already left the drawer.
      {
        BlancNumber: "A0",
        Branch: BRANCH,
        PaymentType: "Cash",
        Price: "40.00",
        CurrencyType: "EUR",
        CreationDate: "2026-10-13 09:00:00",
        Annulled: 0,
        Deleted: 0,
        BrokerId: null,
      }
    );
    tables.cash_resets.push({
      Branch: BRANCH,
      Currency: "EUR",
      // What was handed over at the shift's start; the drawer itself is 0.
      KeptAmount: 5,
      CreatedAt: "2026-10-14 08:00:00",
    });
    tables.cash_transactions.push(
      // The sale entry: same money as policy A1 above, so it is skipped.
      {
        Branch: BRANCH,
        Type: "increase",
        Amount: 100,
        Currency: "EUR",
        Reason: "A1",
        CreatedAt: "2026-10-14 09:00:00",
        Deleted: 0,
      },
      {
        Branch: BRANCH,
        Type: "reduce",
        Amount: 20,
        Currency: "EUR",
        Reason: "rent",
        CreatedAt: "2026-10-14 12:00:00",
        Deleted: 0,
      },
      {
        Branch: BRANCH,
        Type: "handover",
        Amount: 10,
        Currency: "EUR",
        Reason: "to the safe",
        Recipient: "Ivan",
        CreatedAt: "2026-10-14 13:00:00",
        Deleted: 0,
      },
      {
        Branch: BRANCH,
        Type: "increase",
        Amount: 30,
        Currency: "TRY",
        Reason: "top-up",
        CreatedAt: "2026-10-14 14:00:00",
        Deleted: 0,
      }
    );
    // 100 cash - 20 expense - 10 handed over = 70 EUR; the drawer started that
    // shift at 0 (the reset handed the earlier money over). TRY was never
    // reset: 200 cash + 30 manual increase = 230.
    eq(
      await CC.getAvailableCashAsOf(
        { query: async (sql, params) => query(sql, params) },
        BRANCH,
        "2026-10-15"
      ),
      { EUR: 70, TRY: 230 },
      "historical available cash"
    );
    // The historical name still resolves to the same calculation.
    eq(
      await CC.getCurrentCashAsOf(
        { query: async (sql, params) => query(sql, params) },
        BRANCH,
        "2026-10-15"
      ),
      { EUR: 70, TRY: 230 },
      "getCurrentCashAsOf alias"
    );
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
    eq(seen.length, 11, "transactions + resets + cash from brokers + insurance lists queried");
    // The day's history: cash movements, cash resets, card resets, the broker
    // top-ups, the Cash from Brokers resets and the broker hand-overs.
    const dayScoped = seen.filter(
      (q) => q.s.includes("CreatedAt < ?") && q.s.includes("Branch = ?")
    );
    eq(dayScoped.length, 5, "one day-scoped query per branch history table");
    for (const q of dayScoped) {
      eq(q.params, [BRANCH, today, CC.addDays(today, 1)], "day bounds: " + q.s);
    }
    // Broker hand-overs carry no branch, so they are day-scoped only.
    const brokerHandoversQuery = seen.find(
      (q) => q.s.includes("m.Type = 'handover'") && q.s.includes("CreatedAt < ?")
    );
    ok(brokerHandoversQuery, "broker hand-overs queried");
    eq(
      brokerHandoversQuery.params,
      [today, CC.addDays(today, 1)],
      "broker hand-over day bounds"
    );
    // The walk-in card policies are day-scoped on their CREATION date, like the
    // daily card payments figure they explain.
    const cardInsurancesQuery = seen.find(
      (q) => /FROM insurance/.test(q.s) && q.s.includes("PaymentType = 'Card'")
    );
    ok(cardInsurancesQuery, "walk-in card insurances queried");
    eq(
      cardInsurancesQuery.params,
      [BRANCH, today, CC.addDays(today, 1)],
      "card insurance day bounds: " + cardInsurancesQuery.s
    );
    const cashInsurancesQuery = seen.find(
      (q) => /FROM insurance/.test(q.s) && q.s.includes("PaymentType = 'Cash'")
    );
    ok(cashInsurancesQuery, "walk-in cash insurances queried");
    eq(
      cashInsurancesQuery.params,
      [BRANCH, today, CC.addDays(today, 1)],
      "cash insurance day bounds"
    );
    const brokerInsurancesQuery = seen.find(
      (q) => /FROM insurance i/.test(q.s) && q.s.includes("BrokerId IS NOT NULL")
    );
    ok(brokerInsurancesQuery, "broker-funded insurances queried");
    eq(
      brokerInsurancesQuery.params,
      [BRANCH, today, CC.addDays(today, 1)],
      "broker insurance day bounds"
    );
    // The branch's live Cash from Brokers: the reset marker and the top-up sum.
    const branchScoped = seen.filter(
      (q) =>
        /broker_cash_resets|broker_balance_movements/.test(q.s) &&
        !q.s.includes("CreatedAt >= ?")
    );
    eq(branchScoped.length, 2, "cash from brokers balance + reset marker");
    for (const q of branchScoped) {
      eq(q.params[0], BRANCH, "branch: " + q.s);
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

  await check("GET /currentcash/daily computes the country-wide report", async () => {
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
        seen.push({ s, params });
        if (/MIN\(CAST\(PolicyNumber AS UNSIGNED\)\)/.test(s)) {
          return [[{ firstPolicy: "101", lastPolicy: "104" }]];
        }
        if (/COUNT\(\*\) AS total/.test(s)) {
          return [[{ total: 5, broker: 2, walkIn: 3 }]];
        }
        // The two policies that set the ends of the policy-number span.
        if (/ORDER BY CAST\(PolicyNumber AS UNSIGNED\)/.test(s)) {
          return [[]];
        }
        // The four insurance-money queries: walk-in cash, walk-in card,
        // broker-funded and all of them together.
        if (s.includes("PaymentType = 'Cash'")) {
          return [[{ Branch: BRANCH, Currency: "EUR", Net: 30 }]];
        }
        if (s.includes("PaymentType = 'Card'")) {
          return [[{ Branch: OTHER, Currency: "TRY", Net: 5 }]];
        }
        if (s.includes("BrokerId IS NOT NULL")) {
          return [[{ Branch: BRANCH, Currency: "EUR", Net: 20 }]];
        }
        if (s.includes("FROM insurance")) {
          return [
            [
              { Branch: BRANCH, Currency: "EUR", Net: 50 },
              { Branch: OTHER, Currency: "TRY", Net: 5 },
            ],
          ];
        }
        return [[]];
      },
    };
    RouterCC.createCurrentCashRouter(db);
    const route = routes.find((r) => r.path === "/currentcash/daily");
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

    const today = CC.clientLocalDate(0);
    let r = await call({ tzOffset: "0" });
    eq(r.code, 200, "status");
    eq(
      r.body,
      {
        date: today,
        totalInsurances: 5,
        brokerInsurances: 2,
        walkInInsurances: 3,
        // The price of every insurance of the day: 30 + 20 EUR and 5 TRY.
        totalDailyBalance: { EUR: 50, TRY: 5 },
        countryWideInsurances: 3,
        countryWideRange: { first: null, last: null },
        cashPayments: [{ Branch: BRANCH, EUR: 30, TRY: 0 }],
        cardPayments: [{ Branch: OTHER, EUR: 0, TRY: 5 }],
        brokerBalance: [{ Branch: BRANCH, EUR: 20, TRY: 0 }],
        cashFromBrokers: { EUR: 0, TRY: 0 },
      },
      "defaults to today and computes the report"
    );
    const dayQueries = seen.filter((q) => q.params && q.params.length);
    eq(
      dayQueries.length,
      9,
      "counts + span + its two ends + cash + card + broker + all insurances + cash from brokers"
    );
    for (const q of dayQueries) {
      eq(q.params, [today, CC.addDays(today, 1)], "day bounds: " + q.s);
    }

    seen.length = 0;
    r = await call({ tzOffset: "0", date: "not-a-date" });
    eq(r.code, 400, "malformed date rejected");
    eq(seen.length, 0, "no queries for a rejected date");
  });

  await check("GET /currentcash/daily includes the branch's available cash", async () => {
    const routes = [];
    const router = Object.assign({}, fakeRouter, {
      get: (p, ...h) => routes.push({ path: p, handler: h[h.length - 1] }),
    });
    const RouterCC = loadModule("CurrentCash.js", {
      express: { Router: () => router },
    });
    const db = {
      query: async (sql, params) => {
        const s = String(sql).replace(/\s+/g, " ").trim();
        if (/MIN\(CAST\(PolicyNumber AS UNSIGNED\)\)/.test(s)) {
          return [[{ firstPolicy: "101", lastPolicy: "104" }]];
        }
        if (/COUNT\(\*\) AS total/.test(s)) {
          return [[{ total: 5, broker: 2, walkIn: 3 }]];
        }
        // The branch's cash policies for the derived drawer balance.
        if (s.includes("GROUP BY CurrencyType")) {
          return [[{ Currency: "EUR", Total: 100 }]];
        }
        // Its last reset before the requested day: the shift's drawer starts
        // at 0 there (the reset handed the money over).
        if (/FROM cash_resets/.test(s)) {
          return [
            [
              {
                Currency: "EUR",
                KeptAmount: 5,
                CreatedAt: "2026-11-01 08:00:00",
              },
            ],
          ];
        }
        // Its manual drawer movements: one expense of 20 EUR.
        if (/FROM cash_transactions ct/.test(s)) {
          return [
            [
              {
                Type: "reduce",
                Amount: 20,
                Currency: "EUR",
                Reason: "rent",
                PolicyBlanc: null,
              },
            ],
          ];
        }
        return [[]];
      },
    };
    RouterCC.createCurrentCashRouter(db);
    const route = routes.find((r) => r.path === "/currentcash/daily");
    ok(route, "route registered");

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
    const today = CC.clientLocalDate(0);
    await route.handler(
      { query: { branch: BRANCH, tzOffset: "0" }, user: { username: USER } },
      res
    );
    eq(res.code, 200, "status");
    eq(
      res.body,
      {
        date: today,
        totalInsurances: 5,
        brokerInsurances: 2,
        walkInInsurances: 3,
        totalDailyBalance: { EUR: 0, TRY: 0 },
        countryWideInsurances: 3,
        countryWideRange: { first: null, last: null },
        cashPayments: [],
        cardPayments: [],
        brokerBalance: [],
        cashFromBrokers: { EUR: 0, TRY: 0 },
        // The shift started at 0 (the reset handed the earlier money over):
        // 100 cash - the 20 expense.
        availableCash: { EUR: 80, TRY: 0 },
      },
      "the report carries the branch's derived available cash"
    );
  });

  await check(
    "GET /currentcash/daily names the two policies bounding the range",
    async () => {
      const routes = [];
      const router = Object.assign({}, fakeRouter, {
        get: (p, ...h) => routes.push({ path: p, handler: h[h.length - 1] }),
      });
      const RouterCC = loadModule("CurrentCash.js", {
        express: { Router: () => router },
      });
      const db = {
        query: async (sql, params) => {
          const s = String(sql).replace(/\s+/g, " ").trim();
          if (/MIN\(CAST\(PolicyNumber AS UNSIGNED\)\)/.test(s)) {
            return [[{ firstPolicy: "101", lastPolicy: "900103" }]];
          }
          if (/COUNT\(\*\) AS total/.test(s)) {
            return [[{ total: 4, broker: 0, walkIn: 4 }]];
          }
          // The two policies that set the ends of the span.
          if (/ORDER BY CAST\(PolicyNumber AS UNSIGNED\) ASC/.test(s)) {
            eq(params, ["2026-10-20", "2026-10-21"], "ascending day bounds");
            return [
              [
                {
                  PolicyNumber: "101",
                  BlancNumber: "B1",
                  Branch: BRANCH,
                  Author: USER,
                  CreatedAt: "2026-10-20 09:15",
                },
              ],
            ];
          }
          if (/ORDER BY CAST\(PolicyNumber AS UNSIGNED\) DESC/.test(s)) {
            eq(params, ["2026-10-20", "2026-10-21"], "descending day bounds");
            return [
              [
                {
                  PolicyNumber: "900103",
                  BlancNumber: "B4",
                  Branch: OTHER,
                  Author: USER,
                  CreatedAt: "2026-10-20 17:40",
                },
              ],
            ];
          }
          return [[]];
        },
      };
      RouterCC.createCurrentCashRouter(db);
      const route = routes.find((r) => r.path === "/currentcash/daily");
      ok(route, "route registered");

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
      await route.handler(
        { query: { date: "2026-10-20", tzOffset: "0" }, user: { username: USER } },
        res
      );
      eq(res.code, 200, "status");
      eq(
        res.body.countryWideInsurances,
        900002,
        "the range is still last - first"
      );
      eq(
        res.body.countryWideRange,
        {
          first: {
            PolicyNumber: "101",
            BlancNumber: "B1",
            Branch: BRANCH,
            Author: USER,
            CreatedAt: "2026-10-20 09:15",
          },
          last: {
            PolicyNumber: "900103",
            BlancNumber: "B4",
            Branch: OTHER,
            Author: USER,
            CreatedAt: "2026-10-20 17:40",
          },
        },
        "both ends carry the policy that produced them"
      );
    }
  );

  await check(
    "GET /currentcash/daily scopes card/broker to the branch and nets annulments by creation date",
    async () => {
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
          seen.push({ s, params });
          if (/MIN\(CAST\(PolicyNumber AS UNSIGNED\)\)/.test(s)) {
            return [[{ firstPolicy: "101", lastPolicy: "104" }]];
          }
          if (/COUNT\(\*\) AS total/.test(s)) {
            return [[{ total: 5, broker: 2, walkIn: 3 }]];
          }
          if (/FROM cash_transactions/.test(s)) {
            if (s.includes("Branch = ?"))
              return [[{ Currency: "EUR", Net: 30 }]];
            return [[{ Currency: "EUR", Net: 50 }, { Currency: "TRY", Net: -5 }]];
          }
          if (/FROM insurance/.test(s)) {
            if (s.includes("PaymentType = 'Card'")) {
              return [[{ Branch: BRANCH, Currency: "EUR", Net: 80 }]];
            }
            if (s.includes("BrokerId IS NOT NULL")) {
              return [[{ Branch: BRANCH, Currency: "EUR", Net: 25 }]];
            }
            return [[]];
          }
          if (/FROM cash_resets/.test(s)) return [[{ Currency: "EUR", Kept: 5 }]];
          return [[]];
        },
      };
      RouterCC.createCurrentCashRouter(db);
      const route = routes.find((r) => r.path === "/currentcash/daily");
      ok(route, "route registered");

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
      const today = CC.clientLocalDate(0);
      await route.handler(
        { query: { branch: BRANCH, tzOffset: "0" }, user: { username: USER } },
        res
      );
      eq(res.code, 200, "status");
      eq(
        res.body.cardPayments,
        [{ Branch: BRANCH, EUR: 80, TRY: 0 }],
        "card payments restricted to the branch"
      );
      eq(
        res.body.brokerBalance,
        [{ Branch: BRANCH, EUR: 25, TRY: 0 }],
        "broker balance restricted to the branch"
      );

      const cardQ = seen.find(
        (q) => /FROM insurance/.test(q.s) && q.s.includes("PaymentType = 'Card'")
      );
      const brokerQ = seen.find(
        (q) =>
          /FROM insurance/.test(q.s) && q.s.includes("WHERE BrokerId IS NOT NULL")
      );
      ok(cardQ, "card query issued");
      ok(brokerQ, "broker query issued");
      ok(/BrokerId IS NULL/.test(cardQ.s), "card counts walk-ins only: " + cardQ.s);
      ok(/CASE WHEN (i\.)?Annulled = 0/.test(cardQ.s), "card nets annulments (fee after annul): " + cardQ.s);
      ok(/CreationDate >= \?/.test(cardQ.s), "card is keyed on the creation date: " + cardQ.s);
      ok(/AND Branch = \?/.test(cardQ.s), "card query is branch-scoped: " + cardQ.s);
      ok(/AND Branch = \?/.test(brokerQ.s), "broker query is branch-scoped: " + brokerQ.s);
      eq(cardQ.params, [today, CC.addDays(today, 1), BRANCH], "card query params");
      eq(brokerQ.params, [today, CC.addDays(today, 1), BRANCH], "broker query params");
    }
  );


  await check("movePolicyBranch transfers the balance and re-branches the ledger", async () => {
    resetTables();
    await CC.recordCashMovement(fakeDb, BRANCH, USER, "increase", 25, "168655", "EUR");
    eq((await CC.getCurrentCash(fakeDb, BRANCH)).EUR, 25, "cash in the old branch");
    eq((await CC.getCurrentCash(fakeDb, OTHER)).EUR, 0, "nothing in the new branch yet");

    await CC.movePolicyBranch(fakeDb, "Cash", {
      fromBranch: BRANCH,
      toBranch: OTHER,
      amount: 25,
      reason: "168655",
      currency: "EUR",
    });

    eq((await CC.getCurrentCash(fakeDb, BRANCH)).EUR, 0, "old branch drawn down");
    eq((await CC.getCurrentCash(fakeDb, OTHER)).EUR, 25, "new branch now holds the money");

    eq(
      tables.cash_transactions.map((r) => `${r.Branch} ${r.Type} ${r.Reason}`),
      [`${OTHER} increase 168655`],
      "cash ledger row follows the policy"
    );
    eq(
      tables.total_cash_transactions.map(
        (r) => `${r.Branch} ${r.Source} ${r.Type} ${r.Reason}`
      ),
      [`${OTHER} Cash increase 168655`],
      "total cash ledger row follows the policy"
    );
    await assertSuperset("after a branch transfer", OTHER);
  });

  await check("movePolicyBranch only moves the policy's own rows", async () => {
    resetTables();
    await CC.recordCashMovement(fakeDb, BRANCH, USER, "increase", 25, "168655", "EUR");
    await CC.recordCashMovement(fakeDb, BRANCH, USER, "increase", 10, "999999", "EUR");

    await CC.movePolicyBranch(fakeDb, "Cash", {
      fromBranch: BRANCH,
      toBranch: OTHER,
      amount: 25,
      reason: "168655",
      currency: "EUR",
    });

    const byReason = (row) => `${row.Branch} ${row.Reason}`;
    eq(
      tables.cash_transactions.map(byReason).sort(),
      [`${OTHER} 168655`, `${BRANCH} 999999`].sort(),
      "the other policy's row stays put"
    );
  });


  // --- client-side creation time (CreatedAt) ---------------------------------
  await check("parseClientDateTime validates and normalises", () => {
    eq(
      CC.parseClientDateTime("2026-10-10 09:15:42"),
      "2026-10-10 09:15:42",
      "space separator"
    );
    eq(
      CC.parseClientDateTime("2026-10-10T09:15:42"),
      "2026-10-10 09:15:42",
      "T separator"
    );
    eq(CC.parseClientDateTime("2026-02-31 10:00:00"), null, "impossible date");
    eq(CC.parseClientDateTime("2026-10-10 25:00:00"), null, "impossible time");
    eq(CC.parseClientDateTime("nope"), null, "garbage");
  });

  await check("clientLocalDateTime shifts by the client's offset", () => {
    const INSTANT = new Date(Date.UTC(2026, 9, 10, 6, 30, 0));
    eq(CC.clientLocalDateTime(180, INSTANT), "2026-10-10 09:30:00", "+3h");
    eq(CC.clientLocalDateTime(0, INSTANT), "2026-10-10 06:30:00", "UTC");
  });

  await check("resolveRequestCreatedAt prefers the client's own value", () => {
    eq(
      CC.resolveRequestCreatedAt({
        CreatedAt: "2026-10-10 12:00:00",
        TzOffset: 180,
      }).createdAt,
      "2026-10-10 12:00:00",
      "CreatedAt wins over TzOffset"
    );
    eq(
      CC.resolveRequestCreatedAt({ createdAt: "2026-10-10 12:00:00" }).createdAt,
      "2026-10-10 12:00:00",
      "lowercase key accepted"
    );
    const INSTANT = new Date(Date.UTC(2026, 9, 10, 6, 0, 0));
    eq(
      CC.resolveRequestCreatedAt({ TzOffset: 180 }, INSTANT).createdAt,
      "2026-10-10 09:00:00",
      "TzOffset fallback"
    );
    ok(
      CC.resolveRequestCreatedAt({ CreatedAt: "bad" }).error,
      "invalid value rejected"
    );
  });

  await check("a movement stores the client's CreatedAt as sent", async () => {
    resetTables();
    await CC.recordCashMovement(
      fakeDb,
      BRANCH,
      USER,
      "increase",
      10,
      "top-up",
      "EUR",
      "2026-10-20 09:15:42"
    );
    eq(
      tables.cash_transactions[0].CreatedAt,
      "2026-10-20 09:15:42",
      "cash ledger"
    );
    eq(
      tables.total_cash_transactions[0].CreatedAt,
      "2026-10-20 09:15:42",
      "total cash ledger"
    );
  });

  await check("resets are stamped with the client's CreatedAt", async () => {
    resetTables();
    await CC.recordCashMovement(
      fakeDb,
      BRANCH,
      USER,
      "increase",
      50,
      "A",
      "EUR"
    );
    await CC.resetBranch(fakeDb, BRANCH, USER, "2026-10-20 18:30:00");
    eq(tables.cash_resets[0].CreatedAt, "2026-10-20 18:30:00", "cash reset");
    eq(
      tables.card_resets[0] && tables.card_resets[0].CreatedAt,
      "2026-10-20 18:30:00",
      "card reset"
    );
  });


  // ---------------------------------------------------------------------------
  console.log("\nCash from brokers - money handed over by brokers");
  // ---------------------------------------------------------------------------

  // Loads the CurrentCash router against the fake DB and returns a caller for one
  // of its GET routes, e.g. `await call("/currentcash/daily", query)`.
  function routeCaller(path) {
    const routes = [];
    const router = Object.assign({}, fakeRouter, {
      get: (p, ...h) => routes.push({ path: p, handler: h[h.length - 1] }),
    });
    const RouterCC = loadModule("CurrentCash.js", {
      express: { Router: () => router },
    });
    RouterCC.createCurrentCashRouter(fakeDb);
    const route = routes.find((r) => r.path === path);
    ok(route, "route registered: " + path);
    return async (query) => {
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
      await route.handler({ query, user: { username: USER } }, res);
      return res;
    };
  }

  await check("a broker top-up raises Cash from Brokers, not current cash", async () => {
    resetTables();
    await CC.recordCashMovement(
      fakeDb, BRANCH, USER, "increase", 20, "walk-in", "EUR"
    );
    const cashBefore = await CC.getCurrentCash(fakeDb, BRANCH);
    const totalBefore = await CC.getTotalCash(fakeDb, BRANCH);

    brokerTopUp(BRANCH, 100, "EUR");

    eq(await CC.getBrokerCash(fakeDb, BRANCH), { EUR: 100, TRY: 0 },
      "the branch's cash from brokers");
    eq(await CC.getCurrentCash(fakeDb, BRANCH), cashBefore,
      "available cash does not move");
    eq(await CC.getTotalCash(fakeDb, BRANCH), totalBefore,
      "total cash does not move either");
    eq(await CC.getBrokerCash(fakeDb, OTHER), { EUR: 0, TRY: 0 },
      "another branch is not credited");
  });

  await check("only manual top-ups of that day and branch are listed", async () => {
    resetTables();
    brokerTopUp(BRANCH, 100, "EUR", { CreatedAt: "2026-10-20 10:00:00" });
    brokerTopUp(BRANCH, 50, "TRY", { CreatedAt: "2026-10-20 11:00:00" });
    // Refunds of an annulled / deleted insurance raise the broker's balance but
    // are not money handed over, so they stay out of this list.
    brokerTopUp(BRANCH, 30, "EUR", { Type: "annulment", CreatedAt: "2026-10-20 12:00:00" });
    brokerTopUp(BRANCH, 40, "EUR", { Type: "deletion", CreatedAt: "2026-10-20 12:30:00" });
    brokerTopUp(BRANCH, 25, "EUR", { CreatedAt: "2026-10-20 13:00:00", Deleted: true });
    brokerTopUp(BRANCH, 60, "EUR", { CreatedAt: "2026-10-21 09:00:00" });
    brokerTopUp(OTHER, 70, "EUR", { CreatedAt: "2026-10-20 14:00:00" });

    const rows = await CC.getBrokerCashTransactions(
      fakeDb, BRANCH, "2026-10-20", "2026-10-21"
    );
    eq(
      rows.map((r) => [r.Amount, r.Currency, r.Reason]),
      [[50, "TRY", "top-up"], [100, "EUR", "top-up"]],
      "newest first, only the branch's manual top-ups of that day"
    );
  });

  await check("resetting clears Cash from Brokers and records what was kept", async () => {
    resetTables();
    brokerTopUp(BRANCH, 100, "EUR", { CreatedAt: "2026-10-20 10:00:00" });
    brokerTopUp(BRANCH, 40, "TRY", { CreatedAt: "2026-10-20 11:00:00" });
    brokerTopUp(OTHER, 90, "EUR", { CreatedAt: "2026-10-20 12:00:00" });

    const kept = await CC.resetBrokerCash(
      fakeDb, BRANCH, USER, "2026-10-20 18:00:00"
    );
    eq(kept, { EUR: 100, TRY: 40 }, "kept amounts");
    eq(await CC.getBrokerCash(fakeDb, BRANCH), { EUR: 0, TRY: 0 }, "balance cleared");
    eq(
      tables.broker_cash_resets.map((r) => [
        r.Branch, r.Currency, r.KeptAmount, r.CreatedAt,
      ]),
      [[BRANCH, "EUR", 100, "2026-10-20 18:00:00"],
       [BRANCH, "TRY", 40, "2026-10-20 18:00:00"]],
      "resets recorded per currency"
    );
    eq(await CC.getBrokerCash(fakeDb, OTHER), { EUR: 90, TRY: 0 },
      "another branch keeps its money");

    brokerTopUp(BRANCH, 10, "EUR", { CreatedAt: "2026-10-21 09:00:00" });
    eq(await CC.getBrokerCash(fakeDb, BRANCH), { EUR: 10, TRY: 0 },
      "a later top-up starts a new period");
  });


  await check("Reset to 0 clears the drawer, the card balance and the broker money", async () => {
    resetTables();
    await CC.recordCashMovement(fakeDb, BRANCH, USER, "increase", 20, "walk-in", "EUR");
    await payByCard(BRANCH, 30, "card payment");
    brokerTopUp(BRANCH, 50, "EUR");

    const result = await CC.resetBranch(fakeDb, BRANCH, USER, "2026-10-20 18:00:00");
    eq(result.cash, { EUR: 20, TRY: 0 }, "kept cash");
    eq(result.card, 30, "kept card balance");
    eq(result.brokerCash, { EUR: 50, TRY: 0 }, "kept cash from brokers");
    eq(await CC.getCurrentCash(fakeDb, BRANCH), { EUR: 0, TRY: 0 }, "drawer cleared");
    eq(await CC.getBrokerCash(fakeDb, BRANCH), { EUR: 0, TRY: 0 },
      "cash from brokers cleared");
  });

  await check("the Current cash tab lists the branch's top-ups of the day", async () => {
    resetTables();
    brokerTopUp(BRANCH, 100, "EUR", { CreatedAt: "2026-10-20 10:00:00" });
    brokerTopUp(BRANCH, 50, "TRY", { CreatedAt: "2026-10-20 11:00:00" });
    brokerTopUp(BRANCH, 25, "EUR", { CreatedAt: "2026-10-21 09:00:00" });
    brokerTopUp(OTHER, 75, "EUR", { CreatedAt: "2026-10-20 12:00:00" });

    const call = routeCaller("/currentcash");
    const r = await call({ branch: BRANCH, date: "2026-10-20", tzOffset: "0" });
    eq(r.code, 200, "status");
    eq(r.body.brokerCash, { EUR: 125, TRY: 50 }, "the branch's live balance");
    eq(
      r.body.brokerCashTransactions.map((t) => [t.Amount, t.Currency, t.Username]),
      [[50, "TRY", USER], [100, "EUR", USER]],
      "that day's and branch's manual top-ups, newest first"
    );
    eq(r.body.transactions, [], "the cash Transactions list stays cash only");
  });

  await check("the daily report totals the broker money of the day", async () => {
    resetTables();
    brokerTopUp(BRANCH, 100, "EUR", { CreatedAt: "2026-10-20 10:00:00" });
    brokerTopUp(OTHER, 50, "EUR", { CreatedAt: "2026-10-20 11:00:00" });
    brokerTopUp(BRANCH, 30, "TRY", { CreatedAt: "2026-10-21 09:00:00" });
    brokerTopUp(BRANCH, 20, "EUR", { Type: "annulment", CreatedAt: "2026-10-20 12:00:00" });
    await CC.recordCashMovement(
      fakeDb, BRANCH, USER, "increase", 15, "walk-in", "EUR", "2026-10-20 08:00:00"
    );
    // The day's insurance money: a walk-in cash policy and a policy funded
    // from a broker's balance. A manual increase (above) is not insurance
    // money, so it does not change the Total daily balance.
    tables.insurance.push(
      {
        BlancNumber: "T1",
        Branch: BRANCH,
        PaymentType: "Cash",
        Price: "25.00",
        CurrencyType: "EUR",
        CreationDate: "2026-10-20 09:00:00",
        Annulled: 0,
        Deleted: 0,
        BrokerId: null,
      },
      {
        BlancNumber: "T2",
        Branch: OTHER,
        PaymentType: "Broker",
        Price: "40.00",
        CurrencyType: "TRY",
        CreationDate: "2026-10-20 10:00:00",
        Annulled: 0,
        Deleted: 0,
        BrokerId: 3,
      }
    );

    const call = routeCaller("/currentcash/daily");
    let r = await call({ date: "2026-10-20", tzOffset: "0" });
    eq(r.code, 200, "status");
    eq(r.body.cashFromBrokers, { EUR: 150, TRY: 0 },
      "all branches, manual top-ups of the day only");
    eq(
      r.body.totalDailyBalance,
      { EUR: 25, TRY: 40 },
      "every insurance of the day, whatever the payment type"
    );

    r = await call({ date: "2026-10-20", tzOffset: "0", branch: BRANCH });
    eq(r.body.cashFromBrokers, { EUR: 100, TRY: 0 }, "scoped to the branch");
    eq(
      r.body.totalDailyBalance,
      { EUR: 25, TRY: 0 },
      "the branch's own insurance money"
    );
    eq(
      r.body.availableCash,
      { EUR: 40, TRY: 0 },
      "the drawer balance of that day: the 25 cash policy + the 15 manual increase, without the broker money"
    );
  });


  // ---------------------------------------------------------------------------
  console.log("\nHand over - money given to a person");
  // ---------------------------------------------------------------------------

  await check(
    "a hand-over lowers the drawer but is neither an expense nor daily cash",
    async () => {
      resetTables();
      // A cash policy of the day. Its sale row is written to the same ledger
      // (reason = the blanc number), and the drawer is 100 whether that row is
      // read or the policy is.
      tables.insurance.push({
        BlancNumber: "H1",
        Branch: BRANCH,
        PaymentType: "Cash",
        Price: "100.00",
        CurrencyType: "EUR",
        CreationDate: "2026-10-20 08:00:00",
        Annulled: 0,
        Deleted: 0,
        BrokerId: null,
      });
      await CC.recordCashMovement(
        fakeDb, BRANCH, USER, "increase", 100, "H1", "EUR", "2026-10-20 08:00:00"
      );
      await CC.recordCashMovement(
        fakeDb, BRANCH, USER, "reduce", 10, "pens", "EUR", "2026-10-20 09:00:00"
      );
      await CC.recordCashHandover(
        fakeDb, BRANCH, USER, 40, "Runner to the safe", "Ivan", "EUR",
        "2026-10-20 10:00:00"
      );

      eq(
        await CC.getCurrentCash(fakeDb, BRANCH),
        { EUR: 50, TRY: 0 },
        "the drawer drops by all three movements"
      );
      eq(
        tables.total_cash_transactions.length,
        2,
        "a hand-over writes no Total cash ledger row"
      );
      eq(
        tables.cash_transactions.map((r) => [r.Type, r.Amount, r.Recipient ?? null]),
        [
          ["increase", 100, null],
          ["reduce", 10, null],
          ["handover", 40, "Ivan"],
        ],
        "the ledger row names the person who took the money"
      );

      const ledger = routeCaller("/currentcash");
      let r = await ledger({ branch: BRANCH, date: "2026-10-20", tzOffset: "0" });
      eq(
        r.body.expences.map((t) => t.Amount),
        [10],
        "the hand-over is not an expense"
      );
      eq(
        r.body.totalExpences,
        { EUR: 10, TRY: 0 },
        "the expenses total keeps only what was spent"
      );
      eq(
        r.body.transactions.map((t) => t.Type),
        ["reduce", "handover"],
        "the sale row is the policy, not a transaction; the hand-over is listed"
      );

      const daily = routeCaller("/currentcash/daily");
      r = await daily({ date: "2026-10-20", tzOffset: "0" });
      eq(
        r.body.totalDailyBalance,
        { EUR: 100, TRY: 0 },
        "the policy's price; the hand-over never reduces the Total daily balance"
      );
      r = await daily({ date: "2026-10-20", tzOffset: "0", branch: BRANCH });
      eq(
        r.body.availableCash,
        { EUR: 50, TRY: 0 },
        "Available cash does lose the hand-over"
      );
    }
  );

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();

