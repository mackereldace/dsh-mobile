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
  }
  /**
   * ★ round 185 追加：`__DSH_MOBILE_BOOT__` ✓ —— 取证读数走它的 `.apk.deviceCallLog()` ✓
   *   （那正是主线用 adb + CDP 念的**同一个**入口 ✓，不是测试专用口 ✓）。
   */
  boot: {
    apk: {
      deviceCallLog: () => DeviceCallLogEntry[]
      /**
       * ★ 本轮追加：「会话与智能体」那一组 ✓（**生产渲染函数** `buildAgentsGroup` ✓ ——
       *   与 `hostsPanel` 同一个写法 ✓：断言打在"面板真的画了什么"上 ✓，不打在复制品上 ✓）。
       *   `group` 会**自己**在数据落地后原地重画 ✓ ⇒ 断言可以打在同一棵元素上 ✓。
       */
      agentsPanel: (getTunnel?: () => unknown) => { model: Record<string, unknown>; group: FakeElement }
      /** ★ 本轮追加：这一组的口径读数 ✓（超时 / 重试上限 / 缓存 / 行数上限 ✓）。 */
      agentsConfig: () => {
        timeoutMs: number
        listRetry: number
        cacheMs: number
        maxRows: number
        clickTries: number
        clickStepMs: number
      }
    }
  }
  /** ★ 本轮追加：沙箱里那个 localStorage 的底表 ✓ —— 用来证明"读数与落盘同源"✓。 */
  storage: Map<string, string>
}

/**
 * ★★ 本轮追加：一个**最小可用的假 DOM 节点** ✓（只有新的那几条用例会造它 ✓）。
 *
 * 为什么要它 ✗：既有夹具的 `setAttribute` / `addEventListener` 都是**空函数** ✓（原来够用 ✓），
 * 而本轮要断言的恰恰是"**每一条都带得走的判据**"✓（`data-dshm-session` 之类 ✓）与
 * "**点击之后到底点了哪个 DOM 节点**"✓ ⇒ 这两件事都要求属性与监听器**真的存下来** ✓。
 * ★ 只加能力、不动既有语义 ✗：不传新参数时，既有用例走的路与原来**逐字一致** ✓。
 */
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
  /** ★ 追加：预装一个假隧道 ✓（塞进 `__DSH_TRANSPORT__` ✓ ⇒ poll 会真的取待办并逐条执行 ✓）。 */
  transport?: Record<string, unknown>
  /** ★ 追加：冒充原生壳 ✓（`DshmShell` ✓ —— 形状照 scripts/check-device-channel.mjs ✓）。 */
  shell?: Record<string, unknown>
  /** ★ 追加：让 localStorage 对**取证那个键**读写都抛错 ✓（验"落盘坏了也不许炸"✓）。 */
  storageThrowsForLog?: boolean
  /** ★ 追加：沙箱里的定时器 unref ✓ —— 免得 drawBar 那个 15 秒清理定时器把测试进程挂住 ✓。 */
  unrefTimers?: boolean
  /**
   * ★ 本轮追加：一个**假 DSH DOM** ✓（`createDshDom` 造的 ✓ —— 见它自己的说明 ✓）。
   *   不传 ⇒ `document.querySelector` 照旧恒 `null`、`querySelectorAll` 照旧恒 `[]` ✓
   *   （既有用例一个字都不用改 ✓）。
   */
  dsh?: DshDom
  /** ★ 本轮追加：`document.title` ✓（DSH 把当前会话标题写在它里面 ✓ —— 兜底判据要用 ✓，见 agentsIdByTitle ✓）。 */
  title?: string
}): Surface {
  const boxText: string[] = []
  const intervals: Array<() => void> = []
  const thrown: unknown[] = []

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
      attrs: {},
      clicks: 0,
      listeners: {},
      /**
       * ★ 本轮追加：属性**真的存下来** ✓（原来这里是空函数 ✗）——
       *   本轮要断言的"带得走的判据"就是 `data-dshm-*` 属性 ✓。
       *   `data-x-y` 同时同步进 `dataset` ✓（与真 DOM 一致 ✓）。
       */
      setAttribute: (name: string, value: unknown) => {
        const text = String(value)
        ;(element['attrs'] as Record<string, string>)[name] = text
        if (name.indexOf('data-') === 0) {
          const key = name
            .slice('data-'.length)
            .replace(/-([a-z0-9])/g, (_match: string, letter: string) => letter.toUpperCase())
          ;(element['dataset'] as Record<string, string>)[key] = text
        }
      },
      getAttribute: (name: string) => (element['attrs'] as Record<string, string>)[name] ?? null,
      removeAttribute: (name: string) => {
        delete (element['attrs'] as Record<string, string>)[name]
      },
      /**
       * ★ 本轮追加：监听器**真的存下来** ✓（原来也是空函数 ✗）——
       *   新用例靠 `fireClick` 真的把那条路上点一遍 ✓（不是断言"函数存在"✗）。
       */
      addEventListener: (type: string, run: (event?: unknown) => void) => {
        const table = element['listeners'] as Record<string, Array<(event?: unknown) => void>>
        if (table[type] === undefined) table[type] = []
        table[type].push(run)
      },
      removeEventListener: () => {},
      remove: () => {},
      querySelector: () => null,
      querySelectorAll: () => [],
      replaceChildren: () => {
        // ★ 本轮追加：清空子节点 ✓（生产代码用它"原地重画这一组"✓ —— 真 DOM 本来就有它 ✓）
        ;(element['children'] as unknown[]).length = 0
      },
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

  const documentStub = {
    readyState: options.readyState ?? 'complete',
    title: options.title ?? '',
    body,
    head: makeElement('head'),
    documentElement: makeElement('html'),
    getElementById: (id: string) => registry.get(id) ?? null,
    /**
     * ★ 本轮追加：给了假 DSH DOM 就由它回答 ✓（不传 ⇒ 与原来逐字一致：恒 `null` / 恒 `[]` ✓）。
     *   本轮要验的是"**到底点了哪个节点**"✓ ⇒ DSH 那一侧必须能被查询到 ✓。
     */
    querySelector: (selector: string) => (options.dsh === undefined ? null : options.dsh.querySelector(selector)),
    querySelectorAll: (selector: string) =>
      options.dsh === undefined ? [] : options.dsh.querySelectorAll(selector),
    createElement: (tag: string) => makeElement(tag),
    createTextNode: (text: string) => ({ textContent: text }),
    addEventListener: () => {},
    removeEventListener: () => {},
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
      origin: 'https://10.34.221.181:3443',
      protocol: 'https:',
      host: '10.34.221.181:3443',
      pathname: options.pathname,
      search: '?debug=1',
      href: 'https://10.34.221.181:3443' + options.pathname + '?debug=1',
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
    navigator: { userAgent: 'Mozilla/5.0 (Linux; Android 10; K)', vibrate: () => true },
    Notification: { permission: 'granted', requestPermission: async () => 'granted' },
    WebSocket: class {
      readyState = 0
      binaryType = 'blob'
      send() {}
      close() {}
      addEventListener() {}
      removeEventListener() {}
    },
    fetch: async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }),
    MutationObserver: class {
      observe() {}
      disconnect() {}
    },
    innerWidth: options.innerWidth,
    innerHeight: 915,
    isSecureContext: true,
    matchMedia: () => ({ matches: true, addEventListener: () => {}, removeEventListener: () => {} }),
    addEventListener: () => {},
    removeEventListener: () => {},
    performance: globalThis.performance,
    /**
     * ★ 本轮追加：`MouseEvent` ✓ —— 生产代码"打开 DSH 那颗子智能体树"时**必须**合成一次
     * `mouseover`（0.1.5 计数形态的 `onClick` 是 undefined ✗，只有悬停能开树 ✓ ——
     * 见 29 号文档 §一 #21 ✓）。原来沙箱里没有它 ⇒ 那一句会抛 ReferenceError
     * （被 catch 住、只写一行调试框 ✓）⇒ **测不到"到底有没有合成"** ✗。
     * 这里给一个最小实现 ✓：只记 type 与 init ✓（够断言"发了、发的是 mouseover"✓）。
     */
    MouseEvent: class {
      type: string
      detail: Record<string, unknown>
      constructor(type: string, init?: Record<string, unknown>) {
        this.type = type
        this.detail = init ?? {}
      }
    },
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
const { TunnelSession } = await import('../../host/src/tunnel.ts')
const { mkdtempSync, rmSync } = await import('node:fs')
const { tmpdir } = await import('node:os')

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
            return { endpoint: request.endpoint, payload: request.payload }
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

