/**
 * 手机表面（`/mobile/app`）上端侧通道的**启动路径**回归测试。
 *
 * ## 为什么单独有这么一个文件
 *
 * `direct.test.ts` 里的沙箱走的是**非手机表面**：`location.pathname` 是 `/`，
 * 而且没有 `innerWidth`，于是 `isShellSurface()` 为 false，`installDeviceChannel()`
 * 在第一道守卫就 return 了 —— 轮询定时器**根本不会启动**。
 *
 * 结果是手机上真正跑的那条路**覆盖为零**，并因此藏住了一个致命错误：
 * `unsupported` 只被赋值和读取、从未声明，而 boot.js 是 `'use strict'`，
 * 于是定时器回调里第一句 `if (unsupported) return` 每 4 秒抛一次 ReferenceError，
 * 而且抛在 `poll()` **之前**。表现是端侧通道**从来没有轮询过一次**：
 * 电脑侧 `enabled` 永远为空、审批推送没有落点、授权条永远不弹。
 * 未捕获的定时器异常只进控制台 —— 手机上完全看不见，所以它活了很久。
 *
 * 这个文件把那條路拉进测试：断言"会注册定时器"且"回调执行不抛错"。
 * 两条都不需要真实隧道，因此快且稳定。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const bootSource = readFileSync(join(here, '..', 'src', 'boot.js'), 'utf8')

/** ★ round 185：一条投递记录的形状 ✓（与 boot.js 里那份落盘契约一一对应 ✓）。 */
interface DeviceCallLogEntry {
  at: number
  id: string
  kind: string
  phase: string
  outcome: string
  detail: string
}

interface FakeElement {
  tagName: string
  id: string
  style: Record<string, unknown>
  dataset: Record<string, string>
  className: string
  attrs: Record<string, string>
  children: FakeElement[]
  parentNode: FakeElement | null
  textContent: string
  disabled?: boolean
  clicks: number
  listeners: Record<string, Array<(event?: unknown) => void>>
  isConnected?: boolean
  setAttribute: (name: string, value: unknown) => void
  getAttribute: (name: string) => string | null
  removeAttribute: (name: string) => void
  addEventListener: (type: string, run: (event?: unknown) => void) => void
  removeEventListener: () => void
  remove: () => void
  querySelector: (selector: string) => FakeElement | null
  querySelectorAll: (selector: string) => FakeElement[]
  appendChild: (child: FakeElement) => FakeElement
  insertBefore: (child: FakeElement) => FakeElement
  replaceChildren: () => void
  click: () => void
  getBoundingClientRect: () => { top: number; left: number; right: number; bottom: number; width: number; height: number }
  /**
   * ★ 下面三样只有**假 DSH 节点**才需要 ✓（本文件既有的最小夹具不建它们 ✓）——
   *   所以在这里声明成**可选** ✓，由 DshNode 收成**必填** ✓：
   *   两个接口因此是**同一套假元素** ✓（DshNode 处处可当 FakeElement 用 ✓），
   *   而 DshNode 自己的返回值又能收窄 ✓。
   */
  parentElement?: FakeElement | null
  events?: string[]
  dispatchEvent?: (event: { type?: string }) => boolean
}

interface Surface {
  /** 调试框里累积的所有行（手机屏幕上看到的就是它）。 */
  boxText: () => string
  /** 被 `setInterval` 注册的回调（不真的排程，避免测试进程挂住）。 */
  intervals: Array<() => void>
  /** 未捕获的顶层异常。 */
  thrown: unknown[]
  /** `__DSH_MOBILE_INTERNALS__`（生产函数直通口 ✓ —— 断言打在它上面，不打在复制品上 ✓）。 */
  internals: {
    parseFrame: (bytes: Uint8Array, hasTag: boolean) => unknown
    frameDesyncAt: () => number
    /**
     * ★★ 本轮追加：**隧道构造器本身** ✓（生产类 ✓，不是复制品 ✓）—— 让"手动重连失败"与
     *   "自动重连放弃"这两处不必起一条假 WebSocket 就能驱动 ✓（构造函数是纯记账 ✓，
     *   见 `boot.js` 里那句 `Tunnel: Tunnel` 的说明 ✓）。
     */
    Tunnel: new (config: Record<string, unknown>) => {
      reportManualReconnectFailure: (reason: string) => void
      giveUpAutoReconnect: (reason: string) => void
      autoPaused: boolean
      failStreak: number
    }
    /**
     * ★★ 本轮追加：**系统通知的去重判据本身** ✓（纯函数 ✓，`now` 由调用方给 ✓）。
     *   为什么需要 ✗：行为那条只证明"**有**一个窗"✓ —— 窗户**多宽**只有它量得到 ✓
     *   （注入时钟 ✓，不必真等 10 秒 ✗）。
     */
    shellNoticeDeduped: (key: string, now: number) => boolean
  }
  /**
   * ★ round 185 追加：`__DSH_MOBILE_BOOT__` ✓ —— 取证读数走它的 `.apk.deviceCallLog()` ✓
   *   （那正是主线用 adb + CDP 念的**同一个**入口 ✓，不是测试专用口 ✓）。
   */
  boot: {
    apk: {
      deviceCallLog: () => DeviceCallLogEntry[]
      /**
       * ★★ R1a/R1b 追加：宿主目录那两个口 ✓（`__DSH_MOBILE_BOOT__` 上**早就有的**生产入口 ✓，
       *   不是测试专用口 ✗）：`hostRecord` 直通 `hostRecordUpsert` ✓、
       *   `storeHost` 直通配对落盘那条路 ✓（`__DSH_MOBILE_BOOT__.storeHost` ✓）、
       *   `hosts` / `hostsActive` 读目录 ✓。
       */
      hostRecord: (record: Record<string, unknown>) => boolean
      storeHost: (config: Record<string, unknown>) => boolean
      storedHost: () => Record<string, unknown> | null
      hosts: () => Array<Record<string, unknown>>
      hostsActive: () => string | null
      currentFingerprint: () => string | null
      /** ★ R1b 追加：唯一身份写入口 ✓（验收要能"把身份种进壳"✓，与生产同一条路 ✓）。 */
      identityWrite: (key: string, value: string | null) => boolean
      /**
       * ★★ R4 追加：显式跑一次"宿主明确拒绝这台设备"那条路 ✓
       *   （生产函数 `handleDeviceRejection` 的直通口 ✓，验收脚本用的就是它 ✓）。
       */
      deviceRejection: (code: string, detail: string) => boolean
      /**
       * ★★ R5 追加：身份这条线的**读数 + 真实渲染产物** ✓
       *   （`data` = `identityDiagnostics()` ✓、`group` = 生产行渲染函数造的那一组 ✓）。
       */
      identityDiagnostics: () => { data: IdentityDiagnostics; group: FakeElement }
    }
    /**
     * ★★ 方案 A（2026-10-06）追加：**旁挂隧道的只读读数** ✓ ——
     *   就是 `__DSH_MOBILE_BOOT__.sideChannels()` 那个**生产入口** ✓
     *   （真机排障念的是同一个 ✓，不是测试专用口 ✗）。
     */
    sideChannels: () => SideChannelReadout[]
    /**
     * ★★ 方案 A 追加：**主隧道对象** ✓（`__DSH_MOBILE_BOOT__.tunnel` ✓ —— 真机上同一个 ✓）。
     *   本节只读它的 `sessionId`、并在收尾时停掉保活 ✓。
     */
    tunnel?: { sessionId?: string; stopKeepalive?: () => void }
  }
  /** ★ round 185 追加：沙箱里那个 localStorage 的底表 ✓ —— 用来证明"读数与落盘同源"✓。 */
  storage: Map<string, string>
  /**
   * ★★ 剪贴板原生桥追加：当前**提醒横幅**（`[data-dshm-banner=info]`）的**子元素快照** ✓。
   *
   * 为什么要这么一个口子 ✗：假 DOM 没有选择器引擎 ✓（`document.querySelector` 恒为 null ✓），
   * 所以"横幅里正文是不是**单独一个元素**"这件事，只能顺着 `body.children` 找 ✓。
   * 每条 = `{ attrs, text, css }` ✓（`css` 读的是 `style.cssText` ✓ ——
   * 生产代码是**整体赋值** cssText 的 ✓，不是逐条 setProperty ✓）。
   */
  infoBanner: () => Array<{ attrs: Record<string, string>; text: string; css: string }>
  /**
   * ★★ 本轮追加：页面上那条深色提示条（`#dshm-shell-toast` ✓）**当前**的文案 ✓；
   *   `null` ⇔ 生产代码**压根没造过**这个元素 ✓（"没弹"与"弹了别的"因此分得开 ✓）。
   *
   * 为什么要有这个口子 ✗：假 DOM 没有选择器引擎 ✓ ⇒ 只能顺着 `appendChild` 时登记的
   *   那张 id → 元素表去取 ✓ —— 读的仍然是**生产代码自己造的那个元素** ✓（不是另抄一份 ✓）。
   *   它证明的是"**没壳时退的是提示条、不是蓝横幅**"✓（本轮的核心契约之一 ✓）。
   */
  toastText: () => string | null
  /**
   * ★★ 本轮（性能）追加：沙箱里那个假 `MutationObserver` 记下来的**生产回调本体** ✓
   *   （`callback` 就是 `boot.js` 交给 `new MutationObserver(...)` 的那个函数 ✓ ——
   *   测试自己造一条 `MutationRecord` 递进去 ✓，不真的排帧 ✓）。
   */
  observers: ObservedWatcher[]
  /** ★★ 本轮追加：`requestAnimationFrame` 的队列 ✓（测试自己挑时机 `flushFrames()` ✓）。 */
  frames: Array<() => void>
  /** ★★ 本轮追加：把当前排队的帧跑掉 ✓（生产代码一帧只排一次 ✓，跑的过程中新排的留下 ✓）。 */
  flushFrames: () => void
  /**
   * ★★ 本轮追加：**这一页到底扫了几趟全文档** ✓ —— 数的是
   *   `document.querySelectorAll('…katex…')` 被调了几次 ✓。
   *   ★ 判据自检：全文件只有 `dshPreviewSurface()` 起手那一处扫 `.katex` ✓
   *   （结构那条断言钉着它 ✓）⇒ **数次数 = 数扫描次数** ✓（不用猜 ✓、也不看"代码看起来省了" ✗）。
   */
  previewScans: () => number
  /**
   * ★★ 本轮追加：`getComputedStyle` 被调了几次 ✓ —— 用来量 `tuneComposerScroll`
   *   那趟"沿输入区祖先链逐层量样式"到底跑没跑 ✓（**调用次数**做证据 ✓）。
   */
  composerStyleProbes: () => number
  /** ★★ 本轮追加：假输入区那三层的**真身** ✓（断言生产代码写下的标记时用它 ✓）。 */
  composerProbeNodes: () => { center: ProbeNode; layer: ProbeNode; input: ProbeNode } | null
  /** ★★ 本轮追加：冒充"DSH 把输入框重渲染了"✓（换掉输入元素 ✓，层不动 ✓）。 */
  composerRerender: () => void
  /**
   * ★★ round 215 追加：`window.__dshmBack` ✓ —— **生产函数本体** ✓
   *   （壳在返回时调的就是它 ✓，不是测试另抄一份 ✓）。
   */
  back: () => (() => boolean) | undefined
  /** ★★ round 215 追加：假 DSH 树 ✓（只有传了 `dshBackProbe` 时才有 ✓）。 */
  dshBack: () => DshBackTree | null
  /**
   * ★★ round 215 追加：顶栏那颗「回到主会话」—— **生产造的那个元素** ✓
   *   （从夹具的 id 表里取 ✓，不是另抄一份 ✓）。
   * ★ 读"此刻显不显示"要读它的 **`dataset['dshmShown']`** ✓ ——
   *   生产写的是 `dataset.dshmShown` ✓（真 DOM 里它同时就是 `data-dshm-shown` 属性 ✓，
   *   CSS 那条规则读的正是它 ✓）；夹具这两者**不互通** ✓，读 `attrs` 会恒为 undefined ✗。
   * ★ 取它的 `listeners['click']` ✓ 就能**按它一下** ✓（夹具把 `addEventListener` 记下来了 ✓）。
   */
  backToMain: () => Record<string, unknown> | null
}

/**
 * ★★ 本轮（性能）追加：夹具用的**假节点** ✓ —— 只有本轮那两个探针要它 ✓。
 *
 * 为什么不能用既有的最小夹具 ✗：本文件上面那条注释写着"假 DOM 没有选择器引擎 ✓
 * （`querySelector` 恒为 null ✓）"—— 而本轮要量的**恰好是**"变动里的那个节点
 * 自己看不看得见 `.katex` / `_preview`"✓。选择器恒为 null 的话，"没扫"就可能只是
 * "夹具瞎了" ✗ = **假绿** ✓（本项目今天的头号教训 ✓）。所以这里给它一个**最小**选择器引擎 ✓，
 * 只认生产代码真的用到的那几个形状 ✓（`.类` / `[class*="子串"]` / `[属性="值"]` / 标签名 / 逗号 ✓）。
 */
interface ProbeNode {
  tagName: string
  nodeType: number
  className: string
  attrs: Record<string, string>
  dataset: Record<string, string>
  style: Record<string, unknown>
  children: ProbeNode[]
  parentElement: ProbeNode | null
  id: string
  textContent: string
  appendChild: (child: ProbeNode) => ProbeNode
  querySelector: (selector: string) => ProbeNode | null
  querySelectorAll: (selector: string) => ProbeNode[]
  getBoundingClientRect: () => { top: number; left: number; right: number; bottom: number; width: number; height: number }
  /**
   * ★★ 本轮追加的四样 ✓ —— 它们都是**生产代码真的会调**的方法 ✓
   *   （少一个，本轮那条路就会在夹具里抛错 ⇒ 测出来的是夹具坏了 ✗，不是产品坏了 ✓）：
   *   · `contains`   —— `clickDshCollapseControl` 算搜索范围时用 ✓；
   *   · `hasAttribute` / `removeAttribute` —— 面板那个语义属性 ✓（收起 = 摘掉它 ✓）；
   *   · `click`      —— `best.node.click()`（收起键 ✓）与面包屑按钮 ✓；
   *   · `getAttribute` / `setAttribute` —— 按 `aria-label` / `title` 找那颗收起键 ✓。
   */
  contains: (other: ProbeNode) => boolean
  hasAttribute: (name: string) => boolean
  removeAttribute: (name: string) => void
  getAttribute: (name: string) => string | null
  setAttribute: (name: string, value: string) => void
  click: () => void
  /** ★★ 本轮追加：`click()` 时生产之外要顺手做的事（记账 / 冒充 DSH 收起面板 ✓）。 */
  onClick?: () => void
}

/** ★★ 本轮追加：假观察器记下来的那一条 ✓（`callback` = 生产回调本体 ✓，不是复制品 ✓）。 */
interface ObservedWatcher {
  callback: (records: Array<{ addedNodes: ProbeNode[]; removedNodes: ProbeNode[] }>) => void
  target: unknown
  options: Record<string, unknown>
}

/**
 * ★★ 本轮追加：**最小**选择器匹配 ✓ —— 只认生产代码真的用到的形状 ✓：
 *   `.类名` ✓ / `[class*="子串"]` ✓ / `[属性="值"]` ✓ / **`[属性]`（存在性 ✓）** / 标签名 ✓ / 逗号分隔 ✓。
 *
 * ★ round 215 起改成**按 token 逐个判** ✓（原来只认单个前缀 ✓）—— 因为本轮新加的那条判据是
 *   **复合**的：`[data-sidebar-right-panel][data-sidebar-right-open]` ✓（两个存在性属性 ✓，
 *   生产就是这么写的 ✓）。只认前缀的话它会**恒不匹配** ✗ ⇒ "面板开着"在夹具里永远到不了 ✗
 *   ⇒ 那一条会变成**假绿** ✓（本项目今天的头号教训 ✓）。
 * 认不出来的（`link[rel="manifest"]` 这种组合 ✓）一律**不匹配** ✓ ——
 * 与"夹具原来恒为 null"等价 ✓，所以对既有用例零影响 ✓。
 */
function matchesProbeSelector(node: ProbeNode, raw: string): boolean {
  const selector = raw.trim()
  if (selector.length === 0) return false
  if (selector.includes(',')) return selector.split(',').some((part) => matchesProbeSelector(node, part))
  /**
   * ★ round 215：`*` = **全部后代** ✓（真 DOM 就是这条语义 ✓）——
   *   `dshSidebarRoot()` 正是用 `column.querySelectorAll('*')` 找那一列的根的 ✓。
   *   夹具认不出它 ⇒ 那一列**永远被当成"没展开"**✗ ⇒ `ensureSidebarExpanded()` 会去
   *   `dshToggleSidebar()` 点一颗带「侧栏」字样的按钮 ✓ —— 而假收起键的
   *   `aria-label` 正是「收起右侧边栏」✓，**撞上它那条兜底正则** ✓ ⇒
   *   夹具会在**启动时就把面板收掉** ✗（实测：还没按返回，面板标记就已经没了 ✓，
   *   于是"按一次返回"那条量到的是个假象 ✓）。这是**夹具**的问题 ✓
   *   （真机上侧栏是展开的 ✓、那条路一步都不走 ✓），所以这里补齐语义 ✓。
   */
  if (selector === '*') return true
  const tokens = selector.match(/\[[^\]]+\]|\.[^.[\]]+|[a-zA-Z][a-zA-Z0-9-]*/g)
  if (tokens === null || tokens.length === 0) return false
  return tokens.every((token) => {
    if (token.startsWith('.')) return node.className.split(/\s+/).includes(token.slice(1))
    if (token.startsWith('[')) {
      const classSub = /^\[class\*="([^"]*)"\]$/.exec(token)
      if (classSub !== null) return node.className.includes(classSub[1] ?? '')
      const attrEq = /^\[([a-zA-Z-]+)="([^"]*)"\]$/.exec(token)
      if (attrEq !== null) return node.attrs[attrEq[1] ?? ''] === attrEq[2]
      const attrPresent = /^\[([a-zA-Z-]+)\]$/.exec(token)
      if (attrPresent !== null) return Object.prototype.hasOwnProperty.call(node.attrs, attrPresent[1] ?? '')
      return false
    }
    return node.tagName.toLowerCase() === token.toLowerCase()
  })
}

/** ★★ 本轮追加：深度优先收**后代**里命中选择器的那些 ✓（不含自己 ✓，与 DOM 一致 ✓）。 */
function queryProbeDescendants(node: ProbeNode, selector: string): ProbeNode[] {
  const found: ProbeNode[] = []
  const walk = (current: ProbeNode): void => {
    for (const child of current.children) {
      if (matchesProbeSelector(child, selector)) found.push(child)
      walk(child)
    }
  }
  walk(node)
  return found
}

/**
 * ★★ 本轮追加：造一颗假节点 ✓（带 `children` / `parentElement` / 最小选择器引擎 ✓）。
 * ★ 默认 `nodeType: 1` ✓（真 DOM 里元素就是 1 ✓）；文本节点传 `3` ✓
 *   （`boot.js` 的守卫第一句就按它把文本节点排除 ✓ —— 那条也要能被测到 ✓）。
 */
function makeProbeNode(
  tagName: string,
  className: string,
  options: { attrs?: Record<string, string>; nodeType?: number; textContent?: string } = {},
): ProbeNode {
  const node: ProbeNode = {
    tagName,
    nodeType: options.nodeType ?? 1,
    className,
    attrs: options.attrs ?? {},
    dataset: {},
    style: {},
    children: [],
    parentElement: null,
    id: '',
    textContent: options.textContent ?? '',
    appendChild: (child: ProbeNode) => {
      child.parentElement = node
      node.children.push(child)
      return child
    },
    querySelector: (selector: string) => queryProbeDescendants(node, selector)[0] ?? null,
    querySelectorAll: (selector: string) => queryProbeDescendants(node, selector),
    getBoundingClientRect: () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }),
    /** ★★ 本轮追加：真 DOM 的 `Node.contains` ✓（含自己 ✓ —— `clickDshCollapseControl` 靠它算范围 ✓）。 */
    contains: (other: ProbeNode) => {
      let cursor: ProbeNode | null = other
      while (cursor !== null) {
        if (cursor === node) return true
        cursor = cursor.parentElement
      }
      return false
    },
    hasAttribute: (name: string) => Object.prototype.hasOwnProperty.call(node.attrs, name),
    removeAttribute: (name: string) => {
      delete node.attrs[name]
    },
    getAttribute: (name: string) => (Object.prototype.hasOwnProperty.call(node.attrs, name) ? node.attrs[name] ?? null : null),
    setAttribute: (name: string, value: string) => {
      node.attrs[name] = value
    },
    click: () => {
      if (node.onClick !== undefined) node.onClick()
    },
  }
  return node
}

/**
 * ★★ round 215：**假 DSH 顶栏 + 右侧栏面板** ✓ —— 本轮那三处判据都要有一份**真的 DOM**
 *   才验得到 ✗（本文件原来的 `document.querySelector` 恒为 null ✓ ⇒
 *   "面板开着"这个态在夹具里**根本到不了** ✓ = 那几条会变成假绿 ✓）。
 *
 * 形状照真机实测（写在这里，省得下次再猜 ✗）：
 *   · `[data-dshm-topheader]` 里挂着面包屑 `span.*_crumbSeg` ✓（格数 = 层级 ✓，
 *     `deriveAncestry()` 只在子代理会话里给 ≥2 格 ✓）；
 *   · 右侧栏面板挂 `data-sidebar-right-panel` ✓，**展开时**才多一个
 *     `data-sidebar-right-open` ✓ —— 「收起」= DSH 自己把那个属性摘掉 ✓。
 *
 * ★ 那颗假收起键**真的会摘掉属性** ✓（不只是一根计数器 ✓）——
 *   所以"按一次返回 ⇒ 面板标记消失"量的是**因果** ✓，不是"某个字符串还在不在" ✗。
 */
interface DshBackTree {
  root: ProbeNode
  header: ProbeNode
  panel: ProbeNode
  /** 那颗「收起右侧边栏」被生产代码点了几次 ✓。 */
  collapseClicks: () => number
  /** 面包屑上那颗「上一级」被生产代码点了几次 ✓（= 真的退回了一层 ✓）。 */
  crumbClicks: () => number
  /** 冒充"用户在 DSH 里进了 / 退出了子单"✓：把面包屑改成 `count` 格 ✓。 */
  setCrumbs: (count: number) => void
}

function makeDshBackTree(options: { crumbs?: number; panelOpen?: boolean }): DshBackTree {
  const root = makeProbeNode('div', 'probeAppRoot')
  /**
   * ★ 侧栏那一列也要给 ✓（**展开态** ✓）—— `ensureSidebarExpanded()` 先问
   *   `dshSidebarExpanded()` ✓（= 那一列的根不带 `*_collapsed` ✓）；
   *   少了它 ⇒ 启动时会去点一颗带「侧栏」字样的按钮 ✓ ⇒ 正好点中下面那颗假收起键 ✗
   *   ⇒ 面板在**还没按返回时**就被收掉了 ✓（实测踩到过 ✓，见 `matchesProbeSelector` 里那段 ✓）。
   */
  const sidebar = makeProbeNode('div', 'probe_sidebarCol')
  const sidebarRoot = makeProbeNode('div', 'probe_root')
  sidebar.appendChild(sidebarRoot)
  root.appendChild(sidebar)
  const header = makeProbeNode('div', 'probePageHead', { attrs: { 'data-dshm-topheader': '1' } })
  root.appendChild(header)
  const nav = makeProbeNode('div', 'probeCrumbs')
  header.appendChild(nav)

  const panel = makeProbeNode('div', 'probeRightCol', { attrs: { 'data-sidebar-right-panel': '' } })
  root.appendChild(panel)
  if (options.panelOpen === true) panel.attrs['data-sidebar-right-open'] = ''

  let collapseClicks = 0
  const collapse = makeProbeNode('button', 'probeIconButton', { attrs: { 'aria-label': '收起右侧边栏' } })
  // ★ 生产会先量它的 rect（`rect.width <= 0` 就跳过 ✓）⇒ 不给尺寸就等于"那颗键不存在" ✗
  collapse.getBoundingClientRect = () => ({ top: 8, left: 300, right: 340, bottom: 48, width: 40, height: 40 })
  collapse.onClick = () => {
    collapseClicks += 1
    // ★ 冒充 DSH：收起 = **摘掉那个语义属性** ✓（它同时是"面板还开着吗"的唯一判据 ✓）
    delete panel.attrs['data-sidebar-right-open']
  }
  panel.appendChild(collapse)

  let crumbClicks = 0
  const setCrumbs = (count: number): void => {
    nav.children.length = 0
    for (let index = 0; index < count; index++) {
      const seg = makeProbeNode('span', 'probe_crumbSeg')
      const button = makeProbeNode('button', 'probeCrumbButton')
      button.onClick = () => {
        crumbClicks += 1
      }
      seg.appendChild(button)
      nav.appendChild(seg)
    }
  }
  setCrumbs(options.crumbs ?? 0)

  return {
    root,
    header,
    panel,
    collapseClicks: () => collapseClicks,
    crumbClicks: () => crumbClicks,
    setCrumbs,
  }
}

/**
 * ★★ 本轮追加：从假观察器里挑出**预览那一个** ✓。
 *
 * ★ 为什么不能只按 `{childList, subtree}` 找 ✗（**这个坑我自己当场踩了 ✓**）：
 *   `boot.js` 里还有别的观察器也是 `body + childList + subtree` ✓（设置面板那条 ✓、
 *   模型菜单那条 ✓）⇒ 按选项找会拿到**别人** ✓。实测第一版就是这么写的 ✓：
 *   "给预览类节点 ⇒ 必须扫"当场红 ✓，而"没有预览类节点 ⇒ 不扫"**假绿** ✓✗
 *   —— 它压根没把那条变动递给预览观察器 ✓（正是本项目头号教训的样子 ✓）。
 *   ⇒ 判据改成"**回调本体**把 `records` 递给 `runPreviewWatch`" ✓ ——
 *   这是**可执行代码的形状** ✓（不是注释 ✓），也正是上面结构那条断言钉住的形状 ✓。
 */
function findPreviewWatcher(surface: Surface): ObservedWatcher {
  const watcher = surface.observers.find(
    (observed) =>
      observed.options['childList'] === true &&
      observed.options['subtree'] === true &&
      String(observed.callback).includes('runPreviewWatch(records)'),
  )
  assert.ok(
    watcher !== undefined,
    '★ 必须找得到**预览那条**观察器（判据：回调把 records 递给 runPreviewWatch ✓）',
  )
  return watcher
}

/** ★★ 方案 A：`sideChannels()` 的形状 ✓（断言打在**生产函数**的返回值上 ✓）。 */
interface SideChannelReadout {
  fingerprint: string | null
  label: string
  endpoints: string[]
  activeEndpoint: string | null
  state: string | null
  rejected: boolean
  unsupported: boolean
  polls: number
}

/** ★★ R5：`identityDiagnostics()` 的形状 ✓（断言打在**生产函数**的返回值上 ✓）。 */
interface IdentityDiagnostics {
  fingerprint: string | null
  fingerprintShort: string
  why: string
  restore: string
  restoreOk: boolean
  hosts: Array<{
    fingerprint: string
    fingerprintShort: string
    label: string
    slots: string[]
    active: boolean
  }>
  cleared: Record<string, unknown> | null
  clearedText: string
  vaultKeys: string[]
}

/**
 * 用最小假 DOM 把 boot.js 跑起来，重点覆盖"手机表面"这一支。
 *
 * ★ round 185 追加了四个**可选**参数 ✓（全部有默认值 ✓ —— 不传时行为与原来逐字一致 ✓，
 *   既有用例一个字都没动 ✓）：它们让新用例能真的驱动一轮 poll ✓、冒充原生壳 ✓、
 *   以及把 localStorage 打瘸 ✓。
 */
