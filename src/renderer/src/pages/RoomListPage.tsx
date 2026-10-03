import React, { useEffect, useState } from 'react'
import { useStore } from '../state/store'
import { Icon } from '../components/Icon'
import { Modal, formatBytes } from '../components/ui'

// Room list (spec 10): all joined/created rooms, join-by-code, create
// room with member cap and transport selection, plus pending invites.

export function RoomListPage(): React.JSX.Element {
  const bridge = useStore((s) => s.bridge)
  const rooms = useStore((s) => s.rooms)
  const invites = useStore((s) => s.invites)
  const selectRoom = useStore((s) => s.selectRoom)
  const refreshRooms = useStore((s) => s.refreshRooms)
  const respondInvite = useStore((s) => s.respondInvite)
  const [joinCode, setJoinCode] = useState('')
  const [joinError, setJoinError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [joinElapsed, setJoinElapsed] = useState(0)
  const [creating, setCreating] = useState(false)

  useEffect(() => {
    void refreshRooms()
  }, [refreshRooms])

  // Live "still working" feedback during a join — it can legitimately take
  // up to 45s (creator admission), and a silently disabled button reads
  // as stuck.
  useEffect(() => {
    if (!busy) {
      setJoinElapsed(0)
      return
    }
    const t = setInterval(() => setJoinElapsed((s) => s + 1), 1_000)
    return () => clearInterval(t)
  }, [busy])

  const join = (code: string, inviteId?: string): void => {
    if (!bridge || busy) return
    if (!useStore.getState().online) {
      setJoinError('You are offline — go online first (bottom-left toggle).')
      return
    }
    setBusy(true)
    setJoinError(null)
    void bridge
      .call('room:join', { code })
      .then(async (res) => {
        if (res.pending) {
          // Application submitted: the room shows as a pending card and
          // the worker keeps retrying until staff decide.
          setJoinCode('')
          if (inviteId) respondInvite(inviteId, true)
          useStore.getState().toast('Application submitted', 'It will be reviewed by the room staff. The room appears as pending in your list.', 'info')
          await refreshRooms()
          return
        }
        if (!res.ok) {
          setJoinError(res.error)
          return
        }
        setJoinCode('')
        if (inviteId) respondInvite(inviteId, true)
        await refreshRooms()
      })
      .catch((err) => {
        setJoinError(`Join failed: ${(err as Error).message}`)
      })
      .finally(() => setBusy(false))
  }

  const online = useStore((s) => s.online)
  const setOnline = useStore((s) => s.setOnline)

  return (
    <div className="page">
      <div className="page-wide">
        {!online && (
          <div className="offline-banner" style={{ marginBottom: 18 }}>
            <Icon name="alertTriangle" size={14} />
            <span>You're offline — peers can't reach you and joins are disabled.</span>
            <button className="btn small" onClick={() => setOnline(true)}>
              <Icon name="refresh" size={12} />
              Go online
            </button>
          </div>
        )}
        <div className="page-hero">
          <div className="page-hero-icon">
            <Icon name="share2" size={22} />
          </div>
          <h1 className="page-title">Rooms</h1>
        </div>
        <p className="page-sub">Serverless rooms — your data stays between peers.</p>

        {invites.length > 0 && (
          <div style={{ marginBottom: 22 }}>
            {invites.map((inv) => (
              <div key={inv.id} className="invite-card">
                <div className="invite-icon">
                  <Icon name="mail" size={16} />
                </div>
                <div className="invite-body">
                  <div className="invite-title">Invitation: {inv.roomName}</div>
                  <div className="invite-from">from {inv.from}</div>
                </div>
                <button className="btn small" onClick={() => join(inv.code, inv.id)}>
                  <Icon name="check" size={13} />
                  Accept
                </button>
                <button className="btn ghost small" onClick={() => respondInvite(inv.id, false)}>
                  Dismiss
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="join-row">
          <input
            value={joinCode}
            placeholder="Paste a room code…"
            onChange={(e) => setJoinCode(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && join(joinCode)}
          />
          <button className="btn primary" disabled={busy || joinCode.trim().length === 0} onClick={() => join(joinCode)}>
            <Icon name="arrowRight" size={14} />
            Join room
          </button>
          <button className="btn" onClick={() => setCreating(true)}>
            <Icon name="plus" size={14} />
            Create room
          </button>
        </div>
        <div className="error-text">{joinError ?? ''}</div>
        {busy && (
          <div className="join-progress">
            <span className="spinner small" />
            <span>
              Reaching the room creator… {joinElapsed}s / 45s
              <br />
              <span className="join-progress-sub">
                They must be online and click <strong>Admit to room</strong> when your request arrives.
              </span>
            </span>
          </div>
        )}

        {rooms.length === 0 ? (
          <div className="empty-state">
            <div className="big">⇄</div>
            No rooms yet. Create one and share its code, or paste a code from a friend.
            <br />
            The room creator must be online to admit new members.
          </div>
        ) : (
          <div className="room-grid">
            {rooms.map((room) => (
              <div
                key={room.roomId}
                className={`room-card${room.joinState !== 'member' ? ` app-${room.joinState}` : ''}`}
                onClick={() => {
                  if (room.joinState === 'member') void selectRoom(room.roomId)
                }}
              >
                <div className="room-card-name">
                  <Icon name="hash" size={14} className="icon" />
                  <span>{room.name}</span>
                </div>
                {room.joinState === 'member' ? (
                  <div className="room-card-meta">
                    <span>
                      <Icon name="users" size={12} />
                      {room.memberCount} member{room.memberCount === 1 ? '' : 's'}
                    </span>
                    <span>
                      <span className={`member-dot${room.onlineCount > 0 ? ' on' : ''}`} />
                      {room.onlineCount} online
                    </span>
                    {room.isCreator && (
                      <span className="room-card-badge">
                        <Icon name="crown" size={10} />
                        creator
                      </span>
                    )}
                    <span className={`room-card-badge${room.transport === 'vpn' ? ' warn' : ''}`}>
                      <Icon name={room.transport === 'vpn' ? 'globe' : 'zap'} size={10} />
                      {room.transport}
                    </span>
                  </div>
                ) : (
                  <div className="room-card-meta">
                    {room.joinState === 'pending' ? (
                      <>
                        <span>
                          <span className="spinner small" />
                          Application pending
                        </span>
                        <span>
                          <Icon name="users" size={12} />
                          members unavailable
                        </span>
                      </>
                    ) : (
                      <span>
                        <Icon name="xCircle" size={12} />
                        Application rejected{room.appReason ? ` — ${room.appReason}` : ''}
                      </span>
                    )}
                    <button
                      className="btn ghost small"
                      onClick={(e) => {
                        e.stopPropagation()
                        void bridge?.call('room:pendingDismiss', { code: room.code }).then(() => refreshRooms())
                      }}
                    >
                      <Icon name="trash" size={11} />
                      Remove
                    </button>
                  </div>
                )}
                {room.joinState === 'member' && (
                  <span className="room-card-chevron">
                    <Icon name="chevronRight" size={16} />
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
      {creating && (
        <CreateRoomModal
          onClose={() => setCreating(false)}
          onCreated={async () => {
            setCreating(false)
            await refreshRooms()
          }}
        />
      )}
    </div>
  )
}

function CreateRoomModal(props: { onClose: () => void; onCreated: () => Promise<void> }): React.JSX.Element {
  const bridge = useStore((s) => s.bridge)
  const [name, setName] = useState('')
  const [memberCap, setMemberCap] = useState('')
  const [transport, setTransport] = useState<'dht' | 'vpn'>('dht')
  const [adapters, setAdapters] = useState<{ name: string; ip: string; kind: string }[]>([])
  const [vpnIp, setVpnIp] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void bridge?.call('sys:adapters', undefined).then((list) => {
      setAdapters(list)
      const first = list.find((a) => a.kind === 'radmin') ?? list.find((a) => a.kind === 'hamachi')
      if (first) setVpnIp(first.ip)
    })
  }, [bridge])

  const create = (): void => {
    if (!bridge || busy) return
    setBusy(true)
    void bridge
      .call('room:create', {
        name,
        memberCap: memberCap.trim().length > 0 ? Math.max(0, Math.floor(Number(memberCap)) || 0) : null,
        transport,
        vpnIp: transport === 'vpn' ? vpnIp : null
      })
      .then(async (res) => {
        if (!res.ok) {
          setError(res.error)
          return
        }
        await props.onCreated()
      })
      .finally(() => setBusy(false))
  }

  return (
    <Modal
      title="Create room"
      icon="plus"
      onClose={props.onClose}
      footer={
        <>
          <button className="btn" onClick={props.onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={name.trim().length === 0 || busy} onClick={create}>
            <Icon name="plus" size={13} />
            {busy ? 'Creating…' : 'Create'}
          </button>
        </>
      }
    >
      <div className="field">
        <span className="field-label">Room name</span>
        <input value={name} maxLength={64} placeholder="e.g. Movie night" onChange={(e) => setName(e.target.value)} />
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
        <span className="field-label">Transport</span>
        <select value={transport} onChange={(e) => setTransport(e.target.value as 'dht' | 'vpn')}>
          <option value="dht">HyperDHT (no configuration, hole-punched)</option>
          <option value="vpn">VPN adapter (Radmin / Hamachi)</option>
        </select>
      </div>
      {transport === 'vpn' && (
        <div className="field">
          <span className="field-label">Your VPN adapter</span>
          {adapters.length === 0 ? (
            <div className="error-text">
              No Radmin/Hamachi adapter detected. Install the VPN or pick the adapter manually once it
              appears.
            </div>
          ) : (
            <select value={vpnIp ?? ''} onChange={(e) => setVpnIp(e.target.value)}>
              {adapters.map((a) => (
                <option key={a.ip} value={a.ip}>
                  {a.name} — {a.ip} ({a.kind})
                </option>
              ))}
            </select>
          )}
        </div>
      )}
      <div className="error-text">{error ?? ''}</div>
      <p style={{ fontSize: 12, color: 'var(--text-faint)', margin: '0' }}>
        Chat limits default to 500 chars · images {formatBytes(5 * 1024 * 1024)} · video{' '}
        {formatBytes(10 * 1024 * 1024)} · audio {formatBytes(2 * 1024 * 1024)} — adjustable later in
        room settings.
      </p>
    </Modal>
  )
}
