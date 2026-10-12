import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
// @ts-expect-error Browser assets ship as JavaScript; the runtime interface is exercised below.
import { groupSessions, matchesSessionQuery, mountNavigation, sessionActivity, subagentCounts, subagentEntries, workspaceLabel } from '../assets/dsh-chat/navigation.js'

// The catalog matches the actual SubagentCatalogEntry union in app.asar.
const catalog = [
  { id: 'child-c', createdAt: 1700000000010, mode: 'continuable', label: '继续任务' },
  { id: 'child-o', createdAt: 1700000000020, mode: 'one-shot' },
  { id: 'child-u', createdAt: 1700000000030, mode: 'unknown', label: '旧任务' },
]
const parent = { id: 'parent', title: '移动聊天', cwd: '/work/mobile', running: true, updatedAt: 50, subagentStats: { total: 3, running: 1 } }
const sibling = { id: 'sibling', title: '另一会话', cwd: '/work/mobile', running: false, updatedAt: 60 }

class UiEvent {
  type: string; target: Element | null = null; currentTarget: Element | Document | null = null
  key = ''; shiftKey = false; isComposing = false; defaultPrevented = false; propagationStopped = false
  constructor(type: string, fields: Record<string, unknown> = {}) { this.type = type; Object.assign(this, fields) }
  preventDefault(): void { this.defaultPrevented = true }
  stopPropagation(): void { this.propagationStopped = true }
}
type Listener = (event: UiEvent) => unknown
class Element {
  tagName: string; ownerDocument: Document; children: Element[] = []; parentElement: Element | null = null
  attributes = new Map<string, string>(); listeners = new Map<string, Listener[]>()
  className = ''; id = ''; hidden = false; disabled = false; type = ''; title = ''; value = ''; placeholder = ''; ownText = ''
  classList = {
    add: (name: string): void => { this.classList.toggle(name, true) },
    toggle: (name: string, enabled: boolean): void => { const names = new Set(this.className.split(/\s+/).filter(Boolean)); if (enabled) names.add(name); else names.delete(name); this.className = [...names].join(' ') },
  }
  constructor(tag: string, doc: Document) { this.tagName = tag.toUpperCase(); this.ownerDocument = doc }
  get textContent(): string { return this.ownText + this.children.map(node => node.textContent).join('') }
  set textContent(value: string) { this.replaceChildren(); this.ownText = value }
  set innerHTML(_value: string) { throw new Error('Navigation must create text nodes; HTML injection is not a rendering primitive') }
  appendChild(child: Element): Element { child.remove(); child.parentElement = this; this.children.push(child); return child }
  replaceChildren(...nodes: Element[]): void { for (const child of this.children) child.parentElement = null; this.children = []; this.ownText = ''; for (const node of nodes) this.appendChild(node) }
  remove(): void { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(node => node !== this); this.parentElement = null }
  setAttribute(name: string, value: unknown): void { this.attributes.set(name, String(value)); if (name === 'id') this.id = String(value); if (name === 'class') this.className = String(value) }
  getAttribute(name: string): string | null { return this.attributes.get(name) ?? null }
  addEventListener(type: string, handler: Listener): void { this.listeners.set(type, [...(this.listeners.get(type) ?? []), handler]) }
  removeEventListener(type: string, handler: Listener): void { this.listeners.set(type, (this.listeners.get(type) ?? []).filter(item => item !== handler)) }
  contains(target: Element | null): boolean { return target === this || this.children.some(child => child.contains(target)) }
  focus(): void { if (!this.disabled) this.ownerDocument.activeElement = this }
  select(): void { this.setAttribute('data-selected', 'true') }
  matches(selector: string): boolean {
    if (selector.startsWith('#')) return this.id === selector.slice(1)
    if (selector.startsWith('.')) return this.className.split(/\s+/).includes(selector.slice(1))
    const attribute = /^\[([^=]+)="(.*)"\]$/.exec(selector)
    if (attribute) return this.getAttribute(attribute[1]!) === attribute[2]
    return this.tagName.toLowerCase() === selector
  }
  querySelectorAll(selector: string): Element[] { return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]) }
  querySelector(selector: string): Element | null { return this.querySelectorAll(selector)[0] ?? null }
  async dispatchEvent(event: UiEvent): Promise<void> {
    event.target ??= this; event.currentTarget = this
    for (const listener of this.listeners.get(event.type) ?? []) await listener(event)
    if (!event.propagationStopped) { if (this.parentElement) await this.parentElement.dispatchEvent(event); else await this.ownerDocument.dispatchEvent(event) }
  }
  async click(): Promise<void> { if (!this.disabled) await this.dispatchEvent(new UiEvent('click')) }
  async fire(type: string, fields: Record<string, unknown> = {}): Promise<UiEvent> { const event = new UiEvent(type, fields); await this.dispatchEvent(event); return event }
}
class Document {
  activeElement: Element | null = null; body: Element; listeners = new Map<string, Listener[]>()
  copied: string[] = []; copyError: Error | null = null
  defaultView = { navigator: { clipboard: { writeText: async (value: string): Promise<void> => { if (this.copyError) throw this.copyError; this.copied.push(value) } } } }
  constructor() { this.body = this.createElement('body') }
  createElement(tag: string): Element { return new Element(tag, this) }
  createElementNS(_namespace: string, tag: string): Element { return this.createElement(tag) }
  querySelector(selector: string): Element | null { return this.body.querySelector(selector) }
  addEventListener(type: string, handler: Listener): void { this.listeners.set(type, [...(this.listeners.get(type) ?? []), handler]) }
  removeEventListener(type: string, handler: Listener): void { this.listeners.set(type, (this.listeners.get(type) ?? []).filter(item => item !== handler)) }
  async dispatchEvent(event: UiEvent): Promise<void> { event.currentTarget = this; for (const listener of this.listeners.get(event.type) ?? []) await listener(event) }
}
interface MountedOptions {
  switch?: (id: string, metadata: unknown) => unknown
  create?: (args: unknown) => unknown
  rename?: ((args: { sessionId: string; title: string }) => unknown) | null
  files?: (() => unknown) | null
  refresh?: (() => unknown) | null
}
function mounted(options: MountedOptions = {}) {
  const doc = new Document(), root = doc.body
  const el = (tag: string, id: string, parentElement = root): Element => { const node = doc.createElement(tag); node.id = id; parentElement.appendChild(node); return node }
  const header = el('header', 'header')
  const hamburger = el('button', 'session-menu', header), title = el('button', 'title', header), files = el('button', 'files', header), badge = el('button', 'subagent-count', header)
  title.textContent = '旧页标题'
  const drawer = el('div', 'sessions'), backdrop = el('button', 'session-backdrop'), actions = el('div', 'session-actions'), refresh = el('button', 'refresh', actions)
  drawer.hidden = actions.hidden = backdrop.hidden = true
  const input = el('textarea', 'input'); input.value = '草稿保持原样'
  const messages = el('div', 'list'); messages.textContent = '已收到的消息'
  const errors: string[] = [], notices: string[] = [], logs: string[] = [], switches: { id: string; metadata: unknown }[] = [], created: unknown[] = [], renames: unknown[] = []
  let fileCalls = 0, refreshCalls = 0
  const nav = mountNavigation({
    root: doc,
    onSwitch: (id: string, metadata: unknown) => { switches.push({ id, metadata }); return options.switch?.(id, metadata) },
    onCreate: (args: unknown) => { created.push(args); return options.create?.(args) },
    onRename: options.rename === null ? undefined : async (args: { sessionId: string; title: string }) => { renames.push(args); return options.rename ? options.rename(args) : { ok: true, sessionId: args.sessionId, title: args.title } },
    onFiles: options.files === null ? undefined : () => { fileCalls += 1; return options.files?.() },
    onRefresh: options.refresh === null ? undefined : () => { refreshCalls += 1; return options.refresh?.() },
    onError: (value: string) => errors.push(value), onNotice: (value: string) => notices.push(value), onLog: (value: string) => logs.push(value),
  })
  const action = (name: string): Element => root.querySelector('[data-navigation-action="' + name + '"]')!
  const row = (id: string, within: Element = drawer): Element => within.querySelector('[data-session-id="' + id + '"]')!
  const flush = async (): Promise<void> => { await new Promise(resolve => setImmediate(resolve)) }
  return { nav, doc, root, drawer, backdrop, actions, title, hamburger, files, refresh, badge, input, messages, errors, notices, logs, switches, created, renames, action, row, flush, calls: () => ({ files: fileCalls, refresh: refreshCalls }) }
}
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }

describe('native navigation uses original Session and SubagentCatalogEntry facts', () => {
  it('groups by full cwd, shows Windows/Unix basename, and keeps fork sessions', () => {
    const list = [{ ...parent, cwd: '/one/shared' }, { ...sibling, cwd: '/two/shared' }, { id: 'windows', cwd: 'C:\\work\\工程\\', updatedAt: 100 }, { id: 'fork', cwd: '/one/shared', parentSessionId: 'parent', updatedAt: 200 }, { id: 'child', origin: 'subagent', cwd: '/one/shared' }, { id: 'ungrouped' }]
    const before = structuredClone(list), groups = groupSessions(list, '', 'sibling')
    assert.equal(groups[0].cwd, '/two/shared')
    assert.equal(groups.filter((group: { label: string }) => group.label === 'shared').length, 2)
    assert.deepEqual(groups.flatMap((group: { sessions: { id: string }[] }) => group.sessions).map((session: { id: string }) => session.id).sort(), ['fork', 'parent', 'sibling', 'ungrouped', 'windows'])
    assert.equal(workspaceLabel('C:\\work\\工程\\'), '工程'); assert.equal(workspaceLabel('/'), '/'); assert.equal(workspaceLabel(undefined), '未分组')
    assert.deepEqual(list, before)
  })
  it('searches title and ID with multi-term AND and no mutation', () => {
    assert.equal(matchesSessionQuery({ id: 'session-ABC', title: 'Native Mobile' }, 'mobile abc'), true)
    assert.equal(matchesSessionQuery({ id: 'session-ABC', title: 'Native Mobile' }, 'mobile missing'), false)
    assert.equal(matchesSessionQuery(parent, '移动聊天'), true)
    assert.equal(groupSessions([parent, sibling], 'SIBLING')[0].sessions[0].id, 'sibling')
  })
  it('accepts only the catalog array and the three original modes', () => {
    assert.deepEqual(subagentEntries(catalog), catalog)
    for (const value of [{ items: catalog }, { map: catalog }, { 'child-c': catalog[0] }, null]) assert.equal(subagentEntries(value), null)
    assert.deepEqual(subagentEntries([{ id: 'no-time', mode: 'unknown' }, { id: 'no-label', mode: 'continuable', createdAt: 1 }, { id: 'bad-mode', mode: 'observe', createdAt: 2 }, { id: ' ', mode: 'unknown', createdAt: 3 }, catalog[0], catalog[0]]), [catalog[0]])
  })
  it('keeps unknown running counts unknown and never counts mode as activity', () => {
    assert.deepEqual(subagentCounts(parent, catalog), { total: 3, running: 1 })
    assert.deepEqual(subagentCounts({ subagentStats: { total: 3, running: null } }, catalog), { total: 3, running: null })
    assert.deepEqual(subagentCounts({ subagentStats: { total: 9, running: 8 } }, catalog), { total: 3, running: null })
    assert.deepEqual(subagentCounts({}, catalog, [{ id: 'child-c', running: true }, { id: 'child-o', running: false }, { id: 'child-u', running: false }]), { total: 3, running: 1 })
    assert.deepEqual(subagentCounts({}, catalog, [{ id: 'child-c', running: true }]), { total: 3, running: null })
    assert.deepEqual(subagentCounts({ subagentStats: { total: 2, running: 3 } }), { total: 2, running: null })
    assert.deepEqual(subagentCounts({}, []), { total: 0, running: 0 })
  })
  it('shows real waiting/running and unknown status rather than inventing child activity', () => {
    assert.deepEqual(sessionActivity(parent), { kind: 'running', label: '运行中' })
    assert.deepEqual(sessionActivity({ ...parent, awaitingApproval: true }), { kind: 'waiting', label: '等审批' })
    assert.deepEqual(sessionActivity(parent, { userQuestions: { active: [{ callId: 'ask' }], settled: [] } }), { kind: 'waiting', label: '等选择' })
    assert.deepEqual(sessionActivity({ mode: 'continuable', createdAt: Date.now() }), { kind: 'unknown', label: '状态未知' })
    assert.deepEqual(sessionActivity(sibling), { kind: 'idle', label: '空闲' })
  })
})

