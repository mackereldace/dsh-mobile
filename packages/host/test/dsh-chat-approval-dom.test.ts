/**
 * 会话页**审批卡的行为** ✓（不是"按钮画出来了"✗ —— 那是假判据 ✓）。
 *
 * ## 为什么非要一个小假 DOM ✗
 *
 * 这条单里被点名的**第二条断链**就在渲染那一步 ✓：
 * `renderEvent` 里 `toApprovalViewModel(event, null)` **硬编码了 `null`** ✗
 * ⇒ "已经裁决过就不再给按钮"这条规则**从来没生效过** ✓
 * （纯函数 `toApprovalViewModel` 本身是对的 ✓ —— 所以只测纯函数**永远看不出这个错** ✓）。
 * ⇒ 只能把 `renderEvent` 真的跑一遍、**按 DOM 问它** ✓。
 *
 * ★ 这里不引 jsdom ✗（本仓 devDependencies 里没有 ✓，也不该为一条判据加一个重依赖 ✓）——
 *   只实现这一条路真正用到的那几个方法 ✓（`createElement` / `appendChild` /
 *   `setAttribute` / `textContent` / `querySelector(All)` / `addEventListener` ✓）。
 *   它**只**服务于这几条断言 ✓，不是个通用 DOM ✓。
 */

import assert from 'node:assert/strict'
import { describe, it, before, after } from 'node:test'

/** 极小的元素替身 ✓（只够跑审批卡那一条路 ✓）。 */
class FakeElement {
  tagName: string
  className = ''
  textContent = ''
  children: FakeElement[] = []
  parentElement: FakeElement | null = null
  attributes = new Map<string, string>()
  listeners: { type: string; handler: () => void }[] = []
  /** ★ 按钮的置灰位 ✓（`approvalCard` 会写它 ✓ —— 判据直接读它 ✓）。 */
  disabled = false
  constructor(tag: string) {
    this.tagName = tag
  }
  setAttribute(name: string, value: unknown): void {
    this.attributes.set(name, String(value))
  }
  getAttribute(name: string): string | null {
    return this.attributes.has(name) ? (this.attributes.get(name) as string) : null
  }
  appendChild(child: FakeElement): FakeElement {
    child.parentElement = this
    this.children.push(child)
    return child
  }
  replaceWith(next: FakeElement): void {
    const parent = this.parentElement
    if (parent === null) return
    const at = parent.children.indexOf(this)
    if (at >= 0) parent.children[at] = next
    next.parentElement = parent
    this.parentElement = null
  }
  addEventListener(type: string, handler: () => void): void {
    this.listeners.push({ type, handler })
  }
  click(): void {
    for (const listener of this.listeners) if (listener.type === 'click') listener.handler()
  }
  /** 后代里按"类名（+可选属性）"找 ✓（只支持 `.<class>` 与 `.<class>[<attr>]` ✓）。 */
  querySelectorAll(selector: string): FakeElement[] {
    const out: FakeElement[] = []
    const walk = (node: FakeElement): void => {
      for (const child of node.children) {
        if (matches(child, selector)) out.push(child)
        walk(child)
      }
    }
    walk(this)
    return out
  }
  querySelector(selector: string): FakeElement | null {
    const all = this.querySelectorAll(selector)
    return all.length > 0 ? (all[0] as FakeElement) : null
  }
  closest(selector: string): FakeElement | null {
    let node: FakeElement | null = this
    while (node !== null) {
      if (matches(node, selector)) return node
      node = node.parentElement
    }
    return null
  }
}

/** 选择器匹配 ✓（`.<class>` / `.<class>[<attr>]` 两种 ✓）。 */
function matches(element: FakeElement, selector: string): boolean {
  const attr = /\[([^\]]+)\]/.exec(selector)
  const cls = selector.replace(/\[[^\]]+\]/, '').replace(/^\./, '')
  const classes = String(element.className).split(/\s+/)
  if (!classes.includes(cls)) return false
  if (attr === null) return true
  return element.getAttribute(attr[1] as string) !== null
}

/** `document` 只有这一条替身 ✓（`globalThis` 上没有 `document` 的类型 ✓ —— 显式给形状 ✓）。 */
const globalWithDocument = globalThis as unknown as { document?: unknown }
let savedDocument: unknown

