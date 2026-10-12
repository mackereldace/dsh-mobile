/** Native statistics use authoritative session projections, never the DOM window. */
const record = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {}
const count = value => Number.isFinite(value) && value >= 0 ? value : null
const exact = value => Number(value).toLocaleString('zh-CN')
const duration = value => value < 1000 ? Math.round(value) + ' ms' : (value / 1000).toFixed(1) + ' 秒'
export function statisticsDetails(kind, values) {
  const source = record(values), rows = [], add = (label, value, format = exact) => {
    const n = count(value); if (n !== null) rows.push([label, format(n)])
  }
  if (kind === 'context') {
    const pressure = record(source.contextPressure), parts = record(source.contextBreakdown)
    const used = count(pressure.projectedTokens) ?? count(pressure.pressureTokens), capacity = count(pressure.contextWindow)
    add('已用上下文（估算）', used); add('上下文容量', capacity)
    if (used !== null && capacity !== null && capacity > 0) add('剩余容量（估算）', Math.max(0, capacity - used))
    for (const [key, label] of [['systemTokens', '系统提示'], ['toolsTokens', '工具定义'], ['messageTokens', '会话消息']]) add(label + '（估算）', parts[key])
    return { title: '上下文详情', rows, note: Object.keys(parts).length ? '组成按原版启发式估算。' : '当前后端尚未提供上下文组成。' }
  }
  if (kind === 'turns' || kind === 'steps') {
    const stats = record(source.sessionStats)
    add('轮次', stats.turns); add('步骤', stats.steps)
    add('模型耗时', stats.llmMs, duration); add('工具耗时', stats.toolMs, duration)
    if (count(stats.ttftSteps) > 0 && count(stats.ttftMs) !== null) add('平均首 token 延迟', stats.ttftMs / stats.ttftSteps, duration)
    if (count(stats.decodeMs) > 0 && count(stats.decodeTokens) !== null) add('生成速度', stats.decodeTokens / (stats.decodeMs / 1000), value => value.toFixed(1) + ' token/秒')
    return { title: '会话统计', rows, note: '统计来自完整会话，包含已加载窗口以外的轮次。' }
  }
  const usage = record(source.tokenUsage), inputs = ['uncachedInputTokens', 'cacheReadTokens', 'cacheWriteTokens'].map(key => count(usage[key]))
  if (inputs.every(value => value !== null) && count(usage.outputTokens) !== null) add('总 token', inputs.reduce((sum, value) => sum + value, 0) + usage.outputTokens)
  for (const [key, label] of [['uncachedInputTokens', '未缓存输入'], ['cacheReadTokens', '缓存读取'], ['cacheWriteTokens', '缓存写入'], ['outputTokens', '输出']]) add(label, usage[key])
  if (inputs.every(value => value !== null) && inputs.reduce((sum, value) => sum + value, 0) > 0) add('缓存命中率', inputs[1] / inputs.reduce((sum, value) => sum + value, 0) * 100, value => value.toFixed(1) + '%')
  return { title: 'Token 用量', rows, note: '以当前后端实际报告的用量为准。' }
}

const contextParts = [['systemTokens', '系统提示词', 'system'], ['toolsTokens', '工具定义', 'tools'], ['messageTokens', '对话消息', 'messages']]
const compact = value => value < 1000 ? String(value) : ((value < 1e6 ? value / 1000 : value / 1e6) >= 100
  ? Math.round(value < 1e6 ? value / 1000 : value / 1e6) : Math.round((value < 1e6 ? value / 1000 : value / 1e6) * 10) / 10) + (value < 1e6 ? 'K' : 'M')
const elapsed = value => value < 60000 ? Math.round(value / 100) / 10 + ' 秒' : Math.floor(Math.round(value / 1000) / 60) + ' 分 ' + Math.round(value / 1000) % 60 + ' 秒'

