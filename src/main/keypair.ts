import { app, safeStorage } from 'electron'
import fs from 'node:fs'
import path from 'node:path'

// The ed25519 identity keypair (spec 5.1): generated once inside the net
// worker, stored DPAPI-encrypted in the main process. The public key is
// the peer's network identity — never an IP.

export interface StoredKeyPair {
  publicKey: string
  secretKey: string
}

function keypairFile(): string {
  return path.join(app.getPath('userData'), 'keypair.bin')
}

export function loadKeypair(): StoredKeyPair | null {
  try {
    const raw = fs.readFileSync(keypairFile())
    if (raw.length === 0) return null
    let plain: string
    if (safeStorage.isEncryptionAvailable()) {
      plain = safeStorage.decryptString(Buffer.from(raw.toString('utf8').split('\n')[0], 'base64'))
    } else {
      plain = raw.toString('utf8')
    }
    const parsed = JSON.parse(plain) as Partial<StoredKeyPair>
    if (typeof parsed.publicKey === 'string' && typeof parsed.secretKey === 'string') {
      return { publicKey: parsed.publicKey, secretKey: parsed.secretKey }
    }
    return null
  } catch {
    return null
  }
}

export function saveKeypair(kp: StoredKeyPair): void {
  try {
    fs.mkdirSync(path.dirname(keypairFile()), { recursive: true })
    const json = JSON.stringify(kp)
    if (safeStorage.isEncryptionAvailable()) {
      const encrypted = safeStorage.encryptString(json)
      fs.writeFileSync(keypairFile(), encrypted.toString('base64') + '\n', { mode: 0o600 })
    } else {
      fs.writeFileSync(keypairFile(), json, { mode: 0o600 })
    }
  } catch {
    // If persistence fails the app still works this session; the identity
    // regenerates next launch.
  }
}
