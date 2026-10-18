#!/usr/bin/env node
// Generates the PWA PNG icons with zero dependencies (Node zlib PNG encoding).
// Usage: node scripts/generate-icons.mjs

import { mkdirSync, writeFileSync } from 'node:fs'
import { deflateSync } from 'node:zlib'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT_DIR = join(ROOT, 'apps', 'web', 'public', 'icons')

const BG = [15, 23, 42] // #0f172a
const BODY = [226, 232, 240] // #e2e8f0
const SCREEN = [99, 102, 241] // #6366f1

const CRC_TABLE = new Uint32Array(256)
for (let n = 0; n < 256; n++) {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  CRC_TABLE[n] = c >>> 0
}

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length)
  out.writeUInt32BE(data.length, 0)
  out.write(type, 4, 'ascii')
  data.copy(out, 8)
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length)
  return out
}

function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type RGBA
  const stride = size * 4
  const raw = Buffer.alloc((stride + 1) * size)
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0 // filter: none
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(
      raw,
      y * (stride + 1) + 1,
    )
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

function blend(px, i, [r, g, b], alpha) {
  const dstA = px[i + 3] / 255
  const outA = alpha + dstA * (1 - alpha)
  if (outA <= 0) {
    px[i] = 0
    px[i + 1] = 0
    px[i + 2] = 0
    px[i + 3] = 0
    return
  }
  px[i] = Math.round((r * alpha + px[i] * dstA * (1 - alpha)) / outA)
  px[i + 1] = Math.round((g * alpha + px[i + 1] * dstA * (1 - alpha)) / outA)
  px[i + 2] = Math.round((b * alpha + px[i + 2] * dstA * (1 - alpha)) / outA)
  px[i + 3] = Math.round(outA * 255)
}

// Coverage (0..1) of a point against an antialiased rounded rectangle.
function rrCoverage(x, y, w, h, r, px, py) {
  const hw = w / 2
  const hh = h / 2
  const cx = px - (x + hw)
  const cy = py - (y + hh)
  const qx = Math.abs(cx) - (hw - r)
  const qy = Math.abs(cy) - (hh - r)
  const d = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r
  return Math.min(Math.max(0.5 - d / 1.25, 0), 1)
}

function drawIcon(size, maskable) {
  const px = new Uint8Array(size * size * 4)
  const cornerRadius = maskable ? 0 : size * 0.22

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const cov = maskable ? 1 : rrCoverage(0, 0, size, size, cornerRadius, x + 0.5, y + 0.5)
      if (cov > 0) blend(px, (y * size + x) * 4, BG, cov)
    }
  }

  // Geometry as fractions of size; kept inside the maskable safe zone (~80%).
  const shapes = [
    { x: 0.24, y: 0.22, w: 0.52, h: 0.4, r: 0.05, color: BODY }, // monitor body
    { x: 0.285, y: 0.265, w: 0.43, h: 0.31, r: 0.025, color: SCREEN }, // screen
    { x: 0.465, y: 0.635, w: 0.07, h: 0.1, r: 0.01, color: BODY }, // stand
    { x: 0.38, y: 0.71, w: 0.24, h: 0.05, r: 0.025, color: BODY }, // base
  ]

  for (const s of shapes) {
    const x = s.x * size
    const y = s.y * size
    const w = s.w * size
    const h = s.h * size
    const r = Math.min(s.r * size, w / 2, h / 2)
    const x0 = Math.max(0, Math.floor(x - 2))
    const x1 = Math.min(size, Math.ceil(x + w + 2))
    const y0 = Math.max(0, Math.floor(y - 2))
    const y1 = Math.min(size, Math.ceil(y + h + 2))
    for (let py = y0; py < y1; py++) {
      for (let pxX = x0; pxX < x1; pxX++) {
        const cov = rrCoverage(x, y, w, h, r, pxX + 0.5, py + 0.5)
        if (cov > 0) blend(px, (py * size + pxX) * 4, s.color, cov)
      }
    }
  }

  return px
}

mkdirSync(OUT_DIR, { recursive: true })

const icons = [
  ['icon-192.png', 192, false],
  ['icon-512.png', 512, false],
  ['icon-maskable-512.png', 512, true],
]

for (const [name, size, maskable] of icons) {
  const png = encodePng(size, drawIcon(size, maskable))
  writeFileSync(join(OUT_DIR, name), png)
  console.log(`${name}: ${size}x${size}, ${png.length} bytes`)
}
