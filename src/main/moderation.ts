import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import { parseBanDuration } from '../shared/durations'
import { NAME_TAKEN_ERROR, PROTOCOL_VERSION, ROLE_RANK } from '../shared/constants'
import type { BanEntryView, BadgeInfo, TrustPrompt } from '../shared/api'
import type { WireBanEntry } from '../shared/worker'
import { banStore } from './db/bans'
import { chatStore } from './db/chat'
import { roomsDb } from './db/rooms'
import { roomStateCache, myPublicKey } from './roomState'
import type { NetClient } from './netClient'

// Moderation glue (spec 7): the ban check runs FIRST on any join attempt,
// bans are creator-authoritative with an offline-mod outbox that syncs on
// the creator's reconnect ping, and being banned wipes all room-local data.

interface PendingTrust {
  prompt: TrustPrompt
  resolve: (accept: boolean) => void
  promise: Promise<boolean>
}

export class Moderation {
  private net: NetClient
  private pendingTrust = new Map<string, PendingTrust>()
  private pushTrust: ((prompt: TrustPrompt) => void) | null = null
  private pushBanned: ((roomId: string, roomName: string, reason: string, adminName: string, adminBadges: BadgeInfo[], expiresAt: number | null) => void) | null = null
  private log: ((msg: string) => void) | null = null
  private refreshRoom: ((roomId: string) => void) | null = null

  constructor(net: NetClient) {
    this.net = net
  }

  bind(
    pushTrust: (prompt: TrustPrompt) => void,
    pushBanned: (roomId: string, roomName: string, reason: string, adminName: string, adminBadges: BadgeInfo[], expiresAt: number | null) => void,
    log: (msg: string) => void,
    refreshRoom?: (roomId: string) => void
  ): void {
    this.pushTrust = pushTrust
    this.pushBanned = pushBanned
    this.log = log
    this.refreshRoom = refreshRoom ?? null
  }

  // ---- join admission (creator side) ----
  //
  // Joins are INSTANT: anyone with the code gets in, and their typed join
  // reason is recorded in the application center (the join log). The only
  // automatic rejections are bans, modified builds and name clashes.
  // A banned applicant receives the full ban entry on the wire, which
  // their app renders as the blocking ban screen.

