#!/usr/bin/env node
/**
 * 端到端浏览器验收：真 Chrome + 真 dsh web + 真局域网代理。
 *
 * ## 为什么必须有这一层
 *
 * 单元测试与 live-verify 覆盖的是**协议**，但配对体验里的失败几乎都在浏览器层：
 * 跳转载荷形状不匹配、localStorage 形状不匹配、CSP 拦截、剪贴板不可用、
 * 布局注错角色……这些都只在真实浏览器里暴露，而且表现是"手机就是连不上"。
 * 本项目已两次在真机上才发现问题（Origin 解析、fence 位置），所以固化成脚本。
 *
 * ## 覆盖的链路
 *
 * 1. 电脑（loopback）打开 `/mobile` → 生成配对码，并断言手机地址是**局域网代理地址**而不是 3080；
 * 2. 手机（经代理，带 `x-forwarded-for`）打开 `/mobile` → 断言看到的是**手机端**角色；
 * 3. 手机提交链接 → claim → 断言跳转 `?pair=` 的载荷形状与 boot.js 一致（往返解码）；
 * 4. 电脑看到待确认设备并比对指纹 → 点「允许此设备」；
 * 5. 手机自动连上隧道 → 断言 `/mobile/ws` 升级成功且 DSH 界面资源被加载。
 *
 * 运行：node scripts/e2e-pairing.mjs
 * 前置：**无**（自己建临时 DSH_HOME 并安装插件；不依赖生产状态、不碰生产配置）
 */

import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { snapshotChromeClones, sweepChromeClones, removeQuietly } from './chrome-clone-guard.mjs'
/** ★ Chrome `code_sign_clone` 残留守卫（见 chrome-clone-guard.mjs）：启动前拍快照、收尾时只删本次新增 ✓。 */
let cloneSnapshot = null
/** 拍快照：只在**第一次**启动 Chrome 之前拍 ✓ —— 多次启动时，最早那张快照才覆盖全部新增 ✓。 */
function markChromeLaunch() {
  if (cloneSnapshot === null) cloneSnapshot = snapshotChromeClones()
}

import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { explainMissingDsh, resolveDsh } from './resolve-dsh.mjs'

// 端口可被外部固定：安装到临时 DSH_HOME 的插件里写死了 publicBaseUrl（含端口），
// 随机端口会让票据端点与手机实际访问的 origin 不一致——那样测的就不是链路而是拒绝逻辑。
const DSH_PORT = Number(process.env['E2E_DSH_PORT'] ?? 3600 + Math.floor(Math.random() * 300))
const PROXY_PORT = Number(process.env['E2E_PROXY_PORT'] ?? DSH_PORT + 1)
/**
 * ★★ 局域网 IP **必须动态探测** ✗ —— 这里原来写死成 `10.34.221.181` ✓。
 *
 * 后果（**本轮实测** ✓）：电脑换网络后 IP 变成 `10.34.255.229` ✓ ⇒ 这个临时实例只信任**旧** authority ✗
 * ⇒ 走 `http://${LAN_IP}:${PROXY_PORT}/…` 的那三条断言（短码入口 302 ✓ / 带票据的 Location ✓ / 无效码 404 ✓）
 * 全部报"HTTP 请求失败" ✗ —— 而它**看起来**像配对逻辑坏了 ✗（其实是那个地址已经不通了 ✓）。
 *
 * 这正是 `check-mobile-layout.mjs:33` 记过的**同一个坑** ✓ —— ★ **那次只改了一半** ✗，本脚本当时漏了 ✓
 * （与 `extraEndpoints` 那次"只改了一半"同型 ✓）。现在照它的做法（`:41` ✓）交给项目自己的 `detect-lan-ip.mjs` ✓。
 *
 * 与 `check-mobile-layout.mjs` 的**差别**：这里**多一道判空** ✓ —— `detectLanIp()` 找不到时返回 `undefined`
 * （见该模块末尾 ✓），带着 `undefined` 往下跑只会得到一堆看不懂的失败 ✗ ⇒ 探不到就**明确报错退出** ✓。
 * 仍然支持 `E2E_LAN_IP` 覆盖 ✓（调试用 ✓）。
 */
