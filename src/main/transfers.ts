import { app } from 'electron'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { OfferView, PreviewMeta, TaskView } from '../shared/api'
import { CHUNK_SIZE, DISK_SAFETY_BYTES, PREVIEW_MEM_SAFETY, MAX_ATTACHMENT_BYTES } from '../shared/constants'
import {
  ensureDir,
  findFreeName,
  getFreeSpaceBytes,
  isRiskyExtension,
  resolveInsideRoot,
  writeMarkOfTheWeb
} from './fsSafety'
import { settings } from './settings'
import type { NetClient } from './netClient'

// Main-side transfer responsibilities (spec 8): building offers from the
// filesystem, all disk writes on the receiving side, checkpoint state,
// previews (whole-file-into-RAM, spec 8.3), and the room-wide task
// registry cache. The net worker owns the wire protocol, pacing and acks.

export interface OfferFile {
  id: number
  relPath: string
  size: number
  risky: boolean
}

interface SendTaskState {
  taskId: string
  roomId: string
  receiverKey: string
  label: string
  files: (OfferFile & { absPath: string })[]
  totalSize: number
}

interface RecvFileState {
  id: number
  relPath: string
  size: number
  risky: boolean
  finalPath: string | null
  doneBytes: number
  bitmap: string // base64, 1 bit per chunk
  totalChunks: number
  completed: boolean
}

interface RecvTaskState {
  taskId: string
  roomId: string
  senderKey: string
  label: string
  speedCapBps: number | null
  files: RecvFileState[]
  totalSize: number
}

export const TRANSFER_ERRORS = {
  NOT_CONNECTED: 'ERR: remote host not connected',
  NO_DISK_SPACE: 'ERR: remote host has insufficient disk space',
  NO_MEMORY: 'ERR: not enough memory',
  FOLDER_MISSING: 'ERR: receive folder does not exist',
  INTEGRITY: 'ERR: file integrity check failed',
  CANCELLED: 'cancelled'
} as const

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4', flac: 'audio/flac',
  txt: 'text/plain', md: 'text/plain', json: 'text/plain', log: 'text/plain',
  csv: 'text/plain', xml: 'text/plain', ini: 'text/plain'
}

export function mimeForFile(name: string): string | null {
  const dot = name.lastIndexOf('.')
  if (dot < 0) return null
  return MIME_BY_EXT[name.slice(dot + 1).toLowerCase()] ?? null
}

export class TransferManager {
  private net: NetClient | null = null
  private stateDir = ''
  private openHandles = new Map<string, number>() // `${taskId}:${fileId}` -> fd
  private pendingPreviews = new Map<string, (meta: PreviewMeta) => void>()
  private previewBuffers = new Map<string, { buf: Buffer; timer: NodeJS.Timeout }>()
  private taskCache = new Map<string, TaskView[]>()
  private offers = new Map<string, OfferView>()
  private pushEvent: ((roomId: string) => void) | null = null
  private onRecvComplete: ((taskId: string, label: string, roomId: string) => void) | null = null

  init(net: NetClient, pushTasks: (roomId: string) => void, onRecvComplete: (taskId: string, label: string, roomId: string) => void): void {
    this.net = net
    this.stateDir = path.join(app.getPath('userData'), 'transfers')
    fs.mkdirSync(this.stateDir, { recursive: true })
    this.pushEvent = pushTasks
    this.onRecvComplete = onRecvComplete
    this.registerWorkerHandlers()
  }

  // ---- state files ----

  private sendStatePath(taskId: string): string {
    return path.join(this.stateDir, `${taskId}.send.json`)
  }

  private recvStatePath(taskId: string): string {
    return path.join(this.stateDir, `${taskId}.recv.json`)
  }

  private readJson<T>(p: string): T | null {
    try {
      return JSON.parse(fs.readFileSync(p, 'utf8')) as T
    } catch {
      return null
    }
  }

