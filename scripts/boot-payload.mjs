/**
 * boot.js 的**载荷变换**（构建与安装共用的唯一实现）。
 *
 * ## 为什么必须抽出来
 *
 * `boot.js` 有**两条上线路径**：
 *   1. `npm run build`（`build-lib.mjs`）→ `packages/host/lib/boot.js`；
 *   2. `install-host-plugin.mjs` → 直接读 `packages/client/src/boot.js` 写进 profile。
 *
 * 它们**各自**做了一遍"占位符替换"✗ —— 只要有一处变换只在其中一条路径实现，
 * 就会变成"本地/临时实例正常、手机上是旧的" ✗（极其难查：两边代码看着都对 ✓）。
 *
 * round 98 就真栽了一次：公式渲染器（Temml）的内联副本只加在 `build-lib.mjs` 里 ✗，
 * 于是**装到手机上那份 boot.js 里还是占位符** ✓ ——
 * 现象是"手机上公式仍然按原样 TeX 显示"，而验收脚本（装的是 lib ✓）却全绿 ✗✓。
 *
 * 所以：**所有对 boot.js 源码的改写都只在这里实现** ✓，
 * 两条路径都调它 ✓，谁也别自己 `.split(...).join(...)` ✗。
 *
 * ## 目前有两个变换
 *
 * 1. **构建戳**：`__DSHM_BOOT_STAMP__` → `BUILD-yymmddhhmmss` ✓
 *    （唯一用途是回答"手机上跑的是哪一版"，原样上线就等于当场作废 ✗）；
 * 2. **公式渲染器内联**：`'__DSHM_TEMML_GZIP_BASE64__'` → Temml 源码的
 *    gzip+base64 字面量 ✓（168 KB → ~66 KB ✓）——
 *    内联是为了"**用户不需要重启**" ✓：宿主路由要重启 ✗，而 boot.js 每次请求从磁盘读 ✓。
 *    客户端只在第一次遇到公式时才解压 ✓。
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..')

/** 内联副本的源（`packages/host/assets/` 下的版本化文件 ✓）。 */
const TEMML_SOURCE = join(repoRoot, 'packages', 'host', 'assets', 'temml-0.13.5.min.js')

/** 当前的构建戳（`BUILD-yymmddhhmmss`，本地时间 ✓）。 */
export function bootStamp(now = new Date()) {
  return 'BUILD-' + now.toISOString().replace(/[-:T]/g, '').slice(4, 14)
}

/** Temml 源码的 gzip+base64（文件不在时返回空串 ✓ —— 客户端会回退并**说明原因** ✓）。 */
export function temmlInlineBase64(sourcePath = TEMML_SOURCE) {
  if (!existsSync(sourcePath)) return ''
  return gzipSync(readFileSync(sourcePath), { level: 9 }).toString('base64')
}

/**
 * 把 boot.js 源码变成"可以上线的那份"。
 *
 * @param source - `packages/client/src/boot.js` 的原文 ✓。
 * @param stamp  - 本次的构建/安装戳 ✓。
 * @param temmlBase64 - 可注入 Temml 副本；不传则现算 ✓（测试里可传空串模拟"没有渲染器"✓）。
 */
export function buildBootPayload(source, { stamp, temmlBase64 } = {}) {
  const base64 = temmlBase64 === undefined ? temmlInlineBase64() : temmlBase64
  return String(source)
    .split('__DSHM_BOOT_STAMP__')
    .join(String(stamp ?? bootStamp()))
    .split("'__DSHM_TEMML_GZIP_BASE64__'")
    .join(JSON.stringify(base64))
}
