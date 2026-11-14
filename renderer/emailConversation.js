"use strict";

// Client-side helpers for the broker email cards' conversation history and
// their "answered, waiting for the broker" state.
//
// Kept in a separate classic <script> without DOM access so the exact same
// code runs in the dashboard (WorkPage.js), on the add-insurance form
// (AddInsurance.js) and in the Node test harness
// (Test/emailConversation.test.cjs).
//
// Two independent maps live in localStorage:
//
//   emailConversations   threadKey -> [ { id, direction, from, text, at } ]
//   emailAnsweredThreads threadKey -> { at, by, messageIds: [...] }
//
// The conversation map makes the replies visible on the form even when the
// Gmail thread cannot be read (offline, server without the thread endpoint).
// The answered map survives the navigation to AddInsurance and back, so the
// card can be dimmed and parked at the bottom until the broker answers.
//
// Stored history starts only once the conversation has a reply - an employee
// answer or the broker writing back on their original message (see
// emailConversationHasReplies). The original email alone is never history.

const EMAIL_CONVERSATIONS_KEY = "emailConversations";
const EMAIL_ANSWERED_KEY = "emailAnsweredThreads";

// Keep the stored data bounded. A thread is a conversation with one broker;
// older entries are no longer useful once the card has been completed.
const EMAIL_CONVERSATION_MAX_MESSAGES = 80;
const EMAIL_CONVERSATION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const EMAIL_ANSWERED_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

// The conversation key of an email. WorkPage keys its cards the same way, so
// the dashboard and the form always look at the same conversation.
function emailConversationKey(email) {
  return emailThreadKey(email || {});
}

