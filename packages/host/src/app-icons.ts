/**
 * 「添加到主屏幕」（PWA）要用的图标 —— 以及一个**不依赖任何图形库**的最小 PNG 编码器。
 *
 * ## 图标的两个来源（现在是第二个）
 *
 * 1. **代码画的**（本文件 `renderIconRgba`：深色底 + 三条白色圆角横杠）——
 *    第一版就是它。理由是"二进制资产要额外的复制规则，而多一条规则就多一个
 *    '改了没生效'的来源" ✗。这仍然是**回退路径**：生成物缺失时服务照旧给出一张
 *    合法、可安装的图标 ✓；
 * 2. **官方鲸鱼栅格化**（用户要求："改成 deepseek 的 icon（鲸鱼）"）✓ ——
 *    源文件 `packages/host/assets/deepseek-whale.svg`，
 *    由 `scripts/make-app-icons.mjs` 用无头 Chrome 出三张 PNG，
 *    再把 base64 内联进 `app-icons-asset.ts` ✓。
 *
 *    ★ 为什么内联成 TS 而不是往仓库里放三张 png：安装脚本只复制 `lib/` ✓，
 *    运行时读仓库里的图片会读不到 ✗（"装出去的产物缺东西"这类事故本项目吃过）。
 *    内联之后宿主依然**零外部文件依赖** ✓，同时图标终于是官方的那个图形 ✓。
 *
 * ## 可安装性的清单（缺一条 Chrome 就不给"安装应用"）
 *
 * · manifest 里有 `name` / `short_name` / `start_url` / `display:standalone` ✓
 * · **192 与 512 两个尺寸的 PNG 图标** ✓（SVG 单独不够，见下）
 * · 一个**带 `fetch` 处理器的 service worker** ✓（我们在 sw.js 里加了一个**空**处理器：
 *   只为满足条件，**绝不 respondWith** —— 一旦拦截请求，就可能把"改了脚本手机上还跑旧版"
 *   那类坑引进来 ✗，而那个坑本项目在配对页上已经踩过一次）
 * · HTTPS ✓（手机入口本来就是 TLS）
 *
 * macOS 上可以用 `sips -g pixelWidth -g pixelHeight <file>` 或 `file <file>` 独立复核，
 * 这条也被写进了验收脚本 —— 自己写的编码器不能只信自己的断言 ✓。
 */

import { deflateSync } from 'node:zlib'
import { appIconAsset } from './app-icons-asset.ts'

/** 标准 CRC-32（PNG 每个 chunk 都要）✓。 */
const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

export function crc32(bytes: Buffer): number {
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i += 1) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** 一个 PNG chunk：长度 + 类型 + 数据 + CRC ✓。 */
function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const typeBytes = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 0)
  return Buffer.concat([length, typeBytes, data, crc])
}

/**
 * 把 RGBA 像素编码成 PNG（8 位 / 真彩+alpha / 无隔行）。
 *
 * 只实现"够用"的那一档：每行一个 filter 字节（0 = None）✓ —— 图标是小图，
 * 压缩率不重要，**可复核**才重要 ✓。
 */
export function encodePng(width: number, height: number, rgba: Buffer, compress: (raw: Buffer) => Buffer = deflateSync): Buffer {
  if (rgba.length !== width * height * 4) throw new Error(`encodePng: 像素数不对（期望 ${width * height * 4}，实际 ${rgba.length}）`)
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type: RGBA
  ihdr[10] = 0 // compression
  ihdr[11] = 0 // filter
  ihdr[12] = 0 // interlace
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', compress(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/** 图标配色：与手机外壳一致（深色底 + 白色前景）。 */
const BACKGROUND = { r: 0x0f, g: 0x11, b: 0x15 }
const FOREGROUND = { r: 0xff, g: 0xff, b: 0xff }

/**
 * 画图标：深色底 + 三条白色圆角横杠。
 *
 * `maskable` 版本把内容收进**安全区**（Android 的遮罩可能裁掉外围 ~20%）✓，
 * 所以内容只占 52% 而不是 62% ✓ —— 两个尺寸（192 / 512）各出一个 maskable ✓。
 */
export function renderIconRgba(size: number, options: { maskable?: boolean } = {}): Buffer {
  const maskable = options.maskable === true
  const inner = size * (maskable ? 0.52 : 0.62)
  const barHeight = inner * 0.15
  const barWidth = inner
  const gap = barHeight * 0.8
  const totalHeight = barHeight * 3 + gap * 2
  const radius = barHeight / 2
  const bars = [0, 1, 2].map((index) => {
    const top = size / 2 - totalHeight / 2 + index * (barHeight + gap)
    return { x0: size / 2 - barWidth / 2, x1: size / 2 + barWidth / 2, y0: top, y1: top + barHeight }
  })
  const insideBar = (x: number, y: number): boolean => {
    for (const bar of bars) {
      if (x < bar.x0 || x > bar.x1 || y < bar.y0 || y > bar.y1) continue
      // 圆角矩形：只在外侧那 2r×2r 的角上按圆判，其余按矩形 ✓
      const dx = Math.max(bar.x0 + radius - x, 0, x - (bar.x1 - radius))
      const dy = Math.max(bar.y0 + radius - y, 0, y - (bar.y1 - radius))
      if (dx * dx + dy * dy <= radius * radius) return true
    }
    return false
  }
  // 3×3 超采样：512 上也就是 2.4M 次判定，请求时算一次并缓存 ✓（边缘不会有锯齿）
  const samples = 3
  const rgba = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let hits = 0
      for (let sy = 0; sy < samples; sy += 1) {
        for (let sx = 0; sx < samples; sx += 1) {
          if (insideBar(x + (sx + 0.5) / samples, y + (sy + 0.5) / samples)) hits += 1
        }
      }
      const coverage = hits / (samples * samples)
      const at = (y * size + x) * 4
      rgba[at] = Math.round(BACKGROUND.r + (FOREGROUND.r - BACKGROUND.r) * coverage)
      rgba[at + 1] = Math.round(BACKGROUND.g + (FOREGROUND.g - BACKGROUND.g) * coverage)
      rgba[at + 2] = Math.round(BACKGROUND.b + (FOREGROUND.b - BACKGROUND.b) * coverage)
      rgba[at + 3] = 0xff
    }
  }
  return rgba
}

