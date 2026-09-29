#!/usr/bin/env node
/**
 * 真机实验：**退到后台之后，页面里的 JS 还跑不跑？原生注入的 JS 还执行不执行？**
 *
 * ## 这是整个「壳侧保活」方案的分水岭（不是可选验证 ✗）
 *
 * 方案 B′ 的全部便宜之处都建立在一条假设上 ✓：
 *   · 前台服务提供"**活着的进程**"✓；
 *   · `moveTaskToBack` 提供"**活着的 WebView**"✓；
 *   · 原生 `Handler` 提供"**活着的时钟**"✓，用 `evaluateJavascript` 去戳网页已有的心跳/轮询 ✓。
 * ⇒ 如果"注入的 JS 在后台照样执行"✓，那么**加密、协议、证书、身份一行都不用重写** ✓；
 *   如果不执行 ✗，B′ 作废，只能上"原生自己实现一遍隧道"（1.5–2 周 + 永久双份维护 ✗）。
 * ⇒ 所以 `25-壳侧保活与通知-勘察与方案.md` §4.5 把它列为**开工第一件事** ✓。
 *
 * ## 为什么不去真机跑"独立探针 APK"，而是量**正在跑的那个页面** ✓
 *
 * 独立探针要另打一个包、另装一次 ✓，而它量到的只是"探针那个隐藏 WebView"的行为 ✓ ——
 * 真机上真正要紧的是**我们这个壳 + 这个页面**的组合 ✓。所以这里直接挂到**已经开着的那一页**上 ✓：
 *
 *   1. 往页面里装两条计数器 ✓：
 *      · `pgTimer` —— 页面**自己的** `setInterval(1000)` 累加 ✓（量"页面 JS 还跑不跑"✓）；
 *      · `nativeTicks` —— 把 `__DSH_MOBILE_BOOT__.tick` **替换成一个记账函数** ✓
 *        （量"原生 `evaluateJavascript` 还执行不执行"✓ —— 原生注入的正是 `b.tick('ping'|'poll')` ✓）。
 *      ★ 这一步**不部署任何东西** ✗、**不改手机上的 boot.js** ✗ ——
 *        它只在这一个页面的内存里挂两条计数器 ✓，刷新即消失 ✓。
 *        （生产上的 `boot.js` 还没有 `tick` ✓，所以原生那一发原本会静默返回 `'no'` ✓ ——
 *         我们把它换成一个会记账的函数，就能把"有没有执行"变成**可读的数** ✓。）
 *   2. 读一次基线 ✓ → 用 `adb shell input keyevent KEYCODE_HOME` **按 Home 退到后台** ✓
 *      → 每隔一段时间再读一次 ✓，把读到的数连成一条曲线 ✓。
 *
 * ★ 读数的判读（三种都可能是结论 ✓，别只看"涨没涨"✗）：
 *   · `nativeTicks` 在后台**继续涨** ⇒ B′ 成立 ✓，照方案做 ✓；
 *   · `nativeTicks` 停了、而 `pgTimer` 还在涨 ⇒ 原生注入被挡（少见，但要求"只靠页面定时器"✗）；
 *   · **两条都停** ⇒ WebView 被冻结 ✓ ⇒ B′ 的"原生时钟驱动网页"这条路**不成立** ✗
 *     ⇒ 只能上 C（原生自己维持隧道）✓，并如实加工期 ✓。
 *   · 还有一种最容易被误读的情形 ✗：**连 CDP 都读不动了** ✓（evaluate 超时 ✓）——
 *     那说明**渲染进程整个被冻住**✓，比"定时器被降频"严重得多 ✓，要分开记 ✓。
 *
 * ## 用法（每一步都可单独跑 ✓）
 *
 * ```bash
 * # ① 找到手机上 WebView 的调试口并转发（<pid> 用 adb shell ps -A | grep dshm 拿）
 * adb forward tcp:19222 localabstract:webview_devtools_remote_<pid>
 * # ② 让 App 在前台，然后量
 * node scripts/check-keepalive-device.mjs --after-background 150
 * # ③ 只想看当前状态、不按 Home
 * node scripts/check-keepalive-device.mjs --no-background --seconds 1
 * ```
 *
 * ★ 纪律：**只读 + 只在这个页面内存里挂计数器** ✗ —— 不写任何 profile、不装任何东西、
 *   不重启任何服务、不碰 `~/.dsh` ✓。跑完把 `adb forward --remove` 掉即可 ✓。
 */

import { execFileSync } from 'node:child_process'