function bootOnSurface(options: {
  pathname: string
  innerWidth: number
  consent: string[]
  readyState?: string
  /**
   * ★ 本轮追加：`location.search` ✓（默认 `?debug=1` ✓ —— 不传时与原来逐字一致 ✓）。
   *   R1b 那条用例要靠它塞一张**真的配对票据**（`?pair=<base64url(票据 JSON)>` ✓）——
   *   产品的 `readUrlConfig()` 只从查询串读票据 ✓，没有这个口子就验不到
   *   "配对落盘时 endpoints 还在不在"✗。
   */
  search?: string
  /**
   * ★ 本轮追加：`location.host` ✓（默认 `10.34.221.181:3443` ✓ —— 不传时与原来逐字一致 ✓）。
   *   **换源**在真机上就是"换一个 authority"✓ ⇒ 只有能换 host，才验得到
   *   "同一台电脑的两个地址互相认不认得出"✓（一个沙箱 = 一个源 ✓、共享同一个壳 ✓）。
   */
  host?: string
  /** ★ 追加：预装一个假隧道 ✓（塞进 `__DSH_TRANSPORT__` ✓ ⇒ poll 会真的取待办并逐条执行 ✓）。 */
  transport?: Record<string, unknown>
  /** ★ 追加：冒充原生壳 ✓（`DshmShell` ✓ —— 形状照 scripts/check-device-channel.mjs ✓）。 */
  shell?: Record<string, unknown>
  /** ★ 追加：让 localStorage 对**取证那个键**读写都抛错 ✓（验"落盘坏了也不许炸"✓）。 */
  storageThrowsForLog?: boolean
  /** ★ 追加：沙箱里的定时器 unref ✓ —— 免得 drawBar 那个 15 秒清理定时器把测试进程挂住 ✓。 */
  unrefTimers?: boolean
  /**
   * ★★ 本轮追加：把**网页那条剪贴板路**打桩成"可用"✓（默认不打桩 ⇒ 不传时与原来逐字一致 ✓）。
   *
   * 为什么需要 ✗：本沙箱的 `navigator` 原来**没有** `clipboard` ✓、`document` **没有**
   * `execCommand` ✓ ⇒ "没壳 + 剪贴板真的写进去了"这一态在测试里**根本到不了** ✗
   * （只能到"两条路都不行"的降级横幅 ✓），而本轮新加的那条"**无壳** ⇒ 退页面提示条"正好要它 ✓。
   */
  webClipboard?: boolean
  /**
   * ★★ 方案 A 追加：`localStorage` 的**种子** ✓（默认空 ⇒ 不传时与原来逐字一致 ✓）。
   *
   * 为什么需要 ✗：旁挂隧道**只在启动时**建 ✓（`startSideTunnels` ✓）——
   * 它读的是「宿主目录 + 本机到底持有哪几台的凭据」✓，那两样都必须**在 boot 之前**就在
   * localStorage 里 ✓；像 R1a 那几条用例那样「跑起来之后再种」是**来不及**的 ✗。
   */
  seed?: Record<string, string>
  /**
   * ★★ 方案 A 追加：`WebSocket` 换成**真宿主那套替身** ✓（`ReplaySocket` ✓，
   *   默认仍是那个什么都不做的桩 ⇒ 不传时与原来逐字一致 ✓）。
   *
   * 为什么需要 ✗：要证明「两条隧道各自取各自队列」必须让**真的握手**跑起来 ✓ ——
   * 本文件既有的 `ReplaySocket` + 真 `TunnelSession` 就是干这个的 ✓（见 `bootReplayWorld` ✓）。
   */
  webSocket?: unknown
  /**
   * ★★ 本轮（性能）追加：把 `MutationObserver` / `requestAnimationFrame` 换成
   *   **可注入的假货** ✓（默认仍是原来那个什么都不做的桩 ✓ —— 不传时既有用例逐字不变 ✓）。
   *
   * 为什么需要 ✗：本轮修的那条路是"**观察器回调先判类、再决定扫不扫**"✓ ——
   *   原来的桩 `observe() {}` 把回调**吞了** ✗，于是"扫没扫"在测试里**根本到不了** ✓。
   *   有它之后，测试能自己造一条 `MutationRecord` 递进**生产回调** ✓（不起浏览器 ✓）。
   */
  previewWatchProbe?: boolean
  /**
   * ★★ 本轮追加：沙箱里给一套**假输入区**（对话列 + 可滚层 + 输入框 ✓）+ 会记账的
   *   `getComputedStyle` ✓（默认不装 ⇒ 不传时既有用例逐字不变 ✓）。
   *
   * 为什么需要 ✗：要证明"**输入区没变就不跑**"必须能数**调用次数** ✓ ——
   *   而原来的夹具里 `document.querySelector` 恒为 null ✓ ⇒ `tuneComposerScroll` 第一句就返回 ✓
   *   （一辈子都不跑 ✓，也就永远测不到"跑了几次"✗）。
   */
  composerProbe?: boolean
  /**
   * ★★ round 215：给沙箱一份**假 DSH 顶栏 + 右侧栏面板** ✓（默认不建 ⇒ 不传时既有用例逐字不变 ✓）。
   *
   * 为什么需要 ✗：本轮修的是"**面板开着 ⇒ 返回键得管它**"✓ ——
   *   而原来的夹具里 `document.querySelector` 恒为 null ✓ ⇒ "面板开着"这个态
   *   在测试里**根本到不了** ✗ ⇒ 那几条断言会变成**假绿** ✓（今天的头号教训 ✓）。
   *
   *   · `crumbs` = 面包屑格数 ✓（≥2 = 在子单层级里 ✓，1 = 主单 ✓）；
   *   · `panelOpen` = 面板带不带 `data-sidebar-right-open` ✓。
   */
  dshBackProbe?: { crumbs?: number; panelOpen?: boolean }
}): Surface {
  const boxText: string[] = []
  const intervals: Array<() => void> = []
  const thrown: unknown[] = []
  /** ★★ 本轮追加：假观察器 / 假帧队列 / 全文档扫描计数 / 逐层量样式计数 ✓。 */
  const observers: ObservedWatcher[] = []
  const frames: Array<() => void> = []
  const documentQueries: string[] = []
  let composerStyleProbes = 0

  const registry = new Map<string, Record<string, unknown>>()
  const makeElement = (tag: string): Record<string, unknown> => {
    const element: Record<string, unknown> = {
      tagName: tag,
      id: '',
      style: {},
      dataset: {},
      className: '',
      children: [],
      textContent: '',
      /**
       * ★ 剪贴板原生桥追加：把 `setAttribute` 写下的东西**记下来** ✓（原先是个空函数 ✗）。
       *   为什么现在要 ✗：本轮的降级横幅要靠 `data-dshm-clipboard-text` 把"正文那一块"
       *   认出来 ✓（见 `packages/client/src/boot.js` 的 clipboard 分支 ✓），
       *   而假 DOM 没有选择器引擎 ✗ —— 不记属性就没有任何办法从测试这一侧指认它 ✗。
       *   `FakeElement` 接口里本来就声明了 `attrs` ✓（只是最小夹具没建它 ✓），
       *   这里补上等于**把夹具对齐到它自己的接口** ✓，对既有用例零影响 ✓（它们都不读属性 ✓）。
       */
      attrs: {},
      setAttribute: (name: string, value: unknown) => {
        ;(element['attrs'] as Record<string, string>)[String(name)] = String(value)
      },
      /**
       * ★★ round 215：补上 `getAttribute` ✓ —— 同样是**把夹具对齐到它自己的接口**
       *   （`FakeElement` 里早就声明了它 ✓，只是最小夹具没建 ✓）。
       *
       * 为什么非补不可 ✗：`syncDrawer()` 里有一句 `nav.getAttribute('aria-expanded')` ✓，
       *   而 `nav` 正是我们自己的顶栏按钮（`makeElement` 造的 ✓）—— 没有这个方法就
       *   `TypeError` ✗ ⇒ `installShell` 又在 `mount()` **之前**抛掉 ✗ ⇒
       *   `mount()` / `startObserving()` / `schedule()` 全都跑不到 ✓
       *   ⇒ 本轮"那颗键显不显示"的行为断言只会量到初值 ✓ = **假绿** ✓
       *   （实测抓到的 ✓：`installShell` 抛的就是这一句 ✓）。
       * ★ 对既有用例零影响 ✓：它们本来就先撞在 `applyPush()`（`documentElement.style` ✓）
       *   那一步上、走不到这一句 ✓；而未设置的属性返回 `null` ✓ 正是真 DOM 的答案 ✓。
       */
      getAttribute: (name: string) => {
        const attrs = element['attrs'] as Record<string, string>
        return Object.prototype.hasOwnProperty.call(attrs, String(name)) ? attrs[String(name)] ?? null : null
      },
      removeAttribute: () => {},
      /**
       * ★★ round 215：把 `addEventListener` 挂上去的回调**记下来** ✓（原先是个空函数 ✗）。
       *   为什么现在要 ✗：顶栏那颗「回到主会话」的动作是**用 `addEventListener` 挂的** ✓
       *   （与 ☰ / 文件夹那两颗同一个写法 ✓）—— 不记下来就没法按它一下 ✗，
       *   而"按下之后两件事都发生了吗"正是本轮最值钱的那条断言 ✓。
       *   `FakeElement` 接口里本来就声明了 `listeners` ✓（只是最小夹具没建它 ✓）——
       *   这里同样是**把夹具对齐到它自己的接口** ✓，对既有用例零影响 ✓。
       */
      listeners: {},
      addEventListener: (type: string, run: (event?: unknown) => void) => {
        const bucket = element['listeners'] as Record<string, Array<(event?: unknown) => void>>
        if (bucket[type] === undefined) bucket[type] = []
        bucket[type].push(run)
      },
      removeEventListener: () => {},
      remove: () => {},
      querySelector: () => null,
      querySelectorAll: () => [],
      getBoundingClientRect: () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }),
      appendChild(child: Record<string, unknown>) {
        ;(element['children'] as unknown[]).push(child)
        if (typeof child['id'] === 'string' && child['id'].length > 0) registry.set(child['id'], child)
        return child
      },
      insertBefore(child: Record<string, unknown>) {
        return (element['appendChild'] as (c: unknown) => unknown)(child)
      },
    }
    return element
  }
  const body = makeElement('body')
  // 调试框正文通过 defineProperty 收集：boot.js 是 `box.textContent = ...` 整体赋值，
  // 直接抓赋值就能拿到它想显示的全部内容（与手机上看到的完全一致）。
  const realAppend = body['appendChild'] as (child: Record<string, unknown>) => unknown
  body['appendChild'] = (child: Record<string, unknown>) => {
    if (child['id'] === 'dshm-upload-debug') {
      Object.defineProperty(child, 'textContent', {
        get: () => boxText.join('\n'),
        set: (value: string) => {
          boxText.length = 0
          boxText.push(value)
        },
        configurable: true,
      })
    }
    return realAppend(child)
  }

  const store = new Map<string, string>([['dsh-mobile.debug', '1']])
  for (const capability of options.consent) store.set('dsh-mobile.deviceEnabled.' + capability, 'yes')
  // ★★ 方案 A：启动前就把种子放进去 ✓（旁挂隧道只在启动时建 ✓ —— 见那个选项的说明 ✓）。
  if (options.seed !== undefined) {
    for (const [key, value] of Object.entries(options.seed)) store.set(key, value)
  }

  /**
   * ★★ 本轮追加：假输入区 ✓（只有 `composerProbe` 时才建 ✓，其余用例一个字不变 ✓）：
   *   `center`（对话列 ✓）→ `layer`（DSH 自己声明 `overflow-y: auto` 的那一层 ✓）→ `input`（输入框 ✓）。
   * ★ 三层的**类名**都照着生产代码真的在找的形状给 ✓：对话列含 `centerCol` ✓
   *   （`document.querySelector('[class*="centerCol"]')` ✓）、可滚层含 `_scroll` ✓
   *   （`getComputedStyle` 桩对它回 `overflow-y: auto` ✓ ⇒ 走"给这一层限高"那一支 ✓）。
   * ★ 三层都带 `parentElement` ✓ ⇒ 生产代码那条签名链「输入元素 → 对话列」走得出来 ✓。
   */
  const composer =
    options.composerProbe === true
      ? (() => {
          const center = makeProbeNode('div', 'uV2eYG_centerCol')
          const layer = makeProbeNode('div', 'uV2eYG_scroll')
          const input = makeProbeNode('div', 'uV2eYG_input', { attrs: { contenteditable: 'true' } })
          center.appendChild(layer)
          layer.appendChild(input)
          return { center, layer, input }
        })()
      : null

  /**
   * ★★ round 215：假 DSH 树 ✓（只有 `dshBackProbe` 时才建 ✓ —— 不传时 `document.querySelector`
   *   与原来**逐字等价** ✓ ⇒ 既有用例一个字节都不变 ✓）。
   */
  const dshBack = options.dshBackProbe === undefined ? null : makeDshBackTree(options.dshBackProbe)

  const documentStub = {
    readyState: options.readyState ?? 'complete',
    body,
    head: makeElement('head'),
    documentElement: makeElement('html'),
    getElementById: (id: string) => registry.get(id) ?? null,
    /**
     * ★ 只有 `composerProbe` 那条用例才认得对话列 ✓；`dshBackProbe` 那条才认得假 DSH 树 ✓
     *   —— 其余选择器照旧恒为 null ✓（与这个夹具原来的样子逐字等价 ✓）。
     */
    querySelector: (selector: string) => {
      if (composer !== null && selector === '[class*="centerCol"]') return composer.center
      if (dshBack !== null) return queryProbeDescendants(dshBack.root, selector)[0] ?? null
      return null
    },
    /**
     * ★★ 本轮追加：**把它查过的选择器全记下来** ✓ —— 返回值照旧是空表 ✓
     *   （既有用例看到的完全一样 ✓）。`previewScans()` 数的就是这里面含 `katex` 的那几次 ✓：
     *   全文件只有 `dshPreviewSurface()` 起手会扫 `.katex` ✓ ⇒ **数次数 = 数扫描次数** ✓。
     * ★ round 215：有假 DSH 树时，这里返回**树上命中的那些** ✓ ——
     *   那颗「收起右侧边栏」就在其中 ✓（否则生产代码永远找不到它 ✗）。
     */
    querySelectorAll: (selector: string) => {
      documentQueries.push(String(selector))
      return dshBack === null ? [] : queryProbeDescendants(dshBack.root, selector)
    },
    createElement: (tag: string) => makeElement(tag),
    createTextNode: (text: string) => ({ textContent: text }),
    addEventListener: () => {},
    removeEventListener: () => {},
  }

  /**
   * ★★ round 215：给假 `<html>` 补上**行内样式的三个方法** ✓（真 DOM 的 `style` 本来就有 ✓）。
   *
   * ## 为什么非有不可 ✗（这是本轮**实测**抓到的一个夹具缺口 ✓）
   * `installShell` 里 `mount()` 之前会走 `syncDrawer()` → `applyPush()` ✓，而它读的是
   * `document.documentElement.style.getPropertyValue('--dshm-push')` ✓ ——
   * 夹具那个 `style` 是个**空对象** ✗ ⇒ `TypeError` ⇒ `installShell` 整体抛错 ✗
   * ⇒ 被上一层的 `catch` 吞掉（`console.error` 在夹具里是空的 ✓）⇒
   * **`mount()` 从来没跑过** ✗ ⇒ `startObserving()` / `schedule()` 也从来没跑过 ✓。
   * 对本轮意味着：顶栏那颗键的**显/隐（`syncBackToMainButton()`）**一次都不会被调到 ✗
   * ⇒ 那条行为断言只会量到初值 ✓ = **假绿** ✓（今天的头号教训 ✓）。
   *
   * ## 为什么只在这条用例上补 ✗
   * 补上它 ⇒ `mount()` 会**真的跑起来** ✓（对本轮是好事 ✓：量到的就是线上那条路 ✓）。
   * 但那会顺带改变**既有**探针用例的执行路径 ✗（它们现在都在 `mount()` 抛错之后停着 ✓）——
   * 一单只碰两个文件、且"不许新增红" ✗ ⇒ 这里**只在 `dshBackProbe` 那条路上补** ✓，
   * 既有用例看到的字节级不变 ✓。
   */
  if (options.dshBackProbe !== undefined) {
    const htmlStyle = documentStub.documentElement['style'] as Record<string, unknown>
    htmlStyle['getPropertyValue'] = () => ''
    htmlStyle['setProperty'] = () => {}
    htmlStyle['removeProperty'] = () => {}
  }

  const sandbox: Record<string, unknown> = {
    console: { info: () => {}, warn: () => {}, error: () => {}, log: () => {} },
    crypto: globalThis.crypto,
    TextEncoder,
    TextDecoder,
    Response,
    Request,
    Headers,
    URL,
    URLSearchParams,
    Blob: globalThis.Blob,
    // ★ 追加（round 185）：默认就是真实 setTimeout ✓（与原来一致 ✓）；只有新用例传
    //   unrefTimers 时才顺手 unref ✓ —— boot.js 里 drawBar 会给横幅挂一个 15 秒的清理
    //   定时器 ✓（notify 那条分支必然走到它 ✓），不 unref 的话整个测试进程要陪它多活
    //   15 秒 ✓（unref 的定时器照样按时触发 ✓，只是不撑着事件循环 ✓）。
    setTimeout: (handler: () => void, ms?: number): unknown => {
      const handle = setTimeout(handler, ms)
      if (options.unrefTimers === true) {
        const unref = (handle as { unref?: () => void }).unref
        if (typeof unref === 'function') unref.call(handle)
      }
      return handle
    },
    clearTimeout,
    // 不真的排程：测试自己挑时机调用回调，这样"回调抛错"能被断言捕获，
    // 而且测试进程不会因为一个永不停止的 interval 挂住（direct.test.ts 踩过这个坑）。
    setInterval: (fn: () => void) => {
      intervals.push(fn)
      return intervals.length
    },
    clearInterval: () => {},
    atob: (value: string) => Buffer.from(value, 'base64').toString('binary'),
    btoa: (value: string) => Buffer.from(value, 'binary').toString('base64'),
    location: {
      origin: 'https://' + (options.host ?? '10.34.221.181:3443'),
      protocol: 'https:',
      host: options.host ?? '10.34.221.181:3443',
      pathname: options.pathname,
      search: options.search ?? '?debug=1',
      href: 'https://' + (options.host ?? '10.34.221.181:3443') + options.pathname + (options.search ?? '?debug=1'),
    },
    document: documentStub,
    localStorage: {
      getItem: (key: string) => {
        // ★ 只打瘸**取证那个键** ✓：把 localStorage 整体打瘸的话，device channel 在装载期
        //   读同意记录那一行就先抛了 ✗（那是**既有**行为 ✓，本轮不动 ✗）⇒
        //   那样测到的就不是"取证坏了会怎样"✓。所以只让这一个键抛 ✓。
        if (options.storageThrowsForLog === true && key === 'dsh-mobile.deviceCallLog') {
          throw new Error('打桩：localStorage 读失败')
        }
        return store.get(key) ?? null
      },
      setItem: (key: string, value: string) => {
        if (options.storageThrowsForLog === true && key === 'dsh-mobile.deviceCallLog') {
          throw new Error('打桩：localStorage 写失败')
        }
        store.set(key, String(value))
      },
      removeItem: (key: string) => void store.delete(key),
      clear: () => store.clear(),
    },
    history: { replaceState: () => {}, pushState: () => {} },
    /**
     * ★★ 本轮追加：`webClipboard` 打开时给一条**能写进去**的网页剪贴板路 ✓
     *   （`navigator.clipboard.writeText` ✓ —— 生产代码判的就是这个属性 ✓，见 `copyText` ✓）。
     *   默认（不传）时这一个键**压根不存在** ✓ ⇒ 既有用例看到的东西与原来逐字一致 ✓。
     */
    navigator: {
      userAgent: 'Mozilla/5.0 (Linux; Android 10; K)',
      vibrate: () => true,
      ...(options.webClipboard === true ? { clipboard: { writeText: async () => undefined } } : {}),
    },
    Notification: { permission: 'granted', requestPermission: async () => 'granted' },
    /**
     * ★★ 方案 A：默认仍是那个**什么都不做**的桩 ✓（不传 `webSocket` 时与原来逐字一致 ✓）；
     *   传了就换成 `ReplaySocket` ✓ —— 真的把字节交给宿主侧的 `TunnelSession` ✓。
     */
    WebSocket: options.webSocket ?? class {
      readyState = 0
      binaryType = 'blob'
      send() {}
      close() {}
      addEventListener() {}
      removeEventListener() {}
    },
    fetch: async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }),
    MutationObserver:
      options.previewWatchProbe === true
        ? class {
            callback: (records: Array<{ addedNodes: ProbeNode[]; removedNodes: ProbeNode[] }>) => void
            constructor(
              callback: (records: Array<{ addedNodes: ProbeNode[]; removedNodes: ProbeNode[] }>) => void,
            ) {
              this.callback = callback
            }
            observe(target: unknown, observeOptions: Record<string, unknown>) {
              // ★ 记下**生产回调本体** ✓ —— 测试自己造 MutationRecord 递进去 ✓（不真的排帧 ✓）。
              observers.push({ callback: this.callback, target, options: observeOptions })
            }
            disconnect() {}
          }
        : class {
            observe() {}
            disconnect() {}
          },
    ...(options.previewWatchProbe === true
      ? {
          // ★★ 本轮追加：帧**不真的排** ✓ —— 测试自己挑时机 `flushFrames()` ✓（与 setInterval 同一个手法 ✓）。
          requestAnimationFrame: (callback: () => void): unknown => {
            frames.push(callback)
            return frames.length
          },
          cancelAnimationFrame: () => {},
        }
      : {}),
    ...(options.composerProbe === true
      ? {
          /**
           * ★★ 本轮追加：会记账的 `getComputedStyle` ✓ —— 只有 `composerProbe` 时才存在 ✓
           *   （既有用例里它压根不存在 ✓ ⇒ 行为逐字不变 ✓）。
           *   判据形状照生产代码真的在读的：`overflowY` ✓ —— 含 `_scroll` 的那层回 `auto` ✓。
           */
          getComputedStyle: (node: ProbeNode) => {
            composerStyleProbes += 1
            return {
              overflowY: String(node.className || '').includes('_scroll') ? 'auto' : 'visible',
              display: 'block',
              visibility: 'visible',
              opacity: '1',
            }
          },
        }
      : {}),
    /**
     * ★★ round 215：`dshBackProbe` 这条也要一个 `getComputedStyle` ✓ ——
     *   `clickDshCollapseControl()` 会拿它把"看不见的键"筛掉 ✓
     *   （夹具里**没有** `getComputedStyle` 时那句会抛 ⇒ 被内层 catch 吞掉 ⇒ 一个键都点不到 ✗
     *   ⇒ 测出来会是"生产代码没点"✗，而真相是"夹具没给这个函数" ✓ —— 那正是假绿的样子 ✓）。
     *   `composerProbe` 与它不会同时传 ✓（同时传时**后者生效** ✓，两条用例互不影响 ✓）。
     */
    ...(options.dshBackProbe !== undefined
      ? {
          getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1', position: 'static' }),
        }
      : {}),
    innerWidth: options.innerWidth,
    innerHeight: 915,
    isSecureContext: true,
    matchMedia: () => ({ matches: true, addEventListener: () => {}, removeEventListener: () => {} }),
    addEventListener: () => {},
    removeEventListener: () => {},
    performance: globalThis.performance,
  }
  sandbox['globalThis'] = sandbox
  sandbox['window'] = sandbox
  sandbox['self'] = sandbox
  // ★ 追加（round 185）：预装假隧道 / 假壳 ✓ —— 必须在 runInNewContext **之前**塞进去 ✓，
  //   因为 installPlaceholderTransport 只在"还没有 __DSH_TRANSPORT__"时才装占位层 ✓
  //   （先塞 ⇒ 它原样留着 ✓ ⇒ poll 走的就是生产那条 RPC 路 ✓）。
  if (options.transport !== undefined) sandbox['__DSH_TRANSPORT__'] = options.transport
  if (options.shell !== undefined) sandbox['DshmShell'] = options.shell

  try {
    runInNewContext(bootSource, sandbox, { filename: 'boot.js' })
  } catch (error) {
    thrown.push(error)
  }
  return {
    boxText: () => boxText.join('\n'),
    intervals,
    thrown,
    internals: sandbox['__DSH_MOBILE_INTERNALS__'] as Surface['internals'],
    boot: sandbox['__DSH_MOBILE_BOOT__'] as Surface['boot'],
    storage: store,
    infoBanner: () =>
      (body['children'] as Array<Record<string, unknown>>)
        .filter((bar) => (bar['attrs'] as Record<string, string>)['data-dshm-banner'] === 'info')
        .flatMap((bar) =>
          (bar['children'] as Array<Record<string, unknown>>).map((child) => ({
            attrs: (child['attrs'] ?? {}) as Record<string, string>,
            text: String(child['textContent'] ?? ''),
            css: String(((child['style'] ?? {}) as Record<string, unknown>)['cssText'] ?? ''),
          })),
        ),
    toastText: () => {
      const box = registry.get('dshm-shell-toast')
      return box === undefined ? null : String(box['textContent'] ?? '')
    },
    // ── ★★ 本轮（性能）追加的那几个探针 ✓（默认全空 ✓ —— 不传选项时既有用例看到的一模一样 ✓）──
    observers,
    frames,
    flushFrames: () => {
      // ★ 只跑**这一刻**排队的那几帧 ✓（生产代码一帧只排一次 ✓；跑的过程中新排的留在队列里 ✓）
      const queued = frames.splice(0, frames.length)
      for (const frame of queued) frame()
    },
    previewScans: () => documentQueries.filter((selector) => selector.includes('katex')).length,
    composerStyleProbes: () => composerStyleProbes,
    composerProbeNodes: () => composer,
    composerRerender: () => {
      if (composer === null) return
      // ★ 冒充"DSH 把输入框重渲染了"✓：**换掉输入元素** ✓（层不动 ✓ ⇒ 链的身份变了 ✓）。
      const fresh = makeProbeNode('div', 'uV2eYG_input', { attrs: { contenteditable: 'true' } })
      composer.layer.children = [fresh]
      fresh.parentElement = composer.layer
      composer.input = fresh
    },
    // ── ★★ round 215 追加的那三个口子 ✓（默认全 null ✓ —— 不传选项时既有用例看到的逐字不变 ✓）──
    back: () => sandbox['__dshmBack'] as (() => boolean) | undefined,
    dshBack: () => dshBack,
    backToMain: () => (registry.get('dsh-mobile-back-main') as Record<string, unknown> | undefined) ?? null,
  }
}

test('手机表面（/mobile/app）会注册轮询定时器', () => {
  const surface = bootOnSurface({ pathname: '/mobile/app', innerWidth: 412, consent: [] })
  assert.equal(surface.thrown.length, 0, `顶层不应抛错：${String(surface.thrown[0])}`)
  assert.ok(surface.intervals.length > 0, '端侧通道应在手机表面注册轮询定时器')
})

test('★ 定时器回调执行不抛错（`unsupported` 未声明那个 bug 的回归守卫）', () => {
  const surface = bootOnSurface({ pathname: '/mobile/app', innerWidth: 412, consent: ['show', 'notify'] })
  // noUncheckedIndexedAccess 下 `intervals[0]` 是 `(() => void) | undefined`：
  // 先把元素取出来并让 `assert.ok` 收窄类型，再去调用。
  // （也顺带把"一个定时器都没注册"这种失败在断言文案里说清楚。）
  const onTick = surface.intervals[0]
  assert.ok(onTick !== undefined, '端侧通道应至少注册一个轮询定时器')
  // 逐次调用定时器回调。修复前这里是 ReferenceError: unsupported is not defined，
  // 而且抛在 poll() 之前 —— 端侧通道从来没有轮询过一次。
  for (let tick = 0; tick < 3; tick++) {
    assert.doesNotThrow(() => onTick(), `第 ${tick + 1} 次定时器回调不应抛错`)
  }
})

test('定时器回调真的走到轮询逻辑（调试框里能看到轮询痕迹）', async () => {
  const surface = bootOnSurface({ pathname: '/mobile/app', innerWidth: 412, consent: ['show', 'notify'] })
  const onTick = surface.intervals[0]
  assert.ok(onTick !== undefined, '端侧通道应至少注册一个轮询定时器')
  onTick()
  // poll() 是 async：等微任务与等待隧道的那一轮跑完
  await new Promise((resolve) => setTimeout(resolve, 30))
  const box = surface.boxText()
  assert.match(box, /端侧通道已装载/, `调试框应含装载行，实际：\n${box}`)
  assert.match(box, /轮询#1/, `定时器回调后应出现轮询痕迹，实际：\n${box}`)
})

test('非手机表面不注册轮询定时器（避免在电脑浏览器上白跑）', () => {
  const surface = bootOnSurface({ pathname: '/', innerWidth: 1440, consent: [] })
  assert.equal(surface.intervals.length, 0, '宽屏且非 /mobile/app 时不应注册轮询')
})

/**
 * ★★ round 184：**帧长不匹配必须被记下来** ✓ —— 用户 2026-09-29 真机报的那条 ✓。
 *
 * 症状（用户原话）："我在**小退再进**以后，发消息提示**帧长不同步**，确实我的消息没有上手机的
 * 聊天界面，但电脑上可以看到我已经发了消息" ✓。
 *
 * 为什么这条测试值得单独写 ✗：那种时候**隧道一直报 `connected`** ✓（socket 活着、RPC 也通 ✓），
 * 坏的只有**帧长解析器** ⇒ 既有的前台自愈（判据是 `state() !== 'connected'` ✗）**永远不触发** ✗
 * ⇒ 页面卡在"看着像好的、其实再也不更新"✓，用户只能"退出重进"自救 ✗。
 * ⇒ 修法就是**记下这个时刻** ✓，让自愈据它重载页面 ✓（`selfHealDecision` 里排在那条之前 ✓）。
 *
 * ★ 这里断言的是**生产函数**（`__DSH_MOBILE_INTERNALS__.parseFrame` ✓）而不是复制品 ✓。
 * ★ 本条覆盖"**记没记住**"这一半 ✓；"记住之后自愈会不会重载"那一半在本沙箱里**测不了** ✗
 *   —— 本沙箱没有壳桥（`DshmShell` ✗），`selfHealDecision` 会在第一道守卫就 `skip:no-shell` ✓。
 *   那一半靠**真机探针**：`scripts/check-keepalive-device.mjs --eval "…healVerdict(…)"` ✓。
 */
test('★ 帧长不匹配会被记下来（前台自愈据此重载页面，修"小退再进消息上不了屏"）', () => {
  const surface = bootOnSurface({ pathname: '/mobile/app', innerWidth: 412, consent: [] })
  const internals = surface.internals
  assert.ok(internals !== undefined, 'boot.js 应装上 __DSH_MOBILE_INTERNALS__ ✓')
  assert.equal(internals.frameDesyncAt(), 0, '刚起来时不该有"帧长不匹配"的记录 ✓')
  // 30 字节、头部声称 payload=0 ⇒ 14+0 ≠ 30 ⇒ 必然走到"帧长不匹配"那一支 ✓
  assert.throws(() => internals.parseFrame(new Uint8Array(30), true), /帧长不匹配/)
  assert.ok(
    internals.frameDesyncAt() > 0,
    '出错后必须记下时刻 —— 前台自愈就是靠它决定"整页重载"的（新开 socket 修不好错位的解析器 ✗）',
  )
})

/* ────────────────────────────────────────────────────────────────────────────
 * ★★ round 185：端侧**投递链的取证记录** ✓（纯取证 —— 只加记录，不改行为 ✗）
 *
 * 用户 2026-09-30 真机报「有提权请求，但手机一点反应都没有」✗，而宿主侧审计（三条实例）
 * **全是对的** ✓：approval/asked → approval-push → mobile/device/call notify ✓，
 * 2 秒后手机确实来取了 mobile/device/pending ✓，然后**没有 mobile/device/result** ✗。
 * ⇒ 问题在「手机取到之后、回报之前」✓，而这一段原先**一个字都不记**✗ ——
 *   手机上没有控制台 ✓ ⇒ 现场必须落盘 ✓（localStorage ✓），并能从外面读 ✓
 *   （__DSH_MOBILE_BOOT__.apk.deviceCallLog() ✓ —— 主线用 adb + CDP 念的就是它 ✓）。
 *
 * ★ 下面每条用例都同时钉住**两半** ✓：
 *   ① "记下来了"✓（读数里有那几段 ✓）；
 *   ② "该发生的照旧发生"✓（假隧道收到的请求路径就是后者的证据 ✓ —— 取证绝不许改变行为 ✗）。
 * ★ 每条断言都写了「怎么把它打红」✓（按那句话做一遍变异 ⇒ **恰好**那几条红 ✓）。
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * 一套**假隧道** ✓ —— 让 poll 真的能取到待办、真的逐条执行并回报 ✓。
 *
 * 为什么必须真的驱动 poll ✗：只调记录函数等于**测复制品** ✓（本项目为这条栽过，
 * 见 10-交接文档 §五 第 25 条：桩喂空集合 ⇒ 整段逻辑没覆盖 ✓）——
 * 所以断言要打在**生产路径**上 ✓（`devicePollTick` → `poll` → `runCall` ✓）。
 *
 * 形状照真传输层那份契约 ✓：`fetch(path, init)` 回一个 Response ✓，里面是
 * `{result: ...}` 信封 ✓（与 boot.js 的 `call()` 的读法一一对应 ✓）。
 */
function makeDeviceTransport(options: {
  /** 每一轮 `mobile/device/pending` 要回的 calls ✓（轮次用完就重复最后一轮 ✓）。 */
  rounds: Array<Array<Record<string, unknown>>>
  /** false ⇒ `mobile/device/result` 回一个**没有 id** 的结果 ✓（应记 report-fail/no-ack ✓）。 */
  reportOk?: boolean
  /** true ⇒ `mobile/device/result` **直接抛错** ✓（模拟"回报那一刻链路断了"✓）。 */
  reportThrows?: boolean
}): { transport: Record<string, unknown>; paths: string[]; reportBodies: string[] } {
  const paths: string[] = []
  const reportBodies: string[] = []
  let round = 0
  const respond = (payload: unknown): Response =>
    new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } })
  const transport: Record<string, unknown> = {
    ownsHost: true,
    fetch: async (input: unknown, init?: { body?: unknown }) => {
      const path = String(input)
      paths.push(path)
      if (path.includes('mobile/device/pending')) {
        const calls = options.rounds[Math.min(round, options.rounds.length - 1)] ?? []
        round += 1
        return respond({ result: { ok: true, value: { calls, enabled: [], capabilities: {} } } })
      }
      if (path.includes('mobile/device/result')) {
        const body = String(init?.body ?? '')
        reportBodies.push(body)
        if (options.reportThrows === true) throw new Error('打桩：回报通道断了')
        // ★ 照宿主 recordResult 那样**回显 id** ✓ —— 生产代码正是靠这个判定"回执到了"✓
        //   （宿主的 recordResult 就是把 args.id 原样放进结果里 ✓，见 packages/host/src/device-calls.ts ✓）。
        const sent = JSON.parse(body) as { payload?: { args?: { id?: string } } }
        const id = sent.payload?.args?.id ?? ''
        return respond({ result: options.reportOk === false ? { ok: false } : { id, ok: true, detail: 'stub' } })
      }
      return respond({ result: { ok: true, value: {} } })
    },
  }
  return { transport, paths, reportBodies }
}

/** 让一轮 poll（含它的 RPC 与微任务）跑完 ✓ —— 与既有用例同一种等法（真实 30ms ✓）。 */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 30))
}

/**
 * 读回取证记录 ✓ —— **走主线那个入口**（`__DSH_MOBILE_BOOT__.apk.deviceCallLog()` ✓），
 * 再 JSON 往返一次搬回本 realm ✓：vm 里的数组原型与这边不同 ✓，
 * 直接用 deepStrictEqual 比会因原型不同而假红 ✗。
 */
function readLog(surface: Surface): DeviceCallLogEntry[] {
  return JSON.parse(JSON.stringify(surface.boot.apk.deviceCallLog())) as DeviceCallLogEntry[]
}

/** 一条通知投递 ✓（本轮故障的那一种 ✓）。 */
function notifyCall(id: string): Record<string, unknown> {
  return { id, capability: 'notify', text: '批准：需要你点一下' }
}

/** 一条剪贴板投递 ✓（剪贴板原生桥的真身 ✓ —— 端侧必须如实回报"到底写进去了没有"✓）。 */
function clipboardCall(id: string, text: string): Record<string, unknown> {
  return { id, capability: 'clipboard', text }
}

/** 照 scripts/check-device-channel.mjs 那份假壳 ✓（接口与 MainActivity.ShellBridge 一致 ✓）。 */
function makeFakeShell(notifyReturn: string): Record<string, unknown> {
  return {
    version: () => '0.1.0+TEST',
    insets: () => JSON.stringify({ seen: true, top: 24, bottom: 0, ime: 0, density: 3, edgeToEdge: true }),
    platform: () => JSON.stringify({ sdk: 35, android: '15', model: 'test', version: '0.1.0+TEST', edgeToEdge: true }),
    notificationPermission: () => 'granted',
    requestNotificationPermission: () => {},
    notify: () => notifyReturn,
    changeAddress: () => {},
    log: () => {},
  }
}

test('★ 取证：取到 0 条也记一条 taken（这样"没取到"与"取到却没弹"才分得开）', async () => {
  const fake = makeDeviceTransport({ rounds: [[]] })
  const surface = bootOnSurface({
    pathname: '/mobile/app',
    innerWidth: 412,
    consent: [],
    transport: fake.transport,
    unrefTimers: true,
  })
  const onTick = surface.intervals[0]
  assert.ok(onTick !== undefined, '端侧通道应至少注册一个轮询定时器')
  onTick()
  await settle()
  const log = readLog(surface)
  // 怎么把它打红：删掉 poll() 里那句
  //   deviceCallLogPush('pending', '-', 'taken', 'count=' + calls.length, summary)
  // ⇒ 下面长度那条立刻红（本用例是唯一钉"0 条也要记"的 ✓，所以红的恰好是它 ✓）。
  assert.equal(log.length, 1, `取到 0 条也必须落一条（实际：${JSON.stringify(log)}）`)
  assert.equal(log[0]?.phase, 'taken')
  assert.equal(log[0]?.kind, 'pending')
  assert.equal(log[0]?.id, '-')
  assert.equal(log[0]?.outcome, 'count=0', '★ 0 条这一轮也要把条数记成 0 ✓（不是跳过 ✗）')
  assert.ok((log[0]?.at ?? 0) > 0, 'at 应是真实的毫秒时间戳（与宿主审计能直接比 ✓）')
  assert.match(String(log[0]?.detail), /待办0条/, 'detail 就是那句给人念的待办摘要 ✓')
  // ★ 同源：对外读数与 localStorage 里那份必须**逐字一致** ✓（落盘与读数只有一份实现 ✓）
  assert.deepEqual(
    JSON.parse(surface.storage.get('dsh-mobile.deviceCallLog') ?? 'null'),
    log,
    '读数必须与落盘同源（不许另算一份 ✗）',
  )
})

