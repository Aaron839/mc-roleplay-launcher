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
  setCrashReports: (enabled) => ipcRenderer.invoke("set-crash-reports", enabled),
  setDisclaimer: (enabled) => ipcRenderer.invoke("set-disclaimer", enabled),
  setLaunchMode: (mode) => ipcRenderer.invoke("set-launch-mode", mode),
  authStatus: () => ipcRenderer.invoke("auth-status"),
  authLogin: () => ipcRenderer.invoke("auth-login"),
  authCancel: () => ipcRenderer.invoke("auth-cancel"),
  authLogout: () => ipcRenderer.invoke("auth-logout"),
  openUrl: (url) => ipcRenderer.invoke("open-url", url),
  copyText: (t) => ipcRenderer.invoke("clipboard-write", t),
  winMinimize: () => ipcRenderer.invoke("win-minimize"),
  winClose: () => ipcRenderer.invoke("win-close"),
  onAuthCode: (cb) => ipcRenderer.on("auth-code", (_e, data) => cb(data)),
  onStatus: (cb) => {
    ipcRenderer.on("status", (_event, data) => cb(data));
  },
  onUpdateStatus: (cb) => {
    ipcRenderer.on("update-status", (_event, data) => cb(data));
  },
});
