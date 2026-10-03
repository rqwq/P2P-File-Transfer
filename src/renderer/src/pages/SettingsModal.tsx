import React, { useEffect, useState } from 'react'
import type { Settings } from '../../../shared/api'
import { useStore } from '../state/store'
import { Icon } from '../components/Icon'
import { BytesUnitField, Modal, formatSpeed } from '../components/ui'

// Settings (spec 10): display name (validated in main — reserved names
// and per-room duplicates are rejected there), receive folder, transfer
// limits — all unlimited by default (spec 8.5).

export function SettingsModal(): React.JSX.Element {
  const bridge = useStore((s) => s.bridge)
  const showSettings = useStore((s) => s.showSettings)
  const setSettingsOpen = useStore((s) => s.setSettingsOpen)
  const [draft, setDraft] = useState<Settings | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    if (showSettings) {
      const s = useStore.getState().settings
      setDraft(s ? { ...s } : null)
      setError(null)
      setSaved(false)
    }
  }, [showSettings])

  if (!showSettings || !bridge || !draft) return <></>

  const save = (): void => {
    void bridge.call('app:updateSettings', draft).then((res) => {
      if (res.error) {
        setError(res.error)
        return
      }
      useStore.setState({ settings: res.settings })
      setSaved(true)
      setTimeout(() => setSettingsOpen(false), 350)
    })
  }

  const pickFolder = (): void => {
    void bridge.call('sys:pickFolder', undefined).then((res) => {
      if (res) setDraft({ ...draft, receiveFolder: res.path })
    })
  }

  const parseLimit = (value: string): number | null => {
    if (value.trim() === '') return null
    const n = Number(value)
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : null
  }

  return (
    <Modal
      title="Settings"
      icon="settings"
      onClose={() => setSettingsOpen(false)}
      footer={
        <>
          <button className="btn" onClick={() => setSettingsOpen(false)}>
            Cancel
          </button>
          <button className="btn primary" onClick={save}>
            <Icon name="check" size={13} />
            {saved ? 'Saved' : 'Save'}
          </button>
        </>
      }
    >
      <div className="field">
        <span className="field-label">Display name</span>
        <input
          value={draft.displayName}
          maxLength={32}
          onChange={(e) => setDraft({ ...draft, displayName: e.target.value })}
        />
      </div>
      <div className="field">
        <span className="field-label">Receive folder</span>
        <div style={{ display: 'flex', gap: 8 }}>
          <input value={draft.receiveFolder} readOnly style={{ flex: 1 }} />
          <button className="btn" onClick={pickFolder}>
            <Icon name="folder" size={13} />
            Browse…
          </button>
        </div>
      </div>
      <div className="field">
        <span className="field-label">Max simultaneous transfers (empty = unlimited)</span>
        <input
          value={draft.maxSimultaneousTransfers ?? ''}
          inputMode="numeric"
          placeholder="unlimited"
          onChange={(e) =>
            setDraft({ ...draft, maxSimultaneousTransfers: parseLimit(e.target.value) })
          }
        />
      </div>
      <BytesUnitField
        label="Max transfer speed (empty = unlimited)"
        bytes={draft.maxTransferSpeedBps}
        onBytes={(b) => setDraft({ ...draft, maxTransferSpeedBps: b })}
        placeholder="unlimited"
        hint={draft.maxTransferSpeedBps !== null ? `≈ ${formatSpeed(draft.maxTransferSpeedBps)}` : undefined}
      />
      <div className="error-text">{error ?? ''}</div>
    </Modal>
  )
}
