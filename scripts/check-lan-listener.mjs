#!/usr/bin/env node
/**
 * 插件进程内局域网监听（C1）的**实例级**验收 —— 干净临时家目录 + 装插件 + 真起监听 + 从局域网侧打它。
 *
 * ## 为什么需要这个脚本
 *
 * C1 把原先**外置的第三进程** `scripts/lan-proxy.mjs` 搬进了 DSH 插件进程
 * （`packages/host/src/lan-listener.ts`，由 profile 里的 `listener.enabled` 开关控制，**默认关闭**）。
 * 落地时"真起监听 / 真注入来源 / 真伴随 IPv6"只用过**一个跑完即删的一次性脚本**验过
 * ⇒ 之后**没有任何永久回归断言**。`check-lan-proxy.mjs` 断的是"行为"（每个请求都带真实来源），
 * 它假定"监听方已在跑"（C1 后即插件的监听），既不管"默认关闭"，也不管"谁在监听"。
 * 本脚本补上缺的那一半：**实例级**（起真进程、真端口、真自检读数）。
 *
 * ## ★★ 安全命门（本脚本存在的首要理由）：`x-forwarded-for` 注入
 *
 * 插件自己起的监听 socket 对端**恒为回环**（监听器与 DSH 同机）⇒ 若不注入该头，
 * "这个请求是不是来自本机"的判断（`isLoopbackRequest`）会把**所有局域网手机**判成
 * "人在电脑前"，于是配对码生成 / 配对确认 / 设备列表（`LOCAL_ONLY` 全家）在局域网可达 ——
 * **这是权限提升**。本项目真实发生过两次。
 *
 * 因此 C 组断言 `GET /mobile/pair/pending` 与 `GET /mobile/devices` 从**局域网 IP** 打
 * **必须 403**，并且**同一 keep-alive 连接上连续多个请求都要 403**（防"只有第一个请求带来源"
 * 那个历史 bug；curl 每次新建连接，只有浏览器式复用连接才暴露）。
 *
 * ★ 交付纪律：本脚本必须配一次**变异读数** —— 把 `lan-listener.ts` 里那次
 * `injectForwardedFor(...)` 调用临时去掉 ⇒ 重建 ⇒ C 组那几条**必须变红**（403 变 200），
 * 还原 ⇒ 全绿。具体命令见文件末尾注释。
 *
 * ## 端口纪律（★ 红线）
 *
 * 这台机器上跑着用户**生产**的 DSH 与手机入口（3080 / 3081 / 3443）。
 * 本脚本**绝不碰**那三个端口：所有端口走环境变量，**默认值全是测试专用**
 * （`LL_DSH_PORT=3691` / `LL_PLAIN_PORT=3692` / `LL_TLS_PORT=3693`），
 * 且启动时有硬闸门：任一端口等于生产端口就直接拒绝运行。
 * 家目录一律 `mkdtemp`（临时），绝不使用 `~/.dsh`。
 *
 * ## 断言分组
 *
 *   A. 默认关闭：不带 `--listener` ⇒ 两个端口没有任何监听者，自检报"未启用"（不是"故障"）
 *   B. 打开后真的起来：带 `--listener` ⇒ 两个端口都有监听者，自检报"已启用且 ok"
 *   C. ★★ 安全命门：从局域网侧打明文端口，`/mobile` 200 而管理端点必须 403（含 keep-alive 一致性）
 *   D. IPv6 伴随监听：`0.0.0.0:<plain>` 必须有 `::` 伴随，且从 `[::1]` 连得上
 *   E. 端口冲突不许静默半死：先占住 `<plain>` ⇒ DSH 仍起得来，自检必须**明确报错**
 *
 * 用法：node scripts/check-lan-listener.mjs
 * 环境：LL_DSH_PORT / LL_PLAIN_PORT / LL_TLS_PORT（都有测试专用默认值）
 * 退出码：0 全绿；1 有 ✗；2 环境性问题（探测不到局域网 IP / 测试端口已被占）
 */
