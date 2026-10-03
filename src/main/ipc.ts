import { clipboard, dialog, ipcMain, shell, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { app } from 'electron'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { BanEntryView, BootState, AppBanInfo, CallMethod, CallResult, RoomState, Settings, SettingsUpdateResult, TaskView } from '../shared/api'
import type { CallMap } from '../shared/api'
import { isAppModHwid, DEFAULT_CHAT_LIMITS, NAME_TAKEN_ERROR, RESERVED_HASH_B64, ROLE_RANK } from '../shared/constants'
import { parseBanDuration } from '../shared/durations'
import type { AdapterInfo } from '../shared/worker'
import { roomsDb } from './db/rooms'
import { chatStore } from './db/chat'
import { LICENSE_TEXT, validateDisplayName } from './identity'
import { folderLock } from './folderLock'
import type { Moderation } from './moderation'
import type { NetClient } from './netClient'
import { notifier } from './notify'
import { myPublicKey, roomStateCache } from './roomState'
import { settings } from './settings'
import type { TransferManager } from './transfers'
import type { Updater } from './updater'

export interface IpcContext {
  getWindow: () => BrowserWindow | null
  hwidHash: () => string
  bootStage: () => BootState['stage']
  appBan: () => AppBanInfo | null
  rebuildHwid: () => Promise<CallResult>
  setAvailability: (online: boolean) => void
  isAvailable: () => boolean
  net: NetClient
  moderation: Moderation
  transfers: TransferManager
  updater: Updater
  pushBoot: () => void
  pushSettings: () => void
  pushRooms: () => void
  pushRoomState: (roomId: string) => void
  quitApp: () => void
}

// Adapter enumeration + detection heuristic (spec 5.2): the adapter name
// containing radmin/hamachi wins; the known IP ranges (26.0.0.0/8 Radmin,
// 25.0.0.0/8 Hamachi) are only a fallback signal since ranges can change.

// The owner's reserved HWID, decoded once — the official app-moderator
// checks match it in addition to any extra hardcoded entries.
const RESERVED_HWID = Buffer.from(RESERVED_HASH_B64, 'base64').toString('utf8')
export function listAdapters(): AdapterInfo[] {
  const out: AdapterInfo[] = []
  const interfaces = os.networkInterfaces()
  for (const [name, addrs] of Object.entries(interfaces)) {
    for (const addr of addrs ?? []) {
      if (addr.family !== 'IPv4') continue
      const lower = name.toLowerCase()
      let kind: AdapterInfo['kind'] = 'other'
      if (lower.includes('radmin')) kind = 'radmin'
      else if (lower.includes('hamachi')) kind = 'hamachi'
      else if (addr.address.startsWith('26.')) kind = 'radmin'
      else if (addr.address.startsWith('25.')) kind = 'hamachi'
      if (kind === 'other') continue
      out.push({ name, ip: addr.address, kind })
      break
    }
  }
  return out
}

function appOrigin(): string {
  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (devUrl) return devUrl
  return 'file://'
}

// A display name must not collide with another member of any room the
// user is in (case-insensitive). The room creator re-checks this on every
// join admission, so this is the rename-side half of the rule.
function roomNameConflict(name: string): boolean {
  if (!myPublicKey) return false
  const wanted = name.trim().toLowerCase()
  if (wanted.length === 0) return false
  for (const room of roomsDb.listRooms()) {
    const clash = roomsDb
      .listMembers(room.roomId)
      .find((m) => m.key !== myPublicKey && m.name.trim().toLowerCase() === wanted)
    if (clash) return true
  }
  return false
}

function senderIsApp(event: IpcMainInvokeEvent): boolean {
  const url = event.senderFrame?.url ?? ''
  const origin = appOrigin()
  if (origin === 'file://') return url.includes('/out/renderer/')
  return url.startsWith(origin)
}

export function registerIpc(ctx: IpcContext): void {
  const ok = (error: string | null = null): CallResult => ({ ok: error === null, error })

  const registry = {
    'app:boot': (): BootState => {
      const s = settings.get()
      return {
        stage: ctx.bootStage(),
        settings: s,
        version: app.getVersion(),
        hwidRebuildError: null,
        online: ctx.isAvailable(),
        appBan: ctx.appBan()
      }
    },
    'app:setReceiveFolder': (p: { folder: string }): CallResult => {
      try {
        const stat = fs.statSync(p.folder)
        if (!stat.isDirectory()) return ok('Choose a folder, not a file.')
      } catch {
        return ok('That folder does not exist.')
      }
      settings.update({ receiveFolder: p.folder })
      folderLock.ensureStarted(p.folder)
      ctx.pushBoot()
      return ok()
    },
    'app:setDisplayName': (p: { name: string }): CallResult => {
      const res = validateDisplayName(p.name, ctx.hwidHash())
      if (!res.ok) return ok(res.error)
      if (roomNameConflict(p.name)) return ok(NAME_TAKEN_ERROR)
      settings.update({ displayName: p.name })
      ctx.net.send({
        kind: 'identity',
        name: p.name,
        hwid: ctx.hwidHash(),
        maxSpeedBps: settings.get().maxTransferSpeedBps
      })
      ctx.pushBoot()
      return ok()
    },
    'app:getSettings': (): Settings => settings.get(),
    'app:updateSettings': (p: Partial<Settings>): SettingsUpdateResult => {
      if (typeof p.displayName === 'string' && p.displayName.trim() !== settings.get().displayName) {
        const res = validateDisplayName(p.displayName, ctx.hwidHash())
        if (!res.ok) return { settings: settings.get(), error: res.error }
        if (roomNameConflict(p.displayName)) return { settings: settings.get(), error: NAME_TAKEN_ERROR }
        ctx.net.send({
          kind: 'identity',
          name: p.displayName.trim(),
          hwid: ctx.hwidHash(),
          maxSpeedBps: settings.get().maxTransferSpeedBps
        })
        p = { ...p, displayName: p.displayName.trim() }
      }
      const updated = settings.update(p)
      ctx.net.send({ kind: 'settings:speed', maxSpeedBps: updated.maxTransferSpeedBps })
      ctx.pushSettings()
      return { settings: updated, error: null }
    },
    'app:rebuildHwid': (): Promise<CallResult> => ctx.rebuildHwid(),
    // User availability (spec 10 "go offline"): offline suspends every
    // room in the worker — unreachable for chat, offers and joins. The
    // reply always carries the authoritative state so the renderer can
    // reconcile (setAvailability is a no-op when already in that state).
    'app:setAvailability': (p: { online: boolean }): CallResult & { online: boolean } => {
      ctx.setAvailability(p.online)
      return { ...ok(), online: ctx.isAvailable() }
    },
    'win:minimize': (): void => ctx.getWindow()?.minimize(),
    'win:toggleMaximize': (): void => {
      const win = ctx.getWindow()
      if (!win) return
      if (win.isMaximized()) win.unmaximize()
      else win.maximize()
    },
    'win:close': (): void => ctx.getWindow()?.close(),
    'room:create': async (p: {
      name: string
      memberCap: number | null
      transport: 'dht' | 'vpn'
      vpnIp: string | null
    }): Promise<CallResult> => {
      const name = p.name.trim()
      if (name.length === 0) return ok('Enter a room name.')
      const reply = await ctx.net.request<{ roomId: string; code: string }>({
        kind: 'room:create',
        name,
        memberCap: p.memberCap,
        transport: p.transport,
        vpnIp: p.vpnIp
      })
      ctx.pushRooms()
      ctx.pushRoomState(reply.roomId)
      return ok()
    },
    'room:list': () => roomsDb.summaries(roomStateCache.onlineSets(roomsDb.listRooms().map((r) => r.roomId))),
    'room:join': async (p: { code: string }): Promise<CallResult & { pending: boolean }> => {
      // The worker's join flow waits up to 45s (creator admission prompt
      // included) and replies with a precise reason; the request window
      // must be longer so that answer — not a generic timeout — surfaces.
      const reply = await ctx.net.request<{
        ok: boolean
        error: string | null
        pending?: boolean
        ban: { reason: string; adminName: string; expiresAt: number | null } | null
      }>({ kind: 'room:join', code: p.code.trim() }, 60_000)
      const pending = reply.pending === true
      if (!reply.ok && !pending) {
        if (reply.ban) {
          notifier.push('You are banned', reply.ban.reason || 'No reason given', 'ban')
        }
        // A rejection lands on the pending card so the typed-out reason
        // stays visible in the room list.
        roomsDb.markPendingRejected(p.code.trim(), reply.error ?? 'application rejected')
        ctx.pushRooms()
        return { ok: false, error: reply.error, pending: false }
      }
      if (pending) {
        // Application submitted — the room card shows as pending and the
        // worker keeps retrying until staff decide.
        ctx.pushRooms()
        return { ok: false, error: reply.error ?? 'Application submitted — waiting for the room staff.', pending: true }
      }
      ctx.pushRooms()
      return { ok: true, error: null, pending: false }
    },
    'room:leave': (p: { roomId: string }): CallResult => {
      const room = roomsDb.getRoom(p.roomId)
      if (!room) return ok('not in this room')
      ctx.net.send({ kind: 'room:leave', roomId: p.roomId })
      ctx.moderation.wipeRoom(p.roomId)
      roomsDb.deletePendingByRoom(p.roomId)
      ctx.pushRooms()
      return ok()
    },
    'room:state': (p: { roomId: string }): RoomState | null => roomStateCache.buildRoomState(p.roomId),
    'room:updateSettings': (p: { roomId: string; settings: Partial<RoomState['settings']> }): CallResult => {
      const room = roomsDb.getRoom(p.roomId)
      if (!room?.isCreator) return ok('Only the room creator can change room settings.')
      const current = roomStateCache.getRoomSettings(p.roomId)
      if (!current) return ok('Room settings not loaded yet.')
      const next = { ...current, ...p.settings }
      if (next.memberCap !== null && next.memberCap < 0) return ok('Invalid member cap.')
      roomStateCache.setRoomSettings(p.roomId, next)
      roomsDb.upsertRoom({
        roomId: p.roomId,
        name: next.name,
        code: room.code,
        isCreator: true,
        transport: next.transport,
        vpnIp: next.vpnIp,
        vpnPort: next.vpnPort
      })
      ctx.net.send({ kind: 'room:updateSettings', roomId: p.roomId, settings: next })
      ctx.pushRoomState(p.roomId)
      return ok()
    },
    'chat:log': (p: { roomId: string; limit: number }) => chatStore.log(p.roomId, Math.min(500, Math.max(1, p.limit))),
    'chat:send': (p: { roomId: string; text: string; attachmentPath: string | null }): CallResult => {
      const limits = roomStateCache.getRoomSettings(p.roomId)?.chatLimits ?? DEFAULT_CHAT_LIMITS
      const text = p.text.trim()
      if (text.length === 0 && !p.attachmentPath) return ok('Nothing to send.')
      if (text.length > limits.textLength) {
        return ok(`Message is limited to ${limits.textLength} characters in this room.`)
      }
      let attachment: { name: string; mime: string; size: number; blob: Uint8Array } | null = null
      if (p.attachmentPath) {
        try {
          const stat = fs.statSync(p.attachmentPath)
          const mime = guessMime(p.attachmentPath)
          if (!mime) return ok('Chat supports image, video, audio and text attachments only.')
          let cap: number
          if (mime.startsWith('image/')) cap = limits.imageBytes
          else if (mime.startsWith('video/')) cap = limits.videoBytes
          else if (mime.startsWith('audio/')) cap = limits.audioBytes
          else cap = 512 * 1024
          if (stat.size > cap) return ok(`Attachment exceeds this room's ${formatBytes(cap)} limit.`)
          attachment = {
            name: path.basename(p.attachmentPath),
            mime,
            size: stat.size,
            blob: new Uint8Array(fs.readFileSync(p.attachmentPath))
          }
        } catch {
          return ok('Cannot read the attachment file.')
        }
      }
      ctx.net.send({
        kind: 'chat:send',
        roomId: p.roomId,
        id: crypto.randomUUID(),
        ts: Date.now(),
        text,
        attachment
      })
      return ok()
    },
    'chat:attachment': (p: { roomId: string; messageId: string }): ArrayBuffer | null => {
      const blob = chatStore.attachmentBlob(p.roomId, p.messageId)
      if (!blob) return null
      const out = new ArrayBuffer(blob.length)
      new Uint8Array(out).set(blob)
      return out
    },
    'transfer:offer': async (p: { roomId: string; peerKey: string; paths: string[] }): Promise<CallResult> => {
      const res = await ctx.transfers.buildOffer(p.roomId, p.peerKey, p.paths)
      return ok(res.error)
    },
    'transfer:respond': async (p: { taskId: string; accept: boolean; speedCapBps: number | null }): Promise<CallResult> => {
      const res = await ctx.transfers.respond(p.taskId, p.accept, p.speedCapBps)
      return ok(res.error)
    },
    'transfer:control': (p: { taskId: string; action: 'pause' | 'resume' | 'cancel' }): CallResult => {
      ctx.net.send({ kind: 'transfer:control', taskId: p.taskId, action: p.action })
      if (p.action === 'cancel') ctx.transfers.dropTaskHandles(p.taskId)
      return ok()
    },
    'transfer:setCap': (p: { taskId: string; speedCapBps: number | null }): CallResult => {
      ctx.net.send({ kind: 'transfer:setCap', taskId: p.taskId, speedCapBps: p.speedCapBps })
      return ok()
    },
    'transfer:tasks': (p: { roomId: string }): TaskView[] => ctx.transfers.tasksFor(p.roomId),
    'transfer:preview': (p: { taskId: string; fileId: number }) => ctx.transfers.requestPreview(p.taskId, p.fileId),
    'transfer:previewRead': (p: { previewId: string }) => ctx.transfers.readPreview(p.previewId),
    'transfer:previewClose': (p: { previewId: string }): CallResult => {
      ctx.transfers.closePreview(p.previewId)
      return ok()
    },
    'mod:ban': (p: { roomId: string; targetKey: string; duration: string; reason: string }): CallResult => {
      const room = roomsDb.getRoom(p.roomId)
      if (!room) return ok('not in this room')
      const me = roomsDb.getMember(p.roomId, myPublicKey)
      const isMod = room.isCreator || me?.role === 'moderator'
      if (!isMod) return ok('You do not have permission to ban.')
      const issuerName = me?.name ?? settings.get().displayName
      const res = ctx.moderation.issueBan(
        p.roomId,
        myPublicKey,
        issuerName,
        p.targetKey,
        p.duration,
        p.reason,
        room.isCreator
      )
      return ok(res.error)
    },
    'mod:unban': (p: { roomId: string; targetKey: string }): CallResult => {
      const room = roomsDb.getRoom(p.roomId)
      if (!room) return ok('not in this room')
      const res = ctx.moderation.issueUnban(p.roomId, p.targetKey, room.isCreator)
      return ok(res.error)
    },
    'mod:setRole': (p: { roomId: string; targetKey: string; role: 'admin' | 'moderator' | 'member' }): CallResult => {
      const room = roomsDb.getRoom(p.roomId)
      if (!room) return ok('not in this room')
      const me = roomsDb.getMember(p.roomId, myPublicKey)
      const myRole = room.isCreator ? 'creator' : (me?.role ?? 'member')
      const target = roomsDb.getMember(p.roomId, p.targetKey)
      if (!target) return ok('member not found')
      if (target.role === 'creator') return ok("The room creator's role cannot change.")
      if (target.key === myPublicKey) return ok('You cannot change your own role.')
      // Role management is creator + admin only — moderators cannot
      // promote or demote anyone. An admin may only manage roles strictly
      // below their own.
      if (myRole !== 'creator' && myRole !== 'admin') {
        return ok('Only the room creator or an administrator can change roles.')
      }
      if (ROLE_RANK[p.role] >= ROLE_RANK[myRole]) {
        return ok('You can only assign roles below your own.')
      }
      roomsDb.upsertMember({ ...target, role: p.role })
      ctx.net.send({ kind: 'mod:setRole', roomId: p.roomId, targetKey: p.targetKey, role: p.role })
      ctx.pushRoomState(p.roomId)
      return ok()
    },
    'mod:applications': (p: { roomId: string }): import('../shared/api').ApplicationView[] => {
      const room = roomsDb.getRoom(p.roomId)
      if (!room) return []
      return ctx.moderation.listApplications(p.roomId)
    },
    'mod:decideApplication': (p: { roomId: string; applicantKey: string; approve: boolean; reason: string }): CallResult => {
      const me = roomsDb.getMember(p.roomId, myPublicKey)
      const room = roomsDb.getRoom(p.roomId)
      if (!room?.isCreator) return ok('Only the room creator reviews applications.')
      const byName = room.isCreator ? (me?.name ?? 'creator') : (me?.name ?? 'staff')
      const res = ctx.moderation.decideApplication(p.roomId, p.applicantKey, p.approve, p.reason, byName)
      return ok(res.error)
    },
    // App-level ban: offered only to official app moderators (the
    // reserved owner's HWID or the hardcoded list). Delivered over the
    // wire; receivers self-enforce.
    'app:ban': (p: { roomId: string; targetKey: string; duration: string; reason: string }): CallResult => {
      if (!isAppModHwid(ctx.hwidHash(), RESERVED_HWID)) return ok('Only official app moderators can do that.')
      const target = roomsDb.getMember(p.roomId, p.targetKey)
      if (!target) return ok('member not found')
      const parsed = parseBanDuration(p.duration)
      if (!parsed) return ok('invalid duration (examples: 23d, 1y 30d 1m, perm)')
      ctx.net.send({
        kind: 'app:banSend',
        roomId: p.roomId,
        targetKey: p.targetKey,
        hwid: target.hwid,
        reason: p.reason.trim() || 'no reason given',
        until: parsed.expiresAt
      })
      notifier.push('App ban issued', `${target.name} is banned from the app${parsed.expiresAt === null ? ' permanently' : ''}.`, 'ban')
      return ok()
    },
    'room:pendingDismiss': (p: { code: string }): CallResult => {
      const pending = roomsDb.listPendingRooms().find((pr) => pr.code === p.code)
      if (!pending) return ok('not found')
      roomsDb.deletePendingRoom(p.code)
      ctx.net.send({ kind: 'room:leave', roomId: pending.roomId })
      ctx.pushRooms()
      return ok()
    },
    'mod:bans': (p: { roomId: string }): BanEntryView[] => {
      const room = roomsDb.getRoom(p.roomId)
      if (!room) return []
      const me = roomsDb.getMember(p.roomId, myPublicKey)
      const staff = room.isCreator || me?.role === 'admin' || me?.role === 'moderator'
      if (!staff) return []
      return ctx.moderation.listBans(p.roomId, room.isCreator)
    },
    'trust:respond': (p: { key: string; accept: boolean }): CallResult => {
      ctx.moderation.respondTrust(p.key, p.accept)
      return ok()
    },
    'invite:respond': (p: { inviteId: string; accept: boolean }): CallResult => {
      roomsDb.markInviteHandled(p.inviteId)
      return ok()
    },
    'sys:pickFiles': (): { paths: string[] } | null => {
      const win = ctx.getWindow()
      const res = win
        ? dialog.showOpenDialogSync(win, {
            title: 'Select files to send',
            properties: ['openFile', 'multiSelections']
          })
        : dialog.showOpenDialogSync({
            title: 'Select files to send',
            properties: ['openFile', 'multiSelections']
          })
      return res && res.length > 0 ? { paths: res } : null
    },
    'sys:pickFolder': (): { path: string } | null => {
      const win = ctx.getWindow()
      const res = win
        ? dialog.showOpenDialogSync(win, {
            title: 'Select a folder to send',
            properties: ['openDirectory']
          })
        : dialog.showOpenDialogSync({
            title: 'Select a folder to send',
            properties: ['openDirectory']
          })
      return res && res.length === 1 ? { path: res[0] } : null
    },
    'sys:showInFolder': (p: { path: string }): CallResult => {
      const receiveFolder = settings.get().receiveFolder
      const resolved = path.resolve(p.path)
      if (
        receiveFolder.length === 0 ||
        !resolved.toLowerCase().startsWith(path.resolve(receiveFolder).toLowerCase() + path.sep)
      ) {
        return ok('Only received files can be revealed.')
      }
      shell.showItemInFolder(resolved)
      return ok()
    },
    'sys:openExternal': (p: { url: string }): CallResult => {
      // Strict allowlist: the GitHub repo only.
      if (!/^https:\/\/github\.com\//.test(p.url)) return ok('Blocked link.')
      void shell.openExternal(p.url)
      return ok()
    },
    'sys:copyText': (p: { text: string }): CallResult => {
      clipboard.writeText(p.text)
      return ok()
    },
    'sys:adapters': (): AdapterInfo[] => listAdapters(),
    'about:license': (): { text: string } => ({ text: LICENSE_TEXT }),
    'update:install': (): CallResult => {
      ctx.updater.install()
      return ok()
    },
    'app:quit': (): void => {
      // Hard quit (HWID-mismatch screen "Close application" and similar);
      // bypasses the close-to-tray behavior entirely.
      ctx.quitApp()
    }
  } satisfies { [M in CallMethod]: (payload: CallMap[M]['in']) => CallMap[M]['out'] | Promise<CallMap[M]['out']> }

  const dispatch = registry as unknown as Record<string, (payload: unknown) => unknown>

  ipcMain.handle('call', (event, method: string, payload: unknown) => {
    // event.senderFrame is validated on every handler (spec 3/11).
    if (!senderIsApp(event)) throw new Error('untrusted sender')
    const handler = dispatch[method]
    if (!handler) throw new Error(`unknown method: ${method}`)
    return handler(payload ?? undefined)
  })
}

function guessMime(p: string): string | null {
  const ext = path.extname(p).slice(1).toLowerCase()
  const image = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg']
  const video = ['mp4', 'webm', 'mov', 'mkv']
  const audio = ['mp3', 'wav', 'ogg', 'm4a', 'flac', 'opus']
  if (image.includes(ext)) return `image/${ext === 'jpg' ? 'jpeg' : ext}`
  if (video.includes(ext)) return `video/${ext}`
  if (audio.includes(ext)) return `audio/${ext}`
  if (['txt', 'md', 'json', 'log', 'csv'].includes(ext)) return 'text/plain'
  return null
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = bytes / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(v >= 10 ? 0 : 1)} ${units[i]}`
}
