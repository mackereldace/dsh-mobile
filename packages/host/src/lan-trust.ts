/**
 * 局域网信任的**自推导**——本插件自己那道闸（`/mobile/*`）的判据来源之一。
 *
 * ## 为什么需要它（这一步要干掉的是"手传 IP"）
 *
 * 本插件注册的 `/mobile/*` 路由**不受** DSH 的 `/api` 信任栅栏保护，所以栅栏只能自己写。
 * 而它此前是**纯静态列表**（`options.trustedHosts`，由 `install-host-plugin.mjs` 从
 * `--trusted-host` 抄进 `cordis.patch.yml`）⇒ 换一台机器、换一次 DHCP、插一次网线，
 * 都得**人工把新 IP 再传一遍**，忘了就是一片 403（表现为"手机怎么都连不上"）。
 *
 * ★ 关键发现：DSH 自己**早就在自动推导**这套东西了。
 *   `dsh-web-app/lib/index.js` 的 `resolveLanTrust(bindHost, extra)`：绑 `0.0.0.0` 时
 *   把 `os.networkInterfaces()` 里**所有非内部 IPv4**（含 Tailscale 的 100.x）都算进
 *   `trustedHosts`。于是"我们这道闸比 DSH 还严"这件事并没有换来安全，只换来了手工维护。
 *   本模块就是把同一套推导搬到插件这一侧，让**两道信任同时不再需要手配**。
 *
 * ## 判据（宽严都必须说得出来）
 *
 * 可信集合 = **回环**（调用方用 `isLoopbackHostname` 单独判）∪ 静态列表 ∪ 本机非内部 IPv4
 *          ∪ 本机 hostname ∪ 中继 authority ∪ `phoneBaseUrl`。
 * 后两项由调用方并入静态列表（它们本来就是"部署方声明过的 authority"），
 * 本模块只负责"本机"那一半。
 *
 * ★ 为什么**只有 IP 字面量 Host 才与本机 IP 集合比对**：
 *   DNS rebinding 的攻击面是**名字**——攻击者控制 `evil.example.com` 的解析，
 *   让它指向受害机的地址，于是浏览器带着 `Host: evil.example.com` 打到本机。
 *   只要我们从**不解析** Host（既不查 DNS，也不做"这个名字解析出来是不是本机 IP"的比较），
 *   那条路就整条不存在。所以这里的比较是**字符串字面量**比较：
 *   `Host: 10.0.0.5` 命中；`Host: 10.0.0.5.evil.com`、`Host: evil.com` 一律不命中。
 *
 * ★ 本机 hostname（含 `<hostname>.local`）要不要放行——**放行，但只认精确匹配**：
 *   · 放行的理由：证书 SAN、配对码推荐地址、`<hostname>.local` 这套"地址不随 IP 变"的
 *     体验本来就是按机器名设计的（见 `scripts/make-cert.mjs` 的长注释）；不放行的话
 *     用机器名访问手机端会 403，而机器名正是我们推荐用户去用的那个地址。
 *   · 为什么**精确匹配就够安全**：攻击者要借 rebinding 用上这条放行，必须让浏览器加载一个
 *     **origin 恰好等于受害机自己的 hostname** 的页面——而那个名字（经 mDNS）解析回受害机
 *     自身，页面上跑的是**我们自己的前端**，不是攻击者的页面。即"能被打上这个 Host 的请求"
 *     本来就来自本机自己。反过来，`.local` 确实可被同局域网的人用 mDNS 抢答冒充，但那是
 *     **把客户端骗到攻击者那里**（中间人），并不能让攻击者的页面拿到我们这个受信 Host；
 *     而中间人这条路在原生外壳里已被"内嵌 CA 固定"挡住（见 `09-原生外壳方案.md`）。
 *   · 因此判据写成：**只认本机 hostname 的精确匹配**（裸名与 `<裸名>.local` 两种写法，
 *     大小写归一），绝不做后缀/前缀/正则匹配，也绝不把名字解析成地址后再比。
 *     `.local` 与裸名**同等对待**：裸名反而可能被 DHCP 下发的 DNS 搜索域劫持，
 *     比 RFC 6762 保留的 `.local` 更不可控，所以没有理由厚此薄彼。
 *   · 需要收紧的部署可以关掉这半边（`MobileHostConfig.trustLocalNames = false`）——
 *     那样就只剩 IP 字面量与静态列表，代价是用机器名访问会 403。
 *
 * ## 每次请求现算，不是启动时算一次
 *
 * 换 Wi-Fi / 插网线 / VPN 起来 / Tailscale 掉线，都会改变本机地址；启动时算一次就等于
 * "换网必须重启 DSH"。所以 `deriveLanTrust` 是一个**纯函数**，调用方在每次
 * `handleHttp` / `handleUpgrade` 里现调它；网卡取值函数可注入，测试才能把"换网"演出来。
 *
 * ## 推导失败时**退回静态列表**（不放开闸门）
 *
 * `os.networkInterfaces()` 抛错时返回 `derived: false` 且地址为空 —— 结果是"只剩静态列表 +
 * 回环"，比平常更严，而不是更松。方向刻意选这一侧：闸门失效时宁可 403 也不放行。
 */

