#!/usr/bin/env node
/**
 * 会话页（**产品页面**）的端到端检查 —— 用假隧道 + 真浏览器，对 DOM 断言 ✓。
 *
 * ## 为什么要有它
 *
 * 这几轮反复被同一类事故咬到：**接线漏一行，页面照常打开、什么都不报** ✗ ——
 * 少 `<script src="/mobile/boot.js">`（永远连不上）、`mountChat` 偷偷往别人的 options 上装处理器
 * （事件一条不渲染）、`scrollTop` 设在不是滚动容器的元素上（新消息永远在屏幕外）✓。
 * 这些**在电脑上也能现形** ✓：只要把一个"假隧道"塞给真页面，再看它画出来的 DOM ✓。
 *
 * ## 它验的是什么（以及不验什么）
 *
 * 验：`page.html` + `theme.css` + `app.js` + `ui.js` + `poller.js` **合起来**能不能
 *     把假宿主给的会话、消息、审批、认不出的事件画出来 ✓；能不能发出一条 ✓；
 *     隧道**缺席**时会不会落到错误态 ✓（反向断言 —— 证明这个夹具真的能发现"没接上" ✓）。
 * 不验：真 DSH 网关的语义（那要真机 ✓）、观感（归用户 ✓）。
 *
 * ## 用法
 *
 * ```
 * node scripts/check-chat-page.mjs            # 跑一遍，打印读数
 * node scripts/check-chat-page.mjs --keep     # 保留临时目录便于查看
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
/**
 * ★★ 夹具：一条**真实**的 `assistant/message` 事件（从 `~/.dsh/sessions/**` 原样取出的 ✓）。
 *
 * 为什么不再自造 ✗：这个页面曾经把**真消息整段画成 JSON** ✓，而当时的夹具是
 * 自己编的 `data:{text}` ✓ —— **夹具与真实形状不符** ⇒ 断言全绿、线上照错 ✓
 * （与今天那 9 条"静默跳过"、6 处"假判据"同一族 ✓）。
 *
 * ★ 页面侧**拿不到**这块数据 ✗（不挂在 `/mobile/chat/` 下 ✓）——
 *   它由假宿主的 `/fixture/real-assistant-message-event.json` 端点交给 `boot.js` ✓
 *   （模拟真宿主"从磁盘读会话日志再发下来"那一步 ✓）。
 */
const FIXTURE_DIR = join(HERE, '..', 'packages', 'host', 'test', 'dsh-chat', 'fixtures')
const FIXTURE_EVENT = JSON.parse(readFileSync(join(FIXTURE_DIR, 'real-assistant-message-event.json'), 'utf8'))
const KEEP = process.argv.includes('--keep')

/** 夹具读数（**由真事件机械推出** ✓ —— 不是手抄的期望值 ✗）。 */
const PART_TEXT = (part) => (part !== null && typeof part === 'object' && typeof part.text === 'string' ? part.text : '')
/** ★ 只认真形状 ✓：`data.message.content[]` —— 认不出就给空数组（由"夹具形状自检"报红 ✓，不崩 ✗）。 */
const PART_LIST = (event) =>
  event !== null && typeof event === 'object' && event.data !== null && typeof event.data === 'object' &&
  event.data.message !== null && typeof event.data.message === 'object' && Array.isArray(event.data.message.content)
    ? event.data.message.content
    : []
const REAL_PARTS_ALL = PART_LIST(FIXTURE_EVENT)
const REAL_PARTS = REAL_PARTS_ALL.filter((part) => part !== null && typeof part === 'object' && part.type === 'text')
const REAL_PROSE = REAL_PARTS.map(PART_TEXT).join('\n')
const REAL_REASONING = REAL_PARTS_ALL
  .filter((part) => part !== null && typeof part === 'object' && part.type === 'reasoning')
  .map(PART_TEXT)
  .join('\n')