/* ────────────────────────────────────────────────────────────────────────────
 * ★★ 本轮：「设备 / 智能体面板」增量 1 —— **当前这台电脑的会话 + 当前会话的子智能体** ✓
 *
 * 需求出处：27-项目简介.md §接下来 第 4 条 / 26-交付总览-20260930.md §9 第 4 条 /
 *   23-项目交付总览.md §196 / 21-后续目标与路线图.md §4C（"把 DSH 的多会话、子代理在手机上可视化"）。
 * 接口依据：29-多智能体切换页-接口调研.md（`session/list` ✓ / 0.1.5 `subagents/list` ✓ /
 *   0.2.0 `session/projections` → `values.subagentCatalog` ✓ / 切过去只能点 DOM ✓）。
 *
 * ## 下面的夹具为什么必须存在（不是"为了测试方便"✗）
 * 这一轮要验的两件事**只有真 DOM 才说得清** ✓：
 *   ① **每一条都带得走的判据** ✓（`data-dshm-session` / `data-dshm-subagent` 属性 ✓）；
 *   ② **点击之后到底点了哪个节点** ✓（判据是"那一行被点过"✓，不是"某个函数被调用"✗）。
 * 既有的假 DOM 把 `setAttribute` / `addEventListener` 都写成空函数 ✗ ⇒ 这两件事都测不到 ✓。
 * 所以下面这一层只补**真 DOM 本来就有的能力** ✓（属性存储 ✓、监听器派发 ✓、`replaceChildren` ✓），
 * 并且**只在传 `dsh` 时才介入** ✓ —— 既有用例走的路一个字都没变 ✓。
 */

/** 一个假 DSH 节点 ✓（比夹具多记两样：点过几次 ✓、收过哪些合成事件 ✓）。 */
interface DshNode extends FakeElement {
  clicks: number
  /** ★ 收到过的**合成事件类型** ✓（`mouseover` ✓ —— 断言"悬停有没有真的发出去"就靠它 ✓）。 */
  events: string[]
  dispatchEvent: (event: { type?: string }) => boolean
  children: DshNode[]
  parentNode: DshNode | null
  /** ★ 真 DOM 里 `parentElement` 与 `parentNode` 在"父节点是元素"时是同一个 ✓ ——
   *  生产代码读的正是它（与既有 `lineageForwardPointer` 同一个写法 ✓）⇒ 假节点必须也有 ✓。 */
  parentElement: DshNode | null
  /** ★ 返回值收窄回 DshNode ✓（父接口给的是 FakeElement ✓ —— 收窄是允许的 ✓）。 */
  querySelector: (selector: string) => DshNode | null
  querySelectorAll: (selector: string) => DshNode[]
}

/** 假 DSH DOM 的对外形状 ✓（生产代码只用到这几个选择器 ✓）。 */
interface DshDom {
  querySelector: (selector: string) => DshNode | null
  querySelectorAll: (selector: string) => DshNode[]
  /** 按会话 id 取侧栏那一行 ✓（0.1.5 / 0.2.0 都给 ✓ —— 断言"点的是哪一行"✓）。 */
  row: (id: string) => DshNode
  /** 树菜单里那一行 ✓（按 label 认 ✓）。 */
  treeRow: (label: string) => DshNode
  /** 那颗「N 个子智能体」入口 ✓（没渲染就是 null ✓）。 */
  trigger: () => DshNode | null
  /** 树菜单现在开着没有 ✓（点完那一行它必须关掉 ✓ —— 生产代码就是这么验的 ✓）。 */
  treeOpen: () => boolean
}

/** 只支持生产代码真正会用到的那几种选择器 ✓（`tag` / `.class` / `[attr]` / `[attr="value"]` ✓）。 */
function matchesSelector(node: DshNode, selector: string): boolean {
  const tokens = selector.match(/[a-zA-Z][\w-]*|\[[^\]]+\]|\.[\w-]+/g) ?? []
  if (tokens.length === 0) return false
  for (const token of tokens) {
    if (token.startsWith('[')) {
      const body = token.slice(1, -1)
      const equal = body.indexOf('=')
      if (equal < 0) {
        if (node.getAttribute(body) === null) return false
        continue
      }
      const name = body.slice(0, equal)
      const wanted = body.slice(equal + 1).replace(/^"|"$/g, '')
      if (String(node.getAttribute(name)) !== wanted) return false
      continue
    }
    if (token.startsWith('.')) {
      if (String(node.className).split(/\s+/).indexOf(token.slice(1)) < 0) return false
      continue
    }
    if (String(node.tagName).toLowerCase() !== token.toLowerCase()) return false
  }
  return true
}