const LAN_IP = process.env['E2E_LAN_IP'] ?? (await import('./detect-lan-ip.mjs')).detectLanIp()
if (LAN_IP === undefined || LAN_IP.length === 0) {
  console.error(
    '[e2e] 探测不到局域网 IP ⇒ 拒绝继续（**绝不回退到一个可能过期的旧地址** ✗）\n' +
      '      请显式指定：E2E_LAN_IP=<你的局域网 IP> node scripts/e2e-pairing.mjs',
  )
  process.exit(1)
}
const AUTHORITY = `${LAN_IP}:${PROXY_PORT}`
const DESKTOP_URL = `http://127.0.0.1:${DSH_PORT}/mobile`
// 手机侧必须走 HTTPS：普通 HTTP 页面不是安全上下文，crypto.subtle 不存在，
// 配对与隧道都无法工作（实测症状：Cannot read properties of undefined (reading 'generateKey')）。
const TLS_PORT = Number(process.env['E2E_TLS_PORT'] ?? 0)
const PHONE_SCHEME = TLS_PORT > 0 ? 'https' : 'http'
const PHONE_PORT = TLS_PORT > 0 ? TLS_PORT : PROXY_PORT
const PHONE_URL = `${PHONE_SCHEME}://127.0.0.1:${PHONE_PORT}/mobile`
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

const problems = []
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 所有派生的子进程都登记在这里：**失败路径也必须回收**。
 *
 * 踩过的坑：`startProxy()` 里直接用 `process.exit(1)` 退出，绕过了 try/finally，
 * 于是 `dsh web` 成了孤儿并继续占着端口；下一次运行会被自己的端口预检拦下
 * （预检是对的，但根因是这里的清理不完备）。现在退出前统一整树回收。
 */
const spawned = []
function killAllSpawned() {
  for (const child of spawned.splice(0)) killTree(child)
}
/** 统一的失败退出：先清理再退出，避免留下孤儿实例。 */
function failFast(message) {
  if (message !== undefined) console.error(message)
  killAllSpawned()
  process.exit(1)
}

function log(message) {
  console.log(`[e2e] ${message}`)
}

function check(ok, label, detail) {
  if (ok) log(`  ✓ ${label}`)
  else {
    problems.push(label + (detail === undefined ? '' : `（${detail}）`))
    log(`  ✗ ${label}${detail === undefined ? '' : `（${detail}）`}`)
  }
}

/**
 * 端口预检：端口被占用时直接拒绝运行。
 *
 * 为什么必须显式检查：`dsh web` 会派生自己的子进程，父进程被 kill 后子进程可能成为孤儿
 * 并继续占着端口。此后的运行会**静默连上那个旧进程**（旧插件、旧配置），
 * 表现为"改了代码却毫无变化"，非常难定位。宁可拒绝启动，也不要跑出不可信的结果。
 */
async function assertPortsFree() {
  const ports = [
    ['DSH', DSH_PORT],
    ['代理', PROXY_PORT],
  ]
  if (TLS_PORT > 0) ports.push(['TLS 代理', TLS_PORT])
  for (const [label, port] of ports) {
    const occupied = await new Promise((resolve) => {
      const probe = createServer()
      probe.once('error', () => resolve(true))
      probe.once('listening', () => probe.close(() => resolve(false)))
      probe.listen(port, '127.0.0.1')
    })
    if (occupied) {
      console.error(
        `[e2e] 端口 ${port}（${label}）已被占用——很可能是上次运行遗留的实例。\n` +
          `  请先清理：lsof -nP -iTCP:${port} -sTCP:LISTEN，然后 kill 对应 PID；\n` +
          '  或换端口运行：E2E_DSH_PORT=3780 E2E_PROXY_PORT=3781 node scripts/e2e-pairing.mjs',
      )
      process.exit(1)
    }
  }
}

