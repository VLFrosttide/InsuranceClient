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

// Print an image (data URL) by loading it in a hidden window and invoking the
// system print dialog. Used by the "printable picture" feature.
//
// Resolves with `{ ok: true }` on success, or
// `{ ok: false, error, cancelled }` on failure/cancellation so the renderer can
// surface a toast to the user.
ipcMain.handle("PrintImage", async (event, dataUrl) => {
  if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:")) {
    console.error("[PrintImage] Invalid image data received (expected a data URL).");
    return { ok: false, error: "Invalid image data." };
  }

  let printWin;
  try {
    printWin = new BrowserWindow({
      show: false,
      webPreferences: { sandbox: true, contextIsolation: true },
    });
  } catch (err) {
    console.error("[PrintImage] Failed to create the hidden print window.", err);
    return { ok: false, error: "Failed to open the print window." };
  }

  return new Promise((resolve) => {
    let tempFile = "";
    let settled = false;

    // Resolve exactly once and clean up (close the window + remove temp file).
    const finish = (result) => {
      if (settled) return;
      settled = true;
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

    printWin.webContents.on("did-finish-load", () => {
      try {
        const result = printWin.webContents.print({}, (success, failureReason) => {
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
        // Newer Electron versions return a Promise from print().
        if (result && typeof result.then === "function") {
          result.then(
            () => {
              console.log("[PrintImage] Print job completed successfully (promise).");
              finish({ ok: true });
            },
            (err) => {
              console.error("[PrintImage] print() promise rejected.", err);
              finish({ ok: false, error: String(err) });
            }
          );
        }
      } catch (err) {
        console.error("[PrintImage] Exception while calling print().", err);
        finish({ ok: false, error: String(err) });
      }
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
    tempFile = path.join(dir, `print-${Date.now()}.html`);

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
