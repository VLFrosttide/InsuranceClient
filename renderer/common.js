"use strict";

// Shared helpers for the InsuranceClient renderer.
// Load this file before any page-specific logic script.

const API_BASE = "https://lavender-quail-935384.hostingersite.com";
const WS_URL = "wss://lavender-quail-935384.hostingersite.com/ws";

const ROLE_LABELS = { 1: "Admin", 2: "Worker", 3: "Client" };

// ---------------------------------------------------------------------------
// Internationalisation (Bulgarian + English).
//
// Default language is Bulgarian. The user can switch with the language button
// in the header; the choice is persisted in localStorage under "lang".
// ---------------------------------------------------------------------------
const I18N = {
  en: {
    brand: "Insurance Console",
    username: "Username",
    password: "Password",
    branch: "Branch",
    login: "Login",
    showHidePassword: "Show/hide password",
    enterCredentials: "Enter username and password",
    accessDenied: "Access Denied",
    sessionExpired: "Session expired",
    serverError: "Server Error",
    logout: "Logout",

    "nav.dashboard": "Dashboard",
    "nav.users": "Users",
    "nav.insurances": "Insurances",
    "nav.insurancesByDate": "Insurances by date",
    "nav.currentCash": "Current cash",
    "nav.card": "Card",
    "nav.brokers": "Brokers",
    "nav.myInsurances": "My insurances",
    "nav.clients": "Clients",
    "nav.profile": "Profile",
    addInsurance: "+ Add Insurance",

    loading: "Loading…",
    noData: "No data.",
    actions: "Actions",
    overview: "Overview",
    noUnreadEmails: "No unread emails.",
    unreadEmails: "Unread emails",

    balance: "Balance",
    currentCash: "Current cash",
    cardBalance: "Card balance",
    users: "Users",
    brokers: "Brokers",
    clients: "Clients",
    movements: "movements",
    admins: "Admins",
    workers: "Workers",

    "role.1": "Admin",
    "role.2": "Worker",
    "role.3": "Client",
    role: "Role",
    payoutPct: "Payout %",
    status: "Status",

    newUser: "New user",
    newBroker: "New broker",
    edit: "Edit",
    promote: "Promote",
    suspend: "Suspend",
    delete: "Delete",
    save: "Save",
    saveChanges: "Save changes",
    createUser: "Create user",
    newRole: "New role",
    setBalance: "Set balance",

    increase: "Increase",
    reduce: "Reduce",
    resetTo0: "Reset to 0",
    amount: "Amount",
    reason: "Reason",
    type: "Type",
    user: "User",
    created: "Created",
    transactions: "Transactions",
    resets: "Resets",
    allInsurances: "All insurances",
    myProfile: "My Profile",
    myInsurances: "My Insurances",

    author: "Author",
    date: "Date",
    load: "Load",
    clear: "Clear",
    searchCriteriaRequired:
      "Enter at least one search criteria (author, date, policy number, blank number or car number)",
    blankNo: "Blank No.",
    client: "Client",
    price: "Price",
    currency: "Currency",
    payment: "Payment",
    broker: "Broker",
    policyNumber: "Policy number",
    carNumber: "Car number",
    test: "Test",
    exportJson: "Export JSON",
    exportCsv: "Export CSV",
    close: "Close",
    editInsurance: "Edit insurance",
    insuranceUpdated: "Insurance updated",
    userUpdated: "User updated",
    userRoleUpdated: "User role updated",
    userSuspended: "User suspended",
    userDeleted: "User deleted",
    userCreated: "User {u} created",
    registrationFailed: "Registration failed",
    currentCashIncreased: "Current cash increased",
    currentCashReduced: "Current cash reduced",
    currentCashReset: "Current cash reset",
    transactionUpdated: "Transaction updated",
    editTransaction: "Edit transaction",
    resetConfirm: "Reset current cash to 0? This will record the kept amount.",
    brokerBalanceIncreased: "Broker balance increased",
    brokerBalanceReduced: "Broker balance reduced",
    brokerCreated: "Broker created",
    brokerUpdated: "Broker updated",
    brokerDeleted: "Broker deleted",
    exportFailed: "Export failed",
    balanceUpdated: "Balance updated",
    setBalanceFor: "Set balance for",
    deleteConfirm: "Delete",
    emailClaimed: "This email was already opened by another worker",
    emailConnUnavailable: "Email connection unavailable",
    name: "Name",
    percentage: "Percentage",
    rangeStart: "Range start",
    rangeEnd: "Range end",
    inactive: "Inactive",
    kept: "Kept",
    cardPayments: "Card payments",
    paymentType: "Payment method",
    "payment.Cash": "Cash",
    "payment.Card": "Card",

    annul: "Annul",
    annulled: "Annulled",
    annulReason: "Annul reason",
    "annul.broker": "Broker fault",
    "annul.worker": "Worker fault",
    "annul.none": "No fault",
    annulFee: "Fee",
    annulRefund: "Refund",
    annulFeeNote: "A fee is deducted from the refund depending on the reason.",
    annulConfirmTitle: "Annul insurance",
    annulSubmit: "Annul insurance",
    insuranceAnnulled: "Insurance annulled",
    alreadyAnnulled: "Already annulled",

    "add.back": "← Dashboard",

    "add.title": "Add Insurance",
    "add.policyNumber": "Policy number",
    "add.blancNumber": "Blank number",
    "add.carNumber": "Car number",
    "add.carNumberRequired": "Car number is required",
    "add.duration": "Duration",
    "add.branch": "Branch",
    "add.vehicleType": "Vehicle type",
    "add.startDate": "Starting date",
    "add.price": "Price",
    "add.currency": "Currency",
    "add.cash": "In cash",
    "add.submit": "Save",
    "add.clear": "Clear",
    "add.saved": "Insurance saved",
    "add.testDisableEmail": "Test (disable return email)",
    "add.dropArea": "Drop files here",
    "add.dropAreaHint": "or click to choose files",
    "add.attachedFiles": "Attached files",
    "add.removeFile": "Remove",
    "add.reply": "Reply",
    "add.replyPlaceholder": "Type your reply…",
    "add.replyButton": "Send reply",
    "add.replyConfirm": "Send this reply to the original sender?",
    "add.replySent": "Reply sent",
    "add.replyEmpty": "Type a reply first",

    "email.noSubject": "(no subject)",
    "email.from": "From:",
    "email.date": "Date:",
    "email.emptyBody": "(empty body)",
    "email.attachments": "Attached pictures",
    "email.noAttachments": "No attachments.",
    "email.attachment": "attachment",
    "email.zoomIn": "Zoom in",
    "email.zoomOut": "Zoom out",
    "email.resetZoom": "Reset zoom",
    "email.print": "Print picture",
    "email.close": "Close",
    "email.unclaim": "Unclaim",
  },
  bg: {
    brand: "Застрахователна конзола",
    username: "Потребителско име",
    password: "Парола",
    branch: "Клон",
    login: "Вход",
    showHidePassword: "Покажи/скрий паролата",
    enterCredentials: "Въведете потребителско име и парола",
    accessDenied: "Отказан достъп",
    sessionExpired: "Сесията изтече",
    serverError: "Сървърна грешка",
    logout: "Изход",

    "nav.dashboard": "Табло",
    "nav.users": "Потребители",
    "nav.insurances": "Застраховки",
    "nav.insurancesByDate": "Застраховки по дата",
    "nav.currentCash": "Наличен кеш",
    "nav.card": "Карта",
    "nav.brokers": "Брокери",
    "nav.myInsurances": "Моите застраховки",
    "nav.clients": "Клиенти",
    "nav.profile": "Профил",
    addInsurance: "+ Нова застраховка",

    loading: "Зареждане…",
    noData: "Няма данни.",
    actions: "Действия",
    overview: "Общ преглед",
    noUnreadEmails: "Няма нови имейли.",
    unreadEmails: "Непрочетени имейли",

    balance: "Баланс",
    currentCash: "Наличен кеш",
    cardBalance: "Баланс карта",
    users: "Потребители",
    brokers: "Брокери",
    clients: "Клиенти",
    movements: "движения",
    admins: "Администратори",
    workers: "Служители",

    "role.1": "Администратор",
    "role.2": "Служител",
    "role.3": "Клиент",
    role: "Роля",
    payoutPct: "% Изплащане",
    status: "Статус",

    newUser: "Нов потребител",
    newBroker: "Нов брокер",
    edit: "Редактирай",
    promote: "Повиши",
    suspend: "Спри",
    delete: "Изтрий",
    save: "Запази",
    saveChanges: "Запази промените",
    createUser: "Създай потребител",
    newRole: "Нова роля",
    setBalance: "Задай баланс",

    increase: "Увеличи",
    reduce: "Намали",
    resetTo0: "Нулирай",
    amount: "Сума",
    reason: "Причина",
    type: "Тип",
    user: "Потребител",
    created: "Създаден",
    transactions: "Транзакции",
    resets: "Нулирания",
    allInsurances: "Всички застраховки",
    myProfile: "Моят профил",
    myInsurances: "Моите застраховки",

    author: "Автор",
    date: "Дата",
    load: "Зареди",
    clear: "Изчисти",
    searchCriteriaRequired:
      "Въведете поне един критерий за търсене (автор, дата, номер на полица, номер на бланка или номер на автомобил)",
    blankNo: "Бланка №",
    client: "Клиент",
    price: "Цена",
    currency: "Валута",
    payment: "Плащане",
    broker: "Брокер",
    policyNumber: "Номер на полица",
    carNumber: "Номер на автомобил",
    test: "Тест",
    exportJson: "Експорт JSON",
    exportCsv: "Експорт CSV",
    close: "Затвори",
    editInsurance: "Редактирай застраховка",
    insuranceUpdated: "Застраховката е обновена",
    userUpdated: "Потребителят е обновен",
    userRoleUpdated: "Ролята е обновена",
    userSuspended: "Потребителят е спрян",
    userDeleted: "Потребителят е изтрит",
    userCreated: "Потребител {u} е създаден",
    registrationFailed: "Регистрацията не успя",
    currentCashIncreased: "Наличният кеш беше увеличен",
    currentCashReduced: "Наличният кеш беше намален",
    currentCashReset: "Наличният кеш беше нулиран",
    transactionUpdated: "Транзакцията е обновена",
    editTransaction: "Редактирай транзакция",
    resetConfirm:
      "Да се нулира ли наличният кеш? Ще бъде записана задържаната сума.",
    brokerBalanceIncreased: "Балансът на брокера беше увеличен",
    brokerBalanceReduced: "Балансът на брокера беше намален",
    brokerCreated: "Брокерът е създаден",
    brokerUpdated: "Брокерът е обновен",
    brokerDeleted: "Брокерът е изтрит",
    exportFailed: "Експортът не успя",
    balanceUpdated: "Балансът е обновен",
    setBalanceFor: "Задай баланс за",
    deleteConfirm: "Изтриване",
    emailClaimed: "Този имейл вече е отворен от друг служител",
    emailConnUnavailable: "Връзката с имейл е недостъпна",
    name: "Име",
    percentage: "Процент",
    rangeStart: "Начало на диапазон",
    rangeEnd: "Край на диапазон",
    inactive: "Неактивни",
    kept: "Задържана",
    cardPayments: "Плащания с карта",
    paymentType: "Начин на плащане",
    "payment.Cash": "В брой",
    "payment.Card": "С карта",
    "add.back": "← Табло",
    "add.title": "Нова застраховка",
    "add.policyNumber": "Полица номер",
    "add.blancNumber": "Бланка номер",
    "add.carNumber": "Номер на автомобил",
    "add.carNumberRequired": "Номерът на автомобила е задължителен",
    "add.duration": "Срок",
    "add.branch": "Клон",
    "add.vehicleType": "Вид превозно средство",
    "add.startDate": "Начална дата",
    "add.price": "Цена",
    "add.currency": "Валута",
    "add.cash": "В брой",
    "add.submit": "Запиши",
    "add.clear": "Изчисти",
    "add.saved": "Застраховката е запазена",
    "add.testDisableEmail": "Тест (изключи обратния имейл)",
    "add.dropArea": "Пуснете файлове тук",
    "add.dropAreaHint": "или щракнете, за да изберете файлове",
    "add.attachedFiles": "Прикачени файлове",
    "add.removeFile": "Премахни",
    "add.reply": "Отговор",
    "add.replyPlaceholder": "Въведете отговора си…",
    "add.replyButton": "Изпрати отговор",
    "add.replyConfirm": "Да се изпрати ли този отговор до оригиналния подател?",
    "add.replySent": "Отговорът е изпратен",
    "add.replyEmpty": "Първо въведете отговор",

    "email.noSubject": "(без тема)",
    "email.from": "От:",
    "email.date": "Дата:",
    "email.emptyBody": "(празно съдържание)",
    "email.attachments": "Прикачени снимки",
    "email.noAttachments": "Няма прикачени файлове.",
    "email.attachment": "прикачен файл",
    "email.zoomIn": "Увеличи",
    "email.zoomOut": "Намали",
    "email.resetZoom": "Нулирай мащаба",
    "email.print": "Принтирай снимка",
    "email.close": "Затвори",
    "email.unclaim": "Освободи имейла",
  },
};

