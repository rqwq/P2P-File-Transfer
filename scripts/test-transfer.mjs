// End-to-end test of the transfer ENGINE (worker layer): the real
// TransferEngine + Peer + framing + Zod protocol over a real paired
// SecretStream, with a fake "main" doing real file I/O — the same layer
// where the missing transfer:beginFile request and the between-files
// pump deadlock lived. No Electron needed.
//
//   npm run test:transfer
//
// Covers: offer → accept → beginFile (lazy, memoized per file) → chunked
// transfer with per-chunk SHA-256 and acks → multi-file progression →
// file_done + whole-file hash verification → completion on both sides.

import { execSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const TMP = path.join('scripts', '.transfer-tmp')
fs.rmSync(TMP, { recursive: true, force: true })
fs.mkdirSync(TMP, { recursive: true })

// Bundle entry re-exporting both engine and peer (the engine module does
// not re-export Peer itself).
fs.writeFileSync(
  path.join(TMP, 'entry.mjs'),
  `export { TransferEngine } from '../../src/net/transferEngine.ts'
export { Peer } from '../../src/net/peer.ts'
`
)
execSync(
  `node node_modules/esbuild/bin/esbuild ${path.join(TMP, 'entry.mjs')} --bundle --format=esm --platform=node --external:node:* --outfile=${path.join(TMP, 'engine.mjs')}`,
  { stdio: 'pipe' }
)

const { TransferEngine, Peer } = await import(pathToFileURL(path.resolve(TMP, 'engine.mjs')).href)
const { default: SecretStream } = await import('@hyperswarm/secret-stream')

const { CHUNK_SIZE } = await import(pathToFileURL(path.resolve('out/.smoke-constants.mjs')).href).catch(async () => {
  execSync(
    `node node_modules/esbuild/bin/esbuild src/shared/constants.ts --bundle --format=esm --platform=node --external:node:* --outfile=${path.join(TMP, 'constants.mjs')}`,
    { stdio: 'pipe' }
  )
  return import(pathToFileURL(path.resolve(TMP, 'constants.mjs')).href)
})

const ROOM = 'r'.repeat(40)
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'p2pft-xfer-'))
const SRC = path.join(ROOT, 'src')
const DST = path.join(ROOT, 'dst')
fs.mkdirSync(SRC, { recursive: true })
fs.mkdirSync(DST, { recursive: true })

// Source: 7 full chunks + a partial one, plus a tiny second file — the
// second file is what exposed the between-files pump deadlock.
const fileA = Buffer.alloc(CHUNK_SIZE * 7 + 123_457)
for (let i = 0; i < fileA.length; i += 4096) fileA.fill((i / 4096) & 0xff, i, Math.min(i + 4096, fileA.length))
const fileB = Buffer.from('second file, small\n')
fs.writeFileSync(path.join(SRC, 'alpha.bin'), fileA)
fs.writeFileSync(path.join(SRC, 'beta.txt'), fileB)

// ---- the encrypted connection (real noise stack) ----
const sa = new SecretStream(true)
const sb = new SecretStream(false)
sa.rawStream.pipe(sb.rawStream).pipe(sa.rawStream)
await Promise.all([new Promise((r) => sa.on('connect', r)), new Promise((r) => sb.on('connect', r))])
const senderKeyHex = sa.publicKey.toString('hex')
const recvKeyHex = sb.publicKey.toString('hex')

const senderPeer = new Peer(sa, ROOM, sb.publicKey, true)
const recvPeer = new Peer(sb, ROOM, sa.publicKey, true)

// ---- fake main (mirrors src/main/transfers.ts semantics) ----
const hashOf = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')
const recvHandles = new Map()
const recvState = new Map()
const recvFinished = []
const sendFiles = [
  { id: 0, abs: path.join(SRC, 'alpha.bin'), size: fileA.length },
  { id: 1, abs: path.join(SRC, 'beta.txt'), size: fileB.length }
]

const recvHandlers = {
  'transfer:resumeState': () => null,
  'transfer:beginFile': ({ taskId, fileId }) => {
    const f = recvState.get(taskId)?.files.find((x) => x.id === fileId)
    if (!f) return { ok: false, error: 'unknown file' }
    if (!f.finalPath) {
      f.finalPath = path.join(DST, f.relPath)
      fs.writeFileSync(f.finalPath, '')
    }
    recvHandles.set(`${taskId}:${fileId}`, fs.openSync(f.finalPath, 'r+'))
    return { ok: true, error: null }
  },
  'transfer:writeChunk': ({ taskId, fileId, chunkIdx, data }) => {
    const fd = recvHandles.get(`${taskId}:${fileId}`)
    if (fd === undefined) return { ok: false, error: 'file not begun' }
    fs.writeSync(fd, data, 0, data.length, chunkIdx * CHUNK_SIZE)
    return { ok: true, error: null }
  },
  'transfer:finishFile': ({ taskId, fileId, sha256, bytes }) => {
    const f = recvState.get(taskId).files.find((x) => x.id === fileId)
    fs.closeSync(recvHandles.get(`${taskId}:${fileId}`))
    recvHandles.delete(`${taskId}:${fileId}`)
    const ok = hashOf(f.finalPath) === sha256 && f.size === bytes
    if (ok) recvFinished.push(fileId)
    return { ok, error: ok ? null : 'ERR: file integrity check failed' }
  },
  'transfer:cleanup': () => ({ ok: true, error: null })
}
const sendHandlers = {
  'transfer:needChunk': ({ taskId, fileId, chunkIdx }) => {
    const f = sendFiles.find((x) => x.id === fileId)
    const len = Math.min(CHUNK_SIZE, f.size - chunkIdx * CHUNK_SIZE)
    if (len <= 0 && f.size > 0) return { data: null, locked: false, error: 'chunk out of range' }
    const buf = Buffer.alloc(Math.max(0, len))
    const fd = fs.openSync(f.abs, 'r')
    fs.readSync(fd, buf, 0, Math.max(0, len), chunkIdx * CHUNK_SIZE)
    fs.closeSync(fd)
    return { data: new Uint8Array(buf), locked: false, error: null }
  },
  'transfer:hashFile': ({ fileId }) => ({ sha256: hashOf(sendFiles.find((x) => x.id === fileId).abs) }),
  'transfer:cleanup': () => ({ ok: true, error: null })
}

