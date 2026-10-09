import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { formatFileMention, inputTrigger, mountComposerControls, resolveCommand } from '../assets/dsh-chat/composer.js'

/** The DOM double covers actual menu clicks, disabling, focus, and capture. */
class UiEvent {
  type: string
  target: Element | null = null
  key = ''
  isComposing = false
  shiftKey = false
  defaultPrevented = false
  immediateStopped = false
  propagationStopped = false
  constructor(type: string) { this.type = type }
  preventDefault(): void { this.defaultPrevented = true }
  stopPropagation(): void { this.propagationStopped = true }
  stopImmediatePropagation(): void { this.immediateStopped = true; this.propagationStopped = true }
}
class Element {
  tagName: string
  ownerDocument: Document
  children: Element[] = []
  parentElement: Element | null = null
  attributes = new Map<string, string>()
  listeners: { type: string; handler: (event: UiEvent) => void; capture: boolean }[] = []
  className = ''
  id = ''
  hidden = false
  disabled = false
  checked = false
  type = ''
  title = ''
  value = ''
  placeholder = ''
  selectionStart = 0
  selectionEnd = 0
  style: { left?: string; top?: string } = {}
  ownText = ''
  constructor(tagName: string, owner: Document) { this.tagName = tagName; this.ownerDocument = owner }
  get textContent(): string { return this.ownText + this.children.map((node) => node.textContent).join('') }
  set textContent(value: string) { this.ownText = value; this.children = [] }
  appendChild(node: Element): Element { this.children.push(node); node.parentElement = this; return node }
  replaceChildren(...nodes: Element[]): void { this.ownText = ''; this.children = []; for (const node of nodes) this.appendChild(node) }
  setAttribute(name: string, value: unknown): void { this.attributes.set(name, String(value)); if (name === 'id') this.id = String(value) }
  getAttribute(name: string): string | null { return this.attributes.get(name) ?? null }
  removeAttribute(name: string): void { this.attributes.delete(name) }
  addEventListener(type: string, handler: (event: UiEvent) => void, options?: boolean): void { this.listeners.push({ type, handler, capture: options === true }) }
  removeEventListener(type: string, handler: (event: UiEvent) => void): void { this.listeners = this.listeners.filter((listener) => listener.type !== type || listener.handler !== handler) }
  contains(target: Element | null): boolean { return target === this || this.children.some((child) => child.contains(target)) }
  focus(): void { this.ownerDocument.activeElement = this }
  setSelectionRange(start: number, end: number): void { this.selectionStart = start; this.selectionEnd = end }
  scrollIntoView(): void {}
  getBoundingClientRect(): { width: number; height: number; top: number; right: number } { return { width: 280, height: 180, top: 660, right: 396 } }
  matches(selector: string): boolean {
    const attribute = /\[([^=\]]+)(?:="?([^"\]]+)"?)?\]/.exec(selector)
    if (attribute && (this.getAttribute(attribute[1] as string) === null || attribute[2] !== undefined && this.getAttribute(attribute[1] as string) !== attribute[2])) return false
    const plain = selector.replace(/\[[^\]]+\]/, '')
    if (!plain) return true
    if (plain.startsWith('#')) return this.id === plain.slice(1)
    if (plain.startsWith('.')) return this.className.split(/\s+/).includes(plain.slice(1))
    return this.tagName === plain
  }
  querySelectorAll(selector: string): Element[] {
    const results: Element[] = []
    const walk = (node: Element): void => { for (const child of node.children) { if (child.matches(selector)) results.push(child); walk(child) } }
    walk(this)
    return results
  }
  querySelector(selector: string): Element | null { return this.querySelectorAll(selector)[0] ?? null }
  dispatchEvent(event: UiEvent): boolean {
    event.target ??= this
    const listeners = [...this.listeners].filter((listener) => listener.type === event.type).sort((a, b) => Number(b.capture) - Number(a.capture))
    for (const listener of listeners) { if (event.immediateStopped) break; listener.handler(event) }
    return !event.defaultPrevented
  }
  click(): UiEvent {
    const event = new UiEvent('click')
    if (!this.disabled) this.dispatchEvent(event)
    return event
  }
}
class Document {
  activeElement: Element | null = null
  listeners: { type: string; handler: (event: UiEvent) => void }[] = []
  defaultView = { innerWidth: 412, innerHeight: 915, Event: UiEvent, addEventListener() {}, removeEventListener() {} }
  createElement(tag: string): Element { return new Element(tag, this) }
  createElementNS(_namespace: string, tag: string): Element { return this.createElement(tag) }
  addEventListener(type: string, handler: (event: UiEvent) => void): void { this.listeners.push({ type, handler }) }
  removeEventListener(type: string, handler: (event: UiEvent) => void): void { this.listeners = this.listeners.filter((listener) => listener.type !== type || listener.handler !== handler) }
}
type Call = { kind?: string; sessionId?: string; line?: string; action?: string; ref?: { id: string; revision: number }; request?: { objective: string }; provider?: string; model?: string; reasoningEffort?: string; query?: string; quoted?: boolean; receiptIds?: string[]; address?: unknown }
type Handler = (args: Call) => Promise<unknown>
interface Extra {
  channels?: { controls?: boolean }
  onCatalog?: Handler
  onSelectModel?: Handler
  onCommand?: Handler
  onReferences?: Handler
  onCancel?: Handler
  onGoal?: Handler
  onRefresh?: Handler
  onSubmit?: () => void
}
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: Error) => void } {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}
const settle = async (): Promise<void> => { await new Promise((resolve) => setTimeout(resolve, 0)) }
const models = {
  default: { provider: 'actual-provider', model: 'actual-model', reasoningEffort: 'low' },
  groups: [{ id: 'actual-provider', name: '实际提供方', models: [
    { id: 'actual-model', name: '实际模型', reasoning: { defaultEffort: 'low', efforts: [{ id: 'low', name: '轻量' }, { id: 'high', name: '深入' }] } },
    { id: 'second-model', name: '第二模型' },
  ] }], failures: [],
}
const permissions = { options: [
  { value: 'read-only', name: 'Read Only' }, { value: 'workspace-write', name: 'Workspace Write' },
  { value: 'danger-full-access', name: 'Full Access' }, { value: 'auto', name: 'Auto Review' },
] }
const commands = [
  { name: 'goal', definitionId: '@deepseek-ai/dsh-command-goal', description: '目标', input: { hint: '目标文本' } },
  { name: 'compact', definitionId: '@deepseek-ai/dsh-command-compact', description: '压缩' },
  { name: 'accept-files', input: { attachments: true } },
]
const projection = { modelSelection: { next: { provider: 'actual-provider', model: 'actual-model', reasoningEffort: 'low' } }, permissions: { currentValue: 'read-only' }, goal: null }
function fixture(extra: Extra = {}) {
  const doc = new Document()
  const root = doc.createElement('div')
  function add(tag: string, id: string, className = ''): Element { const node = doc.createElement(tag); node.id = id; node.className = className; root.appendChild(node); return node }
  const input = add('textarea', 'input')
  const model = add('button', 'model-select')
  const permission = add('button', 'permission-select')
  const menu = add('div', 'input-menu')
  const goal = add('div', 'goal-dock')
  const send = add('button', 'send', 'send-btn')
  const command = add('button', 'command'); command.setAttribute('data-tool', 'command')
  const calls: Call[] = []
  const errors: string[] = []
  let session: { sessionId: string; address?: unknown } = { sessionId: 'session-a' }
  const catalogHandler: Handler = async (args) => ({ ok: true, kind: args.kind, catalog: args.kind === 'models' ? models : args.kind === 'permissions' ? permissions : commands })
  const controls = mountComposerControls({
    root, getSession: () => session,
    onCatalog: extra.onCatalog || catalogHandler,
    onSelectModel: extra.onSelectModel || (async (args: Call) => { calls.push(args); return { ok: true, selected: args } }),
    onCommand: extra.onCommand || (async (args: Call) => { calls.push(args); return { ok: true, matched: true } }),
    onReferences: extra.onReferences || (async () => ({ ok: true, files: [], sessions: [] })),
    onCancel: extra.onCancel || (async (args: Call) => { calls.push(args); return { ok: true, accepted: true } }),
    onGoal: extra.onGoal || (async (args: Call) => { calls.push(args); return { ok: true, goal: null } }),
    onRefresh: extra.onRefresh,
    onSubmit: extra.onSubmit,
    onError: (text: string) => { errors.push(text) },
  })
  controls.setSession(session)
  controls.setConnection('online')
  controls.setCapabilities(extra.channels ?? { controls: true })
  controls.setValues(projection)
  function changeSession(sessionId: string, address?: unknown): void { session = { sessionId, ...address ? { address } : {} }; controls.setSession(session) }
  function draft(value: string, caret = value.length): void { input.value = value; input.setSelectionRange(caret, caret); controls.handleInput() }
  function option(value: string): Element { const found = menu.querySelectorAll('.composer-menu-option').find((node) => node.getAttribute('data-value') === value); assert.ok(found, '菜单缺少选项：' + value); return found }
  return { controls, root, input, model, permission, menu, goal, send, command, calls, errors, changeSession, draft, option }
}

