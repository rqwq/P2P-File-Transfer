import crypto from 'node:crypto'
import type SecretStream from '@hyperswarm/secret-stream'
import b4a from 'b4a'
import { encodeRoomCode, decodeRoomCode } from '../shared/roomCode'
import { DEFAULT_CHAT_LIMITS, isAppModHwid, PROTOCOL_VERSION, RESERVED_HASH_B64 } from '../shared/constants'
import type { ControlMessage } from '../shared/protocol'
import type { WireBanEntry, WireMember, WireRoomSettings } from '../shared/worker'
import type { NetContext } from './context'
import { Peer } from './peer'
import { startVpnListener, connectVpnTo, stopVpn } from './vpnTcp'

// A room's live networking state: the swarm topic, connected peers, the
// roster mirror (authoritative on the creator), chat sync and every
// control-message flow. The protocol layer above is transport-agnostic —
// peers arrive from the DHT swarm or the VPN TCP listener identically.

const JOIN_TIMEOUT_MS = 45_000

// Build identity advertised in hello/join_request (baked in by the
// vite `define`; 'dev' when it isn't, which is safe to advertise).
export const BUILD_ID = typeof __BUILD_STAMP__ === 'string' ? __BUILD_STAMP__ : 'dev'

// The owner's reserved HWID — always an official app moderator.
const RESERVED_HWID = Buffer.from(RESERVED_HASH_B64, 'base64').toString('utf8')

export class RoomNet {
  readonly ctx: NetContext
  readonly roomId: string
  readonly code: string
  readonly creatorKey: string
  readonly isCreator: boolean
  settings: WireRoomSettings
  members = new Map<string, WireMember>()
  peers = new Map<string, Peer>()
  private discovery: { refresh: (o: { server?: boolean; client?: boolean }) => Promise<unknown> | void; destroy: () => unknown } | null = null
  private closed = false
  private suspended = false
  // Leave mode (banned installs on boot): every peer that connects gets a
  // member_left goodbye, then the room closes itself.
  private leaving = false
  // Keys dialed via swarm.joinPeer — must be leavePeer'd on teardown or
  // hyperswarm keeps reconnecting to them forever.
  private dialed = new Set<string>()
  private syncCandidates = new Map<string, { missing: string[]; overlap: number; rtt: number }>()
  private myManifest: [string, number][] = []
  private syncTimer: NodeJS.Timeout | null = null
  private pendingAttachments = new Map<string, (blob: Uint8Array) => void>()
  vpnPort: number | null = null

  constructor(ctx: NetContext, opts: { roomId: string; code: string; creatorKey: string; isCreator: boolean; settings: WireRoomSettings }) {
    this.ctx = ctx
    this.roomId = opts.roomId
    this.code = opts.code
    this.creatorKey = opts.creatorKey
    this.isCreator = opts.isCreator
    this.settings = opts.settings
  }

  static topicOf(code: string): Buffer {
    return crypto.createHash('sha256').update(`p2pft-room:${code}`).digest()
  }

  static idOfCreatorKey(creatorKeyHex: string): string {
    return creatorKeyHex
  }

  // ---- lifecycle ----

  async announce(asServer: boolean): Promise<void> {
    const topic = RoomNet.topicOf(this.code)
    if (this.discovery) {
      // hyperswarm 4's discovery session has refresh(), not update() —
      // calling a missing method here made every re-announce (e.g. a
      // member flipping to server after admission) throw and silently
      // skip announcing.
      await this.discovery.refresh({ server: asServer, client: true })
    } else {
      this.discovery = this.ctx.swarm.join(topic, { server: asServer, client: true })
    }
    if (this.settings.transport === 'vpn') {
      const port = await startVpnListener(this, this.settings.vpnIp)
      this.vpnPort = port
    }
  }

  async connectTo(keyHex: string): Promise<void> {
    const key = Buffer.from(keyHex, 'hex')
    this.dialed.add(keyHex)
    try {
      // hyperswarm 4 has no swarm.connect() — the direct-dial API is
      // joinPeer(key). The connection arrives on 'connection' with no
      // topic, so the worker routes it by remote key (see net/index.ts).
      this.ctx.swarm.joinPeer(key)
    } catch (err) {
      this.ctx.log('warn', `connect to ${keyHex.slice(0, 8)} failed: ${(err as Error).message}`)
    }
  }

