import crypto from 'node:crypto'
import os from 'node:os'
import { CHUNK_SIZE, CHUNK_WINDOW, PREVIEW_MEM_SAFETY } from '../shared/constants'
import type { TaskView, OfferView } from '../shared/api'
import type { ControlMessage } from '../shared/protocol'
import { chunkHeaderSchema, previewHeaderSchema } from '../shared/protocol'
import type { NetContext } from './context'
import type { RoomNet } from './room'
import { Peer } from './peer'
import { FRAME_CHUNK, FRAME_PREVIEW } from './framing'

// Transfer engine (worker side, spec 8). The wire protocol, chunk
// windowing, retransmits, pacing and resume negotiation live here; the
// main process owns the actual disk I/O and checkpoint state files.
// task_update broadcasts deliberately carry no filenames (spec 8.6) so
// onlookers can never see paths, at the protocol level.

const ACK_TIMEOUT_MS = 20_000
const PREVIEW_PART = 256 * 1024

type TaskState = 'active' | 'paused' | 'waiting-lock' | 'completed' | 'failed' | 'cancelled'

interface SendFile {
  id: number
  relPath: string
  size: number
  risky: boolean
  totalChunks: number
}

interface SendTask {
  kind: 'send'
  taskId: string
  roomId: string
  receiverKey: string
  label: string
  files: SendFile[]
  totalSize: number
  state: TaskState
  error: string | null
  capBps: number | null
  maxSpeedBps: number | null
  fileIdx: number
  acked: Set<number>
  inFlight: Map<number, NodeJS.Timeout>
  cursor: number
  doneBytes: number
  filesDone: number
  ready: boolean // transfer_resume received from receiver
  pumping: boolean
  reattach: boolean
  // Guards completeSendFile against a duplicate/late final chunk_ack
  // running the file completion twice (double fileIdx advance would
  // silently skip a file).
  completing: boolean
  lockTimer: NodeJS.Timeout | null
  lastSendAt: number
  speedSample: { ts: number; bytes: number } | null
  speedBps: number
}

interface RecvFile {
  id: number
  relPath: string
  size: number
  risky: boolean
  totalChunks: number
  bitmap: Buffer
  // Memoized main-side beginFile (destination path resolution + open),
  // requested when the first chunk of this file arrives — previously the
  // engine NEVER asked main to begin the file, so every first writeChunk
  // came back "file not begun" and the whole transfer failed.
  beginPromise: Promise<{ ok: boolean; error: string | null }> | null
}

interface RecvTask {
  kind: 'recv'
  taskId: string
  roomId: string
  senderKey: string
  label: string
  files: RecvFile[]
  totalSize: number
  state: TaskState
  error: string | null
  capBps: number | null
  doneBytes: number
  filesDone: number
  speedSample: { ts: number; bytes: number } | null
  speedBps: number
}

interface RemoteTask {
  taskId: string
  roomId: string
  senderKey: string
  receiverKey: string
  total: number
  done: number
  fileCount: number
  state: TaskState
  updatedAt: number
}

interface PendingPreview {
  mime: string
  size: number
  parts: Buffer[]
  received: number
}

export class TransferEngine {
  private ctx: NetContext
  private tasks = new Map<string, SendTask | RecvTask>()
  private remoteTasks = new Map<string, RemoteTask>()
  private pendingOffers = new Map<string, { offer: OfferView; senderKey: string }>()
  private pendingPreviews = new Map<string, PendingPreview>()
  private dirtyRooms = new Set<string>()
  private flushTimer: NodeJS.Timeout | null = null
  private lastBroadcast = new Map<string, number>()

  constructor(ctx: NetContext) {
    this.ctx = ctx
  }

  private roomOf(roomId: string): RoomNet | undefined {
    const ref = this.ctx.rooms.get(roomId)
    return (ref as unknown as RoomNet) ?? undefined
  }

  // ---- main-driven entry points ----

