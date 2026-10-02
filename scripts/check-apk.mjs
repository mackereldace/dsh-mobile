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
 *      （`INTERNET` + `POST_NOTIFICATIONS` + **`CAMERA`** ✓ —— 第三条是 round 143 加的；
 *      ★ **保活轮**又加了 **`FOREGROUND_SERVICE` + `FOREGROUND_SERVICE_SPECIAL_USE`** ✗
 *      —— 现在白名单是**五条** ✓，逐项列在下面 `allowedPermissions` 里 ✓，
 *      为什么非加不可 / 有没有替代，也都写在那一格里 ✓）；
 *   2. **该有的东西在**：`classes.dex` ✓、两张图标 ✓、**扫码界面的文案** ✓、
 *      ★ **没有** `assets/dshm_ca.pem` ✓（C2 起 —— 见下面那条断言的说明 ✓）；
 *   2b. **壳的代码真的在里面** ✓：三个尺寸变量 / insets 事件 / 显式 edge-to-edge /
 *      通知桥 / 文件选择器 / 外链 / **系统返回（OnBackInvokedCallback ✓ round 121）** /
 *      **底部手势区读数（mandatorySystemGestures ✓ round 124）** /
 *      **端点槽与换槽计时器 + 身份哑存储（round 129 ✓）** /
 *      **扫码配对（深链 + 壳内扫码 + 相机 + ZXing 解码器 ✓ round 143 ✓）** /
 *      **画面比例修复（`PreviewFit` 纯数学 + `applyPreviewLayout` ✓ round 153 ✓ ——
 *      修的是用户报的"调用的相机是纵向拉伸的"✗，见下面 `previewFit` 那段 ✓）** /
 *      ★ **壳侧保活（保活轮 ✓：`KeepAliveService` 前台服务 / 根返回改 `moveTaskToBack(true)` /
 *      原生时钟的注入入口 / 网页→原生状态桥 ✓）** /
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
import { createHash, X509Certificate } from 'node:crypto'
import { existsSync, readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

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
 * ★★ **现在的构成（保活轮之后 ✓）：包信息 13 + APK 内容 4 + 资源文案 3 + dex 符号 26 +
 *   TOFU/链 3 = 49 ✓ + 原生首页那一套 1 ✓ + **底部标签图标 1 = 51** ✓（= 下面那个 `EXPECTED_MIN_CHECKS` ✓ —— 两处必须同时改 ✗）。
 *   ⚠️ 这一行此前写的是"40 = …dex 符号 22…"✗ —— 那个数**与代码从来就对不上** ✓：
 *      round 174 时 dex 实际已经是 **23** 组 ✓（下面历史段落里的"22"是漏算了一组 ✓）。
 *      以本行为准 ✓（数错不会让任何断言变红 ✗，只会让下一个人以为"删几条也没事"✗ —— 正是防呆要防的东西 ✓）。
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
 *    ★★ round 5（2026-09-28）从 38 抬到 **40** ✓ —— 补的是 C2 里**唯一没有断言的那条缝**：
 *      **指纹的"写法"契约**（宿主发冒号十六进制 95 字符 ✓，壳必须先归一化 ✓）。
 *      ⑤a dex：`normalizeFingerprint` + `caFingerprintOf` + `formatFingerprintGroups` 在产物里 ✓
 *          （少了归一化 ⇒ 带冒号的值长度 95 ⇒ 被判成"旧宿主" ⇒ `expectedCaFingerprint=null`
 *           ⇒ **每次**首次连接都退化成人工确认 ✗ —— 不崩不报错，**只在手机上现形** ✗）；
 *      ⑤b **可执行交叉验证**：宿主那串值按壳的规则归一化后，必须 == 独立算的 CA DER SHA-256 ✓
 *          （这是"两侧算法一致"的**唯一**证明 ✓ —— 之前只有"两边各自的代码都在"✗，没有"两边相等"✗）。
 *    ★★ round 174（2026-09-28）从 40 抬到 **41** ✓ —— 补的是**地址归一化 + P1b 切换桥**：
 *      真机报"改地址填裸域名打不开"（实测那条是 `/` 的 401 ✓ —— 壳此前"输什么加载什么"✗）
 *      ⇒ 归一化抽成零依赖纯类 `MobileUrl` ✓、两个入口共用 `loadHostUrl` ✓、新增 `switchHost` 桥 ✓。
 *      三者任一不在包里，症状都是**静默失败**（地址打不开 ✗ / 面板那颗按钮永远不出现 ✗）⇒ 只能靠 dex 判 ✓。
 *    ★★ **保活轮**（2026-09-28）从 41 抬到 **49** ✓ —— 补的是用户报的**"退出 App 就断联"**✗
 *      （方案见 `25-壳侧保活与通知-勘察与方案.md` §4.2 B′ ✓）：**前台服务（`specialUse` ✓）**
 *      + **根返回改成 `moveTaskToBack(true)`** ✓ + **原生时钟用 `evaluateJavascript` 驱动网页心跳** ✓。
 *      八条新的（每一条都能被打红 ✓，逐条写在各段注释里 ✓）：
 *        · 权限白名单 +2 ✓（两条 **一起**断言在不在 ✓ —— 少了任一条 `startForeground()` 直接抛
 *          `SecurityException` ⇒ 服务当场死 ✓，而**没有任何界面差异** ✗）；
 *        · `KeepAliveService` 在清单里且 `exported=false` ✓；
 *        · `foregroundServiceType` **恰好**是 `specialUse` 的位掩码 `0x40000000` ✓
 *          （targetSdk 34+ 缺它 ⇒ `MissingForegroundServiceTypeException` ✗）；
 *        · `specialUse` 的 `<property …PROPERTY_SPECIAL_USE_FGS_SUBTYPE…>` 子元素 ✓；
 *        · dex：服务本体（`KeepAliveService` + `startForeground` + `NotificationChannel` + 渠道 id ✓）；
 *        · dex：★ **`moveTaskToBack`** ✓ —— **本轮最值钱的一条** ✗（少了它按返回仍然销毁 WebView
 *          ⇒ "退出 App 就断联"原样存在 ✓，而且**没有任何报错** ✗）；
 *        · dex：原生时钟的注入入口 `__DSH_MOBILE_BOOT__` + 网页→原生状态桥 `setKeepAliveState` ✓
 *          + 纯逻辑类 `KeepAlivePolicy` ✓（"它算得对不对"归 `scripts/check-keepalive.mjs` **真跑** ✓）；
 *        · 常驻通知的四条文案资源 ✓（`keepalive_*` ✓ —— 那是用户**唯一**能看见保活的地方 ✓）。
 *      ⚠️⚠️ 这里**故意不写** `FOREGROUND_SERVICE_TYPE_SPECIAL_USE` 这个 dex 判据 ✗（虽然它看起来很该有 ✓）：
 *        它是 `static final int` **编译期常量** ⇒ javac 直接内联成字面量 `1073741824` ✓
 *        （本机实证：`javap -c` 出来是 `ldc // int 1073741824` ✓，无 `getstatic` ✓；
 *          再用 d8 打成 dex 后 `strings classes.dex | grep FOREGROUND_SERVICE` **零命中** ✓）
 *        ⇒ dex 的字符串表里**根本没有这个名字** ✗ ⇒ 拿它当判据只会得到一条
 *        "实现完全正确也**永远红**"的假断言 ✗（比没有断言更糟 ✓）。
 *        ★ 类型的判据在**清单**那边 ✓（`foregroundServiceType=0x40000000` ✓）—— 那也正是安卓自己读的地方 ✓。
 */
const EXPECTED_MIN_CHECKS = 51
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
    // ★★ 保活轮新加的**两条** ✗ —— 与上面 CAMERA 那段同一个口径 ✓（"为什么非加不可"写在
    //   `native/android/AndroidManifest.xml` 里那两条权限上方的注释里 ✓，改之前先读那一段 ✓）：
    //   · `FOREGROUND_SERVICE` —— API 28 起，**任何**前台服务都要它 ✓
    //     （★ 它是最容易被漏掉的一条 ✗：讲安卓 14 的文章只讲"类型权限"✓，
    //      而少了它 `startForeground()` 直接抛 `SecurityException` ✗ ⇒ 服务当场死 ✓）；
    //   · `FOREGROUND_SERVICE_SPECIAL_USE` —— `specialUse` 这个类型自己的权限 ✓
    //     （API 34 起，类型权限与清单里的 `foregroundServiceType` **必须成对** ✓）。
    //   两条都是**普通权限**（安装即授予 ✓、不弹框 ✓）⇒ 不改变"用户要授权什么"这件事 ✓；
    //   它们**不是**可选的增强 ✗ —— 前台服务在安卓上没有别的写法 ✓（本地取证见 doc 25 §7.1 ✓）。
    'android.permission.FOREGROUND_SERVICE',
    'android.permission.FOREGROUND_SERVICE_SPECIAL_USE',
  ]
  const unexpected = permissions.filter((name) => !allowedPermissions.includes(name))
  check(
    unexpected.length === 0 && permissions.includes('android.permission.INTERNET'),
    '权限只有 INTERNET + POST_NOTIFICATIONS + CAMERA + FOREGROUND_SERVICE + FOREGROUND_SERVICE_SPECIAL_USE（没有存储/定位/通讯录等 ✗）',
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
  /**
   * ★★ 保活轮：**前台服务那两条权限必须真的在清单里** ✗（与上面那条 CAMERA 同一个理由 ✓）。
   *
   * 上面那条白名单管的是"**没有多出别的**"✓，这一条管的是"**这两条必须在**"✗ ——
   * 两条方向相反 ✓，缺一条都会漏：
   *   · 少了白名单那条 ⇒ 有人偷偷加权限没人管 ✗；
   *   · 少了这一条 ⇒ 有人**把前台服务权限删掉**（比如嫌它破坏"只有三条"的旧约定 ✓），
   *     `aapt2` 那边一声不响 ✓，装到手机上表现为：`FOREGROUND_SERVICE` 少了 ⇒
   *     `startForeground()` 抛 `SecurityException` ✓；类型权限少了 ⇒ 抛
   *     `SecurityException: Starting FGS with type specialUse … requires permissions` ✓
   *     —— 两种都是**服务当场就死、一点保活都没有** ✗，
   *     而界面上与"后台保活这件事完全没做"**一模一样** ✗（不崩、不弹、只是照旧断联 ✓）。
   * ★ 两条**一起**断言 ✓（它们是一对 ✓：一条是 API 28+ 的硬要求 ✓、一条是 API 34+ 的 ✓，
   *   在 targetSdk=35 上只写一条照样起不来 ✗）。
   */
  const keepAlivePermissions = ['android.permission.FOREGROUND_SERVICE', 'android.permission.FOREGROUND_SERVICE_SPECIAL_USE']
  const missingKeepAlivePermissions = keepAlivePermissions.filter((name) => !permissions.includes(name))
  check(
    missingKeepAlivePermissions.length === 0,
    '带 FOREGROUND_SERVICE + FOREGROUND_SERVICE_SPECIAL_USE（★ 前台服务的**两条**硬要求 ✓ —— 少了任何一条，startForeground() 直接抛 SecurityException ⇒ 服务当场死、一点保活都没有 ✗，而手机上只表现为"照旧断联"✗、完全没有报错 ✓）',
    missingKeepAlivePermissions.length === 0
      ? keepAlivePermissions.map((name) => name.replace('android.permission.', '')).join(' + ')
      : `缺 ${missingKeepAlivePermissions.join('、')}`,
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
  /**
   * ★★ 保活轮：**前台服务真的在清单里、而且声明对了** ✗（用户报的"退出 App 就断联"✓ 的第一半 ✓）。
   *
   * 三件事在同一个 `E: service` 块里**逐一**断言 ✓（照上面 ScanActivity 那段的取法 ✓ ——
   * 先把名字定位到，再回溯到最近的 `E: service` ✓，**不用整份清单做子串匹配** ✗：
   * 那样别处出现同名字符串也算过 ✓）。缺哪一件都是**静默失败** ✗：
   *
   *   ① **注册了 + `exported=false`** ✓：没注册 ⇒ `startForegroundService()` 抛
   *      `IllegalArgumentException` ✗（用户那边只是"保活没生效"✗，没有画面差异 ✓）；
   *      `exported` 不为 false ⇒ 任何应用都能拉起我们的保活服务 ✗
   *      （它不是外部入口 ✓ —— 外面没有任何入口 ✓）；
   *
   *   ② **`foregroundServiceType` 恰好是 `specialUse`** ✓：targetSdk 34 起（本包 35 ✓）
   *      不声明类型 ⇒ `startForeground()` 抛 `MissingForegroundServiceTypeException` ✗；
   *      声明成别的类型则是**另一套前置条件** ✗（`dataSync` 还有"后台累计 6 小时"的时限 ✓、
   *      `connectedDevice` 会连带要求网络状态类权限 ✓ ⇒ 破坏"最小权限"纪律 ✗ ——
   *      见 doc 25 §7.1 的官方取证 ✓）。
   *      ★ 这里刻意**不**比对字符串 `specialUse` ✗ —— 清单里存的是**位掩码** ✓
   *      （aapt2 在 link 期就把这个 flag 编译成整数了 ✓，产物里的渲染形态与
   *        `configChanges=0x00000fa0` 同形 ✓）；`0x40000000 = 1073741824` 由
   *        `javap -constants ~/Library/Android/sdk/platforms/android-35/android.jar` 实证 ✓
   *        （`FOREGROUND_SERVICE_TYPE_SPECIAL_USE = 1073741824` ✓，同处还有
   *         `…_DATA_SYNC = 1` ✓ `…_CONNECTED_DEVICE = 16` ✓ —— 拿来当反例 ✓）；
   *
   *   ③ **`<property android:name="android.app.PROPERTY_SPECIAL_USE_FGS_SUBTYPE" …>` 子元素** ✓：
   *      这是官方对 `specialUse` 的**规范要求** ✓（少了它类型声明不完整 ✓）。
   *      判据取 `E: property` + 那个长名字 + 值 ✓，三个都必须在**服务块内** ✓。
   */
  {
    const at = manifestTree.indexOf('.KeepAliveService')
    const start = at < 0 ? -1 : manifestTree.lastIndexOf('E: service', at)
    const after = at < 0 ? -1 : manifestTree.indexOf('E: service', at)
    const block = start < 0 ? '' : manifestTree.slice(start, after < 0 ? manifestTree.length : after)
    check(
      block !== '' && /exported\([^)]*\)=false/.test(block),
      '清单里注册了 KeepAliveService 且 exported=false（前台服务本体 ✓ —— 没注册就是 startForegroundService() 抛 IllegalArgumentException ✗；exported 不为 false 则任何应用都能拉起它 ✗；两种在手机上都没有画面差异 ✗）',
      block === '' ? '清单树里没有 .KeepAliveService ✗' : (/android:name\([^)]*\)="[^"]*"/.exec(block)?.[0] ?? '').trim(),
    )
    /**
     * ★ `aapt2 dump xmltree` 把整数属性渲染成 `=0x…` ✓（与产物里 `configChanges=0x00000fa0` 同形 ✓），
     *   但**没有**任何文档保证它永远是十六进制 ✗ ⇒ 这里两种写法都认 ✓（`0x…` / 十进制 ✓）。
     *   判据仍然落在**一个确定的整数**上 ✓ —— 不是"含 `0x40000000` 这几个字符"✗
     *   （那种子串判据会被 `0x400000000`、或者别的属性里的同形数字喂饱 ✓）。
     */
    const SPECIAL_USE_MASK = 1073741824 // = 0x40000000 = ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE ✓（javap 实证 ✓）
    const parseManifestInt = (raw) => {
      const token = String(raw ?? '').replace(/^\(type 0x[0-9a-fA-F]+\)/, '').trim()
      if (/^0x[0-9a-fA-F]+$/.test(token)) return Number.parseInt(token.slice(2), 16)
      if (/^-?\d+$/.test(token)) return Number.parseInt(token, 10)
      return Number.NaN
    }
    const typeMask = parseManifestInt(/foregroundServiceType\([^)]*\)=(\S+)/.exec(block)?.[1])
    check(
      typeMask === SPECIAL_USE_MASK,
      '★ 清单里 KeepAliveService 的 foregroundServiceType 是 specialUse（位掩码 0x40000000 ✓ —— targetSdk 34+ 缺它 ⇒ startForeground() 抛 MissingForegroundServiceTypeException ✗，服务起不来、一点保活都没有 ✓，而手机上不崩不报 ✗）',
      block === ''
        ? '清单树里没有 .KeepAliveService ✗'
        : Number.isNaN(typeMask)
          ? '没有 foregroundServiceType 这一项 ✗'
          : `0x${(typeMask >>> 0).toString(16)}${typeMask === SPECIAL_USE_MASK ? '（specialUse ✓）' : '（不是 specialUse ✗ —— specialUse 是 0x40000000 ✓）'}`,
    )
    const hasPropertyElement = /E: property/.test(block)
    const hasPropertyName = block.includes('PROPERTY_SPECIAL_USE_FGS_SUBTYPE')
    const hasPropertyValue = block.includes('lan-tunnel-keepalive')
    const missingProperty = [
      hasPropertyElement ? null : 'E: property 子元素',
      hasPropertyName ? null : 'android.app.PROPERTY_SPECIAL_USE_FGS_SUBTYPE',
      hasPropertyValue ? null : 'android:value="lan-tunnel-keepalive"',
    ].filter(Boolean)
    check(
      block !== '' && missingProperty.length === 0,
      '★ 服务里有 specialUse 的子类型声明（`<property android:name="android.app.PROPERTY_SPECIAL_USE_FGS_SUBTYPE" android:value="lan-tunnel-keepalive" />` ✓ —— 官方对 specialUse 的规范要求 ✓，少了它类型声明不完整 ✗）',
      block === ''
        ? '清单树里没有 .KeepAliveService ✗'
        : missingProperty.length === 0
          ? 'PROPERTY_SPECIAL_USE_FGS_SUBTYPE = lan-tunnel-keepalive ✓'
          : `缺 ${missingProperty.join('、')}`,
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
  /**
   * ★★ 保活轮：**常驻通知的四条文案资源也在包里** ✓。
   *
   * 与上面两条同一个理由 ✓（少一个 `R.string.*` 编译期就红 ✓ —— 所以这条防的是
   * "资源被 aapt2 的拆分/裁剪弄丢"✓：那时 `classes.dex` 一个字节不变 ✗、图标也都在 ✓，
   * 只有界面上显示成一串资源 id ✗）。
   * ★ 为什么这里比上面两条更要紧 ✗：**常驻通知是用户唯一能看见"保活到底有没有在跑"的地方** ✓
   * （App 退到后台之后，界面上什么都没了 ✓）—— 它变成一串 `2131…` 的话，
   * 用户看到的就是一条**看不懂的通知** ✓，而"保活到底生效没有"也就无从判断了 ✗。
   * 四条各管一件事 ✓：
   *   · `keepalive_channel` / `keepalive_channel_desc` —— 通知渠道的名字与说明 ✓
   *     （安卓 8+ 的通知必须挂在渠道上 ✓；渠道文案就是系统设置里用户能翻到的那一行 ✓）；
   *   · `keepalive_title` —— 常驻通知的**标题** ✓（"保持连接" ✓）。
   *     ★ 订正（2026-09-28 主线对着实现核过 ✓）：这里原先写的是"常驻通知的**正文**"✗ ——
   *     实现里**正文**是那三条状态文案 `keepalive_state_connected` /
   *     `keepalive_state_connecting` / `keepalive_state_reconnecting` ✓
   *     （`KeepAliveService` 按 `setKeepAliveState` 报上来的状态切 ✓），
   *     `keepalive_title` 只当标题 ✓。★ 那三条状态文案**故意不列进下面这张名单** ✗：
   *     它们的条数会随状态机长（现在 3 条 ✓），钉死条数就会变成"实现加一态、验收就红"的假断言 ✗ ——
   *     名单只管"**少了就一定出问题**"的那几条 ✓。
   *   · `keepalive_exit` —— ★ **通知上那个「真的退出」动作** ✓：保活轮把根返回改成了
   *     `moveTaskToBack(true)` ✓ ⇒ "真的退出"**必须另给出口** ✗，就是通知上这颗按钮 ✓
   *     （少了它的文案，那个动作在手机上就是一颗没有字的按钮 ✗）。
   */
  const wantedKeepAlive = ['string/keepalive_channel', 'string/keepalive_channel_desc', 'string/keepalive_title', 'string/keepalive_exit']
  const missingKeepAlive = wantedKeepAlive.filter((name) => !resources.includes(name))
  check(
    missingKeepAlive.length === 0,
    '保活的文案资源在包里（`keepalive_channel` 渠道名 + `keepalive_channel_desc` 渠道说明 + `keepalive_title` 常驻通知**标题** + `keepalive_exit` 通知上那颗「真的退出」✓ —— 少了任何一条，手机上就是"通知里显示一串资源 id"✗，而常驻通知正是用户唯一能看见保活的地方 ✓）',
    resources === '' ? '读不出资源表 ✗' : (missingKeepAlive.length === 0 ? wantedKeepAlive.join('、') : `缺 ${missingKeepAlive.join('、')}`),
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
   * ★ 地址归一化 + P1b 切换桥（round 174，**用户真机验收报回来的** ✓）。
   *
   * 起因：用户往「改地址」里输 `https://10.34.255.229:3443`（**裸域名** ✓）打不开 ✗ ——
   * 实测那条返回 **401** ✓（`dsh web authentication required; …` ✓）：壳此前是
   * **你输什么就加载什么** ✗（只补 scheme ✓、不补路径 ✗）⇒ 落到 DSH 的**电脑版**根路径 ✓。
   * 修法是把归一化抽成零依赖纯类 `MobileUrl` ✓（`normalize()` ✓：空路径或单个 `/` ⇒ 补
   * `/mobile/app` ✓；明确路径原样尊重 ✗），两个入口（地址框 / `switchHost` 桥）**共用**
   * `loadHostUrl` ✓。
   *
   * 这一条同样是**静默失败** ✗：`MobileUrl` 不在包里 ⇒ 地址框与切换按钮**当场抛**
   * （`NoClassDefFoundError` ✓，用户只看到"打不开"✗）；`switchHost` 不在包里 ⇒
   * 网页侧探不到那条桥 ✓ ⇒ 面板**刻意不画按钮** ✓（这是设计 ✓，但也意味着
   * "新的 APK 装上去却什么都没有" ✗）—— 两种都只能在 dex 里判 ✓。
   */
  const hostUrlFix = ['MobileUrl', 'switchHost', 'loadHostUrl', 'PinStore']
  check(
    hasAll(hostUrlFix),
    '地址归一化 + 切换桥 + 按台各存一份的 CA pin 都在 dex 里（`MobileUrl` + `switchHost` + `loadHostUrl` + `PinStore` ✓ —— 少了归一化，改地址填裸域名仍会落到 `/` 的 401 ✗；少了 `switchHost`，面板那颗「切到这台」永远不出现 ✗；少了 `PinStore`，「从 Windows 切回 Mac」会被单值 pin 判成"指纹不一致"✗，而且手机上只表现为"连不上"✗）',
    missing(hostUrlFix).length === 0 ? hostUrlFix.join('、') : `缺 ${missing(hostUrlFix).join('、')}`,
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
  /**
   * ★★ C2 第 ④ 组：**指纹"写法"契约的一半** —— 壳里那条**归一化流水线**必须在 ✓。
   *
   * 为什么非有不可 ✗：宿主发的是 Node 的 `X509Certificate.fingerprint256` ✓
   * = **冒号十六进制、95 字符** ✓（见 `tls-cert.ts` 的 `certFingerprint` ✓）；
   * 而壳自己算出来的是**纯十六进制 64 字符** ✓（`caFingerprintOf` 手写转换 ✓）。
   * 两边**写法本来就不同** ✓，靠的是壳先 `normalizeFingerprint` 去冒号 + 大写 ✓，
   * 再过一道 `length() != 64` 的闸门 ✓（见 `rememberTicketCaFingerprint` ✓）。
   *
   * ⇒ 少了归一化，带冒号的值长度是 **95** ✗ ⇒ 闸门把它判成"**旧宿主**"✗
   *   ⇒ `expectedCaFingerprint = null` ✗ ⇒ **每一次**首次连接都退化成
   *   "弹指纹让用户确认"✓ —— 不崩、不报错、只是**静默降级** ✗。
   *   用户看到的是"新 APK 怎么每次都问我"✓，而**电脑上完全看不出来** ✗（真机上才现形 ✓）。
   *
   * ★ 这一组与后面的"指纹契约（可执行交叉验证）"是**一对** ✓：
   *   这里证明"归一化在产物里"✓，那里证明"归一化之后两侧真的相等"✓。
   */
  const fpNormalize = ['normalizeFingerprint', 'caFingerprintOf', 'formatFingerprintGroups']
  check(
    hasAll(fpNormalize),
    '★★ 指纹的归一化流水线在 dex 里（`normalizeFingerprint` 去冒号+大写 ✓ + `caFingerprintOf` 手写 64 位十六进制 ✓ + `formatFingerprintGroups` 人眼分组 ✓ —— 少了归一化，宿主那串带冒号的指纹会被当成"旧宿主" ⇒ 首次连接**每次都退化成人工确认** ✗，而手机上只表现为"怎么老问我"，电脑上完全看不出来 ✗）',
    missing(fpNormalize).length === 0 ? fpNormalize.join('、') : `缺 ${missing(fpNormalize).join('、')}`,
  )

  /**
   * ★★ 保活轮 第 ① 组：**前台服务本体真的进了包** ✓（用户报的"退出 App 就断联"✗）。
   *
   * 为什么只能靠 dex 符号判 ✗：与本文件其它几组同病 ✓ —— 服务没起来**不崩不报** ✗
   * （没有常驻通知、没有保活 ✓），而"源码改了、装出去的还是旧 APK"✗ 在手机上
   * 与"这段代码压根没写"**长得一模一样** ✗（本项目反复吃过这一类事故 ✓，见 `05` §73 ✓）。
   *
   * 四个符号各管一件事 ✓：
   *   · `KeepAliveService` —— 服务类真的进了 dex ✓（少了它 `startForegroundService()`
   *     抛 `ClassNotFoundException`/`IllegalArgumentException` ✗）；
   *   · `startForeground` —— ★ 它才是"前台服务"这个身份的来源 ✗：只 `startService()`
   *     不算常驻 ✓（进程照样被回收 ✗）；
   *   · `NotificationChannel` —— 安卓 8+ 的通知必须挂在渠道上 ✓（本包 minSdk 29 ✓）：
   *     不建渠道 ⇒ 那条通知**根本不会显示** ✓ ⇒ 用户看不到"保活在跑"、也**没有出口** ✗；
   *   · `dshm-keepalive` —— 渠道 id ✓（契约里钉死的名字 ✓）。
   *     ★ 它是**字符串字面量** ✓（渠道 id 只能是 Java 常量 ✓ 没有资源化的写法 ✓）。
   *
   * ⚠️⚠️ **别把 `FOREGROUND_SERVICE_TYPE_SPECIAL_USE` 写成 dex 判据** ✗ ——
   *   它是 `static final int` **编译期常量** ✓ ⇒ javac **直接内联**成字面量 `1073741824` ✓
   *   （本机实证：`javap -c` 得到 `ldc // int 1073741824` ✓、**没有** `getstatic` ✓；
   *    再用 `d8 --release --min-api 29` 打成 dex 后 `strings classes.dex | grep FOREGROUND_SERVICE`
   *    **零命中** ✓，而同一份 dex 里 `Landroid/app/NotificationChannel;` 与 `dshm-keepalive` 都在 ✓）
   *   ⇒ dex 的字符串表里**根本没有这个名字** ✗ ⇒ 拿它当判据只会得到一条
   *   "实现完全正确也**永远红**"的假断言 ✗（比没有断言更糟 ✓：下一个人会去改实现 ✗）。
   *   ★ 类型的判据在**清单**那边 ✓（`foregroundServiceType=0x40000000` ✓）——
   *     那也正是安卓自己读的地方 ✓。
   *
   * ★★ 这是**一类**坑，不是一条 ✗ —— 判据里凡是"`static final` 的基本类型常量"，
   *   都要先问一句"它会不会被 javac 内联掉"✓。本轮实测同一份 dex 里：
   *     · `FOREGROUND_SERVICE_TYPE_SPECIAL_USE` ✗ 不在（`static final int` ⇒ 内联 ✓）；
   *     · `IMPORTANCE_LOW` ✗ 不在（**同上** ✓ —— `NotificationManager.IMPORTANCE_LOW` 也是常量 ✓）；
   *     · `1002`（通知 id ✗）不在（整数常量编在 **code item** 里 ✓，字符串表根本不收 ✓）。
   *   ⇒ 反过来说，**能**当判据的是这三类 ✓：类/方法名 ✓（`KeepAliveService` ✓ `startForeground` ✓
   *     `NotificationChannel` ✓ `moveTaskToBack` ✓）、**字符串字面量** ✓（`dshm-keepalive` ✓
   *     `__DSH_MOBILE_BOOT__` ✓）、以及本文件其它组用的那些字符串常量 ✓。
   *   ★ 验证办法（30 秒 ✓、不用装手机 ✓）：对**产物**跑一遍
   *     `strings classes.dex | grep -F '<你要加的符号>'` ✓ —— 不在就先怀疑内联 ✓，别急着改实现 ✗。
   */
  const keepAliveForeground = ['KeepAliveService', 'startForeground', 'NotificationChannel', 'dshm-keepalive']
  check(
    hasAll(keepAliveForeground),
    '★★ 前台服务本体在 dex 里（`KeepAliveService` ✓ + `startForeground` ✓ + `NotificationChannel` ✓ + 渠道 id `dshm-keepalive` ✓ —— 少了它就没有常驻、没有保活 ✗，而手机上**不崩不报**、只是"退出 App 就断联"原样存在 ✗）',
    missing(keepAliveForeground).length === 0 ? keepAliveForeground.join('、') : `缺 ${missing(keepAliveForeground).join('、')}`,
  )
  /**
   * ★★ 保活轮 第 ② 组：**根返回改成了 `moveTaskToBack(true)`** ✓
   *   —— **本轮最值钱的一条断言** ✗（它守的是那条最难查的失败 ✓）。
   *
   * 因果链（一个字都不许省 ✓）：用户报的是**"退出 App 就断联"**✗ —— 而"退出"在他那里
   * 就是**按一下返回** ✓。壳此前在"没有可返回的东西"时**直接 `finish()`** ✗
   * ⇒ Activity 销毁 ⇒ **WebView 连同隧道一起拆掉** ✗ ⇒ 断联 ✓
   * （前台服务还活着 ✓、通知还挂着 ✓，但**页面已经没了** ✗ —— 这正是"假活"✓）。
   * 改成 `moveTaskToBack(true)` 之后，返回只把**任务**移进后台 ✓，
   * Activity 与 WebView **都还在** ✓ ⇒ 隧道不断 ✓。
   *
   * 为什么这一条是静默失败里最难查的 ✗：少了它**没有任何报错** ✗（不崩、不弹、不写日志 ✓），
   * 用户看到的就是"怎么又断了"✓，而我们会先去怀疑 Doze / 网络 / 宿主 ✗ ——
   * 只有**真机 + 复现步骤**才抓得住 ✓。而在电脑上，唯一抓得住它的就是这一个符号 ✓。
   * ★ 判据刻意只有**一个**符号 ✓（不掺 `onBackPressed` / `handleBackPressed` 之类 ✗ ——
   *   壳里那两处调用方改不改名都能满足判据 ✓，多写只会制造假红 ✓）。
   */
  const keepAliveBack = ['moveTaskToBack']
  check(
    hasAll(keepAliveBack),
    '★★ 根返回已改成 moveTaskToBack（`Activity.moveTaskToBack(true)` ✓ —— 少了它，按返回仍然 **finish() ⇒ 销毁 WebView ⇒ 拆掉隧道** ✗，"退出 App 就断联"原样存在 ✓，而且全程**没有任何报错** ✗，是本轮最难查的一类 ✓）',
    missing(keepAliveBack).length === 0 ? keepAliveBack.join('、') : `缺 ${missing(keepAliveBack).join('、')}`,
  )
  /**
   * ★★ 保活轮 第 ③ 组：**原生时钟的两端 + 那段纯逻辑** ✓。
   *
   * 前台服务保住的是"**进程还活着**"✓；页面里的心跳与轮询要接着跑，
   * 还得有人**按节拍推它** ✗（WebView 退到后台后 `setInterval` 会被限流 ✓ ⇒ 假活 ✓）。
   * 这一组就是那条链在产物里的三个落点 ✓：
   *   · `KeepAlivePolicy` —— 零 android 依赖的纯逻辑类 ✓（节拍 ✓ / `tickExpression(String)` ✓ /
   *     `parseState(String)` ✓）。"它**算得对不对**"归 `scripts/check-keepalive.mjs` **真跑** ✓，
   *     "它**在不在包里**"归这一条 ✓ —— 两者都在才叫"这段验过了"✓（分工口径见文件头 :38-40 ✓）。
   *     少了它 ⇒ `KeepAliveService` 当场 `NoClassDefFoundError` ✗ ⇒ 服务起不来 ✓；
   *   · `__DSH_MOBILE_BOOT__` —— ★ 原生注入网页的**唯一**约定入口 ✓
   *     （`window.__DSH_MOBILE_BOOT__.tick(kind)` ✓）。少了它（或者写成别的名字 ✗）
   *     ⇒ 原生时钟**空转** ✓：它照样每 15s/4s 调一次 `evaluateJavascript` ✓，
   *     但页面那边一个函数都没被调到 ✗ ⇒ **页面照旧被限流、照旧假活** ✗，
   *     而且**两侧都不报错** ✗（原生认为推过了 ✓、网页以为没人推 ✓）；
   *   · `setKeepAliveState` —— 网页 → 原生的状态回传桥 ✓（`DshmShell.setKeepAliveState(json)` ✓）。
   *     少了它 ⇒ 常驻通知永远显示同一个状态 ✗ ⇒ 用户没法一眼看出"到底还连着没有"✓
   *     （那正是本轮要解决的那件事 ✓），而**没有任何报错** ✗。
   */
  const keepAliveClock = ['KeepAlivePolicy', '__DSH_MOBILE_BOOT__', 'setKeepAliveState']
  check(
    hasAll(keepAliveClock),
    '★★ 原生时钟与状态桥在 dex 里（`KeepAlivePolicy` 纯逻辑 ✓ + 注入入口 `__DSH_MOBILE_BOOT__` ✓ + 状态回传 `setKeepAliveState` ✓ —— 少了入口，原生时钟**空转**、页面照旧被限流 ⇒ 假活 ✗；少了状态桥，常驻通知永远不反映"连没连上"✗；两种都不报错 ✓）',
    missing(keepAliveClock).length === 0 ? keepAliveClock.join('、') : `缺 ${missing(keepAliveClock).join('、')}`,
  )

  /**
   * ★ 原生首页这一套（2026-10-03 起）✓ —— 它现在还**没有被 MainActivity 调用** ✓，
   *   所以"文件在、但没进编译源集合"这种事故**不会有任何症状** ✗
   *   （首页永远空 / 永远"未知"，而手机上一个字都不报 ✓）⇒ 用这条断言把它钉住 ✓。
   *
   * 为什么逐个点符号 ✗：这条链上每一格都对应一种"看着像没网"的故障 ✓ ——
   * `HomeStore`（读壳身份库与端点槽 ✓ 少了它首页永远空 ✓）、
   * `HomeLoader`（探哪些/用哪张 CA ✓ 少了它没有任何状态 ✓）、
   * `ManifestProbe`（固定 CA 的那次探测 ✓）、
   * `HomePinSource`（每条地址该信哪张 CA ✓ 少了它"没 pin"会被当成"连不上"✓）、
   * `HomeEntry`（点智能体打开哪条地址 ✓ 少了它点了没反应 ✓）、
   * `HomeController`（合并/线程 ✓ 少了它可能连点就发起好几趟、或回调跑到后台线程 ✓）。
   */
  /**
   * ★ 底部标签那三颗矢量图（2026-10-03 用户点名改了图标 ✓）。
   *
   * 为什么值得断言 ✗：图标这种东西"文件在、却没进资源表 / 名字对不上 / 被换成另一张"
   * 在手机上只表现为"那颗图标不见了或长得不对"✗ —— 而这台的构建链是 aapt2 手写的 ✓，
   * 没有 Gradle 帮你兜住 ✓。这里连**路径数据**一起查 ✓：
   * 稿子（`docs/native/home-mock.html`）与包里那份必须是**同一份形状** ✓，
   * 否则就是"稿子好看、装机变样"这条最典型的翻车 ✓。
   */
  const tabIcons = [
    ['res/drawable/ic_tab_computer.xml', ['13.6', '19.4']],
    ['res/drawable/ic_tab_sessions.xml', ['20.6', '3.6']],
    ['res/drawable/ic_tab_settings.xml', ['5.6', '1.42']],
    // 页头那两颗（刷新 / 配对新电脑 ✓）—— 同样是"文件在、却没进资源表"就静默消失的那一类 ✓
    ['res/drawable/ic_action_refresh.xml', ['17.37', '19.6,12']],
    ['res/drawable/ic_action_add.xml', ['12,5.5', '5.5,12']],
  ]
  let iconsOk = true
  let iconsDetail = ''
  for (const [member, needles] of tabIcons) {
    let body = ''
    try {
      body = unzip(member).toString('utf8')
    } catch (error) {
      iconsOk = false
      iconsDetail += `${member} 不在包里 ✗ `
      continue
    }
    // aapt2 会把矢量图编成二进制 XML ✓ —— 路径数据仍在字符串池里 ✓（实测可读 ✓）
    const printable = body.replace(/[^\x20-\x7e]/g, ' ')
    const missingNeedles = needles.filter((needle) => !printable.includes(needle))
    if (missingNeedles.length > 0) {
      iconsOk = false
      iconsDetail += `${member} 少了路径数据 ${missingNeedles.join('/')} ✗ `
    } else {
      iconsDetail += `${member.split('/').pop()} ✓ `
    }
  }
  check(
    iconsOk,
    '★ 首页那五颗矢量图在包内且形状与设计稿一致（底部三颗：`ic_tab_computer` 显示器 ✓ / `ic_tab_sessions` 对话气泡 ✓ / `ic_tab_settings` 齿轮——★ 齿必须**咬着环** ✗，留缝在 22px 下看起来是"太阳"☀，第一版就是这么翻的 ✓；页头两颗：`ic_action_refresh` 刷新 ✓ / `ic_action_add` 加号 ✓）',
    iconsDetail.trim(),
  )

  // ★ 一句**特有**的话：只有 HomeLabels 会产出它 ✓ ——
  //   它同时证明"那个类真的进了包"✓ 与"那两类未知没有被合并成一句"✓
  /**
   * ★ 注意：`dexText` 是 `latin1` 解的 ✓ —— 拿它查 ASCII 没问题 ✓（既有的断言全是 ASCII ✓），
   *   但**查中文一定查不到** ✗（中文在 dex 里是 MUTF-8 三字节 ✓，latin1 解出来是乱码 ✓）。
   *   ⇒ 查中文要**另解一份 utf8** ✓（BMP 内的字符 MUTF-8 与 UTF-8 一致 ✓）。
   */
  const dexUtf8 = dexBytes.toString('utf8')
  check(
    dexUtf8.includes('没有它的证书'),
    '★ 「未知（没有它的证书）」这句特有的字在 dex 里（它区分了"没探到"与"没配对过"✓）',
  )

  const nativeHome = [
    'HomeStore',
    'HomeLoader',
    'ManifestProbe',
    'HomePinSource',
    'HomeEntry',
    'HomeController',
    'HomeWiring',
    'HomeView',
    'HomeTheme',
    // ★ 界面上的**每一句字**都在这里 ✓（视图里不许再有内联中文 ✗）——
    //   少了它，屏幕上那些字就没有任何断言守着 ✓
    'HomeLabels',
    'dsh-mobile.hosts',
  ]
  check(
    hasAll(nativeHome),
    '★★ 原生首页那一套在 dex 里（`HomeStore` 读壳身份库/端点槽 ✓ + `HomeLoader` 探哪些与用哪张 CA ✓ + `ManifestProbe` ✓ + `HomePinSource` ✓ + `HomeEntry` 点进哪条地址 ✓ + `HomeController` 合并与线程 ✓ + `HomeWiring` 接线 ✓ + `HomeView`/`HomeTheme` 视图与跟随系统的两套色 ✓ + 身份库键 `dsh-mobile.hosts` ✓ —— 少了任意一个，首页都会"永远空 / 永远未知 / 点了没反应"，而手机上**不报任何错** ✗；它们由 MainActivity 在 onCreate 里装上 ✓）',
    missing(nativeHome).length === 0 ? nativeHome.join('、') : `缺 ${missing(nativeHome).join('、')}`,
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

// ── ⑤ ★★ 指纹契约：**两侧算法一致**的**可执行**交叉验证（宿主 ↔ 壳）
//
// 上面第 ④ 组（dex）证明了"归一化流水线在产物里" ✓；第 ③/④ 条证明了"这台电脑的链自洽" ✓。
// 但**没有**任何一条断言证明：**宿主真正发出去的那串值，经壳的规则归一化之后，
// 正好等于壳自己算出来的那串** ✗ —— 而那正是 `expected.equals(actual)` 能成立的**唯一条件** ✓。
//
// 这里把两侧的算法**都在这台电脑上真跑一遍**：
//   · 宿主侧：Node 的 `X509Certificate.fingerprint256` ✓（= 票据里那个 `caFingerprint` ✓）；
//   · 壳侧：`MainActivity.normalizeFingerprint` 的规则 —— **保留 hex 字符、丢掉其余、全部大写** ✓；
//   · 再用**独立算的** SHA-256（直接对 DER 摘要 ✓）交叉验证，避免"两边一起错"✗。
//
// 它不成立时的表现（也正是它值得存在的理由 ✓）：不会崩、不会报错 ✗，
// 只是 TOFU 从"自动按指纹比对"**静默降级**成"每次都弹框让用户确认" ✓ —— **只在手机上现形** ✗。
// ★★ 取"宿主那一侧的值"必须用**宿主自己的实现** ✓ —— **不许在本脚本里重写一遍** ✗。
//   理由（这条断言的全部意义所在 ✓）：如果重写一遍，那么将来 `tls-cert.ts` 换了算法，
//   本断言**照样绿** ✗ ⇒ 它就成了"看着像在测宿主、其实在测我自己"✗（假绿 ✓）。
//   所以这里 `import` 宿主构建产物里的 `ensureTlsMaterial` ✓ —— 它返回的 `status.caFingerprint`
//   就是**进票据的那个值** ✓（`tls-cert.ts:395` ✓），因此**变异敏感** ✓。
//   刻意在**临时目录**里生成一张 CA（**不碰这台电脑的证书** ✓）：指纹是对 DER 求的 ✓，
//   与"用哪一张 CA"无关 ✓ —— 要证的是**两侧算法一致** ✓。
const hostTlsLib = join(repoRoot, 'packages', 'host', 'lib', 'tls-cert.js')
if (!existsSync(hostTlsLib)) {
  console.log('  · （跳过指纹契约交叉验证：还没有 packages/host/lib ✓ —— 先跑 npm run build）')
} else {
  const contractDir = mkdtempSync(join(tmpdir(), 'dshm-fp-'))
  let contractOk = false
  let contractNote = ''
  try {
    const { ensureTlsMaterial } = await import(pathToFileURL(hostTlsLib).href)
    const status = ensureTlsMaterial({ directory: contractDir })
    const hostStyle = status.caFingerprint // ★ 宿主实现算出来的那一串（= 进票据的那一串 ✓）
    const caPem = readFileSync(join(contractDir, 'lan-ca.pem'), 'utf8')
    const independent = createHash('sha256').update(new X509Certificate(caPem).raw).digest('hex').toUpperCase()
    const shellStyle = String(hostStyle ?? '').replace(/[^0-9A-Fa-f]/g, '').toUpperCase() // 壳的归一化规则
    /**
     * ★★ 判据刻意**窄**（不宽 ✗）：只要求"**经壳的规则之后两侧相等、且长度 64**"✓。
     *
     * 为什么**不**要求"宿主必须发带冒号的"✗：那是宿主的**写法**，不是契约 ✗ ——
     * 壳的归一化是"去掉所有非 hex 字符"✓，它对**带冒号 / 不带冒号 / 小写**都能吃 ✓。
     * 若把 `includes(':')` 也写进判据，将来宿主**合法地**改成不带冒号就会被误判成红 ✗
     * （这正是本项目反复强调的"**判据要窄**"✓：只在我们真的做错时才红 ✓）。
     * 冒号在不在，只作为**读数**写进 detail ✓。
     */
    contractOk = hostStyle !== undefined && shellStyle.length === 64 && shellStyle === independent
    contractNote =
      `宿主实现给出 ${String(hostStyle ?? '(undefined)').length} 字符（${String(hostStyle ?? '').includes(':') ? '带冒号' : '无冒号'}）` +
      `⇒ 按壳的规则归一化后 ${shellStyle.length} 字符；与独立 SHA-256 ${shellStyle === independent ? '一致 ✓' : '**不一致** ✗'}`
  } catch (error) {
    contractNote = String(error?.message ?? error)
  } finally {
    rmSync(contractDir, { recursive: true, force: true })
  }
  check(
    contractOk,
    '★★ 指纹契约成立（**宿主实现**给的那串，经壳的归一化规则后 == 独立算的 CA DER SHA-256 ✓ —— 这是两侧算法一致的**可执行证明** ✓；不成立时 TOFU 只会静默降级成"每次都弹框让人确认"✗，电脑上完全看不出来 ✗，而用户会以为"这包怎么老问"✓）',
    contractNote,
  )
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
