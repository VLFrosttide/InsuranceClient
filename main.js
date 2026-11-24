"use strict";
//Starts with: npm start

import {
  app,
  BrowserWindow,
  globalShortcut,
  screen,
  ipcMain,
  Menu,
  nativeTheme,
  dialog,
  shell,
  powerMonitor,
  net,
  session,
} from "electron";
import path from "path";
import fs from "fs";
import os from "node:os";
import https from "node:https";
import dnsLookup from "node:dns";
import crypto from "node:crypto";
import electronUpdater from "electron-updater";
import { Outbox } from "./outbox.js";
import { BulinsController } from "./bulins.js";
import { ScanWatcher, ensureOcrLanguages } from "./scans.js";
import { pdfFields } from "./pdfFields.js";
import {
  desktopPdfAlreadyHandled,
  desktopPdfBelongsToForm,
  desktopPdfIdentity,
} from "./desktopPdfWatch.js";
import { API } from "./config.js";
const { autoUpdater } = electronUpdater;
let win;
let PreloadPath = path.join(app.getAppPath(), "/renderer/preload.js");

// The API host is defined once in config.js; the CSP, the outbox allow-list,
// the diagnostics and the renderer all use these values.
console.log(`[API] Using ${API.apiBase} (WebSocket ${API.wsUrl})`);

// The app's release number (package.json "version"). Reading package.json
// directly keeps this accurate in both `npm start` (unpackaged) and the
// packaged build, where `app.getVersion()` would report Electron's own version
// during development instead of the app's release number.
let APP_VERSION = "";
try {
  APP_VERSION = JSON.parse(
    fs.readFileSync(path.join(app.getAppPath(), "package.json"), "utf8")
  ).version;
} catch {
  APP_VERSION = app.getVersion();
}

// Surface the release number in the process name so it is easy to confirm
// which build is actually running (Task Manager / process list).
process.title = `Insurance ${APP_VERSION}`;

const CreateWindow = () => {
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    x: 60,
    y: 40,
    title: `Insurance ${APP_VERSION}`,

    webPreferences: {
      nodeIntegration: false,
      sandbox: true,
      contextIsolation: true,
      preload: PreloadPath,
      // Built from config.js: connect-src lists the API/WebSocket host and the
      // local dev server, so the policy never has to be edited by hand.
      contentSecurityPolicy: API.csp,
      // --api-base / --ws-url for renderer/preload.js (window.bridge.ApiBase).
      additionalArguments: API.rendererArgs,
    },
  });

  win.loadFile("renderer/LoginPage/index.html");
  GuardWindowClose(win);

  // Keep the release number visible in the title bar even after a page sets
  // its own document title (e.g. "Insurance - Login").
  win.on("page-title-updated", (event) => {
    event.preventDefault();
    win.setTitle(`Insurance ${APP_VERSION}`);
  });

  // Ctrl + ~ (backquote) toggles DevTools. The application menu is removed, so
  // its built-in accelerator is unavailable; handle the key directly instead.
  win.webContents.on("before-input-event", (event, input) => {
    if (
      input.type === "keyDown" &&
      input.control &&
      !input.alt &&
      (input.code === "Backquote" || input.key === "`" || input.key === "~")
    ) {
      win.webContents.toggleDevTools();
      event.preventDefault();
    }
  });

  // Right-click context menu with a "Copy" action, available on every page of
  // the app. The application menu is removed, so Electron shows no menu on
  // right-click by default; build one on demand instead.
  win.webContents.on("context-menu", (event, params) => {
    ShowContextMenu(win, params);
  });
};

// Labels for the right-click menu, following the language chosen in the UI
// (stored by renderer/common.js in localStorage under "lang", default "bg").
const CONTEXT_MENU_LABELS = {
  bg: { copy: "Копирай", paste: "Постави" },
  en: { copy: "Copy", paste: "Paste" },
};

const ShowContextMenu = async (targetWin, params) => {
  let lang = "bg";
  try {
    const stored = await targetWin.webContents.executeJavaScript(
      'localStorage.getItem("lang")',
      true
    );
    if (stored && CONTEXT_MENU_LABELS[stored]) lang = stored;
  } catch {
    // Page not ready / navigating — fall back to the default language.
  }

  if (targetWin.isDestroyed()) return;

  const labels = CONTEXT_MENU_LABELS[lang];
  const hasSelection =
    Boolean(params.selectionText && params.selectionText.trim()) ||
    Boolean(params.editFlags && params.editFlags.canCopy);

  // Paste is available when there is something in the clipboard that can be
  // inserted into the focused editable element.
  const canPaste = Boolean(params.editFlags && params.editFlags.canPaste);

  const menu = Menu.buildFromTemplate([
    {
      label: labels.copy,
      role: "copy",
      accelerator: "CmdOrCtrl+C",
      enabled: hasSelection,
    },
    {
      label: labels.paste,
      role: "paste",
      accelerator: "CmdOrCtrl+V",
      enabled: canPaste,
    },
  ]);
  menu.popup({ window: targetWin, x: params.x, y: params.y });
};

// ---------------------------------------------------------------------------
// Auto-update: download state + banner
// ---------------------------------------------------------------------------
// electron-updater downloads a new release in the background (autoDownload is
// on). The renderer draws a banner along the top of the window with the live
// percentage and, once the download has finished, the "Restart now / Later"
// buttons - those replaced the native modal dialog, which interrupted whatever
// the worker was typing.
//
// The state lives here, not in a page: every page change destroys the renderer,
// so a freshly loaded page asks for the current state (UpdateGetState) and then
// follows the broadcasts.
const UpdateState = {
  phase: "idle", // "idle" | "downloading" | "ready"
  version: null, // release being downloaded / waiting to be installed
  percent: null, // 0-100; null while the total size is still unknown
  transferred: 0,
  total: 0,
  bytesPerSecond: 0,
  demo: false, // set by INSURANCE_UPDATE_DEMO, see SetupUpdateDemo below
  dismissedVersion: null, // the worker chose "Later" for this version
};

const UpdateStateSnapshot = () => ({
  phase: UpdateState.phase,
  version: UpdateState.version,
  percent: UpdateState.percent,
  transferred: UpdateState.transferred,
  total: UpdateState.total,
  bytesPerSecond: UpdateState.bytesPerSecond,
  demo: UpdateState.demo,
});

// Merge a patch into the state and push it to every open window.
const SetUpdateState = (patch) => {
  Object.assign(UpdateState, patch);
  BroadcastToWindows("UpdateState", UpdateStateSnapshot());
};

// Unpackaged builds never download a release, so during `npm start` the banner
// would never appear. INSURANCE_UPDATE_DEMO=1 walks the real states (0 -> 100 %
// and then "ready") with a fake version, so the look can be checked without
// publishing anything; its buttons are inert.
const SetupUpdateDemo = () => {
  const version = `${APP_VERSION}-demo`;
  UpdateState.demo = true;
  let percent = 0;
  SetUpdateState({
    phase: "downloading",
    version,
    percent: 0,
    transferred: 0,
    total: 0,
    bytesPerSecond: 0,
  });
  const timer = setInterval(() => {
    percent = Math.min(100, percent + 4);
    SetUpdateState({
      percent,
      transferred: percent,
      total: 100,
      bytesPerSecond: 1250 * 1024,
    });
    if (percent >= 100) {
      clearInterval(timer);
      SetUpdateState({ phase: "ready" });
    }
  }, 400);
  console.log(`Auto-update: DEMO mode, simulating version ${version}.`);
};

// Auto-update from GitHub Releases. Only runs in the packaged app, but the IPC
// handlers are registered on every build so the renderer can always ask for the
// state (an unpackaged build simply never leaves "idle").
const SetupAutoUpdater = () => {
  ipcMain.handle("UpdateGetState", () => UpdateStateSnapshot());

  // "Restart now" in the banner. The reply is returned before the restart so
  // the renderer can still report a failure.
  ipcMain.handle("UpdateInstall", () => {
    if (UpdateState.phase !== "ready") return { ok: false, error: "not-ready" };
    // The demo has no downloaded installer behind it.
    if (UpdateState.demo) return { ok: false, error: "demo" };
    setImmediate(() => autoUpdater.quitAndInstall());
    return { ok: true };
  });

  // "Later" in the banner: take it off the screen for this version.
  // autoInstallOnAppQuit then installs the update the next time the app closes,
  // and a newer release asks again.
  ipcMain.handle("UpdateDismiss", () => {
    UpdateState.dismissedVersion = UpdateState.version;
    SetUpdateState({ phase: "idle" });
    return { ok: true };
  });

  if (!app.isPackaged) {
    if (process.env.INSURANCE_UPDATE_DEMO === "1") SetupUpdateDemo();
    return;
  }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  // Log each lifecycle step so update behaviour is easy to trace when
  // diagnosing whether auto-update is working.
  autoUpdater.on("checking-for-update", () => {
    console.log("Auto-update: checking for updates…");
  });
  autoUpdater.on("update-available", (info) => {
    console.log(`Auto-update: version ${info.version} available, downloading…`);
    // "Later" was chosen for exactly this release: keep it off the screen.
    if (UpdateState.dismissedVersion === info.version) return;
    SetUpdateState({
      phase: "downloading",
      version: info.version,
      percent: 0,
      transferred: 0,
      total: 0,
      bytesPerSecond: 0,
    });
  });
  autoUpdater.on("update-not-available", () => {
    console.log("Auto-update: already up to date.");
  });

  // The progress event fires for every chunk; the banner only needs a few
  // updates per second (its CSS keeps the line moving in between), so the
  // broadcasts are throttled. The final 100 % is always sent.
  let lastProgressAt = 0;
  autoUpdater.on("download-progress", (progress) => {
    const total = Number(progress && progress.total) || 0;
    const transferred = Number(progress && progress.transferred) || 0;
    const reported = Number(progress && progress.percent);
    const percent = Number.isFinite(reported)
      ? reported
      : total > 0
        ? (transferred / total) * 100
        : null;
    const rounded =
      percent === null ? null : Math.max(0, Math.min(100, Math.round(percent)));
    const now = Date.now();
    if (rounded !== 100 && now - lastProgressAt < 250) return;
    lastProgressAt = now;
    SetUpdateState({
      phase: "downloading",
      percent: rounded,
      transferred,
      total,
      bytesPerSecond: Number(progress && progress.bytesPerSecond) || 0,
    });
  });

  autoUpdater.on("error", (err) => {
    console.error("Auto-update error:", err);
    // Never leave the banner stuck at "downloading 37 %": an error that stops
    // the download takes it off the screen.
    if (UpdateState.phase === "downloading") SetUpdateState({ phase: "idle" });
  });

  // "Restart now" on an update must not be blocked by the unsent-policies
  // prompt: queued policies are on disk and are sent after the restart.
  autoUpdater.on("before-quit-for-update", () => {
    closeConfirmed = true;
  });

  // The download has finished: the banner turns into the "Restart now / Later"
  // prompt. This used to be a native modal dialog, which interrupted whatever
  // the worker was typing. A periodic re-check re-emits this event for the
  // cached download, so "Later" is remembered per version and a newer release
  // asks again.
  autoUpdater.on("update-downloaded", (info) => {
    console.log(`Auto-update: version ${info.version} downloaded.`);
    if (info.version === UpdateState.dismissedVersion) return;
    SetUpdateState({ phase: "ready", version: info.version, percent: 100 });
  });

  // Check for new releases while the app keeps running, so users do not have
  // to restart it just to discover that an update is live.
  const UPDATE_CHECK_INTERVAL_MS = 5 * 60 * 1000; // regular background poll
  const MIN_CHECK_GAP_MS = 60 * 1000; // throttle for focus/resume triggers
  let checking = false;
  let lastCheckAt = 0;

  const check = async () => {
    if (checking) return;
    checking = true;
    lastCheckAt = Date.now();
    try {
      await autoUpdater.checkForUpdates();
    } catch {
      // Already logged by the "error" listener above.
    } finally {
      checking = false;
    }
  };

  // Extra checks on window focus / wake-from-sleep, throttled so they never
  // hammer the release server.
  const checkIfStale = () => {
    if (Date.now() - lastCheckAt >= MIN_CHECK_GAP_MS) check();
  };

  check();
  setInterval(check, UPDATE_CHECK_INTERVAL_MS);
  app.on("browser-window-focus", checkIfStale);
  // Timers do not run while the PC sleeps; check as soon as it wakes up.
  powerMonitor.on("resume", checkIfStale);
  powerMonitor.on("unlock-screen", checkIfStale);
};

