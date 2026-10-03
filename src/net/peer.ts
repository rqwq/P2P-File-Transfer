import SecretStream from '@hyperswarm/secret-stream'
import { EventEmitter } from 'node:events'
import crypto from 'node:crypto'
import b4a from 'b4a'
import { CHUNK_SIZE, HANDSHAKE_TIMEOUT_MS, IDLE_TIMEOUT_MS, PING_INTERVAL_MS } from '../shared/constants'
import { controlMessageSchema, type ControlMessage } from '../shared/protocol'
import {
  FRAME_ATTACHMENT,
  FRAME_CHUNK,
  FRAME_PREVIEW,
  FrameParser,
  encodeControl,
  encodeFrame,
  type ParsedFrame
} from './framing'

// One encrypted connection to a remote peer. Every inbound control
// message is validated against its Zod schema before anything uses it;
// frames from peers that are not yet TOFU-trusted are held in a bounded
// queue until the user decides (spec 6).

const MAX_QUEUED = 500

export interface PeerIdentity {
  key: string
  name: string
  hwid: string
}

export class Peer extends EventEmitter {
  readonly socket: SecretStream
  readonly roomId: string
  remoteKey = ''
  remoteName = ''
  remoteHwid = ''
  ip: string | null = null
  trusted: boolean
  rtt = Number.POSITIVE_INFINITY
  private queue: ParsedFrame[] = []
  private lastActivity = Date.now()
  private pingTimer: NodeJS.Timeout | null = null
  private watchdogTimer: NodeJS.Timeout | null = null
  private closed = false

  constructor(socket: SecretStream, roomId: string, remoteKey: Buffer | null, trusted: boolean) {
    super()
    this.socket = socket
    this.roomId = roomId
    this.remoteKey = remoteKey ? b4a.toString(remoteKey, 'hex') : ''
    this.trusted = trusted
    const raw = (socket as unknown as { rawStream?: { remoteAddress?: string } }).rawStream
    this.ip = raw?.remoteAddress ?? null

    const parser = new FrameParser(
      (frame) => this.handleFrame(frame),
      (err) => this.protocolError(err)
    )
    socket.on('data', (chunk: Buffer) => {
      this.lastActivity = Date.now()
      parser.push(chunk)
    })
    socket.on('error', () => this.close())
    socket.on('close', () => this.close())
    socket.on('end', () => this.close())

    // Handshake timeout: a connection that never completes its hello dies.
    setTimeout(() => {
      if (!this.remoteName && !this.closed) {
        this.protocolError(new Error('handshake timeout'))
      }
    }, HANDSHAKE_TIMEOUT_MS)

    this.pingTimer = setInterval(() => this.pingOnce(), PING_INTERVAL_MS)
    this.watchdogTimer = setInterval(() => {
      if (Date.now() - this.lastActivity > IDLE_TIMEOUT_MS) {
        this.close()
      }
    }, 10_000)
  }

  get key(): string {
    return this.remoteKey
  }

  sendControl(msg: ControlMessage): boolean {
    if (this.closed) return false
    try {
      this.socket.write(encodeControl(msg))
      return true
    } catch {
      this.close()
      return false
    }
  }

  sendBinary(type: number, header: unknown, data: Uint8Array): boolean {
    if (this.closed) return false
    try {
      this.socket.write(encodeFrame(type, header, data))
      return true
    } catch {
      this.close()
      return false
    }
  }

  sendChatAttachment(chatId: string, size: number, blob: Uint8Array): boolean {
    return this.sendBinary(FRAME_ATTACHMENT, { chatId, size }, blob)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    if (this.pingTimer) clearInterval(this.pingTimer)
    if (this.watchdogTimer) clearInterval(this.watchdogTimer)
    try {
      this.socket.destroy()
    } catch {
      // already destroyed
    }
    this.emit('closed', this)
    this.removeAllListeners()
  }

  private protocolError(err: Error): void {
    this.emit('protocolError', this, err)
    this.close()
  }

  private pingOnce(): void {
    if (this.closed) return
    if (!this.trusted) return
    const nonce = crypto.randomInt(1, 2 ** 31)
    const sent = Date.now()
    const oncePong = (msg: ControlMessage): void => {
      if (msg.t === 'pong' && msg.nonce === nonce) {
        this.rtt = Date.now() - sent
        this.off('control', oncePong)
      }
    }
    this.on('control', oncePong)
    this.sendControl({ t: 'ping', nonce })
    // If the pong never comes back the idle watchdog closes the peer.
  }

  private handleFrame(frame: ParsedFrame): void {
    this.lastActivity = Date.now()
    if (frame.type === FRAME_CHUNK || frame.type === FRAME_PREVIEW || frame.type === FRAME_ATTACHMENT) {
      if (!this.trusted) {
        if (this.queue.length < MAX_QUEUED) this.queue.push(frame)
        return
      }
      this.emit('binary', this, frame)
      return
    }
    // Control frame: strict Zod validation (spec 11) — a message that
    // fails validation never reaches any handler.
    let parsed: unknown
    try {
      parsed = JSON.parse(frame.header.toString('utf8'))
    } catch {
      this.protocolError(new Error('invalid control JSON'))
      return
    }
    const result = controlMessageSchema.safeParse(parsed)
    if (!result.success) {
      // Name the exact field and show the payload — "Required" alone
      // points nowhere when hunting a protocol mismatch.
      const detail = result.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
        .join(' | ')
      const preview = frame.header.toString('utf8').slice(0, 200)
      this.protocolError(new Error(`control message failed validation: ${detail} — message: ${preview}`))
      return
    }
    const msg = result.data as ControlMessage
    if (msg.t === 'hello') {
      this.remoteName = msg.name
      this.remoteHwid = msg.hwid
      if (!this.remoteKey) this.remoteKey = msg.key
      this.emit('hello', this, msg)
      return
    }
    if (msg.t === 'pong') {
      this.emit('control', this, msg)
      return
    }
    if (!this.trusted) {
      // join_request is allowed through untrusted: the creator-side TOFU
      // prompt IS the admission decision (spec 6/7.3).
      if (msg.t !== 'join_request') {
        if (this.queue.length < MAX_QUEUED) this.queue.push(frame)
        return
      }
    }
    this.lastActivity = Date.now()
    this.emit('control', this, msg)
  }

  markTrusted(): void {
    this.trusted = true
    const held = this.queue
    this.queue = []
    for (const frame of held) {
      if (frame.type === FRAME_CHUNK || frame.type === FRAME_PREVIEW || frame.type === FRAME_ATTACHMENT) {
        this.emit('binary', this, frame)
      } else {
        const parsed = JSON.parse(frame.header.toString('utf8')) as ControlMessage
        this.emit('control', this, parsed)
      }
    }
  }

  static chunkCount(size: number): number {
    return Math.max(1, Math.ceil(size / CHUNK_SIZE))
  }
}
