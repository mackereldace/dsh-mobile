/**
 * 机器专属配置的**推导** ✓ —— 为的是让"装完即用"成立。
 *
 * ## 为什么需要它 ✗（这是官方插件管理那条路上的一个真空）
 *
 * 我们的包是 **bundle** ✓：`dsh.bundle.patch` 指向自带的 `cordis.patch.yml` ✓，
 * 装完之后**那一行会自动并进配置** ✓。但那一行**只有 `id` 与 `name`** ✗ ——
 * 而 `trustedHosts` / `publicBaseUrl` / `phoneBaseUrl` / `listener` **属于这台机器**
 * （局域网地址、端口、有没有 Tailscale 各不相同 ✓），bundle **绝不能写死** ✗。
 * ⇒ 走官方那条路装完的人，拿到的是"**插件在跑、手机连不上**"✗
 *   （症状还特别像"插件坏了"✓，很难猜到是少了这几行 ✓）。
 *
 * 自研安装器（`scripts/install-host-plugin.mjs`）当年是**自己推导**这几项再写进 profile 的 ✓；
 * 官方那条路没有它 ⇒ 这里把同一件事做进**插件自己** ✓：
 * **没配就用这台机器的实际地址补上** ✓，并**把补了什么说出来** ✓。
 *
 * ## 三条纪律（与全项目同一条 ✓）
 *
 * 1. **只补缺** ✗：用户配过的，**一个字都不动** ✓（包括空字符串也算"没配"✓）；
 * 2. **不猜** ✗：探测不到本机地址 ⇒ **什么都不填** ✓（保持老行为 ✓），绝不编一个地址 ✗；
 * 3. **说出来** ✗：每一处推导都进 {@link MachineConfigResult.derived} ✓
 *    （人话 ✓，调用方打日志 ⇒ 出问题时用户能念出来 ✓）。
 *
 * 刻意**零依赖**（只吃字符串与地址数组 ✓）⇒ 电脑上可断言 ✓（见 `test/machine-config.test.ts` ✓）。
 */

/** 本机的一个候选地址 ✓（来自 `listLanCandidates()` ✓）。 */
export interface MachineCandidate {
  address: string
}

/** 插件配置里**属于这台机器**的那几项 ✓（都可能是 undefined ✓）。 */
export interface MachineConfigShape {
  trustedHosts?: string[]
  publicBaseUrl?: string
  phoneBaseUrl?: string
  extraEndpoints?: string[]
  listener?: {
    enabled?: boolean
    plain?: string
    tls?: string
  }
}

/** 推导结果 ✓（端口一律落地成具体值 ✓；`derived` 是给人念的 ✓）。 */
export interface MachineConfigResult {
  trustedHosts: string[]
  publicBaseUrl?: string
  phoneBaseUrl?: string
  /** 随配对票据下发的**额外端点** ✓（★ 必须含 **https** 那条 ✗ —— 见下面的说明 ✓）。 */
  extraEndpoints: string[]
  listener: { enabled: boolean; plain: string; tls: string }
  /** 每一句都是"没配 X ⇒ 按探测结果用 Y"✓（**给日志用** ✓）。 */
  derived: string[]
}

/** `0.0.0.0:3081` ⇒ `3081` ✓（取不到就回空串 ✓，绝不猜端口 ✗）。 */
export function portOfListen(value: string | undefined): string {
  if (value === undefined) return ''
  const text = value.trim()
  const at = text.lastIndexOf(':')
  if (at < 0) return ''
  const port = text.slice(at + 1).trim()
  return /^[0-9]+$/.test(port) ? port : ''
}

/** 这一项**算没配**吗 ✓（undefined 与空串都算 ✓）。 */
function blank(value: string | undefined): boolean {
  return value === undefined || value.trim().length === 0
}

