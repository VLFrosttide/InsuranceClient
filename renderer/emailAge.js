"use strict";

// Pure, DOM-free helpers for how long an unread email card has been waiting.
// Kept in a separate classic <script> so the same code runs in the browser
// and in the Node test harness (Test/emailAge.test.cjs).

// Cards waiting longer than this are highlighted as overdue.
const EMAIL_OVERDUE_MS = 10 * 60 * 1000;

// A card's arrival time is the local time when THIS PC first saw the email.
// It is persisted in localStorage (messageId -> epoch ms) because opening a
// card navigates to AddInsurance and coming back reloads the dashboard; an
// in-memory time would reset every card to "just now" on each reload, so no
// card would ever become overdue.
const EMAIL_FIRST_SEEN_KEY = "emailFirstSeen";
// Entries older than this are dropped so the stored map cannot grow forever.
const EMAIL_FIRST_SEEN_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function loadEmailFirstSeen(storage) {
  try {
    const parsed = JSON.parse(storage.getItem(EMAIL_FIRST_SEEN_KEY) || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return {};
  }
}

/**
 * When this PC first saw the email (epoch ms). Records `now` the first time a
 * messageId is seen; later calls return the stored time.
 *
 * @param {Storage} storage   localStorage (or a compatible object in tests).
 * @param {string} messageId
 * @param {number} [now]
 * @returns {number}
 */
function emailFirstSeenMs(storage, messageId, now = Date.now()) {
  const map = loadEmailFirstSeen(storage);
  let changed = false;

  for (const id of Object.keys(map)) {
    const ms = Number(map[id]);
    if (!Number.isFinite(ms) || now - ms > EMAIL_FIRST_SEEN_MAX_AGE_MS) {
      delete map[id];
      changed = true;
    }
  }

  let seen = Number(map[messageId]);
  // Missing, or in the future (PC clock was moved back): start counting now.
  if (!Number.isFinite(seen) || seen > now) {
    seen = now;
    map[messageId] = seen;
    changed = true;
  }

  if (changed) {
    try {
      storage.setItem(EMAIL_FIRST_SEEN_KEY, JSON.stringify(map));
    } catch (err) {
      console.warn("Failed to store email first-seen times:", err);
    }
  }
  return seen;
}

/** Whole minutes the email has been waiting (never negative). */
function emailWaitingMinutes(arrivalMs, now = Date.now()) {
  return Math.max(0, Math.floor((now - arrivalMs) / 60000));
}

/** True when the email has been waiting more than EMAIL_OVERDUE_MS. */
function isEmailOverdue(arrivalMs, now = Date.now()) {
  return now - arrivalMs > EMAIL_OVERDUE_MS;
}

/**
 * Local arrival time: "HH:mm" for today, "dd.mm HH:mm" for older emails.
 *
 * @param {number} arrivalMs
 * @param {number} [now]
 * @returns {string}
 */
function formatEmailArrival(arrivalMs, now = Date.now()) {
  const d = new Date(arrivalMs);
  const today = new Date(now);
  const p = (n) => String(n).padStart(2, "0");
  const time = `${p(d.getHours())}:${p(d.getMinutes())}`;
  const sameDay =
    d.getFullYear() === today.getFullYear() &&
    d.getMonth() === today.getMonth() &&
    d.getDate() === today.getDate();
  return sameDay ? time : `${p(d.getDate())}.${p(d.getMonth() + 1)} ${time}`;
}

/** Sort comparator: oldest arrival first (process these first). */
function compareEmailArrival(a, b) {
  return a - b;
}
