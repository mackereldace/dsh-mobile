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
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
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
  // 共享家目录照旧手建 profile：下面这些既有用例守的是"配置合并语义"，
  // 与"profile 目录谁来建"无关（后者的专属用例是 bareHome()，见文件末尾）。
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

/**
 * ★ 改动 A 用的"全新机器"家目录：**连 `profiles/web` 都不建**。
 *
 * 只有这一条路径能测到改动 A —— `freshHome()` 会先手建那个目录，
 * 于是"安装器要不要自己建"这件事根本走不到（这正是三个验收夹具的旧做法）。
 */
function bareHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dshm-install-bare-'))
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

/**
 * 跑一次安装并**收集输出**（探测失败那条路径要断言"打警告但不失败"）。
 * 用 spawnSync 而不是 execFileSync：后者在非零退出时直接抛，拿不到 stderr 文案。
 */
function installIntoCaptured(homeDir: string, extra: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(
    process.execPath,
    [installer, '--dsh-home', homeDir, '--profile', 'web', '--skip-verify', ...extra],
    { encoding: 'utf8' },
  )
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
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

/**
 * C1：`listener`（插件进程内的局域网监听，把 `scripts/lan-proxy.mjs` 搬进插件）。
 *
 * 这里钉死两条**互相独立**的契约，它们分别对应两种真实事故：
 *
 *   1. **老部署的 patch 逐字节不变** —— 解析后 `enabled !== true` 时一个 `listener:` 块都不发。
 *      否则每次 `restart-lan.sh` 都会往生产配置里塞新键，插件默认关闭的语义就没了。
 *   2. **保留式合并** —— 这次命令行没给 listener 参数时，必须从现有配置里**读回**上次的值。
 *      本脚本是覆盖式重写，`restart-lan.sh` 每次重启都调用它 —— 少了读回就等于
 *      "跑一次重启 ⇒ 手机入口静默换端口/被关掉"（本项目已发生过三次的那类事故）。
 *      与 `relayUrl` / `extraEndpoints` 同一套语义（见文件头与 `readPreservedKeys` 的注释）。
 *
 * 另注：`--no-listener` 那条**只**断言"没有 enabled: true"，不去重复断言"不发块" ——
 * "不发块"这个形状由下面那条逐字节用例**唯一**守着，一个契约只在一个地方表达。
 */
/**
 * C1 之前（也即"老部署"）该调用形态下 patch 的**完整逐字节**内容。
 *
 * 之所以硬编码全文而不是只 `assert.doesNotMatch(/listener/)`：这轮改动的核心承诺是
 * "默认关闭 ⇒ 老部署的 patch **逐字节不变**"，只有全文比对才真的测到"逐字节"。
 * 它对 `patchBlock` 的注释文案同样敏感 —— 这是**故意**的：那段文案也是 patch 的一部分。
 */
const OLD_DEPLOYMENT_PATCH = [
  '# >>> dsh-mobile host plugin (managed by scripts/install-host-plugin.mjs) >>>',
  '# 手机端接入：/mobile/ws 加密隧道、配对与设备管理端点，并往 index.html 注入 boot.js。',
  '# 这条 insert 位于所有 bundle 层之后，因此 webServer / typertGateway 均已就绪。',
  '- insert:',
  '    - id: mobile-host',
  "      name: '@dsh-mobile/host'",
  '      config:',
  '        trustedHosts:',
  "          - '10.0.0.5:3081'",
  "          - '10.0.0.5:3443'",
  "        publicBaseUrl: 'http://10.0.0.5:3081'",
  '    # 预览桥（round 99）：把 DSH 自带的文档预览（KaTeX / PDF / 图片）暴露给手机外壳。',
  '    # 它**必须**在这里被声明 ✓ —— DSH 的客户端 bundle 注册要求"与 graph 行匹配" ✓，',
  '    # 只在页面里 load 是无效的 ✗（见 packages/bridge/lib/client.js 的说明）。',
  '    - id: mobile-preview-bridge',
  "      name: '@dsh-mobile/bridge'",
  '# <<< dsh-mobile host plugin <<<',
  '',
].join('\n')

describe('install-host-plugin：listener（C1，进程内监听）配置', () => {
  it('--listener 装上后，在 config: 下（8 空格缩进）写出 enabled/plain/tls', () => {
    const dir = freshHome()
    installInto(dir, [
      '--trusted-host', '10.0.0.5:3081',
      '--listener',
      '--listener-plain', '0.0.0.0:3081',
      '--listener-tls', '0.0.0.0:3443',
    ])
    assert.deepEqual(readConfig(dir).listener, { enabled: true, plain: '0.0.0.0:3081', tls: '0.0.0.0:3443' })
    // 形状/缩进本身也是契约（插件读的是 config.listener，位置错了就等于没配）
    assert.match(
      patchText(dir),
      /\n {8}listener:\n {10}enabled: true\n {10}plain: '0\.0\.0\.0:3081'\n {10}tls: '0\.0\.0\.0:3443'\n/,
      'listener 块的缩进或形状不对',
    )
  })

  it('--listener 不给 plain/tls ⇒ 用默认 0.0.0.0:3081 / 0.0.0.0:3443', () => {
    const dir = freshHome()
    installInto(dir, ['--trusted-host', '10.0.0.5:3081', '--listener'])
    assert.deepEqual(readConfig(dir).listener, { enabled: true, plain: '0.0.0.0:3081', tls: '0.0.0.0:3443' })
  })

  it('★★ 先 --listener 装、再「不带 listener 参数」重装（restart-lan.sh 就是这样）⇒ listener 配置必须原样留住', () => {
    const dir = freshHome()
    installInto(dir, [
      '--trusted-host', '10.0.0.5:3081',
      '--listener',
      '--listener-plain', '0.0.0.0:3081',
      '--listener-tls', '0.0.0.0:3443',
    ])
    // 这一轮一个 listener 参数都不给（覆盖式重写最容易在这里把上一轮的配置抹掉）
    installInto(dir, ['--trusted-host', '10.0.0.5:3081'])
    assert.deepEqual(
      readConfig(dir).listener,
      { enabled: true, plain: '0.0.0.0:3081', tls: '0.0.0.0:3443' },
      'listener 配置被抹掉了（没做保留式合并）',
    )
  })

  it('★ 重装只给 --listener（不给端口）⇒ 现有配置读回的端口留住，不被默认值顶掉', () => {
    const dir = freshHome()
    installInto(dir, [
      '--trusted-host', '10.0.0.5:3081',
      '--listener',
      '--listener-plain', '0.0.0.0:9999',
      '--listener-tls', '0.0.0.0:9998',
    ])
    installInto(dir, ['--trusted-host', '10.0.0.5:3081', '--listener'])
    assert.deepEqual(
      readConfig(dir).listener,
      { enabled: true, plain: '0.0.0.0:9999', tls: '0.0.0.0:9998' },
      '端口退回了默认值（「命令行 > 现有配置 > 默认」这条优先级被写错）',
    )
  })

  it('--no-listener 能覆盖掉现有的 enabled: true（关掉要真的生效）', () => {
    const dir = freshHome()
    installInto(dir, ['--trusted-host', '10.0.0.5:3081', '--listener'])
    installInto(dir, ['--trusted-host', '10.0.0.5:3081', '--no-listener'])
    const listener = readConfig(dir).listener as { enabled?: boolean } | undefined
    assert.notEqual(listener?.enabled, true, '--no-listener 没能覆盖已有配置里的 enabled: true')
  })

  it('★★ 老部署（从不带 listener 参数）的 patch 逐字节不变：一个 listener: 块都不发', () => {
    const dir = freshHome()
    installInto(dir, ['--trusted-host', '10.0.0.5:3081', '--trusted-host', '10.0.0.5:3443'])
    // 逐字节比对：这就是"默认关闭 ⇒ 老部署行为一字不变"的全部含义
    assert.equal(patchText(dir), OLD_DEPLOYMENT_PATCH, '老部署的 patch 被改动了（enabled !== true 时绝不能发 listener 块）')
    // 显式 --no-listener 同理：enabled 不是 true ⇒ 一个块都不发
    const off = freshHome()
    installInto(off, ['--trusted-host', '10.0.0.5:3081', '--no-listener'])
    assert.doesNotMatch(patchText(off), /^ {8}listener:\s*$/m, '--no-listener 仍写了 listener 块')
  })
})

/**
 * ★★ 换一台新机器（改动 A + 改动 B）。
 *
 * ## 两处实测出来的真问题
 *
 * **A：全新机器上"装插件"这一步直接失败** ✗。旧实现要求 `profiles/web` 已存在，
 * 并提示"请先用该 profile 启动一次 DSH"—— 而实测：在全新 `DSH_HOME` 上跑 `dsh web`，
 * DSH 正常起来、**并不会**创建那个目录（HOME 仍是空的）。也就是说 DSH 自己不需要它，
 * 是安装器多要求了一个目录，于是迁移的第一步就死在那里。
 * 旁证：三个验收夹具都各自 `mkdirSync(profiles/web)` 手建一次 —— 手建就够。
 *
 * **B：新机器签发的配对票据把手机指向一个到不了的地址** ✗。只传 `--listener` 时，
 * 票据 `endpoints` 落到 `http://<ip>:<DSH 端口>`（如 3711），而 DSH 只绑 `127.0.0.1`
 * ⇒ 手机根本连不上 ⇒ 配对必失败。手机该被指向的是**插件内的 TLS 监听**。
 *
 * ## 这几条用例守的契约
 *
 *   1. 缺 profile 目录 ⇒ **建**（但"构建产物存在性"那条检查不许被一起删掉）；
 *   2. 既没有命令行、也没有可沿用的 ⇒ 用 `--lan-ip` / 探测结果写出
 *      `trustedHosts`（明文 + TLS 两条）与 `phoneBaseUrl = https://<lan>:<TLS端口>`；
 *   3. `--no-lan-autodetect` ⇒ 退回"什么都不写"的旧行为；
 *   4. ★ **沿用语义不许被自动推导破坏**（有现有 trustedHosts 时仍沿用）；
 *   5. 探测失败 ⇒ **警告但不失败**（不静默、也不 fail）。
 *
 * ⚠️ 这几条一律用 `--lan-ip` 注入地址，**绝不依赖真机网络**（否则测试会在别的机器上随机红绿）；
 *    连"探测失败"也是注入的（`--lan-ip ''`），不是等真探测失败。
 */
describe('install-host-plugin：换新机器（profile 目录 + 手机入口地址自动推导）', () => {
  /**
   * ★ 改动 A 的唯一专属用例。
   * 其余新用例都用 `freshHome()`（profile 已建）—— 这样"没建目录"这条路径
   * 只有这一个用例覆盖，变异时读数才**恰好**是这一条红。
   */
  it('★ 全新 HOME（连 profiles/web 都没有）⇒ 安装成功，并替你建出 profile 目录', () => {
    const dir = bareHome()
    assert.equal(existsSync(join(dir, 'profiles', 'web')), false, '前置：这条用例的起点必须是空 HOME')
    installInto(dir, ['--trusted-host', '10.0.0.5:3081', '--no-lan-autodetect'])
    assert.ok(existsSync(join(dir, 'profiles', 'web')), 'profile 目录没被建出来（安装器又退回了 fail 行为）')
    assert.ok(existsSync(patchPath(dir)), 'cordis.patch.yml 没写出来')
    assert.deepEqual(trustedHosts(dir), ['10.0.0.5:3081'])
  })

  it('★★ 全新 HOME + --listener --lan-ip ⇒ trustedHosts 含明文/TLS 两条，phoneBaseUrl 是 https://<lan>:<TLS端口>', () => {
    const dir = freshHome()
    installInto(dir, [
      '--listener',
      '--lan-ip', '10.9.8.7',
      '--listener-plain', '0.0.0.0:3901',
      '--listener-tls', '0.0.0.0:3902',
    ])
    assert.deepEqual(trustedHosts(dir), ['10.9.8.7:3901', '10.9.8.7:3902'], '手机入口的两条 authority 没写出来')
    assert.equal(readConfig(dir).phoneBaseUrl, 'https://10.9.8.7:3902', 'phoneBaseUrl 必须是 https://<lan>:<TLS端口>')
    // ★ HTTPS 那条还必须进 extraEndpoints：票据的 endpoints = publicBaseUrl + extraEndpoints，
    //   而手机壳**跳过明文**端点 ⇒ 只写 publicBaseUrl 的话新机器票据里一条能用的 HTTPS 都没有。
    assert.deepEqual(extraEndpoints(dir), ['https://10.9.8.7:3902'], '票据端点里没有 HTTPS（手机壳会跳过明文那条）')
    // publicBaseUrl 的推导沿用旧逻辑（trustedHosts[0] + http）
    assert.equal(readConfig(dir).publicBaseUrl, 'http://10.9.8.7:3901')
    // listener 块本身照旧
    assert.deepEqual(readConfig(dir).listener, { enabled: true, plain: '0.0.0.0:3901', tls: '0.0.0.0:3902' })
  })

  it('★ 端口取自**本次解析出的** listener 端口（命令行 > 读回 > 默认）——不给端口时用默认 3081/3443', () => {
    const dir = freshHome()
    installInto(dir, ['--listener', '--lan-ip', '10.9.8.7'])
    assert.deepEqual(trustedHosts(dir), ['10.9.8.7:3081', '10.9.8.7:3443'], '默认 listener 端口没被用上（另算了一遍端口）')
    assert.equal(readConfig(dir).phoneBaseUrl, 'https://10.9.8.7:3443')
  })

  it('★ --no-lan-autodetect ⇒ 退回旧行为：trustedHosts / phoneBaseUrl 都不写', () => {
    const dir = freshHome()
    installInto(dir, [
      '--listener',
      '--listener-plain', '0.0.0.0:3901',
      '--listener-tls', '0.0.0.0:3902',
      '--no-lan-autodetect',
    ])
    assert.deepEqual(trustedHosts(dir), [], '--no-lan-autodetect 仍写了 trustedHosts')
    assert.equal(readConfig(dir).phoneBaseUrl, undefined, '--no-lan-autodetect 仍写了 phoneBaseUrl')
    assert.deepEqual(extraEndpoints(dir), [], '--no-lan-autodetect 仍写了 extraEndpoints')
    // 关掉的只是"推导"，listener 本身照旧要写
    assert.equal((readConfig(dir).listener as { enabled?: boolean } | undefined)?.enabled, true)
  })

  it('★ 给了 --trusted-host ⇒ 不做自动推导（不会多出探测地址那两条）', () => {
    const dir = freshHome()
    installInto(dir, [
      '--listener',
      '--lan-ip', '10.9.8.7',
      '--trusted-host', '10.0.0.5:3081',
      '--listener-plain', '0.0.0.0:3901',
    ])
    assert.deepEqual(trustedHosts(dir), ['10.0.0.5:3081'])
  })

  /**
   * ★★ **不破坏沿用**（改动 B 的护栏）。
   *
   * `restart-lan.sh` 每次重启都会重跑本脚本。已有配置时若拿探测/注入的地址去覆盖它，
   * 就不是"补上手机入口"而是"每次重启都可能把手机入口换掉" ✗ ——
   * 同一类覆盖式事故本项目已经发生过三次（见 readPreservedKeys 的长注释）。
   *
   * `--lan-ip` 是**刻意给的**：让变异 M3（无条件覆盖）在**任何网络环境下**都能确定性地红，
   * 而不是"恰好这台机器探测得到地址才红"。
   */
  it('★★ 已有 trustedHosts 时不传 --trusted-host ⇒ 仍然沿用（自动推导/--lan-ip 都不许顶掉它）', () => {
    const dir = freshHome()
    installInto(dir, [
      '--trusted-host', '10.34.255.229:3081',
      '--trusted-host', '10.34.255.229:3443',
      '--listener',
    ])
    // restart-lan.sh 的形态：这一轮不给 --trusted-host
    installInto(dir, ['--listener', '--lan-ip', '10.9.8.7'])
    assert.deepEqual(
      trustedHosts(dir),
      ['10.34.255.229:3081', '10.34.255.229:3443'],
      '沿用被自动推导覆盖了（这正是"跑一次重启就把手机入口抹掉"那类事故）',
    )
    // phoneBaseUrl 同理：沿用现有配置，不被推导值顶掉
    assert.equal(readConfig(dir).phoneBaseUrl, undefined)
  })

  it('★ 探测失败（拿不到地址）⇒ 打警告但**不失败**，退回旧行为', () => {
    const dir = freshHome()
    const result = installIntoCaptured(dir, [
      '--listener',
      '--lan-ip', '', // ★ 注入点：确定性地表示"拿不到局域网地址"，不依赖真机网络
      '--listener-plain', '0.0.0.0:3901',
      '--listener-tls', '0.0.0.0:3902',
    ])
    assert.equal(result.status, 0, `探测失败不该让安装失败（能装上去、只是手机连不上）\nstderr=${result.stderr}`)
    assert.match(result.stderr, /警告/, '探测失败必须**打警告**，不许静默')
    assert.match(result.stderr, /--lan-ip/, '警告里要给出可操作的补救参数 --lan-ip')
    assert.match(result.stderr, /--phone-base-url/, '警告里要给出可操作的补救参数 --phone-base-url')
    assert.deepEqual(trustedHosts(dir), [], '探测失败时不该写 trustedHosts')
    assert.equal(readConfig(dir).phoneBaseUrl, undefined, '探测失败时不该写 phoneBaseUrl')
    // listener 仍然照写（装插件这件事本身没失败）
    assert.equal((readConfig(dir).listener as { enabled?: boolean } | undefined)?.enabled, true)
  })

  it('★ 日志要说清"替你决定了什么"（写了哪个地址、为什么）', () => {
    const dir = freshHome()
    const result = installIntoCaptured(dir, [
      '--listener',
      '--lan-ip', '10.9.8.7',
      '--listener-plain', '0.0.0.0:3901',
      '--listener-tls', '0.0.0.0:3902',
    ])
    assert.equal(result.status, 0)
    assert.match(result.stdout, /已替你把手机入口地址写进配置/, '替用户做决定就必须在日志里挑明')
    assert.match(result.stdout, /10\.9\.8\.7:3901/, '日志里要出现写了哪个明文地址')
    assert.match(result.stdout, /https:\/\/10\.9\.8\.7:3902/, '日志里要出现写了哪个 phoneBaseUrl')
  })
})