  offerFromMain(p: {
    taskId: string
    roomId: string
    receiverKey: string
    files: { id: number; relPath: string; size: number; risky: boolean }[]
    totalSize: number
    label: string
  }): void {
    const room = this.roomOf(p.roomId)
    const task: SendTask = {
      kind: 'send',
      taskId: p.taskId,
      roomId: p.roomId,
      receiverKey: p.receiverKey,
      label: p.label,
      files: p.files.map((f) => ({ ...f, totalChunks: Peer.chunkCount(f.size) })),
      totalSize: p.totalSize,
      state: 'active',
      error: null,
      capBps: null,
      maxSpeedBps: this.ctx.identity.maxSpeedBps,
      fileIdx: 0,
      acked: new Set(),
      inFlight: new Map(),
      cursor: 0,
      doneBytes: 0,
      filesDone: 0,
      ready: false,
      pumping: false,
      reattach: false,
      completing: false,
      lockTimer: null,
      lastSendAt: 0,
      speedSample: null,
      speedBps: 0
    }
    this.tasks.set(p.taskId, task)
    const peer = room?.peerOf(p.receiverKey)
    if (!peer || !peer.trusted) {
      // Remote peer not reachable (spec 8.4).
      task.state = 'failed'
      task.error = 'ERR: remote host not connected'
      this.markDirty(p.roomId)
      return
    }
    this.sendOffer(task, peer)
    this.markDirty(p.roomId)
  }

  reattachFromMain(p: {
    tasks: {
      taskId: string
      roomId: string
      receiverKey: string
      files: { id: number; relPath: string; size: number; risky: boolean }[]
      totalSize: number
      label: string
    }[]
  }): void {
    for (const t of p.tasks) {
      if (this.tasks.has(t.taskId)) continue
      this.tasks.set(t.taskId, {
        kind: 'send',
        taskId: t.taskId,
        roomId: t.roomId,
        receiverKey: t.receiverKey,
        label: t.label,
        files: t.files.map((f) => ({ ...f, totalChunks: Peer.chunkCount(f.size) })),
        totalSize: t.totalSize,
        state: 'paused',
        error: null,
        capBps: null,
        maxSpeedBps: this.ctx.identity.maxSpeedBps,
        fileIdx: 0,
        acked: new Set(),
        inFlight: new Map(),
        cursor: 0,
        doneBytes: 0,
        filesDone: 0,
        ready: false,
        pumping: false,
        reattach: true,
        completing: false,
        lockTimer: null,
        lastSendAt: 0,
        speedSample: null,
        speedBps: 0
      })
      this.markDirty(t.roomId)
    }
  }

  respondFromMain(p: { taskId: string; accept: boolean; speedCapBps: number | null; error: string | null }): void {
    const pending = this.pendingOffers.get(p.taskId)
    if (!pending) return
    this.pendingOffers.delete(p.taskId)
    const room = this.roomOf(pending.offer.roomId)
    const peer = room?.peerOf(pending.senderKey)
    const task: RecvTask = {
      kind: 'recv',
      taskId: p.taskId,
      roomId: pending.offer.roomId,
      senderKey: pending.senderKey,
      label: pending.offer.files.map((f) => f.relPath.split(/[\\/]/)[0]).slice(0, 3).join(', '),
      files: pending.offer.files.map((f) => ({
        id: f.id,
        relPath: f.relPath,
        size: f.size,
        risky: f.risky,
        totalChunks: Peer.chunkCount(f.size),
        bitmap: Buffer.alloc(Math.ceil(Peer.chunkCount(f.size) / 8)),
        beginPromise: null
      })),
      totalSize: pending.offer.totalSize,
      state: 'active',
      error: null,
      capBps: p.speedCapBps,
      doneBytes: 0,
      filesDone: 0,
      speedSample: null,
      speedBps: 0
    }
    this.tasks.set(p.taskId, task)
    if (!peer || !peer.trusted) {
      task.state = 'failed'
      task.error = 'ERR: remote host not connected'
      this.markDirty(task.roomId)
      return
    }
    if (!p.accept) {
      this.tasks.delete(p.taskId)
      peer.sendControl({ t: 'transfer_response', taskId: p.taskId, accept: false, speedCapBps: null })
      if (p.error) {
        peer.sendControl({ t: 'transfer_state', taskId: p.taskId, state: 'failed', error: p.error })
      }
      this.markDirty(task.roomId)
      return
    }
    peer.sendControl({ t: 'transfer_response', taskId: p.taskId, accept: true, speedCapBps: p.speedCapBps })
    // Fresh accept: everything at zero — send the (empty) checkpoint map
    // so the sender knows where to start.
    peer.sendControl({
      t: 'transfer_resume',
      taskId: p.taskId,
      files: task.files.map((f) => ({ id: f.id, bitmap: f.bitmap.toString('base64') }))
    })
    this.markDirty(task.roomId)
  }