// ---------------------------------------------------------------------------
// Outbox: requests (new policies + their files) that must reach the server even
// when the connection is slow or down. Runs here, not in a page, because every
// page change destroys the renderer - the retry loop must survive the worker
// moving on to the next policy. Stored under userData so it survives restarts.
// ---------------------------------------------------------------------------
// Only these API origins may be used by queued requests (same list as the CSP:
// the API host plus the local dev server - see config.js).
const OUTBOX_ALLOWED_ORIGINS = new Set(API.allowedOrigins);
const OUTBOX_ALLOWED_PATHS = new Set(["/worker/insurances"]);
const OUTBOX_DEFAULT_ORIGIN = API.apiBase;

let outbox = null;
let outboxReady = null;

// Push the queue state to every open window (the badge on each page).
const BroadcastToWindows = (channel, payload) => {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(channel, payload);
  }
};

const SetupOutbox = () => {
  outbox = new Outbox({
    dir: path.join(app.getPath("userData"), "outbox"),
    baseUrl: OUTBOX_DEFAULT_ORIGIN,
    // Chromium's network stack: honours the system proxy like the renderer.
    fetch: (url, init) => net.fetch(url, init),
    onChange: (state) => BroadcastToWindows("OutboxState", state),
    onDelivered: (item, result) =>
      BroadcastToWindows("OutboxDelivered", { item, result }),
  });
  outboxReady = outbox.init().catch((err) => {
    console.error("[Outbox] Failed to load the saved queue:", err);
  });

  // Timers do not run while the PC sleeps and the network is often just back
  // after a wake-up: retry right away instead of waiting for the next tick.
  const retryNow = () => outbox && outbox.retryAll(false);
  powerMonitor.on("resume", retryNow);
  powerMonitor.on("unlock-screen", retryNow);
};

// Validate an enqueue request coming from a renderer before it is persisted.
const SanitizeOutboxRequest = (req) => {
  if (!req || typeof req !== "object") throw new Error("Invalid request");
  const origin = String(req.baseUrl || OUTBOX_DEFAULT_ORIGIN).replace(/\/+$/, "");
  if (!OUTBOX_ALLOWED_ORIGINS.has(origin)) {
    throw new Error(`Outbox: origin not allowed (${origin})`);
  }
  if (!OUTBOX_ALLOWED_PATHS.has(req.path)) {
    throw new Error(`Outbox: path not allowed (${req.path})`);
  }
  if (typeof req.body !== "string") throw new Error("Outbox: invalid body");
  let verify = null;
  if (req.verify && typeof req.verify === "object") {
    const vPath = String(req.verify.path || "");
    if (vPath.startsWith("/insurances?")) {
      verify = {
        path: vPath,
        listKey: String(req.verify.listKey || "insurances"),
        match: Object.fromEntries(
          Object.entries(req.verify.match || {}).map(([k, v]) => [
            String(k),
            String(v ?? ""),
          ])
        ),
      };
    }
  }
  return {
    baseUrl: origin,
    path: req.path,
    method: "POST",
    body: req.body,
    token: String(req.token || ""),
    username: String(req.username || ""),
    label: String(req.label || "").slice(0, 200),
    kind: String(req.kind || "").slice(0, 50),
    messageId: req.messageId ? String(req.messageId) : null,
    verify,
  };
};

ipcMain.handle("OutboxSubmit", async (event, req, waitMs) => {
  await outboxReady;
  const wait = Math.min(Math.max(Number(waitMs) || 0, 0), 60000);
  return outbox.submit(SanitizeOutboxRequest(req), wait);
});
ipcMain.handle("OutboxGetState", async () => {
  await outboxReady;
  return outbox.getState();
});
ipcMain.handle("OutboxRetryAll", async (event, includeFailed) => {
  await outboxReady;
  return outbox.retryAll(includeFailed === true);
});
ipcMain.handle("OutboxRetry", async (event, id) => {
  await outboxReady;
  return outbox.retry(id);
});
ipcMain.handle("OutboxDiscard", async (event, id) => {
  await outboxReady;
  return outbox.discard(id);
});
ipcMain.handle("OutboxAcknowledge", async (event, id) => {
  await outboxReady;
  return outbox.acknowledge(id);
});
ipcMain.handle("OutboxUpdateToken", async (event, username, token) => {
  await outboxReady;
  return outbox.updateToken(username, token);
});

// ---------------------------------------------------------------------------
// Network diagnostics + log.
//
// A connection problem in the field leaves no trace today: the only evidence is
// the DevTools console (Ctrl + ~), which a worker cannot read and support cannot
// collect. Every interesting client event is therefore appended to
// userData/logs/network.log, and a failing login can ask for one timed /ping so
// the client knows WHICH stage is slow: DNS, TCP, TLS, or the server's first
// byte. That is what separates "the network blocks/slows us" from "the server is
// down".
// ---------------------------------------------------------------------------
const NET_LOG_MAX_BYTES = 512 * 1024;

const NetLogPath = () =>
  path.join(app.getPath("userData"), "logs", "network.log");

const AppendNetLog = (channel, message) => {
  const line = `${new Date().toISOString()} [${channel || "client"}] ${message}`;
  try {
    const file = NetLogPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
      if (fs.statSync(file).size > NET_LOG_MAX_BYTES) {
        fs.renameSync(file, `${file}.1`);
      }
    } catch {
      // No file yet (or the rename was refused): append() will create it.
    }
    fs.appendFileSync(file, line + "\n");
  } catch (err) {
    console.error("[netlog] write failed:", err);
  }
};

ipcMain.on("ClientLog", (event, channel, message) => {
  AppendNetLog(
    String(channel || "client").slice(0, 24),
    String(message || "").slice(0, 2000)
  );
});

// ---------------------------------------------------------------------------
// Client diagnostics queue (renderer/diag.js).
//
// The renderer records every failed request (403 first) and the first success
// after a 403. The queue lives HERE, on disk, so it survives a page change, a
// crash or an app restart - the exact conditions under which an intermittent
// 403 is most likely to be missed. The renderer uploads it to POST /diag/client
// whenever the API is reachable again and then removes the delivered entries.
//
// The file is JSON Lines so a single damaged line can be skipped instead of
// losing the whole queue.
// ---------------------------------------------------------------------------
const DIAG_QUEUE_MAX_ENTRIES = 200;
const DIAG_QUEUE_MAX_BYTES = 4 * 1024 * 1024;

const DiagDir = () => path.join(app.getPath("userData"), "diag");
const DiagQueuePath = () => path.join(DiagDir(), "pending.jsonl");
const DiagClientIdPath = () => path.join(DiagDir(), "client-id.txt");

function EnsureDiagDir() {
  fs.mkdirSync(DiagDir(), { recursive: true });
}

// Stable per-install id. Distinguishes two PCs even when they share a Windows
// user name or a public IP, which is exactly what a 403 investigation needs.
function DiagClientId() {
  try {
    const file = DiagClientIdPath();
    if (fs.existsSync(file)) {
      const existing = String(fs.readFileSync(file, "utf8")).trim();
      if (existing) return existing;
    }
    const id = crypto.randomBytes(12).toString("hex");
    EnsureDiagDir();
    fs.writeFileSync(file, id);
    return id;
  } catch (err) {
    console.error("[diag] client id unavailable:", err);
    return "";
  }
}

function ReadDiagQueue() {
  try {
    const file = DiagQueuePath();
    if (!fs.existsSync(file)) return [];
    const text = fs.readFileSync(file, "utf8");
    const queue = [];
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (entry && typeof entry === "object" && entry.url) queue.push(entry);
      } catch {
        // Skip a damaged line; the rest of the queue is still usable.
      }
    }
    return queue;
  } catch (err) {
    console.error("[diag] queue read failed:", err);
    return [];
  }
}

function TrimDiagQueue(queue) {
  let trimmed = queue.slice(-DIAG_QUEUE_MAX_ENTRIES);
  const encoded = () => trimmed.map((e) => JSON.stringify(e)).join("\n");
  let text = encoded();
  while (text.length > DIAG_QUEUE_MAX_BYTES && trimmed.length > 1) {
    trimmed = trimmed.slice(Math.ceil(trimmed.length / 10));
    text = encoded();
  }
  return { queue: trimmed, text };
}

