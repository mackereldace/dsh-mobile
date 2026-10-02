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
 */

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
  if (event === null || typeof event !== 'object') return null
  const kind = classify(event.type)
  const text = textOf(event)
  const wrapper = document.createElement('div')
  wrapper.className = 'ev ev-' + kind
  wrapper.setAttribute('data-type', String(event.type || ''))

  if (kind === 'user' || kind === 'agent') {
    const bubble = document.createElement('div')
    bubble.className = 'bubble'
    bubble.textContent = text.length > 0 ? text : '（这条没有文字内容）'
    wrapper.appendChild(bubble)
    return wrapper
  }
  if (kind === 'reasoning') {
    const line = document.createElement('div')
    line.className = 'dim small'
    line.textContent = text.length > 0 ? text : String(event.type || '')
    wrapper.appendChild(line)
    return wrapper
  }
  if (kind === 'tool') {
    const head = document.createElement('div')
    head.className = 'tool-head'
    head.textContent = String(event.type || '工具')
    const body = document.createElement('pre')
    body.className = 'tool-body'
    body.textContent = text
    wrapper.appendChild(head)
    wrapper.appendChild(body)
    return wrapper
  }
  if (kind === 'step') {
    // ★ 一轮的开始不该是"孤零零一个词" ✓ —— 做成一条带小标签的分隔线 ✓
    //   （`turn/start` 的 data 里带轮号时写"第 N 轮"✓，没有就写事件名 ✓ —— 不编 ✗）
    const line = document.createElement('div')
    line.className = 'step'
    const label = document.createElement('span')
    const data = event.data
    const turn = data !== null && typeof data === 'object' ? data.turn : undefined
    label.textContent = typeof turn === 'number' ? '第 ' + turn + ' 轮' : String(event.type || '')
    line.appendChild(label)
    wrapper.appendChild(line)
    return wrapper
  }
  // ★ 认不出的类型**也要看得见** ✓（静默丢掉 = 手机上永远查不出来 ✓）
  const fallback = document.createElement('div')
  fallback.className = 'dim small'
  fallback.textContent = String(event.type || '未知事件') + (text.length > 0 ? '：' + text.slice(0, 200) : '')
  wrapper.appendChild(fallback)
  return wrapper
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

  const setStatus = (text) => {
    if (status !== null && status !== undefined) status.textContent = text
    if (typeof options.onStatus === 'function') options.onStatus(text)
  }

  // ★ 新事件**只追加** ✓（不重画 ⇒ 滚动位置与正在输入的内容都不受影响 ✓）
  options.onEvents = (events) => {
    appendEvents(list, events)
  }
  options.onError = (message) => {
    // ★ 出错**不清屏** ✗ —— 只在顶部那一行写清楚 ✓
    setStatus('读取出错：' + message)
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
  return { appendEvents: (events) => appendEvents(list, events), setStatus }
}