  private dropDialed(): void {
    for (const key of this.dialed) {
      try {
        this.ctx.swarm.leavePeer(Buffer.from(key, 'hex'))
      } catch {
        // already gone
      }
    }
    this.dialed.clear()
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    for (const peer of this.peers.values()) peer.close()
    this.peers.clear()
    this.dropDialed()
    if (this.discovery) {
      try {
        this.discovery.destroy()
      } catch {
        // already destroyed
      }
      this.discovery = null
    }
    try {
      this.ctx.swarm.leave(RoomNet.topicOf(this.code))
    } catch {
      // not joined
    }
    stopVpn(this)
  }

  isClosed(): boolean {
    return this.closed
  }

  // ---- availability (user "go offline" toggle) ----
  // Suspend keeps the room object (roster, settings, sync state) but
  // tears down every connection and stops announcing — the user is
  // unreachable: no chat, no incoming transfer offers, no joins. Resume
  // re-announces and reconnects to the known roster.

  suspend(): void {
    if (this.closed || this.suspended) return
    this.suspended = true
    for (const peer of this.peers.values()) peer.close()
    this.peers.clear()
    this.dropDialed()
    if (this.discovery) {
      try {
        this.discovery.destroy()
      } catch {
        // already destroyed
      }
      this.discovery = null
    }
    try {
      this.ctx.swarm.leave(RoomNet.topicOf(this.code))
    } catch {
      // not joined
    }
    stopVpn(this)
  }

  async resume(): Promise<void> {
    if (this.closed || !this.suspended) return
    this.suspended = false
    await this.announce(this.isCreator)
    if (this.isCreator) {
      for (const m of this.members.values()) {
        if (m.key !== this.ctx.myKeyHex) void this.connectTo(m.key)
      }
    } else {
      void this.connectTo(this.creatorKey)
    }
  }

  isSuspended(): boolean {
    return this.suspended
  }

  // Leave mode: this machine is banned and only came online to say
  // goodbye. registerPeer sends member_left to everyone who connects
  // (whichever side dialed), and after the grace window the room closes
  // itself for good — no further traffic, no presence.
  startLeaving(): void {
    if (this.closed || this.leaving) return
    this.leaving = true
    setTimeout(() => {
      try {
        this.close()
      } catch {
        // already closed
      }
    }, 12_000)
  }

  setMembers(members: WireMember[]): void {
    this.members.clear()
    for (const m of members) this.members.set(m.key, m)
  }

  // ---- peer attachment (swarm + vpn both land here) ----

