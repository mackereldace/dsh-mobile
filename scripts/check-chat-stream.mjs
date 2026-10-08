#!/usr/bin/env node
/**
 * 会话页取数**从轮询改成流**的验收（本单 ✓）—— 真浏览器 + 假宿主 + **真实时钟** ✓。
 *
 * ## 为什么不能沿用 `check-chat-page.mjs` 那套读数 ✗
 *
 * 那一套是 `--dump-dom` + `--virtual-time-budget` ✓ —— **虚拟时间**下面
 * "静置 30 秒"里的 30 秒是**跑出来的假时间** ✗。本单的核心判据偏偏是
 * 「**静置 30 秒 `mobile/dsh/read` = 0 次**」✓ ⇒ 那种读数会被一句
 * 「虚拟时间不算」打掉 ✓（今天已经因为"判据不尖"栽过好几次 ✓）。
 * ⇒ 这里换成 **CDP + 真实等待** ✓：读数取的是页面里**真的数了多少次** ✓。
 *
 * ## 三条判据（都是**计数**与**节点增量** ✗，不是"代码看起来改了"✓）
 *
 * 1. `?phase=idle`（静置 30 秒）：
 *    · `mobile/dsh/read` 调用增量 = **0** ✓（核心判据 ✓）；
 *    · 流 open = **1**、fail = **0** ✓；
 *    · 假宿主**推 3 条新事件** ⇒ `#messages .ev` **+3** ✓（防假绿：证明流真的在推 ✓）。
 * 2. `?phase=drop`（流中途断掉）：open **≥2**（= 真的重开了 ✓）、
 *    且 DOM 是 **6** 而不是 9 ✓（= 重开那份快照被**去重**掉了 ⇒ 不重画 ✓）。
 * 3. `?phase=switch`（切会话）：`cancels` **≥1**（= 旧流真的被关掉 ✓）、
 *    open = 2、第二条流跟的是新会话 id ✓、屏上是新会话的内容、旧会话的内容**消失** ✓。
 *
 * ## 纪律
 *
 * · **只读**产品代码 ✓（夹具是假的宿主，页面/资源都是从仓库里现读的真文件 ✓）；
 * · Chrome 用**自己的临时 profile** ✓，收尾**只按自己的 profile 路径**回收 ✓
 *   （绝不按名字或端口杀 —— 会误伤用户正开着的 Chrome ✗）；
 * · 早退点全部走 `finally` ✓。
 *
 * ## 用法
 *
 * ```bash
 * node scripts/check-chat-stream.mjs            # 三趟，约 60-70 秒
 * node scripts/check-chat-stream.mjs --phase idle
 * ```
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const HERE = dirname(fileURLToPath(import.meta.url))
const ASSETS = join(HERE, '..', 'packages', 'host', 'assets', 'dsh-chat')
/** ★ 宿主线上发的就是这一份 ✓（与 `check-chat-page.mjs` 同一条理由 ✓）。 */
const REAL_BOOT = join(HERE, '..', 'packages', 'host', 'lib', 'boot.js')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 断言条数下界（**只许上调** ✓ —— 有人删断言不算"全都验过了" ✓）。 */
const EXPECTED_MIN_CHECKS = 23
let checks = 0
let failed = 0
const check = (name, ok, detail) => {
  checks += 1
  if (ok) console.log(`  ✓ ${name}`)
  else {
    failed += 1
    console.log(`  ✗ ${name}${detail === undefined ? '' : `（${detail}）`}`)
  }
}

// ────────────────────────────── 假宿主（假隧道）──────────────────────────────
/**
 * 夹具的判据全在**计数**上 ✓：`reads`（这条是核心 ✓）、`opens` / `fails` / `cancels` ✓。
 * ★ 一帧都不许自己造形状 ✗：事件都按真形状 `data.message.content[]` ✓
 *   （会话页认的就是它 ✓，见 `check-chat-page.mjs` 头注释里那条教训 ✓）。
 */
