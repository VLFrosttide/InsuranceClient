"use strict";

// Node test for the email cards' conversation history and "answered" state
// (renderer/emailConversation.js).
//
// Runs the REAL renderer files in a vm (they are classic browser <script>s)
// with a tiny in-memory Storage, so the same code that runs in Electron is
// under test.
//
// Run with:  node Test/emailConversation.test.cjs   (or: npm test)

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const CTX = { console, Date, JSON, Math, Number, Object, Array, String, Set, Map };
vm.createContext(CTX);
for (const file of ["emailThread.js", "emailConversation.js"]) {
  vm.runInContext(
    fs.readFileSync(path.join(ROOT, "renderer", file), "utf8"),
    CTX,
    { filename: file }
  );
}
const M = CTX;

// --- tiny Storage stand-in ---------------------------------------------------
function makeStorage() {
  const data = new Map();
  return {
    getItem: (key) => (data.has(key) ? String(data.get(key)) : null),
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: (key) => data.delete(key),
  };
}

// --- tiny assert helpers -----------------------------------------------------
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
  if (!value) throw new Error(label);
}

const KEY = "thread:t1";

console.log("Email card conversation + answered state");

check("messages of both directions are stored oldest first", () => {
  const storage = makeStorage();
  M.emailConversationRecord(storage, KEY, {
    id: "m1:0",
    direction: "client",
    from: "Broker <b@example.com>",
    text: "Please issue the policy.",
    at: 200,
  });
  M.emailConversationRecord(storage, KEY, {
    id: "employee:1",
    direction: "employee",
    from: "worker",
    text: "Attached.",
    at: 300,
    source: "employee",
  });
  const list = M.emailConversationFor(storage, KEY, 400);
  eq(list.map((m) => m.direction), ["client", "employee"], "directions");
  eq(list.map((m) => m.at), [200, 300], "order");
  eq(list[1].source, "employee", "source kept");
});

check("the same message is stored only once", () => {
  const storage = makeStorage();
  const message = { id: "m1:0", direction: "client", text: "Hello", at: 100 };
  M.emailConversationRecord(storage, KEY, message);
  M.emailConversationRecord(storage, KEY, message);
  eq(M.emailConversationFor(storage, KEY, 200).length, 1, "deduplicated");
});

check("empty bodies are not stored", () => {
  const storage = makeStorage();
  M.emailConversationRecord(storage, KEY, {
    id: "m1:0",
    direction: "client",
    text: "   ",
    at: 100,
  });
  eq(M.emailConversationFor(storage, KEY, 200), [], "nothing stored");
});

check("an answered record applies while no new email arrives", () => {
  const storage = makeStorage();
  M.emailMarkAnswered(
    storage,
    KEY,
    { at: 500, by: "worker", messageIds: ["m1"] },
    500
  );
  const record = M.emailAnsweredFor(storage, KEY, 600);
  eq(record.by, "worker", "record read back");
  ok(M.emailAnsweredApplies(record, ["m1"]), "still applies");
});

check("a new email in the conversation revives the card", () => {
  const storage = makeStorage();
  M.emailMarkAnswered(
    storage,
    KEY,
    { at: 500, by: "worker", messageIds: ["m1"] },
    500
  );
  const record = M.emailAnsweredFor(storage, KEY, 600);
  ok(!M.emailAnsweredApplies(record, ["m1", "m2"]), "broker answered");
});

check("clearing the answered state removes it", () => {
  const storage = makeStorage();
  M.emailMarkAnswered(storage, KEY, { at: 500, messageIds: ["m1"] }, 500);
  M.emailClearAnswered(storage, KEY);
  eq(M.emailAnsweredFor(storage, KEY, 600), null, "cleared");
});

check("old answered records expire", () => {
  const storage = makeStorage();
  M.emailMarkAnswered(storage, KEY, { at: 1, messageIds: ["m1"] }, 1);
  eq(
    M.emailAnsweredFor(storage, KEY, 1 + 31 * 24 * 60 * 60 * 1000),
    null,
    "expired"
  );
});

check("changing a card key moves its history and answered state", () => {
  const storage = makeStorage();
  M.emailConversationRecord(storage, "subject:x|b@example.com", {
    id: "m1:0",
    direction: "client",
    text: "Hello",
    at: 100,
  });
  M.emailMarkAnswered(
    storage,
    "subject:x|b@example.com",
    { at: 150, messageIds: ["m1"] },
    150
  );
  M.emailConversationReKey(storage, "subject:x|b@example.com", KEY);
  M.emailAnsweredReKey(storage, "subject:x|b@example.com", KEY);
  eq(M.emailConversationFor(storage, KEY, 200).length, 1, "history moved");
  ok(M.emailAnsweredFor(storage, KEY, 200), "answered moved");
  eq(
    M.emailConversationFor(storage, "subject:x|b@example.com", 200),
    [],
    "old key empty"
  );
});

check("the quoted emails become labelled history messages", () => {
  const email = {
    messageId: "m3",
    threadId: "t1",
    subject: "Re: Policy",
    from: "Broker <broker@example.com>",
    date: "Mon, 10 Nov 2026 12:00:00 +0200",
    body: [
      "Thanks, received.",
      "",
      "On Mon, 10 Nov 2026 10:00:00 +0200, Insurance <office@example.com> wrote:",
      "> Attached.",
      "",
      "On Mon, 10 Nov 2026 09:00:00 +0200, Broker <broker@example.com> wrote:",
      "> Please issue the policy.",
    ].join("\n"),
  };
  const messages = M.emailConversationMessagesFromThread(email);
  eq(messages[0].direction, "client", "newest is the client");
  eq(messages[1].direction, "employee", "our reply is recognised");
  eq(messages[2].direction, "client", "earlier client email");
  ok(
    messages.every((m) => m.source === "thread"),
    "source marked as quoted"
  );
  eq(messages[0].id, "m3:0", "stable id");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