import { spawn, execFileSync } from 'node:child_process'
import { createHash, X509Certificate } from 'node:crypto'
import { mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, statSync } from 'node:fs'
import { Agent, request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { connect, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = dirname(dirname(fileURLToPath(import.meta.url)))
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 生产端口（★ 红线）：出现在下面硬闸门里，任何情况下都不许用。 */
const PRODUCTION_PORTS = [3080, 3081, 3443]

/**
 * 端口全部走环境变量，**默认值刻意是测试专用端口**。
 *
 * ⚠️ 不要照抄 `check-device-channel.mjs` 的默认值 —— 那套默认值贴着生产端口；
 * 这里只照抄它的**结构**（临时 HOME → 装插件 → 起 DSH → 轮询就绪）。
 */
const DSH_PORT = Number(process.env.LL_DSH_PORT ?? 3691)
const PLAIN_PORT = Number(process.env.LL_PLAIN_PORT ?? 3692)
const TLS_PORT = Number(process.env.LL_TLS_PORT ?? 3693)
const PORTS = { DSH_PORT, PLAIN_PORT, TLS_PORT }

for (const [name, port] of Object.entries(PORTS)) {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    console.error(`[check-lan-listener] ${name}=${port} 不是合法端口`)
    process.exit(2)
  }
  if (PRODUCTION_PORTS.includes(port)) {
    console.error(
      `[check-lan-listener] ★ 拒绝运行：${name}=${port} 是**生产端口**（${PRODUCTION_PORTS.join('/')}）。\n` +
        '  这台机器上跑着用户的生产 DSH 与手机入口，测试端口必须是 3691/3692/3693 这类。',
    )
    process.exit(2)
  }
}
if (new Set(Object.values(PORTS)).size !== 3) {
  console.error(`[check-lan-listener] ★ 拒绝运行：三个端口必须互不相同（${JSON.stringify(PORTS)}）`)
  process.exit(2)
}

const LAN = (await import(join(REPO, 'scripts', 'detect-lan-ip.mjs'))).detectLanIp()
if (LAN === undefined || LAN === null) {
  console.error('[check-lan-listener] 探测不到局域网 IP（检查网卡）——C 组断言打不出去')
  process.exit(2)
}

// ── 断言账本（跑完一句总账；有 ✗ 就以非零退出码结束，否则"红"只是屏幕上的一行字）──
let assertions = 0
const failures = []
const ok = (condition, label, detail) => {
  console.log(`  ${condition ? '✓' : '✗'} ${label}${detail === undefined ? '' : `  [${detail}]`}`)
  assertions += 1
  if (!condition) failures.push(label)
}

// ── 资源登记：无论成功失败都要杀掉自己起的进程/监听者，并删掉临时 HOME ──
const spawned = []
const fakeListeners = []
const homes = []
const logFiles = []

function spawnDsh(home, logPath) {
  logFiles.push(logPath)
  const dshBin = resolveDsh()
  const fd = openSync(logPath, 'a')
  const child = spawn(
    dshBin,
    [
      'web',
      '--port',
      String(DSH_PORT),
      '--trusted-host',
      `${LAN}:${PLAIN_PORT}`,
      '--trusted-host',
      `${LAN}:${TLS_PORT}`,
      '--no-open',
    ],
    { env: { ...process.env, DSH_HOME: home }, stdio: ['ignore', fd, fd], detached: true },
  )
  spawned.push(child)
  return child
}

/** 解析 dsh 可执行文件（与其它验收脚本同一个共享模块）。 */
function resolveDsh() {
  const module = dshModule
  const resolved = module.resolveDsh()
  if (resolved === undefined) {
    console.error(module.explainMissingDsh('check-lan-listener'))
    process.exit(2)
  }
  return resolved
}

/** 装插件进临时 HOME 的 web profile。`extraArgs` 决定这次安装带不带 `--listener`。 */
function installPlugin(home, extraArgs) {
  mkdirSync(join(home, 'profiles', 'web'), { recursive: true })
  execFileSync(
    process.execPath,
    [
      join(REPO, 'scripts', 'install-host-plugin.mjs'),
      '--dsh-home',
      home,
      '--profile',
      'web',
      '--trusted-host',
      `${LAN}:${PLAIN_PORT}`,
      '--trusted-host',
      `${LAN}:${TLS_PORT}`,
      '--phone-base-url',
      `https://${LAN}:${TLS_PORT}`,
      '--skip-verify',
      ...extraArgs,
    ],
    { stdio: 'ignore' },
  )
}

const newHome = (label) => {
  const home = mkdtempSync(join(tmpdir(), `ll-${label}-`))
  homes.push(home)
  return home
}

/** TCP 连通性：true = 该地址:端口上确实有监听者。 */
function tcpConnect(host, port, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const socket = connect({ host, port })
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(value)
    }
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
    socket.setTimeout(timeoutMs, () => finish(false))
  })
}

