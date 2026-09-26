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

interface Surface {
  /** 调试框里累积的所有行（手机屏幕上看到的就是它）。 */
  boxText: () => string
  /** 被 `setInterval` 注册的回调（不真的排程，避免测试进程挂住）。 */
  intervals: Array<() => void>
  /** 未捕获的顶层异常。 */
  thrown: unknown[]
}

/** 用最小假 DOM 把 boot.js 跑起来，重点覆盖"手机表面"这一支。 */
function bootOnSurface(options: { pathname: string; innerWidth: number; consent: string[]; readyState?: string }): Surface {
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
    setTimeout,
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
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, String(value)),
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

  try {
    runInNewContext(bootSource, sandbox, { filename: 'boot.js' })
  } catch (error) {
    thrown.push(error)
  }
  return { boxText: () => boxText.join('\n'), intervals, thrown }
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
