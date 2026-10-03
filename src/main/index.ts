import { app, clipboard, ipcMain, shell } from 'electron'
import fs from 'node:fs'
import { APP_ID, APP_BANS } from '../shared/constants'
import type { AppBanInfo, BootState, CallResult, ChatMessageView } from '../shared/api'
import type { WireBanEntry, WireMember, WorkerRequest } from '../shared/worker'
import { banStore } from './db/bans'
import { chatStore } from './db/chat'
import { roomsDb } from './db/rooms'
import { folderLock } from './folderLock'
import { rebuildHwid, verifyHwid } from './hwid'
import { integrityCheck } from './integrity'
import { loadKeypair, saveKeypair } from './keypair'
import { Moderation } from './moderation'
import { NetClient } from './netClient'
import { notifier } from './notify'
import { myPublicKey, roomStateCache, setMyPublicKey, computeBadges, appBanIssuerBadges } from './roomState'
import { settings } from './settings'
import { TransferManager } from './transfers'
import { createIntegrityWindow, createMainWindow, pushToRenderer, getMainWindow, getIntegrityWindow } from './window'
import { createTray, destroyTray } from './tray'
import { registerIpc } from './ipc'
import { Updater } from './updater'

// Composition root. Boot order (spec): single instance -> packaged-only
// integrity gate -> HWID verify (mismatch shows the blocking rebuild
// screen) -> settings/receive-folder gates -> net worker -> window.

const net = new NetClient()
const moderation = new Moderation(net)
const transfers = new TransferManager()
const updater = new Updater()

let hwidHash = ''
let hwidBroken = false
let bootStageValue: BootState['stage'] = 'loading'
// App-level ban (self-enforced): a build-time blocklist entry or a
// peer-delivered app_ban that matches this machine's HWID. Blocks the
// whole UI with the APP BANNED screen and disables auto-update.
let appBanInfo: AppBanInfo | null = null
// Session availability: false = every room is suspended in the worker;
// the user is unreachable (no chat, no offers, no joins). Always starts
// online; not persisted across restarts on purpose.
let available = true

function bootStage(): BootState['stage'] {
  return bootStageValue
}

function computeStage(): BootState['stage'] {
  // App ban verdicts outrank everything else — the screen is blocked.
  if (appBanInfo) return 'appBanned'
  if (hwidBroken) return 'hwidMismatch'
  const s = settings.get()
  if (s.receiveFolder.length === 0 || s.displayName.length === 0) return 'setup'
  if (!fs.existsSync(s.receiveFolder)) return 'setup'
  return 'ready'
}

function checkAppBan(): void {
  for (const b of APP_BANS) {
    if (b.hwid === hwidHash && (b.until === null || b.until > Date.now())) {
      appBanInfo = { reason: b.reason, byName: 'App Moderator', byBadges: appBanIssuerBadges(null), expiresAt: b.until }
      return
    }
  }
  const row = roomsDb.getAppBanByHwid(hwidHash)
  if (row) appBanInfo = { reason: row.reason, byName: row.byName, byBadges: appBanIssuerBadges(row.byHwid), expiresAt: row.until }
}

function pushBoot(): void {
  bootStageValue = computeStage()
  pushToRenderer('boot', {
    stage: bootStageValue,
    settings: settings.get(),
    version: app.getVersion(),
    hwidRebuildError: null,
    // Availability is re-sent with every boot push: a renderer (re)load
    // resets its store to "online" while this process may still be
    // suspended — without this the UI lies about being reachable.
    online: available,
    appBan: appBanInfo
  })
}

function pushSettings(): void {
  pushToRenderer('settings', settings.get())
}

function pushRooms(): void {
  const joined = roomsDb.summaries(roomStateCache.onlineSets(roomsDb.listRooms().map((r) => r.roomId)))
  // Pending/rejected applications render as room cards with hidden
  // member data ("unavailable" until accepted).
  pushToRenderer('rooms', [...joined, ...roomsDb.pendingSummaries()])
}

function pushAllRoomStates(): void {
  for (const room of roomsDb.listRooms()) pushRoomState(room.roomId)
}

function pushRoomState(roomId: string): void {
  const state = roomStateCache.buildRoomState(roomId)
  if (state) pushToRenderer('room', state)
}

function pushTasks(roomId: string): void {
  pushToRenderer('tasks', { roomId, tasks: transfers.tasksFor(roomId) })
}

