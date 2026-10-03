// Generates build_resources/icon.png (512) and src/renderer/src/assets
// PNGs (tray) with a hand-drawn design — no image tooling needed.
// Run: npm run gen:assets

import { deflateSync } from 'node:zlib'
import fs from 'node:fs'
import path from 'node:path'

// ---- tiny PNG encoder (RGBA8, no interlace) ----

const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 0x80000000 ? (c << 1) ^ 0xedb88320 : c << 1
    t[n] = c
  }
  return t
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const typeBuf = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0)
  return Buffer.concat([len, typeBuf, data, crc])
}

function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type RGBA
  const raw = Buffer.alloc(height * (1 + width * 4))
  for (let y = 0; y < height; y++) {
    raw[y * (1 + width * 4)] = 0 // filter: none
    rgba.subarray(y * width * 4, (y + 1) * width * 4).copy(raw, y * (1 + width * 4) + 1)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

// ---- drawing helpers ----

function hex(h) {
  return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]
}

const BG = hex('#0b0e14')
const BG2 = hex('#151b28')
const ACCENT = hex('#7ec8e3')
const DEEP = hex('#0d2635')

function mix(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
}

function drawIcon(size) {
  const px = Buffer.alloc(size * size * 4)
  const set = (x, y, c, a = 255) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return
    const i = (y * size + x) * 4
    // alpha blend
    const prev = px[i + 3] / 255
    const na = a / 255 + prev * (1 - a / 255)
    if (na <= 0) return
    for (let k = 0; k < 3; k++) {
      px[i + k] = Math.round((c[k] * (a / 255) + px[i + k] * prev * (1 - a / 255)) / na)
    }
    px[i + 3] = Math.round(na * 255)
  }
  const s = size
  // rounded-square background with a subtle vertical gradient
  const r = s * 0.22
  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      const cx = Math.min(Math.max(x, r), s - r)
      const cy = Math.min(Math.max(y, r), s - r)
      const dist = Math.hypot(x - cx, y - cy)
      if (dist <= r) {
        const t = y / s
        const c = mix(BG2, BG, t)
        set(x, y, c, 255)
      }
    }
  }
  // double arrows: up-right (hollow) + down-left (solid), sky blue
  const cx = s / 2
  const cy = s / 2
  const arm = s * 0.3
  const thick = Math.max(2, Math.round(s * 0.055))
  const line = (x1, y1, x2, y2, c, a) => {
    const steps = Math.ceil(Math.hypot(x2 - x1, y2 - y1)) * 3
    for (let i = 0; i <= steps; i++) {
      const t = i / steps
      const x = Math.round(x1 + (x2 - x1) * t)
      const y = Math.round(y1 + (y2 - y1) * t)
      for (let oy = -thick; oy <= thick; oy++)
        for (let ox = -thick; ox <= thick; ox++) {
          if (ox * ox + oy * oy <= thick * thick) set(x + ox, y + oy, c, a)
        }
    }
  }
  // arrow 1 (outgoing): up-right
  line(cx - arm * 0.62, cy + arm * 0.62, cx + arm * 0.72, cy - arm * 0.72, ACCENT, 255)
  line(cx + arm * 0.72 - thick * 2.4, cy - arm * 0.72, cx + arm * 0.72, cy - arm * 0.72 + thick * 2.4 + 2, ACCENT, 255)
  line(cx + arm * 0.72, cy - arm * 0.72 + thick * 2.4 + 2, cx + arm * 0.72 - thick * 2.4, cy - arm * 0.72 + thick * 4.6, ACCENT, 220)
  // arrow 2 (incoming): down-left, dimmer
  line(cx + arm * 0.34, cy - arm * 0.34, cx - arm * 0.55, cy + arm * 0.55, DEEP, 255)
  line(cx - arm * 0.55 + thick * 2.2, cy + arm * 0.55, cx - arm * 0.55, cy + arm * 0.55 - thick * 2.2 - 2, DEEP, 255)
  line(cx - arm * 0.55, cy + arm * 0.55 - thick * 2.2 - 2, cx - arm * 0.55 + thick * 2.2, cy + arm * 0.55 - thick * 4.2, DEEP, 200)
  return encodePng(size, size, px)
}

function drawTray(size) {
  const px = Buffer.alloc(size * size * 4)
  const set = (x, y, c) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return
    const i = (y * size + x) * 4
    px[i] = c[0]; px[i + 1] = c[1]; px[i + 2] = c[2]; px[i + 3] = 255
  }
  const s = size
  const th = Math.max(1, Math.round(s / 8))
  for (let i = 0; i <= s - th - 1; i++) {
    const x = th + i
    const y = s - th - 1 - i
    for (let o = 0; o < th; o++) {
      set(x, y + o, [255, 255, 255])
      set(x + o, y, [255, 255, 255])
    }
  }
  return encodePng(s, s, px)
}

const root = process.cwd()
fs.mkdirSync(path.join(root, 'build_resources'), { recursive: true })
fs.mkdirSync(path.join(root, 'src/renderer/public/assets'), { recursive: true })
fs.writeFileSync(path.join(root, 'build_resources/icon.png'), drawIcon(512))
fs.writeFileSync(path.join(root, 'src/renderer/public/assets/icon.png'), drawIcon(256))
fs.writeFileSync(path.join(root, 'src/renderer/public/assets/tray.png'), drawTray(16))
console.log('assets written: build_resources/icon.png, src/renderer/src/assets/{icon,tray}.png')