  async admitJoin(
    roomId: string,
    joiner: { key: string; name: string; hwid: string; ip: string; pv: number; bid: string },
    joinReason: string
  ): Promise<{ allow: boolean; reason: string; ban: WireBanEntry | null }> {
    const room = roomsDb.getRoom(roomId)
    if (!room || !room.isCreator) {
      return { allow: false, reason: 'you are not the room creator', ban: null }
    }
    // Ban-list check (HWID and/or IP, spec 4.3/7.3) before any roster,
    // chat, or other room data is exchanged. The full entry goes back on
    // the wire so the applicant's app shows the ban screen immediately.
    const banned = banStore.checkBanned(roomId, joiner.hwid, joiner.ip)
    if (banned) {
      // Banned join attempts stay visible in the join log.
      this.upsertApplication(roomId, joiner, 'banned', `banned: ${banned.reason || 'no reason given'}`)
      return {
        allow: false,
        reason: `you are banned from this room — ${banned.reason || 'no reason given'}`,
        ban: banned
      }
    }
    // Build check (roles & systems spec): a peer advertising a different
    // wire protocol version is running a modified/patched build — auto
    // group-ban, flag as untrusted, log it in the join log.
    if (joiner.pv !== PROTOCOL_VERSION) {
      const reason = `modified app build (protocol v${joiner.pv} ≠ v${PROTOCOL_VERSION})`
      const entry: WireBanEntry = {
        targetKey: joiner.key,
        hwid: joiner.hwid,
        ip: joiner.ip,
        reason,
        adminName: this.myName(),
        adminKey: myPublicKey,
        expiresAt: null,
        createdAt: Date.now()
      }
      this.issueBan(roomId, myPublicKey, this.myName(), joiner.key, 'perm', reason, true, joiner.hwid)
      roomsDb.markUntrusted(roomId, joiner.key, true)
      this.upsertApplication(roomId, joiner, 'banned', reason)
      this.log?.(`auto-banned ${joiner.name} (${joiner.key.slice(0, 8)}) — ${reason} [build ${joiner.bid}]`)
      return { allow: false, reason: `you are banned from this room — ${reason}`, ban: entry }
    }
    // A previously rejected application answers instantly with the
    // typed-out rejection reason — no round-trip.
    const app = roomsDb.getApplication(roomId, joiner.key)
    if (app && app.status === 'rejected') {
      const reason = app.reason ?? 'application rejected'
      return { allow: false, reason: `application rejected — ${reason}`, ban: null }
    }
    // No two members of a room may share a display name (case-insensitive);
    // reconnecting members keep their own name, hence the key exclusion.
    const wanted = joiner.name.trim().toLowerCase()
    const clash = roomsDb
      .listMembers(roomId)
      .find((m) => m.key !== joiner.key && m.name.trim().toLowerCase() === wanted)
    if (clash) {
      return { allow: false, reason: NAME_TAKEN_ERROR, ban: null }
    }
    const wireSettings = roomStateCache.getRoomSettings(roomId)
    const memberCount = roomsDb.listMembers(roomId).length
    if (wireSettings?.memberCap && memberCount >= wireSettings.memberCap) {
      return { allow: false, reason: 'room is full', ban: null }
    }
    if (roomsDb.getMember(roomId, joiner.key)) {
      // Already a member (reconnect/rejoin, or an approved application
      // from while this peer was offline) — straight in, no prompt.
      if (app && app.status === 'pending') this.upsertApplication(roomId, joiner, 'approved', null)
      return { allow: true, reason: '', ban: null }
    }
    // Instant join: record the join reason in the log (the application
    // center's whole purpose) and trust the member — with no Admit
    // prompt there is no other point where the creator side learns to
    // trust the key on reconnects.
    this.upsertApplication(roomId, joiner, 'approved', joinReason.trim() || null, 'instant join')
    roomsDb.setTrusted(joiner.key, joiner.name)
    this.log?.(`${joiner.name} (${joiner.key.slice(0, 8)}) joined — ${joinReason.trim() || 'no reason given'}`)
    return { allow: true, reason: '', ban: null }
  }

  // ---- application center ----

  // Store/refresh one application row; a decision already recorded is
  // never overwritten by a later pending resubmission.
  private upsertApplication(
    roomId: string,
    applicant: { key: string; name: string; hwid: string; ip: string; pv: number; bid: string },
    status: 'pending' | 'approved' | 'rejected' | 'banned',
    reason: string | null,
    decidedBy?: string
  ): void {
    roomsDb.upsertApplication({
      roomId,
      applicantKey: applicant.key,
      name: applicant.name,
      hwid: applicant.hwid,
      status,
      reason,
      decidedByName: status === 'pending' ? null : (decidedBy ?? this.myName()),
      decidedAt: status === 'pending' ? null : Date.now(),
      createdAt: roomsDb.getApplication(roomId, applicant.key)?.createdAt ?? Date.now(),
      pv: applicant.pv,
      bid: applicant.bid
    })
    this.refreshRoom?.(roomId)
  }

  listApplications(roomId: string): import('../shared/api').ApplicationView[] {
    return roomsDb.listApplications(roomId).map((a) => ({
      applicantKey: a.applicantKey,
      name: a.name,
      status: a.status,
      reason: a.reason,
      decidedBy: a.decidedByName,
      decidedAt: a.decidedAt,
      createdAt: a.createdAt
    }))
  }

