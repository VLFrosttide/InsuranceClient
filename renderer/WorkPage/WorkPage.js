"use strict";

const Content = document.getElementById("Content");
const Nav = document.getElementById("Nav");
const HeaderTitle = document.getElementById("HeaderTitle");
const HeaderSub = document.getElementById("HeaderSub");
const LogoutButton = document.getElementById("LogoutButton");
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
  return email.subject || email.from || "(no subject)";
}

function emailCardsContainer() {
  const container = el("div", null, { id: "EmailCards", class: "email-cards" });
  if (emailCards.size === 0) {
    container.appendChild(el("p", "No unread emails.", { class: "muted" }));
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
      el("h2", "Unread emails"),
      testToolbar(),
      emailCardsContainer()
    );
  }
}

function removeEmailCard(messageId) {
  if (!messageId || !emailCards.delete(messageId)) return;
  if (activeNav && activeNav.load === workerDashboard) {
    Content.replaceChildren(
      el("h2", "Unread emails"),
      testToolbar(),
      emailCardsContainer()
    );
  }
}

function openEmailInNewForm(email) {
  if (!emailSocket) {
    toast("Email connection unavailable", "error");
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

function setupEmailSocket() {
  if (userRole !== "2") return;

  emailSocket = new UnreadEmailSocket({
    new_email: (msg) => addEmailCard(msg.data),
    list_emails: (msg) => {
      for (const email of msg.data || []) addEmailCard(email);
    },
    claim_email: (msg) => {
      if (!pendingClaimEmail || pendingClaimEmail.messageId !== msg.messageId) {
        return;
      }
      const email = pendingClaimEmail;
      pendingClaimEmail = null;
      if (msg.ok) {
        openClaimedEmail(email);
      } else {
        toast("This email was already opened by another worker", "error");
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

function money(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(2) : "0.00";
}

function openModal(title, bodyNode) {
  ModalTitle.textContent = title;
  ModalBody.replaceChildren(bodyNode);
  ModalBackdrop.classList.remove("hidden");
}
function closeModal() {
  ModalBackdrop.classList.add("hidden");
}
ModalClose.addEventListener("click", closeModal);
ModalBackdrop.addEventListener("click", (e) => {
  if (e.target === ModalBackdrop) closeModal();
});

// ---------------------------------------------------------------------------
// Form helpers
// ---------------------------------------------------------------------------
function field(labelText, inputNode) {
  const wrap = el("div", null, { class: "field" });
  wrap.appendChild(el("label", labelText));
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

function buildForm(spec, onSubmit, submitLabel) {
  const form = el("form");
  const values = {};
  for (const s of spec) {
    let control;
    if (s.type === "select") control = select(s.options, s.value);
    else if (s.type === "textarea") control = textarea(s.value, s.placeholder);
    else if (s.type === "checkbox") {
      control = input("checkbox");
      control.checked = !!s.value;
    } else control = input(s.type, s.value, s.placeholder);
    control.dataset.key = s.key;
    values[s.key] = control;
    form.appendChild(field(s.label, control));
  }
  const submit = el("button", submitLabel || "Save", { type: "submit" });
  form.appendChild(submit);

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    submit.disabled = true;
    const payload = {};
    for (const s of spec) {
      const c = values[s.key];
      if (c.type === "checkbox") payload[s.key] = c.checked;
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
function renderTable(items, columns, actions) {
  if (!items || items.length === 0) {
    return el("p", "No data.", { class: "muted" });
  }
  const table = el("table");
  const thead = el("thead");
  const headRow = el("tr");
  columns.forEach((c) => headRow.appendChild(el("th", c.label)));
  if (actions) headRow.appendChild(el("th", "Actions"));
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = el("tbody");
  for (const item of items) {
    const row = el("tr");
    columns.forEach((c) => {
      let value = item[c.key];
      if (c.format) value = c.format(value, item);
      row.appendChild(el("td", value ?? ""));
    });
    if (actions) {
      const td = el("td");
      const wrap = el("div", null, { class: "row actions" });
      actions.forEach((a) => {
        const btn = el("button", a.label, {
          class: `small ${a.class || "secondary"}`,
        });
        btn.addEventListener("click", () => a.onClick(item));
        wrap.appendChild(btn);
      });
      td.appendChild(wrap);
      row.appendChild(td);
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
    { key: "DKN", label: "ДКН", value: insurance.DKN },
    {
      key: "PolicyNumber",
      label: "Полица номер",
      value: insurance.PolicyNumber,
    },
    { key: "Price", label: "Цена", type: "number", value: insurance.Price },
    {
      key: "CurrencyType",
      label: "Валута",
      type: "select",
      options: [
        { label: "EUR", value: "EUR" },
        { label: "USD", value: "USD" },
        { label: "TRY", value: "TRY" },
      ],
      value: insurance.CurrencyType || "EUR",
    },
    {
      key: "BrokerCode",
      label: "Код офис на брокер",
      value: insurance.BrokerCode,
    },
    { key: "Branch", label: "Клон", value: insurance.Branch },
    { key: "Otomobil", label: "Otomobil", value: insurance.Otomobil },
    {
      key: "PaymentType",
      label: "Начин на плащане",
      type: "select",
      options: [
        { label: "Card", value: "Card" },
        { label: "Cash", value: "Cash" },
      ],
      value: insurance.PaymentType || "Card",
    },
    { key: "ClientName", label: "Име на клиент", value: insurance.ClientName },
    {
      key: "ClientAdress",
      label: "Адрес на клиент",
      value: insurance.ClientAdress,
    },
    {
      key: "ChassisNumber",
      label: "Шаси номер",
      value: insurance.ChassisNumber,
    },
    { key: "VehicleBrand", label: "Марка", value: insurance.VehicleBrand },
    { key: "Broker", label: "Broker (username)", value: insurance.Broker },
  ];

  const form = buildForm(
    spec,
    async (payload) => {
      const data = await api(`/insurances/${insurance.BlancNumber}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      toast("Insurance updated", "success");
      closeModal();
      return data;
    },
    "Save changes"
  );

  openModal(`Edit insurance ${insurance.BlancNumber}`, form);
}

// ---------------------------------------------------------------------------
// Admin views
// ---------------------------------------------------------------------------
async function adminDashboard() {
  const [statsData, cashData, cardData, brokerData, usersData] =
    await Promise.all([
      api("/admin/stats"),
      api("/currentcash"),
      api("/cardpayments"),
      api("/brokers"),
      api("/admin/users"),
    ]);
  const s = statsData.stats || {};
  const card = el("div", null, { class: "stat-card" });
  card.appendChild(el("h3", "Current cash"));
  card.appendChild(
    el(
      "p",
      `${money(cashData.currentCash)} (${
        cashData.transactions.length
      } movements)`,
      {
        class: "big",
      }
    )
  );

  const cardCard = el("div", null, { class: "stat-card" });
  cardCard.appendChild(el("h3", "Card balance"));
  cardCard.appendChild(el("p", money(cardData.cardBalance), { class: "big" }));

  const userCard = el("div", null, { class: "stat-card" });
  userCard.appendChild(el("h3", "Users"));
  userCard.appendChild(
    el(
      "p",
      `Admins ${s.admins ?? 0} · Workers ${s.workers ?? 0} · Clients ${
        s.clients ?? 0
      }`,
      { class: "big" }
    )
  );

  const brokerCard = el("div", null, { class: "stat-card" });
  brokerCard.appendChild(el("h3", "Brokers"));
  brokerCard.appendChild(
    el("p", String(brokerData.brokers.length), { class: "big" })
  );

  // Build a fresh grid.
  const grid = el("div", null, { class: "stat-grid" });
  grid.appendChild(card);
  grid.appendChild(cardCard);
  grid.appendChild(userCard);
  grid.appendChild(brokerCard);
  Content.replaceChildren(el("h2", "Overview"), grid);
}

async function adminUsers() {
  const data = await api("/admin/users");
  const roleOptions = [
    { label: "Admin", value: 1 },
    { label: "Worker", value: 2 },
    { label: "Client", value: 3 },
  ];

  const toolbar = el("div", null, { class: "row" });
  const addUserBtn = el("button", "New user");
  addUserBtn.addEventListener("click", () => registerUserForm());
  toolbar.appendChild(addUserBtn);

  const table = renderTable(
    data.users,
    [
      { key: "Username", label: "Username" },
      { key: "Role", label: "Role", format: (v) => ROLE_LABELS[v] || v },
      { key: "Balance", label: "Balance", format: (v) => money(v) },
      { key: "PayoutPercentage", label: "Payout %" },
      { key: "Status", label: "Status" },
    ],
    [
      {
        label: "Edit",
        class: "",
        onClick: (u) => {
          const form = buildForm(
            [
              {
                key: "role",
                label: "Role",
                type: "select",
                options: roleOptions,
                value: u.Role,
              },
              {
                key: "balance",
                label: "Balance",
                type: "number",
                value: u.Balance,
              },
              {
                key: "payoutPercentage",
                label: "Payout %",
                type: "number",
                value: u.PayoutPercentage,
              },
            ],
            async (payload) => {
              await api(`/admin/users/${u.Username}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload),
              });
              toast("User updated", "success");
              closeModal();
              adminUsers();
            },
            "Save"
          );
          openModal(`Edit ${u.Username}`, form);
        },
      },
      {
        label: "Promote",
        class: "secondary",
        onClick: (u) => {
          const form = buildForm(
            [
              {
                key: "role",
                label: "New role",
                type: "select",
                options: [
                  { label: "Worker", value: 2 },
                  { label: "Client", value: 3 },
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
              toast("User role updated", "success");
              closeModal();
              adminUsers();
            },
            "Promote"
          );
          openModal(`Promote ${u.Username}`, form);
        },
      },
      {
        label: "Suspend",
        class: "secondary",
        onClick: async (u) => {
          try {
            await api(`/admin/users/${u.Username}/suspend`, { method: "POST" });
            toast("User suspended", "success");
            adminUsers();
          } catch (err) {
            toast(err.message, "error");
          }
        },
      },
      {
        label: "Delete",
        class: "danger",
        onClick: async (u) => {
          if (!confirm(`Delete user "${u.Username}"?`)) return;
          try {
            await api(`/admin/users/${u.Username}/delete`, { method: "POST" });
            toast("User deleted", "success");
            adminUsers();
          } catch (err) {
            toast(err.message, "error");
          }
        },
      },
    ]
  );
  Content.replaceChildren(el("h2", "Users"), toolbar, table);
}

function registerUserForm() {
  const form = buildForm(
    [
      { key: "username", label: "Username", value: "" },
      { key: "password", label: "Password", type: "password", value: "" },
      {
        key: "role",
        label: "Role",
        type: "select",
        options: [
          { label: "Admin", value: 1 },
          { label: "Worker", value: 2 },
          { label: "Client", value: 3 },
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
        throw new Error(data.error || "Session expired");
      }
      if (!res.ok) {
        throw new Error(data.error || "Registration failed");
      }
      toast(`User "${data.username}" created`, "success");
      closeModal();
      adminUsers();
    },
    "Create user"
  );
  openModal("New user", form);
}

async function adminInsurances() {
  const data = await api("/admin/insurances");
  const table = renderTable(
    data.insurances,
    [
      { key: "BlancNumber", label: "Blank No." },
      { key: "Author", label: "Author" },
      { key: "ClientName", label: "Client" },
      { key: "Price", label: "Price", format: (v) => money(v) },
      { key: "CurrencyType", label: "Currency" },
      { key: "PaymentType", label: "Payment" },
      { key: "Broker", label: "Broker" },
    ],
    [
      {
        label: "Edit",
        class: "",
        onClick: (i) => openInsuranceEditor(i),
      },
    ]
  );
  Content.replaceChildren(el("h2", "All insurances"), table);
}

async function currentCashView() {
  const data = await api("/currentcash");
  const heading = el("h2", "Current cash");
  const balance = el("div", null, { class: "balance-card" });
  balance.appendChild(el("h3", "Balance"));
  balance.appendChild(el("p", `${money(data.currentCash)}`, { class: "big" }));

  const actions = el("div", null, { class: "row" });
  const incBtn = el("button", "Increase");
  const redBtn = el("button", "Reduce", { class: "secondary" });
  const resetBtn = el("button", "Reset to 0", { class: "danger" });
  actions.appendChild(incBtn);
  actions.appendChild(redBtn);
  actions.appendChild(resetBtn);

  function cashForm(kind, title) {
    const form = buildForm(
      [
        { key: "amount", label: "Amount", type: "number", value: "" },
        { key: "reason", label: "Reason", value: "" },
      ],
      async (payload) => {
        await api(`/currentcash/${kind}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        toast(
          `Current cash ${kind === "increase" ? "increased" : "reduced"}`,
          "success"
        );
        closeModal();
        currentCashView();
      },
      kind === "increase" ? "Increase" : "Reduce"
    );
    openModal(title, form);
  }
  incBtn.addEventListener("click", () =>
    cashForm("increase", "Increase current cash")
  );
  redBtn.addEventListener("click", () =>
    cashForm("reduce", "Reduce current cash")
  );
  resetBtn.addEventListener("click", async () => {
    if (!confirm("Reset current cash to 0? This will record the kept amount."))
      return;
    try {
      await api("/currentcash/reset", { method: "POST" });
      toast("Current cash reset", "success");
      currentCashView();
    } catch (err) {
      toast(err.message, "error");
    }
  });

  const txTable = renderTable(data.transactions, [
    { key: "Type", label: "Type" },
    { key: "Amount", label: "Amount", format: (v) => money(v) },
    { key: "Username", label: "User" },
    { key: "Reason", label: "Reason" },
    { key: "CreatedAt", label: "Created" },
  ]);
  const resetTable = renderTable(data.resets, [
    { key: "Username", label: "User" },
    { key: "KeptAmount", label: "Kept", format: (v) => money(v) },
    { key: "CreatedAt", label: "Created" },
  ]);

  Content.replaceChildren(
    heading,
    balance,
    actions,
    el("h3", "Transactions"),
    txTable,
    el("h3", "Resets"),
    resetTable
  );
}

async function cardView() {
  const data = await api("/cardpayments");
  const card = el("div", null, { class: "balance-card" });
  card.appendChild(el("h3", "Card balance"));
  card.appendChild(el("p", money(data.cardBalance), { class: "big" }));
  Content.replaceChildren(el("h2", "Card payments"), card);
}

async function brokersView() {
  const data = await api("/brokers");
  const isAdmin = userRole === "1";

  const toolbar = el("div", null, { class: "row" });
  if (isAdmin) {
    const addBtn = el("button", "New broker");
    addBtn.addEventListener("click", () => brokerCreateForm());
    toolbar.appendChild(addBtn);
    const expJson = el("button", "Export JSON", { class: "secondary" });
    const expCsv = el("button", "Export CSV", { class: "secondary" });
    expJson.addEventListener("click", async () => {
      const d = await api("/brokers/export?format=json");
      openModal("Brokers (JSON)", el("pre", JSON.stringify(d, null, 2)));
    });
    expCsv.addEventListener("click", async () => downloadBrokersCsv());
    toolbar.appendChild(expJson);
    toolbar.appendChild(expCsv);
  }

  const table = renderTable(
    data.brokers,
    [
      { key: "id", label: "ID" },
      { key: "Name", label: "Name" },
      { key: "CashBalance", label: "Balance", format: (v) => money(v) },
      { key: "Percentage", label: "Percentage" },
      { key: "PolicyRangeStart", label: "Range start" },
      { key: "PolicyRangeEnd", label: "Range end" },
      { key: "InactivePolicies", label: "Inactive" },
    ],
    [
      {
        label: "Increase",
        class: "",
        onClick: (b) => brokerAdjust(b, "increase"),
      },
      {
        label: "Reduce",
        class: "secondary",
        onClick: (b) => brokerAdjust(b, "reduce"),
      },
      ...(isAdmin
        ? [
            {
              label: "Edit",
              class: "secondary",
              onClick: (b) => brokerEditForm(b),
            },
            {
              label: "Delete",
              class: "danger",
              onClick: async (b) => {
                if (!confirm(`Delete broker "${b.Name}"?`)) return;
                try {
                  await api(`/brokers/${b.id}`, { method: "DELETE" });
                  toast("Broker deleted", "success");
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

  Content.replaceChildren(el("h2", "Brokers"), toolbar, table);
}

function brokerAdjust(broker, kind) {
  const form = buildForm(
    [{ key: "amount", label: "Amount", type: "number", value: "" }],
    async (payload) => {
      await api(`/brokers/${broker.id}/${kind}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      toast(
        `Broker balance ${kind === "increase" ? "increased" : "reduced"}`,
        "success"
      );
      closeModal();
      brokersView();
    },
    kind === "increase" ? "Increase" : "Reduce"
  );
  openModal(
    `${kind === "increase" ? "Increase" : "Reduce"} ${broker.Name}`,
    form
  );
}

function brokerCreateForm() {
  const form = buildForm(
    [
      { key: "Name", label: "Name", value: "" },
      { key: "CashBalance", label: "Cash balance", type: "number", value: 0 },
      { key: "Percentage", label: "Percentage", type: "number", value: 0 },
      {
        key: "PolicyRangeStart",
        label: "Policy range start",
        type: "number",
        value: "",
      },
      {
        key: "PolicyRangeEnd",
        label: "Policy range end",
        type: "number",
        value: "",
      },
      {
        key: "InactivePolicies",
        label: "Inactive policies",
        type: "number",
        value: 0,
      },
      { key: "emails", label: "Emails (comma separated)", value: "" },
    ],
    async (payload) => {
      payload.emails = String(payload.emails)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      await api("/brokers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      toast("Broker created", "success");
      closeModal();
      brokersView();
    },
    "Create broker"
  );
  openModal("New broker", form);
}

function brokerEditForm(broker) {
  const form = buildForm(
    [
      { key: "Name", label: "Name", value: broker.Name },
      {
        key: "CashBalance",
        label: "Cash balance",
        type: "number",
        value: broker.CashBalance,
      },
      {
        key: "Percentage",
        label: "Percentage",
        type: "number",
        value: broker.Percentage,
      },
      {
        key: "PolicyRangeStart",
        label: "Policy range start",
        type: "number",
        value: broker.PolicyRangeStart,
      },
      {
        key: "PolicyRangeEnd",
        label: "Policy range end",
        type: "number",
        value: broker.PolicyRangeEnd,
      },
      {
        key: "InactivePolicies",
        label: "Inactive policies",
        type: "number",
        value: broker.InactivePolicies,
      },
      {
        key: "emails",
        label: "Emails (comma separated)",
        value: (broker.emails || []).join(", "),
      },
    ],
    async (payload) => {
      payload.emails = String(payload.emails)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      await api(`/brokers/${broker.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      toast("Broker updated", "success");
      closeModal();
      brokersView();
    },
    "Save"
  );
  openModal(`Edit ${broker.Name}`, form);
}

async function downloadBrokersCsv() {
  const res = await fetch(`${API_BASE}/brokers/export?format=csv`, {
    headers: { Authorization: `Bearer ${getToken()}` },
  });
  if (!res.ok) {
    toast("Export failed", "error");
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
  // Admin/worker filtered list: GET /insurances?author=X&date=YYYY-MM-DD
  const authorInput = input("text", username);
  const dateInput = input("date", new Date().toISOString().slice(0, 10));
  const apply = el("button", "Load");
  const form = el("div", null, { class: "row filter-row" });
  form.appendChild(field("Author", authorInput));
  form.appendChild(field("Date", dateInput));
  form.appendChild(apply);
  form.appendChild(el("div", null, { class: "spacer" }));

  const result = el("div");
  apply.addEventListener("click", async () => {
    const date = dateInput.value;
    const author = authorInput.value.trim();
    if (!author || !date) {
      toast("Author and date are required", "error");
      return;
    }
    try {
      const data = await api(
        `/insurances?author=${encodeURIComponent(author)}&date=${date}`
      );
      result.replaceChildren(
        renderTable(
          data.insurances,
          [
            { key: "BlancNumber", label: "Blank No." },
            { key: "ClientName", label: "Client" },
            { key: "Price", label: "Price", format: (v) => money(v) },
            { key: "CurrencyType", label: "Currency" },
            { key: "PaymentType", label: "Payment" },
          ],
          [
            {
              label: "Edit",
              class: "",
              onClick: (i) => openInsuranceEditor(i),
            },
          ]
        )
      );
    } catch (err) {
      toast(err.message, "error");
    }
  });

  Content.replaceChildren(el("h2", "Insurances by author/date"), form, result);
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
        DKN: `TEST${i + 1}${Date.now() % 10000}`,
        PolicyNumber: `BG/TEST/${suffix}`,
        BlancNumber: blancNumber,
        Duration: "1 година",
        BrokerCode: "2.1",
        Branch: "ГКПП Лесово",
        Otomobil: "Otomobil",
        Price: String(100 + i * 25),
        CurrencyType: "EUR",
        ClientName: `Dummy Client ${i + 1}`,
        ClientAdress: `Dummy Address ${i + 1}`,
        ChassisNumber: `CHASSIS-${suffix}`,
        VehicleBrand: "Toyota",
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
  const testBtn = el("button", "Test", { type: "button" });
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
    el("h2", "Unread emails"),
    testToolbar(),
    emailCardsContainer()
  );
}

async function workerClients() {
  const data = await api("/worker/clients");
  const table = renderTable(
    data.clients,
    [
      { key: "Username", label: "Username" },
      { key: "Balance", label: "Balance", format: (v) => money(v) },
      { key: "PayoutPercentage", label: "Payout %" },
    ],
    [
      {
        label: "Set balance",
        class: "",
        onClick: (c) => {
          const form = buildForm(
            [
              {
                key: "balance",
                label: "Balance",
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
              toast("Balance updated", "success");
              closeModal();
              workerClients();
            },
            "Save"
          );
          openModal(`Set balance for ${c.Username}`, form);
        },
      },
    ]
  );
  Content.replaceChildren(el("h2", "Clients"), table);
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
  c1.appendChild(el("h3", "Username"));
  c1.appendChild(el("p", p.Username || username, { class: "big" }));
  const c2 = el("div", null, { class: "stat-card" });
  c2.appendChild(el("h3", "Balance"));
  c2.appendChild(el("p", money(p.Balance), { class: "big" }));
  const c3 = el("div", null, { class: "stat-card" });
  c3.appendChild(el("h3", "Payout %"));
  c3.appendChild(el("p", p.PayoutPercentage ?? "n/a", { class: "big" }));
  card.appendChild(c1);
  card.appendChild(c2);
  card.appendChild(c3);
  Content.replaceChildren(el("h2", "My Profile"), card);
}

async function clientInsurances() {
  const data = await api("/client/insurances");
  const table = renderTable(data.insurances, [
    { key: "BlancNumber", label: "Blank No." },
    { key: "DKN", label: "ДКН" },
    { key: "PolicyNumber", label: "Policy number" },
    { key: "ClientName", label: "Client" },
    { key: "Price", label: "Price", format: (v) => money(v) },
    { key: "CurrencyType", label: "Currency" },
    { key: "PaymentType", label: "Payment" },
    { key: "CreationDate", label: "Created" },
  ]);
  Content.replaceChildren(el("h2", "My Insurances"), table);
}

// ---------------------------------------------------------------------------
// Navigation setup
// ---------------------------------------------------------------------------
const NAV_DEFS = {
  1: [
    { label: "Dashboard", load: adminDashboard },
    { label: "Users", load: adminUsers },
    { label: "Insurances", load: adminInsurances },
    { label: "Insurances by date", load: adminInsurancesByDate },
    { label: "Current cash", load: currentCashView },
    { label: "Card", load: cardView },
    { label: "Brokers", load: brokersView },
  ],
  2: [
    { label: "Dashboard", load: workerDashboard },
    { label: "My insurances", load: workerMyInsurances },
    { label: "Current cash", load: currentCashView },
    { label: "Card", load: cardView },
    { label: "Brokers", load: brokersView },
  ],
  3: [
    { label: "Profile", load: clientProfile },
    { label: "My insurances", load: clientInsurances },
  ],
};

let activeNav = null;

function renderHeader() {
  HeaderTitle.textContent = "Dashboard";
  HeaderSub.textContent = `${username} · ${ROLE_LABELS[userRole] || "User"}`;
  Nav.replaceChildren();

  const defs = NAV_DEFS[userRole] || [];
  defs.forEach((d) => {
    const btn = el("button", d.label, { class: "secondary nav-btn" });
    console.log("Button: ", btn);
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
    const addBtn = el("button", "+ Add Insurance");
    addBtn.addEventListener("click", () =>
      window.bridge.LoadNewPage("renderer/AddInsurance/AddInsurance.html")
    );
    Nav.appendChild(addBtn);
  }
}

async function runLoader(load) {
  Content.replaceChildren(el("p", "Loading…", { class: "muted" }));
  try {
    await load();
  } catch (err) {
    Content.replaceChildren(
      el("p", `Error: ${err.message}`, { class: "muted" })
    );
  }
}

async function init() {
  renderHeader();
  setupEmailSocket();
  fetchUnreadEmails();

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

init();
