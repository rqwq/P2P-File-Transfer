import { app, BrowserWindow, session, shell } from 'electron'
import path from 'node:path'
import type { EventMap, EventChannel } from '../shared/api'

// Window management. The main window is frameless with a hand-drawn
// macOS-style traffic-light titlebar (spec 10); closing hides to tray so
// transfers continue in the background (the app quits only from the tray
// menu).

export let mainWindow: BrowserWindow | null = null
export let integrityWindow: BrowserWindow | null = null

export function pushToRenderer<M extends EventChannel>(channel: M, payload: EventMap[M]): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(`evt:${channel}`, payload)
  }
}

export function getMainWindow(): BrowserWindow | null {
  return mainWindow
}

export function getIntegrityWindow(): BrowserWindow | null {
  return integrityWindow
}

export function isDev(): boolean {
  return !app.isPackaged
}

export function createMainWindow(onCloseToTray: () => void): BrowserWindow {
  const win = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 960,
    minHeight: 620,
    frame: false,
    show: false,
    backgroundColor: '#0b0e14',
    title: 'P2P File Transfer',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      webSecurity: true,
      spellcheck: false,
      devTools: isDev()
    }
  })

  win.once('ready-to-show', () => win.show())

  // Deny everything by default (spec 3/11).
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => {
    callback(false)
  })
  session.defaultSession.setPermissionCheckHandler(() => false)

  // Block all navigation away from the app and all window.open attempts.
  win.webContents.on('will-navigate', (event, url) => {
    if (!isAppUrl(url)) event.preventDefault()
  })
  win.webContents.setWindowOpenHandler((details) => {
    if (isExternalHttp(details.url)) void shell.openExternal(details.url)
    return { action: 'deny' }
  })

  win.on('close', (event) => {
    // Close button minimizes to tray instead of quitting (spec 10):
    // transfers keep running in the background; quitting happens from
    // the tray menu.
    event.preventDefault()
    win.hide()
    onCloseToTray()
  })

  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (devUrl) void win.loadURL(devUrl)
  else void win.loadFile(path.join(__dirname, '../renderer/index.html'))

  mainWindow = win
  win.on('closed', () => {
    mainWindow = null
  })
  return win
}

function isAppUrl(url: string): boolean {
  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (devUrl) return url.startsWith(devUrl)
  return url.startsWith('file://') && url.includes('/out/renderer/')
}

function isExternalHttp(url: string): boolean {
  return /^https?:\/\//i.test(url)
}

// The "unofficial copy" warning window (spec 12.5): a fully separate,
// sandboxed BrowserWindow with its own minimal preload and exactly two
// IPC handlers (registered in integrityWindowIpc.ts). A tampered build
// must never get the full IPC surface.
export function createIntegrityWindow(onAllClosed: () => void): BrowserWindow {
  const win = new BrowserWindow({
    width: 720,
    height: 560,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    backgroundColor: '#0b0e14',
    title: 'Warning — P2P File Transfer',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/integrity.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      devTools: false
    }
  })
  win.setMenuBarVisibility(false)
  win.once('ready-to-show', () => win.show())
  win.on('closed', () => {
    integrityWindow = null
    onAllClosed()
  })

  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (devUrl) void win.loadURL(`${devUrl}/integrity.html`)
  else void win.loadFile(path.join(__dirname, '../renderer/integrity.html'))

  integrityWindow = win
  return win
}
