// Smoke tests for the pure logic modules (no Electron, no network):
// ban-duration parsing, room codes, path safety, wire framing, the
// HWID hash against the owner's real hardware vector, and the reserved
// identity constants.
// Run: npm run smoke

import { execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const TMP = path.join('scripts', '.smoke-tmp')
fs.rmSync(TMP, { recursive: true, force: true })
fs.mkdirSync(TMP, { recursive: true })

const load = (name) => import(pathToFileURL(path.resolve(TMP, name)).href)

const bundles = [
  ['src/shared/durations.ts', 'durations.mjs'],
  ['src/shared/ids.ts', 'ids.mjs'],
  ['src/shared/roomCode.ts', 'roomcode.mjs'],
  ['src/shared/constants.ts', 'constants.mjs'],
  ['src/main/fsSafety.ts', 'fssafety.mjs'],
  ['src/net/framing.ts', 'framing.mjs'],
  ['src/main/hwid.ts', 'hwid.mjs']
]

for (const [entry, out] of bundles) {
  const extra = entry.endsWith('hwid.ts') ? ['--alias:electron=./scripts/electron-stub.mjs'] : []
  execSync(
    `esbuild ${entry} --bundle --format=esm --platform=node --external:node:* --external:better-sqlite3 ${extra.join(' ')} --outfile=${path.join(TMP, out)}`,
    { stdio: 'pipe' }
  )
}

let failures = 0
const assert = (cond, name) => {
  if (cond) console.log(`  ok  ${name}`)
  else {
    failures++
    console.error(`FAIL  ${name}`)
  }
}
const eq = (a, b, name) => assert(a === b, `${name} (${JSON.stringify(a)} === ${JSON.stringify(b)})`)

console.log('— durations —')
{
  const { parseBanDuration } = await load('durations.mjs')
  const now = 1_000_000_000_000
  const perm = parseBanDuration('', now)
  eq(perm.permanent, true, 'empty = permanent')
  eq(parseBanDuration('perm', now).permanent, true, 'perm = permanent')
  eq(parseBanDuration('PERMANENT', now).permanent, true, 'permanent = permanent')
  eq(parseBanDuration('23d', now).expiresAt - now, 23 * 86_400_000, '23d')
  eq(parseBanDuration('5', now).expiresAt - now, 5 * 60_000, 'bare 5 = minutes')
  eq(parseBanDuration('2w 5h 2m 40s', now).expiresAt - now, 2 * 7 * 86_400_000 + 5 * 3_600_000 + 2 * 60_000 + 40_000, '2w 5h 2m 40s (spec example)')
  eq(parseBanDuration('1y 30d 1w 1d 1m 1s', now) !== null, true, '1y 30d 1w 1d 1m 1s parses')
  eq(parseBanDuration('abc', now), null, 'abc rejected')
  eq(parseBanDuration('5x', now), null, 'unknown unit rejected')
  eq(parseBanDuration('999y', now), null, 'over-100y sanity cap')
}

console.log('— base58 & room codes —')
{
  const { base58Encode, base58Decode } = await load('ids.mjs')
  const bytes = new Uint8Array(32).fill(7)
  bytes[0] = 0
  eq(base58Encode(base58Decode(base58Encode(bytes))) === base58Encode(bytes), true, 'base58 roundtrip')
  const { encodeRoomCode, decodeRoomCode, isValidRoomCode } = await load('roomcode.mjs')
  const key = new Uint8Array(32)
  for (let i = 0; i < 32; i++) key[i] = i
  const code = encodeRoomCode(key)
  eq(typeof code === 'string' && code.startsWith('PFT-'), true, 'code has prefix')
  eq(decodeRoomCode(code) !== null && Array.from(decodeRoomCode(key !== undefined ? code : '')).join() === Array.from(key).join(), true, 'code roundtrip')
  eq(isValidRoomCode('PFT-123'), false, 'short code rejected')
  eq(isValidRoomCode(code), true, 'generated code accepted')
  eq(decodeRoomCode('PFT-!!!!!!!!'), null, 'invalid chars rejected')
}

console.log('— fs safety —')
{
  const mod = await load('fssafety.mjs')
  const { sanitizeFilename, resolveInsideRoot, findFreeName, isRiskyExtension } = mod
  eq(sanitizeFilename('..\\..\\evil.exe').includes('\\'), false, 'backslash stripped')
  eq(sanitizeFilename('CON.txt').startsWith('_'), true, 'CON.txt neutralized')
  eq(sanitizeFilename('NUL'), '_NUL', 'NUL neutralized')
  eq(sanitizeFilename('name\u202Efdp.exe').includes('\u202E'), false, 'RTL override stripped')
  eq(sanitizeFilename('a/b/c.txt').includes('/'), false, 'slash stripped')
  eq(isRiskyExtension('setup.exe'), true, '.exe risky')
  eq(isRiskyExtension('photo.png'), false, '.png not risky')
  const root = process.cwd()
  eq(resolveInsideRoot(root, '../../escape.txt').ok, false, 'traversal rejected')
  eq(resolveInsideRoot(root, 'sub/ok.txt').ok, true, 'nested path ok')
  eq(resolveInsideRoot(root, 'a/../../c.txt').ok, false, 'embedded .. rejected')
  eq(resolveInsideRoot(root, '').ok, false, 'empty rejected')
  const dir = path.join(TMP, 'collide')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'report.pdf'), 'x')
  eq(findFreeName(dir, 'report.pdf'), 'report (1).pdf', 'collision suffix (1)')
}

