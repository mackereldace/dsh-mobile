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
    const anchor = trigger.getBoundingClientRect(), card = root.querySelector('.composer-card')?.getBoundingClientRect()
    const rect = panel.getBoundingClientRect(), vv = win.visualViewport, width = vv?.width || win.innerWidth || 412
    const left = Math.max(12, Math.min(anchor.left + anchor.width / 2 - rect.width / 2, width - rect.width - 12))
    panel.style.left = left + 'px'; panel.style.top = Math.max(12, (card?.top ?? anchor.top) - rect.height - 8) + 'px'
  }
  const update = () => {
    if (!current) return
    if (trigger?.isConnected === false) { trigger = root.querySelector('[data-cell="' + current + '"]'); if (!trigger) { close(); return } trigger.setAttribute('aria-expanded', 'true') }
    const view = statisticsDetails(current, getValues()), children = []
    const title = doc.createElement('div'); title.className = 'statistics-title'; title.textContent = view.title; children.push(title)
    panel.setAttribute('aria-label', view.title)
    const dl = doc.createElement('dl')
    for (const [label, value] of view.rows) { const dt = doc.createElement('dt'), dd = doc.createElement('dd'); dt.textContent = label; dd.textContent = value; dl.appendChild(dt); dl.appendChild(dd) }
    children.push(dl)
    const note = doc.createElement('p'); note.className = 'statistics-note'; note.textContent = view.rows.length ? view.note : '当前会话尚未提供这项统计。'; children.push(note)
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