describe('native navigation DOM and durable switching', () => {
  it('hamburger opens the workspace drawer; title opens its separate menu', async () => {
    const p = mounted(); p.nav.setSessions([parent, sibling], 'parent', '移动聊天')
    assert.equal(p.title.textContent, '移动聊天')
    await p.hamburger.click()
    assert.equal(p.drawer.hidden, false); assert.equal(p.backdrop.hidden, false); assert.equal(p.actions.hidden, true)
    assert.equal(p.hamburger.getAttribute('aria-expanded'), 'true'); assert.equal(p.drawer.getAttribute('role'), 'navigation')
    assert.equal(p.doc.body.getAttribute('data-dsh-mobile-drawer'), 'open')
    assert.equal(p.drawer.parentElement, p.doc.body)
    assert.equal(p.drawer.querySelector('.session-workspace-name')!.textContent, 'mobile')
    assert.equal(p.drawer.querySelector('.session-workspace-path')!.textContent, '/work/mobile')
    assert.equal(p.row('parent').getAttribute('aria-current'), 'page')
    assert.equal(p.row('parent').querySelector('.session-flag')!.textContent, '运行中')
    await p.title.click()
    assert.equal(p.drawer.hidden, true); assert.equal(p.backdrop.hidden, true); assert.equal(p.actions.hidden, false)
    assert.deepEqual(p.actions.querySelectorAll('[data-navigation-action="rename"]').map(node => node.textContent), ['重命名'])
    assert.equal(p.title.getAttribute('aria-expanded'), 'true')
    await p.title.click(); assert.equal(p.actions.hidden, true)
  })
  it('filters actual drawer rows by title and ID and keeps the search field mounted', async () => {
    const p = mounted(); p.nav.setSessions([parent, sibling], 'parent'); await p.hamburger.click()
    const search = p.drawer.querySelector('.session-search')!
    search.value = 'SIBLING'; await search.fire('input')
    assert.equal(p.drawer.querySelectorAll('.session-row').filter(node => node.getAttribute('data-session-id')).length, 1)
    assert.equal(p.row('sibling').textContent, '另一会话')
    assert.equal(p.doc.activeElement, p.action('close'))
    p.nav.setSessions([parent, { ...sibling, title: '更新标题' }], 'parent')
    assert.equal(p.drawer.querySelector('.session-search'), search); assert.equal(search.value, 'SIBLING')
    search.value = '不存在'; await search.fire('input'); assert.equal(p.drawer.querySelector('.session-empty')!.textContent, '没有匹配的会话')
  })
  it('calls ordinary switch/create without altering messages or drafts', async () => {
    const p = mounted(); p.nav.setSessions([parent, sibling], 'parent'); await p.hamburger.click()
    await p.row('parent').click(); assert.equal(p.switches.length, 0)
    await p.hamburger.click(); await p.row('sibling').click(); await p.flush()
    assert.deepEqual(p.switches, [{ id: 'sibling', metadata: { address: { kind: 'session', sessionId: 'sibling' }, title: '另一会话' } }])
    assert.equal(p.drawer.hidden, true); assert.equal(p.backdrop.hidden, true)
    await p.hamburger.click(); await p.action('create').click(); await p.flush()
    assert.deepEqual(p.created, [{ cwd: '/work/mobile' }])
    assert.equal(p.messages.textContent, '已收到的消息'); assert.equal(p.input.value, '草稿保持原样')
  })
  it('renders the real total/running badge and opens catalog without a invented item envelope', async () => {
    const p = mounted(); p.nav.setSessions([parent], 'parent')
    assert.equal(p.badge.hidden, false); assert.equal(p.badge.textContent, '3 个子智能体'); assert.match(p.badge.title, /运行中 1 个/)
    p.nav.setValues({ subagentCatalog: catalog }, { sessionId: 'parent' }); await p.badge.click()
    const panel = p.root.querySelector('#subagent-catalog')!
    assert.equal(panel.hidden, false); assert.equal(p.drawer.hidden, true)
    assert.equal(panel.querySelectorAll('.subagent-row').length, 3)
    assert.match(p.row('child-c', panel).textContent, /可继续 · 状态未知/)
    assert.match(p.row('child-o', panel).textContent, /一次性 · 状态未知/)
    assert.equal(p.nav.setValues({ subagentCatalog: { items: catalog } }, { sessionId: 'parent' }), true)
    assert.equal(panel.querySelectorAll('.subagent-row').length, 3, 'Malformed partial values do not fabricate a catalog clear')
    p.nav.setValues({ subagentCatalog: [] }, { sessionId: 'parent' }); assert.equal(p.badge.hidden, true)
    assert.equal(panel.querySelectorAll('.subagent-row').length, 0)
  })
  it('routes all three original child modes and preserves synthetic children across list refresh', async () => {
    const p = mounted(); p.nav.setSessions([parent], 'parent'); p.nav.setValues({ subagentCatalog: catalog }, { sessionId: 'parent' })
    for (const entry of catalog) {
      await p.badge.click(); const panel = p.root.querySelector('#subagent-catalog')!
      await p.row(entry.id, panel).click(); await p.flush()
      assert.deepEqual(p.switches.at(-1), { id: entry.id, metadata: { address: { kind: 'subagent', parentSessionId: 'parent', childSessionId: entry.id, mode: entry.mode }, title: entry.label || entry.id } })
    }
    const merged = p.nav.setSessions([parent], 'child-c', 'child-c')
    assert.equal(p.title.textContent, '继续任务')
    assert.equal(merged.filter((item: { id: string }) => item.id === 'child-c').length, 1)
    assert.deepEqual(p.nav.session('child-c').address, { kind: 'subagent', parentSessionId: 'parent', childSessionId: 'child-c', mode: 'continuable' })
    assert.equal(p.badge.hidden, false, 'A selected child can always return to its known parent')
    await p.badge.click(); await p.action('parent').click(); await p.flush()
    assert.equal(p.switches.at(-1)?.id, 'parent')
    await p.title.click(); assert.equal(p.action('rename').disabled, true)
  })
  it('uses real child summaries for running labels while retaining the catalog address', async () => {
    const p = mounted(); p.nav.setSessions([parent], 'parent'); p.nav.setValues({ subagentCatalog: catalog }, { sessionId: 'parent', subagentSessions: [{ id: 'child-c', title: '细节', running: true }, { id: 'child-o', running: false }, { id: 'child-u', running: false }] })
    await p.badge.click(); const panel = p.root.querySelector('#subagent-catalog')!
    assert.match(p.row('child-c', panel).textContent, /运行中/); assert.match(p.row('child-o', panel).textContent, /空闲/)
    p.nav.setSessions([parent, { id: 'child-c', origin: 'subagent', running: false }], 'child-c')
    assert.equal(p.nav.session('child-c').running, false)
    assert.equal(p.nav.session('child-c').address.mode, 'continuable')
    assert.equal(p.nav.sessions().filter((item: { id: string }) => item.id === 'child-c').length, 1)
  })
  it('ignores old-session projection responses after switching', async () => {
    const p = mounted(); p.nav.setSessions([parent, sibling], 'parent'); p.nav.setValues({ subagentCatalog: catalog }, { sessionId: 'parent' })
    p.nav.setSessions([parent, sibling], 'sibling', '另一会话')
    assert.equal(p.nav.setValues({ title: '迟到旧标题', subagentCatalog: catalog }, { sessionId: 'parent' }), false)
    assert.equal(p.title.textContent, '另一会话'); assert.equal(p.badge.hidden, true)
    p.nav.setValues({ subagentCatalog: [], userQuestions: { active: [{ callId: 'real-question' }], settled: [] } }, { sessionId: 'sibling' })
    await p.hamburger.click(); assert.equal(p.row('sibling').querySelector('.session-flag')!.textContent, '等选择')
    p.nav.setSessions([parent, sibling], 'parent')
    assert.equal(p.nav.session('child-c').address.parentSessionId, 'parent')
  })
  it('shows host titles and directory text as text, including markup characters', async () => {
    const p = mounted(); p.nav.setSessions([{ id: 'unsafe', title: '<img src=x onerror=boom()>', cwd: '/work/<script>', running: false }], 'unsafe')
    await p.hamburger.click(); assert.equal(p.row('unsafe').textContent, '<img src=x onerror=boom()>')
    assert.equal(p.drawer.querySelector('.session-workspace-name')!.textContent, '<script>')
    assert.equal(p.title.textContent, '<img src=x onerror=boom()>')
  })
  it('writes readable diagnostics only when authoritative navigation facts change', () => {
    const p = mounted(); p.nav.setSessions([parent], 'parent'); p.nav.setSessions([parent], 'parent')
    assert.equal(p.logs.length, 1); assert.match(p.logs[0]!, /子目录=尚未收到 子智能体总数=3 运行中=1/)
    p.nav.setValues({ subagentCatalog: catalog }, { sessionId: 'parent' }); p.nav.setValues({ subagentCatalog: catalog }, { sessionId: 'parent' })
    assert.equal(p.logs.length, 2); assert.match(p.logs[1]!, /子目录=已收到 子智能体总数=3 运行中=1/)
    assert.equal(p.nav.setValues({ title: '旧数据' }, { sessionId: 'other' }), false); assert.equal(p.logs.length, 2)
  })
})

