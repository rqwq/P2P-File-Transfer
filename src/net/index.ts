// Net worker entry (utilityProcess). All networking and protocol parsing
// live here, isolated from the window/menu/update code (spec 3/11).
// Communicates with the main process through structured envelopes;
// every inbound *wire* message is Zod-validated before use.

import HyperDHT from 'hyperdht'
import Hyperswarm from 'hyperswarm'
import b4a from 'b4a'
import { MAX_CONNECTIONS_TOTAL, DEFAULT_CHAT_LIMITS, PROTOCOL_VERSION } from '../shared/constants'
import { encodeRoomCode, decodeRoomCode } from '../shared/roomCode'
import type { WireBanEntry, WireMember, WireRoomSettings } from '../shared/worker'
import type { NetContext } from './context'
import { RoomNet, BUILD_ID, JOIN_TIMEOUT_MS } from './room'
import { TransferEngine } from './transferEngine'
import { stopVpn, startVpnListener } from './vpnTcp'

interface PendingReply {
  resolve: (v: unknown) => void
  reject: (e: Error) => void
  timer: NodeJS.Timeout
}

interface Envelope {
  kind: string
  id?: number
  [key: string]: unknown
}

const port = (
  process as unknown as {
    parentPort: {
      on(event: 'message', listener: (e: { data: Envelope }) => void): void
      postMessage(msg: unknown): void
    }
  }
).parentPort

// First thing after fork: prove the worker module loaded at all. If this
// line never appears in the app console, the worker process died before
// or during load — that is why presence and joins both go silent.
post('net:log', { level: 'info', msg: 'net worker starting…' })

const pendingReplies = new Map<number, PendingReply>()
let nextId = 1

function post(kind: string, payload: Record<string, unknown>): void {
  port.postMessage({ kind, ...payload })
}

function callMain<T = unknown>(kind: string, payload: Record<string, unknown>): Promise<T> {
  const id = nextId++
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingReplies.delete(id)
      reject(new Error(`main request timed out: ${kind}`))
    }, 30_000)
    pendingReplies.set(id, { resolve: resolve as (v: unknown) => void, reject, timer })
    port.postMessage({ kind, id, ...payload })
  })
}

function replyMain(id: number, ok: boolean, result: unknown): void {
  port.postMessage({ kind: 'reply', id, ok, result })
}

const identity = { name: 'unknown', hwid: '', maxSpeedBps: null as number | null }
let swarm: Hyperswarm | null = null
let engine: TransferEngine | null = null
// User availability: false = every room is suspended (no connections, no
// announces, all dials rejected) so peers can't reach us at all.
let available = true
const topicToRoom = new Map<string, string>()
const joinWaiters = new Map<
  string,
  {
    resolve: (v: { ok: boolean; pending?: boolean; error: string | null; ban: { reason: string; adminName: string; expiresAt: number | null } | null }) => void
    timer: NodeJS.Timeout
  }
>()
// sendJoin intervals per pending/in-flight join, cleared when a decision
// arrives or the application room is torn down.
const joinTimers = new Map<string, NodeJS.Timeout>()

const ctx: NetContext = {
  keyPair: { publicKey: Buffer.alloc(32), secretKey: Buffer.alloc(64) },
  myKeyHex: '',
  identity,
  swarm: null as unknown as Hyperswarm,
  trusted: new Set<string>(),
  localBans: new Set<string>(),
  rooms: new Map<string, import('./context').RoomRef>(),
  callMain: <T,>(kind: string, payload: Record<string, unknown>) => callMain<T>(kind, payload),
  emitMain: (kind: string, payload: Record<string, unknown>) => {
    // Worker-internal wire events are routed locally; everything else
    // goes to the main process.
    if (kind === 'joinWire' || kind === 'transferWire' || kind === 'transferBinary') {
      routeWireEvent(kind, payload)
      return
    }
    post(kind, payload)
  },
  log: (level, msg) => post('net:log', { level, msg })
}

function getRoom(roomId: string): RoomNet | undefined {
  return ctx.rooms.get(roomId) as unknown as RoomNet | undefined
}

