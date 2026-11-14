"use strict";

// Node test for the email card's Gmail conversation reader
// (InsuranceServer/Mail/threadHistory.js): every message is labelled as the
// client's or the employee's and ordered oldest first.
//
// Run with:  node Test/emailThreadHistory.test.cjs   (or: npm test)

const { serverFile } = require("./serverPath.cjs");
const { parseThreadMessages } = require(serverFile("Mail", "threadHistory.js"));

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

function b64url(text) {
  return Buffer.from(text, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function gmailMessage(id, from, date, text, internalDate) {
  return {
    id,
    internalDate,
    payload: {
      mimeType: "text/plain",
      headers: [
        { name: "From", value: from },
        { name: "Date", value: date },
        { name: "Subject", value: "Re: Policy" },
      ],
      body: { data: b64url(text) },
    },
  };
}

console.log("Email conversation history (Gmail thread)");

check("client and employee messages are labelled and ordered", () => {
  const messages = parseThreadMessages(
    [
      gmailMessage(
        "m2",
        "Insurance Office <office@example.com>",
        "Mon, 10 Nov 2026 10:00:00 +0200",
        "Attached, thank you.",
        1762761600000
      ),
      gmailMessage(
        "m1",
        "Broker <broker@example.com>",
        "Mon, 10 Nov 2026 09:00:00 +0200",
        "Please issue the policy.",
        1762758000000
      ),
      gmailMessage(
        "m3",
        "Broker <broker@example.com>",
        "Mon, 10 Nov 2026 12:00:00 +0200",
        "Thanks, received.",
        1762768800000
      ),
    ],
    "Broker <broker@example.com>"
  );
  eq(
    messages.map((m) => m.id),
    ["m1", "m2", "m3"],
    "oldest first"
  );
  eq(
    messages.map((m) => m.direction),
    ["client", "employee", "client"],
    "directions"
  );
  eq(messages[0].text, "Please issue the policy.", "body text");
});

check("the sender address is matched without the display name", () => {
  const messages = parseThreadMessages(
    [
      gmailMessage(
        "m1",
        "BROKER@example.com",
        "Mon, 10 Nov 2026 09:00:00 +0200",
        "Hi",
        1
      ),
    ],
    "Broker <broker@example.com>"
  );
  eq(messages[0].direction, "client", "case-insensitive address");
});

check("a thread without messages yields an empty list", () => {
  eq(parseThreadMessages(undefined, "b@example.com"), [], "empty");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