/** Presentation follows native ContextMeter and StatsPills without inventing absent readings. */
export function statisticsPresentation(kind, values) {
  const source = record(values), details = statisticsDetails(kind, source)
  const view = { title: details.title, summary: '', reading: '', segments: [], rows: [], note: '' }
  if (kind === 'context') {
    const pressure = record(source.contextPressure), breakdown = record(source.contextBreakdown)
    const used = count(pressure.projectedTokens) ?? count(pressure.pressureTokens), capacity = count(pressure.contextWindow)
    if (used !== null && capacity !== null && capacity > 0) {
      const percent = Math.min(100, Math.round(used / capacity * 100))
      view.title = '上下文已用'; view.reading = percent + '%'; view.summary = '~' + compact(used) + ' / ' + compact(capacity)
      const total = contextParts.reduce((sum, [key]) => sum + (count(breakdown[key]) ?? 0), 0)
      view.segments = (total > 0 ? contextParts.filter(([key]) => count(breakdown[key]) > 0).map(([key, , color]) => ({ key, color, width: percent * breakdown[key] / total })) : [{ key: 'total', color: 'messages', width: percent }]).filter(part => part.width > 0)
    }
    view.rows = contextParts.filter(([key]) => count(breakdown[key]) !== null).map(([key, label, color]) => ({ label, value: '~' + compact(breakdown[key]), color }))
    if (!view.summary || !view.rows.length) view.note = !view.summary ? '当前会话尚未提供上下文用量。' : '当前后端尚未提供上下文组成。'
    return view
  }
  if (kind === 'turns' || kind === 'steps') {
    const stats = record(source.sessionStats), add = (label, value, format = elapsed) => { if (count(value) !== null) view.rows.push({ label, value: format(value) }) }
    add('模型用时', stats.llmMs); add('工具调用用时', stats.toolMs)
    if (count(stats.ttftSteps) > 0 && count(stats.ttftMs) !== null) add('首 token 平均（TTFT）', stats.ttftMs / stats.ttftSteps)
    if (count(stats.decodeMs) > 0 && count(stats.decodeTokens) !== null) add('输出速度（TPS）', stats.decodeTokens / (stats.decodeMs / 1000), value => Math.round(value * 10) / 10 + ' tok/s')
    if (!view.rows.length) view.rows = details.rows.map(([label, value]) => ({ label, value }))
  } else {
    const total = details.rows.find(([label]) => label === '总 token')
    if (total) view.summary = total[1] + ' tok'
    const hit = details.rows.find(([label]) => label === '缓存命中率')
    if (hit) {
      const usage = record(source.tokenUsage), input = usage.uncachedInputTokens + usage.cacheReadTokens + usage.cacheWriteTokens
      const percent = usage.cacheReadTokens / input * 100
      let precision = 0
      while (precision < 12 && usage.cacheReadTokens < input && Number(percent.toFixed(precision)) >= 100) precision++
      view.rows.push({ label: '缓存命中', value: Number(percent.toFixed(precision)) + '%' })
    }
    view.rows.push(...details.rows.filter(([label]) => !['总 token', '缓存命中率'].includes(label)).map(([label, value]) => ({ label, value: value + ' tok' })))
  }
  if (!view.rows.length) view.note = '当前会话尚未提供这项统计。'
  return view
}

