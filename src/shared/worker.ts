// Main <-> net-worker envelopes (utilityProcess MessagePort, structured
// clone). These are internal to the app; the hostile-trust boundary is the
// P2P wire protocol (validated in shared/protocol.ts inside the worker).
// Requests carry an id and are answered with a {kind:'reply'} envelope.

import type { TaskView, TrustPrompt, OfferView } from './api'
import type { ControlMessage } from './protocol'

export interface WireMember {
  key: string
  name: string
  role: 'creator' | 'admin' | 'moderator' | 'member'
  hwid: string
  joinedAt: number
  lastSeen: number
  untrusted?: boolean
}

export interface WireRoomSettings {
  name: string
  memberCap: number | null
  chatLimits: { textLength: number; imageBytes: number; videoBytes: number; audioBytes: number }
  transport: 'dht' | 'vpn'
  vpnIp: string | null
  vpnPort: number | null
}

export interface WireBanEntry {
  targetKey: string
  hwid: string
  ip: string
  reason: string
  adminName: string
  adminKey: string
  expiresAt: number | null
  createdAt: number
}

export interface AdapterInfo {
  name: string
  ip: string
  kind: 'radmin' | 'hamachi' | 'other'
}

// ---- Main -> Worker ----

// Reply to a worker-initiated request (WorkerRequest), correlated by id.
export interface MainReply {
  kind: 'reply'
  id: number
  ok: boolean
  result: unknown
}

export type MainToWorker =
  | MainReply
  | { kind: 'identity'; name: string; hwid: string; maxSpeedBps: number | null }
  | { kind: 'room:create'; name: string; memberCap: number | null; transport: 'dht' | 'vpn'; vpnIp: string | null; id?: number }
  | { kind: 'room:join'; code: string; id?: number }
  | { kind: 'room:leave'; roomId: string }
  | { kind: 'room:updateSettings'; roomId: string; settings: Partial<WireRoomSettings> }
  | { kind: 'room:pushRoster'; roomId: string; members: WireMember[]; settings: WireRoomSettings }
  | { kind: 'room:vpnAdapter'; roomId: string; ip: string | null }
  | {
      kind: 'chat:send'
      roomId: string
      id: string
      ts: number
      text: string
      attachment: { name: string; mime: string; size: number; blob: Uint8Array } | null
    }
  | { kind: 'trust:respond'; key: string; accept: boolean; roomId: string | null }
  | { kind: 'mod:ban'; roomId: string; entry: WireBanEntry }
  | { kind: 'mod:unban'; roomId: string; targetKey: string }
  | { kind: 'mod:setRole'; roomId: string; targetKey: string; role: 'admin' | 'moderator' | 'member' }
  | {
      kind: 'app:banSend'
      roomId: string
      targetKey: string
      hwid: string
      reason: string
      until: number | null
    }
  | {
      kind: 'transfer:offer'
      taskId: string
      roomId: string
      receiverKey: string
      files: { id: number; relPath: string; size: number; risky: boolean }[]
      totalSize: number
      label: string
    }
  | { kind: 'transfer:respond'; taskId: string; accept: boolean; speedCapBps: number | null; error: string | null }
  | { kind: 'transfer:control'; taskId: string; action: 'pause' | 'resume' | 'cancel' }
  | { kind: 'transfer:setCap'; taskId: string; speedCapBps: number | null }
  | {
      kind: 'transfer:reattach'
      tasks: {
        taskId: string
        roomId: string
        receiverKey: string
        files: { id: number; relPath: string; size: number; risky: boolean }[]
        totalSize: number
        label: string
      }[]
    }
  | { kind: 'preview:request'; taskId: string; fileId: number }
  | { kind: 'invite:send'; roomId: string; roomName: string; code: string; targetKey: string }
  | { kind: 'settings:speed'; maxSpeedBps: number | null }
  | { kind: 'availability:set'; online: boolean }
  | { kind: 'trust:known'; keys: string[] }
  | { kind: 'bans:local'; bans: { roomId: string; targetKey: string }[] }
  | {
      kind: 'rooms:restore'
      rooms: { roomId: string; code: string; transport: 'dht' | 'vpn'; vpnIp: string | null; pending: boolean }[]
    }
  | {
      kind: 'keypair:init'
      keyPair: { publicKey: string; secretKey: string } | null
    }

// ---- Worker -> Main: requests (need a reply) ----