/**
 * ★★ 配置里的地址**已经不在本机网卡上**了吗 ✓（2026-10-28 用户实测逼出来的）。
 *
 * 背景：校园网 DHCP 换地址（`10.34.255.229` → `10.34.128.67` ✓）之后，
 * profile 里那四行还是旧 IP ✗ ⇒ 插件照旧**广告**旧地址 ✗ ⇒ 手机按旧地址连
 * ⇒ `ERR_CONNECTION_REFUSED / TIMED_OUT` ⇒ 用户看到「局域网突然连不上、只能走 Tailscale」✗
 * （本机 10-28 实测：旧 IP `curl` 超时、新 IP 200 ✓）。
 *
 * 判据只碰**IPv4 字面量** ✓：
 *   · DNS 名（`xxx.local` / DDNS ✓）**不判** ✗ —— 它可能合法地解析到本机 ✓；
 *   · IPv6 也不判 ✓（本机候选地址目前只有 IPv4 ✓，不扩大范围 ✗）；
 *   · 探测不到任何本机地址 ⇒ **不判、不改** ✓（绝不猜 ✗）。
 *
 * ★ 只改**运行时**的广告/信任（`publicBaseUrl` / `phoneBaseUrl` / `extraEndpoints` /
 *   `trustedHosts` 的返回值 ✓）—— **不写配置文件** ✗、不偷偷改用户的设置 ✓；
 *   每一处替换都进 `derived`（启动日志能念出来 ✓）。
 */
function urlHostOf(value: string): string | undefined {
  try {
    const host = new URL(value).hostname
    return host.length === 0 ? undefined : host.toLowerCase()
  } catch (error) {
    void error
    return undefined
  }
}

/** IPv4 字面量 ✓（其余一律 false ✓——见上面的判据 ✓）。 */
function isIpv4Literal(host: string): boolean {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)
}

/** 这个 URL 的 host 是 IPv4、且不在 `addresses` 里 ⇒ 过期 ✓（其余情况一律"不判"✗）。 */
function isStaleIpv4Url(value: string | undefined, addresses: readonly string[]): boolean {
  if (value === undefined || blank(value) || addresses.length === 0) return false
  const host = urlHostOf(value)
  if (host === undefined || !isIpv4Literal(host)) return false
  return !addresses.includes(host)
}

/** 把 URL 的 host 换成 `address` ✓（端口/协议原样 ✓；坏 URL ⇒ undefined ✓）。 */
function withHost(value: string, address: string): string | undefined {
  try {
    const url = new URL(value)
    url.hostname = address
    const text = url.toString()
    return text.endsWith('/') ? text.slice(0, -1) : text
  } catch (error) {
    void error
    return undefined
  }
}

/**
 * 推导一次 ✓。
 *
 * @param config 用户给的（可能只给了一部分 ✓）
 * @param options `candidates` = 本机地址 ✓（探测不到就给空数组 ⇒ 那就什么都不补 ✓）
 *                `defaultPlain` / `defaultTls` = 与监听器**同一套**默认端口 ✓（别另立一套 ✗）
 */
