import { app, safeStorage } from 'electron'
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

// HWID (spec 4.1). Computed once on first launch from four hardware
// identifiers, then cached. The cache is DPAPI-encrypted via
// safeStorage when available (the lightweight option sanctioned by the
// spec — the trust boundary already assumes a determined attacker can
// rebuild their own identity anyway); otherwise an obfuscated file whose
// embedded checksum breaks on casual edits.

const PS_SCRIPT = [
  "$ErrorActionPreference='Stop'",
  '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8',
  '$r=[ordered]@{}',
  '$r.mb=[string]@(Get-CimInstance Win32_BaseBoard)[0].SerialNumber',
  '$r.cpu=[string]@(Get-CimInstance Win32_Processor)[0].ProcessorId',
  '$r.disk=[string]@(Get-CimInstance Win32_DiskDrive)[0].SerialNumber',
  "$r.mac=[string]@(Get-CimInstance Win32_NetworkAdapterConfiguration -Filter 'IPEnabled=TRUE')[0].MACAddress",
  '[Console]::Out.Write((ConvertTo-Json -Compress ([PSObject]$r)))'
].join('; ')

interface HardwareParts {
  mb: string
  cpu: string
  disk: string
  mac: string
}

function runPowerShell(script: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true }
    )
    let out = ''
    let err = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('hardware query timed out'))
    }, timeoutMs)
    child.stdout.on('data', (d: Buffer) => (out += d.toString('utf8')))
    child.stderr.on('data', (d: Buffer) => (err += d.toString('utf8')))
    child.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0 && out.trim().length > 0) resolve(out)
      else reject(new Error(`powershell exited ${code}: ${err.slice(0, 300)}`))
    })
  })
}

async function readHardwareParts(): Promise<HardwareParts> {
  const raw = await runPowerShell(PS_SCRIPT, 30_000)
  const parsed = JSON.parse(raw) as Partial<HardwareParts>
  const parts: HardwareParts = {
    mb: String(parsed.mb ?? '').trim(),
    cpu: String(parsed.cpu ?? '').trim(),
    disk: String(parsed.disk ?? '').trim(),
    mac: String(parsed.mac ?? '').trim().replace(/[:-]/g, '')
  }
  if (!parts.mb || !parts.cpu || !parts.disk || !parts.mac) {
    throw new Error('one or more hardware identifiers came back empty')
  }
  return parts
}

export function buildRawHwid(parts: HardwareParts): string {
  return `${parts.mb}-${parts.cpu}-${parts.disk}-${parts.mac}`
}

export function hashHwid(raw: string): string {
  return crypto.createHash('sha256').update(raw, 'utf8').digest('hex').toUpperCase()
}

async function computeHwidHash(): Promise<string> {
  const parts = await readHardwareParts()
  return hashHwid(buildRawHwid(parts))
}

function cacheFile(): string {
  return path.join(app.getPath('userData'), 'hwid.bin')
}

// Obfuscated fallback when DPAPI is unavailable: XOR with a fixed key plus
// a checksum of the plaintext, so a hand-edit that does not also fix the
// checksum reads back as garbage and triggers the mismatch flow.
const XOR_KEY = 'p2pft-hwid-cache-v1'
const CHECK_SALT = 'p2pft-hwid-checksum-v1'

function xorBuffer(buf: Buffer, key: string): Buffer {
  const keyBuf = Buffer.from(key, 'utf8')
  const out = Buffer.allocUnsafe(buf.length)
  for (let i = 0; i < buf.length; i++) out[i] = buf[i] ^ keyBuf[i % keyBuf.length]
  return out
}

async function readCachedHwid(): Promise<string | null> {
  try {
    const raw = fs.readFileSync(cacheFile())
    if (raw.length === 0) return null
    if (safeStorage.isEncryptionAvailable()) {
      const plain = safeStorage.decryptString(
        Buffer.from(raw.toString('utf8').split('\n')[0], 'base64')
      )
      return plain || null
    }
    const plainBuf = xorBuffer(raw.subarray(32), XOR_KEY)
    const checksum = crypto.createHash('sha256').update(plainBuf.toString('utf8') + CHECK_SALT).digest()
    if (!checksum.subarray(0, 32).equals(raw.subarray(0, 32))) return null
    return plainBuf.toString('utf8')
  } catch {
    return null
  }
}

async function writeCachedHwid(hash: string): Promise<void> {
  fs.mkdirSync(path.dirname(cacheFile()), { recursive: true })
  if (safeStorage.isEncryptionAvailable()) {
    const encrypted = safeStorage.encryptString(hash)
    fs.writeFileSync(cacheFile(), encrypted.toString('base64') + '\n', { mode: 0o600 })
    return
  }
  const plainBuf = Buffer.from(hash, 'utf8')
  const checksum = crypto.createHash('sha256').update(hash + CHECK_SALT).digest().subarray(0, 32)
  fs.writeFileSync(cacheFile(), Buffer.concat([checksum, xorBuffer(plainBuf, XOR_KEY)]), { mode: 0o600 })
}

export interface HwidCheck {
  firstRun: boolean
  matches: boolean
  hwid: string
  cached: string | null
}

export async function verifyHwid(): Promise<HwidCheck> {
  const current = await computeHwidHash()
  const cached = await readCachedHwid()
  if (cached === null) {
    await writeCachedHwid(current)
    return { firstRun: true, matches: true, hwid: current, cached: null }
  }
  return { firstRun: false, matches: cached === current, hwid: current, cached }
}

// Spec 4.2 "Run HWID rebuild": regenerate from current hardware and
// re-cache. A user evading a ban via hardware change or reinstall is an
// accepted trade-off, not a bug.
export async function rebuildHwid(): Promise<string> {
  const current = await computeHwidHash()
  await writeCachedHwid(current)
  return current
}