test('★ 取证：取到 1 条时四段齐全（taken → exec-start → exec-end → report-ok）', async () => {
  const fake = makeDeviceTransport({ rounds: [[{ id: 'call-1', capability: 'show', text: '电脑发来一条提醒' }]] })
  const surface = bootOnSurface({
    pathname: '/mobile/app',
    innerWidth: 412,
    consent: [],
    transport: fake.transport,
    unrefTimers: true,
  })
  surface.intervals[0]?.()
  await settle()
  const log = readLog(surface)
  // 怎么把它打红：删掉 poll() 里那句 exec-start、或 runCall 里那句 exec-end
  // ⇒ 下面这条顺序断言各自少一段 ⇒ **只有本用例**红 ✓。
  assert.deepEqual(
    log.map((entry) => entry.phase),
    ['taken', 'exec-start', 'exec-end', 'report-ok'],
    `四段必须齐全且有序（实际：${JSON.stringify(log)}）`,
  )
  assert.equal(log[0]?.outcome, 'count=1')
  assert.equal(log[1]?.id, 'call-1')
  assert.equal(log[1]?.kind, 'show')
  assert.equal(log[2]?.outcome, 'ok', '执行成功要记 ok ✓')
  assert.match(String(log[2]?.detail), /displayed/, 'exec-end 要带上 runCall 算出来的 detail ✓')
  assert.equal(log[3]?.outcome, 'acked', '回报成功记 acked ✓')
  assert.match(String(log[3]?.detail), /ok=true/, '回报那一段要把执行结论一起记下 ✓')
  // ★ 行为零变化：回报**照旧**发出去了 ✓（假隧道收到了它 ✓，而且带着同一个 id ✓）
  assert.ok(
    fake.paths.some((path) => path.includes('mobile/device/result')),
    'mobile/device/result 必须照旧发出 ✓（取证不许改回报时机 ✗）',
  )
  assert.match(fake.reportBodies[0] ?? '', /"id":"call-1"/, '回报里必须带着这条投递的 id ✓')
  // ★ 关键节点还要**能念** ✓：真机上只有调试框看得见 ✓（验收卡里就是让人照着念这两行 ✓）。
  // 怎么把它打红：删掉 poll() 里那句 log('[call-log] 取到 ...')、或 runCall 里那句
  //   log('[call-log] 执行完 ...') ⇒ 对应的那一条立刻红 ✓（另一条仍绿 ✓）。
  const box = surface.boxText()
  assert.match(box, /\[call-log\] 取到 1 条：show#call-1/, '调试框要有"取到 N 条"那一行 ✓')
  assert.match(box, /\[call-log\] 执行完 show#call-1 → displayed/, '调试框要有"某条执行结果"那一行 ✓')
})

test('★ 取证：回报失败必须记一条响的 report-fail（本轮最可疑的静默失败点）', async () => {
  // 两种失败都要记 ✓：① 回报直接抛错（链路断在这一刻）；② 回来了但没有回执（宿主不认这条 id）
  const thrownFake = makeDeviceTransport({ rounds: [[notifyCall('call-threw')]], reportThrows: true })
  const surfaceThrew = bootOnSurface({
    pathname: '/mobile/app',
    innerWidth: 412,
    consent: [],
    transport: thrownFake.transport,
    unrefTimers: true,
  })
  surfaceThrew.intervals[0]?.()
  await settle()
  const logThrew = readLog(surfaceThrew)
  // 怎么把它打红：删掉 runCall 里 catch 中那句
  //   deviceCallLogPush(..., 'report-fail', 'threw', ...)
  // ⇒ 下面这条立刻红 ✓（抛错那一支是本用例独有的 ⇒ 其余用例仍全绿 ✓）。
  const failThrew = logThrew.filter((entry) => entry.phase === 'report-fail')
  assert.equal(failThrew.length, 1, `抛错式回报失败必须记一条 report-fail（实际：${JSON.stringify(logThrew)}）`)
  assert.equal(failThrew[0]?.outcome, 'threw')
  assert.equal(failThrew[0]?.id, 'call-threw')
  assert.equal(failThrew[0]?.kind, 'notify')
  assert.match(String(failThrew[0]?.detail), /回报抛错/)
  // ★ 行为零变化：抛错照旧往外抛 ✓ —— 上面那句 await 原来就会把异常交给
  //   devicePollTick 的 onRejected（那里记"轮询失败" ✓，本轮一个字没动 ✓）。
  assert.match(surfaceThrew.boxText(), /轮询失败/, '回报抛错仍走既有那条"轮询失败"记录 ✓')

  const noAckFake = makeDeviceTransport({ rounds: [[notifyCall('call-noack')]], reportOk: false })
  const surfaceNoAck = bootOnSurface({
    pathname: '/mobile/app',
    innerWidth: 412,
    consent: [],
    transport: noAckFake.transport,
    unrefTimers: true,
  })
  surfaceNoAck.intervals[0]?.()
  await settle()
  const logNoAck = readLog(surfaceNoAck)
  const failNoAck = logNoAck.filter((entry) => entry.phase === 'report-fail')
  assert.equal(failNoAck.length, 1, `没有回执也必须记 report-fail（实际：${JSON.stringify(logNoAck)}）`)
  assert.equal(failNoAck[0]?.outcome, 'no-ack')
  assert.match(String(failNoAck[0]?.detail), /回报没有回执/)
  // ★ 而且要**能念**：真机上只有调试框看得见 ✓ —— 回报失败必须写进去 ✓（不许静默 ✗）
  assert.match(surfaceNoAck.boxText(), /回报失败（没有回执）/, '回报失败必须写进调试框（手机唯一的可见通道）✓')
})

test('★ 取证：桥返回的原文被记下来（denied / error / 没有桥，从此分得开）', async () => {
  const fake = makeDeviceTransport({ rounds: [[notifyCall('call-bridge')]] })
  const surface = bootOnSurface({
    pathname: '/mobile/app',
    innerWidth: 412,
    consent: [],
    transport: fake.transport,
    shell: makeFakeShell('denied'),
    unrefTimers: true,
  })
  surface.intervals[0]?.()
  await settle()
  const log = readLog(surface)
  const bridge = log.filter((entry) => entry.phase === 'bridge')
  // 怎么把它打红：删掉 notify 分支里 shellNotify 之后那句
  //   deviceCallLogPush(..., 'bridge', ...)
  // ⇒ 下面两条立刻红 ✓（bridge 这一段是本用例独有的 ⇒ 其余用例仍全绿 ✓）。
  assert.equal(bridge.length, 1, `桥返回必须记一条 bridge（实际：${JSON.stringify(log)}）`)
  assert.equal(bridge[0]?.outcome, 'denied', '★ 记的是**桥返回的原文**（不是再翻译一遍的布尔 ✓）')
  assert.match(String(bridge[0]?.detail), /shellNotify → denied/)
  assert.deepEqual(
    log.map((entry) => entry.phase),
    ['taken', 'exec-start', 'bridge', 'exec-end', 'report-ok'],
    `bridge 那一段要夹在 exec-start 与 exec-end 之间（实际：${JSON.stringify(log)}）`,
  )
  // ★ 行为零变化：桥说 denied ⇒ 照旧退回页面横幅（detail=banner-fallback ✓，一个字没改 ✓）
  assert.match(String(log[3]?.detail), /banner-fallback/, '桥拒绝后仍照旧退回横幅并如实回报 ✓')

  // 没有壳时（纯浏览器 / 桥没注入）那一格也要能分辨 ✓ —— 记 no-bridge ✓
  const noShellFake = makeDeviceTransport({ rounds: [[notifyCall('call-noshell')]] })
  const noShell = bootOnSurface({
    pathname: '/mobile/app',
    innerWidth: 412,
    consent: [],
    transport: noShellFake.transport,
    unrefTimers: true,
  })
  noShell.intervals[0]?.()
  await settle()
  const bridgeNoShell = readLog(noShell).filter((entry) => entry.phase === 'bridge')
  assert.equal(bridgeNoShell.length, 1, '没有壳时也要记一条 bridge ✓（nil 与 denied 是两件事 ✓）')
  assert.equal(bridgeNoShell[0]?.outcome, 'no-bridge')
})

/**
 * ★ 2026-10-05（用户真机抱怨"通知标题没说清是哪台电脑"）：
 * 标题要**由宿主给**（`callInfo.title` ✓），手机这一侧只负责透传给壳 ✓。
 *
 * 为什么必须在这一层钉 ✗：`notify-text.ts` 那边全绿只证明"宿主拼得对"✓ ——
 * 而手机这一侧原来把标题**写死**成「需要你确认」✗ ⇒ 宿主拼什么都会被丢掉 ✗，
 * 在电脑端完全看不出来（推送照样返回 ok ✓）。这里用**假壳**把真正交给
 * `bridge.notify(title, body, link)` 的那三个参数接住 ✓（真机上就是它们进了通知栏 ✓）。
 */
test('★ 2026-10-05：系统通知的标题来自宿主（`callInfo.title`），缺了才退回旧标题', async () => {
  /** 接住壳真正收到的那三个参数 ✓（真机上通知栏显示的就是 title / body ✓）。 */
  const seen: Array<{ title: string; body: string; link: string }> = []
  const shell = makeFakeShell('ok')
  shell['notify'] = (title: unknown, body: unknown, link: unknown) => {
    seen.push({ title: String(title), body: String(body), link: String(link) })
    return 'ok'
  }
  const withTitle = makeDeviceTransport({
    rounds: [[{
      id: 'call-title',
      capability: 'notify',
      text: '允许一次提权到 danger-full-access\nbash escalate sandbox to danger-full-access: 提权演练…',
      title: 'Mac-mini-2024 需要你确认',
      sessionId: 'sess-42',
    }]],
  })
  const surface = bootOnSurface({
    pathname: '/mobile/app',
    innerWidth: 412,
    consent: [],
    transport: withTitle.transport,
    shell,
    unrefTimers: true,
  })
  surface.intervals[0]?.()
  await settle()
  // 怎么把它打红：把 shellNotify 的第一个实参换回写死的 '需要你确认'
  // ⇒ 下面第一条立刻红 ✓（其余用例照旧全绿 ✓）。
  assert.equal(seen.length, 1, `壳应当收到一条通知（实际：${JSON.stringify(seen)}）`)
  assert.equal(seen[0]?.title, 'Mac-mini-2024 需要你确认', '标题必须原样透传，不许在手机这侧改写')
  assert.match(seen[0]?.body ?? '', /允许一次提权到 danger-full-access/, '正文照旧透传（一个字不改 ✓）')
  assert.equal(seen[0]?.link, 'sess-42', '会话仍然透传（点通知落到那个会话 ✓）')

  // ★ 老宿主 / agent 工具 `phone_notify` 不给 title ⇒ 逐字退回旧标题 ✓（行为同今天 ✓）
  const seenOld: string[] = []
  const shellOld = makeFakeShell('ok')
  shellOld['notify'] = (title: unknown) => {
    seenOld.push(String(title))
    return 'ok'
  }
  const withoutTitle = makeDeviceTransport({ rounds: [[notifyCall('call-old')]] })
  const oldSurface = bootOnSurface({
    pathname: '/mobile/app',
    innerWidth: 412,
    consent: [],
    transport: withoutTitle.transport,
    shell: shellOld,
    unrefTimers: true,
  })
  oldSurface.intervals[0]?.()
  await settle()
  assert.deepEqual(seenOld, ['需要你确认'], '没有 title 字段时必须退回原来那三个字（绝不弹一条没标题的通知）')
})

/**
 * ════════════════════════════════════════════════════════════════════════════
 * ★★ 剪贴板原生桥（2026-10-05）：**clipboard 必须能真的写进去**（先问壳 ✓），而且**降级不再算成功** ✗
 *
 * ## 真机现场（用户原话）
 *   「电脑想放进剪贴板，但浏览器不允许自动复制」✗
 *
 * ## 根因
 * 触发时机是**每 4 秒一轮的轮询** ✓ ⇒ **没有任何用户手势** ✗ ——
 * 而 `navigator.clipboard.writeText`（还要安全上下文 ✓）与 `document.execCommand('copy')`
 * 两条都要手势 ✗ ⇒ 必然被拒 ✓，页面于是落到"长按手动复制"的降级横幅 ✓。
 * 壳那边的原生 `ClipboardManager` **不要求手势** ✓ ⇒ 这就是本轮加那条桥的理由 ✓。
 *
 * ## 这一组用例钉住两件事（各有一条"怎么把它打红" ✓）
 *   ① **有壳 ⇒ 走壳** ✓（否则加这条桥等于白加 ✗）；
 *   ② **两条路都不行 ⇒ `ok=false`** ✗（旧口径在这里写死 `ok = true` ✓ ——
 *      "电脑说放进去了、手机上没有" ✗，那正是**假成功** ✗）。
 * ════════════════════════════════════════════════════════════════════════════
 */

test('★ 剪贴板原生桥：有壳时 clipboard 走原生壳（copied:shell-clipboard，ok=true）', async () => {
  /** 接住壳真正收到的正文 ✓（真机上它就是剪贴板里那一段 ✓）。 */
  const clipSeen: string[] = []
  const shell = makeFakeShell('ok')
  shell['setClipboard'] = (text: unknown) => {
    clipSeen.push(String(text))
    return 'ok'
  }
  const fake = makeDeviceTransport({ rounds: [[clipboardCall('call-clip-shell', '要复制的正文')]] })
  const surface = bootOnSurface({
    pathname: '/mobile/app',
    innerWidth: 412,
    consent: [],
    transport: fake.transport,
    shell,
    unrefTimers: true,
  })
  surface.intervals[0]?.()
  await settle()
  // 怎么把它打红：把 copyText 开头那两行（`var native = shellClipboard(text)` 与
  //   `if (native === 'ok') return 'shell-clipboard'`）删掉 ⇒ 下面每一条立刻红 ✓
  //   （`clipSeen` 空 ⇒ 桥压根没被问 ✓；detail 退回 `banner-manual` ✓）——
  //   而本文件其余用例一条都不红 ✓（它们都不带壳或不用 clipboard ✓）。
  assert.deepEqual(clipSeen, ['要复制的正文'], `壳必须收到正文原文（实际：${JSON.stringify(clipSeen)}）`)
  const log = readLog(surface)
  assert.equal(log[2]?.outcome, 'ok', `exec-end 要记 ok（实际：${JSON.stringify(log)}）`)
  assert.match(String(log[2]?.detail), /copied:shell-clipboard/, 'detail 要说清走的是**壳**那条路 ✓')
  // ★ 回报给宿主的那两个字段才是宿主/agent 真正看到的东西 ✓（必须与日志一致 ✓）
  assert.match(fake.reportBodies[0] ?? '', /"ok":true/, '回报里 ok 必须是 true ✓')
  assert.match(fake.reportBodies[0] ?? '', /copied:shell-clipboard/, '回报里要带上端侧原话 ✓')
})

test('★ 剪贴板原生桥：两条路都不行 ⇒ ok=false + banner-manual（降级不再算成功）', async () => {
  /**
   * 本沙箱的 `navigator` **没有** `clipboard` ✓、`document` **没有** `execCommand` ✓
   * ⇒ `copyText` 的两条网页路都走不通 ✓ —— 这正是真机上"无手势轮询"的等价物 ✓。
   */
  const fake = makeDeviceTransport({ rounds: [[clipboardCall('call-clip-fail', '这段文字没能进剪贴板')]] })
  const surface = bootOnSurface({
    pathname: '/mobile/app',
    innerWidth: 412,
    consent: [],
    transport: fake.transport,
    unrefTimers: true,
  })
  surface.intervals[0]?.()
  await settle()
  // 怎么把它打红：把 clipboard 分支里那句 `ok = how !== undefined` 改回 `ok = true`
  // ⇒ 下面 outcome / `"ok":false` 两条立刻红 ✓（本用例是唯一钉"降级要记失败"的 ✓，
  //   所以红的恰好是它 ✓ —— "有壳"那条与"正文分块"那条仍绿 ✓）。
  const log = readLog(surface)
  assert.equal(log[2]?.outcome, 'error', `★ 降级要记成 error（实际：${JSON.stringify(log)}）`)
  assert.match(String(log[2]?.detail), /banner-manual/, 'detail 仍是 banner-manual（宿主认的就是这个口径 ✓）')
  assert.match(
    fake.reportBodies[0] ?? '',
    /"ok":false/,
    '★ 回报给宿主的必须是 ok=false —— 旧口径在这里是 true ✗（那正是"假成功"✗）',
  )
})

test('★ 剪贴板原生桥：降级横幅里**正文单独一个元素**（长按复制到的就是干净正文）', async () => {
  /**
   * 用户价值那一条 ✓：原来"前缀说明 + 正文"塞在同一个 div 里 ✗ ⇒
   * 用户长按全选会把那句说明一起复制走 ✗（粘出来是一段混着说明的脏文本 ✓）。
   */
  const fake = makeDeviceTransport({ rounds: [[clipboardCall('call-clip-split', '这段文字没能进剪贴板')]] })
  const surface = bootOnSurface({
    pathname: '/mobile/app',
    innerWidth: 412,
    consent: [],
    transport: fake.transport,
    unrefTimers: true,
  })
  surface.intervals[0]?.()
  await settle()
  // 怎么把它打红：把 clipboard 分支里造 `clipBody` 那几行去掉、退回
  //   `drawBar('info', '…长按选中下面这段：\n' + text, [], false)`
  // ⇒ `clipBody` 变成 undefined（`body` 那条立刻红 ✓），
  //   而"ok=false"那条仍绿 ✓（那一句 `ok = how !== undefined` 一个字没动 ✓）。
  const kids = surface.infoBanner()
  const clipBody = kids.find((element) => element.attrs['data-dshm-clipboard-text'] === '1')
  assert.ok(clipBody !== undefined, `降级横幅里应当有专门的正文元素（实际子元素：${JSON.stringify(kids)}）`)
  assert.equal(clipBody.text, '这段文字没能进剪贴板', '正文元素里放的就是**正文原文** ✓')
  assert.match(clipBody.css, /user-select:text/, '正文那一块必须显式可选中 ✓（别赌祖先节点有没有关掉 ✓）')
  assert.ok(kids.length >= 2, `前缀说明与正文必须是**两个**元素（实际：${JSON.stringify(kids)}）`)
  assert.ok(
    !(kids[0]?.text ?? '').includes('这段文字没能进剪贴板'),
    '★ 前缀那一块**不许夹带正文**（否则长按选中还是会把说明一起带走 ✗）',
  )
})

/* ════════════════════════════════════════════════════════════════════════════
 * ★★ 2026-10-05：**蓝横幅 / 页面提示条 ⇒ 安卓系统通知**（用户原话）
 *
 *   「把我们的蓝色横幅都改成安卓的通知」✓ +
 *   「那种中间跳的横幅 … 就像我之前跟你说的下载跳的那种横幅，也改成安卓的通知」✓
 *
 * ## 这一组钉住什么（每条都写了"怎么把它打红" ✓）
 *   · 剪贴板**成功**那条蓝横幅 ⇒ 走 `shellNotify` ✓（有壳 ✓；**无壳退提示条** ✓，绝不回蓝横幅 ✗）；
 *   · **手动重连失败**那条提示条 ⇒ 走 `shellNotify` ✓（无壳时文案与旧行为**逐字**一致 ✓）；
 *   · **自动重连放弃**那一处 ⇒ **一个字都不许改** ✗（提示条 + **恰好一条**通知 ✓ ——
 *     理由写在 `boot.js` 那一处自己的注释里 ✓，也是 `scripts/check-mobile-layout.mjs`
 *     第 152-② / 152-④ 条钉着的东西 ✓）；
 *   · **10 秒去重窗** ✓：行为一条（同一条第二次不再发 ✓ —— 真实时钟下两次只隔几十毫秒 ✓，
 *     不必真等 ✓）+ **边界一条**（注入时钟 ✓：9.999 秒仍挡、10.001 秒放行 ✓）。
 *
 * ★ 断言全部打在**生产路径**上 ✓（真的驱动一轮端侧 poll ✓ / 真的构造生产 `Tunnel` ✓ /
 *   读的是生产代码自己造的那个 DOM 元素 ✓），没有一条是"另抄一份再断言它"✗。
 * ════════════════════════════════════════════════════════════════════════════ */

/**
 * 假壳 + **把壳收到的每一条通知记下来** ✓（标题 / 正文 ✓）。
 *
 * 为什么必须记正文 ✗：`shellNotify` 那一句 `String(bridge.notify(...))` 只回一个**状态码** ✓，
 * "壳到底收到了什么"在页面这一侧**只有**这个记录口看得见 ✓
 * （`scripts/check-device-channel.mjs` 用的就是同一种做法 ✓）。
 */
function makeRecordingShell(notifyReturn: string): {
  shell: Record<string, unknown>
  notes: Array<{ title: string; body: string }>
} {
  const notes: Array<{ title: string; body: string }> = []
  const shell = makeFakeShell(notifyReturn)
  shell['notify'] = (title: unknown, body: unknown) => {
    notes.push({ title: String(title), body: String(body) })
    return notifyReturn
  }
  return { shell, notes }
}

/** 造一个**生产** `Tunnel` ✓（`__DSH_MOBILE_INTERNALS__.Tunnel` ✓ —— 构造是纯记账，不开 socket ✓）。 */
function makeTunnel(surface: Surface): {
  reportManualReconnectFailure: (reason: string) => void
  giveUpAutoReconnect: (reason: string) => void
} {
  return new surface.internals.Tunnel({ tunnelUrl: 'wss://10.34.221.181:3443/mobile/ws' })
}

test('★ 蓝横幅改通知：剪贴板成功 ⇒ 走系统通知（蓝横幅消失 ✓）', async () => {
  const { shell, notes } = makeRecordingShell('ok')
  shell['setClipboard'] = () => 'ok'
  const fake = makeDeviceTransport({ rounds: [[clipboardCall('call-notice-clip', '要复制的正文')]] })
  const surface = bootOnSurface({
    pathname: '/mobile/app',
    innerWidth: 412,
    consent: [],
    transport: fake.transport,
    shell,
    unrefTimers: true,
  })
  surface.intervals[0]?.()
  await settle()
  // 怎么把它打红：把 clipboard 那条成功分支里的 `shellNotice('已放进剪贴板', String(text))`
  //   改回 `drawBar('info', '已放进手机剪贴板（' + String(text).slice(0, 60) + '）', [], false)`
  //   ⇒ 下面 notes 那两条立刻红（壳一条都没收到 ✓）且 infoBanner 那条也红（蓝横幅又回来了 ✓）；
  //   本文件其余用例一条都不红 ✓。
  assert.equal(notes.length, 1, `壳必须收到**恰好一条**通知（实际：${JSON.stringify(notes)}）`)
  assert.equal(notes[0]?.title, '已放进剪贴板', '标题就是那六个字 ✓')
  assert.equal(notes[0]?.body, '要复制的正文', '正文就是剪贴板正文本身 ✓')
  assert.equal(surface.infoBanner().length, 0, '★ 蓝色横幅必须消失（用户要消掉的就是它 ✓）')
  assert.equal(surface.toastText(), null, '通知已经发出去了 ⇒ 不该再弹页面提示条 ✓')
  const log = readLog(surface)
  assert.equal(log[2]?.outcome, 'ok', '★ `ok` 的口径一个字都不改（实际还是"真的写进去了"✓）')
  assert.match(String(log[2]?.detail), /copied:shell-clipboard/, '`detail` 口径一个字都不改 ✓')
  assert.match(fake.reportBodies[0] ?? '', /"ok":true/, '回报给宿主的仍是成功 ✓')
})

test('★ 蓝横幅改通知：**无壳**时剪贴板成功 ⇒ 退页面提示条（绝不退回蓝横幅 ✗）', async () => {
  /**
   * `webClipboard: true` ⇒ 网页那条路**真的写进去了** ✓（本沙箱原先两条网页路都不通 ✓，
   * 于是"没壳 + 成功"这一态根本到不了 ✓）。**壳一个都不给** ✓ —— 这正是"手机浏览器打开"的样子 ✓。
   */
  const fake = makeDeviceTransport({ rounds: [[clipboardCall('call-notice-noshell', '无壳也要说清')]] })
  const surface = bootOnSurface({
    pathname: '/mobile/app',
    innerWidth: 412,
    consent: [],
    transport: fake.transport,
    webClipboard: true,
    unrefTimers: true,
  })
  surface.intervals[0]?.()
  await settle()
  // 怎么把它打红：把 `shellNotice` 里那句退路 `shellToast(...)` 换成
  //   `drawBar('info', ...)` ⇒ 下面 infoBanner 那条与 toastText 那条立刻红 ✓
  //   （"退回了正在被消掉的那种蓝条"✓ —— 那等于本轮白改 ✓）；
  //   而"有壳那条"用例仍绿 ✓（它压根走不到退路 ✓）。
  assert.equal(surface.infoBanner().length, 0, '★ 绝不许退回蓝横幅 ✓（这是本轮的核心契约 ✓）')
  assert.match(
    String(surface.toastText()),
    /无壳也要说清/,
    `无壳 ⇒ 深色提示条把同一件事说清（实际：${JSON.stringify(surface.toastText())}）`,
  )
  const log = readLog(surface)
  assert.equal(log[2]?.outcome, 'ok', '无壳走网页那条路，照旧成功 ✓')
  assert.match(String(log[2]?.detail), /copied:clipboard/, 'detail 照旧说清走的是网页那条路 ✓')
})

test('★ 去重窗：10 秒内**同一条**通知只发一次（第二条不再响，但请求照旧被执行）', async () => {
  const { shell, notes } = makeRecordingShell('ok')
  shell['setClipboard'] = () => 'ok'
  // ★ 前两轮**同一句正文**（id 不同 ⇒ 这是两次投递 ✓，不是同一条被重放 ✓）；
  //   第三轮换一句 ⇒ 它**必须**照发 ✓（去重是"同一条"✓，不是"这一段时间内什么都不发"✗）。
  const fake = makeDeviceTransport({
    rounds: [
      [clipboardCall('call-dedup-1', '同一条正文')],
      [clipboardCall('call-dedup-2', '同一条正文')],
      [clipboardCall('call-dedup-3', '换了一句正文')],
    ],
  })
  const surface = bootOnSurface({
    pathname: '/mobile/app',
    innerWidth: 412,
    consent: [],
    transport: fake.transport,
    shell,
    unrefTimers: true,
  })
  const onTick = surface.intervals[0]
  assert.ok(onTick !== undefined, '端侧通道应至少注册一个轮询定时器')
  onTick()
  await settle()
  onTick()
  await settle()
  onTick()
  await settle()
  // 怎么把它打红：把 `shellNotice` 里那句
  //   `if (shellNoticeDeduped(...)) { ...; return 'dedup' }` 删掉（或把窗口改成 0）
  //   ⇒ 下面 notes.length 变成 3 ⇒ 当场红 ✓（★ 三次调用相隔只有几十毫秒 ✓，
  //   真实时钟下**必然**落在 10 秒窗内 ✓ —— 不用等、也不会偶发 ✓）。
  assert.equal(notes.length, 2, `★ 10 秒内**同一条**只许发一次，换一句才发（实际发了 ${String(notes.length)} 条：${JSON.stringify(notes)}）`)
  assert.equal(notes[1]?.body, '换了一句正文', '★ 换了一句就照发（去重不许变成"整段时间静音"✗）')
  assert.match(
    surface.boxText(),
    /秒内同一条不再重复发/,
    '★ 被挡下的那一条要**记账**说清（而不是看起来像"什么都没发生"✗ —— 那正是假绿的老路 ✓）',
  )
  // ★ 去重只挡通知 ✗，**绝不许**把这次投递本身吃掉 ✗（三次都要真的执行 + 真的回报 ✓）
  const ends = readLog(surface).filter((entry) => entry.phase === 'exec-end')
  assert.deepEqual(
    ends.map((entry) => entry.detail),
    ['detail=copied:shell-clipboard', 'detail=copied:shell-clipboard', 'detail=copied:shell-clipboard'],
    `三条都要照旧执行完（实际：${JSON.stringify(ends)}）`,
  )
})

test('★ 去重窗的**边界**：10 秒内算同一条、过了 10 秒就不算（注入时钟 ✓ 不睡 10 秒 ✗）', () => {
  /**
   * 行为那条只证明"**有**一个窗"✓；**窗户到底多宽**只有这个纯函数量得到 ✓。
   * `now` 由调用方给 ✓（见 `boot.js` 里 `shellNoticeDeduped` 的说明 ✓，
   * 与 `fitFileNameParts` 那几条判据同一种写法：打在**生产函数**上 ✓，不是复制品 ✓）。
   */
  const surface = bootOnSurface({ pathname: '/mobile/app', innerWidth: 412, consent: [] })
  const deduped = surface.internals.shellNoticeDeduped
  const key = '同一条标题\u0000同一条正文'
  // 怎么把它打红：把 `SHELL_NOTICE_DEDUP_MS` 改成 30_000 ⇒ 第三条红（10.001 秒后本该放行 ✗）；
  //   改成 1_000 ⇒ 第二条红（9.999 秒后本该仍然挡住 ✗）。
  assert.equal(deduped(key, 1_000_000), false, '第一次 ⇒ 不算重复（并记账 ✓）')
  assert.equal(deduped(key, 1_009_999), true, '9.999 秒后 ⇒ 仍算同一条 ✓（窗口不许被改小 ✗）')
  assert.equal(deduped(key, 1_010_001), false, '过了 10 秒 ⇒ 重新算一条 ✓（窗口不许被改大 ✗）')
  assert.equal(deduped(key, 1_020_000), true, '★ 上一步真的**重新记了账**（不是"一个键只算一次"✗）')
  assert.equal(deduped(key + '（另一个键）', 1_020_000), false, '★ 键不同 ⇒ 互不影响（键 = 标题 + 正文 ✓）')
})

test('★ 提示条改通知：手动重连失败 ⇒ 有壳走系统通知，无壳退提示条且**文案逐字不变**', () => {
  /**
   * ★ 用一条**长原因**（真机上 `shortReason` 允许到 120 字 ✓）：94 字左右 ⇒
   *   如果退路那条提示条也按通知的 72 字去截，"点哪颗橙色提示"那半句就会被切掉 ✗，
   *   而 `scripts/check-mobile-layout.mjs` 第 152-⑨ 条**正是读这一句** ✓（它在
   *   `removeFakeShell()` 之后跑 ⇒ 走的就是这条无壳退路 ✓）。
   */
  const longReason =
    'wss://10.34.221.181:3443/mobile/ws → WebSocket 出错；wss://100.123.136.82:3443/mobile/ws → 候选端点超时（5 秒）'
  assert.ok(longReason.length > 72, `这条原因必须长过通知正文的上限（实际 ${String(longReason.length)} 字）`)
  const oldText = '手动重连失败：' + longReason + '（可再点一次那颗橙色提示重试）'

  // ── ① 有壳 ⇒ 走系统通知（通知正文把"该做什么"放在最前 ⇒ 72 字那道上限切不掉它 ✓） ──
  const { shell, notes } = makeRecordingShell('ok')
  const withShell = bootOnSurface({ pathname: '/mobile/app', innerWidth: 412, consent: [], shell, unrefTimers: true })
  makeTunnel(withShell).reportManualReconnectFailure(longReason)
  // 怎么把它打红：把这一处那句 `shellNotice('手动重连失败', …)` 改回
  //   `shellToast('手动重连失败：' + reason + …)` ⇒ 下面 notes 两条立刻红（壳一条都没收到 ✓）；
  //   而"无壳"那半条仍绿 ✓（它本来就走提示条 ✓）。
  assert.equal(notes.length, 1, `壳必须收到恰好一条通知（实际：${JSON.stringify(notes)}）`)
  assert.equal(notes[0]?.title, '手动重连失败', '标题就是这句话 ✓')
  assert.ok(String(notes[0]?.body).startsWith('可再点一次那颗橙色提示重试'), `通知正文要先说该做什么（实际：${JSON.stringify(notes[0]?.body)}）`)
  assert.ok(String(notes[0]?.body).length <= 73, `通知正文不超过 72 字 + 省略号（实际 ${String(String(notes[0]?.body).length)} 字）`)
  assert.equal(withShell.toastText(), null, '通知发出去了 ⇒ 不该再弹提示条 ✓')
  assert.equal(withShell.infoBanner().length, 0, '也绝不许退回蓝横幅 ✓')

  // ── ② 无壳 ⇒ 退提示条，**与旧行为逐字一致**（152-⑨ 读的就是它 ✓） ──
  const noShell = bootOnSurface({ pathname: '/mobile/app', innerWidth: 412, consent: [], unrefTimers: true })
  makeTunnel(noShell).reportManualReconnectFailure(longReason)
  // 怎么把它打红：把退路那句改成按 72 字截（或改成 drawBar）⇒ 下面这条立刻红 ✓
  //   （前者的实际文案会在"候选端点超时"处断掉并加省略号 ✓；后者连元素都换了 ✓）。
  assert.equal(noShell.toastText(), oldText, '★ 无壳时那句提示条必须与旧行为**逐字一致**（152-⑨ 钉着它 ✓）')
  assert.equal(noShell.infoBanner().length, 0, '★ 绝不退回蓝横幅 ✓')
})

test('★ 自动重连放弃那一处：**一个字都不许改**（提示条 + 恰好一条通知；不许再发第二条）', () => {
  /**
   * ## 为什么这一处**刻意不动** ✗（本轮唯一一处"说改而没改"的地方）
   *
   * 用户要求"中间跳的横幅也改成通知"✓，普查据此提出删掉那句 `shellToast(text)`
   *   （理由：紧邻的下一行已经发了同样的通知 ⇒ 换成通知会变成**发两条**✗）。
   * ★ 但 `scripts/check-mobile-layout.mjs` 第 152-② 条断言的就是**这条提示条**里
   *   有「已停止自动重连」+「试满 5 次」+「手动重连」✓，而这句话在 `boot.js` 里
   *   **只由那一行**写出去 ✓ ⇒ 删掉 = 那条既有验收的唯一观测源没了 ⇒ 当场红 ✗；
   *   同一节的第 152-④ 条又要求这一处 `notify` **恰好 1 次** ✓ ⇒ **两条都要留** ✓。
   *
   * ⇒ 这个用例把"**恰好一个 `shellNotify`、零个 `shellNotice`、一个 `shellToast`**"
   *   钉在**生产类的方法体**上 ✓：以后谁想把它换成 `shellNotice`（= 真发两条通知 ✗），
   *   这里当场红 ✓。
   */
  const { shell, notes } = makeRecordingShell('ok')
  const withShell = bootOnSurface({ pathname: '/mobile/app', innerWidth: 412, consent: [], shell, unrefTimers: true })
  const tunnel = makeTunnel(withShell)
  // ★ 数满 5 轮那一支 ✓（`AUTO_RECONNECT_LIMIT` = 5 ✓ ⇒ 文案是"已试满 5 次…"✓
  //   —— 与 `check-mobile-layout.mjs` 第 152-② 条读的三个子串**逐个对齐** ✓）
  tunnel.failStreak = 5
  tunnel.giveUpAutoReconnect('测试：网络不可达')
  assert.equal(tunnel.autoPaused, true, '前置：确实走到了"放弃"这一支 ✓')
  // 怎么把它打红：把这一处那句 `shellNotify('DSH 移动端：连接中断', text)` 删掉
  //   ⇒ 下面 notes.length 立刻变 0 ⇒ 红 ✓（152-④ 要的正是这一条通知 ✓）。
  assert.equal(notes.length, 1, `放弃时**恰好一条**通知 ✓（实际：${JSON.stringify(notes)}）`)
  assert.equal(notes[0]?.title, 'DSH 移动端：连接中断', '标题照旧 ✓')
  /**
   * ★ 这三个子串就是 `scripts/check-mobile-layout.mjs` 第 152-② 条的全部内容 ✓
   *   （同文件 12066-12072 ✓）—— 直接照抄过来 ✓，于是"删掉那句提示条会不会红"这件事
   *   在**本仓的单元测试**里也量得到 ✓（不必等 5–7 分钟那套真机验收 ✓）。
   */
  for (const [what, wanted] of [
    ['已停止自动重连', /已停止自动重连/],
    ['试满 5 次', /5 次/],
    ['到哪去手动重连', /手动重连/],
  ] as const) {
    assert.match(
      String(withShell.toastText()),
      wanted,
      `★ 页面提示条**仍在**且说清了「${what}」（152-② 的唯一观测源 ✓ —— 它不许被"改成通知"顺手删掉 ✗）`,
    )
  }

  // ── 无壳：通知那一路静默（`shellNotify` ⇒ null ✓），提示条照旧 ──
  const noShell = bootOnSurface({ pathname: '/mobile/app', innerWidth: 412, consent: [], unrefTimers: true })
  const noShellTunnel = makeTunnel(noShell)
  noShellTunnel.failStreak = 5
  noShellTunnel.giveUpAutoReconnect('测试：网络不可达')
  assert.match(String(noShell.toastText()), /已停止自动重连/, '★ 无壳时提示条同样要在（旧行为逐字不变 ✓）')
})

test('★ 结构性：这一轮只动那两处 —— 其余 8 处（蓝横幅 6 + 提示条 2）一个都没消失', () => {
  /**
   * 这一条量的是**代码形状**（和上面"反重放位图只有一个出生地"那条同一种写法 ✓）：
   * 它防的是"顺手把别的横幅也删了"✗ —— 那 8 处各有硬理由（见 10-交接文档与
   * `scripts/check-device-channel.mjs` / `check-mobile-layout.mjs` 各自的断言 ✓）。
   * ★ 注释先被整行滤掉 ✓，所以下面匹配到的都是**可执行代码** ✓（不是注释里的字符串 ✓）。
   */
  const codeOnly = bootSource
    .split('\n')
    .filter((line) => {
      const text = line.trim()
      return !(text.startsWith('*') || text.startsWith('/*') || text.startsWith('//'))
    })
    .join('\n')
  const slice = (marker: string, stop: string): string => {
    const start = codeOnly.indexOf(marker)
    assert.ok(start >= 0, `必须能在源码里找到：${marker}`)
    const end = codeOnly.indexOf(stop, start + marker.length)
    assert.ok(end > start, `必须能在源码里切出这一块：${marker}`)
    return codeOnly.slice(start, end)
  }

  // ── ① show 能力：**必须仍是蓝横幅** ✓（`check-device-channel.mjs:151` 要渲染 [data-dshm-banner=info] ✓）
  const showBranch = slice("if (callInfo.capability === 'show') {", "} else if (callInfo.capability === 'notify') {")
  assert.ok(showBranch.includes("drawBar('info', text, [], false)"), '★ show 能力那条仍走 drawBar（兜底能力**本体** ✓，换掉等于用刚失败的那条路去兜底 ✗）')
  assert.ok(!showBranch.includes('shellNotify('), 'show 那条不许被改成通知 ✓')

  // ── ② notify + 没有壳：**必须仍是蓝横幅** ✓（没壳时通知那套根本不存在 ⇒ 换掉=静默失败 ✗）
  const noBridge = slice('if (posted === null) {', '} else {')
  assert.ok(noBridge.includes("drawBar('info', text, [], false)"), '★ notify 没壳那条仍是蓝横幅 ✓')
  assert.ok(noBridge.includes("banner-no-bridge"), '★ 而且 detail 口径照旧 ✓')

  // ── ③ clipboard 三条路全失败：**必须仍是蓝横幅** ✓（通知里没法长按选区 ✗）
  const manualBar = slice("var clipBar = drawBar('info', '电脑想放进剪贴板", "detail = 'banner-manual'")
  assert.ok(manualBar.includes("data-dshm-clipboard-text"), '★ 降级横幅里那块"可长按复制的正文"仍在 ✓')

  // ── ④ open 能力：**必须仍是蓝横幅 + 可点链接** ✓（通知给不了"点链接"这个手势 ✗）
  //    ★ 切片从**造那个 `<a>`** 开始 ✗（它在 `drawBar` **之前** ✓ —— 只从横幅那一行切
  //      会把链接那几行漏掉 ✓，第一版就是这么写的 ⇒ 假红 ✓）。
  const openBar = slice('link.textContent = target.length > 60', "detail = 'link-shown'")
  assert.ok(openBar.includes("link.target = '_blank'"), '★ open 那条仍把链接摆出来让用户点 ✓')
  assert.ok(openBar.includes("drawBar('info', '电脑推来一个链接"), '★ 而且它仍是一条蓝横幅 ✓')

  // ── ⑤ notify 两条路都失败：**必须仍是蓝横幅 + 申请权限按钮** ✓（申请通知权限必须在用户手势里 ✗）
  const notifyFail = slice('if (!notified) {', '} else {')
  assert.ok(notifyFail.includes("drawBar("), '★ notify 全失败那条仍是蓝横幅 ✓')
  assert.ok(notifyFail.includes('开启系统通知'), '★ 而且那颗"开启系统通知"按钮仍在（它是唯一的申请手势入口 ✓）')

  // ── ⑥ askAbout 允许/不用：**必须仍是蓝横幅** ✓（通知做不到多选项；这是端侧通道唯一入口 ✓）
  assert.ok(
    codeOnly.includes("drawBar('info', '已设为「不用」"),
    '★ askAbout「不用」那条仍是蓝横幅 ✓（check-device-channel.mjs:233 读的就是它 ✓）',
  )

  // ── ⑦ 下载退回：**必须仍是 shellToast** ✓（它本身就是"通知发不出去"的兜底 ✗，不能再套一层通知）
  assert.ok(codeOnly.includes("shellToast(String(title) + '：' + short)"), '★ 下载那条退路仍是提示条 ✓')

  // ── ⑧ 面板内反馈：**必须仍是 shellToast** ✓（原作者已判定这类不该弹通知栏 ✓）
  assert.ok(codeOnly.includes('if (notice === null) shellToast(message)'), '★ 面板内反馈那条仍是提示条 ✓')

  // ── ★ 反向：这一轮改的那两处必须是"通知 + 退提示条"，而且**绝不许退回 drawBar** ✗ ──
  assert.ok(codeOnly.includes("shellNotice('已放进剪贴板', String(text))"), '剪贴板成功那条必须走统一通知出口 ✓')
  assert.ok(!codeOnly.includes("drawBar('info', '已放进手机剪贴板"), '★ 剪贴板成功那条蓝横幅必须**彻底消失** ✓')
  const reconnect = slice('Tunnel.prototype.reportManualReconnectFailure = function', 'Tunnel.prototype.')
  assert.ok(reconnect.includes("shellNotice("), '手动重连失败必须走统一通知出口 ✓')
  assert.ok(!reconnect.includes('shellToast('), '★ 这一处不该再有直发的提示条（退路在 shellNotice 里 ✓）')
  assert.ok(!reconnect.includes('drawBar('), '★ 更不许退回蓝横幅 ✓')

  // ── ★ 自动重连那一处：恰好一个 shellNotify、零个 shellNotice、一个 shellToast ──
  const giveUp = slice('Tunnel.prototype.giveUpAutoReconnect = function', 'Tunnel.prototype.')
  assert.equal(
    giveUp.split('shellNotify(').length - 1,
    1,
    '★ 放弃时的系统通知必须**恰好一条**（152-④ 钉着它 ✓）',
  )
  assert.equal(giveUp.split('shellNotice(').length - 1, 0, '★ 不许在这里再套一层通知 ⇒ 那会真发两条 ✗')
  assert.equal(giveUp.split('shellToast(').length - 1, 1, '★ 页面提示条必须仍在（152-② 钉着它 ✓）')

  // ── ★ 统一出口本体：走壳的通知 + 无壳退提示条 + **绝不** drawBar + 去重窗 ──
  const noticeBody = functionBodyAtColumn2(bootSource, 'shellNotice')
  assert.ok(noticeBody.includes('shellNotify(head, notice'), '统一出口必须真的调壳的通知桥 ✓')
  assert.ok(noticeBody.includes('shellToast('), '无壳 ⇒ 退提示条 ✓')
  assert.ok(!noticeBody.includes('drawBar'), '★ 退路里**不许**出现 drawBar（那正是要消掉的蓝条 ✗）')
  assert.ok(noticeBody.includes('shellNoticeDeduped('), '统一出口必须过一遍去重窗 ✓')
  // ★ 长度：通知那一侧先截（标题 20 / 正文 72 ✓ —— 照 `downloadNotice` 那位先例 ✓）。
  //   怎么把它打红：把这两句里的 `SHELL_NOTICE_*_MAX` 换成 `Number.MAX_SAFE_INTEGER`
  //   （或不截）⇒ 下面两条立刻红 ✓（正文那条另有行为判据：'手动重连失败' 那个用例
  //   量了正文长度 ≤ 73 ✓）。
  assert.ok(
    noticeBody.includes('shellNoticeShort(title, SHELL_NOTICE_TITLE_MAX)'),
    '★ 通知标题必须先按上限截 ✓',
  )
  assert.ok(noticeBody.includes('shellNoticeShort(body, SHELL_NOTICE_BODY_MAX)'), '★ 通知正文必须先按上限截 ✓')
  assert.ok(
    /var SHELL_NOTICE_TITLE_MAX = 20/.test(codeOnly) && /var SHELL_NOTICE_BODY_MAX = 72/.test(codeOnly),
    '★ 上限就是 20 / 72 ✓（不是随手换的数 ✓）',
  )
  assert.ok(
    functionBodyAtColumn2(bootSource, 'shellNoticeDeduped').includes('SHELL_NOTICE_DEDUP_MS'),
    '去重窗的时长必须是那个常量（不许写死一个数 ✓）',
  )
  assert.ok(
    /var SHELL_NOTICE_DEDUP_MS = 10000|var SHELL_NOTICE_DEDUP_MS = 10_000/.test(codeOnly),
    '★ 去重窗 = 10 秒 ✓（用户看到的是"同一条不会被响两次" ✓）',
  )
})

test('★ 取证：环形上限 12 条（连记 20 轮 ⇒ 只剩 12 条，且留的是**最新**那 12 条）', async () => {
  const rounds: Array<Array<Record<string, unknown>>> = []
  // ★ 一层 = 一轮，里面是该轮要投的 calls ✓（写两层会把"call 本身"变成一个数组 ✗ ——
  //   那样 calls[0].id 全是 undefined ✓，测试会以"看起来像少了 id"的方式红 ✓）。
  for (let n = 1; n <= 20; n++) rounds.push([{ id: `call-${String(n)}`, capability: 'show', text: '提醒' }])
  const fake = makeDeviceTransport({ rounds })
  const surface = bootOnSurface({
    pathname: '/mobile/app',
    innerWidth: 412,
    consent: [],
    transport: fake.transport,
    unrefTimers: true,
  })
  const onTick = surface.intervals[0]
  assert.ok(onTick !== undefined, '端侧通道应至少注册一个轮询定时器')
  // 20 轮 × 4 条 = 80 条 ⇒ 环形只留最后 12 条（= 最后三轮 ✓）
  for (let n = 0; n < 20; n++) {
    onTick()
    await settle()
  }
  const log = readLog(surface)
  // 怎么把它打红：删掉 deviceCallLogPush 里那句
  //   if (entries.length > DEVICE_CALL_LOG_MAX) entries = entries.slice(...)
  // ⇒ 下面长度断言会读到 80 ⇒ 立刻红 ✓（其余用例各自的轮数都 ≤ 12 ⇒ 不受影响 ✓）。
  assert.equal(log.length, 12, `环形上限必须是 12 条（实际 ${String(log.length)} 条）`)
  const keptIds = log.map((entry) => entry.id).filter((id, index, all) => all.indexOf(id) === index)
  assert.deepEqual(
    keptIds.filter((id) => id !== '-'),
    ['call-18', 'call-19', 'call-20'],
    '★ 砍的必须是**最旧**的（留下最新那 12 条 ⇒ 否则"最近发生了什么"就假了 ✗）',
  )
  // 留下来的第一条是第 18 轮那条 taken（taken 记的是"取待办"这一级 ⇒ id 是 '-' ✓），
  // 紧接着才是第 18 轮那条 call 的三段 ✓ —— 第 1..17 轮应当全被挤掉 ✓。
  assert.equal(log[0]?.phase, 'taken', '第一条应是第 18 轮的开头（第 1..17 轮都该被挤掉 ✓）')
  assert.equal(log[0]?.outcome, 'count=1', '留下的那一轮也要保住条数 ✓')
  assert.equal(log[1]?.id, 'call-18', '紧接着应是第 18 轮那条 call（不是更旧的 ✓）')
  assert.deepEqual(
    log.map((entry) => entry.phase),
    [
      'taken', 'exec-start', 'exec-end', 'report-ok',
      'taken', 'exec-start', 'exec-end', 'report-ok',
      'taken', 'exec-start', 'exec-end', 'report-ok',
    ],
    '留下的三轮顺序与四段都要完整 ✓',
  )
  // ★ 同源：落盘那份也是 12 条 ✓（不是只有读数被截断 ✗）
  const persisted = JSON.parse(surface.storage.get('dsh-mobile.deviceCallLog') ?? 'null') as DeviceCallLogEntry[]
  assert.equal(persisted.length, 12, '落盘那份也必须被截断（别让它无限长大 ✗）')
  assert.deepEqual(persisted, log, '读数与落盘必须逐字一致 ✓')
})

test('★ 取证：localStorage 读写都抛错时不崩（而且投递链照旧走完 —— 行为零变化）', async () => {
  const fake = makeDeviceTransport({ rounds: [[notifyCall('call-storage')]] })
  const surface = bootOnSurface({
    pathname: '/mobile/app',
    innerWidth: 412,
    consent: [],
    transport: fake.transport,
    storageThrowsForLog: true,
    unrefTimers: true,
  })
  const onTick = surface.intervals[0]
  assert.ok(onTick !== undefined, '端侧通道应至少注册一个轮询定时器')
  // 怎么把它打红：把 deviceCallLogRead / deviceCallLogPush 里的 try/catch 去掉
  // ⇒ 下面 doesNotThrow 立刻红 ✓（而"照旧回报"那两条仍绿 ✓ —— 假红与真红分得开 ✓）。
  assert.doesNotThrow(() => onTick())
  await settle()
  assert.equal(surface.thrown.length, 0, `顶层不该抛错：${String(surface.thrown[0])}`)
  // ★ 取证坏了**绝不许**影响投递：执行与回报照旧发生 ✓（这条链上抛一次错就会把投递带偏 ✗）
  assert.ok(
    fake.paths.some((path) => path.includes('mobile/device/result')),
    '★ 落盘坏了也必须照旧回报 mobile/device/result ✓',
  )
  assert.match(fake.reportBodies[0] ?? '', /"id":"call-storage"/, '回报内容不许因为取证坏了而变 ✓')
  // ★ 读数也不许炸 ✓（读不出来 ⇒ 空数组 ✓ —— 主线念这一句时不能反被它坑 ✗）
  assert.doesNotThrow(() => surface.boot.apk.deviceCallLog())
  assert.deepEqual(readLog(surface), [], '读不出来 ⇒ 空数组（绝不抛 ✗）')
})

/* ═══════════════════════════════════════════════════════════════════════════
 * ★★ round 186：**反重放位图必须与"连接"同生共死** —— 真机 帧被拒绝（seen） 的回归守卫
 *
 * ## 真机现场（用户截图，逐字）
 *   client api: session/prompt failed: dsh-mobile: 帧被拒绝（seen）(gateway/internal)
 * ★ 不对称症状正是这个病的样子：用户的 prompt **早就送到电脑了**（电脑处理了），
 *   只是**电脑回的那一帧被我们自己的窗口丢掉** ⇒ 手机上"消息没上屏"。
 *
 * ## 机理（同一条链上的三件事）
 *   ① 入站帧被判重放 ⇒ 帧解析抛错 ⇒ socket.onmessage 的 catch 调 self.fail(error)；
 *   ② fail() → failPending(error) ⇒ **把那一刻所有在飞的一元请求一起拒掉**；
 *   ③ 于是用户看到的就是 session/prompt failed: 帧被拒绝（seen）——
 *      电脑那边**一点问题都没有**，病在"这一帧该拿哪张位图去判"。
 *
 * ## 为什么"旧连接的帧"会落进"新会话的位图"
 *   openEndpoint 从不关闭上一条 socket（只有端点超时那一支关自己的），
 *   而每条 socket 的 onmessage / onclose 闭包都指向**同一个** Tunnel 实例
 *   ⇒ 被取代的那条连接照样能把帧喂进当前会话。
 *   两边的 counter 都从 1 数起（ServerAuthOk 恒为 1、数据帧恒从 2 开始，
 *   见 docs/protocol.md 的"计数器占位约定"）⇒ 旧连接的第 3 帧与新会话的第 3 帧
 *   **是同一个数字** ⇒ 新会话位图里那一位早已置位 ⇒ check() 判 seen。
 *
 * ## 本节四条用例各钉住什么
 *   · 用例一：旧会话的位图先 accept 若干 counter ⇒ 走"新连接（重连）"那条路 ⇒
 *     再把旧连接上**迟到**的那一帧送进来 ⇒ 在飞的 session/prompt 必须照常拿到回执；
 *   · 用例二（★ 不许为了修症状把安全属性关掉）：**同一条连接内**逐字节重放一帧已经
 *     接受过的帧 ⇒ 必须**仍然**判 seen；
 *   · 用例三：旧连接的 onclose **迟到** ⇒ 不许拆掉新会话（在飞的请求照常回来）；
 *   · 用例四（结构性）：位图**只有一个出生地**，而且就在"建连接"那一处。
 *
 * ## 这个"世界"为什么不跑手机表面
 *   本节量的是**隧道层的位图归属**，与表面无关；而手机表面会额外起一条 4 秒一轮的
 *   端侧轮询（installDeviceChannel）⇒ 它自己会拨号，把本节时序搅乱。
 *   所以这里用 direct.test.ts 那套最小 DOM（pathname=/ 且宽屏 ⇒ 不装端侧通道），
 *   断言全部打在**生产口**上：__DSH_MOBILE_BOOT__.tunnel（真机上就是同一个对象）。
 * ═══════════════════════════════════════════════════════════════════════════ */

const { DEFAULT_CAPABILITIES, FrameType, fingerprint, generateP256KeyPair } = await import('@dsh-mobile/protocol')
const { DeviceStore } = await import('../../host/src/devices.ts')
/** ★★ 方案 A 真跑：端侧队列用**真的**那个 ✓（取走即投递 ✓、回报即出队 ✓）。 */
const { DeviceCallQueue, DEVICE_CAPABILITIES } = await import('../../host/src/device-calls.ts')
const { TunnelSession } = await import('../../host/src/tunnel.ts')
const { mkdtempSync, rmSync } = await import('node:fs')
const { tmpdir } = await import('node:os')

function collect(node: FakeElement, hit: (node: FakeElement) => boolean): FakeElement[] {
  const out: FakeElement[] = []
  const walk = (current: FakeElement): void => {
    if (hit(current)) out.push(current)
    for (const child of current.children ?? []) walk(child)
  }
  walk(node)
  return out
}

function textOf(node: FakeElement): string {
  return collect(node, () => true)
    .map((child) => String(child.textContent ?? ''))
    .join('｜')
}


type HostConnection = InstanceType<typeof TunnelSession>

/** 反重放窗口（VM 里那个对象的最小可读面 ✓ —— 就是 scripts/check-mobile-layout.mjs 读的那两个字段 ✓）。 */
interface ReplayWindowView {
  started: boolean
  highest: bigint
  check(counter: bigint): string | undefined
}

/** 生产隧道对象（__DSH_MOBILE_BOOT__.tunnel ✓）在本节用到的那一部分 ✓。 */
interface ReplayTunnel {
  sessionId?: string
  inReplay?: ReplayWindowView
  clearReconnectTimer(): void
  stopKeepalive(): void
  rpc(endpoint: string, payload: unknown): Promise<{ rpcId: string; result: { ok: boolean; value?: unknown } }>
  openStream(endpoint: string, payload: unknown): AsyncIterable<unknown>
}

/**
 * 手机侧的 WebSocket 替身 ✓ —— 每条 socket 自己一条**宿主连接**（TunnelSession）✓，
 * 因为真机上就是"一条连接 = 一个新会话" ✓（宿主侧 createTunnelSession 是**每连接**
 * 建一个 ✓，它的 outCounter / inReplay 都是实例字段 ✓ ⇒ counter 从 1 重新数 ✓）。
 *
 * 两个方向都能**扣住**（hold）✓ —— 真机上"这一段字节还卡在网络里"就是这个意思 ✓，
 * 本节靠它把"旧连接上迟到的那一帧"造出来 ✓。
 */
class ReplaySocket {
  static created: ReplaySocket[] = []
  static onSend: ((socket: ReplaySocket, bytes: Uint8Array) => void) | undefined
  readyState = 0
  binaryType = 'blob'
  readonly url: string
  onopen: (() => void) | undefined
  onmessage: ((event: { data: ArrayBuffer }) => void) | undefined
  onclose: (() => void) | undefined
  onerror: (() => void) | undefined
  /** true = 宿主这条连接写过来的**数据帧**先扣住 ✓（握手帧照旧放行 ✓ —— 否则握不了手 ✗）。 */
  holdData = false
  /** 被扣住的帧 ✓（按到达顺序 ✓ —— WebSocket 是有序的 ✓）。 */
  readonly held: Uint8Array[] = []
  /** 已经派发出去的数据帧 ✓（用例二拿它做逐字节重放 ✓）。 */
  readonly delivered: Uint8Array[] = []

  constructor(url: string) {
    this.url = url
    ReplaySocket.created.push(this)
  }

  send(data: unknown): void {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBuffer)
    ReplaySocket.onSend?.(this, bytes)
  }

  /** 宿主那条连接写过来的字节 ✓ */
  deliver(bytes: Uint8Array): void {
    const frame = Uint8Array.from(bytes)
    // 握手帧与数据帧的分界：明文 ServerHello 以 { 开头（0x7b）✓、ServerAuthOk 有自己的帧类型 ✓
    const handshake = frame[0] === 0x7b || frame[0] === FrameType.ServerAuthOk
    if (handshake) {
      this.onmessage?.({ data: frame.buffer as ArrayBuffer })
      return
    }
    if (this.holdData) {
      this.held.push(frame)
      return
    }
    this.delivered.push(frame)
    this.onmessage?.({ data: frame.buffer as ArrayBuffer })
  }

  /** 放行前 count 条被扣住的帧 ✓（FIFO ✓）。 */
  release(count = Number.MAX_SAFE_INTEGER): void {
    const batch = this.held.splice(0, count)
    for (const frame of batch) {
      this.delivered.push(frame)
      this.onmessage?.({ data: frame.buffer as ArrayBuffer })
    }
  }

  /** 把一条**已经派发过**的帧逐字节再送一遍 = 真重放 ✓（用例二用 ✓）。 */
  replayDelivered(index: number): void {
    const frame = this.delivered[index]
    if (frame === undefined) throw new Error('没有第 ' + String(index) + ' 条已派发的帧')
    this.onmessage?.({ data: frame.buffer as ArrayBuffer })
  }

  fireOpen(): void {
    this.readyState = 1
    this.onopen?.()
  }

  /** 半死：浏览器判它断了（readyState 归 3）✓，但 **onclose 还没派发** ✓（真机那半死的连接 ✓）。 */
  markDead(): void {
    this.readyState = 3
  }

  /** 迟到的 onclose ✓。 */
  fireClose(): void {
    this.readyState = 3
    this.onclose?.()
  }

  close(): void {
    this.readyState = 3
    this.onclose?.()
  }
}

interface HostStreamQueue {
  items: unknown[]
  wake: (() => void) | undefined
}

interface ReplayWorld {
  tunnel: ReplayTunnel
  sockets: ReplaySocket[]
  socket(index: number): ReplaySocket
  waitSocket(index: number, what: string): Promise<ReplaySocket>
  waitSession(what: string): Promise<string>
  waitSessionChange(previous: string | undefined, what: string): Promise<string>
  callsOf(socket: ReplaySocket): string[]
  waitCall(socket: ReplaySocket, endpoint: string): Promise<void>
  pushTo(socket: ReplaySocket, value: unknown): void
  cleanup(): void
}

/**
 * 立刻把一条在飞的请求的**两种结局**都接住 ✓ —— 不接的话 node 的测试运行器会把
 * 那一下"未处理的拒绝"直接算成整条用例失败 ✗（那样红的是运行器、不是我们的断言 ✗）。
 */
function trackRpc<T>(promise: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  return promise.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error: String((error as { message?: string } | undefined)?.message ?? error) }),
  )
}