  attachPeer(socket: SecretStream, remoteKey: Buffer | null): Peer {
    const keyHex = remoteKey ? b4a.toString(remoteKey, 'hex') : ''
    if (this.suspended) {
      // User is "offline": unreachable by design — drop the socket before
      // any protocol exchange can happen.
      try {
        socket.destroy()
      } catch {
        // already dead
      }
      throw new Error('room suspended (offline)')
    }
    // NOTE: banned keys are NO LONGER destroyed on attach. Destroying the
    // socket here meant a banned user could never learn WHY — their join
    // died silently with "rejected banned peer" on our side and no ban
    // screen on theirs. The socket is attached and the join flow answers
    // with the full ban entry (see handleJoinRequest); anything other
    // than a join attempt from a banned key is cut in onControl.
    const trusted = keyHex !== '' && this.ctx.trusted.has(keyHex)
    const peer = new Peer(socket, this.roomId, remoteKey, trusted)
    if (keyHex) this.registerPeer(peer)
    peer.on('hello', (p, msg) => {
      if (!p.key) this.registerPeer(p)
      this.ctx.emitMain('presence', { roomId: this.roomId, key: p.key, online: true, ip: p.ip })
      this.sendVpnInfo(p)
      if (!msg || !msg.key) return
      // Build check: a roster member advertising a different wire
      // protocol version is running a modified build. Report to main
      // (only the creator enforces) and broadcast the report once —
      // receivers must never re-broadcast it.
      if (msg.pv !== PROTOCOL_VERSION && this.members.has(msg.key)) {
        this.ctx.emitMain('untrust:report', {
          roomId: this.roomId,
          targetKey: msg.key,
          theirPv: msg.pv,
          theirBid: msg.bid
        })
        this.broadcastAll({
          t: 'untrust_report',
          roomId: this.roomId,
          targetKey: msg.key,
          theirPv: msg.pv,
          theirBid: msg.bid
        })
      }
      // Application-center sync on contact: the creator pushes its merged
      // log to staff and pulls their locally captured rows; staff push
      // their rows to the creator.
      const member = this.members.get(msg.key)
      const isStaff = member !== undefined && (member.role === 'admin' || member.role === 'moderator')
      if (this.isCreator && isStaff) {
        void this.pushAppSync(p)
        p.sendControl({ t: 'app_sync_request', roomId: this.roomId })
      } else if (!this.isCreator && msg.key === this.creatorKey) {
        void this.pushAppSync(p)
      }
    })
    peer.on('closed', (p) => {
      if (this.peers.get(p.key) === p) this.peers.delete(p.key)
      if (p.key) {
        this.ctx.emitMain('presence', { roomId: this.roomId, key: p.key, online: false, ip: null })
      }
    })
    peer.on('control', (p, msg) => this.onControl(p, msg))
    peer.on('binary', (p, frame) => this.onBinary(p, frame))
    peer.on('protocolError', (p, err) => {
      this.ctx.log('warn', `protocol error from ${p.key.slice(0, 8) || 'unknown'}: ${err.message}`)
    })
    // Identify ourselves immediately.
    peer.sendControl({
      t: 'hello',
      v: 1,
      key: this.ctx.myKeyHex,
      name: this.ctx.identity.name,
      hwid: this.ctx.identity.hwid,
      room: this.roomId,
      pv: PROTOCOL_VERSION,
      bid: BUILD_ID
    })
    // Trust-on-first-use prompt for unknown keys (spec 6): the joiner's
    // connection to the creator is anchored by the room code itself, so
    // the creator's key never prompts on the joiner side.
    if (keyHex && !trusted && keyHex !== this.creatorKey) {
      const knownMember = this.members.get(keyHex)
      this.ctx.emitMain('trust:prompt', {
        prompt: {
          key: keyHex,
          name: knownMember?.name ?? 'new peer',
          roomId: this.roomId,
          kind: knownMember ? 'peer' : 'peer'
        }
      })
    }
    if (keyHex === this.creatorKey && this.isCreator) {
      // Reconnect ping for offline moderator bans (spec 7.2): ask any
      // reconnecting moderator to push its cached entries.
      const member = this.members.get(keyHex)
      if (member && member.role === 'moderator') {
        peer.sendControl({ t: 'ban_sync_request', roomId: this.roomId })
      }
    }
    if (!this.isCreator && keyHex === this.creatorKey) {
      // A reconnecting creator is also pinged by its members.
      peer.sendControl({ t: 'ban_sync_request', roomId: this.roomId })
    }
    return peer
  }

  private registerPeer(peer: Peer): void {
    const existing = this.peers.get(peer.key)
    if (existing && existing !== peer) existing.close()
    this.peers.set(peer.key, peer)
    if (this.leaving) {
      // Leave mode (banned install boot): every peer that connects —
      // whichever side dialed — is told this member is gone, and the
      // room closes itself after a grace window.
      peer.sendControl({ t: 'member_left', roomId: this.roomId, key: this.ctx.myKeyHex })
    }
    this.onPeerAdded(peer)
    this.ctx.onPeerConnected?.(this.roomId, peer.key)
  }

  private onPeerAdded(peer: Peer): void {
    // Kick off chat sync by exchanging manifests (spec 9).
    void this.ctx
      .callMain<{ entries: [string, number][] }>('chat:getManifest', { roomId: this.roomId })
      .then((res) => {
        this.myManifest = res.entries ?? []
        if (peer.trusted) peer.sendControl({ t: 'chat_manifest', roomId: this.roomId, entries: this.myManifest })
      })
      .catch(() => undefined)
  }

