"use strict";

// Node test for the drawer-ledger blanc patch
// (InsuranceServer/db/repair-cash-ledger-blanc.js).
//
// The repair exists because the drawer ledger pairs a row with a policy by its
// Reason: the sale row carries the policy's blanc number. When the blanc was
// corrected in the insurance editor, the row written before that kept the old
// number, so no policy had it any more. The derived drawer then read the row as
// money typed in BY HAND, counting the policy's price twice that day.
//
// What must hold:
//   - a sale row under the old blanc is relabelled to the policy's blanc;
//   - that also works when the price was corrected later (the policy's current
//     price is no longer the sale amount, but its "Edit <blanc>" reversal is);
//   - nothing is relabelled without an unambiguous policy: no candidate, several
//     candidates, a policy that already owns its sale row, or a row that is not
//     an increase are all only reported;
//   - the relabel never touches an amount, current_cash or the policy.
//
// Run with:  node test/server/cashLedgerBlancRepair.test.cjs   (or: npm test)

const { serverFile } = require("../serverPath.cjs");

const REPAIR_JS = serverFile("db", "repair-cash-ledger-blanc.js");
const { findStrandedSales } = require(REPAIR_JS);

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
function ok(value, msg) {
  if (!value) throw new Error(msg || "expected a truthy value");
}

const BRANCH = "Офис Харманли";
const WHEN = "2026-11-22 13:06:29";

// A policy as the repair reads it: a walk-in cash policy of the branch.
function policy(blanc, extra = {}) {
  return {
    BlancNumber: blanc,
    PolicyNumber: `P${blanc}`,
    Branch: BRANCH,
    Author: "DEQN",
    CreationDate: WHEN,
    Price: 40,
    CurrencyType: "EUR",
    PaymentType: "Cash",
    BrokerId: null,
    Deleted: 0,
    ...extra,
  };
}

// A drawer row. The stranded ones carry a numeric reason no policy has.
function row(extra = {}) {
  return {
    id: 1,
    Branch: BRANCH,
    Type: "increase",
    Amount: 40,
    Currency: "EUR",
    Username: "DEQN",
    Reason: "201146",
    CreatedAt: WHEN,
    Deleted: 0,
    ...extra,
  };
}

// The three statements findStrandedSales issues, answered from the tables.
function fakeConn(tables) {
  return {
    query: async (sql, params) => {
      const s = String(sql).replace(/\s+/g, " ").trim();
      if (
        s.includes("LEFT JOIN insurance p ON p.BlancNumber = ct.Reason") &&
        s.includes("REGEXP")
      ) {
        return [tables.orphans.map((r) => ({ ...r }))];
      }
      if (s.includes("FROM insurance i")) {
        const [createdAt, branch, author, currency] = params || [];
        const rows = (tables.policies || [])
          .filter(
            (p) =>
              p.CreationDate === createdAt &&
              p.Branch === branch &&
              p.Author === author &&
              p.CurrencyType === currency &&
              p.PaymentType === "Cash" &&
              (p.BrokerId === null || p.BrokerId === undefined)
          )
          .map((p) => {
            const edit = (tables.ledger || []).find(
              (l) =>
                l.Reason === `Edit ${p.BlancNumber}` &&
                l.Type === "reduce" &&
                !l.Deleted
            );
            return {
              BlancNumber: p.BlancNumber,
              PolicyNumber: p.PolicyNumber,
              Deleted: p.Deleted,
              Price: p.Price,
              CreatedAt: p.CreationDate,
              EditedFrom: edit ? edit.Amount : 0,
            };
          });
        return [rows];
      }
      if (s.startsWith("SELECT COUNT(*) AS n FROM cash_transactions")) {
        const [reason, branch, createdAt] = params || [];
        const n = (tables.ledger || []).filter(
          (l) =>
            l.Reason === reason &&
            l.Branch === branch &&
            l.Type === "increase" &&
            l.CreatedAt === createdAt
        ).length;
        return [[{ n }]];
      }
      throw new Error("fake DB: unhandled SQL -> " + s);
    },
  };
}

async function plan(tables) {
  return findStrandedSales(fakeConn(tables));
}

(async () => {
  await check("a sale row under the number typed first is re-attached", async () => {
    const found = await plan({ orphans: [row()], policies: [policy("201148")] });
    eq(found.length, 1, "one orphan");
    eq(
      found[0].target && found[0].target.BlancNumber,
      "201148",
      "the policy's blanc"
    );
    eq(found[0].target.PolicyNumber, "P201148", "and its policy number");
  });

  await check("a later price correction does not hide the pairing", async () => {
    // The sale was 25 while the policy's price is 40 now: its "Edit" reversal
    // still shows what the sale was.
    const found = await plan({
      orphans: [row({ id: 2, Amount: 25, Reason: "176592" })],
      policies: [policy("176593")],
      ledger: [
        {
          Branch: BRANCH,
          Type: "reduce",
          Amount: 25,
          Reason: "Edit 176593",
          CreatedAt: "2026-11-18 08:33:50",
          Deleted: 0,
        },
      ],
    });
    eq(found[0].target && found[0].target.BlancNumber, "176593", "re-attached");
  });

  await check("no candidate policy is only reported", async () => {
    const found = await plan({
      orphans: [row({ Reason: "169455" })],
      policies: [policy("201148", { Author: "someone" })],
    });
    eq(found[0].target, null, "not attached");
    ok(found[0].reason.includes("no policy"), "reason: " + found[0].reason);
  });

  await check("several candidate policies are too ambiguous", async () => {
    const found = await plan({
      orphans: [row()],
      policies: [policy("201148"), policy("201149")],
    });
    eq(found[0].target, null, "not attached");
    ok(found[0].reason.includes("ambiguous"), "reason: " + found[0].reason);
  });

  await check("a policy that owns its sale row blocks the relabel", async () => {
    const found = await plan({
      orphans: [row()],
      policies: [policy("201148")],
      ledger: [
        {
          Branch: BRANCH,
          Type: "increase",
          Amount: 40,
          Reason: "201148",
          CreatedAt: WHEN,
          Deleted: 0,
        },
      ],
    });
    eq(found[0].target, null, "not attached");
    ok(found[0].reason.includes("already has"), "reason: " + found[0].reason);
  });

  await check("a numeric manual entry is only reported", async () => {
    const found = await plan({
      orphans: [row({ Type: "reduce" })],
      policies: [policy("201148")],
    });
    eq(found[0].target, null, "not attached");
    ok(found[0].reason.includes("not an increase"), "reason: " + found[0].reason);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
