import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import type { Bridge, CallMethod, CallMap, EventChannel, EventMap } from '../shared/api'
import { BRIDGE_KEY, CALL_CHANNEL, eventChannel } from '../shared/api'

// Narrow, typed preload bridge (spec 3): specific IPC methods only —
// never raw ipcRenderer. Both the call methods and the event channels are
// allowlisted; anything else is refused.

const CALL_ALLOWLIST: CallMethod[] = [
  'app:boot',
  'app:setReceiveFolder',
  'app:setDisplayName',
  'app:getSettings',
  'app:updateSettings',
  'app:rebuildHwid',
  'app:setAvailability',
  'app:quit',
  'win:minimize',
  'win:toggleMaximize',
  'win:close',
  'room:create',
  'room:list',
  'room:join',
  'room:leave',
  'room:state',
  'room:updateSettings',
  'chat:log',
  'chat:send',
  'chat:attachment',
  'transfer:offer',
  'transfer:respond',
  'transfer:control',
  'transfer:setCap',
  'transfer:tasks',
  'transfer:preview',
  'transfer:previewRead',
  'transfer:previewClose',
  'mod:ban',
  'mod:unban',
  'mod:setRole',
  'mod:bans',
  'mod:applications',
  'mod:decideApplication',
  'mod:memberIdentity',
  'mod:suspect',
  'mod:markSuspected',
  'transfer:historyClear',
  'app:ban',
  'trust:respond',
  'invite:respond',
  'sys:pickFiles',
  'sys:pickFolder',
  'sys:showInFolder',
  'sys:openExternal',
  'sys:copyText',
  'sys:adapters',
  'about:license',
  'update:install'
]

const EVENT_ALLOWLIST: EventChannel[] = [
  'boot',
  'settings',
  'rooms',
  'room',
  'chat',
  'tasks',
  'offer',
  'trust',
  'banned',
  'invite',
  'notification',
  'update',
  'availability'
]

const callSet = new Set<string>(CALL_ALLOWLIST)
const eventSet = new Set<string>(EVENT_ALLOWLIST)

const bridge: Bridge = {
  call<M extends CallMethod>(method: M, payload: CallMap[M]['in']): Promise<CallMap[M]['out']> {
    if (!callSet.has(method)) return Promise.reject(new Error('blocked method'))
    return ipcRenderer.invoke(CALL_CHANNEL, method, payload) as Promise<CallMap[M]['out']>
  },
  // Drag & drop support: resolves a renderer File (from a drop event) to
  // its absolute path. Direct webUtils call — no IPC round-trip needed.
  pathForFile(file: File): string {
    return webUtils.getPathForFile(file)
  },
  on<M extends EventChannel>(channel: M, listener: (payload: EventMap[M]) => void): () => void {
    if (!eventSet.has(channel)) return () => undefined
    const name = eventChannel(channel)
    const wrapped = (_e: IpcRendererEvent, payload: unknown): void => {
      listener(payload as EventMap[M])
    }
    ipcRenderer.on(name, wrapped)
    return () => ipcRenderer.removeListener(name, wrapped)
  }
}

contextBridge.exposeInMainWorld(BRIDGE_KEY, bridge)