// Route an inbound/established swarm connection to its room. Receiving-side
// connections arrive with EMPTY topics (hyperswarm's _handleServerConnection
// upserts the peer without topic info), so topic matching only works for
// our own client-side dials. Chain: topic -> known roster/creator key ->
// the single creator-mode room (join attempts are the one flow where
// strangers dial our identity key, and roomId === creatorKey means there
// is at most one such room).
function roomForConnection(info: { publicKey?: Buffer | null; topic?: Buffer; topics?: Buffer[] }): RoomNet | undefined {
  const topics = info.topic ? [info.topic] : (info.topics ?? [])
  for (const t of topics) {
    const roomId = topicToRoom.get(b4a.toString(t, 'hex'))
    const room = roomId ? getRoom(roomId) : undefined
    if (room) return room
  }
  const remote = info.publicKey ? b4a.toString(info.publicKey, 'hex') : ''
  if (remote) {
    for (const room of ctx.rooms.values()) {
      const r = room as unknown as RoomNet
      if (r.creatorKey === remote || r.members.has(remote) || r.peerOf(remote)) return r
    }
    for (const room of ctx.rooms.values()) {
      const r = room as unknown as RoomNet
      if (r.isCreator && !r.isClosed() && !r.isSuspended()) return r
    }
  }
  return undefined
}

function defaultSettings(transport: 'dht' | 'vpn', vpnIp: string | null, name = ''): WireRoomSettings {
  return {
    name,
    memberCap: null,
    chatLimits: { ...DEFAULT_CHAT_LIMITS },
    transport,
    vpnIp,
    vpnPort: null
  }
}

function boot(keyPairFromMain: { publicKey: string; secretKey: string } | null): void {
  const kp = keyPairFromMain
    ? {
        publicKey: Buffer.from(keyPairFromMain.publicKey, 'hex'),
        secretKey: Buffer.from(keyPairFromMain.secretKey, 'hex')
      }
    : HyperDHT.keyPair()

  if (!keyPairFromMain) {
    post('keypair:created', {
      publicKey: kp.publicKey.toString('hex'),
      secretKey: kp.secretKey.toString('hex')
    })
  }
  ctx.keyPair = kp
  ctx.myKeyHex = kp.publicKey.toString('hex')

  swarm = new Hyperswarm({
    keyPair: kp,
    maxConnections: MAX_CONNECTIONS_TOTAL,
    // Fall back to a DHT relay when hole-punching fails (VPN adapters,
    // symmetric NATs). Direct punch is still tried first; the relay sees
    // only end-to-end-encrypted traffic.
    relayThrough: true
  })
  ctx.swarm = swarm
  // Network-level diagnostic: joins fail silently with "could not reach
  // the creator" when the public DHT itself is unreachable (UDP blocked
  // by the network). This line separates that from app bugs.
  void (swarm as unknown as { dht: { ready(): Promise<void> } }).dht.ready().then(
    () => ctx.log('info', 'DHT bootstrapped — public DHT reachable'),
    () => ctx.log('error', 'DHT bootstrap FAILED — public DHT unreachable (is UDP blocked on this network?)')
  )
  swarm.on('connection', (socket, info) => {
    const room = roomForConnection(info)
    if (!room) {
      // Connection on a topic/peer we no longer care about.
      try {
        socket.destroy()
      } catch {
        // already dead
      }
      return
    }
    try {
      room.attachPeer(socket, info.publicKey ?? null)
    } catch {
      // banned or otherwise rejected — socket already destroyed
    }
  })

  engine = new TransferEngine(ctx)
  ctx.onPeerConnected = (roomId, key) => engine?.onPeerConnected(roomId, key)

  post('ready', { publicKey: ctx.myKeyHex })
}

