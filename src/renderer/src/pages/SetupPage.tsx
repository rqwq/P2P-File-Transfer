import React, { useState } from 'react'
import { useStore } from '../state/store'
import { Icon } from '../components/Icon'

// Blocking first-run setup gate (spec 8.7): the user must set a receive
// folder (and pick a display name) before any other part of the app is
// usable.

export function SetupPage(): React.JSX.Element {
  const bridge = useStore((s) => s.bridge)
  const boot = useStore((s) => s.boot)
  const settings = useStore((s) => s.settings)
  const refreshBoot = useStore((s) => s.refreshBoot)
  const [name, setName] = useState(settings?.displayName ?? '')
  const [folder, setFolder] = useState(settings?.receiveFolder ?? '')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const pickFolder = (): void => {
    void bridge?.call('sys:pickFolder', undefined).then((res) => {
      if (res) setFolder(res.path)
    })
  }

  const submit = (): void => {
    if (!bridge || busy) return
    setBusy(true)
    void bridge
      .call('app:setDisplayName', { name })
      .then(async (resName) => {
        if (!resName.ok) {
          setError(resName.error)
          return null
        }
        return bridge.call('app:setReceiveFolder', { folder })
      })
      .then(async (resFolder) => {
        if (resFolder && !resFolder.ok) {
          setError(resFolder.error)
          return
        }
        await refreshBoot()
      })
      .finally(() => setBusy(false))
  }

  const configured = boot !== null && folder.length > 0 && name.trim().length > 0

  return (
    <div className="center-screen">
      <div className="center-card" style={{ maxWidth: 560 }}>
        <h1>
          <Icon name="share2" size={20} />
          Welcome
        </h1>
        <p>
          A couple of things before you start: pick a display name and choose the folder where
          received files will land. The folder is protected from rename/delete while the app runs.
        </p>
        <div className="field">
          <span className="field-label">Display name</span>
          <input
            value={name}
            maxLength={32}
            placeholder="How other members will see you"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && configured && submit()}
          />
        </div>
        <div className="field">
          <span className="field-label">Receive folder</span>
          <div style={{ display: 'flex', gap: 8 }}>
            <input value={folder} readOnly placeholder="Choose a folder…" style={{ flex: 1 }} />
            <button className="btn" onClick={pickFolder}>
              <Icon name="folder" size={13} />
              Browse…
            </button>
          </div>
        </div>
        <div className="error-text">{error ?? ''}</div>
        <div className="btn-row">
          <button className="btn primary" disabled={!configured || busy} onClick={submit}>
            {busy ? 'Saving…' : 'Continue'}
            <Icon name="arrowRight" size={13} />
          </button>
        </div>
      </div>
    </div>
  )
}
