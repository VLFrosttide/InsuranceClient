"use strict";

const Content = document.getElementById("Content");
const Nav = document.getElementById("Nav");
const HeaderTitle = document.getElementById("HeaderTitle");
const HeaderSub = document.getElementById("HeaderSub");
const LogoutButton = document.getElementById("LogoutButton");
const LangButton = document.getElementById("LangButton");
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
  for (const [, entry] of emailCards) container.appendChild(entry.node);
  return container;
}

function addEmailCard(email) {
  if (!email || !email.messageId || emailCards.has(email.messageId)) return;

  const card = el("div", null, { class: "email-card" });

  const openBtn = el("button", emailTitle(email), {
    class: "email-card-open",
    type: "button",
  });
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

  emailCards.set(email.messageId, { email, node: card });

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
    emailSocket.send({ type: "mark_irrelevant", messageId: email.messageId });
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
const CLAIM_TIMEOUT_MS = 3500;
let claimTimer = null;
// performance.now() timestamp of when the pending claim was sent.
let claimSentAt = 0;

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
  if (entry) entry.node.classList.toggle("email-card-busy", busy);
  document.body.classList.toggle("email-claim-pending", busy);
}

function clearPendingClaim() {
  clearTimeout(claimTimer);
  claimTimer = null;
  if (pendingClaimEmail) setCardBusy(pendingClaimEmail.messageId, false);
  pendingClaimEmail = null;
}

function openEmailInNewForm(email) {
  if (!emailSocket) {
    console.error("Cannot open email: email WebSocket is not available");
    toast(t("emailConnUnavailable"), "error");
    return;
  }
  // A claim is already in flight; ignore repeated clicks until it resolves.
  if (pendingClaimEmail) return;

  // The socket is down or still authenticating. Sending now would only queue
  // the claim and the click would look dead, so tell the worker and kick off
  // an immediate reconnect instead of waiting out the backoff delay.
  if (!emailSocket.isReady()) {
    console.warn(
      `Cannot claim email "${email.messageId}": email WebSocket is not connected`
    );
    toast(t("emailConnUnavailable"), "error");
    emailSocket.ensureConnected();
    return;
  }

  // Only navigate once the server confirms this client won the claim. If
  // another worker clicked the same card first, we show an error instead.
  pendingClaimEmail = email;
  setCardBusy(email.messageId, true);
  claimSentAt = performance.now();
  try {
    emailSocket.send({ type: "claim_email", messageId: email.messageId });
  } catch (err) {
    clearPendingClaim();
    reportError("Failed to claim email", err, "emailSendFailed");
    return;
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
    },
    // The connection dropped: the server never answers a claim sent on it, so
    // fail it now instead of leaving the card stuck in its busy state.
    close: () => {
      if (!pendingClaimEmail) return;
      console.error(
        `Email WebSocket closed before claim_email "${pendingClaimEmail.messageId}" was answered`
      );
      clearPendingClaim();
      toast(t("emailConnUnavailable"), "error");
    },
    list_emails: (msg) => reconcileEmailCards(msg.data),
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
}

