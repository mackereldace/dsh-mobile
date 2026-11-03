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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
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
/**
 * ★★ 2026-11-03 真机事故：**模块 id 必须等于「包名」** ✗
 *
 * DSH 的 `dsh-client-modules` 规定：浏览器侧 `__ModuleLoader__.load({ id })` 的
 * `id` **必须等于包名**（graph 行按包名去找这个模块）✓。
 * 桥单独成包时包名是 `@dsh-mobile/bridge`，所以原先直接照抄 ✓；
 * 并进 host 之后**包名变成了 `@dsh-mobile/host`**，再照抄就变成：
 *   · 注册的是 `@dsh-mobile/bridge` ⇒ host 那一行 `import failed: could not load
 *     "@dsh-mobile/host" … loaded without registering "@dsh-mobile/host"` ✗
 *   · 同一个文件被 boot 的合并包与逐行包各执行一次 ⇒
 *     `duplicate factory registration for "@dsh-mobile/bridge"` ✗
 * ⇒ 整个 web boot 失败（用户看到的"开插件就进不去、只能禁用"✓）。
 *
 * 所以复制时**必须把 id 换成 host 的包名** ✓；桥自己那份（单独装桥的人）保持原名 ✓。
 * 替换数必须是 1：将来桥里多出第二个 id 字面量时，这里**当场报错**，不要静默半改 ✗。
 */
const sourceText = readFileSync(source, 'utf8')
const idPattern = /id: '@dsh-mobile\/bridge'/g
const matches = sourceText.match(idPattern)
if (matches === null || matches.length !== 1) {
  throw new Error(
    `[copy-bridge] 期望 client.js 里恰好 1 处 id: '@dsh-mobile/bridge'，实际 ${matches === null ? 0 : matches.length} 处 —— 拒绝生成可能半改的 client.js`,
  )
}
const rewritten = sourceText.replace(idPattern, "id: '@dsh-mobile/host'")
writeFileSync(destination, rewritten)
console.log(`[copy-bridge] 已生成 client.js → ${destination}（${rewritten.length} 字节；模块 id = @dsh-mobile/host）`)