  broadcast(msg: ControlMessage): void {
    for (const peer of this.peers.values()) {
      if (peer.trusted) peer.sendControl(msg)
    }
  }

  // Reach EVERY connected peer, trusted or not — used for messages that
  // must not depend on TOFU state (leaving, untrust reports, app bans).
  broadcastAll(msg: ControlMessage): void {
    for (const peer of this.peers.values()) peer.sendControl(msg)
  }

  // Push this machine's application rows to a staff/creator peer.
  pushAppSync(peer: Peer): void {
    void this.ctx
      .callMain<{
        entries: {
          applicantKey: string
          name: string
          hwid: string
          status: 'pending' | 'approved' | 'rejected'
          reason: string | null
          decidedByName: string | null
          decidedAt: number | null
          createdAt: number
          pv: number | null
          bid: string | null
        }[]
      }>('mod:applications', { roomId: this.roomId })
      .then((res) => {
        peer.sendControl({
          t: 'app_sync',
          roomId: this.roomId,
          entries: (res.entries ?? []).map((e) => ({
            applicantKey: e.applicantKey,
            name: e.name,
            hwid: e.hwid,
            status: e.status,
            reason: e.reason,
            decidedByName: e.decidedByName,
            decidedAt: e.decidedAt,
            createdAt: e.createdAt,
            pv: e.pv ?? undefined,
            bid: e.bid ?? undefined
          }))
        })
      })
      .catch(() => undefined)
  }

  peerOf(key: string): Peer | undefined {
    return this.peers.get(key)
  }

  trustedKeys(): string[] {
    const out: string[] = []
    for (const [key, peer] of this.peers) if (peer.trusted) out.push(key)
    return out
  }

  markTrusted(key: string): void {
    const peer = this.peers.get(key)
    if (peer) peer.markTrusted()
  }

  memberName(key: string): string {
    return this.members.get(key)?.name ?? key.slice(0, 8)
  }

  sendVpnInfo(peer: Peer): void {
    if (this.settings.transport !== 'vpn' || !this.settings.vpnIp || !this.vpnPort) return
    peer.sendControl({ t: 'vpn_info', roomId: this.roomId, ip: this.settings.vpnIp, port: this.vpnPort })
  }

  // ---- inbound control routing ----

