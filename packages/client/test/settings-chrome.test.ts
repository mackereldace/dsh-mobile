/**
 * 设置弹窗「结构认位」的测试（假 DOM + 真 boot.js 切片，毫秒级）。
 *
 * ## 为什么要有它（2026-11-06，用户报的「设置面板全坏」✗）
 *
 * 我们原来把 DSH 设置的 DOM 结构**写死**成 0.2.1 那一套：
 *   `panel.children = [nav, content]`、`content.children = [header, options]`
 * 而 DSH 0.2.2 改成了**四个平级兄弟**：
 *   `panel.children = [navTitle, nav, header, options]`
 *
 * 于是一整排症状同时出现（用户截图为证 ✓）：导航列被当成 header 藏掉（设置页上只剩
 * 「设置」两个字 ✓）、「打开配置文件 + ×」那条头部反而留着 ✓、正文列宽出 32px 被右缘裁掉 ✓、
 * 关闭键的标记落到第二颗导航按钮上 ✓（关设置会把分组切走 ✗）。
 *
 * 这类错**只能靠真机/无头看**才发现 ✗，而单测跑一次是毫秒级 ⇒ 在这里把判据钉死：
 *   1. **两代结构都要认对**（0.2.2 平级 / 0.2.1 包装 ✓）；
 *   2. 认不出时必须**什么都不做**（宁可让开，也不往猜错的位置塞节点 ✓）；
 *   3. CSS 三笔不许回退：正文列不许写 `width:100%`、导航要纵排、标题/导航不许被挤扁 ✓。
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
  const stops = ['\n  function ', '\n    function ', '\n  var ', '\n  /**'].map((mark) => BOOT.indexOf(mark, start + 10)).filter((at) => at >= 0)
  const stop = stops.length === 0 ? BOOT.length : Math.min(...stops)
  return BOOT.slice(start, stop)
}

interface FakeNode {
  tagName: string
  attributes: Map<string, string>
  children: FakeNode[]
  appendChild(child: FakeNode): FakeNode
  setAttribute(name: string, value: string): void
  getAttribute(name: string): string | null
  querySelector(selector: string): FakeNode | null
}

function node(tagName: string, children: FakeNode[] = []): FakeNode {
  const created: FakeNode = {
    tagName,
    attributes: new Map<string, string>(),
    children,
    appendChild(child) {
      created.children.push(child)
      return child
    },
    setAttribute(name, value) {
      created.attributes.set(name, value)
    },
    getAttribute(name) {
      return created.attributes.has(name) ? String(created.attributes.get(name)) : null
    },
    querySelector(selector) {
      // 被测代码只用来找 `[data-dshm-conn="1"]` ✓（见 mountConnBody ✓）
      const name = selector.replace(/^\[data-/, '').replace(/="1"\]$/, '')
      for (const child of created.children) {
        if (child.attributes.has(`data-${name}`)) return child
        const deeper = child.querySelector(selector)
        if (deeper !== null) return deeper
      }
      return null
    },
  }
  return created
}

/** 把这两个函数装进一个假环境 ✓（它们只碰 `panel.children` 与 `tagName` ✓）。 */
function build() {
  const context: Record<string, unknown> = {}
  const code = [
    grabFunction('settingsChromeParts'),
    grabFunction('tagSettingsChrome'),
    'globalThis.__api__ = { settingsChromeParts, tagSettingsChrome }',
  ].join('\n')
  runInNewContext(code, context)
  return context['__api__'] as {
    settingsChromeParts(panel: FakeNode): { nav: FakeNode; content: FakeNode; header: FakeNode; options: FakeNode } | null
    tagSettingsChrome(panel: FakeNode): void
  }
}

/** DSH 0.2.2 的结构：`[navTitle, nav, header, options]` 四个平级兄弟 ✓。 */
function panel202(): { panel: FakeNode; title: FakeNode; nav: FakeNode; navList: FakeNode; header: FakeNode; actions: FakeNode; close: FakeNode; options: FakeNode } {
  const title = node('DIV')
  const navList = node('DIV', [node('BUTTON'), node('BUTTON')])
  const nav = node('NAV', [navList])
  const actions = node('DIV')
  const close = node('BUTTON')
  const header = node('DIV', [actions, close])
  const options = node('DIV')
  const panel = node('DIV', [title, nav, header, options])
  return { panel, title, nav, navList, header, actions, close, options }
}

/** DSH 0.2.1 的结构：`[nav, content]`，content 里再分 `[header, options]` ✓。 */
function panel201(): { panel: FakeNode; nav: FakeNode; navList: FakeNode; content: FakeNode; header: FakeNode; options: FakeNode } {
  const navList = node('DIV', [node('BUTTON')])
  const nav = node('NAV', [node('DIV'), navList])
  const header = node('DIV', [node('DIV'), node('BUTTON')])
  const options = node('DIV')
  const content = node('DIV', [header, options])
  const panel = node('DIV', [nav, content])
  return { panel, nav, navList, content, header, options }
}

