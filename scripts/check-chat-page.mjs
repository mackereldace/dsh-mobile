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
import { execFileSync, spawn } from 'node:child_process'
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
/**
 * ★★ 真 markdown 夹具（本单新增 ✓）：`fixtures/README.md` —— 仓里那份**真文档** ✓，一字未改 ✓。
 *
 * ★ 为什么用**文件**而不是在脚本里编一段 ✗：上一单的教训正是「夹具与真实不符 ⇒
 *   断言全绿、线上照错」✓。这份文档里有标题（`#` / `##` ✓）、粗体（`**…**` ✓）、
 *   有序列表（`1.` `2.` ✓）、围栏代码块（```bash ✓）、表格（`|` ✓）——
 *   全是**真 markdown**，而期望值（下面几条读数 ✓）**从文档机械推出来** ✗，不是手抄的 ✓。
 */
const MD_DOC = readFileSync(join(FIXTURE_DIR, 'README.md'), 'utf8')
/**
 * ★ 不可信输入与公式的**探针**（这一块**不是真事件** ✗ —— 真事件里既没有公式、
 *   也没有恶意输入 ✓ ⇒ 这两档只能自己带 ✓，并且在这里**写明**它是探针 ✓）。
 *
 * ★ 内容是**真的**：粗体 / 斜体 / 行内代码 / 任务勾选 / 行内公式那几行**逐字**取自
 *   工作区的 `公式样例.md` ✓（用户自己写的那一页 ✓）。
 * ★ 恶意输入是**经典探针**（`<img onerror=…>` 与 `javascript:` 链接 ✓）——
 *   它验的是渲染器的**真实行为** ✓（见报告第 5 节 ✓），不是观感 ✓。
 */
const PROBE_MD = [
  '## 不可信输入与公式探针',
  '',
  '行内公式 $E = mc^2$ 与行间公式：',
  '',
  '$$',
  'a^2 + b^2 = c^2',
  '$$',
  '',
  '- **粗体**、*斜体*、`行内代码`',
  '- [x] 任务勾选也能显示',
  '',
  '<img src=x onerror="alert(1)">',
  '',
  '<script>alert(3)</script>',
  '',
  '[点我](javascript:alert(2))',
  '',
].join('\n')
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
 * ★ 不可信输入那几条用的判据：原文到底**以文字**出现在 DOM 里吗 ✓。
 *
 * ★ 为什么要两种编法 ✗：`--dump-dom` 把**文本节点**里的 `<` `>` `&` 转义 ✓，
 *   但 **`"` 不转义**（引号只在属性里才需要转义 ✓）⇒ 只按 `escapeHtml` 去撞
 *   会**假红** ✓（我第一次就是这样 ✓）。两种都认 ✓ —— 判据仍然是"它是**文字**" ✓，
 *   而"它有没有变成元素"由另一条（`!/<img/` ✓）单独钉 ✓。
 */
const escapeTextNode = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const textVisible = (haystack, raw) => haystack.includes(escapeTextNode(raw)) || haystack.includes(escapeHtml(raw))
/**
 * ★ 思维链里**开头**那一小段 ✓ —— 用来证明"它进了折叠的思考块、但**没进**正文气泡" ✓。
 * 取前 24 字（真思维链 ≥100 字 ✓）⇒ 它是 `data-text-head`（前 64 字）的**前缀** ✓。
 */
const REAL_REASONING_HEAD = REAL_REASONING.slice(0, 24)
/**
 * ★★ 从**真事件正文**里机械取出来的两样东西（本单新增 ✓）—— 它们是
 * 「markdown 记号」与「它该变成的那个元素的内容」之间的**唯一**判据 ✓。
 *
 * ★ 为什么非要这样 ✗：不能拿「文本里出现了 `**加了两遍**` 的原文」当「渲染成了粗体」✓
 *   （那正是本仓今天栽过的那类假判据 ✓）。判据必须是：正文里那个 `**X**` 的 X，
 *   在 DOM 里变成了**一个 `<strong>` 元素**，且里面**就是** X ✓。
 */