describe('DSH composer：目录与输入语法', () => {
  it('原版文件语法保留空格引号、目录开放引号，并拒绝不可表示的路径', () => {
    assert.equal(formatFileMention({ path: 'src/main.ts', kind: 'file' }), '@src/main.ts')
    assert.equal(formatFileMention({ path: 'design draft.md', kind: 'file' }), '@"design draft.md"')
    assert.equal(formatFileMention({ path: 'design draft', kind: 'directory' }), '@"design draft/')
    assert.equal(formatFileMention({ path: 'src', kind: 'directory' }), '@src/')
    assert.equal(formatFileMention({ path: 'src/main.ts', kind: 'file' }, true), '@"src/main.ts"')
    assert.equal(formatFileMention({ path: 'bad"name', kind: 'file' }), undefined)
    assert.equal(formatFileMention({ path: 'bad\nname', kind: 'file' }), undefined)
  })
  it('只匹配光标处的活跃 token；带引号文件查询可以含空格', () => {
    assert.deepEqual(inputTrigger('看 @"design draft'), { kind: 'references', start: 2, end: 16, query: 'design draft', quoted: true })
    assert.deepEqual(inputTrigger('/go'), { kind: 'commands', start: 0, end: 3, query: 'go', quoted: false })
    assert.equal(inputTrigger('看 @"done.md"'), null)
    assert.equal(inputTrigger('mail@example.com'), null)
    assert.equal(inputTrigger('正文 /goal'), null)
  })
  it('精确名称优先；中文别名只匹配原版 definitionId，不能越过作用域覆盖', () => {
    assert.equal(resolveCommand('目标', commands)?.name, 'goal')
    assert.equal(resolveCommand('目标', [{ name: '目标', definitionId: 'custom' }, ...commands])?.definitionId, 'custom')
    assert.equal(resolveCommand('目标', [{ name: 'goal', definitionId: 'custom' }]), undefined)
    assert.equal(resolveCommand('unknown', commands), undefined)
  })
  it('模型与等级显示真实目录名称；模型菜单有 root/model/effort 三个 pane', async () => {
    const f = fixture(); await settle()
    assert.match(f.model.textContent, /实际模型轻量/)
    f.model.click(); await settle()
    assert.equal(f.menu.getAttribute('data-pane'), 'root')
    f.option('model').click(); assert.equal(f.menu.getAttribute('data-pane'), 'model')
    assert.ok(f.menu.textContent.includes('第二模型'))
    const back = f.menu.querySelector('.composer-menu-back'); assert.ok(back); back.click()
    f.option('effort').click(); assert.equal(f.menu.getAttribute('data-pane'), 'effort')
    assert.ok(f.menu.textContent.includes('深入'))
    f.controls.dispose()
  })
  it('模型选择只在真实投影改变后更新显示，不把 pending 选择伪装成成功', async () => {
    const request = deferred<unknown>()
    const calls: Call[] = []
    const f = fixture({ onSelectModel: async (args) => { calls.push(args); return request.promise } }); await settle()
    f.model.click(); await settle(); f.option('effort').click(); f.option('high').click()
    assert.equal(f.model.disabled, true)
    assert.match(f.model.textContent, /轻量/)
    assert.deepEqual(calls, [{ sessionId: 'session-a', provider: 'actual-provider', model: 'actual-model', reasoningEffort: 'high' }])
    request.resolve({ ok: true, selected: calls[0] }); await settle()
    assert.match(f.model.textContent, /轻量/)
    f.controls.setValues({ ...projection, modelSelection: { next: { provider: 'actual-provider', model: 'actual-model', reasoningEffort: 'high' } } })
    assert.match(f.model.textContent, /深入/)
    f.controls.dispose()
  })
  it('模型切换失败保留原模型、显示真实错误并恢复可操作状态', async () => {
    const f = fixture({ onSelectModel: async () => ({ ok: false, error: { code: 'session/writer-held', message: '会话已被占用' } }) }); await settle()
    f.model.click(); await settle(); f.option('model').click(); f.option('actual-provider/second-model').click(); await settle()
    assert.equal(f.model.disabled, false)
    assert.match(f.model.textContent, /实际模型/)
    assert.match(f.menu.textContent, /session\/writer-held: 会话已被占用/)
    f.controls.dispose()
  })
  it('未提供实际目录时不产生模型选项；目录失败可重试', async () => {
    const f = fixture({ onCatalog: async (args) => { if (args.kind === 'models') throw new Error('目录服务缺失'); return { ok: true, catalog: permissions } } }); await settle()
    f.model.click(); await settle()
    assert.equal(f.menu.querySelectorAll('.composer-menu-option').length, 0)
    assert.match(f.menu.textContent, /目录服务缺失/)
    assert.ok(f.menu.querySelector('.composer-menu-retry'))
    f.controls.dispose()
  })
  it('旧会话目录迟到不得覆盖新会话模型；重连重新读取目录', async () => {
    const old = deferred<unknown>()
    let count = 0
    const f = fixture({ onCatalog: async (args) => {
      if (args.kind !== 'models') return { ok: true, catalog: permissions }
      count++
      if (args.sessionId === 'session-a') return old.promise
      return { ok: true, catalog: { ...models, groups: [{ id: 'b-provider', models: [{ id: 'b-model', name: '新会话模型' }] }] } }
    } })
    await settle(); f.changeSession('session-b')
    f.controls.setValues({ ...projection, modelSelection: { next: { provider: 'b-provider', model: 'b-model' } } }); await settle()
    old.resolve({ ok: true, catalog: models }); await settle()
    assert.equal(f.model.textContent.includes('新会话模型'), true)
    assert.equal(f.model.textContent.includes('实际模型'), false)
    assert.deepEqual(f.errors, [])
    const before = count; f.controls.setConnection('offline'); f.controls.setConnection('online'); await settle()
    assert.ok(count > before)
    f.controls.dispose()
  })
})

