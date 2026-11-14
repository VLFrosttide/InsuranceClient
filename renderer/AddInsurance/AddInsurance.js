"use strict";

if (!requireLogin()) {
  throw new Error("Not logged in");
}

const DurationOptions = ["15 дена", "1 месец", "3 месеца"];
const DurationInput = document.getElementById("DurationInput");
const StartDateInput = document.getElementById("StartDateInput");
const InsuranceForm = document.getElementById("InsuranceForm");
const SubmitFormButton = document.getElementById("SubmitFormButton");
const ClearButton = document.getElementById("ClearButton");
const BackButton = document.getElementById("BackButton");
const LangButton = document.getElementById("LangButton");
const DisplayMsg = document.getElementById("DisplayMsg");
const EmailSide = document.getElementById("EmailSide");
const EmailSideTitle = document.getElementById("EmailSideTitle");
const EmailSideBody = document.getElementById("EmailSideBody");
const ReplySection = document.getElementById("ReplySection");
const ReplyInput = document.getElementById("ReplyInput");
const ReplyButton = document.getElementById("ReplyButton");
const ConversationSection = document.getElementById("ConversationSection");
const ConversationStatus = document.getElementById("ConversationStatus");
const ConversationHistory = document.getElementById("ConversationHistory");

// File drop area
const DropArea = document.getElementById("DropArea");
const FileInput = document.getElementById("FileInput");
const DroppedFiles = document.getElementById("DroppedFiles");

// Image viewer
const ImageViewer = document.getElementById("ImageViewer");
const ViewerImage = document.getElementById("ViewerImage");
const ViewerZoomIn = document.getElementById("ViewerZoomIn");
const ViewerZoomOut = document.getElementById("ViewerZoomOut");
const ViewerResetZoom = document.getElementById("ViewerResetZoom");
const ViewerRotateLeft = document.getElementById("ViewerRotateLeft");
const ViewerRotateRight = document.getElementById("ViewerRotateRight");
const ViewerPrint = document.getElementById("ViewerPrint");
const ViewerClose = document.getElementById("ViewerClose");

const FormInputArray = Array.from(document.getElementsByClassName("FormInput"));
const ClearFormArray = Array.from(document.getElementsByClassName("ClearForm"));

let droppedFiles = []; // { filename, mimeType, size, base64 }
let viewerScale = 1;
let viewerRotation = 0; // degrees, always one of 0 / 90 / 180 / 270

// Scroll-to-cycle for dropdowns. Works while the mouse hovers the select (no
// focus needed). A "change" event is dispatched so the price auto-calculates
// like a normal selection.
function enableWheelSelect(select) {
  if (!select) return;
  select.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      const count = select.options.length;
      if (!count) return;
      const step = e.deltaY > 0 ? 1 : -1;
      select.selectedIndex = (select.selectedIndex + step + count) % count;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    },
    { passive: false }
  );
}

enableWheelSelect(DurationInput);
enableWheelSelect(document.getElementById("AutoTypeInput"));

// Make the whole date field open the calendar on click, not just the small
// icon on the right. Clicking the input (or its label) triggers the native
// date picker if the browser supports showPicker(); otherwise a normal focus
// still lets the user type a date.
function openDatePicker(input) {
  if (!input) input = StartDateInput;
  if (!input) return;
  try {
    if (typeof input.showPicker === "function") input.showPicker();
    else input.focus();
  } catch {
    input.focus();
  }
}

if (StartDateInput) {
  StartDateInput.addEventListener("click", () =>
    openDatePicker(StartDateInput)
  );
  const startLabel = document.querySelector('label[for="StartDateInput"]');
  if (startLabel) {
    startLabel.addEventListener("click", (e) => {
      e.preventDefault();
      openDatePicker(StartDateInput);
    });
  }
}
// Seed sensible defaults.
DurationInput.value = DurationOptions[1];

// Language toggle.
function syncLangButton() {
  if (!LangButton) return;
  LangButton.textContent = getLang() === "bg" ? "EN" : "BG";
}
LangButton.addEventListener("click", () => {
  toggleLang();
  syncLangButton();
  // Re-render the dynamic email panel and dropped-file list so their labels
  // follow the newly selected language too (static labels are handled by
  // translatePage, invoked inside toggleLang).
  renderEmailSide();
  renderDroppedFiles();
  requestEmailAttachments();
});
syncLangButton();

// ---------------------------------------------------------------------------
// Pending unread email (set by the dashboard before navigating here)
// ---------------------------------------------------------------------------
let PendingEmail = null;
try {
  const raw = localStorage.getItem("pendingEmail");
  if (raw) PendingEmail = JSON.parse(raw);
} catch {
  PendingEmail = null;
}

// Whether this form was opened from an email card (true) or from the
// "+ Add Insurance" button (walk-in, false). Captured once at load: the
// PendingEmail object itself is cleared after a successful save, but the
// page keeps the date rules of the mode it was opened in.
const OpenedFromEmail = !!PendingEmail;

