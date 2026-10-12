import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { describe, it } from 'node:test'

const source = readFileSync(process.env['DSHM_FILES_BOOT_SOURCE'] ?? new URL('../src/boot.js', import.meta.url), 'utf8')
type Data = Record<string, any>

/** Minimal DOM and deterministic clock; the entire production boot script runs unmodified. */
class Element {
  nodeType = 1; id = ''; className = ''; dataset: Data = {}; hidden = false; disabled = false; type = ''; title = ''; value = ''
  private text = ''; private html = ''
  children: Element[] = []; parentNode: Element | null = null
  attributes = new Map<string, string>(); listeners = new Map<string, Set<Function>>()
  style: Data = { setProperty(name: string, value: string) { this[name] = value }, getPropertyValue(name: string) { return this[name] ?? '' }, removeProperty(name: string) { delete this[name] } }
  classList = {
    add: (...names: string[]) => { this.className = [...new Set([...this.className.split(/\s+/).filter(Boolean), ...names])].join(' ') },
    remove: (...names: string[]) => { this.className = this.className.split(/\s+/).filter(name => !names.includes(name)).join(' ') },
    contains: (name: string) => this.className.split(/\s+/).includes(name),
    toggle: (name: string, on: boolean) => { if (on) this.classList.add(name); else this.classList.remove(name) },
  }
  readonly tagName: string
  constructor(tagName: string) { this.tagName = tagName }
  get textContent(): string { return this.text + this.children.map(child => child.textContent).join('') }
  set textContent(value: string) { this.replaceChildren(); this.text = String(value) }
  get innerHTML(): string { return this.html }
  set innerHTML(value: string) { this.replaceChildren(); this.html = String(value) }
  get parentElement() { return this.parentNode }
  get childNodes() { return this.children }
  get firstChild(): Element | null { return this.children[0] ?? null }
  get isConnected(): boolean { return this.tagName === 'html' || this.parentNode?.isConnected === true }
  appendChild(child: Element) { child.remove(); child.parentNode = this; this.children.push(child); return child }
  replaceChildren(...children: Element[]) { this.children.forEach(child => { child.parentNode = null }); this.children = []; this.text = ''; this.html = ''; children.forEach(child => this.appendChild(child)) }
  insertBefore(child: Element, before: Element | null) { child.remove(); child.parentNode = this; const index = before === null ? -1 : this.children.indexOf(before); if (index < 0) this.children.push(child); else this.children.splice(index, 0, child); return child }
  remove() { if (this.parentNode !== null) this.parentNode.children = this.parentNode.children.filter(child => child !== this); this.parentNode = null }
  setAttribute(name: string, value: unknown) { const text = String(value); this.attributes.set(name, text); if (name.startsWith('data-')) this.dataset[name.slice(5).replace(/-([a-z])/g, (_, char) => char.toUpperCase())] = text }
  getAttribute(name: string): string | null { if (name === 'id') return this.id || null; if (name.startsWith('data-')) return this.dataset[name.slice(5).replace(/-([a-z])/g, (_, char) => char.toUpperCase())] ?? null; return this.attributes.get(name) ?? null }
  hasAttribute(name: string) { return this.getAttribute(name) !== null }
  removeAttribute(name: string) { this.attributes.delete(name); if (name.startsWith('data-')) delete this.dataset[name.slice(5).replace(/-([a-z])/g, (_, char) => char.toUpperCase())] }
  matches(selector: string): boolean {
    if (selector === '*') return true
    if (selector.includes(',')) return selector.split(',').some(part => this.matches(part.trim()))
    const tokens = selector.match(/#[\w-]+|\.[\w-]+|\[[^\]]+\]|^[\w-]+/g)
    return tokens !== null && tokens.join('') === selector && tokens.every(token => {
      if (token.startsWith('#')) return this.id === token.slice(1)
      if (token.startsWith('.')) return this.classList.contains(token.slice(1))
      if (token.startsWith('[')) {
        const attr = /^\[([^=\]]+)(?:=["']?([^"'\]]*)["']?)?\]$/.exec(token)
        return attr !== null && (attr[2] === undefined ? this.hasAttribute(attr[1]!) : this.getAttribute(attr[1]!) === attr[2])
      }
      return this.tagName.toLowerCase() === token.toLowerCase()
    })
  }
  querySelectorAll(selector: string): Element[] { return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]) }
  querySelector(selector: string) { return this.querySelectorAll(selector)[0] ?? null }
  contains(node: Element): boolean { return node === this || this.children.some(child => child.contains(node)) }
  closest(selector: string): Element | null { return this.matches(selector) ? this : this.parentNode?.closest(selector) ?? null }
  addEventListener(type: string, handler: Function) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type)!.add(handler) }
  removeEventListener(type: string, handler: Function) { this.listeners.get(type)?.delete(handler) }
  dispatchEvent(event: Data) { for (const listener of this.listeners.get(event.type) ?? []) listener(event); return true }
  click() { this.dispatchEvent({ type: 'click', target: this, stopPropagation() {}, preventDefault() {} }) }
  getBoundingClientRect() { return { top: 0, left: 0, right: 412, bottom: 20, width: 412, height: 20 } }
  scrollIntoView() {}
  focus() {}
}