import { hostname as osHostname, networkInterfaces as osNetworkInterfaces, platform as osPlatformName } from 'node:os'

/**
 * 网卡条目（只取用得到的三个字段）。
 *
 * 刻意**不直接依赖** `os.NetworkInterfaceInfo`：测试要能塞假网卡，而真实结构里
 * `netmask`/`mac`/`cidr`/`scopeid` 这些字段与判据无关，要求测试补齐它们纯属噪音。
 */
export interface NetworkInterfaceEntry {
  readonly address: string
  readonly family: string | number
  readonly internal: boolean
}

/** 网卡取值函数；默认 `os.networkInterfaces`。抛错 = 推导失败。 */
export type NetworkInterfacesReader = () => Partial<Record<string, readonly NetworkInterfaceEntry[] | undefined>>

/** 推导所需的两个外部输入（都可注入，便于测试"网卡变化"与"取不到网卡"）。 */
export interface LanTrustSources {
  readonly networkInterfaces?: NetworkInterfacesReader
  /** 本机 hostname 取值函数；默认 `os.hostname`。 */
  readonly hostname?: () => string
}

/** 一次推导的结果快照（**每个请求都要重新取一次**）。 */
export interface LanTrustSnapshot {
  /** 本机非内部 IPv4 字面量（已排序，便于断言与展示）。 */
  readonly addresses: readonly string[]
  /** 本机 hostname 的精确匹配集合（已小写；含裸名与 `<裸名>.local`）。 */
  readonly hostnames: readonly string[]
  /** 网卡是否真的取到了（false ⇒ 本次推导失败，只剩静态列表可用）。 */
  readonly derived: boolean
  /** 推导失败的原因（进自检，便于排障）。 */
  readonly error?: string
}

/**
 * 本机 hostname 的精确匹配集合。
 *
 * macOS 的 `os.hostname()` 本身就带 `.local`（实测 `Mac-mini-2024.local`），
 * 直接拼 `.local` 会得到 `Mac-mini-2024.local.local`，所以先取裸名再统一拼。
 * 与 `scripts/make-cert.mjs` 里 SAN 的算法**必须一致**：证书里写了什么名字，
 * 这里就放行什么名字，否则会出现"证书认这个地址、闸门不认"。
 */
export function localHostNames(rawHostname?: string): string[] {
  const raw = (rawHostname ?? safeHostname()).trim().toLowerCase()
  if (raw === '') return []
  const bare = raw.replace(/\.local$/i, '')
  if (bare === '') return []
  return [...new Set([bare, `${bare}.local`])]
}

/** `os.hostname()` 抛错时不至于把整个插件带下去（推导是尽力而为）。 */
function safeHostname(): string {
  try {
    return osHostname()
  } catch {
    return ''
  }
}

/**
 * 本机**机器名** ✓（形如 `Mac-mini-2024.local`）—— manifest 的可选 `machineName` 用它 ✓。
 *
 * ## 为什么要单独抽一个函数（而不是在调用处各写一份）
 *
 * "机器名从哪来"必须**只有一处实现** ✓：这里与 `localHostNames()` 共用同一个取值口
 * （`safeHostname` ✓）。它在 `lan-trust.ts` 里而不是调用方那边，是因为"本机 hostname
 * 怎么处理"这件事本来就归这个模块管 ✓（证书 SAN、信任推导、面板补名字三处必须是同一个名字 ✓）。
 *
 * ## 形态（三种情况都说清，别猜 ✗）
 *
 *   · 已经带点（macOS 的 `Mac-mini-2024.local` ✓、或完整域名 ✓）⇒ **原样返回** ✓ ——
 *     "名字真的会被广播/解析"的形态就是它自己 ✓；
 *   · 裸名 + **macOS**（`platform === 'darwin'`）⇒ 补成 `<裸名>.local` ✓ ——
 *     Bonjour/mDNS 广播的就是这个名字 ✓（与 `scripts/make-cert.mjs` 里证书 SAN 的约定一致 ✓）；
 *   · ★ 裸名 + **Windows / Linux** ⇒ **原样返回** ✗，**不补** `.local` ✗ ——
 *     Windows 的 `os.hostname()` 是 `DESKTOP-ABC1234` 这种裸名 ✓（实测见交接文档 §4.1af ✓），
 *     补出来的 `DESKTOP-ABC1234.local` 在那台机器上**根本不解析** ✗，
 *     而它正是要拿去当**面板行名给人看**的 ✓ ⇒ 补了就是给用户看一个假名字 ✗。
 *
 * ★ 平台要**显式传进来**（默认 `os.platform()` ✓）：这是"显示名对不对"的判据之一 ✓，
 *   而单测必须在任何一台开发机上都得到同一个结论 ✗（不许把开发机的平台偷偷带进断言 ✗）。
 *
 * ★ 大小写**保持 `os.hostname()` 的原样** ✓（这是给人看的机器名 ✓）；
 *   信任匹配集合 `localHostNames()` 才做小写归一 ✓（那是判据，不是展示 ✗）—— 两者目的不同，
 *   刻意不合并，但取值口是同一个 ✓。
 *
 * ★ 拿不到（`os.hostname()` 抛错 / 空）⇒ 返回**空串** ✓ ⇒ 调用方**省略这个键** ✓
 *   （绝不写 `undefined` 或空串 ✗ —— 那会把"没有"和"有但为空"混成一件事 ✗）。
 */
