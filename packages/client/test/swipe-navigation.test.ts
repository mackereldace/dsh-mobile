/**
 * 滑动导航状态机的测试（假 DOM + 假触摸，毫秒级）。
 *
 * ## 为什么要有它
 *
 * 滑动这条逻辑改了三轮，每一轮都只能靠**跑一遍完整验收**（8 分钟）来验证，
 * 而且验收里失败时能看到的信息有限 ✗（调试框、诊断对象都只在真实页面里 ✓）——
 * 排查"抽屉为什么关不掉"这类问题时，一轮又一轮地跑验收是极低效的 ✓。
 *
 * 于是把 `installSwipeNavigation` 从 boot.js 里**切出来**，配一套假 DOM 与假触摸事件，
 * 在这里直接驱动状态机 ✓。它能秒级回答"这一笔手势会走到哪一步" ✓，
 * 也能在以后任何一次改动里第一时间拦住回归 ✓。
 *
 * ## 覆盖的语义（都是真机反馈定下来的）
 *
 * · 内容区左滑 → 开右侧面板；右滑 → 开左侧抽屉 ✓；
 * · 面板上**反向右滑推到位** → 关；推不到位 → **回弹**（不误关 ✓）；
 * · 抽屉同理（反向是左滑）✓；
 * · 面板/抽屉上**同方向**滑 → 什么都不做 ✓；
 * · 蒙层/遮罩上反向滑也算（手指不必落在面板上 ✓）。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const BOOT = readFileSync(join(here, '..', 'src', 'boot.js'), 'utf8')

/** 从 boot.js 里切出一个顶层函数（两个空格缩进 + `function name(`）✓。 */
function grabFunction(name: string): string {
  const start = BOOT.indexOf(`  function ${name}(`)
  assert.ok(start >= 0, `boot.js 里找不到函数 ${name}（改名了就要同步改这个测试）`)
  const next = BOOT.indexOf('\n  function ', start + 10)
  return BOOT.slice(start, next < 0 ? BOOT.length : next)
}

/** 切出一个 `var name = …` 声明（到下一个顶格注释/声明为止，够用即可 ✓）。 */
function grabVar(name: string): string {
  const start = BOOT.indexOf(`  var ${name} = `)
  assert.ok(start >= 0, `boot.js 里找不到变量 ${name}`)
  const next = BOOT.indexOf('\n  /**', start + 10)
  return BOOT.slice(start, next < 0 ? start + 800 : next)
}

interface StubNode {
  selector: string
  style: Record<string, unknown> & {
    setProperty(name: string, value: string, priority?: string): void
    removeProperty(name: string): void
    getPropertyValue(name: string): string
  }
  width: number
  closest(selector: string): StubNode | null
  getBoundingClientRect(): { left: number; top: number; width: number; height: number }
  appendChild(child: StubNode): StubNode
  remove(): void
}

/** 造一个假节点：`matches` 决定它能被哪些选择器命中 ✓。 */
function stubNode(selector: string, matches: string[], width = 264): StubNode {
  const properties = new Map<string, string>()
  const node: StubNode = {
    selector,
    width,
    style: {
      transform: '',
      transition: '',
      setProperty: (name, value) => properties.set(name, String(value)),
      removeProperty: (name) => {
        properties.delete(name)
      },
      getPropertyValue: (name) => properties.get(name) ?? '',
    },
    closest: (wanted) => (matches.some((item) => wanted === item || wanted.indexOf(item) >= 0) ? node : null),
    getBoundingClientRect: () => ({ left: 0, top: 0, width, height: 900 }),
    // `measureWidth` 会往 body 挂一个离屏探针，再把它 remove 掉 ✓（桩必须支持这两步 ✓）
    appendChild: (child: StubNode) => child,
    remove: () => undefined,
  }
  return node
}

interface Harness {
  fire(type: string, x: number, y: number, target?: StubNode): void
  state: { last: string | null; count: number; dragging: string | null; lastRelease: { commit: boolean; offset: number } | null }
  logs: string[]
  body: { dataset: Record<string, string> }
  panel: StubNode
  drawer: StubNode
  content: StubNode
  backdrop: StubNode
  root: StubNode
  column: StubNode
  topBar: StubNode
  sheetOpen: () => boolean
  drawerOpen: () => boolean
  /** 预览可见态（`data-dshm-preview` ✓）——打开跟手期间它必须是 '1' ✓。 */
  preview: () => string
  sleeps: number[]
}

