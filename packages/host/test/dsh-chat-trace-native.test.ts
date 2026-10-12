import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createProjection } from '../assets/dsh-chat/projection.js'
import { matchesTraceQuery, mountTrace, traceLayout, traceRows, traceTimeAt, tracePositionAt, traceViewport } from '../assets/dsh-chat/trace.js'

// Tiny explicit DOM double for interaction contracts; no browser or HTTP dependency.
class Element {
  tagName: string; ownerDocument: Document; children: Element[] = []; parent: Element | null = null
  attributes = new Map<string, string>(); listeners = new Map<string, { fn: Function, capture: boolean }[]>(); style: Record<string, string> = {}; captured = new Set<number>(); captureHistory: number[] = []
  className = ''; textContent = ''; hidden = false; disabled = false; value = ''; min = ''; max = ''; type = ''; title = ''; scrollTop = 0
  classList = { toggle: (name: string, enabled: boolean) => { const names = new Set(this.className.split(/\s+/)); if (enabled) names.add(name); else names.delete(name); this.className = [...names].join(' ') } }
  constructor(tag: string, doc: Document) { this.tagName = tag.toUpperCase(); this.ownerDocument = doc }
  appendChild(child: Element) { child.parent = this; this.children.push(child); return child }
  append(...children: Element[]) { children.forEach(child => this.appendChild(child)) }
  replaceChildren(...children: Element[]) { this.children = []; this.append(...children) }
  setAttribute(name: string, value: string) { this.attributes.set(name, value) }
  getAttribute(name: string) { return this.attributes.get(name) ?? null }
  hasAttribute(name: string) { return this.attributes.has(name) }
  addEventListener(name: string, fn: Function, options: boolean | { capture?: boolean } = false) { this.listeners.set(name, [...(this.listeners.get(name) ?? []), { fn, capture: typeof options === 'boolean' ? options : !!options.capture }]) }
  removeEventListener(name: string, listener: Function) { this.listeners.set(name, (this.listeners.get(name) ?? []).filter(item => item.fn !== listener)) }
  setPointerCapture(pointerId: number) { this.captured.add(pointerId); this.captureHistory.push(pointerId) }
  releasePointerCapture(pointerId: number) { this.captured.delete(pointerId) }
  async fire(name: string, data: Record<string, unknown> = {}) {
    let stopped = false, immediate = false
    const path: Element[] = []; for (let node: Element | null = this; node; node = node.parent) path.push(node)
    const event = { target: this, currentTarget: this, clientX: 0, button: 0, pointerId: 1, isPrimary: true, detail: 1, defaultPrevented: false,
      preventDefault() { event.defaultPrevented = true }, stopPropagation() { stopped = true }, stopImmediatePropagation() { stopped = true; immediate = true }, ...data }
    for (const capture of [true, false]) {
      for (const element of capture ? [...path].reverse() : path) {
        event.currentTarget = element
        for (const listener of element.listeners.get(name) ?? []) { if (listener.capture !== capture) continue; await listener.fn(event); if (immediate) break }
        if (stopped) break
      }
      if (stopped) break
    }
    return event
  }
  closest() { return null }
  getBoundingClientRect() { return { top: 0, left: 0, width: 100, height: 30 } }
  scrollIntoView() { this.setAttribute('data-scrolled', 'true') }
  querySelector(selector: string): Element | null { return find(this, el => { const match = selector.match(/^\[([^=]+)="(.*)"\]$/); return match ? el.getAttribute(match[1]!) === match[2] : false }) }
}
class Document { createElement(tag: string) { return new Element(tag, this) }; createElementNS(_ns: string, tag: string) { return this.createElement(tag) } }
const find = (root: Element, predicate: (el: Element) => boolean): Element | null => { if (predicate(root)) return root; for (const child of root.children) { const found = find(child, predicate); if (found) return found }; return null }
const all = (root: Element, predicate: (el: Element) => boolean): Element[] => [ ...(predicate(root) ? [root] : []), ...root.children.flatMap(child => all(child, predicate)) ]
const cls = (root: Element, name: string) => find(root, el => el.className.split(/\s+/).includes(name))!
const control = (root: Element, name: string) => find(root, el => el.getAttribute('data-trace-control') === name)!
const snapshot = () => createProjection('s').ingest([
  { seq: 1, time: 1000, type: 'turn/start', data: { turn: 1 } },
  { seq: 2, time: 1100, type: 'user/message', data: { turn: 1, message: { content: [{ type: 'text', text: 'find source' }] } } },
  { seq: 3, time: 1200, type: 'step/start', data: { turn: 1, step: 1 } },
  { seq: 4, time: 1300, type: 'assistant/live-chunk', data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'analysis' } } },
  { seq: 5, time: 1800, type: 'assistant/message', data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'analysis' }] } } },
  { seq: 6, time: 1900, type: 'tool/call', data: { turn: 1, step: 1, callId: 'c', name: 'read_file', arguments: '{"path":"native.css"}' } },
  { seq: 7, time: 2900, type: 'tool/result', data: { turn: 1, step: 1, message: { source: { callId: 'c' }, isError: true, content: [{ type: 'text', text: 'permission denied' }] } } },
  { seq: 8, time: 3000, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
]).setValues({ status: 'idle' }).snapshot()
const mounted = () => { const doc = new Document(), container = doc.createElement('div'); const view = mountTrace({ container }); view.update(snapshot()); return { container, view } }
const userSnapshot = (count = 12, first = 0, sessionId = 'window') => createProjection(sessionId).ingest(Array.from({ length: count }, (_, index) => {
  const seq = first + index
  return { seq, time: seq * 1000, type: 'user/message', data: { text: 'row ' + seq } }
})).snapshot()
const near = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} differs from ${expected}`)
const withClass = (root: Element, name: string) => all(root, el => el.className.split(/\s+/).includes(name))
const barFor = (root: Element, key: string) => withClass(root, 'trace-bar').find(el => el.getAttribute('data-trace-key') === key)!
const handleFor = (root: Element, name: string, edge: string) => withClass(root, name).find(el => el.getAttribute('data-edge') === edge)!

describe('native shared projection trajectory', () => {
  it('has exactly one tool call/result row and correct three lanes with true timing', () => {
    const rows = traceRows(snapshot())
    assert.equal(rows.filter(row => row.kind === 'tool').length, 1)
    assert.deepEqual(rows.map(row => row.lane), [0, 1, 2])
    assert.equal(rows[2].start, 1900); assert.equal(rows[2].end, 2900); assert.equal(rows[2].error, true)
  })
  it('search is case-insensitive multi-term AND across summary and expanded OUT detail', () => {
    const rows = traceRows(snapshot(), { query: 'NATIVE denied' })
    assert.equal(rows.length, 1); assert.equal(rows[0].key, 'tool:c')
    assert.equal(matchesTraceQuery(rows[0], 'native absent'), false)
  })
  it('selection is inclusive overlap rather than requiring the entire record inside range', () => {
    assert.deepEqual(traceRows(snapshot(), { selection: { from: 2500, to: 2600 } }).map(row => row.key), ['tool:c'])
  })
  it('duration removes every idle interval but preserves concurrent overlapping work', () => {
    const rows = [ { key: 'a', start: 1000, end: 2000, lane: 1 }, { key: 'b', start: 1500, end: 2500, lane: 2 }, { key: 'c', start: 10000, end: 12000, lane: 1 } ]
    const layout = traceLayout(rows, { duration: true })
    assert.equal(layout.start, 1000); assert.equal(layout.end, 4500)
    assert.equal(layout.spans[2].positionStart, 2500)
    assert.equal(traceTimeAt(layout, 1), 12000)
    assert.equal(traceTimeAt(layout, 0), 1000)
    assert.equal(tracePositionAt(layout, 10000), 1500 / 3500)
  })
  it('sequence mode has equal widths and omits neither input nor model lane', () => {
    const layout = traceLayout(traceRows(snapshot()))
    assert.equal(layout.spans.length, 3)
    assert.equal(layout.spans[0].width, layout.spans[2].width)
    assert.equal(layout.end, 3)
  })
  it('turns and calls independently collapse real rows into summaries', () => {
    const turn = traceRows(snapshot(), { collapsedTurns: true })
    assert.equal(turn.length, 1); assert.equal(turn[0].kind, 'turn-summary'); assert.equal(turn[0].members.length, 3)
    const calls = traceRows(snapshot(), { collapsedCalls: true })
    assert.equal(calls.length, 2); assert.equal(calls[1].kind, 'call-summary'); assert.equal(calls[1].members.length, 2)
  })
  it('toolbar changes actual table disclosure and duration geometry', async () => {
    const { container, view } = mounted()
    assert.equal(view.count(), 3)
    await control(container, 'turns').fire('click'); assert.equal(view.count(), 1)
    await control(container, 'turns').fire('click'); assert.equal(view.count(), 3)
    await control(container, 'calls').fire('click'); assert.equal(view.count(), 2)
    await control(container, 'duration').fire('click'); assert.equal(view.state().duration, true)
    assert.equal(control(container, 'duration').getAttribute('aria-pressed'), 'true')
  })
  it('AND search filters table and dims graph matches without changing the complete domain', async () => {
    const { container, view } = mounted(), search = cls(container, 'native-trace-search')
    search.value = 'native denied'; await search.fire('input')
    assert.equal(view.count(), 1)
    assert.equal(all(container, el => el.className.split(/\s+/).includes('trace-bar')).length, 3)
    assert.equal(all(container, el => el.className.split(/\s+/).includes('trace-bar') && el.getAttribute('data-search-match') === 'true').length, 1)
    assert.deepEqual(view.state().fullDomain, { from: 0, to: 3 })
    assert.equal(cls(container, 'native-trace-row').getAttribute('data-trace-key'), 'tool:c')
  })
  it('table and graph focus each other and expand tool IN/OUT without nested details', async () => {
    const { container, view } = mounted()
    const bar = all(container, el => el.className.split(/\s+/).includes('trace-bar')).find(el => el.getAttribute('data-trace-key') === 'tool:c')!
    await bar.fire('click')
    assert.equal(view.state().selectedKey, 'tool:c')
    assert.equal(all(container, el => el.className.split(/\s+/).includes('native-trace-row')).find(el => el.getAttribute('data-trace-key') === 'tool:c')?.className.includes('selected'), true)
    const toolRow = all(container, el => el.className.split(/\s+/).includes('native-trace-row')).find(el => el.getAttribute('data-trace-key') === 'tool:c')!
    await cls(toolRow, 'native-trace-disclosure').fire('click')
    assert.equal(all(container, el => el.className === 'native-trace-io-label').map(el => el.textContent).join(','), 'IN,OUT')
    assert.equal(cls(container, 'native-trace-error').textContent, '工具执行失败')
    assert.equal(all(container, el => el.tagName === 'DETAILS').length, 0)
  })
  it('range highlights matching rows and keeps the whole table and graph, including empty focus', async () => {
    const { container, view } = mounted()
    view.setSelection({ from: 9999, to: 10000 })
    assert.equal(view.count(), 3)
    assert.equal(view.state().selectionKeys.length, 0)
    assert.equal(all(container, el => el.className.split(/\s+/).includes('trace-bar')).length, 3)
    assert.equal(cls(container, 'native-trace-empty').hidden, true)
    assert.equal(cls(container, 'native-trace-range-label').textContent.startsWith('0 条记录'), true)
    await cls(container, 'native-trace-range-clear').fire('click'); assert.equal(view.count(), 3)
  })
  it('range focus inside a folded turn still selects the original tool bar and scrolls its summary row', async () => {
    const { container, view } = mounted()
    await control(container, 'turns').fire('click'); view.setSelection({ from: 2000, to: 2500 })
    assert.equal(view.count(), 1); assert.equal(view.state().selectedKey, 'tool:c')
    assert.equal(barFor(container, 'tool:c').className.split(/\s+/).includes('selected'), true)
    const row = cls(container, 'native-trace-row')
    assert.equal(row.getAttribute('data-range-selected'), 'true'); assert.equal(row.getAttribute('data-scrolled'), 'true')
  })
  it('range inputs and graph pointer dragging share recorded-time selection', async () => {
    const { container, view } = mounted()
    const from = find(container, el => el.getAttribute('aria-label') === '选区开始')!, to = find(container, el => el.getAttribute('aria-label') === '选区结束')!
    from.value = '2000'; to.value = '2500'; await from.fire('input')
    assert.equal(view.count(), 3); assert.equal(view.state().selection.from, 2000)
    assert.deepEqual(view.state().selectionKeys, ['tool:c'])
    assert.equal(all(container, el => el.className.split(/\s+/).includes('native-trace-row') && el.getAttribute('data-range-selected') === 'true').length, 1)
    view.setSelection(null)
    const plot = cls(container, 'native-trace-plot')
    await plot.fire('pointerdown', { clientX: 70 }); await plot.fire('pointermove', { clientX: 90 }); await plot.fire('pointerup', { clientX: 90 })
    assert.equal(view.state().selection !== null, true)
    assert.equal(view.count(), 3)
    assert.deepEqual(view.state().selectionKeys, ['tool:c'])
    assert.equal(cls(container, 'native-trace-selection').getAttribute('aria-hidden'), 'true')
  })
  it('200-row DOM cap retains logical history and earlier/newer windows are reachable', async () => {
    const { container, view } = mounted()
    const p = createProjection('long').ingest(Array.from({ length: 251 }, (_, seq) => ({ seq, time: seq, type: 'user/message', data: { message: { content: [{ type: 'text', text: 'row ' + seq }] } } })))
    view.update(p.snapshot())
    assert.equal(view.count(), 251)
    assert.equal(all(container, el => el.className === 'native-trace-row').length, 200)
    assert.equal(cls(container, 'native-trace-row').getAttribute('data-trace-seq'), '51')
    await cls(container, 'history-load').fire('click')
    assert.equal(cls(container, 'native-trace-row').getAttribute('data-trace-seq'), '0')
    assert.equal(cls(container, 'trace-bar').getAttribute('data-trace-seq'), '0')
    await cls(container, 'native-trace-newer').fire('click')
    assert.equal(cls(container, 'native-trace-row').getAttribute('data-trace-seq'), '51')
  })
  it('window normalization enforces original zoom limits and clamps both ends', () => {
    const layout = traceLayout(traceRows(userSnapshot()))
    assert.deepEqual(traceViewport(layout), { from: 0, to: 12 })
    assert.deepEqual(traceViewport(layout, { from: 5, to: 5.2 }), { from: 5, to: 9 })
    assert.deepEqual(traceViewport(layout, { from: -8, to: -2 }), { from: 0, to: 6 })
    assert.deepEqual(traceViewport(layout, { from: 10, to: 18 }), { from: 4, to: 12 })
    assert.deepEqual(traceViewport(layout, { from: 40, to: 0 }), { from: 0, to: 12 })
    assert.deepEqual(traceViewport({ ...layout, duration: true }, { from: 3, to: 5 }), { from: 0, to: 12 })
  })
  it('a real bar starts range dragging, keeps nodes stable, and suppresses the subsequent click', async () => {
    const { container, view } = mounted(), plot = cls(container, 'native-trace-plot'), bar = barFor(container, 'tool:c')
    const originalBars = [...cls(container, 'native-trace-bars').children]
    await bar.fire('pointerdown', { pointerId: 7, clientX: 70 })
    assert.equal(plot.captured.has(7), true)
    await plot.fire('pointermove', { pointerId: 7, clientX: 90 })
    assert.deepEqual(cls(container, 'native-trace-bars').children, originalBars)
    assert.equal(view.state().dragging, true)
    assert.deepEqual(view.state().selectionKeys, ['tool:c'])
    near(view.state().selectionRange.from, 2.1); near(view.state().selectionRange.to, 2.7)
    await plot.fire('pointerup', { pointerId: 7, clientX: 90 })
    assert.equal(plot.captured.has(7), false); assert.equal(view.state().dragging, false)
    assert.equal(view.count(), 3)
    const row = withClass(container, 'native-trace-row').find(el => el.getAttribute('data-trace-key') === 'tool:c')!
    assert.equal(row.getAttribute('data-range-selected'), 'true'); assert.equal(row.getAttribute('data-scrolled'), 'true')
    await barFor(container, 'tool:c').fire('click', { detail: 1 })
    assert.deepEqual(view.state().selectionKeys, ['tool:c'])
    await barFor(container, 'tool:c').fire('click', { detail: 0 })
    assert.equal(view.state().selectionRange, null)
  })
  it('bar taps select a record; drags from children and range handles adjust the selection', async () => {
    const { container, view } = mounted(); view.update(userSnapshot())
    const plot = cls(container, 'native-trace-plot'), bar = barFor(container, 'user:2'), child = bar.ownerDocument.createElement('span'); bar.appendChild(child)
    await child.fire('pointerdown', { clientX: 20 }); await plot.fire('pointerup', { clientX: 20 })
    assert.equal(view.state().selectedKey, 'user:2'); assert.equal(view.state().selectionRange, null)
    await child.fire('pointerdown', { clientX: 20 }); await plot.fire('pointermove', { clientX: 60 }); await plot.fire('pointerup', { clientX: 60 })
    near(view.state().selectionRange.from, 2.4); near(view.state().selectionRange.to, 7.2)
    const handle = handleFor(container, 'native-trace-selection-handle', 'to')
    await handle.fire('pointerdown', { clientX: 60 }); await plot.fire('pointermove', { clientX: 80 }); await plot.fire('pointerup', { clientX: 80 })
    near(view.state().selectionRange.from, 2.4); near(view.state().selectionRange.to, 9.6)
    assert.deepEqual(view.state().selectionKeys, Array.from({ length: 8 }, (_, index) => 'user:' + (index + 2)))
    assert.equal(view.count(), 12)
  })
  it('the final pointer position commits a short drag even when move events are coalesced', async () => {
    const { container, view } = mounted(), plot = cls(container, 'native-trace-plot')
    await barFor(container, 'tool:c').fire('pointerdown', { clientX: 70 }); await plot.fire('pointerup', { clientX: 90 })
    assert.deepEqual(view.state().selectionKeys, ['tool:c']); near(view.state().selectionRange.from, 2.1); near(view.state().selectionRange.to, 2.7)
    await barFor(container, 'tool:c').fire('pointerdown', { clientX: 70 }); await plot.fire('pointermove', { clientX: 90 }); await plot.fire('pointerup', { clientX: 80 })
    near(view.state().selectionRange.to, 2.4)
  })
  it('mobile scrollbar handles resize a window, its thumb pans, and reset restores the full domain', async () => {
    const { container, view } = mounted(); view.update(userSnapshot())
    const track = cls(container, 'native-trace-scrollbar'), right = handleFor(container, 'native-trace-viewport-handle', 'to')
    assert.equal(track.hidden, false); assert.equal(cls(container, 'native-trace-ranges').hidden, true)
    await right.fire('pointerdown', { clientX: 100 }); await track.fire('pointermove', { clientX: 60 }); await track.fire('pointerup', { clientX: 60 })
    near(view.state().viewport.from, 0); near(view.state().viewport.to, 7.2)
    const thumb = cls(container, 'native-trace-viewport-thumb')
    await thumb.fire('pointerdown', { clientX: 30 }); await track.fire('pointermove', { clientX: 60 }); await track.fire('pointerup', { clientX: 60 })
    near(view.state().viewport.from, 3.6); near(view.state().viewport.to, 10.8)
    const left = handleFor(container, 'native-trace-viewport-handle', 'from')
    await left.fire('pointerdown', { clientX: 36 }); await track.fire('pointermove', { clientX: 0 }); await track.fire('pointerup', { clientX: 0 })
    near(view.state().viewport.from, 0); near(view.state().viewport.to, 10.8)
    assert.equal(view.count(), 12)
    await cls(container, 'native-trace-viewport-reset').fire('click')
    assert.equal(view.state().viewport, null); assert.deepEqual(view.state().domain, { from: 0, to: 12 })
  })
  it('wheel zoom retains its anchor and horizontal wheel pans without changing selection', async () => {
    const { container, view } = mounted(); view.update(userSnapshot())
    const graph = cls(container, 'native-trace-graph')
    const wheel = await graph.fire('wheel', { clientX: 50, deltaY: -1000, deltaX: 0 })
    assert.equal(wheel.defaultPrevented, true); assert.deepEqual(view.state().viewport, { from: 4, to: 8 })
    await graph.fire('wheel', { clientX: 50, deltaY: 0, deltaX: 25 })
    assert.deepEqual(view.state().viewport, { from: 5, to: 9 }); assert.equal(view.state().selectionRange, null)
    await graph.fire('wheel', { clientX: 50, deltaY: 10000, deltaX: 0 })
    assert.equal(view.state().viewport, null)
  })
  it('secondary-button plot panning works from a bar and cancellation restores the viewport', async () => {
    const { container, view } = mounted(); view.update(userSnapshot()); view.setViewport({ from: 4, to: 8 })
    const plot = cls(container, 'native-trace-plot'), bar = barFor(container, 'user:5')
    await bar.fire('pointerdown', { button: 2, clientX: 25 }); await plot.fire('pointermove', { button: 2, clientX: 45 })
    near(view.state().viewport.from, 3.2); near(view.state().viewport.to, 7.2)
    await plot.fire('pointercancel', { button: 2, clientX: 45 })
    assert.deepEqual(view.state().viewport, { from: 4, to: 8 }); assert.equal(view.state().selectionRange, null)
  })
  it('a secondary-button tap clears selection and slider keyboard limits do not move the opposite edge', async () => {
    const { container, view } = mounted(); view.update(userSnapshot()); view.setSelection({ from: 3000, to: 5000 })
    const plot = cls(container, 'native-trace-plot')
    await barFor(container, 'user:4').fire('pointerdown', { button: 2, clientX: 40 }); await plot.fire('pointerup', { button: 2, clientX: 40 })
    assert.equal(view.state().selectionRange, null)
    view.setViewport({ from: 4, to: 8 })
    await handleFor(container, 'native-trace-viewport-handle', 'from').fire('keydown', { key: 'ArrowRight' })
    assert.deepEqual(view.state().viewport, { from: 4, to: 8 })
    await handleFor(container, 'native-trace-viewport-handle', 'to').fire('keydown', { key: 'ArrowLeft' })
    assert.deepEqual(view.state().viewport, { from: 4, to: 8 })
    await cls(container, 'native-trace-viewport-thumb').fire('keydown', { key: 'ArrowRight' })
    near(view.state().viewport.from, 4.12); near(view.state().viewport.to, 8.12)
  })
  it('pointer cancellation and lost capture discard only the draft, and unrelated pointers cannot finish it', async () => {
    const { container, view } = mounted(); view.setSelection({ from: 2000, to: 2500 })
    const original = view.state().selectionRange, plot = cls(container, 'native-trace-plot'), bar = barFor(container, 'tool:c')
    await bar.fire('pointerdown', { pointerId: 7, clientX: 70 })
    await plot.fire('pointermove', { pointerId: 8, clientX: 10 }); assert.deepEqual(view.state().selectionRange, original)
    await plot.fire('pointerup', { pointerId: 8, clientX: 10 }); assert.equal(view.state().dragging, true)
    await plot.fire('pointermove', { pointerId: 7, clientX: 20 }); assert.notDeepEqual(view.state().selectionRange, original)
    await plot.fire('pointercancel', { pointerId: 7, clientX: 20 }); assert.deepEqual(view.state().selectionRange, original)
    assert.deepEqual(view.state().selectionKeys, ['tool:c']); assert.equal(plot.captured.size, 0)
    await barFor(container, 'tool:c').fire('pointerdown', { pointerId: 9, clientX: 70 }); await plot.fire('pointermove', { pointerId: 9, clientX: 30 }); await plot.fire('lostpointercapture', { pointerId: 9, clientX: 30 })
    assert.deepEqual(view.state().selectionRange, original); assert.equal(view.state().dragging, false)
  })
  it('search, collapse, and table paging do not change the viewport or full timeline', async () => {
    const { container, view } = mounted(); view.update(userSnapshot(251)); view.setViewport({ from: 20, to: 80 })
    const before = view.state(), plot = cls(container, 'native-trace-plot')
    const search = cls(container, 'native-trace-search'); search.value = 'row 25'; await search.fire('input')
    assert.equal(view.count(), 4); assert.deepEqual(withClass(container, 'native-trace-row').map(row => row.getAttribute('data-trace-key')), ['user:25', 'user:125', 'user:225', 'user:250']); assert.deepEqual(view.state().fullDomain, before.fullDomain); assert.deepEqual(view.state().viewport, before.viewport)
    assert.equal(plot.getAttribute('data-domain-end'), '251'); assert.equal(barFor(container, 'user:30').getAttribute('data-search-match'), 'false')
    search.value = ''; await search.fire('input'); await control(container, 'turns').fire('click'); await control(container, 'calls').fire('click'); await cls(container, 'history-load').fire('click')
    assert.deepEqual(view.state().fullDomain, before.fullDomain); assert.deepEqual(view.state().viewport, before.viewport)
  })
  it('selection retains all logical records and focuses earlier rows under the hard 200-node cap', () => {
    const doc = new Document(), container = doc.createElement('div'), view = mountTrace({ container, maxRows: 500 })
    view.update(userSnapshot(300))
    assert.equal(view.count(), 300); assert.equal(withClass(container, 'native-trace-row').length, 200); assert.equal(withClass(container, 'trace-bar').length, 200)
    view.setSelection({ from: 10000, to: 12000 })
    assert.equal(view.count(), 300); assert.equal(withClass(container, 'native-trace-row').length, 200); assert.equal(withClass(container, 'trace-bar').length, 200)
    assert.equal(cls(container, 'native-trace-row').getAttribute('data-trace-key'), 'user:10')
    assert.deepEqual(view.state().selectionKeys, ['user:10', 'user:11', 'user:12'])
    assert.equal(withClass(container, 'native-trace-row').filter(row => row.getAttribute('data-range-selected') === 'true').length, 3)
  })
  it('history prepending preserves viewport and selection by record anchors; live appends preserve window width', async () => {
    const { container, view } = mounted(); view.update(userSnapshot(20, 20)); view.setViewport({ from: 4, to: 12 })
    const plot = cls(container, 'native-trace-plot')
    await plot.fire('pointerdown', { clientX: 25 }); await plot.fire('pointermove', { clientX: 60 }); await plot.fire('pointerup', { clientX: 60 })
    const selection = view.state().selectionKeys
    view.update(userSnapshot(30, 10))
    assert.deepEqual(view.state().viewport, { from: 14, to: 22 }); assert.deepEqual(view.state().selectionKeys, selection)
    near(view.state().selectionRange.from, 16); near(view.state().selectionRange.to, 18.8)
    view.update(userSnapshot(35, 10))
    assert.deepEqual(view.state().viewport, { from: 14, to: 22 }); assert.deepEqual(view.state().selectionKeys, selection)
  })
  it('live updates wait until pointer commit so the active drag has a stable coordinate mapping', async () => {
    const { container, view } = mounted(); view.update(userSnapshot())
    const plot = cls(container, 'native-trace-plot'), bar = barFor(container, 'user:2')
    await bar.fire('pointerdown', { clientX: 20 }); view.update(userSnapshot(24))
    assert.deepEqual(view.state().fullDomain, { from: 0, to: 12 }); assert.equal(view.count(), 12)
    await plot.fire('pointermove', { clientX: 60 }); await plot.fire('pointerup', { clientX: 60 })
    assert.deepEqual(view.state().fullDomain, { from: 0, to: 24 }); near(view.state().selectionRange.from, 2.4); near(view.state().selectionRange.to, 7.2)
    assert.deepEqual(view.state().selectionKeys, Array.from({ length: 6 }, (_, index) => 'user:' + (index + 2)))
  })
  it('sequence selection includes untimed records, duration skips them, and Escape clears focus', async () => {
    const { container, view } = mounted(), next = userSnapshot()
    next.records[4].time = null
    view.update(next)
    const plot = cls(container, 'native-trace-plot')
    await barFor(container, 'user:4').fire('pointerdown', { clientX: 36 }); await plot.fire('pointermove', { clientX: 40 }); await plot.fire('pointerup', { clientX: 40 })
    assert.deepEqual(view.state().selectionKeys, ['user:4']); assert.equal(view.count(), 12); assert.equal(view.state().selection, null)
    await plot.fire('keydown', { key: 'Escape' }); assert.equal(view.state().selectionRange, null)
    await control(container, 'duration').fire('click'); assert.equal(withClass(container, 'trace-bar').length, 11); assert.equal(view.count(), 12)
  })
  it('switching to duration clears an untimed selection instead of inventing a timing range', async () => {
    const { container, view } = mounted(), next = userSnapshot(); next.records[4].time = null; view.update(next)
    const plot = cls(container, 'native-trace-plot')
    await barFor(container, 'user:4').fire('pointerdown', { clientX: 36 }); await plot.fire('pointermove', { clientX: 40 }); await plot.fire('pointerup', { clientX: 40 })
    assert.equal(view.state().selection, null); assert.deepEqual(view.state().selectionKeys, ['user:4'])
    await control(container, 'duration').fire('click')
    assert.equal(view.state().selectionRange, null); assert.deepEqual(view.state().selectionKeys, []); assert.equal(view.count(), 12)
  })
  it('a session switch cancels the old pointer and restoring a session restores its disclosure and window', async () => {
    const { container, view } = mounted(); view.update(userSnapshot()); view.setViewport({ from: 2, to: 8 }); view.setSelection({ from: 3000, to: 5000 })
    await cls(container, 'native-trace-disclosure').fire('click')
    const before = view.state(), plot = cls(container, 'native-trace-plot')
    await barFor(container, 'user:4').fire('pointerdown', { pointerId: 7, clientX: 30 }); await plot.fire('pointermove', { pointerId: 7, clientX: 70 })
    view.update(userSnapshot(8, 0, 'new-session'))
    assert.equal(view.state().dragging, false); assert.equal(view.state().selectionRange, null); assert.equal(view.state().viewport, null); assert.equal(view.state().expandedKeys.length, 0)
    await plot.fire('pointermove', { pointerId: 7, clientX: 90 }); await plot.fire('pointerup', { pointerId: 7, clientX: 90 }); assert.equal(view.state().selectionRange, null)
    view.update(userSnapshot())
    assert.deepEqual(view.state().expandedKeys, before.expandedKeys); assert.deepEqual(view.state().viewport, before.viewport); assert.deepEqual(view.state().selectionKeys, before.selectionKeys)
  })
  it('loading server history sends the oldest durable sequence rather than an absent cursor', async () => {
    const doc = new Document(), container = doc.createElement('div'), cursors: number[] = []
    const view = mountTrace({ container, onOlder: async (beforeSeq: number) => { cursors.push(beforeSeq) } })
    view.update({ ...snapshot(), hasMore: true })
    assert.equal(cls(container, 'history-load').hidden, false)
    await cls(container, 'history-load').fire('click')
    assert.deepEqual(cursors, [1])
    assert.equal(cls(container, 'history-load').disabled, false)
    view.dispose()
  })
  it('update preserves disclosure; switching session resets focus; disposal removes DOM', async () => {
    const { container, view } = mounted()
    await cls(container, 'native-trace-disclosure').fire('click')
    view.update(snapshot()); assert.equal(view.state().expandedKeys.length, 1)
    view.update({ ...snapshot(), sessionId: 'different' }); assert.equal(view.state().expandedKeys.length, 0); assert.equal(view.state().selectedKey, null)
    view.dispose(); assert.equal(container.children.length, 0)
    view.update(snapshot()); assert.equal(container.children.length, 0)
  })
})
