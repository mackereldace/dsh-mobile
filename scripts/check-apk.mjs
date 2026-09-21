#!/usr/bin/env node
/**
 * 原生外壳 APK 的**验收检查** ✓（可重复、可回归 ✓，不依赖手机 ✓）。
 *
 * ## 为什么要有它
 *
 * 这个 APK 是"发给用户装的东西"✓ —— 而本项目吃过太多次
 * "看起来生成了、其实里面不对"的亏 ✗（装出去的产物缺文件、占位符没替换 ✓）。
 * 手机上的失败最难查 ✓，所以**能在电脑上断言的就全部断言掉** ✓。
 *
 * 检查五件事 ✓：
 *   1. **能装**：包名、版本、`targetSdk`、launcher activity、**权限白名单**
 *      （`INTERNET` + `POST_NOTIFICATIONS` ✓）；
 *   2. **该有的东西在**：`classes.dex` ✓、两张图标 ✓、`assets/dshm_ca.pem` ✓；
 *   2b. **壳的代码真的在里面** ✓：三个尺寸变量 / insets 事件 / 显式 edge-to-edge /
 *      通知桥 —— 这几件事在手机上失败了没有任何画面差异 ✗，只能靠 dex 里的符号判 ✓；
 *   3. **CA 真的是这台电脑那张** ✓（指纹逐字节比对 ✓）——
 *      这是"证书固定"能成立的前提 ✓；
 *   4. **链能验通** ✓：用 APK 里那张 CA 验证**电脑当前**发的那张服务器证书 ✓
 *      （`openssl verify` ✓）—— 等价于壳里 `pinCa()` 做的事 ✓。
 *
 * 用法：`node scripts/check-apk.mjs [--apk dist/dsh-mobile.apk]`
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const flag = (name, fallback) => {
  const index = process.argv.indexOf(name)
  return index >= 0 && process.argv[index + 1] !== undefined ? process.argv[index + 1] : fallback
}
const apkPath = flag('--apk', join(repoRoot, 'dist', 'dsh-mobile.apk'))
const sdkRoot = process.env.ANDROID_HOME ?? join(homedir(), 'Library', 'Android', 'sdk')
const buildTools = process.env.DSHM_BUILD_TOOLS ?? '35.0.0'
const aapt2 = join(sdkRoot, 'build-tools', buildTools, 'aapt2')
const tlsDir = join(homedir(), '.dsh', 'storages', 'dsh-mobile', 'tls')

let failed = 0
const check = (ok, label, detail) => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail === undefined ? '' : `（${detail}）`}`)
  if (!ok) failed += 1
}

if (!existsSync(apkPath)) {
  console.error(`[check-apk] 找不到 APK：${apkPath}\n        先构建：node scripts/build-apk.mjs`)
  process.exit(2)
}

const workDir = mkdtempSync(join(tmpdir(), 'dshm-apk-'))
const unzip = (member) => execFileSync('unzip', ['-p', apkPath, member], { maxBuffer: 64 * 1024 * 1024 })

// ── ① 包信息（用 aapt2 读二进制清单 ✓ —— 这是"能不能装"的判据 ✓）
if (existsSync(aapt2)) {
  const badging = execFileSync(aapt2, ['dump', 'badging', apkPath], { encoding: 'utf8' })
  const packageLine = /package: name='([^']+)' versionCode='(\d+)' versionName='([^']+)'/.exec(badging)
  check(packageLine !== null && packageLine[1] === 'dev.dshm.shell', '包名正确（dev.dshm.shell ✓）', packageLine?.[1])
  check(/launchable-activity: name='dev\.dshm\.shell\.MainActivity'/.test(badging), '有可启动的入口 Activity ✓', 'dev.dshm.shell.MainActivity')
  const permissions = [...badging.matchAll(/uses-permission: name='([^']+)'/g)].map((m) => m[1])
  /**
   * ★ 权限白名单（round 115 起是**两个** ✓）。
   *
   * 原先写的是"**只**有 INTERNET"✗ —— 那是刻意的：壳是个薄壳，多一个权限就多一份风险 ✓。
   * 本轮加了 `POST_NOTIFICATIONS` ✓，起因是用户报"通知权限没获取"✗：
   * 网页那半用 Web Notification API，而 **Android WebView 不实现它** ✗ ——
   * 所以 APK 里通知只能走原生，而安卓 13 起发通知要运行时授权 ✓。
   * 断言方式因此改成**白名单逐项列出** ✓（而不是 `length === 1`）：
   * 以后再加权限会在这里红一次 ✓ —— 那正是我们想要的"必须有人为它负责" ✓。
   */
  const allowedPermissions = ['android.permission.INTERNET', 'android.permission.POST_NOTIFICATIONS']
  const unexpected = permissions.filter((name) => !allowedPermissions.includes(name))
  check(
    unexpected.length === 0 && permissions.includes('android.permission.INTERNET'),
    '权限只有 INTERNET + POST_NOTIFICATIONS（没有存储/相机/定位等 ✗）',
    permissions.join('、') || '(无)',
  )
  check(
    permissions.includes('android.permission.POST_NOTIFICATIONS'),
    '带 POST_NOTIFICATIONS（否则安卓 13+ 上"允许通知"点下去不会有系统弹窗 ✗）',
    `permissions=${permissions.length}`,
  )
  check(/targetSdkVersion:'(\d+)'/.test(badging), '有 targetSdkVersion ✓', /targetSdkVersion:'(\d+)'/.exec(badging)?.[1])
} else {
  console.log(`  · （跳过包信息检查：找不到 aapt2 —— ${aapt2} ✓）`)
}

