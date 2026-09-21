#!/usr/bin/env node
/**
 * 把**手机界面**在电脑上渲染出来并截图。
 *
 * ## 为什么需要它
 *
 * "把 UI 改好看一点"如果不能看见结果，就只是在改字符串。本项目已经吃过两次
 * "改 CSS 把界面改坏"的亏（`check-mobile-layout.mjs` 顶部记着那两次），
 * 而它的做法是**测量几何** ✓ —— 但几何对了不等于好看 ✗。
 *
 * 所以这里补上另一半：起一个**临时** DSH + 代理 + 无头 Chrome（真实移动视口，
 * 与手机同宽），把页面渲染出来、`Page.captureScreenshot` 存成 PNG ✓，
 * 然后用 `read_image` 直接看 ✓。改一次 → 截一次 → 看一次，几秒一轮。
 *
 * ## 环境是临时且隔离的
 *
 * 与 `check-mobile-layout.mjs` 同一套纪律 ✓：自建临时家目录、自己装插件、
 * 自己造一个演示工作区 ✓ —— **绝不碰 `~/.dsh`（生产）** ✓，
 * 也绝不依赖生产状态 ✓。跑完把临时目录删掉 ✓。
 *
 * ## 用法
 *
 * ```bash
 * node scripts/shoot-ui.mjs                       # 全景：会话页 / 抽屉 / 文件面板
 * node scripts/shoot-ui.mjs --shot files          # 只拍文件面板
 * node scripts/shoot-ui.mjs --shot multi          # 只拍多选态（含二次确认态）
 * node scripts/shoot-ui.mjs --shot statusbar      # 只拍会话页底部的「N 轮 M 步 / token」状态栏
 * node scripts/shoot-ui.mjs --shot statusbar --sessions auto   # 同上，并复制一份真实会话日志
 * node scripts/shoot-ui.mjs --shot files-empty    # 只拍空态
 * node scripts/shoot-ui.mjs --file /tmp/live-boot.js   # 跑**部署出去的那份产物**（验证"线上是哪一版"）
 * node scripts/shoot-ui.mjs --out /tmp/ui         # 指定输出目录
 * node scripts/shoot-ui.mjs --width 390 --height 844
 * ```
 */
import { execFileSync, spawn } from 'node:child_process'
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { snapshotChromeClones, sweepChromeClones, removeQuietly } from './chrome-clone-guard.mjs'
/** ★ Chrome `code_sign_clone` 残留守卫（见 chrome-clone-guard.mjs）：启动前拍快照、收尾时只删本次新增 ✓。 */
let cloneSnapshot = null
/** 拍快照：只在**第一次**启动 Chrome 之前拍 ✓ —— 多次启动时，最早那张快照才覆盖全部新增 ✓。 */
function markChromeLaunch() {
  if (cloneSnapshot === null) cloneSnapshot = snapshotChromeClones()
}

import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const repoRoot = join(here, '..')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const argv = process.argv.slice(2)
const flag = (name, fallback) => {
  const at = argv.indexOf('--' + name)
  return at === -1 ? fallback : argv[at + 1]
}

const DSH_PORT = Number(process.env['UI_DSH_PORT'] ?? 3673)
const PROXY_PORT = Number(process.env['UI_PROXY_PORT'] ?? 3671)
const TLS_PORT = Number(process.env['UI_TLS_PORT'] ?? 3672)
const CDP_PORT = Number(process.env['UI_CDP_PORT'] ?? 9721)
const LAN_IP = process.env['UI_LAN_IP'] ?? '10.34.221.181'
const WIDTH = Number(flag('width', '412'))
const HEIGHT = Number(flag('height', '915'))
const OUT = flag('out', join(tmpdir(), 'dshm-ui-shots'))
const ONLY = flag('shot', undefined)
const KEEP = argv.includes('--keep')
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const HARD_TIMEOUT_MS = Number(process.env['UI_TIMEOUT_MS'] ?? 240_000)

const hardTimer = setTimeout(() => {
  console.error(`[shoot-ui] 超过 ${Math.round(HARD_TIMEOUT_MS / 1000)} 秒仍未完成，强制退出`)
  process.exit(2)
}, HARD_TIMEOUT_MS)
hardTimer.unref?.()

// ── 演示工作区：内容要"像真的"，否则看不出排版好坏 ──────────────────
const DEMO = join(tmpdir(), 'dshm-ui-demo')
rmSync(DEMO, { recursive: true, force: true })
const demoFiles = [
  ['README.md', '# 演示工作区\n\n用来给文件目录面板截图。\n'],
  ['从这里开始.md', '# 从这里开始\n\n两分钟版交接。\n'],
  ['src/boot.js', '// 引导层\n'],
  ['src/tunnel.ts', '// 隧道\n'],
  ['src/host/index.ts', '// 宿主\n'],
  ['docs/protocol.md', '# 协议\n'],
  ['docs/design/UI 方案.md', '# UI 方案\n'],
  // 内容要"像真的文档"，否则截图里看不出排版对不对（标题/列表/代码块/表格/引用都要有 ✓）
  ['docs/项目说明.md', [
    '# 项目说明',
    '',
    '这是**粗体**、*斜体*与 `行内代码`，还有[一个链接](https://example.com)。',
    '',
    '## 这一节讲列表',
    '',
    '- 第一项',
    '- [ ] 还没做的',
    '- [x] 已经做完的',
    '',
    '> 一段引用：手机上读文档，格式比排版美观更重要。',
    '',
    '| 项 | 状态 |',
    '| --- | --- |',
    '| 预览 | 已支持 |',
    '| 排版 | 已支持 |',
    '',
    '```js',
    'const answer = 42',
    '```',
    '',
    '---',
    '',
    '结尾一段。',
    '',
  ].join('\n')],
  ['scripts/build-lib.mjs', '// 构建\n'],
  ['scripts/check-production.mjs', '// 自检\n'],
  ['packages/host/package.json', '{}\n'],
  ['照片/IMG_20260918_231412.jpg', 'x'.repeat(4 * 1024 * 1024)],
  ['备份/工程备份-2026-09-18.tar.gz', 'x'.repeat(2 * 1024 * 1024)],
]
for (const [relative, content] of demoFiles) {
  const full = join(DEMO, relative)
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, content)
}

// `--bigdir <N>`：在演示工作区里造一个 N 项的目录，用来量"大目录加载"的真实耗时与 DOM 规模。
// 为什么要有它：手机上打开一个上千项的目录，现在是**一句话都没有**地卡着，
// 而"卡多久""卡在哪一段（宿主列举 / 隧道 / 客户端渲染）"必须量出来才能改 ✓。
const BIGDIR_COUNT = Number(flag('bigdir', '0'))
if (BIGDIR_COUNT > 0) {
  const bigDir = join(DEMO, '大目录')
  mkdirSync(bigDir, { recursive: true })
  for (let i = 1; i <= BIGDIR_COUNT; i++) writeFileSync(join(bigDir, `条目-${String(i).padStart(5, '0')}.txt`), 'x')
  console.log(`[shoot-ui] 已造大目录：${BIGDIR_COUNT} 项 → ${bigDir}`)
}

const DSH_HOME = mkdtempSync(join(tmpdir(), 'ui-home-'))
const workDir = mkdtempSync(join(tmpdir(), 'ui-'))
mkdirSync(join(DSH_HOME, 'profiles', 'web'), { recursive: true })

// 预置工作区：DSH 的工作区表就在 storages/workspace.json。
//
// ★ 做法是**读生产那份、把演示工作区并进去、写到临时家目录** —— 全程只读生产 ✓。
//   为什么不能自己从零造一份：DSH 对这份存储有 Zod 校验与初始化状态，
//   我手写的最小结构会以 `invalid-record` 让 DSH 起不来（踩过）；
//   而从真实那份派生，格式天然正确 ✓。
mkdirSync(join(DSH_HOME, 'storages'), { recursive: true })
const sourceWorkspaces = join(process.env['HOME'] ?? '', '.dsh', 'storages', 'workspace.json')
if (!existsSync(sourceWorkspaces)) {
  console.error(`[shoot-ui] 找不到工作区表：${sourceWorkspaces}`)
  process.exit(1)
}
const table = JSON.parse(readFileSync(sourceWorkspaces, 'utf8'))
const demoId = 'a11ce000-0000-4000-8000-00000000dem0'
table.global = table.global ?? {}
table.global.workspaceIds = [demoId, ...(table.global.workspaceIds ?? [])]
table.tables = table.tables ?? {}
table.tables.workspaces = { [demoId]: {
  path: DEMO,
  title: '演示工作区',
  sessionIds: [],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
}, ...(table.tables.workspaces ?? {}) }
writeFileSync(join(DSH_HOME, 'storages', 'workspace.json'), JSON.stringify(table, null, 2))

/**
 * `--sessions auto|<sessionId>[,…]`：把**生产那份会话日志**只读复制进临时家目录。
 *
 * 为什么需要：DSH 的底部状态栏（`StatsPills`：`N 轮 M 步` / `token 用量`）在
 * `steps === 0` 时**整体不渲染** —— 欢迎页上它根本不存在 ✓。
 * 于是"截图里没有那条状态栏"既可能是"没有会话"，也可能是"我们把它改没了"，
 * 而这两件事在图上长得一模一样 ✗。要量它、要看它，就必须有一个**真的有轮次**的会话。
 *
 * 纪律：只 `cpSync` 复制（**只读生产**）✓，只复制会话日志本体（不复制 `session.lock`——
 * 那是进程锁，复制过来只会让 DSH 困惑）；临时目录跑完即删 ✓。
 */
