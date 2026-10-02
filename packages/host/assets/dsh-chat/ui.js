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

/**
 * 一条**审批**事件 ⇒ view model ✓（纯函数 ✓）。
 *
 * ★★ 三条自我约束（"审批"是**会改变电脑上正在发生的事**的按钮 ✗，比"发送"更该保守 ✓）：
 *
 * 1. **解析不出选项 ⇒ 一颗按钮都不给** ✗ —— 页面上写清"选项没解析出来" + 把原文摊开 ✓。
 *    绝不默认摆一个「允许 / 拒绝」✗：把没看懂的审批按下去，可能会让智能体做用户没同意的事 ✓；
 * 2. **已经裁决过的**（有对应 `approval/decided` ✓）⇒ 只显示结果，**不再给按钮** ✗；
 * 3. 认不出的形状 ⇒ **原文照摊** ✓（`raw` ✓）—— 绝不因为"看不懂"就什么都不显示 ✗。
 *
 * @param {object} event 事件本身（`{seq,time,type,data}` ✓）
 * @param {object|null} decided 已经收到的裁决（同一条请求的 `approval/decided` ✓），没有就 null ✓
 */
export function toApprovalViewModel(event, decided) {
  const data = event !== null && typeof event === 'object' && event.data !== null && typeof event.data === 'object' ? event.data : {}
  const text = textOf(event)
  const requestId = firstString(data, ['requestId', 'request_id', 'id', 'approvalId'])
  const title = firstString(data, ['title', 'tool', 'toolName', 'name', 'command']) || '需要你确认'
  const detail = firstString(data, ['detail', 'description', 'message', 'reason', 'prompt']) || text
  const options = parseOptions(data)
  const decision = decided !== null && decided !== undefined
    ? firstString(decided.data !== null && typeof decided.data === 'object' ? decided.data : {}, ['decision', 'option', 'choice', 'result', 'answer']) || '已处理'
    : ''
  return {
    kind: 'approval',
    requestId,
    title,
    detail,
    options,
    decided: decision.length > 0,
    decision,
    raw: options.length > 0 ? '' : safeJson(data),
  }
}

