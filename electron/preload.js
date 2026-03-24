import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("electronAPI", {
  savePdf: (html) => ipcRenderer.invoke("save-pdf", html),
});