let currentLang = localStorage.getItem("lang") || "bg";
if (!I18N[currentLang]) currentLang = "bg";

function getLang() {
  return currentLang;
}

function setLang(lang) {
  currentLang = I18N[lang] ? lang : "bg";
  localStorage.setItem("lang", currentLang);
  translatePage();
  return currentLang;
}

function toggleLang() {
  return setLang(currentLang === "bg" ? "en" : "bg");
}

function t(key, fallback) {
  const dict = I18N[currentLang];
  if (dict && dict[key] !== undefined) return dict[key];
  if (I18N.en && I18N.en[key] !== undefined) return I18N.en[key];
  return fallback !== undefined ? fallback : key;
}

function roleLabel(role) {
  return t(`role.${role}`, ROLE_LABELS[role] || String(role));
}

// Translate any static DOM marked with data-i18n / data-i18n-placeholder /
// data-i18n-title attributes.
function translatePage() {
  document.documentElement.lang = currentLang;
  document.querySelectorAll("[data-i18n]").forEach((node) => {
    node.textContent = t(node.getAttribute("data-i18n"));
  });
  document.querySelectorAll("[data-i18n-placeholder]").forEach((node) => {
    node.placeholder = t(node.getAttribute("data-i18n-placeholder"));
  });
  document.querySelectorAll("[data-i18n-title]").forEach((node) => {
    node.title = t(node.getAttribute("data-i18n-title"));
  });
}

