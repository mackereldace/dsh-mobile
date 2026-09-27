#!/usr/bin/env node
/**
 * 构建安卓薄壳 APK —— **全脚本化，不用 Gradle** ✓。
 *
 * ## 为什么不用 Gradle
 *
 * Gradle + AGP 会带来一长串与 JDK 版本的耦合 ✗（这台机器上装的是 **JDK 26**，
 * 而 AGP 目前通常只认 17/21 ✓），还要多下 ~200 MB 的 Gradle 发行包 ✗。
 * 而我们这个壳**几乎没有第三方依赖** ✓（round 143 之前是**零** ✓，仅用框架自带的
 * `android.webkit.WebView` ✓；现在多了一个**纯 Java 的** ZXing core ✓ ——
 * 见下面 §第三方 jar ✓，它同样不需要 Gradle ✓），
 * 于是 build-tools 里那几件工具就够 ✓：
 *
 * ```
 * aapt2 compile/link  →  资源 + 清单 → base.apk（含 R.java）
 * javac               →  Java 源码 → .class
 * d8                  →  .class → classes.dex
 * zip                 →  把 classes.dex 放进 APK 根
 * zipalign + apksigner→  对齐 + 签名 → 可安装的 APK
 * ```
 *
 * 好处很实在 ✓：**没有版本地狱** ✓、构建只用一条命令 ✓、产物可复现 ✓。
 *
 * ## 唯一一个"从电脑上取"的东西：图标
 *
 * 1. **图标** ✓：直接复用插件里那份生成逻辑（`packages/host/lib/app-icons.js` ✓），
 *    不重新画、也不会两边不一致 ✗。
 *
 * ## ★★ 本包**不固定任何 CA**（C2 起 ✓ —— 一个包能连任何一台电脑 ✓）
 *
 * 以前这里还有第 2 件：把 `~/.dsh/storages/dsh-mobile/tls/lan-ca.pem` 打进
 * `assets/dshm_ca.pem` ✓（壳拿它做证书固定 ✓）。代价是**一机一包** ✗：
 * 换一台电脑就得重新构建、重新分发 ✗，而"哪个包配哪台机"没人记得住 ✓。
 *
 * 现在改成 **TOFU**（首次连接时确认宿主的 CA ✓，见
 * `native/android/java/dev/dshm/shell/MainActivity.java` 的 `tofuTrustOnce` ✓）：
 *   · 壳第一次连某台电脑时，去 `/mobile/trust.crt` 取回它的 CA ✓；
 *   · 与**带外**配对票据里的 `caFingerprint` 比对（二维码是扫的，中间人改不了 ✓）；
 *   · 票据里没有（旧宿主 ✓）⇒ **把指纹显示给用户、要用户明确确认** ✓ ——
 *     这一步**不能省** ✗：省掉就把"编译期固定"换成"盲信第一次" ✓（安全倒退 ✓）；
 *   · 确认后落盘到 `SharedPreferences`（键 `pinned-ca` ✓），以后先用它、读不到再退回 assets ✓。
 *
 * ⇒ `dist/dsh-mobile.apk` 从此**可以随仓库/发布走** ✓（不再与某台电脑绑定 ✓），
 *   而 `assets/dshm_ca.pem` 这个文件**不该再存在** ✓（下面第 ② 步专门把它清掉 ✓ ——
 *   老工作区里那份残留会被 aapt2 原样打进包 ✓，那就白改了 ✓）。
 *
 * ## 第三方 jar（round 143 起**有一个** ✗ —— 扫码解码用的 ZXing ✓）
 *
 * `native/android/libs/zxing-core-3.5.3.jar` ✓（Apache-2.0 ✓，纯 Java ✓，
 * 来源/版本/sha256 见 `native/android/libs/README.md` ✓）。
 * 它同时进两处 ✓：`javac -cp` ✓（编译期）与 `d8` 的输入 ✓（打包进 dex ✓）。
 *
 * ★ 两条硬规矩 ✗：
 *   1. **构建时绝不联网** ✓ —— jar 是 vendor 进仓库的 ✓，脚本只读本地文件 ✓；
 *   2. **sha256 对不上就构建失败** ✓（见 {@link ZXING_CORE_SHA256} ✓）——
 *      "仓库里的 jar 被人换掉/改坏"这一类事故必须**在构建这一步**就红 ✗
 *      （它一旦混进 APK，真机上是 `NoClassDefFoundError` 或者更糟 ✗，而本机验不了 ✗）。
 *
 * 用法：`node scripts/build-apk.mjs [--out dist/dsh-mobile.apk]`
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const androidDir = join(repoRoot, 'native', 'android')
const buildDir = join(androidDir, 'build')
const sdkRoot = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT ?? join(homedir(), 'Library', 'Android', 'sdk')
const platform = process.env.DSHM_ANDROID_PLATFORM ?? 'android-35'
const buildTools = process.env.DSHM_BUILD_TOOLS ?? '35.0.0'
const androidJar = join(sdkRoot, 'platforms', platform, 'android.jar')
const toolsDir = join(sdkRoot, 'build-tools', buildTools)

/**
 * ★★ 扫码解码库（round 143 ✓）—— 见 `native/android/libs/README.md` ✓。
 * 版本与 sha256 **都钉死在这里** ✓：换版本要三处一起改 ✓（文件名 / 这两个常量 / README ✓）。
 */