  private onControl(peer: Peer, msg: ControlMessage): void {
    // Banned keys may only ever attempt a join — which handleJoinRequest
    // answers with the full ban entry so their app can show the ban
    // screen. Everything else from a banned key is IGNORED, not cut: the
    // joiner's automatic sync messages (chat manifest, roster pulls)
    // arrive BEFORE its join_request (first sent as soon as the creator
    // is reachable) — closing on them meant the join_request never got
    // through and the banned user never learned why. The idle watchdog
    // still closes the connection if they never attempt a join.
    if (
      this.ctx.localBans.has(`${this.roomId}:${peer.key}`) &&
      msg.t !== 'hello' &&
      msg.t !== 'join_request' &&
      msg.t !== 'ping' &&
      msg.t !== 'pong'
    ) {
      return
    }
    switch (msg.t) {
      case 'join_request': {
        if (this.isCreator) {
          void this.handleJoinRequest(peer, msg)
          return
        }
        // Staff members record the application for the center (synced to
        // the creator); regular members ignore it. Answering "not the
        // room creator" here used to insta-fail the applicant's join.
        const me = this.members.get(this.ctx.myKeyHex)
        if (me && (me.role === 'admin' || me.role === 'moderator')) {
          this.ctx.emitMain('app:submitted', {
            roomId: this.roomId,
            applicant: {
              key: peer.key,
              name: msg.name,
              hwid: msg.hwid,
              ip: peer.ip ?? '',
              pv: msg.pv,
              bid: msg.bid
            }
          })
        }
        return
      }
      case 'join_accept':
      case 'join_reject':
        // Handled by the join flow in the worker entry.
        this.ctx.emitMain('joinWire', { roomId: this.roomId, fromKey: peer.key, msg })
        return
      case 'roster_update': {
        if (peer.key !== this.creatorKey) {
          this.ctx.log('warn', `roster_update from non-creator ${peer.key.slice(0, 8)} ignored`)
          return
        }
        this.settings = msg.room
        this.setMembers(msg.members)
        this.ctx.emitMain('roster', { roomId: this.roomId, members: msg.members, settings: msg.room })
        return
      }
      case 'presence':
        return
      case 'chat': {
        if (!this.chatAllowed(msg)) return
        if (msg.msg.attachment) {
          // The attachment binary frame follows the control message.
          const wait = new Promise<Uint8Array | null>((resolve) => {
            const timer = setTimeout(() => {
              this.pendingAttachments.delete(msg.msg.id)
              resolve(null)
            }, 30_000)
            this.pendingAttachments.set(msg.msg.id, (blob) => {
              clearTimeout(timer)
              resolve(blob)
            })
          })
          void wait.then((blob) => {
            this.ctx.emitMain('chat:message', {
              roomId: this.roomId,
              senderKey: peer.key,
              senderName: msg.senderName,
              msg: msg.msg,
              blob
            })
          })
        } else {
          this.ctx.emitMain('chat:message', {
            roomId: this.roomId,
            senderKey: peer.key,
            senderName: msg.senderName,
            msg: msg.msg,
            blob: null
          })
        }
        return
      }
      case 'chat_manifest': {
        const theirs = new Map(msg.entries)
        const mine = new Set(this.myManifest.map(([id]) => id))
        const missing: string[] = []
        let overlap = 0
        for (const [id] of theirs) {
          if (mine.has(id)) overlap++
          else missing.push(id)
        }
        if (missing.length > 0) {
          this.syncCandidates.set(peer.key, { missing, overlap, rtt: peer.rtt })
          this.scheduleSync()
        }
        return
      }
      case 'chat_pull': {
        void this.ctx
          .callMain<{ id: string; ts: number; text: string; attachment: { name: string; mime: string; size: number } | null; blob: Uint8Array | null }[]>(
            'chat:pullBatch',
            { roomId: this.roomId, ids: msg.ids.slice(0, 5000) }
          )
          .then((messages) => {
            const sendable = messages
            const BATCH = 200
            for (let i = 0; i < sendable.length; i += BATCH) {
              const batch = sendable.slice(i, i + BATCH)
              peer.sendControl({
                t: 'chat_messages',
                roomId: this.roomId,
                senderKey: this.ctx.myKeyHex,
                senderName: this.ctx.identity.name,
                messages: batch.map((m) => ({
                  id: m.id,
                  ts: m.ts,
                  text: m.text,
                  attachment: m.attachment
                })),
                attachmentIds: batch.filter((m) => m.blob).map((m) => m.id)
              })
              for (const m of batch) {
                if (m.blob) peer.sendChatAttachment(m.id, m.attachment?.size ?? m.blob.length, m.blob)
              }
            }
          })
          .catch(() => undefined)
        return
      }
      case 'chat_messages': {
        // Assemble blobs for attachments, then hand the batch to main.
        const blobs = new Map<string, Uint8Array>()
        let pending = msg.attachmentIds.length
        if (pending === 0) {
          this.storeChatBatch(peer, msg, blobs)
          return
        }
        const timer = setTimeout(() => this.storeChatBatch(peer, msg, blobs), 30_000)
        const collect = (chatId: string): void => {
          this.pendingAttachments.set(chatId, (blob) => {
            blobs.set(chatId, blob)
            this.pendingAttachments.delete(chatId)
            if (blobs.size >= msg.attachmentIds.length) {
              clearTimeout(timer)
              this.storeChatBatch(peer, msg, blobs)
            }
          })
        }
        for (const id of msg.attachmentIds) collect(id)
        return
      }
      case 'transfer_offer':
      case 'transfer_response':
      case 'transfer_state':
      case 'transfer_resume':
      case 'chunk_ack':
      case 'file_done':
      case 'transfer_cap':
      case 'task_update':
      case 'tasks_cleared':
      case 'preview_request':
      case 'preview_meta':
      case 'preview_error':
        this.ctx.emitMain('transferWire', { roomId: this.roomId, fromKey: peer.key, msg })
        return
      case 'suspect': {
        // Staff suspicion, relayed: rows are append-only per machine; the
        // badge comes from the rebuilt room state.
        this.ctx.emitMain('suspect:received', {
          roomId: this.roomId,
          targetKey: msg.targetKey,
          targetHwid: msg.targetHwid,
          reason: msg.reason ?? null,
          byName: msg.byName,
          marked: msg.marked === true
        })
        return
      }
      case 'ban': {
        const entry = msg.entry as WireBanEntry
        if (entry.targetKey === this.ctx.myKeyHex) {
          this.ctx.emitMain('banned', {
            roomId: this.roomId,
            ban: {
              reason: entry.reason,
              adminName: entry.adminName,
              adminKey: entry.adminKey,
              expiresAt: entry.expiresAt
            }
          })
          // Delayed close: a join-time ban reply is followed by the
          // join_reject on the same socket — destroying the peer in the
          // same tick would discard it and the join would die with a
          // misleading timeout instead of the ban verdict.
          setTimeout(() => this.close(), 500)
          return
        }
        this.ctx.localBans.add(`${this.roomId}:${entry.targetKey}`)
        const target = this.peers.get(entry.targetKey)
        if (target) target.close()
        this.ctx.emitMain('ban:applied', { roomId: this.roomId, entry })
        return
      }
      case 'unban': {
        this.ctx.localBans.delete(`${this.roomId}:${msg.targetKey}`)
        this.ctx.emitMain('ban:removed', { roomId: this.roomId, targetKey: msg.targetKey })
        return
      }
      case 'ban_sync_request': {
        // I am a moderator: push my cached outbox to the creator (7.2).
        const me = this.members.get(this.ctx.myKeyHex)
        if (me && (me.role === 'moderator' || me.role === 'creator')) {
          void this.ctx
            .callMain<WireBanEntry[]>('mod:outbox', { roomId: this.roomId })
            .then((entries) => {
              if (entries.length > 0) peer.sendControl({ t: 'ban_sync', roomId: this.roomId, entries })
            })
            .catch(() => undefined)
        }
        return
      }
      case 'ban_sync': {
        this.ctx.emitMain('ban:sync', { roomId: this.roomId, entries: msg.entries })
        return
      }
      case 'role_change': {
        const member = this.members.get(msg.key)
        if (member) this.members.set(msg.key, { ...member, role: msg.role })
        this.ctx.emitMain('role:changed', { roomId: this.roomId, key: msg.key, role: msg.role })
        return
      }
      case 'member_left': {
        // The leaver disappears from the mirror immediately; the creator
        // removes them from the authoritative roster and re-broadcasts.
        this.members.delete(msg.key)
        const gone = this.peers.get(msg.key)
        if (gone) gone.close()
        this.ctx.emitMain('member:left', { roomId: this.roomId, key: msg.key })
        return
      }
      case 'app_sync_request': {
        // Only the room creator may pull a staff member's local list.
        if (!this.isCreator && peer.key === this.creatorKey) void this.pushAppSync(peer)
        return
      }
      case 'app_sync': {
        // Staff rows → creator (merge + enforce) or the creator's log →
        // staff (local mirror). Never re-broadcast.
        this.ctx.emitMain('app:sync', { roomId: this.roomId, entries: msg.entries })
        return
      }
      case 'untrust_report': {
        // Only the creator's main enforces; the detector already
        // broadcast this once, so never forward it again.
        this.ctx.emitMain('untrust:report', {
          roomId: this.roomId,
          targetKey: msg.targetKey,
          theirPv: msg.theirPv,
          theirBid: msg.theirBid
        })
        return
      }
      case 'app_ban': {
        // Issuer identity is verified by their hello-carried HWID against
        // the hardcoded app-moderator identity (reserved owner + list).
        // Every receiver persists the entry, re-broadcasts it, and — if
        // it targets this machine — suspends all networking (main blocks
        // the UI on top).
        if (!isAppModHwid(peer.remoteHwid, RESERVED_HWID)) return
        this.ctx.emitMain('appBan:received', {
          entry: {
            targetKey: msg.targetKey,
            hwid: msg.hwid,
            reason: msg.reason,
            byName: msg.byName,
            byHwid: msg.byHwid,
            until: msg.until,
            issuedAt: msg.issuedAt
          }
        })
        this.broadcastAll(msg)
        if (msg.hwid === this.ctx.identity.hwid) {
          // Self-targeted: leave every group BEFORE the connections go
          // down — the peers connected right now (one of them relayed this
          // ban) are the only chance to tell the groups this member is
          // gone. The suspend is DELAYED: destroying the sockets in the
          // same tick discards the buffered writes and the leave message
          // never reaches anyone (the app-banned member then stays in
          // everyone's roster — exactly what the leave is for).
          for (const room of this.ctx.rooms.values()) {
            const r = room as unknown as RoomNet
            r.broadcastAll({ t: 'member_left', roomId: r.roomId, key: this.ctx.myKeyHex })
            setTimeout(() => r.suspend(), 500)
          }
        }
        return
      }
      case 'invite': {
        if (msg.targetKey === this.ctx.myKeyHex) {
          this.ctx.emitMain('invite:received', {
            roomId: msg.roomId,
            roomName: msg.roomName,
            code: msg.code,
            from: msg.from,
            fromKey: peer.key
          })
        } else {
          // Queue for relay: whoever sees the target online next delivers.
          this.ctx.emitMain('invite:relay', {
            roomId: msg.roomId,
            roomName: msg.roomName,
            code: msg.code,
            from: msg.from,
            fromKey: peer.key,
            targetKey: msg.targetKey
          })
        }
        return
      }
      case 'ping':
        peer.sendControl({ t: 'pong', nonce: msg.nonce })
        return
      case 'pong':
        return
      case 'vpn_info': {
        if (this.settings.transport !== 'vpn') return
        // Establish the direct TCP-over-VPN connection to this peer.
        const myIp = this.settings.vpnIp
        connectVpnTo(this, msg.ip, msg.port, peer.key, myIp)
        return
      }
      case 'hello':
        return
    }
  }