const FIXTURE = `
;(function () {
  var sessions = [
    { id: 's-1', title: '甲会话', updatedAt: 30, current: true },
    { id: 's-2', title: '乙会话', updatedAt: 20 }
  ]
  var phase = new URLSearchParams(location.search).get('phase') || 'idle'
  var reads = 0
  var opens = 0
  var fails = 0
  var cancels = 0
  var requests = []
  var ends = []
  var sent = []
  var probeErrors = []
  window.addEventListener('error', function (e) { probeErrors.push('error: ' + e.message) })
  window.addEventListener('unhandledrejection', function (e) {
    probeErrors.push('rejection: ' + ((e.reason && e.reason.message) || e.reason))
  })

  /** 一条**真形状**的用户消息事件 ✓（data.message.content[] ✓）。 */
  function userEvent(seq, text) {
    return { seq: seq, time: 1000 + seq, type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: text }], id: 'u-' + seq } }
  }
  /** 一段窗口：从 base 起、每 2 秒一条（照 id 造前缀，方便断言"屏上是谁的内容" ✓）。 */
  function windowEvents(prefix, base) {
    return [userEvent(base + 1, prefix + '-第1条'), userEvent(base + 2, prefix + '-第2条'), userEvent(base + 3, prefix + '-第3条')]
  }

  var ok = function (value) { return Promise.resolve({ type: 'server-response', rpcId: 'r1', result: { ok: true, value: value } }) }

  /**
   * ★★ 假流：形状照**真客户端**那条迭代器 ✓（{next, return} + [Symbol.asyncIterator] ✓）。
   *   · 先一帧 {type:'snapshot'} ✓（整窗 ✓）；
   *   · 之后按 phase 推增量 / 断掉 ✓；
   *   · return() = 页面发 StreamCancel ✓（**只记数、不唤醒挂着的 next()** ✗
   *     —— 与真 boot.js:6093-6125 逐字同一种行为 ✓：
   *     页面那边靠自己的"取消闩"结束等待 ✓，这里要是替它唤醒，就测不到那一闩了 ✓）。
   */
  function makeStream(request) {
    var queue = []
    var waiter = null
    var done = false
    var failure = null
    function push(value) {
      queue.push(value)
      if (waiter !== null) { var w = waiter; waiter = null; w() }
    }
    function finish() { done = true; if (waiter !== null) { var w2 = waiter; waiter = null; w2() } }
    function fail(error) { failure = error; done = true; if (waiter !== null) { var w3 = waiter; waiter = null; w3() } }

    var id = request && request.address ? request.address.sessionId : ''
    // ① 开场快照（整窗 ✓）
    if (phase === 'switch' && id === 's-2') {
      push({ type: 'snapshot', header: { id: id, version: 1, createdAt: 0, isSeeded: false }, cursor: 20, records: windowEvents('乙', 20).map(function (e) { return { type: 'event', event: e } }), hasMore: false, projections: { asOfSeq: 23, values: { sessionStats: { turns: 1, steps: 2 }, tokenUsage: { outputTokens: 3 }, contextPressure: { contextWindow: 1000, pressureTokens: 10 } } } })
    } else {
      push({ type: 'snapshot', header: { id: id, version: 1, createdAt: 0, isSeeded: false }, cursor: 3, records: windowEvents('甲', 0).map(function (e) { return { type: 'event', event: e } }), hasMore: false, projections: { asOfSeq: 3, values: { sessionStats: { turns: 1, steps: 2 }, tokenUsage: { outputTokens: 3 }, contextPressure: { contextWindow: 1000, pressureTokens: 10 } } } })
    }
    // ② 增量：**服务端一有就推** ✓（这就是本单要的东西 ✓）
    if (phase === 'idle') {
      setTimeout(function () { push({ type: 'event', event: userEvent(11, '甲-新1') }) }, 10_000)
      setTimeout(function () { push({ type: 'event', event: userEvent(12, '甲-新2') }) }, 12_000)
      setTimeout(function () { push({ type: 'event', event: userEvent(13, '甲-新3') }) }, 14_000)
    } else if (phase === 'drop') {
      // ★ 第一条流：2 秒后**断掉**（不是"正常收尾"✓ —— 那是另一条分支 ✓）
      if (opens === 1) {
        setTimeout(function () { fails += 1; fail(new Error('夹具：流断掉了')) }, 2000)
      } else {
        // ★ 第二条流：同窗快照之后推 3 条新的 ✓（快照里那 3 条必须被去重 ✓）
        setTimeout(function () { push({ type: 'event', event: userEvent(4, '甲-补1') }) }, 4000)
        setTimeout(function () { push({ type: 'event', event: userEvent(5, '甲-补2') }) }, 5000)
        setTimeout(function () { push({ type: 'event', event: userEvent(6, '甲-补3') }) }, 6000)
      }
    }
    void finish
    return {
      __fixtureStream: true,
      [Symbol.asyncIterator]: function () {
        return {
          next: function () {
            return new Promise(function (resolve, reject) {
              for (;;) {
                if (queue.length > 0) { resolve({ done: false, value: queue.shift() }); return }
                if (failure !== null) { reject(failure); return }
                if (done) { resolve({ done: true, value: undefined }); return }
                waiter = function () {
                  if (queue.length > 0) { resolve({ done: false, value: queue.shift() }); return }
                  if (failure !== null) { reject(failure); return }
                  resolve({ done: true, value: undefined })
                }
                return
              }
            })
          },
          return: function () {
            cancels += 1
            done = true
            // ★ 故意**不**唤醒 waiter ✗（照真客户端 ✓ —— 见上面那条注释 ✓）
            return Promise.resolve({ done: true, value: undefined })
          }
        }
      }
    }
  }

  var api = globalThis.__DSH_MOBILE_BOOT__ = globalThis.__DSH_MOBILE_BOOT__ || {}
  api.tunnel = {
    rpc: function (method, payload) {
      if (method === 'mobile/dsh/sessions') return ok({ ok: true, sessions: sessions })
      if (method === 'mobile/dsh/read') {
        // ★★ 核心判据：这个计数器**只该在"退回轮询"时增长** ✗
        reads += 1
        // ★ 轮询那条路也要能画出东西来 ✓（真宿主回的就是那一窗事件 ✓）——
        //   否则「改前」那一趟连"开场 3 条上屏"都等不到 ⇒ 次数还没读到就被超时打断 ✓
        return ok({ ok: true, sessionId: payload && payload.args ? payload.args.sessionId : '', events: windowEvents('甲', 0), hasMore: false })
      }
      if (method === 'mobile/dsh/approval') return ok({ ok: false, accepted: false })
      if (method === 'mobile/dsh/create') { sessions = sessions.concat([{ id: 's-new', title: '新会话', updatedAt: 99 }]); return ok({ ok: true, sessionId: 's-new' }) }
      if (method === 'mobile/dsh/send') { sent.push(payload && payload.args ? payload.args.text : ''); return ok({ ok: true, requestId: 'rq-1' }) }
      return Promise.reject(new Error('假隧道不认这个端点：' + method))
    },
    // ★ 流那条路 ✓ —— 有它，页面才会走流（见 app.js 的 streaming 判据 ✓）
    openStream: function (endpoint, payload) {
      opens += 1
      var request = payload && payload.args ? payload.args.request : null
      requests.push({ endpoint: endpoint, request: request })
      return makeStream(request)
    }
  }
  /** 一个回合把所有读数取回来 ✓（少一次往返就少一次竞态 ✓）。 */
  api.__probe = function () {
    return {
      mode: document.documentElement.getAttribute('data-dshm-fetch'),
      reads: reads,
      opens: opens,
      fails: fails,
      cancels: cancels,
      requests: requests,
      sent: sent,
      errors: probeErrors,
      dom: document.querySelectorAll('#messages .ev').length,
      text: (document.getElementById('messages') || {}).textContent || '',
      title: (document.getElementById('title') || {}).textContent || '',
      status: (document.getElementById('status') || {}).textContent || '',
      projections: typeof api.chatProjections === 'function' ? api.chatProjections() : null
    }
  }
})()
`

