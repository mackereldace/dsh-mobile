import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { conversationItems, mountConversation } from '../assets/dsh-chat/conversation.js'

/** DOM interaction double, including the queued native details toggle event. */
class UiEvent {
  type: string; target: Element | null = null; currentTarget: Element | null = null
  defaultPrevented = false
  constructor(type: string) { this.type = type }
  preventDefault(): void { this.defaultPrevented = true }
  stopPropagation(): void {}
}
class Element {
  tagName: string; ownerDocument: Document; children: Element[] = []; parentElement: Element | null = null
  attributes = new Map<string, string>(); listeners = new Map<string, Function[]>()
  className = ''; ownText = ''; hidden = false; disabled = false; type = ''; namespaceURI = 'http://www.w3.org/1999/xhtml'
  style: Record<string, string> = {}; scrollTop = 0; scrollHeight = 1000; clientHeight = 1000
  private opened = false
  classList = {
    add: (name: string) => this.classList.toggle(name, true),
    toggle: (name: string, enabled: boolean) => { const names = new Set(this.className.split(/\s+/).filter(Boolean)); if (enabled) names.add(name); else names.delete(name); this.className = [...names].join(' ') },
  }
  constructor(tag: string, doc: Document) { this.tagName = tag.toLowerCase(); this.ownerDocument = doc }
  get parentNode(): Element | null { return this.parentElement }
  get isConnected(): boolean { return this === this.ownerDocument.body || this.ownerDocument.body.contains(this) }
  get textContent(): string { return this.ownText + this.children.map(child => child.textContent).join('') }
  set textContent(value: string) { this.ownText = value; this.replaceChildren() }
  get open(): boolean { return this.opened }
  set open(value: boolean) { if (this.opened === Boolean(value)) return; this.opened = Boolean(value); this.ownerDocument.toggles.add(this) }
  contains(target: Element): boolean { return target === this || this.children.some(child => child.contains(target)) }
  appendChild(child: Element): Element { child.remove(); child.parentElement = this; this.children.push(child); return child }
  append(...children: Element[]): void { children.forEach(child => this.appendChild(child)) }
  replaceChildren(...children: Element[]): void { for (const child of this.children) child.parentElement = null; this.children = []; this.append(...children) }
  insertBefore(child: Element, next: Element | null): void { if (child === next) return; child.remove(); const index = next ? this.children.indexOf(next) : -1; child.parentElement = this; this.children.splice(index < 0 ? this.children.length : index, 0, child) }
  replaceWith(child: Element): void { const parent = this.parentElement; if (!parent) return; const index = parent.children.indexOf(this); child.remove(); this.parentElement = null; child.parentElement = parent; parent.children[index] = child }
  remove(): void { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this); this.parentElement = null }
  setAttribute(name: string, value: unknown): void { this.attributes.set(name, String(value)); if (name === 'class') this.className = String(value) }
  getAttribute(name: string): string | null { return this.attributes.get(name) ?? null }
  addEventListener(name: string, listener: Function): void { this.listeners.set(name, [...(this.listeners.get(name) || []), listener]) }
  removeEventListener(name: string, listener: Function): void { this.listeners.set(name, (this.listeners.get(name) || []).filter(item => item !== listener)) }
  matches(selector: string): boolean {
    const attribute = /^\[([^=\]]+)(?:="([^"]*)")?\]$/.exec(selector)
    if (attribute) return this.getAttribute(attribute[1]) !== null && (attribute[2] === undefined || this.getAttribute(attribute[1]) === attribute[2])
    if (selector.startsWith('.')) return selector.slice(1).split('.').every(name => this.className.split(/\s+/).includes(name))
    return this.tagName === selector
  }
  querySelectorAll(selector: string): Element[] { return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]) }
  querySelector(selector: string): Element | null { return this.querySelectorAll(selector)[0] ?? null }
  closest(selector: string): Element | null { return this.matches(selector) ? this : this.parentElement?.closest(selector) ?? null }
  getBoundingClientRect(): { top: number; bottom: number; height: number; width: number } { return { top: 0, bottom: 30, height: 30, width: 360 } }
  async fire(name: string): Promise<void> {
    const event = new UiEvent(name); event.target = this; event.currentTarget = this
    for (const listener of this.listeners.get(name) || []) await listener(event)
    if (name === 'click' && this.tagName === 'summary' && this.parentElement?.tagName === 'details' && !event.defaultPrevented) this.parentElement.open = !this.parentElement.open
  }
}
class Document {
  body: Element; toggles = new Set<Element>()
  constructor() { this.body = this.createElement('body') }
  createElement(tag: string): Element { return new Element(tag, this) }
  createElementNS(namespace: string, tag: string): Element { const element = this.createElement(tag); element.namespaceURI = namespace; return element }
  async flushToggles(): Promise<void> { while (this.toggles.size) { const pending = [...this.toggles]; this.toggles.clear(); for (const element of pending) await element.fire('toggle') } }
}
type RecordNode = {
  key: string; kind: string; seq: number; time: number; turn: number | null; step: number | null; status: string
  text: string; visible: boolean; blocks: Array<{ kind: string; text?: string }>; event: { type: string; data: object }
  callId?: string; name?: string; argsRaw?: string; input?: string; output?: string; phase?: string; children?: RecordNode[]; parentCallId?: string
}
const record = (key: string, seq: number, kind = 'assistant', turn: number | null = null): RecordNode => ({ key, kind, seq, time: seq * 1000, turn, step: turn === null ? null : 1, status: 'complete', text: 'text ' + key, visible: true, blocks: [{ kind: 'text', text: 'text ' + key }], event: { type: kind + '/message', data: {} } })
const tool = (key: string, seq: number, turn = 1, children: RecordNode[] = []): RecordNode => ({ ...record(key, seq, 'tool', turn), callId: key, name: 'bash', argsRaw: '{"command":"pwd"}', input: '{"command":"pwd"}', output: 'out ' + key, phase: 'result', children })
const flatten = (records: RecordNode[]): RecordNode[] => records.flatMap(item => [item, ...flatten(item.children || [])])
const group = (turn: number, records: RecordNode[], status = 'running', answer: RecordNode | null = null) => ({ key: 'turn:' + turn, turn, seq: records[0]?.seq ?? answer?.seq ?? turn, status, durationMs: status === 'running' ? null : 5000, processRecords: records, answer })
const snap = (sessionId: string, groups: ReturnType<typeof group>[], standalone: RecordNode[] = []) => ({ sessionId, records: [...standalone, ...groups.flatMap(owner => [...flatten(owner.processRecords), ...owner.answer ? [owner.answer] : []])].sort((a, b) => a.seq - b.seq), turns: groups, status: { running: false }, events: [], hasMore: false })
const classHas = (element: Element, name: string): boolean => element.className.split(/\s+/).includes(name)
const projectedNodes = (container: Element): Element[] => [...container.querySelectorAll('.native-message'), ...container.querySelectorAll('.native-tool').filter(node => !classHas(node.parentElement!, 'native-message'))]
const byKey = (container: Element, key: string): Element => { const result = container.querySelectorAll('[data-key]').find(element => element.getAttribute('data-key') === key); assert.ok(result, 'missing rendered key ' + key); return result }
const button = (container: Element, label: string): Element => { const result = container.querySelectorAll('button').find(element => element.textContent === label); assert.ok(result, 'missing button ' + label); return result }
const process = (container: Element, turn = 1): Element => { const result = container.querySelectorAll('.native-turn-process').find(element => element.getAttribute('data-turn') === String(turn)); assert.ok(result); return result }
const summary = (details: Element): Element => { const result = details.querySelector('summary'); assert.ok(result); return result }
const mounted = (options: { maxRows?: number } = {}) => {
  const doc = new Document(), main = doc.createElement('main'), container = doc.createElement('div')
  doc.body.append(main); main.append(container)
  const measurements: { drawn: number; follow: boolean }[] = []
  const view = mountConversation({ container, ...options, renderMarkdown: (element: Element, value: string) => { element.textContent = value }, onMeasure: (value: { drawn: number; follow: boolean }) => measurements.push(value) })
  return { doc, main, container, measurements, view }
}
const budget = (fixture: ReturnType<typeof mounted>, expected?: number) => {
  const actual = projectedNodes(fixture.container).length
  assert.ok(actual <= fixture.view.limits().maxDrawn, 'all actual projection rows, including nested tools, share the page limit')
  assert.equal(fixture.view.limits().drawn, actual, 'instrumentation includes PTC descendants')
  if (expected !== undefined) assert.equal(actual, expected)
  return actual
}

