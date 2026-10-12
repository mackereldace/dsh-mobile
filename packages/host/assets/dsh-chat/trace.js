/** Native trajectory seat. The shared projection owns records; local state owns focus. */
import { icon, toolPresentation } from './conversation.js'
const finite = value => typeof value === 'number' && Number.isFinite(value)
const lane = kind => kind === 'tool' ? 2 : kind === 'assistant' ? 1 : 0
const interval = record => {
  const start = record.kind === 'tool' && finite(record.callTime) ? record.callTime : record.time
  return { start: finite(start) ? start : null, end: finite(start) ? Math.max(start, finite(record.endTime) ? record.endTime : start) : null }
}
export function matchesTraceQuery(row, query) {
  const text = [row.title, row.summary, row.record?.text, row.record?.reasoning, row.record?.name, row.record?.argsRaw, row.record?.output, row.record?.status, row.record?.event?.type, JSON.stringify(row.record?.event?.data ?? {})].join(' ').toLocaleLowerCase()
  return String(query || '').trim().toLocaleLowerCase().split(/\s+/).filter(Boolean).every(term => text.includes(term))
}
const inRange = (row, range) => !range || row.start !== null && row.start <= Math.max(range.from, range.to) && row.end >= Math.min(range.from, range.to)
const titleFor = record => record.kind === 'tool' ? toolPresentation(record).title : ({ user: '输入', assistant: '模型', approval: '审批', error: '错误' })[record.kind] || '上下文'
const summaryFor = record => record.kind === 'tool' ? toolPresentation(record).summary : record.text || record.reasoning || record.title || record.event?.type || ''

/** All rows are logical; no 200-row truncation belongs in this function. */
export function traceRows(snapshot, options = {}) {
  const rows = (snapshot.records || []).filter(record => record.visible !== false).map(record => ({
    key: record.key, kind: record.kind, seq: record.seq, turn: record.turn, step: record.step,
    title: titleFor(record), summary: summaryFor(record), record, lane: lane(record.kind),
    ...interval(record), error: record.status === 'error' || record.isError === true,
  })).filter(row => matchesTraceQuery(row, options.query) && inRange(row, options.selection))
  if (!options.collapsedTurns && !options.collapsedCalls) return rows
  const output = [], grouped = new Map()
  for (const row of rows) {
    const turnFold = options.collapsedTurns && row.turn !== null
    const callFold = options.collapsedCalls && row.turn !== null && row.step !== null && row.kind !== 'user'
    if (!turnFold && !callFold) { output.push(row); continue }
    const key = turnFold ? 'turn-summary:' + row.turn : 'call-summary:' + row.turn + ':' + row.step
    if (!grouped.has(key)) {
      const group = { ...row, key, kind: turnFold ? 'turn-summary' : 'call-summary', title: turnFold ? '第 ' + row.turn + ' 轮' : '第 ' + row.step + ' 次调用', summary: '', members: [], lane: turnFold ? 0 : 1 }
      grouped.set(key, group); output.push(group)
    }
    const group = grouped.get(key)
    group.members.push(row); group.summary = group.members.length + ' 条记录'
    if (row.start !== null) group.start = group.start === null ? row.start : Math.min(group.start, row.start)
    if (row.end !== null) group.end = group.end === null ? row.end : Math.max(group.end, row.end)
    group.error ||= row.error
  }
  return output
}

/** Recorded-duration mode removes every uncovered idle gap, including overlapping lanes. */
export function traceLayout(rows, { duration = false } = {}) {
  let removed = 0, covered = null
  const offsets = new Map()
  for (const row of [...rows].filter(row => row.start !== null).sort((a, b) => a.start - b.start || a.end - b.end)) {
    if (covered !== null && row.start > covered) removed += row.start - covered
    offsets.set(row.key, removed)
    covered = covered === null ? row.end : Math.max(covered, row.end)
  }
  const spans = rows.flatMap((row, index) => duration && row.start === null ? [] : [{ ...row,
    positionStart: duration ? row.start - (offsets.get(row.key) || 0) : index,
    positionEnd: duration ? row.end - (offsets.get(row.key) || 0) : index + 1,
  }])
  const start = spans.length ? Math.min(...spans.map(row => row.positionStart)) : 0
  const end = spans.length ? Math.max(...spans.map(row => row.positionEnd)) : 1
  return { start, end, duration, spans: spans.map(row => ({ ...row, x: (row.positionStart - start) / Math.max(1, end - start), width: (row.positionEnd - row.positionStart) / Math.max(1, end - start) })) }
}

/** Map a graph coordinate back to actual recorded time, for range/table focus. */
export function traceTimeAt(layout, fraction) {
  const position = layout.start + Math.max(0, Math.min(1, fraction)) * (layout.end - layout.start)
  const spans = [...layout.spans].sort((a, b) => a.positionStart - b.positionStart)
  if (!spans.length) return null
  const row = spans.find(span => span.positionStart <= position && span.positionEnd >= position) || (position < spans[0].positionStart ? spans[0] : spans.at(-1))
  if (row.start === null) return null
  const ratio = Math.max(0, Math.min(1, (position - row.positionStart) / Math.max(1, row.positionEnd - row.positionStart)))
  return row.start + (row.end - row.start) * ratio
}

