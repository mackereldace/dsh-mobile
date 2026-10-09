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
  const spans = [...layout.spans].filter(row => row.start !== null).sort((a, b) => a.positionStart - b.positionStart)
  if (!spans.length) return null
  const row = spans.find(span => span.positionStart <= position && span.positionEnd >= position) || (position < spans[0].positionStart ? spans[0] : spans.at(-1))
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

export function mountTrace({ container, renderMarkdown, onOlder, maxRows = 200 }) {
  const doc = container.ownerDocument
  const el = (tag, cls, text) => { const result = doc.createElement(tag); if (cls) result.className = cls; if (text !== undefined) result.textContent = text; return result }
  const button = (label, action, cls = '') => { const result = el('button', cls, label); result.type = 'button'; result.addEventListener('click', action); return result }
  const toolbar = el('div', 'native-trace-toolbar trace-toolbar'); toolbar.setAttribute('role', 'toolbar'); toolbar.setAttribute('aria-label', '轨迹工具栏')
  const controls = {}
  let snapshot = { records: [], turns: [], status: {}, hasMore: false }, disposed = false, rows = [], layout = traceLayout([]), drag = null, windowStart = null
  let sessionId = null
  const local = { duration: false, collapsedTurns: false, collapsedCalls: false, query: '', selection: null, selectedKey: null, expandedKeys: new Set() }
  for (const [key, label, prop] of [['duration', '时长', 'duration'], ['turns', '轮次', 'collapsedTurns'], ['calls', '调用', 'collapsedCalls']]) {
    const control = button(label, () => { local[prop] = !local[prop]; render() })
    control.replaceChildren(icon(doc, key === 'duration' ? 'clock' : 'rows'), el('span', '', label)); control.setAttribute('data-trace-control', key); controls[key] = control; toolbar.appendChild(control)
  }
  const search = el('input', 'native-trace-search'); search.type = 'search'; search.placeholder = '搜索'; search.setAttribute('aria-label', '搜索轨迹')
  search.addEventListener('input', () => { local.query = search.value; windowStart = null; render() }); toolbar.appendChild(search)
  const graph = el('div', 'native-trace-graph'); graph.setAttribute('aria-label', '输入、模型、工具三条泳道的会话轨迹')
  const labels = el('div', 'native-trace-lanes'); ['输入', '模型', '工具'].forEach(label => labels.appendChild(el('span', '', label)))
  const plot = el('div', 'native-trace-plot'); plot.setAttribute('role', 'group'); plot.setAttribute('aria-label', '时间线概览，拖动选择时间范围'); graph.append(labels, plot)
  const ranges = el('div', 'native-trace-ranges')
  const from = el('input'), to = el('input')
  for (const [input, label] of [[from, '选区开始'], [to, '选区结束']]) { input.type = 'range'; input.step = '1'; input.setAttribute('aria-label', label); ranges.appendChild(input) }
  const rangeLabel = el('output', 'native-trace-range-label'); ranges.appendChild(rangeLabel)
  const clear = button('清除选区', () => { local.selection = null; render() }, 'native-trace-range-clear'); ranges.appendChild(clear)
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
  container.replaceChildren(toolbar, graph, ranges, older, newer, table, empty)
  const md = (target, text) => { if (renderMarkdown) renderMarkdown(target, text); else target.textContent = text }
  const selected = row => row.key === local.selectedKey || row.members?.some(member => member.key === local.selectedKey)
  const focus = key => {
    local.selectedKey = key
    const index = rows.findIndex(row => row.key === key || row.members?.some(member => member.key === key))
    if (index >= 0) windowStart = Math.max(0, Math.min(index, rows.length - maxRows))
    render()
    const target = body.querySelector('[data-trace-key="' + String(key).replaceAll('"', '') + '"]')
    target?.scrollIntoView?.({ block: 'nearest' })
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
      const stamp = el('div', 'native-trace-time', '开始：' + (row.start === null ? '暂无计时数据' : new Date(row.start).toISOString()) + (row.end !== null ? ' · 结束：' + new Date(row.end).toISOString() : '')); cell.appendChild(stamp)
    }
    const tr = el('tr', 'native-trace-detail-row'); tr.appendChild(cell); return tr
  }
  function render() {
    if (disposed) return
    const scroller = container.closest?.('main') || container
    const scrollTop = scroller.scrollTop || 0
    const edge = scroller.getBoundingClientRect?.().top ?? 0
    const anchor = [...body.children].find(row => row.hasAttribute('data-trace-key') && (row.getBoundingClientRect?.().top ?? 0) >= edge)
    const anchorKey = anchor?.getAttribute('data-trace-key'), anchorTop = anchor?.getBoundingClientRect?.().top
    const unselected = traceRows(snapshot, { query: local.query, collapsedTurns: local.collapsedTurns, collapsedCalls: local.collapsedCalls })
    rows = unselected.filter(row => inRange(row, local.selection))
    layout = traceLayout(unselected, { duration: local.duration })
    const timed = traceRows(snapshot).filter(row => row.start !== null)
    const min = timed.length ? Math.min(...timed.map(row => row.start)) : 0, max = timed.length ? Math.max(...timed.map(row => row.end)) : 0
    for (const input of [from, to]) { input.min = String(min); input.max = String(max); input.disabled = !timed.length }
    from.value = String(local.selection?.from ?? min); to.value = String(local.selection?.to ?? max)
    ranges.hidden = !local.selection
    table.setAttribute('data-duration', String(local.duration))
    const eventColumn = el('col'); eventColumn.style.width = '50px'
    columns.replaceChildren(eventColumn, el('col'))
    if (local.duration) { const durationColumn = el('col'); durationColumn.style.width = '68px'; columns.appendChild(durationColumn) }
    clear.hidden = !local.selection
    rangeLabel.textContent = local.selection ? Math.round(Math.max(0, local.selection.to - local.selection.from)) + ' 毫秒' : ''
    for (const [key, prop] of [['duration', 'duration'], ['turns', 'collapsedTurns'], ['calls', 'collapsedCalls']]) { controls[key].setAttribute('aria-pressed', String(local[prop])); controls[key].classList.toggle('active', local[prop]) }
    plot.replaceChildren()
    if (local.selection) {
      const overlay = el('div', 'native-trace-selection'); overlay.setAttribute('aria-hidden', 'true')
      const left = tracePositionAt(layout, local.selection.from), right = tracePositionAt(layout, local.selection.to)
      overlay.style.left = (left * 100) + '%'; overlay.style.width = Math.max(.2, (right - left) * 100) + '%'; plot.appendChild(overlay)
    }
    const visibleSpans = windowStart === null ? layout.spans.slice(-maxRows) : layout.spans.slice(windowStart, windowStart + maxRows)
    for (const span of visibleSpans) {
      const bar = button(span.summary || span.title, event => { event?.stopPropagation?.(); focus(span.key) }, 'trace-bar native-trace-bar' + (selected(span) ? ' selected' : ''))
      bar.textContent = ''; bar.title = span.title + ' · ' + span.summary
      bar.setAttribute('data-trace-key', span.key); bar.setAttribute('data-trace-seq', String(span.seq ?? '')); bar.setAttribute('data-lane', String(span.lane)); bar.setAttribute('data-error', String(span.error)); bar.setAttribute('data-selected', String(inRange(span, local.selection)))
      bar.style.left = (span.x * 100) + '%'; bar.style.width = Math.max(local.duration ? .2 : .5, span.width * 100) + '%'; bar.style.top = (7 + span.lane * 14) + 'px'; plot.appendChild(bar)
    }
    body.replaceChildren()
    const start = windowStart === null ? Math.max(0, rows.length - maxRows) : Math.max(0, Math.min(windowStart, Math.max(0, rows.length - maxRows)))
    older.hidden = !snapshot.hasMore && start === 0
    older.textContent = start > 0 ? '查看更早 ' + Math.min(start, maxRows) + ' 条轨迹' : '加载更早的轨迹'
    newer.hidden = start + maxRows >= rows.length
    let previousTurn = undefined
    for (const row of rows.slice(start, start + maxRows)) {
      const tr = el('tr', 'native-trace-row' + (selected(row) ? ' selected' : '')); tr.setAttribute('data-trace-seq', String(row.seq ?? '')); tr.setAttribute('data-trace-key', row.key); tr.setAttribute('data-turn', String(row.turn ?? '')); tr.setAttribute('data-error', String(row.error)); tr.setAttribute('data-turn-start', String(previousTurn !== row.turn)); previousTurn = row.turn
      tr.setAttribute('data-kind', row.kind)
      const kind = el('td', 'native-trace-kind')
      const mark = el('span', 'native-trace-kind-mark')
      mark.appendChild(icon(doc, row.kind === 'tool' ? 'tool' : row.kind === 'assistant' ? 'sparkles' : row.kind === 'user' ? 'user' : 'file'))
      mark.setAttribute('title', row.title); kind.appendChild(mark)
      if (previousTurn !== undefined && tr.getAttribute('data-turn-start') === 'true' && row.turn !== null) kind.appendChild(el('span', 'native-trace-turn-label', '#' + row.turn))
      const content = el('td', 'native-trace-summary'), toggle = button(row.summary || row.title, event => { event?.stopPropagation?.(); local.selectedKey = row.key; if (local.expandedKeys.has(row.key)) local.expandedKeys.delete(row.key); else local.expandedKeys.add(row.key); render() }, 'native-trace-disclosure')
      if (row.kind === 'tool') {
        const request = el('span', 'native-trace-tool-request'), result = el('span', 'native-trace-tool-result')
        request.append(el('span', 'native-trace-tool-name', row.record.name || row.title), el('span', 'native-trace-tool-args', row.record.argsRaw || row.summary))
        result.append(el('span', 'native-trace-arrow', '→'), el('span', 'native-trace-tool-output', row.record.output || ''))
        toggle.replaceChildren(request, result)
      }
      toggle.setAttribute('aria-expanded', String(local.expandedKeys.has(row.key))); content.appendChild(toggle)
      const time = el('td', 'native-trace-duration', row.start === null ? '—' : Math.max(0, row.end - row.start) + ' ms')
      tr.append(kind, content, time); tr.addEventListener('click', () => focus(row.key)); body.appendChild(tr)
      if (local.expandedKeys.has(row.key)) body.appendChild(details(row))
    }
    empty.hidden = rows.length > 0; empty.textContent = local.query ? '没有匹配的轨迹' : local.selection ? '选区内没有轨迹' : '还没有轨迹'
    if (scrollTop > 0 && anchorKey && anchorTop !== undefined) {
      const after = [...body.children].find(row => row.getAttribute('data-trace-key') === anchorKey)
      if (after?.getBoundingClientRect) scroller.scrollTop += after.getBoundingClientRect().top - anchorTop
    }
  }
  const setSelection = range => { local.selection = range && finite(Number(range.from)) && finite(Number(range.to)) ? { from: Math.min(Number(range.from), Number(range.to)), to: Math.max(Number(range.from), Number(range.to)) } : null; windowStart = null; render() }
  for (const input of [from, to]) input.addEventListener('input', () => setSelection({ from: Number(from.value), to: Number(to.value) }))
  const coordinate = event => { const rect = plot.getBoundingClientRect(); return (event.clientX - rect.left) / Math.max(1, rect.width) }
  const down = event => { if (event.target !== plot) return; const time = traceTimeAt(layout, coordinate(event)); if (time === null) return; drag = { time, clientX: event.clientX }; plot.setPointerCapture?.(event.pointerId) }
  const move = event => { if (!drag || Math.abs(event.clientX - drag.clientX) < 3) return; const time = traceTimeAt(layout, coordinate(event)); if (time !== null) setSelection({ from: drag.time, to: time }) }
  const up = () => { drag = null }
  plot.addEventListener('pointerdown', down); plot.addEventListener('pointermove', move); plot.addEventListener('pointerup', up); plot.addEventListener('pointercancel', up)
  render()
  return {
    update(next) { if (disposed) return; if (sessionId !== next.sessionId) { local.selection = null; local.selectedKey = null; local.expandedKeys.clear(); windowStart = null; sessionId = next.sessionId }; snapshot = next; render() },
    show() { container.hidden = false; render() }, count() { return rows.length },
    state() { return { ...local, expandedKeys: [...local.expandedKeys], selection: local.selection && { ...local.selection } } }, setSelection,
    dispose() { disposed = true; drag = null; plot.removeEventListener('pointerdown', down); plot.removeEventListener('pointermove', move); plot.removeEventListener('pointerup', up); plot.removeEventListener('pointercancel', up); container.replaceChildren() },
  }
}
