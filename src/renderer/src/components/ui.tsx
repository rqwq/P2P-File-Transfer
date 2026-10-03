import React, { useEffect, useRef, useState } from 'react'
import { Icon, type IconName } from './Icon'

// Stack of live modal tokens: Escape closes only the topmost one, so
// stacked modals (offer dialog + file preview) unwind innermost-first.
const escStack: symbol[] = []

export function Modal(props: {
  title: string
  icon?: IconName
  risky?: boolean
  onClose?: () => void
  footer?: React.ReactNode
  children: React.ReactNode
  width?: number
}): React.JSX.Element {
  const onCloseRef = useRef(props.onClose)
  onCloseRef.current = props.onClose
  const tokenRef = useRef<symbol | null>(null)

  useEffect(() => {
    if (tokenRef.current === null) tokenRef.current = Symbol('modal')
    const token = tokenRef.current
    escStack.push(token)
    const onKey = (e: KeyboardEvent): void => {
      if (e.repeat) return
      if (e.key === 'Escape' && escStack[escStack.length - 1] === token) onCloseRef.current?.()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      const i = escStack.indexOf(token)
      if (i >= 0) escStack.splice(i, 1)
      window.removeEventListener('keydown', onKey)
    }
  }, [])

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) props.onClose?.()
      }}
    >
      <div className={`modal${props.risky ? ' risky' : ''}`} style={props.width ? { width: props.width } : undefined}>
        <div className="modal-head">
          {props.icon && (
            <span className="modal-head-icon">
              <Icon name={props.icon} size={15} />
            </span>
          )}
          <span>{props.title}</span>
          {props.onClose && (
            <button className="icon-btn modal-head-close" onClick={props.onClose} title="Close">
              <Icon name="x" size={14} />
            </button>
          )}
        </div>
        <div className="modal-body">{props.children}</div>
        {props.footer && <div className="modal-foot">{props.footer}</div>}
      </div>
    </div>
  )
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = bytes / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(v >= 10 ? 0 : 1)} ${units[i]}`
}

export const BYTE_UNITS = ['Bytes', 'KB', 'MB', 'GB'] as const
export type ByteUnit = (typeof BYTE_UNITS)[number]

export function byteUnitMultiplier(unit: ByteUnit): number {
  return unit === 'Bytes' ? 1 : unit === 'KB' ? 1024 : unit === 'MB' ? 1024 * 1024 : 1024 * 1024 * 1024
}

// Split a byte count into (value, unit) for a BytesUnitField: the largest
// unit that divides it exactly, so a saved value round-trips unchanged.
export function splitBytes(bytes: number): { value: string; unit: ByteUnit } {
  for (let i = BYTE_UNITS.length - 1; i > 0; i--) {
    const unit = BYTE_UNITS[i]
    const mult = byteUnitMultiplier(unit)
    if (bytes >= mult && bytes % mult === 0) return { value: String(bytes / mult), unit }
  }
  return { value: bytes > 0 ? String(bytes) : '', unit: 'Bytes' }
}

// Byte-size input with a Bytes/KB/MB/GB unit dropdown on its right. The
// typed number is the value; the dropdown is the modifier (bytes = n x
// unit). Empty input reports null (caller decides what that means).
export function BytesUnitField(props: {
  label: string
  bytes: number | null
  onBytes: (bytes: number | null) => void
  placeholder?: string
  maxBytes?: number
  hint?: string
}): React.JSX.Element {
  const initial = splitBytes(props.bytes ?? 0)
  const [value, setValue] = useState(initial.value)
  const [unit, setUnit] = useState<ByteUnit>(initial.unit)
  // Re-derive the fields when the incoming bytes change for reasons other
  // than our own emission (modal re-open, external update).
  const lastEmitted = useRef<number | null>(props.bytes ?? null)
  useEffect(() => {
    const incoming = props.bytes ?? null
    if (incoming !== lastEmitted.current) {
      lastEmitted.current = incoming
      const s = splitBytes(incoming ?? 0)
      setValue(s.value)
      setUnit(s.unit)
    }
  }, [props.bytes])

  const emit = (raw: string, u: ByteUnit): void => {
    if (raw.trim() === '') {
      lastEmitted.current = null
      props.onBytes(null)
      return
    }
    const n = Math.floor(Number(raw))
    if (!Number.isFinite(n) || n <= 0) {
      lastEmitted.current = null
      props.onBytes(null)
      return
    }
    const bytes = Math.min(n * byteUnitMultiplier(u), props.maxBytes ?? Number.MAX_SAFE_INTEGER)
    lastEmitted.current = bytes
    props.onBytes(bytes)
  }

  return (
    <div className="field">
      <span className="field-label">{props.label}</span>
      <div style={{ display: 'flex', gap: 8 }}>
        <input
          style={{ flex: 1 }}
          inputMode="numeric"
          placeholder={props.placeholder ?? ''}
          value={value}
          onChange={(e) => {
            const raw = e.target.value.replace(/[^0-9]/g, '')
            setValue(raw)
            emit(raw, unit)
          }}
        />
        <select
          value={unit}
          onChange={(e) => {
            const u = e.target.value as ByteUnit
            setUnit(u)
            emit(value, u)
          }}
        >
          {BYTE_UNITS.map((u) => (
            <option key={u} value={u}>
              {u}
            </option>
          ))}
        </select>
      </div>
      {props.hint && <p style={{ fontSize: 12, color: 'var(--text-faint)', margin: 0 }}>{props.hint}</p>}
    </div>
  )
}

export function formatSpeed(bytesPerSec: number): string {
  if (bytesPerSec <= 0) return '—'
  return `${formatBytes(bytesPerSec)}/s`
}

export function shortKey(key: string): string {
  return key.length > 12 ? `${key.slice(0, 6)}…${key.slice(-4)}` : key
}

export function avatarColor(seed: string): string {
  let hash = 0
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) | 0
  const hue = Math.abs(hash) % 360
  return `hsl(${hue}, 55%, 38%)`
}
