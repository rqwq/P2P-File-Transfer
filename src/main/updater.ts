import { app } from 'electron'
import { autoUpdater } from 'electron-updater'
import type { UpdateState } from '../shared/api'
import { REPO_NAME, REPO_OWNER } from '../shared/constants'

// Auto-update via electron-updater pointed at the same GitHub Releases
// feed the CI pipeline publishes to (spec 13). Disabled until the
// repository placeholder is filled in — a missing configuration must not
// crash or nag.

export class Updater {
  private push: ((state: UpdateState) => void) | null = null
  private enabled = false

  init(push: (state: UpdateState) => void): void {
    this.push = push
    this.enabled = app.isPackaged && REPO_OWNER !== '' && REPO_NAME !== ''
    if (!this.enabled) {
      push({ state: 'off', version: null })
      return
    }
    autoUpdater.setFeedURL({
      provider: 'github',
      owner: REPO_OWNER,
      repo: REPO_NAME
    })
    autoUpdater.autoDownload = true
    autoUpdater.autoInstallOnAppQuit = true
    autoUpdater.on('checking-for-update', () => this.emit({ state: 'checking', version: null }))
    autoUpdater.on('update-available', (info) => this.emit({ state: 'available', version: info.version ?? null }))
    autoUpdater.on('update-not-available', () => this.emit({ state: 'none', version: null }))
    autoUpdater.on('error', () => this.emit({ state: 'error', version: null }))
    void this.check()
    setInterval(() => void this.check(), 4 * 60 * 60 * 1000)
  }

  private emit(state: UpdateState): void {
    this.push?.(state)
  }

  async check(): Promise<void> {
    if (!this.enabled) return
    try {
      await autoUpdater.checkForUpdates()
    } catch {
      this.emit({ state: 'error', version: null })
    }
  }

  install(): void {
    if (!this.enabled) return
    try {
      autoUpdater.quitAndInstall(false, true)
    } catch {
      // quitAndInstall can no-op if no update is staged — harmless
    }
  }
}
