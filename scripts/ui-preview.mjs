#!/usr/bin/env node
/**
 * 移动端 UI 预览：起真实 DSH + 代理，用**移动视口**打开界面并自动截图。
 *
 * ## 为什么需要它（这几轮最大的教训）
 *
 * 我改移动端 CSS 的方式一直是"盲改"：看不到界面 → 靠 DOM 探针猜元素 → 推给用户 →
 * 用户截图 → 我再猜。结果连续引入 4 次回归（`syncNav` 读 null 崩溃、选择器打错元素、
 * 误删 `grid-area`、`left:-100%` 未生效），每一轮都消耗用户的时间。
 *
 * 正确做法是先让**我自己能看见**：这个脚本起一套完整环境，
 * 打印一条**可直接在电脑浏览器打开**的地址（带 token，视口用手机尺寸即可），
 * 并把截图存到 `docs/ui/`，供逐版对比。
 *
 * 用法：
 *   node scripts/ui-preview.mjs                 # 起环境并截图
 *   node scripts/ui-preview.mjs --keep          # 起环境后保持运行（Ctrl-C 结束），不退出
 *   node scripts/ui-preview.mjs --port 3770     # 指定端口（默认 3770，代理 3771/3772）
 *   node scripts/ui-preview.mjs --out /tmp/x    # 截图写到别处（默认 docs/ui/，那里是归档证据）
 */

