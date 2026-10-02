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
 * 字段：`kind` / `type` / `text` / `title` / `body` / `collapsed` / `hiddenLines` / `isError` / `lines` ✓。
 * · `collapsed` 只对**工具类**与"认不出的类型"生效 ✓（消息再长也不折 ✗ —— 那是正文 ✓）；
 * · 折叠时 `body` 是**截过的**（保头 ✓）+ `hiddenLines` 说清还藏了几行 ✓
 *   （"少了几行"必须说出来 ✓，静默截断是最气人的一种 ✗）。
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
    title: titleFor(kind, type),
    text,
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

/** 事件的"种类"⇒ 画法。认不出的一律走 `other`（**仍然画** ✓）。 */
export function classify(type) {
  const text = typeof type === 'string' ? type.toLowerCase() : ''
  if (text.includes('usermessage') || text.includes('user/') || text.includes('prompt')) return 'user'
  if (text.includes('agentmessage') || text.includes('assistant') || text.includes('message')) return 'agent'
  if (text.includes('reasoning') || text.includes('thinking')) return 'reasoning'
  if (text.includes('command') || text.includes('tool') || text.includes('exec')) return 'tool'
  if (text.includes('error') || text.includes('failed')) return 'error'
  if (text.includes('turn/') || text.includes('step')) return 'step'
  return 'other'
}

/** 从事件里尽量掏出一段**能读的文字** ✓（掏不出就返回空串，绝不编 ✗）。 */
export function textOf(event) {
  const data = event === null || typeof event !== 'object' ? null : event.data
  if (typeof data === 'string') return data
  if (data !== null && typeof data === 'object') {
    for (const key of ['text', 'message', 'content', 'output', 'command', 'summary', 'title']) {
      const value = data[key]
      if (typeof value === 'string' && value.length > 0) return value
    }
    // 数组内容（DSH 的 content 常是 parts 数组 ✓）
    if (Array.isArray(data.content)) {
      const parts = []
      for (const part of data.content) {
        if (part !== null && typeof part === 'object' && typeof part.text === 'string') parts.push(part.text)
      }
      if (parts.length > 0) return parts.join('\n')
    }
    try {
      return JSON.stringify(data)
    } catch (error) {
      return ''
    }
  }
  return ''
}

/**
 * 把事件追加到容器里 ✓（**不重画已有的** ✓）。
 *
 * @param {HTMLElement} container
 * @param {Array} events 已经排好序、去过重的事件（来自 `poller.js` ✓）
 */
export function appendEvents(container, events) {
  if (container === null || container === undefined) return
  for (const event of Array.isArray(events) ? events : []) {
    const node = renderEvent(event)
    if (node !== null) container.appendChild(node)
  }
  if (container.scrollHeight !== undefined) container.scrollTop = container.scrollHeight
}

/** 一条事件 ⇒ 一个节点 ✓（`null` = 真的没什么可画的 ✓）。 */
export function renderEvent(event) {
  const view = toViewModel(event)
  const wrapper = document.createElement('div')
  wrapper.className = 'ev ev-' + view.kind + (view.isError ? ' is-error' : '')
  wrapper.setAttribute('data-type', view.type)

  if (view.kind === 'user' || view.kind === 'agent') {
    const bubble = document.createElement('div')
    bubble.className = 'bubble'
    bubble.textContent = view.text.length > 0 ? view.text : '（这条没有文字内容）'
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
    hidden.textContent = '还有 ' + view.hiddenLines + ' 行'
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
      if (hiddenNote !== null) hiddenNote.textContent = expanded ? '还有 ' + view.hiddenLines + ' 行' : '全部'
    })
    head.appendChild(toggle)
  }
  card.appendChild(head)
  card.appendChild(body)
  return card
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
  const form = root.querySelector('#composer')
  const input = root.querySelector('#input')
  const status = root.querySelector('#status')
  const stateBox = root.querySelector('#state')
  const refresh = root.querySelector('#refresh')

  // 这一页的**输入**（三样 ✓）—— 状态完全由它们算出来 ✓（不在渲染里各写一份判断 ✗）
  let eventCount = 0
  let loading = false
  let error = ''
  let connection = 'unknown'

  const paint = () => {
    const view = computePageState({ loading, eventCount, error, connection })
    if (status !== null && status !== undefined) status.textContent = view.statusText
    if (typeof options.onStatus === 'function') options.onStatus(view.statusText)
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
  }

  /**
   * ★ 新事件**只追加** ✓（不重画 ⇒ 滚动位置与正在输入的内容都不受影响 ✓）。
   *
   * ★★ 这两个处理器**由本函数返回** ✓，调用方再交给 `ChatPoller` ✗ ——
   *   不再"偷偷往传进来的对象上装"（2026-10-03 为此踩了**两次**同一个坑：
   *   `mountChat` 收到的是新字面量、而 poller 持有的是**另一个** options 对象 ⇒
   *   处理器根本没接上 ⇒ 画面空白、**渲染脚本的体积从 258KB 掉到 72KB 才露馅** ✗）。
   */
  const handleEvents = (events) => {
    if (Array.isArray(events) && events.length > 0) {
      eventCount += events.length
      error = ''
      appendEvents(list, events)
    }
    loading = false
    paint()
  }
  const handleError = (message) => {
    // ★ 出错**不清屏** ✗ —— 有内容就走状态行 ✓，没内容才占屏 ✓（判据在 computePageState 里）
    error = message
    loading = false
    paint()
  }

  if (refresh !== null && refresh !== undefined) {
    refresh.addEventListener('click', () => {
      loading = true
      error = ''
      paint()
      if (typeof options.onRefresh === 'function') options.onRefresh()
    })
  }


  if (form !== null && form !== undefined) {
    form.addEventListener('submit', async (submitEvent) => {
      if (submitEvent.preventDefault) submitEvent.preventDefault()
      const text = input === null || input === undefined ? '' : String(input.value || '').trim()
      if (text.length === 0) return
      input.value = ''
      try {
        await options.send(text)
        setStatus('已发出')
      } catch (error) {
        setStatus('发送失败：' + (error instanceof Error ? error.message : String(error)))
      }
    })
  }
  paint()
  return {
    /** ★ 交给 `new ChatPoller({ …page.handlers })` ✓ */
    handlers: { onEvents: handleEvents, onError: handleError },
    appendEvents: (events) => appendEvents(list, events),
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
}