console.log('— framing —')
{
  const { encodeFrame, encodeControl, FrameParser, FRAME_CHUNK } = await load('framing.mjs')
  const received = []
  let protoErr = null
  const parser = new FrameParser(
    (f) => received.push(f),
    (e) => (protoErr = e)
  )
  const header = { taskId: '12345678-abcd-abcd-abcd-123456789012', fileId: 0, chunkIdx: 3, sha256: 'a'.repeat(64) }
  const data = new Uint8Array([1, 2, 3, 4, 5])
  const frame = encodeFrame(FRAME_CHUNK, header, data)
  // Split across pushes to exercise buffering.
  parser.push(frame.subarray(0, 5))
  parser.push(frame.subarray(5))
  eq(received.length, 1, 'frame reassembled')
  eq(protoErr, null, 'no protocol error')
  if (received.length === 1) {
    eq(received[0].type, FRAME_CHUNK, 'type preserved')
    eq(JSON.parse(received[0].header.toString('utf8')).chunkIdx, 3, 'header preserved')
    eq(received[0].data.length, 5, 'data preserved')
  }
  const ctrl = encodeControl({ t: 'ping', nonce: 42 })
  parser.push(ctrl)
  eq(received.length, 2, 'control frame parsed')
  eq(JSON.parse(received[1].header.toString('utf8')).t, 'ping', 'control message intact')
  const bad = Buffer.alloc(10)
  bad.writeUInt32BE(999_999_999, 0)
  parser.push(bad)
  eq(protoErr !== null, true, 'oversized frame raises protocol error')
  // Regression: control frames legitimately exceed the 512-byte BINARY
  // header cap — a join_accept with one member is ~750 bytes and was
  // killed as "binary header too large", so joins could never complete.
  // The cap must apply to binary-typed frames only.
  const big = {
    t: 'join_accept',
    roomId: 'x'.repeat(64),
    room: {
      name: 'n'.repeat(64),
      memberCap: null,
      chatLimits: { textLength: 500, imageBytes: 5242880, videoBytes: 10485760, audioBytes: 2097152 },
      transport: 'dht',
      vpnIp: null,
      vpnPort: null
    },
    members: Array.from({ length: 3 }, (_, i) => ({
      key: 'a'.repeat(63) + i,
      name: 'm'.repeat(20),
      role: 'member',
      hwid: 'C'.repeat(63) + i,
      joinedAt: i,
      lastSeen: i
    }))
  }
  const bigFrame = encodeControl(big)
  eq(bigFrame.readUInt16BE(5) > 512, true, 'large control header really exceeds the binary cap')
  const got = []
  const parser2 = new FrameParser((f) => got.push(f), () => {})
  parser2.push(bigFrame)
  eq(got.length, 1, 'large control frame parses')
  if (got.length === 1) {
    eq(JSON.parse(got[0].header.toString('utf8')).t, 'join_accept', 'large control frame intact')
  }
  let binErr = null
  const parser3 = new FrameParser(() => undefined, (e) => (binErr = e))
  parser3.push(encodeFrame(FRAME_CHUNK, { junk: 'x'.repeat(1024) }))
  eq(binErr !== null && /binary header too large/.test(binErr.message), true, 'binary header cap still enforced for binary frames')
}

console.log('— hwid vector —')
{
  const { buildRawHwid, hashHwid } = await load('hwid.mjs')
  const raw = buildRawHwid({
    mb: 'M80-J5M20401579',
    cpu: '178BFBFF00A60F12',
    disk: 'WD-WCC6Y6NKZJ1C',
    mac: '9C6B00AEE4B0'
  })
  eq(raw, 'M80-J5M20401579-178BFBFF00A60F12-WD-WCC6Y6NKZJ1C-9C6B00AEE4B0', 'raw concat matches formula')
  const OWNER_HWID_HASH = 'C3CD539494973C030416AE1CF1954D5244769441989B75A40330C22E139F2D50'
  eq(hashHwid(raw), OWNER_HWID_HASH, 'sha256 uppercase hex matches owner vector')
}

console.log('— reserved identity —')
{
  const { RESERVED_NAME_B64, RESERVED_HASH_B64 } = await load('constants.mjs')
  const name = Buffer.from(RESERVED_NAME_B64, 'base64').toString('utf8')
  const hash = Buffer.from(RESERVED_HASH_B64, 'base64').toString('utf8')
  eq(name.length > 0, true, 'reserved name decodes')
  // A hand-mangled or truncated hash would silently lock the owner out of
  // their own reserved name — it must be well-formed and match the owner
  // hardware vector asserted above.
  eq(/^[0-9A-F]{64}$/.test(hash), true, 'reserved hash is 64 uppercase hex chars')
  eq(
    hash,
    'C3CD539494973C030416AE1CF1954D5244769441989B75A40330C22E139F2D50',
    'reserved hash equals the owner hardware vector'
  )
}

fs.rmSync(TMP, { recursive: true, force: true })
if (failures > 0) {
  console.error(`\nsmoke: FAILED (${failures} assertion(s))`)
  process.exit(1)
}
console.log('\nsmoke: all assertions passed')
