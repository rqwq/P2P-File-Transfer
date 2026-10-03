import Database from 'better-sqlite3'
import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import type { Role, RoomSummary, Transport } from '../../shared/api'

// rooms.db — the local room registry: joined rooms, roster caches,
// per-peer trust (TOFU), invites, locally-applied bans and the
// moderator's offline-ban outbox. One DB, owned by the main process.

export interface RoomRow {
  roomId: string
  name: string
  code: string
  isCreator: boolean
  transport: Transport
  vpnIp: string | null
  vpnPort: number | null
  createdAt: number
}

export interface MemberRow {
  roomId: string
  key: string
  name: string
  role: Role
  hwid: string
  joinedAt: number
  lastSeen: number
  untrusted: number
}

export interface ApplicationRow {
  roomId: string
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
}

export interface PendingRoomRow {
  code: string
  roomId: string
  name: string
  status: 'pending' | 'rejected'
  reason: string | null
  createdAt: number
}

export interface AppBanRow {
  hwid: string
  targetKey: string
  reason: string
  byName: string
  byHwid: string
  until: number | null
  issuedAt: number
}

export interface InviteRow {
  id: string
  roomId: string
  roomName: string
  code: string
  fromName: string
  fromKey: string
  receivedAt: number
  handled: boolean
}

export interface RelayRow {
  id: number
  roomId: string
  roomName: string
  code: string
  fromName: string
  fromKey: string
  targetKey: string
}

export interface LocalBanRow {
  roomId: string
  targetKey: string
  reason: string
  adminName: string
  adminKey: string
  expiresAt: number | null
}

class RoomsDb {
  private db!: Database.Database

