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
 *      （`INTERNET` + `POST_NOTIFICATIONS` + **`CAMERA`** ✓ —— 第三条是 round 143 加的，
 *      见下面 `allowedPermissions` 的说明 ✓）；
 *   2. **该有的东西在**：`classes.dex` ✓、两张图标 ✓、**扫码界面的文案** ✓、
 *      ★ **没有** `assets/dshm_ca.pem` ✓（C2 起 —— 见下面那条断言的说明 ✓）；
 *   2b. **壳的代码真的在里面** ✓：三个尺寸变量 / insets 事件 / 显式 edge-to-edge /
 *      通知桥 / 文件选择器 / 外链 / **系统返回（OnBackInvokedCallback ✓ round 121）** /
 *      **底部手势区读数（mandatorySystemGestures ✓ round 124）** /
 *      **端点槽与换槽计时器 + 身份哑存储（round 129 ✓）** /
 *      **扫码配对（深链 + 壳内扫码 + 相机 + ZXing 解码器 ✓ round 143 ✓）** /
 *      **画面比例修复（`PreviewFit` 纯数学 + `applyPreviewLayout` ✓ round 153 ✓ ——
 *      修的是用户报的"调用的相机是纵向拉伸的"✗，见下面 `previewFit` 那段 ✓）** /
 *      ★ **TOFU 三件套（C2 ✓：取 CA + 与带外票据比对 / pin 落盘 + assets 回退 /
 *      忘记这台电脑 + 已固定指纹可核验 ✓）**
 *      —— 这几件事在手机上失败了没有任何画面差异 ✗，只能靠 dex 里的符号判 ✓；
 *   3. ★★ **不再固定任何 CA**（C2 ✓）—— 这正是"一个包能连任何一台电脑"的**判据** ✓：
 *      `assets/dshm_ca.pem` **不该在包里** ✓；"不固定的代偿"是 TOFU 的闸门真的在 dex 里 ✓
 *      （第 2b 条那三组 ✓）。**"CA 与这台电脑逐字节一致"那条整体退场** ✗ ——
 *      它断言的是一个**已经不存在**的性质 ✓（留着它就是在要求回到"一机一包"✗）；
 *   4. **链仍然验得通** ✓：用**电脑上那张** CA（不再是"APK 里那张"✗）验证
 *      **电脑当前**发的那张服务器证书 ✓（`openssl verify` ✓）——
 *      等价于壳里 `pinCa()` 拿到 pin 之后做的事 ✓，也等价于 TOFU 第 ② 步
 *      "这张 CA 到底签没签服务器那张" ✓。
 *      ★ 它**不**证明"APK 里带对了 CA" ✗（包里已经没有 CA 了 ✓），
 *        只证明"这台电脑的 CA/叶子这一对是自洽的" ✓ —— 后者才是 TOFU 能成功的条件 ✓。
 *
 * ★ 与 `scripts/check-pair-link.mjs` 的分工 ✗：那个脚本**真跑**壳里那份纯解析
 *   （`PairLink.java` ✓ —— 深链怎么变地址 ✓）；本脚本只管**产物里到底有没有这些代码** ✓。
 *   两者都在 ✓ 才叫"这一段验过了"✓。
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
/**
 * 断言条数 ✓（防呆用 ✓）。
 *
 * ★ 为什么要有这条：本脚本的"通过"一直只看**失败数** ✓ —— 于是"有人删掉几条断言"
 *   在输出上表现为**更短的全绿** ✗，与"全都验过了"长得一模一样 ✗
 *   （`check-mobile-layout.mjs` 的 `EXPECTED_MIN_CHECKS` 就是被同一类事故逼出来的 ✓）。
 *   下界再配一条"条数不够就报红" ✓ ⇒ 删断言必须**显式改这个数** ✓，
 *   而改它就会出现在 diff 里 ✓（有人为它负责 ✓）。
 *
 * ★ 只在**环境完整**时执法 ✓（`aapt2` 在 ✓、电脑上有 CA 与服务器证书 ✓）：
 *   缺 SDK / 缺证书时本脚本本来就会**跳过**若干条 ✓（打印 `·` ✓），
 *   那时按这个数判红是**误报** ✗ —— 见文件末尾的 `environmentComplete` ✓。
 *
 * ★★ 38 = 包信息 9 ✓ + APK 内容 4 ✓ + 资源文案 2 ✓ + dex 符号 21 ✓ + TOFU/链 2 ✓
 *   （round 143 从 24 抬到 32 ✓ —— 加的 8 条全是"扫码配对"那条链上的 ✓：
 *    权限 1 ✓ + 清单里的深链 filter 1 ✓ + ScanActivity 1 ✓ + 扫码文案 1 ✓ +
 *    dex 里四个分组（深链 / 入口 / 相机 / 解码器 ✓）✓。
 *    round 152 从 32 抬到 33 ✓ —— 加的那 1 条是 `DshmShell.scanPair` ✓：
 *    网页侧能调起壳内扫码的那条桥 ✓，见下面 `scanBridge` 那段 ✓。
 *    round 153 从 33 抬到 34 ✓ —— 加的那 1 条是"**画面比例修复在 dex 里**"✓：
 *    `PreviewFit`（纯数学 ✓）+ `applyPreviewLayout`（重摆 SurfaceView ✓），
 *    见下面 `previewFit` 那段 ✓ —— 修的是用户报的"调用的相机是纵向拉伸的"✗。
 *    它的"算得对不对"由 `scripts/check-preview-fit.mjs` **真跑**着验 ✓。
 *    ★ C2 从 34 抬到 **38** ✓ —— **只增不减** ✓，四条新的：
 *      ① `string/tofu_title` + `string/address_forget` + `string/tofu_mismatch` 在资源表里 ✓
 *         （与 `action_scan` 那条同一个理由 ✓：文案被 aapt2 弄丢时 dex 一个字节不变 ✗）；
 *      ② dex：TOFU 闸门（取 CA + 与带外票据比对 ✓）；
 *      ③ dex：pin 落盘 + **assets 回退分支** ✓（`dshm_ca.pem` 这个字符串**必须还在** ✓ ——
 *         它是"先读 pin、读不到再退回 assets"那条回退链的落点 ✓，删了就断了老包那条路 ✗）；
 *      ④ dex：「忘记这台电脑」+「已固定指纹可核验」 ✓。
 *    ⚠️ 同时**退场**一条：旧第 ③ 条"APK 里的 CA 与电脑上那张逐字节一致" ✗ ——
 *      它断言的性质（包里带 CA ✓）已经被 C2 **有意**去掉了 ✓。
 *      这不是"删断言"✗：同一件事换成了"包里**不该**有 CA" ✓（第 2 条）
 *      与"不固定的代偿（TOFU 闸门）真的在包里" ✓（第 2b 条那三组）✓。
 *      净变化 34 + 4 = 38 ✓（③/④ 两条**保留** ✓：③ 改成"电脑上有 CA 与叶子可验"✓，
 *      ④ 的 `-CAfile` 从 APK 里那张改成**电脑上**那张 ✓）。
 */
