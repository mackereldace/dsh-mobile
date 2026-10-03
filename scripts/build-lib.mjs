#!/usr/bin/env node
/**
 * 由 `src/*.ts` **生成** `lib/*.js`。
 *
 * ## 为什么需要它（被真实 bug 逼出来的）
 *
 * 本仓库原本靠"手抄"维持两份代码：`packages/<pkg>/src/*.ts` 是真源，
 * `packages/<pkg>/lib/*.js` 是实际被部署、被执行的那一份。同一天里手抄漏过两处：
 *   · 漏了 `let session;` → 严格模式下"给未声明变量赋值" → ReferenceError；
 *   · 漏了 `session.hostSigningKey = options.identity.signingKey` → 握手拿不到宿主身份。
 * 两次的症状都出现在**别的层**（一次表现为中继认证超时，一次表现为客户端"处理帧失败"），
 * 排查成本极高。
 *
 * 所以：**lib 必须由 src 生成，不允许手改。**
 *
 * ## 做了什么
 *
 *   1. 用 `tsconfig.build.json` 跑 `tsc`（它按 `rewriteRelativeImportExtensions`
 *      把 `./x.ts` 重写成 `./x.js`，正是 Node ESM 需要的形式）；
 *   2. 把产物映射回 `packages/<pkg>/lib/`；
 *   3. **加载校验**：真的 import 一次产物；失败则整体回滚——
 *      部署物坏了会直接影响用户手机，宁可构建失败也不留半成品。
 *
 * 用法：node scripts/build-lib.mjs [--check]
 *   --check  只校验产物可生成，不写盘
 */

import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { bootStamp, buildBootPayload } from './boot-payload.mjs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = dirname(here)
const checkOnly = process.argv.includes('--check')
const PACKAGES = ['host', 'protocol']

const out = mkdtempSync(join(tmpdir(), 'dshm-lib-'))
/** 构建前的内容，用于失败回滚。 */
const backups = []
let failed = false