// ────────────────────────────── 假宿主 HTTP ──────────────────────────────
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' }

async function serve() {
  const server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0]
    const send = (body, type) => {
      res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' })
      res.end(body)
    }
    if (path === '/mobile/boot.js') {
      // ★ 真 boot.js（宿主线上发的那一份 ✓）+ 夹具那半（假隧道 ✓）
      send(readFileSync(REAL_BOOT, 'utf8') + '\n;/* ---- 夹具（假隧道 + 假流）---- */\n' + FIXTURE, MIME['.js'])
      return
    }
    if (path === '/mobile/chat' || path === '/mobile/chat/') {
      send(readFileSync(join(ASSETS, 'page.html')), MIME['.html'])
      return
    }
    const name = path.replace('/mobile/chat/', '')
    if (path.startsWith('/mobile/chat/') && !name.includes('..')) {
      try {
        send(readFileSync(join(ASSETS, name)), MIME[extname(name)] ?? 'application/octet-stream')
      } catch (error) {
        res.writeHead(404).end('not found')
      }
      return
    }
    res.writeHead(404).end('not found')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, port: server.address().port }
}

// ────────────────────────────── 手写 CDP ──────────────────────────────
/** 起一个 Chrome（自己的 profile ✓）并把 CDP 接上 ✓。 */
async function launchChrome(url) {
  const profile = mkdtempSync(join(tmpdir(), 'dshm-chat-stream-'))
  const chrome = spawn(
    CHROME,
    [
      '--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      '--remote-debugging-port=0', `--user-data-dir=${profile}`, url,
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  )
  let stderr = ''
  chrome.stderr.on('data', (chunk) => {
    stderr += chunk.toString('utf8')
  })
  const deadline = Date.now() + 20_000
  let port = 0
  while (Date.now() < deadline) {
    const found = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//.exec(stderr)
    if (found !== null) {
      port = Number(found[1])
      break
    }
    await sleep(100)
  }
  if (port === 0) throw new Error('Chrome 没报出 CDP 端口（stderr：' + stderr.slice(-400) + '）')
  // 找到页面那个 target 的 ws 地址 ✓
  const wsDeadline = Date.now() + 15_000
  let wsUrl = ''
  while (Date.now() < wsDeadline && wsUrl === '') {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      const page = list.filter((item) => item.type === 'page')[0]
      if (page !== undefined && typeof page.webSocketDebuggerUrl === 'string') wsUrl = page.webSocketDebuggerUrl
    } catch (error) {
      void error
    }
    if (wsUrl === '') await sleep(150)
  }
  if (wsUrl === '') throw new Error('找不到页面 target 的 CDP 地址')
  return { chrome, profile, port, wsUrl }
}

