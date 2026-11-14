#!/usr/bin/env node
/**
 * **从相册图片里找二维码**那套纯计算的电脑端验收（round 186 ✓）。
 *
 * ## 它验什么、为什么必须有
 *
 * 本轮给「扫码配对」补的是第三条入口 ✓：**从相册里挑一张图**（电脑的配对页截图 ✓、
 * 拿另一台手机拍的照片 ✓）—— 起因很实在 ✓：二维码就在**同一台手机**上（截图 ✓），
 * 或者电脑在远处拍不清 ✓，这两种情况相机那条路**根本用不上** ✓。
 *
 * 但相册这条路在电脑上**一次都跑不了** ✗（没有真机 ✓、`BitmapFactory` 是 stub ✓）。
 * 它真正会出错的地方**全是整数算式** ✓（降采样的倍数 ✓ / EXIF 的八个方向 ✓ /
 * 解码阶梯的档位与顺序 ✓）—— 而且三种错在手机上的**症状完全一样**：
 * 一句"这张图片里没找到二维码"✗（用户看不出真因，我们也看不出 ✓）。
 *
 * ⇒ 把这段抽成**零 android 依赖**的
 * `native/android/java/dev/dshm/shell/ScanImage.java` ✓（与 `PreviewFit` / `PairLink` 同一个套路 ✓），
 * 由本脚本用 `javac` 编到 JVM 上、连同 `ScanImageTest.java` 一起**真跑一遍** ✓ ——
 * 这是"相册那条路算得对不对"在电脑上唯一能拿到的执行级证据 ✓。
 *
 * ★ 它**不**碰 APK ✗（那是 `check-apk.mjs` 的活 ✓）、**不**需要手机 ✗、
 * **不**需要联网 ✗、**不**改任何文件 ✓（只往临时目录写 `.class` ✓）。
 *
 * ## 与另外两个同形脚本的分工 ✓
 *
 * | 脚本 | 验什么 |
 * |---|---|
 * | `check-pair-link.mjs` | 扫到的文本 ⇒ 要加载的地址（`PairLink` ✓） |
 * | `check-preview-fit.mjs` | 帧 + 屏幕 ⇒ 画面摆在哪块矩形上（`PreviewFit` ✓） |
 * | **本脚本** | **一张相册图片 ⇒ 按几倍取样、转多少度、试哪几档（`ScanImage` ✓）** |
 *
 * 用法：`node scripts/check-scan-image.mjs`
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const sourceDir = join(repoRoot, 'native', 'android', 'java')
const testDir = join(repoRoot, 'native', 'android', 'test')
const outDir = mkdtempSync(join(tmpdir(), 'dshm-scan-image-'))

const fail = (message) => {
  console.error(`[check-scan-image] 错误：${message}`)
  process.exit(2)
}

/**
 * ★ 编译用的是**仓库里那份** `ScanImage.java` 原文 ✓ —— 不是副本、不是重写 ✓。
 *   （副本会"测试通过但壳里是另一份代码"✗ —— 那种假绿比没有测试更糟 ✗。）
 * `--release 11` 与 `scripts/build-apk.mjs` 里那条 javac 一致 ✓。
 */
const sources = [
  join(sourceDir, 'dev', 'dshm', 'shell', 'ScanImage.java'),
  join(testDir, 'dev', 'dshm', 'shell', 'ScanImageTest.java'),
]

try {
  execFileSync('javac', ['--release', '11', '-d', outDir, ...sources], { stdio: ['ignore', 'pipe', 'pipe'] })
  console.log(`[check-scan-image] ScanImage.java + ScanImageTest.java 已编译 ✓（${sources.length} 个源文件）`)
  console.log('[check-scan-image] 跑断言（下面每一条都是**真的执行**了壳里那段整数算式 ✓）：')
} catch (error) {
  fail(
    `javac 失败：\n${String(error?.stdout ?? '').slice(-2000)}\n${String(error?.stderr ?? '').slice(-2000)}`,
  )
}

let code = 0
try {
  const output = execFileSync('java', ['-cp', outDir, 'dev.dshm.shell.ScanImageTest'], {
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