  controlFromMain(p: { taskId: string; action: 'pause' | 'resume' | 'cancel' }): void {
    const task = this.tasks.get(p.taskId)
    if (!task) return
    const room = this.roomOf(task.roomId)
    const peerKey = task.kind === 'send' ? task.receiverKey : task.senderKey
    const peer = room?.peerOf(peerKey)
    if (p.action === 'cancel') {
      task.state = 'cancelled'
      peer?.sendControl({ t: 'transfer_state', taskId: task.taskId, state: 'cancelled', error: null })
      if (task.kind === 'send') this.clearInFlight(task)
      this.ctx.emitMain('transfer:cleanup', { taskId: task.taskId })
    } else if (task.kind === 'send') {
      task.state = p.action === 'pause' ? 'paused' : 'active'
      peer?.sendControl({
        t: 'transfer_state',
        taskId: task.taskId,
        state: p.action === 'pause' ? 'paused' : 'resumed',
        error: null
      })
      if (p.action === 'resume') this.pump(task)
    } else {
      task.state = p.action === 'pause' ? 'paused' : 'active'
      peer?.sendControl({
        t: 'transfer_state',
        taskId: task.taskId,
        state: p.action === 'pause' ? 'paused' : 'resumed',
        error: null
      })
    }
    this.markDirty(task.roomId)
  }

  setCapFromMain(p: { taskId: string; speedCapBps: number | null }): void {
    const task = this.tasks.get(p.taskId)
    if (!task) return
    if (task.kind === 'send') {
      // The receiver changed the download cap mid-flight: apply it.
      task.capBps = p.speedCapBps
    } else {
      task.capBps = p.speedCapBps
      const room = this.roomOf(task.roomId)
      room
        ?.peerOf(task.senderKey)
        ?.sendControl({ t: 'transfer_cap', taskId: task.taskId, speedCapBps: p.speedCapBps })
    }
    this.markDirty(task.roomId)
  }

  previewRequestFromMain(p: { taskId: string; fileId: number }): void {
    const pending = this.pendingOffers.get(p.taskId)
    const senderKey = pending?.senderKey ?? (this.tasks.get(p.taskId) as RecvTask | undefined)?.senderKey
    if (!senderKey) return
    const task = this.tasks.get(p.taskId)
    const room = this.roomOf(task?.roomId ?? pending?.offer.roomId ?? '')
    room?.peerOf(senderKey)?.sendControl({ t: 'preview_request', taskId: p.taskId, fileId: p.fileId })
  }

  onPeerConnected(roomId: string, key: string): void {
    for (const task of this.tasks.values()) {
      if (task.kind === 'send' && task.roomId === roomId && task.receiverKey === key) {
        const room = this.roomOf(roomId)
        const peer = room?.peerOf(key)
        if (peer && peer.trusted && (task.state === 'active' || task.state === 'paused' || task.state === 'waiting-lock')) {
          this.sendOffer(task, peer)
        }
      }
    }
  }

  // ---- wire-driven handlers ----

