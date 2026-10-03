import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import type { Settings } from '../shared/api'
import { MAX_DISPLAY_NAME } from '../shared/constants'

const DEFAULTS: Settings = {
  displayName: '',
  receiveFolder: '',
  maxSimultaneousTransfers: null,
  maxTransferSpeedBps: null
}

class SettingsStore {
  private file = ''
  private data: Settings = { ...DEFAULTS }
  private loaded = false

  load(): void {
    this.file = path.join(app.getPath('userData'), 'settings.json')
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<Settings>
      this.data = { ...DEFAULTS, ...raw }
    } catch {
      this.data = { ...DEFAULTS }
    }
    this.loaded = true
  }

  get(): Settings {
    if (!this.loaded) this.load()
    return { ...this.data }
  }

  update(patch: Partial<Settings>): Settings {
    if (!this.loaded) this.load()
    if (typeof patch.displayName === 'string') {
      this.data.displayName = patch.displayName.trim().slice(0, MAX_DISPLAY_NAME)
    }
    if (typeof patch.receiveFolder === 'string') {
      this.data.receiveFolder = patch.receiveFolder
    }
    if ('maxSimultaneousTransfers' in patch) {
      const v = patch.maxSimultaneousTransfers
      this.data.maxSimultaneousTransfers =
        v === null || v === undefined ? null : Math.max(1, Math.floor(v))
    }
    if ('maxTransferSpeedBps' in patch) {
      const v = patch.maxTransferSpeedBps
      this.data.maxTransferSpeedBps =
        v === null || v === undefined ? null : Math.max(1024, Math.floor(v))
    }
    this.save()
    return this.get()
  }

  isConfigured(): boolean {
    const s = this.get()
    return s.displayName.length > 0 && s.receiveFolder.length > 0
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), 'utf8')
  }
}

export const settings = new SettingsStore()