  private storeChatBatch(
    peer: Peer,
    msg: Extract<ControlMessage, { t: 'chat_messages' }>,
    blobs: Map<string, Uint8Array>
  ): void {
    const messages = msg.messages.map((m) => ({
      id: m.id,
      ts: m.ts,
      text: m.text,
      attachment: m.attachment,
      blob: m.attachment && blobs.has(m.id) ? (blobs.get(m.id) as Uint8Array) : null
    }))
    void this.ctx
      .callMain('chat:storeMessages', {
        roomId: this.roomId,
        senderKey: peer.key,
        senderName: msg.senderName,
        messages
      })
      .catch(() => undefined)
  }

  private chatAllowed(msg: Extract<ControlMessage, { t: 'chat' }>): boolean {
    const limits = this.settings.chatLimits ?? DEFAULT_CHAT_LIMITS
    if (msg.msg.text.length > limits.textLength + 400) return false
    const att = msg.msg.attachment
    if (att) {
      if (att.mime.startsWith('image/') && att.size > limits.imageBytes) return false
      if (att.mime.startsWith('video/') && att.size > limits.videoBytes) return false
      if (att.mime.startsWith('audio/') && att.size > limits.audioBytes) return false
      if (att.size > 10 * 1024 * 1024) return false
    }
    return true
  }

