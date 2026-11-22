"use strict";

// Node test for the broker-history patch (InsuranceServer/db/repair-broker-ledger.js).
//
// The repair exists because a broker's balance history pairs a ledger row with a
// policy by its BlancNumber. A row left under the policy's PREVIOUS blanc (the
// blanc was corrected after the row was written) belongs to no live policy, so
// the history page hides it: the insurance exists and the broker is charged, yet
// the charge is missing from that day's history. The reverse happens when a
// charged policy has no row at all.
//
// What must hold:
//   - a sale row under the policy's old blanc is relabelled to the current one
//     (also when the policy already owns other rows there, e.g. an annulment);
//   - a charged policy with no row gets its sale row back;
//   - a soft-deleted (voided) charge is only reported, never re-inserted or
//     un-hidden - that would change money;
//   - an annulled policy whose visible rows already add up to the tax the
//     balance keeps is left alone;
//   - anything that does not add up and cannot be matched is reported.
//
// Run with:  node Test/brokerLedgerRepair.test.cjs   (or: npm test)

const { serverFile } = require("./serverPath.cjs");

const REPAIR_JS = serverFile("db", "repair-broker-ledger.js");
const { planBroker, insuranceCharge } = require(REPAIR_JS);

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
function ok(value, msg) {
  if (!value) throw new Error(msg || "expected a truthy value");
}

const broker = { id: 9, Name: "Test", Payments: 0, StartingBalance: null };
function policy(blanc, extra = {}) {
  return {
    BlancNumber: blanc,
    PolicyNumber: `P${blanc}`,
    Author: "ann",
    CreationDate: "2026-10-21 13:21:14",
    Price: 45,
    Annulled: 0,
    AnnulReason: null,
    AnnulFee: null,
    Deleted: 0,
    ...extra,
  };
}
function row(extra = {}) {
  return {
    id: 1,
    Type: "policy",
    Amount: -45,
    BlancNumber: "169979",
    Reason: "169979",
    Author: "ann",
    CreatedAt: "2026-10-21 13:21:14",
    Deleted: 0,
    ...extra,
  };
}

(async () => {
  await check("a sale row under the policy's old blanc is relabelled", () => {
    const plan = planBroker(
      broker,
      [row({ id: 11, BlancNumber: "776247", Reason: "776247" })],
      [policy("169979")]
    );
    eq(
      plan.actions.map((a) => [a.movementId, a.from, a.to]),
      [[11, "776247", "169979"]],
      "the orphan sale row is attached to the policy"
    );
    eq(plan.inserts.length, 0, "nothing is inserted when it can be relabelled");
    eq(plan.difference, 0, "the history adds up after the relabel");
  });

  await check("rows already under the new blanc do not block the relabel", () => {
    const plan = planBroker(
      broker,
      [
        row({ id: 11, BlancNumber: "776247", Reason: "776247" }),
        row({
          id: 12,
          Type: "annulment",
          Amount: 44,
          CreatedAt: "2026-10-30 14:17:46",
        }),
      ],
      [
        policy("169979", {
          Annulled: 1,
          AnnulReason: "broker",
          AnnulFee: 1,
          Price: 1,
        }),
      ]
    );
    eq(plan.actions.map((a) => a.movementId), [11], "the sale row is relabelled");
    eq(plan.unresolved.length, 0, "the policy is not reported any more");
  });

  await check("a charged policy with no row gets its sale row back", () => {
    const plan = planBroker(broker, [], [policy("169979")]);
    eq(
      plan.inserts.map((i) => [i.blancNumber, i.amount, i.createdAt]),
      [["169979", -45, "2026-10-21 13:21:14"]],
      "the missing charge is written with its amount and creation time"
    );
    eq(plan.difference, 0, "the history adds up after the insert");
  });

  await check("a voided charge is reported, never restored", () => {
    const plan = planBroker(
      broker,
      [row({ id: 12, Deleted: 1 })],
      [policy("169979")]
    );
    eq(plan.voids.map((v) => v.blancNumber), ["169979"], "the void is listed");
    eq(plan.inserts.length, 0, "a void is never re-inserted");
    eq(plan.difference, 0, "a void keeps the history and the balance in step");
  });

  await check("a consistent history needs nothing", () => {
    const plan = planBroker(broker, [row({ id: 13 })], [policy("169979")]);
    eq(
      [
        plan.actions.length,
        plan.inserts.length,
        plan.voids.length,
        plan.unresolved.length,
        plan.difference,
      ],
      [0, 0, 0, 0, 0],
      "nothing to do"
    );
  });

  await check("a moved-away policy's sale row is never re-attached", () => {
    const plan = planBroker(
      broker,
      [row({ id: 16, BlancNumber: "174999", Reason: "174999" })],
      [policy("169979")],
      { foreignBlancs: new Set(["174999"]) }
    );
    eq(plan.actions.length, 0, "the row of another broker's policy is left alone");
    eq(
      plan.inserts.length,
      0,
      "the same money may be that moved row, so nothing is guessed"
    );
    eq(
      plan.unresolved.map((u) => u.problem),
      ["sale row exists under another blanc"],
      "the ambiguity is reported for review"
    );
  });

  await check("a visible annulment tax is left alone", () => {
    const plan = planBroker(
      broker,
      [
        row({
          id: 14,
          Type: "annulment",
          Amount: -1,
          BlancNumber: "155645",
          CreatedAt: "2026-10-26 11:25:55",
        }),
      ],
      [
        policy("155645", {
          Price: 1,
          OriginalPrice: 32,
          Annulled: 1,
          AnnulReason: "broker",
          AnnulFee: 1,
        }),
      ]
    );
    eq(
      [
        plan.actions.length,
        plan.inserts.length,
        plan.voids.length,
        plan.unresolved.length,
      ],
      [0, 0, 0, 0],
      "the policy's money is already visible"
    );
  });

  await check("an annulled policy with no rows is reported, not guessed", () => {
    const plan = planBroker(broker, [], [
      policy("171895", {
        Price: 1,
        OriginalPrice: 32,
        Annulled: 1,
        AnnulReason: "broker",
        AnnulFee: 1,
      }),
    ]);
    eq(plan.inserts.length, 0, "no sale row is invented");
    eq(
      plan.unresolved.map((u) => u.problem),
      ["annulled policy has no ledger row"],
      "the policy is listed for review"
    );
  });

  await check("rows that do not add up to the charge are reported", () => {
    const plan = planBroker(
      broker,
      [row({ id: 15, Amount: -40, BlancNumber: "173882", Reason: "100612" })],
      [policy("173882", { Price: 26 })]
    );
    eq(
      plan.unresolved.map((u) => [u.blancNumber, u.charge, u.visibleNet]),
      [["173882", 26, -40]],
      "the mismatch is listed with what is shown and what is charged"
    );
  });

  await check("the charge of an annulled policy follows who paid", () => {
    eq(
      insuranceCharge({
        Annulled: 1,
        AnnulReason: "worker",
        AnnulFee: 5,
        Price: 5,
        Deleted: 0,
      }),
      0,
      "a worker-paid annulment costs the broker nothing"
    );
    eq(
      insuranceCharge({
        Annulled: 1,
        AnnulReason: "broker",
        AnnulFee: 5,
        Price: 5,
        Deleted: 0,
      }),
      5,
      "a broker-paid annulment keeps its tax"
    );
    eq(
      insuranceCharge({ Annulled: 0, Price: 32, Deleted: 0 }),
      32,
      "a live policy charges its price"
    );
  });

  ok(REPAIR_JS.endsWith("repair-broker-ledger.js"), "the real server file is used");
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed === 0 ? 0 : 1;
})();

