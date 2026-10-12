import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { describe, it } from 'node:test'
// @ts-expect-error Browser JavaScript import; unrelated surface modules keep their real no-DOM guards.
import { createProjection } from '../assets/dsh-chat/projection.js'
// @ts-expect-error Browser JavaScript import.
import { mountStatistics } from '../assets/dsh-chat/stats.js'
// @ts-expect-error Browser JavaScript import.
import { mountMobileShell } from '../assets/dsh-chat/shell.js'

/**
 * 附件通道的**文案分层**（2026-10-12）。
 *
 * 这一层只回答一件事：附件进不去时，如实告诉用户**真实原因**，
 * 绝不把「还在初始化 / 暂时没问成」说成「请重装」，也不假装成功。
 * 跑的是真 ui.js，只把与本组无关的原生视图替换在它们的 import 边界上。
 */
class Element {
  className = ''; hidden = false; disabled = false; textContent = ''; dataset = {}; style = {}
  value = ''; title = ''
  children: Element[] = []; parentElement: Element | null = null
  attributes = new Map<string, string>(); listeners = new Map<string, Function[]>()
  readonly tagName: string
  constructor(tagName: string) { this.tagName = tagName }
  setAttribute(name: string, value: unknown) { this.attributes.set(name, String(value)) }
  getAttribute(name: string): string | null { return this.attributes.get(name) ?? null }
  appendChild(child: Element): Element { child.remove(); child.parentElement = this; this.children.push(child); return child }
  replaceChildren(...children: Element[]) { children.forEach(child => this.appendChild(child)) }
  remove(): void { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this); this.parentElement = null }
  matches(selector: string): boolean {
    const parts = /^(?:\.([\w-]+))?(?:\[([^\]=]+)(?:=([^\]]+))?\])?$/.exec(selector)
    return !!parts && (!parts[1] || this.className.split(/\s+/).includes(parts[1])) && (!parts[2] || this.attributes.has(parts[2]) && (parts[3] === undefined || this.attributes.get(parts[2]) === parts[3]))
  }
  querySelectorAll(selector: string): Element[] { return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]) }
  querySelector(selector: string): Element | null { return this.querySelectorAll(selector)[0] ?? null }
  addEventListener(name: string, handler: Function) { this.listeners.set(name, [...(this.listeners.get(name) ?? []), handler]) }
  async click() { for (const handler of this.listeners.get('click') ?? []) await handler({ preventDefault() {} }) }
}
type Data = Record<string, any>
const source = readFileSync(new URL('../assets/dsh-chat/ui.js', import.meta.url), 'utf8')
const idle = () => {}

function mounted() {
  const input = new Element('textarea'), attach = new Element('button')
  attach.setAttribute('data-tool', 'attach')
  const picker = new Element('input')
  const list = new Element('div'), dock = new Element('div'), form = new Element('form')
  const ids = new Map<string, Element>([
    ['#input', input], ['[data-tool=attach]', attach], ['#attachment-input', picker],
    ['#messages', list], ['#interactions', dock], ['#composer', form],
  ])
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
  const page = context.mount({ root, upload: async () => ({ ok: true }) })
  page.setSessions([{ id: 's', title: 'Fixture' }], 's')
  page.setConnection('online')
  return { page, attach, picker }
}
const off = { approval: false, question: false, upload: false, controls: false }
/** 文案里绝不能出现的「泛化重装/重启」建议。 */
const NO_REINSTALL = /重装|重新安装|重开|重启|退出并重开/

describe('附件通道：按真实状态分层，不猜也不劝重装', () => {
  it('探测没问成 ⇒ 说「暂时联系不上」，如实带上原因，不劝重装', () => {
    const { page, attach } = mounted()
    try {
      page.setChannels(off, { confirmed: false, probeError: '隧道还没就绪' })
      assert.match(attach.title, /暂时联系不上/)
      assert.match(attach.title, /隧道还没就绪/)
      assert.doesNotMatch(attach.title, NO_REINSTALL)
    } finally { page.dispose() }
  })

  it('还没确认过（初始化中）⇒ 说「正在确认」，绝不出现重装建议', () => {
    const { page, attach } = mounted()
    try {
      page.setChannels(off, { confirmed: false, probeError: '' })
      assert.match(attach.title, /正在确认/)
      assert.match(attach.title, /自动重查/)
      assert.doesNotMatch(attach.title, NO_REINSTALL)
    } finally { page.dispose() }
  })

  it('已确认仍未就绪且重试用尽 ⇒ 如实说未就绪，并给出「可重新检测」的出路', () => {
    const { page, attach } = mounted()
    try {
      page.setChannels(off, { confirmed: true, probeError: '', exhausted: true })
      assert.match(attach.title, /仍未就绪/)
      assert.match(attach.title, /重新检测/)
      assert.doesNotMatch(attach.title, NO_REINSTALL)
    } finally { page.dispose() }
  })

  it('已确认宿主没有该服务 ⇒ 如实呈现，不给泛化重装建议', () => {
    const { page, attach } = mounted()
    try {
      page.setChannels(off, { confirmed: true, probeError: '', exhausted: false })
      assert.match(attach.title, /没有提供附件服务/)
      assert.match(attach.title, /fileUploads/)
      assert.doesNotMatch(attach.title, NO_REINSTALL)
    } finally { page.dispose() }
  })

  it('已确认接通 ⇒ 不阻断；离线 ⇒ 说未连接（各归各的因，不混）', () => {
    const { page, attach } = mounted()
    try {
      page.setChannels({ approval: true, question: true, upload: true, controls: true }, { confirmed: true, probeError: '' })
      assert.equal(attach.title, '添加附件（单个≤20MiB）')
      page.setConnection('offline')
      assert.match(attach.title, /电脑尚未连接/)
    } finally { page.dispose() }
  })

  it('选择器在用户点击的同步调用栈里打开，绝不等通道探测', async () => {
    const { page, attach, picker } = mounted()
    let opened = 0
    picker.click = async () => { opened++ }
    try {
      // 通道尚未确认 ⇒ 当场挡住，绝不先 await 探测再点选择器（会把 click 推出手势栈）
      page.setChannels(off, { confirmed: false, probeError: '' })
      await attach.click()
      assert.equal(opened, 0, '未就绪时不该打开系统选择器')
      // 通道确认接通 ⇒ click 同步触发选择器（同栈，无 await）
      page.setChannels({ approval: true, question: true, upload: true, controls: true }, { confirmed: true, probeError: '' })
      await attach.click()
      assert.equal(opened, 1, '接通后必须在用户点击的同一调用栈里打开选择器')
    } finally { page.dispose() }
  })
})
