#!/usr/bin/env node
/**
 * 把**桥的客户端半**复制到宿主包的 `lib/client.js`。
 *
 * ## 为什么桥并进 host（2026-10-31）
 *
 * 用户要把仓库给普通用户，让他们的 agent 直接装好 ✓。原先桥是**单独一个包**
 * （`@dsh-mobile/bridge`，`private: true`，只在主仓 `packages/bridge` 里）✗：
 * 官方插件管理装不了主仓的子目录，README 的"装两次"又没有桥的地址 ✗
 * ⇒ 普通用户装完 host，手机上的 `__DSHM_DSH_COMMANDS__` / slash / sidebarRight
 * 这些 DSH 客户端钩子全都没有 ✓。
 *
 * 并法：host 的 `package.json` 声明 `dsh.client`（inject 沿用桥那 5 项 ✓）+
 * `exports["./client"] = "./lib/client.js"` ✓ —— 桥的宿主半本来就是**空 apply** ✓，
 * host 自己已有 cordis 行（客户端 bundle 注册要求的 graph 行 ✓）⇒ 不需要再插一行 ✓。
 * 于是仍然是一个 bundle、零依赖 ✓（`blockExoticSubdeps` 不会挡 ✓）。
 *
 * 单一事实来源：`packages/bridge/lib/client.js` ✓（本次为复制，不是生成 ✓）。
 * 发行仓（`dsh-mobile-plugin`）没有 `../bridge` ⇒ **跳过** ✓（lib/client.js 是快照 ✓）。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const packageRoot = dirname(here)
const source = join(packageRoot, '..', 'bridge', 'lib', 'client.js')
const destinationDirectory = join(packageRoot, 'lib')
const destination = join(destinationDirectory, 'client.js')

if (!existsSync(source)) {
  console.log(`[copy-bridge] 没有源文件（${source}）⇒ 跳过（发行仓用已提交的 lib/client.js 快照）`)
  process.exit(0)
}

mkdirSync(destinationDirectory, { recursive: true })
copyFileSync(source, destination)
console.log(`[copy-bridge] 已复制 client.js → ${destination}（${readFileSync(destination).length} 字节）`)
