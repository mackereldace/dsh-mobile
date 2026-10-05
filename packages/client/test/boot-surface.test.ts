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
  }
  /** ★ round 185 追加：沙箱里那个 localStorage 的底表 ✓ —— 用来证明"读数与落盘同源"✓。 */
  storage: Map<string, string>
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
      setAttribute: () => {},
      removeAttribute: () => {},
      addEventListener: () => {},
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

  const documentStub = {
    readyState: options.readyState ?? 'complete',
    body,
    head: makeElement('head'),
    documentElement: makeElement('html'),
    getElementById: (id: string) => registry.get(id) ?? null,
    querySelector: () => null,
    querySelectorAll: () => [],
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
  fitFileName: (name: unknown, maxUnits?: number) => string
  fileNameFamily: (name: unknown) => string
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
  assert.ok(body.includes('fitFileName(entry.name'), 'entryRow 必须走 fitFileName ✓')
  assert.ok(body.includes('data-dshm-fs-name'), '完整名字必须留在 data-dshm-fs-name 上 ✓（工具靠它认行 ✓）')
  assert.ok(body.includes('完整名称：'), '长按看全名的入口必须留着 ✓（截断之后它就是兜底 ✓）')
  // 长按那套的四个口一个都不能少 ✓（少一个 = 真机上"按住不动也会被取消"或"看完名字又进了目录"✗）
  for (const type of ['pointerdown', 'pointerup', 'pointercancel', 'pointermove']) {
    assert.ok(body.includes(`'${type}'`), `长按必须监听 ${type} ✓`)
  }
  // 交叉确认：`formatSize` 这个函数本身**不能**删 —— 预览那几处还在用 ✓
  assert.ok(bootSource.includes('function formatSize('), 'formatSize 仍要被预览那几处用着 ✓')
})