/** 一个端口上"有没有监听者"：IPv4 或 IPv6 任一被占用即算有。 */
async function portHasListener(port) {
  const [v4, v6] = await Promise.all([tcpConnect('127.0.0.1', port), tcpConnect('::1', port)])
  return v4 || v6
}

async function waitPortFree(port, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!(await portHasListener(port))) return true
    await sleep(200)
  }
  return !(await portHasListener(port))
}

/** 等 loopback 上的 DSH 就绪（`/mobile/manifest` 能应答）。 */
async function waitDshReady(timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${DSH_PORT}/mobile/manifest`)
      if (response.ok) return true
    } catch {
      /* 还没起来 */
    }
    await sleep(1000)
  }
  return false
}

/** 读自检（`/mobile/admin/selfcheck`，loopback ⇒ 放行）。拿不到就返回 `{error}`，不编。 */
async function readSelfcheck() {
  try {
    const response = await fetch(`http://127.0.0.1:${DSH_PORT}/mobile/admin/selfcheck`)
    if (!response.ok) return { error: `HTTP ${response.status}` }
    return await response.json()
  } catch (error) {
    return { error: String(error?.message ?? error) }
  }
}

const listenerOf = (selfcheck) => (selfcheck === null || typeof selfcheck !== 'object' ? undefined : selfcheck.listener)

/** 从局域网侧发请求（与 `check-lan-proxy.mjs` 同一手法：keepAlive + maxSockets:1 强制复用同一连接）。 */
function makeLanGetter(agent) {
  return (path) =>
    new Promise((resolve) => {
      const request = httpRequest(
        {
          host: LAN,
          port: PLAIN_PORT,
          path,
          agent,
          headers: {
            // 接近真实浏览器的头（较大，容易触发分片）
            'User-Agent':
              'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
            Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
            'Accept-Language': 'zh-CN,zh;q=0.9',
            'Accept-Encoding': 'gzip, deflate',
            Connection: 'keep-alive',
            'Upgrade-Insecure-Requests': '1',
          },
        },
        (response) => {
          const chunks = []
          response.on('data', (chunk) => chunks.push(chunk))
          response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') }))
        },
      )
      request.on('error', (error) => resolve({ status: 0, body: String(error.message) }))
      request.end()
    })
}

/** 从 `[::1]` 打 IPv6 伴随监听。 */
function getViaIpv6(path) {
  return new Promise((resolve) => {
    const request = httpRequest({ host: '::1', port: PLAIN_PORT, path }, (response) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') }))
    })
    request.on('error', (error) => resolve({ status: 0, body: String(error.message) }))
    request.end()
  })
}

/** 从 loopback 打 TLS 监听（自签证书 ⇒ 不收证书错误；这一步同时验"TLS 真的能终结"）。 */
function getViaTls(path) {
  return new Promise((resolve) => {
    const request = httpsRequest(
      { host: '127.0.0.1', port: TLS_PORT, path, rejectUnauthorized: false },
      (response) => {
        const chunks = []
        response.on('data', (chunk) => chunks.push(chunk))
        response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') }))
      },
    )
    request.on('error', (error) => resolve({ status: 0, body: String(error.message) }))
    request.end()
  })
}

/**
 * 从**局域网 IP** 打 TLS 监听 —— 这就是手机的走法 ✓（`https://${LAN}:${TLS_PORT}/…`）。
 * 自签证书 ⇒ `rejectUnauthorized: false` ✓（与手机 TOFU 那条"不验证证书的连接"同义 ✓）。
 * 返回里带上 `headers` ✓：D4 要断言 `content-type` ✓。
 */