async function waitForValue<T>(probe: () => T | undefined, what: string, ms = 8000): Promise<T> {
  const deadline = Date.now() + ms
  for (;;) {
    const value = probe()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error('等待超时：' + what)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

/** 用 WebCrypto 生成设备签名密钥，并以 boot.js 期望的格式写进 localStorage ✓（照 direct.test.ts ✓）。 */
async function createReplayDeviceKey(): Promise<{ deviceId: string; publicKeyB64u: string; storageValue: string }> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  const publicRaw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))
  const privateJwk = await crypto.subtle.exportKey('jwk', pair.privateKey)
  const deviceId = 'web-replay-device'
  const publicKeyB64u = Buffer.from(publicRaw).toString('base64url')
  return { deviceId, publicKeyB64u, storageValue: JSON.stringify({ deviceId, publicKey: publicKeyB64u, privateKeyJwk: privateJwk }) }
}

async function bootReplayWorld(): Promise<ReplayWorld> {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-mobile-replay-'))
  const deviceStore = new DeviceStore({ directory: dir })
  const hostSigningKey = generateP256KeyPair()
  const device = await createReplayDeviceKey()
  deviceStore.upsert({
    deviceId: device.deviceId,
    devicePublicKey: '',
    deviceSigningKey: device.publicKeyB64u,
    fingerprint: fingerprint(device.publicKeyB64u),
    name: '反重放回归端',
    pairedAt: new Date().toISOString(),
    authorization: 'persistent',
    capabilities: { ...DEFAULT_CAPABILITIES },
  })
  const hostFingerprint = fingerprint(hostSigningKey.publicKey)

  const calls = new Map<ReplaySocket, string[]>()
  const queues = new Map<ReplaySocket, HostStreamQueue>()
  const sessions = new Map<ReplaySocket, HostConnection>()
  const callsOf = (socket: ReplaySocket): string[] => {
    const existing = calls.get(socket)
    if (existing !== undefined) return existing
    const fresh: string[] = []
    calls.set(socket, fresh)
    return fresh
  }

  ReplaySocket.created.length = 0
  ReplaySocket.onSend = (socket, bytes) => {
    let session = sessions.get(socket)
    if (session === undefined) {
      const queue: HostStreamQueue = { items: [], wake: undefined }
      queues.set(socket, queue)
      session = new TunnelSession(
        {
          resolveDevice: (hello) => {
            const record = deviceStore.get(hello.deviceId)
            if (record === undefined) return undefined
            return {
              deviceId: record.deviceId,
              devicePublicKey: record.devicePublicKey,
              deviceSigningKey: record.deviceSigningKey,
              fingerprint: record.fingerprint,
              capabilities: record.capabilities,
              authorization: record.authorization,
            }
          },
          invoke: async (request) => {
            callsOf(socket).push(request.endpoint)
            // ★ 隧道把这里的返回值**当 result 原样发** ✓（第 109 轮起）⇒ 必须是与 DSH 一致的
            //   信封 `{ok:true,value}` ✗ 不许返回裸值（裸值会让真机卡在"永不 resolve" ✓）。
            return { ok: true, value: { endpoint: request.endpoint, payload: request.payload } }
          },
          openStream: () =>
            (async function* () {
              for (;;) {
                if (queue.items.length === 0) await new Promise<void>((resolve) => { queue.wake = resolve })
                while (queue.items.length > 0) yield queue.items.shift()
              }
            })(),
        },
        (out) => {
          socket.deliver(new Uint8Array(out))
          return true
        },
      )
      session.hostId = 'host-replay'
      session.hostSigningKey = hostSigningKey as never
      sessions.set(socket, session)
    }
    session.receive(bytes)
  }

  const sandboxGlobals: Record<string, unknown> = {
    console: { info: () => {}, warn: () => {}, error: () => {}, log: () => {} },
    crypto: globalThis.crypto,
    TextEncoder,
    TextDecoder,
    Response,
    URL,
    URLSearchParams,
    Blob: globalThis.Blob,
    setTimeout,
    clearTimeout,
    /**
     * ★ 定时器一律**不排程** ✓：boot.js 的 15 秒保活 Ping 会换来宿主的 Pong ✓，
     *   而 Pong 是一帧**入站数据帧** ⇒ 它会吃掉一个 counter ✓ ⇒ 本节那套
     *   "第 3 帧对第 3 帧"的碰撞就不再是确定的 ✗（假红/假绿都从这儿来 ✗）。
     */
    setInterval: () => 0,
    clearInterval: () => {},
    atob: (value: string) => Buffer.from(value, 'base64').toString('binary'),
    btoa: (value: string) => Buffer.from(value, 'binary').toString('base64'),
    location: {
      origin: 'https://10.34.221.181:3443',
      protocol: 'https:',
      host: '10.34.221.181:3443',
      pathname: '/',
      search: '',
      href: 'https://10.34.221.181:3443/',
    },
    document: {
      body: { dataset: {}, appendChild: () => {} },
      head: { appendChild: () => {} },
      getElementById: () => null,
      createElement: () => ({ addEventListener: () => {}, dataset: {} }),
      addEventListener: () => {},
      querySelector: () => null,
    },
    localStorage: {
      values: {
        'dsh-mobile.device-key': device.storageValue,
        'dsh-mobile.host': JSON.stringify({
          baseUrl: 'https://10.34.221.181:3443',
          tunnelUrl: 'wss://10.34.221.181:3443/mobile/ws',
          pinnedHostFingerprint: hostFingerprint,
        }),
      } as Record<string, string>,
      getItem(this: { values: Record<string, string> }, key: string) {
        return this.values[key] ?? null
      },
      setItem(this: { values: Record<string, string> }, key: string, value: string) {
        this.values[key] = value
      },
      removeItem(this: { values: Record<string, string> }, key: string) {
        delete this.values[key]
      },
    },
    history: { replaceState: () => {} },
    WebSocket: ReplaySocket,
    innerWidth: 1440,
    innerHeight: 900,
    isSecureContext: true,
  }
  sandboxGlobals['globalThis'] = sandboxGlobals
  sandboxGlobals['window'] = sandboxGlobals
  runInNewContext(bootSource, sandboxGlobals, { filename: 'boot.js' })
  const boot = sandboxGlobals['__DSH_MOBILE_BOOT__'] as { tunnel?: ReplayTunnel } | undefined
  const tunnel = boot?.tunnel
  assert.ok(tunnel !== undefined, 'boot.js 必须把生产隧道对象挂上 __DSH_MOBILE_BOOT__.tunnel（本节断言就打在这里）')
  await waitForValue(() => (ReplaySocket.created.length > 0 ? ReplaySocket.created[0] : undefined), 'boot 拨出第一发（建第一条连接）')

  const socket = (index: number): ReplaySocket => {
    const found = ReplaySocket.created[index]
    if (found === undefined) throw new Error('还没有第 ' + String(index) + ' 条 socket')
    return found
  }
  const waitSocket = async (index: number, what: string): Promise<ReplaySocket> =>
    await waitForValue(() => ReplaySocket.created[index], what)
  const waitSession = async (what: string): Promise<string> =>
    await waitForValue(() => tunnel.sessionId, what)
  const waitSessionChange = async (previous: string | undefined, what: string): Promise<string> =>
    await waitForValue(() => (tunnel.sessionId !== undefined && tunnel.sessionId !== previous ? tunnel.sessionId : undefined), what)

  return {
    tunnel,
    sockets: ReplaySocket.created,
    socket,
    waitSocket,
    waitSession,
    waitSessionChange,
    callsOf,
    waitCall: async (target, endpoint) => {
      await waitForValue(() => (callsOf(target).includes(endpoint) ? true : undefined), '宿主收到 ' + endpoint)
    },
    pushTo: (target, value) => {
      const queue = queues.get(target)
      if (queue === undefined) throw new Error('这条连接上还没有开过流')
      queue.items.push(value)
      const wake = queue.wake
      queue.wake = undefined
      if (wake !== undefined) wake()
    },
    cleanup: () => {
      ReplaySocket.onSend = undefined
      try {
        tunnel.stopKeepalive()
        tunnel.clearReconnectTimer()
      } catch (error) {
        void error
      }
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

test('★★ 真机现场：重连之后，旧连接上迟到的那一帧不许被新会话的位图判成 seen', async () => {
  const world = await bootReplayWorld()
  const t = world.tunnel
  try {
    // ── ① 旧会话：握手 + 一次正常往返 ⇒ 它的位图先 accept 掉 1（ServerAuthOk）、2（回执）
    const A = world.socket(0)
    A.fireOpen()
    const sessionA = await world.waitSession('第一条连接完成握手')
    await t.rpc('session/list', { args: {} })
    // 怎么把它打红（前置本身）：把下面那句 A.holdData = true 挪到这次 rpc **之前**
    //   ⇒ 旧位图就只有 {1} ⇒ 用例一最后那次"counter=3 的碰撞"不成立 ⇒ 旧行为也不红（假绿 ✗）。
    assert.equal(t.inReplay?.started, true, '前置（复现的诚实性）：这条活会话的位图真的"见过"计数')
    assert.equal(Number(t.inReplay?.highest), 2, '前置：旧会话的位图已经走过 1（ServerAuthOk）+ 2（回执）')

    // ── ② 这条连接**半死**：浏览器判它断了（readyState 归 3），但 onclose 还没派发
    //      —— 真机上"旧连接还挂在那儿、宿主还在往上写"就是这个样子
    A.holdData = true
    t.openStream('$events', { args: {} })
    await settle()
    world.pushTo(A, { seq: 'A-3' })
    await settle()
    assert.equal(A.held.length, 1, '前置：旧连接上确实扣着一帧（它的 counter=3 ✓）')
    A.markDead()

    // ── ③ 走"新连接（重连）"那条路：端侧轮询那条 rpc 开头 await dialNow(false) ⇒ 真拨号
    const poll = t.rpc('mobile/device/pending', { args: {} })
    const B = await world.waitSocket(1, '拨出第二条连接')
    B.holdData = true
    B.fireOpen()
    const sessionB = await world.waitSessionChange(sessionA, '新连接完成握手')
    assert.notEqual(sessionB, sessionA, '★ 重连就是**新会话**（协议里没有会话恢复）—— 会话标识必须变')
    B.release(1)
    await poll
    // 新会话的位图先走到 {1, 2, 3}：真机上重连之后界面会立刻打一串请求（轮询 + 事件流）
    t.openStream('$events', { args: {} })
    await settle()
    world.pushTo(B, { seq: 'B-3' })
    await settle()
    B.release(1)
    await settle()
    assert.equal(Number(t.inReplay?.highest), 3, '前置：新会话的位图也走到 3 了 ⇒ 旧连接那帧的 counter **正落在它范围内**')

    // ── ④ 用户按下发送（截图里那条）
    const prompt = trackRpc(t.rpc('session/prompt', { args: {} }))
    await world.waitCall(B, 'session/prompt')
    // ★ 现场的前半句：prompt **早就送到电脑了**（电脑收到了、也处理了）
    assert.ok(world.callsOf(B).includes('session/prompt'), '★ prompt 必须已经送到电脑（现场的前半句）')

    // ── ⑤ ★ 旧连接上那一帧（counter=3）现在才到 —— 这一步就是真机现场
    A.release()
    await settle()

    // ── ⑥ 判据：在飞的那条 session/prompt 必须照常拿到电脑的回执
    //     怎么把它打红：把 openEndpoint 里那句"取代判据"（self.inReplay !== inboundReplay）
    //     去掉、或把 onMessage 的 replay 参数改回 this.inReplay
    //     ⇒ 旧连接那帧落进新会话的位图 ⇒ check() 判 seen ⇒ failPending 把这条在飞的
    //       prompt 一起拒掉 ⇒ 下面这条立刻红（红的时候 message 逐字是
    //       dsh-mobile: 帧被拒绝（seen），与用户截图同一句）。
    B.release(1)
    const settledPrompt = await prompt
    assert.equal(
      settledPrompt.ok,
      true,
      '★ 迟到的那一帧不许把在飞的 session/prompt 带崩（现场：回执被我们自己的窗口丢掉）；实际=' + JSON.stringify(settledPrompt),
    )
    assert.equal(t.sessionId, sessionB, '会话不许被那条迟到帧换掉')
  } finally {
    world.cleanup()
  }
})

test('★ 不许削弱反重放：同一条连接内逐字节重放已经见过的帧，必须仍然判 seen', async () => {
  const world = await bootReplayWorld()
  const t = world.tunnel
  try {
    const A = world.socket(0)
    A.fireOpen()
    await world.waitSession('第一条连接完成握手')
    const first = t.rpc('session/list', { args: {} })
    await first
    assert.equal(Number(t.inReplay?.highest), 2, '前置：这条会话的位图已经走过 2 帧')
    // WebSocket 是有序的 ⇒ delivered[0] 就是宿主那条 ServerAuthOk 之后的第一帧数据帧（counter=2）
    const replayIndex = 0
    assert.ok(A.delivered.length > replayIndex, '前置：确实有一帧可以拿来重放')

    const victim = trackRpc(t.rpc('mobile/device/pending', { args: {} }))
    // 怎么把它打红（★ 这条是"不许把安全属性关掉"的那条）：把 ReplayWindow.check 的
    //   "位图已标记 ⇒ 拒绝"那一支去掉（或者每次 openFrame 都换一张新位图 ⇒ 等于每帧都放过）
    //   ⇒ 下面 assert.rejects 立刻红（真重放被当成正常帧接受了）。
    A.replayDelivered(replayIndex)
    await settle()
    const settled = await victim
    assert.equal(settled.ok, false, '★ 真重放必须仍然被拒（不许为了修误拒把反重放关掉）；实际=' + JSON.stringify(settled))
    assert.match(
      settled.ok ? '' : settled.error,
      /帧被拒绝（seen）/,
      '★ 而且拒的理由必须还是 seen（同一条连接内、同一个 counter 第二遍）',
    )
    // ★ 反向守卫：这条重放判据**不许**落到"别的连接"的帧上 —— 见用例一（那里是另一条连接的帧，
    //   它必须被**丢弃**、而不是被拿来判重放）。
  } finally {
    world.cleanup()
  }
})

test('★ 旧连接的 onclose 迟到时，不许拆掉新会话（在飞的请求照常拿到回执）', async () => {
  const world = await bootReplayWorld()
  const t = world.tunnel
  try {
    const A = world.socket(0)
    A.fireOpen()
    const sessionA = await world.waitSession('第一条连接完成握手')
    A.markDead()

    const poll = t.rpc('mobile/device/pending', { args: {} })
    const B = await world.waitSocket(1, '拨出第二条连接')
    B.holdData = true
    B.fireOpen()
    const sessionB = await world.waitSessionChange(sessionA, '新连接完成握手')
    B.release(1)
    await poll

    const inflight = trackRpc(t.rpc('session/prompt', { args: {} }))
    await world.waitCall(B, 'session/prompt')
    // ★ 旧连接那条 socket 的关闭事件**迟到**（真机：它早就半死了，onclose 过一会儿才派发）
    A.fireClose()
    await settle()
    // 怎么把它打红：把 openEndpoint 里 onclose 开头那句"取代判据"去掉
    //   ⇒ 旧连接的关闭事件会 stopKeepalive + failPending + scheduleReconnect
    //   ⇒ 下面这条在飞的 session/prompt 被 failPending 拒掉（message 是
    //     与电脑的连接已断开，正在自动重连）⇒ 立刻红。
    B.release(1)
    const settled = await inflight
    assert.equal(settled.ok, true, '★ 已经被取代的那条连接，它的关闭事件不许动新会话；实际=' + JSON.stringify(settled))
    assert.equal(t.sessionId, sessionB, '★ 会话标识不许被旧连接的关闭事件换掉（那等于凭空重连一次）')
  } finally {
    world.cleanup()
  }
})

test('★ 结构性：反重放位图只有一个出生地，而且就在"建连接"那一处', () => {
  // 这一条量的是**代码形状**（本节唯一一条非行为判据）—— 它防的是"修法退化回
  // 在某一条拨号路径上补一句重置"，那正是这个坑反复复发的成因。
  const boot = bootSource
  const codeOnly = boot
    .split('\n')
    .filter((line) => {
      const text = line.trim()
      return !(text.startsWith('*') || text.startsWith('/*') || text.startsWith('//'))
    })
    .join('\n')
  const births = codeOnly.split('new ReplayWindow(').length - 1
  // 怎么把它打红：在 resetSessionState 或构造函数里再写一句 this.inReplay = new ReplayWindow(1024)
  //   ⇒ 下面第一条立刻红（出生地变成两处/三处）；把 openEndpoint 里那一句挪走 ⇒ 第二条红。
  assert.equal(births, 2, '反重放位图的出生地必须只有两处：连接出生处（1024）+ 握手探针（16）')
  const openStart = codeOnly.indexOf('Tunnel.prototype.openEndpoint = function')
  const openEnd = codeOnly.indexOf('Tunnel.prototype.', openStart + 10)
  assert.ok(openStart > 0 && openEnd > openStart, '必须能在源码里切出 openEndpoint 这一块')
  const openBody = codeOnly.slice(openStart, openEnd)
  // 怎么把它打红：把 openEndpoint 里那句 new ReplayWindow(1024) 删掉（或挪回构造函数）
  //   ⇒ 立刻红（那正是"走别的拨号路径时位图是旧的"那个漏网）。
  assert.ok(openBody.includes('new ReplayWindow(1024)'), '位图必须与 socket 在**建连接**那一处同生（openEndpoint 里）')
  for (const [name, marker] of [
    ['构造函数', 'function Tunnel(config)'],
    ['会话复位 resetSessionState', 'Tunnel.prototype.resetSessionState = function'],
  ] as const) {
    const start = codeOnly.indexOf(marker)
    assert.ok(start > 0, '必须能找到' + name)
    const end = codeOnly.indexOf('Tunnel.prototype.', start + marker.length)
    const body = codeOnly.slice(start, end)
    // 怎么把它打红：往这两块里各加一句 new ReplayWindow(1024) ⇒ 立刻红
    //   （构造函数里那张 = "没有连接的位图"；复位里那张 = "复位顺手造一张，
    //     却还留着旧连接 ⇒ 旧连接的帧照样落进新位图"）。
    assert.ok(!body.includes('new ReplayWindow'), name + '里不许建位图（没有连接就没有会话位图）')
  }
})
/* ════════════════════════════════════════════════════════════════════════════════
 * ★★ 本轮（R1/R4/R5）：**"换网就要重新配对"这条**的回归
 *
 * ## 用户原话（本轮修的就是它 ✗）
 * 「tailscale 和校园网连接会互相冲突，**连好 tail 以后校园网的隧道就需要重新配对**」
 *
 * ## 病根（诊断见 30-换网重新配对问题-诊断.md ✓；读数全部是代码级 ✓）
 *   槽只来自"当前页面的 config"✓，而 `hostRecordUpsert` 把 `slots` **整组替换** ✗ ⇒
 *   同一台电脑的第二个地址把第一个地址挤掉 ✓ ⇒ 换回来时 `currentHostFingerprint()`
 *   三条路全断（票据只在配对当次有 ✗ / 目录里没有这个源 ✗ / 旧键早被迁移删掉 ✗）⇒
 *   `restoreIdentityFromVault()` 一个键都不恢复 ✗ ⇒ 界面"尚未配对" ⇒ 只能重新配对 ⇒
 *   配完又把另一头挤掉 ✓ —— **两个地址互相挤，配一次坏一次** ✓。
 *
 * ## 本组用例怎么钉住它
 *   · R1a：槽**按宿主合并、只增不减**（去重 / 有上限 / 新的在前 ✓）；
 *   · R1b：配对当次的候选地址（票据 `endpoints` ✓）**必须落盘** ✓、
 *     并**跨得过**那次"一次性重载丢 `?pair=`"✓；
 *   · 端到端：**学校配对 ⇒ 切 Tailscale ⇒ 回学校**，三次都要认得出这台电脑 ✓
 *     （这就是用户那句原话的可执行版本 ✓）；
 *   · R4：本机没有这台宿主的身份时被拒 ⇒ **一个键都不许动** ✗（免得连坐清掉另一个源的备份 ✓）；
 *   · R5：诊断页能念出"为什么认不出这台电脑" ✓（此前这条链在手机上完全不可见 ✗）。
 *
 * ★ 一个沙箱 = 一个源 ✓（`host` 选项 ✓），而**壳是跨源的** ✓（同一个 Map 传进三次 ✓）——
 *   这正是真机上"两个地址 = 两个 localStorage + 同一个 SharedPreferences"的形状 ✓。
 * ════════════════════════════════════════════════════════════════════════════════ */

/** 这台电脑的宿主指纹（形状与真实一致：32 位小写十六进制 ✓）。 */
const FP_MINE = 'cccccccccccccccccccccccccccccccc'
/** 另一个宿主（用来证明"合并绝不跨记录" ✗）。 */
const FP_OTHER = 'dddddddddddddddddddddddddddddddd'
const HOST_SCHOOL = 'school.example:3443'
const ORIGIN_SCHOOL = 'https://' + HOST_SCHOOL
const HOST_TS = '100.123.136.82:3443'
const ORIGIN_TS = 'https://' + HOST_TS

/**
 * 一个**哑存储**假壳 ✓ —— `vaultGet` / `vaultSet` 与 Java 侧**同一份约定** ✓
 * （载荷里值为 `null` ⇒ 删除该键 ✓）。`vault` 是外面传进来的 Map ✓ ⇒
 * 断言能直接看"壳里那条还在不在"✓，而且**三个沙箱可以共享同一个壳** ✓（= 跨源 ✓）。
 */
function makeVaultShell(
  vault: Map<string, string>,
  shellSlots: Array<{ label: string; url: string }> = [],
): Record<string, unknown> {
  return {
    version: () => 'test-shell-1',
    vaultGet: () => JSON.stringify(Object.fromEntries(vault)),
    vaultSet: (payload: string) => {
      const patch = JSON.parse(payload) as Record<string, unknown>
      for (const key of Object.keys(patch)) {
        const value = patch[key]
        if (value === null || value === undefined) vault.delete(key)
        else vault.set(key, String(value))
      }
    },
    endpoints: () => JSON.stringify({ slots: shellSlots, timeoutMs: 2000 }),
    insets: () => JSON.stringify({ seen: false }),
    platform: () => JSON.stringify({ android: 34 }),
    changeAddress: () => {},
    // ★ 上报槽那条路会调它 ✓（生产里是真桥 ✓；这里只要不抛就行 ✓）
    setEndpointSlots: () => {},
    scanPair: () => 'ok',
    notify: () => {},
    setBackAvailable: () => {},
    backAvailable: () => {},
    onResume: () => {},
  }
}

/** 目录里那条记录记着的**全部**地址 ✓（顺序也算判据 ✓）。 */
function recordSlots(records: Array<Record<string, unknown>>, fingerprint: string): string[] {
  const record = records.find((item) => item['fingerprint'] === fingerprint)
  assert.ok(record !== undefined, '目录里应有这台宿主：' + fingerprint + '（实际 ' + JSON.stringify(records.map((r) => r['fingerprint'])) + '）')
  const slots = Array.isArray(record['slots']) ? (record['slots'] as Array<Record<string, unknown>>) : []
  /**
   * ★ 必须**自己造一个本 realm 的数组** ✗：`records` / `slots` 都是 vm 里的对象 ✓
   *   （`runInNewContext` 两个 realm ✓）⇒ 直接 map 出来的还是**对方 realm** 的数组 ✗ ⇒
   *   `assert.deepEqual` 会因为"原型不同"红得毫无信息量 ✓（multi-host.test.ts 里那条注释踩过同一个坑 ✓）。
   */
  const out: string[] = []
  for (const slot of slots) out.push(String(slot['url'] ?? ''))
  return out
}

/** 票据那条 base64url ✓（与宿主 `Buffer.toString('base64url')` / 网页 `unb64u` 同一形状 ✓）。 */
function base64url(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url')
}

/** 等异步的 `boot()` 走完那几段（claim / 落盘 ✓）。 */
async function bootSettle(ms = 90): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

test('★★ R1a：同一台电脑的第二个地址不许把第一个地址挤掉（slots 按宿主合并、只增不减）', () => {
  const vault = new Map<string, string>()
  const surface = bootOnSurface({
    pathname: '/mobile/app',
    innerWidth: 412,
    consent: [],
    shell: makeVaultShell(vault),
  })
  assert.equal(surface.thrown.length, 0, `顶层不应抛错：${String(surface.thrown[0])}`)
  const api = surface.boot.apk
  // ① 学校地址上配对成功 ⇒ 目录记下"学校"这一条（外加本页那个源 ✓ —— 产品本来就这么记 ✓）
  api.storeHost({
    baseUrl: ORIGIN_SCHOOL,
    tunnelUrl: 'wss://' + HOST_SCHOOL + '/mobile/ws',
    pinnedHostFingerprint: FP_MINE,
  })
  assert.deepEqual(
    recordSlots(api.hosts(), FP_MINE),
    [ORIGIN_SCHOOL, 'https://10.34.221.181:3443'],
    '第一次配对：记下配对那个源 + 本页源 ✓',
  )
  // ② 切到 Tailscale（同一台电脑的**另一个地址** ⇒ 同一个指纹 ✓）之后又连上
  api.storeHost({
    baseUrl: ORIGIN_TS,
    tunnelUrl: 'wss://' + HOST_TS + '/mobile/ws',
    pinnedHostFingerprint: FP_MINE,
  })
  const merged = recordSlots(api.hosts(), FP_MINE)
  assert.ok(
    merged.includes(ORIGIN_SCHOOL),
    '★ 学校那条**必须还在** ✗（以前这里被整组替换掉 ⇒ 回学校就认不出这台电脑 ✓）：' + JSON.stringify(merged),
  )
  assert.ok(merged.includes(ORIGIN_TS), 'Tailscale 那条也要在 ✓：' + JSON.stringify(merged))
  assert.equal(merged[0], ORIGIN_TS, '最近连上的那个源排第一 ✓（面板「电脑」那一行显示的就是 slots[0] ✓）')
  assert.equal(
    merged.filter((url) => url === 'https://10.34.221.181:3443').length,
    1,
    '同 host 去重 ✓（同一个源不许记两遍 ✗）：' + JSON.stringify(merged),
  )
})

test('★★ R1a：合并只在同一条宿主记录内 —— 另一台电脑的地址绝不许被记到本台名下', () => {
  const vault = new Map<string, string>()
  const surface = bootOnSurface({
    pathname: '/mobile/app',
    innerWidth: 412,
    consent: [],
    shell: makeVaultShell(vault),
  })
  const api = surface.boot.apk
  // 本机（这台电脑）在学校那个地址上有记录 ✓
  api.hostRecord({ fingerprint: FP_MINE, slots: [{ label: '学校', url: ORIGIN_SCHOOL }], updatedAt: 1 })
  // 另一台电脑（另一个指纹 ✓ —— 它自己是另一个 authority ✓）
  api.hostRecord({ fingerprint: FP_OTHER, slots: [{ label: '别的电脑', url: 'https://other.example:3443' }], updatedAt: 1 })
  const mine = recordSlots(api.hosts(), FP_MINE)
  const other = recordSlots(api.hosts(), FP_OTHER)
  assert.deepEqual(other, ['https://other.example:3443'], '另一台只该有它自己那条 ✗：' + JSON.stringify(other))
  assert.equal(
    other.includes(ORIGIN_SCHOOL),
    false,
    '★ 合并绝不许跨记录 ✗（跨了就会"按槽认源"认错机器 ✓ —— 比少个名字严重得多 ✓）',
  )
  assert.deepEqual(mine, [ORIGIN_SCHOOL], '本台那条也要原样在 ✓：' + JSON.stringify(mine))
})

test('★ R1a：槽有上限（新的在前 ⇒ 超了砍尾巴 = 砍最老那些）', () => {
  const surface = bootOnSurface({
    pathname: '/mobile/app',
    innerWidth: 412,
    consent: [],
    shell: makeVaultShell(new Map<string, string>()),
  })
  const api = surface.boot.apk
  for (let index = 0; index < 9; index += 1) {
    api.hostRecord({
      fingerprint: FP_MINE,
      slots: [{ label: '', url: 'https://host' + index + '.example:3443' }],
      updatedAt: index + 1,
    })
  }
  const slots = recordSlots(api.hosts(), FP_MINE)
  assert.ok(slots.length <= 6, '槽不许无限长 ✗：' + JSON.stringify(slots))
  assert.equal(slots[0], 'https://host8.example:3443', '最新的排第一 ✓：' + JSON.stringify(slots))
  assert.equal(slots.includes('https://host0.example:3443'), false, '最老的那条被砍掉 ✓：' + JSON.stringify(slots))
})

test('★ R1a：旧槽上的名字不许被空名字冲掉（壳里补的「学校」/「Tailscale」保得住 ✓）', () => {
  const surface = bootOnSurface({
    pathname: '/mobile/app',
    innerWidth: 412,
    consent: [],
    shell: makeVaultShell(new Map<string, string>()),
  })
  const api = surface.boot.apk
  api.hostRecord({ fingerprint: FP_MINE, slots: [{ label: '学校', url: ORIGIN_SCHOOL }], updatedAt: 1 })
  // 同一条地址、这次**没带名字**（真实情形：下一次上报只认得当前源 ✓）
  api.hostRecord({ fingerprint: FP_MINE, slots: [{ label: '', url: ORIGIN_SCHOOL }], updatedAt: 2 })
  const record = api.hosts().find((item) => item['fingerprint'] === FP_MINE)
  const slots = (record?.['slots'] ?? []) as Array<Record<string, unknown>>
  assert.equal(slots.length, 1, '同 host 去重后只剩一条 ✓：' + JSON.stringify(slots))
  assert.equal(slots[0]?.['label'], '学校', '★ 已经补好的名字不许被空串冲掉 ✗：' + JSON.stringify(slots))
})

test('★★ R1b：配对当次的候选地址（票据 endpoints）要落盘、并进目录 —— 跨得过那次"丢 ?pair="的重载', async () => {
  const vault = new Map<string, string>()
  const ticket = base64url(
    JSON.stringify({
      ticket: 'TICKET-1',
      code: '123456',
      hostFingerprint: FP_MINE,
      endpoints: [ORIGIN_SCHOOL, ORIGIN_TS],
    }),
  )
  const surface = bootOnSurface({
    pathname: '/mobile/app',
    innerWidth: 412,
    consent: [],
    host: HOST_SCHOOL,
    shell: makeVaultShell(vault),
    search: '?debug=1&pair=' + ticket,
  })
  assert.equal(surface.thrown.length, 0, `顶层不应抛错：${String(surface.thrown[0])}`)
  await bootSettle()
  const stored = surface.boot.apk.storedHost()
  assert.ok(stored !== null, '配对那一次加载必须把配置落盘 ✓')
  assert.deepEqual(
    // ★ 同样要搬进本 realm 再比 ✗（vm 里的数组原型不同 ✓ —— 见 recordSlots 那段说明 ✓）
    Array.from((stored?.['endpoints'] ?? []) as string[]),
    [ORIGIN_SCHOOL, ORIGIN_TS],
    '★ 票据给的**全部**候选地址必须一起落盘 ✗（以前只写三个字段 ⇒ 永久丢掉 ✗）：' + JSON.stringify(stored),
  )
  assert.equal(stored?.['pairingTicket'], undefined, '票据照旧**不落盘** ✓（它是一次性的 ✓）')
  const slots = recordSlots(surface.boot.apk.hosts(), FP_MINE)
  assert.ok(
    slots.includes(ORIGIN_TS),
    '★ 票据广告的另一个地址必须进目录 ✓（它就是"换源之后还认得出"的唯一依据 ✓）：' + JSON.stringify(slots),
  )
})

test('★★★ R1a+R1b 端到端：学校配对 ⇒ 切 Tailscale 不用重配 ⇒ 回学校也不用重配（用户那句原话）', async () => {
  /** ★ **同一个壳**跨三次加载 ✓（= 真机上的 SharedPreferences ✓）；三个沙箱 = 三个源 ✓。 */
  const vault = new Map<string, string>()
  const ticket = base64url(
    JSON.stringify({
      ticket: 'TICKET-1',
      code: '123456',
      hostFingerprint: FP_MINE,
      endpoints: [ORIGIN_SCHOOL, ORIGIN_TS],
    }),
  )
  // ── ① 学校地址上扫码配对（URL 带票据 ⇒ readUrlConfig 那条路 ✓）
  const school = bootOnSurface({
    pathname: '/mobile/app',
    innerWidth: 412,
    consent: [],
    host: HOST_SCHOOL,
    shell: makeVaultShell(vault),
    search: '?debug=1&pair=' + ticket,
  })
  await bootSettle()
  assert.deepEqual(
    recordSlots(school.boot.apk.hosts(), FP_MINE).sort(),
    [ORIGIN_SCHOOL, ORIGIN_TS].sort(),
    '★ 配对当次就把两个地址都记进目录 ✓：' + JSON.stringify(recordSlots(school.boot.apk.hosts(), FP_MINE)),
  )
  // 真机上配对之后，设备私钥会被 backfill 进壳（`backfillIdentityVault` ✓）——
  // 这里显式走**同一个写入口**种一次 ✓（配对落盘与身份入壳是两条路 ✓）。
  assert.equal(school.boot.apk.identityWrite('dsh-mobile.device-key:' + FP_MINE, 'KEY-1'), true, '身份写入口应接受带指纹的键 ✓')
  assert.equal(vault.get('dsh-mobile.device-key:' + FP_MINE), 'KEY-1', '壳里必须真的有这把私钥 ✓（跨源那份 ✓）')

  // ── ② 切到 Tailscale（**新源** ✓ localStorage 空的 ✓）——不该再要重新配对 ✗
  const tail = bootOnSurface({
    pathname: '/mobile/app',
    innerWidth: 412,
    consent: [],
    host: HOST_TS,
    shell: makeVaultShell(vault),
  })
  assert.equal(
    tail.boot.apk.currentFingerprint(),
    FP_MINE,
    '★ 换到 Tailscale 也认得出这台电脑 ✓（目录里记着它两个地址 ✓）',
  )
  assert.equal(
    tail.storage.get('dsh-mobile.device-key:' + FP_MINE),
    'KEY-1',
    '★ 身份从壳里恢复出来了 ⇒ **不用重新配对** ✓（修复前这里是 undefined ✗）',
  )
  assert.equal(tail.thrown.length, 0, `顶层不应抛错：${String(tail.thrown[0])}`)
  /**
   * ★★ 真机上"在 Tailscale 上连上了"这一步**必须一起模拟** ✗ —— 它走的是
   *   `noteHostConnected` ⇒ `hostRecordUpsert({..., slots: hostSlotsForConfig(config)})` ✓。
   *   而在"配置里没有 endpoints"的形状下（老配置 / 配对页写的那份 ✓ /
   *   宿主只广告自己一条的部署 ✓），那一次 upsert 算出来的槽**只有当前这个源** ✗ ⇒
   *   只靠 R1b 是不够的 ✗：**R1a（按宿主合并、只增不减）才是这一步的兜底** ✓。
   *   （这里直接用 `hostRecord` 表达那一次 upsert 的产物 ✓ —— 与生产同一个写入口 ✓。）
   */
  assert.equal(
    tail.boot.apk.hostRecord({
      fingerprint: FP_MINE,
      slots: [{ label: '', url: ORIGIN_TS }],
      lastState: 'connected',
      lastSeenAt: 2,
      updatedAt: 2,
    }),
    true,
    '在 Tailscale 上连上 ⇒ 记一次目录 ✓',
  )
  assert.deepEqual(
    recordSlots(tail.boot.apk.hosts(), FP_MINE),
    [ORIGIN_TS, ORIGIN_SCHOOL],
    '★ 连上之后学校那条**仍然要在** ✗（以前这一步把它挤掉 ⇒ 回学校就认不出 ✓）',
  )

  // ── ③ 回学校（又一个新源 ✓）——用户报的那条：**这里以前是要重新配对的** ✗→✓
  const back = bootOnSurface({
    pathname: '/mobile/app',
    innerWidth: 412,
    consent: [],
    host: HOST_SCHOOL,
    shell: makeVaultShell(vault),
  })
  assert.equal(back.boot.apk.currentFingerprint(), FP_MINE, '★ 回学校仍然认得出这台电脑 ✓')
  assert.equal(
    back.storage.get('dsh-mobile.device-key:' + FP_MINE),
    'KEY-1',
    '★ 回学校也不用重新配对 ✓（"连好 tail 以后校园网要重新配对"就是这一条 ✗→✓）',
  )
})

test('★★ R4：本机没有这台宿主的身份时被拒 ⇒ **一个键都不许动**（免得连坐清掉另一个地址的备份）', () => {
  const vault = new Map<string, string>([
    // 这台电脑在**另一个地址**上配过对：配置 + 私钥都在壳里 ✓
    ['dsh-mobile.host:' + FP_MINE, JSON.stringify({ baseUrl: ORIGIN_SCHOOL, tunnelUrl: 'wss://' + HOST_SCHOOL + '/mobile/ws', pinnedHostFingerprint: FP_MINE })],
    ['dsh-mobile.device-key:' + FP_MINE, 'KEY-SCHOOL'],
    ['dsh-mobile.hosts', JSON.stringify([
      { fingerprint: FP_MINE, label: '电脑', slots: [{ label: '学校', url: ORIGIN_SCHOOL + '/mobile/app' }], updatedAt: 1 },
    ])],
  ])
  /** ★ 当前源是夹具那个默认 host ✓（目录里**只有学校那个地址** ⇒ 认不出来 ✓ = 本轮那个病根状态 ✓）。 */
  const surface = bootOnSurface({
    pathname: '/mobile/app',
    innerWidth: 412,
    consent: [],
    shell: makeVaultShell(vault),
  })
  const api = surface.boot.apk
  assert.equal(api.currentFingerprint(), null, '这个源认不出这台电脑（目录里没有它的槽 ✓）')
  assert.equal(api.deviceRejection('mobile/device-unknown', '验收触发'), true, '拒绝那条路应真的跑了 ✓')
  // ★★ 连坐就是这一条：以前会把壳里那四条一起清掉 ✗（另一个地址从此少一条退路 ✓）
  assert.equal(
    vault.get('dsh-mobile.host:' + FP_MINE) !== undefined,
    true,
    '★ 别的地址在壳里的配置不许被清 ✗：' + JSON.stringify(Array.from(vault.keys())),
  )
  assert.equal(vault.get('dsh-mobile.device-key:' + FP_MINE), 'KEY-SCHOOL', '★ 别的地址在壳里的私钥不许被清 ✗')
  // 留痕：清 0 个键 + 为什么跳过 ✓（诊断页读它 ✓）
  const marker = JSON.parse(String(surface.storage.get('dsh-mobile.identityCleared'))) as Record<string, unknown>
  assert.deepEqual(marker['cleared'], [], '这次一个键都没清 ✓')
  assert.match(String(marker['skipped']), /本机没有/, '要写清**为什么跳过** ✓：' + JSON.stringify(marker))
  assert.equal(marker['code'], 'mobile/device-unknown', '拒绝码要留痕 ✓')
})

test('★ R4：真的在这台电脑上配过对（本机持有它的 device-key）⇒ 被拒时照旧清干净', () => {
  const vault = new Map<string, string>([
    // 目录里记着**当前源** ✓ ⇒ 指纹解析得出来 ✓ ⇒ 启动时身份会被恢复进本机 ✓
    ['dsh-mobile.host:' + FP_MINE, JSON.stringify({ baseUrl: 'https://10.34.221.181:3443', tunnelUrl: 'wss://10.34.221.181:3443/mobile/ws', pinnedHostFingerprint: FP_MINE })],
    ['dsh-mobile.device-key:' + FP_MINE, 'KEY-MINE'],
    ['dsh-mobile.claimed-ticket:' + FP_MINE, 'TICKET-MINE'],
    ['dsh-mobile.lastGoodEndpoint:' + FP_MINE, 'wss://10.34.221.181:3443/mobile/ws'],
    ['dsh-mobile.hosts', JSON.stringify([
      { fingerprint: FP_MINE, label: '电脑', slots: [{ label: '学校', url: 'https://10.34.221.181:3443/mobile/app' }], updatedAt: 1 },
    ])],
  ])
  const surface = bootOnSurface({
    pathname: '/mobile/app',
    innerWidth: 412,
    consent: [],
    shell: makeVaultShell(vault),
  })
  const api = surface.boot.apk
  assert.equal(api.currentFingerprint(), FP_MINE, '当前源就是这台电脑 ✓')
  assert.equal(surface.storage.get('dsh-mobile.device-key:' + FP_MINE), 'KEY-MINE', '身份先从壳恢复进本机 ✓')
  assert.equal(api.deviceRejection('mobile/device-revoked', '验收触发'), true, '拒绝那条路应真的跑了 ✓')
  for (const base of ['dsh-mobile.host', 'dsh-mobile.device-key', 'dsh-mobile.claimed-ticket', 'dsh-mobile.lastGoodEndpoint']) {
    assert.equal(vault.has(base + ':' + FP_MINE), false, '真的配过对 ⇒ 照旧清干净 ✓：' + base)
  }
  const marker = JSON.parse(String(surface.storage.get('dsh-mobile.identityCleared'))) as Record<string, unknown>
  assert.ok(Array.isArray(marker['cleared']) && (marker['cleared'] as unknown[]).length > 0, '清理过的键要留痕 ✓')
  assert.equal(marker['skipped'], null, '走的是真清理那条路 ⇒ 没有"跳过"字段 ✓')
})

test('★★ R5：端侧诊断能念出"为什么认不出这台电脑"（指纹 / 恢复读数 / 目录里的地址 / 清理留痕）', () => {
  const vault = new Map<string, string>([
    ['dsh-mobile.host:' + FP_MINE, JSON.stringify({ baseUrl: ORIGIN_SCHOOL, tunnelUrl: 'wss://' + HOST_SCHOOL + '/mobile/ws', pinnedHostFingerprint: FP_MINE })],
    ['dsh-mobile.device-key:' + FP_MINE, 'KEY-SCHOOL'],
    ['dsh-mobile.hosts', JSON.stringify([
      { fingerprint: FP_MINE, label: '学校那台', slots: [{ label: '学校', url: ORIGIN_SCHOOL + '/mobile/app' }], updatedAt: 1 },
    ])],
  ])
  const surface = bootOnSurface({
    pathname: '/mobile/app',
    innerWidth: 412,
    consent: [],
    shell: makeVaultShell(vault),
  })
  const panel = surface.boot.apk.identityDiagnostics()
  // ── ① 读数（生产函数 ✓）
  assert.equal(panel.data.fingerprint, null, '这个源认不出这台电脑 ✓')
  assert.match(panel.data.restore, /跳过/, '恢复那条读数必须**说清跳过了** ✗（以前一个字都没有 ✗）：' + panel.data.restore)
  assert.equal(panel.data.restoreOk, false, '跳过 ≠ 正常 ⇒ 要标出来 ✓')
  assert.match(panel.data.why, /目录记着的地址/, '要逐条说清三条路 ✓：' + panel.data.why)
  assert.ok(
    panel.data.why.includes(ORIGIN_SCHOOL),
    '★ 目录里记着哪些地址要念出来 ✓（这正是判断"换源还认不认得出"的证据 ✓）：' + panel.data.why,
  )
  assert.equal(panel.data.hosts.length, 1, '目录里那一台要列出来 ✓')
  assert.deepEqual(
    Array.from((panel.data.hosts[0]?.['slots'] ?? []) as string[]),
    [ORIGIN_SCHOOL + '/mobile/app'],
    '每台的槽也要念出来 ✓',
  )
  assert.ok(
    panel.data.vaultKeys.includes('dsh-mobile.host:' + FP_MINE),
    '壳里有哪些键名要念出来 ✓（只念键名 ✓）：' + JSON.stringify(panel.data.vaultKeys),
  )
  // ── ② 真渲染产物（生产行渲染函数 ✓ —— 不是"某个字符串存在"✗）
  const text = textOf(panel.group)
  assert.ok(text.includes('端侧诊断'), '行要画在「端侧诊断」这一组里 ✓：' + text)
  assert.ok(text.includes('定不出来'), '第一行要说清"认不出" ✓：' + text)
  assert.ok(text.includes(ORIGIN_SCHOOL), '要把目录记着的地址摆在屏上 ✓：' + text)
  assert.ok(text.includes('学校那台'), '要把宿主的显示名念出来 ✓：' + text)
  assert.ok(text.includes('dsh-mobile.host:' + FP_MINE), '壳里的键名要能念 ✓：' + text)
  // ★★ 屏幕上**绝不许**出现身份值 ✗（这一屏是给人看/念的 ✓）
  assert.equal(text.includes('KEY-SCHOOL'), false, '★ 私钥值绝不许上屏 ✗：' + text)
  // ── ③ 调试框那条"能念的话" ✓（不许静默 ✗）
  assert.match(
    surface.boxText(),
    /认不出这台电脑/,
    '★ 指纹定不下来时调试框必须留一行 ✗（以前这条路上一个字都没有 ✗）：' + surface.boxText(),
  )
})

test('★ R5：清理留痕要有读者 —— 被拒（跳过清理）之后诊断页那行要说得出话', () => {
  const vault = new Map<string, string>([
    ['dsh-mobile.host:' + FP_MINE, JSON.stringify({ baseUrl: ORIGIN_SCHOOL, tunnelUrl: 'wss://' + HOST_SCHOOL + '/mobile/ws', pinnedHostFingerprint: FP_MINE })],
    ['dsh-mobile.hosts', JSON.stringify([
      { fingerprint: FP_MINE, label: '学校那台', slots: [{ label: '学校', url: ORIGIN_SCHOOL + '/mobile/app' }], updatedAt: 1 },
    ])],
  ])
  const surface = bootOnSurface({
    pathname: '/mobile/app',
    innerWidth: 412,
    consent: [],
    shell: makeVaultShell(vault),
  })
  surface.boot.apk.deviceRejection('mobile/device-unknown', '验收触发')
  const panel = surface.boot.apk.identityDiagnostics()
  assert.ok(panel.data.cleared !== null, '★ dsh-mobile.identityCleared 必须真的有读者 ✗（本轮之前它是死键 ✓）')
  assert.match(panel.data.clearedText, /mobile\/device-unknown/, '留痕里要有拒绝码 ✓：' + panel.data.clearedText)
  assert.match(panel.data.clearedText, /跳过了清理/, '留痕里要说清"这次没清任何键" ✓：' + panel.data.clearedText)
  const text = textOf(panel.group)
  assert.ok(text.includes('上次的身份清理'), '诊断页要有一行专门念它 ✓：' + text)
  assert.ok(text.includes('跳过了清理'), '那一行要把原因念出来 ✓：' + text)
})

test('★ 结构性：R5 那组身份读数必须挂在「端侧诊断」那一页上（不是只有验收口能拿到 ✗）', () => {
  /**
   * 为什么用**结构性**判据 ✗：这一句就是"画到用户真能看到的那一页"本身 ✓ ——
   * 而 `fillConnSettings` 依赖真实 DOM 的 `getComputedStyle` ✓（读 CSS 变量那几行 ✓），
   * 在 `node:vm` 的最小假 DOM 里跑不完整 ✓。所以这里断"那一页确实调了它" ✓，
   * 与上面那条版本分叉的结构性判据同一个口径 ✓。
   * ★ 渲染代码仍只有一份 ✓：`appendIdentityDiagnosticsRows` ✓（上面那条用例断的就是它画了什么 ✓）。
   * 怎么把它打红：把 `if (DEBUG_BOX_ON) appendIdentityDiagnosticsRows(diagnostics)` 这一行删掉
   *   ⇒ 立刻红 ✓（用户那一页再也看不到"为什么认不出这台电脑"✓）。
   */
  const lines = bootSource.split('\n')
  const start = lines.findIndex((line) => line.indexOf('  function fillConnSettings(') === 0)
  assert.ok(start > 0, 'boot.js 里应当有 fillConnSettings（「连接与设备」那一页**唯一**的渲染器 ✓）')
  let end = -1
  for (let index = start + 1; index < lines.length; index++) {
    if (lines[index] === '  }') {
      end = index
      break
    }
  }
  assert.ok(end > start, 'fillConnSettings 的结束大括号应当能在第 2 列找到 ✓')
  const inside = lines.slice(start, end + 1).join('\n')
  assert.ok(
    inside.includes('appendIdentityDiagnosticsRows(diagnostics)'),
    '「端侧诊断」那一组必须真的调 appendIdentityDiagnosticsRows ✓',
  )
  assert.ok(
    inside.includes("settingsGroup('端侧诊断')"),
    '而且必须画在「端侧诊断」这一组里 ✓（别的地方用户找不到 ✗）',
  )
})

/**
 * ★★ round 197：文件列表"名字显示不全 ⇒ 认不出后缀"那个反馈的回归守卫。
 *
 * 用户原话："我反馈一个**文件目录**相关的问题，因为我们那个是**窄栏**，然后文件目录会
 * **显示不全文件的名字**，嗯，导致有的我**无法判断它的后缀是什么**。你有没有好的方案？"
 * + "我们现在还会显示一个**文件的大小**，这个感觉**没必要**，你把这个**去掉**的话，
 * 空间可能会更大一点"。
 *
 * ★ 这一组断言打的是**生产函数**（`__DSH_MOBILE_INTERNALS__.fitFileName` ✓），
 *   不是测试里另抄一份的复制品 ✗ —— 判据（"显示的必须以原名那个扩展名结尾"✓）
 *   正是本轮最值钱的一条 ✓。
 *
 * ★ 变异验证（怎么把它打红 ✓）：把 `fitFileName` 里那句
 *   `return fileNameHead(head, room) + '\u2026' + ext`
 *   改成 `return fileNameHead(text, limit - 1) + '\u2026'`（即"直接尾部省略"✗）
 *   ⇒ 本组"必须以扩展名结尾"那几条**恰好**变红 ✓，其余全绿 ✓。
 */
interface FileNameInternals {
  /** ★ round 198：显示层现在要的是**两段**（`head` 允许被压 / `ext` 绝不 ✗）。 */
  /** ★ round 199：第三个参数是 `asFolder` ✓ —— 目录名**不认后缀** ✓（见下面那组断言 ✓）。 */
  fitFileNameParts: (name: unknown, maxUnits?: number, asFolder?: boolean) => { head: string; ext: string }
  fitFileName: (name: unknown, maxUnits?: number) => string
  /** ★ round 199：目录行右端那颗标签的文案 ✓（文件那一侧的文案就是 `ext` ✓）。 */
  dirTagText: (entry: unknown) => string
  fileNameFamily: (name: unknown) => string
  fileFamilyIcon: (family: string) => string
  fileNameExt: (text: string) => string
  fileNameUnits: (text: string) => number
  FILE_NAME_MAX_UNITS: number
}

/** 取一个"第 2 列函数"的整个函数体（与上面 `fillConnSettings` 那条同一个手法 ✓）。 */
function functionBodyAtColumn2(source: string, name: string): string {
  const lines = source.split('\n')
  const start = lines.findIndex((line) => line.indexOf(`  function ${name}(`) === 0)
  assert.ok(start >= 0, `boot.js 里应当有 ${name} ✓`)
  let end = -1
  for (let index = start + 1; index < lines.length; index++) {
    if (lines[index] === '  }') {
      end = index
      break
    }
  }
  assert.ok(end > start, `${name} 的结束大括号应当能在第 2 列找到 ✓`)
  return lines.slice(start, end + 1).join('\n')
}

function fileNameInternals(): FileNameInternals {
  const surface = bootOnSurface({ pathname: '/mobile/app', innerWidth: 412, consent: [] })
  assert.equal(surface.thrown.length, 0, `顶层不应抛错：${String(surface.thrown[0])}`)
  const internals = surface.internals as unknown as FileNameInternals
  assert.equal(typeof internals.fitFileName, 'function', 'boot.js 应装上 fitFileName ✓')
  return internals
}

test('★ 长名字中段省略、**保住扩展名**（用户：认不出后缀 ✗）', () => {
  const internals = fileNameInternals()
  const budget = internals.FILE_NAME_MAX_UNITS
  assert.ok(budget >= 12 && budget <= 40, `名字宽度预算应当是个可用的小数字（实际 ${budget}）`)
  const cases = [
    '一份很长的项目文档最终版.docx',
    '这是我在手机上根本看不全的一份项目计划书最终版.xlsx',
    `${'a'.repeat(60)}.png`,
    '归档备份.tar.gz',
    `${'🐳'.repeat(20)}.md`,
    '.gitignore',
    'README',
    'a.',
    '..',
    '...',
    '',
  ]
  for (const name of cases) {
    for (const limit of [budget, 18, 12, 8]) {
      const shown = internals.fitFileName(name, limit)
      const where = `「${name}」@${limit} ⇒ 「${shown}」`
      assert.equal(typeof shown, 'string', `必须返回字符串，不许 undefined：${where}`)
      assert.ok(!shown.includes('undefined'), `不许把 undefined 显示出来：${where}`)
      const units = internals.fileNameUnits(name)
      const ext = internals.fileNameExt(name)
      if (units <= limit) {
        assert.equal(shown, name, `放得下就必须原样显示（短名字永远是全名 ✓）：${where}`)
        continue
      }
      assert.ok(shown.length < name.length, `截断之后必须比原名短：${where}`)
      if (ext !== '') {
        // ★★ 本轮最值钱的一条：**任何**被截断的行，显示的仍以原名那个扩展名结尾 ✓
        assert.ok(shown.endsWith(ext), `必须以扩展名「${ext}」结尾：${where}`)
        assert.ok(!shown.endsWith('\u2026'), `有扩展名时不许以省略号收尾：${where}`)
      } else {
        // 没有扩展名 ⇒ 退化成**普通尾部省略**（留头 + 省略号 ✓），不许崩、不许空 ✗
        assert.ok(shown.endsWith('\u2026'), `没有扩展名 ⇒ 普通尾部省略：${where}`)
        assert.ok(shown.length > 1, `退化之后也得留下东西：${where}`)
      }
      if (ext === '' || internals.fileNameUnits(ext) + 2 <= limit) {
        assert.ok(
          internals.fileNameUnits(shown) <= limit,
          `显示的宽度不许超出预算（${internals.fileNameUnits(shown)} > ${limit}）：${where}`,
        )
      }
    }
  }
})

test('★ 类型分族按扩展名认（图 / 表 / 码 / 压缩 / 文 / 其它，大小写不敏感）', () => {
  const internals = fileNameInternals()
  assert.equal(internals.fileNameFamily('截图.PNG'), 'image', '大写后缀也要认 ✓')
  assert.equal(internals.fileNameFamily('预算.xlsx'), 'sheet')
  assert.equal(internals.fileNameFamily('脚本.mjs'), 'code')
  assert.equal(internals.fileNameFamily('备份.tar.gz'), 'archive', '看**最后**那个后缀 ✓')
  assert.equal(internals.fileNameFamily('报告.docx'), 'doc')
  assert.equal(internals.fileNameFamily('README'), 'other', '没有后缀 ⇒ 其它 ✓')
  assert.equal(internals.fileNameFamily('神秘.xyz'), 'other', '认不出 ⇒ 其它 ✓')
  assert.equal(internals.fileNameFamily(undefined), 'other', 'undefined 不许崩 ✓')
  assert.equal(internals.fileNameFamily(null), 'other', 'null 不许崩 ✓')
})

test('★ 类型颜色只用主题变量（不许自创配色 ✗）', () => {
  const rules = bootSource.match(/\.dshm-file-icon\[data-family="[a-z]+"\] \{ color: var\(--dsw-alias-[^)]*\); \}/g) ?? []
  assert.ok(rules.length >= 4, `四种以上类型色应当有 CSS 规则（实际 ${rules.length} 条）`)
  for (const rule of rules) {
    assert.match(rule, /var\(--dsw-alias-label-|var\(--dsw-alias-state-/, `类型色必须取自主题变量：${rule}`)
  }
})

test('★ 列表里不再显示文件大小（用户："这个感觉没必要" ✓）', () => {
  assert.ok(
    !bootSource.includes('dshm-file-meta'),
    '大小那一段（`.dshm-file-meta`）应当整个消失，不留半拉子 ✗',
  )
  const body = functionBodyAtColumn2(bootSource, 'entryRow')
  assert.ok(!body.includes('formatSize('), 'entryRow 里不许再算大小 ✗（省下来的宽度全给名字 ✓）')
  assert.ok(body.includes('fitFileNameParts(entry.name'), 'entryRow 必须走 fitFileNameParts ✓')
  assert.ok(body.includes('data-dshm-fs-name'), '完整名字必须留在 data-dshm-fs-name 上 ✓（工具靠它认行 ✓）')
  assert.ok(body.includes('完整名称：'), '长按看全名的入口必须留着 ✓（截断之后它就是兜底 ✓）')
  // 长按那套的四个口一个都不能少 ✓（少一个 = 真机上"按住不动也会被取消"或"看完名字又进了目录"✗）
  for (const type of ['pointerdown', 'pointerup', 'pointercancel', 'pointermove']) {
    assert.ok(body.includes(`'${type}'`), `长按必须监听 ${type} ✓`)
  }
  // 交叉确认：`formatSize` 这个函数本身**不能**删 —— 预览那几处还在用 ✓
  assert.ok(bootSource.includes('function formatSize('), 'formatSize 仍要被预览那几处用着 ✓')
})

/**
 * ★★ round 198：用户又追了两条反馈，都在"窄栏文件列表"上 ✓：
 *   · "文件列表首先有的没有中间省略 ✗，最后导致没有保住扩展名 ✗"；
 *   · "Markdown 和 PDF 还是分不开 ✗，我觉得 PDF 还是有必要单独分出来一类的 ✓，这个最好是红色 ✓"。
 *
 * ## ① 为什么上一单"保住后缀"没兜住（这条是本轮最值钱的 ✓）
 *   上一单只把后缀塞进 `fitFileName` 的**返回字符串**里 ✓，而那一整串落到 DOM 上是
 *   **同一个**文本节点 ✗，它的容器 `.dshm-file-name` 上又挂着 `text-overflow: ellipsis` ✗
 *   ⇒ 只要真实渲染比预算宽一点，CSS 就从**尾部**补一刀 ✗，中间那个省略号和后半截后缀一起没 ✗
 *   （用户看到的正是"有的没有中间省略"✓）。预算为什么会偏小 ✓：
 *     · 它按"一个半角单位 ≈ 7px"估 ✗ —— 实测 SF Pro 14px 下 22 个数字 = **187px** ✓；
 *     · 它漏算了 `#dsh-mobile-sheet-body` 的 `padding: 10px 10px` ✓（= 20px ✓）；
 *     · `min(64vw, 264px)` 在 375px 视口上只有 **240px** ✓（264 只是上限 ✓）。
 *
 * ⇒ 这一轮把后缀做成**独立元素** ✓（`[data-dshm-fs-ext]` ✓，CSS `flex: 0 0 auto` ✓）：
 *   它**在结构上不参与收缩** ✓ ⇒ 中段省略由 JS 算 ✓、尾部由结构保证 ✓，两条各管一段 ✓。
 *   ★ 顺带把容器自己那条 `overflow: hidden` 也摘了 ✗：留着它等于给容器右边缘留了一把剪刀 ✓，
 *     而那正好落在外层缩不动、内层又剪得动的缝里 ✓（详见 boot.js 里那段注释 ✓）。
 *
 * ★ 变异验证（各做一次 ⇒ **恰好**变红 ✓，做完改回 ✓）：
 *   · 把后缀那个元素改回"和头部同一个可收缩元素"✗（`nameHead.textContent = shownName.head + shownName.ext`
 *     并删掉 `data-dshm-fs-ext` 那一段 ✓）⇒ 下面"结构上剪不掉"那组红 ✓；
 *   · 把 `.pdf` 塞回 `doc` 族 ✗ ⇒ 下面"PDF 单独一族"那组红 ✓。
 */
test('★★ 扩展名在**结构上**剪不掉（独立元素 + 不许收缩）——治"有的行没保住后缀"✗', () => {
  const body = functionBodyAtColumn2(bootSource, 'entryRow')
  // ① 后缀必须挂在**自己的**元素上 ✓（不许跟头部混在同一个可收缩元素里 ✗）
  assert.ok(body.includes('data-dshm-fs-ext'), 'entryRow 必须给后缀单独挂一个元素 ✓（data-dshm-fs-ext ✓）')
  assert.ok(body.includes('data-dshm-fs-head'), '头部那个元素也要有记号 ✓（data-dshm-fs-head ✓）')
  assert.match(
    body,
    /nameExt\.textContent = shownName\.ext/,
    '后缀元素里放的必须正好是 `ext` 那一段 ✓（不许把 head + ext 塞回同一个元素 ✗）',
  )
  assert.ok(
    !/nameHead\.textContent = [^\n]*\+/.test(body),
    '头部元素里**不许**再拼后缀 ✗（那样它就退化回上一版那个"一个可收缩元素"✗）',
  )
  // ② CSS：后缀那一条必须**不收缩** ✓；允许被裁的只能是头部那一条 ✓
  const extRule = (/\.dshm-file-name > \[data-dshm-fs-ext\] \{([^}]*)\}/.exec(bootSource) ?? [])[1] ?? ''
  assert.ok(extRule !== '', 'CSS 里必须有 [data-dshm-fs-ext] 那条规则 ✓')
  assert.match(extRule, /flex:\s*0\s+0\s+auto/, `后缀必须 flex: 0 0 auto（结构上不参与收缩 ✓）：${extRule}`)
  assert.match(extRule, /white-space:\s*nowrap/, `后缀必须 nowrap ✓：${extRule}`)
  assert.ok(!/flex:\s*\d+\s+1\b/.test(extRule), `后缀**不许**允许收缩 ✗：${extRule}`)
  const headRule = (/\.dshm-file-name > \[data-dshm-fs-head\] \{([^}]*)\}/.exec(bootSource) ?? [])[1] ?? ''
  assert.ok(headRule !== '', 'CSS 里必须有 [data-dshm-fs-head] 那条规则 ✓')
  assert.match(headRule, /overflow:\s*hidden/, '头部才是允许被裁的那一段 ✓')
  assert.match(headRule, /min-width:\s*0/, '头部要能收缩就必须 min-width: 0 ✓')
  // ③ 名字那一栏自己**不许**再挂尾部省略 / 裁剪：那正是上一版剪掉后缀的那把刀 ✗
  const boxRule = (/\.dshm-file-name \{([^}]*)\}/.exec(bootSource) ?? [])[1] ?? ''
  assert.ok(boxRule !== '', 'CSS 里必须有 .dshm-file-name 那条规则 ✓')
  assert.ok(!/text-overflow/.test(boxRule), `这一栏自己不许挂 text-overflow ✗（那就是剪后缀的刀 ✓）：${boxRule}`)
  assert.ok(!/overflow:\s*hidden/.test(boxRule), `这一栏自己也不许 overflow: hidden ✗（等于换一把刀 ✓）：${boxRule}`)
  /**
   * ④ 纯函数这一段与显示层那一段必须**逐字对得上** ✓ ——
   *    否则"结构上剪不掉"就只是文字游戏 ✓（挂错了元素照样白搭 ✗）。
   */
  const internals = fileNameInternals()
  const cases = [
    '一份很长的项目文档最终版.docx',
    'IMG_20240930_183045_副本.pdf',
    `${'a'.repeat(60)}.png`,
    '归档备份.tar.gz',
    '工作记录.md',
    'README',
    '.gitignore',
  ]
  for (const name of cases) {
    for (const limit of [22, 18, 12, 8]) {
      const parts = internals.fitFileNameParts(name, limit)
      const shown = internals.fitFileName(name, limit)
      const where = `「${name}」@${limit}`
      assert.equal(parts.head + parts.ext, shown, `两段接起来必须正好是显示串 ✓：${where}`)
      // ★ 认出来的后缀**永远**只在 `ext` 那一段里 ⇒ 它永远落在那颗不可收缩的元素上 ✓
      assert.equal(parts.ext, internals.fileNameExt(name), `ext 必须就是认出来的后缀 ✓：${where}`)
      if (parts.ext !== '') {
        assert.ok(shown.endsWith(parts.ext), `显示必须以那一段后缀收尾 ✓：${where} ⇒ 「${shown}」`)
      }
    }
  }
})

test('★ PDF 单独一族 + 红色取自主题变量；Markdown 不与它同族（用户原话 ✓）', () => {
  const internals = fileNameInternals()
  const pdf = internals.fileNameFamily('报告.pdf')
  assert.equal(pdf, 'pdf', 'PDF 必须自己一族 ✓（"PDF 还是有必要单独分出来一类"✓）')
  assert.equal(internals.fileNameFamily('扫描件.PDF'), 'pdf', '大写后缀也要认 ✓')
  const md = internals.fileNameFamily('说明.md')
  assert.notEqual(md, pdf, 'Markdown 不许和 PDF 混在一族 ✗（"还是分不开"✗）')
  assert.equal(md, 'code', 'Markdown 归到"码"族（本轮的取舍 ✓，理由见 boot.js 里那张表 ✓）')
  assert.equal(internals.fileNameFamily('笔记.markdown'), 'code')
  assert.equal(internals.fileNameFamily('报告.docx'), 'doc', 'doc 族剩下的一堆不许被带跑 ✗')
  // ★ 表族（Excel ✓）用户明确满意 ⇒ 一个字都不许动 ✗
  assert.equal(internals.fileNameFamily('预算.xlsx'), 'sheet', '表族必须原样 ✓')
  assert.equal(internals.fileNameFamily('导出.csv'), 'sheet')
  // ★ 图标与颜色一一对应：PDF 那颗必须与**其它每一族**都不一样 ✓
  const pdfIcon = internals.fileFamilyIcon('pdf')
  for (const family of ['image', 'sheet', 'code', 'archive', 'doc', 'other']) {
    assert.notEqual(pdfIcon, internals.fileFamilyIcon(family), `PDF 的图标不许和 ${family} 撞 ✗`)
  }
  // ★ 颜色：必须是主题变量 ✓，而且必须是那颗**语义红** ✓（不许写死 hex ✗）
  const rule = (/\.dshm-file-icon\[data-family="pdf"\] \{[^}]*\}/.exec(bootSource) ?? [])[0] ?? ''
  assert.ok(rule !== '', 'CSS 里必须有 pdf 那一族的颜色规则 ✓')
  const color = ((/color:\s*([^;]+);/.exec(rule) ?? [])[1] ?? '').trim()
  assert.ok(color.startsWith('var(--dsw-alias-'), `类型色必须取自主题变量 ✓（实际 ${color}）`)
  assert.match(
    color,
    /var\(--dsw-alias-state-error-primary,/,
    `PDF 必须用主题里那颗语义红 ✓（实际 ${color}）`,
  )
})

/**
 * ★★ round 199：文件列表"右侧那个位置"改成一个**类型标签** ✓。
 *
 * 用户原话（照抄 ✓）：
 *   · "**文件列表没问题** ✓，就是**有点丑** ✗。我记得之前我们**文件夹会标注出类型** ✓，
 *     然后**文件会标注出大小** ✓。或许把**文件的大小直接替换为文件名后缀**就好了 ✓。呃，
 *     但是我的意思是，**只有名字这一块可能需要改一改** ✓，★ **你的图标改的很好** ✓。"
 *
 * ⇒ 三条落到代码上：
 *   ① 文件行右端吃**后缀** ✓（位置 = 上一单删掉的「大小 / 目录」那一段 ✓）；
 *   ② 目录行右端吃「**目录**」✓（上一单被删掉的那条**回来** ✓；★ 文案由 2026-10-05 那次改动定稿 ✓）；
 *   ③ 名字那一段**只显示 head** ✓ ⇒ 后缀在整行里**只出现一次** ✓（"避免重复显示"✓）。
 *
 * ## ★★ 2026-10-05 这一轮的两处改动（用户原话照抄 ✓）
 *   · "文件列表里**文件夹改成目录** ✓" ⇒ `dirTagText` 的返回值 `'文件夹'` ⇒ `'目录'` ✓
 *     （上面那段 199 的原话里那个词是**历史** ✓ —— 口径以这一条为准 ✓）；
 *   · "**后缀名不要大写** ✓" ⇒ 屏上原来是 `.PDF` / `.DOCX` ✗。★ **是谁把它变大的**：那条标签 CSS 里的
 *     `text-transform: uppercase` ✗（**不是** JS ✓ —— `entryRow` / `fitFileNameParts` / `dirTagText`
 *     里从来没有 `toUpperCase` ✓，后缀一直是按文件名原样存着的 ✓）⇒ **把那一句删掉** ✓，
 *     屏上回到 `.pdf` / `.docx` / `.md` ✓（既不 upper ✗ 也不 lower ✗）。
 *   ★ 图标 / 颜色**一个字没动** ✓（用户：「图标改的很好」✓）；上限 64px 那个数也**没动** ✓（见下面几何那段 ✓）。
 *
 * ## ★ 这一轮新加的判据：**六条独立 test**（都写在**本 test 之后** ✓ —— 见文件末尾 ✓）
 *   为什么拆出去 ✗：node:test 里一条 test 到**第一个**失败的断言就停 ✓ —— 判据挤在一起时，
 *   变异只能让「最前面那条」报红 ✗，后面那几条**根本没跑到** ✗ ⇒ 「恰好变红」就没法说清 ✓。
 *   本组里只留一句 `equal(...) === '目录'`（就地判据 ✓），其余六条各自独立 ✓：
 *     · Ⅰ. `★ 目录标签负例（一）`：`dirTagText` 的**函数体**里不许再出现旧文案 ✗；
 *     · Ⅱ. `★ 目录标签负例（二）`：`entryRow` 里不许把旧文案当**字符串**用 ✗
 *       （★ 要求那个词**带引号** ✓ ⇒ 注释里提到它不会误报 ✓；也不许变成「只匹配注释里的字符串」✗）；
 *     · Ⅲ. `★ 后缀原样（一）`：标签**那条 CSS 规则**里不许有任何 `text-transform` ✗；
 *     · Ⅳ. `★ 后缀原样（二）`：**任何一行 CSS 字符串**里都不许有 `text-transform` ✗
 *       （★ `text-transform` 是**继承**属性 ✓ ⇒ 挂到父规则上照样能顶到标签 ✗，这条专治那种 ✓）；
 *     · Ⅴ. `★ 后缀原样（三）`：JS 生产路径里不许有 `toUpperCase` ✗ / 内联样式 `textTransform` ✗；
 *     · Ⅵ. `★ 后缀原样（四）`：**值**逐字原样 ✓（小写不被顶上去 ✗、大写也不被压下来 ✗）——
 *       ★ 只查「那行 CSS 还在不在」是**软判据** ✗；打在**值**上这一条才硬 ✓。
 *
 * ## ★ 两条"保证"的转移（这一轮最要紧的一处，必须写清楚 ✓）
 *   · 上一单的保证是"**后缀在结构上剪不掉**" ✓ —— 它打在三处：`entryRow` 里后缀有**自己的**
 *     元素（`data-dshm-fs-ext` ✓）、`nameExt.textContent = shownName.ext` ✓、
 *     CSS `.dshm-file-name > [data-dshm-fs-ext] { flex: 0 0 auto; white-space: nowrap; }` ✓。
 *     这一轮**这三处一个字都没动** ✓（下面 round 198 那组断言继续绿 ✓，见本文件上面那一组 ✓）
 *     ⇒ 后缀仍然挂在**不参与收缩**的元素上 ✓。
 *   · 新增的保证是"**后缀看得见**"这条**意图**现在由**右端标签**兑现 ✓：
 *     同一颗元素被 `margin-left: auto` 推到名字栏最右 ✓，而**名字**那一截是唯一会被压的 ✓
 *     （`[data-dshm-fs-head]` 独占 `overflow: hidden` ✓）。名字再长，被剪的也只是名字 ✓。
 *   ★ 换句话说：剪不掉这条**没有改名换姓** ✓ —— 它换的是"被剪的是谁"这个答案里的**名字**那一侧 ✓。
 *
 * ## ★ 几何：拿**真布局引擎**量过（不是估算 ✓、也不是审美判断 ✗）
 *   做法：从 `boot.js` 里**原样抽出**那几条 `.dshm-file*` CSS ✓（不手抄 ✗），拼出一个真 `entryRow` 形状的
 *   行（图标盒 22px 由 CSS 定 ✓），在无头 Chrome 里按 320 / 375 / 412px 三种视口各量一遍
 *   （行宽 = `min(64vw, 264px) - 20`，即 184.8 / 220 / 243.7px ✓）。实测（macOS system-ui ✓）：
 *     · 标签**右边缘三档各自恒定**（139.8 / 175 / 198.7px ✓）、距 `⋯` 恒为 **11px** ✓
 *       ⇒ 右边这一列是对齐的 ✓（不是每行飘 ✓）；
 *     · ★ 2026-10-05 去掉 `uppercase` 之后**在同一台机器上重测过**（同一套"从 boot.js 原样抽 CSS"+
 *       真布局引擎 ✓，320 / 375 / 412px 三档数值一致 ✓；下列数都**含**标签左边那 8px 内边距 ✓）：
 *       `.pdf` 27.2 / `.docx` 35.5 / `.png` 30.4 / `.gz` 23.3 / `.md` 27.2 / `.numbers` 55.9 /
 *       `.markdown` 64.3（★ 改前那版 `.MARKDOWN` = 72 且 `scrollWidth` = 81 ⇒ **真被自己剪了一刀** ✗）/
 *       两字标签 31.0 —— **一个都没被自己那颗上限剪到** ✓（`scrollWidth <= clientWidth` ✓）；
 *       ★ 结论：**去大写只会让同一串字更窄** ✓（实测这几串全变窄 ✓）⇒ 上限 64px 那条结论**不变** ✓
 *       —— 所以下面那条上限断言**只换说明文字，数一个字没动** ✓（只许加、不许松 ✗）；
 *     · 被剪的**只有名字那一段** ✓（长名字 `headClipped=true` ✓，标签 `tagClipped=false` ✓）——
 *       这正是本组要保的那条 ✓；320px 下最坏一档（`.numbers`）名字还剩 36.1px ✓
 *       （★ 这一条与上面「右边缘对齐 / 距 ⋯ 11px」是**上一版**量的 ✓ —— 本轮**没有**重量行宽 ✗：
 *       我这次只量了标签自己的宽度 ✓，而行宽那一栏要另拼容器 ✓；标签变窄只会让名字**更多** ✓
 *       所以这两条更宽松的结论没有被本轮改动推翻 ✓）；
 *     · **没有后缀**的行（`README`）根本没有标签节点 ✓（留白 ✓，不是空标签 ✓）。
 *   ★ 上限为什么是 **64px**（而不是 62 或 72）：那是**大写那一版**量的 ✓ ——
 *     `.NUMBERS` 实测 60.0px ⇒ 64 留了 4px 余量 ✓；先写 62px + `letter-spacing: .02em` 时它
 *     **真被剪了** ✗ ⇒ 去掉字距、上限提到 64 ✓；再往上（≥73px）就轮到 320px 下的名字被挤 ✗。
 *     ★ 去掉大写之后**同一套量法**重测：`.numbers` 只剩 55.9px ✓、最长的 `.markdown` 也只有 64.3px
 *     ⇒ **一个都没被剪** ✓（大写那版 `.markdown` 是 72/`scrollWidth` 81 ⇒ 真被剪 ✗）——
 *     上限这个数**不用动** ✓（理由写进了 `boot.js` 那条 CSS 的注释 ✓）。
 *   ★ 字体差异：★ 本轮重测用的是无头 Chrome 的**默认无衬线**（`getComputedStyle` 报 Arial ✓）——
 *     它与上一版量出的大写数字**逐个吻合**（34.2 / 44.4 / 68.7 ✓）⇒ 至少是**同一把尺子** ✓；
 *     安卓 WebView 是 Roboto ✓ ⇒ 那 4px 余量就是给它的 ✓。
 *
 * ## ★ 变异验证（各做一次 ⇒ **恰好**新增那几条变红 ✓，做完改回 ✓）
 *   · ① 把右端标签整个去掉 ✗（删掉 `entryRow` 里 `data-dshm-fs-ext` 那一段 ✓）⇒
 *     本组 ①②③ 与 round 198 那组一起红 ✓；
 *   · ② 把文件大小加回来 ✗（`entryRow` 里再建一个 `formatSize(entry.size)` ✓）⇒
 *     下面"不再显示大小"那条负例红 ✓；
 *   · ③ 把目录的 `asFolder` 丢掉 ✗（调用改成两参 ✓）⇒ 下面 `v1.2` 那条"目录不许被拆出假后缀"红 ✓；
 *   · ④ 把 `.dshm-file-tag` 的 `margin-left: auto` 去掉 ✗ ⇒ "标签靠右"那条红 ✓。
 *   ★ 四条都实跑过 ✓：①②③④ 每次都是**恰好**那几条红、其余全绿 ✓（还原后 sha256 回到原值 ✓）。
 *
 * ## ★★ 2026-10-05 追加的变异（实跑四次 ✓，每次都**恰好**只多红该红的那几条 ⇒ 改回 ✓）
 *   （下面提到的「红」都**不含**那条既有的 notify 死代码红 ✓ —— 它在本轮的每一次跑里都红 ✓，
 *    与这两处改动无关 ✓：临时换回 HEAD 版 `boot.js` 单独跑它，**照样红** ✓，已核 ✓。）
 *   · ⑤ `dirTagText` 里 `'目录'` 改回旧词 ✗ ⇒ **恰好 2 条**红：本组那句 `equal` ✓ +
 *     `目录标签负例（一）` ✓（★ `负例（二）`**不红** ✓ —— 它盯的是 `entryRow` 里的字符串字面量，
 *     ⑤ 没碰那里 ✓；这两条负例各管一处、都留着 ✓）；
 *   · ⑥a 标签那条 CSS 里加回 `text-transform: uppercase` ✗ ⇒ **恰好 2 条**红：
 *     `后缀原样（一）` + `后缀原样（二）` ✓（值那条**不红** ✓ ⇒ "CSS 判据"与"值判据"各自独立 ✓）；
 *   · ⑥a' 把 `text-transform: uppercase` 挂到**父规则** `.dshm-file-name` 上 ✗（靠继承生效 ✓）
 *     ⇒ **恰好 1 条**红：`后缀原样（二）` ✓ —— ★ 这一条正是（二）非有不可的理由 ✓
 *     （只盯标签那条规则的（一）**对父规则完全无感** ✗）；
 *   · ⑥b `entryRow` 里把后缀 `.toUpperCase()` 一下 ✗（`nameExt.textContent = shownName.ext.toUpperCase()` ✓）
 *     ⇒ **恰好 1 条**红：`后缀原样（三）` ✓（★ 值那条**不红** ✓ —— 纯函数没被碰 ✓）；
 *   · ⑥c `fitFileNameParts` 里把后缀顺手 `.toLowerCase()` ✗ ⇒ **恰好 1 条**红：`后缀原样（四）` ✓
 *     —— ★ 反过来证明「值」那条也**不是**多余的 ✓（⑥b 打不红它、它专治「值被改」✓）。
 */
test('★★ 右端标签：文件行吃原样后缀、目录行有「目录」、名字里不再重复后缀', () => {
  const body = functionBodyAtColumn2(bootSource, 'entryRow')
  const internals = fileNameInternals()

  // ① 文件那一侧：标签元素存在、吃的**正好**是后缀那一段，而且真的挂上了标签样式 ✓
  //    （只查 CSS 不查"有没有挂上这个类"，就是最常见的那种假断言 ✗）
  assert.ok(body.includes('data-dshm-fs-ext'), '文件行必须有一颗后缀标签 ✓（data-dshm-fs-ext ✓）')
  assert.match(
    body,
    /nameExt\.className = 'dshm-file-tag'/,
    '后缀那颗元素必须挂上 `.dshm-file-tag` 样式 ✓（不挂的话 CSS 那几条全是空转 ✗）',
  )
  assert.match(
    body,
    /nameExt\.textContent = shownName\.ext\b/,
    '标签里放的必须正好是 `ext` 那一段 ✓（后缀 ✓，不是整串名字 ✗）',
  )

  // ② 目录那一侧：文案来自**生产函数** `dirTagText` ✓ + 结构上真有那颗标签 ✓（两处合起来才成立 ✓）
  assert.match(body, /dirTag\.className = 'dshm-file-tag'/, '「目录」那颗也要挂同一个类 ✓')
  assert.match(
    body,
    /dirTag\.textContent = dirTagText\(entry\)/,
    '「目录」必须由 `dirTagText` 这个生产函数给 ✓（在测试里另抄一份就是假断言 ✗）',
  )
  assert.ok(body.includes('data-dshm-fs-tag'), '目录标签要有自己的记号 ✓（data-dshm-fs-tag ✓）')
  assert.equal(internals.dirTagText({ type: 'directory' }), '目录', '目录 ⇒ 「目录」✓（用户原话：把这个词改成「目录」✓ —— 原话见上面照抄那段 ✓）')
  assert.equal(internals.dirTagText({ type: 'file' }), '', '文件 ⇒ 空串 ✓（文件那条走 ext ✓，不许在这里也吐一个 ✗）')
  assert.equal(internals.dirTagText(undefined), '', 'undefined 不许崩 ✓')
  assert.equal(internals.dirTagText(null), '', 'null 不许崩 ✓')

  // ②b / ②c 那几条（旧文案的负例、后缀原样）搬成了**独立 test** ✓ —— 见本文件末尾那五条 ✓
  // ③ 名字里不再重复后缀 ✓ —— 整段 `entryRow` 里后缀只被写进**一个**元素 ✓（写两次 = 重复显示 ✗）
  const extWrites = body.match(/textContent = shownName\.ext\b/g) ?? []
  assert.equal(
    extWrites.length,
    1,
    `后缀在整行里只许出现**一次**（重复显示 ✗，实际被写 ${extWrites.length} 次）`,
  )
  assert.ok(
    !/nameHead\.textContent = [^\n]*\+/.test(body),
    '名字那一截**不许**再拼后缀 ✗（那就退回到"后缀跟着名字走"✗）',
  )
  assert.match(body, /nameHead\.textContent = shownName\.head\b/, '名字那一截只放 `head` ✓')

  // ③b 目录名不许被拆出**假后缀** ✗，而且 `entryRow` 必须真把 `isDir` 递进去 ✓（否则下面纯函数那条就是空转 ✗）
  assert.match(
    body,
    /fitFileNameParts\(entry\.name, FILE_NAME_MAX_UNITS, isDir\)/,
    '`entryRow` 必须把 `isDir` 传给 `fitFileNameParts` ✓（不传 ⇒ `v1.2` 这种目录会被拆出 `.2` ✗）',
  )
  // ★ 用两条 `equal` 而不是 `deepEqual` ✗：boot.js 跑在**另一个 realm** 里 ✓，
  //   它返回的对象原型与测试侧不是同一个 ⇒ 深比较会因原型不同而假红 ✓。
  const folderParts = internals.fitFileNameParts('v1.2', 22, true)
  assert.equal(folderParts.head, 'v1.2', '目录名要**原样**留着 ✓（不许被拆短 ✗）')
  assert.equal(folderParts.ext, '', '目录名不认后缀 ✓')
  assert.equal(internals.fitFileNameParts('v1.2', 22).ext, '.2', '文件那一侧照旧认后缀 ✓（这条证明上一条不是恒真 ✓）')
  assert.equal(internals.fitFileNameParts('.gitignore', 22, true).ext, '', '目录名也不认隐藏文件那种点开头 ✓')
  const longFolder = internals.fitFileNameParts('一个很长的目录名字最终版', 8, true)
  assert.equal(longFolder.ext, '', '目录永远不吐后缀 ✓')
  assert.ok(longFolder.head.endsWith('\u2026'), '长目录名退化成尾部省略（留头 ✓）')

  // ④ 标签的样式：**靠右 + 淡 + 有宽度上限** —— 三条缺一，下面每一条都能被变异打红 ✓
  const tagRule = (/\.dshm-file-name > \.dshm-file-tag \{([^}]*)\}/.exec(bootSource) ?? [])[1] ?? ''
  assert.ok(tagRule !== '', 'CSS 里必须有 `.dshm-file-name > .dshm-file-tag` 那条规则 ✓')
  assert.match(
    tagRule,
    /margin-left:\s*auto/,
    '标签必须被推到名字栏**最右** ✓（那里原来写的是文件大小 ✓）',
  )
  assert.match(
    tagRule,
    /color:\s*var\(--dsw-alias-label-tertiary/,
    '淡 = 主题里那颗**次要文字**色 ✓（不许自创颜色 ✗）',
  )
  assert.match(tagRule, /max-width:\s*\d+(?:\.\d+)?px/, '标签必须有**宽度上限** ✓（否则窄栏里把名字挤没 ✗）')
  const cap = Number((/max-width:\s*(\d+(?:\.\d+)?)px/.exec(tagRule) ?? [])[1] ?? '0')
  // ★ 下界 35 / 上界 72：与 2026-10-05 之前**逐字相同** ✓（只许加、不许松 ✗）——
  //   本轮两个变化（去掉 `uppercase` ✗、文案变两字「目录」✓）都只会让标签**更窄** ✓
  //   （真布局实测：`.pdf` 27.2 / `.docx` 35.5 / `.numbers` 55.9 / `.markdown` 64.3 ✓，
  //   改前那版 `.markdown` 是 72 且 `scrollWidth` 81 ⇒ 真被剪 ✗）⇒ 64px 这个上限的结论**继续成立** ✓
  //   所以这里**只换了说明文字，两个数一个字没动** ✓。
  assert.ok(
    cap >= 35 && cap <= 72,
    `上限要放得下常见后缀（实测 \`.docx\` = 35.5px ✓）又要在 320px 下给名字留出大半（实测上限 ${cap}px ✓）`,
  )
  assert.ok(!/flex:\s*\d+\s+1\b/.test(tagRule), `标签**不许**允许收缩 ✗（收缩就是被剪 ✓）：${tagRule}`)

  // ⑤ 没有后缀的文件**不留空标签** ✓（留白 ✓ —— 用户点名的是"替换"，不是"多一颗空的"✗）
  assert.match(
    body,
    /if \(isDir\) \{[\s\S]*?\} else if \(shownName\.ext !== ''\) \{[\s\S]*?nameExt/,
    '文件那条标签必须只在 `ext !== \'\'` 时才建 ✓（没后缀 ⇒ 留白 ✓）',
  )

  // ⑥ 负例（沿用上一单那条 ✓）：列表里不许再出现文件大小 ✗
  assert.ok(!body.includes('formatSize('), '右端标签装的是**类型/后缀**，不是大小 ✗')
  assert.ok(!bootSource.includes('dshm-file-meta'), '大小那一段仍然整个不存在 ✓')
  // ⑦ 图标：用户点名"你的图标改的很好"✓ ⇒ 这一轮**一行都没动** ✓（唯一证据是 git diff 里那片区域零增删 ✓）。
  //    这里再补一条**不软**的判据 ✓：五颗专用族图标**两两不同** ✓，且都与其它那颗不同 ✓ ——
  //    这正是"图 / 表 / PDF / 码 / 压缩在窄栏里一眼分得开"那条 ✓（把任意两族并成一颗 ⇒ 红 ✓）。
  const special = ['image', 'sheet', 'pdf', 'code', 'archive']
  const icons = special.map((family) => internals.fileFamilyIcon(family))
  assert.equal(
    new Set(icons).size,
    special.length,
    `五颗专用族图标必须两两不同 ✓（实际只有 ${new Set(icons).size} 颗不同 ⇒ 有两族撞在一起了 ✗）`,
  )
  for (const family of special) {
    assert.ok(
      internals.fileFamilyIcon(family) !== internals.fileFamilyIcon('other'),
      `${family} 族的图标必须仍然与"其它"那颗不同 ✓（用户：图标改的很好 ✓）`,
    )
  }
  // 而且族名这条映射也没被顺手动过 ✓（图标分族的入口就在这儿 ✓）
  assert.equal(internals.fileNameFamily('截图.png'), 'image')
  assert.equal(internals.fileNameFamily('预算.xlsx'), 'sheet')
  assert.equal(internals.fileNameFamily('报告.pdf'), 'pdf')
  assert.equal(internals.fileNameFamily('脚本.mjs'), 'code')
  assert.equal(internals.fileNameFamily('备份.zip'), 'archive')
})


/**
 * ★★ 2026-10-05（用户原话：把那个词改成「**目录**」✓ —— 照抄见上面那组的大注释 ✓）—— 目录标签文案的**负例**，两条。
 *
 * 为什么要**独立 test** ✗：node:test 里一条 test 到**第一个**失败的断言就停 ✓ ——
 *   几条判据塞在同一个 test 里，变异时只能看见最前面那条红 ✗，后面那几条**根本没跑到** ✗
 *   ⇒ 「恰好变红」这句话就没法说清楚 ✓。拆开之后每条判据各自独立报红 ✓，
 *   上面那组（round 199 的 ①②③④⑤⑥⑦）也**照旧全绿** ✓。
 *
 * ★ 负例打在**生产源码**上，不是打在测试自己抄的一份复制品上 ✗：
 *   `functionBodyAtColumn2` 只切**函数体** ✓ ⇒ `dirTagText` 上面那段 JSDoc 里「照抄原话」的
 *   那个旧词**不在**范围内 ✓ —— 那段是**故意**留的历史 ✓（用户 199 那轮嘴里就是那么说的 ✓）。
 *
 * 变异验证（实跑 ✓）：把 `dirTagText` 里的 `'目录'` 改回旧词 ✗ ⇒
 *   ① 上面那组的 `equal` 红 ✓、② 本 test 红 ✓、③ 下面那条 `entryRow` 负例红 ✓ —— 其余全绿 ✓。
 */
test('★★ 目录标签负例（一）：dirTagText 的函数体里不许再出现旧文案 ✗', () => {
  const dirTagBody = functionBodyAtColumn2(bootSource, 'dirTagText')
  assert.ok(
    !dirTagBody.includes('文件夹'),
    `dirTagText 的函数体里不许再出现旧文案 ✗（用户已改口径 ✓，实际：${dirTagBody.replace(/\n/g, ' / ')}）`,
  )
})

/**
 * ★★ 目录标签负例（二）：`entryRow` 里不许把那个旧词当**字符串**用 ✗。
 *
 * ★ 判据要求那个词**带引号** ✓（`'…'` / `"…"`）—— 两条好处：
 *   · 注释里用「」提到它**不会**误报 ✓（这一轮我写了不少说明 ✓）；
 *   · ★ 反过来也不会变成「只匹配注释里的字符串」那种**假判据** ✗（要我匹配的那东西，
 *     必须真的能被 `entryRow` 当字符串写出来 ✓，光写在注释里不算 ✓）。
 *
 * 变异验证（实跑 ✓）：同（一）那个变异 ⇒ 本 test 红 ✓。
 */
test('★★ 目录标签负例（二）：entryRow 里不许把旧文案当字符串用 ✗', () => {
  const body = functionBodyAtColumn2(bootSource, 'entryRow')
  const quoted = /['"]文件夹['"]/.exec(body)
  assert.equal(
    quoted,
    null,
    `entryRow 里不许把那个旧词当**字符串**用 ✗（目录标签必须走 dirTagText ✓，实际命中：${quoted === null ? '（无）' : quoted[0]}）`,
  )
})

/**
 * ★★ 2026-10-05（用户原话：「**后缀名不要大写** ✓」）—— 后缀**原样**的四条判据。
 *
 * ★ 先回答"**是谁把它变成大写的**"✗：是那条标签 CSS 里的 `text-transform: uppercase` ✓ ——
 *   **不是** JS ✓（`entryRow` / `fitFileNameParts` / `dirTagText` 里从来没有 `toUpperCase` ✓，
 *   后缀一直按文件名原样存着 ✓）⇒ 这一轮**删掉那一句** ✓，屏上回到 `.pdf` / `.docx` / `.md` ✓。
 *
 * ★ 为什么「屏上会不会变大写」要拆成四条 ✗：能把它顶成大写的路**不止一条** ✓ ——
 *   · ① 标签**那条规则**自己的 `text-transform` ✗；
 *   · ② 任何一条 CSS 字符串里的 `text-transform` ✗（`text-transform` 是**继承**属性 ✓ ⇒
 *     挂到父规则（`.dshm-file-name` / `.dshm-file-head` ✓）上照样能顶到标签 ✓）；
 *   · ③ JS 生产路径里的 `.toUpperCase()` ✗ / 内联样式 `el.style.textTransform` ✗；
 *   · ④ 值本身（**纯函数**）—— ★ 前面三条只说明「没写那句话」 ✗，这一条才说明「屏上会是什么」 ✓。
 *   三条「形状」判据 + 一条「值」判据，缺一条都会漏一种写法 ✗。
 */
test('★★ 后缀原样（一）：标签那条 CSS 规则里不许有任何 text-transform ✗', () => {
  const rule = (/\.dshm-file-name > \.dshm-file-tag \{([^}]*)\}/.exec(bootSource) ?? [])[1] ?? ''
  assert.ok(rule !== '', 'CSS 里必须有 `.dshm-file-name > .dshm-file-tag` 那条规则 ✓')
  const decl = /text-transform[^;]*/.exec(rule)
  assert.equal(
    decl,
    null,
    `标签那条 CSS 里不许再有 \`text-transform\` ✗（它就是屏上变大写的原因 ✓，实际：${decl === null ? '（无）' : decl[0]}）`,
  )
})

test('★★ 后缀原样（二）：任何一行 CSS 字符串里都不许有 text-transform ✗', () => {
  /**
   * ★ 判据要求命中那一行**以字符串字面量开头**（`'…'` ✓）：
   *   CSS 进浏览器只有 `style.textContent = [ '…' ]` 这一条路 ✓ ⇒ 那一行必然以 `'` 开头 ✓；
   *   注释行以 `*` / `/*` / `//` / `·` 开头 ✓ ⇒ ★ 我在源码注释里写下的那个词**打不红这条** ✓，
   *   也**不会**被这条当成实现 ✗（否则就是「匹配注释里的字符串」那种假判据 ✗）。
   * 变异验证（实跑 ✓）：把 `text-transform: uppercase` 加回**标签那条**规则 ⇒ 本 test 与（一）一起红 ✓；
   *   加回到**父规则** `.dshm-file-name` 上 ✗ ⇒ **只有本 test 红** ✓（这正是它非有不可的理由 ✓）。
   */
  const hit = /(^|\n)[ \t]*'[^'\n]*text-transform[^'\n]*'/.exec(bootSource)
  assert.equal(
    hit,
    null,
    `boot.js 的 CSS 字符串里不许再有 \`text-transform\` ✗（换到父规则上靠继承生效同样算 ✗，实际：${hit === null ? '（无）' : hit[0].trim()}）`,
  )
})

test('★★ 后缀原样（三）：JS 生产路径里不许有 toUpperCase / textTransform ✗', () => {
  for (const fnName of ['fitFileNameParts', 'entryRow', 'dirTagText']) {
    const fnBody = functionBodyAtColumn2(bootSource, fnName)
    assert.ok(
      !/toUpperCase|toLocaleUpperCase/.test(fnBody),
      `${fnName} 的函数体里不许有 toUpperCase ✗（后缀要原样 ✓）`,
    )
    assert.ok(
      !/textTransform/.test(fnBody),
      `${fnName} 的函数体里不许出现 textTransform ✗（内联样式那条路同样能把后缀顶成大写 ✗）`,
    )
  }
})

test('★★ 后缀原样（四）：后缀**逐字原样**（小写不被顶上去 ✗、大写也不被压下来 ✗）', () => {
  const internals = fileNameInternals()
  assert.equal(internals.fitFileNameParts('报告.pdf', 22).ext, '.pdf', '小写后缀必须**原样**留着 ✓（不许变 .PDF ✗）')
  assert.equal(internals.fitFileNameParts('REPORT.PDF', 22).ext, '.PDF', '本来就大写的后缀也不许被改 ✗（既不 upper ✗ 也不 lower ✗）')
  assert.equal(internals.fitFileNameParts('说明.MD', 22).ext, '.MD', '混合大小写同样原样 ✓')
})

/* ════════════════════════════════════════════════════════════════════════════
 * ★★ 方案 A（2026-10-06 用户拍板 ✓）：**旁挂隧道** —— 手机页面同时挂多条隧道 ✓
 *
 * 用户原话：「先查一下 **A 的实现有没有机会** ✓，因为**如果走 A，延迟可能会更低** ✓。」
 * 目标只有一个 ✗：手机停在 A 电脑的页面上时，**B 电脑**推的端侧待办
 * （提醒 / 通知 / 审批 ✓）也能被取到 ✓ —— 今天它们要等用户切到 B 那台才会送达 ✓。
 *
 * ## 这一组钉的是什么（逐条都是「少一条就出事」✗）
 *   ① **灾难闸** ✗✗：旁挂那条被拒 ⇒ **只记日志** ✓。它一旦走到
 *      `handleDeviceRejection` ✓，就会清掉**当前宿主**那四条身份键
 *      （`deviceRejected` 是**模块级单例** ✗）并把整页 `location.replace('/mobile')` ✗
 *      ⇒ 「B 被撤销 = A 的配对被清 + 整页跳走」✓；
 *   ② 旁挂那条**不许写** `LAST_ENDPOINT_KEY` ✓（会被「host 不一致就删」判成脏数据 ✓
 *      ⇒ 下次加载删掉**当前这台电脑**的 `lastGoodEndpoint` ✗）、
 *      **不许动** `setActiveHost` / `hostsWrite` ✓（只读目录 + 只取待办 ✓）；
 *   ③ **必须去不同的电脑** ✓（宿主 `sessions` 按 `deviceId` 记 ✓ ⇒ 同机同设备再开一条
 *      会把原来那条**顶掉** ✗）；端点只许用**这条记录自己**的地址 ✓；
 *   ④ 轮询护栏**按隧道各记一份** ✓（只有一份 ⇒ 第二台会被第一台的「在飞」永久挡住 ✗）；
 *   ⑤ 旁挂的节拍 **15 秒** ✓（4 秒那档是给主隧道「人在电脑前等确认」的体感 ✓）；
 *   ⑥ `__DSH_TRANSPORT__` 那一段**逐行不许变** ✓（主传输一个字节不改 ✓）。
 *
 * ★ 写法纪律（本项目的头号教训 ✓）：判据只打**可执行代码**上 ✓（注释整行先滤掉 ✓）——
 *   ✗ 不许只匹配注释里的字符串 ✗；每条判据都**能被变异打红** ✓
 *   （变异对照逐条写在交付说明里 ✓，也在每条断言旁注明「怎么把它打红」✓）。
 * ════════════════════════════════════════════════════════════════════════════ */

/** 注释整行滤掉 ⇒ 只剩**可执行代码** ✓（与本文件上面几条结构性断言同一个手法 ✓）。 */
function executableOnly(source: string): string {
  return source
    .split('\n')
    .filter((line) => {
      const text = line.trim()
      return !(text.startsWith('*') || text.startsWith('/*') || text.startsWith('//'))
    })
    .join('\n')
}

/**
 * 从 `startMarker` 切到 `lastFunction` 那个函数的**结束大括号**为止 ✓。
 * ★ 两个锚点都是**纯 ASCII** ✓（汉字一个都不进判据 ✗ —— 判据里的汉字只出现在**给人看的消息**里 ✓）。
 */
function sourceRegionBetween(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker)
  assert.ok(start >= 0, '必须能在源码里找到起点：' + startMarker)
  const end = source.indexOf(endMarker, start + startMarker.length)
  assert.ok(end > start, '必须能在源码里找到终点：' + endMarker)
  return source.slice(start, end)
}

/**
 * 方案 A **那一整块**旁挂代码 ✓：
 *   起点 = 登记表那个 `var` ✓；终点 = **下一段的第一个函数** ✓（`deriveTunnelUrls` ✓，
 *   即「配置与安装」那一段的开头 ✓ —— 两个锚点都是**纯 ASCII** ✓）。
 * ★ 为什么终点取「下一段的开头」而不是「我这一段的最后一个函数」 ✗：后者留了一条**缝** ✓ ——
 *   在段尾**追加**一个函数（比如一个新的失败处理 ✓）就不会被任何判据看见 ✓
 *   （变异实验：把 `writeIdentityKey(LAST_ENDPOINT_KEY, …)` 追加到段尾 ⇒ 旧判据全绿 ✗）。
 */
function sideTunnelRegion(): string {
  return executableOnly(sourceRegionBetween(bootSource, 'var sideTunnelEntries = []', '  function deriveTunnelUrls('))
}

/** 第 4 列缩进的函数（`poll` / `drivePollTarget` 这类活在 `installDeviceChannel` 里的 ✓） */
function innerFunctionBody(source: string, signature: string): string {
  const start = source.indexOf(signature)
  assert.ok(start >= 0, '必须能找到：' + signature)
  const endAt = source.indexOf('\n    }\n', start)
  assert.ok(endAt > start, signature + ' 的结束大括号应当能在第 4 列找到 ✓')
  return executableOnly(source.slice(start, endAt + 6))
}

/**
 * ★★ 主传输那一段的**可执行行** ✓（注释与空行滤掉 ✓）。
 * 这一组断言量的是「**本轮一个字节都没动它**」✓ —— 所以这里把当前内容**冻住** ✗：
 * 以后谁要改那一段，就必须**显式**来改这份清单 ✓（改清单这个动作本身就是一次复核 ✓）。
 */
function transportBlockLines(): string[] {
  const start = bootSource.indexOf('globalThis.__DSH_TRANSPORT__ = {')
  assert.ok(start >= 0, '必须能找到主传输那一段（__DSH_TRANSPORT__ ✓）')
  const ownsAt = bootSource.indexOf('ownsHost: true,', start)
  assert.ok(ownsAt > start, '必须能找到 ownsHost: true ✓')
  const closeAt = bootSource.indexOf('\n    }\n', ownsAt)
  assert.ok(closeAt > ownsAt, '主传输那个对象的结束大括号应当能在第 4 列找到 ✓')
  return executableOnly(bootSource.slice(start, closeAt + 6))
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

/** ★★ 冻住的那一份（= 2026-10-06 方案 A 落地时主传输的样子 ✓）。 */
const TRANSPORT_BLOCK_LINES: string[] = [
  'globalThis.__DSH_TRANSPORT__ = {',
  'fetch: async function (input, init) {',
  "var url = typeof input === 'string' ? input : input.url",
  'var path = new URL(url, location.href)',
  "var endpoint = path.pathname.replace(/^\\/api\\//, '')",
  'var body = init && init.body !== undefined ? init.body : undefined',
  "var envelope = body === undefined ? {} : JSON.parse(typeof body === 'string' ? body : fromUtf8(new Uint8Array(body)))",
  'var response = await tunnel.rpc(envelope.method, envelope.payload, envelope.rpcId)',
  'if (envelope.rpcId !== undefined && response.rpcId !== envelope.rpcId) {',
  "console.warn('[dsh-mobile] rpcId 不一致（会导致 DSH 拒绝该响应）：发出', envelope.rpcId, '收到', response.rpcId)",
  '}',
  'try {',
  'var binaryResponse = buildBinaryResponse(response)',
  'if (binaryResponse !== undefined) return binaryResponse',
  '} catch (error) {',
  "debugBoxLine('[bytes] 交 multipart 失败：' + String(error && error.message ? error.message : error))",
  'throw error',
  '}',
  'return new Response(JSON.stringify(response), {',
  'status: 200,',
  "headers: { 'content-type': 'application/json' },",
  '})',
  '},',
  'openStream: function (endpoint, payload) {',
  'return tunnel.openStream(endpoint, payload)',
  '},',
  'ownsHost: true,',
  '}',
]

test('★★ 灾难闸：旁挂那一整块绝不许碰到 handleDeviceRejection / 身份键 / 导航', () => {
  const side = sideTunnelRegion()
  /**
   * ★★ 怎么把它打红 ✗：往 `noteSideTunnelRejected`（或旁挂那一块里任何地方）写一句
   *   `handleDeviceRejection(tunnel, code, detail)` ⇒ **下面第一条当场红** ✓。
   *   这正是「以后有人觉得'被拒了就该清身份'」时会发生的那一步 ✓ ——
   *   而它的后果是「B 被撤销 ⇒ A 的配对被清 + 整页跳去配对界面」✗✗。
   * ★ 为什么判据放在「整块」而不是只看那一个函数 ✗：以后新加的任何旁挂代码
   *   （失败处理 / 读数 / 安装 ✓）都该受这一条管 ✓。
   */
  assert.equal(
    side.split('handleDeviceRejection').length - 1,
    0,
    '★ 旁挂那一整块里绝不许出现 handleDeviceRejection ✗：它会清**当前宿主**的四条身份键 + location.replace(/mobile) ✗✗',
  )
  assert.equal(side.split('deviceRejected').length - 1, 0, '★ 旁挂那块也不许碰 `deviceRejected` 那个**模块级单例** ✗')
  assert.equal(side.split('location.replace').length - 1, 0, '★ 旁挂那块绝不许导航 ✗（被拒 ⇒ 只记日志 ✓）')
  /**
   * ★★ 再加一道**全文件**的判据 ✓（与上面那条**互相独立** ✓）：
   *   那个函数的**调用点**全文件恰好 3 处（`open()` 的「全部端点都被明确拒绝」 ✓、
   *   Revoked 帧 ✓、验收直通口 ✓）+ 1 处定义 = 4 ✓。
   * ★ 为什么非要有它 ✗：上面那条只覆盖「我这一段」 ✓ —— 而**段尾追加**、
   *   或**别处新增**一个调用点，都会绕过它 ✓（变异实验见交付说明 ✓）。
   * ★ 怎么把它打红 ✗：在任何地方**再加一个调用**（哪怕在旁挂段尾 ✓）⇒ 变成 5 ⇒ 当场红 ✓。
   */
  assert.equal(
    executableOnly(bootSource).split('handleDeviceRejection(').length - 1,
    4,
    '★ 清身份那条路的出生点全文件只许这 4 处（1 定义 + 3 调用）—— 多一处就要人来复核 ✓',
  )
  assert.equal(
    side.split('PAIRING_PAGE_PATH').length - 1,
    0,
    '★ 旁挂那块连配对页那个常量都不许出现 ✓（出现就意味着有人想「跳回配对界面」✗）',
  )
  // ★ 反向：那条「只记日志」的路**真的在** ✓（没有实现的话，「变异打红」就无从谈起 ✓）
  assert.ok(side.includes('function noteSideTunnelRejected('), '旁挂被拒必须有它自己的处理函数 ✓')
  const rejected = executableOnly(functionBodyAtColumn2(bootSource, 'noteSideTunnelRejected'))
  assert.ok(rejected.includes('console.warn('), '被拒之后必须留下**可念的一行** ✓（手机上没有控制台 ✓）')
  assert.ok(rejected.includes('debugBoxLine('), '而且必须进调试框 ✓')
  assert.equal(
    rejected.split('writeIdentityKey(').length + rejected.split('removeIdentityKey(').length,
    2,
    '★ 被拒那条路里**一个身份键都不许动** ✗（本机与壳的那四条都是当前宿主的 ✓）',
  )
  // ★★ 闸本体：必须排在「清身份 + 跳页」**之前** ✗（排后面 = 身份已经被清了 ✓）
  const rejectBody = executableOnly(functionBodyAtColumn2(bootSource, 'handleDeviceRejection'))
  const guardAt = rejectBody.indexOf('isSideChannelTunnel(tunnel)')
  assert.ok(guardAt >= 0, '★ handleDeviceRejection 顶上必须有「这条是不是旁挂」那道闸 ✓')
  const clearAt = rejectBody.indexOf('writeIdentityClearedMarker(code, detail, cleared, undefined)')
  const navAt = rejectBody.indexOf('location.replace(PAIRING_PAGE_PATH)')
  assert.ok(clearAt > guardAt, '★ 闸必须在「清身份」之前 ✗（排在后面 = 身份已经被清掉了 ✓）')
  assert.ok(navAt > guardAt, '★ 闸必须在「跳页」之前 ✗')
})

test('★ 另外两道闸：旁挂那条不写 LAST_ENDPOINT_KEY、也不动宿主目录', () => {
  const side = sideTunnelRegion()
  /**
   * ★★ 第一道闸怎么把它打红 ✗：在旁挂那块里写一句
   *   `writeIdentityKey(LAST_ENDPOINT_KEY, url)`（「顺手记一下上次端点」是个很自然的念头 ✓）
   *   ⇒ 下面第一条（只许出现一次）当场红 ✓。
   *   为什么要禁 ✗：`readLastGoodEndpointForCurrentSource()` 对 host 不一致的那条
   *   **会删掉它** ✓ —— 于是 B 那条隧道写进去的地址，下一次在 A 的页面上加载时
   *   会把**当前这台**的 `lastGoodEndpoint` 清掉 ✗（「首选端点」这条优化静默失效 ✓）。
   */
  assert.equal(
    side.split('LAST_ENDPOINT_KEY').length - 1,
    1,
    '★ 旁挂那块只许**读**一次 lastGoodEndpoint（多出来的那一次必然是写 ✗）',
  )
  assert.ok(
    side.includes('readIdentityKeyValue(LAST_ENDPOINT_KEY, record.fingerprint)'),
    '★ 而且必须是按**那台自己的指纹**读 ✓（「那台的上次端点」才配当首选 ✓）',
  )
  /**
   * ★★ 第二道闸怎么把它打红 ✗：在旁挂那块里调 `setActiveHost(...)` / `hostsWrite(...)`
   *   ⇒ 下面那个循环当场红 ✓。旁挂隧道只该**读**目录 ✓、只该**取**待办 ✓。
   */
  for (const forbidden of [
    'writeIdentityKey(',
    'removeIdentityKey(',
    'hostsWrite(',
    'setActiveHost(',
    'hostRecordUpsert(',
    'forgetHost(',
  ]) {
    assert.equal(
      side.split(forbidden).length - 1,
      0,
      '★ 旁挂那一整块里不许出现 ' + forbidden + ' ✗（只读目录 + 只取待办 ✓）',
    )
  }
  /**
   * ★★ 但上面那条**只覆盖「旁挂那一段」** ✗ —— 而「拨号成功就记一笔」这个副作用长在
   *   **共用的** `open()` 里 ✓：真跑的第一次就把它抓出来了 ✓
   *   （旁挂那段确实一个字节没写 ✓，可它一拨通，`open()` 就替它写了 ✗✗）。
   *   ⇒ 判据必须落在**副作用本身**上 ✓：那句写要被 `self.config.sideChannel !== true` 挡着 ✓。
   * ★ 怎么把它打红 ✗：把 `if (self.config.sideChannel !== true)` 去掉（回到原样一句 ✓）
   *   ⇒ 下面这条**当场红** ✓，而且**真跑**那条也会红 ✓（旁挂一拨通就写进来 ✓）。
   */
  const openAt = bootSource.indexOf('Tunnel.prototype.open = function')
  assert.ok(openAt >= 0, '必须能找到 Tunnel.prototype.open ✓')
  const openEnd = bootSource.indexOf('Tunnel.prototype.', openAt + 10)
  assert.ok(openEnd > openAt, '必须能切出 open() 这一块 ✓')
  const openBody = executableOnly(bootSource.slice(openAt, openEnd))
  assert.ok(
    openBody.includes('if (self.config.sideChannel !== true) writeIdentityKey(LAST_ENDPOINT_KEY, url)'),
    '★ open() 里那句「记上次成功端点」必须被旁挂那道闸挡着 ✗（否则旁挂一拨通就替当前这台写脏了 ✓）',
  )
  assert.equal(
    openBody.split('LAST_ENDPOINT_KEY').length - 1,
    1,
    '★ open() 里碰这个键只此一处 ✓（多一处都要人来复核 ✓）',
  )
})

test('★★ 旁挂隧道必须去**别的电脑**：跳过当前那台、且端点只用这条记录自己的地址', () => {
  const start = executableOnly(functionBodyAtColumn2(bootSource, 'startSideTunnels'))
  /**
   * ★★ 怎么把它打红 ✗：把 `if (fingerprint === current) continue` 删掉
   *   ⇒ 当前这台也会被挂上第二条隧道 ✓ —— 而两条隧道用**同一份凭据**
   *   （同一个 `deviceId` ✓）连**同一台**宿主 ⇒ 宿主按 deviceId 记会话 ⇒
   *   **主隧道当场被顶掉** ✗✗。下面第一条就是钉这件事 ✓。
   */
  assert.ok(start.includes('if (fingerprint === current) continue'), '★ 当前这台必须跳过 ✗（同机同凭据会顶掉主隧道 ✓）')
  assert.ok(
    start.includes('if (!validHostFingerprint(current))'),
    '★ 定不出「当前这台」⇒ **一条都不建** ✓（猜错的方向就是把当前这台也挂上 ✓）',
  )
  assert.ok(
    start.includes('hasStoredHostCredential(fingerprint)'),
    '★ 本机没有那台的凭据 ⇒ 不建 ✓（连上去必被拒，而且会**凭空生成一份新私钥** ✗）',
  )
  assert.ok(start.includes('hostFingerprint: fingerprint'), '★ 那条隧道必须**知道自己是哪台** ✓（取凭据靠它 ✓）')
  assert.ok(start.includes('pinnedHostFingerprint: fingerprint'), '★ 而且要把那台的指纹**钉死** ✓（否则等于让网络位置回答「这台是谁」✗）')
  assert.ok(start.includes('autoReconnect: false'), '★ 安静退化的总开关 ✓（不数轮次 / 不发通知 / 不派发 offline ✓）')
  assert.ok(start.includes('sideChannel: true'), '★ 灾难闸与 noteDialSuccess 的判据 ✓（一个字段、两处读 ✓）')
  /**
   * ★★ 怎么把它打红 ✗：把 `allowed[derivedHost] !== true` 那道过滤删掉 ——
   *   于是 `deriveTunnelUrls` 混进来的「当前页面源」与「当前源上次成功的端点」
   *   会留在候选里 ✓ ⇒ 去 B 的旁挂隧道会**先拿 B 的凭据去连 A** ✓（对面回 device-unknown ✓）。
   */
  const endpoints = executableOnly(functionBodyAtColumn2(bootSource, 'sideTunnelEndpoints'))
  assert.ok(endpoints.includes('deriveTunnelUrls('), '★ 端点必须走**既有那个纯函数** ✓（不许另写一套拼接 ✗）')
  assert.ok(
    endpoints.includes('allowed[derivedHost] !== true'),
    '★ 只留属于**这条记录**的候选 ✓ —— 「必须去不同的电脑」这条硬约束就落在这一句上 ✓',
  )
  assert.equal(
    endpoints.split('LAST_ENDPOINT_KEY').length - 1,
    1,
    '★ 端点推导里只许**读**那台的 lastGoodEndpoint ✓（绝不写 ✗）',
  )
  /**
   * ★ 身份那条链：可选指纹参数 ⇒ 旁挂取**那台**的凭据 ✓；省略 ⇒ 与改动前逐字一致 ✓。
   * ★ 怎么把它打红 ✗：把 `validHostFingerprint(explicitFingerprint) ? … : currentHostFingerprint()`
   *   改回写死 `currentHostFingerprint()` ⇒ 旁挂会拿**当前这台**的私钥去连别的电脑 ✓。
   */
  const loaderAt = bootSource.indexOf('  async function loadOrCreateDeviceKey(')
  assert.ok(loaderAt >= 0, '必须能找到 loadOrCreateDeviceKey ✓')
  const loaderEnd = bootSource.indexOf('\n  }\n', loaderAt)
  const loader = executableOnly(bootSource.slice(loaderAt, loaderEnd))
  assert.ok(
    loader.includes('validHostFingerprint(explicitFingerprint) ? explicitFingerprint : currentHostFingerprint()'),
    '★ 给了合法指纹就用它 ✓、没给就与改动前**逐字一致** ✓（主隧道正是「没给」那一支 ✓）',
  )
  const hsAt = bootSource.indexOf('Tunnel.prototype.performHandshake = async function')
  assert.ok(hsAt >= 0, '必须能找到 performHandshake ✓')
  const hsEnd = bootSource.indexOf('\n  }\n', hsAt)
  const handshake = executableOnly(bootSource.slice(hsAt, hsEnd))
  assert.ok(
    handshake.includes('loadOrCreateDeviceKey(this.config.hostFingerprint)'),
    '★ 握手必须按**这条隧道自己那台**取凭据 ✓',
  )
})

test('★★ 轮询护栏按**隧道各记一份**（只有一份 ⇒ 第二台会被第一台的「在飞」永久挡住）', () => {
  const codeOnly = executableOnly(bootSource)
  /**
   * ★★ 怎么把它打红 ✗：把护栏改回**单个闭包变量**（`var pollInFlightAt = 0`
   *   + `if (pollInFlightAt !== 0 …) return 'busy'` ✓）⇒ 下面第一条当场红 ✓。
   */
  assert.ok(
    !/var pollInFlightAt = 0\b/.test(codeOnly),
    '★ 护栏不许再是**单个变量** ✗ —— 那正是「第二台被第一台永远挡住」的形状 ✓',
  )
  const drive = innerFunctionBody(bootSource, '    function drivePollTarget(target) {')
  const uses = drive.split('target.pollInFlightAt').length - 1
  assert.ok(
    uses >= 3,
    '★ 护栏必须记在**每条隧道自己**那条记录上 ✓（读一次 / 起飞写一次 / 收尾各清一次 ✓），实际 ' + String(uses) + ' 处',
  )
  assert.ok(!drive.includes('var pollInFlightAt'), '★ 这里不许再有「本函数的那一份」 ✗')
  const factory = executableOnly(functionBodyAtColumn2(bootSource, 'makePollTarget'))
  assert.ok(factory.includes('pollInFlightAt: 0'), '★ 每造一条隧道就带**它自己**那份护栏 ✓')
  assert.ok(
    factory.includes('lastPollSummary: null') && factory.includes('lastPollErrorKey: null'),
    '★ 两个去重键也必须每台各一份 ✓（一份 ⇒ 两条隧道互相顶掉 ⇒ 调试框两种话轮流刷 ✗）',
  )
  /**
   * ★★ 怎么把它打红 ✗：让 `devicePollTick` 只驱动主隧道（去掉遍历 ✓）
   *   ⇒ 下面这两条当场红 ✓。
   */
  const tick = innerFunctionBody(bootSource, '    function devicePollTick() {')
  assert.ok(tick.includes('devicePollTargets()'), '★ 这一发必须**遍历**所有该跑的隧道 ✓')
  assert.ok(tick.includes('drivePollTarget('), '★ 每条走**它自己**那一份护栏与节拍 ✓')
  const targets = innerFunctionBody(bootSource, '    function devicePollTargets() {')
  assert.ok(targets.includes('mainPollTarget'), '★ 主隧道永远第一 ✓（`tick(\'poll\')` 那条口径因此不变 ✓）')
  assert.ok(targets.includes('sideTunnelEntries'), '★ 后面接上旁挂那几条 ✓')
  assert.ok(
    targets.includes('entry.rejected === true') && targets.includes('entry.unsupported === true'),
    '★ 已经明确没戏的旁挂隧道要跳过 ✓（再去戳只会换来同样的拒绝 ✓）',
  )
  /**
   * ★★ 怎么把它打红 ✗：让旁挂那条也用主传输（把 `transport = target.transport` 删掉 ✓）
   *   ⇒ 下面这条红 ✓ —— 那等于「拿 B 的待办去问 A」✗。
   */
  /**
   * ★★ 诊断读数也要**按隧道分份** ✗✓：`keepAliveStats.lastPingAt` 回答的是
   *   「**当前这条通道**还活着没有」✓ —— 旁挂的 ping 混进来的话，
   *   主隧道早死了而旁挂还活着时这个数照样在动 ✗（读数骗人 ✓）。
   * ★ 怎么把它打红 ✗：把那句 `if (this.config.sideChannel !== true)` 去掉 ⇒ 下面这条红 ✓。
   */
  const pingAt = bootSource.indexOf('Tunnel.prototype.sendKeepalivePing = function')
  assert.ok(pingAt >= 0, '必须能找到 sendKeepalivePing ✓')
  const pingEnd = bootSource.indexOf('Tunnel.prototype.', pingAt + 10)
  const pingBody = executableOnly(bootSource.slice(pingAt, pingEnd))
  assert.ok(
    pingBody.includes('if (this.config.sideChannel !== true) keepAliveStats.lastPingAt'),
    '★ 保活那个读数只许由主隧道写 ✓（旁挂的 ping 不许混进「当前这条通道」的读数 ✗）',
  )
  const pollBody = innerFunctionBody(bootSource, '    async function poll(target) {')
  assert.ok(pollBody.includes('target.transport'), '★ 旁挂那条必须用**它自己的**传输 ✓（绝不用主传输 ✗）')
  assert.ok(
    pollBody.includes('target.unsupported = true') && pollBody.includes('target.lastPollErrorKey = null'),
    '★ 状态也必须落在**它自己**那条记录上 ✓（原来那三个全局变量的位置 ✓）',
  )
})

test('★ 旁挂那条的节拍是 15 秒（不是主隧道那档 4 秒），而且第一轮不额外等', () => {
  const codeOnly = executableOnly(bootSource)
  /**
   * ★★ 怎么把它打红 ✗：把 `var SIDE_TUNNEL_POLL_MS = 15000` 改成 `4000`
   *   ⇒ 第一条当场红 ✓；把 `drivePollTarget` 里那句 `SIDE_TUNNEL_POLL_MS`
   *   换回写死的 `4000` ⇒ 第二、三条红 ✓。
   */
  assert.ok(/var SIDE_TUNNEL_POLL_MS = 15000\b/.test(codeOnly), '★ 旁挂的节拍常量必须是 **15000ms** ✓（不是 4 秒 ✗）')
  const drive = innerFunctionBody(bootSource, '    function drivePollTarget(target) {')
  assert.ok(drive.includes('SIDE_TUNNEL_POLL_MS'), '★ 节拍必须由那个常量说了算 ✓（不许在别处写死 ✓）')
  assert.ok(!drive.includes('4000'), '★ 旁挂那条绝不走主隧道那档 4 秒 ✗')
  assert.ok(drive.includes('target.side === true'), '★ 那一档**只对旁挂**生效 ✓（主隧道照旧 4 秒 ✓）')
  assert.ok(codeOnly.includes('}, 4000)'), '★ 主隧道那条 4 秒的定时器必须**原样还在** ✓（不许被顺手改掉 ✗）')
  /**
   * ★ 第一轮不额外等 ✓（建起来时不写 `lastDrivenAt` ⇒ 下一发 tick 就轮得到它 ✓）——
   * 用户走方案 A 的动机就是**低延迟** ✓；★ 怎么把它打红 ✗：在创建处加一句
   * `entry.lastDrivenAt = Date.now()` ⇒ 下面这条红 ✓。
   */
  const start = executableOnly(functionBodyAtColumn2(bootSource, 'startSideTunnels'))
  assert.ok(!start.includes('lastDrivenAt'), '★ 建的时候就写 lastDrivenAt ⇒ 第一轮要白等 15 秒 ✗（用户要的是延迟低 ✓）')
})

test('★★ 不许弄坏今天能用的：__DSH_TRANSPORT__ 那一段**逐行原样**', () => {
  /**
   * 怎么把它打红 ✗：往主传输里加/删/改**任何一行**（哪怕只是多一句注释之外的语句 ✓）
   *   ⇒ 下面这条 `deepEqual` 当场红 ✓。
   * ★ 这一条是「旁挂不许蹭主传输」的**另一半** ✓：
   *   旁挂自己那套最小传输写在方案 A 那一块里 ✓（见 `sideChannelTransport` ✓），
   *   主传输那一段**本轮一个字节都没动** ✓。
   */
  assert.deepEqual(transportBlockLines(), TRANSPORT_BLOCK_LINES, '★ 主传输那一段必须与冻结时**逐行一致** ✗')
  const codeOnly = executableOnly(bootSource)
  assert.equal(
    codeOnly.split('globalThis.__DSH_TRANSPORT__ = {').length - 1,
    2,
    '★ 全文件主传输的出生地应当仍是**两处**（真传输 + 占位层 ✓）—— 多一处/少一处都要人来复核 ✓',
  )
  // ★ 旁挂自己那条最小传输：只给 `fetch` 一个口 ✓（多开一个口就多一处「可能跑错机器」的地方 ✓）
  const sideTransport = executableOnly(functionBodyAtColumn2(bootSource, 'sideChannelTransport'))
  assert.ok(sideTransport.includes('fetch:'), '★ 旁挂传输至少要有 fetch ✓（端侧轮询只用它 ✓）')
  assert.ok(
    !sideTransport.includes('openStream') && !sideTransport.includes('ownsHost'),
    '★ 旁挂传输只许有 fetch 一个口 ✗（它不承载 DSH 业务流量 ✓）',
  )
  assert.ok(sideTransport.includes('sideTunnel.rpc('), '★ 它必须走**那条隧道自己**的 rpc ✓')
})

/* ════════════════════════════════════════════════════════════════════════════
 * ★★★ 方案 A 的**端到端证据**：两台**真宿主** + 两条**真隧道** ⇒ 各取各的待办 ✓
 *
 * ## 为什么非要真跑一次 ✗
 * 上面那一组全是**代码形状**的判据 ✓ —— 它们证明不了「两个 `TunnelSession` 与两条隧道
 * 能**同时**活着、而且各自从**自己那台**的队列里取待办」 ✓，而那正是方案 A 的前提
 * （上一单实跑过 14/14 ✓，但验的不是本轮这段代码 ✓）。
 *
 * ## 与真机一致的三处 ✓（都靠本文件既有的那套夹具 —— `ReplaySocket` + 真 `TunnelSession` ✓）
 *   · 页面源 = **A 那台** ✓（`location.host` ✓）；B 那台**在宿主目录里** ✓（槽 = 它自己的地址 ✓）；
 *   · 本机两台的凭据**各自命名空间化** ✓（`dsh-mobile.device-key:<指纹>` ✓，deviceId 也不同 ✓）；
 *   · 端侧队列是**真的** `DeviceCallQueue` ✓（取走即投递 ✓、回报即出队 ✓）。
 *
 * ★ 这一条**不是**替身戏法 ✓：跑的是 `startSideTunnels` **生产那条路** ✓
 *   （boot → 建旁挂 → 15 秒节拍那条 `devicePollTick` ✓），断言打在
 *   **生产读数**（`__DSH_MOBILE_BOOT__.sideChannels()` ✓）与**宿主那两台的收发记录**上 ✓。
 * ════════════════════════════════════════════════════════════════════════════ */

/** 一台「真电脑」：真 `DeviceStore` + 真 `DeviceCallQueue` + 真宿主签名密钥 ✓。 */
interface SideWorldHost {
  name: string
  /** 它的 authority ✓（`host:port` ✓）。 */
  host: string
  fingerprint: string
  deviceId: string
  /** 本机为它存的凭据（`dsh-mobile.device-key:<指纹>` 的值 ✓）。 */
  deviceKeyStorageValue: string
  signing: ReturnType<typeof generateP256KeyPair>
  store: InstanceType<typeof DeviceStore>
  queue: InstanceType<typeof DeviceCallQueue>
  /**
   * 这台收到的每一次隧道请求 ✓（「各取各的」就断言在这上面 ✓）。
   * ★ 连**响应**一起记 ✓：`mobile/device/pending` 的响应里就带着「这一轮取到了哪几条」✓
   *   —— 只记请求的话，「A 取到的是不是 A 那条」就只能靠 id 猜 ✓（id 由队列各自编号 ✓）。
   */
  seen: Array<{ endpoint: string; payload: Record<string, unknown>; response: unknown }>
  /** 这次握手它认出来的设备 ✓（用来证明「用的是**它自己**那份凭据」✓）。 */
  authenticated: string
}

/** 页面源（= A 那台 ✓ —— 与 `bootOnSurface` 默认的 `location.host` 必须一致 ✓）。 */
const SIDE_HOST_A = '10.34.221.181:3443'
/** 目录里**另一台**电脑 ✓（旁挂那条该去的地方 ✓）。 */
const SIDE_HOST_B = '100.123.136.82:3443'

async function makeSideWorldHost(name: string, host: string): Promise<SideWorldHost> {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-mobile-side-' + name + '-'))
  const store = new DeviceStore({ directory: dir })
  const signing = generateP256KeyPair()
  const fingerprintHex = fingerprint(signing.publicKey)
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  const publicRaw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))
  const privateJwk = await crypto.subtle.exportKey('jwk', pair.privateKey)
  const deviceId = 'web-side-' + name
  const publicKeyB64u = Buffer.from(publicRaw).toString('base64url')
  store.upsert({
    deviceId,
    devicePublicKey: '',
    deviceSigningKey: publicKeyB64u,
    fingerprint: fingerprint(publicKeyB64u),
    name: '方案A真跑-' + name,
    pairedAt: new Date().toISOString(),
    authorization: 'persistent',
    capabilities: { ...DEFAULT_CAPABILITIES },
  })
  const queue = new DeviceCallQueue()
  // ★ 端侧能力**默认全禁** ⇒ 不显式打开的话 `takePending` 一条都不投递 ✓（真实语义 ✓）。
  queue.setEnabled(deviceId, 'show', true)
  return {
    name,
    host,
    fingerprint: fingerprintHex,
    deviceId,
    deviceKeyStorageValue: JSON.stringify({ deviceId, publicKey: publicKeyB64u, privateKeyJwk: privateJwk }),
    signing,
    store,
    queue,
    seen: [],
    authenticated: '',
  }
}