  private onBinary(peer: Peer, frame: { type: number; header: Buffer; data: Buffer }): void {
    if (frame.type === 0x12) {
      try {
        const header = JSON.parse(frame.header.toString('utf8')) as { chatId: string }
        const resolver = this.pendingAttachments.get(header.chatId)
        if (resolver) {
          resolver(new Uint8Array(frame.data))
        }
      } catch {
        this.ctx.log('warn', 'bad attachment frame')
      }
      return
    }
    // Chunk/preview frames belong to the transfer engine.
    this.ctx.emitMain('transferBinary', { roomId: this.roomId, fromKey: peer.key, frameType: frame.type, header: frame.header, data: frame.data })
  }

  // ---- chat sync scheduling (spec 9): greatest overlap, lowest ping ----

  private scheduleSync(): void {
    if (this.syncTimer) clearTimeout(this.syncTimer)
    this.syncTimer = setTimeout(() => this.runSync(), 1_500)
  }

  private runSync(): void {
    this.syncTimer = null
    if (this.syncCandidates.size === 0) return
    let best: { key: string; missing: string[]; overlap: number; rtt: number } | null = null
    for (const [key, cand] of this.syncCandidates) {
      if (!best || cand.overlap > best.overlap || (cand.overlap === best.overlap && cand.rtt < best.rtt)) {
        best = { key, ...cand }
      }
    }
    if (!best) return
    const peer = this.peers.get(best.key)
    if (peer && peer.trusted && best.missing.length > 0) {
      const ids = best.missing.splice(0, 2000)
      peer.sendControl({ t: 'chat_pull', roomId: this.roomId, ids })
      this.syncCandidates.set(best.key, { ...best, missing: best.missing })
      if (best.missing.length > 0) this.scheduleSync()
    } else {
      this.syncCandidates.delete(best.key)
      this.scheduleSync()
    }
  }

