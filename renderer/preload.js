const { ipcRenderer, contextBridge } = require("electron");
//Example window.bridge.GlobalKey((event, data) => {})
// Or window.bridge.GlobalKey()

contextBridge.exposeInMainWorld("bridge", {
  LoadNewPage: (page) => {
    ipcRenderer.send("LoadPage", page);
  },
  PrintImage: (dataUrl) => {
    return ipcRenderer.invoke("PrintImage", dataUrl);
  },
  OpenImageExternal: (dataUrl) => {
    ipcRenderer.send("OpenImageExternal", dataUrl);
  },
  // Open any email attachment (PDF, document, …) with the OS default app.
  // file: { filename, mimeType, base64 }
  OpenAttachmentExternal: (file) => {
    ipcRenderer.send("OpenAttachmentExternal", file);
  },

  // Durable outbox (main process): requests that keep retrying until they
  // reach the server, across page changes and app restarts.
  OutboxSubmit: (req, waitMs) => ipcRenderer.invoke("OutboxSubmit", req, waitMs),
  OutboxGetState: () => ipcRenderer.invoke("OutboxGetState"),
  OutboxRetryAll: (includeFailed) =>
    ipcRenderer.invoke("OutboxRetryAll", includeFailed === true),
  OutboxRetry: (id) => ipcRenderer.invoke("OutboxRetry", id),
  OutboxDiscard: (id) => ipcRenderer.invoke("OutboxDiscard", id),
  OutboxAcknowledge: (id) => ipcRenderer.invoke("OutboxAcknowledge", id),
  OutboxUpdateToken: (username, token) =>
    ipcRenderer.invoke("OutboxUpdateToken", username, token),
  // Subscribe to queue changes / late deliveries. Returns an unsubscribe fn.
  OnOutboxState: (callback) => {
    const listener = (event, state) => callback(state);
    ipcRenderer.on("OutboxState", listener);
    return () => ipcRenderer.removeListener("OutboxState", listener);
  },
  OnOutboxDelivered: (callback) => {
    const listener = (event, payload) => callback(payload);
    ipcRenderer.on("OutboxDelivered", listener);
    return () => ipcRenderer.removeListener("OutboxDelivered", listener);
  },
});
// GetIconPath: (callback) => ipcRenderer.on("GetIconPath", callback),