/** 极简 CDP：一路 WebSocket、按 id 配对 ✓（照本仓其它脚本的做法：手写，不引 Playwright ✓）。 */
function connectCdp(wsUrl) {
  const socket = new WebSocket(wsUrl)
  let nextId = 1
  const pending = new Map()
  const ready = new Promise((resolve, reject) => {
    socket.addEventListener('open', () => resolve())
    socket.addEventListener('error', (event) => reject(new Error('CDP WebSocket 出错：' + String(event && event.message))))
  })
  socket.addEventListener('message', (event) => {
    let message = null
    try {
      message = JSON.parse(String(event.data))
    } catch (error) {
      void error
    }
    if (message === null || typeof message.id !== 'number') return
    const entry = pending.get(message.id)
    if (entry === undefined) return
    pending.delete(message.id)
    if (message.error !== undefined) entry.reject(new Error(JSON.stringify(message.error)))
    else entry.resolve(message.result)
  })
  const send = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId++
      pending.set(id, { resolve, reject })
      socket.send(JSON.stringify({ id, method, params: params ?? {} }))
    })
  return { ready, send, close: () => socket.close() }
}

/** 极简软等待 ✓：超时**不抛** ⇒ 让下面那几条断言自己红，而不是把整份套件打断 ✗（变异验证时最要紧 ✓）。 */
async function waitSoft(cdp, expression, timeoutMs, label) {
  try {
    await waitFor(cdp, expression, timeoutMs, label)
    return true
  } catch (error) {
    console.log('  … 等不到：' + label + '（' + String(error && error.message).slice(0, 160) + '）')
    return false
  }
}

/** 在页面里跑一段表达式并把值拿回来 ✓（`await` 也支持 ✓）。 */
async function evaluate(cdp, expression) {
  const result = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (result.exceptionDetails !== undefined) {
    throw new Error('页面里抛了：' + JSON.stringify(result.exceptionDetails.exception ?? result.exceptionDetails))
  }
  return result.result.value
}

