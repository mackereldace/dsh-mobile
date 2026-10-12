import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
// @ts-expect-error The mobile UI is a browser JavaScript module.
import { mountManagement } from '../assets/dsh-chat/management.js'

type Data = Record<string, any>
class Element {
  children: Element[] = []; parentElement: Element | null = null
  className = ''; id = ''; hidden = false; disabled = false; value = ''; checked = false; ownText = ''; type = ''
  attributes = new Map<string, string>(); listeners = new Map<string, Function[]>()
  readonly tagName: string; readonly ownerDocument: Document
  constructor(tagName: string, ownerDocument: Document) { this.tagName = tagName; this.ownerDocument = ownerDocument }
  get textContent(): string { return this.ownText + this.children.map(child => child.textContent).join('') }
  set textContent(text: string) { this.ownText = text }
  appendChild(child: Element) { child.parentElement = this; this.children.push(child); return child }
  replaceChildren() { this.children = [] }
  setAttribute(key: string, value: unknown) { this.attributes.set(key, String(value)) }
  getAttribute(key: string) { return this.attributes.get(key) ?? null }
  addEventListener(type: string, listener: Function) { this.listeners.set(type, [...this.listeners.get(type) ?? [], listener]) }
  matches(selector: string) { return selector.startsWith('#') ? this.id === selector.slice(1) : selector.startsWith('.') ? this.className.split(/\s+/).includes(selector.slice(1)) : this.tagName === selector }
  querySelectorAll(selector: string): Element[] { return this.children.flatMap(child => [...child.matches(selector) ? [child] : [], ...child.querySelectorAll(selector)]) }
  querySelector(selector: string) { return this.querySelectorAll(selector)[0] ?? null }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this) }
  focus() { this.ownerDocument.activeElement = this }
  fire(type: string) { for (const listener of this.listeners.get(type) ?? []) listener({ preventDefault() {} }) }
}
class Document {
  activeElement: Element | null = null; body = new Element('body', this)
  timers = new Map<number, Function>(); nextTimer = 0
  defaultView = { setTimeout: (callback: Function) => { const id = ++this.nextTimer; this.timers.set(id, callback); return id }, clearTimeout: (id: number) => { this.timers.delete(id) } }
  createElement(tag: string) { return new Element(tag, this) }
  querySelector(selector: string) { return this.body.querySelector(selector) }
  addEventListener() {}; removeEventListener() {}
  expire() { for (const [id, callback] of [...this.timers]) { this.timers.delete(id); callback() } }
}
const flush = async () => { await new Promise(resolve => setImmediate(resolve)) }
const deferred = () => { let resolve!: (data: Data) => void, reject!: (error: Error) => void; const promise = new Promise<Data>((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
function mounted() {
  const doc = new Document(), pending = deferred(), calls: { endpoint: string; args: Data }[] = []
  const values = new Map([['dsh', 'model-a'], ['codex', 'model-a']]); let revision = 1, failNext = false
  const data = (backend = 'dsh') => ({ ok: true, backend, fields: [{ id: 'model', label: '模型', type: 'select', value: values.get(backend), choices: [{ value: 'model-a', label: 'A' }, { value: 'model-b', label: 'B' }], writable: true, revision }] })
  const manager = mountManagement({ root: doc, backend: 'dsh', call: (endpoint: string, args: Data) => {
    calls.push({ endpoint, args })
    if (endpoint.endsWith('/capabilities')) return { ok: true, available: true }
    if (endpoint.endsWith('/write')) { if (failNext) { failNext = false; return Promise.reject(new Error('拒绝写入')) }; return pending.promise }
    return data(args.backend)
  } })
  const form = () => doc.querySelector('.management-field')!
  const submit = () => form().fire('submit')
  const edit = () => { const input = doc.querySelector('#management-field-model')!; input.value = '1'; input.fire('input') }
  const locked = () => form().querySelector('button')!.disabled
  return { doc, manager, calls, submit, edit, locked, fail: () => { failNext = true }, confirm: (value = 'model-b') => { values.set('dsh', value); revision++; pending.resolve(data()) } }
}

describe('mobile management write recovery', () => {
  it('late successful acknowledgement displays the actual readback even when the backend overrides the submitted value', async () => {
    const p = mounted()
    try {
      p.manager.open('settings'); await flush(); p.edit(); p.submit(); await flush(); p.doc.expire(); await flush()
      p.confirm('model-a'); await flush()
      assert.equal(p.locked(), false); assert.equal(p.doc.querySelector('#management-field-model')!.value, '0')
    } finally { p.manager.dispose() }
  })
  it('timed-out writes stay locked across retry, fresh reads and close/reopen until real settlement and readback', async () => {
    const p = mounted()
    try {
      p.manager.open('settings'); await flush(); p.edit(); p.submit(); await flush()
      p.doc.expire(); await flush(); assert.equal(p.manager.state().busy, false); assert.equal(p.locked(), true)
      p.submit(); assert.equal(p.calls.filter(call => call.endpoint.endsWith('/write')).length, 1)
      p.doc.body.querySelectorAll('button').find(button => button.textContent === '重新读取')!.fire('click'); await flush()
      assert.equal(p.locked(), true, 'reading before the operation settles must not allow another write')
      p.manager.close(); p.manager.open('settings'); await flush(); assert.equal(p.locked(), true)
      p.confirm(); await flush(); assert.equal(p.locked(), false)
      assert.equal(p.doc.querySelector('#management-field-model')!.value, '1')
      assert.ok(p.calls.filter(call => call.endpoint.endsWith('/read')).length >= 4, 'settlement must trigger an authoritative new read')
    } finally { p.manager.dispose() }
  })
  it('late acknowledgement from a timed-out backend cannot overwrite the new backend or lock it', async () => {
    const p = mounted()
    try {
      p.manager.open('settings'); await flush(); p.edit(); p.submit(); await flush(); p.doc.expire(); await flush()
      const backend = p.doc.querySelector('.management-backend')!.querySelector('select')!; backend.value = 'codex'; backend.fire('change'); await flush()
      assert.equal(p.locked(), false); assert.equal(p.doc.querySelector('#management-field-model')!.value, '0')
      p.confirm(); await flush()
      assert.equal(p.manager.state().backend, 'codex'); assert.equal(p.doc.querySelector('#management-field-model')!.value, '0'); assert.equal(p.locked(), false)
    } finally { p.manager.dispose() }
  })
  it('a confirmed failure preserves the edited field and allows a subsequent deliberate retry', async () => {
    const p = mounted()
    try {
      p.manager.open('settings'); await flush(); p.edit(); p.fail(); p.submit(); await flush()
      assert.equal(p.locked(), false); assert.equal(p.doc.querySelector('#management-field-model')!.value, '1')
      assert.ok(p.doc.querySelector('.management-error')!.textContent.includes('拒绝写入'))
      p.submit(); await flush(); assert.equal(p.calls.filter(call => call.endpoint.endsWith('/write')).length, 2)
      p.confirm(); await flush(); assert.equal(p.locked(), false)
    } finally { p.manager.dispose() }
  })
})