function dshDescendants(node: DshNode): DshNode[] {
  const out: DshNode[] = []
  for (const child of node.children) {
    out.push(child)
    for (const deeper of dshDescendants(child)) out.push(deeper)
  }
  return out
}

/**
 * 造一个**假 DSH 页面** ✓ —— 只造本轮那几条路要用的东西 ✓：
 *   · 侧栏会话行（`[role="treeitem"]` + `aria-selected` ✓；0.2.0 多 `data-row-key` ✓ / 0.1.5 **没有** ✗）；
 *   · 那颗「N 个子智能体」入口（`[aria-haspopup="tree"]` ✓）；
 *   · 树菜单（`[role="tree"]` + `[role="treeitem"]` ✓）—— **只有"开了"才挂在树上** ✓
 *     （真 DSH 是 `createPortal` + 关闭即卸载 ✓ —— 29 §一 #19 ✓；这样"菜单关没关"才验得出来 ✓）。
 */
function createDshDom(spec: {
  sessions: Array<{ id: string; title: string; selected?: boolean; running?: boolean }>
  /** true = 0.2.0（行上有 `data-row-key` ✓）；false = 0.1.5（一个 `data-*` 都没有 ✗）。 */
  rowKey: boolean
  /**
   * ★ 侧栏行"点了没反应"✓（真机上是 React 把节点换掉、或点空了 ✓ —— 29 §三 方案 A 的风险点 ✓）。
   * 用它来钉"**点了之后必须验**"✓：点了但 `aria-selected` 没变 ⇒ 面板**必须**说没切过去 ✗。
   */
  inert?: boolean
  /**
   * ★ 额外造几颗**带 `data-row-key` 的别的行** ✓（0.2.0 的工作区行就是 `workspace:<key>` ✓ ——
   *   29 §一 #24 ✓）。用来造"这一版能从 DOM 上认出来、但**侧栏会话行一条都没渲染**"那个现场 ✓。
   */
  extraRowKeys?: string[]
  tree?: {
    trigger?: boolean
    rows?: Array<{ label: string; aria?: string }>
    /** ★ 开树靠哪条路 ✗✗：0.1.5 的计数形态 `onClick` 是 undefined ⇒ **只有悬停能开** ✓（29 §一 #21）。 */
    opensOn?: 'hover' | 'click' | 'both'
  }
}): DshDom {
  const makeNode = (tag: string): DshNode => {
    // ★ 必须**显式标成 DshNode** ✗：不标的话 TS 从字面量推出来的 children 是 never[]、
    //   dataset/attrs/listeners 是 {} ✓ ⇒ 夹具自己的每一处索引都会报 TS7053 ✓（语义一点没变 ✓）。
    const node: DshNode = {
      tagName: tag,
      id: '',
      style: {},
      dataset: {},
      className: '',
      attrs: {},
      children: [],
      parentNode: null,
      textContent: '',
      clicks: 0,
      events: [],
      listeners: {},
      isConnected: true,
      // ★ 与 parentNode 始终同源 ✓（真 DOM 在"父节点是元素"时也是同一个 ✓）
      get parentElement(): DshNode | null {
        return node.parentNode
      },
      setAttribute(name: string, value: unknown) {
        const text = String(value)
        node.attrs[name] = text
        if (name.indexOf('data-') === 0) {
          node.dataset[
            name
              .slice('data-'.length)
              .replace(/-([a-z0-9])/g, (_match: string, letter: string) => letter.toUpperCase())
          ] = text
        }
      },
      getAttribute(name: string) {
        return node.attrs[name] ?? null
      },
      removeAttribute(name: string) {
        delete node.attrs[name]
      },
      addEventListener(type: string, run: (event?: unknown) => void) {
        if (node.listeners[type] === undefined) node.listeners[type] = []
        node.listeners[type].push(run)
      },
      removeEventListener() {},
      remove() {
        node.isConnected = false
        if (node.parentNode !== null) {
          node.parentNode.children = node.parentNode.children.filter((child: DshNode) => child !== node)
          node.parentNode = null
        }
      },
      appendChild(child: FakeElement) {
        // ★ 参数类型跟随父接口（FakeElement ✓ —— 收窄参数会让 DshNode 不再能当 FakeElement 用 ✗），
        //   里面按假 DSH 节点用 ✓：本夹具造出来的子节点本来就是它 ✓。
        const target = child as DshNode
        target.parentNode = node
        target.isConnected = true
        node.children.push(target)
        return target
      },
      insertBefore(child: FakeElement) {
        return node.appendChild(child)
      },
      replaceChildren() {
        for (const child of node.children) {
          child.parentNode = null
          child.isConnected = false
        }
        node.children.length = 0
      },
      querySelector(selector: string) {
        return node.querySelectorAll(selector)[0] ?? null
      },
      querySelectorAll(selector: string) {
        return dshDescendants(node).filter((candidate) => matchesSelector(candidate, selector))
      },
      click() {
        node.clicks++
        for (const run of node.listeners['click'] ?? []) run()
      },
      dispatchEvent(event: { type?: string }) {
        const type = String(event?.type ?? '')
        node.events.push(type)
        let cursor: DshNode | null = node
        while (cursor !== null) {
          for (const run of cursor.listeners[type] ?? []) run(event)
          cursor = cursor.parentNode
        }
        return true
      },
      getBoundingClientRect() {
        return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }
      },
    }
    return node
  }

  const root = makeNode('body')
  const rows = new Map<string, DshNode>()
  for (const session of spec.sessions) {
    const row = makeNode('div')
    row.className = 'treeRow'
    row.setAttribute('role', 'treeitem')
    row.setAttribute('aria-selected', session.selected === true ? 'true' : 'false')
    if (spec.rowKey) row.setAttribute('data-row-key', 'session:' + session.id)
    row.textContent = session.title
    row.addEventListener('click', () => {
      // ★ 点了没反应那一路 ✓（`inert`）：什么都不做 ⇒ 生产代码**必须**验出来并说出来 ✗
      if (spec.inert === true) return
      // ★ 真 DSH 的行为：点一行 ⇒ 它变成"当前"✓（这正是生产代码用来**验收**的那条判据 ✓）
      for (const other of rows.values()) other.setAttribute('aria-selected', 'false')
      row.setAttribute('aria-selected', 'true')
    })
    rows.set(session.id, row)
    root.appendChild(row)
  }

  for (const key of spec.extraRowKeys ?? []) {
    const extra = makeNode('div')
    extra.setAttribute('data-row-key', key)
    extra.textContent = key
    root.appendChild(extra)
  }

  const trigger = makeNode('button')
  const treeRows = new Map<string, DshNode>()
  const tree = makeNode('div')
  tree.setAttribute('role', 'tree')
  let open = false
  const dropTree = () => {
    open = false
    tree.isConnected = false
    for (const row of treeRows.values()) row.isConnected = false
    root.children = root.children.filter((child) => child !== tree)
    tree.parentNode = null
  }
  const openTree = () => {
    if (open) return
    open = true
    root.appendChild(tree)
  }
  if (spec.tree !== undefined && spec.tree.trigger !== false) {
    trigger.setAttribute('aria-haspopup', 'tree')
    trigger.setAttribute('aria-expanded', 'false')
    const opensOn = spec.tree.opensOn ?? 'both'
    const triggerRoot = makeNode('div')
    triggerRoot.appendChild(trigger)
    // ★ 悬停那条路（0.1.5 唯一能开树的路 ✓）：挂点就在触发键的**根节点**上 ✓（29 §一 #21 ✓）
    triggerRoot.addEventListener('mouseover', () => {
      if (opensOn === 'hover' || opensOn === 'both') openTree()
    })
    trigger.addEventListener('click', () => {
      if (opensOn === 'click' || opensOn === 'both') openTree()
    })
    root.appendChild(triggerRoot)
    for (const entry of spec.tree.rows ?? []) {
      const row = makeNode('div')
      row.setAttribute('role', 'treeitem')
      row.setAttribute('aria-label', entry.aria ?? entry.label)
      row.textContent = entry.aria ?? entry.label
      row.addEventListener('click', () => {
        // ★ 真 DSH 的行为：点一行 = 切过去 + **关菜单** ✓（29 §二·3(d) ✓）——
        //   生产代码就是靠"菜单关了没有"验这一下的 ✓。
        dropTree()
      })
      treeRows.set(entry.label, row)
      tree.appendChild(row)
    }
  }

  return {
    querySelector: (selector: string) => root.querySelector(selector),
    querySelectorAll: (selector: string) => root.querySelectorAll(selector),
    row: (id: string) => {
      const found = rows.get(id)
      if (found === undefined) throw new Error('假 DSH 里没有这条会话行：' + id)
      return found
    },
    treeRow: (label: string) => {
      const found = treeRows.get(label)
      if (found === undefined) throw new Error('假 DSH 的树里没有这一行：' + label)
      return found
    },
    trigger: () =>
      spec.tree !== undefined && spec.tree.trigger !== false && root.querySelector('[aria-haspopup="tree"]') !== null
        ? trigger
        : null,
    treeOpen: () => open,
  }
}

