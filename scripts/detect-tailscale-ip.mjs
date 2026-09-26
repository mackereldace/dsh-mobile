#!/usr/bin/env node
/**
 * 找出本机可用于**经 Tailscale 直连**的 IPv4 地址，打印一个（没有则什么都不打印）。
 *
 * ## 它解决什么问题
 *
 * 手机在校外（蜂窝网、别人家的 Wi-Fi）时，局域网地址必然连不上，公网 IPv6 也不是
 * 每张卡都有。Tailscale 是最省事的一级：两边登录同一账号，手机就能用 `100.x.y.z`
 * 回到本机，再由本机已有的 TLS 反向代理（`*:3443`）落地。
 * 电脑侧要做的事只有两件，都写进插件配置：
 *   · 该 authority 进 `trustedHosts` —— 否则 DSH 的 `/api` 信任栅栏直接 **403**；
 *   · 该基地址进 `extraEndpoints` —— 手机侧才会把它当**候选端点**按序自动尝试
 *     （客户端 `deriveTunnelUrls`，手机代码不用改）。
 * 这个脚本负责第一步里的"地址"从哪来：**可靠地找到那个 100.x.y.z**。
 *
 * 顺带澄清一条容易记错、又容易被"顺手改坏"的事：**Tailscale 的地址不需要写进 TLS 证书的 SAN**。
 * 自签证书的 SAN 里只有局域网 IP，普通浏览器打开 `https://100.x.y.z:3443` 会报主机名不匹配
 * （点一次"继续访问"即可）；但**我们自己的 Android 外壳不校验主机名** ——
 * `MainActivity.onReceivedSslError` 只做一件事：拿这张自签 CA 再验一遍链，通过就放行
 * （等于把这张 CA 当唯一信任根）。所以换 Tailscale、换 IPv6、换任何地址都照样能过，
 * **不要**为此重新签发证书（那会牵动一份正在用的凭据）。
 *
 * ## 取舍：为什么优先问 CLI，而不是直接翻网卡
 *
 * Tailscale 有两种跑法，网卡视角完全不同：
 *   · 内核态（能建 utun 接口）—— `ifconfig` 里能看到 `utun*` 上的 100.64/10 地址；
 *   · **用户态**（`--tun=userspace-networking`，macOS 上以 App 形态装的默认就是它）——
 *     **根本没有这个网络接口**，地址只活在 tailscaled 进程里，`ifconfig` 一无所获。
 * 所以顺序是"先 CLI、后网卡"：`tailscale ip -4` 两种模式都能答，用户态时补一个
 * `--socket=/tmp/tailscaled.sock` 就能连上本机守护进程（先不带 socket 试，失败再带，
 * 因为有权限装内核态时 socket 参数反而可能被拒）。只有 CLI 全都不可用
 * （没装、守护进程没起、非 macOS 的 `ifconfig` 缺失）才去 `ifconfig` 里翻，
 * 并且**必须校验网段** —— 100.64.0.0/10 也是运营商级 NAT（CGNAT）在用的段，
 * 不校验就可能把别的地址当成 Tailscale 广告给手机。
 *
 * ## 用法
 *
 *   node scripts/detect-tailscale-ip.mjs          # 打印 100.x.y.z；没有则输出为空、退出码 0
 *   DSH_TAILSCALE_IP=100.64.1.2 node scripts/detect-tailscale-ip.mjs   # 显式覆盖（调试/测试用）
 *
 * 输出**严格只有** `a.b.c.d`（不带换行之外的任何文字），调用方会直接把它拼进 authority。
 * 调用方（`restart-lan.sh`）在 `set -euo pipefail` 下用 `$(... || true)` 取值：
 * **探测不到不是错误**，只是"这台机器现在没有 Tailscale 这条路"，整段跳过即可。
 */

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'

/** Tailscale 网段：100.64.0.0/10 —— 即 100.64.x.x ～ 100.127.x.x（也是 CGNAT 用的段）。 */
const TAILSCALE_SECOND_OCTET_MIN = 64
const TAILSCALE_SECOND_OCTET_MAX = 127

/**
 * Tailscale CLI 的候选位置，按"先通用、后 macOS 特有"排：
 *   1. `tailscale` —— PATH 里能找到就用（brew / 手工装 / 内核态守护进程的常见情形）；
 *   2. App 内置的可执行文件 —— macOS 上以图形 App 安装时**不会**往 PATH 里放命令；
 *   3. Homebrew 的固定路径 —— 某些 shell（launchd 给的环境）PATH 极简，找不到 1。
 */
