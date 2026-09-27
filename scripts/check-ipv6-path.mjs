#!/usr/bin/env node
/**
 * IPv6 直连验收：**用公网 IPv6 地址访问手机入口，应当拿到 200**。
 *
 * ## 它补的是哪一跳
 *
 * IPv6 直连这条路（不需要服务器、不需要域名）此前是**逐环节**验过的：
 * 探测稳定地址 ✓、配置写入形态 ✓、栅栏匹配 ✓（单元测试）、
 * IPv6 传输通路 ✓（IPv6 与 IPv4 返回相同的 403，证明请求到达了插件）。
 * 唯独"合起来能不能拿到 200"没验——那需要一台**信任该 authority** 的 DSH 在跑，
 * 而生产实例不该为了测试重启。
 *
 * 所以这里**起一个临时实例**（自己的 DSH_HOME + 自己装插件，与 e2e-pairing 同一套做法），
 * 把 IPv6 authority 写进去，再从本机用公网 IPv6 访问它。**全程不碰生产。**
 *
 * ## 用法
 *
 *   node scripts/check-ipv6-path.mjs
 *
 * 退出码 0 = 通；1 = 不通（此时应看 §16 的说明：多半是上游不放行入站 IPv6，退回中继）。
 */

import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { explainMissingDsh, resolveDsh } from './resolve-dsh.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const PROXY_PORT = Number(process.env['IPV6_PROXY_PORT'] ?? 3901)
const TLS_PORT = Number(process.env['IPV6_TLS_PORT'] ?? 3943)
/**
 * ★★ 局域网 IP **必须动态探测** ✗ —— 这里原来回退到写死的 `10.34.221.181` ✓。
 *   与 `e2e-pairing.mjs`、`check-mobile-layout.mjs:33`、`ui-preview.mjs` 是**同一个坑** ✓
 *   （那台机器换过一次 DHCP 地址 ⇒ 写死的旧地址不通 ⇒ 临时实例只信任旧 authority ✗ ⇒ 断言全红 ✓，
 *   而**看起来**像被测功能坏了 ✗）。仍然支持 `IPV6_LAN_IP` 覆盖 ✓（调试用 ✓）。
 */
const LAN_IP =
  process.env['IPV6_LAN_IP'] ?? (await import(join(here, 'detect-lan-ip.mjs'))).detectLanIp()
if (LAN_IP === undefined || LAN_IP.length === 0) {
  console.error(
    '[check-ipv6-path] 探测不到局域网 IP ⇒ 拒绝继续（**绝不回退到一个可能过期的旧地址** ✗）\n' +
      '                 请显式指定：IPV6_LAN_IP=<你的局域网 IP> node scripts/check-ipv6-path.mjs',
  )
  process.exit(1)
}
const PHONE_IP = process.env['IPV6_PHONE_IP'] ?? '10.33.129.145' // 仅用于 x-forwarded-for
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const problems = []
const ok = (condition, label, detail) => {
  console.log(`  ${condition ? '✓' : '✗'} ${label}${detail === undefined ? '' : `（${detail}）`}`)
  if (!condition) problems.push(label)
}

const spawned = []
const kill = (child) => {
  if (child?.pid === undefined) return
  try {
    process.kill(-child.pid, 'SIGKILL')
  } catch {
    try {
      child.kill('SIGKILL')
    } catch {
      /* 已退出 */
    }
  }
}