  // Staff decision from the application center. Approving writes the
  // applicant straight into the roster, so their next reconnect
  // auto-admits them even if they are offline right now. Rejecting
  // requires a typed-out reason.
  decideApplication(
    roomId: string,
    applicantKey: string,
    approve: boolean,
    reason: string,
    byName: string
  ): { ok: boolean; error: string | null } {
    const room = roomsDb.getRoom(roomId)
    if (!room?.isCreator) return { ok: false, error: 'Only the room creator reviews applications.' }
    const app = roomsDb.getApplication(roomId, applicantKey)
    if (!app) return { ok: false, error: 'Application not found.' }
    if (!approve && reason.trim().length === 0) return { ok: false, error: 'Type out a rejection reason.' }
    const status = approve ? 'approved' : 'rejected'
    roomsDb.upsertApplication({
      ...app,
      status,
      reason: approve ? null : reason.trim(),
      decidedByName: byName,
      decidedAt: Date.now()
    })
    if (approve) {
      roomsDb.upsertMember({
        roomId,
        key: app.applicantKey,
        name: app.name,
        role: 'member',
        hwid: app.hwid,
        joinedAt: Date.now(),
        lastSeen: Date.now(),
        untrusted: 0
      })
      roomsDb.setTrusted(app.applicantKey, app.name)
    }
    this.log?.(`application ${status}: ${app.name} (${app.applicantKey.slice(0, 8)}) by ${byName}${approve ? '' : ` — ${reason.trim()}`}`)
    this.refreshRoom?.(roomId)
    return { ok: true, error: null }
  }

  // Peer-delivered application rows (staff → creator sync). Decisions
  // already made locally win; pending rows update contact details.
  mergeApplication(
    roomId: string,
    entry: {
      applicantKey: string
      name: string
      hwid: string
      status: 'pending' | 'approved' | 'rejected' | 'banned'
      reason: string | null
      decidedByName: string | null
      decidedAt: number | null
      createdAt: number
      pv?: number
      bid?: string
    }
  ): void {
    const local = roomsDb.getApplication(roomId, entry.applicantKey)
    if (local && local.status !== 'pending') return
    roomsDb.upsertApplication({
      roomId,
      applicantKey: entry.applicantKey,
      name: entry.name,
      hwid: entry.hwid,
      status: entry.status,
      reason: entry.reason,
      decidedByName: entry.decidedByName,
      decidedAt: entry.decidedAt,
      createdAt: entry.createdAt,
      pv: entry.pv ?? null,
      bid: entry.bid ?? null
    })
    if (entry.status === 'approved') {
      roomsDb.upsertMember({
        roomId,
        key: entry.applicantKey,
        name: entry.name,
        role: 'member',
        hwid: entry.hwid,
        joinedAt: entry.decidedAt ?? entry.createdAt,
        lastSeen: entry.decidedAt ?? entry.createdAt,
        untrusted: 0
      })
    }
    this.refreshRoom?.(roomId)
  }

  promptTrust(prompt: TrustPrompt): Promise<boolean> {
    // A joiner re-sends its join_request every few seconds while the
    // prompt is up; every retry must await the SAME decision. Resolving
    // duplicates with `false` made the creator side auto-decline the
    // join seconds after the prompt appeared.
    const existing = this.pendingTrust.get(prompt.key)
    if (existing) return existing.promise
    let resolve!: (accept: boolean) => void
    const promise = new Promise<boolean>((res) => {
      resolve = res
    })
    this.pendingTrust.set(prompt.key, { prompt, resolve, promise })
    this.pushTrust?.(prompt)
    return promise
  }