// The rooms forward wire control messages here via emitMain; join and
// transfer flows are worker-internal, everything else reaches main.
function routeWireEvent(kind: string, payload: Record<string, unknown>): void {
  const roomId = payload.roomId as string
  if (kind === 'joinWire') {
    const fromKey = String(payload.fromKey ?? '')
    const msg = payload.msg as
      | { t: 'join_accept'; roomId: string; room: WireRoomSettings; members: import('../shared/worker').WireMember[] }
      | { t: 'join_reject'; reason: string; ban: { reason: string; adminName: string; expiresAt: number | null } | null }
    const room = getRoom(roomId)
    // Only the creator's identity is anchored by the room code — its key
    // is the only one allowed to answer a join. Everyone else on the
    // topic could be an uninvited announcer.
    if (!room || fromKey !== room.creatorKey) {
      ctx.log('warn', `join: ignored decision from non-creator ${fromKey.slice(0, 8)}`)
      return
    }
    const waiter = joinWaiters.get(roomId)
    if (msg.t === 'join_accept') {
      joinWaiters.delete(roomId)
      const t = joinTimers.get(roomId)
      if (t) {
        clearInterval(t)
        joinTimers.delete(roomId)
      }
      if (waiter) {
        clearTimeout(waiter.timer)
        waiter.resolve({ ok: true, pending: false, error: null, ban: null })
      }
      room.settings = msg.room
      room.setMembers(msg.members)
      void room.announce(true)
      for (const m of msg.members) {
        if (m.key !== ctx.myKeyHex) void room.connectTo(m.key)
      }
      post('room:state', { roomId, code: room.code, settings: msg.room, isCreator: false })
      post('roster', { roomId, members: msg.members, settings: msg.room })
      ctx.log('info', `join: admitted to room ${roomId.slice(0, 8)}`)
      return
    }
    joinWaiters.delete(roomId)
    const t = joinTimers.get(roomId)
    if (t) {
      clearInterval(t)
      joinTimers.delete(roomId)
    }
    const error = msg.ban ? `you are banned from this room — ${msg.ban.reason || 'no reason given'}` : msg.reason
    if (waiter) {
      clearTimeout(waiter.timer)
      waiter.resolve({ ok: false, pending: false, error, ban: msg.ban })
    }
    ctx.log('warn', `join rejected: ${error ?? 'unknown reason'}`)
    // A rejected application tears the room back down; main marks the
    // pending card with the typed-out reason.
    topicToRoom.delete(b4a.toString(RoomNet.topicOf(room.code), 'hex'))
    room.close()
    ctx.rooms.delete(roomId)
    return
  }
  if (kind === 'transferWire') {
    engine?.onWireControl(roomId, payload.fromKey as string, payload.msg as never)
    return
  }
  if (kind === 'transferBinary') {
    engine?.onBinary(
      roomId,
      payload.fromKey as string,
      payload.frameType as number,
      payload.header as Uint8Array,
      payload.data as Uint8Array
    )
    return
  }
}

// The join-request loop: re-sends the request while the creator is
// reachable but has not answered. Joins are instant (the creator answers
// allow/reject as soon as the request lands), so this only covers the
// network-contact window — no staff prompt is involved anymore.
function startJoinCycle(room: RoomNet, code: string, reason: string): NodeJS.Timeout {
  let joinAnnounced = false
  return setInterval(() => {
    const peer = room.peerOf(room.creatorKey)
    if (peer) {
      if (!joinAnnounced) {
        joinAnnounced = true
        ctx.log('info', `join: creator reachable, sending join request (${room.roomId.slice(0, 8)})`)
      }
      peer.sendControl({
        t: 'join_request',
        code,
        key: ctx.myKeyHex,
        name: identity.name,
        hwid: identity.hwid,
        pv: PROTOCOL_VERSION,
        bid: BUILD_ID,
        reason
      })
    }
  }, 3_000)
}

function teardownJoin(room: RoomNet): void {
  const t = joinTimers.get(room.roomId)
  if (t) {
    clearInterval(t)
    joinTimers.delete(room.roomId)
  }
  topicToRoom.delete(b4a.toString(RoomNet.topicOf(room.code), 'hex'))
  room.close()
  ctx.rooms.delete(room.roomId)
}

