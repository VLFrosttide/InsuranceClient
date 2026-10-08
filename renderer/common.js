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
    blockedBeforeServer:
      "The request was blocked before reaching the server (hosting firewall, antivirus or network proxy)",
    logout: "Logout",

    "nav.dashboard": "Dashboard",
    "nav.users": "Users",
    "nav.insurances": "Insurances",
    "nav.insurancesByDate": "Insurances by date",
    "nav.currentCash": "Current cash",
    "nav.totalCash": "Total cash",
    "nav.card": "Card",
    "nav.reconcile": "Reconcile daily report",
    "reconcile.title": "Reconcile daily report",
    "reconcile.dropHint": "Drop the daily report (Excel file) here",
    "reconcile.dropHint2": "or click to choose a file",
    "reconcile.noFile": "No file selected",
    "reconcile.run": "Reconcile",
    "reconcile.dbDate": "Check database insurances created on",
    "reconcile.dbDateHint":
      "Used to find insurances that exist in the database but are missing from the file. Clear it to skip that check.",
    "reconcile.endNote":
      "Valid-until is compared with Starting date + Duration (days).",
    "reconcile.invalidFile": "Please choose an Excel file (.xlsx, .xlsm, etc.)",
    "reconcile.columnsNotFound": "Required columns not found in the file",
    "reconcile.fileRows": "Rows in file",
    "reconcile.matched": "Fully matching",
    "reconcile.missingFromDb": "Missing from database",
    "reconcile.missingFromFile": "Missing from file",
    "reconcile.mismatches": "Partial data mismatch",
    "reconcile.missingFrom": "Missing from",
    "reconcile.database": "Database",
    "reconcile.file": "Uploaded file",
    "reconcile.fileValue": "File",
    "reconcile.dbValue": "DB",
    "reconcile.row": "File row",
    "reconcile.allGood": "Everything matches.",
    "reconcile.col.policy": "Policy number",
    "reconcile.col.blank": "Blank No.",
    "reconcile.col.from": "Starting date",
    "reconcile.col.to": "Valid until",
    "reconcile.col.car": "Car number",

    "nav.brokers": "Brokers",
    "nav.myInsurances": "My insurances",
    "nav.clients": "Clients",
    "nav.profile": "Profile",
    addInsurance: "+ Add Insurance",

    loading: "Loading…",
    noData: "No data.",
    actions: "Actions",
    overview: "Overview",
    unknownBranch: "Unknown branch",
    manage: "Manage",
    noUnreadEmails: "No unread emails.",
    unreadEmails: "Unread emails",

    balance: "Balance",
    currentCash: "Current cash",
    totalCash: "Total cash",
    totalCashHint:
      "Total cash = current cash + card payments + broker-balance payments. Current cash is only the cash balance.",
    currentCashHint:
      "Only the cash balance: money that physically arrived as cash. Card payments and email payments funded by a broker balance are counted in Total cash instead.",
    source: "Source",
    "source.Cash": "Cash",
    "source.Card": "Card",
    "source.Broker": "Broker balance",
    cashPart: "Cash part",
    cardPart: "Card part",
    brokerPart: "Broker part",
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
    exportJson: "Export JSON",
    exportCsv: "Export CSV",
    exportExcel: "Export Excel",
    rowNo: "No.",
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
    emailClaimTimeout: "The server did not respond. Please try again.",
    emailSendFailed: "Failed to send email",
    name: "Name",
    rangeStart: "Range start",
    rangeEnd: "Range end",
    inactive: "Inactive",
    kept: "Kept",
    cardPayments: "Card payments",
    paymentType: "Payment method",
    "payment.Cash": "Cash",
    "payment.Card": "Card",
    "payment.Broker": "Broker balance",
    clearBalance: "Clear balance",
    clearCardBalanceConfirm:
      "Clear the card balance to 0? This will record the kept amount.",
    cardBalanceCleared: "Card balance cleared",

    annul: "Annul",
    annulled: "Annulled",
    annulPayer: "Fee paid by",
    "annul.payer.broker": "Broker",
    "annul.payer.worker": "Worker",
    "annul.payer.none": "No fault",
    annulNoFault: "No fault: no fee, the full price is refunded.",
    annulInEffect: "The policy is already in effect: fee 9.",
    annulNotInEffect: "The policy has not started yet: fee 1.",
    annulFee: "Fee",
    annulRefund: "Refund",
    annulFeeNote:
      "The fee is 1 if the policy has not started yet, or 9 if it is already in effect (by its start date). No fault: no fee.",
    annulConfirmTitle: "Annul insurance",
    annulSubmit: "Annul insurance",
    insuranceAnnulled: "Insurance annulled",
    alreadyAnnulled: "Already annulled",

    deleted: "Deleted",
    deleteInsuranceConfirm: "Delete insurance {b}? It will be kept in the database but hidden from lists and reports.",
    insuranceDeleted: "Insurance deleted",

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
    "add.startDateRequired": "Starting date is required",
    "add.price": "Price",
    "add.currency": "Currency",
    "add.cash": "In cash",
    "add.nonTurk": "Non-Turk (+5 €)",
    "add.cardFee": "Card payment fee (+2 €)",
    "add.paidFromBroker":
      "Paid from the broker's balance (email policies cannot be paid in cash or by card).",
    "add.submit": "Save",
    "add.clear": "Clear",
    "add.clearConfirm": "Clear the form? All entered data and attached files will be lost.",
    "add.saved": "Insurance saved",
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
    "add.attachmentsRequired":
      "Attach at least one file before saving an email policy. The return email cannot be sent without attachments.",
    "add.replyFailed": "Insurance saved, but the return email failed: {e}",
    "add.emailLost":
      "This email is no longer reserved for you: it was taken by another worker or handled while you were disconnected.",

    "email.noSubject": "(no subject)",
    "email.from": "From:",
    "email.date": "Date:",
    "email.emptyBody": "(empty body)",
    "email.attachments": "Attachments",
    "email.noAttachments": "No attachments.",
    "email.attachment": "attachment",
    "email.zoomIn": "Zoom in",
    "email.zoomOut": "Zoom out",
    "email.resetZoom": "Reset zoom",
    "email.print": "Print picture",
    "email.printSuccess": "Picture sent to printer",
    "email.printCancelled": "Printing cancelled",
    "email.printFailed": "Printing failed",
    "email.close": "Close",
    "email.markIrrelevant": "Mark as irrelevant",
    "email.irrelevantConfirm":
      "Mark this email as irrelevant? It will be removed and will not appear again.",
    "email.irrelevantMarked": "Email marked as irrelevant",

    pricing: "Pricing",
    viewPricing: "View/Edit Pricing",
    editPricing: "Edit Pricing",
    vehicleType: "Vehicle Type",
    duration: "Duration",
    days: "days",
    pricingUpdated: "Pricing updated",

    "duration.15": "15 days",
    "duration.30": "1 month",
    "duration.90": "3 months",
    "vehicle.Automobile": "Car",
    "vehicle.Motor": "Motorcycle",
    "vehicle.Bus": "Van",
    "vehicle.Trailer": "Trailer",
    "edit.priceUnavailable":
      "No tariff for this vehicle type and duration - the price was not changed.",
    "edit.pricingLoadFailed":
      "Failed to load the tariffs - the price was not recalculated.",

    "outbox.queuedToast":
      "No connection to the server. The policy is saved on this computer and will be sent automatically - you can continue with the next one.",
    "outbox.deliveredToast": "Queued policy delivered: {label}",
    "outbox.deliveredReplyFailed":
      "Queued policy {label} was saved, but the return email failed: {e}",
    "outbox.failedToast": "The server rejected queued policy {label}: {e}",
    "outbox.authToast":
      "Your session expired - log in again to send the queued policies.",
    "outbox.badgeQueued": "{n} queued",
    "outbox.badgeFailed": "{n} failed",
    "outbox.badgeTitle": "Requests waiting to be sent to the server",
    "outbox.panelTitle": "Queued requests",
    "outbox.panelHint":
      "Saved on this computer. Retrying every {s} s until the server answers - also after restarting the app.",
    "outbox.retryNow": "Retry now",
    "outbox.retry": "Retry",
    "outbox.discard": "Discard",
    "outbox.discardConfirm":
      "Discard this policy? It has NOT reached the server and its data and files will be lost.",
    "outbox.offline": "Offline - no connection to the server",
    "outbox.online": "Connected",
    "outbox.nextRetry": "Next attempt in {s} s",
    "outbox.sendingNow": "Sending…",
    "outbox.status.pending": "Waiting",
    "outbox.status.sending": "Sending",
    "outbox.status.auth": "Log in again",
    "outbox.status.failed": "Rejected",
    "outbox.status.sent": "Delivered",
    "outbox.attempts": "attempts: {n}",
    "outbox.empty": "Nothing queued.",
    "outbox.emailQueued":
      "This email's policy is queued and will be sent automatically.",
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
    blockedBeforeServer:
      "Заявката е блокирана преди да достигне сървъра (защитна стена на хостинга, антивирус или мрежов прокси)",
    logout: "Изход",

    "nav.dashboard": "Табло",
    "nav.users": "Потребители",
    "nav.insurances": "Застраховки",
    "nav.insurancesByDate": "Застраховки по дата",
    "nav.currentCash": "Наличен кеш",
    "nav.totalCash": "Общ кеш",
    "nav.card": "Карта",
    "nav.reconcile": "Дневен отчет",
    "reconcile.title": "Дневен отчет",
    "reconcile.dropHint": "Пуснете дневния отчет (Excel файл) тук",
    "reconcile.dropHint2": "или щракнете, за да изберете файл",
    "reconcile.noFile": "Няма избран файл",
    "reconcile.run": "Сверка",
    "reconcile.dbDate": "Провери застраховки в базата, създадени на",
    "reconcile.dbDateHint":
      "Използва се за откриване на застраховки, които са в базата, но липсват във файла. Изчистете, за да пропуснете проверката.",
    "reconcile.endNote": "Валиден до се сравнява с Начална дата + Срок (дни).",
    "reconcile.invalidFile": "Моля, изберете Excel файл (.xlsx, .xlsm и др.)",
    "reconcile.columnsNotFound": "Не са намерени необходимите колони във файла",
    "reconcile.fileRows": "Редове във файла",
    "reconcile.matched": "Напълно съвпадащи",
    "reconcile.missingFromDb": "Липсват в базата",
    "reconcile.missingFromFile": "Липсват във файла",
    "reconcile.mismatches": "Частично несъответствие на данни",
    "reconcile.missingFrom": "Липсва от",
    "reconcile.database": "База данни",
    "reconcile.file": "Качения файл",
    "reconcile.fileValue": "Файл",
    "reconcile.dbValue": "База",
    "reconcile.row": "Ред във файла",
    "reconcile.allGood": "Всичко съвпада.",
    "reconcile.col.policy": "Номер на полица",
    "reconcile.col.blank": "Бланка №",
    "reconcile.col.from": "Начална дата",
    "reconcile.col.to": "Валиден до",
    "reconcile.col.car": "Номер на автомобил",

    "nav.brokers": "Брокери",
    "nav.myInsurances": "Моите застраховки",
    "nav.clients": "Клиенти",
    "nav.profile": "Профил",
    addInsurance: "+ Нова застраховка",

    loading: "Зареждане…",
    noData: "Няма данни.",
    actions: "Действия",
    overview: "Общ преглед",
    unknownBranch: "Неизвестен клон",
    manage: "Управление",
    noUnreadEmails: "Няма нови имейли.",
    unreadEmails: "Непрочетени имейли",

    balance: "Баланс",
    currentCash: "Наличен кеш",
    totalCash: "Общ кеш",
    totalCashHint:
      "Общ кеш = наличен кеш + картови плащания + плащания от баланс на брокер. Наличният кеш е само кешовият баланс.",
    currentCashHint:
      "Само кешовият баланс: пари, които са постъпили физически в брой. Картовите плащания и имейл плащанията, финансирани от баланс на брокер, се отчитат в Общ кеш.",
    source: "Източник",
    "source.Cash": "В брой",
    "source.Card": "Карта",
    "source.Broker": "Баланс на брокер",
    cashPart: "Кешова част",
    cardPart: "Картова част",
    brokerPart: "Брокерна част",
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
    exportJson: "Експорт JSON",
    exportCsv: "Експорт CSV",
    exportExcel: "Експорт Excel",
    rowNo: "№",
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
    deleted: "Изтрита",
    deleteInsuranceConfirm:
      "Да се изтрие ли застраховка {b}? Тя ще остане в базата данни, но ще бъде скрита от списъците и справките.",
    insuranceDeleted: "Застраховката е изтрита",
    emailClaimed: "Този имейл вече е отворен от друг служител",
    emailConnUnavailable: "Връзката с имейл е недостъпна",
    emailClaimTimeout: "Сървърът не отговори. Опитайте отново.",
    emailSendFailed: "Неуспешно изпращане на имейл",
    name: "Име",
    rangeStart: "Начало на диапазон",
    rangeEnd: "Край на диапазон",
    inactive: "Неактивни",
    kept: "Задържана",
    cardPayments: "Плащания с карта",
    paymentType: "Начин на плащане",
    "payment.Cash": "В брой",
    "payment.Card": "С карта",
    "payment.Broker": "От баланс на брокер",
    clearBalance: "Изчисти баланса",
    clearCardBalanceConfirm:
      "Да се нулира ли балансът на картата? Ще бъде записана задържаната сума.",
    cardBalanceCleared: "Балансът на картата е изчистен",

    annul: "Анулирай",
    annulled: "Анулирана",
    annulPayer: "Таксата се плаща от",
    "annul.payer.broker": "Брокер",
    "annul.payer.worker": "Служител",
    "annul.payer.none": "Без вина",
    annulNoFault: "Без вина: без такса, възстановява се цялата сума.",
    annulInEffect: "Полицата вече е в сила: такса 9.",
    annulNotInEffect: "Полицата още не е започнала: такса 1.",
    annulFee: "Такса",
    annulRefund: "Възстановена сума",
    annulFeeNote:
      "Таксата е 1, ако полицата още не е започнала, или 9, ако вече е в сила (според началната дата). Без вина: без такса.",
    annulConfirmTitle: "Анулиране на застраховка",
    annulSubmit: "Анулирай застраховката",
    insuranceAnnulled: "Застраховката е анулирана",
    alreadyAnnulled: "Вече е анулирана",
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
    "add.startDateRequired": "Началната дата е задължителна",
    "add.price": "Цена",
    "add.currency": "Валута",
    "add.cash": "В брой",
    "add.nonTurk": "Не-турчин (+5 €)",
    "add.cardFee": "Такса плащане с карта (+2 €)",
    "add.paidFromBroker":
      "Плаща се от баланса на брокера (имейл полиците не могат да се платят в брой или с карта).",
    "add.submit": "Запиши",
    "add.clear": "Изчисти",
    "add.clearConfirm": "Да се изчисти ли формата? Всички въведени данни и прикачени файлове ще бъдат загубени.",
    "add.saved": "Застраховката е запазена",
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
    "add.attachmentsRequired":
      "Прикачете поне един файл, преди да запишете имейл полица. Обратният имейл не може да бъде изпратен без прикачени файлове.",
    "add.replyFailed":
      "Застраховката е запазена, но обратният имейл не беше изпратен: {e}",
    "add.emailLost":
      "Този имейл вече не е запазен за вас: бил е взет от друг служител или обработен, докато връзката беше прекъсната.",

    "email.noSubject": "(без тема)",
    "email.from": "От:",
    "email.date": "Дата:",
    "email.emptyBody": "(празно съдържание)",
    "email.attachments": "Прикачени файлове",
    "email.noAttachments": "Няма прикачени файлове.",
    "email.attachment": "прикачен файл",
    "email.zoomIn": "Увеличи",
    "email.zoomOut": "Намали",
    "email.resetZoom": "Нулирай мащаба",
    "email.print": "Принтирай снимка",
    "email.printSuccess": "Снимката е изпратена към принтера",
    "email.printCancelled": "Принтирането е отказано",
    "email.printFailed": "Принтирането не успя",
    "email.close": "Затвори",
    "email.markIrrelevant": "Маркирай като нерелевантен",
    "email.irrelevantConfirm":
      "Да се маркира ли този имейл като нерелевантен? Той ще бъде премахнат и няма да се показва отново.",
    "email.irrelevantMarked": "Имейлът е маркиран като нерелевантен",

    pricing: "Цени",
    viewPricing: "Преглед/редактиране на цени",
    editPricing: "Редактирай цени",
    vehicleType: "Вид превозно средство",
    duration: "Период",
    days: "дни",
    pricingUpdated: "Цените са обновени",

    "duration.15": "15 дена",
    "duration.30": "1 месец",
    "duration.90": "3 месеца",
    "vehicle.Automobile": "Автомобил",
    "vehicle.Motor": "Мотор",
    "vehicle.Bus": "Бус",
    "vehicle.Trailer": "Ремарке",
    "edit.priceUnavailable":
      "Няма тарифа за този вид превозно средство и срок - цената не е променена.",
    "edit.pricingLoadFailed":
      "Неуспешно зареждане на тарифите - цената не е преизчислена.",

    "outbox.queuedToast":
      "Няма връзка със сървъра. Полицата е запазена на този компютър и ще бъде изпратена автоматично - можете да продължите със следващата.",
    "outbox.deliveredToast": "Чакащата полица е изпратена: {label}",
    "outbox.deliveredReplyFailed":
      "Чакащата полица {label} е запазена, но обратният имейл не беше изпратен: {e}",
    "outbox.failedToast": "Сървърът отхвърли чакащата полица {label}: {e}",
    "outbox.authToast":
      "Сесията изтече - влезте отново, за да се изпратят чакащите полици.",
    "outbox.badgeQueued": "{n} чакащи",
    "outbox.badgeFailed": "{n} неуспешни",
    "outbox.badgeTitle": "Заявки, които чакат изпращане към сървъра",
    "outbox.panelTitle": "Чакащи заявки",
    "outbox.panelHint":
      "Запазени на този компютър. Нов опит на всеки {s} с, докато сървърът отговори - и след рестарт на приложението.",
    "outbox.retryNow": "Опитай сега",
    "outbox.retry": "Опитай",
    "outbox.discard": "Откажи",
    "outbox.discardConfirm":
      "Да се откаже ли тази полица? Тя НЕ е достигнала сървъра и данните и файловете ѝ ще бъдат загубени.",
    "outbox.offline": "Няма връзка със сървъра",
    "outbox.online": "Свързан",
    "outbox.nextRetry": "Следващ опит след {s} с",
    "outbox.sendingNow": "Изпращане…",
    "outbox.status.pending": "Чака",
    "outbox.status.sending": "Изпраща се",
    "outbox.status.auth": "Влезте отново",
    "outbox.status.failed": "Отхвърлена",
    "outbox.status.sent": "Изпратена",
    "outbox.attempts": "опити: {n}",
    "outbox.empty": "Няма чакащи заявки.",
    "outbox.emailQueued":
      "Полицата за този имейл чака изпращане и ще бъде изпратена автоматично.",
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

