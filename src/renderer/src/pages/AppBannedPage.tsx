import React, { useEffect, useMemo, useState } from 'react'
import { useStore } from '../state/store'
import { BadgeRow } from '../components/Badge'

// The APP BANNED screen (self-enforced app ban): replaces the whole app
// body, shows the reason, who issued it and a live countdown to the unban
// time, over an animated night-sky background whose stars appear and
// disappear in random places.

function formatRemaining(ms: number): string {
  if (ms <= 0) return 'expired'
  const total = Math.floor(ms / 1000)
  const d = Math.floor(total / 86_400)
  const h = Math.floor((total % 86_400) / 3_600)
  const m = Math.floor((total % 3_600) / 60)
  const s = total % 60
  if (d > 0) return `${d}d ${h}h ${m}m ${s}s`
  if (h > 0) return `${h}h ${m}m ${s}s`
  if (m > 0) return `${m}m ${s}s`
  return `${s}s`
}

// A star field where each star loops its own twinkle forever at a random
// spot — a continuous night sky. Stars are mounted ONCE (no periodic
// regeneration: remounting the whole field made it blink out dark for a
// moment between generations); `gen` only exists to remount on window
// restore, because Chromium can park hidden-window CSS animations at
// opacity 0.
function StarField(): React.JSX.Element {
  const [gen, setGen] = useState(0)
  useEffect(() => {
    const revive = (): void => {
      if (document.visibilityState === 'visible') setGen((n) => n + 1)
    }
    document.addEventListener('visibilitychange', revive)
    window.addEventListener('focus', revive)
    return () => {
      document.removeEventListener('visibilitychange', revive)
      window.removeEventListener('focus', revive)
    }
  }, [])
  const stars = useMemo(
    () =>
      // Real randomness: the previous Math.sin(i * 37.7) pseudo-random had
      // a period of almost exactly 12π, so every star landed at nearly the
      // same left offset — a single vertical line of stars.
      Array.from({ length: 90 }, () => ({
        left: `${Math.random() * 100}%`,
        top: `${Math.random() * 100}%`,
        delay: `${Math.random() * 6}s`,
        duration: `${3 + Math.random() * 4}s`,
        size: 1 + Math.floor(Math.random() * 3)
      })),
    [gen]
  )
  return (
    <div className="appban-stars" aria-hidden="true">
      {stars.map((s, i) => (
        <span
          key={`${gen}-${i}`}
          className="appban-star"
          style={{ left: s.left, top: s.top, animationDelay: s.delay, animationDuration: s.duration, width: s.size, height: s.size }}
        />
      ))}
    </div>
  )
}

export function AppBannedPage(): React.JSX.Element {
  const boot = useStore((s) => s.boot)
  const bridge = useStore((s) => s.bridge)
  const [, tick] = useState(0)

  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1_000)
    return () => clearInterval(t)
  }, [])

  const ban = boot?.appBan
  const remaining = ban && ban.expiresAt !== null ? ban.expiresAt - Date.now() : null

  return (
    <div className="appban-screen">
      <StarField />
      <div className="appban-card">
        <h1 className="appban-title">
          <span className="appban-title-icon">✖</span>
          APP BANNED.
        </h1>
        <div className="appban-reason-box">
          <span className="appban-reason-label">Reason</span>
          <span className="appban-reason-text">{ban?.reason || 'No reason given'}</span>
        </div>
        <div className="appban-countdown">
          {remaining === null ? (
            'Permanent — this ban does not expire.'
          ) : remaining > 0 ? (
            <>
              Time until unban: <strong>{formatRemaining(remaining)}</strong>
              <span className="appban-date">{new Date(ban!.expiresAt!).toLocaleString()}</span>
            </>
          ) : (
            'This ban has expired — restart the app.'
          )}
        </div>
        <div className="appban-byline">
          Banned by <strong>{ban?.byName || 'App Moderator'}</strong>
          {ban?.byBadges && ban.byBadges.length > 0 && <BadgeRow badges={ban.byBadges} />}
        </div>
        <div className="appban-identity">
          <CopyableIdentity label="HWID" value={ban?.targetHwid || ''} bridge={bridge} />
          <CopyableIdentity label="IP" value={(ban?.targetIps ?? []).join(', ')} bridge={bridge} />
        </div>
        <div className="appban-foot">This ban cannot be appealed.</div>
        <div className="btn-row" style={{ marginTop: 18 }}>
          <button
            className="btn danger"
            onClick={() => {
              void bridge?.call('app:quit', undefined)
            }}
          >
            Close application
          </button>
        </div>
      </div>
    </div>
  )
}

// One copyable identity row (HWID / IP) — the values the app moderator
// needs to hardcode this machine into the APP_BANS list in
// src/shared/constants.ts, so the ban survives a reinstall.
function CopyableIdentity(props: { label: string; value: string; bridge: ReturnType<typeof useStore.getState>['bridge'] }): React.JSX.Element {
  const [copied, setCopied] = React.useState(false)
  const copy = (): void => {
    if (!props.value) return
    void props.bridge?.call('sys:copyText', { text: props.value }).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1_600)
    })
  }
  return (
    <div className="appban-identity-row">
      <span className="appban-identity-label">{props.label}</span>
      <code className="appban-identity-value" title={props.value || '—'}>
        {props.value || '—'}
      </code>
      <button className="btn ghost small" disabled={!props.value} onClick={copy}>
        {copied ? 'Copied ✓' : 'Copy'}
      </button>
    </div>
  )
}
