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
// ★ 改动 B：局域网地址一律用工程自己这一份探测（打分/排除规则的坑都记在它的头注释里）。
//   刻意不在这里手写网卡枚举 —— 那正是它诞生的原因（曾选中 APIPA 169.254.x.x）。
import { detectLanIp } from './detect-lan-ip.mjs'

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
    // 所以没给就沿用现有配置里的值——见 patchBlock 上方的长注释。
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
    // `undefined` 表示"本次没表态"，由 patchBlock 按 命令行 > 现有配置 > 默认 解析。
    listener: undefined,
    listenerPlain: undefined,
    listenerTls: undefined,
    // ★ 改动 B：全新机器上"手机该连哪儿"的自动推导。
    //   `lanIp === undefined` ⇒ 本次没表态，走 detect-lan-ip.mjs 自动探测；
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

/** patch 条目的标记注释：用于幂等识别我们插入的块。 */
const MARKER_START = '# >>> dsh-mobile host plugin (managed by scripts/install-host-plugin.mjs) >>>'
const MARKER_END = '# <<< dsh-mobile host plugin <<<'

/** listener 端口的**默认**值（仅在命令行与现有配置都没给时使用）。 */
const DEFAULT_LISTENER_PLAIN = '0.0.0.0:3081'
const DEFAULT_LISTENER_TLS = '0.0.0.0:3443'

/**
 * 解析本次**生效**的 listener 配置：命令行 > 现有配置读回 > 默认。
 *
 * ★ 全脚本**只此一处**做这件事 ✓。`patchBlock` 写块 ✓、写后往返自检 ✓、
 *   以及改动 B 的手机入口地址推导 ✓ —— 三处必须拿**同一套**结果 ✗，
 *   否则会出现"日志说 3713、配置里写 3443"这种只在手机上才现形的脱节 ✗
 *   （改动 B 的端口就取自这里，不再自己算一遍）。
 *
 * @returns {{ enabled: boolean, plain: string, tls: string }}
 */
function resolveListener(preserved) {
  return {
    enabled: (args.listener ?? preserved?.listenerEnabled ?? false) === true,
    plain: args.listenerPlain ?? preserved?.listenerPlain ?? DEFAULT_LISTENER_PLAIN,
    tls: args.listenerTls ?? preserved?.listenerTls ?? DEFAULT_LISTENER_TLS,
  }
}

/**
 * 从监听地址里取出端口：`0.0.0.0:3081` → `3081`，`[::]:3081` → `3081`。
 *
 * 取**最后一个**冒号之后的部分：IPv6 的 `[::]:3081` 有三个冒号，
 * 按第一个切会切出 `:]:3081` 这种垃圾，而 `trustedHosts` 是逐字参与 Host 比对的。
 *
 * @returns {string | undefined} 拿不到合法端口时返回 undefined（调用方据此不写该项）
 */
function portOfListenerAddress(address) {
  if (typeof address !== 'string') return undefined
  const text = address.trim()
  const index = text.lastIndexOf(':')
  if (index < 0) return undefined
  const port = text.slice(index + 1).trim()
  return /^\d+$/.test(port) ? port : undefined
}

/** 探测失败时的统一警告（★ 刻意**不 fail** —— 退回旧行为，但绝不静默）。 */
function warnNoPhoneEntry(reason) {
  warn(
    `${reason} ⇒ 手机入口地址**没有**写进配置，手机侧届时会连不上（配对票据里会是没有的地址）。\n` +
      '        请用 `--lan-ip <本机局域网IP>` 或 `--phone-base-url https://<IP>:<TLS端口>` 显式指定。',
  )
}

