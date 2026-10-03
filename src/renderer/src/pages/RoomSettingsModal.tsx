import React, { useState } from 'react'
import type { RoomSettings } from '../../../shared/api'
import { useStore } from '../state/store'
import { Icon } from '../components/Icon'
import { BytesUnitField, Modal, formatBytes } from '../components/ui'

// Room settings, creator-only (spec 10): room name, member cap and chat
// limits. The attachment limits are byte fields — number + Bytes/KB/MB/GB
// unit dropdown (the dropdown is the modifier of the typed value).

const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024 // wire schema cap
const MAX_MEMBER_CAP = 1000
const MAX_TEXT_LENGTH = 20_000

export function RoomSettingsModal(props: { roomId: string; onClose: () => void }): React.JSX.Element {
  const bridge = useStore((s) => s.bridge)
  const state = useStore((s) => s.roomStates[props.roomId])
  const [draft, setDraft] = useState<RoomSettings | null>(state?.settings ?? null)
  const [memberCap, setMemberCap] = useState(
    state?.settings.memberCap === null || state?.settings.memberCap === undefined
      ? ''
      : String(state.settings.memberCap)
  )
  const [textLength, setTextLength] = useState(String(state?.settings.chatLimits.textLength ?? 500))
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  if (!bridge || !state || !draft) return <></>

  const save = (): void => {
    if (busy) return
    const name = draft.name.trim()
    if (name.length === 0) {
      setError('Enter a room name.')
      return
    }
    const next: RoomSettings = {
      ...draft,
      name,
      memberCap:
        memberCap.trim() === '' ? null : Math.min(MAX_MEMBER_CAP, Math.max(0, Math.floor(Number(memberCap) || 0))),
      chatLimits: {
        textLength: Math.min(MAX_TEXT_LENGTH, Math.max(1, Math.floor(Number(textLength) || 500))),
        imageBytes: draft.chatLimits.imageBytes,
        videoBytes: draft.chatLimits.videoBytes,
        audioBytes: draft.chatLimits.audioBytes
      }
    }
    setBusy(true)
    void bridge
      .call('room:updateSettings', { roomId: props.roomId, settings: next })
      .then((res) => {
        if (!res.ok) {
          setError(res.error)
          setBusy(false)
          return
        }
        props.onClose()
      })
  }

  const setLimit = (key: 'imageBytes' | 'videoBytes' | 'audioBytes', bytes: number | null): void => {
    setDraft({ ...draft, chatLimits: { ...draft.chatLimits, [key]: bytes ?? 0 } })
  }

  return (
    <Modal
      title={`Room settings — ${state.room.name}`}
      icon="settings"
      onClose={props.onClose}
      footer={
        <>
          <button className="btn" onClick={props.onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy} onClick={save}>
            <Icon name="check" size={13} />
            {busy ? 'Saving…' : 'Save'}
          </button>
        </>
      }
    >
      <div className="field">
        <span className="field-label">Room name</span>
        <input value={draft.name} maxLength={64} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
      </div>
      <div className="field">
        <span className="field-label">Member cap (empty = unlimited)</span>
        <input
          value={memberCap}
          inputMode="numeric"
          placeholder="unlimited"
          onChange={(e) => setMemberCap(e.target.value.replace(/[^0-9]/g, ''))}
        />
      </div>
      <div className="field">
        <span className="field-label">Message length — characters</span>
        <input
          value={textLength}
          inputMode="numeric"
          onChange={(e) => setTextLength(e.target.value.replace(/[^0-9]/g, ''))}
        />
      </div>
      <BytesUnitField
        label="Image attachment limit (empty = 0)"
        bytes={draft.chatLimits.imageBytes}
        onBytes={(b) => setLimit('imageBytes', b)}
        maxBytes={MAX_ATTACHMENT_BYTES}
      />
      <BytesUnitField
        label="Video attachment limit (empty = 0)"
        bytes={draft.chatLimits.videoBytes}
        onBytes={(b) => setLimit('videoBytes', b)}
        maxBytes={MAX_ATTACHMENT_BYTES}
      />
      <BytesUnitField
        label="Audio attachment limit (empty = 0)"
        bytes={draft.chatLimits.audioBytes}
        onBytes={(b) => setLimit('audioBytes', b)}
        maxBytes={MAX_ATTACHMENT_BYTES}
      />
      <p style={{ fontSize: 12, color: 'var(--text-faint)', margin: 0 }}>
        Attachment limits are capped at {formatBytes(MAX_ATTACHMENT_BYTES)} per message. Changes apply to
        everyone in the room.
      </p>
      <div className="error-text">{error ?? ''}</div>
    </Modal>
  )
}