function emailConversationLoadMap(storage, key) {
  try {
    const parsed = JSON.parse(storage.getItem(key) || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return {};
  }
}

function emailConversationSaveMap(storage, key, map) {
  try {
    storage.setItem(key, JSON.stringify(map));
  } catch (err) {
    console.warn(`Failed to store ${key}:`, err);
  }
}

function emailConversationPrune(map, now) {
  let changed = false;
  for (const key of Object.keys(map)) {
    const list = map[key];
    if (!Array.isArray(list) || list.length === 0) {
      delete map[key];
      changed = true;
      continue;
    }
    const kept = list.filter((message) => {
      // Prune by when the message was STORED, not when the email was sent: a
      // broker may send from an old date header, and an old conversation that
      // just arrived is still the current one.
      const storedAt = Number(
        message && (message.storedAt ?? message.at)
      );
      return (
        Number.isFinite(storedAt) &&
        now - storedAt <= EMAIL_CONVERSATION_MAX_AGE_MS
      );
    });
    if (kept.length !== list.length) {
      changed = true;
      if (kept.length === 0) delete map[key];
      else map[key] = kept;
    }
  }
  return changed;
}

/**
 * Add one message to a conversation. Messages are de-duplicated by id, so the
 * same email segment parsed repeatedly (dashboard re-render, form reload) is
 * stored once.
 *
 * @param {Storage} storage
 * @param {string} key        Conversation key (see emailConversationKey).
 * @param {{id?: string, direction?: string, from?: string, text?: string,
 *   at?: number}} message
 * @param {number} [now]
 * @returns {Array} The conversation after the change.
 */
function emailConversationRecord(storage, key, message, now = Date.now()) {
  if (!key || !message) return [];
  const text = String(message.text || "").trim();
  if (!text) return emailConversationFor(storage, key, now);

  const at = Number(message.at);
  const entry = {
    id: String(message.id || `${at || now}`).trim(),
    direction: message.direction === "employee" ? "employee" : "client",
    from: String(message.from || "").trim(),
    text: text.slice(0, 20000),
    at: Number.isFinite(at) ? at : now,
    storedAt: now,
  };
  // Where the message came from: "thread" (quoted inside an email), "gmail"
  // (the server's thread endpoint) or "employee" (sent from this form). Used
  // to present one clean history without duplicates.
  if (message.source) entry.source = String(message.source);
  if (!entry.id) entry.id = String(entry.at);

  const map = emailConversationLoadMap(storage, EMAIL_CONVERSATIONS_KEY);
  const list = Array.isArray(map[key]) ? map[key] : [];
  if (list.some((item) => String(item && item.id) === entry.id)) {
    return list;
  }

  list.push(entry);
  list.sort((a, b) => Number(a.at) - Number(b.at));
  while (list.length > EMAIL_CONVERSATION_MAX_MESSAGES) list.shift();
  map[key] = list;
  emailConversationPrune(map, now);
  emailConversationSaveMap(storage, EMAIL_CONVERSATIONS_KEY, map);
  return list;
}

/**
 * Every stored message of one conversation, oldest first.
 *
 * @param {Storage} storage
 * @param {string} key
 * @param {number} [now]
 * @returns {Array}
 */
function emailConversationFor(storage, key, now = Date.now()) {
  if (!key) return [];
  const map = emailConversationLoadMap(storage, EMAIL_CONVERSATIONS_KEY);
  const list = Array.isArray(map[key]) ? map[key].slice() : [];
  if (emailConversationPrune(map, now)) {
    emailConversationSaveMap(storage, EMAIL_CONVERSATIONS_KEY, map);
  }
  return list.sort((a, b) => Number(a.at) - Number(b.at));
}

// Move a conversation when a card's key changes (an email restored without a
// Gmail thread id starts under its subject key, then gains the thread key).
function emailConversationReKey(storage, fromKey, toKey) {
  if (!fromKey || !toKey || fromKey === toKey) return;
  const map = emailConversationLoadMap(storage, EMAIL_CONVERSATIONS_KEY);
  const from = Array.isArray(map[fromKey]) ? map[fromKey] : [];
  if (from.length === 0) {
    delete map[fromKey];
    return;
  }
  const to = Array.isArray(map[toKey]) ? map[toKey] : [];
  const seen = new Set(to.map((item) => String(item && item.id)));
  for (const message of from) {
    if (!seen.has(String(message && message.id))) to.push(message);
  }
  to.sort((a, b) => Number(a.at) - Number(b.at));
  map[toKey] = to;
  delete map[fromKey];
  emailConversationSaveMap(storage, EMAIL_CONVERSATIONS_KEY, map);
}


/**
 * Turn the emails quoted inside one email body into history messages. This is
 * the local fallback for the server's Gmail thread endpoint: the newest email
 * normally quotes every earlier answer, including the employee's replies.
 *
 * @param {{messageId?: string, threadId?: string, subject?: string,
 *   from?: string, date?: string, body?: string}} email
 * @returns {Array}
 */
function emailConversationMessagesFromThread(email) {
  if (!email || typeof emailThreadInfo !== "function") return [];
  const thread = emailThreadInfo(email);
  const brokerAddress = emailSenderAddress(email.from);
  const baseId = String(email.messageId || email.threadId || "thread");
  const now = Date.now();

  return thread.segments.map((segment, index) => {
    const isLatest = index === 0;
    const from = isLatest ? email.from || "" : segment.from || "";
    const date = isLatest ? email.date || "" : segment.date || "";
    const sender = emailSenderAddress(from);
    const direction =
      !isLatest && sender && brokerAddress && sender !== brokerAddress
        ? "employee"
        : "client";
    const parsed = Date.parse(date);
    // Segments are newest first; when a quoted header has no usable date,
    // keep that order by making later segments slightly older.
    const at = Number.isFinite(parsed) ? parsed : now - index * 60000;
    return {
      id: `${baseId}:${index}`,
      direction,
      from,
      date,
      text: segment.text || "",
      at,
      source: "thread",
    };
  });
}

/**
 * Whether a conversation already has a reply, i.e. whether its history may be
 * stored and shown. The broker's original email on its own is not a
 * conversation: the history begins once an employee answers, or once the
 * client writes back on their original message (a second client message).
 *
 * @param {Array<{direction?: string}>} messages  Oldest first.
 * @returns {boolean}
 */
function emailConversationHasReplies(messages) {
  if (!Array.isArray(messages)) return false;
  let clientMessages = 0;
  for (const message of messages) {
    if (!message) continue;
    // A message typed by the employee is a reply by definition.
    if (message.direction === "employee") return true;
    clientMessages++;
  }
  return clientMessages > 1;
}

/**
 * The attachments of a whole conversation, grouped per email (newest first),
 * each attachment carrying the messageId it belongs to.
 *
 * The form asks the server for the bytes with that id, so a file attached to
 * an earlier reply is fetched from the right message instead of being lost
 * (the newest email of a thread does not necessarily carry it).
 *
 * @param {{messageId?: string, from?: string, date?: string,
 *   attachments?: Array}} primary  The card's newest email.
 * @param {Array} [threadEmails]  Every email of the conversation, in any order.
 * @returns {Array<{messageId: string, from: string, date: string, index: number,
 *   isLatest: boolean, attachments: Array}>} Only emails that carry files.
 */
function emailConversationAttachmentGroups(primary, threadEmails) {
  const emails = [];
  const seenMessages = new Set();
  const add = (email) => {
    const id = String((email && email.messageId) || "").trim();
    if (!id || seenMessages.has(id)) return;
    seenMessages.add(id);
    emails.push(email);
  };
  add(primary);
  for (const email of Array.isArray(threadEmails) ? threadEmails : []) {
    add(email);
  }
  if (emails.length === 0) return [];

  // Newest first: the primary email is the newest one by definition, the
  // others are ordered by their Date header (missing/unusable dates go last).
  const rest = emails.slice(1).sort((a, b) => {
    const at = Date.parse((a && a.date) || "");
    const bt = Date.parse((b && b.date) || "");
    return (Number.isFinite(bt) ? bt : 0) - (Number.isFinite(at) ? at : 0);
  });
  const ordered = [emails[0], ...rest];

  const seenAttachments = new Set();
  return ordered
    .map((email, index) => {
      const attachments = [];
      for (const att of (email && email.attachments) || []) {
        const id = String((att && att.id) || "").trim();
        if (!id || seenAttachments.has(id)) continue;
        seenAttachments.add(id);
        attachments.push({ ...att, messageId: email.messageId });
      }
      return {
        messageId: String(email.messageId || ""),
        from: String(email.from || ""),
        date: String(email.date || ""),
        index,
        isLatest: index === 0,
        attachments,
      };
    })
    .filter((group) => group.attachments.length > 0);
}

function emailAnsweredLoadMap(storage) {
  return emailConversationLoadMap(storage, EMAIL_ANSWERED_KEY);
}

function emailAnsweredSaveMap(storage, map) {
  emailConversationSaveMap(storage, EMAIL_ANSWERED_KEY, map);
}

/**
 * The answered record of a conversation, or null when it is not answered (or
 * the record is too old to matter).
 *
 * @param {Storage} storage
 * @param {string} key
 * @param {number} [now]
 * @returns {{at: number, by: string, messageIds: string[]}|null}
 */
function emailAnsweredFor(storage, key, now = Date.now()) {
  if (!key) return null;
  const map = emailAnsweredLoadMap(storage);
  const record = map[key];
  if (!record || typeof record !== "object") return null;

  const at = Number(record.at);
  if (!Number.isFinite(at) || now - at > EMAIL_ANSWERED_MAX_AGE_MS) {
    delete map[key];
    emailAnsweredSaveMap(storage, map);
    return null;
  }
  return {
    at,
    by: String(record.by || ""),
    messageIds: Array.isArray(record.messageIds)
      ? record.messageIds.map((id) => String(id)).filter(Boolean)
      : [],
  };
}


/**
 * Mark a conversation as answered. `messageIds` is a snapshot of the emails
 * that were known when the reply was sent: a later message (the broker's
 * answer) is what revives the card.
 *
 * @param {Storage} storage
 * @param {string} key
 * @param {{at?: number, by?: string, messageIds?: string[]}} [details]
 * @returns {{at: number, by: string, messageIds: string[]}|null}
 */
function emailMarkAnswered(storage, key, details = {}, now = Date.now()) {
  if (!key) return null;
  const at = Number(details.at);
  const record = {
    at: Number.isFinite(at) ? at : now,
    by: String(details.by || ""),
    messageIds: Array.from(
      new Set((details.messageIds || []).map((id) => String(id)).filter(Boolean))
    ),
  };
  const map = emailAnsweredLoadMap(storage);
  map[key] = record;
  emailAnsweredSaveMap(storage, map);
  return record;
}

function emailClearAnswered(storage, key) {
  if (!key) return;
  const map = emailAnsweredLoadMap(storage);
  if (!(key in map)) return;
  delete map[key];
  emailAnsweredSaveMap(storage, map);
}

function emailAnsweredReKey(storage, fromKey, toKey) {
  if (!fromKey || !toKey || fromKey === toKey) return;
  const map = emailAnsweredLoadMap(storage);
  if (!(fromKey in map)) return;
  if (!(toKey in map)) map[toKey] = map[fromKey];
  delete map[fromKey];
  emailAnsweredSaveMap(storage, map);
}

/**
 * Whether an answered record still applies to the given emails. A new email in
 * the conversation (the broker answered) means the card must be revived.
 * A record without a message snapshot (older stored data) keeps applying until
 * it is explicitly cleared.
 *
 * @param {{messageIds?: string[]}|null} record
 * @param {string[]} messageIds  Every email currently on the card.
 * @returns {boolean}
 */
function emailAnsweredApplies(record, messageIds) {
  if (!record) return false;
  const known = Array.isArray(record.messageIds) ? record.messageIds : [];
  if (known.length === 0) return true;
  const snapshot = new Set(known.map((id) => String(id)));
  return (messageIds || []).every((id) => snapshot.has(String(id)));
}