const EXPECTED_MIN_CHECKS = 38
let checkCount = 0
const check = (ok, label, detail) => {
  checkCount += 1
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
   * ★ 权限白名单（round 115 起是**两个** ✓，**round 143 起是三个** ✗）。
   *
   * 起因一（round 115）：用户报"通知权限没获取"✗ —— 网页那半用 Web Notification API，
   * 而 **Android WebView 不实现它** ✗ ⇒ APK 里通知只能走原生，
   * 而安卓 13 起发通知要运行时授权 ✓。
   *
   * 起因二（**round 143**）★★：用户要"扫码配对"✗ ⇒ 壳里要自己开相机取帧、
   * 自己解码 ✓，而没有 `CAMERA` 时 `Camera.open()` **直接抛** ✗。
   * 这一条是**对"权限白名单"这条成文约束的改动** ✗ ⇒ 所以这里不是"顺手加一项"✓：
   *   · **为什么非加不可** ✓：见 `AndroidManifest.xml` 里那条权限上方的长注释 ✓
   *     （三条理由 ✓ + 有没有不加的替代 ✓ + 拒绝授权时的降级路径 ✓）；
   *   · **不加的替代确实存在** ✓，而且**已经做了** ✓：`dshmobile://pair` 深链
   *     （用手机自己的系统相机/扫码器 ✓，**零新权限** ✓）——
   *     所以相机权限的定位是"**可选增强**"✓：不给也照样能配对 ✓；
   *   · 断言方式因此是**白名单逐项列出** ✓（不是 `length === 3` ✗）：
   *     以后再加权限会在这里红一次 ✓ —— 那正是"必须有人为它负责"✓。
   */
  const allowedPermissions = [
    'android.permission.INTERNET',
    'android.permission.POST_NOTIFICATIONS',
    'android.permission.CAMERA',
  ]
  const unexpected = permissions.filter((name) => !allowedPermissions.includes(name))
  check(
    unexpected.length === 0 && permissions.includes('android.permission.INTERNET'),
    '权限只有 INTERNET + POST_NOTIFICATIONS + CAMERA（没有存储/定位/通讯录等 ✗）',
    permissions.join('、') || '(无)',
  )
  check(
    permissions.includes('android.permission.POST_NOTIFICATIONS'),
    '带 POST_NOTIFICATIONS（否则安卓 13+ 上"允许通知"点下去不会有系统弹窗 ✗）',
    `permissions=${permissions.length}`,
  )
  /**
   * ★★ round 143：`CAMERA` 必须**真的在清单里** ✗。
   *
   * 为什么单列一条（它已经被上面那条白名单覆盖了 ✓）：上面那条断言的是
   * "**没有多出别的**权限"✓，这一条断言的是"**扫码要的那个必须在**"✗ ——
   * 两条方向相反 ✓，缺一条都会漏：
   *   · 少了白名单那条 ⇒ 有人偷偷加权限没人管 ✗；
   *   · 少了这一条 ⇒ 有人**把相机权限删掉**（比如嫌它破坏"两条"的旧约定 ✓），
   *     而 `aapt2` 那边一声不响 ✓，装到手机上表现为"扫码按钮点了弹一句没权限"✗
   *     —— 那时没人会想到是清单里少了一行 ✗。
   */
  check(
    permissions.includes('android.permission.CAMERA'),
    '带 CAMERA（壳内扫码要自己开相机取帧 ✗ 少了它 Camera.open() 直接抛 ✓；不加的替代是 dshmobile://pair 深链 ✓）',
    `permissions=${permissions.length}`,
  )
  check(/targetSdkVersion:'(\d+)'/.test(badging), '有 targetSdkVersion ✓', /targetSdkVersion:'(\d+)'/.exec(badging)?.[1])
  /**
   * ★ 清单里的 `android:enableOnBackInvokedCallback="true"`（round 121）✓。
   *
   * 为什么单列一条：这个开关决定"系统要不要把返回交给 OnBackInvokedCallback"✓。
   * 少了它，壳里注册回调的代码再对也没用 ✗（在 Android 13 上尤其如此 ✓），
   * 而现象与"整段代码没写"**一模一样** ✗ —— 手机上没有报错、只有"侧滑直接退出 App"✗。
   * （badging 里看不到 application 的属性 ✓，所以用 `aapt2 dump xmltree` ✓。）
   */
  let manifestTree = ''
  try {
    manifestTree = execFileSync(aapt2, ['dump', 'xmltree', '--file', 'AndroidManifest.xml', apkPath], { encoding: 'utf8' })
  } catch (error) {
    manifestTree = ''
  }
  check(
    /enableOnBackInvokedCallback[^\n]*=true/.test(manifestTree),
    '清单里显式开着 enableOnBackInvokedCallback=true（预测式返回下，返回不再走 onKeyDown ✗ —— 这个开关就是"要不要交给 OnBackInvokedCallback"✓）',
    manifestTree === '' ? '读不出清单树 ✗' : (/enableOnBackInvokedCallback[^\n]*/.exec(manifestTree)?.[0] ?? '没有这一项 ✗').trim(),
  )
  /**
   * ★★ round 143：**扫码配对的深链兜底**（B ✓，零新权限 ✓）——
   * `dshmobile://pair` 的 `VIEW` + `BROWSABLE` intent-filter 必须真的在清单里 ✗。
   *
   * 为什么这一条非有不可 ✗：手机上"扫了二维码但没反应"的**全部**可能里，
   * 最常见的一种就是**这个 filter 没进包** ✓（比如清单改错了、或者被谁删了 ✓）——
   * 而它**不会**报任何错 ✗：二维码还是那张 ✓，系统只是"没有应用能处理这条链接"✓，
   * 用户看到的是一句"无法打开链接"或者干脆什么都不发生 ✗。
   *
   * 三个条件逐一断言 ✓（缺一个就是"链接点不动"✗）：
   *   · `scheme="dshmobile"` + `host="pair"` ✓ —— 认的是**我们**这条链接 ✓；
   *   · `action.VIEW` ✓ —— 扫码器点的就是它 ✓；
   *   · `category.BROWSABLE` ✓ —— ★ 少了它，**从浏览器/扫码器点过来的链接会被丢掉** ✗
   *     （那正是"点进去没反应"的经典真因 ✓）；`DEFAULT` 也一起断言 ✓（隐式 intent 的匹配前提 ✓）。
   */
  {
    const tree = manifestTree === '' ? '' : manifestTree
    const hasScheme = /android:scheme\([^)]*\)="dshmobile"/.test(tree)
    const hasHost = /android:host\([^)]*\)="pair"/.test(tree)
    const hasView = /"android\.intent\.action\.VIEW"/.test(tree)
    const hasBrowsable = /"android\.intent\.category\.BROWSABLE"/.test(tree)
    const hasDefault = /"android\.intent\.category\.DEFAULT"/.test(tree)
    const missing = [
      hasScheme ? null : 'scheme=dshmobile',
      hasHost ? null : 'host=pair',
      hasView ? null : 'action.VIEW',
      hasBrowsable ? null : 'category.BROWSABLE',
      hasDefault ? null : 'category.DEFAULT',
    ].filter(Boolean)
    check(
      missing.length === 0,
      '清单里有 dshmobile://pair 的 VIEW + BROWSABLE 深链（B ✓ 零新权限 ✓ —— 少了它，用系统相机扫码就是"点了没反应"✗，而且手机上没有任何报错 ✗）',
      missing.length === 0 ? 'scheme=dshmobile、host=pair、VIEW、BROWSABLE、DEFAULT ✓' : `缺 ${missing.join('、')}`,
    )
  }
  /**
   * ★★ round 143：**壳内扫码那个 Activity 也必须真的在清单里** ✗（A ✓）。
   *
   * 判据是 `exported=false` ✓ 那一项：它同时证明两件事 ✓
   *   · 这个 Activity **注册了** ✓（没注册的话 `startActivity` 直接抛
   *     `ActivityNotFoundException` ✗ —— 用户点「扫码配对」就是"没反应"✗）；
   *   · 它**不是**外部入口 ✓（外面那条入口是上面的深链 filter ✓）——
   *     少了 `exported=false`，任何应用都能直接拉起我们的相机预览 ✗。
   */
  {
    const at = manifestTree.indexOf('.ScanActivity')
    const start = at < 0 ? -1 : manifestTree.lastIndexOf('E: activity', at)
    const after = at < 0 ? -1 : manifestTree.indexOf('E: activity', at)
    const block = start < 0 ? '' : manifestTree.slice(start, after < 0 ? manifestTree.length : after)
    check(
      block !== '' && /exported\([^)]*\)=false/.test(block),
      '清单里注册了 ScanActivity 且 exported=false（壳内扫码的界面 ✓ —— 没注册就是点「扫码配对」毫无反应 ✗；exported 不为 false 则任何应用都能拉起我们的相机 ✗）',
      block === '' ? '清单树里没有 .ScanActivity ✗' : (/android:name\([^)]*\)="[^"]*"/.exec(block)?.[0] ?? '').trim(),
    )
  }
} else {
  console.log(`  · （跳过包信息检查：找不到 aapt2 —— ${aapt2} ✓）`)
}

