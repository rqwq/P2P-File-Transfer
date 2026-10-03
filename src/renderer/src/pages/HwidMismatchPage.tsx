import React, { useState } from 'react'
import { useStore } from '../state/store'
import { Icon } from '../components/Icon'

// HWID mismatch screen (spec 4.2): blocking, with exactly two actions —
// Close application, or Run HWID rebuild (regenerates from current
// hardware and re-caches; identity rebuild after a ban is an accepted
// trade-off, not a bug).

export function HwidMismatchPage(): React.JSX.Element {
  const bridge = useStore((s) => s.bridge)
  const refreshBoot = useStore((s) => s.refreshBoot)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const rebuild = (): void => {
    if (!bridge || busy) return
    setBusy(true)
    void bridge
      .call('app:rebuildHwid', undefined)
      .then(async (res) => {
        if (!res.ok) {
          setError(res.error)
          return
        }
        await refreshBoot()
      })
      .finally(() => setBusy(false))
  }

  return (
    <div className="center-screen">
      <div className="center-card">
        <h1>
          <Icon name="alertTriangle" size={20} />
          Hardware identity changed
        </h1>
        <p>
          This machine's hardware fingerprint no longer matches the identity stored on this
          computer. This can happen after a hardware change, or if the stored identity was
          modified. Rebuilding resets this machine's identity.
        </p>
        <div className="error-text">{error ?? ''}</div>
        <div className="btn-row">
          <button className="btn danger" onClick={() => void bridge?.call('app:quit', undefined)}>
            <Icon name="logOut" size={13} />
            Close application
          </button>
          <button className="btn primary" disabled={busy} onClick={rebuild}>
            <Icon name="refresh" size={13} />
            {busy ? 'Rebuilding…' : 'Run HWID rebuild'}
          </button>
        </div>
      </div>
    </div>
  )
}
