import React, { useEffect, useState } from 'react'
import { useStore } from '../state/store'
import { Icon } from '../components/Icon'
import type { IconName } from '../components/Icon'
import { BadgeRow } from '../components/Badge'
import { Modal, formatBytes, formatSpeed, shortKey } from '../components/ui'
import { ChatPanel } from './ChatPanel'
import { OfferModals } from './OfferModals'
import { RoomSettingsModal } from './RoomSettingsModal'
import type { ApplicationView, BanEntryView } from '../../../shared/api'

// Room view (spec 10): transfers are the hero of the room (this is a file
// transfer app, after all) — members sidebar, transfers dashboard in the
// middle with redacted rows for onlookers (spec 8.6), chat as a compact
// side panel on the right.

export function RoomPage(): React.JSX.Element {
  const bridge = useStore((s) => s.bridge)
  const currentRoomId = useStore((s) => s.currentRoomId)
  const roomStates = useStore((s) => s.roomStates)
  const tasks = useStore((s) => (s.currentRoomId ? s.tasks[s.currentRoomId] : undefined)) ?? []
  const refreshRooms = useStore((s) => s.refreshRooms)
  const online = useStore((s) => s.online)
  const setOnline = useStore((s) => s.setOnline)
  const [ctx, setCtx] = useState<{ x: number; y: number; key: string } | null>(null)
  const [banTarget, setBanTarget] = useState<string | null>(null)
  const [showRoomSettings, setShowRoomSettings] = useState(false)
  // undefined = closed · null = pick any member · string = preselected peer
  const [sendFor, setSendFor] = useState<string | null | undefined>(undefined)
  const [copiedCode, setCopiedCode] = useState(false)
  const [showApps, setShowApps] = useState(false)
  const [showBans, setShowBans] = useState(false)
  const [appBanTarget, setAppBanTarget] = useState<string | null>(null)
  const [suspectTarget, setSuspectTarget] = useState<string | null>(null)

  const state = currentRoomId ? roomStates[currentRoomId] : null
  const roomId = currentRoomId ?? ''

  useEffect(() => {
    const closeMenu = (): void => setCtx(null)
    window.addEventListener('click', closeMenu)
    return () => window.removeEventListener('click', closeMenu)
  }, [])

  if (!state || !bridge) {
    return (
      <div className="page">
        <div className="empty-state" style={{ padding: '48px 20px' }}>
          <div className="spinner" />
          <p style={{ marginTop: 14, marginBottom: 0 }}>Opening room…</p>
        </div>
      </div>
    )
  }

  const me = state.members.find((m) => m.isMe)
  const isStaff = state.isStaff
  const isCreator = state.room.isCreator
  // App moderators (hardcoded HWID list, badge computed in main) get the
  // app-ban action.
  const isAppMod = me?.badges.some((b) => b.id === 'appMod') ?? false
  const canManageRoles = isCreator || me?.role === 'admin'
  // Self presence comes from main's room state (isOnline merges the
  // availability toggle there). Never mask it with the renderer's toggle
  // copy: showing yourself online while main is suspended is exactly the
  // lie that hid "creator unreachable" join failures.
  const rowOnline = (m: { online: boolean }): boolean => m.online
  const onlineCount = state.members.filter(rowOnline).length
  const sortedMembers = [...state.members].sort(
    (a, b) => Number(rowOnline(b)) - Number(rowOnline(a)) || a.name.localeCompare(b.name)
  )

  const copyCode = (): void => {
    void bridge.call('sys:copyText', { text: state.room.code }).then(() => {
      setCopiedCode(true)
      setTimeout(() => setCopiedCode(false), 1_600)
    })
  }

  const leave = (): void => {
    void bridge.call('room:leave', { roomId }).then(async () => {
      await refreshRooms()
      useStore.setState({ currentRoomId: null })
    })
  }

  const sendOffer = (paths: string[], peerKey: string): void => {
    if (!online) {
      useStore.getState().toast('You are offline', 'Go online first — peers are unreachable while you are offline.', 'error')
      return
    }
    void bridge.call('transfer:offer', { roomId, peerKey, paths })
  }

  const backToList = (): void => {
    // Navigate back to the room list without leaving the room — rooms and
    // transfers keep running in the background.
    useStore.setState({ currentRoomId: null })
  }

  return (
    <>
      {!online && (
        <div className="offline-banner">
          <Icon name="alertTriangle" size={14} />
          <span>
            You're offline — peers can't reach you: no joins, chat, or transfers. Nobody sees you as
            online.
          </span>
          <button className="btn small" onClick={() => setOnline(true)}>
            <Icon name="refresh" size={12} />
            Go online
          </button>
        </div>
      )}
      <div className="room-layout">
        {/* ------- sidebar: room identity + members ------- */}
        <aside className="room-side">
          <div className="side-head">
            <button className="btn ghost small block side-back" onClick={backToList}>
              <Icon name="arrowLeft" size={13} />
              All rooms
            </button>
            <div className="side-room-name">
              <Icon name="hash" size={15} />
              <span>{state.room.name}</span>
            </div>
            <button className="side-code" onClick={copyCode} title="Copy room code">
              <Icon name={copiedCode ? 'check' : 'copy'} size={12} />
              <span>{copiedCode ? 'code copied' : `${state.room.code.slice(0, 18)}…`}</span>
            </button>
          </div>
          <div className="side-scroll">
            <div className="side-section">Members — {onlineCount} online</div>
            {sortedMembers.map((m) => (
              <div
                key={m.key}
                className="member-row"
                title={isStaff && !m.isMe ? 'Right-click for actions (send files, roles, ban)' : undefined}
                onContextMenu={(e) => {
                  if (!m.isMe && isStaff) {
                    e.preventDefault()
                    setCtx({ x: e.clientX, y: e.clientY, key: m.key })
                  }
                }}
              >
                <span className={`member-dot${rowOnline(m) ? ' on' : ''}`} />
                <span className={`member-name${rowOnline(m) ? '' : ' dim'}`}>{m.name}</span>
                <BadgeRow badges={m.badges} />
              </div>
            ))}
          </div>
          <div className="side-foot">
            <button
              className="btn primary block"
              disabled={!online}
              title={online ? undefined : 'Go online first (bottom-left toggle)'}
              onClick={() => setSendFor(null)}
            >
              <Icon name="upload" size={14} />
              Send files
            </button>
            {isCreator && (
              <button className="btn ghost small block" onClick={() => setShowRoomSettings(true)}>
                <Icon name="settings" size={13} />
                Room settings
              </button>
            )}
            {isStaff && (
              <>
                <button className="btn ghost small block" onClick={() => setShowApps(true)}>
                  <Icon name="mail" size={13} />
                  Application center
                </button>
                <button className="btn ghost small block" onClick={() => setShowBans(true)}>
                  <Icon name="ban" size={13} />
                  Banned users
                </button>
              </>
            )}
            <button className="btn ghost small danger block" onClick={leave}>
              <Icon name="logOut" size={13} />
              Leave room
            </button>
          </div>
        </aside>

        {/* ------- main pane: transfers ------- */}
        <section className="room-main">
          <div className="main-head">
            <div className="main-title">
              <Icon name="share2" size={16} />
              Transfers
              <span className="count-pill">{tasks.filter((t) => t.state === 'active').length} active</span>
            </div>
            <span className="spacer" />
            <button
              className="btn primary small"
              disabled={!online}
              title={online ? undefined : 'Go online first (bottom-left toggle)'}
              onClick={() => setSendFor(null)}
            >
              <Icon name="upload" size={13} />
              New transfer
            </button>
          </div>
          <TransfersPane
            roomId={roomId}
            tasks={tasks}
            onStartSend={() => setSendFor(null)}
            canClearHistory={isStaff}
          />
        </section>

        {/* ------- side panel: chat ------- */}
        <ChatPanel roomId={roomId} />
      </div>

      {ctx && (
        <div
          className="ctx-menu"
          style={{
            left: Math.max(8, Math.min(ctx.x, window.innerWidth - 200)),
            top: Math.max(8, Math.min(ctx.y, window.innerHeight - 300))
          }}
        >
          <button className="ctx-item" onClick={() => void bridge.call('sys:copyText', { text: ctx.key })}>
            <Icon name="copy" size={13} />
            Copy key
          </button>
          <button
            className="ctx-item"
            onClick={() => {
              setSendFor(ctx.key)
              setCtx(null)
            }}
          >
            <Icon name="send" size={13} />
            Send files…
          </button>
          {canManageRoles &&
            (() => {
              const member = state.members.find((m) => m.key === ctx.key)
              if (!member || member.role === 'creator') return null
              const setRole = (role: 'admin' | 'moderator' | 'member'): void => {
                void bridge.call('mod:setRole', { roomId, targetKey: ctx.key, role })
                setCtx(null)
              }
              const belowMine = isCreator
                ? ['admin', 'moderator', 'member']
                : ['moderator', 'member'] // admins manage below admin only
              return (
                <>
                  {member.role !== 'admin' && belowMine.includes('admin') && (
                    <button className="ctx-item" onClick={() => setRole('admin')}>
                      <Icon name="hammerShield" size={13} />
                      Make administrator
                    </button>
                  )}
                  {member.role !== 'moderator' && belowMine.includes('moderator') && (
                    <button className="ctx-item" onClick={() => setRole('moderator')}>
                      <Icon name="shield" size={13} />
                      Make moderator
                    </button>
                  )}
                  {member.role !== 'member' && (
                    <button className="ctx-item" onClick={() => setRole('member')}>
                      <Icon name="xCircle" size={13} />
                      Remove role
                    </button>
                  )}
                  <div className="ctx-sep" />
                </>
              )
            })()}
          {isStaff && (
            <>
              {(() => {
                const member = state.members.find((m) => m.key === ctx.key)
                const suspected = member?.badges.some((b) => b.id === 'suspected')
                return (
                  <>
                    <button
                      className="ctx-item"
                      onClick={() => {
                        setSuspectTarget(ctx.key)
                        setCtx(null)
                      }}
                    >
                      <Icon name="alertCircle" size={13} />
                      Suspect…
                    </button>
                    {suspected && (
                      <button
                        className="ctx-item"
                        onClick={() => {
                          void bridge.call('mod:markSuspected', { roomId, targetKey: ctx.key })
                          setCtx(null)
                        }}
                      >
                        <Icon name="check" size={13} />
                        Mark suspicions handled
                      </button>
                    )}
                  </>
                )
              })()}
              <button
                className="ctx-item danger"
                onClick={() => {
                  setBanTarget(ctx.key)
                  setCtx(null)
                }}
              >
                <Icon name="ban" size={13} />
                Ban…
              </button>
              <button
                className="ctx-item"
                onClick={() => {
                  void bridge.call('mod:unban', { roomId, targetKey: ctx.key })
                  setCtx(null)
                }}
              >
                <Icon name="xCircle" size={13} />
                Unban
              </button>
              {isAppMod && (
                <button
                  className="ctx-item danger"
                  onClick={() => {
                    setAppBanTarget(ctx.key)
                    setCtx(null)
                  }}
                >
                  <Icon name="hammer" size={13} />
                  App ban…
                </button>
              )}
            </>
          )}
        </div>
      )}

      {banTarget && <BanMemberModal roomId={roomId} targetKey={banTarget} onClose={() => setBanTarget(null)} />}
      {appBanTarget && (
        <AppBanModal roomId={roomId} targetKey={appBanTarget} onClose={() => setAppBanTarget(null)} />
      )}
      {suspectTarget && (
        <SuspectModal roomId={roomId} targetKey={suspectTarget} onClose={() => setSuspectTarget(null)} />
      )}
      {showApps && <ApplicationCenterModal roomId={roomId} onClose={() => setShowApps(false)} />}
      {showBans && <BanManagerModal roomId={roomId} onClose={() => setShowBans(false)} />}
      {showRoomSettings && <RoomSettingsModal roomId={roomId} onClose={() => setShowRoomSettings(false)} />}
      {sendFor !== undefined && (
        <SendFlowModal
          members={state.members}
          myKey={me?.key ?? ''}
          preselectedKey={sendFor ?? undefined}
          onClose={() => setSendFor(undefined)}
          onSend={sendOffer}
        />
      )}
      <OfferModals roomId={roomId} />
    </>
  )
}