function deferred<T = any>() { let resolve!: (value: T) => void; let reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
function stream(read: Promise<Data>) {
  let returns = 0
  return { iterable: { [Symbol.asyncIterator]: () => ({ next: () => read, return: async () => { returns += 1; return { done: true } } }) }, returns: () => returns }
}
const baseline = (path = '/workspace', title = '工作区') => ({ done: false, value: { type: 'baseline', value: { items: [{ id: 'workspace-1', title, path }] } } })
const wire = (value: unknown) => ({ result: { ok: true, value } })
const flush = async () => { for (let i = 0; i < 16; i++) await Promise.resolve() }

function mounted(options: { shell?: Data; source?: string } = {}) {
  const html = new Element('html'), head = new Element('head'), body = new Element('body'), app = new Element('div')
  app.className = 'app'; html.appendChild(head); html.appendChild(body); body.appendChild(app)
  const timers = new Map<number, { run: () => void; ms: number }>(); const intervals = new Map<number, Function>(); let serial = 0
  const events: Data[] = []
  const document: Data = {
    readyState: 'loading', head, body, documentElement: html,
    createElement: (tag: string) => new Element(tag), createTextNode: (text: string) => { const node = new Element('#text'); node.textContent = text; return node },
    querySelector: (selector: string) => html.querySelector(selector), querySelectorAll: (selector: string) => html.querySelectorAll(selector), getElementById: (id: string) => html.querySelector('#' + id),
    addEventListener() {}, removeEventListener() {}, dispatchEvent: (event: Data) => { events.push(event); return true },
  }
  const storage = new Map<string, string>(), errors: string[] = []
  const sandbox: Data = {
    document, __DSH_MOBILE_NO_SHELL__: true, crypto: globalThis.crypto, TextEncoder, TextDecoder, URL, URLSearchParams, Headers, Request, Response, Blob,
    location: { pathname: '/mobile/chat', search: '', host: 'example.invalid', origin: 'https://example.invalid', protocol: 'https:', href: 'https://example.invalid/mobile/chat' },
    localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, String(value)), removeItem: (key: string) => storage.delete(key) },
    navigator: { userAgent: 'Fixture mobile' }, history: { replaceState() {} }, innerWidth: 412, innerHeight: 915,
    console: { info() {}, warn() {}, error: (...args: unknown[]) => errors.push(args.map(String).join(' ')), log() {} },
    atob: (value: string) => Buffer.from(value, 'base64').toString('binary'), btoa: (value: string) => Buffer.from(value, 'binary').toString('base64'),
    setTimeout: (run: () => void, ms: number) => { const id = ++serial; timers.set(id, { run, ms }); return id }, clearTimeout: (id: number) => timers.delete(id),
    setInterval: (run: Function) => { const id = ++serial; intervals.set(id, run); return id }, clearInterval: (id: number) => intervals.delete(id),
    requestAnimationFrame: () => ++serial, cancelAnimationFrame() {},
    MutationObserver: class { observe() {} disconnect() {} },
    CustomEvent: class { type: string; options: Data; constructor(type: string, options: Data) { this.type = type; this.options = options } get detail() { return this.options.detail } },
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }), addEventListener() {}, removeEventListener() {},
    getComputedStyle: () => ({ getPropertyValue: () => '', display: 'block' }), performance: globalThis.performance,
    fetch: async () => new Response('{}', { status: 200 }), ...(options.shell === undefined ? {} : { DshmShell: options.shell }),
  }
  sandbox.globalThis = sandbox; sandbox.window = sandbox; sandbox.self = sandbox
  runInNewContext(options.source ?? source, sandbox, { filename: 'production-boot.js' })
  assert.ok(sandbox.__DSH_MOBILE_BOOT__, 'the complete production boot must expose its API')
  const api: Data = sandbox.__DSH_MOBILE_BOOT__
  return {
    api, html, head, body, app, events, errors, sandbox, timers, intervals,
    pane: () => body.querySelector('#dsh-mobile-sheet')!, contents: () => body.querySelector('#dsh-mobile-sheet-body')!,
    deadlines: () => [...timers].filter(([, timer]) => timer.ms === 10000),
    expireReads() { for (const [id, timer] of [...timers]) { if (timer.ms === 10000) { timers.delete(id); timer.run() } } },
  }
}