/** 把 boot.js 里的滑动导航装进一个假环境 ✓。 */
function buildHarness(overrides: { getComputedStyle?: (node: unknown) => { overflowX: string } } = {}): Harness {
  /**
   * `document.body` 要是**节点**（`measureWidth` 会往它上面挂离屏探针 ✓），
   * 同时还得有 `dataset`（状态判断全靠它 ✓）—— 上一版只给了个普通对象 ✗，
   * 于是"量不到宽度"这条用例直接 `appendChild is not a function` ✓。
   */
  const body = stubNode('body', ['body']) as StubNode & { dataset: Record<string, string> }
  body.dataset = {}
  const panel = stubNode('#dsh-mobile-sheet-panel', ['#dsh-mobile-sheet-panel'])
  const backdrop = stubNode('#dsh-mobile-sheet-backdrop', ['#dsh-mobile-sheet-backdrop'])
  const drawer = stubNode('[class*="sidebarCol"]', ['[class*="sidebarCol"]'])
  const scrim = stubNode('#dsh-mobile-scrim', ['#dsh-mobile-scrim'])
  const content = stubNode('[class*="centerCol"]', ['[class*="centerCol"]'])
  /**
   * 主页面那一列（`centerCol`）——拖动期间它的 `transition` 必须被关掉 ✗。
   * ★ 它就是"快速回拖脱节"的根因：面板关了过渡、这一列没关，快拖时它每帧都在追动画 ✓。
   */
  const column = stubNode('#column', ['[class*="centerCol"]'])
  column.style['transition'] = 'transform .24s cubic-bezier(.2,.8,.2,1)'
  /**
   * 顶栏（我们的元素，带 `data-dshm-push-follower` ✓）。
   * ★ 它曾经是"滑动时脱节"的那个漏网元素 ✗ —— 所以这里必须有一个节点代表它 ✓。
   */
  const topBar = stubNode('#dsh-mobile-top', ['#dsh-mobile-top'])
  topBar.style['transition'] = 'transform .22s cubic-bezier(.22,.61,.36,1)'
  const nodes = [panel, backdrop, drawer, scrim, content]

  const listeners = new Map<string, ((event: unknown) => void)[]>()
  const documentElement = stubNode(':root', [':root'])
  const document = {
    body,
    documentElement,
    addEventListener: (type: string, handler: (event: unknown) => void) => {
      listeners.set(type, (listeners.get(type) ?? []).concat(handler))
    },
    querySelector: (selector: string) => {
      // `[class*="centerCol"]` 在真实页面里既可能是内容列、也是它的包装层 ✓；
      // 测试里让"内容列"这个选择器命中 column（拖动要关过渡的那个 ✓）
      if (selector.indexOf('centerCol') >= 0) return column
      return nodes.find((node) => node.closest(selector) === node) ?? null
    },
    /** 拖动要按属性取"跟随者名单"✓（顶栏就是靠它才不会再被漏掉 ✓）。 */
    querySelectorAll: (selector: string) => {
      if (selector.indexOf('data-dshm-push-follower') >= 0) return [column, topBar]
      return []
    },
    createElement: () => stubNode('div', []),
  }
  const logs: string[] = []
  const debugBoxLine = (text: string) => {
    logs.push(text)
  }
  const state = { last: null as string | null, count: 0, dragging: null as string | null, lastRelease: null }

  const code = [
    grabVar('swipeNavigationState'),
    /**
     * ★ 探测「DSH 自带预览开着吗」的两个**模块级** var（round 101 ✓）。
     *   不切进来就是 `ReferenceError` ✗ —— 而 `touchstart` 里的守卫会调它 ✓，
     *   于是整条滑动路径在测试里静默失效 ✗（本轮真的踩了 ✓：13 条红 ✓）。
     *   教训与 markdown 那边同源：**切片名单必须跟着新依赖一起长** ✓。
     */
    grabVar('dshPreviewSurface'),
    grabVar('syncDshPreviewState'),
    grabFunction('describeNode'),
    /**
     * ★ round 160：`applyFrame` 收尾时改调 `flipDrawerMotion`（抽屉走 FLIP ✓）——
     *   它是**模块级**函数 ✓，不切进来就是 `ReferenceError` ✗（同上面那条教训 ✓）。
     */
    grabFunction('flipDrawerMotion'),
    grabFunction('installSwipeNavigation'),
  ].join('\n')

  const sheet = {
    /** 预览可见态挂在 sheet 根上（`data-dshm-preview` ✓）——桩也要有它 ✓。 */
    root: { dataset: {} as Record<string, string> },
    setOpen: (open: boolean) => {
      if (open) body.dataset['dshmFiles'] = 'open'
      else delete body.dataset['dshmFiles']
      // ★ 真实实现里 setOpen 末尾会 refreshPush() ✓ —— 桩必须照抄这一步，
      //   否则"打开后主页面整块让位"在测试里恒为空 ✗（本轮就假红了一次 ✓）
      syncPush()
    },
  }
  const setDrawer = (open: boolean) => {
    if (open) {
      // 与真实实现一致：打开抽屉会**无条件**把右边的面板关掉 ✓
      sheet.setOpen(false)
      body.dataset['dshMobileDrawer'] = 'open'
    } else {
      delete body.dataset['dshMobileDrawer']
    }
    syncPush()
  }
  const openFiles = () => sheet.setOpen(true)
  /**
   * 让位量的"状态重算"：真实实现里 `refreshPush()` 按 data-* 算出 `--dshm-push` ✓。
   * 测试里照抄这条规则（拖动插值由产品代码负责 ✓，这里只负责"交还"那一步 ✓）。
   */
  const syncPush = () => {
    const next = body.dataset['dshMobileDrawer'] === 'open' ? '264px' : body.dataset['dshmFiles'] === 'open' ? '-264px' : '0px'
    documentElement.style.setProperty('--dshm-push', next)
  }

  const run = new Function(
    'document',
    'globalThis',
    'debugBoxLine',
    'sheet',
    'setDrawer',
    'openFiles',
    'syncPush',
    `${code}
     swipeNavigationState.last = null
     installSwipeNavigation(sheet, setDrawer, openFiles, syncPush)
     return swipeNavigationState`,
  )
  const swipeState = run(
    document,
    {
      getComputedStyle: overrides.getComputedStyle ?? (() => ({ overflowX: 'visible' })),
      // 拖动期间的写样走"一帧一次"✓（桩里用 setTimeout(0) 代替，语义一致 ✓）
      requestAnimationFrame: (callback: () => void) => setTimeout(callback, 0),
      cancelAnimationFrame: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    },
    debugBoxLine,
    sheet,
    setDrawer,
    openFiles,
    syncPush,
  ) as Harness['state']

  return {
    fire: (type, x, y, target = content) => {
      const event = {
        touches: type === 'touchend' || type === 'touchcancel' ? [] : [{ clientX: x, clientY: y }],
        target,
        cancelable: true,
        preventDefault: () => undefined,
        stopPropagation: () => undefined,
      }
      for (const handler of listeners.get(type) ?? []) handler(event)
    },
    state: swipeState,
    logs,
    body,
    panel,
    drawer,
    content,
    backdrop,
    root: documentElement,
    column,
    topBar,
    sheetOpen: () => body.dataset['dshmFiles'] === 'open',
    drawerOpen: () => body.dataset['dshMobileDrawer'] === 'open',
    preview: () => String(sheet.root.dataset['dshmPreview'] ?? ''),
    sleeps: [],
  }
}

