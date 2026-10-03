// ---------------------------------------------------------------------------
// View models (main -> renderer). The renderer never sees wire types.
// ---------------------------------------------------------------------------

export type Role = 'creator' | 'admin' | 'moderator' | 'member'
export type Transport = 'dht' | 'vpn'
export type TaskState = 'active' | 'paused' | 'waiting-lock' | 'completed' | 'failed' | 'cancelled'

// Badges computed in the main process (they depend on the member's HWID,
// which the renderer never sees): order matters — special app-wide badges
// first, room roles after, untrusted last.
export interface BadgeInfo {
  id: import('./constants').BadgeId
  name: string
  description: string
}

export interface ChatLimits {
  textLength: number
  imageBytes: number
  videoBytes: number
  audioBytes: number
}

export interface RoomSettings {
  name: string
  memberCap: number | null
  chatLimits: ChatLimits
  transport: Transport
  vpnIp: string | null
  vpnPort: number | null
}

export interface Settings {
  displayName: string
  receiveFolder: string
  maxSimultaneousTransfers: number | null
  maxTransferSpeedBps: number | null
}

// app:updateSettings result: on a rejected display name the settings come
// back unchanged and `error` carries the exact rejection reason.
export interface SettingsUpdateResult {
  settings: Settings
  error: string | null
}

export interface BootState {
  stage: 'loading' | 'hwidMismatch' | 'appBanned' | 'setup' | 'ready'
  settings: Settings
  version: string
  hwidRebuildError: string | null
  // Authoritative session availability. The renderer must inherit it on
  // every (re)load — its store resets to "online", while main may still be
  // suspended from a toggle before the reload.
  online: boolean
  // Set when stage === 'appBanned' (build-time blocklist or a
  // peer-delivered app ban matched this machine's HWID).
  appBan: AppBanInfo | null
}

export interface MemberView {
  key: string
  name: string
  role: Role
  online: boolean
  isMe: boolean
  lastSeen: number
  badges: BadgeInfo[]
}

// member: fully joined · pending: application submitted, waiting for
// staff · rejected: application was declined (appReason carries the
// typed-out rejection reason).
export type JoinState = 'member' | 'pending' | 'rejected'

export interface RoomSummary {
  roomId: string
  name: string
  code: string
  isCreator: boolean
  transport: Transport
  memberCount: number
  onlineCount: number
  joinState: JoinState
  appReason: string | null
}

export interface RoomState {
  room: RoomSummary
  settings: RoomSettings
  members: MemberView[]
  isStaff: boolean
}

export interface ChatAttachmentMeta {
  name: string
  mime: string
  size: number
}

export interface ChatMessageView {
  id: string
  ts: number
  senderKey: string
  senderName: string
  text: string
  attachment: ChatAttachmentMeta | null
  hasAttachmentBlob: boolean
}

export interface OfferFileView {
  id: number
  relPath: string
  size: number
  risky: boolean
}

export interface OfferView {
  taskId: string
  roomId: string
  senderKey: string
  senderName: string
  files: OfferFileView[]
  totalSize: number
  risky: boolean
}

export interface TaskView {
  taskId: string
  roomId: string
  direction: 'send' | 'recv' | 'other'
  peerKey: string
  peerName: string
  total: number
  done: number
  fileCount: number
  state: TaskState
  speedBps: number
  speedCapBps: number | null
  participant: boolean
  // Only set for the two parties; permanently null for onlookers (spec 8.6).
  label: string | null
  error: string | null
}

export interface TrustPrompt {
  key: string
  name: string
  roomId: string | null
  kind: 'join' | 'peer'
}

export interface InviteView {
  id: string
  roomId: string
  roomName: string
  code: string
  from: string
  fromKey: string
  receivedAt: number
}

export interface BanInfo {
  roomId: string
  roomName: string
  reason: string
  adminName: string
  // Role/system badges of the banning staff member, shown next to their
  // name on the ban screen.
  adminBadges: BadgeInfo[]
  expiresAt: number | null
}

export interface BanEntryView {
  targetKey: string
  targetName: string
  reason: string
  adminName: string
  createdAt: number
  expiresAt: number | null
  // false = expired or explicitly unbanned — shown in green below active
  // (red) bans, and kept in the list permanently.
  active: boolean
}

// One entry of the application center (join applications log). Pending
// rows await a staff decision; approved/rejected rows are the permanent
// log with who decided, when and the typed-out rejection reason.
export interface ApplicationView {
  applicantKey: string
  name: string
  status: 'pending' | 'approved' | 'rejected'
  reason: string | null
  decidedBy: string | null
  decidedAt: number | null
  createdAt: number
}

// App-level ban (self-enforced): shown as the blocking APP BANNED screen.
export interface AppBanInfo {
  reason: string
  byName: string
  // Identity badges of the issuing app moderator, shown next to their
  // name on the APP BANNED screen.
  byBadges: BadgeInfo[]
  expiresAt: number | null
}

export interface AdapterView {
  name: string
  ip: string
  kind: 'radmin' | 'hamachi' | 'other'
}

export interface PreviewMeta {
  previewId: string
  taskId: string
  fileId: number
  mime: string
  size: number
  error: string | null
}

export interface UpdateState {
  state: 'off' | 'checking' | 'available' | 'none' | 'error'
  version: string | null
}

// ---------------------------------------------------------------------------
// IPC call map. The preload exposes exactly these methods; the main
// process registers one handler per entry (src/main/ipc.ts) and validates
// event.senderFrame on every handler.
// ---------------------------------------------------------------------------

