#!/usr/bin/env node
/**
 * 把 dsh-mobile 的宿主插件安装进 DSH 的 web profile。
 *
 * 为什么需要这个脚本（而不是 `pnpm add`）：
 *   profile 用 `nodeLinker: hoisted`，插件必须**同时**满足两个条件才能在运行时被加载：
 *     1. 包本身出现在 `$DSH_HOME/profiles/web/node_modules/` 下；
 *     2. 其依赖 `@dsh-mobile/protocol` 也在同一层（hoisted 布局下 Node 逐级向上查找）。
 *   直接用 pnpm 从本地路径安装会把 workspace 链接进去，虽然开发时方便，
 *   但一旦中间目录被移动或删除，DSH 就会在生产启动时加载失败。
 *   因此这里**复制**构建产物，让 profile 自包含。
 *
 * 同时它会幂等地维护 `cordis.patch.yml` 中的一条 insert 条目，并做真实加载校验。
 *
 * 用法：
 *   node scripts/install-host-plugin.mjs            # 安装（默认 profile=web）
 *   node scripts/install-host-plugin.mjs --uninstall
 *   node scripts/install-host-plugin.mjs --profile web --dsh-home ~/.dsh
 *   node scripts/install-host-plugin.mjs --dsh-home ~/.dsh --listener \
 *     --listener-plain 0.0.0.0:3081 --listener-tls 0.0.0.0:3443   # C1：插件进程内监听
 */

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bootStamp, buildBootPayload } from './boot-payload.mjs'
/**
 * ★★ 配置的**推导与读写只有一处实现** ✓（2026-09-29 搬进共用模块）：
 *   `packages/host/src/setup-config.ts` ✓ —— 电脑上 DSH 页面里的
 *   `GET/POST /mobile/setup` 走的是**同一份** ✓。
 *
 * 为什么必须搬 ✗：同一件事曾经有两条上线路径各写一份（本脚本 ✓ / 页面路由 ✓），
 * 而"两份实现漂移"这亏本项目吃过 —— `boot.js` 那次就是手机拿到的那份没内联公式渲染器，
 * 而验收脚本全绿 ✗✓（极难查）。
 *
 * ★ 它是 `.ts`（宿主插件源码），由 Node 的**类型剥离**直接加载 ✓（engines ≥ 22.18 ✓）。
 *   ★ 那个模块是**纯函数、无副作用** ✗ ⇒ 这里静态 import 不会顺手把安装跑起来 ✓
 *     （反面教材：import 本脚本自己会执行 main() ✗）。
 * ★ 网络探测也随之改成 `./lan.ts` 那一份（同一套排序/排除规则 ✓，
 *   由 `packages/host/test/lan.test.ts` 钉住"两份结论必须相同" ✓）：
 *   插件被复制进 profile 之后 import 不到仓库里的 `scripts/` ✗，共用模块只能用包内那份 ✓，
 *   脚本跟着用它，才不会出现"脚本显示 A、页面写 B"这类只在真机上现形的分歧 ✗。
 */
import {
  derivePhoneEntry,
  normalizeBase,
  readPreservedKeys,
  readPreservedListener,
  removeBlock,
  renderConfigOnlyPatch,
  renderInsertPatch,
  resolveListener,
  resolvePatchConfig,
} from '../packages/host/src/setup-config.ts'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = dirname(here)

