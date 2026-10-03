export const APP_ID = 'com.p2pft.app'
export const APP_NAME = 'P2P File Transfer'

// The GitHub repository exists (https://github.com/rqwq/P2P-File-Transfer)
// but these two constants MUST stay empty until its FIRST RELEASE is
// published: they drive electron-updater AND the packaged-startup
// integrity gate, and the gate treats a missing release (404) as
// 'fail' — filling them in before a release exists would flag every
// packaged build as an unofficial copy. Once the release workflow has
// published (with the asar.sha256 asset), set REPO_OWNER='rqwq',
// REPO_NAME='P2P-File-Transfer'. While empty, auto-update is disabled
// and the integrity gate no-ops (a missing configuration is not a
// tamper signal).
export const REPO_OWNER = ''
export const REPO_NAME = ''

// Reserved identity (spec 4.4), stored base64-encoded so the raw strings
// are not visible via a plaintext strings/grep pass over the repo or the
// built bundle (the production obfuscator additionally hides these behind
// its base64 string array). Decoding happens only in the main process.
// The hash MUST decode to exactly 64 uppercase hex chars (the owner
// machine's SHA-256 HWID hash) — scripts/smoke.mjs cross-checks it
// against the same hardware vector the HWID test uses.
export const RESERVED_NAME_B64 = 'ZXh0cmVtaXNt'
export const RESERVED_HASH_B64 =
  'QzNDRDUzOTQ5NDk3M0MwMzA0MTZBRTFDRjE5NTRENTI0NDc2OTQ0MTk4OUI3NUE0MDMzMEMyMkUxMzlGMkQ1MA=='

// Error shown when a display name collides with another member of a room
// (join admission or rename) — exact string on the wire and in the UI.
export const NAME_TAKEN_ERROR = 'ERR: name not available'

// Extensions that trigger the stronger confirmation variant (spec 8.2).
export const RISKY_EXTENSIONS = new Set([
  'exe', 'scr', 'bat', 'cmd', 'com', 'lnk', 'msi', 'js', 'jse', 'vbs',
  'vbe', 'ps1', 'hta', 'pif', 'cpl', 'reg', 'jar', 'wsf', 'url'
])

export const RISKY_CONFIRM_SECONDS = 15
export const SAFE_CONFIRM_SECONDS = 10

// Transfer engine tuning.
export const CHUNK_SIZE = 512 * 1024
export const CHUNK_WINDOW = 16
export const MAX_CONTROL_FRAME = 256 * 1024
export const BINARY_HEADER_CAP = 512

// Connection hygiene (spec 11).
export const HANDSHAKE_TIMEOUT_MS = 10_000
export const IDLE_TIMEOUT_MS = 60_000
export const PING_INTERVAL_MS = 20_000
export const MAX_CONNECTIONS_TOTAL = 256

// Preview loads whole files into RAM (spec 8.3). Require the file to fit
// within this fraction of currently free RAM.
export const PREVIEW_MEM_SAFETY = 0.5

// Free-space headroom required on top of the incoming payload.
export const DISK_SAFETY_BYTES = 64 * 1024 * 1024

// Default per-room chat limits (spec 9), creator-configurable.
export const DEFAULT_CHAT_LIMITS = {
  textLength: 500,
  imageBytes: 5 * 1024 * 1024,
  videoBytes: 10 * 1024 * 1024,
  audioBytes: 2 * 1024 * 1024
} as const

export const MAX_MEMBER_CAP = 1000
export const MAX_DISPLAY_NAME = 32

// Wire/JSON size sanity for one chat attachment (all attachment classes).
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024

// ---------------------------------------------------------------------------
// Roles, badges and app-level identity (user spec, "roles & systems").
// ---------------------------------------------------------------------------

// Role hierarchy: creator > admin > moderator > member. Rank helpers live
// in shared so main, worker and renderer all order roles identically.
export type RoleId = 'creator' | 'admin' | 'moderator' | 'member'
export const ROLE_RANK: Record<RoleId, number> = { creator: 4, admin: 3, moderator: 2, member: 1 }

// Wire protocol version. Every peer advertises it in `hello` and
// `join_request`; a mismatch means the peers run different app builds and
// the connection/room policies below apply (auto group-ban + untrusted
// flag). Bump this whenever wire shapes change incompatibly. This is a
// cooperative check — a modified client can lie; there is no server to
// attest builds in a serverless app.
export const PROTOCOL_VERSION = 2

// Extra HWID hashes (64 uppercase hex) allowed to issue app bans and
// shown with the Official App Moderator hammer — ADDITIONAL to the
// owner. The owner is ALWAYS an app moderator: every check also matches
// the reserved identity's HWID (the same hash the reserved name
// extremism is bound to), so this list must never contain a hand-typed
// copy of it — the last such copy drifted by one character and silently
// disabled the badge.
export const APP_MOD_HWIDS: string[] = []

// True when `hwid` belongs to an official app moderator: the owner (the
// reserved identity's HWID, passed already-decoded by callers) or an
// entry of APP_MOD_HWIDS. Callers decode RESERVED_HASH_B64 themselves —
// this module is also imported by the sandboxed renderer, where Buffer
// is unavailable.
export function isAppModHwid(hwid: string, reservedHwid: string): boolean {
  return hwid === reservedHwid || APP_MOD_HWIDS.includes(hwid)
}

// Build-time app-level blocklist (owner decision, baked into the build).
// Checked against the local machine's HWID hash at startup — a match
// boots into the APP BANNED screen and disables auto-update. This is the
// whole enforcement: the app refuses itself, nothing modifies anyone's
// files. Peer-delivered bans (app_ban) land in the same screen via the
// appBans DB table at runtime.
export const APP_BANS: { hwid: string; reason: string; until: number | null }[] = []

// Badge catalog: id, display name and the hover description shown in the
// tooltip (name on the first line, description below a gray separator).
export interface BadgeDef {
  name: string
  description: string
}

export type BadgeId = 'appMod' | 'official' | 'creator' | 'admin' | 'moderator' | 'untrusted'

export const BADGES: Record<BadgeId, BadgeDef> = {
  appMod: { name: 'App Moderator', description: 'The Official App Moderator.' },
  official: { name: 'Verified', description: 'Official representative of the app.' },
  creator: { name: 'Room Creator', description: 'The creator of this room.' },
  admin: { name: 'Room Administrator', description: 'The administrator of this room.' },
  moderator: { name: 'Room Moderator', description: 'The moderator of this room.' },
  untrusted: { name: 'Untrusted', description: 'Caught running a modified or mismatched app build.' }
}
