#!/usr/bin/env node
/**
 * 配对页二维码编码器的 **vendor 清单 + 注入 + 取回**（只有这一份实现 ✓）。
 *
 * ## 为什么要有这个文件
 *
 * 二维码编码器必须**内联**进配对页 ✓（那页零外部请求 ✗ 不许 CDN ✗），但它是一份
 * 56 KB 的第三方源码 ✓ —— 直接粘进 `pairing-page.html` 会有两个后果 ✗：
 *   1. 谁也无法一眼看出"页面里那段到底是什么版本、有没有被改过" ✗；
 *   2. 手改一处就**静默**偏离上游 ✗（二维码看着还是二维码，只是扫出来不对 ✗）。
 *
 * 所以：源码单独摆放 ✓（`packages/host/assets/qrcode-generator-2.0.4.js` ✓，来源/版本/
 * sha256/许可正文见同目录 `qrcode-generator.README.md` ✓），页面里只留占位符 ✓，
 * 由 `scripts/gen-pairing-page.mjs` 注入 ✓，`scripts/check-pairing-page.mjs` 再从
 * **构建产物**里把它取回来与源码逐字节比对 ✓。
 *
 * ★ 校验（sha256）与取回的规则**三处共用这一份** ✓：注入端 ✓、校验端 ✓、
 *   以后要加别的消费方也走这里 ✓ —— 谁也别自己写一遍 split/join ✗
 *   （本项目在 boot.js 的 Temml 内联上真栽过一次"两条路径各写一份" ✓，
 *   见 `scripts/boot-payload.mjs` 的头注释 ✓）。
 */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

/** vendored 源码（**仓库里唯一的那份** ✓）。 */
export const QR_VENDOR_PATH = join(here, '..', 'packages', 'host', 'assets', 'qrcode-generator-2.0.4.js')

/**
 * ★ 钉死的 sha256 ✓（= `packages/host/assets/qrcode-generator.README.md` 上表里的值 ✓）。
 *
 * 与 `scripts/build-apk.mjs` 钉死 zxing jar 的做法一致 ✓：换版本必须**同时**改这里 ✓，
 * 于是"仓库里的编码器被换掉"从来不是静默事件 ✗。
 */
export const QR_VENDOR_SHA256 = '79ec86f82856005b1c887905cfccfcfbec3821ca61c7fd5a952faa5f778f791c'

/** 页面里圈出内联源码的两个标记（各自独占一行 ✓）。 */
export const QR_VENDOR_BEGIN = '/* __DSHM_QR_VENDOR_BEGIN__ */'
export const QR_VENDOR_END = '/* __DSHM_QR_VENDOR_END__ */'

/** 页面里等着被替换的占位符 ✓。 */
export const QR_VENDOR_PLACEHOLDER = '/* __DSHM_QR_VENDOR__ */'

/** sha256 十六进制小写 ✓（注入端与校验端用同一个函数 ✓）。 */
export function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex')
}

/**
 * 读 vendored 源码并**校验 sha256** ✓。
 *
 * 对不上就抛 ✗ —— 绝不允许"用一份来路不明的编码器生成用户的配对码" ✗。
 */
export function readQrVendorSource(path = QR_VENDOR_PATH) {
  const bytes = readFileSync(path)
  const actual = createHash('sha256').update(bytes).digest('hex')
  if (actual !== QR_VENDOR_SHA256) {
    throw new Error(
      `二维码编码器 sha256 不符：期望 ${QR_VENDOR_SHA256}，实际 ${actual}\n` +
        `  文件：${path}\n` +
        '  换版本请**同时**更新 packages/host/assets/qrcode-generator.README.md、' +
        'scripts/qr-vendor.mjs 与 scripts/check-pairing-page.mjs 里的黄金样本',
    )
  }
  return bytes.toString('utf8')
}

/**
 * 要内联进页面的形态：去掉文件末尾**那一个**换行 ✓。
 *
 * 为什么：占位符在页面里独占一行 ✓，而源码本身以 `\n` 结尾 ✓ ——
 * 不去掉就会在"源码末行"与结束标记之间多出一个空行 ✓，
 * 于是"页面里那段 === 仓库里那份"的逐字节比对会无谓地失败 ✗。
 */
export function qrVendorInlineSource(source = readQrVendorSource()) {
  return source.endsWith('\n') ? source.slice(0, -1) : source
}

/** 把占位符换成内联源码 ✓（占位符必须**恰好出现一次** ✗ 否则抛 ✗）。 */
export function injectQrVendor(html, source = qrVendorInlineSource()) {
  const hits = html.split(QR_VENDOR_PLACEHOLDER).length - 1
  if (hits !== 1) {
    throw new Error(`pairing-page.html 里 ${QR_VENDOR_PLACEHOLDER} 必须恰好出现 1 次，实际 ${hits} 次`)
  }
  if (!html.includes(QR_VENDOR_BEGIN) || !html.includes(QR_VENDOR_END)) {
    throw new Error(`pairing-page.html 缺少 ${QR_VENDOR_BEGIN} / ${QR_VENDOR_END} 标记（源码段无法被校验）`)
  }
  const injected = html.split(QR_VENDOR_PLACEHOLDER).join(source)
  if (injected.includes(QR_VENDOR_PLACEHOLDER)) {
    throw new Error('注入后仍残留二维码占位符（源码里含该标记？）')
  }
  return injected
}

/**
 * 从任意一份 HTML（**尤其是构建产物** ✓）里取回内联的那段源码 ✓。
 *
 * 找不到标记时返回 `undefined` ✓（调用方负责把它变成一条明确的错误 ✗）。
 */
export function extractQrVendor(html) {
  const start = html.indexOf(QR_VENDOR_BEGIN)
  const end = html.indexOf(QR_VENDOR_END)
  if (start === -1 || end === -1 || end < start) return undefined
  let inner = html.slice(start + QR_VENDOR_BEGIN.length, end)
  if (inner.startsWith('\n')) inner = inner.slice(1)
  // ★ 去尾必须写 slice(0, -1) ✗ 别写成 slice(1) ✗ ——
  //   后者会把**开头**那个字符吃掉（曾因此让"页面里那段"与仓库里那份差一个 '/'，
  //   而长度居然还对得上：尾部的换行没被去掉 ✓ 于是两处抵消 ✗）。
  if (inner.endsWith('\n')) inner = inner.slice(0, -1)
  return inner
}
