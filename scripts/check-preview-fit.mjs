#!/usr/bin/env node
/**
 * **壳内扫码画面比例**那套纯数学的电脑端验收（round 153 ✓）。
 *
 * ## 它验什么、为什么必须有
 *
 * 用户真机报的缺陷是"调用的相机是**纵向拉伸**的"✗（原话 ✓）—— 功能全通 ✓
 * （能扫到、能配对 ✓），纯粹是画面比例错 ✓：相机给的是**横向帧**（1280×720 ✓），
 * `setDisplayOrientation()` 把它转 90° 后是 720×1280（0.5625 ✓），
 * 而 `SurfaceView` 此前铺满竖屏（1080×2400 ⇒ 0.45 ✓）⇒ **画面被硬铺在更窄的视图上** ✓
 * ⇒ 纵向拉伸 ≈ 1.25 倍 ✗。
 *
 * "画面有没有被拉长"这件事**本机验不了** ✗（没有相机 ✗、没有真机 ✗，
 * 壳里的 Java 也跑不起来 —— `android.jar` 的类是 stub ✓）。
 * 但变形**只**取决于一个纯数学量 ✓：**视图矩形的宽高比 == 帧旋转后的宽高比** ✓ ——
 * 于是把这段数学拆成一个**零 android 依赖**的类
 * `native/android/java/dev/dshm/shell/PreviewFit.java` ✓（**与 `PairLink` 同一个套路** ✓），
 * 由本脚本用 `javac` 编到 JVM 上、连同 `PreviewFitTest.java` 一起**真跑一遍** ✓ ——
 * 这是"画面不变形"这件事在电脑上唯一能拿到的执行级证据 ✓。
 *
 * ★ 它**不**碰 APK ✗（那是 `check-apk.mjs` 的活 ✓）、**不**需要手机 ✗、**不**需要联网 ✗、
 * **不**改任何文件 ✓（只往临时目录写 `.class` ✓）。
 *
 * ## 与 `scripts/check-pair-link.mjs` 的分工 ✓
 *
 * 两个脚本形状完全一样 ✓（都是"编壳里那份**原样的**纯 java 源文件 + 跑断言"✓）：
 * 那个管"扫到的文本 → 要加载的地址"✓；本脚本管"帧 + 屏幕 → 画面摆在哪块矩形上"✓。
 *
 * 用法：`node scripts/check-preview-fit.mjs`
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const sourceDir = join(repoRoot, 'native', 'android', 'java')
const testDir = join(repoRoot, 'native', 'android', 'test')
const outDir = mkdtempSync(join(tmpdir(), 'dshm-preview-fit-'))

const fail = (message) => {
  console.error(`[check-preview-fit] 错误：${message}`)
  process.exit(2)
}

/**
 * ★ 编译用的是**仓库里那份** `PreviewFit.java` 原文 ✓ —— 不是副本、不是重写 ✓。
 *   （副本会"测试通过但壳里是另一份代码"✗ —— 那种假绿比没有测试更糟 ✗。）
 * `--release 11` 与 `scripts/build-apk.mjs` 里那条 javac 一致 ✓。
 */
const sources = [
  join(sourceDir, 'dev', 'dshm', 'shell', 'PreviewFit.java'),
  join(testDir, 'dev', 'dshm', 'shell', 'PreviewFitTest.java'),
]

try {
  execFileSync('javac', ['--release', '11', '-d', outDir, ...sources], { stdio: ['ignore', 'pipe', 'pipe'] })
  console.log(`[check-preview-fit] PreviewFit.java + PreviewFitTest.java 已编译 ✓（${sources.length} 个源文件）`)
  console.log('[check-preview-fit] 跑断言（下面每一条都是**真的执行**了壳里那段数学 ✓）：')
} catch (error) {
  fail(
    `javac 失败：\n${String(error?.stdout ?? '').slice(-2000)}\n${String(error?.stderr ?? '').slice(-2000)}`,
  )
}

let code = 0
try {
  const output = execFileSync('java', ['-cp', outDir, 'dev.dshm.shell.PreviewFitTest'], {
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
