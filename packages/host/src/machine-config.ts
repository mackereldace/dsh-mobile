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

  return {
    trustedHosts,
    ...(publicBaseUrl === undefined ? {} : { publicBaseUrl }),
    ...(phoneBaseUrl === undefined ? {} : { phoneBaseUrl }),
    listener: { enabled: config.listener?.enabled === true, plain, tls },
    derived,
  }
}
