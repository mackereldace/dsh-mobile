#!/usr/bin/env node
/**
 * 把**浏览器半** `src/client.js` 复制成 `lib/client.js`。
 *
 * ## 为什么源码放在 `src/`、不是直接手改 `lib/`
 *
 * `lib/` 是构建产物（`lib/boot.js` 也是 `src/boot.js` 的复制 ✓），
 * 手改 `lib/client.js` 会在下一次构建时被覆盖 ✗，而且"源码在哪"会变模糊 ✓。
 * 现在与 `copy-boot.mjs` 同一形状：`src/` 是真源 ✓，`lib/` 随包发布 ✓。
 *
 * ## 为什么复制时**必须**检查模块 id（2026-11-03 真机事故）
 *
 * DSH 的 `dsh-client-modules` 用 **graph 行的包名**（`@dsh-mobile/host`）去取
 * 浏览器模块 ✗ —— `window.__ModuleLoader__.load({ id })` 的 `id` **必须等于包名** ✓。
 * 并包初版误抄成 `@dsh-mobile/bridge` ✗，后果是 web boot 直接失败：
 *   · `client-modules: duplicate factory registration for "@dsh-mobile/bridge"`
 *   · `web boot: 1 entry did not activate / @dsh-mobile/host: import failed`
 * ⇒ **一启用插件 DSH 页面就进不去** ✓（用户实测"只能禁用插件再进入"✓）。
 *
 * 所以这里两道断言：id **恰好 1 处**、且**不许**再出现旧包名 ✓。
 * 断言失败就**拒绝生成** lib/client.js（宁可不构建，也不发布一个会让页面进不去的包 ✗）。
 *
 * ## 发行仓
 *
 * `dsh-mobile-plugin` 仓库只有 `lib/`（没有 `src/`）⇒ 源文件不存在 ⇒ **跳过** ✓
 * （那里用已提交的 `lib/client.js` 快照 ✓，与 `copy-boot.mjs` 同一条约定 ✓）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const packageRoot = dirname(here)
const source = join(packageRoot, 'src', 'client.js')
const destinationDirectory = join(packageRoot, 'lib')
const destination = join(destinationDirectory, 'client.js')

if (!existsSync(source)) {
  console.log(`[copy-client] 没有源文件（${source}）⇒ 跳过（发行仓用已提交的 lib/client.js 快照）`)
  process.exit(0)
}

const text = readFileSync(source, 'utf8')
/**
 * ★ 把**二维码编码器**内联进产物 ✓ —— 配对面板在客户端画 QR（不依赖宿主路由 ✓），
 *   而面板源码不该被 56KB 的第三方库淹没 ✗ ⇒ 只在构建时拼：
 *   库在 bundle 顶层执行（`var qrcode` 与拼接后的 wrapper 同一个作用域）✓，
 *   wrapper 把它挂到 `globalThis.__DSHM_QR__`；客户端工厂运行得晚，读得到 ✓。
 *   库是 MIT（Kazuhiko Arase），文件头许可证保留在下面 ✓。
 */
const qrAsset = join(packageRoot, 'assets', 'qrcode-generator-2.0.4.js')
let qrPrelude = ''
if (existsSync(qrAsset)) {
  const qrSource = readFileSync(qrAsset, 'utf8')
  /**
   * ★ 只取库的**核心**（`var qrcode = function(){…}()`），**丢掉尾部 UMD 包装** ✗ ——
   *   那段会嗅 `define` / `exports` / `module` ✓：在 DSH 的客户端 bundle 里如果恰好有
   *   `exports` 而没有 `module`（或反过来），它会**当场 throw** ✗，整个 bundle 加载失败
   *   （手机上真机报的就是 "bundle script … failed to load" ✓）。
   *   再把它包进一个**懒工厂** ✓：不在 bundle 顶层执行第三方代码，只有面板真要画二维码时才跑 ✓。
   */
  const umdStart = qrSource.lastIndexOf('(function (factory) {')
  const qrCore = umdStart > 0 ? qrSource.slice(0, umdStart) : qrSource
  qrPrelude =
    '/* ===== qrcode-generator-2.0.4.js（随包内联；MIT，Copyright (c) 2009 Kazuhiko Arase）===== */\n' +
    'globalThis.__DSHM_QR_FACTORY__ = function () {\n' +
    qrCore +
    '\n  return typeof qrcode === \'function\' ? qrcode : undefined\n' +
    '}\n' +
    '/* ===== @dsh-mobile/host client ===== */\n'
} else {
  console.warn('[copy-client] 警告：assets/qrcode-generator-2.0.4.js 不存在 ⇒ 配对面板的二维码会降级为文字提示')
}
const expectedId = /id: '@dsh-mobile\/host'/g
const expectedMatches = text.match(expectedId)
if (expectedMatches === null || expectedMatches.length !== 1) {
  throw new Error(
    `[copy-client] 期望 client.js 里恰好 1 处 id: '@dsh-mobile/host'，实际 ${expectedMatches === null ? 0 : expectedMatches.length} 处 —— ` +
      'DSH 用包名取模块，id 写错会让 web boot 失败（见本脚本开头的事故说明）',
  )
}
if (text.includes("id: '@dsh-mobile/bridge'")) {
  throw new Error("[copy-client] client.js 里仍有旧包名 id: '@dsh-mobile/bridge' —— 必须改成 @dsh-mobile/host 再构建")
}

mkdirSync(destinationDirectory, { recursive: true })
const bundled = qrPrelude + text
writeFileSync(destination, bundled)
console.log(
  `[copy-client] 已生成 client.js → ${destination}（${Buffer.byteLength(bundled)} 字节；模块 id = @dsh-mobile/host${qrPrelude === '' ? '；二维码编码器未内联' : '；已内联二维码编码器'}）`,
)