export interface CallResult {
  ok: boolean
  error: string | null
}

export interface CallMap {
  'app:boot': { in: void; out: BootState }
  'app:setReceiveFolder': { in: { folder: string }; out: CallResult }
  'app:setDisplayName': { in: { name: string }; out: CallResult }
  'app:getSettings': { in: void; out: Settings }
  'app:updateSettings': { in: Partial<Settings>; out: SettingsUpdateResult }
  'app:rebuildHwid': { in: void; out: CallResult }
  // The reply carries the AUTHORITATIVE availability: setAvailability
  // early-returns on a no-op request, so the reply — not the renderer's
  // optimistic flip — is what reconciles the two sides.
  'app:setAvailability': { in: { online: boolean }; out: CallResult & { online: boolean } }
  'win:minimize': { in: void; out: void }
  'win:toggleMaximize': { in: void; out: void }
  'win:close': { in: void; out: void }
  'room:create': {
    in: { name: string; memberCap: number | null; transport: Transport; vpnIp: string | null }
    out: CallResult
  }
  'room:list': { in: void; out: RoomSummary[] }
  'room:join': { in: { code: string }; out: CallResult & { pending: boolean } }
  'room:leave': { in: { roomId: string }; out: CallResult }
  'room:state': { in: { roomId: string }; out: RoomState | null }
  'room:updateSettings': { in: { roomId: string; settings: Partial<RoomSettings> }; out: CallResult }
  'chat:log': { in: { roomId: string; limit: number }; out: ChatMessageView[] }
  'chat:send': { in: { roomId: string; text: string; attachmentPath: string | null }; out: CallResult }
  'chat:attachment': { in: { roomId: string; messageId: string }; out: ArrayBuffer | null }
  'transfer:offer': {
    in: { roomId: string; peerKey: string; paths: string[] }
    out: CallResult
  }
  'transfer:respond': { in: { taskId: string; accept: boolean; speedCapBps: number | null }; out: CallResult }
  'transfer:control': { in: { taskId: string; action: 'pause' | 'resume' | 'cancel' }; out: CallResult }
  'transfer:setCap': { in: { taskId: string; speedCapBps: number | null }; out: CallResult }
  'transfer:tasks': { in: { roomId: string }; out: TaskView[] }
  'transfer:preview': { in: { taskId: string; fileId: number }; out: PreviewMeta }
  'transfer:previewRead': { in: { previewId: string }; out: ArrayBuffer | null }
  'transfer:previewClose': { in: { previewId: string }; out: CallResult }
  'mod:ban': { in: { roomId: string; targetKey: string; duration: string; reason: string }; out: CallResult }
  'mod:unban': { in: { roomId: string; targetKey: string }; out: CallResult }
  'mod:setRole': { in: { roomId: string; targetKey: string; role: 'admin' | 'moderator' | 'member' }; out: CallResult }
  'mod:bans': { in: { roomId: string }; out: BanEntryView[] }
  'mod:applications': { in: { roomId: string }; out: ApplicationView[] }
  'mod:decideApplication': { in: { roomId: string; applicantKey: string; approve: boolean; reason: string }; out: CallResult }
  // App-level ban: only offered to hardcoded APP_MOD_HWIDS identities.
  'app:ban': { in: { roomId: string; targetKey: string; duration: string; reason: string }; out: CallResult }
  'room:pendingDismiss': { in: { code: string }; out: CallResult }
  'trust:respond': { in: { key: string; accept: boolean }; out: CallResult }
  'invite:respond': { in: { inviteId: string; accept: boolean }; out: CallResult }
  'sys:pickFiles': { in: void; out: { paths: string[] } | null }
  'sys:pickFolder': { in: void; out: { path: string } | null }
  'sys:showInFolder': { in: { path: string }; out: CallResult }
  'sys:openExternal': { in: { url: string }; out: CallResult }
  'sys:copyText': { in: { text: string }; out: CallResult }
  'sys:adapters': { in: void; out: AdapterView[] }
  'about:license': { in: void; out: { text: string } }
  'update:install': { in: void; out: CallResult }
  'app:quit': { in: void; out: void }
}

export type CallMethod = keyof CallMap

// ---------------------------------------------------------------------------
// Pushed events (main -> renderer), fixed channel allowlist.
// ---------------------------------------------------------------------------

export interface EventMap {
  boot: BootState
  settings: Settings
  rooms: RoomSummary[]
  room: RoomState
  chat: { roomId: string; message: ChatMessageView; merged: boolean }
  tasks: { roomId: string; tasks: TaskView[] }
  offer: OfferView
  trust: TrustPrompt
  banned: BanInfo
  invite: InviteView
  notification: { title: string; body: string; kind: 'info' | 'chat' | 'transfer' | 'ban' | 'invite' }
  update: UpdateState
  availability: { online: boolean }
}

export type EventChannel = keyof EventMap

export interface Bridge {
  call<M extends CallMethod>(method: M, payload: CallMap[M]['in']): Promise<CallMap[M]['out']>
  on<M extends EventChannel>(channel: M, listener: (payload: EventMap[M]) => void): () => void
  // Drag & drop: absolute path of a dropped File (webUtils.getPathForFile).
  pathForFile(file: File): string
}

// Exposed via contextBridge as window.p2pft (src/preload/index.ts).
export const BRIDGE_KEY = 'p2pft'
export const CALL_CHANNEL = 'call'
export const eventChannel = (name: string): string => `evt:${name}`
