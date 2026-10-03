import React from 'react'
import { useStore } from '../state/store'
import { Icon } from './Icon'
import type { IconName } from './Icon'

const KIND_ICON: Record<string, IconName> = {
  info: 'info',
  transfer: 'download',
  ban: 'ban',
  invite: 'mail',
  error: 'alertTriangle'
}

export function Toasts(): React.JSX.Element {
  const toasts = useStore((s) => s.toasts)
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>
          <span className="toast-icon">
            <Icon name={KIND_ICON[t.kind] ?? 'info'} size={14} />
          </span>
          <div>
            <div className="toast-title">{t.title}</div>
            {t.body && <div className="toast-body">{t.body}</div>}
          </div>
        </div>
      ))}
    </div>
  )
}