/** 把一串字折成"HTML 里安全的片段" ✓（页面把文字转义过 ⇒ 直接 includes 会假失败 ✗）。 */
const escapeHtml = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
/**
 * ★ 思维链里**开头**那一小段 ✓ —— 用来证明"它进了折叠的思考块、但**没进**正文气泡" ✓。
 * 取前 24 字（真思维链 ≥100 字 ✓）⇒ 它是 `data-text-head`（前 64 字）的**前缀** ✓。
 */
const REAL_REASONING_HEAD = REAL_REASONING.slice(0, 24)

/** ★ 断言条数下界（**只许上调** ✓ —— 有人删断言不算"全都验过了" ✓）。 */
const EXPECTED_MIN_CHECKS = 30

let checks = 0
let failed = 0
const check = (name, ok, detail) => {
  checks += 1
  if (ok) {
    console.log(`  ✓ ${name}`)
  } else {
    failed += 1
    console.log(`  ✗ ${name}${detail === undefined ? '' : `（${detail}）`}`)
  }
}

// ────────────────────────── 假宿主 ──────────────────────────

/** 假隧道：按脚本回答 `mobile/dsh/*`，与真宿主同形状（`{result:{ok,value}}` ✓）。 */
const FAKE_BOOT = `
;(function () {
  var sessions = [
    { id: 's-1', title: '换图标那两个标签', updatedAt: 30, current: true },
    { id: 's-2', title: '原生首页的卡片间距', updatedAt: 90, running: true },
  ]
  /*
   * ★★ 事件**全部按真形状造** ✓（这是本单一半的价值 ✓）：
   *   · user/message   ⇒ data.message.content[{type:'text',text}] ✓（真日志逐条核过 ✓）
   *   · assistant/message ⇒ 从 ~/.dsh/sessions 取出的**真事件**（由假宿主的 /fixture/ 端点发下来 ✓）
   *   · approval/asked ⇒ data.{id,toolName,callId,reason} ✓（真日志里 **55/55 条都是这一个形状** ✓，
   *                       而且**没有 options 字段** ✗ —— 所以页面上不该出现任何审批按钮 ✓）
   *   · someUnknownEvent ⇒ 保留（它验的是"认不出也要看得见" ✓）
   */
  var events = [
    { seq: 1, time: 1, type: 'turn/start', data: { turn: 1 } },
    { seq: 2, time: 2, type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: '把首页那两颗图标的圆角再收一点' }], source: { kind: 'user' }, id: 'u-1' } },
    { seq: 3, time: 3, type: 'approval/asked', data: { id: 'ap-1', toolName: 'bash', callId: 'call_1', reason: 'escalate sandbox to danger-full-access: npm test' } },
    { seq: 5, time: 5, type: 'someUnknownEvent', data: { whatever: 1 } }
  ]
  var realAssistant = null
  var pending = []
  var settled = false
  function flush() {
    settled = true
    var queue = pending
    pending = []
    for (var i = 0; i < queue.length; i++) queue[i]()
  }
  function whenReady(deliver) {
    if (settled) deliver()
    else pending.push(deliver)
  }
  // ★ 真事件**同步**拉（经典脚本先跑、module 是 defer ✓）⇒ 第一次读之前一定已经就位 ✓
  try {
    var xhr = new XMLHttpRequest()
    xhr.open('GET', '/fixture/real-assistant-message-event.json', false)
    xhr.send(null)
    realAssistant = JSON.parse(xhr.responseText)
    events = events.concat([realAssistant])
    flush()
    document.documentElement.setAttribute('data-e2e-fixture', String(Array.isArray(realAssistant.data.message.content) ? realAssistant.data.message.content.length : -1))
  } catch (error) {
    document.documentElement.setAttribute('data-e2e-fixture-error', String((error && error.message) || error))
  }
  var sent = []
  var calls = []
  function ok(value) { return Promise.resolve({ type: 'server-response', rpcId: 'r1', result: { ok: true, value: value } }) }
  function bad(message) { return Promise.resolve({ type: 'server-response', rpcId: 'r1', result: { ok: false, error: { message: message } } }) }
  /*
   * ★ 夹具按 phase 造两种"半路出事"（都不是"一开始就连不上"✗ —— 那一种已经有反向断言了 ✓）：
   *   phase=send-fail ⇒ 发送失败（要验："字必须还在输入框里" ✓）
   *   phase=read-fail ⇒ 先成功渲染一轮、之后读取开始失败（要验："已画出来的内容不许被清掉" ✓）
   */
  var phase = new URLSearchParams(location.search).get('phase') || 'sent'
  var reads = 0
  globalThis.__DSH_MOBILE_BOOT__ = {
    tunnel: {
      rpc: function (method, payload) {
        calls.push(method)
        if (method === 'mobile/dsh/sessions') return ok({ ok: true, sessions: sessions })
        if (method === 'mobile/dsh/read') {
          return new Promise(function (resolve, reject) {
            whenReady(function () {
              reads += 1
              if (phase === 'read-fail' && reads > 1) { document.documentElement.setAttribute('data-e2e-badreads', String(reads - 1)); resolve(bad('隧道断了：socket closed')) ; return }
              var want = payload && payload.args ? payload.args.sessionId : ''
              if (want === 's-new') { resolve(ok({ ok: true, sessionId: 's-new', events: [], hasMore: false })); return }
              resolve(ok({ ok: true, sessionId: 's-1', events: events, hasMore: false }))
            })
          })
        }
        if (method === 'mobile/dsh/create') {
          sessions = sessions.concat([{ id: 's-new', title: '新会话', updatedAt: 999 }])
          return ok({ ok: true, sessionId: 's-new' })
        }
        if (method === 'mobile/dsh/send') {
          var text = payload && payload.args ? payload.args.text : ''
          if (phase === 'send-fail') { sent.push(text); return bad('隧道断了：socket closed') }
          sent.push(text)
          // ★ 真宿主下一次读取就会带上这条 ⇒ 夹具也必须这样 ✓
          //   （否则"发出去的字出现在页面上"这条断言会在一个**不真**的夹具上失败 ✓）
          events = events.concat([{ seq: 100 + events.length, time: 100 + events.length, type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: text }] } }])
          return ok({ ok: true, requestId: 'rq-1' })
        }
        return Promise.reject(new Error('假隧道不认这个端点：' + method))
      }
    },
    // 夹具自检用：真页面跑完应当已经问过这两个端点 ✓
    __fakeCalls: function () { return calls.slice() },
    __fakeSent: function () { return sent.slice() }
  }
  // ★ 把页面里的 JS 错误**画在 DOM 上** ✓ —— 夹具失败时能自证原因 ✓（这条学自开发壳 ✓）
  var errs = []
  globalThis.addEventListener('error', function (e) { errs.push('error: ' + e.message) })
  globalThis.addEventListener('unhandledrejection', function (e) {
    errs.push('rejection: ' + ((e.reason && e.reason.message) || e.reason))
  })
  setInterval(function () {
    if (errs.length === 0) return
    var box = document.getElementById('fixture-errors')
    if (box === null) {
      box = document.createElement('div')
      box.id = 'fixture-errors'
      document.body.appendChild(box)
    }
    box.textContent = '［夹具］' + errs.join(' / ')
  }, 200)

  // ★ 测试驱动：等页面画完，往输入框里写字并**触发真实的提交路径** ✓
  globalThis.addEventListener('load', function () {
    setTimeout(function () {
      var box = document.getElementById('input')
      var form = document.getElementById('composer')
      if (box === null || form === null) return
      box.value = '这条是端到端检查发出去的'
      box.dispatchEvent(new Event('input'))
      form.dispatchEvent(new Event('submit', { cancelable: true }))
      /*
       * ★ --dump-dom 只给一帧（虚拟时钟跑完那一帧）✗ ⇒ 想看两个阶段就得跑两趟 ✓：
       *   ?phase=sent   ⇒ 只看"发出去之后"（那时旧会话的内容还在 ✓）
       *   ?phase=create ⇒ 再点一次「＋ 新会话」（看"切到空会话之后"✓）
       * ★ 注意：这段是**模板字符串**里的内容 ✗ —— 里面不许出现反引号，
       *   我第一次就在这儿写了反引号，把 FAKE_BOOT 整段截断了 ✓（与 codex 页那条教训同款 ✓）。
       */
      var phase2 = new URLSearchParams(location.search).get('phase') || 'sent'
      if (phase2 === 'send-fail' || phase2 === 'read-fail') {
        /*
         * ★ 两个取证上的坑（都是这轮踩出来的 ✓）：
         *   ① --dump-dom **看不到 textarea 的 value** ✗（JS 设的 value 是属性、不是内容 ✓）
         *      ⇒ 把"输入框里现在有什么"主动写到 DOM 上 ✓（编码一下，免得引号/换行毁掉 dump ✓）；
         *   ② 读失败那条要**等失败真的发生** ✓（第一趟成功、第二趟才坏 ⇒ 大约在 1.2s ✓），
         *      900ms 取帧太早 ⇒ 断言会假失败 ✗。
         */
        setTimeout(function () {
          var box = document.getElementById('input')
          document.documentElement.setAttribute('data-e2e-draft', encodeURIComponent(box === null ? '' : box.value))
          document.documentElement.setAttribute('data-e2e', 'settled')
        }, phase2 === 'read-fail' ? 1700 : 1000)
        return
      }
      if (phase2 !== 'create') {
        setTimeout(function () { document.documentElement.setAttribute('data-e2e', 'sent') }, 300)
        return
      }
      // 会话列表可能还没到 ⇒ 等一拍再点开标题 ⇒ 再点「＋ 新会话」✓
      setTimeout(function () {
        var title = document.getElementById('title')
        if (title !== null) title.dispatchEvent(new Event('click'))
        setTimeout(function () {
          var create = document.querySelector('.session-create')
          if (create !== null) create.dispatchEvent(new Event('click'))
          setTimeout(function () { document.documentElement.setAttribute('data-e2e', 'done') }, 600)
        }, 250)
      }, 400)
    }, 300)
  })
})()
`