export type WorkerRequest =
  | {
      kind: 'mod:admitJoin'
      roomId: string
      joiner: { key: string; name: string; hwid: string; ip: string; pv: number; bid: string }
      id: number
    }
  | { kind: 'mod:outbox'; roomId: string; id: number }
  | { kind: 'chat:getManifest'; roomId: string; id: number }
  | {
      kind: 'chat:storeMessages'
      roomId: string
      senderKey: string
      senderName: string
      messages: { id: string; ts: number; text: string; attachment: { name: string; mime: string; size: number } | null; blob: Uint8Array | null }[]
      id: number
    }
  | { kind: 'chat:pullBatch'; roomId: string; ids: string[]; id: number }
  | { kind: 'mod:applications'; roomId: string; id: number }
  | { kind: 'transfer:beginFile'; taskId: string; fileId: number; id: number }
  | { kind: 'transfer:writeChunk'; taskId: string; fileId: number; chunkIdx: number; data: Uint8Array; id: number }
  | { kind: 'transfer:needChunk'; taskId: string; fileId: number; chunkIdx: number; id: number }
  | { kind: 'transfer:resumeState'; taskId: string; id: number }
  | { kind: 'transfer:finishFile'; taskId: string; fileId: number; sha256: string; bytes: number; id: number }
  | { kind: 'transfer:hashFile'; taskId: string; fileId: number; id: number }
  | { kind: 'preview:readFile'; taskId: string; fileId: number; id: number }

// ---- Worker -> Main: events (no reply) ----

export type WorkerEvent =
  | { kind: 'ready'; publicKey: string }
  | { kind: 'room:state'; roomId: string; code: string; settings: WireRoomSettings; isCreator: boolean }
  | { kind: 'roster'; roomId: string; members: WireMember[]; settings: WireRoomSettings }
  | { kind: 'presence'; roomId: string; key: string; online: boolean; ip: string | null }
  | { kind: 'chat:message'; roomId: string; senderKey: string; senderName: string; msg: { id: string; ts: number; text: string; attachment: { name: string; mime: string; size: number } | null }; blob: Uint8Array | null }
  | { kind: 'trust:prompt'; prompt: TrustPrompt }
  | { kind: 'offer:incoming'; offer: OfferView }
  | { kind: 'tasks:snapshot'; roomId: string; tasks: TaskView[] }
  | { kind: 'transfer:cleanup'; taskId: string }
  | { kind: 'banned'; roomId: string; ban: { reason: string; adminName: string; adminKey: string; expiresAt: number | null } }
  | { kind: 'invite:received'; roomId: string; roomName: string; code: string; from: string; fromKey: string }
  | { kind: 'invite:relay'; roomId: string; roomName: string; code: string; from: string; fromKey: string; targetKey: string }
  | { kind: 'ban:applied'; roomId: string; entry: WireBanEntry }
  | { kind: 'ban:removed'; roomId: string; targetKey: string }
  | { kind: 'ban:sync'; roomId: string; entries: WireBanEntry[] }
  | { kind: 'role:changed'; roomId: string; key: string; role: 'admin' | 'moderator' | 'member' }
  | { kind: 'member:left'; roomId: string; key: string }
  // A join application arrived at a staff member (stored in the
  // application center; the creator decides).
  | { kind: 'app:submitted'; roomId: string; applicant: { key: string; name: string; hwid: string; ip: string; pv: number; bid: string } }
  // A member was seen advertising a mismatched app build.
  | { kind: 'untrust:report'; roomId: string; targetKey: string; theirPv: number; theirBid: string }
  // The join window expired without a decision — the room goes to the
  // applicant's list as "pending" and keeps retrying in the background.
  | { kind: 'room:pending'; roomId: string; code: string }
  // A peer-delivered app ban arrived (already verified against
  // APP_MOD_HWIDS by the worker). Main persists it and self-enforces if
  // the target is this machine.
  | { kind: 'appBan:received'; entry: { targetKey: string; hwid: string; reason: string; byName: string; byHwid: string; until: number | null; issuedAt: number } }
  // Application rows synced from a staff member to the creator (or the
  // creator's merged log pushed to a staff member).
  | {
      kind: 'app:sync'
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
    }
  | { kind: 'joinWire'; roomId: string; fromKey: string; msg: ControlMessage }
  | { kind: 'transferWire'; roomId: string; fromKey: string; msg: ControlMessage }
  | {
      kind: 'transferBinary'
      roomId: string
      fromKey: string
      frameType: number
      header: Uint8Array
      data: Uint8Array
    }
  | { kind: 'preview:received'; taskId: string; fileId: number; mime: string; size: number; data: Uint8Array | null; error: 'not_enough_memory' | 'unavailable' | null }
  | { kind: 'adapters'; adapters: AdapterInfo[] }
  | { kind: 'net:log'; level: 'info' | 'warn' | 'error'; msg: string }
  | { kind: 'join:failed'; reason: string }

export type WorkerToMain =
  | WorkerRequest
  | WorkerEvent
  | { kind: 'keypair:created'; publicKey: string; secretKey: string }
  | { kind: 'reply'; id: number; ok: boolean; result: unknown; error: string | null }

// Re-exported so the worker can route validated wire control messages
// through to main without re-declaring the type.
export type WireControl = ControlMessage
