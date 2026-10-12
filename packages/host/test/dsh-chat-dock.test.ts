import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { describe, it } from 'node:test'
import { createProjection } from '../assets/dsh-chat/projection.js'
// @ts-expect-error Browser JavaScript import; unrelated surface modules keep their real no-DOM guards.
import { mountStatistics } from '../assets/dsh-chat/stats.js'
// @ts-expect-error Browser JavaScript import.
import { mountMobileShell } from '../assets/dsh-chat/shell.js'

/** Exercise the real UI entry and approval bookkeeping; unrelated native views
 * are replaced at their import boundaries, each with its own behavior suite. */
class Element {
  className = ''; hidden = false; disabled = false; textContent = ''; dataset = {}; style = {}
  value = ''
  children: Element[] = []; parentElement: Element | null = null
  attributes = new Map<string, string>(); listeners = new Map<string, Function[]>()
  readonly tagName: string
  constructor(tagName: string) { this.tagName = tagName }
  setAttribute(name: string, value: unknown) { this.attributes.set(name, String(value)) }
  getAttribute(name: string) { return this.attributes.get(name) ?? null }
  appendChild(child: Element) { child.remove(); child.parentElement = this; this.children.push(child); return child }
  replaceChildren(...children: Element[]) { this.children.forEach(child => { child.parentElement = null }); this.children = []; children.forEach(child => this.appendChild(child)) }
  replaceWith(next: Element) { const parent = this.parentElement; if (!parent) return; const index = parent.children.indexOf(this); next.remove(); parent.children[index] = next; next.parentElement = parent; this.parentElement = null }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this); this.parentElement = null }
  matches(selector: string) {
    const parts = /^(?:\.([\w-]+))?(?:\[([^\]=]+)(?:=([^\]]+))?\])?$/.exec(selector)
    return !!parts && (!parts[1] || this.className.split(/\s+/).includes(parts[1])) && (!parts[2] || this.attributes.has(parts[2]) && (!parts[3] || this.getAttribute(parts[2]) === parts[3]))
  }
  querySelectorAll(selector: string): Element[] { return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]) }
  querySelector(selector: string) { return this.querySelectorAll(selector)[0] ?? null }
  closest(selector: string): Element | null { return this.matches(selector) ? this : this.parentElement?.closest(selector) ?? null }
  addEventListener(name: string, handler: Function) { this.listeners.set(name, [...this.listeners.get(name) ?? [], handler]) }
  async click() { for (const handler of this.listeners.get('click') ?? []) await handler({ preventDefault() {} }) }
}
type Data = Record<string, any>
const source = readFileSync(new URL('../assets/dsh-chat/ui.js', import.meta.url), 'utf8')
const idle = () => {}
const asked = (id = 'approval-1') => ({ seq: 1, time: 1, type: 'approval/asked', data: { id, toolName: 'bash', callId: 'call-1', reason: 'Run the fixture check' } })
const decided = (id = 'approval-1') => ({ seq: 2, time: 2, type: 'approval/decided', data: { id, outcome: 'allowed-once' } })
function mounted(answerApproval: (id: string, decision: string) => Promise<Data> = async () => ({ ok: true }), send?: Function) {
  const list = new Element('div'), dock = new Element('div'), form = new Element('form')
  const ids = new Map([['#messages', list], ['#interactions', dock], ['#composer', form]])
  const input = new Element('textarea'); if (send) ids.set('#input', input)
  const root = { querySelector: (selector: string) => ids.get(selector) ?? null }
  let sessions: Data[] = []
  const context: Data = {
    createProjection, mountStatistics, mountMobileShell, document: { createElement: (tag: string) => new Element(tag) }, console: { log: idle },
    mountNavigation: () => ({ setSessions: (next: Data[]) => (sessions = next), sessions: () => sessions, session: (id: string) => sessions.find(item => item.id === id), setValues: idle, dispose: idle }),
    mountConversation: () => ({ update: idle, limits: () => ({ drawn: 0 }), dispose: idle }),
    mountTrace: () => ({ show: idle, update: idle, count: () => 0, dispose: idle }),
    mountComposerControls: () => ({ setSession: idle, setValues: idle, setCapabilities: idle, setConnection: idle, setRunning: idle, handleSubmit: async () => false, dispose: idle }),
    icon: idle,
  }
  const entry = source.replace(/^import .+ from '.+'\n/gm, '').replace(/\bexport /g, '')
  runInNewContext(entry + '\nthis.mount = mountChat', context, { filename: 'real-chat-ui.js' })
  const page = context.mount({ root, answerApproval, send })
  page.setSessions([{ id: 's', title: 'Fixture' }], 's')
  return { page, list, dock, form, input }
}
const flush = async () => { await new Promise(resolve => setImmediate(resolve)) }

