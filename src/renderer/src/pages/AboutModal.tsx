import React, { useEffect, useState } from 'react'
import { useStore } from '../state/store'
import { Modal } from '../components/ui'

// About / License panel (spec 14): renders the final product EULA from
// the main process (LICENSE_TEXT in src/main/identity.ts, mirrored in
// the repository root as LICENSE).

export function AboutModal(): React.JSX.Element {
  const bridge = useStore((s) => s.bridge)
  const showAbout = useStore((s) => s.showAbout)
  const setAboutOpen = useStore((s) => s.setAboutOpen)
  const boot = useStore((s) => s.boot)
  const [text, setText] = useState('')

  useEffect(() => {
    if (showAbout && bridge) {
      void bridge.call('about:license', undefined).then((res) => setText(res.text))
    }
  }, [showAbout, bridge])

  if (!showAbout) return <></>

  return (
    <Modal
      title="About & License"
      icon="fileText"
      onClose={() => setAboutOpen(false)}
      footer={
        <button className="btn" onClick={() => setAboutOpen(false)}>
          Close
        </button>
      }
    >
      <p style={{ fontSize: 12.5, color: 'var(--text-dim)', marginTop: 0 }}>
        P2P File Transfer {boot?.version ? `v${boot.version}` : ''} — serverless peer-to-peer file
        transfer. Source-available for review; not open source.
      </p>
      <pre
        style={{
          whiteSpace: 'pre-wrap',
          fontFamily: 'inherit',
          fontSize: 12.5,
          lineHeight: 1.55,
          color: 'var(--text-dim)',
          background: 'var(--bg-elev)',
          border: '1px solid var(--border-soft)',
          borderRadius: 8,
          padding: 12,
          userSelect: 'text'
        }}
      >
        {text}
      </pre>
      <p style={{ fontSize: 12, color: 'var(--text-faint)', marginBottom: 0 }}>
        Contact for licensing questions / abuse reports: Discord <code>.extremism</code>
      </p>
    </Modal>
  )
}
