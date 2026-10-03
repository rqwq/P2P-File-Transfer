import Database from 'better-sqlite3'
import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import type { WireBanEntry } from '../../shared/worker'

// Creator-authoritative ban list (spec 7.2/7.3). One SQLite DB per room
// the user owns, private to the creator — never shared in full with
// regular members. Entries merge additively via a structured upsert
// keyed by target identity + timestamp, so concurrent moderator bans
// never conflict.

export interface BanRow extends WireBanEntry {}

class BanStore {
  private dbs = new Map<string, Database.Database>()

  private db(roomId: string): Database.Database {
    let db = this.dbs.get(roomId)
    if (db) return db
    const dir = path.join(app.getPath('userData'), 'bans')
    fs.mkdirSync(dir, { recursive: true })
    db = new Database(path.join(dir, `${roomId}.db`))
    db.pragma('journal_mode = WAL')
    db.exec(`
      CREATE TABLE IF NOT EXISTS bans (
        targetKey TEXT NOT NULL,
        hwid TEXT NOT NULL,
        ip TEXT NOT NULL,
        reason TEXT NOT NULL,
        adminName TEXT NOT NULL,
        adminKey TEXT NOT NULL,
        expiresAt INTEGER,
        createdAt INTEGER NOT NULL,
        PRIMARY KEY (targetKey, createdAt)
      );
      CREATE INDEX IF NOT EXISTS idx_bans_hwid ON bans (hwid);
      CREATE INDEX IF NOT EXISTS idx_bans_ip ON bans (ip);
    `)
    // Migration: unbans used to delete the row; now they mark it inactive
    // so the banned/unbanned history stays visible in the ban manager.
    try {
      db.prepare('ALTER TABLE bans ADD COLUMN unbannedAt INTEGER').run()
    } catch {
      // column already exists
    }
    this.dbs.set(roomId, db)
    return db
  }

  // Additive merge (spec 7.2): keyed upsert on target + timestamp.
  upsert(roomId: string, entry: WireBanEntry): void {
    this.db(roomId)
      .prepare(
        `INSERT INTO bans (targetKey, hwid, ip, reason, adminName, adminKey, expiresAt, createdAt)
         VALUES (@targetKey, @hwid, @ip, @reason, @adminName, @adminKey, @expiresAt, @createdAt)
         ON CONFLICT (targetKey, createdAt) DO UPDATE SET
           reason = excluded.reason, adminName = excluded.adminName,
           adminKey = excluded.adminKey, expiresAt = excluded.expiresAt`
      )
      .run(entry)
  }

  // Ban matching is HWID OR IP (spec 4.3) — a match on either field is
  // sufficient to reject. NAT false positives are an accepted trade-off.
  // Explicitly unbanned entries never match.
  checkBanned(roomId: string, hwid: string, ip: string): WireBanEntry | null {
    const now = Date.now()
    const row = this.db(roomId)
      .prepare(
        `SELECT * FROM bans
         WHERE (hwid = ? OR (? <> '' AND ip = ?))
           AND (expiresAt IS NULL OR expiresAt > ?)
           AND unbannedAt IS NULL
         ORDER BY createdAt DESC LIMIT 1`
      )
      .get(hwid, ip, ip, now) as WireBanEntry | undefined
    return row ?? null
  }

  listActive(roomId: string): WireBanEntry[] {
    const now = Date.now()
    return this.db(roomId)
      .prepare(
        'SELECT * FROM bans WHERE (expiresAt IS NULL OR expiresAt > ?) AND unbannedAt IS NULL ORDER BY createdAt DESC'
      )
      .all(now) as WireBanEntry[]
  }

  // Full history for the ban manager: active bans first (red), then
  // unbanned/expired (green) — kept permanently.
  listAll(roomId: string): (WireBanEntry & { unbannedAt: number | null })[] {
    return this.db(roomId)
      .prepare('SELECT * FROM bans ORDER BY unbannedAt IS NOT NULL, createdAt DESC')
      .all() as (WireBanEntry & { unbannedAt: number | null })[]
  }

  // Soft unban: the row stays (green in the manager), but stops matching.
  unban(roomId: string, targetKey: string): void {
    this.db(roomId).prepare('UPDATE bans SET unbannedAt = ? WHERE targetKey = ? AND unbannedAt IS NULL').run(Date.now(), targetKey)
  }

  wipe(roomId: string): void {
    const db = this.dbs.get(roomId)
    if (db) {
      try {
        db.close()
      } catch {
        // already closed
      }
      this.dbs.delete(roomId)
    }
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        fs.unlinkSync(path.join(app.getPath('userData'), 'bans', `${roomId}.db${suffix}`))
      } catch {
        // not present
      }
    }
  }
}

export const banStore = new BanStore()
