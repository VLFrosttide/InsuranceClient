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
const DisableReturnEmailInput = document.getElementById(
  "DisableReturnEmailInput"
);
const ReplySection = document.getElementById("ReplySection");
const ReplyInput = document.getElementById("ReplyInput");
const ReplyButton = document.getElementById("ReplyButton");
const UnclaimButton = document.getElementById("UnclaimButton");

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

let emailSocket = null;

// The server sends email attachments as metadata only ({ id, filename,
// mimeType, size }). The image bytes are fetched lazily over the WebSocket via
// a "get_attachment" message. This maps an attachment id to its on-screen <img>
// so the get_attachment reply can fill the image in once the bytes arrive.
const emailAttachmentImages = new Map(); // id -> { img, att, requested }

function emailSubject(email) {
  return email.subject || email.from || t("email.noSubject");
}

function clearPendingEmail() {
  PendingEmail = null;
  localStorage.removeItem("pendingEmail");
}

// Walk-in insurances are created directly from the "+ Нова застраховка" button
// and have no associated broker email. There is no return email to send and no
// files to attach, so the file drop area and the "disable return email" test
// checkbox are hidden for them.
function configureWalkInMode() {
  const isWalkIn = !PendingEmail;
  if (DropArea) DropArea.classList.toggle("hidden", isWalkIn);
  if (FileInput) FileInput.hidden = isWalkIn;
  const testField = document.querySelector(".test-checkbox-field");
  if (testField) testField.classList.toggle("hidden", isWalkIn);
}

