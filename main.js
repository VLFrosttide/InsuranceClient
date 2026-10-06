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
} from "electron";
import path from "path";
import fs from "fs";
import electronUpdater from "electron-updater";
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

  autoUpdater.on("update-downloaded", (info) => {
    const options = {
      type: "info",
      buttons: ["Restart now", "Later"],
      defaultId: 0,
      cancelId: 1,
      title: "Update available",
      message: `Version ${info.version} has been downloaded.`,
      detail: "Restart the application to apply the update.",
    };
    // `win` may be closed/destroyed by the time the download finishes, so fall
    // back to a parent-less dialog instead of crashing.
    const choice =
      win && !win.isDestroyed()
        ? dialog.showMessageBoxSync(win, options)
        : dialog.showMessageBoxSync(options);
    if (choice === 0) autoUpdater.quitAndInstall();
  });

  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  check();
  // Re-check every hour while the app stays open.
  setInterval(check, 60 * 60 * 1000);
};

app.whenReady().then(() => {
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