function fetchUnreadEmails() {
  if (userRole !== "2" || !emailSocket) return;
  try {
    emailSocket.send({ type: "list_emails" });
  } catch (err) {
    reportError("Failed to request unread emails", err, "emailSendFailed");
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

function buildForm(spec, onSubmit, submitLabel) {
  const form = el("form");
  const values = {};
  for (const s of spec) {
    let control;
    if (s.type === "emails") control = emailListEditor(s.value);
    else if (s.type === "select") control = select(s.options, s.value);
    else if (s.type === "textarea") control = textarea(s.value, s.placeholder);
    else if (s.type === "checkbox") {
      control = input("checkbox");
      control.checked = !!s.value;
    } else control = input(s.type, s.value, s.placeholder);
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
      if (s.type === "emails") payload[s.key] = c.getValues();
      else if (c.type === "checkbox") payload[s.key] = c.checked;
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
function renderTable(items, columns, actions, rowClass) {
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
    const row = el("tr", null, extraClass ? { class: extraClass } : null);
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
// does - and the branch walk-in tariffs for walk-ins. The fees stored with the
// policy are added on top, exactly like the add form: +5 for a non-Turk
// client and +2 for the card fee (only while the payment is by card).
const EDIT_DURATION_OPTIONS = [15, 30, 90];
const EDIT_VEHICLE_TYPES = ["Automobile", "Motor", "Bus", "Trailer"];
const EDIT_NON_TURK_FEE = 5;
const EDIT_CARD_FEE = 2;

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
  if (fees && fees.cardFee) total += EDIT_CARD_FEE;
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
  const paymentInput = control("PaymentType");

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

    const price = editedPolicyPrice(
      pricing,
      vehicleInput.value,
      durationInput.value,
      {
        nonTurk: editFlag(insurance.NonTurk),
        // Email policies have no payment field: they are broker-paid and the
        // server clears their card fee.
        cardFee:
          editFlag(insurance.CardFee) &&
          !!paymentInput &&
          paymentInput.value === "Card",
      }
    );
    if (price === null) {
      // Keep the current price; the worker can still correct it by hand.
      toast(t("edit.priceUnavailable"), "error");
      return;
    }
    priceInput.value = price.toFixed(2);
  }

  durationInput.addEventListener("change", recalc);
  vehicleInput.addEventListener("change", recalc);
}

// ---------------------------------------------------------------------------
// Modal form for editing an insurance (admins + workers)
// ---------------------------------------------------------------------------
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
    { key: "Price", label: t("price"), type: "number", value: insurance.Price },
    {
      key: "CurrencyType",
      label: t("currency"),
      type: "select",
      options: [
        { label: "EUR", value: "EUR" },
        { label: "USD", value: "USD" },
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
    { key: "Branch", label: t("add.branch"), value: insurance.Branch },
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
      value: insurance.StartDate,
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

  const form = buildForm(
    spec,
    async (payload) => {
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
// fault" charges no fee at all. The
// server computes the same fee on its own; this is only the preview.
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

  const payerSelect = select(
    [
      { label: t("annul.payer.broker"), value: "broker" },
      { label: t("annul.payer.worker"), value: "worker" },
      { label: t("annul.payer.none"), value: "none" },
    ],
    "broker"
  );

  const statusLine = el("p", "", { class: "muted" });
  const feeLine = el("p", "", { class: "muted" });
  const refundLine = el("p", "", { class: "big" });

  function updatePreview() {
    const inEffect = isPolicyInEffect(insurance);
    // No fault is always free; otherwise the start date decides.
    const noFault = payerSelect.value === "none";
    const fee = noFault
      ? 0
      : inEffect
      ? ANNUL_FEE_IN_EFFECT
      : ANNUL_FEE_NOT_IN_EFFECT;
    const refund = Math.max(0, Math.round((price - fee) * 100) / 100);
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
  payerSelect.addEventListener("change", updatePreview);
  updatePreview();

  const form = el("form");
  form.appendChild(field(t("annulPayer"), payerSelect));
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
      const data = await api(`/insurances/${insurance.BlancNumber}/annul`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ payer: payerSelect.value }),
      });
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
  const data = await api("/admin/users");
  const roleOptions = [
    { label: t("role.1"), value: 1 },
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
      { key: "Status", label: t("status") },
    ],
    [
      {
        label: t("edit"),
        class: "",
        onClick: (u) => {
          const form = buildForm(
            [
              {
                key: "role",
                label: t("role"),
                type: "select",
                options: roleOptions,
                value: u.Role,
              },
              {
                key: "balance",
                label: t("balance"),
                type: "number",
                value: u.Balance,
              },
            ],
            async (payload) => {
              await api(`/admin/users/${u.Username}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload),
              });
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
        label: t("promote"),
        class: "secondary",
        onClick: (u) => {
          const form = buildForm(
            [
              {
                key: "role",
                label: t("newRole"),
                type: "select",
                options: [
                  { label: t("role.2"), value: 2 },
                  { label: t("role.3"), value: 3 },
                ],
                value: 2,
              },
            ],
            async (payload) => {
              await api(`/admin/users/${u.Username}/promote`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload),
              });
              toast(t("userRoleUpdated"), "success");
              closeModal();
              adminUsers();
            },
            t("promote")
          );
          openModal(`${t("promote")} ${u.Username}`, form);
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

async function adminInsurances() {
  const data = await api("/admin/insurances");

  function render() {
    const table = renderTable(
      data.insurances,
      [
        { key: "BlancNumber", label: t("blankNo") },
        { key: "Author", label: t("author") },
        { key: "PolicyNumber", label: t("policyNumber") },
        { key: "Price", label: t("price"), format: (v) => money(v) },
        { key: "CurrencyType", label: t("currency") },
        { key: "PaymentType", label: t("payment"), format: paymentLabel },
        { key: "Broker", label: t("broker") },
        {
          key: "Annulled",
          label: t("status"),
          format: (v) => (v ? t("annulled") : ""),
        },
      ],
      (i) => [
        {
          label: t("edit"),
          class: "",
          // Re-render from the row the editor just refreshed with the server's
          // stored values, so a corrected price/payment type shows up straight
          // away.
          onClick: () => openInsuranceEditor(i, () => render()),
        },
        ...(!i.Annulled
          ? [
              {
                label: t("annul"),
                class: "danger",
                onClick: () =>
                  openAnnulForm(i, () => {
                    i.Annulled = 1;
                    render();
                  }),
              },
            ]
          : []),
        {
          label: t("delete"),
          class: "danger",
          onClick: () =>
            deleteInsurance(i, () => {
              data.insurances = data.insurances.filter(
                (x) => x.BlancNumber !== i.BlancNumber
              );
              render();
            }),
        },
      ],
      (i) => (i.Annulled ? "row-annulled" : "")
    );
    Content.replaceChildren(el("h2", t("allInsurances")), table);
  }

  render();
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
    await api(`/insurances/${insurance.BlancNumber}`, { method: "DELETE" });
    toast(t("insuranceDeleted"), "success");
    if (onDone) onDone();
  } catch (err) {
    toast(err.message, "error");
  }
}

async function currentCashView(overrideBranch) {
  // Admins can inspect/manage any branch's cash (not just the branch they
  // logged in with); workers are always scoped to their own login branch.
  const isAdmin = userRole === "1";
  let branch = overrideBranch || getBranch();

  let allBranchNames = [];
  if (isAdmin) {
    const branchesData = await api("/currentcash/branches");
    allBranchNames = Object.keys(branchesData.branches || {}).sort();
    // If the admin's own login branch has no record yet, default to the
    // first known branch so the view is never blank.
    if (!branch && allBranchNames.length) branch = allBranchNames[0];
  }

  const data = await api(`/currentcash?branch=${encodeURIComponent(branch)}`);
  const heading = el("h2", t("currentCash"));

  // Always show which branch the cash balance belongs to — never display a
  // balance without saying which branch holds it.
  heading.appendChild(
    el("span", ` — ${t("branch")}: ${branch || t("unknownBranch")}`, {
      class: "muted",
    })
  );

  // Admins get a dropdown to switch between branches without needing to log
  // out/in with a different branch selected.
  if (isAdmin && allBranchNames.length > 1) {
    const branchSelect = select(
      allBranchNames.map((b) => ({ label: b, value: b })),
      branch
    );
    branchSelect.addEventListener("change", () => {
      currentCashView(branchSelect.value);
    });
    heading.appendChild(branchSelect);
  }

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
            { label: "USD", value: "USD" },
            { label: "TRY", value: "TRY" },
          ],
          value: "EUR",
        },
        { key: "reason", label: t("reason"), value: "" },
      ],
      async (payload) => {
        // Attach the branch to the payload before sending.
        payload.branch = branch;
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
        currentCashView(branch);
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
        body: JSON.stringify({ branch }),
      });
      toast(t("currentCashReset"), "success");
      currentCashView(branch);
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
            { label: "USD", value: "USD" },
            { label: "TRY", value: "TRY" },
          ],
          value: tx.Currency || "EUR",
        },
        { key: "reason", label: t("reason"), value: tx.Reason },
      ],
      async (payload) => {
        await api(`/currentcash/transactions/${tx.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        toast(t("transactionUpdated"), "success");
        closeModal();
        currentCashView(branch);
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
  const resetTable = renderTable(data.resets, [
    { key: "Username", label: t("user") },
    { key: "Currency", label: t("currency") },
    { key: "KeptAmount", label: t("kept"), format: (v) => money(v) },
    { key: "CreatedAt", label: t("created"), format: (v) => formatDateTime(v) },
  ]);

  Content.replaceChildren(
    heading,
    balance,
    el("p", t("currentCashHint"), { class: "muted" }),
    actions,
    el("h3", t("transactions")),
    txTable,
    el("h3", t("resets")),
    resetTable
  );
}

// Total cash - the second record of cash flow.
//
// Total cash is a strict superset of current cash: every type of payment (cash
// money, card payments and payments funded from a broker's balance) is counted
// in it, while current cash holds only the cash balance. It is read-only here -
// the money moves through the same increase/reduce/reset actions as before, and
// Total cash follows them by construction.
async function totalCashView(overrideBranch) {
  // Admins can inspect any branch's total; workers are scoped to their own
  // login branch, exactly like the current cash view.
  const isAdmin = userRole === "1";
  let branch = overrideBranch || getBranch();

  let allBranchNames = [];
  if (isAdmin) {
    const branchesData = await api("/totalcash/branches");
    allBranchNames = Object.keys(branchesData.branches || {}).sort();
    if (!branch && allBranchNames.length) branch = allBranchNames[0];
  }

  const data = await api(`/totalcash?branch=${encodeURIComponent(branch)}`);
  const heading = el("h2", t("totalCash"));

  heading.appendChild(
    el("span", ` — ${t("branch")}: ${branch || t("unknownBranch")}`, {
      class: "muted",
    })
  );

  if (isAdmin && allBranchNames.length > 1) {
    const branchSelect = select(
      allBranchNames.map((b) => ({ label: b, value: b })),
      branch
    );
    branchSelect.addEventListener("change", () => {
      totalCashView(branchSelect.value);
    });
    heading.appendChild(branchSelect);
  }

  const balances = data.balances || {};
  const parts = data.parts || {};

  const balance = el("div", null, { class: "balance-card" });
  balance.appendChild(el("h3", t("totalCash")));

  const nonZero = Object.entries(balances).filter(
    ([, value]) => Number(value) !== 0
  );
  if (nonZero.length === 0) {
    balance.appendChild(el("p", money(0), { class: "big" }));
  } else {
    const list = el("div");
    for (const [currency, value] of nonZero) {
      list.appendChild(el("p", `${money(value)} ${currency}`, { class: "big" }));
    }
    balance.appendChild(list);
  }
  balance.appendChild(el("p", t("totalCashHint"), { class: "muted" }));

  // Break the total down into the three payment types it is built from. The
  // cash part is what current cash already carries, so it is derived rather
  // than sent by the server.
  const partsRows = Object.keys(balances).map((currency) => {
    const p = parts[currency] || {};
    const card = Number(p.CardPart) || 0;
    const broker = Number(p.BrokerPart) || 0;
    const total = Number(balances[currency]) || 0;
    return {
      Currency: currency,
      CashPart: Math.round((total - card - broker) * 100) / 100,
      CardPart: card,
      BrokerPart: broker,
      Total: total,
    };
  });

  const partsTable = renderTable(partsRows, [
    { key: "Currency", label: t("currency") },
    { key: "CashPart", label: t("cashPart"), format: (v) => money(v) },
    { key: "CardPart", label: t("cardPart"), format: (v) => money(v) },
    { key: "BrokerPart", label: t("brokerPart"), format: (v) => money(v) },
    { key: "Total", label: t("totalCash"), format: (v) => money(v) },
  ]);

  // One row per movement, tagged with the channel it came through, so this
  // ledger can be compared entry by entry with the current cash one.
  const txTable = renderTable(data.transactions, [
    { key: "Source", label: t("source"), format: (v) => t(`source.${v}`, v) },
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
  ]);

  Content.replaceChildren(
    heading,
    balance,
    el("h3", t("overview")),
    partsTable,
    el("h3", t("transactions")),
    txTable
  );
}

async function cardView() {
  const data = await api("/cardpayments");
  const card = el("div", null, { class: "balance-card" });
  card.appendChild(el("h3", t("cardBalance")));
  card.appendChild(el("p", money(data.cardBalance), { class: "big" }));

  const children = [el("h2", t("cardPayments")), card];

  // Clearing the card balance is a destructive, admin-only action.
  if (userRole === "1") {
    const actions = el("div", null, { class: "row" });
    const clearBtn = el("button", t("clearBalance"), { class: "danger" });
    clearBtn.addEventListener("click", async () => {
      if (!confirm(t("clearCardBalanceConfirm"))) return;
      try {
        await api("/cardpayments/reset", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
        });
        toast(t("cardBalanceCleared"), "success");
        cardView();
      } catch (err) {
        toast(err.message, "error");
      }
    });
    actions.appendChild(clearBtn);
    children.push(actions);
  }

  const resetTable = renderTable(data.resets, [
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
          key: "Name",
          label: t("name"),
          onClick: (b) => brokerPricingEditor(b),
        },
        {
          key: "CashBalance",
          label: t("balance"),
          format: (v) => money(v),
          ...sortHeader("CashBalance"),
        },
        {
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
      (b) => (brokerHasNoEmail(b) ? "row-broker-alert" : "")
    );
  };
  tableHolder.appendChild(buildTable());

  Content.replaceChildren(el("h2", t("brokers")), toolbar, tableHolder);
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
          { label: "USD", value: "USD" },
          { label: "TRY", value: "TRY" },
        ],
        value: "EUR",
      },
      { key: "reason", label: t("reason"), value: "" },
    ],
    async (payload) => {
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
      {
        key: "PolicyRangeStart",
        label: t("rangeStart"),
        type: "number",
        value: "",
      },
      {
        key: "PolicyRangeEnd",
        label: t("rangeEnd"),
        type: "number",
        value: "",
      },
      {
        key: "InactivePolicies",
        label: t("inactive"),
        type: "number",
        value: 0,
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
      {
        key: "PolicyRangeStart",
        label: t("rangeStart"),
        type: "number",
        value: broker.PolicyRangeStart,
      },
      {
        key: "PolicyRangeEnd",
        label: t("rangeEnd"),
        type: "number",
        value: broker.PolicyRangeEnd,
      },
      {
        key: "InactivePolicies",
        label: t("inactive"),
        type: "number",
        value: broker.InactivePolicies,
      },
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

async function brokerPricingEditor(broker) {
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

async function adminInsurancesByDate(defaultAuthor = "") {
  // Admin/worker filtered list: GET /insurances?author=&date=&policyNumber=&blancNumber=&carNumber=&broker=
  // All fields are optional, but at least one must be filled in to search. Any
  // single criteria (or any combination of them) can be used.
  // The author field is intentionally empty by default so a search by, e.g.,
  // only a car number is not silently narrowed to the current user's own
  // records. Workers reach this view through "My insurances", which pre-fills
  // the author with their username so they still see only their own records.
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
  form.appendChild(apply);
  form.appendChild(clearBtn);
  form.appendChild(el("div", null, { class: "spacer" }));

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

  // Renders the current rows with the active sort applied. Sorting is done in
  // the browser (see sortInsuranceRows), so switching the order never re-runs
  // the search.
  function renderResults() {
    result.replaceChildren(
      renderTable(
        sortInsuranceRows(lastRows, insuranceSort.key, insuranceSort.dir),
        [
          { key: "BlancNumber", label: t("blankNo") },
          { key: "PolicyNumber", label: t("policyNumber") },
          { key: "CarNumber", label: t("carNumber") },
          {
            key: "Price",
            label: t("price"),
            format: (v) => money(v),
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
            format: (v) => (v ? t("annulled") : ""),
            ...sortHeader("Annulled"),
          },
        ],
        (i) => [
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
        (i) => (i.Annulled ? "row-annulled" : "")
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

    if (
      !author &&
      !broker &&
      !date &&
      !policyNumber &&
      !blancNumber &&
      !carNumber
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

    try {
      const data = await api(`/insurances?${params.toString()}`);
      let rows = data.insurances || [];
      // The server applies `Broker LIKE %name%` itself. This extra pass only
      // matters while the deployed server still predates the `broker`
      // parameter, so the new field keeps working right after a client update;
      // once the server filters too, every returned row already matches and
      // the pass is a no-op.
      if (broker) {
        const needle = broker.toLowerCase();
        rows = rows.filter((r) =>
          String(r.Broker || "").toLowerCase().includes(needle)
        );
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
    // Clearing drops the results, so the sort order is reset with them: the
    // next search starts in the default (server) order again.
    lastRows = [];
    insuranceSort = { key: null, dir: "desc" };
    result.replaceChildren();
  });

  Content.replaceChildren(el("h2", t("nav.insurancesByDate")), form, result);
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

async function workerMyInsurances() {
  // Workers only see their own records here, so pre-fill the author filter
  // with their username. The admin's "Insurances by date" view keeps the
  // author field empty so any single/multiple criteria can be searched.
  await adminInsurancesByDate(username);
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
      { key: "Price", label: t("price"), format: (v) => money(v) },
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
    (i) => (i.Annulled ? "row-annulled" : "")
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
    { key: "nav.insurances", load: adminInsurances },
    { key: "nav.insurancesByDate", load: adminInsurancesByDate },
    { key: "nav.currentCash", load: currentCashView },
    { key: "nav.totalCash", load: totalCashView },
    { key: "nav.card", load: cardView },
    { key: "nav.brokers", load: brokersView },
    { key: "nav.reconcile", load: reconcileView },
  ],
  2: [
    { key: "nav.dashboard", load: workerDashboard },
    { key: "nav.myInsurances", load: workerMyInsurances },
    { key: "nav.currentCash", load: currentCashView },
    { key: "nav.totalCash", load: totalCashView },
    { key: "nav.card", load: cardView },
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

  if (userRole === "2") {
    const addBtn = el("button", t("addInsurance"));
    addBtn.addEventListener("click", () => {
      // This is a walk-in insurance, not a broker-requested one: make sure no
      // leftover "pendingEmail" makes it look like an email-sourced insurance.
      localStorage.removeItem("pendingEmail");
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
    Content.replaceChildren(
      el("p", `Error: ${err.message}`, { class: "muted" })
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
    if (activeNav) runLoader(activeNav.load);
  });
}
syncLangButton();

init();