  respondTrust(key: string, accept: boolean): void {
    const pending = this.pendingTrust.get(key)
    if (pending) {
      this.pendingTrust.delete(key)
      if (accept) roomsDb.setTrusted(key, this.lookupName(key))
      pending.resolve(accept)
      // A join application answered via the prompt is logged in the
      // application center like any other decision.
      if (pending.prompt.kind === 'join' && pending.prompt.roomId) {
        const roomId = pending.prompt.roomId
        const app = roomsDb.getApplication(roomId, key)
        if (app && app.status === 'pending') {
          const status = accept ? 'approved' : 'rejected'
          roomsDb.upsertApplication({
            ...app,
            status,
            reason: accept ? null : 'join request declined',
            decidedByName: this.myName(),
            decidedAt: Date.now()
          })
          if (accept) {
            roomsDb.upsertMember({
              roomId,
              key: app.applicantKey,
              name: app.name,
              role: 'member',
              hwid: app.hwid,
              joinedAt: Date.now(),
              lastSeen: Date.now(),
              untrusted: 0
            })
          }
          this.refreshRoom?.(roomId)
        }
      }
    }
    // The worker blocks peer messages until it hears the decision (for
    // join prompts this is redundant but harmless — the admitJoin reply
    // carries the outcome).
    this.net.send({ kind: 'trust:respond', key, accept, roomId: null })
  }

  // A generic first-contact peer prompt (existing member meeting a newly
  // joined peer, or vice versa) routed through the same pending registry
  // so the UI has one prompt flow.
  promptPeerTrust(prompt: TrustPrompt): void {
    this.pushTrust?.(prompt)
  }

  isTrustPending(key: string): boolean {
    return this.pendingTrust.has(key)
  }

  private lookupName(key: string): string {
    for (const room of roomsDb.listRooms()) {
      const m = roomsDb.getMember(room.roomId, key)
      if (m) return m.name
    }
    return 'unknown peer'
  }

  // ---- ban issuance ----

  issueBan(
    roomId: string,
    issuerKey: string,
    issuerName: string,
    targetKey: string,
    durationText: string,
    reason: string,
    isCreator: boolean,
    targetHwid?: string
  ): { ok: boolean; error: string | null } {
    const parsed = parseBanDuration(durationText)
    if (!parsed) return { ok: false, error: 'invalid duration (examples: 23d, 1y 30d 1m, perm)' }
    // The room creator is immune to bans — a moderator banning the
    // creator used to wipe the room's data on the creator's own machine
    // and break the room from inside.
    if (targetKey === roomId) return { ok: false, error: 'The room creator cannot be banned.' }
    const target = roomsDb.getMember(roomId, targetKey)
    // Rank rules: an issuer can only ban strictly below their own role
    // (creator > admin > moderator > member). Bans for unknown keys are
    // allowed only with an explicit HWID (protocol-violation auto-bans).
    const issuer = roomsDb.getMember(roomId, issuerKey)
    const issuerRole = isCreator ? 'creator' : issuer?.role ?? 'member'
    const targetRole = target?.role ?? 'member'
    if (ROLE_RANK[issuerRole] <= ROLE_RANK[targetRole]) {
      return { ok: false, error: 'You can only ban members below your role.' }
    }
    if (!target && !targetHwid) {
      return { ok: false, error: 'member not found' }
    }
    const entry: WireBanEntry = {
      targetKey,
      hwid: target?.hwid ?? targetHwid ?? '',
      ip: roomStateCache.peerIp(roomId, targetKey) ?? '',
      reason: reason.trim() || 'no reason given',
      adminName: issuerName,
      adminKey: issuerKey,
      expiresAt: parsed.expiresAt,
      createdAt: Date.now()
    }
    if (isCreator) {
      banStore.upsert(roomId, entry)
    } else {
      // Moderator/admin ban while the creator may be offline (spec 7.2):
      // cache locally, merge into the creator's authoritative DB on
      // reconnect.
      roomsDb.pushOutboxBan(roomId, JSON.stringify(entry))
    }
    this.applyLocalBan(roomId, entry)
    this.net.send({ kind: 'mod:ban', roomId, entry })
    return { ok: true, error: null }
  }

  applyLocalBan(roomId: string, entry: WireBanEntry): void {
    roomsDb.upsertLocalBan({
      roomId,
      targetKey: entry.targetKey,
      reason: entry.reason,
      adminName: entry.adminName,
      adminKey: entry.adminKey,
      expiresAt: entry.expiresAt
    })
  }