function connected(page: ReturnType<typeof mounted>, options: { read?: Promise<Data>; rpc?: (endpoint: string, payload: Data) => Promise<Data> } = {}) {
  const follow = stream(options.read ?? Promise.resolve(baseline()))
  const calls: Array<{ endpoint: string; payload: Data }> = []
  page.api.tunnel = {
    openStream(endpoint: string, payload: Data) { calls.push({ endpoint, payload }); return follow.iterable },
    rpc(endpoint: string, payload: Data) {
      calls.push({ endpoint, payload })
      if (options.rpc !== undefined) return options.rpc(endpoint, payload)
      return Promise.resolve(wire(endpoint === 'mobile/files/list' ? { path: payload.args.path, parent: null, entries: [] } : { items: [] }))
    },
  }
  return { follow, calls }
}

describe('standalone conversation files use the production boot and visible portal', { timeout: 3000 }, () => {
  it('opens synchronously outside the transformed app and cancels the baseline exactly once on close', async () => {
    const page = mounted(), pending = deferred<Data>(), { follow } = connected(page, { read: pending.promise })
    const loading = page.api.openFiles('/workspace')
    assert.ok(page.pane(), 'the file pane must exist under the visible document body')
    assert.equal(page.pane().parentNode, page.body)
    assert.equal(page.head.contains(page.pane()), false)
    assert.equal(page.app.contains(page.pane()), false)
    assert.equal(page.api.filesOpen(), true)
    assert.equal(page.body.dataset.dshmFiles, 'open')
    assert.match(page.contents().textContent, /读取工作区/)
    page.pane().querySelector('#dsh-mobile-sheet-close')!.click()
    await flush()
    assert.equal(follow.returns(), 1)
    assert.equal(page.deadlines().length, 0)
    await loading
    assert.equal(page.api.filesOpen(), false)
    assert.equal(page.body.dataset.dshmFiles, undefined)
    assert.equal(follow.returns(), 1)
    assert.deepEqual(page.events.filter(event => event.type === 'dshm:files-state').map(event => event.detail.open), [true, false])
    assert.equal(page.deadlines().length, 0)
    pending.resolve(baseline('/late', '迟到工作区')); await flush()
    assert.equal(page.api.filesOpen(), false)
    assert.equal(page.contents().textContent.includes('迟到工作区'), false)
  })

  it('missing tunnel and baseline errors show retry and stay closeable', async () => {
    const page = mounted()
    await page.api.openFiles()
    assert.match(page.contents().textContent, /尚未连接/)
    const retry = page.contents().querySelector('[data-dshm-files-retry="1"]')!
    assert.ok(retry)
    connected(page); retry.click(); await flush()
    assert.match(page.contents().textContent, /工作区/)
    assert.equal(page.api.filesBack(), true)
    assert.equal(page.api.filesOpen(), false)
    const failed = Promise.reject(new Error('会话权限不足')); connected(page, { read: failed })
    await page.api.openFiles()
    assert.match(page.contents().textContent, /会话权限不足/)
    assert.ok(page.contents().querySelector('[data-dshm-files-retry="1"]'))
    assert.equal(page.api.closeFiles(), true)
    assert.equal(page.api.closeFiles(), false)
  })

  it('a baseline that never arrives becomes a ten-second error with retry and stream cancellation', async () => {
    const page = mounted(), pending = deferred<Data>(), { follow } = connected(page, { read: pending.promise })
    const loading = page.api.openFiles()
    assert.equal(page.deadlines().length, 1)
    page.expireReads(); await loading
    assert.match(page.contents().textContent, /超过 10 秒/)
    assert.ok(page.contents().querySelector('[data-dshm-files-retry="1"]'))
    assert.equal(follow.returns(), 1)
    assert.equal(page.api.filesOpen(), true)
    assert.equal(page.api.closeFiles(), true)
  })

  it('opening a new target discards the old baseline and late records', async () => {
    const page = mounted(), old = deferred<Data>(), previous = connected(page, { read: old.promise })
    const first = page.api.openFiles('/old')
    const next = connected(page, { read: Promise.resolve(baseline('/new', '新工作区')) })
    const second = page.api.openFiles('/new')
    await Promise.all([first, second]); await flush()
    assert.equal(previous.follow.returns(), 1)
    assert.equal(next.follow.returns(), 1)
    const content = page.contents().textContent
    old.resolve(baseline('/old', '旧工作区')); await flush()
    assert.equal(page.contents().textContent, content)
    assert.equal(next.calls.find(call => call.endpoint === 'mobile/files/list')?.payload.args.path, '/new')
    page.api.closeFiles()
  })

  it('a settled baseline awaiting its next microtask cannot write into the next target', async () => {
    const page = mounted()
    connected(page, { read: Promise.resolve({ done: false, value: { type: 'baseline', value: { items: [] } } }) })
    const first = page.api.openFiles('/old')
    // Stop after the read settles but before the async entrance resumes its DOM work.
    for (let index = 0; index < 12 && page.deadlines().length > 0; index++) await Promise.resolve()
    assert.equal(page.deadlines().length, 0)
    assert.match(page.contents().textContent, /读取工作区/)
    const next = deferred<Data>(); connected(page, { read: next.promise })
    const second = page.api.openFiles('/new')
    await first
    assert.match(page.contents().textContent, /读取工作区/)
    assert.equal(page.contents().textContent.includes('还没有工作区'), false)
    page.api.closeFiles(); await second
    next.resolve(baseline('/new')); await flush()
  })

  it('directory reads time out, stop the loading clock, and can retry without closing the pane', async () => {
    const page = mounted(), listing = deferred<Data>(); let count = 0
    connected(page, { rpc: async endpoint => {
      if (endpoint === 'mobile/files/list') { count += 1; return count === 1 ? listing.promise : wire({ path: '/workspace', parent: null, entries: [{ name: '重试成功.txt', type: 'file', size: 5 }] }) }
      return wire({ items: [] })
    } })
    await page.api.openFiles('/workspace'); await flush()
    const activeIntervals = page.intervals.size
    assert.ok(page.contents().querySelector('[data-dshm-loading="1"]'))
    page.expireReads(); await flush()
    assert.match(page.contents().textContent, /超过 10 秒/)
    assert.equal(page.intervals.size, activeIntervals - 1)
    page.contents().querySelector('[data-dshm-files-retry="1"]')!.click(); await flush()
    assert.ok(page.contents().querySelector('[data-dshm-fs-name="重试成功.txt"]'))
    assert.equal(page.api.filesOpen(), true)
    page.api.closeFiles()
    listing.resolve(wire({ path: '/old', entries: [{ name: '迟到.txt', type: 'file' }] })); await flush()
    assert.equal(page.contents().querySelector('[data-dshm-fs-name="迟到.txt"]'), null)
  })

  it('late directory results cannot replace the newly opened session directory', async () => {
    const page = mounted(), oldDirectory = deferred<Data>()
    connected(page, { read: Promise.resolve(baseline('/old')), rpc: async endpoint => endpoint === 'mobile/files/list' ? oldDirectory.promise : wire({ items: [] }) })
    await page.api.openFiles('/old'); await flush()
    connected(page, { read: Promise.resolve(baseline('/new')), rpc: async endpoint => wire(endpoint === 'mobile/files/list'
      ? { path: '/new', parent: null, entries: [{ name: 'current.txt', type: 'file', size: 2 }] } : { items: [] }) })
    await page.api.openFiles('/new'); await flush()
    assert.ok(page.contents().querySelector('[data-dshm-fs-name="current.txt"]'))
    oldDirectory.resolve(wire({ path: '/old', parent: null, entries: [{ name: 'stale.txt', type: 'file', size: 2 }] })); await flush()
    assert.ok(page.contents().querySelector('[data-dshm-fs-name="current.txt"]'))
    assert.equal(page.contents().querySelector('[data-dshm-fs-name="stale.txt"]'), null)
    page.api.closeFiles()
  })

  it('file read timeout presents retry, and leaving preview prevents late content from replacing the list', async () => {
    const page = mounted(), file = deferred<Data>(); let readCalls = 0
    connected(page, { rpc: async (endpoint, payload) => {
      if (endpoint === 'mobile/files/read') { readCalls += 1; return readCalls === 1 ? file.promise : wire({ data: Buffer.from('retried').toString('base64'), size: 7, eof: true }) }
      return wire(endpoint === 'mobile/files/list' ? { path: payload.args.path, parent: null, entries: [{ name: 'note.txt', type: 'file', size: 7 }] } : { items: [] })
    } })
    await page.api.openFiles('/workspace'); await flush()
    page.contents().querySelector('.dshm-file-head')!.click(); await flush()
    assert.equal(page.deadlines().length, 1)
    page.expireReads(); await flush()
    assert.match(page.contents().textContent, /超过 10 秒/)
    page.contents().querySelector('.dshm-preview-host')!.querySelectorAll('button').find(button => button.textContent === '重试')!.click(); await flush()
    assert.equal(page.contents().querySelector('[data-dshm-preview="text"]')!.textContent, 'retried')
    page.api.filesBack(); await flush()
    file.resolve(wire({ data: Buffer.from('stale body').toString('base64'), size: 10, eof: true })); await flush()
    assert.equal(page.contents().querySelector('[data-dshm-preview="text"]'), null)
    assert.equal(page.contents().textContent.includes('stale body'), false)
    page.api.closeFiles()
  })

  it('an unavailable optional opening-apps catalog cannot freeze directory access', async () => {
    const page = mounted(), apps = deferred<Data>()
    connected(page, { rpc: async (endpoint, payload) => endpoint === 'mobile/openInApp/apps' ? apps.promise : wire({ path: payload.args.path, parent: null, entries: [{ name: 'available.txt', type: 'file', size: 1 }] }) })
    const loading = page.api.openFiles('/workspace'); await flush()
    assert.equal(page.deadlines().length, 1)
    page.expireReads(); await loading; await flush()
    assert.ok(page.contents().querySelector('[data-dshm-fs-name="available.txt"]'))
    assert.equal(page.api.closeFiles(), true)
  })

  it('file preview, capabilities, root directory, and workspace list retain their back hierarchy', async () => {
    const page = mounted()
    const link = connected(page, { rpc: async (endpoint, payload) => wire(endpoint === 'mobile/files/list'
      ? { path: payload.args.path, parent: payload.args.path === '/workspace/sub' ? '/workspace' : null, entries: [{ name: 'note.txt', type: 'file', size: 4 }] }
      : endpoint === 'mobile/files/read' ? { data: Buffer.from('note').toString('base64'), size: 4, eof: true } : { items: [] }) })
    await page.api.openFiles('/workspace/sub'); await flush()
    page.contents().querySelector('[data-dshm-fs-name="note.txt"]')!.querySelector('.dshm-file-head')!.click(); await flush()
    assert.ok(page.contents().querySelector('[data-dshm-preview="text"]'))
    assert.equal(page.api.filesBack(), true); await flush()
    assert.equal(link.calls.filter(call => call.endpoint === 'mobile/files/list').at(-1)?.payload.args.path, '/workspace/sub')
    page.pane().querySelector('#dshm-conn-entry')!.click()
    assert.match(page.pane().querySelector('.dshm-sheet-title')!.textContent, /端侧能力/)
    assert.equal(page.api.filesBack(), true); await flush()
    assert.equal(link.calls.filter(call => call.endpoint === 'mobile/files/list').at(-1)?.payload.args.path, '/workspace/sub')
    assert.equal(page.api.filesBack(), true); await flush() // parent directory
    assert.equal(page.api.filesBack(), true); await flush() // root to workspace list
    assert.ok(page.contents().querySelector('.dshm-ws-name'))
    assert.equal(page.api.filesOpen(), true)
    assert.equal(page.api.filesBack(), true)
    assert.equal(page.api.filesOpen(), false)
  })

  it('connection settings reuse the existing renderer and release mounted content', () => {
    const page = mounted(), container = new Element('section'); page.body.appendChild(container)
    const cleanup = page.api.mountConnectionSettings(container)
    assert.equal(container.classList.contains('dshm-conn-body'), true)
    assert.equal(container.getAttribute('data-dshm-conn'), '1')
    assert.match(container.textContent, /端侧能力/)
    assert.match(container.textContent, /当前地址/)
    assert.match(container.textContent, /解除配对/)
    assert.equal(container.querySelectorAll('[role="switch"]').length >= 5, true)
    cleanup(); assert.equal(container.childNodes.length, 0)
  })

  it('NO_SHELL delegates native back to the page without a React shell or persistent listeners', async () => {
    const reports: boolean[] = []
    const page = mounted({ shell: { version: () => 'fixture-BUILD-1', setBackAvailable: (available: boolean) => reports.push(available) } })
    let available = true, calls = 0
    page.api.setNavigationHandlers({ available: () => available, back: () => { calls += 1; available = false; return true } })
    assert.equal(typeof page.sandbox.__dshmBack, 'function')
    assert.equal(page.api.apk.backAvailable(), true)
    assert.equal(page.sandbox.__dshmBack(), true)
    assert.equal(calls, 1)
    assert.equal(reports.at(-1), false)
    assert.equal(page.body.querySelector('#dsh-mobile-nav'), null)
    page.api.setNavigationHandlers(null)
    assert.equal(page.sandbox.__dshmBack(), false)
    connected(page); await page.api.openFiles()
    assert.equal(page.api.apk.backAvailable(), true)
    assert.equal(page.sandbox.__dshmBack(), true)
    assert.equal(page.api.filesOpen(), false)
    assert.equal(reports.at(-1), false)
  })
})