before(() => {
  savedDocument = globalWithDocument.document
  globalWithDocument.document = { createElement: (tag: string): FakeElement => new FakeElement(tag) }
})

after(() => {
  globalWithDocument.document = savedDocument
})

const { renderEvent } = await import('../assets/dsh-chat/ui.js')

/** DSH 真形状的一条 `approval/asked` ✓（`dsh-user-approval/lib/index.js:132-137` ✓）。 */
const askedEvent = (id = 'ap-1') => ({
  seq: 1,
  type: 'approval/asked',
  data: { id, toolName: 'bash', callId: 'call-1', reason: '需要越权读一个只读文件' },
})

/** 真形状的一条 `approval/decided` ✓（`:139-142`：`{id, outcome}` ✓）。 */
const decidedEvent = (id = 'ap-1', outcome = 'allowed-once') => ({
  seq: 2,
  type: 'approval/decided',
  data: { id, outcome },
})

/** 画一张卡用的上下文 ✓（与 `mountChat` 里那份同形 ✓）。 */
interface ApprovalContextInput {
  readonly channelConnected?: boolean
  readonly answer?: (requestId: string, decision: string) => Promise<unknown>
  readonly decidedBy?: Record<string, unknown>
}
const context = (input: ApprovalContextInput = {}) => ({
  channelConnected: input.channelConnected === true,
  answer: input.answer,
  decidedFor: (event: { data?: { id?: string } } | null) =>
    input.decidedBy === undefined || event === null ? undefined : input.decidedBy[String(event.data?.id)],
})

/**
 * 画一张卡并取出卡本身 ✓（**断言它真的画出来了** ✓ —— 帮测试省掉一层判空 ✓）。
 * ★ 这里必须 `as FakeElement` ✗：`ui.js` 是个没有 `.d.ts` 的浏览器资产 ✓
 *   （本仓既有测试同样是 `implicitly has an 'any' type` ✓）⇒ 形状只能在这里**声明** ✓。
 */
/** 按下标取（本仓开了 `noUncheckedIndexedAccess` ✓ ⇒ 取值要显式断言存在 ✓）。 */
const nth = (list: FakeElement[], index: number): FakeElement => {
  const value = list[index]
  assert.ok(value !== undefined)
  return value
}

const cardOf = (event: unknown, ctx: unknown): FakeElement => {
  const wrapper = renderEvent(event, ctx) as FakeElement | null
  assert.ok(wrapper !== null)
  const card = wrapper.querySelector('.approval')
  assert.ok(card !== null)
  return card
}