  onWireControl(roomId: string, fromKey: string, msg: ControlMessage): void {
    switch (msg.t) {
      case 'transfer_offer': {
        void this.handleIncomingOffer(roomId, fromKey, msg)
        return
      }
      case 'transfer_response': {
        const task = this.tasks.get(msg.taskId)
        if (task?.kind !== 'send' || task.receiverKey !== fromKey) return
        if (!msg.accept) {
          task.state = 'cancelled'
          task.error = null
          this.clearInFlight(task)
          this.markDirty(task.roomId)
          return
        }
        task.capBps = msg.speedCapBps
        task.state = 'active'
        this.markDirty(task.roomId)
        return
      }
      case 'transfer_resume': {
        const task = this.tasks.get(msg.taskId)
        if (task?.kind !== 'send' || task.receiverKey !== fromKey) return
        for (const f of msg.files) {
          const file = task.files.find((x) => x.id === f.id)
          if (!file) continue
          const map = Buffer.from(f.bitmap, 'base64')
          let doneBytes = 0
          for (let i = 0; i < file.totalChunks; i++) {
            if (map[i >> 3] & (1 << (i & 7))) {
              task.acked.add(i)
              doneBytes += Math.min(CHUNK_SIZE, file.size - i * CHUNK_SIZE)
            }
          }
          if (task.fileIdx === task.files.indexOf(file)) {
            task.doneBytes = doneBytes
          }
        }
        task.ready = true
        task.state = 'active'
        this.pump(task)
        return
      }
      case 'chunk_ack': {
        const task = this.tasks.get(msg.taskId)
        if (task?.kind !== 'send' || task.receiverKey !== fromKey) return
        const file = task.files[task.fileIdx]
        if (!file || file.id !== msg.fileId) return
        const timer = task.inFlight.get(msg.chunkIdx)
        if (timer) {
          clearTimeout(timer)
          task.inFlight.delete(msg.chunkIdx)
        }
        if (msg.bad) return // chunk will be re-picked by the cursor scan
        if (!task.acked.has(msg.chunkIdx)) {
          task.acked.add(msg.chunkIdx)
          task.doneBytes += Math.min(CHUNK_SIZE, file.size - msg.chunkIdx * CHUNK_SIZE)
        }
        if (task.acked.size >= file.totalChunks) {
          void this.completeSendFile(task, file)
        } else {
          this.pump(task)
        }
        return
      }
      case 'transfer_state': {
        const task = this.tasks.get(msg.taskId)
        if (!task) return
        if (task.kind === 'recv') {
          if (msg.state === 'paused') task.state = 'paused'
          else if (msg.state === 'resumed') task.state = 'active'
          else if (msg.state === 'cancelled') {
            task.state = 'cancelled'
            this.ctx.emitMain('transfer:cleanup', { taskId: task.taskId })
          } else if (msg.state === 'failed') {
            task.state = 'failed'
            task.error = msg.error ?? 'transfer failed'
            this.ctx.emitMain('transfer:cleanup', { taskId: task.taskId })
          } else if (msg.state === 'completed') {
            task.state = 'completed'
          }
          this.markDirty(task.roomId)
          return
        }
        // Send task: the RECEIVER reported its state. failed/cancelled
        // used to be ignored here (the guard only accepted recv tasks),
        // so the sender kept writing chunks into a transfer that had
        // already died on the other side.
        if (task.receiverKey !== fromKey) return
        if (msg.state === 'failed' || msg.state === 'cancelled') {
          task.state = msg.state
          task.error = msg.state === 'failed' ? (msg.error ?? 'transfer failed') : null
          this.clearInFlight(task)
          this.ctx.emitMain('transfer:cleanup', { taskId: task.taskId })
        } else if (msg.state === 'paused') {
          // Stop the pump and drop in-flight retries; 'resumed' re-pumps
          // from the first unacked chunk.
          task.state = 'paused'
          this.clearInFlight(task)
        } else if (msg.state === 'resumed') {
          task.state = 'active'
          this.pump(task)
        }
        this.markDirty(task.roomId)
        return
      }
      case 'transfer_cap': {
        const task = this.tasks.get(msg.taskId)
        if (task?.kind !== 'send') return
        task.capBps = msg.speedCapBps
        this.markDirty(task.roomId)
        return
      }
      case 'file_done': {
        const task = this.tasks.get(msg.taskId)
        if (task?.kind !== 'recv' || task.senderKey !== fromKey) return
        const room = this.roomOf(task.roomId)
        const peer = room?.peerOf(fromKey)
        void this.ctx
          .callMain<{ ok: boolean; error: string | null }>('transfer:finishFile', {
            taskId: msg.taskId,
            fileId: msg.fileId,
            sha256: msg.sha256,
            bytes: msg.bytes
          })
          .then((res) => {
            if (!res.ok) {
              task.state = 'failed'
              task.error = res.error ?? 'ERR: file integrity check failed'
              peer?.sendControl({ t: 'transfer_state', taskId: task.taskId, state: 'failed', error: task.error })
              this.ctx.emitMain('transfer:cleanup', { taskId: task.taskId })
              this.markDirty(task.roomId)
              return
            }
            task.filesDone++
            if (task.filesDone >= task.files.length) {
              task.state = 'completed'
              this.ctx.emitMain('transfer:cleanup', { taskId: task.taskId })
            }
            this.markDirty(task.roomId)
          })
          .catch(() => undefined)
        return
      }
      case 'task_update': {
        const me = this.ctx.myKeyHex
        if (msg.senderKey === me || msg.receiverKey === me) return
        const id = `${msg.roomId}:${msg.taskId}`
        this.remoteTasks.set(id, {
          taskId: msg.taskId,
          roomId: msg.roomId,
          senderKey: msg.senderKey,
          receiverKey: msg.receiverKey,
          total: msg.total,
          done: msg.done,
          fileCount: msg.fileCount,
          state: msg.state,
          updatedAt: Date.now()
        })
        this.markDirty(msg.roomId)
        return
      }
      case 'preview_request': {
        void this.servePreview(roomId, fromKey, msg.taskId, msg.fileId)
        return
      }
      case 'preview_meta': {
        const key = `${msg.taskId}:${msg.fileId}`
        if (msg.size > os.freemem() * PREVIEW_MEM_SAFETY) {
          this.ctx.emitMain('preview:received', { taskId: msg.taskId, fileId: msg.fileId, mime: '', size: msg.size, data: null, error: 'not_enough_memory' })
          this.pendingPreviews.delete(key)
          return
        }
        this.pendingPreviews.set(key, { mime: msg.mime, size: msg.size, parts: [], received: 0 })
        return
      }
      case 'preview_error': {
        this.ctx.emitMain('preview:received', {
          taskId: msg.taskId,
          fileId: msg.fileId,
          mime: '',
          size: 0,
          data: null,
          error: msg.code
        })
        return
      }
      default:
        return
    }
  }