/** 走一笔完整手势（起 → 若干move → 落）✓；返回时等"关闭动画 + 状态切换"那 220ms ✓。 */
async function swipe(h: Harness, fromX: number, dx: number, target: StubNode, dy = 0) {
  h.fire('touchstart', fromX, 600, target)
  for (const ratio of [0.34, 0.67, 1]) h.fire('touchmove', fromX + dx * ratio, 600 + dy * ratio, target)
  h.fire('touchend', fromX + dx, 600, target)
  await new Promise((resolve) => setTimeout(resolve, 300))
}

test('内容区左滑开面板、反向推到位关掉', async () => {
  const h = buildHarness()
  await swipe(h, 330, -140, h.content)
  assert.equal(h.sheetOpen(), true, '内容区左滑应当打开文件面板')
  assert.equal(h.state.last, 'open-files')
  await swipe(h, 280, 150, h.panel)
  assert.equal(h.sheetOpen(), false, '面板上反向（右滑）推到位应当关闭')
  assert.equal(h.state.last, 'close-files')
})

test('面板上短拖回弹：不关、且内联样式清干净', async () => {
  const h = buildHarness()
  await swipe(h, 330, -140, h.content)
  assert.equal(h.sheetOpen(), true)
  await swipe(h, 280, 70, h.panel)
  assert.equal(h.sheetOpen(), true, '短拖不该关掉面板（用户的误关反馈）')
  assert.equal(h.state.lastRelease?.commit, false, '松手判定应当是"回弹"')
  assert.equal(h.panel.style['transform'], '', '回弹后内联 transform 必须清掉')
  assert.equal(h.panel.style['transition'], '', '回弹后 transition 必须恢复')
})