const SESSIONS_ARG = flag('sessions', undefined)
const copiedSessions = []
if (SESSIONS_ARG !== undefined) {
  // 会话日志与工作区表**只读派生**（见 scripts/session-fixture.mjs 的说明）
  const fixture = await import(join(here, 'session-fixture.mjs'))
  const copied = fixture.copyWorkspaceSessions({ dshHome: DSH_HOME, table })
  if (copied.ids.length === 0) {
    console.error('[shoot-ui] --sessions 没有复制到任何会话（生产里没有可用的会话日志？）')
  } else {
    for (const id of copied.ids) copiedSessions.push({ id, title: copied.title })
    console.log(`[shoot-ui] 已复制 ${copied.ids.length} 个会话（工作区「${copied.title}」）`)
  }
}

execFileSync(
  process.execPath,
  [
    join(here, 'install-host-plugin.mjs'),
    '--dsh-home', DSH_HOME,
    '--profile', 'web',
    '--trusted-host', `${LAN_IP}:${PROXY_PORT}`,
    '--trusted-host', `${LAN_IP}:${TLS_PORT}`,
    '--phone-base-url', `https://${LAN_IP}:${TLS_PORT}`,
    '--skip-verify',
  ],
  { stdio: 'ignore' },
)

/**
 * `--file <路径>`：拿**部署出去的那份 boot.js**（profile 里的产物）覆盖临时实例要服务的那一份。
 *
 * 为什么需要：`install-host-plugin.mjs` 装的是**工作区里的源码**，所以默认截出来的图是
 * "源码长什么样"；而排障时真正要回答的是"**线上跑的那一版**长什么样"（改完没生效、
 * 生效的是哪一版，这两件事在手机上看起来一模一样）。与 `repro-boot.mjs` 的同名参数一致 ✓。
 *
 * 用法：
 * ```bash
 * curl -sk https://<电脑IP>:3443/mobile/boot.js -o /tmp/live-boot.js
 * node scripts/shoot-ui.mjs --shot multi --file /tmp/live-boot.js
 * ```
 */
const BOOT_FILE = flag('file', undefined)
if (BOOT_FILE !== undefined) {
  const installedBoot = join(DSH_HOME, 'profiles', 'web', 'node_modules', '@dsh-mobile', 'host', 'lib', 'boot.js')
  if (!existsSync(BOOT_FILE)) {
    console.error(`[shoot-ui] --file 指向的文件不存在：${BOOT_FILE}`)
    process.exit(1)
  }
  copyFileSync(BOOT_FILE, installedBoot)
  const stamp = /BUILD-[0-9]+/.exec(readFileSync(BOOT_FILE, 'utf8'))
  console.log(`[shoot-ui] 用部署产物跑：${BOOT_FILE}（戳 ${stamp === null ? '（无戳）' : stamp[0]}）`)
}

const tlsDir = join(DSH_HOME, 'storages', 'dsh-mobile', 'tls')
const sourceTls = join(process.env['HOME'] ?? '', '.dsh', 'storages', 'dsh-mobile', 'tls')
if (!existsSync(join(sourceTls, 'lan-cert.pem'))) {
  console.error(`[shoot-ui] 缺少 TLS 证书：${sourceTls}`)
  process.exit(1)
}
mkdirSync(tlsDir, { recursive: true })
copyFileSync(join(sourceTls, 'lan-cert.pem'), join(tlsDir, 'lan-cert.pem'))
copyFileSync(join(sourceTls, 'lan-key.pem'), join(tlsDir, 'lan-key.pem'))

const { resolveDsh, explainMissingDsh } = await import(join(here, 'resolve-dsh.mjs'))
const dshBin = resolveDsh()
if (dshBin === undefined) {
  console.error(explainMissingDsh('shoot-ui'))
  process.exit(1)
}

const children = []
const shutdown = () => {
  for (const child of children) {
    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch {
      /* 已经没了 */
    }
  }
}
process.on('exit', () => {
  shutdown()
  // ★ 收掉 Chrome 的 `code_sign_clone` 残留 ✓ —— 它不随进程退出消失 ✗（见 chrome-clone-guard.mjs）
  try {
    sweepChromeClones(cloneSnapshot ?? new Set())
  } catch {
    /* 清理失败不该影响脚本 ✓ */
  }
  if (!KEEP) {
    for (const dir of [DSH_HOME, workDir]) rmSync(dir, { recursive: true, force: true })
  } else {
    console.error(`[shoot-ui] --keep：临时家目录留在 ${DSH_HOME}`)
  }
})

const dsh = spawn(
  dshBin,
  ['web', '--port', String(DSH_PORT), '--trusted-host', `${LAN_IP}:${PROXY_PORT}`, '--trusted-host', `${LAN_IP}:${TLS_PORT}`, '--no-open'],
  { cwd: workDir, env: { ...process.env, DSH_HOME }, stdio: ['ignore', 'pipe', 'pipe'], detached: true },
)
children.push(dsh)
let dshOut = ''
dsh.stdout?.on('data', (chunk) => (dshOut += chunk))
dsh.stderr?.on('data', (chunk) => (dshOut += chunk))
for (let i = 0; i < 200 && !/token=/.test(dshOut); i++) await sleep(300)
if (!/token=/.test(dshOut)) {
  console.error(`[shoot-ui] DSH 未就绪：\n${dshOut.slice(-3000)}`)
  process.exit(1)
}

const proxy = spawn(
  process.execPath,
  [
    join(here, 'lan-proxy.mjs'),
    '--listen', `0.0.0.0:${PROXY_PORT}`,
    '--target', `127.0.0.1:${DSH_PORT}`,
    '--tls-listen', `0.0.0.0:${TLS_PORT}`,
    '--cert', join(tlsDir, 'lan-cert.pem'),
    '--key', join(tlsDir, 'lan-key.pem'),
  ],
  { stdio: 'ignore', detached: true },
)
children.push(proxy)
await sleep(1200)

const chromeDir = mkdtempSync(join(tmpdir(), 'ui-chrome-'))
markChromeLaunch()
const chrome = spawn(
  CHROME,
  ['--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${chromeDir}`, '--no-first-run', '--disable-gpu', '--ignore-certificate-errors', '--hide-scrollbars', 'about:blank'],
  { stdio: 'ignore', detached: true },
)
children.push(chrome)
let target
for (let i = 0; i < 80 && target === undefined; i++) {
  await sleep(300)
  try {
    target = (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()).find((t) => t.type === 'page')
  } catch {
    /* 还没起来 */
  }
}
if (target === undefined) {
  console.error('[shoot-ui] 无头 Chrome 未就绪')
  process.exit(1)
}

const ws = new WebSocket(target.webSocketDebuggerUrl)
ws.binaryType = 'arraybuffer'
await Promise.race([new Promise((resolve) => (ws.onopen = resolve)), sleep(5000)])
let messageId = 0
const pending = new Map()
ws.onmessage = (event) => {
  const message = JSON.parse(typeof event.data === 'string' ? event.data : Buffer.from(event.data).toString('utf8'))
  if (message.id && pending.has(message.id)) {
    pending.get(message.id)(message)
    pending.delete(message.id)
  }
}
const send = (method, params = {}) =>
  new Promise((resolve) => {
    const id = ++messageId
    pending.set(id, resolve)
    ws.send(JSON.stringify({ id, method, params }))
  })
await send('Page.enable')
await send('Runtime.enable')
// ★ 打开焦点模拟：无头页面默认"没有被聚焦"，于是 `element.focus()` **不会触发 focus/focusin 事件**
//   （实测：连页面里自己挂的 focusin 探针都收不到 ✗）。而"输入法弹出来"这条链全靠 focus 事件，
//   不开这个开关就只能量到假象 ✓。
await send('Emulation.setFocusEmulationEnabled', { enabled: true })
await send('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: HEIGHT, deviceScaleFactor: 2, mobile: true })
await send('Emulation.setUserAgentOverride', {
  userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
})
const evaluate = async (expression) => {
  const result = await Promise.race([
    send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }),
    sleep(10_000).then(() => ({ timeout: true })),
  ])
  if (result.timeout === true) return '(超时)'
  if (result.result?.exceptionDetails) return `(异常) ${result.result.exceptionDetails.text}`
  return result.result?.result?.value
}

/** 在视口坐标上发一次**可信**点击（页面里的 `element.click()` 不算用户手势，测聚焦必须用真事件）。 */
const tapAt = async (x, y) => {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
}

/** 取一个元素中心点的视口坐标（点不到就返回 undefined）。 */
const centerOf = async (selector) =>
  evaluate(`(function(){
    var el=document.querySelector(${JSON.stringify(selector)})
    if(!el) return null
    var r=el.getBoundingClientRect()
    if(r.width<=0||r.height<=0) return null
    return JSON.stringify({x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}) })()`)