describe('DSH composer：权限、命令、引用和停止', () => {
  it('未获宿主 controls 能力时不请求目录或目标，保留旧 slash 插入入口', async () => {
    let directoryReads = 0
    const f = fixture({ channels: {}, onCatalog: async () => { directoryReads++; return { ok: true, catalog: models } } }); await settle()
    assert.equal(directoryReads, 0)
    assert.equal(f.calls.length, 0)
    assert.equal(f.model.hidden, true)
    assert.equal(f.permission.hidden, true)
    f.input.value = '原草稿'; f.command.click()
    assert.equal(f.input.value, '/原草稿')
    assert.equal(f.menu.hidden, true)
    assert.equal(await f.controls.handleSubmit({ text: '/goal 新控制尚未接通' }), false)
    f.controls.setRunning(true)
    assert.equal(f.send.disabled, true)
    assert.match(f.send.title, /退出并重开/)
    f.controls.dispose()
  })
  it('普通权限选项无需额外确认，真实命令回执前显示原权限', async () => {
    const f = fixture(); await settle(); f.permission.click(); await settle(); f.option('workspace-write').click(); await settle()
    assert.deepEqual(f.calls.filter((call) => call.line), [{ sessionId: 'session-a', line: '/permission workspace-write' }])
    assert.match(f.permission.textContent, /仅可查看/)
    assert.equal(f.menu.hidden, true)
    f.controls.dispose()
  })
  it('完全权限和 Auto review 只有勾选风险确认后才提交', async () => {
    for (const value of ['danger-full-access', 'auto']) {
      const f = fixture(); await settle(); f.permission.click(); await settle(); f.option(value).click()
      assert.equal(f.menu.getAttribute('role'), 'dialog')
      const confirm = f.menu.querySelector('.composer-risk-confirm'); assert.ok(confirm)
      assert.equal(confirm.disabled, true); confirm.click()
      assert.equal(f.calls.filter((call) => call.line).length, 0)
      const checkbox = f.menu.querySelector('.composer-risk-checkbox'); assert.ok(checkbox)
      checkbox.checked = true; checkbox.dispatchEvent(new UiEvent('change'))
      assert.equal(confirm.disabled, false); confirm.click(); await settle()
      assert.deepEqual(f.calls.filter((call) => call.line), [{ sessionId: 'session-a', line: '/permission ' + value }])
      f.controls.dispose()
    }
  })
  it('切换会话撤销风险确认，旧复选状态不能用于新会话', async () => {
    const f = fixture(); await settle(); f.permission.click(); await settle(); f.option('auto').click()
    f.changeSession('session-b'); f.controls.setValues(projection); await settle()
    assert.equal(f.menu.hidden, true)
    f.permission.click(); await settle(); f.option('auto').click()
    assert.equal(f.menu.querySelector('.composer-risk-confirm')?.disabled, true)
    f.controls.dispose()
  })
  it('命令提交使用被冻结的草稿，附件只交给声明支持附件的真实命令', async () => {
    const f = fixture(); await settle(); f.input.value = ''
    assert.equal(await f.controls.handleSubmit({ text: '/目标 做完任务' }), true)
    assert.equal(await f.controls.handleSubmit({ text: '/accept-files 图片', receiptIds: ['receipt-1'] }), true)
    assert.deepEqual(f.calls.filter((call) => call.line), [
      { sessionId: 'session-a', line: '/goal 做完任务' },
      { sessionId: 'session-a', line: '/accept-files 图片', receiptIds: ['receipt-1'] },
    ])
    await assert.rejects(f.controls.handleSubmit({ text: '/goal 做完任务', receiptIds: ['receipt-2'] }), /不接受附件/)
    assert.equal(f.calls.filter((call) => call.line).length, 2)
    f.controls.dispose()
  })
  it('目录加载失败必须阻止降级成普通消息；原版未知命令才返回 false', async () => {
    const f = fixture({ onCatalog: async (args) => { if (args.kind === 'commands') throw new Error('目录断开'); return { ok: true, catalog: args.kind === 'models' ? models : permissions } } }); await settle()
    await assert.rejects(f.controls.handleSubmit({ text: '/goal 继续' }), /目录断开/)
    assert.equal(f.calls.filter((call) => call.line).length, 0)
    f.controls.dispose()
    const good = fixture(); await settle()
    assert.equal(await good.controls.handleSubmit({ text: '/unknown 普通文字' }), false)
    assert.equal(await good.controls.handleSubmit({ text: '/compact 不属于 bare 参数' }), false)
    good.controls.dispose()
  })
  it('已匹配指令未被接纳或带附件的 handler 失败都抛错，不能消费附件', async () => {
    const f = fixture({ onCommand: async () => ({ ok: true, matched: false }) }); await settle()
    await assert.rejects(f.controls.handleSubmit({ text: '/goal 继续' }), /未被接纳/)
    f.controls.dispose()
    const failure = fixture({ onCommand: async () => ({ ok: true, matched: true, result: { kind: 'error', text: '附件命令失败' } }) }); await settle()
    await assert.rejects(failure.controls.handleSubmit({ text: '/accept-files 描述', receiptIds: ['receipt-1'] }), /附件命令失败/)
    failure.controls.dispose()
  })
  it('提交在等待目录时切换会话，旧提交抛错且绝不发到新会话', async () => {
    const response = deferred<unknown>()
    const f = fixture({ onCatalog: async (args) => args.kind === 'commands' ? response.promise : { ok: true, catalog: args.kind === 'models' ? models : permissions } }); await settle()
    const operation = f.controls.handleSubmit({ text: '/goal 旧任务' })
    const rejected = assert.rejects(operation, /会话已切换/)
    await settle(); f.changeSession('session-b'); response.resolve({ ok: true, catalog: commands }); await rejected
    assert.equal(f.calls.filter((call) => call.line).length, 0)
    f.controls.dispose()
  })
  it('从真实目录选择带参数命令只插入前缀，bare 命令委托主线原提交流程', async () => {
    let submits = 0
    const f = fixture({ onSubmit: () => { submits++ } }); await settle()
    f.draft('/go'); await settle(); f.option('goal').click()
    assert.equal(f.input.value, '/goal ')
    assert.equal(submits, 0)
    f.draft('/co'); await settle(); f.option('compact').click()
    assert.equal(submits, 1)
    assert.equal(f.input.value.trim(), '/compact')
    f.controls.dispose()
  })
  it('带引号的 @ 查询仅提供文件候选；引用插入采用真实 mention', async () => {
    const queries: Call[] = []
    const f = fixture({ onReferences: async (args) => {
      queries.push(args)
      return { ok: true, files: [{ kind: 'file', path: 'design draft.md' }, { kind: 'file', path: 'bad"name' }], sessions: [{ sessionId: 's-2', label: '另一会话', mention: '@session:actual-reference' }] }
    } }); await settle()
    f.draft('@"design'); await settle()
    assert.deepEqual(queries, [{ sessionId: 'session-a', query: 'design', quoted: true }])
    assert.equal(f.menu.textContent.includes('另一会话'), false)
    assert.equal(f.menu.querySelectorAll('.composer-menu-option').length, 1)
    f.option('@"design draft.md"').click()
    assert.equal(f.input.value, '@"design draft.md" ')
    f.draft('@'); await settle(); f.option('@session:actual-reference').click()
    assert.equal(f.input.value, '@session:actual-reference ')
    f.controls.dispose()
  })
  it('旧引用结果不污染新查询；目录选择继续向下钻取', async () => {
    const old = deferred<unknown>()
    const queries: Call[] = []
    const f = fixture({ onReferences: async (args) => {
      queries.push(args)
      if (args.query === 'old') return old.promise
      return { ok: true, files: [{ kind: 'directory', path: 'src' }], sessions: [] }
    } }); await settle()
    f.draft('@old'); await settle(); f.draft('@new'); await settle()
    old.resolve({ ok: true, files: [{ kind: 'file', path: 'wrong.txt' }], sessions: [] }); await settle()
    assert.equal(f.menu.textContent.includes('wrong.txt'), false)
    f.option('@src/').click(); await settle()
    assert.equal(f.input.value, '@src/')
    assert.equal(queries.at(-1)?.query, 'src/')
    f.controls.dispose()
  })
  it('停止按钮捕获 click、阻断普通提交，并使用真实子智能体地址', async () => {
    const f = fixture(); await settle()
    const address = { kind: 'subagent', parentSessionId: 'parent', childSessionId: 'child', mode: 'observe' }
    f.changeSession('child', address); f.controls.setValues(projection); f.controls.setRunning(true)
    let ordinaryClicks = 0
    f.send.addEventListener('click', () => { ordinaryClicks++ })
    const event = f.send.click(); await settle()
    assert.equal(event.defaultPrevented, true)
    assert.equal(event.immediateStopped, true)
    assert.equal(ordinaryClicks, 0)
    assert.equal(f.send.type, 'button')
    assert.deepEqual(f.calls.filter((call) => call.address), [{ sessionId: 'child', address }])
    assert.equal(f.model.hidden, true)
    assert.equal(f.permission.hidden, true)
    assert.equal(f.command.disabled, true)
    await assert.rejects(f.controls.handleSubmit({ text: '/goal 不允许' }), /子智能体/)
    f.controls.dispose()
  })
})

