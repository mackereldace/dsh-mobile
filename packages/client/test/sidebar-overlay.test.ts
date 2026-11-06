/**
 * 侧栏「覆盖层形态」的测试（假 DOM + 真 boot.js 切片，毫秒级）。
 *
 * ## 为什么要有它
 *
 * DSH 0.2.2 把侧栏从「网格里的一列」改成了**覆盖层对话框**：它用
 * `transform: translateX(-100%)` + `visibility: hidden` + `inert` 自己藏起来 ✓。
 * 我们那套「改 `left` 把列推出去/推回来」的做法对它**一个像素都不动** ⇒
 * 真机上抽屉拉开是**一整片黑** ✓（用户原话：「会话列表为空、显示为黑」✓）。
 *
 * 修法是按形态分支（见 `dshSidebarOverlayMode()` 的注释）。这块逻辑有三个容易错的地方，
 * 每一条都只能靠跑完整真机验收（8~25 分钟）才能发现 ✗ ⇒ 在这里把它们钉死：
 *
 *  1. **判据不许看 `position`** —— 我们自己那条样式已经把列改成 `fixed !important` ✓，
 *     按 `position` 判会**恒为真** ✓（0.2.1 会被误判成覆盖层 ✓）；
 *  2. `inert` 必须在开抽屉时摘掉、关抽屉时**只还自己摘过的那一次** ✓
 *     （抽屉"看得见、点不动"就是 `inert` 还在 ✓）；
 *  3. 形态判定要**按元素缓存**（判据读计算样式，而调用点在去抖观察者里 ✓）。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const BOOT = readFileSync(join(here, '..', 'src', 'boot.js'), 'utf8')

/** 从 boot.js 里切出一个顶层函数（两个空格缩进 ✓）。 */
function grabFunction(name: string): string {
  const start = BOOT.indexOf(`  function ${name}(`)
  assert.ok(start >= 0, `boot.js 里找不到函数 ${name}（改名了就要同步改这个测试）`)
  const next = BOOT.indexOf('\n  function ', start + 10)
  const stop = next < 0 ? BOOT.length : next
  return BOOT.slice(start, stop)
}

/** 切出一个模块级 `var name = …`（到下一个顶格注释/函数为止 ✓）。 */
function grabVar(name: string): string {
  const start = BOOT.indexOf(`  var ${name} = `)
  assert.ok(start >= 0, `boot.js 里找不到变量 ${name}`)
  const next = BOOT.indexOf('\n  function ', start + 10)
  const stop = next < 0 ? start + 600 : next
  return BOOT.slice(start, stop)
}

interface FakeElement {
  className: string
  attributes: Map<string, string>
  dataset: Record<string, string>
  children: FakeElement[]
  hasAttribute(name: string): boolean
  getAttribute(name: string): string | null
  setAttribute(name: string, value: string): void
  removeAttribute(name: string): void
  querySelectorAll(selector: string): FakeElement[]
}

/** 造一个够用的假元素（只实现被测代码真正碰的那几个方法 ✓）。 */
function element(options: { className?: string; role?: string; inert?: boolean } = {}): FakeElement {
  const attributes = new Map<string, string>()
  if (options.role !== undefined) attributes.set('role', options.role)
  if (options.inert === true) attributes.set('inert', '')
  const node: FakeElement = {
    className: options.className ?? '',
    attributes,
    dataset: {},
    children: [],
    hasAttribute: (name) => attributes.has(name),
    getAttribute: (name) => (attributes.has(name) ? String(attributes.get(name)) : null),
    setAttribute: (name, value) => {
      attributes.set(name, value)
    },
    removeAttribute: (name) => {
      attributes.delete(name)
    },
    querySelectorAll: () => (node.children.length > 0 ? node.children : [node]),
  }
  return node
}

interface World {
  body: FakeElement
  setColumn(next: FakeElement): void
  visibility: { value: 'visible' | 'hidden' }
  api: {
    dshSidebarOverlayMode(): boolean
    syncSidebarMode(): void
    syncSidebarInert(open: boolean): void
  }
}