  private writeJsonAtomic(p: string, data: unknown): void {
    const tmp = `${p}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(data))
    fs.renameSync(tmp, p)
  }

  listPersistedSends(): SendTaskState[] {
    const out: SendTaskState[] = []
    try {
      for (const name of fs.readdirSync(this.stateDir)) {
        if (!name.endsWith('.send.json')) continue
        const st = this.readJson<SendTaskState>(path.join(this.stateDir, name))
        if (st && Array.isArray(st.files) && st.files.length > 0) out.push(st)
      }
    } catch {
      // directory missing — nothing to reattach
    }
    return out
  }

  // ---- offer building (sender) ----

  async buildOffer(roomId: string, peerKey: string, paths: string[]): Promise<{ ok: boolean; error: string | null }> {
    if (paths.length === 0) return { ok: false, error: 'nothing selected' }
    const files: (OfferFile & { absPath: string })[] = []
    let id = 0
    for (const p of paths) {
      let stat
      try {
        stat = await fs.promises.stat(p)
      } catch {
        return { ok: false, error: `cannot access ${path.basename(p)}` }
      }
      if (stat.isFile()) {
        files.push({
          id: id++,
          relPath: path.basename(p),
          absPath: p,
          size: stat.size,
          risky: isRiskyExtension(p)
        })
      } else if (stat.isDirectory()) {
        const root = path.resolve(p)
        const walk = async (dir: string): Promise<string | null> => {
          let entries
          try {
            entries = await fs.promises.readdir(dir, { withFileTypes: true })
          } catch {
            return `cannot read folder ${dir}`
          }
          for (const e of entries) {
            const full = path.join(dir, e.name)
            if (e.isDirectory()) {
              const err = await walk(full)
              if (err) return err
            } else if (e.isFile()) {
              const s = await fs.promises.stat(full)
              files.push({
                id: id++,
                relPath: path.relative(root, full),
                absPath: full,
                size: s.size,
                risky: isRiskyExtension(e.name)
              })
            }
          }
          return null
        }
        const err = await walk(root)
        if (err) return { ok: false, error: err }
      }
    }
    if (files.length === 0) return { ok: false, error: 'no files found' }
    if (files.length > 10_000) return { ok: false, error: 'too many files' }

    const totalSize = files.reduce((a, f) => a + f.size, 0)
    const taskId = crypto.randomUUID()
    const label =
      paths.length === 1 ? path.basename(paths[0]) : `${files.length} items`
    const state: SendTaskState = { taskId, roomId, receiverKey: peerKey, label, files, totalSize }
    this.writeJsonAtomic(this.sendStatePath(taskId), state)
    this.net?.send({
      kind: 'transfer:offer',
      taskId,
      roomId,
      receiverKey: peerKey,
      files: files.map((f) => ({ id: f.id, relPath: f.relPath, size: f.size, risky: f.risky })),
      totalSize,
      label
    })
    return { ok: true, error: null }
  }

  // ---- receiving ----

  registerIncomingOffer(offer: OfferView): void {
    this.offers.set(offer.taskId, offer)
  }

  async respond(taskId: string, accept: boolean, speedCapBps: number | null): Promise<{ ok: boolean; error: string | null }> {
    const offer = this.offers.get(taskId)
    if (!offer) return { ok: false, error: 'unknown transfer' }
    if (!accept) {
      this.offers.delete(taskId)
      this.net?.send({ kind: 'transfer:respond', taskId, accept: false, speedCapBps: null, error: null })
      return { ok: true, error: null }
    }
    const receiveFolder = settings.get().receiveFolder
    if (!fs.existsSync(receiveFolder)) {
      this.offers.delete(taskId)
      this.net?.send({ kind: 'transfer:respond', taskId, accept: false, speedCapBps: null, error: TRANSFER_ERRORS.FOLDER_MISSING })
      return { ok: false, error: TRANSFER_ERRORS.FOLDER_MISSING }
    }
    const free = await getFreeSpaceBytes(receiveFolder)
    if (free < offer.totalSize + DISK_SAFETY_BYTES) {
      this.offers.delete(taskId)
      this.net?.send({ kind: 'transfer:respond', taskId, accept: false, speedCapBps: null, error: TRANSFER_ERRORS.NO_DISK_SPACE })
      return { ok: false, error: TRANSFER_ERRORS.NO_DISK_SPACE }
    }
    const state: RecvTaskState = {
      taskId,
      roomId: offer.roomId,
      senderKey: offer.senderKey,
      label: offer.files.map((f) => f.relPath.split(/[\\/]/)[0]).slice(0, 3).join(', '),
      speedCapBps,
      totalSize: offer.totalSize,
      files: offer.files.map((f) => {
        const totalChunks = Math.max(1, Math.ceil(f.size / CHUNK_SIZE))
        return {
          id: f.id,
          relPath: f.relPath,
          size: f.size,
          risky: f.risky,
          finalPath: null,
          doneBytes: 0,
          bitmap: Buffer.alloc(Math.ceil(totalChunks / 8)).toString('base64'),
          totalChunks,
          completed: false
        }
      })
    }
    this.persistRecv(state)
    this.offers.delete(taskId)
    this.net?.send({ kind: 'transfer:respond', taskId, accept: true, speedCapBps, error: null })
    return { ok: true, error: null }
  }

  private recvCache = new Map<string, RecvTaskState>()

  private persistRecv(state: RecvTaskState): void {
    this.recvCache.set(state.taskId, state)
    this.writeJsonAtomic(this.recvStatePath(state.taskId), state)
  }

  getRecvState(taskId: string): RecvTaskState | null {
    const cached = this.recvCache.get(taskId)
    if (cached) return cached
    const st = this.readJson<RecvTaskState>(this.recvStatePath(taskId))
    if (st) this.recvCache.set(taskId, st)
    return st
  }

  private bitmapOf(file: RecvFileState): Buffer {
    return Buffer.from(file.bitmap, 'base64')
  }

  // Worker asks for resume info before auto-accepting a re-offer.
  resumeState(taskId: string): { files: { id: number; bitmap: string }[] } | null {
    const st = this.getRecvState(taskId)
    if (!st) return null
    return { files: st.files.map((f) => ({ id: f.id, bitmap: f.bitmap })) }
  }

  private fdKey(taskId: string, fileId: number): string {
    return `${taskId}:${fileId}`
  }

  beginFile(taskId: string, fileId: number): { ok: boolean; error: string | null } {
    const st = this.getRecvState(taskId)
    if (!st) return { ok: false, error: 'unknown transfer state' }
    const file = st.files.find((f) => f.id === fileId)
    if (!file) return { ok: false, error: 'unknown file' }
    const receiveFolder = settings.get().receiveFolder
    if (!fs.existsSync(receiveFolder)) return { ok: false, error: TRANSFER_ERRORS.FOLDER_MISSING }

    if (!file.finalPath) {
      const safe = resolveInsideRoot(receiveFolder, file.relPath)
      if (!safe.ok) return { ok: false, error: safe.error ?? 'unsafe path' }
      const dir = path.dirname(safe.absolutePath)
      try {
        ensureDir(dir)
      } catch {
        return { ok: false, error: 'cannot create destination folder' }
      }
      const freeName = findFreeName(dir, path.basename(safe.relPath))
      file.finalPath = path.join(dir, freeName)
      this.persistRecv(st)
    }
    try {
      if (!fs.existsSync(file.finalPath)) fs.writeFileSync(file.finalPath, '')
      const fd = fs.openSync(file.finalPath, 'r+')
      this.openHandles.set(this.fdKey(taskId, fileId), fd)
    } catch {
      return { ok: false, error: 'cannot open destination file' }
    }
    return { ok: true, error: null }
  }

  writeChunk(taskId: string, fileId: number, chunkIdx: number, data: Uint8Array): { ok: boolean; error: string | null } {
    const st = this.getRecvState(taskId)
    if (!st) return { ok: false, error: 'unknown transfer state' }
    const file = st.files.find((f) => f.id === fileId)
    if (!file) return { ok: false, error: 'unknown file' }
    if (chunkIdx >= file.totalChunks) return { ok: false, error: 'chunk out of range' }
    if (data.length > CHUNK_SIZE) return { ok: false, error: 'chunk too large' }
    const key = this.fdKey(taskId, fileId)
    let fd = this.openHandles.get(key)
    if (fd === undefined) {
      if (!file.finalPath) return { ok: false, error: 'file not begun' }
      try {
        fd = fs.openSync(file.finalPath, 'r+')
        this.openHandles.set(key, fd)
      } catch {
        return { ok: false, error: TRANSFER_ERRORS.FOLDER_MISSING }
      }
    }
    try {
      fs.writeSync(fd, data, 0, data.length, chunkIdx * CHUNK_SIZE)
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (code === 'ENOSPC') return { ok: false, error: TRANSFER_ERRORS.NO_DISK_SPACE }
      return { ok: false, error: 'write failed' }
    }
    const buf = this.bitmapOf(file)
    const byteIdx = chunkIdx >> 3
    const bit = 1 << (chunkIdx & 7)
    if (buf.length <= byteIdx) return { ok: false, error: 'bitmap corrupted' }
    const alreadySet = (buf[byteIdx] & bit) !== 0
    if (!alreadySet) {
      buf[byteIdx] |= bit
      file.bitmap = buf.toString('base64')
      file.doneBytes = Math.min(file.size, file.doneBytes + data.length)
      this.persistRecv(st)
    }
    return { ok: true, error: null }
  }

  async finishFile(taskId: string, fileId: number, sha256: string, bytes: number): Promise<{ ok: boolean; error: string | null }> {
    const st = this.getRecvState(taskId)
    if (!st) return { ok: false, error: 'unknown transfer state' }
    const file = st.files.find((f) => f.id === fileId)
    if (!file || !file.finalPath) return { ok: false, error: 'file not begun' }
    const key = this.fdKey(taskId, fileId)
    const fd = this.openHandles.get(key)
    if (fd !== undefined) {
      try {
        fs.closeSync(fd)
      } catch {
        // already closed
      }
      this.openHandles.delete(key)
    }
    // Verify the whole-file hash on disk before declaring victory.
    const actual = await this.hashFile(file.finalPath)
    if (actual !== sha256 || file.size !== bytes) {
      file.completed = false
      this.persistRecv(st)
      return { ok: false, error: TRANSFER_ERRORS.INTEGRITY }
    }
    file.completed = true
    this.persistRecv(st)
    writeMarkOfTheWeb(file.finalPath)
    if (st.files.every((f) => f.completed)) {
      this.onRecvComplete?.(taskId, st.label, st.roomId)
      try {
        fs.unlinkSync(this.recvStatePath(taskId))
      } catch {
        // already gone
      }
    }
    return { ok: true, error: null }
  }

  private async hashFile(p: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const hash = crypto.createHash('sha256')
      const stream = fs.createReadStream(p)
      stream.on('data', (d) => hash.update(d))
      stream.on('end', () => resolve(hash.digest('hex')))
      stream.on('error', reject)
    })
  }

  cancelRecv(taskId: string): void {
    for (const key of [...this.openHandles.keys()]) {
      if (key.startsWith(`${taskId}:`)) {
        const fd = this.openHandles.get(key)
        if (fd !== undefined) {
          try {
            fs.closeSync(fd)
          } catch {
            // already closed
          }
        }
        this.openHandles.delete(key)
      }
    }
  }

  // ---- sender-side chunk source ----

  private sendTaskOf(taskId: string): SendTaskState | null {
    return this.readJson<SendTaskState>(this.sendStatePath(taskId))
  }

  async needChunk(taskId: string, fileId: number, chunkIdx: number): Promise<{ data: Uint8Array | null; locked: boolean; error: string | null }> {
    const st = this.sendTaskOf(taskId)
    if (!st) return { data: null, locked: false, error: 'unknown send task' }
    const file = st.files.find((f) => f.id === fileId)
    if (!file) return { data: null, locked: false, error: 'unknown file' }
    if (chunkIdx * CHUNK_SIZE >= file.size && file.size > 0) return { data: null, locked: false, error: 'chunk out of range' }
    const key = this.fdKey(taskId, fileId)
    let fd = this.openHandles.get(key)
    if (fd === undefined) {
      try {
        fd = fs.openSync(file.absPath, 'r')
        this.openHandles.set(key, fd)
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code
        if (code === 'EBUSY' || code === 'EPERM') {
          // File locked by another process on the sender's machine (spec
          // 8.8): the transfer waits for the lock to clear.
          return { data: null, locked: true, error: null }
        }
        return { data: null, locked: false, error: 'cannot read source file' }
      }
    }
    const len = Math.min(CHUNK_SIZE, file.size - chunkIdx * CHUNK_SIZE)
    const buf = Buffer.allocUnsafe(len)
    try {
      fs.readSync(fd, buf, 0, len, chunkIdx * CHUNK_SIZE)
    } catch {
      return { data: null, locked: false, error: 'read failed' }
    }
    return { data: new Uint8Array(buf), locked: false, error: null }
  }

  dropSendFileHandle(taskId: string, fileId: number): void {
    const key = this.fdKey(taskId, fileId)
    const fd = this.openHandles.get(key)
    if (fd !== undefined) {
      try {
        fs.closeSync(fd)
      } catch {
        // already closed
      }
      this.openHandles.delete(key)
    }
  }

  async hashForSend(taskId: string, fileId: number): Promise<string | null> {
    const st = this.sendTaskOf(taskId)
    const file = st?.files.find((f) => f.id === fileId)
    if (!st || !file) return null
    try {
      return await this.hashFile(file.absPath)
    } catch {
      return null
    }
  }

  dropTaskHandles(taskId: string): void {
    this.cancelRecv(taskId)
  }

  // ---- previews (spec 8.3: whole file into RAM) ----

  async requestPreview(taskId: string, fileId: number): Promise<PreviewMeta> {
    const offer = this.offers.get(taskId)
    const file = offer?.files.find((f) => f.id === fileId)
    if (!file) return { previewId: '', taskId, fileId, mime: '', size: 0, error: 'unavailable' }
    // Receiver-side RAM check with a safety margin.
    if (file.size > os.freemem() * PREVIEW_MEM_SAFETY) {
      return { previewId: '', taskId, fileId, mime: '', size: file.size, error: TRANSFER_ERRORS.NO_MEMORY }
    }
    return new Promise<PreviewMeta>((resolve) => {
      const key = `${taskId}:${fileId}`
      this.pendingPreviews.set(key, resolve)
      this.net?.send({ kind: 'preview:request', taskId, fileId })
      setTimeout(() => {
        const pending = this.pendingPreviews.get(key)
        if (pending) {
          this.pendingPreviews.delete(key)
          pending({ previewId: '', taskId, fileId, mime: '', size: 0, error: 'preview timed out' })
        }
      }, 60_000)
    })
  }

  handlePreviewReceived(taskId: string, fileId: number, mime: string, size: number, data: Uint8Array | null, error: string | null): void {
    const key = `${taskId}:${fileId}`
    const resolve = this.pendingPreviews.get(key)
    if (!resolve) return
    this.pendingPreviews.delete(key)
    if (error) {
      resolve({
        previewId: '',
        taskId,
        fileId,
        mime: '',
        size,
        error: error === 'not_enough_memory' ? TRANSFER_ERRORS.NO_MEMORY : 'unavailable'
      })
      return
    }
    if (!data) {
      resolve({ previewId: '', taskId, fileId, mime: '', size: 0, error: 'unavailable' })
      return
    }
    const previewId = crypto.randomUUID()
    const timer = setTimeout(() => this.closePreview(previewId), 10 * 60_000)
    this.previewBuffers.set(previewId, { buf: Buffer.from(data), timer })
    resolve({ previewId, taskId, fileId, mime, size, error: null })
  }

  readPreview(previewId: string): ArrayBuffer | null {
    const entry = this.previewBuffers.get(previewId)
    if (!entry) return null
    const out = new ArrayBuffer(entry.buf.length)
    entry.buf.copy(new Uint8Array(out))
    return out
  }

  closePreview(previewId: string): void {
    const entry = this.previewBuffers.get(previewId)
    if (!entry) return
    clearTimeout(entry.timer)
    this.previewBuffers.delete(previewId)
    // Memory is released once the preview is closed (spec 8.3).
  }

  // sender side of a preview request
  async readPreviewForSend(taskId: string, fileId: number): Promise<{ size: number; mime: string; data: Uint8Array | null; error: string | null }> {
    const st = this.sendTaskOf(taskId)
    const file = st?.files.find((f) => f.id === fileId)
    if (!st || !file) return { size: 0, mime: '', data: null, error: 'unavailable' }
    const mime = mimeForFile(file.absPath)
    if (!mime) return { size: file.size, mime: '', data: null, error: 'unavailable' }
    if (file.size > MAX_ATTACHMENT_BYTES * 200) return { size: file.size, mime, data: null, error: TRANSFER_ERRORS.NO_MEMORY }
    if (file.size > os.freemem() * PREVIEW_MEM_SAFETY) {
      return { size: file.size, mime, data: null, error: TRANSFER_ERRORS.NO_MEMORY }
    }
    try {
      const data = await fs.promises.readFile(file.absPath)
      return { size: file.size, mime, data: new Uint8Array(data), error: null }
    } catch {
      return { size: file.size, mime, data: null, error: 'unavailable' }
    }
  }

  // ---- task registry cache (worker is authoritative for live state) ----

  cacheTasks(roomId: string, tasks: TaskView[]): void {
    this.taskCache.set(roomId, tasks)
    this.pushEvent?.(roomId)
  }

  tasksFor(roomId: string): TaskView[] {
    return this.taskCache.get(roomId) ?? []
  }

  offerOf(taskId: string): OfferView | null {
    return this.offers.get(taskId) ?? null
  }

  // ---- worker wiring ----

  private registerWorkerHandlers(): void {
    const net = this.net
    if (!net) return
    net.on('transfer:beginFile', (msg: { taskId: string; fileId: number; id: number }) => {
      const res = this.beginFile(msg.taskId, msg.fileId)
      this.reply(msg.id, res.ok, res)
    })
    net.on('transfer:writeChunk', (msg: { taskId: string; fileId: number; chunkIdx: number; data: Uint8Array; id: number }) => {
      const res = this.writeChunk(msg.taskId, msg.fileId, msg.chunkIdx, msg.data)
      this.reply(msg.id, res.ok, res)
    })
    net.on('transfer:needChunk', (msg: { taskId: string; fileId: number; chunkIdx: number; id: number }) => {
      void this.needChunk(msg.taskId, msg.fileId, msg.chunkIdx).then((res) => {
        this.reply(msg.id, !res.error && res.data !== null, res)
      })
    })
    net.on('transfer:resumeState', (msg: { taskId: string; id: number }) => {
      const res = this.resumeState(msg.taskId)
      this.reply(msg.id, true, res)
    })
    net.on('transfer:finishFile', (msg: { taskId: string; fileId: number; sha256: string; bytes: number; id: number }) => {
      void this.finishFile(msg.taskId, msg.fileId, msg.sha256, msg.bytes).then((res) => {
        this.reply(msg.id, res.ok, res)
      })
    })
    net.on('transfer:hashFile', (msg: { taskId: string; fileId: number; id: number }) => {
      void this.hashForSend(msg.taskId, msg.fileId).then((res) => {
        this.reply(msg.id, res !== null, { sha256: res })
      })
    })
    net.on('preview:readFile', (msg: { taskId: string; fileId: number; id: number }) => {
      void this.readPreviewForSend(msg.taskId, msg.fileId).then((res) => {
        this.reply(msg.id, res.error === null, res)
      })
    })
    net.on('preview:received', (msg: { taskId: string; fileId: number; mime: string; size: number; data: Uint8Array | null; error: string | null }) => {
      this.handlePreviewReceived(msg.taskId, msg.fileId, msg.mime, msg.size, msg.data, msg.error)
    })
    net.on('tasks:snapshot', (msg: { roomId: string; tasks: TaskView[] }) => {
      this.cacheTasks(msg.roomId, msg.tasks)
    })
    net.on('offer:incoming', (msg: { offer: OfferView }) => {
      this.registerIncomingOffer(msg.offer)
    })
  }

  private reply(id: number, ok: boolean, result: unknown): void {
    this.net?.replyTo(id, ok, result)
  }
}