test('★★★ 方案 A 真跑：两条隧道同时 pending ⇒ 各取各的队列（两台真宿主 + 真握手 + 真队列）', async () => {
  const hostA = await makeSideWorldHost('a', SIDE_HOST_A)
  const hostB = await makeSideWorldHost('b', SIDE_HOST_B)
  assert.notEqual(hostA.deviceId, hostB.deviceId, '前置：两台的 deviceId 必须不同 ✓（宿主就是按它记会话的 ✓）')

  // ★ 两台各压一条待办 ✓（A 一条、B 一条 ✓ —— 各取各的才测得出串台 ✓）
  const callA = hostA.queue.enqueue(hostA.deviceId, 'show', 'A 那条提醒')
  /**
   * ★ 隔开几毫秒再压第二条 ✗：`DeviceCallQueue` 的 id 是**每个队列各自编号**的
   *   （`dc-<序号>-<时间戳36进制>` ✓）⇒ 两台在同一毫秒里各压一条会得到**同样的 id** ✓
   *   —— 那样「各取各的」就只能靠 id 之外的东西证明 ✓。这里隔开，
   *   是为了让下面那些**按 id** 的判据本身有意义 ✓（并且单独断言两个 id 真的不同 ✓）。
   */
  await new Promise((resolve) => setTimeout(resolve, 5))
  const callB = hostB.queue.enqueue(hostB.deviceId, 'show', 'B 那条提醒')
  assert.notEqual(callA.id, callB.id, '前置：两条待办的 id 必须不同 ✓（否则按 id 的判据证明不了什么 ✓）')

  /** 每条 socket 归哪台宿主 ✓（按它的 URL 认 ✓ —— 真机上就是「连到哪台」✓）。 */
  const sessions = new Map<ReplaySocket, InstanceType<typeof TunnelSession>>()
  const hostOfSocket = (socket: ReplaySocket): SideWorldHost => (socket.url.includes(SIDE_HOST_B) ? hostB : hostA)
  const dirs: string[] = []
  const cleanup = (): void => {
    ReplaySocket.onSend = undefined
    try {
      surface.boot.tunnel?.stopKeepalive?.()
    } catch (error) {
      void error
    }
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  }

  ReplaySocket.created.length = 0
  ReplaySocket.onSend = (socket, bytes) => {
    const host = hostOfSocket(socket)
    let session = sessions.get(socket)
    if (session === undefined) {
      session = new TunnelSession(
        {
          resolveDevice: (hello) => {
            host.authenticated = hello.deviceId
            const record = host.store.get(hello.deviceId)
            if (record === undefined) return undefined
            return {
              deviceId: record.deviceId,
              devicePublicKey: record.devicePublicKey,
              deviceSigningKey: record.deviceSigningKey,
              fingerprint: record.fingerprint,
              capabilities: record.capabilities,
              authorization: record.authorization,
            }
          },
          invoke: async (request) => {
            /**
             * ★ 这一段与**宿主生产实现**（`packages/host/src/index.ts` 的 `mobile/device/*`）
             * 同一个形状 ✓：`pending` 取走即投递 ✓、`result` 回报即出队 ✓ ——
             * 断言因此量的是**真语义** ✓，不是「我编个回声」✓。
             */
            const payload = (request.payload ?? {}) as Record<string, unknown>
            const args = (payload['args'] ?? {}) as Record<string, unknown>
            let value: unknown = { ok: true, value: { endpoint: request.endpoint } }
            if (request.endpoint === 'mobile/device/pending') {
              value = {
                ok: true,
                value: {
                  calls: host.queue.takePending(host.authenticated),
                  // ★ 与宿主生产实现逐字同源 ✓（`index.ts` 的 `mobile/device/pending` ✓）
                  capabilities: [...DEVICE_CAPABILITIES],
                  enabled: host.queue.listEnabled(host.authenticated),
                },
              }
            } else if (request.endpoint === 'mobile/device/result') {
              value = {
                ok: true,
                value: host.queue.recordResult(
                  host.authenticated,
                  String(args['id'] ?? ''),
                  args['ok'] === true,
                  String(args['detail'] ?? ''),
                ),
              }
            } else if (request.endpoint === 'mobile/device/enable') {
              value = {
                ok: true,
                value: {
                  capabilities: host.queue.setEnabled(
                    host.authenticated,
                    String(args['capability'] ?? ''),
                    args['enabled'] !== false,
                  ),
                },
              }
            }
            host.seen.push({ endpoint: request.endpoint, payload, response: value })
            return value
          },
          openStream: () => (async function* () {})(),
        },
        (out) => {
          socket.deliver(new Uint8Array(out))
          return true
        },
      )
      session.hostId = 'host-' + host.name
      session.hostSigningKey = host.signing as never
      sessions.set(socket, session)
    }
    session.receive(bytes)
  }

  const seed: Record<string, string> = {
    ['dsh-mobile.device-key:' + hostA.fingerprint]: hostA.deviceKeyStorageValue,
    ['dsh-mobile.device-key:' + hostB.fingerprint]: hostB.deviceKeyStorageValue,
    ['dsh-mobile.host:' + hostA.fingerprint]: JSON.stringify({
      baseUrl: 'https://' + SIDE_HOST_A,
      tunnelUrl: 'wss://' + SIDE_HOST_A + '/mobile/ws',
      pinnedHostFingerprint: hostA.fingerprint,
    }),
    'dsh-mobile.hosts': JSON.stringify([
      {
        fingerprint: hostA.fingerprint,
        label: '电脑A',
        slots: [{ label: '本机', url: 'https://' + SIDE_HOST_A }],
        lastState: 'paired',
        lastSeenAt: 1,
        updatedAt: 1,
      },
      {
        fingerprint: hostB.fingerprint,
        label: '电脑B',
        slots: [{ label: '学校', url: 'https://' + SIDE_HOST_B }],
        lastState: 'paired',
        lastSeenAt: 2,
        updatedAt: 2,
      },
    ]),
    // ★ 端侧能力那条征询不参与本用例 ✓（`runCall` 自己不看它 ✓ —— 只有征询条看 ✓）
    'dsh-mobile.deviceAsk.show': 'yes',
  }

  const surface = bootOnSurface({
    pathname: '/mobile/app',
    innerWidth: 412,
    consent: [],
    seed,
    webSocket: ReplaySocket,
    unrefTimers: true,
  })
  try {
    assert.equal(surface.thrown.length, 0, `顶层不应抛错：${String(surface.thrown[0])}`)

    /**
     * ★★ 第一道闸的**真跑**判据用的是**顺序**✗✓：**先只放行旁挂那条（去 B 的）** ✓，
     *   等它真的连上 ✓ ⇒ 此刻「上次成功的端点」必须**一个字节都没有** ✓
     *   （若它写了，下面那条当场红 ✓）。这样断言就**不依赖**「谁后写谁赢」那种时序 ✓ ——
     *   否则主隧道随后写一次就会把证据盖掉 ⇒ **假绿** ✓（项目里的头号教训 ✓）。
     */
    const sideSocket = await waitForValue(
      () => ReplaySocket.created.find((socket) => socket.url.includes(SIDE_HOST_B)),
      '旁挂那条拨出 socket（去 B）',
    )
    const mainSocket = await waitForValue(
      () => ReplaySocket.created.find((socket) => socket.url.includes(SIDE_HOST_A)),
      '主隧道拨出 socket（去 A）',
    )
    sideSocket.fireOpen()
    await waitForValue(() => {
      const side = surface.boot.sideChannels()
      return side.length === 1 && side[0]!.activeEndpoint !== null ? true : undefined
    }, '旁挂那条（B）先连上')
    assert.equal(
      surface.storage.get('dsh-mobile.lastGoodEndpoint:' + hostA.fingerprint),
      undefined,
      '★ 旁挂那条拨号成功**一个字节都不许写**「上次成功的端点」✗✗（写了会在下次加载时被当成「属于别的源」删掉当前这台的 ✓）',
    )
    assert.equal(
      surface.storage.get('dsh-mobile.lastGoodEndpoint:' + hostB.fingerprint),
      undefined,
      '★ B 那个命名空间下同样不许有 ✓（旁挂那条不该留任何「上次端点」✓）',
    )
    // ★ 再放行主隧道 ✓ —— 它照旧要写（今天这条优化一个字不改 ✓）
    mainSocket.fireOpen()
    await waitForValue(
      () => (surface.boot.tunnel !== undefined && surface.boot.tunnel.sessionId !== undefined ? true : undefined),
      '主隧道（A）连上',
    )
    assert.equal(
      surface.storage.get('dsh-mobile.lastGoodEndpoint:' + hostA.fingerprint),
      'wss://' + SIDE_HOST_A + '/mobile/ws',
      '★ 主隧道照旧把「上次成功的端点」记下来 ✓（这条优化今天怎么用，现在还怎么用 ✓）',
    )

    assert.equal(hostA.authenticated, hostA.deviceId, '★ A 那台认出来的必须是**A 自己**那份凭据 ✓')
    assert.equal(hostB.authenticated, hostB.deviceId, '★ B 那台认出来的必须是**B 自己**那份凭据 ✓（命名空间化 ✓）')
    assert.equal(hostA.queue.pendingCount(), 1, '前置：驱动之前 A 那条还在 ✓（证明是这一轮取的 ✓）')
    assert.equal(hostB.queue.pendingCount(), 1, '前置：驱动之前 B 那条还在 ✓')

    // ── 驱动**一发**轮询 ✓（页面那个 4 秒定时器在沙箱里就是 `intervals[0]` ✓）──
    const onTick = surface.intervals[0]
    assert.ok(onTick !== undefined, '端侧通道应注册轮询定时器')
    onTick()
    try {
      await waitForValue(
        () =>
          hostA.seen.some((entry) => entry.endpoint === 'mobile/device/result') &&
          hostB.seen.some((entry) => entry.endpoint === 'mobile/device/result')
            ? true
            : undefined,
        '两台电脑各自收到回报',
      )
    } catch (error) {
      // ★ 这里的现场必须**带出来** ✗：手机上排障只有调试框与读数可用 ✓，测试也一样 ✓。
      assert.fail(
        String(error) +
          '\nA 收到：' + JSON.stringify(hostA.seen.map((entry) => entry.endpoint)) +
          '\nB 收到：' + JSON.stringify(hostB.seen.map((entry) => entry.endpoint)) +
          '\n旁挂读数：' + JSON.stringify(surface.boot.sideChannels()) +
          '\n调试框：\n' + surface.boxText(),
      )
    }

    // ── ① 两台**各自**被取过一次待办 ✓（不是一台被取两次、另一台零次 ✗）──
    const aTook = hostA.seen.filter((entry) => entry.endpoint === 'mobile/device/pending')
    const bTook = hostB.seen.filter((entry) => entry.endpoint === 'mobile/device/pending')
    assert.equal(aTook.length, 1, '★ A 那台应当恰好被取过一次待办 ✓')
    assert.equal(bTook.length, 1, '★ B 那台应当恰好被取过一次待办 ✓')

    // ── ② 回报的 id 只能是**各自主人**那条 ✓（跑错机器就是这几条红 ✓）──
    const aReport = hostA.seen.find((entry) => entry.endpoint === 'mobile/device/result')
    const bReport = hostB.seen.find((entry) => entry.endpoint === 'mobile/device/result')
    assert.ok(aReport !== undefined && bReport !== undefined, '两台都必须收到回报 ✓')
    assert.equal((aReport.payload['args'] as Record<string, unknown>)['id'], callA.id, '★ A 回报的必须是 **A 那条** ✓')
    assert.equal((bReport.payload['args'] as Record<string, unknown>)['id'], callB.id, '★ B 回报的必须是 **B 那条** ✓')
    assert.ok(!JSON.stringify(hostA.seen).includes(callB.id), '★ A 那台绝不许看到 B 那条 ✓')
    assert.ok(!JSON.stringify(hostB.seen).includes(callA.id), '★ B 那台绝不许看到 A 那条 ✓')
    /**
     * ★★ 最直白的那一条判据 ✓：**每一轮取到的那几条，正文只能是它自己那台压的那条** ✓
     *   （上面那几条按 id ✓，这一条按**正文** ✓ —— 两个口径互相独立 ✓）。
     */
    const callsTakenBy = (host: SideWorldHost): string[] => {
      const entry = host.seen.find((item) => item.endpoint === 'mobile/device/pending')
      const value = (entry?.response ?? {}) as { value?: { calls?: Array<{ text?: string }> } }
      return (value.value?.calls ?? []).map((call) => String(call.text ?? ''))
    }
    assert.deepEqual(callsTakenBy(hostA), ['A 那条提醒'], '★ A 取到的必须**只有 A 那条** ✓')
    assert.deepEqual(callsTakenBy(hostB), ['B 那条提醒'], '★ B 取到的必须**只有 B 那条** ✓')

    // ── ③ 两条队列都**真的**被取空并回报完 ✓（真 `DeviceCallQueue` 的语义 ✓）──
    assert.equal(hostA.queue.pendingCount(), 0, '★ A 那条必须已经被取走并回报 ✓')
    assert.equal(hostB.queue.pendingCount(), 0, '★ B 那条必须已经被取走并回报 ✓')
    assert.equal(hostA.queue.getResult(callA.id)?.ok, true, '★ A 那边记下的结果必须是 ok ✓')
    assert.equal(hostB.queue.getResult(callB.id)?.ok, true, '★ B 那边记下的结果必须是 ok ✓')

    // ── ④ 生产读数：只挂一条、去的是 B、真的连上了 ✓ ──
    const side = surface.boot.sideChannels()
    assert.equal(side.length, 1, '★ 只许挂**一条**旁挂 ✓（当前那台 = A 必须被跳过 ✓）')
    assert.equal(side[0]!.fingerprint, hostB.fingerprint, '★ 旁挂那条去的必须是**别的**电脑 ✓')
    assert.equal(side[0]!.state, 'connected', '★ 旁挂那条真的连上了 ✓')
    assert.equal(side[0]!.activeEndpoint, 'wss://' + SIDE_HOST_B + '/mobile/ws', '★ 而且端点只用了 B 自己的地址 ✓')
    assert.ok(side[0]!.polls >= 1, '★ 这一轮真的驱动过它 ✓')
    assert.equal(side[0]!.rejected, false, '★ 没有被拒绝 ✓')

    // ── ⑤ 两边身份都在 ✓（灾难闸：谁都没被清 ✓）──
    assert.notEqual(surface.storage.get('dsh-mobile.device-key:' + hostA.fingerprint), undefined, '★ 当前那台（A）的身份必须还在 ✓')
    assert.notEqual(surface.storage.get('dsh-mobile.device-key:' + hostB.fingerprint), undefined, '★ B 的身份也必须还在 ✓')
    assert.equal(surface.boot.tunnel?.sessionId !== undefined, true, '★ 主隧道（A）必须仍然活着 ✓（没被旁挂顶掉 ✓）')
  } finally {
    dirs.push(join(tmpdir(), 'dsh-mobile-side-a-'), join(tmpdir(), 'dsh-mobile-side-b-'))
    cleanup()
  }
})

