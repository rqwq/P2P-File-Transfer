import { base58Decode, base58Encode } from './ids'

// A room code encodes the creator's ed25519 public key (spec 5.3) — not a
// raw IP — so joiners can reach the creator through the DHT without the
// creator forwarding any ports. Layout: 1 version byte + 32 key bytes,
// base58 with a short prefix so codes are recognizable and greppable.
const PREFIX = 'PFT-'
const PAYLOAD_LEN = 33

export function encodeRoomCode(creatorPublicKey: Uint8Array): string {
  if (creatorPublicKey.length !== 32) throw new Error('creator key must be 32 bytes')
  const payload = new Uint8Array(PAYLOAD_LEN)
  payload[0] = 1
  payload.set(creatorPublicKey, 1)
  return PREFIX + base58Encode(payload)
}

export function decodeRoomCode(code: string): Uint8Array | null {
  const trimmed = code.trim()
  const body = trimmed.toUpperCase().startsWith(PREFIX) ? trimmed.slice(4) : trimmed
  if (body.length < 20 || body.length > 60) return null
  try {
    const payload = base58Decode(body)
    if (payload.length !== PAYLOAD_LEN || payload[0] !== 1) return null
    return payload.subarray(1)
  } catch {
    return null
  }
}

export function isValidRoomCode(code: string): boolean {
  return decodeRoomCode(code) !== null
}
