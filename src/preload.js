// MC-ROLEPLAY.DE Launcher — Preload (contextBridge)
"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("launcher", {
  play: () => ipcRenderer.invoke("play"),
  syncPack: () => ipcRenderer.invoke("sync-pack"),
  checkUpdate: () => ipcRenderer.invoke("check-update"),
  installUpdate: () => ipcRenderer.invoke("install-update"),
  getInfo: () => ipcRenderer.invoke("get-info"),
  setRam: (ramMb) => ipcRenderer.invoke("set-ram", ramMb),
  onStatus: (cb) => {
    ipcRenderer.on("status", (_event, data) => cb(data));
  },
  onUpdateStatus: (cb) => {
    ipcRenderer.on("update-status", (_event, data) => cb(data));
  },
});
