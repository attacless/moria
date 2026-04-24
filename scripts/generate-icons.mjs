import { deflateSync } from 'node:zlib'
import { writeFileSync } from 'node:fs'

// CRC32 lookup table
const crcTable = new Uint32Array(256)
for (let i = 0; i < 256; i++) {
  let c = i
  for (let k = 0; k < 8; k++) c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  crcTable[i] = c
}

function crc32(data) {
  let crc = 0xffffffff
  for (const b of data) crc = crcTable[(crc ^ b) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function u32be(n) {
  return new Uint8Array([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff])
}

function concat(arrays) {
  const total = arrays.reduce((s, a) => s + a.length, 0)
  const out = new Uint8Array(total)
  let off = 0
  for (const a of arrays) { out.set(a, off); off += a.length }
  return out
}

function pngChunk(type, data) {
  const t = new TextEncoder().encode(type)
  const crcInput = concat([t, data])
  return concat([u32be(data.length), t, data, u32be(crc32(crcInput))])
}

function generateIcon(size) {
  // Build raw scanlines: filter byte (0=None) + RGB per pixel
  const rowBytes = 1 + size * 3
  const raw = new Uint8Array(size * rowBytes)

  const bg    = [7, 7, 9]        // #070709
  const green = [22, 240, 122]   // #16f07a

  for (let y = 0; y < size; y++) {
    raw[y * rowBytes] = 0  // filter = None
    for (let x = 0; x < size; x++) {
      const off = y * rowBytes + 1 + x * 3
      raw[off] = bg[0]; raw[off + 1] = bg[1]; raw[off + 2] = bg[2]
    }
  }

  // Green dot centered at (size/2, size*0.65)
  const cx = Math.floor(size / 2)
  const cy = Math.floor(size * 0.65)
  const r  = Math.floor(size * 0.04)
  for (let y = Math.max(0, cy - r); y < Math.min(size, cy + r + 1); y++) {
    for (let x = Math.max(0, cx - r); x < Math.min(size, cx + r + 1); x++) {
      if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) {
        const off = y * rowBytes + 1 + x * 3
        raw[off] = green[0]; raw[off + 1] = green[1]; raw[off + 2] = green[2]
      }
    }
  }

  const sig  = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
  const ihdr = concat([u32be(size), u32be(size), new Uint8Array([8, 2, 0, 0, 0])])
  const idat = deflateSync(raw)

  return concat([sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', new Uint8Array(0))])
}

writeFileSync('public/icon-192.png', generateIcon(192))
writeFileSync('public/icon-512.png', generateIcon(512))
console.log('Icons generated: public/icon-192.png, public/icon-512.png')
