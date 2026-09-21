#!/usr/bin/env node
/**
 * 把 packages/host/src/pairing-page.html 生成成 TypeScript 字符串常量。
 *
 * 为什么要生成而不是运行时读文件：插件安装进 profile 时只复制 lib/，
 * 运行时用相对路径去读 HTML 会在"文件没被复制"或"工作目录不同"时静默失败。
 * 编译进模块则永远跟随构建产物，且省一次 IO。
 *
 * 运行：node scripts/gen-pairing-page.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = dirname(here)
const htmlPath = join(repoRoot, 'packages', 'host', 'src', 'pairing-page.html')
const outPath = join(repoRoot, 'packages', 'host', 'src', 'pairing-page.ts')

const html = readFileSync(htmlPath, 'utf8')
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
 */
export const PAIRING_PAGE_HTML = \`${escapeForTemplateLiteral(html)}\`
`
writeFileSync(outPath, output, 'utf8')
console.log(`[gen-pairing-page] 已生成 ${outPath}（${Buffer.byteLength(html, 'utf8')} 字节）`)