describe('★★ 审批卡：按 DOM 问它行为（不是"按钮画出来了"）', () => {
  it('★ 记账事件（approval/decided）**不画卡**（否则同一件事凭空多一张）', () => {
    assert.equal(renderEvent(decidedEvent(), context()), null)
    assert.equal(renderEvent({ seq: 3, type: 'approval/policy', data: { policy: 'never' } }, context()), null)
  })

  it('★★ 两颗按钮的 decision 就是封闭词汇里那两个（页面不许自造词）', () => {
    const card = cardOf(askedEvent(), context({ channelConnected: true }))
    const buttons = card.querySelectorAll('.approval-option')
    assert.deepEqual(
      buttons.map((button) => button.getAttribute('data-decision')),
      ['rejected', 'allowed-once'],
    )
    assert.deepEqual(
      buttons.map((button) => button.textContent),
      ['拒绝', '允许一次'],
    )
    // ★★ 不许出现任何"总是允许"那一类词 ✗
    for (const button of buttons) {
      assert.ok(['rejected', 'allowed-once'].includes(String(button.getAttribute('data-decision'))))
    }
  })

  it('★★ 通道没接通 ⇒ 两颗都置灰 + 说清理由（不假装能用）', () => {
    const card = cardOf(askedEvent(), context({ channelConnected: false }))
    const buttons = card.querySelectorAll('.approval-option')
    assert.equal(buttons.length, 2)
    for (const button of buttons) assert.equal(button.disabled, true)
    assert.ok(card.querySelector('.approval-why') !== null)
  })

  it('★★ 通道接通 ⇒ 可点（且点下去真的打到 answer）', async () => {
    const calls: [string, string][] = []
    const card = cardOf(
      askedEvent(),
      context({ channelConnected: true, answer: (requestId: string, decision: string) => {
        calls.push([requestId, decision])
        return Promise.resolve({ ok: true, outcome: decision })
      } }),
    )
    const buttons = card.querySelectorAll('.approval-option')
    for (const button of buttons) assert.equal(button.disabled, false)
    nth(buttons, 1).click()
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.deepEqual(calls, [['ap-1', 'allowed-once']])
  })

  /**
   * ★★ 这条钉的就是**硬编码 `null`** 那条断链 ✗：
   * 变异：把 `renderEvent` 里的 `decidedEventFor(context, event)` 改回 `null` ⇒
   * 下面**当场变红** ✓（"已经裁决过还给按钮"正是它造成的 ✓）。
   */
  it('★★ 已经裁决过 ⇒ **一颗按钮都不给** + 标题写出结果', () => {
    const decided = decidedEvent('ap-1', 'allowed-once')
    const card = cardOf(askedEvent('ap-1'), context({
      channelConnected: true,
      decidedBy: { 'ap-1': decided },
    }))
    assert.equal(card.querySelectorAll('.approval-option').length, 0)
    const title = card.querySelector('.approval-title')
    assert.ok(title !== null)
    assert.ok(title.textContent.includes('allowed-once'))
  })

  it('★ 裁决的是**另一条**请求 ⇒ 这张卡照样给按钮（不许张冠李戴）', () => {
    const other = decidedEvent('ap-9', 'rejected')
    const card = cardOf(askedEvent('ap-1'), context({
      channelConnected: true,
      decidedBy: { 'ap-1': undefined, 'ap-9': other },
    }))
    assert.equal(card.querySelectorAll('.approval-option').length, 2)
  })

  it('★ 认不出 id ⇒ 不给按钮、把原文摊开（看不懂就什么都不做 ✗）', () => {
    const card = cardOf({ seq: 1, type: 'approval/asked', data: { toolName: 'bash' } }, context({ channelConnected: true }))
    assert.equal(card.querySelectorAll('.approval-option').length, 0)
    assert.ok(card.querySelector('.approval-raw') !== null)
  })

  it('★ 按下去之后**立刻置灰**（同一次审批不许提交两次）', async () => {
    const card = cardOf(
      askedEvent(),
      context({ channelConnected: true, answer: () => Promise.resolve({ ok: true, outcome: 'rejected' }) }),
    )
    const buttons = card.querySelectorAll('.approval-option')
    nth(buttons, 0).click()
    for (const button of buttons) assert.equal(button.disabled, true)
    await new Promise((resolve) => setTimeout(resolve, 0))
  })

  /**
   * ★★ 宿主回话里 `ok:false` 的意思是"这一下没落到任何在等的请求上" ✓
   * ⇒ 页面**必须说出来** ✗（显示成"已处理"就是在撒谎 ✓）。
   * 变异：把 `answerApproval` 里的分支改成无条件写"已提交" ⇒ 这条当场变红 ✓。
   */
  it('★★ 落空（重复点/已超时）⇒ 卡片上写出"没落到任何在等的审批上"', async () => {
    const card = cardOf(
      askedEvent(),
      context({ channelConnected: true, answer: () => Promise.resolve({ ok: false, outcome: null }) }),
    )
    nth(card.querySelectorAll('.approval-option'), 1).click()
    await new Promise((resolve) => setTimeout(resolve, 0))
    const lines = card.querySelectorAll('.approval-why').map((node: FakeElement) => node.textContent)
    assert.ok(lines.some((line) => line.includes('没落到任何在等的审批上')))
  })

  it('★ 提交失败（抛）⇒ 也说出来（一个安静的按钮最坏）', async () => {
    const card = cardOf(
      askedEvent(),
      context({ channelConnected: true, answer: () => Promise.reject(new Error('隧道断了')) }),
    )
    nth(card.querySelectorAll('.approval-option'), 0).click()
    await new Promise((resolve) => setTimeout(resolve, 0))
    const lines = card.querySelectorAll('.approval-why').map((node: FakeElement) => node.textContent)
    assert.ok(lines.some((line) => line.includes('没提交成功') && line.includes('隧道断了')))
  })
})
