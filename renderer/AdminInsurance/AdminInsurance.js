"use strict";

if (!requireLogin()) {
  throw new Error("Not logged in");
}

// This form is for admins only.
if (getRole() !== "1") {
  throw new Error("Admins only");
}

const DurationOptions = ["15 дена", "1 месец", "3 месеца"];
const DurationInput = document.getElementById("DurationInput");
const AutoTypeInput = document.getElementById("AutoTypeInput");
const StartDateInput = document.getElementById("StartDateInput");
const CreationDateInput = document.getElementById("CreationDateInput");
const CurrencyInput = document.getElementById("CurrencyInput");
const BrokerSelect = document.getElementById("BrokerSelect");
const BrokerNote = document.getElementById("BrokerNote");
const CashInput = document.getElementById("CashInput");
const NonTurkInput = document.getElementById("NonTurkInput");
const CardFeeInput = document.getElementById("CardFeeInput");
const CashField = document.getElementById("CashField");
const NonTurkField = document.getElementById("NonTurkField");
const CardFeeField = document.getElementById("CardFeeField");
const TotalPriceDisplay = document.getElementById("TotalPriceDisplay");
const InsuranceForm = document.getElementById("InsuranceForm");
const SubmitFormButton = document.getElementById("SubmitFormButton");
const ClearButton = document.getElementById("ClearButton");
const BackButton = document.getElementById("BackButton");
const LangButton = document.getElementById("LangButton");
const DisplayMsg = document.getElementById("DisplayMsg");

const FormInputArray = Array.from(document.getElementsByClassName("FormInput"));
const ClearFormArray = Array.from(document.getElementsByClassName("ClearForm"));

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------
function pad(n) {
  return String(n).padStart(2, "0");
}

