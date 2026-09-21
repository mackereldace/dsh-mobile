#!/usr/bin/env node
/**
 * 找出本机可用于**公网 IPv6 直连**的全局地址，打印一个（没有则什么都不打印）。
 *
 * ## 它解决什么问题
 *
 * 手机在蜂窝网上拿到的往往就是 IPv6 地址。电脑只要有**全局** IPv6，手机就能直连——
 * 这条路不需要服务器、不需要域名，是"互联网互通"里成本最低的一级。
 * 但地址要写进插件的 `trustedHosts`（带方括号），所以得先把它可靠地找出来。
 *
 * ## 取舍：优先**稳定**地址，而不是临时地址
 *
 * macOS 的隐私扩展会同时给出两个全局地址：
 *   · `secured`   —— 稳定地址（由接口标识派生，长期不变）
 *   · `temporary` —— 临时地址（默认每天轮换）
 * 把**临时**地址写进配置，第二天就会失效，表现为"昨天还能远程，今天 403"——
 * 极难排查。所以这里优先取稳定地址；`ifconfig` 不可用时退回第一个全局地址，
 * 并在 stderr 说明这一点（调用方可以据此提示用户）。
 *
 * 注意：**即使用的是稳定地址**，运营商重新分配前缀时它也会变——
 * 所以 `restart-lan.sh` 每次都会重新探测并重装配置，不需要手工维护。
 *
 * 用法：node scripts/detect-lan-ipv6.mjs
 */

import { execFileSync } from 'node:child_process'
import { networkInterfaces } from 'node:os'

/** 不应被选为"公网直连地址"的接口名前缀（与 detect-lan-ip.mjs 保持一致）。 */
const VIRTUAL_INTERFACE_PREFIXES = ['bridge', 'utun', 'awdl', 'llw', 'gif', 'stf', 'anpi', 'lo']

/** 是否是可用的全局 IPv6：排除回环、链路本地（fe80）、唯一本地（fc/fd）。 */
function isUsableGlobal(address) {
  const lower = address.toLowerCase().split('%')[0] // 去掉 `%en0` 这种 scope
  if (lower === '::1') return false
  if (lower.startsWith('fe80')) return false // 链路本地：只在同一段链路内有效
  if (lower.startsWith('fc') || lower.startsWith('fd')) return false // ULA：不能公网路由
  return /^[0-9a-f:]+$/.test(lower) && lower.includes(':')
}

/**
 * 从 `ifconfig` 输出里找出**非临时**的全局 IPv6（macOS）。
 *
 * 输出的相关行形如：
 *   inet6 2001:da8:203:cc10:1893:4887:e495:ecb6 prefixlen 64 autoconf secured
 *   inet6 2001:da8:203:cc10:acbb:3b87:5df2:e2ae prefixlen 64 autoconf temporary
 *
 * @returns {string | undefined}
 */
function stableFromIfconfig() {
  try {
    const text = execFileSync('ifconfig', [], { encoding: 'utf8' })
    for (const line of text.split('\n')) {
      if (!/\binet6\b/.test(line)) continue
      if (/\btemporary\b/.test(line)) continue
      const match = /\binet6\s+([0-9a-fA-F:]+)/.exec(line)
      if (match !== null && isUsableGlobal(match[1])) return match[1]
    }
  } catch {
    /* 没有 ifconfig（如 Linux/Windows）：交给下面的通用兜底 */
  }
  return undefined
}

/** 通用兜底：从 networkInterfaces() 里取第一个全局 IPv6。 */
function anyGlobal() {
  for (const [name, addresses] of Object.entries(networkInterfaces())) {
    if (VIRTUAL_INTERFACE_PREFIXES.some((prefix) => name.startsWith(prefix))) continue
    for (const entry of addresses ?? []) {
      if (entry.family !== 'IPv6') continue
      if (entry.internal === true) continue
      if (isUsableGlobal(entry.address)) return entry.address.split('%')[0]
    }
  }
  return undefined
}

const stable = stableFromIfconfig()
if (stable !== undefined) {
  process.stdout.write(stable)
} else {
  const fallback = anyGlobal()
  if (fallback !== undefined) {
    // 明确说出来：兜底拿到的可能是临时地址，写进配置会随轮换失效
    process.stderr.write('[detect-lan-ipv6] 未能确认稳定地址，退回第一个全局 IPv6（可能是临时地址，会轮换）\n')
    process.stdout.write(fallback)
  }
}