// Transfers dashboard: participants get controls and real names; onlookers
// get a permanently blurred card (spec 8.6 — redaction is also enforced at
// the protocol level, this is just the last-mile UI).
function TransfersPane(props: {
  roomId: string
  tasks: import('../../../shared/api').TaskView[]
  onStartSend: () => void
  canClearHistory: boolean
}): React.JSX.Element {
  const bridge = useStore((s) => s.bridge)
  const online = useStore((s) => s.online)
  const [capDraft, setCapDraft] = useState<Record<string, string>>({})
  const live = props.tasks.filter((t) => t.state !== 'completed' && t.state !== 'cancelled' && t.state !== 'failed')
  const finished = props.tasks.filter((t) => t.state === 'completed' || t.state === 'failed' || t.state === 'cancelled')

  if (props.tasks.length === 0) {
    return (
      <div className="main-scroll">
        <div className="transfers-empty">
          <div className="transfers-empty-icon">
            <Icon name="inbox" size={32} />
          </div>
          <h2>No transfers in this room</h2>
          <p>
            Pick a member, choose files or a whole folder, and everything you send appears here —
            everyone sees progress, only the two parties see names.
          </p>
          <button className="btn primary" onClick={props.onStartSend} disabled={!online}>
            <Icon name="upload" size={14} />
            Send files
          </button>
        </div>
      </div>
    )
  }

  const card = (t: import('../../../shared/api').TaskView, finishedRow: boolean): React.JSX.Element => {
    const pct = t.total > 0 ? Math.min(100, (t.done / t.total) * 100) : 0
    const dirIcon: IconName = t.direction === 'send' ? 'upload' : t.direction === 'recv' ? 'download' : 'share2'
    const peers =
      t.direction === 'send'
        ? `you → ${t.peerName}`
        : t.direction === 'recv'
          ? `${t.peerName} → you`
          : `${t.peerName} → member`
    return (
      <article key={t.taskId} className={`transfer-card${t.participant ? '' : ' onlooker'}${finishedRow ? ' finished' : ''}`}>
        <div className="tc-head">
          <span className={`tc-dir${t.direction}`}>
            <Icon name={dirIcon} size={15} />
          </span>
          <span className="tc-name">{t.participant ? (t.label ?? 'transfer') : 'file transfer'}</span>
          <span className="tc-peers">
            <Icon name="users" size={12} />
            {peers}
          </span>
          <span className={`tc-state ${t.state}`}>{t.state.replace('-', ' ')}</span>
        </div>
        <div className="tc-bar">
          <div
            className={`tc-fill${t.state === 'completed' ? ' done' : t.state === 'failed' ? ' err' : ''}`}
            style={{ width: `${pct}%` }}
          />
        </div>
        <div className="tc-meta">
          <span className="tc-stats">
            <Icon name="file" size={12} />
            {formatBytes(t.done)} / {formatBytes(t.total)}
          </span>
          {t.participant && t.state === 'active' && (
            <span className="tc-stats">
              <Icon name="zap" size={12} />
              {formatSpeed(t.speedBps)}
            </span>
          )}
          {t.participant && !finishedRow && (
            <div className="tc-actions">
              {(t.state === 'active' || t.state === 'waiting-lock') && (
                <button
                  className="icon-btn"
                  title="Pause"
                  onClick={() => void bridge?.call('transfer:control', { taskId: t.taskId, action: 'pause' })}
                >
                  <Icon name="pause" size={13} />
                </button>
              )}
              {t.state === 'paused' && (
                <button
                  className="icon-btn"
                  title="Resume"
                  onClick={() => void bridge?.call('transfer:control', { taskId: t.taskId, action: 'resume' })}
                >
                  <Icon name="play" size={13} />
                </button>
              )}
              <button
                className="icon-btn danger"
                title="Cancel"
                onClick={() => void bridge?.call('transfer:control', { taskId: t.taskId, action: 'cancel' })}
              >
                <Icon name="xCircle" size={13} />
              </button>
              <input
                className="tc-cap"
                placeholder="cap KB/s"
                value={capDraft[t.taskId] ?? ''}
                title="Speed cap in KB/s — press Enter to apply"
                onChange={(e) => setCapDraft({ ...capDraft, [t.taskId]: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    const raw = capDraft[t.taskId] ?? ''
                    const bps = raw.trim() === '' ? null : Math.floor(Number(raw) * 1024)
                    void bridge?.call('transfer:setCap', { taskId: t.taskId, speedCapBps: bps && bps > 0 ? bps : null })
                  }
                }}
              />
            </div>
          )}
        </div>
        {t.participant && t.error && (
          <div className="tc-error">
            <Icon name="alertTriangle" size={13} />
            {t.error}
          </div>
        )}
      </article>
    )
  }

  return (
    <div className="main-scroll">
      {props.canClearHistory && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8 }}>
          <button
            className="btn ghost small"
            title="Remove finished, failed and cancelled transfer rows for everyone in the room. Active transfers are untouched."
            onClick={() => {
              void bridge?.call('transfer:historyClear', { roomId: props.roomId })
            }}
          >
            <Icon name="trash" size={12} />
            Clear history
          </button>
        </div>
      )}
      {live.map((t) => card(t, false))}
      {finished.length > 0 && <div className="side-section">Recent — {Math.min(3, finished.length)}</div>}
      {finished.slice(0, 3).map((t) => card(t, true))}
    </div>
  )
}

