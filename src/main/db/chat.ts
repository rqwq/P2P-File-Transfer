import Database from 'better-sqlite3'
import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import type { ChatMessageView } from '../../shared/api'

// Per-room chat DB (spec 9). Every member stores the room's messages
// locally; attachments up to the room's size limits are stored as blobs
// in the same DB. Merges are always INSERT OR IGNORE by message id —
// never one side overwriting the other.

export interface StoredMessage {
  id: string
  ts: number
  senderKey: string
  senderName: string
  text: string
  attachment: { name: string; mime: string; size: number } | null
  blob: Buffer | null
}

// Upper bound on manifest entries. Must fit a control frame: ~55 bytes
// per [uuid, ts] pair, and encodeControl refuses JSON over 512KB — a
// 20k-entry manifest (~1MB) would throw at send time. 8k messages is far
// beyond any real room and stays inside the frame budget.
const MANIFEST_CAP = 8_000

class ChatStore {
  private dbs = new Map<string, Database.Database>()

  private db(roomId: string): Database.Database {
    let db = this.dbs.get(roomId)
    if (db) return db
    const dir = path.join(app.getPath('userData'), 'chats')
    fs.mkdirSync(dir, { recursive: true })
    db = new Database(path.join(dir, `${roomId}.db`))
    db.pragma('journal_mode = WAL')
    db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        ts INTEGER NOT NULL,
        senderKey TEXT NOT NULL,
        senderName TEXT NOT NULL,
        text TEXT NOT NULL,
        attName TEXT,
        attMime TEXT,
        attSize INTEGER,
        attBlob BLOB
      );
      CREATE INDEX IF NOT EXISTS idx_messages_ts ON messages (ts);
    `)
    this.dbs.set(roomId, db)
    return db
  }

  store(roomId: string, msg: StoredMessage): boolean {
    const db = this.db(roomId)
    const res = db
      .prepare(
        `INSERT OR IGNORE INTO messages (id, ts, senderKey, senderName, text, attName, attMime, attSize, attBlob)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        msg.id,
        msg.ts,
        msg.senderKey,
        msg.senderName,
        msg.text,
        msg.attachment?.name ?? null,
        msg.attachment?.mime ?? null,
        msg.attachment?.size ?? null,
        msg.blob ?? null
      )
    return res.changes > 0
  }

  manifest(roomId: string): [string, number][] {
    const rows = this.db(roomId)
      .prepare(`SELECT id, ts FROM (
         SELECT id, ts FROM messages ORDER BY ts DESC, id DESC LIMIT ${MANIFEST_CAP}
       ) ORDER BY ts ASC, id ASC`)
      .all() as { id: string; ts: number }[]
    return rows.map((r) => [r.id, r.ts])
  }

  pull(roomId: string, ids: string[]): StoredMessage[] {
    if (ids.length === 0) return []
    const db = this.db(roomId)
    const out: StoredMessage[] = []
    const stmt = db.prepare(
      'SELECT * FROM messages WHERE id = ?'
    )
    for (const id of ids) {
      const row = stmt.get(id) as
        | {
            id: string
            ts: number
            senderKey: string
            senderName: string
            text: string
            attName: string | null
            attMime: string | null
            attSize: number | null
            attBlob: Buffer | null
          }
        | undefined
      if (!row) continue
      out.push({
        id: row.id,
        ts: row.ts,
        senderKey: row.senderKey,
        senderName: row.senderName,
        text: row.text,
        attachment:
          row.attName && row.attMime && row.attSize !== null
            ? { name: row.attName, mime: row.attMime, size: row.attSize }
            : null,
        blob: row.attBlob ?? null
      })
    }
    return out
  }

  log(roomId: string, limit: number): ChatMessageView[] {
    const rows = this.db(roomId)
      .prepare(
        'SELECT id, ts, senderKey, senderName, text, attName, attMime, attSize FROM messages ORDER BY ts DESC, id DESC LIMIT ?'
      )
      .all(limit) as {
      id: string
      ts: number
      senderKey: string
      senderName: string
      text: string
      attName: string | null
      attMime: string | null
      attSize: number | null
    }[]
    return rows
      .reverse()
      .map((r) => ({
        id: r.id,
        ts: r.ts,
        senderKey: r.senderKey,
        senderName: r.senderName,
        text: r.text,
        attachment:
          r.attName && r.attMime && r.attSize !== null
            ? { name: r.attName, mime: r.attMime, size: r.attSize }
            : null,
        hasAttachmentBlob: r.attName !== null
      }))
  }

  attachmentBlob(roomId: string, messageId: string): Buffer | null {
    const row = this.db(roomId)
      .prepare('SELECT attBlob FROM messages WHERE id = ?')
      .get(messageId) as { attBlob: Buffer | null } | undefined
    return row?.attBlob ?? null
  }

  countMissing(roomId: string, ids: string[]): number {
    if (ids.length === 0) return 0
    const db = this.db(roomId)
    const stmt = db.prepare('SELECT 1 FROM messages WHERE id = ?')
    let missing = 0
    for (const id of ids) if (stmt.get(id) === undefined) missing++
    return missing
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
        fs.unlinkSync(path.join(app.getPath('userData'), 'chats', `${roomId}.db${suffix}`))
      } catch {
        // not present
      }
    }
  }
}

export const chatStore = new ChatStore()
