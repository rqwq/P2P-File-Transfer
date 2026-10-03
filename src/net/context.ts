// Shared worker context handed to rooms and engines.

export interface NetContext {
  keyPair: { publicKey: Buffer; secretKey: Buffer }
  myKeyHex: string
  identity: { name: string; hwid: string; maxSpeedBps: number | null }
  swarm: import('hyperswarm')
  trusted: Set<string>
  // `${roomId}:${peerKey}` — locally applied bans gate reconnects.
  localBans: Set<string>
  rooms: Map<string, RoomRef>
  callMain<T = unknown>(kind: string, payload: Record<string, unknown>): Promise<T>
  emitMain(kind: string, payload: Record<string, unknown>): void
  log(level: 'info' | 'warn' | 'error', msg: string): void
  onPeerConnected?: (roomId: string, key: string) => void
}

// The rooms registry value type — RoomNet satisfies it structurally.
export interface RoomRef {
  roomId: string
}