const argv = process.argv.slice(2)
const flag = (name, fallback) => {
  const bare = name.replace(/^--?/, '')
  const index = argv.findIndex((arg) => arg === name || arg === bare)
  return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : fallback
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const FORWARD = Number(flag('--forward', '19222'))
const SAMPLE_EVERY_S = Number(flag('--sample-every', '10'))
const BACKGROUND_AFTER_S = Number(flag('--background-after', '5'))
const AFTER_BACKGROUND_S = Number(flag('--after-background', '120'))
const NO_BACKGROUND = argv.includes('--no-background')
const READ_TIMEOUT_MS = Number(flag('--read-timeout', '5000'))
/**
 * 只读一条表达式就退出 ✓（例如读页面自己的保活读数 ✓）。
 *
 * ★ 为什么值得单开一个开关 ✗：真机排障时最常用的动作就是"**就念一下这一行**"✓ ——
 *   而挂上调试口、连 CDP、跑一条 evaluate 这套动作手抄一次要错一次 ✓。
 *   例：`--eval "__DSH_MOBILE_BOOT__.apk.keepAlive()"` ✓。
 * ★ 它**不装任何东西** ✓、不改页面 ✓，纯只读 ✓。
 */
const EVAL = flag('--eval', '')

/** 装计数器 ✓（**幂等** ✓ —— 重复跑不会把基线清零 ✓，但会保留上一次的数 ✓，所以基线要现读 ✓）。 */
const INSTALL = `
(() => {
  const w = window
  if (!w.__dshmKaProbe) {
    w.__dshmKaProbe = { pgTimer: 0, nativeTicks: 0, ping: 0, poll: 0, lastKind: null, lastAt: 0, installedAt: Date.now() }
    setInterval(() => { w.__dshmKaProbe.pgTimer += 1 }, 1000)
  }
  // ★ 把原生那一发的落点换成记账函数 ✓（原生注入的表达式就是 b.tick('ping'|'poll') ✓）
  const boot = (w.__DSH_MOBILE_BOOT__ = w.__DSH_MOBILE_BOOT__ || {})
  boot.tick = function (kind) {
    const p = w.__dshmKaProbe
    const k = kind === 'poll' ? 'poll' : 'ping'
    p.nativeTicks += 1
    p[k] += 1
    p.lastKind = k
    p.lastAt = Date.now()
    return 'probe:' + k
  }
  return 'installed'
})()
`

const READ = `
(() => {
  const p = window.__dshmKaProbe
  if (!p) return null
  return { pgTimer: p.pgTimer, nativeTicks: p.nativeTicks, ping: p.ping, poll: p.poll, lastKind: p.lastKind, lastAt: p.lastAt, msSinceLast: p.lastAt ? Date.now() - p.lastAt : null }
})()
`

async function connect() {
  const list = await (await fetch(`http://127.0.0.1:${FORWARD}/json/list`)).json()
  const page = list.find((t) => t.type === 'page')
  if (page === undefined) throw new Error('调试口里没有 page target（App 是不是没在前台/没在跑？）')
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    ws.onopen = res
    ws.onerror = rej
  })
  let id = 0
  const pending = new Map()
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data)
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message)
      pending.delete(message.id)
    }
  }
  /** ★ 每次 evaluate 都带**自己的超时** ✓ —— 页面被冻住时它会挂住 ✓，那正是我们要记的信号 ✓。 */
  const evaluate = (expression) =>
    new Promise((resolve) => {
      const messageId = ++id
      const timer = setTimeout(() => {
        pending.delete(messageId)
        resolve({ ok: false, reason: `evaluate 超时（${READ_TIMEOUT_MS}ms）—— 渲染进程可能被冻住 ✗` })
      }, READ_TIMEOUT_MS)
      pending.set(messageId, (message) => {
        clearTimeout(timer)
        if (message.error) resolve({ ok: false, reason: JSON.stringify(message.error) })
        else if (message.result?.exceptionDetails) resolve({ ok: false, reason: '页面里抛了异常' })
        else resolve({ ok: true, value: message.result?.result?.value })
      })
      ws.send(JSON.stringify({ id: messageId, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }))
    })
  return { ws, evaluate, url: page.url }
}

const fmt = (n) => String(n).padStart(6)

