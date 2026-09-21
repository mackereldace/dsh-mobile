#!/usr/bin/env node
/**
 * 把浏览器端 boot.js 复制到宿主包的 lib/ 目录。
 *
 * ## 为什么需要这一步
 *
 * `cordis.ts` 按**自身所在目录**解析注入脚本：
 *
 * ```js
 * const bootScriptPath = config.bootScriptPath ?? join(dirname(fileURLToPath(import.meta.url)), 'boot.js')
 * ```
 *
 * 源码在 `src/cordis.ts` 时它指向 `src/boot.js`（不存在），编译后指向 `lib/boot.js`。
 * 因此 `lib/boot.js` 必须存在——否则 `bootScript` 为 undefined，
 * `tapIndex` 会**静默地**什么也不注入：电脑端看着一切正常，
 * 只有手机端表现为"页面打开了但连不上"，而且没有任何报错。
 *
 * 安装脚本会把 `packages/client/src/boot.js` 复制进 profile，
 * 所以"通过安装脚本部署"这条路径一直是好的，掩盖了"直接跑源码/跑构建产物"这条路径的缺失。
 * 这里把它补成构建的一部分，保证两条路径一致。
 *
 * 单一事实来源仍是 `packages/client/src/boot.js`（本次为复制，不是生成）。
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const packageRoot = dirname(here)
const source = join(packageRoot, '..', 'client', 'src', 'boot.js')
const destinationDirectory = join(packageRoot, 'lib')
const destination = join(destinationDirectory, 'boot.js')

if (!existsSync(source)) {
  console.error(`[copy-boot] 找不到源文件：${source}`)
  process.exit(1)
}

mkdirSync(destinationDirectory, { recursive: true })
copyFileSync(source, destination)

const bytes = readFileSync(destination).length
console.log(`[copy-boot] 已复制 boot.js → ${destination}（${bytes} 字节）`)