// Format a date/datetime (Date object or MySQL "YYYY-MM-DD HH:MM:SS" string)
// as "dd-mm-yy HH:mm". Used for the current-cash transaction/reset timestamps.
function formatDateTime(value) {
  if (value === undefined || value === null || value === "") return "";
  let d;
  if (value instanceof Date) {
    d = value;
  } else if (typeof value === "string") {
    const s = value.trim();
    const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})/);
    if (m) {
      d = new Date(
        Number(m[1]),
        Number(m[2]) - 1,
        Number(m[3]),
        Number(m[4]),
        Number(m[5])
      );
    } else {
      d = new Date(s);
    }
  } else {
    d = new Date(value);
  }
  if (!d || isNaN(d.getTime())) return String(value ?? "");
  const p = (n) => String(n).padStart(2, "0");
  return (
    `${p(d.getDate())}-${p(d.getMonth() + 1)}-${p(d.getFullYear() % 100)} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}`
  );
}

function getToken() {
  return localStorage.getItem("token") || "";
}
function getUsername() {
  return localStorage.getItem("username") || "";
}
function getRole() {
  return localStorage.getItem("role") || "";
}
function getBranch() {
  return localStorage.getItem("branch") || "";
}

function clearSession() {
  localStorage.removeItem("token");
  localStorage.removeItem("username");
  localStorage.removeItem("role");
}

