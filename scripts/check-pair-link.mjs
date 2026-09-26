#!/usr/bin/env node
/**
 * **扫码配对**那套纯解析的电脑端验收（round 143 ✓）。
 *
 * ## 它验什么、为什么必须有
 *
 * 本轮加的两条路（B：`dshmobile://pair` 深链 ✓；A：壳内扫码 ✓）最后都落到**同一件事**上：
 * 把扫到的那串文本变成 `<电脑基地址>/mobile/app?pair=<票据>` ✓，再交给**已有的加载路径** ✓。
 * 而这两条路在**本机都验不了** ✗：没有相机 ✗、没有真机 ✗，
 * 壳里的 Java 也没法在电脑上跑（`android.jar` 的类是 stub ✓）。
 *
 * 于是把"**最容易写错、又最难在真机上看出错**"的那一段（解析 + 拼址 ✓）
 * 拆成一个**零 android 依赖**的类 `native/android/java/dev/dshm/shell/PairLink.java` ✓，
 * 由本脚本用 `javac` 编到 JVM 上、连同 `PairLinkTest.java` 一起**真跑一遍** ✓ ——
 * 这是"扫码"这件事在电脑上唯一能拿到的执行级证据 ✓。
 *
 * ★ 它**不**碰 APK ✗（那是 `check-apk.mjs` 的活 ✓）、**不**需要手机 ✗、
 * **不**需要联网 ✗、**不**改任何文件 ✓（只往临时目录写 `.class` ✓）。
 *
 * 用法：`node scripts/check-pair-link.mjs`
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const sourceDir = join(repoRoot, 'native', 'android', 'java')
const testDir = join(repoRoot, 'native', 'android', 'test')
const outDir = mkdtempSync(join(tmpdir(), 'dshm-pair-link-'))

const fail = (message) => {
  console.error(`[check-pair-link] 错误：${message}`)
  process.exit(2)
}

/**
 * ★ 编译用的是**仓库里那份** `PairLink.java` 原文 ✓ —— 不是副本、不是重写 ✓。
 *   （副本会"测试通过但壳里是另一份代码"✗ —— 那种假绿比没有测试更糟 ✗。）
 * `--release 11` 与 `scripts/build-apk.mjs` 里那条 javac 一致 ✓。
 */
const sources = [
  join(sourceDir, 'dev', 'dshm', 'shell', 'PairLink.java'),
  join(testDir, 'dev', 'dshm', 'shell', 'PairLinkTest.java'),
]

try {
  execFileSync('javac', ['--release', '11', '-d', outDir, ...sources], { stdio: ['ignore', 'pipe', 'pipe'] })
  console.log(`[check-pair-link] PairLink.java + PairLinkTest.java 已编译 ✓（${sources.length} 个源文件）`)
  console.log('[check-pair-link] 跑断言（下面每一条都是**真的执行**了壳里那段代码 ✓）：')
} catch (error) {
  fail(
    `javac 失败：\n${String(error?.stdout ?? '').slice(-2000)}\n${String(error?.stderr ?? '').slice(-2000)}`,
  )
}

let code = 0
try {
  const output = execFileSync('java', ['-cp', outDir, 'dev.dshm.shell.PairLinkTest'], {
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