describe('DSH composer：目标投影和 CAS 操作', () => {
  it('目标为空或已完成时不画 dock；普通消息投影不重复查询目标', async () => {
    const f = fixture(); await settle()
    assert.equal(f.goal.hidden, true)
    const data = { goal: { id: 'g-1', revision: 1, objective: '完成任务', phase: 'active' } }
    f.controls.setValues({ ...projection, goal: data }); await settle()
    const reads = f.calls.filter((call) => call.action === 'get').length
    f.controls.setValues({ ...projection, goal: structuredClone(data), status: 'running' }); await settle()
    assert.equal(f.calls.filter((call) => call.action === 'get').length, reads)
    f.controls.setValues({ ...projection, goal: { goal: { ...data.goal, phase: 'complete' } } })
    assert.equal(f.goal.hidden, true)
    f.controls.dispose()
  })
  it('armed/disarmed 来自真实 get activation；pause/resume 使用当前 ref', async () => {
    const goal = { id: 'g-1', revision: 3, objective: '完成任务', phase: 'active' }
    const calls: Call[] = []
    let live = 'armed'
    const f = fixture({ onGoal: async (args) => { calls.push(args); return { ok: true, goal: { ...goal, activation: live } } } }); await settle()
    f.controls.setValues({ ...projection, goal: { goal } }); await settle()
    const pause = f.goal.querySelector('[data-goal-action="pause"]'); assert.ok(pause); pause.click(); await settle()
    assert.deepEqual(calls.find((call) => call.action === 'pause'), { sessionId: 'session-a', action: 'pause', ref: { id: 'g-1', revision: 3 } })
    live = 'disarmed'; f.controls.setRunning(true); await settle()
    assert.match(f.goal.textContent, /未运行的目标/)
    const resume = f.goal.querySelector('[data-goal-action="resume"]'); assert.ok(resume); resume.click(); await settle()
    assert.deepEqual(calls.find((call) => call.action === 'resume'), { sessionId: 'session-a', action: 'resume', ref: { id: 'g-1', revision: 3 } })
    f.controls.dispose()
  })
  it('编辑目标传 request/objective，失败保留编辑草稿，清除只在成功回执后隐藏', async () => {
    const goal = { id: 'g-1', revision: 3, objective: '完成任务', phase: 'paused' }
    const calls: Call[] = []
    const f = fixture({ onGoal: async (args) => {
      calls.push(args)
      if (args.action === 'edit') return { ok: false, error: { code: 'stale-goal', message: '目标已更新' } }
      return { ok: true, goal }
    } }); await settle(); f.controls.setValues({ ...projection, goal: { goal } }); await settle()
    const edit = f.goal.querySelector('[data-goal-action="edit"]'); assert.ok(edit); edit.click()
    const field = f.goal.querySelector('.goal-objective-input'); assert.ok(field); field.value = '新的目标'; field.dispatchEvent(new UiEvent('input'))
    const save = f.goal.querySelector('[aria-label="保存目标"]'); assert.ok(save); save.click(); await settle()
    assert.deepEqual(calls.find((call) => call.action === 'edit'), { sessionId: 'session-a', action: 'edit', ref: { id: 'g-1', revision: 3 }, request: { objective: '新的目标' } })
    assert.equal(f.goal.querySelector('.goal-objective-input')?.value, '新的目标')
    assert.match(f.goal.textContent, /目标已更新/)
    const cancel = f.goal.querySelector('[aria-label="取消编辑"]'); assert.ok(cancel); cancel.click()
    const clear = f.goal.querySelector('[data-goal-action="clear"]'); assert.ok(clear); clear.click(); await settle()
    assert.equal(f.goal.hidden, true)
    f.controls.dispose()
  })
  it('旧目标 get 不能覆盖新 revision 的 durable 投影', async () => {
    const old = deferred<unknown>()
    const f = fixture({ onGoal: async () => old.promise }); await settle()
    f.controls.setValues({ ...projection, goal: { goal: { id: 'g-1', revision: 4, objective: '最新目标', phase: 'paused' } } })
    old.resolve({ ok: true, goal: { id: 'g-1', revision: 3, objective: '旧目标', phase: 'active', activation: 'armed' } }); await settle()
    assert.equal(f.goal.textContent.includes('最新目标'), true)
    assert.equal(f.goal.textContent.includes('旧目标'), false)
    assert.equal(f.goal.querySelector('[data-goal-action="pause"]'), null)
    f.controls.dispose()
  })
})
