const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("hrmsAgent", {
  login: (email, password) => ipcRenderer.invoke("auth:login", { email, password }),
});