function getPricingCache() {
  try {
    const cached = localStorage.getItem("brokerPricing");
    return cached ? JSON.parse(cached) : null;
  } catch {
    return null;
  }
}

function setPricingCache(pricing) {
  if (pricing) {
    localStorage.setItem("brokerPricing", JSON.stringify(pricing));
  }
}

/**
 * Fetch broker pricing from server and cache it locally.
 * Call this on login to update the pricing cache.
 *
 * @returns {Promise<object|null>} Pricing object {Auto: {15: price, ...}, ...}
 */
async function fetchBrokerPricing() {
  try {
    const branch = getBranch();
    const query = branch ? `?branch=${encodeURIComponent(branch)}` : "";
    const data = await api(`/tariffs/my-pricing${query}`);
    if (data && data.pricing) {
      setPricingCache(data.pricing);
      return data.pricing;
    }
  } catch (err) {
    if (err && err.status === 404) {
      // This user has no broker/pricing assigned on the server. Drop any stale
      // cache so old prices are never applied.
      localStorage.removeItem("brokerPricing");
      return null;
    }
    console.warn("Failed to fetch broker pricing:", err);
  }
  return null;
}

/**
 * Get a specific insurance price for the given type and duration.
 *
 * @param {string} insuranceType - e.g., "Auto", "Motor", "Bus", "Trailer"
 * @param {number} duration - days: 15, 30, 90
 * @returns {number|null} Price or null if not found
 */
