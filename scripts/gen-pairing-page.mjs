#!/usr/bin/env node
/**
 * 把 packages/host/src/pairing-page.html 生成成 TypeScript 字符串常量。
 *
 * 为什么要生成而不是运行时读文件：插件安装进 profile 时只复制 lib/，
 * 运行时用相对路径去读 HTML 会在"文件没被复制"或"工作目录不同"时静默失败。
 * 编译进模块则永远跟随构建产物，且省一次 IO。
 *
 * 顺带做**二维码编码器的内联** ✓：`pairing-page.html` 里只有占位符 ✓，
 * 真正的源码在 `packages/host/assets/qrcode-generator-2.0.4.js` ✓——
 * 规则（sha256 校验 + 替换 + 取回）全部在 `scripts/qr-vendor.mjs` ✓。
 *
 * 运行：node scripts/gen-pairing-page.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { QR_VENDOR_PATH, injectQrVendor, qrVendorInlineSource, sha256Hex } from './qr-vendor.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = dirname(here)
const htmlPath = join(repoRoot, 'packages', 'host', 'src', 'pairing-page.html')
const outPath = join(repoRoot, 'packages', 'host', 'src', 'pairing-page.ts')

/**
 * ★ 先把二维码编码器注入进来 ✓ —— 页面里只有占位符 ✓。
 *
 * 为什么放在这里而不是让源码里那份 56 KB 常驻 HTML：
 *   · 版本/来源/sha256/许可只在一处（`packages/host/assets/`）✓；
 *   · 注入前校验 sha256 ✓ ⇒ 仓库里的编码器被换掉时**当场失败** ✗
 *     （否则就是"页面照常打开、二维码照常画出来，只有手机扫不上" ✗ ——
 *     本项目对这类"看着都好"的失败特别警惕 ✓）。
 */
const sourceHtml = readFileSync(htmlPath, 'utf8')
let html
try {
  html = injectQrVendor(sourceHtml, qrVendorInlineSource())
} catch (error) {
  console.error(`[gen-pairing-page] 注入二维码编码器失败：${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
const vendorSha = sha256Hex(qrVendorInlineSource())
console.log(
  `[gen-pairing-page] 已内联二维码编码器（${QR_VENDOR_PATH.split('/').pop()}，sha256 ${vendorSha.slice(0, 16)}…）`,
)

if (html.includes('`')) {
  console.error('[gen-pairing-page] HTML 里含有反引号，需改用其他嵌入方式')
  process.exit(1)
}

/**
 * 把 HTML 安全地嵌入模板字面量。
 *
 * **这是本文件唯一容易出错的地方**：直接把 HTML 放进模板字面量时，
 * 其中的 `\s`、`\(` 等序列会被 JS **当作转义序列解析**，反斜杠就此消失——
 * 曾因此把页面里的正则 `/Android[^;]*;\s*(...)/` 变成 `/Android[^;]*;s*(...)/`，
 * 于是内联脚本语法错误、整个配对页卡在"正在加载"（页面看起来是好的，极难定位）。
 * 因此必须把反斜杠翻倍，并顺带处理 `${` 与（已在上方禁止的）反引号。
 */
function escapeForTemplateLiteral(source) {
  return source.replace(/\\/g, '\\\\').replace(/\$\{/g, '\\${')
}

const output = `/**
 * 配对页 HTML —— **由 scripts/gen-pairing-page.mjs 自动生成，请勿手工编辑**。
 * 源文件：packages/host/src/pairing-page.html
 *
 * 生成时间：${new Date().toISOString()}
 * 大小：${Buffer.byteLength(html, 'utf8')} 字节
 *
 * ★ 下面两个 sha256 是给校验脚本用的"同步戳" ✓（scripts/check-pairing-page.mjs ✓）：
 *   源 HTML 改过、或 vendored 编码器换过之后**忘了重新跑本脚本** ✗ 时，
 *   构建产物里的 HTML 还是旧的 ✓ ⇒ 那两个戳对不上 ⇒ 校验当场报红 ✗。
 *   为什么不用"比对正文"的办法 ✗：那要把模板字面量转义规则再抄一份 ✓（迟早走偏 ✗）。
 * 源 HTML sha256：${sha256Hex(sourceHtml)}
 * 内联编码器 sha256：${vendorSha}
 */
export const PAIRING_PAGE_HTML = \`${escapeForTemplateLiteral(html)}\`
`
writeFileSync(outPath, output, 'utf8')
console.log(`[gen-pairing-page] 已生成 ${outPath}（${Buffer.byteLength(html, 'utf8')} 字节）`)