function pushChat(roomId: string, message: ChatMessageView, merged: boolean): void {
  pushToRenderer('chat', { roomId, message, merged })
}

// Creator's authoritative roster push: persist is done by callers before
// this; the worker mirrors + broadcasts roster_update to the room.
function pushRosterToWorker(roomId: string): void {
  const room = roomsDb.getRoom(roomId)
  const wireSettings = roomStateCache.getRoomSettings(roomId)
  if (!room || !wireSettings) return
  const members: WireMember[] = roomsDb.listMembers(roomId).map((m) => ({
    key: m.key,
    name: m.name,
    role: m.role,
    hwid: m.hwid,
    joinedAt: m.joinedAt,
    lastSeen: m.lastSeen,
    untrusted: m.untrusted === 1
  }))
  net.send({ kind: 'room:pushRoster', roomId, members, settings: wireSettings })
}

async function rebuildHwidFlow(): Promise<CallResult> {
  try {
    const fresh = await rebuildHwid()
    hwidHash = fresh
    hwidBroken = false
    pushBoot()
    return { ok: true, error: null }
  } catch (e) {
    return { ok: false, error: `HWID rebuild failed: ${(e as Error).message}` }
  }
}

function setAvailability(online: boolean): void {
  // A banned install can never go online — the toggle is locked on
  // Offline from the moment the ban becomes active.
  if (online && appBanInfo) return
  if (online === available) return
  available = online
  // Own presence follows the toggle: you are online to yourself (and in
  // room-card counts) exactly while available.
  roomStateCache.setSelfOnline(online)
  for (const room of roomsDb.listRooms()) {
    if (roomsDb.getMember(room.roomId, myPublicKey)) {
      roomStateCache.setPresence(room.roomId, myPublicKey, online, null)
    }
  }
  net.send({ kind: 'availability:set', online })
  pushAllRoomStates()
  pushRooms()
  pushToRenderer('availability', { online })
  notifier.push(
    online ? 'You are online' : 'You went offline',
    online ? 'Rooms reconnected — you can send and receive again.' : 'Peers can no longer reach you: no messages, no transfer requests.',
    'info'
  )
}

// Everything that must happen the moment an app ban becomes ACTIVE on this
// machine: the user leaves every group (the worker already broadcast
// member_left on the wire path, so peers drop us from their rosters) and
// is locked out of going online for the rest of the session.
function enforceAppBan(): void {
  available = false
  roomStateCache.setSelfOnline(false)
  for (const room of roomsDb.listRooms()) {
    // room:leave also tears down any pending join cycle in the worker;
    // the wipe drops all room-local data (members, chat, transfer state).
    net.send({ kind: 'room:leave', roomId: room.roomId })
    moderation.wipeRoom(room.roomId)
  }
  for (const p of roomsDb.listPendingRooms()) {
    net.send({ kind: 'room:leave', roomId: p.roomId })
    roomsDb.deletePendingByRoom(p.roomId)
  }
  net.send({ kind: 'availability:set', online: false })
  pushRooms()
  pushToRenderer('availability', { online: false })
}

