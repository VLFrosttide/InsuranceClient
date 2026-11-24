"use strict";

const Content = document.getElementById("Content");
const Nav = document.getElementById("Nav");
const HeaderTitle = document.getElementById("HeaderTitle");
const HeaderSub = document.getElementById("HeaderSub");
const LogoutButton = document.getElementById("LogoutButton");
const LangButton = document.getElementById("LangButton");
const PresenceWidget = document.getElementById("PresenceWidget");
const ModalBackdrop = document.getElementById("ModalBackdrop");
const Modal = document.getElementById("Modal");
const ModalTitle = document.getElementById("ModalTitle");
const ModalBody = document.getElementById("ModalBody");
const ModalClose = document.getElementById("ModalClose");

const userRole = getRole();
const username = getUsername();

if (!requireLogin()) {
  throw new Error("Not logged in");
}

// ---------------------------------------------------------------------------
// Unread email cards (admins and workers)
// ---------------------------------------------------------------------------
const emailCards = new Map(); // thread key -> { emails, email (newest), node }
let emailSocket = null;
let pendingClaimEmail = null;

// Re-reads whichever broker view is on screen (the Brokers table or one broker's
// balance history). Set by those views, cleared by the marker element: a push
// from the server only refreshes when that view is still the visible one.
let refreshActiveBrokersView = null;

// What the worker typed into the search bar of the email card tab. Kept here
// (not in the DOM) so a re-render - a new email arriving, a card being
// completed - keeps the filter and the field's text.
let emailSearchQuery = "";

// Sender address -> broker code (the ID shown in the brokers table). The
// broker list endpoint includes every broker's Code and email addresses, and
// workers are allowed to read it, so the card can show the code without a new
// server field. Loaded once per dashboard; cards already on screen are
// refreshed when it arrives.
let brokerCodeByAddress = new Map();

function brokerCodeForEmail(email) {
  if (!email) return "";
  const direct = String(email.brokerCode ?? email.BrokerCode ?? "").trim();
  if (direct) return direct;
  const address = emailSenderAddress(email.from);
  return address ? brokerCodeByAddress.get(address) || "" : "";
}

async function loadBrokerCodes() {
  // Admins get the same email cards as workers, so they need the broker code
  // chip too. Both roles may read the broker list.
  if (userRole !== "1" && userRole !== "2") return;
  try {
    const data = await api("/brokers");
    const map = new Map();
    for (const broker of (data && data.brokers) || []) {
      const code = String(
        (broker && (broker.Code ?? broker.code)) || ""
      ).trim();
      if (!code) continue;
      for (const address of (broker && (broker.emails || broker.Emails)) || []) {
        const sender = emailSenderAddress(address);
        if (sender) map.set(sender, code);
      }
    }
    brokerCodeByAddress = map;
    // The cards may already be rendered (emails arrive before this request
    // answers): refresh their broker-code chips in place.
    for (const entry of emailCards.values()) applyEmailCardLabels(entry);
  } catch (err) {
    console.warn("Failed to load broker codes:", err);
  }
}

// The Bulins border-insurance web form (see ../bulins.js and SetupBulins in
// main.js) replaced the in-app AddInsurance form for new insurances: opening an
// email or pressing "Add insurance" showed the Bulins site in a WebContentsView
// instead. It is switched off for now, so both paths use the in-app form again.
// Nothing was deleted - the whole Bulins integration (bulins.js, the IPC bridge
// in preload.js / main.js and setupBulinsHandlers below) is left in place; set
// this to true to bring the web form back.
const USE_BULINS_WEB_FORM = false;

function emailTitle(email) {
  return email.subject || email.from || t("email.noSubject");
}

// A card is one conversation: the original request plus every reply to it.
// Only the newest email is shown (it normally quotes the earlier ones) and it
// is the message claimed when the card is opened; the card's badge counts the
// replies. The server sends Gmail's threadId with every email, so replies group
// reliably even when their subject was edited.
function findEmailCardByMessageId(messageId) {
  if (!messageId) return null;
  for (const entry of emailCards.values()) {
    if (entry.emails.some((email) => email.messageId === messageId)) {
      return entry;
    }
  }
  return null;
}

// The card an email belongs to. The thread id is preferred; the subject/sender
// key is only a fallback for emails restored without one. Two different Gmail
// threads that happen to share a subject must stay separate, so the fallback
// never pairs two emails that both carry a thread id.
function findEmailCardFor(email) {
  const direct = emailCards.get(emailThreadKey(email));
  if (direct) return direct;
  const subjectKey = emailSubjectKey(email);
  if (!subjectKey) return null;
  const threadId = String((email && email.threadId) || "").trim();
  for (const entry of emailCards.values()) {
    if (threadId && entry.threadId) continue;
    if (entry.subjectKey === subjectKey) return entry;
  }
  return null;
}

// When the email was sent, used to keep a conversation oldest -> newest.
// Falls back to when this PC first saw it when the date header is unusable.
function emailSentMs(email) {
  const parsed = Date.parse((email && email.date) || "");
  if (Number.isFinite(parsed)) return parsed;
  return emailFirstSeenMs(localStorage, email.messageId);
}

function emailThreadIdOf(emails) {
  for (const email of emails) {
    const threadId = String((email && email.threadId) || "").trim();
    if (threadId) return threadId;
  }
  return "";
}

function replyCountLabel(count) {
  return count === 1
    ? t("email.replyCountOne")
    : t("email.replyCount").replace("{n}", count);
}

// Badge text for the current language, built from the values cached on the
// entry so it can be re-translated without splitting an email body again.
function emailCardBadgeText(entry) {
  if (entry.answeredAt) {
    return entry.replyCount > 0
      ? `${t("email.answered")} · ${replyCountLabel(entry.replyCount)}`
      : t("email.answered");
  }
  if (entry.kind === "forward") {
    return entry.threadCount > 1
      ? `${t("email.forward")} · ${t("email.threadCount").replace(
          "{n}",
          entry.threadCount
        )}`
      : t("email.forward");
  }
  if (entry.replyCount > 0) {
    return `${t("email.reply")} · ${replyCountLabel(entry.replyCount)}`;
  }
  return "";
}

// Apply the reply / forward colour, badge, broker code and title. Cheap
// (cached values), so it also runs from refreshEmailCardAges to follow a
// language change.
function applyEmailCardLabels(entry) {
  const isForward = entry.kind === "forward";
  const answered = Boolean(entry.answeredAt);
  entry.node.classList.toggle(
    "email-card-reply",
    !isForward && !answered && entry.replyCount > 0
  );
  entry.node.classList.toggle("email-card-forward", isForward && !answered);
  entry.node.classList.toggle("email-card-answered", answered);
  // An answered card is low priority: the last reply was the employee's and
  // the conversation now waits for the client.
  entry.node.classList.toggle("email-card-low-priority", answered);

  // The broker code sits above the subject in its own accent chip, so it
  // stands out from the title instead of reading as part of it. Only the
  // number is shown; the "ID" label is redundant in the chip.
  const code = brokerCodeForEmail(entry.email);
  entry.brokerCode = code;
  if (entry.codeNode) {
    entry.codeNode.textContent = code;
    entry.codeNode.style.display = code ? "" : "none";
    entry.codeNode.title = code ? t("email.brokerCodeTitle") : "";
  }

  const badgeText = emailCardBadgeText(entry);
  entry.badgeNode.textContent = badgeText;
  entry.badgeNode.style.display = badgeText ? "" : "none";
  entry.badgeNode.classList.toggle("email-card-badge-answered", answered);
  entry.titleNode.textContent = emailTitle(entry.email);
}


// Keep the map key in step with the conversation: an email restored without a
// Gmail thread id may create the card under its subject key, and the thread id
// has to take over once one of its emails carries it. Without this, the next
// reply (which does have a thread id) would miss the card and be shown alone.
// The locally stored conversation / answered state is moved along, so nothing
// recorded under the old key is lost.
function syncEmailCardKey(entry) {
  const key = entry.threadId
    ? `thread:${entry.threadId}`
    : emailThreadKey(entry.email);
  if (key === entry.key) return;
  emailConversationReKey(localStorage, entry.key, key);
  emailAnsweredReKey(localStorage, entry.key, key);
  emailWaitSinceReKey(localStorage, entry.key, key);
  emailCards.delete(entry.key);
  entry.key = key;
  emailCards.set(key, entry);
}

// Store the emails visible in this conversation (the newest email plus the
// earlier ones it quotes) so the add-insurance form can show the history even
// when the Gmail thread is not available. Employee replies are added by the
// form itself when they are sent.
//
// Storage only begins once the conversation has a reply: either an employee
// answered the request, or the broker wrote back on their original email. A
// lone original email is the request itself (already shown on the card and in
// the form), not a conversation history.
function recordEmailConversation(entry) {
  if (!entry || !entry.email) return;
  if (!entry.answeredAt && entry.replyCount <= 0) return;
  for (const message of emailConversationMessagesFromThread(entry.email)) {
    emailConversationRecord(localStorage, entry.key, message);
  }
}

// A gentle highlight when an answered card becomes active again (the broker
// replied). The class is removed after the animation so it can play again on
// the next revival.
function markEmailRevived(entry) {
  const node = entry && entry.node;
  if (!node) return;
  node.classList.remove("email-card-revived");
  // Reading offsetWidth restarts the animation when the class was just removed.
  void node.offsetWidth;
  node.classList.add("email-card-revived");
  clearTimeout(entry.reviveTimer);
  entry.reviveTimer = setTimeout(() => {
    node.classList.remove("email-card-revived");
  }, 1600);
}


// Refresh a card after its conversation changed (a reply arrived, or an email
// was completed / dismissed elsewhere): newest email, reply colour + badge,
// answered state and the title, without rebuilding the card or losing its busy
// state.
function updateEmailCard(entry) {
  entry.emails.sort((a, b) => emailSentMs(a) - emailSentMs(b));
  const newest = entry.emails[entry.emails.length - 1];
  entry.email = newest;
  entry.threadId = emailThreadIdOf(entry.emails);
  entry.subjectKey = emailSubjectKey(newest);
  // When the conversation first reached this PC. A reply does not normally
  // reset the card's age (that would push it to the end of the dashboard), but
  // a low-priority card that the client answers starts counting again from
  // that answer - see the revival handling below.
  const firstSeenMs = entry.emails.reduce(
    (min, email) =>
      Math.min(min, emailFirstSeenMs(localStorage, email.messageId)),
    Number.POSITIVE_INFINITY
  );

  const thread = emailThreadInfo(newest);
  let replyCount = Math.max(entry.emails.length, thread.count) - 1;
  if (thread.kind === "reply" && replyCount < 1) replyCount = 1;

  entry.kind = thread.kind;
  entry.threadCount = thread.count;
  entry.replyCount = replyCount;

  // The key may change once a thread id becomes known; move the stored
  // conversation/answered records before reading them back below.
  syncEmailCardKey(entry);

  // Answered state. The server marks every email of a replied-to thread, so
  // the newest email is authoritative. A locally stored record (this PC sent
  // the reply) survives server restarts; it stops applying as soon as a newer
  // email arrives - the broker has answered and the card must come back.
  const messageIds = entry.emails.map((email) => email.messageId);
  const serverAnsweredAt = Number(newest.answeredAt) || 0;
  const localAnswered = emailAnsweredFor(localStorage, entry.key);
  const wasAnswered = Boolean(entry.answeredAt);
  let answeredAt = 0;
  let revived = false;
  if (serverAnsweredAt) {
    answeredAt = serverAnsweredAt;
    emailMarkAnswered(localStorage, entry.key, {
      at: serverAnsweredAt,
      by: newest.answeredBy || "",
      messageIds,
    });
  } else if (localAnswered && emailAnsweredApplies(localAnswered, messageIds)) {
    answeredAt = localAnswered.at;
  } else if (localAnswered) {
    // A new email arrived after the reply: the broker answered.
    emailClearAnswered(localStorage, entry.key);
    revived = true;
  }
  entry.answeredAt = answeredAt;
  entry.answeredBy =
    (newest.answeredBy || (localAnswered && localAnswered.by)) || "";

  // The last reply determines the card's priority:
  // - an employee reply leaves the card low priority (answered, awaiting the
  //   broker), parked out of the queue and hidden after two hours;
  // - a client answer after that reply brings it back as a normal card, with
  //   its waiting time counted from the answer itself - not from the first
  //   email that created the card.
  if (answeredAt) {
    emailClearWaitSince(localStorage, entry.key);
  } else if (wasAnswered || revived) {
    emailSetWaitSince(
      localStorage,
      entry.key,
      emailFirstSeenMs(localStorage, newest.messageId)
    );
    markEmailRevived(entry);
  }
  const waitSinceMs = emailWaitSinceFor(localStorage, entry.key);
  entry.waitSinceMs = waitSinceMs > firstSeenMs ? waitSinceMs : 0;
  entry.arrivalMs = entry.waitSinceMs || firstSeenMs;

  recordEmailConversation(entry);
  applyEmailCardLabels(entry);
  refreshEmailCardAges();
}


// The tab body: heading, search bar and the cards. Used by the tab loader and
// when the dashboard has to be built from scratch (e.g. an email arrives while
// another tab is open, then this tab is shown again).
function emailCardsDashboard() {
  return [el("h2", t("unreadEmails")), emailSearchBar(), emailCardsContainer()];
}

// Search bar of the email card tab. It filters the cards currently on the
// dashboard by their content; the query lives in emailSearchQuery so typing
// only rebuilds the cards, not the field itself. Escape or ✕ clears it.
function emailSearchBar() {
  const wrapper = el("div", null, { class: "email-search" });
  const field = el("div", null, { class: "email-search-field" });

  const searchInput = el("input", null, {
    type: "text",
    id: "EmailSearchInput",
    class: "email-search-input",
    placeholder: t("email.searchPlaceholder"),
    "aria-label": t("email.searchPlaceholder"),
    autocomplete: "off",
    spellcheck: "false",
  });
  searchInput.value = emailSearchQuery;

  const clearBtn = el("button", "✕", {
    class: "email-search-clear",
    type: "button",
    title: t("email.searchClear"),
    "aria-label": t("email.searchClear"),
  });
  clearBtn.style.display = emailSearchQuery ? "" : "none";

  function applyQuery(value) {
    emailSearchQuery = value;
    searchInput.value = value;
    clearBtn.style.display = value ? "" : "none";
    refreshEmailCardsOnly();
  }

  searchInput.addEventListener("input", () => applyQuery(searchInput.value));
  searchInput.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !emailSearchQuery) return;
    event.preventDefault();
    applyQuery("");
  });
  clearBtn.addEventListener("click", () => {
    applyQuery("");
    searchInput.focus();
  });

  field.appendChild(searchInput);
  field.appendChild(clearBtn);
  wrapper.appendChild(field);
  return wrapper;
}

// Re-render only the cards, so a click in the search field keeps the caret
// where the worker left it instead of recreating the field.
function refreshEmailCardsOnly() {
  const cards = document.getElementById("EmailCards");
  if (cards) cards.replaceWith(emailCardsContainer());
}

// Whether one card matches what was typed. The locally stored conversation is
// searched too: replies typed by the employee live only there, not in the
// email bodies the card holds.
function emailCardMatchesQuery(entry) {
  // Nothing typed: skip the (per-card) storage reads entirely.
  if (emailSearchTokens(emailSearchQuery).length === 0) return true;
  const conversation = emailConversationFor(localStorage, entry.key).map(
    (message) =>
      [message && message.from, message && message.text].filter(Boolean).join(" ")
  );
  return emailCardMatchesSearch(entry, emailSearchQuery, conversation);
}

function renderEmailCardsIfVisible() {
  if (!activeNav || activeNav.load !== emailCardsView) return;
  const cards = document.getElementById("EmailCards");
  if (cards) {
    cards.replaceWith(emailCardsContainer());
    return;
  }
  Content.replaceChildren(...emailCardsDashboard());
}

function emailCardsContainer() {
  const container = el("div", null, {
    id: "EmailCards",
    class: "email-cards-layout",
  });
  if (emailCards.size === 0) {
    container.appendChild(el("p", t("noUnreadEmails"), { class: "muted" }));
    return container;
  }

  const now = Date.now();
  // A card whose last reply is the employee's is low priority: it leaves the
  // queue for the answered block. When the client has still not answered two
  // hours later the card is hidden entirely (the node is kept, not destroyed,
  // so a new email in the conversation brings it straight back).
  const visible = Array.from(emailCards.values()).filter((entry) => {
    const hidden =
      Boolean(entry.answeredAt) &&
      isLowPriorityEmailHidden(entry.answeredAt, now);
    entry.hiddenLowPriority = hidden;
    return !hidden;
  });
  const hiddenLowPriority = emailCards.size - visible.length;

  // Only the cards matching the search bar; a blank search matches every card.
  // Card nodes are never destroyed: an unmatched card is simply left out of the
  // grid, so it reappears as soon as the search is cleared or broadened.
  const searching = emailSearchTokens(emailSearchQuery).length > 0;
  const entries = searching ? visible.filter(emailCardMatchesQuery) : visible;
  if (searching && entries.length === 0) {
    container.appendChild(
      el(
        "p",
        t("email.searchNoResults").replace("{q}", emailSearchQuery.trim()),
        { class: "muted" }
      )
    );
    return container;
  }

  // Oldest first: the card that has waited longest is the one to process next.
  // Low-priority cards stay in their own block at the bottom right until the
  // client answers (or they are hidden).
  const active = entries
    .filter((entry) => !entry.answeredAt)
    .sort((a, b) => compareEmailArrival(a.arrivalMs, b.arrivalMs));
  const answered = entries
    .filter((entry) => entry.answeredAt)
    .sort((a, b) => compareEmailArrival(a.arrivalMs, b.arrivalMs));

  const activeGrid = el("div", null, { class: "email-cards" });
  if (active.length === 0) {
    activeGrid.appendChild(
      el(
        "p",
        t(
          answered.length || hiddenLowPriority
            ? "email.allAnswered"
            : "noUnreadEmails"
        ),
        { class: "muted" }
      )
    );
  }
  for (const entry of active) activeGrid.appendChild(entry.node);
  container.appendChild(activeGrid);

  if (answered.length) {
    const block = el("div", null, { class: "email-answered" });
    block.appendChild(
      el("h3", t("email.lowPrioritySection"), {
        class: "email-answered-heading",
      })
    );
    const grid = el("div", null, {
      class: "email-cards email-cards-answered",
    });
    for (const entry of answered) grid.appendChild(entry.node);
    block.appendChild(grid);
    container.appendChild(block);
  }

  if (hiddenLowPriority > 0) {
    container.appendChild(
      el(
        "p",
        t("email.lowPriorityHidden").replace("{n}", hiddenLowPriority),
        { class: "muted email-low-priority-hidden" }
      )
    );
  }

  refreshEmailCardAges();
  return container;
}


function emailWaitingLabel(arrivalMs, now) {
  const minutes = emailWaitingMinutes(arrivalMs, now);
  if (minutes < 1) return t("email.waitingNow");
  if (minutes < 60) return t("email.waitingMin").replace("{n}", minutes);
  return t("email.waitingHours")
    .replace("{h}", Math.floor(minutes / 60))
    .replace("{m}", minutes % 60);
}

// Update every card's arrival time / waiting label and overdue highlight.
// Also re-translates the labels, so it runs on every dashboard render.
function refreshEmailCardAges() {
  const now = Date.now();
  let lowPriorityVisibilityChanged = false;
  for (const entry of emailCards.values()) {
    // Re-translate the badge/title too: this runs on every dashboard render,
    // including the one after a language change.
    applyEmailCardLabels(entry);
    const answered = Boolean(entry.answeredAt);
    // An answered card is waiting for the broker, not for the worker, so it
    // must never turn red as overdue.
    const overdue = !answered && isEmailOverdue(entry.arrivalMs, now);
    entry.node.classList.toggle("email-card-overdue", overdue);

    // Hide a low-priority card once it has waited two hours for the client.
    // Only a change needs a re-render (the card must leave or rejoin the DOM).
    const hidden = answered && isLowPriorityEmailHidden(entry.answeredAt, now);
    if (hidden !== Boolean(entry.hiddenLowPriority)) {
      entry.hiddenLowPriority = hidden;
      lowPriorityVisibilityChanged = true;
    }

    if (answered) {
      entry.timeNode.textContent = t("email.answeredAt").replace(
        "{t}",
        formatEmailArrival(entry.answeredAt, now)
      );
      entry.waitNode.textContent = t("email.lowPriorityAwaiting");
      entry.timeWrap.title = entry.answeredBy
        ? `${t("email.answered")} · ${entry.answeredBy}`
        : t("email.answered");
    } else {
      entry.timeNode.textContent = t("email.arrived").replace(
        "{t}",
        formatEmailArrival(entry.arrivalMs, now)
      );
      entry.waitNode.textContent = emailWaitingLabel(entry.arrivalMs, now);
      entry.timeWrap.title = overdue ? t("email.overdue") : "";
    }
    if (entry.busyLabelNode) {
      entry.busyLabelNode.textContent = t("email.opening");
    }
  }
  if (lowPriorityVisibilityChanged) renderEmailCardsIfVisible();
}


// Ages change while the dashboard sits open: refresh them periodically.
// Cheap (text/class updates only) and harmless when the dashboard is hidden.
const EMAIL_AGE_REFRESH_MS = 30 * 1000;
setInterval(refreshEmailCardAges, EMAIL_AGE_REFRESH_MS);

function createEmailCard(key, email) {
  const card = el("div", null, { class: "email-card" });

  const openBtn = el("button", null, {
    class: "email-card-open",
    type: "button",
  });

  // Reply / forward badge. It is hidden for a fresh request and filled in by
  // updateEmailCard, which also sets the card's coloured edge.
  const badgeNode = el("span", null, { class: "email-card-badge" });
  badgeNode.style.display = "none";
  // Broker code chip: its own line above the subject, so the broker's number
  // stands out from the title. Hidden until a code is known for the sender.
  const codeNode = el("span", null, { class: "email-card-broker" });
  codeNode.style.display = "none";
  const titleNode = el("span", null, { class: "email-card-title" });
  openBtn.appendChild(badgeNode);
  openBtn.appendChild(codeNode);
  openBtn.appendChild(titleNode);


  // Arrival time (when this PC first saw the email) + how long the card has
  // been waiting (filled in and kept current by refreshEmailCardAges).
  const timeWrap = el("span", null, { class: "email-card-time" });
  const timeNode = el("span", null, { class: "email-card-arrived" });
  const waitNode = el("span", null, { class: "email-card-waiting" });
  timeWrap.appendChild(timeNode);
  timeWrap.appendChild(waitNode);
  openBtn.appendChild(timeWrap);

  // Busy indicator (spinner + "Opening…" label) revealed while a click on this
  // card is waiting for the server's claim confirmation.
  const busyNode = el("span", null, {
    class: "email-card-busy-indicator",
    "aria-hidden": "true",
  });
  const spinnerNode = el("span", null, { class: "email-card-spinner" });
  const busyLabelNode = el("span", t("email.opening"), {
    class: "email-card-busy-label",
  });
  busyNode.appendChild(spinnerNode);
  busyNode.appendChild(busyLabelNode);
  openBtn.appendChild(busyNode);

  const entry = {
    key,
    threadId: "",
    subjectKey: "",
    emails: [email],
    email,
    kind: null,
    threadCount: 0,
    replyCount: 0,
    answeredAt: 0,
    answeredBy: "",
    hiddenLowPriority: false,
    waitSinceMs: 0,
    brokerCode: "",
    reviveTimer: null,
    node: card,
    openBtn,
    xBtn: null,
    badgeNode,
    codeNode,
    titleNode,
    busyNode,
    busyLabelNode,
    arrivalMs: 0,
    timeWrap,
    timeNode,
    waitNode,
  };


  // Open through the entry rather than the email captured here: once a reply
  // updates the card, the newest email of the conversation is the one to show.
  openBtn.addEventListener("click", () => openEmailInNewForm(entry.email));

  const xBtn = el("button", "✕", {
    class: "email-card-x",
    type: "button",
    title: t("email.markIrrelevant"),
    "aria-label": t("email.markIrrelevant"),
  });
  xBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    markEmailIrrelevant(entry);
  });
  entry.xBtn = xBtn;

  card.appendChild(openBtn);
  card.appendChild(xBtn);

  emailCards.set(key, entry);
  updateEmailCard(entry);
  return entry;
}

function addEmailCard(email) {
  if (!email || !email.messageId) return;
  // Its policy is already queued in the outbox (saved offline, waiting to be
  // sent): the email is handled, so it must not be offered again.
  if (outboxEmailIds().has(email.messageId)) return;

  const existing = findEmailCardFor(email);
  if (existing) {
    const known = existing.emails.find(
      (item) => item.messageId === email.messageId
    );
    if (known) {
      // list_emails repeats every known email. The server may have changed the
      // thread's state (e.g. another worker replied), so refresh the stored
      // copy and let updateEmailCard re-evaluate the answered state.
      if (!Object.prototype.hasOwnProperty.call(email, "answeredAt")) {
        // The server clears these when the broker answers; merge only what
        // the server sent so a stale "answered" flag cannot stick.
        delete known.answeredAt;
        delete known.answeredBy;
      }
      Object.assign(known, email);
      updateEmailCard(existing);
      renderEmailCardsIfVisible();
      return;
    }
    // A reply to a conversation already on the dashboard: keep its one card
    // and refresh the reply colour / badge / title instead of adding a second.
    existing.emails.push(email);
    updateEmailCard(existing);
    renderEmailCardsIfVisible();
    return;
  }

  createEmailCard(emailThreadKey(email), email);
  renderEmailCardsIfVisible();
}

function removeEmailCard(id) {
  if (!id) return;
  const entry = emailCards.get(id) || findEmailCardByMessageId(id);
  if (!entry) return;
  // The card may come back (e.g. the other worker cancels), so the answered
  // marker is left in place; only an explicit dismissal/completion clears it.
  if (entry.reviveTimer) clearTimeout(entry.reviveTimer);
  emailCards.delete(entry.key);
  renderEmailCardsIfVisible();
}

// Drop one email (completed, dismissed or read outside the app) from its
// conversation. The card stays while another email of the thread is still
// unread and is rebuilt around the newest remaining one.
function removeEmailMessage(messageId) {
  const entry = findEmailCardByMessageId(messageId);
  if (!entry) return;
  entry.emails = entry.emails.filter(
    (email) => email.messageId !== messageId
  );
  if (entry.emails.length === 0) {
    emailClearAnswered(localStorage, entry.key);
    emailClearWaitSince(localStorage, entry.key);
    if (entry.reviveTimer) clearTimeout(entry.reviveTimer);
    emailCards.delete(entry.key);
  } else {
    updateEmailCard(entry);
  }
  renderEmailCardsIfVisible();
}


async function markEmailIrrelevant(entry) {
  const emails = entry && Array.isArray(entry.emails) ? entry.emails : [];
  if (emails.length === 0) return;
  const confirmed = await appConfirm(t("email.irrelevantConfirm"));
  if (!confirmed) return;

  // Dismiss on the server. The server removes the email from the shared pool
  // and marks the Gmail message read, so it disappears for every worker and
  // never re-surfaces on a later poll or server restart. Every email of the
  // conversation is dismissed - otherwise the older ones would come back as a
  // new card after the newest was removed.
  try {
    if (!emailSocket) throw new Error(t("emailConnUnavailable"));
    const ready = emailSocket.isReady();
    for (const email of emails) {
      if (!email.messageId) continue;
      if (ready) {
        emailSocket.send({ type: "mark_irrelevant", messageId: email.messageId });
      } else {
        queueDurableEmailWsAction({
          type: "mark_irrelevant",
          messageId: email.messageId,
        });
      }
    }
    if (!ready) emailSocket.ensureConnected();
  } catch (err) {
    // Keep the card: the server never received the dismissal.
    reportError("Failed to mark email as irrelevant", err, "emailSendFailed");
    return;
  }
  // Dismissed for good: the answered marker no longer applies. The
  // conversation history is kept (it is harmless and helps future context).
  emailClearAnswered(localStorage, entry.key);
  emailClearWaitSince(localStorage, entry.key);
  removeEmailCard(entry.key);
  toast(t("email.irrelevantMarked"), "success");
}

// How long to wait for the server's claim_email answer before giving up. A
// half-open socket (readyState OPEN, network path dead) silently swallows the
// request, so without this the click would appear to do nothing at all.
const CLAIM_TIMEOUT_MS = 8000;
let claimTimer = null;
// performance.now() timestamp of when the pending claim was sent.
let claimSentAt = 0;
let pendingClaimSent = false;

// Claim round-trip times are kept in localStorage: a successful claim
// navigates to AddInsurance, which would wipe any in-memory history.
const CLAIM_TIMINGS_KEY = "claimResponseTimes";
const CLAIM_TIMINGS_MAX = 50;

function loadClaimTimings() {
  try {
    const parsed = JSON.parse(localStorage.getItem(CLAIM_TIMINGS_KEY) || "[]");
    return Array.isArray(parsed) ? parsed.filter(Number.isFinite) : [];
  } catch {
    return [];
  }
}

// Log one claim round trip plus a summary of recent ones.
function logClaimResponseTime(messageId, ok, ms) {
  const samples = loadClaimTimings();
  samples.push(ms);
  while (samples.length > CLAIM_TIMINGS_MAX) samples.shift();
  try {
    localStorage.setItem(CLAIM_TIMINGS_KEY, JSON.stringify(samples));
  } catch (err) {
    console.warn("Failed to store claim response time:", err);
  }

  const sorted = [...samples].sort((a, b) => a - b);
  const pick = (p) =>
    sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
  const avg = sorted.reduce((sum, v) => sum + v, 0) / sorted.length;
  console.log(
    `[claim_email] server responded in ${ms.toFixed(0)} ms ` +
      `(${ok ? "claimed" : "rejected"}, "${messageId}") | ` +
      `last ${sorted.length}: median ${pick(0.5).toFixed(0)} ms, ` +
      `avg ${avg.toFixed(0)} ms, p95 ${pick(0.95).toFixed(0)} ms, ` +
      `min ${sorted[0].toFixed(0)} ms, max ${sorted[sorted.length - 1].toFixed(0)} ms ` +
      `(timeout ${CLAIM_TIMEOUT_MS} ms)`
  );
}

function setCardBusy(messageId, busy) {
  const entry = findEmailCardByMessageId(messageId);
  if (entry) {
    entry.node.classList.toggle("email-card-busy", busy);
    entry.node.setAttribute("aria-busy", String(Boolean(busy)));
    if (entry.openBtn) entry.openBtn.disabled = Boolean(busy);
    if (entry.xBtn) entry.xBtn.disabled = Boolean(busy);
    if (entry.busyNode) {
      entry.busyNode.setAttribute("aria-hidden", String(!busy));
    }
  }
  document.body.classList.toggle("email-claim-pending", busy);
}

function clearPendingClaim() {
  clearTimeout(claimTimer);
  claimTimer = null;
  pendingClaimSent = false;
  if (pendingClaimEmail) setCardBusy(pendingClaimEmail.messageId, false);
  pendingClaimEmail = null;
}

function sendPendingClaimNow() {
  if (!pendingClaimEmail || pendingClaimSent) return;
  if (!emailSocket || !emailSocket.isReady()) return;
  try {
    clearDurableEmailWsAction(pendingClaimEmail.messageId);
    emailSocket.send({
      type: "claim_email",
      messageId: pendingClaimEmail.messageId,
    });
    pendingClaimSent = true;
  } catch (err) {
    clearPendingClaim();
    reportError("Failed to claim email", err, "emailSendFailed");
  }
}

function openEmailInNewForm(email) {
  if (!emailSocket) {
    console.error("Cannot open email: email WebSocket is not available");
    toast(t("emailConnUnavailable"), "error");
    return;
  }
  // A claim is already in flight; ignore repeated clicks until it resolves.
  if (pendingClaimEmail) return;

  // The card is a whole conversation, so remember every email of it: the form
  // completes them all when the policy is saved, otherwise the older emails
  // would come back as a card after the newest one is marked read.
  const entry = findEmailCardByMessageId(email && email.messageId);
  const claimEmail = entry
    ? {
        ...email,
        threadMessageIds: entry.emails.map((item) => item.messageId),
        // Every email of the conversation (metadata only) so the form can list
        // and print attachments that arrived with an earlier reply, not just
        // the files of the newest email.
        threadEmails: entry.emails.map((item) => ({
          messageId: item.messageId,
          from: item.from || "",
          date: item.date || "",
          attachments: Array.isArray(item.attachments) ? item.attachments : [],
        })),
        // The form stores the conversation under the same key and shows the
        // broker code the card already resolved.
        conversationKey: entry.key,
        brokerCode: entry.brokerCode || brokerCodeForEmail(email),
      }
    : email;


  // Only navigate once the server confirms this client won the claim. If
  // another worker clicked the same card first, we show an error instead.
  pendingClaimEmail = claimEmail;
  pendingClaimSent = false;
  setCardBusy(claimEmail.messageId, true);
  claimSentAt = performance.now();

  // Remember when this email card was clicked. The AddInsurance form uses it as
  // the lower bound for the Desktop PDF watcher: only PDFs downloaded after this
  // moment are auto-attached to the policy.
  try {
    localStorage.setItem("desktopPdfWatchSinceMs", String(Date.now()));
  } catch (err) {
    console.error("Failed to store the Desktop watch start time:", err);
  }

  if (emailSocket.isReady()) {
    sendPendingClaimNow();
  } else {
    // The socket is reconnecting or still authenticating: kick off an immediate
    // connection attempt and let auth_ok send the claim as soon as it is ready.
    emailSocket.ensureConnected();
  }

  claimTimer = setTimeout(() => {
    if (
      !pendingClaimEmail ||
      pendingClaimEmail.messageId !== claimEmail.messageId
    ) {
      return;
    }
    console.error(
      `No claim_email response for "${claimEmail.messageId}" within ` +
        `${CLAIM_TIMEOUT_MS} ms; the connection looks dead, reconnecting`
    );
    clearPendingClaim();
    toast(t("emailClaimTimeout"), "error");
    // The connection is most likely half-open: replace it. auth_ok then
    // re-syncs the card list with the server.
    emailSocket.reconnectNow();
  }, CLAIM_TIMEOUT_MS);
}

function openClaimedEmail(email) {
  // Pass the email to the new page (AddInsurance) so it can show the full
  // body and attached pictures beside the form. AddInsurance will either
  // complete (submit) or release (cancel/back) the claim.
  try {
    localStorage.setItem("pendingEmail", JSON.stringify(email || null));
  } catch (err) {
    console.error("Failed to store pending email:", err);
  }

  // Disabled for now (USE_BULINS_WEB_FORM): while it is on, the Bulins web form
  // opens in a WebContentsView over the dashboard instead of the in-app form.
  // The claim then stays alive because the dashboard is never unloaded, and
  // closing the view releases the email again (see setupBulinsHandlers).
  if (
    USE_BULINS_WEB_FORM &&
    window.bridge &&
    typeof window.bridge.BulinsOpen === "function"
  ) {
    window.bridge
      .BulinsOpen({ mode: "email", email: email || null })
      .catch((err) => {
        console.error("Failed to open the Bulins web form:", err);
        const message =
          translateError(err && err.message ? err.message : "") ||
          t("serverError");
        toast(`${t("errorPrefix")}: ${message}`, "error");
        releaseClaimedEmail(email && email.messageId);
      });
    return;
  }

  // Also used when the Bulins bridge is unavailable (e.g. an older preload).
  window.bridge.LoadNewPage("renderer/AddInsurance/AddInsurance.html");
}

function releaseClaimedEmail(messageId) {
  if (!messageId) return;
  try {
    if (emailSocket && emailSocket.isReady()) {
      emailSocket.send({ type: "release_email", messageId });
      return;
    }
  } catch (err) {
    // Fall through to the durable queue: the release must still reach the
    // server once the socket is back.
  }
  queueDurableEmailWsAction({ type: "release_email", messageId });
  if (emailSocket) emailSocket.ensureConnected();
}

// Subscribe to Bulins web-form events. When the worker closes the Bulins view
// (the floating "← Insurance" button), release the claimed email back into the
// pool so its card reappears, and remember the latest scraped data.
function setupBulinsHandlers() {
  if (!window.bridge || typeof window.bridge.OnBulinsClosed !== "function") {
    return;
  }

  window.bridge.OnBulinsClosed((context = {}) => {
    console.log("[Bulins] web form closed:", context.mode || "walkin");
    if (context.mode === "email" && context.email && context.email.messageId) {
      releaseClaimedEmail(context.email.messageId);
    }
    try {
      localStorage.removeItem("pendingEmail");
    } catch (err) {
      /* ignore */
    }
    try {
      localStorage.removeItem("desktopPdfWatchSinceMs");
    } catch (err) {
      /* ignore */
    }
  });

  if (typeof window.bridge.OnBulinsScraped === "function") {
    window.bridge.OnBulinsScraped((entry) => {
      console.log("[Bulins] scraped data captured:", entry && entry.url);
      try {
        localStorage.setItem(
          "lastBulinsScrape",
          JSON.stringify({
            capturedAt: entry && entry.capturedAt,
            url: entry && entry.url,
            record: entry && entry.record,
          })
        );
      } catch (err) {
        /* ignore */
      }
    });
  }
}

function reconcileEmailCards(serverEmails) {
  const seen = new Set();
  // Emails whose policy is already waiting in the outbox are handled: they
  // must not be offered again, and must not keep a card alive on their own.
  const handled = outboxEmailIds();
  for (const email of serverEmails || []) {
    if (!email || !email.messageId || handled.has(email.messageId)) continue;
    seen.add(email.messageId);
    addEmailCard(email);
  }
  // Drop any email the server no longer lists (claimed/completed while this
  // client was disconnected). A card left behind here would otherwise become
  // unclickable: the server no longer has the email to claim it. A card whose
  // remaining emails are still unread stays, rebuilt around the newest one.
  for (const entry of Array.from(emailCards.values())) {
    const remaining = entry.emails.filter((email) =>
      seen.has(email.messageId)
    );
    if (remaining.length === entry.emails.length) continue;
    if (remaining.length === 0) {
      emailCards.delete(entry.key);
    } else {
      entry.emails = remaining;
      updateEmailCard(entry);
    }
  }
  renderEmailCardsIfVisible();
}

// The server rebuilds a broker's balance on every change (policy sold, edited,
// annulled, restored, deleted; a top-up, a hand-over, a paid bill) and pushes
// the affected broker ids. Refresh the broker view on screen so a colleague's
// change shows up here without a reload.
function handleBrokerBalanceChanged(msg) {
  const host = Content.querySelector("[data-brokers-view]");
  if (!host) return;
  if (host.dataset.brokersView === "history") {
    const ids = Array.isArray(msg && msg.data && msg.data.brokers)
      ? msg.data.brokers.map(Number)
      : [];
    const viewing = Number(host.dataset.brokerId);
    if (ids.length > 0 && !ids.includes(viewing)) return;
  }
  if (typeof refreshActiveBrokersView === "function") {
    // A failed refresh must not break the socket's message loop.
    Promise.resolve()
      .then(() => refreshActiveBrokersView())
      .catch((err) => console.error("Failed to refresh the broker view:", err));
  }
}

function setupEmailSocket() {
  // Admins receive the unread email cards as well, so they can work an email
  // themselves when no worker is available.
  if (userRole !== "1" && userRole !== "2") return;

  emailSocket = new UnreadEmailSocket({
    new_email: (msg) => addEmailCard(msg.data),
    auth_ok: () => {
      // After (re)connecting, re-sync cards with the server's source of truth.
      try {
        emailSocket.send({ type: "list_emails" });
      } catch (err) {
        reportError("Failed to request unread emails", err, "emailSendFailed");
      }
      // Keep emails of queued policies reserved; complete delivered ones.
      syncOutboxEmails(emailSocket);
      // Share this connection for the presence board so the page only opens one
      // WebSocket instead of two. Admins see the board but are not listed on it.
      try {
        if (userRole === "2") {
          sendPresence(presenceStatusFor("online", lastActivityAt));
        }
        emailSocket.send({ type: "list_presence" });
      } catch (err) {
        console.error("Failed to send presence request:", err);
      }
      // If the worker clicked an email card while the socket was reconnecting,
      // send the pending claim now.
      sendPendingClaimNow();
      // Catch up on broker balance changes pushed while the socket was down.
      handleBrokerBalanceChanged(null);
    },
    // The connection dropped: allow a reconnect within CLAIM_TIMEOUT_MS to
    // re-send any pending claim automatically.
    close: () => {
      // The server released this connection's claims: re-claim on reconnect.
      resetOutboxEmailClaims();
      if (!pendingClaimEmail) return;
      pendingClaimSent = false;
    },
    list_emails: (msg) => reconcileEmailCards(msg.data),
    presence_update: (msg) => {
      presenceWorkers = Array.isArray(msg.data) ? msg.data : [];
      renderPresence(presenceWorkers);
    },
    claim_email: (msg) => {
      if (!pendingClaimEmail || pendingClaimEmail.messageId !== msg.messageId) {
        return;
      }
      const email = pendingClaimEmail;
      logClaimResponseTime(
        email.messageId,
        Boolean(msg.ok),
        performance.now() - claimSentAt
      );
      clearPendingClaim();
      if (msg.ok) {
        openClaimedEmail(email);
      } else {
        // The server rejected the claim (email already claimed/completed
        // elsewhere or no longer present). Drop the stale card so it can't
        // be clicked again with no effect.
        removeEmailCard(msg.messageId || email.messageId);
        toast(t("emailClaimed"), "error");
      }
    },
    email_claimed: (msg) => removeEmailCard(msg.messageId),
    email_completed: (msg) => removeEmailMessage(msg.messageId),
    email_irrelevant: (msg) => removeEmailMessage(msg.messageId),
    // The original Gmail message was read outside the app: drop it from its
    // card; a still-unread reply in the same conversation keeps the card alive.
    email_read: (msg) => removeEmailMessage(msg.messageId),
    // The reply to the broker's email could not be sent immediately: show
    // whether it is being re-tried automatically or failed for good.
    email_send_failed: handleEmailSendFailed,
    email_released: (msg) => {
      const email = msg.data;
      if (email && email.messageId) {
        addEmailCard(email);
      } else if (msg.messageId) {
        addEmailCard({ messageId: msg.messageId, subject: "" });
      }
    },
    // A broker balance moved (by this client or another one): refresh the
    // Brokers tab / balance history if it is the view on screen.
    broker_balance_changed: handleBrokerBalanceChanged,
  });
  emailSocket.connect();

  // Queue changes: hide cards of newly queued email policies and complete the
  // emails of policies the outbox just delivered.
  onOutboxState(() => {
    for (const messageId of outboxEmailIds()) removeEmailMessage(messageId);
    syncOutboxEmails(emailSocket);
  });
}

function fetchUnreadEmails() {
  if (
    (userRole !== "1" && userRole !== "2") ||
    !emailSocket ||
    !emailSocket.isReady()
  ) {
    return;
  }
  try {
    emailSocket.send({ type: "list_emails" });
  } catch (err) {
    reportError("Failed to request unread emails", err, "emailSendFailed");
  }
}

// ---------------------------------------------------------------------------
// Worker presence board (who is online and their current status).
//   green  = online, on the PC
//   orange = busy working on a form
//   red    = online but away from keyboard
// ---------------------------------------------------------------------------
let presenceSocket = null;
let presenceWorkers = [];
let presenceStatus = null; // last status sent to the server
let lastActivityAt = Date.now();

const PRESENCE_STATUSES = ["online", "working", "afk"];

function renderPresence(workers) {
  if (!PresenceWidget) return;
  PresenceWidget.replaceChildren();

  const list = Array.isArray(workers) ? workers : [];
  if (list.length === 0) {
    PresenceWidget.appendChild(
      el("span", t("presence.none"), { class: "presence-none" })
    );
    return;
  }

  for (const w of list) {
    const status = PRESENCE_STATUSES.includes(w.status) ? w.status : "online";
    const statusLabel = t(`presence.${status}`);
    const chip = el("span", null, { class: "presence-chip" });
    chip.title = `${w.username} · ${statusLabel}`;
    chip.appendChild(el("span", null, { class: `presence-dot ${status}` }));
    chip.appendChild(el("span", w.username, { class: "presence-name" }));
    chip.appendChild(el("span", statusLabel, { class: "presence-status" }));
    PresenceWidget.appendChild(chip);
  }
}

function sendPresence(status) {
  // Remember the status this page wants the server to know even while the
  // socket is down: the next heartbeat re-sends it once the link is back.
  presenceStatus = status;
  if (!presenceSocket) return;
  if (typeof presenceSocket.isReady === "function" && !presenceSocket.isReady()) {
    return;
  }
  try {
    presenceSocket.send({ type: "presence", status });
  } catch (err) {
    console.error("Failed to send presence status:", err);
  }
}

function markActivity() {
  lastActivityAt = Date.now();
  if (presenceStatus === "afk") sendPresence("online");
}

function setupPresenceSocket() {
  if (userRole !== "1" && userRole !== "2") return;
  if (emailSocket) {
    // Reuse the emailSocket so the dashboard maintains a single WebSocket
    // connection for both emails and presence (admins and workers).
    presenceSocket = emailSocket;
    if (userRole !== "2") return;
    trackUserActivity(markActivity);
    // Heartbeat: re-assert "online"/"afk" on every tick even when it did not
    // change. The server only re-broadcasts a real change, so this is cheap -
    // and it heals the board after a lost frame or a stray status from another
    // session of the same worker.
    setInterval(() => {
      sendPresence(presenceStatusFor("online", lastActivityAt));
    }, 15 * 1000);
    return;
  }
  presenceSocket = new UnreadEmailSocket({
    auth_ok: () => {
      try {
        if (userRole === "2") {
          sendPresence(presenceStatusFor("online", lastActivityAt));
        }
        presenceSocket.send({ type: "list_presence" });
      } catch (err) {
        console.error("Failed to send presence request:", err);
      }
      // After a reconnect, catch up on balance changes that were pushed while
      // the socket was down.
      handleBrokerBalanceChanged(null);
    },
    presence_update: (msg) => {
      presenceWorkers = Array.isArray(msg.data) ? msg.data : [];
      renderPresence(presenceWorkers);
    },
    broker_balance_changed: handleBrokerBalanceChanged,
  });
  presenceSocket.connect();

  if (userRole === "2") {
    trackUserActivity(markActivity);
    setInterval(() => {
      // Same heartbeat as above: a repeated status keeps the board correct
      // instead of relying on the single update sent when the page loaded.
      sendPresence(presenceStatusFor("online", lastActivityAt));
    }, 15 * 1000);
  }
}

// ---------------------------------------------------------------------------
// Fetch broker pricing on page load (for clients/brokers)
// ---------------------------------------------------------------------------
async function initializeBrokerPricing() {
  // Only workers (role "2") create insurances and need prices; admins have no
  // broker attached, so the server answers 404 "Broker not found" for them.
  if (userRole !== "2") return;
  try {
    await fetchBrokerPricing();
  } catch (err) {
    console.warn("Failed to initialize broker pricing:", err);
  }
}

function money(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(2) : "0.00";
}

// The amount a worker should charge the client for a policy. It is the stored
// Price plus the +2 card fee for walk-in (broker-less) policies paid by card.
// The +2 is a bank tax, so it is visible here and on the add form but is never
// stored in the database (the server keeps CardFee at 0 and Price excludes it).
// An annulled policy has already been refunded and its stored Price is the
// annulment tax now, so no card fee is added on top of it.
const CARD_FEE = 2;

function chargePrice(item) {
  const raw = Number(item && item.Price);
  if (!Number.isFinite(raw)) return raw;
  if (item && Boolean(Number(item.Annulled))) return raw;
  const isWalkIn =
    item.BrokerId === null ||
    item.BrokerId === undefined ||
    item.BrokerId === "";
  const isCard = String(item.PaymentType || "") === "Card";
  return isWalkIn && isCard ? Math.round((raw + CARD_FEE) * 100) / 100 : raw;
}

// The amount a policy contributes to the price column (table and Excel
// export). A normal policy contributes its charge price (stored price, plus the
// visual-only +2 card fee for walk-in card payments). An annulled policy's
// price IS the annulment tax now (the server keeps Price = AnnulFee and saves
// the sale price in OriginalPrice), so it contributes exactly that tax.
function insuranceExportPrice(item) {
  if (item && Boolean(Number(item.Annulled))) {
    const fee = Number(item.AnnulFee);
    return Number.isFinite(fee) ? fee : 0;
  }
  return chargePrice(item);
}

// Total of the shown policies, per currency. Each row contributes the amount
// its Price column shows (insuranceExportPrice): an active policy its price
// plus the visual-only +2 card fee of a walk-in card payment, and an annulled
// policy its annulment tax (the tax is the policy's price now), so the total
// includes what annulled policies kept. `canSee` is the same price-visibility
// predicate the table uses; a row whose price the user may not see contributes
// nothing, so a worker's total cannot reveal a broker (email) price. Deleted
// policies are counted when the admin asked to show them (they are shown rows
// then).
// Returns [{ currency, amount }] sorted by currency, so EUR and TRY stay
// apart instead of being added together.
function sumShownInsurancePrices(items, canSee) {
  const visible = typeof canSee === "function" ? canSee : () => true;
  const cents = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    if (!item || !visible(item)) continue;
    const amount = Number(insuranceExportPrice(item));
    if (!Number.isFinite(amount)) continue;
    const currency = String(item.CurrencyType || "EUR").trim().toUpperCase();
    cents.set(currency, (cents.get(currency) || 0) + Math.round(amount * 100));
  }
  return Array.from(cents, ([currency, value]) => ({
    currency,
    amount: value / 100,
  })).sort((a, b) => a.currency.localeCompare(b.currency));
}

// Display label for a stored payment type (Cash / Card / Broker). Unknown
// values are shown as they are.
function paymentLabel(value) {
  if (value === undefined || value === null || value === "") return "";
  return t(`payment.${value}`, String(value));
}

function renderCashBalances(balances) {
  const entries = Object.entries(balances || {}).filter(
    ([, value]) => Number(value) !== 0
  );
  if (entries.length === 0) return money(0);
  return entries
    .map(([currency, value]) => `${money(value)} ${currency}`)
    .join(" · ");
}

// ---------------------------------------------------------------------------
// Cash ledger tinting
// ---------------------------------------------------------------------------
// A movement above the notable amount FOR ITS CURRENCY is worth a second look:
// its row is tinted one step stronger than the ordinary ones. The thresholds
// mirror the branch exchange rate (5 500 TRY = 100 EUR), so 100 EUR and 5 500
// TRY are the same limit and neither currency is flagged sooner than the other.
// Kept deliberately low-key - the tables still have to be easy to read.
const NOTABLE_AMOUNT = 100;
const NOTABLE_AMOUNT_TRY = 5500;

// The notable amount of a currency: 100 EUR, or 5 500 TRY (the same money).
// Anything else is treated as EUR, the drawer's own currency.
function notableAmount(currency) {
  return String(currency).toUpperCase() === "TRY"
    ? NOTABLE_AMOUNT_TRY
    : NOTABLE_AMOUNT;
}

// Is this movement big enough to stand out? Compared in its own currency.
function isNotableAmount(amount, currency) {
  return Math.abs(Number(amount) || 0) > notableAmount(currency);
}

// Fill a balance card with one big line per non-zero currency, the way the
// Balance and Cash from brokers cards are built. A card with nothing to show
// displays a plain zero instead of an empty body.
function fillBalanceCard(card, balances) {
  const nonZero = Object.entries(balances || {}).filter(
    ([, value]) => Number(value) !== 0
  );
  if (nonZero.length === 0) {
    card.appendChild(el("p", money(0), { class: "big" }));
    return;
  }
  const list = el("div");
  for (const [currency, value] of nonZero) {
    list.appendChild(el("p", `${money(value)} ${currency}`, { class: "big" }));
  }
  card.appendChild(list);
}

// Row tint for a cash-ledger movement: a soft green for money in, a soft red
// for money spent out of the drawer, a muted amber for money HANDED OVER to a
// person (out of the drawer, but not an expense), and a step stronger once the
// amount passes the currency's notable amount (100 EUR / 5 500 TRY).
function movementRowClass(type, amount, currency) {
  const big = isNotableAmount(amount, currency);
  const kind = String(type);
  if (kind === "increase") {
    return big ? "row-increase row-large-increase" : "row-increase";
  }
  if (kind === "reduce") {
    return big ? "row-reduce row-large-reduce" : "row-reduce";
  }
  if (kind === "handover") {
    return big ? "row-handover row-large-handover" : "row-handover";
  }
  // Money coming back from a hand-over fills the drawer again, so it carries
  // the same green hue as an increase.
  if (kind === "handover_return") {
    return big ? "row-increase row-large-increase" : "row-increase";
  }
  return "";
}

// A reason made only of digits and punctuation (a bare policy number such as
// "123456", or a total typed by hand) explains nothing, so its row is dimmed. A
// reason with words in it says why the money moved, so its row is nudged up
// slightly instead. An empty reason stays neutral.
function reasonRowClass(reason) {
  const text = String(reason ?? "").trim();
  if (text === "") return "";
  return /[A-Za-z\u0400-\u04FF]/.test(text)
    ? "row-text-reason"
    : "row-numeric-reason";
}

// The row class of a cash-ledger entry: its movement tint plus its reason tint.
function cashLedgerRowClass(type, amount, currency, reason) {
  return [movementRowClass(type, amount, currency), reasonRowClass(reason)]
    .filter(Boolean)
    .join(" ");
}

// Amount cell emphasis for the notable movements, so a big entry still stands
// out when the row tints are too subtle to notice at a glance.
function amountCellClass(item) {
  return isNotableAmount(item && item.Amount, item && item.Currency)
    ? "amount-notable"
    : "";
}

// The cash ledger's technical Type values, as the tables show them to a user:
// "increase" -> Increase, "reduce" -> Expense, "handover" -> Hand over,
// "handover_return" -> Returned hand over. An unknown value is shown as it is,
// so a new type is never hidden. (Broker movements have their own
// movementTypeLabel further down.)
function cashTypeLabel(type) {
  const kind = String(type ?? "");
  if (kind === "increase") return t("increase");
  if (kind === "reduce") return t("expense");
  if (kind === "handover") return t("handOver");
  if (kind === "handover_return") return t("handoverReturn");
  return kind;
}

// The money a policy row contributes to a ledger: its price while active, or
// just the annulment fee once annulled. A walk-in policy writes no row to
// cash_transactions, so the combined Transactions table reads it from the
// policy itself.
function policyLedgerAmount(policy) {
  if (!policy) return 0;
  return Number(policy.Annulled) === 1
    ? Number(policy.AnnulFee) || 0
    : Number(policy.Price) || 0;
}

// One row of the combined Transactions table for an insurance policy.
function policyTransactionRow(policy, type) {
  const row = policy || {};
  return {
    ...row,
    Type: type,
    Source: "insurance",
    Amount: policyLedgerAmount(row),
    Currency: row.CurrencyType,
    Username: row.Author,
    CreatedAt: row.CreationDate,
    Reason: row.Reason,
  };
}

// The Transactions table is the day's full ledger: every walk-in policy (cash
// or card), every broker-funded policy, the broker payments (manual increases
// and hand-overs) and the drawer's own manual movements (increases, expenses
// and hand-overs). A policy's correction rows are still not listed - the
// policy is shown once, at its current price.
function combinedCashTransactions(data) {
  const source = data || {};
  const rows = [];
  for (const tx of source.transactions || []) {
    rows.push({ ...tx, Source: "cash" });
  }
  for (const policy of source.cashInsurances || []) {
    rows.push(policyTransactionRow(policy, "policy_cash"));
  }
  for (const policy of source.cardInsurances || []) {
    rows.push(policyTransactionRow(policy, "policy_card"));
  }
  for (const policy of source.brokerInsurances || []) {
    rows.push(policyTransactionRow(policy, "policy_broker"));
  }
  for (const tx of source.brokerCashTransactions || []) {
    rows.push({ ...tx, Type: "broker_increase", Source: "broker" });
  }
  for (const tx of source.brokerHandovers || []) {
    rows.push({ ...tx, Type: "broker_handover", Source: "broker" });
  }
  return rows.sort((a, b) => {
    const byDate = String(b.CreatedAt || "").localeCompare(
      String(a.CreatedAt || "")
    );
    if (byDate !== 0) return byDate;
    return (Number(b.id) || 0) - (Number(a.id) || 0);
  });
}

// The Type label of a combined Transactions row. Unknown values fall back to
// the cash ledger label so a new ledger type is never hidden.
function transactionTypeLabel(row) {
  const kind = String((row && row.Type) || "");
  if (kind === "policy_cash") return t("transactionPolicyCash");
  if (kind === "policy_card") return t("transactionPolicyCard");
  if (kind === "policy_broker") return t("transactionPolicyBroker");
  if (kind === "broker_increase") return t("increase");
  if (kind === "broker_handover") return t("handOver");
  return cashTypeLabel(kind);
}

// The Type cell: the label plus the broker's name for a broker-funded row.
function transactionTypeCell(row) {
  const wrap = el("span", null, { class: "movement-type" });
  wrap.appendChild(el("span", transactionTypeLabel(row)));
  if (row && row.BrokerName) {
    wrap.appendChild(el("span", ` — ${row.BrokerName}`, { class: "muted" }));
  }
  return wrap;
}

// Row tint of a combined row. Policy sales and broker payments are money in
// (green), an expense is money out (red), a hand-over is amber.
function transactionRowClass(row) {
  const kind = String((row && row.Type) || "");
  if (
    kind === "policy_cash" ||
    kind === "policy_card" ||
    kind === "policy_broker" ||
    kind === "broker_increase"
  ) {
    return cashLedgerRowClass(
      "increase",
      row && row.Amount,
      row && row.Currency,
      row && row.Reason
    );
  }
  if (kind === "broker_handover") {
    return cashLedgerRowClass(
      "handover",
      row && row.Amount,
      row && row.Currency,
      row && row.Reason
    );
  }
  return cashLedgerRowClass(
    kind,
    row && row.Amount,
    row && row.Currency,
    row && row.Reason
  );
}

// ---------------------------------------------------------------------------
// Per-type, per-price counts for the collapsible section headings
// ---------------------------------------------------------------------------
// Every collapsible ledger table shows what it holds in its heading, grouped by
// type and then by price tier - "Increase: 10× 40 EUR, 20× 25 EUR" - so the
// day's prices can be read without opening anything. The type order is fixed (a
// type the order does not name yet still appears, after the known ones) so the
// heading reads the same way every day.

// The type a cash-ledger row is counted under. An annulment is a policy
// movement, not ordinary money in or out of the drawer: its reason says
// "Annul <blanc>", so it is counted as its own type instead of swelling the
// Increase or Expense total next to it.
function cashLedgerCountKind(tx) {
  const reason = String((tx && tx.Reason) || "").trim();
  if (/^annul\b/i.test(reason)) return "annul";
  return String((tx && tx.Type) || "");
}

const CASH_LEDGER_COUNT_ORDER = [
  "increase",
  "reduce",
  "handover",
  "handover_return",
  "annul",
];

// Who paid the annulment fee, as the Status column names it: "broker",
// "worker" or "none" (no fault). Anything else is a legacy row without a payer.
const ANNUL_PAYER_KINDS = ["broker", "worker", "none"];

function annulPayerKey(value) {
  const payer = String(value || "").trim().toLowerCase();
  return ANNUL_PAYER_KINDS.includes(payer) ? payer : "";
}

// The parenthesised payer of an annulment (" (Broker)" ...), or "" when the row
// carries no known payer. The Status column and the heading counts share it, so
// the two can never word the payer differently.
function annulPayerSuffix(value) {
  const payer = annulPayerKey(value);
  return payer ? ` (${t(`annul.payer.${payer}`)})` : "";
}

// The type a card payment is counted under: a policy still standing is
// "active"; an annulled one is counted per who paid the fee, so the annulled
// types stay apart from each other and from the normal payments.
function cardPaymentStatusKind(item) {
  if (!item) return "";
  if (item.Deleted) return "deleted";
  if (!item.Annulled) return "active";
  const payer = annulPayerKey(item.AnnulReason);
  return payer ? `annulled-${payer}` : "annulled";
}

const CARD_PAYMENT_STATUS_ORDER = [
  "active",
  "annulled-worker",
  "annulled-broker",
  "annulled-none",
  "annulled",
  "deleted",
];

// Every row of a table grouped by type and then by its price tier (amount and
// currency): [{ kind, tiers: [{ amount, currency, count }] }]. Rows stored as a
// string ("40.00") and as a number (40) land in the same tier, and a currency
// keeps its own tiers together, biggest price first - exactly how the heading
// reads them.
function groupRowsByKindAndTier(items, kindOf, tierOf, order) {
  const groups = new Map();
  for (const item of items || []) {
    const kind = kindOf(item);
    if (!kind) continue;
    const tier = tierOf(item) || {};
    const amount = Number(tier.amount) || 0;
    const currency = String(tier.currency || "EUR").toUpperCase();
    if (!groups.has(kind)) groups.set(kind, new Map());
    const tiers = groups.get(kind);
    const key = `${currency}|${amount}`;
    const seen = tiers.get(key);
    if (seen) seen.count += 1;
    else tiers.set(key, { amount, currency, count: 1 });
  }
  const rank = (kind) => {
    const index = order.indexOf(kind);
    return index === -1 ? order.length : index;
  };
  // The sort is stable, so the unnamed types keep the order they first appear.
  return [...groups]
    .map(([kind, tiers]) => ({
      kind,
      tiers: [...tiers.values()].sort((a, b) =>
        a.currency === b.currency
          ? b.amount - a.amount
          : a.currency.localeCompare(b.currency)
      ),
    }))
    .sort((a, b) => rank(a.kind) - rank(b.kind));
}

// The Current cash ledger's rows grouped per type and price (the Amount column).
function cashLedgerTypeTiers(items) {
  return groupRowsByKindAndTier(
    items,
    cashLedgerCountKind,
    (tx) => ({ amount: tx && tx.Amount, currency: tx && tx.Currency }),
    CASH_LEDGER_COUNT_ORDER
  );
}

// The Card payments rows grouped per status and price (the Price column).
function cardPaymentStatusTiers(items) {
  return groupRowsByKindAndTier(
    items,
    cardPaymentStatusKind,
    (item) => ({ amount: item && item.Price, currency: item && item.CurrencyType }),
    CARD_PAYMENT_STATUS_ORDER
  );
}

// A price as a heading shows it: "40", "25.5", "12.75". The tables keep the
// cents everywhere else (money()); a heading is a summary, so a whole amount is
// not padded with ".00".
function compactMoney(value) {
  const n = Number(value);
  return Number.isFinite(n) ? String(Math.round(n * 100) / 100) : "0";
}

// One type's price tiers as the heading words them:
// "Increase: 10× 40 EUR, 20× 25 EUR".
function formatTierGroup(group, labelOf) {
  const tiers = group.tiers
    .map(
      (tier) => `${tier.count}× ${compactMoney(tier.amount)} ${tier.currency}`
    )
    .join(", ");
  return `${labelOf(group.kind)}: ${tiers}`;
}

// The heading label of a cash-ledger count. An annulment keeps its own name so
// it is never read as an Increase or an Expense.
function cashLedgerCountLabel(kind) {
  return kind === "annul" ? t("annulments") : cashTypeLabel(kind);
}

// The heading label of a card-payment count, worded exactly like the table's
// Status column: "Annulled (Broker)", "Annulled (Worker)", "Annulled (No
// fault)", with "Active" for a payment that is still standing.
function cardPaymentStatusCountLabel(kind) {
  if (kind === "active") return t("active");
  if (kind === "deleted") return t("deleted");
  const payer = String(kind).startsWith("annulled-")
    ? String(kind).slice("annulled-".length)
    : "";
  return `${t("annulled")}${annulPayerSuffix(payer)}`;
}

function openModal(title, bodyNode) {
  ModalTitle.textContent = title;
  ModalBody.replaceChildren(bodyNode);
  ModalBackdrop.classList.remove("hidden");
  // Focus the first form control so the field is immediately targetable,
  // avoiding the "loses focus / cannot be clicked" symptom when a form opens.
  const focusTarget = ModalBody.querySelector("input, select, textarea");
  if (focusTarget) focusTarget.focus();
}
function closeModal() {
  ModalBackdrop.classList.add("hidden");
}
ModalClose.addEventListener("click", closeModal);
ModalBackdrop.addEventListener("click", (e) => {
  if (e.target === ModalBackdrop) closeModal();
});
// Escape hotkey: hide the open window (e.g. broker pricing editor).
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (ModalBackdrop.classList.contains("hidden")) return;
  e.preventDefault();
  closeModal();
});

// ---------------------------------------------------------------------------
// Form helpers
// ---------------------------------------------------------------------------
let fieldIdCounter = 0;
function field(labelText, inputNode) {
  const wrap = el("div", null, { class: "field" });
  // Link the label to its control so clicking the caption focuses (and thus
  // targets) the input. Without the `for`/`id` pairing a click on the label
  // does nothing, which made fields feel untargetable.
  // A control can be a wrapper around the real input (a password field carries
  // its eye button, see passwordField), so the label follows `focusTarget`.
  const focusable = inputNode.focusTarget || inputNode;
  const id = `fld-${++fieldIdCounter}-${Date.now()}`;
  const label = el("label", labelText);
  label.setAttribute("for", id);
  focusable.id = focusable.id || id;
  wrap.appendChild(label);
  wrap.appendChild(inputNode);
  return wrap;
}
function input(type, value, placeholder) {
  // A date field always reads dd/mm/yyyy, whatever locale the PC runs in (see
  // renderer/dateField.js). The wrapper behaves like the input it replaces:
  // `.value` is the ISO string, "change" events bubble and min/max pass through.
  if (
    (type === "date" || type === "datetime-local") &&
    typeof createDateField === "function"
  ) {
    return createDateField({
      mode: type === "datetime-local" ? "datetime" : "date",
      value: value === undefined || value === null ? "" : value,
    });
  }
  const node = el("input");
  node.type = type || "text";
  if (value !== undefined && value !== null) node.value = value;
  if (placeholder) node.placeholder = placeholder;
  return node;
}

// A checkbox presented as a pill toggle, matching the compare-field toggles on
// the reconcile daily report: the whole pill is the hit area and the round tick
// on the left says whether it is on. The native checkbox stays inside the
// <label>, so `.checked`, "change" events and disabled all keep working; the
// wrapper exposes it as `.input` to the callers that need to read or set it.
function checkboxToggle(labelText, checked, existingInput) {
  const box = existingInput || input("checkbox");
  if (!existingInput) box.checked = !!checked;
  const wrap = el("label", null, { class: "checkbox-toggle" });
  wrap.appendChild(box);
  wrap.appendChild(el("span", labelText || ""));
  wrap.input = box;
  return wrap;
}


// Password input plus its eye button, laid out by .password-row (app.css) so the
// eye sits inside the field's right edge. Returns the wrapper; `focusTarget`
// lets field() point the label at the input inside it, and buildForm() reads the
// value from the same node.
function passwordField(value, placeholder) {
  const wrap = el("div", null, { class: "password-row" });
  const pass = input("password", value, placeholder);
  const eye = el("button", null, { class: "pw-toggle", type: "button" });
  eye.innerHTML = PASSWORD_EYE_ICON_SVG;
  eye.setAttribute("aria-pressed", "false");
  wrap.appendChild(pass);
  wrap.appendChild(eye);
  wrap.focusTarget = pass;
  setupPasswordToggle(eye, pass);
  return wrap;
}
function select(options, value) {
  const node = el("select");
  for (const opt of options) {
    const o = el("option", opt.label, { value: opt.value });
    if (String(opt.value) === String(value)) o.selected = true;
    node.appendChild(o);
  }
  return node;
}
function textarea(value, placeholder) {
  const node = el("textarea");
  node.value = value || "";
  if (placeholder) node.placeholder = placeholder;
  return node;
}

// Editable list of emails: one input per address with a remove button, plus an
// "add" button. Call `.getValues()` on the returned node to read the result.
function emailListEditor(initial) {
  const wrap = el("div", null, { class: "email-list-editor" });
  const rows = el("div", null, { class: "email-list-rows" });
  wrap.appendChild(rows);

  function addRow(value, focus) {
    const row = el("div", null, { class: "email-list-row" });
    const inp = input("email", value || "", "name@example.com");
    const rm = el("button", "✕", {
      class: "small danger",
      type: "button",
      title: t("delete"),
    });
    rm.addEventListener("click", () => row.remove());
    row.appendChild(inp);
    row.appendChild(rm);
    rows.appendChild(row);
    if (focus) inp.focus();
  }

  (initial || []).forEach((e) => addRow(e));
  if (!initial || initial.length === 0) addRow("");

  const addBtn = el("button", "+ Add email", {
    class: "small secondary",
    type: "button",
  });
  addBtn.addEventListener("click", () => addRow("", true));
  wrap.appendChild(addBtn);

  wrap.getValues = () => {
    const seen = new Set();
    const out = [];
    rows.querySelectorAll("input").forEach((i) => {
      const v = i.value.trim();
      const key = v.toLowerCase();
      if (v && !seen.has(key)) {
        seen.add(key);
        out.push(v);
      }
    });
    return out;
  };
  return wrap;
}

// Editable list of blanc batches: one "start - end" row per batch, a remove
// button per row and an "add batch" button. `.getValues()` returns
// [{ RangeStart, RangeEnd }] for every row with at least one field filled in
// (the server validates the numbers and rejects overlapping ranges).
function batchListEditor(initial) {
  const wrap = el("div", null, { class: "batch-list-editor" });
  const rows = el("div", null, { class: "batch-list-rows" });
  wrap.appendChild(rows);

  function addRow(batch, focus) {
    const row = el("div", null, { class: "batch-list-row" });
    const start = input("number", batch ? batch.RangeStart : "", t("rangeStart"));
    const end = input("number", batch ? batch.RangeEnd : "", t("rangeEnd"));
    start.min = "0";
    end.min = "0";
    start.dataset.role = "start";
    end.dataset.role = "end";
    const rm = el("button", "✕", {
      class: "small danger",
      type: "button",
      title: t("delete"),
    });
    rm.addEventListener("click", () => row.remove());
    row.appendChild(start);
    row.appendChild(el("span", "–", { class: "muted" }));
    row.appendChild(end);
    row.appendChild(rm);
    rows.appendChild(row);
    if (focus) start.focus();
  }

  (initial || []).forEach((b) => addRow(b));
  if (!initial || initial.length === 0) addRow(null);

  const addBtn = el("button", t("addBatch"), {
    class: "small secondary",
    type: "button",
  });
  addBtn.addEventListener("click", () => addRow(null, true));
  wrap.appendChild(addBtn);

  wrap.getValues = () => {
    const out = [];
    rows.querySelectorAll(".batch-list-row").forEach((r) => {
      const s = r.querySelector('[data-role="start"]').value.trim();
      const e = r.querySelector('[data-role="end"]').value.trim();
      if (s || e) out.push({ RangeStart: s, RangeEnd: e });
    });
    return out;
  };
  return wrap;
}

function buildForm(spec, onSubmit, submitLabel) {
  const form = el("form");
  const values = {};
  for (const s of spec) {
    let control;
    if (s.type === "emails") control = emailListEditor(s.value);
    else if (s.type === "batches") control = batchListEditor(s.value);
    else if (s.type === "select") control = select(s.options, s.value);
    else if (s.type === "textarea") control = textarea(s.value, s.placeholder);
    else if (s.type === "password") control = passwordField(s.value, s.placeholder);
    else if (s.type === "checkbox") {
      control = input("checkbox");
      control.checked = !!s.value;
    } else control = input(s.type, s.value, s.placeholder);
    if (s.step !== undefined && s.step !== null) control.step = s.step;
    // A date field can be bounded: the broker top-up's date picker opens on
    // today and must not name a day that has not happened yet.
    if (s.min !== undefined && s.min !== null) control.min = s.min;
    if (s.max !== undefined && s.max !== null) control.max = s.max;
    if (s.readonly) control.readOnly = true;
    // A disabled control is shown but cannot be changed (e.g. the broker of an
    // annulled policy, which the server refuses to move). buildForm still reads
    // its value, so an unchanged field simply travels back as a no-op.
    if (s.disabled) control.disabled = true;
    control.dataset.key = s.key;
    values[s.key] = control;
    if (s.type === "checkbox") {
      // A checkbox is a pill toggle, like the reconcile compare toggles. The
      // .field holder keeps the modal's spacing.
      const holder = el("div", null, { class: "field" });
      holder.appendChild(checkboxToggle(s.label, null, control));
      form.appendChild(holder);
    } else {
      form.appendChild(field(s.label, control));
    }
  }
  const submit = el("button", submitLabel || t("save"), { type: "submit" });
  form.appendChild(submit);

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    submit.disabled = true;
    const payload = {};
    for (const s of spec) {
      const c = values[s.key];
      // The password control is a wrapper (input + eye button): read the input.
      const node = c.focusTarget || c;
      if (s.type === "emails" || s.type === "batches") {
        payload[s.key] = c.getValues();
      } else if (node.type === "checkbox") payload[s.key] = node.checked;
      else if (s.type === "number") payload[s.key] = Number(node.value);
      else payload[s.key] = node.value;
    }
    try {
      await onSubmit(payload);
    } catch (err) {
      toast(err.message, "error");
    } finally {
      submit.disabled = false;
    }
  });

  return form;
}

// ---------------------------------------------------------------------------
// Table helper (with optional per-row action buttons)
//
// `actions` is an array (or a function returning one) of
//   { label, class, onClick, hover?, icon? }
// A normal action renders as a small button. One flagged `hover: true` renders
// as an icon button (default "×") that stays invisible until the row is
// hovered - see the row-hover-x rules in app.css.
//
// `options.revealActions` additionally hides ALL of the row's action buttons
// until the row is hovered or something inside it has the keyboard focus (the
// row-hover-actions rules in app.css). The lists that are read far more often
// than acted on - Brokers, Users and Branches - use it so their buttons never
// clutter the table.
// ---------------------------------------------------------------------------
function renderTable(items, columns, actions, rowClass, onRowClick, options) {
  if (!items || items.length === 0) {
    return el("p", t("noData"), { class: "muted" });
  }
  const table = el("table");
  const thead = el("thead");
  const headRow = el("tr");
  columns.forEach((c) => {
    // A column may replace its plain label with a live node: the brokers
    // table's "Name" header doubles as a filter input. Everything else keeps
    // the ordinary text label.
    const headerNode =
      typeof c.headerRender === "function" ? c.headerRender() : null;
    const th = el(
      "th",
      headerNode ? null : c.label + (c.headerSuffix ? ` ${c.headerSuffix}` : "")
    );
    if (headerNode) th.appendChild(headerNode);
    if (typeof c.onHeaderClick === "function") {
      th.classList.add("sortable");
      th.addEventListener("click", () => c.onHeaderClick());
    }
    headRow.appendChild(th);
  });
  if (actions) headRow.appendChild(el("th", t("actions")));
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = el("tbody");
  for (const item of items) {
    const extraClass = typeof rowClass === "function" ? rowClass(item) : "";
    const rowClasses = [extraClass].filter(Boolean);
    if (typeof onRowClick === "function") rowClasses.push("row-clickable");
    const row = el("tr", null, rowClasses.length ? { class: rowClasses.join(" ") } : null);
    if (typeof onRowClick === "function") {
      row.addEventListener("click", (event) => {
        // Row clicks open the row's own view, but buttons inside the row
        // (e.g. the broker name link and the action buttons) keep their action.
        if (event.target.closest("button")) return;
        onRowClick(item, event);
      });
    }
    columns.forEach((c) => {
      let value = item[c.key];
      if (c.format) value = c.format(value, item);
      if (typeof c.onClick === "function") {
        const link = el("button", value ?? "", {
          class: "link-button",
          type: "button",
        });
        link.addEventListener("click", () => c.onClick(item));
        const linkCell = el("td");
        linkCell.appendChild(link);
        row.appendChild(linkCell);
        return;
      }
      if (typeof c.render === "function") {
        const cell = el("td");
        const node = c.render(value, item);
        if (node) cell.appendChild(node);
        row.appendChild(cell);
        return;
      }
      const cellClass =
        typeof c.cellClass === "function" ? c.cellClass(item) : "";
      row.appendChild(
        el("td", value ?? "", cellClass ? { class: cellClass } : null)
      );
    });

    if (actions) {
      const rowActions =
        typeof actions === "function" ? actions(item) : actions;
      if (rowActions && rowActions.length) {
        const td = el("td");
        // See the renderTable comment: a table that only shows its buttons while
        // the row is hovered gets the extra wrapper class.
        const wrap = el("div", null, {
          class:
            options && options.revealActions
              ? "row actions row-hover-actions"
              : "row actions",
        });
        rowActions.forEach((a) => {
          // A hover action is an icon button (the delete "X") that only shows
          // while the row is hovered, so a long list stays readable and a
          // destructive click is never one stray click away. Its label becomes
          // the tooltip / accessible name, since the button shows the icon.
          if (a.hover) {
            const btn = el("button", a.icon || "×", {
              class: `row-hover-x ${a.class || "danger"}`,
              type: "button",
              title: a.label,
              "aria-label": a.label,
            });
            btn.addEventListener("click", () => a.onClick(item));
            wrap.appendChild(btn);
            return;
          }
          const actionAttrs = { class: `small ${a.class || "secondary"}` };
          if (a.title) actionAttrs.title = a.title;
          // Only the visible label is used for a normal action button, so the
          // title doubles as its tooltip (the cut-off action uses one).
          const btn = el("button", a.label, actionAttrs);
          if (a.title) btn.setAttribute("aria-label", a.label);
          btn.addEventListener("click", () => a.onClick(item));
          wrap.appendChild(btn);
        });
        td.appendChild(wrap);
        row.appendChild(td);
      }
    }
    tbody.appendChild(row);
  }
  table.appendChild(tbody);
  return table;
}

// ---------------------------------------------------------------------------
// Sortable tables
//
// A thin wrapper around renderTable: every column with a key is sortable
// unless it sets `sortable: false`. The first click sorts descending (highest
// or newest first), the second click flips it. The sort state lives in the
// caller, so re-rendering a page (a new date, a refresh) keeps the chosen
// order. Columns may give `sortValue` when the displayed text is not what
// should be compared (e.g. a role label vs its number) and `sortType`
// ("text" | "number" | "date") when the value needs explicit handling.
// ---------------------------------------------------------------------------
function tableSortValue(row, column) {
  if (!row) return null;
  const value =
    typeof column.sortValue === "function"
      ? column.sortValue(row)
      : row[column.sortKey || column.key];
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.getTime();
  const text = String(value).trim();
  if (text === "") return null;
  if (column.sortType === "number") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  if (column.sortType === "date") {
    const t = Date.parse(text.replace(" ", "T"));
    return Number.isNaN(t) ? null : t;
  }
  if (column.sortType === "text") return text;
  // No explicit type: numbers sort numerically, everything else as text.
  const n = Number(value);
  return Number.isFinite(n) ? n : text;
}

function sortTableRows(items, columns, sort) {
  const list = Array.isArray(items) ? [...items] : [];
  if (!sort || !sort.key) return list;
  const column = columns.find((c) => (c.sortKey || c.key) === sort.key);
  if (!column) return list;
  const sign = sort.dir === "asc" ? 1 : -1;
  return list.sort((a, b) => {
    const av = tableSortValue(a, column);
    const bv = tableSortValue(b, column);
    // Empty values sink to the bottom in both directions.
    if (av === null || bv === null) {
      return av === bv ? 0 : av === null ? 1 : -1;
    }
    if (typeof av === "number" && typeof bv === "number") {
      return sign * (av - bv);
    }
    return (
      sign *
      String(av).localeCompare(String(bv), undefined, {
        numeric: true,
        sensitivity: "base",
      })
    );
  });
}

function sortableTable(items, columns, actions, rowClass, onRowClick, options) {
  const opts = options || {};
  const state = opts.sort || { key: null, dir: "desc" };
  const holder = el("div", null, { class: "sortable-table" });
  const render = () => {
    const headerColumns = columns.map((c) => {
      const key = c.sortKey || c.key;
      if (!key || c.sortable === false) return c;
      return {
        ...c,
        headerSuffix:
          state.key !== key ? "" : state.dir === "desc" ? "▼" : "▲",
        onHeaderClick: () => {
          state.dir =
            state.key === key && state.dir === "desc" ? "asc" : "desc";
          state.key = key;
          render();
        },
      };
    });
    holder.replaceChildren(
      renderTable(
        sortTableRows(items, columns, state),
        headerColumns,
        actions,
        rowClass,
        onRowClick,
        opts
      )
    );
  };
  render();
  return holder;
}

// A collapsible table section: the heading stays visible - with the number of
// rows it holds and, when given, a per-type price breakdown such as
// "Increase: 10× 40 EUR, 20× 25 EUR" - and the body only opens when the heading
// is clicked, so a busy day does not bury the rest of the page. A render
// starts collapsed; only the Current cash tab re-opens the folds the user left
// open (see applyCashFoldState).
function collapsibleSection(title, count, nodes, breakdown, foldKey) {
  const details = el("details", null, { class: "collapsible-section" });
  // A stable key lets the Current cash view keep the open/closed state across a
  // rebuild (a new day or branch) instead of folding everything again.
  if (foldKey) details.setAttribute("data-cash-fold", foldKey);
  const summary = el("summary", `${title} (${count})`);
  if (breakdown && breakdown.length > 0) {
    summary.appendChild(
      el("span", `— ${breakdown.join(" · ")}`, { class: "collapsible-counts" })
    );
  }
  details.appendChild(summary);
  const body = el("div", null, { class: "collapsible-body" });
  for (const node of nodes) body.appendChild(node);
  details.appendChild(body);
  return details;
}

// A balance card that starts FOLDED. The heading is the summary; clicking it
// unfolds the figures. Used for the three big Current cash reports so a busy
// day does not fill the screen before anything is asked for. options.foldKey
// lets the tab keep the card as the user left it across a day/branch change
// (see applyCashFoldState).
function foldedCard(title, options = {}) {
  const details = el("details", null, {
    class: `balance-card folded-card${options.className ? ` ${options.className}` : ""}`,
  });
  if (options.foldKey) details.setAttribute("data-cash-fold", options.foldKey);
  if (options.hint) details.title = options.hint;
  const summary = el("summary");
  summary.appendChild(el("h3", title));
  details.appendChild(summary);
  return details;
}

// ---------------------------------------------------------------------------
// Edit-insurance price recalculation
// ---------------------------------------------------------------------------
// Changing the duration or the vehicle type of a policy in the edit modal
// recalculates its price from the same tariffs the add-insurance form uses:
// the broker's tariffs for email (broker-linked) policies - falling back to the
// branch walk-in tariffs when the broker has none, like /tariffs/policy-pricing
// does - and the branch walk-in tariffs for walk-ins. The stored non-Turk fee
// (+5 EUR / +200 TRY) is added on top, like the add form (the +2 card fee is
// visual-only and never added to the price or any balance).
const EDIT_DURATION_OPTIONS = [15, 30, 90];
const EDIT_VEHICLE_TYPES = ["Automobile", "Motor", "Bus", "Trailer"];
// Branch dropdown options for the edit form. Mirrors the login page's branch
// dropdown below, so the lists cannot drift apart.
let EDIT_BRANCHES = ["ГКПП Капитан Андреево", "ГКПП Лесово", "Офис Харманли"];
const EDIT_NON_TURK_FEE = 5;
const EDIT_NON_TURK_FEE_TRY = 200;

// The non-Turk fee is currency-specific: EUR 5, Turkish lira 200.
function editNonTurkFee(currency) {
  return String(currency).toUpperCase() === "TRY"
    ? EDIT_NON_TURK_FEE_TRY
    : EDIT_NON_TURK_FEE;
}

// Stored Otomobil value -> tariff key ("Auto" / "Motor" / "Bus" / "Trailer").
// Accepts the values the add form stores as well as their Bulgarian labels.
function pricingVehicleKey(otomobil) {
  const v = String(otomobil ?? "").trim().toLowerCase();
  if (!v) return null;
  if (
    v === "automobile" ||
    v === "otomobil" ||
    v === "auto" ||
    v === "автомобил" ||
    v === "лек автомобил"
  )
    return "Auto";
  if (v === "motor" || v === "мотор") return "Motor";
  if (v === "bus" || v === "бус") return "Bus";
  if (v === "trailer" || v === "ремарке") return "Trailer";
  return null;
}

// MySQL flags arrive as 0/1 (number or string) or booleans.
function editFlag(value) {
  return value === true || value === 1 || value === "1";
}

// Duration dropdown options (values in days). A stored duration that is not
// one of the standard ones is kept as an extra option, so opening the editor
// never changes it silently.
function editDurationOptions(current) {
  const options = EDIT_DURATION_OPTIONS.map((d) => ({
    label: t(`duration.${d}`, `${d} ${t("days")}`),
    value: d,
  }));
  const hasCurrent = current !== undefined && current !== null && current !== "";
  if (!hasCurrent) {
    options.unshift({ label: "", value: "" });
  } else if (!EDIT_DURATION_OPTIONS.some((d) => String(d) === String(current))) {
    options.push({ label: `${current} ${t("days")}`, value: current });
  }
  return options;
}

// Vehicle type dropdown options. Like the duration, an unknown stored value
// (e.g. a legacy free-text one) is kept as an extra option.
function editVehicleOptions(current) {
  const options = EDIT_VEHICLE_TYPES.map((v) => ({
    label: t(`vehicle.${v}`, v),
    value: v,
  }));
  const hasCurrent = current !== undefined && current !== null && current !== "";
  if (!hasCurrent) {
    options.unshift({ label: "", value: "" });
  } else if (!EDIT_VEHICLE_TYPES.includes(String(current))) {
    options.push({ label: String(current), value: current });
  }
  return options;
}

// Branch dropdown options for the edit form. Like the duration/vehicle
// dropdowns, an unknown stored value (a legacy or hand-typed branch) is kept as
// an extra option so opening the editor never silently reassigns the policy.
function editBranchOptions(current) {
  const options = EDIT_BRANCHES.map((name) => ({ label: name, value: name }));
  const hasCurrent = current !== undefined && current !== null && current !== "";
  if (!hasCurrent) {
    options.unshift({ label: "", value: "" });
  } else if (!EDIT_BRANCHES.includes(String(current))) {
    options.push({ label: String(current), value: current });
  }
  return options;
}

// Price for the given vehicle type + duration including the policy's fees, or
// null when the tariffs have no price for that combination.
function editedPolicyPrice(pricing, otomobil, duration, fees, currency) {
  const type = pricingVehicleKey(otomobil);
  const days = Number(duration);
  if (!type || !Number.isFinite(days) || days <= 0) return null;
  if (!pricing || !pricing[type]) return null;
  const raw = pricing[type][days];
  if (raw === undefined || raw === null || raw === "") return null;
  const base = Number(raw);
  if (!Number.isFinite(base)) return null;
  let total = base;
  if (fees && fees.nonTurk) total += editNonTurkFee(currency);
  return Math.round(total * 100) / 100;
}

// Tariffs that apply to the edited policy. Responses are kept in `cache` for
// as long as the modal is open, so each source is requested at most once.
async function loadEditPricing(insurance, branch, cache) {
  const brokerId = insurance.BrokerId;
  if (brokerId !== null && brokerId !== undefined && brokerId !== "") {
    const key = `broker:${brokerId}`;
    if (!(key in cache)) {
      const data = await api(`/tariffs/broker/${encodeURIComponent(brokerId)}`);
      cache[key] = (data && data.pricing) || {};
    }
    if (Object.keys(cache[key]).length > 0) return cache[key];
  }
  if (!branch) return {};
  const key = `branch:${branch}`;
  if (!(key in cache)) {
    const data = await api(`/tariffs/branch/${encodeURIComponent(branch)}`);
    cache[key] = (data && data.pricing) || {};
  }
  return cache[key];
}

// Hooks the duration / vehicle type dropdowns of the edit form up to the price
// field. Tariffs are only fetched once one of them actually changes.
function wireEditPriceRecalc(form, insurance) {
  if (!form || typeof form.querySelector !== "function") return;
  const control = (key) => form.querySelector(`[data-key="${key}"]`);
  const priceInput = control("Price");
  const durationInput = control("Duration");
  const vehicleInput = control("Otomobil");
  if (!priceInput || !durationInput || !vehicleInput) return;
  const branchInput = control("Branch");
  // The broker picked in the form (admins only: the field exists for them). A
  // reassignment therefore recalculates from the NEW broker's tariffs instead
  // of the stored one's.
  const brokerInput = control("BrokerId");
  const pricingRow = () =>
    brokerInput
      ? {
          ...insurance,
          BrokerId:
            String(brokerInput.value ?? "").trim() === ""
              ? null
              : Number(brokerInput.value),
        }
      : insurance;
  // Non-Turk fee checkbox (only exists for walk-ins: email policies are
  // broker-paid and the non-Turk tax only applies to walk-ins).
  const nonTurkInput = control("NonTurk");
  // Card fee checkbox (also walk-in only). It is purely visual - it never
  // changes the price or any balance - and only applies while the policy is
  // paid by card, so it is locked (and cleared) when Cash is selected.
  const cardFeeInput = control("CardFee");
  const paymentInput = control("PaymentType");
  const currencyInput = control("CurrencyType");
  // Currency that decides the non-Turk fee: what is selected now, or stored.
  const currencyValue = () =>
    currencyInput && currencyInput.value
      ? currencyInput.value
      : insurance.CurrencyType || "EUR";

  // Fees currently selected in the form. A missing box (email policy) means
  // no fee. The card fee is deliberately NOT part of this: it is visual-only.
  function selectedFees() {
    return {
      nonTurk: !!nonTurkInput && !!nonTurkInput.checked,
    };
  }

  // Adds `delta` to the price field (never below 0). An empty price is left
  // alone - there is nothing to put the fee on top of.
  function shiftPrice(delta) {
    const raw = String(priceInput.value ?? "").trim().replace(",", ".");
    if (!raw) return;
    const current = Number(raw);
    if (!Number.isFinite(current)) return;
    const next = Math.max(0, Math.round((current + delta) * 100) / 100);
    priceInput.value = next.toFixed(2);
  }

  // Fees already included in the price shown in the field.
  let appliedFees = selectedFees();

  // The fee checkbox changed: add/remove that fee from the current price, so a
  // hand-corrected price is kept as well. The server moves current cash / the
  // card balance by the price difference.
  function onFeesChanged() {
    const fees = selectedFees();
    let delta = 0;
    if (fees.nonTurk !== appliedFees.nonTurk) {
      const fee = editNonTurkFee(currencyValue());
      delta += fees.nonTurk ? fee : -fee;
    }
    appliedFees = fees;
    if (delta) shiftPrice(delta);
  }

  // The card fee only makes sense for card payments, so it is disabled (and
  // unticked) while Cash is selected - the same rule as on the add form.
  function applyCardFeeGating() {
    if (!cardFeeInput || !paymentInput) return;
    if (paymentInput.value === "Cash") {
      cardFeeInput.checked = false;
      cardFeeInput.disabled = true;
    } else {
      cardFeeInput.disabled = false;
    }
  }

  const cache = {};
  let latest = 0;

  async function recalc() {
    const request = ++latest;
    const branch = String(
      branchInput ? branchInput.value : insurance.Branch ?? ""
    ).trim();
    let pricing;
    try {
      pricing = await loadEditPricing(pricingRow(), branch, cache);
    } catch (err) {
      console.warn("Failed to load pricing for the edited policy:", err);
      if (request === latest) toast(t("edit.pricingLoadFailed"), "error");
      return;
    }
    // A newer change started while this one was loading; let it win.
    if (request !== latest) return;

    const fees = selectedFees();
    const price = editedPolicyPrice(
      pricing,
      vehicleInput.value,
      durationInput.value,
      fees,
      currencyValue()
    );
    if (price === null) {
      // Keep the current price; the worker can still correct it by hand.
      toast(t("edit.priceUnavailable"), "error");
      return;
    }
    priceInput.value = price.toFixed(2);
    // The recalculated price already contains exactly these fees.
    appliedFees = fees;
  }

  durationInput.addEventListener("change", recalc);
  vehicleInput.addEventListener("change", recalc);
  if (nonTurkInput) nonTurkInput.addEventListener("change", onFeesChanged);
  if (paymentInput) {
    paymentInput.addEventListener("change", applyCardFeeGating);
  }

  // Start with the card fee locked while the policy is paid in cash.
  applyCardFeeGating();
}

// ---------------------------------------------------------------------------
// Modal form for editing an insurance (admins + workers)
// ---------------------------------------------------------------------------

// Normalise a stored date to the "YYYY-MM-DD" string an <input type="date">
// needs in order to display it. The server may return the start date as a full
// "YYYY-MM-DD HH:MM:SS" datetime (or a Date object), which a date input rejects
// and leaves blank, so only the calendar-day part is kept. Empty or unparsable
// values become "" so the field is simply left unset rather than wrongly filled.
function dateInputValue(value) {
  if (value === undefined || value === null || value === "") return "";
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return "";
    const p = (n) => String(n).padStart(2, "0");
    return `${value.getFullYear()}-${p(value.getMonth() + 1)}-${p(
      value.getDate()
    )}`;
  }
  const m = String(value)
    .trim()
    .match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : "";
}

// ---------------------------------------------------------------------------
// Admin-only author / broker dropdowns of the edit form
// ---------------------------------------------------------------------------
// Admins can correct who authored a policy and which broker it belongs to.
// The two lists come from the server (the live staff accounts and the live
// brokers) and are cached for the session; the lookup tab refreshes them just
// before a row is opened, so only the first modal of a session waits for them.
let insuranceEditAuthors = [];
let insuranceEditBrokers = [];
let insuranceEditLookupsLoaded = false;
let insuranceEditLookupsRequest = null;

// Fetch the accounts and brokers used by the admin-only fields. Failures are
// thrown to the caller, which still opens the editor with the stored values;
// concurrent calls share one request.
function loadInsuranceEditLookups() {
  if (insuranceEditLookupsRequest) return insuranceEditLookupsRequest;
  insuranceEditLookupsRequest = (async () => {
    const [users, brokers] = await Promise.all([
      api("/admin/users"),
      api("/brokers"),
    ]);
    insuranceEditAuthors = Array.from(
      new Set(
        ((users && users.users) || [])
          .map((u) => String((u && u.Username) || "").trim())
          .filter(Boolean)
      )
    ).sort((a, b) => a.localeCompare(b));
    insuranceEditBrokers = ((brokers && brokers.brokers) || [])
      .map((b) => ({
        id: Number(b && b.id),
        name: String((b && b.Name) || "").trim(),
        code: String((b && b.Code) || "").trim(),
      }))
      .filter((b) => Number.isInteger(b.id) && b.id > 0 && b.name)
      .sort((a, b) => a.name.localeCompare(b.name));
    insuranceEditLookupsLoaded = true;
    return { authors: insuranceEditAuthors, brokers: insuranceEditBrokers };
  })().finally(() => {
    insuranceEditLookupsRequest = null;
  });
  return insuranceEditLookupsRequest;
}

// Options of the Author dropdown: every staff account, with the stored author
// kept selectable even when that account is gone (an unchanged value is never
// re-validated by the server, so opening the editor cannot silently reassign it).
function editAuthorOptions(current) {
  const stored = String(current ?? "").trim();
  let names = insuranceEditAuthors.filter((n) => n !== stored);
  // Before the lists arrive (or when they cannot be loaded) the signed-in admin
  // is still a sensible choice, and an empty stored author keeps an empty option
  // so the select never jumps to someone else.
  if (!names.length && typeof username === "string" && username) {
    names = [username];
  }
  return (stored ? [stored, ...names] : ["", ...names]).map((name) => ({
    label: name,
    value: name,
  }));
}

// Selectable value of the Broker dropdown: the linked broker's id, or "" for a
// walk-in (no broker).
function editBrokerValue(insurance) {
  const id = Number(insurance && insurance.BrokerId);
  return Number.isInteger(id) && id > 0 ? String(id) : "";
}

// Options of the Broker dropdown. "" means "no broker": the policy is a
// walk-in paid in cash or by card. A broker that is no longer in the list (e.g.
// a soft-deleted one) stays selectable so the stored assignment is preserved.
function editBrokerOptions(insurance) {
  const currentId = Number(insurance && insurance.BrokerId);
  const options = [{ label: t("addAdmin.brokerNone"), value: "" }];
  const list = insuranceEditBrokers.slice();
  if (
    Number.isInteger(currentId) &&
    currentId > 0 &&
    !list.some((b) => b.id === currentId)
  ) {
    list.push({
      id: currentId,
      name: String((insurance && insurance.Broker) || currentId),
      code: "",
    });
  }
  for (const b of list) {
    options.push({
      label: b.code ? `${b.name} (${b.code})` : b.name,
      value: String(b.id),
    });
  }
  return options;
}

// Opens the editor, first making sure the admin-only dropdown data is loaded.
// Only the first modal of a session waits for it; later ones open straight away
// and refresh the cache in the background. A failed lookup still opens the
// modal (with the stored values) instead of blocking the edit.
async function openInsuranceEditorFor(insurance, onDone) {
  if (userRole === "1") {
    if (insuranceEditLookupsLoaded) {
      loadInsuranceEditLookups().catch((err) => {
        console.warn("Failed to refresh the insurance edit lookups:", err);
      });
    } else {
      try {
        await loadInsuranceEditLookups();
      } catch (err) {
        console.warn("Failed to load the insurance edit lookups:", err);
      }
    }
  }
  return openInsuranceEditor(insurance, onDone);
}

// `onDone` (optional) runs after a successful save so the calling view can
// refresh itself — the same pattern openAnnulForm/deleteInsurance use. Editing
// the price, the payment type, the branch or the currency also moves the money
// behind the policy on the server (current cash / card balance), so the list has
// to be re-rendered for the change to be visible.
function openInsuranceEditor(insurance, onDone) {
  // Email (broker-linked) policies are paid ONLY from the broker's balance, so
  // their payment type cannot be edited at all. Walk-ins choose Cash or Card.
  const isEmailPolicy =
    insurance.BrokerId !== null &&
    insurance.BrokerId !== undefined &&
    insurance.BrokerId !== "";

  const spec = [
    {
      key: "PolicyNumber",
      label: t("add.policyNumber"),
      value: insurance.PolicyNumber,
    },
    // Plain text inputs (not "number"): buildForm would turn a number input
    // into Number(...), dropping leading zeros and turning "" into 0.
    {
      key: "BlancNumber",
      label: t("add.blancNumber"),
      value: insurance.BlancNumber,
    },
    {
      key: "CarNumber",
      label: t("add.carNumber"),
      value: insurance.CarNumber,
    },
    // Admins see and edit the price of any policy. Workers see it only for
    // walk-ins (the non-Turk / card-fee fees below apply to walk-ins and the
    // recalculated price has to stay visible to them) and can read but not type
    // it. Broker (email) prices stay hidden from workers.
    //
    // Once a policy is annulled its stored Price IS the annulment tax, so the
    // field is read-only for everyone: the tax is changed through the Fee field
    // below (the server keeps Price = AnnulFee).
    ...(userRole === "1" || !isEmailPolicy
      ? [
          {
            key: "Price",
            label: t("price"),
            type: "number",
            value: insurance.Price,
            readonly: userRole !== "1" || Boolean(Number(insurance.Annulled)),
          },
        ]
      : []),
    {
      key: "CurrencyType",
      label: t("currency"),
      type: "select",
      options: [
        { label: "EUR", value: "EUR" },
        { label: "TRY", value: "TRY" },
      ],
      value: insurance.CurrencyType || "EUR",
    },
    // Duration and vehicle type are dropdowns: changing either one
    // recalculates the price from the tariffs (see wireEditPriceRecalc).
    {
      key: "Duration",
      label: t("add.duration"),
      type: "select",
      options: editDurationOptions(insurance.Duration),
      value: insurance.Duration,
    },
    {
      key: "Branch",
      label: t("add.branch"),
      type: "select",
      options: editBranchOptions(insurance.Branch),
      value: insurance.Branch,
    },
    {
      key: "Otomobil",
      label: t("add.vehicleType"),
      type: "select",
      options: editVehicleOptions(insurance.Otomobil),
      value: insurance.Otomobil,
    },
    {
      key: "StartDate",
      label: t("add.startDate"),
      type: "date",
      value: dateInputValue(insurance.StartDate),
    },
  ];
  // Admins may also correct who authored the policy and which broker it belongs
  // to. Assigning a broker turns the policy into a broker-paid one (the server
  // refunds the previous broker and charges the new one); "no broker" makes it a
  // walk-in again, paid in cash or by card.
  if (userRole === "1") {
    spec.push({
      key: "Author",
      label: t("author"),
      type: "select",
      options: editAuthorOptions(insurance.Author),
      value: String(insurance.Author ?? ""),
    });
    spec.push({
      key: "BrokerId",
      label: t("broker"),
      type: "select",
      options: editBrokerOptions(insurance),
      value: editBrokerValue(insurance),
      // An annulled policy was already refunded through its original broker, so
      // the server refuses to move it; do not offer the change.
      disabled: Boolean(Number(insurance.Annulled)),
    });
  }
  if (!isEmailPolicy) {
    spec.push({
      key: "PaymentType",
      label: t("paymentType"),
      type: "select",
      options: [
        { label: t("payment.Card"), value: "Card" },
        { label: t("payment.Cash"), value: "Cash" },
      ],
      value: insurance.PaymentType === "Cash" ? "Cash" : "Card",
    });
  }
  // The non-Turk option chosen when the policy was created. Toggling it adds
  // or removes its fee (+5 EUR / +200 TRY) from the price (see
  // wireEditPriceRecalc), and the
  // server moves current cash / the card balance by the difference. Only
  // applies to walk-ins: email policies are broker-paid and the non-Turk tax
  // is a walk-in charge.
  if (!isEmailPolicy) {
    spec.push({
      key: "NonTurk",
      label: t("add.nonTurk"),
      type: "checkbox",
      value: editFlag(insurance.NonTurk),
    });
    // The card payment fee (+2) is purely visual: it can be ticked or unticked
    // while the policy is paid by card (wireEditPriceRecalc locks it for cash),
    // but it never changes the price or any balance.
    spec.push({
      key: "CardFee",
      label: t("add.cardFee"),
      type: "checkbox",
      value: editFlag(insurance.CardFee),
    });
  }
  // Admins can change who is at fault and the fee for an already-annulled
  // insurance, and can un-annul (restore) it so it stands as a normal policy
  // again. The checkbox is ticked because the policy is annulled; unticking it
  // and saving sends Annulled: false and removes the annulment.
  if (userRole === "1" && editFlag(insurance.Annulled)) {
    spec.push({
      key: "Annulled",
      label: t("annulled"),
      type: "checkbox",
      value: true,
    });
    const storedReason = String(insurance.AnnulReason || "")
      .trim()
      .toLowerCase();
    spec.push({
      key: "AnnulReason",
      label: t("annulPayer"),
      type: "select",
      options: [
        { label: t("annul.payer.broker"), value: "broker" },
        { label: t("annul.payer.worker"), value: "worker" },
        { label: t("annul.payer.none"), value: "none" },
      ],
      value: ["broker", "worker", "none"].includes(storedReason)
        ? storedReason
        : "broker",
    });
    // A text input (not "number") so an empty field stays empty in the payload
    // instead of becoming 0: leaving it blank means "keep the stored fee", while
    // typing a value overrides it. Pre-filled with the stored fee when present.
    spec.push({
      key: "AnnulFee",
      label: t("annulFee"),
      value:
        insurance.AnnulFee !== undefined &&
        insurance.AnnulFee !== null &&
        insurance.AnnulFee !== ""
          ? insurance.AnnulFee
          : "",
      placeholder: "0.00",
    });
  }

  const form = buildForm(
    spec,
    async (payload) => {
      // Both numbers are required, exactly like on the add form. Throwing
      // keeps the modal open and buildForm toasts the message.
      if ("BlancNumber" in payload) {
        payload.BlancNumber = String(payload.BlancNumber ?? "").trim();
        if (!payload.BlancNumber) throw new Error(t("add.blancNumberRequired"));
      }
      if ("CarNumber" in payload) {
        payload.CarNumber = String(payload.CarNumber ?? "").trim();
        if (!payload.CarNumber) throw new Error(t("add.carNumberRequired"));
      }
      // The "Annulled" checkbox is only shown for annulled policies, so leaving
      // it ticked (true) means "keep it annulled" - a no-op that is not sent.
      // Unticking it (false) is the restore action and is sent to the server.
      if ("Annulled" in payload) {
        if (payload.Annulled) delete payload.Annulled;
      }
      // Only send the annulment fee when the admin actually changed it: an empty
      // field means "keep the stored fee" (or let the server compute it for rows
      // that predate the fee), and an unchanged value keeps the server's own
      // fault/fee logic (e.g. re-deciding it after a start-date correction).
      if ("AnnulFee" in payload) {
        const raw = String(payload.AnnulFee ?? "").trim();
        if (raw === "") {
          delete payload.AnnulFee;
        } else {
          const entered = Number(raw.replace(",", "."));
          if (!Number.isFinite(entered) || entered < 0) {
            throw new Error(t("annulFeeInvalid"));
          }
          const hadFee =
            insurance.AnnulFee !== undefined &&
            insurance.AnnulFee !== null &&
            insurance.AnnulFee !== "";
          if (hadFee && entered === Number(insurance.AnnulFee)) {
            delete payload.AnnulFee;
          } else {
            payload.AnnulFee = entered;
          }
        }
      }
      // The URL always names the policy by its CURRENT (stored) blank number;
      // a new one travels in the body and is adopted below once saved.
      // Stamp the resulting ledger movements with the worker's local time (the
      // server stores CreatedAt as sent instead of its own UTC clock).
      payload.CreatedAt = localDateTimeNow();
      const data = await api(`/insurances/${insurance.BlancNumber}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      // Adopt the stored row (the server returns the policy as it is now,
      // including any normalisation it applied) so a view rendering from its
      // local rows immediately shows the new price/payment type.
      if (data && data.insurance) Object.assign(insurance, data.insurance);
      toast(t("insuranceUpdated"), "success");
      closeModal();
      if (onDone) onDone(data);
      return data;
    },
    t("saveChanges")
  );
  // An annulled policy's price is its fixed annulment tax, not a tariff price,
  // so the duration / vehicle type dropdowns must not recalculate it.
  if (!Boolean(Number(insurance.Annulled))) wireEditPriceRecalc(form, insurance);

  openModal(`${t("editInsurance")} ${insurance.BlancNumber}`, form);
}

// ---------------------------------------------------------------------------
// Annulment modal (admins + workers)
// ---------------------------------------------------------------------------
// The fee is decided by whether the policy is already in effect when it is
// annulled (now has reached its start date): 9 if it is, 1 if it has not
// started yet. Who pays it (broker or worker) is chosen in the form; "no
// fault" charges no fee at all. Admins can override the fee by hand; otherwise
// the server computes the same fee on its own.
const ANNUL_FEE_NOT_IN_EFFECT = 1;
const ANNUL_FEE_IN_EFFECT = 9;

// Local midnight of the policy's start date, or null when it has none.
function annulStartDate(value) {
  if (value === undefined || value === null || value === "") return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return new Date(value.getFullYear(), value.getMonth(), value.getDate());
  }
  const m = String(value)
    .trim()
    .match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

// A policy without a start date is treated as in effect (the higher fee).
function isPolicyInEffect(insurance, now = new Date()) {
  const start = annulStartDate(insurance.StartDate);
  if (!start) return true;
  return now.getTime() >= start.getTime();
}

function openAnnulForm(insurance, onDone) {
  const price = Number(insurance.Price) || 0;
  const currency = insurance.CurrencyType || "";
  // A broker-linked (email) policy is funded by the broker's own balance, so its
  // refund goes back to the broker rather than out of the cash drawer / card.
  const isBrokerLinked =
    insurance.BrokerId !== null &&
    insurance.BrokerId !== undefined &&
    insurance.BrokerId !== "";

  const isAdmin = userRole === "1";

  // The automatic fee (1 before the start date, 9 once in effect). Admins can
  // override it by typing their own value; workers always get this fee.
  const autoFee = () =>
    isPolicyInEffect(insurance) ? ANNUL_FEE_IN_EFFECT : ANNUL_FEE_NOT_IN_EFFECT;

  const feeInput = isAdmin ? input("number", "0", "0") : null;
  if (feeInput) {
    feeInput.min = "0";
    feeInput.step = "0.01";
  }

  const storedPayer = String(insurance.AnnulReason || "")
    .trim()
    .toLowerCase();
  const payerSelect = select(
    [
      { label: t("annul.payer.broker"), value: "broker" },
      { label: t("annul.payer.worker"), value: "worker" },
      { label: t("annul.payer.none"), value: "none" },
    ],
    ["broker", "worker", "none"].includes(storedPayer) ? storedPayer : "broker"
  );

  const statusLine = el("p", "", { class: "muted" });
  const feeLine = el("p", "", { class: "muted" });
  const refundLine = el("p", "", { class: "big" });

  // Keep the fee field in step with the automatic suggestion: pre-filled with
  // the computed fee, cleared and locked for a "no fault" annulment (which is
  // always free).
  function syncFeeInput() {
    if (!feeInput) return;
    if (payerSelect.value === "none") {
      feeInput.disabled = true;
      feeInput.value = "";
    } else {
      feeInput.disabled = false;
      feeInput.value = String(autoFee());
    }
  }

  // The fee shown in the preview: the admin's typed value when it is valid,
  // otherwise the automatic one (and always 0 for no fault).
  function previewFee() {
    if (payerSelect.value === "none") return 0;
    if (!feeInput) return autoFee();
    const raw = String(feeInput.value ?? "").trim().replace(",", ".");
    if (raw === "") return autoFee();
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : autoFee();
  }

  // The fee an admin explicitly typed (null when nothing valid was entered, so
  // the server keeps computing it). Workers never send one.
  function manualFee() {
    if (!isAdmin || !feeInput || payerSelect.value === "none") return null;
    const raw = String(feeInput.value ?? "").trim().replace(",", ".");
    if (raw === "") return null;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : null;
  }

  function updatePreview() {
    const inEffect = isPolicyInEffect(insurance);
    // No fault is always free; otherwise the start date decides (or the admin's
    // typed fee).
    const noFault = payerSelect.value === "none";
    const fee = previewFee();
    // The broker is refunded the full price unless the broker itself is at
    // fault, in which case only the price minus the fee comes back. Everyone
    // else (cash/card) always gets price - fee.
    const refund = isBrokerLinked
      ? payerSelect.value === "broker"
        ? Math.max(0, Math.round((price - fee) * 100) / 100)
        : price
      : Math.max(0, Math.round((price - fee) * 100) / 100);
    statusLine.textContent = t(
      noFault ? "annulNoFault" : inEffect ? "annulInEffect" : "annulNotInEffect"
    );
    // Show who pays next to the fee; a no-fault annulment has no payer.
    feeLine.textContent = noFault
      ? `${t("annulFee")}: ${money(fee)} ${currency}`
      : `${t("annulFee")}: ${money(fee)} ${currency} (${t(
          `annul.payer.${payerSelect.value}`
        )})`;
    refundLine.textContent = `${t("annulRefund")}: ${money(
      refund
    )} ${currency}`;
  }
  payerSelect.addEventListener("change", () => {
    syncFeeInput();
    updatePreview();
  });
  if (feeInput) feeInput.addEventListener("input", updatePreview);
  syncFeeInput();
  updatePreview();

  const form = el("form");
  form.appendChild(field(t("annulPayer"), payerSelect));
  if (feeInput) {
    form.appendChild(field(t("annulFee"), feeInput));
    form.appendChild(el("p", t("annulFeeAdminNote"), { class: "muted" }));
  }
  form.appendChild(el("p", t("annulFeeNote"), { class: "muted" }));
  form.appendChild(statusLine);
  form.appendChild(feeLine);
  form.appendChild(refundLine);

  const submit = el("button", t("annulSubmit"), { class: "danger" });
  submit.type = "submit";
  form.appendChild(submit);

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    submit.disabled = true;
    try {
      const body = {
        payer: payerSelect.value,
        CreatedAt: localDateTimeNow(),
      };
      const fee = manualFee();
      if (fee !== null) body.fee = fee;
      const data = await api(`/insurances/${insurance.BlancNumber}/annul`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (data && data.insurance) Object.assign(insurance, data.insurance);
      toast(t("insuranceAnnulled"), "success");
      closeModal();
      if (onDone) onDone(data);
    } catch (err) {
      toast(err.message, "error");
    } finally {
      submit.disabled = false;
    }
  });

  openModal(`${t("annulConfirmTitle")} ${insurance.BlancNumber}`, form);
}

// ---------------------------------------------------------------------------
// Admin views
// ---------------------------------------------------------------------------

// Fetch the currently enabled branches so the edit form's branch dropdown
// always reflects newly created / disabled branches.
async function loadEnabledBranches() {
  try {
    const data = await api("/branches");
    const names = (data && data.branches ? data.branches : [])
      .map((b) => b.Name)
      .filter(Boolean);
    if (names.length > 0) {
      EDIT_BRANCHES = names;
    }
  } catch (err) {
    console.warn("Failed to load branches:", err);
  }
}

// Sort state of the users table. Kept outside the DOM so saving a user,
// restoring one or switching languages keeps the chosen order.
let userSort = { key: null, dir: "desc" };
let deletedUserSort = { key: null, dir: "desc" };

async function adminUsers() {
  // ?includeDeleted=1 also returns the soft-deleted accounts (data.deleted), so
  // the panel can offer Restore; the live list itself never contains them.
  const [data, brokerData] = await Promise.all([
    api("/admin/users?includeDeleted=1"),
    api("/brokers"),
  ]);
  const brokerList = (brokerData && brokerData.brokers) || [];
  // Soft-deleted accounts: shown in their own list at the bottom, greyed out,
  // each with a Restore button (the delete is reversible).
  const deletedUsers = (data && data.deleted) || [];
  const brokerById = new Map(brokerList.map((b) => [Number(b.id), b]));
  const brokerNameOf = (id) => {
    if (id === null || id === undefined || id === "") return "";
    const b = brokerById.get(Number(id));
    return b ? b.Name : "";
  };
  const mainBrokerOf = (u) => {
    const b = brokerById.get(Number(u.BrokerId));
    return b ? brokerNameOf(b.ParentBrokerId) : "";
  };
  const promoteRoleOptions = [
    { label: t("role.2"), value: 2 },
    { label: t("role.3"), value: 3 },
  ];

  const toolbar = el("div", null, { class: "row" });
  const addUserBtn = el("button", t("newUser"));
  addUserBtn.addEventListener("click", () => registerUserForm());
  toolbar.appendChild(addUserBtn);

  const table = sortableTable(
    data.users,
    [
      { key: "Username", label: t("username"), sortType: "text" },
      {
        key: "Role",
        label: t("role"),
        format: (v) => roleLabel(v),
        sortType: "number",
      },
      {
        key: "Balance",
        label: t("balance"),
        format: (v) => money(v),
        sortType: "number",
      },
      {
        key: "BrokerId",
        sortKey: "BrokerName",
        label: t("brokerName"),
        format: (v) => brokerNameOf(v) || "—",
        sortValue: (u) => brokerNameOf(u.BrokerId),
        sortType: "text",
      },
      {
        key: "BrokerId",
        sortKey: "MainBroker",
        label: t("mainBroker"),
        format: (_v, u) => mainBrokerOf(u) || "—",
        sortValue: (u) => mainBrokerOf(u),
        sortType: "text",
      },
      { key: "Status", label: t("status"), sortType: "text" },
    ],
    (u) => [
      {
        label: t("edit"),
        class: "",
        onClick: (u) => {
          const currentBrokerId = u.BrokerId == null ? null : Number(u.BrokerId);
          const currentBroker =
            currentBrokerId == null
              ? null
              : brokerList.find((b) => Number(b.id) === currentBrokerId);

          const brokerOptions = [
            { label: "—", value: "" },
            ...brokerList.map((b) => ({ label: b.Name, value: b.id })),
          ];
          const mainBrokerOptions = [
            { label: "—", value: "" },
            ...brokerList
              .filter((b) => Number(b.id) !== currentBrokerId)
              .map((b) => ({ label: b.Name, value: b.id })),
          ];

          const spec = [
            {
              key: "broker",
              label: t("brokerName"),
              type: "select",
              options: brokerOptions,
              value: currentBrokerId == null ? "" : currentBrokerId,
            },
          ];

          // The main broker is a property of the broker the account is linked
          // to, so it is only editable while a broker is linked.
          if (currentBrokerId != null) {
            spec.push({
              key: "mainBroker",
              label: t("mainBroker"),
              type: "select",
              options: mainBrokerOptions,
              value:
                currentBroker && currentBroker.ParentBrokerId != null
                  ? currentBroker.ParentBrokerId
                  : "",
            });
          }

          // Admins cannot change their own (or another admin's) role.
          if (String(u.Role) !== "1") {
            spec.push({
              key: "role",
              label: t("role"),
              type: "select",
              options: promoteRoleOptions,
              value: u.Role,
            });
          }

          spec.push({
            key: "balance",
            label: t("balance"),
            type: "number",
            value: u.Balance,
          });

          const form = buildForm(
            spec,
            async (payload) => {
              const brokerId =
                payload.broker === "" || payload.broker == null
                  ? null
                  : Number(payload.broker);

              const userPatch = { BrokerId: brokerId };
              if (payload.role !== undefined && payload.role !== "") {
                userPatch.role = Number(payload.role);
              }
              if (payload.balance !== undefined) {
                userPatch.balance = Number(payload.balance);
              }

              await api(`/admin/users/${u.Username}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(userPatch),
              });

              // Update the linked broker's main broker only when it changed;
              // the endpoint also resets sub-broker tariffs when a parent is
              // assigned, so a no-op save must not trigger it.
              if (currentBrokerId != null) {
                const parentId =
                  payload.mainBroker === "" || payload.mainBroker == null
                    ? null
                    : Number(payload.mainBroker);
                const currentParentId =
                  currentBroker && currentBroker.ParentBrokerId != null
                    ? Number(currentBroker.ParentBrokerId)
                    : null;
                if (parentId !== currentParentId) {
                  await api(`/brokers/${currentBrokerId}`, {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ ParentBrokerId: parentId }),
                  });
                }
              }

              toast(t("userUpdated"), "success");
              closeModal();
              adminUsers();
            },
            t("save")
          );
          openModal(`${t("edit")} ${u.Username}`, form);
        },
      },
      {
        label: t("suspend"),
        class: "secondary",
        onClick: async (u) => {
          try {
            await api(`/admin/users/${u.Username}/suspend`, { method: "POST" });
            toast(t("userSuspended"), "success");
            adminUsers();
          } catch (err) {
            toast(err.message, "error");
          }
        },
      },
      {
        label: t("delete"),
        class: "danger",
        hover: true,
        onClick: (u) => deleteUser(u, () => adminUsers()),
      },
    ],
    null,
    null,
    { revealActions: true, sort: userSort }
  );
  // Live accounts first; the soft-deleted ones (if any) are listed separately so
  // they can be restored without cluttering the table above.
  const children = [el("h2", t("users")), toolbar, table];
  if (deletedUsers.length) {
    children.push(el("h3", t("deletedUsers")));
    children.push(
      sortableTable(
        deletedUsers,
        [
          { key: "Username", label: t("username"), sortType: "text" },
          {
            key: "Role",
            label: t("role"),
            format: (v) => roleLabel(v),
            sortType: "number",
          },
          {
            key: "DeletedAt",
            label: t("deleted"),
            format: (v) => formatDateTime(v),
            sortType: "date",
          },
          { key: "DeletedBy", label: t("deletedBy"), sortType: "text" },
        ],
        (u) => [
          {
            label: t("restore"),
            class: "secondary",
            onClick: (u) => restoreUser(u, () => adminUsers()),
          },
        ],
        () => "row-deleted",
        null,
        { revealActions: true, sort: deletedUserSort }
      )
    );
  }
  Content.replaceChildren(...children);
}

function registerUserForm() {
  const form = buildForm(
    [
      { key: "username", label: t("username"), value: "" },
      { key: "password", label: t("password"), type: "password", value: "" },
      {
        key: "role",
        label: t("role"),
        type: "select",
        options: [
          { label: t("role.1"), value: 1 },
          { label: t("role.2"), value: 2 },
          { label: t("role.3"), value: 3 },
        ],
        value: 3,
      },
    ],
    async (payload) => {
      const res = await fetch(`${API_BASE}/userreg`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${getToken()}`,
        },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 401) {
        redirectToLogin("sessionExpired");
        throw new Error(data.error || t("sessionExpired"));
      }
      if (!res.ok) {
        throw new Error(data.error || t("registrationFailed"));
      }
      toast(t("userCreated").replace("{u}", data.username), "success");
      closeModal();
      adminUsers();
    },
    t("createUser")
  );
  openModal(t("newUser"), form);
}

// ---------------------------------------------------------------------------
// Branch management (admin only)
// ---------------------------------------------------------------------------

// List every branch (enabled and disabled) and let the admin create a new
// branch, rename one, or toggle it on/off. A disabled branch disappears from
// the login dropdown and blocks new insurances through it (enforced server-
// side). The server owns the branch registry; the client only drives it.
async function adminBranches() {
  const data = await api("/admin/branches");
  const branches = (data && data.branches ? data.branches : []).slice();
  branches.sort((a, b) => String(a.Name).localeCompare(String(b.Name)));

  const toolbar = el("div", null, { class: "row" });
  const addBtn = el("button", t("newBranch"));
  addBtn.addEventListener("click", () => branchForm());
  toolbar.appendChild(addBtn);

  const table = renderTable(
    branches,
    [
      { key: "Name", label: t("branchName") },
      {
        key: "Enabled",
        label: t("status"),
        format: (enabled) =>
          enabled ? t("branchEnabled") : t("branchDisabled"),
        cellClass: (b) => (b.Enabled ? "" : "muted"),
      },
      {
        key: "CreatedAt",
        label: t("created"),
        format: (v) => formatDateTime(v),
      },
    ],
    (branch) => [
      {
        label: t("edit"),
        class: "secondary",
        onClick: (b) => branchForm(b),
      },
      {
        // The on/off toggle is the row's hovering "X" (a tick when it brings the
        // branch back), so it looks and behaves like the deletes elsewhere.
        label: branch.Enabled ? t("disable") : t("enable"),
        class: branch.Enabled ? "danger" : "secondary",
        hover: true,
        icon: branch.Enabled ? "×" : "✓",
        onClick: async (b) => {
          try {
            await api(`/admin/branches/${b.id}`, {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ enabled: !b.Enabled }),
            });
            toast(t("branchUpdated"), "success");
            adminBranches();
            loadEnabledBranches();
          } catch (err) {
            toast(err.message, "error");
          }
        },
      },
    ],
    null,
    null,
    { revealActions: true }
  );

  Content.replaceChildren(el("h2", t("branches")), toolbar, table);
}

// Create (no argument) or rename (branch argument) a branch. Branches cannot be
// deleted — only disabled — so renaming is the only way to change a name.
function branchForm(branch) {
  const isEdit = !!branch;
  const form = buildForm(
    [
      {
        key: "name",
        label: t("branchName"),
        value: branch ? branch.Name : "",
      },
    ],
    async (payload) => {
      const name = String(payload.name ?? "").trim();
      if (!name) throw new Error(t("err.branchNameRequired"));

      if (isEdit) {
        await api(`/admin/branches/${branch.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name }),
        });
        toast(t("branchUpdated"), "success");
      } else {
        await api("/admin/branches", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name }),
        });
        toast(t("branchCreated"), "success");
      }
      closeModal();
      adminBranches();
      loadEnabledBranches();
    },
    isEdit ? t("saveChanges") : t("createBranch")
  );
  openModal(isEdit ? t("editBranch") : t("newBranch"), form);
}


// Soft-delete an insurance from the admin panel. The row is kept in the
// database (tagged with Deleted/DeletedAt/DeletedBy by the server) so it is
// never lost, but it is removed from `data.insurances` here so it disappears
// from the list without a reload, and the server excludes it from every
// other list/search endpoint so it no longer gets parsed (e.g. in the daily
// reconcile report).
async function deleteInsurance(insurance, onDone) {
  const confirmed = await appConfirm(
    t("deleteInsuranceConfirm").replace("{b}", insurance.BlancNumber),
    { danger: true, confirmLabel: t("delete") }
  );
  if (!confirmed) {
    return;
  }
  try {
    await api(`/insurances/${insurance.BlancNumber}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        CreatedAt: localDateTimeNow(),
      }),
    });
    toast(t("insuranceDeleted"), "success");
    if (onDone) onDone();
  } catch (err) {
    toast(err.message, "error");
  }
}

// Restore a previously soft-deleted insurance from the admin panel. The server
// re-applies the money the deletion removed (re-charging the broker when the
// policy was broker-funded) and sets Deleted back to 0, so the policy reappears
// in lists and reports.
async function restoreInsurance(insurance, onDone) {
  const confirmed = await appConfirm(
    t("restoreInsuranceConfirm").replace("{b}", insurance.BlancNumber),
    { confirmLabel: t("restore") }
  );
  if (!confirmed) {
    return;
  }
  try {
    await api(`/insurances/${insurance.BlancNumber}/restore`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        CreatedAt: localDateTimeNow(),
      }),
    });
    toast(t("insuranceRestored"), "success");
    if (onDone) onDone();
  } catch (err) {
    toast(err.message, "error");
  }
}

// Soft-delete a user account from the Users panel (the row's hovering "X"). The
// account is kept in the database - the server tags it with
// Deleted/DeletedAt/DeletedBy and drops its sessions - so it can no longer sign
// in or appear in the users list, but an admin can bring it back with
// restoreUser.
async function deleteUser(user, onDone) {
  const confirmed = await appConfirm(
    t("deleteUserConfirm").replace("{u}", user.Username),
    { danger: true, confirmLabel: t("delete") }
  );
  if (!confirmed) {
    return;
  }
  try {
    await api(`/admin/users/${user.Username}/delete`, { method: "POST" });
    toast(t("userDeleted"), "success");
    if (onDone) onDone();
  } catch (err) {
    toast(err.message, "error");
  }
}

// Restore a soft-deleted account: the server clears the Deleted flags, so the
// account can sign in and shows up in the users list again. Nothing else is
// reapplied - the delete never touched the password, broker link or balance.
async function restoreUser(user, onDone) {
  const confirmed = await appConfirm(
    t("restoreUserConfirm").replace("{u}", user.Username),
    { confirmLabel: t("restore") }
  );
  if (!confirmed) {
    return;
  }
  try {
    await api(`/admin/users/${user.Username}/restore`, { method: "POST" });
    toast(t("userRestored"), "success");
    if (onDone) onDone();
  } catch (err) {
    toast(err.message, "error");
  }
}

// Soft-delete a broker (the row's hovering "X"). The broker's balance, blanc
// batches, emails, tariffs and policies stay untouched - the server only tags
// the row with Deleted/DeletedAt/DeletedBy - so the broker disappears from the
// lists and stops being recognised as an email sender, and an admin can bring it
// back with restoreBroker.
async function deleteBroker(broker, onDone) {
  const confirmed = await appConfirm(
    t("deleteBrokerConfirm").replace("{b}", broker.Name),
    { danger: true, confirmLabel: t("delete") }
  );
  if (!confirmed) {
    return;
  }
  try {
    await api(`/brokers/${broker.id}`, { method: "DELETE" });
    toast(t("brokerDeleted"), "success");
    if (onDone) onDone();
  } catch (err) {
    toast(err.message, "error");
  }
}

// Restore a soft-deleted broker: the server clears the Deleted flags, so the
// broker (with the balance and blancs it kept) reappears in the lists.
async function restoreBroker(broker, onDone) {
  const confirmed = await appConfirm(
    t("restoreBrokerConfirm").replace("{b}", broker.Name),
    { confirmLabel: t("restore") }
  );
  if (!confirmed) {
    return;
  }
  try {
    await api(`/brokers/${broker.id}/restore`, { method: "POST" });
    toast(t("brokerRestored"), "success");
    if (onDone) onDone();
  } catch (err) {
    toast(err.message, "error");
  }
}

// Soft-delete one entry of the Current cash ledger (admin only, the row's
// hovering "X"). The entry is kept in the database - tagged with
// Deleted/DeletedAt/DeletedBy by the server - but it disappears from the ledger
// (and from the day's expenses and totals), and the money it moved is reversed:
// an increase is taken back off the drawer, a reduction is put back in. The
// server rejects a reversal the drawer cannot fund (e.g. the money was already
// spent or reset), so the balance can never go negative here.
async function deleteCashTransaction(tx, onDone) {
  const text = t("deleteTransactionConfirm")
    .replace("{i}", tx.id)
    .replace("{t}", t(tx.Type))
    .replace("{a}", money(tx.Amount))
    .replace("{c}", tx.Currency)
    .replace("{r}", tx.Reason || "");
  const confirmed = await appConfirm(text, {
    danger: true,
    confirmLabel: t("delete"),
  });
  if (!confirmed) {
    return;
  }
  try {
    await api(`/currentcash/transactions/${tx.id}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        CreatedAt: localDateTimeNow(),
      }),
    });
    toast(t("transactionDeleted"), "success");
    if (onDone) onDone();
  } catch (err) {
    toast(err.message, "error");
  }
}

// Local calendar day as "YYYY-MM-DD" (built from local components, not
// toISOString, so the day never shifts around midnight).
function localDateString(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// Current local wall-clock time as "YYYY-MM-DD HH:MM:SS" (MySQL DATETIME).
// Sent as the transaction/reset creation time so the server stores the
// client's local time instead of the database server's (UTC) clock.
function localDateTimeNow(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  );
}

// The CreatedAt of a broker movement recorded for a chosen day and time of day
// ("YYYY-MM-DDTHH:mm" from an admin's picker): both are kept, so a backdated
// payment can say when it really happened. A bare day ("YYYY-MM-DD") keeps the
// current time of day, so the row still sorts last within its day. An empty or
// malformed value means "now".
function brokerMovementCreatedAt(picked, now = new Date()) {
  const stamp = localDateTimeNow(now);
  const value = String(
    picked === undefined || picked === null ? "" : picked
  ).trim();
  const m = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}):(\d{2}))?$/.exec(value);
  if (!m) return stamp;
  return `${m[1]} ${
    m[2] === undefined ? stamp.slice(11) : `${m[2]}:${m[3]}:00`
  }`;
}

// The current local wall clock as an <input type="datetime-local"> value
// ("YYYY-MM-DDTHH:mm"), the default of the admin's day-and-time pickers.
function localDateTimeInputNow(d = new Date()) {
  return localDateTimeNow(d).slice(0, 16).replace(" ", "T");
}

// The datetime-local value ("YYYY-MM-DDTHH:mm") of a stored DATETIME, so a
// picker opens on the moment that is actually recorded.
function datetimeInputValue(value) {
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})/.exec(
    String(value === undefined || value === null ? "" : value).trim()
  );
  return m ? `${m[1]}T${m[2]}:${m[3]}` : "";
}

// "YYYY-MM-DD" one calendar day after the given local date string.
function nextLocalDate(dateString) {
  const [y, m, d] = dateString.split("-").map(Number);
  return localDateString(new Date(y, m - 1, d + 1));
}

// "YYYY-MM-DD" one calendar day before the given local date string.
function previousLocalDate(dateString) {
  const [y, m, d] = dateString.split("-").map(Number);
  return localDateString(new Date(y, m - 1, d - 1));
}

// Admin-only fix for a shift that was never ended (e.g. an employee forgot to
// finish last night's shift).
//
// POST /currentcash/reset-asof splits all three branch balances at the cutoff
// from their movement timestamps: the part held at midnight is recorded as
// kept, and everything created after midnight stays in the live balances. The
// card balance and Cash from Brokers are split exactly like the cash drawer.
// A dry run returns the split for the confirmation; the real call applies it
// atomically on the server.
function fixShiftCashLabel(amounts) {
  return ["EUR", "TRY"]
    .map((currency) => `${money(amounts[currency] || 0)} ${currency}`)
    .join(" · ");
}

// Ask the server for a dry-run split of the cash drawer, card balance and Cash
// from Brokers at the shift cutoff. Nothing is written.
async function previewForgottenShiftSplit(branch, cutoff) {
  return api("/currentcash/reset-asof", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ branch, Cutoff: cutoff, DryRun: true }),
  });
}

async function applyForgottenShiftSplit(branch, cutoff) {
  return api("/currentcash/reset-asof", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ branch, Cutoff: cutoff }),
  });
}

function openForgottenShiftFix(branch, defaultDate) {
  const info = el("div", null, { class: "fix-shift" });
  info.appendChild(el("p", t("fixShiftHint")));

  const form = buildForm(
    [
      {
        key: "date",
        label: t("fixShiftDate"),
        type: "date",
        value: defaultDate,
      },
    ],
    async (payload) => {
      const shiftDate = String(payload.date || "").trim();
      const cutoff = shiftEndOfDayTimestamp(shiftDate);
      if (!cutoff) throw new Error(t("fixShiftInvalid"));
      if (shiftCloseIsFuture(cutoff, new Date())) {
        throw new Error(t("fixShiftFuture"));
      }

      let preview;
      try {
        preview = await previewForgottenShiftSplit(branch, cutoff);
      } catch (err) {
        throw new Error(translateError(err.message) || err.message);
      }
      const confirmed = await appConfirm(
        fmt(t("fixShiftConfirm"), {
          date: formatDateOnly(shiftDate),
          cutoff: formatDateTime(cutoff),
          keptCash: fixShiftCashLabel(preview.kept.cash),
          keptCard: money(preview.kept.card),
          keptBroker: fixShiftCashLabel(preview.kept.brokerCash),
          remainCash: fixShiftCashLabel(preview.remaining.cash),
          remainCard: money(preview.remaining.card),
          remainBroker: fixShiftCashLabel(preview.remaining.brokerCash),
        })
      );
      if (!confirmed) return;

      let applied;
      try {
        applied = await applyForgottenShiftSplit(branch, cutoff);
      } catch (err) {
        throw new Error(translateError(err.message) || err.message);
      }
      toast(
        fmt(t("fixShiftDone"), {
          date: formatDateOnly(shiftDate),
          keptCash: fixShiftCashLabel(applied.kept.cash),
          keptCard: money(applied.kept.card),
          keptBroker: fixShiftCashLabel(applied.kept.brokerCash),
        }),
        "success"
      );
      closeModal();
      // Show the closed day, where the new End shift rows are listed.
      currentCashView(branch, shiftDate);
    },
    t("fixShiftSubmit")
  );
  info.appendChild(form);
  openModal(t("fixShiftTitle"), info);
}

// Monotonic counter used to drop out-of-order renders: switching branch/date
// starts a new load, and only the most recently started one may paint. Without
// this, a slower earlier request can finish last and overwrite the UI with a
// stale branch, mixing up the daily report.
let currentCashSeq = 0;

// The day picked in the Current cash tab, kept outside the DOM. Switching nav
// tabs throws the view away and rebuilds it on return, so without this the day
// jumped back to today every time - the user had to re-pick it. Null means no
// day has been picked yet, so the tab opens on today.
let currentCashDate = null;

// The currencies the drawer tracks. Every cash movement (including a hand-over)
// records one of these; a new movement defaults to EUR, while TRY can be picked
// explicitly and is deducted from the TRY balance.
const CASH_CURRENCY_OPTIONS = [
  { label: "EUR", value: "EUR" },
  { label: "TRY", value: "TRY" },
];

// Sort state of the four ledger tables in the Current cash tab. Kept outside
// the DOM so changing the day (which rebuilds the view) or sorting one table
// never loses the order the other tables were left in.
const cashTableSort = {
  transactions: { key: null, dir: "desc" },
  expenses: { key: null, dir: "desc" },
  brokerCash: { key: null, dir: "desc" },
  cardInsurances: { key: null, dir: "desc" },
  cashInsurances: { key: null, dir: "desc" },
  resets: { key: null, dir: "desc" },
  handovers: { key: null, dir: "desc" },
  bankHistory: { key: null, dir: "desc" },
  bankHandovers: { key: null, dir: "desc" },
};

// True when a per-currency balance object holds anything besides zero.
function hasNonZeroCash(balances) {
  return Object.values(balances || {}).some((value) => Number(value) !== 0);
}

// Sum the per-branch money rows the daily endpoint returns (each row carries
// Branch, EUR and TRY) into one per-currency object.
function cashRowsTotal(rows) {
  const total = { EUR: 0, TRY: 0 };
  for (const row of rows || []) {
    total.EUR += Number(row && row.EUR) || 0;
    total.TRY += Number(row && row.TRY) || 0;
  }
  total.EUR = Math.round(total.EUR * 100) / 100;
  total.TRY = Math.round(total.TRY * 100) / 100;
  return total;
}

// Add two per-currency money objects (e.g. the undone cash and broker-balance
// hand-overs) into one. Currencies the ledger supports are always present.
function sumCashBalances(first, second) {
  const total = { EUR: 0, TRY: 0 };
  for (const currency of Object.keys(total)) {
    total[currency] =
      Math.round(
        ((Number(first && first[currency]) || 0) +
          (Number(second && second[currency]) || 0)) *
          100
      ) / 100;
  }
  return total;
}

// The cash hand-overs recorded on one day. The hand-over statistics are
// company-wide and always live (see getHandoverStats on the server), so the list
// under them would otherwise ignore the day picker. CreatedAt is the local
// wall-clock DATETIME ("YYYY-MM-DD HH:MM:SS") the entry was stored with, so its
// first ten characters are the day the money was handed over.
function handoversOnDay(handovers, date) {
  return (handovers || []).filter(
    (handover) =>
      String((handover && handover.CreatedAt) || "").slice(0, 10) === date
  );
}

// Make a Current cash balance card a shortcut to its table. Cards with a zero
// balance stay inert: there is nothing to look at in the ledger. The card is
// also keyboard reachable, since it now behaves like a button.
function activateCashCard(card, section, active) {
  if (!card || !section || !active) return;
  card.classList.add("clickable");
  card.tabIndex = 0;
  card.setAttribute("role", "button");
  const open = () => {
    section.open = true;
    if (typeof section.scrollIntoView === "function") {
      section.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  };
  card.addEventListener("click", open);
  card.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    open();
  });
}

// The folding sections and cards of the Current cash tab carry a stable
// data-cash-fold key. Picking another day (or branch, or saving a movement)
// rebuilds the whole view; without this every fold the user had opened closed
// itself again and the table being read was lost. cashOpenFolds() records what
// was open in the view about to be replaced, applyCashFoldState() re-opens it
// on the rebuilt nodes and - when the tab was already on screen - marks the
// reloaded figures with .cash-updated, whose short flash (WorkPage.css) says
// "the data inside changed" without moving anything.
function cashOpenFolds() {
  const open = new Set();
  if (!Content || typeof Content.querySelectorAll !== "function") return open;
  for (const details of Content.querySelectorAll("details[data-cash-fold]")) {
    if (details.open) open.add(details.getAttribute("data-cash-fold"));
  }
  return open;
}

// `roots` are the new top-level nodes of the view: the cards row and each
// ledger section. A root may be a folding element itself or contain the folded
// cards. Only folds that were open are re-opened, so a first visit still starts
// folded. `flash` is true only when this is a rebuild of a view already on
// screen: a fresh visit gets no animation.
function applyCashFoldState(roots, openFolds, flash) {
  for (const root of roots) {
    if (!root || typeof root.querySelectorAll !== "function") continue;
    const folds = [];
    if (root.matches && root.matches("details[data-cash-fold]")) {
      folds.push(root);
    }
    folds.push(...root.querySelectorAll("details[data-cash-fold]"));
    for (const details of folds) {
      if (openFolds.has(details.getAttribute("data-cash-fold"))) {
        details.open = true;
      }
    }
    if (!flash) continue;
    // Every reloaded figure flashes once: the folding sections and the balance
    // cards above them.
    const figures = new Set(folds);
    if (root.matches && root.matches(".balance-card")) figures.add(root);
    for (const card of root.querySelectorAll(".balance-card")) {
      figures.add(card);
    }
    for (const node of figures) node.classList.add("cash-updated");
  }
}

async function currentCashView(overrideBranch, overrideDate) {
  const seq = ++currentCashSeq;

  // The tab may already be on screen - the day picker, the one-day steps, a
  // branch switch or a save all rebuild it. Remember which folds the user had
  // opened before the old view is thrown away: changing the day must swap only
  // the figures inside them, never fold the table being read. A fresh visit
  // through runLoader finds nothing here and opens collapsed, as before.
  const refreshing =
    Content.querySelectorAll("details[data-cash-fold]").length > 0;
  const openFolds = cashOpenFolds();

  // Admins can inspect/manage any branch's cash (not just the branch they
  // logged in with); workers are always scoped to their own login branch.
  const isAdmin = userRole === "1";
  let branch = overrideBranch || getBranch();

  // The transaction/reset history is shown one day at a time. A day the caller
  // asks for wins, then the day this tab was last left on; the first visit (and
  // every visit after "today" was picked) opens on today.
  const now = new Date();
  const today = localDateString(now);
  const date = overrideDate || currentCashDate || today;
  if (overrideDate) {
    // Remember a picked day so changing tabs and coming back keeps it. "Today"
    // is deliberately not stored: that leaves the tab opening on the real today
    // even when the app stays open past midnight.
    currentCashDate = overrideDate === today ? null : overrideDate;
  }

  let allBranchNames = [];
  if (isAdmin) {
    // The list carries the same derived drawer balance as this screen, so the
    // dashboard and this tab cannot disagree. tzOffset lets the server work out
    // the same "today".
    const branchesData = await api(
      `/currentcash/branches?tzOffset=${-now.getTimezoneOffset()}`
    );
    allBranchNames = Object.keys(branchesData.branches || {}).sort();
    // If the admin's own login branch has no record yet, default to the
    // first known branch so the view is never blank.
    if (!branch && allBranchNames.length) branch = allBranchNames[0];
  }

  // tzOffset (minutes east of UTC) lets the server work out the same "today".
  const tzOffset = -now.getTimezoneOffset();
  const dailyQuery =
    `/currentcash/daily?date=${encodeURIComponent(date)}` +
    `&tzOffset=${tzOffset}`;
  const [data, daily, dailyAll, bank] = await Promise.all([
    api(
      `/currentcash?branch=${encodeURIComponent(branch)}` +
        `&date=${encodeURIComponent(date)}` +
        `&tzOffset=${tzOffset}`
    ),
    // Branch-scoped daily figures: the Drawers card needs this branch's
    // available cash, broker top-ups and card payments.
    api(`${dailyQuery}&branch=${encodeURIComponent(branch)}`),
    // Country-wide daily figures for the Daily report card. The counts were
    // always country-wide; this call makes the money statistic country-wide
    // too instead of showing the selected branch only.
    api(dailyQuery),
    // The company bank account is admin-only. The server refuses the call for
    // anyone else, so it is simply not requested. A server that does not have
    // the endpoint yet must not take the whole cash screen down with it.
    isAdmin
      ? api(`/bank?tzOffset=${tzOffset}`).catch(() => null)
      : Promise.resolve(null),
  ]);

  // A newer load (branch or date switch) started while this one was in flight;
  // drop this stale response so it cannot overwrite the fresh view.
  if (seq !== currentCashSeq) return;

  const heading = el("h2", t("currentCash"));

  // Always show which branch the cash balance belongs to — never display a
  // balance without saying which branch holds it.
  heading.appendChild(
    el("span", ` — ${t("branch")}: ${branch || t("unknownBranch")}`, {
      class: "muted",
    })
  );

  // Admins get a row of buttons to switch between branches without needing to
  // log out/in with a different branch selected. The active branch is
  // highlighted; clicking another branch reloads the view for it. The buttons
  // sit on the left of the header row that also holds the day picker (built
  // further down, once the shown day is known).
  const branchSelector = el("div", null, { class: "branch-selector" });
  if (isAdmin && allBranchNames.length > 1) {
    for (const name of allBranchNames) {
      const isActive = name === branch;
      const btn = el("button", name, {
        class: isActive ? "branch-btn active" : "branch-btn",
        "aria-pressed": isActive ? "true" : "false",
      });
      btn.addEventListener("click", () => {
        currentCashView(name, date).catch((err) => toast(err.message, "error"));
      });
      branchSelector.appendChild(btn);
    }
  }

  // Balance cards are shortcuts to the ledger below them. Every role gets the
  // Available cash and Card balance cards; the card titles carry no branch
  // name (the heading above the row already says which branch is shown).
  const cardsRow = el("div", null, { class: "cash-cards" });
  const leftCol = el("div", null, { class: "cash-cards-left" });
  // Kept in variables (rather than only inside the blocks below) so each card
  // can be wired to its ledger section once the sections exist.
  let balanceCard = null;
  let cardCard = null;
  let bankCard = null;

  // The branch's cash drawer, derived from its cash policies and manual
  // movements for the picked day (the day picker below switches it).
  balanceCard = el("div", null, { class: "balance-card" });
  balanceCard.appendChild(el("h3", t("availableCash")));
  fillBalanceCard(balanceCard, daily.availableCash || {});
  leftCol.appendChild(balanceCard);

  // Cash from brokers: the money brokers handed over at this branch since its
  // last reset. It is kept apart from the cash drawer above (a broker top-up
  // no longer increases Available cash), so it is shown to everyone, admins
  // included.
  const brokerCashCard = el("div", null, { class: "balance-card" });
  brokerCashCard.appendChild(el("h3", t("cashFromBrokers")));
  fillBalanceCard(brokerCashCard, data.brokerCash);
  leftCol.appendChild(brokerCashCard);

  // The branch's card balance - cleared together with the cash by "Reset to 0".
  cardCard = el("div", null, { class: "balance-card" });
  cardCard.appendChild(el("h3", t("cardBalance")));
  cardCard.appendChild(el("p", money(data.cardBalance), { class: "big" }));
  leftCol.appendChild(cardCard);

  // The company bank account is visible to admins only. It is a monthly figure
  // and does not follow the branch selector.
  if (isAdmin && bank) {
    bankCard = el("div", null, {
      class: "balance-card bank-card",
      title: t("bankAccountHint"),
    });
    bankCard.appendChild(el("h3", t("bankAccount")));
    fillBalanceCard(bankCard, bank.balance);
    bankCard.appendChild(
      el("p", fmt(t("bankMonthLabel"), { month: bank.month }), {
        class: "muted",
      })
    );
    leftCol.appendChild(bankCard);
  }
  cardsRow.appendChild(leftCol);

  // Expenses: the money this branch spent out of its drawer on the picked day
  // (the "Expense" entries). A card so the day's total can be read at a glance;
  // the individual entries stay in the collapsible list below. Hand-overs are
  // not spends and are never part of this figure.
  // Note: the server still spells its payload fields `totalExpences` /
  // `expences`, so those keep the old spelling here - only the UI text is
  // corrected.
  const expensesCard = el("div", null, {
    class: "balance-card expenses-card",
    title: t("expensesHint"),
  });
  expensesCard.appendChild(el("h3", t("expenses")));
  fillBalanceCard(expensesCard, data.totalExpences);
  cardsRow.appendChild(expensesCard);

  // A row inside a report card. `extraClass` lets a sub-figure be indented
  // under the total it belongs to.
  const dailyStat = (label, value, hint, extraClass) => {
    const attrs = {
      class: extraClass
        ? `daily-report-row ${extraClass}`
        : "daily-report-row",
    };
    if (hint) attrs.title = hint;
    const row = el("div", null, attrs);
    row.appendChild(el("span", label, { class: "muted" }));
    row.appendChild(el("span", value));
    return row;
  };
  // The two halves of the Daily report card.
  const dailyGroup = (label) =>
    el("h4", label, { class: "daily-report-group" });
  // The country-wide figure is the distance between the day's lowest and
  // highest policy number, so name the two policies that set those ends: a
  // single mistyped or out-of-series number is what makes the figure jump, and
  // showing the two policy numbers makes that visible straight away.
  const dailyRangeStat = (label, value, range, hint) => {
    const attrs = { class: "daily-report-row" };
    if (hint) attrs.title = hint;
    const row = el("div", null, attrs);
    row.appendChild(el("span", label, { class: "muted" }));
    const box = el("div", null, { class: "daily-report-range" });
    box.appendChild(
      el("span", String(value ?? 0), { class: "daily-report-range-value" })
    );
    const first = range && range.first;
    const last = range && range.last;
    const entries = [];
    if (
      first &&
      last &&
      first.BlancNumber &&
      first.BlancNumber === last.BlancNumber
    ) {
      // One numbered policy that day: it sets both ends of the range.
      entries.push(["countryWideSinglePolicy", first]);
    } else {
      if (first) entries.push(["countryWideFromPolicy", first]);
      if (last) entries.push(["countryWideToPolicy", last]);
    }
    for (const [labelKey, policy] of entries) {
      // Only the policy number is shown for these two rows. The rest of the
      // record (blank number, branch, author, date) made the line long enough
      // to run out of the card, so it stays in the API payload and is not
      // rendered here.
      const line = el("div", null, { class: "daily-report-policy" });
      line.appendChild(el("span", t(labelKey), { class: "muted" }));
      line.appendChild(
        el("span", policy.PolicyNumber, { class: "daily-report-policy-number" })
      );
      box.appendChild(line);
    }
    row.appendChild(box);
    return row;
  };

  // Hand-over statistics (admin only): how much money left the company because
  // it was handed to a person - from a branch drawer or from a broker's balance
  // - and how much of it has come back. The figures cover every branch and
  // every broker, so they do not change with the branch selector above; the
  // outstanding hand-overs are listed further down with their branch.
  if (isAdmin && data.handoverStats) {
    const stats = data.handoverStats;
    const handoverCard = foldedCard(t("handoverStats"), {
      foldKey: "handoverStats",
      className: "handover-card",
      hint: t("handoverStatsHint"),
    });

    handoverCard.appendChild(dailyGroup(t("handoverGroupHandedOver")));
    handoverCard.appendChild(
      dailyStat(
        t("handedOverFromDrawer"),
        renderCashBalances(stats.cash && stats.cash.handedOver),
        t("handedOverFromDrawerHint")
      )
    );
    handoverCard.appendChild(
      dailyStat(
        t("handedOverFromBrokerBalance"),
        renderCashBalances(stats.balance && stats.balance.handedOver),
        t("handedOverFromBrokerBalanceHint")
      )
    );

    handoverCard.appendChild(dailyGroup(t("handoverGroupReturns")));
    handoverCard.appendChild(
      dailyStat(
        t("returnedToDrawer"),
        renderCashBalances(stats.cash && stats.cash.returnedToDrawer),
        t("returnedToDrawerHint")
      )
    );
    handoverCard.appendChild(
      dailyStat(
        t("returnedToBank"),
        renderCashBalances(stats.cash && stats.cash.returnedToBank),
        t("returnedToBankHint")
      )
    );
    handoverCard.appendChild(
      dailyStat(
        t("handoverUndone"),
        renderCashBalances(
          sumCashBalances(
            stats.cash && stats.cash.undone,
            stats.balance && stats.balance.undone
          )
        ),
        t("handoverUndoneHint")
      )
    );

    handoverCard.appendChild(dailyGroup(t("handoverGroupOutstanding")));
    handoverCard.appendChild(
      dailyStat(
        t("handoverCashOutstanding"),
        renderCashBalances(stats.cash && stats.cash.outstanding),
        t("handoverCashOutstandingHint")
      )
    );
    handoverCard.appendChild(
      dailyStat(
        t("handoverBalanceOutstanding"),
        renderCashBalances(stats.balance && stats.balance.outstanding),
        t("handoverBalanceOutstandingHint")
      )
    );
    cardsRow.appendChild(handoverCard);
  }

  // Drawers: where this branch's money sits at the end of the picked day -
  // the cash drawer (derived from its policies), the money brokers handed over,
  // and the card side (the day's card payments and the live card balance). It
  // was previously mixed into the Daily report card; keeping it apart lets the
  // report talk only about insurances.
  const drawersCard = foldedCard(t("drawers"), {
    foldKey: "drawers",
    className: "drawers-card",
  });
  drawersCard.appendChild(
    dailyStat(
      fmt(t("availableCashBranch"), {
        branch: branch || t("unknownBranch"),
      }),
      renderCashBalances(daily.availableCash || {}),
      t("availableCashHint")
    )
  );
  drawersCard.appendChild(
    dailyStat(
      t("manualBrokerIncreases"),
      renderCashBalances(daily.cashFromBrokers || {}),
      t("manualBrokerIncreasesHint")
    )
  );
  // Card payments come back as one row per branch (only the selected branch
  // when a branch is passed), so sum the rows into a single per-currency line.
  drawersCard.appendChild(
    dailyStat(
      t("cardPayments"),
      renderCashBalances(cashRowsTotal(daily.cardPayments)),
      t("cardPaymentsHint")
    )
  );
  // The branch's live card balance (what the removed Card tab used to show).
  // The day's card payments above explain how much of it came in on that day;
  // the card balance itself is cleared by the branch's "End shift".
  drawersCard.appendChild(
    dailyStat(t("cardBalance"), money(data.cardBalance), t("cardBalanceHint"))
  );
  cardsRow.appendChild(drawersCard);

  // Daily report: country-wide insurance statistics for the picked day. It is
  // independent of the branch selector above - insurances and money are
  // counted across ALL branches. The two halves are the number of insurances
  // and the money they brought in.
  //
  // Every money line is the price of the policies created on that day, split by
  // payment channel: walk-in cash, walk-in card and broker-funded. Their sum is
  // the day's Total daily balance, so the three sub-lines always add up to the
  // total shown above them.
  const walkInCash = cashRowsTotal(dailyAll.cashPayments);
  const walkInCard = cashRowsTotal(dailyAll.cardPayments);
  const brokerInsuranceMoney = cashRowsTotal(dailyAll.brokerBalance);
  const totalDailyBalance =
    dailyAll.totalDailyBalance ||
    sumCashBalances(
      sumCashBalances(walkInCash, walkInCard),
      brokerInsuranceMoney
    );

  const dailyCard = foldedCard(t("dailyReport"), {
    foldKey: "dailyReport",
    className: "daily-report",
  });

  // Insurance number statistics.
  dailyCard.appendChild(dailyGroup(t("insuranceNumberStatistics")));
  dailyCard.appendChild(
    dailyStat(t("totalInsurances"), String(dailyAll.totalInsurances ?? 0))
  );
  dailyCard.appendChild(
    dailyStat(
      t("brokerInsurances"),
      String(dailyAll.brokerInsurances ?? 0),
      undefined,
      "daily-report-sub"
    )
  );
  dailyCard.appendChild(
    dailyStat(
      t("walkInInsurances"),
      String(dailyAll.walkInInsurances ?? 0),
      undefined,
      "daily-report-sub"
    )
  );
  dailyCard.appendChild(
    dailyRangeStat(
      t("countryWideInsurances"),
      dailyAll.countryWideInsurances ?? 0,
      dailyAll.countryWideRange,
      t("countryWideInsurancesHint")
    )
  );

  // Insurance money statistics: the day's total, split by where the money came
  // from.
  dailyCard.appendChild(dailyGroup(t("insuranceMoneyStatistics")));
  dailyCard.appendChild(
    dailyStat(
      t("totalDailyBalance"),
      renderCashBalances(totalDailyBalance),
      t("totalDailyBalanceHint")
    )
  );
  dailyCard.appendChild(
    dailyStat(
      t("balanceFromBrokerInsurances"),
      renderCashBalances(brokerInsuranceMoney),
      t("balanceFromBrokerInsurancesHint"),
      "daily-report-sub"
    )
  );
  dailyCard.appendChild(
    dailyStat(
      t("balanceFromWalkInsCash"),
      renderCashBalances(walkInCash),
      t("balanceFromWalkInsCashHint"),
      "daily-report-sub"
    )
  );
  dailyCard.appendChild(
    dailyStat(
      t("balanceFromWalkInsCard"),
      renderCashBalances(walkInCard),
      t("balanceFromWalkInsCardHint"),
      "daily-report-sub"
    )
  );

  cardsRow.appendChild(dailyCard);

  const actions = el("div", null, { class: "row" });
  const incBtn = el("button", t("increase"));
  // "Expense": money the branch spent - it leaves the drawer AND counts as an
  // expense (the server records it as Type "reduce"). The day's Total daily
  // balance is insurance money only, so an expense never changes it.
  const expenseBtn = el("button", t("expense"), { class: "secondary" });
  // "Hand over": money given to a person. It leaves the drawer (Available cash)
  // but is not a sale and not an expense, so the Total daily balance and the
  // expenses stay untouched. The person who took it is recorded with the entry.
  const handOverBtn = el("button", t("handOver"), { class: "secondary" });
  const resetBtn = el("button", t("resetTo0"), { class: "danger" });
  actions.appendChild(incBtn);
  actions.appendChild(expenseBtn);
  actions.appendChild(handOverBtn);
  // Admins have no shifts: "End shift" closes a worker's day (it zeroes the
  // branch's drawer, card balance and cash from brokers), so it is a worker
  // action. An admin repairs a forgotten shift with the button below instead.
  if (!isAdmin) {
    actions.appendChild(resetBtn);
  }

  // Admin-only repair for a shift that was never ended. The reset is recorded
  // at the chosen time, so the forgotten night's report is corrected while the
  // current balances are cleared now.
  if (isAdmin) {
    const fixBtn = el("button", t("fixShift"), { class: "secondary" });
    fixBtn.addEventListener("click", () => {
      // The common case is last night's shift; another past day can still be
      // picked in the modal.
      openForgottenShiftFix(branch, previousLocalDate(localDateString()));
    });
    actions.appendChild(fixBtn);
  }

  // The move-cash form shared by the three buttons. `kind` is the API path
  // segment AND the ledger type the server records: "increase", "reduce" (the
  // "Expense" button) or "handover". A hand-over additionally asks who received
  // the money - the server requires it.
  function cashForm(kind, title) {
    const spec = [
      { key: "amount", label: t("amount"), type: "number", value: "" },
      {
        key: "currency",
        label: t("currency"),
        type: "select",
        options: CASH_CURRENCY_OPTIONS,
        // A new movement (hand-over included) defaults to euros.
        value: "EUR",
      },
      { key: "reason", label: t("reason"), value: "" },
    ];
    if (kind === "handover") {
      spec.push({
        key: "Recipient",
        label: t("handedTo"),
        value: "",
        placeholder: t("handedToPlaceholder"),
      });
    }
    // An admin may record ANY of these movements on an earlier day and at an
    // earlier time (money that moved before anyone could enter it): the picker
    // carries a 24-hour clock and cannot name a day that has not happened yet.
    // A worker always records "now".
    if (isAdmin) {
      spec.push({
        key: "date",
        label:
          kind === "handover"
            ? t("handoverDate")
            : kind === "increase"
            ? t("increaseDate")
            : t("expenseDate"),
        type: "datetime-local",
        value: localDateTimeInputNow(),
        max: localDateString(),
      });
    }
    const submitLabel =
      kind === "increase"
        ? t("increase")
        : kind === "handover"
        ? t("handOver")
        : t("expense");
    const form = buildForm(
      spec,
      async (payload) => {
        // Attach the branch and the client's local creation time before sending.
        // The server stores CreatedAt as sent, instead of stamping it with the
        // database server's (UTC) clock. An admin's picker carries the day AND
        // the 24-hour clock: they travel as `date` (the calendar day the server
        // validates) and `time`, and CreatedAt takes both. A worker's movement is
        // simply "now".
        payload.branch = branch;
        const picked = isAdmin ? payload.date : "";
        payload.CreatedAt = brokerMovementCreatedAt(picked);
        if (picked) {
          const parts = dateFieldParseDateTime(picked);
          payload.date = parts.iso;
          payload.time = parts.time;
        }
        payload.TzOffset = -new Date().getTimezoneOffset();
        await api(`/currentcash/${kind}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        toast(
          kind === "increase"
            ? t("currentCashIncreased")
            : kind === "handover"
            ? t("cashHandedOver")
            : t("expenseRecorded"),
          "success"
        );
        closeModal();
        currentCashView(branch, date);
      },
      submitLabel
    );
    openModal(title, form);
  }
  incBtn.addEventListener("click", () =>
    cashForm("increase", t("currentCashIncreased"))
  );
  expenseBtn.addEventListener("click", () =>
    cashForm("reduce", t("recordExpense"))
  );
  handOverBtn.addEventListener("click", () =>
    cashForm("handover", t("handOverCash"))
  );
  resetBtn.addEventListener("click", async () => {
    const confirmed = await appConfirm(t("resetConfirm"), { danger: true });
    if (!confirmed) return;
    try {
      // "Reset to 0" also clears the branch's cash from brokers, recording what
      // was kept.
      await api("/currentcash/reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          branch,
          CreatedAt: localDateTimeNow(),
          TzOffset: -new Date().getTimezoneOffset(),
        }),
      });
      toast(t("currentCashReset"), "success");
      currentCashView(branch, date);
    } catch (err) {
      toast(err.message, "error");
    }
  });

  function openTransactionEditor(tx) {
    // A hand-over keeps its own type: it may be corrected (amount, currency,
    // reason, who took the money), but it cannot be turned into an expense or an
    // increase - that would move money between Total daily cash and the expenses
    // without any matching ledger row. So its type select is left out and the
    // server keeps 'handover' (see PATCH /currentcash/transactions/:id).
    const isHandover = String(tx.Type || "") === "handover";
    const spec = [];
    if (!isHandover) {
      spec.push({
        key: "type",
        label: t("type"),
        type: "select",
        options: [
          { label: t("increase"), value: "increase" },
          { label: t("expense"), value: "reduce" },
        ],
        value: tx.Type,
      });
    }
    spec.push(
      { key: "amount", label: t("amount"), type: "number", value: tx.Amount },
      {
        key: "currency",
        label: t("currency"),
        type: "select",
        options: CASH_CURRENCY_OPTIONS,
        value: tx.Currency || "EUR",
      },
      { key: "reason", label: t("reason"), value: tx.Reason }
    );
    if (isHandover) {
      spec.push({
        key: "Recipient",
        label: t("handedTo"),
        value: tx.Recipient || "",
        placeholder: t("handedToPlaceholder"),
      });
      // An admin can correct which day AND which time (24-hour clock) the
      // hand-over belongs to. The picker cannot name a future day.
      if (isAdmin) {
        spec.push({
          key: "date",
          label: t("handoverDate"),
          type: "datetime-local",
          value: datetimeInputValue(tx.CreatedAt),
          max: localDateString(),
        });
      }
    }
    const form = buildForm(
      spec,
      async (payload) => {
        // Stamp the correction's own ledger entries with the worker's local
        // time (the original transaction keeps its CreatedAt unless the admin
        // moved the picker). A picked day and 24-hour clock are sent as `date`
        // and `time`, which the server accepts from an admin only.
        payload.CreatedAt = localDateTimeNow();
        if (isHandover && isAdmin && payload.date) {
          const parts = dateFieldParseDateTime(payload.date);
          payload.date = parts.iso;
          payload.time = parts.time;
        }
        payload.TzOffset = -new Date().getTimezoneOffset();
        await api(`/currentcash/transactions/${tx.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        toast(t("transactionUpdated"), "success");
        closeModal();
        currentCashView(branch, date);
      },
      t("saveChanges")
    );
    openModal(`${t("editTransaction")} #${tx.id}`, form);
  }

  // Undo a hand-over: ask how much came back and where it went. "Office
  // drawer" puts it back into available cash (a 'handover_return' ledger row);
  // "Company bank account" touches no drawer and only lowers the handed-over
  // total. The server refuses more than is still out.
  function openUndoHandover(handover) {
    const spec = [
      {
        key: "Amount",
        label: t("amount"),
        type: "number",
        step: "0.01",
        value: handover.Remaining,
      },
      {
        key: "Destination",
        label: t("undoHandoverDestination"),
        type: "select",
        options: [
          { label: t("undoHandoverDrawer"), value: "drawer" },
          { label: t("undoHandoverBank"), value: "bank" },
        ],
        value: "drawer",
      },
      { key: "Reason", label: t("undoHandoverReason"), value: "" },
    ];
    const form = buildForm(
      spec,
      async (payload) => {
        payload.CreatedAt = localDateTimeNow();
        payload.TzOffset = -new Date().getTimezoneOffset();
        await api(`/currentcash/handover/${handover.id}/undo`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        toast(
          payload.Destination === "bank"
            ? t("handoverReturnedToBank")
            : t("handoverReturnedToDrawer"),
          "success"
        );
        closeModal();
        currentCashView(branch, date);
      },
      t("undoHandoverSubmit")
    );
    openModal(fmt(t("undoHandoverTitle"), { i: handover.id }), form);
  }

  // Hand money over OUT of the company bank account. Admin only, like the bank
  // balance itself. The picked day and 24-hour clock become the hand-over's
  // CreatedAt, so a correction can be bookkept on the moment it happened.
  function openBankHandoverForm() {
    if (!isAdmin) return;
    const spec = [
      { key: "amount", label: t("amount"), type: "number", value: "" },
      {
        key: "currency",
        label: t("currency"),
        type: "select",
        options: CASH_CURRENCY_OPTIONS,
        value: "EUR",
      },
      {
        key: "Recipient",
        label: t("handedTo"),
        value: "",
        placeholder: t("handedToPlaceholder"),
      },
      { key: "reason", label: t("reason"), value: "" },
      {
        key: "date",
        label: t("handoverDate"),
        type: "datetime-local",
        value: localDateTimeInputNow(),
        max: localDateString(),
      },
    ];
    const form = buildForm(
      spec,
      async (payload) => {
        const picked = payload.date;
        payload.CreatedAt = brokerMovementCreatedAt(picked);
        if (picked) {
          const parts = dateFieldParseDateTime(picked);
          payload.date = parts.iso;
          payload.time = parts.time;
        }
        payload.TzOffset = -new Date().getTimezoneOffset();
        await api("/bank/handover", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        toast(t("bankHandoverRecorded"), "success");
        closeModal();
        currentCashView(branch, date);
      },
      t("bankHandOver")
    );
    openModal(t("bankHandOver"), form);
  }

  // The day's full ledger. Policies write no cash_transactions row, so the
  // combined list adds the walk-in (cash and card) and broker-funded policies
  // to the drawer movements and the broker's manual payments.
  const combinedTransactions = combinedCashTransactions(data);
  const txTable = sortableTable(
    combinedTransactions,
    [
      {
        key: "Type",
        label: t("type"),
        render: (_v, tx) => transactionTypeCell(tx),
        sortValue: (tx) => transactionTypeLabel(tx),
        sortType: "text",
      },
      { key: "BlancNumber", label: t("blankNo"), format: (v) => v || "—", sortType: "text" },
      { key: "PolicyNumber", label: t("policyNumber"), format: (v) => v || "—", sortType: "text" },
      {
        key: "Amount",
        label: t("amount"),
        format: (v) => money(v),
        cellClass: amountCellClass,
        sortType: "number",
      },
      { key: "Currency", label: t("currency"), sortType: "text" },
      { key: "Username", label: t("user"), sortType: "text" },
      { key: "Reason", label: t("reason"), sortType: "text" },
      // Only a hand-over carries it, but the column is shown for every row so
      // the ledger reads as one table: it says who walked away with the money.
      {
        key: "Recipient",
        label: t("handedTo"),
        format: (v) => v || "",
        sortType: "text",
      },
      {
        key: "CreatedAt",
        label: t("created"),
        format: (v) => formatDateTime(v),
        sortType: "date",
      },
    ],
    // Only a row of the drawer ledger can be edited or deleted here. A policy
    // (walk-in or broker-funded) is corrected through its insurance, and a
    // broker payment through the broker's history. A hand-over RETURN is a
    // locked bookkeeping row: it is undone through the hand-over itself.
    (tx) => {
      const rowActions = [];
      if (tx.Source !== "cash") return rowActions;
      if (String(tx.Type || "") === "handover_return") return rowActions;
      // The author edits it; an admin may also correct any hand-over (for
      // example its date), whoever recorded it.
      const canEdit =
        String(tx.Username) === String(username) ||
        (isAdmin && String(tx.Type || "") === "handover");
      if (canEdit) {
        rowActions.push({
          label: t("edit"),
          class: "",
          onClick: () => openTransactionEditor(tx),
        });
      }
      if (isAdmin) {
        rowActions.push({
          label: t("deleteTransaction"),
          class: "danger",
          hover: true,
          onClick: () =>
            deleteCashTransaction(tx, () => currentCashView(branch, date)),
        });
      }
      return rowActions;
    },
    // Soft green for money in, soft red for money spent, muted amber for money
    // handed over to a person; an amount above the currency's notable amount
    // (100 EUR / 5 500 TRY) is tinted a step stronger.
    (tx) => transactionRowClass(tx),
    undefined,
    { sort: cashTableSort.transactions }
  );
  // Handed-over cash that has not come back yet (admin only). Like every other
  // ledger on this screen it follows the day picker: only the hand-overs
  // recorded on the picked day are listed, so an older one is reached by picking
  // its day. The statistics card above stays company-wide - "still handed over"
  // is a live total, not a figure of one day.
  let handoverSection = null;
  if (isAdmin && data.handoverStats) {
    const outstandingHandovers = handoversOnDay(
      data.handoverStats.handovers,
      date
    ).filter((h) => Number(h.Remaining) > 0);
    const handoversTable = sortableTable(
      outstandingHandovers,
      [
        { key: "Branch", label: t("branch"), sortType: "text" },
        { key: "Recipient", label: t("handedTo"), sortType: "text" },
        {
          key: "Amount",
          label: t("amount"),
          format: (v) => money(v),
          cellClass: amountCellClass,
          sortType: "number",
        },
        { key: "Currency", label: t("currency"), sortType: "text" },
        {
          key: "Returned",
          label: t("handoverReturnedAmount"),
          format: (v) => money(v),
          sortType: "number",
        },
        {
          key: "Remaining",
          label: t("handoverRemaining"),
          format: (v) => money(v),
          sortType: "number",
        },
        { key: "Reason", label: t("reason"), sortType: "text" },
        {
          key: "CreatedAt",
          label: t("created"),
          format: (v) => formatDateTime(v),
          sortType: "date",
        },
      ],
      (h) => [
        {
          label: t("undoHandover"),
          class: "danger",
          onClick: () => openUndoHandover(h),
        },
      ],
      (h) => cashLedgerRowClass("handover", h.Amount, h.Currency, h.Reason),
      undefined,
      { sort: cashTableSort.handovers }
    );
    handoverSection = collapsibleSection(
      t("handedOverCashSection"),
      outstandingHandovers.length,
      [el("p", t("handedOverCashDayHint"), { class: "muted" }), handoversTable],
      undefined,
      "handovers"
    );
  }
  // Expenses: the money that LEFT this branch's drawer as a spend on the picked
  // day. The server lists only the manual reductions ("Expense" entries) - the
  // refunds of annulled or deleted insurances reduce the drawer as well, but
  // they are policy movements, not money the branch spent, so they are not
  // expenses and stay out of both the list and the total. Hand-overs are a
  // separate ledger type and are left out too.
  const expensesTotal = el(
    "p",
    `${t("totalExpenses")}: ${renderCashBalances(data.totalExpences || {})}`
  );
  const expensesTable = sortableTable(
    data.expences,
    [
      {
        key: "Amount",
        label: t("amount"),
        format: (v) => money(v),
        cellClass: amountCellClass,
        sortType: "number",
      },
      { key: "Currency", label: t("currency"), sortType: "text" },
      { key: "Reason", label: t("reason"), sortType: "text" },
      { key: "Username", label: t("user"), sortType: "text" },
      {
        key: "CreatedAt",
        label: t("created"),
        format: (v) => formatDateTime(v),
        sortType: "date",
      },
    ],
    null,
    // Every expense is a reduction, so the red hue always applies; one above the
    // currency's notable amount (100 EUR / 5 500 TRY) is tinted a step stronger.
    (tx) => cashLedgerRowClass("reduce", tx.Amount, tx.Currency, tx.Reason),
    undefined,
    { sort: cashTableSort.expenses }
  );

  // Every top-up a broker made at this branch on the picked day, in the order
  // it was received. Top-ups recorded before broker money was separated from
  // current cash were given a branch by the server's one-time migration, so they
  // are listed here too; a top-up the migration could not match stays out.
  const brokerCashTable = sortableTable(
    data.brokerCashTransactions,
    [
      { key: "BrokerName", label: t("broker"), sortType: "text" },
      {
        key: "Amount",
        label: t("amount"),
        format: (v) => money(v),
        cellClass: amountCellClass,
        sortType: "number",
      },
      { key: "Currency", label: t("currency"), sortType: "text" },
      { key: "Username", label: t("user"), sortType: "text" },
      { key: "Reason", label: t("reason"), sortType: "text" },
      {
        key: "CreatedAt",
        label: t("created"),
        format: (v) => formatDateTime(v),
        sortType: "date",
      },
    ],
    null,
    // Broker top-ups are money in, so they carry the green hue.
    (tx) => cashLedgerRowClass("increase", tx.Amount, tx.Currency, tx.Reason),
    undefined,
    { sort: cashTableSort.brokerCash }
  );

  // Walk-in policies paid by card on the picked day. This is the list behind
  // the branch's Card balance: the server returns exactly the policies whose
  // stored price made up that balance (no broker-funded policies, no other
  // day). A soft-deleted policy is left out, like everywhere else.
  const cardInsurancesTable = sortableTable(
    data.cardInsurances,
    [
      { key: "BlancNumber", label: t("blankNo"), sortType: "text" },
      { key: "PolicyNumber", label: t("policyNumber"), sortType: "text" },
      { key: "CarNumber", label: t("carNumber"), sortType: "text" },
      {
        key: "Price",
        label: t("price"),
        // The stored price, not the displayed +2 card fee: these rows explain
        // the card balance, which is built from the stored price.
        format: (_v, item) => money(item.Price),
        sortType: "number",
      },
      { key: "CurrencyType", label: t("currency"), sortType: "text" },
      { key: "Author", label: t("author"), sortType: "text" },
      {
        key: "CreationDate",
        label: t("created"),
        format: (v) => formatDateTime(v),
        sortType: "date",
      },
      {
        key: "Annulled",
        label: t("status"),
        format: (_v, item) => insuranceStatusLabel(item),
        sortValue: (item) => insuranceStatusLabel(item),
        sortType: "text",
      },
    ],
    undefined,
    (item) => annulledRowClass(item),
    undefined,
    { sort: cashTableSort.cardInsurances }
  );

  // Walk-in policies paid in CASH on the picked day. This is the list behind the
  // Available cash card: a walk-in sale writes no cash_transactions row, so its
  // money is read live from the policy and shown here.
  const cashInsurancesTable = sortableTable(
    data.cashInsurances,
    [
      { key: "BlancNumber", label: t("blankNo"), sortType: "text" },
      { key: "PolicyNumber", label: t("policyNumber"), sortType: "text" },
      { key: "CarNumber", label: t("carNumber"), sortType: "text" },
      {
        key: "Price",
        label: t("price"),
        format: (_v, item) => money(policyLedgerAmount(item)),
        sortType: "number",
      },
      { key: "CurrencyType", label: t("currency"), sortType: "text" },
      { key: "Author", label: t("author"), sortType: "text" },
      {
        key: "CreationDate",
        label: t("created"),
        format: (v) => formatDateTime(v),
        sortType: "date",
      },
      {
        key: "Annulled",
        label: t("status"),
        format: (_v, item) => insuranceStatusLabel(item),
        sortValue: (item) => insuranceStatusLabel(item),
        sortType: "text",
      },
    ],
    undefined,
    (item) => annulledRowClass(item),
    undefined,
    { sort: cashTableSort.cashInsurances }
  );

  // A "Reset to 0" clears the cash drawer (one `cash_resets` row per currency)
  // AND the branch's card balance (one `card_resets` row) AND its cash from
  // brokers (one `broker_cash_resets` row per currency with something kept).
  // Merge all three so the Resets table shows every amount kept, tagged with
  // what it was.
  const cardResets = (data.cardResets || []).map((r) => ({
    ...r,
    Currency: t("cardPayments"),
  }));
  const brokerCashResets = (data.brokerCashResets || []).map((r) => ({
    ...r,
    Currency: t("cashFromBrokers"),
  }));
  const resetTable = sortableTable(
    [...(data.resets || []), ...cardResets, ...brokerCashResets].sort((a, b) =>
      String(b.CreatedAt || "").localeCompare(String(a.CreatedAt || ""))
    ),
    [
      { key: "Username", label: t("user"), sortType: "text" },
      { key: "Currency", label: t("currency"), sortType: "text" },
      {
        key: "KeptAmount",
        label: t("kept"),
        format: (v) => money(v),
        sortType: "number",
      },
      {
        key: "CreatedAt",
        label: t("created"),
        format: (v) => formatDateTime(v),
        sortType: "date",
      },
    ],
    undefined,
    undefined,
    undefined,
    { sort: cashTableSort.resets }
  );

  // Day picker for the history below; changing it reloads the transactions
  // and resets of that day. Clearing it falls back to the shown day.
  const dateInput = input("date", date);
  dateInput.addEventListener("change", () => {
    const picked = dateInput.value;
    if (!picked) {
      dateInput.value = date;
      return;
    }
    currentCashView(branch, picked).catch((err) =>
      toast(err.message, "error")
    );
  });

  // One-day steps on both sides of the picker, so walking the history does not
  // need the calendar popup. A step reloads exactly like a picked day, which
  // also remembers it for the next visit. The date is read from the field, so a
  // step follows a date that was typed but not committed yet.
  const stepToDay = (picked) =>
    currentCashView(branch, picked).catch((err) => toast(err.message, "error"));
  const previousDayBtn = el("button", "‹", {
    type: "button",
    class: "secondary date-step",
    title: fmt(t("previousDay"), {
      date: formatDateOnly(previousLocalDate(dateInput.value || date)),
    }),
  });
  previousDayBtn.setAttribute("aria-label", previousDayBtn.title);
  previousDayBtn.addEventListener("click", () =>
    stepToDay(previousLocalDate(dateInput.value || date))
  );
  const nextDayBtn = el("button", "›", {
    type: "button",
    class: "secondary date-step",
    title: fmt(t("nextDay"), {
      date: formatDateOnly(nextLocalDate(dateInput.value || date)),
    }),
  });
  nextDayBtn.setAttribute("aria-label", nextDayBtn.title);
  nextDayBtn.addEventListener("click", () =>
    stepToDay(nextLocalDate(dateInput.value || date))
  );

  const dateNav = el("div", null, { class: "date-nav" });
  dateNav.appendChild(previousDayBtn);
  dateNav.appendChild(dateInput);
  dateNav.appendChild(nextDayBtn);
  // field() points its label at the control; the wrapper itself is not
  // focusable, so the label follows the input inside it (like passwordField).
  dateNav.focusTarget = dateInput.focusTarget || dateInput;

  // The branch buttons and the day picker share one line under the heading: the
  // branches stay on the left and the picked day (with its one-day steps) sits
  // on the right. The picker is still rendered before every ledger list below,
  // so it governs all of them (the handed-over cash included).
  const dateRow = el("div", null, {
    class: "row filter-row cash-header-row",
  });
  if (branchSelector.children.length > 0) dateRow.appendChild(branchSelector);
  dateRow.appendChild(field(t("date"), dateNav));

  const topNodes = [heading];

  // Proactive check for last night: if yesterday had cash/card/broker activity
  // but no End shift was recorded, the day is still open. This is exactly the
  // "an employee forgot to finish his shift" case, so the admin gets a warning
  // with a pre-filled fix.
  if (isAdmin && date === previousLocalDate(localDateString())) {
    const resetsOnDay =
      (data.resets || []).length +
      (data.cardResets || []).length +
      (data.brokerCashResets || []).length;
    const hadActivity =
      (data.transactions || []).length > 0 ||
      (data.expences || []).length > 0 ||
      (data.brokerCashTransactions || []).length > 0 ||
      // A policy's own ledger rows are not transactions, so a day with nothing
      // but insurance sales would look empty: its money counts as activity too.
      hasNonZeroCash(daily.totalDailyBalance) ||
      hasNonZeroCash(daily.availableCash);
    if (hadActivity && resetsOnDay === 0) {
      const warning = el("div", null, { class: "banner shift-missed" });
      warning.appendChild(
        el("p", fmt(t("shiftMissedWarning"), { date: formatDateOnly(date) }), {
          class: "shift-missed-text",
        })
      );
      const closeBtn = el("button", t("fixShift"), { class: "small" });
      closeBtn.addEventListener("click", () =>
        openForgottenShiftFix(branch, date)
      );
      warning.appendChild(closeBtn);
      topNodes.push(warning);
    }
  }

  // One section per ledger table, kept in variables so the balance cards above
  // can open and scroll to them. The Transactions list is the day's FULL
  // ledger: every walk-in sale (cash and card), every broker-funded policy,
  // the broker's manual payments (increases and hand-overs) and the drawer's
  // own movements (manual increases, expenses and hand-overs). A policy's
  // correction rows are still not repeated there - the policy is shown once.
  const transactionsSection = collapsibleSection(
    t("transactions"),
    combinedTransactions.length,
    [txTable],
    // The heading lists the day's prices per type, with the annulments kept
    // apart (and their own prices) instead of inside the increases and expenses.
    cashLedgerTypeTiers(data.transactions).map((group) =>
      formatTierGroup(group, cashLedgerCountLabel)
    ),
    "transactions"
  );
  const cashInsurancesSection = collapsibleSection(
    t("cashInsurances"),
    (data.cashInsurances || []).length,
    [el("p", t("cashInsurancesHint"), { class: "muted" }), cashInsurancesTable],
    // The heading lists the day's cash prices per status, like the card list.
    // An annulled policy is shown at the fee it actually contributed.
    cardPaymentStatusTiers(
      (data.cashInsurances || []).map((p) => ({
        ...p,
        Price: policyLedgerAmount(p),
      }))
    ).map((group) => formatTierGroup(group, cardPaymentStatusCountLabel)),
    "cashInsurances"
  );
  const expensesSection = collapsibleSection(
    t("expenses"),
    (data.expences || []).length,
    [
      expensesTotal,
      el("p", t("expensesHint"), { class: "muted" }),
      expensesTable,
    ],
    undefined,
    "expenses"
  );
  const brokerCashSection = collapsibleSection(
    t("transactionsCashFromBrokers"),
    (data.brokerCashTransactions || []).length,
    [brokerCashTable],
    undefined,
    "brokerCash"
  );
  const cardInsurancesSection = collapsibleSection(
    t("cardInsurances"),
    (data.cardInsurances || []).length,
    [cardInsurancesTable],
    // The heading lists the day's card prices per status, so the annulled ones
    // (who paid the fee, and at which price) are visible without opening it.
    cardPaymentStatusTiers(data.cardInsurances).map((group) =>
      formatTierGroup(group, cardPaymentStatusCountLabel)
    ),
    "cardInsurances"
  );
  const resetsSection = collapsibleSection(
    t("resets"),
    (data.resets || []).length +
      cardResets.length +
      brokerCashResets.length,
    [resetTable],
    undefined,
    "resets"
  );

  // The company bank account. Admin only: its balance and hand-overs are never
  // built for a worker. It is monthly, so it does not follow the day picker.
  let bankSection = null;
  if (isAdmin && bank) {
    const bankHandoversTable = sortableTable(
      bank.handovers || [],
      [
        {
          key: "Amount",
          label: t("amount"),
          format: (v) => money(v),
          cellClass: amountCellClass,
          sortType: "number",
        },
        { key: "Currency", label: t("currency"), sortType: "text" },
        { key: "Recipient", label: t("handedTo"), sortType: "text" },
        { key: "Reason", label: t("reason"), sortType: "text" },
        { key: "Author", label: t("user"), sortType: "text" },
        {
          key: "CreatedAt",
          label: t("created"),
          format: (v) => formatDateTime(v),
          sortType: "date",
        },
      ],
      null,
      (row) =>
        cashLedgerRowClass("handover", row.Amount, row.Currency, row.Reason),
      undefined,
      { sort: cashTableSort.bankHandovers }
    );
    const bankHistoryTable = sortableTable(
      bank.history || [],
      [
        { key: "Month", label: t("bankMonth"), sortType: "text" },
        {
          key: "CashKept",
          label: t("bankCashKept"),
          format: (v) => renderCashBalances(v),
          sortType: "text",
        },
        {
          key: "BrokerIncreases",
          label: t("bankBrokerIncreases"),
          format: (v) => renderCashBalances(v),
          sortType: "text",
        },
        {
          key: "HandedOver",
          label: t("bankHandedOver"),
          format: (v) => renderCashBalances(v),
          sortType: "text",
        },
        {
          key: "Balance",
          label: t("bankClosingBalance"),
          format: (v) => renderCashBalances(v),
          sortType: "text",
        },
      ],
      null,
      undefined,
      undefined,
      { sort: cashTableSort.bankHistory }
    );
    const bankHandoverBtn = el("button", t("bankHandOver"), {
      class: "secondary",
    });
    bankHandoverBtn.addEventListener("click", openBankHandoverForm);
    bankSection = collapsibleSection(
      fmt(t("bankAccountMonth"), { month: bank.month }),
      (bank.handovers || []).length,
      [
        el("p", t("bankAccountHint"), { class: "muted" }),
        dailyStat(
          t("bankCashKept"),
          renderCashBalances(bank.cashKept),
          t("bankCashKeptHint")
        ),
        dailyStat(
          t("bankBrokerIncreases"),
          renderCashBalances(bank.brokerIncreases),
          t("bankBrokerIncreasesHint")
        ),
        dailyStat(
          t("bankHandedOver"),
          renderCashBalances(bank.handedOver),
          t("bankHandedOverHint")
        ),
        dailyStat(
          t("bankBalance"),
          renderCashBalances(bank.balance),
          t("bankAccountHint")
        ),
        bankHandoverBtn,
        dailyGroup(t("bankHandovers")),
        bankHandoversTable,
        dailyGroup(t("bankHistory")),
        bankHistoryTable,
      ],
      undefined,
      "bank"
    );
  }

  // A card is a shortcut to its table, but only when it has something to show:
  // a zero balance leaves the card inert.
  activateCashCard(
    balanceCard,
    // Available cash opens the walk-in CASH policies of the day - the sales
    // that put money in the drawer. A policy writes no cash_transactions row,
    // so this list is read from the policies themselves.
    cashInsurancesSection,
    hasNonZeroCash(daily.availableCash) ||
      (data.cashInsurances || []).length > 0
  );
  activateCashCard(
    brokerCashCard,
    brokerCashSection,
    hasNonZeroCash(data.brokerCash)
  );
  activateCashCard(
    cardCard,
    // The card balance is the sum of the walk-in card policies of the picked
    // day, so the card opens exactly that list.
    cardInsurancesSection,
    Number(data.cardBalance) !== 0
  );
  activateCashCard(
    bankCard,
    bankSection,
    Boolean(
      bank &&
        (hasNonZeroCash(bank.balance) || (bank.handovers || []).length > 0)
    )
  );
  activateCashCard(
    expensesCard,
    expensesSection,
    hasNonZeroCash(data.totalExpences)
  );

  // Everything is built. Re-open the folds that were open before the rebuild
  // and let the reloaded figures flash once: only the figures change - the page
  // never folds itself shut under the user.
  applyCashFoldState(
    [
      cardsRow,
      transactionsSection,
      cashInsurancesSection,
      cardInsurancesSection,
      brokerCashSection,
      expensesSection,
      handoverSection,
      resetsSection,
      bankSection,
    ],
    openFolds,
    refreshing
  );

  Content.replaceChildren(
    ...topNodes,
    // The branch buttons and the day picker share the row under the heading;
    // every ledger list below still follows the picked day.
    dateRow,
    cardsRow,
    el("p", t("currentCashHint"), { class: "muted" }),
    actions,
    // The combined Transactions table is the FIRST table on the page: it is
    // the day's full money ledger (walk-ins, broker payments and the drawer).
    transactionsSection,
    cashInsurancesSection,
    cardInsurancesSection,
    brokerCashSection,
    expensesSection,
    ...(handoverSection ? [handoverSection] : []),
    resetsSection,
    ...(bankSection ? [bankSection] : [])
  );
}

// Sort state for the brokers table: key is null (server order), "CashBalance",
// "InactivePolicies" or "Code" (the broker ID shown in the ID column); dir is
// "desc" (highest first) or "asc" (lowest first).
let brokerSort = { key: null, dir: "desc" };

// Text typed into the brokers table's "Name" column header, which doubles as a
// name filter (see brokerNameFilterHeader). Kept outside the DOM so sorting the
// table or refreshing it (an edited balance, a new broker) keeps the filter.
let brokerNameFilter = "";
// Whether the header shows its input while the filter is still empty.
let brokerNameFilterInputOpen = false;

// Broker IDs (the Code shown in the ID column) are decimal-looking codes such
// as "1.9" or "1,12" (the comma is the local decimal separator). They have to
// sort by their numeric value, so 1.12 comes before 1.9 - a plain text
// comparison would put "1,12" after "1,9". Values that are not such a number
// (e.g. "1.2.3" or "A1") fall back to the text comparison below.
function brokerIdSortValue(value) {
  const text = String(value).trim();
  if (!/^\d+(?:[.,]\d+)?$/.test(text)) return null;
  const n = Number(text.replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

// Comparable value of one broker cell. Numbers stay numbers; broker IDs are
// compared by their decimal value ("1.12" before "1.9", whether the separator
// is a dot or a comma); any other text sorts alphabetically. Empty values
// become null so they sink to the bottom of the list.
function brokerSortValue(value, key) {
  if (value === undefined || value === null || String(value).trim() === "") {
    return null;
  }
  if (key === "Code") {
    const id = brokerIdSortValue(value);
    if (id !== null) return id;
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : String(value);
}

// Sorted copy of the broker rows. Numbers sort numerically, broker IDs sort by
// their decimal value ("1.12" before "1.9"), and brokers without a value sink
// to the bottom in both directions. Array.prototype.sort is stable, so equal
// values keep the server order.
function sortBrokerRows(rows, key, dir) {
  const list = Array.isArray(rows) ? [...rows] : [];
  if (!key) return list;
  const sign = dir === "desc" ? -1 : 1;
  return list.sort((a, b) => {
    const av = brokerSortValue(a ? a[key] : null, key);
    const bv = brokerSortValue(b ? b[key] : null, key);
    // Empty values (e.g. a broker without an ID) stay at the bottom.
    if (av === null || bv === null) {
      return av === bv ? 0 : av === null ? 1 : -1;
    }
    if (typeof av === "number" && typeof bv === "number") {
      return sign * (av - bv);
    }
    // Remaining text sorts alphabetically, with numbers in numeric order
    // ("2" before "10") and case ignored.
    return sign * String(av).localeCompare(String(bv), undefined, {
      numeric: true,
      sensitivity: "base",
    });
  });
}

// The whole row is flagged when the broker has no email.
function brokerHasNoEmail(b) {
  const emails = Array.isArray(b.emails)
    ? b.emails.filter((e) => String(e || "").trim() !== "")
    : [];
  return emails.length === 0;
}

// The "cut off" action shown in the brokers table's Actions column. It is an
// admin action: the whole action list is built only for admins, so a broker can
// be cut off (or re-enabled) at any time.
function brokerCutOffAction(b) {
  const cutOff = Boolean(b.cutOff);
  return {
    label: cutOff ? t("brokerCutOffRestore") : t("brokerCutOff"),
    class: cutOff ? "danger" : "secondary",
    title: t("brokerCutOffHint"),
    onClick: (broker) => toggleBrokerCutOff(broker),
  };
}

// The last payment a broker made (the newest manual top-up): amount, currency
// and date. A broker without a top-up shows a dash.
function brokerLastPaymentLabel(b) {
  if (!b || !b.LastPaymentAt) return "—";
  const currency = b.LastPaymentCurrency ? ` ${b.LastPaymentCurrency}` : "";
  return `${money(b.LastPaymentAmount)}${currency} · ${formatDateTime(
    b.LastPaymentAt
  )}`;
}

async function toggleBrokerCutOff(b) {
  const target = !Boolean(b.cutOff);
  try {
    await api(`/brokers/${b.id}/cutoff`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cutOff: target }),
    });
    toast(
      target ? t("brokerCutOffSet") : t("brokerCutOffRestored"),
      "success"
    );
  } catch (err) {
    toast(err.message, "error");
    return;
  }
  brokersView();
}

// The "Name" column header of the brokers table doubles as a name filter:
// clicking the label replaces it with a text input, and the already-rendered
// rows are narrowed to the brokers whose name matches what is typed (see
// brokerNameMatches - case- and Cyrillic/Latin-insensitive, so "lesovo" finds
// "ГКПП Лесово"). Escape or the ✕ clears it and restores the plain label.
// `onChange` re-applies the filter to the table; the input itself is never
// rebuilt while typing, so the caret never jumps.
function brokerNameFilterHeader(onChange) {
  const opened = brokerNameFilterInputOpen || Boolean(brokerNameFilter);
  const holder = el("span", null, {
    class: opened ? "broker-name-filter open" : "broker-name-filter",
  });

  const label = el("button", t("name"), {
    class: "broker-name-filter-label",
    type: "button",
    title: t("brokerNameFilterHint"),
    "aria-label": t("brokerNameFilterHint"),
  });

  const field = el("span", null, { class: "broker-name-filter-field" });
  const searchInput = el("input", null, {
    type: "text",
    id: "BrokerNameFilterInput",
    class: "broker-name-filter-input",
    placeholder: t("brokerNameFilterPlaceholder"),
    "aria-label": t("brokerNameFilterPlaceholder"),
    autocomplete: "off",
    spellcheck: "false",
  });
  searchInput.value = brokerNameFilter;

  const clearBtn = el("button", "✕", {
    class: "broker-name-filter-clear",
    type: "button",
    title: t("brokerNameFilterClear"),
    "aria-label": t("brokerNameFilterClear"),
  });
  clearBtn.style.display = brokerNameFilter ? "" : "none";

  function setOpen(value) {
    brokerNameFilterInputOpen = value;
    holder.classList.toggle("open", value);
  }

  function apply(value) {
    brokerNameFilter = value;
    searchInput.value = value;
    clearBtn.style.display = value ? "" : "none";
    if (typeof onChange === "function") onChange();
  }

  label.addEventListener("click", () => {
    setOpen(true);
    searchInput.focus();
  });
  searchInput.addEventListener("input", () => apply(searchInput.value));
  searchInput.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    apply("");
    setOpen(false);
  });
  // Leaving an empty field puts the plain "Name" header back.
  searchInput.addEventListener("blur", () => {
    if (!brokerNameFilter) setOpen(false);
  });
  clearBtn.addEventListener("click", () => {
    apply("");
    searchInput.focus();
  });

  field.appendChild(searchInput);
  field.appendChild(clearBtn);
  holder.appendChild(label);
  holder.appendChild(field);
  return holder;
}

async function brokersView() {
  const isAdmin = userRole === "1";
  // Admins also ask for the soft-deleted brokers (data.deleted) so the panel can
  // offer Restore; the live list itself never contains them.
  const data = await api(isAdmin ? "/brokers?includeDeleted=1" : "/brokers");
  const deletedBrokers = (data && data.deleted) || [];

  // Another client can move a balance at any time (a policy sold/annulled, a
  // top-up, a bill paid). The server pushes that over the WebSocket; re-read
  // this list so the figure on screen is always the stored one.
  refreshActiveBrokersView = () => brokersView();

  const toolbar = el("div", null, { class: "row" });
  if (isAdmin) {
    const addBtn = el("button", t("newBroker"));
    addBtn.addEventListener("click", () => brokerCreateForm());
    toolbar.appendChild(addBtn);
    const expJson = el("button", t("exportJson"), { class: "secondary" });
    const expCsv = el("button", t("exportCsv"), { class: "secondary" });
    expJson.addEventListener("click", async () => {
      const d = await api("/brokers/export?format=json");
      openModal(
        `${t("brokers")} (JSON)`,
        el("pre", JSON.stringify(d, null, 2))
      );
    });
    expCsv.addEventListener("click", async () => downloadBrokersCsv());
    toolbar.appendChild(expJson);
    toolbar.appendChild(expCsv);
  }

  // Admin-only toggle: accept broker requests that would push the broker
  // balance below zero. When off, such requests are rejected by the server.
  if (isAdmin) {
    const toggle = checkboxToggle(
      t("brokerAllowNegative"),
      data.allowNegativeBalance !== false
    );
    toggle.classList.add("broker-toggle");
    const toggleInput = toggle.input;
    toggle.title = t("brokerAllowNegativeHint");
    toggleInput.addEventListener("change", async () => {
      toggleInput.disabled = true;
      try {
        await api("/brokers/settings", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ allowNegativeBalance: toggleInput.checked }),
        });
        toast(t("settingSaved"), "success");
      } catch (err) {
        toggleInput.checked = !toggleInput.checked;
        toast(err.message, "error");
      } finally {
        toggleInput.disabled = false;
      }
    });
    toolbar.appendChild(toggle);
  }

  const tableHolder = el("div");
  // Marks this view for the live-refresh handler (broker balance push).
  tableHolder.dataset.brokersView = "list";
  // Shown under the table when the Name filter matches no broker. It lives
  // outside the table, so the header input survives an empty result.
  const filterStatus = el("p", null, {
    class: "muted broker-name-filter-status",
  });
  filterStatus.style.display = "none";

  // One entry per rendered broker row, in table order (renderTable appends one
  // row per item), so the name filter can hide and show rows in place instead of
  // rebuilding the table - which would recreate the header input.
  let filterRows = [];

  const applyBrokerNameFilter = () => {
    const query = brokerNameFilter.trim();
    const shown = applyBrokerNameFilterToRows(filterRows, query);
    const noMatches = Boolean(query) && filterRows.length > 0 && shown === 0;
    filterStatus.textContent = noMatches
      ? t("brokerNameNoMatches").replace("{q}", query)
      : "";
    filterStatus.style.display = noMatches ? "" : "none";
  };

  const buildTable = () => {
    const brokers = data.brokers || [];
    const sortedBrokers = brokerSort.key
      ? sortBrokerRows(brokers, brokerSort.key, brokerSort.dir)
      : brokers;
    const sortHeader = (key) => ({
      headerSuffix:
        brokerSort.key !== key ? "" : brokerSort.dir === "desc" ? "▼" : "▲",
      onHeaderClick: () => {
        brokerSort = {
          key,
          dir:
            brokerSort.key === key && brokerSort.dir === "desc"
              ? "asc"
              : "desc",
        };
        renderTableArea();
      },
    });
    const table = renderTable(
      sortedBrokers,
      [
        {
          key: "Name",
          label: t("name"),
          // The header itself is the broker-name filter: clicking the label
          // opens an input that narrows the table as it is typed.
          headerRender: () => brokerNameFilterHeader(applyBrokerNameFilter),
          // Only admins may open a broker's pricing by clicking its name.
          // Workers just see the plain name (row click opens balance history).
          onClick: isAdmin ? (b) => brokerPricingEditor(b) : undefined,
        },
        {
          key: "Code",
          label: t("brokerId"),
          ...sortHeader("Code"),
        },
        {
          key: "CashBalance",
          label: t("balance"),
          format: (v) => money(v),
          // A negative balance colours only this cell (light pink) so the number
          // stands out without tinting the whole row.
          cellClass: (b) => (Number(b.CashBalance) < 0 ? "cell-broker-negative" : ""),
          ...sortHeader("CashBalance"),
        },
        {
          // The newest manual top-up of the broker's balance (amount + date),
          // so a broker who has not paid for a long time is obvious at a glance.
          key: "LastPaymentAt",
          label: t("lastPayment"),
          format: (_v, b) => brokerLastPaymentLabel(b),
          ...sortHeader("LastPaymentAt"),
        },
        {
          key: "batches",
          label: t("blancBatches"),
          // Batches the server added by itself (a blanc forced in outside the
          // handed-out ranges) are pink, so they stand out from the rest.
          render: (_v, b) => blancBatchesLabel(b.batches),
        },
        {
          // Calculated by the server from ALL of the broker's batch ranges.
          key: "InactivePolicies",
          label: t("inactive"),
          cellClass: (b) =>
            Number(b.InactivePolicies) < 30 ? "cell-broker-alert" : "",
          ...sortHeader("InactivePolicies"),
        },
      ],
      (b) => [
        {
          label: t("increase"),
          class: "broker-adjust",
          onClick: (broker) => brokerAdjust(broker, "increase"),
        },
        // A broker may pay the owner directly: that is a payment on their
        // balance as well, but the money never reaches a branch, so it is
        // recorded as a hand-over (no branch, no Cash from Brokers).
        {
          label: t("handOver"),
          class: "broker-adjust secondary",
          onClick: (broker) => brokerAdjust(broker, "handover"),
        },
        // There is no "Reduce" action: a balance may only grow through money the
        // broker actually paid (a top-up or a hand-over). It falls by itself as
        // policies are created, and it is recalculated from the starting balance
        // and the policies, so a hand-typed reduction is not possible any more.
        // The historical "reduce" rows are kept and still show in the history.
        ...(isAdmin
          ? [
              brokerCutOffAction(b),
              {
                label: t("edit"),
                class: "secondary",
                onClick: (broker) => brokerEditForm(broker),
              },
              {
                label: t("blancBatches"),
                class: "secondary",
                onClick: (broker) => brokerBatchesView(broker),
              },
              {
                label: t("delete"),
                class: "danger",
                hover: true,
                onClick: (broker) => deleteBroker(broker, () => brokersView()),
              },
            ]
          : []),
      ],
      (b) => {
        const classes = [];
        if (brokerHasNoEmail(b)) classes.push("row-broker-alert");
        return classes.join(" ");
      },
      (b) => brokerHistoryView(b),
      { revealActions: true }
    );

    // Remember each rendered row with the broker name it shows, so the header
    // filter can hide and show rows without rebuilding the table.
    filterRows = [];
    if (table && table.tagName === "TABLE") {
      const rows = Array.from(table.querySelectorAll("tbody tr"));
      rows.forEach((row, index) => {
        const broker = sortedBrokers[index] || {};
        filterRows.push({ name: String(broker.Name || ""), row });
      });
    }
    return table;
  };

  const renderTableArea = () => {
    tableHolder.replaceChildren(buildTable(), filterStatus);
    applyBrokerNameFilter();
  };

  renderTableArea();

  // The heading explains the row and cell colours on hover: the highlights are
  // easy to see but their meaning is not obvious from the table alone.
  const heading = el("h2", t("brokers"), {
    class: "heading-hint",
    title: t("brokersHint"),
  });

  const children = [heading, toolbar, tableHolder];

  // Soft-deleted brokers (admin only): kept apart from the live list, greyed out,
  // each with a Restore button - the delete is reversible.
  if (isAdmin && deletedBrokers.length) {
    const deletedHolder = el("div");
    deletedHolder.appendChild(el("h3", t("deletedBrokers")));
    deletedHolder.appendChild(
      renderTable(
        deletedBrokers,
        [
          { key: "Name", label: t("name") },
          { key: "Code", label: t("brokerId") },
          { key: "CashBalance", label: t("balance"), format: (v) => money(v) },
          {
            key: "DeletedAt",
            label: t("deleted"),
            format: (v) => formatDateTime(v),
          },
          { key: "DeletedBy", label: t("deletedBy") },
        ],
        (b) => [
          {
            label: t("restore"),
            class: "secondary",
            onClick: (b) => restoreBroker(b, () => brokersView()),
          },
        ],
        () => "row-deleted",
        null,
        { revealActions: true }
      )
    );
    children.push(deletedHolder);
  }

  Content.replaceChildren(...children);
}

// Label for a broker balance movement type (policy, annulment, deletion,
// price_change, increase, reduce, adjust). Unknown types are shown as they are.
function movementTypeLabel(type) {
  return t(`movement.${type}`, type || "");
}

// The Type cell of a broker movement. A retired row (reduce/adjust) gets a tag
// next to its label, so it stands out and can be reviewed or soft-deleted; the
// tooltip explains that the balance rule ignores it.
function movementTypeCell(value, movement) {
  const wrap = el("span", null, { class: "movement-type" });
  wrap.appendChild(el("span", movementTypeLabel(value)));
  if (movement && movement.Retired) {
    wrap.appendChild(
      el("span", t("retiredTag"), {
        class: "movement-retired-tag",
        title: t("retiredTagHint"),
      })
    );
  }
  return wrap;
}

// Signed, currency-precise amount (e.g. "+25.00" / "-10.00").
function signedMoney(value) {
  const n = Number(value);
  const abs = money(Math.abs(Number.isFinite(n) ? n : 0));
  return `${n >= 0 ? "+" : "-"}${abs}`;
}

// Total of the Amount column of the broker movements shown on THIS page, so the
// figure always matches the rows under it: it stays meaningful without a date
// (the whole history is paged, 40 rows at a time) and changes with the page.
// Retired reduce/adjust rows are listed but never move the balance (see
// retiredMovementNote), so they stay out of the total.
function sumDisplayedBrokerAmounts(movements) {
  let cents = 0;
  for (const m of Array.isArray(movements) ? movements : []) {
    if (!m || m.Retired) continue;
    const amount = Number(m.Amount);
    if (!Number.isFinite(amount)) continue;
    cents += Math.round(amount * 100);
  }
  return cents / 100;
}

// Pagination controls (Prev / "Page x of y" / Next).
function pagerControls(totalPages, page, onPage) {
  const wrap = el("div", null, { class: "row pagination" });
  const info = el(
    "span",
    t("pageOf").replace("{page}", page).replace("{total}", totalPages),
    { class: "muted" }
  );
  const prev = el("button", t("previous"), {
    class: "secondary small",
    type: "button",
  });
  prev.disabled = page <= 1;
  prev.addEventListener("click", () => onPage(page - 1));
  const next = el("button", t("next"), {
    class: "secondary small",
    type: "button",
  });
  next.disabled = page >= totalPages;
  next.addEventListener("click", () => onPage(page + 1));
  wrap.appendChild(prev);
  wrap.appendChild(info);
  wrap.appendChild(next);
  return wrap;
}

// Day navigation for a single-day history. Once a date is picked the history is
// exactly one page, so the pager's Previous / Next must NOT sit disabled: they
// step one calendar day at a time (the picked day is shown between them). There
// is no history after today, so the walk stops there.
function dayPagerControls(date, onDate) {
  const wrap = el("div", null, { class: "row pagination" });
  const prev = el("button", t("previous"), {
    class: "secondary small",
    type: "button",
    title: fmt(t("previousDay"), {
      date: formatDateOnly(previousLocalDate(date)),
    }),
  });
  prev.addEventListener("click", () => onDate(previousLocalDate(date)));
  const next = el("button", t("next"), {
    class: "secondary small",
    type: "button",
    title: fmt(t("nextDay"), { date: formatDateOnly(nextLocalDate(date)) }),
  });
  next.disabled = date >= localDateString();
  next.addEventListener("click", () => {
    if (next.disabled) return;
    onDate(nextLocalDate(date));
  });
  wrap.appendChild(prev);
  wrap.appendChild(el("span", formatDateOnly(date), { class: "muted" }));
  wrap.appendChild(next);
  return wrap;
}

// True while #Content shows THIS broker's balance history. Re-reading it must
// keep the rows on screen until the fresh figures arrive: clearing the page for
// the loading line first blanked the window and threw the scroll position away,
// which read like a page refresh on every delete, edit and socket push.
function brokerHistoryOnScreen(broker) {
  const host = Content.querySelector('[data-brokers-view="history"]');
  return !!host && Number(host.dataset.brokerId) === Number(broker.id);
}

// Every re-read takes a ticket; only the newest one may paint. The server pushes
// the balance change for a deleted movement while the delete's own re-read is
// still in flight, so an older answer must not repaint over the newer page.
let brokerHistoryRequestId = 0;

// Movements per page of the broker balance history. It is also the step of the
// table's "No." column: the numbering runs on across pages (the first row of
// page 2 is 41), because the rows are one numbered history, not separate lists.
const BROKER_HISTORY_PAGE_SIZE = 40;

// The broker balance history "page": every balance movement of the broker,
// newest first, with a back button to the list. It goes all the way back to the
// broker's first movement, and a calendar picker scopes it to a single day.
// A policy's price edits and (once annulled) its refund are folded into the
// original sale row by the server, so that row simply shows the policy's current
// price - its annulment tax once annulled - and is tinted like its row in
// "Insurances by date". A policy that was moved to another broker disappears
// from this broker's history entirely. Retired reduce/adjust rows stay listed
// with a tag, never move the balance and can be soft-deleted from their row.
async function brokerHistoryView(broker, page = 1, date = "", includeDeleted = false) {
  const onScreen = brokerHistoryOnScreen(broker);
  const requestId = ++brokerHistoryRequestId;
  if (!onScreen) {
    Content.replaceChildren(el("p", t("loading"), { class: "muted" }));
  }
  try {
    const pageSize = BROKER_HISTORY_PAGE_SIZE;
    const params = new URLSearchParams({
      page: String(page),
      pageSize: String(pageSize),
      // Lets the server resolve the default upper bound ("now") in the
      // worker's local time, matching the client-stamped movement times.
      tzOffset: String(-new Date().getTimezoneOffset()),
    });
    if (date) {
      params.set("since", date);
      params.set("until", nextLocalDate(date));
    }
    if (includeDeleted) params.set("includeDeleted", "1");
    const data = await api(`/brokers/${broker.id}/history?${params.toString()}`);
    if (requestId !== brokerHistoryRequestId) return;
    renderBrokerHistory(broker, data, page, date, includeDeleted);
  } catch (err) {
    if (requestId !== brokerHistoryRequestId) return;
    const message = translateError(err && err.message ? err.message : "");
    // A failed re-read keeps the page the user is already looking at intact;
    // only a page that had nothing on it yet gives way to the error line.
    if (onScreen) {
      toast(`${t("errorPrefix")}: ${message}`, "error");
      return;
    }
    Content.replaceChildren(
      el("p", `${t("errorPrefix")}: ${message}`, { class: "muted" })
    );
  }
}

function renderBrokerHistory(broker, data, page, date = "", includeDeleted = false) {
  // A change made by another client (a policy annulled, a top-up, the starting
  // balance corrected) arrives over the WebSocket; re-read this page instead of
  // showing a stale figure.
  refreshActiveBrokersView = () =>
    brokerHistoryView(broker, page, date, includeDeleted);

  const backBtn = el("button", t("back"), { class: "secondary", type: "button" });
  backBtn.addEventListener("click", () => brokersView());

  const heading = el("h2", `${t("brokerHistory")}: ${broker.Name}`);
  // Marks this view for the live-refresh handler (broker balance push).
  heading.dataset.brokersView = "history";
  heading.dataset.brokerId = String(broker.id);
  const range = `${formatDateTime(data.since)} – ${formatDateTime(data.until)}`;
  // The balance of the scoped range's END (what the broker owed then), not the
  // current balance: walking the date back has to change the figure instead of
  // repeating today's balance on every day.
  const balanceAtEnd =
    data.balanceAtEnd === undefined || data.balanceAtEnd === null
      ? data.broker.CashBalance
      : data.balanceAtEnd;
  const summary = el(
    "p",
    `${t("balance")}: ${money(balanceAtEnd)} · ${t("netChange")}: ${signedMoney(data.netChange)} · ${range}`,
    { class: "muted", title: t("brokerHistoryBalanceHint") }
  );

  // The balance the broker had BEFORE its first insurance was created. An admin
  // clicks the value to set or correct it (brokerStartingBalanceForm); saving it
  // makes the server recalculate the broker's balance from the insurances and
  // the manual payments. A broker without one says so instead of pretending it
  // started at zero.
  const starting = data.startingBalance || null;
  const startingRow = el("p", null, {
    class: "muted history-starting-balance",
  });
  startingRow.appendChild(el("span", `${t("startingBalance")}: `));
  if (userRole === "1") {
    const startingBtn = el(
      "button",
      starting ? money(starting.amount) : t("startingBalanceNotSet"),
      { class: "link-button", type: "button", title: t("startingBalanceHint") }
    );
    startingBtn.addEventListener("click", () =>
      brokerStartingBalanceForm(broker, starting, date, includeDeleted)
    );
    startingRow.appendChild(startingBtn);
  } else {
    startingRow.appendChild(
      el("span", starting ? money(starting.amount) : t("startingBalanceNotSet"))
    );
  }
  if (starting && starting.date) {
    startingRow.appendChild(
      // A calendar day only, so it is shown as dd-mm-yyyy (no time of day).
      el(
        "span",
        ` · ${t("startingBalanceDate")}: ${formatDateOnly(starting.date)}`
      )
    );
  }

  // Calendar picker scopes the history to a single day; clearing it falls back
  // to the whole history.
  const dateInput = input("date", date || "");

  // Admins can also list the soft-deleted movements and restore them. The flag
  // is re-read on every change so the deleted list tracks the current scope.
  const includeDeletedInput = userRole === "1" ? input("checkbox") : null;
  if (includeDeletedInput) {
    includeDeletedInput.checked = !!includeDeleted;
    includeDeletedInput.addEventListener("change", () =>
      brokerHistoryView(broker, 1, dateInput.value, includeDeletedInput.checked).catch((err) =>
        toast(err.message, "error")
      )
    );
  }

  dateInput.addEventListener("change", () => {
    brokerHistoryView(
      broker,
      1,
      dateInput.value,
      includeDeletedInput ? includeDeletedInput.checked : false
    ).catch((err) => toast(err.message, "error"));
  });

  const dateRow = el("div", null, { class: "row filter-row" });
  dateRow.appendChild(field(t("date"), dateInput));
  if (includeDeletedInput) {
    // Same pill toggle as everywhere else: the caption belongs inside the pill,
    // not above a bare checkbox.
    dateRow.appendChild(
      checkboxToggle(t("includeDeleted"), null, includeDeletedInput)
    );
  }

  // Total of the Amount column of the movements on THIS page, right-aligned
  // above the table. It is read off the rows the table shows (not the server's
  // netChange, which covers the whole scoped range), so it is the same figure
  // whether or not a date is picked and it changes with the page. Next to it
  // stands the broker's balance when the shown day ended: the total says what
  // moved on the page, the balance says where the broker stood once it was over.
  const pageTotal = sumDisplayedBrokerAmounts(data.movements);
  const totalRow = el("div", null, { class: "row history-total-row" });
  totalRow.appendChild(
    el("span", `${t("total")}: ${signedMoney(pageTotal)}`, { class: "muted" })
  );
  totalRow.appendChild(
    el("span", `${t("balanceAtDayEnd")}: ${money(balanceAtEnd)}`, {
      class: "muted",
      title: t("balanceAtDayEndHint"),
    })
  );

  // Admins can correct or remove a single movement; workers and broker
  // clients only read the history, so the action column stays hidden for them.
  const historyActions =
    userRole === "1"
      ? [
          {
            label: t("edit"),
            class: "secondary",
            onClick: (m) => brokerHistoryEditForm(broker, m, page, date, includeDeleted),
          },
          {
            // The delete "X": hidden until the row is hovered.
            label: t("deleteMovement"),
            class: "danger",
            hover: true,
            onClick: async (m) => {
              const confirmed = await appConfirm(
                t(m.Retired ? "deleteRetiredMovementConfirm" : "deleteMovementConfirm"),
                { danger: true, confirmLabel: t("delete") }
              );
              if (!confirmed) return;
              try {
                await api(`/brokers/${broker.id}/history/${m.id}`, {
                  method: "DELETE",
                });
                toast(t("movementDeleted"), "success");
                brokerHistoryView(broker, page, date, includeDeleted);
              } catch (err) {
                toast(err.message, "error");
              }
            },
          },
        ]
      : undefined;

  // "No." column: renderTable hands a column the row itself, not its position,
  // so the numbers are looked up per row. They follow the order the table shows
  // (newest first) and carry on from the previous page: with 40 rows a page,
  // page 2 starts at 41. Numbering the rows makes a movement easy to point at
  // ("row 17") without relying on its date or amount.
  const firstRowNumber = (page - 1) * BROKER_HISTORY_PAGE_SIZE + 1;
  const rowNumbers = new Map(
    (data.movements || []).map((m, idx) => [m, firstRowNumber + idx])
  );

  const table = renderTable(
    data.movements || [],
    [
      {
        key: "__rowNo",
        label: t("rowNo"),
        format: (_v, m) => rowNumbers.get(m),
        cellClass: () => "row-number",
      },
      { key: "CreatedAt", label: t("date"), format: (v) => formatDateTime(v) },
      {
        key: "Type",
        label: t("type"),
        render: (v, m) => movementTypeCell(v, m),
      },
      { key: "BlancNumber", label: t("blankNo"), format: (v) => v || "—" },
      { key: "Reason", label: t("reason") },
      // Only a hand-over carries it, but the column is shown for every row so
      // the history reads as one table: it says who received the money.
      {
        key: "Recipient",
        label: t("handedTo"),
        format: (v) => v || "—",
      },
      { key: "Author", label: t("author"), format: (v) => v || "—" },
      {
        key: "Amount",
        label: t("amount"),
        format: (v) => signedMoney(v),
        cellClass: (m) => (Number(m.Amount) >= 0 ? "num-pos" : "num-neg"),
      },
      {
        key: "BalanceAfter",
        label: t("balanceAfter"),
        format: (v) => money(v),
        cellClass: (m) => (Number(m.BalanceAfter) < 0 ? "num-neg" : ""),
      },
    ],
    historyActions,
    // A policy's price edits and (once annulled) its refund are folded into its
    // sale row, so the Amount already shows the current price or tax. Tint an
    // annulled policy exactly like its row in the insurance tabs, so who paid
    // the tax is readable at a glance.
    (m) => {
      const classes = [];
      const annulled = annulledRowClass({
        Annulled: m.PolicyAnnulled,
        AnnulReason: m.PolicyAnnulReason,
      });
      if (annulled) classes.push(annulled);
      if (m.Retired) classes.push("row-broker-retired");
      return classes.join(" ");
    }
  );

  // With a date picked the history is a single day, so its Previous / Next walk
  // the calendar instead of sitting disabled (see dayPagerControls). A day with
  // more movements than one page keeps the ordinary pager too. The controls are
  // rendered above and below the table.
  const buildPagers = (extraClass = "") => {
    const pagers = [];
    if (date) {
      pagers.push(
        dayPagerControls(date, (d) =>
          brokerHistoryView(broker, 1, d, includeDeleted)
        )
      );
      if (data.totalPages > 1) {
        pagers.push(
          pagerControls(data.totalPages, page, (p) =>
            brokerHistoryView(broker, p, date, includeDeleted)
          )
        );
      }
    } else {
      pagers.push(
        pagerControls(data.totalPages, page, (p) =>
          brokerHistoryView(broker, p, date, includeDeleted)
        )
      );
    }
    if (extraClass) pagers.forEach((p) => p.classList.add(extraClass));
    return pagers;
  };

  // A retired reduce/adjust row is history only: it is listed (and can be
  // soft-deleted) but never moves the balance. Explain the tag when one is on
  // the shown page.
  const retiredNote = (data.movements || []).some((m) => m.Retired)
    ? el("p", t("retiredMovementNote"), {
        class: "muted history-retired-note",
      })
    : null;

  const children = [
    backBtn,
    heading,
    summary,
    startingRow,
    dateRow,
    totalRow,
    ...(retiredNote ? [retiredNote] : []),
    ...buildPagers("pagination-top"),
    table,
    ...buildPagers(),
  ];

  // Soft-deleted movements are kept in the database and only shown when the
  // admin asks for them (Include deleted). Each one can be brought straight back.
  if (userRole === "1" && Array.isArray(data.deleted) && data.deleted.length) {
    children.push(el("h3", t("deletedMovements")));
    children.push(
      renderTable(
        data.deleted,
        [
          { key: "CreatedAt", label: t("date"), format: (v) => formatDateTime(v) },
          {
            key: "Type",
            label: t("type"),
            render: (v, m) => movementTypeCell(v, m),
          },
          { key: "BlancNumber", label: t("blankNo"), format: (v) => v || "—" },
          {
            key: "Reason",
            label: t("reason"),
            format: (v, m) => `${v || ""}${m.DeletedBy ? ` (${m.DeletedBy})` : ""}`,
          },
          { key: "Author", label: t("author"), format: (v) => v || "—" },
          {
            key: "Amount",
            label: t("amount"),
            format: (v) => signedMoney(v),
            cellClass: (m) => (Number(m.Amount) >= 0 ? "num-pos" : "num-neg"),
          },
        ],
        [
          {
            label: t("restore"),
            class: "",
            onClick: (m) => restoreBrokerMovement(broker, m, page, date),
          },
        ],
        (m) => (m.Retired ? "row-deleted row-broker-retired" : "row-deleted")
      )
    );
  }

  Content.replaceChildren(...children);
}

// Restore a previously soft-deleted broker movement. The server re-applies the
// movement's amount to the broker's balance and clears the Deleted flag, putting
// the row back exactly where it was.
async function restoreBrokerMovement(broker, movement, page, date) {
  const confirmed = await appConfirm(
    t(
      movement && movement.Retired
        ? "restoreRetiredMovementConfirm"
        : "restoreMovementConfirm"
    ),
    { confirmLabel: t("restore") }
  );
  if (!confirmed) return;
  try {
    await api(`/brokers/${broker.id}/history/${movement.id}/restore`, {
      method: "POST",
    });
    toast(t("movementRestored"), "success");
    brokerHistoryView(broker, page, date, true);
  } catch (err) {
    toast(err.message, "error");
  }
}

// Admin-only modal to correct a single broker balance movement. The amount is
// shown signed (positive = increase, negative = decrease); changing it shifts
// the broker balance by the difference - except for a retired row
// (reduce/adjust), which never counts towards the balance. Type, blank number,
// reason and author are stored as entered; changing a row in or out of a
// retired type moves the balance by the contribution it gains or loses.
function brokerHistoryEditForm(broker, movement, page, date, includeDeleted = false) {
  // A hand-over keeps its own type: it is a payment the owner took directly, so
  // it never carried a branch. Turning it into a branch top-up (or the other
  // way round) would move the money between the broker's balance and Cash from
  // Brokers, so the server rejects that correction (PATCH
  // /brokers/:id/history/:movementId). Its type select is left out here for
  // the same reason, and the other movements do not offer "handover".
  const isHandover = String(movement.Type || "") === "handover";
  const typeOptions = [
    "policy",
    "annulment",
    "deletion",
    "price_change",
    "increase",
    "reduce",
    "adjust",
  ].map((value) => ({ label: movementTypeLabel(value), value }));
  const spec = [
    {
      key: "amount",
      label: t("amount"),
      type: "number",
      step: "0.01",
      value: movement.Amount,
    },
  ];
  if (!isHandover) {
    spec.push({
      key: "type",
      label: t("type"),
      type: "select",
      options: typeOptions,
      value: movement.Type,
    });
  }
  spec.push(
    {
      key: "blancNumber",
      label: t("blankNo"),
      value: movement.BlancNumber || "",
    },
    { key: "reason", label: t("reason"), value: movement.Reason || "" },
    { key: "author", label: t("author"), value: movement.Author || "" }
  );
  if (isHandover) {
    // Who received the money, and the day AND time (24-hour clock) it belongs
    // to. Both are corrected here; the server keeps the stored moment when the
    // picker is cleared.
    spec.push({
      key: "Recipient",
      label: t("handedTo"),
      value: movement.Recipient || "",
      placeholder: t("handedToPlaceholder"),
    });
    spec.push({
      key: "date",
      label: t("handoverDate"),
      type: "datetime-local",
      value: datetimeInputValue(movement.CreatedAt),
      max: localDateString(),
    });
  }
  const form = buildForm(
    spec,
    async (payload) => {
      if (isHandover && payload.date) {
        const parts = dateFieldParseDateTime(payload.date);
        payload.date = parts.iso;
        payload.time = parts.time;
      }
      payload.TzOffset = -new Date().getTimezoneOffset();
      await api(`/brokers/${broker.id}/history/${movement.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      toast(t("movementUpdated"), "success");
      closeModal();
      brokerHistoryView(broker, page, date, includeDeleted);
    },
    t("save")
  );
  openModal(`${t("editMovement")} — ${broker.Name}`, form);
}

// Admin-only modal that sets the broker's starting balance: the balance it had
// BEFORE its first insurance was created, plus the date that balance belongs
// to. Saving it (PUT /brokers/:id/starting-balance) recalculates the broker's
// balance on the server from all of its insurances (an annulled one at its
// annulment tax only when the broker paid it) and its payments (top-ups and
// hand-overs), then re-opens the history so the corrected figures - and the
// recalculated running balances - are shown straight away.
function brokerStartingBalanceForm(
  broker,
  starting,
  date,
  includeDeleted = false
) {
  const form = buildForm(
    [
      {
        key: "amount",
        label: t("startingBalance"),
        type: "number",
        step: "0.01",
        value: starting ? starting.amount : 0,
      },
      {
        key: "date",
        label: t("startingBalanceDate"),
        type: "date",
        // A new starting balance belongs to today until the admin says
        // otherwise; an existing one keeps the day it was recorded for.
        value: starting && starting.date ? starting.date : localDateString(),
      },
    ],
    async (payload) => {
      await api(`/brokers/${broker.id}/starting-balance`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          amount: payload.amount,
          date: payload.date || localDateString(),
        }),
      });
      toast(t("startingBalanceSaved"), "success");
      closeModal();
      // The recalculated balance reorders nothing on this page, but a page past
      // the first would show a stale slice: start again at page 1.
      brokerHistoryView(broker, 1, date, includeDeleted);
    },
    t("save")
  );

  const body = el("div");
  body.appendChild(el("p", t("startingBalanceHint"), { class: "muted" }));
  body.appendChild(form);
  openModal(`${t("startingBalance")} — ${broker.Name}`, body);
}

// Money the broker paid: a top-up ("increase", the branch takes it as Cash from
// Brokers) or a hand-over to the owner ("handover", no branch). There is no
// "reduce" any more - a balance may not be lowered by hand; it falls as policies
// are created and is recalculated from the starting balance and the policies.
function brokerAdjust(broker, kind) {
  const titles = {
    increase: t("increase"),
    handover: t("handOver"),
  };
  const confirmations = {
    increase: t("brokerBalanceIncreased"),
    handover: t("brokerHandoverRecorded"),
  };
  // Admins may record a payment on an earlier day AND at an earlier time: money
  // the broker handed over before anyone could enter it still belongs to that
  // day's reports (and, for a top-up, to the branch's Cash from Brokers). The
  // picker opens on now, carries a 24-hour clock, and cannot name a day that has
  // not happened yet; a worker always records "now".
  const canBackdate =
    (kind === "increase" || kind === "handover") && userRole === "1";
  const spec = [
    { key: "amount", label: t("amount"), type: "number", value: "" },
    {
      key: "currency",
      label: t("currency"),
      type: "select",
      options: [
        { label: "EUR", value: "EUR" },
        { label: "TRY", value: "TRY" },
      ],
      value: "EUR",
    },
    { key: "reason", label: t("reason"), value: "" },
  ];
  // A hand-over records who in the office received the money from the broker.
  // The server requires it, just like it does for a cash hand-over.
  if (kind === "handover") {
    spec.push({
      key: "Recipient",
      label: t("handedTo"),
      value: "",
      placeholder: t("handedToPlaceholder"),
    });
  }
  if (canBackdate) {
    spec.push({
      key: "date",
      label: kind === "handover" ? t("handoverDate") : t("increaseDate"),
      type: "datetime-local",
      value: localDateTimeInputNow(),
      max: localDateString(),
    });
  }
  const form = buildForm(
    spec,
    async (payload) => {
      // The resulting broker movement is stamped with the picked day AND the
      // picked 24-hour clock; without a pick it is the worker's local time. A
      // backdated movement therefore carries the moment it really happened, not
      // the moment it was typed in. `date` and `time` are what tell the server
      // the moment was chosen, so it can insist on an admin.
      const picked = canBackdate ? payload.date : "";
      payload.CreatedAt = brokerMovementCreatedAt(picked);
      if (picked) {
        const parts = dateFieldParseDateTime(picked);
        payload.date = parts.iso;
        payload.time = parts.time;
      }
      payload.TzOffset = -new Date().getTimezoneOffset();
      // Money handed over by the broker is kept apart from current cash as the
      // branch's Cash from Brokers, so an increase must name the branch that
      // took the money (the logged-in user's branch). A hand-over went straight
      // to the owner, so it gets no branch - which is exactly what keeps it out
      // of Cash from Brokers.
      if (kind === "increase") payload.branch = getBranch();
      await api(`/brokers/${broker.id}/${kind}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      toast(confirmations[kind] || titles[kind] || kind, "success");
      closeModal();
      brokersView();
    },
    titles[kind] || kind
  );
  if (!canBackdate) {
    openModal(`${titles[kind] || kind} ${broker.Name}`, form);
    return;
  }
  const body = el("div");
  body.appendChild(
    el(
      "p",
      kind === "handover" ? t("handoverDateHint") : t("increaseDateHint"),
      { class: "muted" }
    )
  );
  body.appendChild(form);
  openModal(`${titles[kind] || kind} ${broker.Name}`, body);
}

function brokerCreateForm() {
  const form = buildForm(
    [
      { key: "Name", label: t("name"), value: "" },
      { key: "Code", label: t("brokerId"), value: "" },
      // A broker starts with the balance it is created with: the server stores
      // it as the broker's starting balance (dated today), which is the base of
      // every later recalculation.
      {
        key: "CashBalance",
        label: t("startingBalance"),
        type: "number",
        value: 0,
      },
      // Inactive blancs are not entered: they are calculated from the batches.
      {
        key: "batches",
        label: t("blancBatches"),
        type: "batches",
        value: [],
      },
      { key: "emails", label: "Emails", type: "emails", value: [] },
    ],
    async (payload) => {
      await api("/brokers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      toast(t("brokerCreated"), "success");
      closeModal();
      brokersView();
    },
    t("createUser")
  );
  openModal(t("newBroker"), form);
}

async function brokerEditForm(broker) {
  // The list endpoint may not include emails; fall back to the single-broker
  // endpoint so the emails already in use are always shown.
  // Normalise any plausible shape (array of strings/objects, a delimited
  // string, different key casing) into a flat list of address strings.
  const EMAIL_KEYS = ["emails", "Emails", "brokerEmails", "BrokerEmails"];
  const extractEmails = (src) => {
    if (!src || typeof src !== "object") return [];
    let raw;
    for (const k of EMAIL_KEYS) {
      if (src[k] !== undefined && src[k] !== null) {
        raw = src[k];
        break;
      }
    }
    if (raw === undefined) return [];
    if (typeof raw === "string") {
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) raw = parsed;
      } catch {
        // not JSON: treat as delimited text
      }
    }
    if (typeof raw === "string") raw = raw.split(/[,;\s]+/);
    if (!Array.isArray(raw)) return [];
    return raw
      .map((e) =>
        typeof e === "string"
          ? e
          : e && (e.Email || e.email || e.Address || e.address)
      )
      .map((e) => (typeof e === "string" ? e.trim() : ""))
      .filter(Boolean);
  };

  let emails = extractEmails(broker);
  // Always consult the single-broker endpoint too: the list endpoint may omit
  // emails or return them empty.
  try {
    const d = await api(`/brokers/${broker.id}`);
    const detail = [...extractEmails(d && d.broker), ...extractEmails(d)];
    emails = Array.from(new Set([...emails, ...detail]));
  } catch (err) {
    console.warn("Failed to load broker emails:", err);
  }

  const form = buildForm(
    [
      { key: "Name", label: t("name"), value: broker.Name },
      { key: "Code", label: t("brokerId"), value: broker.Code || "" },
      // The balance is NOT edited here: it is calculated from the broker's
      // starting balance, its policies and its payments, so a typed figure
      // would only last until the next recalculation (and used to leave an
      // "adjust" row behind). It is set on the balance history page instead.
      // Blanc ranges are managed per batch (the "Blanc batches" button), and
      // inactive blancs are calculated from them, so neither is edited here.
      {
        key: "emails",
        label: "Emails",
        type: "emails",
        value: emails,
      },
    ],
    async (payload) => {
      await api(`/brokers/${broker.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      toast(t("brokerUpdated"), "success");
      closeModal();
      brokersView();
    },
    t("save")
  );
  openModal(`${t("edit")} ${broker.Name}`, form);
}

// Compact "start–end, start–end" label for the brokers table. A batch that the
// server added by itself (a policy was force-created with a blanc outside every
// handed-out range) is painted pink, so it stands out from the batches an admin
// actually gave the broker.
function blancBatchesLabel(batches) {
  const holder = el("span");
  const list = Array.isArray(batches) ? batches : [];
  if (list.length === 0) {
    holder.textContent = "-";
    return holder;
  }
  list.forEach((b, index) => {
    if (index > 0) holder.appendChild(el("span", ", "));
    const range = `${b.RangeStart}–${b.RangeEnd}`;
    holder.appendChild(
      el(
        "span",
        range,
        b.AutoAdded
          ? { class: "batch-auto", title: t("autoBatchHint") }
          : null
      )
    );
  });
  return holder;
}

// Modal listing a broker's blanc batches with the per-batch and total
// used / inactive counts calculated by the server. Admins can add a new batch
// (start + end number), correct a batch's range or remove a batch; every
// change answers with the refreshed broker, which is re-rendered here.
async function brokerBatchesView(broker) {
  const isAdmin = userRole === "1";
  let current;
  try {
    current = (await api(`/brokers/${broker.id}`)).broker || broker;
  } catch (err) {
    toast(err.message, "error");
    return;
  }

  const holder = el("div", null, { class: "batch-manager" });
  const title = `${t("blancBatches")} - ${broker.Name}`;
  const send = async (path, method, body) => {
    const data = await api(`/brokers/${broker.id}/batches${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (data && data.broker) current = data.broker;
    render();
    brokersView();
  };

  function render() {
    const batches = Array.isArray(current.batches) ? current.batches : [];
    const summary = el("p", null, { class: "muted" });
    summary.textContent = t("blancSummary")
      .replace("{t}", Number(current.BlancTotal) || 0)
      .replace("{u}", Number(current.BlancUsed) || 0)
      .replace("{i}", Number(current.InactivePolicies) || 0);

    const table = renderTable(
      batches,
      [
        { key: "RangeStart", label: t("rangeStart") },
        { key: "RangeEnd", label: t("rangeEnd") },
        { key: "Total", label: t("blancCount") },
        { key: "Used", label: t("blancUsed") },
        { key: "Inactive", label: t("inactive") },
        {
          key: "CreatedAt",
          label: t("created"),
          format: (v) => formatDateTime(v),
        },
      ],
      isAdmin
        ? [
            {
              label: t("edit"),
              class: "secondary",
              onClick: (b) => editBatch(b),
            },
            {
              label: t("delete"),
              class: "danger",
              onClick: async (b) => {
                const msg = t("deleteBatchConfirm")
                  .replace("{s}", b.RangeStart)
                  .replace("{e}", b.RangeEnd);
                const confirmed = await appConfirm(msg, {
                  danger: true,
                  confirmLabel: t("delete"),
                });
                if (!confirmed) return;
                try {
                  await send(`/${b.id}`, "DELETE");
                  toast(t("batchDeleted"), "success");
                } catch (err) {
                  toast(err.message, "error");
                }
              },
            },
          ]
        : null,
      // A batch the server added by itself (a forced blanc outside the
      // handed-out ranges) is tinted pink, so it stands out in the list.
      (b) => (b.AutoAdded ? "batch-auto-row" : "")
    );

    const children = [summary, table];
    if (isAdmin) {
      children.push(el("h3", t("addBatch")));
      children.push(
        buildForm(
          [
            { key: "RangeStart", label: t("rangeStart"), value: "" },
            { key: "RangeEnd", label: t("rangeEnd"), value: "" },
          ],
          async (payload) => {
            await send("", "POST", payload);
            toast(t("batchAdded"), "success");
          },
          t("addBatch")
        )
      );
    }
    holder.replaceChildren(...children);
  }

  function editBatch(batch) {
    const form = buildForm(
      [
        { key: "RangeStart", label: t("rangeStart"), value: batch.RangeStart },
        { key: "RangeEnd", label: t("rangeEnd"), value: batch.RangeEnd },
      ],
      async (payload) => {
        await send(`/${batch.id}`, "PATCH", payload);
        toast(t("batchUpdated"), "success");
        // Return to the batch list (now refreshed) in the same modal.
        openModal(title, holder);
      },
      t("save")
    );
    openModal(`${t("edit")} ${batch.RangeStart}–${batch.RangeEnd}`, form);
  }

  render();
  openModal(title, holder);
}

async function brokerPricingEditor(broker) {
  // Only admins may view/edit a broker's pricing; workers have no access.
  if (userRole !== "1") return;
  try {
    // Fetch broker pricing from the server
    const data = await api(`/brokers/${broker.id}/pricing`);
    const pricing = data.pricing || {};
    const canEdit = userRole === "1";
    const modalTitle = `${t("pricing")} - ${broker.Name}`;

    // Build a table-like display for editing prices
    const container = el("div", null, { class: "pricing-editor" });

    // Get all vehicle types and durations from the pricing data
    const vehicleTypes = Object.keys(pricing).sort();
    const durations = new Set();
    for (const type of vehicleTypes) {
      Object.keys(pricing[type] || {}).forEach((d) => durations.add(Number(d)));
    }
    const durationArray = Array.from(durations).sort((a, b) => a - b);

    if (vehicleTypes.length === 0 || durationArray.length === 0) {
      container.appendChild(el("p", t("noData"), { class: "muted" }));
      openModal(modalTitle, container);
      return;
    }

    // Create a form with input fields for each price
    const form = el("form");
    const priceInputs = {}; // Store references to price inputs

    // Create table header
    const table = el("table", null, { class: "pricing-table" });
    const thead = el("thead");
    const headerRow = el("tr");
    headerRow.appendChild(el("th", t("vehicleType")));
    durationArray.forEach((d) => {
      headerRow.appendChild(
        el("th", `${d} ${t("days")}`, { class: "text-center" })
      );
    });
    thead.appendChild(headerRow);
    table.appendChild(thead);

    const tbody = el("tbody");
    vehicleTypes.forEach((vehicleType) => {
      const row = el("tr");
      const typeCell = el("td", vehicleType);
      row.appendChild(typeCell);

      durationArray.forEach((duration) => {
        const rawPrice = (pricing[vehicleType] || {})[duration];
        const cell = el("td", null, { class: "text-center" });
        if (canEdit) {
          const inputField = input("number", rawPrice ?? 0, "0.00");
          inputField.step = "0.01";
          inputField.min = "0";
          priceInputs[`${vehicleType}_${duration}`] = inputField;
          cell.appendChild(inputField);
        } else {
          cell.textContent = rawPrice === undefined ? "-" : money(rawPrice);
        }
        row.appendChild(cell);
      });

      tbody.appendChild(row);
    });
    table.appendChild(tbody);
    form.appendChild(table);

    // Submit button
    const submitBtn = el("button", t("save"), { type: "submit" });
    if (canEdit) form.appendChild(submitBtn);

    // Handle form submission
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      submitBtn.disabled = true;

      try {
        // Reconstruct pricing object from inputs
        const updatedPricing = {};
        for (const vehicleType of vehicleTypes) {
          updatedPricing[vehicleType] = {};
          durationArray.forEach((duration) => {
            const key = `${vehicleType}_${duration}`;
            const inputValue = priceInputs[key].value;
            updatedPricing[vehicleType][duration] = Number(inputValue) || 0;
          });
        }

        // Send to server
        await api(`/brokers/${broker.id}/pricing`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pricing: updatedPricing }),
        });

        toast(t("pricingUpdated"), "success");
        closeModal();
        brokersView();
      } catch (err) {
        toast(err.message, "error");
      } finally {
        submitBtn.disabled = false;
      }
    });

    container.appendChild(form);
    openModal(modalTitle, container);
  } catch (err) {
    toast(err.message, "error");
  }
}

async function downloadBrokersCsv() {
  const res = await fetch(`${API_BASE}/brokers/export?format=csv`, {
    headers: { Authorization: `Bearer ${getToken()}` },
  });
  if (!res.ok) {
    toast(t("exportFailed"), "error");
    return;
  }
  const text = await res.text();
  const blob = new Blob([text], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = el("a", "download");
  a.href = url;
  a.download = "brokers.csv";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------------------
// Insurance lookup result sorting
//
// The lookup table ("My insurances" for workers, "Insurances by date" for
// admins) is sorted in the browser: the whole result set is already loaded by
// the search, so clicking a column header re-orders it locally instead of
// querying the server again. The helpers below are pure (no DOM) so they can be
// exercised in Node.
// ---------------------------------------------------------------------------

// Sort state for the insurance lookup table: key is null (server order, newest
// first) or one of INSURANCE_SORT_KEYS; dir is "desc" (highest/newest first) or
// "asc" (lowest/oldest first).
let insuranceSort = { key: null, dir: "desc" };

// The columns of the lookup table that can be sorted by clicking their header.
const INSURANCE_SORT_KEYS = [
  "Price",
  "CreationDate",
  "Broker",
  "BrokerCode",
  "Author",
  "Annulled",
  "PaymentType",
  "Duration",
];

// Last search of each lookup tab (admins: "Insurances by date", workers:
// "Insurances"), keyed by the tab's title key. Switching tabs destroys the
// view, so the filters, results and sort are kept here and re-rendered when the
// tab is opened again - the user does not have to retype or re-run the search.
const insuranceSearchStates = new Map();

// Autocomplete data for the lookup filters (authors and broker names/codes).
// The dedicated /insurances/suggestions endpoint is preferred, but the lists
// must still work against an older server (or while it is unreachable), so the
// loader falls back to endpoints that already exist:
//   - /brokers          -> broker names + their IDs (roles 1 and 2),
//   - /admin/users      -> author usernames (admins only),
//   - the signed-in user and every search's own rows are merged in as well, so
//     workers gradually get their colleagues' names from the policies they see.
// The pool is shared by every lookup tab and one failed load is not cached, so
// opening the tab again retries the primary source.
const insuranceSuggestionAuthors = new Set();
const insuranceSuggestionBrokers = new Map(); // broker name -> code
let insuranceFilterSuggestionsRequest = null;
let insuranceFilterSuggestionsLoaded = false;

// Add authors/brokers to the shared pool. Returns true when anything new was
// learned, so the caller can refresh its dropdowns only when needed.
function mergeInsuranceSuggestions(authors, brokers) {
  let changed = false;
  for (const raw of Array.isArray(authors) ? authors : []) {
    const name = String(raw ?? "").trim();
    if (name && !insuranceSuggestionAuthors.has(name)) {
      insuranceSuggestionAuthors.add(name);
      changed = true;
    }
  }
  for (const raw of Array.isArray(brokers) ? brokers : []) {
    const name = String((raw && raw.Name) || "").trim();
    if (!name) continue;
    const code = String((raw && raw.Code) || "").trim();
    const previous = insuranceSuggestionBrokers.get(name);
    if (previous === undefined) {
      insuranceSuggestionBrokers.set(name, code);
      changed = true;
    } else if (!previous && code) {
      // The brokers table knows the ID of a name first seen on an old policy.
      insuranceSuggestionBrokers.set(name, code);
      changed = true;
    }
  }
  return changed;
}

// The current pool in the order the dropdowns show it.
function currentInsuranceSuggestions() {
  return {
    authors: Array.from(insuranceSuggestionAuthors).sort((a, b) =>
      a.localeCompare(b)
    ),
    brokers: Array.from(
      insuranceSuggestionBrokers,
      ([Name, Code]) => ({ Name, Code })
    ).sort((a, b) => a.Name.localeCompare(b.Name)),
  };
}

// Learn from the rows of a search the user just ran. This is what gives a
// worker author suggestions without an admin-only users endpoint.
function rememberInsuranceSuggestionsFromRows(rows) {
  const list = Array.isArray(rows) ? rows : [];
  return mergeInsuranceSuggestions(
    list.map((r) => r && r.Author),
    list.map((r) => ({ Name: r && r.Broker, Code: r && r.BrokerCode }))
  );
}

function loadInsuranceFilterSuggestions() {
  if (insuranceFilterSuggestionsLoaded) {
    return Promise.resolve(currentInsuranceSuggestions());
  }
  if (!insuranceFilterSuggestionsRequest) {
    insuranceFilterSuggestionsRequest = (async () => {
      let primaryLoaded = false;
      let fallbackLoaded = false;
      // Preferred source: the dedicated endpoint (authors + brokers, including
      // broker names that only survive on old policies).
      try {
        const data = await api("/insurances/suggestions");
        mergeInsuranceSuggestions(data && data.authors, data && data.brokers);
        primaryLoaded = true;
      } catch (err) {
        console.warn("Failed to load insurance filter suggestions:", err);
      }
      // Older server: brokers are available to both admins and workers.
      if (!primaryLoaded) {
        try {
          const data = await api("/brokers");
          mergeInsuranceSuggestions([], data && data.brokers);
          fallbackLoaded = true;
        } catch (err) {
          console.warn("Failed to load broker suggestions:", err);
        }
      }
      // Author names for admins, who may list every account (including the
      // soft-deleted ones whose policies still exist).
      if (!primaryLoaded && userRole === "1") {
        try {
          const data = await api("/admin/users?includeDeleted=1");
          mergeInsuranceSuggestions(
            [
              ...((data && data.users) || []).map((u) => u && u.Username),
              ...((data && data.deleted) || []).map((u) => u && u.Username),
            ],
            []
          );
          fallbackLoaded = true;
        } catch (err) {
          console.warn("Failed to load author suggestions:", err);
        }
      }
      // The signed-in user is always a valid author.
      if (typeof username === "string" && username) {
        mergeInsuranceSuggestions([username], []);
      }
      insuranceFilterSuggestionsLoaded = primaryLoaded || fallbackLoaded;
      return currentInsuranceSuggestions();
    })().finally(() => {
      insuranceFilterSuggestionsRequest = null;
    });
  }
  return insuranceFilterSuggestionsRequest;
}

// Unique id source for the visible autocomplete dropdowns.
let suggestionListSeq = 0;

// Comparable value of one cell: a number for price/status/duration, a timestamp
// for the creation date (parsed exactly like formatDateTime, so the order
// matches what is displayed) and text for broker/author/payment type. Empty or
// unparsable values become null and always sink to the bottom of the list.
function insuranceSortValue(item, key) {
  const raw = item ? item[key] : null;
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return null;
  }
  if (key === "Price" || key === "Annulled" || key === "Duration") {
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }
  if (key === "CreationDate") {
    let d;
    if (raw instanceof Date) {
      d = raw;
    } else {
      const s = String(raw).trim();
      const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})/);
      d = m
        ? new Date(
            Number(m[1]),
            Number(m[2]) - 1,
            Number(m[3]),
            Number(m[4]),
            Number(m[5])
          )
        : new Date(s);
    }
    const ms = d ? d.getTime() : NaN;
    return Number.isFinite(ms) ? ms : null;
  }
  return String(raw);
}

// Order two extracted values: numbers numerically, text alphabetically
// (case-insensitive, and "2" before "10" thanks to the numeric option).
function compareInsuranceValues(a, b) {
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "string" && typeof b === "string") {
    return a.localeCompare(b, undefined, {
      numeric: true,
      sensitivity: "base",
    });
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

// Sorted copy of `rows`. They are returned untouched (in the fetched order)
// when no sort key is active. Array.prototype.sort is stable, so equal values
// keep the server order (newest first).
function sortInsuranceRows(rows, key, dir) {
  const list = Array.isArray(rows) ? [...rows] : [];
  if (!INSURANCE_SORT_KEYS.includes(key)) return list;
  const d = dir === "asc" ? 1 : -1;
  return list.sort((a, b) => {
    const va = insuranceSortValue(a, key);
    const vb = insuranceSortValue(b, key);
    // Blank cells stay at the bottom in both directions.
    if (va === null || vb === null) {
      if (va === null && vb === null) return 0;
      return va === null ? 1 : -1;
    }
    return d * compareInsuranceValues(va, vb);
  });
}

// Status shown for a policy in the lookup table / export. A deleted policy
// (only visible to admins searching with "Include deleted") says so, along
// with who deleted it when the server recorded that.
function insuranceStatusLabel(item) {
  if (!item) return "";
  if (item.Deleted) {
    const by = item.DeletedBy ? ` (${item.DeletedBy})` : "";
    return `${t("deleted")}${by}`;
  }
  if (!item.Annulled) return "";
  return `${t("annulled")}${annulPayerSuffix(item.AnnulReason)}`;
}

// Row tint for a policy in a table. Annulled rows are tinted by who was at
// fault (worker / broker / no fault); unknown/legacy reasons fall back to a
// plain annulled tint.
function annulledRowClass(item) {
  if (!item || !item.Annulled) return "";
  const payer = annulPayerKey(item.AnnulReason);
  return payer ? `row-annulled-${payer}` : "row-annulled";
}

// ---------------------------------------------------------------------------
// Broker name matching (script-insensitive)
// ---------------------------------------------------------------------------

// Bulgarian Cyrillic → Latin transliteration so the broker lookup is insensitive
// to the Cyrillic/Latin script difference: "Lesovo" finds the walk-in policies
// stored under "ГКПП Лесово", and "kap andreevo" finds "ГКПП Капитан Андреево".
// Mirrors the server-side match in InsuranceServer/Requests/TierEndpoints.js.
const BROKER_CYR_TO_LAT = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ж: "zh", з: "z",
  и: "i", й: "y", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p",
  р: "r", с: "s", т: "t", у: "u", ф: "f", х: "h", ц: "ts", ч: "ch",
  ш: "sh", щ: "sht", ъ: "a", ь: "y", ю: "yu", я: "ya",
};
function transliterateBrokerName(value) {
  return String(value == null ? "" : value)
    .toLowerCase()
    .replace(/[а-я]/g, (ch) => BROKER_CYR_TO_LAT[ch] || ch);
}
function brokerNameMatches(storedBroker, query) {
  const haystack = transliterateBrokerName(storedBroker);
  const words = transliterateBrokerName(query).split(/\s+/).filter(Boolean);
  if (!words.length) return false;
  let from = 0;
  for (const word of words) {
    const idx = haystack.indexOf(word, from);
    if (idx === -1) return false;
    from = idx + word.length;
  }
  return true;
}

// Whether a broker row stays visible for the brokers table's Name filter.
// An empty filter shows every row; otherwise every typed word must match the
// broker's name (script- and case-insensitive, see brokerNameMatches).
function brokerRowMatchesNameFilter(name, query) {
  const text = String(query === undefined || query === null ? "" : query).trim();
  if (!text) return true;
  return brokerNameMatches(name, text);
}

// The lookup's Broker field accepts the broker's ID ("2.1") as well, so the ID
// shown next to a name in the suggestions can be typed directly. Codes are
// compared as case-insensitive substrings, exactly like the server matches
// them, and an empty query matches nothing (the name match already handled the
// empty-filter case).
function brokerCodeMatchesQuery(code, query) {
  const text = String(query === undefined || query === null ? "" : query)
    .trim()
    .toLowerCase();
  if (!text) return false;
  return String(code === undefined || code === null ? "" : code)
    .toLowerCase()
    .includes(text);
}

// A small visible autocomplete dropdown for a text input. Native <datalist>
// suggestions are easy to miss (they only appear while typing and cannot be
// opened programmatically), so the lookup filters use this instead:
//   - clicking or focusing the field shows the current suggestions at once,
//   - typing filters them (the caller decides how),
//   - clicking or Enter selects one, ArrowUp/Down move, Escape closes.
// `getItems` returns [{ value, hint? }] from the current suggestion pool, so
// names learned later (a search, the async loader) are used automatically.
function attachAutocomplete(inputNode, getItems, matches) {
  const fieldWrap = inputNode.closest(".field") || inputNode.parentNode;
  if (!fieldWrap) return { refresh() {} };
  fieldWrap.classList.add("autocomplete-field");
  const listId = `autocomplete-list-${++suggestionListSeq}`;
  const list = el("div", null, {
    class: "autocomplete-list hidden",
    id: listId,
    role: "listbox",
  });
  fieldWrap.appendChild(list);
  inputNode.setAttribute("autocomplete", "off");
  inputNode.setAttribute("aria-autocomplete", "list");
  inputNode.setAttribute("aria-controls", listId);
  inputNode.setAttribute("aria-expanded", "false");

  let items = [];
  let active = -1;

  function close() {
    list.classList.add("hidden");
    inputNode.setAttribute("aria-expanded", "false");
    inputNode.removeAttribute("aria-activedescendant");
    active = -1;
  }

  function open() {
    const query = String(inputNode.value || "").trim();
    items = (getItems() || [])
      .filter((item) => item && matches(item, query))
      .slice(0, 12);
    if (!items.length) {
      close();
      return;
    }
    active = -1;
    list.replaceChildren(
      ...items.map((item, index) => {
        const option = el("div", null, {
          class: "autocomplete-option",
          role: "option",
          id: `${listId}-${index}`,
        });
        option.appendChild(
          el("span", item.value, { class: "autocomplete-value" })
        );
        if (item.hint) {
          option.appendChild(
            el("span", item.hint, { class: "autocomplete-hint" })
          );
        }
        option.addEventListener("mousedown", (e) => {
          // Keep the focus in the input; a click would blur it first and the
          // blur timer would close the list before the selection was handled.
          e.preventDefault();
          pick(index);
        });
        return option;
      })
    );
    list.classList.remove("hidden");
    inputNode.setAttribute("aria-expanded", "true");
  }

  function pick(index) {
    const item = items[index];
    if (!item) return;
    inputNode.value = item.value;
    // Tell the rest of the view (persistence, filters) that the value changed.
    inputNode.dispatchEvent(new Event("input", { bubbles: true }));
    close();
  }

  function highlight(index) {
    if (!items.length) return;
    active = (index + items.length) % items.length;
    Array.from(list.children).forEach((node, i) =>
      node.classList.toggle("active", i === active)
    );
    inputNode.setAttribute(
      "aria-activedescendant",
      `${listId}-${active}`
    );
  }

  inputNode.addEventListener("focus", open);
  inputNode.addEventListener("click", open);
  inputNode.addEventListener("input", open);
  inputNode.addEventListener("blur", () => setTimeout(close, 120));
  inputNode.addEventListener("keydown", (e) => {
    if (list.classList.contains("hidden")) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      highlight(active + 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      highlight(active - 1);
    } else if (e.key === "Enter" && active >= 0) {
      // Select the highlighted suggestion instead of running the search.
      e.preventDefault();
      e.stopImmediatePropagation();
      pick(active);
    } else if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  });

  return {
    refresh() {
      // Re-open (or fill while the input is focused) when names arrive later,
      // e.g. from the async loader or from a search the user just ran.
      if (
        !list.classList.contains("hidden") ||
        document.activeElement === inputNode
      ) {
        open();
      }
    },
    close,
  };
}

// Hide/show already-rendered broker rows for the Name filter. `rows` holds
// { name, row } entries in table order; returns how many rows stay visible. The
// rows are toggled in place (never rebuilt), so the header input keeps its
// value and the caret stays where the worker left it.
function applyBrokerNameFilterToRows(rows, query) {
  const list = Array.isArray(rows) ? rows : [];
  const text = String(query === undefined || query === null ? "" : query).trim();
  let shown = 0;
  for (const entry of list) {
    if (!entry || !entry.row) continue;
    const match = brokerRowMatchesNameFilter(entry.name, text);
    entry.row.classList.toggle("broker-name-filtered-out", !match);
    if (match) shown++;
  }
  return shown;
}


async function adminInsurancesByDate(defaultAuthor = "", titleKey = "nav.insurancesByDate") {
  // Admin/worker filtered list: GET /insurances?author=&date=&policyNumber=&blancNumber=&carNumber=&broker=&annulled=&payment=
  // All fields are optional, but at least one must be filled in to search. Any
  // single criteria (or any combination of them) can be used.
  // The author field is intentionally empty by default so a search by, e.g.,
  // only a car number is not silently narrowed to the current user's own
  // records. Workers reach this view through the "Insurances" tab, which also
  // leaves the author field empty so they can find and edit any policy.
  // PolicyNumber/BlancNumber/CarNumber/Broker match partially (substring) on
  // the server, so a worker can search by a fragment of the number or a partly
  // typed broker name ("Euro" finds the "Euroins" policies). The broker field
  // also accepts the broker's ID ("2.1"): the suggestions show it next to the
  // name and the match covers it, so there is no separate ID input. Author and
  // Broker have autocomplete from the values already in the database.
  // The result table also lists the broker, its ID and the author of every
  // policy and can be sorted by price, creation date, broker, broker ID, author,
  // status and payment type by clicking the column headers (see the sorting
  // helpers above).
  //
  // The tab remembers its last search: switching to another tab and back
  // restores the filters, the results and the chosen sort (see
  // insuranceSearchStates). Clearing the form forgets it.
  const savedSearch = insuranceSearchStates.get(titleKey) || null;
  // Restore the sort the tab was left with.
  if (savedSearch && savedSearch.sort) {
    insuranceSort = { ...savedSearch.sort };
  }
  const initial = (key, fallback = "") =>
    savedSearch && savedSearch[key] !== undefined ? savedSearch[key] : fallback;

  const authorInput = input("text", initial("author", defaultAuthor));
  const brokerInput = input("text", initial("broker"));
  const dateInput = input("date", initial("date"));
  const policyNumberInput = input("text", initial("policyNumber"));
  const blancNumberInput = input("text", initial("blancNumber"));
  const carNumberInput = input("text", initial("carNumber"));
  const paymentInput = select(
    [
      { label: "", value: "" },
      { label: t("payment.Cash"), value: "Cash" },
      { label: t("payment.Card"), value: "Card" },
      // Both walk-in channels at once (the server accepts the combination).
      { label: t("payment.cardCash"), value: "cash+card" },
      { label: t("payment.Broker"), value: "Broker" },
    ],
    initial("payment")
  );
  const annulledInput = input("checkbox");
  annulledInput.checked = Boolean(savedSearch && savedSearch.annulled);

  // Autocomplete for the free-text filters is attached after the inputs are
  // wrapped in their .field containers (see below): the dropdown is positioned
  // relative to that wrapper, which only exists once the form is built.

  const apply = el("button", t("load"));
  const clearBtn = el("button", t("clear"), {
    class: "secondary",
    type: "button",
  });
  const form = el("div", null, { class: "row filter-row" });
  form.appendChild(field(t("author"), authorInput));
  form.appendChild(field(t("broker"), brokerInput));
  form.appendChild(field(t("date"), dateInput));
  form.appendChild(field(t("policyNumber"), policyNumberInput));
  form.appendChild(field(t("blankNo"), blancNumberInput));
  form.appendChild(field(t("carNumber"), carNumberInput));
  form.appendChild(field(t("payment"), paymentInput));
  // Checkboxes are the shared pill toggle (see checkboxToggle), so the caption
  // sits INSIDE the outlined pill like every other checkbox in the app instead
  // of above a bare round tick.
  form.appendChild(checkboxToggle(t("annulledFilter"), null, annulledInput));
  // Admins can also look up soft-deleted insurances (e.g. to check who deleted
  // a policy and when). Workers never get the option - the server ignores the
  // flag for them anyway.
  const isAdminSearch = userRole === "1";
  const includeDeletedInput = isAdminSearch ? input("checkbox") : null;
  if (includeDeletedInput) {
    includeDeletedInput.checked = Boolean(
      savedSearch && savedSearch.includeDeleted
    );
    form.appendChild(
      checkboxToggle(t("includeDeleted"), null, includeDeletedInput)
    );
  }
  // Attach the visible autocomplete dropdowns now that the inputs are inside
  // their .field wrappers.
  const authorAutocomplete = attachAutocomplete(
    authorInput,
    () =>
      currentInsuranceSuggestions().authors.map((name) => ({ value: name })),
    (item, query) =>
      !query || item.value.toLowerCase().includes(query.toLowerCase())
  );
  const brokerAutocomplete = attachAutocomplete(
    brokerInput,
    () =>
      currentInsuranceSuggestions().brokers.map((b) => ({
        value: b.Name,
        hint: b.Code ? `${t("brokerIdFilter")} ${b.Code}` : "",
      })),
    (item, query) =>
      brokerRowMatchesNameFilter(item.value, query) ||
      !query ||
      String(item.hint || "")
        .toLowerCase()
        .includes(query.toLowerCase())
  );
  function refreshAutocompletes() {
    authorAutocomplete.refresh();
    brokerAutocomplete.refresh();
  }
  function closeAutocompletes() {
    authorAutocomplete.close();
    brokerAutocomplete.close();
  }
  loadInsuranceFilterSuggestions().then(refreshAutocompletes);
  // Exports exactly what the table shows (same rows, same order, same row
  // numbers) as an .xlsx file. Disabled until a search returns rows. Workers
  // get the same button; the broker prices they cannot see stay blank.
  const exportBtn = el("button", t("exportExcel"), {
    class: "secondary",
    type: "button",
  });
  exportBtn.disabled = true;
  form.appendChild(apply);
  form.appendChild(clearBtn);
  form.appendChild(el("div", null, { class: "spacer" }));
  form.appendChild(exportBtn);

  const result = el("div");

  // Live search feedback. The spinner makes a request visible even when it
  // finishes in milliseconds; the text then says whether anything came back or
  // whether the result is the same as the previous search. `aria-live` lets a
  // screen reader announce it as well.
  const searchStatus = el("div", null, {
    class: "search-status hidden",
    "aria-live": "polite",
  });
  const searchSpinner = el("span", null, {
    class: "search-spinner",
    "aria-hidden": "true",
  });
  const searchStatusText = el("span", null, { class: "search-status-text" });
  searchSpinner.hidden = true;
  searchStatus.appendChild(searchSpinner);
  searchStatus.appendChild(searchStatusText);

  function setSearchStatus(state, text) {
    searchStatus.classList.remove(
      "hidden",
      "is-searching",
      "is-done",
      "is-empty"
    );
    if (!state) {
      searchStatus.classList.add("hidden");
      searchSpinner.hidden = true;
      searchStatusText.textContent = "";
      return;
    }
    searchStatus.classList.add(`is-${state}`);
    searchSpinner.hidden = state !== "searching";
    searchStatusText.textContent = text || "";
    // Restart the short slide-in even when the line was already visible (a
    // second search), so every completed lookup is visibly acknowledged.
    if (text) {
      searchStatusText.classList.remove("search-status-text");
      void searchStatusText.offsetWidth;
      searchStatusText.classList.add("search-status-text");
    }
  }

  // Same idea for the results themselves: a brief fade/slide on every completed
  // search, including one that leaves the rows exactly as they were.
  function flashSearchResults() {
    result.classList.remove("search-result-flash");
    void result.offsetWidth;
    result.classList.add("search-result-flash");
  }

  // Rows of the last successful search, kept so clicking a column header can
  // re-sort and re-render them without asking the server again. They (and the
  // fact that a search was run) are restored when the tab is reopened.
  let lastRows =
    savedSearch && Array.isArray(savedSearch.rows) ? savedSearch.rows : [];
  let hasSearched = Boolean(
    savedSearch &&
      (savedSearch.searched ||
        (Array.isArray(savedSearch.rows) && savedSearch.rows.length > 0))
  );
  // True while a request is in flight: blocks a second search and keeps the
  // Load button disabled until the answer arrives.
  let searching = false;
  // Incremented by Clear so a reply that arrives after clearing is ignored
  // instead of re-filling the results the user just removed.
  let searchSeq = 0;

  // Snapshot of everything the tab should remember when it is left.
  function rememberSearch() {
    insuranceSearchStates.set(titleKey, {
      author: authorInput.value,
      broker: brokerInput.value,
      date: dateInput.value,
      policyNumber: policyNumberInput.value,
      blancNumber: blancNumberInput.value,
      carNumber: carNumberInput.value,
      payment: paymentInput.value,
      annulled: annulledInput.checked,
      includeDeleted: Boolean(
        includeDeletedInput && includeDeletedInput.checked
      ),
      rows: lastRows,
      sort: { ...insuranceSort },
      searched: hasSearched,
    });
  }

  // Header extras for a sortable column: an arrow on the currently sorted
  // column plus the click handler. The first click on a column sorts
  // descending (highest/newest first), a second click on the same column flips
  // it to ascending — the same behaviour as the brokers table.
  const sortHeader = (key) => ({
    headerSuffix:
      insuranceSort.key !== key ? "" : insuranceSort.dir === "desc" ? "▼" : "▲",
    onHeaderClick: () => {
      insuranceSort = {
        key,
        dir:
          insuranceSort.key === key && insuranceSort.dir === "desc"
            ? "asc"
            : "desc",
      };
      renderResults();
    },
  });

  // Whether the current user may see the price of `item`. Admins always can;
  // workers see every walk-in (broker-less) price — the non-Turk / card-fee
  // fees apply to those and must stay visible — but never a broker (email)
  // price.
  function canSeePrice(item) {
    if (userRole === "1") return true;
    if (!item) return false;
    return (
      item.BrokerId === null ||
      item.BrokerId === undefined ||
      item.BrokerId === ""
    );
  }

  // Renders the current rows with the active sort applied. Sorting is done in
  // the browser (see sortInsuranceRows), so switching the order never re-runs
  // the search.
  function renderResults() {
    const sorted = sortInsuranceRows(
      lastRows,
      insuranceSort.key,
      insuranceSort.dir
    );
    // Row numbers follow the displayed (sorted) order: 1, 2, 3, …
    const rowNumbers = new Map(sorted.map((row, idx) => [row, idx + 1]));
    exportBtn.disabled = sorted.length === 0;
    result.replaceChildren(
      renderTable(
        sorted,
        [
          {
            key: "__rowNo",
            label: t("rowNo"),
            format: (_v, item) => rowNumbers.get(item),
          },
          { key: "BlancNumber", label: t("blankNo") },
          { key: "PolicyNumber", label: t("policyNumber") },
          { key: "CarNumber", label: t("carNumber") },
          // The policy's term, in the same shift-log shorthand the Excel export
          // uses (15D / 1M / 3M), so a row and its exported sheet always agree.
          {
            key: "Duration",
            label: t("add.duration"),
            format: (v) => insuranceDurationLabel(v),
            ...sortHeader("Duration"),
          },
          {
            key: "Price",
            label: t("price"),
            // Admins always see the price. Workers see walk-in (broker-less)
            // prices but never a broker (email) price. For an active walk-in
            // card payment the +2 bank fee is shown on top so the worker knows
            // the total to charge (it is never stored). An annulled policy
            // shows the annulment tax (see insuranceExportPrice), never the
            // original sale price.
            format: (_v, item) =>
              canSeePrice(item) ? money(insuranceExportPrice(item)) : "",
            ...sortHeader("Price"),
          },
          { key: "CurrencyType", label: t("currency") },
          {
            key: "PaymentType",
            label: t("payment"),
            format: paymentLabel,
            ...sortHeader("PaymentType"),
          },
          { key: "Broker", label: t("broker"), ...sortHeader("Broker") },
          // The broker's human-readable ID ("2.1"). A walk-in policy has no
          // BrokerId of its own, but the server still fills its ID from the
          // branch's broker record - the border crossings are registered as
          // brokers - so a policy issued at ГКПП Капитан Андреево shows 2.1 and
          // one from ГКПП Лесово shows 4.2. Branches that are not brokers (the
          // Harmanli office) have no ID and stay blank.
          { key: "BrokerCode", label: t("brokerIdFilter"), ...sortHeader("BrokerCode") },
          { key: "Author", label: t("author"), ...sortHeader("Author") },
          {
            key: "CreationDate",
            label: t("created"),
            format: (v) => formatDateTime(v),
            ...sortHeader("CreationDate"),
          },
          {
            key: "Annulled",
            label: t("status"),
            format: (_v, item) => insuranceStatusLabel(item),
            ...sortHeader("Annulled"),
          },
        ],
        // A deleted policy can no longer be edited, annulled or deleted (the
        // server rejects all three). Admin users get a "Restore" action instead
        // to bring it back; anyone else sees it read-only.
        (i) =>
          i.Deleted
            ? userRole === "1"
              ? [
                  {
                    label: t("restore"),
                    class: "",
                    onClick: () => restoreInsurance(i, () => runSearch()),
                  },
                ]
              : []
            : [
                {
                  label: t("edit"),
                  class: "",
                  // Re-run the search after a save (like annul/delete do here) so
                  // the corrected fields are re-read from the server. Admins get
                  // the author / broker dropdowns, whose lists are refreshed
                  // first (see openInsuranceEditorFor).
                  onClick: () => openInsuranceEditorFor(i, () => runSearch()),
                },
                ...(!i.Annulled
                  ? [
                      {
                        label: t("annul"),
                        class: "danger",
                        onClick: () =>
                          openAnnulForm(i, () => {
                            i.Annulled = 1;
                            runSearch();
                          }),
                      },
                    ]
                  : []),
                // Deleting is an admin-only action (enforced server-side too). It
                // is the row's "X": it only appears while the row is hovered, so
                // it cannot be hit by accident.
                ...(userRole === "1"
                  ? [
                      {
                        label: t("deleteInsurance"),
                        class: "danger",
                        hover: true,
                        onClick: () => deleteInsurance(i, () => runSearch()),
                      },
                    ]
                  : []),
              ],
        (i) => (i.Deleted ? "row-deleted" : annulledRowClass(i)),
        // Edit and Annul stay invisible until the row is hovered (or one of its
        // buttons is reached with the keyboard), so a list that is read far more
        // often than it is acted on stays calm - see .row-hover-actions in
        // app.css. The delete "X" keeps its own, stricter hover-only rule.
        null,
        { revealActions: true }
      )
    );
    // The sum of the shown policies, right-aligned under the table and split
    // per currency (the rows can mix EUR and TRY). Each row contributes what
    // its Price cell shows: an active policy its price, an annulled policy its
    // annulment tax, so the total includes the tax kept from annulled rows. A
    // row whose price this user may not see contributes nothing, exactly like
    // its blank Price cell - a worker's total never reveals a broker (email)
    // price.
    if (sorted.length) {
      const totals = sumShownInsurancePrices(sorted, canSeePrice);
      const totalText = totals.length
        ? totals
            .map(({ currency, amount }) => `${money(amount)} ${currency}`)
            .join(" · ")
        : money(0);
      const totalRow = el("div", null, { class: "row insurance-total-row" });
      totalRow.appendChild(
        el("span", `${t("totalIncludingAnnulled")}: ${totalText}`, {
          class: "muted",
        })
      );
      result.appendChild(totalRow);
    }
    // Keep the tab's search state current for the next visit (also when a
    // header click changed only the sort).
    rememberSearch();
  }

  async function runSearch() {
    if (searching) return;
    const author = authorInput.value.trim();
    const broker = brokerInput.value.trim();
    const date = dateInput.value;
    const policyNumber = policyNumberInput.value.trim();
    const blancNumber = blancNumberInput.value.trim();
    const carNumber = carNumberInput.value.trim();
    const payment = paymentInput.value;
    const annulled = annulledInput.checked;

    if (
      !author &&
      !broker &&
      !date &&
      !policyNumber &&
      !blancNumber &&
      !carNumber &&
      !payment &&
      !annulled
    ) {
      toast(t("searchCriteriaRequired"), "error");
      return;
    }

    searching = true;
    const requestId = ++searchSeq;
    apply.disabled = true;
    const previousRows = lastRows;
    const wasSearched = hasSearched;
    const startedAt = Date.now();
    closeAutocompletes();
    setSearchStatus("searching", t("searching"));

    const params = new URLSearchParams();
    if (author) params.set("author", author);
    if (broker) params.set("broker", broker);
    if (date) params.set("date", date);
    if (policyNumber) params.set("policyNumber", policyNumber);
    if (blancNumber) params.set("blancNumber", blancNumber);
    if (carNumber) params.set("carNumber", carNumber);
    if (payment) params.set("payment", payment);
    if (annulled) params.set("annulled", "1");
    if (includeDeletedInput && includeDeletedInput.checked) {
      params.set("includeDeleted", "1");
    }

    try {
      const data = await api(`/insurances?${params.toString()}`);
      // Keep the spinner on screen long enough to register even when the server
      // answers in a few milliseconds. The result flash then confirms that the
      // lookup finished.
      const remaining = 260 - (Date.now() - startedAt);
      if (remaining > 0) {
        await new Promise((resolve) => setTimeout(resolve, remaining));
      }
      // The user cleared the form while the request was running: drop this
      // answer so it cannot bring the results back.
      if (requestId !== searchSeq) return;
      let rows = data.insurances || [];
      // The server matches the broker name (and its ID) itself, script-
      // insensitively. This extra pass only matters while the deployed server
      // still predates that, so the Broker field keeps working right after a
      // client update; once the server filters too, every returned row already
      // matches and the pass is a no-op. It uses the same transliteration-aware
      // name match and the same case-insensitive ID substring.
      if (broker) {
        rows = rows.filter(
          (r) =>
            brokerNameMatches(r.Broker, broker) ||
            brokerCodeMatchesQuery(r.BrokerCode, broker)
        );
      }
      // The rows themselves are the best autocomplete source: every author and
      // broker the user can see is added to the shared pool (this is how a
      // worker gets colleagues' names without the admin-only users endpoint).
      rememberInsuranceSuggestionsFromRows(rows);
      refreshAutocompletes();
      // Keep the rows so the column headers can re-sort them locally.
      const unchanged =
        wasSearched && JSON.stringify(previousRows) === JSON.stringify(rows);
      lastRows = rows;
      hasSearched = true;
      renderResults();
      // A short fade/slide confirms the search even when the rows match the
      // previous ones; the status line says which of the three cases happened.
      flashSearchResults();
      if (!rows.length) {
        setSearchStatus("empty", t("searchNoResults"));
      } else if (unchanged) {
        setSearchStatus("done", t("searchUnchanged"));
      } else {
        setSearchStatus("done", fmt(t("searchFound"), { n: rows.length }));
      }
    } catch (err) {
      toast(err.message, "error");
      setSearchStatus(null);
    } finally {
      searching = false;
      apply.disabled = false;
    }
  }

  apply.addEventListener("click", runSearch);
  // Pressing Enter in any filter field triggers the search too.
  [
    authorInput,
    brokerInput,
    dateInput,
    policyNumberInput,
    blancNumberInput,
    carNumberInput,
  ].forEach((inp) => {
    inp.addEventListener("keydown", (e) => {
      if (e.defaultPrevented) return;
      if (e.key === "Enter") {
        e.preventDefault();
        runSearch();
      }
    });
  });
  // Keep the form's current values even when the user leaves without pressing
  // Load, so returning to the tab shows exactly what was being typed.
  [
    authorInput,
    brokerInput,
    dateInput,
    policyNumberInput,
    blancNumberInput,
    carNumberInput,
  ].forEach((inp) => inp.addEventListener("input", rememberSearch));
  paymentInput.addEventListener("change", rememberSearch);
  annulledInput.addEventListener("change", rememberSearch);
  if (includeDeletedInput) {
    includeDeletedInput.addEventListener("change", rememberSearch);
  }
  clearBtn.addEventListener("click", () => {
    authorInput.value = "";
    brokerInput.value = "";
    dateInput.value = "";
    policyNumberInput.value = "";
    blancNumberInput.value = "";
    carNumberInput.value = "";
    paymentInput.value = "";
    annulledInput.checked = false;
    if (includeDeletedInput) includeDeletedInput.checked = false;
    // Clearing drops the results, so the sort order is reset with them: the
    // next search starts in the default (server) order again. The tab is
    // forgotten too, so returning to it later shows a fresh form.
    lastRows = [];
    hasSearched = false;
    searchSeq++;
    insuranceSort = { key: null, dir: "desc" };
    insuranceSearchStates.delete(titleKey);
    exportBtn.disabled = true;
    setSearchStatus(null);
    closeAutocompletes();
    result.replaceChildren();
  });
  exportBtn.addEventListener("click", () => {
    const sorted = sortInsuranceRows(
      lastRows,
      insuranceSort.key,
      insuranceSort.dir
    );
    if (!sorted.length) {
      toast(t("noData"), "error");
      return;
    }
    try {
      downloadInsurancesXlsx(sorted, dateInput.value, canSeePrice);
    } catch (err) {
      toast(`${t("exportFailed")}: ${err.message}`, "error");
    }
  });

  Content.replaceChildren(
    el("h2", t(titleKey)),
    form,
    searchStatus,
    result
  );
  // Re-render the search the tab was left with (filters are already in the
  // form): its rows, order and total come back without another request.
  if (hasSearched) renderResults();
}

// Shorthand for a stored duration (in days) used in the Excel export:
// 15 -> "15D", 30 -> "1M", 90 -> "3M". Any other value (e.g. a legacy 365)
// is exported as-is so no information is dropped; empty becomes a blank cell.
function insuranceDurationLabel(duration) {
  if (duration === undefined || duration === null || duration === "") return "";
  const days = Number(duration);
  if (Number.isFinite(days)) {
    if (days === 15) return "15D";
    if (days === 30) return "1M";
    if (days === 90) return "3M";
  }
  return String(duration);
}

// ---------------------------------------------------------------------------
// Insurance lookup -> Excel export
//
// Columns mirror the result table (row number included). Prices are written
// as real numbers (0.00 format) and creation dates as real Excel date/times,
// so the sheet can be summed, filtered and sorted in Excel.
//
// `canSeePrice` (optional) is the caller's price-visibility predicate: admins
// omit it and export every price, workers pass the same predicate the table
// uses so broker (email) prices they must not see become blank cells.
// ---------------------------------------------------------------------------
function insuranceExportSheet(rows, canSeePrice) {
  const columns = [
    { label: t("rowNo"), width: 6 },
    { label: t("blankNo"), width: 14 },
    { label: t("policyNumber"), width: 18 },
    { label: t("carNumber"), width: 14 },
    { label: t("add.duration"), width: 9 },
    { label: t("price"), width: 10 },
    { label: t("currency"), width: 9 },
    { label: t("payment"), width: 14 },
    { label: t("broker"), width: 20 },
    { label: t("brokerIdFilter"), width: 8 },
    { label: t("author"), width: 14 },
    { label: t("created"), width: 17 },
    { label: t("status"), width: 12 },
  ];
  const text = (v) => (v === undefined || v === null ? "" : String(v));
  const body = (rows || []).map((r, idx) => {
    const price = insuranceExportPrice(r);
    const showPrice = !canSeePrice || canSeePrice(r);
    // Same parsing as the display/sort (local wall-clock time).
    const ms = insuranceSortValue(r, "CreationDate");
    const serial = ms === null ? null : xlsxDateSerial(new Date(ms));
    return [
      idx + 1,
      text(r.BlancNumber),
      text(r.PolicyNumber),
      text(r.CarNumber),
      insuranceDurationLabel(r.Duration),
      showPrice && Number.isFinite(price)
        ? { value: price, style: "money" }
        : "",
      text(r.CurrencyType),
      paymentLabel(r.PaymentType),
      text(r.Broker),
      text(r.BrokerCode),
      text(r.Author),
      serial !== null
        ? { value: serial, style: "date" }
        : text(r.CreationDate),
      insuranceStatusLabel(r),
    ];
  });
  return { columns, rows: body };
}

function downloadInsurancesXlsx(rows, date, canSeePrice) {
  const sheet = insuranceExportSheet(rows, canSeePrice);
  const bytes = buildXlsxFile({
    sheetName: t("nav.insurances"),
    columns: sheet.columns,
    rows: sheet.rows,
  });
  const now = new Date();
  const p = (n) => String(n).padStart(2, "0");
  const stamp =
    date ||
    `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
  const blob = new Blob([bytes], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  const url = URL.createObjectURL(blob);
  const a = el("a", "download");
  a.href = url;
  a.download = `insurances_${stamp}.xlsx`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------------------
// Reconcile daily report (admin)
//
// Reads an Excel (.xlsx/.xlsm/...) daily report and compares each row with the insurance table:
//   [НОМЕР НА ПОЛИЦА] / [№ ПОЛИЦА] / [Policy number] -> PolicyNumber
//   [НОМЕР НА СТИКЕР] / [№ БЛАНКА] / [Blanc Number]  -> BlancNumber
//   [ВАЛИДЕН ОТ] / [ДАТА]                           -> StartDate
//   [ВАЛИДЕН ДО] / [СРОК]                           -> StartDate + Duration (days)
//   [ДКН] / [Car number] / [Plate number]           -> CarNumber
//   [СРОК] / [SROK] / [Duration]                    -> Duration (15D = 15 days, 3M = 3 months)
//   [ЦЕНА] / [Price] / [ТАРИФА] / [Tarifa]          -> Price (amount only - the currency type is not compared)
// (English is accepted for the policy / sticker / car / duration / price
// columns; see the full list in RECON_COLUMNS, reconcile-core.js.)
//
// Two report layouts are supported, since daily reports in the field use a
// shorter header set than the one originally designed here:
//   - Full layout: explicit "ВАЛИДЕН ОТ" / "ВАЛИДЕН ДО" date columns.
//   - Shift-log layout (e.g. "FINANSOV OTCHET" files): a single "ДАТА" column
//     plus a "СРОК" (term) column holding a shorthand like "15D"/"1M"/"3M",
//     from which the valid-until date is derived.
//
// Duration and price are compared when the report has their column; a file
// without them still reconciles the rest (the missing field is reported as not
// compared instead of flagging every row).
//
// The columns the file must contain follow the compare buttons: only a field
// whose button is ticked is required, so unticking a field lets a report that
// does not print its column reconcile the remaining ones (reconRequiredColumns
// in reconcile-core.js).
//
// The report is checked against one day or a range of days (two date inputs)
// and, when a broker name is typed, only against that broker's insurances; an
// empty broker checks every insurer.
//
// The pure helpers used here (RECON_COLUMNS, RECON_TERM_COLUMN,
// reconFindColumns, reconParseFileRows, reconCompareRow, reconDbValues, and the
// recon* normalisation/date helpers) live in reconcile-core.js, loaded before
// this file so they can be unit-tested in Node without the DOM.
//
// `options`:
//   creationFrom / creationTo - the day (or range of days) the report covers.
//     Insurances created in it that no file row matched are listed as missing
//     from the file. Clearing both dates switches that check off.
//   broker - only the policies of this broker are checked. The name is matched
//     like the lookup's Broker field: partially and insensitive to the
//     Cyrillic/Latin script of the stored name (brokerNameMatches). Empty
//     means every broker.
//   compareFields - which columns are compared (see RECON_COMPARE_FIELDS).
//     Only the ticked fields are required in the file; an unticked one may be
//     missing from the report entirely.
// ---------------------------------------------------------------------------

async function reconcileReport(rows, options) {
  const { creationFrom, creationTo, broker, compareFields } = options || {};
  const cols = reconFindColumns(rows, compareFields);
  if (cols.missing.length) {
    throw new Error(
      `${t("reconcile.columnsNotFound")}: ${cols.missing
        .map((c) => `[${c.header}]`)
        .join(", ")}`
    );
  }
  const fileRows = reconParseFileRows(rows, cols.headerRow, cols.index);
  // The columns this file actually has. The optional ones (duration, price)
  // are not compared when the report does not print them.
  const fileFields = reconFileFields(cols.index);

  // Which fields the user wants checked. Everything is compared unless some
  // fields were switched off in the toggle row (the choice is stored in
  // localStorage).
  const compared = reconParseCompareFields(compareFields);

  const data = await api("/admin/insurances");
  let insurances = data.insurances || [];

  // A typed broker narrows the whole reconciliation - both the rows the file
  // is matched against and the "missing from file" list - to that broker's
  // policies. The server stores the broker's name on each policy, including
  // the walk-in (branch) ones, so the same name match as the lookup is enough.
  const brokerQuery = String(broker ?? "").trim();
  if (brokerQuery) {
    insurances = insurances.filter((ins) =>
      brokerNameMatches(ins.Broker, brokerQuery)
    );
  }

  const byPolicy = new Map();
  const byBlank = new Map();
  const addTo = (map, key, ins) => {
    if (!key) return;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(ins);
  };
  for (const ins of insurances) {
    addTo(byPolicy, reconNormPolicy(ins.PolicyNumber), ins);
    addTo(byBlank, reconNormId(ins.BlancNumber), ins);
  }

  const matchedInsurances = new Set();
  const missingFromDb = [];
  const mismatches = [];
  let matched = 0;

  for (const fileRow of fileRows) {
    const candidates = new Set([
      ...(byPolicy.get(reconNormPolicy(fileRow.policy)) || []),
      ...(byBlank.get(reconNormId(fileRow.blank)) || []),
    ]);

    if (candidates.size === 0) {
      missingFromDb.push(fileRow);
      continue;
    }

    let best = null;
    for (const ins of candidates) {
      const cmp = reconCompareRow(fileRow, ins, compared, fileFields);
      if (!best || cmp.count < best.cmp.count) best = { ins, cmp };
    }
    matchedInsurances.add(best.ins);
    if (best.cmp.count === 0) matched++;
    else mismatches.push({ rowNo: fileRow.rowNo, ...best.cmp.fields });
  }

  // Insurances that should have appeared in the report but did not: created in
  // the chosen day/range and never matched by a file row. An empty range
  // matches nothing, so the list stays empty and the check is skipped.
  const range = reconDateRange(creationFrom, creationTo);
  const missingFromFile = insurances.filter(
    (ins) =>
      !matchedInsurances.has(ins) && reconDateInRange(ins.CreationDate, range)
  );

  return {
    fileRowCount: fileRows.length,
    matched,
    missingFromDb,
    missingFromFile,
    mismatches,
    // The range and broker actually used (a reversed pair is reported in the
    // order it was applied), so the tab can put them back into its fields.
    creationFrom: range.from,
    creationTo: range.to,
    broker: brokerQuery,
    // Kept with the result so the screen can say what was not checked (and
    // dim those columns) even when the report is restored from the cache.
    compareFields: compared,
    // Same, for the columns the file did not have at all.
    fileFields,
  };
}

function reconRenderResults(result) {
  const wrap = el("div", null, { class: "recon-results" });

  // One scroll target per summary card. Each table lives in its own section so
  // the card can jump straight to the rows it counts; the sticky page header
  // would otherwise cover the heading (see .recon-section in WorkPage.css).
  const missingDbSection = el("div", null, {
    class: "recon-section",
    id: "recon-missing-db",
  });
  const missingFileSection = el("div", null, {
    class: "recon-section",
    id: "recon-missing-file",
  });
  const mismatchSection = el("div", null, {
    class: "recon-section",
    id: "recon-mismatches",
  });

  const scrollTo = (target) => {
    if (target && typeof target.scrollIntoView === "function") {
      target.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  };

  const stats = el("div", null, { class: "stat-grid" });
  const addStat = (label, value, cls, target) => {
    const card = el("div", null, { class: `stat-card ${cls || ""}`.trim() });
    card.appendChild(el("h3", label));
    card.appendChild(el("p", String(value), { class: "big" }));
    if (target) {
      // Cards with a table are navigation, exactly like the Current cash
      // balance cards: click or Enter/Space jumps to that table.
      card.classList.add("clickable");
      card.tabIndex = 0;
      card.setAttribute("role", "button");
      card.title = t("reconcile.cardHint");
      card.addEventListener("click", () => scrollTo(target));
      card.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        scrollTo(target);
      });
    }
    stats.appendChild(card);
  };
  addStat(t("reconcile.fileRows"), result.fileRowCount);
  addStat(
    t("reconcile.matched"),
    result.matched,
    result.matched ? "recon-good" : ""
  );
  addStat(
    t("reconcile.missingFromDb"),
    result.missingFromDb.length,
    result.missingFromDb.length ? "recon-bad" : "",
    missingDbSection
  );
  addStat(
    t("reconcile.missingFromFile"),
    result.missingFromFile.length,
    result.missingFromFile.length ? "recon-bad" : "",
    missingFileSection
  );
  addStat(
    t("reconcile.mismatches"),
    result.mismatches.length,
    result.mismatches.length ? "recon-warn" : "",
    mismatchSection
  );
  wrap.appendChild(stats);

  // A green "everything matches" must not hide the fact that some fields were
  // switched off (or are not in the file), so the ignored ones are named right
  // under the summary.
  const ignoredLabels = RECON_COLUMNS.filter(
    (c) =>
      !reconIsCompareFieldChecked(
        result.compareFields,
        result.fileFields,
        c.key
      )
  ).map((c) => t(c.label));
  if (ignoredLabels.length > 0) {
    wrap.appendChild(
      el("p", `${t("reconcile.notCompared")}: ${ignoredLabels.join(", ")}`, {
        class: "muted recon-ignored",
      })
    );
  }

  const buildSection = (section, title, items, columns, rowClass) => {
    section.appendChild(el("h3", `${title} (${items.length})`));
    section.appendChild(renderTable(items, columns, null, rowClass));
  };

  // --- Policies in the file that the database does not have ---------------
  const missingDbRows = result.missingFromDb.map((r) => ({
    rowNo: r.rowNo,
    policy: r.policy,
    blank: r.blank,
    from: r.fromKey ? reconShowDate(r.fromKey) : r.fromRaw,
    to: r.toKey ? reconShowDate(r.toKey) : r.toRaw,
    car: r.car,
    duration: r.durationRaw || reconShowDuration(r.durationDays),
    price: reconShowPrice(r.priceRaw),
  }));
  buildSection(
    missingDbSection,
    t("reconcile.missingFromDb"),
    missingDbRows,
    [
      { key: "rowNo", label: t("reconcile.row") },
      ...RECON_COLUMNS.map((c) => ({ key: c.key, label: t(c.label) })),
    ],
    () => "row-missing"
  );

  // --- Insurances in the database that the file does not list -------------
  const missingFileRows = result.missingFromFile.map((ins) => {
    const db = reconDbValues(ins);
    return {
      policy: db.policy,
      blank: db.blank,
      from: reconShowDate(db.fromKey),
      to: reconShowDate(db.toKey),
      car: db.car,
      duration: reconShowDuration(db.durationDays),
      price: reconShowPrice(db.price),
    };
  });
  buildSection(
    missingFileSection,
    t("reconcile.missingFromFile"),
    missingFileRows,
    RECON_COLUMNS.map((c) => ({ key: c.key, label: t(c.label) })),
    () => "row-missing"
  );

  // --- Partial data mismatches (mismatching cells in dark red) ------------
  // A field switched off in the compare toggles - or whose column the file does
  // not have - is shown for reference but never highlighted and never annotated
  // as a difference, even when the report on screen was computed while the
  // field was still compared.
  const mismatchCol = (col) => {
    const off = !reconIsCompareFieldChecked(
      result.compareFields,
      result.fileFields,
      col.key
    );
    return {
      key: col.key,
      label: t(col.label),
      format: (v) => {
        const cell = v || {};
        return cell.mismatch && !off
          ? `${t("reconcile.fileValue")}: ${cell.file || "—"}\n${t(
              "reconcile.dbValue"
            )}: ${cell.db || "—"}`
          : cell.file;
      },
      cellClass: (item) => {
        const cell = item[col.key] || {};
        if (off || cell.ignored) return "cell-ignored";
        return cell.mismatch ? "cell-mismatch" : "";
      },
    };
  };
  buildSection(
    mismatchSection,
    t("reconcile.mismatches"),
    result.mismatches,
    [
      { key: "rowNo", label: t("reconcile.row") },
      ...RECON_COLUMNS.map(mismatchCol),
    ]
  );

  wrap.appendChild(missingDbSection);
  wrap.appendChild(missingFileSection);
  wrap.appendChild(mismatchSection);

  if (
    !missingDbRows.length &&
    !missingFileRows.length &&
    !result.mismatches.length &&
    result.fileRowCount > 0
  ) {
    wrap.appendChild(
      el("p", t("reconcile.allGood"), { class: "recon-good-text" })
    );
  }
  return wrap;
}

// The last reconciled report, kept in memory. The Reconcile tab is rebuilt on
// every nav switch; without this the spreadsheet would be parsed and the whole
// insurance list fetched again just to show the same result. The chosen File is
// kept too, so Run still works after coming back. Nothing is written to disk:
// the cache lives only as long as this dashboard window, and a newly chosen
// file invalidates it until Run is pressed again.
let reconcileCache = null;

// The compare-field choice lives in localStorage, so it is asked once: the next
// time the dashboard opens (a restart, a logout/login on the same machine) the
// same fields are already ticked. An unreadable value means "compare
// everything" - see reconParseCompareFields.
function loadReconcileCompareFields() {
  let raw = null;
  try {
    raw = localStorage.getItem(RECON_COMPARE_STORAGE_KEY);
  } catch (err) {
    console.warn("Failed to read the reconcile compare fields:", err);
  }
  return reconParseCompareFields(raw);
}

function saveReconcileCompareFields(fields) {
  try {
    localStorage.setItem(RECON_COMPARE_STORAGE_KEY, JSON.stringify(fields));
  } catch (err) {
    console.warn("Failed to store the reconcile compare fields:", err);
  }
}

// "Columns the daily report must have": a collapsed help block on the tab, so
// the rules are readable in the client instead of living in a code comment.
// The rows come from reconHintRows(), i.e. from the same constants the parser
// uses, and the prose comes from the translations.
function reconColumnHint() {
  const details = el("details", null, {
    class: "collapsible-section recon-hint",
  });
  details.appendChild(el("summary", t("reconcile.hintTitle")));

  const body = el("div", null, { class: "collapsible-body" });
  body.appendChild(el("p", t("reconcile.hintIntro"), { class: "muted" }));
  body.appendChild(el("p", t("reconcile.hintRequired"), { class: "muted" }));

  const table = el("table", null, { class: "recon-hint-table" });
  const thead = el("thead");
  const headRow = el("tr");
  headRow.appendChild(el("th", t("reconcile.hintField")));
  headRow.appendChild(el("th", t("reconcile.hintHeaders")));
  headRow.appendChild(el("th", t("reconcile.hintComparedWith")));
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = el("tbody");
  for (const row of reconHintRows()) {
    const tr = el("tr");
    tr.appendChild(el("td", t(row.label)));
    tr.appendChild(el("td", row.headers.join(", ")));
    tr.appendChild(el("td", row.source, { class: "muted" }));
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  body.appendChild(table);

  body.appendChild(el("p", t("reconcile.hintLayouts"), { class: "muted" }));
  body.appendChild(el("p", t("reconcile.hintTerms"), { class: "muted" }));
  body.appendChild(el("p", t("reconcile.hintDates"), { class: "muted" }));
  details.appendChild(body);
  return details;
}

// A small "thinking" indicator shown instead of the results while the report
// is parsed and compared: a big spreadsheet takes a moment, and a frozen
// screen would look like a failed run. Three dots bounce in turn next to the
// loading text, which is announced through the live region.
function reconLoadingIndicator() {
  const wrap = el("div", null, { class: "recon-loading", role: "status" });
  wrap.setAttribute("aria-live", "polite");
  const dots = el("span", null, { class: "recon-loading-dots" });
  dots.setAttribute("aria-hidden", "true");
  for (let i = 0; i < 3; i++) dots.appendChild(el("span"));
  wrap.appendChild(dots);
  wrap.appendChild(el("span", t("loading"), { class: "recon-loading-text" }));
  return wrap;
}

// One toggle button per compared field. Switching a field off only stops its
// differences from counting - the rows are still matched by policy / blank
// number exactly as before.
//
// These are real <button> elements, not checkboxes: the whole pill is the hit
// area and the on/off state is carried by aria-pressed (so screen readers and
// the keyboard get a toggle button) plus the .is-on class the stylesheet
// animates. Clicking one pops the pill briefly and cross-fades the tick, so the
// click is acknowledged even when the recomputed report looks the same.
function reconCompareToggles(compareFields, onChange) {
  const wrap = el("div", null, { class: "recon-toggles" });
  wrap.appendChild(
    el("span", t("reconcile.compareFields"), { class: "recon-toggles-label" })
  );
  // The current choice is tracked here too, so flipping one button after another
  // builds on the previous flip instead of on the set the row started with.
  let current = reconParseCompareFields(compareFields);
  const buttons = new Map();

  // Paints the on/off state without animating, so restoring a stored choice
  // (syncFields) cannot look like a click.
  const paint = (btn, on) => {
    btn.setAttribute("aria-pressed", on ? "true" : "false");
    btn.classList.toggle("is-on", on);
  };

  // Restarts the pop keyframe (WorkPage.css) on every click. Removing the class
  // and reading offsetWidth forces a reflow; without it a second click during
  // the 260ms animation would not replay it.
  const pulse = (btn) => {
    btn.classList.remove("is-clicked");
    void btn.offsetWidth;
    btn.classList.add("is-clicked");
  };

  for (const col of RECON_COLUMNS) {
    const btn = el("button", null, { class: "recon-toggle", type: "button" });
    btn.setAttribute("data-field", col.key);
    btn.title = t("reconcile.compareToggleHint");
    // Decorative only: the text next to it already names the field and
    // aria-pressed already says whether it is on.
    const tick = el("span", "\u2713", { class: "recon-toggle-tick" });
    tick.setAttribute("aria-hidden", "true");
    btn.appendChild(tick);
    btn.appendChild(el("span", t(col.label), { class: "recon-toggle-text" }));
    paint(btn, current.includes(col.key));
    btn.addEventListener("click", () => {
      // Clicking flips the state: the button is its own indicator, so the new
      // value cannot be read off a stale box.
      const on = !current.includes(col.key);
      current = reconToggleCompareField(current, col.key, on);
      paint(btn, on);
      pulse(btn);
      onChange(current);
    });
    buttons.set(col.key, btn);
    wrap.appendChild(btn);
  }
  // Lets the view put the buttons back in step with the stored choice.
  wrap.syncFields = (fields) => {
    current = reconParseCompareFields(fields);
    for (const [key, btn] of buttons) paint(btn, current.includes(key));
  };
  return wrap;
}

async function reconcileView() {
  let selectedFile = reconcileCache ? reconcileCache.file : null;
  // Remembered across sessions (see loadReconcileCompareFields).
  let compareFields = loadReconcileCompareFields();

  const fileInput = el("input", null, { type: "file" });
  fileInput.accept =
    ".xlsx,.xlsm,.xltx,.xltm,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel.sheet.macroEnabled.12,application/vnd.openxmlformats-officedocument.spreadsheetml.template,application/vnd.ms-excel.template.macroEnabled.12";
  fileInput.classList.add("hidden");

  const dropZone = el("div", null, { class: "drop-zone", tabindex: "0" });
  dropZone.appendChild(el("strong", t("reconcile.dropHint")));
  dropZone.appendChild(
    el("span", t("reconcile.dropHint2"), { class: "muted" })
  );
  const fileName = el(
    "span",
    reconcileCache ? reconcileCache.fileName : t("reconcile.noFile"),
    { class: "muted" }
  );
  dropZone.appendChild(fileName);
  if (reconcileCache) dropZone.classList.add("has-file");

  // A successful pick flashes the drag-and-drop field itself, so the upload is
  // noticed even before the new file name is read. Only a valid file triggers
  // it (essentially the drop zone's own confirmation). The class is removed
  // once the animation has played so the next upload replays it.
  let dropNoticeTimer = 0;
  function noticeDropZone() {
    dropZone.classList.remove("drop-accepted");
    // Reading offsetWidth restarts the animation when the class was just
    // removed, the same trick markEmailRevived uses.
    void dropZone.offsetWidth;
    dropZone.classList.add("drop-accepted");
    clearTimeout(dropNoticeTimer);
    dropNoticeTimer = setTimeout(() => {
      dropZone.classList.remove("drop-accepted");
    }, 800);
  }

  const setFile = (file) => {
    if (!file) return;
    if (!/\.(xlsx|xlsm|xltx|xltm)$/i.test(file.name)) {
      toast(t("reconcile.invalidFile"), "error");
      return;
    }
    // A different file has not been reconciled yet: drop the old result so it
    // is never mistaken for this file's report.
    if (!reconcileCache || reconcileCache.file !== file) {
      reconcileCache = null;
      result.replaceChildren();
    }
    selectedFile = file;
    fileName.textContent = file.name;
    dropZone.classList.add("has-file");
    noticeDropZone();
  };

  dropZone.addEventListener("click", () => fileInput.click());
  dropZone.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      fileInput.click();
    }
  });
  fileInput.addEventListener("change", () => setFile(fileInput.files[0]));
  ["dragenter", "dragover"].forEach((evt) =>
    dropZone.addEventListener(evt, (e) => {
      e.preventDefault();
      dropZone.classList.add("drag-over");
    })
  );
  ["dragleave", "drop"].forEach((evt) =>
    dropZone.addEventListener(evt, (e) => {
      e.preventDefault();
      dropZone.classList.remove("drag-over");
    })
  );
  dropZone.addEventListener("drop", (e) => {
    setFile(e.dataTransfer && e.dataTransfer.files[0]);
  });

  const today = new Date();
  const todayString = `${today.getFullYear()}-${reconPad(
    today.getMonth() + 1
  )}-${reconPad(today.getDate())}`;
  // Restore the date range and broker the cached report was run for, so the
  // fields and the report on screen always agree. Both dates default to today
  // (a one-day report); widening the range is just changing the first date.
  const fromInput = input(
    "date",
    reconcileCache ? reconcileCache.creationFrom : todayString
  );
  const toInput = input(
    "date",
    reconcileCache ? reconcileCache.creationTo : todayString
  );
  const brokerInput = input(
    "text",
    reconcileCache ? reconcileCache.broker : ""
  );

  const runBtn = el("button", t("reconcile.run"), { type: "button" });
  const controls = el("div", null, { class: "row filter-row" });
  controls.appendChild(field(t("reconcile.dbDate"), fromInput));
  controls.appendChild(field(t("reconcile.dbDateTo"), toInput));
  controls.appendChild(field(t("broker"), brokerInput));
  controls.appendChild(runBtn);

  // The Broker field suggests the same names as the lookup's Broker field (see
  // adminInsurancesByDate), including the ones that only survive on old
  // policies, and matches them the same way. Attached after the input sits in
  // its .field wrapper, which the dropdown is positioned against.
  const brokerAutocomplete = attachAutocomplete(
    brokerInput,
    () =>
      currentInsuranceSuggestions().brokers.map((b) => ({
        value: b.Name,
        hint: b.Code ? `${t("brokerIdFilter")} ${b.Code}` : "",
      })),
    (item, query) =>
      brokerRowMatchesNameFilter(item.value, query) ||
      !query ||
      String(item.hint || "")
        .toLowerCase()
        .includes(query.toLowerCase())
  );
  loadInsuranceFilterSuggestions().then(() => brokerAutocomplete.refresh());

  const result = el("div");
  // Coming back to the tab shows the previous report immediately, without
  // reading the file again or fetching the insurance list.
  if (reconcileCache && reconcileCache.report) {
    result.appendChild(reconRenderResults(reconcileCache.report));
  }

  // Runs the selected file through the full pipeline: parse the first sheet,
  // reconcile against the database and render the comparison.
  const runReconcile = async (file, btn) => {
    btn.disabled = true;
    btn.setAttribute("aria-busy", "true");
    result.replaceChildren(reconLoadingIndicator());
    try {
      const sheetRows = await readXlsxFirstSheet(await file.arrayBuffer());
      const report = await reconcileReport(sheetRows, {
        creationFrom: fromInput.value,
        creationTo: toInput.value,
        broker: brokerInput.value.trim(),
        compareFields,
      });
      // Keep the successful result (and the File that produced it) so a tab
      // switch can restore it without reading the spreadsheet again.
      reconcileCache = {
        file,
        fileName: file.name,
        creationFrom: fromInput.value,
        creationTo: toInput.value,
        broker: brokerInput.value.trim(),
        report,
      };
      result.replaceChildren(reconRenderResults(report));
    } catch (err) {
      result.replaceChildren();
      toast(err.message, "error");
    } finally {
      btn.disabled = false;
      btn.removeAttribute("aria-busy");
    }
  };

  runBtn.addEventListener("click", async () => {
    brokerAutocomplete.close();
    if (!selectedFile) {
      toast(t("reconcile.noFile"), "error");
      return;
    }
    await runReconcile(selectedFile, runBtn);
  });

  // The compare toggle buttons, restored from localStorage. Flipping one is
  // saved immediately; if a report is already on screen it is recomputed, so the
  // figures and the highlights never disagree with the toggles.
  const compareToggles = reconCompareToggles(compareFields, (next) => {
    compareFields = next;
    saveReconcileCompareFields(compareFields);
    compareToggles.syncFields(compareFields);
    if (selectedFile && reconcileCache) runReconcile(selectedFile, runBtn);
  });

  Content.replaceChildren(
    el("h2", t("reconcile.title")),
    reconColumnHint(),
    dropZone,
    fileInput,
    controls,
    compareToggles,
    el(
      "p",
      `${t("reconcile.dbDateHint")} ${t("reconcile.brokerHint")} ${t(
        "reconcile.endNote"
      )}`,
      { class: "muted" }
    ),
    result
  );
}

// ---------------------------------------------------------------------------
// Worker views
// ---------------------------------------------------------------------------
// The dashboard view shared by admins and workers: the unread email cards they
// can claim and work. Admins used to get a branch overview here, but it held no
// useful data, so they now get the same cards and can step in when needed.
async function emailCardsView() {
  Content.replaceChildren(...emailCardsDashboard());
}

async function workerClients() {
  const data = await api("/worker/clients");
  const table = renderTable(
    data.clients,
    [
      { key: "Username", label: t("username") },
      { key: "Balance", label: t("balance"), format: (v) => money(v) },
    ],
    [
      {
        label: t("setBalance"),
        class: "",
        onClick: (c) => {
          const form = buildForm(
            [
              {
                key: "balance",
                label: t("balance"),
                type: "number",
                value: c.Balance,
              },
            ],
            async (payload) => {
              await api("/worker/clients/balance", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  username: c.Username,
                  balance: payload.balance,
                }),
              });
              toast(t("balanceUpdated"), "success");
              closeModal();
              workerClients();
            },
            t("save")
          );
          openModal(`${t("setBalanceFor")} ${c.Username}`, form);
        },
      },
    ]
  );
  Content.replaceChildren(el("h2", t("clients")), table);
}

async function workerInsurances() {
  // Workers can view and modify every policy (not just their own), so the
  // author filter is left empty exactly like in the admin view.
  await adminInsurancesByDate("", "nav.insurances");
}

// ---------------------------------------------------------------------------
// Client views
// ---------------------------------------------------------------------------
async function clientProfile() {
  const data = await api("/client/profile");
  const p = data.profile || {};
  const card = el("div", null, { class: "stat-grid" });
  const c1 = el("div", null, { class: "stat-card" });
  c1.appendChild(el("h3", t("username")));
  c1.appendChild(el("p", p.Username || username, { class: "big" }));
  const c2 = el("div", null, { class: "stat-card" });
  c2.appendChild(el("h3", t("balance")));
  c2.appendChild(el("p", money(p.Balance), { class: "big" }));
  card.appendChild(c1);
  card.appendChild(c2);
  Content.replaceChildren(el("h2", t("myProfile")), card);
}

async function clientInsurances() {
  const data = await api("/client/insurances");
  const table = renderTable(
    data.insurances,
    [
      { key: "BlancNumber", label: t("blankNo") },
      { key: "PolicyNumber", label: t("policyNumber") },
      { key: "CurrencyType", label: t("currency") },
      { key: "PaymentType", label: t("payment"), format: paymentLabel },
      {
        key: "CreationDate",
        label: t("created"),
        format: (v) => formatDateTime(v),
      },
      {
        key: "Annulled",
        label: t("status"),
        format: (v) => (v ? t("annulled") : ""),
      },
    ],
    null,
    (i) => annulledRowClass(i)
  );
  Content.replaceChildren(el("h2", t("myInsurances")), table);
}

// ---------------------------------------------------------------------------
// Admin: client diagnostics
//
// Every PC records the failed requests it sees (403 first) plus the first
// successful request after a 403, and uploads them to the server when it can
// reach it again. This view lists what the server has stored (nothing is
// pruned; Delete all is the explicit cleanup), shows one report in full, and
// pairs it with the server's own view of a request (IP resolution,
// X-Forwarded-For, auth/CORS policy, busiest paths) so "blocked before the
// server" can be told apart from "rejected by the app".
// ---------------------------------------------------------------------------
let diagStatusFilter = "";

function diagClientLabel(report) {
  const env = (report && report.Env) || {};
  const host = env.hostname || "";
  const user =
    report.Username || (env.renderer && env.renderer.username) || "";
  const id = String(report.ClientId || env.clientId || "").slice(0, 8);
  const parts = [host || (id ? `#${id}` : "")];
  if (user && user !== host) parts.push(user);
  return parts.filter(Boolean).join(" · ") || "—";
}

function diagDetailsNode(report) {
  const wrap = el("div");
  const summary = el("div", null, { class: "stat-grid" });
  const card = (label, value) => {
    const box = el("div", null, { class: "stat-card" });
    box.appendChild(el("h3", label));
    box.appendChild(
      el(
        "p",
        value === null || value === undefined || value === "" ? "—" : String(value)
      )
    );
    summary.appendChild(box);
  };
  card(t("diag.status"), report.Status);
  card(t("diag.kind"), report.Kind);
  card(t("diag.requestId"), report.RequestId || "—");
  card(t("diag.uploadIp"), report.UploadIp || "—");
  wrap.appendChild(summary);

  if (report.PairId) {
    wrap.appendChild(
      el(
        "p",
        `${t("diag.paired")}: ${report.PairId}` +
          (report.SamePath ? "" : " (different path)"),
        { class: "muted" }
      )
    );
  }
  wrap.appendChild(
    el("p", `${report.Method || ""} ${report.Url || ""}`, { class: "muted" })
  );
  wrap.appendChild(
    el(
      "p",
      `${t("diag.captured")}: ${formatDateTime(
        report.CapturedAtText || report.CapturedAt
      )}` +
        (report.DurationMs !== null && report.DurationMs !== undefined
          ? ` · ${report.DurationMs} ms`
          : "") +
        (report.RepeatCount > 1 ? ` · ×${report.RepeatCount}` : ""),
      { class: "muted" }
    )
  );

  const pre = el("pre", JSON.stringify(report, null, 2), { class: "diag-json" });
  wrap.appendChild(pre);

  const copy = el("button", t("diag.copy"), {
    class: "secondary small",
    type: "button",
  });
  copy.addEventListener("click", () => {
    const text = JSON.stringify(report, null, 2);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(
        () => toast(t("diag.copied"), "success"),
        () => toast(t("diag.copied"), "error")
      );
    }
  });
  wrap.appendChild(copy);
  return wrap;
}


async function adminDiagnostics() {
  const title = el("h2", t("diag.title"));
  const hint = el("p", t("diag.hint"), { class: "muted" });
  const controls = el("div", null, { class: "row" });
  const summary = el("div", null, { class: "stat-grid" });
  const contextHost = el("div");
  const tableHost = el("div");
  const localHost = el("div");

  // The collection switch. It lives here, in the tab itself, and it is the one
  // control that stops the whole company's clients from being recorded: while it
  // is off the server answers every upload with "nothing stored", so the PCs
  // stop sending instead of retrying forever. Reports already stored stay
  // readable, and the switch is always reachable to turn gathering back on.
  const collectCard = el("div", null, { class: "balance-card diag-collect" });
  collectCard.appendChild(el("h3", t("diag.collect")));
  collectCard.appendChild(el("p", t("diag.collectHint"), { class: "muted" }));
  const collectToggleWrap = checkboxToggle(
    t("diag.collectToggle"),
    diagnosticsEnabled
  );
  const collectToggle = collectToggleWrap.input;
  const collectState = el("span", "", { class: "muted" });
  const syncCollectState = () => {
    collectState.textContent = collectToggle.checked
      ? t("diag.collectingOn")
      : t("diag.collectingOff");
  };
  syncCollectState();
  collectToggle.addEventListener("change", async () => {
    const wanted = collectToggle.checked;
    collectToggle.disabled = true;
    try {
      const data = await api("/admin/diagnostics/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: wanted }),
      });
      diagnosticsEnabled = !data || data.enabled !== false;
      collectToggle.checked = diagnosticsEnabled;
      toast(t("settingsSaved"), "success");
      // What has been gathered does not change by flipping the switch, so only
      // this PC's queue line may need a redraw.
      renderLocalQueue();
    } catch (err) {
      // Put the switch back where it was: nothing was saved.
      collectToggle.checked = !wanted;
      toast(err.message, "error");
    } finally {
      collectToggle.disabled = false;
      syncCollectState();
    }
  });
  const collectRow = el("div", null, { class: "row" });
  collectToggleWrap.title = t("diag.collectHint");
  collectRow.appendChild(collectToggleWrap);
  collectRow.appendChild(collectState);
  collectCard.appendChild(collectRow);
  // Show what the server is actually doing, not what this screen assumed: a
  // failed read leaves the default (gathering on).
  try {
    const settings = await api("/admin/diagnostics/settings");
    diagnosticsEnabled = !settings || settings.enabled !== false;
    collectToggle.checked = diagnosticsEnabled;
    syncCollectState();
  } catch (err) {
    // Keep the default; the switch still works when saving.
  }

  const statusSelect = select(
    [
      { value: "", label: t("diag.all") },
      { value: "403", label: t("diag.only403") },
      { value: "401", label: "401" },
      { value: "429", label: "429" },
      { value: "500", label: "500" },
    ],
    diagStatusFilter
  );
  statusSelect.addEventListener("change", () => {
    diagStatusFilter = statusSelect.value;
    load();
  });

  let latest = { reports: [], summary: {}, stored: 0 };
  let latestContext = null;

  const refreshButton = el("button", t("diag.refresh"), {
    class: "secondary",
    type: "button",
  });
  refreshButton.addEventListener("click", () => load());

  const downloadButton = el("button", t("diag.download"), {
    class: "secondary",
    type: "button",
  });
  downloadButton.addEventListener("click", () => {
    const payload = {
      exportedAt: new Date().toISOString(),
      summary: latest.summary,
      serverContext: latestContext,
      reports: latest.reports,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download =
      `client-diagnostics-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  });

  const clearButton = el("button", t("diag.clear"), {
    class: "danger",
    type: "button",
  });
  clearButton.addEventListener("click", async () => {
    const confirmed = await appConfirm(t("diag.clearConfirm"), {
      danger: true,
      confirmLabel: t("delete"),
    });
    if (!confirmed) return;
    try {
      const result = await api("/admin/diagnostics", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ all: true }),
      });
      toast(
        t("diag.deleted").replace("{n}", String(result.deleted || 0)),
        "success"
      );
      load();
    } catch (err) {
      reportError("Failed to delete diagnostics", err);
    }
  });

  controls.appendChild(statusSelect);
  controls.appendChild(refreshButton);
  controls.appendChild(downloadButton);
  controls.appendChild(clearButton);

  async function renderLocalQueue() {
    localHost.replaceChildren();
    let info = null;
    try {
      if (window.Diag && typeof window.Diag.info === "function") {
        info = await window.Diag.info();
      }
    } catch {
      info = null;
    }
    const card = el("div", null, { class: "stat-card" });
    card.appendChild(el("h3", t("diag.localQueue")));
    if (!info) {
      card.appendChild(el("p", t("diag.noContext"), { class: "muted" }));
      localHost.appendChild(card);
      return;
    }
    card.appendChild(
      el(
        "p",
        `${info.queueLength}` +
          (info.clientId ? ` · #${String(info.clientId).slice(0, 8)}` : "") +
          (info.lastFlushError ? ` · ${info.lastFlushError}` : "") +
          // The server refuses to store anything while gathering is off; say so
          // here instead of leaving the admin wondering why uploads "succeed"
          // without adding rows.
          (info.collectionDisabled ? ` · ${t("diag.collectingOff")}` : "")
      )
    );
    if (info.queueLength) {
      const flush = el("button", t("diag.flushNow"), {
        class: "secondary small",
        type: "button",
      });
      flush.addEventListener("click", async () => {
        const result = await window.Diag.flush();
        toast(
          t("diag.flushed").replace("{n}", String(result.uploaded || 0)),
          result.skipped ? "info" : "success"
        );
        renderLocalQueue();
        load();
      });
      card.appendChild(flush);
    }
    localHost.appendChild(card);
  }


  function renderContext(context) {
    contextHost.replaceChildren();
    if (!context) {
      contextHost.appendChild(el("p", t("diag.noContext"), { class: "muted" }));
      return;
    }
    contextHost.appendChild(el("h3", t("diag.serverContext")));
    const grid = el("div", null, { class: "stat-grid" });

    const requestCard = el("div", null, { class: "stat-card" });
    requestCard.appendChild(el("h3", "Request"));
    requestCard.appendChild(
      el("div", `${t("diag.observedIp")}: ${context.request.ip || "—"}`, {
        class: "muted",
      })
    );
    requestCard.appendChild(
      el(
        "div",
        `${t("diag.forwardedFor")}: ${context.request.forwardedFor || "—"}`,
        { class: "muted" }
      )
    );
    requestCard.appendChild(
      el("div", `${t("diag.realIp")}: ${context.request.xRealIp || "—"}`, {
        class: "muted",
      })
    );
    requestCard.appendChild(
      el("div", `Origin: ${context.request.origin || "—"}`, { class: "muted" })
    );
    requestCard.appendChild(
      el("div", `Socket: ${context.request.socketRemoteAddress || "—"}`, {
        class: "muted",
      })
    );
    grid.appendChild(requestCard);

    const ac = context.accessControl || {};
    const policyCard = el("div", null, { class: "stat-card" });
    policyCard.appendChild(el("h3", "Access control"));
    policyCard.appendChild(
      el("div", `${t("diag.proxy")}: ${String(ac.trustProxy ?? "—")}`, {
        class: "muted",
      })
    );
    policyCard.appendChild(
      el("div", `${t("diag.ipAllowList")}: ${ac.ipAllowList || "—"}`, {
        class: "muted",
      })
    );
    policyCard.appendChild(
      el("div", `${t("diag.authPolicy")}: ${ac.authentication || "—"}`, {
        class: "muted",
      })
    );
    policyCard.appendChild(
      el("div", `${t("diag.rateLimits")}: ${JSON.stringify(ac.rateLimits || {})}`, {
        class: "muted",
      })
    );
    policyCard.appendChild(
      el("div", `CORS: ${JSON.stringify(ac.cors || {})}`, { class: "muted" })
    );
    grid.appendChild(policyCard);
    contextHost.appendChild(grid);

    const polling = (context.recent && context.recent.polling) || [];
    contextHost.appendChild(el("h3", t("diag.polling")));
    if (!polling.length) {
      contextHost.appendChild(el("p", t("noData"), { class: "muted" }));
    } else {
      contextHost.appendChild(
        renderTable(
          polling,
          [
            { key: "ip", label: t("diag.uploadIp") },
            { key: "method", label: "Method" },
            { key: "path", label: "Path" },
            { key: "requestsPerMinute", label: "/min" },
            { key: "lastStatus", label: t("diag.status") },
          ],
          null,
          (row) => (Number(row.requestsPerMinute) >= 30 ? "warn-row" : "")
        )
      );
    }

    const failures = (context.recent && context.recent.failures) || [];
    contextHost.appendChild(el("h3", t("diag.recentFailures")));
    if (!failures.length) {
      contextHost.appendChild(el("p", t("noData"), { class: "muted" }));
    } else {
      contextHost.appendChild(
        renderTable(
          failures.slice(-30).reverse(),
          [
            {
              key: "at",
              label: t("diag.captured"),
              format: (v) => formatDateTime(v),
            },
            { key: "method", label: "Method" },
            { key: "path", label: "Path" },
            { key: "status", label: t("diag.status") },
            { key: "ip", label: t("diag.uploadIp") },
            { key: "user", label: t("username") },
          ],
          null,
          () => ""
        )
      );
    }
  }


  function renderReports() {
    const reports = latest.reports || [];
    summary.replaceChildren();
    const stats = latest.summary || {};
    const card = (label, value) => {
      const box = el("div", null, { class: "stat-card" });
      box.appendChild(el("h3", label));
      box.appendChild(
        el("p", String(value === undefined || value === null ? 0 : value))
      );
      summary.appendChild(box);
    };
    card(t("diag.total"), stats.total || 0);
    card(t("diag.forbidden"), stats.forbidden || 0);
    card(t("diag.recoveries"), stats.recoveries || 0);
    card(t("diag.withRequestId"), stats.withRequestId || 0);
    card(t("diag.clients"), stats.clients || 0);

    tableHost.replaceChildren();
    if (!reports.length) {
      tableHost.appendChild(el("p", t("diag.empty"), { class: "muted" }));
      return;
    }
    tableHost.appendChild(
      renderTable(
        reports,
        [
          {
            key: "CapturedAtText",
            label: t("diag.captured"),
            format: (v, row) => v || row.CapturedAt || row.ReceivedAt || "",
          },
          {
            key: "ClientId",
            label: t("diag.client"),
            format: (v, row) => diagClientLabel(row),
          },
          { key: "Kind", label: t("diag.kind") },
          { key: "Status", label: t("diag.status") },
          {
            key: "Path",
            label: "Request",
            format: (v, row) => `${row.Method || ""} ${v || ""}`,
          },
          {
            key: "RequestId",
            label: t("diag.requestId"),
            format: (v) => (v ? String(v).slice(0, 12) : "—"),
          },
          { key: "UploadIp", label: t("diag.uploadIp") },
          { key: "RepeatCount", label: "×" },
        ],
        null,
        (row) => (Number(row.Status) === 403 ? "warn-row" : ""),
        (row) => openModal(t("diag.details"), diagDetailsNode(row))
      )
    );
  }

  async function load() {
    tableHost.replaceChildren(el("p", t("loading"), { class: "muted" }));
    try {
      const query =
        "/admin/diagnostics?limit=100" +
        (diagStatusFilter
          ? `&status=${encodeURIComponent(diagStatusFilter)}`
          : "");
      const [data, context] = await Promise.all([
        api(query),
        api("/admin/diagnostics/context").catch(() => null),
      ]);
      latest = data || { reports: [], summary: {} };
      latestContext = context;
      renderReports();
      renderContext(context);
    } catch (err) {
      tableHost.replaceChildren(
        el(
          "p",
          `${t("errorPrefix")}: ${translateError(
            err && err.message ? err.message : ""
          )}`,
          { class: "muted" }
        )
      );
    }
    renderLocalQueue();
  }

  Content.replaceChildren(
    title,
    hint,
    collectCard,
    summary,
    controls,
    tableHost,
    localHost,
    contextHost
  );
  await load();
}

// __DIAG_UI_END__
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Profits (admin)
//
// The Bulins prices and the per-policy profit are typed by an admin and kept
// ONLY on this computer (localStorage). Nothing here is ever sent to the
// server: the report is computed from the insurance rows the app already reads
// (/admin/insurances) plus these local inputs.
//
// Per counted policy (annulled and soft-deleted ones are left out):
//   Bulins payment = Bulins price (type + duration) - profit (type + duration)
//   Profit         = the policy's Price - Bulins payment
// so the report only describes money the company actually kept.
// ---------------------------------------------------------------------------
const PROFIT_SETTINGS_KEY = "profitSettings.v1";
// The report's vehicle types. "Other" collects every stored value the tariffs
// do not know (a legacy free-text type), and the "other" duration does the same
// for any duration that is not one of the three standard ones.
const PROFIT_TYPES = ["Auto", "Motor", "Bus", "Trailer", "Other"];
const PROFIT_DURATION_KEYS = ["15", "30", "90", "other"];

// The insurance rows are read once and reused while the tab is open; the
// Refresh button drops the cache so a policy sold in another window shows up.
const PROFIT_INSURANCE_TTL_MS = 2 * 60 * 1000;
let profitInsurancesCache = null;
let profitInsurancesCacheAt = 0;

// The local inputs and the period are kept outside the DOM, so switching tabs
// and coming back restores both.
let profitSettingsCache = null;
let profitPeriodState = null;
let profitSettingsOpen = null;
// True while the grids hold values the admin has not saved yet: typing only
// changes the working copy, Calculate is what saves it (and refreshes the
// report).
let profitSettingsDirty = false;

// Empty grid: one cell per vehicle type and duration. The values are the
// strings exactly as typed (an empty cell means "not filled in yet").
function profitEmptyGrid() {
  const grid = {};
  for (const type of PROFIT_TYPES) {
    grid[type] = {};
    for (const key of PROFIT_DURATION_KEYS) grid[type][key] = "";
  }
  return grid;
}

function profitDefaultSettings() {
  return {
    currency: "EUR",
    bulins: profitEmptyGrid(),
    profit: profitEmptyGrid(),
  };
}

// A number typed into a profit input, or a stored decimal price. Accepts a
// comma as the decimal separator and ignores spaces and a currency sign, so
// " 40,50 € " reads as 40.5. An empty or unreadable value is NaN, which is how
// "this cell was never filled in" is told apart from a real 0.
function profitNumber(value) {
  if (value === undefined || value === null) return NaN;
  const text = String(value).trim().replace(/[€\s]/g, "").replace(",", ".");
  if (!text) return NaN;
  const n = Number(text);
  return Number.isFinite(n) ? n : NaN;
}

function profitRound(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

function profitTypeLabel(type) {
  const key = {
    Auto: "vehicle.Automobile",
    Motor: "vehicle.Motor",
    Bus: "vehicle.Bus",
    Trailer: "vehicle.Trailer",
  }[type];
  return t(key || "profits.otherType");
}

function profitDurationLabel(key) {
  return key === "15" || key === "30" || key === "90"
    ? t(`duration.${key}`)
    : t("profits.otherDuration");
}

// Stored Otomobil value -> one of PROFIT_TYPES. Reuses the tariff mapping, so
// "Automobile", "Otomobil", "автомобил" and "Auto" all mean the same type.
function profitPolicyType(otomobil) {
  const key = pricingVehicleKey(otomobil);
  return key && PROFIT_TYPES.includes(key) ? key : "Other";
}

// Stored duration (days) -> grid column.
function profitDurationKey(duration) {
  const days = Number(duration);
  if (days === 15 || days === 30 || days === 90) return String(days);
  return "other";
}

// The calendar day of a stored DATETIME ("YYYY-MM-DD HH:mm:ss"), an ISO string
// or a Date. The day is read as it was written (the client's wall clock), like
// every other date in the app.
function profitDayOf(value) {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? "" : localDateString(value);
  }
  const match = String(value === undefined || value === null ? "" : value)
    .trim()
    .match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : "";
}

function profitLoadSettings() {
  const settings = profitDefaultSettings();
  let raw = null;
  try {
    raw = localStorage.getItem(PROFIT_SETTINGS_KEY);
  } catch {
    return settings;
  }
  if (!raw) return settings;
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return settings;
  }
  if (!parsed || typeof parsed !== "object") return settings;
  const currency = String(parsed.currency || "").toUpperCase();
  if (currency === "EUR" || currency === "TRY") settings.currency = currency;
  for (const table of ["bulins", "profit"]) {
    const source = parsed[table];
    if (!source || typeof source !== "object") continue;
    for (const type of PROFIT_TYPES) {
      const row = source[type];
      if (!row || typeof row !== "object") continue;
      for (const key of PROFIT_DURATION_KEYS) {
        if (row[key] === undefined || row[key] === null) continue;
        // Keep the typed text, so a comma typed by the admin stays visible.
        settings[table][type][key] = String(row[key]);
      }
    }
  }
  return settings;
}

// Store the inputs on this computer. They are never uploaded anywhere.
function profitSaveSettings(settings) {
  try {
    localStorage.setItem(PROFIT_SETTINGS_KEY, JSON.stringify(settings));
    return true;
  } catch (err) {
    console.error("Failed to save the profit inputs:", err);
    return false;
  }
}

function profitSettingsHasValues(settings) {
  if (!settings) return false;
  for (const table of ["bulins", "profit"]) {
    const grid = settings[table];
    if (!grid) continue;
    for (const type of PROFIT_TYPES) {
      const row = grid[type];
      if (!row) continue;
      for (const key of PROFIT_DURATION_KEYS) {
        if (String(row[key] === undefined ? "" : row[key]).trim() !== "") {
          return true;
        }
      }
    }
  }
  return false;
}

// One policy's contribution to the report.
function profitPolicyAmounts(policy, settings) {
  const price = profitNumber(policy ? policy.Price : "");
  const income = Number.isFinite(price) ? price : 0;
  const type = profitPolicyType(policy ? policy.Otomobil : "");
  const durationKey = profitDurationKey(policy ? policy.Duration : "");
  const cell = (table) => {
    const grid = settings ? settings[table] : null;
    const row = grid ? grid[type] : null;
    return row ? row[durationKey] : "";
  };
  const bulinsPrice = profitNumber(cell("bulins"));
  const profitShare = profitNumber(cell("profit"));
  const priced = Number.isFinite(bulinsPrice);
  // An unfilled Bulins price leaves the policy out of the Bulins payment (its
  // income is then counted as profit) and is reported as "unpriced".
  const bulins = priced
    ? bulinsPrice - (Number.isFinite(profitShare) ? profitShare : 0)
    : 0;
  return {
    type,
    durationKey,
    priced,
    income,
    bulins,
    profit: income - bulins,
  };
}

function profitEmptyTotals() {
  return { policies: 0, income: 0, bulins: 0, profit: 0, unpriced: 0 };
}

function profitAddTotals(totals, amounts) {
  totals.policies += 1;
  totals.income += amounts.income;
  totals.bulins += amounts.bulins;
  totals.profit += amounts.profit;
  if (!amounts.priced) totals.unpriced += 1;
  return totals;
}

function profitFinalTotals(totals) {
  return {
    policies: totals.policies,
    income: profitRound(totals.income),
    bulins: profitRound(totals.bulins),
    profit: profitRound(totals.profit),
    unpriced: totals.unpriced,
  };
}

// Bucket helper: one totals row per key (a day, a month, a type, a duration).
function profitBucket(map, key, amounts) {
  let bucket = map.get(key);
  if (!bucket) {
    bucket = profitEmptyTotals();
    map.set(key, bucket);
  }
  profitAddTotals(bucket, amounts);
  return bucket;
}

function profitBest(rows, key) {
  let best = null;
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!best || Number(row[key]) > Number(best[key])) best = row;
  }
  return best;
}

function profitMargin(profit, income) {
  const total = Number(income);
  if (!Number.isFinite(total) || total === 0) return "";
  const value = Math.round((Number(profit) / total) * 1000) / 10;
  return Number.isFinite(value) ? `${value}%` : "";
}

// The whole report for one period, computed in the browser from the insurance
// rows and the local inputs. Nothing is written back to the server.
function profitReport(insurances, settings, from, to) {
  const currency = String(
    settings && settings.currency ? settings.currency : "EUR"
  ).toUpperCase();
  const fromDay = profitDayOf(from);
  const toDay = profitDayOf(to) || fromDay;
  // The pickers always send From <= To, but a reversed pair is still read in
  // the order that describes a real period.
  const start = fromDay && toDay && fromDay > toDay ? toDay : fromDay;
  const end = fromDay && toDay && fromDay > toDay ? fromDay : toDay;

  const report = {
    currency,
    from: start,
    to: end,
    totals: profitEmptyTotals(),
    days: [],
    months: [],
    types: [],
    durations: [],
    bestDay: null,
    bestMonth: null,
    // Policies of the period in another currency: they are left out of every
    // figure above, so the view can say how many there are.
    otherCurrency: 0,
  };

  const dayBuckets = new Map();
  const monthBuckets = new Map();
  const typeBuckets = new Map();
  const durationBuckets = new Map();

  for (const policy of Array.isArray(insurances) ? insurances : []) {
    if (!policy) continue;
    // Deleted and annulled policies are not money the company kept.
    if (Number(policy.Deleted) === 1) continue;
    if (Number(policy.Annulled) === 1) continue;
    const day = profitDayOf(policy.CreationDate);
    if (!day) continue;
    if (start && day < start) continue;
    if (end && day > end) continue;
    const policyCurrency = String(policy.CurrencyType || "EUR").toUpperCase();
    if (policyCurrency !== currency) {
      report.otherCurrency += 1;
      continue;
    }

    const amounts = profitPolicyAmounts(policy, settings);
    profitAddTotals(report.totals, amounts);
    profitBucket(dayBuckets, day, amounts);
    profitBucket(monthBuckets, day.slice(0, 7), amounts);
    profitBucket(typeBuckets, amounts.type, amounts);
    profitBucket(durationBuckets, amounts.durationKey, amounts);
  }

  report.totals = profitFinalTotals(report.totals);
  report.days = Array.from(dayBuckets.keys())
    .sort()
    .map((date) => ({ date, ...profitFinalTotals(dayBuckets.get(date)) }));
  report.months = Array.from(monthBuckets.keys())
    .sort()
    .map((month) => ({ month, ...profitFinalTotals(monthBuckets.get(month)) }));
  report.types = PROFIT_TYPES.filter((type) => typeBuckets.has(type)).map(
    (type) => ({ type, ...profitFinalTotals(typeBuckets.get(type)) })
  );
  report.durations = PROFIT_DURATION_KEYS.filter((key) =>
    durationBuckets.has(key)
  ).map((key) => ({
    duration: key,
    ...profitFinalTotals(durationBuckets.get(key)),
  }));
  report.bestDay = profitBest(report.days, "profit");
  report.bestMonth = profitBest(report.months, "profit");
  return report;
}

// ---------------------------------------------------------------------------
// Profits: period helpers
// ---------------------------------------------------------------------------
function profitMonthStart(iso) {
  const day = profitDayOf(iso);
  return day ? `${day.slice(0, 7)}-01` : "";
}

function profitMonthEnd(iso) {
  const day = profitDayOf(iso);
  if (!day) return "";
  // Day 0 of the NEXT month is the last day of this one.
  return localDateString(
    new Date(Number(day.slice(0, 4)), Number(day.slice(5, 7)), 0)
  );
}

function profitShiftDays(iso, days) {
  const day = profitDayOf(iso);
  if (!day) return localDateString();
  const [y, m, d] = day.split("-").map(Number);
  return localDateString(new Date(y, m - 1, d + Number(days || 0)));
}

// Calendar days in [from, to], at least 1.
function profitDaysBetween(fromIso, toIso) {
  const from = profitDayOf(fromIso);
  const to = profitDayOf(toIso);
  if (!from || !to) return 1;
  const a = new Date(
    Number(from.slice(0, 4)),
    Number(from.slice(5, 7)) - 1,
    Number(from.slice(8, 10))
  );
  const b = new Date(
    Number(to.slice(0, 4)),
    Number(to.slice(5, 7)) - 1,
    Number(to.slice(8, 10))
  );
  return Math.max(
    1,
    Math.round((b.getTime() - a.getTime()) / 86400000) + 1
  );
}

function profitShiftMonth(iso, delta) {
  const day = profitMonthStart(iso) || profitMonthStart(localDateString());
  const months =
    Number(day.slice(0, 4)) * 12 + Number(day.slice(5, 7)) - 1 + Number(delta || 0);
  const year = Math.floor(months / 12);
  const month = ((months % 12) + 12) % 12;
  return `${year}-${String(month + 1).padStart(2, "0")}-01`;
}

// Whether a period is one day, one whole calendar month or something else.
function profitRangeMode(fromIso, toIso) {
  const from = profitDayOf(fromIso);
  const to = profitDayOf(toIso) || from;
  if (!from) return "custom";
  if (from === to) return "day";
  if (from === profitMonthStart(from) && to === profitMonthEnd(from)) {
    return "month";
  }
  return "custom";
}

// The period a step button moves to: a day by one day, a whole month by one
// month, any other period by its own length (so paging keeps the range size).
function profitShiftRange(fromIso, toIso, direction) {
  const step = direction < 0 ? -1 : 1;
  const from = profitDayOf(fromIso) || localDateString();
  const to = profitDayOf(toIso) || from;
  if (from === to) {
    const day = step < 0 ? previousLocalDate(from) : nextLocalDate(from);
    return { from: day, to: day };
  }
  if (profitRangeMode(from, to) === "month") {
    const month = profitShiftMonth(from, step);
    return { from: month, to: profitMonthEnd(month) };
  }
  const span = profitDaysBetween(from, to) * step;
  return { from: profitShiftDays(from, span), to: profitShiftDays(to, span) };
}

// A fresh-enough copy of every live insurance. The endpoint is admin-only and
// the Profits tab is part of the admin navigation.
async function profitInsuranceRows(force) {
  const now = Date.now();
  if (
    !force &&
    profitInsurancesCache &&
    now - profitInsurancesCacheAt < PROFIT_INSURANCE_TTL_MS
  ) {
    return profitInsurancesCache;
  }
  const data = await api("/admin/insurances");
  const rows = Array.isArray(data && data.insurances) ? data.insurances : [];
  profitInsurancesCache = rows;
  profitInsurancesCacheAt = Date.now();
  return rows;
}

// One editable grid (the Bulins prices or the profits). `onValue(type,
// duration, text)` runs on every keystroke and only stores the text; `onEnter`
// runs the calculation when Enter is pressed in a cell.
function profitSettingsTable(title, grid, onValue, onEnter) {
  const block = el("div", null, { class: "profit-settings-block" });
  block.appendChild(el("h4", title));

  const table = el("table", null, { class: "profit-input-table" });
  const thead = el("thead");
  const head = el("tr");
  head.appendChild(el("th", t("profits.type")));
  for (const key of PROFIT_DURATION_KEYS) {
    head.appendChild(el("th", profitDurationLabel(key)));
  }
  thead.appendChild(head);
  table.appendChild(thead);

  const tbody = el("tbody");
  for (const type of PROFIT_TYPES) {
    const row = el("tr");
    row.appendChild(el("th", profitTypeLabel(type), { scope: "row" }));
    for (const key of PROFIT_DURATION_KEYS) {
      const value = grid && grid[type] ? grid[type][key] : "";
      const cellInput = input("text", value === undefined ? "" : value);
      cellInput.className = "profit-input";
      cellInput.inputMode = "decimal";
      cellInput.autocomplete = "off";
      cellInput.setAttribute(
        "aria-label",
        `${profitTypeLabel(type)} · ${profitDurationLabel(key)}`
      );
      cellInput.addEventListener("input", () =>
        onValue(type, key, cellInput.value)
      );
      // Enter runs the calculation without leaving the cell.
      cellInput.addEventListener("keydown", (event) => {
        if (event.key !== "Enter") return;
        event.preventDefault();
        if (typeof onEnter === "function") onEnter();
      });
      const cell = el("td");
      cell.appendChild(cellInput);
      row.appendChild(cell);
    }
    tbody.appendChild(row);
  }
  table.appendChild(tbody);
  block.appendChild(table);
  return block;
}

// The statistics half of the report: best day/month, averages and the two
// breakdown tables (by vehicle type and by duration).
function profitStatisticsNodes(report) {
  const currency = report.currency;
  const amount = (value) => `${money(value)} ${currency}`;
  const nodes = [];
  const days = profitDaysBetween(report.from, report.to);

  nodes.push(el("h3", t("profits.statistics")));
  const stats = el("div", null, { class: "stat-grid" });
  const stat = (label, value) => {
    const box = el("div", null, { class: "stat-card" });
    box.appendChild(el("h3", label));
    box.appendChild(el("p", value));
    stats.appendChild(box);
  };
  stat(
    t("profits.bestDay"),
    report.bestDay
      ? `${formatDateOnly(report.bestDay.date)} · ${amount(report.bestDay.profit)}`
      : t("noData")
  );
  stat(
    t("profits.bestMonth"),
    report.bestMonth
      ? `${dateFieldMonthLabel(`${report.bestMonth.month}-01`)} · ${amount(
          report.bestMonth.profit
        )}`
      : t("noData")
  );
  stat(t("profits.sellingDays"), `${report.days.length} / ${days}`);
  stat(
    t("profits.avgProfitPerPolicy"),
    amount(
      report.totals.policies
        ? profitRound(report.totals.profit / report.totals.policies)
        : 0
    )
  );
  stat(
    t("profits.avgIncomePerPolicy"),
    amount(
      report.totals.policies
        ? profitRound(report.totals.income / report.totals.policies)
        : 0
    )
  );
  stat(
    t("profits.avgProfitPerDay"),
    amount(
      report.days.length
        ? profitRound(report.totals.profit / report.days.length)
        : 0
    )
  );
  nodes.push(stats);

  const moneyColumn = (key, label) => ({
    key,
    label: `${label} (${currency})`,
    format: (value) => money(value),
  });
  const breakdownColumns = (labelKey) => [
    { key: "label", label: t(labelKey) },
    { key: "policies", label: t("profits.policies") },
    moneyColumn("income", t("profits.totalIncome")),
    moneyColumn("bulins", t("profits.bulinsPayment")),
    moneyColumn("profit", t("profits.profit")),
    { key: "margin", label: t("profits.margin") },
  ];
  const withMargin = (rows) =>
    rows.map((row) => ({
      ...row,
      margin: profitMargin(row.profit, row.income),
    }));

  nodes.push(el("h3", t("profits.byType")));
  nodes.push(
    renderTable(
      withMargin(
        report.types.map((row) => ({
          ...row,
          label: profitTypeLabel(row.type),
        }))
      ),
      breakdownColumns("profits.type")
    )
  );

  nodes.push(el("h3", t("profits.byDuration")));
  nodes.push(
    renderTable(
      withMargin(
        report.durations.map((row) => ({
          ...row,
          label: profitDurationLabel(row.duration),
        }))
      ),
      breakdownColumns("profits.byDuration")
    )
  );

  return nodes;
}

// The report itself: summary cards, the daily and monthly tables and the
// statistics. Every figure comes from the local inputs + the fetched policies.
function profitReportNodes(report) {
  const currency = report.currency;
  const amount = (value) => `${money(value)} ${currency}`;
  const nodes = [];

  const cards = el("div", null, { class: "stat-grid" });
  const card = (label, value, hint) => {
    const attrs = { class: "stat-card" };
    if (hint) attrs.title = hint;
    const box = el("div", null, attrs);
    box.appendChild(el("h3", label));
    box.appendChild(el("p", value, { class: "big" }));
    cards.appendChild(box);
  };
  card(
    t("profits.totalIncome"),
    amount(report.totals.income),
    t("profits.totalIncomeHint")
  );
  card(
    t("profits.bulinsPayment"),
    amount(report.totals.bulins),
    t("profits.bulinsPaymentHint")
  );
  card(t("profits.profit"), amount(report.totals.profit), t("profits.profitHint"));
  card(
    t("profits.policies"),
    String(report.totals.policies),
    t("profits.policiesHint")
  );
  nodes.push(cards);

  const days = profitDaysBetween(report.from, report.to);
  const range =
    `${formatDateOnly(report.from)} – ${formatDateOnly(report.to)}` +
    ` · ${days} ${t("profits.days")}`;
  nodes.push(
    el("p", `${t("profits.period")}: ${range}`, {
      class: "muted profit-period-line",
    })
  );
  if (report.totals.unpriced > 0) {
    nodes.push(
      el("p", fmt(t("profits.unpriced"), { n: report.totals.unpriced }), {
        class: "profit-warning",
      })
    );
  }
  if (report.otherCurrency > 0) {
    nodes.push(
      el("p", fmt(t("profits.otherCurrency"), { n: report.otherCurrency }), {
        class: "muted profit-period-line",
      })
    );
  }

  const moneyColumn = (key, label) => ({
    key,
    label: `${label} (${currency})`,
    format: (value) => money(value),
  });
  const warnUnpriced = (row) => (Number(row.unpriced) > 0 ? "warn-row" : "");

  nodes.push(el("h3", t("profits.dailyReport")));
  nodes.push(
    renderTable(
      report.days,
      [
        {
          key: "date",
          label: t("date"),
          format: (value) => formatDateOnly(value),
        },
        { key: "policies", label: t("profits.policies") },
        moneyColumn("income", t("profits.totalIncome")),
        moneyColumn("bulins", t("profits.bulinsPayment")),
        moneyColumn("profit", t("profits.profit")),
      ],
      null,
      warnUnpriced
    )
  );

  nodes.push(el("h3", t("profits.monthlyReport")));
  nodes.push(
    renderTable(
      report.months,
      [
        {
          key: "month",
          label: t("profits.month"),
          format: (value) => dateFieldMonthLabel(`${value}-01`),
        },
        { key: "policies", label: t("profits.policies") },
        moneyColumn("income", t("profits.totalIncome")),
        moneyColumn("bulins", t("profits.bulinsPayment")),
        moneyColumn("profit", t("profits.profit")),
      ],
      null,
      warnUnpriced
    )
  );

  nodes.push(...profitStatisticsNodes(report));
  return nodes;
}

// The Profits tab. Everything is computed here, in this window: the server only
// supplies the insurance rows it always supplies, and the Bulins prices/profits
// never leave localStorage.
async function profitsView() {
  const today = localDateString();
  const settings =
    profitSettingsCache || (profitSettingsCache = profitLoadSettings());
  if (!profitPeriodState) {
    profitPeriodState = { from: today, to: today };
  }
  const period = profitPeriodState;

  // ---- header: title + the period controls on the top right
  const titleBox = el("div", null, { class: "profit-heading-title" });
  titleBox.appendChild(el("h2", t("nav.profits")));
  titleBox.appendChild(el("p", t("profits.localOnly"), { class: "muted" }));

  const periodBox = el("div", null, { class: "profit-period" });
  const fromInput = input("date", period.from);
  const toInput = input("date", period.to);

  // Switching the period throws the view away and rebuilds it (like the
  // Current cash day picker), so every figure is rendered from one period.
  const go = (next) => {
    profitPeriodState = { from: next.from, to: next.to };
    profitsView().catch((err) => toast(err.message, "error"));
  };

  fromInput.addEventListener("change", () => {
    let from = fromInput.value || period.from;
    let to = toInput.value || from;
    if (profitRangeMode(period.from, period.to) === "day") to = from;
    if (from && to && to < from) to = from;
    go({ from, to });
  });
  toInput.addEventListener("change", () => {
    let to = toInput.value || period.to;
    let from = fromInput.value || period.from;
    if (from && to && to < from) from = to;
    go({ from, to });
  });

  // One step button on each side of the two pickers: a day period moves one
  // day, a whole month moves one month, any other period keeps its length.
  const step = (direction) => {
    const next = profitShiftRange(
      fromInput.value || period.from,
      toInput.value || period.to,
      direction
    );
    go(next);
  };
  const previousBtn = el("button", "‹", {
    type: "button",
    class: "secondary date-step",
    title: t("profits.previousPeriod"),
  });
  previousBtn.setAttribute("aria-label", previousBtn.title);
  previousBtn.addEventListener("click", () => step(-1));
  const nextBtn = el("button", "›", {
    type: "button",
    class: "secondary date-step",
    title: t("profits.nextPeriod"),
  });
  nextBtn.setAttribute("aria-label", nextBtn.title);
  nextBtn.addEventListener("click", () => step(1));

  const dateNav = el("div", null, { class: "profit-date-nav" });
  dateNav.appendChild(previousBtn);
  dateNav.appendChild(field(t("profits.from"), fromInput));
  dateNav.appendChild(field(t("profits.to"), toInput));
  dateNav.appendChild(nextBtn);

  const activeMode = profitRangeMode(period.from, period.to);
  const modeRow = el("div", null, { class: "profit-period-modes" });
  for (const def of [
    { mode: "day", label: t("profits.day") },
    { mode: "month", label: t("profits.month") },
    { mode: "custom", label: t("profits.custom") },
  ]) {
    const isActive = def.mode === activeMode;
    const btn = el("button", def.label, {
      type: "button",
      class: isActive ? "branch-btn active" : "branch-btn",
      "aria-pressed": isActive ? "true" : "false",
    });
    btn.addEventListener("click", () => {
      const ref = fromInput.value || period.from || today;
      if (def.mode === "day") return go({ from: ref, to: ref });
      if (def.mode === "month") {
        return go({ from: profitMonthStart(ref), to: profitMonthEnd(ref) });
      }
      go({
        from: fromInput.value || ref,
        to: toInput.value || fromInput.value || ref,
      });
    });
    modeRow.appendChild(btn);
  }

  const todayBtn = el("button", t("profits.today"), {
    type: "button",
    class: "secondary small",
  });
  todayBtn.addEventListener("click", () => go({ from: today, to: today }));
  const monthBtn = el("button", t("profits.thisMonth"), {
    type: "button",
    class: "secondary small",
  });
  monthBtn.addEventListener("click", () =>
    go({ from: profitMonthStart(today), to: profitMonthEnd(today) })
  );
  const refreshBtn = el("button", t("profits.refresh"), {
    type: "button",
    class: "secondary small",
  });
  refreshBtn.addEventListener("click", () => {
    profitInsurancesCache = null;
    profitInsurancesCacheAt = 0;
    profitsView().catch((err) => toast(err.message, "error"));
  });

  const presets = el("div", null, { class: "profit-period-presets" });
  presets.appendChild(todayBtn);
  presets.appendChild(monthBtn);
  presets.appendChild(refreshBtn);

  periodBox.appendChild(modeRow);
  periodBox.appendChild(dateNav);
  periodBox.appendChild(presets);

  const headingRow = el("div", null, { class: "profit-heading-row" });
  headingRow.appendChild(titleBox);
  headingRow.appendChild(periodBox);

  // ---- the policies the report is computed from. A failed read must not hide
  // the local inputs: the admin can still fill them in and retry with Refresh.
  let insurances = null;
  let loadError = null;
  try {
    insurances = await profitInsuranceRows();
  } catch (err) {
    loadError = err;
  }

  // ---- report (recomputed only when Calculate runs)
  const reportHost = el("div", null, { class: "profit-report" });
  function renderReport() {
    if (!insurances) {
      reportHost.replaceChildren(
        el(
          "p",
          `${t("errorPrefix")}: ${translateError(
            loadError && loadError.message ? loadError.message : ""
          )}`,
          { class: "muted" }
        )
      );
      return;
    }
    const from = fromInput.value || period.from;
    const to = toInput.value || from;
    reportHost.replaceChildren(
      ...profitReportNodes(profitReport(insurances, settings, from, to))
    );
  }

  // ---- the local inputs (never uploaded)
  const settingsCard = el("details", null, { class: "profit-settings-card" });
  settingsCard.open =
    profitSettingsOpen === null
      ? !profitSettingsHasValues(settings)
      : profitSettingsOpen;
  settingsCard.addEventListener("toggle", () => {
    profitSettingsOpen = settingsCard.open;
  });
  const settingsSummary = el("summary");
  settingsSummary.appendChild(el("h3", t("profits.settings")));
  settingsCard.appendChild(settingsSummary);

  const settingsBody = el("div", null, { class: "profit-settings-body" });
  settingsBody.appendChild(el("p", t("profits.settingsHint"), { class: "muted" }));

  const toolbar = el("div", null, { class: "profit-settings-toolbar" });
  const currencySelect = select(
    [
      { label: "EUR", value: "EUR" },
      { label: "TRY", value: "TRY" },
    ],
    settings.currency
  );
  currencySelect.addEventListener("change", () => {
    settings.currency = currencySelect.value;
    markDirty();
  });
  toolbar.appendChild(field(t("currency"), currencySelect));
  const saveStatus = el(
    "span",
    t(profitSettingsDirty ? "profits.unsaved" : "profits.saved"),
    { class: "muted profit-save-status" }
  );
  toolbar.appendChild(saveStatus);
  toolbar.appendChild(el("div", null, { class: "spacer" }));

  const calculateBtn = el("button", t("profits.calculate"), { type: "button" });
  calculateBtn.addEventListener("click", runCalculation);
  toolbar.appendChild(calculateBtn);

  const resetBtn = el("button", t("profits.reset"), {
    type: "button",
    class: "danger",
  });
  resetBtn.addEventListener("click", async () => {
    const confirmed = await appConfirm(t("profits.resetConfirm"), {
      danger: true,
    });
    if (!confirmed) return;
    settings.bulins = profitEmptyGrid();
    settings.profit = profitEmptyGrid();
    profitSaveSettings(settings);
    profitSettingsDirty = false;
    profitSettingsOpen = true;
    profitsView().catch((err) => toast(err.message, "error"));
  });
  toolbar.appendChild(resetBtn);
  settingsBody.appendChild(toolbar);

  // Typing only changes the working copy. Nothing is written to localStorage
  // until Calculate (or Enter in a cell) runs - and that is also the only
  // moment the report is recomputed.
  function markDirty() {
    profitSettingsDirty = true;
    saveStatus.textContent = t("profits.unsaved");
  }
  function runCalculation() {
    const saved = profitSaveSettings(settings);
    profitSettingsDirty = !saved;
    saveStatus.textContent = t(saved ? "profits.saved" : "profits.unsaved");
    renderReport();
  }
  function storeValue(table, type, key, value) {
    settings[table][type][key] = value;
    markDirty();
  }

  const settingsTables = el("div", null, { class: "profit-settings-tables" });
  settingsTables.appendChild(
    profitSettingsTable(
      t("profits.bulinsTable"),
      settings.bulins,
      (type, key, value) => storeValue("bulins", type, key, value),
      runCalculation
    )
  );
  settingsTables.appendChild(
    profitSettingsTable(
      t("profits.profitTable"),
      settings.profit,
      (type, key, value) => storeValue("profit", type, key, value),
      runCalculation
    )
  );
  settingsBody.appendChild(settingsTables);
  settingsBody.appendChild(el("p", t("profits.emptyHint"), { class: "muted" }));
  settingsCard.appendChild(settingsBody);

  Content.replaceChildren(headingRow, settingsCard, reportHost);
  renderReport();
}

// Navigation setup
// ---------------------------------------------------------------------------
const NAV_DEFS = {
  1: [
    // The Dashboard tab shows the unread email cards, so an admin can work an
    // email when no worker is available (the old overview was removed).
    { key: "nav.dashboard", load: emailCardsView },
    { key: "nav.users", load: adminUsers },
    { key: "nav.branches", load: adminBranches },
    { key: "nav.insurancesByDate", load: adminInsurancesByDate },
    { key: "nav.currentCash", load: currentCashView },
    // Profits: the Bulins prices/profits are typed by the admin and kept on
    // this computer only (see profitsView); the tab is admin-only because it
    // reads /admin/insurances.
    { key: "nav.profits", load: profitsView },
    // No separate Card tab: the branch's card balance, its reset history and
    // the walk-in card insurances behind it are all on the Current cash screen.
    { key: "nav.brokers", load: brokersView },
    { key: "nav.reconcile", load: reconcileView },
    { key: "nav.diagnostics", load: adminDiagnostics },
  ],
  2: [
    { key: "nav.dashboard", load: emailCardsView },
    { key: "nav.insurances", load: workerInsurances },
    // No Card tab: workers see only their own branch's card balance, shown
    // on the Current cash screen.
    { key: "nav.currentCash", load: currentCashView },
    { key: "nav.brokers", load: brokersView },
  ],
  3: [
    { key: "nav.profile", load: clientProfile },
    { key: "nav.myInsurances", load: clientInsurances },
  ],
};

// Admin switch: whether client diagnostics are being gathered. It is a
// server-side setting (see Requests/Diagnostics.js) shown inside the
// Diagnostics tab itself, so the tab is always part of the admin navigation.
let diagnosticsEnabled = true;

// The nav entries of the current role. Kept as a function because several
// places (rendering, highlighting, init) must see exactly the same list.
function navDefs() {
  return NAV_DEFS[userRole] || [];
}

let activeNav = null;

// Highlight and remember the nav entry whose loader is `load`. Used by links
// inside views (e.g. a branch card's Manage button) and by the end-of-shift
// reminder, so all of them behave exactly like a click on the nav button.
function activateNav(load) {
  const defs = navDefs();
  const idx = defs.findIndex((d) => d.load === load);
  if (idx === -1) return false;
  activeNav = defs[idx];
  Array.from(Nav.children).forEach((btn, i) => {
    btn.classList.toggle("active", i === idx);
  });
  return true;
}

// The shared shift reminder (common.js) runs on every page. On the dashboard
// it calls this hook directly instead of reloading the page.
window.__openCurrentCash = function openCurrentCashFromReminder() {
  if (!activateNav(currentCashView)) return false;
  // The reminder is about the shift that is running now, so open today even if
  // the tab was last left on another day.
  currentCashDate = null;
  runLoader(() => currentCashView());
  return true;
};

function renderHeader() {
  HeaderTitle.textContent = t("nav.dashboard");
  HeaderSub.textContent = `${username} · ${roleLabel(userRole)}`;
  Nav.replaceChildren();

  const defs = navDefs();
  defs.forEach((d) => {
    const btn = el("button", t(d.key), { class: "secondary nav-btn" });
    btn.addEventListener("click", () => {
      activeNav = d;
      btn.classList.add("active");
      Array.from(Nav.children).forEach((c) => {
        if (c !== btn) c.classList.remove("active");
      });
      runLoader(d.load);
    });
    Nav.appendChild(btn);
  });
  // Keep the open view highlighted when only the navigation is redrawn (e.g.
  // after an admin flips the Diagnostics switch).
  if (activeNav) {
    const idx = defs.findIndex((d) => d.load === activeNav.load);
    if (idx !== -1 && Nav.children[idx]) {
      Nav.children[idx].classList.add("active");
    }
  }

  if (userRole === "1" || userRole === "2") {
    const addBtn = el("button", t("addInsurance"));
    addBtn.addEventListener("click", () => {
      // This is a walk-in (or admin back-fill) insurance, not a
      // broker-requested one: make sure no leftover "pendingEmail" makes it
      // look like an email-sourced insurance.
      localStorage.removeItem("pendingEmail");

      // Admins keep the in-app back-fill form. Workers fall through to the
      // in-app AddInsurance form; the Bulins web form (a WebContentsView over
      // the dashboard) is disabled for now, see USE_BULINS_WEB_FORM.
      if (userRole === "1") {
        window.bridge.LoadNewPage("renderer/AdminInsurance/AdminInsurance.html");
        return;
      }

      if (
        USE_BULINS_WEB_FORM &&
        window.bridge &&
        typeof window.bridge.BulinsOpen === "function"
      ) {
        window.bridge
          .BulinsOpen({ mode: "walkin", email: null })
          .catch((err) => {
            console.error("Failed to open the Bulins web form:", err);
            const message =
              translateError(err && err.message ? err.message : "") ||
              t("serverError");
            toast(`${t("errorPrefix")}: ${message}`, "error");
          });
        return;
      }

      // The walk-in form starts the Desktop PDF watcher when it loads. This is
      // the moment the button was clicked, so PDFs downloaded right after the
      // click are picked up (and printed) by the watcher.
      try {
        localStorage.setItem("desktopPdfWatchSinceMs", String(Date.now()));
      } catch (err) {
        console.error("Failed to store the Desktop watch start time:", err);
      }

      window.bridge.LoadNewPage("renderer/AddInsurance/AddInsurance.html");
    });
    Nav.appendChild(addBtn);
  }
}

async function runLoader(load) {
  Content.replaceChildren(el("p", t("loading"), { class: "muted" }));
  try {
    await load();
  } catch (err) {
    const message = translateError(err && err.message ? err.message : "");
    Content.replaceChildren(
      el("p", `${t("errorPrefix")}: ${message}`, { class: "muted" })
    );
  }
}

function syncLangButton() {
  if (!LangButton) return;
  LangButton.textContent = getLang() === "bg" ? "EN" : "BG";
}

// Show a one-time toast handed over by the previous page (e.g. AddInsurance
// after saving an email policy and redirecting back to the dashboard).
function showFlashToast() {
  let flash = null;
  try {
    const raw = localStorage.getItem("flashToast");
    localStorage.removeItem("flashToast");
    if (raw) flash = JSON.parse(raw);
  } catch {
    flash = null;
  }
  if (flash && flash.text) toast(flash.text, flash.type || "info");
}

async function init() {
  renderHeader();
  showFlashToast();
  setupEmailSocket();
  setupBulinsHandlers();
  setupPresenceSocket();
  fetchUnreadEmails();
  initializeBrokerPricing();
  loadBrokerCodes();
  loadEnabledBranches();

  // The shift reminder's "Finish shift" button on the insurance form stores a
  // request to open Current cash and loads this page. Honor it instead of the
  // default first tab, then let the reminder add its dashboard-only shortcut.
  if (
    typeof consumeShiftReminderPendingView === "function" &&
    consumeShiftReminderPendingView() &&
    window.__openCurrentCash()
  ) {
    if (typeof refreshShiftReminder === "function") refreshShiftReminder();
    return;
  }

  const defs = navDefs();
  if (defs.length) {
    activeNav = defs[0];
    const first = Nav.children[0];
    if (first) first.classList.add("active");
    await runLoader(defs[0].load);
  }
  // If the reminder is already on screen, re-render it now that the dashboard
  // hook exists so it offers the one-click "Finish shift" action.
  if (typeof refreshShiftReminder === "function") refreshShiftReminder();
}

LogoutButton.addEventListener("click", () => {
  clearSession();
  window.bridge.LoadNewPage("renderer/LoginPage/index.html");
});

// Language toggle re-renders header + current view labels.
if (LangButton) {
  LangButton.addEventListener("click", () => {
    toggleLang();
    syncLangButton();
    renderHeader();
    renderPresence(presenceWorkers);
    if (activeNav) runLoader(activeNav.load);
  });
}
syncLangButton();

init();
