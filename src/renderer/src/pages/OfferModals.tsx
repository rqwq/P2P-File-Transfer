import React, { useEffect, useRef, useState } from 'react'
import type { OfferView, PreviewMeta } from '../../../shared/api'
import { RISKY_CONFIRM_SECONDS, SAFE_CONFIRM_SECONDS } from '../../../shared/constants'
import { useStore } from '../state/store'
import { Icon } from '../components/Icon'
import { Modal, formatBytes } from '../components/ui'

// Incoming-offer confirmation (spec 8.2) with the risky-extension variant
// (15s disabled accept + subtle red glow; 10s for non-risky) plus the
// whole-file-into-RAM preview (spec 8.3) rendered from the fetched bytes.

export function OfferModals(props: { roomId: string }): React.JSX.Element {
  const bridge = useStore((s) => s.bridge)
  const offers = useStore((s) => s.offers)
  const [declined, setDeclined] = useState<Set<string>>(new Set())
  const active = Object.values(offers).filter((o) => o.roomId === props.roomId && !declined.has(o.taskId))
  const offer = active[0]

  if (!offer || !bridge) return <></>

  const respond = (accept: boolean, capBps: number | null): void => {
    setDeclined((prev) => {
      const next = new Set(prev)
      next.add(offer.taskId)
      return next
    })
    void bridge.call('transfer:respond', { taskId: offer.taskId, accept, speedCapBps: capBps }).then(() => {
      useStore.setState((s) => {
        const offers = { ...s.offers }
        delete offers[offer.taskId]
        return { offers }
      })
    })
  }

  return (
    <>
      <OfferConfirmModal offer={offer} onRespond={respond} />
    </>
  )
}

function OfferConfirmModal(props: {
  offer: OfferView
  onRespond: (accept: boolean, capBps: number | null) => void
}): React.JSX.Element {
  const [secondsLeft, setSecondsLeft] = useState(props.offer.risky ? RISKY_CONFIRM_SECONDS : SAFE_CONFIRM_SECONDS)
  const [cap, setCap] = useState('')
  const [preview, setPreview] = useState<{ fileId: number } | null>(null)

  useEffect(() => {
    if (secondsLeft <= 0) return
    const t = setTimeout(() => setSecondsLeft((s) => s - 1), 1_000)
    return () => clearTimeout(t)
  }, [secondsLeft])

  const capBps = (): number | null => {
    const raw = cap.trim()
    if (raw === '') return null
    const n = Math.floor(Number(raw) * 1024)
    return Number.isFinite(n) && n > 0 ? n : null
  }

  return (
    <>
      <Modal
        title={`${props.offer.senderName} wants to send you ${props.offer.files.length} file${props.offer.files.length === 1 ? '' : 's'}`}
        icon="download"
        risky={props.offer.risky}
        onClose={() => props.onRespond(false, null)}
        footer={
          <>
            <button className="btn" onClick={() => props.onRespond(false, null)}>
              <Icon name="x" size={13} />
              Decline
            </button>
            <button
              className="btn primary"
              disabled={secondsLeft > 0}
              onClick={() => props.onRespond(true, capBps())}
            >
              <Icon name="check" size={13} />
              {secondsLeft > 0 ? `Accept in ${secondsLeft}s` : 'Accept'}
            </button>
          </>
        }
      >
        {props.offer.risky && (
          <div className="risky-banner">
            <Icon name="alertTriangle" size={16} />
            <span>
              This transfer contains executable or script files (.exe, .bat, .ps1, …). Only accept
              files from people you trust — the accept button unlocks in {RISKY_CONFIRM_SECONDS}s.
            </span>
          </div>
        )}
        <div className="offer-summary">
          <span>
            <strong>{formatBytes(props.offer.totalSize)}</strong> total
          </span>
          <span>
            <strong>{props.offer.files.length}</strong> file(s)
          </span>
          {props.offer.risky && (
            <span style={{ color: 'var(--danger)' }}>
              <strong>{props.offer.files.filter((f) => f.risky).length}</strong> risky
            </span>
          )}
        </div>
        <div className="offer-file-list">
          {props.offer.files.map((f) => (
            <div key={f.id} className="offer-file" onClick={() => setPreview({ fileId: f.id })}>
              <Icon name="file" size={14} />
              <span className="offer-file-path">{f.relPath}</span>
              {f.risky && (
                <span className="risky-tag">
                  <Icon name="alertTriangle" size={10} />
                  risky
                </span>
              )}
              <span className="offer-file-size">{formatBytes(f.size)}</span>
            </div>
          ))}
        </div>
        <div className="field" style={{ marginBottom: 0 }}>
          <span className="field-label">Download speed cap for this transfer — KB/s (empty = uncapped)</span>
          <input
            value={cap}
            inputMode="numeric"
            placeholder="uncapped"
            style={{ maxWidth: 220 }}
            onChange={(e) => setCap(e.target.value.replace(/[^0-9.]/g, ''))}
          />
        </div>
        {secondsLeft > 0 && !props.offer.risky && (
          <p style={{ fontSize: 11.5, color: 'var(--text-faint)', margin: '4px 0 0' }}>
            Accept unlocks in<span className="countdown">{secondsLeft}s</span>
          </p>
        )}
      </Modal>
      {preview && (
        <PreviewModal
          offer={props.offer}
          fileId={preview.fileId}
          onClose={() => setPreview(null)}
        />
      )}
    </>
  )
}