/** 轮询等一个条件成立 ✓（超时就把最后一次读数带出来 ✓）。 */
async function waitFor(cdp, expression, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    last = await evaluate(cdp, expression)
    if (last === true) return true
    await sleep(200)
  }
  throw new Error(`等不到：${label}（最后一次读数 ${JSON.stringify(last)}）`)
}

const probe = (cdp) => evaluate(cdp, 'window.__DSH_MOBILE_BOOT__.__probe()')

// ────────────────────────────── 三趟 ──────────────────────────────
const argv = process.argv.slice(2)
const onlyIndex = argv.indexOf('--phase')
const ONLY = onlyIndex >= 0 ? argv[onlyIndex + 1] : ''

async function runIdle(base) {
  console.log('\n── 第一趟 · 静置 30 秒（核心判据：read = 0 次）──')
  const { chrome, profile, wsUrl } = await launchChrome(`${base}/mobile/chat?phase=idle`)
  const cdp = connectCdp(wsUrl)
  try {
    await cdp.ready
    await cdp.send('Runtime.enable')
    await waitFor(cdp, 'window.__DSH_MOBILE_BOOT__ && typeof window.__DSH_MOBILE_BOOT__.__probe === "function"', 20_000, '夹具装上')
    // ★ 起来那一步的判据：快照那 3 条已经上屏 ✓（否则下面的 +3 是空转 ✓）
    await waitFor(cdp, 'window.__DSH_MOBILE_BOOT__.__probe().dom === 3', 20_000, '开场快照那 3 条画出来')
    const before = await probe(cdp)
    check('★★ 夹具自检：页面走的是**流**（`data-dshm-fetch` = stream ✓）', before.mode === 'stream', `读到 ${String(before.mode)}`)
    check('★ 夹具自检：开场快照那 3 条真的上屏了（后面的 +3 才不是空转 ✓）', before.dom === 3, `DOM .ev = ${before.dom}`)
    check('★ 流的请求形状**没有** `cursor`（`SessionFollowRequest` 里根本没有这个字段 ✗）',
      before.requests.length === 1 && before.requests[0].request !== null &&
        Object.prototype.hasOwnProperty.call(before.requests[0].request, 'cursor') === false,
      JSON.stringify(before.requests[0] && before.requests[0].request))
    check('★ 流的请求跟的是当前会话（address.kind = session ✓、sessionId = s-1 ✓）',
      before.requests.length === 1 && before.requests[0].request !== null &&
        before.requests[0].request.address.kind === 'session' && before.requests[0].request.address.sessionId === 's-1' &&
        before.requests[0].request.maxMessages === 500,
      JSON.stringify(before.requests[0] && before.requests[0].request))

    console.log('  … 静置 30 秒（真实时钟 ✓）…')
    await sleep(30_000)
    const after = await probe(cdp)
    check('★★★ 静置 30 秒内 `mobile/dsh/read` 调用 = **0 次**（改动前是每 900ms 一趟 ✗）',
      after.reads - before.reads === 0, `这 30 秒里又调了 ${after.reads - before.reads} 次（累计 ${after.reads}）`)
    check('★★ 流 open = 1、fail = 0（这 30 秒里没有重开、也没有失败 ✓）',
      after.opens === 1 && after.fails === 0, `open=${after.opens} fail=${after.fails}`)
    check('★★ 假宿主推的 3 条新事件都上了屏：DOM 消息节点 **+3** ✓',
      after.dom - before.dom === 3, `DOM ${before.dom} → ${after.dom}（期望 +3）`)
    check('★ 推来的内容**逐字**在屏上（不是"节点多了但内容是别的"✗）',
      after.text.includes('甲-新1') && after.text.includes('甲-新2') && after.text.includes('甲-新3'), `读到 ${JSON.stringify(after.text.slice(-60))}`)
    check('★ 开场快照自带的 `projections` 接进来了（状态条那三个数的真数据源 ✓）',
      after.projections !== null && after.projections !== undefined && after.projections.asOfSeq === 3 &&
        after.projections.values !== null && after.projections.values !== undefined &&
        after.projections.values.sessionStats !== undefined && after.projections.values.tokenUsage !== undefined &&
        after.projections.values.contextPressure !== undefined,
      JSON.stringify(after.projections))
    check('★ 页面里没有未处理的 JS 错误（夹具把这些也记下来了 ✓）',
      after.errors.length === 0, after.errors.join(' / '))
  } finally {
    cdp.close()
    chrome.kill('SIGKILL')
    try {
      const { execFileSync } = await import('node:child_process')
      execFileSync('pkill', ['-f', `--user-data-dir=${profile}`], { stdio: 'ignore' })
    } catch (error) {
      void error
    }
    rmSync(profile, { recursive: true, force: true })
  }
}

