import net from 'node:net'
import SecretStream from '@hyperswarm/secret-stream'
import type { RoomNet } from './room'

// Alternative transport (spec 5.2): plain TCP sockets over a Radmin VPN /
// Hamachi adapter, wrapped in the same Noise secret-stream so peer
// identity and the protocol above it stay transport-agnostic. The
// protocol layer never knows which transport produced a connection.

const listeners = new Map<string, net.Server>()

// Creator/member binds a listener on its own adapter IP; the port is
// broadcast to peers via vpn_info. Returns the chosen port.
export function startVpnListener(room: RoomNet, ip: string | null): Promise<number | null> {
  const existing = listeners.get(room.roomId)
  if (existing) {
    const addr = existing.address()
    return Promise.resolve(typeof addr === 'object' && addr !== null ? addr.port : null)
  }
  if (!ip) return Promise.resolve(null)
  return new Promise((resolve) => {
    const server = net.createServer()
    server.on('error', () => resolve(null))
    server.listen(0, ip, () => {
      const addr = server.address()
      const port = typeof addr === 'object' && addr !== null ? addr.port : null
      if (port === null) {
        resolve(null)
        return
      }
      listeners.set(room.roomId, server)
      server.on('connection', (raw) => {
        // Responder side; the remote public key is checked after the
        // Noise handshake against the room roster.
        const secret = new SecretStream(false, raw, { keyPair: room.ctx.keyPair })
        secret.on('connect', () => {
          const remoteKey = secret.remotePublicKey
          if (!remoteKey || !room.members.has(hexOf(remoteKey))) {
            try {
              secret.destroy()
            } catch {
              // already dead
            }
            room.ctx.log('warn', 'vpn connection from unknown peer rejected')
            return
          }
          room.attachPeer(secret, remoteKey)
        })
      })
      resolve(port)
    })
  })
}

export function stopVpn(room: RoomNet): void {
  const server = listeners.get(room.roomId)
  if (server) {
    try {
      server.close()
    } catch {
      // already closed
    }
    listeners.delete(room.roomId)
  }
}

// Connect out to a peer's advertised VPN endpoint, binding to our own
// adapter so the traffic actually rides the VPN.
export function connectVpnTo(room: RoomNet, ip: string, port: number, expectedKey: string, localAddress: string | null): void {
  const already = room.peerOf(expectedKey)
  if (already) return
  const socket = net.connect({
    host: ip,
    port,
    localAddress: localAddress ?? undefined,
    timeout: 10_000
  })
  socket.on('error', () => {
    room.ctx.log('warn', `vpn connect to ${ip}:${port} failed`)
  })
  const secret = new SecretStream(true, socket, {
    keyPair: room.ctx.keyPair,
    remotePublicKey: Buffer.from(expectedKey, 'hex')
  })
  secret.on('connect', () => {
    room.attachPeer(secret, Buffer.from(expectedKey, 'hex'))
  })
}

function hexOf(buf: Buffer): string {
  return buf.toString('hex')
}
