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
const ViewerPrint = document.getElementById("ViewerPrint");
const ViewerClose = document.getElementById("ViewerClose");

const FormInputArray = Array.from(document.getElementsByClassName("FormInput"));
const ClearFormArray = Array.from(document.getElementsByClassName("ClearForm"));

let droppedFiles = []; // { filename, mimeType, size, base64 }
let viewerScale = 1;

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
const emailAttachmentEntries = new Map(); // id -> { img|tile, att, requested, base64 }

function isImageAttachment(att) {
  return typeof att.mimeType === "string" && att.mimeType.startsWith("image/");
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
// so they are removed from the form entirely (not just hidden/disabled) and a
// note in their place says how the policy is paid. Walk-ins keep both options.
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

  for (const id of ["CashInput", "CardFeeInput"]) {
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

function renderEmailSide() {
  if (!PendingEmail || !EmailSide || !EmailSideBody || !EmailSideTitle) {
    return;
  }

  // The reply UI only makes sense when the form was opened from an email card.
  if (ReplySection) ReplySection.classList.remove("hidden");

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

  const attachments = PendingEmail.attachments || [];
  if (attachments.length) {
    const heading = el("h3", t("email.attachments"));
    EmailSideBody.appendChild(heading);
    const gallery = el("div", null, { class: "email-attachments" });
    for (const att of attachments) {
      const wrap = el("div", null, { class: "email-attachment" });
      const isImage = isImageAttachment(att);
      if (isImage && att.id != null) {
        // The card only carries attachment metadata; the image bytes are
        // fetched lazily via get_attachment and filled in on its reply.
        const img = el("img");
        img.alt = att.filename || t("email.attachment");
        img.classList.add("attachment-loading");
        emailAttachmentEntries.set(att.id, { img, att, requested: false });
        img.addEventListener("click", (e) => {
          if (!img.src) return;
          if (e.ctrlKey || e.metaKey) {
            openImageExternal(img.src);
          } else {
            openImageViewer(img.src, att.filename || "");
          }
        });
        wrap.appendChild(img);
      } else if (att.id != null) {
        // PDFs and any other file type: a tile that opens the file with the
        // system's default application once its bytes have been fetched.
        const tile = el("button", attachmentTypeLabel(att), {
          class: "attachment-file attachment-loading",
          type: "button",
          title: att.filename || t("email.attachment"),
        });
        const entry = { tile, att, requested: false, base64: null };
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
      gallery.appendChild(wrap);
    }
    EmailSideBody.appendChild(gallery);
  } else {
    EmailSideBody.appendChild(
      el("p", t("email.noAttachments"), { class: "muted" })
    );
  }

  EmailSide.classList.remove("hidden");
}

function requestEmailAttachments() {
  if (!emailSocket || !PendingEmail || !PendingEmail.messageId) return;
  for (const att of PendingEmail.attachments || []) {
    if (att.id == null) continue;
    const entry = emailAttachmentEntries.get(att.id);
    if (!entry || entry.requested) continue;
    try {
      emailSocket.send({
        type: "get_attachment",
        messageId: PendingEmail.messageId,
        id: att.id,
      });
      entry.requested = true;
    } catch (err) {
      reportError("Failed to request email attachment", err, "emailSendFailed");
    }
  }
}

// Set once the worker completes (saves) or cancels the email. From then on a
// reconnect must not claim the email again.
let leavingEmail = false;

function setupEmailSocket() {
  if (!PendingEmail || !PendingEmail.messageId) return;

  emailSocket = new UnreadEmailSocket({
    auth_ok: () => {
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
        emailSocket.send({
          type: "claim_email",
          messageId: PendingEmail.messageId,
          restore: true,
        });
      } catch (err) {
        reportError("Failed to claim email", err, "emailSendFailed");
      }
      // Attachment bytes are not included on the card; fetch each one lazily.
      requestEmailAttachments();
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
      if (entry.tile) {
        // Non-image attachment (PDF, document…): keep the bytes so a click on
        // the tile opens the file with the system's default application.
        if (msg.ok && msg.base64) {
          entry.base64 = msg.base64;
          entry.tile.classList.remove("attachment-loading");
        } else {
          // Too large to inline / fetch failed: the tile cannot be opened.
          entry.tile.classList.remove("attachment-loading");
          entry.tile.classList.add("attachment-unavailable");
          entry.tile.disabled = true;
        }
        return;
      }
      if (!entry.img) return;
      if (
        msg.ok &&
        msg.base64 &&
        typeof msg.mimeType === "string" &&
        msg.mimeType.startsWith("image/")
      ) {
        entry.img.src = `data:${msg.mimeType};base64,${msg.base64}`;
        entry.img.classList.remove("attachment-loading");
        trackCtrlCursor(entry.img);
      } else {
        // Could not be inlined (too large / fetch failed): show the filename.
        entry.img.replaceWith(
          el("span", entry.att.filename || t("email.attachment"), {
            class: "muted",
          })
        );
      }
    },
  });
  emailSocket.connect();
}

function releaseEmail() {
  leavingEmail = true;
  if (emailSocket && PendingEmail && PendingEmail.messageId) {
    try {
      emailSocket.send({
        type: "release_email",
        messageId: PendingEmail.messageId,
      });
    } catch (err) {
      reportError("Failed to release email", err, "emailSendFailed");
    }
  }
}

async function waitForSocketAuth(timeoutMs = 800) {
  if (!emailSocket) return;
  if (emailSocket.authed) return;
  const started = Date.now();
  while (!emailSocket.authed && Date.now() - started < timeoutMs) {
    await new Promise((r) => setTimeout(r, 50));
  }
}

function completeEmail() {
  leavingEmail = true;
  if (emailSocket && PendingEmail && PendingEmail.messageId) {
    try {
      emailSocket.send({
        type: "complete_email",
        messageId: PendingEmail.messageId,
      });
    } catch (err) {
      reportError("Failed to complete email", err, "emailSendFailed");
    }
  }
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

function openImageViewer(src, title) {
  if (!ViewerImage || !ImageViewer) return;
  viewerScale = 1;
  ViewerImage.src = src;
  ViewerImage.alt = title || "";
  ViewerImage.style.transform = `scale(${viewerScale})`;
  ImageViewer.classList.remove("hidden");
}

function closeImageViewer() {
  if (!ImageViewer) return;
  ImageViewer.classList.add("hidden");
  ViewerImage.src = "";
}

function applyViewerScale() {
  if (!ViewerImage) return;
  ViewerImage.style.transform = `scale(${viewerScale})`;
}

function zoomViewer(delta) {
  viewerScale = Math.max(0.1, Math.min(8, viewerScale + delta));
  applyViewerScale();
}

async function printViewerImage() {
  if (!ViewerImage || !ViewerImage.src) return;
  if (window.bridge && typeof window.bridge.PrintImage === "function") {
    try {
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
    } catch (err) {
      console.error("PrintImage failed:", err);
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
// Extra fees added on top of the base price.
const NON_TURK_FEE = 5;
const CARD_FEE = 2;

const NonTurkInput = document.getElementById("NonTurkInput");
const CardFeeInput = document.getElementById("CardFeeInput");
const CashInput = document.getElementById("CashInput");
const TotalPriceInput = document.getElementById("TotalPriceInput");

// The price without the optional fees. TotalPriceInput always shows
// basePrice + the currently selected fees.
let basePrice = 0;

// True while the selected vehicle type + duration has no price: the price field
// is left empty and shows "n/a" as a placeholder.
let priceUnavailable = false;

function setPriceUnavailable(unavailable) {
  priceUnavailable = unavailable;
  if (!TotalPriceInput) return;
  TotalPriceInput.placeholder = unavailable ? "n/a" : "";
  if (unavailable) {
    TotalPriceInput.value = "";
    basePrice = 0;
  }
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function currentFees() {
  let fees = 0;
  if (NonTurkInput && NonTurkInput.checked) fees += NON_TURK_FEE;
  if (CardFeeInput && CardFeeInput.checked) fees += CARD_FEE;
  return fees;
}

// Writes basePrice + fees into the price input (leaves it empty while there is
// no base price yet and no fee selected).
function renderTotalPrice() {
  if (!TotalPriceInput) return;
  if (priceUnavailable) return;
  const fees = currentFees();
  if (TotalPriceInput.value === "" && basePrice === 0 && fees === 0) return;
  TotalPriceInput.value = round2(basePrice + fees);
}

// The card fee is only allowed when the payment is NOT cash.
function syncCardFeeState() {
  if (!CardFeeInput || !CashInput) return;
  if (CashInput.checked) {
    CardFeeInput.checked = false;
    CardFeeInput.disabled = true;
  } else {
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

// When the worker types a price manually, treat it as the final total and
// derive the base price from it so toggling fees keeps working.
if (TotalPriceInput) {
  TotalPriceInput.addEventListener("input", () => {
    // Typing a price manually overrides the "n/a" state.
    priceUnavailable = false;
    TotalPriceInput.placeholder = "";
    const typed = parseFloat(TotalPriceInput.value);
    basePrice = Number.isFinite(typed) ? round2(typed - currentFees()) : 0;
  });
}
syncCardFeeState();

// Pricing used for this form. Insurances created from an email card use the
// broker's pricing (resolved from the sender address); walk-ins use the
// branch pricing. Loaded from the server, with the locally cached pricing as
// a fallback when the request fails.
let policyPricing = null;

function lookupPrice(insuranceType, duration) {
  if (
    policyPricing &&
    policyPricing[insuranceType] &&
    policyPricing[insuranceType][duration] !== undefined
  ) {
    return policyPricing[insuranceType][duration];
  }
  return null;
}

async function loadPolicyPricing() {
  const params = new URLSearchParams();
  const from = PendingEmail && PendingEmail.from ? PendingEmail.from : "";
  if (from) params.set("from", from);
  const branch = localStorage.getItem("branch") || "";
  if (branch) params.set("branch", branch);
  try {
    const data = await api(`/tariffs/policy-pricing?${params.toString()}`);
    policyPricing = (data && data.pricing) || {};
  } catch (err) {
    console.warn("Failed to load policy pricing:", err);
    policyPricing = getPricingCache() || {};
  }
  autofillPrice();
}

function autofillPrice() {
  const autoTypeInput = document.getElementById("AutoTypeInput");
  const durationInput = document.getElementById("DurationInput");
  const priceInput = document.getElementById("TotalPriceInput");

  if (!autoTypeInput || !durationInput || !priceInput) return;

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

  // Look up the price. When there is none, show "n/a" instead of keeping the
  // previous value.
  const price =
    mappedType && duration ? lookupPrice(mappedType, duration) : null;
  if (price !== null) {
    setPriceUnavailable(false);
    basePrice = Number(price) || 0;
    priceInput.value = round2(basePrice + currentFees());
  } else {
    setPriceUnavailable(true);
  }
}

// Attach auto-fill listeners to duration and vehicle type inputs
if (DurationInput) {
  DurationInput.addEventListener("change", autofillPrice);
}

const AutoTypeInput = document.getElementById("AutoTypeInput");
if (AutoTypeInput) {
  AutoTypeInput.addEventListener("change", autofillPrice);
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
  basePrice = 0;
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
  await new Promise((r) => setTimeout(r, 120));
  clearPendingEmail();
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

  const carNumber = FormObject.CarNumberInput
    ? String(FormObject.CarNumberInput).trim()
    : "";
  if (!carNumber) {
    setMessage(t("add.carNumberRequired"), true);
    const CarNumberInputEl = document.getElementById("CarNumberInput");
    if (CarNumberInputEl) CarNumberInputEl.focus();
    return;
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
    PolicyNumber: FormObject.PolicyNumberInput,
    BlancNumber: FormObject.BlancNumberInput,
    CarNumber: carNumber,
    Duration: FormObject.DurationInput,
    // The branch is no longer typed on this form. It is selected at login and
    // stored in localStorage, so it is sent along with every created policy.
    Branch: localStorage.getItem("branch") || "",
    Otomobil: FormObject.AutoTypeInput,
    StartDate: FormObject.StartDateInput || "",
    Price: FormObject.TotalPriceInput,
    CurrencyType: FormObject.CurrencyInput,
    // Email policies are paid only from the broker's balance; walk-ins are
    // paid in cash or by card.
    PaymentType: OpenedFromEmail
      ? "Broker"
      : FormObject.CashInput === true
      ? "Cash"
      : "Card",
    // Informational flags; their fees (+5 / +2) are already included in Price.
    NonTurk: FormObject.NonTurkInput === true,
    CardFee:
      !OpenedFromEmail &&
      FormObject.CardFeeInput === true &&
      FormObject.CashInput !== true,

    // Broker is not typed on this form. When the form was opened from an unread
    // email, the sender's address is sent so the server can resolve the broker.
    EmailFrom: PendingEmail ? PendingEmail.from || "" : "",

    // Return-email handling: the original Gmail message ID (when this form was
    // opened from an unread email) and the files dropped by the worker.
    MessageId: PendingEmail ? PendingEmail.messageId || null : null,
    // A walk-in insurance has no broker email to reply to, so the return email
    // must never be sent for it. Email policies always send it.
    DisableReturnEmail: !PendingEmail,
    // The worker's UTC offset in minutes (east positive, e.g. 180 for UTC+3),
    // so the server stamps CreationDate in local time instead of the database
    // server's (UTC) time. getTimezoneOffset() is west-positive, hence the
    // minus sign. Taken at submit time so daylight saving is always current.
    TzOffset: -new Date().getTimezoneOffset(),
    Attachments: droppedFiles.map((f) => ({
      filename: f.filename,
      mimeType: f.mimeType,
      base64: f.base64,
    })),
  };

  SubmitFormButton.disabled = true;
  try {
    const result = await api("/worker/insurances", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    // The insurance is saved even when the return email fails (the server
    // sends it after committing), so report that failure separately.
    const replyError = result && result.replyError;
    if (replyError) {
      const message = t("add.replyFailed").replace("{e}", replyError);
      console.error("Return email failed after saving insurance:", replyError);
      toast(message, "error");
    } else {
      toast(t("add.saved"), "success");
    }

    // The form is complete (email policy or walk-in): return the worker to the
    // dashboard with the unread email cards. The toast is handed over through
    // localStorage because it would otherwise be lost on navigation; WorkPage
    // shows it once loaded.
    if (OpenedFromEmail) {
      // Mark the email handled, removing its card everywhere.
      await waitForSocketAuth();
      completeEmail();
      // Give the socket a moment to flush the "complete_email" frame before
      // the page is unloaded (same approach as goBack()).
      await new Promise((r) => setTimeout(r, 120));
    }
    clearPendingEmail();
    try {
      localStorage.setItem(
        "flashToast",
        JSON.stringify(
          replyError
            ? {
                text: t("add.replyFailed").replace("{e}", replyError),
                type: "error",
              }
            : { text: t("add.saved"), type: "success" }
        )
      );
    } catch (err) {
      console.error("Failed to store flash toast:", err);
    }
    // Keep Save disabled while the page unloads so it can't be submitted twice.
    redirecting = true;
    window.bridge.LoadNewPage("renderer/WorkPage/WorkPage.html");
  } catch (error) {
    console.error("Error saving insurance:", error);
    const message = error.message || t("serverError");
    setMessage(message, true);
    toast(message, "error");
  } finally {
    if (!redirecting) SubmitFormButton.disabled = false;
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

configureWalkInMode();
renderEmailSide();
setupEmailSocket();
