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
} from "electron";
import path from "path";
import fs from "fs";
import https from "node:https";
import crypto from "node:crypto";
import electronUpdater from "electron-updater";
import { Outbox } from "./outbox.js";
const { autoUpdater } = electronUpdater;
let win;
let PreloadPath = path.join(app.getAppPath(), "/renderer/preload.js");

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
      contentSecurityPolicy:
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self' https://lavender-quail-935384.hostingersite.com wss://lavender-quail-935384.hostingersite.com http://127.0.0.1:5501 http://localhost:5501 ws://127.0.0.1:5501 ws://localhost:5501; manifest-src 'self';",
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

// Auto-update from GitHub Releases. Only runs in the packaged app.
const SetupAutoUpdater = () => {
  if (!app.isPackaged) return;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  // Log each lifecycle step so update behaviour is easy to trace when
  // diagnosing whether auto-update is working.
  autoUpdater.on("checking-for-update", () => {
    console.log("Auto-update: checking for updates…");
  });
  autoUpdater.on("update-available", (info) => {
    console.log(`Auto-update: version ${info.version} available, downloading…`);
  });
  autoUpdater.on("update-not-available", () => {
    console.log("Auto-update: already up to date.");
  });

  autoUpdater.on("error", (err) => {
    console.error("Auto-update error:", err);
  });

  // "Restart now" on an update must not be blocked by the unsent-policies
  // prompt: queued policies are on disk and are sent after the restart.
  autoUpdater.on("before-quit-for-update", () => {
    closeConfirmed = true;
  });

  // Remember which version the user was already asked about, so a periodic
  // re-check (which re-emits "update-downloaded" for the cached download) does
  // not nag them again after they chose "Later". A newer release still prompts.
  let promptedVersion = null;
  let promptOpen = false;

  autoUpdater.on("update-downloaded", async (info) => {
    if (promptOpen || info.version === promptedVersion) return;
    promptedVersion = info.version;
    promptOpen = true;

    const options = {
      type: "info",
      buttons: ["Restart now", "Later"],
      defaultId: 0,
      cancelId: 1,
      title: "Update available",
      message: `Version ${info.version} has been downloaded.`,
      detail:
        "Restart the application to apply the update. If you choose Later, it will be installed automatically the next time the app is closed.",
    };
    try {
      // Async dialog so the main process (IPC, printing, …) is not blocked
      // while the prompt is waiting for the user. `win` may be destroyed by the
      // time the download finishes, so fall back to a parent-less dialog.
      const { response } =
        win && !win.isDestroyed()
          ? await dialog.showMessageBox(win, options)
          : await dialog.showMessageBox(options);
      if (response === 0) autoUpdater.quitAndInstall();
    } catch (err) {
      console.error("Auto-update: failed to show the update prompt:", err);
    } finally {
      promptOpen = false;
    }
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
// Only these API origins may be used by queued requests (same list as the CSP).
const OUTBOX_ALLOWED_ORIGINS = new Set([
  "https://lavender-quail-935384.hostingersite.com",
  "http://127.0.0.1:5501",
  "http://localhost:5501",
]);
const OUTBOX_ALLOWED_PATHS = new Set(["/worker/insurances"]);
const OUTBOX_DEFAULT_ORIGIN = "https://lavender-quail-935384.hostingersite.com";

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
// While a worker processes an email-sourced policy, an external tool downloads
// the policy PDFs to the user's Desktop. The renderer starts this watcher when
// the email card is clicked; we then poll the Desktop every second for PDFs
// created after that moment, push their bytes to the form at once, delete the
// source files, and queue a paper-copy print in the background (see the print
// queue below).
//
// Both PDFs are auto-attached to the form. The policy PDF itself
// ("BG_02_ FI<policy>.pdf") is uploaded but never auto-printed; only the
// remaining PDF gets a paper copy. The watcher stops itself once it has
// collected both files.
let DesktopPdfWatch = null; // { sinceMs, timer, emitted, sizes, foundPolicy, foundOther }

function DesktopPdfDirectory() {
  try {
    return app.getPath("desktop");
  } catch (err) {
    console.error("[DesktopPdfWatch] Could not resolve the Desktop path:", err);
    return null;
  }
}

function StopDesktopPdfWatch() {
  if (!DesktopPdfWatch) return;
  if (DesktopPdfWatch.timer) clearInterval(DesktopPdfWatch.timer);
  DesktopPdfWatch = null;
}

// Give up loading a document for printing after this long (did-finish-load
// never firing otherwise wedges the print request).
const PrintLoadTimeoutMs = 20000;
// Settle time after the document finishes loading before print is issued;
// printing too early can produce blank pages.
const PrintRenderDelayMs = 500;
// Give up waiting for webContents.print() to finish after this long. On some
// Electron versions printing a loaded PDF never fires the print callback, which
// would otherwise leave the print promise (and the queue) hanging and the
// "Print" window open forever. Generous because the native dialog is
// interactive; the timer only fires when nothing settles the print in time.
const PrintResultTimeoutMs = 5 * 60 * 1000;

let DesktopPdfScanning = false;

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
    if (DesktopPdfWatch.emitted.has(filePath)) continue;

    // The policy PDF ("BG_02_ FI<policy>.pdf") is auto-attached like every
    // other PDF, but it is never auto-printed: only the remaining PDF gets a
    // paper copy.
    const isPolicyPdf = /^BG_02_\s*FI/i.test(entry.name);

    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch (err) {
      continue; // transient (still being written) — retry next poll
    }

    // "Downloaded after the click": prefer the file's creation time and fall
    // back to its modification time on filesystems that report birthtime as 0.
    const createdMs =
      Number.isFinite(stat.birthtimeMs) && stat.birthtimeMs > 0
        ? stat.birthtimeMs
        : stat.mtimeMs;
    if (!(createdMs > DesktopPdfWatch.sinceMs)) continue;

    // A download may still be in progress (its size keeps growing). Accept the
    // file only once its size has held steady across one poll cycle.
    if (DesktopPdfWatch.sizes.get(filePath) !== stat.size) {
      DesktopPdfWatch.sizes.set(filePath, stat.size);
      continue;
    }
    DesktopPdfWatch.sizes.delete(filePath);

    let base64;
    try {
      base64 = fs.readFileSync(filePath).toString("base64");
    } catch (err) {
      console.error(`[DesktopPdfWatch] Failed to read "${entry.name}":`, err);
      continue;
    }

    // Capture is complete: push the bytes to the form immediately so the
    // upload is never blocked by printing, mark the file handled, and remove
    // the Desktop copy. A paper copy is printed afterwards in the background
    // queue (its bytes are already safe in the queue, so deleting the source
    // file here cannot lose the policy).
    DesktopPdfWatch.emitted.add(filePath);
    if (isPolicyPdf) {
      DesktopPdfWatch.foundPolicy = true;
    } else {
      DesktopPdfWatch.foundOther = true;
    }

    if (win && !win.isDestroyed()) {
      win.webContents.send("DesktopPdfFound", {
        filename: entry.name,
        mimeType: "application/pdf",
        size: stat.size,
        base64,
      });
    }

    try {
      fs.unlinkSync(filePath);
    } catch (err) {
      console.error(`[DesktopPdfWatch] Failed to delete "${entry.name}":`, err);
    }

    // Only the non-policy PDF is printed automatically.
    if (!isPolicyPdf) {
      enqueueDesktopPrint(base64, entry.name);
    }

    if (DesktopPdfWatch.foundPolicy && DesktopPdfWatch.foundOther) {
      StopDesktopPdfWatch();
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Desktop PDF print queue
// ---------------------------------------------------------------------------
// Printing a paper copy is decoupled from the Desktop scan so the native print
// dialog — which blocks until the worker responds — can never stall the upload
// of the next PDF or wedge the watcher. PDFs are printed one at a time in the
// background. Each job is attempted exactly once: once the user has interacted
// with the dialog (printed or cancelled) — or the print has failed — the dialog
// is never re-opened automatically, so the print window cannot pop up again
// after the user is already done with it.
let DesktopPrintQueue = []; // { base64, filename }
let DesktopPrintRunning = false;

function enqueueDesktopPrint(base64, filename) {
  if (!base64) return;
  if (DesktopPrintQueue.some((job) => job.filename === filename)) return;
  DesktopPrintQueue.push({ base64, filename });
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

      if (result && result.ok) continue;

      // The paper copy is finished one way or another: it printed, the user
      // dismissed the dialog, or it failed. Do NOT re-open the print dialog on
      // its own — that made the dialog reappear even after the user had already
      // clicked Print (and after the physical page had finished). Log the
      // outcome and move on to the next queued PDF instead.
      if (result && result.cancelled) {
        console.log(`[DesktopPdfWatch] Printing of "${job.filename}" was cancelled.`);
      } else {
        console.warn(
          `[DesktopPdfWatch] Printing of "${job.filename}" did not complete` +
            (result && result.error ? `: ${result.error}` : ".")
        );
      }
    }
  } finally {
    DesktopPrintRunning = false;
  }
}

// Print a document (usually a PDF, but any file Chromium can render) to the
// system printer. Mirrors printImageDataUrl: the bytes are written to a temp
// file, loaded in a visible window and handed to webContents.print(), which
// opens the native print dialog. A settle delay after the page loads lets the
// viewer finish rendering before the print is issued (printing too early used
// to produce blank pages), and a load timeout prevents a stalled view from
// hanging forever.
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

    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (loadTimer) clearTimeout(loadTimer);
      if (printTimer) clearTimeout(printTimer);
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
      // avoids the blank-page issues seen with hidden windows.
      printWin = new BrowserWindow({
        width: 900,
        height: 700,
        center: true,
        title: "Print",
        webPreferences: { sandbox: true, contextIsolation: true },
      });
    } catch (err) {
      console.error(`${logTag} Failed to create print window for "${filename}".`, err);
      finish({ ok: false, error: "Failed to open the print window." });
      return;
    }

    // Bring the print window (and the native print dialog it will open) to the
    // foreground so it is immediately visible and targetable instead of popping
    // up behind the main window without focus.
    printWin.show();
    printWin.focus();
    printWin.webContents.focus();

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
      // Give the PDF viewer a moment to finish rendering, then print.
      setTimeout(() => {
        if (settled) return;
        try {
          // Focus again right before the native print dialog opens so it (and
          // the dialog) sits in the foreground rather than behind other windows.
          printWin.focus();
          printWin.webContents.focus();
          // Fail-safe: if print() never reports back (some Electron versions
          // skip the callback when printing a PDF), settle and clean up rather
          // than leaving the promise hanging and the window open forever.
          printTimer = setTimeout(() => {
            finish({ ok: false, error: "Timed out waiting for the print dialog." });
          }, PrintResultTimeoutMs);
          const result = printWin.webContents.print({}, (success, failureReason) => {
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
      }, PrintRenderDelayMs);
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

ipcMain.handle("StartDesktopPdfWatch", (event, sinceMs) => {
  const dir = DesktopPdfDirectory();
  if (!dir) return { ok: false };

  const since = Number(sinceMs) || Date.now();
  StopDesktopPdfWatch();
  DesktopPdfWatch = {
    sinceMs: since,
    timer: setInterval(ScanDesktopPdfs, 1000),
    emitted: new Set(),
    sizes: new Map(),
    foundPolicy: false,
    foundOther: false,
  };
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

app.whenReady().then(() => {
  SetupOutbox();
  CreateWindow();
  Menu.setApplicationMenu(null);
  SetupAutoUpdater();
});

ipcMain.on("LoadPage", (event, page) => {
  win.loadFile(page);
});

// Print an image (data URL) by loading it in a visible window and invoking the
// system print dialog. Used by the "printable picture" feature and by the
// per-file "Print" button for image attachments.
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
      title: "Print",
      webPreferences: { sandbox: true, contextIsolation: true },
    });
  } catch (err) {
    console.error("[PrintImage] Failed to create the print window.", err);
    return Promise.resolve({ ok: false, error: "Failed to open the print window." });
  }

  // Bring the print window (and the native print dialog it will open) to the
  // foreground so it is immediately visible and targetable instead of popping
  // up behind the main window without focus.
  printWin.show();
  printWin.focus();
  printWin.webContents.focus();

  return new Promise((resolve) => {
    let tempFile = "";
    let settled = false;
    let loadTimer = null;
    let printTimer = null;

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
      // Give the image a moment to finish rendering, then print.
      setTimeout(() => {
        if (settled) return;
        try {
          // Focus again right before the native print dialog opens so it (and
          // the dialog) sits in the foreground rather than behind other windows.
          printWin.focus();
          printWin.webContents.focus();
          // Fail-safe: if print() never reports back, settle and clean up rather
          // than leaving a lingering print window behind.
          printTimer = setTimeout(() => {
            finish({ ok: false, error: "Timed out waiting for the print dialog." });
          }, PrintResultTimeoutMs);
          const result = printWin.webContents.print({}, (success, failureReason) => {
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
      }, PrintRenderDelayMs);
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
    // fail silently and the print dialog never appeared — the print button
    // looked like it did nothing. loadFile() has no such limit, and the embedded
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