// ── ② 该有的东西在不在
const listing = execFileSync('unzip', ['-l', apkPath], { encoding: 'utf8' })
check(/\bclasses\.dex\b/.test(listing), '打包了 classes.dex ✓')
check(/res\/mipmap-xxhdpi-v4\/ic_launcher\.png/.test(listing), '带 192 图标 ✓')
check(/res\/mipmap-xxxhdpi-v4\/ic_launcher\.png/.test(listing), '带 512 图标 ✓')
check(/assets\/dshm_ca\.pem/.test(listing), '带本机 CA（证书固定用 ✓）')

/**
 * ── ②b 壳的**代码本身**有没有真的打进去 ─────────────────────────────
 *
 * 为什么查 dex 里的字符串：本项目反复吃过"源码改了、装出去的还是旧的"✗
 * （见 `05` §73 与交接文档 §五.1）✓。而这几件事**全都没有界面**✓ ——
 * 在手机上失败了既没有报错、也没有画面差异✗，只能靠"产物里到底有没有这段代码"来判 ✓。
 * 读 `classes.dex` 的字符串表即可 ✓（`unzip -p` 出来的字节按 latin1 读，ASCII 子串不会变形 ✓）。
 */
{
  const dexBytes = unzip('classes.dex')
  const dexText = dexBytes.toString('latin1')
  const hasAll = (needles) => needles.every((needle) => dexText.includes(needle))
  const missing = (needles) => needles.filter((needle) => !dexText.includes(needle))

  const safeVars = ['dshm-safe-top', 'dshm-safe-bottom', 'dshm-keyboard']
  check(
    hasAll(safeVars),
    '三个尺寸变量都在 dex 里（状态栏 / 导航栏 / 输入法 ✓ —— 网页靠它们让位 ✓）',
    missing(safeVars).length === 0 ? safeVars.join('、') : `缺 ${missing(safeVars).join('、')}`,
  )
  const insetsPlumbing = ['dshm-shell-insets', 'setDecorFitsSystemWindows', 'data-dshm-shell']
  check(
    hasAll(insetsPlumbing),
    'insets 变化会主动通知网页 + 显式 edge-to-edge + 打"这是 APK"的标记 ✓',
    missing(insetsPlumbing).length === 0 ? insetsPlumbing.join('、') : `缺 ${missing(insetsPlumbing).join('、')}`,
  )
  const notifyBridge = ['requestNotificationPermission', 'notificationPermission', 'notify']
  check(
    hasAll(notifyBridge),
    '通知桥在 dex 里（权限查询 + 运行时申请 + 发通知 ✓ —— WebView 里没有 Web Notification ✗）',
    missing(notifyBridge).length === 0 ? notifyBridge.join('、') : `缺 ${missing(notifyBridge).join('、')}`,
  )
}

// ── ③ APK 里那张 CA 是不是这台电脑那张（指纹逐字节比对 ✓）
const apkCaPath = join(workDir, 'apk-ca.pem')
const liveCaPath = join(tlsDir, 'lan-ca.pem')
if (/assets\/dshm_ca\.pem/.test(listing) && existsFile(liveCaPath)) {
  writeFileSync(apkCaPath, unzip('assets/dshm_ca.pem'))
  const fingerprint = (path) =>
    execFileSync('openssl', ['x509', '-in', path, '-noout', '-fingerprint', '-sha256'], { encoding: 'utf8' }).trim()
  const apkFp = fingerprint(apkCaPath)
  const liveFp = fingerprint(liveCaPath)
  check(apkFp === liveFp, 'APK 里的 CA 与电脑上那张**完全一致**（否则固定必然失败 ✗）', apkFp.split('=')[1]?.slice(0, 32))
} else {
  check(false, 'APK 里带本机 CA 且电脑上有 CA 可比对', `apk=${/assets\/dshm_ca\.pem/.test(listing)} live=${existsFile(liveCaPath)}`)
}

// ── ④ 用 APK 里那张 CA 去验**电脑当前**发的那张服务器证书（= 壳里 pinCa() 做的事 ✓）
const liveLeafPath = join(tlsDir, 'lan-cert.pem')
if (existsFile(apkCaPath) && existsFile(liveLeafPath)) {
  let verified = false
  let note = ''
  try {
    const output = execFileSync('openssl', ['verify', '-CAfile', apkCaPath, liveLeafPath], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    verified = /: OK/.test(output)
    note = output.trim().split('\n').pop() ?? ''
  } catch (error) {
    note = String(error?.stdout ?? error?.message ?? error).trim().split('\n').pop() ?? ''
  }
  check(verified, '用 APK 里的 CA 能验通电脑当前发的服务器证书（= 证书固定会成功 ✓）', note)
} else {
  console.log('  · （跳过链校验：电脑上还没有 CA/服务器证书 ✓ —— 先跑 node scripts/make-cert.mjs）')
}

rmSync(workDir, { recursive: true, force: true })

console.log(
  failed === 0
    ? '\n[check-apk] 通过：APK 可以装、内容齐全、证书固定链验得通 ✓'
    : `\n[check-apk] 未通过 ${failed} 项 ✗`,
)
process.exit(failed === 0 ? 0 : 1)

function existsFile(path) {
  return existsSync(path)
}