async function main() {
  const { ws, evaluate, url } = await connect()
  console.log(`已挂上：${url}`)

  if (EVAL !== '') {
    const result = await evaluate(EVAL)
    console.log(result.ok ? `→ ${JSON.stringify(result.value)}` : `读不到 ✗ —— ${result.reason}`)
    ws.close()
    return
  }

  const installed = await evaluate(INSTALL)
  if (!installed.ok) throw new Error(`装计数器失败：${installed.reason}`)
  console.log(`计数器就位 ✓（${installed.value}）`)

  const samples = []
  const take = async (label) => {
    const result = await evaluate(READ)
    const row = { label, at: new Date().toISOString().slice(11, 19), ok: result.ok, ...(result.ok ? result.value : { reason: result.reason }) }
    samples.push(row)
    if (row.ok) {
      console.log(
        `  ${row.at}  ${label.padEnd(22)} 页面定时器 ${fmt(row.pgTimer)}  原生注入 ${fmt(row.nativeTicks)}` +
          `（ping ${row.ping} / poll ${row.poll}）  距上次注入 ${row.msSinceLast === null ? '—' : row.msSinceLast + 'ms'}`,
      )
    } else {
      console.log(`  ${row.at}  ${label.padEnd(22)} **读不到** ✗ —— ${row.reason}`)
    }
    return row
  }

  const before = await take('基线（前台）')
  void before

  if (NO_BACKGROUND) {
    console.log('\n（--no-background：不按 Home，只再读一次 ✓）')
    await sleep(SAMPLE_EVERY_S * 1000)
    await take('前台 +10s')
  } else {
    console.log(`\n等 ${BACKGROUND_AFTER_S}s 后按 Home（这期间 App 一直在前台）…`)
    for (let t = SAMPLE_EVERY_S; t <= BACKGROUND_AFTER_S; t += SAMPLE_EVERY_S) {
      await sleep(SAMPLE_EVERY_S * 1000)
      await take(`前台 +${t}s`)
    }
    console.log('\n★ 按 Home 退到后台（KEYCODE_HOME）—— 从这里开始，读数才是本实验要的那一段 ✓')
    execFileSync('adb', ['shell', 'input', 'keyevent', 'KEYCODE_HOME'])
    const started = Date.now()
    for (let t = 0; t < 5; t++) {
      await sleep(SAMPLE_EVERY_S * 1000)
      await take(`后台 +${Math.round((Date.now() - started) / 1000)}s`)
    }
  }

  /* ── 判读 ── */
  const good = samples.filter((s) => s.ok)
  const last = good[good.length - 1]
  const first = good[0]
  console.log('\n===== 判读 =====')
  if (good.length < 2 || last === undefined || first === undefined) {
    console.log('样本太少，判不了 ✗ —— 至少要有两次读得动的读数 ✓')
    ws.close()
    return
  }
  const dP = last.pgTimer - first.pgTimer
  const dN = last.nativeTicks - first.nativeTicks
  const unreadable = samples.filter((s) => !s.ok).length
  console.log(`样本 ${samples.length} 次，其中读不到 ${unreadable} 次`)
  console.log(`页面自己的定时器：${first.pgTimer} → ${last.pgTimer}（Δ ${dP}）`)
  console.log(`原生注入的 tick  ：${first.nativeTicks} → ${last.nativeTicks}（Δ ${dN}）`)

  const backgrounded = !NO_BACKGROUND
  const anyReadableInBackground = samples.slice(-5).some((s) => s.ok)
  console.log('')
  if (!backgrounded) {
    console.log('（--no-background：这次只量了前台 ✓，别据此判 B′ ✗）')
  } else if (!anyReadableInBackground) {
    console.log('✗ **后台里连 CDP 都读不动** —— 渲染进程整个被冻住了 ✓ ⇒ B′ 的"原生时钟驱动网页"不成立 ✗')
    console.log('  ⇒ 只能上 C（原生自己维持隧道）✓，并如实加工期 ✓（见 25 号 §4.3/§4.4）')
  } else if (dN > 0) {
    console.log('✓✓ **原生注入的 JS 在后台照样执行** ⇒ B′ 成立 ✓ —— 照 25 号 §4.2 开工 ✓')
    console.log(`  （后台那段里原生共戳了 ${dN} 次 ✓；页面自己的定时器同期 Δ ${dP} ✓ —— 两者都涨说明"活着的时钟"这条路通 ✓）`)
  } else if (dP > 0) {
    console.log('✗ 原生注入没执行，但页面自己的定时器还在跑 ⇒ 只能靠页面定时器 ✓（原生时钟这条要另找办法 ✗）')
  } else {
    console.log('✗ 两条都停了 —— 页面 JS 与原生注入在后台都不执行 ✗ ⇒ B′ 不成立 ⇒ 上 C ✓')
  }
  ws.close()
}

await main()