  onBinary(_roomId: string, fromKey: string, frameType: number, header: Uint8Array, data: Uint8Array): void {
    if (frameType === FRAME_CHUNK) {
      const parsed = chunkHeaderSchema.safeParse(JSON.parse(Buffer.from(header).toString('utf8')))
      if (!parsed.success) return
      this.handleChunk(fromKey, parsed.data.taskId, parsed.data.fileId, parsed.data.chunkIdx, parsed.data.sha256, data)
      return
    }
    if (frameType === FRAME_PREVIEW) {
      const parsed = previewHeaderSchema.safeParse(JSON.parse(Buffer.from(header).toString('utf8')))
      if (!parsed.success) return
      const key = `${parsed.data.taskId}:${parsed.data.fileId}`
      const pending = this.pendingPreviews.get(key)
      if (!pending) return
      pending.parts.push(Buffer.from(data))
      pending.received += data.length
      if (parsed.data.eof) {
        this.pendingPreviews.delete(key)
        this.ctx.emitMain('preview:received', {
          taskId: parsed.data.taskId,
          fileId: parsed.data.fileId,
          mime: pending.mime,
          size: pending.size,
          data: new Uint8Array(Buffer.concat(pending.parts)),
          error: null
        })
      }
    }
  }

  // ---- internals: offers ----

  private async handleIncomingOffer(
    roomId: string,
    fromKey: string,
    msg: Extract<ControlMessage, { t: 'transfer_offer' }>
  ): Promise<void> {
    if (msg.receiverKey !== this.ctx.myKeyHex) return
    const room = this.roomOf(roomId)
    if (!room) return
    const existing = await this.ctx
      .callMain<{ files: { id: number; bitmap: string }[] } | null>('transfer:resumeState', { taskId: msg.taskId })
      .catch(() => null)
    if (existing) {
      // Already accepted previously (reconnect): auto-resume, no UI prompt.
      const task: RecvTask = {
        kind: 'recv',
        taskId: msg.taskId,
        roomId,
        senderKey: fromKey,
        label: msg.files.map((f) => f.relPath.split(/[\\/]/)[0]).slice(0, 3).join(', '),
        files: msg.files.map((f) => {
          const totalChunks = Peer.chunkCount(f.size)
          const bm = Buffer.alloc(Math.ceil(totalChunks / 8))
          const saved = existing.files.find((x) => x.id === f.id)?.bitmap
          if (saved) Buffer.from(saved, 'base64').copy(bm)
          return { id: f.id, relPath: f.relPath, size: f.size, risky: f.risky, totalChunks, bitmap: bm, beginPromise: null }
        }),
        totalSize: msg.totalSize,
        state: 'active',
        error: null,
        capBps: null,
        doneBytes: 0,
        filesDone: 0,
        speedSample: null,
        speedBps: 0
      }
      let done = 0
      for (const f of task.files) {
        for (let i = 0; i < f.totalChunks; i++) {
          if (f.bitmap[i >> 3] & (1 << (i & 7))) done += Math.min(CHUNK_SIZE, f.size - i * CHUNK_SIZE)
        }
      }
      task.doneBytes = done
      this.tasks.set(msg.taskId, task)
      const peer = room.peerOf(fromKey)
      peer?.sendControl({ t: 'transfer_response', taskId: msg.taskId, accept: true, speedCapBps: null })
      peer?.sendControl({
        t: 'transfer_resume',
        taskId: msg.taskId,
        files: task.files.map((f) => ({ id: f.id, bitmap: f.bitmap.toString('base64') }))
      })
      this.markDirty(roomId)
      return
    }
    if (this.tasks.has(msg.taskId) || this.pendingOffers.has(msg.taskId)) return
    const offer: OfferView = {
      taskId: msg.taskId,
      roomId,
      senderKey: fromKey,
      senderName: room.memberName(fromKey),
      files: msg.files.map((f) => ({ id: f.id, relPath: f.relPath, size: f.size, risky: f.risky })),
      totalSize: msg.totalSize,
      risky: msg.files.some((f) => f.risky)
    }
    this.pendingOffers.set(msg.taskId, { offer, senderKey: fromKey })
    this.ctx.emitMain('offer:incoming', { offer })
  }