function getInsurancePrice(insuranceType, duration) {
  const pricing = getPricingCache();
  if (
    !pricing ||
    !pricing[insuranceType] ||
    pricing[insuranceType][duration] === undefined
  ) {
    return null;
  }
  return pricing[insuranceType][duration];
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

  // Read the body as text first so a non-JSON reply (e.g. an HTML error page
  // from the hosting CDN/firewall or a proxy) can still be diagnosed. Every
  // error our own server sends is JSON with an `error` field.
  let raw = "";
  try {
    raw = await res.text();
  } catch {
    raw = "";
  }
  let data = {};
  let isJson = false;
  if (raw) {
    try {
      data = JSON.parse(raw);
      isJson = true;
    } catch {
      data = {};
    }
  }

  if (res.status === 401) {
    redirectToLogin();
    throw new Error(data.error || t("sessionExpired"));
  }
  if (!res.ok) {
    let message = data.error;
    if (!message) {
      // Not produced by the InsuranceServer API: the request was rejected
      // before it reached the application (hosting CDN / web application
      // firewall, antivirus or network proxy).
      const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(raw);
      const title = titleMatch ? titleMatch[1].replace(/\s+/g, " ").trim() : "";
      message = isJson
        ? `Request failed (${res.status})`
        : `${t("blockedBeforeServer")} (HTTP ${res.status}${
            title ? ` - ${title}` : ""
          })`;
      console.error(
        `API ${options.method || "GET"} ${path} was rejected outside the ` +
          `application: HTTP ${res.status}, server=${
            res.headers.get("server") || "?"
          }, request-id=${res.headers.get("x-hcdn-request-id") || "?"}, ` +
          `body: ${raw.slice(0, 500)}`
      );
    }
    const error = new Error(message);
    error.status = res.status;
    throw error;
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
// Confirmation / error toasts stay on screen for 6.5 s (previously 3.5 s) so
// the worker has time to notice and read them.
const TOAST_DURATION_MS = 6500;
let toastTimer = null;
function toast(text, type = "info") {
  if (!text) return;
  const existing = document.querySelector(".toast");
  if (existing) existing.remove();

  const node = el("div", text, { class: `toast ${type}` });
  // Errors interrupt screen readers; confirmations are announced politely.
  node.setAttribute("role", type === "error" ? "alert" : "status");
  node.setAttribute("aria-live", type === "error" ? "assertive" : "polite");
  document.body.appendChild(node);

  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.remove(), TOAST_DURATION_MS);
}

// Log an error to the console and show it to the user in an error toast.
// `context` describes what failed (console only); the toast shows the error's
// own message, or the translated `fallbackKey` when the error has none.
function reportError(context, err, fallbackKey = "serverError") {
  console.error(`${context}:`, err);
  const message = err && err.message ? err.message : "";
  const base = t(fallbackKey);
  toast(message && message !== base ? `${base}: ${message}` : base, "error");
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
// Outbox (offline queue) - renderer side.
//
// The queue itself lives in the main process (see /outbox.js): it stores each
// request with its files on disk and retries every 5 s until the server
// answers, across page changes and app restarts. This part shows a floating
// "N queued" badge on every page and keeps the email workflow in sync.
// ---------------------------------------------------------------------------
let outboxState = null;
const outboxListeners = new Set();
let outboxBadge = null;
let outboxPanel = null;
let outboxTick = null;

function outboxAvailable() {
  return !!(window.bridge && typeof window.bridge.OutboxSubmit === "function");
}

function fmt(text, vars) {
  return String(text).replace(/\{(\w+)\}/g, (m, k) =>
    vars && vars[k] !== undefined ? String(vars[k]) : m
  );
}

// Subscribe to queue state changes (called immediately with the last state).
function onOutboxState(listener) {
  outboxListeners.add(listener);
  if (outboxState) listener(outboxState);
  return () => outboxListeners.delete(listener);
}

// Message IDs of email policies that are queued (not yet delivered, or
// delivered but the email is not completed yet). Their cards must stay hidden.
function outboxEmailIds(state = outboxState) {
  const ids = new Set();
  for (const item of (state && state.items) || []) {
    if (item.messageId && item.status !== "failed") ids.add(item.messageId);
  }
  return ids;
}

/**
 * Send a request through the durable outbox. Waits up to `waitMs` for the
 * server, so with a normal connection it behaves like api(); when the server
 * cannot be reached the request stays queued and `{ queued: true }` returns.
 *
 * @returns {Promise<{status, queued, result?, error?, id}>}
 *   status: "sent" | "failed" | "pending" | "sending" | "auth"
 */
async function submitWithOutbox(req, waitMs = 8000) {
  if (!outboxAvailable()) {
    // Fallback (plain browser): a normal one-shot request.
    const result = await api(req.path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: req.body,
    });
    return { status: "sent", queued: false, result };
  }
  return window.bridge.OutboxSubmit(
    {
      ...req,
      baseUrl: API_BASE,
      token: getToken(),
      username: getUsername(),
    },
    waitMs
  );
}

// --- Email follow-up for queued email policies ----------------------------
// An email policy's email must stay reserved for this worker while the policy
// waits in the queue, and be completed once it is delivered. Pages that hold
// an authenticated email socket (dashboard, email form) call this after
// auth_ok and on every queue change.
const outboxClaimedEmails = new Set();

// `ownMessageId`: the email the current page itself has open (the email form).
// Its claim is managed by that page, so it is never claimed or released here -
// e.g. a policy the server rejects right away is dropped from the queue, and
// that must not hand the email the worker is still editing back to everyone.
function syncOutboxEmails(socket, ownMessageId = null) {
  if (!socket || typeof socket.isReady !== "function" || !socket.isReady()) {
    return;
  }
  const current = new Set();
  for (const item of (outboxState && outboxState.items) || []) {
    if (!item.messageId) continue;
    current.add(item.messageId);
    if (item.messageId === ownMessageId && item.status !== "sent") continue;
    try {
      if (item.status === "sent") {
        // Delivered: mark the email handled everywhere, then forget the item.
        socket.send({ type: "complete_email", messageId: item.messageId });
        outboxClaimedEmails.delete(item.messageId);
        window.bridge.OutboxAcknowledge(item.id).catch((err) =>
          console.error("Failed to acknowledge outbox item:", err)
        );
      } else if (!outboxClaimedEmails.has(item.messageId)) {
        // Still queued: keep the email reserved so nobody handles it twice.
        socket.send({
          type: "claim_email",
          messageId: item.messageId,
          restore: true,
        });
        outboxClaimedEmails.add(item.messageId);
      }
    } catch (err) {
      console.error("Failed to sync queued email policy:", err);
    }
  }
  // Discarded by the worker: give the email back to everyone.
  for (const messageId of Array.from(outboxClaimedEmails)) {
    if (current.has(messageId) || messageId === ownMessageId) continue;
    outboxClaimedEmails.delete(messageId);
    try {
      socket.send({ type: "release_email", messageId });
    } catch (err) {
      console.error("Failed to release discarded email policy:", err);
    }
  }
}

// A reconnect starts a new server-side session: claims must be re-sent.
function resetOutboxEmailClaims() {
  outboxClaimedEmails.clear();
}

// --- Badge + panel ---------------------------------------------------------
function outboxStatusLabel(status) {
  return t(`outbox.status.${status}`, status);
}

function ensureOutboxBadge() {
  if (outboxBadge || !document.body) return;
  outboxBadge = el("button", "", {
    id: "OutboxBadge",
    type: "button",
    class: "outbox-badge hidden",
  });
  outboxBadge.addEventListener("click", () => toggleOutboxPanel());
  outboxPanel = el("div", null, { id: "OutboxPanel", class: "outbox-panel hidden" });
  document.body.appendChild(outboxPanel);
  document.body.appendChild(outboxBadge);
}

function toggleOutboxPanel(show) {
  if (!outboxPanel) return;
  const visible = show ?? outboxPanel.classList.contains("hidden");
  outboxPanel.classList.toggle("hidden", !visible);
  if (visible) renderOutboxPanel();
}

function renderOutboxBadge() {
  ensureOutboxBadge();
  if (!outboxBadge) return;
  const s = outboxState || { items: [], unsentCount: 0, failedCount: 0 };
  const unsent = s.unsentCount || 0;
  const failed = s.failedCount || 0;
  const visible = unsent > 0 || failed > 0;
  outboxBadge.classList.toggle("hidden", !visible);
  if (!visible) {
    toggleOutboxPanel(false);
    return;
  }
  const parts = [];
  if (unsent) parts.push(fmt(t("outbox.badgeQueued"), { n: unsent }));
  if (failed) parts.push(fmt(t("outbox.badgeFailed"), { n: failed }));
  let sub = "";
  if (unsent) {
    if (s.items.some((i) => i.status === "sending")) sub = t("outbox.sendingNow");
    else if (s.nextRetryAt) {
      const secs = Math.max(0, Math.ceil((s.nextRetryAt - Date.now()) / 1000));
      sub = fmt(t("outbox.nextRetry"), { s: secs });
    }
  }
  outboxBadge.replaceChildren(
    el("span", "⇅", { class: "outbox-badge-icon" }),
    el("span", parts.join(" · "), { class: "outbox-badge-count" }),
    el("span", sub, { class: "outbox-badge-sub" })
  );
  outboxBadge.title = t("outbox.badgeTitle");
  outboxBadge.classList.toggle("outbox-badge-failed", failed > 0);
  outboxBadge.classList.toggle("outbox-badge-offline", s.connected === false);
  if (outboxPanel && !outboxPanel.classList.contains("hidden")) {
    renderOutboxPanel();
  }
}

function renderOutboxPanel() {
  if (!outboxPanel) return;
  const s = outboxState || { items: [] };
  const items = (s.items || []).filter((i) => i.status !== "sent");

  const header = el("div", null, { class: "row outbox-panel-header" });
  header.appendChild(el("strong", t("outbox.panelTitle")));
  header.appendChild(el("div", null, { class: "spacer" }));
  const retryAll = el("button", t("outbox.retryNow"), {
    class: "small",
    type: "button",
  });
  retryAll.addEventListener("click", () => {
    window.bridge
      .OutboxRetryAll(true)
      .catch((err) => reportError("Outbox retry failed", err));
  });
  header.appendChild(retryAll);
  const close = el("button", "✕", { class: "secondary small", type: "button" });
  close.addEventListener("click", () => toggleOutboxPanel(false));
  header.appendChild(close);

  const conn = el(
    "div",
    s.connected === false ? t("outbox.offline") : s.connected ? t("outbox.online") : "",
    { class: `outbox-conn ${s.connected === false ? "offline" : "online"}` }
  );
  const hint = el(
    "div",
    fmt(t("outbox.panelHint"), { s: Math.round((s.retryIntervalMs || 5000) / 1000) }),
    { class: "muted outbox-hint" }
  );

  const list = el("ul", null, { class: "outbox-list" });
  if (!items.length) list.appendChild(el("li", t("outbox.empty"), { class: "muted" }));
  for (const item of items) {
    const li = el("li", null, { class: `outbox-item status-${item.status}` });
    const top = el("div", null, { class: "row" });
    top.appendChild(el("span", item.label || item.id, { class: "outbox-label" }));
    top.appendChild(el("div", null, { class: "spacer" }));
    top.appendChild(
      el("span", outboxStatusLabel(item.status), { class: "outbox-status" })
    );
    li.appendChild(top);
    const meta = [
      formatDateTime(new Date(item.createdAt)),
      fmt(t("outbox.attempts"), { n: item.attempts || 0 }),
    ];
    li.appendChild(el("div", meta.join(" · "), { class: "muted small" }));
    if (item.lastError) {
      li.appendChild(el("div", item.lastError, { class: "outbox-error small" }));
    }
    const actions = el("div", null, { class: "row outbox-actions" });
    if (item.status === "failed") {
      const retry = el("button", t("outbox.retry"), { class: "small", type: "button" });
      retry.addEventListener("click", () =>
        window.bridge.OutboxRetry(item.id).catch((err) => reportError("Outbox retry failed", err))
      );
      actions.appendChild(retry);
    }
    if (item.status !== "sending") {
      const discard = el("button", t("outbox.discard"), {
        class: "danger small",
        type: "button",
      });
      discard.addEventListener("click", () => {
        if (!confirm(t("outbox.discardConfirm"))) return;
        window.bridge
          .OutboxDiscard(item.id)
          .catch((err) => reportError("Outbox discard failed", err));
      });
      actions.appendChild(discard);
    }
    if (actions.childNodes.length) li.appendChild(actions);
    list.appendChild(li);
  }
  outboxPanel.replaceChildren(header, conn, hint, list);
}

function applyOutboxState(state) {
  const previous = outboxState;
  outboxState = state || null;
  // Surface new 401 parking once per change, not on every tick.
  const authNow = (state && state.items || []).some((i) => i.status === "auth");
  const authBefore = (previous && previous.items || []).some((i) => i.status === "auth");
  if (authNow && !authBefore) toast(t("outbox.authToast"), "error");
  // Newly rejected items (validation error, duplicate number, ...).
  const failedBefore = new Set(
    ((previous && previous.items) || [])
      .filter((i) => i.status === "failed")
      .map((i) => i.id)
  );
  if (previous) {
    for (const item of (state && state.items) || []) {
      if (item.status === "failed" && !failedBefore.has(item.id)) {
        toast(
          fmt(t("outbox.failedToast"), { label: item.label, e: item.lastError }),
          "error"
        );
      }
    }
  }
  renderOutboxBadge();
  for (const listener of outboxListeners) {
    try {
      listener(outboxState);
    } catch (err) {
      console.error("Outbox state listener failed:", err);
    }
  }
}

function initOutboxUi() {
  if (!outboxAvailable()) return;
  window.bridge.OnOutboxState(applyOutboxState);
  window.bridge.OnOutboxDelivered(({ item, result } = {}) => {
    if (!item) return;
    const replyError = result && result.replyError;
    if (replyError) {
      toast(
        fmt(t("outbox.deliveredReplyFailed"), { label: item.label, e: replyError }),
        "error"
      );
    } else {
      toast(fmt(t("outbox.deliveredToast"), { label: item.label }), "success");
    }
  });
  window.bridge
    .OutboxGetState()
    .then((state) => {
      // Pick up a fresh login (new token) for requests parked on a 401.
      const token = getToken();
      if (token && state && state.items.some((i) => i.status === "auth")) {
        window.bridge.OutboxUpdateToken(getUsername(), token).catch(() => {});
      }
      applyOutboxState(state);
    })
    .catch((err) => console.error("Failed to load the outbox state:", err));
  // Count down "Next attempt in N s" between state pushes.
  clearInterval(outboxTick);
  outboxTick = setInterval(() => {
    if (outboxState && outboxState.unsentCount && outboxState.nextRetryAt) {
      renderOutboxBadge();
    }
  }, 1000);
  // The OS says the network is back: do not wait for the next 5 s tick.
  window.addEventListener("online", () => {
    window.bridge.OutboxRetryAll(false).catch(() => {});
  });
}

// ---------------------------------------------------------------------------
// WebSocket helper for unread-email workflows.
//
// The server authenticates the socket with the same Bearer token used by the
// REST API. Messages sent with `send()` before authentication are queued and
// flushed automatically once the server acknowledges `auth_ok`.
// ---------------------------------------------------------------------------

// Number of consecutive failed handshakes before the worker is told that live
// email updates are unavailable. One or two failures are routine - the hosting
// platform recycles the Node process on deploy - so those stay in the console.
const WS_OUTAGE_REPORT_AFTER = 3;

class UnreadEmailSocket {
  constructor(handlers = {}) {
    this.handlers = handlers;
    this.ws = null;
    this.authed = false;
    this.pending = [];
    this.reconnectDelay = 1000;
    this.reconnectTimer = null;
    this.manuallyClosed = false;
    // Consecutive attempts that never reached the OPEN state. A WebSocket
    // handshake never follows redirects, so when the hosting CDN answers the
    // upgrade with a 3xx (or the origin is briefly unreachable) the only
    // recovery is the retry loop. These counters decide when the failure is
    // worth showing to the worker and when to run the reachability probe.
    this.failedAttempts = 0;
    this.outageReported = false;
    this.probing = false;
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

    // Distinguishes "the handshake never completed" from "an established
    // connection dropped later". Only the former means the upgrade itself was
    // refused (e.g. a 3xx from the reverse proxy instead of 101).
    let opened = false;

    ws.addEventListener("open", () => {
      opened = true;
      // Reset the backoff and the outage state now that a connection succeeded.
      this.reconnectDelay = 1000;
      this.failedAttempts = 0;
      this.outageReported = false;
      try {
        ws.send(
          JSON.stringify({
            type: "auth",
            token: getToken(),
            branch: getBranch(),
          })
        );
      } catch (err) {
        console.error("Failed to authenticate email WebSocket:", err);
      }
    });

    ws.addEventListener("message", (event) => {
      // Ignore late messages from a socket superseded by reconnectNow().
      if (this.ws !== ws) return;
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch (err) {
        console.error("Failed to parse email WebSocket message:", err);
        return;
      }

      if (msg.type === "auth_ok") {
        this.authed = true;
        this.flush();
        try {
          if (this.handlers.auth_ok) this.handlers.auth_ok(msg);
        } catch (err) {
          console.error("Email WebSocket auth_ok handler failed:", err);
        }
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

      try {
        if (this.handlers[msg.type]) this.handlers[msg.type](msg);
        if (this.handlers["*"]) this.handlers["*"](msg);
      } catch (err) {
        console.error(`Email WebSocket "${msg.type}" handler failed:`, err);
      }
    });

    ws.addEventListener("close", () => {
      // A socket dropped by reconnectNow() must not clobber its replacement.
      if (this.ws !== ws) return;
      this.ws = null;
      this.authed = false;
      if (this.handlers.close) this.handlers.close();

      if (!opened) {
        // The handshake never completed. This is what a redirect looks like
        // from here: the browser reports "Unexpected response code: 307" (or
        // any other non-101 status) and the socket never opens.
        this.failedAttempts += 1;
        console.error(
          `Email WebSocket handshake failed for ${WS_URL} ` +
            `(attempt ${this.failedAttempts}, retrying in ${this.reconnectDelay} ms)`
        );
        this.reportOutage();
      }
      this.scheduleReconnect();
    });

    ws.addEventListener("error", (event) => {
      // A close event follows and resets connection state. The event itself
      // carries no detail, so log the target URL alongside it: a refused
      // handshake and a dropped connection look identical otherwise.
      console.error(`Email WebSocket error (${WS_URL}):`, event);
    });
  }

  /**
   * After several handshakes fail in a row, tell the worker that live email
   * updates are unavailable and work out why. Probing the REST API separates
   * the two causes, which need completely different fixes: the server being
   * down (both fail), versus something blocking only the upgrade - the hosting
   * CDN answering with a redirect, a system proxy, or antivirus TLS
   * inspection (REST works, the socket does not).
   */
  reportOutage() {
    if (this.failedAttempts < WS_OUTAGE_REPORT_AFTER || this.outageReported) {
      return;
    }
    this.outageReported = true;
    toast(t("emailConnUnavailable"), "error");
    this.probeApi();
  }

  async probeApi() {
    if (this.probing) return;
    this.probing = true;
    try {
      const res = await fetch(`${API_BASE}/health`, { cache: "no-store" });
      const body = (await res.text()).trim();
      console.warn(
        "Email WebSocket diagnostic: the REST API is reachable " +
          `(HTTP ${res.status}${body ? ` ${body}` : ""}), so the server is up. ` +
          "Only the WebSocket upgrade is failing, which means it is being " +
          "redirected or blocked by an intermediary between this client and " +
          "the server (hosting CDN, system proxy, or antivirus TLS " +
          "inspection). Retrying automatically."
      );
    } catch (err) {
      console.warn(
        "Email WebSocket diagnostic: the REST API is NOT reachable (" +
          `${err && err.message ? err.message : err}), so the server or the ` +
          "network path to it is down. Retrying automatically."
      );
    } finally {
      this.probing = false;
    }
  }

  // True when a message sent now goes straight to the server instead of being
  // queued. Request/response flows (e.g. claiming an email) need this: a
  // queued request gives the user no feedback until the socket reconnects.
  isReady() {
    return Boolean(
      this.authed && this.ws && this.ws.readyState === WebSocket.OPEN
    );
  }

  // Skip the remaining backoff delay when no connection attempt is in
  // progress (the user is actively waiting on the socket).
  ensureConnected() {
    if (this.manuallyClosed || this.ws) return;
    this.reconnectNow();
  }

  // Drop the current connection - which may be half-open: readyState still
  // OPEN while the network path is dead, so sends vanish silently - and open
  // a fresh one immediately.
  reconnectNow() {
    if (this.manuallyClosed) return;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const old = this.ws;
    this.ws = null;
    this.authed = false;
    if (old) {
      try {
        old.close();
      } catch {
        // ignore
      }
    }
    this.reconnectDelay = 1000;
    this.connect();
  }

  scheduleReconnect() {
    if (this.manuallyClosed || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 15000);
  }

  // Send (or queue until authenticated) an email WebSocket message. Errors are
  // logged here and re-thrown so every caller can guard the send with its own
  // try/catch and tell the worker what failed.
  send(obj) {
    if (this.authed && this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify(obj));
      } catch (err) {
        console.error("Failed to send email WebSocket message:", err);
        throw err;
      }
    } else {
      this.pending.push(obj);
    }
  }

  // Queued messages are flushed from the socket's own message handler, where
  // there is no caller to re-throw to, so failures are reported directly.
  flush() {
    while (
      this.authed &&
      this.ws &&
      this.ws.readyState === WebSocket.OPEN &&
      this.pending.length
    ) {
      try {
        this.ws.send(JSON.stringify(this.pending.shift()));
      } catch (err) {
        reportError(
          "Failed to flush queued email WebSocket message",
          err,
          "emailSendFailed"
        );
        break;
      }
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
// Queued-requests badge on every page (scripts are deferred: body exists).
initOutboxUi();