test('0.2.2 四个平级兄弟：nav / header / options 各就各位，导航列**不许**被当成 header', () => {
  const { settingsChromeParts, tagSettingsChrome } = build()
  const world = panel202()
  const parts = settingsChromeParts(world.panel)
  assert.ok(parts !== null, '0.2.2 的结构必须认得出来')
  assert.equal(parts.header, world.header)
  assert.equal(parts.options, world.options)
  assert.equal(parts.nav, world.nav)
  assert.equal(parts.content, world.panel, '0.2.2 没有包装层 ⇒ 我们那份正文挂在 panel 上')

  tagSettingsChrome(world.panel)
  assert.equal(world.header.getAttribute('data-dshm-settings-header'), '1')
  assert.equal(world.options.getAttribute('data-dshm-settings-options'), '1')
  assert.equal(world.navList.getAttribute('data-dshm-settings-header'), null, '导航列被打成 header ⇒ 壳里会把整个导航藏掉（本轮真 bug）')
  assert.equal(world.close.getAttribute('data-dshm-settings-close'), '1', '关闭键必须是 header 里那颗 button')
  assert.equal(world.actions.getAttribute('data-dshm-settings-actions'), '1')
  assert.equal(world.panel.getAttribute('data-dshm-settings-content'), null, 'panel 自己不该被标成 content 包装层')
})

test('0.2.1 包装结构：content 层要打标记（否则那条「非滚动项不收缩」会拿走它的滚动能力）', () => {
  const { settingsChromeParts, tagSettingsChrome } = build()
  const world = panel201()
  const parts = settingsChromeParts(world.panel)
  assert.ok(parts !== null)
  assert.equal(parts.content, world.content)
  assert.equal(parts.header, world.header)
  assert.equal(parts.options, world.options)

  tagSettingsChrome(world.panel)
  assert.equal(world.content.getAttribute('data-dshm-settings-content'), '1')
  assert.equal(world.header.getAttribute('data-dshm-settings-header'), '1')
  assert.equal(world.options.getAttribute('data-dshm-settings-options'), '1')
  assert.equal(world.navList.getAttribute('data-dshm-settings-header'), null)
})

test('结构又变了（认不出）⇒ 一律让开：不抛、不打任何标记', () => {
  const { settingsChromeParts, tagSettingsChrome } = build()
  const noNav = node('DIV', [node('DIV'), node('DIV')])
  assert.equal(settingsChromeParts(noNav), null, '没有 <nav> 就不是设置弹窗')
  tagSettingsChrome(noNav)
  for (const child of noNav.children) {
    assert.equal(child.getAttribute('data-dshm-settings-header'), null)
    assert.equal(child.getAttribute('data-dshm-settings-options'), null)
  }
  const onlyNav = node('DIV', [node('NAV', [node('DIV')])])
  assert.equal(settingsChromeParts(onlyNav), null, 'nav 之后一个兄弟都没有 ⇒ 认不出')
  assert.equal(settingsChromeParts(null as unknown as FakeNode), null, 'null 也要安全')
})

test('CSS 三笔不许回退（正文列宽、导航纵排、标题不许被挤扁）', () => {
  const cssStart = BOOT.indexOf('style.textContent = [')
  assert.ok(cssStart >= 0, 'boot.js 里找不到样式表那一大段（注入点改名了就要同步改这个测试）')
  const css = BOOT.slice(cssStart)
  /**
   * ① 正文列：`width:100%` + DSH 的 `padding: 0 16px`（content-box）⇒ 宽出 32px 被裁掉 ✓
   *    （用户截图里「跟随系统」卡片与「充值」按钮就是那么不见的 ✓）。
   */
  const optionsStart = css.indexOf("'  [data-dshm-settings-options] {'")
  assert.ok(optionsStart >= 0, 'CSS 里找不到正文列的规则')
  const optionsRule = css.slice(optionsStart, optionsStart + 600)
  assert.ok(optionsRule.includes('width: auto !important'), '正文列必须写 width:auto（写 100% 会宽出一条）')
  assert.ok(!optionsRule.includes("'    width: 100% !important"), '正文列不许再写 width:100%（`max-width` 不算 ✓）')
  assert.ok(optionsRule.includes('box-sizing: border-box !important'))
  assert.ok(!css.includes("'  [data-dshm-panel] > div:last-child {'"), '旧的 > div:last-child 判据必须已经删掉（0.2.2 会打偏）')
  /**
   * ② 导航：DSH 0.2.2 的窄屏样式会把它改成**横向条**，用户早就拍板要纵排 ✓。
   */
  assert.ok(css.includes('flex-direction: column !important; overflow: visible !important;'), '导航列必须压回纵排')
  /**
   * ③ 标题/导航不许被挤扁（切到「连接与设备」后「设置」只剩一条横缝 ✓）。
   */
  assert.ok(css.includes("'  [data-dshm-panel] > nav,'"), '非滚动项（标题 / 导航）必须 flex-shrink:0')
  assert.ok(css.includes("'  [data-dshm-panel] > div:not([data-dshm-settings-options]):not([data-dshm-conn]):not([data-dshm-settings-content]) {'"), '那条「非滚动项不收缩」必须把两份正文排除在外')
  assert.ok(css.includes("'  [data-dshm-settings-content] {'"), '0.2.1 那层包装要有自己的滚动规则')
})