export function tracePositionAt(layout, time) {
  const timed = [...layout.spans].filter(row => row.start !== null).sort((a, b) => a.start - b.start)
  if (!timed.length) return 0
  const row = timed.find(span => span.start <= time && span.end >= time) || timed.filter(span => span.start <= time).at(-1) || timed[0]
  const ratio = Math.max(0, Math.min(1, (time - row.start) / Math.max(1, row.end - row.start)))
  const position = row.positionStart + ratio * (row.positionEnd - row.positionStart)
  return Math.max(0, Math.min(1, (position - layout.start) / Math.max(1, layout.end - layout.start)))
}

const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value))
const ordered = (from, to) => ({ from: Math.min(from, to), to: Math.max(from, to) })
const bounds = layout => ({ from: layout.start, to: Math.max(layout.start + 1, layout.end) })
const overlaps = (span, range) => !range || span.positionStart <= range.to && span.positionEnd >= range.from

/** The display window is independent of search, table pagination, and selection. */
export function traceViewport(layout, viewport = null) {
  const full = bounds(layout)
  if (!viewport || !finite(viewport.from) || !finite(viewport.to)) return full
  const minimum = Math.min(layout.duration ? 20 : 4, full.to - full.from)
  const width = clamp(Math.abs(viewport.to - viewport.from), minimum, full.to - full.from)
  const from = clamp(Math.min(viewport.from, viewport.to), full.from, full.to - width)
  return { from, to: from + width }
}

/** Keep an axis location attached to a stable record when history is prepended. */
const axisAnchor = (layout, position, edge) => {
  const spans = layout.spans
  const span = spans.find(span => edge === 'from'
    ? span.positionStart <= position && span.positionEnd > position
    : span.positionStart < position && span.positionEnd >= position)
    || spans.find(span => span.positionStart === position)
    || (position <= layout.start ? spans[0] : spans.at(-1))
  return span ? { key: span.key, fraction: clamp((position - span.positionStart) / Math.max(1, span.positionEnd - span.positionStart), 0, 1) } : null
}
const anchorPosition = (layout, anchor) => {
  const span = anchor && layout.spans.find(span => span.key === anchor.key)
  return span ? span.positionStart + (span.positionEnd - span.positionStart) * anchor.fraction : null
}
const rangeAnchors = (layout, range) => range && ({ from: axisAnchor(layout, range.from, 'from'), to: axisAnchor(layout, range.to, 'to') })
const anchoredRange = (layout, anchors, fallback) => {
  const from = anchorPosition(layout, anchors?.from), to = anchorPosition(layout, anchors?.to)
  return from !== null && to !== null ? ordered(from, to) : fallback
}