const post = async (path, body) => {
  const response = await fetch(`http://127.0.0.1:${DSH_PORT}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })
  return response.json().catch(() => null)
}

const shots = []
const shoot = async (name) => {
  const result = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  const data = result.result?.data
  if (typeof data !== 'string') {
    console.error(`[shoot-ui] ${name} 截图失败`)
    return
  }
  mkdirSync(OUT, { recursive: true })
  const file = join(OUT, `${name}.png`)
  writeFileSync(file, Buffer.from(data, 'base64'))
  shots.push(file)
  console.log(`  · ${file}`)
}

try {
  // ── 配对（与 check-mobile-layout 同一套流程）──
  const created = await post('/mobile/pair/code')
  await send('Page.navigate', { url: `https://${LAN_IP}:${TLS_PORT}/mobile` })
  await sleep(2500)
  await evaluate(`document.getElementById('link').value=${JSON.stringify(created.qrPayload)}`)
  await evaluate(`document.getElementById('do-pair').click()`)
  await sleep(2500)
  const pendingList = await (await fetch(`http://127.0.0.1:${DSH_PORT}/mobile/pair/pending`)).json()
  const device = (pendingList.pairings ?? []).find((x) => x.state === 'claimed')
  if (device !== undefined) await post('/mobile/pair/confirm', { code: device.code, deviceId: device.deviceId, approve: true })
  await sleep(12_000)
  for (let i = 0; i < 3; i++) {
    const clicked = await evaluate(
      `(function(){var b=[].slice.call(document.querySelectorAll('button')).find(function(x){return /稍后配置|继续|跳过/.test(x.innerText||'')});if(b){b.click();return true}return false})()`,
    )
    if (clicked !== true) break
    await sleep(1500)
  }

  const ready = await evaluate(`!!document.getElementById('dsh-mobile-files')`)
  if (ready !== true) {
    console.error('[shoot-ui] 手机外壳未就绪，页面文本：' + String(await evaluate('(document.body.innerText||"").slice(0,200)')))
    process.exit(1)
  }

  console.log(`[shoot-ui] 移动视口 ${WIDTH}×${HEIGHT}，输出到 ${OUT}`)
  const want = (name) => ONLY === undefined || ONLY === name

  if (want('conversation')) {
    await evaluate(`(function(){var n=document.getElementById('dsh-mobile-drawer-backdrop');if(n)n.click()})()`)
    await sleep(600)
    await shoot('conversation')
  }

  if (want('drawer')) {
    await evaluate(`document.getElementById('dsh-mobile-nav').click()`)
    await sleep(900)
    await shoot('drawer')
    await evaluate(`document.getElementById('dsh-mobile-nav').click()`)
    await sleep(700)
  }

  if (want('files')) {
    await evaluate(`document.getElementById('dsh-mobile-files').click()`)
    await sleep(1500)
    await shoot('files')

    // 几何探针：改版时"看起来不对"必须能变成数字，否则只能靠猜
    const probe = await evaluate(`(function(){
      function box(sel){var e=document.querySelector(sel);if(!e)return null;var r=e.getBoundingClientRect();
        return {x:Math.round(r.left),y:Math.round(r.top),w:Math.round(r.width),h:Math.round(r.height)}}
      var head=document.getElementById('dsh-mobile-sheet-head');
      var cs=head?getComputedStyle(head):null;
      return JSON.stringify({
        panel: box('#dsh-mobile-sheet-panel'),
        head: box('#dsh-mobile-sheet-head'),
        title: box('.dshm-sheet-title'),
        close: box('#dsh-mobile-sheet-close'),
        gear: box('#dsh-mobile-sheet-gear'),
        sub: box('.dshm-sheet-sub'),
        foot: box('#dsh-mobile-sheet-foot'),
        askbar: box('[data-dshm-askbar]'),
        // 图标的**实际绘制范围**（viewBox 用户单位）：若中心不是 (12,12)，
        // 图标在按钮里看起来就是歪的 —— 而按钮几何完全对称时，这是唯一可疑处。
        gearBBox: (function(){var svg=document.querySelector('#dsh-mobile-sheet-gear svg');if(!svg)return null;var b=svg.getBBox();return {x:+b.x.toFixed(2),y:+b.y.toFixed(2),w:+b.width.toFixed(2),h:+b.height.toFixed(2)}})(),
        headDisplay: cs?cs.display:null,
        headColumns: cs?cs.gridTemplateColumns:null,
        bodyOverflowY: (function(){var b=document.getElementById('dsh-mobile-sheet-body');return b?getComputedStyle(b).overflowY:null})()
      })
    })()`)
    console.log('  [探针] ' + String(probe))

    // 进入第一个工作区的**文件列表** —— 这一屏才是版式好坏的关键
    const opened = await evaluate(
      // 工作区行现在整行就是按钮（.dshm-ws），不再有「浏览文件…」那个大按钮
      `(function(){var r=document.querySelector('.dshm-ws');if(!r)return false;r.click();return r.innerText.replace(/\s+/g,' ').slice(0,40)})()`,
    )
    await sleep(1800)
    await shoot('files-list')
    console.log(`  （工作区按钮 ${String(opened)} 个）`)

    // 再进一层目录：看面包屑、返回、以及目录内的排布
    const entered = await evaluate(
      `(function(){var r=[].slice.call(document.querySelectorAll('[data-dshm-fs-entry]'));for(var i=0;i<r.length;i++){if(r[i].getAttribute('data-dshm-fs-kind')==='dir'){r[i].click();return r[i].innerText}}return false})()`,
    )
    await sleep(1400)
    await shoot('files-inside')
    if (entered !== false) console.log(`  （进入目录：${String(entered).slice(0, 30)}）`)
    // 路径行探针：文字 / 颜色 / 尺寸 / 是否被裁掉
    const crumb = await evaluate(`(function(){
      var e=document.querySelector('.dshm-crumb-path');if(!e)return '(没有路径元素)';
      var r=e.getBoundingClientRect();var cs=getComputedStyle(e);
      return JSON.stringify({tag:e.tagName,text:e.textContent,color:cs.color,fontSize:cs.fontSize,
        w:Math.round(r.width),h:Math.round(r.height),x:Math.round(r.left),
        overflow:cs.overflow,display:cs.display,flex:cs.flex,opacity:cs.opacity,visibility:cs.visibility})
    })()`)
    console.log(`  （路径行：${String(crumb)}）`)
  }

  if (want('multi')) {
    // 多选态核对：进入 / 勾选 / 计数 / 底栏替换 / 退出还原
    await evaluate(`document.getElementById('dsh-mobile-files').click()`)
    await sleep(1200)
    await evaluate(`(function(){var r=document.querySelector('.dshm-ws');if(r)r.click()})()`)
    await sleep(1800)
    const entered = await evaluate(`(function(){var b=[].slice.call(document.querySelectorAll('button')).find(function(x){return (x.innerText||'').trim()==='选择'});if(!b)return '(没有「选择」按钮)';b.click();return 'ok'})()`)
    await sleep(800)
    await shoot('multi-enter')
    const chipsVisible = `Array.prototype.filter.call(document.querySelectorAll('.dshm-cap-chip'),function(c){return c.offsetParent!==null}).length`
    const before = await evaluate(`(function(){var f=document.getElementById('dsh-mobile-sheet-foot');return JSON.stringify({foot:(f?f.innerText.replace(/\\s+/g,' ').slice(0,50):''),chips:${chipsVisible},rows:document.querySelectorAll('.dshm-file').length,selecting:document.body.dataset.dshmSelecting||'(无标记)'})})()`)
    const ticked = await evaluate(`(function(){var h=[].slice.call(document.querySelectorAll('.dshm-file-head'));var n=0;for(var i=0;i<Math.min(2,h.length);i++){h[i].click();n++}return n})()`)
    await sleep(700)
    await shoot('multi-selected')
    const after = await evaluate(`(function(){var f=document.getElementById('dsh-mobile-sheet-foot');return JSON.stringify({foot:(f?f.innerText.replace(/\\s+/g,' ').slice(0,50):''),chips:${chipsVisible}})})()`)
    console.log(`  （进入多选：${entered} | 之前：${before}）`)
    console.log(`  （勾了 ${ticked} 行 → 之后：${after}）`)
    await evaluate(`(function(){var b=[].slice.call(document.querySelectorAll('#dsh-mobile-sheet-foot button')).find(function(x){return /取消/.test(x.innerText||'')});if(b)b.click()})()`)
    await sleep(800)
    const back = await evaluate(`(function(){var f=document.getElementById('dsh-mobile-sheet-foot');return JSON.stringify({foot:(f?f.innerText.replace(/\\s+/g,' ').slice(0,40):''),chips:${chipsVisible}})})()`)
    await shoot('multi-exit')
    console.log(`  （取消后：${back}）`)
  }

  if (want('settings')) {
    await evaluate(`document.getElementById('dsh-mobile-files').click()`)
    await sleep(1200)
    const opened = await evaluate(`(function(){var g=document.getElementById('dsh-mobile-sheet-gear');if(!g)return false;g.click();return true})()`)
    await sleep(1000)
    await shoot('settings')
    const text = await evaluate(
      `(function(){var b=document.getElementById('dsh-mobile-sheet-body');return b?b.innerText.replace(/\\s+/g,' ').slice(0,160):'(无)'})()`,
    )
    console.log(`  （齿轮：${opened} | 设置内容：${String(text)}）`)
    // 再点一次应**返回文件视图**（齿轮是开关）
    const back = await evaluate(`(function(){
      var g=document.getElementById('dsh-mobile-sheet-gear');if(!g)return null;
      g.click();
      var t=document.querySelector('.dshm-sheet-title');
      var ws=document.querySelectorAll('.dshm-ws').length;
      return JSON.stringify({title:t?t.textContent:'', workspaces:ws, gearActive:g.dataset.active||'0'})
    })()`)
    await sleep(900)
    await shoot('settings-back')
    console.log(`  （再点齿轮 → ${String(back)}）`)
  }

  if (want('copy')) {
    // 「复制路径」这一跳要真的点出来看：剪贴板 API 在无头 Chrome / WebView 里
    // 时灵时不灵，所以这里既截图、也把状态行的原文打出来对账。
    await evaluate(`document.getElementById('dsh-mobile-files').click()`)
    await sleep(1200)
    await evaluate(`(function(){var r=document.querySelector('.dshm-ws');if(r)r.click()})()`)
    await sleep(1800)
    const expanded = await evaluate(`(function(){
      var rows=[].slice.call(document.querySelectorAll('.dshm-file'));
      for(var i=0;i<rows.length;i++){
        var icon=rows[i].querySelector('.dshm-file-icon');
        var more=rows[i].querySelector('.dshm-file-more');
        if(!more||!icon) continue;
        if(icon.dataset.kind==='directory') continue;
        more.click();
        return rows[i].innerText.replace(/\\s+/g,' ').slice(0,30);
      }
      return false
    })()`)
    await sleep(700)
    await shoot('copy-actions')
    const clicked = await evaluate(`(function(){
      var b=[].slice.call(document.querySelectorAll('.dshm-file-actions button')).find(function(x){return /复制路径/.test(x.innerText||'')});
      if(!b) return '(没有「复制路径」按钮)';
      b.click(); return '已点击'
    })()`)
    await sleep(900)
    await shoot('copy-done')
    const note = await evaluate(
      `(function(){var n=document.getElementById('dsh-mobile-sheet-note');return n?n.textContent:'(无状态行)'})()`,
    )
    console.log(`  （展开条目：${String(expanded).slice(0, 24)} | ${clicked} | 状态行：${String(note).slice(0, 90)}）`)
    // 顺带验"点路径行复制当前目录路径"
    const dirCopied = await evaluate(`(function(){
      var c=document.querySelector('.dshm-crumb-path');if(!c)return '(没有路径行)';
      c.click();return '已点击'
    })()`)
    await sleep(800)
    const dirNote = await evaluate(
      `(function(){var n=document.getElementById('dsh-mobile-sheet-note');return n?n.textContent:'(无状态行)'})()`,
    )
    console.log(`  （${dirCopied} → 状态行：${String(dirNote).slice(0, 80)}）`)
  }

  if (want('multi')) {
    // 多选批量操作：进文件列表 → 点「选择」→ 勾两项 → 截一次 → 点一次「删除」（只到确认态）。
    // 这里**刻意不真的删**：截图脚本只负责"看见"，破坏性验证在 check-device-channel 里。
    await evaluate(`document.getElementById('dsh-mobile-files').click()`)
    await sleep(1500)
    await evaluate(`(function(){var r=document.querySelector('.dshm-ws');if(r)r.click()})()`)
    await sleep(1800)
    const entered = await evaluate(`(function(){
      var b=[].slice.call(document.querySelectorAll('.dshm-files-toolbar button')).find(function(x){return x.textContent.trim()==='选择'});
      if(!b) return '(没有「选择」按钮)';
      b.click(); return 'ok'
    })()`)
    await sleep(600)
    // 勾两项：一个文件 + 一个目录 —— 删除时 `recursive` 的两条分支都进画面
    const ticked = await evaluate(`(function(){
      var rows=[].slice.call(document.querySelectorAll('[data-dshm-fs-entry]'))
      var picked=[rows.filter(function(r){return r.getAttribute('data-dshm-fs-kind')==='file'})[0],
                  rows.filter(function(r){return r.getAttribute('data-dshm-fs-kind')==='dir'})[0]]
      var paths=[]
      picked.forEach(function(r){ if(r){ r.querySelector('.dshm-file-head').click(); paths.push(r.getAttribute('data-dshm-path')) } })
      return paths.join(' | ')
    })()`)
    await sleep(500)
    await shoot('multi-select')
    // 探针：底栏几何 / 计数 / 端侧开关（**必须还在 DOM 里**，只是被收起）
    const probeMulti = await evaluate(`(function(){
      function box(sel){var e=document.querySelector(sel);if(!e)return null;var r=e.getBoundingClientRect();
        return {x:Math.round(r.left),y:Math.round(r.top),w:Math.round(r.width),h:Math.round(r.height)}}
      var caps=document.querySelector('.dshm-caps')
      return JSON.stringify({
        bar: box('#dsh-mobile-sheet-select'),
        count: (document.getElementById('dshm-select-count')||{}).textContent||null,
        selectedRows: document.querySelectorAll('.dshm-file[data-selected="1"]').length,
        visibleChecks: document.querySelectorAll('.dshm-file[data-selecting="1"] .dshm-file-check').length,
        moreButtonsVisible: [].slice.call(document.querySelectorAll('.dshm-file-more')).filter(function(m){return getComputedStyle(m).display!=='none'}).length,
        capsInDom: caps!==null,
        capsDisplay: caps?getComputedStyle(caps).display:null,
        barButtons: [].slice.call(document.querySelectorAll('#dsh-mobile-sheet-select button')).map(function(b){return b.textContent.trim()})
      })
    })()`)
    console.log('  [探针] ' + String(probeMulti))
    const armed = await evaluate(`(function(){
      var b=document.getElementById('dshm-select-delete');
      if(!b) return '(没有删除按钮)';
      b.click();
      return JSON.stringify({text:b.textContent.trim(), confirm:b.dataset.confirm})
    })()`)
    await sleep(600)
    await shoot('multi-confirm')
    const note = await evaluate(`(function(){var n=document.getElementById('dsh-mobile-sheet-note');return n?n.textContent:''})()`)
    console.log(`  （进入多选：${String(entered)} | 勾选：${String(ticked).slice(0, 60)}）`)
    console.log(`  （点一次「删除」：${String(armed)} | 提示行：${String(note).slice(0, 60)}）`)
    // 收尾：退出多选态，确认底栏收起、端侧开关还原（截图脚本不该把界面留在半路状态）
    const restored = await evaluate(`(function(){
      var bs=[].slice.call(document.querySelectorAll('#dsh-mobile-sheet-select button'));
      var cancel=bs.filter(function(x){return x.textContent.trim()==='取消'})[0];
      if(cancel) cancel.click();
      var bar=document.getElementById('dsh-mobile-sheet-select');
      var caps=document.querySelector('.dshm-caps');
      return JSON.stringify({barHidden:bar?bar.hidden:null, capsDisplay:caps?getComputedStyle(caps).display:null})
    })()`)
    console.log(`  （退出多选 → ${String(restored)}）`)
  }

  if (want('statusbar')) {
    /**
     * 会话页底部那条「N 轮 M 步 / token 用量」。
     *
     * 它由 DSH 自己的 `StatsPills` 渲染，而 `stats.steps === 0` 时**整体不渲染** ——
     * 所以欢迎页上量不到它（不是"量失败"，是它真的不在 DOM 里）。要量它就得先
     * 打开一个**真实会话**：`--sessions auto` 会把一份生产会话日志只读复制进临时家目录。
     *
     * 探针把"结构"而不是"观感"写下来：类名后缀、`aria-label`、几何、父链。
     * 改 UI 的正确姿势是先钉死这些，再动一行 CSS ✓。
     */
    await evaluate(`(function(){var n=document.getElementById('dsh-mobile-nav');if(n)n.click()})()`)
    await sleep(1300)
    const sidebar = await evaluate(`(function(){
      function rows(sel){return [].slice.call(document.querySelectorAll(sel)).slice(0,6).map(function(e){
        var r=e.getBoundingClientRect()
        return {tag:e.tagName,cls:String(e.className).slice(0,34),x:Math.round(r.left),y:Math.round(r.top),w:Math.round(r.width),h:Math.round(r.height),text:(e.innerText||'').replace(/\\s+/g,' ').slice(0,34)}})}
      return JSON.stringify({projects:rows('[class*="_projectRow"]'),sessions:rows('[class*="_sessionRow"]'),titles:rows('[class*="_title"]')})
    })()`)
    console.log('  [侧栏结构] ' + String(sidebar).slice(0, 900))

    // 展开目标工作区 → 点第一个会话行（DSH 侧栏的工作区行点击 = 展开/收起会话列表）。
    // 工作区**按标题选**：`--sessions auto` 复制的会话属于哪个工作区，就点哪个 ——
    // 点错行会打开一个没被复制过来的会话，表现是"会话打不开"，与我们要测的东西无关 ✗。
    const wantTitle = copiedSessions.length > 0 ? copiedSessions[0].title : undefined
    const expanded = await evaluate(`(function(){
      var title=${JSON.stringify(wantTitle ?? null)}
      var rows=[].slice.call(document.querySelectorAll('[class*="_projectRow"]'))
      var target=null
      for(var i=0;i<rows.length;i++){ if(title && (rows[i].innerText||'').indexOf(title)>=0){ target=rows[i]; break } }
      if(!target) target=rows[0]
      if(!target) return '(没有工作区行)'
      target.click(); return (target.innerText||'').replace(/\\s+/g,' ').slice(0,24) })()`)
    await sleep(1500)
    /**
     * 挨个试会话行，直到宿主那行（`[data-composer-stats]`）出现在 DOM 里。
     *
     * 为什么不能只点第一个：会话行的 DOM 不暴露 session id（只有 `role="treeitem"`），
     * 而**空会话根本不渲染状态栏** —— 点错了就会拍出一张"没有状态栏"的图，
     * 与"我们把状态栏改没了"完全同形 ✗。
     * 判定用 **textContent**：那行被我们 `visibility:hidden` 收起后 `innerText` 恒为空 ✗。
     */
    let clicked = '(没有会话行)'
    for (let i = 0; i < 6; i++) {
      const row = await evaluate(`(function(){
        var byClass=[].slice.call(document.querySelectorAll('[class*="_sessionRow"]'))
        var rows=byClass.length>0?byClass:[].slice.call(document.querySelectorAll('[role="treeitem"]'))
        var r=rows[${i}]; if(!r) return null
        r.click(); return (r.innerText||'').replace(/\\s+/g,' ').slice(0,30) })()`)
      if (row === null || row === undefined) break
      clicked = row
      await sleep(5500)
      const hasBar = await evaluate(`(function(){
        var r=document.querySelector('[data-composer-stats]')
        return r!==null&&r!==undefined&&(r.textContent||'').length>0 })()`)
      if (hasBar === true) break
    }
    await evaluate(`(function(){var b=document.getElementById('dsh-mobile-drawer-backdrop');if(b)b.click()})()`)
    await sleep(1000)
    await shoot('statusbar')

    const probe = await evaluate(`(function(){
      function round(v){return Math.round(v)}
      function boxOf(e){var r=e.getBoundingClientRect();return {x:round(r.left),y:round(r.top),w:round(r.width),h:round(r.height)}}
      function chainOf(e){var out=[],n=e;for(var i=0;i<4&&n;i++){n=n.parentElement;if(!n||n===document.body)break
        out.push({tag:n.tagName,cls:String(n.className).slice(0,44),display:getComputedStyle(n).display,box:boxOf(n)})}return out}
      var root=document.querySelector('[data-composer-stats]')
      var hostOk = root!==null && root!==undefined
      var hostBox = hostOk?boxOf(root):null
      var cs = hostOk?getComputedStyle(root):null
      var hostButtons = hostOk?[].slice.call(root.querySelectorAll('button')).map(function(b){
        return {aria:b.getAttribute('aria-label'),box:boxOf(b),text:(b.innerText||'').replace(/\\s+/g,' ').slice(0,44)}}):[]
      if(!hostOk) return JSON.stringify({hostFound:false})
      var mine=document.getElementById('dshm-stats')
      if(!mine) return JSON.stringify({hostFound:true,hostBox:hostBox,hostButtons:hostButtons,mineFound:false,hostCss:{h:cs.height,pad:cs.padding,vis:cs.visibility}})
      var kids=[].slice.call(mine.querySelectorAll('button,span')).map(function(e){
        return {tag:e.tagName,id:e.id||null,cls:String(e.className).slice(0,30),box:boxOf(e),
          text:(e.innerText||'').replace(/\\s+/g,' ').slice(0,44),
          display:getComputedStyle(e).display}})
      return JSON.stringify({
        hostFound:true, hostBox:hostBox,
        hostCss:{height:cs.height,minHeight:cs.minHeight,padding:cs.padding,visibility:cs.visibility,overflow:cs.overflow},
        hostButtons:hostButtons,
        mineFound:true, mineBox:boxOf(mine), mineText:(mine.innerText||'').replace(/\\s+/g,' '),
        mineOn:mine.dataset.on, mineKids:kids, mineChain:chainOf(mine),
        composerBox:(function(){var c=document.querySelector('[class*="composerStack"]');return c?boxOf(c):null})()
      })
    })()`)
    console.log('  [状态栏探针] ' + String(probe).slice(0, 2600))
    // 点开详情：**必须等 React 重渲染**再查 —— 第一版点完立刻 `querySelectorAll`，
    // 于是两个对话框都读成空数组，看起来像"转发没生效"（其实是量早了）✗
    // ── DSH 自己的「上下文已用」环 + 面板（真·已用/上限）──
    // 它可能已经在手机上可见、也可用；量清楚它在哪里，才知道我们该不该再画一条条。
    const meter = await evaluate(`(async function(){
      var wait=function(ms){return new Promise(function(r){setTimeout(r,ms)})}
      function boxOf(e){var r=e.getBoundingClientRect();return {x:Math.round(r.left),y:Math.round(r.top),w:Math.round(r.width),h:Math.round(r.height)}}
      var trig=document.querySelector('[aria-haspopup="dialog"][aria-label*="上下文已用"]')
      if(!trig) return JSON.stringify({found:false})
      var cs=getComputedStyle(trig)
      var chain=[],n=trig
      for(var i=0;i<3&&n;i++){n=n.parentElement;if(!n||n===document.body)break
        chain.push({tag:n.tagName,cls:String(n.className).slice(0,36),box:boxOf(n)})}
      trig.click(); await wait(700)
      var panel=document.querySelector('[role="dialog"][aria-label="上下文已用"]')
      var out={found:true,aria:trig.getAttribute('aria-label'),box:boxOf(trig),display:cs.display,visibility:cs.visibility,
        inViewport:(function(){var r=trig.getBoundingClientRect();return r.top>=0&&r.bottom<=window.innerHeight&&r.left>=0&&r.right<=window.innerWidth})(),
        chain:chain,
        panel:panel?{box:boxOf(panel),text:(panel.textContent||'').replace(/\\s+/g,' ').trim().slice(0,160),
          bar:(function(){var b=panel.querySelector('[class*="_bar"]');if(!b)return null;var r=b.getBoundingClientRect()
            return {w:Math.round(r.width),h:Math.round(r.height),segs:[].slice.call(b.children).map(function(c){return Math.round(c.getBoundingClientRect().width)})}})()}:null}
      trig.click(); await wait(400)
      return JSON.stringify(out) })()`)
    console.log('  [上下文环探针] ' + String(meter).slice(0, 1400))
    /**
     * 谁给宿主元素加了这条样式？（CDP 版）
     *
     * 为什么需要它：这轮用户报"点开上下文比例多了一块空白区域"，我在页面内扫
     * `document.styleSheets` **什么都扫不到**（规则来自 `adoptedStyleSheets`/更高层），
     * 最后是 CDP 的 `CSS.getMatchedStylesForNode` 一句话给出答案：
     *   `[class*="header"] → padding-top: calc(var(--dshm-top-h) + …) !important`
     * —— **是我们自己那条选择器写太宽的规则**（把面板的 header 也推下去 52px）✗。
     *
     * 凡是"宿主元素看起来不对"的排查，先用这条探针问浏览器"谁命中了它"，
     * 比按类名去 grep 源码快得多 ✓（DSH 的类名是构建哈希，grep 也 grep 不到）。
     */
    await evaluate(`(function(){
      var t=document.querySelector('button[aria-haspopup="dialog"] svg circle[stroke-dasharray]')
      if(t) t.closest('button').click(); return true })()`)
    await sleep(800)
    try {
      await send('DOM.enable')
      await send('CSS.enable')
      const doc = await send('DOM.getDocument', { depth: 1 })
      const found = await send('DOM.querySelector', {
        nodeId: doc.result.root.nodeId,
        selector: '[role="dialog"][aria-label="上下文已用"] [class*="_header"]',
      })
      if (found.result?.nodeId) {
        const styles = await send('CSS.getMatchedStylesForNode', { nodeId: found.result.nodeId })
        const rules = (styles.result?.matchedCSSRules ?? []).map((row) => {
          const text = row.rule.style.cssText ?? ''
          return `${row.rule.selectorList.text.slice(0, 60)} → ${text.slice(0, 120)} [${row.rule.origin}]`
        })
        console.log('  [CDP 命中规则] ' + JSON.stringify(rules).slice(0, 1200))
        const inline = styles.result?.inlineStyle?.cssText ?? '(无内联样式)'
        console.log('  [CDP 内联样式] ' + String(inline).slice(0, 300))
      } else {
        console.log('  [CDP 命中规则] 没找到 header 节点')
      }
    } catch (error) {
      console.log('  [CDP 命中规则] 查询失败：' + String(error && error.message ? error.message : error).slice(0, 120))
    }
    await evaluate(`(function(){
      var t=document.querySelector('button[aria-haspopup="dialog"] svg circle[stroke-dasharray]')
      if(t) t.closest('button').click(); return true })()`)
    await sleep(400)

    // ── 那块空白是谁加的：把**所有匹配到 panel/header 的 CSS 规则**列出来 ──
    // （CSS 模块里查不到 padding-top:52px，所以直接问浏览器"谁匹配了这个元素"）
    const matched = await evaluate(`(async function(){
      var wait=function(ms){return new Promise(function(r){setTimeout(r,ms)})}
      var t=document.querySelector('button[aria-haspopup="dialog"] svg circle[stroke-dasharray]')
      if(!t) return '(没有上下文环)'
      t.closest('button').click(); await wait(700)
      var panel=document.querySelector('[role="dialog"][aria-label="上下文已用"]')
      if(!panel){ t.closest('button').click(); return '(面板没打开)' }
      var targets={panel:panel, header:panel.querySelector('[class*="_header"]')}
      var out={}
      for (var key in targets){
        var el=targets[key]; if(!el) continue
        var hits=[]
        for(var i=0;i<document.styleSheets.length;i++){
          var rules=null
          try{ rules=document.styleSheets[i].cssRules }catch(e){ continue }
          if(!rules) continue
          var stack=[].slice.call(rules)
          while(stack.length){
            var r=stack.pop()
            if(r.cssRules){ stack.push.apply(stack,[].slice.call(r.cssRules)); continue }
            if(!r.selectorText) continue
            var applies=false
            try{ applies=el.matches(r.selectorText) }catch(e){ applies=false }
            if(!applies) continue
            var css=r.style&&r.style.cssText?r.style.cssText:''
            if(!/padding|margin|height/.test(css)) continue
            hits.push(r.selectorText.slice(0,60)+' { '+css.slice(0,90)+' }')
          }
        }
        out[key]=hits
      }
      t.closest('button').click(); await wait(300)
      return JSON.stringify(out) })()`)
    console.log('  [谁匹配了面板] ' + String(matched).slice(0, 1500))

    // ── 输入框右侧那一排：谁占了位、"空位"到底是哪一段 ──
    const trailing = await evaluate(`(function(){
      function box(e){if(!e)return null;var r=e.getBoundingClientRect();return {x:Math.round(r.left),r:Math.round(r.right),w:Math.round(r.width),h:Math.round(r.height)}}
      var trig=document.querySelector('button[aria-haspopup="dialog"] svg circle[stroke-dasharray]')
      if(!trig) return JSON.stringify({found:false})
      var button=trig.closest('button')
      var root=button.parentElement
      var row=root.parentElement
      var cs=getComputedStyle(row)
      var kids=[].slice.call(row.children).map(function(c){
        var s=getComputedStyle(c)
        return {tag:c.tagName,cls:String(c.className||'').slice(0,26),box:box(c),
          display:s.display,position:s.position,visibility:s.visibility,isMeterRoot:c===root}})
      // "空位" = 仪表容器左邻居的右缘 → 发送键左缘
      var idx=kids.findIndex(function(k){return k.isMeterRoot})
      var prev=idx>0?row.children[idx-1]:null
      var next=idx>=0&&idx+1<row.children.length?row.children[idx+1]:null
      return JSON.stringify({row:{box:box(row),display:cs.display,justify:cs.justifyContent,gap:cs.gap,align:cs.alignItems},
        rootBox:box(root),rootPosition:getComputedStyle(root).position,rootWidth:getComputedStyle(root).width,
        kids:kids,
        gapLeft: prev?Math.round(box(next).x-box(prev).r):null,
        prevCls:prev?String(prev.className||'').slice(0,24):null,
        nextCls:next?String(next.className||'').slice(0,24):null}) })()`)
    console.log('  [输入框右侧排布] ' + String(trailing).slice(0, 1100))

    const meterShot = await evaluate(`(function(){
      var t=document.querySelector('[aria-haspopup="dialog"][aria-label*="上下文已用"]')
      if(!t) return false
      t.click(); return true })()`)
    if (meterShot === true) {
      await sleep(800)
      await shoot('statusbar-context')
      await evaluate(`(function(){var t=document.querySelector('[aria-haspopup="dialog"][aria-label*="上下文已用"]');if(t)t.click()})()`)
      await sleep(400)
    }

    const dialogs = await evaluate(`(async function(){
      var wait=function(ms){return new Promise(function(r){setTimeout(r,ms)})}
      var readDialogs=function(){return [].slice.call(document.querySelectorAll('[role="dialog"]')).map(function(d){
        var r=d.getBoundingClientRect()
        return {label:d.getAttribute('aria-label'),x:Math.round(r.left),y:Math.round(r.top),w:Math.round(r.width),h:Math.round(r.height),
          text:(d.innerText||'').replace(/\\s+/g,' ').slice(0,80)}})}
      var out={}
      for (const id of ['dshm-stats-context','dshm-stats-time','dshm-stats-usage']) {
        var b=document.getElementById(id)
        if(!b){ out[id]='(没有这个段)'; continue }
        b.click(); await wait(700)
        var open=readDialogs()
        b.click(); await wait(700)
        var closed=readDialogs()
        out[id]={openCount:open.length,open:open,closedCount:closed.length}
      }
      return JSON.stringify(out) })()`)
    console.log('  [点开详情→宿主对话框] ' + String(dialogs).slice(0, 1200))
    await sleep(600)
    await shoot('statusbar-open')
    await evaluate(`(function(){var b=document.getElementById('dshm-stats-usage');if(b)b.click()})()`)
    await sleep(700)
    await shoot('statusbar-dialog')
    await evaluate(`(function(){var b=document.getElementById('dshm-stats-usage');if(b)b.click()})()`)
    await sleep(500)
    console.log(`  （打开的工作区：${String(expanded)} | 会话行：${String(clicked)}）`)
  }

  if (want('bigdir')) {
    /**
     * 打开一个大目录：**逐帧记录**发生了什么（这是"改之前"的基线）。
     *
     * 记录方式：点之前先在面板 body 上挂一个 `MutationObserver`，把每次 DOM 变动
     * 连同"距点击多少毫秒、当时有多少行、提示行写的什么"一起存进 `window.__big` ✓ ——
     * 比按固定间隔轮询靠谱（轮询会漏掉一闪而过的"读取中"那行）。
     */
    await evaluate(`document.getElementById('dsh-mobile-files').click()`)
    await sleep(1500)
    await evaluate(`(function(){var r=document.querySelector('.dshm-ws');if(r)r.click()})()`)
    await sleep(1900)
    const armed = await evaluate(`(function(){
      var body=document.getElementById('dsh-mobile-sheet-body')
      if(!body) return false
      window.__big={t0:0,events:[],maxRows:0,maxNodes:0}
      var record=function(){
        var rows=document.querySelectorAll('.dshm-file').length
        var nodes=document.querySelectorAll('#dsh-mobile-sheet-body *').length
        var msg=document.querySelector('[data-dshm-loading]')||document.querySelector('.dshm-ws-path')
        if(rows>window.__big.maxRows) window.__big.maxRows=rows
        if(nodes>window.__big.maxNodes) window.__big.maxNodes=nodes
        window.__big.events.push({t:Math.round(performance.now()-window.__big.t0),rows:rows,nodes:nodes,
          msg:msg?(msg.textContent||'').replace(/\s+/g,' ').slice(0,28):null})
      }
      var obs=new MutationObserver(record)
      obs.observe(body,{childList:true,subtree:true})
      window.__bigObs=obs
      window.__bigRecord=record
      return true })()`)
    const clicked = await evaluate(`(function(){
      var rows=[].slice.call(document.querySelectorAll('[data-dshm-fs-entry]'))
      for(var i=0;i<rows.length;i++){
        if((rows[i].innerText||'').indexOf('大目录')>=0){
          window.__big.t0=performance.now()
          rows[i].querySelector('.dshm-file-head').click()
          return true } }
      return false })()`)
    await sleep(120)
    await shoot('bigdir-loading')
    await sleep(2500)
    await shoot('bigdir-loaded')
    const report = await evaluate(`(function(){
      var ev=window.__big?window.__big.events:[]
      // 只留"状态变化"的那些采样（行数或提示行变了），避免几千条噪声
      var slim=[],prev=''
      for(var i=0;i<ev.length;i++){
        var key=ev[i].rows+'|'+ev[i].msg
        if(key===prev) continue
        prev=key; slim.push(ev[i])
      }
      var rows=document.querySelectorAll('.dshm-file').length
      var nodes=document.querySelectorAll('#dsh-mobile-sheet-body *').length
      var body=document.getElementById('dsh-mobile-sheet-body')
      var first=slim.length?slim[0]:null, last=slim.length?slim[slim.length-1]:null
      return JSON.stringify({
        changes:slim.length,firstAt:first?first.t:null,rowsAtFirst:first?first.rows:null,
        lastAt:last?last.t:null,rows:rows,nodes:nodes,maxRows:window.__big.maxRows,maxNodes:window.__big.maxNodes,
        sawLoading: ev.some(function(e){return e.msg&&e.msg.indexOf('读取')>=0}),
        timeline:slim.slice(0,6),tail:slim.slice(-4),
        bodyText:(body?(body.innerText||'').replace(/\s+/g,' ').slice(0,90):null)}) })()`)
    console.log(`  [大目录测量] 挂好观察器=${String(armed)} 点到大目录=${String(clicked)} → ` + String(report).slice(0, 1200))
    const after = await evaluate(`(function(){
      function box(e){if(!e)return null;var r=e.getBoundingClientRect();return {y:Math.round(r.top),h:Math.round(r.height)}}
      var info=document.querySelector('[data-dshm-listing-info]')
      var more=document.querySelector('[data-dshm-more]')
      // ★ 先把所有值读下来**再**点击：info 是活元素，点完再读会读到点击后的文案 ✗
      // （注：这段在模板字符串里，注释**不能出现反引号** —— 已踩三次，见简报第 3 条坑）
      var before=document.querySelectorAll('.dshm-file').length
      var infoBefore=info?info.textContent:null
      var labelBefore=more?more.textContent:null
      var nodesBefore=document.querySelectorAll('#dsh-mobile-sheet-body *').length
      if(more) more.click()
      return JSON.stringify({rowsBefore:before,nodesBefore:nodesBefore,
        infoBefore:infoBefore,moreLabel:labelBefore,moreBox:box(more)}) })()`)
    await sleep(900)
    const afterClick = await evaluate(`(function(){
      var info=document.querySelector('[data-dshm-listing-info]')
      var more=document.querySelector('[data-dshm-more]')
      return JSON.stringify({rows:document.querySelectorAll('.dshm-file').length,nodes:document.querySelectorAll('#dsh-mobile-sheet-body *').length,
        info:info?info.textContent:null,moreLabel:more?more.textContent:null}) })()`)
    console.log('  [大目录封顶] 点击前：' + String(after).slice(0, 300))
    console.log('  [大目录封顶] 点「继续显示」后：' + String(afterClick).slice(0, 300))
    await shoot('bigdir-more')
  }

  if (want('preview')) {
    /**
     * 测一件事：**DSH 自带的文件预览在手机上到底能不能用？**
     *
     * 为什么先测再决定：DSH 的文档预览渲染在**右侧栏**里（`dsh-client-ui-sidebar-documentpreview`），
     * 而我们的窄屏 CSS **并没有藏它**（只改了 z-index）✓ —— 所以"要不要自己再做一个预览"
     * 取决于它现在能不能用 ✗✓（本项目的老规矩：提议之前先查，别重复造）
     * —— §32.1 就有一次"以为缺、其实工具栏里早就有「上传」"的教训 ✓。
     */
    // 先找"看起来是文件引用"的可点元素（转录里那些路径 chip）
    const candidates = await evaluate(`(function(){
      var out=[]
      var all=[].slice.call(document.querySelectorAll('button,a,[role="button"],[class*="link"],[class*="Link"]'))
      for(var i=0;i<all.length&&out.length<8;i++){
        var t=(all[i].innerText||all[i].textContent||'').replace(/\s+/g,' ').trim()
        if(t.length<3||t.length>80) continue
        if(!/[\/.]/.test(t)) continue
        if(!/[A-Za-z]/.test(t)) continue
        var r=all[i].getBoundingClientRect()
        if(r.width<=0||r.height<=0) continue
        if(r.top<0||r.bottom>window.innerHeight) continue
        out.push({tag:all[i].tagName,cls:String(all[i].className||'').slice(0,34),text:t.slice(0,34),
          x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)})
      }
      return JSON.stringify(out) })()`)
    console.log('  [预览·候选] ' + String(candidates).slice(0, 800))
    const list = typeof candidates === 'string' ? JSON.parse(candidates) : []
    // 打开抽屉看会话（复用 statusbar 那段的做法：按标题选工作区，再点会话行）
    const opened = await evaluate(`(function(){
      var n=document.getElementById('dsh-mobile-nav'); if(!n) return false
      n.click(); return true })()`)
    await sleep(1300)
    const rows = await evaluate(`(function(){
      var rs=[].slice.call(document.querySelectorAll('[class*="_projectRow"]'))
      var target=rs[0]
      for(var i=0;i<rs.length;i++){ if((rs[i].innerText||'').indexOf('工程设计')>=0){ target=rs[i]; break } }
      if(!target) return false
      target.click(); return true })()`)
    await sleep(1400)
    let openedSession = false
    for (let i = 0; i < 4 && !openedSession; i++) {
      const clicked = await evaluate(`(function(){
        var rs=[].slice.call(document.querySelectorAll('[class*="_sessionRow"]'))
        if(!rs[${i}]) return false
        rs[${i}].click(); return true })()`)
      if (clicked !== true) break
      await sleep(5000)
      const hasStats = await evaluate(`(function(){var r=document.querySelector('[data-composer-stats]');return r!==null&&r!==undefined&&(r.textContent||'').length>0})()`)
      if (hasStats === true) openedSession = true
    }
    await evaluate(`(function(){var b=document.getElementById('dsh-mobile-drawer-backdrop');if(b)b.click()})()`)
    await sleep(900)
    // 转录里的"文件引用"到底长什么样：把所有**文本像路径**的叶子元素都列出来
    const pathEls = await evaluate(`(function(){
      var out=[]
      var all=document.querySelectorAll('*')
      for(var i=0;i<all.length&&out.length<10;i++){
        var el=all[i]
        if(el.children.length>0) continue
        var t=(el.textContent||'').replace(/\\s+/g,' ').trim()
        if(t.length<4||t.length>70) continue
        if(!/[A-Za-z0-9_-]+\\.[A-Za-z]{1,4}\\b/.test(t) && !new RegExp('/[A-Za-z0-9_-]+/').test(t)) continue
        var r=el.getBoundingClientRect()
        if(r.width<=0||r.height<=0) continue
        out.push({tag:el.tagName,cls:String(el.className||'').slice(0,36),role:el.getAttribute('role'),
          clickable:el.tagName==='BUTTON'||el.tagName==='A'||el.getAttribute('role')==='button'||el.tabIndex>=0,
          text:t.slice(0,40),x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)})
      }
      return JSON.stringify(out) })()`)
    console.log('  [预览·路径元素] ' + String(pathEls).slice(0, 900))
    // 逐个试：点最像"文件引用"的几个，直到出现预览面板（或全都试完）
    const attempts = []
    const plist = typeof pathEls === 'string' ? JSON.parse(pathEls) : []
    let previewFound = null
    for (const item of plist.slice(0, 5)) {
      await evaluate(`(function(){
        var all=document.querySelectorAll('*'),want=${JSON.stringify(item.text)}
        for(var i=0;i<all.length;i++){
          if(all[i].children.length>0) continue
          if((all[i].textContent||'').replace(/\\s+/g,' ').trim().slice(0,40)!==want) continue
          var el=all[i]
          // 先点它自己；没反应再点它的可点祖先（DSH 的路径 chip 常常是"里层 span + 外层按钮"）
          var target=el
          for(var d=0;d<4&&target;d++){
            if(target.tagName==='BUTTON'||target.tagName==='A'||target.getAttribute('role')==='button') break
            target=target.parentElement
          }
          ;(target||el).click()
          return true }
        return false })()`)
      await sleep(1600)
      const seen = await evaluate(`(function(){
        function box(e){if(!e)return null;var r=e.getBoundingClientRect();return {x:Math.round(r.left),y:Math.round(r.top),w:Math.round(r.width),h:Math.round(r.height)}}
        var hits=[]
        var all=document.querySelectorAll('*')
        for(var i=0;i<all.length;i++){
          var cls=String(all[i].className||'')
          if(!/preview|Preview/i.test(cls)) continue
          var b=box(all[i]); if(!b||b.w<=0||b.h<=0) continue
          hits.push({cls:cls.slice(0,42),box:b,text:(all[i].innerText||'').replace(/\\s+/g,' ').slice(0,40)})
          if(hits.length>=3) break
        }
        var bar=document.querySelector('[class*="rightbarCol"]')
        return JSON.stringify({hits:hits,rightbar:box(bar)}) })()`)
      attempts.push({text: item.text.slice(0, 26), tag: item.tag, seen: String(seen).slice(0, 220)})
      const parsed = typeof seen === 'string' ? JSON.parse(seen) : {}
      if ((parsed.hits ?? []).length > 0 || (parsed.rightbar ?? {}).w > 40) {
        previewFound = parsed
        break
      }
    }
    const clicked = JSON.stringify(attempts).slice(0, 600)
    const previewProbe = JSON.stringify(previewFound ?? { none: true })
    console.log('  [预览·探针结果] ' + String(previewProbe).slice(0, 700))
    const preview = await evaluate(`(function(){
      function box(e){if(!e)return null;var r=e.getBoundingClientRect();return {x:Math.round(r.left),y:Math.round(r.top),w:Math.round(r.width),h:Math.round(r.height)}}
      var bar=document.querySelector('[class*="rightbarCol"]')
      var hit=[]
      var all=document.querySelectorAll('*')
      for(var i=0;i<all.length;i++){
        var cls=String(all[i].className||'')
        if(!/preview|Preview|document/i.test(cls)) continue
        var b=box(all[i]); if(!b||b.w<=0||b.h<=0) continue
        hit.push({cls:cls.slice(0,40),box:b,text:(all[i].innerText||'').replace(/\s+/g,' ').slice(0,40)})
        if(hit.length>=4) break
      }
      return JSON.stringify({opened:${JSON.stringify(String(openedSession))},clicked:${JSON.stringify('')},
        rightbar:box(bar),
        rightbarVisible: bar!==null && getComputedStyle(bar).visibility!=='hidden' && box(bar).w>0,
        previews:hit, viewport:{w:window.innerWidth,h:window.innerHeight}}) })()`)
    console.log(`  [预览·点了什么] ${String(clicked).slice(0, 120)}`)
    console.log('  [预览·右栏与预览元素] ' + String(preview).slice(0, 1000))
    await shoot('preview')
    void opened
  }

  if (want('keyboard')) {
    /**
     * "切会话/切工作区，手机输入法自己弹出来"这个问题的**契约测试**。
     *
     * 背景：根因在宿主 —— `ui-conversation` 里那段
     * `useEffect(() => editor.getRootElement()?.focus(), [sessionId, …])`
     * 会在每次切会话时重新聚焦 composer ✓。无头环境里复现不了它
     * （那里的 composer 是 `contenteditable="false"` 的只读态，effect 直接 return ✗），
     * 所以这里**不依赖复现**，直接验我们那条守卫的四条规则 ✓：
     *   ① 没有手势的程序化聚焦 → 必须被撤销；
     *   ② 用户真的点它 → 必须保留（否则等于把打字弄坏）；
     *   ③ 手势后 250ms 内的聚焦 → 放行；
     *   ④ 我们自己的面板输入框 → 一律放行。
     */
    await evaluate(`(function(){
      var host=document.querySelector('[class*="centerCol"]')||document.body
      var probe=document.createElement('input')
      probe.type='text'
      probe.id='dshm-focus-probe'
      probe.setAttribute('aria-label','聚焦探针')
      probe.style.cssText='position:fixed;left:12px;bottom:120px;width:200px;height:34px;z-index:9999'
      host.appendChild(probe)
      return true })()`)
    await sleep(400)
    // 守卫到底装上了没有？—— 用 CDP 直接数 document 上的 focusin 监听器（最硬的证据）
    let listeners = null
    try {
      const doc = await send('Runtime.evaluate', { expression: 'document' })
      const found = await send('DOMDebugger.getEventListeners', { objectId: doc.result?.result?.objectId, depth: 0 })
      listeners = (found.result?.listeners ?? []).map((l) => l.type)
    } catch (error) {
      listeners = '查询失败：' + String(error && error.message ? error.message : error).slice(0, 80)
    }
    const guardMark = await evaluate(`document.body.dataset.dshmKeyboardGuard||null`)
    console.log(`  [聚焦守卫] 安装标记=${String(guardMark)} document 上的监听器=${JSON.stringify(listeners).slice(0, 200)}`)
    const rule1 = await evaluate(`(function(){
      var el=document.getElementById('dshm-focus-probe')
      var seen=[]
      var spy=function(e){ seen.push(e.target.id||e.target.tagName) }
      document.addEventListener('focusin',spy,true)
      el.focus()
      var focusedNow=document.activeElement===el
      document.removeEventListener('focusin',spy,true)
      return JSON.stringify({focused:focusedNow,focusinFired:seen.length,seen:seen,
        guard:document.body.dataset.dshmKeyboardGuard||null,activeTag:document.activeElement?document.activeElement.tagName:null}) })()`)
    // ② 用户真的点它（可信手势）→ 应该聚焦
    const pos = await centerOf('#dshm-focus-probe')
    let rule2 = null
    if (pos !== null) {
      await evaluate(`(function(){var a=document.activeElement;if(a&&a.blur)a.blur()})()`)
      await tapAt(JSON.parse(pos).x, JSON.parse(pos).y)
      await sleep(400)
      rule2 = await evaluate(`(function(){
        var el=document.getElementById('dshm-focus-probe')
        return JSON.stringify({focused:document.activeElement===el}) })()`)
    }
    // ③ 手势之后 250ms 内的程序化聚焦 → 放行
    const rule3 = await evaluate(`(function(){
      var el=document.getElementById('dshm-focus-probe')
      if(document.activeElement&&document.activeElement.blur)document.activeElement.blur()
      el.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}))
      el.focus()
      var kept=document.activeElement===el
      if(document.activeElement&&document.activeElement.blur)document.activeElement.blur()
      return JSON.stringify({kept:kept}) })()`)
    // ④ 我们自己的面板输入框：点「新建」后应被自动聚焦
    await evaluate(`document.getElementById('dsh-mobile-files').click()`)
    await sleep(1200)
    await evaluate(`(function(){var r=document.querySelector('.dshm-ws');if(r)r.click()})()`)
    await sleep(1500)
    const rule4 = await evaluate(`(async function(){
      var wait=function(ms){return new Promise(function(r){setTimeout(r,ms)})}
      var mk=[].slice.call(document.querySelectorAll('.dshm-files-toolbar button')).filter(function(b){return /新建/.test(b.textContent||'')})[0]
      if(!mk) return JSON.stringify({found:false})
      mk.click(); await wait(400)
      var input=document.querySelector('.dshm-prompt-input')
      return JSON.stringify({found:true,focused:input!==null&&document.activeElement===input}) })()`)
    await evaluate(`(function(){var el=document.getElementById('dshm-focus-probe');if(el)el.remove()})()`)
    console.log(`  [聚焦守卫] ①无手势聚焦被撤销=${String(rule1)}`)
    console.log(`  [聚焦守卫] ②真手势点它=${String(rule2)}`)
    console.log(`  [聚焦守卫] ③手势后 250ms 内放行=${String(rule3)}`)
    console.log(`  [聚焦守卫] ④我们自己的输入框=${String(rule4)}`)
    await shoot('keyboard-guard')
  }

  /**
   * 文件预览（round 83，用户第 1 点）。
   *
   * 拍的是"点开一个真代码文件"的那一屏：等宽字体、长行可横向滚、
   * 工具行（返回 / 下载 / 在电脑上打开）都要在画面里 ✓。
   */
  if (want('preview')) {
    await evaluate(`document.getElementById('dsh-mobile-files').click()`)
    await sleep(1400)
    // 确保在演示工作区里（点第一个工作区行）
    await evaluate(`(function(){var bar=document.querySelector('.dshm-files-toolbar');var bs=bar===null?[]:[].slice.call(bar.querySelectorAll('button'));for(var i=0;i<bs.length;i++){if(/工作区/.test(bs[i].textContent||'')){bs[i].click();return true}}return false})()`)
    await sleep(1200)
    await evaluate(`(function(){var rows=[].slice.call(document.querySelectorAll('.dshm-ws'));if(rows.length>0)rows[0].click()})()`)
    await sleep(1600)
    // 进 scripts/ 目录再点一个 .mjs（真实代码文件）
    await evaluate(`(function(){var rows=[].slice.call(document.querySelectorAll('[data-dshm-fs-entry="1"]'));for(var i=0;i<rows.length;i++){var n=rows[i].querySelector('.dshm-file-name');if(n&&/^scripts$/.test(String(n.textContent||''))){rows[i].querySelector('.dshm-file-head').click();return true}}return false})()`)
    await sleep(1500)
    const clicked = await evaluate(`(function(){var rows=[].slice.call(document.querySelectorAll('[data-dshm-fs-entry="1"]'));for(var i=0;i<rows.length;i++){var n=rows[i].querySelector('.dshm-file-name');if(n&&/\.mjs$/.test(String(n.textContent||''))){rows[i].querySelector('.dshm-file-head').click();return String(n.textContent)} }return null})()`)
    await sleep(1500)
    console.log('  [预览] 打开的文件：' + String(clicked))
    await shoot('preview-file')
    // 再拍一张图片预览（演示区那张是假 jpg，所以这里拍"二进制/不支持"的兜底文案更有价值 ✗）
    // → 改为回列表点「照片」目录里的 .jpg，看它到底怎么报错：这正是"不静默失败"的样子 ✓
    await evaluate(`(function(){var bar=document.querySelector('.dshm-preview-bar');var bs=bar===null?[]:[].slice.call(bar.querySelectorAll('button'));for(var i=0;i<bs.length;i++){if(/返回/.test(bs[i].textContent||'')){bs[i].click();return true}}return false})()`)
    await sleep(1300)
    await evaluate(`(function(){var bar=document.querySelector('.dshm-files-toolbar');var bs=bar===null?[]:[].slice.call(bar.querySelectorAll('button'));for(var i=0;i<bs.length;i++){if(/上层|上级|返回/.test(bs[i].textContent||'')){bs[i].click();return true}}return false})()`)
    await sleep(1300)
    await evaluate(`(function(){var rows=[].slice.call(document.querySelectorAll('[data-dshm-fs-entry="1"]'));for(var i=0;i<rows.length;i++){var n=rows[i].querySelector('.dshm-file-name');if(n&&/^照片$/.test(String(n.textContent||''))){rows[i].querySelector('.dshm-file-head').click();return true}}return false})()`)
    await sleep(1400)
    await evaluate(`(function(){var rows=[].slice.call(document.querySelectorAll('[data-dshm-fs-entry="1"]'));for(var i=0;i<rows.length;i++){var n=rows[i].querySelector('.dshm-file-name');if(n&&/\.jpg$/.test(String(n.textContent||''))){rows[i].querySelector('.dshm-file-head').click();return true}}return false})()`)
    await sleep(2000)
    await shoot('preview-image-fallback')
  }

  /**
   * 公式样例（round 87）：用户要"做一个公式的样例文件我看看"。
   *
   * ★ 这份文件是**给用户看的**，所以真身在用户自己的工作区
   *   （`工程设计/公式样例.md` ✓），这里**直接读它**、不复制一份进来 ✓ ——
   *   两处各存一份的话，改了这头忘那头，截图与手机上看到的就不是同一个文件 ✗。
   *   文件不在（比如换了机器）就跳过这一张，并说清原因 ✓（不静默 ✗）。
   */
  if (want('formulas')) {
    const samplePath = join(repoRoot, '..', '公式样例.md')
    if (!existsSync(samplePath)) {
      console.log('  [公式样例] 跳过：找不到 ' + samplePath)
    } else {
      writeFileSync(join(DEMO, '公式样例.md'), readFileSync(samplePath))
      await evaluate(`document.getElementById('dsh-mobile-files').click()`)
      await sleep(1400)
      await evaluate(`(function(){var bar=document.querySelector('.dshm-files-toolbar');var bs=bar===null?[]:[].slice.call(bar.querySelectorAll('button'));for(var i=0;i<bs.length;i++){if(/工作区/.test(bs[i].textContent||'')){bs[i].click();return true}}return false})()`)
      await sleep(1200)
      await evaluate(`(function(){var rows=[].slice.call(document.querySelectorAll('.dshm-ws'));if(rows.length>0)rows[0].click()})()`)
      await sleep(1600)
      const opened = await evaluate(`(function(){var rows=[].slice.call(document.querySelectorAll('[data-dshm-fs-entry="1"]'));for(var i=0;i<rows.length;i++){var n=rows[i].querySelector('.dshm-file-name');if(n&&/公式样例/.test(String(n.textContent||''))){rows[i].querySelector('.dshm-file-head').click();return String(n.textContent)} }return null})()`)
      await sleep(1800)
      console.log('  [公式样例] 打开的文件：' + String(opened))
      await shoot('preview-formulas')
    }
  }

  /**
   * Markdown 全屏预览（round 86，用户反馈"md 没格式"+"预览应该占满全屏"）。
   *
   * 拍的是"点开一份真文档"的那一屏：整屏宽度 + 排版后的标题/列表/代码块/表格 ✓。
   */
  if (want('preview-markdown')) {
    await evaluate(`document.getElementById('dsh-mobile-files').click()`)
    await sleep(1400)
    await evaluate(`(function(){var bar=document.querySelector('.dshm-files-toolbar');var bs=bar===null?[]:[].slice.call(bar.querySelectorAll('button'));for(var i=0;i<bs.length;i++){if(/工作区/.test(bs[i].textContent||'')){bs[i].click();return true}}return false})()`)
    await sleep(1200)
    await evaluate(`(function(){var rows=[].slice.call(document.querySelectorAll('.dshm-ws'));if(rows.length>0)rows[0].click()})()`)
    await sleep(1600)
    await evaluate(`(function(){var rows=[].slice.call(document.querySelectorAll('[data-dshm-fs-entry="1"]'));for(var i=0;i<rows.length;i++){var n=rows[i].querySelector('.dshm-file-name');if(n&&/^docs$/.test(String(n.textContent||''))){rows[i].querySelector('.dshm-file-head').click();return true}}return false})()`)
    await sleep(1500)
    const opened = await evaluate(`(function(){var rows=[].slice.call(document.querySelectorAll('[data-dshm-fs-entry="1"]'));for(var i=0;i<rows.length;i++){var n=rows[i].querySelector('.dshm-file-name');if(n&&/\.md$/.test(String(n.textContent||''))&&/项目说明/.test(String(n.textContent||''))){rows[i].querySelector('.dshm-file-head').click();return String(n.textContent)} }return null})()`)
    await sleep(1600)
    console.log('  [md 预览] 打开的文件：' + String(opened))
    await shoot('preview-markdown')
  }

  /**
   * DSH 原生设置的**整屏**版（round 83，用户第 5 点）。
   *
   * 这张是给用户看"控件怎么安放"的：顶部是我们注入的标题栏（电脑端设置 + 返回），
   * 下面是 DSH 自己的横向导航与内容 ✓。
   */
  if (want('native-settings')) {
    await evaluate(`(function(){var c=document.getElementById('dsh-mobile-sheet-close');if(c&&document.body.dataset.dshmFiles==='open')c.click()})()`)
    await sleep(700)
    await evaluate(`document.getElementById('dsh-mobile-nav').click()`)
    await sleep(1000)
    const opened = await evaluate(`(function(){
      var col=document.querySelector('[class*=sidebarCol]');
      if(col===null) return 'no-sidebar';
      var buttons=col.querySelectorAll('button');
      for(var i=0;i<buttons.length;i++){
        var text=String(buttons[i].textContent||'').trim();
        if(/^设置/.test(text)){ buttons[i].click(); return text.slice(0,10) }
      }
      return 'no-settings-button';
    })()`)
    await sleep(1800)
    console.log('  [原生设置] 点击结果：' + String(opened))
    await shoot('native-settings')
  }

  if (want('files-empty')) {
    // 空态：把工作区切到一个空目录
    const empty = join(tmpdir(), 'dshm-ui-empty')
    mkdirSync(empty, { recursive: true })
    process.env['SHOOT_EMPTY'] = empty
    console.log('  （空态需要把 storages/workspace.json 指向空目录后重启本脚本）')
  }

  console.log(`[shoot-ui] 完成：${shots.length} 张`)
} finally {
  try {
    ws.close()
  } catch {
    /* 忽略 */
  }
}
process.exit(0)
