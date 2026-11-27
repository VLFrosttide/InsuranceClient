"use strict";

if (!requireLogin()) {
  throw new Error("Not logged in");
}

// This form is for admins only.
if (getRole() !== "1") {
  throw new Error("Admins only");
}

const DurationOptions = ["15 дена", "1 месец", "3 месеца"];
const KindInput = document.getElementById("KindInput");
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
const TariffPriceField = document.getElementById("TariffPriceField");
const ManualPriceInput = document.getElementById("ManualPriceInput");
const ManualPriceField = document.getElementById("ManualPriceField");
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
const NON_TURK_FEE_TRY = 200;
const CARD_FEE = 2;

let branchPricing = {}; // walk-in EUR
let tryPricing = {}; // walk-in TRY (border crossings only)
let brokerPricing = {}; // assigned broker's EUR pricing
let pricingLoading = false;
let tariffPrice = null;

// Border insurance is the one product priced from the tariff grid. Medical
// insurance and civil liability have no tariff rows: their price is typed by
// hand (ManualPriceInput) and the grid is never consulted for them. The two fee
// toggles (non-Turk tax, card fee) are border-tariff extras, so they do not
// apply to a hand-priced policy either.
const TARIFF_PRICED_KIND = "border";

function selectedKind() {
  return String(
    (KindInput && KindInput.value) || defaultInsuranceKind || TARIFF_PRICED_KIND
  ).trim();
}

function usesManualPrice() {
  return selectedKind() !== TARIFF_PRICED_KIND;
}

// Border insurance carries the border-form details: a blanc number, a car number,
// a policy number, a start date and the vehicle / duration. Medical insurance and
// civil liability are priced by hand and have none of them: every field of their
// form may be left empty, and the server makes up a reference (MED-… / CIV-…) for
// a blank number so the policy still has its key.
const POLICY_DETAIL_INPUTS = [
  "CarNumberInput",
  "PolicyNumberInput",
  "BlancNumberInput",
];

function requiresPolicyDetails() {
  return !usesManualPrice();
}

