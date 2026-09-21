/**
 * 探测本机可用于局域网访问的 IPv4 地址。
 *
 * ## 为什么需要这个模块，而不是"取第一个非内部地址"
 *
 * 真实踩坑：`start-lan.sh` 原来就是"第一个非 internal 的 IPv4"，在一台同时有
 * 多个接口的 Mac 上选中了 `en0` 的 **169.254.31.222**——那是 DHCP 没拿到地址时的
 * **自分配（APIPA / link-local）** 地址，只能在本地链路内勉强通信，手机根本连不上。
 * 而真正可用的地址在 `en1`（`10.34.221.181`）。结果是：脚本打印了一个"奇怪的 IP"，
 * 手机照着连必然失败，且失败原因完全看不出来。
 *
 * 同一台机器上还可能有 `bridge100`（互联网共享网桥，192.168.2.1）这类
 * **不该被选中的虚拟接口**——它不是用户所在的那个局域网。
 *
 * ## 排序规则（先排除，再按可用性打分）
 *
 * 排除：
 *  - 回环（127.0.0.0/8）；
 *  - **link-local 169.254.0.0/16**（APIPA，本机没拿到 DHCP 的标志）；
 *  - 虚拟/隧道接口：`bridge*`、`utun*`、`awdl*`、`llw*`、`gif*`、`stf*`、`anpi*`（Mac 的伴生接口）。
 *
 * 打分（越小越优先）：
 *  0. 常见的家庭/办公私网：`192.168.0.0/16`、`10.0.0.0/8`
 *  1. 运营商级 NAT：`100.64.0.0/10`
 *  2. 172.16.0.0/12（同样是私网，但常被虚拟化软件占用，故排在后面）
 *  3. 其它公网地址
 *
 * 同分时按**接口名的字典序**取第一个，保证同一台机器上结果稳定（不会每次启动换一个）。
 *
 * @returns {Array<{ address: string, iface: string, score: number }>} 按优先级升序
 */
import { networkInterfaces } from 'node:os'
import { pathToFileURL } from 'node:url'

/** 不应被选为"局域网访问地址"的接口名前缀。 */
const VIRTUAL_INTERFACE_PREFIXES = ['bridge', 'utun', 'awdl', 'llw', 'gif', 'stf', 'anpi', 'lo']

/** 明显不是"局域网私有地址"的网段（回环与 APIPA）。 */
function isUnusable(address) {
  const parts = address.split('.').map(Number)
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true
  const [a, b] = parts
  if (a === 127) return true // 回环
  if (a === 169 && b === 254) return true // APIPA：DHCP 失败的自分配地址
  if (a === 0) return true
  return false
}

/** 可用性打分：越小越优先。 */
function scoreOf(address) {
  const [a, b] = address.split('.').map(Number)
  if (a === 192 && b === 168) return 0
  if (a === 10) return 0
  if (a === 100 && b >= 64 && b <= 127) return 1 // 100.64/10，运营商级 NAT
  if (a === 172 && b >= 16 && b <= 31) return 2
  return 3
}

/**
 * 列出候选地址（已按可用性排序）。
 * @returns {Array<{ address: string, iface: string, score: number }>}
 */
export function listLanCandidates() {
  const out = []
  for (const [iface, addresses] of Object.entries(networkInterfaces())) {
    if (VIRTUAL_INTERFACE_PREFIXES.some((prefix) => iface.startsWith(prefix))) continue
    for (const entry of addresses ?? []) {
      if (entry.internal) continue
      if (entry.family !== 'IPv4') continue
      if (isUnusable(entry.address)) continue
      out.push({ address: entry.address, iface, score: scoreOf(entry.address) })
    }
  }
  out.sort((left, right) => left.score - right.score || left.iface.localeCompare(right.iface))
  return out
}

/**
 * 选出最可能可用的局域网地址。
 * @returns {string | undefined} 找不到时返回 undefined（调用方应让用户显式指定 LAN_IP）
 */
export function detectLanIp() {
  return listLanCandidates()[0]?.address
}

/**
 * 被排除掉的地址（用于提示"为什么没选它"）。
 * @returns {Array<{ address: string, iface: string, reason: string }>}
 */
export function listRejected() {
  const out = []
  for (const [iface, addresses] of Object.entries(networkInterfaces())) {
    for (const entry of addresses ?? []) {
      if (entry.internal) continue
      if (entry.family !== 'IPv4') continue
      if (VIRTUAL_INTERFACE_PREFIXES.some((prefix) => iface.startsWith(prefix))) {
        out.push({ address: entry.address, iface, reason: '虚拟/隧道接口' })
      } else if (isUnusable(entry.address)) {
        out.push({
          address: entry.address,
          iface,
          reason: entry.address.startsWith('169.254.') ? '自分配地址（DHCP 未获取到）' : '回环/保留地址',
        })
      }
    }
  }
  return out
}

// 作为 CLI 直接运行时：打印选中的地址（供 shell 脚本取用），诊断信息走 stderr。
//
// 入口判断必须用 pathToFileURL 比较：手写 `file://${process.argv[1]}` 在**相对路径**调用时
// 不成立（argv[1] 是 `scripts/detect-lan-ip.mjs`，拼出来是 `file://scripts/...`，
// 而 import.meta.url 是 `file:///Volumes/...`），于是 CLI 分支被静默跳过、只输出空行。
const isDirectRun =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (isDirectRun) {
  const args = process.argv.slice(2)
  if (args.includes('--explain')) {
    const chosen = detectLanIp()
    console.error(`选中      : ${chosen ?? '(无)'}`)
    for (const candidate of listLanCandidates()) {
      console.error(`  候选    : ${candidate.address} (${candidate.iface}, 优先级 ${candidate.score})`)
    }
    for (const rejected of listRejected()) {
      console.error(`  已排除  : ${rejected.address} (${rejected.iface}) —— ${rejected.reason}`)
    }
  } else {
    const chosen = detectLanIp()
    if (chosen !== undefined) process.stdout.write(chosen)
  }
}