/** 结束一个子进程及其子孙（dsh 会派生自己的子进程，只 kill 父进程会留下孤儿）。 */
function killTree(child) {
  if (child === undefined || child.pid === undefined) return
  try {
    process.kill(-child.pid, 'SIGKILL')
  } catch {
    try {
      child.kill('SIGKILL')
    } catch {
      /* 已经退出 */
    }
  }
}

/** 起一个真实的 dsh web（信任局域网 authority），并等待就绪。 */
async function startDsh() {
  const dir = mkdtempSync(join(tmpdir(), 'e2e-dsh-'))
  const dshBin = resolveDsh()
  if (dshBin === undefined) {
    console.error(explainMissingDsh('e2e-pairing'))
    process.exit(1)
  }

  // ── 自包含：独立家目录 + 自己安装插件 ────────────────────────────────
  //
  // 这里踩过两次，都值得记下来：
  //
  // ① **原先没有设 `DSH_HOME`**，于是 `dsh web` 用的是**默认的 `~/.dsh`（生产！）**，
  //    临时目录只被当作 cwd。这让"测试"直接跑在生产 profile 上，而它的前置条件
  //    「请先用 install-host-plugin 装好插件」也正源于此——**测试依赖了生产状态**。
  // ② 端口是**随机**的（`3600 + random(300)`），而插件配置里写死的 `publicBaseUrl`
  //    必须与端口一致。于是"外部先装好"这个前置**在设计上就不可能稳定成立**：
  //    每次运行的端口都不同，装好的配置必然对不上，断言就会莫名其妙地失败
  //    （表现是"电脑端展示的手机地址用的不是本次端口"）。
  //
  // 所以正确做法是：**自己建家目录、自己装插件、用自己那份端口**。
  // 同一个仓库里的 `check-relay-e2e.mjs` 一直是这么做的，所以它一直可靠。
  mkdirSync(join(dir, 'profiles', 'web'), { recursive: true })
  // 路径在**本函数内**推导：`repoRoot` 是另一个函数里的局部变量，这里看不到
  const scriptDir = fileURLToPath(new URL('.', import.meta.url))
  const installArgs = [
    join(scriptDir, 'install-host-plugin.mjs'),
    '--dsh-home', dir,
    '--profile', 'web',
    '--trusted-host', AUTHORITY,
    ...(TLS_PORT > 0 ? ['--trusted-host', `${LAN_IP}:${TLS_PORT}`] : []),
    '--phone-base-url', `${PHONE_SCHEME}://${LAN_IP}:${PHONE_PORT}`,
    '--skip-verify',
  ]
  try {
    execFileSync(process.execPath, installArgs, { cwd: scriptDir, stdio: 'ignore' })
  } catch (error) {
    console.error(`[e2e] 插件安装失败（自包含前置）：${error?.message ?? error}`)
    process.exit(1)
  }

  const child = spawn(
    dshBin,
    ['web', '--port', String(DSH_PORT), '--trusted-host', AUTHORITY, '--no-open'],
    // detached：让 dsh 及其派生的子进程处于独立进程组，清理时可整树 kill
    // DSH_HOME 指向临时家目录：**绝不碰生产配置**
    { cwd: dir, env: { ...process.env, DSH_HOME: dir }, stdio: ['ignore', 'pipe', 'pipe'], detached: true },
  )
  spawned.push(child)
  let output = ''
  child.stdout?.on('data', (chunk) => (output += chunk.toString('utf8')))
  child.stderr?.on('data', (chunk) => (output += chunk.toString('utf8')))
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    if (/token=[A-Za-z0-9_-]+/.test(output)) return { child, dir, log: () => output }
    if (child.exitCode !== null) {
      failFast(`dsh web 提前退出（code=${child.exitCode}）：\n${output.slice(-2000)}`)
    }
    await sleep(200)
  }
  failFast(`等待 dsh web 启动超时：\n${output.slice(-2000)}`)
}