// Marks the number fields required (and the native browser check with them) only
// for the kind that carries them.
function syncPolicyDetailRequirements() {
  const required = requiresPolicyDetails();
  for (const id of POLICY_DETAIL_INPUTS) {
    const input = document.getElementById(id);
    if (input) input.required = required;
  }
  return required;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function isBrokerMode() {
  return Boolean(BrokerSelect && String(BrokerSelect.value).trim() !== "");
}

function currentFees() {
  // A hand-priced product (medical / civil) has no tariff fees.
  if (usesManualPrice()) return 0;
  if (isBrokerMode()) return 0;
  if (NonTurkInput && NonTurkInput.checked) {
    return CurrencyInput && CurrencyInput.value === "TRY"
      ? NON_TURK_FEE_TRY
      : NON_TURK_FEE;
  }
  return 0;
}

// What the policy costs before fees: the tariff row for border insurance, the
// amount typed by the admin for medical insurance / civil liability.
function currentBasePrice() {
  if (!usesManualPrice()) return tariffPrice;
  const raw = ManualPriceInput ? String(ManualPriceInput.value || "").trim() : "";
  if (!raw) return null;
  const n = Number(raw.replace(",", "."));
  return Number.isFinite(n) && n >= 0 ? round2(n) : null;
}

// Price actually saved: the base price + non-Turk fee (card fee is visual-only).
function currentTotalPrice() {
  const base = currentBasePrice();
  if (base === null) return null;
  return round2(base + currentFees());
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

// Switch the price area between the two ways of pricing a policy: the tariff
// output for border insurance, the hand-typed amount for medical / civil. The
// non-Turk and card-fee toggles belong to the border product, so they are hidden
// (and cleared) for the hand-priced kinds, which are then shown again by
// syncBrokerMode when border insurance comes back.
function syncKindPricing() {
  const manual = usesManualPrice();
  // The three numbers are required for border insurance only (see
  // requiresPolicyDetails); the browser's own required check follows along.
  syncPolicyDetailRequirements();
  if (TariffPriceField) TariffPriceField.classList.toggle("hidden", manual);
  if (ManualPriceField) ManualPriceField.classList.toggle("hidden", !manual);
  if (manual) {
    if (NonTurkInput) NonTurkInput.checked = false;
    if (CardFeeInput) CardFeeInput.checked = false;
  }
  syncBrokerMode();
  if (manual) renderTotalPrice();
  else autofillPrice();
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
// Kinds of insurance (border / medical / civil)
// ---------------------------------------------------------------------------
// The server owns the list of kinds (Requests/InsuranceKinds.js, served by
// GET /insurance-kinds) and the rules for who may create which one. This form is
// admin-only, so every kind the response marks as `allowed` is offered; a kind
// added on the server therefore appears here without a client update. The
// constants below are only the fallback used until - or if - that request cannot
// answer, so the form still works on a cold start and offline.
const DEFAULT_INSURANCE_KIND = "border";
const FALLBACK_INSURANCE_KINDS = [
  {
    value: "border",
    label: "Border insurance",
    labelBg: "Гранична застраховка",
    allowed: true,
  },
  {
    value: "medical",
    label: "Medical insurance",
    labelBg: "Медицинска застраховка",
    allowed: true,
  },
  {
    value: "civil",
    label: "Civil liability",
    labelBg: "Гражданска отговорност",
    allowed: true,
  },
];

let insuranceKinds = FALLBACK_INSURANCE_KINDS;
let defaultInsuranceKind = DEFAULT_INSURANCE_KIND;

// The label of one kind: the client's own translation when it has one
// (kind.border / kind.medical / kind.civil), otherwise whatever the server sent
// with the kind, in the language on screen.
function insuranceKindLabel(kind) {
  const value = String((kind && kind.value) || "");
  const translated = t("kind." + value, "");
  if (translated) return translated;
  if (getLang() === "bg") {
    return kind.labelBg || kind.label || value;
  }
  return kind.label || kind.labelBg || value;
}

// The kinds this user may create, in the server's order.
function allowedInsuranceKinds() {
  return insuranceKinds.filter(
    (kind) => kind && kind.value && kind.allowed !== false
  );
}

// Fill the select. `allowed: false` kinds are never offered, so a future
// admin-only-for-some-role kind cannot be picked by accident. The current
// choice survives a reload (and a language switch), and an empty or unknown
// choice falls back to the server's default kind, then to the first allowed one.
function renderInsuranceKinds() {
  if (!KindInput) return;
  const previous = String(KindInput.value || "");
  const kinds = allowedInsuranceKinds();
  KindInput.replaceChildren();
  for (const kind of kinds) {
    const option = document.createElement("option");
    option.value = String(kind.value);
    option.textContent = insuranceKindLabel(kind);
    KindInput.appendChild(option);
  }
  const values = kinds.map((kind) => String(kind.value));
  if (previous && values.includes(previous)) {
    KindInput.value = previous;
  } else if (values.includes(defaultInsuranceKind)) {
    KindInput.value = defaultInsuranceKind;
  } else if (values.length) {
    KindInput.value = values[0];
  }
}

// Ask the server which kinds exist and which this user may create. A failure is
// not fatal: the fallback list (and the server-side rule) still keep the form
// honest, so it is only logged.
async function loadInsuranceKinds() {
  try {
    const data = await api("/insurance-kinds");
    const kinds = Array.isArray(data && data.kinds) ? data.kinds : [];
    if (kinds.length) {
      insuranceKinds = kinds;
      const serverDefault = String(
        (data && data.defaultKind) || DEFAULT_INSURANCE_KIND
      );
      defaultInsuranceKind = serverDefault || DEFAULT_INSURANCE_KIND;
    }
  } catch (err) {
    console.warn("Failed to load insurance kinds:", err);
  }
  renderInsuranceKinds();
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
  // The non-Turk tax and the card fee are border-tariff extras: a hand-priced
  // policy (medical / civil) never shows them.
  const hideFees = broker || usesManualPrice();
  if (CashField) CashField.classList.toggle("hidden", broker);
  for (const f of [NonTurkField, CardFeeField]) {
    if (f) f.classList.toggle("hidden", hideFees);
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
  if (KindInput) KindInput.value = defaultInsuranceKind;
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
  // Picks the right price area for the (default) kind again and refreshes the
  // broker / currency / card-fee state with it.
  syncKindPricing();
}

InsuranceForm.addEventListener("submit", async function (e) {
  e.preventDefault();

  const FormObject = {};
  for (const el of FormInputArray) {
    if (!el.id || !el.isConnected) continue;
    if (el.type === "checkbox") FormObject[el.id] = el.checked;
    else FormObject[el.id] = el.value;
  }

  // Border insurance is written on a blanc for a vehicle, so its three numbers
  // are required and the policy / blanc numbers have a fixed length. A medical or
  // civil liability policy is priced by hand and carries none of that: whatever
  // is typed travels as-is (a blank number gets a reference made up by the
  // server), so nothing is demanded there.
  const needsPolicyDetails = requiresPolicyDetails();
  const requiredNumbers = [
    ["CarNumberInput", "add.carNumberRequired"],
    ["PolicyNumberInput", "add.policyNumberRequired"],
    ["BlancNumberInput", "add.blancNumberRequired"],
  ];
  const trimmed = {};
  for (const [id, messageKey] of requiredNumbers) {
    trimmed[id] = FormObject[id] ? String(FormObject[id]).trim() : "";
    if (needsPolicyDetails && !trimmed[id]) {
      setMessage(t(messageKey), true);
      const inputEl = document.getElementById(id);
      if (inputEl) inputEl.focus();
      return;
    }
  }
  const carNumber = trimmed.CarNumberInput;
  const policyNumber = trimmed.PolicyNumberInput;
  const blancNumber = trimmed.BlancNumberInput;

  if (needsPolicyDetails) {
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
  }

  const startDate = FormObject.StartDateInput
    ? String(FormObject.StartDateInput).trim()
    : "";
  if (needsPolicyDetails && !startDate) {
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
    const manual = usesManualPrice();
    setMessage(
      manual
        ? t("add.manualPriceRequired")
        : pricingLoading
        ? t("add.priceLoading")
        : t("add.priceUnavailable"),
      true
    );
    if (manual && ManualPriceInput) ManualPriceInput.focus();
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
    // Which product the policy is (border / medical / civil). The dropdown is
    // built from GET /insurance-kinds; an empty select falls back to the default
    // kind so a policy can never be saved without one.
    Kind: String(
      FormObject.KindInput || defaultInsuranceKind || DEFAULT_INSURANCE_KIND
    ).trim(),
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

  // A broker-linked insurance whose blanc number is outside the broker's blanc
  // batches is rejected once; the admin is asked whether to create it anyway.
  let forceOutsideBlancBatch = false;
  while (true) {
    const outbound = forceOutsideBlancBatch
      ? { ...payload, ForceOutsideBlancBatch: true }
      : payload;

    SubmitFormButton.disabled = true;
    try {
      await api("/admin/insurances", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(outbound),
      });
      const flash = { text: t("add.saved"), type: "success" };
      try {
        localStorage.setItem("flashToast", JSON.stringify(flash));
      } catch (err) {
        console.error("Failed to store flash toast:", err);
      }
      goBack();
      return;
    } catch (err) {
      const message =
        translateError(err && err.message ? err.message : "") ||
        t("serverError");

      if (
        !forceOutsideBlancBatch &&
        err &&
        err.code === BLANC_OUTSIDE_BROKER_BATCHES_CODE
      ) {
        setMessage(message, true);
        toast(message, "error");
        const confirmed = await appConfirm(t("add.blancOutsideBatchesConfirm"));
        if (!confirmed) {
          return;
        }
        forceOutsideBlancBatch = true;
        continue;
      }

      setMessage(message, true);
      toast(message, "error");
      return;
    } finally {
      SubmitFormButton.disabled = false;
    }
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
    // The kind labels are built here, not marked with data-i18n, so they have to
    // be rebuilt in the new language.
    renderInsuranceKinds();
    syncBrokerMode();
  });
}
if (BackButton) BackButton.addEventListener("click", goBack);
if (ClearButton) {
  ClearButton.addEventListener("click", async () => {
    const confirmed = await appConfirm(t("add.clearConfirm"), {
      danger: true,
      confirmLabel: t("clear"),
    });
    if (!confirmed) return;
    clearForm();
  });
}

if (DurationInput) DurationInput.addEventListener("change", autofillPrice);
// A different kind switches the price area (tariff output vs hand-typed input).
if (KindInput) KindInput.addEventListener("change", syncKindPricing);
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
  // Paint the (fallback) kinds at once so the select is never empty, then
  // replace them with the server's list when it answers.
  renderInsuranceKinds();
  syncKindPricing();
  loadBrokers();
  loadPricing();
  // The server's list may name another default kind; make the price area follow
  // whatever the select ends up on.
  loadInsuranceKinds().then(syncKindPricing);
}

init();



