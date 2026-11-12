'use strict'

// 生成 Windows .ico 图标（多尺寸 16/24/32/48/64/128/256）。
// 纯 Node 实现：自己画 RGBA 像素 → PNG 编码 → 打包成 ICO 容器。
// 无第三方依赖。
//
// 用法: node build-icon.js

const fs = require('node:fs')
const path = require('node:path')
const zlib = require('node:zlib')

// ---------- PNG 编码 ----------

function crc32(buf) {
  let table = crc32.t
  if (!table) {
    table = crc32.t = new Int32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      table[n] = c
    }
  }
  let crc = -1
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff]
  return (crc ^ -1) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([len, body, crc])
}

function encodePNG(rgba, size) {
  const raw = Buffer.alloc((size * 4 + 1) * size)
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0 // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4)
  }
  const idat = zlib.deflateSync(raw, { level: 9 })

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8   // bit depth
  ihdr[9] = 6   // RGBA
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0))
  ])
}

// ---------- 图形绘制 ----------

// 闪电多边形（归一化 0..1，略偏右以视觉居中）
const BOLT = [
  [0.575, 0.10],
  [0.315, 0.545],
  [0.475, 0.545],
  [0.425, 0.90],
  [0.695, 0.435],
  [0.525, 0.435],
  [0.615, 0.10]
]

function pointInPolygon(px, py, poly) {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]
    const [xj, yj] = poly[j]
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

// 品牌绿（与界面 --accent 同色系，稍深以便白色闪电对比清楚）
const BRAND = [0x2f, 0x9e, 0x6b]
const WHITE = [0xff, 0xff, 0xff]

// 超采样绘制，得到平滑边缘
function renderIcon(size) {
  const SS = size >= 64 ? 4 : 8 // 小尺寸多采样，保证轮廓不糊
  const big = size * SS
  const buf = Buffer.alloc(size * size * 4)

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let sr = 0, sg = 0, sb = 0, sa = 0

      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const u = (x * SS + sx + 0.5) / big
          const v = (y * SS + sy + 0.5) / big

          // 圆角方形底（比纯圆更像 App 图标，也更适合小尺寸）
          const inset = 0.04
          const radius = 0.22
          const inCorner = cornerDistance(u, v, inset, radius) <= 0
          if (!inCorner) continue

          sa += 1
          if (pointInPolygon(u, v, BOLT)) {
            sr += WHITE[0]; sg += WHITE[1]; sb += WHITE[2]
          } else {
            sr += BRAND[0]; sg += BRAND[1]; sb += BRAND[2]
          }
        }
      }

      const o = (y * size + x) * 4
      const total = SS * SS
      if (sa > 0) {
        buf[o] = Math.round(sr / sa)
        buf[o + 1] = Math.round(sg / sa)
        buf[o + 2] = Math.round(sb / sa)
      }
      buf[o + 3] = Math.round((sa / total) * 255)
    }
  }
  return buf
}

// 返回点 (u,v) 到圆角矩形边界的有符号距离（<=0 表示在内部）
function cornerDistance(u, v, inset, radius) {
  const half = 0.5 - inset
  const dx = Math.abs(u - 0.5) - (half - radius)
  const dy = Math.abs(v - 0.5) - (half - radius)
  const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0))
  const inside = Math.min(Math.max(dx, dy), 0)
  return outside + inside - radius
}

// ---------- ICO 容器 ----------

function buildICO(images) {
  // images: [{ size, png }]
  const count = images.length
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)      // reserved
  header.writeUInt16LE(1, 2)      // type: icon
  header.writeUInt16LE(count, 4)  // image count

  const entries = []
  let offset = 6 + count * 16

  for (const img of images) {
    const e = Buffer.alloc(16)
    e.writeUInt8(img.size >= 256 ? 0 : img.size, 0) // width (0 = 256)
    e.writeUInt8(img.size >= 256 ? 0 : img.size, 1) // height
    e.writeUInt8(0, 2)  // color palette
    e.writeUInt8(0, 3)  // reserved
    e.writeUInt16LE(1, 4)   // color planes
    e.writeUInt16LE(32, 6)  // bits per pixel
    e.writeUInt32LE(img.png.length, 8)
    e.writeUInt32LE(offset, 12)
    entries.push(e)
    offset += img.png.length
  }

  return Buffer.concat([header, ...entries, ...images.map((i) => i.png)])
}

// ---------- ICNS 容器（macOS） ----------

// macOS 图标格式。现代 icns 允许直接内嵌 PNG，按尺寸映射到对应的类型码。
const ICNS_TYPES = [
  { size: 16, type: 'icp4' },   // 16x16
  { size: 32, type: 'icp5' },   // 32x32
  { size: 64, type: 'icp6' },   // 64x64
  { size: 128, type: 'ic07' },  // 128x128
  { size: 256, type: 'ic08' }   // 256x256
]

function buildICNS(pngBySize) {
  const chunks = []
  let total = 8 // 文件头 8 字节

  for (const { size, type } of ICNS_TYPES) {
    const png = pngBySize.get(size)
    if (!png) continue
    const chunk = Buffer.alloc(8 + png.length)
    chunk.write(type, 0, 'ascii')
    chunk.writeUInt32BE(8 + png.length, 4) // 长度含这 8 字节头
    png.copy(chunk, 8)
    chunks.push(chunk)
    total += chunk.length
  }

  const head = Buffer.alloc(8)
  head.write('icns', 0, 'ascii')
  head.writeUInt32BE(total, 4)
  return Buffer.concat([head, ...chunks])
}

// ---------- 主流程 ----------

const SIZES = [16, 24, 32, 48, 64, 128, 256]
const assetsDir = path.join(__dirname, 'assets')
fs.mkdirSync(assetsDir, { recursive: true })

const images = SIZES.map((size) => {
  const rgba = renderIcon(size)
  const png = encodePNG(rgba, size)
  // 单独存一份 256 的 PNG，供 electron-builder / 文档使用
  if (size === 256) fs.writeFileSync(path.join(assetsDir, 'icon.png'), png)
  // 托盘用小尺寸
  if (size === 32) fs.writeFileSync(path.join(assetsDir, 'tray.png'), png)
  return { size, png }
})

const ico = buildICO(images)
fs.writeFileSync(path.join(assetsDir, 'icon.ico'), ico)

// macOS：icns 直接内嵌 PNG
const pngBySize = new Map(SIZES.map((size) => [size, images.find((i) => i.size === size).png]))
const icns = buildICNS(pngBySize)
fs.writeFileSync(path.join(assetsDir, 'icon.icns'), icns)

console.log('生成完成:')
console.log(`  assets/icon.ico   (${SIZES.join('/')} 共 ${SIZES.length} 种尺寸, ${(ico.length / 1024).toFixed(1)} KB)`)
console.log(`  assets/icon.icns  (macOS, ${(icns.length / 1024).toFixed(1)} KB)`)
console.log(`  assets/icon.png   (256x256)`)
console.log(`  assets/tray.png   (32x32)`)