function wireWorker(): void {
  // Worker diagnostics: the worker emits net:log events for connect
  // failures, rejected peers and admission outcomes — route them to the
  // real console levels (they were previously unhandled and invisible).
  net.on('net:log', (raw) => {
    const msg = raw as unknown as { level: 'info' | 'warn' | 'error'; msg: string }
    console[msg.level === 'error' ? 'error' : msg.level === 'warn' ? 'warn' : 'log'](`[net] ${msg.msg}`)
  })
  // Anything genuinely unhandled still shows up once, as a warning.
  net.setLogSink((level, msg) => console[level === 'error' ? 'error' : 'log'](`[net] ${msg}`))

  net.on('keypair:created', (msg: { publicKey: string; secretKey: string }) => {
    saveKeypair({ publicKey: msg.publicKey, secretKey: msg.secretKey })
  })

  net.on('ready', (msg: { publicKey: string }) => {
    setMyPublicKey(msg.publicKey)
    // A (re)spawned worker always starts as "available": re-assert the
    // session availability FIRST. Messages are FIFO, so this is processed
    // before rooms:restore below — an offline (or banned) user never
    // flashes online to their rooms, even after a worker respawn.
    if (!available) net.send({ kind: 'availability:set', online: false })
    // Seed own presence for every room we belong to: presence events only
    // exist for remote peers, so without this you never appear online to
    // yourself. The renderer's own dot also follows the availability
    // toggle independently (belt and suspenders).
    for (const room of roomsDb.listRooms()) {
      if (roomsDb.getMember(room.roomId, msg.publicKey)) {
        roomStateCache.setPresence(room.roomId, msg.publicKey, true, null)
      }
    }
    // Boot diagnostics — identity and per-room presence verdict. If these
    // lines are missing from the console, the worker never reached ready
    // (or the instance is running a stale build).
    console.log(
      `[app] identity ${msg.publicKey.slice(0, 8)}… — ${roomsDb.listRooms().length} room(s) — build ${
        typeof __BUILD_STAMP__ === 'string' ? __BUILD_STAMP__ : 'unknown'
      }`
    )
    for (const room of roomsDb.listRooms()) {
      const me = roomsDb.getMember(room.roomId, msg.publicKey)
      console.log(
        `[app] room "${room.name}": ${me ? `self=${me.name}` : 'SELF NOT IN MEMBER LIST'} — presence=${roomStateCache.isOnline(room.roomId, msg.publicKey) ? 'ONLINE' : 'OFFLINE'}`
      )
    }
    // The boot-time rooms/room-state pushes happen BEFORE the worker is
    // ready, so they carry no identity and count the self presence as
    // offline. Re-push now that identity + presence are seeded — this is
    // what makes the room cards show "1 online" without a re-navigation.
    pushAllRoomStates()
    pushRooms()
    const s = settings.get()
    if (s.displayName && hwidHash) {
      net.send({ kind: 'identity', name: s.displayName, hwid: hwidHash, maxSpeedBps: s.maxTransferSpeedBps })
    }
    net.send({ kind: 'trust:known', keys: roomsDb.listTrusted().map((t) => t.key) })
    net.send({
      kind: 'bans:local',
      bans: roomsDb.listLocalBans().map((b) => ({ roomId: b.roomId, targetKey: b.targetKey }))
    })
    // A banned install never comes online: no room is restored, so the
    // worker announces nothing and dials no one. Mid-session bans already
    // left every group on receipt; boot-time enforcement (below) wiped the
    // local room data, so there is nothing to restore anyway.
    if (!appBanInfo) {
      net.send({
        kind: 'rooms:restore',
        rooms: [
          ...roomsDb.listRooms().map((r) => ({
            roomId: r.roomId,
            code: r.code,
            transport: r.transport,
            vpnIp: roomsDb.getRoomVpnIp(r.roomId) ?? r.vpnIp,
            pending: false
          })),
          // Pending applications re-dial the creator on every start until a
          // decision arrives (the applicant's pull replaces a push).
          ...roomsDb.listPendingRooms().map((p) => ({
            roomId: p.roomId,
            code: p.code,
            transport: 'dht' as const,
            vpnIp: null,
            pending: true
          }))
        ]
      })
    }
    // Seed the worker's roster mirrors from the local caches so presence,
    // member names and connection gating work before the first wire sync.
    for (const room of roomsDb.listRooms()) {
      const wireSettings =
        roomStateCache.getRoomSettings(room.roomId) ?? {
          name: room.name,
          memberCap: null,
          chatLimits: {
            textLength: 500,
            imageBytes: 5 * 1024 * 1024,
            videoBytes: 10 * 1024 * 1024,
            audioBytes: 2 * 1024 * 1024
          },
          transport: room.transport,
          vpnIp: room.vpnIp,
          vpnPort: room.vpnPort
        }
      roomStateCache.setRoomSettings(room.roomId, wireSettings)
      const members: WireMember[] = roomsDb.listMembers(room.roomId).map((m) => ({
        key: m.key,
        name: m.name,
        role: m.role,
        hwid: m.hwid,
        joinedAt: m.joinedAt,
        lastSeen: m.lastSeen,
        untrusted: m.untrusted === 1
      }))
      if (members.length > 0) {
        net.send({ kind: 'room:pushRoster', roomId: room.roomId, members, settings: wireSettings })
      }
    }
    // Reattach persisted send tasks so interrupted transfers can resume
    // when the receiver comes back (chunk-level checkpointing, spec 8.8).
    const persisted = transfers.listPersistedSends()
    if (persisted.length > 0) {
      net.send({
        kind: 'transfer:reattach',
        tasks: persisted.map((t) => ({
          taskId: t.taskId,
          roomId: t.roomId,
          receiverKey: t.receiverKey,
          files: t.files.map((f) => ({ id: f.id, relPath: f.relPath, size: f.size, risky: f.risky })),
          totalSize: t.totalSize,
          label: t.label
        }))
      })
    }
  })

  net.on('room:state', (msg: { roomId: string; code: string; settings: import('../shared/worker').WireRoomSettings; isCreator: boolean }) => {
    const room = roomsDb.getRoom(msg.roomId)
    roomsDb.upsertRoom({
      roomId: msg.roomId,
      name: msg.settings.name,
      code: msg.code,
      isCreator: msg.isCreator,
      transport: msg.settings.transport,
      vpnIp: msg.settings.vpnIp,
      vpnPort: msg.settings.vpnPort
    })
    roomStateCache.setRoomSettings(msg.roomId, msg.settings)
    // An accepted application replaces its pending card.
    roomsDb.deletePendingByRoom(msg.roomId)
    if (!room) {
      // Newly joined room: seed self membership if missing.
      const me = myPublicKey
      if (me && !roomsDb.getMember(msg.roomId, me)) {
        const s = settings.get()
        roomsDb.upsertMember({
          roomId: msg.roomId,
          key: me,
          name: s.displayName || 'me',
          role: msg.isCreator ? 'creator' : 'member',
          hwid: hwidHash,
          joinedAt: Date.now(),
          lastSeen: Date.now(),
          untrusted: 0
        })
      }
    }
    pushRooms()
    pushRoomState(msg.roomId)
  })

  net.on('roster', (msg: { roomId: string; members: WireMember[]; settings: import('../shared/worker').WireRoomSettings }) => {
    roomsDb.upsertMembers(
      msg.roomId,
      msg.members.map((m) => ({ ...m, roomId: msg.roomId }))
    )
    roomStateCache.setRoomSettings(msg.roomId, msg.settings)
    pushRoomState(msg.roomId)
    pushRooms()
  })

  net.on('presence', (msg: { roomId: string; key: string; online: boolean; ip: string | null }) => {
    roomStateCache.setPresence(msg.roomId, msg.key, msg.online, msg.ip)
    if (msg.online) {
      // Deliver any invites queued for this peer while they were offline
      // (spec 5.4).
      const room = roomsDb.getRoom(msg.roomId)
      for (const relay of roomsDb.relaysFor(msg.key)) {
        if (relay.roomId !== msg.roomId) continue
        net.send({
          kind: 'invite:send',
          roomId: relay.roomId,
          roomName: room?.name ?? relay.roomName,
          code: relay.code,
          targetKey: relay.targetKey
        })
        roomsDb.deleteRelay(relay.id)
      }
    }
    const member = roomsDb.getMember(msg.roomId, msg.key)
    if (member) roomsDb.upsertMember({ ...member, lastSeen: Date.now() })
    pushRoomState(msg.roomId)
    pushRooms()
  })

  net.on('chat:message', (msg: {
    roomId: string
    senderKey: string
    senderName: string
    msg: { id: string; ts: number; text: string; attachment: { name: string; mime: string; size: number } | null }
    blob: Uint8Array | null
  }) => {
    // OS notification for messages from other members (item: chat
    // notifications) — your own messages and merged history don't ring.
    if (msg.senderKey !== myPublicKey && msg.msg.text.trim().length > 0) {
      const room = roomsDb.getRoom(msg.roomId)
      notifier.push(
        `${msg.senderName} → ${room?.name ?? 'room'}`,
        msg.msg.text.length > 120 ? `${msg.msg.text.slice(0, 120)}…` : msg.msg.text,
        'chat'
      )
    }
    const merged = chatStore.store(msg.roomId, {
      id: msg.msg.id,
      ts: msg.msg.ts,
      senderKey: msg.senderKey,
      senderName: msg.senderName,
      text: msg.msg.text,
      attachment: msg.msg.attachment,
      blob: msg.blob ? Buffer.from(msg.blob) : null
    })
    pushChat(
      msg.roomId,
      {
        id: msg.msg.id,
        ts: msg.msg.ts,
        senderKey: msg.senderKey,
        senderName: msg.senderName,
        text: msg.msg.text,
        attachment: msg.msg.attachment,
        hasAttachmentBlob: msg.blob !== null || msg.msg.attachment !== null
      },
      merged
    )
  })

  net.on('trust:prompt', (msg: { prompt: import('../shared/api').TrustPrompt }) => {
    void moderation.promptTrust(msg.prompt)
  })

  // Worker requests (need replies).
  const handleRequest = (msg: WorkerRequest): void => {
    switch (msg.kind) {
      case 'mod:admitJoin': {
        void moderation.admitJoin(msg.roomId, msg.joiner).then((res) => {
          if (res.allow) {
            const room = roomsDb.getRoom(msg.roomId)
            const wireSettings = roomStateCache.getRoomSettings(msg.roomId)
            roomsDb.upsertMember({
              roomId: msg.roomId,
              key: msg.joiner.key,
              name: msg.joiner.name,
              role: 'member',
              hwid: msg.joiner.hwid,
              joinedAt: Date.now(),
              lastSeen: Date.now(),
              untrusted: 0
            })
            if (room?.isCreator && wireSettings) pushRosterToWorker(msg.roomId)
            pushRoomState(msg.roomId)
          }
          net.replyTo(msg.id, true, res)
        })
        break
      }
      case 'mod:outbox': {
        // Moderator hands cached bans to the reconnecting creator (spec
        // 7.2); clearing on hand-off is acceptable because the instant
        // broadcast already carried these entries to online peers.
        const entries = moderation.outboxBans(msg.roomId)
        moderation.clearOutbox(msg.roomId)
        net.replyTo(msg.id, true, entries)
        break
      }
      case 'chat:getManifest': {
        // The worker reads `res.entries` (see RoomNet.onPeerAdded) — the
        // reply must be shaped, not a bare array, or every manifest
        // silently resolves to [] and chat history never syncs.
        net.replyTo(msg.id, true, { entries: chatStore.manifest(msg.roomId) })
        break
      }
      case 'chat:storeMessages': {
        let newest = 0
        for (const m of msg.messages) {
          const merged = chatStore.store(msg.roomId, {
            id: m.id,
            ts: m.ts,
            senderKey: msg.senderKey,
            senderName: msg.senderName,
            text: m.text,
            attachment: m.attachment,
            blob: m.blob ? Buffer.from(m.blob) : null
          })
          if (merged) {
            newest = Math.max(newest, m.ts)
            pushChat(
              msg.roomId,
              {
                id: m.id,
                ts: m.ts,
                senderKey: msg.senderKey,
                senderName: msg.senderName,
                text: m.text,
                attachment: m.attachment,
                hasAttachmentBlob: m.blob !== null || m.attachment !== null
              },
              true
            )
          }
        }
        net.replyTo(msg.id, true, { ok: true })
        break
      }
      case 'chat:pullBatch': {
        net.replyTo(msg.id, true, chatStore.pull(msg.roomId, msg.ids))
        break
      }
      case 'mod:applications': {
        // Rows for wire app_sync (creator's merged log, or a staff
        // member's locally captured applications).
        net.replyTo(msg.id, true, {
          entries: roomsDb.listApplications(msg.roomId).map((a) => ({
            applicantKey: a.applicantKey,
            name: a.name,
            hwid: a.hwid,
            status: a.status,
            reason: a.reason,
            decidedByName: a.decidedByName,
            decidedAt: a.decidedAt,
            createdAt: a.createdAt,
            pv: a.pv,
            bid: a.bid
          }))
        })
        break
      }
      default: {
        // transfer:*/preview:* requests are handled by the TransferManager.
        break
      }
    }
  }
  net.on('mod:admitJoin', handleRequest)
  net.on('mod:outbox', handleRequest)
  net.on('chat:getManifest', handleRequest)
  net.on('chat:storeMessages', handleRequest)
  net.on('chat:pullBatch', handleRequest)
  net.on('mod:applications', handleRequest)

  // Application rows synced over the wire (staff → creator merges into the
  // authoritative log; creator → staff mirrors the log locally).
  net.on('app:sync', (msg: {
    roomId: string
    entries: {
      applicantKey: string
      name: string
      hwid: string
      status: 'pending' | 'approved' | 'rejected'
      reason: string | null
      decidedByName: string | null
      decidedAt: number | null
      createdAt: number
      pv?: number
      bid?: string
    }[]
  }) => {
    for (const entry of msg.entries) moderation.mergeApplication(msg.roomId, entry)
  })

  net.on('banned', (msg: { roomId: string; ban: { reason: string; adminName: string; adminKey: string; expiresAt: number | null } }) => {
    // Badges are computed from the roster BEFORE handleBanned wipes it —
    // after the wipe the issuing staff member is no longer lookup-able.
    const admin = roomsDb.getMember(msg.roomId, msg.ban.adminKey)
    const adminBadges = admin ? computeBadges(admin) : []
    moderation.handleBanned(msg.roomId, msg.ban.reason, msg.ban.adminName, adminBadges, msg.ban.expiresAt)
    notifier.push('You have been banned', msg.ban.reason || 'No reason given', 'ban')
    pushRooms()
  })

  net.on('ban:applied', (msg: { roomId: string; entry: WireBanEntry }) => {
    moderation.applyLocalBan(msg.roomId, msg.entry)
    const room = roomsDb.getRoom(msg.roomId)
    if (room?.isCreator) {
      banStore.upsert(msg.roomId, msg.entry)
      // Remove the banned member from the authoritative roster and push.
      const member = roomsDb.getMember(msg.roomId, msg.entry.targetKey)
      if (member) {
        roomsDb.upsertMembers(
          msg.roomId,
          roomsDb
            .listMembers(msg.roomId)
            .filter((m) => m.key !== msg.entry.targetKey)
        )
        pushRosterToWorker(msg.roomId)
        pushRoomState(msg.roomId)
      }
    }
    pushRoomState(msg.roomId)
  })

  net.on('ban:sync', (msg: { roomId: string; entries: WireBanEntry[] }) => {
    moderation.mergeBans(msg.roomId, msg.entries)
  })

  net.on('role:changed', (msg: { roomId: string; key: string; role: 'admin' | 'moderator' | 'member' }) => {
    const member = roomsDb.getMember(msg.roomId, msg.key)
    if (member) {
      roomsDb.upsertMember({ ...member, role: msg.role })
      pushRoomState(msg.roomId)
      const room = roomsDb.getRoom(msg.roomId)
      if (room?.isCreator) pushRosterToWorker(msg.roomId)
    }
  })

  net.on('member:left', (msg: { roomId: string; key: string }) => {
    const room = roomsDb.getRoom(msg.roomId)
    // The leaver drops out of the member list immediately: the creator
    // removes them from the authoritative roster and re-broadcasts it.
    if (room?.isCreator) {
      const member = roomsDb.getMember(msg.roomId, msg.key)
      if (member) {
        roomsDb.upsertMembers(
          msg.roomId,
          roomsDb.listMembers(msg.roomId).filter((m) => m.key !== msg.key)
        )
        pushRosterToWorker(msg.roomId)
      }
    }
    roomStateCache.setPresence(msg.roomId, msg.key, false, null)
    pushRoomState(msg.roomId)
    pushRooms()
  })

  // A join application arrived at a staff member. The creator's rows are
  // the log; staff rows sync back to the creator via app_sync.
  net.on('app:submitted', (msg: {
    roomId: string
    applicant: { key: string; name: string; hwid: string; ip: string; pv: number; bid: string }
  }) => {
    const existing = roomsDb.getApplication(msg.roomId, msg.applicant.key)
    if (existing && existing.status !== 'pending') return
    roomsDb.upsertApplication({
      roomId: msg.roomId,
      applicantKey: msg.applicant.key,
      name: msg.applicant.name,
      hwid: msg.applicant.hwid,
      status: 'pending',
      reason: null,
      decidedByName: null,
      decidedAt: null,
      createdAt: existing?.createdAt ?? Date.now(),
      pv: msg.applicant.pv,
      bid: msg.applicant.bid
    })
    notifier.push('Room application', `${msg.applicant.name} applied to join — review it in the application center.`, 'info')
    pushRoomState(msg.roomId)
  })

  // The join window expired: the room card goes to "pending" and the
  // worker keeps retrying until staff decide.
  net.on('room:pending', (msg: { roomId: string; code: string }) => {
    roomsDb.upsertPendingRoom({
      code: msg.code,
      roomId: msg.roomId,
      name: `Room ${msg.roomId.slice(0, 8)}`,
      status: 'pending',
      reason: null
    })
    pushRooms()
  })

  // A roster member was caught advertising a mismatched app build. Only
  // the creator enforces (auto group-ban + untrusted flag); the report
  // was already broadcast to the room by the worker.
  net.on('untrust:report', (msg: { roomId: string; targetKey: string; theirPv: number; theirBid: string }) => {
    const room = roomsDb.getRoom(msg.roomId)
    if (!room?.isCreator) return
    const reason = `modified app build (protocol v${msg.theirPv}) [build ${msg.theirBid}]`
    moderation.issueBan(msg.roomId, myPublicKey, 'room creator', msg.targetKey, 'perm', reason, true)
    roomsDb.markUntrusted(msg.roomId, msg.targetKey, true)
    pushRosterToWorker(msg.roomId)
    pushRoomState(msg.roomId)
    console.log(`[moderation] untrusted build: ${msg.targetKey.slice(0, 8)} — ${reason}`)
  })

  // Peer-delivered app ban (issuer pre-verified against APP_MOD_HWIDS by
  // the worker). Persist; if it targets this machine, enforce on self.
  net.on('appBan:received', (msg: {
    entry: { targetKey: string; hwid: string; reason: string; byName: string; byHwid: string; until: number | null; issuedAt: number }
  }) => {
    const already = roomsDb.getAppBanByHwid(msg.entry.hwid)
    if (already && already.issuedAt >= msg.entry.issuedAt) return
    roomsDb.upsertAppBan({
      hwid: msg.entry.hwid,
      targetKey: msg.entry.targetKey,
      reason: msg.entry.reason,
      byName: msg.entry.byName,
      byHwid: msg.entry.byHwid,
      until: msg.entry.until,
      issuedAt: msg.entry.issuedAt
    })
    if (msg.entry.hwid === hwidHash) {
      appBanInfo = {
        reason: msg.entry.reason,
        byName: msg.entry.byName,
        byBadges: appBanIssuerBadges(msg.entry.byHwid),
        expiresAt: msg.entry.until
      }
      // Only an ACTIVE ban enforces: leaving every group and the offline
      // lock are irreversible for the session, so an already-expired
      // entry just shows the screen.
      if (msg.entry.until === null || msg.entry.until > Date.now()) enforceAppBan()
      pushBoot()
      pushToRenderer('notification', {
        title: 'APP BANNED',
        body: msg.entry.reason || 'No reason given',
        kind: 'ban'
      })
    }
  })

  net.on('invite:received', (msg: { roomId: string; roomName: string; code: string; from: string; fromKey: string }) => {
    const id = `${msg.roomId}:${msg.fromKey}:${Date.now()}`
    roomsDb.addInvite({
      id,
      roomId: msg.roomId,
      roomName: msg.roomName,
      code: msg.code,
      fromName: msg.from,
      fromKey: msg.fromKey,
      receivedAt: Date.now(),
      handled: false
    })
    pushToRenderer('invite', {
      id,
      roomId: msg.roomId,
      roomName: msg.roomName,
      code: msg.code,
      from: msg.from,
      fromKey: msg.fromKey,
      receivedAt: Date.now()
    })
    notifier.push('Room invitation', `${msg.from} invited you to "${msg.roomName}"`, 'invite')
  })

  net.on('invite:relay', (msg: { roomId: string; roomName: string; code: string; from: string; fromKey: string; targetKey: string }) => {
    roomsDb.addRelay({
      roomId: msg.roomId,
      roomName: msg.roomName,
      code: msg.code,
      fromName: msg.from,
      fromKey: msg.fromKey,
      targetKey: msg.targetKey
    })
  })

  net.on('offer:incoming', (msg: { offer: import('../shared/api').OfferView }) => {
    pushToRenderer('offer', msg.offer)
    notifier.push('Incoming transfer', `${msg.offer.senderName} wants to send you ${msg.offer.files.length} file(s)`, 'transfer')
  })

  net.on('tasks:snapshot', (msg: { roomId: string; tasks: import('../shared/api').TaskView[] }) => {
    pushTasks(msg.roomId)
  })

  net.on('join:failed', (msg: { reason: string }) => {
    notifier.push('Join failed', msg.reason, 'info')
  })

  moderation.bind(
    (prompt) => pushToRenderer('trust', prompt),
    (roomId, roomName, reason, adminName, adminBadges, expiresAt) => {
      pushToRenderer('banned', { roomId, roomName, reason, adminName, adminBadges, expiresAt })
    },
    (msgString) => console.log(`[moderation] ${msgString}`),
    // Post-decision refresh: roster (so approvals reach the worker's
    // mirror), room state and the room cards.
    (roomId) => {
      const room = roomsDb.getRoom(roomId)
      if (room?.isCreator) pushRosterToWorker(roomId)
      pushRoomState(roomId)
      pushRooms()
    }
  )
}

