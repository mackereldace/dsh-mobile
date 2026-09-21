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
    const files = readdirSync(built).filter((f) => f.endsWith('.js') || f.endsWith('.d.ts') || f.endsWith('.map'))
    if (files.length === 0) throw new Error(`构建产物为空：${built}`)
    if (checkOnly) {
      console.log(`[build-lib] ${pkg}: 可生成 ${files.length} 个文件（--check 不写盘）`)
      continue
    }
    for (const file of files) {
      const to = join(target, file)
      if (existsSync(to)) backups.push({ to, data: readFileSync(to) })
      copyFileSync(join(built, file), to)
    }
    console.log(`[build-lib] ${pkg}: 已写入 ${files.length} 个文件 → packages/${pkg}/lib/`)
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
