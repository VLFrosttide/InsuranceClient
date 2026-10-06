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

const CreateWindow = () => {
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    x: 60,
    y: 40,
    title: "Insurance",

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

  autoUpdater.on("error", (err) => {
    console.error("Auto-update error:", err);
  });

  autoUpdater.on("update-downloaded", (info) => {
    const choice = dialog.showMessageBoxSync(win, {
      type: "info",
      buttons: ["Restart now", "Later"],
      defaultId: 0,
      cancelId: 1,
      title: "Update available",
      message: `Version ${info.version} has been downloaded.`,
      detail: "Restart the application to apply the update.",
    });
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

// Read the sample daily-report file bundled in the repo's "Test" folder so the
// admin "Reconcile daily report" view can run its test button against real
// report data. Only files already inside that folder are readable (the caller
// passes no path), so this cannot be abused to read arbitrary files.
ipcMain.handle("ReadTestReport", async () => {
  const dir = path.join(app.getAppPath(), "Test");
  let filePath = null;
  try {
    const entries = fs.readdirSync(dir);
    const report = entries.find((n) => /\.(xlsx|xlsm)$/i.test(n));
    if (report) filePath = path.join(dir, report);
  } catch {
    filePath = null;
  }
  if (!filePath) return { ok: false };

  try {
    const data = await fs.promises.readFile(filePath);
    return { ok: true, name: path.basename(filePath), data: data.toString("base64") };
  } catch {
    return { ok: false };
  }
});

// Print an image (data URL) by loading it in a hidden window and invoking the
// system print dialog. Used by the "printable picture" feature.
ipcMain.on("PrintImage", (event, dataUrl) => {
  if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:")) return;

  let printWin;
  try {
    printWin = new BrowserWindow({
      show: false,
      webPreferences: { sandbox: true, contextIsolation: true },
    });
  } catch {
    return;
  }

  printWin.webContents.on("did-finish-load", () => {
    const close = () => {
      try {
        printWin.close();
      } catch {
        // ignore
      }
    };
    try {
      const result = printWin.webContents.print({}, () => {
        // Older Electron versions call this callback when printing finishes.
        close();
      });
      // Newer Electron versions return a Promise from print().
      if (result && typeof result.then === "function") {
        result.then(close, close);
      }
    } catch {
      close();
    }
  });

  printWin.webContents.on("did-fail-load", () => {
    try {
      printWin.close();
    } catch {
      // ignore
    }
  });

  // Wrap the image in an HTML document so it fills the page and prints well.
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8" />
  <title>Print</title>
  <style>
    html, body { margin: 0; padding: 0; }
    img { display: block; max-width: 100%; max-height: 100vh; margin: 0 auto; }
  </style></head>
  <body><img src="${dataUrl}" /></body></html>`;

  printWin
    .loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
    .catch(() => {
      try {
        printWin.close();
      } catch {
        // ignore
      }
    });
});

// Open an image (data URL) with the system's default image viewer, i.e.
// outside of the Electron window. The data is written to a temp file with the
// correct extension and then handed off to the OS via shell.openPath().
ipcMain.on("OpenImageExternal", (event, dataUrl) => {
  if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:")) return;

  const comma = dataUrl.indexOf(",");
  if (comma === -1) return;

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
  } catch {
    return;
  }

  const dir = path.join(app.getPath("temp"), "insurance-viewer");
  fs.mkdir(dir, { recursive: true }, (err) => {
    if (err) return;

    const filePath = path.join(dir, `image-${Date.now()}${ext}`);
    fs.writeFile(filePath, buffer, (writeErr) => {
      if (writeErr) return;
      shell.openPath(filePath).catch(() => {
        // Ignore: the OS could not open the file (e.g. no default app).
      });
    });
  });
});
