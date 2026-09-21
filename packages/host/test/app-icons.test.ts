/**
 * PWA 图标与 manifest 的单元测试。
 *
 * ## 为什么自己写的 PNG 编码器必须单测
 *
 * 它是**手写的二进制格式** ✗ —— 出错时不会抛异常，只会生成一张"能下载但打不开"的图，
 * 而手机上看到的只是"图标是空白的" ✓（正是这个项目最怕的那类静默失败）。
 * 所以这里逐层验：签名 → IHDR 字段 → IDAT 能解压且长度对 → 每个 chunk 的 CRC 对 ✓。
 * 另外验收脚本还会用 macOS 的 `sips` / `file` **再独立复核一次**（自己不能只信自己）✓。
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { inflateSync } from 'node:zlib'

import { APP_ICON_ASSETS, appIconAsset } from '../src/app-icons-asset.ts'
import { buildWebAppManifest, crc32, encodePng, iconPng, renderIconRgba } from '../src/app-icons.ts'

/** 把 PNG 拆成 chunk 列表（用于逐块校验 CRC 与内容）✓。 */
function readChunks(png: Buffer): { type: string; data: Buffer; crcOk: boolean }[] {
  const out: { type: string; data: Buffer; crcOk: boolean }[] = []
  let at = 8
  while (at + 8 <= png.length) {
    const length = png.readUInt32BE(at)
    const type = png.subarray(at + 4, at + 8).toString('ascii')
    const data = png.subarray(at + 8, at + 8 + length)
    const stored = png.readUInt32BE(at + 8 + length)
    out.push({ type, data, crcOk: stored === crc32(png.subarray(at + 4, at + 8 + length)) })
    at += 12 + length
    if (type === 'IEND') break
  }
  return out
}

/**
 * ★ 这一组测的是**手写编码器**，所以一律直接调 `encodePng` / `renderIconRgba` ✓。
 *
 * 为什么要改：图标换成官方鲸鱼之后，`iconPng()` 返回的是"无头 Chrome 栅格化的生成物"，
 * 它可能用调色板/非零 filter（那是浏览器的自由 ✗）；继续拿 `iconPng()` 的输出去断言
 * "位深 8、颜色类型 6、每行 filter 都是 0"就等于在断言"Chrome 必须按我们的编码器输出" ✗
 * —— 测试会红，但它红得毫无意义 ✓（这类"测错了对象"的红，本项目已经吃过几次）。
 */
describe('PWA 图标：手写 PNG 编码器（回退路径）', () => {
  it('签名、IHDR 字段、IEND 都对（8 位 RGBA、非隔行）', () => {
    const png = encodePng(192, 192, renderIconRgba(192))
    assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'PNG 签名不对')
    const chunks = readChunks(png)
    assert.equal(chunks[0]?.type, 'IHDR')
    assert.equal(chunks[0]?.data.readUInt32BE(0), 192)
    assert.equal(chunks[0]?.data.readUInt32BE(4), 192)
    assert.equal(chunks[0]?.data[8], 8, '位深应为 8')
    assert.equal(chunks[0]?.data[9], 6, '颜色类型应为 6（RGBA）')
    assert.equal(chunks[0]?.data[12], 0, '不应是隔行')
    assert.equal(chunks.at(-1)?.type, 'IEND')
    assert.ok(chunks.every((c) => c.crcOk), '有 chunk 的 CRC 不对')
  })

  it('IDAT 解压后长度正确、且每行的 filter 字节都是 0', () => {
    const size = 96
    const png = encodePng(size, size, renderIconRgba(size))
    const idat = readChunks(png).find((c) => c.type === 'IDAT')
    assert.ok(idat !== undefined)
    const raw = inflateSync(idat.data)
    assert.equal(raw.length, (size * 4 + 1) * size, '解压后的原始扫描线长度不对')
    for (let y = 0; y < size; y += 1) assert.equal(raw[y * (size * 4 + 1)], 0, `第 ${y} 行的 filter 不是 0`)
  })

  it('maskable 变体与普通版不同，但同样是合法 PNG', () => {
    const plain = encodePng(512, 512, renderIconRgba(512))
    const maskable = encodePng(512, 512, renderIconRgba(512, { maskable: true }))
    assert.notEqual(plain.length, maskable.length, '两个变体不该一模一样（安全区不同）')
    assert.equal(readChunks(maskable)[0]?.data.readUInt32BE(0), 512)
    assert.ok(readChunks(maskable).every((c) => c.crcOk))
  })

  it('画出来的像素确实是"深底 + 白色前景"（不是全黑或全白）', () => {
    const rgba = renderIconRgba(64)
    let white = 0
    let dark = 0
    for (let i = 0; i < rgba.length; i += 4) {
      const value = rgba[i]!
      if (value > 200) white += 1
      else if (value < 40) dark += 1
    }
    assert.ok(white > 0, '没有白色前景')
    assert.ok(dark > white, '背景应占多数')
  })

  it('同一尺寸只算一次（缓存返回同一个 Buffer）', () => {
    assert.equal(iconPng(192), iconPng(192))
  })

  it('像素数不对时立刻报错（而不是生成一张坏图）', () => {
    assert.throws(() => encodePng(4, 4, Buffer.alloc(9)), /像素数不对/)
  })
})

