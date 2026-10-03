import React from 'react'
import { useStore } from '../state/store'
import { Icon } from './Icon'

// License/About footer (spec 10): present on every page — link to the
// license text, a GitHub button (system browser via shell.openExternal)
// and a copy-Discord-username button. No first-run EULA flow.

export function Footer(props: { onOpenSettings?: () => void }): React.JSX.Element {
  const bridge = useStore((s) => s.bridge)
  const boot = useStore((s) => s.boot)
  const setAboutOpen = useStore((s) => s.setAboutOpen)
  const online = useStore((s) => s.online)
  const setOnline = useStore((s) => s.setOnline)
  const [copied, setCopied] = React.useState(false)

  // App-banned installs can never go online: the pill is locked on
  // Offline (main also rejects the call, this keeps the button honest).
  const appBanned = boot?.stage === 'appBanned'

  const copyContact = (): void => {
    void bridge?.call('sys:copyText', { text: 'phenomenal_lqc' }).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1_600)
    })
  }

  return (
    <div className="app-footer">
      <button
        className={`status-pill${online ? ' on' : ''}`}
        disabled={appBanned}
        onClick={() => {
          if (!appBanned) setOnline(!online)
        }}
        title={
          appBanned
            ? 'You are banned — you cannot go online'
            : online
              ? 'Go offline — peers can no longer reach you (no messages, no transfer requests)'
              : 'Go online — reconnect to your rooms'
        }
      >
        <span className="status-dot" />
        {online ? 'Online' : 'Offline'}
      </button>
      <button className="footer-link" onClick={() => setAboutOpen(true)}>
        <Icon name="fileText" size={12} />
        License
      </button>
      <button
        className="footer-link"
        onClick={() => void bridge?.call('sys:openExternal', { url: 'https://github.com/rqwq/P2P-File-Transfer' })}
      >
        <Icon name="externalLink" size={12} />
        GitHub
      </button>
      <button className="footer-link" onClick={copyContact}>
        <Icon name={copied ? 'check' : 'message'} size={12} />
        {copied ? 'Discord copied ✓' : 'Discord: phenomenal_lqc'}
      </button>
      <span className="footer-spacer" />
      {props.onOpenSettings && (
        <button className="footer-link" onClick={props.onOpenSettings}>
          <Icon name="settings" size={12} />
          Settings
        </button>
      )}
    </div>
  )
}