export function resolveMachineConfig(
  config: MachineConfigShape,
  options: { candidates: MachineCandidate[]; defaultPlain: string; defaultTls: string },
): MachineConfigResult {
  const derived: string[] = []
  const plain = config.listener?.plain ?? options.defaultPlain
  const tls = config.listener?.tls ?? options.defaultTls
  /**
   * ★★★ 2026-10-04（用户："这个第一步必须我做吗，不能安装的时候直接弄好吗"✗）：
   *   **监听的默认值从"关"翻成"开"** ✓ —— 理由是：这个插件的**全部意义**就是让手机连进来 ✓，
   *   装完却在偷听 0 个端口 ✗ 是**更让人意外**的默认 ✓（而且症状是"手机连不上"✗，
   *   看起来像插件坏了 ✓ —— 用户今天就正好被这一步绊住 ✓）。
   * ★ 只翻转**缺省** ✗：**显式 `enabled: false` 一律尊重** ✓
   *   （老部署的 config 里通常写着 `enabled: true` 或 `false` ✓ ⇒ 行为一字不变 ✓；
   *    本机实测就是显式 `true` ✓）。
   * ★ 而且**必须喊出来** ✓（下面 derived 里那条 ✓）—— 开端口这种事不许悄悄做 ✗。
   */
  const listenerEnabled = config.listener?.enabled !== false
  if (config.listener?.enabled === undefined) {
    derived.push(`没配 listener.enabled ⇒ **默认开启局域网监听**（${plain} 与 ${tls}）；`
      + '不想要就在你的 config 里写 listener: { enabled: false }')
  }
  const plainPort = portOfListen(plain)
  const tlsPort = portOfListen(tls)
  const addresses = options.candidates
    .map((candidate) => (candidate.address ?? '').trim())
    .filter((address) => address.length > 0)

  // ① trustedHosts：用户给了就一个字不动 ✓
  let trustedHosts = Array.isArray(config.trustedHosts) ? config.trustedHosts.slice() : []
  if (trustedHosts.length === 0) {
    if (addresses.length > 0 && plainPort.length > 0 && tlsPort.length > 0) {
      for (const address of addresses) trustedHosts.push(`${address}:${plainPort}`, `${address}:${tlsPort}`)
      derived.push(`没配 trustedHosts ⇒ 按本机地址用 ${addresses.join(' / ')}（端口 ${plainPort} 与 ${tlsPort}）`)
    } else if (addresses.length > 0) {
      derived.push('没配 trustedHosts，但监听端口读不出来 ⇒ 这一项不补（不猜 ✗）')
    }
  }

  // ② publicBaseUrl（明文那条，给电脑上的浏览器用 ✓）
  let publicBaseUrl = blank(config.publicBaseUrl) ? undefined : config.publicBaseUrl
  if (publicBaseUrl === undefined && addresses.length > 0 && plainPort.length > 0) {
    publicBaseUrl = `http://${addresses[0]}:${plainPort}`
    derived.push(`没配 publicBaseUrl ⇒ 用 http://${addresses[0]}:${plainPort}`)
  }

  // ③ phoneBaseUrl（手机该用的那条 ✓，一定是 https ✓）
  let phoneBaseUrl = blank(config.phoneBaseUrl) ? undefined : config.phoneBaseUrl
  if (phoneBaseUrl === undefined && addresses.length > 0 && tlsPort.length > 0) {
    phoneBaseUrl = `https://${addresses[0]}:${tlsPort}`
    derived.push(`没配 phoneBaseUrl ⇒ 用 https://${addresses[0]}:${tlsPort}`)
  }

  /**
   * ★★ 过期地址自愈（2026-10-28，见 `isStaleIpv4Url` 的长注释 ✓）。
   *
   * 只在"配置里**有** IPv4 字面量、而它**不在**当前网卡上"时动手 ✓：
   *   · `publicBaseUrl` / `phoneBaseUrl` ⇒ 换成**当前地址**（端口/协议不动 ✓）；
   *   · `trustedHosts` ⇒ 追加当前地址的两条（旧条目保留 ✓，不删用户配置 ✗）；
   *   · `extraEndpoints` ⇒ 追加当前地址的 https 那条（见下面 ✓）。
   * 每条替换都进 `derived` ✓（启动日志里能念出来 ✓）。
   */
  const configPublic = blank(config.publicBaseUrl) ? undefined : config.publicBaseUrl
  const configPhone = blank(config.phoneBaseUrl) ? undefined : config.phoneBaseUrl
  const configExtra = Array.isArray(config.extraEndpoints) ? config.extraEndpoints : []
  const stalePublic = isStaleIpv4Url(configPublic, addresses)
  const stalePhone = isStaleIpv4Url(configPhone, addresses)
  const staleExtra = configExtra.some((url) => isStaleIpv4Url(url, addresses))
  const staleTrusted = trustedHosts.some((entry) => {
    if (addresses.length === 0) return false
    const at = entry.lastIndexOf(':')
    const host = (at > 0 ? entry.slice(0, at) : entry).toLowerCase()
    return isIpv4Literal(host) && !addresses.includes(host)
  })
  const staleConfigured = stalePublic || stalePhone || staleExtra || staleTrusted
  if (staleConfigured && addresses.length > 0) {
    if (stalePublic && publicBaseUrl !== undefined) {
      const replaced = withHost(publicBaseUrl, addresses[0]!)
      if (replaced !== undefined) {
        derived.push(`配置的 publicBaseUrl ${publicBaseUrl} 已不在本机网卡上（现在 ${addresses.join(' / ')}）⇒ 本次广告改用 ${replaced}（配置文件未改）`)
        publicBaseUrl = replaced
      }
    }
    if (stalePhone && phoneBaseUrl !== undefined) {
      const replaced = withHost(phoneBaseUrl, addresses[0]!)
      if (replaced !== undefined) {
        derived.push(`配置的 phoneBaseUrl ${phoneBaseUrl} 已不在本机网卡上 ⇒ 本次广告改用 ${replaced}（配置文件未改）`)
        phoneBaseUrl = replaced
      }
    }
    const addedTrusted: string[] = []
    for (const address of addresses) {
      for (const port of [plainPort, tlsPort]) {
        if (port.length === 0) continue
        const entry = `${address}:${port}`
        if (trustedHosts.includes(entry)) continue
        trustedHosts.push(entry)
        addedTrusted.push(entry)
      }
    }
    if (addedTrusted.length > 0) {
      derived.push(`配置里有过期地址 ⇒ 运行时信任补上当前地址：${addedTrusted.join(' / ')}（配置文件未改）`)
    }
  }

  /**
   * ★★★ 2026-10-04 **真机逼出来的**（用户在新电脑上扫码配对：不弹信任框、不出新卡片、提示"重连"✗）：
   *   票据里下发给手机的端点 = `publicBaseUrl`（**明文 http** ✗）+ `extraEndpoints` ✓。
   *   而**手机 App 是 https-only** ✓（禁明文 ✓）⇒ 只广告明文 ⇒ 手机拿到的第一条候选
   *   **连 TLS 都开始不了** ✗ ⇒ 不弹 TOFU ✓ ⇒ 退回旧候选 ⇒ 用户看到"配对失败/重连" ✓✓。
   *   ★ 本机（Mac）一直没事 ✗，是因为**自研安装器**当年替它写了 `extraEndpoints: ['https://…:3453']` ✓
   *     —— 我上轮做自推导时**漏了这一项** ✗，于是新装的机器就中了 ✓。
   * ⇒ 补上：**每个本机地址的 https 那条** ✓（含 `phoneBaseUrl` ✓，去重 ✓，顺序保持 ✓）。
   * ★ 只补缺 ✗：用户写了 `extraEndpoints` 就一个字不动 ✓。
   */
  let extraEndpoints = Array.isArray(config.extraEndpoints) ? config.extraEndpoints.slice() : []
  if (extraEndpoints.length === 0 && tlsPort.length > 0) {
    const wanted: string[] = []
    if (phoneBaseUrl !== undefined) wanted.push(phoneBaseUrl)
    for (const address of addresses) wanted.push(`https://${address}:${tlsPort}`)
    for (const url of wanted) {
      if (!extraEndpoints.includes(url)) extraEndpoints.push(url)
    }
    if (extraEndpoints.length > 0) {
      derived.push(`没配 extraEndpoints ⇒ 按 https 那条补上 ${extraEndpoints.join(' / ')}（手机只走 https ✓，'
        + '只广告明文会让它连不上 ✓）`)
    }
  }

  /**
   * ★ 过期地址那一种：`extraEndpoints` 里全是旧 IP 时，**运行时候选**补上当前地址 ✓
   * （配置文件不动 ✓）。不这么做，票据里第一条 https 仍是旧 IP ⇒ 手机先白等一轮 ✗。
   */
  if (staleConfigured && addresses.length > 0 && tlsPort.length > 0) {
    const addedEndpoints: string[] = []
    const wanted: string[] = []
    if (phoneBaseUrl !== undefined) wanted.push(phoneBaseUrl)
    for (const address of addresses) wanted.push(`https://${address}:${tlsPort}`)
    for (const url of wanted) {
      if (extraEndpoints.includes(url)) continue
      extraEndpoints.push(url)
      addedEndpoints.push(url)
    }
    if (addedEndpoints.length > 0) {
      derived.push(`配置里有过期地址 ⇒ 运行时候选补上当前地址：${addedEndpoints.join(' / ')}（配置文件未改）`)
    }
  }

  return {
    trustedHosts,
    ...(publicBaseUrl === undefined ? {} : { publicBaseUrl }),
    ...(phoneBaseUrl === undefined ? {} : { phoneBaseUrl }),
    extraEndpoints,
    listener: { enabled: listenerEnabled, plain, tls },
    derived,
  }
}