/**
 * 一个假隧道 ✓ —— 形状与真宿主逐字段一致 ✓（`packages/host/src/tunnel.ts` 那个 `server-response` 信封 ✓）：
 *   · 成功 ⇒ `{type, rpcId, result:{ok:true, value}}` ✓；
 *   · 失败 ⇒ `{type, rpcId, result:{ok:false, error:{code, message}}}` ✓；
 *   · **没写处理器的端点** ⇒ 回"端点不在了"那个码 ✓ —— 与真网关对
 *     `subagents/list`（0.2.0 已删 ✓）的答复**同一个** ✓ ⇒ 那一处分叉就是在这里被验的 ✓。
 */
interface FakeTunnel {
  rpc: (endpoint: string, payload: unknown, rpcId?: string) => Promise<unknown>
  calls: Array<{ endpoint: string; args: Record<string, unknown> }>
  count: (endpoint: string) => number
}

function fakeTunnel(handlers: Record<string, (args: Record<string, unknown>) => unknown>): FakeTunnel {
  const calls: FakeTunnel['calls'] = []
  return {
    calls,
    count: (endpoint: string) => calls.filter((call) => call.endpoint === endpoint).length,
    async rpc(endpoint: string, payload: unknown, rpcId?: string) {
      const envelope = payload as { args?: Record<string, unknown> } | undefined
      const args = envelope?.args ?? {}
      calls.push({ endpoint, args })
      const handler = handlers[endpoint]
      if (handler === undefined) {
        return {
          type: 'server-response',
          rpcId,
          result: {
            ok: false,
            error: { code: 'gateway/invocation-unavailable', message: 'no active Remote method exports this endpoint' },
          },
        }
      }
      try {
        const value = await handler(args)
        return { type: 'server-response', rpcId, result: { ok: true, value } }
      } catch (error) {
        const failure = error as { code?: string; message?: string }
        return {
          type: 'server-response',
          rpcId,
          result: { ok: false, error: { code: failure?.code ?? 'stub/failed', message: String(failure?.message ?? error) } },
        }
      }
    },
  }
}

/**
 * 把假隧道记下的调用**搬回本 realm** ✓ —— vm 里造的 `args` 对象原型与这边不同 ✓，
 * 直接 `deepStrictEqual` 会因原型不同而**假红** ✗（`readLog` 那条注释记过同一个坑 ✓）。
 */
function callsOf(tunnel: FakeTunnel): Array<{ endpoint: string; args: Record<string, unknown> }> {
  return JSON.parse(JSON.stringify(tunnel.calls)) as Array<{ endpoint: string; args: Record<string, unknown> }>
}

/** 等异步落地 ✓（面板自己的重画是微任务 + 定时器 ✓）。 */
async function agentsSettle(ms = 60): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

/** 深度收集 ✓（假 DOM 没有 `querySelector` 的通用实现 ⇒ 测试自己走一遍 ✓）。 */
function collect(node: FakeElement, hit: (node: FakeElement) => boolean): FakeElement[] {
  const out: FakeElement[] = []
  const walk = (current: FakeElement): void => {
    if (hit(current)) out.push(current)
    for (const child of current.children ?? []) walk(child)
  }
  walk(node)
  return out
}

/** 按某个 `data-dshm-*` 属性找那一行 ✓（没找到就抛 ✓ —— 免得断言悄悄变成"反正没有"✗）。 */
function findByAttr(group: FakeElement, name: string, value: string): FakeElement {
  const found = collect(group, (node) => node.attrs[name] === value)
  assert.ok(found.length > 0, `面板里应当有一行 ${name}="${value}"`)
  return found[0] as FakeElement
}

/** 一棵子树的全部可见文字 ✓（假 DOM 的 textContent 是直接写的 ✓ —— 与真 DOM 的"拼接"等价于我们要看的那几行 ✓）。 */
function textOf(node: FakeElement): string {
  return collect(node, () => true)
    .map((child) => String(child.textContent ?? ''))
    .join('｜')
}

