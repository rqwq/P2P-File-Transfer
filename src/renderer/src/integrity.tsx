import React from 'react'
import { createRoot } from 'react-dom/client'

// The "unofficial copy" warning window's UI (spec 12.5): a fully separate
// page from the main app, with only the two bridge actions — open the
// repository in the system browser, and copy the Discord contact.

interface IntegrityBridge {
  openRepo(): Promise<unknown>
  copyContact(): Promise<unknown>
}

function IntegrityWarning(): React.JSX.Element {
  const bridge = (window as unknown as Record<string, unknown>).p2pftIntegrity as
    | IntegrityBridge
    | undefined
  const [copied, setCopied] = React.useState(false)

  return (
    <div
      style={{
        height: '100vh',
        margin: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: '#0b0e14',
        color: '#d7e3f4',
        fontFamily: "'Segoe UI', system-ui, sans-serif",
        padding: 24,
        userSelect: 'none'
      }}
    >
      <div
        style={{
          maxWidth: 560,
          background: '#151b28',
          border: '1px solid rgba(255,107,107,0.4)',
          boxShadow: '0 0 40px rgba(255,70,70,0.15)',
          borderRadius: 14,
          padding: '34px 38px',
          animation: 'pulse 2.4s ease-in-out infinite alternate'
        }}
      >
        <style>{`@keyframes pulse { from { box-shadow: 0 0 24px rgba(255,70,70,0.10); } to { box-shadow: 0 0 48px rgba(255,70,70,0.25); } }`}</style>
        <div style={{ fontSize: 40, marginBottom: 8 }}>⚠</div>
        <h1 style={{ margin: '0 0 10px', fontSize: 21, color: '#ff8a8a' }}>
          This may be a modified copy
        </h1>
        <p style={{ color: '#8595ad', lineHeight: 1.6, fontSize: 14, margin: '0 0 12px' }}>
          This build's integrity check failed: the packaged code does not match the official
          release. A modified copy may contain malware — it could steal files, credentials, or
          worse.
        </p>
        <p style={{ color: '#8595ad', lineHeight: 1.6, fontSize: 14, margin: '0 0 22px' }}>
          Recommended actions:
        </p>
        <ul style={{ color: '#8595ad', lineHeight: 1.8, fontSize: 13.5, margin: '0 0 26px', paddingLeft: 20 }}>
          <li>Close this app and delete it, along with the installer you used.</li>
          <li>Consider rotating passwords you used on this machine recently.</li>
          <li>Download only from the official GitHub Releases page.</li>
          <li>Report where you got this copy — Discord <code>phenomenal_lqc</code>.</li>
        </ul>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button
            onClick={() => void bridge?.copyContact().then(() => setCopied(true))}
            style={{
              font: 'inherit',
              fontSize: 13,
              padding: '9px 16px',
              borderRadius: 8,
              cursor: 'pointer',
              background: '#1a2233',
              color: '#d7e3f4',
              border: '1px solid #232d42'
            }}
          >
            {copied ? 'Discord copied ✓' : 'Copy Discord username'}
          </button>
          <button
            onClick={() => void bridge?.openRepo()}
            style={{
              font: 'inherit',
              fontSize: 13,
              padding: '9px 16px',
              borderRadius: 8,
              cursor: 'pointer',
              background: '#7ec8e3',
              color: '#08121c',
              fontWeight: 600,
              border: '1px solid #7ec8e3'
            }}
          >
            Open official repository
          </button>
        </div>
      </div>
    </div>
  )
}

const container = document.getElementById('root')
if (container) createRoot(container).render(<IntegrityWarning />)