/**
 * ★★ 改动 B：全新机器上自动推导"手机该连哪儿"。
 *
 * ## 要解决的事故
 *
 * 新电脑上只跑 `--listener`（没传 `--trusted-host` / `--phone-base-url`）时，
 * 旧行为是"什么都不写" ⇒ 配对票据里的 `endpoints` 落到 `http://<ip>:<DSH 端口>`
 * （例如 3711）—— 而 DSH 自己只绑 `127.0.0.1` ⇒ **手机根本连不上** ⇒ 配对必失败。
 * 手机真正该被指向的是**插件内的 TLS 监听**（`https://<lan>:<TLS端口>`）。
 *
 * ## 只在"既没有命令行、也没有可沿用的"这条路径上跑
 *
 * 调用方（`updatePatch`）保证：只有 `--trusted-host` 一条都没给、
 * 且现有配置里也读不回任何 authority 时才调用本函数。
 * ★ 有现有配置时的"沿用"语义**原样不动** —— 那是防"跑一次重启就把手机入口抹掉"的护栏，
 *   同一类事故本项目已经发生过三次（见 `readPreservedKeys` 的长注释）。
 *
 * ## 端口
 *
 * 明文 / TLS 端口取自 `resolveListener`（命令行 > 读回 > 默认 3081/3443），
 * **不另算一遍**；`phoneBaseUrl` 用 **HTTPS**（手机侧安全上下文 / WebCrypto 的前提，
 * 见 `patchBlock` 里同一句话的注释），`publicBaseUrl` 仍由 `patchBlock` 按 `trustedHosts[0]` 推导；
 * 同一个 HTTPS 地址还会进 `extraEndpoints` —— 因为票据的 `endpoints` 是
 * `publicBaseUrl` + `extraEndpoints`，而明文那条会被手机壳跳过（详见返回值处的长注释）。
 *
 * ## 可注入、可关闭
 *
 *   · `--lan-ip <ip>`：显式指定，跳过探测；
 *   · `--lan-ip ''`：注入"拿不到地址"，用于确定性地测探测失败路径；
 *   · `--no-lan-autodetect`：整个关掉（调用方处理），退回旧行为。
 *
 * @returns {{ lanIp: string, hosts: string[], phoneBaseUrl?: string, endpoint?: string } | undefined}
 *          推导不出来（探测失败 / 端口解析失败）时返回 undefined，**不抛不 fail**。
 */
function derivePhoneEntry(preserved) {
  const listener = resolveListener(preserved)
  if (!listener.enabled) {
    // 端口照样解析（默认 3081/3443），但必须说清这个前提 —— 否则用户会以为我们在替
    // 一个没人监听的端口背书。第三方 lan-proxy 的部署形态下这两个端口确实有人听。
    log('提醒：本次没开插件内监听（--listener），下面写的入口端口假定由其它进程提供（例如 lan-proxy.mjs）')
  }
  /** @type {string} */
  let lanIp
  if (args.lanIp !== undefined) {
    lanIp = String(args.lanIp).trim()
    if (lanIp.length === 0) {
      warnNoPhoneEntry('--lan-ip 给的是空值，视为拿不到局域网地址')
      return undefined
    }
    log(`手机入口地址：使用 --lan-ip 显式指定的 ${lanIp}（跳过自动探测）`)
  } else {
    const detected = detectLanIp()
    if (detected === undefined || String(detected).trim().length === 0) {
      warnNoPhoneEntry('自动探测本机局域网地址失败（没有可用的 IPv4 网卡）')
      return undefined
    }
    lanIp = String(detected).trim()
    log(
      `手机入口地址：自动探测到本机局域网地址 ${lanIp}` +
        `（scripts/detect-lan-ip.mjs；要换用 --lan-ip，要关掉自动推导用 --no-lan-autodetect）`,
    )
  }
  const plainPort = portOfListenerAddress(listener.plain)
  const tlsPort = portOfListenerAddress(listener.tls)
  const tlsAuthority = tlsPort === undefined ? undefined : `${lanIp}:${tlsPort}`
  const hosts = []
  if (plainPort !== undefined) hosts.push(`${lanIp}:${plainPort}`)
  if (tlsAuthority !== undefined) hosts.push(tlsAuthority)
  if (hosts.length === 0) {
    warnNoPhoneEntry(`listener 端口解析不出端口号（plain='${listener.plain}'，tls='${listener.tls}'）`)
    return undefined
  }
  const phoneBaseUrl = tlsAuthority === undefined ? undefined : `https://${tlsAuthority}`
  if (phoneBaseUrl === undefined) {
    warnNoPhoneEntry(`listener 的 TLS 端口解析不出来（tls='${listener.tls}'），phoneBaseUrl 没法推导（手机必须 HTTPS）`)
  }
  /**
   * ★★ 为什么 HTTPS 那条还要同时进 `extraEndpoints`：
   *
   * 配对票据里的 `endpoints` **不是** `phoneBaseUrl`，而是
   * `publicBaseUrl` + `extraEndpoints` 两份拼出来的（见 host 侧 `createEndpointResolver`）。
   * 而 `publicBaseUrl` 沿用现有逻辑只能是 `http://<hosts[0]>`（明文那一条）。
   *
   * 手机壳那边**明文端点是直接跳过的**（`PairLink.isCleartext`；本机真实票据
   * `["http://10.34.255.229:3081", "https://100.123.136.82:3443", "https://10.34.255.229:3443"]`
   * 第 ① 条就是这么被跳过的）。所以只写 `publicBaseUrl` 的话，新机器的票据里
   * **一条能用的 HTTPS 都没有** ✗ ⇒ 手机仍然配对必失败 ✗ ——
   * 正是本改动要修的那个现象。生产配置里那两条 `https` 也是走 `extraEndpoints` 来的，
   * 这里与它保持一致。authority 已在 `hosts` 里，不会重复。
   */
  const endpoint = phoneBaseUrl
  log(
    `★★ 已替你把手机入口地址写进配置：trustedHosts += ${hosts.join('、')}` +
      `${phoneBaseUrl === undefined ? '；phoneBaseUrl 未写（无 TLS 端口）' : `；phoneBaseUrl = ${phoneBaseUrl}`}` +
      `${endpoint === undefined ? '' : `；extraEndpoints += ${endpoint}（配对票据的 endpoints 就取自这里 + publicBaseUrl）`}`,
  )
  log('    依据：手机只能走局域网，而 DSH 自己只绑回环（127.0.0.1）；上面这些是本次解析出的监听端口。')
  return { lanIp, hosts, phoneBaseUrl, endpoint }
}