  private sendOffer(task: SendTask, peer: Peer): void {
    const room = this.roomOf(task.roomId)
    peer.sendControl({
      t: 'transfer_offer',
      taskId: task.taskId,
      roomId: task.roomId,
      senderKey: this.ctx.myKeyHex,
      senderName: this.ctx.identity.name,
      receiverKey: task.receiverKey,
      files: task.files.map((f) => ({ id: f.id, relPath: f.relPath, size: f.size, risky: f.risky })),
      totalSize: task.totalSize
    })
    void room
  }

  // ---- internals: send pump ----

  private clearInFlight(task: SendTask): void {
    for (const timer of task.inFlight.values()) clearTimeout(timer)
    task.inFlight.clear()
    if (task.lockTimer) {
      clearTimeout(task.lockTimer)
      task.lockTimer = null
    }
  }

  private effectiveCap(task: SendTask): number | null {
    // Live values: the receiver's per-transfer cap and the local global
    // setting (changes apply mid-flight).
    const caps = [task.capBps, this.ctx.identity.maxSpeedBps].filter(
      (v): v is number => typeof v === 'number' && v > 0
    )
    return caps.length > 0 ? Math.min(...caps) : null
  }

  private pump(task: SendTask): void {
    if (task.pumping || task.state !== 'active' || !task.ready || task.kind !== 'send') return
    task.pumping = true
    try {
      this.pumpInner(task)
    } finally {
      task.pumping = false
    }
  }

  private pumpInner(task: SendTask): void {
    const room = this.roomOf(task.roomId)
    const peer = room?.peerOf(task.receiverKey)
    if (!peer || !peer.trusted) {
      // Unexpected connection drop: park the task (it auto-resumes when
      // the peer reappears — spec 8.8).
      if (task.state === 'active') {
        task.state = 'paused'
        this.markDirty(task.roomId)
      }
      return
    }
    const file = task.files[task.fileIdx]
    if (!file) return
    const cap = this.effectiveCap(task)
    const now = Date.now()
    if (cap) {
      const chunkLen = Math.min(CHUNK_SIZE, file.size - task.cursor * CHUNK_SIZE) || 1
      const minIntervalMs = (chunkLen / cap) * 1000
      const sinceLast = now - task.lastSendAt
      if (sinceLast < minIntervalMs) {
        setTimeout(() => this.pump(task), minIntervalMs - sinceLast)
        return
      }
    }
    while (task.inFlight.size < CHUNK_WINDOW) {
      // Advance the cursor past acked chunks.
      while (task.cursor < file.totalChunks && (task.acked.has(task.cursor) || task.inFlight.has(task.cursor))) {
        task.cursor++
      }
      if (task.cursor >= file.totalChunks) break
      const chunkIdx = task.cursor
      void this.ctx
        .callMain<{ data: Uint8Array | null; locked: boolean; error: string | null }>('transfer:needChunk', {
          taskId: task.taskId,
          fileId: file.id,
          chunkIdx
        })
        .then((res) => {
          // State read through a helper so TS narrowing doesn't fight the
          // waiting-lock transitions below.
          const st = (): TaskState => task.state
          if (!task.ready || (st() !== 'active' && st() !== 'waiting-lock')) return
          if (res.locked) {
            // Sender-side file locked by another process (spec 8.8): the
            // transfer of this file waits for the lock to clear.
            if (st() !== 'waiting-lock') {
              task.state = 'waiting-lock'
              this.markDirty(task.roomId)
            }
            if (!task.lockTimer) {
              task.lockTimer = setTimeout(() => {
                task.lockTimer = null
                if (task.state === 'waiting-lock') {
                  task.state = 'active'
                  this.pump(task)
                }
              }, 2_000)
            }
            return
          }
          if (st() === 'waiting-lock') {
            task.state = 'active'
            this.markDirty(task.roomId)
          }
          if (res.error || !res.data) {
            task.state = 'failed'
            task.error = res.error ?? 'read failed'
            this.clearInFlight(task)
            this.markDirty(task.roomId)
            return
          }
          const data = res.data
          const sha256 = crypto.createHash('sha256').update(data).digest('hex')
          const ok = peer.sendBinary(FRAME_CHUNK, { taskId: task.taskId, fileId: file.id, chunkIdx, sha256 }, data)
          if (!ok) return
          task.lastSendAt = Date.now()
          const timer = setTimeout(() => {
            task.inFlight.delete(chunkIdx)
            this.pump(task)
          }, ACK_TIMEOUT_MS)
          task.inFlight.set(chunkIdx, timer)
          this.pump(task)
        })
        .catch(() => undefined)
      return // async chunk fetch; pump resumes from the .then chain
    }
  }

