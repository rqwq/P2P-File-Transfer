import fs from 'node:fs'
import path from 'node:path'
import { RISKY_EXTENSIONS } from '../shared/constants'

// Filename/path safety (spec 11). Every path the app writes under the
// receive folder goes through sanitize + resolveInsideRoot so nothing —
// a malicious peer included — can escape the root.

const RESERVED_DEVICE_NAMES = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
  'CLOCK$'
])

// RTL-override and other bidi-control characters that can disguise an
// executable's real extension (spec 11).
const BIDI_RE = /[\u202A-\u202E\u2066-\u2069\u200E\u200F]/g
const UNSAFE_CHARS_RE = /[\u0000-\u001F<>:"|?*\\/]/g
const MAX_BASENAME = 180
const MAX_EXT = 12

export function isRiskyExtension(filename: string): boolean {
  const dot = filename.lastIndexOf('.')
  if (dot < 0) return false
  const ext = filename.slice(dot + 1).toLowerCase()
  return RISKY_EXTENSIONS.has(ext)
}

export function sanitizeFilename(name: string): string {
  let cleaned = name.normalize('NFC')
  cleaned = cleaned.replace(BIDI_RE, '')
  cleaned = cleaned.replace(UNSAFE_CHARS_RE, '')
  // Windows silently strips trailing dots/spaces; do it ourselves first.
  cleaned = cleaned.replace(/[. ]+$/g, '')
  cleaned = cleaned.replace(/\s+/g, ' ').trim()
  if (cleaned.length === 0) cleaned = 'file'

  const dot = cleaned.lastIndexOf('.')
  const stem = dot > 0 ? cleaned.slice(0, dot) : cleaned
  const ext = dot > 0 ? cleaned.slice(dot + 1) : ''

  if (RESERVED_DEVICE_NAMES.has(stem.split('.')[0].toUpperCase())) {
    return `_${cleaned}`
  }

  let safeStem = stem.length > MAX_BASENAME ? stem.slice(0, MAX_BASENAME) : stem
  let safeExt = ext.length > MAX_EXT ? ext.slice(0, MAX_EXT) : ext
  // Keep a visible extension intact: never let the truncation eat the dot.
  safeStem = safeStem.replace(/[. ]+$/g, '') || 'file'
  return safeExt.length > 0 ? `${safeStem}.${safeExt}` : safeStem
}

export interface SafePathResult {
  ok: boolean
  absolutePath: string
  relPath: string
  error: string | null
}

// Splits a peer-supplied relative path into sanitized components and
// resolves it strictly inside `root`. Returns ok:false on anything that
// tries to escape, is empty, or nests too deep.
export function resolveInsideRoot(root: string, relPath: string, maxDepth = 64): SafePathResult {
  const parts: string[] = []
  for (const raw of relPath.split(/[\\/]+/)) {
    const segment = raw.trim()
    if (segment.length === 0 || segment === '.') continue
    if (segment === '..') return { ok: false, absolutePath: '', relPath: '', error: 'parent traversal rejected' }
    parts.push(sanitizeFilename(segment))
    if (parts.length > maxDepth) return { ok: false, absolutePath: '', relPath: '', error: 'path too deep' }
  }
  if (parts.length === 0) return { ok: false, absolutePath: '', relPath: '', error: 'empty path' }
  const safeRel = parts.join(path.sep)
  const absolute = path.resolve(root, safeRel)
  const rootNorm = path.resolve(root)
  if (
    absolute !== rootNorm &&
    !absolute.toLowerCase().startsWith(rootNorm.toLowerCase() + path.sep)
  ) {
    return { ok: false, absolutePath: '', relPath: '', error: 'path escapes receive folder' }
  }
  return { ok: true, absolutePath: absolute, relPath: safeRel, error: null }
}

// Windows-style collision suffix (spec 8.8): name.ext -> name (1).ext
export function findFreeName(dir: string, filename: string): string {
  let candidate = filename
  const dot = filename.lastIndexOf('.')
  const stem = dot > 0 ? filename.slice(0, dot) : filename
  const ext = dot > 0 ? filename.slice(dot) : ''
  for (let i = 1; i < 10_000; i++) {
    try {
      fs.accessSync(path.join(dir, candidate))
      candidate = `${stem} (${i})${ext}`
    } catch {
      return candidate
    }
  }
  return `${stem} (${Date.now()})${ext}`
}

// Mark-of-the-Web (spec 11): Zone.Identifier ADS with ZoneId=3 so Windows
// treats every received file as internet-downloaded. Best-effort — some
// filesystems do not support ADS.
export function writeMarkOfTheWeb(filePath: string): void {
  try {
    fs.writeFileSync(`${filePath}:Zone.Identifier`, '[ZoneTransfer]\r\nZoneId=3\r\n')
  } catch {
    // filesystem without ADS support — not fatal
  }
}

export async function getFreeSpaceBytes(dir: string): Promise<number> {
  const stat = await fs.promises.statfs(dir)
  return stat.bsize * stat.bavail
}

export async function ensureDir(dir: string): Promise<void> {
  await fs.promises.mkdir(dir, { recursive: true })
}

export function fileExists(p: string): boolean {
  try {
    fs.accessSync(p)
    return true
  } catch {
    return false
  }
}