function WriteDiagQueue(queue) {
  try {
    const { text } = TrimDiagQueue(Array.isArray(queue) ? queue : []);
    EnsureDiagDir();
    fs.writeFileSync(DiagQueuePath(), text ? text + "\n" : "");
    return true;
  } catch (err) {
    console.error("[diag] queue write failed:", err);
    return false;
  }
}

ipcMain.handle("DiagQueueRead", async () => ReadDiagQueue());
ipcMain.handle("DiagQueueSave", async (event, queue) => {
  return WriteDiagQueue(queue);
});
ipcMain.handle("DiagQueueState", async () => {
  let bytes = 0;
  try {
    bytes = fs.statSync(DiagQueuePath()).size;
  } catch {
    bytes = 0;
  }
  return {
    path: DiagQueuePath(),
    clientId: DiagClientId(),
    entries: ReadDiagQueue().length,
    bytes,
  };
});

// ---------------------------------------------------------------------------
// Diagnostics environment.
//
// Everything the renderer cannot see on its own but a 403 investigation needs:
// which proxy Chromium resolved for the API (antivirus web filters show up
// here), the public IP (an IP-range block shows up here), the TLS certificate
// issuer (an HTTPS-scanning antivirus replaces it), hostname/OS user and the
// build's versions. Cached for ten minutes; the public-IP lookup is the only
// slow part.
// ---------------------------------------------------------------------------
const DIAG_ENV_TTL_MS = 10 * 60 * 1000;
let diagEnvCache = null;
let diagEnvAt = 0;

function FetchPublicIp() {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    Promise.resolve()
      .then(() =>
        net.fetch("https://api.ipify.org?format=json", {
          signal: AbortSignal.timeout(8000),
          cache: "no-store",
        })
      )
      .then(async (res) => {
        if (!res.ok) return finish({ error: `HTTP ${res.status}` });
        const text = await res.text();
        let ip = "";
        try {
          const parsed = JSON.parse(text);
          ip = String(parsed && parsed.ip ? parsed.ip : "");
        } catch {
          ip = String(text || "").trim();
        }
        finish(ip ? { ip } : { error: "empty answer" });
      })
      .catch((err) => finish({ error: String((err && err.message) || err) }));
  });
}

// The issuer of the certificate the API host actually presented. If an
// antivirus or a corporate proxy scans HTTPS, this is ITS name instead of the
// hosting provider's - the clearest sign that something intercepts TLS.
function FetchTlsIssuer() {
  return new Promise((resolve) => {
    let url;
    try {
      url = new URL(OUTBOX_DEFAULT_ORIGIN);
    } catch {
      resolve(null);
      return;
    }
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const req = https.request(
      {
        protocol: url.protocol,
        host: url.hostname,
        port: url.port || 443,
        path: "/ping",
        method: "HEAD",
        agent: false,
        // Capture the issuer even when an antivirus replaced the certificate.
        rejectUnauthorized: false,
        timeout: 8000,
      },
      (res) => {
        let cert = null;
        try {
          cert = res.socket ? res.socket.getPeerCertificate() : null;
        } catch {
          cert = null;
        }
        res.destroy();
        finish(
          cert
            ? {
                issuer: cert.issuer || null,
                subject: cert.subject || null,
                validFrom: cert.valid_from || null,
                validTo: cert.valid_to || null,
                fingerprint256: cert.fingerprint256 || null,
              }
            : null
        );
      }
    );
    req.on("timeout", () => {
      req.destroy();
      finish(null);
    });
    req.on("error", () => finish(null));
    req.end();
  });
}

async function CollectDiagContext(force) {
  if (!force && diagEnvCache && Date.now() - diagEnvAt < DIAG_ENV_TTL_MS) {
    return diagEnvCache;
  }

  let proxy = null;
  try {
    proxy = await session.defaultSession.resolveProxy(OUTBOX_DEFAULT_ORIGIN);
  } catch (err) {
    proxy = `unavailable: ${String((err && err.message) || err)}`;
  }

  const publicIp = await FetchPublicIp();
  const tls = await FetchTlsIssuer();

  const networkInterfaces = {};
  try {
    for (const [name, addresses] of Object.entries(os.networkInterfaces())) {
      networkInterfaces[name] = (addresses || [])
        .filter((address) => !address.internal)
        .map((address) => ({
          family: address.family,
          address: address.address,
          mac: address.mac,
        }));
    }
  } catch {
    // Leave it empty.
  }

  let osUser = null;
  try {
    osUser = os.userInfo().username;
  } catch {
    osUser = null;
  }

  let systemLocale = null;
  try {
    systemLocale =
      typeof app.getSystemLocale === "function" ? app.getSystemLocale() : null;
  } catch {
    systemLocale = null;
  }

  diagEnvCache = {
    collectedAt: new Date().toISOString(),
    clientId: DiagClientId(),
    appVersion: APP_VERSION,
    hostname: os.hostname(),
    osUser,
    platform: process.platform,
    osRelease: os.release(),
    arch: process.arch,
    totalMemoryBytes: os.totalmem(),
    cpuCount: (os.cpus() || []).length,
    electron: process.versions.electron || null,
    chrome: process.versions.chrome || null,
    node: process.versions.node || null,
    v8: process.versions.v8 || null,
    locale: app.getLocale(),
    systemLocale,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    proxy: { resolved: proxy, apiOrigin: OUTBOX_DEFAULT_ORIGIN },
    publicIp: publicIp.ip || null,
    publicIpError: publicIp.error || null,
    tls,
    networkInterfaces,
  };
  diagEnvAt = Date.now();
  return diagEnvCache;
}

ipcMain.handle("DiagContext", async (event, force) =>
  CollectDiagContext(force === true)
);

// One GET /ping with every stage timed. /ping needs no auth and never touches
// the database, so this is safe to run while a login is failing.
const DIAGNOSE_TIMEOUT_MS = 20000;

const DiagnoseServer = () =>
  new Promise((resolve) => {
    let url;
    try {
      url = new URL(OUTBOX_DEFAULT_ORIGIN);
    } catch (err) {
      resolve({
        ok: false,
        stage: "url",
        error: String((err && err.message) || err),
      });
      return;
    }

    const startedAt = process.hrtime.bigint();
    const since = () => Number(process.hrtime.bigint() - startedAt) / 1e6;
    const summary = {
      ok: false,
      host: url.host,
      timeoutMs: DIAGNOSE_TIMEOUT_MS,
    };
    let dnsMs = null;
    let connectMs = null;
    let tlsMs = null;
    let settled = false;

    const finish = (extra) => {
      if (settled) return;
      settled = true;
      Object.assign(summary, { dnsMs, connectMs, tlsMs, totalMs: since() }, extra);
      AppendNetLog("diagnose", JSON.stringify(summary));
      resolve(summary);
    };

    const req = https.request({
      protocol: url.protocol,
      host: url.hostname,
      port: url.port || 443,
      path: "/ping",
      method: "GET",
      agent: false,
      headers: {
        "User-Agent": `Insurance/${APP_VERSION}`,
        Accept: "application/json",
      },
      // Time the resolver separately: a filtered or hijacked DNS answer is the
      // difference between "this network blocks us" and "the app is slow".
      lookup: (hostname, options, callback) => {
        dnsLookup.lookup(hostname, options, (err, address, family) => {
          if (!err) {
            dnsMs = since();
          } else {
            finish({
              stage: "dns",
              error: String((err && (err.code || err.message)) || "lookup failed"),
            });
          }
          callback(err, address, family);
        });
      },
    });

    req.setTimeout(DIAGNOSE_TIMEOUT_MS, () => {
      const err = new Error("timeout");
      err.code = "ETIMEDOUT";
      req.destroy(err);
    });

    req.on("socket", (socket) => {
      socket.once("connect", () => {
        connectMs = since();
      });
      socket.once("secureConnect", () => {
        tlsMs = since();
      });
    });

    req.on("response", (res) => {
      const ttfbMs = since();
      res.resume();
      res.on("end", () =>
        finish({
          ok: true,
          status: res.statusCode,
          ttfbMs,
          server: res.headers.server || null,
        })
      );
      res.on("error", () =>
        finish({
          ok: false,
          stage: "body",
          status: res.statusCode,
          ttfbMs,
          error: "response stream failed",
        })
      );
    });

    req.on("error", (err) => {
      const code = String((err && err.code) || "");
      const stage =
        code === "ETIMEDOUT" || code === "ESOCKETTIMEDOUT"
          ? "timeout"
          : connectMs == null
            ? "connect"
            : tlsMs == null
              ? "tls"
              : "response";
      finish({
        stage,
        error: `${code || (err && err.name) || "error"}${
          err && err.message ? `: ${err.message}` : ""
        }`,
      });
    });

    req.end();
  });

ipcMain.handle("ServerDiagnose", () => DiagnoseServer());

// ---------------------------------------------------------------------------
// WebSocket handshake probe (runs in the main process: no CORS, no browser
// redirect-hiding).
//
// When `new WebSocket()` in the renderer fails, Chromium only reports
// "Unexpected response code: 307" and hides the Location header. This raw
// handshake captures the real status + Location + `server` header so the app
// can (a) tell the worker whether the redirect came from Hostinger's CDN
// (`server: hcdn`) or from a client-side proxy/antivirus, and (b) follow a
// stable redirect target that the browser WebSocket API refuses to follow.
// ---------------------------------------------------------------------------
const WS_PROBE_HOST = new URL(OUTBOX_DEFAULT_ORIGIN).host;
const WS_PROBE_PATH = "/ws";

function probeWsHandshake() {
  return new Promise((resolve) => {
    const req = https.request({
      host: WS_PROBE_HOST,
      port: 443,
      method: "GET",
      path: WS_PROBE_PATH,
      agent: false,
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": crypto.randomBytes(16).toString("base64"),
      },
    });

    let done = false;
    const finish = (summary) => {
      if (done) return;
      done = true;
      try {
        req.destroy();
      } catch {
        /* ignore */
      }
      resolve(summary);
    };

    // Non-101 response (3xx redirects, 4xx, 5xx, ...).
    req.on("response", (res) => {
      const summary = {
        status: res.statusCode,
        location: res.headers.location || null,
        server: res.headers.server || null,
        requestId: res.headers["x-hcdn-request-id"] || null,
      };
      res.destroy();
      finish(summary);
    });

    // 101 Switching Protocols: Node emits "upgrade" instead of "response".
    req.on("upgrade", (res, socket) => {
      const summary = {
        status: res.statusCode,
        location: res.headers.location || null,
        server: res.headers.server || null,
        requestId: res.headers["x-hcdn-request-id"] || null,
        ok: res.statusCode === 101,
      };
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
      finish(summary);
    });

    req.setTimeout(6000, () => finish({ status: "timeout" }));
    req.on("error", (err) => finish({ status: "error", error: err.message }));
    req.end();
  });
}