/**
 * 从**现有** `cordis.patch.yml` 里读回 `listener` 段（C1）。
 *
 * 与 `readPreservedKeys` 里其它键同一动机：`patchBlock` 是**覆盖式**重写，
 * 而 `restart-lan.sh` 会在**每次重启**时重新调用本脚本 —— 若这次没显式传
 * `--listener-plain/--listener-tls` 就把上次写下的监听地址丢掉，
 * 那就是"跑一次重启 ⇒ 手机入口静默换端口"（本项目已发生过三次的那类事故）。
 *
 * 解析必须是**缩进作用域内**的：`enabled` / `plain` / `tls` 都是很普通的名字，
 * 整文件 grep/正则很容易撞上同名键（`readPreservedKeys` 里 `extraEndpoints`
 * 就是被 `phoneBaseUrl` 骗过一次）。所以这里先定位 `listener:` 那一行，
 * 再只读它**更深缩进**的子行，遇到缩进回退即停。
 *
 * @returns {{ enabled?: boolean, plain?: string, tls?: string }} 没写过 listener 段时返回 `{}`
 */
function readPreservedListener(text) {
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const head = /^(\s+)listener:\s*$/.exec(lines[i])
    if (head === null) continue
    const indent = head[1].length
    const out = {}
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j].trim() === '') continue
      const field = /^(\s+)([A-Za-z]+):\s*'?([^'\n]+?)'?\s*$/.exec(lines[j])
      if (field === null || field[1].length <= indent) break
      if (field[2] === 'enabled') out.enabled = field[3].trim() === 'true'
      else if (field[2] === 'plain') out.plain = field[3].trim()
      else if (field[2] === 'tls') out.tls = field[3].trim()
    }
    return out
  }
  return {}
}

/**
 * 生成 patch 块。
 * `trustedHosts` 必须与手机实际访问的 authority 一致：本插件注册的 /mobile 路由
 * 不受 DSH 的 /api 信任栅栏保护，因此它自己校验 Host/Origin（见 index.ts 的说明）。
 */
/**
 * 从**现有** cordis.patch.yml 里读回中继相关的键。
 *
 * ## 为什么必须这么做（这是被同一类 bug 咬第三次之后加的）
 *
 * 这个脚本写 patch 是**覆盖式**的：它按本次参数重新生成整个配置块。
 * 对 `trustedHosts` / `publicBaseUrl` / `phoneBaseUrl` 这是对的——它们本来就该
 * 随局域网地址重算。但中继那几项（`relayUrl` / `relayToken` / `extraEndpoints` …）
 * **与本次地址无关**，一旦被覆盖就等于：
 *
 *   > 用户配好中继 → 某天跑了一次 `restart-lan.sh` → 中继配置被抹掉 → **远程访问静默失效**。
 *
 * 前两次同类事故是 `3443` 与 `phoneBaseUrl` 被抹掉（手机"一直重连中"）。
 * 所以这里改成**保留式合并**：现有配置里的中继键一律沿用，除非命令行显式覆盖。
 * `extraEndpoints` 更进一步是**纯追加**（见 patchBlock）：它只是"候选端点"，
 * 多留一条不会有副作用，而少一条就是一条路静默失效。
 */