/** 选项：`options` / `choices` / `actions` 里挑一个数组 ✓；元素可以是字符串或 `{id,label}` ✓。 */
export function parseOptions(data) {
  if (data === null || typeof data !== 'object') return []
  for (const key of ['options', 'choices', 'actions', 'buttons']) {
    const value = data[key]
    if (!Array.isArray(value)) continue
    const out = []
    for (const item of value) {
      if (typeof item === 'string' && item.length > 0) {
        out.push({ id: item, label: item })
        continue
      }
      if (item !== null && typeof item === 'object') {
        const id = firstString(item, ['id', 'value', 'key', 'action'])
        const label = firstString(item, ['label', 'title', 'text', 'name']) || id
        if (id.length > 0) out.push({ id, label: label.length > 0 ? label : id, kind: firstString(item, ['kind', 'tone', 'style']) })
      }
    }
    if (out.length > 0) return out
  }
  return []
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
  if (text.includes('usermessage') || text.includes('user/') || text.includes('prompt')) return 'user'
  if (text.includes('agentmessage') || text.includes('assistant') || text.includes('message')) return 'agent'
  // ★ 审批要**排在工具之前**判 ✓ —— `approval/asked` 里没有 tool 字样，但审批常被包在工具事件里 ✓
  if (text.includes('approval') || text.includes('permission')) return 'approval'
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
  /**
   * ★ 要滚的是**真正的滚动容器** ✗，不是消息列表本身 ✓ ——
   *   页面结构改成"外层 `main` 滚、里面 `#messages` 只排"之后 ✓，
   *   再给 `#messages` 设 `scrollTop` 就是一个**静默无效**的赋值 ✓
   *   ⇒ 表现是"新消息永远在屏幕外、看着像卡住" ✓（本轮截图抓到的就是这个 ✓）。
   *   若 DOM 结构改回列表自己滚，这里**也**还能对（取到的就是它自己 ✓）。
   */
  const scroller = typeof container.closest === 'function'
    ? (container.closest('main') || container.parentElement || container)
    : (container.parentElement || container)
  const follow = shouldAutoScroll(
    { scrollTop: scroller.scrollTop, scrollHeight: scroller.scrollHeight, clientHeight: scroller.clientHeight },
    80,
  )
  for (const event of Array.isArray(events) ? events : []) {
    const node = renderEvent(event)
    if (node !== null) container.appendChild(node)
  }
  // ★ 用户手动往上翻的时候**不许把他拽回去** ✗（`follow` 是在追加之前量的 ✓）
  if (follow && typeof scroller.scrollTop === 'number') scroller.scrollTop = scroller.scrollHeight
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

  if (view.kind === 'approval') {
    wrapper.appendChild(approvalCard(toApprovalViewModel(event, null)))
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
 * ★ 按钮**一律置灰**（`disabled` ✓）并且写清原因 ✓ —— 这是本项目的既定纪律：
 *   **不假装能用** ✗（与首页那两个还没通电的标签同一个处理 ✓）。
 *   为什么：按下去会**改变电脑上正在发生的事** ✓，而"决策走哪条通道"还没在真机上验过 ✗
 *   （见 `37-会话页数据面探针.md` §十四 ✓）。等验过再把 `disabled` 摘掉 ✓。
 */
function approvalCard(view) {
  const card = document.createElement('div')
  card.className = 'approval' + (view.decided ? ' approval-decided' : '')

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

  if (!view.decided) {
    const actions = document.createElement('div')
    actions.className = 'approval-actions'
    if (view.options.length > 0) {
      for (const option of view.options) {
        const button = document.createElement('button')
        button.type = 'button'
        button.className = 'approval-option'
        button.textContent = option.label
        button.disabled = true
        actions.appendChild(button)
      }
    } else {
      const note = document.createElement('div')
      note.className = 'dim small'
      note.textContent = '这条审批的选项没能解析出来（原文在下面）—— 先不给你能按的按钮'
      actions.appendChild(note)
    }
    card.appendChild(actions)
    const why = document.createElement('div')
    why.className = 'approval-why'
    why.textContent = '裁决通道还没接通（正在真机上验），所以这里的按钮先置灰'
    card.appendChild(why)
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
  /** ★ 草稿柜：**按会话存** ✓（切走再切回来，字还在 ✓）。 */
  let drafts = {}
  /** ★ 由下面赋值（输入区那一段）—— `paint` 里会调它 ✓。
   *  刻意**不**用"事后包一层 paint"的写法 ✗：那既容易写成 `const` 重赋值（运行时才炸 ✓），
   *  也正是上一轮记下的坏味道（别靠改别人的东西接线 ✓）。 */
  let paintComposer = () => {}

  const paint = () => {
    const view = computePageState({ loading, eventCount, error, connection })
    const line = notice.length > 0 ? notice : pendingSwitch ? '正在切换会话…（下面的内容还在）' : view.statusText
    if (status !== null && status !== undefined) status.textContent = line
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
    // ★ 输入区的可用状态跟着页面状态走 ✓（断线时那颗按钮要立刻变灰 ✓）
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
  const sessionPanel = root.querySelector('#sessions')
  const titleButton = root.querySelector('#title')

  /** 画会话列表 ✓（当前那个打勾 ✓；正在跑 / 等审批的带标记 ✓）。 */
  const paintSessions = () => {
    if (sessionPanel === null || sessionPanel === undefined) return
    sessionPanel.innerHTML = ''
    // ★ 「＋ 新会话」—— 没有它，一个还没有会话的手机**什么也做不了** ✗
    //   （输入框发出去只会得到"缺 sessionId"的错 ✓）
    const createRow = document.createElement('button')
    createRow.type = 'button'
    createRow.className = 'session-row session-create'
    createRow.textContent = '＋ 新会话'
    createRow.addEventListener('click', () => {
      hideSessions()
      // ★ 与"切到某个已有会话"同一套状态 ✓：旧内容先留着，等新会话的**第一趟回应**到了才替换 ✓
      pendingSwitch = true
      sawResponseSinceSwitch = false
      paint()
      if (typeof options.onCreate === 'function') options.onCreate()
    })
    sessionPanel.appendChild(createRow)

    const ordered = sortSessions(sessions)
    if (ordered.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'state-hint'
      empty.textContent = '这台电脑上没有别的会话'
      sessionPanel.appendChild(empty)
      return
    }
    for (const item of ordered) {
      const row = document.createElement('button')
      row.type = 'button'
      row.className = 'session-row' + (item.id === currentSessionId ? ' is-current' : '')
      const name = document.createElement('span')
      name.className = 'session-title'
      name.textContent = item.title !== undefined && item.title.length > 0 ? item.title : item.id
      row.appendChild(name)
      if (item.awaitingApproval === true || item.running === true) {
        const flag = document.createElement('span')
        flag.className = 'session-flag'
        flag.textContent = item.awaitingApproval === true ? '等审批' : '在跑'
        row.appendChild(flag)
      }
      if (item.id === currentSessionId) {
        const mark = document.createElement('span')
        mark.className = 'session-mark'
        mark.textContent = '✓'
        row.appendChild(mark)
      }
      row.addEventListener('click', () => {
        if (item.id === currentSessionId) {
          hideSessions()
          return
        }
        // ★ 切走前先把当前草稿**存进柜子** ✓（切回来字还在 ✓）
        if (input !== null && input !== undefined) drafts = putDraft(drafts, currentSessionId, String(input.value || ''))
        pendingSwitch = true
        sawResponseSinceSwitch = false
        hideSessions()
        paint()
        if (typeof options.onSwitch === 'function') options.onSwitch(item.id)
      })
      sessionPanel.appendChild(row)
    }
  }

  const hideSessions = () => {
    if (sessionPanel !== null && sessionPanel !== undefined) sessionPanel.hidden = true
  }

  if (titleButton !== null && titleButton !== undefined) {
    titleButton.addEventListener('click', () => {
      if (sessionPanel === null || sessionPanel === undefined) return
      const willShow = sessionPanel.hidden !== false
      sessionPanel.hidden = !willShow
      if (willShow) paintSessions()
    })
  }

  /** 外面喂列表 ✓（`currentId` 变了就顺手把草稿换过来 ✓）。 */
  const setSessions = (next, currentId, titleText) => {
    sessions = Array.isArray(next) ? next : []
    if (typeof titleText === 'string' && titleButton !== null && titleButton !== undefined) {
      titleButton.textContent = titleText
    }
    if (typeof currentId === 'string' && currentId !== currentSessionId) {
      if (input !== null && input !== undefined) {
        // 存起旧的、换上新的（★ 这就是"切回来字还在"的全部机制 ✓）
        drafts = putDraft(drafts, currentSessionId, String(input.value || ''))
        input.value = getDraft(drafts, currentId)
      }
      currentSessionId = currentId
    }
    paintSessions()
  }

  /** 写一条临时消息 ✓（并立刻重画 ✓）。 */
  const setNotice = (text) => {
    notice = typeof text === 'string' ? text : ''
    paint()
  }

  const handleEvents = (events) => {
    const willReplace = resolveDelivery(pendingSwitch, sawResponseSinceSwitch, events) === 'replace'
    if (pendingSwitch) sawResponseSinceSwitch = true
    if (willReplace) {
      // ★ 第一趟回应到了 ⇒ 这时候才替换 ✗（切换的瞬间不许清屏 ✓；空会话也该清 ✓）
      list.innerHTML = ''
      eventCount = 0
      pendingSwitch = false
      paintSessions()
    }
    if (Array.isArray(events) && events.length > 0) {
      error = ''
      // ★ 刻意**不**在这里清临时消息 ✗：那样"没发出去：…（字还在输入框里）"会被
      //   下一趟历史轮询**冲掉** ✓ —— 用户根本没看清就没了 ✓（与"字丢了"同一类伤害 ✓）。
      //   清空时机只有**用户的下一次动作**：再发一次 ✓ / 点刷新 ✓。
      eventCount += events.length
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
      notice = ''
      paint()
      if (typeof options.onRefresh === 'function') options.onRefresh()
    })
  }


  // ── 输入区：清空要立刻（手感 ✓），但失败**把字放回去**（见 canSend/sendBegin/sendSettled ✓）──
  let sending = false
  const sendButton = form === null || form === undefined ? null : form.querySelector('button')

  const growInput = () => {
    if (input === null || input === undefined || input.style === undefined) return
    try {
      input.style.height = 'auto'
      input.style.height = composerHeight(input.scrollHeight, 38, 132) + 'px'
    } catch (error) {
      void error
    }
  }

  paintComposer = () => {
    if (input !== null && input !== undefined) input.disabled = sending
    if (sendButton !== null && sendButton !== undefined) {
      sendButton.disabled = sending || !canSend({ text: input === null || input === undefined ? '' : input.value, sending: false, connection })
      sendButton.textContent = sending ? '发送中…' : '发送'
    }
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
      if (!canSend({ text: current, sending, connection })) {
        // ★ 按了没反应是最糟的 ✓ —— 断线时说清楚 ✓
        if (connection === 'offline') setNotice('断线中，等连上再发（字还在）')
        return
      }
      const begun = sendBegin(current)
      if (input !== null && input !== undefined) input.value = begun.draft
      sending = true
      growInput()
      paintComposer()
      setNotice('发送中…')
      try {
        await options.send(begun.pending)
        sending = false
        sendSettled(true, begun.pending)
        setNotice('已发出')
      } catch (error) {
        // ★★ 失败 ⇒ **原文放回输入框** ✗（"发出去的字突然没了"是我最想避免的一种）
        const settled = sendSettled(false, begun.pending)
        if (input !== null && input !== undefined) input.value = settled.draft
        sending = false
        growInput()
        setNotice(sendFailureHint(error instanceof Error ? error.message : String(error)))
      }
      paintComposer()
    })
  }

  paint()
  return {
    /** ★ 交给 `new ChatPoller({ …page.handlers })` ✓ */
    handlers: { onEvents: handleEvents, onError: handleError },
    /** 喂会话列表 ✓（第三个参数是标题栏文字 ✓）。 */
    setSessions,
    /** 当前会话 id ✓。 */
    current: () => currentSessionId,
    /** 草稿柜读数 ✓（开发壳与测试用 ✓）。 */
    drafts: () => ({ ...drafts }),
    /** 切换是否还等着替换 ✓。 */
    isSwitching: () => pendingSwitch,
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
