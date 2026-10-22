/**
 * 설정 창에 내주는 길 — 데몬 로컬 API 와 몇 가지 시스템 동작만. 창은 Node 를 직접 쓰지 않는다
 */
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("light", {
  status: () => ipcRenderer.invoke("status"),
  onStatus: (listener: (value: unknown) => void) => ipcRenderer.on("status", (_event, value) => listener(value)),
  onView: (listener: (view: string) => void) => ipcRenderer.on("view", (_event, view: string) => listener(view)),
  settings: () => ipcRenderer.invoke("settings:get"),
  updateSettings: (patch: unknown) => ipcRenderer.invoke("settings:update", patch),
  refreshNetwork: () => ipcRenderer.invoke("network:refresh"),
  registerServe: () => ipcRenderer.invoke("serve:register"),
  testPush: () => ipcRenderer.invoke("push:test"),
  removeDevice: (id: string) => ipcRenderer.invoke("devices:remove", id),
  restartDaemon: () => ipcRenderer.invoke("daemon:restart"),
  openLogs: () => ipcRenderer.invoke("logs:open"),
  qr: (text: string) => ipcRenderer.invoke("qr", text),
  copy: (text: string) => ipcRenderer.invoke("clipboard", text),
  openExternal: (url: string) => ipcRenderer.invoke("external", url),
  chooseFolders: () => ipcRenderer.invoke("folder:choose"),
  onboarded: () => ipcRenderer.invoke("onboarded"),
});
