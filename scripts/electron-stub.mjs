// Minimal electron stub so the smoke harness can bundle modules that
// import from 'electron' without pulling in the real (native) module.
export const app = {
  getPath: () => process.env.APPDATA ?? '.',
  isPackaged: false,
  getVersion: () => '0.0.0'
}
export const safeStorage = {
  isEncryptionAvailable: () => false,
  encryptString: (s) => Buffer.from(s),
  decryptString: (b) => b.toString()
}
export const session = { defaultSession: { setPermissionRequestHandler: () => undefined } }
export const BrowserWindow = class {}
export const nativeImage = { createFromPath: () => ({ isEmpty: () => true }) }
export const dialog = {}
export const shell = {}
export const clipboard = {}
export const ipcMain = { handle: () => undefined }
export const Tray = class {}
export const Menu = {}
export const Notification = class {}
export const net = { fetch: () => Promise.resolve(new Response()) }
export const utilityProcess = { fork: () => ({ on: () => undefined, postMessage: () => undefined, kill: () => undefined }) }
export const autoUpdaterDummy = true