  private async completeSendFile(task: SendTask, file: SendFile): Promise<void> {
    if (task.completing) return
    task.completing = true
    try {
      const room = this.roomOf(task.roomId)
      const peer = room?.peerOf(task.receiverKey)
      const hashRes = await this.ctx
        .callMain<{ sha256: string | null }>('transfer:hashFile', { taskId: task.taskId, fileId: file.id })
        .catch(() => ({ sha256: null }))
      if (!hashRes.sha256) {
        // Without the source hash the receiver can never verify this
        // file — skipping file_done used to leave its task "active"
        // forever.
        task.state = 'failed'
        task.error = 'cannot hash source file'
        this.clearInFlight(task)
        peer?.sendControl({ t: 'transfer_state', taskId: task.taskId, state: 'failed', error: task.error })
        this.ctx.emitMain('transfer:cleanup', { taskId: task.taskId })
        this.markDirty(task.roomId)
        return
      }
      peer?.sendControl({ t: 'file_done', taskId: task.taskId, fileId: file.id, sha256: hashRes.sha256, bytes: file.size })
      task.filesDone++
      task.fileIdx++
      task.acked.clear()
      task.cursor = 0
      if (task.filesDone >= task.files.length) {
        task.state = 'completed'
        peer?.sendControl({ t: 'transfer_state', taskId: task.taskId, state: 'completed', error: null })
        this.ctx.emitMain('transfer:cleanup', { taskId: task.taskId })
      } else {
        // The final ack of THIS file leaves nothing in flight, so nothing
        // else would ever restart the pump — kick it for the NEXT file.
        // Without this the task parked forever between files.
        this.pump(task)
      }
      this.markDirty(task.roomId)
    } finally {
      task.completing = false
    }
  }

  // ---- internals: receive ----

  private handleChunk(fromKey: string, taskId: string, fileId: number, chunkIdx: number, sha256: string, data: Uint8Array): void {
    const task = this.tasks.get(taskId)
    if (task?.kind !== 'recv' || task.senderKey !== fromKey) return
    // A failed/cancelled task must not process (and re-fail on) further
    // in-flight chunks from the sender.
    if (task.state === 'failed' || task.state === 'cancelled') return
    const room = this.roomOf(task.roomId)
    const peer = room?.peerOf(fromKey)
    if (!peer) return
    const file = task.files.find((f) => f.id === fileId)
    if (!file || chunkIdx >= file.totalChunks) return
    const actual = crypto.createHash('sha256').update(data).digest('hex')
    if (actual !== sha256) {
      peer.sendControl({ t: 'chunk_ack', taskId, fileId, chunkIdx, bad: true })
      return
    }
    if (file.bitmap[chunkIdx >> 3] & (1 << (chunkIdx & 7))) {
      peer.sendControl({ t: 'chunk_ack', taskId, fileId, chunkIdx, bad: false })
      return
    }
    // The destination file must be created and open before the first
    // write: main's beginFile resolves the safe path inside the receive
    // folder and keeps the fd. Memoized — the window's worth of
    // in-flight chunks of one file share a single begin round-trip.
    file.beginPromise ??= this.ctx
      .callMain<{ ok: boolean; error: string | null }>('transfer:beginFile', { taskId, fileId })
      .catch(() => ({ ok: false, error: 'cannot open destination file' }))
    void file.beginPromise
      .then((res) => {
        if (!res.ok) {
          task.state = 'failed'
          task.error = res.error ?? 'cannot open destination file'
          peer.sendControl({ t: 'transfer_state', taskId, state: 'failed', error: task.error })
          this.ctx.emitMain('transfer:cleanup', { taskId })
          this.markDirty(task.roomId)
          return
        }
        return this.ctx
          .callMain<{ ok: boolean; error: string | null }>('transfer:writeChunk', {
            taskId,
            fileId,
            chunkIdx,
            data
          })
          .then((res) => {
            if (!res.ok) {
              task.state = 'failed'
              task.error = res.error ?? 'write failed'
              peer.sendControl({ t: 'transfer_state', taskId, state: 'failed', error: task.error })
              this.ctx.emitMain('transfer:cleanup', { taskId })
              this.markDirty(task.roomId)
              return
            }
            file.bitmap[chunkIdx >> 3] |= 1 << (chunkIdx & 7)
            task.doneBytes += data.length
            peer.sendControl({ t: 'chunk_ack', taskId, fileId, chunkIdx, bad: false })
            this.markDirty(task.roomId)
          })
      })
      .catch(() => undefined)
  }