export function mountTrace({ container, renderMarkdown, onOlder, maxRows = 200 }) {
  maxRows = Math.min(200, Math.max(1, Math.trunc(maxRows) || 200))
  const doc = container.ownerDocument
  const el = (tag, cls, text) => { const result = doc.createElement(tag); if (cls) result.className = cls; if (text !== undefined) result.textContent = text; return result }
  const button = (label, action, cls = '') => { const result = el('button', cls, label); result.type = 'button'; result.addEventListener('click', action); return result }
  const toolbar = el('div', 'native-trace-toolbar trace-toolbar'); toolbar.setAttribute('role', 'toolbar'); toolbar.setAttribute('aria-label', '轨迹工具栏')
  const controls = {}, sessions = new Map()
  let snapshot = { records: [], turns: [], status: {}, hasMore: false }, pendingSnapshot = null, disposed = false
  let rows = [], allRows = [], rowByKey = new Map(), spanByKey = new Map(), layout = traceLayout([]), drag = null, draft = null, windowStart = null, sessionId = null, suppressClickUntil = 0
  let selectionSource = null, selectionAnchors = null, viewportAnchors = null, selectedKeys = new Set()
  const local = { duration: false, collapsedTurns: false, collapsedCalls: false, query: '', selection: null, selectionRange: null, viewport: null, selectedKey: null, expandedKeys: new Set() }
  for (const [key, label, prop] of [['duration', '时长', 'duration'], ['turns', '轮次', 'collapsedTurns'], ['calls', '调用', 'collapsedCalls']]) {
    const control = button(label, () => { cancelDrag(); local[prop] = !local[prop]; render() })
    control.replaceChildren(icon(doc, key === 'duration' ? 'clock' : 'rows'), el('span', '', label)); control.setAttribute('data-trace-control', key); controls[key] = control; toolbar.appendChild(control)
  }
  const search = el('input', 'native-trace-search'); search.type = 'search'; search.placeholder = '搜索'; search.setAttribute('aria-label', '搜索轨迹')
  search.addEventListener('input', () => { cancelDrag(); local.query = search.value; windowStart = null; render() }); toolbar.appendChild(search)
  const graph = el('div', 'native-trace-graph'); graph.setAttribute('aria-label', '输入、模型、工具三条泳道的会话轨迹')
  const labels = el('div', 'native-trace-lanes'); ['输入', '模型', '工具'].forEach(label => labels.appendChild(el('span', '', label)))
  const plot = el('div', 'native-trace-plot'); plot.setAttribute('role', 'group'); plot.setAttribute('aria-label', '时间线，拖动选择时间范围，滚轮缩放'); plot.tabIndex = 0
  const bars = el('div', 'native-trace-bars')
  const overlay = el('div', 'native-trace-selection'); overlay.setAttribute('aria-hidden', 'true')
  const selectionHandles = {}
  for (const edge of ['from', 'to']) {
    const handle = el('button', 'native-trace-selection-handle'); handle.type = 'button'; handle.setAttribute('role', 'slider'); handle.setAttribute('data-edge', edge); handle.setAttribute('data-trace-selection-edge', edge); handle.setAttribute('aria-label', edge === 'from' ? '调整选区开始' : '调整选区结束')
    selectionHandles[edge] = handle
  }
  plot.append(bars, overlay, selectionHandles.from, selectionHandles.to); graph.append(labels, plot)
  const scrollbar = el('div', 'native-trace-scrollbar'); scrollbar.setAttribute('aria-label', '轨迹显示窗口，拖动窗口或两端调整显示范围')
  const thumb = el('div', 'native-trace-viewport-thumb'); thumb.setAttribute('role', 'slider'); thumb.setAttribute('aria-label', '平移轨迹显示窗口'); thumb.tabIndex = 0
  const viewportHandles = {}
  for (const edge of ['from', 'to']) {
    const handle = el('button', 'native-trace-viewport-handle'); handle.type = 'button'; handle.setAttribute('role', 'slider'); handle.setAttribute('data-edge', edge); handle.setAttribute('data-trace-viewport-edge', edge); handle.setAttribute('aria-label', edge === 'from' ? '调整显示窗口开始' : '调整显示窗口结束')
    viewportHandles[edge] = handle; thumb.appendChild(handle)
  }
  scrollbar.appendChild(thumb)
  const windowControls = el('div', 'native-trace-window-controls'), windowLabel = el('output', 'native-trace-viewport-label')
  const reset = button('显示全部', () => { cancelDrag(); setViewport(null) }, 'native-trace-viewport-reset'); windowControls.append(windowLabel, reset)
  const ranges = el('div', 'native-trace-ranges'), from = el('input'), to = el('input')
  for (const [input, label] of [[from, '选区开始'], [to, '选区结束']]) { input.type = 'range'; input.step = '1'; input.setAttribute('aria-label', label); ranges.appendChild(input) }
  const rangeLabel = el('output', 'native-trace-range-label'); ranges.appendChild(rangeLabel)
  const clear = button('清除选区', () => setSelection(null), 'native-trace-range-clear'); ranges.appendChild(clear)
  const older = button('加载更早的轨迹', async () => {
    const start = windowStart ?? Math.max(0, rows.length - maxRows)
    if (start > 0) { windowStart = Math.max(0, start - maxRows); render(); return }
    if (onOlder) { older.disabled = true; try { await onOlder(snapshot.events?.[0]?.seq) } finally { older.disabled = false } }
  }, 'history-load')
  const newer = button('查看较新的轨迹', () => { windowStart = Math.min(Math.max(0, rows.length - maxRows), (windowStart ?? 0) + maxRows); render() }, 'native-trace-newer')
  const table = el('table', 'native-trace-table'), columns = el('colgroup'); table.appendChild(columns)
  const head = el('thead'), header = el('tr')
  for (const label of ['事件', '内容', '时长']) header.appendChild(el('th', '', label))
  head.appendChild(header); const body = el('tbody'); table.append(head, body)
  const empty = el('div', 'native-trace-empty', '还没有轨迹')
  container.replaceChildren(toolbar, graph, scrollbar, windowControls, ranges, older, newer, table, empty)
  const md = (target, text) => { if (renderMarkdown) renderMarkdown(target, text); else target.textContent = text }
  const selected = row => row.key === local.selectedKey || row.members?.some(member => member.key === local.selectedKey)
  const rangeSelected = row => selectedKeys.has(row.key) || row.members?.some(member => selectedKeys.has(member.key))
  const activeRange = () => draft || local.selectionRange
  const domain = () => traceViewport(layout, local.viewport)
  const positionAt = (event, rect, range) => range.from + clamp((event.clientX - rect.left) / Math.max(1, rect.width), 0, 1) * (range.to - range.from)
  const actualRange = range => {
    if (!range) return null
    const full = bounds(layout), first = traceTimeAt(layout, (range.from - full.from) / (full.to - full.from)), last = traceTimeAt(layout, (range.to - full.from) / (full.to - full.from))
    return first === null || last === null ? null : ordered(first, last)
  }
  function setViewport(range, paint = false) {
    const next = traceViewport(layout, range), full = bounds(layout)
    local.viewport = !range || next.to - next.from >= (full.to - full.from) * .999 ? null : next
    viewportAnchors = rangeAnchors(layout, local.viewport)
    if (paint) paintGraph(); else render()
  }
  function refreshSelection() {
    const range = activeRange()
    selectedKeys = new Set((draft || selectionSource === 'axis')
      ? layout.spans.filter(span => overlaps(span, range) && range).map(span => span.key)
      : allRows.filter(row => local.selection && inRange(row, local.selection)).map(row => row.key))
  }
  function updateSelection(range, source = 'axis') {
    selectionSource = range ? source : null; local.selectionRange = range
    if (source === 'axis') local.selection = actualRange(range)
    selectionAnchors = rangeAnchors(layout, range); refreshSelection()
  }
  const focus = (key, shouldRender = true) => {
    local.selectedKey = key
    const index = rows.findIndex(row => row.key === key || row.members?.some(member => member.key === key))
    if (index >= 0) windowStart = Math.max(0, Math.min(index, Math.max(0, rows.length - maxRows)))
    const span = layout.spans.find(span => span.key === key), visible = domain()
    if (local.viewport && span && (span.positionEnd <= visible.from || span.positionStart >= visible.to)) {
      const width = visible.to - visible.from
      const start = span.positionEnd <= visible.from ? span.positionStart : span.positionEnd - width
      const next = traceViewport(layout, { from: start, to: start + width }); local.viewport = next; viewportAnchors = rangeAnchors(layout, next)
    }
    if (shouldRender) render()
    const targetKey = rows.find(row => row.key === key || row.members?.some(member => member.key === key))?.key
    const target = [...body.children].find(row => row.getAttribute('data-trace-key') === targetKey)
    target?.scrollIntoView?.({ block: 'nearest' })
  }
  function focusSelection() {
    const row = rows.find(rangeSelected)
    if (row) focus(row.members?.find(member => selectedKeys.has(member.key))?.key || row.key); else render()
  }
  function details(row) {
    const cell = el('td', 'native-trace-detail'); cell.colSpan = local.duration ? 3 : 2
    if (row.members) {
      for (const member of row.members) cell.appendChild(button(member.title + ' · ' + member.summary, () => { local.collapsedTurns = false; local.collapsedCalls = false; focus(member.key) }, 'native-trace-member'))
    } else {
      const record = row.record
      if (record.kind === 'tool') {
        for (const [label, text] of [['IN', record.input || record.argsRaw || ''], ['OUT', record.output || '']]) { const section = el('div', 'native-trace-io'); section.append(el('span', 'native-trace-io-label', label), el('pre', 'native-trace-io-text', text)); cell.appendChild(section) }
        if (record.status === 'error') cell.appendChild(el('div', 'native-trace-error', '工具执行失败'))
      } else { if (record.reasoning) { const thought = el('div', 'native-trace-reasoning'); md(thought, record.reasoning); cell.appendChild(thought) }; const content = el('div', 'native-trace-body'); md(content, record.text || row.summary); cell.appendChild(content) }
      cell.appendChild(el('div', 'native-trace-time', '开始：' + (row.start === null ? '暂无计时数据' : new Date(row.start).toISOString()) + (row.end !== null ? ' · 结束：' + new Date(row.end).toISOString() : '')))
    }
    const tr = el('tr', 'native-trace-detail-row'); tr.appendChild(cell); return tr
  }
  function sliderAttributes(element, value, minimum, maximum) {
    element.setAttribute('aria-valuemin', String(minimum)); element.setAttribute('aria-valuemax', String(maximum)); element.setAttribute('aria-valuenow', String(value)); element.setAttribute('aria-orientation', 'horizontal')
  }
  function paintGraph() {
    refreshSelection()
    const full = bounds(layout), visible = domain(), width = visible.to - visible.from, range = activeRange()
    plot.setAttribute('data-domain-start', String(full.from)); plot.setAttribute('data-domain-end', String(full.to)); plot.setAttribute('data-viewport-start', String(visible.from)); plot.setAttribute('data-viewport-end', String(visible.to)); plot.setAttribute('data-view-mode', local.duration ? 'duration' : 'sequence'); plot.setAttribute('data-dragging', String(!!drag)); plot.setAttribute('data-panning', String(drag?.mode === 'pan' || drag?.mode === 'viewport-pan'))
    for (const bar of bars.children) {
      const span = spanByKey.get(bar.getAttribute('data-trace-key')); if (!span) continue
      bar.style.left = ((span.positionStart - visible.from) / width * 100) + '%'; bar.style.width = Math.max(local.duration ? .2 : .5, (span.positionEnd - span.positionStart) / width * 100) + '%'
      bar.setAttribute('data-selected', String(!range || selectedKeys.has(span.key))); bar.setAttribute('data-search-match', String(matchesTraceQuery(span, local.query)))
      bar.classList.toggle('selected', selected(span))
    }
    overlay.hidden = !range
    for (const edge of ['from', 'to']) {
      const handle = selectionHandles[edge]; handle.hidden = !range || range[edge] < visible.from || range[edge] > visible.to
      handle.style.left = (range ? (range[edge] - visible.from) / width * 100 : 0) + '%'
      sliderAttributes(handle, range?.[edge] ?? full[edge], full.from, full.to)
    }
    if (range) { overlay.style.left = ((range.from - visible.from) / width * 100) + '%'; overlay.style.width = Math.max(.2, (range.to - range.from) / width * 100) + '%'; overlay.setAttribute('data-dragging', String(!!draft)) }
    thumb.style.left = ((visible.from - full.from) / (full.to - full.from) * 100) + '%'; thumb.style.width = (width / (full.to - full.from) * 100) + '%'
    sliderAttributes(thumb, visible.from, full.from, full.to - width)
    thumb.setAttribute('aria-valuetext', Math.round(width / (full.to - full.from) * 100) + '% 的轨迹')
    for (const edge of ['from', 'to']) sliderAttributes(viewportHandles[edge], visible[edge], full.from, full.to)
    scrollbar.hidden = layout.spans.length === 0; windowControls.hidden = layout.spans.length === 0; reset.disabled = !local.viewport
    windowLabel.textContent = local.viewport ? '显示 ' + Math.round(width / (full.to - full.from) * 100) + '%' : '完整轨迹'
    const timed = allRows.filter(row => row.start !== null), min = timed.length ? Math.min(...timed.map(row => row.start)) : 0, max = timed.length ? Math.max(...timed.map(row => row.end)) : 0
    const real = draft ? actualRange(draft) : local.selection
    for (const input of [from, to]) { input.min = String(min); input.max = String(max); input.disabled = !timed.length }
    from.value = String(real?.from ?? min); to.value = String(real?.to ?? max); ranges.hidden = !range && !local.selection
    rangeLabel.textContent = ranges.hidden ? '' : selectedKeys.size + ' 条记录' + (real ? ' · ' + Math.round(Math.max(0, real.to - real.from)) + ' 毫秒' : '')
    clear.hidden = ranges.hidden
    for (const row of body.children) {
      const logical = rowByKey.get(row.getAttribute('data-trace-key'))
      if (logical) row.setAttribute('data-range-selected', String(!!range && rangeSelected(logical)))
    }
  }
  function render() {
    if (disposed) return
    if (drag) { paintGraph(); return }
    const scroller = container.closest?.('main') || container, scrollTop = scroller.scrollTop || 0, edge = scroller.getBoundingClientRect?.().top ?? 0
    const anchor = [...body.children].find(row => row.hasAttribute('data-trace-key') && (row.getBoundingClientRect?.().top ?? 0) >= edge)
    const anchorKey = anchor?.getAttribute('data-trace-key'), anchorTop = anchor?.getBoundingClientRect?.().top
    const oldRows = rows, oldWindowKey = windowStart === null ? null : oldRows[windowStart]?.key
    allRows = traceRows(snapshot)
    layout = traceLayout(allRows, { duration: local.duration })
    spanByKey = new Map(layout.spans.map(span => [span.key, span]))
    local.viewport = local.viewport ? traceViewport(layout, anchoredRange(layout, viewportAnchors, local.viewport)) : null
    viewportAnchors = rangeAnchors(layout, local.viewport)
    if (selectionSource === 'axis') {
      if (selectionAnchors && anchorPosition(layout, selectionAnchors.from) === null && anchorPosition(layout, selectionAnchors.to) === null) updateSelection(null)
      else { local.selectionRange = anchoredRange(layout, selectionAnchors, local.selectionRange); local.selection = actualRange(local.selectionRange) }
    }
    else if (local.selection) {
      const full = bounds(layout)
      local.selectionRange = ordered(full.from + tracePositionAt(layout, local.selection.from) * (full.to - full.from), full.from + tracePositionAt(layout, local.selection.to) * (full.to - full.from))
    }
    selectionAnchors = rangeAnchors(layout, local.selectionRange); refreshSelection()
    rows = traceRows(snapshot, { query: local.query, collapsedTurns: local.collapsedTurns, collapsedCalls: local.collapsedCalls })
    rowByKey = new Map(rows.map(row => [row.key, row]))
    if (oldWindowKey) { const index = rows.findIndex(row => row.key === oldWindowKey); if (index >= 0) windowStart = index }
    table.setAttribute('data-duration', String(local.duration))
    const eventColumn = el('col'); eventColumn.style.width = '50px'; columns.replaceChildren(eventColumn, el('col'))
    if (local.duration) { const durationColumn = el('col'); durationColumn.style.width = '68px'; columns.appendChild(durationColumn) }
    for (const [key, prop] of [['duration', 'duration'], ['turns', 'collapsedTurns'], ['calls', 'collapsedCalls']]) { controls[key].setAttribute('aria-pressed', String(local[prop])); controls[key].classList.toggle('active', local[prop]) }
    const visible = domain(), candidates = layout.spans.filter(span => overlaps(span, visible)), visibleSpans = candidates.length <= maxRows ? candidates : Array.from({ length: maxRows }, (_, index) => candidates[Math.round(index * (candidates.length - 1) / Math.max(1, maxRows - 1))])
    const focused = candidates.find(span => selected(span)); if (focused && !visibleSpans.includes(focused)) visibleSpans[visibleSpans.length - 1] = focused
    bars.replaceChildren()
    for (const span of visibleSpans) {
      const bar = button('', event => {
        event?.stopPropagation?.(); if (Date.now() < suppressClickUntil && event?.detail !== 0) { event?.preventDefault?.(); return }
        updateSelection(null); focus(span.key)
      }, 'trace-bar native-trace-bar')
      bar.title = span.title + ' · ' + span.summary
      bar.setAttribute('data-trace-key', span.key); bar.setAttribute('data-trace-seq', String(span.seq ?? '')); bar.setAttribute('data-lane', String(span.lane)); bar.setAttribute('data-error', String(span.error)); bar.style.top = (7 + span.lane * 14) + 'px'; bars.appendChild(bar)
    }
    body.replaceChildren()
    const start = windowStart === null ? Math.max(0, rows.length - maxRows) : Math.max(0, Math.min(windowStart, Math.max(0, rows.length - maxRows)))
    older.hidden = !snapshot.hasMore && start === 0; older.textContent = start > 0 ? '查看更早 ' + Math.min(start, maxRows) + ' 条轨迹' : '加载更早的轨迹'; newer.hidden = start + maxRows >= rows.length
    let previousTurn = undefined
    for (const row of rows.slice(start, start + maxRows)) {
      const tr = el('tr', 'native-trace-row' + (selected(row) ? ' selected' : '')); tr.setAttribute('data-trace-seq', String(row.seq ?? '')); tr.setAttribute('data-trace-key', row.key); tr.setAttribute('data-turn', String(row.turn ?? '')); tr.setAttribute('data-error', String(row.error)); tr.setAttribute('data-turn-start', String(previousTurn !== row.turn)); previousTurn = row.turn
      tr.setAttribute('data-kind', row.kind)
      const kind = el('td', 'native-trace-kind'), mark = el('span', 'native-trace-kind-mark')
      mark.appendChild(icon(doc, row.kind === 'tool' ? 'tool' : row.kind === 'assistant' ? 'sparkles' : row.kind === 'user' ? 'user' : 'file')); mark.setAttribute('title', row.title); kind.appendChild(mark)
      if (previousTurn !== undefined && tr.getAttribute('data-turn-start') === 'true' && row.turn !== null) kind.appendChild(el('span', 'native-trace-turn-label', '#' + row.turn))
      const content = el('td', 'native-trace-summary'), toggle = button(row.summary || row.title, event => { event?.stopPropagation?.(); local.selectedKey = row.key; if (local.expandedKeys.has(row.key)) local.expandedKeys.delete(row.key); else local.expandedKeys.add(row.key); render() }, 'native-trace-disclosure')
      if (row.kind === 'tool') {
        const request = el('span', 'native-trace-tool-request'), result = el('span', 'native-trace-tool-result')
        request.append(el('span', 'native-trace-tool-name', row.record.name || row.title), el('span', 'native-trace-tool-args', row.record.argsRaw || row.summary)); result.append(el('span', 'native-trace-arrow', '→'), el('span', 'native-trace-tool-output', row.record.output || '')); toggle.replaceChildren(request, result)
      }
      toggle.setAttribute('aria-expanded', String(local.expandedKeys.has(row.key))); content.appendChild(toggle)
      const time = el('td', 'native-trace-duration', row.start === null ? '—' : Math.max(0, row.end - row.start) + ' ms')
      tr.append(kind, content, time); tr.addEventListener('click', () => focus(row.key)); body.appendChild(tr)
      if (local.expandedKeys.has(row.key)) body.appendChild(details(row))
    }
    empty.hidden = rows.length > 0; empty.textContent = local.query ? '没有匹配的轨迹' : '还没有轨迹'
    paintGraph()
    if (scrollTop > 0 && anchorKey && anchorTop !== undefined) { const after = [...body.children].find(row => row.getAttribute('data-trace-key') === anchorKey); if (after?.getBoundingClientRect) scroller.scrollTop += after.getBoundingClientRect().top - anchorTop }
  }
  function setSelection(range) {
    cancelDrag()
    local.selection = range && finite(Number(range.from)) && finite(Number(range.to)) ? ordered(Number(range.from), Number(range.to)) : null
    selectionSource = local.selection ? 'time' : null; local.selectionRange = null; selectionAnchors = null
    render(); if (local.selection) focusSelection()
  }
  for (const input of [from, to]) input.addEventListener('input', () => setSelection({ from: Number(from.value), to: Number(to.value) }))
  const nodeAttribute = (target, attribute, root) => {
    for (let node = target; node && node !== root; node = node.parentElement || node.parent) { const value = node.getAttribute?.(attribute); if (value !== null && value !== undefined) return value }
    return null
  }
  function down(event) {
    if (disposed || drag || layout.spans.length === 0 || event.isPrimary === false) return
    const source = event.currentTarget, rect = source.getBoundingClientRect(), visible = domain(), full = bounds(layout)
    if (source === plot && event.button !== undefined && ![0, 2].includes(event.button)) return
    const selectionEdge = nodeAttribute(event.target, 'data-trace-selection-edge', source), viewportEdge = nodeAttribute(event.target, 'data-trace-viewport-edge', source)
    const mode = source === scrollbar ? viewportEdge ? 'viewport-' + viewportEdge : 'viewport-pan' : selectionEdge ? 'selection-' + selectionEdge : event.button === 2 || event.shiftKey ? 'pan' : 'select'
    suppressClickUntil = 0
    drag = { source, mode, pointerId: event.pointerId, rect, layout, full, visible, viewport: local.viewport && { ...local.viewport }, viewportAnchors, selection: local.selection && { ...local.selection }, selectionRange: local.selectionRange && { ...local.selectionRange }, selectionAnchors, selectionSource, anchorClientX: event.clientX, anchorPosition: positionAt(event, rect, visible), key: nodeAttribute(event.target, 'data-trace-key', source), moved: false }
    if (source === scrollbar) drag.anchorPosition = positionAt(event, rect, full)
    try { source.setPointerCapture?.(event.pointerId) } catch {}
    if (mode !== 'select') event.preventDefault?.()
    paintGraph()
  }
  function move(event, finishing = false) {
    if (!drag || drag.pointerId !== event.pointerId) return
    const dx = event.clientX - drag.anchorClientX
    if (!drag.moved && Math.abs(dx) < 3) return
    drag.moved = true; event.preventDefault?.()
    const current = drag, minimum = Math.min(local.duration ? 20 : 4, current.full.to - current.full.from)
    if (current.mode === 'viewport-pan') {
      const width = current.visible.to - current.visible.from, delta = dx / Math.max(1, current.rect.width) * (current.full.to - current.full.from)
      setViewport({ from: current.visible.from + delta, to: current.visible.to + delta }, true); return
    }
    if (current.mode === 'viewport-from' || current.mode === 'viewport-to') {
      const position = positionAt(event, current.rect, current.full)
      setViewport(current.mode === 'viewport-from' ? { from: clamp(position, current.full.from, current.visible.to - minimum), to: current.visible.to } : { from: current.visible.from, to: clamp(position, current.visible.from + minimum, current.full.to) }, true); return
    }
    if (current.mode === 'pan') {
      const width = current.visible.to - current.visible.from, delta = dx / Math.max(1, current.rect.width) * width
      setViewport({ from: current.visible.from - delta, to: current.visible.to - delta }, true); return
    }
    let visible = domain()
    if (local.viewport && !finishing) {
      const localX = event.clientX - current.rect.left, edgeWidth = Math.min(32, Math.max(1, current.rect.width * .08)), direction = localX < edgeWidth ? -1 : localX > current.rect.width - edgeWidth ? 1 : 0
      if (direction) {
        const strength = clamp((direction < 0 ? edgeWidth - localX : localX - (current.rect.width - edgeWidth)) / edgeWidth, 0, 1), width = visible.to - visible.from, delta = direction * width * .025 * Math.max(.2, strength)
        setViewport({ from: visible.from + delta, to: visible.to + delta }, true); visible = domain()
      }
    }
    const point = positionAt(event, current.rect, visible)
    draft = current.mode === 'selection-from' ? ordered(point, current.selectionRange.to) : current.mode === 'selection-to' ? ordered(current.selectionRange.from, point) : ordered(current.anchorPosition, point)
    paintGraph()
  }
  function end(event, cancelled = false) {
    if (!drag || event && drag.pointerId !== event.pointerId) return
    if (!cancelled && event && (drag.moved || Math.abs(event.clientX - drag.anchorClientX) >= 3)) move(event, true)
    const current = drag; drag = null
    if (cancelled) {
      local.viewport = current.viewport; viewportAnchors = current.viewportAnchors; local.selection = current.selection; local.selectionRange = current.selectionRange; selectionAnchors = current.selectionAnchors; selectionSource = current.selectionSource
    } else if (current.mode === 'pan' && !current.moved) updateSelection(null)
    else if (current.mode === 'select' || current.mode.startsWith('selection-')) {
      if (current.moved && draft) updateSelection(draft)
      else if (current.mode === 'select') {
        if (current.key) { updateSelection(null); focus(current.key, false) }
        else {
          const minimum = Math.min(current.visible.to - current.visible.from, (current.full.to - current.full.from) / Math.max(1, layout.spans.length)), from = clamp(current.anchorPosition - minimum / 2, current.full.from, current.full.to - minimum)
          updateSelection({ from, to: from + minimum })
        }
      }
    }
    draft = null
    if (current.moved || current.mode === 'select') suppressClickUntil = Date.now() + 400
    try { current.source.releasePointerCapture?.(current.pointerId) } catch {}
    const next = pendingSnapshot; pendingSnapshot = null; if (next) snapshot = next
    render()
    if (!cancelled && (current.mode === 'select' || current.mode.startsWith('selection-'))) {
      if (local.selectionRange) focusSelection(); else if (current.key) focus(current.key)
    }
  }
  function cancelDrag() { if (drag) end(null, true) }
  const up = event => end(event), cancel = event => end(event, true)
  const clickGuard = event => { if (Date.now() < suppressClickUntil && event.detail !== 0) { event.preventDefault?.(); event.stopImmediatePropagation?.(); event.stopPropagation?.() } }
  const wheel = event => {
    if (disposed || drag || !layout.spans.length) return
    event.preventDefault?.()
    const visible = domain(), full = bounds(layout), width = visible.to - visible.from
    if (Math.abs(event.deltaX || 0) > Math.abs(event.deltaY || 0)) { const delta = (event.deltaX || 0) / Math.max(1, plot.getBoundingClientRect().width) * width; setViewport({ from: visible.from + delta, to: visible.to + delta }); return }
    const fraction = clamp((event.clientX - plot.getBoundingClientRect().left) / Math.max(1, plot.getBoundingClientRect().width), 0, 1), minimum = Math.min(local.duration ? 20 : 4, full.to - full.from), nextWidth = clamp(width * Math.exp((event.deltaY || 0) * .0015), minimum, full.to - full.from), anchor = visible.from + fraction * width
    setViewport({ from: anchor - fraction * nextWidth, to: anchor + (1 - fraction) * nextWidth })
  }
  const keydown = event => {
    if (event.key === 'Escape') { event.preventDefault?.(); setSelection(null); return }
    const edge = nodeAttribute(event.target, 'data-trace-selection-edge', plot), windowEdge = nodeAttribute(event.target, 'data-trace-viewport-edge', scrollbar), direction = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0
    if (!direction) return
    const full = bounds(layout), step = (full.to - full.from) / 100
    if (edge && local.selectionRange) { event.preventDefault?.(); const range = { ...local.selectionRange, [edge]: clamp(local.selectionRange[edge] + direction * step, full.from, full.to) }; updateSelection(ordered(range.from, range.to)); render(); focusSelection() }
    else if (event.currentTarget === scrollbar) {
      event.preventDefault?.(); const range = domain(), minimum = Math.min(local.duration ? 20 : 4, full.to - full.from)
      if (windowEdge === 'from') range.from = clamp(range.from + direction * step, full.from, range.to - minimum)
      else if (windowEdge === 'to') range.to = clamp(range.to + direction * step, range.from + minimum, full.to)
      else { range.from += direction * step; range.to += direction * step }
      setViewport(range)
    }
  }
  const contextMenu = event => event.preventDefault?.(), doubleClick = event => { event.preventDefault?.(); setSelection(null) }
  for (const source of [plot, scrollbar]) { source.addEventListener('pointerdown', down); source.addEventListener('pointermove', move); source.addEventListener('pointerup', up); source.addEventListener('pointercancel', cancel); source.addEventListener('lostpointercapture', cancel); source.addEventListener('keydown', keydown); source.addEventListener('click', clickGuard, true) }
  graph.addEventListener('wheel', wheel, { passive: false }); plot.addEventListener('contextmenu', contextMenu); plot.addEventListener('dblclick', doubleClick)
  render()
  return {
    update(next) {
      if (disposed) return
      if (sessionId !== next.sessionId) {
        cancelDrag()
        if (sessionId !== null) sessions.set(sessionId, { query: local.query, collapsedTurns: local.collapsedTurns, collapsedCalls: local.collapsedCalls, selection: local.selection, selectionRange: local.selectionRange, selectionSource, selectionAnchors, viewport: local.viewport, viewportAnchors, selectedKey: local.selectedKey, expandedKeys: [...local.expandedKeys], windowStart })
        const saved = sessions.get(next.sessionId)
        local.query = saved?.query || ''; search.value = local.query; local.collapsedTurns = saved?.collapsedTurns || false; local.collapsedCalls = saved?.collapsedCalls || false; local.selection = saved?.selection || null; local.selectionRange = saved?.selectionRange || null; selectionSource = saved?.selectionSource || null; selectionAnchors = saved?.selectionAnchors || null; local.viewport = saved?.viewport || null; viewportAnchors = saved?.viewportAnchors || null; local.selectedKey = saved?.selectedKey || null; local.expandedKeys = new Set(saved?.expandedKeys || []); windowStart = saved?.windowStart ?? null; rows = []; pendingSnapshot = null; sessionId = next.sessionId
      }
      if (drag) { pendingSnapshot = next; return }
      snapshot = next; render()
    },
    show() { container.hidden = false; render() }, count() { return rows.length },
    state() { return { ...local, expandedKeys: [...local.expandedKeys], selection: draft ? actualRange(draft) : local.selection && { ...local.selection }, selectionRange: activeRange() && { ...activeRange() }, selectionKeys: [...selectedKeys], viewport: local.viewport && { ...local.viewport }, domain: { ...domain() }, fullDomain: bounds(layout), dragging: !!drag } }, setSelection,
    setViewport(range) { cancelDrag(); setViewport(range) },
    dispose() {
      cancelDrag(); disposed = true; pendingSnapshot = null; sessions.clear()
      for (const source of [plot, scrollbar]) { source.removeEventListener('pointerdown', down); source.removeEventListener('pointermove', move); source.removeEventListener('pointerup', up); source.removeEventListener('pointercancel', cancel); source.removeEventListener('lostpointercapture', cancel); source.removeEventListener('keydown', keydown); source.removeEventListener('click', clickGuard, true) }
      graph.removeEventListener('wheel', wheel); plot.removeEventListener('contextmenu', contextMenu); plot.removeEventListener('dblclick', doubleClick); container.replaceChildren()
    },
  }
}
