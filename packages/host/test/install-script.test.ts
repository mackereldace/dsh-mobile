/**
 * 安装脚本写配置的回归测试。
 *
 * ## 为什么值得单独测一个 shell 脚本的行为
 *
 * `install-host-plugin.mjs` 写 `cordis.patch.yml` 是**覆盖式**的：它按本次参数
 * 重新生成整个配置块。对 `trustedHosts` 这类"本来就该随地址重算"的键这是对的，
 * 但对**与地址无关**的键就是灾难。同一类事故已经发生过**三次**：
 *
 *   1. `restart-lan.sh` 只传一个 authority → 覆盖式写入把 `3443` 抹掉
 *      → 手机走 3443 被栅栏 403 → **"一直重连中"**；
 *   2. 同一次还把 `phoneBaseUrl` 抹掉 → 手机配对时拿到明文 HTTP 地址；
 *   3. 中继上线后，只要跑一次 `restart-lan.sh`，`relayUrl` / `relayToken` 就会被抹掉
 *      → **远程访问静默失效**（这一条是本测试诞生的直接原因）。
 *
 * 三次都不是"逻辑写错"，而是"以为只改 A、其实顺手删了 B"。
 * 所以这里把**两类键的预期行为**都钉死：
 *   · 与地址相关的（trustedHosts / publicBaseUrl / phoneBaseUrl）→ **必须跟着变**；
 *   · 与地址无关的（relayUrl / relayToken / extraEndpoints / relayPoolSize）→ **必须留住**。
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { load } from 'js-yaml'

const repoRoot = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))))
const installer = join(repoRoot, 'scripts', 'install-host-plugin.mjs')

let home = ''

/** 每个用例自带的临时家目录（用例之间不靠"上一个留下的配置"过日子）。 */
const tempHomes: string[] = []

before(() => {
  home = mkdtempSync(join(tmpdir(), 'dshm-install-'))
  // 安装脚本要求 profile 目录已存在（真实流程里由 DSH 首次启动创建）
  mkdirSync(join(home, 'profiles', 'web'), { recursive: true })
})

after(() => {
  rmSync(home, { recursive: true, force: true })
  for (const dir of tempHomes) rmSync(dir, { recursive: true, force: true })
})

/** 新建一个隔离的临时家目录。 */
function freshHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dshm-install-'))
  mkdirSync(join(dir, 'profiles', 'web'), { recursive: true })
  tempHomes.push(dir)
  return dir
}

/** 跑一次安装（verify 会尝试真实加载 DSH，测试里跳过）。 */
function install(...extra: string[]): void {
  installInto(home, extra)
}

/** 在指定家目录里跑安装。 */
function installInto(homeDir: string, extra: string[]): void {
  execFileSync(
    process.execPath,
    [
      installer,
      '--dsh-home', homeDir,
      '--profile', 'web',
      '--skip-verify',
      ...extra,
    ],
    { stdio: 'ignore' },
  )
}

const patchPath = (homeDir: string = home): string => join(homeDir, 'profiles', 'web', 'cordis.patch.yml')
const patchText = (homeDir: string = home): string => readFileSync(patchPath(homeDir), 'utf8')

/**
 * 用**真实 YAML 解析**读回插件配置。
 *
 * 顺序 / 去重 / 数量这类断言光靠正则容易写出"恰好通过"的假绿 —— 而这几条要守的
 * 恰恰是"顺序被改了"这种正则看不出来的回归。
 */
function readConfig(homeDir: string = home): Record<string, unknown> {
  const parsed = load(patchText(homeDir)) as Array<Record<string, unknown>>
  const row = parsed.find((item) => Array.isArray(item?.insert))
  const insert = (row?.insert ?? []) as Array<Record<string, unknown>>
  const host = insert.find((entry) => entry?.name === '@dsh-mobile/host')
  return (host?.config ?? {}) as Record<string, unknown>
}

const trustedHosts = (homeDir: string = home): string[] =>
  (readConfig(homeDir).trustedHosts ?? []) as string[]

const extraEndpoints = (homeDir: string = home): string[] =>
  (readConfig(homeDir).extraEndpoints ?? []) as string[]

