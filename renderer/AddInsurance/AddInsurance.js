"use strict";

if (!requireLogin()) {
  throw new Error("Not logged in");
}

const DurationOptions = ["1 ден", "15 дена", "3 месеца", "1 година"];
const BranchOptions = [
  "ГКПП Капитан Андреево",
  "ГКПП Лесово",
  "ГКПП Малко Търново",
];

const DurationInput = document.getElementById("DurationInput");
const BranchInput = document.getElementById("BranchInput");
const InsuranceForm = document.getElementById("InsuranceForm");
const SubmitFormButton = document.getElementById("SubmitFormButton");
const ClearButton = document.getElementById("ClearButton");
const BackButton = document.getElementById("BackButton");
const DisplayMsg = document.getElementById("DisplayMsg");
const EmailSide = document.getElementById("EmailSide");
const EmailSideTitle = document.getElementById("EmailSideTitle");
const EmailSideBody = document.getElementById("EmailSideBody");

const FormInputArray = Array.from(document.getElementsByClassName("FormInput"));
const ClearFormArray = Array.from(document.getElementsByClassName("ClearForm"));

let LM = 0;
let LN = 0;

DurationInput.addEventListener("wheel", (e) => {
  e.preventDefault();
  LM += e.deltaY > 0 ? 1 : -1;
  LM = (LM + DurationOptions.length) % DurationOptions.length;
  DurationInput.value = DurationOptions[LM];
});

BranchInput.addEventListener("wheel", (e) => {
  e.preventDefault();
  LN += e.deltaY > 0 ? 1 : -1;
  LN = (LN + BranchOptions.length) % BranchOptions.length;
  BranchInput.value = BranchOptions[LN];
});

// Seed sensible defaults.
DurationInput.value = DurationOptions[1];
BranchInput.value = BranchOptions[1];

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

function emailSubject(email) {
  return email.subject || email.from || "(no subject)";
}

function clearPendingEmail() {
  PendingEmail = null;
  localStorage.removeItem("pendingEmail");
}

function renderEmailSide() {
  if (!PendingEmail || !EmailSide || !EmailSideBody || !EmailSideTitle) {
    return;
  }

  EmailSideTitle.textContent = emailSubject(PendingEmail);
  EmailSideBody.replaceChildren();

  const meta = el("div", null, { class: "email-meta" });
  meta.appendChild(el("div", `From: ${PendingEmail.from || "?"}`));
  meta.appendChild(el("div", `Date: ${PendingEmail.date || "?"}`));
  EmailSideBody.appendChild(meta);

  const body = el("pre", PendingEmail.body || "(empty body)", {
    class: "email-body",
  });
  EmailSideBody.appendChild(body);

  const attachments = PendingEmail.attachments || [];
  if (attachments.length) {
    const heading = el("h3", "Attached pictures");
    EmailSideBody.appendChild(heading);
    const gallery = el("div", null, { class: "email-attachments" });
    for (const att of attachments) {
      const wrap = el("div", null, { class: "email-attachment" });
      if (
        att.base64 &&
        typeof att.mimeType === "string" &&
        att.mimeType.startsWith("image/")
      ) {
        const img = el("img");
        img.alt = att.filename || "attachment";
        img.src = `data:${att.mimeType};base64,${att.base64}`;
        wrap.appendChild(img);
      } else {
        wrap.appendChild(
          el("span", att.filename || "attachment", { class: "muted" })
        );
      }
      if (att.filename)
        wrap.appendChild(el("div", att.filename, { class: "muted small" }));
      gallery.appendChild(wrap);
    }
    EmailSideBody.appendChild(gallery);
  } else {
    EmailSideBody.appendChild(el("p", "No attachments.", { class: "muted" }));
  }

  EmailSide.classList.remove("hidden");
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
  BranchInput.value = BranchOptions[1];
  setMessage("", false);
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

ClearButton.addEventListener("click", clearForm);

InsuranceForm.addEventListener("submit", async function (e) {
  e.preventDefault();

  const FormObject = {};
  for (const el of FormInputArray) {
    if (!el.id) continue;
    if (el.type === "checkbox") FormObject[el.id] = el.checked;
    else FormObject[el.id] = el.value;
  }

  const payload = {
    DKN: FormObject.DKNInput,
    PolicyNumber: FormObject.PolicyNumberInput,
    BlancNumber: FormObject.BlancNumberInput,
    Duration: FormObject.DurationInput,
    BrokerCode: FormObject.BrokerCodeInput,
    Branch: FormObject.BranchInput,
    Otomobil: FormObject.AutoTypeInput,
    Price: FormObject.TotalPriceInput,
    CurrencyType: FormObject.CurrencyInput,
    ClientName: FormObject.ClientNameInput,
    ClientAdress: FormObject.ClientAdressInput,
    ChassisNumber: FormObject.ChassisNumberInput,
    VehicleBrand: FormObject.VehicleBrandInput,
    Cash: FormObject.CashInput === true,
  };

  SubmitFormButton.disabled = true;
  try {
    await api("/worker/insurances", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    toast("Insurance saved", "success");
    setMessage("Insurance saved", false);

    // The form is complete: mark the email handled and remove it everywhere.
    completeEmail();
    clearPendingEmail();

    clearForm();
  } catch (error) {
    console.error("Error saving insurance:", error);
    setMessage(error.message || "Server Error", true);
  } finally {
    SubmitFormButton.disabled = false;
  }
});

renderEmailSide();
setupEmailSocket();