// Today's date as YYYY-MM-DD in local time — the value format expected by
// <input type="date">. Built from local components (not toISOString) so the
// day never shifts around midnight.
function todayLocalDate() {
  const now = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

// The current local date and time as "YYYY-MM-DD HH:MM:SS" (MySQL DATETIME).
// Sent as the insurance's creation time, which the server stores as is.
function localDateTimeNow() {
  const now = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return (
    `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} ` +
    `${p(now.getHours())}:${p(now.getMinutes())}:${p(now.getSeconds())}`
  );
}

// Walk-in insurances start with today's date pre-filled. Email insurances
// keep the date unselected on purpose: the worker must choose it, and the
// submit is rejected with an error while it is still empty.
if (!OpenedFromEmail && StartDateInput) {
  StartDateInput.value = todayLocalDate();
}

let emailSocket = null;

// The server sends email attachments as metadata only ({ id, filename,
// mimeType, size }). The bytes of EVERY attachment (images, PDFs, documents…)
// are fetched lazily over the WebSocket via a "get_attachment" message. This
// maps an attachment id to its on-screen element so the get_attachment reply
// can fill it in once the bytes arrive: images get an <img> preview, any other
// file gets a clickable tile that opens it with the system's default app.
const emailAttachmentEntries = new Map(); // id -> { img|tile, att, wrap, requested, attempts, gaveUp, base64 }

function isImageAttachment(att) {
  return typeof att.mimeType === "string" && att.mimeType.startsWith("image/");
}

// --- Attachment loading resilience -------------------------------------------
// Attachment bytes are fetched lazily over the WebSocket. A slow or unstable
// connection can lose either the request or its reply (a half-open socket
// swallows the send silently even though its readyState is still OPEN), which
// previously left pictures stuck in the "loading" state forever. These bounds
// retry automatically with backoff, give up gracefully only after several
// failures, and re-request anything still missing whenever the socket
// reconnects.
const ATTACHMENT_TIMEOUT_BASE_MS = 30000; // grace period before assuming the request was lost
const ATTACHMENT_TIMEOUT_MAX_MS = 5 * 60 * 1000; // hard cap for very large files
const ATTACHMENT_SLOW_BYTES_PER_SEC = 32 * 1024; // floor for a genuinely slow link
const ATTACHMENT_MAX_ATTEMPTS = 6; // requests per attachment per connection
const ATTACHMENT_RETRY_BASE_MS = 1500; // first retry delay (doubles each time)
const ATTACHMENT_CONCURRENCY = 2; // max concurrent attachment downloads over the socket

// A request is only "done" once the bytes have actually arrived.
function isAttachmentLoaded(entry) {
  return Boolean(entry && ((entry.img && entry.img.src) || entry.base64));
}

// Timeout for one request: a fixed grace period plus the time the bytes need at
// the slowest speed we still want to support, so a big photo on a bad
// connection is not aborted mid-transfer.
function attachmentTimeoutMs(entry) {
  const size = (entry.att && entry.att.size) || 0;
  const transferMs = (size * 1.37 * 1000) / ATTACHMENT_SLOW_BYTES_PER_SEC;
  return Math.min(ATTACHMENT_TIMEOUT_BASE_MS + transferMs, ATTACHMENT_TIMEOUT_MAX_MS);
}

function clearAttachmentTimers(entry) {
  if (entry.timer) {
    clearTimeout(entry.timer);
    entry.timer = null;
  }
  if (entry.retryTimer) {
    clearTimeout(entry.retryTimer);
    entry.retryTimer = null;
  }
  if (entry.progressTimer) {
    clearInterval(entry.progressTimer);
    entry.progressTimer = null;
  }
  if (entry.progressHideTimer) {
    clearTimeout(entry.progressHideTimer);
    entry.progressHideTimer = null;
  }
}

// --- Attachment download progress UI ----------------------------------------
// The bytes are delivered in one WebSocket message, so there is no byte stream
// to measure. attachmentProgress.js turns the attachment's size and the time
// the request has been running into a conservative percentage that stops at
// 90% until the reply really arrives. Until then a spinner and the moving bar
// make it obvious that the picture is still being downloaded, instead of a
// thumbnail that looks frozen.
function stopAttachmentProgress(entry) {
  if (entry && entry.progressTimer) {
    clearInterval(entry.progressTimer);
    entry.progressTimer = null;
  }
}

function paintAttachmentProgress(entry) {
  if (!entry || !entry.progress) return;
  const done = isAttachmentLoaded(entry);
  const percent = attachmentProgressPercent(
    entry.att && entry.att.size,
    Date.now() - (entry.progressStartedAt || Date.now()),
    done
  );
  const overlay = entry.progress.el;
  const fill = entry.progress.fill;
  const label = entry.progress.label;
  overlay.classList.add("active");
  overlay.classList.toggle("indeterminate", percent === null);
  overlay.classList.toggle("complete", done);
  if (percent === null) {
    // No size from the server: an animated bar is the honest option.
    fill.style.width = "";
    label.textContent = t("email.downloadingUnknown");
  } else {
    fill.style.width = `${percent}%`;
    label.textContent = done
      ? t("email.downloaded")
      : fmt(t("email.downloading"), { percent });
  }
  if (done) stopAttachmentProgress(entry);
}

// Begin (or restart, after a retry) the moving progress bar for one image.
function startAttachmentProgress(entry) {
  if (!entry || !entry.progress) return;
  entry.progressStartedAt = Date.now();
  stopAttachmentProgress(entry);
  clearTimeout(entry.progressHideTimer);
  entry.progressHideTimer = null;
  paintAttachmentProgress(entry);
  entry.progressTimer = setInterval(() => paintAttachmentProgress(entry), 250);
}

// The picture is queued behind the concurrency limit (or waiting for a retry):
// show the spinner straight away so it never looks frozen before its request
// is actually sent.
function showQueuedAttachmentProgress(entry) {
  if (!entry || !entry.progress) return;
  stopAttachmentProgress(entry);
  const overlay = entry.progress.el;
  overlay.classList.add("active", "indeterminate");
  overlay.classList.remove("complete");
  entry.progress.fill.style.width = "";
  entry.progress.label.textContent = t("email.downloadingUnknown");
}

// The connection dropped: keep the overlay visible, but say what is happening
// instead of leaving a bar frozen at its last value.
function pauseAttachmentProgress(entry) {
  if (!entry || !entry.progress) return;
  stopAttachmentProgress(entry);
  const overlay = entry.progress.el;
  overlay.classList.add("active", "indeterminate");
  overlay.classList.remove("complete");
  entry.progress.fill.style.width = "";
  entry.progress.label.textContent = t("email.downloadRetrying");
}

// The bytes are here: show 100% for a moment, then fade the overlay out so it
// does not cover the picture.
function finishAttachmentProgress(entry) {
  if (!entry || !entry.progress) return;
  stopAttachmentProgress(entry);
  const overlay = entry.progress.el;
  overlay.classList.add("active", "complete");
  overlay.classList.remove("indeterminate");
  entry.progress.fill.style.width = "100%";
  entry.progress.label.textContent = t("email.downloaded");
  clearTimeout(entry.progressHideTimer);
  entry.progressHideTimer = setTimeout(() => {
    entry.progressHideTimer = null;
    overlay.classList.remove("active");
  }, 450);
}

function hideAttachmentProgress(entry) {
  if (!entry || !entry.progress) return;
  stopAttachmentProgress(entry);
  clearTimeout(entry.progressHideTimer);
  entry.progressHideTimer = null;
  entry.progress.el.classList.remove("active", "indeterminate", "complete");
}

// The server answered but could not deliver the bytes (too large / fetch
// failed). Retry a few times in case it was transient, then fall back to the
// filename placeholder / a disabled tile.
function onAttachmentFailed(entry) {
  if (entry.gaveUp) return;
  if (entry.attempts >= ATTACHMENT_MAX_ATTEMPTS) {
    giveUpOnAttachment(entry);
  } else {
    scheduleAttachmentRetry(entry);
  }
}

function scheduleAttachmentRetry(entry) {
  if (entry.gaveUp || isAttachmentLoaded(entry)) return;
  clearTimeout(entry.retryTimer);
  const delay = Math.min(
    ATTACHMENT_RETRY_BASE_MS * Math.pow(2, Math.max(0, entry.attempts - 1)),
    30000
  );
  entry.retryTimer = setTimeout(() => {
    entry.retryTimer = null;
    entry.requested = true;
    showQueuedAttachmentProgress(entry);
    pumpAttachmentQueue();
  }, delay);
}

// Permanent fallback: show the filename instead of a broken preview.
function giveUpOnAttachment(entry) {
  if (entry.gaveUp) return;
  entry.gaveUp = true;
  entry.inFlight = false;
  entry.requested = false;
  clearAttachmentTimers(entry);
  hideAttachmentProgress(entry);
  if (entry.tile) {
    entry.tile.classList.remove("attachment-loading");
    entry.tile.classList.add("attachment-unavailable");
    entry.tile.disabled = true;
  } else if (entry.img && entry.preview) {
    // Keep the preview shell (and its overlay) in place; hide the empty image
    // and show the filename instead, so a later successful retry can simply
    // swap the picture back in.
    entry.img.classList.add("attachment-hidden");
    if (!entry.fallback) {
      entry.fallback = el(
        "span",
        entry.att.filename || t("email.attachment"),
        { class: "muted attachment-fallback" }
      );
      entry.preview.appendChild(entry.fallback);
    }
  } else if (entry.img && entry.img.parentNode) {
    entry.img.replaceWith(
      el("span", entry.att.filename || t("email.attachment"), {
        class: "muted",
      })
    );
  }
}

function sendAttachmentRequest(entry) {
  if (!emailSocket || !emailSocket.isReady() || !PendingEmail) {
    return false;
  }
  // A file may belong to an earlier reply rather than the newest email: ask
  // the server for it by the message that actually carries it.
  const messageId = entry.messageId || PendingEmail.messageId;
  if (!messageId) return false;
  if (entry.inFlight || entry.gaveUp || isAttachmentLoaded(entry)) {
    return false;
  }
  if (entry.attempts >= ATTACHMENT_MAX_ATTEMPTS) {
    giveUpOnAttachment(entry);
    return false;
  }
  entry.requested = true;
  entry.inFlight = true;
  entry.attempts += 1;
  try {
    emailSocket.send({
      type: "get_attachment",
      messageId,
      id: entry.att.id,
    });
  } catch (err) {
    entry.inFlight = false;
    entry.requested = false;
    pauseAttachmentProgress(entry);
    reportError("Failed to request email attachment", err, "emailSendFailed");
    scheduleAttachmentRetry(entry);
    return false;
  }
  startAttachmentProgress(entry);
  // Start the transfer timeout only once the request is actually sent on the
  // wire (not while waiting behind earlier attachments in the queue).
  clearTimeout(entry.timer);
  entry.timer = setTimeout(() => {
    entry.timer = null;
    if (entry.inFlight && !isAttachmentLoaded(entry)) {
      entry.inFlight = false;
      entry.requested = false;
      pauseAttachmentProgress(entry);
      scheduleAttachmentRetry(entry);
      pumpAttachmentQueue();
    }
  }, attachmentTimeoutMs(entry));
  return true;
}

// Send up to ATTACHMENT_CONCURRENCY attachment requests at a time, smallest
// files first, so small PDFs/thumbnails appear quickly and large photos do not
// cause later attachments to time out while waiting in line on a slow link.
function pumpAttachmentQueue() {
  if (!emailSocket || !emailSocket.isReady() || !PendingEmail || !PendingEmail.messageId) {
    return;
  }
  let inFlightCount = 0;
  const candidates = [];
  for (const entry of emailAttachmentEntries.values()) {
    if (entry.inFlight) {
      inFlightCount += 1;
    } else if (
      entry.requested &&
      !entry.gaveUp &&
      !entry.retryTimer &&
      !isAttachmentLoaded(entry)
    ) {
      candidates.push(entry);
    }
  }
  if (inFlightCount >= ATTACHMENT_CONCURRENCY || candidates.length === 0) {
    return;
  }
  candidates.sort(
    (a, b) => ((a.att && a.att.size) || 0) - ((b.att && b.att.size) || 0)
  );
  for (const entry of candidates) {
    if (inFlightCount >= ATTACHMENT_CONCURRENCY) break;
    if (sendAttachmentRequest(entry)) {
      inFlightCount += 1;
    }
  }
}

// Ask the server for one attachment's bytes, guarding against a lost request so
// a picture is never left spinning forever on a bad connection.
function requestAttachment(entry) {
  if (!emailSocket || !PendingEmail || !PendingEmail.messageId) return;
  if (entry.inFlight || entry.gaveUp || isAttachmentLoaded(entry)) return;
  if (entry.attempts >= ATTACHMENT_MAX_ATTEMPTS) {
    giveUpOnAttachment(entry);
    return;
  }
  entry.requested = true;
  showQueuedAttachmentProgress(entry);
  pumpAttachmentQueue();
}
// Shared click behaviour for an <img> preview: open the picture in the viewer,
// or externally (Ctrl/Cmd-click).
function wireAttachmentImage(img, filename) {
  img.addEventListener("click", (e) => {
    if (!img.src) return;
    if (e.ctrlKey || e.metaKey) {
      openImageExternal(img.src);
    } else {
      openImageViewer(img.src, filename || "");
    }
  });
}

// Short type label for a non-image attachment tile, e.g. "PDF" or "DOCX".
function attachmentTypeLabel(att) {
  const name = String(att.filename || "");
  const dot = name.lastIndexOf(".");
  if (dot > 0 && dot < name.length - 1) {
    return name.slice(dot + 1).slice(0, 5).toUpperCase();
  }
  const sub = String(att.mimeType || "").split("/")[1] || "";
  return (sub.split(/[.+-]/).pop() || "FILE").slice(0, 5).toUpperCase();
}

// Open a fetched (non-image) attachment with the OS default application.
function openAttachmentExternal(entry) {
  if (!entry || !entry.base64) return;
  if (
    window.bridge &&
    typeof window.bridge.OpenAttachmentExternal === "function"
  ) {
    window.bridge.OpenAttachmentExternal({
      filename: entry.att.filename || "attachment",
      mimeType: entry.att.mimeType || "application/octet-stream",
      base64: entry.base64,
    });
    return;
  }
  // Plain browser fallback (no Electron bridge): download/open via data URL.
  const a = document.createElement("a");
  a.href = `data:${entry.att.mimeType || "application/octet-stream"};base64,${entry.base64}`;
  a.download = entry.att.filename || "attachment";
  a.click();
}

function emailSubject(email) {
  return email.subject || email.from || t("email.noSubject");
}

function clearPendingEmail() {
  PendingEmail = null;
  localStorage.removeItem("pendingEmail");
}

// ---------------------------------------------------------------------------
// Blank-number autofill & paste trimming
// ---------------------------------------------------------------------------

// When the form is opened for a broker email, look through the email's subject
// and body and pre-fill the blank-number field with the first 6-digit number
// and the car-number field with the first 8-character alphanumeric car number
// (both helpers live in numberField.js).
function autofillEmailNumbers() {
  if (!PendingEmail) return;
  const text = [PendingEmail.subject, PendingEmail.body].filter(Boolean).join("\n");

  const blancInput = document.getElementById("BlancNumberInput");
  if (blancInput) {
    const found = extractBlankNumber(text);
    if (found !== null) blancInput.value = found;
  }

  const carInput = document.getElementById("CarNumberInput");
  if (carInput) {
    const found = extractCarNumber(text);
    if (found !== null) carInput.value = found;
  }
}

// Trim all whitespace the moment a value is pasted into the car / policy /
// blank-number fields. The clipboard text is inserted by the browser's default
// action AFTER the paste event handlers run, so trim on the next tick. Typing
// is left alone; the save handler still trims leading/trailing space as a
// backstop.
function trimOnPaste(input) {
  if (!input) return;
  input.addEventListener("paste", () => {
    setTimeout(() => {
      input.value = stripWhitespace(input.value);
    }, 0);
  });
}

// Walk-in insurances are created directly from the "+ Нова застраховка" button
// and have no associated broker email. There is no return email to send and no
// files to attach, so the file drop area is hidden for them. The native file
// input always stays hidden: it is only opened programmatically by clicking
// the drop area, so the drop area is the single file selector on the page.
function configureWalkInMode() {
  const isWalkIn = !PendingEmail;
  if (DropArea) DropArea.classList.toggle("hidden", isWalkIn);
  if (FileInput) FileInput.hidden = true;
  removeEmailPaymentOptions();
}

// Email policies are paid ONLY from the broker's balance - never in cash and
// never by card. The "In cash" and card-fee checkboxes do not apply to them,
// and neither does the non-Turk tax (a walk-in-only charge the server rejects
// for email policies), so all three are removed from the form entirely (not
// just hidden/disabled) and a note in their place says how the policy is
// paid. Walk-ins keep all options.
// Safe to call repeatedly: once removed, the checkboxes are no longer found.
function removeEmailPaymentOptions() {
  if (!OpenedFromEmail) return;

  const cashInput = document.getElementById("CashInput");
  const cashField = cashInput ? cashInput.closest(".field") : null;
  if (cashField && !document.getElementById("BrokerPaymentNote")) {
    const note = document.createElement("div");
    note.id = "BrokerPaymentNote";
    note.className = "field muted";
    note.setAttribute("data-i18n", "add.paidFromBroker");
    note.textContent = t("add.paidFromBroker");
    cashField.parentNode.insertBefore(note, cashField);
  }

  for (const id of ["CashInput", "CardFeeInput", "NonTurkInput"]) {
    const input = document.getElementById(id);
    if (!input) continue;
    // Untick first: the fee helpers keep a reference to these inputs, and an
    // unticked detached checkbox never adds a fee to the price.
    input.checked = false;
    const fieldEl = input.closest(".field");
    if (fieldEl) fieldEl.remove();
    else input.remove();
  }
}

// One email of a (possibly single-email) thread: label, sender/date, body.
// The first segment is the email that was actually received; the following
// ones are the earlier emails it quotes.
function renderEmailSegment(segment, index, thread) {
  const isLatest = index === 0;
  const box = el("section", null, {
    class: `email-message ${isLatest ? "email-message-latest" : "email-message-quoted"}`,
  });

  if (thread.count > 1) {
    const label = isLatest
      ? t("email.latestMessage")
      : t("email.earlierMessage").replace("{n}", index);
    box.appendChild(el("div", label, { class: "email-message-label" }));
  }

  // The received email shows the real message headers; earlier ones show
  // what could be read from their quote header.
  const from = isLatest ? PendingEmail.from : segment.from;
  const date = isLatest ? PendingEmail.date : segment.date;
  const meta = el("div", null, { class: "email-meta" });
  if (isLatest || from) {
    meta.appendChild(el("div", `${t("email.from")} ${from || "?"}`));
  }
  if (isLatest || date) {
    meta.appendChild(el("div", `${t("email.date")} ${date || "?"}`));
  }
  if (!isLatest && !from && !date && segment.attribution) {
    meta.appendChild(el("div", segment.attribution));
  }
  if (meta.childNodes.length) box.appendChild(meta);

  box.appendChild(
    el("pre", segment.text || t("email.emptyBody"), { class: "email-body" })
  );
  return box;
}

// ---------------------------------------------------------------------------
// Conversation history (above the reply form)
// ---------------------------------------------------------------------------
// The history combines three sources, de-duplicated by content:
//   - the emails quoted inside the newest email (works fully offline),
//   - the server's Gmail thread endpoint (exact client + employee messages),
//   - the replies sent from this form, stored locally when they are sent.
// It only starts once the conversation has a reply (an employee answer or the
// broker writing back on their original email); the original email alone is
// the request itself, already shown next to the history.
let conversationRequested = false;

function conversationKey() {
  if (!PendingEmail) return "";
  return PendingEmail.conversationKey || emailConversationKey(PendingEmail);
}

// "12.11.2026 14:05" from a Gmail date header or an epoch-ms value.
function formatConversationDate(value) {
  if (value === undefined || value === null || value === "") return "";
  const parsed = typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(parsed)) return String(value);
  const d = new Date(parsed);
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()} ${p(
    d.getHours()
  )}:${p(d.getMinutes())}`;
}

// One display text per message: the server sends the full Gmail body, which
// quotes the earlier emails; keep only the new part so it matches the locally
// split segments and the same message is not shown twice.
function conversationMessageText(message) {
  const text = String((message && message.text) || "");
  if (
    message &&
    message.source === "gmail" &&
    typeof splitEmailThread === "function"
  ) {
    const segments = splitEmailThread(text);
    if (segments.length && segments[0].text) return segments[0].text;
  }
  return text;
}

function conversationMessages() {
  const key = conversationKey();
  const stored = key ? emailConversationFor(localStorage, key) : [];
  const quoted = emailConversationMessagesFromThread(PendingEmail);

  // Later sources win ties: the Gmail thread has the real sender/date, then
  // the quoted emails, then a reply typed on this PC.
  const rank = { employee: 0, thread: 1, gmail: 2 };
  const byContent = new Map();
  const add = (message) => {
    const text = conversationMessageText(message).trim();
    if (!text) return;
    const direction = message.direction === "employee" ? "employee" : "client";
    const signature = `${direction}|${text.replace(/\s+/g, " ").toLowerCase()}`;
    const candidate = { ...message, direction, text };
    const current = byContent.get(signature);
    if (
      !current ||
      (rank[candidate.source] || 0) >= (rank[current.source] || 0)
    ) {
      byContent.set(signature, candidate);
    }
  };
  for (const message of quoted) add(message);
  for (const message of stored) add(message);

  const messages = Array.from(byContent.values()).sort(
    (a, b) => Number(a.at || 0) - Number(b.at || 0)
  );

  // The history begins with the first reply. Until then the form is showing
  // only the original request, which is already displayed next to it.
  return emailConversationHasReplies(messages) ? messages : [];
}

function renderConversationHistory() {
  if (!ConversationSection || !ConversationHistory || !PendingEmail) return;
  ConversationSection.classList.remove("hidden");
  ConversationHistory.replaceChildren();

  const messages = conversationMessages();
  if (messages.length === 0) {
    if (ConversationStatus) {
      ConversationStatus.textContent = t("add.conversationEmpty");
    }
    return;
  }
  if (ConversationStatus) ConversationStatus.textContent = "";

  for (const message of messages) {
    const employee = message.direction === "employee";
    const item = el("li", null, {
      class: `conversation-message ${
        employee
          ? "conversation-message-employee"
          : "conversation-message-client"
      }`,
    });

    const meta = el("div", null, { class: "conversation-meta" });
    meta.appendChild(
      el(
        "span",
        t(employee ? "add.messageFromEmployee" : "add.messageFromBroker"),
        { class: "conversation-who" }
      )
    );
    if (message.from) meta.appendChild(el("span", message.from));
    const when = formatConversationDate(message.date || message.at);
    if (when) meta.appendChild(el("span", when));
    item.appendChild(meta);
    item.appendChild(
      el("pre", message.text || t("email.emptyBody"), {
        class: "conversation-text",
      })
    );
    ConversationHistory.appendChild(item);
  }

  // Oldest first; start at the newest message, like a chat log.
  ConversationHistory.scrollTop = ConversationHistory.scrollHeight;
}

// Ask the server for the real Gmail thread. Older servers do not have the
// endpoint: the quoted emails and the locally stored replies are still shown,
// so the history never blocks the worker.
async function loadConversationHistory() {
  if (!PendingEmail || !PendingEmail.messageId) return;
  if (ConversationStatus) {
    ConversationStatus.textContent = t("add.conversationLoading");
  }
  try {
    const data = await api(
      `/worker/emails/${encodeURIComponent(PendingEmail.messageId)}/thread`
    );
    const messages =
      data && Array.isArray(data.messages) ? data.messages : [];
    const key = conversationKey();
    const stored = key ? emailConversationFor(localStorage, key) : [];
    // The stored history starts with the first reply (an employee answer or
    // the broker writing back). A thread that only holds the original email
    // must not create one, so opening the card leaves nothing behind.
    if (
      !emailConversationHasReplies(messages) &&
      !emailConversationHasReplies(stored)
    ) {
      renderConversationHistory();
      return;
    }
    for (const message of messages) {
      const dateMs = Date.parse(message.date);
      const at =
        Number(message.at) || (Number.isFinite(dateMs) ? dateMs : Date.now());
      emailConversationRecord(localStorage, key, {
        id: `gmail:${message.id || at}`,
        direction: message.direction === "employee" ? "employee" : "client",
        from: message.from || "",
        text: message.text || "",
        at,
        source: "gmail",
      });
    }
    renderConversationHistory();
  } catch (err) {
    console.warn("Failed to load the email conversation:", err);
    renderConversationHistory();
    if (ConversationStatus && ConversationHistory.childElementCount === 0) {
      ConversationStatus.textContent = t("add.conversationUnavailable");
    }
  }
}

// All attachments of the conversation, grouped by the email that carried them
// (newest first). A file sent with a reply is just as usable as one from the
// newest email: every attachment carries its messageId, so the bytes are
// fetched from the right Gmail message.
function emailAttachmentGroups() {
  if (!PendingEmail) return [];
  if (typeof emailConversationAttachmentGroups === "function") {
    return emailConversationAttachmentGroups(
      PendingEmail,
      PendingEmail.threadEmails
    );
  }
  // Fallback for an older emailConversation.js: newest email only.
  const attachments = PendingEmail.attachments || [];
  return attachments.length
    ? [
        {
          messageId: PendingEmail.messageId || "",
          from: PendingEmail.from || "",
          date: PendingEmail.date || "",
          index: 0,
          isLatest: true,
          attachments,
        },
      ]
    : [];
}

// One attachment of an email: the image preview or the file tile, its name and
// size, and a Print button (enabled once the bytes have been fetched).
function renderEmailAttachment(att, messageId) {
  const wrap = el("div", null, { class: "email-attachment" });
  const isImage = isImageAttachment(att);
  let entry = null;

  if (isImage && att.id != null) {
    // The card only carries attachment metadata; the image bytes are
    // fetched lazily via get_attachment and filled in on its reply.
    const img = el("img");
    img.alt = att.filename || t("email.attachment");
    img.classList.add("attachment-loading");

    // The preview shell holds the picture plus the download overlay
    // (spinner, percentage and progress bar). The overlay covers the empty
    // thumbnail while the bytes are in flight and fades out once they
    // arrive.
    const preview = el("div", null, { class: "attachment-preview" });
    const progress = el("div", null, {
      class: "attachment-progress",
      "aria-hidden": "true",
    });
    const spinner = el("span", null, { class: "attachment-spinner" });
    const progressLabel = el("span", t("email.downloadingUnknown"), {
      class: "attachment-progress-label",
    });
    const progressTrack = el("div", null, {
      class: "attachment-progress-track",
    });
    const progressFill = el("div", null, {
      class: "attachment-progress-fill",
    });
    progressTrack.appendChild(progressFill);
    progress.appendChild(spinner);
    progress.appendChild(progressLabel);
    progress.appendChild(progressTrack);
    preview.appendChild(img);
    preview.appendChild(progress);

    entry = {
      img,
      att,
      messageId,
      wrap,
      preview,
      progress: {
        el: progress,
        label: progressLabel,
        fill: progressFill,
      },
      fallback: null,
      requested: false,
      attempts: 0,
      gaveUp: false,
      timer: null,
      retryTimer: null,
      progressTimer: null,
      progressHideTimer: null,
      progressStartedAt: 0,
      base64: null,
      printBtn: null,
    };
    emailAttachmentEntries.set(att.id, entry);
    wireAttachmentImage(img, att.filename);
    wrap.appendChild(preview);
  } else if (att.id != null) {
    // PDFs and any other file type: a tile that opens the file with the
    // system's default application once its bytes have been fetched.
    const tile = el("button", attachmentTypeLabel(att), {
      class: "attachment-file attachment-loading",
      type: "button",
      title: att.filename || t("email.attachment"),
    });
    entry = {
      tile,
      att,
      messageId,
      requested: false,
      attempts: 0,
      gaveUp: false,
      timer: null,
      retryTimer: null,
      base64: null,
      printBtn: null,
    };
    emailAttachmentEntries.set(att.id, entry);
    tile.addEventListener("click", () => openAttachmentExternal(entry));
    wrap.appendChild(tile);
  } else {
    wrap.appendChild(
      el("span", att.filename || t("email.attachment"), { class: "muted" })
    );
  }

  if (att.filename)
    wrap.appendChild(el("div", att.filename, { class: "muted small" }));
  if (att.size)
    wrap.appendChild(
      el("div", fileSizeLabel(att.size), { class: "muted small" })
    );

  // Print the attachment, whether it is a picture or a PDF/document. It stays
  // disabled until the bytes have actually arrived. Only files with an id can
  // be fetched from the server, so a nameless placeholder gets no button.
  if (entry) {
    const printBtn = el("button", t("add.printFile"), {
      class: "secondary small attachment-print",
      type: "button",
      title: t("add.printFile"),
    });
    printBtn.disabled = true;
    printBtn.addEventListener("click", () => {
      if (!entry.base64) return;
      printAttachment({
        filename: entry.att.filename || "attachment",
        mimeType: entry.att.mimeType || "application/octet-stream",
        base64: entry.base64,
      });
    });
    entry.printBtn = printBtn;
    wrap.appendChild(printBtn);
  }

  return wrap;
}

function renderEmailSide() {
  if (!PendingEmail || !EmailSide || !EmailSideBody || !EmailSideTitle) {
    return;
  }

  // Re-rendering replaces every attachment element, so clear any pending
  // timeout/retry timers on the old entries first. Otherwise an orphaned timer
  // would keep re-sending get_attachment for a detached image forever.
  for (const old of emailAttachmentEntries.values()) clearAttachmentTimers(old);
  emailAttachmentEntries.clear();

  // The reply UI only makes sense when the form was opened from an email card.
  if (ReplySection) ReplySection.classList.remove("hidden");

  // Conversation history sits directly above the reply form.
  renderConversationHistory();
  if (!conversationRequested) {
    conversationRequested = true;
    loadConversationHistory();
  }

  EmailSideTitle.textContent = emailSubject(PendingEmail);
  EmailSideBody.replaceChildren();

  // A reply carries the earlier email(s) quoted inside its body. Show every
  // email in its own box (newest first) so it is clear where one ends and the
  // next starts, instead of one combined block of text.
  const thread = emailThreadInfo(PendingEmail);
  EmailSide.classList.toggle("email-side-thread", thread.count > 1);
  const threadNode = el("div", null, { class: "email-thread" });
  thread.segments.forEach((segment, index) => {
    threadNode.appendChild(renderEmailSegment(segment, index, thread));
  });
  EmailSideBody.appendChild(threadNode);

  // Every attachment of the whole conversation, grouped by the email that
  // carried it (newest first). A file sent with an earlier reply stays listed
  // and printable instead of being lost when a newer email arrives.
  const attachmentGroups = emailAttachmentGroups();
  if (attachmentGroups.length) {
    EmailSideBody.appendChild(el("h3", t("email.attachments")));
    const multiple = attachmentGroups.length > 1;
    // Label the pieces when they come from more than one email, and also when
    // the only files arrived with an earlier reply (so it is clear they are
    // not part of the newest message).
    const showLabels = multiple || !attachmentGroups[0].isLatest;
    for (const group of attachmentGroups) {
      if (showLabels) {
        const label = group.isLatest
          ? t("email.latestMessage")
          : t("email.earlierMessage").replace("{n}", group.index);
        EmailSideBody.appendChild(
          el("div", group.from ? `${label} · ${group.from}` : label, {
            class: "email-message-label attachment-group-label",
          })
        );
      }
      const gallery = el("div", null, { class: "email-attachments" });
      for (const att of group.attachments) {
        gallery.appendChild(renderEmailAttachment(att, group.messageId));
      }
      EmailSideBody.appendChild(gallery);
    }
  } else {
    EmailSideBody.appendChild(
      el("p", t("email.noAttachments"), { class: "muted" })
    );
  }

  EmailSide.classList.remove("hidden");
}

function requestEmailAttachments() {
  if (!emailSocket || !PendingEmail) return;
  // Every attachment tile/preview of the conversation was just rendered; ask
  // for the bytes of each. Each entry carries its own messageId.
  for (const entry of emailAttachmentEntries.values()) {
    requestAttachment(entry);
  }
}

// The socket reconnected (auth_ok): any in-flight request died with the old
// socket, so allow still-missing attachments to be requested again on the
// fresh connection. This is the key recovery for an unstable connection that
// drops in the middle of loading a picture.
function retryPendingAttachments() {
  for (const entry of emailAttachmentEntries.values()) {
    if (isAttachmentLoaded(entry)) continue;
    entry.inFlight = false;
    entry.requested = true;
    entry.gaveUp = false;
    entry.attempts = 0;
    clearAttachmentTimers(entry);
    showQueuedAttachmentProgress(entry);
  }
  pumpAttachmentQueue();
}

// Set once the worker completes (saves) or cancels the email. From then on a
// reconnect must not claim the email again.
let leavingEmail = false;

function setupEmailSocket() {
  if (!PendingEmail || !PendingEmail.messageId) {
    // Walk-in form: no email of its own. Connect a single shared socket for
    // worker presence ("working" / "afk") and outbox email reservations.
    if (getRole() === "2") {
      emailSocket = new UnreadEmailSocket({
        close: () => resetOutboxEmailClaims(),
        auth_ok: () => {
          sendPresence(presenceStatusFor("working", lastActivityAt));
          syncOutboxEmails(emailSocket);
        },
      });
      emailSocket.connect();
      onOutboxState(() => syncOutboxEmails(emailSocket));
      return;
    }
    onOutboxState((state) => {
      if (emailSocket || outboxEmailIds(state).size === 0) return;
      emailSocket = new UnreadEmailSocket({
        close: () => resetOutboxEmailClaims(),
        auth_ok: () => syncOutboxEmails(emailSocket),
      });
      emailSocket.connect();
    });
    onOutboxState(() => syncOutboxEmails(emailSocket));
    return;
  }

  emailSocket = new UnreadEmailSocket({
    // The server released this connection's claims: re-claim on reconnect.
    close: () => resetOutboxEmailClaims(),
    auth_ok: () => {
      if (getRole() === "2") {
        sendPresence(presenceStatusFor("working", lastActivityAt));
      }
      // Emails of policies queued earlier stay reserved on this connection
      // too (the dashboard's connection, which held them, is gone), and get
      // completed here if the outbox delivers them while this form is open.
      syncOutboxEmails(emailSocket, ownEmailId());
      // The email is being completed or released while this page unloads (or
      // was already completed): do not claim it again.
      if (leavingEmail || !PendingEmail || !PendingEmail.messageId) return;
      // Claim the email on this page's own connection. The server broadcasts
      // "email_claimed" to every other worker, removing their card, and marks
      // the Gmail message read. auth_ok also fires after every reconnect: when
      // the connection dropped, the server returned the email to the pool
      // (marked unread), so claiming it again here takes it back and marks it
      // read once more. `restore` lets the server reload the email from Gmail
      // if it no longer holds it (e.g. it restarted while we were away).
      try {
        clearDurableEmailWsAction(PendingEmail.messageId);
        emailSocket.send({
          type: "claim_email",
          messageId: PendingEmail.messageId,
          restore: true,
        });
      } catch (err) {
        reportError("Failed to claim email", err, "emailSendFailed");
      }
      // Attachment bytes are not included on the card; fetch each one lazily.
      // On a reconnect this also re-requests any attachment whose earlier
      // request/reply was lost to the dropped connection.
      retryPendingAttachments();
    },
    claim_email: (msg) => {
      if (leavingEmail) return;
      if (!PendingEmail || msg.messageId !== PendingEmail.messageId) return;
      if (msg.ok) return;
      // Another worker took the email (or it was completed/dismissed) while
      // this page was disconnected. Keep the form so nothing typed is lost,
      // but warn the worker that it is no longer reserved for them.
      const message = t("add.emailLost");
      console.error(
        `Email "${msg.messageId}" could not be claimed again: ${msg.error || "taken"}`
      );
      setMessage(message, true);
      toast(message, "error");
    },
    get_attachment: (msg) => {
      const entry = emailAttachmentEntries.get(msg.id);
      if (!entry) return;
      // A reply arrived, so cancel the "request was lost" timeout.
      clearTimeout(entry.timer);
      entry.timer = null;
      entry.inFlight = false;
      entry.requested = false;

      if (entry.tile) {
        // Non-image attachment (PDF, document…): keep the bytes so a click on
        // the tile opens the file with the system's default application.
        if (msg.ok && msg.base64) {
          entry.base64 = msg.base64;
          entry.tile.classList.remove("attachment-loading");
          // Re-enable a tile that was previously marked unavailable after a
          // transient failure (e.g. the connection recovered on a reconnect).
          entry.tile.classList.remove("attachment-unavailable");
          entry.tile.disabled = false;
          if (entry.printBtn) entry.printBtn.disabled = false;
        } else {
          onAttachmentFailed(entry);
        }
        pumpAttachmentQueue();
        return;
      }
      if (!entry.img) {
        pumpAttachmentQueue();
        return;
      }
      if (
        msg.ok &&
        msg.base64 &&
        typeof msg.mimeType === "string" &&
        msg.mimeType.startsWith("image/")
      ) {
        const src = `data:${msg.mimeType};base64,${msg.base64}`;
        // Keep the bytes as well, so the Print button can print the picture
        // exactly like a dropped file.
        entry.base64 = msg.base64;
        if (entry.printBtn) entry.printBtn.disabled = false;
        // A give-up leaves the filename placeholder in the preview; the bytes
        // just arrived, so drop it and show the picture again.
        if (entry.fallback) {
          entry.fallback.remove();
          entry.fallback = null;
        }
        entry.img.classList.remove("attachment-hidden");
        if (entry.img.parentNode) {
          entry.img.src = src;
          entry.img.classList.remove("attachment-loading");
          trackCtrlCursor(entry.img);
        } else {
          // The preview was replaced with a filename placeholder after an
          // earlier give-up; rebuild it now that the bytes have arrived.
          const img = el("img");
          img.alt = entry.att.filename || t("email.attachment");
          img.src = src;
          wireAttachmentImage(img, entry.att.filename);
          trackCtrlCursor(img);
          const placeholder = entry.wrap
            ? entry.wrap.querySelector("span.muted")
            : null;
          if (placeholder) placeholder.replaceWith(img);
          else if (entry.wrap) entry.wrap.appendChild(img);
          entry.img = img;
        }
        finishAttachmentProgress(entry);
      } else {
        pauseAttachmentProgress(entry);
        onAttachmentFailed(entry);
      }
      pumpAttachmentQueue();
    },
    email_send_failed: handleEmailSendFailed,
  });
  emailSocket.connect();
  onOutboxState(() => syncOutboxEmails(emailSocket, ownEmailId()));
}

// The email this form was opened for (claimed and released by this page).
// Kept even after a save so a late queue update cannot release it.
const OwnEmailId = PendingEmail && PendingEmail.messageId ? PendingEmail.messageId : null;
function ownEmailId() {
  return OwnEmailId;
}

function releaseEmail() {
  leavingEmail = true;
  if (PendingEmail && PendingEmail.messageId) {
    if (emailSocket && emailSocket.isReady()) {
      try {
        emailSocket.send({
          type: "release_email",
          messageId: PendingEmail.messageId,
        });
        clearDurableEmailWsAction(PendingEmail.messageId);
        return;
      } catch (err) {
        reportError("Failed to release email", err, "emailSendFailed");
      }
    }
    queueDurableEmailWsAction({
      type: "release_email",
      messageId: PendingEmail.messageId,
    });
  }
}

async function waitForSocketAuth(timeoutMs = 800) {
  if (!emailSocket) return;
  if (emailSocket.authed) return;
  emailSocket.ensureConnected();
  const started = Date.now();
  while (!emailSocket.authed && Date.now() - started < timeoutMs) {
    await new Promise((r) => setTimeout(r, 50));
  }
}

// Every Gmail message of the conversation the form was opened for. The card on
// the dashboard groups the original email and its replies, so completing only
// the newest one would bring the older ones back as a new card.
function conversationMessageIds() {
  if (!PendingEmail || !PendingEmail.messageId) return [];
  const ids = Array.isArray(PendingEmail.threadMessageIds)
    ? PendingEmail.threadMessageIds.filter(
        (id) => typeof id === "string" && id
      )
    : [];
  if (!ids.includes(PendingEmail.messageId)) ids.push(PendingEmail.messageId);
  return ids;
}

function completeEmail() {
  leavingEmail = true;
  const ids = conversationMessageIds();
  if (ids.length === 0) return false;
  if (emailSocket && emailSocket.isReady()) {
    try {
      for (const messageId of ids) {
        emailSocket.send({ type: "complete_email", messageId });
        clearDurableEmailWsAction(messageId);
      }
      return true;
    } catch (err) {
      reportError("Failed to complete email", err, "emailSendFailed");
    }
  }
  for (const messageId of ids) {
    queueDurableEmailWsAction({ type: "complete_email", messageId });
  }
  return false;
}

// Whether saving this form sends a return email to the broker: only for
// policies opened from an email card.
function returnEmailEnabled() {
  return OpenedFromEmail && !!PendingEmail && !!PendingEmail.messageId;
}

// ---------------------------------------------------------------------------
// File drop area
// ---------------------------------------------------------------------------
function fileSizeLabel(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function renderDroppedFiles() {
  if (!DroppedFiles) return;
  DroppedFiles.replaceChildren();
  // A file has been attached: clear the "attachments required" highlight.
  if (DropArea && droppedFiles.length) DropArea.classList.remove("drop-error");

  for (let i = 0; i < droppedFiles.length; i++) {
    const f = droppedFiles[i];
    const li = el("li");

    const isImage =
      typeof f.mimeType === "string" &&
      f.mimeType.startsWith("image/") &&
      f.base64;

    if (isImage) {
      const src = `data:${f.mimeType};base64,${f.base64}`;
      const thumb = el("img", null, { class: "file-thumb" });
      thumb.alt = f.filename;
      thumb.src = src;
      trackCtrlCursor(thumb);
      thumb.addEventListener("click", (e) => {
        if (e.ctrlKey || e.metaKey) {
          openImageExternal(src);
        } else {
          openImageViewer(src, f.filename);
        }
      });
      li.appendChild(thumb);
    }

    li.appendChild(el("span", f.filename, { class: "file-name" }));
    li.appendChild(el("span", fileSizeLabel(f.size), { class: "file-size" }));

    // Manual print button: opens the native print dialog for this one file so
    // the worker can print a paper copy on demand.
    const printBtn = el("button", t("add.printFile"), {
      class: "secondary",
      type: "button",
      title: t("add.printFile"),
    });
    printBtn.addEventListener("click", () => printAttachment(f));
    li.appendChild(printBtn);

    const removeBtn = el("button", t("add.removeFile"), {
      class: "secondary",
      type: "button",
    });
    removeBtn.addEventListener("click", () => {
      droppedFiles.splice(i, 1);
      renderDroppedFiles();
    });
    li.appendChild(removeBtn);

    DroppedFiles.appendChild(li);
  }
}

// Open the native print dialog for a single attached file so the worker can
// manually print a paper copy on demand.
async function printAttachment(file) {
  if (!file || !file.base64) return;
  if (window.bridge && typeof window.bridge.PrintAttachment === "function") {
    try {
      const result = await window.bridge.PrintAttachment({
        filename: file.filename,
        mimeType: file.mimeType,
        base64: file.base64,
      });
      if (result && result.ok) {
        toast(t("add.printSuccess"), "success");
      } else if (result && result.cancelled) {
        toast(t("email.printCancelled"), "info");
      } else {
        const reason = (result && result.error) || "unknown error";
        console.error("PrintAttachment failed:", reason);
        toast(t("add.printFailed"), "error");
      }
    } catch (err) {
      console.error("PrintAttachment failed:", err);
      toast(t("add.printFailed"), "error");
    }
  }
}

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result || "";
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error || new Error("Read failed"));
    reader.readAsDataURL(file);
  });
}

async function addFiles(fileList) {
  const files = Array.from(fileList || []);
  for (const file of files) {
    try {
      const base64 = await readFileAsBase64(file);
      droppedFiles.push({
        filename: file.name,
        mimeType: file.type || "application/octet-stream",
        size: file.size,
        base64,
      });
      prefillPolicyNumberFromFilename(file.name);
    } catch (err) {
      console.error("Failed to read dropped file:", err);
    }
  }
  renderDroppedFiles();
}

if (DropArea && FileInput) {
  DropArea.addEventListener("click", () => FileInput.click());
  DropArea.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      FileInput.click();
    }
  });

  FileInput.addEventListener("change", () => {
    addFiles(FileInput.files);
    FileInput.value = "";
  });

  ["dragenter", "dragover"].forEach((type) => {
    DropArea.addEventListener(type, (e) => {
      e.preventDefault();
      e.stopPropagation();
      DropArea.classList.add("dragover");
    });
  });
  ["dragleave", "drop"].forEach((type) => {
    DropArea.addEventListener(type, (e) => {
      e.preventDefault();
      e.stopPropagation();
      DropArea.classList.remove("dragover");
    });
  });
  DropArea.addEventListener("drop", (e) => {
    addFiles(e.dataTransfer ? e.dataTransfer.files : []);
  });
}

// ---------------------------------------------------------------------------
// Desktop PDF watcher
// ---------------------------------------------------------------------------
// While a policy is being processed, the worker's tools download the two policy
// PDFs to the Desktop. Email policies attach them to the form; walk-in
// insurances only get a paper copy of both. The main process performs the
// actual polling, printing and cleanup.
const DesktopWatchStorageKey = "desktopPdfWatchSinceMs";

function desktopWatchAvailable() {
  return (
    window.bridge &&
    typeof window.bridge.StartDesktopPdfWatch === "function" &&
    typeof window.bridge.StopDesktopPdfWatch === "function" &&
    typeof window.bridge.OnDesktopPdfFound === "function"
  );
}

function stopDesktopPdfWatch() {
  if (!desktopWatchAvailable()) return;
  window.bridge.StopDesktopPdfWatch().catch((err) => {
    console.error("[DesktopPdfWatch] Failed to stop watching the Desktop:", err);
  });
}

// Pre-fill the policy-number field from a policy PDF filename. The insurer
// names one of the policy PDFs "BG_02_ FI<policy>.pdf", so the policy number
// can be read straight out of the filename (the "FI" marker is stripped — see
// extractPolicyNumber in numberField.js). Only fills the field when a number
// is actually found and leaves any existing value untouched otherwise.
function prefillPolicyNumberFromFilename(filename) {
  const found = extractPolicyNumber(filename);
  if (found === null) return;
  const input = document.getElementById("PolicyNumberInput");
  if (input) input.value = found;
}

// Files discovered on the Desktop, ready to be attached to the policy.
// Deduplicates by filename as a safety net (the main process already avoids
// re-sending the same file).
function attachDesktopPdf(files) {
  const seen = new Set(droppedFiles.map((f) => f.filename));
  let added = 0;
  for (const file of files || []) {
    if (!file || typeof file.base64 !== "string" || !file.base64) continue;
    if (seen.has(file.filename)) continue;
    seen.add(file.filename);
    droppedFiles.push({
      filename: file.filename,
      mimeType: file.mimeType || "application/pdf",
      size: Number(file.size) || 0,
      base64: file.base64,
    });
    prefillPolicyNumberFromFilename(file.filename);
    added += 1;
  }
  if (added) {
    renderDroppedFiles();
    toast(t("add.desktopPdfAttached"), "info");
  }
}

function startDesktopPdfWatch() {
  if (!desktopWatchAvailable()) return;

  // The moment the email card or the walk-in insurance button was clicked,
  // stored by the dashboard. It is the lower bound for which Desktop PDFs
  // count as "new" for this policy.
  let sinceMs = Date.now();
  try {
    const raw = localStorage.getItem(DesktopWatchStorageKey);
    if (raw) {
      const parsed = Number(raw);
      if (Number.isFinite(parsed) && parsed > 0) sinceMs = parsed;
    }
    localStorage.removeItem(DesktopWatchStorageKey);
  } catch (err) {
    console.error("[DesktopPdfWatch] Failed to read the start time:", err);
  }

  // Email policies attach the downloaded PDFs to the form. Walk-in insurances
  // have no return email or attachment area: the main process simply prints
  // both files and deletes each one once its print has finished.
  if (OpenedFromEmail) {
    window.bridge.OnDesktopPdfFound((file) => attachDesktopPdf([file]));
  }
  window.bridge
    .StartDesktopPdfWatch(sinceMs, {
      mode: OpenedFromEmail ? "email" : "walkin",
    })
    .catch((err) => {
      console.error("[DesktopPdfWatch] Failed to start watching the Desktop:", err);
    });
}

// ---------------------------------------------------------------------------
// Zoomable / printable picture viewer
// ---------------------------------------------------------------------------
// Open an image with the OS default viewer (outside Electron) via the preload
// bridge. Falls back to a new browser tab when the bridge is unavailable.
function openImageExternal(src) {
  if (!src) return;
  if (window.bridge && typeof window.bridge.OpenImageExternal === "function") {
    window.bridge.OpenImageExternal(src);
    return;
  }
  const w = window.open("", "_blank");
  if (!w) {
    toast(t("email.print"), "info");
    return;
  }
  const html = `<html><head><title></title></head>
    <body style="margin:0;display:flex;align-items:center;justify-content:center;">
      <img src="${src}" style="max-width:100%;max-height:100%;" />
    </body></html>`;
  w.document.write(html);
  w.document.close();
}

// Unrotated source of the picture currently shown in the viewer. Rotations are
// always rendered from this original so repeated turns never degrade quality.
let viewerOriginalSrc = "";
// Bumped on every open/close/rotate so a slow, stale rotation never overwrites
// a newer one (e.g. when the rotate button is clicked rapidly).
let viewerRotateToken = 0;

function openImageViewer(src, title) {
  if (!ViewerImage || !ImageViewer) return;
  viewerScale = 1;
  viewerRotation = 0;
  viewerRotateToken++;
  viewerOriginalSrc = src;
  ViewerImage.src = src;
  ViewerImage.alt = title || "";
  ViewerImage.style.transform = `scale(${viewerScale})`;
  ImageViewer.classList.remove("hidden");
}

function closeImageViewer() {
  if (!ImageViewer) return;
  ImageViewer.classList.add("hidden");
  ViewerImage.src = "";
  viewerOriginalSrc = "";
  viewerRotation = 0;
  viewerRotateToken++;
}

// Load an image source into a detached <img> so it can be drawn to a canvas.
function loadImageElement(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Failed to load image for rotation."));
    img.src = src;
  });
}

// Produce a data URL of `src` rotated clockwise by `degrees` (0/90/180/270).
// Keeps JPEG/WebP formats (high quality) to avoid huge PNG re-encodes of
// photos; everything else is rendered as PNG.
async function rotateImageSource(src, degrees) {
  const img = await loadImageElement(src);
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  const quarterTurn = degrees === 90 || degrees === 270;

  const canvas = document.createElement("canvas");
  canvas.width = quarterTurn ? h : w;
  canvas.height = quarterTurn ? w : h;
  const ctx = canvas.getContext("2d");
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate((degrees * Math.PI) / 180);
  ctx.drawImage(img, -w / 2, -h / 2);

  const mimeMatch = /^data:([^;,]+)/.exec(src);
  const mime = mimeMatch ? mimeMatch[1].toLowerCase() : "";
  if (mime === "image/jpeg" || mime === "image/jpg") {
    return canvas.toDataURL("image/jpeg", 0.95);
  }
  if (mime === "image/webp") {
    return canvas.toDataURL("image/webp", 0.95);
  }
  return canvas.toDataURL("image/png");
}

// Rotate the viewer picture by `delta` degrees (+90 = right, -90 = left).
// The rotated picture replaces the displayed source, so printing and
// "open externally" use exactly what the worker sees.
async function rotateViewer(delta) {
  if (!ViewerImage || !viewerOriginalSrc) return;
  viewerRotation = (((viewerRotation + delta) % 360) + 360) % 360;
  const token = ++viewerRotateToken;
  const original = viewerOriginalSrc;

  if (viewerRotation === 0) {
    ViewerImage.src = original;
    return;
  }

  try {
    const rotated = await rotateImageSource(original, viewerRotation);
    // Ignore results from an outdated click or a closed/replaced picture.
    if (token !== viewerRotateToken || original !== viewerOriginalSrc) return;
    ViewerImage.src = rotated;
  } catch (err) {
    console.error("Image rotation failed:", err);
  }
}

function applyViewerScale() {
  if (!ViewerImage) return;
  ViewerImage.style.transform = `scale(${viewerScale})`;
}

function zoomViewer(delta) {
  viewerScale = Math.max(0.1, Math.min(8, viewerScale + delta));
  applyViewerScale();
}

// Guard against rapid/duplicate clicks: the native print dialog takes a moment
// (~0.5s render delay + file load) to appear, so an impatient second click used
// to open a second print window and dialog stacked on top of the first.
let viewerPrinting = false;

async function printViewerImage() {
  if (!ViewerImage || !ViewerImage.src) return;
  if (viewerPrinting) return;
  viewerPrinting = true;
  try {
    if (window.bridge && typeof window.bridge.PrintImage === "function") {
      const result = await window.bridge.PrintImage(ViewerImage.src);
      if (result && result.ok) {
        toast(t("email.printSuccess"), "success");
      } else if (result && result.cancelled) {
        toast(t("email.printCancelled"), "info");
      } else {
        const reason = (result && result.error) || "unknown error";
        console.error("PrintImage failed:", reason);
        toast(t("email.printFailed"), "error");
      }
    } else {
      // Fallback for a plain browser context (no Electron bridge).
      const w = window.open("", "_blank");
      if (!w) {
        toast(t("email.print"), "info");
        return;
      }
      const html = `<html><head><title>${ViewerImage.alt || ""}</title></head>
        <body style="margin:0;display:flex;align-items:center;justify-content:center;">
          <img src="${ViewerImage.src}" style="max-width:100%;max-height:100%;" />
        </body></html>`;
      w.document.write(html);
      w.document.close();
    }
  } catch (err) {
    console.error("PrintImage failed:", err);
    toast(t("email.printFailed"), "error");
  } finally {
    viewerPrinting = false;
  }
}

if (ViewerZoomIn)
  ViewerZoomIn.addEventListener("click", () => zoomViewer(0.25));
if (ViewerZoomOut)
  ViewerZoomOut.addEventListener("click", () => zoomViewer(-0.25));
if (ViewerResetZoom)
  ViewerResetZoom.addEventListener("click", () => {
    viewerScale = 1;
    applyViewerScale();
  });
if (ViewerRotateLeft)
  ViewerRotateLeft.addEventListener("click", () => rotateViewer(-90));
if (ViewerRotateRight)
  ViewerRotateRight.addEventListener("click", () => rotateViewer(90));
if (ViewerPrint) ViewerPrint.addEventListener("click", printViewerImage);
if (ViewerClose) ViewerClose.addEventListener("click", closeImageViewer);
if (ImageViewer) {
  ImageViewer.addEventListener("click", (e) => {
    if (e.target === ImageViewer) closeImageViewer();
  });
}
if (ViewerImage) {
  ViewerImage.addEventListener("wheel", (e) => {
    e.preventDefault();
    zoomViewer(e.deltaY < 0 ? 0.25 : -0.25);
  });
}

// ---------------------------------------------------------------------------
// Ctrl-hover cursor helpers
// ---------------------------------------------------------------------------
// Images that open externally when Ctrl/Cmd is held show a pointer cursor while
// the key is down; otherwise they keep their zoom-in cursor.
const CtrlCursorImages = new Set();
let CtrlHeld = false;

function refreshCtrlCursors() {
  for (const img of CtrlCursorImages) {
    img.style.cursor = CtrlHeld ? "pointer" : "zoom-in";
  }
}

function trackCtrlCursor(img) {
  CtrlCursorImages.add(img);
  img.addEventListener("mouseenter", (e) => {
    CtrlHeld = e.ctrlKey || e.metaKey;
    img.style.cursor = CtrlHeld ? "pointer" : "zoom-in";
  });
  img.addEventListener("mouseleave", () => {
    img.style.cursor = "zoom-in";
  });
}

// Escape hotkey: hide the image viewer window if it is open.
window.addEventListener("keydown", (e) => {
  if (
    e.key === "Escape" &&
    ImageViewer &&
    !ImageViewer.classList.contains("hidden")
  ) {
    e.preventDefault();
    closeImageViewer();
  }
});

window.addEventListener("keydown", (e) => {
  if (e.key === "Control" || e.key === "Meta") {
    CtrlHeld = true;
    refreshCtrlCursors();
  }
});
window.addEventListener("keyup", (e) => {
  if (e.key === "Control" || e.key === "Meta") {
    CtrlHeld = false;
    refreshCtrlCursors();
  }
});
window.addEventListener("blur", () => {
  CtrlHeld = false;
  refreshCtrlCursors();
});

// ---------------------------------------------------------------------------
// Auto-fill price based on insurance type and duration
// ---------------------------------------------------------------------------
// Extra fees added on top of the base price. The non-Turk fee is
// currency-specific: EUR 5, Turkish lira 200.
const NON_TURK_FEE = 5;
const NON_TURK_FEE_TRY = 200;
const CARD_FEE = 2;

const NonTurkInput = document.getElementById("NonTurkInput");
const CardFeeInput = document.getElementById("CardFeeInput");
const CashInput = document.getElementById("CashInput");
// Read-only price shown on the form. The price can NOT be typed: it is always
// the tariff price for the selected vehicle type + duration plus the selected
// fees, and that calculated value is what gets saved.
const TotalPriceDisplay = document.getElementById("TotalPriceDisplay");

// The tariff price without the optional fees, or null while there is none -
// either the tariffs are still loading, or the selected vehicle type +
// duration has no price ("n/a"). A policy cannot be saved without a price.
let basePrice = null;
// True while the tariffs are being (re)loaded, so "…" is shown, not "n/a".
let pricingLoading = true;

function round2(n) {
  return Math.round(n * 100) / 100;
}

// Currency selected on the creation form (EUR unless TRY is picked).
function selectedCurrency() {
  const input = document.getElementById("CurrencyInput");
  return input && input.value === "TRY" ? "TRY" : "EUR";
}

function currentFees() {
  let fees = 0;
  if (NonTurkInput && NonTurkInput.checked) {
    fees += selectedCurrency() === "TRY" ? NON_TURK_FEE_TRY : NON_TURK_FEE;
  }
  return fees;
}

// The price that will be saved: tariff price + saved fees (+5/+200 non-Turk),
// or null when there is no tariff price. The +2 card tax goes to the bank and
// is visual-only while creating the insurance, so it is never included here.
function currentTotalPrice() {
  if (basePrice === null) return null;
  return round2(basePrice + currentFees());
}

// The price shown on the creation form (includes the visual-only +2 card tax).
function currentDisplayPrice() {
  const total = currentTotalPrice();
  if (total === null) return null;
  const cardFee = CardFeeInput && CardFeeInput.checked ? CARD_FEE : 0;
  return round2(total + cardFee);
}

// Shows the calculated total in the read-only price field.
function renderTotalPrice() {
  if (!TotalPriceDisplay) return;
  const total = currentDisplayPrice();
  const unavailable = total === null;
  TotalPriceDisplay.classList.toggle("price-unavailable", unavailable);
  TotalPriceDisplay.textContent = unavailable
    ? pricingLoading
      ? "…"
      : "n/a"
    : total.toFixed(2);
}

// The card fee is only allowed when the payment is NOT cash. Switching to card
// auto-applies the +2 bank tax so the worker immediately sees the total to
// charge; they can still untick it afterwards to waive the fee.
function syncCardFeeState() {
  if (!CardFeeInput || !CashInput) return;
  if (CashInput.checked) {
    CardFeeInput.checked = false;
    CardFeeInput.disabled = true;
  } else {
    if (CardFeeInput.disabled) CardFeeInput.checked = true;
    CardFeeInput.disabled = false;
  }
}

function onFeeChange() {
  syncCardFeeState();
  renderTotalPrice();
}

if (NonTurkInput) NonTurkInput.addEventListener("change", onFeeChange);
if (CashInput) CashInput.addEventListener("change", onFeeChange);
if (CardFeeInput) CardFeeInput.addEventListener("change", onFeeChange);

syncCardFeeState();
renderTotalPrice();

// Pricing used for this form. Insurances created from an email card use the
// broker's pricing (resolved from the sender address); walk-ins use the
// branch pricing. Loaded from the server, with the locally cached pricing as
// a fallback when the request fails.
let policyPricing = null;
let tryPricing = null;

function lookupPrice(insuranceType, duration, currency) {
  const source = currency === "TRY" ? tryPricing : policyPricing;
  if (
    source &&
    source[insuranceType] &&
    source[insuranceType][duration] !== undefined
  ) {
    return source[insuranceType][duration];
  }
  return null;
}

async function loadPolicyPricing() {
  pricingLoading = true;
  renderTotalPrice();
  const params = new URLSearchParams();
  const from = PendingEmail && PendingEmail.from ? PendingEmail.from : "";
  if (from) params.set("from", from);
  const branch = localStorage.getItem("branch") || "";
  if (branch) params.set("branch", branch);
  try {
    const data = await api(`/tariffs/policy-pricing?${params.toString()}`);
    policyPricing = (data && data.pricing) || {};
    tryPricing = (data && data.tryPricing) || {};
  } catch (err) {
    console.warn("Failed to load policy pricing:", err);
    policyPricing = getPricingCache() || {};
    tryPricing = {};
  }
  pricingLoading = false;
  autofillPrice();
}

function autofillPrice() {
  const autoTypeInput = document.getElementById("AutoTypeInput");
  const durationInput = document.getElementById("DurationInput");

  if (!autoTypeInput || !durationInput) return;

  const insuranceType = autoTypeInput.value;
  const durationText = durationInput.value;

  // Map duration text to days: "15 дена" -> 15, "1 месец" -> 30, "3 месеца" -> 90
  let duration = null;
  if (durationText.includes("15")) duration = 15;
  else if (durationText.includes("месеца")) duration = 90;
  else if (durationText.includes("месец")) duration = 30;

  // Map insurance type: "Otomobil" -> "Auto", etc.
  let mappedType = null;
  if (insuranceType === "Otomobil" || insuranceType === "Automobile")
    mappedType = "Auto";
  else if (insuranceType === "Motor") mappedType = "Motor";
  else if (insuranceType === "Bus") mappedType = "Bus";
  else if (insuranceType === "Trailer") mappedType = "Trailer";

  // Look up the price. When there is none, "n/a" is shown instead of keeping
  // the previous value, and the policy cannot be saved.
  const currencyInput = document.getElementById("CurrencyInput");
  const currency = currencyInput ? currencyInput.value : "EUR";
  const price =
    mappedType && duration ? lookupPrice(mappedType, duration, currency) : null;
  const numeric = price === null || price === "" ? NaN : Number(price);
  basePrice = Number.isFinite(numeric) ? numeric : null;
  renderTotalPrice();
}

// Attach auto-fill listeners to duration and vehicle type inputs
if (DurationInput) {
  DurationInput.addEventListener("change", autofillPrice);
}

const AutoTypeInput = document.getElementById("AutoTypeInput");
if (AutoTypeInput) {
  AutoTypeInput.addEventListener("change", () => {
    autofillPrice();
    syncCurrencyOptions();
  });
}

// Turkish lira is only allowed for Auto policies at the Lesovo / Kap Andreevo
// border crossings. Everywhere else the policy is EUR only, so the TRY option
// is disabled and any TRY selection is reset to EUR while it does not apply.
const CurrencyInput = document.getElementById("CurrencyInput");

function tryCurrencyAllowed() {
  const branch = localStorage.getItem("branch") || "";
  const vehicle = AutoTypeInput ? AutoTypeInput.value : "";
  const isBorderCrossing =
    branch.includes("Лесово") || branch.includes("Андреево") ||
    branch.includes("Lesovo") || branch.includes("Andreevo");
  const isAuto = vehicle === "Automobile" || vehicle === "Otomobil";
  return isBorderCrossing && isAuto;
}

function syncCurrencyOptions() {
  if (!CurrencyInput) return;
  const tryOption = Array.from(CurrencyInput.options).find((o) => o.value === "TRY");
  const allowed = tryCurrencyAllowed();
  if (tryOption) tryOption.disabled = !allowed;
  if (!allowed && CurrencyInput.value === "TRY") CurrencyInput.value = "EUR";
}

if (CurrencyInput) {
  CurrencyInput.addEventListener("change", () => {
    syncCurrencyOptions();
    autofillPrice();
  });
  syncCurrencyOptions();
}

// Initial calculation once pricing is loaded (duration + vehicle type already
// have default selections).
loadPolicyPricing();

// ---------------------------------------------------------------------------
// Form helpers
// ---------------------------------------------------------------------------
function setMessage(text, isError) {
  if (!DisplayMsg) return;
  DisplayMsg.textContent = text;
  DisplayMsg.className = isError ? "error" : "success";
  DisplayMsg.style.color = "";
}

function clearForm() {
  for (const el of ClearFormArray) {
    el.value = "";
  }
  DurationInput.value = DurationOptions[1];
  // Walk-ins go back to today's pre-filled date; email forms stay empty
  // (there the date must always be chosen deliberately).
  if (StartDateInput)
    StartDateInput.value = OpenedFromEmail ? "" : todayLocalDate();
  droppedFiles = [];
  renderDroppedFiles();
  if (NonTurkInput) NonTurkInput.checked = false;
  if (CardFeeInput) CardFeeInput.checked = false;
  // No price until the tariffs below are reloaded and recalculated.
  basePrice = null;
  syncCardFeeState();
  removeEmailPaymentOptions();
  setMessage("", false);
  // The email (if any) may have just been completed; reload the matching
  // pricing and recalculate the default price.
  loadPolicyPricing();
}

async function goBack() {
  // Cancel: return the unread email as a card to every client. Wait for the
  // socket to authenticate, then flush the release frame before navigating.
  await waitForSocketAuth();
  releaseEmail();
  stopDesktopPdfWatch();
  await new Promise((r) => setTimeout(r, 120));
  clearPendingEmail();
  window.bridge.LoadNewPage("renderer/WorkPage/WorkPage.html");
}

// After a reply the form closes and the worker is taken back to the email
// cards. The email is released (not completed): it stays on the dashboard,
// parked and dimmed as "answered" until the broker's answer arrives as a new
// email, which revives and re-queues the card.
async function closeFormAfterReply() {
  await waitForSocketAuth();
  releaseEmail();
  stopDesktopPdfWatch();
  await new Promise((r) => setTimeout(r, 120));
  clearPendingEmail();
  try {
    localStorage.setItem(
      "flashToast",
      JSON.stringify({ text: t("add.replySent"), type: "success" })
    );
  } catch (err) {
    console.error("Failed to store flash toast:", err);
  }
  window.bridge.LoadNewPage("renderer/WorkPage/WorkPage.html");
}

BackButton.addEventListener("click", goBack);

// Clearing wipes every entered value and attached file, so ask first.
ClearButton.addEventListener("click", () => {
  if (!confirm(t("add.clearConfirm"))) return;
  clearForm();
});

// Set once a successful save starts navigating back to the dashboard.
let redirecting = false;

// How long Save waits for the server before the policy is left in the outbox
// and the worker is sent on to the next one. Short enough not to stall the
// worker on a dead connection; the outbox returns even earlier as soon as an
// attempt fails outright (no network, server down).
const OUTBOX_WAIT_MS = 10000;

InsuranceForm.addEventListener("submit", async function (e) {
  e.preventDefault();

  const FormObject = {};
  for (const el of FormInputArray) {
    // Skip inputs removed from the form (the cash / card-fee checkboxes on
    // email policies) — FormInputArray was captured before they were removed.
    if (!el.id || !el.isConnected) continue;
    if (el.type === "checkbox") FormObject[el.id] = el.checked;
    else FormObject[el.id] = el.value;
  }

  // Car number, policy number and blank number are required for every policy
  // - walk-ins and email cards alike. Whitespace alone does not count. The
  // first empty one (in form order) is reported and focused.
  const requiredNumbers = [
    ["CarNumberInput", "add.carNumberRequired"],
    ["PolicyNumberInput", "add.policyNumberRequired"],
    ["BlancNumberInput", "add.blancNumberRequired"],
  ];
  const trimmed = {};
  for (const [id, messageKey] of requiredNumbers) {
    trimmed[id] = FormObject[id] ? String(FormObject[id]).trim() : "";
    if (!trimmed[id]) {
      setMessage(t(messageKey), true);
      const inputEl = document.getElementById(id);
      if (inputEl) inputEl.focus();
      return;
    }
  }
  const carNumber = trimmed.CarNumberInput;
  const policyNumber = trimmed.PolicyNumberInput;
  const blancNumber = trimmed.BlancNumberInput;

  // The policy number must be exactly 8 characters and the blank number
  // exactly 6, counted after trimming leading/trailing whitespace. Anything
  // else is reported, the field is focused and the policy is not posted.
  const exactLengths = [
    ["PolicyNumberInput", policyNumber, 8, "add.policyNumberLength"],
    ["BlancNumberInput", blancNumber, 6, "add.blancNumberLength"],
  ];
  for (const [id, value, length, messageKey] of exactLengths) {
    if (String(value).trim().length !== length) {
      setMessage(t(messageKey), true);
      const inputEl = document.getElementById(id);
      if (inputEl) inputEl.focus();
      return;
    }
  }

  // Email insurances must have an explicit starting date (walk-ins come
  // pre-filled with today). Show the error and open the calendar so the
  // worker can pick the date right away.
  const startDate = FormObject.StartDateInput
    ? String(FormObject.StartDateInput).trim()
    : "";
  if (OpenedFromEmail && !startDate) {
    setMessage(t("add.startDateRequired"), true);
    if (StartDateInput) {
      StartDateInput.focus();
      openDatePicker(StartDateInput);
    }
    return;
  }

  // The price is never typed - it is the calculated tariff price + fees. While
  // there is none (tariffs still loading, or no tariff for this vehicle type +
  // duration) the policy cannot be saved.
  const totalPrice = currentTotalPrice();
  if (totalPrice === null) {
    setMessage(
      t(pricingLoading ? "add.priceLoading" : "add.priceUnavailable"),
      true
    );
    return;
  }

  // Email card policies are answered with a return email carrying the policy
  // files, so they must not be saved without at least one attached file.
  if (returnEmailEnabled() && droppedFiles.length === 0) {
    const message = t("add.attachmentsRequired");
    console.error("Email policy submit blocked: no attached files");
    setMessage(message, true);
    toast(message, "error");
    if (DropArea) {
      DropArea.classList.add("drop-error");
      DropArea.scrollIntoView({ behavior: "smooth", block: "center" });
      DropArea.focus();
    }
    return;
  }

  const payload = {
    PolicyNumber: policyNumber,
    BlancNumber: blancNumber,
    CarNumber: carNumber,
    Duration: FormObject.DurationInput,
    // The branch is no longer typed on this form. It is selected at login and
    // stored in localStorage, so it is sent along with every created policy.
    Branch: localStorage.getItem("branch") || "",
    Otomobil: FormObject.AutoTypeInput,
    StartDate: FormObject.StartDateInput || "",
    // Calculated, read-only price (tariff + selected fees).
    Price: totalPrice.toFixed(2),
    CurrencyType: FormObject.CurrencyInput,
    // Email policies are paid only from the broker's balance; walk-ins are
    // paid in cash or by card.
    PaymentType: OpenedFromEmail
      ? "Broker"
      : FormObject.CashInput === true
      ? "Cash"
      : "Card",
    // Informational flag; the non-Turk fee (+5 EUR / +200 TRY) is already
    // included in Price. The non-Turk tax only applies to walk-ins. The card
    // fee (+2) is a bank tax shown only visually during creation and never
    // stored.
    NonTurk: !OpenedFromEmail && FormObject.NonTurkInput === true,
    CardFee: false,

    // Broker is not typed on this form. When the form was opened from an unread
    // email, the sender's address is sent so the server can resolve the broker.
    EmailFrom: PendingEmail ? PendingEmail.from || "" : "",

    // Return-email handling: the original Gmail message ID (when this form was
    // opened from an unread email) and the files dropped by the worker.
    MessageId: PendingEmail ? PendingEmail.messageId || null : null,
    // A walk-in insurance has no broker email to reply to, so the return email
    // must never be sent for it. Email policies always send it.
    DisableReturnEmail: !PendingEmail,
    // Creation time, computed here on the worker's PC in local time and stored
    // by the server as sent.
    CreationDate: localDateTimeNow(),
    // The worker's UTC offset in minutes (east positive, e.g. 180 for UTC+3).
    // Only used by servers that do not read CreationDate yet.
    TzOffset: -new Date().getTimezoneOffset(),
    Attachments: droppedFiles.map((f) => ({
      filename: f.filename,
      mimeType: f.mimeType,
      base64: f.base64,
    })),
  };

  // A broker-linked insurance whose blanc number falls outside the broker's
  // blanc batches is rejected once with a distinct error; the worker is then
  // asked whether to create the policy anyway before it is re-sent with a
  // force flag.
  let forceOutsideBlancBatch = false;

  for (let attempt = 0; attempt < 2; attempt++) {
    const outbound = forceOutsideBlancBatch
      ? { ...payload, ForceOutsideBlancBatch: true }
      : payload;

    SubmitFormButton.disabled = true;
    try {
      // Sent through the durable outbox: with a working connection this waits
      // for the server like a normal request; when the server cannot be reached
      // the policy (with its files) is stored on disk and retried every 5 s in
      // the background, and the worker moves on to the next policy.
      const outcome = await submitWithOutbox(
        {
          path: "/worker/insurances",
          body: JSON.stringify(outbound),
          kind: "insurance",
          label: [outbound.BlancNumber, outbound.CarNumber]
            .filter(Boolean)
            .join(" · "),
          messageId: returnEmailEnabled() ? PendingEmail.messageId : null,
          // After an attempt that got no answer, the outbox checks whether this
          // policy already exists before re-sending it (no duplicates).
          verify: {
            path: `/insurances?blancNumber=${encodeURIComponent(
              outbound.BlancNumber
            )}&author=${encodeURIComponent(getUsername())}`,
            listKey: "insurances",
            match: { BlancNumber: outbound.BlancNumber, Author: getUsername() },
          },
        },
        OUTBOX_WAIT_MS
      );

      if (outcome.status === "failed") {
        // The server answered and rejected it (validation, duplicate, ...):
        // keep the form so the worker can fix it.
        const error = new Error(outcome.error || t("serverError"));
        error.status = outcome.httpStatus;
        error.code = outcome.errorCode || null;
        throw error;
      }

      const queued = outcome.status !== "sent";
      const result = outcome.result || {};

      // The insurance is saved even when the return email fails (the server
      // sends it after committing), so report that failure separately.
      const replyError = !queued && result && result.replyError;
      let flash;
      if (queued) {
        console.warn(
          "Insurance queued in the outbox (server unreachable):",
          outcome.error || outcome.status
        );
        flash = { text: t("outbox.queuedToast"), type: "info" };
      } else if (replyError) {
        console.error("Return email failed after saving insurance:", replyError);
        flash = { text: t("add.replyFailed").replace("{e}", replyError), type: "error" };
      } else {
        flash = { text: t("add.saved"), type: "success" };
      }
      toast(flash.text, flash.type);

      // The form is complete (email policy or walk-in): return the worker to the
      // dashboard with the unread email cards. The toast is handed over through
      // localStorage because it would otherwise be lost on navigation; WorkPage
      // shows it once loaded.
      if (OpenedFromEmail) {
        // Delivered: mark the email handled, removing its card everywhere.
        // Queued: keep it reserved; the dashboard keeps the claim alive and
        // completes the email once the outbox delivers the policy.
        leavingEmail = true;
        await waitForSocketAuth();
        if (!queued) {
          const sentNow = completeEmail();
          if (sentNow && outcome.id && outboxAvailable()) {
            window.bridge.OutboxAcknowledge(outcome.id).catch(() => {});
          }
        }
        // Give the socket a moment to flush the "complete_email" frame before
        // the page is unloaded (same approach as goBack()).
        await new Promise((r) => setTimeout(r, 120));
      }
      clearPendingEmail();
      try {
        localStorage.setItem("flashToast", JSON.stringify(flash));
      } catch (err) {
        console.error("Failed to store flash toast:", err);
      }
      // Keep Save disabled while the page unloads so it can't be submitted twice.
      stopDesktopPdfWatch();
      redirecting = true;
      if (outcome.status === "auth") {
        // Session expired (401). The policy is safe in the outbox and is sent
        // with the new token right after the worker logs in again.
        toast(t("outbox.authToast"), "error");
        redirectToLogin("sessionExpired");
        return;
      }
      window.bridge.LoadNewPage("renderer/WorkPage/WorkPage.html");
      return;
    } catch (error) {
      console.error("Error saving insurance:", error);
      const message =
        translateError(error && error.message ? error.message : "") ||
        t("serverError");

      // The blanc number is outside the broker's blanc batches: show the
      // error and ask whether to create the policy anyway.
      if (
        !forceOutsideBlancBatch &&
        error &&
        error.code === BLANC_OUTSIDE_BROKER_BATCHES_CODE
      ) {
        setMessage(message, true);
        toast(message, "error");
        if (!confirm(t("add.blancOutsideBatchesConfirm"))) {
          return;
        }
        forceOutsideBlancBatch = true;
        continue;
      }

      setMessage(message, true);
      toast(message, "error");
      return;
    } finally {
      if (!redirecting) SubmitFormButton.disabled = false;
    }
  }
});

// True while a reply request is in flight (the button stays disabled even if
// the worker keeps typing).
let replySending = false;

// The reply button is only clickable once something has been typed in the
// reply input. Whitespace alone does not count: sendReply rejects it anyway.
// The empty state gets its own class (faded to 0.2 in the CSS) so it looks
// different from the normal disabled "sending" state.
function syncReplyButton() {
  if (!ReplyButton) return;
  const isEmpty = !ReplyInput || !ReplyInput.value.trim();
  ReplyButton.classList.toggle("reply-empty", isEmpty);
  ReplyButton.disabled = isEmpty || replySending;
}

async function sendReply() {
  try {
    if (!PendingEmail || !PendingEmail.messageId) {
      console.error("Cannot send reply: no pending email");
      toast(t("emailConnUnavailable"), "error");
      return;
    }

    const text = ReplyInput ? ReplyInput.value.trim() : "";
    if (!text) {
      toast(t("add.replyEmpty"), "error");
      return;
    }

    if (!confirm(t("add.replyConfirm"))) return;

    replySending = true;
    syncReplyButton();
    await api("/worker/insurances/reply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messageId: PendingEmail.messageId,
        bodyText: text,
      }),
    });
    toast(t("add.replySent"), "success");
    if (ReplyInput) ReplyInput.value = "";

    // Remember the employee's answer and mark the conversation as answered.
    // The dashboard reads both after the navigation: the card is dimmed and
    // parked at the bottom right until the broker's answer arrives.
    const key = conversationKey();
    const now = Date.now();
    emailConversationRecord(localStorage, key, {
      id: `employee:${PendingEmail.messageId}:${now}`,
      direction: "employee",
      from: getUsername() || "",
      text,
      at: now,
      source: "employee",
    });
    emailMarkAnswered(localStorage, key, {
      at: now,
      by: getUsername() || "",
      messageIds: conversationMessageIds(),
    });

    // The reply is done: close the form and return to the email cards.
    await closeFormAfterReply();
  } catch (error) {
    reportError("Error sending reply", error, "emailSendFailed");
  } finally {
    replySending = false;
    // Re-evaluates the input: after a successful send it was cleared, so the
    // button goes back to its faded, unclickable state.
    syncReplyButton();
  }
}

if (ReplyButton) ReplyButton.addEventListener("click", sendReply);
if (ReplyInput) ReplyInput.addEventListener("input", syncReplyButton);
syncReplyButton();

// ---------------------------------------------------------------------------
// Worker presence: the form is open, so the base status is "working" (orange).
// Once the worker stops interacting (mouse/keyboard/input) for more than the
// afk threshold, they flip to "afk" (red).
// ---------------------------------------------------------------------------
const PRESENCE_CHECK_MS = 15 * 1000;
let presenceSocket = null;
let presenceStatus = null; // last status sent to the server
let lastActivityAt = Date.now();

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
  if (presenceStatus === "afk") sendPresence("working");
}

function setupPresenceSocket() {
  if (getRole() !== "2") return;
  if (emailSocket) {
    // Reuse emailSocket so the form page maintains a single WebSocket
    // connection for emails, attachments, outbox sync and presence.
    presenceSocket = emailSocket;
  } else {
    presenceSocket = new UnreadEmailSocket({
      auth_ok: () => sendPresence(presenceStatusFor("working", lastActivityAt)),
    });
    presenceSocket.connect();
  }

  trackUserActivity(markActivity);
  if (InsuranceForm) {
    InsuranceForm.addEventListener("input", markActivity);
    InsuranceForm.addEventListener("change", markActivity);
  }
  setInterval(() => {
    const status = presenceStatusFor("working", lastActivityAt);
    if (status !== presenceStatus) sendPresence(status);
  }, PRESENCE_CHECK_MS);
}

trimOnPaste(document.getElementById("CarNumberInput"));
trimOnPaste(document.getElementById("PolicyNumberInput"));
trimOnPaste(document.getElementById("BlancNumberInput"));
autofillEmailNumbers();

configureWalkInMode();
renderEmailSide();
setupEmailSocket();
setupPresenceSocket();
startDesktopPdfWatch();

// A page unload (back button, save, or any other navigation away from the
// form) must never leave the Desktop watcher running in the main process.
window.addEventListener("pagehide", stopDesktopPdfWatch);
