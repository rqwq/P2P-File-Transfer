// Minimal ambient typings for the P2P dependency surface we use. These
// packages ship no TypeScript types of their own.

declare module 'hyperdht' {
  import type { Duplex } from 'node:stream'
  interface DhtKeyPair {
    publicKey: Buffer
    secretKey: Buffer
  }
  interface DhtServer extends Duplex {
    on(event: 'connection', listener: (socket: import('@hyperswarm/secret-stream'), info: unknown) => void): this
    listen(): Promise<void> | void
    close(): Promise<void> | void
  }
  class DHT {
    static keyPair(seed?: Buffer): DhtKeyPair
    constructor(opts?: Record<string, unknown>)
    ready(): Promise<void>
    destroy(opts?: { force?: boolean }): Promise<void>
    connect(publicKey: Buffer, opts?: Record<string, unknown>): Promise<import('@hyperswarm/secret-stream')>
    createServer(opts?: { firewall?: (remotePublicKey: Buffer) => boolean }): DhtServer
  }
  export = DHT
}

declare module 'hyperswarm' {
  import type { Duplex } from 'node:stream'
  interface SwarmConnectionInfo {
    publicKey: Buffer
    topics: Buffer[]
    topic?: Buffer
    client: boolean
    peer: { host: string; port: number } | null
  }
  interface PeerDiscovery {
    // hyperswarm 4's discovery session API: refresh() re-announces /
    // re-lookups with new server/client flags. There is no update().
    refresh(opts?: { server?: boolean; client?: boolean }): Promise<unknown> | void
    destroy(): Promise<unknown> | void
    flushed(): Promise<void> | void
  }
  class Hyperswarm extends Duplex {
    constructor(opts?: {
      keyPair?: { publicKey: Buffer; secretKey: Buffer }
      maxConnections?: number
      firewall?: (remotePublicKey: Buffer) => boolean
      localAddress?: string
      debug?: boolean
      // Relay connections through a DHT relay when hole-punching fails
      // (e.g. VPN adapters / symmetric NATs). Direct punch is still
      // attempted first; traffic stays end-to-end encrypted.
      relayThrough?: boolean
    })
    on(event: 'connection', listener: (socket: import('@hyperswarm/secret-stream'), info: SwarmConnectionInfo) => void): this
    on(event: 'init' | 'error' | 'close', listener: (...args: never[]) => void): this
    join(topic: Buffer, opts?: { server?: boolean; client?: boolean }): PeerDiscovery
    leave(topic: Buffer): boolean
    // Explicit peer dial by key (the only direct-connect API hyperswarm 4
    // has; `connect` does not exist and crashes at runtime). Connections
    // arrive on 'connection' with empty topics.
    joinPeer(publicKey: Buffer): void
    leavePeer(publicKey: Buffer): boolean
    listen(): Promise<void> | void
    destroy(opts?: { force?: boolean }): Promise<void>
    connections: Set<Duplex>
  }
  export = Hyperswarm
}

declare module '@hyperswarm/secret-stream' {
  import type { Duplex } from 'node:stream'
  class SecretStream extends Duplex {
    constructor(
      isInitiator: boolean | unknown,
      rawStream?: Duplex,
      opts?: { keyPair?: { publicKey: Buffer; secretKey: Buffer }; remotePublicKey?: Buffer }
    )
    remotePublicKey: Buffer | null
    publicKey: Buffer | null
    on(event: 'connect' | 'open' | 'close' | 'error' | 'end' | 'data', listener: (...args: never[]) => void): this
  }
  export = SecretStream
}