/* ════════════════════════════════════════════════════════════════════════════
 * ★★ 本轮（性能）：`/mobile/app` 上那个「**每次 DOM 变动就扫全文档**」的放大器
 *
 * 用户现场（原话 ✓）：「目前我在使用**手机端**的时候，感觉当**聊天渲染了很多公式**
 * 会**非常卡** ✗，这**正常吗** ✓？」
 *
 * 量出来的根因 ✓（上一单的读数 ✓，不重做 ✗）：`MutationObserver`（`childList+subtree` ✓）在
 * **每一次 DOM 变动后的那一帧**就调 `syncDshPreviewState()` ✓，而它**第一句**就是
 * `dshPreviewSurface()` ✓ —— **无条件扫全文档两趟** ✓（`.katex` ✓ + 属性子串选择器 ✓），
 * 再对**每一颗** `.katex` 沿祖先链走一遍 ✓ ⇒ **公式越多 / 会话越长，这一趟越贵** ✓
 * （实测 772 公式 / 24,937 节点：0.74ms（1x）/ 3.15ms（4x）/ 6.7ms（8x）✓ ——
 * 8x 时 = **每帧 16.7ms 里的四成** ✗，而它前面还有 DSH 的 markdown + KaTeX + React + 布局 ✓）。
 *
 * 这一组钉三件事 ✓（**每个方向都要能被打红** ✓）：
 *   ① 不像预览层的变动 ⇒ **一趟全文档扫描都不许跑** ✓（流式时最常进来的文本节点就是这个形状 ✓）；
 *   ② 像的变动 ⇒ **必须立刻扫** ✓（`_preview` / `_document` / 预览层**里面**的 `.katex` ✓、
 *      以及**摘掉**预览层那一笔 ✓）—— 识别能力**不许降级** ✗；
 *   ③ 结构上：观察器**先判类再排帧** ✓、判类那一趟**绝不许查全文档** ✓、
 *      200ms 心跳**仍在** ✓（兜底不许删 ✗ —— 识别最坏延迟就等于它 ✓）、
 *      `tuneComposerScroll` 有签名判断 ✓ 且它在逐层 `getComputedStyle` **之前** ✓。
 *
 * ★ 判据纪律（本项目的头号教训：**假判据** ✓）：断言只打在**可执行代码形状**与
 *   **调用次数**上 ✓（注释行先滤掉 ✓）；性能证据是**扫描次数** / **逐层量样式的次数** ✓——
 *   **不是**"代码看起来省了" ✗。★ 而且"数次数 = 数扫描次数"这件事由下面第一条**自检**兜住 ✓。
 * ════════════════════════════════════════════════════════════════════════════ */

