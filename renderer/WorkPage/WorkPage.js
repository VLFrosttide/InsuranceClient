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

  const card = el("button", emailTitle(email), {
    class: "email-card",
    type: "button",
  });
  card.addEventListener("click", () => openEmailInNewForm(email));

  emailCards.set(email.messageId, { email, node: card });

  // If the dashboard is the active view, re-render it in place.
  if (activeNav && activeNav.load === workerDashboard) {
    Content.replaceChildren(
      el("h2", t("unreadEmails")),
      testToolbar(),
      emailCardsContainer()
    );
  }
}

function removeEmailCard(messageId) {
  if (!messageId || !emailCards.delete(messageId)) return;
  if (activeNav && activeNav.load === workerDashboard) {
    Content.replaceChildren(
      el("h2", t("unreadEmails")),
      testToolbar(),
      emailCardsContainer()
    );
  }
}

function openEmailInNewForm(email) {
  if (!emailSocket) {
    toast(t("emailConnUnavailable"), "error");
    return;
  }

  // Only navigate once the server confirms this client won the claim. If
  // another worker clicked the same card first, we show an error instead.
  pendingClaimEmail = email;
  emailSocket.send({ type: "claim_email", messageId: email.messageId });
}

function openClaimedEmail(email) {
  // Pass the email to the new page (AddInsurance) so it can show the full
  // body and attached pictures beside the form. AddInsurance will either
  // complete (submit) or release (cancel/back) the claim.
  localStorage.setItem("pendingEmail", JSON.stringify(email || null));
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
      testToolbar(),
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
      emailSocket.send({ type: "list_emails" });
    },
    list_emails: (msg) => reconcileEmailCards(msg.data),
    claim_email: (msg) => {
      if (!pendingClaimEmail || pendingClaimEmail.messageId !== msg.messageId) {
        return;
      }
      const email = pendingClaimEmail;
      pendingClaimEmail = null;
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
  emailSocket.send({ type: "list_emails" });
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
  columns.forEach((c) => headRow.appendChild(el("th", c.label)));
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
      row.appendChild(el("td", value ?? ""));
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
// Modal form for editing an insurance (admins + workers)
// ---------------------------------------------------------------------------
function openInsuranceEditor(insurance) {
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
    {
      key: "Duration",
      label: t("add.duration"),
      type: "number",
      value: insurance.Duration,
    },
    { key: "Branch", label: t("add.branch"), value: insurance.Branch },
    { key: "Otomobil", label: t("add.vehicleType"), value: insurance.Otomobil },
    {
      key: "StartDate",
      label: t("add.startDate"),
      type: "date",
      value: insurance.StartDate,
    },
    {
      key: "PaymentType",
      label: t("paymentType"),
      type: "select",
      options: [
        { label: t("payment.Card"), value: "Card" },
        { label: t("payment.Cash"), value: "Cash" },
      ],
      value: insurance.PaymentType || "Card",
    },
  ];

  const form = buildForm(
    spec,
    async (payload) => {
      const data = await api(`/insurances/${insurance.BlancNumber}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      toast(t("insuranceUpdated"), "success");
      closeModal();
      return data;
    },
    t("saveChanges")
  );

  openModal(`${t("editInsurance")} ${insurance.BlancNumber}`, form);
}

// ---------------------------------------------------------------------------
// Annulment modal (admins + workers)
// ---------------------------------------------------------------------------
const ANNUL_FEES = { broker: 8, worker: 1, none: 0 };

function openAnnulForm(insurance, onDone) {
  const price = Number(insurance.Price) || 0;

  const reasonSelect = select(
    [
      { label: t("annul.broker"), value: "broker" },
      { label: t("annul.worker"), value: "worker" },
      { label: t("annul.none"), value: "none" },
    ],
    "broker"
  );

  const feeLine = el("p", "", { class: "muted" });
  const refundLine = el("p", "", { class: "big" });

  function updatePreview() {
    const reason = reasonSelect.value;
    const fee = ANNUL_FEES[reason] ?? 0;
    const refund = Math.max(0, Math.round((price - fee) * 100) / 100);
    feeLine.textContent = `${t("annulFee")}: ${money(fee)} ${
      insurance.CurrencyType || ""
    }`;
    refundLine.textContent = `${t("annulRefund")}: ${money(refund)} ${
      insurance.CurrencyType || ""
    }`;
  }
  reasonSelect.addEventListener("change", updatePreview);
  updatePreview();

  const form = el("form");
  form.appendChild(field(t("annulReason"), reasonSelect));
  form.appendChild(el("p", t("annulFeeNote"), { class: "muted" }));
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
        body: JSON.stringify({ reason: reasonSelect.value }),
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

  // Get today's date in YYYY-MM-DD format
  const today = new Date().toISOString().slice(0, 10);

  // Count insurances by branch for today
  const branchCounts = {};
  for (const insurance of insurances) {
    const creationDate = insurance.CreationDate
      ? insurance.CreationDate.slice(0, 10)
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
        { key: "PaymentType", label: t("payment") },
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
          onClick: () => openInsuranceEditor(i),
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
      ],
      (i) => (i.Annulled ? "row-annulled" : "")
    );
    Content.replaceChildren(el("h2", t("allInsurances")), table);
  }

  render();
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
    actions,
    el("h3", t("transactions")),
    txTable,
    el("h3", t("resets")),
    resetTable
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

  const table = renderTable(
    data.brokers,
    [
      {
        key: "Name",
        label: t("name"),
        onClick: (b) => brokerPricingEditor(b),
      },
      { key: "CashBalance", label: t("balance"), format: (v) => money(v) },
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
    ]
  );

  Content.replaceChildren(el("h2", t("brokers")), toolbar, table);
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

async function adminInsurancesByDate() {
  // Admin/worker filtered list: GET /insurances?author=&date=&policyNumber=&blancNumber=&carNumber=
  // All fields are optional, but at least one must be filled in to search.
  // PolicyNumber/BlancNumber/CarNumber match partially (substring) on the
  // server, so a worker can search by a fragment of the number too.
  const authorInput = input("text", username);
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
  form.appendChild(field(t("date"), dateInput));
  form.appendChild(field(t("policyNumber"), policyNumberInput));
  form.appendChild(field(t("blankNo"), blancNumberInput));
  form.appendChild(field(t("carNumber"), carNumberInput));
  form.appendChild(apply);
  form.appendChild(clearBtn);
  form.appendChild(el("div", null, { class: "spacer" }));

  const result = el("div");

  async function runSearch() {
    const author = authorInput.value.trim();
    const date = dateInput.value;
    const policyNumber = policyNumberInput.value.trim();
    const blancNumber = blancNumberInput.value.trim();
    const carNumber = carNumberInput.value.trim();

    if (!author && !date && !policyNumber && !blancNumber && !carNumber) {
      toast(t("searchCriteriaRequired"), "error");
      return;
    }

    const params = new URLSearchParams();
    if (author) params.set("author", author);
    if (date) params.set("date", date);
    if (policyNumber) params.set("policyNumber", policyNumber);
    if (blancNumber) params.set("blancNumber", blancNumber);
    if (carNumber) params.set("carNumber", carNumber);

    try {
      const data = await api(`/insurances?${params.toString()}`);
      result.replaceChildren(
        renderTable(
          data.insurances,
          [
            { key: "BlancNumber", label: t("blankNo") },
            { key: "PolicyNumber", label: t("policyNumber") },
            { key: "CarNumber", label: t("carNumber") },
            { key: "Price", label: t("price"), format: (v) => money(v) },
            { key: "CurrencyType", label: t("currency") },
            { key: "PaymentType", label: t("payment") },
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
          (i) => [
            {
              label: t("edit"),
              class: "",
              onClick: () => openInsuranceEditor(i),
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
          ],
          (i) => (i.Annulled ? "row-annulled" : "")
        )
      );
    } catch (err) {
      toast(err.message, "error");
    }
  }

  apply.addEventListener("click", runSearch);
  // Pressing Enter in any filter field triggers the search too.
  [
    authorInput,
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
    dateInput.value = "";
    policyNumberInput.value = "";
    blancNumberInput.value = "";
    carNumberInput.value = "";
    result.replaceChildren();
  });

  Content.replaceChildren(el("h2", t("nav.insurancesByDate")), form, result);
}

// ---------------------------------------------------------------------------
// Worker views
// ---------------------------------------------------------------------------
async function testSimulateEmail() {
  await api("/test/email", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
}

async function testCreateDummyInsurances(count = 3) {
  const created = [];
  for (let i = 0; i < count; i++) {
    const suffix = `${Date.now()}-${i}-${Math.random()
      .toString(36)
      .slice(2, 6)}`;
    const blancNumber = `TEST-${suffix}`;
    await api("/worker/insurances", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        PolicyNumber: `BG/TEST/${suffix}`,
        BlancNumber: blancNumber,
        Duration: "1 година",
        Branch: "ГКПП Лесово",
        Otomobil: "Otomobil",
        StartDate: new Date().toISOString().slice(0, 10),
        Price: String(100 + i * 25),
        CurrencyType: "EUR",
        Cash: i % 2 === 0,
      }),
    });
    created.push(blancNumber);
  }
  return created;
}

async function runTest() {
  await testSimulateEmail();
  const created = await testCreateDummyInsurances(3);
  toast(
    `Test complete: email injected + ${created.length} dummy insurances created`,
    "success"
  );
}

function testToolbar() {
  const toolbar = el("div", null, { class: "row test-toolbar" });
  const testBtn = el("button", t("test"), { type: "button" });
  testBtn.addEventListener("click", async () => {
    testBtn.disabled = true;
    try {
      await runTest();
    } catch (err) {
      toast(err.message, "error");
    } finally {
      testBtn.disabled = false;
    }
  });
  toolbar.appendChild(testBtn);
  return toolbar;
}

async function workerDashboard() {
  Content.replaceChildren(
    el("h2", t("unreadEmails")),
    testToolbar(),
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
  await adminInsurancesByDate();
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
      { key: "PaymentType", label: t("payment") },
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
    { key: "nav.card", load: cardView },
    { key: "nav.brokers", load: brokersView },
  ],
  2: [
    { key: "nav.dashboard", load: workerDashboard },
    { key: "nav.myInsurances", load: workerMyInsurances },
    { key: "nav.currentCash", load: currentCashView },
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
    addBtn.addEventListener("click", () =>
      window.bridge.LoadNewPage("renderer/AddInsurance/AddInsurance.html")
    );
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

async function init() {
  renderHeader();
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