/** 起局域网代理（注入 x-forwarded-for，模拟手机经代理访问）。 */
async function startProxy(dshLog) {
  // 必须用 fileURLToPath：仓库路径含中文，URL.pathname 会给出百分号编码后的路径
  const repoRoot = fileURLToPath(new URL('..', import.meta.url))
  const child = spawn(
    process.execPath,
    [
      join(repoRoot, 'scripts', 'lan-proxy.mjs'),
      '--listen',
      `0.0.0.0:${PROXY_PORT}`,
      '--target',
      `127.0.0.1:${DSH_PORT}`,
      ...(TLS_PORT > 0 ? ['--tls-listen', `0.0.0.0:${TLS_PORT}`] : []),
    ],
    { stdio: ['ignore', 'pipe', 'pipe'], detached: true },
  )
  spawned.push(child)
  let output = ''
  child.stdout?.on('data', (chunk) => (output += chunk.toString('utf8')))
  child.stderr?.on('data', (chunk) => (output += chunk.toString('utf8')))
  let lastError = '(尚未尝试)'
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${PROXY_PORT}/mobile/manifest`)
      if (response.status === 200) return child
      lastError = `HTTP ${response.status}`
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
    if (child.exitCode !== null) {
      failFast(`代理提前退出（code=${child.exitCode}）：\n${output.slice(-1000)}`)
    }
    await sleep(300)
  }
  // 失败时把两端的日志都打出来：否则只剩一句"代理未就绪"，无法定位
  failFast(
    `代理未就绪（最后错误：${lastError}）\n代理日志：\n${output.slice(-800)}\nDSH 日志：\n${dshLog().slice(-1500)}`,
  )
}

/** 一个极简 CDP 会话。 */
async function openChrome(profileDir) {
  markChromeLaunch()
  const port = 9700 + Math.floor(Math.random() * 200)
  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--disable-gpu',
      // HTTPS 模式下接受自签证书——对应手机上首次访问点"继续访问"
      ...(TLS_PORT > 0 ? ['--ignore-certificate-errors'] : []),
      'about:blank',
    ],
    { stdio: 'ignore' },
  )
  let target
  for (let i = 0; i < 60 && target === undefined; i++) {
    await sleep(300)
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      target = list.find((t) => t.type === 'page')
    } catch {
      /* 还没起来 */
    }
  }
  if (target === undefined) {
    console.error('Chrome 未就绪')
    process.exit(1)
  }
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.onopen = resolve
    ws.onerror = reject
  })
  let id = 0
  const pending = new Map()
  const consoleLines = []
  const wsUrls = []
  /**
   * 记录每一次导航的 URL。
   *
   * 为什么不能用 `location.href` 轮询来抓跳转：手机落到外壳页后，boot.js 会**立刻**
   * 把 `?pair=` 从地址栏擦掉（刻意的，避免票据留在历史里）。若靠 500ms 轮询去读，
   * 命中这个窗口全靠运气——本脚本因此间歇性失败过（同样的代码，一次过一次不过）。
   * CDP 的 frameNavigated 事件记录的是**导航当时**的 URL，不受后续 replaceState 影响。
   */
  const navigations = []
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data)
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message.result)
      pending.delete(message.id)
    }
    if (message.method === 'Runtime.consoleAPICalled') {
      consoleLines.push(
        `${message.params.type}: ${(message.params.args ?? [])
          .map((a) => a.value ?? a.description ?? '')
          .join(' ')}`,
      )
    }
    if (message.method === 'Network.webSocketCreated') wsUrls.push(message.params.url)
    if (message.method === 'Page.frameNavigated' && message.params?.frame?.url) {
      navigations.push(message.params.frame.url)
    }
  }
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const messageId = ++id
      pending.set(messageId, resolve)
      ws.send(JSON.stringify({ id: messageId, method, params }))
    })
  await send('Page.enable')
  await send('Runtime.enable')
  await send('Network.enable')
  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (result?.exceptionDetails) return { error: result.exceptionDetails.text }
    return result?.result?.value
  }
  const navigate = async (url, waitMs = 3000) => {
    await send('Page.navigate', { url })
    await sleep(waitMs)
  }
  return { chrome, send, evaluate, navigate, consoleLines, wsUrls, navigations, close: () => ws.close() }
}

await assertPortsFree()
const dshInstance = await startDsh()
const { child: dsh, dir: dshDir } = dshInstance
const proxy = await startProxy(dshInstance.log)
log(`实例就绪：DSH ${DSH_PORT}（loopback）/ 代理 ${PROXY_PORT}（0.0.0.0）`)

/**
 * ★ 核心回归断言：安装本插件**不得**改变 pathname `/` 的路由归属。
 *
 * 真实事故：插件曾注册 `{kind:'prefix', path:'/'}` 提供手机外壳，而 DSH 的
 * 分发是「最长前缀胜出 + 命中即 return」（register 没有 next()），
 * 而 `dsh web` 打印的唯一认证入口 URL 的 pathname 恰好是 `/`（`?token=`）——
 * token 兑换永不执行 → cookie 永远铸造不出来 → **任何浏览器 401 死循环**。
 *
 * 这里直接验证"独木桥仍可通行"：带 token 请求 `/` 必须拿到 303 + Set-Cookie。
 */
{
  const match = /token=([A-Za-z0-9_-]+)/.exec(dshInstance.log())
  check(match !== null, '启动日志里能取到 launch token')
  if (match !== null) {
    const token = match[1]
    const bare = await fetch(`http://127.0.0.1:${DSH_PORT}/`, { redirect: 'manual' })
    check(bare.status === 401, '未认证访问 `/` 返回 401（核心门禁生效）', `HTTP ${bare.status}`)
    const exchanged = await fetch(`http://127.0.0.1:${DSH_PORT}/?token=${token}`, { redirect: 'manual' })
    const setCookie = exchanged.headers.get('set-cookie') ?? ''
    check(
      exchanged.status === 303 && setCookie.includes('dsh-auth-'),
      '★ `/?token=` 仍能兑换 cookie（插件未抢占根路由）',
      `HTTP ${exchanged.status} set-cookie=${setCookie.slice(0, 40) || '(无)'}`,
    )
  }
}