  // ---- creator-side join admission ----

  private async handleJoinRequest(peer: Peer, msg: Extract<ControlMessage, { t: 'join_request' }>): Promise<void> {
    const decoded = decodeRoomCode(msg.code)
    if (!decoded || b4a.toString(decoded, 'hex') !== this.ctx.myKeyHex) {
      peer.sendControl({ t: 'join_reject', reason: 'invalid room code', ban: null })
      return
    }
    const res = await this.ctx
      .callMain<{
        allow: boolean
        reason: string
        ban: import('../shared/worker').WireBanEntry | null
      }>(
        'mod:admitJoin',
        {
          roomId: this.roomId,
          joiner: {
            key: peer.key,
            name: msg.name,
            hwid: msg.hwid,
            ip: peer.ip ?? '',
            pv: msg.pv,
            bid: msg.bid
          },
          reason: msg.reason ?? ''
        }
      )
      .catch(() => ({ allow: false, reason: 'admission failed', ban: null }))
    if (res.allow) {
      const me = this.members.get(this.ctx.myKeyHex)
      const joinerMember: WireMember = {
        key: peer.key,
        name: msg.name,
        role: 'member',
        hwid: msg.hwid,
        joinedAt: Date.now(),
        lastSeen: Date.now()
      }
      this.members.set(peer.key, joinerMember)
      this.ctx.trusted.add(peer.key)
      peer.markTrusted()
      peer.sendControl({
        t: 'join_accept',
        roomId: this.roomId,
        room: this.settings,
        members: [...this.members.values()]
      })
      this.broadcast({
        t: 'roster_update',
        roomId: this.roomId,
        room: this.settings,
        members: [...this.members.values()]
      })
      if (me) this.ctx.log('info', `${msg.name} joined (instant)`)
      return
    }
    if (res.ban) {
      // Banned applicant: the full ban entry goes on the wire FIRST —
      // their app renders it as the blocking ban screen with the reason,
      // issuer and countdown. The join_reject that follows is the
      // join-button feedback. The close is delayed so both messages
      // flush (destroying the socket in the same tick discards them).
      peer.sendControl({ t: 'ban', roomId: this.roomId, entry: res.ban })
      peer.sendControl({
        t: 'join_reject',
        reason: res.reason,
        ban: { reason: res.ban.reason, adminName: res.ban.adminName, expiresAt: res.ban.expiresAt }
      })
      this.ctx.log('info', `rejected banned applicant ${peer.key.slice(0, 8)}`)
      setTimeout(() => peer.close(), 1_000)
      return
    }
    peer.sendControl({ t: 'join_reject', reason: res.reason, ban: null })
  }

  // ---- membership helpers used by the worker entry ----

  selfMember(): WireMember {
    const me = this.members.get(this.ctx.myKeyHex)
    return (
      me ?? {
        key: this.ctx.myKeyHex,
        name: this.ctx.identity.name,
        role: this.isCreator ? 'creator' : 'member',
        hwid: this.ctx.identity.hwid,
        joinedAt: Date.now(),
        lastSeen: Date.now()
      }
    )
  }

  buildCode(): string {
    return encodeRoomCode(this.ctx.keyPair.publicKey)
  }
}

export { JOIN_TIMEOUT_MS }
