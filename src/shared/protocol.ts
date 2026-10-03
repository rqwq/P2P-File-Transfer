import { z } from 'zod'

// Wire protocol (spec Section 11). Every control message is validated
// against its Zod schema before any field is used — never JSON.parse +
// trust. Binary frames carry a small JSON header validated the same way.

export const peerKeySchema = z.string().regex(/^[0-9a-f]{64}$/)
export const hwidSchema = z.string().regex(/^[0-9A-F]{64}$/)
export const sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/)
export const uuidSchema = z.string().regex(
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
)

// Build identity advertised in hello/join_request: pv = wire protocol
// version (a mismatch means different app builds → untrusted + group
// ban), bid = opaque build stamp for diagnostics/logs.
export const buildIdSchema = z.string().max(64)

export const chatLimitsSchema = z.object({
  textLength: z.number().int().min(1).max(20_000),
  imageBytes: z.number().int().min(0).max(100 * 1024 * 1024),
  videoBytes: z.number().int().min(0).max(100 * 1024 * 1024),
  audioBytes: z.number().int().min(0).max(100 * 1024 * 1024)
})

export const roomSettingsWireSchema = z.object({
  name: z.string().min(1).max(64),
  memberCap: z.number().int().min(0).max(1000).nullable(),
  chatLimits: chatLimitsSchema,
  transport: z.enum(['dht', 'vpn']),
  vpnIp: z.string().max(64).nullable(),
  vpnPort: z.number().int().min(1).max(65_535).nullable()
})

export const memberWireSchema = z.object({
  key: peerKeySchema,
  name: z.string().min(1).max(64),
  role: z.enum(['creator', 'admin', 'moderator', 'member']),
  hwid: hwidSchema,
  joinedAt: z.number(),
  lastSeen: z.number(),
  // Set by the room creator when the peer was caught advertising a
  // mismatched app build (protocol version differs). Old rosters simply
  // omit it.
  untrusted: z.boolean().optional()
})

// One application-center row as it travels mod → creator (sync) and
// between staff builds. The applicant itself never sees rows, only the
// resulting join_accept/join_reject.
export const applicationWireSchema = z.object({
  applicantKey: peerKeySchema,
  name: z.string().min(1).max(64),
  hwid: hwidSchema,
  status: z.enum(['pending', 'approved', 'rejected']),
  reason: z.string().max(500).nullable(),
  decidedByName: z.string().max(64).nullable(),
  decidedAt: z.number().nullable(),
  createdAt: z.number(),
  pv: z.number().int().optional(),
  bid: buildIdSchema.optional()
})

// App-level ban (issued only by hardcoded APP_MOD_HWIDS identities).
// Every receiver self-checks the hwid, persists the entry and rebroadcasts
// it — enforcement is each client refusing itself, nothing more.
export const appBanWireSchema = z.object({
  targetKey: peerKeySchema,
  hwid: hwidSchema,
  reason: z.string().max(500),
  byName: z.string().max(64),
  byHwid: hwidSchema,
  until: z.number().nullable(),
  issuedAt: z.number()
})

export const offerFileWireSchema = z.object({
  id: z.number().int().min(0),
  relPath: z.string().min(1).max(1024),
  size: z.number().int().min(0),
  risky: z.boolean()
})

export const attachmentMetaWireSchema = z.object({
  name: z.string().min(1).max(255),
  mime: z.string().min(1).max(128),
  size: z.number().int().min(0)
})

export const chatMessageWireSchema = z.object({
  id: uuidSchema,
  ts: z.number().int().min(0),
  text: z.string().max(20_000),
  attachment: attachmentMetaWireSchema.nullable()
})

export const banEntryWireSchema = z.object({
  targetKey: peerKeySchema,
  hwid: hwidSchema,
  ip: z.string().max(64),
  reason: z.string().max(500),
  adminName: z.string().max(64),
  adminKey: peerKeySchema,
  expiresAt: z.number().nullable(),
  createdAt: z.number()
})

export type ControlMessage = z.infer<typeof controlMessageSchema>