describe('install-host-plugin：与地址无关的配置必须被保留', () => {
  it('带上中继参数安装后，四项中继配置都在', () => {
    install(
      '--trusted-host', '10.0.0.5:3081',
      '--trusted-host', '10.0.0.5:3443',
      '--phone-base-url', 'https://10.0.0.5:3443',
      '--relay-url', 'wss://relay.example.com/attach',
      '--relay-token', 'tok-123',
      '--relay-pool-size', '2',
      '--extra-endpoint', 'https://relay.example.com',
    )
    const text = patchText()
    assert.match(text, /relayUrl: 'wss:\/\/relay\.example\.com\/attach'/)
    assert.match(text, /relayToken: 'tok-123'/)
    assert.match(text, /relayPoolSize: 2/)
    assert.match(text, /extraEndpoints:\n\s+- 'https:\/\/relay\.example\.com'/)
  })

  it('★ 再用「不带中继参数」的方式重装（restart-lan.sh 就是这样）→ 中继配置必须原样留住', () => {
    install('--trusted-host', '10.0.0.5:3081', '--trusted-host', '10.0.0.5:3443', '--phone-base-url', 'https://10.0.0.5:3443')
    const text = patchText()
    assert.match(text, /relayUrl: 'wss:\/\/relay\.example\.com\/attach'/, 'relayUrl 被抹掉了')
    assert.match(text, /relayToken: 'tok-123'/, 'relayToken 被抹掉了')
    assert.match(text, /relayPoolSize: 2/, 'relayPoolSize 被抹掉了')
    assert.match(text, /extraEndpoints:[\s\S]*relay\.example\.com/, 'extraEndpoints 被抹掉了')
  })

  it('与地址相关的配置必须**跟着变**（别把保留写成了"什么都不更新"）', () => {
    install('--trusted-host', '192.168.1.9:3081', '--trusted-host', '192.168.1.9:3443', '--phone-base-url', 'https://192.168.1.9:3443')
    const text = patchText()
    assert.match(text, /192\.168\.1\.9:3443/)
    assert.doesNotMatch(text, /10\.0\.0\.5:3443/, '旧的 authority 应该被换掉')
    // 而中继那几项仍然不动
    assert.match(text, /relayUrl: 'wss:\/\/relay\.example\.com\/attach'/)
  })

  it('显式传 --relay-url 时可以更换中继（保留不等于不能改）', () => {
    install(
      '--trusted-host', '192.168.1.9:3081',
      '--trusted-host', '192.168.1.9:3443',
      '--phone-base-url', 'https://192.168.1.9:3443',
      '--relay-url', 'wss://relay2.example.com/attach',
    )
    assert.match(patchText(), /relayUrl: 'wss:\/\/relay2\.example\.com\/attach'/)
  })
})

/**
 * 不变量：**凡是被广告出去的 endpoint，其 authority 必须同时在 `trustedHosts` 里。**
 *
 * 这两份配置来自不同的键：`extraEndpoints` 是"给手机试的候选端点"（保留式），
 * `trustedHosts` 是"DSH 栅栏放行的 authority"。只要两者脱节，手机按候选取到
 * 那个 endpoint 就会吃到 **403**，表现是"一直重连中"，而电脑端看配置一切正常。
 *
 * 第四条用例守的是最容易复发的那一面：`restart-lan.sh` 每次重装都**不带**
 * `--extra-endpoint`（中继那条靠保留），所以"第二次安装"必须既留住端点、
 * 也留住它的 trust。第五条守的是"为 Tailscale 传 --extra-endpoint 时
 * 不能把中继那条挤掉"（同一类覆盖式事故的第四次）。
 */
