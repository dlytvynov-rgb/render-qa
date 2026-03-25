const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  savePdf: (html) => ipcRenderer.invoke("save-pdf", html),
});
