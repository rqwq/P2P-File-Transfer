import React, { useEffect, useState } from 'react'
import { useStore } from '../state/store'
import { Icon } from '../components/Icon'
import { BadgeRow } from '../components/Badge'

// Ban-received screen (spec 7.5): shows the reason, the admin's name and
// a countdown to unban rendered in the user's own local timezone. All
// local data for the room was already wiped by the main process.

function formatCountdown(ms: number): string {
  if (ms <= 0) return 'expired'
  const total = Math.floor(ms / 1000)
  const d = Math.floor(total / 86_400)
  const h = Math.floor((total % 86_400) / 3_600)
  const m = Math.floor((total % 3_600) / 60)
  const s = total % 60
  if (d > 0) return `${d}d ${h}h ${m}m`
  if (h > 0) return `${h}h ${m}m ${s}s`
  if (m > 0) return `${m}m ${s}s`
  return `${s}s`
}

export function BanDialog(): React.JSX.Element {
  const ban = useStore((s) => s.banScreen)
  const close = useStore((s) => s.closeBanScreen)
  const [, tick] = useState(0)

  useEffect(() => {
    const timer = setInterval(() => tick((n) => n + 1), 1_000)
    return () => clearInterval(timer)
  }, [])

  if (!ban) return <div className="center-screen" />

  const remaining = ban.expiresAt !== null ? ban.expiresAt - Date.now() : null

  return (
    <div className="center-screen">
      <div className="center-card" style={{ borderColor: 'rgba(255,107,107,0.4)' }}>
        <h1 style={{ color: 'var(--danger)' }}>
          <Icon name="ban" size={20} />
          You are banned
        </h1>
        <p>
          Room <strong>{ban.roomName || 'this room'}</strong> — banned by{' '}
          <strong>{ban.adminName}</strong>
          {ban.adminBadges.length > 0 && <BadgeRow badges={ban.adminBadges} />}.
        </p>
        <p style={{ marginBottom: 6 }}>
          Reason: <strong>{ban.reason || 'No reason given'}</strong>
        </p>
        <div className="ban-countdown">
          {remaining === null
            ? 'Permanent'
            : remaining > 0
              ? formatCountdown(remaining)
              : 'Ban expired'}
        </div>
        {ban.expiresAt !== null && (
          <p style={{ fontSize: 12 }}>
            Unban date: {new Date(ban.expiresAt).toLocaleString()} ({Intl.DateTimeFormat().resolvedOptions().timeZone})
          </p>
        )}
        <div className="btn-row">
          <button className="btn" onClick={close}>
            {remaining !== null && remaining <= 0 ? 'Continue' : 'Close'}
          </button>
        </div>
      </div>
    </div>
  )
}