function redirectToLogin() {
  clearSession();
  window.bridge.LoadNewPage("renderer/LoginPage/index.html");
}

// Fetch helper that attaches the Bearer token and handles 401 globally.
async function api(path, options = {}) {
  const headers = Object.assign(
    { Authorization: `Bearer ${getToken()}` },
    options.headers || {}
  );
  const res = await fetch(`${API_BASE}${path}`, { ...options, headers });

  let data = {};
  try {
    data = await res.json();
  } catch {
    data = {};
  }

  if (res.status === 401) {
    redirectToLogin();
    throw new Error(data.error || t("sessionExpired"));
  }
  if (!res.ok) {
    throw new Error(data.error || `Request failed (${res.status})`);
  }
  return data;
}

// DOM factory.
function el(tag, text, attrs) {
  const node = document.createElement(tag);
  if (text !== undefined && text !== null) node.textContent = text;
  if (attrs) {
    for (const key in attrs) {
      if (key === "class") node.className = attrs[key];
      else if (key === "type") node.type = attrs[key];
      else node.setAttribute(key, attrs[key]);
    }
  }
  return node;
}

// Toast notification. `pointer-events` is disabled via CSS so a visible toast
// can never block pointer events on the inputs underneath it (this was a
// source of "sometimes unresponsive" input fields).
let toastTimer = null;
function toast(text, type = "info") {
  if (!text) return;
  const existing = document.querySelector(".toast");
  if (existing) existing.remove();

  const node = el("div", text, { class: `toast ${type}` });
  document.body.appendChild(node);

  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.remove(), 3500);
}