const REAL_BOLD = (REAL_PROSE.match(/\*\*([^*]+)\*\*/) ?? [])[1] ?? ''
const REAL_INLINE_CODE = (REAL_PROSE.match(/`([^`]+)`/) ?? [])[1] ?? ''
/** 正文里**第一个 markdown 记号之前**那一段 ✓（气泡的文字必须从它开始 ✓）。 */
const REAL_PROSE_LEAD = REAL_PROSE.slice(0, REAL_PROSE.indexOf('**') < 0 ? 40 : REAL_PROSE.indexOf('**'))
/** ★ 真 markdown 文档里的读数（同样**从文档机械推出来** ✓）。 */
const MD_FENCE_FIRST_LINE = (MD_DOC.match(/```[A-Za-z0-9]*\n([^\n]+)/) ?? [])[1] ?? ''
const MD_OL_COUNT = (MD_DOC.match(/^\d+[.)]\s+/gm) ?? []).length
const MD_H_COUNT = (MD_DOC.match(/^#{1,6}\s+/gm) ?? []).length
/** ★ 探针那段里的读数（`$…$` 有两处 ⇒ 该画出两个数学节点 ✓）。 */
const PROBE_MATH_COUNT = 2

/**
 * ★★ 四格（状态条）那几档的**已知投影夹具** ✓ —— 一条真会话的 `values` 真形状 ✓
 * （字段名逐个抄自 `app.asar` ✓，见 `dsh-chat-bridge.ts` 的 `normalizeValues` ✓）。
 *
 * ## 为什么要有它（以及为什么必须有**四**档 ✗）
 *
 * 桥把三个会话投影带进了 `values` ✓，而那是"**可能有、可能没有**"的键 ✗ ——
 * ⇒ 只验"有数据时画对了"是**半个判据** ✓：真正会出错的是另一半 ✓
 * （键缺了却画一个 `0%` / `0 轮` ✓ —— 那正是本条铁律要防的"编数字"✗）。
 * 所以四档各钉一件事 ✓：
 *   · `full`         ⇒ 四格**逐字**且**顺序**正确 ✓（含上下文那个环 ✓）；
 *   · `nopressure`   ⇒ **缺整个 `contextPressure`** ⇒ `%` 那一格**一个都没有** ✗
 *                      （★ `0%` 也算失败 ✗ —— 那正是"退化成 0"）；
 *   · `missingturns` ⇒ `sessionStats` 在、但**缺 `turns`** ⇒ 没有「轮」那一格 ✗
 *                      （★ 不许退化成 `0 轮` ✗ —— 这一档专门打"只判投影在不在"的实现 ✓）；
 *   · `zeroturns`    ⇒ `turns: 0` 是 **DSH 自己报的真实 0** ⇒ **照显示 `0 轮`** ✓
 *                      （★ "没有这个数"与"这个数是 0"是两件事 ✗ —— 这一档防的是**矫枉过正**：
 *                        把真实的 0 也当成"取不到"藏起来 ✓）。
 *
 * ★ 数字是**挑**出来的 ✓（`488 轮` / `2525 步` / `1062M tok` / `45%` ✓ —— 用户给的那张参照表 ✓）：
 *   下面 `expectedCells` 那几格是**从这些数机械算出来**的 ✗，不是手抄的期望值 ✓；
 *   而"机械算出来的就是这四个字面"这一条**单独有一条夹具自检** ✓
 *   ⇒ 谁改了这里的数、却又没改目标字面，那条自检当场红 ✓。
 */
const PROJ_FIXTURES = {
  full: {
    asOfSeq: 8412,
    values: {
      sessionStats: { turns: 488, steps: 2525 },
      // ★ 四桶求和要正好落在 1.062e9 ⇒ `1062M tok` ✓（`cacheWriteTokens` 是 0 也算一个桶 ✓）
      tokenUsage: { uncachedInputTokens: 2000000, cacheReadTokens: 1058000000, cacheWriteTokens: 0, outputTokens: 2000000 },
      // ★ used 取 `projectedTokens`（450000 / 1000000 = 45% ✓）
      contextPressure: { contextWindow: 1000000, pressureTokens: 259578, projectedTokens: 450000 },
    },
  },
  nopressure: {
    asOfSeq: 8412,
    values: {
      sessionStats: { turns: 488, steps: 2525 },
      tokenUsage: { uncachedInputTokens: 2000000, cacheReadTokens: 1058000000, cacheWriteTokens: 0, outputTokens: 2000000 },
      // ★ 这个键**整个不在** ✓（不是 null ✗、不是 0 ✗ —— 桥那层的口径就是"认不出连键都不输出"✓）
    },
  },
  missingturns: {
    asOfSeq: 8412,
    values: {
      sessionStats: { steps: 2525 },
      tokenUsage: { uncachedInputTokens: 2000000, cacheReadTokens: 1058000000, cacheWriteTokens: 0, outputTokens: 2000000 },
      contextPressure: { contextWindow: 1000000, projectedTokens: 450000 },
    },
  },
  zeroturns: {
    asOfSeq: 8412,
    values: {
      sessionStats: { turns: 0, steps: 2525 },
      tokenUsage: { uncachedInputTokens: 2000000, cacheReadTokens: 1058000000, cacheWriteTokens: 0, outputTokens: 2000000 },
      contextPressure: { contextWindow: 1000000, projectedTokens: 450000 },
    },
  },
}

/** ★ 四格的**期望值**：从夹具机械推出来 ✓（口径与 `ui.js` 的 `statsCells` 同源 ✓，不是手抄 ✗）。 */
const TOKEN_BUCKET_KEYS = ['uncachedInputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens']
const expectedTokenSum = (usage) => TOKEN_BUCKET_KEYS.reduce((sum, key) => sum + usage[key], 0)
const expectedTokText = (usage) => {
  const value = expectedTokenSum(usage)
  const scaled = (candidate) => (candidate >= 100 ? String(Math.round(candidate)) : String(Math.round(candidate * 10) / 10))
  if (value < 1e3) return String(value) + ' tok'
  if (value < 1e6) return scaled(value / 1e3) + 'K tok'
  return scaled(value / 1e6) + 'M tok'
}
const expectedPercent = (pressure) => {
  const used = pressure.projectedTokens ?? pressure.pressureTokens
  return Math.min(100, Math.round((used / pressure.contextWindow) * 100))
}
/** 一格 ⇒ `[data-cell, 文本]` ✓（取不到的那一格**根本不在表里** ✗）。 */
const expectedCells = (name) => {
  const values = PROJ_FIXTURES[name].values
  const out = []
  const pressure = values.contextPressure
  if (pressure !== undefined && (pressure.projectedTokens ?? pressure.pressureTokens) !== undefined && pressure.contextWindow !== undefined) {
    out.push(['context', expectedPercent(pressure) + '%'])
  }
  const stats = values.sessionStats
  if (stats !== undefined && stats.turns !== undefined) out.push(['turns', stats.turns + ' 轮'])
  if (stats !== undefined && stats.steps !== undefined) out.push(['steps', stats.steps + ' 步'])
  const usage = values.tokenUsage
  if (usage !== undefined && TOKEN_BUCKET_KEYS.every((key) => usage[key] !== undefined)) out.push(['tokens', expectedTokText(usage)])
  return out
}
/** ★ 上下文那个环的 `stroke-dasharray` ✓（与 `ui.js` 同一条算式 ✓ —— 两侧都是 IEEE754 双精度 ⇒ 字面相等 ✓）。 */
const RING_CIRCUMFERENCE = 2 * Math.PI * 5.5
const expectedDash = (percent) => RING_CIRCUMFERENCE * percent / 100 + ' ' + RING_CIRCUMFERENCE

/**
 * 从 dump 里切出**某一条助手事件**的那一块 ✓ —— 按 `data-text-chars`（= 正文长度 ✓）找 ✓。
 *
 * ★ 为什么不用「第几条」✗：事件先后由 `seq` 决定 ✓，用序号会在夹具一增减时**静默错位** ✓
 *   （切错了还照样去 includes ⇒ 假绿 ✓）。
 */
const agentBlockByChars = (html, chars) => {
  for (const part of html.split('<div class="ev ev-agent')) {
    if (!part.includes('data-type="assistant/message"')) continue
    const seen = Number((part.match(/data-text-chars="(\d+)"/) ?? [])[1] ?? '-1')
    if (seen === chars) return '<div class="ev ev-agent' + part.split('</div></div>')[0] + '</div></div>'
  }
  return ''
}

/**
 * ★ 断言条数下界（**只许上调** ✓ —— 有人删断言不算"全都验过了" ✓）。
 *
 * ★★ 提到 **96** 的账（本单 ✓）：改前是 **67** ✗ —— 而那一轮**实跑 73 项** ✓
 *   ⇒ 也就是**有 6 条余量** ✗（少跑 6 条也不会红 ✓，那正是这道下界想防的静默 ✓）。
 *   本单实跑 **96** 项（95 通过 / 1 失败 —— 那条红是审批那单造成的**过期断言** ✓，
 *   与本单无关 ✓，也不由本单来修 ✗）⇒ 下界**贴着实跑数**写到 **96** ✓。
 *   ★ 本文件同时有另一单在改（★ 它把那 6 条余量里的一条用掉了：67 → 68 ✓）——
 *   ★ 这一行是**共享的** ✗：谁最后写谁说了算 ✓（若那一单后写，就会退回 68 ✓）。 */
const EXPECTED_MIN_CHECKS = 96

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
  /*
   * ★★ 这一趟的**取数方式**与**投影档**由 URL 决定 ✓（本单新增 ✓）。
   *
   * ★ 为什么用 URL 参数而不是"另起一个夹具" ✗：\`app.js\` 判"走流还是走轮询"的判据是
   *   **能力**（\`typeof tunnel.openStream === 'function'\` ✓，在**模块加载那一刻**读一次 ✓）
   *   ⇒ 只有"这一趟有没有挂 openStream"能改它 ✓ —— 而**不挂**的那几趟
   *   （\`phase=create\` / \`send-fail\` / \`read-fail\` / 无隧道 ✓）必须**逐字保持原样** ✗
   *   （它们验的是轮询那条老路 ✓，一个字都不许动 ✓）。
   *
   * ★ 四格的数据**只能**从流那条路来 ✓（★ 这不是夹具挑食 ✗）：
   *   \`app.js\` 把快照里的投影记进 \`latestProjections\` ✓（\`rememberProjections\` ✓，
   *   只认 \`{type:'snapshot', projections}\` ✓）⇒ \`boot.chatProjections()\` 才念得出来 ✓；
   *   而**真机上恒为流** ✓（\`boot.js\` 一直有 \`openStream\` ✓ —— 见 \`app.js:56\` 那段 ✓）。
   */
  var Q = new URLSearchParams(location.search)
  var PROJ_KEY = Q.get('proj') || ''
  var STREAM_MODE = Q.get('fetch') === 'stream'
  /** ★ 探针在页面加载后多久取读数 ✓（默认 320 与原状逐字相同 ✓；流那一档给宽一点 ✓）。 */
  var PROBE_MS = Number(Q.get('probe') || '320')
  var PROJECTIONS = ${JSON.stringify(PROJ_FIXTURES)}
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
  // ★ 真事件与真 markdown 文档都**同步**拉（经典脚本先跑、module 是 defer ✓）
  //   ⇒ 第一次读之前一定已经就位 ✓
  try {
    var xhr = new XMLHttpRequest()
    xhr.open('GET', '/fixture/real-assistant-message-event.json', false)
    xhr.send(null)
    realAssistant = JSON.parse(xhr.responseText)
    events = events.concat([realAssistant])
    document.documentElement.setAttribute('data-e2e-fixture', String(Array.isArray(realAssistant.data.message.content) ? realAssistant.data.message.content.length : -1))
  } catch (error) {
    document.documentElement.setAttribute('data-e2e-fixture-error', String((error && error.message) || error))
  }
  /*
   * ★★ 本单的**真 markdown 夹具** ✓：把仓里那份真文档（fixtures/README.md ✓）原样拉下来，
   *   包成**真形状**的 assistant/message 事件 ✓（data.message.content 里 type=text 那种块 ✓）。
   *   ★ 两条探针事件单独发（公式 + 不可信输入 ✓ —— 真事件里没有这两样 ✓）。
   *   ★ seq 必须**大于**真事件那条（8345 ✓）✗：断言里取"第一条 assistant/message"的地方
   *     还在（见下面 agentBlock ✓）⇒ 让真事件永远是第一条 ✓。
   */
  var mdDoc = ''
  var probeDoc = ''
  try {
    var mdXhr = new XMLHttpRequest()
    mdXhr.open('GET', '/fixture/real-markdown-doc.md', false)
    mdXhr.send(null)
    mdDoc = mdXhr.responseText
  } catch (mdError) {
    document.documentElement.setAttribute('data-e2e-md-error', String((mdError && mdError.message) || mdError))
  }
  try {
    var probeXhr = new XMLHttpRequest()
    probeXhr.open('GET', '/fixture/untrusted-probe.md', false)
    probeXhr.send(null)
    probeDoc = probeXhr.responseText
  } catch (probeError) {
    document.documentElement.setAttribute('data-e2e-md-error', String((probeError && probeError.message) || probeError))
  }
  if (mdDoc.length > 0) {
    events = events.concat([
      { seq: 9001, time: 9001, type: 'assistant/message', data: { turn: 1, step: 2, message: { content: [{ type: 'text', text: mdDoc }] } } }
    ])
  }
  if (probeDoc.length > 0) {
    events = events.concat([
      { seq: 9002, time: 9002, type: 'assistant/message', data: { turn: 1, step: 3, message: { content: [{ type: 'text', text: probeDoc }] } } }
    ])
  }
  document.documentElement.setAttribute('data-e2e-md', String(mdDoc.length))
  flush()
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
  /*
   * ★★ 这里**不能**整个盖掉 __DSH_MOBILE_BOOT__ ✗（本单改 ✓）：
   *   宿主发的 boot.js 已经把 **markdown 渲染器**挂在它上面了 ✓
   *   （renderMarkdownInto ✓ —— 会话页要用的就是它 ✓）⇒
   *   整对象重新赋值会把渲染器**悄悄抹掉** ✓ ⇒ 页面永远走兜底路径、而断言还全绿 ✗。
   */
  var __api = globalThis.__DSH_MOBILE_BOOT__ = globalThis.__DSH_MOBILE_BOOT__ || {}
  __api.tunnel = {
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
    }
  // 夹具自检用：真页面跑完应当已经问过这两个端点 ✓
  __api.__fakeCalls = function () { return calls.slice() }
  __api.__fakeSent = function () { return sent.slice() }
  /*
   * ★★ 流那条路（★ 本单新增 ✗，**只在 \`?fetch=stream\` 那一趟挂上** ✓）——
   *   四格的数据（会话投影 ✓）**只有**开场快照带得下来 ✓，而快照只在流里 ✓。
   *
   * ## 这一条流要满足的两件事（★ 都与真宿主同形 ✗）
   *
   * 1. **第一帧必须是 \`{type:'snapshot'}\`** ✓，里面 \`records[].event\` 逐条是事件 ✓、
   *    \`projections\` 就是那三个键 ✓ —— 与 \`app.js\` 的 \`frameEvents\` / \`rememberProjections\`
   *    认的两样**逐字对齐** ✓（形状错了 ⇒ 事件不来 / 投影不来 ⇒ 断言全红 ✓，不会静默 ✓）；
   * 2. **之后一直挂着** ✓（不结束 ✗）：流正常收尾会被 \`app.js\` 当成一次断开 ✓
   *    （\`StreamEnd\` ⇒ 报错 + 排重开 ✓）⇒ 那一趟会反复重开、读数是活的 ✓
   *    —— ★ 本单不验重开那条路 ✗（它有自己的单 ✓），所以这里按住不动 ✓。
   *    ★ \`return()\` 要**真的**把挂着的 \`next()\` 叫醒 ✗（切会话 / 发消息都会取消这一条 ✓）——
   *    不叫醒它，页面里那个 \`await\` 就永远挂着 ✓（\`app.js\` 里那段"取消闩"注释说的就是这个坑 ✓）。
   */
  if (STREAM_MODE) {
    __api.tunnel.openStream = function (method, payload) {
      calls.push(method + '(stream)')
      void payload
      var frame = {
        type: 'snapshot',
        records: events.map(function (one) { return { event: one } }),
        projections: PROJECTIONS[PROJ_KEY] || null,
      }
      var handed = false
      var hold = null
      var iter = {
        next: function () {
          if (!handed) { handed = true; return Promise.resolve({ done: false, value: frame }) }
          return new Promise(function (resolve) { hold = resolve })
        },
        'return': function () {
          if (hold !== null) { var fire = hold; hold = null; fire({ done: true, cancelled: true }) }
          return Promise.resolve({ done: true })
        },
      }
      iter[Symbol.asyncIterator] = function () { return iter }
      var iterable = {}
      iterable[Symbol.asyncIterator] = function () { return iter }
      return iterable
    }
  }
  /** ★ 这一趟**真的**是流 / 真的带了哪一档投影 ✓（夹具自检用 ✓）。 */
  document.documentElement.setAttribute('data-e2e-fetch', STREAM_MODE ? 'stream' : 'poll')
  document.documentElement.setAttribute('data-e2e-proj', PROJ_KEY || '(none)')
  /*
   * ★★ 夹具自检（本单最要紧的一条 ✓）：页面里**真的拿得到**那个渲染器吗 ✗ ——
   *   它来自宿主发的真 boot.js ✓（不是我在这儿塞的 ✓）。
   *   拿不到 ⇒ 下面的 markdown 断言全是在验**兜底路径** ✓（假绿 ✓）。
   */
  document.documentElement.setAttribute('data-e2e-boot', typeof __api.renderMarkdownInto)
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
        /*
         * ★★ 输入栏的**几何读数**（本单新增 ✓）—— dump-dom 只给 DOM，
         *   所以把 getBoundingClientRect / getComputedStyle 的结果
         *   序列化成一个属性挂在 documentElement 上 ✓（与 data-e2e-draft 同一套做法 ✓）。
         *   ★ 量的是**关系**（相对视口宽 / 相对卡片）✗，不是写死的像素 ✓ ——
         *     这个夹具跑在 Chrome 默认窗口宽上，写死像素会假红 ✓。
         */
        setTimeout(function () {
          try {
            var card = document.querySelector('.composer-card')
            var tools = document.querySelectorAll('.tool-btn')
            var send = document.querySelector('.send-btn')
            var strip = document.querySelector('.stats-strip')
            var home = document.querySelector('.homebar')
            var composer = document.getElementById('composer')
            var input = document.getElementById('input')
            var box = function (e) {
              if (e === null || e === undefined) return null
              var r = e.getBoundingClientRect()
              return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), bottom: Math.round(r.bottom), right: Math.round(r.right) }
            }
            var radiusOf = function (e) { return e === null || e === undefined ? null : getComputedStyle(e).borderRadius }
            var g = {
              vw: innerWidth, vh: innerHeight,
              card: box(card), cardRadius: radiusOf(card),
              toolCount: tools.length,
              tools: [].slice.call(tools).map(function (b) { return box(b) }),
              toolRadius: tools.length > 0 ? radiusOf(tools[0]) : null,
              toolLabels: [].slice.call(tools).map(function (b) { return b.getAttribute('aria-label') }),
              send: box(send), sendRadius: radiusOf(send),
              sendIcon: box(document.querySelector('.send-btn .send-icon')),
              strip: box(strip), stripFont: strip === null ? null : getComputedStyle(strip).fontSize,
              stripText: strip === null ? null : strip.textContent,
              /*
               * ★★ 状态条那**四格**的逐项读数 ✓（本单新增 ✓ —— 这一段就是四格断言的全部证据 ✓）。
               *
               * ★ 判据一律是**元素与文本** ✗，不是"页面里出现了 \`%\` 这个字符"✓：
               *   · \`stripCells\` 逐格记 \`[data-cell, 文本]\` ✓（顺序即 DOM 顺序 ✓）；
               *   · \`stripSeps\` 数分隔符 ✓（应当是**格数 − 1** ✓ —— 缺一格时不许留孤零零的「·」✓）；
               *   · \`stripButtons\` 数这一条里的 \`<button>\` ✓（★ 必须是 **0** ✗ —— 四格是纯展示 ✓）；
               *   · 环的 \`stroke-width\` 与 \`stroke-dasharray\` 都取自**计算值/属性**✓
               *     （dasharray 与脚本里那条同算式机械推出来的字面**逐字比** ✓）。
               */
              stripCells: strip === null ? null : [].slice.call(strip.querySelectorAll('.stats-cell')).map(function (c) {
                return [c.getAttribute('data-cell'), c.textContent]
              }),
              stripSeps: strip === null ? null : strip.querySelectorAll('.stats-sep').length,
              stripButtons: strip === null ? null : strip.querySelectorAll('button').length,
              stripHidden: strip === null ? null : strip.hasAttribute('hidden'),
              stripDisplay: strip === null ? null : getComputedStyle(strip).display,
              stripLineHeight: strip === null ? null : getComputedStyle(strip).lineHeight,
              stripGapUnit: strip === null ? null : getComputedStyle(strip).gap,
              stripPadLeft: strip === null ? null : getComputedStyle(strip).paddingLeft,
              stripClipped: strip === null ? null : strip.scrollWidth > strip.clientWidth + 1,
              stripRing: (function () {
                var ring = strip === null ? null : strip.querySelector('.stats-ring')
                if (ring === null) return null
                var track = ring.querySelector('.stats-ring-track')
                var fill = ring.querySelector('.stats-ring-fill')
                var trackCss = track === null ? null : getComputedStyle(track)
                var fillCss = fill === null ? null : getComputedStyle(fill)
                return {
                  viewBox: ring.getAttribute('viewBox'),
                  box: box(ring),
                  trackStrokeWidth: trackCss === null ? null : trackCss.strokeWidth,
                  trackStroke: trackCss === null ? null : trackCss.stroke,
                  trackFill: trackCss === null ? null : trackCss.fill,
                  fillStrokeWidth: fillCss === null ? null : fillCss.strokeWidth,
                  fillStroke: fillCss === null ? null : fillCss.stroke,
                  fillLinecap: fillCss === null ? null : fillCss.strokeLinecap,
                  dash: fill === null ? null : fill.getAttribute('stroke-dasharray'),
                  transform: fill === null ? null : fill.getAttribute('transform'),
                }
              })(),
              home: box(home), homeHeight: home === null ? null : getComputedStyle(home).height,
              composer: box(composer),
              placeholder: input === null ? null : input.getAttribute('placeholder'),
              sendLabel: (function () { var l = document.getElementById('send-label'); return l === null ? null : l.textContent })(),
            }
            document.documentElement.setAttribute('data-e2e-geometry', encodeURIComponent(JSON.stringify(g)))
            /*
             * ★★ 标签栏「对话｜轨迹」的读数（本单新增 ✓）。
             *
             * 判据要能证明**换了一屏**✗（不是"按钮变了色"✓）⇒ 两样都记：
             *   1. 点之前两个视图层各自的 hidden 与几何（对话层可见、轨迹层不可见 ✓）；
             *   2. 按**真实点击路径**点「轨迹」之后，再记一次 ✓ + 轨迹层画出来几条 ✓。
             * ★ 轨迹层那几条**不带 [hidden] 也量得到几何**✓（量的是盒子、不是可见性 ✓）——
             *   所以"换了一屏"那条判据必须看 hidden / display✗，不能看"轨迹层有没有尺寸"✓。
             */
            var tabBar = document.getElementById('tabs')
            var chatLayer = document.getElementById('messages')
            var traceLayer = document.getElementById('trace')
            var tabBtns = [].slice.call(document.querySelectorAll('#tabs button[role=tab]'))
            var tbox = function (e) { return box(e) }
            var stateOf = function (el) {
              if (el === null || el === undefined) return null
              return {
                hidden: el.hasAttribute('hidden'),
                display: getComputedStyle(el).display,
                tabIndex: el.getAttribute('aria-selected'),
                cls: el.className,
                text: el.textContent,
                rect: box(el),
              }
            }
            var tabs = {
              vw: innerWidth, vh: innerHeight,
              barFound: tabBar !== null, barRole: tabBar === null ? null : tabBar.getAttribute('role'),
              barRect: tbox(tabBar),
              barGap: tabBar === null ? null : getComputedStyle(tabBar).gap,
              barPaddingLeft: tabBar === null ? null : getComputedStyle(tabBar).paddingLeft,
              barMarginTop: tabBar === null ? null : getComputedStyle(tabBar).marginTop,
              btnCount: tabBtns.length,
              btns: tabBtns.map(function (el) {
                var r = el.getBoundingClientRect()
                var c = getComputedStyle(el)
                var after = getComputedStyle(el, '::after')
                return {
                  id: el.id, text: el.textContent, selected: el.getAttribute('aria-selected'),
                  rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), bottom: Math.round(r.bottom), right: Math.round(r.right) },
                  fontSize: c.fontSize, fontWeight: c.fontWeight, lineHeight: c.lineHeight, color: c.color,
                  paddingBottom: c.paddingBottom,
                  afterHeight: after.height, afterBottom: after.bottom, afterRadius: after.borderRadius,
                }
              }),
              headerRect: tbox(document.querySelector('header')),
              before: { chat: stateOf(chatLayer), trace: stateOf(traceLayer) },
              badgeCount: document.querySelectorAll('.tab-badge, .tabs .badge, [data-tab-badge]').length,
              barHTML: tabBar === null ? '' : tabBar.outerHTML.slice(0, 900),
            }
            /*
             * ★★ 切标签**不许动布局** ✗ —— 判据取**输入栏那一层**（#composer ✓）
             * 而不是里面那张卡片 ✓。
             *
             * ★ 为什么不是卡片 ✗（本单**实测**出来的 ✓）：卡片的高度跟着 textarea
             * **自己长**✓（growInput ✓ —— 夹具刚往输入框写了字 ✓）⇒ 它的 bottom
             * 在两次读数之间本来就会差几像素 ✓ ⇒ 拿它当判据是**假红** ✓
             * （我第一版就是这么写的 ✓，读到 "391 → 359" ✓，红得毫无道理 ✓）。
             * 稳的那一层是 #composer：它的盒子只由页头 / 标签栏 / main 决定 ✓。
             */
            tabs.composerBefore = (function () {
              var cp0 = document.getElementById('composer')
              return cp0 === null ? null : box(cp0)
            })()
            var traceBtn = document.getElementById('tab-trace')
            if (traceBtn !== null) traceBtn.dispatchEvent(new Event('click'))
            tabs.after = { chat: stateOf(chatLayer), trace: stateOf(traceLayer) }
            tabs.traceSteps = (traceLayer === null ? 0 : traceLayer.querySelectorAll('.ev').length)
            tabs.traceHasTool = traceLayer !== null && traceLayer.querySelector('.ev-tool') !== null
            tabs.traceHasStep = traceLayer !== null && traceLayer.querySelector('.ev-step') !== null
            tabs.traceHasUser = traceLayer !== null && traceLayer.querySelector('.ev-user') !== null
            tabs.selectedAfterClick = tabBtns.map(function (el) { return el.getAttribute('aria-selected') })
            tabs.inputVisibleAfter = (function () {
              var out2 = { vh: innerHeight }
              var mn2 = document.querySelector('main')
              if (mn2 !== null) out2.main = box(mn2)
              var cp3 = document.getElementById('composer')
              if (cp3 !== null) out2.composer = box(cp3)
              var app2 = document.querySelector('.app')
              if (app2 !== null) out2.app = box(app2)
              return out2
            })()
            document.documentElement.setAttribute('data-e2e-tabs', encodeURIComponent(JSON.stringify(tabs)))
          } catch (error) {
            document.documentElement.setAttribute('data-e2e-geometry-error', String((error && error.message) || error))
          }
        }, PROBE_MS)
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
      /**
       * ★★ 这里发的是**真的 `boot.js`**（宿主线上发的就是这一份 ✓：`packages/host/lib/boot.js` ✓）
       *   后面接上夹具那半（假隧道 ✓）。
       *
       * ★ 为什么非真不可 ✗（本单改 ✓）：会话页的 markdown 渲染器**就在这个文件里** ✓ ——
       *   用一份假 boot 就永远测不到「页面真的从宿主那里拿到了渲染器」✓，
       *   而那正是本单的判据 ✓（假 boot 会把渲染器抹掉 ⇒ 页面永远走兜底 ⇒ 假绿 ✗）。
       * ★ 真 boot.js 在会话页上是**安全**的 ✓：`page.html` 设了 `__DSH_MOBILE_NO_SHELL__` ✓
       *   ⇒ 外壳不装 ✓（只读探针实测：没有 DOM 注入、没有报错、`tunnel` 仍由夹具给 ✓）。
       */
      const real = readFileSync(join(HERE, '..', 'packages', 'host', 'lib', 'boot.js'), 'utf8')
      /**
       * ★ `no-renderer` 模式：把渲染器**摘掉**（模拟老宿主 ✓）——
       *   验的是兜底那条路：拿不到渲染器时正文**照旧看得见** ✓，不许空白 ✗。
       */
      const prelude = mode === 'no-renderer'
        ? '\n;(function () { var api = globalThis.__DSH_MOBILE_BOOT__; if (api) api.renderMarkdownInto = undefined })();\n'
        : ''
      const fixture = mode === 'no-tunnel' ? NO_TUNNEL_BOOT : FAKE_BOOT
      send(real + prelude + '\n;/* ---- 夹具（假隧道）---- */\n' + fixture, MIME['.js'])
      return
    }
    if (path === '/fixture/real-assistant-message-event.json') {
      send(readFileSync(join(FIXTURE_DIR, 'real-assistant-message-event.json')), 'application/json; charset=utf-8')
      return
    }
    /**
     * ★★ 真 markdown 文档（仓里那份夹具 README ✓）—— 原样发，不改一个字 ✓。
     *   它**不属于会话页要拿的量** ✓（会话页拿不到夹具目录 ✓），
     *   与真事件同一条路：模拟宿主把磁盘上的东西交给页面 ✓。
     */
    if (path === '/fixture/real-markdown-doc.md') {
      send(readFileSync(join(FIXTURE_DIR, 'README.md')), 'text/markdown; charset=utf-8')
      return
    }
    /** ★ 探针那段（公式 + 不可信输入 ✓ —— 不是真事件 ✓，见 PROBE_MD 上面的说明 ✓）。 */
    if (path === '/fixture/untrusted-probe.md') {
      send(PROBE_MD, 'text/markdown; charset=utf-8')
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
 * 跑一次 Chrome 拿 DOM 的 HTML。
 *
 * ★ 两个老坑（都写在这儿，别再重走 ✓）：
 *   ① Chrome 打完 DOM **不退出** ✗ ⇒ 这里拿到标记（或超时）就 SIGKILL ✓；
 *   ② 本机文件沙箱里必须 `--no-sandbox` ✗（否则 GPU 进程直接 FATAL ✓）。
 *
 * ★ 第三个参数 `viewport`（本单新增 ✓，形如 `'412x915'` ✓）：
 *   · **不带** ⇒ 走 `--dump-dom` ✓，还是**原来的默认窗口** ✓（第一趟那些读数一个字都没变 ✗）；
 *   · **带上** ⇒ 改走 CDP ✓（见 `dumpDomAtViewport` ✓）—— 因为 `--window-size` 在
 *     新版 headless Chrome 上**不决定视口** ✗（本轮实测：传 `--window-size=412x915` ✓，
 *     页面里读到的仍是 **756×413** ✓ ⇒ 那个参数静默无效 ✓，而"两档几何"若照着它写
 *     就是**两条永远在量同一个窗口**的假判据 ✓ —— 这正是本仓最忌讳的那类 ✓）。
 */
async function dumpDom(url, marker, timeoutMs, viewport) {
  if (typeof viewport === 'string' && /^\d+x\d+$/.test(viewport)) {
    return dumpDomAtViewport(url, marker, timeoutMs, viewport)
  }
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

/**
 * ★★ 在**指定视口**上跑一次，拿 DOM 的 HTML（本单新增 ✓ —— 「几何两档」那条判据的**唯一**办法 ✓）。
 *
 * ## 为什么非走 CDP 不可 ✗
 *
 * `--window-size` 在 headless Chrome 上**不决定视口** ✗（**实测**：传 `412x915` ✓、
 * 页面里 `innerWidth×innerHeight` 仍是 **756×413** ✓ —— 与不传时逐字相同 ✓）。
 * 而 `Emulation.setDeviceMetricsOverride` 是**真·视口覆盖** ✓：
 * `innerWidth` / `innerHeight` / `devicePixelRatio` / `matchMedia` 全跟着它走 ✓
 * —— 与输入栏那一单量真 DSH 页面时用的是同一条路 ✓。
 *
 * ## 纪律（与全仓其它起 Chrome 的脚本同一条 ✓）
 *
 * · profile 用 `mkdtempSync` 自建 ✓、回收**只按自己那个完整路径** `pkill -f --user-data-dir=<它>` ✓
 *   （**绝不按名字或端口** ✗ —— 会误伤用户自己开着的 Chrome ✓）；
 * · **每一步都有超时** ✗（起 CDP 15s ✓、加载 30s ✓）—— 无超时的 `await` 会一直挂着 ✓
 *   （这正是"起了个 Chrome 卡了 10 小时"那类事故的形状 ✓）。
 */
async function dumpDomAtViewport(url, marker, timeoutMs, viewport) {
  const [width, height] = viewport.split('x').map(Number)
  const profile = mkdtempSync(join(tmpdir(), 'dshm-chat-geo-'))
  /** ★ 让系统给一个**空闲端口** ✓（写死端口在并行跑时必然撞 ✓）。 */
  const port = await new Promise((resolve) => {
    const probe = createServer()
    probe.listen(0, '127.0.0.1', () => {
      const p = probe.address().port
      probe.close(() => resolve(p))
    })
  })
  const chrome = spawn(
    CHROME,
    [
      '--headless=new', '--no-sandbox', '--disable-gpu', `--user-data-dir=${profile}`,
      '--no-first-run', '--no-default-browser-check', `--remote-debugging-port=${port}`,
      '--ignore-certificate-errors', 'about:blank',
    ],
    { stdio: 'ignore', detached: true },
  )
  let html = ''
  const cleanup = () => {
    try { process.kill(-chrome.pid, 'SIGKILL') } catch (error) { void error }
    try {
      execFileSync('pkill', ['-f', `--user-data-dir=${profile}`], { stdio: 'ignore' })
    } catch (error) { void error }
    rmSync(profile, { recursive: true, force: true })
  }
  try {
    // ① 等 CDP 端点（★ 有超时 ✓）
    const versionDeadline = Date.now() + 15_000
    let pageWs = ''
    while (Date.now() < versionDeadline && pageWs.length === 0) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
        const page = (Array.isArray(list) ? list : []).filter((t) => t.type === 'page')[0]
        pageWs = page !== undefined && typeof page.webSocketDebuggerUrl === 'string' ? page.webSocketDebuggerUrl : ''
      } catch (error) { void error }
      if (pageWs.length === 0) await new Promise((resolve) => setTimeout(resolve, 200))
    }
    if (pageWs.length === 0) return html
    // ② 连上去、把视口打准（★ 连接也有超时 ✓）
    const ws2 = new WebSocket(pageWs)
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP 连接超时')), 10_000)
      ws2.addEventListener('open', () => { clearTimeout(timer); resolve() })
      ws2.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP 连接失败')) })
    })
    let nextId = 0
    const waiting = new Map()
    ws2.addEventListener('message', (event) => {
      const data = JSON.parse(event.data)
      const slot = waiting.get(data.id)
      if (slot === undefined) return
      waiting.delete(data.id)
      if (data.error !== undefined) slot.reject(new Error(JSON.stringify(data.error)))
      else slot.resolve(data.result)
    })
    const send2 = (method, params) => new Promise((resolve, reject) => {
      const id = (nextId += 1)
      waiting.set(id, { resolve, reject })
      ws2.send(JSON.stringify({ id, method, params: params ?? {} }))
    })
    await send2('Page.enable')
    await send2('Emulation.setDeviceMetricsOverride', {
      width, height, deviceScaleFactor: 2, mobile: true, screenWidth: width, screenHeight: height,
    })
    await send2('Page.navigate', { url })
    // ③ 等标记（★ 有超时 ✓）
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const probe = await send2('Runtime.evaluate', {
        expression: 'document.documentElement ? document.documentElement.outerHTML : ""',
        returnByValue: true,
      })
      html = typeof probe.result?.value === 'string' ? probe.result.value : ''
      if (html.includes(marker)) break
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
    ws2.close()
  } catch (error) {
    void error
  } finally {
    cleanup()
  }
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
  /**
   * ★★ 本单的两条**夹具自检** ✓——少了它们，下面的 markdown 断言有可能是在**空转** ✓：
   *   · 页面到底有没有**真渲染器**（假 boot 会把它抹掉 ⇒ 页面永远走兜底 ⇒ 假绿 ✗）；
   *   · 那份**真 markdown 文档**到底有没有交到页面 ✓。
   */
  const bootProbe = (html.match(/data-e2e-boot="([^"]*)"/) ?? [])[1] ?? '(没有这个读数)'
  const mdDocChars = Number((html.match(/data-e2e-md="(\d+)"/) ?? [])[1] ?? '-1')
  const mdError = (html.match(/data-e2e-md-error="([^"]*)"/) ?? [])[1] ?? ''
  check(
    '★★ 夹具自检：页面里**真的拿得到**渲染器（宿主发的 boot.js 导出的那个 ✓ —— 换成假 boot 这条必红 ✓）',
    bootProbe === 'function' && mdError === '',
    `typeof renderMarkdownInto=${bootProbe}｜夹具错误=${mdError || '(无)'}`,
  )
  check(
    '★★ 夹具自检：**真 markdown 文档**已交给页面（字数逐字对上那份文件 ✓）',
    mdDocChars === MD_DOC.length,
    `页面上 ${mdDocChars} 字 vs 文件 ${MD_DOC.length} 字`,
  )

  check('页头显示的是当前会话的标题 ✓', html.includes('换图标那两个标签'))
  /**
   * ★ 用户消息现在按**真形状**给（`data.message.content[]` ✓ —— 不再是自造的 `data:{text}` ✗）
   *   ⇒ 这条同时钉住"用户消息也走同一套正文提取" ✓。
   * ★★ 本单把口径**改强**了 ✗：气泡里不但要有那段字，还要**过渲染器** ✓
   *   （渲染器给每段包一个 `<p>` ✓）—— 所以这里钉的是 `<p>` + 原话 ✓，
   *   而不是原来那句"气泡里直接就是裸文本" ✓（那正是被本单换掉的行为 ✓）。
   */
  const userBubble = (html.match(/class="ev ev-user"[^>]*>\s*<div class="bubble">([\s\S]*?)<\/div>/) ?? [])[1] ?? ''
  check(
    '用户消息被画出来了，而且正文**过的是渲染器**（真形状 `data.message.content[]` ⇒ 气泡里的 `<p>` ✓）',
    userBubble.includes('<p>') && userBubble.includes('把首页那两颗图标的圆角再收一点'),
    `用户气泡=${JSON.stringify(userBubble.slice(0, 48))}`,
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
    agentBubble.startsWith('<p>' + escapeHtml(REAL_PROSE_LEAD)) && !html.includes(escapeHtml('{"turn":')),
    `气泡开头=${JSON.stringify(agentBubble.slice(0, 48))}`,
  )
  /**
   * ★★ 本单的**主断言** ✓：正文里的 markdown 记号**真的变成了元素** ✗。
   *
   * `**X**` ⇒ `<strong>X</strong>` ✓、行内代码 ⇒ `<code>X</code>` ✓，
   * 而 X **是从真事件正文里机械取出来的** ✓（不是手抄的期望值 ✗）。
   * ★ 判据为什么非这样不可 ✗：「文本里出现了 `**加了两遍**` 的原文」在**旧行为**
   *   （`textContent`）下同样成立 ✓ —— 那是假判据 ✓。这里要的是**元素** ✓。
   * ★ 变异回 `textContent`（或把原文整个塞进 `innerHTML`）⇒ 这条必红 ✓。
   */
  check(
    '★★ 真事件里的 markdown **真的渲染成了元素**（`**X**` ⇒ `<strong>X</strong>` ✓、行内代码 ⇒ `<code>X</code>` ✓）',
    REAL_BOLD.length > 0 && REAL_INLINE_CODE.length > 0 &&
      agentBubble.includes('<strong>' + escapeHtml(REAL_BOLD) + '</strong>') &&
      agentBubble.includes('<code>' + escapeHtml(REAL_INLINE_CODE) + '</code>'),
    `期望 <strong>${REAL_BOLD}</strong> 与 <code>${REAL_INLINE_CODE}</code>｜气泡=${JSON.stringify(agentBubble.slice(0, 90))}`,
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
  /**
   * ★★ 本单新加：认不出的形状**照旧摊原文** ✗（不只画个类型名 ✓）。
   *   `someUnknownEvent` 的 data 是 `{whatever:1}` ✓ ⇒ `textOf` 认不出字段 ⇒
   *   `JSON.stringify` 兜底 ✓ ⇒ 那坨 JSON 必须**看得见** ✓。
   * ★ 变异：把兜底那条 append 删掉 ⇒ 这条必红 ✓（类型名那条也可能一起红 ✓）。
   */
  check(
    '★ 认不出的形状**照旧摊原文**（`{"whatever":1}` 那坨 JSON 在页面上看得见 ✓ —— 静默丢掉必红 ✓）',
    html.includes('someUnknownEvent') && html.includes('{"whatever":1}'),
    `原文字样在不在=${html.includes('{"whatever":1}')}`,
  )
  check('★ 发出去的这条以用户气泡出现在页面上（走的是真实提交路径 ✓）', html.includes('这条是端到端检查发出去的'))
  check('发送之后输入框是空的（清空立刻 ✓）', !/id="input"[^>]*>这条是端到端检查发出去的</.test(html))

  /**
   * ─────────── ★★ markdown 渲染（本单的主场 ✓）───────────
   *
   * ★★ 判据一律是**元素** ✗，不是文本 ✓：真文档里写了 `# 标题` ✓ ⇒ DOM 里必须真有 `<h1>` ✓。
   *   「文本里出现了 `# 标题` 的原文」在**旧行为**（`textContent`）下同样成立 ✓
   *   ⇒ 那种判据是**假的** ✓（本项目今天栽过的那一类 ✓）。
   * ★ 每一条的期望值都是**从那份真文档机械推出来的** ✓（不是手抄的 ✓）。
   */
  const mdBlock = agentBlockByChars(html, MD_DOC.length)
  check(
    '★★ 夹具自检：真 markdown 文档那条助手事件**画出来了**（按 `data-text-chars` 定位 ✓）',
    mdBlock.length > 0,
    `文档 ${MD_DOC.length} 字｜切到 ${mdBlock.length} 字`,
  )
  check(
    '★★ 真 markdown 的**标题**渲染成了元素（文档里有「# 」/「## 」⇒ DOM 里真有 `<h1>` / `<h2>` ✓）',
    /<h1[ >]/.test(mdBlock) && /<h2[ >]/.test(mdBlock),
    `文档里有 ${MD_H_COUNT} 行标题｜DOM 里 <h1> ${(mdBlock.match(/<h1[ >]/g) ?? []).length} 个`,
  )
  check(
    '★★ 真 markdown 的**粗体 / 行内代码**渲染成了元素（`<strong>` / `<code>` 计数 ✓ —— 不是看文本 ✓）',
    (mdBlock.match(/<strong[ >]/g) ?? []).length > 0 && (mdBlock.match(/<code[ >]/g) ?? []).length > 0,
    `<strong> ${(mdBlock.match(/<strong[ >]/g) ?? []).length} 个｜<code> ${(mdBlock.match(/<code[ >]/g) ?? []).length} 个`,
  )
  check(
    '★★ 真 markdown 的**围栏代码块**渲染成了 `<pre class="dshm-md-code"><code>`（里面就是那份文档的第一行命令 ✓）',
    mdBlock.includes('<pre class="dshm-md-code">') && mdBlock.includes(escapeHtml(MD_FENCE_FIRST_LINE)),
    `期望第一行=${JSON.stringify(MD_FENCE_FIRST_LINE.slice(0, 48))}`,
  )
  check(
    '★★ 真 markdown 的**列表**渲染成了元素（文档里 N 条有序项 ⇒ DOM 里真有 `<ol>` + `<li>` ✓）',
    /<ol[ >]/.test(mdBlock) && (mdBlock.match(/<li[ >]/g) ?? []).length >= MD_OL_COUNT,
    `文档里 ${MD_OL_COUNT} 条有序项｜DOM 里 ${(mdBlock.match(/<li[ >]/g) ?? []).length} 个 <li>`,
  )
  check(
    '★ 真 markdown 的**表格**渲染成了 `<table>`（真文档里确实有表 ✓）',
    /<table[ >]/.test(mdBlock) && /<th[ >]/.test(mdBlock),
  )

  /**
   * ─────────── ★ 公式与**不可信输入**（探针那条 ✓ —— 见 PROBE_MD 的说明 ✓）───────────
   *
   * ★ 公式那一档的读数**以实测为准** ✗：只读探针量到的是
   *   `<span class="dshm-md-math" data-dshm-math="ready">` 里套 **Temml 画出的 `<math>`** ✓
   *   （`packages/host/lib/boot.js` 里内联了 Temml ✓，所以这一档在验收页上是真能画出来的 ✓）。
   */
  const probeBlock = agentBlockByChars(html, PROBE_MD.length)
  check(
    '★★ 夹具自检：探针那条（公式 + 不可信输入）画出来了 ✓',
    probeBlock.length > 0,
    `探针 ${PROBE_MD.length} 字｜切到 ${probeBlock.length} 字`,
  )
  check(
    '★★ 公式渲染出了**数学节点**（`$…$` ⇒ `.dshm-md-math` ✓，而且 Temml 真画出了 `<math>` ✓）',
    (probeBlock.match(/dshm-md-math/g) ?? []).length >= PROBE_MATH_COUNT &&
      probeBlock.includes('data-dshm-math="ready"') && probeBlock.includes('<math'),
    `数学节点 ${(probeBlock.match(/dshm-md-math/g) ?? []).length} 个（期望 ≥${PROBE_MATH_COUNT}）｜状态=${(probeBlock.match(/data-dshm-math="([a-z]+)"/) ?? [])[1] ?? '(无)'}`,
  )
  check(
    '★★ 不可信输入**没有变成元素**（`<img …>` 只以**转义文字**出现 ✓ —— 一个 `<img>` 元素都不许有 ✓）',
    !/<img[ >/]/.test(html) && !probeBlock.includes('<script') &&
      textVisible(probeBlock, '<img src=x onerror="alert(1)">') &&
      textVisible(probeBlock, '<script>alert(3)</script>'),
    `页面里 <img> 元素 ${(html.match(/<img[ >/]/g) ?? []).length} 个｜原文以文字可见=${textVisible(probeBlock, '<img src=x onerror="alert(1)">')}`,
  )
  check(
    '★★ `javascript:` 链接**没有**变成可点的 href（降级成纯文本 ✓ —— 渲染器自己的规矩 ✓）',
    !/href="javascript:/i.test(html) && probeBlock.includes('链接协议不被允许'),
    `页面里 href="javascript:…" 出现 ${(html.match(/href="javascript:/gi) ?? []).length} 次`,
  )

  /**
   * ─────────────── 输入栏：1:1 复刻 DSH 手机端（本单新增 ✓）───────────────
   *
   * ## 为什么把这些放在**这个脚本**里
   *
   * 这一块的几何是"输入栏长成什么样"那一半事实的**唯一**可判据点 ✓：
   *   · 圆角 / 占满宽度 / 两颗小圆按钮的直径与位置 / 发送键是不是圆的 /
   *     状态条在不在输入框正下方 / 安全区有没有被算两遍 ✓。
   * ★ 只钉**几何与存在性** ✗ —— "好不好看"归用户看 ✓（本仓纪律：观感不进断言 ✓）。
   * ★ 参照读数来自无头 Chrome 打在真 `/mobile/app` 上的实测（412×915、dpr2 ✓）：
   *   卡片圆角 22px ✓、两颗小工具键 28×28 ✓（`border-radius:999px` ✓）、
   *   发送键 34×34 ✓ 浅蓝 `rgb(103,158,254)` ✓ —— 见交付说明第 1 节 ✓。
   *
   * ★★ 两条**只许换口径、不许放松** ✗ 的地方写在各自那条断言旁边 ✓。
   */
  const geometryError = (html.match(/data-e2e-geometry-error="([^"]*)"/) ?? [])[1] ?? ''
  const geometryRaw = decodeURIComponent((html.match(/data-e2e-geometry="([^"]*)"/) ?? [])[1] ?? '')
  let g = null
  try { g = geometryRaw.length > 0 ? JSON.parse(geometryRaw) : null } catch (error) { g = null }
  /** ★ 夹具把页面里的 JS 错误画在 `#fixture-errors` 上 ✓ —— 出问题时**先念它** ✗（不然只剩猜 ✓）。 */
  const fixtureErrors = (html.match(/id="fixture-errors"[^>]*>([^<]*)</) ?? [])[1] ?? ''
  console.log('    \u2500\u2500 \u8bca\u65ad\uff1a\u771f\u4e8b\u4ef6\u5230\u4e86\u5417 data-text-chars \u51fa\u73b0 ' + ((html.match(/data-text-chars=/g) ?? []).length) + ' \u6b21\uff5c\u6c14\u6ce1 ' + ((html.match(/class="bubble"/g) ?? []).length) + ' \u4e2a\uff5cdata-e2e-fixture=' + ((html.match(/data-e2e-fixture="(-?\d+)"/) ?? [])[1] ?? '-'))
  /**
   * ★★ 这一行原来是 `JSON.stringify({ strip: gv.strip, … }) + ' ｜ tabs.y=' + (tb?.barRect?.y) + …` ✗
   *   —— 而 `gv` 在**下面**才声明（第 1206 行 ✓）、`tb` 更要等到标签栏那一节（第 1344 行 ✓）
   *   ⇒ `let/const` 的**死区**当场 `ReferenceError` ✓ ⇒ ★ **整套件跑到这里就崩** ✗
   *   （另一单 11:00:00 写进去的 ✓，我 11:00:1x 跑验收时正好踩上 ✓）。
   * ★ 处置：这一行改成只念**已经拿到的** `g` ✓；`tabs` 那两样**挪到 `tb` 解析之后**去念 ✓
   *   （见标签栏那一节开头的同名诊断 ✓）—— ★ 一个读数都没少 ✗，只是换了个地方念 ✓。
   */
  console.log('    \u2500\u2500 \u8bca\u65ad\uff1ageometry=' + JSON.stringify({ strip: g?.strip, stripText: g?.stripText, card: g?.card, composer: g?.composer, vh: g?.vh }))
  check(
    '夹具自检：输入栏几何读数拿到了（本来没有的话下面全是空转 ✓）',
    g !== null && geometryError === '',
    `夹具错误=${geometryError || '(无)'}｜页面 JS 错误=${fixtureErrors || '(无)'}`,
  )
  const gv = g ?? {}
  const card = gv.card ?? null
  const tools = Array.isArray(gv.tools) ? gv.tools : []
  const send = gv.send ?? null
  const stripBox = gv.strip ?? null
  const homeBox = gv.home ?? null
  const composerBox = gv.composer ?? null

  /**
   * ① 大圆角、占满宽度、两边留**统一**边距（= 视口宽 − 2×14 ✓）。
   *    ★ 边距那条用关系式写 ✗（这个夹具跑在 Chrome 默认窗口宽上 ✓，写死像素会假红 ✓）。
   */
  check(
    '★ 输入框：大圆角卡片（22px）+ 占满宽度（两边各留 14px）',
    gv.cardRadius === '22px' && card !== null && Math.abs(card.x - 14) <= 1 && Math.abs(card.w - (gv.vw - 28)) <= 2,
    `圆角=${gv.cardRadius}｜卡片 x=${card?.x} w=${card?.w}｜视口 ${gv.vw}`,
  )
  /** ② 占位语**照抄真图**（文案一个字都不许改 ✗）。 */
  check(
    '★ 输入框占位语照真图（发消息或创建任务，/ 调用指令，@ 文件或对话）',
    gv.placeholder === '发消息或创建任务，/ 调用指令，@ 文件或对话',
    `读到 ${JSON.stringify(gv.placeholder)}`,
  )
  /** ③ 左下**两颗**小圆按钮：都在卡片左半边、直径相等且 = 28、全圆。 */
  check(
    '★ 左下两颗小圆按钮：数量 2、全圆、直径 = 卡片高的 28×28、都在卡片左半边',
    gv.toolCount === 2 && gv.toolRadius === '999px' && tools.length === 2 &&
      tools.every((b) => b.w === tools[0].w && b.h === tools[0].h && b.w >= 24 && b.w <= 32) &&
      tools.every((b) => b.x < (card?.x ?? 0) + (card?.w ?? 0) / 2),
    `数量=${gv.toolCount}｜圆角=${gv.toolRadius}｜尺寸=${tools.map((b) => b.w + '×' + b.h).join('、')}`,
  )
  /** ④ 两颗按钮都要**念得出名字**（只做长相，但名字不能没有 ✓）。 */
  check(
    '★ 两颗小圆按钮各自有可念的名字（命令行 / 添加附件）',
    Array.isArray(gv.toolLabels) && gv.toolLabels[0] === '命令行' && gv.toolLabels[1] === '添加附件',
    `读到 ${JSON.stringify(gv.toolLabels)}`,
  )
  /**
   * ⑤ 右侧大圆发送键：**圆形**（不是方块 ✗）。
   *    ★★ 口径不许放松 ✗：判据是"宽高相等且 border-radius 是 999px" ✓ ——
   *      把它改回方块（`border-radius:12px`、宽 62 高 38 ✓）时这一条**必须红** ✓（已做变异验证 ✓）。
   */
  check(
    '★ 发送键：圆形（宽高相等、border-radius 999px）+ 贴着卡片右内缘',
    gv.sendRadius === '999px' && send !== null && Math.abs(send.w - send.h) <= 1 && send.w >= 30 && send.w <= 40 &&
      (card === null || send.right <= card.right) && (card === null || send.right >= card.right - 20),
    `圆角=${gv.sendRadius}｜尺寸=${send?.w}×${send?.h}｜send.right=${send?.right} vs card.right=${card?.right}`,
  )
  /** ⑥ 发送键里是**箭头**（原来是方块文字「发送」✗）。 */
  check(
    '★ 发送键里是箭头（svg 真的有尺寸），平时不显示那行字',
    gv.sendIcon !== null && gv.sendIcon.w > 8 && gv.sendIcon.h > 8 && (gv.sendLabel === '' || gv.sendLabel === null),
    `图标=${gv.sendIcon?.w}×${gv.sendIcon?.h}｜那行字=${JSON.stringify(gv.sendLabel)}`,
  )
  /**
   * ⑦ ★★ 这一趟**没有投影数据**（轮询那条路 ✓，`mobile/dsh/read` 的 `values` 谁也没读 ✓）
   *   ⇒ 按本单那条铁律：**四格全取不到 ⇒ 整条不占高度** ✗ —— 所以这一档量的是**塌陷** ✓。
   *
   * ★ 为什么把原来那条"位置 + 字号 11px"搬走了 ✗：这条口径换过之后，这一趟里状态条
   *   `display:none`（`getBoundingClientRect()` 恒 `0×0` ✓）⇒ 在这里量高度/位置是**在量空气** ✓
   *   （那正是 `ui.js` 里那段注释说的"空串会让这一条塌成 0 高 ⇒ 几何就量不到了"✓）。
   *   ⇒ 几何那条**搬到有投影的那一档**去量 ✓（见下面「四格 · 已知投影」那一节 ✓）——
   *     口径只换地方、**没放松** ✗（那里量的是真高度 22px ±2 ✓，比原来更硬 ✓）。
   */
  check(
    '★★ 投影取不到 ⇒ 状态条**整条塌陷**（display:none、高 0 —— 那 22px 的空带不许在 ✓）',
    gv.stripDisplay === 'none' && stripBox !== null && stripBox.h === 0 && gv.stripHidden === true,
    `display=${gv.stripDisplay}｜hidden=${gv.stripHidden}｜盒=${JSON.stringify(stripBox)}`,
  )
  /**
   * ⑧ ★★ 塌陷时**四格一个都不许画** ✗ —— 也不许留"0 轮"这种**编出来的**数 ✓。
   *
   * ★★ 这一条的**口径是换过的** ✓（原来要求"文本非空、且没有 `%`"✓）：数据面已经通了 ✓
   *   （桥把三个投影带进了 `values` ✓，另一单 ✓）⇒ 旧口径的两半**都反了** ✓：
   *   现在正确的行为是**空**（取不到就不画 ✓），而不是"非空 + 不许有百分比"✗。
   *   ⇒ 换成"**一格都没有** + 条上没有任何四格的字面"✓（更严 ✓，不是放松 ✗）。
   * ★ 反向打红：把 `statsCells` 里任何一处"取不到就补 0"打开 ⇒ 这条必红 ✓（已做变异 ✓）。
   */
  check(
    '★★ 塌陷时**四格一个都不画**（0 格 / 0 个分隔符 / 没有任何「N 轮」「N 步」「tok」「%」✓）',
    gv.stripCells !== null && gv.stripCells.length === 0 && gv.stripSeps === 0 &&
      typeof gv.stripText === 'string' && !/[0-9]+\s*(轮|步|tok)|%/.test(gv.stripText),
    `格数=${gv.stripCells?.length}｜分隔符=${gv.stripSeps}｜文本=${JSON.stringify(gv.stripText)}`,
  )
  /**
   * ⑨ 安全区**只算一次**（这是本项目花钱最多的一条 ✓）：
   *    输入栏底边 + 安全区那条 = 视口底边 ✓ —— 两处都算安全区就会多出一条空带 ✓。
   */
  check(
    '★ 安全区只算一次：输入栏底边 + 安全区（homebar）高 = 视口高',
    homeBox !== null && composerBox !== null && homeBox.h > 0 &&
      Math.abs(composerBox.bottom + homeBox.h - gv.vh) <= 1 &&
      Math.abs(homeBox.bottom - gv.vh) <= 1,
    `输入栏底=${composerBox?.bottom} homebar=${homeBox?.h} 视口高=${gv.vh}`,
  )
  /**
   * ⑩ ★★ 键盘让位**只引壳那一个变量** ✗（源码口径 ✓）——
   *    "自己再算一套 visualViewport" 正是当年删掉的旧写法 ✗，
   *    它会让 `adjustResize` 的壳把让位算两遍 ✓（变异验证过 ✓）。
   *    ★ 判据要**先去掉注释** ✗：这段 CSS 的注释里正好写着"绝不用 visualViewport"✓
   *      （不去注释就是自己把自己判红 ✓）。
   */
  const cssNoComments = readFileSync(join(ASSETS, 'theme.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
  check(
    '★★ 键盘让位只用壳那份（var(--dshm-keyboard-pad, var(--dshm-keyboard, 0px))），且**没有**自己算 visualViewport',
    cssNoComments.includes('var(--dshm-keyboard-pad, var(--dshm-keyboard, 0px))') &&
      !cssNoComments.includes('visualViewport') && !cssNoComments.includes('vv.height'),
  )
  /**
   * ⑪ ★★ 安全区**不许写死** ✗（原来 `.homebar { height: 22px }` 就是写死的 ✓）——
   *    要用 `max(env(safe-area-inset-bottom, 0px), var(--dshm-gesture-bottom, 22px))` ✓
   *    （`boot.js:68` 那条本仓口径 ✓）。
   */
  check(
    '★★ 安全区不写死：homebar 高走 max(env(safe-area-inset-bottom,0px), var(--dshm-gesture-bottom,22px))',
    cssNoComments.includes('max(env(safe-area-inset-bottom, 0px), var(--dshm-gesture-bottom, 22px))') &&
      !/\.homebar\s*\{[^}]*height:\s*22px/.test(cssNoComments),
  )

  /**
   * ─────────── ★★ 标签栏「对话｜轨迹」（复刻清单第 3 项 ✓）───────────
   *
   * ## 参照读数从哪来 ✗（★ 写清楚，别把两路取证混成一路 ✓）
   *
   * · ① **真机读数**：隔离无头 Chrome + 移动视口（412×915 dpr2 ✓）打在 **DSH 自己的页**上，
   *   用 `getBoundingClientRect` / `getComputedStyle` 量那条标签栏 ✓ —— 逐条见报告第 1 节 ✓；
   * · ② **源码印证**：`app.asar` ⇒ `@deepseek-ai/dsh-client-ui-conversation/lib/client.js`
   *   里那条**未压缩的 CSS 原文** ✓（`.…_tabs` / `.…_tab` / `.…_tab:after` / `.…_tabActive` ✓）——
   *   几何与色值的**逐字**出处都在那里 ✓。
   *
   * ## 这一组断言为什么这么写 ✗
   *
   * 「点了轨迹」这件事**不能**用"按钮变了色"当判据 ✓（那是观感 ✓）；
   * 判据必须是**换了一屏**：轨迹层从 `display:none` 变成真的排出来 ✓、
   * 而对话层被藏起来 ✓ —— 两条都要成立 ✓（只查一条的话，"两层叠在一起"会静默通过 ✗）。
   */
  const tabsError = (html.match(/data-e2e-tabs-error="([^"]*)"/) ?? [])[1] ?? ''
  const tabsRaw = decodeURIComponent((html.match(/data-e2e-tabs="([^"]*)"/) ?? [])[1] ?? '')
  let tb = null
  try { tb = tabsRaw.length > 0 ? JSON.parse(tabsRaw) : null } catch (error) { tb = null }
  /** ★ 这一行就是原来那条 `tabs.y=… tabs.before=…` 诊断 ✓（挪到 `tb` 真的解析出来之后 ✓）。 */
  console.log('    \u2500\u2500 \u8bca\u65ad\uff1atabs.y=' + (tb?.barRect?.y) + ' tabs.before=' + JSON.stringify(tb?.before))
  check(
    '夹具自检：标签栏读数拿到了（本来没有的话下面全是空转 ✓）',
    tb !== null && tabsError === '',
    `夹具错误=${tabsError || '(无)'}`,
  )
  const tv = tb ?? {}
  const tabBtns = Array.isArray(tv.btns) ? tv.btns : []
  const barRect = tv.barRect ?? null
  const beforeChat = tv.before?.chat ?? null
  const beforeTrace = tv.before?.trace ?? null
  const afterChat = tv.after?.chat ?? null
  const afterTrace = tv.after?.trace ?? null

  /** ① 两颗标签**存在**、字面就是「对话」「轨迹」✓、`role=tab` ✓。 */
  check(
    '★★ 标签栏两颗标签存在且字面就是「对话」「轨迹」（`role=tab` + 可念的名字 ✓）',
    tv.barFound === true && tv.barRole === 'tablist' && tv.btnCount === 2 &&
      tabBtns[0]?.text === '对话' && tabBtns[1]?.text === '轨迹' &&
      tabBtns[0]?.id === 'tab-chat' && tabBtns[1]?.id === 'tab-trace',
    `角色=${tv.barRole}｜颗数=${tv.btnCount}｜字面=${JSON.stringify(tabBtns.map((b) => b.text))}`,
  )
  /**
   * ② ★★ **默认选中「对话」** ✓ —— 判两处，缺一不可 ✗。
   *
   * ## ★ 为什么一处不够 ✗（本轮**变异验证**逼出来的 ✓）
   *
   * 我第一版只判运行时读数（`aria-selected` + 两层的 `hidden` ✓）。
   * 然后把 `page.html` 里两颗标签的默认标记**对调**（让「轨迹」一开场就是选中 ✓）——
   * **它没红** ✗！原因很实在 ✓：`mountChat` 里那句 `showView('chat')` 是**开场就重写一遍** ✓
   * ⇒ 运行时读数永远是对的 ✓（**不管 HTML 里写的是什么** ✗）。
   * ⇒ 那条断言当时只证明了"JS 兜住了"✓，**没**证明"HTML 标记是对的"✗ ——
   *   而 HTML 标记**真的有后果** ✗：`.tab::after` 的底色默认是 `transparent` ✓，
   *   下划线只认 `.is-active` ✓ ⇒ 标记写错的那一瞬（脚本还没跑完）屏幕上**没有指示条** ✓。
   *
   * ⇒ 补齐：**HTML 源头**（字面 `class="tab is-active"` + `aria-selected="true"` 只能在「对话」那颗上 ✓）
   *   **和**运行时读数（两句都对 ✓）一起判 ✓ —— 任一处写反 ⇒ 这条红 ✓。
   */
  const PAGE_HTML_TEXT = readFileSync(join(ASSETS, 'page.html'), 'utf8')
  /** 从**源头**取某颗标签的标记 ✓（`<button … id="tab-chat" …>` 那一段 ✓）。 */
  const tabSourceTag = (id) => (PAGE_HTML_TEXT.match(new RegExp('<button[^>]*id="' + id + '"[^>]*>')) ?? [])[0] ?? ''
  const sourceChatTag = tabSourceTag('tab-chat')
  const sourceTraceTag = tabSourceTag('tab-trace')
  check(
    '★★ 默认选中「对话」（★ **HTML 源头 + 运行时**两处一起判 ✓ —— 只判运行时会被 JS 兜住 ⇒ 假绿 ✓）',
    tabBtns[0]?.selected === 'true' && tabBtns[1]?.selected === 'false' &&
      beforeChat?.hidden === false && beforeTrace?.hidden === true &&
      sourceChatTag.includes('is-active') && sourceChatTag.includes('aria-selected="true"') &&
      !sourceTraceTag.includes('is-active') && sourceTraceTag.includes('aria-selected="false"'),
    `运行时 aria-selected=${JSON.stringify(tabBtns.map((b) => b.selected))}｜对话层 hidden=${beforeChat?.hidden}｜轨迹层 hidden=${beforeTrace?.hidden}｜源头 对话=${JSON.stringify(sourceChatTag.slice(0, 120))}｜轨迹=${JSON.stringify(sourceTraceTag.slice(0, 120))}`,
  )
  /**
   * ③ ★★ **点「轨迹」⇒ 真的切过去** ✗（这一条就是"不许只做样子"✓）。
   *
   * 判据三样一起 ✓：轨迹层**从没排到排**（display 变了 ✓）、对话层被藏起来 ✓、
   * 而 `aria-selected` 跟着换 ✓。★ 缺任何一样都说明"切换"没真的发生 ✓。
   * ★ 变异：把两颗标签的 `click` 监听删掉 ⇒ 这一条必须红 ✓（已做 ✓）。
   */
  check(
    '★★ 点「轨迹」真的切过去了：轨迹层从 display:none 变成真排出来、对话层被藏起来（换了一屏 ✓）',
    beforeTrace?.display === 'none' && afterTrace?.display !== 'none' &&
      afterTrace?.hidden === false && afterChat?.hidden === true &&
      Array.isArray(tv.selectedAfterClick) && tv.selectedAfterClick[1] === 'true' && tv.selectedAfterClick[0] === 'false',
    `轨迹层 ${beforeTrace?.display} → ${afterTrace?.display}｜对话层 hidden=${beforeChat?.hidden} → ${afterChat?.hidden}｜aria-selected=${JSON.stringify(tv.selectedAfterClick)}`,
  )
  /** ④ ★ 轨迹视图的内容 = **同一批事件的另一条渲染路** ✓（复用 `classify`/`renderEvent` ✓）。 */
  check(
    '★ 轨迹视图摊开的是 `step` / `tool` 那类事件（对话层里的用户气泡**不该**跟过来 ✓）',
    tv.traceSteps >= 1 && tv.traceHasStep === true && tv.traceHasUser === false,
    `轨迹层 .ev ${tv.traceSteps} 条｜有 ev-step=${tv.traceHasStep}｜有 ev-user=${tv.traceHasUser}`,
  )
  /**
   * ⑤ ★★ 徽标：**没有子智能体来源 ⇒ 一个徽标都不画** ✗。
   *
   * ★ 为什么是"判它不在"而不是"判它在" ✗（★ 报告第 2 节会写全 ✓）：
   *   子智能体的会话**到不了这一页** —— 桥在 `normalizeSessions` 里就按
   *   `origin === 'subagent'` 滤掉了 ✓（`dsh-chat-bridge.ts:458` ✓），事件里也没有 `origin` ✓。
   *   ⇒ 页面数不到 ⇒ 按纪律**宁可不画**✓、**绝不编一个恒为 0 的徽标** ✗。
   * ★ 这条**能被打红** ✓：只要有人加一个 `.tab-badge` 元素（哪怕写死 0 ✓）就红 ✓。
   */
  check(
    '★★ 徽标：数据到不了这一页 ⇒ **一个徽标都不画**（写了就是编数据 ✓ —— 加了 .tab-badge 必红）',
    tv.badgeCount === 0,
    `标签栏里的徽标元素 ${tv.badgeCount} 个`,
  )
  /**
   * ⑥ ★★ 几何：标签栏的**高度 / 位置 / 两颗标签的字号字重间距**与真值一致到 ±2px ✓。
   *
   * 真值有两路来源 ✓（见本节开头 ✓），逐项：
   *   · 标签栏高 **27** ✓ = 标签高 25（行高 16 + 下内边距 9 ✓）+ 2（指示条压在底线下面 1px ✓）；
   *   · 字号 **13px** / 字重 **500** / 行高 **16px** / 下内边距 **9px** ✓；
   *   · 两颗标签间距 **36px** ✓、左缩进 **8px** ✓；
   *   · 指示条 **2px** 高、**2px** 圆角、`bottom:-1px` ✓ —— 选中那颗才有底色 ✓。
   * ★ 位置那条用**关系式**写 ✗（夹具跑在默认窗口宽上 ✓，写死 x 会假红 ✓）：
   *   标签栏在页头**正下方**（`bar.top >= header.bottom - 2` ✓）且**在消息区上方** ✓。
   */
  const tab0 = tabBtns[0] ?? null
  const tab1 = tabBtns[1] ?? null
  check(
    '★★ 标签栏几何照真值 ±2px（高 25 / 字号 13 / 字重 500 / 行高 16 / 下内边距 9 / 间距 36 / 左缩进 28 / 指示条 2px+圆角2px）',
    barRect !== null && Math.abs(barRect.h - 25) <= 2 &&
      Math.abs(Number.parseFloat(tv.barGap ?? '0') - 36) <= 2 &&
      Math.abs(Number.parseFloat(tv.barPaddingLeft ?? '0') - 28) <= 2 &&
      Math.abs((tab0?.rect?.x ?? -99) - 28) <= 2 &&
      tab0?.fontSize === '13px' && tab0?.fontWeight === '500' && tab0?.lineHeight === '16px' &&
      tab0?.paddingBottom === '9px' && tab1?.afterHeight === '2px' &&
      tab1?.afterRadius === '2px' && tab1?.afterBottom === '-1px',
    `高=${barRect?.h}（真机也是 25）｜gap=${tv.barGap}｜padding-left=${tv.barPaddingLeft}｜首颗 x=${tab0?.rect?.x}（真值 28 = 侧栏轨道 20 + 源码 8）｜字号=${tab0?.fontSize}/${tab0?.fontWeight}/${tab0?.lineHeight}｜下内边距=${tab0?.paddingBottom}｜指示条=${tab1?.afterHeight} r=${tab1?.afterRadius} bottom=${tab1?.afterBottom}`,
  )
  /**
   * ⑨ ★★ 两颗标签的**实测位置**与真机截图逐像素对上 ✓
   *   （`docs/ui/08-conversation.png` ✓ —— 824×1830 @dpr2 ✓，量法见 `theme.css` 里那张表 ✓）。
   *
   * 真机读数：选中那颗 **28..53.5** ✓、未选中那颗文字从 **90.5** 起 ✓
   * ⇒ 首颗左沿 **28±2** ✓、两颗**文字左沿差 62±3** ✓。
   * ★ 这两条与上面那条**不是重复** ✗：上面判的是 CSS 声明值 ✓，这条判的是**排出来的盒子** ✓
   *   —— 字体/字距一变，声明值照样对、位置就偏了 ✓（而这正是"1:1"里唯一可判定的那一半 ✓）。
   */
  check(
    '★★ 两颗标签的实测位置照真机截图 ±2px（首颗左沿 28 ✓、第二颗比它右 62 ✓）',
    tab0 !== null && tab1 !== null &&
      Math.abs(tab0.rect.x - 28) <= 3 && Math.abs((tab1.rect.x - tab0.rect.x) - 62) <= 3,
    `首颗 x=${tab0?.rect?.x}（真值 28）｜第二颗 x=${tab1?.rect?.x}（真值 90.5 ⇒ 差 62）｜实测差=${tab1 === null || tab0 === null ? '-' : tab1.rect.x - tab0.rect.x}`,
  )
  /** ⑦ ★ 位置：在**页头下面**（不是上面 ✗）、且在消息区之上 ✓。 */
  check(
    '★ 标签栏在页头**正下方**（不是页头上面 ✓）、高度不吃掉消息区（≤ 底栏的 1/3 ✓）',
    tv.headerRect !== null && barRect !== null && composerBox !== null &&
      barRect.y >= tv.headerRect.bottom - 2 &&
      barRect.bottom <= (composerBox.y ?? 0) &&
      barRect.h <= (composerBox.y ?? 0) / 3,
    `页头底=${tv.headerRect?.bottom}｜标签栏 y=${barRect?.y} bottom=${barRect?.bottom}｜输入栏 y=${composerBox?.y}`,
  )
  /**
   * ⑧ ★★ 切到轨迹以后**输入栏那一层一个像素都没动** ✓、也没有被挤出视口 ✓ ——
   *   "切一屏把输入栏顶掉"是这一单最容易犯、也最难看的错 ✓。
   *
   * ★ 判据取 `#composer`（稳的那一层 ✓），不取里面那张卡片 ✓ ——
   *   卡片高度跟着 textarea 自己长 ✓（见夹具里那段说明 ✓）。
   */
  const composerBefore = tv.composerBefore ?? null
  const composerAfter = tv.inputVisibleAfter?.composer ?? null
  check(
    '★★ 切到轨迹后输入栏**那一层**不动（底边仍在视口内、与切之前逐像素同一位置 ✓）',
    composerBefore !== null && composerAfter !== null &&
      composerBefore.y === composerAfter.y && composerBefore.h === composerAfter.h &&
      composerBefore.bottom === composerAfter.bottom &&
      composerAfter.bottom <= (tv.inputVisibleAfter?.vh ?? 0),
    `切之前 ${JSON.stringify(composerBefore)}｜切之后 ${JSON.stringify(composerAfter)}｜视口高=${tv.inputVisibleAfter?.vh}`,
  )

  /**
   * ─────────── ★★ 四格状态条 · **已知投影**那四档（本单的主场 ✓）───────────
   *
   * ## 判据为什么必须长这样 ✗（三条"假判据"都是这里最容易犯的 ✓）
   *
   * 1. ★ **"页面里有 `%` 这个字符"不算"百分比是对的"** ✗ —— 判据是那一格的
   *    `[data-cell, 文本]` **逐字**等于**从夹具机械推出来**的期望 ✓；
   * 2. ★ **"有四个格子"不算"缺格不画"** ✗ —— 所以专门有 `nopressure` / `missingturns`
   *    两档 ✓（键不在 ⇒ **那一格连元素都不该有** ✓，而不是画一个 `0%` / `0 轮` ✗）；
   * 3. ★ **"取不到就不画"也不许反过来伤到真实数据** ✗ —— 所以有 `zeroturns`
   *    （`turns: 0` ⇒ 必须**照显示** `0 轮` ✓）。
   *
   * ## 这一节的四趟怎么跑（★ 都必须走**流** ✗）
   *
   * 四格的数据只有开场快照带得下来 ✓ ⇒ 夹具挂了 `openStream` ✓（见 `FAKE_BOOT` 里那段 ✓）——
   * ★ 于是这四趟**顺带**在验"真机那条取数路"（流 ✓）上这四格是对的 ✓，
   *   而**不是**在一个只有夹具才有的旁路上 ✓。
   */
  console.log('\n── ★★ 四格状态条：已知投影夹具（逐字 / 缺格不画 / 真实 0）──')
  check(
    '★★ 夹具自检：四个已知投影**机械推出**的四格 = 设计目标（`45%` / `488 轮` / `2525 步` / `1062M tok` ✓ —— 目标字面与夹具数是同一条链 ✓）',
    JSON.stringify(expectedCells('full')) ===
      JSON.stringify([['context', '45%'], ['turns', '488 轮'], ['steps', '2525 步'], ['tokens', '1062M tok']]),
    `机械推出=${JSON.stringify(expectedCells('full'))}`,
  )
  check(
    '★★ 夹具自检：`nopressure` 档的 `values` 里**真的没有** `contextPressure` 这个键（否则下面那条是空转 ✓）',
    !('contextPressure' in PROJ_FIXTURES.nopressure.values) && PROJ_FIXTURES.full.values.contextPressure !== undefined,
  )
  check(
    '★★ 夹具自检：`missingturns` 档的 `sessionStats` 在、但**真的没有** `turns`（★ 不是 null、不是 0 ✓）',
    PROJ_FIXTURES.missingturns.values.sessionStats !== undefined &&
      !('turns' in PROJ_FIXTURES.missingturns.values.sessionStats) &&
      PROJ_FIXTURES.missingturns.values.sessionStats.steps !== undefined,
  )
  check(
    '★★ 夹具自检：`zeroturns` 档给的是**真实的 0**（`turns === 0` ✓ —— 不是缺键 ✓）',
    PROJ_FIXTURES.zeroturns.values.sessionStats.turns === 0,
  )

  /** 跑一档已知投影 ✓（走流 ✓、读数在 `data-e2e-geometry` 上 ✓）。 */
  const projRuns = {}
  for (const name of ['full', 'nopressure', 'missingturns', 'zeroturns']) {
    const dom = await dumpDom(`${base}/mobile/chat?phase=sent&fetch=stream&proj=${name}&probe=1200`, 'data-e2e-tabs=', 40_000)
    const raw = decodeURIComponent((dom.match(/data-e2e-geometry="([^"]*)"/) ?? [])[1] ?? '')
    let geo = null
    try { geo = raw.length > 0 ? JSON.parse(raw) : null } catch (error) { geo = null }
    projRuns[name] = { dom, geo }
  }
  const runGeo = (name) => projRuns[name]?.geo ?? null
  const runCells = (name) => {
    const cells = runGeo(name)?.stripCells
    return Array.isArray(cells) ? cells : null
  }
  const runStripText = (name) => {
    const text = runGeo(name)?.stripText
    return typeof text === 'string' ? text : ''
  }

  // ── 档 ①：`full`（四格逐字 ✓ + 那个环 ✓ + 高/位置/字号 ✓）──────────────
  const fullGeo = runGeo('full')
  check(
    '★★ 夹具自检：`proj=full` 这一档**真的**走的是流、且四格读数拿到了（否则下面全是空转 ✓）',
    fullGeo !== null && projRuns.full.dom.includes('data-e2e-fetch="stream"') &&
      Array.isArray(fullGeo.stripCells) && fullGeo.stripCells.length === 4,
    `fetch=${(projRuns.full.dom.match(/data-e2e-fetch="([^"]*)"/) ?? [])[1] ?? '(没有)'}｜格数=${fullGeo?.stripCells?.length}｜文本=${JSON.stringify(fullGeo?.stripText)}`,
  )
  check(
    '★★ 四格**逐字**且**顺序**正确（`45%` / `488 轮` / `2525 步` / `1062M tok` ✓ —— 期望值**从夹具机械推出来** ✗，不是手抄 ✓）',
    JSON.stringify(runCells('full')) === JSON.stringify(expectedCells('full')),
    `读到=${JSON.stringify(runCells('full'))}｜期望=${JSON.stringify(expectedCells('full'))}`,
  )
  check(
    '★ 分隔符「·」的数量 = 格数 − 1（3 个 ✓ —— 跟着数据走 ✓，不是四个位置各留一个 ✓）',
    fullGeo?.stripSeps === expectedCells('full').length - 1,
    `分隔符=${fullGeo?.stripSeps}｜格数=${fullGeo?.stripCells?.length}`,
  )
  check(
    '★★ 四格**是纯展示**：这一条里**一个 `<button>` 都没有**（★ 本仓规矩：没有真实通道就别假装能点 ✗）',
    fullGeo?.stripButtons === 0,
    `这一条里的 button = ${fullGeo?.stripButtons}`,
  )
  check(
    '★★ 上下文那一格前面**真的有那个环**：14×14 / 2px 描边 / `dasharray` 与算式**逐字**相同（★ 判据不是"看见一个 `%`"✗）',
    fullGeo?.stripRing !== null && fullGeo?.stripRing !== undefined &&
      fullGeo.stripRing.viewBox === '0 0 14 14' &&
      fullGeo.stripRing.box.w === 14 && fullGeo.stripRing.box.h === 14 &&
      fullGeo.stripRing.trackStrokeWidth === '2px' && fullGeo.stripRing.fillStrokeWidth === '2px' &&
      fullGeo.stripRing.fillLinecap === 'round' &&
      fullGeo.stripRing.dash === expectedDash(expectedPercent(PROJ_FIXTURES.full.values.contextPressure)) &&
      fullGeo.stripRing.transform === 'rotate(-90 7 7)',
    `环=${JSON.stringify(fullGeo?.stripRing)}｜期望 dash=${expectedDash(expectedPercent(PROJ_FIXTURES.full.values.contextPressure))}`,
  )
  check(
    '★★ 状态条的**高度 / 字号 / 位置**照真值 ±2px（高 22 = 行高 20 + 上下各 1px ✓、字号 12px ✓、在卡片**之下**、输入栏**之内** ✓）',
    fullGeo !== null && fullGeo.stripHidden === false && fullGeo.strip !== null &&
      Math.abs(fullGeo.strip.h - 22) <= 2 && fullGeo.stripFont === '12px' && fullGeo.stripLineHeight === '20px' &&
      fullGeo.card !== null && fullGeo.composer !== null &&
      fullGeo.strip.y >= fullGeo.card.bottom - 1 && fullGeo.strip.bottom <= fullGeo.composer.bottom + 1,
    `高=${fullGeo?.strip?.h}（真值 22）｜字号=${fullGeo?.stripFont}/${fullGeo?.stripLineHeight}｜y=${fullGeo?.strip?.y} card.bottom=${fullGeo?.card?.bottom} composer.bottom=${fullGeo?.composer?.bottom}`,
  )

  // ── 档 ②：`nopressure`（缺 projection ⇒ 那一格不画 ✗，**不是** `0%` ✗）────────
  check(
    '★★ 缺整个 `contextPressure` ⇒ **没有 `%` 那一格**（★ 连元素都不在 ✗ —— 画 `0%` 就是"编数字" ✓）',
    JSON.stringify(runCells('nopressure')) === JSON.stringify([['turns', '488 轮'], ['steps', '2525 步'], ['tokens', '1062M tok']]) &&
      !runStripText('nopressure').includes('%') &&
      (runCells('nopressure') ?? []).every(([cell]) => cell !== 'context'),
    `读到=${JSON.stringify(runCells('nopressure'))}｜文本=${JSON.stringify(runStripText('nopressure'))}`,
  )
  check(
    '★ 而**其余三格照画**（缺一格不许把整条都收掉 ✗）—— 格数 3、分隔符 2、条**没有**塌陷 ✓',
    runGeo('nopressure')?.stripCells?.length === 3 && runGeo('nopressure')?.stripSeps === 2 &&
      runGeo('nopressure')?.stripHidden === false,
    `格数=${runGeo('nopressure')?.stripCells?.length}｜分隔符=${runGeo('nopressure')?.stripSeps}｜hidden=${runGeo('nopressure')?.stripHidden}`,
  )

  // ── 档 ③：`missingturns`（**字段**级缺 ⇒ 那一格不画 ✗ —— 专打"退化成 0 轮"✗）──
  check(
    '★★ `sessionStats` 里缺 `turns` ⇒ **没有「轮」那一格** ✗ —— 尤其**不许**退化成 `0 轮` ✗（★ 这一档打的是"只判投影在不在"的实现 ✓）',
    JSON.stringify(runCells('missingturns')) === JSON.stringify([['context', '45%'], ['steps', '2525 步'], ['tokens', '1062M tok']]) &&
      !runStripText('missingturns').includes('轮'),
    `读到=${JSON.stringify(runCells('missingturns'))}｜文本=${JSON.stringify(runStripText('missingturns'))}`,
  )

  // ── 档 ④：`zeroturns`（DSH 报的**真实 0** ⇒ **照显示** ✓）──────────────────
  check(
    '★★ DSH 报的**真实 0 照显示**：`turns: 0` ⇒ 那一格就是 `0 轮` ✓（★ 不许因为"0 看着像没数据"就藏起来 ✗ —— 那是另一条铁律的反面 ✓）',
    JSON.stringify(runCells('zeroturns')) === JSON.stringify(expectedCells('zeroturns')) &&
      (runCells('zeroturns') ?? []).some(([cell, text]) => cell === 'turns' && text === '0 轮') &&
      runGeo('zeroturns')?.stripHidden === false,
    `读到=${JSON.stringify(runCells('zeroturns'))}｜期望=${JSON.stringify(expectedCells('zeroturns'))}`,
  )

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

  /**
   * ── 反向：**拿不到渲染器**（老宿主 / 假 boot ✓）⇒ 正文照旧看得见，不许空白 ──
   *
   * ★ 这一趟专治"保底路径"：本单把正文改走渲染器 ✓ ⇒ 一旦渲染器**缺席**，
   *   兜底必须**摊原文** ✓（"认不出的也要看得见" ✓）。
   * ★ 变异：把兜底那条 `container.textContent = text` 删掉 ⇒ 下面第一条必红 ✓。
   */
  console.log('\n── 反向：拿不到渲染器（老宿主）⇒ 正文**照旧摊原文**，不许空白 ──')
  const noRendererSetup = await serve('no-renderer')
  const noRenderer = await dumpDom(`http://127.0.0.1:${noRendererSetup.port}/mobile/chat?phase=sent`, 'data-e2e="sent"', 40_000)
  const noRendererBoot = (noRenderer.match(/data-e2e-boot="([^"]*)"/) ?? [])[1] ?? '(没有这个读数)'
  const proseLeadPresent = noRenderer.includes(escapeHtml(REAL_PROSE.slice(0, 40)))
  check(
    '夹具自检：这一趟**确实没有**渲染器（否则下面那条是在空转 ✓）',
    noRendererBoot === 'undefined',
    `typeof renderMarkdownInto=${noRendererBoot}`,
  )
  check(
    '★ 拿不到渲染器时正文**照旧摊原文**（显示成空白必红 ✓，而且这趟**不该**有 `<strong>` ✓）',
    proseLeadPresent && !noRenderer.includes('<strong>'),
    `正文开头在不在=${proseLeadPresent}｜页面里 <strong> ${(noRenderer.match(/<strong[ >]/g) ?? []).length} 个`,
  )
  noRendererSetup.server.close()

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

  /**
   * ─────────── ★★ 几何两档：412×915 与 320×568（本单新增 ✓）───────────
   *
   * ## 为什么非要两档 ✗
   *
   * 第一趟跑在 Chrome 的**默认窗口**上（756×413 ✓ —— 又宽又矮 ✓），
   * 它证明不了"窄屏 / 正常手机屏"上的事 ✓：
   *   · **320 宽**是这一页最窄的真机档 ✓ —— 标签栏 + 满宽输入栏是否还排得下 ✓；
   *   · **915 高**才是手机的正常高度 ✓ —— 默认窗口只有 413 ✓，
   *     "标签栏会不会把输入栏挤出视口"在那上面**量不出真值** ✗。
   * ⇒ 两档各量一次 ✓（`--window-size` ✓，与输入栏那一单量真图同一条路 ✓）。
   *
   * ## 两条判据（★ 都只判**几何与不被遮挡** ✗ —— 观感归用户 ✓）
   *
   * 1. **标签栏在视口里、且在输入栏上方** ✓（没被顶出去、也没盖住输入栏 ✓）；
   * 2. ★★ **输入栏整条都在视口内** ✗（`composer.bottom <= vh` ✓ ——
   *    这正是"标签栏不许把输入栏挤出视口"那条要求的**可判定**写法 ✓）；
   *    并且消息区还剩得下地方 ✓（`main.h > 0` ✓ —— 不许被挤成 0 高 ✓）。
   */
  for (const size of ['412x915', '320x568']) {
    const [w, h] = size.split('x').map(Number)
    console.log(`\n── 几何档 ${size}（宽 ${w} / 高 ${h}）──`)
    const shot = await dumpDom(`${base}/mobile/chat?phase=sent`, 'data-e2e-tabs=', 40_000, size)
    const raw = decodeURIComponent((shot.match(/data-e2e-tabs="([^"]*)"/) ?? [])[1] ?? '')
    let g2 = null
    try { g2 = raw.length > 0 ? JSON.parse(raw) : null } catch (error) { g2 = null }
    /**
     * ★ 状态条那几样读的是**另一个属性** ✗（`data-e2e-geometry` ✓ —— 它们在 `g` 上 ✓，
     *   不在 `tabs` 上 ✓）。★ 第一次我把这两处读串了 ⇒ 两条"塌陷"断言读到 `undefined` 当场红 ✓
     *   （这正是"读数拿不到就红、不许当绿"那条 ✓）。
     */
    const rawGeo2 = decodeURIComponent((shot.match(/data-e2e-geometry="([^"]*)"/) ?? [])[1] ?? '')
    let geo2 = null
    try { geo2 = rawGeo2.length > 0 ? JSON.parse(rawGeo2) : null } catch (error) { geo2 = null }
    const bar = g2?.barRect ?? null
    const comp = g2?.composerBefore ?? null
    const vh2 = g2?.vh ?? -1
    const realVw = g2?.vw ?? -1
    check(
      `★★ [${size}] 夹具自检：这一档**真的**拿到了读数与真视口（宽 ${w} / 高 ${h} ✓）`,
      g2 !== null && realVw === w && vh2 === h && bar !== null,
      `读到视口 ${realVw}×${vh2}（期望 ${w}×${h}）`,
    )
    check(
      `★ [${size}] 标签栏在视口里、且在输入栏**上方**（没被顶出去、也没盖住输入栏 ✓）`,
      bar !== null && comp !== null &&
        bar.y >= 0 && bar.bottom <= vh2 && bar.bottom <= comp.y,
      `标签栏 y=${bar?.y} bottom=${bar?.bottom}｜输入栏 y=${comp?.y} bottom=${comp?.bottom}｜视口高 ${vh2}`,
    )
    check(
      `★★ [${size}] 输入栏**整条都在视口内**（composer.bottom <= vh ✓）、且标签栏没把它顶下去（底边仍有 ≥ 40px 让位 ✓）`,
      comp !== null && comp.h > 0 && comp.bottom <= vh2 && comp.bottom >= vh2 - 40,
      `输入栏 ${JSON.stringify(comp)}｜视口高 ${vh2}｜距底 ${comp === null ? '-' : vh2 - comp.bottom}px`,
    )
    /**
     * ★★ [本单新增] 这一档**没有投影** ⇒ 那条状态条不许占高度 ✗（在真机视口上再钉一次 ✓）——
     *   22px 的空带在 412 宽上就是"输入框底下多一条空白"✓，比在默认窗口上更该钉 ✓。
     */
    check(
      `★★ [${size}] 投影取不到 ⇒ 状态条**塌陷**（display:none、高 0 ✓ —— 不占那 22px ✓）`,
      geo2?.stripHidden === true && geo2?.stripDisplay === 'none' && (geo2?.strip?.h ?? -1) === 0,
      `hidden=${geo2?.stripHidden}｜display=${geo2?.stripDisplay}｜高=${geo2?.strip?.h}｜格数=${geo2?.stripCells?.length}`,
    )
  }

  /**
   * ─────────── ★★ 几何两档 · **四格展开档**（本单新增 ✓）───────────
   *
   * ## 为什么单开这两档 ✗
   *
   * 上面那两档里状态条是**塌陷**的 ✓（那是另一条判据 ✓）—— 而"这一条有多高、有没有被截断"
   * ★ 必须在它**真的画着四格**的时候量 ✗（否则就是在量空气 ✓ —— 本仓栽过这种"几何量到 0"✓）。
   * ⇒ 同两档（412×915 / 320×568 ✓）再跑一次，这次给**已知投影** ✓（走流 ✓）。
   *
   * ## 判据（★ 全部是几何与元素，没有一条是观感 ✗）
   *
   * 1. **四格逐字**（320 那一档与 412 那一档**都**要 ✓ —— 窄屏不许悄悄少一格 ✗）；
   * 2. **高 22 ±2px** ✓（真值 22 = 行高 20 + 上下各 1px ✓，见 `theme.css` 那一段的出处 ✓）、
   *    且在卡片之下、输入栏之内 ✓；
   * 3. ★★ **没被截断** ✗（`scrollWidth ≤ clientWidth + 1` ✓ —— "多一项就被省略号吃掉"
   *    是本仓那条紧凑条**实测栽过**的事 ✓：320 宽上四格 + 三个分隔符必须还排得下 ✓）；
   * 4. **输入栏整条仍在视口内** ✓（这一条是"状态条不许把输入栏挤出去"的可判定写法 ✓）。
   */
  for (const size of ['412x915', '320x568']) {
    const [w, h] = size.split('x').map(Number)
    console.log(`\n── 几何档 ${size} · 四格展开（已知投影 ✓）──`)
    const shot = await dumpDom(`${base}/mobile/chat?phase=sent&fetch=stream&proj=full&probe=1200`, 'data-e2e-tabs=', 40_000, size)
    const rawGeo = decodeURIComponent((shot.match(/data-e2e-geometry="([^"]*)"/) ?? [])[1] ?? '')
    let gp = null
    try { gp = rawGeo.length > 0 ? JSON.parse(rawGeo) : null } catch (error) { gp = null }
    const cells = Array.isArray(gp?.stripCells) ? gp.stripCells : null
    check(
      `★★ [${size}] 夹具自检：这一档**真的**拿到了读数、真视口（${w}×${h} ✓）与四格（走的是流 ✓）`,
      gp !== null && gp.vw === w && gp.vh === h && cells !== null && cells.length === 4 &&
        shot.includes('data-e2e-fetch="stream"'),
      `读到视口 ${gp?.vw}×${gp?.vh}（期望 ${w}×${h}）｜格数=${cells?.length}｜fetch=${(shot.match(/data-e2e-fetch="([^"]*)"/) ?? [])[1] ?? '(没有)'}`,
    )
    check(
      `★★ [${size}] 四格逐字（机械推出 ✓ —— 窄屏上也不许少一格 / 不许换字 ✓）`,
      JSON.stringify(cells) === JSON.stringify(expectedCells('full')),
      `读到=${JSON.stringify(cells)}｜期望=${JSON.stringify(expectedCells('full'))}`,
    )
    check(
      `★★ [${size}] 状态条高 22±2px、未被省略号截断、且不把输入栏挤出视口（★ 这三样合起来才是"排得下"✓）`,
      gp !== null && gp.strip !== null && Math.abs(gp.strip.h - 22) <= 2 && gp.stripClipped === false &&
        gp.composer !== null && gp.composer.h > 0 && gp.composer.bottom <= gp.vh + 1 &&
        gp.strip.y >= gp.card.bottom - 1 && gp.strip.bottom <= gp.composer.bottom + 1,
      `高=${gp?.strip?.h}（真值 22）｜截断=${gp?.stripClipped}（scrollW vs clientW）｜输入栏 bottom=${gp?.composer?.bottom} / 视口高 ${gp?.vh}｜条 y=${gp?.strip?.y} card.bottom=${gp?.card?.bottom}`,
    )
  }
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
