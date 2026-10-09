import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createProjection } from '../assets/dsh-chat/projection.js'
import { matchesTraceQuery, mountTrace, traceLayout, traceRows, traceTimeAt, tracePositionAt } from '../assets/dsh-chat/trace.js'

// Tiny explicit DOM double for interaction contracts; no browser or HTTP dependency.
class Element {
  tagName: string; ownerDocument: Document; children: Element[] = []; parent: Element | null = null
  attributes = new Map<string, string>(); listeners = new Map<string, Function[]>(); style: Record<string, string> = {}
  className = ''; textContent = ''; hidden = false; disabled = false; value = ''; min = ''; max = ''; type = ''; title = ''; scrollTop = 0
  classList = { toggle: (name: string, enabled: boolean) => { const names = new Set(this.className.split(/\s+/)); if (enabled) names.add(name); else names.delete(name); this.className = [...names].join(' ') } }
  constructor(tag: string, doc: Document) { this.tagName = tag.toUpperCase(); this.ownerDocument = doc }
  appendChild(child: Element) { child.parent = this; this.children.push(child); return child }
  append(...children: Element[]) { children.forEach(child => this.appendChild(child)) }
  replaceChildren(...children: Element[]) { this.children = []; this.append(...children) }
  setAttribute(name: string, value: string) { this.attributes.set(name, value) }
  getAttribute(name: string) { return this.attributes.get(name) ?? null }
  hasAttribute(name: string) { return this.attributes.has(name) }
  addEventListener(name: string, listener: Function) { this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]) }
  removeEventListener(name: string, listener: Function) { this.listeners.set(name, (this.listeners.get(name) ?? []).filter(item => item !== listener)) }
  async fire(name: string, data: Record<string, unknown> = {}) { for (const fn of this.listeners.get(name) ?? []) await fn({ target: this, currentTarget: this, stopPropagation() {}, clientX: 0, ...data }) }
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
  it('search filters table and graph from the same matched records', async () => {
    const { container, view } = mounted(), search = cls(container, 'native-trace-search')
    search.value = 'native denied'; await search.fire('input')
    assert.equal(view.count(), 1)
    assert.equal(all(container, el => el.className.split(/\s+/).includes('trace-bar')).length, 1)
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
  it('range filters table while graph retains its entire extent and can clear empty focus', async () => {
    const { container, view } = mounted()
    view.setSelection({ from: 9999, to: 10000 })
    assert.equal(view.count(), 0)
    assert.equal(all(container, el => el.className.split(/\s+/).includes('trace-bar')).length, 3)
    assert.equal(cls(container, 'native-trace-empty').textContent, '选区内没有轨迹')
    await cls(container, 'native-trace-range-clear').fire('click'); assert.equal(view.count(), 3)
  })
  it('range inputs and graph pointer dragging share recorded-time selection', async () => {
    const { container, view } = mounted()
    const from = find(container, el => el.getAttribute('aria-label') === '选区开始')!, to = find(container, el => el.getAttribute('aria-label') === '选区结束')!
    from.value = '2000'; to.value = '2500'; await from.fire('input')
    assert.equal(view.count(), 1); assert.equal(view.state().selection.from, 2000)
    view.setSelection(null)
    const plot = cls(container, 'native-trace-plot')
    await plot.fire('pointerdown', { clientX: 70 }); await plot.fire('pointermove', { clientX: 90 }); await plot.fire('pointerup')
    assert.equal(view.state().selection !== null, true)
    assert.equal(view.count(), 1)
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
