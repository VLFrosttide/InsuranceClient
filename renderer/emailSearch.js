"use strict";

// Pure, DOM-free helpers for the search bar of the "Unread emails" tab. The
// dashboard joins the content of every card it currently shows (the subject,
// sender and body of each email of the conversation, the broker code chip and
// the replies that only exist in the locally stored conversation history) and
// these helpers decide whether a card matches what the worker typed.
//
// Kept in a separate classic <script> so the exact same code runs in the
// dashboard (WorkPage.js) and in the Node test harness
// (Test/emailSearch.test.cjs).
//
// Matching is literal and case-insensitive: every word of the input must occur
// somewhere in the card's text, in any order. A blank input matches everything
// (that is the unfiltered dashboard).

/**
 * Lower-case and collapse runs of whitespace, so "  Policy   123 " and
 * "policy 123" compare equal. Case folding works for Cyrillic and Latin alike.
 *
 * @param {*} value
 * @returns {string}
 */
function emailSearchNormalize(value) {
  return String(value === undefined || value === null ? "" : value)
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The distinct words of a query, normalized. An empty input has no words,
 * which means "no filter".
 *
 * @param {*} query
 * @returns {string[]}
 */
function emailSearchTokens(query) {
  return Array.from(
    new Set(emailSearchNormalize(query).split(" ").filter(Boolean))
  );
}

/**
 * Whether `haystack` contains every word of `query` (each word anywhere, in any
 * order). A blank query matches everything.
 *
 * @param {*} haystack
 * @param {*} query
 * @returns {boolean}
 */
function emailSearchMatches(haystack, query) {
  const tokens = emailSearchTokens(query);
  if (tokens.length === 0) return true;
  const text = emailSearchNormalize(haystack);
  return tokens.every((token) => text.includes(token));
}

/**
 * Every searchable text of one card: the subject, sender and body of each email
 * of its conversation, the broker code, plus any extra texts (the stored
 * conversation history, which carries the employee's replies).
 *
 * @param {{emails?: Array, email?: object, brokerCode?: string}} entry
 * @param {string[]} [extraTexts]
 * @returns {string}
 */
function emailCardSearchText(entry, extraTexts) {
  const parts = [];
  const emails = Array.isArray(entry && entry.emails)
    ? entry.emails
    : entry && entry.email
      ? [entry.email]
      : [];
  for (const email of emails) {
    if (!email) continue;
    parts.push(email.subject, email.from, email.body);
  }
  if (entry && entry.brokerCode) parts.push(entry.brokerCode);
  if (Array.isArray(extraTexts)) parts.push(...extraTexts);
  return parts
    .filter((part) => part !== undefined && part !== null && part !== "")
    .join("\n");
}

/**
 * Whether one email card matches the search input.
 *
 * @param {{emails?: Array, email?: object, brokerCode?: string}|null} entry
 * @param {*} query
 * @param {string[]} [extraTexts]  Text that is not part of the emails, e.g. the
 *   locally stored conversation history of the card.
 * @returns {boolean}
 */
function emailCardMatchesSearch(entry, query, extraTexts) {
  // Skip the work (and any storage lookups done by the caller) when there is
  // nothing to filter by.
  if (emailSearchTokens(query).length === 0) return true;
  return emailSearchMatches(emailCardSearchText(entry, extraTexts), query);
}
