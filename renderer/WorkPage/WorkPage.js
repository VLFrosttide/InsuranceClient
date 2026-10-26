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
// Unread email cards (workers only)
// ---------------------------------------------------------------------------
const emailCards = new Map(); // messageId -> { email, node }
let emailSocket = null;
let pendingClaimEmail = null;

function emailTitle(email) {
  return email.subject || email.from || t("email.noSubject");
}

function emailCardsContainer() {
  const container = el("div", null, { id: "EmailCards", class: "email-cards" });
  if (emailCards.size === 0) {
    container.appendChild(el("p", t("noUnreadEmails"), { class: "muted" }));
    return container;
  }
  // Oldest first: the card that has waited longest is the one to process next.
  const entries = Array.from(emailCards.values()).sort((a, b) =>
    compareEmailArrival(a.arrivalMs, b.arrivalMs)
  );
  for (const entry of entries) container.appendChild(entry.node);
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
  for (const entry of emailCards.values()) {
    const overdue = isEmailOverdue(entry.arrivalMs, now);
    entry.node.classList.toggle("email-card-overdue", overdue);
    entry.timeNode.textContent = t("email.arrived").replace(
      "{t}",
      formatEmailArrival(entry.arrivalMs, now)
    );
    entry.waitNode.textContent = emailWaitingLabel(entry.arrivalMs, now);
    entry.timeWrap.title = overdue ? t("email.overdue") : "";
    if (entry.busyLabelNode) {
      entry.busyLabelNode.textContent = t("email.opening");
    }
  }
}

// Ages change while the dashboard sits open: refresh them periodically.
// Cheap (text/class updates only) and harmless when the dashboard is hidden.
const EMAIL_AGE_REFRESH_MS = 30 * 1000;
setInterval(refreshEmailCardAges, EMAIL_AGE_REFRESH_MS);

function addEmailCard(email) {
  if (!email || !email.messageId || emailCards.has(email.messageId)) return;
  // Its policy is already queued in the outbox (saved offline, waiting to be
  // sent): the email is handled, so it must not be offered again.
  if (outboxEmailIds().has(email.messageId)) return;

  const card = el("div", null, { class: "email-card" });

  const openBtn = el("button", null, {
    class: "email-card-open",
    type: "button",
  });

  // Replies / forwards look different from a fresh request: a coloured edge
  // plus a badge saying how many emails the thread contains.
  const thread = emailThreadInfo(email);
  if (thread.kind) {
    card.classList.add(`email-card-${thread.kind}`);
    let badgeText = t(thread.kind === "forward" ? "email.forward" : "email.reply");
    if (thread.count > 1) {
      badgeText += ` · ${t("email.threadCount").replace("{n}", thread.count)}`;
    }
    openBtn.appendChild(el("span", badgeText, { class: "email-card-badge" }));
  }
  openBtn.appendChild(el("span", emailTitle(email), { class: "email-card-title" }));

  // Arrival time (when this PC first saw the email) + how long the card has
  // been waiting (filled in and kept current by refreshEmailCardAges).
  const arrivalMs = emailFirstSeenMs(localStorage, email.messageId);
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

  openBtn.addEventListener("click", () => openEmailInNewForm(email));

  const xBtn = el("button", "✕", {
    class: "email-card-x",
    type: "button",
    title: t("email.markIrrelevant"),
    "aria-label": t("email.markIrrelevant"),
  });
  xBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    markEmailIrrelevant(email);
  });

  card.appendChild(openBtn);
  card.appendChild(xBtn);

  emailCards.set(email.messageId, {
    email,
    node: card,
    openBtn,
    xBtn,
    busyNode,
    busyLabelNode,
    arrivalMs,
    timeWrap,
    timeNode,
    waitNode,
  });
  refreshEmailCardAges();

  // If the dashboard is the active view, re-render it in place.
  if (activeNav && activeNav.load === workerDashboard) {
    Content.replaceChildren(
      el("h2", t("unreadEmails")),
      emailCardsContainer()
    );
  }
}

function removeEmailCard(messageId) {
  if (!messageId || !emailCards.delete(messageId)) return;
  if (activeNav && activeNav.load === workerDashboard) {
    Content.replaceChildren(
      el("h2", t("unreadEmails")),
      emailCardsContainer()
    );
  }
}

function markEmailIrrelevant(email) {
  if (!email || !email.messageId) return;
  if (!confirm(t("email.irrelevantConfirm"))) return;

  // Dismiss on the server. The server removes the email from the shared pool
  // and marks the Gmail message read, so it disappears for every worker and
  // never re-surfaces on a later poll or server restart.
  try {
    if (!emailSocket) throw new Error(t("emailConnUnavailable"));
    if (!emailSocket.isReady()) {
      queueDurableEmailWsAction({
        type: "mark_irrelevant",
        messageId: email.messageId,
      });
      emailSocket.ensureConnected();
    } else {
      emailSocket.send({ type: "mark_irrelevant", messageId: email.messageId });
    }
  } catch (err) {
    // Keep the card: the server never received the dismissal.
    reportError("Failed to mark email as irrelevant", err, "emailSendFailed");
    return;
  }
  removeEmailCard(email.messageId);
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
  const entry = emailCards.get(messageId);
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

  // Only navigate once the server confirms this client won the claim. If
  // another worker clicked the same card first, we show an error instead.
  pendingClaimEmail = email;
  pendingClaimSent = false;
  setCardBusy(email.messageId, true);
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
    if (!pendingClaimEmail || pendingClaimEmail.messageId !== email.messageId) {
      return;
    }
    console.error(
      `No claim_email response for "${email.messageId}" within ` +
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
  window.bridge.LoadNewPage("renderer/AddInsurance/AddInsurance.html");
}

function reconcileEmailCards(serverEmails) {
  const seen = new Set();
  for (const email of serverEmails || []) {
    if (email && email.messageId) {
      seen.add(email.messageId);
      addEmailCard(email);
    }
  }
  // Drop any card the server no longer lists (claimed/completed while this
  // client was disconnected). A card left behind here would otherwise become
  // unclickable: the server no longer has the email to claim it.
  for (const messageId of Array.from(emailCards.keys())) {
    if (!seen.has(messageId)) emailCards.delete(messageId);
  }
  if (activeNav && activeNav.load === workerDashboard) {
    Content.replaceChildren(
      el("h2", t("unreadEmails")),
      emailCardsContainer()
    );
  }
}

function setupEmailSocket() {
  if (userRole !== "2") return;

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
      // Share this connection for worker presence so the page only opens one
      // WebSocket instead of two.
      try {
        sendPresence(presenceStatusFor("online", lastActivityAt));
        emailSocket.send({ type: "list_presence" });
      } catch (err) {
        console.error("Failed to send presence request:", err);
      }
      // If the worker clicked an email card while the socket was reconnecting,
      // send the pending claim now.
      sendPendingClaimNow();
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
    email_completed: (msg) => removeEmailCard(msg.messageId),
    email_irrelevant: (msg) => removeEmailCard(msg.messageId),
    // The original Gmail message was read outside the app: drop its card.
    email_read: (msg) => removeEmailCard(msg.messageId),
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
  });
  emailSocket.connect();

  // Queue changes: hide cards of newly queued email policies and complete the
  // emails of policies the outbox just delivered.
  onOutboxState(() => {
    for (const messageId of outboxEmailIds()) removeEmailCard(messageId);
    syncOutboxEmails(emailSocket);
  });
}

