import { app, net } from 'electron'
import crypto from 'node:crypto'
import { createReadStream } from 'original-fs'
import path from 'node:path'
import { REPO_NAME, REPO_OWNER } from '../shared/constants'

// Runtime integrity gate (spec 12.4). On every packaged-app startup:
// hash the on-disk app.asar with original-fs (NOT the Electron-patched
// fs, and never by toggling process.noAsar — that flag is process-wide
// and can race with unrelated asar reads), fetch the official release's
// asar.sha256 asset, and compare. Mismatch, or a version that never had
// an official release (404), shows the "unofficial copy" warning window.
// Network errors and non-200/non-404 API responses are treated as pass
// so legitimately offline users are not locked out.
//
// This is a second line of defense, not a guarantee: someone who strips
// the gate out of their own rebuild gets no warning. Obfuscation raises
// the cost of that surgery; code signing (out of scope for v1) would be
// the real fix.

export type IntegrityResult = 'pass' | 'fail' | 'skip'

function hashAsar(asarPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256')
    const stream = createReadStream(asarPath)
    stream.on('data', (d) => hash.update(d))
    stream.on('end', () => resolve(hash.digest('hex')))
    stream.on('error', reject)
  })
}

export async function integrityCheck(): Promise<IntegrityResult> {
  if (!app.isPackaged) return 'skip'
  if (!REPO_OWNER || !REPO_NAME) {
    console.warn('[integrity] REPO_OWNER/REPO_NAME not configured — gate skipped')
    return 'skip'
  }
  const asarPath = path.join(process.resourcesPath, 'app.asar')
  try {
    const localHash = await hashAsar(asarPath)
    const releaseUrl = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/releases/tags/v${app.getVersion()}`
    let response: Response
    try {
      response = await net.fetch(releaseUrl, {
        headers: { 'User-Agent': 'p2p-file-transfer-integrity-gate' }
      })
    } catch {
      // Offline / DNS failure: pass (spec 12.4 point 5).
      return 'pass'
    }
    if (response.status === 404) return 'fail'
    if (response.status !== 200) return 'pass'
    const release = (await response.json()) as { assets?: { name: string; url: string }[] }
    const asset = release.assets?.find((a) => a.name === 'asar.sha256')
    if (!asset) {
      // A release published without its integrity asset means our CI
      // upload step failed — locking every user out over that would be
      // worse than passing, so pass with a log line.
      console.warn('[integrity] release has no asar.sha256 asset — passing')
      return 'pass'
    }
    let expected: string
    try {
      const assetResponse = await net.fetch(asset.url, {
        headers: { 'User-Agent': 'p2p-file-transfer-integrity-gate', Accept: 'application/octet-stream' }
      })
      expected = (await assetResponse.text()).trim().toLowerCase()
    } catch {
      return 'pass'
    }
    return expected === localHash ? 'pass' : 'fail'
  } catch (err) {
    // Local read failures are suspicious but not proof — pass rather than
    // brick the app on a transient fs error.
    console.warn('[integrity] gate error, treating as pass:', err)
    return 'pass'
  }
}