// ── ② 该有的东西在不在
const listing = execFileSync('unzip', ['-l', apkPath], { encoding: 'utf8' })
check(/\bclasses\.dex\b/.test(listing), '打包了 classes.dex ✓')
check(/res\/mipmap-xxhdpi-v4\/ic_launcher\.png/.test(listing), '带 192 图标 ✓')
check(/res\/mipmap-xxxhdpi-v4\/ic_launcher\.png/.test(listing), '带 512 图标 ✓')
/**
 * ★★ C2：**包里不该再有任何固定 CA** ✓（`assets/dshm_ca.pem` ✗）。
 *
 * 这条断言是"APK 与机器解耦"的**唯一**产物级判据 ✓：
 *   · 包里带 CA ⇒ 这个包只认**那一台**电脑 ✓（一机一包 ✗）；
 *   · 包里不带 CA ⇒ 首次连接只能走 TOFU ✓（`/mobile/trust.crt` + 带外指纹比对 ✓）。
 *
 * 为什么要专门断言"**没有**" ✗（而不是删掉旧断言就完事 ✓）：
 *   `native/android/assets/` 是 aapt2 的 `-A` 输入目录 ✓，而那份 CA 曾经是**入库**的 ✓ ——
 *   谁要是把文件恢复回来（或者老工作区里那份没删干净 ✓），aapt2 会静默地照样打进包 ✓，
 *   构建日志、dex、图标全都看不出任何异样 ✗，只有**装到手机上**才会发现
 *   "换了电脑连不上、而且死活不弹确认框"✗。
 *   `scripts/build-apk.mjs` 的第 ② 步现在会主动删掉它 ✓ —— 这里再验一遍产物 ✓（两道 ✓）。
 */
check(
  !/assets\/dshm_ca\.pem/.test(listing),
  '★ 包里**没有**固定 CA（assets/dshm_ca.pem ✗ —— C2 起一个包能连任何一台电脑 ✓，首次连接走 TOFU ✓；包里带 CA 就说明"一机一包"又回来了 ✗）',
  /assets\/dshm_ca\.pem/.test(listing) ? '存在 assets/dshm_ca.pem ✗' : 'assets 里没有任何 CA ✓',
)

/**
 * ★★ round 143：**扫码界面的文案资源也在包里** ✓（`string/scan_*` ✓）。
 *
 * 为什么单列一条 ✗：一个 `R.string.scan_hint` 少了，**编译期就会红** ✓ ——
 * 所以这条看起来多余 ✓。它防的其实是另一件事：**资源被 aapt2 的拆分/裁剪弄丢** ✓
 * （例如以后有人改 link 参数、或者把 `res/` 下的 values 挪走 ✓）——
 * 那时 `classes.dex` 一个字节不变 ✓、图标与 CA 也都在 ✓，只有界面文案变成
 * 一串资源 id ✗（手机上是"标题显示成数字"这种怪现象 ✓，谁都不会想到是打包问题 ✗）。
 * 判据取**两个关键字**：入口那颗按钮 ✓ + 扫码界面的提示 ✓。
 */
