import type { RoomState, RoomSummary, RoomSettings, MemberView, BadgeInfo, Role } from '../shared/api'
import type { WireRoomSettings } from '../shared/worker'
import { BADGES, isAppModHwid, isDeveloperHwid, RESERVED_HASH_B64, RESERVED_NAME_B64, SUSPECTED } from '../shared/constants'
import { roomsDb } from './db/rooms'

// Live room state composition: the roster cache + room settings come from
// the worker's roster broadcasts (persisted in rooms.db), presence comes
// from the worker's per-connection events. The renderer's RoomState views
// are always built here.

// Decoded once: the owner's reserved identity (name + HWID hash) is what
// earns the cyan Verified badge — and the official app-moderator hammer.
const RESERVED_NAME = Buffer.from(RESERVED_NAME_B64, 'base64').toString('utf8')
const RESERVED_HWID = Buffer.from(RESERVED_HASH_B64, 'base64').toString('utf8')

// Badge order: app-wide badges first (Developer, App Moderator, Verified),
// room roles after, Suspected before Untrusted last.
export function computeBadges(m: { name: string; role: Role; hwid: string; untrusted: number }): BadgeInfo[] {
  const out: BadgeInfo[] = []
  if (isDeveloperHwid(m.hwid, RESERVED_HWID)) out.push({ id: 'developer', ...BADGES.developer })
  if (isAppModHwid(m.hwid, RESERVED_HWID)) out.push({ id: 'appMod', ...BADGES.appMod })
  if (m.hwid === RESERVED_HWID || m.name === RESERVED_NAME) out.push({ id: 'official', ...BADGES.official })
  if (m.role === 'creator') out.push({ id: 'creator', ...BADGES.creator })
  if (m.role === 'admin') out.push({ id: 'admin', ...BADGES.admin })
  if (m.role === 'moderator') out.push({ id: 'moderator', ...BADGES.moderator })
  // Suspected: merge the build-time SUSPECTED list (authoritative, in
  // src/shared/constants.ts) with this machine's runtime suspicion log.
  // Suspicious rows are append-only — `marked` turns the badge red →
  // orange ("past suspicions", all reasons in the hover tooltip).
  {
    const code = SUSPECTED.find((s) => s.hwid === m.hwid)
    const local = roomsDb.suspicionsFor(m.hwid)
    if (code || local.length > 0) {
      const reasons: string[] = [...(code?.reasons ?? [])]
      for (const r of local) if (!reasons.includes(r.reason)) reasons.push(r.reason)
      const marked = code ? code.marked === true : local.every((r) => r.marked === 1)
      out.push({
        id: 'suspected',
        name: BADGES.suspected.name,
        description: marked
          ? `Past suspicions: ${reasons.join('; ')}`
          : `This user is suspected of ${reasons.join('; ')}.`,
        variant: marked ? 'marked' : undefined
      })
    }
  }
  if (m.untrusted === 1) out.push({ id: 'untrusted', ...BADGES.untrusted })
  return out
}

// Badges of an app-ban issuer: every issuer is by definition an official
// app moderator (the wire path pre-verifies them); the reserved owner
// additionally carries the Verified badge.
export function appBanIssuerBadges(byHwid: string | null): BadgeInfo[] {
  const out: BadgeInfo[] = [{ id: 'appMod', ...BADGES.appMod }]
  if (byHwid && byHwid === RESERVED_HWID) out.push({ id: 'official', ...BADGES.official })
  return out
}

export function isStaffRole(role: Role | undefined, isCreator: boolean): boolean {
  return isCreator || role === 'admin' || role === 'moderator'
}

class RoomStateCache {
  private presence = new Map<string, Map<string, { online: boolean; ip: string | null }>>()
  private roomSettings = new Map<string, WireRoomSettings>()
  // Own availability (footer toggle). You are always "online to yourself"
  // while available — presence events only exist for remote peers.
  private selfOnline = true

  setPresence(roomId: string, key: string, online: boolean, ip: string | null): void {
    let room = this.presence.get(roomId)
    if (!room) {
      room = new Map()
      this.presence.set(roomId, room)
    }
    room.set(key, { online, ip })
  }

  dropPresence(roomId: string, key: string): void {
    this.presence.get(roomId)?.delete(key)
  }

  presenceMap(roomId: string): Map<string, { online: boolean; ip: string | null }> {
    return this.presence.get(roomId) ?? new Map()
  }

  onlineSets(roomIds: string[]): Map<string, Set<string>> {
    const out = new Map<string, Set<string>>()
    for (const roomId of roomIds) {
      const set = new Set<string>()
      const peers = this.presence.get(roomId)
      if (peers) {
        for (const [key, info] of peers) if (info.online) set.add(key)
      }
      if (this.selfOnline && myPublicKey) set.add(myPublicKey)
      out.set(roomId, set)
    }
    return out
  }

  peerIp(roomId: string, key: string): string | null {
    return this.presence.get(roomId)?.get(key)?.ip ?? null
  }

  dropRoom(roomId: string): void {
    this.presence.delete(roomId)
    this.roomSettings.delete(roomId)
  }

  isOnline(roomId: string, key: string): boolean {
    if (key === myPublicKey && this.selfOnline) return true
    return this.presence.get(roomId)?.get(key)?.online ?? false
  }

  setSelfOnline(online: boolean): void {
    this.selfOnline = online
  }

  setRoomSettings(roomId: string, s: WireRoomSettings): void {
    this.roomSettings.set(roomId, s)
  }

  getRoomSettings(roomId: string): WireRoomSettings | null {
    return this.roomSettings.get(roomId) ?? null
  }

  buildRoomState(roomId: string): RoomState | null {
    const room = roomsDb.getRoom(roomId)
    if (!room) return null
    const wireSettings = this.roomSettings.get(roomId)
    const myKey = myPublicKey
    const members: MemberView[] = roomsDb.listMembers(roomId).map((m) => ({
      key: m.key,
      name: m.name,
      role: m.role,
      online: this.isOnline(roomId, m.key),
      isMe: m.key === myKey,
      lastSeen: m.lastSeen,
      badges: computeBadges(m)
    }))
    const onlineCount = members.filter((m) => m.online).length
    const roomSettingsView: RoomSettings = wireSettings
      ? {
          name: wireSettings.name,
          memberCap: wireSettings.memberCap,
          chatLimits: wireSettings.chatLimits,
          transport: wireSettings.transport,
          vpnIp: wireSettings.vpnIp,
          vpnPort: wireSettings.vpnPort
        }
      : {
          name: room.name,
          memberCap: null,
          chatLimits: { textLength: 500, imageBytes: 5 * 1024 * 1024, videoBytes: 10 * 1024 * 1024, audioBytes: 2 * 1024 * 1024 },
          transport: room.transport,
          vpnIp: room.vpnIp,
          vpnPort: room.vpnPort
        }
    const myRole = members.find((m) => m.isMe)?.role ?? 'member'
    return {
      room: {
        roomId,
        name: room.name,
        code: room.code,
        isCreator: room.isCreator,
        transport: room.transport,
        memberCount: members.length,
        onlineCount,
        joinState: 'member',
        appReason: null
      } satisfies RoomSummary,
      settings: roomSettingsView,
      members,
      isStaff: room.isCreator || myRole === 'admin' || myRole === 'moderator'
    }
  }
}

// Filled by index.ts once the worker reports its public key.
export let myPublicKey = ''
export function setMyPublicKey(key: string): void {
  myPublicKey = key
}

export const roomStateCache = new RoomStateCache()
