const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("testAPI", {
  reportResult: (result) => ipcRenderer.send("recording-result", result),
});