  init(): void {
    const dir = app.getPath('userData')
    fs.mkdirSync(dir, { recursive: true })
    this.db = new Database(path.join(dir, 'rooms.db'))
    this.db.pragma('journal_mode = WAL')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS rooms (
        roomId TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        code TEXT NOT NULL,
        isCreator INTEGER NOT NULL DEFAULT 0,
        transport TEXT NOT NULL DEFAULT 'dht',
        vpnIp TEXT,
        vpnPort INTEGER,
        createdAt INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS members (
        roomId TEXT NOT NULL,
        key TEXT NOT NULL,
        name TEXT NOT NULL,
        role TEXT NOT NULL,
        hwid TEXT NOT NULL,
        joinedAt INTEGER NOT NULL,
        lastSeen INTEGER NOT NULL,
        untrusted INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (roomId, key)
      );
      CREATE TABLE IF NOT EXISTS applications (
        roomId TEXT NOT NULL,
        applicantKey TEXT NOT NULL,
        name TEXT NOT NULL,
        hwid TEXT NOT NULL,
        status TEXT NOT NULL,
        reason TEXT,
        decidedByName TEXT,
        decidedAt INTEGER,
        createdAt INTEGER NOT NULL,
        pv INTEGER,
        bid TEXT,
        PRIMARY KEY (roomId, applicantKey)
      );
      CREATE TABLE IF NOT EXISTS pendingRooms (
        code TEXT PRIMARY KEY,
        roomId TEXT NOT NULL,
        name TEXT NOT NULL,
        status TEXT NOT NULL,
        reason TEXT,
        createdAt INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS appBans (
        hwid TEXT PRIMARY KEY,
        targetKey TEXT NOT NULL,
        reason TEXT NOT NULL,
        byName TEXT NOT NULL,
        byHwid TEXT NOT NULL,
        until INTEGER,
        issuedAt INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS trust (
        key TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS invites (
        id TEXT PRIMARY KEY,
        roomId TEXT NOT NULL,
        roomName TEXT NOT NULL,
        code TEXT NOT NULL,
        fromName TEXT NOT NULL,
        fromKey TEXT NOT NULL,
        receivedAt INTEGER NOT NULL,
        handled INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS relayQueue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        roomId TEXT NOT NULL,
        roomName TEXT NOT NULL,
        code TEXT NOT NULL,
        fromName TEXT NOT NULL,
        fromKey TEXT NOT NULL,
        targetKey TEXT NOT NULL,
        addedAt INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS outboxBans (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        roomId TEXT NOT NULL,
        json TEXT NOT NULL,
        createdAt INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS roomPrefs (
        roomId TEXT PRIMARY KEY,
        vpnIp TEXT
      );
      CREATE TABLE IF NOT EXISTS roomBans (
        roomId TEXT NOT NULL,
        targetKey TEXT NOT NULL,
        reason TEXT NOT NULL,
        adminName TEXT NOT NULL,
        adminKey TEXT NOT NULL DEFAULT '',
        expiresAt INTEGER,
        PRIMARY KEY (roomId, targetKey)
      );
    `)
    // Migration: databases created before the roles rework have no
    // `untrusted` column on members.
    try {
      this.db.prepare('ALTER TABLE members ADD COLUMN untrusted INTEGER NOT NULL DEFAULT 0').run()
    } catch {
      // column already exists
    }
  }

  // ---- rooms ----

  upsertRoom(row: Omit<RoomRow, 'createdAt'> & { createdAt?: number }): RoomRow {
    const now = Date.now()
    this.db
      .prepare(
        `INSERT INTO rooms (roomId, name, code, isCreator, transport, vpnIp, vpnPort, createdAt)
         VALUES (@roomId, @name, @code, @isCreator, @transport, @vpnIp, @vpnPort, @createdAt)
         ON CONFLICT (roomId) DO UPDATE SET
           name = excluded.name, code = excluded.code, isCreator = excluded.isCreator,
           transport = excluded.transport, vpnIp = excluded.vpnIp, vpnPort = excluded.vpnPort`
      )
      // Callers carry isCreator as a boolean (RoomRow), but SQLite only
      // binds numbers — normalize at the boundary.
      .run({ ...row, isCreator: row.isCreator ? 1 : 0, createdAt: row.createdAt ?? now })
    return this.getRoom(row.roomId) as RoomRow
  }

  getRoom(roomId: string): RoomRow | null {
    const row = this.db.prepare('SELECT * FROM rooms WHERE roomId = ?').get(roomId) as
      | (Omit<RoomRow, 'isCreator'> & { isCreator: number })
      | undefined
    if (!row) return null
    return { ...row, isCreator: row.isCreator === 1 }
  }

  listRooms(): RoomRow[] {
    const rows = this.db
      .prepare('SELECT * FROM rooms ORDER BY createdAt DESC')
      .all() as (Omit<RoomRow, 'isCreator'> & { isCreator: number })[]
    return rows.map((r) => ({ ...r, isCreator: r.isCreator === 1 }))
  }

  deleteRoom(roomId: string): void {
    const tx = this.db.transaction(() => {
      this.db.prepare('DELETE FROM rooms WHERE roomId = ?').run(roomId)
      this.db.prepare('DELETE FROM members WHERE roomId = ?').run(roomId)
      this.db.prepare('DELETE FROM roomPrefs WHERE roomId = ?').run(roomId)
      this.db.prepare('DELETE FROM roomBans WHERE roomId = ?').run(roomId)
      this.db.prepare('DELETE FROM relayQueue WHERE roomId = ?').run(roomId)
      this.db.prepare('DELETE FROM outboxBans WHERE roomId = ?').run(roomId)
      this.db.prepare('DELETE FROM applications WHERE roomId = ?').run(roomId)
      this.db.prepare('DELETE FROM pendingRooms WHERE roomId = ?').run(roomId)
    })
    tx()
  }

  // ---- members (roster cache) ----

  upsertMember(m: MemberRow): void {
    this.db
      .prepare(
        `INSERT INTO members (roomId, key, name, role, hwid, joinedAt, lastSeen, untrusted)
         VALUES (@roomId, @key, @name, @role, @hwid, @joinedAt, @lastSeen, @untrusted)
         ON CONFLICT (roomId, key) DO UPDATE SET
           name = excluded.name, role = excluded.role, hwid = excluded.hwid, lastSeen = excluded.lastSeen`
      )
      // untrusted is deliberately NOT updated on conflict: it is set only
      // by markUntrusted / roster pulls, never accidentally reset to 0.
      .run({ ...m, untrusted: m.untrusted ?? 0 })
  }

  markUntrusted(roomId: string, key: string, untrusted: boolean): void {
    this.db.prepare('UPDATE members SET untrusted = ? WHERE roomId = ? AND key = ?').run(untrusted ? 1 : 0, roomId, key)
  }

  // Roster replace: incoming wire members carry untrusted as an optional
  // boolean; normalize to the DB's 0/1 at the boundary.
  upsertMembers(roomId: string, members: (Omit<MemberRow, 'roomId' | 'untrusted'> & { untrusted?: boolean | number })[]): void {
    const tx = this.db.transaction(() => {
      this.db.prepare('DELETE FROM members WHERE roomId = ?').run(roomId)
      for (const m of members) {
        this.upsertMember({ ...m, roomId, untrusted: m.untrusted ? 1 : 0 } as MemberRow)
      }
    })
    tx()
  }

  listMembers(roomId: string): MemberRow[] {
    return this.db.prepare('SELECT * FROM members WHERE roomId = ?').all(roomId) as MemberRow[]
  }

  getMember(roomId: string, key: string): MemberRow | null {
    return (
      (this.db
        .prepare('SELECT * FROM members WHERE roomId = ? AND key = ?')
        .get(roomId, key) as MemberRow | undefined) ?? null
    )
  }

  // ---- trust (TOFU, global per peer key) ----

  isTrusted(key: string): boolean {
    return this.db.prepare('SELECT 1 FROM trust WHERE key = ?').get(key) !== undefined
  }

  setTrusted(key: string, name: string): void {
    this.db
      .prepare(
        'INSERT INTO trust (key, name, at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET name = excluded.name'
      )
      .run(key, name, Date.now())
  }

  listTrusted(): { key: string; name: string }[] {
    return this.db.prepare('SELECT key, name FROM trust').all() as { key: string; name: string }[]
  }

  // ---- invites ----

  addInvite(inv: InviteRow): void {
    this.db
      .prepare(
        `INSERT INTO invites (id, roomId, roomName, code, fromName, fromKey, receivedAt, handled)
         VALUES (@id, @roomId, @roomName, @code, @fromName, @fromKey, @receivedAt, 0)
         ON CONFLICT (id) DO NOTHING`
      )
      .run(inv)
  }

  listInvites(includeHandled = false): InviteRow[] {
    return this.db
      .prepare('SELECT * FROM invites WHERE handled = 0 OR ? ORDER BY receivedAt DESC')
      .all(includeHandled ? 1 : 0) as InviteRow[]
  }

  markInviteHandled(id: string): void {
    this.db.prepare('UPDATE invites SET handled = 1 WHERE id = ?').run(id)
  }

  // ---- invite relay queue ----

  addRelay(row: Omit<RelayRow, 'id'>): void {
    const dupe = this.db
      .prepare('SELECT 1 FROM relayQueue WHERE roomId = ? AND targetKey = ?')
      .get(row.roomId, row.targetKey)
    if (dupe) return
    this.db
      .prepare(
        'INSERT INTO relayQueue (roomId, roomName, code, fromName, fromKey, targetKey, addedAt) VALUES (?, ?, ?, ?, ?, ?, ?)'
      )
      .run(row.roomId, row.roomName, row.code, row.fromName, row.fromKey, row.targetKey, Date.now())
  }

  relaysFor(targetKey: string): RelayRow[] {
    return this.db
      .prepare('SELECT * FROM relayQueue WHERE targetKey = ?')
      .all(targetKey) as RelayRow[]
  }

  deleteRelay(id: number): void {
    this.db.prepare('DELETE FROM relayQueue WHERE id = ?').run(id)
  }

  // ---- moderator offline-ban outbox (spec 7.2) ----

  pushOutboxBan(roomId: string, json: string): void {
    this.db
      .prepare('INSERT INTO outboxBans (roomId, json, createdAt) VALUES (?, ?, ?)')
      .run(roomId, json, Date.now())
  }

  listOutboxBans(roomId: string): { id: number; json: string }[] {
    return this.db
      .prepare('SELECT id, json FROM outboxBans WHERE roomId = ?')
      .all(roomId) as { id: number; json: string }[]
  }

  clearOutboxBans(roomId: string): void {
    this.db.prepare('DELETE FROM outboxBans WHERE roomId = ?').run(roomId)
  }

  // ---- per-room local prefs ----

  setRoomVpnIp(roomId: string, ip: string | null): void {
    this.db
      .prepare('INSERT INTO roomPrefs (roomId, vpnIp) VALUES (?, ?) ON CONFLICT (roomId) DO UPDATE SET vpnIp = excluded.vpnIp')
      .run(roomId, ip)
  }

  getRoomVpnIp(roomId: string): string | null {
    const row = this.db.prepare('SELECT vpnIp FROM roomPrefs WHERE roomId = ?').get(roomId) as
      | { vpnIp: string | null }
      | undefined
    return row?.vpnIp ?? null
  }

  // ---- locally-applied bans (from broadcasts; used to gate reconnects) ----

  upsertLocalBan(row: LocalBanRow): void {
    this.db
      .prepare(
        `INSERT INTO roomBans (roomId, targetKey, reason, adminName, adminKey, expiresAt)
         VALUES (@roomId, @targetKey, @reason, @adminName, @adminKey, @expiresAt)
         ON CONFLICT (roomId, targetKey) DO UPDATE SET
           reason = excluded.reason, adminName = excluded.adminName,
           adminKey = excluded.adminKey, expiresAt = excluded.expiresAt`
      )
      .run(row)
  }

  removeLocalBan(roomId: string, targetKey: string): void {
    this.db.prepare('DELETE FROM roomBans WHERE roomId = ? AND targetKey = ?').run(roomId, targetKey)
  }

  listLocalBans(): (LocalBanRow & { targetKey: string; roomId: string })[] {
    return this.db
      .prepare(
        'SELECT roomId, targetKey, reason, adminName, adminKey, expiresAt FROM roomBans WHERE expiresAt IS NULL OR expiresAt > ?'
      )
      .all(Date.now()) as (LocalBanRow & { targetKey: string; roomId: string })[]
  }

  // ---- application center (join applications; staff side) ----

  getApplication(roomId: string, applicantKey: string): ApplicationRow | null {
    return (
      (this.db
        .prepare('SELECT * FROM applications WHERE roomId = ? AND applicantKey = ?')
        .get(roomId, applicantKey) as ApplicationRow | undefined) ?? null
    )
  }

  upsertApplication(row: ApplicationRow): void {
    this.db
      .prepare(
        `INSERT INTO applications (roomId, applicantKey, name, hwid, status, reason, decidedByName, decidedAt, createdAt, pv, bid)
         VALUES (@roomId, @applicantKey, @name, @hwid, @status, @reason, @decidedByName, @decidedAt, @createdAt, @pv, @bid)
         ON CONFLICT (roomId, applicantKey) DO UPDATE SET
           name = excluded.name, hwid = excluded.hwid, pv = excluded.pv, bid = excluded.bid,
           status = CASE WHEN applications.status = 'pending' THEN excluded.status ELSE applications.status END,
           reason = CASE WHEN applications.status = 'pending' THEN excluded.reason ELSE applications.reason END,
           decidedByName = CASE WHEN applications.status = 'pending' THEN excluded.decidedByName ELSE applications.decidedByName END,
           decidedAt = CASE WHEN applications.status = 'pending' THEN excluded.decidedAt ELSE applications.decidedAt END`
      )
      .run(row)
  }

  listApplications(roomId: string): ApplicationRow[] {
    return this.db
      .prepare(
        `SELECT * FROM applications WHERE roomId = ?
         ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END, COALESCE(decidedAt, createdAt) DESC`
      )
      .all(roomId) as ApplicationRow[]
  }

  // ---- pending rooms (applicant side: applied, not yet accepted) ----

  upsertPendingRoom(row: Omit<PendingRoomRow, 'createdAt'> & { createdAt?: number }): void {
    this.db
      .prepare(
        `INSERT INTO pendingRooms (code, roomId, name, status, reason, createdAt)
         VALUES (@code, @roomId, @name, @status, @reason, @createdAt)
         ON CONFLICT (code) DO UPDATE SET
           status = excluded.status, reason = excluded.reason, name = excluded.name`
      )
      .run({ ...row, createdAt: row.createdAt ?? Date.now() })
  }

  listPendingRooms(): PendingRoomRow[] {
    return this.db
      .prepare('SELECT * FROM pendingRooms ORDER BY createdAt DESC')
      .all() as PendingRoomRow[]
  }

  markPendingRejected(code: string, reason: string): void {
    this.db
      .prepare("UPDATE pendingRooms SET status = 'rejected', reason = ? WHERE code = ?")
      .run(reason, code)
  }

  getPendingByRoom(roomId: string): PendingRoomRow | null {
    return (
      (this.db.prepare('SELECT * FROM pendingRooms WHERE roomId = ?').get(roomId) as PendingRoomRow | undefined) ?? null
    )
  }

  deletePendingRoom(code: string): void {
    this.db.prepare('DELETE FROM pendingRooms WHERE code = ?').run(code)
  }

  deletePendingByRoom(roomId: string): void {
    this.db.prepare('DELETE FROM pendingRooms WHERE roomId = ?').run(roomId)
  }

  // ---- app-level bans (self-enforced) ----

  upsertAppBan(row: AppBanRow): void {
    // A newer ban replaces an older one for the same HWID; unban arrives
    // as a null-expiry reversal? No — unban at app level is a new build
    // decision; peer bans simply overwrite.
    this.db
      .prepare(
        `INSERT INTO appBans (hwid, targetKey, reason, byName, byHwid, until, issuedAt)
         VALUES (@hwid, @targetKey, @reason, @byName, @byHwid, @until, @issuedAt)
         ON CONFLICT (hwid) DO UPDATE SET
           reason = excluded.reason, byName = excluded.byName, byHwid = excluded.byHwid,
           until = excluded.until, issuedAt = excluded.issuedAt, targetKey = excluded.targetKey`
      )
      .run(row)
  }

  getAppBanByHwid(hwid: string): AppBanRow | null {
    const row = this.db.prepare('SELECT * FROM appBans WHERE hwid = ?').get(hwid) as
      | AppBanRow
      | undefined
    if (!row) return null
    if (row.until !== null && row.until <= Date.now()) return null
    return row
  }

  // ---- summary view for the renderer ----

  summaries(presence: Map<string, Set<string>>): RoomSummary[] {
    return this.listRooms().map((r) => {
      const onlineCount = presence.get(r.roomId)?.size ?? 0
      return {
        roomId: r.roomId,
        name: r.name,
        code: r.code,
        isCreator: r.isCreator,
        transport: r.transport,
        memberCount: this.listMembers(r.roomId).length,
        onlineCount,
        joinState: 'member' as const,
        appReason: null
      }
    })
  }

  // Pending/rejected applications rendered as room cards with hidden
  // member data ("unavailable" until accepted).
  pendingSummaries(): RoomSummary[] {
    return this.listPendingRooms().map((p) => ({
      roomId: p.roomId,
      name: p.name,
      code: p.code,
      isCreator: false,
      transport: 'dht' as const,
      memberCount: 0,
      onlineCount: 0,
      joinState: p.status,
      appReason: p.reason
    }))
  }
}

export const roomsDb = new RoomsDb()