/** 缺席版：**不装隧道** ⇒ 页面应当落到错误态 ✓（反向断言 ✓）。 */
const NO_TUNNEL_BOOT = `
globalThis.__DSH_MOBILE_BOOT__ = {};
// 夹具：把错误画在状态行上，好让失败自证 ✓
var errs2 = [];
globalThis.addEventListener('error', function (e) { errs2.push('error: ' + e.message) });
globalThis.addEventListener('unhandledrejection', function (e) { errs2.push('rejection: ' + ((e.reason && e.reason.message) || e.reason)) });
setInterval(function () {
  if (errs2.length === 0) return;
  var box = document.getElementById('fixture-errors');
  if (box === null) { box = document.createElement('div'); box.id = 'fixture-errors'; document.body.appendChild(box); }
  box.textContent = '[夹具]' + errs2.join(' / ');
}, 200);
`

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' }

/**
 * 起一个"像宿主"的小服务：`/mobile/chat` 发 page.html ✓、`/mobile/chat/*` 发真资源 ✓、
 * `/mobile/boot.js` 发假隧道 ✓（模式由 `mode` 决定 ✓）。
 *
 * ★ 多加一条 `/fixture/…` ✗：**这条路径真实宿主上有，但它不属于会话页要拿的量** ✓ ——
 *   它模拟的是"宿主从 `~/.dsh/sessions` 读会话日志"那一步 ✓，
 *   真事件由此**原样**交给页面（不经过会话页自己的任何代码 ✓）。
 */
