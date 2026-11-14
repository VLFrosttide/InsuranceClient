"use strict";

// Pure, DOM-free helpers for how long an unread email card has been waiting.
// Kept in a separate classic <script> so the same code runs in the browser
// and in the Node test harness (Test/emailAge.test.cjs).

// Cards waiting longer than this are highlighted as overdue.
const EMAIL_OVERDUE_MS = 10 * 60 * 1000;

// Low priority: a card whose last reply is from an employee (the conversation
// is answered and waits for the broker) is parked out of the queue. When the
// client has still not answered after this long, the card is hidden from the
// dashboard entirely. A later email in the conversation brings it back.
const EMAIL_LOW_PRIORITY_HIDE_MS = 2 * 60 * 60 * 1000;

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

/**
 * Whether a low-priority (answered, awaiting the broker) card has waited so
 * long, without an answer from the client, that it should be hidden from the
 * dashboard.
 *
 * @param {number} answeredAt  Epoch ms of the employee's reply (0 when the card
 *   is not answered, in which case it is never hidden).
 * @param {number} [now]
 * @returns {boolean}
 */
function isLowPriorityEmailHidden(answeredAt, now = Date.now()) {
  const at = Number(answeredAt);
  if (!Number.isFinite(at) || at <= 0) return false;
  return now - at >= EMAIL_LOW_PRIORITY_HIDE_MS;
}

// When a low-priority card comes back because the client answered, its waiting
// time must restart at that answer instead of the first email that created the
// card. Persisted per conversation (threadKey -> epoch ms) because opening a
// card navigates to the add-insurance form and coming back reloads the
// dashboard; an in-memory value would be lost.
const EMAIL_WAIT_SINCE_KEY = "emailWaitSince";
// Answers older than this no longer matter: the conversation has been handled.
const EMAIL_WAIT_SINCE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

function loadEmailWaitSince(storage) {
  try {
    const parsed = JSON.parse(storage.getItem(EMAIL_WAIT_SINCE_KEY) || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return {};
  }
}

function saveEmailWaitSince(storage, map) {
  try {
    storage.setItem(EMAIL_WAIT_SINCE_KEY, JSON.stringify(map));
  } catch (err) {
    console.warn("Failed to store email waiting times:", err);
  }
}

/**
 * When the waiting time of a conversation's card restarted (epoch ms), or 0
 * when the card still counts from the first email that created it.
 *
 * @param {Storage} storage
 * @param {string} key  Conversation key (threadKey).
 * @param {number} [now]
 * @returns {number}
 */
function emailWaitSinceFor(storage, key, now = Date.now()) {
  if (!key) return 0;
  const map = loadEmailWaitSince(storage);
  const raw = Number(map[key]);
  if (!Number.isFinite(raw) || raw <= 0 || now - raw > EMAIL_WAIT_SINCE_MAX_AGE_MS) {
    if (key in map) {
      delete map[key];
      saveEmailWaitSince(storage, map);
    }
    return 0;
  }
  // A clock moved backwards must not produce a negative waiting time.
  return Math.min(raw, now);
}

/**
 * Restart a conversation card's waiting time at `ms` (the client's answer).
 *
 * @param {Storage} storage
 * @param {string} key
 * @param {number} ms
 * @param {number} [now]
 */
function emailSetWaitSince(storage, key, ms, now = Date.now()) {
  if (!key) return;
  const at = Number(ms);
  if (!Number.isFinite(at) || at <= 0) return;
  const map = loadEmailWaitSince(storage);
  for (const id of Object.keys(map)) {
    const value = Number(map[id]);
    if (!Number.isFinite(value) || now - value > EMAIL_WAIT_SINCE_MAX_AGE_MS) {
      delete map[id];
    }
  }
  map[key] = Math.min(at, now);
  saveEmailWaitSince(storage, map);
}

function emailClearWaitSince(storage, key) {
  if (!key) return;
  const map = loadEmailWaitSince(storage);
  if (!(key in map)) return;
  delete map[key];
  saveEmailWaitSince(storage, map);
}

function emailWaitSinceReKey(storage, fromKey, toKey) {
  if (!fromKey || !toKey || fromKey === toKey) return;
  const map = loadEmailWaitSince(storage);
  if (!(fromKey in map)) return;
  if (!(toKey in map)) map[toKey] = map[fromKey];
  delete map[fromKey];
  saveEmailWaitSince(storage, map);
}
