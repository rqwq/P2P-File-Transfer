import React from 'react'
import { useStore } from '../state/store'
import { Icon } from './Icon'

// macOS-style traffic lights on a frameless window (spec 10), even
// though the target OS is Windows. Glyphs appear on hover, like macOS.

export function TitleBar(): React.JSX.Element {
  const bridge = useStore((s) => s.bridge)
  const currentRoomId = useStore((s) => s.currentRoomId)
  const roomStates = useStore((s) => s.roomStates)
  const room = currentRoomId ? roomStates[currentRoomId] : null
  const title = room ? `P2P File Transfer — ${room.room.name}` : 'P2P File Transfer'

  return (
    <div className="titlebar">
      <div className="traffic-lights">
        <button
          className="traffic-light traffic-red"
          title="Close (to tray — transfers continue)"
          onClick={() => void bridge?.call('win:close', undefined)}
        >
          <Icon name="x" size={8} className="tl-glyph" />
        </button>
        <button
          className="traffic-light traffic-yellow"
          title="Minimize"
          onClick={() => void bridge?.call('win:minimize', undefined)}
        >
          <Icon name="minus" size={8} className="tl-glyph" />
        </button>
        <button
          className="traffic-light traffic-green"
          title="Maximize / restore"
          onClick={() => void bridge?.call('win:toggleMaximize', undefined)}
        >
          <Icon name="maximize" size={8} className="tl-glyph" />
        </button>
      </div>
      <div className="titlebar-center">
        <div className="titlebar-logo">
          <Icon name="share2" size={12} />
        </div>
        <div className="titlebar-title">{title}</div>
      </div>
      <div style={{ width: 63, flex: '0 0 auto' }} />
    </div>
  )
}
