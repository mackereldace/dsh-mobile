/** Native Web detailed flow. Projection owns facts; this module owns disclosure and DOM. */
const node = (doc, tag, cls, text) => {
  const el = doc.createElement(tag)
  if (cls) el.className = cls
  if (text !== undefined) el.textContent = text
  return el
}
const terminal = status => ['complete', 'stopped', 'error'].includes(status)
export const elapsedLabel = ms => ms == null ? '' : Math.max(0, Math.floor(ms / 1000)) + ' 秒'
export function reasoningSummary(text, running = false) {
  const clean = String(text || '').replace(/\*\*/g, '').trim()
  const paragraphs = clean.split(/\n\s*\n/)
  const paragraph = running && paragraphs.length > 1 ? paragraphs.at(-2) : paragraphs[0]
  return (paragraph || clean).split('\n')[0].trim()
}
export function toolPresentation(record) {
  let args = record.args
  if (!args || typeof args !== 'object') {
    try { args = JSON.parse(record.argsRaw || '{}') } catch { args = {} }
  }
  const name = String(record.name || '')
  const key = name.toLowerCase()
  const running = !terminal(record.status)
  const prep = record.phase === 'preparing'
  let title = running ? '正在调用工具' : '已调用工具', icon = 'tool'
  if (args.command || args.cmd || /terminal|shell|exec|command/.test(key)) { title = prep ? '准备执行命令' : running ? '正在执行命令' : '执行了命令'; icon = 'terminal' }
  else if (/write|edit|patch/.test(key)) { title = prep ? '准备写入文件' : running ? '正在写入文件' : '写入了文件'; icon = 'edit' }
  else if (/read|cat|view_file/.test(key)) { title = running ? '正在读取文件' : '读取了文件'; icon = 'file' }
  else if (/search|grep|find/.test(key)) { title = running ? '正在搜索' : '完成了搜索'; icon = 'search' }
  else if (/web|browse|fetch/.test(key)) { title = running ? '正在浏览网页' : '浏览了网页'; icon = 'web' }
  else if (/subagent|delegate|spawn/.test(key)) { title = running ? '正在调度子智能体' : '已调度子智能体'; icon = 'agent' }
  const summary = args.command || args.cmd || args.path || args.file_path || args.filePath || args.query || args.url || name
  return { title, icon, summary: String(summary || '').replace(/\s+/g, ' '), preparing: prep, failed: record.isError || record.status === 'error' }
}
const paths = {
  copy: 'M6 3h7a1 1 0 0 1 1 1v8M3 6h7a1 1 0 0 1 1 1v7H3V6Z',
  terminal: 'm3 4 4 4-4 4m6 0h4', file: 'M4 2h5l3 3v9H4V2Zm5 0v4h3',
  edit: 'M10 2 14 6 6 14H2v-4l8-8Zm-7 5H2V2h5', search: 'M10 10l4 4M11 6a5 5 0 1 1-10 0 5 5 0 0 1 10 0Z',
  agent: 'M8 1v2M5 3h6l3 3v7H2V6l3-3Zm0 5h1m4 0h1M5 11h6',
  tool: 'M5 2a4 4 0 0 0 5 5l4 4-3 3-4-4a4 4 0 0 1-5-5l3 2 2-2-2-3Z',
  web: 'M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1ZM1 8h14M8 1c-4 4-4 10 0 14 4-4 4-10 0-14Z',
  thought: 'M8 2c-7-3-8 5-1 8s8-5 1-8Zm0 0c7-3 8 5 1 8s-8-5-1-8Zm0-1v14',
  chevron: 'm5 3 5 5-5 5', down: 'm3 6 5 5 5-5',
  user: 'M8 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm-5 6v-1a5 4 0 0 1 10 0v1',
  sparkles: 'm10 4 1.3 3.7L15 9l-3.7 1.3L10 14l-1.3-3.7L5 9l3.7-1.3L10 4ZM3 1l.5 1.5L5 3l-1.5.5L3 5l-.5-1.5L1 3l1.5-.5L3 1Z',
  clock: 'M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1Zm0 3v4l3 2',
  rows: 'M2 2h12v4H2V2Zm0 8h12v4H2v-4Z',
}
export function icon(doc, name) {
  const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 16 16'); svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('class', 'native-icon')
  const path = doc.createElementNS(svg.namespaceURI, 'path')
  path.setAttribute('d', paths[name] || paths.tool); path.setAttribute('fill', 'none'); path.setAttribute('stroke', 'currentColor')
  path.setAttribute('stroke-width', '1.25'); path.setAttribute('stroke-linecap', 'round'); path.setAttribute('stroke-linejoin', 'round')
  svg.appendChild(path); return svg
}
const signature = record => JSON.stringify([record.status, record.blocks, record.name, record.argsRaw, record.output, record.phase, record.children?.map(signature)])
export function conversationItems(snapshot) {
  const records = snapshot.records || [], result = [], seenTurns = new Set()
  for (const record of records) {
    if (record.kind === 'user') { result.push({ key: record.key, kind: 'record', seq: record.seq, record }); continue }
    if (record.kind === 'tool' && record.parentCallId) continue
    if (record.kind === 'approval' || record.kind === 'approval-meta' || /^(approval\/|userQuestions\/)/.test(record.event?.type || '')) continue
    if (record.kind === 'other' && /^(turn\/|step\/|session\/|subagent\/|assistant\/|model\/|sandbox\/|permission\/|goal\/|todo\/|agent-preset\/)/.test(record.event?.type || '')) continue
    const turn = snapshot.turns.find(t => t.turn === record.turn)
    if (!turn) {
      if (record.visible !== false) result.push({ key: record.key, kind: 'record', seq: record.seq, record })
      continue
    }
    if (seenTurns.has(turn.key)) continue
    seenTurns.add(turn.key)
    if (turn.processRecords.length) result.push({ key: turn.key + ':process', kind: 'process', seq: turn.seq, turn })
    if (turn.answer && turn.answer.visible !== false) result.push({ key: turn.answer.key, kind: 'record', seq: turn.answer.seq, record: turn.answer })
  }
  return result.sort((a, b) => a.seq - b.seq)
}

