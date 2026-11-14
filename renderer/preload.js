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
  // Open the native print dialog for a single attached file (image or PDF) so
  // the worker can manually print a paper copy on demand.
  // file: { filename, mimeType, base64 }
  PrintAttachment: (file) => {
    return ipcRenderer.invoke("PrintAttachment", file);
  },

  // Desktop PDF watcher: while an email-sourced policy is being processed, the
  // worker's tools download the two policy PDFs to the Desktop. The main process
  // polls every two seconds, streams the new PDFs back here and then deletes
  // them from the Desktop.
  StartDesktopPdfWatch: (sinceMs) =>
    ipcRenderer.invoke("StartDesktopPdfWatch", sinceMs),
  StopDesktopPdfWatch: () => ipcRenderer.invoke("StopDesktopPdfWatch"),
  OnDesktopPdfFound: (callback) => {
    const listener = (event, file) => callback(file);
    ipcRenderer.on("DesktopPdfFound", listener);
    return () => ipcRenderer.removeListener("DesktopPdfFound", listener);
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
  // Privileged raw WebSocket-upgrade probe (bypasses CORS + browser redirect
  // hiding) so the renderer can learn the status + Location a CDN returned.
  WsHandshakeProbe: () => ipcRenderer.invoke("WsHandshakeProbe"),
  // Timed GET /ping from the main process: DNS, TCP, TLS and first-byte
  // timings, so a failed login can say which stage is slow or blocked.
  DiagnoseServer: () => ipcRenderer.invoke("ServerDiagnose"),
  // Append one line to userData/logs/network.log (the trail a worker can hand
  // over when a login misbehaves only on their network).
  LogEvent: (channel, message) =>
    ipcRenderer.send("ClientLog", String(channel || "client"), String(message || "")),
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

  // Bulins border-insurance web form (WebContentsView). Opening an email or a
  // walk-in insurance shows this form instead of the in-app form; the main
  // process scrapes every page the worker visits.
  BulinsOpen: (context) => ipcRenderer.invoke("BulinsOpen", context),
  BulinsClose: () => ipcRenderer.invoke("BulinsClose"),
  BulinsGetState: () => ipcRenderer.invoke("BulinsGetState"),
  BulinsListScrapes: (limit) => ipcRenderer.invoke("BulinsListScrapes", limit),
  OnBulinsScraped: (callback) => {
    const listener = (event, entry) => callback(entry);
    ipcRenderer.on("BulinsScraped", listener);
    return () => ipcRenderer.removeListener("BulinsScraped", listener);
  },
  OnBulinsClosed: (callback) => {
    const listener = (event, context) => callback(context);
    ipcRenderer.on("BulinsClosed", listener);
    return () => ipcRenderer.removeListener("BulinsClosed", listener);
  },
});
// GetIconPath: (callback) => ipcRenderer.on("GetIconPath", callback),
