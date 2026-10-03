// Ban-duration parsing (spec 7.4): compound free-text tokens.
//   y = years, w = weeks, d = days, h = hours, m = minutes, s = seconds.
// A bare number defaults to minutes. Empty / "perm" / "permanent" means a
// permanent ban. There is no months unit — express months as days.
// (The spec's own example "2w 5h 2m 40s" includes hours, so `h` is
// supported even though the field list in 7.4 omits it.)

export interface ParsedBan {
  permanent: boolean
  expiresAt: number | null
  durationMs: number
}

const UNIT_MS: Record<string, number> = {
  y: 365 * 86_400_000,
  w: 7 * 86_400_000,
  d: 86_400_000,
  h: 3_600_000,
  m: 60_000,
  s: 1_000
}

const HUNDRED_YEARS_MS = 100 * 365 * 86_400_000

export function parseBanDuration(input: string, now = Date.now()): ParsedBan | null {
  const t = input.trim().toLowerCase()
  if (t === '' || t === 'perm' || t === 'permanent') {
    return { permanent: true, expiresAt: null, durationMs: 0 }
  }
  let ms = 0
  let i = 0
  while (i < t.length) {
    if (t[i] === ' ') {
      i++
      continue
    }
    let num = 0
    let digits = 0
    while (i < t.length && t[i] >= '0' && t[i] <= '9') {
      num = num * 10 + (t.charCodeAt(i) - 48)
      if (num > 1e9) return null
      i++
      digits++
    }
    if (digits === 0) return null
    let unit = 'm'
    if (i < t.length && 'ywdhms'.includes(t[i])) {
      unit = t[i]
      i++
    }
    ms += num * UNIT_MS[unit]
    if (ms > HUNDRED_YEARS_MS) return null
  }
  if (ms <= 0) return null
  return { permanent: false, expiresAt: now + ms, durationMs: ms }
}

export function formatBanDuration(ms: number): string {
  const units: [number, string][] = [
    [UNIT_MS.y, 'y'],
    [UNIT_MS.w, 'w'],
    [UNIT_MS.d, 'd'],
    [UNIT_MS.h, 'h'],
    [UNIT_MS.m, 'm'],
    [UNIT_MS.s, 's']
  ]
  const parts: string[] = []
  let rest = ms
  for (const [value, suffix] of units) {
    if (rest >= value) {
      parts.push(`${Math.floor(rest / value)}${suffix}`)
      rest %= value
    }
  }
  return parts.length > 0 ? parts.join(' ') : '0s'
}