try {
  execFileSync('npx', ['tsc', '-p', join(repo, 'tsconfig.build.json'), '--outDir', out], { cwd: repo, stdio: 'inherit' })

  for (const pkg of PACKAGES) {
    const built = join(out, pkg, 'src')
    if (!existsSync(built)) throw new Error(`构建产物缺失：${built}`)
    const target = join(repo, 'packages', pkg, 'lib')
    /**
     * 递归列出产物（**相对路径**）。
     * 原来只 `readdirSync` 顶层，于是源码里一旦有子目录（例如 src/codex/），
     * 它编译出来的子目录**永远不会被复制进 lib/**，最后表现为"加载校验时找不到模块"。
     */
    const listBuilt = (dir, prefix) => {
      const out = []
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const rel = prefix === '' ? entry.name : prefix + '/' + entry.name
        if (entry.isDirectory()) out.push(...listBuilt(join(dir, entry.name), rel))
        else if (rel.endsWith('.js') || rel.endsWith('.d.ts') || rel.endsWith('.map')) out.push(rel)
      }
      return out
    }
    const files = listBuilt(built, '')
    if (files.length === 0) throw new Error(`构建产物为空：${built}`)
    if (checkOnly) {
      console.log(`[build-lib] ${pkg}: 可生成 ${files.length} 个文件（--check 不写盘）`)
      continue
    }
    for (const file of files) {
      const to = join(target, file)
      mkdirSync(dirname(to), { recursive: true })
      if (existsSync(to)) backups.push({ to, data: readFileSync(to) })
      copyFileSync(join(built, file), to)
    }
    console.log(`[build-lib] ${pkg}: 已写入 ${files.length} 个文件 → packages/${pkg}/lib/`)
  }

  /**
   * ★★ 把 `@dsh-mobile/protocol` **内联进 host 的 lib** ✓（2026-09-29）。
   *
   * ## 为什么非内联不可 ✗（实测撞出来的，不是设计洁癖 ✓）
   *
   * 官方插件管理从 git 装包时，DSH 给 profile 开着 **`blockExoticSubdeps`** ✓ ——
   * 一条**供应链安全策略**：插件**不许**在自己的子依赖里出现 git 这类"外来"来源 ✗
   *（顶层那个 `github:…` 是允许的 ✓，因为那是用户显式要求的 ✓）。
   * 而我们的 monorepo 里 host 依赖 protocol ✓（本地是 workspace 软链 ✓）⇒ 消费端**两条路都堵** ✗：
   *   · 写 `workspace:*` ⇒ `ERR_PNPM_WORKSPACE_PKG_NOT_FOUND` ✗（消费端没有 workspace 上下文 ✓）；
   *   · 写 `github:…#path:/packages/protocol` ⇒ `ERR_PNPM_EXOTIC_SUBDEP` ✗。
   * ★ 两种错**都真跑出来过** ✓（见 `24-0.17官方插件管理-调研与接入方案.md` 与本轮交单 ✓）。
   *
   * ⇒ 不需要任何账号、也不用改包名的唯一办法：**让 host 自包含** ✓ ——
   *   把 protocol 的编译产物拷进 `host/lib/protocol/` ✓，
   *   再把 host 产物里那几处裸引用改写成相对路径 ✓。
   *
   * ★ 为什么这样改写是安全的 ✓（改之前实测过 ✓）：
   *   · host 的产物是**平铺**的 ✓（`lib/` 下没有子目录 ✓）⇒ `./protocol/index.js` 一定解析得到 ✓；
   *   · 引用**全是裸名** `'@dsh-mobile/protocol'` ✓（**没有**子路径写法 ✗）⇒ 一次 `replaceAll` 足够 ✓；
   *   · `protocol/lib` 自身**零外部依赖** ✓（它 package.json 的 dependencies 是空的 ✓）⇒ 拷过去就完事 ✓。
   * ★ 与 boot.js 同一个套路 ✓（源码在别处、构建时拷进 lib ✓），
   *   且**只在构建这一处实现** ✓ —— 别再搞出第二条上线路径 ✗（boot.js 当年就是两条路径不一致，
   *   手机拿到的那份没有内联副本、而验收全绿 ✗，教训见本文件下面那段 ✓）。
   */
  if (!checkOnly) {
    const protoLib = join(repo, 'packages', 'protocol', 'lib')
    const protoTarget = join(repo, 'packages', 'host', 'lib', 'protocol')
    if (!existsSync(protoLib)) throw new Error(`内联源缺失：${protoLib}`)
    rmSync(protoTarget, { recursive: true, force: true })
    mkdirSync(protoTarget, { recursive: true })
    let copied = 0
    for (const file of readdirSync(protoLib)) {
      copyFileSync(join(protoLib, file), join(protoTarget, file))
      copied += 1
    }
    let rewrote = 0
    const hostLib = join(repo, 'packages', 'host', 'lib')
    for (const file of readdirSync(hostLib)) {
      if (!file.endsWith('.js') && !file.endsWith('.d.ts')) continue
      const target = join(hostLib, file)
      const before = readFileSync(target, 'utf8')
      const after = before.replaceAll("'@dsh-mobile/protocol'", "'./protocol/index.js'")
      if (after === before) continue
      backups.push({ to: target, data: Buffer.from(before) })
      writeFileSync(target, after)
      rewrote += 1
    }
    console.log(
      `[build-lib] 已内联 protocol → packages/host/lib/protocol/（${copied} 个文件 ✓，改写 ${rewrote} 个文件的引用 ✓）`,
    )
  }

  if (!checkOnly) {
    // 加载校验：产物必须真的能 import
    for (const pkg of PACKAGES) {
      const entry = join(repo, 'packages', pkg, 'lib', 'index.js')
      if (!existsSync(entry)) continue
      await import(pathToFileURL(entry).href)
      console.log(`[build-lib] 加载校验通过：packages/${pkg}/lib/index.js`)
    }
    // boot.js 是客户端脚本（不是 tsc 产物），从 client/src 同步过来
    const bootSrc = join(repo, 'packages', 'client', 'src', 'boot.js')
    const bootTarget = join(repo, 'packages', 'host', 'lib', 'boot.js')
    if (existsSync(bootSrc) && existsSync(bootTarget)) {
      backups.push({ to: bootTarget, data: readFileSync(bootTarget) })
      // ★ 构建戳必须是**每次构建都不同**的：它唯一的用途就是回答
      //   “手机上跑的是哪一版”。写死的常量（原先的 BUILD-0918-2336）永远不变，
      //   等于把这条唯一的线索作废 ✗。
      const stamp = bootStamp()
      /**
       * ★ boot.js 的全部改写都走 `scripts/boot-payload.mjs`（**构建与安装共用一份** ✓）：
       *   构建戳 ✓ + 公式渲染器内联副本 ✓。
       *
       * 这里原本自己写了一版 ✗，而安装脚本另写一版 ✗ —— 结果手机拿到的那份
       * **没有内联副本** ✓（公式仍旧原样 TeX），而验收脚本（装的是 lib ✓）全绿 ✗✓。
       * 教训：同一份产物有两条上线路径时，变换只能有**一处**实现 ✓。
       */
      const bootCode = buildBootPayload(readFileSync(bootSrc, 'utf8'), { stamp })
      writeFileSync(bootTarget, bootCode)
      console.log(`[build-lib] 已同步 boot.js → packages/host/lib/boot.js（戳 ${stamp}）`)
    }
  }
} catch (error) {
  failed = true
  console.error('[build-lib] 失败：', error?.message ?? error)
  if (!checkOnly) {
    for (const { to, data } of backups) writeFileSync(to, data)
    console.error('[build-lib] 已回滚到构建前的 lib')
  }
} finally {
  rmSync(out, { recursive: true, force: true })
}

process.exit(failed ? 1 : 0)