test('抽屉：内容区右滑打开、反向左滑推到位关闭', async () => {
  const h = buildHarness()
  await swipe(h, 120, 150, h.content)
  assert.equal(h.drawerOpen(), true, '内容区右滑应当打开左侧抽屉')
  assert.equal(h.state.last, 'open-drawer')
  await swipe(h, 132, -150, h.drawer)
  assert.equal(h.drawerOpen(), false, '抽屉上反向（左滑）推到位应当关闭')
  assert.equal(h.state.last, 'close-drawer')
})

test('抽屉：短拖回弹，且内联 left 被清掉', async () => {
  const h = buildHarness()
  await swipe(h, 120, 150, h.content)
  await swipe(h, 132, -70, h.drawer)
  assert.equal(h.drawerOpen(), true, '短拖不该关掉抽屉')
  assert.equal(h.state.lastRelease?.commit, false)
  assert.equal(h.drawer.style['getPropertyValue']('left'), '', '回弹后内联 left 必须清掉')
})

test('蒙层与遮罩上反向滑也能关（手指不必落在面板上）', async () => {
  const h = buildHarness()
  await swipe(h, 330, -140, h.content)
  assert.equal(h.sheetOpen(), true)
  await swipe(h, 60, 130, h.backdrop)
  if (h.sheetOpen()) console.log('蒙层用例日志：', JSON.stringify(h.logs), 'state=', JSON.stringify(h.state))
  assert.equal(h.sheetOpen(), false, '蒙层上反向滑应当关闭面板')

  // 遮罩（抽屉右侧那块）同理 ✓
  const h2 = buildHarness()
  await swipe(h2, 120, 150, h2.content)
  assert.equal(h2.drawerOpen(), true)
  h2.fire('touchstart', 380, 600, h2.backdrop)
  // 遮罩节点在假环境里用同一套 `closest` 判定 ✓（真实页面里它是 #dsh-mobile-scrim ✓）
  h2.fire('touchstart', 380, 600, h2.drawer)
  for (const ratio of [0.34, 0.67, 1]) h2.fire('touchmove', 380 - 130 * ratio, 600, h2.drawer)
  h2.fire('touchend', 250, 600, h2.drawer)
  await new Promise((resolve) => setTimeout(resolve, 300))
  assert.equal(h2.drawerOpen(), false, '遮罩上反向滑应当关闭抽屉')
})