export const controlMessageSchema = z.discriminatedUnion('t', [
  // First frame on every fresh connection: identifies the peer and the
  // room context (null while handshaking a join).
  z.object({
    t: z.literal('hello'),
    v: z.literal(1),
    key: peerKeySchema,
    name: z.string().min(1).max(64),
    hwid: hwidSchema,
    room: z.string().max(128).nullable(),
    pv: z.number().int(),
    bid: buildIdSchema
  }),
  z.object({
    t: z.literal('join_request'),
    code: z.string().min(5).max(128),
    key: peerKeySchema,
    name: z.string().min(1).max(64),
    hwid: hwidSchema,
    pv: z.number().int(),
    bid: buildIdSchema
  }),
  z.object({
    t: z.literal('join_accept'),
    roomId: z.string().max(128),
    room: roomSettingsWireSchema,
    members: z.array(memberWireSchema).max(1000)
  }),
  z.object({
    t: z.literal('join_reject'),
    reason: z.string().max(500),
    ban: z
      .object({
        reason: z.string().max(500),
        adminName: z.string().max(64),
        expiresAt: z.number().nullable()
      })
      .nullable()
  }),
  z.object({
    t: z.literal('roster_update'),
    roomId: z.string().max(128),
    room: roomSettingsWireSchema,
    members: z.array(memberWireSchema).max(1000)
  }),
  z.object({
    t: z.literal('presence'),
    roomId: z.string().max(128),
    key: peerKeySchema,
    online: z.boolean()
  }),
  z.object({
    t: z.literal('chat'),
    roomId: z.string().max(128),
    senderKey: peerKeySchema,
    senderName: z.string().min(1).max(64),
    msg: chatMessageWireSchema
  }),
  z.object({
    t: z.literal('chat_manifest'),
    roomId: z.string().max(128),
    entries: z.array(z.tuple([uuidSchema, z.number()])).max(20_000)
  }),
  z.object({
    t: z.literal('chat_pull'),
    roomId: z.string().max(128),
    ids: z.array(uuidSchema).max(5_000)
  }),
  z.object({
    t: z.literal('chat_messages'),
    roomId: z.string().max(128),
    senderKey: peerKeySchema,
    senderName: z.string().min(1).max(64),
    messages: z.array(chatMessageWireSchema).max(500),
    // ids of messages in this batch that carry an attachment blob
    attachmentIds: z.array(uuidSchema).max(500)
  }),
  z.object({
    t: z.literal('transfer_offer'),
    taskId: z.string().min(8).max(64),
    roomId: z.string().max(128),
    senderKey: peerKeySchema,
    senderName: z.string().min(1).max(64),
    receiverKey: peerKeySchema,
    files: z.array(offerFileWireSchema).min(1).max(10_000),
    totalSize: z.number().int().min(0)
  }),
  z.object({
    t: z.literal('transfer_response'),
    taskId: z.string().min(8).max(64),
    accept: z.boolean(),
    speedCapBps: z.number().int().min(0).nullable()
  }),
  z.object({
    t: z.literal('transfer_state'),
    taskId: z.string().min(8).max(64),
    state: z.enum(['paused', 'resumed', 'cancelled', 'failed', 'completed']),
    error: z.string().max(256).nullable()
  }),
  z.object({
    t: z.literal('transfer_cap'),
    taskId: z.string().min(8).max(64),
    speedCapBps: z.number().int().min(0).nullable()
  }),
  z.object({
    t: z.literal('transfer_resume'),
    taskId: z.string().min(8).max(64),
    files: z
      .array(
        z.object({
          id: z.number().int().min(0),
          bitmap: z.string().max(200_000)
        })
      )
      .max(10_000)
  }),
  z.object({
    t: z.literal('chunk_ack'),
    taskId: z.string().min(8).max(64),
    fileId: z.number().int().min(0),
    chunkIdx: z.number().int().min(0),
    bad: z.boolean()
  }),
  z.object({
    t: z.literal('file_done'),
    taskId: z.string().min(8).max(64),
    fileId: z.number().int().min(0),
    sha256: sha256HexSchema,
    bytes: z.number().int().min(0)
  }),
  // Room-wide task telemetry (spec 8.6). Deliberately carries no paths or
  // filenames: non-participants must never be able to see them, so the
  // redaction is enforced at the protocol layer, not the UI layer.
  z.object({
    t: z.literal('task_update'),
    taskId: z.string().min(8).max(64),
    roomId: z.string().max(128),
    senderKey: peerKeySchema,
    receiverKey: peerKeySchema,
    total: z.number().int().min(0),
    done: z.number().int().min(0),
    fileCount: z.number().int().min(0),
    state: z.enum(['active', 'paused', 'waiting-lock', 'completed', 'failed', 'cancelled'])
  }),
  z.object({
    t: z.literal('ban'),
    roomId: z.string().max(128),
    entry: banEntryWireSchema
  }),
  z.object({
    t: z.literal('unban'),
    roomId: z.string().max(128),
    targetKey: peerKeySchema
  }),
  z.object({
    t: z.literal('ban_sync_request'),
    roomId: z.string().max(128)
  }),
  z.object({
    t: z.literal('ban_sync'),
    roomId: z.string().max(128),
    entries: z.array(banEntryWireSchema).max(10_000)
  }),
  z.object({
    t: z.literal('role_change'),
    roomId: z.string().max(128),
    key: peerKeySchema,
    role: z.enum(['admin', 'moderator', 'member'])
  }),
  // Sent by a member that explicitly left the room; the creator reacts by
  // removing them from the authoritative roster and re-broadcasting it.
  z.object({
    t: z.literal('member_left'),
    roomId: z.string().max(128),
    key: peerKeySchema
  }),
  // Application-center sync (creator ⇄ staff): the creator pulls the
  // staff member's locally captured applications; the reply carries them.
  z.object({
    t: z.literal('app_sync_request'),
    roomId: z.string().max(128)
  }),
  z.object({
    t: z.literal('app_sync'),
    roomId: z.string().max(128),
    entries: z.array(applicationWireSchema).max(1000)
  }),
  // Broadcast by any peer that sees a roster member advertising a
  // mismatched protocol version; the room creator enforces it (auto
  // group-ban + untrusted flag). Reports about non-members are ignored.
  z.object({
    t: z.literal('untrust_report'),
    roomId: z.string().max(128),
    targetKey: peerKeySchema,
    theirPv: z.number().int(),
    theirBid: buildIdSchema
  }),
  z.object({
    t: z.literal('app_ban'),
    ...appBanWireSchema.shape
  }),
  z.object({
    t: z.literal('invite'),
    roomId: z.string().max(128),
    roomName: z.string().min(1).max(64),
    code: z.string().min(5).max(128),
    from: z.string().min(1).max(64),
    fromKey: peerKeySchema,
    targetKey: peerKeySchema
  }),
  z.object({ t: z.literal('ping'), nonce: z.number().int().min(0) }),
  z.object({ t: z.literal('pong'), nonce: z.number().int().min(0) }),
  z.object({
    t: z.literal('vpn_info'),
    roomId: z.string().max(128),
    ip: z.string().min(3).max(64),
    port: z.number().int().min(1).max(65_535)
  }),
  z.object({
    t: z.literal('preview_request'),
    taskId: z.string().min(8).max(64),
    fileId: z.number().int().min(0)
  }),
  z.object({
    t: z.literal('preview_meta'),
    taskId: z.string().min(8).max(64),
    fileId: z.number().int().min(0),
    size: z.number().int().min(0),
    mime: z.string().max(128)
  }),
  z.object({
    t: z.literal('preview_error'),
    taskId: z.string().min(8).max(64),
    fileId: z.number().int().min(0),
    code: z.enum(['not_enough_memory', 'unavailable'])
  })
])

// ---- Binary frames: [u32 length][u8 type][u16 headerLen][header JSON][data]

export const FRAME_CONTROL = 0x01
export const FRAME_CHUNK = 0x10
export const FRAME_PREVIEW = 0x11
export const FRAME_ATTACHMENT = 0x12

export const chunkHeaderSchema = z.object({
  taskId: z.string().min(8).max(64),
  fileId: z.number().int().min(0),
  chunkIdx: z.number().int().min(0),
  sha256: sha256HexSchema
})

export const previewHeaderSchema = z.object({
  taskId: z.string().min(8).max(64),
  fileId: z.number().int().min(0),
  seq: z.number().int().min(0),
  eof: z.boolean()
})

export const attachmentHeaderSchema = z.object({
  chatId: uuidSchema,
  size: z.number().int().min(0)
})