async function serve(mode) {
  const server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0]
    const send = (body, type) => {
      res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' })
      res.end(body)
    }
    if (path === '/mobile/boot.js') {
      send(mode === 'no-tunnel' ? NO_TUNNEL_BOOT : FAKE_BOOT, MIME['.js'])
      return
    }
    if (path === '/fixture/real-assistant-message-event.json') {
      send(readFileSync(join(FIXTURE_DIR, 'real-assistant-message-event.json')), 'application/json; charset=utf-8')
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

/**
 * 跑一次 Chrome 拿 `--dump-dom` 的 HTML。
 *
 * ★ 两个老坑（都写在这儿，别再重走 ✓）：
 *   ① Chrome 打完 DOM **不退出** ✗ ⇒ 这里拿到标记（或超时）就 SIGKILL ✓；
 *   ② 本机文件沙箱里必须 `--no-sandbox` ✗（否则 GPU 进程直接 FATAL ✓）。
 */
async function dumpDom(url, marker, timeoutMs) {
  const profile = mkdtempSync(join(tmpdir(), 'dshm-chat-e2e-'))
  const chrome = spawn(
    CHROME,
    [
      '--headless=new', '--no-sandbox', '--disable-gpu', `--user-data-dir=${profile}`,
      '--no-first-run', '--no-default-browser-check', '--virtual-time-budget=6000', '--dump-dom', url,
    ],
    { stdio: ['ignore', 'pipe', 'ignore'] },
  )
  let html = ''
  chrome.stdout.on('data', (chunk) => {
    html += chunk.toString('utf8')
  })
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline && !html.includes(marker)) {
    await new Promise((resolve) => setTimeout(resolve, 120))
  }
  chrome.kill('SIGKILL')
  try {
    const { execFileSync } = await import('node:child_process')
    execFileSync('pkill', ['-f', `--user-data-dir=${profile}`], { stdio: 'ignore' })
  } catch (error) {
    void error
  }
  rmSync(profile, { recursive: true, force: true })
  return html
}