/**
 * 生成物（官方鲸鱼栅格化）这一组。
 *
 * 为什么值得单独测：这三张图是**二进制**，出错时不会抛异常，
 * 手机上只表现为"图标空白/还是旧的" ✗（正是本项目最怕的静默失败）。
 * 这里断言的是"服务出去的到底是不是生成物那张" ✓ —— 而不是"代码里有没有引用它" ✓。
 */
describe('PWA 图标：生成物（官方鲸鱼）', () => {
  it('三张都在（192 / 512 / maskable-512），且都是尺寸正确的合法 PNG', () => {
    assert.equal(APP_ICON_ASSETS.length, 3, '应有 192 / 512 / maskable-512 三张')
    for (const size of [192, 512]) {
      const asset = appIconAsset(size, false)
      assert.ok(asset !== undefined, `缺 ${size} 普通版`)
      const bytes = Buffer.from(asset!.base64, 'base64')
      assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', `${size} 不是 PNG`)
      assert.equal(bytes.readUInt32BE(16), size, `${size} 的 IHDR 宽度不对`)
      assert.equal(bytes.readUInt32BE(20), size, `${size} 的 IHDR 高度不对`)
      assert.ok(bytes.length > 1000, `${size} 太小了，像是空图`)
    }
    const maskable = appIconAsset(512, true)
    assert.ok(maskable !== undefined, '缺 maskable-512')
    assert.equal(Buffer.from(maskable!.base64, 'base64').readUInt32BE(16), 512)
  })

  it('普通版与 maskable 版是**两张不同的图**（安全区不同，不能拿同一张糊弄）', () => {
    const plain = appIconAsset(512, false)!
    const maskable = appIconAsset(512, true)!
    assert.notEqual(plain.base64, maskable.base64)
  })

  it('服务出去的就是生成物本身（iconPng 不再走"代码画"的那条路）', () => {
    const served = iconPng(192)
    const asset = Buffer.from(appIconAsset(192, false)!.base64, 'base64')
    assert.equal(served.toString('base64'), asset.toString('base64'), 'iconPng(192) 不是生成物')
    const drawn = encodePng(192, 192, renderIconRgba(192))
    assert.notEqual(served.toString('base64'), drawn.toString('base64'), '还在发代码画的那一版 ✗')
  })
})

describe('PWA manifest：可安装性清单', () => {
  it('名字 / short_name / start_url / 独立窗口 / 192 与 512 图标齐全', () => {
    const manifest = buildWebAppManifest()
    assert.equal(typeof manifest['name'], 'string')
    assert.equal(typeof manifest['short_name'], 'string')
    // ★ start_url 必须是手机外壳：`/` 是 DSH 的 token/cookie 入口，手机打开只会 401 死循环
    assert.equal(manifest['start_url'], '/mobile/app')
    assert.equal(manifest['display'], 'standalone')
    const icons = manifest['icons'] as { sizes: string; type: string; purpose?: string }[]
    const sizes = icons.map((icon) => icon.sizes)
    assert.ok(sizes.includes('192x192'), '缺 192 图标（Chrome 硬条件）')
    assert.ok(sizes.includes('512x512'), '缺 512 图标（Chrome 硬条件）')
    assert.ok(icons.some((icon) => icon.purpose === 'maskable'), '缺 maskable 图标（Android 遮罩会裁）')
    assert.ok(icons.every((icon) => icon.type === 'image/png'))
  })
})