const zxingJar = join(androidDir, 'libs', 'zxing-core-3.5.3.jar')
const ZXING_CORE_VERSION = '3.5.3'
const ZXING_CORE_SHA256 = '8d8064c1636fdaef7189dd9055c7d59950a8940a12f2293956446ec3c109fd82'

const outPath = (() => {
  const index = process.argv.indexOf('--out')
  return index >= 0 && process.argv[index + 1] !== undefined
    ? process.argv[index + 1]
    : join(repoRoot, 'dist', 'dsh-mobile.apk')
})()

/** 本次构建戳 ✓（版本名与日志共用同一个 ✓）。 */
const stamp = 'BUILD-' + new Date().toISOString().replace(/[-:T]/g, '').slice(4, 14)

const log = (message) => console.log(`[build-apk] ${message}`)
const fail = (message) => {
  console.error(`[build-apk] 错误：${message}`)
  process.exit(1)
}
const run = (command, args, options = {}) => {
  try {
    return execFileSync(command, args, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', ...options })
  } catch (error) {
    const stderr = error?.stderr ?? ''
    const stdout = error?.stdout ?? ''
    fail(`${command} 失败：\n${String(stdout).slice(-1500)}\n${String(stderr).slice(-1500)}`)
  }
}

// ── 前置检查（缺什么就直接说清楚，别让人对着莫名其妙的中途错误猜 ✓）
for (const [label, path] of [
  ['Android SDK', sdkRoot],
  ['android.jar', androidJar],
  ['build-tools', toolsDir],
]) {
  if (!existsSync(path)) {
    fail(
      `缺少 ${label}：${path}\n` +
        '        装法：sdkmanager "platform-tools" "platforms;' +
        platform +
        '" "build-tools;' +
        buildTools +
        '"',
    )
  }
}

/**
 * ★ 扫码解码库必须在、而且**必须是我们 vendor 的那一份** ✓（见文件头 §第三方 jar ✓）。
 * 这一段刻意放在"下载/解压"之前 ✓：宁可构建刚开始就红 ✗，
 * 也不要等 d8 跑到一半报一个"找不到类"✗ —— 那个报错完全指不到"jar 被换了"这个真因 ✓。
 */
if (!existsSync(zxingJar)) {
  fail(
    `找不到扫码解码库：${zxingJar}\n` +
      `        它是 vendor 进仓库的（ZXing core ${ZXING_CORE_VERSION}，Apache-2.0 ✓）——\n` +
      '        补回来的办法见 native/android/libs/README.md ✓（构建**不会**联网去拉 ✗）',
  )
}
{
  const actual = createHash('sha256').update(readFileSync(zxingJar)).digest('hex')
  if (actual !== ZXING_CORE_SHA256) {
    fail(
      `扫码解码库的 sha256 对不上 ✗：\n` +
        `        期望 ${ZXING_CORE_SHA256}\n` +
        `        实际 ${actual}\n` +
        '        说明这个 jar 被换过/改坏了 ✗ —— 见 native/android/libs/README.md ✓',
    )
  }
  log(`扫码解码库已校验 ✓（ZXing core ${ZXING_CORE_VERSION}，sha256 ${actual.slice(0, 16)}… ✓）`)
}


rmSync(buildDir, { recursive: true, force: true })
mkdirSync(join(buildDir, 'gen'), { recursive: true })
mkdirSync(join(buildDir, 'classes'), { recursive: true })
mkdirSync(join(androidDir, 'assets'), { recursive: true })
mkdirSync(dirname(outPath), { recursive: true })

// ── ① 图标：复用插件里那份生成逻辑 ✓（168/512 两个密度够用 ✓）
{
  // ★ 必须用 pathToFileURL ✓ —— 本仓库路径里有**中文与空格** ✗，手拼 file:// 会直接崩 ✓
  const { iconPng } = await import(pathToFileURL(join(repoRoot, 'packages', 'host', 'lib', 'app-icons.js')).href)
  const mipmaps = [
    ['mipmap-xxhdpi', 192],
    ['mipmap-xxxhdpi', 512],
  ]
  for (const [dir, size] of mipmaps) {
    const target = join(androidDir, 'res', dir)
    mkdirSync(target, { recursive: true })
    writeFileSync(join(target, 'ic_launcher.png'), iconPng(size, { maskable: false }))
  }
  log(`图标已生成（192 / 512 ✓）`)
}

// ── ② ★★ C2：**不再**把本机 CA 打进 assets ✓ —— 本包不固定任何 CA（配对时 TOFU ✓）
{
  /**
   * ⚠️ 这一步**不是**"顺手删个文件"，而是本次改动的一部分 ✗：
   *   aapt2 的 `-A assets` 会把 `native/android/assets/` **整目录**打进包 ✓ ——
   *   老工作区里那份 `dshm_ca.pem`（C2 之前由本脚本写进去的 ✓，而且它是**入库**的 ✓）
   *   如果留着，新包照样"一机一包" ✓，而**日志上完全看不出来** ✗
   *   （`check-apk.mjs` 里那条"assets 里不该有 CA"的断言就是防这个 ✓）。
   *   所以：先删 ✓，再明说"本包不固定任何 CA" ✓。
   */
  const caAssetPath = join(androidDir, 'assets', 'dshm_ca.pem')
  if (existsSync(caAssetPath)) {
    rmSync(caAssetPath, { force: true })
    log('已删除老的 assets/dshm_ca.pem（包子里的那份固定 CA ✗ —— 它正是"一机一包"的来源 ✓）')
  }
  log('本包**不**固定任何 CA（配对时 TOFU）✓ —— 一个包能连任何一台电脑 ✓')
}

// ── ③ 资源与清单 → base.apk（同时产出 R.java ✓）
run(join(toolsDir, 'aapt2'), ['compile', '--dir', join(androidDir, 'res'), '-o', join(buildDir, 'res.zip')])
run(join(toolsDir, 'aapt2'), [
  'link',
  '-o', join(buildDir, 'base.apk'),
  '-I', androidJar,
  '--manifest', join(androidDir, 'AndroidManifest.xml'),
  '-R', join(buildDir, 'res.zip'),
  '-A', join(androidDir, 'assets'),
  '--java', join(buildDir, 'gen'),
  '--min-sdk-version', '29',
  '--target-sdk-version', '35',
  '--version-code', String(Math.floor(Date.now() / 1000) % 2000000000),
  /**
   * ★ 版本名里带**构建时间戳** ✓ —— 起因：用户下载后说"仍是之前的 APK" ✗，
   *   而实测三份字节完全一致 ✓（那一轮只改了网页 ✓，壳本来就没变 ✓）。
   *   问题在于**用户无法分辨装的是哪一版** ✗ —— 于是给包一个可读的版本号 ✓：
   *   安卓的"应用信息"里能直接看到 ✓，App 内也会显示（见 MainActivity.shellVersion ✓）。
   */
  '--version-name', `0.1.0+${stamp}`, 
  '--auto-add-overlay',
])
log('资源与清单已链接 ✓')

// ── ④ 编译 Java（框架 + 那一个 vendor 进来的 jar ✓ —— 见文件头 §第三方 jar ✓）
const sources = run('find', [join(androidDir, 'java'), join(buildDir, 'gen'), '-name', '*.java'])
  .split('\n')
  .filter((line) => line.trim() !== '')
/**
 * ★ 类路径分隔符在 macOS/Linux 上是 `:` ✓（本脚本只在这两种系统上跑 ✓）。
 * 把 jar 加进 `-cp` 是为了 `ScanActivity` 能 `import com.google.zxing.*` ✓；
 * 真正把它**打进 dex** 的是下面第 ⑤ 步 ✓（两件事，别混 ✓）。
 */
const classPath = [androidJar, zxingJar].join(':')
run('javac', ['--release', '11', '-cp', classPath, '-d', join(buildDir, 'classes'), ...sources])
log(`Java 已编译（${sources.length} 个源文件 ✓，含壳里的扫码界面 ✓）`)

// ── ⑤ dex（★ d8 要求输出目录**先存在** ✗ —— 不建就会报 'Output must be ... an existing directory' ✓）
mkdirSync(join(buildDir, 'dex'), { recursive: true })
/**
 * ★ 输入有两部分 ✓：壳体自己的 `.class` ✓ + **整个 ZXing jar** ✓。
 *
 * 为什么是**整包**、而不是只挑 `qrcode` + `common` 那几十个类 ✗：
 * 挑着 dex 一旦漏掉一个**间接引用**，真机扫码时就是 `NoClassDefFoundError` ✗ ——
 * 而"真机扫码"这件事**本机验不了** ✗（没有相机、没有真机 ✓）。
 * 代价是 classes.dex 大 **+458 KB** ✓（58 KB 的 APK → ~520 KB ✓）——
 * 对一个"局域网下载、装一次"的壳，这个代价换"不会缺类"是划算的 ✓。
 * 理由与实测数字写在 `native/android/libs/README.md` ✓。
 */
run(join(toolsDir, 'd8'), [
  '--release',
  '--min-api', '29',
  '--lib', androidJar,
  '--output', join(buildDir, 'dex'),
  ...run('find', [join(buildDir, 'classes'), '-name', '*.class'])
    .split('\n')
    .filter((line) => line.trim() !== ''),
  zxingJar,
])
run('zip', ['-q', join(buildDir, 'base.apk'), 'classes.dex'], { cwd: join(buildDir, 'dex') })
log('classes.dex 已放入 APK ✓')

// ── ⑥ 对齐 + 签名（debug 自签，够自己装 ✓）
run(join(toolsDir, 'zipalign'), ['-f', '4', join(buildDir, 'base.apk'), join(buildDir, 'aligned.apk')])
const keystore = join(repoRoot, 'dist', 'dshm-debug.keystore')
if (!existsSync(keystore)) {
  run('keytool', [
    '-genkeypair', '-keystore', keystore, '-storepass', 'android', '-keypass', 'android',
    '-alias', 'androiddebugkey', '-keyalg', 'RSA', '-keysize', '2048', '-validity', '10000',
    '-dname', 'CN=DSH Mobile Debug, OU=dshm, O=dshm',
  ])
  log('已生成 debug 签名密钥（dist/dshm-debug.keystore ✓）')
}
run(join(toolsDir, 'apksigner'), [
  'sign', '--ks', keystore, '--ks-pass', 'pass:android', '--key-pass', 'pass:android',
  '--out', outPath, join(buildDir, 'aligned.apk'),
])
/**
 * ★ 同时复制一份到 `packages/host/lib/` ✓ —— 宿主路由 `/mobile/app.apk`
 *   读的是**它自己模块旁边**那份 ✓（与 boot.js 同一个套路 ✓），
 *   而安装脚本、临时实例、验收脚本也都从那里取 ✓。
 *   只写 `dist/` 会让"本地产物、实例里 404" ✗（本轮差点又踩一次 ✓）。
 */
{
  const libTarget = join(repoRoot, 'packages', 'host', 'lib', 'dsh-mobile.apk')
  mkdirSync(dirname(libTarget), { recursive: true })
  writeFileSync(libTarget, readFileSync(outPath))
  log(`已同步到 packages/host/lib/dsh-mobile.apk ✓（宿主路由读这份 ✓）`)
}

const size = readFileSync(outPath).length
log(`完成：${outPath}（${(size / 1024).toFixed(1)} KB ✓，版本名 0.1.0+${stamp} ✓）`)
log(`装到手机：把手机插上（adb devices 能看到）后跑  adb install -r ${outPath}  ✓`)
log(`或者：宿主启动后手机直接下  https://<地址>:3443/mobile/app.apk  ✓`)