ipcMain.handle("WsHandshakeProbe", () => probeWsHandshake());

// ---------------------------------------------------------------------------
// Desktop PDF watcher
// ---------------------------------------------------------------------------
// While a worker processes a policy, an external tool downloads the policy
// PDFs to the user's Desktop. The renderer starts this watcher when the email
// card or the walk-in insurance button is clicked; we then poll the Desktop
// every second for PDFs downloaded after that moment and queue paper copies in
// the background (see the print queue below).
//
// Only files that belong to THIS form are touched. Anything already sitting on
// the Desktop when the watch starts is left alone, however old it is, and
// nothing that predates the click is ever printed, uploaded or deleted. Two
// signals decide that together:
//   - a snapshot of the Desktop's PDFs taken when the watch starts: a file that
//     is not in it appeared after the form was opened, so it is ours;
//   - the file's creation time, for the one case the snapshot cannot see: a PDF
//     downloaded in the gap between the click and the form finishing loading
//     (it is in the snapshot, but created after the click).
// The timestamp alone is not enough: a downloader may keep the server's
// (older) timestamp, and a filesystem without a usable creation time reports
// the modification time instead — either would make a fresh PDF look old and
// leave it on the Desktop forever.
//
// Email mode: both PDFs are pushed to the form at once and deleted from the
// Desktop; the policy PDF ("BG_02_ FI<policy>.pdf") is uploaded but never
// auto-printed, only the remaining PDF gets a paper copy. The watcher stops
// once it has collected both files.
//
// Walk-in mode: both PDFs get a paper copy, and each Desktop file is deleted
// only after its print has settled — printed, cancelled or failed — so a file
// this watch took over is never left behind.
let DesktopPdfWatch = null; // { mode, sinceMs, timer, existing, emitted, sizes, foundPolicy, foundOther, foundCount, printedCount, fields }

function DesktopPdfDirectory() {
  try {
    return app.getPath("desktop");
  } catch (err) {
    console.error("[DesktopPdfWatch] Could not resolve the Desktop path:", err);
    return null;
  }
}

// Every PDF already on the Desktop when a watch starts, with the size and
// creation time it had at that moment. A file that is not in here was written
// after the watch started, so it can only belong to the form being opened.
// Which of these files may then be handled is decided by
// desktopPdfBelongsToForm (./desktopPdfWatch.js).
function DesktopPdfSnapshot(dir) {
  const snapshot = new Map();
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    console.error("[DesktopPdfWatch] Failed to list the Desktop:", err);
    return snapshot;
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (path.extname(entry.name).toLowerCase() !== ".pdf") continue;
    const filePath = path.join(dir, entry.name);
    try {
      snapshot.set(filePath, desktopPdfIdentity(fs.statSync(filePath)));
    } catch (err) {
      // Vanished or unreadable: leave it out. When it does turn up it is treated
      // like any other new file.
    }
  }
  return snapshot;
}

// True when this PDF may have been downloaded for the form that opened the
// watch, so it may be uploaded, printed and deleted. The rules - and why the
// snapshot and the click time are both needed - live in ./desktopPdfWatch.js.

// Windows keeps a freshly downloaded PDF locked for a moment (the downloader,
// antivirus or a viewer may still hold it open), so a single unlink can fail
// with EBUSY/EPERM and the file would stay on the Desktop. Retry with a growing
// delay, and treat an already-missing file as deleted.
const DesktopPdfDeleteAttempts = 8;
const DesktopPdfDeleteRetryMs = 250;

async function DeleteDesktopPdfFile(filePath, logTag = "[DesktopPdfWatch]") {
  for (let attempt = 1; attempt <= DesktopPdfDeleteAttempts; attempt += 1) {
    try {
      await fs.promises.unlink(filePath);
      return true;
    } catch (err) {
      if (err.code === "ENOENT") return true;
      const locked =
        err.code === "EBUSY" || err.code === "EPERM" || err.code === "EACCES";
      if (!locked || attempt === DesktopPdfDeleteAttempts) {
        console.error(`${logTag} Failed to delete "${filePath}":`, err);
        return false;
      }
      await printDelay(DesktopPdfDeleteRetryMs * attempt);
    }
  }
  return false;
}

function StopDesktopPdfWatch() {
  if (!DesktopPdfWatch) return;
  if (DesktopPdfWatch.timer) clearInterval(DesktopPdfWatch.timer);
  DesktopPdfWatch = null;
}

// Give up loading a document for printing after this long (did-finish-load
// never firing otherwise wedges the print request).
const PrintLoadTimeoutMs = 20000;
// Settle time used when the document cannot tell us it is ready (non-PDF files,
// or if the internal readiness event below is unavailable). Printing too early
// can produce blank pages.
const PrintRenderDelayMs = 500;
// Give up waiting for webContents.print() to finish after this long. On some
// Electron versions printing a loaded PDF never fires the print callback, which
// would otherwise leave the print promise (and the queue) hanging and the
// "Print" window open forever. Generous because it only applies when the
// fallback dialog is shown (a silent print uses PrintSilentHandoffMs); the
// timer only fires when nothing settles the print in time.
const PrintResultTimeoutMs = 5 * 60 * 1000;

// ---------------------------------------------------------------------------
// Silent printing
// ---------------------------------------------------------------------------
// Every paper copy is printed without the native print dialog. The workers use
// one printer with its own settings and never pick copies, a tray or a page
// size; a copy that did not come out is simply printed again with the Print
// button (which now prints silently too). webContents.print() prints straight
// to that printer when it is given `silent: true`; the dialog is opened only
// when the app cannot print silently (see PrintOptionsFor below), so a job can
// never disappear without a trace.
//
// Electron 34 does not always report the result of a silently printed PDF
// (electron/electron#47272: the paper comes out, the callback never runs), so
// a silent job that reports nothing is treated as sent after a short hand-off
// instead of waiting the interactive timeout - otherwise the print window
// would stay on screen for five minutes after every policy.
const PrintSilent = true;
const PrintSilentHandoffMs = 10 * 1000;

// The options for one print. An empty object means "show the native dialog",
// which is the fallback when the system has no printer the app can use.
async function PrintOptionsFor(webContents, logTag) {
  if (!PrintSilent) return {};
  if (typeof webContents.getPrintersAsync !== "function") return {};

  let printers = [];
  try {
    const listed = await webContents.getPrintersAsync();
    printers = Array.isArray(listed) ? listed : [];
  } catch (err) {
    console.error(`${logTag} Could not list the printers; showing the print dialog.`, err);
    return {};
  }

  const defaultPrinter = printers.find((printer) => printer.isDefault);
  // Without a default printer Windows has no opinion, so only a single printer
  // is unambiguous; with several, let the worker pick one in the dialog.
  const target = defaultPrinter || (printers.length === 1 ? printers[0] : null);
  if (!target) {
    console.warn(`${logTag} No default printer; showing the print dialog.`);
    return {};
  }

  // "Microsoft Print to PDF", "Microsoft XPS Document Writer", OneNote and fax
  // devices ask for a file name or a phone number, which a silent job cannot
  // supply: its document would be dropped. Fall back to the dialog for those.
  if (/pdf|xps|onenote|fax/i.test(`${target.name} ${target.displayName}`)) {
    console.warn(
      `${logTag} The default printer "${target.displayName}" needs the print dialog; ` +
        `showing it.`
    );
    return {};
  }

  console.log(`${logTag} Printing silently to "${target.displayName}".`);
  // deviceName is the OS name ("Brother_QL_820NWB"), not the printable one
  // ("Brother QL-820NWB"); it is what Chromium matches the driver against.
  const deviceName = target.name || target.displayName;
  if (!deviceName) {
    console.warn(`${logTag} The printer has no usable name; showing the print dialog.`);
    return {};
  }
  return { silent: true, deviceName };
}

// ---------------------------------------------------------------------------
// Blank-page ("white paper") protection
// ---------------------------------------------------------------------------
// Chromium's PDF viewer keeps loading its content AFTER did-finish-load: the
// page reports "loaded" while the viewer is still fetching/rendering the
// document, and printing in that window prints blank pages. That is the root
// cause of the Electron printing white-pages bug (electron/electron#30947,
// upstream-fixed for Electron 32+ in #43309, but the race is still there).
//
// Measured on Electron 34 with a small PDF:
//   - did-finish-load fires at ~290 ms,
//   - "-pdf-ready-to-print" fires at ~810 ms (0.5-2 s later for bigger PDFs),
//   - a snapshot taken at did-finish-load is exactly the size of a blank page.
// The old fixed 500 ms delay therefore sat right on the edge and often printed
// before the viewer was ready.
//
// The viewer's internal "-pdf-ready-to-print" event is the reliable signal; the
// snapshot check below guarantees that a blank page is never sent to the
// printer even if that event is missed or removed by a future Electron.