/** 真点一下某个节点 ✓（走上生产代码注册的那条路 ✓，不是直接调函数 ✗）。 */
function fireClick(node: FakeElement): void {
  for (const run of node.listeners['click'] ?? []) run()
}

/** 会话列表答复的**最小真实形状** ✓（`projections.values.title` ✓ —— 29 §二·1(b) 坑 1 ✓）。 */
function sessionItem(spec: {
  id: string
  title: string
  running?: boolean
  updatedAt?: number
  parentSessionId?: string
  subagent?: boolean
}): Record<string, unknown> {
  const item: Record<string, unknown> = {
    sessionId: spec.id,
    running: spec.running === true,
    blank: false,
    updatedAt: spec.updatedAt ?? 0,
    projections: { asOfSeq: 1, values: { title: spec.title } },
  }
  if (spec.parentSessionId !== undefined) item['parentSessionId'] = spec.parentSessionId
  if (spec.subagent === true) item['origin'] = 'subagent'
  return item
}

test('★★ 会话与智能体（0.2.0）：列出这台电脑的会话与当前会话的子智能体，点一条真的点了 DSH 那一行', async () => {
  const dsh = createDshDom({
    rowKey: true,
    sessions: [
      { id: 's1', title: '修侧栏标题', selected: true, running: true },
      { id: 's2', title: '另一个会话', running: true },
      { id: 's3', title: '早就停了的会话' },
    ],
    // 0.2.0：点一下就能钉住开树 ✓（合成悬停照样能开 ✓ —— 两条路都验得到 ✓）
    tree: { rows: [{ label: 'build-lib 子代理', aria: 'build-lib 子代理 可继续 正在运行' }], opensOn: 'both' },
  })
  const tunnel = fakeTunnel({
    'session/list': () => ({
      items: [
        sessionItem({ id: 's1', title: '修侧栏标题', running: true, updatedAt: 300 }),
        sessionItem({ id: 's2', title: '另一个会话', running: true, updatedAt: 200 }),
        sessionItem({ id: 's3', title: '早就停了的会话', updatedAt: 100 }),
        // ★ 子智能体会话**自己也在**这份列表里 ✓（29 §二·1(b) 坑 3）—— 它**不该**出现在会话那一组 ✗
        sessionItem({ id: 'a1', title: 'build-lib 子代理', running: true, parentSessionId: 's1', subagent: true }),
      ],
    }),
    // 0.2.0：目录走 projections ✓（29 §一 #12 ✓ —— 目录在 values.subagentCatalog ✓）
    'session/projections': () => ({
      asOfSeq: 7,
      values: { subagentCatalog: [{ id: 'a1', createdAt: 1, mode: 'continuable', label: 'build-lib 子代理' }] },
    }),
  })
  const surface = bootOnSurface({ pathname: '/mobile/app', innerWidth: 412, consent: [], dsh })
  assert.equal(surface.thrown.length, 0, `顶层不应抛错：${String(surface.thrown[0])}`)
  const group = surface.boot.apk.agentsPanel(() => tunnel).group
  await agentsSettle()

  // ① 会话：在跑的在前 ✓、都带得走的判据 ✓、子智能体会话**不列**在这里 ✓
  const order = collect(group, (node) => node.attrs['data-dshm-session'] !== undefined).map(
    (node) => node.attrs['data-dshm-session'],
  )
  assert.deepEqual(order, ['s1', 's2', 's3'], `会话应当"在跑的在前、其次最近"：${JSON.stringify(order)}`)
  assert.equal(findByAttr(group, 'data-dshm-session', 's1').attrs['data-dshm-session-current'], '1', '当前那一条要标出来 ✓')
  assert.equal(findByAttr(group, 'data-dshm-session', 's2').attrs['data-dshm-session-running'], '1')
  assert.equal(findByAttr(group, 'data-dshm-session', 's3').attrs['data-dshm-session-running'], '0')
  assert.ok(textOf(group).includes('另一个会话'), '行上要看得见名字 ✓：' + textOf(group))
  assert.ok(textOf(group).includes('正在跑 2 个'), '要写清有几个在跑 ✓：' + textOf(group))
  assert.ok(textOf(group).includes('当前电脑'), '这一组要落在"当前这台电脑"下面 ✓：' + textOf(group))

  // ② 参数：`_request` 必须**显式给空对象** ✓（省略会被网关判 missing ✗ —— 见 boot.js 那段注释 ✓）
  assert.deepEqual(callsOf(tunnel)[0], { endpoint: 'session/list', args: { _request: {} } })
  assert.deepEqual(callsOf(tunnel)[1], { endpoint: 'session/projections', args: { request: { sessionId: 's1' } } })
  // ③ 0.2.0 **一次都不该**去打那个已经被删掉的端点 ✓（DOM 上就认出是哪一版了 ✓）
  assert.equal(tunnel.count('subagents/list'), 0, '0.2.0 上那个端点已经没了 ⇒ 不该去试 ✗')

  // ④ 子智能体：状态来自会话列表那一行的 running ✓（0.2.0 的目录**没有** activity ✗ —— 29 §一 #9）
  const subagent = findByAttr(group, 'data-dshm-subagent', 'a1')
  assert.equal(subagent.attrs['data-dshm-subagent-running'], '1')
  assert.equal(subagent.attrs['data-dshm-subagent-source'], 'catalog')
  assert.ok(textOf(subagent).includes('build-lib 子代理'))

  // ⑤ 点会话 ⇒ 判据是"**DSH 那一行被点过**"✓（不是"某个函数被调用"✗）
  fireClick(findByAttr(group, 'data-dshm-session', 's2'))
  await agentsSettle()
  assert.equal(dsh.row('s2').clicks, 1, '必须点了 DSH 自己那条会话行 ✓')
  assert.equal(dsh.row('s2').getAttribute('aria-selected'), 'true', 'DSH 那边真的换过去了 ✓')
  assert.equal(dsh.row('s1').clicks, 0, '不许顺手把当前那条也点了 ✗')

  // ⑥ 点子智能体 ⇒ 先开 DSH 那颗树（合成悬停 + 点入口 ✓）⇒ 再点树里那一行 ✓
  fireClick(findByAttr(group, 'data-dshm-subagent', 'a1'))
  await agentsSettle()
  assert.equal(dsh.trigger()?.clicks, 1, '必须点过那颗「子智能体」入口 ✓')
  assert.ok(
    (dsh.trigger()?.parentNode?.events ?? []).includes('mouseover'),
    '还必须合成过 mouseover（0.1.5 只有这条路能开树 ✓ —— 29 §一 #21）',
  )
  assert.equal(dsh.treeRow('build-lib 子代理').clicks, 1, '必须点了树里那一行 ✓')
  assert.equal(dsh.treeOpen(), false, '点完那一行菜单应当关了（DSH 的 closeCatalog ✓）')

  // ⑦ 成功路径**不许**在屏幕上留"没切过去"✗
  assert.equal(textOf(group).includes('没切过去'), false, '成功了就不许写失败提示 ✗：' + textOf(group))
})

