import React from 'react'
import type { Bridge } from '../../../shared/api'
import { BRIDGE_KEY } from '../../../shared/api'
import { Icon } from './Icon'

// Last-resort crash screen. Without this, an uncaught render error unmounts
// the entire React tree — on a frameless window that leaves a dead blank
// rectangle with no controls at all. The fallback keeps a readable card on
// screen with reload/quit buttons, plus a draggable strip so the window
// can still be moved.

interface State {
  error: Error | null
}

export class ErrorBoundary extends React.Component<{ children: React.ReactNode }, State> {
  override state: State = { error: null }

  static getDerivedStateFromError(error: Error): Partial<State> | null {
    return { error }
  }

  override componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error('[ui] render crashed:', error, info.componentStack)
  }

  private reload = (): void => {
    window.location.reload()
  }

  private quit = (): void => {
    const bridge = (window as unknown as Record<string, unknown>)[BRIDGE_KEY] as Bridge | undefined
    if (bridge) void bridge.call('app:quit', undefined)
    else window.close()
  }

  override render(): React.ReactNode {
    if (!this.state.error) return this.props.children
    return (
      <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', background: 'var(--bg)' }}>
        <div style={{ height: 38, flex: '0 0 auto', WebkitAppRegion: 'drag' } as React.CSSProperties} />
        <div className="center-screen" style={{ flex: 1 }}>
          <div className="center-card" style={{ maxWidth: 640 }}>
            <h1 style={{ color: 'var(--danger)' }}>
              <Icon name="alertTriangle" size={20} />
              The interface hit an error
            </h1>
            <p>
              Something crashed while drawing the window. Transfers and rooms keep running in the
              background — reload to get back in. The details below say why it happened.
            </p>
            <pre
              style={{
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                fontFamily: 'ui-monospace, Consolas, monospace',
                fontSize: 11.5,
                lineHeight: 1.5,
                color: 'var(--text-dim)',
                background: 'var(--bg-elev)',
                border: '1px solid var(--border-soft)',
                borderRadius: 8,
                padding: 12,
                maxHeight: 200,
                overflow: 'auto',
                userSelect: 'text',
                margin: '0 0 18px'
              }}
            >
              {String(this.state.error)}
            </pre>
            <div className="btn-row">
              <button className="btn" onClick={this.quit}>
                <Icon name="logOut" size={13} />
                Quit app
              </button>
              <button className="btn primary" onClick={this.reload}>
                <Icon name="refresh" size={13} />
                Reload interface
              </button>
            </div>
          </div>
        </div>
      </div>
    )
  }
}