/** 把这几个函数装进一个假环境（`document` 只有一个侧栏列 ✓）。 */
function buildWorld(initial: FakeElement): World {
  let column = initial
  const body = element()
  const visibility = { value: 'visible' as 'visible' | 'hidden' }
  const context: Record<string, unknown> = {
    document: {
      body,
      querySelector: (selector: string) => (selector.indexOf('sidebarCol') >= 0 ? column : null),
    },
    getComputedStyle: () => ({ visibility: visibility.value }),
  }
  const code = [
    grabVar('sidebarModeCache'),
    grabFunction('classHasSuffix'),
    grabFunction('dshSidebarColumn'),
    grabFunction('dshSidebarRoot'),
    grabFunction('dshSidebarOverlayMode'),
    grabFunction('syncSidebarMode'),
    grabFunction('syncSidebarInert'),
    'globalThis.__api__ = { dshSidebarOverlayMode, syncSidebarMode, syncSidebarInert }',
  ].join('\n')
  runInNewContext(code, context)
  return {
    body,
    setColumn: (next) => {
      column = next
    },
    visibility,
    api: context['__api__'] as World['api'],
  }
}

test('★ 0.2.2 形态：列上有 inert ⇒ 判为覆盖层', () => {
  const column = element({ className: 'abc_sidebarCol', inert: true })
  const world = buildWorld(column)
  assert.equal(world.api.dshSidebarOverlayMode(), true)

  world.api.syncSidebarMode()
  assert.equal(world.body.dataset['dshmSidebar'], 'overlay', '★ 形态要写进 body 的数据属性（样式表按它分支 ✓）')
})

test('★ 0.2.2 形态：列没有 inert、但 visibility: hidden ⇒ 仍然判为覆盖层', () => {
  const column = element({ className: 'abc_sidebarCol' })
  const world = buildWorld(column)
  world.visibility.value = 'hidden'
  assert.equal(world.api.dshSidebarOverlayMode(), true)
})

test('★ 0.2.2 形态：列没有 inert、但内层根带 role="dialog" ⇒ 仍然判为覆盖层', () => {
  const root = element({ className: 'abc_root abc_quietBars', role: 'dialog' })
  const column = element({ className: 'abc_sidebarCol' })
  column.children = [root]
  const world = buildWorld(column)
  assert.equal(world.api.dshSidebarOverlayMode(), true)
})

test('★★ 0.2.1 形态不许误判：三者都没有 ⇒ native（否则 0.2.1 会被"覆盖层"那套样式接管 ✗）', () => {
  const root = element({ className: 'abc_root abc_quietBars' })
  const column = element({ className: 'abc_sidebarCol' })
  column.children = [root]
  const world = buildWorld(column)
  assert.equal(world.api.dshSidebarOverlayMode(), false, '★ 裸的侧栏列（0.2.1）必须是 native')

  world.api.syncSidebarMode()
  assert.equal(world.body.dataset['dshmSidebar'], 'native')
})

test('★★ 判据不许看 position（我们自己把列改成了 fixed !important）', () => {
  const root = element({ className: 'abc_root' })
  const column = element({ className: 'abc_sidebarCol' })
  column.children = [root]
  const world = buildWorld(column)
  // `position` 在假环境里连读都读不到 —— 只要实现去读它就会抛 / 判错 ✓
  assert.equal(world.api.dshSidebarOverlayMode(), false, '★ 覆盖层判据只认 DSH 自己的隐藏标记 ✓')
})

test('★★ inert：开抽屉时摘掉、关抽屉时还回去（抽屉"看得见、点不动"就是它没摘 ✗）', () => {
  const column = element({ className: 'abc_sidebarCol', inert: true })
  const world = buildWorld(column)
  assert.equal(column.hasAttribute('inert'), true)

  world.api.syncSidebarInert(true)
  assert.equal(column.hasAttribute('inert'), false, '★ 开着的时候整棵子树必须能收指针事件')
  assert.equal(column.dataset['dshmInert'], '1', '★ 要记住"是我们摘的"，关的时候才只还这一份')

  world.api.syncSidebarInert(false)
  assert.equal(column.hasAttribute('inert'), true, '★ 关掉以后必须还回去（否则屏幕外那块仍能被读屏/焦点摸到）')
  assert.equal(column.dataset['dshmInert'], undefined)
})