describe('install-host-plugin：被广告出去的 endpoint 必须同时在 trustedHosts 里', () => {
  it('★ --extra-endpoint https://100.64.1.2:3443 ⇒ trustedHosts 里必须有它的 authority', () => {
    const dir = freshHome()
    installInto(dir, [
      '--trusted-host', '10.0.0.5:3081',
      '--trusted-host', '10.0.0.5:3443',
      '--extra-endpoint', 'https://100.64.1.2:3443',
      // 同一个端点给两遍：派生必须**去重**
      '--extra-endpoint', 'https://100.64.1.2:3443',
    ])
    assert.deepEqual(trustedHosts(dir), ['10.0.0.5:3081', '10.0.0.5:3443', '100.64.1.2:3443'])
    assert.deepEqual(extraEndpoints(dir), ['https://100.64.1.2:3443'])
  })

  it('★ 派生的 authority 只能**追加在显式 --trusted-host 之后**，publicBaseUrl 仍按第一条推导', () => {
    const dir = freshHome()
    installInto(dir, [
      '--trusted-host', '192.168.7.7:3081',
      '--trusted-host', '192.168.7.7:3443',
      '--phone-base-url', 'https://192.168.7.7:3443',
      '--extra-endpoint', 'https://100.64.9.9:3443',
    ])
    // 顺序本身就是契约：插到最前面会把 publicBaseUrl（配对码里嵌的地址）换掉
    assert.deepEqual(trustedHosts(dir), ['192.168.7.7:3081', '192.168.7.7:3443', '100.64.9.9:3443'])
    assert.equal(readConfig(dir).publicBaseUrl, 'http://192.168.7.7:3081', 'publicBaseUrl 必须仍按第一条推导')
    assert.equal(readConfig(dir).phoneBaseUrl, 'https://192.168.7.7:3443')
  })

  it('--extra-endpoint wss://relay.example.com/attach ⇒ **不**产生新的 trustedHost', () => {
    const dir = freshHome()
    installInto(dir, [
      '--trusted-host', '10.0.0.5:3081',
      '--extra-endpoint', 'wss://relay.example.com/attach',
    ])
    // 中继拓扑下手机只连中继，中继经回环回源；域名不需要进 trust（见 07 号文档的结论）
    assert.deepEqual(trustedHosts(dir), ['10.0.0.5:3081'])
    assert.deepEqual(extraEndpoints(dir), ['wss://relay.example.com/attach'])
  })

  it('★ 已存在的 extraEndpoint 再用「不带 --extra-endpoint」重装 ⇒ 端点仍在，且它的 trust 也在', () => {
    const dir = freshHome()
    installInto(dir, [
      '--trusted-host', '10.0.0.5:3081',
      '--trusted-host', '10.0.0.5:3443',
      '--extra-endpoint', 'https://relay.example.com',
    ])
    // restart-lan.sh 就是这个形态：只重算地址，不带端点参数
    installInto(dir, ['--trusted-host', '10.0.0.5:3081', '--trusted-host', '10.0.0.5:3443'])
    assert.deepEqual(extraEndpoints(dir), ['https://relay.example.com'], 'extraEndpoints 被抹掉了')
    assert.deepEqual(trustedHosts(dir), ['10.0.0.5:3081', '10.0.0.5:3443', 'relay.example.com'])
  })

  it('★ 为 Tailscale 传 --extra-endpoint 时，中继那条 https 端点不能被挤掉（纯追加合并）', () => {
    const dir = freshHome()
    installInto(dir, [
      '--trusted-host', '10.0.0.5:3081',
      '--trusted-host', '10.0.0.5:3443',
      '--extra-endpoint', 'https://relay.example.com',
    ])
    installInto(dir, [
      '--trusted-host', '10.0.0.5:3081',
      '--trusted-host', '10.0.0.5:3443',
      '--extra-endpoint', 'https://100.64.1.2:3443',
    ])
    assert.deepEqual(extraEndpoints(dir), ['https://relay.example.com', 'https://100.64.1.2:3443'])
    assert.deepEqual(trustedHosts(dir), ['10.0.0.5:3081', '10.0.0.5:3443', 'relay.example.com', '100.64.1.2:3443'])
  })

  /**
   * ★★ 回归（round 129 修 ✓）：**list 里 ≥2 条时，读回只抓第 1 条** ✗。
   *
   * ## 为什么上面那条 ★ 用例一直是绿的（"假绿"的成因，值得记 ✗）
   *
   * 它（relay → TS）在第二次安装时，`extraEndpoints` 里**只有 1 条** ✗ ——
   * 旧实现的"只抓第 1 条"恰好等于"全抓" ✓，所以它**从来没碰到这个 bug** ✗。
   * 也就是说：那条用例守的是"端点会不会被**整体抹掉**" ✓，
   * 而"**第 2 条起会不会被悄悄吞掉**"从来没人守 ✗ ⇒ 测试全绿、配置却在缩水 ✓。
   *
   * 要触发它，只需要一次"list 里已经有 ≥2 条"的重装 ✓（第三次安装、
   * 或任何一次多端点配置下的重装 ✓）—— 而本轮 `restart-lan.sh` 正是一次
   * 广告**两条**（学校 HTTPS + Tailscale ✓）✗ ⇒ 第 2 条会在下一次重装时静默消失 ✗
   * ⇒ 用户要的"两个默认链接"自己退化成一条 ✗。
   *
   * 成因（`readPreservedKeys`）：旧实现用一条大正则读列表，组内 `\s*` 会把**换行**
   * 也吃掉 ⇒ 第 1 项之后迭代就断了 ✗。现在改成与 `trustedHosts` 同形态的逐行循环 ✓。
   */
  it('★ list 里已有 ≥2 条 extraEndpoints 时「不带 --extra-endpoint」重装 ⇒ 一条都不许丢', () => {
    const dir = freshHome()
    installInto(dir, [
      '--trusted-host', '10.0.0.5:3081',
      '--trusted-host', '10.0.0.5:3443',
      '--extra-endpoint', 'https://100.64.1.2:3443',
      '--extra-endpoint', 'https://relay.example.com',
    ])
    assert.deepEqual(extraEndpoints(dir), ['https://100.64.1.2:3443', 'https://relay.example.com'])
    // restart-lan.sh 的形态：只重算地址、一条 --extra-endpoint 都不带
    // ⇒ 保留式合并必须把**两条都**留下（旧实现到这里只剩第 1 条）
    installInto(dir, ['--trusted-host', '10.0.0.5:3081', '--trusted-host', '10.0.0.5:3443'])
    assert.deepEqual(
      extraEndpoints(dir),
      ['https://100.64.1.2:3443', 'https://relay.example.com'],
      '第 2 条起被丢掉了（旧实现的大正则只抓得回第 1 条）',
    )
  })

  it('★★ 本轮真实顺序：Tailscale → 中继 → 学校+Tailscale（restart-lan 形态）⇒ 三条都在，中继不被挤掉', () => {
    const dir = freshHome()
    // ① 今天线上的形态：只有 Tailscale 一条
    installInto(dir, [
      '--trusted-host', '10.34.255.229:3081',
      '--trusted-host', '10.34.255.229:3443',
      '--extra-endpoint', 'https://100.123.136.82:3443',
    ])
    // ② deploy-relay.sh 的形态：再加中继那条 ⇒ 它落在**第 2 位**
    //    （正是旧实现会丢掉的那个位置 ✗ —— 我那次的实测就是这个顺序）
    installInto(dir, [
      '--trusted-host', '10.34.255.229:3081',
      '--trusted-host', '10.34.255.229:3443',
      '--relay-url', 'wss://relay.example.com/attach',
      '--relay-token', 'tok-123',
      '--extra-endpoint', 'https://relay.example.com',
    ])
    assert.deepEqual(extraEndpoints(dir), ['https://100.123.136.82:3443', 'https://relay.example.com'])
    // ③ 本轮 restart-lan.sh：学校 HTTPS + Tailscale **两条都当参数重传**
    installInto(dir, [
      '--trusted-host', '10.34.255.229:3081',
      '--trusted-host', '10.34.255.229:3443',
      '--extra-endpoint', 'https://100.123.136.82:3443',
      '--extra-endpoint', 'https://10.34.255.229:3443',
    ])
    assert.deepEqual(
      extraEndpoints(dir),
      ['https://100.123.136.82:3443', 'https://relay.example.com', 'https://10.34.255.229:3443'],
      '中继端点被静默挤掉了（旧实现只抓第 1 条）—— 这会让"两个槽"退化成一条',
    )
    // 中继的标量键走的是另一条路（逐键 scalar），也必须照旧留住
    assert.equal(readConfig(dir).relayUrl, 'wss://relay.example.com/attach')
    assert.equal(readConfig(dir).relayToken, 'tok-123')
    // publicBaseUrl 仍按 trustedHosts[0] 推导（学校端点没把它顶掉）
    assert.equal(readConfig(dir).publicBaseUrl, 'http://10.34.255.229:3081')
  })

  /**
   * ★ 顺手核对（round 129）：`trustedHosts` 的逐行循环对**带方括号的 IPv6** 也成立 ✓。
   *
   * 起因：真实配置里就有 `'[2001:da8:203:cc10:1037:78ee:82ec:47e8]:3443'` 这一条 ✓
   * （手机走蜂窝 IPv6 时用它 ✓）—— 解析器要是把方括号吃坏，
   * 它会在下一次重装时静默消失 ✗，表现是"手机在蜂窝网下连不上"✗。
   * 这里守两条路：显式写入 ✓ + **沿用路径**（一个 `--trusted-host` 都不给 ✓）。
   */
  it('★ 带方括号的 IPv6 authority 在「沿用已有受信列表」这条路上原样保留（别把它读坏）', () => {
    const dir = freshHome()
    const ipv6 = '[2001:da8:203:cc10:1037:78ee:82ec:47e8]:3443'
    installInto(dir, [
      '--trusted-host', '10.34.255.229:3081',
      '--trusted-host', '10.34.255.229:3443',
      '--trusted-host', ipv6,
    ])
    assert.deepEqual(trustedHosts(dir), ['10.34.255.229:3081', '10.34.255.229:3443', ipv6])
    // 沿用路径：这一轮一个 --trusted-host 都不给 ⇒ 逐行循环必须把方括号那条也读回来
    installInto(dir, [])
    assert.deepEqual(trustedHosts(dir), ['10.34.255.229:3081', '10.34.255.229:3443', ipv6], 'IPv6 那条被读丢了')
  })
})