const mkCtx = (myKeyHex, peerOf, handlers, onOffer) => {
  const rooms = new Map()
  rooms.set(ROOM, { peerOf, memberName: () => 'peer', broadcast: () => {}, roomId: ROOM })
  return {
    keyPair: null,
    myKeyHex,
    identity: { name: 'tester', hwid: 'F'.repeat(64), maxSpeedBps: null },
    swarm: null,
    trusted: new Set(),
    localBans: new Set(),
    rooms,
    callMain: (kind, payload) => Promise.resolve(handlers[kind] ? handlers[kind](payload) : { ok: false, error: `no handler ${kind}` }),
    emitMain: (kind, payload) => {
      if (kind === 'offer:incoming' && onOffer) onOffer(payload.offer)
    },
    log: () => {}
  }
}

const engineA = new TransferEngine(mkCtx(senderKeyHex, () => senderPeer, sendHandlers))
const engineB = new TransferEngine(
  mkCtx(recvKeyHex, () => recvPeer, recvHandlers, (offer) => {
    // Mirror what main + an accepting user do: register receive state,
    // then respond with accept.
    recvState.set(offer.taskId, {
      files: offer.files.map((f) => ({ id: f.id, relPath: f.relPath, size: f.size, finalPath: null }))
    })
    engineB.respondFromMain({ taskId: offer.taskId, accept: true, speedCapBps: null, error: null })
  })
)

// What RoomNet normally wires:
senderPeer.on('control', (p, msg) => engineA.onWireControl(ROOM, p.key, msg))
senderPeer.on('binary', (p, f) => engineA.onBinary(ROOM, p.key, f.type, f.header, f.data))
recvPeer.on('control', (p, msg) => engineB.onWireControl(ROOM, p.key, msg))
recvPeer.on('binary', (p, f) => engineB.onBinary(ROOM, p.key, f.type, f.header, f.data))

// ---- drive ----
const taskId = crypto.randomUUID()
engineA.offerFromMain({
  taskId,
  roomId: ROOM,
  receiverKey: recvKeyHex,
  files: sendFiles.map((f) => ({ id: f.id, relPath: path.basename(f.abs), size: f.size, risky: false })),
  totalSize: fileA.length + fileB.length,
  label: '2 items'
})

const started = Date.now()
let verdict = 'timeout'
let lastLog = ''
while (Date.now() - started < 60_000) {
  await new Promise((r) => setTimeout(r, 200))
  const saT = engineA.snapshot(ROOM).find((t) => t.taskId === taskId)
  const sbT = engineB.snapshot(ROOM).find((t) => t.taskId === taskId)
  const log = `sender=${saT?.state}/${saT?.done} recv=${sbT?.state}/${sbT?.done} finished=[${recvFinished}]`
  if (log !== lastLog) {
    console.log(`  ${log}`)
    lastLog = log
  }
  if (saT?.state === 'failed' || sbT?.state === 'failed') {
    verdict = `FAILED (sender: ${saT?.state}/${saT?.error} — receiver: ${sbT?.state}/${sbT?.error})`
    break
  }
  if (saT?.state === 'completed' && sbT?.state === 'completed') {
    verdict = 'completed'
    break
  }
}

const bytesOk = (() => {
  try {
    return (
      hashOf(path.join(DST, 'alpha.bin')) === hashOf(path.join(SRC, 'alpha.bin')) &&
      hashOf(path.join(DST, 'beta.txt')) === hashOf(path.join(SRC, 'beta.txt'))
    )
  } catch {
    return false
  }
})()

fs.rmSync(ROOT, { recursive: true, force: true })
fs.rmSync(TMP, { recursive: true, force: true })

console.log(`  verdict: ${verdict}`)
console.log(`  destination bytes match: ${bytesOk}`)
if (verdict === 'completed' && bytesOk && recvFinished.length === 2) {
  console.log('transfer: all assertions passed')
  process.exit(0)
}
console.log('transfer: FAILED')
process.exit(1)
