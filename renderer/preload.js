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
});
// GetIconPath: (callback) => ipcRenderer.on("GetIconPath", callback),
