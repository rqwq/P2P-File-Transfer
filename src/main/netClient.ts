import { utilityProcess, type UtilityProcess } from 'electron'
import path from 'node:path'
import type { MainReply, MainToWorker, WorkerToMain } from '../shared/worker'

// Main-side client for the net worker (src/net/index.ts), which owns all
// networking and protocol parsing (spec 3: a protocol bug cannot reach
// window/menu/update code). Structured envelopes over MessagePort with
// request/response correlation.

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }

export class NetClient {
  // The worker is stateless — identity, trust, bans, rooms and transfer
  // state all re-seed from main when it reports ready — so an unexpected
  // worker exit is recoverable by respawning it. A crash-looping worker
  // must not spin forever, though.
  static readonly MAX_RESTARTS = 5

  private proc: UtilityProcess | null = null
  private pending = new Map<number, Pending>()
  private nextId = 1
  private eventHandlers = new Map<string, ((payload: unknown) => void)[]>()
  private logSink: ((level: string, msg: string) => void) | null = null
  private stopped = false
  private restarts = 0
  private respawnTimer: NodeJS.Timeout | null = null
  private onRespawn: (() => void) | null = null

  // Called after a respawn fork; main re-seeds the worker's identity
  // here (everything else re-seeds in the 'ready' handler).
  setOnRespawn(cb: () => void): void {
    this.onRespawn = cb
  }

  start(): void {
    if (this.proc) return
    this.stopped = false
    this.proc = utilityProcess.fork(path.join(__dirname, 'net.js'), [], {
      serviceName: 'p2p-net',
      stdio: 'inherit'
    })
    this.proc.on('message', (msg: WorkerToMain) => this.onMessage(msg))
    this.proc.on('exit', (code) => this.handleExit(code))
  }

  private handleExit(code: number): void {
    this.proc = null
    // A dead worker silently breaks everything (presence, joins,
    // transfers) — make it unmissable in the console.
    console.error(`[net] net worker EXITED (code ${code})`)
    const err = new Error(`net worker exited (code ${code})`)
    for (const p of this.pending.values()) {
      clearTimeout(p.timer)
      p.reject(err)
    }
    this.pending.clear()
    if (this.stopped) return
    if (this.respawnTimer) return
    if (this.restarts >= NetClient.MAX_RESTARTS) {
      console.error(`[net] worker crashed ${this.restarts} times — not respawning again, networking is down until app restart`)
      return
    }
    this.restarts++
    const delay = Math.min(1000 * this.restarts, 10_000)
    console.error(`[net] respawning net worker in ${delay}ms (restart ${this.restarts}/${NetClient.MAX_RESTARTS})`)
    this.respawnTimer = setTimeout(() => {
      this.respawnTimer = null
      this.start()
      this.onRespawn?.()
    }, delay)
  }

  setLogSink(sink: (level: string, msg: string) => void): void {
    this.logSink = sink
  }

  private onMessage(msg: WorkerToMain): void {
    if (msg.kind === 'reply') {
      const p = this.pending.get(msg.id)
      if (!p) return
      this.pending.delete(msg.id)
      clearTimeout(p.timer)
      if (msg.ok) p.resolve(msg.result)
      else p.reject(new Error(msg.error ?? 'worker request failed'))
      return
    }
    const handlers = this.eventHandlers.get(msg.kind)
    if (handlers) for (const h of handlers) h(msg)
    else if (this.logSink) this.logSink('warn', `unhandled worker message: ${msg.kind}`)
  }

  // Fire-and-forget send. NEVER throws on a missing worker: every call
  // happens mid-IPC-handler (chat, roles, bans, leaves) and a throw left
  // those handlers half-applied — the local DB write went through but
  // the UI refresh and the wire sync never ran, so e.g. a role change
  // looked like it silently did nothing. The message is dropped (with a
  // loud log) and the respawn supervisor brings the worker back.
  send(msg: MainToWorker): void {
    if (!this.proc) {
      this.logSink?.('error', `dropping '${msg.kind}' — net worker not running`)
      return
    }
    this.proc.postMessage(msg)
  }

  // Fire a request expecting a reply. Callers await this and surface the
  // rejection themselves, so an honest error is the right behavior here
  // (unlike send()).
  request<T = unknown>(msg: MainToWorker & { id?: number }, timeoutMs = 20_000): Promise<T> {
    if (!this.proc) return Promise.reject(new Error('net worker not started'))
    const id = msg.id ?? this.nextId++
    const envelope = { ...msg, id } as MainToWorker
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`worker request timed out: ${msg.kind}`))
      }, timeoutMs)
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer })
      this.proc!.postMessage(envelope)
    })
  }

  // Reply to a worker-initiated request (WorkerRequest), correlated by id.
  replyTo(id: number, ok: boolean, result: unknown): void {
    if (!this.proc) return
    this.proc.postMessage({ kind: 'reply', id, ok, result } satisfies MainReply)
  }

  on(kind: string, handler: (payload: never) => void): void {
    const list = this.eventHandlers.get(kind) ?? []
    list.push(handler as (payload: unknown) => void)
    this.eventHandlers.set(kind, list)
  }

  stop(): void {
    // Intentional shutdown (app quit): the exit it triggers must not
    // schedule a respawn.
    this.stopped = true
    if (this.respawnTimer) {
      clearTimeout(this.respawnTimer)
      this.respawnTimer = null
    }
    if (this.proc) {
      this.proc.kill()
      this.proc = null
    }
  }

  log(level: 'info' | 'warn' | 'error', msg: string): void {
    this.logSink?.(level, msg)
  }
}