describe('native title menu receipts and lifecycle', () => {
  it('copies the real current ID and reports clipboard rejection accurately', async () => {
    const p = mounted(); p.nav.setSessions([parent], 'parent'); await p.title.click(); await p.action('copy-id').click()
    assert.deepEqual(p.doc.copied, ['parent']); assert.equal(p.actions.querySelector('.session-menu-feedback')!.textContent, '已复制会话 ID')
    p.doc.copyError = new Error('禁止读取剪贴板'); await p.action('copy-id').click()
    assert.match(p.errors.at(-1)!, /复制失败：禁止读取剪贴板/)
    assert.match(p.actions.querySelector('.session-menu-feedback')!.textContent, /复制失败/)
  })
  it('renames only after the correct host receipt and trims user input', async () => {
    const receipt = deferred<unknown>(), p = mounted({ rename: () => receipt.promise })
    p.nav.setSessions([parent], 'parent'); await p.title.click(); await p.action('rename').click()
    const input = p.actions.querySelector('.session-rename-input')!, form = p.actions.querySelector('.session-rename-form')!
    assert.equal(input.value, '移动聊天'); assert.equal(input.getAttribute('data-selected'), 'true')
    input.value = '  新标题  '; await input.fire('input'); const submit = form.fire('submit')
    assert.equal(input.disabled, true); assert.equal(p.action('save-rename').disabled, true)
    assert.equal(p.title.textContent, '移动聊天')
    receipt.resolve({ ok: true, sessionId: 'parent', title: '服务端新标题' }); await submit
    assert.deepEqual(p.renames, [{ sessionId: 'parent', title: '新标题' }])
    assert.equal(p.title.textContent, '服务端新标题'); assert.equal(form.hidden, true); assert.deepEqual(p.notices, ['已重命名'])
    assert.equal(p.row('parent').querySelector('.session-title')!.textContent, '服务端新标题')
  })
  it('keeps the title unchanged and form retryable on a missing, false or wrong-session receipt', async () => {
    for (const result of [undefined, { ok: true, sessionId: 'other' }, { ok: false, error: { message: '宿主拒绝' } }]) {
      const p = mounted({ rename: () => result }); p.nav.setSessions([parent], 'parent'); await p.title.click(); await p.action('rename').click()
      const input = p.actions.querySelector('.session-rename-input')!, form = p.actions.querySelector('.session-rename-form')!
      input.value = '不该假成功'; await input.fire('input'); await form.fire('submit')
      assert.equal(p.title.textContent, '移动聊天'); assert.equal(form.hidden, false); assert.equal(input.disabled, false)
      assert.equal(p.errors.length, 1); assert.match(p.errors[0]!, /重命名失败/); assert.equal(p.notices.length, 0)
    }
  })
  it('blocks empty and IME-composition submission, and does not submit twice while pending', async () => {
    const receipt = deferred<unknown>(), p = mounted({ rename: () => receipt.promise })
    p.nav.setSessions([parent], 'parent'); await p.title.click(); await p.action('rename').click()
    const input = p.actions.querySelector('.session-rename-input')!, form = p.actions.querySelector('.session-rename-form')!
    input.value = '   '; await input.fire('input'); await form.fire('submit'); assert.equal(p.renames.length, 0)
    input.value = '输入中'; await input.fire('input'); await input.fire('compositionstart'); await form.fire('submit'); assert.equal(p.renames.length, 0)
    await input.fire('compositionend'); const first = form.fire('submit'); await form.fire('submit'); assert.equal(p.renames.length, 1)
    receipt.resolve({ ok: true, sessionId: 'parent' }); await first
  })
  it('does not let a late rename receipt or rejection alter another session', async () => {
    for (const rejected of [false, true]) {
      const receipt = deferred<unknown>(), p = mounted({ rename: () => receipt.promise })
      p.nav.setSessions([parent, sibling], 'parent'); await p.title.click(); await p.action('rename').click()
      const input = p.actions.querySelector('.session-rename-input')!, form = p.actions.querySelector('.session-rename-form')!
      input.value = '旧会话改名'; await input.fire('input'); const submitted = form.fire('submit')
      p.nav.setSessions([parent, sibling], 'sibling', '另一会话')
      if (rejected) receipt.reject(new Error('旧请求失败')); else receipt.resolve({ ok: true, sessionId: 'parent', title: '旧会话改名' })
      await submitted
      assert.equal(p.title.textContent, '另一会话'); assert.equal(p.errors.length, 0); assert.equal(p.notices.length, 0)
      assert.equal(p.actions.hidden, true)
    }
  })
  it('calls the real files/refresh callbacks and disables unavailable capabilities', async () => {
    const p = mounted(); p.nav.setSessions([parent], 'parent'); await p.files.click(); await p.title.click(); await p.refresh.click(); await p.flush()
    assert.deepEqual(p.calls(), { files: 1, refresh: 1 }); assert.equal(p.actions.hidden, true)
    const missing = mounted({ files: null, refresh: null, rename: null }); missing.nav.setSessions([parent], 'parent')
    assert.equal(missing.files.disabled, true); assert.equal(missing.refresh.disabled, true); assert.equal(missing.action('rename').disabled, true)
    await missing.files.click(); await missing.refresh.click(); assert.deepEqual(missing.calls(), { files: 0, refresh: 0 })
    const failed = mounted({ files: () => ({ ok: false, error: { message: '文件服务未接通' } }) }); await failed.files.click(); await failed.flush()
    assert.deepEqual(failed.errors, ['打开文件失败：文件服务未接通'])
  })
  it('closes by backdrop, outside click and Escape, with focus restored and drawer Tab wrapped', async () => {
    const p = mounted(); p.nav.setSessions([parent, sibling], 'parent'); await p.hamburger.click(); await p.backdrop.click()
    assert.equal(p.drawer.hidden, true); assert.equal(p.doc.activeElement, p.hamburger)
    await p.title.click(); const escape = new UiEvent('keydown', { key: 'Escape' }); await p.doc.dispatchEvent(escape)
    assert.equal(escape.defaultPrevented, true); assert.equal(p.actions.hidden, true); assert.equal(p.doc.activeElement, p.title)
    await p.hamburger.click(); const first = p.action('close'), last = p.drawer.querySelectorAll('[data-navigation-action="switch"]').at(-1)!
    last.focus(); const forward = new UiEvent('keydown', { key: 'Tab' }); await p.doc.dispatchEvent(forward); assert.equal(p.doc.activeElement, first); assert.equal(forward.defaultPrevented, true)
    const backward = new UiEvent('keydown', { key: 'Tab', shiftKey: true }); await p.doc.dispatchEvent(backward); assert.equal(p.doc.activeElement, last)
    await p.messages.click(); assert.equal(p.drawer.hidden, true); assert.equal(p.backdrop.hidden, true)
  })
  it('dispose removes global listeners and suppresses late pending results', async () => {
    const receipt = deferred<unknown>(), p = mounted({ rename: () => receipt.promise })
    p.nav.setSessions([parent], 'parent'); await p.title.click(); await p.action('rename').click()
    const input = p.actions.querySelector('.session-rename-input')!, form = p.actions.querySelector('.session-rename-form')!
    input.value = '迟到'; await input.fire('input'); const pending = form.fire('submit'); p.nav.dispose()
    receipt.resolve({ ok: true, sessionId: 'parent', title: '迟到' }); await pending
    assert.equal(p.title.textContent, '移动聊天'); assert.equal(p.doc.listeners.get('click')!.length, 0); assert.equal(p.doc.listeners.get('keydown')!.length, 0)
    assert.equal(p.root.querySelector('#subagent-catalog'), null); await p.hamburger.click(); assert.equal(p.drawer.hidden, true)
    assert.equal(p.nav.setValues({ title: '未生效' }), false); assert.deepEqual(p.errors, []); assert.deepEqual(p.notices, [])
    p.nav.dispose()
  })
})