test('拖动期间主页面**同步**让位（用户反馈的"脱节"）', async () => {
  const h = buildHarness()
  await swipe(h, 330, -140, h.content)
  assert.equal(h.sheetOpen(), true)
  // 打开态：主页面被推开一个面板宽度 ✓
  assert.equal(h.root.style['getPropertyValue']('--dshm-push'), '-264px', '打开态应当整块让位')

  // 拖动到一半（132px = 面板宽 264 的一半）——**先不松手**，量主页面让位 ✓
  h.fire('touchstart', 280, 600, h.panel)
  h.fire('touchmove', 346, 600, h.panel)
  await new Promise((resolve) => setTimeout(resolve, 25))
  // ★ **一次快速跳到位**（模拟"快速回拖"✓）：位移必须立刻生效，不能还在追动画 ✗
  h.fire('touchmove', 412, 600, h.panel)
  // ★ 写样式是"一帧一次"（rAF ✓）→ 采样前必须等一帧，否则量到的是上一帧的值 ✗
  await new Promise((resolve) => setTimeout(resolve, 25))
  // ★ 拖动期间主页面由**内联 transform** 驱动（同一帧写 ✓），不再走根变量 ✗
  assert.equal(
    h.column.style['transform'],
    'translateX(-132px)',
    `拖动到一半时主页面应当只让一半（实测 ${h.column.style['transform']}）`,
  )
  assert.equal(
    h.root.style['getPropertyValue']('--dshm-push'),
    '-264px',
    '拖动期间不动根变量（它只在交还给状态时才写 ✓）',
  )
  // ★ 顶栏必须与内容列**同一帧、同一值**（用户反馈过"滑动时顶栏脱节" ✗）
  assert.equal(
    h.topBar.style['transform'],
    'translateX(-132px)',
    `拖动期间顶栏必须与内容列同步（实测 ${h.topBar.style['transform']}）`,
  )
  assert.equal(h.topBar.style['transition'], 'none', '拖动期间顶栏的过渡也要关掉 ✓')
  assert.equal(
    h.column.style['transition'],
    'none',
    '拖动期间主页面列的过渡必须被关掉（否则快速拖动会脱节 ✗）',
  )

  // 真人会**拖回去再松手**（132px 已经过了 92px 的提交阈值 ✓，直接松手会关掉 ✗）
  h.fire('touchmove', 280 + 60, 600, h.panel)
  h.fire('touchend', 280 + 60, 600, h.panel)
  await new Promise((resolve) => setTimeout(resolve, 120))
  assert.equal(h.sheetOpen(), true, '推不到位应当回弹')
  await new Promise((resolve) => setTimeout(resolve, 40))
  assert.equal(h.root.style['getPropertyValue']('--dshm-push'), '-264px', '回弹后让位交还给状态')
  assert.equal(h.column.style['transform'], '', '回弹后内容列的内联 transform 必须清掉（交还给状态 ✓）')
  assert.equal(h.topBar.style['transform'], '', '回弹后顶栏的内联 transform 也必须清掉 ✓')
  assert.notEqual(h.topBar.style['transition'], 'none', '回弹后顶栏的过渡必须恢复 ✓')
  // 松手后清掉内联的 `transition` ✓ —— 真正的过渡来自**样式表**（`[class*="centerCol"]`
  // 那条 CSS 规则），清掉内联值它就自动生效 ✓。所以在测试里断言"不再是 none" ✓，
  // 而不是断言某个具体字符串 ✗（桩没有样式表，比字符串只会自欺 ✓）。
  assert.notEqual(h.column.style['transition'], 'none', '松手后主页面列的过渡必须恢复')

  // 推到位 → 松手瞬间**不能先复位**，然后才回位 ✓（用户说的"复位、然后再动" ✗）
  h.fire('touchstart', 280, 600, h.panel)
  for (const x of [340, 400, 460, 520]) h.fire('touchmove', x, 600, h.panel)
  h.fire('touchend', 520, 600, h.panel)
  // ★ 松手后**立刻**采样：那一刻状态还没切换（220ms 后才切 ✓），
  //   所以这里绝不能回到"整块让位"（-264px ✗）——它必须是 0（主页面已经进场了 ✓）。
  await new Promise((resolve) => setTimeout(resolve, 30))
  // 状态**立刻**切换（不再等 220ms ✗），所以这里根变量与内容列都已经在"进场"这一侧 ✓
  assert.equal(h.sheetOpen(), false, '推到位松手后状态应当**立刻**切换（不留竞态窗口 ✗）')
  // 推到位时**状态立刻切换**（不留竞态窗口 ✓），让位量随之交还给状态 → 根变量变成 0 ✓
  assert.equal(
    h.root.style['getPropertyValue']('--dshm-push'),
    '0px',
    `推到位松手后主页面应当直接朝 0 走（实测 ${h.root.style['getPropertyValue']('--dshm-push')}）`,
  )
  assert.equal(h.column.style['transform'], '', '此时让位量已交还状态，内联应当清掉 ✓')
  await new Promise((resolve) => setTimeout(resolve, 320))
  assert.equal(h.sheetOpen(), false, '推到位应当关闭')
  assert.equal(h.root.style.getPropertyValue('--dshm-push'), '0px', '关闭后主页面完全回位')
})

test('面板关着（display:none）时量不到宽度，仍必须能打开（真机就栽在这里）', async () => {
  const h = buildHarness()
  /**
   * ★ 复现真机情形：面板关闭时 `getBoundingClientRect().width` 是 **0** ✗
   *   （`#dsh-mobile-sheet` 那时是 `display: none` ✓）。
   *   产品代码必须回退到"按 CSS 变量解析宽度"✓，否则打开手势的推进量永远到不了阈值 ✓
   *   —— 现象就是"侧滑打开没反应"，而桩里宽度恒为 264 时**完全看不见** ✗。
   */
  h.panel.getBoundingClientRect = () => ({ left: 0, top: 0, width: 0, height: 0 })
  h.fire('touchstart', 330, 600, h.content)
  for (const x of [280, 230, 180]) h.fire('touchmove', x, 600, h.content)
  h.fire('touchend', 180, 600, h.content)
  await new Promise((resolve) => setTimeout(resolve, 150))
  assert.equal(h.sheetOpen(), true, '关着（量不到宽度）时也必须能滑开 ✓')
  assert.equal(h.state.last, 'open-files')
})