export function mountConversation({ container, renderMarkdown, onOlder, loadAttachment, onMeasure, maxRows = 200 }) {
  maxRows = Math.max(1, Math.min(200, Math.floor(Number(maxRows) || 200)))
  const doc = container.ownerDocument || document
  const scroller = container.closest('main') || container
  const flow = node(doc, 'div', 'native-flow')
  const older = node(doc, 'button', 'history-load', '加载更早的消息'); older.type = 'button'; older.hidden = true
  const top = node(doc, 'div', 'conversation-spacer'), bottom = node(doc, 'div', 'conversation-spacer')
  const anchorSlack = node(doc, 'div', 'conversation-anchor-slack'); anchorSlack.style.height = '0px'
  const running = node(doc, 'div', 'native-running'), runningText = node(doc, 'span', 'native-running-text')
  const whale = node(doc, 'img', 'running-whale'); whale.src = '/mobile/chat/whale.svg'; whale.alt = ''
  running.append(whale, runningText)
  const jump = node(doc, 'button', 'back-to-bottom', '↓'); jump.type = 'button'; jump.setAttribute('aria-label', '回到底部'); jump.hidden = true
  container.replaceChildren(older, top, flow, bottom, anchorSlack, running, jump)
  const elements = new Map(), openStates = new Map(), heights = new Map()
  let snapshot = { records: [], turns: [], status: {}, hasMore: false }, items = [], windowStart = 0, windowEnd = 0, windowTail = true, sessionId = '', timer = null, loadingOlder = false, disposed = false
  const processOffsets = new Map(), toolOffsets = new Map()
  const scoped = key => JSON.stringify([sessionId, key])
  const isOpen = (key, fallback = false) => openStates.has(scoped(key)) ? openStates.get(scoped(key)) : fallback
  const processRecords = turn => turn.processRecords.filter(record => record.visible !== false && !record.parentCallId && record.name !== 'ask_user_question' && !/^approval\//.test(record.event?.type || ''))
  const processStart = (turn, visible) => Math.max(0, Math.min(processOffsets.get(scoped(turn.key)) ?? Math.max(0, visible.length - maxRows), Math.max(0, visible.length - 1)))
  const toolChildren = record => (record.children || []).filter(child => child.visible !== false && child.name !== 'ask_user_question')
  const toolStart = (record, children) => Math.max(0, Math.min(toolOffsets.get(scoped(record.key)) ?? 0, Math.max(0, children.length - 1)))
  const recordCost = (record, limit = maxRows) => {
    let cost = 1
    if (record.kind === 'tool' && record.phase !== 'preparing' && isOpen(record.key)) {
      const children = toolChildren(record), start = toolStart(record, children)
      for (const child of children.slice(start)) {
        if (cost >= limit) break
        cost += recordCost(child, limit - cost)
      }
    }
    return Math.min(limit, cost)
  }
  const itemCost = item => {
    if (item.kind === 'record') return recordCost(item.record)
    if (!isOpen(item.turn.key + ':process', item.turn.status !== 'complete')) return 0
    const visible = processRecords(item.turn), start = processStart(item.turn, visible)
    let cost = 0
    for (const record of visible.slice(start)) {
      if (cost >= maxRows) break
      cost += recordCost(record, maxRows - cost)
    }
    return cost
  }
  const tailStart = () => {
    let remaining = maxRows, start = items.length, count = 0
    for (let index = items.length - 1; index >= 0 && count < maxRows; index--) {
      const cost = itemCost(items[index])
      if (cost > remaining && remaining === 0) break
      start = index; count++; remaining -= Math.min(cost, remaining)
    }
    return start
  }
  const md = (el, text) => { if (renderMarkdown) renderMarkdown(el, text); else { el.textContent = text; el.setAttribute('data-render-fallback', '渲染器未就绪') } }
  const repaint = context => {
    if (disposed) return
    if (context) {
      if (context.turnKey && Number.isInteger(context.rootIndex)) processOffsets.set(scoped(context.turnKey), context.rootIndex)
      const index = items.findIndex(item => item.key === context.itemKey)
      if (index >= 0) { windowStart = index; windowTail = false }
    }
    draw()
  }
  const remember = (details, key, defaultOpen, changed, disabled = false) => {
    const stateKey = scoped(key)
    details.open = openStates.has(stateKey) ? openStates.get(stateKey) : defaultOpen
    // Native toggle also fires for our default/open restoration. Only a user
    // activation of summary owns a durable disclosure preference.
    details.querySelector('summary')?.addEventListener('click', event => {
      if (event.defaultPrevented) return
      event.preventDefault()
      if (disabled) return
      details.open = !details.open
      openStates.set(stateKey, details.open)
      changed?.(details.open)
    })
  }
  const discloseText = (parent, label, text) => {
    if (!text) return
    const header = node(doc, 'div', 'tool-section-label', label), pre = node(doc, 'pre', 'tool-output', text)
    parent.append(header, pre)
  }
  const tool = (record, budget, context, nested = false) => {
    if (nested) {
      if (budget.remaining <= 0) return null
      budget.remaining--
    }
    const style = toolPresentation(record), details = node(doc, 'details', 'native-tool' + (style.failed ? ' is-error' : ''))
    details.setAttribute('data-call-id', record.callId || ''); details.setAttribute('data-status', record.status)
    details.setAttribute('data-key', record.key)
    if (nested) details.setAttribute('data-projection-key', record.key)
    const summary = node(doc, 'summary', 'tool-disclosure'); summary.append(icon(doc, style.icon), node(doc, 'span', 'tool-title', style.title))
    if (style.summary) summary.append(node(doc, 'span', 'tool-separator', '·'), node(doc, 'span', 'tool-summary', style.summary))
    details.append(summary); remember(details, record.key, false, open => repaint(open ? context : null), style.preparing)
    let body = null, bodyKey = ''
    const fill = () => {
      if (!details.open || style.preparing) return
      if (!body) { body = node(doc, 'div', 'native-tool-body'); details.append(body) }
      const key = signature(record)
      if (bodyKey === key) return
      bodyKey = key; body.replaceChildren()
      discloseText(body, 'IN', record.input || record.argsRaw)
      discloseText(body, style.failed ? 'ERROR / OUT' : 'OUT', record.output)
      const children = toolChildren(record), start = toolStart(record, children)
      const page = (label, offset) => {
        const button = node(doc, 'button', 'history-load', label); button.type = 'button'
        button.addEventListener('click', () => { toolOffsets.set(scoped(record.key), offset); repaint(context) })
        body.append(button)
      }
      if (start > 0) page('查看更早的子调用', Math.max(0, start - maxRows))
      let end = start
      for (; end < children.length && budget.remaining > 0; end++) body.append(tool(children[end], budget, context, true))
      if (end < children.length) page(end === start ? '查看子调用' : '查看后续子调用', end)
    }
    details.addEventListener('toggle', fill)
    fill(); return details
  }
  const attachment = block => {
    const metadata = block.attachment || block.block?.attachment || block.block || {}
    if (block.kind === 'image') {
      const figure = node(doc, 'figure', 'message-image'), image = node(doc, 'img', 'message-image-content')
      image.alt = metadata.name || '图片'; image.loading = 'lazy'; figure.append(image)
      const error = node(doc, 'span', 'image-error', '正在读取图片…'); figure.append(error)
      if (loadAttachment) Promise.resolve(loadAttachment(metadata, snapshot.sessionId)).then(url => {
        if (!url || !figure.isConnected) return
        image.src = url; error.hidden = true
      }).catch(() => { error.textContent = '图片读取失败' })
      else error.textContent = '图片读取通道未接通'
      return figure
    }
    const file = node(doc, 'div', 'message-file'); file.append(icon(doc, 'file'), node(doc, 'span', '', metadata.name || metadata.path || '附件')); return file
  }
  const body = (record, budget, context) => {
    if (budget.remaining <= 0) return null
    budget.remaining--
    const wrap = node(doc, 'div', 'native-message ev ev-' + (record.kind === 'assistant' ? 'agent' : record.kind))
    wrap.setAttribute('data-key', record.key)
    wrap.setAttribute('data-projection-key', record.key)
    if (typeof record.seq === 'number') wrap.setAttribute('data-seq', String(record.seq))
    wrap.setAttribute('data-type', record.event?.type || record.kind)
    wrap.setAttribute('data-text-chars', String(record.text?.length || 0)); wrap.setAttribute('data-text-head', encodeURIComponent((record.text || '').slice(0, 64)))
    if (record.kind === 'tool') { wrap.append(tool(record, budget, context)); return wrap }
    if (record.kind === 'other' || record.kind === 'error') {
      const detail = node(doc, 'details', 'native-other'), label = node(doc, 'summary', '', record.event?.type || '记录')
      detail.open = record.kind === 'error'
      detail.append(label, node(doc, 'pre', '', JSON.stringify(record.event?.data, null, 2))); wrap.append(detail); return wrap
    }
    const content = node(doc, 'div', record.kind === 'user' ? 'native-user-stack' : 'native-assistant-content')
    const blocks = record.blocks?.length ? record.blocks : [{ kind: 'text', text: record.text || '' }]
    // Native user attachments precede the plain-text bubble; assistant block order is authored order.
    const ordered = record.kind === 'user' ? [...blocks.filter(b => ['image', 'file'].includes(b.kind)), ...blocks.filter(b => !['image', 'file'].includes(b.kind))] : blocks
    for (let i = 0; i < ordered.length; i++) {
      const block = ordered[i]
      if (block.kind === 'tool-call') continue
      if (block.kind === 'text' && block.text?.trim()) {
        const text = node(doc, 'div', 'bubble' + (record.kind === 'user' ? ' native-user-bubble' : ' native-response'))
        if (record.kind === 'user') { text.textContent = block.text; text.classList.add('user-plain-text') }
        else md(text, block.text)
        content.append(text)
      } else if (block.kind === 'reasoning' && block.text?.trim()) {
        const detail = node(doc, 'details', 'native-reasoning thinking'), head = node(doc, 'summary', 'reasoning-head')
        head.append(icon(doc, 'thought'), node(doc, 'span', 'reasoning-title', terminal(record.status) ? '已完成分析' : '正在分析请求'), node(doc, 'span', 'reasoning-summary', reasoningSummary(block.text, !terminal(record.status))))
        const expanded = node(doc, 'div', 'reasoning-body bubble'); md(expanded, block.text)
        detail.append(head, expanded); remember(detail, record.key + ':reason:' + i, false); content.append(detail)
      } else if (['image', 'file'].includes(block.kind)) content.append(attachment(block))
      else if (block.kind === 'other') {
        const info = node(doc, 'details', 'native-other'); info.append(node(doc, 'summary', '', '内容详情'), node(doc, 'pre', '', JSON.stringify(block.block, null, 2))); content.append(info)
      }
    }
    wrap.append(content)
    if (terminal(record.status) && (record.text || '').trim()) {
      const actions = node(doc, 'div', 'message-actions')
      if (record.time !== null && record.time !== undefined) actions.append(node(doc, 'time', '', new Date(record.time).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })))
      const copy = node(doc, 'button', 'copy-message'); copy.type = 'button'; copy.setAttribute('aria-label', '复制消息'); copy.append(icon(doc, 'copy'))
      copy.addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(record.text); copy.setAttribute('aria-label', '已复制'); setTimeout(() => copy.setAttribute('aria-label', '复制消息'), 1500) }
        catch { copy.setAttribute('aria-label', '复制失败') }
      })
      actions.append(copy); wrap.append(actions)
    }
    return wrap
  }
  const process = (turn, budget) => {
    const detail = node(doc, 'details', 'native-turn-process'); detail.setAttribute('data-turn', String(turn.turn)); detail.setAttribute('data-key', turn.key + ':process'); detail.setAttribute('data-status', turn.status)
    const head = node(doc, 'summary', 'turn-process-head')
    const duration = elapsedLabel(turn.durationMs)
    const label = turn.status === 'error' ? '执行失败' : turn.status === 'stopped' ? '已停止' : terminal(turn.status) ? '已完成' : '执行过程'
    head.append(icon(doc, 'chevron'), node(doc, 'span', '', label + (duration ? '，用时 ' + duration : '')))
    detail.append(head); remember(detail, turn.key + ':process', turn.status !== 'complete', open => repaint(open ? { itemKey: turn.key + ':process' } : null))
    let loaded = false
    const fill = () => {
      if (!detail.open || loaded) return
      loaded = true
      const members = node(doc, 'div', 'turn-process-body')
      const visible = processRecords(turn), start = processStart(turn, visible)
      if (start > 0) {
        const previous = node(doc, 'button', 'history-load', '查看更早的执行过程'); previous.type = 'button'
        previous.addEventListener('click', () => { processOffsets.set(scoped(turn.key), Math.max(0, start - maxRows)); repaint({ itemKey: turn.key + ':process' }) })
        members.append(previous)
      }
      let end = start
      for (; end < visible.length && budget.remaining > 0; end++) members.append(body(visible[end], budget, { itemKey: turn.key + ':process', turnKey: turn.key, rootIndex: end }))
      if (end < visible.length) {
        const next = node(doc, 'button', 'history-load', '查看后续执行过程'); next.type = 'button'
        next.addEventListener('click', () => { processOffsets.set(scoped(turn.key), end); repaint({ itemKey: turn.key + ':process' }) })
        members.append(next)
      }
      detail.append(members)
    }
    detail.addEventListener('toggle', fill); fill(); return detail
  }
  const disclosure = record => [isOpen(record.key), toolOffsets.get(scoped(record.key)), record.blocks?.map((block, index) => block.kind === 'reasoning' ? isOpen(record.key + ':reason:' + index) : null), record.children?.map(disclosure)]
  const cacheKey = (item, capacity) => JSON.stringify([capacity, item.kind === 'record' ? signature(item.record) : [item.turn.status, item.turn.durationMs, item.turn.processRecords.map(signature)], item.kind === 'record' ? disclosure(item.record) : [isOpen(item.turn.key + ':process', item.turn.status !== 'complete'), processOffsets.get(scoped(item.turn.key)), item.turn.processRecords.map(disclosure)]])
  const runningClock = () => {
    const isRunning = snapshot.status?.running === true
    running.hidden = !isRunning
    if (!isRunning) return
    const started = snapshot.status.startTime
    runningText.textContent = '深度求索中' + (typeof started === 'number' ? '，用时 ' + elapsedLabel(Date.now() - started) : '') + ' ···'
  }
  const draw = () => {
    if (disposed) return
    const oldKeys = new Set(elements.keys()), selected = []
    let remaining = maxRows
    for (let index = windowTail ? items.length - 1 : windowStart; index >= 0 && index < items.length && selected.length < maxRows; index += windowTail ? -1 : 1) {
      const cost = itemCost(items[index])
      if (cost > remaining && remaining === 0) break
      const capacity = Math.min(cost, remaining)
      selected.push({ item: items[index], capacity }); remaining -= capacity
    }
    if (windowTail) { selected.reverse(); windowStart = items.length - selected.length }
    windowEnd = windowStart + selected.length
    for (let index = 0; index < selected.length; index++) {
      const { item, capacity } = selected[index]
      const key = cacheKey(item, capacity), existing = elements.get(item.key)
      let el = existing?.node
      if (!el || existing.signature !== key) {
        const budget = { remaining: capacity }
        el = item.kind === 'record' ? body(item.record, budget, { itemKey: item.key }) : process(item.turn, budget)
        if (existing?.node.parentNode) existing.node.replaceWith(el)
        elements.set(item.key, { node: el, signature: key })
      }
      if (flow.children[index] !== el) flow.insertBefore(el, flow.children[index] || null)
      oldKeys.delete(item.key)
    }
    for (const key of oldKeys) { elements.get(key).node.remove(); elements.delete(key) }
    const heightOf = item => heights.get(item.key) || (item.kind === 'process' ? 32 : item.record.kind === 'user' ? 100 : 70)
    top.style.height = items.slice(0, windowStart).reduce((sum, item) => sum + heightOf(item), 0) + 'px'
    bottom.style.height = items.slice(windowEnd).reduce((sum, item) => sum + heightOf(item), 0) + 'px'
    for (const { item } of selected) { const height = elements.get(item.key).node.getBoundingClientRect().height; if (height) heights.set(item.key, height) }
    older.hidden = !snapshot.hasMore; runningClock()
  }
  const update = (next, metadata = {}) => {
    if (disposed) return
    const changedSession = sessionId !== next.sessionId
    const follow = changedSession || !metadata.preserveAnchor && parseFloat(anchorSlack.style.height) === 0 && scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= 80
    const boxTop = scroller.getBoundingClientRect().top
    const anchor = [...flow.children].find(el => el.getBoundingClientRect().bottom > boxTop)
    const anchorKey = anchor?.getAttribute('data-key'), before = anchor?.getBoundingClientRect().top
    if (changedSession) { sessionId = next.sessionId; elements.clear(); heights.clear(); flow.replaceChildren(); items = []; windowStart = 0 }
    if (follow) anchorSlack.style.height = '0px'
    snapshot = next; const nextItems = conversationItems(snapshot)
    const priorFirst = items[windowStart]?.key; items = nextItems
    windowTail = follow
    windowStart = follow ? tailStart() : Math.max(0, items.findIndex(item => item.key === priorFirst))
    if (metadata.preserveAnchor && items.length <= maxRows) windowStart = 0
    draw()
    if (follow) scroller.scrollTop = scroller.scrollHeight
    else if (anchorKey) {
      const after = elements.get(anchorKey)?.node.getBoundingClientRect().top
      if (before !== undefined && after !== undefined) {
        const desired = scroller.scrollTop + after - before
        // A folded initial page may be shorter than the viewport. Preserve its
        // visible anchor even then; release the trailing room on bottom follow.
        if (metadata.preserveAnchor) {
          const missing = desired - Math.max(0, scroller.scrollHeight - scroller.clientHeight)
          if (missing > 0) anchorSlack.style.height = (parseFloat(anchorSlack.style.height) + missing) + 'px'
        }
        scroller.scrollTop = desired
      }
    }
    jump.hidden = follow
    onMeasure?.({ follow, drawn: flow.querySelectorAll('[data-projection-key]').length, scrollDelta: anchorKey && elements.get(anchorKey) ? elements.get(anchorKey).node.getBoundingClientRect().top - before : null })
    if (snapshot.status?.running && !timer) timer = setInterval(runningClock, 1000)
    if (!snapshot.status?.running && timer) { clearInterval(timer); timer = null }
  }
  const scroll = () => {
    jump.hidden = parseFloat(anchorSlack.style.height) === 0 && scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= 80
    const topHeight = parseFloat(top.style.height || '0'), bottomHeight = parseFloat(bottom.style.height || '0')
    if (windowStart > 0 && scroller.scrollTop < topHeight + 120) { windowTail = false; windowStart = Math.max(0, windowStart - Math.max(1, Math.floor(maxRows / 2))); draw() }
    else if (windowEnd < items.length && scroller.scrollTop + scroller.clientHeight > scroller.scrollHeight - bottomHeight - 120) { windowTail = false; windowStart = Math.min(items.length - 1, windowStart + Math.max(1, Math.floor((windowEnd - windowStart) / 2))); draw() }
  }
  scroller.addEventListener('scroll', scroll, { passive: true })
  jump.addEventListener('click', () => { windowTail = true; anchorSlack.style.height = '0px'; windowStart = tailStart(); draw(); scroller.scrollTop = scroller.scrollHeight; jump.hidden = true })
  older.addEventListener('click', async () => {
    if (loadingOlder || !onOlder) return
    loadingOlder = true; older.disabled = true; older.textContent = '正在加载…'
    try { await onOlder(snapshot.events?.[0]?.seq) }
    catch { older.textContent = '加载失败，点击重试'; return }
    finally { loadingOlder = false; older.disabled = false }
    older.textContent = '加载更早的消息'
  })
  return { update, limits: () => ({ maxDrawn: maxRows, drawn: flow.querySelectorAll('[data-projection-key]').length, total: snapshot.records.length, windowStart }), dispose() { disposed = true; if (timer) clearInterval(timer); timer = null; scroller.removeEventListener('scroll', scroll); elements.clear(); container.replaceChildren() } }
}