  private async servePreview(roomId: string, fromKey: string, taskId: string, fileId: number): Promise<void> {
    const room = this.roomOf(roomId)
    const peer = room?.peerOf(fromKey)
    if (!peer) return
    const res = await this.ctx
      .callMain<{ size: number; mime: string; data: Uint8Array | null; error: string | null }>('preview:readFile', {
        taskId,
        fileId
      })
      .catch(() => ({ size: 0, mime: '', data: null, error: 'unavailable' }))
    if (res.error || !res.data) {
      peer.sendControl({
        t: 'preview_error',
        taskId,
        fileId,
        code: res.error === 'ERR: not enough memory' ? 'not_enough_memory' : 'unavailable'
      })
      return
    }
    peer.sendControl({ t: 'preview_meta', taskId, fileId, size: res.size, mime: res.mime })
    const view = new Uint8Array(res.data)
    for (let seq = 0; seq * PREVIEW_PART < view.length || seq === 0; seq++) {
      const start = seq * PREVIEW_PART
      const part = view.subarray(start, Math.min(start + PREVIEW_PART, view.length))
      const eof = start + PREVIEW_PART >= view.length
      peer.sendBinary(FRAME_PREVIEW, { taskId, fileId, seq, eof }, part)
      if (eof) break
    }
  }

  // ---- snapshots (spec 8.6) ----

  private markDirty(roomId: string): void {
    this.dirtyRooms.add(roomId)
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      for (const id of this.dirtyRooms) this.flush(id)
      this.dirtyRooms.clear()
    }, 500)
  }

  private flush(roomId: string): void {
    const tasks = this.snapshot(roomId)
    this.ctx.emitMain('tasks:snapshot', { roomId, tasks })
    // Room-wide live task entries: throttled 1s broadcast of redacted
    // aggregates to every connected peer.
    const now = Date.now()
    const last = this.lastBroadcast.get(roomId) ?? 0
    if (now - last >= 1_000) {
      this.lastBroadcast.set(roomId, now)
      const room = this.roomOf(roomId)
      for (const task of tasks) {
        if (!task.participant) continue
        const local = this.tasks.get(task.taskId)
        if (!local) continue
        const senderKey = local.kind === 'send' ? this.ctx.myKeyHex : local.senderKey
        const receiverKey = local.kind === 'send' ? local.receiverKey : this.ctx.myKeyHex
        room?.broadcast({
          t: 'task_update',
          taskId: local.taskId,
          roomId,
          senderKey,
          receiverKey,
          total: local.totalSize,
          done: local.doneBytes,
          fileCount: local.files.length,
          state: local.state
        })
      }
    }
  }

  snapshot(roomId: string): TaskView[] {
    const room = this.roomOf(roomId)
    const out: TaskView[] = []
    const now = Date.now()
    for (const task of this.tasks.values()) {
      if (task.roomId !== roomId) continue
      const peerKey = task.kind === 'send' ? task.receiverKey : task.senderKey
      // Speed over the last sample window.
      if (task.speedSample && now - task.speedSample.ts > 3_000) {
        const dt = (now - task.speedSample.ts) / 1000
        if (dt > 0) task.speedBps = Math.max(0, Math.round((task.doneBytes - task.speedSample.bytes) / dt))
        task.speedSample = { ts: now, bytes: task.doneBytes }
      } else if (!task.speedSample) {
        task.speedSample = { ts: now, bytes: task.doneBytes }
      }
      out.push({
        taskId: task.taskId,
        roomId,
        direction: task.kind,
        peerKey,
        peerName: room?.memberName(peerKey) ?? peerKey.slice(0, 8),
        total: task.totalSize,
        done: task.doneBytes,
        fileCount: task.files.length,
        state: task.state,
        speedBps: task.speedBps,
        speedCapBps: task.kind === 'send' ? task.capBps : task.capBps,
        participant: true,
        label: task.label,
        error: task.error
      })
    }
    for (const remote of this.remoteTasks.values()) {
      if (remote.roomId !== roomId) continue
      if (now - remote.updatedAt > 10 * 60_000) {
        this.remoteTasks.delete(`${remote.roomId}:${remote.taskId}`)
        continue
      }
      out.push({
        taskId: remote.taskId,
        roomId,
        direction: 'other',
        peerKey: remote.receiverKey,
        peerName: room?.memberName(remote.senderKey) ?? 'peer',
        total: remote.total,
        done: remote.done,
        fileCount: remote.fileCount,
        state: remote.state,
        speedBps: 0,
        speedCapBps: null,
        participant: false,
        label: null,
        error: null
      })
    }
    return out
  }
}