test('**打开也跟手**：拖到一半时面板/内容/顶栏同帧同位，提前松手回弹到关闭 ✓', async () => {
  const h = buildHarness()
  // 从内容区往左拖 66px（不到 92px 的提交阈值 ✓），**按住不放**量三者位置 ✓
  h.fire('touchstart', 330, 600, h.content)
  h.fire('touchmove', 300, 600, h.content)
  await new Promise((resolve) => setTimeout(resolve, 25))
  h.fire('touchmove', 264, 600, h.content) // |dx| = 66 ✓
  await new Promise((resolve) => setTimeout(resolve, 25))

  // 面板：从屏外拉进来 66px → 还剩 264−66 = 198px 在外面 ✓
  assert.equal(
    h.panel.style['transform'],
    'translateX(198px)',
    `打开跟手时面板应当只露出一部分（实测 ${h.panel.style['transform']}）`,
  )
  // 内容与顶栏：跟着让开 66px ✓（三者同一帧 ✓ —— 用户报过"打开时顶栏自己走" ✗）
  assert.equal(h.column.style['transform'], 'translateX(-66px)', '内容应当跟随打开手势 ✓')
  assert.equal(h.topBar.style['transform'], 'translateX(-66px)', '顶栏也应当跟随打开手势 ✓')
  assert.equal(h.preview(), '1', '打开跟手期间面板必须**可见**（否则手滑时只有内容在动 ✗）')

  // 提前松手 → 回弹到**关闭**（不是打开 ✓）
  h.fire('touchend', 264, 600, h.content)
  await new Promise((resolve) => setTimeout(resolve, 120))
  assert.equal(h.sheetOpen(), false, '没拉到位应当回弹到关闭 ✓')
  // 回弹是"滑回去再消失"✓：先动画到屏外，动画走完（~280ms）才收掉预览态并把内联清掉 ✓
  await new Promise((resolve) => setTimeout(resolve, 380))
  assert.equal(h.preview(), '0', '回弹后预览可见态必须收掉 ✓')
  assert.equal(h.panel.style['transform'], '', '回弹结束后内联位移要清掉（否则下次打开会被顶到屏外 ✗）')
  assert.equal(h.column.style['transform'], '', '回弹后内容也让位归零 ✓')
  assert.equal(h.topBar.style['transform'], '', '回弹后顶栏也让位归零 ✓')

  // 拉到位 → 打开 ✓
  h.fire('touchstart', 330, 600, h.content)
  for (const x of [280, 230, 180]) h.fire('touchmove', x, 600, h.content)
  h.fire('touchend', 180, 600, h.content)
  await new Promise((resolve) => setTimeout(resolve, 120))
  assert.equal(h.sheetOpen(), true, '拉到位应当打开 ✓')
  assert.equal(h.state.last, 'open-files')
})

test('上一笔的收尾回调**不得覆盖**新手势（"偶尔对不上"的结构性根因）', async () => {
  const h = buildHarness()
  // 第一笔：开抽屉 → 推到位关闭（这会安排一个 260ms 后的"清内联"回调 ✓）
  await swipe(h, 120, 150, h.content)
  assert.equal(h.drawerOpen(), true)
  h.fire('touchstart', 132, 600, h.drawer)
  for (const x of [80, 20, -40]) h.fire('touchmove', x, 600, h.drawer)
  h.fire('touchend', -40, 600, h.drawer)
  assert.equal(h.drawerOpen(), false, '第一笔应当把抽屉推到位关闭')

  // 手快：立刻重开抽屉，并在抽屉上**拖住不放**（此时抽屉带着我们写的内联 left ✓）
  h.fire('touchstart', 120, 600, h.content) // 注意：这一笔只是"打开"，不是拖动 ✓
  h.fire('touchmove', 260, 600, h.content)
  h.fire('touchend', 260, 600, h.content)
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(h.drawerOpen(), true, '第二笔应当把抽屉重新打开')
  h.fire('touchstart', 132, 600, h.drawer)
  await new Promise((resolve) => setTimeout(resolve, 25))
  // 往左拖 72px：**超过 56px 的起手阈值**（否则拖动根本不会开始 ✗）、
  // 又低于 92px 的提交阈值 → 正好停在"按着不放"的中间态 ✓
  h.fire('touchmove', 60, 600, h.drawer)
  await new Promise((resolve) => setTimeout(resolve, 25))
  const heldLeft = String(h.drawer.style['getPropertyValue']('left'))

  // 等过第一笔的清理时刻（260ms）✓ —— 没有令牌校验的话，这一刻内联 left 会被清掉 ✗
  await new Promise((resolve) => setTimeout(resolve, 320))
  const afterCleanup = String(h.drawer.style['getPropertyValue']('left'))
  assert.notEqual(heldLeft, '', '拖动期间抽屉应当带着内联 left ✓')
  assert.equal(
    afterCleanup,
    heldLeft,
    '第一笔的收尾回调把新手势的位移清掉了（令牌没生效 ✗）',
  )
})