/** 解析命令行参数。 */
function parseArgs(argv) {
  const out = {
    profile: 'web',
    // ⚠️ **故意不读 `process.env.DSH_HOME`**：DSH 运行时会在环境里设 `DSH_HOME=~/.dsh`，
    //    于是任何"顺手读一下环境变量"的脚本都会指向**生产**。本项目为此真实出过两次事故
    //    （生产配置被写成测试端口、手机 403）。家目录只能由 `--dsh-home` 显式给出。
    dshHome: undefined,
    uninstall: false,
    skipVerify: false,
    trustedHosts: [],
    phoneBaseUrl: undefined,
    // 中继相关：这些**不是**每次安装都该重算的（不像 trustedHosts 随地址变），
    // 所以没给就沿用现有配置里的值——见 setup-config.ts 里 readPreservedKeys 的长注释。
    relayUrl: undefined,
    relayToken: undefined,
    relayHttpUrl: undefined,
    relayPoolSize: undefined,
    // ⚠️ `--extra-endpoint` 是**纯追加**语义：它只往里加候选端点，**命令行无法删除已存在的端点**。
    //    这是有意的取舍 —— 宁可多留一个死候选，也不愿"某次重装少传一个参数"就静默丢掉一条路
    //    （本项目为此已经发生过三次事故，见 readPreservedKeys 的长注释）。
    //    代价与运维办法：换中继域名后，旧域名会作为**死候选**留在列表里，手机每次重连会白试一次
    //    再回落 —— 表现为"多一次延迟"，不是"连不上"。**要删除端点请直接编辑 cordis.patch.yml**
    //    （删掉那一行后重装即可），别用"少传一个参数"表达删除。
    extraEndpoints: [],
    // C1：插件进程内的局域网监听（把 scripts/lan-proxy.mjs 搬进插件）。
    // 与中继那几项**同一类**：不是每次安装都该重算的，没给就沿用现有配置里的值
    // （见 readPreservedKeys 的长注释 —— "没传就静默删掉"正是本项目发生过三次的事故）。
    // `undefined` 表示"本次没表态"，由 setup-config.ts 的 resolveListener 按 命令行 > 现有配置 > 默认 解析。
    listener: undefined,
    listenerPlain: undefined,
    listenerTls: undefined,
    // ★ 改动 B：全新机器上"手机该连哪儿"的自动推导。
    //   `lanIp === undefined` ⇒ 本次没表态，走自动探测（setup-config.ts 里的 detectLanIp ✓，
    //   也即包内 lan.ts 那一份 —— 与页面路由**同一份** ✓）；
    //   给了值（含**空串**）⇒ 一律不再探测。空串是**测试用的注入点**：
    //   它表示"拿不到地址"，用来确定性地走"探测失败"那条路径（否则测试会依赖真机网络）。
    lanIp: undefined,
    // ★ 关掉自动推导，退回"什么都不写"的旧行为（给**已有配置**的机器用）。
    autoDetectLan: true,
    /**
     * ★★ `--config-only`：**只补机器专属配置，不装任何文件** ✓（2026-09-29 新增 ✓）。
     *
     * ## 为什么需要它 ✗（官方插件管理那条路的最后一块拼图 ✓）
     *
     * 走官方那条路时，**插件行由 bundle 自己插入** ✓（`@dsh-mobile/host` 自带的
     * `cordis.patch.yml` ✓），我们**不该**再写一条 `insert` ✗ —— 那会插出第二行 ✗。
     * 但 bundle **只给行、不给 config** ✓（config 属于"这台机器"：局域网 IP、端口、
     * 有没有 Tailscale ✓，写死在包里就是错的 ✓，见 `24` 号 §3.2 ✓）⇒
     * 官方装完 `listener.enabled=false`（默认 ✓）⇒ **手机连不上** ✗。
     *
     * ⇒ 这个模式就是补那一块 ✓：**同一份推导逻辑**（`patchBlock` ✓，命令行 > 现有配置 > 自动推导 ✓），
     *   只换 patch 的**形状** —— 从"`insert:` 一行"换成"按 `id` 覆盖 `config`" ✓
     *   （DSH 的合成器就是"后续层按 id 找到同一行、整块替换它的 config" ✓）。
     *
     * ★ 它**不装文件、不跑加载校验** ✗（那些事官方那条路已经做过了 ✓）。
     */
    configOnly: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--uninstall') out.uninstall = true
    else if (arg === '--config-only') out.configOnly = true
    else if (arg === '--skip-verify') out.skipVerify = true
    else if (arg === '--trusted-host') out.trustedHosts.push(argv[++i])
    else if (arg === '--clear-trusted-hosts') out.trustedHosts = []
    else if (arg === '--profile') out.profile = argv[++i]
    else if (arg === '--dsh-home') out.dshHome = argv[++i]
    else if (arg === '--phone-base-url') out.phoneBaseUrl = argv[++i]
    else if (arg === '--relay-url') out.relayUrl = argv[++i]
    else if (arg === '--relay-token') out.relayToken = argv[++i]
    else if (arg === '--relay-http-url') out.relayHttpUrl = argv[++i]
    else if (arg === '--relay-pool-size') out.relayPoolSize = argv[++i]
    else if (arg === '--extra-endpoint') out.extraEndpoints.push(argv[++i])
    else if (arg === '--listener') out.listener = true
    else if (arg === '--no-listener') out.listener = false
    else if (arg === '--listener-plain') out.listenerPlain = argv[++i]
    else if (arg === '--listener-tls') out.listenerTls = argv[++i]
    // ★ 改动 B：`--lan-ip` 是"显式指定手机该连的局域网地址"的**注入点**（跳过探测）；
    //   漏写值 ⇒ 空串 ⇒ 等同"探测失败"（见 derivePhoneEntry），不会静默退回真实探测。
    else if (arg === '--lan-ip') out.lanIp = argv[++i] ?? ''
    else if (arg === '--no-lan-autodetect') out.autoDetectLan = false
    else if (arg === '--help' || arg === '-h') {
      console.log(
        '用法: node scripts/install-host-plugin.mjs [--profile web] [--dsh-home ~/.dsh] ' +
          '[--trusted-host <authority>]... [--phone-base-url https://<ip>:<tls端口>] ' +
          '[--listener | --no-listener] [--listener-plain <host:port>] [--listener-tls <host:port>] ' +
          '[--lan-ip <本机局域网IP> | --no-lan-autodetect] ' +
          '[--config-only] [--uninstall] [--skip-verify]',
      )
      process.exit(0)
    }
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
/**
 * **必须显式指定家目录**（`--dsh-home` 或 `DSH_HOME`），没有默认值。
 *
 * ## 为什么把默认值去掉
 *
 * 这个脚本会**覆盖式**重写 `cordis.patch.yml`。原先它默认写 `~/.dsh`（通常是生产），
 * 于是一旦任何调用链没把家目录传对，它就会**直接改掉生产配置**——而配置是热加载的，
 * 线上几秒内开始 403，用户那边表现为"手机突然连不上了"。
 *
 * 本项目真的发生过两次（一次布局验收之后、一次我在测防护时）。第二次之后我放弃了
 * "靠比对路径来判断是不是默认家目录"的做法——那道闸没能拦住，而且**它本身没法安全地测试**
 * （要测它就得拿真生产配置当靶子）。
 *
 * 改成"没有默认值"就同时解决了两件事：
 *   · 漏传 = 直接拒绝运行（拒绝不写盘，所以这道闸**可以安全测试**）；
 *   · 想写哪儿必须写出来，配置来源一目了然。
 *
 * 合法调用方 `restart-lan.sh` 本来就一直显式传 `--dsh-home`。
 */
if (typeof args.dshHome !== 'string' || args.dshHome.length === 0) {
  console.error(
    '[install-host] 必须显式指定家目录：--dsh-home <路径>。\n' +
      '  本脚本会覆盖式重写该家目录下的 cordis.patch.yml，因此**故意不提供默认值**，\n' +
      '  以免某条调用链漏传时把生产配置改掉（真实事故，发生过两次）。\n' +
      '  维护这台电脑的配置：bash scripts/restart-lan.sh\n' +
      '  验收/测试请用专用目录：--dsh-home /tmp/xxx',
  )
  process.exit(2)
}

const profileDir = join(args.dshHome, 'profiles', args.profile)
const profileModules = join(profileDir, 'node_modules')
const patchFile = join(profileDir, 'cordis.patch.yml')

/**
 * 需要安装的包：插件本体、协议依赖，以及**预览桥**。
 *
 * 桥（`@dsh-mobile/bridge`）是 round 99 新增的 ✓：DSH 的文档预览能力在它的依赖注入
 * 容器里 ✗，而我们的注入脚本拿不到 `ctx` ✓ —— DSH 的模块加载器要求
 * 客户端 bundle 的注册**与宿主声明的 graph 行匹配** ✓，
 * 所以必须作为一个正式插件被声明（下面 patchBlock 里的第二个 insert ✓）。
 */
const PACKAGES = [
  { name: '@dsh-mobile/protocol', source: join(repoRoot, 'packages', 'protocol') },
  { name: '@dsh-mobile/host', source: join(repoRoot, 'packages', 'host') },
  { name: '@dsh-mobile/bridge', source: join(repoRoot, 'packages', 'bridge') },
]

/**
 * 本次调用的输入，喂给共用模块的 `SetupInput` ✓。
 *
 * ★ 这里**只做搬运**，不含任何判断 ✗ —— `命令行 > 现有配置 > 默认` 那套优先级
 *   全在 `packages/host/src/setup-config.ts` 里（本项目头号纪律：同一份推导只有一处实现 ✓）。
 *   `lanIp === undefined` ⇒ 本次没表态（走自动探测 ✓）；`''` ⇒ 拿不到地址（探测失败的注入点 ✓）。
 */
function setupInput() {
  return {
    lanIp: args.lanIp,
    autoDetectLan: args.autoDetectLan,
    phoneBaseUrl: args.phoneBaseUrl,
    relayUrl: args.relayUrl,
    relayToken: args.relayToken,
    relayHttpUrl: args.relayHttpUrl,
    relayPoolSize: args.relayPoolSize,
    extraEndpoints: args.extraEndpoints,
    listener: args.listener,
    listenerPlain: args.listenerPlain,
    listenerTls: args.listenerTls,
  }
}

/** 共用模块的日志出口：前缀仍是本脚本原来的 `[install-host]` ✓（逐字节不变 ✗）。 */
const io = { log, warn }

/**
 * 生成 patch 块。
 *
 * `trustedHosts` 必须与手机实际访问的 authority 一致：本插件注册的 /mobile 路由
 * 不受 DSH 的 /api 信任栅栏保护，因此它自己校验 Host/Origin（见 index.ts 的说明）。
 *
 * ★ 展开成 config 行的逻辑**一格都不在这里** ✗：`resolvePatchConfig`（取值优先级 ✓）
 *   与 `renderInsertPatch` / `renderConfigOnlyPatch`（缩进与形状 ✓）都在共用模块里 ✓。
 *   本函数只剩"选哪种形状 + 打那行 trust 日志"✓ —— 与页面的 `POST /mobile/setup`
 *   写出的 config 逐字相同 ✓（页面用同一个 renderer，只是不带 `name:` 那两行 ✓）。
 */
function patchBlock(trustedHosts, preserved, derived) {
  const { config, addedTrustedHosts } = resolvePatchConfig(trustedHosts, preserved, derived, setupInput())
  if (addedTrustedHosts.length > 0) log(`为 extraEndpoints 补了 ${addedTrustedHosts.length} 条 trust：${addedTrustedHosts.join('、')}`)
  return args.configOnly ? renderConfigOnlyPatch(config) : renderInsertPatch(config)
}

function log(message) {
  console.log(`[install-host] ${message}`)
}

/** ★ 警告走 **stderr**：调用方（部署脚本 / 测试）可以单独看它，且不 fail（见 warnNoPhoneEntry）。 */
function warn(message) {
  console.warn(`[install-host] 警告：${message}`)
}

function fail(message) {
  console.error(`[install-host] 错误：${message}`)
  process.exit(1)
}

/** 检查前置条件：profile 目录（缺了就**建**）、构建产物存在。 */
function preflight() {
  /**
   * ★ 改动 A：profile 目录不存在时**建出来**，不再 fail 退出。
   *
   * 原先这里要求 `profiles/<name>` 已存在，并提示"请先用该 profile 启动一次 DSH"✗ ——
   * **那句提示是错的** ✗：实测在全新 `DSH_HOME` 上跑 `dsh web`，DSH 正常起来，
   * 而且**并不会**创建这个目录（HOME 仍是空的）✓。也就是说 DSH 自己不需要它，
   * 是我们安装器多要求了一个目录 ✗，于是"换一台新电脑"的第一步就死在这里。
   *
   * 旁证 ✓：三个验收夹具（check-device-channel / check-mobile-layout / check-lan-listener）
   * 都各自 `mkdirSync(profiles/web, {recursive:true})` 手动建一次，然后插件就能被加载 ✓ ——
   * 它们本来就证明"手建就够"。这里把它变成安装器自己的职责 ✓。
   *
   * ⚠️ 下面那段**构建产物存在性**检查是另一回事，必须原样保留 ✗：
   *    它拦的是"没 build 就装"，装上的是半成品 —— 那个检查是对的 ✓。
   */
  if (!existsSync(profileDir)) {
    mkdirSync(profileDir, { recursive: true })
    log(
      `profile 目录不存在，已创建：${profileDir}` +
        `（DSH 自己不会建它；三个验收夹具也都是手建的）`,
    )
  }
  for (const pkg of PACKAGES) {
    const lib = join(pkg.source, 'lib')
    if (!existsSync(join(lib, 'index.js'))) {
      fail(
        `缺少构建产物：${lib}\n` +
          `        请先运行：pnpm --filter ${pkg.name} run build`,
      )
    }
  }
}

/** 复制包到 profile 的 node_modules（hoisted 布局：直接放在顶层）。 */
function installPackages() {
  mkdirSync(profileModules, { recursive: true })
  for (const pkg of PACKAGES) {
    const destination = join(profileModules, pkg.name)
    rmSync(destination, { recursive: true, force: true })
    mkdirSync(destination, { recursive: true })
    // 只复制运行时需要的文件：lib 与 package.json。
    // 刻意不复制 src 与测试，避免把开发期文件带进生产 profile。
    cpSync(join(pkg.source, 'lib'), join(destination, 'lib'), { recursive: true })
    cpSync(join(pkg.source, 'package.json'), join(destination, 'package.json'))
    log(`已安装 ${pkg.name} → ${destination}`)
  }

  // 浏览器端 boot.js：由宿主插件通过 tapIndex 注入 index.html，必须随宿主一起安装。
  // 它位于 client 包（浏览器侧产物），但由 host 包提供 HTTP 服务，
  // 因此安装时把它复制到 host 的 lib 目录下——cordis.ts 默认就在那里找它。
  const bootSource = join(repoRoot, 'packages', 'client', 'src', 'boot.js')
  const bootDestination = join(profileModules, '@dsh-mobile', 'host', 'lib', 'boot.js')
  if (!existsSync(bootSource)) fail(`缺少 boot.js：${bootSource}`)
  /**
   * ★ 安装时同样要跑**全部**载荷变换：构建戳 ✓ + **公式渲染器内联副本** ✓
   *   （都只在 `scripts/boot-payload.mjs` 实现 ✓，这里只管调用 ✓）。
   *
   * 两个坑都踩过：
   *   1. 早先直接 `cpSync` 源文件 → 占位符原样上线，调试框显示 `__DSHM_BOOT_STAMP__` ✗；
   *   2. round 98 只把"Temml 内联"加在 `build-lib.mjs` 里 ✗ → **手机上那份没有副本** ✓，
   *      公式仍按原样 TeX 显示，而验收脚本（装的是 lib ✓）全绿 ✗✓ —— 极难查 ✓。
   */
  const installStamp = bootStamp()
  const bootCode = buildBootPayload(readFileSync(bootSource, 'utf8'), { stamp: installStamp })
  writeFileSync(bootDestination, bootCode)
  /**
   * 原生外壳 APK ✓：`dist/dsh-mobile.apk` → 插件目录（宿主路由 `/mobile/app.apk` 读它 ✓）。
   * 没构建就跳过 ✓（只提示一句 ✓，不让安装失败 ✗ —— 外壳是可选增强 ✓）。
   *
   * ★★ C2：这个包**不再与某台电脑绑定** ✓ —— `build-apk.mjs` 不再把本机 CA 打进 assets ✓，
   *   首次连接由壳与宿主**当场 TOFU**（取回 CA → 与带外票据里的 `caFingerprint` 比对 ✓）。
   *   于是：
   *     · `dist/dsh-mobile.apk` **可以随仓库 / 发布走** ✓（预置、缓存、复用都行 ✓）；
   *     · profile 里那份**旧的** APK 也不需要因为"换了电脑"而重装 ✓
   *       （旧包只是"带了一张老家 CA"✓ —— 首次连新宿主时会走 TOFU 覆盖 pin ✓）；
   *     · `check-apk.mjs` 里"APK 里的 CA 与电脑上那张逐字节一致"那条已经**整体退场** ✓
   *       （它要求的是"一机一包"✓，与本改动相反 ✓）。
   *   代价（运维上要知道 ✓）：**换宿主后必须点一次「忘记这台电脑」** ✓
   *   （壳的「电脑地址」框里那个勾 ✓），否则旧 pin 会把新宿主全拒掉 ✓。
   */
  const apkSource = join(repoRoot, 'dist', 'dsh-mobile.apk')
  const apkTarget = join(profileModules, '@dsh-mobile', 'host', 'lib', 'dsh-mobile.apk')
  let apkNote = '未构建（跑 node scripts/build-apk.mjs 后重装即可）'
  if (existsSync(apkSource)) {
    cpSync(apkSource, apkTarget)
    apkNote = `已安装（${Math.round(readFileSync(apkSource).length / 1024)} KB ✓，与机器无关 ✓）`
  }

  const hasTemml = bootCode.includes('TEMML_INLINE_GZIP_BASE64 = "')
  log(`已安装 boot.js → ${bootDestination}（戳 ${installStamp}，${hasTemml ? '含公式渲染器 ✓' : '⚠ 不含公式渲染器（公式将按原样显示）'}）`)
  log(`原生外壳 APK：${apkNote}（手机可直接下 /mobile/app.apk ✓ —— C2 起这个包不固定任何 CA ✓）`)
}

/** 更新 cordis.patch.yml（幂等：先删旧块再追加）。 */
function updatePatch() {
  const original = existsSync(patchFile) ? readFileSync(patchFile, 'utf8') : '[]\n'
  const base = normalizeBase(removeBlock(original))
  // 保留式合并：中继相关键从现有配置读回（见 readPreservedKeys 的长注释）
  const preserved = readPreservedKeys(patchFile)
  if (preserved.relayUrl !== undefined && args.relayUrl === undefined) {
    log(`保留现有中继配置：${preserved.relayUrl}（如要更换请显式传 --relay-url）`)
  }
  // ★ 空参数**沿用**已有受信列表（而不是覆盖成空）。
  //   显式清空要用 `--clear-trusted-hosts`，那是刻意行为，与「忘了带参数」必须分开。
  let trustedHosts = args.trustedHosts
  let reusedTrustedHosts = false
  /** @type {{ lanIp: string, hosts: string[], phoneBaseUrl?: string } | undefined} */
  let derivedEntry
  if (trustedHosts.length === 0 && preserved.trustedHosts.length > 0) {
    trustedHosts = preserved.trustedHosts
    reusedTrustedHosts = true
    log(`未提供 --trusted-host，沿用已有 ${trustedHosts.length} 条受信 authority（避免抹掉手机入口）`)
    // ★ 别让 `--lan-ip` 在这种情形下**静默不生效** —— 用户给了参数却看不出它没用，
    //   下一轮就会以为"自动推导坏了"。要换地址请显式传 --trusted-host（那是刻意行为）。
    if (args.lanIp !== undefined) {
      log(`（已有可沿用的受信列表，本次 --lan-ip ${args.lanIp} 不生效；要换地址请显式传 --trusted-host）`)
    }
  } else if (trustedHosts.length === 0) {
    /**
     * ★★ 改动 B 的**触发条件**：命令行没给、现有配置里也读不回 ⇒ 这才是"全新机器"。
     *
     * 为什么必须是 `else if`（而不是"没给就推导"）✗：上面那条"沿用"是**防事故的护栏** ——
     * `restart-lan.sh` 每次重启都会重跑本脚本，若拿探测结果去覆盖已有 authority，
     * 就不是"补上手机入口"而是"每次重启都可能把手机入口换成探测到的那张网卡的地址" ✗
     * （本项目已发生过三次同类事故，见 readPreservedKeys）。
     * 测试里有一条 ★ 用例专门守它（`不破坏沿用`），变异 M3 就是把它改成无条件覆盖。
     */
    if (args.autoDetectLan) {
      derivedEntry = derivePhoneEntry(preserved, setupInput(), io)
      if (derivedEntry !== undefined) trustedHosts = derivedEntry.hosts
    } else {
      log('--no-lan-autodetect：跳过手机入口地址的自动推导（trustedHosts / phoneBaseUrl 都不写，与旧行为一致）')
    }
  }
  writeFileSync(patchFile, `${base}${patchBlock(trustedHosts, preserved, derivedEntry)}`, 'utf8')
  // ★ 写完立刻自检：原有的 authority 一条都不能少。
  //   少了就是手机入口 403，而配置热加载意味着**破坏是即时的**——
  //   宁可在这里报错退出，也不要静默地把线上入口关掉。
  {
    const written = readFileSync(patchFile, 'utf8')
    // ★ 只在**沿用**路径上自检。显式传了新 authority 时，旧地址本来就该被换掉
    //   （那正是"地址跟着变"的正确行为，测试里有一条专门守它）——
    //   第一版没区分这两种情况，于是把"换地址"误判成"丢配置"，直接 fail 退出。
    const lost = reusedTrustedHosts ? preserved.trustedHosts.filter((host) => !written.includes(host)) : []
    if (lost.length > 0) fail(`配置自检失败：沿用路径下丢失受信 authority ${lost.join('、')}`)
    // ★ 改动 B 自检：**自动推导写下的入口地址一条都不能少** ——
    //   少了就是"脚本报成功、手机连不上"，正是这个脚本最怕的失败形态（同 C1 那次）。
    const derivedLost =
      derivedEntry === undefined ? [] : derivedEntry.hosts.filter((host) => !written.includes(host))
    if (derivedLost.length > 0) fail(`配置自检失败：自动推导的手机入口地址没写进配置：${derivedLost.join('、')}`)
    if (derivedEntry !== undefined) {
      log('配置自检通过：自动推导的手机入口地址已写入（trustedHosts 与 phoneBaseUrl）')
    }
  }
  /**
   * ★★ C1 写完立刻自检：**`listener` 块的"往返"必须与本次意图一致** ✓。
   *
   * 为什么必须有（这条是本轮补的 ✓）：`--listener` 是"**把手机入口从第三进程搬到插件内**"那一步的**唯一开关** ✓。
   * 而它**要等 DSH 重启才生效** ✗ ⇒ 万一 `patchBlock` 因为任何原因没把它写进去，
   * **本脚本会报成功** ✓、**重启后也一切正常** ✓、只是手机入口**静默地还留在原来的第三进程上** ✗ ——
   * 那正是本项目最怕的一类失败：**看起来做完了，实际没做** ✓。
   *
   * 判据刻意用**同一个** `readPreservedListener` 解析回来 ✓（不是再写一条正则 ✗）：
   * 这样它同时验了"写得进去"**和**"读得回来"✓ —— 也就是"保留式合并"那条路自己也走了一遍 ✓。
   *
   * 方向**两边都判** ✓：
   *   · 本次意图是**开**（命令行 `--listener` ✓ 或沿用现有配置里的 true ✓）⇒ 解析回来必须 `enabled === true` ✗；
   *   · 本次意图是**关** ⇒ 解析回来**不许**是 true ✗（否则用户以为关了、重启后它却起来了 ✓）。
   */
  {
    // ★ 与 `patchBlock` / `derivePhoneEntry` 里**同一个**解析函数（命令行 > 现有配置 > 默认）——
    //   三处必须一致，否则这条自检会在正确的路径上误报 ✗（改动 B 起改成共用一个函数）。
    const wanted = resolveListener(preserved, setupInput()).enabled
    const written = readPreservedListener(readFileSync(patchFile, 'utf8'))
    if (wanted && written.enabled !== true) {
      fail(
        '配置自检失败：本次要求**打开**插件内监听（--listener 或沿用配置），但写出的配置里读不回 `listener.enabled: true`。\n' +
          '        重启后手机入口**不会**搬到插件内，而且**不会有任何报错** ⇒ 必须先修这个再重启。',
      )
    }
    if (!wanted && written.enabled === true) {
      fail('配置自检失败：本次意图是**关闭**插件内监听，但写出的配置里 `listener.enabled` 仍是 true（会被误解为"已关"）。')
    }
    if (wanted) log('配置自检通过：listener 块可往返（重启后手机入口由 DSH 插件进程提供）')
  }
  log(`已更新 ${patchFile}`)
}

function uninstall() {
  for (const pkg of PACKAGES) {
    rmSync(join(profileModules, pkg.name), { recursive: true, force: true })
    log(`已移除 ${pkg.name}`)
  }
  if (existsSync(patchFile)) {
    const text = readFileSync(patchFile, 'utf8')
    const cleaned = removeBlock(text).trim()
    writeFileSync(patchFile, cleaned.length === 0 ? '[]\n' : `${cleaned}\n`, 'utf8')
    log(`已从 ${patchFile} 移除插件条目`)
  }
  log('卸载完成。重启 DSH web 后生效。')
}

/**
 * 真实加载校验：用 profile 的解析上下文导入插件，确认 name/inject/apply 齐备。
 *
 * 为什么必须做这一步：`pnpm add` 成功、文件存在，都不代表 DSH 运行时的动态 import
 * 能找到它（hoisted 布局、ESM 解析、依赖缺失都可能让它在启动时才炸）。
 */
async function verify() {
  const entry = join(profileModules, '@dsh-mobile/host', 'lib', 'cordis.js')
  if (!existsSync(entry)) fail(`校验失败：${entry} 不存在`)
  const loaded = await import(`file://${entry}`)
  const plugin = loaded.default ?? loaded
  if (typeof plugin.apply !== 'function') fail('校验失败：插件没有导出 apply 函数')
  if (typeof plugin.name !== 'string' || plugin.name.length === 0) fail('校验失败：插件没有导出 name')
  log(`校验通过：name=${plugin.name} inject=${JSON.stringify(plugin.inject ?? [])}`)

  // 校验 patch 文件能被 YAML 解析（避免安装完 DSH 启动即失败）
  const { load } = await import('js-yaml')
  const parsed = load(readFileSync(patchFile, 'utf8'))
  if (!Array.isArray(parsed)) fail('校验失败：cordis.patch.yml 顶层不是数组')
  const found = parsed.some(
    (row) => row !== null && typeof row === 'object' && Array.isArray(row.insert) && row.insert.some((e) => e?.name === '@dsh-mobile/host'),
  )
  if (!found) fail('校验失败：cordis.patch.yml 中找不到 mobile-host 条目')
  log('校验通过：cordis.patch.yml 可解析且包含 mobile-host 条目')
}

async function main() {
  if (args.uninstall) {
    uninstall()
    return
  }
  if (args.configOnly) {
    /**
     * ★ 官方插件管理那条路专用 ✓：**只补机器专属 config** ✓ ——
     *   不装文件（官方已经装过了 ✓）、不跑加载校验（那是安装那一步的事 ✓）。
     *   用法见 `--config-only` 的注释 ✓；配套的用户步骤写在 `24` 号 §10.3 ✓。
     */
    updatePatch()
    /**
     * ★ **整份**再解析一遍 ✓ —— 上一版只验了"自己那块"的逻辑 ✓，
     *   漏掉了"写出来的到底是不是合法 YAML、是不是一个列表项"✗（第一版真漏了 `- id:` 那一行 ✓，
     *   结果整份文件非法、而自检照样打绿 ✗）。配置写坏了的症状是 **DSH 起不来** ✗，
     *   而这里的代价只有一行 ✓ ⇒ 必须验 ✓。
     */
    try {
      const { load: loadYaml } = await import('js-yaml')
      const parsed = loadYaml(readFileSync(patchFile, 'utf8'))
      if (!Array.isArray(parsed)) throw new Error('顶层不是数组')
      const found = parsed.some((entry) => entry !== null && typeof entry === 'object' && entry.id === 'mobile-host')
      if (!found) throw new Error('找不到 id: mobile-host 这一项')
      const host = parsed.find((entry) => entry !== null && typeof entry === 'object' && entry.id === 'mobile-host')
      if (host.config === undefined || typeof host.config !== 'object') throw new Error('mobile-host 那一项没有 config')
      if (host.name !== undefined) throw new Error('不该带 name（行由 bundle 插入，这里只覆盖 config）')
      log(`配置自检通过：整份 cordis.patch.yml 可解析 ✓，mobile-host 带 config（${Object.keys(host.config).length} 个键 ✓）且不带 name ✓`)
    } catch (error) {
      fail(`config-only 自检失败（写出来的配置有问题，别重启 DSH）：${error instanceof Error ? error.message : String(error)}`)
    }
    log('')
    log('已写入机器专属配置（只补 config、没动任何文件）✓。下一步：')
    log('  1. 重启 DSH web（配置在启动时读一次）')
    log(`  2. 打开 http://127.0.0.1:<端口>/mobile/manifest 应返回 JSON（含 protocolVersion 与主机指纹）`)
    log('  3. POST /mobile/pair/code 生成配对码，然后在手机上用 dsh-mobile 扫码')
    return
  }
  preflight()
  installPackages()
  updatePatch()
  if (!args.skipVerify) await verify()
  log('')
  log('安装完成。下一步：')
  log(`  1. 重启 DSH web（当前进程不会自动加载新插件）`)
  log(`  2. 打开 http://127.0.0.1:3080/mobile/manifest 应返回 JSON（含 protocolVersion 与主机指纹）`)
  log(`  3. POST /mobile/pair/code 生成配对码，然后在手机上用 dsh-mobile 扫码`)
  log('')
  log('注意：局域网访问需要 DSH 绑定所有网卡并声明可信主机，例如：')
  log('  dsh web --host 0.0.0.0 --trusted-host <电脑局域网IP>')
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error))
})