let home
try {
  // ① 探测本机全局 IPv6（与 restart-lan.sh 用的是同一个脚本，保证口径一致）
  let ipv6 = ''
  try {
    ipv6 = execFileSync(process.execPath, [join(here, 'detect-lan-ipv6.mjs')], { encoding: 'utf8' }).trim()
  } catch {
    ipv6 = ''
  }
  ok(ipv6.length > 0, '本机有可用的全局 IPv6', ipv6 || '没有')
  if (ipv6 === '') {
    console.log('\n  没有全局 IPv6 → 这条路不可用（中继仍是备选）')
    process.exit(1)
  }
  const V6_AUTHORITY = `[${ipv6}]:${TLS_PORT}`

  // ② 临时实例：自己的家目录 + 自己装插件（**不碰生产**）
  home = mkdtempSync(join(tmpdir(), 'ipv6-path-'))
  mkdirSync(join(home, 'profiles', 'web'), { recursive: true })
  execFileSync(
    process.execPath,
    [
      join(here, 'install-host-plugin.mjs'),
      '--dsh-home', home,
      '--profile', 'web',
      // 两个族都要装：IPv4 的**代理端口**与**TLS 端口**（对照用），以及 IPv6 的 TLS 端口。
      // 只装代理端口会让 IPv4 对照拿到 403 —— 那是我第一版的错，不是链路问题；
      // 反过来说，这也证明了那个 200 确实由 IPv6 authority 带来。
      '--trusted-host', `${LAN_IP}:${PROXY_PORT}`,
      '--trusted-host', `${LAN_IP}:${TLS_PORT}`,
      '--trusted-host', V6_AUTHORITY,
      '--phone-base-url', `https://${LAN_IP}:${TLS_PORT}`,
      '--skip-verify',
    ],
    { cwd: here, stdio: 'ignore' },
  )
  ok(true, '已把 IPv6 authority 装进临时实例', V6_AUTHORITY)

  const dshBin = resolveDsh()
  if (dshBin === undefined) {
    console.error(explainMissingDsh('check-ipv6-path'))
    process.exit(1)
  }
  // ★ 必须带 IPv6 authority。原先这里只带 IPv4 —— 于是**脚本的写法与线上那个 bug 一模一样**，
  //   插件路由在 IPv6 上通、DSH 的 /api 却 403，而本脚本永远绿 ✓（测试与被测对象同错）。
  const dsh = spawn(
    dshBin,
    [
      'web',
      '--port', String(PROXY_PORT - 1),
      // 三个 authority 一个都不能少，**与生产的启动命令保持一致**：
      // 明文端口、TLS 端口、IPv6 的 TLS 端口。少任何一个，本脚本就会在
      // "测试环境比生产少配一条" 的情况下变绿（这次的 403 就是这么冒出来的）。
      '--trusted-host', `${LAN_IP}:${PROXY_PORT}`,
      '--trusted-host', `${LAN_IP}:${TLS_PORT}`,
      '--trusted-host', V6_AUTHORITY,
      '--no-open',
    ],
    {
    cwd: home,
    env: { ...process.env, DSH_HOME: home },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    },
  )
  spawned.push(dsh)
  let dshOut = ''
  dsh.stdout?.on('data', (chunk) => (dshOut += chunk))
  dsh.stderr?.on('data', (chunk) => (dshOut += chunk))

  const tlsDir = join(process.env['HOME'] ?? '', '.dsh/storages/dsh-mobile/tls')
  const proxy = spawn(
    process.execPath,
    [
      join(here, 'lan-proxy.mjs'),
      '--listen', `0.0.0.0:${PROXY_PORT}`,
      '--target', `127.0.0.1:${PROXY_PORT - 1}`,
      '--tls-listen', `0.0.0.0:${TLS_PORT}`,
      '--cert', join(tlsDir, 'lan-cert.pem'),
      '--key', join(tlsDir, 'lan-key.pem'),
    ],
    { stdio: ['ignore', 'pipe', 'pipe'], detached: true },
  )
  spawned.push(proxy)
  let proxyOut = ''
  proxy.stdout?.on('data', (chunk) => (proxyOut += chunk))
  proxy.stderr?.on('data', (chunk) => (proxyOut += chunk))

  let ready = false
  for (let i = 0; i < 60; i++) {
    await sleep(1000)
    try {
      if ((await fetch(`http://127.0.0.1:${PROXY_PORT - 1}/mobile/manifest`)).ok) {
        ready = true
        break
      }
    } catch {
      /* 还没起来 */
    }
  }
  ok(ready, '临时 DSH 就绪')
  ok(/IPv6 监听/.test(proxyOut), '代理已在监听 IPv6', proxyOut.split('\n').find((l) => /IPv6/.test(l))?.trim() ?? '未见')

  // ③ 关键一跳：用**公网 IPv6** 访问手机入口（手机身份）
  const call = (host) => {
    try {
      return execFileSync(
        'curl',
        ['-sk', '-o', '/dev/null', '-w', '%{http_code}', '-m', '10', '-H', `x-forwarded-for: ${PHONE_IP}`, `https://${host}/mobile/manifest`],
        { encoding: 'utf8' },
      ).trim()
    } catch (error) {
      return `curl失败:${String(error?.message ?? error).slice(0, 40)}`
    }
  }
  const v6Code = call(`[${ipv6}]:${TLS_PORT}`)
  const v4Code = call(`${LAN_IP}:${TLS_PORT}`)
  ok(v6Code === '200', '经公网 IPv6 访问手机入口拿到 200（这条路真的能用）', `HTTP ${v6Code}`)
  ok(v4Code === '200', '对照：经局域网 IPv4 也是 200（两个地址族等价）', `HTTP ${v4Code}`)

  // ④ DSH 自身的 `/api` 信任栅栏：**IPv6 是独立的一条配置**，必须单独断言。
  //    为什么单独测：插件的 `/mobile/*` 与 DSH 的 `/api` 由**两套** trustedHosts 决定
  //    （插件那份在 cordis 配置里，DSH 那份在 `--trusted-host` 命令行里）。
  //    真实故障：只配了插件那一半 —— `/mobile/app` 拿 200、`/api` 却 403 forbidden，
  //    手机在蜂窝网走 IPv6 时业务调用全被拒。而本脚本原先的写法与那个 bug 一致，
  //    所以它一直是绿的（**测试与被测对象同错**，是这次最该记的一条）。
  const postApi = (host) => {
    try {
      return execFileSync(
        'curl',
        ['-sk', '-o', '/dev/null', '-w', '%{http_code}', '-m', '10', '-H', `x-forwarded-for: ${PHONE_IP}`,
          '-H', 'content-type: application/json', '-X', 'POST', `https://${host}/api`, '-d', '{}'],
        { encoding: 'utf8' },
      ).trim()
    } catch (error) {
      return `curl失败:${String(error?.message ?? error).slice(0, 40)}`
    }
  }
  const v6Api = postApi(`[${ipv6}]:${TLS_PORT}`)
  const v4Api = postApi(`${LAN_IP}:${TLS_PORT}`)
  ok(v6Api !== '403', 'DSH 的 /api 栅栏放行 IPv6 authority（403 = 手机走 IPv6 时业务调用全被拒）', `HTTP ${v6Api}`)
  ok(v4Api !== '403', '对照：IPv4 的 /api 栅栏也放行', `HTTP ${v4Api}`)

  if (v6Code !== '200') {
    console.log('\n  排查提示：')
    console.log('    · 若 IPv4 也是 403 → 是 authority 没进 trustedHosts（看上面的配置写入）')
    console.log('    · 若 IPv4 是 200 而 IPv6 不是 → 本机 IPv6 监听/地址解析问题（本脚本会一并暴露）')
    console.log('    · 本脚本从**本机**访问自己的全局 IPv6，所以它验证的是"本机这条链通不通"；')
    console.log('      上游出口是否放行入站，仍需手机在蜂窝网上实测')
  }
} finally {
  for (const child of spawned.splice(0)) kill(child)
  await sleep(500)
  if (home !== undefined) rmSync(home, { recursive: true, force: true })
}

if (problems.length > 0) {
  console.error(`\n[check-ipv6-path] 未通过 ${problems.length} 项`)
  process.exit(1)
}
console.log('\n[check-ipv6-path] 通过：IPv6 直连链路在本机完全可用 ✓')
console.log('  下一步（唯一剩下的）：手机在蜂窝网打开 https://[<本机IPv6>]:' + TLS_PORT + '/mobile/app')
