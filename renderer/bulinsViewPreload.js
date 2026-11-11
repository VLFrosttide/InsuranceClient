const { contextBridge, ipcRenderer } = require("electron");

// Bridge for the Bulins web form loaded in a WebContentsView. The floating
// "← Insurance" button injected into the page calls close() to hand control
// back to the app.
contextBridge.exposeInMainWorld("bulinsBridge", {
  close: () => ipcRenderer.send("BulinsViewCloseRequest"),
});
