/**
 * **壳里"用户输的地址该加载成什么"**那套纯归一化的电脑端验收（round 174 ✓）。
 *
 * ## 它验什么、为什么必须有
 *
 * 用户真机报的缺陷是"输入 `https://10.34.255.229:3443`（**裸域名**）打不开"✗ ——
 * 实测那条地址返回 **401**（`dsh web authentication required; reopen the URL printed by dsh web.` ✓）：
 * 壳的「改地址」框是**你输什么就加载什么** ✗（只补 scheme ✓、不补路径 ✗），
 * 而面板上那句提示让人填的正是裸源 ✓ ⇒ 必然落到 DSH 的**电脑版**根路径 ✓。
 *
 * "拼出来的地址对不对"这件事**本机验不了** ✗（没有真机 ✗，`android.jar` 的类是 stub ✓），
 * 但归一化**只**取决于一个纯函数 ✓：`MobileUrl.normalize()` ✓ ——
 * 所以把它拆成一个**零 android 依赖**的类 ✓（**与 `PairLink` / `PreviewFit` 同一个套路** ✓），
 * 由本脚本用 `javac` 编到 JVM 上、连同 `MobileUrlTest.java` 一起**真跑一遍** ✓ ——
 * 这是"地址补路径"这件事在电脑上唯一能拿到的执行级证据 ✓。
 *
 * ★ 它**不**碰 APK ✗（那是 `check-apk.mjs` 的活 ✓）、**不**需要手机 ✗、**不**需要联网 ✗、
 * **不**改任何文件 ✓（只往临时目录写 `.class` ✓）。
 *
 * ## 与 `scripts/check-pair-link.mjs` / `check-preview-fit.mjs` 的分工 ✓
 *
 * 三个脚本形状完全一样 ✓（都是"编壳里那份**原样的**纯 java 源文件 + 跑断言"✓）：
 * 那个管"扫到的文本 → 要加载的地址"✓；`check-preview-fit` 管"帧 + 屏幕 → 画面摆在哪块矩形上"✓；
 * 本脚本管"**用户输的地址 → 真正要加载的那条**"✓（空路径或单个 `/` ⇒ 补 `/mobile/app` ✓，
 * 明确给了路径就**原样尊重** ✗，`dshmobile:` 深链**一个字不动** ✓）。
 *
 * 用法：`node scripts/check-mobile-url.mjs`
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const sourceDir = join(repoRoot, 'native', 'android', 'java')
const testDir = join(repoRoot, 'native', 'android', 'test')
const outDir = mkdtempSync(join(tmpdir(), 'dshm-mobile-url-'))

const fail = (message) => {
  console.error(`[check-mobile-url] 错误：${message}`)
  process.exit(2)
}

/**
 * ★ 编译用的是**仓库里那份** `MobileUrl.java` 原文 ✓ —— 不是副本、不是重写 ✓。
 *   （副本会"测试通过但壳里是另一份代码"✗ —— 那种假绿比没有测试更糟 ✗。）
 * `--release 11` 与 `scripts/build-apk.mjs` 里那条 javac 一致 ✓。
 */
const sources = [
  join(sourceDir, 'dev', 'dshm', 'shell', 'MobileUrl.java'),
  /**
   * ★ `PairLink.java` 也要带上 ✓ —— 测试里有两条断言是**跨这两份源码**的：
   *   `MobileUrl.APP_PATH == PairLink.APP_PATH` ✓、以及"`dshmobile:` 深链仍归 `PairLink` 管"✓。
   *   不编它就会得到"找不到符号 PairLink"✗（本脚本第一版就是这么挂的 ✓）——
   *   那种红看起来像"壳里的代码坏了"✓，其实只是脚本少给了一个源文件 ✗。
   */
  join(sourceDir, 'dev', 'dshm', 'shell', 'PairLink.java'),
  join(testDir, 'dev', 'dshm', 'shell', 'MobileUrlTest.java'),
]

try {
  execFileSync('javac', ['--release', '11', '-d', outDir, ...sources], { stdio: ['ignore', 'pipe', 'pipe'] })
  console.log(`[check-mobile-url] MobileUrl.java + MobileUrlTest.java 已编译 ✓（${sources.length} 个源文件）`)
  console.log('[check-mobile-url] 跑断言（下面每一条都是**真的执行**了壳里那段数学 ✓）：')
} catch (error) {
  fail(
    `javac 失败：\n${String(error?.stdout ?? '').slice(-2000)}\n${String(error?.stderr ?? '').slice(-2000)}`,
  )
}

let code = 0
try {
  const output = execFileSync('java', ['-cp', outDir, 'dev.dshm.shell.MobileUrlTest'], {
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