function getViaTlsFromLan(path) {
  return new Promise((resolve) => {
    const request = httpsRequest(
      { host: LAN, port: TLS_PORT, path, rejectUnauthorized: false },
      (response) => {
        const chunks = []
        response.on('data', (chunk) => chunks.push(chunk))
        response.on('end', () =>
          resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8'), headers: response.headers }),
        )
      },
    )
    request.on('error', (error) => resolve({ status: 0, body: String(error.message), headers: {} }))
    request.end()
  })
}

/** 自检 `tls` 段里那个指纹（= **进配对票据的那一个** ✓，见 `index.ts` 的 selfcheck/manifest ✓）。 */
function selfcheckTlsFingerprint(selfcheck) {
  if (selfcheck === null || typeof selfcheck !== 'object') return undefined
  const tls = selfcheck.tls
  return tls !== null && typeof tls === 'object' ? tls.caFingerprint : undefined
}

/** 轮询自检，直到 `predicate(listener)` 成立或超时。返回最后一次读到的 listener 段。 */
async function waitForListener(predicate, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    last = listenerOf(await readSelfcheck())
    if (last !== undefined && predicate(last) === true) return last
    await sleep(500)
  }
  return last
}

const bindingsOf = (listener) => (Array.isArray(listener?.bindings) ? listener.bindings : [])
const plainV4 = (listener) => bindingsOf(listener).find((b) => b.kind === 'plain' && b.ipv6 !== true)
const tlsV4 = (listener) => bindingsOf(listener).find((b) => b.kind === 'tls' && b.ipv6 !== true)
const plainV6 = (listener) => bindingsOf(listener).find((b) => b.kind === 'plain' && b.ipv6 === true)

const dshModule = await import(join(REPO, 'scripts', 'resolve-dsh.mjs'))

