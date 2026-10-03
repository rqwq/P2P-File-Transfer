import { Notification } from 'electron'

// Native OS toast notifications (spec 10) plus an in-app mirror pushed to
// the renderer so the UI can show its own toasts.

type Listener = (n: { title: string; body: string; kind: 'info' | 'chat' | 'transfer' | 'ban' | 'invite' }) => void

class Notifier {
  private listeners: Listener[] = []
  private inApp = true

  push(title: string, body: string, kind: 'info' | 'chat' | 'transfer' | 'ban' | 'invite'): void {
    for (const l of this.listeners) l({ title, body, kind })
    if (this.inApp) {
      try {
        if (Notification.isSupported()) {
          const n = new Notification({ title, body, silent: false })
          n.on('click', () => {
            for (const l of this.listeners) l({ title: `${title}__activate`, body, kind })
          })
          n.show()
        }
      } catch {
        // notifications can fail on stripped-down systems — not fatal
      }
    }
  }

  subscribe(l: Listener): void {
    this.listeners.push(l)
  }
}

export const notifier = new Notifier()