const desktopProfile = mkdtempSync(join(tmpdir(), 'e2e-desktop-'))
const desktop = await openChrome(desktopProfile)
let phone

try {
  // ── 1. 电脑端 ──────────────────────────────────────────────────────────
  log('1) 电脑端（127.0.0.1，loopback）生成配对码')
  await desktop.navigate(DESKTOP_URL)
  await desktop.evaluate(`document.getElementById('gen').click()`)
  await sleep(1500)
  const code = await desktop.evaluate(`document.getElementById('code').textContent.trim()`)
  const payload = await desktop.evaluate(`document.getElementById('payload').value`)
  const phoneUrlShown = await desktop.evaluate(`document.getElementById('phone-url').textContent.trim()`)
  const fatal = await desktop.evaluate(`document.getElementById('fatal').textContent.trim()`)
  check(/^\d{6}$/.test(code), `电脑端生成 6 位配对码（${code}）`, fatal)
  check(
    phoneUrlShown.includes(String(PHONE_PORT)),
    `电脑端展示的手机地址用的是手机侧端口（${PHONE_PORT}${TLS_PORT > 0 ? '，HTTPS' : ''}）`,
    phoneUrlShown || '(空)',
  )
  check(!phoneUrlShown.includes(`:${DSH_PORT}/`), '电脑端展示的手机地址没有误用 DSH 自身端口', phoneUrlShown)

  // 载荷格式与端点自洽：否则第 3 步会以"这不是 DSH 的配对链接"失败，
  // 看起来像页面 bug，实际是插件安装时的 publicBaseUrl 与本次端口不一致。
  check(payload.startsWith('dshmobile://pair?d='), '配对载荷是 dshmobile:// 链接', payload.slice(0, 40) || '(空)')

  // ── 短码入口：手机只需在浏览器里打开 /mobile/p/<6 位码> ──
  // 为什么必须在这一层验：二维码里编的是 dshmobile:// 深链，**浏览器打不开**，
  // 所以在此之前手机侧唯一的办法是把那条长链复制粘贴进输入框。短码入口把这一步
  // 变成"照着电脑屏幕敲 6 个数字"。单测已覆盖 service 层与 302 的 Location，
  // 这里补的是**真实 HTTP 一跳**（含信任栅栏与端口/协议是否对得上）。
  if (/^\d{6}$/.test(code)) {
    const shortUrl = `${PHONE_SCHEME}://${LAN_IP}:${PHONE_PORT}/mobile/p/${code}`
    const shortRes = await fetch(shortUrl, { redirect: 'manual' }).catch(() => undefined)
    check(shortRes !== undefined && shortRes.status === 302, `短码入口 ${shortUrl} 返回 302`, `HTTP ${shortRes === undefined ? '请求失败' : shortRes.status}`)
    const location = shortRes === undefined ? '' : shortRes.headers.get('location') ?? ''
    check(
      location.startsWith('/mobile/app?pair='),
      '短码入口把我们跳到应用外壳并带上票据',
      location.slice(0, 48) || '(无 Location)',
    )
    const badRes = await fetch(`${PHONE_SCHEME}://${LAN_IP}:${PHONE_PORT}/mobile/p/000000`, { redirect: 'manual' }).catch(() => undefined)
    check(badRes !== undefined && badRes.status === 404, '无效短码返回 404（而不是静默跳到别处）', `HTTP ${badRes === undefined ? '请求失败' : badRes.status}`)
  }
  const ticket = JSON.parse(Buffer.from(payload.split('d=')[1] ?? '', 'base64url').toString('utf8'))
  check(
    Array.isArray(ticket.endpoints) && ticket.endpoints[0] === `http://${AUTHORITY}`,
    '票据端点与本次局域网 authority 一致',
    JSON.stringify(ticket.endpoints),
  )

  // ── 2. 手机端角色判定 ──────────────────────────────────────────────────
  log('2) 手机端（经代理 + x-forwarded-for）打开 /mobile')
  const phoneProfile = mkdtempSync(join(tmpdir(), 'e2e-phone-'))
  phone = await openChrome(phoneProfile)
  await phone.send('Network.setExtraHTTPHeaders', { headers: { 'x-forwarded-for': LAN_IP } })
  await phone.navigate(PHONE_URL)
  const isPhoneView = await phone.evaluate(`!document.getElementById('phone').classList.contains('hide')`)
  const isDesktopView = await phone.evaluate(`!document.getElementById('desktop').classList.contains('hide')`)
  check(isPhoneView === true, '手机看到的是手机端角色')
  check(isDesktopView === false, '手机没有看到电脑端控制台（权限未越界）')

  // ── 3. 手机提交配对请求 ────────────────────────────────────────────────
  log('3) 手机提交配对链接 → claim')
  await phone.evaluate(
    `(function () { var el = document.getElementById('link'); el.value = ${JSON.stringify(payload)}; return true })()`,
  )
  await phone.evaluate(`document.getElementById('do-pair').click()`)
  const claimDeadline = Date.now() + 25_000
  let navigated = false
  let handoffUrl = ''
  while (Date.now() < claimDeadline && !navigated) {
    await sleep(200)
    // 从导航事件里找带 pair 的那一次（见 navigations 的说明）
    const hit = phone.navigations.find((u) => u.includes('/mobile/app') && u.includes('pair='))
    if (hit !== undefined) {
      navigated = true
      handoffUrl = hit
      break
    }
    // 双保险：也看一眼当前地址（若还没被擦掉）
    const url = await phone.evaluate(`location.href`)
    if (typeof url === 'string' && url.includes('/mobile/app') && url.includes('pair=')) {
      navigated = true
      handoffUrl = url
    }
  }
  const phoneFatal = await phone.evaluate(`document.getElementById('phone-err') ? document.getElementById('phone-err').textContent.trim() : ''`)
  check(navigated, '手机 claim 成功后跳转到带 ?pair= 的界面地址', phoneFatal || '(未跳转)')

  if (navigated) {
    const token = new URL(handoffUrl).searchParams.get('pair')
    let decoded
    try {
      decoded = JSON.parse(Buffer.from(token.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'))
    } catch (error) {
      decoded = undefined
    }
    check(decoded !== undefined && typeof decoded === 'object', '?pair= 载荷是 base64url(JSON) 且可被 boot.js 解出')
    check(decoded?.ticket === ticket.ticket, '?pair= 载荷携带配对票据')
    check(decoded?.hostFingerprint === ticket.hostFingerprint, '?pair= 载荷携带宿主指纹（防中间人关键）')

    // boot.js 应在同一页面里装上传输层并读到配置
    const installed = await phone.evaluate(`!!(globalThis.__DSH_TRANSPORT__ && globalThis.__DSH_TRANSPORT__.ownsHost)`)
    const storedFp = await phone.evaluate(
      `(function () { try { return JSON.parse(localStorage.getItem('dsh-mobile.host') || '{}').pinnedHostFingerprint || '' } catch (e) { return '' } })()`,
    )
    // boot.js 读完即擦：地址栏里不应再残留票据（安全预期，不是缺陷）
    const scrubbed = await phone.evaluate(`location.search.indexOf('pair=') < 0`)
    check(scrubbed === true, 'boot.js 读取后已把票据从地址栏擦除')
    check(installed === true, 'boot.js 已装上 __DSH_TRANSPORT__（ownsHost）')
    check(storedFp === ticket.hostFingerprint, 'boot.js 读到固定的宿主指纹', storedFp || '(空)')
  }

  // ── 4. 电脑端确认指纹 ──────────────────────────────────────────────────
  log('4) 电脑端看到待确认设备并允许')
  await desktop.evaluate(`document.getElementById('refresh').click()`)
  await sleep(1500)
  const pendingText = await desktop.evaluate(`document.getElementById('pending').textContent`)
  const pendingHasFp = await desktop.evaluate(
    `!!document.querySelector('#pending .fp') && document.querySelector('#pending .fp').textContent.trim().length > 0`,
  )
  check(pendingHasFp, '电脑端列出了待确认设备及其指纹', pendingText.slice(0, 120))
  const clickedAllow = await desktop.evaluate(
    `(function () { var b = document.querySelector('#pending button.primary'); if (!b) return false; b.click(); return true })()`,
  )
  check(clickedAllow === true, '电脑端可点击「允许此设备」')
  await sleep(2000)

  // ── 5. 手机连上隧道 ────────────────────────────────────────────────────
  log('5) 手机自动重连并进入 DSH 界面')
  const tunnelDeadline = Date.now() + 30_000
  let wsSeen = false
  while (Date.now() < tunnelDeadline && !wsSeen) {
    await sleep(1000)
    wsSeen = phone.wsUrls.some((url) => url.includes('/mobile/ws'))
  }
  check(wsSeen, '手机建立了 /mobile/ws 隧道连接', phone.wsUrls.join(', ') || '(无)')

  const guiDeadline = Date.now() + 40_000
  let guiOk = false
  let lastProbe = ''
  while (Date.now() < guiDeadline && !guiOk) {
    await sleep(1500)
    // DSH 前端是单页应用，根元素 id 固定为 #root。
    // 这里断言"外壳已渲染出实质内容"，而不是只看 HTTP 200——
    // 客户端模块加载失败时页面同样 200，只是永远停在骨架屏。
    const probe = await phone.evaluate(`(function () {
      var root = document.getElementById('root')
      var text = root ? (root.innerText || '').replace(/\\s+/g, ' ').trim() : ''
      return JSON.stringify({
        hasRoot: !!root,
        textLen: text.length,
        head: text.slice(0, 60),
      })
    })()`)
    lastProbe = String(probe)
    try {
      const parsed = JSON.parse(probe)
      guiOk = parsed.hasRoot === true && parsed.textLen > 0
    } catch {
      /* 页面还在切 */
    }
  }
  check(guiOk, '手机进入了 DSH 界面（#root 已渲染出内容）', lastProbe)

  /**
   * ★ 关键：界面**能用**才算通过，只看"渲染出内容"不够。
   *
   * 这一条是被两次真实故障逼出来的：界面明明渲染出来了，但
   *   · `rpcId mismatch for <endpoint>`（我丢了 DSH 自己的 rpcId）——面板全部失效；
   *   · `connection: invalid server-response`（响应少一层信封）——同样失效。
   * 两者都**不影响**"#root 有文本"这个弱断言，所以 e2e 一直全绿而真机不可用。
   *
   * 因此这里断言：DSH 客户端在界面启动期间**没有抛出协议类错误**。
   * 这些错误的文案很有辨识度（rpcId mismatch / invalid server-response / transport failure）。
   */
  const protocolErrors = phone.consoleLines.filter((line) =>
    /rpcId mismatch|invalid server-response|transport failure|invalid server-stream/i.test(line),
  )
  check(
    protocolErrors.length === 0,
    '界面启动期间无协议层错误（rpcId / 响应信封）',
    protocolErrors.slice(0, 2).join(' | ') || '无',
  )

  // 界面真的把服务端能力加载出来了（agentPresets 生效时会出现"标准模式"这类文案）
  const rendered = await phone.evaluate(
    `(function () { var r = document.getElementById('root'); return r ? (r.innerText || '') : '' })()`,
  )
  check(
    typeof rendered === 'string' && rendered.length > 10,
    '界面渲染出了实际内容（而非空白骨架）',
    String(rendered).replace(/\s+/g, ' ').slice(0, 60),
  )

  // 隧道是否真的承载了业务：DSH 启动必然调用会话列表
  const tunnelCalls = phone.consoleLines.filter((line) => /dsh-mobile/i.test(line))
  log(`  手机端 boot.js 日志 ${tunnelCalls.length} 条${tunnelCalls.length > 0 ? `：${tunnelCalls.slice(0, 3).join(' | ')}` : ''}`)
  const phoneConsole = phone.consoleLines.filter((line) => /error|失败|decrypt|handshake/i.test(line))
  if (phoneConsole.length > 0) log(`  手机端 console（错误类）：${phoneConsole.slice(0, 6).join(' | ')}`)
} finally {
  phone?.close()
  desktop.close()
  phone?.chrome.kill()
  desktop.chrome.kill()
  killTree(dsh)
  killTree(proxy)
  await sleep(500)
  rmSync(desktopProfile, { recursive: true, force: true })
  rmSync(dshDir, { recursive: true, force: true })
  // ★ 两笔自己的账：Chrome 克隆残留 + 本次运行留下的测试 profile / 临时家目录 ✓
  sweepChromeClones(cloneSnapshot ?? new Set())
  removeQuietly(dshDir)
}

if (problems.length > 0) {
  console.error(`\n[e2e] 失败 ${problems.length} 项：`)
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}
console.log('\n[e2e] 全部端到端验收项通过 ✓')
