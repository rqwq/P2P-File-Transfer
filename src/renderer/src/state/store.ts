import { create } from 'zustand'
import type {
  BanInfo,
  BootState,
  Bridge,
  ChatMessageView,
  InviteView,
  OfferView,
  PreviewMeta,
  RoomState,
  RoomSummary,
  Settings,
  TaskView,
  TrustPrompt,
  UpdateState
} from '../../../shared/api'

// Renderer state. All data flows in through the typed preload bridge;
// the renderer performs no filesystem or network access itself.

interface Toast {
  id: number
  title: string
  body: string
  kind: 'info' | 'chat' | 'transfer' | 'ban' | 'invite' | 'error'
}

interface AppState {
  bridge: Bridge | null
  boot: BootState | null
  settings: Settings | null
  rooms: RoomSummary[]
  currentRoomId: string | null
  roomStates: Record<string, RoomState>
  chats: Record<string, ChatMessageView[]>
  tasks: Record<string, TaskView[]>
  offers: Record<string, OfferView>
  trustPrompts: TrustPrompt[]
  invites: InviteView[]
  banScreen: BanInfo | null
  toasts: Toast[]
  update: UpdateState
  showSettings: boolean
  showAbout: boolean
  preview: { meta: PreviewMeta; buffer: ArrayBuffer | null } | null
  online: boolean
}

export interface Actions {
  init(bridge: Bridge | null): void
  refreshBoot(): Promise<void>
  refreshRooms(): Promise<void>
  selectRoom(roomId: string): Promise<void>
  closeBanScreen(): void
  dismissToast(id: number): void
  toast(title: string, body: string, kind?: Toast['kind']): void
  respondInvite(inviteId: string, accept: boolean): void
  setOnline(online: boolean): void
  setSettingsOpen(open: boolean): void
  setAboutOpen(open: boolean): void
  closePreview(): Promise<void>
}

let toastSeq = 1
let subscriptions: (() => void)[] = []

export const useStore = create<AppState & Actions>((setState, getState) => ({
  bridge: null,
  boot: null,
  settings: null,
  rooms: [],
  currentRoomId: null,
  roomStates: {},
  chats: {},
  tasks: {},
  offers: {},
  trustPrompts: [],
  invites: [],
  banScreen: null,
  toasts: [],
  update: { state: 'off', version: null },
  showSettings: false,
  showAbout: false,
  preview: null,
  online: true,

  init(bridge) {
    if (!bridge || subscriptions.length > 0) {
      setState({ bridge })
      return
    }
    setState({ bridge })
    subscriptions = [
      bridge.on('boot', (boot) => setState({ boot, online: boot.online })),
      bridge.on('settings', (settings) => setState({ settings })),
      bridge.on('rooms', (rooms) => setState({ rooms })),
      bridge.on('room', (room) => {
        setState((s) => ({ roomStates: { ...s.roomStates, [room.room.roomId]: room } }))
      }),
      bridge.on('chat', ({ roomId, message }) => {
        setState((s) => {
          const existing = s.chats[roomId] ?? []
          if (existing.some((m) => m.id === message.id)) return {}
          return { chats: { ...s.chats, [roomId]: [...existing, message] } }
        })
      }),
      bridge.on('tasks', ({ roomId, tasks }) => setState((s) => ({ tasks: { ...s.tasks, [roomId]: tasks } }))),
      bridge.on('offer', (offer) => setState((s) => ({ offers: { ...s.offers, [offer.taskId]: offer } }))),
      bridge.on('trust', (prompt) =>
        setState((s) => {
          const idx = s.trustPrompts.findIndex((p) => p.key === prompt.key)
          // Same-key prompts share one decision (main dedupes); a later
          // "join" wording replaces a generic "peer" one.
          if (idx === -1) return { trustPrompts: [...s.trustPrompts, prompt] }
          if (s.trustPrompts[idx].kind === prompt.kind) return {}
          const next = [...s.trustPrompts]
          next[idx] = prompt
          return { trustPrompts: next }
        })
      ),
      bridge.on('banned', (ban) => setState({ banScreen: ban, currentRoomId: null })),
      bridge.on('invite', (invite) => setState((s) => ({ invites: [...s.invites, invite] }))),
      bridge.on('notification', (n) => {
        const id = toastSeq++
        setState((s) => ({ toasts: [...s.toasts, { id, title: n.title, body: n.body, kind: n.kind }] }))
        setTimeout(
          () => setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
          5_000
        )
      }),
      bridge.on('update', (update) => setState({ update })),
      bridge.on('availability', ({ online }) => setState({ online }))
    ]
    void getState().refreshBoot()
    void getState().refreshRooms()
  },

  async refreshBoot() {
    const bridge = getState().bridge
    if (!bridge) return
    const boot = await bridge.call('app:boot', undefined)
    // Availability is authoritative in main: inherit it instead of
    // assuming the store default (a reload must not resurrect "online"
    // while main is suspended).
    setState({ boot, settings: boot.settings, online: boot.online })
  },

  async refreshRooms() {
    const bridge = getState().bridge
    if (!bridge) return
    const rooms = await bridge.call('room:list', undefined)
    setState({ rooms })
  },

  async selectRoom(roomId) {
    const bridge = getState().bridge
    if (!bridge) return
    setState({ currentRoomId: roomId })
    const state = await bridge.call('room:state', { roomId })
    if (!state) {
      // The room vanished while we were opening it (left from another
      // flow, wiped by a ban, …) — bounce back to the list instead of
      // parking on a dead room page.
      if (getState().currentRoomId === roomId) setState({ currentRoomId: null })
      getState().toast('Room unavailable', 'That room is no longer on this machine.', 'error')
      return
    }
    setState((s) => ({ roomStates: { ...s.roomStates, [roomId]: state } }))
    const log = await bridge.call('chat:log', { roomId, limit: 500 })
    setState((s) => ({ chats: { ...s.chats, [roomId]: log } }))
    const tasks = await bridge.call('transfer:tasks', { roomId })
    setState((s) => ({ tasks: { ...s.tasks, [roomId]: tasks } }))
  },

  closeBanScreen() {
    setState({ banScreen: null })
  },

  dismissToast(id) {
    setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
  },

  toast(title, body, kind = 'info') {
    const id = toastSeq++
    setState((s) => ({ toasts: [...s.toasts, { id, title, body, kind }] }))
    setTimeout(() => setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), 5_000)
  },

  respondInvite(inviteId, accept) {
    const bridge = getState().bridge
    setState((s) => ({ invites: s.invites.filter((i) => i.id !== inviteId) }))
    void bridge?.call('invite:respond', { inviteId, accept })
  },

  setOnline(online) {
    const bridge = getState().bridge
    // Optimistic flip keeps the pill responsive; the authoritative state
    // in the reply wins (main no-ops a redundant request instead of
    // pushing a correction).
    setState({ online })
    void bridge?.call('app:setAvailability', { online }).then((res) => {
      setState({ online: res.online })
    })
  },

  setSettingsOpen(open) {
    setState({ showSettings: open })
  },

  setAboutOpen(open) {
    setState({ showAbout: open })
  },

  async closePreview() {
    const bridge = getState().bridge
    const preview = getState().preview
    if (bridge && preview) await bridge.call('transfer:previewClose', { previewId: preview.meta.previewId })
    setState({ preview: null })
  }
}))
