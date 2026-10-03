import { contextBridge, ipcRenderer } from 'electron'

// The "unofficial copy" warning window's bridge (spec 12.5): exactly two
// IPC handlers exist on the main side for this window, and this preload
// exposes exactly those two — a tampered build never gets the full IPC
// surface.

contextBridge.exposeInMainWorld('p2pftIntegrity', {
  openRepo: () => ipcRenderer.invoke('integrity:openRepo'),
  copyContact: () => ipcRenderer.invoke('integrity:copyContact')
})