function readPreservedKeys(patchFile) {
  const preserved = { extraEndpoints: [], trustedHosts: [] }
  let text = ''
  try {
    text = readFileSync(patchFile, 'utf8')
  } catch {
    return preserved
  }
  const scalar = (key) => {
    const match = new RegExp(`^\\s+${key}:\\s*'?([^'\\n]+)'?\\s*$`, 'm').exec(text)
    return match?.[1]?.trim()
  }
  // ★ 已有的受信 authority 也读出来。
  //   踩过两次的坑：`--trusted-host` 不给就是空数组，而 patchBlock 是**覆盖式**写入 ——
  //   于是「不带参数跑一次安装」会把 TLS authority 与 phoneBaseUrl 一起抹掉，
  //   手机侧立刻 403（配置是热加载的，破坏是即时的）。第二次是我自己踩的。
  //
  //   列表必须**逐行**解析。第一版写成一条正则 `(?:\s+-\s*'?[^'\n]+?'?)+`，
  //   懒量词配上可选引号，重复组吃一个字符就收工 —— 只抓到第一条，
  //   "沿用"于是变成"删掉后两条"，手机入口照样 403（护栏本身有 bug）。
  const patchLines = text.split('\n')
  for (let i = 0; i < patchLines.length; i++) {
    if (!/^\s+trustedHosts:\s*$/.test(patchLines[i])) continue
    for (let j = i + 1; j < patchLines.length; j++) {
      const item = /^\s+-\s*'?([^'\n]+?)'?\s*$/.exec(patchLines[j])
      if (item === null) break
      preserved.trustedHosts.push(item[1].trim())
    }
    break
  }
  preserved.phoneBaseUrl = scalar('phoneBaseUrl')
  preserved.relayUrl = scalar('relayUrl')
  preserved.relayToken = scalar('relayToken')
  preserved.relayHttpUrl = scalar('relayHttpUrl')
  preserved.relayPoolSize = scalar('relayPoolSize')
  /**
   * ★ extraEndpoints 与 trustedHosts **同一形态：逐行循环** ✓。
   *
   * 这里原先是一条大正则 ✗，而它**只抓得回第 1 条** ✓ —— 两个坑都实测过：
   *
   * 1. **大正则的 `\s*` 会把换行也吃掉** ✗：
   *    `/^\s+extraEndpoints:\s*\n((?:\s+-\s*'?[^'\n]+'?\s*\n?)+)/m` 里，组内第 1 次
   *    迭代末尾那个 `\s*` 贪婪地把 `\n` **加上第 2 行的缩进**一起吞掉 ⇒ 第 2 次迭代
   *    再也匹配不到 `\s+-` ⇒ **列表到此为止** ✗（实测：写进去 `['a','b']`，
   *    读回来只有 `['a']` ✓）。
   *    `trustedHosts` 早先正是同一个 bug，已经改成逐行循环 ✓ ——
   *    **extraEndpoints 当时漏改了** ✗。
   *
   * 2. **整文件 grep 这个串也不行** ✗：`phoneBaseUrl: 'https://ip:端口'` 与
   *    "学校端点"的字符串**逐字相同** ✓ ⇒ "这条端点配置过没有"会被 `phoneBaseUrl`
   *    骗成"有" ✗（实测：整文件 `grep -F "'https://10.34.255.229:3443'"` 命中的
   *    就是 `phoneBaseUrl` 那一行 ✓）。
   *
   * 所以只能：先定位到 `extraEndpoints:` 那一行，再**逐行**读它下面的 `- ` 条目 ✓。
   *
   * ★ 为什么这件事在本轮从"潜在"变成"必须"：`restart-lan.sh` 现在一次广告
   *   **两条**端点（学校 HTTPS ✓ + Tailscale ✓）✗ —— 只抓第 1 条 ⇒ 第 2 条会在
   *   下一次重装时**静默消失** ✗ ⇒ 用户要的"两个默认链接"自己退化成一条 ✗
   *   （回归测试见 `packages/host/test/install-script.test.ts` 里那两条 ★ 用例 ✓）。
   *
   * ⚠️ 与 `trustedHosts` 同一限制（**刻意保持一致** ✓）：列表**中间**出现注释行或
   *    其它非 `- ` 行会被当作列表结束 ✓。我们写出来的块里不会有这种行 ✓。
   */
  const endpointLines = text.split('\n')
  for (let i = 0; i < endpointLines.length; i++) {
    if (!/^\s+extraEndpoints:\s*$/.test(endpointLines[i])) continue
    for (let j = i + 1; j < endpointLines.length; j++) {
      const item = /^\s+-\s*'?([^'\n]+?)'?\s*$/.exec(endpointLines[j])
      if (item === null) break
      preserved.extraEndpoints.push(item[1].trim())
    }
    break
  }
  // C1：listener 段（插件进程内监听）走**缩进作用域**解析，避免 `enabled`/`plain`/`tls`
  // 这类普通名字与文件里别处的同名键串味（见 readPreservedListener 的说明）。
  const listener = readPreservedListener(text)
  preserved.listenerEnabled = listener.enabled
  preserved.listenerPlain = listener.plain
  preserved.listenerTls = listener.tls
  return preserved
}

