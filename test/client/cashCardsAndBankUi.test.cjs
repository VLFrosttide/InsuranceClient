"use strict";

// UI test for the Current cash cards, the folded reports, the combined
// Transactions table and the admin-only bank account
// (renderer/WorkPage/WorkPage.js + renderer/common.js + app.css).
//
// Run with:  node test/client/cashCardsAndBankUi.test.cjs   (or: npm test)

const fs = require("fs");
const path = require("path");

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
function ok(value, msg) {
  if (!value) throw new Error(msg || "expected a truthy value");
}
function eq(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error((msg || "values differ") + ` (got ${a}, want ${b})`);
}

const ROOT = path.join(__dirname, "..", "..");
const WORKPAGE = fs.readFileSync(
  path.join(ROOT, "renderer", "WorkPage", "WorkPage.js"),
  "utf8"
);
const CSS = fs.readFileSync(
  path.join(ROOT, "renderer", "WorkPage", "WorkPage.css"),
  "utf8"
);
const COMMON = fs.readFileSync(path.join(ROOT, "renderer", "common.js"), "utf8");
// Whitespace-insensitive copy for regexes spanning lines (the file is CRLF).
const flat = WORKPAGE.replace(/\s+/g, " ");
const flatCommon = COMMON.replace(/\s+/g, " ");

console.log("Current cash cards, folded reports, combined transactions and bank");

check("the three big reports start folded", () => {
  ok(flat.includes('foldedCard(t("handoverStats")'), "hand-over statistics");
  ok(flat.includes('foldedCard(t("drawers")'), "drawers");
  ok(flat.includes('foldedCard(t("dailyReport")'), "daily report");
  const helper = WORKPAGE.slice(
    WORKPAGE.indexOf("function foldedCard("),
    WORKPAGE.indexOf("\n}", WORKPAGE.indexOf("function foldedCard("))
  );
  ok(helper.includes('el("details"'), "a details element");
  ok(!helper.includes("open = true"), "it is not opened by default");
  ok(CSS.includes(".balance-card.folded-card"), "the folded card is styled");
});

check("Available cash is a card without a branch name and opens walk-in cash", () => {
  ok(
    flat.includes('balanceCard.appendChild(el("h3", t("availableCash")))'),
    "the card title has no branch name"
  );
  ok(
    /activateCashCard\(\s*balanceCard,[\s\S]{0,500}?cashInsurancesSection/.test(
      WORKPAGE
    ),
    "clicking it opens the walk-in cash list"
  );
  ok(
    flat.includes('collapsibleSection( t("cashInsurances"),'),
    "the walk-in cash section exists"
  );
});

check("Card balance is a card that opens the walk-in card list", () => {
  ok(
    flat.includes('cardCard.appendChild(el("h3", t("cardBalance")))'),
    "the card is built for every role"
  );
  ok(
    /activateCashCard\(\s*cardCard,[\s\S]{0,500}?cardInsurancesSection/.test(
      WORKPAGE
    ),
    "clicking it opens the walk-in card list"
  );
});

check("Transactions is the first table on the page", () => {
  const view = WORKPAGE.indexOf("async function currentCashView(");
  const start = WORKPAGE.indexOf("Content.replaceChildren(", view);
  const block = WORKPAGE.slice(start, WORKPAGE.indexOf("\n}", start));
  const picker = block.indexOf("dateRow,");
  const transactions = block.indexOf("transactionsSection,");
  ok(picker >= 0 && transactions > picker, "Transactions follows the day picker");
  for (const section of [
    "cashInsurancesSection",
    "cardInsurancesSection",
    "brokerCashSection",
    "expensesSection",
    "resetsSection",
  ]) {
    ok(
      block.indexOf(section) > transactions,
      `${section} comes after Transactions`
    );
  }
});

check("the combined Transactions list reads every source", () => {
  ok(
    flat.includes("const combinedTransactions = combinedCashTransactions(data)"),
    "the table is built from the combined list"
  );
  const start = WORKPAGE.indexOf("function combinedCashTransactions(");
  const block = WORKPAGE.slice(start, WORKPAGE.indexOf("\n}", start));
  for (const key of [
    "transactions",
    "cashInsurances",
    "cardInsurances",
    "brokerInsurances",
    "brokerCashTransactions",
    "brokerHandovers",
  ]) {
    ok(block.includes(`source.${key}`), `it includes ${key}`);
  }
  ok(
    flat.includes('t("transactionPolicyCash")') &&
      flat.includes('t("transactionPolicyCard")') &&
      flat.includes('t("transactionPolicyBroker")'),
    "walk-in and broker policies have their own type labels"
  );
});

check("the bank account is admin-only and can hand money over", () => {
  ok(flat.includes("if (isAdmin && bank)"), "the bank card and section are admin-only");
  ok(flat.includes("isAdmin ? api(`/bank?tzOffset=${tzOffset}`)"), "the report is requested for admins");
  ok(flat.includes("function openBankHandoverForm()"), "a hand-over form exists");
  ok(flat.includes('api("/bank/handover"'), "it posts to the bank hand-over endpoint");
  ok(flat.includes('t("bankHandOver")'), "its action is labelled");
  ok(flat.includes("activateCashCard( bankCard, bankSection,"), "the bank card opens the bank section");
});

check("Cash from brokers list is the same money as the card", () => {
  ok(
    flat.includes(
      'el("p", t("brokerCashTransactionsHint"), { class: "muted" })'
    ),
    "the day's top-up list carries a hint"
  );
  ok(
    flatCommon.includes("card above shows the same top-ups"),
    "the hint says the card and the list are the same money"
  );
  ok(
    flatCommon.includes("a historical correction appears on its own day"),
    "the hint says a backdated top-up stays on its own day"
  );
  ok(
    !COMMON.includes("cashFromBrokersSinceReset"),
    "the old since-last-reset figure is gone"
  );
});

check("the new labels exist in both languages", () => {
  for (const key of [
    "cashInsurances",
    "cashInsurancesHint",
    "brokerCashTransactionsHint",
    "bankAccount",
    "bankAccountHint",
    "bankHandOver",
    "bankHandoverRecorded",
    "bankHandovers",
    "bankHistory",
    "bankClosingBalance",
    "transactionPolicyCash",
    "transactionPolicyCard",
    "transactionPolicyBroker",
  ]) {
    eq(
      (COMMON.match(new RegExp(`\\b${key}:`, "g")) || []).length,
      2,
      `${key} in EN and BG`
    );
  }
  ok(flatCommon.includes("Only admins see it"), "the bank hint says it is admin-only");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
