import React from 'react'
import { useStore } from '../state/store'
import { Icon } from '../components/Icon'
import { Modal, shortKey } from '../components/ui'

// Trust-on-first-use prompt (spec 6): requires explicit user action,
// never auto-accept. One prompt per unknown peer key; the kind is shown
// for context (a join request or a newly met room member).

export function TrustModal(): React.JSX.Element {
  const prompts = useStore((s) => s.trustPrompts)
  const bridge = useStore((s) => s.bridge)
  const prompt = prompts[0]

  if (!prompt || !bridge) return <></>

  const respond = (accept: boolean): void => {
    void bridge.call('trust:respond', { key: prompt.key, accept }).then(() => {
      useStore.setState((s) => ({ trustPrompts: s.trustPrompts.filter((p) => p.key !== prompt.key) }))
    })
  }

  return (
    <Modal
      title={prompt.kind === 'join' ? 'Join request' : 'New peer'}
      icon="shield"
      onClose={() => respond(false)}
      footer={
        <>
          <button className="btn" onClick={() => respond(false)}>
            <Icon name="x" size={13} />
            Block
          </button>
          <button className="btn primary" onClick={() => respond(true)}>
            <Icon name="check" size={13} />
            {prompt.kind === 'join' ? 'Admit to room' : 'Trust this peer'}
          </button>
        </>
      }
    >
      <p style={{ color: 'var(--text-dim)', fontSize: 13.5, lineHeight: 1.5 }}>
        {prompt.kind === 'join'
          ? 'Someone is asking to join your room. Their identity is confirmed by their encryption key — check the name before admitting.'
          : 'You are connected to a peer you have not seen before. Trusting them lets them send you messages and files.'}
      </p>
      <div className="code-chip">
        {prompt.name} · {shortKey(prompt.key)}
      </div>
    </Modal>
  )
}