describe('native page approval dock integration', () => {
  it('pending sends only disable their own session and late failure restores that session draft', async () => {
    let rejectA!: (error: Error) => void, resolveB!: () => void
    const a = new Promise<void>((_, reject) => { rejectA = reject }), b = new Promise<void>(resolve => { resolveB = resolve })
    const sent: string[] = []
    const { page, form, input } = mounted(undefined, (_text: string, _receipts: unknown, target: Data) => { sent.push(target.sessionId); return target.sessionId === 's' ? a : b })
    const submit = () => form.listeners.get('submit')![0]!({ preventDefault() {} })
    try {
      page.setConnection('online'); input.value = 'A draft'
      const pendingA = submit(); await flush(); assert.equal(input.disabled, true)
      page.setSessions([{ id: 's' }, { id: 'b' }], 'b'); page.setConnection('online')
      assert.equal(input.disabled, false)
      input.value = 'B draft'; const pendingB = submit(); await flush(); assert.equal(input.disabled, true)
      rejectA(new Error('A failed')); await pendingA
      assert.equal(input.disabled, true, 'A settling must not unlock B while B is pending')
      resolveB(); await pendingB; assert.equal(input.disabled, false)
      page.setSessions([{ id: 's' }, { id: 'b' }], 's')
      assert.equal(input.value, 'A draft'); assert.equal(input.disabled, false)
      assert.deepEqual(sent, ['s', 'b'])
    } finally { page.dispose() }
  })
  it('attaches a pending approval to the dock once and enables it when the channel arrives', () => {
    const { page, dock, list, form } = mounted()
    try {
      page.handlers.onEvents([asked()])
      assert.equal(dock.querySelectorAll('.approval').length, 1)
      assert.equal(list.querySelectorAll('.approval').length, 0)
      assert.equal(dock.querySelectorAll('.approval-option').every(button => button.disabled), true)
      assert.equal(form.hidden, false)
      page.setChannels({ approval: true })
      assert.equal(form.hidden, true)
      assert.equal(dock.querySelectorAll('.approval-option').every(button => !button.disabled), true)
      page.handlers.onEvents([asked()])
      assert.equal(dock.querySelectorAll('.approval').length, 1)
    } finally { page.dispose() }
  })
  it('a later decision removes its card and restores the composer; replay cannot resurrect it', () => {
    const { page, dock, form } = mounted()
    try {
      page.setChannels({ approval: true }); page.handlers.onEvents([asked()]); page.handlers.onEvents([decided()])
      assert.equal(dock.children.length, 0); assert.equal(dock.hidden, true); assert.equal(form.hidden, false)
      page.handlers.onEvents([asked()]); assert.equal(dock.children.length, 0)
    } finally { page.dispose() }
  })
  it('out-of-order history containing the decision and request never takes over input', () => {
    const { page, dock, form } = mounted()
    try {
      page.setChannels({ approval: true }); page.handlers.onEvents([decided(), asked()])
      assert.equal(dock.children.length, 0); assert.equal(form.hidden, false)
    } finally { page.dispose() }
  })
  it('only an accepted approval receipt dismisses the pending card', async () => {
    let accepted = false
    const { page, dock, form } = mounted(async () => ({ ok: accepted }))
    try {
      page.setChannels({ approval: true }); page.handlers.onEvents([asked()])
      await dock.querySelectorAll('.approval-option')[0]!.click(); await flush()
      assert.equal(dock.querySelectorAll('.approval').length, 1)
      assert.equal(dock.querySelectorAll('.approval-option').every(button => !button.disabled), true)
      accepted = true
      await dock.querySelectorAll('.approval-option')[0]!.click(); await flush()
      assert.equal(dock.children.length, 0); assert.equal(form.hidden, false)
    } finally { page.dispose() }
  })
})