test('★ 判据自检：全文件只有一处扫 `.katex` ⇒「数次数」就等于「数扫描次数」', () => {
  /**
   * 下面那几条"扫了几次"的判据数的是 `document.querySelectorAll('…katex…')` 的**调用次数** ✓。
   * 这条自检保证那个等式成立 ✓：全文件只有 `dshPreviewSurface()` 的**起手**会扫 `.katex` ✓
   * （它每次调用都必然先走这一句 ✓）。多出第二处 ⇒ 计数就失真了 ✗ ⇒ 这条先红 ✓。
   */
  assert.equal(
    executableOnly(bootSource).split("document.querySelectorAll('.katex')").length - 1,
    1,
    '★ 全文件只许有一处扫 `.katex`（= `dshPreviewSurface` 的起手 ✓）—— 计数判据靠它成立 ✓',
  )
})

test('★★ 结构：观察器先判类再排帧、判类那趟不查全文档、200ms 心跳仍在', () => {
  /** 这一段 = 判类守卫 + 观察器 + 三条 200ms/250ms 心跳 ✓（锚点全是纯 ASCII ✓）。 */
  const region = executableOnly(
    sourceRegionBetween(bootSource, 'var PREVIEW_LAYER_CLASS =', 'setInterval(liftPopupsOverKeyboard, 250)'),
  )

  // ── ① 观察器必须把 `MutationRecord` **递进**生产回调（否则没法按变动判类 ✗）──
  assert.match(
    region,
    /new MutationObserver\(function \(records\) \{\s*runPreviewWatch\(records\)\s*\}\)\.observe\(document\.body, \{ childList: true, subtree: true \}\)/,
    '★ 观察器必须把 MutationRecord 递给回调 ✓（原来是无条件 `new MutationObserver(runPreviewWatch)` ✗）',
  )

  // ── ② 守卫必须在「排帧」之前、扫描之前 ──
  const guardAt = region.indexOf('if (!mutationLooksLikePreview(records)) return')
  const frameAt = region.indexOf('requestAnimationFrame(')
  const scanAt = region.indexOf('syncDshPreviewState()')
  assert.ok(
    guardAt >= 0,
    '★ 回调里必须有"不像就不扫"的守卫 ✓（"一有变动就扫全文档"正是本轮要修的那件 ✗）',
  )
  assert.ok(frameAt > guardAt, '★ 守卫必须在**排帧之前** ✓（排在后面 = 每一帧还是照扫 ✗）')
  assert.ok(scanAt > frameAt, '★ 那一扫必须在守卫之后 ✓')
  assert.equal(
    region.split('syncDshPreviewState()').length - 1,
    1,
    '★ 这一段里只许有**一处**调扫描 ✓（在守卫之后 ✓ —— 多一处就是又冒出一条无条件扫 ✓）',
  )

  // ── ③ 兜底：那条 200ms 心跳**必须在**（它现在是识别的最坏延迟 ✓）──
  assert.ok(
    /setInterval\(syncDshPreviewState, 200\)/.test(region),
    '★ 那条 200ms 心跳**绝不能删** ✗ —— 识别的最坏延迟就等于它 ✓',
  )

  // ── ④ 判类那一趟**绝不许查全文档**（它必须只 O(变动) ✓）──
  const guardRegion = executableOnly(
    sourceRegionBetween(bootSource, 'var PREVIEW_LAYER_CLASS =', 'var previewWatchQueued = false'),
  )
  assert.ok(
    !guardRegion.includes('document.querySelectorAll'),
    '★ 判类不许查全文档 ✗（那等于把放大器原样留下 ✓）',
  )
  assert.ok(
    !guardRegion.includes('document.querySelector('),
    '★ 判类也不许从文档里找东西 ✓（只看 MutationRecord 递过来的节点 ✓）',
  )
  assert.ok(
    guardRegion.includes('addedNodes') && guardRegion.includes('removedNodes'),
    '★ 判据必须真的来自 `MutationRecord` 的 `addedNodes` / `removedNodes` ✓',
  )
})

