import React, { useEffect } from 'react'
import type { Bridge } from '../../shared/api'
import { BRIDGE_KEY } from '../../shared/api'
import { useStore } from './state/store'
import { Icon } from './components/Icon'
import { TitleBar } from './components/TitleBar'
import { Footer } from './components/Footer'
import { Toasts } from './components/Toasts'
import { SettingsModal } from './pages/SettingsModal'
import { AboutModal } from './pages/AboutModal'
import { TrustModal } from './pages/TrustModal'
import { BanDialog } from './pages/BanDialog'
import { SetupPage } from './pages/SetupPage'
import { HwidMismatchPage } from './pages/HwidMismatchPage'
import { AppBannedPage } from './pages/AppBannedPage'
import { RoomListPage } from './pages/RoomListPage'
import { RoomPage } from './pages/RoomPage'

export default function App(): React.JSX.Element {
  const init = useStore((s) => s.init)
  const boot = useStore((s) => s.boot)
  const banScreen = useStore((s) => s.banScreen)
  const update = useStore((s) => s.update)
  const setSettingsOpen = useStore((s) => s.setSettingsOpen)
  const bridge = useStore((s) => s.bridge)

  useEffect(() => {
    init((window as unknown as Record<string, unknown>)[BRIDGE_KEY] as Bridge | null)
  }, [init])

  if (!bridge) {
    return (
      <div className="app-shell">
        <TitleBar />
        <div className="center-screen">
          <div className="center-card">
            <h1>Preview mode</h1>
            <p>
              The UI shell is running outside the app window, so the desktop bridge is unavailable.
              Launch the desktop app for full functionality.
            </p>
          </div>
        </div>
        <Footer />
      </div>
    )
  }

  const stage = boot?.stage ?? 'loading'

  let body: React.JSX.Element
  if (banScreen) {
    body = <BanDialog />
  } else if (stage === 'loading') {
    body = (
      <div className="center-screen">
        <div className="center-card" style={{ textAlign: 'center' }}>
          <div className="spinner" />
          <p style={{ marginBottom: 0 }}>Starting up — reading hardware identity…</p>
        </div>
      </div>
    )
  } else if (stage === 'hwidMismatch') {
    body = <HwidMismatchPage />
  } else if (stage === 'appBanned') {
    // App-level ban: blocks the whole app (frame excepted) until it
    // expires or the blocklist decision changes.
    body = <AppBannedPage />
  } else if (stage === 'setup') {
    body = <SetupPage />
  } else {
    body = <MainScreen />
  }

  return (
    <div className="app-shell">
      <TitleBar />
      {update.state === 'available' && (
        <div className="update-banner">
          <Icon name="download" size={14} />
          <span>Update {update.version} available — it installs on quit.</span>
          <button className="btn ghost small" onClick={() => void bridge.call('update:install', undefined)}>
            <Icon name="refresh" size={12} />
            Restart & update
          </button>
        </div>
      )}
      <div className="app-body">{body}</div>
      <Footer onOpenSettings={() => setSettingsOpen(true)} />
      <SettingsModal />
      <AboutModal />
      <TrustModal />
      <Toasts />
    </div>
  )
}

function MainScreen(): React.JSX.Element {
  const currentRoomId = useStore((s) => s.currentRoomId)
  if (currentRoomId) return <RoomPage />
  return <RoomListPage />
}
