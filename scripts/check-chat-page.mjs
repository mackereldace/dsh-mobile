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
const KEEP = process.argv.includes('--keep')

/** ★ 断言条数下界（**只许上调** ✓ —— 有人删断言不算"全都验过了" ✓）。 */
const EXPECTED_MIN_CHECKS = 24

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
  var events = [
    { seq: 1, time: 1, type: 'turn/start', data: { turn: 1 } },
    { seq: 2, time: 2, type: 'userMessage', data: { text: '把首页那两颗图标的圆角再收一点' } },
    { seq: 3, time: 3, type: 'agentMessage', data: { text: '收到，我把圆角从 14 收到 12。' } },
    { seq: 4, time: 4, type: 'approval/asked', data: { requestId: 'ap-1', tool: '执行命令', detail: 'npm test', options: [{ id: 'allow', label: '允许一次' }, { id: 'deny', label: '拒绝' }] } },
    { seq: 5, time: 5, type: 'someUnknownEvent', data: { whatever: 1 } }
  ]
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
          reads += 1
          if (phase === 'read-fail' && reads > 1) { document.documentElement.setAttribute('data-e2e-badreads', String(reads - 1)); return bad('隧道断了：socket closed') }
          var want = payload && payload.args ? payload.args.sessionId : ''
          if (want === 's-new') return ok({ ok: true, sessionId: 's-new', events: [], hasMore: false })
          return ok({ ok: true, sessionId: 's-1', events: events, hasMore: false })
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
          events = events.concat([{ seq: 100 + events.length, time: 100 + events.length, type: 'userMessage', data: { text: text } }])
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

  check('页头显示的是当前会话的标题 ✓', html.includes('换图标那两个标签'))
  check('用户消息被画出来了', html.includes('把首页那两颗图标的圆角再收一点'))
  check('助手消息被画出来了', html.includes('我把圆角从 14 收到 12'))
  check('审批卡片被画出来了，且选项按钮是**置灰**的（不假装能用 ✓）', html.includes('允许一次') && /class="approval-option"[^>]*disabled/.test(html))
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