export function localMachineName(rawHostname?: string, platform: string = osPlatformName()): string {
  const raw = (rawHostname ?? safeHostname()).trim().replace(/\.$/, '')
  if (raw === '') return ''
  // 已经带点 ⇒ 原样（`.local` 与完整域名都属于"这个名字本来就存在"）
  if (raw.includes('.')) return raw
  // 裸名：只有 macOS 才补 `.local`（Bonjour 广播的就是它）；Windows/Linux 补了不解析 ⇒ 原样
  return platform === 'darwin' ? `${raw}.local` : raw
}

/**
 * 推导一次信任快照。
 *
 * 纯函数 + 可注入 ⇒ 单测可以演"网卡从 A 变成 B"（同一份代码、同一个宿主对象，
 * 两次调用得到不同结论），这正是"换网立刻生效"的可执行证据。
 */
export function deriveLanTrust(sources: LanTrustSources = {}): LanTrustSnapshot {
  const hostnames = localHostNames(sources.hostname?.())
  const read = sources.networkInterfaces ?? osNetworkInterfaces
  try {
    const table = read()
    const addresses: string[] = []
    for (const entries of Object.values(table ?? {})) {
      for (const entry of entries ?? []) {
        if (entry === undefined || entry === null) continue
        // `internal` 为真 = 回环/内部地址，由 isLoopbackHostname 单独处理，不重复纳入
        if (entry.internal === true) continue
        // 只收 IPv4：IPv6 的 Host 是 `[addr]` 形态，与这里的裸地址形态不同，
        // 混进来只会得到"永远匹配不上"的假条目（IPv6 走静态列表 / 中继那条路）。
        if (entry.family !== 'IPv4' && entry.family !== 4) continue
        if (typeof entry.address !== 'string' || entry.address.length === 0) continue
        addresses.push(entry.address.toLowerCase())
      }
    }
    addresses.sort()
    return { addresses, hostnames, derived: true }
  } catch (error) {
    return {
      addresses: [],
      hostnames,
      derived: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * Host 是不是一个 **IP 字面量**。
 *
 * `parseAuthority` 走 WHATWG URL，IPv6 出来是带方括号的（`[2001:db8::1]`），
 * IPv4 是点分四段；宿主名不可能含 `:`。判据必须与"本机 IP 集合"的形态对齐，
 * 否则会出现"网关里写了却匹配不上"这种最难查的静默 403。
 */
export function isIpLiteralHostname(hostname: string): boolean {
  if (hostname.startsWith('[') && hostname.endsWith(']')) return true
  if (hostname.includes(':')) return true
  const parts = hostname.split('.')
  if (parts.length !== 4) return false
  return parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

/**
 * 用推导结果判定一个 authority 是否可信。
 *
 * 两条**互斥**的路：
 *   ① Host 是 IP 字面量 ⇒ 与本机地址集合做字符串比较；
 *   ② Host 是名字 ⇒ 只做本机 hostname 的精确匹配。
 * 绝不解析名字（见文件头注释）。
 */
export function matchesDerivedTrust(authority: { readonly hostname: string }, snapshot: LanTrustSnapshot): boolean {
  const hostname = authority.hostname.toLowerCase()
  if (isIpLiteralHostname(hostname)) {
    return snapshot.addresses.includes(hostname)
  }
  return snapshot.hostnames.includes(hostname)
}