const TAILSCALE_CLI_CANDIDATES = [
  'tailscale',
  '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
  '/opt/homebrew/bin/tailscale',
]

/** 用户态模式的守护进程 socket（`--tun=userspace-networking` 时的默认位置）。 */
const USERSPACE_SOCKET = '/tmp/tailscaled.sock'

/** 严格校验 `a.b.c.d`，再确认它落在 100.64.0.0/10 —— 两步缺一不可。 */
function isTailscaleIpv4(value) {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value)
  if (match === null) return false
  const parts = match.slice(1).map(Number)
  if (parts.some((part) => part > 255)) return false
  const [first, second] = parts
  return first === 100 && second >= TAILSCALE_SECOND_OCTET_MIN && second <= TAILSCALE_SECOND_OCTET_MAX
}

/** 从命令输出里取第一行合法地址（CLI 正常只输出一行，多行时取第一条）。 */
function firstAddressIn(text) {
  for (const line of text.split('\n')) {
    const address = line.trim()
    if (isTailscaleIpv4(address)) return address
  }
  return undefined
}

/**
 * 跑一条 CLI 变体。
 *
 * 命令不存在（ENOENT）、守护进程没起（`failed to connect to local tailscaled`）、
 * 超时，全都归为"这条路不可用" —— 交给下一个候选，调用方不该因此看到错误。
 * 加 `timeout` 是有意的：本脚本在 `restart-lan.sh` 的关键路径上，
 * 宁可 5 秒放弃，也不能让重启卡在一个不肯退出的子进程上。
 */
function runCli(command, args) {
  try {
    const text = execFileSync(command, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    })
    return firstAddressIn(text)
  } catch {
    return undefined
  }
}

/**
 * 依次问 CLI。
 * 每个命令都先**不带** `--socket` 试一次；只有存在用户态 socket 时才补带一次 ——
 * 两种部署模式的唯一区别就在这里（见文件头的"取舍"）。
 */
function fromCli() {
  const plain = ['ip', '-4']
  const variants = existsSync(USERSPACE_SOCKET)
    ? [plain, [`--socket=${USERSPACE_SOCKET}`, ...plain]]
    : [plain]
  for (const command of TAILSCALE_CLI_CANDIDATES) {
    for (const args of variants) {
      const address = runCli(command, args)
      if (address !== undefined) return address
    }
  }
  return undefined
}

/**
 * 兜底：翻 `ifconfig`（macOS/Linux）。
 *
 * 只在 CLI 不可用时才有意义 —— 例如内核态装了但守护进程没起，接口还留着。
 * 相关行形如：
 *   inet 100.101.102.103 netmask 0xffffffff ...
 * 这里**不做接口名过滤**（用户态没有 utun，内核态接口名也不保证是 utun）：
 * 网段校验已经足够把非 Tailscale 的地址挡在外面。
 */
function fromIfconfig() {
  try {
    const text = execFileSync('ifconfig', [], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    })
    for (const line of text.split('\n')) {
      const match = /^\s+inet\s+([0-9]+\.[0-9]+\.[0-9]+\.[0-9]+)/.exec(line)
      if (match !== null && isTailscaleIpv4(match[1])) return match[1]
    }
  } catch {
    /* 没有 ifconfig（非 POSIX 平台）：就当这条路也不可用 */
  }
  return undefined
}

// ── 取值顺序：显式覆盖 → CLI → ifconfig ────────────────────────────────
const override = process.env.DSH_TAILSCALE_IP
if (override !== undefined && override.length > 0) {
  // ★ 覆盖是**权威**的：给了但格式/网段不对时只提示、**不打印**，也不回退去探测。
  //   否则"我明明指定了地址，手机却拿到另一个"会变成最难查的一类问题。
  if (isTailscaleIpv4(override)) {
    process.stdout.write(override)
  } else {
    process.stderr.write(
      `[detect-tailscale-ip] DSH_TAILSCALE_IP=${override} 不是 100.64.0.0/10 网段的 IPv4 地址，已忽略（本次不输出地址）\n`,
    )
  }
} else {
  const address = fromCli() ?? fromIfconfig()
  if (address !== undefined) process.stdout.write(address)
}