  // Creator merges a moderator's synced entries (additive upsert, spec 7.2).
  mergeBans(roomId: string, entries: WireBanEntry[]): void {
    for (const e of entries) banStore.upsert(roomId, e)
  }

  // Outbox for ban_sync responses; cleared once handed to the creator.
  outboxBans(roomId: string): WireBanEntry[] {
    const rows = roomsDb.listOutboxBans(roomId)
    const out: WireBanEntry[] = []
    for (const r of rows) {
      try {
        out.push(JSON.parse(r.json) as WireBanEntry)
      } catch {
        this.log?.(`dropping corrupt outbox ban ${r.id}`)
      }
    }
    return out
  }

  clearOutbox(roomId: string): void {
    roomsDb.clearOutboxBans(roomId)
  }

  issueUnban(roomId: string, targetKey: string, isCreator: boolean): { ok: boolean; error: string | null } {
    if (isCreator) banStore.unban(roomId, targetKey)
    roomsDb.removeLocalBan(roomId, targetKey)
    this.net.send({ kind: 'mod:unban', roomId, targetKey })
    return { ok: true, error: null }
  }

  listBans(roomId: string, isCreator: boolean): BanEntryView[] {
    const nameOf = (key: string): string => {
      const m = roomsDb.getMember(roomId, key)
      return m?.name ?? key.slice(0, 8)
    }
    if (isCreator) {
      // Full permanent history for the ban manager: active (red) above
      // unbanned/expired (green), decided by the ORDER BY in listAll.
      return banStore.listAll(roomId).map((b) => ({
        targetKey: b.targetKey,
        targetName: nameOf(b.targetKey),
        reason: b.reason,
        adminName: b.adminName,
        createdAt: b.createdAt,
        expiresAt: b.expiresAt,
        active: b.unbannedAt === null && (b.expiresAt === null || b.expiresAt > Date.now())
      }))
    }
    // The ban list is never shared in full with regular members or other
    // peers (spec 7.2): moderators see only their own cached entries.
    const me = myPublicKey
    return roomsDb
      .listLocalBans()
      .filter((b) => b.roomId === roomId && b.adminKey === me)
      .map((b) => ({
        targetKey: b.targetKey,
        targetName: nameOf(b.targetKey),
        reason: b.reason,
        adminName: b.adminName,
        createdAt: 0,
        expiresAt: b.expiresAt,
        active: b.expiresAt === null || b.expiresAt > Date.now()
      }))
  }

  private myName(): string {
    for (const room of roomsDb.listRooms()) {
      const me = roomsDb.getMember(room.roomId, myPublicKey)
      if (me) return me.name
    }
    return 'staff'
  }

  // ---- ban applied to me: wipe everything room-local (spec 7.5) ----

  handleBanned(roomId: string, reason: string, adminName: string, adminBadges: BadgeInfo[], expiresAt: number | null): void {
    const room = roomsDb.getRoom(roomId)
    const roomName = room?.name ?? 'room'
    this.wipeRoom(roomId)
    this.pushBanned?.(roomId, roomName, reason, adminName, adminBadges, expiresAt)
  }

  wipeRoom(roomId: string): void {
    roomsDb.deleteRoom(roomId)
    chatStore.wipe(roomId)
    // Remove persisted transfer states for the room.
    const dir = path.join(app.getPath('userData'), 'transfers')
    try {
      for (const name of fs.readdirSync(dir)) {
        if (!name.endsWith('.json')) continue
        const p = path.join(dir, name)
        try {
          const st = JSON.parse(fs.readFileSync(p, 'utf8')) as { roomId?: string }
          if (st.roomId === roomId) fs.unlinkSync(p)
        } catch {
          // unreadable state — leave it
        }
      }
    } catch {
      // transfers dir missing — nothing to clean
    }
    roomStateCache.dropRoom(roomId)
    this.log?.(`wiped all local data for room ${roomId}`)
  }
}
