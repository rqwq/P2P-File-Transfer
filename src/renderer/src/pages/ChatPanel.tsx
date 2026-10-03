import React, { useEffect, useRef, useState } from 'react'
import { useStore } from '../state/store'
import { Markdown } from '../components/Markdown'
import { Icon } from '../components/Icon'
import { formatBytes } from '../components/ui'

// Chat (spec 9): persistent per-room text chat with markdown rendering
// and attachments within the room's limits. Every member stores messages
// locally; sync merges happen in the net worker.

export function ChatPanel(props: { roomId: string }): React.JSX.Element {
  const bridge = useStore((s) => s.bridge)
  // The selector must return a stable reference: defaulting to a fresh []
  // here gives React's useSyncExternalStore a new snapshot on every check,
  // which loops to "maximum update depth exceeded" and unmounts the whole
  // window (the blank-screen-on-room-entry crash). Default OUTSIDE the hook.
  const loadedMessages = useStore((s) => s.chats[props.roomId])
  const messages = loadedMessages ?? []
  const roomStates = useStore((s) => s.roomStates)
  const settings = useStore((s) => s.settings)
  const state = roomStates[props.roomId]
  const limit = state?.settings.chatLimits.textLength ?? 500
  const [text, setText] = useState('')
  const [attachmentPath, setAttachmentPath] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const attachmentCache = useRef(new Map<string, string>())

  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages.length])

  // Revoke all attachment blob URLs when leaving the room (they are
  // renderer-side leaks otherwise) — the map itself lives for the mount.
  useEffect(() => {
    const cache = attachmentCache.current
    return () => {
      for (const url of cache.values()) URL.revokeObjectURL(url)
      cache.clear()
    }
  }, [])

  const send = (): void => {
    if (!bridge) return
    if (!useStore.getState().online) {
      useStore.getState().toast('You are offline', 'Go online first (bottom-left toggle) to send messages.', 'error')
      return
    }
    const trimmed = text.trim()
    if (trimmed.length === 0 && !attachmentPath) return
    void bridge.call('chat:send', { roomId: props.roomId, text: trimmed, attachmentPath }).then((res) => {
      if (res.ok) {
        setText('')
        setAttachmentPath(null)
      } else {
        useStore.getState().toast('Message not sent', res.error ?? 'Unknown error', 'error')
      }
    })
  }

  const pickAttachment = (): void => {
    void bridge?.call('sys:pickFiles', undefined).then((res) => {
      if (res && res.paths.length > 0) setAttachmentPath(res.paths[0])
    })
  }

  // Drag & drop: exactly one file per chat message (validated on send).
  const onDrop = (e: React.DragEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    setDragOver(false)
    if (!bridge) return
    const files = Array.from(e.dataTransfer.files)
    if (files.length === 0) return
    const path = bridge.pathForFile(files[0])
    if (!path) {
      useStore.getState().toast('Cannot attach', 'That item has no usable file path.', 'error')
      return
    }
    setAttachmentPath(path)
    if (files.length > 1) {
      useStore
        .getState()
        .toast('One attachment per message', `Using "${files[0].name}" — attach the rest in follow-up messages.`, 'info')
    }
  }

  const loadAttachment = (messageId: string): void => {
    if (!bridge || attachmentCache.current.has(messageId)) return
    void bridge.call('chat:attachment', { roomId: props.roomId, messageId }).then((buf) => {
      if (!buf) return
      const blob = new Blob([buf])
      const url = URL.createObjectURL(blob)
      attachmentCache.current.set(messageId, url)
      // Force a re-render so the attachment appears.
      setTick((t) => t + 1)
    })
  }

  const [tick, setTick] = useState(0)
  void tick

  let lastDay = ''

  return (
    <div
      className="room-chat"
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return
        e.preventDefault()
        setDragOver(true)
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragOver(false)
      }}
      onDrop={onDrop}
    >
      {dragOver && (
        <div className="drop-overlay">
          <Icon name="paperclip" size={22} />
          <span>Drop to attach</span>
        </div>
      )}
      <div className="chat-head">
        <Icon name="message" size={14} />
        Chat
        <span className="count">{messages.length > 0 ? `${messages.length} msg` : ''}</span>
      </div>
      <div className="chat-scroll" ref={scrollRef}>
        {loadedMessages === undefined && (
          <div className="empty-state" style={{ padding: '30px 20px' }}>
            <div className="spinner" />
          </div>
        )}
        {loadedMessages !== undefined && messages.length === 0 && (
          <div className="empty-state">
            <div className="big">💬</div>
            No messages yet — say hi. History is stored by every member and merged automatically.
          </div>
        )}
        {messages.map((m) => {
          const day = new Date(m.ts).toDateString()
          const showDay = day !== lastDay
          lastDay = day
          const mine = m.senderKey === (state?.members.find((x) => x.isMe)?.key ?? '')
          const url = attachmentCache.current.get(m.id)
          return (
            <React.Fragment key={m.id}>
              {showDay && <div className="day-sep">{day}</div>}
              <div className={`chat-row${mine ? ' mine' : ''}`}>
                <div className="chat-avatar">{(mine ? settings?.displayName ?? 'you' : m.senderName).slice(0, 2).toUpperCase()}</div>
                <div className="chat-bubble">
                  <div className="chat-meta">
                    <span>{mine ? (settings?.displayName ?? 'you') : m.senderName}</span>
                    <span>
                      {new Date(m.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </span>
                  </div>
                  {m.text.length > 0 && <Markdown text={m.text} />}
                  {m.attachment && (
                    <div className="chat-att">
                      {url ? (
                        m.attachment.mime.startsWith('image/') ? (
                          <img src={url} alt={m.attachment.name} />
                        ) : m.attachment.mime.startsWith('video/') ? (
                          <video src={url} controls />
                        ) : m.attachment.mime.startsWith('audio/') ? (
                          <audio src={url} controls />
                        ) : (
                          <span className="chat-att-name">{m.attachment.name}</span>
                        )
                      ) : (
                        <button className="chat-att-cta" onClick={() => loadAttachment(m.id)}>
                          <Icon
                            name={
                              m.attachment.mime.startsWith('image/')
                                ? 'image'
                                : m.attachment.mime.startsWith('video/')
                                  ? 'film'
                                  : m.attachment.mime.startsWith('audio/')
                                    ? 'music'
                                    : 'fileText'
                            }
                            size={14}
                          />
                          <span>{m.attachment.name}</span>
                          <span className="chat-att-meta">· {formatBytes(m.attachment.size)} — click to load</span>
                        </button>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </React.Fragment>
          )
        })}
      </div>
      <div className="chat-input-row">
        {attachmentPath && (
          <button className="chat-attach-chip" onClick={() => setAttachmentPath(null)} title="Remove attachment">
            <Icon name="paperclip" size={11} />
            <span>{attachmentPath.split(/[\\/]/).pop()}</span>
            <Icon name="x" size={11} />
          </button>
        )}
        <button className="icon-btn" onClick={pickAttachment} title="Attach image / video / audio">
          <Icon name="paperclip" size={14} />
        </button>
        <input
          value={text}
          placeholder={state?.room.name ? `Message #${state.room.name} — markdown supported` : 'Message — markdown supported'}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              send()
            }
          }}
        />
        <span className="chat-counter">
          {text.length}/{limit}
        </span>
        <button className="icon-btn" onClick={send} disabled={text.trim().length === 0 && !attachmentPath} title="Send">
          <Icon name="send" size={14} />
        </button>
      </div>
    </div>
  )
}
