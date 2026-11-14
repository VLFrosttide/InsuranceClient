"use strict";

// Node test for the server-side "answered" state of email threads
// (InsuranceServer/Mail/mailStore.js): a reply parks every email of the
// thread, and a new email (the broker's answer) clears it again.
//
// Run with:  node Test/mailStoreAnswered.test.cjs   (or: npm test)

const { serverFile } = require("./serverPath.cjs");
const mailStore = require(serverFile("Mail", "mailStore.js"));

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

function email(account, messageId, threadId) {
  return {
    account,
    messageId,
    threadId,
    from: "Broker <broker@example.com>",
    subject: "Policy",
    body: "Hi",
  };
}

console.log("Email thread answered state");

check("marking a reply stamps every email of the conversation", () => {
  const first = mailStore.add(email("a1", "m1", "t1"));
  const second = mailStore.add(email("a1", "m2", "t1"));
  mailStore.markAnswered("m2", "worker", "done", 1234);
  eq(first.answeredAt, 1234, "first email parked");
  eq(second.answeredBy, "worker", "second email parked");
  eq(mailStore.answeredFor(first).at, 1234, "record available");
});

check("another conversation is not marked", () => {
  const other = mailStore.add(email("a1", "m3", "t2"));
  eq(other.answeredAt, undefined, "other thread untouched");
});

check("a new email in the thread clears the answered state", () => {
  const email1 = mailStore.get("m1");
  mailStore.clearAnsweredForThread("a1", "t1");
  eq(email1.answeredAt, undefined, "answeredAt removed");
  eq(email1.answeredBy, undefined, "answeredBy removed");
  eq(mailStore.answeredFor(email1), null, "record removed");
});

check("removing the last email forgets the conversation state", () => {
  mailStore.markAnswered("m1", "worker", "done", 2000);
  mailStore.remove("m1");
  mailStore.remove("m2");
  eq(mailStore.answeredFor(email("a1", "m1", "t1")), null, "forgotten");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