function todayLocalDate() {
  const now = new Date();
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function localDateTimeNow() {
  const now = new Date();
  return (
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` +
    `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
  );
}

// Default value for an <input type="datetime-local">.
function datetimeLocalNow() {
  const now = new Date();
  return (
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
    `T${pad(now.getHours())}:${pad(now.getMinutes())}`
  );
}

// Convert the datetime-local value to the MySQL DATETIME the server expects.
function creationDatePayload() {
  const v = CreationDateInput ? String(CreationDateInput.value || "").trim() : "";
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(v);
  if (m) return `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:00`;
  return localDateTimeNow();
}

// Strip whitespace from pasted numbers, same as the walk-in form.
function trimOnPaste(input) {
  if (!input) return;
  input.addEventListener("paste", () => {
    setTimeout(() => {
      input.value = input.value.replace(/\s+/g, "");
    }, 0);
  });
}

trimOnPaste(document.getElementById("CarNumberInput"));
trimOnPaste(document.getElementById("PolicyNumberInput"));
trimOnPaste(document.getElementById("BlancNumberInput"));

// ---------------------------------------------------------------------------
// Pricing (broker vs walk-in)
// ---------------------------------------------------------------------------
const NON_TURK_FEE = 5;
const CARD_FEE = 2;

let branchPricing = {}; // walk-in EUR
let tryPricing = {}; // walk-in TRY (border crossings only)
let brokerPricing = {}; // assigned broker's EUR pricing
let pricingLoading = false;
let tariffPrice = null;

function round2(n) {
  return Math.round(n * 100) / 100;
}

function isBrokerMode() {
  return Boolean(BrokerSelect && String(BrokerSelect.value).trim() !== "");
}

function currentFees() {
  if (isBrokerMode()) return 0;
  if (NonTurkInput && NonTurkInput.checked) return NON_TURK_FEE;
  return 0;
}

// Price actually saved: tariff + non-Turk fee (card fee is visual-only).
function currentTotalPrice() {
  if (tariffPrice === null) return null;
  return round2(tariffPrice + currentFees());
}

// Price shown on the form (adds the visual-only card fee).
function currentDisplayPrice() {
  const total = currentTotalPrice();
  if (total === null) return null;
  const cardFee =
    !isBrokerMode() && CardFeeInput && CardFeeInput.checked ? CARD_FEE : 0;
  return round2(total + cardFee);
}

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

function mapVehicle(value) {
  const v = String(value || "").trim();
  if (v === "Automobile" || v === "Otomobil") return "Auto";
  if (v === "Motor") return "Motor";
  if (v === "Bus") return "Bus";
  if (v === "Trailer") return "Trailer";
  return null;
}

function mapDuration(value) {
  const s = String(value || "").trim().toLowerCase();
  if (s.includes("15")) return 15;
  if (s.includes("месеца") || s.includes("months")) return 90;
  if (s.includes("месец") || s.includes("month")) return 30;
  const n = parseInt(s.replace(/[^0-9]/g, ""), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function lookupPrice(type, duration, currency) {
  const source = isBrokerMode()
    ? brokerPricing
    : currency === "TRY"
    ? tryPricing
    : branchPricing;
  if (source && source[type] && source[type][duration] !== undefined) {
    return source[type][duration];
  }
  return null;
}

function autofillPrice() {
  const type = mapVehicle(AutoTypeInput ? AutoTypeInput.value : "");
  const duration = mapDuration(DurationInput ? DurationInput.value : "");
  const currency = CurrencyInput ? CurrencyInput.value : "EUR";
  const raw = type && duration ? lookupPrice(type, duration, currency) : null;
  const n = raw === null || raw === "" ? NaN : Number(raw);
  tariffPrice = Number.isFinite(n) ? n : null;
  renderTotalPrice();
}

async function loadPricing() {
  pricingLoading = true;
  renderTotalPrice();
  const brokerId = isBrokerMode() ? String(BrokerSelect.value).trim() : "";
  if (brokerId) {
    try {
      const data = await api(`/tariffs/broker/${encodeURIComponent(brokerId)}`);
      brokerPricing = (data && data.pricing) || {};
    } catch (err) {
      console.warn("Failed to load broker pricing:", err);
      brokerPricing = {};
    }
    branchPricing = {};
    tryPricing = {};
  } else {
    const branch = localStorage.getItem("branch") || "";
    const params = new URLSearchParams();
    if (branch) params.set("branch", branch);
    try {
      const data = await api(`/tariffs/policy-pricing?${params.toString()}`);
      branchPricing = (data && data.pricing) || {};
      tryPricing = (data && data.tryPricing) || {};
    } catch (err) {
      console.warn("Failed to load branch pricing:", err);
      branchPricing = getPricingCache() || {};
      tryPricing = {};
    }
    brokerPricing = {};
  }
  pricingLoading = false;
  autofillPrice();
}

// ---------------------------------------------------------------------------
// Payment options / currency / broker-mode visibility
// ---------------------------------------------------------------------------
function syncCardFeeState() {
  if (!CardFeeInput || !CashInput) return;
  if (isBrokerMode() || CashInput.checked) {
    CardFeeInput.checked = false;
    CardFeeInput.disabled = true;
  } else {
    if (CardFeeInput.disabled) CardFeeInput.checked = true;
    CardFeeInput.disabled = false;
  }
}

function tryCurrencyAllowed() {
  const branch = localStorage.getItem("branch") || "";
  const vehicle = AutoTypeInput ? AutoTypeInput.value : "";
  const isBorder =
    branch.includes("Лесово") ||
    branch.includes("Андреево") ||
    branch.includes("Lesovo") ||
    branch.includes("Andreevo");
  const isAuto = vehicle === "Automobile" || vehicle === "Otomobil";
  return isBorder && isAuto;
}

function syncCurrencyOptions() {
  if (!CurrencyInput) return;
  const tryOption = Array.from(CurrencyInput.options).find(
    (o) => o.value === "TRY"
  );
  const allowed = !isBrokerMode() && tryCurrencyAllowed();
  if (tryOption) tryOption.disabled = !allowed;
  if (!allowed && CurrencyInput.value === "TRY") CurrencyInput.value = "EUR";
}

function syncBrokerMode() {
  const broker = isBrokerMode();
  for (const f of [CashField, NonTurkField, CardFeeField]) {
    if (f) f.classList.toggle("hidden", broker);
  }
  if (BrokerNote) {
    BrokerNote.textContent = broker ? t("addAdmin.brokerNote") : "";
    BrokerNote.classList.toggle("hidden", !broker);
  }
  syncCurrencyOptions();
  syncCardFeeState();
  renderTotalPrice();
}

// ---------------------------------------------------------------------------
// Form helpers
// ---------------------------------------------------------------------------
function setMessage(text, isError) {
  if (!DisplayMsg) return;
  DisplayMsg.textContent = text || "";
  DisplayMsg.classList.toggle("error", Boolean(isError));
  DisplayMsg.classList.toggle("success", !isError && Boolean(text));
}

async function loadBrokers() {
  if (!BrokerSelect) return;
  try {
    const data = await api("/brokers");
    const brokers = (data && data.brokers) || [];
    const selected = BrokerSelect.value;
    BrokerSelect.replaceChildren();
    const none = document.createElement("option");
    none.value = "";
    none.setAttribute("data-i18n", "addAdmin.brokerNone");
    none.textContent = t("addAdmin.brokerNone");
    BrokerSelect.appendChild(none);
    for (const br of brokers) {
      const opt = document.createElement("option");
      opt.value = String(br.id);
      opt.textContent = br.Name || String(br.id);
      BrokerSelect.appendChild(opt);
    }
    if (selected) BrokerSelect.value = selected;
  } catch (err) {
    console.error("Failed to load brokers:", err);
    toast(t("addAdmin.brokersLoadFailed"), "error");
  }
}

function goBack() {
  window.bridge.LoadNewPage("renderer/WorkPage/WorkPage.html");
}

function clearForm() {
  for (const el of ClearFormArray) {
    if (!el.isConnected) continue;
    if (el.type === "checkbox") el.checked = false;
    else el.value = "";
  }
  if (DurationInput) DurationInput.value = DurationOptions[1];
  if (AutoTypeInput) AutoTypeInput.value = "Automobile";
  if (CurrencyInput) CurrencyInput.value = "EUR";
  if (CashInput) CashInput.checked = true;
  if (NonTurkInput) NonTurkInput.checked = false;
  if (CardFeeInput) CardFeeInput.checked = false;
  if (StartDateInput) StartDateInput.value = todayLocalDate();
  if (CreationDateInput) CreationDateInput.value = datetimeLocalNow();
  if (BrokerSelect) BrokerSelect.value = "";
  setMessage("", false);
  syncBrokerMode();
  syncCurrencyOptions();
  syncCardFeeState();
  autofillPrice();
}

InsuranceForm.addEventListener("submit", async function (e) {
  e.preventDefault();

  const FormObject = {};
  for (const el of FormInputArray) {
    if (!el.id || !el.isConnected) continue;
    if (el.type === "checkbox") FormObject[el.id] = el.checked;
    else FormObject[el.id] = el.value;
  }

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

  const startDate = FormObject.StartDateInput
    ? String(FormObject.StartDateInput).trim()
    : "";
  if (!startDate) {
    setMessage(t("add.startDateRequired"), true);
    if (StartDateInput) StartDateInput.focus();
    return;
  }

  const creationValue = CreationDateInput
    ? String(CreationDateInput.value || "").trim()
    : "";
  if (!creationValue) {
    setMessage(t("addAdmin.creationDateRequired"), true);
    if (CreationDateInput) CreationDateInput.focus();
    return;
  }

  const totalPrice = currentTotalPrice();
  if (totalPrice === null) {
    setMessage(
      pricingLoading ? t("add.priceLoading") : t("add.priceUnavailable"),
      true
    );
    return;
  }

  const brokerId = isBrokerMode() ? String(BrokerSelect.value).trim() : "";

  const payload = {
    PolicyNumber: policyNumber,
    BlancNumber: blancNumber,
    CarNumber: carNumber,
    Duration: FormObject.DurationInput,
    Branch: localStorage.getItem("branch") || "",
    Otomobil: FormObject.AutoTypeInput,
    StartDate: startDate,
    Price: totalPrice.toFixed(2),
    CurrencyType: FormObject.CurrencyInput,
    PaymentType: brokerId
      ? "Broker"
      : FormObject.CashInput === true
      ? "Cash"
      : "Card",
    NonTurk: !brokerId && FormObject.NonTurkInput === true,
    CardFee: false,
    BrokerId: brokerId || null,
    CreationDate: creationDatePayload(),
    TzOffset: -new Date().getTimezoneOffset(),
  };

  SubmitFormButton.disabled = true;
  try {
    await api("/admin/insurances", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const flash = { text: t("add.saved"), type: "success" };
    try {
      localStorage.setItem("flashToast", JSON.stringify(flash));
    } catch (err) {
      console.error("Failed to store flash toast:", err);
    }
    goBack();
  } catch (err) {
    const message = err && err.message ? err.message : t("serverError");
    setMessage(message, true);
    toast(message, "error");
  } finally {
    SubmitFormButton.disabled = false;
  }
});

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------
function syncLangButton() {
  if (!LangButton) return;
  LangButton.textContent = getLang() === "bg" ? "EN" : "BG";
}

if (LangButton) {
  LangButton.addEventListener("click", () => {
    toggleLang();
    syncLangButton();
    syncBrokerMode();
  });
}
if (BackButton) BackButton.addEventListener("click", goBack);
if (ClearButton) {
  ClearButton.addEventListener("click", () => {
    if (!confirm(t("add.clearConfirm"))) return;
    clearForm();
  });
}

if (DurationInput) DurationInput.addEventListener("change", autofillPrice);
if (AutoTypeInput) {
  AutoTypeInput.addEventListener("change", () => {
    autofillPrice();
    syncCurrencyOptions();
  });
}
if (CurrencyInput) {
  CurrencyInput.addEventListener("change", () => {
    syncCurrencyOptions();
    autofillPrice();
  });
}
if (CashInput) {
  CashInput.addEventListener("change", () => {
    syncCardFeeState();
    renderTotalPrice();
  });
}
if (NonTurkInput) NonTurkInput.addEventListener("change", renderTotalPrice);
if (CardFeeInput) CardFeeInput.addEventListener("change", renderTotalPrice);
if (BrokerSelect) {
  BrokerSelect.addEventListener("change", () => {
    syncBrokerMode();
    loadPricing();
  });
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
function init() {
  if (StartDateInput) StartDateInput.value = todayLocalDate();
  if (CreationDateInput) CreationDateInput.value = datetimeLocalNow();
  if (DurationInput) DurationInput.value = DurationOptions[1];
  syncLangButton();
  syncBrokerMode();
  loadBrokers();
  loadPricing();
}

init();