describe('native conversation global window and user disclosure', () => {
  it('state receipts update controls without emitting metadata JSON into the conversation', () => {
    const types = ['model/selection', 'sandbox/mode', 'permission/preset', 'goal/change', 'todo/write', 'agent-preset/selected']
    const stateRecords = types.map((type, index) => ({ ...record('state:' + index, index, 'other'), event: { type, data: { value: 'native state' } } }))
    const unknown = { ...record('unknown', 20, 'other'), event: { type: 'extension/notice', data: { text: 'real existing content' } } }
    const user = record('user', 21, 'user')
    assert.deepEqual(conversationItems(snap('s', [], [...stateRecords, unknown, user])).map(item => item.key), ['unknown', 'user'])
  })
  it('history prepend preserves reading rather than enabling bottom follow on a short folded page', () => {
    const fixture = mounted()
    try {
      fixture.view.update(snap('s', [], [record('current', 10)]))
      fixture.main.scrollTop = 0
      fixture.view.update(snap('s', [], [record('older', 1), record('current', 10)]), { preserveAnchor: true })
      assert.equal(fixture.measurements.at(-1)?.follow, false)
      assert.equal(fixture.container.querySelector('.back-to-bottom')?.hidden, false)
      assert.ok(byKey(fixture.container, 'older'))
      assert.ok(byKey(fixture.container, 'current'))
    } finally { fixture.view.dispose() }
  })
  it('one page budget spans several expanded process groups and standalone messages', async t => {
    const fixture = mounted(); t.after(() => fixture.view.dispose())
    const first = Array.from({ length: 130 }, (_, i) => tool('a:' + i, i + 1, 1))
    const second = Array.from({ length: 130 }, (_, i) => tool('b:' + i, i + 131, 2))
    const users = Array.from({ length: 10 }, (_, i) => record('user:' + i, i + 261, 'user'))
    const snapshot = snap('s', [group(1, first), group(2, second)], users)
    fixture.view.update(snapshot); await fixture.doc.flushToggles()
    budget(fixture, 200)
    assert.equal(process(fixture.container, 1).open, true)
    assert.equal(process(fixture.container, 2).open, true)
    assert.equal(fixture.measurements.at(-1)?.drawn, 200)
    assert.equal(fixture.view.limits().total, 270)
    assert.equal(snapshot.records.length, 270)
    assert.equal(byKey(fixture.container, 'user:9').textContent.includes('text user:9'), true)
  })
  it('PTC children consume the global budget and their later and earlier pages remain reachable', async t => {
    const fixture = mounted(); t.after(() => fixture.view.dispose())
    const children = Array.from({ length: 251 }, (_, i) => ({ ...tool('child:' + i, i + 2), parentCallId: 'root' }))
    const root = tool('root', 1, 1, children)
    fixture.view.update(snap('s', [group(1, [root])]))
    await summary(byKey(fixture.container, 'root').querySelector('.native-tool')!).fire('click'); await fixture.doc.flushToggles()
    budget(fixture, 200)
    assert.equal(fixture.container.querySelectorAll('.native-tool').length, 200)
    assert.equal(fixture.container.querySelectorAll('.native-message').length, 1)
    assert.equal(byKey(fixture.container, 'child:198').getAttribute('data-call-id'), 'child:198')
    assert.equal(fixture.view.limits().total, 252)
    await button(fixture.container, '查看后续子调用').fire('click'); await fixture.doc.flushToggles()
    budget(fixture, 53)
    assert.equal(byKey(fixture.container, 'child:199').getAttribute('data-call-id'), 'child:199')
    assert.equal(byKey(fixture.container, 'child:250').getAttribute('data-call-id'), 'child:250')
    await button(fixture.container, '查看更早的子调用').fire('click')
    budget(fixture, 200)
    assert.equal(byKey(fixture.container, 'child:0').getAttribute('data-call-id'), 'child:0')
  })
  it('nested PTC expansion and an adjacent final answer share the same record budget', async t => {
    const fixture = mounted(); t.after(() => fixture.view.dispose())
    const nested = Array.from({ length: 220 }, (_, i) => ({ ...tool('nested:' + i, i + 3), parentCallId: 'branch' }))
    const branch = { ...tool('branch', 2, 1, nested), parentCallId: 'root' }
    const root = tool('root', 1, 1, [branch, ...Array.from({ length: 80 }, (_, i) => ({ ...tool('sibling:' + i, i + 223), parentCallId: 'root' }))])
    fixture.view.update(snap('s', [group(1, [root])]))
    await summary(byKey(fixture.container, 'root').querySelector('.native-tool')!).fire('click')
    await summary(byKey(fixture.container, 'branch')).fire('click'); await fixture.doc.flushToggles()
    budget(fixture, 200)
    assert.equal(byKey(fixture.container, 'nested:197').getAttribute('data-call-id'), 'nested:197')
    const answer = record('answer', 304, 'assistant', 1)
    fixture.view.update(snap('s', [group(1, [root], 'running', answer)])); await fixture.doc.flushToggles()
    budget(fixture, 200)
    assert.equal(byKey(fixture.container, 'answer').textContent.includes('text answer'), true)
    assert.equal(fixture.view.limits().total, 303)
  })
  it('process pages retain the entire logical history and reach both ends', async t => {
    const fixture = mounted(); t.after(() => fixture.view.dispose())
    const records = Array.from({ length: 251 }, (_, i) => tool('tool:' + i, i + 1))
    const snapshot = snap('s', [group(1, records)])
    fixture.view.update(snapshot); budget(fixture, 200)
    assert.equal(byKey(fixture.container, 'tool:51').getAttribute('data-seq'), '52')
    await button(fixture.container, '查看更早的执行过程').fire('click'); budget(fixture, 200)
    assert.equal(byKey(fixture.container, 'tool:0').getAttribute('data-seq'), '1')
    await button(fixture.container, '查看后续执行过程').fire('click'); budget(fixture, 51)
    assert.equal(byKey(fixture.container, 'tool:250').getAttribute('data-seq'), '251')
    assert.equal(snapshot.records.length, 251)
  })
  it('default running process folds on completion after its automatic native toggle event', async t => {
    const fixture = mounted(); t.after(() => fixture.view.dispose())
    const records = [tool('tool:0', 1), tool('tool:1', 2)]
    fixture.view.update(snap('s', [group(1, records)])); await fixture.doc.flushToggles()
    assert.equal(process(fixture.container).open, true)
    budget(fixture, 2)
    const answer = record('answer', 3, 'assistant', 1)
    fixture.view.update(snap('s', [group(1, records, 'complete', answer)])); await fixture.doc.flushToggles()
    assert.equal(process(fixture.container).open, false)
    assert.equal(process(fixture.container).querySelector('.turn-process-body'), null)
    budget(fixture, 1)
    assert.equal(byKey(fixture.container, 'answer').textContent.includes('text answer'), true)
  })
  it('actual manual process choices persist across updates and are scoped to each session', async t => {
    const fixture = mounted(); t.after(() => fixture.view.dispose())
    const records = [tool('tool:0', 1)]
    const a = snap('a', [group(1, records)]), b = snap('b', [group(1, records)])
    fixture.view.update(a); await fixture.doc.flushToggles()
    await summary(process(fixture.container)).fire('click'); await fixture.doc.flushToggles()
    fixture.view.update(a); assert.equal(process(fixture.container).open, false)
    fixture.view.update(b); await fixture.doc.flushToggles(); assert.equal(process(fixture.container).open, true)
    fixture.view.update(a); assert.equal(process(fixture.container).open, false)
    await summary(process(fixture.container)).fire('click'); await fixture.doc.flushToggles()
    fixture.view.update(snap('a', [group(1, records, 'complete')])); assert.equal(process(fixture.container).open, true)
    fixture.view.update(snap('b', [group(1, records, 'complete')])); assert.equal(process(fixture.container).open, false)
    fixture.view.update(snap('a', [group(1, records, 'complete')])); assert.equal(process(fixture.container).open, true)
  })
  it('manual tool and reasoning disclosure survives replacement without learning programmatic toggles', async t => {
    const fixture = mounted(); t.after(() => fixture.view.dispose())
    const root = tool('root', 1), answer = record('answer', 2, 'assistant', 1)
    answer.blocks = [{ kind: 'reasoning', text: 'why' }, { kind: 'text', text: 'answer' }]
    const snapshot = snap('s', [group(1, [root], 'complete', answer)])
    fixture.view.update(snapshot)
    await summary(process(fixture.container)).fire('click')
    await summary(byKey(fixture.container, 'root').querySelector('.native-tool')!).fire('click')
    await summary(byKey(fixture.container, 'answer').querySelector('.native-reasoning')!).fire('click'); await fixture.doc.flushToggles()
    byKey(fixture.container, 'root').querySelector('.native-tool')!.open = false
    byKey(fixture.container, 'answer').querySelector('.native-reasoning')!.open = false
    await fixture.doc.flushToggles()
    fixture.view.update(snap('s', [group(1, [{ ...root, output: 'updated' }], 'complete', { ...answer, blocks: [{ kind: 'reasoning', text: 'updated why' }, { kind: 'text', text: 'answer' }] })]))
    assert.equal(byKey(fixture.container, 'root').querySelector('.native-tool')!.open, true)
    assert.equal(byKey(fixture.container, 'answer').querySelector('.native-reasoning')!.open, true)
    budget(fixture, 2)
  })
  it('a prepared tool ignores summary activation and cannot save an accidental open preference', async t => {
    const fixture = mounted(); t.after(() => fixture.view.dispose())
    const preparing = { ...tool('root', 1), phase: 'preparing', status: 'preparing' }
    fixture.view.update(snap('s', [group(1, [preparing])]))
    await summary(byKey(fixture.container, 'root').querySelector('.native-tool')!).fire('click'); await fixture.doc.flushToggles()
    assert.equal(byKey(fixture.container, 'root').querySelector('.native-tool')!.open, false)
    fixture.view.update(snap('s', [group(1, [tool('root', 1)])]))
    assert.equal(byKey(fixture.container, 'root').querySelector('.native-tool')!.open, false)
    budget(fixture, 1)
  })
  it('closing one expanded process releases its shared record budget to the other group', async t => {
    const fixture = mounted(); t.after(() => fixture.view.dispose())
    const first = Array.from({ length: 130 }, (_, i) => tool('a:' + i, i + 1, 1))
    const second = Array.from({ length: 130 }, (_, i) => tool('b:' + i, i + 131, 2))
    fixture.view.update(snap('s', [group(1, first), group(2, second)])); budget(fixture, 200)
    await summary(process(fixture.container, 1)).fire('click'); budget(fixture, 130)
    await summary(process(fixture.container, 1)).fire('click'); budget(fixture, 200)
    await summary(process(fixture.container, 2)).fire('click'); budget(fixture, 130)
    assert.equal(process(fixture.container, 1).open, true)
  })
  it('plain records retain 200 rows, earlier windows are reachable, and disposal detaches the view', async t => {
    const fixture = mounted({ maxRows: 999 }); t.after(() => fixture.view.dispose())
    const snapshot = snap('s', [], Array.from({ length: 251 }, (_, i) => record('user:' + i, i, 'user')))
    fixture.view.update(snapshot); budget(fixture, 200)
    assert.equal(fixture.view.limits().maxDrawn, 200)
    assert.equal(byKey(fixture.container, 'user:51').getAttribute('data-seq'), '51')
    fixture.main.scrollHeight = 10000; fixture.main.clientHeight = 400; fixture.main.scrollTop = 0
    await fixture.main.fire('scroll'); budget(fixture, 200)
    assert.equal(byKey(fixture.container, 'user:0').getAttribute('data-seq'), '0')
    await button(fixture.container, '↓').fire('click'); budget(fixture, 200)
    assert.equal(byKey(fixture.container, 'user:250').getAttribute('data-seq'), '250')
    assert.equal(fixture.view.limits().total, 251)
    fixture.view.dispose(); fixture.view.update(snapshot)
    assert.equal(fixture.container.children.length, 0)
  })
})
