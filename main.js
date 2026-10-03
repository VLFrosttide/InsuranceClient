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
} from "electron";
import path from "path";
let win;
let MenuTemp;
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
};

app.whenReady().then(() => {
  CreateWindow();
  MenuTemp = [
    { label: "Reload", accelerator: "Ctrl+R", role: "forceReload" },
    {
      label: "Dev tools",
      role: "toggleDevTools",
      accelerator: "Ctrl+`",
    },
  ];
  const menu = Menu.buildFromTemplate(MenuTemp);
  Menu.setApplicationMenu(menu);
});

ipcMain.on("LoadPage", (event, page) => {
  win.loadFile(page);
});
