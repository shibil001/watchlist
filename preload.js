const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  setPin: (on) => ipcRenderer.invoke("set-pin", on),
  setTheme: (theme) => ipcRenderer.invoke("set-theme", theme),
  loadList: () => ipcRenderer.sendSync("list-load"),
  saveList: (json) => ipcRenderer.sendSync("list-save", json),
  revealList: () => ipcRenderer.invoke("list-reveal"),
  openExternal: (url) => ipcRenderer.invoke("open-external", url),
  secretGet: () => ipcRenderer.sendSync("secret-get"),
  secretSet: (value) => ipcRenderer.sendSync("secret-set", value),
  deviceName: () => ipcRenderer.sendSync("device-name"),
});