if (existsSync(aapt2)) {
  let resources = ''
  try {
    resources = execFileSync(aapt2, ['dump', 'resources', apkPath], { encoding: 'utf8' })
  } catch (error) {
    resources = ''
  }
  const wanted = ['string/action_scan', 'string/scan_hint', 'string/scan_denied_hint']
  const missing = wanted.filter((name) => !resources.includes(name))
  check(
    missing.length === 0,
    '扫码配对的文案资源在包里（`action_scan` 入口按钮 + `scan_hint` 界面提示 + `scan_denied_hint` 降级提示 ✓）',
    resources === '' ? '读不出资源表 ✗' : (missing.length === 0 ? wanted.join('、') : `缺 ${missing.join('、')}`),
  )
  /**
   * ★★ C2：**TOFU 与「忘记这台电脑」的文案资源也在包里** ✓。
   *
   * 与上面那条同一个理由 ✓（少一个 `R.string.*` 编译期就红 ✓ —— 所以这条防的是
   * "资源被 aapt2 的拆分/裁剪弄丢"✓：那时 dex 一个字节不变 ✓、只是界面上
   * 显示成一串资源 id ✗）。
   * 取三个关键字，各管一件事 ✓：
   *   · `tofu_title` —— "第一次连这台电脑要确认身份"那个框 ✓（**没有它就没有确认这一步** ✓）；
   *   · `tofu_mismatch` —— 指纹**不一致**那条（"可能有人在中间冒充"✓）——
   *     这是 TOFU 唯一真正危险的失败 ✓，这条文案丢了就等于把风险交给用户猜 ✗；
   *   · `address_forget` —— 「忘记这台电脑」✓（换宿主之后的**唯一**出路 ✓）。
   */
  const wantedTofu = ['string/tofu_title', 'string/tofu_mismatch', 'string/address_forget']
  const missingTofu = wantedTofu.filter((name) => !resources.includes(name))
  check(
    missingTofu.length === 0,
    'TOFU 的文案资源在包里（`tofu_title` 确认框 + `tofu_mismatch` 指纹不一致的警告 + `address_forget`「忘记这台电脑」✓ —— 少了任何一条，手机上就没有"确认身份 / 说清为什么拒 / 换电脑"这三步 ✓）',
    resources === '' ? '读不出资源表 ✗' : (missingTofu.length === 0 ? wantedTofu.join('、') : `缺 ${missingTofu.join('、')}`),
  )
} else {
  console.log(`  · （跳过扫码文案检查：找不到 aapt2 —— ${aapt2} ✓）`)
}

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
  /**
   * ★ 底部**手势导航条（小白条）**的读数（round 124）✓ —— 用户："我的手机底部开启了小白条
   *   （手势导航条），目前应用最底下的上下文用量说明那一行与它冲突"✗。
   *
   * 为什么单列一条：壳此前**只读 `navigationBars`** ✗ —— 手势导航下它可能远小于小白条
   * 真正占住的高度 ✓，而描述"系统强制手势区"的是 `mandatorySystemGestures` ✓。
   * 这类"读错了量"在真机上是**纯视觉**的 ✗（不崩、不报错，只是那一行被盖住 ✓），
   * 电脑上永远看不出来 ✓ ⇒ 至少让符号断言保证"这段代码真的在包里"✓。
   *
   * 三个符号缺一不可 ✓：`mandatorySystemGestures` ✓（强制手势区）/ `systemGestures` ✓
   * （系统建议避让区）/ `dshm-gesture-bottom` ✓（写出去的 CSS 变量名 ✓ ——
   * 网页的「端侧诊断」那一行读的就是它 ✓）。
   */
  const gestureInsets = ['mandatorySystemGestures', 'systemGestures', 'dshm-gesture-bottom']
  check(
    hasAll(gestureInsets),
    '底部手势区读数在 dex 里（`mandatorySystemGestures` + `systemGestures` + `--dshm-gesture-bottom` ✓ —— 读错量在真机上是**纯视觉**的 ✗，只能靠符号判 ✓）',
    missing(gestureInsets).length === 0 ? gestureInsets.join('、') : `缺 ${missing(gestureInsets).join('、')}`,
  )
  /**
   * ★ 文件选择器（round 119）✓ —— 用户报"添加文件点了没反应"✗，真因是壳里
   *   **没有实现 `WebChromeClient.onShowFileChooser`** ✓（Android WebView 的硬要求 ✓）。
   *   这一条在手机上失败了**完全没有报错** ✗，所以只能靠 dex 里的符号判 ✓。
   */
  const fileChooser = ['onShowFileChooser', 'WebChromeClient', 'onActivityResult']
  check(
    hasAll(fileChooser),
    '文件选择器已接上（`WebChromeClient.onShowFileChooser` ✓ —— 否则网页里的「添加文件」点了**毫无反应** ✗）',
    missing(fileChooser).length === 0 ? fileChooser.join('、') : `缺 ${missing(fileChooser).join('、')}`,
  )
  /**
   * ★ 外链（round 120）✓ —— 用户："外链也点不动"✗，真因是 **Android WebView 默认丢掉
   *   `target="_blank"` 的点击** ✓（桌面 Chrome 会开新标签页 ⇒ 无头验收测不出来 ✗）。
   *   同样是"静默失败"，所以只能靠 dex 里的符号判 ✓。
   */
  const externalLinks = ['setSupportMultipleWindows', 'onCreateWindow']
  check(
    hasAll(externalLinks),
    '外链已接上（`setSupportMultipleWindows` + `onCreateWindow` ✓ —— 否则正文里的 http 链接点了没反应 ✗）',
    missing(externalLinks).length === 0 ? externalLinks.join('、') : `缺 ${missing(externalLinks).join('、')}`,
  )
  /**
   * ★ 外链的**网页侧兜底**（round 122）✓ —— 光有 `onCreateWindow` 不够：
   *   它靠 `WebView.getHitTestResult().getExtra()` 取地址 ✓，那是"上一次触摸命中了什么" ✓，
   *   对**程序化**弹窗与部分锚点并不可靠 ✗ —— 取不到就 `return false` ⇒ **弹窗被丢掉** ✗
   *   （日志里那句 "外链点了但拿不到地址（_blank）" ✓）。
   *   网页那一侧知道被点的是哪个 `<a href>` ✓ ⇒ 由它调 `DshmShell.openExternal(url)` ✓，
   *   壳这边用 `Intent.ACTION_VIEW` 真正打开 ✓（`ACTION_VIEW` 不引入权限 ✓，
   *   所以上面那条"权限白名单只有两项"的契约不变 ✓）。
   *   这一条同样是**静默失败**（手机上点了没反应、没有任何报错 ✗）⇒ 只能靠 dex 里的符号判 ✓。
   */
  const externalFallback = ['openExternal']
  check(
    hasAll(externalFallback),
    '外链兜底桥在 dex 里（`DshmShell.openExternal` ✓ —— 少了它，hit test 取不到地址的 `_blank` 仍然**点了没反应** ✗）',
    missing(externalFallback).length === 0 ? externalFallback.join('、') : `缺 ${missing(externalFallback).join('、')}`,
  )
  const notifyBridge = ['requestNotificationPermission', 'notificationPermission', 'notify']
  check(
    hasAll(notifyBridge),
    '通知桥在 dex 里（权限查询 + 运行时申请 + 发通知 ✓ —— WebView 里没有 Web Notification ✗）',
    missing(notifyBridge).length === 0 ? notifyBridge.join('、') : `缺 ${missing(notifyBridge).join('、')}`,
  )
  /**
   * ★ 系统返回（round 121）✓ —— 用户："手机的侧边返回会默认为退出 app"✗。
   *
   * 根因：预测式返回默认开启 ⇒ 返回**不再走 `onKeyDown`** ✗（官方文档：
   * intercepting back events from KeyEvent.KEYCODE_BACK is no longer supported ✓），
   * 而壳当时**没有注册** `OnBackInvokedCallback` ✗ ⇒ 系统按默认行为结束 Activity ✓。
   * 这一条同样是**静默失败**（手机上没有报错、只有"直接退出"✗），
   * 所以只能靠 dex 里的符号判 ✓ —— 三个缺一不可：
   *   · `OnBackInvokedCallback` / `registerOnBackInvokedCallback`：真的注册了回调 ✓；
   *   · `setBackAvailable`：网页能告诉壳"现在有没有可返回的东西"✓
   *     （壳不能异步去问 ✗ —— 返回必须在同一帧决定"吃掉还是退出"✓）。
   */
  const backHandling = ['OnBackInvokedCallback', 'registerOnBackInvokedCallback', 'setBackAvailable']
  check(
    hasAll(backHandling),
    '系统返回已接管（OnBackInvokedCallback + registerOnBackInvokedCallback + setBackAvailable ✓ —— 少了它，侧滑返回会**直接退出 App** ✗，而且手机上完全没有报错 ✗）',
    missing(backHandling).length === 0 ? backHandling.join('、') : `缺 ${missing(backHandling).join('、')}`,
  )
  /**
   * ★ **保存文件到「下载」的桥**（round 128）✓ —— 用户真机反馈：
   *   "手机上下载提示成功但文件没到手机" ✗。
   *
   * 根因：文件面板的下载是"JS 里拿到字节 → 点 `<a download>`（blob:）"✗，
   * 而 **Android WebView 默认把下载整条丢掉** ✗ ⇒ 网页那句"下载成功"是**假成功** ✗。
   * blob 下载**不能**靠 `setDownloadListener` 救 ✗（它只对网络 URL 触发 ✓）⇒ 必须走这条桥 ✓。
   *
   * 为什么断言的是这三个符号：`MediaStore` + `Downloads` 证明"写的是系统「下载」目录"✓，
   * `saveFile` 证明桥方法真的在包里 ✓。这一条在手机上失败是**完全静默**的 ✗
   * （点了没反应、或者更糟：网页说成功而文件不在 ✓）⇒ 只能靠 dex 里的符号判 ✓。
   *
   * ⚠️ 这条桥**不引入任何权限** ✓（`MediaStore.Downloads` 由系统代写 ✓）——
   * 上面那条"权限白名单只有两项"的契约必须照旧成立 ✓。
   */
  const saveToDownloads = ['MediaStore', 'Downloads', 'saveFile']
  check(
    hasAll(saveToDownloads),
    '「保存到下载」的桥在 dex 里（MediaStore.Downloads + saveFile ✓ —— 少了它，手机上"下载成功"却**没有文件** ✗，而且全程没有报错 ✗）',
    missing(saveToDownloads).length === 0 ? saveToDownloads.join('、') : `缺 ${missing(saveToDownloads).join('、')}`,
  )
  /**
   * ★★ round 129：**端点槽 + 换槽计时器**（用户要的"两个默认链接，优先学校、
   *   超时切 Tailscale、再不行弹地址框" ✓）。
   *
   * `setEndpointSlots` 是网页上报候选槽的那条桥 ✓（**只落盘、绝不导航** ✗）；
   * `endpoint-slots` / `switch-timeout-ms` 是它落盘用的两个 prefs 键 ✓
   * （`switch-timeout-ms` 默认 2000 ✓、夹在 200..10000 ✓）。
   *
   * 为什么断言的是**符号**而不是行为：手机上"槽没切过去"是**完全静默**的 ✗
   * （页面就是一直转圈 ✓，没有任何报错 ✓）—— 电脑上唯一抓得住的就是
   * "这段代码到底有没有进包" ✓（同一类判据见上面 round 119/120/121/128 各条 ✓）。
   */
  const endpointSlots = ['setEndpointSlots', 'endpoint-slots', 'switch-timeout-ms']
  check(
    hasAll(endpointSlots),
    '端点槽桥与两个配置键在 dex 里（`setEndpointSlots` + `endpoint-slots` + `switch-timeout-ms` ✓ —— 少了它，用户要的"学校 → Tailscale → 弹框"这条链整条不存在 ✗，而且手机上看不出任何异样 ✗）',
    missing(endpointSlots).length === 0 ? endpointSlots.join('、') : `缺 ${missing(endpointSlots).join('、')}`,
  )
  /**
   * ★★ round 129：**换槽计时器**（`Handler` + `postDelayed` + `removeCallbacks` ✓）。
   *
   * 这三样**一个都不能少** ✓：
   *   · `postDelayed` —— "超过 2000ms 就切"这条**唯一**的实现手段 ✓
   *     （本轮之前全仓**一个计时器都没有** ✗，所以这条断言曾经必然红 ✗）；
   *   · `removeCallbacks` —— 取消点（服务器已响应 ✓）/ 换槽 ✓ / `onDestroy` ✓
   *     都要撤掉它 ✗，不撤就是：计时器泄漏 + 到点去动一个已经销毁的 WebView ✗
   *     + 把"已经赢了的槽"再切走 ✗（连环跳 ✗）。
   */
  const slotTimer = ['Handler', 'postDelayed', 'removeCallbacks']
  check(
    hasAll(slotTimer),
    '换槽计时器在 dex 里（`Handler` + `postDelayed` + `removeCallbacks` ✓ —— 少了它就没有"2000ms 切下一个"这回事 ✗；少了 remove 就会连环跳 + 泄漏 ✗）',
    missing(slotTimer).length === 0 ? slotTimer.join('、') : `缺 ${missing(slotTimer).join('、')}`,
  )
  /**
   * ★★ round 129：**"服务器有响应 ≠ 失败" + 地址框防重入 + 身份哑存储** ✓。
   *
   * · `onReceivedHttpError`（本轮**新增** ✓）：此前这个方法**没有 override** ✗ ⇒
   *   403 / 404 / 5xx **完全静默** ✗。现在它把状态码记进日志 ✓ 并**当作"服务器有响应"** ✓
   *   （403 不是"这一槽失败"✗ —— 换地址救不了它 ✗）。
   * · `addressDialogOpen` + `promptForAddress`：地址输入框的**防重入** ✓ ——
   *   它此前在四个地方被调用而**零防重入** ✗ ⇒ `onReceivedError` 与双击返回
   *   前后脚触发就会**叠两个框** ✗（而且 `setCancelable(false)`，用户连点掉一个都不行 ✗）。
   * · `vaultGet` / `vaultSet`：**身份哑存储** ✓ —— 这是"换源不丢身份"的**唯一**落点 ✓：
   *   WebView 的 `localStorage` **按源隔离** ✗ ⇒ 换 URL = 换源 ⇒ 设备私钥与配对配置全丢 ✗
   *   （页面能开但没有隧道、点不动 ✗），而 `SharedPreferences` 天然跨源 ✓。
   *   少了它，手机上的表现是"能打开、但像一台没配过对的新手机" ✗ —— 静默 ✗。
   */
  const switchSemantics = ['onReceivedHttpError', 'promptForAddress', 'addressDialogOpen', 'vaultGet', 'vaultSet']
  check(
    hasAll(switchSemantics),
    '换槽语义与身份存储在 dex 里（`onReceivedHttpError` 不再静默 ✓ + `addressDialogOpen` 地址框防重入 ✓ + `vaultGet`/`vaultSet` 身份跨源 ✓ —— 少了它们：403 查不出来 ✗ / 叠两个框 ✗ / 换源后配对丢失 ✗）',
    missing(switchSemantics).length === 0 ? switchSemantics.join('、') : `缺 ${missing(switchSemantics).join('、')}`,
  )

  /**
   * ★★ round 143：**扫码配对**（B 深链 ✓ + A 壳内扫码 ✓）——
   * 四组断言，一组都不许少 ✓（这一整条链上**每一环**在真机上都是"静默失败"✗）。
   *
   * 为什么只能靠 dex 符号判 ✗：本机没有相机、没有真机 ✓ ——
   * "扫了没反应"与"这段代码压根没进包"在手机上**长得一模一样**✗
   * （没有报错、没有画面差异 ✓）。所以这里断言的是"产物里到底有没有这些代码"✓，
   * 而"它算出来的地址对不对"由 `scripts/check-pair-link.mjs` **真跑**着验 ✓（分工见文件头 ✓）。
   *
   * 第 ① 组 **深链的两个入口** ✓：`onNewIntent` 缺了 ⇒ "App 已在前台时扫码没反应"✗；
   *   `handlePairIntent` / `handlePairText` 缺了 ⇒ 收到 intent 也不会变成加载 ✗。
   * 第 ② 组 **壳内扫码的入口** ✓：`startScan` 是「电脑地址」框上那颗「扫码配对」按钮 ✓，
   *   `ScanActivity` 是那个界面本身 ✓ —— 缺任何一个，用户在壳里就扫不了码 ✗。
   * 第 ③ 组 **相机** ✓：`android/hardware/Camera` + `setPreviewCallback` 证明"真的开预览取帧"✓
   *   （不是拍张照片了事 ✓）；`requestPermissions` 证明**运行时**要权限 ✓
   *   （清单里声明了不等于用户给了 ✓ —— 少了它，扫码界面一开就崩 ✗）。
   * 第 ④ 组 **解码器真的被打进 dex** ✓：这是**唯一**能证明"vendored 的 ZXing 真的进了包"
   *   的办法 ✗（`javac -cp` 只证明编译期找得到 ✓ —— jar 没进 d8 输入的话，
   *   编译一路绿灯 ✓、装到手机上一点"扫码"就 `NoClassDefFoundError` ✗）。
   */
  const deepLink = ['onNewIntent', 'handlePairIntent', 'handlePairText']
  check(
    hasAll(deepLink),
    '扫码配对的深链两入口在 dex 里（`onCreate` ✓ + `onNewIntent` ✓ 都汇到 `handlePairText` ✓ —— 少了 onNewIntent，App 开着时扫二维码**没反应** ✗，而且手机上没有任何报错 ✗）',
    missing(deepLink).length === 0 ? deepLink.join('、') : `缺 ${missing(deepLink).join('、')}`,
  )
  const scanEntry = ['startScan', 'ScanActivity', 'PairLink']
  check(
    hasAll(scanEntry),
    '壳内扫码的入口与界面在 dex 里（「电脑地址」框上的 `startScan` ✓ + `ScanActivity` ✓ + 与深链共用的 `PairLink` ✓ —— 少了入口，用户在壳里根本扫不了码 ✗）',
    missing(scanEntry).length === 0 ? scanEntry.join('、') : `缺 ${missing(scanEntry).join('、')}`,
  )
  /**
   * ★★ round 152：**网页侧唤起壳内扫码的那条桥** ✓（`DshmShell.scanPair` ✓）。
   *
   * 为什么单列一条 ✗：用户报的正是"手机端点击「扫码配对」没有正常功能"✗ ——
   * 壳里明明有 `ScanActivity` ✓，却**只**长在「电脑地址」框上 ✓，
   * 网页（配对页 `/mobile` ✓ 与「连接与设备」✓ 两颗同名按钮）**一个字都调不到** ✗。
   * 少了这条桥，那两颗按钮在手机上的表现就是"点了没反应"✗（而且在手机上完全没有报错 ✗）。
   *
   * 判据取方法名 `scanPair` ✓：它出现在 dex 的字符串表里 ✓ ——
   * "源码里改了、装出去的还是旧 APK"✗ 是本项目反复吃过的那一类事故 ✓
   * （见 `05` §73 与交接文档 §五.1 ✓）。
   */
  const scanBridge = ['scanPair']
  check(
    hasAll(scanBridge),
    '★★ 网页侧唤起壳内扫码的桥在 dex 里（`DshmShell.scanPair` ✓ —— 少了它，网页上那两颗「扫码配对」只能是一句提示 ✗，用户在手机上看就是"点了没反应"✗，而且没有任何报错 ✗）',
    missing(scanBridge).length === 0 ? scanBridge.join('、') : `缺 ${missing(scanBridge).join('、')}`,
  )
  /**
   * ★★ round 153：**画面比例那套数学 + 重摆动作真的进包了** ✓。
   *
   * 起因（用户真机原话）："调用的相机是**纵向拉伸**的"✗ —— 功能全通 ✓（能扫到、能配对 ✓），
   * 纯粹是画面被拉长 ≈ 1.25 倍 ✓（人/二维码看起来瘦高 ✓）。
   *
   * 为什么这一条也必须靠 dex 符号判 ✗：与上面几条同病 —— 手机上**没有任何报错** ✗
   * （不崩、不弹、还能扫 ✓），只是"人看起来瘦高"✓；而本机没有相机、没有真机 ✗
   * ⇒ "源码改了但装出去的还是旧 APK"✗ 在真机上与"根本没改"长得**一模一样** ✗
   * （本项目反复吃过这一类事故 ✓，见 `05` §73 ✓）。
   *
   * 两个符号缺一不可 ✓：
   *   · `PreviewFit` —— 选尺寸 + 算"不变形"矩形的纯数学类 ✓（**零 android 依赖** ✓，
   *     于是它能在电脑上**真跑**测试 ✓：`scripts/check-preview-fit.mjs` ✓ ——
   *     "算得对不对"归那个脚本 ✓，"在不在包里"归这一条 ✓，两者都在才叫验过 ✓）；
   *   · `applyPreviewLayout` —— 把算出来的矩形真正落到 `SurfaceView` 上的那一步 ✓
   *     （`surfaceChanged` 里每次旋转都重摆 ✓）。少了它，`PreviewFit` 算得再对也没人用 ✗。
   */
  const previewFit = ['PreviewFit', 'applyPreviewLayout']
  check(
    hasAll(previewFit),
    '★★ 画面比例修复在 dex 里（`PreviewFit` 纯数学 + `applyPreviewLayout` 重摆 SurfaceView ✓ —— 少了它，竖屏下画面会被硬铺成"屏幕比例"⇒ **纵向拉伸 ≈1.25 倍** ✗，而手机上不报任何错、只是人看起来瘦高 ✗）',
    missing(previewFit).length === 0 ? previewFit.join('、') : `缺 ${missing(previewFit).join('、')}`,
  )
  const cameraPath = ['android/hardware/Camera', 'setPreviewCallback', 'requestPermissions']
  check(
    hasAll(cameraPath),
    '相机预览与运行时申请权限在 dex 里（`android.hardware.Camera` + `setPreviewCallback` + `requestPermissions` ✓ —— 少了权限申请，扫码界面一开就崩 ✗；少了预览回调就永远扫不到 ✗）',
    missing(cameraPath).length === 0 ? cameraPath.join('、') : `缺 ${missing(cameraPath).join('、')}`,
  )
  const zxingDecoder = [
    'com/google/zxing/qrcode/QRCodeReader',
    'com/google/zxing/PlanarYUVLuminanceSource',
    'com/google/zxing/common/HybridBinarizer',
  ]
  check(
    hasAll(zxingDecoder),
    '★ ZXing 解码器**真的**在 dex 里（QRCodeReader + PlanarYUVLuminanceSource + HybridBinarizer ✓ —— `javac -cp` 只证明编译期找得到 ✓，jar 没进 d8 输入的话编译照样全绿 ✗，装到手机上一扫码就 NoClassDefFoundError ✗）',
    missing(zxingDecoder).length === 0
      ? `${zxingDecoder.length} 个类都在（ZXing core 3.5.3 ✓）`
      : `缺 ${missing(zxingDecoder).join('、')}`,
  )

  /**
   * ★★ C2 第 ① 组：**TOFU 的决策闸门真的在包里** ✓。
   *
   * 这三样是"**绝不静默接受未知证书**"这条硬不变量的**代码形态** ✓：
   *   · `tofuTrustOnce` —— 未知身份时那条"取 CA → 比对 → 落盘 → 才 proceed"的路 ✓
   *     （少了它，`onReceivedSslError` 就只有"验不通 ⇒ cancel"✗：
   *      新包不带 CA ⇒ **永远连不上任何电脑** ✓ —— 用户在手机上看到的只是"打不开"✗）；
   *   · `trust.crt` —— `/mobile/trust.crt` 那个取 CA 的路径 ✓（少了它取不到 CA ✓）；
   *   · `rememberTicketCaFingerprint` —— **读票据里那个带外指纹**的那一段 ✓
   *     （少了它，"拿什么比对"这件事就只剩下"用户自己看"✓ —— 旧宿主那条降级路能走 ✓，
   *      但新宿主明明带了指纹却被忽略 ✗）。
   *     ★ 这里刻意**不**用字符串 `caFingerprint` 当判据 ✗ —— 变异验证时发现的：
   *       `String.includes` 是**子串**匹配 ✓，而壳里有个无关的方法叫 `caFingerprintOf` ✓，
   *       于是"把读票据字段那段整个删掉"之后这条断言**照样绿** ✗（判据被同名前缀喂饱了 ✓）。
   *       换成方法名 `rememberTicketCaFingerprint` 之后，删掉那段就是真红 ✓。
   *
   * 为什么只能靠 dex 符号判 ✗：本机没有真机 ✓ —— 这三样在手机上失败的表现
   * 与"整段代码没写"**一模一样**✗（不崩、不报错，只是连不上或者永远弹确认框 ✓）。
   * 而"闸门到底有没有被绕过"（能不能被静默接受 ✓）**电脑上验不了** ✗ ——
   * 那是真机 / 代码评审的事 ✓，这里只管"这段代码在不在产物里"✓。
   */
  const tofuGate = ['tofuTrustOnce', 'trust.crt', 'rememberTicketCaFingerprint']
  check(
    hasAll(tofuGate),
    '★★ TOFU 的闸门在 dex 里（`tofuTrustOnce` 取 CA 与**带外**票据指纹比对 + `/mobile/trust.crt` 路径 + `rememberTicketCaFingerprint` 读票据字段 ✓ —— 少了它，不带 CA 的新包**永远连不上**，而手机上只表现为"打不开"✗；少了比对就是"盲信第一次"✗）',
    missing(tofuGate).length === 0 ? tofuGate.join('、') : `缺 ${missing(tofuGate).join('、')}`,
  )
  /**
   * ★★ C2 第 ② 组：**pin 落盘 + 读不到时退回 assets** ✓。
   *
   * 回退链是"**先读 pin，读不到再退回 assets**" ✓ —— 这一组的四个符号正好是这条链 ✓：
   *   · `loadPinnedCa`（先读 pin ✓、读不到退回 assets ✓）/ `savePinnedCa`（TOFU 确认后落盘 ✓）；
   *   · `pinned-ca`（prefs 键名 ✓ —— 与参数里那份"不固定任何 CA"配套 ✓）；
   *   · `dshm_ca.pem` —— ★ **这个字符串必须还在 dex 里** ✗：它是 assets 回退分支的落点 ✓。
   *     有人可能觉得"包里都不带 CA 了，这个字符串也该删"✗ ——
   *     删了就等于**只留一条路** ✓：老包（CA 还打在包里 ✓）就再也不能靠 assets 工作了 ✗，
   *     而"滚回只需恢复 build-apk 那一步、不用改壳代码"正是本方案的回退承诺 ✓。
   */
  const tofuPinFallback = ['loadPinnedCa', 'savePinnedCa', 'pinned-ca', 'dshm_ca.pem']
  check(
    hasAll(tofuPinFallback),
    '★ pin 落盘与 assets 回退在 dex 里（`loadPinnedCa` 先读 pin ✓、`savePinnedCa` 确认后落盘 ✓、prefs 键 `pinned-ca` ✓、回退分支的 `dshm_ca.pem` ✓ —— 少了回退，滚回老包那条路就断了 ✗；少了落盘，每次冷启动都要重新确认身份 ✗）',
    missing(tofuPinFallback).length === 0 ? tofuPinFallback.join('、') : `缺 ${missing(tofuPinFallback).join('、')}`,
  )
  /**
   * ★★ C2 第 ③ 组：**「忘记这台电脑」+「已固定指纹可核验」** ✓。
   *
   * 这两件事是 TOFU 的**运维前提**（不是锦上添花 ✓）：
   *   · `forgetThisComputer` —— 换宿主之后旧 pin 会把新宿主**全部拒掉** ✓
   *     （TOFU 的经典操作陷阱 ✓）；没有它，用户只能卸载重装 ✓；
   *   · `pinnedCaFingerprint` —— 网页要能显示"手机到底固定了哪一张"✓
   *     （配对页的「连接」卡把它与"这台电脑的 CA 指纹"并排显示 ✓）。
   *     少了它，用户对着一句"连不上"没有任何可核对的线索 ✗。
   */
  const tofuForget = ['forgetThisComputer', 'pinnedCaFingerprint', 'KEY_PINNED_CA']
  check(
    hasAll(tofuForget),
    '★ 「忘记这台电脑」与已固定指纹可核验在 dex 里（`forgetThisComputer` 同时清 pin 与 pinned-slot ✓ + `pinnedCaFingerprint` 只读桥 ✓ + `KEY_PINNED_CA` 常量名 ✓ —— 少了前者，换电脑之后只能卸载重装 ✗；少了后者，用户没有任何可核对的线索 ✗）',
    missing(tofuForget).length === 0 ? tofuForget.join('、') : `缺 ${missing(tofuForget).join('、')}`,
  )
}

