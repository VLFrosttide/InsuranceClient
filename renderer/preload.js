const { ipcRenderer, contextBridge } = require("electron");
//Example window.bridge.GlobalKey((event, data) => {})
// Or window.bridge.GlobalKey()

contextBridge.exposeInMainWorld("bridge", {
  LoadNewPage: (page) => {
    ipcRenderer.send("LoadPage", page);
  },
  PrintImage: (dataUrl) => {
    ipcRenderer.send("PrintImage", dataUrl);
  },
  OpenImageExternal: (dataUrl) => {
    ipcRenderer.send("OpenImageExternal", dataUrl);
  },
  ReadTestReport: () => {
    return ipcRenderer.invoke("ReadTestReport");
  },
});
// GetIconPath: (callback) => ipcRenderer.on("GetIconPath", callback),