test('★★ 会话与智能体（0.1.5）：目录走 subagents/list，侧栏行没有 id ⇒ 按文案认', async () => {
  const dsh = createDshDom({
    // ★ 0.1.5：侧栏行上**一个 data-* 都没有** ✗（29 §一 #24：那一版 grep data-row-key = 0）
    rowKey: false,
    sessions: [
      { id: 's1', title: '甲会话', selected: true, running: true },
      { id: 's2', title: '乙会话', running: true },
    ],
    // ★ 0.1.5 的计数形态**点不开**树 ✗（onClick 是 undefined ✓）⇒ 只有合成悬停能开 ✓（29 §一 #21）
    tree: { rows: [{ label: '窗口探针', aria: '窗口探针 一次性 正在运行' }], opensOn: 'hover' },
  })
  const tunnel = fakeTunnel({
    'session/list': () => ({
      items: [
        sessionItem({ id: 's1', title: '甲会话', running: true, updatedAt: 200 }),
        sessionItem({ id: 's2', title: '乙会话', running: true, updatedAt: 100 }),
        sessionItem({ id: 'b1', title: '窗口探针', running: true, parentSessionId: 's1', subagent: true }),
      ],
    }),
    // 0.1.5 的目录端点 ✓（29 §一 #10：条目**自带** activity ✓）
    'subagents/list': () => ({
      parentAvailable: true,
      entries: [{ kind: 'child', id: 'b1', activity: 'running', hasChildren: false, mode: 'one-shot', label: '窗口探针' }],
    }),
    // ★ 刻意**不装** session/projections ✓ —— 这一版要是跑去调它，下面那条断言就会红 ✓
  })
  const surface = bootOnSurface({ pathname: '/mobile/app', innerWidth: 412, consent: [], dsh })
  const group = surface.boot.apk.agentsPanel(() => tunnel).group
  await agentsSettle()

  // ① 当前会话 id 是**按标题反推**的 ✓（行上没有 id ✗）⇒ 目录请求的 parentSessionId 必须对 ✓
  assert.equal(tunnel.count('subagents/list'), 1)
  assert.deepEqual(callsOf(tunnel)[1], { endpoint: 'subagents/list', args: { parentSessionId: 's1' } })
  assert.equal(tunnel.count('session/projections'), 0, '0.1.5 不该去碰 0.2.0 的那个端点 ✗')
  // ② 状态**直接来自服务端的 activity** ✓（这一版独有的字段 ✓ —— 29 §一 #10）
  const subagent = findByAttr(group, 'data-dshm-subagent', 'b1')
  assert.equal(subagent.attrs['data-dshm-subagent-running'], '1')
  assert.equal(subagent.attrs['data-dshm-subagent-source'], 'catalog')
  // ③ 点会话 ⇒ 按**可见文案**认那一行 ✓（这一版没有 data-row-key ✗）
  fireClick(findByAttr(group, 'data-dshm-session', 's2'))
  await agentsSettle()
  assert.equal(dsh.row('s2').clicks, 1, '按文案也要认对那一行 ✓')
  assert.equal(dsh.row('s1').clicks, 0)
  // ④ 点子智能体 ⇒ **只有合成悬停能开树** ✓（夹具的 click 在这一版故意打不开 ✗ —— 这条就在钉它 ✓）
  fireClick(findByAttr(group, 'data-dshm-subagent', 'b1'))
  await agentsSettle()
  assert.ok(
    (dsh.trigger()?.parentNode?.events ?? []).includes('mouseover'),
    '0.1.5 上必须合成悬停（click() 打不开那棵树 ✗）',
  )
  assert.equal(dsh.treeRow('窗口探针').clicks, 1)
  assert.equal(textOf(group).includes('没切过去'), false, '成功了就不许写失败提示 ✗：' + textOf(group))
})

test('★ 会话与智能体：读不到数据时面板照常显示（只少那一组）+ 调试框一行 —— 不许静默 ✗', async () => {
  const dsh = createDshDom({ rowKey: false, sessions: [{ id: 's1', title: '甲会话', selected: true }] })
  const tunnel = fakeTunnel({
    'session/list': () => {
      throw Object.assign(new Error('电脑没回话'), { code: 'stub/down' })
    },
  })
  const surface = bootOnSurface({ pathname: '/mobile/app', innerWidth: 412, consent: [], dsh })
  const group = surface.boot.apk.agentsPanel(() => tunnel).group
  // ★ 同步就该有一棵能看的树 ✓（请求还在飞 ✓ —— 面板**不被网络卡住** ✓）
  assert.ok(textOf(group).includes('当前电脑'), '还没读到数据时也要有这一组 ✓：' + textOf(group))
  assert.equal(surface.thrown.length, 0, `顶层不应抛错：${String(surface.thrown[0])}`)
  await agentsSettle(200)
  assert.ok(textOf(group).includes('读取失败'), '失败要写在屏幕上 ✓：' + textOf(group))
  assert.match(surface.boxText(), /\[会话\] 读取失败/, '调试框也要有一行 ✓')
  // ★ 重试上限 = 1（合计 2 次）✓ —— 失败不许变成无限重试 ✗
  assert.equal(tunnel.count('session/list'), 2, '重试上限就是 1 次（合计 2 次）✗')
})

test('★ 会话与智能体：请求带超时，且**超时不再重试**（手机上没网时不许把面板挂住 ✗）', async () => {
  const dsh = createDshDom({ rowKey: true, sessions: [{ id: 's1', title: '甲会话', selected: true }] })
  const tunnel = fakeTunnel({
    // 永不回话 = "手机上没网" ✓
    'session/list': () => new Promise(() => {}),
  })
  const surface = bootOnSurface({ pathname: '/mobile/app', innerWidth: 412, consent: [], dsh })
  const config = surface.boot.apk.agentsConfig()
  assert.ok(config.timeoutMs > 0 && config.timeoutMs <= 10000, '单次请求必须**有**上限 ✓：' + config.timeoutMs)
  assert.equal(config.listRetry, 1, '重试上限就写在生产代码里 ✓')
  const group = surface.boot.apk.agentsPanel(() => tunnel).group
  assert.ok(textOf(group).includes('正在读'), '面板要**立刻**能看 ✓（不等网络 ✓）：' + textOf(group))
  await agentsSettle(config.timeoutMs + 400)
  assert.match(surface.boxText(), /\[会话\] 读取失败：请求超时/, '超时要说出来 ✓（手机上没有控制台 ✓）')
  assert.equal(tunnel.count('session/list'), 1, '超时**不重试**（再试只是把等待翻倍 ✗）')
  assert.ok(textOf(group).includes('读取失败'), '屏幕上也要有 ✓：' + textOf(group))
})