let exitCode = 0
try {
  // ── 前置：三个测试端口必须都是空的（否则后面所有结论都不可信）──
  for (const [name, port] of Object.entries(PORTS)) {
    if (await portHasListener(port)) {
      console.error(
        `[check-lan-listener] 测试端口已被占用：${name}=${port}。\n` +
          '  请先释放它（本脚本会真起监听，端口不空则断言无意义）。这是环境问题，不是产品 bug。',
      )
      process.exit(2)
    }
  }

  console.log(`[check-lan-listener] 局域网 IP=${LAN}｜DSH=${DSH_PORT} 明文=${PLAIN_PORT} TLS=${TLS_PORT}`)
  console.log('  （临时 HOME；生产端口 3080/3081/3443 全程不碰）')

  // ══════════════════════════════════════════════════════════════════════
  // 场景 A：**默认关闭**（不变量）—— 不带 --listener 装一遍
  // ══════════════════════════════════════════════════════════════════════
  console.log('\n【A. 默认关闭：不带 --listener 时两个端口必须没有任何监听者】')
  {
    const home = newHome('a')
    installPlugin(home, [])
    spawnDsh(home, join(home, 'dsh.log'))
    const ready = await waitDshReady()
    ok(ready, 'A0 前置：DSH 起来了（loopback /mobile/manifest 有应答）', ready ? `127.0.0.1:${DSH_PORT}` : '超时')
    if (!ready) throw new Error('场景 A：DSH 未能就绪（超时）')

    // 默认关闭是"不变量"：老部署行为一字不变 ⇒ 一个监听者都不许有
    const plainUp = await portHasListener(PLAIN_PORT)
    const tlsUp = await portHasListener(TLS_PORT)
    ok(!plainUp, `A1 明文端口 ${PLAIN_PORT} 上没有任何监听者（IPv4 与 IPv6 都试过）`, plainUp ? '有监听者' : '空')
    ok(!tlsUp, `A2 TLS 端口 ${TLS_PORT} 上没有任何监听者（IPv4 与 IPv6 都试过）`, tlsUp ? '有监听者' : '空')

    const selfcheck = await readSelfcheck()
    const listener = listenerOf(selfcheck)
    if (listener === undefined) {
      ok(false, 'A3 自检里能读到 listener 段', `selfcheck=${JSON.stringify(selfcheck).slice(0, 120)}`)
      ok(false, 'A4 自检 listener.bindings 为空（一个监听都没起）', '拿不到 listener 段')
    } else {
      ok(
        listener.available === true && listener.enabled === false && listener.ok === true,
        'A3 自检 listener 段：available=true、enabled=false、ok=true（"未启用" ≠ "故障"）',
        `available=${listener.available} enabled=${listener.enabled} ok=${listener.ok}`,
      )
      ok(
        bindingsOf(listener).length === 0,
        'A4 自检 listener.bindings 为空（真的一条监听都没起）',
        JSON.stringify(bindingsOf(listener).map((b) => `${b.kind}${b.ipv6 ? '/v6' : ''}:${b.address}`)),
      )
    }
  }
  killSpawned()
  await sleep(500)
  for (const port of [DSH_PORT, PLAIN_PORT, TLS_PORT]) await waitPortFree(port)

  // ══════════════════════════════════════════════════════════════════════
  // 场景 B/C/D：带 --listener 装一遍，真起监听后从局域网侧与 [::1] 打它
  // ══════════════════════════════════════════════════════════════════════
  console.log('\n【B. 打开后真的起来：带 --listener 时两个端口都必须有监听者】')
  const home = newHome('bcd')
  installPlugin(home, ['--listener', '--listener-plain', `0.0.0.0:${PLAIN_PORT}`, '--listener-tls', `0.0.0.0:${TLS_PORT}`])
  spawnDsh(home, join(home, 'dsh.log'))
  {
    const ready = await waitDshReady()
    ok(ready, 'B0 前置：DSH 起来了（loopback /mobile/manifest 有应答）', ready ? `127.0.0.1:${DSH_PORT}` : '超时')
    if (!ready) throw new Error('场景 B：DSH 未能就绪（超时）')

    const listener = await waitForListener(
      (value) => plainV4(value)?.listening === true && tlsV4(value)?.listening === true,
    )
    const plainUp = await portHasListener(PLAIN_PORT)
    const tlsProbe = await getViaTls('/mobile')
    ok(plainUp, `B1 明文端口 ${PLAIN_PORT} 有监听者`, plainUp ? 'TCP 可连' : '连不上')
    ok(
      tlsProbe.status === 200,
      `B2 TLS 端口 ${TLS_PORT} 有监听者且能完成 TLS 握手（https://127.0.0.1:${TLS_PORT}/mobile ⇒ 200）`,
      `HTTP ${tlsProbe.status}${tlsProbe.status === 0 ? `（${tlsProbe.body.slice(0, 60)}）` : ''}`,
    )
    ok(
      listener?.enabled === true && listener?.ok === true && plainV4(listener)?.listening === true && tlsV4(listener)?.listening === true,
      'B3 自检 listener 段：enabled=true、ok=true，明文与 TLS 两条 IPv4 绑定都在听',
      `enabled=${listener?.enabled} ok=${listener?.ok} plain=${plainV4(listener)?.listening} tls=${tlsV4(listener)?.listening}`,
    )
    ok(
      listener?.forwardedForInjection === true,
      'B4 自检 listener.forwardedForInjection=true（x-forwarded-for 注入这一项被报成开启）',
      String(listener?.forwardedForInjection),
    )

    // ── C. ★★ 安全命门：从局域网 IP 打明文端口 ──────────────────────────
    console.log(`\n【C. ★★ 安全命门：从局域网 ${LAN}:${PLAIN_PORT} 打明文端口（keep-alive 复用同一连接）】`)
    const agent = new Agent({ keepAlive: true, maxSockets: 1 })
    const lanGet = makeLanGetter(agent)
    const page = await lanGet('/mobile')
    ok(page.status === 200, `C1 从局域网 GET /mobile ⇒ 200（页面本身可达）`, `HTTP ${page.status}`)

    // 管理端点必须被识别为"非本机"。若注入漏了，这里会是 200 = 被当成电脑本机 = **权限提升**。
    const management = [
      ['C2', '/mobile/pair/pending'],
      ['C3', '/mobile/devices'],
    ]
    for (const [id, path] of management) {
      const response = await lanGet(path)
      ok(
        response.status === 403,
        `${id} 从局域网 GET ${path} ⇒ 403（被识别为非本机）`,
        `HTTP ${response.status}${response.status === 200 ? ' ← 权限提升！注入漏了' : ''}`,
      )
    }

    // 同一连接上连续多个请求都必须一致（防"只有第一个请求带来源"那个历史 bug）
    const repeat = await Promise.all([0, 1, 2].map(() => lanGet('/mobile/pair/pending')))
    ok(
      repeat.every((response) => response.status === 403),
      'C4 同一 keep-alive 连接上连续 3 个 /mobile/pair/pending 全部 403',
      repeat.map((response) => response.status).join(','),
    )
    agent.destroy()

    // 实例级证据：这些请求确实是**插件内的监听**转发的（而不是某个外置进程）
    const afterC = await readSelfcheck()
    const connections = listenerOf(afterC)?.connections
    ok(
      typeof connections === 'number' && connections >= 1,
      'C5 自检 listener.connections ≥ 1（确实是插件内监听在处理这些连接）',
      `connections=${connections}`,
    )

    // ── D. IPv6 伴随监听 ────────────────────────────────────────────────
    console.log('\n【D. IPv6 伴随监听（明文给 0.0.0.0 时必须补 :: 伴随）】')
    const listenerForIpv6 = listenerOf(await readSelfcheck())
    const companion = plainV6(listenerForIpv6)
    ok(
      companion !== undefined && companion.listening === true && companion.port === PLAIN_PORT,
      `D1 自检里有明文 IPv6 伴随绑定（host=::、port=${PLAIN_PORT}、listening=true）`,
      companion === undefined ? '没有 IPv6 伴随绑定' : `host=${companion.host} port=${companion.port} listening=${companion.listening}`,
    )
    const viaIpv6 = await getViaIpv6('/mobile')
    ok(viaIpv6.status === 200, `D2 从 [::1]:${PLAIN_PORT} GET /mobile ⇒ 200`, `HTTP ${viaIpv6.status}`)

    /**
     * ── D2. ★★ TOFU 的**第一步**：手机在**还不信任**这台电脑时，必须能取到那张 CA ─────
     *
     * 为什么这一组非有不可 ✗：C2 把"首次连接"的判据改成 TOFU ✓ ——
     * 而 TOFU 的**前提**是手机能先 `GET <源>/mobile/trust.crt` 把那台电脑的 CA 取回来 ✓
     * （见 `MainActivity.tofuTrustOnce` ✓：它跑的是一条**不验证证书**的连接 ✓）。
     * 这条路由在宿主里只受**第一道栅栏**管（Host 必须是回环或受信 ✓，见 `index.ts:2493` ✓）——
     * 而"本机局域网 IP 自动受信"是 B1 那条**自推导**给的 ✓（`lan-trust.ts` ✓）。
     *
     * ⇒ 一旦自推导坏了 / 这条路由被挪进 `/mobile/admin/*`（那还有第二道 `isAdminSourceTrusted` ✗），
     *   症状是**手机永远连不上任何一台电脑**✗，而电脑上一切正常 ✓ ——
     *   与 `e2e-pairing` 那次的"看起来像功能坏了"是同一类陷阱 ✓。
     *
     * ★ D6 是**手机那一侧比对的可执行等价物** ✓：宿主广告的指纹（自检 `tls.caFingerprint` ✓，
     *   = 进票据的那一个 ✓）经**壳的归一化规则**（去非 hex + 大写 ✓）之后，
     *   必须 == 对**真正发出去的那份 CA** 求 SHA-256 的结果 ✓。
     *
     * ★ 编号接着 D 走（D3–D6）而不是另起一节 ✓：它跑在**同一个临时实例**上 ✓
     *   （就在 `killSpawned()` 之前 ✓），所以打印顺序是 D→D2→E ✓，不会出现"F 在 E 前面"那种像 bug 的读数 ✓。
     */
    console.log(`\n【D2. ★★ TOFU 第一步：局域网 ${LAN}:${TLS_PORT} 取 CA（手机在受信之前就得能取到）】`)
    const trust = await getViaTlsFromLan('/mobile/trust.crt')
    ok(
      trust.status === 200,
      `D3 从局域网 https://${LAN}:${TLS_PORT}/mobile/trust.crt ⇒ 200（TOFU 的前提：**还没被信任时**就取得到 CA）`,
      `HTTP ${trust.status}${trust.status === 403 ? ' ← 被栅栏挡了：手机会永远连不上任何电脑' : ''}`,
    )
    const trustType = String(trust.headers?.['content-type'] ?? '')
    ok(
      trustType.includes('application/x-x509-ca-cert'),
      'D4 content-type 是 application/x-x509-ca-cert（安卓见到这个类型才会引导安装 ✓）',
      trustType || '(无 content-type)',
    )
    const caOnDisk = readFileSync(join(home, 'storages', 'dsh-mobile', 'tls', 'lan-ca.pem'), 'utf8')
    ok(
      trust.body === caOnDisk,
      'D5 取回来的字节 == 这台实例磁盘上那张 lan-ca.pem（逐字节）',
      trust.body === caOnDisk ? `一致（${trust.body.length} 字符）` : `不一致（取回 ${trust.body.length} / 磁盘 ${caOnDisk.length}）`,
    )
    {
      const advertised = String(selfcheckTlsFingerprint(await readSelfcheck()) ?? '')
      const shellStyle = advertised.replace(/[^0-9A-Fa-f]/g, '').toUpperCase() // 壳的归一化规则
      let served = ''
      try {
        served = createHash('sha256').update(new X509Certificate(trust.body).raw).digest('hex').toUpperCase()
      } catch {
        served = '(发回来的不是一张证书)'
      }
      ok(
        shellStyle.length === 64 && shellStyle === served,
        '★★ D6 TOFU 比对能成立：宿主广告的指纹经壳的归一化规则后 == 对**真正发出去的**那份 CA 求 SHA-256（D3–D5 都绿而这条红 ⇒ 手机一定会判"指纹不一致"并拒绝连接 ✗）',
        `广告 ${advertised.length} 字符 ⇒ 归一化后 ${shellStyle.length}；与发出的 CA 的 SHA-256 ${shellStyle === served ? '一致 ✓' : '**不一致** ✗'}`,
      )
    }
  }
  killSpawned()
  await sleep(500)
  for (const port of [DSH_PORT, PLAIN_PORT, TLS_PORT]) await waitPortFree(port)

  // ══════════════════════════════════════════════════════════════════════
  // 场景 E：端口冲突**不许静默半死**
  // ══════════════════════════════════════════════════════════════════════
  console.log('\n【E. 端口冲突：先占住明文端口，再带 --listener 起 DSH】')
  const occupier = createServer(() => {})
  await new Promise((resolve, reject) => {
    occupier.once('error', reject)
    occupier.listen({ port: PLAIN_PORT, host: '0.0.0.0' }, resolve)
  })
  fakeListeners.push(occupier)
  console.log(`  · 假监听者已占住 0.0.0.0:${PLAIN_PORT}`)
  {
    const homeE = newHome('e')
    installPlugin(homeE, ['--listener', '--listener-plain', `0.0.0.0:${PLAIN_PORT}`, '--listener-tls', `0.0.0.0:${TLS_PORT}`])
    spawnDsh(homeE, join(homeE, 'dsh.log'))
    const ready = await waitDshReady()
    ok(ready, 'E1 端口被占时 DSH 仍然起得来（手机入口不可用 ≠ DSH 挂掉）', ready ? `loopback /mobile/manifest OK` : '超时')
    if (ready) {
      const loopbackPage = await fetch(`http://127.0.0.1:${DSH_PORT}/mobile`)
      ok(loopbackPage.status === 200, `E2 loopback http://127.0.0.1:${DSH_PORT}/mobile ⇒ 200`, `HTTP ${loopbackPage.status}`)
    } else {
      ok(false, `E2 loopback http://127.0.0.1:${DSH_PORT}/mobile ⇒ 200`, 'DSH 未就绪')
    }

    const listener = await waitForListener((value) => value.ok === false)
    const plain = plainV4(listener)
    ok(
      listener?.enabled === true && listener?.ok === false,
      'E3 自检 listener.ok=false（明确报出"启用但没起来"，不假装成功）',
      `enabled=${listener?.enabled} ok=${listener?.ok}`,
    )
    ok(
      plain !== undefined && plain.listening !== true && typeof plain.error === 'string' && plain.error.length > 0 && plain.code === 'EADDRINUSE',
      'E4 明文绑定带 error 且 code=EADDRINUSE（原因说得清，不是静默半死）',
      plain === undefined ? '没有明文绑定' : `code=${plain.code} error=${String(plain.error).slice(0, 70)}`,
    )
    const warnings = Array.isArray(listener?.warnings) ? listener.warnings : []
    ok(
      warnings.some((warning) => /未就绪/.test(String(warning))),
      'E5 自检 warnings 里有人话结论（"监听 … 未就绪：…"）',
      warnings.find((warning) => /未就绪/.test(String(warning)))?.slice(0, 90) ?? JSON.stringify(warnings).slice(0, 90),
    )
  }
} catch (error) {
  console.error(`\n[check-lan-listener] 运行中断：${String(error?.stack ?? error)}`)
  exitCode = 2
} finally {
  // ── 收工：杀自己起的 DSH / 假监听者，删临时 HOME（无论成功失败都要走到）──
  killSpawned()
  for (const server of fakeListeners) {
    try {
      await new Promise((resolve) => server.close(() => resolve()))
    } catch {
      /* 已经关了 */
    }
  }
  // 失败时先把每个场景的 DSH 日志尾巴打出来（临时 HOME 马上要删掉，不先打就没线索了）
  if (failures.length > 0 || exitCode === 2) {
    for (const logPath of logFiles) {
      try {
        if (statSync(logPath).size === 0) continue
        const lines = readFileSync(logPath, 'utf8').trimEnd().split('\n')
        console.log(`\n  ── ${logPath} 末尾 ${Math.min(12, lines.length)} 行 ──`)
        for (const line of lines.slice(-12)) console.log(`    ${line}`)
      } catch {
        /* 日志不存在就算了 */
      }
    }
  }
  for (const home of homes) {
    // 失败时留一份日志片段供排查，其余一律删掉（几十 MB 的 storages 不留）
    try {
      rmSync(home, { recursive: true, force: true })
    } catch {
      /* 删不掉也不该让脚本挂在这里 */
    }
  }
  await sleep(500)
  const leaked = []
  for (const [name, port] of Object.entries(PORTS)) {
    if (await portHasListener(port)) leaked.push(`${name}=${port}`)
  }
  console.log(
    `\n[check-lan-listener] 收工：临时 HOME ${homes.length} 个已删除，自起进程/假监听者已全部结束；` +
      `测试端口${leaked.length === 0 ? '已全部释放' : `仍有监听者：${leaked.join(', ')}`}`,
  )
  console.log(`\n[check-lan-listener] ${assertions - failures.length}/${assertions} 条断言通过`)
  for (const label of failures) console.log(`  ✗ ${label}`)
  if (failures.length > 0) exitCode = 1
  process.exit(exitCode)
}