// ── ③ ★★ C2：**本包不带任何固定 CA**，而"不固定的代偿"是这台电脑 CA/叶子这一对自洽 ✓
//
// 旧的第 ③ 条（"APK 里那张 CA 与电脑上那张逐字节一致"）**整体退场** ✗ ——
// 它断言的性质已经被 C2 有意去掉了（包里不再带 CA ✓）。这里换成两件仍然成立、
// 而且**正是 TOFU 能成功的条件** ✓：
//   ③a）电脑上确实有一张 CA、以及由它签发的服务器证书（壳要去取的对象存在 ✓）；
//   ③b）用**电脑上那张** CA 能验通**电脑当前**发的那张服务器证书
//        （= 壳里 `pinCa()` 拿到 pin 之后做的事 ✓ = TOFU 第 ② 步的"签得了吗" ✓）。
// ★ 这两条**不再**碰 APK 里的任何证书 ✓（包里没有 CA 了 ✓）；
//   判据从"包与这台电脑一致" ✓ 变成"包与机器无关 ✓ + 这台电脑自己是自洽的" ✓。
const liveCaPath = join(tlsDir, 'lan-ca.pem')
const liveLeafPath = join(tlsDir, 'lan-cert.pem')
if (existsFile(liveCaPath) && existsFile(liveLeafPath)) {
  check(true, '电脑上有 CA 与由它签发的服务器证书（TOFU 要取回并比对的对象 ✓ —— 与 APK 里带了什么**无关** ✓）', `${liveCaPath} + ${liveLeafPath}`)
} else {
  console.log('  · （跳过"电脑上有 CA/叶子"：还没生成 ✓ —— 先跑 node scripts/make-cert.mjs）')
}

