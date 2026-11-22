"use strict";

// UI test for the hand-over dates and the broker hand-over's "Received by"
// field (renderer/WorkPage/WorkPage.js + renderer/common.js).
//
// Run with:  node Test/handoverDates.test.cjs   (or: npm test)

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

const ROOT = path.join(__dirname, "..");
const WORKPAGE_JS = path.join(ROOT, "renderer", "WorkPage", "WorkPage.js");
const COMMON_JS = path.join(ROOT, "renderer", "common.js");
const source = fs.readFileSync(WORKPAGE_JS, "utf8");
const common = fs.readFileSync(COMMON_JS, "utf8");

// From a marker up to the next marker (exclusive).
function between(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  ok(start !== -1, "could not find " + startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  ok(end !== -1, "could not find " + endMarker);
  return source.slice(start, end);
}

// One top-level function, from its first line to the first "}" at column 0.
function cutFunction(marker) {
  const start = source.indexOf(marker);
  ok(start !== -1, "could not find " + marker);
  const tail = source.slice(start);
  const closing = /\r?\n}\r?\n/.exec(tail);
  ok(closing, "could not find the end of " + marker);
  return tail.slice(0, closing.index + closing[0].length);
}

console.log("Hand-over dates and the broker 'Received by' field");

check("the cash forms give admins a date-and-time picker on creation", () => {
  const block = between(
    "function cashForm(kind, title) {",
    "function openTransactionEditor(tx) {"
  );
  ok(block.includes("if (isAdmin)"), "admins only");
  ok(block.includes('key: "date"'), "a date field");
  ok(block.includes('t("handoverDate")'), "the hand-over label");
  ok(block.includes('t("increaseDate")'), "the increase label");
  ok(block.includes('t("expenseDate")'), "the expense label");
  ok(block.includes('type: "datetime-local"'), "a 24-hour date-and-time picker");
  ok(block.includes("localDateTimeInputNow()"), "it opens on now");
  ok(block.includes("max: localDateString()"), "the future cannot be picked");
  ok(
    block.includes("brokerMovementCreatedAt(picked)"),
    "the picked day and clock become CreatedAt"
  );
  ok(block.includes("payload.time = parts.time"), "the clock is sent as `time`");
});

check("the cash hand-over editor lets an admin change the day and the clock", () => {
  const block = between(
    "function openTransactionEditor(tx) {",
    "// Undo a hand-over"
  );
  ok(block.includes("if (isHandover)"), "the field is only for hand-overs");
  ok(block.includes("if (isAdmin)"), "admins only");
  ok(block.includes('key: "date"'), "a date field");
  ok(block.includes('type: "datetime-local"'), "a 24-hour date-and-time picker");
  ok(
    block.includes("datetimeInputValue(tx.CreatedAt)"),
    "the stored day and time are shown"
  );
  ok(block.includes("max: localDateString()"), "the future cannot be picked");
  ok(block.includes("payload.time = parts.time"), "the clock is sent as `time`");
  ok(block.includes("payload.TzOffset"), "the server is told the offset");
});

check("an admin can edit a hand-over recorded by someone else", () => {
  ok(
    source.includes('(isAdmin && String(tx.Type || "") === "handover")'),
    "the Edit action is offered for another user's hand-over"
  );
});

check("the broker hand-over form asks who received the money", () => {
  const block = cutFunction("function brokerAdjust(broker, kind) {");
  ok(block.includes('if (kind === "handover")'), "hand-over only");
  ok(block.includes('key: "Recipient"'), "a recipient field");
  ok(block.includes('t("handedTo")'), "the Received by label");
  ok(block.includes('t("handedToPlaceholder")'), "its placeholder");
});

check("the broker hand-over form gives admins a date-and-time picker", () => {
  const block = cutFunction("function brokerAdjust(broker, kind) {");
  ok(
    block.includes(
      '(kind === "increase" || kind === "handover") && userRole === "1"'
    ),
    "admins only, for top-ups and hand-overs"
  );
  ok(block.includes('t("handoverDate")'), "the hand-over label");
  ok(block.includes('t("handoverDateHint")'), "the explanation");
  ok(block.includes('type: "datetime-local"'), "a 24-hour date-and-time picker");
  ok(block.includes("localDateTimeInputNow()"), "it opens on now");
  ok(block.includes("max: localDateString()"), "the future cannot be picked");
  ok(
    block.includes("payload.CreatedAt = brokerMovementCreatedAt("),
    "the picked day and clock become CreatedAt"
  );
  ok(block.includes("payload.time = parts.time"), "the clock is sent as `time`");
});

check("the broker history editor corrects a hand-over's recipient, day and clock", () => {
  const block = cutFunction(
    "function brokerHistoryEditForm(broker, movement, page, date, includeDeleted = false) {"
  );
  ok(block.includes('key: "Recipient"'), "a recipient field");
  ok(block.includes('key: "date"'), "a date field");
  ok(block.includes('type: "datetime-local"'), "a 24-hour date-and-time picker");
  ok(
    block.includes("datetimeInputValue(movement.CreatedAt)"),
    "the stored day and time are shown"
  );
  ok(block.includes("max: localDateString()"), "the future cannot be picked");
  ok(block.includes("payload.time = parts.time"), "the clock is sent as `time`");
  ok(block.includes("payload.TzOffset"), "the server is told the offset");
});

check("the broker history shows a Received by column", () => {
  ok(
    source.includes('key: "Recipient"') &&
      source.includes('label: t("handedTo")'),
    "the column and its label are rendered"
  );
});

check("the labels exist in both languages", () => {
  for (const key of [
    "handoverDate",
    "handoverDateHint",
    "increaseDate",
    "expenseDate",
  ]) {
    eq(
      (common.match(new RegExp(`\\b${key}:`, "g")) || []).length,
      2,
      `${key} in EN and BG`
    );
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