test('★ 会话与智能体：认不出那一行时明确写「没切过去」（屏幕上 + 调试框各一处）', async () => {
  const dsh = createDshDom({ rowKey: true, sessions: [{ id: 's1', title: '甲会话', selected: true, running: true }] })
  const tunnel = fakeTunnel({
    // 列表里有 s2 ✓，而页面上的侧栏里**没有**它 ✗ —— 真机上"换了会话/抽屉没渲染"就是这个样子 ✓
    'session/list': () => ({
      items: [
        sessionItem({ id: 's1', title: '甲会话', running: true, updatedAt: 200 }),
        sessionItem({ id: 's2', title: '乙会话', running: true, updatedAt: 100 }),
      ],
    }),
  })
  const surface = bootOnSurface({ pathname: '/mobile/app', innerWidth: 412, consent: [], dsh })
  const group = surface.boot.apk.agentsPanel(() => tunnel).group
  await agentsSettle()
  fireClick(findByAttr(group, 'data-dshm-session', 's2'))
  await agentsSettle(surface.boot.apk.agentsConfig().clickTries * surface.boot.apk.agentsConfig().clickStepMs + 200)
  assert.ok(textOf(group).includes('没切过去'), '屏幕上必须明说没切过去 ✓：' + textOf(group))
  assert.match(surface.boxText(), /\[会话\] 切到「乙会话」：没切过去/, '调试框也要有一行 ✓')
  assert.equal(dsh.row('s1').clicks, 0, '认不出目标时不许乱点别的行 ✗')
})

test('★ 会话与智能体：**点了但 DSH 没换过去**时也要明说（判据是那一行真的被选中了）', async () => {
  const dsh = createDshDom({
    rowKey: true,
    // ★ 点了没反应 ✓（真机：React 把节点换掉 / 点空了 ⇒ 29 §三 方案 A 点名的那个风险 ✓）
    inert: true,
    sessions: [
      { id: 's1', title: '甲会话', selected: true, running: true },
      { id: 's2', title: '乙会话', running: true },
    ],
  })
  const tunnel = fakeTunnel({
    'session/list': () => ({
      items: [
        sessionItem({ id: 's1', title: '甲会话', running: true, updatedAt: 200 }),
        sessionItem({ id: 's2', title: '乙会话', running: true, updatedAt: 100 }),
      ],
    }),
  })
  const surface = bootOnSurface({ pathname: '/mobile/app', innerWidth: 412, consent: [], dsh })
  const config = surface.boot.apk.agentsConfig()
  const group = surface.boot.apk.agentsPanel(() => tunnel).group
  await agentsSettle()
  fireClick(findByAttr(group, 'data-dshm-session', 's2'))
  await agentsSettle(config.clickTries * config.clickStepMs + 200)
  // ★ 确实点了（不是"没点却说没切过去"✓）—— 判据是**节点被点过** ✓
  assert.equal(dsh.row('s2').clicks, 1, '该点的还是要点 ✓')
  assert.equal(dsh.row('s2').getAttribute('aria-selected'), 'false', '假 DSH 故意没换 ✓')
  // ★ 点了没换成 ⇒ **必须**说出来 ✗（"点了就当成功"是这一轮点名要消灭的那种假成功 ✓）
  assert.ok(textOf(group).includes('没切过去'), '屏幕上必须明说没切过去 ✓：' + textOf(group))
  assert.ok(textOf(group).includes('DSH 没有换过去'), '还要说清是"点了没换"这一种 ✓：' + textOf(group))
  assert.match(surface.boxText(), /\[会话\] 切到「乙会话」：没切过去/, '调试框也要有一行 ✓')
})

test('★ 会话与智能体：目录端点拿不到时退回会话列表的父子关系（少的是状态，不是一整组）', async () => {
  const dsh = createDshDom({ rowKey: true, sessions: [{ id: 's1', title: '甲会话', selected: true, running: true }] })
  const tunnel = fakeTunnel({
    'session/list': () => ({
      items: [
        sessionItem({ id: 's1', title: '甲会话', running: true, updatedAt: 200 }),
        // ★ 子智能体会话**本来就在**这份列表里 ✓（29 §二·1(b) 坑 3）—— 降级路就靠它 ✓
        sessionItem({ id: 'c1', title: '降级也要看得见', running: true, parentSessionId: 's1', subagent: true }),
      ],
    }),
    // ★ 目录那一个端点**两个版本都不给** ✓（没装的端点 ⇒ 网关回"端点不在了"✓）
  })
  const surface = bootOnSurface({ pathname: '/mobile/app', innerWidth: 412, consent: [], dsh })
  const group = surface.boot.apk.agentsPanel(() => tunnel).group
  await agentsSettle()
  const subagent = findByAttr(group, 'data-dshm-subagent', 'c1')
  assert.equal(subagent.attrs['data-dshm-subagent-source'], 'sessions', '要说清这一条是降级来的 ✓')
  assert.equal(subagent.attrs['data-dshm-subagent-running'], '1', '状态退回用会话列表那一行 ✓')
  assert.ok(textOf(group).includes('降级也要看得见'), '降级也要看得见这条子智能体 ✓：' + textOf(group))
  assert.ok(textOf(group).includes('目录端点拿不到'), '降级这件事要写在屏幕上 ✓：' + textOf(group))
  assert.match(surface.boxText(), /\[会话\] 子智能体目录拿不到/, '调试框也要有一行 ✓')
})

