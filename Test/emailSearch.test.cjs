"use strict";

// Node test for the email card search helpers (renderer/emailSearch.js): the
// search bar on the "Unread emails" tab filters the cards currently on the
// dashboard by their content - subject, sender, body, broker code and the
// locally stored replies. Runs the REAL renderer file in a vm.
//
// Run with:  node Test/emailSearch.test.cjs   (or: npm test)

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const CTX = { console };
vm.createContext(CTX);
vm.runInContext(
  fs.readFileSync(
    path.join(__dirname, "..", "renderer", "emailSearch.js"),
    "utf8"
  ),
  CTX,
  { filename: "emailSearch.js" }
);
const {
  emailSearchNormalize,
  emailSearchTokens,
  emailSearchMatches,
  emailCardSearchText,
  emailCardMatchesSearch,
} = CTX;

let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    fn();
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
function ok(value, label) {
  if (!value) throw new Error(label || "expected a truthy value");
}

// Two emails of one conversation: the original request and a reply. The reply
// quotes the request inside its body, exactly like Gmail does.
const CARD = {
  key: "thread:t1",
  brokerCode: "1.9",
  email: {
    messageId: "m2",
    subject: "Re: Policy for CA 1234 AB",
    from: "Broker One <broker@example.com>",
    body: "Attaching the policy now.\n\n> Original request...",
  },
  emails: [
    {
      messageId: "m1",
      subject: "Policy for CA 1234 AB",
      from: "Broker One <broker@example.com>",
      body: "Please issue a policy for car CA 1234 AB, driver Ivan Petrov.",
    },
    {
      messageId: "m2",
      subject: "Re: Policy for CA 1234 AB",
      from: "Broker One <broker@example.com>",
      body: "Attaching the policy now.\n\n> Original request...",
    },
  ],
};

console.log("Email card search");

check("normalization folds case and collapses whitespace", () => {
  eq(emailSearchNormalize("  Policy   No.  123 "), "policy no. 123", "text");
  eq(emailSearchNormalize(null), "", "null");
  eq(emailSearchNormalize(undefined), "", "undefined");
  eq(emailSearchNormalize("ЛЕСОВО"), "лесово", "Cyrillic upper case");
});

check("the query is split into distinct words", () => {
  eq(emailSearchTokens("Policy policy  123"), ["policy", "123"], "tokens");
  eq(emailSearchTokens("   "), [], "blank");
  eq(emailSearchTokens(""), [], "empty");
});

check("a blank query matches everything", () => {
  eq(emailSearchMatches("anything", ""), true, "empty");
  eq(emailSearchMatches("anything", "   "), true, "spaces");
  eq(emailCardMatchesSearch(CARD, ""), true, "card");
});

check("the subject is searched, case-insensitively", () => {
  ok(emailCardMatchesSearch(CARD, "policy"), "lower case");
  ok(emailCardMatchesSearch(CARD, "POLICY"), "upper case");
  ok(emailCardMatchesSearch(CARD, "pOlIcY"), "mixed case");
  ok(emailCardMatchesSearch(CARD, "1234"), "number");
  ok(emailCardMatchesSearch(CARD, "olic"), "substring");
});

check("the sender and the broker code are searched", () => {
  ok(emailCardMatchesSearch(CARD, "broker@example.com"), "address");
  ok(emailCardMatchesSearch(CARD, "Broker One"), "display name");
  ok(emailCardMatchesSearch(CARD, "1.9"), "broker code");
});

check("the body of every email is searched", () => {
  ok(emailCardMatchesSearch(CARD, "Ivan Petrov"), "original body");
  ok(emailCardMatchesSearch(CARD, "Attaching the policy"), "reply body");
});

check("every word must match, in any order and in any field", () => {
  ok(emailCardMatchesSearch(CARD, "1234 Ivan"), "subject + body");
  ok(emailCardMatchesSearch(CARD, "Ivan 1234"), "reverse order");
  ok(!emailCardMatchesSearch(CARD, "1234 Nikolay"), "one missing word");
  ok(!emailCardMatchesSearch(CARD, "tractor"), "nothing matches");
});

check("cards only need the entry email instead of the whole array", () => {
  const entry = { email: CARD.email, brokerCode: "1.9" };
  ok(emailCardMatchesSearch(entry, "attaching"), "body");
  ok(emailCardMatchesSearch(entry, "1.9"), "code");
});

check("stored conversation replies are searchable too", () => {
  const extras = ["Employee: I sent the policy by email."];
  ok(emailCardMatchesSearch(CARD, "sent the policy", extras), "reply text");
  ok(!emailCardMatchesSearch(CARD, "sent the policy"), "not in the emails");
  eq(
    emailCardSearchText(CARD, extras).includes("Employee: I sent the policy"),
    true,
    "searchable text contains the reply"
  );
});

check("Cyrillic content is matched (broker emails are often Bulgarian)", () => {
  const card = {
    email: {
      subject: "Застраховка за автомобил",
      from: "ГКПП Лесово <office@example.com>",
      body: "Моля, издайте полица за кола СА 1234 АВ.",
    },
  };
  ok(emailCardMatchesSearch(card, "лесово"), "lower case Cyrillic");
  ok(emailCardMatchesSearch(card, "ЛЕСОВО"), "upper case Cyrillic");
  ok(emailCardMatchesSearch(card, "полица"), "Cyrillic body word");
  ok(!emailCardMatchesSearch(card, "lesovo"), "Latin query needs Latin text");
});

check("missing and empty cards do not throw", () => {
  eq(emailCardMatchesSearch(null, ""), true, "null with blank query");
  eq(emailCardMatchesSearch(null, "x"), false, "null with a query");
  eq(emailCardMatchesSearch({}, "x"), false, "empty entry");
  eq(emailCardSearchText({}), "", "no searchable text");
  eq(
    emailCardSearchText({ emails: [null, { subject: "", body: null }] }),
    "",
    "empty fields are skipped"
  );
});

check("the joined text separates fields with a newline", () => {
  const text = emailCardSearchText({
    emails: [{ subject: "Subject", from: "a@b.c", body: "Body" }],
    brokerCode: "7",
  });
  eq(text, "Subject\na@b.c\nBody\n7", "text");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