// Let the first frame paint after the document reports it is ready.
const PrintSettleAfterReadyMs = 150;
// How long to wait for Chromium to report that a loaded PDF is printable.
const PrintPdfReadyTimeoutMs = 10000;
// How long to wait for the printable image to finish loading.
const PrintImageDecodeTimeoutMs = 15000;
// How often the image readiness poll runs while it is still loading.
const PrintImagePollIntervalMs = 100;
// A blank printed page snapshots to ~0.73-0.8 KB (measured on Electron 34), so
// anything below 1 KB means Chromium rendered no text, image or shape at all.
// Real policies (text, scans) snapshot to tens of KB or more, so they are never
// affected.
const PrintBlankSnapshotBytes = 1000;
// Snapshot retries while the document is still blank (the viewer may still be
// rendering) and the per-attempt backoff.
const PrintSnapshotAttempts = 5;
const PrintSnapshotRetryMs = 500;
// One snapshot can take a while for a big scanned policy; don't wait forever.
const PrintSnapshotTimeoutMs = 20000;
const printDelay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Reject if `promise` does not settle within `ms` (used to bound the snapshot
// calls, which have no timeout of their own).
function WithPrintTimeout(promise, ms, message) {
  let timer = null;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

// Watches Chromium's internal "-pdf-ready-to-print" event, which fires when the
// PDF viewer has loaded its content and is ready to print. The event exists in
// the Electron versions this app ships on but is undocumented, so listening is
// best-effort and every wait has a timeout.
function PdfReadyWatcher(webContents) {
  let ready = false;
  const waiters = new Set();

  const onReady = () => {
    ready = true;
    for (const resolve of waiters) resolve(true);
    waiters.clear();
  };

  try {
    webContents.on("-pdf-ready-to-print", onReady);
  } catch (err) {
    console.error("[Print] Could not listen for -pdf-ready-to-print:", err);
  }

  return {
    // Resolves true when the viewer becomes ready, false on timeout.
    wait(timeoutMs) {
      if (ready) return Promise.resolve(true);
      return new Promise((resolve) => {
        const done = () => {
          clearTimeout(timer);
          waiters.delete(done);
          resolve(true);
        };
        const timer = setTimeout(() => {
          waiters.delete(done);
          resolve(false);
        }, timeoutMs);
        waiters.add(done);
      });
    },
    dispose() {
      try {
        webContents.removeListener("-pdf-ready-to-print", onReady);
      } catch {
        // The window is already gone.
      }
    },
  };
}

// Snapshot the document in memory (printToPDF opens no dialog) and check that it
// actually contains something. Returns "ready" when content is present, "blank"
// when every snapshot was an empty page, and "unknown" when snapshotting itself
// failed — in that case the caller prints anyway, exactly as before.
async function CheckPrintableContent(webContents, logTag, filename) {
  let snapshots = 0;

  for (let attempt = 1; attempt <= PrintSnapshotAttempts; attempt += 1) {
    try {
      const pdf = await WithPrintTimeout(
        webContents.printToPDF({}),
        PrintSnapshotTimeoutMs,
        "printToPDF timed out."
      );
      snapshots += 1;
      const bytes = pdf ? pdf.length : 0;
      if (bytes >= PrintBlankSnapshotBytes) return { state: "ready", bytes };
      console.warn(
        `${logTag} "${filename}" still renders as a blank page ` +
          `(${bytes} bytes, attempt ${attempt}/${PrintSnapshotAttempts}); ` +
          `waiting for the document to finish rendering.`
      );
    } catch (err) {
      console.error(
        `${logTag} Blank-page check failed for "${filename}" ` +
          `(attempt ${attempt}/${PrintSnapshotAttempts}).`,
        err
      );
    }
    if (attempt < PrintSnapshotAttempts) {
      await printDelay(PrintSnapshotRetryMs * attempt);
    }
  }

  return { state: snapshots > 0 ? "blank" : "unknown", bytes: 0 };
}

// Resolve once the <img> in the print page has finished loading. Large scans
// used to print white when print() ran before the image was ready.
//
// Polls <img>.complete from the main process instead of awaiting img.decode():
// awaiting a Promise returned by executeJavaScript is subject to renderer task
// throttling and can stall for seconds (or forever) if the window is background.
// Returns "ok", "error" (unrenderable image), "missing" or "timeout".
async function WaitForImageDecode(webContents) {
  const deadline = Date.now() + PrintImageDecodeTimeoutMs;
  let lastError = null;

  do {
    try {
      const state = await webContents.executeJavaScript(
        `(() => {
          const img = document.images && document.images[0];
          if (!img) return "missing";
          if (!img.complete) return "loading";
          return img.naturalWidth > 0 && img.naturalHeight > 0 ? "ok" : "error";
        })()`,
        true
      );
      if (state !== "loading") return state;
    } catch (err) {
      lastError = err;
    }
    await printDelay(PrintImagePollIntervalMs);
  } while (Date.now() < deadline);

  console.error(
    "[PrintImage] Timed out waiting for the image to load.",
    lastError || "(still loading)"
  );
  return "timeout";
}

let DesktopPdfScanning = false;

// Read the fields out of a downloaded PDF and push whatever is new to the form.
// Each PDF only carries some of them (the policy number and the blank number
// are split between the two, while the car number may be printed on either), so
// the values are collected on the watcher and each field is sent once - a later
// file never overwrites a value already found. Anything that goes wrong here is
// logged and ignored: the upload and the print must never depend on the form
// being fillable.
function SendDesktopPdfFields(watch, filename, bytes) {
  if (!watch || !bytes) return;
  if (!watch.fields) watch.fields = {};
  let fields;
  try {
    fields = pdfFields(bytes, filename);
  } catch (err) {
    console.warn(`[DesktopPdfWatch] Could not read the fields of "${filename}":`, err);
    return;
  }
  if (!fields) return;

  const found = {};
  for (const key of ["policyNumber", "carNumber", "blancNumber"]) {
    const value = fields[key];
    if (!value || watch.fields[key]) continue;
    watch.fields[key] = value;
    found[key] = value;
  }
  if (!Object.keys(found).length) return;

  console.log(
    `[DesktopPdfWatch] "${filename}" -> ${Object.entries(found)
      .map(([key, value]) => `${key}=${value}`)
      .join(", ")}`
  );
  if (win && !win.isDestroyed()) {
    win.webContents.send("DesktopPdfFields", found);
  }
}

// Single-flight guard: only one scan runs at a time. Printing is handled by the
// background queue (see below), so the scan itself never blocks on a dialog.
async function ScanDesktopPdfs() {
  if (!DesktopPdfWatch || DesktopPdfScanning) return;
  DesktopPdfScanning = true;
  try {
    await ScanDesktopPdfsOnce();
  } finally {
    DesktopPdfScanning = false;
  }
}

async function ScanDesktopPdfsOnce() {
  const dir = DesktopPdfDirectory();
  if (!dir) return;

  const watch = DesktopPdfWatch;
  if (!watch) return;
  const isWalkIn = watch.mode === "walkin";

  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    console.error("[DesktopPdfWatch] Failed to list the Desktop:", err);
    return;
  }

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (path.extname(entry.name).toLowerCase() !== ".pdf") continue;

    const filePath = path.join(dir, entry.name);

    // The policy PDF ("BG_02_ FI<policy>.pdf") is auto-attached like every
    // other PDF, but it is never auto-printed in email mode: only the
    // remaining PDF gets a paper copy.
    const isPolicyPdf = /^BG_02_\s*FI/i.test(entry.name);

    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch (err) {
      continue; // transient (still being written) — retry next poll
    }
    const identity = desktopPdfIdentity(stat);

    // Already handled in this watch - unless the file at that name has been
    // written again since (same name, new download), which must be handled too
    // or it would stay on the Desktop forever.
    if (desktopPdfAlreadyHandled(watch.emitted.get(filePath), identity)) {
      continue;
    }

    // Only PDFs downloaded for this form are touched. Files that were already
    // on the Desktop before it was opened - including leftovers from an earlier
    // walk-in - are left exactly where they are.
    if (!desktopPdfBelongsToForm(watch, filePath, identity)) continue;

    // A download may still be in progress (its size keeps growing). Accept the
    // file only once its size has held steady across one poll cycle.
    if (watch.sizes.get(filePath) !== stat.size) {
      watch.sizes.set(filePath, stat.size);
      continue;
    }
    watch.sizes.delete(filePath);

    let bytes;
    try {
      bytes = fs.readFileSync(filePath);
    } catch (err) {
      console.error(`[DesktopPdfWatch] Failed to read "${entry.name}":`, err);
      continue;
    }
    const base64 = bytes.toString("base64");

    watch.emitted.set(filePath, identity);
    watch.foundCount += 1;
    if (isPolicyPdf) {
      watch.foundPolicy = true;
    } else {
      watch.foundOther = true;
    }

    // Pre-fill the add-insurance form from the PDF that just arrived, in both
    // modes (an email policy and a walk-in carry the same two PDFs). The
    // policy number comes from the policy PDF's file name, the car number from
    // whichever PDF prints it (three times, see pdfFields.js) and the blank
    // number from the other PDF's text.
    SendDesktopPdfFields(watch, entry.name, bytes);

    if (isWalkIn) {
      // Walk-ins are print-only: nothing is attached to the form. Every PDF
      // downloaded for the visit gets a paper copy, and the Desktop file is
      // kept until that print has settled (see the print queue below), so the
      // source is still there if the print fails. The queue deletes it in every
      // outcome - printed, cancelled or failed - so nothing is left behind.
      enqueueDesktopPrint(base64, entry.name, {
        filePath,
        deleteAfterPrint: true,
        onSettled: () => {
          // Only count a print for the watcher that queued it: the form may
          // have been closed and reopened (starting a new walk-in watch) while
          // an older print job was still being handed to the printer.
          if (watch !== DesktopPdfWatch || watch.mode !== "walkin") return;
          watch.printedCount += 1;
          if (watch.printedCount >= 2) StopDesktopPdfWatch();
        },
      });

      // Both downloads are in hand: stop polling so unrelated PDFs saved to
      // the Desktop are not picked up. The watcher stays alive (without a
      // timer) until both print jobs settle, which is when it is stopped.
      if (watch.foundCount >= 2) {
        if (watch.timer) clearInterval(watch.timer);
        watch.timer = null;
        break;
      }
      continue;
    }

    // Email mode: push the bytes to the form immediately so the upload is
    // never blocked by printing, mark the file handled, and remove the Desktop
    // copy. A paper copy is printed afterwards in the background queue (its
    // bytes are already safe in the queue, so deleting the source file here
    // cannot lose the policy).
    if (win && !win.isDestroyed()) {
      win.webContents.send("DesktopPdfFound", {
        filename: entry.name,
        mimeType: "application/pdf",
        size: stat.size,
        base64,
      });
    }

    // A PDF that was just downloaded is often still locked for a moment, so the
    // delete retries instead of leaving the file on the Desktop.
    await DeleteDesktopPdfFile(filePath);

    // Only the non-policy PDF is printed automatically.
    if (!isPolicyPdf) {
      enqueueDesktopPrint(base64, entry.name);
    }

    if (watch.foundPolicy && watch.foundOther) {
      StopDesktopPdfWatch();
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Desktop PDF print queue
// ---------------------------------------------------------------------------
// Printing a paper copy is decoupled from the Desktop scan so preparing and
// handing a job to the printer can never stall the upload of the next PDF or
// wedge the watcher. PDFs are printed one at a time in the background, and each
// job is attempted exactly once: if it fails (or the fallback dialog is
// dismissed) the job is never retried on its own, so the print window cannot
// pop up again after the worker has already moved on. A missing copy is
// reprinted on demand with the Print button.
let DesktopPrintQueue = []; // { base64, filename, filePath, deleteAfterPrint, onSettled }
let DesktopPrintRunning = false;

function enqueueDesktopPrint(base64, filename, options = {}) {
  if (!base64) return;
  // One print per file name. A second request for a name that is still queued
  // must not be dropped outright: its Desktop source still has to be removed
  // once the queued print settles, so the delete is merged into that job
  // instead (dropping it left the file on the Desktop forever).
  const queued = DesktopPrintQueue.find((job) => job.filename === filename);
  if (queued) {
    if (options.filePath && !queued.filePath) queued.filePath = options.filePath;
    if (options.deleteAfterPrint === true) queued.deleteAfterPrint = true;
    if (typeof options.onSettled === "function" && !queued.onSettled) {
      queued.onSettled = options.onSettled;
    }
    return;
  }
  DesktopPrintQueue.push({
    base64,
    filename,
    // Walk-in jobs keep the Desktop source around until this print settles.
    filePath: options.filePath || "",
    deleteAfterPrint: options.deleteAfterPrint === true,
    onSettled:
      typeof options.onSettled === "function" ? options.onSettled : null,
  });
  drainDesktopPrintQueue();
}

async function drainDesktopPrintQueue() {
  if (DesktopPrintRunning) return;
  DesktopPrintRunning = true;
  try {
    while (DesktopPrintQueue.length) {
      const job = DesktopPrintQueue.shift();

      let result;
      try {
        result = await PrintDocument(job.base64, job.filename);
      } catch (err) {
        console.error(`[DesktopPdfWatch] Print threw for "${job.filename}":`, err);
        result = { ok: false, error: String((err && err.message) || err) };
      }

      // The paper copy is finished one way or another: it printed, it was
      // handed to the printer and never reported back, or it failed. Do NOT
      // retry on its own — that used to bring the print window back after the
      // worker had already moved on. Log the outcome and continue with the next
      // queued PDF instead.
      if (!result || !result.ok) {
        if (result && result.cancelled) {
          console.log(`[DesktopPdfWatch] Printing of "${job.filename}" was cancelled.`);
        } else {
          console.warn(
            `[DesktopPdfWatch] Printing of "${job.filename}" did not complete` +
              (result && result.error ? `: ${result.error}` : ".")
          );
        }
      }

      // Walk-in downloads stay on the Desktop for the entire print attempt.
      // Remove the source now that the print has settled (printed, cancelled
      // or failed) so the file never lingers. A freshly downloaded file is
      // often still locked, so the delete retries for a few seconds.
      if (job.deleteAfterPrint && job.filePath) {
        const deleted = await DeleteDesktopPdfFile(job.filePath);
        if (deleted) {
          console.log(`[DesktopPdfWatch] Deleted "${job.filename}" after printing.`);
        }
      }

      // Lets the walk-in watcher count finished prints and stop itself once
      // both paper copies are done.
      if (job.onSettled) {
        try {
          job.onSettled(result);
        } catch (err) {
          console.error(
            `[DesktopPdfWatch] Print callback threw for "${job.filename}":`,
            err
          );
        }
      }
    }
  } finally {
    DesktopPrintRunning = false;
  }
}

// Print a document (usually a PDF, but any file Chromium can render) to the
// system printer. Mirrors printImageDataUrl: the bytes are written to a temp
// file, loaded in a visible window and handed to webContents.print(), which
// prints silently to the printer chosen in PrintOptionsFor - no dialog, so the
// worker never has to confirm anything. A copy that did not come out is simply
// printed again with the Print button.
//
// Blank pages happen when print() is issued before Chromium's PDF viewer has
// actually loaded the document, so the print waits for the viewer's readiness
// event (not just a fixed delay) and then verifies with an in-memory snapshot
// that the document really has printable content. A load timeout prevents a
// stalled view from hanging forever.
//
// `ext` is the temp-file extension (default ".pdf") so the same helper also
// prints other attachments, and `logTag` prefixes the log lines so the Desktop
// queue and the manual print button are easy to tell apart.
function PrintDocument(base64, filename, ext = ".pdf", logTag = "[DesktopPdfWatch]") {
  return new Promise((resolve) => {
    let tempFile = "";
    let settled = false;
    let loadTimer = null;
    let printTimer = null;
    let pdfReady = null;
    // did-finish-load can fire more than once (reload/navigation); only prepare
    // and print one job per window.
    let preparingPrint = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (loadTimer) clearTimeout(loadTimer);
      if (printTimer) clearTimeout(printTimer);
      if (pdfReady) pdfReady.dispose();
      try {
        if (printWin && !printWin.isDestroyed()) printWin.close();
      } catch (err) {
        console.error(`${logTag} Error closing print window for "${filename}".`, err);
      }
      if (tempFile) {
        fs.promises.unlink(tempFile).catch((err) => {
          console.error(`${logTag} Failed to remove temp print file for "${filename}":`, err);
        });
      }
      resolve(result);
    };

    let printWin;
    try {
      // A real, visible window: Chromium renders the PDF viewer on screen, which
      // avoids the blank-page issues seen with hidden windows. Background
      // throttling is disabled so a window that loses focus (or is occluded)
      // keeps rendering while the print is being prepared. It is created hidden
      // and then shown without activation: printing is silent, so the window
      // must never take the keyboard focus away from whatever the worker is
      // typing, and it is kept out of the taskbar.
      printWin = new BrowserWindow({
        width: 900,
        height: 700,
        center: true,
        show: false,
        skipTaskbar: true,
        title: "Print",
        webPreferences: {
          sandbox: true,
          contextIsolation: true,
          backgroundThrottling: false,
        },
      });
    } catch (err) {
      console.error(`${logTag} Failed to create print window for "${filename}".`, err);
      finish({ ok: false, error: "Failed to open the print window." });
      return;
    }

    // Shown, but without activation (see above). It stays up only while the
    // document is prepared and handed to the printer.
    printWin.showInactive();

    // Closing the print window by hand settles the job at once. Without this
    // the queue only noticed when the result timeout fired, so a walk-in PDF
    // the worker closed the window on stayed on the Desktop for minutes - and
    // forever if the app was closed first. (finish() closes the window itself;
    // `settled` keeps this handler from running twice.)
    printWin.on("closed", () => {
      if (settled) return;
      console.log(`${logTag} Print window for "${filename}" was closed.`);
      finish({ ok: false, cancelled: true, error: "Print window closed." });
    });

    // Listen from the start: the viewer may report readiness before
    // did-finish-load fires. Only PDFs emit it; other documents fall back to a
    // settle delay (see below).
    pdfReady = PdfReadyWatcher(printWin.webContents);

    // Fail-safe: if the PDF never finishes loading (stalled viewer, missing
    // plugin, ...), give up after a bounded wait instead of hanging forever.
    loadTimer = setTimeout(() => {
      finish({ ok: false, error: "Timed out loading the PDF for printing." });
    }, PrintLoadTimeoutMs);

    printWin.webContents.on("did-fail-load", (e, errorCode, errorDescription) => {
      console.error(
        `${logTag} Failed to load "${filename}" for printing` +
          ` (${errorCode}${errorDescription ? ": " + errorDescription : ""}).`
      );
      finish({ ok: false, error: errorDescription || "Failed to load the PDF for printing." });
    });

    printWin.webContents.on("did-finish-load", () => {
      clearTimeout(loadTimer);
      if (preparingPrint) return;
      preparingPrint = true;
      (async () => {
        try {
          // A loaded PDF keeps rendering after did-finish-load. Wait for the
          // viewer to report that its content is printable, then let the last
          // paint settle; printing in between prints a blank page.
          const isPdf = String(ext || "").toLowerCase() === ".pdf";
          if (isPdf) {
            const ready = await pdfReady.wait(PrintPdfReadyTimeoutMs);
            if (ready) {
              await printDelay(PrintSettleAfterReadyMs);
            } else {
              console.warn(
                `${logTag} "${filename}" did not report it was ready to print` +
                  ` within ${PrintPdfReadyTimeoutMs} ms; falling back to a settle delay.`
              );
              await printDelay(PrintRenderDelayMs);
            }
          } else {
            await printDelay(PrintRenderDelayMs);
          }
          if (settled) return;

          // Never send white paper to the printer: snapshot the document and
          // keep waiting while Chromium still renders an empty page.
          const check = await CheckPrintableContent(printWin.webContents, logTag, filename);
          if (settled) return;
          if (check.state === "blank") {
            console.error(
              `${logTag} Refusing to print "${filename}": Chromium rendered only blank pages.`
            );
            finish({
              ok: false,
              error: "The document did not render (blank page), so nothing was printed.",
            });
            return;
          }
          if (check.state === "unknown") {
            console.warn(
              `${logTag} Could not verify the print output of "${filename}"; printing anyway.`
            );
          }

          const printOptions = await PrintOptionsFor(printWin.webContents, logTag);
          if (settled) return;
          // A silent print opens no dialog, so nothing has to be brought to the
          // foreground. Only the fallback dialog does - it must not end up
          // behind the main window.
          if (printOptions.silent !== true) {
            printWin.focus();
            printWin.webContents.focus();
          }
          // Fail-safe: if print() never reports back (Electron 34 skips the
          // callback for a silently printed PDF, electron/electron#47272),
          // settle and clean up rather than leaving the promise hanging and the
          // window open forever.
          const silent = printOptions.silent === true;
          printTimer = setTimeout(() => {
            if (silent) {
              // No dialog is open, so nothing is waiting for the worker. The
              // document had already been handed to the spooler when this timer
              // was started, and the blank-page check above refused an empty
              // one, so an unreported silent job counts as sent. A paper copy
              // that did not come out is printed again with the Print button.
              console.warn(
                `${logTag} No print result reported for "${filename}"; ` +
                  `the job was already handed to the printer.`
              );
              finish({ ok: true, unconfirmed: true });
              return;
            }
            finish({ ok: false, error: "Timed out waiting for the print dialog." });
          }, silent ? PrintSilentHandoffMs : PrintResultTimeoutMs);
          const result = printWin.webContents.print(printOptions, (success, failureReason) => {
            if (settled) return;
            if (success) {
              console.log(`${logTag} "${filename}" sent to printer.`);
              finish({ ok: true });
            } else {
              const cancelled = /cancel/i.test(failureReason || "");
              console.log(
                `${logTag} Print of "${filename}" ${cancelled ? "cancelled" : "failed"}` +
                  (failureReason ? `: ${failureReason}` : ".")
              );
              finish({
                ok: false,
                cancelled,
                error: failureReason || (cancelled ? "Print cancelled." : "Print failed."),
              });
            }
          });
          // Newer Electron versions return a Promise from print() (and some may
          // stop invoking the callback). Handle both so a print is recorded as
          // a success or failure exactly once.
          if (result && typeof result.then === "function") {
            result.then(
              () => {
                if (settled) return;
                console.log(`${logTag} "${filename}" sent to printer (promise).`);
                finish({ ok: true });
              },
              (err) => {
                if (settled) return;
                const message = String((err && err.message) || err);
                console.error(`${logTag} print() promise rejected for "${filename}".`, err);
                finish({ ok: false, cancelled: /cancel/i.test(message), error: message });
              }
            );
          }
        } catch (err) {
          console.error(`${logTag} Exception printing "${filename}".`, err);
          finish({ ok: false, error: String(err) });
        }
      })();
    });

    const dir = path.join(app.getPath("temp"), "insurance-print");
    tempFile = path.join(dir, `print-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`);

    (async () => {
      try {
        await fs.promises.mkdir(dir, { recursive: true });
        await fs.promises.writeFile(tempFile, Buffer.from(base64, "base64"));
      } catch (err) {
        console.error(`${logTag} Failed to write temp print file for "${filename}".`, err);
        finish({ ok: false, error: "Failed to prepare the print document." });
        return;
      }
      try {
        await printWin.loadFile(tempFile);
      } catch (err) {
        console.error(`${logTag} Failed to load temp print file for "${filename}".`, err);
        finish({ ok: false, error: String(err) });
      }
    })();
  });
}

ipcMain.handle("StartDesktopPdfWatch", (event, sinceMs, options) => {
  const dir = DesktopPdfDirectory();
  if (!dir) return { ok: false };

  const opts = options && typeof options === "object" ? options : {};
  const mode = opts.mode === "walkin" ? "walkin" : "email";
  const since = Number(sinceMs) || Date.now();
  StopDesktopPdfWatch();
  DesktopPdfWatch = {
    mode,
    sinceMs: since,
    timer: setInterval(ScanDesktopPdfs, 1000),
    // The Desktop as it is right now: anything in here predates the form and is
    // never touched (see desktopPdfBelongsToForm in ./desktopPdfWatch.js).
    existing: DesktopPdfSnapshot(dir),
    // path -> { size, createdMs } of the files already handled in this watch.
    emitted: new Map(),
    sizes: new Map(),
    foundPolicy: false,
    foundOther: false,
    foundCount: 0,
    printedCount: 0,
    // Values read out of the PDFs for the add-insurance form; each is sent to
    // the renderer once, the first time it is found (see SendDesktopPdfFields).
    fields: {},
  };
  console.log(
    `[DesktopPdfWatch] Watching the Desktop (${mode} mode); ` +
      `${DesktopPdfWatch.existing.size} older PDF(s) ignored.`
  );
  return { ok: true };
});

ipcMain.handle("StopDesktopPdfWatch", () => {
  StopDesktopPdfWatch();
  return { ok: true };
});

// Closing the window with undelivered policies: they are stored on disk and
// sent on the next start, but warn so the worker does not assume they landed.
// Hooked on the window's "close" (not app "before-quit") so the window is still
// there when the worker chooses to keep it open, and so auto-update installs
// (quitAndInstall) are never blocked.
let closeConfirmed = false;
const GuardWindowClose = (window) => {
  window.on("close", (event) => {
    if (closeConfirmed || !outbox || outbox.unsentCount() === 0) return;
    event.preventDefault();
    const count = outbox.unsentCount();
    dialog
      .showMessageBox(window, {
        type: "warning",
        buttons: ["Close anyway", "Keep the app open"],
        defaultId: 1,
        cancelId: 1,
        title: "Unsent policies",
        message: `${count} polic${count === 1 ? "y has" : "ies have"} not reached the server yet.`,
        detail:
          "They are saved on this computer and will be sent automatically the next time the app is started with an internet connection. Keep the app open to send them now.",
      })
      .then(({ response }) => {
        if (response === 0 && !window.isDestroyed()) {
          closeConfirmed = true;
          window.close();
        }
      })
      .catch((err) => console.error("[Outbox] Close prompt failed:", err));
  });
};

// ---------------------------------------------------------------------------
// Scans folder (Desktop\Scans)
// ---------------------------------------------------------------------------
// Created on start when it is missing. Every scan dropped into it is read with
// the Windows OCR engine in Turkish - every scan is assumed to be Turkish and
// upright, though the quarter turn a phone photo keeps in EXIF is applied - and
// the text is logged (see ./scans.js) and saved to Desktop\OCRScans.txt, which
// each new scan overwrites. Each field is saved as its label, a tab, then its
// data. The Turkish OCR language pack is checked on every start and installed
// when missing, which makes Windows ask for permission.
let scanWatcher = null;

const SetupScans = () => {
  try {
    const desktop = app.getPath("desktop");
    scanWatcher = new ScanWatcher({
      dir: path.join(desktop, "Scans"),
      outFile: path.join(desktop, "OCRScans.txt"),
    });
    scanWatcher.start();
  } catch (err) {
    console.error("[Scans] Failed to watch the scans folder:", err);
  }
  ensureOcrLanguages().catch((err) => {
    console.error("[Scans] Failed to check the OCR language packs:", err);
  });
};

app.whenReady().then(() => {
  SetupOutbox();
  CreateWindow();
  SetupBulins();
  SetupScans();
  Menu.setApplicationMenu(null);
  SetupAutoUpdater();
});

ipcMain.on("LoadPage", (event, page) => {
  win.loadFile(page);
});

// ---------------------------------------------------------------------------
// Bulins web form (WebContentsView)
// ---------------------------------------------------------------------------
// Bulins can show its border-insurance website in a WebContentsView layered over
// the main window, in place of the in-app AddInsurance form, and scrape every
// page the worker visits (see ./bulins.js for the controller + scraper).
//
// NOTE: currently inactive. New insurances use the in-app form again - the
// renderer gates these calls behind USE_BULINS_WEB_FORM in
// renderer/WorkPage/WorkPage.js. Everything below is kept so the web form can
// be switched back on by flipping that flag.
let bulins = null;

const SetupBulins = () => {
  bulins = new BulinsController({
    getWindow: () => win,
    onScraped: (entry) => BroadcastToWindows("BulinsScraped", entry),
    onClosed: (context) => BroadcastToWindows("BulinsClosed", context),
  });

  ipcMain.handle("BulinsOpen", (event, context) => bulins.open(context));
  ipcMain.handle("BulinsClose", () => bulins.close());
  ipcMain.handle("BulinsGetState", () => bulins.getState());
  ipcMain.handle("BulinsListScrapes", (event, limit) => bulins.listScrapes(limit));
  // Sent from the floating "← Insurance" button injected into the Bulins page.
  ipcMain.on("BulinsViewCloseRequest", () => bulins.close());
};

// Print an image (data URL) by loading it in a visible window and sending it to
// the printer silently (see PrintOptionsFor). Used by the "printable picture"
// feature and by the per-file "Print" button for image attachments - the button
// stays the way to get another copy, and it does not ask for confirmation
// either.
//
// Resolves with `{ ok: true }` on success, or
// `{ ok: false, error, cancelled }` on failure/cancellation so the caller can
// surface a toast to the user.
function printImageDataUrl(dataUrl) {
  if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:")) {
    console.error("[PrintImage] Invalid image data received (expected a data URL).");
    return Promise.resolve({ ok: false, error: "Invalid image data." });
  }

  let printWin;
  try {
    printWin = new BrowserWindow({
      width: 900,
      height: 700,
      center: true,
      show: false,
      skipTaskbar: true,
      title: "Print",
      // Background throttling off: an unfocused/occluded print window must keep
      // rendering the page while the print is prepared, or the output is blank.
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        backgroundThrottling: false,
      },
    });
  } catch (err) {
    console.error("[PrintImage] Failed to create the print window.", err);
    return Promise.resolve({ ok: false, error: "Failed to open the print window." });
  }

  // Shown without activation: the print is silent, so the window must not take
  // the keyboard focus (or a taskbar slot) away from the worker. It stays up
  // only while the image is prepared and handed to the printer.
  printWin.showInactive();

  return new Promise((resolve) => {
    let tempFile = "";
    let settled = false;
    let loadTimer = null;
    let printTimer = null;
    // Only prepare and print one job even if did-finish-load fires again.
    let preparingPrint = false;

    // Resolve exactly once and clean up (close the window + remove temp file).
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (loadTimer) clearTimeout(loadTimer);
      if (printTimer) clearTimeout(printTimer);
      try {
        printWin.close();
      } catch (err) {
        console.error("[PrintImage] Error closing the print window.", err);
      }
      if (tempFile) {
        fs.promises.unlink(tempFile).catch((err) => {
          console.error("[PrintImage] Failed to remove temp file:", tempFile, err);
        });
      }
      resolve(result);
    };

    // Fail-safe: if the document never finishes loading, give up after a
    // bounded wait instead of leaving the renderer's print request hanging.
    loadTimer = setTimeout(() => {
      finish({ ok: false, error: "Timed out loading the document for printing." });
    }, PrintLoadTimeoutMs);

    printWin.webContents.on("did-finish-load", () => {
      clearTimeout(loadTimer);
      if (preparingPrint) return;
      preparingPrint = true;
      (async () => {
        try {
          // Printing before the image decodes produced white pages for large
          // scans, so wait for the <img> to be fully decoded first.
          const imageState = await WaitForImageDecode(printWin.webContents);
          if (settled) return;
          if (imageState === "error" || imageState === "missing") {
            console.error(`[PrintImage] The image could not be rendered (${imageState}).`);
            finish({ ok: false, error: "The image could not be rendered for printing." });
            return;
          }
          if (imageState === "timeout") {
            console.warn(
              "[PrintImage] The image did not finish decoding in time; continuing."
            );
          }
          await printDelay(PrintSettleAfterReadyMs);
          if (settled) return;

          // Never send a white page to the printer.
          const check = await CheckPrintableContent(
            printWin.webContents,
            "[PrintImage]",
            "image"
          );
          if (settled) return;
          if (check.state === "blank") {
            console.error("[PrintImage] Refusing to print: the page rendered blank.");
            finish({
              ok: false,
              error: "The image did not render (blank page), so nothing was printed.",
            });
            return;
          }
          if (check.state === "unknown") {
            console.warn("[PrintImage] Could not verify the print output; printing anyway.");
          }

          const printOptions = await PrintOptionsFor(printWin.webContents, "[PrintImage]");
          if (settled) return;
          // Only the fallback dialog needs to be brought to the foreground; a
          // silent print opens no dialog at all.
          if (printOptions.silent !== true) {
            printWin.focus();
            printWin.webContents.focus();
          }
          // Fail-safe: if print() never reports back, settle and clean up rather
          // than leaving a lingering print window behind.
          const silent = printOptions.silent === true;
          printTimer = setTimeout(() => {
            if (silent) {
              // Nothing is waiting for the worker: the image was already handed
              // to the spooler, so an unreported silent job counts as sent. It
              // can be printed again from the viewer/attachment Print button.
              console.warn(
                "[PrintImage] No print result reported; the job was already handed to the printer."
              );
              finish({ ok: true, unconfirmed: true });
              return;
            }
            finish({ ok: false, error: "Timed out waiting for the print dialog." });
          }, silent ? PrintSilentHandoffMs : PrintResultTimeoutMs);
          const result = printWin.webContents.print(printOptions, (success, failureReason) => {
            if (settled) return;
            if (success) {
              console.log("[PrintImage] Print job completed successfully.");
              finish({ ok: true });
            } else {
              const cancelled = /cancel/i.test(failureReason || "");
              const message = `[PrintImage] Print ${cancelled ? "cancelled" : "failed"}` +
                (failureReason ? `: ${failureReason}` : ".");
              if (cancelled) console.log(message);
              else console.error(message);
              finish({
                ok: false,
                cancelled,
                error: failureReason || (cancelled ? "Print cancelled." : "Print failed."),
              });
            }
          });
          // Newer Electron versions return a Promise from print() (and some may
          // stop invoking the callback). Handle both so a print is recorded as
          // a success or failure exactly once.
          if (result && typeof result.then === "function") {
            result.then(
              () => {
                if (settled) return;
                console.log("[PrintImage] Print job completed successfully (promise).");
                finish({ ok: true });
              },
              (err) => {
                if (settled) return;
                const message = String((err && err.message) || err);
                console.error("[PrintImage] print() promise rejected.", err);
                finish({ ok: false, cancelled: /cancel/i.test(message), error: message });
              }
            );
          }
        } catch (err) {
          console.error("[PrintImage] Exception while calling print().", err);
          finish({ ok: false, error: String(err) });
        }
      })();
    });

    printWin.webContents.on("did-fail-load", (e, errorCode, errorDescription) => {
      console.error(
        `[PrintImage] Failed to load the print document` +
        ` (${errorCode}${errorDescription ? ": " + errorDescription : ""}).`
      );
      finish({
        ok: false,
        error: errorDescription || "Failed to load the print document.",
      });
    });

    // Wrap the image in an HTML document so it fills the page and prints well.
    //
    // The document is written to a temp file and loaded with loadFile() instead
    // of navigating to a giant `data:` URL. Chromium caps navigation URLs at
    // 2 MB (url::kMaxURLChars), so a large base64 image used to make loadURL()
    // fail silently and the print never started — the print button looked like
    // it did nothing. loadFile() has no such limit, and the embedded
    // <img src="data:..."> is fetched as a subresource (exactly like the
    // on-screen viewer already does), so large images now print correctly.
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8" />
  <title>Print</title>
  <style>
    html, body { margin: 0; padding: 0; }
    img { display: block; max-width: 100%; max-height: 100vh; margin: 0 auto; }
  </style></head>
  <body><img src="${dataUrl}" /></body></html>`;

    const dir = path.join(app.getPath("temp"), "insurance-print");
    tempFile = path.join(dir, `print-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.html`);

    (async () => {
      try {
        await fs.promises.mkdir(dir, { recursive: true });
        await fs.promises.writeFile(tempFile, html, "utf8");
      } catch (err) {
        console.error("[PrintImage] Failed to write the temp print document.", err);
        finish({ ok: false, error: "Failed to prepare the print document." });
        return;
      }

      try {
        await printWin.loadFile(tempFile);
      } catch (err) {
        console.error("[PrintImage] Failed to load the temp print document.", err);
        finish({ ok: false, error: String(err) });
      }
    })();
  });
}

ipcMain.handle("PrintImage", async (event, dataUrl) => {
  return printImageDataUrl(dataUrl);
});

// Pick a temp-file extension for a file the worker wants to print manually.
// Prefer the original file's extension; fall back from the MIME type; default
// to ".pdf" so policy PDFs (the common case) always print correctly.
function AttachmentPrintExt(filename, mimeType) {
  const name = String(filename || "");
  const dot = name.lastIndexOf(".");
  if (dot > -1 && dot < name.length - 1) {
    const ext = name.slice(dot).toLowerCase();
    if (/^\.[a-z0-9]{1,10}$/.test(ext)) return ext;
  }

  const mime = String(mimeType || "").toLowerCase();
  if (mime === "application/pdf") return ".pdf";
  if (mime === "image/png") return ".png";
  if (mime === "image/jpeg") return ".jpg";
  if (mime === "image/gif") return ".gif";
  if (mime === "image/webp") return ".webp";
  if (mime === "image/bmp") return ".bmp";
  return ".pdf";
}

// Print a single attached file on demand. The renderer shows a "Print" button
// next to each upload so the worker can manually print a paper copy even after
// the automatic Desktop print has already finished.
ipcMain.handle("PrintAttachment", async (event, file) => {
  if (!file || typeof file.base64 !== "string" || !file.base64) {
    console.error("[PrintAttachment] Invalid attachment data received.");
    return { ok: false, error: "Invalid attachment data." };
  }

  const filename = String(file.filename || "attachment");
  const mimeType = String(file.mimeType || "").toLowerCase();

  if (mimeType.startsWith("image/")) {
    return printImageDataUrl(`data:${file.mimeType};base64,${file.base64}`);
  }

  return PrintDocument(file.base64, filename, AttachmentPrintExt(filename, mimeType), "[PrintAttachment]");
});

// Open an image (data URL) with the system's default image viewer, i.e.
// outside of the Electron window. The data is written to a temp file with the
// correct extension and then handed off to the OS via shell.openPath().
ipcMain.on("OpenImageExternal", (event, dataUrl) => {
  if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:")) {
    console.error("[OpenImageExternal] Invalid image data received (expected a data URL).");
    return;
  }

  const comma = dataUrl.indexOf(",");
  if (comma === -1) {
    console.error("[OpenImageExternal] Malformed data URL (missing comma separator).");
    return;
  }

  const header = dataUrl.slice(0, comma);
  const payload = dataUrl.slice(comma + 1);

  const mimeMatch = header.match(/^data:([^;]+)/);
  const mimeType = mimeMatch ? mimeMatch[1] : "image/png";

  // Map the MIME type to a file extension. Falls back to .png.
  const MIME_EXT = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "image/bmp": ".bmp",
    "image/svg+xml": ".svg",
  };
  const ext = MIME_EXT[mimeType] || ".png";

  let buffer;
  try {
    buffer = Buffer.from(payload, "base64");
  } catch (err) {
    console.error("[OpenImageExternal] Failed to decode base64 image data.", err);
    return;
  }

  const dir = path.join(app.getPath("temp"), "insurance-viewer");
  fs.mkdir(dir, { recursive: true }, (err) => {
    if (err) {
      console.error("[OpenImageExternal] Failed to create temp directory:", err);
      return;
    }

    const filePath = path.join(dir, `image-${Date.now()}${ext}`);
    fs.writeFile(filePath, buffer, (writeErr) => {
      if (writeErr) {
        console.error("[OpenImageExternal] Failed to write temp image file:", writeErr);
        return;
      }
      shell.openPath(filePath).catch((err) => {
        console.error("[OpenImageExternal] Could not open the image externally:", err);
      });
    });
  });
});

// Open any email attachment (PDF, Word, Excel, …) with the system's default
// application. The bytes are written to a temp file that keeps the original
// (sanitized) file name and extension, so the OS picks the right program.
ipcMain.on("OpenAttachmentExternal", (event, file) => {
  if (!file || typeof file.base64 !== "string" || !file.base64) {
    console.error("[OpenAttachmentExternal] Invalid attachment data received.");
    return;
  }

  let name = String(file.filename || "attachment")
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
    .replace(/[. ]+$/, "")
    .trim();
  if (!name || name === "." || name === "..") name = "attachment";
  if (!path.extname(name) && file.mimeType === "application/pdf") name += ".pdf";

  let buffer;
  try {
    buffer = Buffer.from(file.base64, "base64");
  } catch (err) {
    console.error("[OpenAttachmentExternal] Failed to decode base64 data.", err);
    return;
  }

  // A fresh sub-folder per open keeps the original file name without
  // colliding with (or overwriting) a file that is still open elsewhere.
  const dir = path.join(
    app.getPath("temp"),
    "insurance-attachments",
    String(Date.now())
  );
  fs.mkdir(dir, { recursive: true }, (err) => {
    if (err) {
      console.error("[OpenAttachmentExternal] Failed to create temp directory:", err);
      return;
    }
    const filePath = path.join(dir, name);
    fs.writeFile(filePath, buffer, (writeErr) => {
      if (writeErr) {
        console.error("[OpenAttachmentExternal] Failed to write temp file:", writeErr);
        return;
      }
      shell.openPath(filePath).then((errorMessage) => {
        if (errorMessage) {
          console.error("[OpenAttachmentExternal] Could not open the file:", errorMessage);
        }
      });
    });
  });
});
