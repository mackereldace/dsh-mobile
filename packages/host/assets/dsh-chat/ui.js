/**
 * 会话页的**画**那一半（DOM）—— 会话页骨架的第二块。
 *
 * ★ 纯 JS、直接发给浏览器（与 `assets/codex/ui.js` 同一类 ✓）。
 * ★ 取数循环在 `poller.js` 里（**不碰 DOM** ✓，能单测 ✓）；这里只回答"长什么样" ✓。
 *
 * ## 三条与首页一致的口径（观感归用户拍板 ✓，所以色值只在 CSS 变量里出现一次 ✗）
 *
 * 1. **只用系统字体** ✓、颜色全走 CSS 变量 ✓（浅/暗两套 = `prefers-color-scheme` ✓）；
 * 2. **事件的种类要看得见** ✓：认不出的类型也画一行小字（**绝不静默丢掉** ✗ ——
 *    "消息少了一条"在手机上完全查不出来 ✓）；
 * 3. **渲染是追加式的** ✓：新事件 append ✓，旧的一个都不重画 ✗
 *    （重画就会把用户的滚动位置、正在输入的内容弄没 ✗）。
 *
 * ## ★ "怎么判断"与"怎么画"分开（2026-10-03 晚）
 *
 * `toViewModel()` 是**纯函数** ✓（不碰 DOM ✓）—— "哪些事件要折叠、错误怎么认、
 * 长输出截到哪一行"全在它里面 ✓ ⇒ 这些判断能在 Node 里被钉死 ✓
 * （`packages/host/test/dsh-chat-viewmodel.test.ts` ✓）。
 * `renderEvent()` 只负责把 view model 画出来 ✓ —— 判断散在 DOM 代码里就永远测不了 ✗。
 */

/** 与boot手机调试框共用一个写入器；没有诊断口的旧客户端仍留控制台日志。 */
import { createProjection } from './projection.js'
import { mountConversation, icon } from './conversation.js'
import { mountTrace } from './trace.js'
import { mountComposerControls } from './composer.js'
import { mountNavigation } from './navigation.js'
import { mountStatistics } from './stats.js'
import { mountMobileShell } from './shell.js'
import { mountManagement, navigateMobileBackend } from './management.js'

export function chatLog(text) {
  try { console.log(text) } catch (error) { void error }
  const boot = globalThis.__DSH_MOBILE_BOOT__
  if (boot && typeof boot.debugLine === 'function') {
    try { boot.debugLine(text) } catch (error) { void error }
  }
}

/** 折叠阈值：工具块超过它就默认收起 ✓（手机屏小，一条 300 行的命令会吃掉整屏 ✗）。 */
export const MAX_VISIBLE_LINES = 10
export const MAX_VISIBLE_CHARS = 600

/**
 * 这条事件**是不是失败** ✓。
 *
 * 认这几种写法（都是 DSH 里真会出现的 ✓）：`exitCode` 非 0 ✓、`status` 是 failed/error ✓、
 * `ok === false` ✓、`failed === true` ✓、`error` 有内容 ✓。
 * ★ 认不出就是**不是**错误 ✓（宁可少标红，也不许把正常输出染红 ✗）。
 */
export function isFailure(data) {
  if (data === null || typeof data !== 'object') return false
  if (typeof data.exitCode === 'number' && data.exitCode !== 0) return true
  if (typeof data.exit_code === 'number' && data.exit_code !== 0) return true
  if (typeof data.status === 'string' && ['failed', 'error', 'failure'].includes(data.status.toLowerCase())) return true
  if (data.ok === false) return true
  if (data.failed === true) return true
  if (typeof data.error === 'string' && data.error.length > 0) return true
  if (data.error !== null && typeof data.error === 'object') return true
  return false
}

/** 事件类型 ⇒ 那块东西的标题（中文 ✓ —— 界面上不该出现 `commandExecution` 这种内部名 ✗）。 */
export function titleFor(kind, type) {
  if (kind === 'tool') {
    const text = typeof type === 'string' ? type.toLowerCase() : ''
    if (text.includes('command') || text.includes('exec')) return '命令'
    if (text.includes('file')) return '文件改动'
    if (text.includes('mcp')) return '工具调用'
    return '工具'
  }
  if (kind === 'reasoning') return '思考'
  if (kind === 'error') return '出错'
  if (kind === 'step') return '一轮'
  return typeof type === 'string' && type.length > 0 ? type : '事件'
}

/**
 * 一条事件 ⇒ **view model**（纯函数 ✓，不碰 DOM ✓）。
 *
 * 字段：`kind` / `type` / `text` / `thinking` / `title` / `body` / `collapsed` / `hiddenLines` / `isError` / `lines` ✓。
 * · `collapsed` 只对**工具类**与"认不出的类型"生效 ✓（消息再长也不折 ✗ —— 那是正文 ✓）；
 * · 折叠时 `body` 是**截过的**（保头 ✓）+ `hiddenLines` 说清还藏了几行 ✓
 *   （"少了几行"必须说出来 ✓，静默截断是最气人的一种 ✗）。
 * · `thinking` 是这条消息自己的**思维链** ✓（DSH 的 `reasoning` 块 ✓）——它**不进** `text` ✗，
 *   由 `renderEvent` 画成一条**默认折叠**的"思考"行 ✓（口径与官方客户端一致 ✓）。
 */
export function toViewModel(event) {
  const type = event !== null && typeof event === 'object' ? String(event.type || '') : ''
  const data = event !== null && typeof event === 'object' ? event.data : null
  const kind = classify(type)
  const text = textOf(event)
  const lines = text.length === 0 ? 0 : text.split('\n').length
  const view = {
    kind,
    type,
    title: kind === 'tool' && data !== null && typeof data === 'object'
      ? firstString(data, ['name', 'toolName']) || titleFor(kind, type)
      : titleFor(kind, type),
    text,
    thinking: thinkingOf(data),
    body: text,
    lines,
    collapsed: false,
    hiddenLines: 0,
    isError: kind === 'error' || isFailure(data),
  }
  const foldable = kind === 'tool' || kind === 'other'
  if (foldable && (lines > MAX_VISIBLE_LINES || text.length > MAX_VISIBLE_CHARS)) {
    const head = text.split('\n').slice(0, MAX_VISIBLE_LINES).join('\n').slice(0, MAX_VISIBLE_CHARS)
    view.collapsed = true
    view.body = head
    view.hiddenLines = Math.max(0, lines - head.split('\n').length)
  }
  return view
}

/**
 * 手机上那两颗按钮 ✓ —— DSH **封闭词汇**的**子集** ✓。
 *
 * 权威：`dsh-user-approval/lib/index.js:30-35` ✓
 * （`["allowed-once","rejected","cancelled","unavailable"]` ✓），
 * 官方客户端的按钮是**硬编码**这两颗 ✓（`dsh-client-ui-approval/lib/client.js:119-133` ✓：
 * `answer("rejected")` ✓ 与 `answer("allowed-once")` ✓），文案逐字抄自同一处
 * （`:261-262` 的 `reject: "拒绝"` ✓、`allowOnce: "允许一次"` ✓）。
 *
 * ★★ **没有「总是允许」** ✗（DSH 里不存在 ✓ —— 那是**会话策略**那个旋钮 ✓，
 *   走 `/permission <preset>` ✓，与一次裁决无关 ✗）。
 * ★ 这里是**复制**了一份 ✓（浏览器资产读不到宿主那个模块 ✓）⇒ 由单测钉住"两边不许漂移" ✓
 *   （见 `packages/host/test/dsh-approval.test.ts` 的"两张表必须一致" ✓）。
 */
export const APPROVAL_OPTIONS = Object.freeze([
  Object.freeze({ id: 'rejected', label: '拒绝' }),
  Object.freeze({ id: 'allowed-once', label: '允许一次' }),
])

/** 没有按钮时用的空表 ✓（冻结的**同一个**实例 ✓）。 */
const NO_APPROVAL_OPTIONS = Object.freeze([])

/**
 * 按**事件类型**给按钮 ✓ —— 不再从 `data.options` / `choices` / `actions` 里猜 ✗。
 *
 * ★★ 为什么必须按类型给 ✗（2026-10-08 改 ✓）：DSH 的 `approval/asked` 里
 *   **根本没有 options** ✓ —— 官方客户端那两颗按钮是硬编码的 ✓
 *   （`dsh-client-ui-approval/lib/client.js:119-133` ✓）⇒ 原来那条"解析选项"的路
 *   在真机上**永远是空的** ✓ ⇒ 按钮永远画不出来 ✓（这就是置灰那一步的真正原因 ✓）。
 *
 * ★ 只有**"在问"**的那一条给按钮 ✓：`approval/decided` / `approval/policy` 是记账 ⇒ 一颗都不给 ✓
 *   （它们连卡都不该画 ✓ —— 见 `classify` 与 `renderEvent` ✓）。
 */
export function approvalOptionsFor(type) {
  const text = typeof type === 'string' ? type.toLowerCase() : ''
  return text === 'approval/asked' || text.endsWith('/asked') ? APPROVAL_OPTIONS : NO_APPROVAL_OPTIONS
}

/**
 * 一张审批卡**该不该给能按的按钮** ✓（纯函数 ✓ —— 这一条错了，在手机上只会表现为
 * "按不动"或"按下去是在撒谎" ✗，都是最难查的那类 ✓）。
 *
 * ★★ 判据只有一条：**通道真的接通了吗** ✗ —— 没接通就**一律置灰** ✓（不假装能用 ✓）。
 *   通道状态由页面**探测**出来的（`app.js` 探一次 ⇒ `setApprovalChannel` ✓），
 *   不是"我们觉得它应该通了"✗。
 *
 * @param {object} input `{decided, channelConnected, sending}` ✓
 */
export function approvalActionState(input) {
  const source = input !== null && typeof input === 'object' ? input : {}
  const decided = source.decided === true
  const connected = source.channelConnected === true
  const sending = source.sending === true
  return {
    /** 已经裁决过 ⇒ 连按钮区都不摆 ✓（只显示结果 ✓）。 */
    showActions: !decided,
    /** 按不按得动 ✓。 */
    disabled: !connected || sending,
    /** 置灰的理由 ✓（空串 = 不必解释 ✓）。 */
    why: decided || connected ? '' : '裁决通道还没接通，所以这里的按钮先置灰（不假装能用）',
  }
}

/**
 * 一条**审批**事件 ⇒ view model ✓（纯函数 ✓）。
 *
 * ★★ 三条自我约束（"审批"是**会改变电脑上正在发生的事**的按钮 ✗，比"发送"更该保守 ✓）：
 *
 * 1. **认不出是哪一条请求 ⇒ 一颗按钮都不给** ✗（没有 `id` ⇒ 按下去也无从提交 ✓）+ 原文摊开 ✓。
 *    ★ 注意：按钮**不是**从事件里"解析"出来的 ✓ —— 它来自 `APPROVAL_OPTIONS` ✓
 *    （封闭词汇的子集 ✓，见 `approvalOptionsFor` ✓）；
 * 2. **已经裁决过的**（有对应 `approval/decided` ✓）⇒ 只显示结果，**不再给按钮** ✗；
 * 3. 认不出的形状 ⇒ **原文照摊** ✓（`raw` ✓）—— 绝不因为"看不懂"就什么都不显示 ✗。
 *
 * @param {object} event 事件本身（`{seq,time,type,data}` ✓）
 * @param {object|null} decided 已经收到的裁决（同一条请求的 `approval/decided` ✓），没有就 null ✓
 */
export function toApprovalViewModel(event, decided) {
  const data = event !== null && typeof event === 'object' && event.data !== null && typeof event.data === 'object' ? event.data : {}
  const text = textOf(event)
  const type = event !== null && typeof event === 'object' ? String(event.type || '') : ''
  const requestId = firstString(data, ['requestId', 'request_id', 'id', 'approvalId'])
  const title = firstString(data, ['title', 'tool', 'toolName', 'name', 'command']) || '需要你确认'
  const detail = firstString(data, ['detail', 'description', 'message', 'reason', 'prompt']) || text
  /**
   * ★★ 按钮来自**事件类型** ✓（封闭词汇的子集 ✓），不是从 data 里解析出来的 ✗
   *   —— 这一行原来是 `parseOptions(data)` ✓，那个函数在真机上**永远返回空表** ✓。
   * ★ 再加一道：**认不出是哪条请求**（没有 id ✓）就一颗都不给 ✗ ——
   *   否则那两颗按钮**注定失败** ✓（宿主那边 `requestId` 是必填 ✓），
   *   而"按下去报一句参数缺失"比"一开始就不给按钮"糟得多 ✓。
   */
  const options = requestId.length > 0 ? approvalOptionsFor(type) : NO_APPROVAL_OPTIONS
  /**
   * ★★ 裁决**结果的那个字**要按 DSH 的真字段名取 ✗：`approval/decided` 的 data 是
   *   **`{id, outcome}`** ✓（`dsh-user-approval/lib/index.js:139-142` 那条 append ✓）——
   *   不是 `decision` ✗（本仓栽过四次"照着想的字段名写"✓）。
   *   `decision` / `option` 这些是**老夹具**的写法 ✓，一起认，但 `outcome` 排第一 ✓。
   */
  const decision = decided !== null && decided !== undefined
    ? firstString(decided.data !== null && typeof decided.data === 'object' ? decided.data : {}, ['outcome', 'decision', 'option', 'choice', 'result', 'answer']) || '已处理'
    : ''
  const dump = safeJson(data)
  return {
    kind: 'approval',
    type,
    requestId,
    title,
    detail,
    options,
    decided: decision.length > 0,
    decision,
    /**
     * ★ 什么时候摊原文 ✗：① 这条**不是"在问"**（认不出该给什么按钮 ✓）；
     *   ② 或者**认不出是哪一条请求**（没有 id ⇒ 按下去也无从提交 ✓）。
     *   两种都要让人看得见原始形状 ✓ —— 静默变成一张空卡是最难查的 ✗。
     */
    raw: options.length > 0 && requestId.length > 0 ? '' : (typeof dump === 'string' ? dump : ''),
  }
}