export function mountStatistics({ root, getValues }) {
  const doc = root.ownerDocument || (typeof root.createElement === 'function' ? root : globalThis.document), win = doc?.defaultView || globalThis
  if (!doc?.createElement || !(doc.body || root)?.appendChild) return { toggle() {}, update() {}, close: () => false, available: () => false, dispose() {} }
  const panel = doc.createElement('div'); panel.id = 'statistics-details'; panel.className = 'statistics-details'; panel.hidden = true
  panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-modal', 'false')
  ;(doc.body || root).appendChild(panel)
  let current = null, trigger = null
  const close = (focus = false) => {
    if (!current) return false
    current = null; panel.hidden = true; trigger?.setAttribute('aria-expanded', 'false')
    if (focus) trigger?.focus(); trigger = null; return true
  }
  const position = () => {
    if (!current || !trigger?.getBoundingClientRect) return
    const anchor = trigger.getBoundingClientRect(), rect = panel.getBoundingClientRect(), vv = win.visualViewport
    const leftEdge = vv?.offsetLeft || 0, topEdge = vv?.offsetTop || 0, width = vv?.width || win.innerWidth || 412, height = vv?.height || win.innerHeight || 915
    const left = Math.max(leftEdge + 12, Math.min(anchor.left + anchor.width / 2 - rect.width / 2, leftEdge + width - rect.width - 12))
    const top = Math.max(topEdge + 12, Math.min(anchor.top - rect.height - (current === 'context' ? 8 : 6), topEdge + height - rect.height - 12))
    panel.style.left = left + 'px'; panel.style.top = top + 'px'
  }
  const node = (tag, className, text) => { const el = doc.createElement(tag); if (className) el.className = className; if (text !== undefined) el.textContent = text; return el }
  const glyph = kind => {
    if (!doc.createElementNS) return null
    const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg'), path = doc.createElementNS('http://www.w3.org/2000/svg', 'path')
    svg.setAttribute('viewBox', '0 0 16 16'); svg.setAttribute('aria-hidden', 'true')
    path.setAttribute('d', kind === 'tokens' ? 'M13 3.5c0 1.4-2.2 2.5-5 2.5S3 4.9 3 3.5 5.2 1 8 1s5 1.1 5 2.5ZM3 3.5v9c0 1.4 2.2 2.5 5 2.5s5-1.1 5-2.5v-9M3 8c0 1.4 2.2 2.5 5 2.5s5-1.1 5-2.5' : 'M3 13a6.5 6.5 0 1 1 10 0M8 8l4-4M4 5l1 1M12 5l-1 1M7.5 9h1')
    for (const [key, value] of Object.entries({ fill: 'none', stroke: 'currentColor', 'stroke-width': '1.25', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })) path.setAttribute(key, value)
    svg.appendChild(path); return svg
  }
  const update = () => {
    if (!current) return
    if (trigger?.isConnected === false) { trigger = root.querySelector('[data-cell="' + current + '"]'); if (!trigger) { close(); return } trigger.setAttribute('aria-expanded', 'true') }
    const view = statisticsPresentation(current, getValues()), children = []
    panel.setAttribute('data-kind', current); panel.setAttribute('aria-label', view.title)
    const title = node('div', 'statistics-title'), label = node('span', 'statistics-title-label')
    const mark = current === 'context' ? null : glyph(current)
    if (mark) label.appendChild(mark)
    label.appendChild(node('span', 'statistics-title-text', view.title)); title.appendChild(label)
    if (view.reading) title.appendChild(node('span', 'statistics-reading', view.reading))
    if (view.summary) title.appendChild(node('span', 'statistics-summary', view.summary))
    children.push(title)
    if (current === 'context') {
      const bar = node('div', 'statistics-context-bar'); bar.setAttribute('aria-hidden', 'true')
      for (const part of view.segments) { const segment = node('span', 'statistics-context-segment statistics-color-' + part.color); segment.style.width = part.width + '%'; segment.setAttribute('data-part', part.key); bar.appendChild(segment) }
      children.push(bar)
    } else { const rule = node('div', 'statistics-title-rule'); rule.setAttribute('aria-hidden', 'true'); children.push(rule) }
    const dl = node('dl')
    for (const row of view.rows) {
      const dt = node('dt'), dd = node('dd', '', row.value)
      if (row.color) { const swatch = node('span', 'statistics-swatch statistics-color-' + row.color); swatch.setAttribute('aria-hidden', 'true'); dt.appendChild(swatch) }
      dt.appendChild(node('span', '', row.label)); dl.appendChild(dt); dl.appendChild(dd)
    }
    children.push(dl)
    if (view.note) children.push(node('p', 'statistics-note', view.note))
    panel.replaceChildren(...children); position()
  }
  const toggle = (kind, anchor) => {
    if (current === kind && trigger === anchor) return close()
    close(); current = kind; trigger = anchor; panel.hidden = false; anchor.setAttribute('aria-expanded', 'true'); update()
  }
  const outside = event => { if (!panel.contains(event.target) && !trigger?.contains(event.target)) close() }
  const key = event => { if (event.key === 'Escape' && close(true)) event.preventDefault() }
  doc.addEventListener('click', outside); doc.addEventListener('keydown', key)
  win.addEventListener?.('resize', position); win.visualViewport?.addEventListener('resize', position)
  return { toggle, update, close, available: () => current !== null, dispose() { close(); panel.remove(); doc.removeEventListener('click', outside); doc.removeEventListener('keydown', key); win.removeEventListener?.('resize', position); win.visualViewport?.removeEventListener('resize', position) } }
}