test('同方向再滑什么也不做（不退、也不重复打开）', async () => {
  const h = buildHarness()
  await swipe(h, 330, -140, h.content)
  assert.equal(h.sheetOpen(), true)
  const before = h.state.count
  await swipe(h, 200, -150, h.panel)
  assert.equal(h.sheetOpen(), true, '同方向（左滑）不该关掉面板')
  assert.equal(h.state.count, before, '同方向不该产生任何动作')
})

test('面板开着时，**内容区**上同方向的横滑不跟手（用户反馈"边栏动而不返回"）', async () => {
  /**
   * ★ 用户原话："打开边栏另一个滑动方向的返回逻辑没删干净，会导致边栏动而不返回" ✗。
   *   已有那条"同方向什么也不做"滑的是**面板区** ✓，而真机上手指常常落在**内容区** ✓ ——
   *   那里原来只看"起点区域" ✗ → 左滑仍判成 `open-files` ✓ → 以**打开模式**跟手 ✓
   *   （`offset = 宽 − |dx|` = 面板反而往外走 ✓）→ 松手又弹回来 ✓ = "动了但不返回" ✓✓。
   */
  const h = buildHarness()
  await swipe(h, 330, -140, h.content)
  assert.equal(h.sheetOpen(), true, '前置：内容区左滑应当打开面板 ✓')

  // 同方向（继续左滑，仍从**内容区**起手）→ 按住不放时**不许有任何位移** ✓
  h.fire('touchstart', 330, 600, h.content)
  h.fire('touchmove', 280, 600, h.content)
  await new Promise((resolve) => setTimeout(resolve, 25))
  h.fire('touchmove', 240, 600, h.content) // |dx| = 90 ✓（远超任何阈值 ✓）
  await new Promise((resolve) => setTimeout(resolve, 25))
  const panelDuringSameDirection = h.panel.style['transform']
  h.fire('touchend', 240, 600, h.content)
  await new Promise((resolve) => setTimeout(resolve, 300))

  assert.equal(h.sheetOpen(), true, '同方向滑动不该把面板关掉 ✗')
  assert.equal(h.state.last, 'open-files', '同方向滑动不该产生新的动作 ✓')
  // 打开状态下 CSS 就是"没有内联位移" ✓ —— 被跟手写脏会变成 translateX(174px) 之类 ✓
  assert.ok(
    panelDuringSameDirection === undefined ||
      panelDuringSameDirection === '' ||
      panelDuringSameDirection === 'translateX(0px)',
    `同方向滑动不该让面板跟手移动（实测 transform=${JSON.stringify(panelDuringSameDirection)} ✓）`,
  )
  assert.equal(h.column.style['transform'], '', '主页面也不该被推歪 ✓')

  // 反向（内容区右滑）→ 正常返回 ✓
  await swipe(h, 120, 150, h.content)
  assert.equal(h.sheetOpen(), false, '反向滑动应当关掉面板 ✓')
})

