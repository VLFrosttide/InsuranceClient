"use strict";

// Static wiring test: the Diagnostics tab and the client recorder must be
// loaded/wired exactly once and on every page.
//
// The behaviour is covered by clientDiagnostics.test.cjs and
// clientDiagnosticsServer.test.cjs; this test catches the mistakes those cannot
// see - a page that forgets to load diag.js, a missing bridge method, a nav
// entry that points at a function that does not exist.
//
// Run with:  node test/server/diagnosticsAdminUI.test.cjs

const fs = require("fs");
const path = require("path");
const { serverFile } = require("../serverPath.cjs");

const ROOT = path.join(__dirname, "..", "..");
const read = (...parts) =>
  fs.readFileSync(path.join(ROOT, ...parts), "utf8");

let passed = 0;
let failed = 0;
function ok(value, label) {
  if (value) {
    passed++;
    console.log("  PASS  " + label);
  } else {
    failed++;
    console.error("  FAIL  " + label);
  }
}

const workPage = read("renderer", "WorkPage", "WorkPage.js");
const common = read("renderer", "common.js");
const preload = read("renderer", "preload.js");
const main = read("src", "main.js");

// --- The admin tab ----------------------------------------------------------
ok(
  workPage.includes('{ key: "nav.diagnostics", load: adminDiagnostics }'),
  "admin nav entry points at adminDiagnostics"
);
ok(
  /async function adminDiagnostics\(\)/.test(workPage),
  "adminDiagnostics() is defined"
);
ok(
  workPage.includes('"/admin/diagnostics?limit=100"'),
  "the tab reads GET /admin/diagnostics"
);
ok(
  workPage.includes('api("/admin/diagnostics/context")'),
  "the tab reads GET /admin/diagnostics/context"
);
ok(
  workPage.includes('method: "DELETE"') &&
    workPage.includes('body: JSON.stringify({ all: true })'),
  "Delete all issues DELETE /admin/diagnostics { all: true }"
);
ok(
  workPage.includes('window.Diag.flush()'),
  "the tab can flush this PC's local queue"
);

// --- Translations for every new label --------------------------------------
for (const key of [
  "diag.title",
  "diag.hint",
  "diag.refresh",
  "diag.download",
  "diag.clear",
  "diag.details",
  "diag.serverContext",
  "diag.polling",
  // The collection switch inside the tab, and the renamed daily figures.
  "diag.collect",
  "diag.collectToggle",
  "diag.collectHint",
  "diag.collectingOn",
  "diag.collectingOff",
  "settingsSaved",
  "totalDailyBalance",
  "availableCash",
  "payment.cardCash",
]) {
  const occurrences =
    common.split(`${key}:`).length - 1 + (common.split(`"${key}":`).length - 1);
  ok(occurrences >= 2, `translated in both languages: ${key}`);
}

// --- The collection switch lives inside the Diagnostics tab ----------------
ok(
  /async function adminDiagnostics\(\)/.test(workPage) &&
    workPage.indexOf('t("diag.collectToggle")') > workPage.indexOf("async function adminDiagnostics()"),
  "the switch is rendered by the Diagnostics tab"
);
ok(
  workPage.includes('api("/admin/diagnostics/settings")'),
  "the tab reads GET /admin/diagnostics/settings"
);
ok(
  workPage.includes('body: JSON.stringify({ enabled: wanted })'),
  "the switch saves PUT /admin/diagnostics/settings"
);
ok(
  !workPage.includes('d.key !== "nav.diagnostics"'),
  "the Diagnostics tab is never hidden from the navigation"
);

// --- diag.js is loaded before common.js on every page ----------------------
for (const page of [
  ["renderer", "LoginPage", "index.html"],
  ["renderer", "WorkPage", "WorkPage.html"],
  ["renderer", "AddInsurance", "AddInsurance.html"],
  ["renderer", "AdminInsurance", "AdminInsurance.html"],
]) {
  const html = read(...page);
  const diagAt = html.indexOf('<script src="../diag.js"');
  const commonAt = html.indexOf('<script src="../common.js"');
  const label = page.join("/");
  ok(diagAt !== -1, `${label} loads diag.js`);
  ok(
    diagAt !== -1 && commonAt !== -1 && diagAt < commonAt,
    `${label} loads diag.js before common.js`
  );
}

// --- Bridge + main process wiring -----------------------------------------
ok(
  preload.includes('ipcRenderer.invoke("DiagQueueRead")'),
  "preload exposes DiagRead"
);
ok(
  preload.includes('ipcRenderer.invoke("DiagQueueSave", queue)'),
  "preload exposes DiagSave"
);
ok(
  preload.includes('ipcRenderer.invoke("DiagContext", force === true)'),
  "preload exposes DiagContext"
);
ok(
  main.includes('ipcMain.handle("DiagQueueRead"') &&
    main.includes('ipcMain.handle("DiagQueueSave"') &&
    main.includes('ipcMain.handle("DiagContext"'),
  "main process registers the diag IPC handlers"
);
ok(
  main.includes('path.join(app.getPath("userData"), "diag")'),
  "the queue lives under userData/diag"
);
ok(
  main.includes("resolveProxy(OUTBOX_DEFAULT_ORIGIN)"),
  "the environment records the resolved proxy"
);
ok(
  main.includes("api.ipify.org"),
  "the environment records the public IP"
);
ok(
  main.includes("getPeerCertificate()"),
  "the environment records the TLS certificate issuer"
);

// --- Server mount ----------------------------------------------------------
const serverMain = fs.readFileSync(serverFile("main.js"), "utf8");
ok(
  serverMain.includes("createDiagnosticsRouter") &&
    serverMain.includes("pollingStats"),
  "server mounts the diagnostics router with polling stats"
);
ok(
  serverMain.includes("origin: req.headers.origin"),
  "server logs the request origin"
);

const setup = fs.readFileSync(serverFile("db", "setup.js"), "utf8");
ok(
  setup.includes("CREATE TABLE IF NOT EXISTS client_diagnostics"),
  "client_diagnostics is created by db/setup.js"
);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