// ────────────────────────── 主流程 ──────────────────────────

const setup = await serve('fake')
const base = `http://127.0.0.1:${setup.port}`
console.log(`[check-chat-page] 假宿主 http://127.0.0.1:${setup.port} ✓（/mobile/chat + 假 boot.js）`)

try {
  console.log('\n── 正向（第一趟 · 发出去之后）：页面应当把宿主给的东西都画出来 ──')
  const html = await dumpDom(`${base}/mobile/chat?phase=sent`, 'data-e2e="sent"', 40_000)

  // ★ 夹具自检：页面确实跑到了"发完"那一步（否则下面每一条都可能是在空 DOM 上"通过" ✗）
  check('夹具自检：页面跑完了测试驱动（DOM 上有 data-e2e=sent）', html.includes('data-e2e="sent"'))
  check('夹具自检：产品页面里**没有**开发壳那行内部读数（说明发的是产品页 ✓）', !html.includes('dev：'))
  check('夹具自检：会话列表已到（标题来自宿主 ✓ —— 说明隧道被用上了 ✓）', html.includes('换图标那两个标签'))
  /**
   * ★★ 夹具自检（本单最要紧的一条 ✓）：**真事件**必须真的到了页面上 ✓ ——
   *   它从 `/fixture/…` 下来的 ✓，没到就说明下面"正文不是 JSON"那几条是**空转** ✓。
   */
  const fixtureParts = (html.match(/data-e2e-fixture="(-?\d+)"/) ?? [])[1] ?? ''
  const fixtureError = (html.match(/data-e2e-fixture-error="([^"]*)"/) ?? [])[1] ?? ''
  check(
    '★★ 夹具自检：夹具文件本身是**真形状**（`data.message.content[]` = reasoning + text ✓）',
    REAL_PARTS_ALL.length === 2 && REAL_PROSE.length > 0 && REAL_REASONING.length > 0,
    `块数=${REAL_PARTS_ALL.length}｜正文 ${REAL_PROSE.length} 字｜思维链 ${REAL_REASONING.length} 字`,
  )
  check(
    '★★ 夹具自检：真事件已交给页面（2 个内容块 ✓）',
    fixtureParts === String(REAL_PARTS_ALL.length) && fixtureError === '',
    `块数=${fixtureParts}｜夹具错误=${fixtureError || '(无)'}`,
  )

  check('页头显示的是当前会话的标题 ✓', html.includes('换图标那两个标签'))
  /**
   * ★ 用户消息现在按**真形状**给（`data.message.content[]` ✓ —— 不再是自造的 `data:{text}` ✗）
   *   ⇒ 这条同时钉住"用户消息也走同一套正文提取" ✓。
   */
  check(
    '用户消息被画出来了（真形状 `data.message.content[]` ⇒ 用户气泡 ✓）',
    /class="ev ev-user"[^>]*>\s*<div class="bubble">把首页那两颗图标的圆角再收一点</.test(html),
  )
  /**
   * ★★ 本单的**主断言** ✓：真事件的正文必须**一字不差**地出现在气泡里 ✓，
   *   而且**不许**是 `{"turn":…` 那种"整坨 JSON 被当正文画"✓
   *   （那条 bug 的判据就是它 ✓ —— 变异回旧 `textOf` 时这条必红 ✓）。
   */
  const headAttr = (html.match(/<div class="ev ev-agent[^"]*" data-type="assistant\/message"[^>]*>/) ?? [])[0] ?? ''
  const textChars = Number((headAttr.match(/data-text-chars="(\d+)"/) ?? [])[1] ?? '-1')
  const textHead = decodeURIComponent((headAttr.match(/data-text-head="([^"]*)"/) ?? [])[1] ?? '(没有这个读数)')
  /**
   * 助手那条的**整块 DOM**（`\s*` 兼顾换行 ✓）—— 气泡与折叠的思考块都在里面 ✓。
   * ★ 先取整块、再从里面切气泡 ✗：真实事件带 `details`、被变异过的不带 ⇒
   *   直接从外层数 `</div>` 的个数会**时对时错** ✓（我第一次就写成那样，读出来是空串 ✓）。
   */
  const agentBlock = (html.match(/<div class="ev ev-agent[^"]*" data-type="assistant\/message"[\s\S]*?<\/div><\/div>/) ?? [])[0] ?? ''
  /**
   * 助手气泡里那段字（气泡里**只有文字、没有嵌套元素** ⇒ 非贪婪匹配停在自己的 `</div>` ✓）。
   */
  const agentBubble = (agentBlock.match(/<div class="bubble">([\s\S]*?)<\/div>/) ?? [])[1] ?? ''
  check(
    '★★ 真事件画出来的是**正文**（不是整坨 JSON）：气泡**以正文开头**，且页面上没有 `{"turn":`',
    agentBubble.length > 0 && agentBubble.startsWith(escapeHtml(REAL_PROSE.slice(0, 40))) && !html.includes(escapeHtml('{"turn":')),
    `气泡开头=${JSON.stringify(agentBubble.slice(0, 40))}`,
  )
  check(
    '★★ 正文**就是**期望的那段（字符数逐字对上 `type:\'text\'` 块 ✓）',
    textChars === REAL_PROSE.length,
    `页面上 ${textChars} 字 vs 期望 ${REAL_PROSE.length} 字`,
  )
  check(
    '★ 正文开头不是 JSON（页面上的前 64 字 = 期望正文的前 64 字 ✓）',
    textHead === REAL_PROSE.slice(0, 64),
    `页面上 ${JSON.stringify(textHead)}`,
  )
  /**
   * ★ 思维链的处理（口径同官方客户端 ✓）：它**不进正文** ✗，但在页面上**看得见** ✓
   *   （进了一个**默认折叠**的"思考"块 ✓）。
   */
  check(
    '★★ 思维链**没混进正文**（正文的 data-text-head 不是思维链开头 ✓）',
    textHead !== REAL_REASONING_HEAD && html.includes('思考'),
  )
  check(
    '★★ 思维链本身**看得见**（在折叠的思考块里 ✓ —— 不是丢掉 ✓）',
    html.includes(escapeHtml(REAL_REASONING_HEAD)),
    `思维链开头=${JSON.stringify(REAL_REASONING_HEAD)}`,
  )
  /**
   * ★ 审批按**真形状**（`{id,toolName,callId,reason}` ✓ —— 真日志 55/55 条都没有 `options` ✗）
   *   ⇒ 页面上**不该有任何审批按钮** ✓，而原因原文要摊出来 ✓。
   *   （这与"不许假装能用"是同一条纪律 ✓：看不懂的审批绝不摆按钮 ✓）
   */
  check(
    '★ 真形状的审批（没有 options）⇒ 一颗按钮都不给，且原文摊出来 ✓',
    html.includes('escalate sandbox to danger-full-access') && !/class="approval-option"/.test(html),
  )
  check('★ 认不出的事件类型也画了出来（没有静默丢弃 ✓）', html.includes('someUnknownEvent'))
  check('★ 发出去的这条以用户气泡出现在页面上（走的是真实提交路径 ✓）', html.includes('这条是端到端检查发出去的'))
  check('发送之后输入框是空的（清空立刻 ✓）', !/id="input"[^>]*>这条是端到端检查发出去的</.test(html))

  console.log('\n── 正向（第二趟 · 新建会话之后）：切到空会话，旧内容必须让位 ──')
  const after = await dumpDom(`${base}/mobile/chat?phase=create`, 'data-e2e="done"', 40_000)
  check('夹具自检：第二趟也跑完了（DOM 上有 data-e2e=done）', after.includes('data-e2e="done"'))
  check('★ 新建的会话出现在页头上（走的是真实点击路径 ✓）', after.includes('新会话'))
  check('★★ 切到空会话后，**上一个会话的消息必须消失**（成功返回空也要清 ✓）', !after.includes('把首页那两颗图标的圆角再收一点'))
  check('★★ 而且不许白屏：空会话该显示"还没有内容"✓', after.includes('还没有内容'))

  console.log('\n── 正向（第三趟 · 发失败）：★ "发出去的字必须还在" ──')
  const sendFail = await dumpDom(`${base}/mobile/chat?phase=send-fail`, 'data-e2e="settled"', 40_000)
  check('夹具自检：第三趟跑完了', sendFail.includes('data-e2e="settled"'))
  const draft = (sendFail.match(/data-e2e-draft="([^"]*)"/) ?? [])[1] ?? ''
  check(
    '★★ 发送失败后，草稿**原样回到输入框**（本轮最要紧的一条规矩 ✓）',
    decodeURIComponent(draft) === '这条是端到端检查发出去的',
    `输入框里现在是 ${JSON.stringify(draft)}`,
  )
  check('★ 状态行说清"没发出去"，并告诉用户字还在', sendFail.includes('没发出去') && sendFail.includes('字还在'))
  check('★ 按钮没被卡在"发送中…"（失败后要能再按一次 ✓）', !sendFail.includes('发送中…'))

  console.log('\n── 正向（第四趟 · 读着读着坏掉）：★ "已画出来的内容不许被清掉" ──')
  const readFail = await dumpDom(`${base}/mobile/chat?phase=read-fail`, 'data-e2e="settled"', 40_000)
  check('夹具自检：第四趟跑完了', readFail.includes('data-e2e="settled"'))
  const badReads = Number((readFail.match(/data-e2e-badreads="(\d+)"/) ?? [])[1] ?? '0')
  check('夹具自检：这一趟**真的发生过读取失败**（否则下面那条是空转 ✓）', badReads >= 1, `坏回应 ${badReads} 次`)
  check('★★ 读取出错后，**之前画出来的消息仍在**（出错绝不清屏 ✓）', readFail.includes('把首页那两颗图标的圆角再收一点'))
  if (!readFail.includes('读取出错')) {
    const statusLine = (readFail.match(/id="status"[^>]*>([^<]*)</) ?? [])[1] ?? '(空)'
    const stateCls = (readFail.match(/class="state state-([a-z]+)"/) ?? [])[1] ?? '(没有状态块)'
    const fixtureErr = (readFail.match(/id="fixture-errors"[^>]*>([^<]*)</) ?? [])[1] ?? '(无)'
    console.log(`    现场：状态行=${JSON.stringify(statusLine)}｜状态块=${stateCls}｜夹具错误=${fixtureErr}`)
  }
  check('★ 而状态行确实在报错（不能"装作没事"✓）', readFail.includes('读取出错'))

  console.log('\n── 反向：假隧道缺席 ⇒ 页面必须落到"读不出来"，而不是白屏 ──')
  const noTunnelSetup = await serve('no-tunnel')
  const broken = await dumpDom(`http://127.0.0.1:${noTunnelSetup.port}/mobile/chat`, '读不出来', 30_000)
  if (!broken.includes('读不出来')) {
    const stateClass = (broken.match(/class="state state-([a-z]+)"/) ?? [])[1] ?? '(没有状态块)'
    const statusText = (broken.match(/id="status"[^>]*>([^<]*)</) ?? [])[1] ?? ''
    const stateText = (broken.match(/state-title"[^>]*>([^<]*)</) ?? [])[1] ?? ''
    console.log(`    ── 现场：状态块=${stateClass}｜标题=${stateText}｜状态行=${statusText || '(空)'}`)
    console.log('    ── 脚本报错（若夹具抓到）──')
    const errLine = (broken.match(/\[夹具\]([^<]*)</) ?? [])[1] ?? '(没有抓到任何错误)'
    console.log('    ' + errLine)
  }
  check('★ 反向断言：没有隧道时页面显示"读不出来"（证明这个夹具能发现"没接上" ✓）', broken.includes('读不出来'))
  check('★ 反向断言：错误态下"已读到的都还在"这种内容不许出现（本来就没有内容 ✓）', !broken.includes('把首页那两颗图标的圆角再收一点'))
  noTunnelSetup.server.close()
} finally {
  setup.server.close()
  /**
   * ★★ 这里**不许**去删临时目录本身 ✗ ——
   *   我第一版顺手写了 `rmSync(tmpdir(), …)` ✓，那是在删 `/var/folders/…/T` 这台机器**全系统**的临时目录 ✓
   *   （`recursive:false` 让它只报了 EISDIR ✗ —— 换成递归就是一场事故 ✓）。
   *   规矩：**任何删除动作，路径都要是"自己刚创建的那个具体目录"** ✓，
   *   绝不许把 `tmpdir()` 这类"系统给的公共路径"直接塞进去 ✗。
   *   这里其实无事可做：每次跑用的 Chrome profile 在 `dumpDom` 里已经精确删掉了 ✓。
   */
  if (KEEP) console.log(`[check-chat-page] --keep：临时目录见 ${tmpdir()}（每次跑的 profile 已各自清掉 ✓）`)
}

console.log('\n── check-chat-page ────────────────────────────')
console.log(`通过 ${checks - failed} 项，失败 ${failed} 项（共 ${checks} 项）`)
if (checks < EXPECTED_MIN_CHECKS) {
  console.log(`✗ 断言条数 ${checks} **少于**下界 ${EXPECTED_MIN_CHECKS} —— 有人删了断言，这不是「全都验过了」`)
  failed += 1
}
console.log('───────────────────────────────────────────────')
if (failed > 0) process.exit(1)