async function runDrop(base) {
  console.log('\n── 第二趟 · 流中途断掉（判据：真的重开，而且不重画）──')
  const { chrome, profile, wsUrl } = await launchChrome(`${base}/mobile/chat?phase=drop`)
  const cdp = connectCdp(wsUrl)
  try {
    await cdp.ready
    await cdp.send('Runtime.enable')
    await waitFor(cdp, 'window.__DSH_MOBILE_BOOT__ && typeof window.__DSH_MOBILE_BOOT__.__probe === "function"', 20_000, '夹具装上')
    await waitFor(cdp, 'window.__DSH_MOBILE_BOOT__.__probe().dom === 3', 20_000, '第一条流的快照上屏')
    // ★ 等重开：夹具在 2 秒时把第一条流断掉 ✓，页面按 500ms 阶梯重开 ✓
    await waitSoft(cdp, 'window.__DSH_MOBILE_BOOT__.__probe().opens >= 2', 20_000, '断掉之后重开（open ≥ 2）')
    // ★ 等第二条流推的 3 条新的上屏 ✓
    await waitSoft(cdp, 'window.__DSH_MOBILE_BOOT__.__probe().dom === 6', 20_000, '重开之后推的 3 条上屏')
    await sleep(1500) // 再静置一下，看有没有多余的重画/重开 ✓
    const after = await probe(cdp)
    check('★★ 流断掉之后**真的重开了同一条流**（open ≥ 2 ✓ —— 删掉重开这段必红 ✗）',
      after.opens >= 2 && after.fails >= 1, `open=${after.opens} fail=${after.fails}`)
    check('★★ 重开那份**整窗快照被去重掉了**：DOM 恰好 = 6（不是 9 ✗）',
      after.dom === 6, `DOM = ${after.dom}（3 旧 + 3 新 = 6 ✓；重画一次就是 9 ✗）`)
    check('★ 断线期间漏掉的那 3 条**只补了一次**（逐字在屏上 ✓）',
      after.text.includes('甲-补1') && after.text.includes('甲-补2') && after.text.includes('甲-补3'), `读到 ${JSON.stringify(after.text.slice(-60))}`)
    check('★★ 全程 `mobile/dsh/read` 仍然是 **0 次**（断线重开也不许退回轮询 ✗）',
      after.reads === 0, `读完累计 ${after.reads} 次`)
    check('★ 断线**没有清屏**（出错只进状态行 ✓ —— 这是既有纪律 ✓）',
      // ★ 这一条**只问**"已经画出来的还在不在" ✗ —— 不许把"重开了没有"混进来 ✓
      //   （混进来它就是一条**假判据**：重开失败时它以"清屏了"的名义红，而屏幕其实没被清 ✓）
      after.dom >= 3 && after.text.includes('甲-第1条'), `DOM=${after.dom}｜旧内容在不在=${after.text.includes('甲-第1条')}`)
    check('★ 页面里没有未处理的 JS 错误', after.errors.length === 0, after.errors.join(' / '))
  } finally {
    cdp.close()
    chrome.kill('SIGKILL')
    try {
      const { execFileSync } = await import('node:child_process')
      execFileSync('pkill', ['-f', `--user-data-dir=${profile}`], { stdio: 'ignore' })
    } catch (error) {
      void error
    }
    rmSync(profile, { recursive: true, force: true })
  }
}