test('★ 会话与智能体：命中缓存就不重复请求（刷新要克制），点「刷新」才再取一次', async () => {
  const dsh = createDshDom({ rowKey: true, sessions: [{ id: 's1', title: '甲会话', selected: true, running: true }] })
  const tunnel = fakeTunnel({
    'session/list': () => ({ items: [sessionItem({ id: 's1', title: '甲会话', running: true, updatedAt: 200 })] }),
    'session/projections': () => ({ asOfSeq: 1, values: { subagentCatalog: [] } }),
  })
  const surface = bootOnSurface({ pathname: '/mobile/app', innerWidth: 412, consent: [], dsh })
  const api = surface.boot.apk
  const first = api.agentsPanel(() => tunnel).group
  await agentsSettle()
  assert.equal(tunnel.count('session/list'), 1)
  // 用户又点进这一页 ⇒ 面板**被重建** ✓ —— 缓存还在 ⇒ 一次请求都不许再发 ✗
  const second = api.agentsPanel(() => tunnel).group
  await agentsSettle()
  assert.equal(tunnel.count('session/list'), 1, '缓存内不许再请求 ✗（刷新时机要克制）')
  assert.ok(textOf(second).includes('甲会话'), '缓存里的数据要照画 ✓：' + textOf(second))
  assert.ok(textOf(first).includes('甲会话'))
  // 「刷新」= 强制再取一次 ✓
  const refresh = collect(second, (node) => node.dataset['dshmAction'] === 'agents-refresh')
  assert.equal(refresh.length, 1, '这一组要有**一颗**「刷新」（缓存没过期又想立刻更新时用 ✓）')
  fireClick(refresh[0] as FakeElement)
  await agentsSettle()
  assert.equal(tunnel.count('session/list'), 2, '点了「刷新」才再取一次 ✓')
  const config = api.agentsConfig()
  assert.ok(config.cacheMs >= 5000, '缓存时长要**是**个数（生产值 ✓）：' + config.cacheMs)
  assert.ok(config.maxRows >= 1 && config.maxRows <= 50, '列表上限要**是**个数（不静默截断 ✗）：' + config.maxRows)
})

test('★ 会话与智能体：侧栏收起（会话行根本没渲染）时用**文档标题**认当前会话 —— 子智能体那一组不许变空', async () => {
  /**
   * ★ 为什么这条最像真机 ✗✗：手机上面板常是**收起态** ✓，而 DSH 在收起态**不渲染侧栏列表** ✗
   *   （见 dshToggleSidebar 自己的说明 ✓）⇒ "那条选中的行"根本不存在 ✓。
   *   只认行的写法在真机上会**永远**认不出当前会话 ⇒ 子智能体那一组永远是空的 ✓ 而且不报错 ✗。
   * 两版都验一遍 ✓（0.2.0 靠工作区行也带 data-row-key 认出版本 ✓；0.1.5 一个 data-* 都没有 ✓）。
   */
  const cases = [
    {
      name: '0.2.0',
      extraRowKeys: ['workspace:root'],
      endpoint: 'session/projections',
      args: { request: { sessionId: 's1' } } as Record<string, unknown>,
      other: 'subagents/list',
    },
    {
      name: '0.1.5',
      extraRowKeys: [] as string[],
      endpoint: 'subagents/list',
      args: { parentSessionId: 's1' } as Record<string, unknown>,
      other: 'session/projections',
    },
  ]
  for (const one of cases) {
    const dsh = createDshDom({
      rowKey: false,
      // ★ 侧栏会话行**一条都没有** ✓（面板收起就是这个世界 ✓）
      sessions: [],
      extraRowKeys: one.extraRowKeys,
      tree: { rows: [{ label: '标题认出来的子代理' }], opensOn: 'both' },
    })
    const tunnel = fakeTunnel({
      'session/list': () => ({
        items: [
          sessionItem({ id: 's1', title: '甲会话', running: true, updatedAt: 200 }),
          sessionItem({ id: 'c9', title: '标题认出来的子代理', running: true, parentSessionId: 's1', subagent: true }),
        ],
      }),
      // 两个端点都装 ✓ —— 断言只看**这一版该走哪一个** ✓
      'session/projections': () => ({
        asOfSeq: 1,
        values: { subagentCatalog: [{ id: 'c9', createdAt: 1, mode: 'continuable', label: '标题认出来的子代理' }] },
      }),
      'subagents/list': () => ({
        parentAvailable: true,
        entries: [{ kind: 'child', id: 'c9', activity: 'running', mode: 'continuable', label: '标题认出来的子代理' }],
      }),
    })
    const surface = bootOnSurface({ pathname: '/mobile/app', innerWidth: 412, consent: [], dsh, title: '甲会话' })
    const group = surface.boot.apk.agentsPanel(() => tunnel).group
    await agentsSettle()
    assert.deepEqual(
      callsOf(tunnel)[1],
      { endpoint: one.endpoint, args: one.args },
      one.name + '：目录请求要按**文档标题**认出来的当前会话发 ✓',
    )
    assert.equal(tunnel.count(one.other), 0, one.name + '：不该去碰另一版的那个端点 ✗')
    const subagent = findByAttr(group, 'data-dshm-subagent', 'c9')
    assert.ok(textOf(subagent).includes('标题认出来的子代理'), one.name + '：这一组不许是空的 ✗：' + textOf(group))
  }
})

test('★ 结构性：0.1.5 / 0.2.0 的分叉**只许有一处**（版本号字面量只能出现在 agentsFork 里）', () => {
  const lines = bootSource.split('\n')
  const start = lines.findIndex((line) => line.indexOf('  function agentsFork(') === 0)
  assert.ok(start > 0, 'boot.js 里应当有 agentsFork（两版**唯一**的分叉点 ✓）')
  let end = -1
  for (let index = start + 1; index < lines.length; index++) {
    // 函数级结束大括号 = 恰好两个空格 + "}" ✓（函数体里的都在 4 列以后 ✓）
    if (lines[index] === '  }') {
      end = index
      break
    }
  }
  assert.ok(end > start, 'agentsFork 的结束大括号应当能在第 2 列找到 ✓')
  const inside = lines.slice(start, end + 1)
  assert.ok(inside.some((line) => line.includes("'0.1.5'")), '0.1.5 那一版要在这一处 ✓')
  assert.ok(inside.some((line) => line.includes("'0.2.0'")), '0.2.0 那一版要在这一处 ✓')
  const offenders = lines
    .map((line, index) => ({ line, index }))
    .filter((item) => /'0\.(1\.5|2\.0)'/.test(item.line))
    .filter((item) => item.index < start || item.index > end)
    .map((item) => String(item.index + 1) + ': ' + item.line.trim())
  // 怎么把它打红：把 agentsFork 里任何一处版本差异挪到别的函数里（例如在 agentsLoadCatalog 里
  //   直接判 `plan.version === '0.1.5'`）⇒ 立刻红 ✓。
  assert.deepEqual(offenders, [], '版本差异不许散到 agentsFork 之外 ✗')
})
