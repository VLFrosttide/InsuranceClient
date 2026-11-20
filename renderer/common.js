"use strict";

// Shared helpers for the InsuranceClient renderer.
// Load this file before any page-specific logic script.

// API host. The value is defined once in config.js (API_DOMAIN) and handed over
// by renderer/preload.js. Never hardcode a domain here - the fallbacks below
// only apply when common.js runs outside the Electron shell (unit tests, a
// plain-browser preview).
const FALLBACK_API_BASE = "https://bulsig.online";
const FALLBACK_WS_URL = "wss://bulsig.online/ws";

const BridgeConfig = (typeof window !== "undefined" && window.bridge) || {};

const API_BASE = String(BridgeConfig.ApiBase || FALLBACK_API_BASE).replace(
  /\/+$/,
  ""
);
const WS_URL = String(BridgeConfig.WsUrl || FALLBACK_WS_URL).replace(/\/+$/, "");

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
    // Labels of the eye button in a password field. The label names the action
    // the click performs: "Show password" while the field is still masked.
    showPassword: "Show password",
    hidePassword: "Hide password",
    enterCredentials: "Enter username and password",
    accessDenied: "Access Denied",
    sessionExpired: "Session expired",
    serverError: "Server Error",
    blockedBeforeServer:
      "The request was blocked before reaching the server (hosting firewall, antivirus or network proxy)",
    "net.connected": "Connected",
    "net.offline": "Offline",
    "net.checking": "Checking…",
    "net.slow": "Slow connection",
    "login.retrying": "Server unreachable — retrying…",
    "login.retryingSlow": "The server is slow — retrying…",
    "login.signingIn": "Signing in…",
    "login.waitingServer": "Waiting for the server…",
    "login.offline": "No connection — the server is unreachable",
    "login.success": "Login successful — loading…",
    "login.elapsed": "{seconds} s",
    // Terminal outcomes that are not an answer from the API. A slow server, a
    // network with no answer at all, a captive portal and an incomplete answer
    // are different problems and must not all read "Server Error".
    "login.timeout":
      "The server did not answer in time — your login may already have been accepted. Please try again.",
    "login.networkFailed":
      "No answer from the server — check the network connection and try again.",
    "login.noToken":
      "The server's answer was incomplete — please try again.",
    // The login request carries the branch, and the server refuses a branch that
    // was disabled or renamed. Say when the dropdown could not be confirmed.
    "login.branchListUnverified":
      "The branch list could not be loaded from the server, so the selected branch may be out of date.",
    branchChanged:
      "Your branch “{from}” is no longer available; using “{to}”.",
    // A forced logout (expired or replaced token) explains itself on the form.
    "login.replaced":
      "Your login was replaced by a newer one. Please sign in again.",
    logout: "Logout",

    "nav.dashboard": "Dashboard",
    "nav.users": "Users",
    "nav.branches": "Branches",
    "nav.insurances": "Insurances",
    "nav.insurancesByDate": "Insurances by date",
    "nav.currentCash": "Current cash",
    "nav.reconcile": "Reconcile daily report",
    "nav.diagnostics": "Diagnostics",
    settingsSaved: "Setting saved",

    // Admin > Diagnostics: the failed requests recorded on every client PC.
    "diag.title": "Client diagnostics",
    "diag.hint":
      "Failed requests recorded on the PCs (403s and the first successful request after them), uploaded as soon as the client can reach the server. They stay here until you delete them.",
    "diag.collect": "Data collection",
    "diag.collectToggle": "Gather client diagnostics",
    "diag.collectHint":
      "Switches data gathering on or off for every PC. While it is off, uploads are answered but nothing is stored: the clients drop their queued reports instead of retrying. Reports already stored stay readable.",
    "diag.collectingOn": "Gathering is on",
    "diag.collectingOff": "Gathering is off - new reports are discarded",
    "diag.refresh": "Refresh",
    "diag.download": "Download JSON",
    "diag.clear": "Delete all",
    "diag.clearConfirm":
      "Delete every stored client report? Download them first if you still need them.",
    "diag.deleted": "Deleted {n} report(s)",
    "diag.empty": "No client reports stored yet.",
    "diag.failures": "Failures",
    "diag.recoveries": "Recoveries",
    "diag.withRequestId": "With request id",
    "diag.total": "Stored reports",
    "diag.clients": "Clients",
    "diag.forbidden": "403",
    "diag.all": "All statuses",
    "diag.only403": "Only 403",
    "diag.status": "Status",
    "diag.kind": "Kind",
    "diag.client": "Client",
    "diag.requestId": "Request id",
    "diag.uploadIp": "Upload IP",
    "diag.captured": "Captured",
    "diag.details": "Report details",
    "diag.serverContext": "How the server sees a request",
    "diag.observedIp": "Observed IP",
    "diag.forwardedFor": "X-Forwarded-For",
    "diag.realIp": "X-Real-IP",
    "diag.proxy": "Trust proxy",
    "diag.authPolicy": "Authentication",
    "diag.rateLimits": "Rate limits",
    "diag.ipAllowList": "IP allow list",
    "diag.polling": "Busiest IP/path in the last minute",
    "diag.recentFailures": "Server-side failures",
    "diag.localQueue": "Local queue on this PC",
    "diag.flushNow": "Upload now",
    "diag.flushed": "Uploaded {n} report(s)",
    "diag.queueEmpty": "Nothing queued on this PC",
    "diag.copied": "Copied",
    "diag.copy": "Copy JSON",
    "diag.noContext": "Server context unavailable",
    "diag.paired": "Paired with",
    "reconcile.title": "Reconcile daily report",
    "reconcile.dropHint": "Drop the daily report (Excel file) here",
    "reconcile.dropHint2": "or click to choose a file",
    "reconcile.noFile": "No file selected",
    "reconcile.run": "Reconcile",
    "reconcile.dbDate": "Check database insurances created from",
    "reconcile.dbDateTo": "to",
    "reconcile.dbDateHint":
      "Used to find insurances that exist in the database but are missing from the file. An empty date leaves that end of the range open; clear both to skip that check.",
    "reconcile.brokerHint":
      "Only the insurances of the broker typed here are checked; leave it empty to check every broker.",
    "reconcile.endNote":
      "Valid-until is compared with Starting date + Duration (days).",
    "reconcile.invalidFile": "Please choose an Excel file (.xlsx, .xlsm, etc.)",
    "reconcile.columnsNotFound": "Required columns not found in the file",
    "reconcile.fileRows": "Rows in file",
    "reconcile.matched": "Fully matching",
    "reconcile.missingFromDb": "Missing from database",
    "reconcile.missingFromFile": "Missing from file",
    "reconcile.mismatches": "Partial data mismatch",
    "reconcile.fileValue": "File",
    "reconcile.dbValue": "DB",
    "reconcile.row": "File row",
    "reconcile.allGood": "Everything matches.",
    "reconcile.cardHint": "Click to jump to the matching table",
    "reconcile.col.policy": "Policy number",
    "reconcile.col.blank": "Blank No.",
    "reconcile.col.from": "Starting date",
    "reconcile.col.to": "Valid until",
    "reconcile.col.car": "Car number",
    "reconcile.col.duration": "Duration",
    "reconcile.col.price": "Price",
    "reconcile.hintTitle": "Columns the daily report must have",
    "reconcile.hintIntro":
      "Only the first worksheet is read. The header row may sit anywhere in the first 50 rows, and header names are matched ignoring case, spaces and punctuation. Duration and Price are optional: a report without those columns is still reconciled, the field is just not compared.",
    "reconcile.hintRequired":
      "Only the fields ticked under Compare are required: unticking one lets a report without that column reconcile the rest. Duration and Price stay optional even when ticked.",
    "reconcile.hintField": "Field",
    "reconcile.hintHeaders": "Accepted header names",
    "reconcile.hintComparedWith": "Compared with",
    "reconcile.hintLayouts":
      "Two layouts are accepted - full: НОМЕР НА ПОЛИЦА, НОМЕР НА СТИКЕР, ВАЛИДЕН ОТ, ВАЛИДЕН ДО, ДКН; shift log: № ПОЛИЦА, № БЛАНКА, ДАТА, СРОК, ДКН.",
    "reconcile.hintTerms":
      "Valid until is either the date in ВАЛИДЕН ДО or is calculated from СРОК: 15D = 15 days, 1M = 30, 3M = 90, 1Y = 365. The same СРОК column is compared with the policy's duration and the ЦЕНА column with its price. Price is compared as a number only - the currency type is never compared.",
    "reconcile.hintDates":
      "Dates may be real Excel dates or text as 05.10.2026, 05/10/2026 or 2026-10-05. A \"BG/02/FI\" prefix in front of the policy number is ignored.",
    "reconcile.compareFields": "Compare:",
    "reconcile.compareToggleHint":
      "Switch a field off to stop its differences from counting as mismatches. The choice is remembered on this computer.",
    "reconcile.notCompared": "Not compared",

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

    "presence.none": "No workers online",
    "presence.online": "Online",
    "presence.working": "Working",
    "presence.afk": "Away",

    balance: "Balance",
    currentCash: "Current cash",
    currentCashHint:
      "Available cash is the cash actually in the drawer, derived from the policies: the walk-in cash policies of the open shift plus manual increases, minus expenses and hand-overs. Card payments, email payments funded by a broker balance and money handed over by brokers (cash from brokers) are tracked separately. Correcting a policy changes the drawer by exactly its new price - it never leaves a transaction behind.",
    cardBalance: "Card balance",
    users: "Users",
    brokers: "Brokers",
    brokersHint:
      "Row and cell colours: dark red row = the broker has no email address; light pink balance = the balance is negative; dark red Inactive cell = fewer than 30 blancs are left. Admins can cut a broker off at any time with the Cut off button, which blocks new insurances for that broker.",
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
    branches: "Branches",
    newBranch: "New branch",
    branchName: "Branch name",
    branchEnabled: "Enabled",
    branchDisabled: "Disabled",
    branchCreated: "Branch created",
    branchUpdated: "Branch updated",
    createBranch: "Create branch",
    editBranch: "Edit branch",
    enable: "Enable",
    disable: "Disable",
    brokerName: "Broker",
    mainBroker: "Main broker",
    brokerAllowNegative: "Accept broker requests with negative balance",
    brokerAllowNegativeHint:
      "When off, broker requests that would push the balance below zero are rejected, and emails from brokers with a negative balance are not shown.",
    cutOff: "Cut off",
    brokerCutOff: "Cut off",
    brokerCutOffRestore: "Re-enable",
    brokerCutOffHint: "Block new insurances for this broker",
    brokerCutOffSet: "Broker cut off — new insurances are blocked",
    brokerCutOffRestored: "Broker re-enabled — new insurances are allowed again",
    brokerNameFilterHint: "Click to filter the brokers by name",
    brokerNameFilterPlaceholder: "Filter by name…",
    brokerNameFilterClear: "Clear the name filter",
    brokerNameNoMatches: "No brokers match “{q}”.",
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
    expense: "Expense",
    handOver: "Hand over",
    handedTo: "Received by",
    handedToPlaceholder: "Name of the person who took the money",
    resetTo0: "End shift",
    amount: "Amount",
    reason: "Reason",
    type: "Type",
    user: "User",
    created: "Created",
    transactions: "Transactions",
    annulments: "Annulments",
    active: "Active",
    resets: "Resets",
    back: "Back",
    previous: "Previous",
    next: "Next",
    pageOf: "Page {page} of {total}",
    brokerHistory: "Balance history",
    brokerHistoryBalanceHint:
      "The broker's balance at the end of the shown range. Pick a date to see the balance on that day; the history goes all the way back to the first movement.",
    startingBalance: "Starting balance",
    startingBalanceNotSet: "Not set",
    startingBalanceDate: "Starting balance date",
    startingBalanceHint:
      "The broker's balance before the first insurance was created. Saving it recalculates the broker's balance from all of its insurances (an annulled one at its annulment tax) and all of its payments (top-ups and hand-overs).",
    startingBalanceSaved:
      "Starting balance saved — the broker balance has been recalculated",
    balanceAtDayEnd: "Balance at the end of the day",
    balanceAtDayEndHint:
      "The broker's balance when the shown day ended: the starting balance plus every payment, minus every insurance up to that moment.",
    balanceAfter: "Balance after",
    netChange: "Change",
    total: "Total",
    "movement.policy": "Policy",
    "movement.annulment": "Annulment",
    "movement.deletion": "Deletion",
    "movement.price_change": "Price change",
    "movement.increase": "Increase",
    "movement.reduce": "Reduce",
    "movement.adjust": "Adjustment",
    "movement.handover": "Hand over",
    myProfile: "My Profile",
    myInsurances: "My Insurances",

    author: "Author",
    date: "Date",
    previousDay: "Previous day ({date})",
    nextDay: "Next day ({date})",
    load: "Load",
    clear: "Clear",
    searchCriteriaRequired:
      "Enter at least one search criteria (author, date, policy number, blank number, car number, broker, broker ID, payment or annulled)",
    searching: "Searching…",
    searchFound: "Found {n} insurances.",
    searchNoResults: "No insurances found.",
    searchUnchanged: "Search complete — results unchanged.",
    blankNo: "Blank No.",
    client: "Client",
    price: "Price",
    currency: "Currency",
    payment: "Payment",
    broker: "Broker",
    brokerId: "ID",
    brokerIdFilter: "Broker ID",
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
    userRestored: "User restored",
    deleteUserConfirm:
      "Delete user {u}? The account is kept in the database and an admin can restore it, but it can no longer sign in.",
    restoreUserConfirm:
      "Restore user {u}? The account can sign in and will appear in the users list again.",
    deletedUsers: "Deleted users",
    userCreated: "User {u} created",
    registrationFailed: "Registration failed",
    currentCashIncreased: "Current cash increased",
    currentCashReduced: "Current cash reduced",
    cashHandedOver: "Cash handed over",
    recordExpense: "Record an expense",
    handOverCash: "Hand over cash",
    handoverStats: "Hand over statistics",
    handoverStatsHint:
      "Money handed to a person and not yet back in a drawer or the company bank. The figures cover every branch and every broker; the list under the day picker names the branch of each hand-over of that day.",
    handoverGroupHandedOver: "Handed over",
    handoverGroupReturns: "Returns and undos",
    handoverGroupOutstanding: "Still handed over",
    handedOverFromDrawer: "From office drawer",
    handedOverFromDrawerHint:
      "Cash hand-overs recorded with the Hand over button (money physically given to a person).",
    handedOverFromBrokerBalance: "From broker balance",
    handedOverFromBrokerBalanceHint:
      "Broker hand-overs recorded in a broker's balance history (the broker paid the owner directly).",
    returnedToDrawer: "Returned to office drawer",
    returnedToDrawerHint:
      "Undone hand-overs whose money was put back into a branch's available cash.",
    returnedToBank: "Returned to company bank account",
    returnedToBankHint:
      "Undone hand-overs sent straight to the company bank; no drawer was touched.",
    handoverUndone: "Undone hand-overs",
    handoverUndoneHint:
      "Hand-over entries deleted from their ledger (cash and broker balance). Their money was already reversed.",
    handoverCashOutstanding: "Cash still handed over",
    handoverCashOutstandingHint:
      "Live cash hand-overs minus the amounts already returned to a drawer or the bank.",
    handoverBalanceOutstanding: "Broker balance still handed over",
    handoverBalanceOutstandingHint:
      "Live broker hand-overs. They are undone from the broker's balance history.",
    handedOverCashSection: "Handed over cash",
    handedOverCashDayHint:
      "Only the hand-overs recorded on the picked day are listed. Pick another day to see (or undo) an older one.",
    handoverReturn: "Returned hand over",
    handoverReturnedAmount: "Returned",
    handoverRemaining: "Remaining",
    undoHandover: "Undo hand over",
    undoHandoverTitle: "Undo hand over #{i}",
    undoHandoverDestination: "Where the money goes",
    undoHandoverDrawer: "Office drawer (increases available cash)",
    undoHandoverBank: "Company bank account (no drawer change)",
    undoHandoverReason: "Note (optional)",
    undoHandoverSubmit: "Return money",
    handoverReturnedToDrawer: "Returned to the office drawer",
    handoverReturnedToBank: "Returned to the company bank account",
    expenseRecorded: "Expense recorded",
    currentCashReset: "Current cash, card balance and cash from brokers reset",
    transactionUpdated: "Transaction updated",
    editTransaction: "Edit transaction",
    deleteTransaction: "Delete transaction",
    deleteTransactionConfirm:
      "Delete transaction #{i} ({t} {a} {c} - {r})? It is kept in the database but hidden from the ledger, and its money is reversed on the drawer.",
    transactionDeleted: "Transaction deleted",
    resetConfirm:
      "Reset this branch's current cash, card balance and cash from brokers to 0? This will record the kept amounts.",
    fixShift: "Fix forgotten shift",
    fixShiftTitle: "Close a forgotten shift",
    fixShiftHint:
      "The shift closes at the end of the selected day (23:59:59, midnight). The cash drawer, the card balance and Cash from Brokers are split from their movement times: the amount each held at midnight is recorded as the closed shift, and everything recorded after midnight — today's insurances included — stays in the live balances.",
    fixShiftDate: "Shift date",
    fixShiftSubmit: "Close shift at midnight",
    fixShiftConfirm:
      "Close the shift of {date} at {cutoff}?\n\nKept by the closed shift:\nCash: {keptCash}\nCard: {keptCard}\nCash from brokers: {keptBroker}\n\nStays in the live balances:\nCash: {remainCash}\nCard: {remainCard}\nCash from brokers: {remainBroker}",
    fixShiftDone:
      "Shift of {date} closed at midnight — kept {keptCash} cash, {keptCard} card, {keptBroker} broker cash",
    fixShiftInvalid: "Enter a valid shift date.",
    fixShiftFuture: "The shift end must be in the past.",
    fixShiftAlreadyClosed:
      "A shift has already been closed at or after this cutoff. Use the normal End shift instead.",
    fixShiftCashBelow:
      "Today's cash is below the midnight balance for {currency}. Nothing was changed — use the normal End shift.",
    fixShiftCutoffNegative:
      "The cash balance at the cutoff is negative for {currency}. Nothing was changed.",
    fixShiftBrokerBelow:
      "Cash from brokers is below the midnight balance for {currency}. Nothing was changed.",
    shiftMissedWarning:
      "No End shift is recorded for {date}. If an employee forgot to finish that shift, close it now so the day's report is correct.",
    "shiftReminder.title": "Shift ends in 5 minutes",
    "shiftReminder.body":
      "Remember to finish your shift before midnight: open Current cash and press “End shift”.",
    "shiftReminder.remaining": "Time until midnight: {time}",
    "shiftReminder.overdue":
      "Midnight has passed — please finish last night's shift now.",
    "shiftReminder.endShift": "Finish shift",
    "shiftReminder.dismiss": "Dismiss",
    "shiftReminder.leaveFormConfirm":
      "Leave this page? Anything not saved on the insurance form will be lost. Open Current cash to finish the shift?",
    brokerBalanceIncreased: "Broker balance increased",
    brokerBalanceReduced: "Broker balance reduced",
    brokerHandoverRecorded: "Hand over recorded",
    brokerCreated: "Broker created",
    brokerUpdated: "Broker updated",
    brokerDeleted: "Broker deleted",
    brokerRestored: "Broker restored",
    deleteBrokerConfirm:
      "Delete broker {b}? It is kept in the database and an admin can restore it, but it disappears from the lists and its emails are no longer shown. Its balance, blancs and policies are untouched.",
    restoreBrokerConfirm:
      "Restore broker {b}? It will appear in the lists again with the balance and blancs it kept.",
    deletedBrokers: "Deleted brokers",
    editMovement: "Edit movement",
    deleteMovement: "Delete movement",
    movementUpdated: "Movement updated",
    movementDeleted: "Movement deleted",
    movementRestored: "Movement restored",
    deletedMovements: "Deleted movements",
    deleteMovementConfirm:
      "Hide this balance movement? It is kept in the database and can be restored; its amount is added back to the broker's balance.",
    restoreMovementConfirm:
      "Restore this balance movement? Its amount is applied to the broker's balance again.",
    exportFailed: "Export failed",
    balanceUpdated: "Balance updated",
    settingSaved: "Setting saved",
    setBalanceFor: "Set balance for",
    deleteConfirm: "Delete",
    emailClaimed: "This email was already opened by another worker",
    emailConnUnavailable: "Email connection unavailable",
    emailClaimTimeout: "The server did not respond. Please try again.",
    emailSendFailed: "Failed to send email",
    emailReplyQueued: "Reply email is being re-tried automatically",
    emailReplyQueuedTo: "Reply email to {email} is being re-tried automatically",
    emailReplyFailed: "Reply email could not be sent",
    emailReplyFailedTo: "Reply email to {email} could not be sent",
    name: "Name",
    rangeStart: "Range start",
    rangeEnd: "Range end",
    inactive: "Inactive",
    blancBatches: "Blanc batches",
    addBatch: "+ Add batch",
    blancCount: "Blancs",
    blancUsed: "Used",
    blancSummary: "{t} blancs in all batches · {u} used · {i} inactive",
    deleteBatchConfirm: "Delete blanc batch {s}–{e}?",
    batchAdded: "Blanc batch added",
    batchUpdated: "Blanc batch updated",
    batchDeleted: "Blanc batch deleted",
    autoBatchHint:
      "Added automatically: this blanc was outside the broker's batches",
    kept: "Kept",
    cardPayments: "Card payments",
    paymentType: "Payment method",
    "payment.Cash": "Cash",
    "payment.Card": "Card",
    "payment.Broker": "Broker balance",
    "payment.cardCash": "Card + cash",
    clearBalance: "Clear balance",
    clearCardBalanceConfirm:
      "Clear the card balance to 0? This will record the kept amount.",
    cardBalanceCleared: "Card balance cleared",
    cardBalanceTotal: "Card balance (all branches)",
    cashFromBrokers: "Cash from brokers",
    cashFromBrokersHint:
      "Money brokers handed over at this branch since its last reset. It is kept apart from the available cash, which no longer grows when a broker balance is increased.",
    unassignedBranch: "(no branch)",

    dailyReport: "Daily report",
    drawers: "Drawers",
    insuranceNumberStatistics: "Insurance number statistics",
    insuranceMoneyStatistics: "Insurance money statistics",
    manualBrokerIncreases: "Manual cash increases to brokers balance",
    manualBrokerIncreasesHint:
      "Money brokers handed over on this day (manual top-ups of a broker balance). Refunds of annulled insurances are not counted.",
    balanceFromBrokerInsurances: "Balance from broker insurances",
    balanceFromBrokerInsurancesHint:
      "Money funded from a broker's balance by the policies created on this day.",
    balanceFromWalkInsCash: "Balance from walk-ins cash",
    balanceFromWalkInsCashHint:
      "The price of the walk-in policies paid in cash on this day (annulled ones count with their annulment fee).",
    balanceFromWalkInsCard: "Balance from walk-ins card",
    balanceFromWalkInsCardHint:
      "The price of the walk-in policies paid by card on this day (annulled ones count with their annulment fee).",
    lastPayment: "Last payment",
    totalInsurances: "Total insurances",
    brokerInsurances: "Broker insurances",
    walkInInsurances: "Walk-in insurances",
    totalDailyBalance: "Total daily balance",
    totalDailyBalanceHint:
      "The price of every insurance created on this day, whatever the payment type - cash, card or a broker's balance. It is the sum of the three figures below.",
    availableCash: "Available cash",
    availableCashBranch: "Available cash ({branch})",
    availableCashHint:
      "The branch's cash drawer at the end of the selected day: the walk-in cash policies of its current shift plus manual increases, minus expenses and hand-overs. Walking the dates back shows how much cash the branch actually had available then.",
    countryWideInsurances: "Country-wide insurances",
    countryWideInsurancesHint:
      "The range of policy numbers issued in the country on this day: the highest number minus the lowest. The policies listed below set the ends of that range, so a mistyped or out-of-series number at either end changes the figure.",
    countryWideFromPolicy: "From policy",
    countryWideToPolicy: "To policy",
    countryWideSinglePolicy: "Only policy",
    cardPaymentsHint:
      "Card payments collected at this branch on this day.",
    cardBalanceHint:
      "This branch's live card balance: the walk-in card policies since its last reset (an “End shift” clears it together with the drawer).",
    cardInsurances: "Walk-in card insurances",
    cardInsurancesHint:
      "Walk-in policies paid by card at this branch on the selected day. The Card balance card opens this list.",
    brokerBalanceTotal: "Broker balance total",
    brokerBalanceTotalHint:
      "Money funded from a broker's balance at this branch on this day (email policies).",
    totalCashFromBrokers: "Total cash from brokers",
    totalCashFromBrokersHint:
      "Money brokers handed over on this day (broker balance top-ups). Refunds of annulled insurances are not counted.",
    transactionsCashFromBrokers: "Transactions cash from brokers",

    expenses: "Expenses",
    totalExpenses: "Total expenses",
    expensesHint:
      "Money spent from this branch's drawer on this day (the entries recorded with the “Expense” button). Refunds of annulled or deleted insurances reduce the drawer too, but they are policy movements, not money the branch spent, so they are not counted here. Cash handed over to a person (the “Hand over” button) is not counted either: it left the drawer, but the branch did not spend it.",

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
    annulFeeAdminNote: "Admins can type a different fee.",
    annulFeeInvalid: "Fee must be a non-negative number.",
    annulConfirmTitle: "Annul insurance",
    annulSubmit: "Annul insurance",
    insuranceAnnulled: "Insurance annulled",
    alreadyAnnulled: "Already annulled",

    deleted: "Deleted",
    deletedBy: "Deleted by",
    includeDeleted: "Include deleted",
    annulledFilter: "Annulled",
    totalIncludingAnnulled: "Total (including annulled tax)",
    deleteInsuranceConfirm: "Delete insurance {b}? It will be kept in the database but hidden from lists and reports.",
    deleteInsurance: "Delete insurance",
    insuranceDeleted: "Insurance deleted",
    restore: "Restore",
    restoreInsuranceConfirm: "Restore insurance {b}? Its money and broker balance will be reapplied and it will reappear in lists and reports.",
    insuranceRestored: "Insurance restored",

    "add.back": "← Dashboard",

    "add.title": "Add Insurance",
    "addAdmin.title": "Add Insurance (admin)",
    "addAdmin.creationDate": "Creation date",
    "addAdmin.creationDateRequired": "Creation date is required",
    "addAdmin.broker": "Broker",
    "addAdmin.brokerNone": "— No broker (walk-in) —",
    "addAdmin.brokerNote":
      "Paid from the selected broker's balance. The broker balance will be reduced for the chosen creation date.",
    "addAdmin.brokersLoadFailed": "Failed to load the broker list",
    "add.policyNumber": "Policy number",
    "add.blancNumber": "Blank number",
    "add.carNumber": "Car number",
    "add.carNumberRequired": "Car number is required",
    "add.policyNumberRequired": "Policy number is required",
    "add.blancNumberRequired": "Blank number is required",
    "add.policyNumberLength": "Policy number must be exactly 8 characters",
    "add.blancNumberLength": "Blank number must be exactly 6 characters",
    "add.duration": "Duration",
    "add.branch": "Branch",
    "add.vehicleType": "Vehicle type",
    "add.startDate": "Starting date",
    "add.startDateRequired": "Starting date is required",
    "add.price": "Price",
    "add.priceUnavailable":
      "There is no tariff for this vehicle type and duration - the policy cannot be saved.",
    "add.priceLoading": "The price is still loading - try again in a moment.",
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
    "add.blancOutsideBatchesConfirm":
      "This blank number is not in any of the broker's blank batches. Create the insurance anyway? The blank will be added to the broker's batches and shown in pink.",
    "add.dropArea": "Drop files here",
    "add.dropAreaHint": "or click to choose files",
    "add.attachedFiles": "Attached files",
    "add.removeFile": "Remove",
    "add.printFile": "Print",
    "add.printSuccess": "Sent to printer",
    "add.printFailed": "Printing failed",
    "add.reply": "Reply",
    "add.replyPlaceholder": "Type your reply…",
    "add.replyButton": "Send reply",
    "add.replyConfirm": "Send this reply to the original sender?",
    "add.replySent": "Reply sent",
    "add.replyEmpty": "Type a reply first",
    "add.attachmentsRequired":
      "Attach at least one file before saving an email policy. The return email cannot be sent without attachments.",
    "add.replyFailed": "Insurance saved, but the return email failed: {e}",
    "add.desktopPdfAttached": "Policy PDF attached from the Desktop.",
    "add.emailLost":
      "This email is no longer reserved for you: it was taken by another worker or handled while you were disconnected.",
    "add.conversationHistory": "Conversation",
    "add.conversationEmpty": "No replies yet.",
    "add.conversationLoading": "Loading conversation…",
    "add.conversationUnavailable":
      "The older conversation could not be loaded; the quoted emails and your replies are shown below.",
    "add.messageFromBroker": "Client",
    "add.messageFromEmployee": "Employee",

    "email.noSubject": "(no subject)",
    "email.from": "From:",
    "email.date": "Date:",
    "email.emptyBody": "(empty body)",
    "email.reply": "Reply",
    "email.forward": "Forwarded",
    "email.threadCount": "{n} emails",
    "email.replyCount": "{n} replies",
    "email.replyCountOne": "1 reply",
    "email.arrived": "Arrived {t}",
    "email.waitingNow": "just now",
    "email.waitingMin": "{n} min ago",
    "email.waitingHours": "{h} h {m} min ago",
    "email.overdue": "Waiting over 10 minutes",
    "email.latestMessage": "Latest message",
    "email.earlierMessage": "Earlier email #{n}",
    "email.attachments": "Attachments",
    "email.noAttachments": "No attachments.",
    "email.attachment": "attachment",
    "email.downloading": "Downloading… {percent}%",
    "email.downloadingUnknown": "Downloading…",
    "email.downloadRetrying": "Connection lost — retrying…",
    "email.downloaded": "Downloaded",
    "email.zoomIn": "Zoom in",
    "email.zoomOut": "Zoom out",
    "email.resetZoom": "Reset zoom",
    "email.rotateLeft": "Rotate left",
    "email.rotateRight": "Rotate right",
    "email.print": "Print picture",
    "email.printSuccess": "Picture sent to printer",
    "email.printCancelled": "Printing cancelled",
    "email.printFailed": "Printing failed",
    "email.close": "Close",
    "email.markIrrelevant": "Mark as irrelevant",
    "email.irrelevantConfirm":
      "Mark this email as irrelevant? It will be removed and will not appear again.",
    "email.irrelevantMarked": "Email marked as irrelevant",
    "email.opening": "Opening…",
    "email.brokerCodeTitle": "Broker code",
    "email.answered": "Answered",
    "email.answeredSection": "Answered — awaiting broker reply",
    "email.lowPrioritySection":
      "Low priority — answered, awaiting broker reply",
    "email.lowPriorityAwaiting": "low priority · awaiting broker",
    "email.lowPriorityHidden":
      "{n} low-priority conversation(s) hidden until the client answers.",
    "email.answeredAt": "Answered {t}",
    "email.awaitingBroker": "awaiting broker",
    "email.allAnswered": "All caught up — waiting for the brokers.",
    "email.searchPlaceholder": "Search emails…",
    "email.searchClear": "Clear search",
    "email.searchNoResults": "No emails match “{q}”.",

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
    // Auto-update banner (renderUpdateBanner below).
    "update.downloading": "Downloading update {version}… {percent}%",
    "update.downloadingUnknown": "Downloading update {version}…",
    "update.unknownVersion": "a new version",
    "update.ready": "Update {version} is ready to install",
    "update.readyHint":
      "Restart to apply it now, or it will be installed when the app is closed.",
    "update.restartNow": "Restart now",
    "update.later": "Later",
    "update.restarting": "Restarting…",
    "update.restartFailed":
      "Could not restart — close and open the app manually to apply the update.",
    // Server error messages (mapped to translation keys in translateError below).
    "err.invalidCredentials": "Invalid username or password",
    "err.usernamePasswordRequired": "Username and password are required",
    "err.usernameLength": "Username must be at least 2 characters",
    "err.passwordLength": "Password must be at least 6 characters",
    "err.accountSuspended": "Account suspended",
    "err.accountDeleted": "Account deleted",
    "err.branchDisabled": "This branch is disabled",
    "err.branchExists": "A branch with this name already exists",
    "err.branchNameRequired": "Branch name is required",
    "err.branchNameLength": "Branch name must be 100 characters or fewer",
    "err.branchNotFound": "Branch not found",
    "err.accessDeniedRole": "Access denied: unknown role",
    "err.usernameExists": "Username already exists",
    "err.blancExists": "An insurance with this blank number already exists",
    "err.blancOutsideBrokerBatches":
      "This blank number is not in any of the broker's blank batches",
    "err.blancBelongsToAnotherBroker":
      "This blank number is in another broker's blank batches ({broker}). Change the blank number to save the insurance.",
    "err.insuranceNotFound": "Insurance not found",
    "err.cannotModifyDeleted": "A deleted insurance cannot be modified",
    "err.cannotAnnulDeleted": "A deleted insurance cannot be annulled",
    "err.alreadyAnnulled": "Insurance already annulled",
    "err.notAnnulled": "Insurance is not annulled",
    "err.onlyAdminAnnulFault":
      "Only admins can change the fault of an annulled insurance",
    "err.onlyAdminRestoreAnnul":
      "Only admins can restore an annulled insurance",
    "err.onlyAdminAuthor": "Only admins can change the author of an insurance",
    "err.onlyAdminBroker": "Only admins can change the broker of an insurance",
    "err.brokerChangeAnnulled":
      "The broker of an annulled insurance cannot be changed",
    "err.authorRequired": "The author is required",
    "err.authorNotFound": "Author not found",
    "err.emailBrokerOnly": "Email policies are paid from the broker balance only",
    "err.onlyEmailBroker": "Only email policies can be paid from a broker balance",
    "err.nonTurkWalkInOnly": "The non-Turk tax only applies to walk-in policies",
    "err.senderNotBroker": "The email sender is not linked to a broker",
    "err.brokerNegativeBalance":
      "Broker request rejected: the broker balance would go negative",
    "err.brokerCutOff":
      "Broker is cut off; new insurances cannot be created until the broker is re-enabled",
    "err.payerInvalid": "The fee payer must be 'broker', 'worker' or 'none'",
    "err.dateFormat": "Date must be in YYYY-MM-DD format",
    "err.creationDateFormat": "Creation date must be in YYYY-MM-DD HH:MM:SS format",
    "err.insufficientCash": "Insufficient cash for the reduction",
    "err.invalidDuration": "Invalid duration",
    "err.invalidVehicleType": "Invalid vehicle type",
    "err.userNotFound": "User not found",
    "err.userNotDeleted": "The user is not deleted",
    "err.brokerNotFound": "Broker not found",
    "err.brokerNotDeleted": "The broker is not deleted",
    "err.brokerDeleted": "This broker is deleted and has to be restored first",
    "err.clientNotFound": "Client not found",
    "err.transactionNotFound": "Transaction not found",
    "err.transactionAlreadyDeleted": "The transaction is already deleted",
    "err.blancBatchNotFound": "Blanc batch not found",
    "err.cannotDeleteSelf": "You cannot delete your own account",
    "err.cannotDeleteAdmin": "An admin account cannot be deleted",
    "err.cannotSuspendAdmin": "An admin account cannot be suspended",
    "err.cannotChangeAdminRole": "The role of an admin cannot be changed",
    "err.ownTransactionsOnly": "You can only edit your own transactions",
    "err.accountNotBroker": "This account is not linked to a broker",
    "err.ownBrokerOnly": "You can only view your own broker",
    "err.statusInvalid": "Status must be 'active' or 'suspended'",
    "err.roleInvalid": "Role must be 1, 2 or 3",
    "err.nameEmpty": "Name cannot be empty",
    "err.nameRequired": "Name is required",
    "err.usernameRequired": "Username is required",
    "err.bodyTextRequired": "Reply text is required",
    "err.amountPositive": "Amount must be a positive number",
    "err.balanceNonNegative": "Balance must be a non-negative number",
    "err.priceNonNegative": "Price must be a non-negative number",
    "err.durationPositive": "Duration must be a positive number",
    "err.brokerIdInvalid": "Broker must be a valid identifier",
    "err.brokerNameExists": "A broker with this name already exists",
    "err.tariffFieldsRequired": "Vehicle type, duration and price are required",
    "err.pricingFormat": "Invalid pricing data format",
    "err.tariffsRequired": "At least one tariff is required",
    "err.typeInvalid": "Type must be 'increase' or 'reduce'",
    "err.cashTypeInvalid": "Type must be 'increase', 'reduce' or 'handover'",
    "err.usernameBalanceRequired": "Username and balance are required",
    "err.noBatch": "No batch given",
    "err.rangeRequired": "Range start and end are required",
    "err.rangeOrder": "Range end must be greater than or equal to range start",
    "err.rangeTooLarge": "Range start / end is too large",
    "err.rangeWhole": "Range start and end must be non-negative whole numbers",
    "err.nothingToUpdate": "Nothing to update",
    "err.partInvalid": "Part must be 'CardPart' or 'BrokerPart'",
    "err.reasonRequired": "Reason is required",
    "err.recipientRequired": "Enter who received the money",
    "err.handoverReturnTooMuch":
      "The amount is more than what is still handed over",
    "err.handoverAlreadyReturned":
      "This hand-over has already been fully returned",
    "err.handoverHasReturns":
      "A hand-over that has been (partly) returned cannot be deleted; undo the remaining amount instead",
    "err.handoverReturnLocked":
      "A hand-over return cannot be edited or deleted",
    "err.notHandover": "This entry is not a cash hand-over",
    "err.handoverDeleted": "A deleted hand-over cannot be returned",
    "err.amountBelowReturned": "The amount is below what was already returned",
    "err.destinationInvalid": "Destination must be 'drawer' or 'bank'",
    "err.handoverTypeFixed":
      "A hand-over cannot be changed into an increase or an expense (or the other way round); delete the entry and record the right one instead",
    "err.sourceInvalid": "Source must be 'Card' or 'Broker'",
    "err.movementNotFound": "Balance movement not found",
    "err.movementIdInvalid": "Invalid movement id",
    "err.amountNonZero": "Amount must be a non-zero number",
    "err.typeEmpty": "Type cannot be empty",
    "err.movementAlreadyDeleted": "Movement is already deleted",
    "err.movementNotDeleted": "Movement is not deleted",
    "err.failedLoadInsurances": "Failed to load insurances",
    "err.failedUpdateInsurance": "Failed to update insurance",
    "err.failedAnnullInsurance": "Failed to annul insurance",
    "err.failedCreateInsurance": "Failed to create insurance",
    errorPrefix: "Error",

  },
  bg: {
    brand: "Застрахователна конзола",
    username: "Потребителско име",
    password: "Парола",
    branch: "Клон",
    login: "Вход",
    showPassword: "Покажи паролата",
    hidePassword: "Скрий паролата",
    enterCredentials: "Въведете потребителско име и парола",
    accessDenied: "Отказан достъп",
    sessionExpired: "Сесията изтече",
    serverError: "Сървърна грешка",
    blockedBeforeServer:
      "Заявката е блокирана преди да достигне сървъра (защитна стена на хостинга, антивирус или мрежов прокси)",
    "net.connected": "Свързан",
    "net.offline": "Няма връзка",
    "net.checking": "Проверка…",
    "net.slow": "Бавна връзка",
    "login.retrying": "Сървърът е недостъпен — нов опит…",
    "login.retryingSlow": "Сървърът отговаря бавно — нов опит…",
    "login.signingIn": "Влизане…",
    "login.waitingServer": "Изчакване на сървъра…",
    "login.offline": "Няма връзка — сървърът е недостъпен",
    "login.success": "Успешен вход — зареждане…",
    "login.elapsed": "{seconds} с",
    "login.timeout":
      "Сървърът не отговори навреме — възможно е входът вече да е приет. Опитайте отново.",
    "login.networkFailed":
      "Няма отговор от сървъра — проверете връзката и опитайте отново.",
    "login.noToken":
      "Отговорът на сървъра е непълен — опитайте отново.",
    "login.branchListUnverified":
      "Списъкът с клонове не можа да се зареди от сървъра, затова избраният клон може да е остарял.",
    branchChanged:
      "Клонът „{from}“ вече не е наличен; използва се „{to}“.",
    "login.replaced":
      "Входът беше заменен от по-нов. Моля, влезте отново.",
    logout: "Изход",

    "nav.dashboard": "Табло",
    "nav.users": "Потребители",
    "nav.branches": "Клонове",
    "nav.insurances": "Застраховки",
    "nav.insurancesByDate": "Застраховки по дата",
    "nav.currentCash": "Наличен кеш",
    "nav.reconcile": "Дневен отчет",
    "nav.diagnostics": "Диагностика",
    settingsSaved: "Настройката е запазена",

    // Админ > Диагностика: неуспешните заявки, записани на всеки клиент.
    "diag.title": "Клиентска диагностика",
    "diag.hint":
      "Неуспешни заявки, записани на компютрите (403 и първата успешна заявка след тях), качени веднага щом клиентът достигне сървъра. Стоят тук, докато не ги изтриете.",
    "diag.collect": "Събиране на данни",
    "diag.collectToggle": "Събирай клиентска диагностика",
    "diag.collectHint":
      "Включва или изключва събирането на данни за всички компютри. Докато е изключено, качванията получават отговор, но нищо не се записва: клиентите изхвърлят чакащите отчети, вместо да ги опитват отново. Вече записаните отчети остават за преглед.",
    "diag.collectingOn": "Събирането е включено",
    "diag.collectingOff": "Събирането е изключено - новите отчети се изхвърлят",
    "diag.refresh": "Опресни",
    "diag.download": "Изтегли JSON",
    "diag.clear": "Изтрий всички",
    "diag.clearConfirm":
      "Да се изтрият ли всички запазени клиентски отчети? Първо ги изтеглете, ако все още са ви нужни.",
    "diag.deleted": "Изтрити {n} отчета",
    "diag.empty": "Все още няма запазени клиентски отчети.",
    "diag.failures": "Неуспешни",
    "diag.recoveries": "Възстановени",
    "diag.withRequestId": "С request id",
    "diag.total": "Запазени отчети",
    "diag.clients": "Клиенти",
    "diag.forbidden": "403",
    "diag.all": "Всички статуси",
    "diag.only403": "Само 403",
    "diag.status": "Статус",
    "diag.kind": "Вид",
    "diag.client": "Клиент",
    "diag.requestId": "Request id",
    "diag.uploadIp": "IP при качване",
    "diag.captured": "Записано",
    "diag.details": "Детайли на отчета",
    "diag.serverContext": "Как сървърът вижда заявката",
    "diag.observedIp": "Видян IP",
    "diag.forwardedFor": "X-Forwarded-For",
    "diag.realIp": "X-Real-IP",
    "diag.proxy": "Trust proxy",
    "diag.authPolicy": "Автентикация",
    "diag.rateLimits": "Ограничения на честотата",
    "diag.ipAllowList": "Списък с разрешени IP-та",
    "diag.polling": "Най-натоварени IP/път за последната минута",
    "diag.recentFailures": "Сървърни грешки",
    "diag.localQueue": "Локална опашка на този компютър",
    "diag.flushNow": "Качи сега",
    "diag.flushed": "Качени {n} отчета",
    "diag.queueEmpty": "Няма нищо в опашката на този компютър",
    "diag.copied": "Копирано",
    "diag.copy": "Копирай JSON",
    "diag.noContext": "Сървърният контекст не е наличен",
    "diag.paired": "Свързан с",
    "reconcile.title": "Дневен отчет",
    "reconcile.dropHint": "Пуснете дневния отчет (Excel файл) тук",
    "reconcile.dropHint2": "или щракнете, за да изберете файл",
    "reconcile.noFile": "Няма избран файл",
    "reconcile.run": "Сверка",
    "reconcile.dbDate": "Провери застраховки в базата, създадени от",
    "reconcile.dbDateTo": "до",
    "reconcile.dbDateHint":
      "Използва се за откриване на застраховки, които са в базата, но липсват във файла. Празна дата оставя тази страна на диапазона отворена; изчистете и двете, за да пропуснете проверката.",
    "reconcile.brokerHint":
      "Проверяват се само застраховките на въведения брокер; оставете полето празно, за да се проверяват всички.",
    "reconcile.endNote": "Валиден до се сравнява с Начална дата + Срок (дни).",
    "reconcile.invalidFile": "Моля, изберете Excel файл (.xlsx, .xlsm и др.)",
    "reconcile.columnsNotFound": "Не са намерени необходимите колони във файла",
    "reconcile.fileRows": "Редове във файла",
    "reconcile.matched": "Напълно съвпадащи",
    "reconcile.missingFromDb": "Липсват в базата",
    "reconcile.missingFromFile": "Липсват във файла",
    "reconcile.mismatches": "Частично несъответствие на данни",
    "reconcile.fileValue": "Файл",
    "reconcile.dbValue": "База",
    "reconcile.row": "Ред във файла",
    "reconcile.allGood": "Всичко съвпада.",
    "reconcile.cardHint": "Щракнете, за да отидете до съответната таблица",
    "reconcile.col.policy": "Номер на полица",
    "reconcile.col.blank": "Бланка №",
    "reconcile.col.from": "Начална дата",
    "reconcile.col.to": "Валиден до",
    "reconcile.col.car": "Номер на автомобил",
    "reconcile.col.duration": "Срок",
    "reconcile.col.price": "Цена",
    "reconcile.hintTitle": "Колони, които дневният отчет трябва да съдържа",
    "reconcile.hintIntro":
      "Чете се само първият лист. Редът със заглавията може да е навсякъде в първите 50 реда, а заглавията се сравняват без значение от главни и малки букви, интервали и пунктуация. Срок и Цена са незадължителни: отчет без тези колони пак се сверява, полето просто не се сравнява.",
    "reconcile.hintRequired":
      "Задължителни са само отметнатите полета в „Сравнявай“: изключено поле позволява отчет без неговата колона да се сверява с останалите. Срок и Цена остават незадължителни дори когато са отметнати.",
    "reconcile.hintField": "Поле",
    "reconcile.hintHeaders": "Приети заглавия",
    "reconcile.hintComparedWith": "Сравнява се с",
    "reconcile.hintLayouts":
      "Приемат се два вида - пълен: НОМЕР НА ПОЛИЦА, НОМЕР НА СТИКЕР, ВАЛИДЕН ОТ, ВАЛИДЕН ДО, ДКН; дневник на смяна: № ПОЛИЦА, № БЛАНКА, ДАТА, СРОК, ДКН.",
    "reconcile.hintTerms":
      "Валиден до се взема от ВАЛИДЕН ДО или се изчислява от СРОК: 15D = 15 дни, 1M = 30, 3M = 90, 1Y = 365. Същата колона СРОК се сравнява със срока на застраховката, а колоната ЦЕНА - с нейната цена. Цената се сравнява само като число - валутата никога не се сравнява.",
    "reconcile.hintDates":
      "Датите може да са истински Excel дати или текст 05.10.2026, 05/10/2026 или 2026-10-05. Префиксът „BG/02/FI“ пред номера на полицата се пренебрегва.",
    "reconcile.compareFields": "Сравнявай:",
    "reconcile.compareToggleHint":
      "Изключете поле, за да не се броят разликите в него като несъответствия. Изборът се запомня на този компютър.",
    "reconcile.notCompared": "Не се сравнява",

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

    "presence.none": "Няма онлайн служители",
    "presence.online": "Онлайн",
    "presence.working": "Работи",
    "presence.afk": "Отсъства",

    balance: "Баланс",
    currentCash: "Наличен кеш",
    currentCashHint:
      "Наличният кеш е кешът, който реално е в касата, изчислен от полиците: застраховките на място, платени в брой, от текущата смяна, плюс ръчните увеличения, минус разходите и предадените пари. Картовите плащания, имейл плащанията, финансирани от баланс на брокер, и парите, предадени от брокери (кеш от брокери), се отчитат отделно. Корекцията на полица променя касата точно с новата ѝ цена и не оставя транзакция след себе си.",
    cardBalance: "Баланс карта",
    users: "Потребители",
    brokers: "Брокери",
    brokersHint:
      "Цветове на редовете и клетките: тъмночервен ред = брокерът няма имейл адрес; светлорозов баланс = отрицателен баланс; тъмночервена клетка Неактивни = остават под 30 бланки. Администраторите могат да спрат брокер по всяко време с бутона Спри, който блокира новите застраховки за този брокер.",
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
    branches: "Клонове",
    newBranch: "Нов клон",
    branchName: "Име на клона",
    branchEnabled: "Активен",
    branchDisabled: "Неактивен",
    branchCreated: "Клонът е създаден",
    branchUpdated: "Клонът е обновен",
    createBranch: "Създай клон",
    editBranch: "Редактирай клон",
    enable: "Активирай",
    disable: "Деактивирай",
    brokerName: "Брокер",
    mainBroker: "Главен брокер",
    brokerAllowNegative: "Приемане на заявки от брокери с отрицателен баланс",
    brokerAllowNegativeHint:
      "Когато е изключено, заявките от брокери, които биха свалили баланса под нула, се отхвърлят, а имейлите от брокери с отрицателен баланс не се показват.",
    cutOff: "Спри",
    brokerCutOff: "Спри",
    brokerCutOffRestore: "Активирай",
    brokerCutOffHint: "Спри новите застраховки за този брокер",
    brokerCutOffSet: "Брокерът е спрян — новите застраховки са блокирани",
    brokerCutOffRestored: "Брокерът е активиран — новите застраховки са разрешени отново",
    brokerNameFilterHint: "Кликнете, за да филтрирате брокерите по име",
    brokerNameFilterPlaceholder: "Филтър по име…",
    brokerNameFilterClear: "Изчисти филтъра по име",
    brokerNameNoMatches: "Няма брокери, отговарящи на „{q}“.",
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
    expense: "Разход",
    handOver: "Предай пари",
    handedTo: "Получател",
    handedToPlaceholder: "Име на човека, който взе парите",
    resetTo0: "Завърши смяна",
    amount: "Сума",
    reason: "Причина",
    type: "Тип",
    user: "Потребител",
    created: "Създаден",
    transactions: "Транзакции",
    annulments: "Анулирания",
    active: "Активни",
    resets: "Нулирания",
    back: "Назад",
    previous: "Предишна",
    next: "Следваща",
    pageOf: "Страница {page} от {total}",
    brokerHistory: "История на баланса",
    brokerHistoryBalanceHint:
      "Балансът на брокера в края на показания период. Изберете дата, за да видите баланса за този ден; историята стига до първото движение.",
    startingBalance: "Начален баланс",
    startingBalanceNotSet: "Не е зададен",
    startingBalanceDate: "Дата на началния баланс",
    startingBalanceHint:
      "Балансът на брокера преди създаването на първата му застраховка. При запазване балансът се преизчислява от всички негови застраховки (анулираните – по тяхната такса за анулиране) и всички негови плащания (увеличения и предадени суми).",
    startingBalanceSaved:
      "Началният баланс е запазен — балансът на брокера е преизчислен",
    balanceAtDayEnd: "Баланс в края на деня",
    balanceAtDayEndHint:
      "Балансът на брокера в края на показания ден: началният баланс плюс всички плащания, минус всички застраховки до този момент.",
    balanceAfter: "Баланс след",
    netChange: "Промяна",
    total: "Общо",
    "movement.policy": "Полица",
    "movement.annulment": "Анулиране",
    "movement.deletion": "Изтриване",
    "movement.price_change": "Промяна на цена",
    "movement.increase": "Увеличение",
    "movement.reduce": "Намаление",
    "movement.adjust": "Корекция",
    "movement.handover": "Предай пари",
    myProfile: "Моят профил",
    myInsurances: "Моите застраховки",

    author: "Автор",
    date: "Дата",
    previousDay: "Предишен ден ({date})",
    nextDay: "Следващ ден ({date})",
    load: "Зареди",
    clear: "Изчисти",
    searchCriteriaRequired:
      "Въведете поне един критерий за търсене (автор, дата, номер на полица, номер на бланка, номер на автомобил, брокер, ID на брокера, начин на плащане или анулирани)",
    searching: "Търсене…",
    searchFound: "Намерени {n} застраховки.",
    searchNoResults: "Не са намерени застраховки.",
    searchUnchanged: "Търсенето приключи — резултатите не са се променили.",
    blankNo: "Бланка №",
    client: "Клиент",
    price: "Цена",
    currency: "Валута",
    payment: "Плащане",
    broker: "Брокер",
    brokerId: "ID",
    brokerIdFilter: "ID на брокера",
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
    userRestored: "Потребителят е възстановен",
    deleteUserConfirm:
      "Да се изтрие ли потребител {u}? Акаунтът се запазва в базата данни и администратор може да го възстанови, но той вече не може да влиза.",
    restoreUserConfirm:
      "Да се възстанови ли потребител {u}? Акаунтът ще може да влиза отново и ще се появи в списъка с потребители.",
    deletedUsers: "Изтрити потребители",
    userCreated: "Потребител {u} е създаден",
    registrationFailed: "Регистрацията не успя",
    currentCashIncreased: "Наличният кеш беше увеличен",
    currentCashReduced: "Наличният кеш беше намален",
    cashHandedOver: "Парите са предадени",
    recordExpense: "Записване на разход",
    handOverCash: "Предаване на пари",
    handoverStats: "Статистика на предаванията",
    handoverStatsHint:
      "Пари, предадени на човек и още невърнати в каса или във фирмената банкова сметка. Стойностите обхващат всички клонове и всички брокери; списъкът под избора на дата показва клона на всяко предаване от този ден.",
    handoverGroupHandedOver: "Предадено",
    handoverGroupReturns: "Връщания и отмени",
    handoverGroupOutstanding: "Все още предадено",
    handedOverFromDrawer: "От офис касата",
    handedOverFromDrawerHint:
      "Предавания в брой, записани с бутона „Предай пари“ (пари, физически дадени на човек).",
    handedOverFromBrokerBalance: "От баланс на брокер",
    handedOverFromBrokerBalanceHint:
      "Предавания, записани в историята на брокерски баланс (брокерът е платил директно на собственика).",
    returnedToDrawer: "Върнато в офис касата",
    returnedToDrawerHint:
      "Отменени предавания, чиито пари са върнати в наличния кеш на клона.",
    returnedToBank: "Върнато във фирмената банкова сметка",
    returnedToBankHint:
      "Отменени предавания, изпратени директно във фирмената банка; не е пипана каса.",
    handoverUndone: "Отменени предавания",
    handoverUndoneHint:
      "Изтрити записи за предаване от съответния регистър (кеш и брокерски баланс). Парите им вече са сторнирани.",
    handoverCashOutstanding: "Кеш, който все още е предаден",
    handoverCashOutstandingHint:
      "Активни предавания в брой минус сумите, вече върнати в каса или в банката.",
    handoverBalanceOutstanding: "Брокерски баланс, който все още е предаден",
    handoverBalanceOutstandingHint:
      "Активни брокерски предавания. Отменят се от историята на брокерския баланс.",
    handedOverCashSection: "Предадени пари в брой",
    handedOverCashDayHint:
      "Показани са само предаванията, записани на избрания ден. Изберете друг ден, за да видите (или отмените) по-старо предаване.",
    handoverReturn: "Връщане на предаване",
    handoverReturnedAmount: "Върнато",
    handoverRemaining: "Остава",
    undoHandover: "Отмени предаване",
    undoHandoverTitle: "Отмяна на предаване #{i}",
    undoHandoverDestination: "Къде отиват парите",
    undoHandoverDrawer: "Офис каса (увеличава наличния кеш)",
    undoHandoverBank: "Фирмена банкова сметка (без промяна в касата)",
    undoHandoverReason: "Бележка (по избор)",
    undoHandoverSubmit: "Върни парите",
    handoverReturnedToDrawer: "Върнато в офис касата",
    handoverReturnedToBank: "Върнато във фирмената банкова сметка",
    expenseRecorded: "Разходът е записан",
    currentCashReset:
      "Наличният кеш, балансът на картата и кешът от брокери бяха нулирани",
    transactionUpdated: "Транзакцията е обновена",
    editTransaction: "Редактирай транзакция",
    deleteTransaction: "Изтрий транзакция",
    deleteTransactionConfirm:
      "Да се изтрие ли транзакция #{i} ({t} {a} {c} - {r})? Тя ще остане в базата данни, но ще бъде скрита от регистъра, а сумата ѝ ще бъде сторнирана.",
    transactionDeleted: "Транзакцията е изтрита",
    resetConfirm:
      "Да се нулират ли наличният кеш, балансът на картата и кешът от брокери на този клон? Ще бъдат записани задържаните суми.",
    fixShift: "Поправи забравена смяна",
    fixShiftTitle: "Затвори забравена смяна",
    fixShiftHint:
      "Смяната се затваря в края на избрания ден (23:59:59, полунощ). Наличният кеш, балансът на картата и кешът от брокери се разделят по време на движенията: сумата, която всеки е държал в полунощ, се записва като приключена смяна, а всичко след полунощ — включително днешните застраховки — остава в текущите баланси.",
    fixShiftDate: "Дата на смяната",
    fixShiftSubmit: "Затвори смяната в полунощ",
    fixShiftConfirm:
      "Да се затвори ли смяната на {date} в {cutoff}?\n\nЗадържани от приключената смяна:\nКеш: {keptCash}\nКарта: {keptCard}\nКеш от брокери: {keptBroker}\n\nОстава в текущите баланси:\nКеш: {remainCash}\nКарта: {remainCard}\nКеш от брокери: {remainBroker}",
    fixShiftDone:
      "Смяната на {date} е затворена в полунощ — задържани {keptCash} кеш, {keptCard} карта, {keptBroker} кеш от брокери",
    fixShiftInvalid: "Въведете валидна дата на смяната.",
    fixShiftFuture: "Краят на смяната трябва да е в миналото.",
    fixShiftAlreadyClosed:
      "Смяна вече е затворена в или след този час. Използвайте обикновено „Завърши смяна“.",
    fixShiftCashBelow:
      "Днешният кеш е по-малък от баланса в полунощ за {currency}. Нищо не беше променено — използвайте обикновено „Завърши смяна“.",
    fixShiftCutoffNegative:
      "Кешовият баланс към този час е отрицателен за {currency}. Нищо не беше променено.",
    fixShiftBrokerBelow:
      "Кешът от брокери е по-малък от баланса в полунощ за {currency}. Нищо не беше променено.",
    shiftMissedWarning:
      "За {date} няма записано „Завърши смяна“. Ако служител е забравил да приключи смяната, затворете я сега, за да е верен отчетът за деня.",
    "shiftReminder.title": "Смяната приключва след 5 минути",
    "shiftReminder.body":
      "Не забравяйте да завършите смяната си преди полунощ: отворете „Наличен кеш“ и натиснете „Завърши смяна“.",
    "shiftReminder.remaining": "До полунощ: {time}",
    "shiftReminder.overdue":
      "Полунощ мина — моля, завършете смяната от предната нощ сега.",
    "shiftReminder.endShift": "Завърши смяната",
    "shiftReminder.dismiss": "Затвори",
    "shiftReminder.leaveFormConfirm":
      "Да се напусне ли страницата? Незаписаното във формуляра за застраховка ще бъде загубено. Да се отвори ли „Наличен кеш“, за да завършите смяната?",
    brokerBalanceIncreased: "Балансът на брокера беше увеличен",
    brokerBalanceReduced: "Балансът на брокера беше намален",
    brokerHandoverRecorded: "Предаването е записано",
    brokerCreated: "Брокерът е създаден",
    brokerUpdated: "Брокерът е обновен",
    brokerDeleted: "Брокерът е изтрит",
    brokerRestored: "Брокерът е възстановен",
    deleteBrokerConfirm:
      "Да се изтрие ли брокер {b}? Той се запазва в базата данни и администратор може да го възстанови, но изчезва от списъците и имейлите му вече не се показват. Балансът, бланките и застраховките му остават непроменени.",
    restoreBrokerConfirm:
      "Да се възстанови ли брокер {b}? Той ще се появи отново в списъците със запазения си баланс и бланки.",
    deletedBrokers: "Изтрити брокери",
    editMovement: "Редактирай движение",
    deleteMovement: "Изтрий движение",
    movementUpdated: "Движението е обновено",
    movementDeleted: "Движението е изтрито",
    movementRestored: "Движението е възстановено",
    deletedMovements: "Изтрити движения",
    deleteMovementConfirm:
      "Да се скрие ли това движение? То се запазва в базата данни и може да бъде възстановено; сумата му се връща към баланса на брокера.",
    restoreMovementConfirm:
      "Да се възстанови ли това движение? Сумата му ще бъде приложена отново към баланса на брокера.",
    exportFailed: "Експортът не успя",
    balanceUpdated: "Балансът е обновен",
    settingSaved: "Настройката е запазена",
    setBalanceFor: "Задай баланс за",
    deleteConfirm: "Изтриване",
    deleted: "Изтрита",
    deletedBy: "Изтрит от",
    includeDeleted: "Включи изтритите",
    annulledFilter: "Анулирани",
    totalIncludingAnnulled: "Общо (с такса анулирани)",
    deleteInsuranceConfirm:
      "Да се изтрие ли застраховка {b}? Тя ще остане в базата данни, но ще бъде скрита от списъците и справките.",
    deleteInsurance: "Изтрий застраховка",
    insuranceDeleted: "Застраховката е изтрита",
    restore: "Възстанови",
    restoreInsuranceConfirm:
      "Да се възстанови ли застраховка {b}? Нейните суми и балансът на брокера ще бъдат приложени отново и тя ще се появи отново в списъците и справките.",
    insuranceRestored: "Застраховката е възстановена",
    emailClaimed: "Този имейл вече е отворен от друг служител",
    emailConnUnavailable: "Връзката с имейл е недостъпна",
    emailClaimTimeout: "Сървърът не отговори. Опитайте отново.",
    emailSendFailed: "Неуспешно изпращане на имейл",
    emailReplyQueued: "Имейлът с отговор се изпраща отново автоматично",
    emailReplyQueuedTo:
      "Имейлът с отговор до {email} се изпраща отново автоматично",
    emailReplyFailed: "Имейлът с отговор не можа да бъде изпратен",
    emailReplyFailedTo: "Имейлът с отговор до {email} не можа да бъде изпратен",
    name: "Име",
    rangeStart: "Начало на диапазон",
    rangeEnd: "Край на диапазон",
    inactive: "Неактивни",
    blancBatches: "Партиди бланки",
    addBatch: "+ Добави партида",
    blancCount: "Бланки",
    blancUsed: "Използвани",
    blancSummary: "{t} бланки във всички партиди · {u} използвани · {i} неактивни",
    deleteBatchConfirm: "Да се изтрие ли партида бланки {s}–{e}?",
    batchAdded: "Партидата бланки е добавена",
    batchUpdated: "Партидата бланки е обновена",
    batchDeleted: "Партидата бланки е изтрита",
    autoBatchHint:
      "Добавена автоматично: бланката е била извън партидите на брокера",
    kept: "Задържана",
    cardPayments: "Плащания с карта",
    paymentType: "Начин на плащане",
    "payment.Cash": "В брой",
    "payment.Card": "С карта",
    "payment.Broker": "От баланс на брокер",
    "payment.cardCash": "Карта + кеш",
    clearBalance: "Изчисти баланса",
    clearCardBalanceConfirm:
      "Да се нулира ли балансът на картата? Ще бъде записана задържаната сума.",
    cardBalanceCleared: "Балансът на картата е изчистен",
    cardBalanceTotal: "Баланс карта (всички клонове)",
    cashFromBrokers: "Кеш от брокери",
    cashFromBrokersHint:
      "Пари, предадени от брокери в този клон след последното нулиране. Те се отчитат отделно от наличния кеш, който вече не се увеличава при увеличаване на баланс на брокер.",
    unassignedBranch: "(без клон)",

    dailyReport: "Дневен отчет",
    drawers: "Каси",
    insuranceNumberStatistics: "Статистика по брой застраховки",
    insuranceMoneyStatistics: "Статистика по пари от застраховки",
    manualBrokerIncreases: "Ръчни увеличения на кеша към баланса на брокери",
    manualBrokerIncreasesHint:
      "Пари, предадени от брокери на този ден (ръчни увеличения на баланс на брокер). Върнатите суми за анулирани застраховки не се броят.",
    balanceFromBrokerInsurances: "Баланс от брокерски застраховки",
    balanceFromBrokerInsurancesHint:
      "Пари, финансирани от баланс на брокер чрез застраховките, създадени на този ден.",
    balanceFromWalkInsCash: "Баланс от плащания в брой на място",
    balanceFromWalkInsCashHint:
      "Цената на застраховките на място, платени в брой на този ден (анулираните се броят с таксата за анулиране).",
    balanceFromWalkInsCard: "Баланс от плащания с карта на място",
    balanceFromWalkInsCardHint:
      "Цената на застраховките на място, платени с карта на този ден (анулираните се броят с таксата за анулиране).",
    lastPayment: "Последно плащане",
    totalInsurances: "Общо застраховки",
    brokerInsurances: "Брокерски застраховки",
    walkInInsurances: "Застраховки на място",
    totalDailyBalance: "Общ дневен баланс",
    totalDailyBalanceHint:
      "Цената на всички застраховки, създадени на този ден, независимо от начина на плащане - в брой, с карта или от баланс на брокер. Това е сборът на трите стойности по-долу.",
    availableCash: "Наличен кеш",
    availableCashBranch: "Наличен кеш ({branch})",
    availableCashHint:
      "Кешът в касата на клона в края на избрания ден: застраховките на място, платени в брой, от текущата смяна, плюс ръчните увеличения, минус разходите и предадените пари. Връщането на датата назад показва колко кеш е имал клонът на разположение тогава.",
    countryWideInsurances: "Застраховки в страната",
    countryWideInsurancesHint:
      "Диапазонът на номерата на полиците, издадени в страната за този ден: най-високият номер минус най-ниският. Полиците по-долу определят краищата на диапазона, така че сгрешен или чужд номер в някой от краищата променя стойността.",
    countryWideFromPolicy: "От полица",
    countryWideToPolicy: "До полица",
    countryWideSinglePolicy: "Единствена полица",
    cardPaymentsHint:
      "Плащания с карта, събрани в този клон на този ден.",
    cardBalanceHint:
      "Текущият баланс на картата за този клон: застраховките с карта на място от последното нулиране („Завърши смяна“ го изчиства заедно с касата).",
    cardInsurances: "Застраховки с карта (на място)",
    cardInsurancesHint:
      "Застраховки на място, платени с карта в този клон на избрания ден. Картата „Баланс на картата“ отваря този списък.",
    brokerBalanceTotal: "Общ баланс на брокери",
    brokerBalanceTotalHint:
      "Пари, финансирани от баланс на брокер, в този клон на този ден (застраховки по имейл).",
    totalCashFromBrokers: "Общо кеш от брокери",
    totalCashFromBrokersHint:
      "Пари, предадени от брокери на този ден (увеличения на баланс на брокер). Върнатите суми за анулирани застраховки не се броят.",
    transactionsCashFromBrokers: "Транзакции кеш от брокери",

    expenses: "Разходи",
    totalExpenses: "Общо разходи",
    expensesHint:
      "Пари, изразходвани от касата на този клон на този ден (записаните с бутона „Разход“). Върнатите суми за анулирани или изтрити застраховки също намаляват касата, но те са движения по полици, а не пари, изразходвани от клона, и не се броят тук. Преданият на човек кеш (бутонът „Предай пари“) също не се брои: той е излязъл от касата, но клонът не го е изразходвал.",

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
    annulFeeAdminNote: "Администраторите могат да въведат друга такса.",
    annulFeeInvalid: "Таксата трябва да е неотрицателно число.",
    annulConfirmTitle: "Анулиране на застраховка",
    annulSubmit: "Анулирай застраховката",
    insuranceAnnulled: "Застраховката е анулирана",
    alreadyAnnulled: "Вече е анулирана",
    "add.back": "← Табло",
    "add.title": "Нова застраховка",
    "addAdmin.title": "Нова застраховка (админ)",
    "addAdmin.creationDate": "Дата на създаване",
    "addAdmin.creationDateRequired": "Датата на създаване е задължителна",
    "addAdmin.broker": "Брокер",
    "addAdmin.brokerNone": "— Без брокер (на място) —",
    "addAdmin.brokerNote":
      "Плаща се от баланса на избрания брокер. Балансът на брокера ще бъде намален за избраната дата на създаване.",
    "addAdmin.brokersLoadFailed": "Списъкът с брокери не можа да се зареди",
    "add.policyNumber": "Полица номер",
    "add.blancNumber": "Бланка номер",
    "add.carNumber": "Номер на автомобил",
    "add.carNumberRequired": "Номерът на автомобила е задължителен",
    "add.policyNumberRequired": "Номерът на полицата е задължителен",
    "add.blancNumberRequired": "Номерът на бланката е задължителен",
    "add.policyNumberLength": "Номерът на полицата трябва да е точно 8 символа",
    "add.blancNumberLength": "Номерът на бланката трябва да е точно 6 символа",
    "add.duration": "Срок",
    "add.branch": "Клон",
    "add.vehicleType": "Вид превозно средство",
    "add.startDate": "Начална дата",
    "add.startDateRequired": "Началната дата е задължителна",
    "add.price": "Цена",
    "add.priceUnavailable":
      "Няма тарифа за този вид превозно средство и срок - застраховката не може да бъде записана.",
    "add.priceLoading": "Цената още се зарежда - опитайте отново след малко.",
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
    "add.blancOutsideBatchesConfirm":
      "Този номер на бланка не е в никоя от партидите на брокера. Да се създаде ли застраховката въпреки това? Бланката ще бъде добавена към партидите на брокера и ще бъде означена в розово.",
    "add.dropArea": "Пуснете файлове тук",
    "add.dropAreaHint": "или щракнете, за да изберете файлове",
    "add.attachedFiles": "Прикачени файлове",
    "add.removeFile": "Премахни",
    "add.printFile": "Принтирай",
    "add.printSuccess": "Изпратено към принтера",
    "add.printFailed": "Принтирането не успя",
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
    "add.desktopPdfAttached": "PDF от работния плот е прикачен към полицата.",
    "add.emailLost":
      "Този имейл вече не е запазен за вас: бил е взет от друг служител или обработен, докато връзката беше прекъсната.",
    "add.conversationHistory": "Разговор",
    "add.conversationEmpty": "Няма отговори още.",
    "add.conversationLoading": "Зареждане на разговора…",
    "add.conversationUnavailable":
      "По-старият разговор не можа да бъде зареден; цитираните имейли и вашите отговори са показани по-долу.",
    "add.messageFromBroker": "Клиент",
    "add.messageFromEmployee": "Служител",

    "email.noSubject": "(без тема)",
    "email.from": "От:",
    "email.date": "Дата:",
    "email.emptyBody": "(празно съдържание)",
    "email.reply": "Отговор",
    "email.forward": "Препратен",
    "email.threadCount": "{n} имейла",
    "email.replyCount": "{n} отговора",
    "email.replyCountOne": "1 отговор",
    "email.arrived": "Получен {t}",
    "email.waitingNow": "току-що",
    "email.waitingMin": "преди {n} мин",
    "email.waitingHours": "преди {h} ч {m} мин",
    "email.overdue": "Чака повече от 10 минути",
    "email.latestMessage": "Последно съобщение",
    "email.earlierMessage": "Предишен имейл №{n}",
    "email.attachments": "Прикачени файлове",
    "email.noAttachments": "Няма прикачени файлове.",
    "email.attachment": "прикачен файл",
    "email.downloading": "Изтегляне… {percent}%",
    "email.downloadingUnknown": "Изтегляне…",
    "email.downloadRetrying": "Връзката прекъсна — нов опит…",
    "email.downloaded": "Изтеглено",
    "email.zoomIn": "Увеличи",
    "email.zoomOut": "Намали",
    "email.resetZoom": "Нулирай мащаба",
    "email.rotateLeft": "Завърти наляво",
    "email.rotateRight": "Завърти надясно",
    "email.print": "Принтирай снимка",
    "email.printSuccess": "Снимката е изпратена към принтера",
    "email.printCancelled": "Принтирането е отказано",
    "email.printFailed": "Принтирането не успя",
    "email.close": "Затвори",
    "email.markIrrelevant": "Маркирай като нерелевантен",
    "email.irrelevantConfirm":
      "Да се маркира ли този имейл като нерелевантен? Той ще бъде премахнат и няма да се показва отново.",
    "email.irrelevantMarked": "Имейлът е маркиран като нерелевантен",
    "email.opening": "Отваряне…",
    "email.brokerCodeTitle": "Код на брокер",
    "email.answered": "Отговорено",
    "email.answeredSection": "Отговорени — чакат отговор от брокера",
    "email.lowPrioritySection":
      "Нископриоритетни — отговорени, чакат отговор от брокера",
    "email.lowPriorityAwaiting": "нисък приоритет · чака брокер",
    "email.lowPriorityHidden":
      "{n} нископриоритетни карти са скрити, докато клиентът отговори.",
    "email.answeredAt": "Отговорено {t}",
    "email.awaitingBroker": "чака брокер",
    "email.allAnswered": "Всичко е обработено — чакаме брокерите.",
    "email.searchPlaceholder": "Търсене в имейлите…",
    "email.searchClear": "Изчисти търсенето",
    "email.searchNoResults": "Няма имейли, отговарящи на „{q}“.",

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
    // Банер за автоматична актуализация (виж renderUpdateBanner по-долу).
    "update.downloading": "Изтегля се актуализация {version}… {percent}%",
    "update.downloadingUnknown": "Изтегля се актуализация {version}…",
    "update.unknownVersion": "нова версия",
    "update.ready": "Актуализация {version} е готова за инсталиране",
    "update.readyHint":
      "Рестартирайте, за да я приложите сега, или тя ще се инсталира при затваряне на програмата.",
    "update.restartNow": "Рестартирай сега",
    "update.later": "По-късно",
    "update.restarting": "Рестартиране…",
    "update.restartFailed":
      "Рестартирането не успя — затворете и отворете програмата ръчно, за да се приложи актуализацията.",

    // Превод на съобщенията за грешки от сървъра (виж translateError по-долу).
    "err.invalidCredentials": "Грешно потребителско име или парола",
    "err.usernamePasswordRequired": "Потребителско име и парола са задължителни",
    "err.usernameLength": "Потребителското име трябва да е поне 2 символа",
    "err.passwordLength": "Паролата трябва да е поне 6 символа",
    "err.accountSuspended": "Акаунтът е спрян",
    "err.accountDeleted": "Акаунтът е изтрит",
    "err.branchDisabled": "Този клон е деактивиран",
    "err.branchExists": "Вече съществува клон с това име",
    "err.branchNameRequired": "Името на клона е задължително",
    "err.branchNameLength": "Името на клона трябва да е до 100 символа",
    "err.branchNotFound": "Клонът не е намерен",
    "err.accessDeniedRole": "Отказан достъп: непозната роля",
    "err.usernameExists": "Потребителското име вече съществува",
    "err.blancExists": "Вече съществува застраховка с този номер на бланка",
    "err.blancOutsideBrokerBatches":
      "Този номер на бланка не е в никоя от партидите на брокера",
    "err.blancBelongsToAnotherBroker":
      "Този номер на бланка е в партидите на друг брокер ({broker}). Сменете номера на бланката, за да се запише застраховката.",
    "err.insuranceNotFound": "Застраховката не е намерена",
    "err.cannotModifyDeleted": "Изтрита застраховка не може да се редактира",
    "err.cannotAnnulDeleted": "Изтрита застраховка не може да се анулира",
    "err.alreadyAnnulled": "Застраховката вече е анулирана",
    "err.notAnnulled": "Застраховката не е анулирана",
    "err.onlyAdminAnnulFault":
      "Само администратор може да промени вината на анулирана застраховка",
    "err.onlyAdminRestoreAnnul":
      "Само администратор може да възстанови анулирана застраховка",
    "err.onlyAdminAuthor":
      "Само администратор може да промени автора на застраховка",
    "err.onlyAdminBroker":
      "Само администратор може да промени брокера на застраховка",
    "err.brokerChangeAnnulled":
      "Брокерът на анулирана застраховка не може да се променя",
    "err.authorRequired": "Авторът е задължителен",
    "err.authorNotFound": "Авторът не е намерен",
    "err.emailBrokerOnly": "Имейл полиците се плащат само от баланса на брокера",
    "err.onlyEmailBroker": "Само имейл полици могат да се плащат от баланс на брокер",
    "err.nonTurkWalkInOnly": "Данъкът за чужденци важи само за полици на място",
    "err.senderNotBroker": "Подателят на имейла не е свързан с брокер",
    "err.brokerNegativeBalance":
      "Заявката на брокера е отхвърлена: балансът на брокера ще стане отрицателен",
    "err.brokerCutOff":
      "Брокерът е спрян; нови застраховки не могат да се създават, докато брокерът не бъде отново активиран",
    "err.payerInvalid": "Платецът на таксата трябва да е 'брокер', 'служител' или 'без вина'",
    "err.dateFormat": "Датата трябва да е във формат ГГГГ-ММ-ДД",
    "err.creationDateFormat":
      "Датата на създаване трябва да е във формат ГГГГ-ММ-ДД ЧЧ:ММ:СС",
    "err.insufficientCash": "Недостатъчен наличен кеш за намалението",
    "err.invalidDuration": "Невалиден период",
    "err.invalidVehicleType": "Невалиден вид превозно средство",
    "err.userNotFound": "Потребителят не е намерен",
    "err.userNotDeleted": "Потребителят не е изтрит",
    "err.brokerNotFound": "Брокерът не е намерен",
    "err.brokerNotDeleted": "Брокерът не е изтрит",
    "err.brokerDeleted": "Този брокер е изтрит и трябва първо да бъде възстановен",
    "err.clientNotFound": "Клиентът не е намерен",
    "err.transactionNotFound": "Транзакцията не е намерена",
    "err.transactionAlreadyDeleted": "Транзакцията вече е изтрита",
    "err.blancBatchNotFound": "Партидата с бланки не е намерена",
    "err.cannotDeleteSelf": "Не можете да изтриете собствения си акаунт",
    "err.cannotDeleteAdmin": "Администраторски акаунт не може да се изтрие",
    "err.cannotSuspendAdmin": "Администраторски акаунт не може да се спре",
    "err.cannotChangeAdminRole": "Ролята на администратор не може да се промени",
    "err.ownTransactionsOnly": "Можете да редактирате само собствените си транзакции",
    "err.accountNotBroker": "Този акаунт не е свързан с брокер",
    "err.ownBrokerOnly": "Можете да преглеждате само собствения си брокер",
    "err.statusInvalid": "Статусът трябва да е 'активен' или 'спрян'",
    "err.roleInvalid": "Ролята трябва да е 1, 2 или 3",
    "err.nameEmpty": "Името не може да е празно",
    "err.nameRequired": "Името е задължително",
    "err.usernameRequired": "Потребителското име е задължително",
    "err.bodyTextRequired": "Текстът на отговора е задължителен",
    "err.amountPositive": "Сумата трябва да е положително число",
    "err.balanceNonNegative": "Балансът трябва да е неотрицателно число",
    "err.priceNonNegative": "Цената трябва да е неотрицателно число",
    "err.durationPositive": "Периодът трябва да е положително число",
    "err.brokerIdInvalid": "Брокерът трябва да е валиден идентификатор",
    "err.brokerNameExists": "Вече съществува брокер с това име",
    "err.tariffFieldsRequired": "Вид превозно средство, период и цена са задължителни",
    "err.pricingFormat": "Невалиден формат на данните за цените",
    "err.tariffsRequired": "Необходима е поне една тарифа",
    "err.typeInvalid": "Типът трябва да е 'увеличение' или 'намаление'",
    "err.cashTypeInvalid":
      "Типът трябва да е 'увеличение', 'намаление' или 'предаване'",
    "err.usernameBalanceRequired": "Потребителско име и баланс са задължителни",
    "err.noBatch": "Не е подадена партида",
    "err.rangeRequired": "Началото и краят на диапазона са задължителни",
    "err.rangeOrder": "Краят на диапазона трябва да е по-голям или равен на началото",
    "err.rangeTooLarge": "Началото/краят на диапазона е твърде голям",
    "err.rangeWhole":
      "Началото и краят на диапазона трябва да са цели неотрицателни числа",
    "err.nothingToUpdate": "Няма какво да се обнови",
    "err.partInvalid": "Частта трябва да е 'CardPart' или 'BrokerPart'",
    "err.reasonRequired": "Причината е задължителна",
    "err.recipientRequired": "Въведете кой получи парите",
    "err.handoverReturnTooMuch":
      "Сумата е повече от това, което все още е предадено",
    "err.handoverAlreadyReturned":
      "Това предаване вече е върнато изцяло",
    "err.handoverHasReturns":
      "Предаване, което е частично или изцяло върнато, не може да се изтрие; отменете оставащата сума",
    "err.handoverReturnLocked":
      "Връщането на предаване не може да се редактира или изтрива",
    "err.notHandover": "Този запис не е предаване на пари в брой",
    "err.handoverDeleted": "Изтрито предаване не може да бъде върнато",
    "err.amountBelowReturned": "Сумата е под вече върнатата",
    "err.destinationInvalid": "Дестинацията трябва да е 'drawer' или 'bank'",
    "err.handoverTypeFixed":
      "Предаването на пари не може да се превърне в увеличение или разход (или обратното); изтрийте записа и въведете правилния",
    "err.movementNotFound": "Движението не е намерено",
    "err.movementIdInvalid": "Невалидно движение",
    "err.amountNonZero": "Сумата трябва да е число, различно от нула",
    "err.typeEmpty": "Типът не може да е празен",
    "err.movementAlreadyDeleted": "Движението вече е изтрито",
    "err.movementNotDeleted": "Движението не е изтрито",
    "err.sourceInvalid": "Източникът трябва да е 'Card' или 'Broker'",
    "err.failedLoadInsurances": "Неуспешно зареждане на застраховките",
    "err.failedUpdateInsurance": "Неуспешно обновяване на застраховката",
    "err.failedAnnullInsurance": "Неуспешно анулиране на застраховката",
    "err.failedCreateInsurance": "Неуспешно създаване на застраховката",
    errorPrefix: "Грешка",
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
  // The shift-reminder banner is built in JS, so it is not covered by
  // translatePage(); re-render it in the new language while it is on screen.
  refreshShiftReminder();
  // Same for the auto-update banner, which may be on screen during a download.
  refreshUpdateBanner();
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

// Maps the server's English error messages to translation keys, so errors shown
// to the worker follow the selected language as well. Messages that are not
// listed here (or that carry dynamic data) are returned unchanged.

// Machine-readable code the server returns when a broker-linked policy's blanc
// number is not covered by the broker's blanc batches.
const BLANC_OUTSIDE_BROKER_BATCHES_CODE = "BLANC_OUTSIDE_BROKER_BATCHES";

const SERVER_ERROR_TRANSLATIONS = {
  // Authentication / accounts.
  "Invalid username or password": "err.invalidCredentials",
  "Username and Password are required": "err.usernamePasswordRequired",
  "Username must be at least 2 characters": "err.usernameLength",
  "Password must be at least 6 characters": "err.passwordLength",
  "Account suspended": "err.accountSuspended",
  "Branch is disabled": "err.branchDisabled",
  "This branch is disabled": "err.branchDisabled",
  "A branch with this name already exists": "err.branchExists",
  "Branch name is required": "err.branchNameRequired",
  "Branch name cannot be empty": "err.branchNameRequired",
  "Branch name must be 100 characters or fewer": "err.branchNameLength",
  "Branch not found": "err.branchNotFound",
  "Access Denied: unknown role": "err.accessDeniedRole",
  "Username already exists": "err.usernameExists",
  "Unauthorized: invalid or expired token": "sessionExpired",
  "Unauthorized: missing token": "sessionExpired",
  Unauthorized: "sessionExpired",
  "Forbidden: insufficient permissions": "accessDenied",
  Forbidden: "accessDenied",

  // Insurances.
  "Insurance with this BlancNumber already exists": "err.blancExists",
  "This blanc number is not in any of the broker's blanc batches":
    "err.blancOutsideBrokerBatches",
  "Insurance not found": "err.insuranceNotFound",
  "Cannot modify a deleted insurance": "err.cannotModifyDeleted",
  "Cannot annul a deleted insurance": "err.cannotAnnulDeleted",
  "Insurance already annulled": "err.alreadyAnnulled",
  "Insurance is not annulled": "err.notAnnulled",
  "Only admins can change the fault of an annulled insurance":
    "err.onlyAdminAnnulFault",
  "Only admins can restore an annulled insurance": "err.onlyAdminRestoreAnnul",
  "Only admins can change the author of an insurance": "err.onlyAdminAuthor",
  "Only admins can change the broker of an insurance": "err.onlyAdminBroker",
  "Cannot change the broker of an annulled insurance":
    "err.brokerChangeAnnulled",
  "Author is required": "err.authorRequired",
  "Author not found": "err.authorNotFound",
  "Email policies are paid from the broker balance only": "err.emailBrokerOnly",
  "Only email policies can be paid from a broker balance": "err.onlyEmailBroker",
  "The non-Turk tax only applies to walk-in policies": "err.nonTurkWalkInOnly",
  "The email sender is not linked to a broker": "err.senderNotBroker",
  "Broker request rejected: negative balance not allowed":
    "err.brokerNegativeBalance",
  "Broker is cut off; new insurances cannot be created until the broker is re-enabled":
    "err.brokerCutOff",
  "Attach at least one file before saving an email policy": "add.attachmentsRequired",
  "payer must be one of 'broker', 'worker' or 'none'": "err.payerInvalid",
  "date must be in YYYY-MM-DD format": "err.dateFormat",
  "CreationDate must be in YYYY-MM-DD HH:MM:SS format": "err.creationDateFormat",
  "BlancNumber is required": "add.blancNumberRequired",
  "PolicyNumber is required": "add.policyNumberRequired",
  "CarNumber is required": "add.carNumberRequired",
  "insufficient current cash for reduction": "err.insufficientCash",

  // Users / brokers / cash.
  "User not found": "err.userNotFound",
  "User is not deleted": "err.userNotDeleted",
  "Broker not found": "err.brokerNotFound",
  "Broker is not deleted": "err.brokerNotDeleted",
  "Broker is deleted; it has to be restored first": "err.brokerDeleted",
  "Account deleted": "err.accountDeleted",
  "Client not found": "err.clientNotFound",
  "Transaction not found": "err.transactionNotFound",
  "Transaction already deleted": "err.transactionAlreadyDeleted",
  "Blanc batch not found": "err.blancBatchNotFound",
  "Cannot delete your own account": "err.cannotDeleteSelf",
  "Forbidden: cannot delete an admin": "err.cannotDeleteAdmin",
  "Forbidden: cannot suspend an admin": "err.cannotSuspendAdmin",
  "Forbidden: cannot change the role of an admin": "err.cannotChangeAdminRole",
  "Forbidden: you can only edit your own transactions": "err.ownTransactionsOnly",
  "Forbidden: this account is not linked to a broker": "err.accountNotBroker",
  "Forbidden: you can only view your own broker": "err.ownBrokerOnly",
  "Status must be 'active' or 'suspended'": "err.statusInvalid",
  "role must be 1, 2 or 3": "err.roleInvalid",
  "RoleID must be one of 1 (admin), 2 (worker), 3 (client)": "err.roleInvalid",
  "Name cannot be empty": "err.nameEmpty",
  "Name is required": "err.nameRequired",
  "Username is required": "err.usernameRequired",
  "bodyText is required": "err.bodyTextRequired",
  "amount must be a positive number": "err.amountPositive",
  "balance must be a non-negative number": "err.balanceNonNegative",
  "price must be a non-negative number": "err.priceNonNegative",
  "duration must be a positive number": "err.durationPositive",
  "BrokerId must be a positive integer or null": "err.brokerIdInvalid",
  "Invalid broker id": "err.brokerIdInvalid",
  "A broker with this Name already exists": "err.brokerNameExists",
  "insuranceType, duration, and price are required": "err.tariffFieldsRequired",
  "Invalid pricing data format": "err.pricingFormat",
  "tariffs array is required and must not be empty": "err.tariffsRequired",
  "type must be 'increase' or 'reduce'": "err.typeInvalid",
  "type must be 'increase', 'reduce' or 'handover'": "err.cashTypeInvalid",
  "username and balance are required": "err.usernameBalanceRequired",
  "No batch given": "err.noBatch",
  "RangeStart and RangeEnd are required": "err.rangeRequired",
  "RangeStart and RangeEnd must be non-negative whole numbers": "err.rangeWhole",
  "RangeEnd must be >= RangeStart": "err.rangeOrder",
  "RangeStart / RangeEnd is too large": "err.rangeTooLarge",
  "Nothing to update": "err.nothingToUpdate",
  "part must be 'CardPart' or 'BrokerPart'": "err.partInvalid",
  "reason is required": "err.reasonRequired",
  "recipient is required": "err.recipientRequired",
  "destination must be 'drawer' or 'bank'": "err.destinationInvalid",
  "amount exceeds the money still handed over": "err.handoverReturnTooMuch",
  "the hand-over has already been fully returned": "err.handoverAlreadyReturned",
  "a hand-over with returns cannot be deleted": "err.handoverHasReturns",
  "a hand-over return cannot be edited or deleted": "err.handoverReturnLocked",
  "transaction is not a hand-over": "err.notHandover",
  "a deleted hand-over cannot be returned": "err.handoverDeleted",
  "amount is below what was already returned": "err.amountBelowReturned",
  "a hand-over cannot be changed into an increase or an expense, or the other way round":
    "err.handoverTypeFixed",
  "source must be 'Card' or 'Broker'": "err.sourceInvalid",
  "Movement not found": "err.movementNotFound",
  "Invalid movement id": "err.movementIdInvalid",
  "amount must be a non-zero number": "err.amountNonZero",
  "Type cannot be empty": "err.typeEmpty",
  "Movement already deleted": "err.movementAlreadyDeleted",
  "Movement is not deleted": "err.movementNotDeleted",

  // Generic 500s surfaced by common worker flows.
  "Failed to fetch insurances": "err.failedLoadInsurances",
  "Failed to update insurance": "err.failedUpdateInsurance",
  "Failed to annul insurance": "err.failedAnnullInsurance",
  "Failed to create insurance": "err.failedCreateInsurance",

  // Admin "fix forgotten shift" (as-of reset).
  "A shift has already been closed at or after this cutoff":
    "fixShiftAlreadyClosed",
  "Cutoff must be in YYYY-MM-DD HH:MM:SS format": "fixShiftInvalid",
  "Failed to close the shift as of the cutoff": "serverError",
};

// Translate a server error message to the current language. Returns an empty
// string for empty input and the original message when no translation exists.
function translateError(message) {
  if (!message) return "";
  const text = String(message).trim();
  const key = SERVER_ERROR_TRANSLATIONS[text];
  if (key) return t(key);
  // Dynamic messages that carry a value after a colon.
  if (text.startsWith("Invalid duration:")) {
    return `${t("err.invalidDuration")} ${text.slice(text.indexOf(":") + 1).trim()}`;
  }
  if (text.startsWith("Invalid vehicle type:")) {
    return `${t("err.invalidVehicleType")} ${text.slice(text.indexOf(":") + 1).trim()}`;
  }
  // A blanc that is already in another broker's batches names that broker as
  // "... (Broker Name)" at the end of the server message.
  if (
    text.startsWith(
      "This blanc number belongs to another broker's blanc batches"
    )
  ) {
    const open = text.indexOf("(");
    const close = text.lastIndexOf(")");
    const broker =
      open !== -1 && close > open ? text.slice(open + 1, close).trim() : "";
    return fmt(t("err.blancBelongsToAnotherBroker"), { broker });
  }
  // The as-of shift reset names the currency in these messages.
  const asOfPrefixes = [
    [
      "Today's cash is below the midnight balance for ",
      "fixShiftCashBelow",
    ],
    [
      "Cash from brokers is below the midnight balance for ",
      "fixShiftBrokerBelow",
    ],
    [
      "The cash balance at the cutoff is negative for ",
      "fixShiftCutoffNegative",
    ],
  ];
  for (const [prefix, key] of asOfPrefixes) {
    if (text.startsWith(prefix)) {
      return fmt(t(key), { currency: text.slice(prefix.length).trim() });
    }
  }
  return text;
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

// Drop the session and go back to the login page.
//
// `noticeKey` is an i18n key explaining WHY the worker was sent back (expired
// token, token replaced by a newer login). It is stored as a one-shot notice the
// login page shows once, so a forced logout never looks like "the program just
// refuses to let me in".
function redirectToLogin(noticeKey) {
  clearSession();
  try {
    if (noticeKey) localStorage.setItem("loginNotice", noticeKey);
    else localStorage.removeItem("loginNotice");
  } catch {
    // localStorage unavailable: the redirect still has to happen.
  }
  window.bridge.LoadNewPage("renderer/LoginPage/index.html");
}

// Send a client-side event to the main process, which appends it to
// userData/logs/network.log. The DevTools console (Ctrl + ~) is the only trail a
// connection problem leaves today, and a worker in the field cannot read it, so
// the interesting events are mirrored into a file support can collect.
function logEvent(channel, message) {
  try {
    if (window.bridge && typeof window.bridge.LogEvent === "function") {
      window.bridge.LogEvent(channel, message);
    }
  } catch {
    // Logging must never break the page.
  }
}

// How long a single REST request may run before it is aborted. Slow or unstable
// connections would otherwise leave the UI stuck on a request that will never
// finish. GETs are safe to retry, so they also get a couple of automatic
// attempts; mutating requests (POST/PATCH/PUT/DELETE) are never retried because
// a retry could apply the change twice.
const API_TIMEOUT_MS = 45000;
const API_MAX_ATTEMPTS = 3;
const API_RETRY_BASE_MS = 800;

function apiIsRetryable(method) {
  const m = String(method || "GET").toUpperCase();
  return m === "GET" || m === "HEAD";
}

// Fetch helper that attaches the Bearer token and handles 401 globally.
async function api(path, options = {}) {
  const headers = Object.assign(
    { Authorization: `Bearer ${getToken()}` },
    options.headers || {}
  );
  const method = String(options.method || "GET").toUpperCase();
  const retryable = apiIsRetryable(method);
  const attempts = retryable ? API_MAX_ATTEMPTS : 1;

  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) {
      await new Promise((r) =>
        setTimeout(r, API_RETRY_BASE_MS * Math.pow(2, attempt - 1))
      );
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
    let res;
    try {
      res = await fetch(`${API_BASE}${path}`, {
        ...options,
        headers,
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      // Timeout (AbortError) or a network-level failure (fetch rejects with a
      // TypeError when the connection cannot be made). Retry idempotent
      // requests so a momentary blip does not fail the whole operation.
      if (
        retryable &&
        (err.name === "AbortError" || err instanceof TypeError)
      ) {
        lastError = err;
        continue;
      }
      throw err;
    }

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
    clearTimeout(timer);

    if (res.status === 401) {
      redirectToLogin("sessionExpired");
      throw new Error(
        data.error ? translateError(data.error) : t("sessionExpired")
      );
    }
    if (!res.ok) {
      // A transient server-side state (rate limit / 5xx): retry idempotent
      // requests so a momentary server blip does not fail the whole operation.
      if (retryable && (res.status === 429 || res.status >= 500)) {
        lastError = new Error(
          data.error ? translateError(data.error) : `Request failed (${res.status})`
        );
        lastError.status = res.status;
        continue;
      }
      let message = data.error ? translateError(data.error) : "";
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
          `API ${method} ${path} was rejected outside the ` +
            `application: HTTP ${res.status}, server=${
              res.headers.get("server") || "?"
            }, request-id=${res.headers.get("x-hcdn-request-id") || "?"}, ` +
            `body: ${raw.slice(0, 500)}`
        );
      }
      const error = new Error(message);
      error.status = res.status;
      error.code = data.code || null;
      throw error;
    }
    return data;
  }

  // All retries were exhausted on a retryable request: surface the last error.
  if (lastError) throw lastError;
  throw new Error("Request failed");
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

// ---------------------------------------------------------------------------
// Password visibility toggle
//
// One eye icon, one behaviour, everywhere a password is typed. The icon is a
// single outline eye drawn with `currentColor` (so it follows the theme) plus a
// slash that is stroked in when the password becomes readable: a plain eye means
// "masked", an eye with a slash means "readable right now". Geometry, in a
// 0 0 24 24 box:
//   * the lens: two quadratic curves meeting in sharp corners at (2.5 12) and
//     (21.5 12);
//   * the pupil: circle at (12 12) r=2.8;
//   * the slash: 45 degrees through the middle, longer than the lens is wide
//     (~23.2 units) -- app.css animates it with a 24 unit dash.
// The pressed state lives on aria-pressed, which is what the CSS keys off, so
// the icon and the screen-reader state can never disagree.
// ---------------------------------------------------------------------------
const PASSWORD_EYE_ICON_SVG =
  '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
  '<path d="M2.5 12Q6.25 5.6 12 5.6T21.5 12Q17.75 18.4 12 18.4T2.5 12Z"/>' +
  '<circle cx="12" cy="12" r="2.8"/>' +
  '<path class="pw-eye-slash" d="M3.8 3.8 20.2 20.2"/>' +
  "</svg>";

// Wires an eye button to a password input. Returns a handle whose sync() is
// called again after a language switch, because the label is translated.
function setupPasswordToggle(button, input) {
  if (!button || !input) return null;

  function sync() {
    const visible = input.type === "text";
    const label = t(visible ? "hidePassword" : "showPassword");
    button.setAttribute("aria-pressed", visible ? "true" : "false");
    button.setAttribute("aria-label", label);
    button.title = label;
  }

  button.addEventListener("click", () => {
    const visible = input.type === "text";
    // Flipping the type moves the caret to the end in Chromium; put it back so
    // a typo in the middle of the password can be corrected while it is shown.
    const start = input.selectionStart;
    const end = input.selectionEnd;
    const direction = input.selectionDirection;
    input.type = visible ? "password" : "text";
    try {
      if (typeof start === "number") {
        input.setSelectionRange(start, end, direction);
      }
    } catch (err) {
      // Not offered by every input type: the caret position is cosmetic.
    }
    // The click moved focus to the button; hand it back so typing continues.
    if (typeof input.focus === "function") input.focus();
    sync();
  });

  // Start from the field's real state: a page may render it already readable.
  sync();
  return { sync };
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
  const message = err && err.message ? translateError(err.message) : "";
  const base = t(fallbackKey);
  toast(message && message !== base ? `${base}: ${message}` : base, "error");
}

// Handle the server's "email_send_failed" push: the reply to a broker's email
// could not be sent immediately. Tell the worker whether it was queued for
// automatic retry (so they know it is not lost) or failed for good.
function handleEmailSendFailed(msg) {
  const data = (msg && msg.data) || {};
  const email = String(data.recipient || "").trim();
  const queued = data.status === "queued";
  const text = queued
    ? email
      ? fmt(t("emailReplyQueuedTo"), { email })
      : t("emailReplyQueued")
    : email
      ? fmt(t("emailReplyFailedTo"), { email })
      : t("emailReplyFailed");
  toast(text, queued ? "info" : "error");
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

// ---------------------------------------------------------------------------
// End-of-shift reminder (5 minutes before local midnight)
//
// Current cash is not reset automatically: a WORKER must press "End shift" so
// the branch's drawer, card balance and cash from brokers are zeroed and the
// day's report closes. A worker who forgets leaves last night's money sitting
// in today's balances. Admins do not have shifts (and no End shift button), so
// the reminder is not shown to them.
//
// `shiftReminder.js` provides the pure timing helpers; the banner itself lives
// here so every page gets it from one place.
// ---------------------------------------------------------------------------
const SHIFT_REMINDER_DISMISSED_KEY = "shiftReminderDismissedDay";
const SHIFT_REMINDER_PENDING_VIEW_KEY = "shiftReminderOpenCurrentCash";

let shiftReminderTimer = null;
let shiftReminderTick = null;
let shiftReminderNode = null;

function shiftReminderEligible() {
  // Workers only: an admin has no shift to finish. A stale role left on the
  // login page (after a crash, say) must not show a shift reminder over the
  // sign-in form either.
  if (getRole() !== "2") return false;
  return typeof getToken === "function" ? Boolean(getToken()) : true;
}

function shiftReminderTodayKey(now = new Date()) {
  if (typeof shiftReminderDayKey === "function") return shiftReminderDayKey(now);
  const p = (n) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

function hideShiftReminder(markDismissed) {
  if (shiftReminderTick) {
    clearInterval(shiftReminderTick);
    shiftReminderTick = null;
  }
  if (shiftReminderNode) {
    shiftReminderNode.remove();
    shiftReminderNode = null;
  }
  if (markDismissed) {
    try {
      localStorage.setItem(
        SHIFT_REMINDER_DISMISSED_KEY,
        shiftReminderTodayKey(new Date())
      );
    } catch (err) {
      console.warn("Could not remember the dismissed shift reminder:", err);
    }
  }
}

// Update the countdown line every second; after midnight it switches to the
// "finish last night's shift" wording instead of counting down again.
function updateShiftReminderCountdown() {
  if (!shiftReminderNode) return;
  const countdown = shiftReminderNode.querySelector(
    ".shift-reminder-countdown"
  );
  if (!countdown) return;
  const seconds =
    typeof shiftReminderSecondsLeft === "function"
      ? shiftReminderSecondsLeft(new Date())
      : 0;
  if (seconds > 0) {
    countdown.textContent = fmt(t("shiftReminder.remaining"), {
      time: formatShiftCountdown(seconds),
    });
    countdown.classList.remove("overdue");
  } else {
    countdown.textContent = t("shiftReminder.overdue");
    countdown.classList.add("overdue");
  }
}

// Open Current cash so the worker can press "End shift". On the dashboard the
// page installs `window.__openCurrentCash`; on the insurance form the request
// is handed to the dashboard through localStorage and a page load, because the
// form has no Current cash view of its own.
function openCurrentCashForShiftReminder() {
  if (typeof window.__openCurrentCash === "function") {
    hideShiftReminder(true);
    try {
      window.__openCurrentCash();
    } catch (err) {
      console.error("Failed to open Current cash from the shift reminder:", err);
    }
    return;
  }
  // On the insurance form this leaves the page, so make the loss of unsaved
  // form data explicit before navigating away.
  if (!window.confirm(t("shiftReminder.leaveFormConfirm"))) return;
  hideShiftReminder(true);
  try {
    localStorage.setItem(SHIFT_REMINDER_PENDING_VIEW_KEY, "1");
  } catch (err) {
    console.warn("Could not queue the Current cash view:", err);
  }
  if (window.bridge && typeof window.bridge.LoadNewPage === "function") {
    window.bridge.LoadNewPage("renderer/WorkPage/WorkPage.html");
  }
}

// True once the dashboard has been asked (from the reminder) to show Current
// cash. The flag is consumed so a later reload does not jump there again.
function consumeShiftReminderPendingView() {
  try {
    if (localStorage.getItem(SHIFT_REMINDER_PENDING_VIEW_KEY) === "1") {
      localStorage.removeItem(SHIFT_REMINDER_PENDING_VIEW_KEY);
      return true;
    }
  } catch (err) {
    console.warn("Could not read the pending Current cash view:", err);
  }
  return false;
}

function showShiftReminder() {
  if (!shiftReminderEligible() || shiftReminderNode) return;
  if (typeof document === "undefined" || !document.body) return;

  // One dismissal per day is enough; a page opened tomorrow asks again.
  try {
    const dismissed = localStorage.getItem(SHIFT_REMINDER_DISMISSED_KEY);
    if (dismissed && dismissed === shiftReminderTodayKey(new Date())) return;
  } catch (err) {
    console.warn("Could not read the dismissed shift reminder:", err);
  }

  const box = el("div", null, { class: "shift-reminder", role: "alert" });
  box.appendChild(
    el("span", "⏰", { class: "shift-reminder-icon", "aria-hidden": "true" })
  );

  const body = el("div", null, { class: "shift-reminder-body" });
  body.appendChild(
    el("strong", t("shiftReminder.title"), { class: "shift-reminder-title" })
  );
  body.appendChild(
    el("span", t("shiftReminder.body"), { class: "shift-reminder-text" })
  );
  body.appendChild(el("span", "", { class: "shift-reminder-countdown" }));
  box.appendChild(body);

  const actions = el("div", null, { class: "shift-reminder-actions" });
  const canOpenCash =
    typeof window.__openCurrentCash === "function" ||
    (window.bridge && typeof window.bridge.LoadNewPage === "function");
  if (canOpenCash) {
    const endBtn = el("button", t("shiftReminder.endShift"), {
      type: "button",
      class: "small",
    });
    endBtn.addEventListener("click", openCurrentCashForShiftReminder);
    actions.appendChild(endBtn);
  }
  const dismissBtn = el("button", t("shiftReminder.dismiss"), {
    type: "button",
    class: "secondary small",
  });
  dismissBtn.addEventListener("click", () => hideShiftReminder(true));
  actions.appendChild(dismissBtn);
  box.appendChild(actions);

  document.body.appendChild(box);
  shiftReminderNode = box;
  updateShiftReminderCountdown();
  shiftReminderTick = setInterval(updateShiftReminderCountdown, 1000);
}

// Re-render the banner after a language switch (the countdown keeps running).
function refreshShiftReminder() {
  if (!shiftReminderNode) return;
  hideShiftReminder(false);
  showShiftReminder();
}

/**
 * Arm the night's reminder. `reference` is an optional time to measure from
 * (defaults to now); `useNext` targets tomorrow's 23:55 even when called inside
 * tonight's window, which is how the timer re-arms after firing without
 * looping.
 */
function scheduleShiftReminder(reference, useNext) {
  if (shiftReminderTimer) {
    clearTimeout(shiftReminderTimer);
    shiftReminderTimer = null;
  }
  if (!shiftReminderEligible() || typeof shiftMsUntilReminder !== "function") {
    return;
  }
  // Resolve the reference time only after the guards: on a page without the
  // timing helpers (or in a test harness without a Date constructor) there is
  // nothing to schedule and no date to build.
  const now =
    reference === undefined
      ? new Date()
      : reference instanceof Date
        ? reference
        : new Date(reference);
  const delay =
    useNext && typeof shiftMsUntilNextReminder === "function"
      ? shiftMsUntilNextReminder(now)
      : Math.max(0, shiftMsUntilReminder(now));
  shiftReminderTimer = setTimeout(() => {
    shiftReminderTimer = null;
    showShiftReminder();
    // Arm the following night explicitly: at 23:55 `shiftMsUntilReminder`
    // is 0, so re-using it here would fire the banner again immediately.
    scheduleShiftReminder(undefined, true);
  }, delay);
}

function startShiftReminder() {
  if (!shiftReminderEligible()) return;
  scheduleShiftReminder();
}

// Deferred scripts run before DOMContentLoaded, so waiting for it lets the
// dashboard install window.__openCurrentCash first and the banner offer its
// "Finish shift" shortcut right away.
if (typeof document !== "undefined") {
  if (document.readyState === "loading" || document.readyState === "interactive") {
    document.addEventListener("DOMContentLoaded", startShiftReminder);
  } else {
    startShiftReminder();
  }
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
const outboxCompletingIds = new Set();

// Durable queue of email WebSocket actions (`release_email` / `complete_email`)
// that were issued right as a page was unloading while the socket was offline
// or still authenticating. Flushed on the next authenticated connection.
const PENDING_EMAIL_WS_ACTIONS_KEY = "pendingEmailWsActions";
const PENDING_EMAIL_WS_ACTIONS_TTL_MS = 24 * 60 * 60 * 1000;

function loadDurableEmailWsActions() {
  try {
    const raw = localStorage.getItem(PENDING_EMAIL_WS_ACTIONS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const now = Date.now();
    return parsed.filter(
      (a) =>
        a &&
        typeof a.type === "string" &&
        typeof a.messageId === "string" &&
        a.messageId &&
        now - (Number(a.queuedAt) || 0) < PENDING_EMAIL_WS_ACTIONS_TTL_MS
    );
  } catch {
    return [];
  }
}

function saveDurableEmailWsActions(actions) {
  try {
    if (!actions || actions.length === 0) {
      localStorage.removeItem(PENDING_EMAIL_WS_ACTIONS_KEY);
    } else {
      localStorage.setItem(PENDING_EMAIL_WS_ACTIONS_KEY, JSON.stringify(actions));
    }
  } catch {
    // ignore storage errors
  }
}

function queueDurableEmailWsAction(action) {
  if (!action || !action.type || !action.messageId) return;
  const list = loadDurableEmailWsActions().filter(
    (a) => a.messageId !== action.messageId
  );
  list.push({
    type: action.type,
    messageId: action.messageId,
    queuedAt: Date.now(),
  });
  saveDurableEmailWsActions(list);
}

function clearDurableEmailWsAction(messageId) {
  if (!messageId) return;
  const list = loadDurableEmailWsActions();
  const next = list.filter((a) => a.messageId !== messageId);
  if (next.length !== list.length) saveDurableEmailWsActions(next);
}

function flushDurableEmailWsActions(socket) {
  if (!socket || typeof socket.isReady !== "function" || !socket.isReady()) {
    return;
  }
  const list = loadDurableEmailWsActions();
  if (!list.length) return;
  const remaining = [];
  for (const action of list) {
    try {
      socket.send({ type: action.type, messageId: action.messageId });
    } catch {
      remaining.push(action);
    }
  }
  saveDurableEmailWsActions(remaining);
}

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
        if (outboxCompletingIds.has(item.id)) continue;
        outboxCompletingIds.add(item.id);
        // Delivered: mark the email handled everywhere, then forget the item.
        socket.send({ type: "complete_email", messageId: item.messageId });
        clearDurableEmailWsAction(item.messageId);
        outboxClaimedEmails.delete(item.messageId);
        window.bridge
          .OutboxAcknowledge(item.id)
          .catch((err) => {
            outboxCompletingIds.delete(item.id);
            console.error("Failed to acknowledge outbox item:", err);
          });
      } else if (!outboxClaimedEmails.has(item.messageId)) {
        // Still queued: keep the email reserved so nobody handles it twice.
        clearDurableEmailWsAction(item.messageId);
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
  outboxCompletingIds.clear();
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
// Auto-update banner
//
// While electron-updater downloads a release (main process), a strip across the
// top of the window shows the live percentage with a progress line along its
// bottom edge. When the download has finished the strip turns green and carries
// the "Restart now" / "Later" buttons - they replaced the native dialog, which
// interrupted whatever the worker was typing.
//
// The state is owned by the main process (SetupAutoUpdater in main.js) because a
// page change destroys this renderer: every page asks for the current state on
// load and then follows the broadcasts, so the banner is already on screen when
// the next page appears.
// ---------------------------------------------------------------------------
let updateBannerNode = null;
let updateBannerState = null;
let updateBannerPhase = null;

function updateBannerAvailable() {
  return !!(window.bridge && typeof window.bridge.UpdateGetState === "function");
}

// Whole percent downloaded so far, or null while the total size is unknown.
function updateBannerPercent(state) {
  const raw = state ? state.percent : null;
  if (raw === null || raw === undefined) return null;
  const value = Number(raw);
  if (!Number.isFinite(value)) return null;
  return Math.max(0, Math.min(100, Math.round(value)));
}

// The release name from the main process, with a readable stand-in so a missing
// version never leaves a literal "{version}" in the banner.
function updateBannerVersion(state) {
  const version = state && state.version ? String(state.version).trim() : "";
  return version || t("update.unknownVersion");
}

// Build the banner once. Later updates only rewrite its text and classes, so the
// entrance animation does not restart on every progress tick.
function ensureUpdateBanner() {
  if (updateBannerNode || !document.body) return;
  const box = el("div", null, {
    id: "UpdateBanner",
    class: "update-banner hidden",
    role: "status",
    "aria-live": "polite",
    "aria-atomic": "true",
  });
  box.appendChild(
    el("span", "↓", { class: "update-banner-icon", "aria-hidden": "true" })
  );
  box.appendChild(el("span", "", { class: "update-banner-text" }));
  box.appendChild(el("div", null, { class: "update-banner-actions" }));
  const track = el("div", null, {
    class: "update-banner-track",
    "aria-hidden": "true",
  });
  track.appendChild(el("div", "", { class: "update-banner-fill" }));
  box.appendChild(track);
  document.body.appendChild(box);
  updateBannerNode = box;
}

// "Restart now" / "Later" - only in the finished state. Rebuilt when the phase
// changes (and on a language switch), not on every progress update.
function renderUpdateBannerActions(box, ready) {
  const actions = box.querySelector(".update-banner-actions");
  if (!actions) return;
  actions.replaceChildren();
  if (!ready) return;
  if (!window.bridge || typeof window.bridge.UpdateInstall !== "function") return;

  const restart = el("button", t("update.restartNow"), {
    type: "button",
    class: "update-btn-primary",
  });
  const later = el("button", t("update.later"), {
    type: "button",
    class: "update-btn-later",
  });

  restart.addEventListener("click", async () => {
    restart.disabled = true;
    later.disabled = true;
    restart.textContent = t("update.restarting");
    try {
      const result = await window.bridge.UpdateInstall();
      if (result && result.ok === false) {
        throw new Error(result.error || "Restart refused");
      }
      // The main process quits and installs the update; nothing else to do here.
    } catch (err) {
      console.error("Could not restart for the update:", err);
      restart.disabled = false;
      later.disabled = false;
      restart.textContent = t("update.restartNow");
      toast(t("update.restartFailed"), "error");
    }
  });

  later.addEventListener("click", () => {
    // The banner goes away for this version and the update installs the next
    // time the app closes (autoInstallOnAppQuit in main.js). A newer release
    // asks again.
    Promise.resolve(window.bridge.UpdateDismiss()).catch((err) =>
      console.error("Could not dismiss the update banner:", err)
    );
  });

  actions.appendChild(restart);
  actions.appendChild(later);
}

function renderUpdateBanner() {
  const state = updateBannerState;
  const phase =
    state && state.phase === "ready"
      ? "ready"
      : state && state.phase === "downloading"
        ? "downloading"
        : "idle";
  const visible = phase !== "idle";

  ensureUpdateBanner();
  // The banner covers the top of the window, so the page header (and toasts) are
  // pushed below it while it is on screen - see app.css.
  if (document.documentElement && document.documentElement.classList) {
    document.documentElement.classList.toggle("update-banner-open", visible);
  }

  const box = updateBannerNode;
  if (!box) return;
  box.classList.toggle("hidden", !visible);
  if (!visible) {
    updateBannerPhase = null;
    return;
  }

  const phaseChanged = updateBannerPhase !== phase;
  updateBannerPhase = phase;
  const ready = phase === "ready";
  box.classList.toggle("ready", ready);
  box.classList.toggle("downloading", !ready);

  const percent = ready ? 100 : updateBannerPercent(state);
  const version = updateBannerVersion(state);

  const icon = box.querySelector(".update-banner-icon");
  if (icon) icon.textContent = ready ? "✔" : "↓";
  const text = box.querySelector(".update-banner-text");
  if (text) {
    text.textContent = ready
      ? fmt(t("update.ready"), { version })
      : percent === null
        ? fmt(t("update.downloadingUnknown"), { version })
        : fmt(t("update.downloading"), { version, percent });
  }
  box.title = ready ? t("update.readyHint") : "";

  // The progress line. A download whose total size is unknown sweeps instead of
  // standing at a percentage nobody measured.
  box.classList.toggle("indeterminate", !ready && percent === null);
  const fill = box.querySelector(".update-banner-fill");
  if (fill) fill.style.width = ready || percent === null ? "" : `${percent}%`;

  if (phaseChanged) renderUpdateBannerActions(box, ready);
}

function applyUpdateBannerState(state) {
  updateBannerState = state || null;
  renderUpdateBanner();
}

// Re-render after a language switch: the text and the button labels are
// translated (the progress itself does not change).
function refreshUpdateBanner() {
  if (!updateBannerNode) return;
  updateBannerPhase = null; // rebuild the buttons with the new labels
  renderUpdateBanner();
}

// The banner lives on every page, so this runs wherever common.js is loaded. A
// plain browser (no preload bridge) simply never shows it.
function initUpdateBanner() {
  if (!updateBannerAvailable()) return;
  window.bridge.OnUpdateState(applyUpdateBannerState);
  window.bridge
    .UpdateGetState()
    .then((state) => {
      // A broadcast may already have described a newer moment; it wins.
      if (!updateBannerState) applyUpdateBannerState(state);
    })
    .catch((err) => console.error("Failed to read the update state:", err));
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

// A handshake failure triggers a short burst of raw upgrade probes rather than
// a single one. The 307 the app sees is intermittent (edge- or time-specific),
// so one probe usually answers 101 and misses the redirect entirely; a few
// staggered attempts catch its Location header often enough to matter.
const WS_PROBE_ATTEMPTS = 4;
const WS_PROBE_RETRY_MS = 250;

// Timeout bounds for connection setup and background liveness checks.
const WS_HANDSHAKE_TIMEOUT_MS = 12000;
const WS_AUTH_TIMEOUT_MS = 10000;
const WS_PING_INTERVAL_MS = 20000;
const WS_PONG_TIMEOUT_MS = 10000;
const WS_RECONNECT_BASE_MS = 1000;
const WS_RECONNECT_MAX_MS = 20000;

function normalizeWsUrl(rawUrl, baseUrl) {
  try {
    const u = new URL(rawUrl, baseUrl);
    if (u.protocol === "https:") u.protocol = "wss:";
    else if (u.protocol === "http:") u.protocol = "ws:";
    return u.href;
  } catch {
    return null;
  }
}

class UnreadEmailSocket {
  constructor(handlers = {}) {
    this.handlers = handlers;
    this.ws = null;
    this.authed = false;
    this.pending = [];
    this.reconnectDelay = WS_RECONNECT_BASE_MS;
    this.reconnectTimer = null;
    this.handshakeTimer = null;
    this.authTimer = null;
    this.pingTimer = null;
    this.pongTimer = null;
    this.lastReceivedAt = 0;
    this.connectStartedAt = 0;
    this.manuallyClosed = false;
    // Consecutive attempts that never reached the authenticated state.
    this.failedAttempts = 0;
    this.outageReported = false;
    this.probing = false;
    this.wsUrl = WS_URL;
    this.diagnoseInFlight = false;
    this.redirectCandidate = null;
    this.redirectSeen = 0;

    this._onOnline = () => {
      if (this.manuallyClosed) return;
      this.reconnectDelay = WS_RECONNECT_BASE_MS;
      if (!this.ws) {
        this.reconnectNow();
      } else if (
        this.ws.readyState === WebSocket.CONNECTING &&
        Date.now() - this.connectStartedAt > 3000
      ) {
        this.reconnectNow();
      } else if (this.authed && this.ws.readyState === WebSocket.OPEN) {
        this.sendPing(this.ws, 5000);
      }
    };

    this._onVisibilityChange = () => {
      if (this.manuallyClosed) return;
      if (
        typeof document !== "undefined" &&
        document.visibilityState !== "visible"
      ) {
        return;
      }
      if (!this.ws) {
        this.ensureConnected();
      } else if (
        this.authed &&
        this.ws.readyState === WebSocket.OPEN &&
        Date.now() - this.lastReceivedAt >= WS_PING_INTERVAL_MS
      ) {
        this.sendPing(this.ws, 5000);
      }
    };

    if (typeof window !== "undefined" && window.addEventListener) {
      window.addEventListener("online", this._onOnline);
    }
    if (typeof document !== "undefined" && document.addEventListener) {
      document.addEventListener("visibilitychange", this._onVisibilityChange);
    }
  }

  clearSocketTimers() {
    if (this.handshakeTimer) {
      clearTimeout(this.handshakeTimer);
      this.handshakeTimer = null;
    }
    if (this.authTimer) {
      clearTimeout(this.authTimer);
      this.authTimer = null;
    }
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.pongTimer) {
      clearTimeout(this.pongTimer);
      this.pongTimer = null;
    }
  }

  startHeartbeat(ws) {
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.pongTimer) {
      clearTimeout(this.pongTimer);
      this.pongTimer = null;
    }
    this.pingTimer = setInterval(() => {
      if (this.ws !== ws || !this.authed || ws.readyState !== WebSocket.OPEN) {
        return;
      }
      this.sendPing(ws, WS_PONG_TIMEOUT_MS);
    }, WS_PING_INTERVAL_MS);
  }

  sendPing(ws, timeoutMs = WS_PONG_TIMEOUT_MS) {
    if (this.ws !== ws || !this.authed || ws.readyState !== WebSocket.OPEN) {
      return;
    }
    if (this.pongTimer) return;
    const pingSentAt = Date.now();
    try {
      ws.send(JSON.stringify({ type: "ping", ts: pingSentAt }));
    } catch (err) {
      console.warn("Email WebSocket ping send failed; reconnecting:", err);
      this.reconnectNow();
      return;
    }
    this.pongTimer = setTimeout(() => {
      this.pongTimer = null;
      if (this.ws !== ws) return;
      if (this.lastReceivedAt >= pingSentAt) return;
      console.warn(
        `Email WebSocket heartbeat timed out after ${timeoutMs} ms; reconnecting`
      );
      this.reconnectNow();
    }, timeoutMs);
  }

  connect() {
    if (this.ws) return;
    this.manuallyClosed = false;
    this.clearSocketTimers();

    let ws;
    try {
      ws = new WebSocket(this.wsUrl);
    } catch (err) {
      console.error("WebSocket error:", err);
      // A 403/failed upgrade is part of the same incident the HTTP diagnostics
      // track, so record it there too (the browser hides the status code).
      try {
        if (window.Diag && typeof window.Diag.noteWebSocketFailure === "function") {
          window.Diag.noteWebSocketFailure(
            this.wsUrl,
            `constructor failed: ${(err && err.message) || err}`
          );
        }
      } catch {
        // Diagnostics must never break reconnection.
      }
      if (this.handlers.close) this.handlers.close(err);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    this.connectStartedAt = Date.now();

    // Distinguishes "the handshake never completed" from "an established
    // connection dropped later". Only the former means the upgrade itself was
    // refused (e.g. a 3xx from the reverse proxy instead of 101).
    let opened = false;

    this.handshakeTimer = setTimeout(() => {
      this.handshakeTimer = null;
      if (this.ws !== ws || opened) return;
      console.warn(
        `Email WebSocket handshake timed out after ${WS_HANDSHAKE_TIMEOUT_MS} ms; aborting`
      );
      try {
        ws.close();
      } catch {
        // ignore
      }
    }, WS_HANDSHAKE_TIMEOUT_MS);

    ws.addEventListener("open", () => {
      if (this.ws !== ws) return;
      opened = true;
      this.lastReceivedAt = Date.now();
      if (this.handshakeTimer) {
        clearTimeout(this.handshakeTimer);
        this.handshakeTimer = null;
      }
      this.authTimer = setTimeout(() => {
        this.authTimer = null;
        if (this.ws !== ws || this.authed) return;
        console.warn(
          `Email WebSocket auth timed out after ${WS_AUTH_TIMEOUT_MS} ms; reconnecting`
        );
        this.reconnectNow();
      }, WS_AUTH_TIMEOUT_MS);
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
      this.lastReceivedAt = Date.now();
      if (this.pongTimer) {
        clearTimeout(this.pongTimer);
        this.pongTimer = null;
      }
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch (err) {
        console.error("Failed to parse email WebSocket message:", err);
        return;
      }

      if (msg.type === "pong") {
        return;
      }

      if (msg.type === "auth_ok") {
        if (this.authTimer) {
          clearTimeout(this.authTimer);
          this.authTimer = null;
        }
        // Reset backoff and outage state only once end-to-end auth succeeds.
        this.reconnectDelay = WS_RECONNECT_BASE_MS;
        this.failedAttempts = 0;
        this.outageReported = false;
        this.authed = true;
        this.startHeartbeat(ws);
        this.flush();
        try {
          if (this.handlers.auth_ok) this.handlers.auth_ok(msg);
        } catch (err) {
          console.error("Email WebSocket auth_ok handler failed:", err);
        }
        return;
      }

      if (msg.type === "auth_error") {
        if (this.authTimer) {
          clearTimeout(this.authTimer);
          this.authTimer = null;
        }
        try {
          if (this.handlers.auth_error) this.handlers.auth_error(msg);
          else redirectToLogin("sessionExpired");
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
      this.clearSocketTimers();
      this.ws = null;
      this.authed = false;
      if (this.handlers.close) this.handlers.close();

      if (!opened) {
        // The handshake never completed. This is what a redirect looks like
        // from here: the browser reports "Unexpected response code: 307" (or
        // any other non-101 status) and the socket never opens.
        this.failedAttempts += 1;
        if (
          this.wsUrl !== WS_URL &&
          this.failedAttempts >= WS_OUTAGE_REPORT_AFTER
        ) {
          console.warn(
            `[ws] redirect target ${this.wsUrl} failed ${this.failedAttempts} times; reverting to ${WS_URL}`
          );
          this.wsUrl = WS_URL;
        }
        console.error(
          `Email WebSocket handshake failed for ${this.wsUrl} ` +
            `(attempt ${this.failedAttempts}, retrying in ${this.reconnectDelay} ms)`
        );
        try {
          if (
            window.Diag &&
            typeof window.Diag.noteWebSocketFailure === "function"
          ) {
            window.Diag.noteWebSocketFailure(
              this.wsUrl,
              `handshake failed (attempt ${this.failedAttempts})`
            );
          }
        } catch {
          // Diagnostics must never break reconnection.
        }
        this.reportOutage();
        this.diagnoseHandshakeFailure();
      }
      this.scheduleReconnect();
    });

    ws.addEventListener("error", (event) => {
      // A close event follows and resets connection state. The event itself
      // carries no detail, so log the target URL alongside it: a refused
      // handshake and a dropped connection look identical otherwise.
      console.error(`Email WebSocket error (${this.wsUrl}):`, event);
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

  // A handshake failed (e.g. "Unexpected response code: 307"). Ask the main
  // process to do a raw upgrade so we can see the status + Location the browser
  // WebSocket API hides. This also tells us WHO is redirecting: `server: hcdn`
  // means Hostinger's CDN; anything else points at a client-side proxy/AV/TLS
  // inspector. A stable redirect target is adopted automatically (the browser
  // refuses to follow WebSocket redirects, so we follow it ourselves).
  //
  // The probe runs a short burst of attempts (not just one) because the 307 is
  // intermittent. Each result is logged with its attempt number, so the
  // incident trail shows the status + Location + server for every try.
  async diagnoseHandshakeFailure() {
    if (!window.bridge || typeof window.bridge.WsHandshakeProbe !== "function") {
      return;
    }
    if (this.diagnoseInFlight) return;
    this.diagnoseInFlight = true;
    try {
      for (let attempt = 1; attempt <= WS_PROBE_ATTEMPTS; attempt++) {
        let r;
        try {
          r = await window.bridge.WsHandshakeProbe();
        } catch (err) {
          console.error("[ws] handshake probe failed:", err);
          r = null;
        }
        if (!r) continue; // bridge-side failure; retry on the next attempt

        // Network-level failures (timeout / connect error) cannot reveal a
        // redirect on a retry, so report once and stop the burst early.
        if (typeof r.status !== "number") {
          console.warn(
            `[ws] handshake probe ${attempt}/${WS_PROBE_ATTEMPTS}: ` +
              `${r.status}${r.error ? ` (${r.error})` : ""} - server unreachable`
          );
          break;
        }

        this.logHandshakeProbeResult(attempt, WS_PROBE_ATTEMPTS, r);

        // Adopt a redirect target once it has been observed consistently. The
        // burst means the 307's Location header is captured even though a
        // single probe usually answers 101.
        if (r.status >= 300 && r.status < 400 && r.location) {
          const normalized = normalizeWsUrl(r.location, this.wsUrl);
          if (normalized) this.registerRedirect(normalized);
          else console.error("[ws] bad redirect location:", r.location);
        }

        if (attempt < WS_PROBE_ATTEMPTS) {
          await new Promise((resolve) => setTimeout(resolve, WS_PROBE_RETRY_MS));
        }
      }
    } finally {
      this.diagnoseInFlight = false;
    }
  }

  // Format and log one raw-upgrade probe result. Kept as its own method so the
  // burst can print each attempt's status + Location + server clearly during an
  // incident, instead of a single aggregate line.
  logHandshakeProbeResult(attempt, total, r) {
    const viaHcdn = String(r.server || "").toLowerCase() === "hcdn";
    // Interpret the raw result honestly. A 101 is a *successful* upgrade, so a
    // browser failure that the probe answers with 101 was transient (or hit a
    // different CDN edge) and is NOT a block. Only a 3xx is a redirect; any
    // other non-101 status is a genuine block.
    const verdict =
      r.status === 101
        ? "raw upgrade succeeded - browser failure was transient/edge-specific"
        : r.status >= 300 && r.status < 400
        ? viaHcdn
          ? "redirect from Hostinger CDN"
          : "redirect, NOT hcdn - likely a client-side proxy/AV/TLS inspector"
        : viaHcdn
        ? "blocked by Hostinger CDN"
        : "blocked, NOT hcdn - likely a client-side proxy/AV/TLS inspector";
    console.warn(
      `[ws] handshake probe ${attempt}/${total}: status=${r.status}` +
        (r.location ? ` location=${r.location}` : "") +
        (r.server ? ` server=${r.server}` : "") +
        (r.requestId ? ` requestId=${r.requestId}` : "") +
        `  (${verdict})`
    );
  }

  // Follow a redirect target only after seeing it twice in a row (a single
  // observation could be a one-off; two means the CDN is consistently pointing
  // somewhere else and we should stop fighting it).
  registerRedirect(target) {
    const normalized = normalizeWsUrl(target, this.wsUrl);
    if (!normalized || normalized === this.wsUrl) return;
    if (this.redirectCandidate !== normalized) {
      this.redirectCandidate = normalized;
      this.redirectSeen = 1;
      return;
    }
    this.redirectSeen += 1;
    if (this.redirectSeen >= 2) {
      console.warn(`[ws] adopting stable redirect target: ${normalized}`);
      this.wsUrl = normalized;
      this.redirectCandidate = null;
      this.redirectSeen = 0;
      this.reconnectNow();
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
  // progress (the user is actively waiting on the socket). Also replaces a
  // socket that has been stuck in CONNECTING for several seconds or probes an
  // idle connection.
  ensureConnected() {
    if (this.manuallyClosed) return;
    if (!this.ws) {
      this.reconnectNow();
      return;
    }
    if (
      this.ws.readyState === WebSocket.CLOSING ||
      this.ws.readyState === WebSocket.CLOSED
    ) {
      this.reconnectNow();
      return;
    }
    if (
      this.ws.readyState === WebSocket.CONNECTING &&
      Date.now() - this.connectStartedAt > 5000
    ) {
      this.reconnectNow();
      return;
    }
    if (
      this.authed &&
      this.ws.readyState === WebSocket.OPEN &&
      Date.now() - this.lastReceivedAt >= WS_PING_INTERVAL_MS
    ) {
      this.sendPing(this.ws, 4000);
    }
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
    this.clearSocketTimers();
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
    this.reconnectDelay = WS_RECONNECT_BASE_MS;
    this.connect();
  }

  scheduleReconnect() {
    if (this.manuallyClosed || this.reconnectTimer) return;
    // Add +/-20% jitter so multiple clients / tabs do not reconnect in lockstep.
    const jitter = 0.8 + Math.random() * 0.4;
    const delay = Math.max(250, Math.round(this.reconnectDelay * jitter));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
    this.reconnectDelay = Math.min(
      this.reconnectDelay * 2,
      WS_RECONNECT_MAX_MS
    );
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
    flushDurableEmailWsActions(this);
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
    this.clearSocketTimers();
    if (typeof window !== "undefined" && window.removeEventListener) {
      window.removeEventListener("online", this._onOnline);
    }
    if (typeof document !== "undefined" && document.removeEventListener) {
      document.removeEventListener("visibilitychange", this._onVisibilityChange);
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
// Auto-update banner (hidden unless a release is being downloaded / is ready).
initUpdateBanner();
