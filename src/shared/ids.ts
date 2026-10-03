// Base58 (Bitcoin alphabet) — copy-paste-safe, no 0/O/I/l.
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
const INDEX: Record<string, number> = {}
for (let i = 0; i < ALPHABET.length; i++) INDEX[ALPHABET[i]] = i

export function base58Encode(buf: Uint8Array): string {
  if (buf.length === 0) return ''
  let zeros = 0
  while (zeros < buf.length && buf[zeros] === 0) zeros++
  const digits: number[] = []
  for (let i = zeros; i < buf.length; i++) {
    let carry = buf[i]
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8
      digits[j] = carry % 58
      carry = (carry / 58) | 0
    }
    while (carry > 0) {
      digits.push(carry % 58)
      carry = (carry / 58) | 0
    }
  }
  let out = ''
  for (let i = 0; i < zeros; i++) out += '1'
  for (let i = digits.length - 1; i >= 0; i--) out += ALPHABET[digits[i]]
  return out
}

export function base58Decode(s: string): Uint8Array {
  const clean = s.replace(/\s+/g, '')
  if (clean.length === 0) return new Uint8Array(0)
  let zeros = 0
  while (zeros < clean.length && clean[zeros] === '1') zeros++
  const bytes: number[] = []
  for (let i = zeros; i < clean.length; i++) {
    const value = INDEX[clean[i]]
    if (value === undefined) throw new Error('invalid base58 character')
    let carry = value
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58
      bytes[j] = carry & 0xff
      carry >>= 8
    }
    while (carry > 0) {
      bytes.push(carry & 0xff)
      carry >>= 8
    }
  }
  const out = new Uint8Array(zeros + bytes.length)
  for (let i = 0; i < bytes.length; i++) out[out.length - 1 - i] = bytes[i]
  return out
}