async function runSwitch(base) {
  console.log('\n── 第三趟 · 切会话（判据：旧流被关掉 + 屏上换成新会话）──')
  const { chrome, profile, wsUrl } = await launchChrome(`${base}/mobile/chat?phase=switch`)
  const cdp = connectCdp(wsUrl)
  try {
    await cdp.ready
    await cdp.send('Runtime.enable')
    await waitFor(cdp, 'window.__DSH_MOBILE_BOOT__ && typeof window.__DSH_MOBILE_BOOT__.__probe === "function"', 20_000, '夹具装上')
    await waitFor(cdp, 'window.__DSH_MOBILE_BOOT__.__probe().dom === 3', 20_000, '第一条流的快照上屏')
    check('★ 夹具自检：第一条流跟的是甲会话（s-1 ✓）',
      (await probe(cdp)).requests[0]?.request?.address?.sessionId === 's-1')
    // ★ 走**真实点击路径**切会话 ✓（点标题开面板 ⇒ 点「乙会话」那一行 ✓）
    const clicked = await evaluate(cdp, `(function () {
      var title = document.getElementById('title')
      if (title === null) return 'no-title'
      title.click()
      var rows = [].slice.call(document.querySelectorAll('.session-row'))
      var target = rows.filter(function (row) { return row.textContent.indexOf('乙会话') >= 0 })[0]
      if (target === undefined) return 'no-row:' + rows.map(function (r) { return r.textContent }).join('|')
      target.click()
      return 'clicked'
    })()`)
    check('★ 夹具自检：切会话走的是真实点击路径（点开了面板并点到那一行 ✓）', clicked === 'clicked', String(clicked))
    await waitSoft(cdp, 'window.__DSH_MOBILE_BOOT__.__probe().opens >= 2', 20_000, '切过去之后开了第二条流')
    await waitSoft(cdp, 'window.__DSH_MOBILE_BOOT__.__probe().text.indexOf("乙-第1条") >= 0', 20_000, '新会话的内容上屏')
    await sleep(800)
    const after = await probe(cdp)
    check('★★ 切会话时**旧流真的被关掉了**（`StreamCancel` ≥ 1 ✓ —— 不关就是在电脑那头白挂一条流 ✗）',
      after.cancels >= 1, `cancels = ${after.cancels}`)
    check('★ 第二条流跟的是**新会话**（s-2 ✓）', after.requests.length >= 2 && after.requests[1]?.request?.address?.sessionId === 's-2', JSON.stringify(after.requests.map((r) => r.request && r.request.address)))
    check('★★ 屏上是新会话的内容、**旧会话的内容消失**（切会话不许混着显示 ✗）',
      after.text.includes('乙-第1条') && after.text.includes('乙-第3条') && !after.text.includes('甲-第1条'), `读到 ${JSON.stringify(after.text.slice(0, 80))}`)
    check('★ 全程 `mobile/dsh/read` = **0 次**（切会话也不许退回轮询 ✗）', after.reads === 0, `读完累计 ${after.reads} 次`)
    check('★ 页面里没有未处理的 JS 错误', after.errors.length === 0, after.errors.join(' / '))
  } finally {
    cdp.close()
    chrome.kill('SIGKILL')
    try {
      const { execFileSync } = await import('node:child_process')
      execFileSync('pkill', ['-f', `--user-data-dir=${profile}`], { stdio: 'ignore' })
    } catch (error) {
      void error
    }
    rmSync(profile, { recursive: true, force: true })
  }
}

// ────────────────────────────── 主流程 ──────────────────────────────
const setup = await serve()
const base = `http://127.0.0.1:${setup.port}`
console.log(`[check-chat-stream] 假宿主 ${base} ✓（真页面 + 真资源 + 真 boot.js + 假隧道/假流）`)
try {
  if (ONLY === '' || ONLY === 'idle') await runIdle(base)
  if (ONLY === '' || ONLY === 'drop') await runDrop(base)
  if (ONLY === '' || ONLY === 'switch') await runSwitch(base)
} finally {
  setup.server.close()
}

console.log('\n── check-chat-stream ──────────────────────────')
console.log(`通过 ${checks - failed} 项，失败 ${failed} 项（共 ${checks} 项）`)
// ★ 下界只在**三趟全跑**时执法 ✗（`--phase idle` 这种单跑必然少于下界 ✓）
if (ONLY === '' && checks < EXPECTED_MIN_CHECKS) {
  console.log(`✗ 断言条数 ${checks} **少于**下界 ${EXPECTED_MIN_CHECKS} —— 有人删了断言，这不是「全都验过了」`)
  failed += 1
}
console.log('───────────────────────────────────────────────')
if (failed > 0) process.exit(1)
