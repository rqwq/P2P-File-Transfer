import React, { useId, useState } from 'react'
import type { BadgeInfo } from '../../../shared/api'
import { Icon } from './Icon'

// One identity badge on a member row. Hovering shows the badge name and,
// below a gray separator line, its short description. The tooltip is a
// real fixed-position element measured from the badge's rect — CSS
// pseudo-element tooltips got clipped by the sidebar's scroll container
// and overlapped by neighboring panes.

const ICON_OF: Record<BadgeInfo['id'], { icon: Parameters<typeof Icon>[0]['name']; color: string }> = {
  developer: { icon: 'wrench', color: 'var(--badge-developer)' },
  creator: { icon: 'crown', color: 'var(--badge-creator)' },
  admin: { icon: 'hammerShield', color: 'var(--badge-admin)' },
  moderator: { icon: 'shield', color: 'var(--badge-mod)' },
  official: { icon: 'checkCircle', color: 'var(--badge-official)' },
  appMod: { icon: 'anarchy', color: 'var(--badge-appmod)' },
  suspected: { icon: 'alertCircle', color: 'var(--danger)' },
  untrusted: { icon: 'thumbsDown', color: 'var(--badge-untrusted)' }
}

// The Developer badge is a wrench at a right angle, stroked with a real
// animated gradient: the two stops cycle orange → red → green out of
// phase, so a moving gradient band flows along the stroke.
function DeveloperGradientIcon(props: { size: number }): React.JSX.Element {
  const gradId = useId()
  return (
    <svg
      className="icon"
      width={props.size}
      height={props.size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={`url(#${gradId})`}
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="24" y2="24" gradientUnits="userSpaceOnUse">
          <stop offset="0%">
            <animate attributeName="stop-color" values="#ff9f43;#ff5c5c;#4ad66d;#ff9f43" dur="3.6s" repeatCount="indefinite" />
          </stop>
          <stop offset="100%">
            <animate attributeName="stop-color" values="#4ad66d;#ff9f43;#ff5c5c;#4ad66d" dur="3.6s" repeatCount="indefinite" />
          </stop>
        </linearGradient>
      </defs>
      {/* wrench at a right angle */}
      <g transform="rotate(90 12 12)">
        <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
      </g>
    </svg>
  )
}

// The app-moderator anarchy symbol is stroked with a real animated
// gradient: the two stops cycle yellow → cyan → light-red out of phase,
// so a moving gradient band flows along the stroke. A <linearGradient> in
// userSpace spans the icon's 24×24 grid diagonally regardless of rendered
// size.
function AppModGradientIcon(props: { size: number }): React.JSX.Element {
  const gradId = useId()
  return (
    <svg
      className="icon"
      width={props.size}
      height={props.size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={`url(#${gradId})`}
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="24" y2="24" gradientUnits="userSpaceOnUse">
          <stop offset="0%">
            <animate attributeName="stop-color" values="#ffe45c;#35e0e8;#ff8f9a;#ffe45c" dur="3s" repeatCount="indefinite" />
          </stop>
          <stop offset="100%">
            <animate attributeName="stop-color" values="#ff8f9a;#ffe45c;#35e0e8;#ff8f9a" dur="3s" repeatCount="indefinite" />
          </stop>
        </linearGradient>
      </defs>
      <circle cx="12" cy="12" r="9.5" />
      <path d="M5.2 21.2 12 2 18.8 21.2" />
      <path d="M7.75 14h8.5" />
    </svg>
  )
}

interface TipPos {
  left: number
  top: number
  below: boolean
}

export function Badge(props: { badge: BadgeInfo; size?: number }): React.JSX.Element {
  const { badge } = props
  const size = props.size ?? 16
  const look = ICON_OF[badge.id]
  const [tip, setTip] = useState<TipPos | null>(null)

  const show = (el: HTMLElement): void => {
    const r = el.getBoundingClientRect()
    // Place above the badge; flip below when too close to the window top
    // (the first member rows sit high in the sidebar).
    const below = r.top < 96
    setTip({ left: r.left + r.width / 2, top: below ? r.bottom : r.top, below })
  }

  return (
    <span
      className={`badge badge-${badge.id}${badge.variant ? ` ${badge.variant}` : ''}`}
      style={{ color: look.color }}
      onMouseEnter={(e) => show(e.currentTarget as HTMLElement)}
      onMouseLeave={() => setTip(null)}
      onMouseDown={() => setTip(null)}
    >
      {badge.id === 'appMod' ? (
        <AppModGradientIcon size={size} />
      ) : badge.id === 'developer' ? (
        <DeveloperGradientIcon size={size} />
      ) : (
        <Icon name={look.icon} size={size} />
      )}
      {tip && (
        <div className="badge-tip" style={{ left: tip.left, top: tip.top }} data-below={tip.below ? '1' : undefined}>
          <span className="badge-tip-name">{badge.name}</span>
          <span className="badge-tip-desc">{badge.description}</span>
        </div>
      )}
    </span>
  )
}

export function BadgeRow(props: { badges: BadgeInfo[]; size?: number }): React.JSX.Element | null {
  if (props.badges.length === 0) return null
  return (
    <span className="badge-row">
      {props.badges.map((b) => (
        <Badge key={b.id} badge={b} size={props.size} />
      ))}
    </span>
  )
}