test('★★ 结构：`tuneComposerScroll` 有"输入区没变就不跑"的签名判断，且在逐层 getComputedStyle 之前', () => {
  const body = executableOnly(functionBodyAtColumn2(bootSource, 'tuneComposerScroll'))
  const guardAt = body.indexOf('chainLooksSame(')
  const styleAt = body.indexOf('getComputedStyle(')
  assert.ok(guardAt >= 0, '★ 签名判断必须真的在 ✓（否则那 200ms 心跳每趟都沿祖先链逐层量样式 ✗）')
  assert.ok(styleAt >= 0, '夹具自检：逐层 `getComputedStyle` 仍在 ✓（只是挪到签名之后 ✓）')
  assert.ok(guardAt < styleAt, '★ 签名判断必须在**逐层 getComputedStyle 之前** ✓（排在后面 = 一次都没省 ✗）')
  assert.ok(body.includes('composerScrollChain = chain'), '★ 真的跑成了才记签名 ✓（不记 ⇒ 下一趟又从头量 ✗）')
  assert.ok(
    body.includes('composerScrollKey = chainKey'),
    '★ 签名的**两半都要记下来** ✓（漏了类名那半 ⇒ 每趟都不相等 ⇒ 一次都没省 ✗ —— 这一条就是实测抓到的那个坑 ✓）',
  )
  assert.ok(
    body.includes("chainKey += String(probe.className || '')"),
    '★ 类名也要进签名 ✓（DSH 在**同一个节点上换类** ⇒ 结论会变 ⇒ 必须重跑 ✓）',
  )
  // ★ 修性能**不许**靠"把这条心跳删掉" ✗（那会连带丢掉"DSH 重渲染后补标记"✓）
  assert.ok(
    executableOnly(bootSource).includes('setInterval(tuneComposerScroll, 200)'),
    '★ 输入区那条 200ms 心跳必须仍在 ✓（本轮只是让它先比签名 ✓）',
  )
})

test('★★ 行为（负）：变动里没有预览类节点 ⇒ 一趟全文档扫描都不许跑（聊天里的 `.katex` 正是这个形状）', () => {
  const surface = bootOnSurface({ pathname: '/mobile/app', innerWidth: 412, consent: [], previewWatchProbe: true })
  assert.equal(surface.thrown.length, 0, `顶层不应抛错：${String(surface.thrown[0])}`)
  /**
   * ★ 用 `findPreviewWatcher` 挑**预览那条** ✓ —— 不是"随便一条 childList+subtree" ✗
   *   （那条路会拿到设置面板/模型菜单的观察器 ⇒ 下面"没扫"变**假绿** ✓，见它的注释 ✓）。
   */
  const watcher = findPreviewWatcher(surface)
  const before = surface.previewScans()

  // ── 造三种"聊天在流式渲染"的变动（**都不在预览层里** ✓）──
  //   ① 流式时最常见的一笔：一个**文本节点**（`nodeType: 3` ✓）
  const textNode = makeProbeNode('#text', '', { nodeType: 3, textContent: '一' })
  //   ② 一条新消息的容器（里面带公式 ✓ —— 聊天里的 `.katex` ✓）
  const message = makeProbeNode('div', 'ds-markdown')
  const messageKatex = message.appendChild(makeProbeNode('span', 'katex'))
  //   ③ 单独插进来的一颗公式（DSH 增量渲染时的形状 ✓）
  const loneKatex = makeProbeNode('span', 'katex')

  const framesBefore = surface.frames.length
  watcher.callback([{ addedNodes: [message], removedNodes: [] }])
  watcher.callback([{ addedNodes: [messageKatex], removedNodes: [] }])
  watcher.callback([{ addedNodes: [loneKatex], removedNodes: [] }])
  watcher.callback([{ addedNodes: [textNode], removedNodes: [] }])

  assert.equal(surface.frames.length, framesBefore, '★ 不像 ⇒ 连一帧都不该排 ✓（排了就一定会扫 ✗）')
  surface.flushFrames()
  assert.equal(
    surface.previewScans() - before,
    0,
    '★ 变动里没有预览类节点 ⇒ **一趟全文档扫描都不许跑** ✗（这一笔就是用户"非常卡"里的开销 ✓）',
  )
})

test('★★ 行为（正）：`_preview` / `_document` / 预览层里的 `.katex` / 摘掉预览层 ⇒ 必须立刻扫', () => {
  const surface = bootOnSurface({ pathname: '/mobile/app', innerWidth: 412, consent: [], previewWatchProbe: true })
  const watcher = findPreviewWatcher(surface)

  // ── ① 预览层**自己**进来（类名后缀 `_preview` ✓ —— 实测就是这个形状 ✓）──
  let before = surface.previewScans()
  watcher.callback([{ addedNodes: [makeProbeNode('div', 'dhJKeW_preview')], removedNodes: [] }])
  surface.flushFrames()
  assert.equal(surface.previewScans() - before, 1, '★ 预览层进来 ⇒ 必须扫 ✓')

  // ── ② 预览层**已经在**了，只是里面的公式被换成了新的（`.katex` ✓ + 祖先链上有 `_document` ✓）──
  const docLayer = makeProbeNode('div', '0RKuNG_document')
  const holder = makeProbeNode('div', '_markdown_abc')
  docLayer.appendChild(holder)
  holder.appendChild(makeProbeNode('span', 'katex'))
  before = surface.previewScans()
  watcher.callback([{ addedNodes: [holder], removedNodes: [] }])
  surface.flushFrames()
  assert.equal(surface.previewScans() - before, 1, '★ 预览层**里面**的公式变了 ⇒ 必须扫 ✓')

  // ── ③ 摘掉预览层（用户关掉预览 ✓）⇒ 也要立刻认出来 ──
  before = surface.previewScans()
  watcher.callback([{ addedNodes: [], removedNodes: [docLayer] }])
  surface.flushFrames()
  assert.equal(surface.previewScans() - before, 1, '★ 摘掉预览层 ⇒ 必须扫 ✓（"关掉了"要立刻认出来 ✓）')
})

test('★★ 行为：输入区没变 ⇒ 那 200ms 心跳不再逐层 getComputedStyle（调用次数为证）', () => {
  const surface = bootOnSurface({ pathname: '/mobile/app', innerWidth: 412, consent: [], composerProbe: true })
  assert.equal(surface.thrown.length, 0, `顶层不应抛错：${String(surface.thrown[0])}`)
  /**
   * ★ 用**生产那条心跳本体**（`setInterval(tuneComposerScroll, 200)` 递进去的就是这个函数 ✓）——
   *   不是另抄一份复制品 ✓。
   */
  const tick = surface.intervals.find((fn) => fn.name === 'tuneComposerScroll')
  assert.ok(tick !== undefined, '★ 输入区那条 200ms 心跳必须仍在 ✓')
  const nodes = surface.composerProbeNodes()
  assert.ok(nodes !== null, '夹具：假输入区应当建好了 ✓')

  const before = surface.composerStyleProbes()
  tick()
  const firstPass = surface.composerStyleProbes() - before
  assert.ok(
    firstPass >= 2,
    `第一趟必须真的逐层量过 ✓（实测 ${String(firstPass)} 次 ⇒ 少于 2 次说明判据/夹具不成立 ✗）`,
  )
  // ★ 功能侧也不许降级：这一趟该写下的标记必须真的写上了 ✓
  assert.equal(
    nodes.layer.dataset['dshmComposerScroller'],
    'v2',
    '★ 限高必须仍然落在**真的会滚的那一层**上 ✓（判据形状照生产 ✓）',
  )
  assert.equal(
    nodes.input.style['overscrollBehaviorY'],
    'contain',
    '★ 输入框那一层的 `contain` 必须仍然写上 ✓',
  )

  // ── ★ 输入区一个字都没动 ⇒ 后面每一趟**一次都不许再量** ──
  tick()
  tick()
  tick()
  assert.equal(
    surface.composerStyleProbes() - before,
    firstPass,
    '★ 输入区没变 ⇒ 后续心跳一次 `getComputedStyle` 都不许再跑 ✗',
  )

  // ── ★ 反向：DSH 把输入框重渲染了 ⇒ 必须重新逐层量（该补的标记一件都不许漏 ✓）──
  surface.composerRerender()
  tick()
  assert.ok(
    surface.composerStyleProbes() - before > firstPass,
    '★ 输入元素被换掉 ⇒ 必须重新量一遍 ✓（签名把"变了"认出来了 ✓）',
  )
  assert.equal(
    surface.composerProbeNodes()?.input.style['overscrollBehaviorY'],
    'contain',
    '★ 换上来那个新输入框也要被标上 `contain` ✓（不许漏 ✓）',
  )
})

/* ════════════════════════════════════════════════════════════════════════════
 * ★★ round 215：进子智能体会话之后**没有任何方式回到主会话** ✗
 *
 * 用户现场（原话 ✓）：「查看子智能体的时候，★ **没有任何方式回到对应的主智能体** ✗……
 *   **退出 APP 再重进也不能刷新掉** ✗，**这是很恐怖的** ✓。」
 *
 * 根因（上一单已查清 ✓，这里只用它 ✓，不重查 ✗）：`localStorage["dsh.sessions.current"]`
 * 里存着 `{sessionId, subagentAddress}` ✓，DSH 每次加载都会**按它恢复子单** ✓；
 * 而我们这一侧的三处判据里**都没有"DSH 右侧栏面板开着"这一层** ✗：
 *   ① `backAvailableNow()` —— 壳先问它 ✓，为假 ⇒ 返回键**到不了网页** ⇒ `finish()` = 退出 App ✗；
 *   ② `dshmBack()` 的梯子 —— 少一层 ⇒ 那一下没人吃 ✓；
 *   ③ `clickDshCollapseControl()` 的 scope 只认预览层 ✗ ⇒ 面板里那颗「收起右侧边栏」
 *      要么找不到 ✓、要么（退回全文档扫时）**找错**✓（round 118 那个事故的形状 ✓）。
 *
 * 这一组钉三件事 ✓（**每个方向都要能被打红** ✓ —— 变异对照写在交付说明里 ✓）：
 *   ① 结构：判据里有那一层 ✓、动作走的是既有的收起控件 ✓、**标签表一个字没动** ✓；
 *   ② 结构：顶栏那颗「回到主会话」存在 ✓ + 动作**同时**做两件事 ✓ +
 *      `z-index` **高于**面板那一列 ✓（"不可能被盖住"的机械保证 ✓）；
 *   ③ 行为：面板开着 ⇒ 上报"可返回"为真 ✓；按一次返回 ⇒ 点了收起控件 + 面板标记消失 ✓；
 *      按那颗顶栏键 ⇒ **两件事都真的发生** ✓；它在子单层级显示 ✓、主单**不显示** ✓。
 *
 * ★ 判据纪律（本项目头号教训：**假判据** ✓）：只打**可执行代码形状**与**真实副作用** ✓
 *   （注释整行先滤掉 ✓）；"面板开着"这个态由**夹具真的造出来** ✓（不是靠一个字符串 ✓）。
 * ════════════════════════════════════════════════════════════════════════════ */

/**
 * ★★ round 215：一个**最小假壳** ✓ —— 只为拿 `setBackAvailable` 那一条上报 ✓
 *   （形状照本项目既有的 `makeVaultShell` ✓，只留这一轮要用的 ✓）。
 * `pushes` 是外面传进来的数组 ✓ ⇒ 断言直接看"壳收到了什么"✓（= 用户在真机上按返回时的判据 ✓）。
 */
function makeBackShell(pushes: boolean[]): Record<string, unknown> {
  return {
    version: () => 'test-shell-back',
    setBackAvailable: (value: unknown) => {
      pushes.push(value === true)
    },
    backAvailable: () => {},
    insets: () => JSON.stringify({ seen: false }),
    platform: () => JSON.stringify({ android: 34 }),
    endpoints: () => JSON.stringify({ slots: [], timeoutMs: 2000 }),
    vaultGet: () => JSON.stringify({}),
    vaultSet: () => {},
    notify: () => {},
    onResume: () => {},
  }
}

/**
 * ★★ round 215：取一条 CSS 规则的正文 ✓（起点 = 那条规则的选择器串 ✓，
 *   终点 = 它自己那一行 `'}'` ✓）。两个锚点都是**纯 ASCII** ✓。
 * ★ 为什么需要 ✗：本轮的机械保证是**两条 CSS 规则的 z-index 比大小** ✓ ——
 *   正则满文件乱找会撞上"别处的 z-index"✗（右栏那条 `!important` 在文件里有**两条** ✓：
 *   基态 25 ✓ 与预览态 190 ✓）⇒ 必须先**圈定规则**、再取值 ✓。
 */
function cssRuleBody(source: string, selectorLiteral: string): string {
  const start = source.indexOf(selectorLiteral)
  assert.ok(start >= 0, '必须能找到 CSS 规则：' + selectorLiteral)
  const end = source.indexOf("\n      '}',", start)
  assert.ok(end > start, 'CSS 规则的结束那一行应当能在第 6 列找到：' + selectorLiteral)
  return source.slice(start, end)
}

test('★★ 结构：返回键判据里有「DSH 右侧栏面板」那一层，动作走既有的收起控件', () => {
  const code = executableOnly(bootSource)

  // ── ① 判据本体：那个**语义属性**（与 `dshPreviewMinimizedNotClosed` 同一个 ✓，不是哈希类名 ✗）──
  assert.ok(
    code.includes("document.querySelector('[data-sidebar-right-panel][data-sidebar-right-open]')"),
    '★ 认"面板开着"必须用那个语义属性 ✓（哈希类名会随构建变 ✗）',
  )
  const panelFn = executableOnly(functionBodyAtColumn2(bootSource, 'dshRightPanelOpen'))
  assert.ok(
    panelFn.includes("'[data-sidebar-right-panel][data-sidebar-right-open]'"),
    '★ `dshRightPanelOpen()` 必须是那份判据的唯一落点 ✓',
  )

  // ── ② `backAvailableNow()` 里必须真的调它 ✗✗（壳先问它 ✓ —— 漏了 ⇒ 返回键到不了网页 ⇒ 退出 App ✗）──
  const available = executableOnly(functionBodyAtColumn2(bootSource, 'backAvailableNow'))
  assert.ok(
    available.includes('dshRightPanelOpen()'),
    '★ `backAvailableNow()` 必须把"面板开着"算成可返回 ✓（漏了 ⇒ 返回键根本进不了网页 ✗）',
  )

  // ── ③ `dshmBack()` 的梯子里必须有这一支，而且动作是**点 DSH 自己那颗收起键** ✓ ──
  const back = executableOnly(functionBodyAtColumn2(bootSource, 'dshmBack'))
  const guardAt = back.indexOf('if (dshRightPanelOpen())')
  // ★ 从那一支**往下**找 ✓ —— `dshmBack` 里"预览"那一支**也**调 `clickDshCollapseControl()` ✓，
  //   从函数头开始找会拿到**上面**那一处 ✗（这一句我自己当场踩到过 ✓）。
  const clickAt = back.indexOf('clickDshCollapseControl()', guardAt)
  assert.ok(guardAt >= 0, '★ 返回键梯子里必须有"面板开着"这一支 ✓（否则那一下没人吃 ✗）')
  assert.ok(clickAt > guardAt, '★ 这一支的动作必须是点 DSH 自己那颗「收起右侧边栏」✓（不许自己猜关闭方式 ✗）')
})

test('★★ 结构：收起控件的搜索范围含「右侧栏面板」，而标签表一个字没动', () => {
  const body = executableOnly(functionBodyAtColumn2(bootSource, 'clickDshCollapseControl'))

  // ── ① scope 必须收成一条名单，且**含右侧栏面板** ✓ ──
  assert.ok(body.includes('var scopes = []'), '★ scope 应当收成一条名单 ✓（预览层 ∪ 面板 ✓）')
  assert.ok(
    body.includes("document.querySelector('[data-sidebar-right-panel][data-sidebar-right-open]')"),
    '★ scope 里必须有右侧栏面板 ✓（子单那一屏**过不了**预览层那两条判据 ✗ ⇒ 少了它就够不到 ✓）',
  )
  assert.ok(body.includes('scopes.push('), '★ 两个 scope 都要真的进名单 ✓（只算不 push = 白算 ✗）')
  assert.ok(
    !body.includes('var scope = hitLayer'),
    '★ 原来那条"scope 就是预览层"的写法必须已经不在了 ✓（留着就还是够不到面板 ✗）',
  )

  // ── ② ★ 标签表**逐字**保持原样 ✗（本轮只许改搜索范围 ✓）──
  const labelsAnchor = [
    'var labels = [',
    '      /^关闭$/,',
    '      /^close$/i,',
    '      /收起右侧边栏/,',
    '      /收起侧边栏/,',
    '      /收起侧栏/,',
    '      /collapse (right )?(sidebar|panel)/i,',
    '    ]',
  ].join('\n')
  assert.ok(bootSource.includes(labelsAnchor), '★ 标签表必须逐条逐字不变 ✓（本轮一个字都不许动 ✗）')
})

test('★★ 结构：顶栏那颗「回到主会话」存在、动作两半都在、且 z-index 压得住面板', () => {
  const code = executableOnly(bootSource)

  // ── ① 存在 ✓，而且挂在**顶栏**里 ✓ ──
  assert.ok(
    code.includes("shellIconButton('dsh-mobile-back-main', '回到主会话', ICON_BACK_MAIN)"),
    '★ 那一颗必须真的建出来 ✓（同一个 `shellIconButton` ✓，不是另起一套 ✓）',
  )
  assert.ok(code.includes('bar.appendChild(backToMain)'), '★ 而且必须挂在**顶栏**里 ✓（挂别处 ⇒ 会被面板盖住 ✗）')

  // ── ② 显/隐的判据 = 面包屑 ≥ 2 格，而且与"退回上一级"**共用同一份判据** ✓ ──
  // ★ 它是 `installShell` 里的**第二层**函数（4 列缩进 ✓）⇒ 用 `innerFunctionBody` ✓
  //   （`functionBodyAtColumn2` 只认 2 列那一档 ✓ —— 拿错会报"boot.js 里应当有 …"✗）
  const sync = innerFunctionBody(bootSource, '    function syncBackToMainButton() {')
  assert.ok(sync.includes('subagentCrumbSegs()'), '★ 显/隐判据必须与"退回上一级"同一份 ✓（两套实现迟早漂 ✗）')
  assert.ok(sync.includes('segs.length >= 2'), '★ 判据 = 面包屑 ≥ 2 格 ✓（= 此刻在子单层级里 ✓）')
  assert.ok(sync.includes('backToMain.dataset.dshmShown'), '★ 结论必须**写进 DOM** ✓（否则 CSS 无从生效 ✗）')

  // ── ③ ★ 动作里**两半**都要在 ✓（少任何一半 ⇒ 用户看到的都是"回不去"✗）──
  const handlerStart = code.indexOf("backToMain.addEventListener('click'")
  assert.ok(handlerStart >= 0, '★ 那颗键必须有 click 处理 ✓')
  const handlerEnd = code.indexOf('reportBackAvailable()', handlerStart)
  assert.ok(handlerEnd > handlerStart, '★ 那个处理必须先把两件事做完、再上报 ✓')
  const handler = code.slice(handlerStart, handlerEnd)
  assert.ok(handler.includes('clickDshCollapseControl()'), '★ 第一半：**关掉右侧栏面板** ✓（少了它 ⇒ 面板还整屏盖着 ✗）')
  assert.ok(
    handler.includes('backOutOfSubagentSession(true)'),
    '★ 第二半：**退出子单那一层** ✓（少了它 ⇒ 面板关了人还在子单里 ✗）',
  )
  assert.ok(
    handler.indexOf('clickDshCollapseControl()') < handler.indexOf('backOutOfSubagentSession(true)'),
    '★ 顺序固定：先关面板、再退层级 ✓（反过来 ⇒ 面板还盖着，看不出退没退 ✗）',
  )

  // ── ④ ★★ 机械保证：顶栏的 z-index **严格高于**面板那一列 ✓ ──
  const topZRaw = /z-index:\s*(\d+)/.exec(cssRuleBody(bootSource, "'#dsh-mobile-top {'"))
  assert.ok(topZRaw !== null, '★ 顶栏那条 CSS 规则里必须有 z-index ✓')
  const panelZRaw = /\[class\*="rightbarCol"\] \{ z-index: (\d+) !important; \}/.exec(code)
  assert.ok(panelZRaw !== null, '★ 右侧栏那一列的**基态** z-index 规则必须仍在 ✓')
  const topZ = Number(topZRaw?.[1] ?? NaN)
  const panelZ = Number(panelZRaw?.[1] ?? NaN)
  assert.ok(Number.isFinite(topZ) && Number.isFinite(panelZ), '夹具自检：两个 z-index 都要能取到数 ✓')
  assert.ok(
    topZ > panelZ,
    `★ 顶栏 z-index(${String(topZ)}) 必须**严格高于**面板那一列(${String(panelZ)}) ✓ —— 这就是"那颗键不可能被面板盖住"的机械保证 ✓（把它改小 ⇒ 本条红 ✓）`,
  )
})

test('★★ 行为：面板开着 ⇒ 壳收到"可返回=true"；面板关着 ⇒ false（同一套 DOM，只差那个属性）', () => {
  /**
   * ★ 量的是**壳真的收到了什么** ✓（`installBackHook()` 里那次 `reportBackAvailable(true)` ✓）——
   *   它就是真机上 `MainActivity.handleBackPressed` 据以决定"这一下吃掉还是退出"的那个量 ✓。
   * ★ 而且它**不依赖任何定时器** ✓（启动那一刻同步上报 ✓）。
   */
  const openPushes: boolean[] = []
  const open = bootOnSurface({
    pathname: '/mobile/app',
    innerWidth: 412,
    consent: [],
    shell: makeBackShell(openPushes),
    dshBackProbe: { crumbs: 0, panelOpen: true },
  })
  assert.equal(open.thrown.length, 0, `顶层不应抛错：${String(open.thrown[0])}`)
  assert.equal(
    openPushes[0],
    true,
    '★ 面板开着 ⇒ 必须上报"可返回=true" ✓（报 false 的那一下，壳会直接 finish() = 退出 App ✗）',
  )

  // ── ★ 反向：**逐字相同**的一套 DOM，只把面板那个属性拿掉 ⇒ 必须是 false ✓ ──
  const shutPushes: boolean[] = []
  const shut = bootOnSurface({
    pathname: '/mobile/app',
    innerWidth: 412,
    consent: [],
    shell: makeBackShell(shutPushes),
    dshBackProbe: { crumbs: 0, panelOpen: false },
  })
  assert.equal(shut.thrown.length, 0, `顶层不应抛错：${String(shut.thrown[0])}`)
  assert.equal(
    shutPushes[0],
    false,
    '★ 面板关着、又不在子单层级 ⇒ 不许虚报可返回 ✓（虚报 ⇒ 返回键被白吃一下、用户以为坏了 ✗）',
  )
})

test('★★ 行为：按一次返回 ⇒ 点了 DSH 那颗收起键、面板标记随之消失', () => {
  const pushes: boolean[] = []
  const surface = bootOnSurface({
    pathname: '/mobile/app',
    innerWidth: 412,
    consent: [],
    shell: makeBackShell(pushes),
    dshBackProbe: { crumbs: 0, panelOpen: true },
  })
  const tree = surface.dshBack()
  assert.ok(tree !== null, '夹具：假 DSH 树应当建好了 ✓')
  const back = surface.back()
  assert.ok(back !== undefined, '★ 有壳时必须装上 `window.__dshmBack` ✓（壳的返回走的就是它 ✓）')

  assert.equal(back(), true, '★ 面板开着 ⇒ 这一下必须被网页吃掉 ✓（返回 false 就是壳退出 App ✗）')
  assert.equal(tree.collapseClicks(), 1, '★ 必须点的是 **DSH 自己那颗「收起右侧边栏」** ✓（不是我们猜的关闭方式 ✗）')
  assert.equal(
    tree.panel.hasAttribute('data-sidebar-right-open'),
    false,
    '★ 收起之后那个标记必须消失 ✓（= 屏幕回到主会话那一层 ✓）',
  )
  assert.equal(pushes[pushes.length - 1], false, '★ 面板没了 ⇒ 这一下之后上报必须是 false ✓（否则返回键会被连续白吃 ✗）')

  // ── ★ 反向：面板已经关了 ⇒ 这一下必须**交还壳** ✓，而且**不许**再点一次 ✓ ──
  assert.equal(back(), false, '★ 面板关了、又不在子单层级 ⇒ 必须交还壳 ✓（吃掉它就等于"返回键失灵"✗）')
  assert.equal(tree.collapseClicks(), 1, '★ 面板已经关了 ⇒ 不许再点一次收起键 ✓')
})

test('★★ 行为：按那颗「回到主会话」⇒ 面板收起 + 真的退了一层（两半都发生）', () => {
  const surface = bootOnSurface({
    pathname: '/mobile/app',
    innerWidth: 412,
    consent: [],
    shell: makeBackShell([]),
    dshBackProbe: { crumbs: 2, panelOpen: true },
  })
  const tree = surface.dshBack()
  assert.ok(tree !== null, '夹具：假 DSH 树应当建好了 ✓')
  const button = surface.backToMain()
  assert.ok(button !== null, '★ 顶栏那颗必须真的建出来了 ✓')

  /**
   * ★ 用**生产自己挂上去的那个回调** ✓（夹具把 `addEventListener` 记下来了 ✓）——
   *   不是测试另调一遍 `clickDshCollapseControl()` ✗（那就测不到"那颗键挂对了没有"✓）。
   */
  const listeners = (button['listeners'] as Record<string, Array<(event?: unknown) => void>>)['click'] ?? []
  assert.equal(listeners.length, 1, '★ 那颗键必须恰好挂了一个 click 处理 ✓')
  for (const run of listeners) run(undefined)

  assert.equal(tree.collapseClicks(), 1, '★ 第一半：必须收起面板 ✓（少了它 ⇒ 面板还整屏盖着、看起来"什么都没发生"✗）')
  assert.equal(
    tree.panel.hasAttribute('data-sidebar-right-open'),
    false,
    '★ 收起之后那个标记必须消失 ✓',
  )
  assert.equal(
    tree.crumbClicks(),
    1,
    '★ 第二半：必须真的点了**上一级那一格** ✓（少了它 ⇒ 面板关了、人还在子单里 ✗）',
  )
})

test('★★ 行为：那颗顶栏键只在子单层级显示（子单 = 显示 ✓；主单 = 不显示 ✗，两个方向都验）', () => {
  // ── ① 子单层级（面包屑 2 格 ✓）⇒ 必须显示 ──
  const deep = bootOnSurface({
    pathname: '/mobile/app',
    innerWidth: 412,
    consent: [],
    shell: makeBackShell([]),
    dshBackProbe: { crumbs: 2, panelOpen: true },
  })
  const deepButton = deep.backToMain()
  assert.ok(deepButton !== null, '★ 顶栏那颗必须真的建出来了 ✓')
  assert.equal(
    /**
     * ★ 读的是**生产自己写下的那个 `dataset` 键** ✓（`backToMain.dataset.dshmShown` ✓）——
     *   真 DOM 里它同时就是 `data-dshm-shown` 属性 ✓（CSS 那条规则读的正是它 ✓）；
     *   夹具这两者不互通 ✓，所以这里读 dataset ✓（读 `attrs` 会恒为 undefined ✗ = 假红 ✓）。
     */
    (deepButton['dataset'] as Record<string, string>)['dshmShown'],
    '1',
    '★ 在子单层级里必须显示 ✓（它就是"永远回得去"那条保证 ✓）',
  )

  // ── ② 主单（面包屑 1 格 ✓）⇒ 必须不显示 ──
  const root = bootOnSurface({
    pathname: '/mobile/app',
    innerWidth: 412,
    consent: [],
    shell: makeBackShell([]),
    dshBackProbe: { crumbs: 1, panelOpen: false },
  })
  const rootButton = root.backToMain()
  assert.ok(rootButton !== null, '★ 顶栏那颗必须真的建出来了 ✓')
  assert.equal(
    (rootButton['dataset'] as Record<string, string>)['dshmShown'],
    '0',
    '★ 主单上必须**不显示** ✗（常驻一颗按下去什么都不发生的键 = 用户以为它坏了 ✗）',
  )
})
