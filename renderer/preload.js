const { ipcRenderer, contextBridge } = require("electron");
//Example window.bridge.GlobalKey((event, data) => {})
// Or window.bridge.GlobalKey()

// The API host for this build. main.js takes it from config.js (API_DOMAIN) and
// passes it down through webPreferences.additionalArguments, so no renderer
// file has to hardcode the domain.
const ArgValue = (prefix) => {
  const hit = (process.argv || []).find((arg) => String(arg).startsWith(prefix));
  return hit ? String(hit).slice(prefix.length) : "";
};
const API_BASE = ArgValue("--api-base=");
const WS_URL = ArgValue("--ws-url=");

contextBridge.exposeInMainWorld("bridge", {
  // ---------------------------------------------------------------------------
  // API host (renderer/common.js reads these as API_BASE / WS_URL).
  // apiBase: https origin of the API, wsUrl: its wss .../ws endpoint.
  // ---------------------------------------------------------------------------
  ApiBase: API_BASE,
  WsUrl: WS_URL,

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

  // Desktop PDF watcher: while a policy is being processed, the worker's tools
  // download the two policy PDFs to the Desktop. The main process polls the
  // Desktop and either streams the new PDFs back here (email policies) or
  // prints them both and deletes them (walk-in insurances).
  // options: { mode: "email" | "walkin" }
  StartDesktopPdfWatch: (sinceMs, options) =>
    ipcRenderer.invoke("StartDesktopPdfWatch", sinceMs, options),
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

  // ---------------------------------------------------------------------------
  // Client diagnostics (renderer/diag.js).
  //
  // Failed requests (403 first) are kept in userData/diag/pending.jsonl by the
  // main process so they survive page changes and restarts, then uploaded to
  // the server when it is reachable again. DiagContext supplies the facts the
  // renderer cannot read: proxy, public IP, TLS issuer, hostname, versions.
  // ---------------------------------------------------------------------------
  DiagRead: () => ipcRenderer.invoke("DiagQueueRead"),
  DiagSave: (queue) => ipcRenderer.invoke("DiagQueueSave", queue),
  DiagState: () => ipcRenderer.invoke("DiagQueueState"),
  DiagContext: (force) => ipcRenderer.invoke("DiagContext", force === true),
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

  // Auto-update banner. The download state is owned by the main process (a page
  // change destroys this renderer), so a page asks for it on load and then
  // follows the broadcasts. `state` is
  // { phase: "idle" | "downloading" | "ready", version, percent, total, … }.
  UpdateGetState: () => ipcRenderer.invoke("UpdateGetState"),
  // "Restart now" / "Later" on the finished download.
  UpdateInstall: () => ipcRenderer.invoke("UpdateInstall"),
  UpdateDismiss: () => ipcRenderer.invoke("UpdateDismiss"),
  OnUpdateState: (callback) => {
    const listener = (event, state) => callback(state);
    ipcRenderer.on("UpdateState", listener);
    return () => ipcRenderer.removeListener("UpdateState", listener);
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