/**
 * 取一个端点的 authority（`URL.host`，IPv6 会带方括号，与 `trustedHosts` 的写法一致）。
 *
 * 只认 `http://` / `https://`；`ws://` / `wss://`（中继的 `wss://域名/attach`）返回 undefined。
 */
function authorityOfEndpoint(endpoint) {
  let url
  try {
    url = new URL(endpoint)
  } catch {
    return undefined // 连 URL 都解析不了：广告方自己写错了，这里不猜
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
  return url.host === '' ? undefined : url.host
}

/**
 * 把端点派生出的 authority **追加**到显式受信列表之后（去重）。
 *
 * ## 不变量：凡是被广告出去的 endpoint，其 authority 必须同时在 `trustedHosts` 里
 *
 * 两份配置来自不同的键、由不同的调用方维护，很容易出现"端点广告了、trust 没跟上"：
 * 手机按候选取到它 → DSH 信任栅栏 **403** → 表现为"一直重连中"，
 * 而电脑端看配置却觉得一切正常。`05-项目进度与改动评估.md` 里那三次事故
 * （`3443` / `phoneBaseUrl` / `relayUrl` 被覆盖式重装抹掉）都是同一类"以为只改 A、其实少了 B"。
 *
 * 只从 `http://` / `https://` 派生：`ws://` / `wss://`（中继的 `wss://域名/attach`）
 * **不派生** —— 中继拓扑下域名**不需要**进 trust：手机只连中继，中继经**回源通道**
 * （回环）访问本机，而栅栏本就把回环请求当"人在电脑前"
 * （结论见 `07-非局域网中继方案设计.md` §5）。
 *
 * ⚠️ 只追加、**绝不插到前面**：`patchBlock` 用 `trustedHosts[0]` 推导 `publicBaseUrl`
 *    （配对码里要嵌的那个地址），插到前面会把它换掉 —— 又是一次静默的行为变更。
 *
 * @returns {{ hosts: string[], added: string[] }} `added` 仅用于日志
 */
function withEndpointAuthorities(trustedHosts, extraEndpoints) {
  const hosts = [...trustedHosts]
  const seen = new Set(hosts)
  const added = []
  for (const endpoint of extraEndpoints) {
    const authority = authorityOfEndpoint(endpoint)
    if (authority === undefined || seen.has(authority)) continue
    seen.add(authority)
    hosts.push(authority)
    added.push(authority)
  }
  return { hosts, added }
}

function patchBlock(trustedHosts, preserved, derived) {
  // 端点列表先算出来：`trustedHosts` 要从它派生（见 withEndpointAuthorities 的说明）。
  //
  // ⚠️ 这里是**追加**合并，而不是原先的"命令行给了就整体覆盖"：
  //   `restart-lan.sh` 现在每次都会为 Tailscale 传一条 `--extra-endpoint`，
  //   若按覆盖语义，中继那条 `https://<域名>` 会在下一次重启时被静默挤掉 ——
  //   正是本项目已经发生过三次的那类事故（保留式合并只做了一半）。
  //   要**删除**某个端点请直接编辑配置，别用"少传一个参数"表达删除。
  // ★ 改动 B 推导出的那条 https 也并进来（纯追加，见 derivePhoneEntry 里的长注释）：
  //   它必须出现在**票据的 endpoints 里**，否则新机器的票据只有一条被壳跳过的明文。
  const extraEndpoints = [
    ...new Set([...(preserved?.extraEndpoints ?? []), ...args.extraEndpoints, ...(derived?.endpoint === undefined ? [] : [derived.endpoint])]),
  ]
  const { hosts, added } = withEndpointAuthorities(trustedHosts, extraEndpoints)
  if (added.length > 0) log(`为 extraEndpoints 补了 ${added.length} 条 trust：${added.join('、')}`)
  // 配对码里要嵌"手机能访问到的地址"：DSH 只绑 loopback，手机走的是代理端口，
  // 因此把首个受信 authority 直接作为 publicBaseUrl（形如 http://<ip>:<代理端口>）。
  const publicBaseUrl = hosts.length > 0 ? `http://${hosts[0]}` : undefined
  const lines = []
  if (hosts.length > 0) {
    lines.push('        trustedHosts:')
    for (const entry of hosts) lines.push(`          - '${entry}'`)
  }
  if (publicBaseUrl !== undefined) lines.push(`        publicBaseUrl: '${publicBaseUrl}'`)
  // 手机侧必须 HTTPS（安全上下文 / WebCrypto 前提），端口与明文端口不同，单独一项。
  // 优先级：**命令行 > 现有配置读回 > 改动 B 的自动推导**（后者只在全新机器的路径上存在）。
  const phoneBaseUrl = args.phoneBaseUrl ?? preserved?.phoneBaseUrl ?? derived?.phoneBaseUrl
  if (phoneBaseUrl !== undefined) lines.push(`        phoneBaseUrl: '${phoneBaseUrl}'`)
  // 中继：命令行优先，其次沿用现有配置（见 readPreservedKeys 的说明）
  const relayUrl = args.relayUrl ?? preserved?.relayUrl
  const relayToken = args.relayToken ?? preserved?.relayToken
  const relayHttpUrl = args.relayHttpUrl ?? preserved?.relayHttpUrl
  const relayPoolSize = args.relayPoolSize ?? preserved?.relayPoolSize
  if (extraEndpoints.length > 0) {
    lines.push('        extraEndpoints:')
    for (const entry of extraEndpoints) lines.push(`          - '${entry}'`)
  }
  if (relayUrl !== undefined) lines.push(`        relayUrl: '${relayUrl}'`)
  if (relayToken !== undefined) lines.push(`        relayToken: '${relayToken}'`)
  if (relayHttpUrl !== undefined) lines.push(`        relayHttpUrl: '${relayHttpUrl}'`)
  if (relayPoolSize !== undefined) lines.push(`        relayPoolSize: ${relayPoolSize}`)
  /**
   * C1：插件进程内的局域网监听（把 `scripts/lan-proxy.mjs` 搬进插件）。
   *
   * 优先级：**命令行 > 现有配置读回 > 默认**（读回见 readPreservedKeys 的说明）。
   *
   * ★★ **发射规则**：解析后 `enabled` **不是 true 时一个 `listener:` 块都不发** ——
   *    这样老部署（从不带 `--listener`）的 patch 与改动前**逐字节相同**，
   *    DSH 那边的行为也就一字不变（插件侧 `config.listener?.enabled !== true` ⇒ 不起监听）。
   *    ⚠️ 别改成"总是发块"：那会在**每一次** `restart-lan.sh` 里往生产配置塞新键。
   */
  const listener = resolveListener(preserved)
  if (listener.enabled === true) {
    const listenerPlain = listener.plain
    const listenerTls = listener.tls
    lines.push('        listener:')
    lines.push('          enabled: true')
    if (listenerPlain !== undefined && listenerPlain.length > 0) lines.push(`          plain: '${listenerPlain}'`)
    if (listenerTls !== undefined && listenerTls.length > 0) lines.push(`          tls: '${listenerTls}'`)
  }
  const config = lines.length === 0 ? '' : `\n      config:\n${lines.join('\n')}`
  /**
   * ★★ 官方插件管理那条路：**只给 config、不 insert 行** ✓（2026-09-29 ✓）。
   *
   * ## 为什么形状不一样 ✗
   *
   * 走官方那条路时，**插件行由 bundle 自己插入** ✓（`packages/host/cordis.patch.yml` ✓）；
   * 我们再写一条 `insert` 就会插出**第二行** ✗。但 bundle **只给行、不给 config** ✓
   * （config 属于"这台机器" ✓），所以缺的就是这块 ✓。
   *
   * DSH 的配置是三层叠加（bundle 层 → profile 层 → home 层 ✓），合成器的规则是
   * "**后续层按 `id` 找到同一行、整块替换它的 `config`**" ✓ ⇒ 这里写一条
   * `- id: mobile-host` + `config:` 就正好补上 ✓（**不写 `name:`** ✗ —— 行已经在了 ✓）。
   *
   * ★ 展开逻辑（`lines` 那几十行）与上面那条 `insert` 版本**完全共用** ✓ ——
   *   命令行 > 现有配置 > 自动推导这套优先级只有**一处**实现 ✓（本项目的头号纪律 ✓）。
   *   唯一的差别是**缩进**：`insert` 版嵌在四级里（8 空格 ✓），这里在顶层（4 空格 ✓）。
   */
  if (args.configOnly) {
    /**
     * ★★ 注意第一条必须是 `- id: mobile-host` ✗ —— 漏了它写出来就不是一个**列表项**，
     *    整份 YAML **非法** ✓（第一版就漏了 ✓，而且当时那条"自检"只验自己那块、没验整份文件，
     *    所以它照样打了"配置自检通过"✗ ⇒ 下面补了一道**整份解析**的校验 ✓）。
     */
    const body =
      lines.length === 0
        ? ['- id: mobile-host', '  config: {}'].join('\n')
        : ['- id: mobile-host', '  config:', ...lines.map((line) => line.replace(/^ {4}/, ''))].join('\n')
    return `${MARKER_START}
# 手机端接入的**机器专属配置**（★ 这条**只给 config、不 insert 行** ✗）。
# 行本身由 bundle 自带（@dsh-mobile/host 的 cordis.patch.yml ✓）——
# DSH 三层叠加、后续层按 id 整块替换 config ⇒ "bundle 给行、这里给 config" ✓。
# 由 scripts/install-host-plugin.mjs --config-only 维护（幂等：先删本块再追加 ✓）。
${body}
${MARKER_END}
`
  }
  return `${MARKER_START}
# 手机端接入：/mobile/ws 加密隧道、配对与设备管理端点，并往 index.html 注入 boot.js。
# 这条 insert 位于所有 bundle 层之后，因此 webServer / typertGateway 均已就绪。
- insert:
    - id: mobile-host
      name: '@dsh-mobile/host'${config}
    # 预览桥（round 99）：把 DSH 自带的文档预览（KaTeX / PDF / 图片）暴露给手机外壳。
    # 它**必须**在这里被声明 ✓ —— DSH 的客户端 bundle 注册要求"与 graph 行匹配" ✓，
    # 只在页面里 load 是无效的 ✗（见 packages/bridge/lib/client.js 的说明）。
    - id: mobile-preview-bridge
      name: '@dsh-mobile/bridge'
${MARKER_END}
`
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
      derivedEntry = derivePhoneEntry(preserved)
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
    const wanted = resolveListener(preserved).enabled
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

/**
 * 把 patch 文件的既有内容规范化成"可以安全追加一个列表项"的基底。
 *
 * 关键点：DSH 首次生成的 patch 文件内容是空列表字面量 `[]`。
 * 若把我们的 `- insert:` 直接追加在 `[]` 之后，YAML 会变成两个顶层节点而解析失败
 * （安装脚本自身在更新后立刻做 YAML 解析校验，正是为了拦住这种错误）。
 * 因此空列表必须被替换掉，而不是被追加。
 */
function normalizeBase(text) {
  // 去掉纯注释行与空白，判断是否等价于空列表
  const meaningful = text
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n')
    .trim()
  if (meaningful === '' || meaningful === '[]') {
    // 保留用户原有注释（若有），丢掉 `[]` 字面量
    const comments = text
      .split('\n')
      .filter((line) => line.trimStart().startsWith('#'))
      .join('\n')
    return comments.length === 0 ? '' : `${comments}\n`
  }
  return `${text.trimEnd()}\n`
}

function removeBlock(text) {
  const start = text.indexOf(MARKER_START)
  if (start < 0) return text
  const end = text.indexOf(MARKER_END)
  if (end < 0) return text.slice(0, start)
  return text.slice(0, start) + text.slice(end + MARKER_END.length + 1)
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