function fetchUnreadEmails() {
  if (userRole !== "2" || !emailSocket || !emailSocket.isReady()) return;
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
  if (!presenceSocket) return;
  try {
    presenceSocket.send({ type: "presence", status });
    presenceStatus = status;
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
  if (userRole === "2" && emailSocket) {
    // Reuse the worker's emailSocket so the dashboard maintains a single
    // WebSocket connection for both emails and presence.
    presenceSocket = emailSocket;
    trackUserActivity(markActivity);
    setInterval(() => {
      const status = presenceStatusFor("online", lastActivityAt);
      if (status !== presenceStatus) sendPresence(status);
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
    },
    presence_update: (msg) => {
      presenceWorkers = Array.isArray(msg.data) ? msg.data : [];
      renderPresence(presenceWorkers);
    },
  });
  presenceSocket.connect();

  if (userRole === "2") {
    trackUserActivity(markActivity);
    setInterval(() => {
      const status = presenceStatusFor("online", lastActivityAt);
      if (status !== presenceStatus) sendPresence(status);
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
const CARD_FEE = 2;

function chargePrice(item) {
  const raw = Number(item && item.Price);
  if (!Number.isFinite(raw)) return raw;
  const isWalkIn =
    item.BrokerId === null ||
    item.BrokerId === undefined ||
    item.BrokerId === "";
  const isCard = String(item.PaymentType || "") === "Card";
  return isWalkIn && isCard ? Math.round((raw + CARD_FEE) * 100) / 100 : raw;
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
  const id = `fld-${++fieldIdCounter}-${Date.now()}`;
  const label = el("label", labelText);
  label.setAttribute("for", id);
  inputNode.id = inputNode.id || id;
  wrap.appendChild(label);
  wrap.appendChild(inputNode);
  return wrap;
}
function input(type, value, placeholder) {
  const node = el("input");
  node.type = type || "text";
  if (value !== undefined && value !== null) node.value = value;
  if (placeholder) node.placeholder = placeholder;
  return node;
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
    else if (s.type === "checkbox") {
      control = input("checkbox");
      control.checked = !!s.value;
    } else control = input(s.type, s.value, s.placeholder);
    if (s.step !== undefined && s.step !== null) control.step = s.step;
    if (s.readonly) control.readOnly = true;
    control.dataset.key = s.key;
    values[s.key] = control;
    form.appendChild(field(s.label, control));
  }
  const submit = el("button", submitLabel || t("save"), { type: "submit" });
  form.appendChild(submit);

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    submit.disabled = true;
    const payload = {};
    for (const s of spec) {
      const c = values[s.key];
      if (s.type === "emails" || s.type === "batches") {
        payload[s.key] = c.getValues();
      } else if (c.type === "checkbox") payload[s.key] = c.checked;
      else if (s.type === "number") payload[s.key] = Number(c.value);
      else payload[s.key] = c.value;
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
// ---------------------------------------------------------------------------
function renderTable(items, columns, actions, rowClass, onRowClick) {
  if (!items || items.length === 0) {
    return el("p", t("noData"), { class: "muted" });
  }
  const table = el("table");
  const thead = el("thead");
  const headRow = el("tr");
  columns.forEach((c) => {
    const th = el("th", c.label + (c.headerSuffix ? ` ${c.headerSuffix}` : ""));
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
        const wrap = el("div", null, { class: "row actions" });
        rowActions.forEach((a) => {
          const btn = el("button", a.label, {
            class: `small ${a.class || "secondary"}`,
          });
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
// Edit-insurance price recalculation
// ---------------------------------------------------------------------------
// Changing the duration or the vehicle type of a policy in the edit modal
// recalculates its price from the same tariffs the add-insurance form uses:
// the broker's tariffs for email (broker-linked) policies - falling back to the
// branch walk-in tariffs when the broker has none, like /tariffs/policy-pricing
// does - and the branch walk-in tariffs for walk-ins. The stored non-Turk fee
// (+5) is added on top, like the add form (the +2 card fee is visual-only and
// never added to the price or any balance).
const EDIT_DURATION_OPTIONS = [15, 30, 90];
const EDIT_VEHICLE_TYPES = ["Automobile", "Motor", "Bus", "Trailer"];
// Branch dropdown options for the edit form. Mirrors the login page's branch
// dropdown and KNOWN_BRANCHES below, so the lists cannot drift apart.
const EDIT_BRANCHES = ["ГКПП Капитан Андреево", "ГКПП Лесово", "Офис Харманли"];
const EDIT_NON_TURK_FEE = 5;

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
function editedPolicyPrice(pricing, otomobil, duration, fees) {
  const type = pricingVehicleKey(otomobil);
  const days = Number(duration);
  if (!type || !Number.isFinite(days) || days <= 0) return null;
  if (!pricing || !pricing[type]) return null;
  const raw = pricing[type][days];
  if (raw === undefined || raw === null || raw === "") return null;
  const base = Number(raw);
  if (!Number.isFinite(base)) return null;
  let total = base;
  if (fees && fees.nonTurk) total += EDIT_NON_TURK_FEE;
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
  // Non-Turk fee checkbox (only exists for walk-ins: email policies are
  // broker-paid and the non-Turk tax only applies to walk-ins).
  const nonTurkInput = control("NonTurk");
  // Card fee checkbox (also walk-in only). It is purely visual - it never
  // changes the price or any balance - and only applies while the policy is
  // paid by card, so it is locked (and cleared) when Cash is selected.
  const cardFeeInput = control("CardFee");
  const paymentInput = control("PaymentType");

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
      delta += fees.nonTurk ? EDIT_NON_TURK_FEE : -EDIT_NON_TURK_FEE;
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
      pricing = await loadEditPricing(insurance, branch, cache);
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
      fees
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
    ...(userRole === "1" || !isEmailPolicy
      ? [
          {
            key: "Price",
            label: t("price"),
            type: "number",
            value: insurance.Price,
            readonly: userRole !== "1",
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
  // or removes its fee (+5) from the price (see wireEditPriceRecalc), and the
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
  // insurance.
  if (userRole === "1" && editFlag(insurance.Annulled)) {
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
  wireEditPriceRecalc(form, insurance);

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

// The fixed set of real branches (mirrors the login page's branch dropdown).
// Used so the Overview always shows a card for every known branch — even
// when it has no current-cash record yet (shown as 0) — while never
// displaying a blank/unknown "branch" that legacy or malformed records may
// carry.
const KNOWN_BRANCHES = [
  "ГКПП Капитан Андреево",
  "ГКПП Лесово",
  "Офис Харманли",
];

async function adminDashboard() {
  // Fetch all insurances and branch cash data
  const [insuranceData, branchesData] = await Promise.all([
    api("/admin/insurances"),
    api("/currentcash/branches"),
  ]);

  const insurances = insuranceData.insurances || [];
  const branches = branchesData.branches || {};

  // Today's date as a LOCAL "YYYY-MM-DD". toISOString() would give the UTC day,
  // which differs from the local day around midnight.
  const now = new Date();
  const today = `${now.getFullYear()}-${reconPad(now.getMonth() + 1)}-${reconPad(
    now.getDate()
  )}`;

  // Count insurances by branch for today. CreationDate holds the local wall
  // clock time, so its first 10 characters are the local creation day.
  const branchCounts = {};
  for (const insurance of insurances) {
    const creationDate = insurance.CreationDate
      ? String(insurance.CreationDate).slice(0, 10)
      : null;
    if (creationDate === today) {
      const branch = insurance.Branch;
      if (!branch) continue; // skip legacy/blank branch entries
      branchCounts[branch] = (branchCounts[branch] || 0) + 1;
    }
  }

  // Build branch cards with insurance count and cash balance. Always show
  // every known branch (defaulting to 0 when there is no data for it yet),
  // plus any other non-blank branch name the server knows about. Blank or
  // missing branch names (e.g. legacy data from before branch tracking) are
  // intentionally dropped instead of shown as "Unknown branch", so no card
  // ever displays money without a real branch to attribute it to.
  const branchesSection = el("div", null, null);
  const branchNames = Array.from(
    new Set([...KNOWN_BRANCHES, ...Object.keys(branches)])
  )
    .filter((name) => name)
    .sort();

  if (branchNames.length > 0) {
    const branchGrid = el("div", null, { class: "stat-grid" });

    for (const branchName of branchNames) {
      const branchCard = el("div", null, { class: "stat-card" });
      branchCard.appendChild(el("h4", branchName));

      // Insurance count for today (0 when the branch has no data yet).
      const insuranceCount = branchCounts[branchName] || 0;
      branchCard.appendChild(
        el("p", `${t("nav.insurances")}: ${insuranceCount}`, {
          class: "muted",
        })
      );

      // Current cash balance (only non-zero currencies, same as the
      // Current Cash tab). Branches with no current-cash record yet render
      // as 0.
      const balances = branches[branchName] || {};
      branchCard.appendChild(
        el("p", renderCashBalances(balances), { class: "big" })
      );

      // Jump straight into the Current Cash tab, pre-filtered to this
      // branch, so the balance can be increased/reduced/reset from here.
      const manageBtn = el("button", t("manage"), {
        class: "secondary small",
      });
      manageBtn.addEventListener("click", () => {
        const defs = NAV_DEFS[userRole] || [];
        const idx = defs.findIndex((d) => d.load === currentCashView);
        if (idx !== -1) {
          activeNav = defs[idx];
          Array.from(Nav.children).forEach((btn, i) =>
            btn.classList.toggle("active", i === idx)
          );
        }
        runLoader(() => currentCashView(branchName));
      });
      branchCard.appendChild(manageBtn);

      branchGrid.appendChild(branchCard);
    }
    branchesSection.appendChild(branchGrid);
  } else {
    branchesSection.appendChild(el("p", t("noData"), { class: "muted" }));
  }

  Content.replaceChildren(el("h2", t("overview")), branchesSection);
}

async function adminUsers() {
  const [data, brokerData] = await Promise.all([
    api("/admin/users"),
    api("/brokers"),
  ]);
  const brokerList = (brokerData && brokerData.brokers) || [];
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

  const table = renderTable(
    data.users,
    [
      { key: "Username", label: t("username") },
      { key: "Role", label: t("role"), format: (v) => roleLabel(v) },
      { key: "Balance", label: t("balance"), format: (v) => money(v) },
      {
        key: "BrokerId",
        label: t("brokerName"),
        format: (v) => brokerNameOf(v) || "—",
      },
      {
        key: "BrokerId",
        label: t("mainBroker"),
        format: (_v, u) => mainBrokerOf(u) || "—",
      },
      { key: "Status", label: t("status") },
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
        onClick: async (u) => {
          if (!confirm(`${t("deleteConfirm")} "${u.Username}"?`)) return;
          try {
            await api(`/admin/users/${u.Username}/delete`, { method: "POST" });
            toast(t("userDeleted"), "success");
            adminUsers();
          } catch (err) {
            toast(err.message, "error");
          }
        },
      },
    ]
  );
  Content.replaceChildren(el("h2", t("users")), toolbar, table);
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
        redirectToLogin();
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

// Soft-delete an insurance from the admin panel. The row is kept in the
// database (tagged with Deleted/DeletedAt/DeletedBy by the server) so it is
// never lost, but it is removed from `data.insurances` here so it disappears
// from the list without a reload, and the server excludes it from every
// other list/search endpoint so it no longer gets parsed (e.g. in the daily
// reconcile report).
async function deleteInsurance(insurance, onDone) {
  if (
    !confirm(t("deleteInsuranceConfirm").replace("{b}", insurance.BlancNumber))
  ) {
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
  if (
    !confirm(t("restoreInsuranceConfirm").replace("{b}", insurance.BlancNumber))
  ) {
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

// "YYYY-MM-DD" one calendar day after the given local date string.
function nextLocalDate(dateString) {
  const [y, m, d] = dateString.split("-").map(Number);
  return localDateString(new Date(y, m - 1, d + 1));
}

// Monotonic counter used to drop out-of-order renders: switching branch/date
// starts a new load, and only the most recently started one may paint. Without
// this, a slower earlier request can finish last and overwrite the UI with a
// stale branch, mixing up the daily report.
let currentCashSeq = 0;

async function currentCashView(overrideBranch, overrideDate) {
  const seq = ++currentCashSeq;

  // Admins can inspect/manage any branch's cash (not just the branch they
  // logged in with); workers are always scoped to their own login branch.
  const isAdmin = userRole === "1";
  let branch = overrideBranch || getBranch();

  // The transaction/reset history is shown one day at a time, defaulting to
  // today. Any day can be picked.
  const now = new Date();
  const date = overrideDate || localDateString(now);

  let allBranchNames = [];
  if (isAdmin) {
    const branchesData = await api("/currentcash/branches");
    allBranchNames = Object.keys(branchesData.branches || {}).sort();
    // If the admin's own login branch has no record yet, default to the
    // first known branch so the view is never blank.
    if (!branch && allBranchNames.length) branch = allBranchNames[0];
  }

  // tzOffset (minutes east of UTC) lets the server work out the same "today".
  const tzOffset = -now.getTimezoneOffset();
  const [data, daily] = await Promise.all([
    api(
      `/currentcash?branch=${encodeURIComponent(branch)}` +
        `&date=${encodeURIComponent(date)}` +
        `&tzOffset=${tzOffset}`
    ),
    api(
      `/currentcash/daily?date=${encodeURIComponent(date)}` +
        `&tzOffset=${tzOffset}&branch=${encodeURIComponent(branch)}`
    ),
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
  // highlighted; clicking another branch reloads the view for it.
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

  // Workers see their own drawer's balance and card balance here. Admins get
  // the same money broken out per branch inside the daily report instead, so
  // the two cards are omitted for them.
  const cardsRow = el("div", null, { class: "cash-cards" });
  if (!isAdmin) {
    const balance = el("div", null, { class: "balance-card" });
    balance.appendChild(el("h3", t("balance")));

    // Show each currency only when its balance is above/below 0.
    const balances = data.balances || {};
    const nonZero = Object.entries(balances).filter(
      ([, value]) => Number(value) !== 0
    );
    if (nonZero.length === 0) {
      balance.appendChild(el("p", money(0), { class: "big" }));
    } else {
      const list = el("div");
      for (const [currency, value] of nonZero) {
        list.appendChild(
          el("p", `${money(value)} ${currency}`, { class: "big" })
        );
      }
      balance.appendChild(list);
    }

    // The branch's card balance - cleared together with the cash by "Reset to 0".
    const cardCard = el("div", null, { class: "balance-card" });
    cardCard.appendChild(el("h3", t("cardBalance")));
    cardCard.appendChild(el("p", money(data.cardBalance), { class: "big" }));

    const leftCol = el("div", null, { class: "cash-cards-left" });
    leftCol.appendChild(balance);
    leftCol.appendChild(cardCard);
    cardsRow.appendChild(leftCol);
  }

  // Country-wide daily report for the picked day. It is independent of the
  // branch selector above: insurances and cash are counted across all branches.
  const dailyCard = el("div", null, { class: "balance-card daily-report" });
  dailyCard.appendChild(el("h3", t("dailyReport")));
  const dailyStat = (label, value, hint) => {
    const attrs = { class: "daily-report-row" };
    if (hint) attrs.title = hint;
    const row = el("div", null, attrs);
    row.appendChild(el("span", label, { class: "muted" }));
    row.appendChild(el("span", value));
    return row;
  };
  // A per-branch money entry: one row per branch, each showing the branch name
  // and its per-currency amounts.
  const dailyBranchStat = (label, rows, hint) => {
    const attrs = { class: "daily-report-row" };
    if (hint) attrs.title = hint;
    const row = el("div", null, attrs);
    row.appendChild(el("span", label, { class: "muted" }));
    const list = el("div", null, { class: "daily-report-branches" });
    const items = rows || [];
    for (const entry of items) {
      const line = el("div", null, { class: "daily-report-branch" });
      line.appendChild(
        el("span", entry.Branch || t("unassignedBranch"), { class: "muted" })
      );
      line.appendChild(
        el(
          "span",
          renderCashBalances({ EUR: entry.EUR, TRY: entry.TRY })
        )
      );
      list.appendChild(line);
    }
    if (items.length === 0) list.appendChild(el("span", money(0)));
    row.appendChild(list);
    return row;
  };
  dailyCard.appendChild(
    dailyStat(t("totalInsurances"), String(daily.totalInsurances ?? 0))
  );
  dailyCard.appendChild(
    dailyStat(t("brokerInsurances"), String(daily.brokerInsurances ?? 0))
  );
  dailyCard.appendChild(
    dailyStat(t("walkInInsurances"), String(daily.walkInInsurances ?? 0))
  );
  dailyCard.appendChild(
    dailyStat(t("countryWideInsurances"), String(daily.countryWideInsurances ?? 0))
  );

  if (isAdmin) {
    // Card payments and broker-balance totals are daily, per-branch figures:
    // each branch's card money and its broker-balance-funded money for the day.
    dailyCard.appendChild(
      dailyBranchStat(
        t("cardPayments"),
        daily.cardPayments || [],
        t("cardPaymentsHint")
      )
    );
    dailyCard.appendChild(
      dailyBranchStat(
        t("brokerBalanceTotal"),
        daily.brokerBalance || [],
        t("brokerBalanceTotalHint")
      )
    );
  } else {
    // Total daily cash is a per-currency net (walk-in cash + manual increases −
    // manual reductions), rendered exactly like the balance card above. Hovering
    // over it explains precisely what it means and what it consists of.
    dailyCard.appendChild(
      dailyStat(
        t("totalDailyCash"),
        renderCashBalances(daily.totalDailyCash || {}),
        t("totalDailyCashHint")
      )
    );
  }

  // The selected branch's cash drawer balance at the end of the picked day. It
  // is walked back from the live balance, so choosing an older date shows how
  // much cash that branch actually had available on that day. Kept at the
  // bottom of the report.
  dailyCard.appendChild(
    dailyStat(
      fmt(t("availableCashBranch"), {
        branch: branch || t("unknownBranch"),
      }),
      renderCashBalances(daily.availableCash || {}),
      t("availableCashHint")
    )
  );

  cardsRow.appendChild(dailyCard);

  const actions = el("div", null, { class: "row" });
  const incBtn = el("button", t("increase"));
  const redBtn = el("button", t("reduce"), { class: "secondary" });
  const resetBtn = el("button", t("resetTo0"), { class: "danger" });
  actions.appendChild(incBtn);
  actions.appendChild(redBtn);
  actions.appendChild(resetBtn);

  function cashForm(kind, title) {
    const form = buildForm(
      [
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
      ],
      async (payload) => {
        // Attach the branch and the client's local creation time before sending.
        // The server stores CreatedAt as sent, instead of stamping it with the
        // database server's (UTC) clock.
        payload.branch = branch;
        payload.CreatedAt = localDateTimeNow();
        payload.TzOffset = -new Date().getTimezoneOffset();
        await api(`/currentcash/${kind}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        toast(
          kind === "increase"
            ? t("currentCashIncreased")
            : t("currentCashReduced"),
          "success"
        );
        closeModal();
        currentCashView(branch, date);
      },
      kind === "increase" ? t("increase") : t("reduce")
    );
    openModal(title, form);
  }
  incBtn.addEventListener("click", () =>
    cashForm("increase", t("currentCashIncreased"))
  );
  redBtn.addEventListener("click", () =>
    cashForm("reduce", t("currentCashReduced"))
  );
  resetBtn.addEventListener("click", async () => {
    if (!confirm(t("resetConfirm"))) return;
    try {
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
    const form = buildForm(
      [
        {
          key: "type",
          label: t("type"),
          type: "select",
          options: [
            { label: t("increase"), value: "increase" },
            { label: t("reduce"), value: "reduce" },
          ],
          value: tx.Type,
        },
        {
          key: "amount",
          label: t("amount"),
          type: "number",
          value: tx.Amount,
        },
        {
          key: "currency",
          label: t("currency"),
          type: "select",
          options: [
            { label: "EUR", value: "EUR" },
            { label: "TRY", value: "TRY" },
          ],
          value: tx.Currency || "EUR",
        },
        { key: "reason", label: t("reason"), value: tx.Reason },
      ],
      async (payload) => {
        // Stamp the correction's own ledger entries with the worker's local
        // time (the original transaction keeps its CreatedAt).
        payload.CreatedAt = localDateTimeNow();
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

  const txTable = renderTable(
    data.transactions,
    [
      { key: "Type", label: t("type") },
      { key: "Amount", label: t("amount"), format: (v) => money(v) },
      { key: "Currency", label: t("currency") },
      { key: "Username", label: t("user") },
      { key: "Reason", label: t("reason") },
      {
        key: "CreatedAt",
        label: t("created"),
        format: (v) => formatDateTime(v),
      },
    ],
    (tx) =>
      String(tx.Username) === String(username)
        ? [
            {
              label: t("edit"),
              class: "",
              onClick: () => openTransactionEditor(tx),
            },
          ]
        : []
  );
  // A "Reset to 0" clears the cash drawer (one `cash_resets` row per currency)
  // AND the branch's card balance (one `card_resets` row). Merge the two so the
  // Resets table also shows the card amount kept, tagged as "Card payments".
  const cardResets = (data.cardResets || []).map((r) => ({
    ...r,
    Currency: t("cardPayments"),
  }));
  const resetTable = renderTable(
    [...(data.resets || []), ...cardResets].sort((a, b) =>
      String(b.CreatedAt || "").localeCompare(String(a.CreatedAt || ""))
    ),
    [
      { key: "Username", label: t("user") },
      { key: "Currency", label: t("currency") },
      { key: "KeptAmount", label: t("kept"), format: (v) => money(v) },
      { key: "CreatedAt", label: t("created"), format: (v) => formatDateTime(v) },
    ]
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
  const dateRow = el("div", null, { class: "row filter-row" });
  dateRow.appendChild(field(t("date"), dateInput));

  const topNodes = [heading];
  if (branchSelector.children.length > 0) topNodes.push(branchSelector);

  Content.replaceChildren(
    ...topNodes,
    cardsRow,
    el("p", t("currentCashHint"), { class: "muted" }),
    actions,
    dateRow,
    el("h3", t("transactions")),
    txTable,
    el("h3", t("resets")),
    resetTable
  );
}

// Card balance overview (admin only): every branch's card balance, read-only.
// A branch's card balance is cleared only by that branch's "Reset to 0" on the
// Current cash screen, together with its cash. Workers see their own branch's
// card balance there instead.
async function cardView() {
  const data = await api("/cardpayments");
  const card = el("div", null, { class: "balance-card" });
  card.appendChild(el("h3", t("cardBalanceTotal")));
  card.appendChild(el("p", money(data.cardBalance), { class: "big" }));

  const branchLabel = (b) => (b ? b : t("unassignedBranch"));
  const branchTable = renderTable(data.branches || [], [
    { key: "Branch", label: t("branch"), format: (v) => branchLabel(v) },
    { key: "CardBalance", label: t("cardBalance"), format: (v) => money(v) },
  ]);

  const children = [el("h2", t("cardPayments")), card, branchTable];

  const resetTable = renderTable(data.resets, [
    { key: "Branch", label: t("branch"), format: (v) => branchLabel(v) },
    { key: "Username", label: t("user") },
    { key: "KeptAmount", label: t("kept"), format: (v) => money(v) },
    { key: "CreatedAt", label: t("created"), format: (v) => formatDateTime(v) },
  ]);
  children.push(el("h3", t("resets")), resetTable);

  Content.replaceChildren(...children);
}

// Sort state for the brokers table: key is null (server order), "CashBalance"
// or "InactivePolicies"; dir is "desc" (highest first) or "asc" (lowest first).
let brokerSort = { key: null, dir: "desc" };

// The whole row is flagged when the broker has no email.
function brokerHasNoEmail(b) {
  const emails = Array.isArray(b.emails)
    ? b.emails.filter((e) => String(e || "").trim() !== "")
    : [];
  return emails.length === 0;
}

// The "cut off" button shown in the leftmost column of the brokers list. It is
// disabled until an admin can act: available once the broker is two weeks
// behind on payment (overdue) or already cut off (so it can be re-enabled).
function brokerCutOffButton(b) {
  const cutOff = Boolean(b.cutOff);
  const overdue = Boolean(b.overdue);
  const canToggle = userRole === "1" && (overdue || cutOff);

  const label = cutOff ? t("brokerCutOffRestore") : t("brokerCutOff");
  const btn = el("button", label, {
    class: `small ${cutOff ? "danger" : "secondary"}`,
    type: "button",
  });
  btn.disabled = !canToggle;
  btn.title = cutOff
    ? t("brokerCutOffHint")
    : overdue
      ? t("brokerCutOffReady")
      : userRole !== "1"
        ? t("brokerCutOffAdminOnly")
        : t("brokerCutOffDisabledHint");

  if (canToggle) {
    btn.addEventListener("click", () => toggleBrokerCutOff(b));
  }
  return btn;
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

async function brokersView() {
  const data = await api("/brokers");
  const isAdmin = userRole === "1";

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
    const toggle = el("label", null, { class: "broker-toggle" });
    const toggleInput = input("checkbox");
    toggleInput.checked = data.allowNegativeBalance !== false;
    toggle.appendChild(toggleInput);
    toggle.appendChild(el("span", t("brokerAllowNegative")));
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
  const buildTable = () => {
    let brokers = data.brokers || [];
    if (brokerSort.key) {
      const dir = brokerSort.dir === "desc" ? -1 : 1;
      const k = brokerSort.key;
      brokers = [...brokers].sort(
        (a, b) => dir * (Number(a[k]) - Number(b[k]))
      );
    }
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
        tableHolder.replaceChildren(buildTable());
      },
    });
    return renderTable(
      brokers,
      [
        {
          key: "cutoff",
          label: t("cutOff"),
          render: (_value, b) => brokerCutOffButton(b),
        },
        {
          key: "Name",
          label: t("name"),
          // Only admins may open a broker's pricing by clicking its name.
          // Workers just see the plain name (row click opens balance history).
          onClick: isAdmin ? (b) => brokerPricingEditor(b) : undefined,
        },
        {
          key: "CashBalance",
          label: t("balance"),
          format: (v) => money(v),
          ...sortHeader("CashBalance"),
        },
        {
          key: "batches",
          label: t("blancBatches"),
          format: (v) => formatBlancBatches(v),
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
      [
        {
          label: t("increase"),
          class: "",
          onClick: (b) => brokerAdjust(b, "increase"),
        },
        {
          label: t("reduce"),
          class: "secondary",
          onClick: (b) => brokerAdjust(b, "reduce"),
        },
        ...(isAdmin
          ? [
              {
                label: t("edit"),
                class: "secondary",
                onClick: (b) => brokerEditForm(b),
              },
              {
                label: t("blancBatches"),
                class: "secondary",
                onClick: (b) => brokerBatchesView(b),
              },
              {
                label: t("delete"),
                class: "danger",
                onClick: async (b) => {
                  if (!confirm(`${t("deleteConfirm")} "${b.Name}"?`)) return;
                  try {
                    await api(`/brokers/${b.id}`, { method: "DELETE" });
                    toast(t("brokerDeleted"), "success");
                    brokersView();
                  } catch (err) {
                    toast(err.message, "error");
                  }
                },
              },
            ]
          : []),
      ],
      (b) => {
        const classes = [];
        if (brokerHasNoEmail(b)) classes.push("row-broker-alert");
        if (b.overdue) classes.push("row-broker-overdue");
        return classes.join(" ");
      },
      (b) => brokerHistoryView(b)
    );
  };
  tableHolder.appendChild(buildTable());

  Content.replaceChildren(el("h2", t("brokers")), toolbar, tableHolder);
}

// Label for a broker balance movement type (policy, annulment, deletion,
// price_change, increase, reduce, adjust). Unknown types are shown as they are.
function movementTypeLabel(type) {
  return t(`movement.${type}`, type || "");
}

// Signed, currency-precise amount (e.g. "+25.00" / "-10.00").
function signedMoney(value) {
  const n = Number(value);
  const abs = money(Math.abs(Number.isFinite(n) ? n : 0));
  return `${n >= 0 ? "+" : "-"}${abs}`;
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

// The broker balance history "page": the broker's balance movements for the
// last month, 40 per page, newest first, with a back button to the list. A
// calendar picker scopes it to a single day.
async function brokerHistoryView(broker, page = 1, date = "", includeDeleted = false) {
  Content.replaceChildren(el("p", t("loading"), { class: "muted" }));
  try {
    const pageSize = 40;
    const params = new URLSearchParams({
      page: String(page),
      pageSize: String(pageSize),
      // Lets the server resolve the default "last 30 days" window in the
      // worker's local time, matching the client-stamped movement times.
      tzOffset: String(-new Date().getTimezoneOffset()),
    });
    if (date) {
      params.set("since", date);
      params.set("until", nextLocalDate(date));
    }
    if (includeDeleted) params.set("includeDeleted", "1");
    const data = await api(`/brokers/${broker.id}/history?${params.toString()}`);
    renderBrokerHistory(broker, data, page, date, includeDeleted);
  } catch (err) {
    const message = translateError(err && err.message ? err.message : "");
    Content.replaceChildren(
      el("p", `${t("errorPrefix")}: ${message}`, { class: "muted" })
    );
  }
}

function renderBrokerHistory(broker, data, page, date = "", includeDeleted = false) {
  const backBtn = el("button", t("back"), { class: "secondary", type: "button" });
  backBtn.addEventListener("click", () => brokersView());

  const heading = el("h2", `${t("brokerHistory")}: ${broker.Name}`);
  const range = `${formatDateTime(data.since)} – ${formatDateTime(data.until)}`;
  const summary = el(
    "p",
    `${t("balance")}: ${money(data.broker.CashBalance)} · ${t("netChange")}: ${signedMoney(data.netChange)} · ${range}`,
    { class: "muted" }
  );

  // Calendar picker scopes the history to a single day; clearing it falls back
  // to the default last-month window.
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
    dateRow.appendChild(field(t("includeDeleted"), includeDeletedInput));
  }

  // Total (net) sum of the movements across the whole scoped range, right-aligned
  // above the table. The server returns this as netChange over the entire window,
  // so it stays correct regardless of which page is shown.
  const totalRow = el("div", null, { class: "row history-total-row" });
  totalRow.appendChild(
    el("span", `${t("total")}: ${signedMoney(data.netChange)}`, { class: "muted" })
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
            label: t("delete"),
            class: "danger",
            onClick: async (m) => {
              if (!confirm(t("deleteMovementConfirm"))) return;
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

  const table = renderTable(
    data.movements || [],
    [
      { key: "CreatedAt", label: t("date"), format: (v) => formatDateTime(v) },
      { key: "Type", label: t("type"), format: (v) => movementTypeLabel(v) },
      { key: "BlancNumber", label: t("blankNo"), format: (v) => v || "—" },
      { key: "Reason", label: t("reason") },
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
    historyActions
  );

  const pager = pagerControls(data.totalPages, page, (p) =>
    brokerHistoryView(broker, p, date, includeDeleted)
  );

  const children = [backBtn, heading, summary, dateRow, totalRow, table, pager];

  // Soft-deleted movements are kept in the database and only shown when the
  // admin asks for them (Include deleted). Each one can be brought straight back.
  if (userRole === "1" && Array.isArray(data.deleted) && data.deleted.length) {
    children.push(el("h3", t("deletedMovements")));
    children.push(
      renderTable(
        data.deleted,
        [
          { key: "CreatedAt", label: t("date"), format: (v) => formatDateTime(v) },
          { key: "Type", label: t("type"), format: (v) => movementTypeLabel(v) },
          { key: "BlancNumber", label: t("blankNo"), format: (v) => v || "—" },
          {
            key: "Reason",
            label: t("reason"),
            format: (v, m) => `${v || ""}${m.DeletedBy ? ` (${m.DeletedBy})` : ""}`,
          },
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
        () => "row-deleted"
      )
    );
  }

  Content.replaceChildren(...children);
}

// Restore a previously soft-deleted broker movement. The server re-applies the
// movement's amount to the broker's balance and clears the Deleted flag, putting
// the row back exactly where it was.
async function restoreBrokerMovement(broker, movement, page, date) {
  if (!confirm(t("restoreMovementConfirm"))) return;
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
// the broker balance by the difference. Type, blank number, reason and author
// are stored as entered.
function brokerHistoryEditForm(broker, movement, page, date, includeDeleted = false) {
  const typeOptions = [
    "policy",
    "annulment",
    "deletion",
    "price_change",
    "increase",
    "reduce",
    "adjust",
  ].map((value) => ({ label: movementTypeLabel(value), value }));
  const form = buildForm(
    [
      {
        key: "amount",
        label: t("amount"),
        type: "number",
        step: "0.01",
        value: movement.Amount,
      },
      {
        key: "type",
        label: t("type"),
        type: "select",
        options: typeOptions,
        value: movement.Type,
      },
      {
        key: "blancNumber",
        label: t("blankNo"),
        value: movement.BlancNumber || "",
      },
      { key: "reason", label: t("reason"), value: movement.Reason || "" },
      { key: "author", label: t("author"), value: movement.Author || "" },
    ],
    async (payload) => {
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

function brokerAdjust(broker, kind) {
  const form = buildForm(
    [
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
    ],
    async (payload) => {
      // The resulting broker movement (and, for an increase, the mirrored cash
      // transaction) is stamped with the worker's local time.
      payload.CreatedAt = localDateTimeNow();
      await api(`/brokers/${broker.id}/${kind}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      toast(
        kind === "increase"
          ? t("brokerBalanceIncreased")
          : t("brokerBalanceReduced"),
        "success"
      );
      closeModal();
      brokersView();
    },
    kind === "increase" ? t("increase") : t("reduce")
  );
  openModal(
    `${kind === "increase" ? t("increase") : t("reduce")} ${broker.Name}`,
    form
  );
}

function brokerCreateForm() {
  const form = buildForm(
    [
      { key: "Name", label: t("name"), value: "" },
      { key: "CashBalance", label: t("balance"), type: "number", value: 0 },
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
      {
        key: "CashBalance",
        label: t("balance"),
        type: "number",
        value: broker.CashBalance,
      },
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
      // A balance change records an "adjust" broker movement; stamp it with the
      // worker's local time.
      payload.CreatedAt = localDateTimeNow();
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

// Compact "start–end, start–end" text for the brokers table.
function formatBlancBatches(batches) {
  if (!Array.isArray(batches) || batches.length === 0) return "-";
  return batches.map((b) => `${b.RangeStart}–${b.RangeEnd}`).join(", ");
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
                if (!confirm(msg)) return;
                try {
                  await send(`/${b.id}`, "DELETE");
                  toast(t("batchDeleted"), "success");
                } catch (err) {
                  toast(err.message, "error");
                }
              },
            },
          ]
        : null
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
  "Author",
  "Annulled",
  "PaymentType",
];

// Comparable value of one cell: a number for price/status, a timestamp for the
// creation date (parsed exactly like formatDateTime, so the order matches what
// is displayed) and text for broker/author/payment type. Empty or unparsable
// values become null and always sink to the bottom of the list.
function insuranceSortValue(item, key) {
  const raw = item ? item[key] : null;
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return null;
  }
  if (key === "Price" || key === "Annulled") {
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
  const reason = String(item.AnnulReason || "").trim().toLowerCase();
  const payer = ["broker", "worker", "none"].includes(reason)
    ? ` (${t(`annul.payer.${reason}`)})`
    : "";
  return `${t("annulled")}${payer}`;
}

// Row tint for a policy in a table. Annulled rows are tinted by who was at
// fault (worker / broker / no fault); unknown/legacy reasons fall back to a
// plain annulled tint.
function annulledRowClass(item) {
  if (!item || !item.Annulled) return "";
  const reason = String(item.AnnulReason || "").trim().toLowerCase();
  if (["broker", "worker", "none"].includes(reason)) {
    return `row-annulled-${reason}`;
  }
  return "row-annulled";
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


async function adminInsurancesByDate(defaultAuthor = "", titleKey = "nav.insurancesByDate") {
  // Admin/worker filtered list: GET /insurances?author=&date=&policyNumber=&blancNumber=&carNumber=&broker=&annulled=&payment=
  // All fields are optional, but at least one must be filled in to search. Any
  // single criteria (or any combination of them) can be used.
  // The author field is intentionally empty by default so a search by, e.g.,
  // only a car number is not silently narrowed to the current user's own
  // records. Workers reach this view through the "Insurances" tab, which also
  // leaves the author field empty so they can find and edit any policy.
  // PolicyNumber/BlancNumber/CarNumber/Broker match partially (substring) on
  // the server, so a worker can search by a fragment of the number, or by a
  // partially typed broker name ("Euro" finds the "Euroins" policies) too.
  // The result table also lists the broker and the author of every policy and
  // can be sorted by price, creation date, broker, author, status and payment
  // type by clicking the column headers (see the sorting helpers above).
  const authorInput = input("text", defaultAuthor);
  const brokerInput = input("text", "");
  const dateInput = input("date", "");
  const policyNumberInput = input("text", "");
  const blancNumberInput = input("text", "");
  const carNumberInput = input("text", "");
  const paymentInput = select(
    [
      { label: "", value: "" },
      { label: t("payment.Cash"), value: "Cash" },
      { label: t("payment.Card"), value: "Card" },
      { label: t("payment.Broker"), value: "Broker" },
    ],
    ""
  );
  const annulledInput = input("checkbox");
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
  form.appendChild(field(t("annulledFilter"), annulledInput));
  // Admins can also look up soft-deleted insurances (e.g. to check who deleted
  // a policy and when). Workers never get the option - the server ignores the
  // flag for them anyway.
  const isAdminSearch = userRole === "1";
  const includeDeletedInput = isAdminSearch ? input("checkbox") : null;
  if (includeDeletedInput) {
    form.appendChild(field(t("includeDeleted"), includeDeletedInput));
  }
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

  // Rows of the last successful search, kept so clicking a column header can
  // re-sort and re-render them without asking the server again.
  let lastRows = [];

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
          {
            key: "Price",
            label: t("price"),
            // Admins always see the price. Workers see walk-in (broker-less)
            // prices but never a broker (email) price. For a walk-in card
            // payment the +2 bank fee is shown on top so the worker knows the
            // total to charge (it is never stored).
            format: (_v, item) => (canSeePrice(item) ? money(chargePrice(item)) : ""),
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
            // Re-run the search after a save (like annul/delete do here) so the
            // corrected price/payment type is re-read from the server.
            onClick: () => openInsuranceEditor(i, () => runSearch()),
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
          // Deleting is an admin-only action (enforced server-side too).
          ...(userRole === "1"
            ? [
                {
                  label: t("delete"),
                  class: "danger",
                  onClick: () => deleteInsurance(i, () => runSearch()),
                },
              ]
            : []),
        ],
        (i) => (i.Deleted ? "row-deleted" : annulledRowClass(i))
      )
    );
  }

  async function runSearch() {
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
      let rows = data.insurances || [];
      // The server matches the broker name itself (script-insensitively). This
      // extra pass only matters while the deployed server still predates the
      // `broker` parameter, so the new field keeps working right after a client
      // update; once the server filters too, every returned row already matches
      // and the pass is a no-op. It uses the same transliteration-aware match.
      if (broker) {
        rows = rows.filter((r) => brokerNameMatches(r.Broker, broker));
      }
      // Keep the rows so the column headers can re-sort them locally.
      lastRows = rows;
      renderResults();
    } catch (err) {
      toast(err.message, "error");
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
      if (e.key === "Enter") {
        e.preventDefault();
        runSearch();
      }
    });
  });
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
    // next search starts in the default (server) order again.
    lastRows = [];
    insuranceSort = { key: null, dir: "desc" };
    exportBtn.disabled = true;
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

  Content.replaceChildren(el("h2", t(titleKey)), form, result);
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
    { label: t("price"), width: 10 },
    { label: t("currency"), width: 9 },
    { label: t("payment"), width: 14 },
    { label: t("broker"), width: 20 },
    { label: t("author"), width: 14 },
    { label: t("created"), width: 17 },
    { label: t("status"), width: 12 },
  ];
  const text = (v) => (v === undefined || v === null ? "" : String(v));
  const body = (rows || []).map((r, idx) => {
    const price = chargePrice(r);
    const showPrice = !canSeePrice || canSeePrice(r);
    // Same parsing as the display/sort (local wall-clock time).
    const ms = insuranceSortValue(r, "CreationDate");
    const serial = ms === null ? null : xlsxDateSerial(new Date(ms));
    return [
      idx + 1,
      text(r.BlancNumber),
      text(r.PolicyNumber),
      text(r.CarNumber),
      showPrice && Number.isFinite(price)
        ? { value: price, style: "money" }
        : "",
      text(r.CurrencyType),
      paymentLabel(r.PaymentType),
      text(r.Broker),
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
//   [НОМЕР НА ПОЛИЦА] or [№ ПОЛИЦА] -> PolicyNumber
//   [НОМЕР НА СТИКЕР] or [№ БЛАНКА] -> BlancNumber
//   [ВАЛИДЕН ОТ] or [ДАТА]          -> StartDate
//   [ВАЛИДЕН ДО] or [СРОК]          -> StartDate + Duration (days)
//   [ДКН]                          -> CarNumber
//
// Two report layouts are supported, since daily reports in the field use a
// shorter header set than the one originally designed here:
//   - Full layout: explicit "ВАЛИДЕН ОТ" / "ВАЛИДЕН ДО" date columns.
//   - Shift-log layout (e.g. "FINANSOV OTCHET" files): a single "ДАТА" column
//     plus a "СРОК" (term) column holding a shorthand like "15D"/"1M"/"3M",
//     from which the valid-until date is derived.
//
// The pure helpers used here (RECON_COLUMNS, RECON_TERM_COLUMN,
// reconFindColumns, reconParseFileRows, reconCompareRow, reconDbValues, and the
// recon* normalisation/date helpers) live in reconcile-core.js, loaded before
// this file so they can be unit-tested in Node without the DOM.
// ---------------------------------------------------------------------------

async function reconcileReport(rows, dbDate) {
  const cols = reconFindColumns(rows);
  if (cols.missing.length) {
    throw new Error(
      `${t("reconcile.columnsNotFound")}: ${cols.missing
        .map((c) => `[${c.header}]`)
        .join(", ")}`
    );
  }
  const fileRows = reconParseFileRows(rows, cols.headerRow, cols.index);

  const data = await api("/admin/insurances");
  const insurances = data.insurances || [];

  const byPolicy = new Map();
  const byBlank = new Map();
  const addTo = (map, key, ins) => {
    if (!key) return;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(ins);
  };
  for (const ins of insurances) {
    addTo(byPolicy, reconNormId(ins.PolicyNumber), ins);
    addTo(byBlank, reconNormId(ins.BlancNumber), ins);
  }

  const matchedInsurances = new Set();
  const missingFromDb = [];
  const mismatches = [];
  let matched = 0;

  for (const fileRow of fileRows) {
    const candidates = new Set([
      ...(byPolicy.get(reconNormId(fileRow.policy)) || []),
      ...(byBlank.get(reconNormId(fileRow.blank)) || []),
    ]);

    if (candidates.size === 0) {
      missingFromDb.push(fileRow);
      continue;
    }

    let best = null;
    for (const ins of candidates) {
      const cmp = reconCompareRow(fileRow, ins);
      if (!best || cmp.count < best.cmp.count) best = { ins, cmp };
    }
    matchedInsurances.add(best.ins);
    if (best.cmp.count === 0) matched++;
    else mismatches.push({ rowNo: fileRow.rowNo, ...best.cmp.fields });
  }

  const missingFromFile = dbDate
    ? insurances.filter(
        (ins) =>
          !matchedInsurances.has(ins) &&
          reconDbDate(ins.CreationDate) === dbDate
      )
    : [];

  return {
    fileRowCount: fileRows.length,
    matched,
    missingFromDb,
    missingFromFile,
    mismatches,
    dbDate,
  };
}

function reconRenderResults(result) {
  const wrap = el("div", null, { class: "recon-results" });

  const stats = el("div", null, { class: "stat-grid" });
  const addStat = (label, value, cls) => {
    const card = el("div", null, { class: `stat-card ${cls || ""}` });
    card.appendChild(el("h3", label));
    card.appendChild(el("p", String(value), { class: "big" }));
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
    result.missingFromDb.length ? "recon-bad" : ""
  );
  addStat(
    t("reconcile.missingFromFile"),
    result.missingFromFile.length,
    result.missingFromFile.length ? "recon-bad" : ""
  );
  addStat(
    t("reconcile.mismatches"),
    result.mismatches.length,
    result.mismatches.length ? "recon-warn" : ""
  );
  wrap.appendChild(stats);

  // --- Missing rows (with the side they are missing from) -----------------
  const missingItems = [
    ...result.missingFromDb.map((r) => ({
      source: t("reconcile.database"),
      rowNo: r.rowNo,
      policy: r.policy,
      blank: r.blank,
      from: r.fromKey ? reconShowDate(r.fromKey) : r.fromRaw,
      to: r.toKey ? reconShowDate(r.toKey) : r.toRaw,
      car: r.car,
    })),
    ...result.missingFromFile.map((ins) => {
      const db = reconDbValues(ins);
      return {
        source: t("reconcile.file"),
        rowNo: "",
        policy: db.policy,
        blank: db.blank,
        from: reconShowDate(db.fromKey),
        to: reconShowDate(db.toKey),
        car: db.car,
      };
    }),
  ];

  wrap.appendChild(el("h3", `${t("reconcile.missingFrom")}…`));
  wrap.appendChild(
    renderTable(
      missingItems,
      [
        { key: "source", label: t("reconcile.missingFrom") },
        { key: "rowNo", label: t("reconcile.row") },
        ...RECON_COLUMNS.map((c) => ({ key: c.key, label: t(c.label) })),
      ],
      null,
      () => "row-missing"
    )
  );

  // --- Partial data mismatches (mismatching cells in dark red) ------------
  const mismatchCol = (col) => ({
    key: col.key,
    label: t(col.label),
    format: (v) =>
      v.mismatch
        ? `${t("reconcile.fileValue")}: ${v.file || "—"}\n${t(
            "reconcile.dbValue"
          )}: ${v.db || "—"}`
        : v.file,
    cellClass: (item) => (item[col.key].mismatch ? "cell-mismatch" : ""),
  });

  wrap.appendChild(el("h3", t("reconcile.mismatches")));
  wrap.appendChild(
    renderTable(result.mismatches, [
      { key: "rowNo", label: t("reconcile.row") },
      ...RECON_COLUMNS.map(mismatchCol),
    ])
  );

  if (
    !missingItems.length &&
    !result.mismatches.length &&
    result.fileRowCount > 0
  ) {
    wrap.appendChild(
      el("p", t("reconcile.allGood"), { class: "recon-good-text" })
    );
  }
  return wrap;
}

async function reconcileView() {
  let selectedFile = null;

  const fileInput = el("input", null, { type: "file" });
  fileInput.accept =
    ".xlsx,.xlsm,.xltx,.xltm,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel.sheet.macroEnabled.12,application/vnd.openxmlformats-officedocument.spreadsheetml.template,application/vnd.ms-excel.template.macroEnabled.12";
  fileInput.classList.add("hidden");

  const dropZone = el("div", null, { class: "drop-zone", tabindex: "0" });
  dropZone.appendChild(el("strong", t("reconcile.dropHint")));
  dropZone.appendChild(
    el("span", t("reconcile.dropHint2"), { class: "muted" })
  );
  const fileName = el("span", t("reconcile.noFile"), { class: "muted" });
  dropZone.appendChild(fileName);

  const setFile = (file) => {
    if (!file) return;
    if (!/\.(xlsx|xlsm|xltx|xltm)$/i.test(file.name)) {
      toast(t("reconcile.invalidFile"), "error");
      return;
    }
    selectedFile = file;
    fileName.textContent = file.name;
    dropZone.classList.add("has-file");
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
  const dateInput = input(
    "date",
    `${today.getFullYear()}-${reconPad(today.getMonth() + 1)}-${reconPad(
      today.getDate()
    )}`
  );
  const dateField = field(t("reconcile.dbDate"), dateInput);

  const runBtn = el("button", t("reconcile.run"), { type: "button" });
  const controls = el("div", null, { class: "row filter-row" });
  controls.appendChild(dateField);
  controls.appendChild(runBtn);

  const result = el("div");

  // Runs the selected file through the full pipeline: parse the first sheet,
  // reconcile against the database and render the comparison.
  const runReconcile = async (file, btn) => {
    btn.disabled = true;
    result.replaceChildren(el("p", t("loading"), { class: "muted" }));
    try {
      const sheetRows = await readXlsxFirstSheet(await file.arrayBuffer());
      const report = await reconcileReport(sheetRows, dateInput.value);
      result.replaceChildren(reconRenderResults(report));
    } catch (err) {
      result.replaceChildren();
      toast(err.message, "error");
    } finally {
      btn.disabled = false;
    }
  };

  runBtn.addEventListener("click", async () => {
    if (!selectedFile) {
      toast(t("reconcile.noFile"), "error");
      return;
    }
    await runReconcile(selectedFile, runBtn);
  });

  Content.replaceChildren(
    el("h2", t("reconcile.title")),
    dropZone,
    fileInput,
    controls,
    el("p", `${t("reconcile.dbDateHint")} ${t("reconcile.endNote")}`, {
      class: "muted",
    }),
    result
  );
}

// ---------------------------------------------------------------------------
// Worker views
// ---------------------------------------------------------------------------
async function workerDashboard() {
  Content.replaceChildren(
    el("h2", t("unreadEmails")),
    emailCardsContainer()
  );
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
// Navigation setup
// ---------------------------------------------------------------------------
const NAV_DEFS = {
  1: [
    { key: "nav.dashboard", load: adminDashboard },
    { key: "nav.users", load: adminUsers },
    { key: "nav.insurancesByDate", load: adminInsurancesByDate },
    { key: "nav.currentCash", load: currentCashView },
    { key: "nav.card", load: cardView },
    { key: "nav.brokers", load: brokersView },
    { key: "nav.reconcile", load: reconcileView },
  ],
  2: [
    { key: "nav.dashboard", load: workerDashboard },
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

let activeNav = null;

function renderHeader() {
  HeaderTitle.textContent = t("nav.dashboard");
  HeaderSub.textContent = `${username} · ${roleLabel(userRole)}`;
  Nav.replaceChildren();

  const defs = NAV_DEFS[userRole] || [];
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

  if (userRole === "1" || userRole === "2") {
    const addBtn = el("button", t("addInsurance"));
    addBtn.addEventListener("click", () => {
      // This is a walk-in (or admin back-fill) insurance, not a
      // broker-requested one: make sure no leftover "pendingEmail" makes it
      // look like an email-sourced insurance.
      localStorage.removeItem("pendingEmail");
      const page =
        userRole === "1"
          ? "renderer/AdminInsurance/AdminInsurance.html"
          : "renderer/AddInsurance/AddInsurance.html";
      window.bridge.LoadNewPage(page);
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
  setupPresenceSocket();
  fetchUnreadEmails();
  initializeBrokerPricing();

  const defs = NAV_DEFS[userRole] || [];
  if (defs.length) {
    activeNav = defs[0];
    const first = Nav.children[0];
    if (first) first.classList.add("active");
    await runLoader(defs[0].load);
  }
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