// Guard pages that require login.
function requireLogin() {
  if (!getToken()) {
    redirectToLogin();
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// WebSocket helper for unread-email workflows.
//
// The server authenticates the socket with the same Bearer token used by the
// REST API. Messages sent with `send()` before authentication are queued and
// flushed automatically once the server acknowledges `auth_ok`.
// ---------------------------------------------------------------------------
class UnreadEmailSocket {
  constructor(handlers = {}) {
    this.handlers = handlers;
    this.ws = null;
    this.authed = false;
    this.pending = [];
    this.reconnectDelay = 1000;
    this.reconnectTimer = null;
    this.manuallyClosed = false;
  }

  connect() {
    if (this.ws) return;
    this.manuallyClosed = false;

    let ws;
    try {
      ws = new WebSocket(WS_URL);
    } catch (err) {
      console.error("WebSocket error:", err);
      if (this.handlers.close) this.handlers.close(err);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.addEventListener("open", () => {
      // Reset the backoff now that a connection succeeded.
      this.reconnectDelay = 1000;
      ws.send(JSON.stringify({ type: "auth", token: getToken() }));
    });

    ws.addEventListener("message", (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }

      if (msg.type === "auth_ok") {
        this.authed = true;
        this.flush();
        if (this.handlers.auth_ok) this.handlers.auth_ok(msg);
        return;
      }

      if (msg.type === "auth_error") {
        try {
          if (this.handlers.auth_error) this.handlers.auth_error(msg);
          else redirectToLogin();
        } finally {
          // The token was rejected: there is no point in retrying.
          this.close();
        }
        return;
      }

      if (this.handlers[msg.type]) this.handlers[msg.type](msg);
      if (this.handlers["*"]) this.handlers["*"](msg);
    });

    ws.addEventListener("close", () => {
      this.ws = null;
      this.authed = false;
      if (this.handlers.close) this.handlers.close();
      this.scheduleReconnect();
    });

    ws.addEventListener("error", () => {
      // A close event follows and resets connection state.
    });
  }

  scheduleReconnect() {
    if (this.manuallyClosed || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 15000);
  }

  send(obj) {
    if (this.authed && this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
    } else {
      this.pending.push(obj);
    }
  }

  flush() {
    while (
      this.authed &&
      this.ws &&
      this.ws.readyState === WebSocket.OPEN &&
      this.pending.length
    ) {
      this.ws.send(JSON.stringify(this.pending.shift()));
    }
  }

  close() {
    this.manuallyClosed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // ignore
      }
    }
    this.ws = null;
    this.authed = false;
    this.pending = [];
  }
}

// Apply translations once the static DOM is parsed (scripts are deferred).
translatePage();