/** 杀掉所有自己 spawn 的 DSH（detached ⇒ 按进程组杀，连带它的子进程）。 */
function killSpawned() {
  for (const child of spawned.splice(0)) {
    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch {
      try {
        child.kill('SIGKILL')
      } catch {
        /* 已经没了 */
      }
    }
  }
}

/**
 * ── C 条变异读数怎么跑（交付必须带）──────────────────────────────────────
 *
 * 1. 备份 + 变异（去掉那次注入）：
 *      cp packages/host/src/lan-listener.ts /tmp/lan-listener.ts.bak
 *      # 把 `forward(injectForwardedFor(joined, clientAddress))` 改成 `forward(joined)`
 * 2. 重建：node scripts/build-lib.mjs
 * 3. 重跑本脚本 ⇒ **C2/C3/C4 必须变红**（403 变 200 = 被当成电脑本机 = 权限提升），其余组仍绿
 * 4. 还原 + 重建 + 重跑 ⇒ 全绿：
 *      cp /tmp/lan-listener.ts.bak packages/host/src/lan-listener.ts
 *      node scripts/build-lib.mjs
 * 5. 确认没留痕：git status --porcelain（lib/ 已 gitignore，src 必须与 HEAD 一致）
 *
 * 读日志：每个场景的 DSH stdout/stderr 写在它自己临时 HOME 的 dsh.log 里
 * （临时 HOME 收工即删；要留证据请在重跑前先把那份日志复制出来）。
 */