// Ban dialog (spec 7.4): free-text compound duration + reason.
function BanMemberModal(props: { roomId: string; targetKey: string; onClose: () => void }): React.JSX.Element {
  const bridge = useStore((s) => s.bridge)
  const roomStates = useStore((s) => s.roomStates)
  const state = roomStates[props.roomId]
  const target = state?.members.find((m) => m.key === props.targetKey)
  const [duration, setDuration] = useState('')
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const issue = (): void => {
    if (!bridge || busy) return
    setBusy(true)
    void bridge
      .call('mod:ban', { roomId: props.roomId, targetKey: props.targetKey, duration, reason })
      .then((res) => {
        if (!res.ok) {
          setError(res.error)
          setBusy(false)
          return
        }
        props.onClose()
      })
  }

  return (
    <Modal
      title={`Ban ${target?.name ?? shortKey(props.targetKey)}`}
      icon="ban"
      onClose={props.onClose}
      footer={
        <>
          <button className="btn" onClick={props.onClose}>
            Cancel
          </button>
          <button className="btn danger" disabled={busy} onClick={issue}>
            <Icon name="ban" size={13} />
            {busy ? 'Banning…' : 'Ban'}
          </button>
        </>
      }
    >
      <div className="field">
        <span className="field-label">Duration — e.g. 1y 30d 1w 1d 1m 1s · bare number = minutes · empty = permanent</span>
        <input
          value={duration}
          placeholder="perm"
          onChange={(e) => setDuration(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && issue()}
        />
      </div>
      <div className="field">
        <span className="field-label">Reason</span>
        <input value={reason} maxLength={500} placeholder="Shown to the banned user" onChange={(e) => setReason(e.target.value)} />
      </div>
      <div className="error-text">{error ?? ''}</div>
      <p style={{ fontSize: 12, color: 'var(--text-faint)', margin: 0 }}>
        They are notified instantly if online, and on their next contact with the room creator
        otherwise. All their local data for this room is wiped.
      </p>
    </Modal>
  )
}

// Application center (staff): pending join applications with
// accept/reject (rejection reason typed out), plus the permanent log of
// approvals and rejections.
function ApplicationCenterModal(props: { roomId: string; onClose: () => void }): React.JSX.Element {
  const bridge = useStore((s) => s.bridge)
  const [apps, setApps] = useState<ApplicationView[]>([])

  const load = (): void => {
    void bridge?.call('mod:applications', { roomId: props.roomId }).then(setApps)
  }
  useEffect(load, [props.roomId])

  const chip = (status: ApplicationView['status']): React.JSX.Element => (
    <span className={`app-verdict ${status}`}>
      {status === 'approved' ? 'joined' : status === 'banned' ? 'banned' : status === 'rejected' ? 'rejected' : 'pending'}
    </span>
  )

  return (
    <Modal
      title="Join log"
      icon="mail"
      onClose={props.onClose}
      footer={
        <button className="btn" onClick={props.onClose}>
          Close
        </button>
      }
    >
      <div className="field">
        <span className="field-label">
          Joins — {apps.length} · every join is instant; its typed reason lands here for the staff
        </span>
        {apps.length === 0 ? (
          <p style={{ fontSize: 12, color: 'var(--text-faint)', margin: 0 }}>
            Nobody has joined yet. When someone joins with the room code, their name, reason and time
            appear here — banned join attempts are recorded too.
          </p>
        ) : (
          <div className="app-list">
            {apps.map((a) => (
              <div
                key={a.applicantKey}
                className={`app-row${a.status === 'approved' ? ' ok' : ' no'}`}
              >
                <div className="app-row-body">
                  <div className="app-row-name">
                    {a.name} {chip(a.status)}
                  </div>
                  <div className="app-row-meta">
                    {new Date(a.decidedAt ?? a.createdAt).toLocaleString()}
                    {a.reason ? ` — “${a.reason}”` : ''}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </Modal>
  )
}

// Banned users (staff): the permanent ban history. Active bans (red)
// always sort above unbanned/expired ones (green).
function BanManagerModal(props: { roomId: string; onClose: () => void }): React.JSX.Element {
  const bridge = useStore((s) => s.bridge)
  const [bans, setBans] = useState<BanEntryView[]>([])

  const load = (): void => {
    void bridge?.call('mod:bans', { roomId: props.roomId }).then(setBans)
  }
  useEffect(load, [props.roomId])

  const unban = (targetKey: string): void => {
    void bridge?.call('mod:unban', { roomId: props.roomId, targetKey }).then(load)
  }

  return (
    <Modal
      title="Banned users"
      icon="ban"
      onClose={props.onClose}
      footer={
        <button className="btn" onClick={props.onClose}>
          Close
        </button>
      }
    >
      {bans.length === 0 ? (
        <p style={{ fontSize: 12, color: 'var(--text-faint)', margin: 0 }}>
          No bans in this room yet. Right-click a member → “Ban…” to issue one.
        </p>
      ) : (
        <div className="banman-list">
          {bans.map((b) => (
            <div key={`${b.targetKey}:${b.createdAt}`} className={`banman-row${b.active ? ' active' : ''}`}>
              <span className={`banman-icon${b.active ? ' on' : ' off'}`}>
                <Icon name={b.active ? 'ban' : 'checkCircle'} size={13} />
              </span>
              <div className="banman-body">
                <div className="banman-name">
                  {b.targetName}
                  <span className={`banman-state ${b.active ? 'banned' : 'unbanned'}`}>
                    {b.active ? 'banned' : 'unbanned'}
                  </span>
                </div>
                <div className="banman-meta">
                  {b.reason || 'no reason given'} · by {b.adminName} · {new Date(b.createdAt).toLocaleString()}
                  {b.expiresAt !== null
                    ? b.expiresAt > Date.now()
                      ? ` · until ${new Date(b.expiresAt).toLocaleString()}`
                      : ' · expired'
                    : ' · permanent'}
                </div>
              </div>
              {b.active && (
                <button className="btn small" onClick={() => unban(b.targetKey)}>
                  <Icon name="xCircle" size={12} />
                  Unban
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </Modal>
  )
}

// App-level ban (official app moderators only): blocks the target's whole
// app with the APP BANNED screen, delivered and self-enforced by every
// receiving client.
function AppBanModal(props: { roomId: string; targetKey: string; onClose: () => void }): React.JSX.Element {
  const bridge = useStore((s) => s.bridge)
  const [duration, setDuration] = useState('')
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [identity, setIdentity] = useState<{ hwid: string; ip: string | null } | null>(null)
  const [copied, setCopied] = useState<string | null>(null)

  useEffect(() => {
    if (!bridge) return
    void bridge.call('mod:memberIdentity', { roomId: props.roomId, targetKey: props.targetKey }).then(setIdentity)
  }, [bridge, props.roomId, props.targetKey])

  const copy = (what: string, text: string): void => {
    void bridge?.call('sys:copyText', { text }).then(() => {
      setCopied(what)
      setTimeout(() => setCopied(null), 1_600)
    })
  }

  const issue = (): void => {
    if (!bridge || busy) return
    setBusy(true)
    void bridge
      .call('app:ban', { roomId: props.roomId, targetKey: props.targetKey, duration, reason })
      .then((res) => {
        if (!res.ok) {
          setError(res.error)
          setBusy(false)
          return
        }
        props.onClose()
      })
      .finally(() => setBusy(false))
  }

  return (
    <Modal
      title={`App ban ${shortKey(props.targetKey)}`}
      icon="hammer"
      onClose={props.onClose}
      footer={
        <>
          <button className="btn" onClick={props.onClose}>
            Cancel
          </button>
          <button className="btn danger" disabled={busy || reason.trim().length === 0} onClick={issue}>
            <Icon name="hammer" size={13} />
            {busy ? 'Issuing…' : 'Ban from app'}
          </button>
        </>
      }
    >
      <div className="field">
        <span className="field-label">Duration — e.g. 30d · bare number = minutes · empty = permanent</span>
        <input value={duration} placeholder="perm" onChange={(e) => setDuration(e.target.value)} />
      </div>
      <div className="field">
        <span className="field-label">Reason (shown on their APP BANNED screen)</span>
        <input value={reason} maxLength={500} placeholder="Required" onChange={(e) => setReason(e.target.value)} />
      </div>
      {identity && (
        <div className="field">
          <span className="field-label">
            Target identity — copy into the hardcoded APP_BANS list (src/shared/constants.ts) to make the ban survive a reinstall
          </span>
          <div className="appban-identity">
            <div className="appban-identity-row">
              <span className="appban-identity-label">HWID</span>
              <code className="appban-identity-value" title={identity.hwid || '—'}>
                {identity.hwid || '—'}
              </code>
              <button
                className="btn ghost small"
                disabled={!identity.hwid}
                onClick={() => copy('hwid', identity.hwid)}
              >
                {copied === 'hwid' ? 'Copied ✓' : 'Copy'}
              </button>
            </div>
            <div className="appban-identity-row">
              <span className="appban-identity-label">IP</span>
              <code className="appban-identity-value" title={identity.ip || '—'}>
                {identity.ip || '—'}
              </code>
              <button
                className="btn ghost small"
                disabled={!identity.ip}
                onClick={() => copy('ip', identity.ip ?? '')}
              >
                {copied === 'ip' ? 'Copied ✓' : 'Copy'}
              </button>
            </div>
          </div>
        </div>
      )}
      <div className="error-text">{error ?? ''}</div>
      <p style={{ fontSize: 12, color: 'var(--text-faint)', margin: 0 }}>
        Their app blocks itself with the ban screen, reason and countdown, and stops updating. No files on
        their machine are touched.
      </p>
    </Modal>
  )
}

// Staff "Suspect…" dialog: typed reason + the target's HWID (copy it into
// the hardcoded SUSPECTED list in src/shared/constants.ts). Suspicion rows
// are append-only — they can only ever be marked as handled, never deleted.
function SuspectModal(props: { roomId: string; targetKey: string; onClose: () => void }): React.JSX.Element {
  const bridge = useStore((s) => s.bridge)
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [hwid, setHwid] = useState('')
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!bridge) return
    void bridge
      .call('mod:memberIdentity', { roomId: props.roomId, targetKey: props.targetKey })
      .then((res) => setHwid(res.hwid))
  }, [bridge, props.roomId, props.targetKey])

  const submit = (): void => {
    if (!bridge || busy) return
    setBusy(true)
    void bridge
      .call('mod:suspect', { roomId: props.roomId, targetKey: props.targetKey, reason })
      .then((res) => {
        if (!res.ok) {
          setError(res.error)
          setBusy(false)
          return
        }
        useStore
          .getState()
          .toast('Suspected', 'The member now carries the red "!" badge. It can only be marked as handled, never removed.', 'info')
        props.onClose()
      })
      .finally(() => setBusy(false))
  }

  return (
    <Modal
      title={`Suspect ${shortKey(props.targetKey)}`}
      icon="alertCircle"
      onClose={props.onClose}
      footer={
        <>
          <button className="btn" onClick={props.onClose}>
            Cancel
          </button>
          <button className="btn danger" disabled={busy || reason.trim().length === 0} onClick={submit}>
            <Icon name="alertCircle" size={13} />
            {busy ? 'Marking…' : 'Mark as suspected'}
          </button>
        </>
      }
    >
      <div className="field">
        <span className="field-label">Suspected of… (shown on the badge hover, for every staff member)</span>
        <input
          value={reason}
          maxLength={500}
          placeholder="Required — e.g. spreading a modified build"
          onChange={(e) => setReason(e.target.value)}
        />
      </div>
      {hwid && (
        <div className="field">
          <span className="field-label">
            Target HWID — copy it into the hardcoded SUSPECTED list (src/shared/constants.ts) so the badge ships with the build
          </span>
          <div className="appban-identity-row">
            <code className="appban-identity-value" title={hwid}>
              {hwid}
            </code>
            <button
              className="btn ghost small"
              onClick={() => {
                void bridge?.call('sys:copyText', { text: hwid }).then(() => {
                  setCopied(true)
                  setTimeout(() => setCopied(false), 1_600)
                })
              }}
            >
              {copied ? 'Copied ✓' : 'Copy'}
            </button>
          </div>
        </div>
      )}
      <div className="error-text">{error ?? ''}</div>
      <p style={{ fontSize: 12, color: 'var(--text-faint)', margin: 0 }}>
        A suspicion is permanent history: the red "!" badge can only turn orange ("handled"), never disappear.
      </p>
    </Modal>
  )
}

// Send flow: pick a peer, pick files/folders, send the offer.
function SendFlowModal(props: {
  members: import('../../../shared/api').MemberView[]
  myKey: string
  preselectedKey?: string
  onClose: () => void
  onSend: (paths: string[], peerKey: string) => void
}): React.JSX.Element {
  const bridge = useStore((s) => s.bridge)
  const [peerKey, setPeerKey] = useState(props.preselectedKey ?? '')
  const [paths, setPaths] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [dragOver, setDragOver] = useState(false)

  const candidates = props.members.filter((m) => !m.isMe && m.key !== props.myKey)

  const addDropped = (e: React.DragEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    setDragOver(false)
    if (!bridge) return
    const dropped = Array.from(e.dataTransfer.files)
      .map((f) => bridge.pathForFile(f))
      .filter((p) => p.length > 0)
    if (dropped.length === 0) return
    setPaths((p) => [...p, ...dropped.filter((d) => !p.includes(d))])
  }

  const pickFiles = (): void => {
    void bridge?.call('sys:pickFiles', undefined).then((res) => {
      if (res) setPaths((p) => [...p, ...res.paths])
    })
  }
  const pickFolder = (): void => {
    void bridge?.call('sys:pickFolder', undefined).then((res) => {
      if (res) setPaths((p) => [...p, ...res.path])
    })
  }

  const send = (): void => {
    if (busy) return
    setBusy(true)
    props.onSend(paths, peerKey)
    props.onClose()
  }

  return (
    <Modal
      title="Send files"
      icon="upload"
      onClose={props.onClose}
      footer={
        <>
          <button className="btn" onClick={props.onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={peerKey.length === 0 || paths.length === 0 || busy} onClick={send}>
            <Icon name="send" size={13} />
            Send offer
          </button>
        </>
      }
    >
      <div className="field">
        <span className="field-label">Send to</span>
        <select value={peerKey} onChange={(e) => setPeerKey(e.target.value)}>
          <option value="">Choose a member…</option>
          {candidates.map((m) => (
            <option key={m.key} value={m.key}>
              {m.name} {m.online ? '(online)' : '(offline)'}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <span className="field-label">Files & folders</span>
        <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
          <button className="btn small" onClick={pickFiles}>
            <Icon name="file" size={13} />
            Add files…
          </button>
          <button className="btn small" onClick={pickFolder}>
            <Icon name="folder" size={13} />
            Add folder…
          </button>
        </div>
        <div
          className={`drop-target${dragOver ? ' over' : ''}`}
          onDragOver={(e) => {
            if (!e.dataTransfer.types.includes('Files')) return
            e.preventDefault()
            setDragOver(true)
          }}
          onDragLeave={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragOver(false)
          }}
          onDrop={addDropped}
        >
          <Icon name="upload" size={15} />
          <span>Drag files or folders here</span>
        </div>
        {paths.length === 0 ? (
          <div className="empty-state" style={{ padding: 18 }}>
            Pick files or a whole folder tree — structure is preserved on the other side.
          </div>
        ) : (
          <div className="offer-file-list">
            {paths.map((p) => (
              <div key={p} className="offer-file">
                <Icon name={p.includes('\\') || p.includes('/') ? 'folder' : 'file'} size={14} />
                <span className="offer-file-path">{p}</span>
                <button className="icon-btn danger" title="Remove" onClick={() => setPaths((arr) => arr.filter((x) => x !== p))}>
                  <Icon name="trash" size={13} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </Modal>
  )
}