function joinRoom(
  code: string,
  reason: string
): Promise<{ ok: boolean; pending?: boolean; error: string | null; ban: { reason: string; adminName: string; expiresAt: number | null } | null }> {
  const decoded = decodeRoomCode(code)
  if (!decoded) {
    return Promise.resolve({ ok: false, error: 'That code does not look like a room code.', ban: null })
  }
  if (!available) {
    return Promise.resolve({ ok: false, error: 'You are offline — go online to join rooms.', ban: null })
  }
  const creatorKey = b4a.toString(decoded, 'hex')
  const roomId = creatorKey
  // The creator's key is anchored by the room code itself (TOFU-by-code,
  // spec 6): trust it up front. Without this the creator's peer is
  // untrusted on the joiner side and peer.ts would queue join_accept as
  // an untrusted control frame — the admission answer can never arrive
  // and the join times out even though the creator admitted you.
  ctx.trusted.add(creatorKey)
  if (ctx.rooms.has(roomId)) {
    // Already joining, or already a member.
    if (joinTimers.has(roomId)) {
      return Promise.resolve({
        ok: false,
        error: 'Already joining this room — wait for the answer.',
        ban: null
      })
    }
    return Promise.resolve({ ok: true, error: null, ban: null })
  }
  const room = new RoomNet(ctx, {
    roomId,
    code: code.trim(),
    creatorKey,
    isCreator: false,
    settings: defaultSettings('dht', null)
  })
  ctx.rooms.set(roomId, room)
  topicToRoom.set(b4a.toString(RoomNet.topicOf(code.trim()), 'hex'), roomId)
  const waiter = new Promise<{ ok: boolean; pending?: boolean; error: string | null; ban: { reason: string; adminName: string; expiresAt: number | null } | null }>((resolve) => {
    const timer = setTimeout(() => {
      joinWaiters.delete(roomId)
      // Instant joins: there is no staff decision to wait for. If the
      // creator never answered within the window, the join failed —
      // tear the half-open room down and say so.
      teardownJoin(room)
      ctx.log('warn', `join: could not reach the room creator (${roomId.slice(0, 8)})`)
      resolve({
        ok: false,
        error: 'Could not reach the room creator — they may be offline.',
        ban: null
      })
    }, JOIN_TIMEOUT_MS)
    joinWaiters.set(roomId, { resolve, timer })
  })
  void room.announce(false)
  void room.connectTo(creatorKey)
  joinTimers.set(roomId, startJoinCycle(room, code.trim(), reason))
  ctx.log('info', `join: looking for the room creator (${creatorKey.slice(0, 8)})`)
  return waiter
}