// The integrity warning window gets exactly two IPC handlers (spec 12.4):
// open-repo-in-browser and copy-Discord-username. A tampered build must
// never get the full IPC surface.
function registerIntegrityWindowIpc(): void {
  ipcMain.handle('integrity:openRepo', () => {
    void shell.openExternal('https://github.com/rqwq/P2P-File-Transfer')
    return null
  })
  ipcMain.handle('integrity:copyContact', () => {
    clipboard.writeText('phenomenal_lqc')
    return true
  })
}

function quitApp(): void {
  folderLock.stop()
  net.stop()
  destroyTray()
  app.exit(0)
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  // A silent exit here is how a "restart" secretly does nothing: the old
  // instance keeps running old code and keeps getting tested against.
  console.error(
    '[app] another instance is ALREADY RUNNING — it was focused; this launch exits WITHOUT opening a window. Close the old one (tray icon → Quit) before starting a new one.'
  )
  app.quit()
} else {
  app.on('second-instance', () => {
    const win = getMainWindow()
    if (win) {
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
    }
  })

  void app.whenReady().then(async () => {
    app.setAppUserModelId(APP_ID)

    // Packaged-only runtime integrity gate (spec 12.4).
    if (app.isPackaged) {
      const gate = await integrityCheck()
      if (gate === 'fail') {
        registerIntegrityWindowIpc()
        createIntegrityWindow(() => quitApp())
        return
      }
    }

    settings.load()
    roomsDb.init()

    // HWID: computed once on first launch, verified against the cache on
    // every subsequent launch (spec 4.1/4.2). A mismatch shows the
    // blocking error screen with exactly two actions.
    try {
      const check = await verifyHwid()
      hwidHash = check.hwid
      hwidBroken = !check.matches
    } catch (e) {
      console.error('[hwid] compute failed:', e)
      hwidBroken = true
    }

    // App-level ban (build-time blocklist or previously received
    // peer-delivered app_ban): blocks the UI and disables auto-update.
    checkAppBan()
    if (appBanInfo) {
      // Boot-time enforcement of an active ban: locked offline (the
      // availability toggle can never leave Offline) and out of every
      // group — a banned member must not reappear in anyone's roster.
      // Mid-session bans already did this on receipt; this also covers
      // build-time blocklist entries and any room data left from a
      // session that never got the wire-delivered leave out.
      available = false
      roomStateCache.setSelfOnline(false)
      for (const room of roomsDb.listRooms()) moderation.wipeRoom(room.roomId)
      for (const p of roomsDb.listPendingRooms()) roomsDb.deletePendingByRoom(p.roomId)
    }

    // Receive folder: existence is re-checked on every app start (spec 8.7).
    const s = settings.get()
    if (s.receiveFolder && fs.existsSync(s.receiveFolder)) {
      folderLock.ensureStarted(s.receiveFolder)
    }

    wireWorker()
    // Worker respawn re-seeding: the worker is stateless, so a crashed
    // worker is replaced (see NetClient) and re-initialized exactly like
    // a fresh boot — identity here, everything else in the 'ready'
    // handler.
    net.setOnRespawn(() => {
      net.send({ kind: 'keypair:init', keyPair: loadKeypair() })
    })
    net.start()
    // The worker's identity keypair: reuse the DPAPI-persisted one, or let
    // the worker generate and report a fresh pair.
    net.send({ kind: 'keypair:init', keyPair: loadKeypair() })
    transfers.init(net, pushTasks, (_taskId, label, roomId) => {
      notifier.push('Transfer complete', label, 'transfer')
      pushTasks(roomId)
    })

    createMainWindow(() => {
      // Hidden to tray; nothing extra to do — transfers continue.
    })

    registerIpc({
      getWindow: () => getMainWindow(),
      hwidHash: () => hwidHash,
      bootStage,
      appBan: () => appBanInfo,
      rebuildHwid: rebuildHwidFlow,
      setAvailability,
      isAvailable: () => available,
      net,
      moderation,
      transfers,
      updater,
      pushBoot,
      pushSettings,
      pushRooms,
      pushRoomState,
      quitApp
    })

    createTray(() => getMainWindow(), () => quitApp())

    // No update channel for banned installs: a banned build must not
    // silently replace itself.
    if (!appBanInfo) updater.init((state) => pushToRenderer('update', state))
    notifier.subscribe((n) => pushToRenderer('notification', n))

    pushBoot()
    pushRooms()
  })

  app.on('before-quit', () => {
    folderLock.stop()
    net.stop()
  })

  app.on('window-all-closed', () => {
    // The integrity window closing ends the app; the main window never
    // really closes (it hides to tray).
    if (getIntegrityWindow()) app.exit(0)
  })
}
