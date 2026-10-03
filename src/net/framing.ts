import { BINARY_HEADER_CAP, CHUNK_SIZE } from '../shared/constants'
import type { ControlMessage } from '../shared/protocol'

// Wire framing (spec 11): length-prefixed frames with hard size caps.
// Layout: [u32 length][u8 type][u16 headerLen][header JSON][data]
// where `length` counts everything after the u32 itself.

export const FRAME_CONTROL = 0x01
export const FRAME_CHUNK = 0x10
export const FRAME_PREVIEW = 0x11
export const FRAME_ATTACHMENT = 0x12

export const MAX_FRAME = 2 * CHUNK_SIZE + 64 * 1024

export interface ParsedFrame {
  type: number
  header: Buffer
  data: Buffer
}

export class FrameParser {
  private buf = Buffer.alloc(0)

  constructor(private onFrame: (frame: ParsedFrame) => void, private onProtocolError: (err: Error) => void) {}

  push(chunk: Buffer): void {
    this.buf = this.buf.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.buf, chunk])
    // Any single frame bigger than the cap, or a buffer that has grown past
    // the cap plus slack, is treated as a protocol violation.
    if (this.buf.length > MAX_FRAME * 2) {
      this.onProtocolError(new Error('frame buffer overflow'))
      this.buf = Buffer.alloc(0)
      return
    }
    for (;;) {
      if (this.buf.length < 7) return
      const total = this.buf.readUInt32BE(0)
      if (total > MAX_FRAME) {
        this.onProtocolError(new Error('frame too large'))
        this.buf = Buffer.alloc(0)
        return
      }
      if (this.buf.length < 4 + total) return
      const type = this.buf[4]
      const headerLen = this.buf.readUInt16BE(5)
      // The tight cap is for BINARY frame headers only (chunk/preview/
      // attachment headers are tiny and fixed-shape). Control frames carry
      // their whole JSON message in the header slot and are legitimately
      // large — rosters, chat batches, manifests — bounded by the
      // MAX_FRAME check above and the 512KB cap in encodeControl. Capping
      // control headers here too made every join_accept (~750 bytes with a
      // single member) kill the connection as "binary header too large",
      // so no join could ever complete.
      if (type !== FRAME_CONTROL && headerLen > BINARY_HEADER_CAP) {
        this.onProtocolError(new Error('binary header too large'))
        this.buf = Buffer.alloc(0)
        return
      }
      const header = this.buf.subarray(7, 7 + headerLen)
      const data = this.buf.subarray(7 + headerLen, 4 + total)
      this.buf = this.buf.subarray(4 + total)
      this.onFrame({ type, header, data })
    }
  }
}

export function encodeFrame(type: number, headerObj: unknown, data?: Uint8Array): Buffer {
  const header = Buffer.from(JSON.stringify(headerObj), 'utf8')
  const dataLen = data ? data.length : 0
  const total = 1 + 2 + header.length + dataLen
  const out = Buffer.allocUnsafe(4 + total)
  out.writeUInt32BE(total, 0)
  out[4] = type
  out.writeUInt16BE(header.length, 5)
  header.copy(out, 7)
  if (data && dataLen > 0) Buffer.from(data.buffer, data.byteOffset, dataLen).copy(out, 7 + header.length)
  return out
}

export function encodeControl(msg: ControlMessage): Buffer {
  const json = Buffer.from(JSON.stringify(msg), 'utf8')
  if (json.length > 512 * 1024) throw new Error('control frame too large')
  return encodeFrame(FRAME_CONTROL, msg)
}
