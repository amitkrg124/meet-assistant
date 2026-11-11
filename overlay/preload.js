const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("overlay", {
  onMessage: (fn) => ipcRenderer.on("overlay", (_e, msg) => fn(msg)),
  setInteractive: (on) => ipcRenderer.send("set-interactive", on),
  startDrag: () => ipcRenderer.send("overlay-drag", "start"),
  dragMove: () => ipcRenderer.send("overlay-drag", "move"),
  endDrag: () => ipcRenderer.send("overlay-drag", "end"),
  clear: () => ipcRenderer.send("clear"),
  toggleListening: () => ipcRenderer.send("toggle-listening"),
  answerNow: () => ipcRenderer.send("answer-now"),
  sendAudio: (payload) => ipcRenderer.send("audio", payload),
  sendDevices: (list) => ipcRenderer.send("devices", list),
  sendTracks: (tracks) => ipcRenderer.send("tracks", tracks),
  getSettings: () => ipcRenderer.invoke("get-settings"),
  saveSettings: (partial) => ipcRenderer.invoke("save-settings", partial),
  getPlatform: () => ipcRenderer.invoke("get-platform"),
  getDesktopSourceId: () => ipcRenderer.invoke("get-desktop-source-id"),
  togglePanel: () => ipcRenderer.send("toggle-panel"),
  closePanel: () => ipcRenderer.send("close-panel"),
  captureScreen: () => ipcRenderer.invoke("capture-screen"),
  quit: () => ipcRenderer.send("quit-app"),
});