// ── ④ 用**电脑上那张** CA 去验**电脑当前**发的那张服务器证书（= 壳里 pinCa() 做的事 ✓）
if (existsFile(liveCaPath) && existsFile(liveLeafPath)) {
  let verified = false
  let note = ''
  try {
    const output = execFileSync('openssl', ['verify', '-CAfile', liveCaPath, liveLeafPath], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    verified = /: OK/.test(output)
    note = output.trim().split('\n').pop() ?? ''
  } catch (error) {
    note = String(error?.stdout ?? error?.message ?? error).trim().split('\n').pop() ?? ''
  }
  check(verified, '用电脑上的 CA 能验通电脑当前发的服务器证书（= TRUST 成立、TOFU 第 ② 步的"签得了吗"会通过 ✓；★ 这条**不**再说明"APK 里带对了 CA"✗ —— 包里已经没有 CA 了 ✓）', note)
} else {
  console.log('  · （跳过链校验：电脑上还没有 CA/服务器证书 ✓ —— 先跑 node scripts/make-cert.mjs）')
}

rmSync(workDir, { recursive: true, force: true })

console.log(
  failed === 0
    ? `\n[check-apk] 通过：APK 可以装、内容齐全、★ 与机器无关（包里不带任何 CA ✓、TOFU 闸门在 ✓）、这台电脑的 CA/叶子自洽 ✓（${checkCount} 条 ✓ / 0 ✗）`
    : `\n[check-apk] 未通过 ${failed} 项 ✗（共 ${checkCount} 条）`,
)
/**
 * ★ 条数防呆 ✓（见 `EXPECTED_MIN_CHECKS` 的说明 ✓）：
 *   **环境完整**时才执法 ✗ —— `aapt2` 缺失或电脑上没有 CA/服务器证书时，
 *   本脚本会**成组跳过**断言 ✓（打印 `·` ✓），那时"条数少"是环境使然 ✓，
 *   不是"有人删了断言"✗ —— 按固定条数判红只会误导下一个人 ✓。
 *   （C2 起，电脑上有没有 CA/叶子只影响第 ③/④ 两条 ✓ —— 它们验的是**这台电脑**
 *    自己的自洽性 ✓，与包里带了什么**无关** ✓。）
 */
const environmentComplete = existsSync(aapt2) && existsFile(liveCaPath) && existsFile(liveLeafPath)
if (environmentComplete && checkCount < EXPECTED_MIN_CHECKS) {
  console.error(`\n[check-apk] 断言条数不足：${checkCount} < ${EXPECTED_MIN_CHECKS} ✗`)
  console.error('  - 有人删掉了断言？（见 EXPECTED_MIN_CHECKS 的说明）')
  process.exit(1)
}
process.exit(failed === 0 ? 0 : 1)

function existsFile(path) {
  return existsSync(path)
}