const iconCache = new Map<string, Buffer>()

/**
 * 取一张图标的 PNG 字节（同一尺寸 + 变体只算一次）✓。
 *
 * ★ 优先用**生成物**：用户要求把图标换成 DeepSeek 的鲸鱼之后，图标不再由这段代码画，
 *   而是 `scripts/make-app-icons.mjs` 用无头 Chrome 把官方 SVG 栅格化成三张 PNG，
 *   内联进 `app-icons-asset.ts` ✓（源文件在 `packages/host/assets/deepseek-whale.svg`）。
 *
 * 为什么还留着"用代码画"的那一版：它是**回退**，不是死代码 ✓ ——
 *   · 仓库里删掉生成物（或换台机器没跑生成脚本）时，服务仍然给出**合法可安装**的图标 ✓，
 *     而不是 500 或者缺图标导致 Chrome 判定不可安装 ✗；
 *   · 单测里那几条"PNG 尺寸正确 / maskable 有安全区"的断言对两版都成立 ✓，
 *     于是"回退坏了"这件事也会被测出来 ✓。
 *
 * 生成物损坏（base64 不合法、PNG 头不对）时同样回退，并在返回值里**不静默** ——
 * 由验收脚本比对线上字节来发现 ✓（`check-mobile-layout` 里那条"图标就是鲸鱼"的断言）。
 */
export function iconPng(size: number, options: { maskable?: boolean } = {}): Buffer {
  const key = `${size}${options.maskable === true ? '-maskable' : ''}`
  const cached = iconCache.get(key)
  if (cached !== undefined) return cached
  const asset = appIconAsset(size, options.maskable === true)
  let png: Buffer | undefined
  if (asset !== undefined) {
    const decoded = Buffer.from(asset.base64, 'base64')
    // 只认"真的是一张 size×size 的 PNG"，否则宁可回退也不要发一张坏图 ✗
    if (decoded.length > 24 && decoded.readUInt32BE(0) === 0x89504e47 && decoded.readUInt32BE(16) === size) {
      png = decoded
    }
  }
  const bytes = png ?? encodePng(size, size, renderIconRgba(size, options))
  iconCache.set(key, bytes)
  return bytes
}

/**
 * 「添加到主屏幕」用的 web app manifest。
 *
 * `start_url` 指向**手机外壳**（`/mobile/app`）而不是 `/` ✓ ——
 * `/` 是 DSH 的 token/cookie 认证入口，手机打开它只会 401 死循环 ✗
 * （那条事故写在 `cordis.ts` 的注释里）。
 */
export function buildWebAppManifest(): Record<string, unknown> {
  return {
    id: '/mobile/app',
    name: 'DSH Mobile',
    short_name: 'DSH',
    description: '手机安全接入电脑上的 DeepSeek Harness（端到端加密隧道）',
    start_url: '/mobile/app',
    scope: '/mobile/',
    display: 'standalone',
    orientation: 'any',
    background_color: '#0f1115',
    theme_color: '#0f1115',
    lang: 'zh-CN',
    icons: [
      { src: '/mobile/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/mobile/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/mobile/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  }
}