function firstString(source, keys) {
  if (source === null || typeof source !== 'object') return ''
  for (const key of keys) {
    const value = source[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return ''
}

function safeJson(value) {
  try {
    return JSON.stringify(value)
  } catch (error) {
    return ''
  }
}

/** 事件的"种类"⇒ 画法。认不出的一律走 `other`（**仍然画** ✓）。 */
export function classify(type) {
  const text = typeof type === 'string' ? type.toLowerCase() : ''
  // 已核实的内部记账事件：保留原文供排障，但默认收起，避免 JSON 淹没对话。
  if (text.startsWith('session-log-deepseek/') || text.startsWith('agent/inbox/')) return 'meta'
  if (text.includes('usermessage') || text.includes('user/') || text.includes('prompt')) return 'user'
  if (text.includes('agentmessage') || text.includes('assistant') || text.includes('message')) return 'agent'
  /**
   * ★★ 审批要**排在工具之前**判 ✓ —— `approval/asked` 里没有 tool 字样 ✓，
   *   但审批常被包在工具事件里 ✓。
   *
   * ★★ 但**只有"在问"的那一条才是一张卡** ✗（2026-10-08 改 ✓）：
   *   `approval/decided`（裁决落地 ✓）与 `approval/policy`（会话策略 ✓）的 data 里
   *   同样带 `approval` 字样 ✓ ⇒ 旧判据会把它们**再画一张审批卡** ✓
   *   —— 同一件事凭空多出一张、还带按钮 ✗（这就是"凭空多一张卡"的来源 ✓）。
   *   ⇒ 它们单独一类 `approval-meta` ✓，由 `renderEvent` **不画** ✗（只当记账用 ✓：
   *     卡片据此变成"已处理"✓）。
   */
  if (text === 'approval/asked' || text.endsWith('/asked')) return 'approval'
  if (text.startsWith('approval/')) return 'approval-meta'
  if (text.includes('permission')) return 'approval'
  if (text.includes('reasoning') || text.includes('thinking')) return 'reasoning'
  if (text.includes('command') || text.includes('tool') || text.includes('exec')) return 'tool'
  if (text.includes('error') || text.includes('failed')) return 'error'
  if (text.includes('turn/') || text.includes('step')) return 'step'
  return 'other'
}

/**
 * 把 `data.message.content[]`（**DSH 的真形状** ✓）拼成一段能读的正文 ✓。
 *
 * 形状来源（**不是猜的** ✗）：
 * · `@deepseek-ai/dsh-llm` 0.2.0-rc.2 的类型声明 ——
 *   `TextBlock{type:'text',text}` / `ReasoningBlock{type:'reasoning',text}` /
 *   `ToolCallBlock{type:'tool-call',…}` / `ImageBlock` / `FileBlock` ✓；
 * · 真会话日志（`~/.dsh/sessions/**`，85 份）里逐条核过 ✓。
 *
 * ★ 只收 `text` 块 ✗ —— `reasoning`（思维链）**不是正文** ✓：
 *   官方 DSH 客户端的正文就是 `blocks.filter(block => block.kind === 'text')` ✓
 *   （`dsh-client-ui-chat` 的 `assistantText()` ✓），思维链单独走一条**默认折叠**的
 *   "思考"行（同包的 `ReasoningRow` ✓）。手机端照同一口径 ✓。
 *
 * ★ 空 `text` 一律丢掉 ✓：DSH 的 reasoning 块**经常是空串**（这仓里 17178 个 reasoning
 *   块中 2939 个是空的 ✓）⇒ 拼进去只会在正文里留一片空白 ✓。
 */
export function assistantText(data) {
  if (data === null || typeof data !== 'object') return ''
  const message = data.message
  const contents = []
  if (message !== null && typeof message === 'object' && Array.isArray(message.content)) contents.push(message.content)
  // ★ `data.content` 是**字符串**时它就是一整段正文 ✓（不是块数组 ✓）—— 不必按块拆 ✗
  if (Array.isArray(data.content)) contents.push(data.content)
  for (const parts of contents) {
    const texts = []
    for (const part of parts) {
      if (part === null || typeof part !== 'object') continue
      if (part.type === 'reasoning') continue
      if (typeof part.text === 'string' && part.text.length > 0) texts.push(part.text)
    }
    if (texts.length > 0) return texts.join('\n')
  }
  return ''
}

/**
 * 一条消息里的**思维链**（DSH 的 `reasoning` 块 ✓）—— 与正文**分开**取 ✓。
 *
 * ★ 为什么分开 ✗：思维链不是"助手对用户说的话" ✓ —— 官方 DSH 客户端把它渲染成
 *   一条**默认折叠**的"思考"行（`ReasoningRow` ✓，收起时只露第一段的首行 ✓），
 *   而正文只取 `text` 块 ✓。手机端照同一口径 ⇒ 正文里**不许混进思维链** ✗。
 */
export function thinkingOf(data) {
  if (data === null || typeof data !== 'object') return ''
  const message = data.message
  const contents = []
  if (message !== null && typeof message === 'object' && Array.isArray(message.content)) contents.push(message.content)
  if (Array.isArray(data.content)) contents.push(data.content)
  for (const parts of contents) {
    const texts = []
    for (const part of parts) {
      if (part === null || typeof part !== 'object') continue
      if (part.type !== 'reasoning') continue
      if (typeof part.text === 'string' && part.text.length > 0) texts.push(part.text)
    }
    if (texts.length > 0) return texts.join('\n')
  }
  return ''
}

/**
 * 从事件里尽量掏出一段**能读的文字** ✓（掏不出就返回空串，绝不编 ✗）。
 *
 * ★ 认得出的形状 ⇒ **绝不退回 `JSON.stringify`** ✗：一条真消息被整段画成 JSON，
 *   在手机上是**最难查的一类**（它不报错、只是"看着像乱码"）✓ —— 这正是本轮的 bug ✓。
 * `JSON.stringify` **只留作最后兜底** ✓：真的一个字段都不认识时，宁可把原文摊出来
 *   （"认不出的也要看得见"✓），也不许返回空串让人以为"什么都没有" ✓。
 */
export function textOf(event) {
  const data = event === null || typeof event !== 'object' ? null : event.data
  if (typeof data === 'string') return data
  if (data !== null && typeof data === 'object') {
    if (classify(event.type) === 'tool' && data.arguments !== undefined) return toolArguments(data.arguments)
    const message = recordOf(data.message)
    if (classify(event.type) === 'tool' && message !== null) {
      const text = assistantText(data)
      if (text.length > 0) return text
    }
    for (const key of ['text', 'message', 'content', 'output', 'command', 'summary', 'title']) {
      const value = data[key]
      if (typeof value === 'string' && value.length > 0) return value
    }
    // ★ DSH 的事件都是 `data.message.content[]` / `data.content[]`（真形状 ✓ —— 见 assistantText ✓）
    const assistant = assistantText(data)
    if (assistant.length > 0) return assistant
    try {
      return JSON.stringify(data)
    } catch (error) {
      return ''
    }
  }
  return ''
}

/** 工具参数只展示业务字段；JSON 字符串先解开，命令保持真实换行。 */
export function toolArguments(value) {
  let args = value
  if (typeof args === 'string') {
    try { args = JSON.parse(args) } catch { return args }
  }
  const record = recordOf(args)
  if (record === null) return typeof args === 'string' ? args : safeJson(args)
  const command = firstString(record, ['command', 'cmd', 'script'])
  if (command.length > 0) {
    const rest = Object.entries(record).filter(([key]) => !['command', 'cmd', 'script'].includes(key))
    return command + (rest.length > 0 ? '\n\n' + rest.map(([key, entry]) => key + ': ' +
      (typeof entry === 'string' ? entry : JSON.stringify(entry, null, 2))).join('\n') : '')
  }
  return JSON.stringify(record, null, 2)
}

/**
 * 把事件追加到容器里 ✓（**不重画已有的** ✓）。
 *
 * @param {HTMLElement} container
 * @param {Array} events 已经排好序、去过重的事件（来自 `poller.js` ✓）
 * @param {object} [context] 画审批卡要的上下文 ✓（`{decidedFor, answer, channelConnected}` ✓）——
 *   **可选** ✓：不给 ⇒ 按钮按"通道没接通"处理 ✓（置灰 ✓，不假装能用 ✗）。
 */
export function appendEvents(container, events, context) {
  if (container === null || container === undefined) return { follow: null, scrollTop: null }
  /**
   * ★ 要滚的是**真正的滚动容器** ✗，不是消息列表本身 ✓ ——
   *   页面结构改成"外层 `main` 滚、里面 `#messages` 只排"之后 ✓，
   *   再给 `#messages` 设 `scrollTop` 就是一个**静默无效**的赋值 ✓
   *   ⇒ 表现是"新消息永远在屏幕外、看着像卡住" ✓（本轮截图抓到的就是这个 ✓）。
   *   若 DOM 结构改回列表自己滚，这里**也**还能对（取到的就是它自己 ✓）。
   */
  const scroller = scrollContainerOf(container)
  const follow = shouldAutoScroll(
    { scrollTop: scroller.scrollTop, scrollHeight: scroller.scrollHeight, clientHeight: scroller.clientHeight },
    80,
  )
  for (const event of Array.isArray(events) ? events : []) {
    if (context && typeof context.isQuestionEvent === 'function' && context.isQuestionEvent(event)) continue
    const node = renderEvent(event, context)
    if (node !== null) {
      if (classify(event.type) === 'approval' && context && context.dock) {
        if (!decidedEventFor(context, event)) context.dock.insertBefore(node, context.dock.firstChild)
        if (typeof context.dockChanged === 'function') context.dockChanged()
      } else container.appendChild(node)
    }
  }
  // ★ 用户手动往上翻的时候**不许把他拽回去** ✗（`follow` 是在追加之前量的 ✓）
  if (follow && typeof scroller.scrollTop === 'number') scroller.scrollTop = scroller.scrollHeight
  /**
   * ★ 把这一次追加的**两个读数**交出去 ✓（长会话那一单 ✓ —— 裁剪那一步要拿它们做补偿 ✗，
   *   验收要拿它们证明"补偿真的发生了"✓）。**纯读数** ✓：不改任何状态 ✓。
   */
  return { follow, scrollTop: typeof scroller.scrollTop === 'number' ? scroller.scrollTop : null }
}

/**
 * ★★ **长会话的窗口**（复刻清单第 6 项 ✓）—— 一条会话最多在屏上留这么多条事件 ✗。
 *
 * ## 上界为什么是 **200**（★ 依据写在这儿，改数先改这段话 ✗）
 *
 * 1. **它比任何一屏都长得多** ✓：这条消息列表每条约 40–60px（`theme.css` 的
 *    `#messages { gap: 10px }` + 气泡内边距 ✓）⇒ 200 条 ≈ **8,000–12,000px** ✓，
 *    而手机视口高 568–915px ✓ ⇒ 屏上同时看得见的不到 **8 条** ✓
 *    （≈ 25 屏的历史 ✓）—— 用户"往回翻"的时候不会撞到边界 ✓；
 * 2. **它与 DSH 自己的窗口同量级** ✗（源码读数：`session.js:20` 的
 *    `HISTORY_PAGE_OPTIONS.maxMessages = 500` ✓）—— 我们没有"取更早"那条通道 ✓
 *    （见 {@link trimEventWindow} 的说明 ✓）⇒ **不照抄 500** ✗，
 *    取 200 是为了"既留住足够多的历史、又把节点数钉在上千以下" ✓；
 * 3. **节点数是确定性判据** ✓：200 条 ×（一条消息 ≈ 4–6 个元素 ✓）≈ 1,200 节点 ✓，
 *    手机 WebView 完全无压力 ✓；而上千条事件（旧行为）会到 **5,000+ 节点** ✗。
 *
 * ★ 这不是虚拟列表 ✗（那要测量、要预估行高 ✓，在这个"追加式"渲染器里会引入新的抖动 ✓）——
 *   它是**有上界的窗口 + 头部回收** ✓：新事件照旧 `appendChild` ✓，只把最老的移出去 ✓。
 */
export const MAX_DRAWN_EVENTS = 200

/**
 * 那条"更早的消息已收起"的提示行 ✓（自己造的字 ✓，纯 ASCII 属性名 ✓）。
 *
 * ★ 只有**对话视图**摆它 ✗（`withNote` ✓）：轨迹视图是"步骤列表" ✓ ——
 *   它那面自己有"还没有步骤"的占位话 ✓，再加一句"更早的 N 条已收起"就会
 *   把"轨迹里画了几条"这个读数搅浑 ✓（验收里那条判据是逐条数的 ✓）。
 */
function ensureTrimNote(container, hiddenCount, withNote) {
  if (typeof container.querySelector !== 'function') return null
  let note = container.querySelector('.ev-trim-note')
  const text = '更早的 ' + String(hiddenCount) + ' 条已收起（这一页只留最近 ' + String(MAX_DRAWN_EVENTS) + ' 条）'
  if (!withNote || hiddenCount <= 0) {
    if (note !== null && note !== undefined && typeof note.remove === 'function') note.remove()
    return null
  }
  if (note === null || note === undefined) {
    note = document.createElement('div')
    note.className = 'ev ev-trim-note'
    note.setAttribute('data-trim-hidden', String(hiddenCount))
    note.textContent = text
    container.insertBefore(note, container.firstChild)
    return note
  }
  note.setAttribute('data-trim-hidden', String(hiddenCount))
  note.textContent = text
  return note
}

/**
 * 一条事件节点**能不能被回收** ✓（纯函数 ✓ —— 不碰 DOM ⇒ 能断言 ✓）。
 *
 * ★★ 一条"不许回收"的规矩（**为了不骗用户** ✓）：
 * · `[data-pending-approval]` —— 那张卡上还有**能按的按钮** ✓，它是现在进行时的交互 ✓
 *   （用户还没裁决 ✓）⇒ 摘掉它就是"屏幕上少了一次要你决定的事" ✗（最坏的一种 ✓）。
 *
 * ★★ 那句提示行 `.ev-trim-note` **算"可回收"** ✗（★ 这是本轮实测抓到的一个死锁 ✓）：
 *   它住在列表**头部** ✓（`insertBefore(note, firstChild)` ✓）⇒ 若把它判成"不许回收" ✓，
 *   那么**下一次**裁剪在第一格就 `break` ✓ ⇒ 从此**一条都裁不掉** ✓
 *   （读数症状：`hidden` 卡在第一次那个数、而列表里的事件数一路涨到两千 ✓ ——
 *   我第一版就是这样 ✓，屏上看着完全正常 ✓）。它本来就由 `ensureTrimNote` 自己维护 ✓
 *   （要么被摘、要么在下一批重建 ✓），所以让它跟别的头部节点一起走是安全的 ✓。
 */
export function isTrimmableEvent(node) {
  if (node === null || node === undefined || typeof node.getAttribute !== 'function') return false
  return node.getAttribute('data-pending-approval') === null
}

/**
 * ★★ 把事件窗口裁到 {@link MAX_DRAWN_EVENTS} 以内 ✓ —— **从头部回收** ✗。
 *
 * ## 五条口径（每一条都是"不做就会在手机上出错" ✓）
 *
 * 1. **只在超了的时候才动 DOM** ✓：没超 ⇒ 一次 `getAttribute` 都不做 ✓
 *    （每条消息都跑一遍"要不要裁"才是新的卡顿源 ✗）；
 * 2. ★★ **不碰 `computePageState`** ✗：有内容就 `ready` ✓ 这条规矩**一个字都没改** ✓
 *    ⇒ "裁剪"永远不会变成"出错清屏"✓（裁决那件事仍归 `eventCount > 0` ✓）；
 * 3. ★★ **滚动位置不跳** ✗：裁掉的是**已经画在用户上面**的那些节点 ✓ ⇒
 *    内容整体上移 ✓。补偿用**实测的 `scrollHeight` 差值** ✓（不是预估行高 ✗）：
 *    `scrollTop += 裁之前的高 − 裁之后的高` ✓ ⇒ 用户正在读的那一条**纹丝不动** ✓；
 * 4. ★ **`seq` 去重不受影响** ✓：去重那本账（`poller.js` 的 `seen` ✓）**不在这一层** ✗，
 *    也**不跟着裁** ✓ ⇒ 被回收的 `seq` 若被再次推来，照样被去重掉 ✓
 *    （这一层因此**不需要**自己记 `seq` ✓ —— 同一个概念只有一个事实来源 ✓）；
 * 5. ★ 待裁决的审批卡**不回收** ✓（见 {@link isTrimmableEvent} ✓）—— 于是"窗口"在那一种
 *    情况下会**短暂超上界** ✓，这是**故意的** ✗（宁可多几个节点，也不许把"等你决定"那件事
 *    从屏上拿走 ✓）。真到那一步的会话，节点数仍由"未裁决的审批数"封住（通常 ≤ 1 ✓）。
 *
 * @param {HTMLElement} container 事件列表（`#messages` ✓）
 * @param {object} [metrics] 追加**之前**量好的读数 ✓（`{scroller, scrollTop, anchor, anchorTop}` ✓）——
 *   给了它就做滚动补偿 ✓（见下面那段长注释 ✓）
 * @param {boolean} [withNote] 要不要摆那句"更早的 N 条已收起" ✓（默认要 ✓；轨迹视图传 `false` ✓）
 * @returns {{ trimmed: number, hidden: number, drawn: number, scrollTop: number|null, screenDelta: number|null }}
 *   `trimmed` = 这一次摘掉几个节点 ✓、`hidden` = 列表里累计收起了几条 ✓、
 *   `drawn` = 现在列表里还有几个孩子 ✓（它就是"节点数"那条判据的读数 ✓）、
 *   `scrollTop` = 补偿之后的滚动位置（没补偿就是 `null` ✓）、
 *   `screenDelta` = 补偿**之后**锚点相对屏口还差多少 px ✓（≈0 ⇒ 用户那一条没动 ✓）
 */
export function trimEventWindow(container, metrics, withNote) {
  const none = { trimmed: 0, hidden: 0, drawn: 0, scrollTop: null, screenDelta: null }
  if (!container || !container.children) return none
  const hiddenBefore = Math.max(0, Number(container.getAttribute('data-trim-hidden-total') || '0'))
  const rows = Array.from(container.children).filter(node => !node.classList.contains('ev-trim-note'))
  const excess = Math.max(0, rows.length - MAX_DRAWN_EVENTS)
  const doomed = []
  for (const node of rows.slice(0, excess)) {
    if (!isTrimmableEvent(node)) break
    doomed.push(node)
  }
  if (!doomed.length) return { ...none, hidden: hiddenBefore, drawn: container.children.length }
  // 保留同一节点及其屏口坐标；不估算行高、gap或提示行高度。
  const scroller = metrics && metrics.scroller
  let anchor = metrics && metrics.anchor
  let anchorTop = metrics && metrics.anchorTop
  if (anchor && doomed.includes(anchor)) {
    anchor = rows[doomed.length]
    anchorTop = anchor && scroller ? anchor.getBoundingClientRect().top - scroller.getBoundingClientRect().top : null
  }
  for (const node of doomed) node.remove()
  const hidden = hiddenBefore + doomed.length
  container.setAttribute('data-trim-hidden-total', String(hidden))
  ensureTrimNote(container, hidden, withNote !== false)
  let screenDelta = null
  if (scroller && typeof scroller.scrollTop === 'number') {
    if (metrics.follow === true) scroller.scrollTop = scroller.scrollHeight
    else if (anchor && anchor.parentElement === container && typeof anchorTop === 'number') {
      const delta = anchor.getBoundingClientRect().top - scroller.getBoundingClientRect().top - anchorTop
      scroller.scrollTop += delta
      screenDelta = anchor.getBoundingClientRect().top - scroller.getBoundingClientRect().top - anchorTop
    }
  }
  return { trimmed: doomed.length, hidden, drawn: container.children.length,
    scrollTop: scroller ? scroller.scrollTop : null, screenDelta }
}

export function resetEventWindow(container) {
  if (container === null || container === undefined || typeof container.querySelector !== 'function') return
  container.setAttribute('data-trim-hidden-total', '0')
  const note = container.querySelector('.ev-trim-note')
  if (note !== null && note !== undefined && typeof note.remove === 'function') note.remove()
}

/** 事件列表真正在滚的那一层 ✓（`main` ✓；没有它时退回父节点 / 自己 ✓）。 */
function scrollContainerOf(container) {
  return typeof container.closest === 'function'
    ? (container.closest('main') || container.parentElement || container)
    : (container.parentElement || container)
}

/**
 * ★★ 「轨迹」视图要摊开哪些事件 ✓（纯函数 ✓ —— 不碰 DOM ⇒ 能单测 ✓）。
 *
 * ## 这判据是从哪来的（★ 不是我定的 ✗）
 *
 * 复刻清单第 3 项的原话 ✓：轨迹视图 = **同一批事件的另一条渲染路** ✓，
 * 「把 **`step` / `tool` 那类事件**按**步骤列表**摊开」✓ ——
 * 而 `step` / `tool` 正是 {@link classify} 已经有的两个种类 ✓
 * ⇒ 这里**只做挑选** ✓，**不新造分类** ✗（同一件事只有一个真相来源 ✓）。
 *
 * ★ 为什么不换一套判据 ✗：`classify()` 是本文件里"什么事件长什么样"的**唯一**判据 ✓
 *   （审批、思维链、认不出的类型全在它里面 ✓）。在这儿再写一遍 `text.includes('tool')`
 *   就是第二个真相来源 ✓ —— 改一处漏一处，而且**改错了在屏幕上完全看不出来** ✗。
 *
 * @param {object} event 一条事件（`{seq,time,type,data}` ✓）
 */
export function isTraceEvent(event) {
  const view = toViewModel(event)
  return view.kind === 'step' || view.kind === 'tool'
}

/**
 * 一条事件 ⇒ 轨迹视图里那个节点 ✓（`null` = 这条不进轨迹视图 ✓）。
 *
 * ## 复用，不是重写（★ 本仓规矩 ✓）
 *
 * 认种类走 {@link classify} ✓（在 `toViewModel` 里 ✓）、画法走 {@link renderEvent} ✓ ——
 * **一个字都没新写** ✗（渲染分支：工具卡 / 一轮分隔线 / 出错 / 认不出的兜底 全在原处 ✓）。
 * 这一层只回答"哪些进得来"✓（见 {@link isTraceEvent} ✓）。
 *
 * ★ 为什么不另写一套"更漂亮的步骤列表" ✗：那正是"两个渲染器"✗ ——
 *   工具卡上的「展开 / 收起」、出错标记、思维链折叠这些**已经修好的行为**
 *   会在轨迹视图里**全部消失** ✓（而且消失得看不出来 ✓）。
 */
export function renderTraceEvent(event, context) {
  if (!isTraceEvent(event)) return null
  return renderEvent(event, context)
}

/** 实际事件配对的泳道数据；时长模式移除未被任何span覆盖的空闲区间。 */
export function traceTimeline(events, duration = false) {
  const source = Array.isArray(events) ? events : []
  const results = new Map(), starts = new Map()
  for (const event of source) {
    const data = event.data || {}
    const id = data.callId || (data.message && data.message.toolCallId)
    if (event.type === 'tool/result' && id) results.set(id, Number(event.time))
    if (event.type === 'request/header' || event.type === 'step/start') {
      starts.set(String(data.turn) + ':' + String(data.step), Number(event.time))
    }
  }
  let turn = 0, step = 0
  const spans = []
  for (const event of source) {
    const data = event.data || {}, view = toViewModel(event)
    if (typeof data.turn === 'number') turn = data.turn
    if (typeof data.step === 'number') step = data.step
    if (!['user', 'agent', 'reasoning', 'tool', 'step', 'error'].includes(view.kind)) continue
    const lane = view.kind === 'tool' ? 2 : ['agent', 'reasoning'].includes(view.kind) ? 1 : 0
    let start = Number(data.startedAt ?? event.time)
    if (!Number.isFinite(start) && typeof data.startedAt === 'string') start = Date.parse(data.startedAt)
    let end = start
    if (typeof data.timeSeconds === 'number' && Number.isFinite(data.timeSeconds)) end = start + Math.max(0, data.timeSeconds * 1000)
    else if (event.type === 'tool/call' && results.has(data.callId)) end = results.get(data.callId)
    else if (lane === 1) {
      const began = starts.get(String(turn) + ':' + String(step))
      if (Number.isFinite(began) && began <= start) { end = start; start = began }
    }
    if (duration && (!Number.isFinite(start) || !Number.isFinite(end))) continue
    spans.push({ event, view, turn, step, lane, start, end: Math.max(start, end), milliseconds: Math.max(0, end - start) || 0 })
  }
  if (!duration) return { spans: spans.map((span, index) => ({ ...span, start: index, end: index + 1 })), extent: spans.length }
  const sorted = [...spans].sort((a, b) => a.start - b.start)
  if (!sorted.length) return { spans: [], extent: 0 }
  const base = sorted[0].start
  let coveredUntil = base, removedIdle = 0, extent = 0
  for (const span of sorted) {
    if (span.start > coveredUntil) removedIdle += span.start - coveredUntil
    const end = Math.max(span.start + 1, span.end)
    const projectedStart = span.start - base - removedIdle
    span.start = projectedStart
    span.end = end - base - removedIdle
    coveredUntil = Math.max(coveredUntil, end)
    extent = Math.max(extent, span.end)
  }
  return { spans, extent }
}

/**
 * 这张审批卡对应的那条 `approval/decided` ✓（没有 ⇒ `null` ✓）。
 *
 * ★ 为什么由**调用方**给 ✗（而不是在这里自己找 ✓）：裁决事件可能比那张卡**晚到** ✓
 *   （页面是分批轮询的 ✓）⇒ 只有页面那一层知道"这颗 id 后来被裁决了"✓
 *   （`mountChat` 里那本账 ✓）。
 */
function decidedEventFor(context, event) {
  if (context === null || context === undefined || typeof context.decidedFor !== 'function') return null
  const value = context.decidedFor(event)
  return value === undefined ? null : value
}

/**
 * 一条审批事件里的**请求 id** ✓（空串 = 认不出 ✓ ⇒ 不给按钮 ✓，见 `toApprovalViewModel` ✓）。
 *
 * ★ DSH 的真字段名是 **`id`** ✓（`dsh-user-approval/lib/index.js:132-137` 那条 append ✓：
 *   `session.append("approval/asked", { id, toolName, … })` ✓）；
 *   `requestId` 一起认 ✓ 是为了**老夹具**（本仓的单测夹具 ✓）—— 两种都试，不猜语义 ✓。
 */
function approvalIdOf(event) {
  const data =
    event !== null && typeof event === 'object' && event.data !== null && typeof event.data === 'object' ? event.data : {}
  return firstString(data, ['id', 'requestId', 'request_id', 'approvalId'])
}

/**
 * 把一条消息的**正文**画进容器 ✓ —— 用**现成**的渲染器 ✗。
 *
 * ## 复用的是哪一个
 *
 * `boot.js` 自己那一套（`renderMarkdownInto` ✓ —— Temml + 行内公式 + 标题 / 列表 /
 * 代码块 / 表格 / 引用 ✓）。会话页**本来就加载 `boot.js`**（`page.html` ✓）⇒
 * 它就是 `globalThis.__DSH_MOBILE_BOOT__.renderMarkdownInto` ✓（`boot.js:23469` ✓）。
 *
 * ★ 为什么必须复用 ✗：本仓规矩 —— **不新造渲染器** ✓。再写一份就是同一件事有
 *   两个真相来源 ✓（而且外壳那份的坑已经被它自己的回归测试钉住了 ✓）。
 *
 * ## 拿不到的时候怎么办（两条既有纪律都不能破 ✓）
 *
 * · ★ **认不出的也要看得见** ✓：拿不到渲染器（老宿主 / 单测里没给 `boot.js` /
 *   隧道缺席 ✓）⇒ **退回摊原文** ✓。宁可显示成没有格式的纯文本，
 *   也**绝不许显示成空白** ✗ —— 空白在手机上完全查不出来 ✓。
 * · ★ **不拼 `innerHTML`** ✗：正文是**不可信输入** ✓（助手说的话里可以带
 *   `<img onerror=…>` ✓）⇒ 兜底这条路只走 `textContent` ✓
 *   （渲染器自己那条路里的 `innerHTML` 是 Temml 的产物 ✓ —— 见报告第 5 节 ✓）。
 *
 * ★ 渲染**只在画这一条的时候做一次** ✓（`appendEvents` 只 appendChild ✓，
 *   轮询不会重画已有节点 ✓）⇒ 这里**不缓存、也不重渲染** ✓。
 */
function renderBodyInto(container, text) {
  const boot = globalThis.__DSH_MOBILE_BOOT__
  const render = boot === null || boot === undefined ? undefined : boot.renderMarkdownInto
  if (typeof render === 'function') {
    try {
      render(container, text)
      return
    } catch (error) {
      // ★ 渲染器自己炸了也**不许**留个空白 ✗ —— 摊原文，并且把原因说出来 ✓
      container.textContent = text
      container.setAttribute('data-render-fallback', String(error && error.message ? error.message : error))
      return
    }
  }
  container.textContent = text
  container.setAttribute('data-render-fallback', '渲染器未就绪')
}

/** 一条事件 ⇒ 一个节点 ✓（`null` = 真的没什么可画的 ✓）。 */
export function renderEvent(event, context) {
  const view = toViewModel(event)
  /**
   * ★★ 记账事件**不画** ✗（`approval/decided` / `approval/policy` ✓）：
   *   它们的 data 里也带 `approval` 字样 ✓，旧判据会把它们**再画一张审批卡** ✓
   *   —— 同一件事凭空多出一张、还带按钮 ✗。它们只用来把那张**真卡**标成"已处理" ✓。
   */
  if (view.kind === 'approval-meta') return null
  const wrapper = document.createElement('div')
  wrapper.className = 'ev ev-' + view.kind + (view.isError ? ' is-error' : '')
  wrapper.setAttribute('data-type', view.type)
  /**
   * ★ 这两个读数**只给验收用** ✓（纯 ASCII 名字 ✓）—— DOM 上看不出区别，
   *   但"正文到底掏出来几个字 / 有没有混进 JSON"从此**能在 dump 里逐字对** ✓。
   *   为什么非要它 ✗：正文里有引号/换行/`<`，直接拿字符串去撞 HTML 很容易变成
   *   "判据比被判断的东西软" ✓（本项目今天栽过 9+ 次的那类 ✓）。
   *   `data-text-head` 走 `encodeURIComponent` ✓（属性值里不留 `<` `"` `&` 这些会毁掉 dump 的字 ✓）。
   */
  wrapper.setAttribute('data-text-chars', String(view.text.length))
  // ★ 逐字符编 ✓（空格也编成 `%20` ⇒ `decodeURIComponent` 能**原样**还原 ✓）
  wrapper.setAttribute('data-text-head', view.text.slice(0, 64).split('').map((ch) =>
    /[A-Za-z0-9\-_.~]/.test(ch) ? ch : encodeURIComponent(ch)).join(''))
  /**
   * ★★ 这条事件自己的 `seq`（长会话那一单 ✓）—— **只有数值型的才写** ✗。
   *
   * 为什么要它 ✗：裁剪之后，"屏上那几条**还是不是原来那几条、顺序还对不对**"
   * 必须**能从 DOM 上直接读出来** ✓ —— 拿 `textContent` 去撞正文是"判据比被判断的
   * 东西软"（正文里有引号 / 换行 / `<` ✓，本仓今天栽过 9+ 次 ✓）。
   * 有了它，"最新几条仍在、顺序仍对"就是一条**机械可判**的读数 ✓。
   * ★ 数值才写 ✗：`seq` 缺失的事件（`poller.js` 允许 ✓）写一个 `"null"` 进去，
   *   读的人会以为它真有条号 ✓。
   * ★ 放在**最后**写 ✗ —— 属性顺序就是 DOM dump 里的字符顺序 ✓，
   *   既有断言里那两条正则（`class="ev ev-user"[^>]*>` 与
   *   `data-type="assistant/message"[^>]*>`）都是**前缀匹配** ✓，
   *   插在它们前面就会把既有断言打红 ✓（那是本单绝不许发生的事 ✓）。
   */
  const seq = event !== null && typeof event === 'object' ? event.seq : null
  if (typeof seq === 'number') wrapper.setAttribute('data-seq', String(seq))

  if (view.kind === 'meta') {
    const details = document.createElement('details')
    details.className = 'event-meta'
    const summary = document.createElement('summary')
    summary.textContent = view.type.startsWith('session-log-deepseek/') ? '会话记录已同步' : '输入队列已更新'
    const raw = document.createElement('pre')
    raw.textContent = JSON.stringify(event.data, null, 2)
    details.appendChild(summary)
    details.appendChild(raw)
    wrapper.appendChild(details)
    return wrapper
  }

  if (view.kind === 'user' || view.kind === 'agent') {
    // ★ 思维链**默认折叠** ✓（口径同官方客户端的"思考"行 ✓）—— 点开才看全文 ✓
    if (view.thinking.length > 0) {
      const think = document.createElement('details')
      think.className = 'thinking'
      const summary = document.createElement('summary')
      summary.textContent = '思考'
      const body = document.createElement('pre')
      body.className = 'thinking-body'
      body.textContent = view.thinking
      think.appendChild(summary)
      think.appendChild(body)
      wrapper.appendChild(think)
    }
    const bubble = document.createElement('div')
    bubble.className = 'bubble'
    /**
     * ★★ 正文走**现成**的 markdown 渲染器 ✗（`renderMarkdownInto` ✓）——
     *   以前这一行是 `bubble.textContent = view.text` ✓，所以助手写 `**加了两遍**`
     *   在手机上就**原样带星号** ✓（用户点名的那件事 ✓）。
     * ★ 空正文仍然只写那句占位话 ✓（渲染器对空串什么都不画 ⇒ 会变成空气泡 ✗）。
     * ★ 思维链**不走这里** ✗（它在那条默认折叠的「思考」行里 ✓ —— 口径不变 ✓）。
     */
    if (view.text.length > 0) renderBodyInto(bubble, view.text)
    else bubble.textContent = '（这条没有文字内容）'
    wrapper.appendChild(bubble)
    return wrapper
  }

  if (view.kind === 'reasoning') {
    const line = document.createElement('div')
    line.className = 'dim small'
    line.textContent = view.text.length > 0 ? view.text : view.title
    wrapper.appendChild(line)
    return wrapper
  }

  if (view.kind === 'tool') {
    wrapper.appendChild(toolCard(view))
    return wrapper
  }

  if (view.kind === 'approval') {
    wrapper.appendChild(approvalCard(toApprovalViewModel(event, decidedEventFor(context, event)), context))
    return wrapper
  }

  if (view.kind === 'step') {
    // ★ 一轮的开始不该是"孤零零一个词" ✓ —— 做成一条带小标签的分隔线 ✓
    //   （`turn/start` 的 data 里带轮号时写"第 N 轮"✓，没有就写事件名 ✓ —— 不编 ✗）
    const line = document.createElement('div')
    line.className = 'step'
    const label = document.createElement('span')
    const data = event !== null && typeof event === 'object' ? event.data : null
    const turn = data !== null && typeof data === 'object' ? data.turn : undefined
    label.textContent = typeof turn === 'number' ? '第 ' + turn + ' 轮' : view.type
    line.appendChild(label)
    wrapper.appendChild(line)
    return wrapper
  }

  // ★ 认不出的类型**也要看得见** ✓（静默丢掉 = 手机上永远查不出来 ✓）
  const fallback = document.createElement('div')
  fallback.className = 'dim small'
  fallback.textContent = view.title + (view.text.length > 0 ? '：' + view.text.slice(0, 200) : '')
  wrapper.appendChild(fallback)
  return wrapper
}

/**
 * 审批卡片 ✓。
 *
 * ★★ 按钮什么时候**能按** ✗（2026-10-08 改 ✓）：
 *   · 通道**探测到接通**（`approvalActionState` 的 `channelConnected` ✓）⇒ 才可点 ✓；
 *   · 没接通 ⇒ **一律置灰** ✓ 并写清理由 ✓ —— 这条纪律**没变** ✓（不假装能用 ✗）。
 *   ★ 改前是无条件置灰 ✓（那时通道确实没接通 ✓）；现在"接通"是**探出来的** ✓
 *     （`app.js` 探一次 ⇒ `setApprovalChannel` ✓），不是"我们觉得应该通了"✗。
 *
 * ★ 按下去之后 ✓：① 先把这张卡的按钮全置灰（同一次审批不许提交两次 ✓）；
 *   ② 把宿主回话**原样说出来** ✓ —— `ok:false` 的意思是"这一下没落到任何在等的请求上"
 *   （重复点 / 已经超时 / id 不对 ✓）⇒ **必须说出来** ✓，不许显示成"已处理" ✗。
 */
function approvalCard(view, context) {
  const card = document.createElement('div')
  card.className = 'approval' + (view.decided ? ' approval-decided' : '')
  /** ★ 这张卡对应哪条请求 ✓（纯 ASCII 属性名 ✓ —— 验收与排障都要按它找 ✓）。 */
  if (view.requestId.length > 0) card.setAttribute('data-request', view.requestId)

  const head = document.createElement('div')
  head.className = 'approval-head'
  const title = document.createElement('div')
  title.className = 'approval-title'
  title.textContent = view.decided ? '已处理：' + view.decision : view.title
  head.appendChild(title)
  card.appendChild(head)

  if (view.detail.length > 0) {
    const detail = document.createElement('pre')
    detail.className = 'approval-detail'
    detail.textContent = view.detail
    card.appendChild(detail)
  }

  const state = approvalActionState({
    decided: view.decided,
    channelConnected: context !== null && context !== undefined && context.channelConnected === true,
    sending: false,
  })

  if (state.showActions) {
    /**
     * ★★ 这张卡**还在等用户决定** ✗（长会话那一单 ✓）—— 裁剪那一层看见这个标记就**收手** ✓
     *   （见 `isTrimmableEvent` ✓）：屏幕上少一次要你决定的事，比多几个 DOM 节点坏得多 ✓。
     * ★ 只在 `showActions` 为真时写 ✗（已裁决的卡可以照常回收 ✓ —— 它已经没有可点的东西了 ✓）。
     */
    card.setAttribute('data-pending-approval', '1')
    const actions = document.createElement('div')
    actions.className = 'approval-actions'
    if (view.options.length > 0) {
      for (const option of view.options) {
        const button = document.createElement('button')
        button.type = 'button'
        button.className = 'approval-option'
        button.setAttribute('data-decision', option.id)
        button.textContent = option.label
        button.disabled = state.disabled
        button.addEventListener('click', () => {
          void answerApproval(card, view, option, context)
        })
        actions.appendChild(button)
      }
    } else {
      const note = document.createElement('div')
      note.className = 'dim small'
      note.textContent = '这一条不是 DSH 的审批请求（认不出该给什么按钮）—— 原文在下面'
      actions.appendChild(note)
    }
    card.appendChild(actions)
    if (state.why.length > 0) {
      const why = document.createElement('div')
      why.className = 'approval-why'
      why.textContent = state.why
      card.appendChild(why)
    }
  }

  if (view.raw.length > 0) {
    const raw = document.createElement('pre')
    raw.className = 'approval-raw'
    raw.textContent = view.raw
    card.appendChild(raw)
  }
  return card
}

/**
 * 手机点了审批上的一颗按钮 ✓。
 *
 * ★ 失败**必须说出来** ✗：**一个安静的按钮比一个置灰的按钮更坏** ✓
 *   （置灰至少是诚实的 ✓；"按下去什么都没发生"会让人以为已经批准了 ✓）。
 */
function answerApproval(card, view, option, context) {
  const buttons = card.querySelectorAll('.approval-option')
  for (const button of buttons) button.disabled = true
  const status = document.createElement('div')
  status.className = 'approval-why'
  status.textContent = '正在提交…'
  card.appendChild(status)
  const answer = context !== null && typeof context === 'object' ? context.answer : undefined
  if (typeof answer !== 'function') {
    status.textContent = '这一页没有接上裁决通道（按钮本不该能按）'
    return Promise.resolve()
  }
  let accepted = false
  return Promise.resolve()
    .then(() => answer(view.requestId, option.id))
    .then((result) => {
      const ok = result !== null && typeof result === 'object' && result.ok === true
      accepted = ok
      const outcome = result !== null && typeof result === 'object' && typeof result.outcome === 'string' ? result.outcome : ''
      status.textContent = ok
        ? '已提交：' + (outcome.length > 0 ? outcome : option.id)
        : '这一下没落到任何在等的审批上（可能已经处理过或已超时）'
    })
    .catch((error) => {
      status.textContent = '没提交成功：' + (error instanceof Error ? error.message : String(error))
    }).finally(() => {
      if (!accepted && context && context.channelConnected === true) for (const button of buttons) button.disabled = false
    })
}

/**
 * 工具块 ✓：标题行（**中文**，不出现 `commandExecution` 这种内部名 ✗）+ 正文。
 *
 * ★ 长输出**默认收起** ✓，并且**说清楚还藏了几行** ✗（静默截断是最气人的一种 ✓）；
 * ★ 失败**标出来** ✓（`exitCode` 非 0 / `status: failed` / `ok:false` —— 见 `isFailure` ✓）。
 */
function toolCard(view) {
  const card = document.createElement('div')
  card.className = 'tool' + (view.isError ? ' tool-error' : '')

  const head = document.createElement('div')
  head.className = 'tool-head'
  const title = document.createElement('span')
  title.className = 'tool-title'
  title.textContent = view.title
  head.appendChild(title)
  if (view.isError) {
    const flag = document.createElement('span')
    flag.className = 'tool-flag'
    flag.textContent = '失败'
    head.appendChild(flag)
  }
  if (view.collapsed) {
    const hidden = document.createElement('span')
    hidden.className = 'tool-hidden'
    hidden.textContent = view.hiddenLines > 0 ? '还有 ' + view.hiddenLines + ' 行' : '还有 ' + (view.text.length - view.body.length) + ' 字'
    head.appendChild(hidden)
  }
  const spacer = document.createElement('span')
  spacer.className = 'grow'
  head.appendChild(spacer)

  const body = document.createElement('pre')
  body.className = 'tool-body'
  body.textContent = view.body

  if (view.collapsed) {
    const toggle = document.createElement('button')
    toggle.type = 'button'
    toggle.className = 'tool-toggle'
    toggle.textContent = '展开'
    toggle.addEventListener('click', () => {
      const expanded = card.getAttribute('data-open') === '1'
      card.setAttribute('data-open', expanded ? '0' : '1')
      body.textContent = expanded ? view.body : view.text
      toggle.textContent = expanded ? '展开' : '收起'
      const hiddenNote = head.querySelector('.tool-hidden')
      if (hiddenNote !== null) hiddenNote.textContent = expanded
        ? (view.hiddenLines > 0 ? '还有 ' + view.hiddenLines + ' 行' : '还有 ' + (view.text.length - view.body.length) + ' 字') : '全部'
    })
    head.appendChild(toggle)
  }
  card.appendChild(head)
  card.appendChild(body)
  return card
}

/**
 * 新内容到达时，**要不要自动跟到底部** ✓（纯函数 ✓）。
 *
 * 两条都别做错 ✗：
 * · 不该跟的时候跟了 ⇒ 用户正翻上面的历史，被**一把拽回底部** ✓（很气人 ✓）；
 * · 该跟的时候没跟 ⇒ 新消息在屏幕外 ✓，用户以为"卡住了" ✓
 *   （这正是本轮截图暴露的那个 bug：滚动容器改了，`scrollTop` 还设在旧元素上 ✗）。
 *
 * @param {{scrollTop:number, scrollHeight:number, clientHeight:number}} metrics 追加**之前**量 ✓
 * @param {number} nearBottomPx 离底部多近算"还在跟" ✓（默认 80）
 */
export function shouldAutoScroll(metrics, nearBottomPx) {
  const threshold = typeof nearBottomPx === 'number' && nearBottomPx >= 0 ? nearBottomPx : 80
  if (metrics === null || typeof metrics !== 'object') return true
  const top = typeof metrics.scrollTop === 'number' ? metrics.scrollTop : 0
  const height = typeof metrics.scrollHeight === 'number' ? metrics.scrollHeight : 0
  const client = typeof metrics.clientHeight === 'number' ? metrics.clientHeight : 0
  if (height <= 0 || client <= 0) return true // 量不出来 ⇒ 当作"在跟" ✓（宁可跟到底 ✓）
  return height - top - client <= threshold
}

/**
 * 会话列表与切换的纯判断 ✓（不碰 DOM ⇒ 能断言 ✓）。
 *
 * ## 三条规矩
 *
 * 1. ★ **切换时不清屏** ✗：切走的瞬间旧内容**留在原地** ✓，等新会话的**第一批**到了才替换 ✓ ——
 *    否则就是"点了名字 ⇒ 白屏一下 ⇒ 内容出来" ✓（本项目对"白屏一下"一贯是零容忍 ✓）。
 * 2. ★ **草稿按会话分开存** ✓：在 A 里打了一半、切到 B、再切回 A ⇒ **字还在** ✓
 *    （全局一个草稿框就会把 A 的字弄丢 ✗，而这与"发失败丢字"是同一类伤害 ✓）。
 * 3. 列表顺序**稳定** ✓：正在跑 / 等审批的排前面 ✓（那时用户最需要找到它 ✓），
 *    其余按最近更新降序 ✓，同分按 id ✓（**不许靠运气** ✗ —— 每次刷新都换位置等于点不准 ✓）。
 */

/** 会话列表排序 ✓（不改原数组 ✓）。`running`/`awaitingApproval` 优先 ✓，再按 `updatedAt` 降序 ✓。 */
export function sortSessions(sessions) {
  const list = Array.isArray(sessions) ? sessions.slice() : []
  const rank = (item) => {
    if (item === null || typeof item !== 'object') return 2
    if (item.awaitingApproval === true) return 0
    if (item.running === true) return 1
    return 2
  }
  return list.sort((a, b) => {
    const ra = rank(a)
    const rb = rank(b)
    if (ra !== rb) return ra - rb
    const ta = a !== null && typeof a === 'object' && typeof a.updatedAt === 'number' ? a.updatedAt : 0
    const tb = b !== null && typeof b === 'object' && typeof b.updatedAt === 'number' ? b.updatedAt : 0
    if (ta !== tb) return tb - ta
    const ia = a !== null && typeof a === 'object' && typeof a.id === 'string' ? a.id : ''
    const ib = b !== null && typeof b === 'object' && typeof b.id === 'string' ? b.id : ''
    return ia < ib ? -1 : ia > ib ? 1 : 0
  })
}

/** 过滤 ✓（空查询 ⇒ 全部 ✓；标题与 id 都不含才算不匹配 ✓；大小写不挑 ✓）。 */
export function filterSessions(sessions, query) {
  const list = Array.isArray(sessions) ? sessions : []
  const needle = typeof query === 'string' ? query.trim().toLowerCase() : ''
  if (needle.length === 0) return list
  return list.filter((item) => {
    if (item === null || typeof item !== 'object') return false
    const title = typeof item.title === 'string' ? item.title.toLowerCase() : ''
    const id = typeof item.id === 'string' ? item.id.toLowerCase() : ''
    return title.includes(needle) || id.includes(needle)
  })
}

/**
 * ★ 新到的一批事件该**替换**还是**追加** ✓。
 *
 * ★★ 判据是"**切换之后的第一趟回应**"，不是"这一趟有内容" ✗ ——
 *   我原先写的是后者 ✓，结果：切到一个**空会话**时，旧会话的消息会**一直留在屏上** ✗
 *   （"成功返回了空"本来就是一句明确的话："这个会话没有内容"✓，该清就清 ✓）。
 *   而"切换**还没**收到任何回应"那段时间仍然留着旧内容 ✓ —— 那才是要避免白屏的那一段 ✓。
 *
 * @param {boolean} pendingSwitch 正等着切换 ✓
 * @param {boolean} sawResponse 切换之后**是否已经收到过**一趟回应 ✓
 */
export function resolveDelivery(pendingSwitch, sawResponse, events) {
  void events
  if (pendingSwitch === true && sawResponse !== true) return 'replace'
  return 'append'
}

/** 草稿柜：**按会话存** ✓（纯函数式：给一份进、还一份新的出 ✓，方便断言 ✓）。 */
export function putDraft(drafts, sessionId, text) {
  const next = drafts !== null && typeof drafts === 'object' ? { ...drafts } : {}
  const key = typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : ''
  if (key.length === 0) return next
  const value = typeof text === 'string' ? text : ''
  if (value.length === 0) delete next[key]
  else next[key] = value
  return next
}

/** 取某个会话的草稿 ✓（没有就是空串 ✓）。 */
export function getDraft(drafts, sessionId) {
  if (drafts === null || typeof drafts !== 'object') return ''
  const value = drafts[sessionId]
  return typeof value === 'string' ? value : ''
}

/**
 * 输入区的三条纯判断 ✓（不碰 DOM ⇒ 能断言 ✓）。
 *
 * ## ★ 最要紧的一条规矩：**发出去的字不许凭空消失** ✗
 *
 * "点了发送 ⇒ 输入框清空 ⇒ 结果没发出去 ⇒ 字没了" ✓ 是聊天页最气人的一种失败 ✓
 * （用户刚打完一长段，还得重打 ✗）。⇒ 本文件的口径是：
 * **清空要立刻**（手感 ✓）、**但那份内容先留着**（{@link sendBegin} ✓），
 * **失败就原样放回去**（{@link sendSettled} ✓）并明说"字还在输入框里" ✓。
 */

/** 现在能不能发 ✓（空 / 空白 / 正在发 / 断线 ⇒ 都不能 ✓ —— 别让用户按了没反应 ✗）。 */
export function canSend(input) {
  const text = input !== null && typeof input === 'object' && typeof input.text === 'string' ? input.text : ''
  if (text.trim().length === 0) return false
  if (input !== null && typeof input === 'object' && input.sending === true) return false
  if (input !== null && typeof input === 'object' && input.connection === 'offline') return false
  return true
}

/** 输入框高度：跟着内容长，但夹在 `min..max` 之间 ✓（超过就自己滚 ✓，不许把消息区挤没 ✗）。 */
export function composerHeight(scrollHeightPx, minPx, maxPx) {
  const raw = typeof scrollHeightPx === 'number' && scrollHeightPx > 0 ? scrollHeightPx : 0
  const min = typeof minPx === 'number' && minPx > 0 ? minPx : 0
  const max = typeof maxPx === 'number' && maxPx > 0 ? maxPx : 0
  if (max <= 0) return Math.max(min, raw)
  if (raw < min) return min
  if (raw > max) return max
  return raw
}

/**
 * 按下发送的那一刻 ✓：**输入框立刻清空**（手感 ✓），但把原文**留一份** ✓。
 *
 * @returns {{ draft: string, pending: string }}
 */
export function sendBegin(text) {
  const value = typeof text === 'string' ? text : ''
  return { draft: '', pending: value }
}

/**
 * 这一次发完了 ✓：成功 ⇒ 那份留存丢掉 ✓；失败 ⇒ **原文放回输入框** ✓ + 一句说明 ✓。
 *
 * @param {boolean} ok
 * @param {string} pending
 * @returns {{ draft: string, pending: null, error: string }}
 */
export function sendSettled(ok, pending) {
  const value = typeof pending === 'string' ? pending : ''
  if (ok === true) return { draft: '', pending: null, error: '' }
  return { draft: value, pending: null, error: '' }
}

/** 失败时给用户的那句话 ✓（**别只说"失败"** ✗ —— 要说清字还在 ✓）。 */
export function sendFailureHint(message) {
  const why = typeof message === 'string' && message.length > 0 ? message : '没发出去'
  return '没发出去：' + why + '（字还在输入框里）'
}

/**
 * 那四格的**键**与顺序 ✓（纯 ASCII ✓ —— 验收按 `data-cell="<key>"` 定位那一格 ✗）。
 *
 * ★ 顺序 = 真图顺序 ✓：上下文% → 轮 → 步 → tok ✓
 *   （DSH 自己那一行是「换成 1 个比例格 + 2 颗药丸」的排法 ✓，
 *   见 `StatsPills` + `ContextMeter` ✓ —— 逐条读数见报告第 1 节 ✓）。
 */
export const STATS_CELL_KEYS = Object.freeze(['context', 'turns', 'steps', 'tokens'])

/** ★ 上下文那格的环：14px viewBox、半径 5.5、描边 2px ✓（逐字抄自 `ContextMeter` ✓）。 */
export const STATS_RING_RADIUS = 5.5
/** 环的周长 ✓（`stroke-dasharray` 的第二个数就用它 ✓ —— 与 DSH 同一条算式 ✓）。 */
export const STATS_RING_CIRCUMFERENCE = 2 * Math.PI * STATS_RING_RADIUS
/** token 求和要的**四个桶** ✓（名字取自 `dsh-token-meter` 的投影 ✓，一个不许漏 ✗）。 */
const TOKEN_BUCKETS = Object.freeze(['uncachedInputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens'])

/** 只认**真对象** ✓（数组 / `null` / 标量一律不认 ✗ —— 与桥那一层同一条纪律 ✓）。 */
function recordOf(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null
}

/**
 * 取一个**非负安全整数** ✓（取不到 ⇒ `null` ✓ —— **绝不补 0** ✗）。
 *
 * ★ 这一行就是"键不存在 = 数据取不到"那条铁律的落点 ✓：
 *   `0` 是**合法值**（⇒ 返回 `0` ✓），而"没有这个键 / 不是整数 / 是负数"
 *   一律 `null` ✓ ⇒ 调用方据此**不画那一格** ✗。
 */
function countOf(source, key) {
  const record = recordOf(source)
  const value = record === null ? undefined : record[key]
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

/**
 * token 总数怎么念 ✓（纯函数 ✓）—— ★ 判据**逐字抄自** DSH 自己的客户端 ✗，不是我们定的 ✓：
 *
 * · `@deepseek-ai/dsh-client-ui-chat/lib/client.js` 的 `formatTokens()` ✓；
 * · `@deepseek-ai/dsh-client-ui-conversation/lib/client.js` 里那个**同名同体**的函数 ✓
 *   （两份独立文件逐字相同 ⇒ 这条口径不是某一处的笔误 ✓）。
 *
 * ```
 * scaled = c >= 100 ? round(c) : round(c*10)/10        // ★ ≥100 取整、否则一位小数 ✓
 * value < 1e3  ⇒ 原数 ✓
 * value < 1e6  ⇒ scaled(value/1e3) + 「K」✓
 * 否则          ⇒ scaled(value/1e6) + 「M」✓
 * ```
 * 单位后缀取自语言包 ✓（`"number.thousand": "{value}K"` / `"number.million": "{value}M"` ✓）。
 * ★ 认不出（负数 / `NaN` / 不是数）⇒ 空串 ✓（调用方据此不画那一格 ✗）。
 */
export function formatTokenCount(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return ''
  const scaled = (candidate) => (candidate >= 100 ? String(Math.round(candidate)) : String(Math.round(candidate * 10) / 10))
  if (value < 1e3) return String(value)
  if (value < 1e6) return scaled(value / 1e3) + 'K'
  return scaled(value / 1e6) + 'M'
}

/**
 * 输入框**正下方那一行状态条**该画哪几格 ✓（纯函数 ✓ —— 不碰 DOM ⇒ 能单测 ✓）。
 *
 * ## 四格的官方口径（★ 逐条抄自 DSH 自己的客户端 ✗，不是我们定的 ✓）
 *
 * | 格子 | 读 | 口径 |
 * |---|---|---|
 * | 上下文% | `values.contextPressure` | `used = projectedTokens ?? pressureTokens` ✓；`min(100, round(used / contextWindow × 100))` + `%` ✓ |
 * | 轮 | `values.sessionStats.turns` | 整数 + 「轮」✓ |
 * | 步 | `values.sessionStats.steps` | 整数 + 「步」✓ |
 * | tok | `values.tokenUsage` **四个桶求和** | 见 {@link formatTokenCount} ✓ |
 *
 * 出处（都在 `app.asar` 里读出来 ✓）：
 * · 百分比 ⇒ `dsh-client-ui-conversation/lib/client.js` 的 `contextOccupancy()` ✓
 *   （`projectedTokens ?? pressureTokens` ✓；缺 used 或 `contextWindow` ⇒ 返回 `null` ⇒
 *   **那一格不画** ✗ —— 同一条纪律我们照抄 ✓）；
 * · 轮 / 步 / 求和 ⇒ `dsh-client-ui-chat/lib/client.js` 的 `StatsPills()` ✓
 *   （`billedInputTokens(usage) + usage.outputTokens` ✓，其中
 *   `billedInputTokens = uncachedInputTokens + cacheReadTokens + cacheWriteTokens` ✓）；
 * · 文案 ⇒ 同包中文语言包 `"stats.counts": "{turns} 轮 {steps} 步"` ✓。
 *
 * ## ★★ 铁律：**键不存在 = 数据取不到 = 那一格不画** ✗
 *
 * 不许退化成 `0` ✗、不许填编造的值 ✗；而 DSH **自己报的真实 0**（例如 `turns: 0`）
 * **照常显示 `0 轮`** ✓ —— "没有这个数"与"这个数是 0"是两件事 ✓。
 * 取不到 ⇒ 这一格**整个不产出** ✓ ⇒ 调用方（`renderStatsStrip` ✓）据此决定整条要不要占高度 ✓。
 *
 * ★ 比 DSH 多一道守卫 ✗：`tokenUsage` 的四个桶**必须都在**才算得出那一格 ✓ ——
 *   少一个桶的"和"是一个**偏小的假数** ✓（桥那边的字段真形状是四个都在 ✓；
 *   真要缺了，宁可这一格不画 ✗，也不报一个错的 tok 数 ✗）。
 *
 * @param {unknown} values `boot.chatProjections().values` ✓（**可能有、可能没有**的键 ✓）
 * @returns {Array<{key: string, text: string, percent?: number}>} 只含**取得到**的那几格 ✓（顺序固定 ✓）
 */
export function statsCells(values) {
  const source = recordOf(values)
  const cells = []

  // ① 上下文% ✓（`used` 或 `contextWindow` 任一取不到 ⇒ 这一格不画 ✗）
  const pressure = source === null ? null : recordOf(source.contextPressure)
  if (pressure !== null) {
    const projected = countOf(pressure, 'projectedTokens')
    const reported = countOf(pressure, 'pressureTokens')
    const used = projected !== null ? projected : reported
    const window = countOf(pressure, 'contextWindow')
    if (used !== null && window !== null && window > 0) {
      const percent = Math.min(100, Math.round((used / window) * 100))
      cells.push({ key: 'context', text: percent + '%', percent })
    }
  }

  // ② 轮 / ③ 步 ✓（各自独立取 ✓ —— 一个取不到不影响另一个 ✓）
  const stats = source === null ? null : recordOf(source.sessionStats)
  const turns = countOf(stats, 'turns')
  if (turns !== null) cells.push({ key: 'turns', text: turns + ' 轮' })
  const steps = countOf(stats, 'steps')
  if (steps !== null) cells.push({ key: 'steps', text: steps + ' 步' })

  // ④ tok ✓（四个桶求和 ✓ —— 少一个桶就不算这一格 ✗）
  const usage = source === null ? null : recordOf(source.tokenUsage)
  if (usage !== null) {
    const buckets = TOKEN_BUCKETS.map((key) => countOf(usage, key))
    if (buckets.every((count) => count !== null)) {
      const total = buckets.reduce((sum, count) => sum + count, 0)
      const text = formatTokenCount(total)
      if (text.length > 0) cells.push({ key: 'tokens', text: text + ' tok' })
    }
  }

  return cells
}

/** 四格拼成一行字 ✓（**只给日志/排障念** ✗ —— DOM 那条路是 {@link mountChat} 里现搭的 ✓）。 */
export function statsStripText(values) {
  return statsCells(values)
    .map((cell) => cell.text)
    .join(' · ')
}

/**
 * 状态行**该显示哪一句** ✓（纯函数 ✓）。
 *
 * ★★ 优先级：**错误/断线 > 一次性提示 > 正常读数** ✗ ——
 *   这一条是被端到端检查逼出来的 ✓：我第 17 轮定的是"提示只由用户的下一次动作清掉"✓，
 *   本意是别让轮询把"没发出去"冲掉 ✓；可它太绝对了 ⇒
 *   **一条过期的提示能把真实错误永久盖住** ✓ ——
 *   现场就是：读取一直在失败 ✓，而状态行始终写着上一次的"已发出" ✓（页面装作没事 ✓）。
 *   ⇒ 现在的规矩：**错误/断线一出现，提示立刻作废** ✓（它本来就该让位 ✓）；
 *     而正常读数**不许**盖掉提示 ✓（"没发出去"要留到用户下次动作 ✓，这条原来就对 ✓）。
 */
export function resolveStatusLine(input) {
  const notice = input !== null && typeof input === 'object' && typeof input.notice === 'string' ? input.notice : ''
  const problem = input !== null && typeof input === 'object' && typeof input.problem === 'string' ? input.problem : ''
  const normal = input !== null && typeof input === 'object' && typeof input.normal === 'string' ? input.normal : ''
  if (problem.length > 0) return problem
  if (notice.length > 0) return notice
  return normal
}

/**
 * 这一页**现在该显示哪种状态** ✓（纯函数 ✓ —— 不碰 DOM ⇒ 能断言 ✓）。
 *
 * ## ★ 一条压倒一切的规矩：**已经有内容时，错误与断线只进状态行，绝不覆盖画面** ✗
 *
 * "读取出错 ⇒ 白屏一下"是这一页最糟的表现 ✓：用户正在读的输出突然没了、
 * 滚动位置也没了 ✓，而真正的原因（一次超时 / 一次重连 ✓）**根本不该动画面** ✓。
 * ⇒ 只要 `eventCount > 0`，就永远是 `ready` ✓，错误与断线只体现在 `statusText` 里 ✓。
 *
 * @param {{ loading?: boolean, eventCount?: number, error?: string, connection?: 'online'|'offline'|'unknown' }} input
 * @returns {{ kind: string, title: string, hint: string, showInList: boolean, statusText: string }}
 */
export function computePageState(input) {
  const loading = input !== null && typeof input === 'object' && input.loading === true
  const error = input !== null && typeof input === 'object' && typeof input.error === 'string' ? input.error : ''
  const connection = input !== null && typeof input === 'object' ? input.connection : 'unknown'
  const count = input !== null && typeof input === 'object' && typeof input.eventCount === 'number' ? input.eventCount : 0
  const offline = connection === 'offline'

  if (count > 0) {
    // ★ 有内容 ⇒ 只更新状态行（错误优先于断线：它更具体 ✓）
    const statusText = error.length > 0
      ? '读取出错：' + error + '（已读到的都还在）'
      : offline
        ? '断线，正在重连…（已读到的都还在）'
        : ''
    return { kind: 'ready', title: '', hint: '', showInList: false, statusText }
  }

  if (loading) {
    return { kind: 'loading', title: '正在读取…', hint: '第一次连这台电脑会慢一点', showInList: true, statusText: '' }
  }
  if (error.length > 0) {
    return {
      kind: 'error',
      title: '读不出来',
      hint: error + '（点右上角刷新重试）',
      showInList: true,
      statusText: '读取出错：' + error,
    }
  }
  if (offline) {
    return {
      kind: 'offline',
      title: '连不上这台电脑',
      hint: '确认手机和它在同一个网络，或点右上角刷新重试',
      showInList: true,
      statusText: '断线，正在重连…',
    }
  }
  return { kind: 'empty', title: '还没有内容', hint: '在下面发一条试试', showInList: true, statusText: '' }
}

/**
 * 把整页接起来 ✓（取数循环 + 渲染 + 输入框）。
 *
 * @param {{ root: HTMLElement, poller: any, send: (text: string) => Promise<any>, onStatus?: (text: string) => void }} options
 */
export function mountChat(options) {
  const root = options.root
  const list = root.querySelector('#messages')
  let projection = createProjection('')
  /**
   * ★ 钩子是**外面装的** ✓（`globalThis.__DSHM_CHAT_PAGE__.measure` ✓）——
   *   页面自己**不定义**它 ✓：没装的时候 `typeof measure !== 'function'` ⇒ 一个字节都不做 ✓
   *   （生产页面上不花这份钱 ✓，而验收与真机调试框装得上 ✓）。
   * ★★ **每次现取，不许在装配时缓存** ✗：验收那一套是**先让页面跑完一整帧、
   *   再把钩子装上**的 ✓（`--dump-dom` 只给一帧 ✓，见本文件头那两条实测 ✓）——
   *   缓存下来就是"钩子永远装不上"✓，而那看起来完全像"这一条验过了"✗。
   */
  const measure = (record) => {
    const hook = globalThis.__DSHM_CHAT_PAGE__
    if (hook === null || hook === undefined || typeof hook.measure !== 'function') return
    try {
      hook.measure(record)
    } catch (error) {
      void error
    }
  }
  const dock = root.querySelector('#interactions')
  const form = root.querySelector('#composer')
  const input = root.querySelector('#input')
  const status = root.querySelector('#status')
  const stateBox = root.querySelector('#state')
  const refresh = root.querySelector('#refresh')
  /**
   * ★★ 输入框**正下方**那一行紧凑状态条 ✓ —— 四格：上下文% / 轮 / 步 / tok ✓。
   *
   * ## 数据从哪来（★ 页面侧**只有**这一个入口 ✗）
   *
   * `boot.chatProjections()` ✓（`app.js:456` ✓）⇒ `{asOfSeq, values}` ✓ ——
   * 宿主那条流路由把**开场快照自带的投影**接进去 ✓（`rememberProjections` ✓）。
   * ★ 每次 `paint()` **现取** ✓、不缓存 ✗：投影是"每个会话第一帧一次"✓，
   *   缓存它就会在切会话之后还念上一个会话的数 ✓（在手机上完全看不出来 ✗）。
   * ★ 取不到（老宿主 / 没有投影 / 桥还没接上 ✓）⇒ `null` ✓ ⇒ 四格全部不画 ✓。
   *
   * ## ★★ 四格全取不到 ⇒ 这条**不占高度** ✗
   *
   * 这是**故意**的 ✓，也正是这条口径与改前那条注释的关系 ✗：改前这一行只会写
   * 「窗口内已读 N 条 · 在线」✓ ⇒ **恒有字** ✓ ⇒ 它的前提是"绝不会塌成 0 高"✓。
   * 现在这一行**会**塌（没有投影时 ✓），所以：
   *   · `hidden` 走 `display:none` ✓（`.stats-strip[hidden]` 那条规则是**必须的** ✗ ——
   *     与 `#messages[hidden]` / `#sessions[hidden]` 同一个坑：作者样式的 `display:flex`
   *     会盖掉 UA 的 `[hidden]` ✓ ⇒ 不写就是"藏着还占 22px"✓）；
   *   · ★ 于是**几何断言必须跑在"有投影"的那一档上** ✗ —— 在有投影的夹具里量高度 ✓；
   *     没有投影的那一档量的是"塌陷"（`display:none` + 高 0 ✓），不是"这条有多高" ✓
   *     （本仓原话：空串会让这一条塌成 0 高 ⇒ 几何就量不到了 ✗ —— 现在这一条**是**要量的那条 ✓）。
   *
   * 点击详情使用同一份完整会话投影；不从已挂载的消息节点统计。
   */
  const statsStrip = root.querySelector('#stats-strip')
  const nativeStatistics = mountStatistics({ root, getValues: () => projection.snapshot().values })
  const nativeManagement = typeof options.manage === 'function' ? mountManagement({ root, backend: 'dsh', call: options.manage, boot: globalThis.__DSH_MOBILE_BOOT__ }) : null
  /**
   * ★ 上一次画进 DOM 的那四格（`null` = 还没画过 ✓）。
   *
   * ★ 为什么要它 ✗：`paint()` 会被**每一批事件**触发 ✓，而四格的值一小时也不变一次 ✓
   *   ⇒ 不挡住就是"每条消息都重建一次 DOM"✓（白烧电 ✓，还会把环的过渡打断 ✗）。
   * ★ 初值必须是 `null` 而**不是** `''` ✗：空串与"四格全没有"的键**撞车** ✓
   *   ⇒ 第一次 `paint()`（那时候正好没有投影）会被当成"没变"而**跳过** ✓
   *   ⇒ `hidden` 永远不设 ⇒ 那 22px 空带一直在 ✓（塌陷那条断言也就假绿了 ✓）。
   */
  let statsDrawnKey = null
  /**
   * ★★ 「对话｜轨迹」标签栏（复刻清单第 3 项 ✓）—— 三样东西：两个 tab、两个视图层、一个读数 ✓。
   *
   * ★ 视图**不是两套数据** ✗：同一批事件同时喂给 `#messages`（对话 ✓）与 `#trace`（轨迹 ✓），
   *   只是两条**渲染路**不同 ✓（轨迹那条见 `renderTraceEvent` ✓）。
   *   ⇒ 切标签**不重画、不清屏、不重新取数** ✓ —— 切回去时对话视图还是原来那一屏 ✓
   *     （"切一下就白屏"是本仓零容忍的那一类 ✓）。
   */
  const tabs = root.querySelector('#tabs')
  const tabChat = root.querySelector('#tab-chat')
  const tabTrace = root.querySelector('#tab-trace')
  const chatView = root.querySelector('#messages')
  const traceView = root.querySelector('#trace')
  /**
   * ★ 轨迹视图里现在**画了几条** ✓（`0` ⇒ 摆一句"还没有步骤"✓）。
   *   ★ 为什么不用 `traceView.childElementCount` ✗：那就是"拿 DOM 当变量"✓ ——
   *     那句占位话自己也是一个孩子 ✓ ⇒ 数出来恒 ≥1 ⇒ 占位话**再也撤不掉** ✓。
   */
  let traceSteps = 0

  // 这一页的**输入**（三样 ✓）—— 状态完全由它们算出来 ✓（不在渲染里各写一份判断 ✗）
  let eventCount = 0
  let loading = false
  let error = ''
  let connection = 'unknown'
  /**
   * 状态行的**临时消息** ✓（"发送中…"/"已发出"/"没发出去：…"✓）。
   *
   * ★ 为什么单独一条通道 ✗：状态行平时由 `paint()` 按页面状态写 ✓，
   *   而 `paint()` 会被任何一次事件到达触发 ✓ ⇒ 临时消息必须**优先级更高** ✓，
   *   否则"没发出去：…（字还在输入框里）"会被下一趟轮询**立刻冲掉** ✗ ——
   *   用户根本没看清就没了 ✓（这跟"字丢了"是同一类伤害 ✓）。
   *   清空时机：新事件到达 ✓ / 用户点刷新 ✓ / 下一次发送 ✓。
   */
  let notice = ''
  /** 会话列表（已排序 ✓）与当前会话 id ✓ —— 由外面喂（`setSessions` ✓）。 */
  let sessions = []
  let currentSessionId = ''
  /** ★ 正等着切换（**旧内容留在原地** ✓，等新会话第一批到了才替换 ✗）。 */
  let pendingSwitch = false
  /** 切换之后是否已经收到过一趟回应 ✓（用来判"该不该把旧内容换掉"✓）。 */
  let sawResponseSinceSwitch = false
  /**
   * ★★ 裁决通道**探测到**的状态 ✓（默认 `false` ⇒ 按钮置灰 ✓ —— 不假装能用 ✗）。
   *   由 `app.js` 探一次之后喂进来 ✓（`setApprovalChannel` ✓）；
   *   ★ 探测结果可能比卡片**晚到** ✓ ⇒ 变了必须把已经画出来的卡**就地重画** ✓（见下 ✓）。
   */
  let approvalChannelConnected = false
  let questionChannelConnected = false, uploadChannelConnected = false
  /** 上一次通道探测的失败原因（'' = 探测成功）。空 ⇒ 是真没接通，非空 ⇒ 只是没问成。 */
  let channelProbeError = ''
  /** 最近一次落下的通道能力是不是**成功读到宿主**的回执（false = 还没确认过/读失败）。 */
  let channelConfirmed = false
  /** 退避重查已用尽 ⇒ 自动重查停了，提示用户可重新检测。 */
  let channelRetryExhausted = false
  let interactionValues = { active: [], settled: [] }
  const answeredQuestions = new Set()
  const questionCards = new Map()
  const questionEventIds = new Set()
  const attachmentDrafts = new Map()
  const activeAttachments = () => attachmentDrafts.get(currentSessionId) || []
  const dockChanged = () => {
    if (!dock) return
    dock.hidden = dock.children.length === 0
    // 老宿主缺应答能力时保留草稿入口；通道已接通的待办接管输入区。
    if (form) form.hidden = !dock.hidden && (approvalChannelConnected || questionChannelConnected)
  }
  /**
   * ★ 那本账之一：`requestId ⇒ 那条 approval/decided` ✓。
   *   ★ 为什么非得有它 ✗：裁决事件可能比那张卡**晚到** ✓（页面是分批轮询的 ✓），
   *     而画出来的卡不会自己变 ✓ ⇒ 缺了它就会出现"这条已经处理过了、按钮还在"✓
   *     —— 这正是那条**硬编码 `null`** 造成的第二条断链 ✓
   *     （`toApprovalViewModel(event, null)` ⇒ `decided` 永远是 `false` ✓）。
   */
  const decidedApprovals = new Map()
  /** ★ 那本账之二：`requestId ⇒ {wrapper, event}` ✓（"屏幕上还真挂着这几张待办的卡"✓）。 */
  const drawnApprovals = new Map()

  /** 画一张审批卡要的上下文 ✓（**每次现取** ✓ —— 缓存它就是"状态变了卡不变"那类 bug ✓）。 */
  const approvalContext = () => ({
    channelConnected: approvalChannelConnected && typeof options.answerApproval === 'function',
    decidedFor: (event) => {
      const id = approvalIdOf(event)
      return id.length > 0 ? decidedApprovals.get(id) : undefined
    },
    dock, dockChanged,
    isQuestionEvent: event => {
      const data = event.data || {}
      if ((event.type === 'tool/call' || event.type === 'tool/ptc-dispatch') && data.name === 'ask_user_question') {
        questionEventIds.add(data.callId || data.subCallId)
        return true
      }
      return event.type === 'tool/result' && questionEventIds.has(data.callId || (data.message && data.message.toolCallId))
    },
    answer: async (id, decision) => {
      const session = currentSessionId
      const result = await options.answerApproval(id, decision)
      if (session === currentSessionId && result && result.ok === true) {
        const drawn = drawnApprovals.get(id)
        if (drawn) drawn.wrapper.remove()
        drawnApprovals.delete(id)
        decidedApprovals.set(id, { type: 'approval/decided', data: { id, decision } })
        dockChanged()
      }
      return result
    },
  })

  /** 这一批里的 `approval/decided` 入账 ✓（返回**这一批新增**的那些 ✓）。 */
  const collectDecided = (events) => {
    const fresh = new Map()
    for (const event of Array.isArray(events) ? events : []) {
      const type = event !== null && typeof event === 'object' ? String(event.type || '') : ''
      if (type !== 'approval/decided') continue
      const id = approvalIdOf(event)
      if (id.length === 0) continue
      decidedApprovals.set(id, event)
      fresh.set(id, event)
    }
    return fresh
  }

  /** 就地重画一张已经画出来的审批卡 ✓（裁决到了 / 通道状态变了 ✓）。 */
  const redrawApproval = (wrapper, event, decided) => {
    if (wrapper === null || wrapper === undefined || typeof wrapper.querySelector !== 'function') return
    const existing = wrapper.querySelector('.approval')
    if (existing === null || existing === undefined) return
    existing.replaceWith(approvalCard(toApprovalViewModel(event, decided === undefined ? null : decided), approvalContext()))
  }

  /** 裁决到了 ⇒ 把**屏幕上那几张待办的卡**就地改成"已处理"✓（摘按钮 ✓，不必等重画 ✗）。 */
  const settleDrawnApprovals = (fresh) => {
    for (const [id, decided] of fresh) {
      const drawn = drawnApprovals.get(id)
      if (drawn === undefined) continue
      drawnApprovals.delete(id)
      drawn.wrapper.remove()
      dockChanged()
    }
  }

  /**
   * 把**刚刚画出来**的审批卡登记进账 ✓（只登记还没登记的 ✓）。
   * ★ 用 `data-request` 从 DOM 里认 ✓，而不是让 `renderEvent` 往回调里写 ✗ ——
   *   画卡那条路是纯函数 ✓（`appendEvents`/`renderEvent` 不碰页面状态 ✓）。
   */
  const registerDrawnApprovals = (events) => {
    const container = dock || list
    if (typeof container.querySelectorAll !== 'function') return
    for (const card of container.querySelectorAll('.approval[data-request]')) {
      const id = String(card.getAttribute('data-request') || '')
      if (id.length === 0 || drawnApprovals.has(id)) continue
      const asked = (Array.isArray(events) ? events : []).filter((event) => approvalIdOf(event) === id)[0]
      if (asked === undefined) continue
      const wrapper = typeof card.closest === 'function' ? card.closest('.ev') : card.parentElement
      if (wrapper !== null && wrapper !== undefined) drawnApprovals.set(id, { wrapper, event: asked })
    }
  }

  /**
   * 通道状态变了 ⇒ **已经画出来的卡也要跟着变** ✓（否则"探测晚到"就白探了 ✗：
   * 卡片会永远停在置灰 ✓ —— 而那看起来完全像"功能没做"✓）。
   */
  const setApprovalChannel = (connected) => {
    const next = connected === true
    if (next === approvalChannelConnected) return
    approvalChannelConnected = next
    dockChanged()
    for (const [id, drawn] of [...drawnApprovals]) {
      redrawApproval(drawn.wrapper, drawn.event, decidedApprovals.get(id))
    }
  }
  const renderQuestion = entry => {
    if (!dock || !entry || typeof entry.callId !== 'string' || !Array.isArray(entry.questions)) return
    const signature = JSON.stringify(entry)
    const previous = questionCards.get(entry.callId)
    if (previous && previous.signature === signature) return
    if (previous) previous.node.remove()
    const card = document.createElement('form')
    card.className = 'question-card'
    card.setAttribute('data-call-id', entry.callId)
    const title = document.createElement('div')
    title.className = 'question-title'
    title.textContent = entry.state === 'continued' ? '等待你的选择（任务已继续）' : '等待你的选择'
    card.appendChild(title)
    const fields = []
    for (const q of entry.questions) {
      const field = document.createElement('fieldset')
      const legend = document.createElement('legend')
      legend.textContent = q.question || q.header || q.id
      field.appendChild(legend)
      if (q.detail) { const detail = document.createElement('p'); detail.textContent = q.detail; field.appendChild(detail) }
      const inputs = []
      const custom = document.createElement('textarea')
      custom.rows = 1
      custom.placeholder = '补充或自行填写'
      custom.setAttribute('aria-label', (q.header || q.question || q.id) + ' 自定义回答')
      custom.disabled = !questionChannelConnected
      for (const option of Array.isArray(q.options) ? q.options : []) {
        const label = document.createElement('label')
        label.className = 'question-option'
        const choice = document.createElement('input')
        choice.type = q.multiSelect ? 'checkbox' : 'radio'
        choice.name = entry.callId + ':' + q.id
        choice.value = option.label
        choice.disabled = !questionChannelConnected
        const text = document.createElement('span')
        text.textContent = option.label
        if (option.description) { const detail = document.createElement('small'); detail.textContent = option.description; text.appendChild(detail) }
        label.append(choice, text)
        choice.addEventListener('change', () => { if (!q.multiSelect) custom.value = ''; updateSubmit() })
        inputs.push(choice)
        field.appendChild(label)
      }
      custom.addEventListener('input', () => { if (!q.multiSelect && custom.value.trim()) inputs.forEach(input => { input.checked = false }); updateSubmit() })
      field.appendChild(custom)
      fields.push({ q, inputs, custom })
      card.appendChild(field)
    }
    const submit = document.createElement('button')
    submit.type = 'submit'
    submit.className = 'question-submit'
    submit.textContent = '提交选择'
    const why = document.createElement('div')
    why.className = 'question-status'
    why.setAttribute('role', 'status')
    why.textContent = questionChannelConnected ? '' : '选择应答通道未接通（请重开 DeepSeek Harness）'
    card.append(submit, why)
    let busy = false
    const updateSubmit = () => { submit.disabled = busy || !questionChannelConnected || !fields.length || fields.some(f => !f.inputs.some(i => i.checked) && !f.custom.value.trim()) }
    updateSubmit()
    card.addEventListener('submit', async event => {
      event.preventDefault()
      if (submit.disabled || typeof options.answerQuestion !== 'function') return
      const answers = fields.map(f => ({ id: f.q.id, selected: f.inputs.filter(i => i.checked).map(i => i.value), ...(f.custom.value.trim() ? {custom:f.custom.value.trim()} : {}) }))
      const session = currentSessionId
      busy = true
      updateSubmit()
      fields.forEach(f => [...f.inputs,f.custom].forEach(i => { i.disabled = true }))
      why.textContent = '正在提交…'
      try {
        const result = await options.answerQuestion(entry.callId, answers)
        if (session !== currentSessionId) return
        if (!result || result.accepted !== true || result.ok !== true) throw new Error('请求已处理或已超时，本次选择未被接收')
        answeredQuestions.add(entry.callId)
        questionCards.delete(entry.callId)
        card.remove()
        dockChanged()
        setNotice('选择已提交')
      } catch (error) {
        why.textContent = '没提交成功：' + (error instanceof Error ? error.message : String(error))
        busy = false
        fields.forEach(f => [...f.inputs,f.custom].forEach(i => { i.disabled = !questionChannelConnected }))
        updateSubmit()
      }
    })
    questionCards.set(entry.callId, { node: card, signature })
    dock.appendChild(card)
  }
  const setInteractions = value => {
    const questions = value && value.values ? value.values.userQuestions : value && value.userQuestions
    if (!questions || !Array.isArray(questions.active)) return
    interactionValues = questions
    const activeIds = new Set(questions.active.map(entry => entry.callId))
    for (const [id, card] of questionCards) {
      if (!activeIds.has(id)) { card.node.remove(); questionCards.delete(id) }
    }
    for (const entry of questions.active) if (!answeredQuestions.has(entry.callId)) renderQuestion(entry)
    dockChanged()
  }
  const setChannels = (channels, probe) => {
    if (!channels || typeof channels !== 'object') return
    nativeControls.setCapabilities(channels)
    setApprovalChannel(channels.approval === true)
    const changed = questionChannelConnected !== (channels.question === true)
    questionChannelConnected = channels.question === true && typeof options.answerQuestion === 'function'
    uploadChannelConnected = channels.upload === true && typeof options.upload === 'function'
    channelProbeError = typeof probe?.probeError === 'string' ? probe.probeError : ''
    channelConfirmed = probe?.confirmed === true
    channelRetryExhausted = probe?.exhausted === true
    if (changed) {
      for (const card of questionCards.values()) card.node.remove()
      questionCards.clear()
      setInteractions({ userQuestions: interactionValues })
    }
    dockChanged()
    paintComposer()
    chatLog('[dsh-chat] 交互通道：审批=' + approvalChannelConnected + ' 选择=' + questionChannelConnected + ' 附件=' + uploadChannelConnected + ' 确认=' + channelConfirmed + (channelProbeError ? ' 探测=' + channelProbeError : ''))
  }
  /** ★ 草稿柜：**按会话存** ✓（切走再切回来，字还在 ✓）。 */
  let drafts = {}
  /** ★ 由下面赋值（输入区那一段）—— `paint` 里会调它 ✓。
   *  刻意**不**用"事后包一层 paint"的写法 ✗：那既容易写成 `const` 重赋值（运行时才炸 ✓），
   *  也正是上一轮记下的坏味道（别靠改别人的东西接线 ✓）。 */
  let paintComposer = () => {}

  /**
   * 现取一次宿主给的**会话投影** ✓（`boot.chatProjections()` ✓ —— 页面侧唯一入口 ✓）。
   *
   * ★ 认不出一律 `null` ✓：老宿主没有这个函数 ✓、它抛 ✓、它给的形状不对 ✓ ——
   *   三种都当成"取不到"✓ ⇒ 四格全不画 ✓（**绝不许**因此画一个 0 ✗ 或 `-` ✗）。
   */
  const readProjectionValues = () => {
    const boot = globalThis.__DSH_MOBILE_BOOT__
    const read = boot === null || boot === undefined ? undefined : boot.chatProjections
    if (typeof read !== 'function') return null
    try {
      const snapshot = read()
      const values = snapshot !== null && typeof snapshot === 'object' ? snapshot.values : null
      return values !== null && typeof values === 'object' ? values : null
    } catch (error) {
      return null
    }
  }

  /** 沿用我们现有紧凑条的 56×6 进度条；百分比来自真实投影。 */
  const contextProgress = (percent) => {
    const bar = document.createElement('span')
    bar.className = 'stats-progress'
    bar.setAttribute('role', 'progressbar')
    bar.setAttribute('aria-label', '上下文占用')
    bar.setAttribute('aria-valuemin', '0')
    bar.setAttribute('aria-valuemax', '100')
    bar.setAttribute('aria-valuenow', String(percent))
    const fill = document.createElement('span')
    fill.className = 'stats-progress-fill'
    fill.style.width = String(percent) + '%'
    bar.appendChild(fill)
    return bar
  }

  /**
   * 把那四格画进 DOM ✓（**取不到的那一格整个不产出** ✗ —— 连分隔符也不留 ✓）。
   *
   * ★ 次序与 DOM：`span.stats-cell[data-cell=…]` 一串 ✓，两格之间一个
   *   `span.stats-sep`（「·」✓）—— 分隔符**跟着数据走** ✗（画在"前两格之间"而不是
   *   "四个位置各留一个"✓，否则缺一格时就会留下一个孤零零的「·」✓）。
   * ★ `innerHTML` 一个字都不用 ✗（这里全是自己造的字 ✓，但同一条纪律照守 ✓）。
   */
  const renderStatsStrip = () => {
    if (statsStrip === null || statsStrip === undefined) return
    const values = projection.snapshot().values
    nativeStatistics.update()
    const cells = statsCells(values)
    const key = cells.map((cell) => cell.key + '=' + cell.text).join('|')
    // ★ 内容没变 ⇒ 一个字节都不动 ✓（`paint()` 每批事件都会跑 ✓）
    if (key === statsDrawnKey) return
    statsDrawnKey = key
    /**
     * ★ 真机排障用的一行 ✓（本仓规矩：真机才现形的问题要**在调试框里留一行可念的**✗）——
     *   用户报"这一条怎么没了 / 怎么少一格"时，这一行就是答案 ✓。
     * ★ 只在**变了**的时候念 ✓（四格一小时也难得变一次 ✓ —— 不会刷屏 ✓）。
     * ★ 与 `app.js` 那句"开场快照的投影：… 三个键命中 N/3"配成一对 ✓
     *   （那句说**宿主给了什么** ✓，这句说**页面画了什么** ✓）。
     */
    try {
      chatLog(
        '[dsh-chat] 状态条：' +
          (cells.length === 0 ? '（投影取不到 ⇒ 这一条不占高度）' : statsStripText(values)),
      )
    } catch (error) {
      // ★ 念不出来也不许影响画 ✗（老壳的 console 可能被摘掉 ✓）
      void error
    }
    if (typeof statsStrip.replaceChildren === 'function') statsStrip.replaceChildren()
    else statsStrip.textContent = ''
    // ★★ 四格全取不到 ⇒ **整条不占高度** ✗（`hidden` 的 `display:none` 写在 theme.css 里 ✓）
    if (cells.length === 0) {
      statsStrip.hidden = true
      return
    }
    statsStrip.hidden = false
    for (let index = 0; index < cells.length; index += 1) {
      if (index > 0) {
        const sep = document.createElement('span')
        sep.className = 'stats-sep'
        sep.setAttribute('aria-hidden', 'true')
        sep.textContent = '·'
        statsStrip.appendChild(sep)
      }
      const cell = document.createElement('button')
      cell.type = 'button'
      cell.className = 'stats-cell'
      // ★ 纯 ASCII 的钩子 ✓（验收按它找那一格 ✓，DOM 上看不出区别 ✓）
      cell.setAttribute('data-cell', cells[index].key)
      cell.setAttribute('aria-haspopup', 'dialog'); cell.setAttribute('aria-controls', 'statistics-details'); cell.setAttribute('aria-expanded', 'false')
      cell.addEventListener('click', () => nativeStatistics.toggle(cells[index].key, cell))
      if (cells[index].key === 'context') cell.appendChild(contextProgress(cells[index].percent))
      const text = document.createElement('span')
      text.className = 'stats-text'
      text.textContent = cells[index].text
      cell.appendChild(text)
      statsStrip.appendChild(cell)
    }
  }

  const paint = () => {
    const view = computePageState({ loading, eventCount, error, connection })
    const line = resolveStatusLine({
      notice,
      // ★ 错误/断线 > 一次性提示（提示是"上一次动作的回音"，错误是"现在的事实"✓）
      problem: view.kind === 'ready' ? (view.statusText.length > 0 ? view.statusText : '') : '',
      normal: pendingSwitch ? '正在切换会话…（下面的内容还在）' : view.statusText,
    })
    if (status !== null && status !== undefined) status.textContent = line
    // ★ 输入框正下方那一行：**四格只画取得到的那几格** ✓（口径见 `statsCells` ✓、
    //   塌陷与"为什么不占高度"见 `statsStrip` 那一段 ✓）
    renderStatsStrip()
    if (typeof options.onStatus === 'function') options.onStatus(line)
    if (stateBox !== null && stateBox !== undefined) {
      stateBox.hidden = view.showInList !== true
      stateBox.innerHTML = ''
      if (view.showInList === true) {
        const card = document.createElement('div')
        card.className = 'state state-' + view.kind
        const title = document.createElement('div')
        title.className = 'state-title'
        title.textContent = view.title
        const hint = document.createElement('div')
        hint.className = 'state-hint'
        hint.textContent = view.hint
        card.appendChild(title)
        card.appendChild(hint)
        stateBox.appendChild(card)
      }
    }
    const empty = eventCount === 0 && !loading && !error && connection === 'online' && !pendingSwitch
    const app = root.querySelector('.app'), welcome = root.querySelector('#welcome')
    app?.classList.toggle('is-empty', empty)
    if (welcome) welcome.hidden = !empty
    if (tabs) tabs.hidden = empty
    if (stateBox && empty) stateBox.hidden = true
    paintComposer()
  }

  /**
   * ★ 新事件**只追加** ✓（不重画 ⇒ 滚动位置与正在输入的内容都不受影响 ✓）。
   *
   * ★★ 这两个处理器**由本函数返回** ✓，调用方再交给 `ChatPoller` ✗ ——
   *   不再"偷偷往传进来的对象上装"（2026-10-03 为此踩了**两次**同一个坑：
   *   `mountChat` 收到的是新字面量、而 poller 持有的是**另一个** options 对象 ⇒
   *   处理器根本没接上 ⇒ 画面空白、**渲染脚本的体积从 258KB 掉到 72KB 才露馅** ✗）。
   */
  // ── 会话切换：列表、草稿、切换（★ 不清屏 ✓）────────────────────────────
  const titleButton = root.querySelector('#title')
  const prepareSwitch = () => {
    if (input) drafts = putDraft(drafts, currentSessionId, String(input.value || ''))
    pendingSwitch = true; sawResponseSinceSwitch = false; notice = ''; error = ''
    paint()
  }
  const nativeNavigation = mountNavigation({
    root,
    onSwitch: (id, metadata) => { prepareSwitch(); return options.onSwitch?.(id, metadata) },
    onCreate: request => { prepareSwitch(); return options.onCreate?.(request) },
    onRename: options.rename, onFiles: typeof options.onFiles === 'function' ? () => { nativeStatistics.close(); nativeControls.back?.(); return options.onFiles() } : undefined,
    onManage: nativeManagement ? kind => { nativeStatistics.close(); nativeControls.back?.(); nativeManagement.open(kind) } : undefined,
    onBackendChange: typeof options.manage === 'function' ? backend => {
      if (backend === 'dsh') return
      if (pendingSends.size || [...attachmentDrafts.values()].some(files => files.some(file => file.uploading))) throw new Error('请等当前发送或上传结束后再切换来源')
      const ready = activeAttachments().filter(file => file.receiptId).map(({ name, size, receiptId }) => ({ name, size, receiptId, uploading: false, error: '' }))
      try { globalThis.sessionStorage?.setItem('dshm-attachments:' + currentSessionId, JSON.stringify(ready)) } catch { /* In-page drafts still remain valid. */ }
      navigateMobileBackend(backend, root)
    } : undefined,
    onRefresh: () => { loading = true; error = ''; notice = ''; paint(); return options.onRefresh?.() },
    onError: text => setNotice(text), onNotice: text => setNotice(text), onLog: chatLog,
  })
  const paintSessions = () => {
    sessions = nativeNavigation.setSessions(sessions, currentSessionId)
  }

  const nativeConversation = mountConversation({
    container: list, renderMarkdown: renderBodyInto, maxRows: MAX_DRAWN_EVENTS,
    onOlder: beforeSeq => options.onOlder?.(beforeSeq), loadAttachment: options.loadAttachment,
    onMeasure: record => measure({ ...record, trimHidden: 0, trimmed: 0, drawn: record.drawn }),
  })
  const nativeTrace = mountTrace({ container: traceView, renderMarkdown: renderBodyInto,
    onOlder: beforeSeq => options.onOlder?.(beforeSeq) })
  const nativeControls = mountComposerControls({
    root,
    getSession: () => ({ sessionId: currentSessionId, address: nativeNavigation.session(currentSessionId)?.address }),
    onCatalog: options.catalog, onSelectModel: options.selectModel, onCommand: options.command,
    onReferences: options.references, onCancel: options.cancel, onGoal: options.goal,
    onRefresh: request => options.refreshProjections?.(request),
    onSubmit: () => form?.requestSubmit(), onError: text => setNotice(text),
  })
  const mobileShell = mountMobileShell({ root, navigation: nativeNavigation, statistics: nativeStatistics, management: nativeManagement, controls: nativeControls, boot: globalThis.__DSH_MOBILE_BOOT__ })
  const drawTrace = () => { nativeTrace.show(); traceSteps = nativeTrace.count() }
  const appendTrace = () => { nativeTrace.update(projection.snapshot()); traceSteps = nativeTrace.count() }
  const applyValues = (values, metadata = {}) => {
    if (metadata.sessionId && metadata.sessionId !== currentSessionId) return
    if (values && typeof values === 'object') {
      projection.setValues(values, { asOfSeq: metadata.asOfSeq })
      const merged = projection.snapshot().values
      nativeControls.setValues(merged); nativeNavigation.setValues(merged, { sessionId: currentSessionId })
      sessions = nativeNavigation.sessions()
    }
    if (typeof metadata.hasMore === 'boolean') projection.ingest({ events: [], hasMore: metadata.hasMore })
    if (!pendingSwitch) {
      nativeConversation.update(projection.snapshot(), { preserveAnchor: metadata.preserveAnchor === true })
      appendTrace()
    }
    paint()
  }

  const showView = (which) => {
    const trace = which === 'trace'
    if (chatView !== null && chatView !== undefined) chatView.hidden = trace
    if (traceView !== null && traceView !== undefined) traceView.hidden = !trace
    if (tabChat !== null && tabChat !== undefined) {
      tabChat.classList.toggle('is-active', !trace)
      tabChat.setAttribute('aria-selected', trace ? 'false' : 'true')
    }
    if (tabTrace !== null && tabTrace !== undefined) {
      tabTrace.classList.toggle('is-active', trace)
      tabTrace.setAttribute('aria-selected', trace ? 'true' : 'false')
    }
    // ★ 从没有过步骤 ⇒ 切过去的时候才第一次摆那句占位话 ✓
    if (trace) drawTrace()
  }

  if (tabs !== null && tabs !== undefined) {
    if (tabChat !== null && tabChat !== undefined) tabChat.addEventListener('click', () => showView('chat'))
    if (tabTrace !== null && tabTrace !== undefined) tabTrace.addEventListener('click', () => showView('trace'))
  }
  // ★ 开场就按标记定一次 ✓ —— 页面上写死的 `is-active` / `aria-selected` 与这段必须一致 ✓
  showView('chat')

  /** 外面喂列表 ✓（`currentId` 变了就顺手把草稿换过来 ✓）。 */
  const setSessions = (next, currentId, titleText) => {
    sessions = nativeNavigation.setSessions(Array.isArray(next) ? next : [], currentId, titleText)
    if (typeof currentId === 'string' && currentId !== currentSessionId) {
      nativeStatistics.close(); globalThis.__DSH_MOBILE_BOOT__?.closeFiles?.()
      if (input) {
        drafts = putDraft(drafts, currentSessionId, String(input.value || ''))
        input.value = getDraft(drafts, currentId)
        try {
          if (!input.value) input.value = globalThis.sessionStorage?.getItem('dshm-route-draft:/mobile/chat:' + currentId) || ''
          if (!attachmentDrafts.has(currentId)) {
            const files = JSON.parse(globalThis.sessionStorage?.getItem('dshm-attachments:' + currentId) || '[]')
            if (Array.isArray(files)) attachmentDrafts.set(currentId, files.filter(file => typeof file?.receiptId === 'string' && file.receiptId && typeof file.name === 'string' && Number.isFinite(file.size)))
          }
        } catch { /* Session storage is optional. */ }
      }
      currentSessionId = currentId
      pendingSwitch = true; sawResponseSinceSwitch = false
      projection = createProjection(currentSessionId)
      nativeControls.setSession({ sessionId: currentSessionId, address: nativeNavigation.session(currentSessionId)?.address })
      nativeControls.setValues({})
      if (dock) dock.replaceChildren()
      questionCards.clear(); answeredQuestions.clear(); questionEventIds.clear()
      decidedApprovals.clear(); drawnApprovals.clear()
      interactionValues = { active: [], settled: [] }
      dockChanged()
    }
    paintComposer()
  }

  /** 写一条临时消息 ✓（并立刻重画 ✓）。 */
  const setNotice = (text) => {
    notice = typeof text === 'string' ? text : ''
    paint()
  }

  const handleEvents = (events) => {
    const willReplace = pendingSwitch
    if (willReplace) {
      projection = createProjection(currentSessionId)
      eventCount = 0; pendingSwitch = false; sawResponseSinceSwitch = true
      decidedApprovals.clear(); drawnApprovals.clear()
      if (dock) dock.querySelectorAll('.ev-approval').forEach(node => node.remove())
      dockChanged(); paintSessions()
    }
    const incoming = Array.isArray(events) ? events : []
    const freshDecided = collectDecided(incoming)
    for (const event of incoming) {
      approvalContext().isQuestionEvent(event)
      const requestId = approvalIdOf(event)
      if (classify(String(event.type || '')) === 'approval' && !decidedApprovals.has(requestId) && !drawnApprovals.has(requestId)) {
        const card = renderEvent(event, approvalContext())
        if (card) (dock || list)?.appendChild(card)
      }
    }
    projection.ingest(incoming)
    nativeControls.setValues(projection.snapshot().values)
    const snapshot = projection.snapshot()
    eventCount = snapshot.records.filter(record => record.visible !== false && ['user', 'assistant', 'tool', 'error'].includes(record.kind)).length
    if (incoming.length) error = ''
    nativeConversation.update(snapshot)
    appendTrace()
    registerDrawnApprovals(incoming); settleDrawnApprovals(freshDecided)
    measure({ replaced: willReplace, batch: incoming.length, drawn: nativeConversation.limits().drawn, projected: snapshot.records.length })
    loading = false; paint()
  }
  const handleError = (message) => {
    // ★ 出错**不清屏** ✗ —— 有内容就走状态行 ✓，没内容才占屏 ✓（判据在 computePageState 里）
    error = message
    loading = false
    // ★★ 并且把一次性提示**收走** ✗ —— 否则一条过期的"已发出"会把真实错误永久盖住 ✓
    //   （端到端检查抓到的真事：读取一直在失败，状态行却始终写着"已发出"✓）
    notice = ''
    paint()
  }

  // ── 输入区：清空要立刻（手感 ✓），但失败**把字放回去**（见 canSend/sendBegin/sendSettled ✓）──
  const pendingSends = new Set()
  /**
   * ★ 发送键 = `form` 里那颗 `button` ✓ —— **取法与改前逐字相同** ✗
   *   （原来那颗是方块文字「发送」✓，现在换成了圆形箭头 ✓，但那**不影响**这条取值 ✓）。
   */
  const sendButton = form === null || form === undefined ? null : form.querySelector('button[type=submit]')

  const growInput = () => {
    if (input === null || input === undefined || input.style === undefined) return
    try {
      input.style.height = 'auto'
      // ★ 上下限跟着新几何走 ✓（原来是 38/132 ✓，那是旧方块输入框的高度 ✓）：
      //   单行 min-height 20px（CSS 里那一条 ✓）、长到 132px 就自己滚 ✓ —— 不许把消息区挤没 ✗
      input.style.height = composerHeight(input.scrollHeight, 20, 132) + 'px'
    } catch (error) {
      void error
    }
  }

  const attachmentsBox = root.querySelector('#attachments')
  const attachmentInput = root.querySelector('#attachment-input')
  const attachButton = root.querySelector('[data-tool=attach]')
  const paintAttachments = () => {
    const sending = pendingSends.has(currentSessionId)
    if (!attachmentsBox) return
    attachmentsBox.replaceChildren()
    const files = activeAttachments()
    attachmentsBox.hidden = !files.length
    for (const file of files) {
      const chip = document.createElement('div')
      chip.className = 'attachment-chip' + (file.error ? ' is-error' : '')
      const text = document.createElement('span')
      text.textContent = file.name + (file.uploading ? ' · 上传中…' : file.error ? ' · ' + file.error : ' · ' + file.size + ' 字节')
      chip.appendChild(text)
      if (file.error && file.source) {
        const retry = document.createElement('button'); retry.type = 'button'; retry.textContent = '重试'; retry.disabled = sending || connection !== 'online'
        retry.setAttribute('aria-label', '重试上传 ' + file.name)
        retry.addEventListener('click', () => { void uploadAttachment(currentSessionId, file) }); chip.appendChild(retry)
      }
      const remove = document.createElement('button')
      remove.type = 'button'
      remove.textContent = '×'
      remove.setAttribute('aria-label', '移除附件 ' + file.name)
      remove.disabled = sending
      remove.addEventListener('click', () => {
        attachmentDrafts.set(currentSessionId, activeAttachments().filter(entry => entry !== file))
        paintComposer()
      })
      chip.appendChild(remove)
      attachmentsBox.appendChild(chip)
    }
  }
  const attachmentBlocked = () => {
    const address = nativeNavigation.session(currentSessionId)?.address
    if (address?.kind === 'subagent' && address.mode !== 'continuable') return '此子智能体仅支持查看'
    if (!currentSessionId) return '请先选择或新建会话'
    if (connection !== 'online') return '电脑尚未连接，请连接后添加附件'
    if (!uploadChannelConnected) {
      // ★ 2026-10-12 修：按真实状态分层，**不猜也不劝重装** ✗ ——
      //   · 没问成（探测失败）      ⇒ 暂时联系不上，会自动重查；
      //   · 还没确认过 / 初始化中   ⇒ 正在确认，页面会自动重查；
      //   · 已确认仍未就绪且重试用尽 ⇒ 如实说仍未就绪，并给出「可重新检测」的出路；
      //   · 已确认宿主没有该服务    ⇒ 如实说没有，**不给泛化的重装建议**（重装未必解决注册时序）。
      if (channelProbeError) return '附件通道暂时联系不上电脑（' + channelProbeError + '），恢复连接后会自动重试'
      if (!channelConfirmed) return '正在确认电脑的附件通道（宿主可能仍在初始化），页面会自动重查'
      if (channelRetryExhausted) return '电脑上的附件通道仍未就绪，可刷新页面重新检测'
      return '电脑上的 DeepSeek Harness 此刻没有提供附件服务（fileUploads 未注册）'
    }
    return ''
  }
  const uploadAttachment = async (session, file) => {
      if (file.uploading || !file.source) return
      file.uploading = true; file.error = ''; paintComposer()
      const source = file.source
      try {
        // 单帧协议32MiB，base64展开后仍须留足JSON和加密帧空间。
        if (source.size > 20 * 1024 * 1024) throw new Error('附件超过20MiB单次上传上限')
        const bytes = new Uint8Array(await source.arrayBuffer())
        const value = await options.upload(session, source.name, bytes)
        if (!value || value.ok !== true || typeof value.receiptId !== 'string' || !value.receiptId) throw new Error('宿主没有返回附件收据')
        file.receiptId = value.receiptId
        file.source = null
        chatLog('[dsh-chat] 附件上传：' + source.name + ' ' + bytes.length + ' 字节，收据已取得')
      } catch (error) {
        file.error = error instanceof Error ? error.message : String(error)
        chatLog('[dsh-chat] 附件上传失败：' + file.error)
      }
      file.uploading = false
      if (session === currentSessionId) paintComposer()
  }
  const addAttachments = async files => {
    const blocked = attachmentBlocked()
    if (blocked) { setNotice(blocked); chatLog('[dsh-chat] 附件入口：' + blocked); return }
    const session = currentSessionId
    for (const source of Array.from(files || [])) {
      const file = { name: source.name, size: source.size, source, uploading: false, receiptId: '', error: '' }
      const pending = attachmentDrafts.get(session) || []
      pending.push(file); attachmentDrafts.set(session, pending)
      await uploadAttachment(session, file)
    }
  }
  if (attachButton) attachButton.addEventListener('click', () => {
    if (attachButton.disabled) return
    const blocked = attachmentBlocked()
    if (blocked) { setNotice(blocked); chatLog('[dsh-chat] 附件入口：' + blocked); return }
    if (!attachmentInput) { setNotice('附件选择器未加载，请刷新页面'); return }
    // 保持在点击调用栈中，Android WebView 与浏览器都要求真实用户激活。
    // ★ 绝不能改成「先 await 通道探测 / 退避重查，再点选择器」（2026-10-12 ✗）：
    //   任何 await 都会把 click 推出用户手势栈，选择器直接打不开 ✓。
    //   通道未就绪由上面的 attachmentBlocked 当场挡住，而不是靠等探测 ✓。
    attachmentInput.click(); chatLog('[dsh-chat] 附件入口：已打开系统选择器')
  })
  if (attachmentInput) attachmentInput.addEventListener('change', () => { const files = Array.from(attachmentInput.files || []); attachmentInput.value = ''; void addAttachments(files) })

  paintComposer = () => {
    const sending = pendingSends.has(currentSessionId)
    const files = activeAttachments()
    const hasReceipts = files.some(file => file.receiptId.length > 0)
    const uploadPending = files.some(file => file.uploading || file.error)
    paintAttachments()
    if (attachButton) {
      attachButton.disabled = sending
      attachButton.setAttribute('aria-disabled', String(attachButton.disabled))
      attachButton.title = attachmentBlocked() || '添加附件（单个≤20MiB）'
    }
    const address = nativeNavigation.session(currentSessionId)?.address
    const readOnlyChild = address?.kind === 'subagent' && address.mode !== 'continuable'
    if (input) input.disabled = sending || readOnlyChild
    if (attachButton && address?.kind === 'subagent') { attachButton.disabled = true; attachButton.title = '子智能体不支持文件附件' }
    if (sendButton !== null && sendButton !== undefined) {
      sendButton.disabled = sending || uploadPending || !(hasReceipts ? connection === 'online' : canSend({ text: input === null || input === undefined ? '' : input.value, sending: false, connection }))
      /**
       * ★★ 这里原来写的是 `sendButton.textContent = sending ? '发送中…' : '发送'` ✗。
       *   新键子的**形状**是圆形箭头 ✓ ⇒ 那行字不能再当"按钮内容"写了 ✓（会把箭头抹掉 ✗）：
       *   · 箭头与那行字**同时**在标记里 ✓（`page.html` ✓）；
       *   · 显隐由 CSS 认这个 `data-sending` 标记 ✓（只显隐、不改内容 ✗）；
       *   · 那行字写在 `#send-label` 里 ✓ —— 只有发送中那一下才看得见 ✓。
       */
      const label = sendButton.querySelector('#send-label')
      if (label !== null && label !== undefined) label.textContent = sending ? '发送中…' : ''
    }
    if (form !== null && form !== undefined && form.dataset !== undefined) {
      form.dataset.sending = sending ? '1' : '0'
    }
    nativeControls.setConnection(connection)
    nativeControls.setRunning(projection.snapshot().status.running)
    if (sendButton && readOnlyChild) { sendButton.disabled = true; sendButton.title = '此子智能体仅支持查看' }
  }

  if (input !== null && input !== undefined) {
    input.addEventListener('input', () => {
      growInput()
      paintComposer()
    })
  }

  if (form !== null && form !== undefined) {
    form.addEventListener('submit', async (submitEvent) => {
      if (submitEvent.preventDefault) submitEvent.preventDefault()
      const current = input === null || input === undefined ? '' : String(input.value || '')
      const session = currentSessionId
      const sending = pendingSends.has(session)
      const files = activeAttachments()
      const receiptIds = files.filter(file => file.receiptId).map(file => file.receiptId)
      if (sending || files.some(file => file.uploading || file.error) || !(receiptIds.length ? connection === 'online' : canSend({ text: current, sending, connection }))) {
        // ★ 按了没反应是最糟的 ✓ —— 断线时说清楚 ✓
        if (connection === 'offline') setNotice('断线中，等连上再发（字还在）')
        return
      }
      const begun = sendBegin(current)
      if (input !== null && input !== undefined) input.value = begun.draft
      pendingSends.add(session)
      growInput()
      paintComposer()
      setNotice('发送中…')
      try {
        const commandHandled = await nativeControls.handleSubmit({ text: begun.pending, receiptIds })
        if (!commandHandled) await options.send(begun.pending, receiptIds, { sessionId: session, address: nativeNavigation.session(session)?.address })
        attachmentDrafts.set(session, [])
        pendingSends.delete(session)
        sendSettled(true, begun.pending)
        if (session === currentSessionId) setNotice('已发出')
      } catch (error) {
        // ★★ 失败 ⇒ **原文放回输入框** ✗（"发出去的字突然没了"是我最想避免的一种）
        const settled = sendSettled(false, begun.pending)
        if (session === currentSessionId && input !== null && input !== undefined) input.value = settled.draft
        else drafts = putDraft(drafts, session, settled.draft)
        pendingSends.delete(session)
        growInput()
        if (session === currentSessionId) setNotice(sendFailureHint(error instanceof Error ? error.message : String(error)))
      }
      paintComposer()
    })
  }

  paint()
  const api = {
    /** ★ 交给 `new ChatPoller({ …page.handlers })` ✓ */
    handlers: { onEvents: handleEvents, onError: handleError },
    /** 喂会话列表 ✓（第三个参数是标题栏文字 ✓）。 */
    setSessions,
    setValues: applyValues,
    prependHistory: page => {
      projection.ingest({ events: page.events, hasMore: page.hasMore })
      eventCount = projection.snapshot().events.length
      nativeConversation.update(projection.snapshot(), { preserveAnchor: true }); appendTrace(); paint()
    },
    projection: () => projection.snapshot(),
    ingestStream: (frame, metadata) => {
      projection.ingestStream(frame, metadata)
      const snapshot = projection.snapshot()
      nativeConversation.update(snapshot); appendTrace(); paint()
      return snapshot.stream
    },
    replaceStream: (baseline, metadata) => {
      projection.replaceStream(baseline, metadata)
      nativeConversation.update(projection.snapshot()); appendTrace(); paint()
    },
    controls: nativeControls,
    navigation: nativeNavigation,
    statistics: nativeStatistics, management: nativeManagement, shell: mobileShell,
    closePopups: () => { nativeStatistics.close(); nativeControls.back?.() },
    dispose: () => { mobileShell.dispose(); nativeStatistics.dispose(); nativeManagement?.dispose(); nativeConversation.dispose(); nativeTrace.dispose(); nativeControls.dispose(); nativeNavigation.dispose() },
    /** 当前会话 id ✓。 */
    current: () => currentSessionId,
    /** 草稿柜读数 ✓（开发壳与测试用 ✓）。 */
    drafts: () => ({ ...drafts }),
    /** 切换是否还等着替换 ✓。 */
    isSwitching: () => pendingSwitch,
    /**
     * ★★ 切到「对话」/「轨迹」✓（复刻清单第 3 项 ✓）。
     *
     * ★ 为什么把它交出去 ✗：那一单的验收要能**按真实点击路径**切 ✓ ——
     *   夹具里 `dispatchEvent(new Event('click'))` 打的就是这颗键 ✓，
     *   与用户手指按下去走的是同一条路 ✓（不是"直接调内部函数"那种假判据 ✓）。
     * ★ 轨迹视图当前摊开了几条 ✓（纯读数 ✓ —— 验收要能证明"换了一屏"而不是"按钮变了色"✗）。
     */
    switchView: showView,
    traceSteps: () => traceSteps,
    /**
     * ★★ 长会话那一单的**纯读数** ✓（不碰任何状态 ✓）—— 验收与真机调试框都念得出来 ✓。
     *   · `maxDrawn`：屏上**最多**留多少条事件 ✓（上界的**唯一**真身处 = `MAX_DRAWN_EVENTS` ✓）；
     *   · `trimNote`：那句"更早的 N 条已收起"**现在在不在屏上** ✓（`null` = 不在 ✓）；
     *   · `drawn`：现在屏上真有几条事件节点 ✓（`#messages` 的孩子数 ✓ —— 它就是"节点数"那条判据 ✓）；
     *   · `liveSeqs`：屏上这几条的 `data-seq` ✓（顺序即 DOM 顺序 ✓ ⇒ "最新几条仍在、顺序仍对"可判 ✓）。
     */
    limits: () => ({
      maxDrawn: MAX_DRAWN_EVENTS,
      drawn: nativeConversation.limits().drawn,
      trimNote: (() => {
        const note = list === null || list === undefined || typeof list.querySelector !== 'function'
          ? null
          : list.querySelector('.ev-trim-note')
        return note === null || note === undefined ? null : { text: note.textContent, hidden: note.getAttribute('data-trim-hidden') }
      })(),
      liveSeqs: list === null || list === undefined || typeof list.querySelectorAll !== 'function'
        ? []
        : Array.prototype.slice.call(list.querySelectorAll('.ev[data-seq]')).map((node) => Number(node.getAttribute('data-seq'))),
    }),
    appendEvents: handleEvents,
    /**
     * ★★ 裁决通道**探测结果**从外面喂进来 ✓（`app.js` 探一次 ✓）——
     *   探到接通 ⇒ 卡片上那两颗按钮才可点 ✓；探不到 ⇒ 一直置灰 ✓（不假装能用 ✗）。
     */
    setApprovalChannel,
    setChannels,
    setInteractions,
    addAttachments,
    setConnection: (next) => {
      connection = next === 'offline' ? 'offline' : next === 'online' ? 'online' : 'unknown'
      paint()
    },
    setLoading: (next) => {
      loading = next === true
      paint()
    },
    state: () => computePageState({ loading, eventCount, error, connection }),
  }
  /**
   * ★★ 把这套读数挂到那个**取证钩子**上 ✓（长会话那一单 ✓）——
   *   `globalThis.__DSHM_CHAT_PAGE__` 由**外面**建（验收的夹具 ✓ / 真机调试框 ✓）；
   *   没建的时候一个字节都不做 ✓（生产页面上不花这份钱 ✓）。
   *
   * ★ 为什么在这儿挂、而不是在 `app.js` 里 ✗：`app.js` 这一单里**不许改** ✓
   *   （它已经发货了 ✓）；而"页面自己报出屏上有几条"这件事本来就属于**画**那一半 ✓。
   */
  try {
    const hook = globalThis.__DSHM_CHAT_PAGE__
    if (hook !== null && hook !== undefined && typeof hook === 'object') hook.page = api
  } catch (error) {
    void error
  }
  return api
}
