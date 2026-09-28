#!/usr/bin/env node
/**
 * **壳里"已信任的 CA"按哪台电脑各存一份**那套纯逻辑的电脑端验收（round 175 ✓）。
 *
 * ## 它守的是什么
 *
 * 真机报的缺陷：手机装了两台电脑后，**从 Windows 切回 Mac 被拒**，提示"证书与配对票据里的
 * 指纹不一致"✗。根因：壳把已信任的 CA 只存在**一个**键 `pinned-ca` 里 ✗ ⇒ 两台电脑抢同一个
 * 槽位 ⇒ 连过 Windows 之后那个 pin 变成 Windows 的 CA ⇒ 再连 Mac 就被判"不一致"✗
 * （时有时无，取决于最后连的是哪台 ✓）。
 *
 * "该读哪个键、旧值要不要认领"这件事**本机验不了** ✗（没有真机、`android.jar` 是 stub ✓），
 * 但它**只**取决于纯逻辑 ✓ ⇒ 拆成零 android 依赖的 `PinStore.java` ✓
 * （与 `PairLink` / `PreviewFit` / `MobileUrl` 同一个套路 ✓），
 * 由本脚本用 `javac` 编到 JVM 上、连同 `PinStoreTest.java` 一起**真跑一遍** ✓。
 *
 * ★ 它**不**碰 APK ✗（那是 `check-apk.mjs` 的活 ✓）、不需要手机 ✗、不改任何文件 ✓
 * （只往临时目录写 `.class` ✓）。
 *
 * 用法：`node scripts/check-pin-store.mjs`
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const sourceDir = join(repoRoot, 'native', 'android', 'java')
const testDir = join(repoRoot, 'native', 'android', 'test')
const outDir = mkdtempSync(join(tmpdir(), 'dshm-pin-store-'))

const fail = (message) => {
  console.error(`[check-pin-store] 错误：${message}`)
  process.exit(2)
}

/**
 * ★ 编译用的是**仓库里那份** `PinStore.java` 原文 ✓ —— 不是副本、不是重写 ✓。
 *   （副本会"测试通过但壳里是另一份代码"✗ —— 那种假绿比没有测试更糟 ✗。）
 * `--release 11` 与 `scripts/build-apk.mjs` 里那条 javac 一致 ✓。
 */
const sources = [
  join(sourceDir, 'dev', 'dshm', 'shell', 'PinStore.java'),
  join(testDir, 'dev', 'dshm', 'shell', 'PinStoreTest.java'),
]

try {
  execFileSync('javac', ['--release', '11', '-d', outDir, ...sources], { stdio: ['ignore', 'pipe', 'pipe'] })
  console.log(`[check-pin-store] PinStore.java + PinStoreTest.java 已编译 ✓（${sources.length} 个源文件）`)
  console.log('[check-pin-store] 跑断言（下面每一条都是**真的执行**了壳里那段数学 ✓）：')
} catch (error) {
  fail(
    `javac 失败：\n${String(error?.stdout ?? '').slice(-2000)}\n${String(error?.stderr ?? '').slice(-2000)}`,
  )
}

let code = 0
try {
  const output = execFileSync('java', ['-cp', outDir, 'dev.dshm.shell.PinStoreTest'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  })
  process.stdout.write(output)
} catch (error) {
  // 断言失败时 java 退出码是 1 ✓ —— 测试自己的输出在 stdout 上 ✓，照原样打出来 ✓
  process.stdout.write(String(error?.stdout ?? ''))
  const stderr = String(error?.stderr ?? '')
  if (stderr.trim() !== '') process.stderr.write(stderr)
  code = typeof error?.status === 'number' ? error.status : 1
} finally {
  rmSync(outDir, { recursive: true, force: true })
}

process.exit(code)
