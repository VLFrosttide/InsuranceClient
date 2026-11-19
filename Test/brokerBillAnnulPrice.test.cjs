"use strict";

// Node test for the annulled-policy amounts in a broker bill.
//
// Once an annulled policy's tax becomes its new Price, the original sale price
// lives in OriginalPrice. A refund to the broker is still `original - tax`, so
// the bill must use OriginalPrice (and fall back to Price only for older rows
// that predate the column). The tax itself is what the policy is charged.
//
// Runs against the REAL InsuranceServer/db/brokerBills.js (see
// Test/serverPath.cjs), so a change to the production helpers is caught here.
//
// Run with:  node Test/brokerBillAnnulPrice.test.cjs   (or: npm test)

const { serverFile } = require("./serverPath.cjs");
const {
  refundAmount,
  policyAmount,
  toBillLine,
  priceLineForBroker,
} = require(serverFile("db", "brokerBills.js"));

let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    fn();
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

console.log("Broker bills — annulled policies (tax is Price, original is kept)");

check("a converted annulled row is billed its tax", () => {
  const row = {
    Price: "9",
    OriginalPrice: "100",
    AnnulFee: "9",
    Annulled: 1,
  };
  eq(policyAmount(row), 9, "charged amount");
  eq(toBillLine(row).amount, 9, "bill line amount");
});

check("a converted annulled row refunds original - tax", () => {
  eq(
    refundAmount({
      Price: "9",
      OriginalPrice: "100",
      AnnulFee: "9",
      Annulled: 1,
    }),
    91,
    "100 - 9"
  );
});

check("an older annulled row without OriginalPrice still refunds", () => {
  eq(
    refundAmount({ Price: "100", AnnulFee: "9", Annulled: 1 }),
    91,
    "falls back to Price"
  );
});

check("a sub-broker refund uses its own display price", () => {
  eq(
    refundAmount(
      { Price: "9", OriginalPrice: "100", AnnulFee: "9", Annulled: 1 },
      120
    ),
    111,
    "120 - 9"
  );
});

check("an annulled sub-broker line is charged the tax, not the tariff", () => {
  const row = {
    Price: "9",
    OriginalPrice: "100",
    AnnulFee: "9",
    Annulled: 1,
    Otomobil: "Automobile",
    Duration: 15,
  };
  const line = toBillLine(row);
  const priced = priceLineForBroker(
    line,
    row,
    { subPricing: { Automobile: { 15: 120 } }, priceFor: () => 120 }
  );
  eq(priced.amount, 9, "charged at the tax");
  eq(priced.cost, 9, "cost to us is the tax too");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