function mainDispatch(msg: Envelope): void {
  switch (msg.kind) {
    case 'reply': {
      const pending = pendingReplies.get(msg.id as number)
      if (!pending) return
      pendingReplies.delete(msg.id as number)
      clearTimeout(pending.timer)
      if (msg.ok) pending.resolve(msg.result)
      else pending.reject(new Error(String(msg.error ?? 'main request failed')))
      return
    }
    case 'keypair:init': {
      boot((msg.keyPair as { publicKey: string; secretKey: string } | null) ?? null)
      return
    }
    case 'identity': {
      identity.name = String(msg.name ?? '')
      identity.hwid = String(msg.hwid ?? '')
      identity.maxSpeedBps = (msg.maxSpeedBps as number | null) ?? null
      return
    }
    case 'settings:speed': {
      identity.maxSpeedBps = (msg.maxSpeedBps as number | null) ?? null
      return
    }
    case 'availability:set': {
      const online = msg.online === true
      if (online === available) return
      available = online
      for (const room of ctx.rooms.values()) {
        const r = room as unknown as RoomNet
        if (online) void r.resume()
        else r.suspend()
      }
      return
    }
    case 'trust:known': {
      for (const key of (msg.keys as string[]) ?? []) ctx.trusted.add(key)
      return
    }
    case 'trust:respond': {
      const key = String(msg.key ?? '')
      const accept = msg.accept === true
      if (accept) {
        ctx.trusted.add(key)
        for (const room of ctx.rooms.values()) (room as unknown as RoomNet).markTrusted(key)
      } else {
        for (const room of ctx.rooms.values()) {
          const peer = (room as unknown as RoomNet).peerOf(key)
          peer?.close()
        }
      }
      return
    }
    case 'bans:local': {
      ctx.localBans.clear()
      for (const b of (msg.bans as { roomId: string; targetKey: string }[]) ?? []) {
        ctx.localBans.add(`${b.roomId}:${b.targetKey}`)
      }
      return
    }
    case 'rooms:restore': {
      const leave = msg.leave === true
      for (const r of (msg.rooms as { roomId: string; code: string; transport: 'dht' | 'vpn'; vpnIp: string | null }[]) ?? []) {
        if (ctx.rooms.has(r.roomId)) continue
        const decoded = decodeRoomCode(r.code)
        if (!decoded) continue
        const creatorKey = b4a.toString(decoded, 'hex')
        const room = new RoomNet(ctx, {
          roomId: r.roomId,
          code: r.code,
          creatorKey,
          isCreator: creatorKey === ctx.myKeyHex,
          settings: defaultSettings(r.transport, r.vpnIp)
        })
        room.settings.transport = r.transport
        room.settings.vpnIp = r.vpnIp
        if (leave) room.startLeaving()
        ctx.rooms.set(r.roomId, room)
        topicToRoom.set(b4a.toString(RoomNet.topicOf(r.code), 'hex'), r.roomId)
        // Leave mode ignores the availability state on purpose: the whole
        // point is one last contact with each group. Otherwise suspended
        // rooms would never deliver the goodbye.
        if (!leave && !available) {
          room.suspend()
          continue
        }
        // Everyone announces as server after restore, exactly like after a
        // fresh join — client-only members could never find each other,
        // breaking member-to-member transfers until the creator returned.
        void room.announce(true)
        if (!room.isCreator) {
          // Same TOFU-by-code trust as a fresh join (see joinRoom): a
          // restored member must receive the creator's roster, chat and
          // pings instead of queueing them behind an untrusted peer.
          ctx.trusted.add(creatorKey)
          void room.connectTo(creatorKey)
        }
      }
      return
    }
    case 'room:create': {
      const roomId = ctx.myKeyHex
      const code = encodeRoomCode(ctx.keyPair.publicKey)
      const room = new RoomNet(ctx, {
        roomId,
        code,
        creatorKey: ctx.myKeyHex,
        isCreator: true,
        settings: defaultSettings(
          (msg.transport as 'dht' | 'vpn') ?? 'dht',
          (msg.vpnIp as string | null) ?? null,
          String(msg.name ?? 'room')
        )
      })
      room.settings.memberCap = (msg.memberCap as number | null) ?? null
      room.setMembers([room.selfMember()])
      ctx.rooms.set(roomId, room)
      topicToRoom.set(b4a.toString(RoomNet.topicOf(code), 'hex'), roomId)
      if (!available) {
        room.suspend()
        replyMain(msg.id as number, true, { roomId, code })
        post('room:state', { roomId, code, settings: room.settings, isCreator: true })
        post('roster', { roomId, members: [...room.members.values()], settings: room.settings })
        return
      }
      void room
        .announce(true)
        .then(() => replyMain(msg.id as number, true, { roomId, code }))
        .catch(() => replyMain(msg.id as number, false, { error: 'failed to announce room' }))
      post('room:state', { roomId, code, settings: room.settings, isCreator: true })
      post('roster', { roomId, members: [...room.members.values()], settings: room.settings })
      return
    }
    case 'room:join': {
      void joinRoom(String(msg.code ?? ''), String(msg.reason ?? '')).then((res) => replyMain(msg.id as number, true, res))
      return
    }
    case 'room:leave': {
      const room = getRoom(String(msg.roomId ?? ''))
      if (room) {
        // Announce the leave before tearing down: the creator drops us
        // from the authoritative roster, so the member list stops
        // showing us "forever" after leaving. The teardown is DELAYED —
        // destroying the sockets in the same tick discards the buffered
        // writes and the leave message never reaches anyone.
        room.broadcastAll({ t: 'member_left', roomId: room.roomId, key: ctx.myKeyHex })
        const waiter = joinWaiters.get(room.roomId)
        if (waiter) {
          clearTimeout(waiter.timer)
          joinWaiters.delete(room.roomId)
          waiter.resolve({ ok: false, error: 'cancelled', ban: null })
        }
        setTimeout(() => teardownJoin(room), 500)
      }
      return
    }
    case 'room:updateSettings': {
      const room = getRoom(String(msg.roomId ?? ''))
      if (!room || !room.isCreator) return
      Object.assign(room.settings, msg.settings as Partial<WireRoomSettings>)
      room.broadcast({
        t: 'roster_update',
        roomId: room.roomId,
        room: room.settings,
        members: [...room.members.values()]
      })
      return
    }
    case 'room:pushRoster': {
      const room = getRoom(String(msg.roomId ?? ''))
      if (!room) return
      room.settings = msg.settings as WireRoomSettings
      room.setMembers(msg.members as WireMember[])
      // Only the creator's copy is authoritative: it re-broadcasts the
      // roster to the room. Members just mirror.
      if (room.isCreator) {
        room.broadcast({
          t: 'roster_update',
          roomId: room.roomId,
          room: room.settings,
          members: [...room.members.values()]
        })
      }
      return
    }
    case 'room:vpnAdapter': {
      const room = getRoom(String(msg.roomId ?? ''))
      if (!room) return
      const ip = (msg.ip as string | null) ?? null
      room.settings.vpnIp = ip
      if (room.settings.transport === 'vpn') {
        stopVpn(room)
        void startVpnListener(room, ip).then((port) => {
          room.vpnPort = port
          for (const peer of room.peers.values()) room.sendVpnInfo(peer)
        })
      }
      return
    }
    case 'chat:send': {
      const room = getRoom(String(msg.roomId ?? ''))
      if (!room) return
      const chatMsg = {
        id: String(msg.id ?? ''),
        ts: Number(msg.ts ?? Date.now()),
        text: String(msg.text ?? ''),
        attachment: (msg.attachment as { name: string; mime: string; size: number } | null) ?? null
      }
      const wire = {
        t: 'chat' as const,
        roomId: room.roomId,
        senderKey: ctx.myKeyHex,
        senderName: identity.name,
        msg: chatMsg
      }
      room.broadcast(wire)
      const blob = (msg.attachment as { blob?: Uint8Array } | null)?.blob
      if (chatMsg.attachment && blob) {
        for (const peer of room.peers.values()) {
          if (peer.trusted) peer.sendChatAttachment(chatMsg.id, chatMsg.attachment.size, blob)
        }
      }
      // Store the sender's own message locally too.
      post('chat:message', {
        roomId: room.roomId,
        senderKey: ctx.myKeyHex,
        senderName: identity.name,
        msg: chatMsg,
        blob: blob ?? null
      })
      return
    }
    case 'mod:ban': {
      const room = getRoom(String(msg.roomId ?? ''))
      const entry = msg.entry as WireBanEntry
      room?.broadcast({ t: 'ban', roomId: room.roomId, entry })
      if (room) {
        ctx.localBans.add(`${room.roomId}:${entry.targetKey}`)
        room.peerOf(entry.targetKey)?.close()
      }
      return
    }
    case 'mod:unban': {
      const room = getRoom(String(msg.roomId ?? ''))
      const targetKey = String(msg.targetKey ?? '')
      room?.broadcast({ t: 'unban', roomId: room.roomId, targetKey })
      if (room) ctx.localBans.delete(`${room.roomId}:${targetKey}`)
      return
    }
    case 'mod:setRole': {
      const room = getRoom(String(msg.roomId ?? ''))
      const key = String(msg.targetKey ?? '')
      const role = msg.role as 'admin' | 'moderator' | 'member'
      const member = room?.members.get(key)
      if (room && member) {
        room.members.set(key, { ...member, role })
        room.broadcast({ t: 'role_change', roomId: room.roomId, key, role })
      }
      return
    }
    case 'mod:suspect': {
      const room = getRoom(String(msg.roomId ?? ''))
      if (!room) return
      room.broadcast({
        t: 'suspect',
        roomId: room.roomId,
        targetKey: String(msg.targetKey ?? ''),
        targetHwid: String(msg.targetHwid ?? ''),
        reason: String(msg.reason ?? ''),
        byName: identity.name,
        marked: false
      })
      return
    }
    case 'mod:markSuspected': {
      const room = getRoom(String(msg.roomId ?? ''))
      if (!room) return
      room.broadcast({
        t: 'suspect',
        roomId: room.roomId,
        targetKey: String(msg.targetKey ?? ''),
        targetHwid: String(msg.targetHwid ?? ''),
        reason: null,
        byName: identity.name,
        marked: true
      })
      return
    }
    case 'transfer:historyClear': {
      engine?.clearHistoryFromMain(String(msg.roomId ?? ''))
      return
    }
    case 'app:banSend': {
      const room = getRoom(String(msg.roomId ?? ''))
      if (!room) return
      room.broadcastAll({
        t: 'app_ban',
        targetKey: String(msg.targetKey ?? ''),
        hwid: String(msg.hwid ?? ''),
        reason: String(msg.reason ?? ''),
        byName: identity.name,
        byHwid: identity.hwid,
        until: (msg.until as number | null) ?? null,
        issuedAt: Date.now()
      })
      return
    }
    case 'transfer:offer': {
      engine?.offerFromMain({
        taskId: String(msg.taskId ?? ''),
        roomId: String(msg.roomId ?? ''),
        receiverKey: String(msg.receiverKey ?? ''),
        files: msg.files as { id: number; relPath: string; size: number; risky: boolean }[],
        totalSize: Number(msg.totalSize ?? 0),
        label: String(msg.label ?? '')
      })
      return
    }
    case 'transfer:reattach': {
      engine?.reattachFromMain({
        tasks: msg.tasks as {
          taskId: string
          roomId: string
          receiverKey: string
          files: { id: number; relPath: string; size: number; risky: boolean }[]
          totalSize: number
          label: string
        }[]
      })
      return
    }
    case 'transfer:respond': {
      engine?.respondFromMain({
        taskId: String(msg.taskId ?? ''),
        accept: msg.accept === true,
        speedCapBps: (msg.speedCapBps as number | null) ?? null,
        error: (msg.error as string | null) ?? null
      })
      return
    }
    case 'transfer:control': {
      engine?.controlFromMain({
        taskId: String(msg.taskId ?? ''),
        action: msg.action as 'pause' | 'resume' | 'cancel'
      })
      return
    }
    case 'transfer:setCap': {
      engine?.setCapFromMain({
        taskId: String(msg.taskId ?? ''),
        speedCapBps: (msg.speedCapBps as number | null) ?? null
      })
      return
    }
    case 'preview:request': {
      engine?.previewRequestFromMain({ taskId: String(msg.taskId ?? ''), fileId: Number(msg.fileId ?? 0) })
      return
    }
    case 'invite:send': {
      const room = getRoom(String(msg.roomId ?? ''))
      if (!room) return
      const peer = room.peerOf(String(msg.targetKey ?? ''))
      peer?.sendControl({
        t: 'invite',
        roomId: room.roomId,
        roomName: String(msg.roomName ?? ''),
        code: room.code,
        from: identity.name,
        fromKey: ctx.myKeyHex,
        targetKey: String(msg.targetKey ?? '')
      })
      return
    }
    default: {
      // Unknown kinds are logged, never fatal.
      ctx.log('warn', `unhandled main message: ${msg.kind}`)
      return
    }
  }
}

port.on('message', (e) => {
  const msg = e.data
  try {
    mainDispatch(msg)
  } catch (err) {
    ctx.log('error', `dispatch failed for ${String(msg.kind)}: ${(err as Error).message}`)
  }
})
