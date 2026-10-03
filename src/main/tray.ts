import { Menu, Tray, nativeImage, type BrowserWindow } from 'electron'
import path from 'node:path'

// System tray (spec 10): the window's close button hides to tray; the app
// quits only via the tray menu.

let tray: Tray | null = null

export function createTray(getWindow: () => BrowserWindow | null, onQuit: () => void): Tray {
  const iconPath = path.join(__dirname, '../renderer/assets/tray.png')
  let image = nativeImage.createFromPath(iconPath)
  if (image.isEmpty()) {
    // Fallback: a plain accent-colored dot so the tray still works.
    image = nativeImage.createFromDataURL(
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGBgAAAABQABh6FO1AAAAABJRU5ErkJggg=='
    )
  }
  tray = new Tray(image)
  tray.setToolTip('P2P File Transfer')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Show P2P File Transfer', click: () => showWindow(getWindow) },
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => {
          onQuit()
        }
      }
    ])
  )
  tray.on('click', () => showWindow(getWindow))
  return tray
}

function showWindow(getWindow: () => BrowserWindow | null): void {
  const win = getWindow()
  if (!win) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

export function destroyTray(): void {
  if (tray) {
    tray.destroy()
    tray = null
  }
}