function renderEmailSide() {
  if (!PendingEmail || !EmailSide || !EmailSideBody || !EmailSideTitle) {
    return;
  }

  // The reply UI only makes sense when the form was opened from an email card.
  if (ReplySection) ReplySection.classList.remove("hidden");

  EmailSideTitle.textContent = emailSubject(PendingEmail);
  EmailSideBody.replaceChildren();

  const meta = el("div", null, { class: "email-meta" });
  meta.appendChild(el("div", `${t("email.from")} ${PendingEmail.from || "?"}`));
  meta.appendChild(el("div", `${t("email.date")} ${PendingEmail.date || "?"}`));
  EmailSideBody.appendChild(meta);

  const body = el("pre", PendingEmail.body || t("email.emptyBody"), {
    class: "email-body",
  });
  EmailSideBody.appendChild(body);

  const attachments = PendingEmail.attachments || [];
  if (attachments.length) {
    const heading = el("h3", t("email.attachments"));
    EmailSideBody.appendChild(heading);
    const gallery = el("div", null, { class: "email-attachments" });
    for (const att of attachments) {
      const wrap = el("div", null, { class: "email-attachment" });
      const isImage =
        typeof att.mimeType === "string" && att.mimeType.startsWith("image/");
      if (isImage && att.id != null) {
        // The card only carries attachment metadata; the image bytes are
        // fetched lazily via get_attachment and filled in on its reply.
        const img = el("img");
        img.alt = att.filename || t("email.attachment");
        img.classList.add("attachment-loading");
        emailAttachmentImages.set(att.id, { img, att, requested: false });
        img.addEventListener("click", (e) => {
          if (!img.src) return;
          if (e.ctrlKey || e.metaKey) {
            openImageExternal(img.src);
          } else {
            openImageViewer(img.src, att.filename || "");
          }
        });
        wrap.appendChild(img);
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
    if (typeof att.mimeType !== "string" || !att.mimeType.startsWith("image/"))
      continue;
    const entry = emailAttachmentImages.get(att.id);
    if (!entry || entry.requested) continue;
    entry.requested = true;
    emailSocket.send({
      type: "get_attachment",
      messageId: PendingEmail.messageId,
      id: att.id,
    });
  }
}

function setupEmailSocket() {
  if (!PendingEmail || !PendingEmail.messageId) return;

  emailSocket = new UnreadEmailSocket({
    auth_ok: () => {
      // Claim the email on this page's own connection. The server broadcasts
      // "email_claimed" to every other worker, removing their card.
      emailSocket.send({
        type: "claim_email",
        messageId: PendingEmail.messageId,
      });
      // Attachment bytes are not included on the card; fetch each image lazily.
      requestEmailAttachments();
    },
    get_attachment: (msg) => {
      const entry = emailAttachmentImages.get(msg.id);
      if (!entry || !entry.img) return;
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
  if (emailSocket && PendingEmail && PendingEmail.messageId) {
    emailSocket.send({
      type: "release_email",
      messageId: PendingEmail.messageId,
    });
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
  if (emailSocket && PendingEmail && PendingEmail.messageId) {
    emailSocket.send({
      type: "complete_email",
      messageId: PendingEmail.messageId,
    });
  }
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
  if (StartDateInput) StartDateInput.value = "";
  droppedFiles = [];
  renderDroppedFiles();
  if (DisableReturnEmailInput) DisableReturnEmailInput.checked = false;
  if (NonTurkInput) NonTurkInput.checked = false;
  if (CardFeeInput) CardFeeInput.checked = false;
  basePrice = 0;
  syncCardFeeState();
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
if (UnclaimButton) UnclaimButton.addEventListener("click", goBack);

ClearButton.addEventListener("click", clearForm);

InsuranceForm.addEventListener("submit", async function (e) {
  e.preventDefault();

  const FormObject = {};
  for (const el of FormInputArray) {
    if (!el.id) continue;
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
    Cash: FormObject.CashInput === true,
    // Informational flags; their fees (+5 / +2) are already included in Price.
    NonTurk: FormObject.NonTurkInput === true,
    CardFee: FormObject.CardFeeInput === true && FormObject.CashInput !== true,

    // Broker is not typed on this form. When the form was opened from an unread
    // email, the sender's address is sent so the server can resolve the broker.
    EmailFrom: PendingEmail ? PendingEmail.from || "" : "",

    // Return-email handling: the original Gmail message ID (when this form was
    // opened from an unread email), the files dropped by the worker, and the
    // test checkbox that disables sending the reply.
    MessageId: PendingEmail ? PendingEmail.messageId || null : null,
    // A walk-in insurance has no broker email to reply to, so the return email
    // must never be sent for it (broker emails keep the worker's test checkbox).
    DisableReturnEmail:
      !PendingEmail ||
      (DisableReturnEmailInput && DisableReturnEmailInput.checked) ||
      false,
    Attachments: droppedFiles.map((f) => ({
      filename: f.filename,
      mimeType: f.mimeType,
      base64: f.base64,
    })),
  };

  SubmitFormButton.disabled = true;
  try {
    await api("/worker/insurances", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    toast(t("add.saved"), "success");
    setMessage(t("add.saved"), false);

    // The form is complete: mark the email handled and remove it everywhere.
    completeEmail();
    clearPendingEmail();

    clearForm();
  } catch (error) {
    console.error("Error saving insurance:", error);
    setMessage(error.message || t("serverError"), true);
  } finally {
    SubmitFormButton.disabled = false;
  }
});

async function sendReply() {
  if (!PendingEmail || !PendingEmail.messageId) {
    toast(t("emailConnUnavailable"), "error");
    return;
  }

  const text = ReplyInput ? ReplyInput.value.trim() : "";
  if (!text) {
    toast(t("add.replyEmpty"), "error");
    return;
  }

  if (!confirm(t("add.replyConfirm"))) return;

  if (ReplyButton) ReplyButton.disabled = true;
  try {
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
    console.error("Error sending reply:", error);
    toast(error.message || t("serverError"), "error");
  } finally {
    if (ReplyButton) ReplyButton.disabled = false;
  }
}

if (ReplyButton) ReplyButton.addEventListener("click", sendReply);

configureWalkInMode();
renderEmailSide();
setupEmailSocket();