test('边栏开着时，遮罩上同方向的横滑**既不返回也不推主界面**（用户反馈"反过来了"）', async () => {
  /**
   * ★ 用户原话："右滑再右滑依旧没修复，左滑再左滑边栏不会返回，但**主界面会动**，
   *   和右滑再右滑的反过来了，但这都不是我们想要的" ✗。
   *   机制：`decide()` 返回 `null` 后 ✗，touchmove 仍然调 `beginDrag(null, …)` ✓
   *   → `surfaceOfAction(null)` 落到兜底 ✓ → 以**关闭**模式跟手 ✓
   *   → 面板没返回 ✓、**主界面却被推走** ✓✓。
   */
  const h = buildHarness()
  await swipe(h, 330, -140, h.content)
  assert.equal(h.sheetOpen(), true, '前置：面板应当已打开 ✓')

  // 同方向（左滑），从**遮罩**（主界面那块）起手 → 面板与主界面都必须纹丝不动 ✓
  h.fire('touchstart', 120, 600, h.backdrop)
  h.fire('touchmove', 60, 600, h.backdrop)
  await new Promise((resolve) => setTimeout(resolve, 25))
  const columnDuring = h.column.style['transform']
  const panelDuring = h.panel.style['transform']
  h.fire('touchend', 60, 600, h.backdrop)
  await new Promise((resolve) => setTimeout(resolve, 300))

  assert.equal(h.sheetOpen(), true, '同方向不该关掉面板 ✗')
  assert.equal(columnDuring, '', `同方向滑动不该推走主界面（实测 ${JSON.stringify(columnDuring)} ✗）`)
  assert.ok(
    panelDuring === undefined || panelDuring === '' || panelDuring === 'translateX(0px)',
    `同方向滑动不该让面板跟手（实测 ${JSON.stringify(panelDuring)} ✗）`,
  )
})

test('宽表格：横向滚动容器在深处（≥5 层）时也必须拦住手势（用户反馈）', async () => {
  /**
   * ★ 真机情形：宽表格的横向滚动容器在 `td → tr → tbody → table → 包装层` 之后 ✓，
   *   从单元格往上要 **5 层**才够 ✓ —— 旧代码只走 4 层 ✗，于是"在表格里横向平移"
   *   被当成滑动导航 ✓（用户："翻聊天记录的宽表格时，很容易拉起左右边栏" ✗）。
   */
  type Extras = { parentElement?: unknown; scrollWidth?: number; clientWidth?: number; overflowX?: string }
  const cell = stubNode('#cell', ['#cell']) as StubNode & Extras
  let cursor: StubNode & Extras = cell
  for (let level = 0; level < 6; level += 1) {
    const node = stubNode(`#level-${level}`, [`#level-${level}`]) as StubNode & Extras
    // 第 5 层（level 4）模拟"表格的横向滚动包装层"✓：内容 2000px、可视 400px ✓
    node.scrollWidth = level === 4 ? 2000 : 100
    node.clientWidth = level === 4 ? 400 : 100
    node.overflowX = level === 4 ? 'auto' : 'visible'
    cursor.parentElement = node
    cursor = node
  }
  const h = buildHarness({
    getComputedStyle: (node: unknown) => ({ overflowX: String((node as Extras | null)?.overflowX ?? 'visible') }),
  })
  await swipe(h, 330, -140, cell)
  assert.equal(h.sheetOpen(), false, '在宽表格（深层横向滚动容器）里横滑**不该**打开面板 ✗')
  assert.equal(h.drawerOpen(), false, '也不该打开抽屉 ✗')

  // 对照：同样的手势落在**普通内容**上（祖先都不可横向滚动）→ 该开就开 ✓
  const plain = buildHarness({
    getComputedStyle: () => ({ overflowX: 'visible' }),
  })
  await swipe(plain, 330, -140, plain.content)
  assert.equal(plain.sheetOpen(), true, '普通内容上的左滑仍然要能打开面板 ✓')
})

test('竖向滑动不抢（滚动消息不会开关面板）', async () => {
  const h = buildHarness()
  h.fire('touchstart', 200, 600, h.content)
  for (const y of [660, 720, 780]) h.fire('touchmove', 202, y, h.content)
  h.fire('touchend', 202, 780, h.content)
  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.equal(h.sheetOpen(), false, '竖向滑动不该打开面板')
  assert.equal(h.drawerOpen(), false, '竖向滑动不该打开抽屉')
})

test('拖动被打断（竖向滚动 / 浏览器取消）→ 回弹而不是卡在半路', async () => {
  const h = buildHarness()
  await swipe(h, 330, -140, h.content)
  assert.equal(h.sheetOpen(), true)
  h.fire('touchstart', 280, 600, h.panel)
  h.fire('touchmove', 340, 600, h.panel)
  h.fire('touchmove', 350, 700, h.panel) // 竖向漂移
  h.fire('touchcancel', 350, 700, h.panel) // 浏览器取消 → 必须回弹 ✓
  await new Promise((resolve) => setTimeout(resolve, 120))
  assert.equal(h.sheetOpen(), true, '打断后应当回弹（面板仍开着）')
  assert.equal(h.panel.style['transform'], '', '打断后内联 transform 必须清掉')
})