function PreviewModal(props: { offer: OfferView; fileId: number; onClose: () => void }): React.JSX.Element {
  const bridge = useStore((s) => s.bridge)
  const [meta, setMeta] = useState<PreviewMeta | null>(null)
  const [url, setUrl] = useState<string | null>(null)
  const [text, setText] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const previewIdRef = useRef<string | null>(null)
  const urlRef = useRef<string | null>(null)

  useEffect(() => {
    setLoading(true)
    setUrl(null)
    setText(null)
    let cancelled = false
    void bridge
      ?.call('transfer:preview', { taskId: props.offer.taskId, fileId: props.fileId })
      .then(async (res) => {
        if (cancelled) return
        setMeta(res)
        if (res.error) {
          setLoading(false)
          return
        }
        previewIdRef.current = res.previewId
        const buf = await bridge.call('transfer:previewRead', { previewId: res.previewId })
        if (cancelled) return
        if (!buf) {
          setLoading(false)
          return
        }
        const blob = new Blob([buf], { type: res.mime })
        const objectUrl = URL.createObjectURL(blob)
        urlRef.current = objectUrl
        setUrl(objectUrl)
        if (res.mime.startsWith('text/')) {
          setText(new TextDecoder().decode(buf))
        }
        setLoading(false)
      })
    return () => {
      cancelled = true
      // Free both sides promptly: the renderer blob URL and the main-side
      // RAM preview. (The previous cleanup closed over a stale url that was
      // always null, so neither was ever released.)
      if (urlRef.current) {
        URL.revokeObjectURL(urlRef.current)
        urlRef.current = null
      }
      const previewId = previewIdRef.current
      previewIdRef.current = null
      if (previewId) void bridge?.call('transfer:previewClose', { previewId })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.offer.taskId, props.fileId])

  const file = props.offer.files.find((f) => f.id === props.fileId)

  return (
    <Modal
      title={`Preview — ${file?.relPath.split(/[\\/]/).pop() ?? ''}`}
      icon="fileText"
      width={700}
      onClose={props.onClose}
      footer={
        <button className="btn" onClick={props.onClose}>
          Close preview
        </button>
      }
    >
      {loading && (
        <div style={{ textAlign: 'center', padding: 30 }}>
          <div className="spinner" />
          <p style={{ color: 'var(--text-dim)', fontSize: 12.5 }}>
            Loading whole file into RAM for preview…
          </p>
        </div>
      )}
      {!loading && meta?.error && (
        <div className="error-text" style={{ fontSize: 14 }}>
          {meta.error}
        </div>
      )}
      {!loading && url && !text && (
        <div className="preview-frame">
          {meta?.mime.startsWith('image/') && <img src={url} alt="preview" />}
          {meta?.mime.startsWith('video/') && <video src={url} controls autoPlay={false} />}
          {meta?.mime.startsWith('audio/') && <audio src={url} controls style={{ width: '100%' }} />}
        </div>
      )}
      {!loading && text && (
        <div className="preview-frame preview-text">{text}</div>
      )}
    </Modal>
  )
}