import { spawn, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { snapshotChromeClones, sweepChromeClones, removeQuietly } from './chrome-clone-guard.mjs'
/** ★ Chrome `code_sign_clone` 残留守卫（见 chrome-clone-guard.mjs）：启动前拍快照、收尾时只删本次新增 ✓。 */
let cloneSnapshot = null
/** 拍快照：只在**第一次**启动 Chrome 之前拍 ✓ —— 多次启动时，最早那张快照才覆盖全部新增 ✓。 */
function markChromeLaunch() {
  if (cloneSnapshot === null) cloneSnapshot = snapshotChromeClones()
}

import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const repoRoot = dirname(here)
const argv = process.argv.slice(2)
/**
 * 取命令行参数。
 *
 * ★ 两种写法都认（`--port` 与 `port`）：上一版只认**不带横杠**的名字，
 *   而用法注释里写的是 `--port 3770` ✓ —— 于是这个参数**从来没生效过**，
 *   用户传了端口、脚本还是用默认的 3770，报错时只看到"连不上 3770" ✗
 *   （又一次"改了没生效"：参数被静默忽略，比报错更难查 ✓）。
 */
const flag = (name, fallback) => {
  const bare = name.replace(/^--?/, '')
  const index = argv.findIndex((arg) => arg === name || arg === bare)
  return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : fallback
}
const DSH_PORT = Number(flag('--port', '3770'))
const PROXY_PORT = DSH_PORT + 1
const TLS_PORT = DSH_PORT + 2
const KEEP = argv.includes('--keep')
/**
 * 预览用的 DSH profile 名。
 *
 * ## 2026-09 起：**自包含**，只读生产（round 80 改）
 *
 * 旧版直接在生产家目录上装插件（profile 只能叫 `web`），于是**预览与生产共用同一份**
 * `profiles/web/cordis.patch.yml`，而它是热重载的：预览一启动就把 `trustedHosts` /
 * `phoneBaseUrl` 改成预览端口，**生产的手机入口当场 403** ✗ —— 真实发生过两次，
 * 所以文档里一直写着"不要用 ui-preview 做验证" ✓。
 *
 * 现在的做法与 `shoot-ui.mjs` 完全一致：
 *   · **生产家目录只读**（只 `readFileSync` / `cpSync`）✓；
 *   · 工作区表**派生**一份到临时家目录（DSH 对它有 Zod 校验，手写最小结构会起不来 ✗）；
 *   · 会话按上限复制过去（侧栏里才有真实的会话可看 ✓）；
 *   · 证书从生产复制（自签、只在本机用）✓；
 *   · 退出时删掉临时家目录（`--keep` 保留以便排查）✓。
 *
 * 规矩不变：**验收工具不该有能力修改生产状态** ✓ —— 现在它连"改坏"的机会都没有了 ✓。
 */
const PREVIEW_PROFILE = 'web'
/** 只读的生产家目录（数据的**来源**）✓。 */
const SOURCE_HOME = process.env['DSH_HOME'] ?? join(homedir(), '.dsh')
/** 本次预览真正使用的**临时**家目录（生产一个字节都不会被写）✓。 */
const DSH_HOME = mkdtempSync(join(tmpdir(), 'ui-preview-home-'))
const LAN_IP = process.env['LAN_IP'] ?? '10.34.221.181'
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const { resolveDsh, explainMissingDsh } = await import(join(here, 'resolve-dsh.mjs'))
const fixture = await import(join(here, 'session-fixture.mjs'))

if (!existsSync(CHROME)) {
  console.error(`找不到 Chrome：${CHROME}`)
  process.exit(1)
}

console.log(`[ui-preview] 生产家目录（只读）：${SOURCE_HOME}`)
console.log(`[ui-preview] 本次预览用临时家目录：${DSH_HOME}`)

// 1) 把"看得见真实数据"所需的东西**派生**到临时家目录（全程只读生产）
mkdirSync(join(DSH_HOME, 'profiles', PREVIEW_PROFILE), { recursive: true })
const table = fixture.readProductionWorkspaceTable()
if (table === undefined) {
  console.error(`[ui-preview] 找不到 ${join(SOURCE_HOME, 'storages', 'workspace.json')}，无法派生工作区表`)
  process.exit(1)
}
fixture.writeWorkspaceTable(DSH_HOME, table)
const sessions = fixture.copyAllSessions({ dshHome: DSH_HOME, table })
console.log(`[ui-preview] 已派生 ${sessions.count} 个会话：${sessions.workspaces.map((w) => `${w.title}×${w.count}`).join('、') || '（无）'}`)
// 设置（主题/语言那类）也带一份，预览看起来才与真实一致；**凭证不复制**（预览只看界面）✓
const sourceSettings = join(SOURCE_HOME, 'settings.yaml')
if (existsSync(sourceSettings)) copyFileSync(sourceSettings, join(DSH_HOME, 'settings.yaml'))

// 2) 在**临时家目录**里装插件：authority 只需要预览端口（生产那份配置完全不用管）✓
const install = spawn(
  process.execPath,
  [
    join(here, 'install-host-plugin.mjs'),
    '--dsh-home', DSH_HOME,
    '--profile', PREVIEW_PROFILE,
    '--trusted-host', `${LAN_IP}:${PROXY_PORT}`,
    '--trusted-host', `${LAN_IP}:${TLS_PORT}`,
    '--phone-base-url', `https://${LAN_IP}:${TLS_PORT}`,
    '--skip-verify',
  ],
  { stdio: 'ignore' },
)
await new Promise((resolve) => install.on('close', resolve))

// 3) 证书：从生产复制（自签证书只在本机用）✓；没有就现生成一张
const tlsDir = join(DSH_HOME, 'storages', 'dsh-mobile', 'tls')
const certPath = join(tlsDir, 'lan-cert.pem')
mkdirSync(tlsDir, { recursive: true })
const sourceTls = join(SOURCE_HOME, 'storages', 'dsh-mobile', 'tls')
if (existsSync(join(sourceTls, 'lan-cert.pem'))) {
  copyFileSync(join(sourceTls, 'lan-cert.pem'), certPath)
  copyFileSync(join(sourceTls, 'lan-key.pem'), join(tlsDir, 'lan-key.pem'))
} else {
  console.log(`[ui-preview] 生产没有证书，现生成一张（SAN=${LAN_IP}）…`)
  const cert = spawn(process.execPath, [join(here, 'make-cert.mjs'), '--ip', LAN_IP, '--out-dir', tlsDir], { stdio: 'inherit' })
  await new Promise((resolve) => cert.on('close', resolve))
}

// 4) 起 DSH
/**
 * ★ 子进程登记表 + **最早期**注册的清理器。
 *
 * 为什么必须写在最前面：这一段之前的每一处 `process.exit(...)`（Chrome 不在、DSH 没起来、
 * token 拿不到…）都会**绕过后面那个 `finally`** ✗ —— 子进程（DSH / 代理 / Chrome）
 * 于是留在后台占着端口，下一次运行直接 `EADDRINUSE` ✓（实测踩到：3780 被上一轮遗留的
 * DSH 占住，而我在日志里只看到"DSH 未就绪" ✗）。
 * 这条教训在 `从这里开始.md` §7 第 4 条里写着（"进程在进入 try 块之前崩了，finally 根本没执行"），
 * 这一版把它真正落到了代码里 ✓。
 */
const spawnedChildren = []
const killChildren = () => {
  // ★ Chrome 会派生一堆 helper（zygote / GPU / renderer），它们**不在**我们那个进程组里 ✗ ——
  //   只 kill 主进程会留下孤儿，表现是"脚本明明结束了，调用方的管道却被占着不返回" ✓（实测）。
  //   所以再按 `--user-data-dir` 兜一遍（那是本次运行独有的临时目录 ✓ 不会误伤别处）。
  for (const child of spawnedChildren) {
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
const killChromeByProfile = () => {
  for (const child of spawnedChildren) {
    if (typeof child.spawnargs?.join === 'function' && child.spawnargs.join(' ').includes('--user-data-dir=')) {
      for (const arg of child.spawnargs) {
        if (!String(arg).startsWith('--user-data-dir=')) continue
        try {
          spawnSync('pkill', ['-f', String(arg).slice('--user-data-dir='.length)], { stdio: 'ignore' })
        } catch {
          /* pkill 不在也无所谓 */
        }
      }
    }
  }
}
process.on('exit', () => {
  killChildren()
  killChromeByProfile()
  /**
   * ★ 本脚本自己留下的两笔账（round 117 补）：
   *   ① Chrome 的 `code_sign_clone` 残留 ✓（这台机器的 Chrome 退出后不自己删 ✗）；
   *   ② 临时家目录 / 工作目录 ✓（以前从来不删 ✗ —— 每个几十 MB ✓，累积起来比克隆大得多 ✓）。
   *   全包在 try 里：`workDir` 是后面才 `const` 的 ✓，初始化中途退出时引用它会 TDZ 抛错 ✗。
   */
  try {
    sweepChromeClones(cloneSnapshot ?? new Set())
    removeQuietly(DSH_HOME)
    removeQuietly(workDir)
  } catch {
    /* 清理失败不该改变退出码 ✓ */
  }
})
process.on('SIGTERM', () => process.exit(0))

const workDir = mkdtempSync(join(tmpdir(), 'uip-'))
const dshBin = resolveDsh()
if (dshBin === undefined) {
  console.error(explainMissingDsh('ui-preview'))
  process.exit(1)
}
const dsh = spawn(dshBin, ['web', '--port', String(DSH_PORT), '--trusted-host', `${LAN_IP}:${PROXY_PORT}`, '--trusted-host', `${LAN_IP}:${TLS_PORT}`, '--no-open'], {
  cwd: workDir,
  env: { ...process.env, DSH_HOME },
  stdio: ['ignore', 'pipe', 'pipe'],
  detached: true,
})
spawnedChildren.push(dsh)
let dshOut = ''
dsh.stdout?.on('data', (c) => (dshOut += c))
dsh.stderr?.on('data', (c) => (dshOut += c))
const deadline = Date.now() + 90_000
while (!/token=/.test(dshOut) && Date.now() < deadline) await sleep(300)
const token = /token=([A-Za-z0-9_-]+)/.exec(dshOut)?.[1]
if (token === undefined) {
  console.error(`DSH 未就绪：\n${dshOut.slice(-800)}`)
  process.exit(1)
}

// 5) 起代理（明文 + TLS）
const proxy = spawn(
  process.execPath,
  [
    join(here, 'lan-proxy.mjs'),
    '--listen', `0.0.0.0:${PROXY_PORT}`,
    '--target', `127.0.0.1:${DSH_PORT}`,
    '--tls-listen', `0.0.0.0:${TLS_PORT}`,
    '--cert', join(DSH_HOME, 'storages', 'dsh-mobile', 'tls', 'lan-cert.pem'),
    '--key', join(DSH_HOME, 'storages', 'dsh-mobile', 'tls', 'lan-key.pem'),
  ],
  { stdio: 'ignore', detached: true },
)
await sleep(2500)

spawnedChildren.push(proxy)

const desktopUrl = `http://127.0.0.1:${DSH_PORT}/?token=${token}`
const phoneUrl = `https://${LAN_IP}:${TLS_PORT}/mobile/app`
console.log('\n════════ 预览地址 ════════')
console.log(`  电脑（DSH 本体）: ${desktopUrl}`)
console.log(`  手机形态         : ${phoneUrl}`)
console.log('  （在电脑浏览器里把窗口缩到手机宽度，看到的就是手机端的形态）')
console.log('  注意：手机形态需要先在电脑上完成配对——打开 ' + `http://127.0.0.1:${DSH_PORT}/mobile` + ' 生成配对码')
console.log('══════════════════════════\n')

// 5) 截图（移动视口 412×915），存到 docs/ui/
/**
 * 截图目录默认仍是 `docs/ui/`（这个脚本的用途就是逐版对比 ✓），
 * 但允许 `--out <目录>` 换到别处 —— 默认目录里是**归档证据**，
 * 名字固定就会覆盖它们 ✗（做验证时一律给临时目录 ✓）。
 */
const outDir = flag('--out', join(repoRoot, '..', 'docs', 'ui'))
mkdirSync(outDir, { recursive: true })
const shots = await shoot(phoneUrl, LAN_IP, TLS_PORT)
for (const [name, path] of Object.entries(shots)) console.log(`  截图 ${name}: ${path}`)



/**
 * 自动完成一次配对，让预览里能看到**完整界面**（含真实会话），而不是"未配对"空态。
 *
 * 为什么必须自动化：未配对时界面只显示「选择工作区」的引导页，
 * 顶栏、抽屉、输入区都不渲染——我前几轮就是在这种空态下反复"测量"，
 * 测到的全是空值，于是不断误判。预览必须进入"已配对且有会话"的状态才有意义。
 */
async function pairOnce(dshPort, lanIp, tlsPort) {
  const post = async (path, body) => {
    const response = await fetch(`http://127.0.0.1:${dshPort}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    })
    return response.json().catch(() => null)
  }
  const created = await post('/mobile/pair/code')
  if (created?.qrPayload === undefined) return undefined
  return created.qrPayload
}

/** 在页面里提交配对码并让电脑端自动允许（预览用，仅本地）。 */
async function autoPair(send, evaluate, dshPort, qrPayload) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  await send('Page.navigate', { url: `http://127.0.0.1:${dshPort}/mobile` })
  await sleep(3000)
  await evaluate(`document.getElementById('link').value=${JSON.stringify(qrPayload)}`)
  await evaluate(`document.getElementById('do-pair').click()`)
  await sleep(2500)
  const pending = await (await fetch(`http://127.0.0.1:${dshPort}/mobile/pair/pending`)).json().catch(() => null)
  const device = (pending?.pairings ?? []).find((x) => x.state === 'claimed')
  if (device !== undefined) {
    await fetch(`http://127.0.0.1:${dshPort}/mobile/pair/confirm`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: device.code, deviceId: device.deviceId, approve: true }),
    })
  }
  await sleep(8000)
}

async function shoot(url, lanIp, tlsPort) {
  const chromeDir = mkdtempSync(join(tmpdir(), 'uipc-'))
  const cdpPort = 9591
markChromeLaunch()
  const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${chromeDir}`, '--no-first-run', '--disable-gpu', '--ignore-certificate-errors', 'about:blank'], { stdio: 'ignore', detached: true })
  spawnedChildren.push(chrome)
  let target
  for (let i = 0; i < 40 && target === undefined; i++) {
    await sleep(300)
    try {
      target = (await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json()).find((t) => t.type === 'page')
    } catch {
      /* 还没起来 */
    }
  }
  if (target === undefined) return {}
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await Promise.race([new Promise((r) => (ws.onopen = r)), sleep(4000)])
  let id = 0
  const pending = new Map()
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data)
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message)
      pending.delete(message.id)
    }
  }
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const messageId = ++id
      pending.set(messageId, resolve)
      ws.send(JSON.stringify({ id: messageId, method, params }))
    })
  await send('Page.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: 412, height: 915, deviceScaleFactor: 2, mobile: true })
  await send('Emulation.setUserAgentOverride', { userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36' })
  const result = {}
  // 先完成配对（否则界面停在未配对空态，顶栏/抽屉/输入区都不渲染）
  // ★ 用**本次的** DSH_PORT：上一版这里读 `UI_PREVIEW_DSH_PORT` 且兜底 '3770'，
  //   于是 `--port` 传了别的值也没用，脚本一路连默认端口 ✗（第二处"参数被静默忽略"）
  const qrPayload = await pairOnce(DSH_PORT, lanIp, tlsPort)
  if (qrPayload !== undefined) {
    const evaluate = async (expression) => {
      const r = await Promise.race([send('Runtime.evaluate', { expression, returnByValue: true }), sleep(8000).then(() => ({ timeout: true }))])
      return r.timeout === true ? undefined : r.result?.result?.value
    }
    await autoPair(send, evaluate, DSH_PORT, qrPayload)
  }
  await send('Page.navigate', { url })
  await sleep(9000)
  const capture = async (name) => {
    const shot = await send('Page.captureScreenshot', { format: 'png' })
    if (shot?.result?.data !== undefined) {
      const file = join(outDir, `${name}.png`)
      writeFileSync(file, Buffer.from(shot.result.data, 'base64'))
      result[name] = file
    }
  }
  await capture('01-shell')
  // 打开抽屉再截一张
  await send('Runtime.evaluate', { expression: `document.getElementById('dsh-mobile-nav')?.click()`, returnByValue: true })
  await sleep(900)
  await capture('02-drawer')
  try {
    process.kill(-chrome.pid, 'SIGKILL')
  } catch {
    /* 已退出 */
  }
  rmSync(chromeDir, { recursive: true, force: true })
  void lanIp
  void tlsPort
  return result
}

/**
 * 还原插件配置。
 *
 * 预览把生产/预览两套 authority 并集写进了同一份 patch 文件，退出时把它写回原样，
 * 免得信任列表里长期留着一堆预览端口。**还原失败不影响可用性**——
 * 并集里始终保留着生产的 authority（见文件顶部说明）。
 */
/**
 * 退出时把**临时**家目录删掉（`--keep` 保留以便排查）✓。
 * 生产家目录从头到尾没被写过，所以这里不需要"还原"这类动作 ✓
 * —— 旧版靠"退出时把备份写回"来兜底，而它一旦没跑到（强杀），
 * 生产配置就留着预览端口 ✗（真实发生过两次）。
 */
const cleanupTempHome = () => {
  if (KEEP) {
    console.log(`[ui-preview] --keep：临时家目录留在 ${DSH_HOME}`)
    return
  }
  try {
    rmSync(DSH_HOME, { recursive: true, force: true })
  } catch {
    /* 忽略 */
  }
}
process.on('exit', cleanupTempHome)
process.on('SIGTERM', () => {
  /* 不再需要还原：生产配置从未被写过（自包含临时家目录）✓ */
  process.exit(0)
})

if (KEEP) {
  console.log('[ui-preview] --keep：环境保持运行，Ctrl-C 结束')
  process.on('SIGINT', () => {
    /* 子进程由最早期注册的 killChildren 负责 ✓（这里不必再手写一遍）*/
    process.exit(0)
  })
} else {
  killChildren()
  rmSync(workDir, { recursive: true, force: true })
  console.log('\n[ui-preview] 截图完成（环境已关闭）。加 --keep 可保持运行以便在浏览器里交互。')
}