test('★ inert：DSH 本来就没写 inert（native 形态）⇒ 我们一个字节都不碰', () => {
  const root = element({ className: 'abc_root' })
  const column = element({ className: 'abc_sidebarCol' })
  column.children = [root]
  const world = buildWorld(column)
  world.api.syncSidebarInert(true)
  assert.equal(column.hasAttribute('inert'), false)
  assert.equal(column.dataset['dshmInert'], undefined, '★ native 形态下不许留我们的标记')
})

test('★ 形态判定按元素缓存：同一个列不重复读计算样式，换了列要重新判', () => {
  const column = element({ className: 'abc_sidebarCol', inert: true })
  const world = buildWorld(column)
  assert.equal(world.api.dshSidebarOverlayMode(), true)
  // 摘掉 inert 之后**仍然**判为覆盖层（缓存 ✓ —— 否则我们的样式一动就来回翻 ✓）
  column.removeAttribute('inert')
  assert.equal(world.api.dshSidebarOverlayMode(), true)
  // 换一列（DSH 重渲染）⇒ 重新判 ✓
  world.setColumn(element({ className: 'def_sidebarCol' }))
  assert.equal(world.api.dshSidebarOverlayMode(), false)
})

test('★ 样式表里真有覆盖层那一支（判据是 CSS 规则存在，不是"函数被调用"✗）', () => {
  assert.ok(
    BOOT.includes('body[data-dshm-sidebar="overlay"] [class*="sidebarCol"] {'),
    '★ 覆盖层形态必须有它自己的一组规则（left / visibility / transform 三件 ✓）',
  )
  assert.ok(
    BOOT.includes('body[data-dshm-sidebar="overlay"][data-dsh-mobile-drawer="open"] [class*="sidebarCol"] {'),
    '★ 打开态必须把 transform 归零（否则列停在屏幕外 ⇒ 一整片黑 ✓）',
  )
  /**
   * ★★ 这两条必须**落在覆盖层那一段里**（变异验证过一次 ✓）：
   *   `visibility: visible !important` 在全文件还有第二处（子代理入口那一条 ✓），
   *   用全文件 `includes` 判会**假绿** ✗ —— 把覆盖层这一行删掉仍然绿 ✗。
   *   切法：从覆盖层那条选择器到它的行尾 `'  }',` 为止 ✓。
   */
  const start = BOOT.indexOf('body[data-dshm-sidebar="overlay"] [class*="sidebarCol"] {')
  const end = BOOT.indexOf("'  }',", start)
  assert.ok(start >= 0 && end > start, '必须能切出覆盖层那一段')
  const block = BOOT.slice(start, end)
  assert.ok(
    block.includes('visibility: visible !important'),
    '★ DSH 用 visibility: hidden 藏它 ⇒ 覆盖层那一段里必须显式改回来（别处那一处不算 ✓）',
  )
  assert.ok(
    block.includes('transform: translateX('),
    '★ 关态要靠 transform 把它推到屏幕外（`left` 对它无效 ✓ —— 这正是 0.2.2 那片黑的成因 ✓）',
  )
})

test('★ flipDrawerMotion 在覆盖层形态下不再自己补 transform（会和 !important 的样式规则打架 ✗）', () => {
  const start = BOOT.indexOf('  function flipDrawerMotion(mutate) {')
  const end = BOOT.indexOf('\n  function ', start + 10)
  const body = BOOT.slice(start, end < 0 ? start + 1200 : end)
  assert.ok(
    body.includes('dshSidebarOverlayMode()'),
    '★ 覆盖层形态必须走"直接 mutate、不补内联 transform"那一支 ✓',
  )
})
