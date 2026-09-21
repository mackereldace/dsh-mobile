#!/usr/bin/env node
/**
 * 在电脑上复现「手机屏幕上那个调试框」。
 *
 * ## 为什么需要它
 *
 * 这个项目反复卡在同一类循环里：改一行 → 构建 → 安装 → 让用户刷新手机 → 用户念回几行 →
 * 发现没变化 → 再猜。每一轮成本是"人肉往返一次"，而手机没有控制台，
 * 唯一取证手段就是屏幕上那个调试框（见 boot.js 顶部注释）。
 *
 * 于是把那个调试框**搬到电脑上**：用 `node:vm` + 一个最小假 DOM 跑同一份 boot.js，
 * 把写进 `#dshm-upload-debug` 的每一行原样打印出来。
 * 迭代从"一分钟一轮、要用户配合"变成"一秒一轮、全自动"。
 *
 * ## 边界（必须说清楚，否则会误用）
 *
 * 它复现的是**引导层自身的执行路径**：脚本从哪一行开始、走到哪、被哪个 guard 挡住、
 * 有没有抛异常。它**不**复现：真实 WebCrypto 协商、真实 WebSocket、真实 Service Worker、
 * 真实通知权限。所以"隧道没连上"这类结论不能靠它下 —— 它能回答的是
 * "手机上这几行代码到底执行到哪一步"，而那恰好是最难从外部观测的部分。
 *
 * 用法：
 *   node scripts/repro-boot.mjs                        # 默认 /mobile/app?debug=1
 *   node scripts/repro-boot.mjs --consent notify=yes   # 预置端侧同意记录
 *   node scripts/repro-boot.mjs --path / --no-debug    # 看非手机表面的行为
 *   node scripts/repro-boot.mjs --ready loading        # 模拟 body 尚未生成
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))

// ── 参数 ──────────────────────────────────────────────────────────────
const argv = process.argv.slice(2)
const arg = (name, fallback) => {
  const hit = argv.indexOf('--' + name)
  return hit === -1 ? fallback : argv[hit + 1]
}
// 默认跑**源文件**；`--file` 可以指向部署出去的那份（profile 里的产物）。
// 验证纪律：要断言的是"线上跑的到底是什么"，而不是"仓库里写的是什么" ——
// 这两者已经不止一次不一样（构建戳占位符就是原样上线过一次）。
const bootFile = arg('file', join(here, '..', 'packages', 'client', 'src', 'boot.js'))
const bootSource = readFileSync(bootFile, 'utf8')
const PATHNAME = arg('path', '/mobile/app')
const SEARCH = argv.includes('--no-debug') ? '' : arg('search', '?debug=1')
const READY_STATE = arg('ready', 'complete')
const CONSENT = (arg('consent', '') ?? '')
  .split(',')
  .map((pair) => pair.trim())
  .filter((pair) => pair.includes('='))
  .map((pair) => {
    const [capability, value] = pair.split('=')
    return ['dsh-mobile.deviceEnabled.' + capability, value]
  })
const SETTLED_MS = Number(arg('settle', '400'))

// ── 假 DOM：只实现 boot.js 真正碰到的那些面 ────────────────────────────
const registry = new Map()
function makeElement(tag) {
  const element = {
    tagName: tag,
    id: '',
    // ★ style 要像真的 CSSStyleDeclaration：boot.js 会读 CSS 变量（getPropertyValue）。
    //   桩里只给 `{}` 会让 applyPush 抛错，于是每次复现都多出一行
    //   "移动端外壳安装失败（不影响连接）" ✗ —— **假线索比没有线索更糟**（本轮就被它带偏一次）。
    style: (function () {
      var values = new Map()
      return {
        getPropertyValue: function (name) { return values.has(name) ? values.get(name) : '' },
        setProperty: function (name, value) { values.set(name, String(value)) },
        removeProperty: function (name) { values.delete(name) },
      }
    })(),
    dataset: {},
    // 属性要能读回来：boot.js 会 setAttribute 之后 getAttribute 比对
    // （如 aria-expanded），桩里只给 setAttribute(){} 会让它抛 getAttribute is not a function ✗
    attributes: new Map(),
    children: [],
    textContent: '',
    className: '',
    setAttribute(name, value) { element.attributes.set(name, String(value)) },
    getAttribute(name) { return element.attributes.has(name) ? element.attributes.get(name) : null },
    hasAttribute(name) { return element.attributes.has(name) },
    removeAttribute(name) { element.attributes.delete(name) },
    matches() { return false },
    closest() { return null },
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false } },
    addEventListener() {},
    removeEventListener() {},
    appendChild(child) {
      element.children.push(child)
      if (child.id) registry.set(child.id, child)
      return child
    },
    remove() {},
    querySelector() {
      return null
    },
    querySelectorAll() {
      return []
    },
    insertBefore(child) {
      return element.appendChild(child)
    },
    getBoundingClientRect() {
      return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }
    },
  }
  return element
}
const body = makeElement('body')
const documentStub = {
  readyState: READY_STATE,
  body,
  head: makeElement('head'),
  documentElement: makeElement('html'),
  getElementById: (id) => registry.get(id) ?? null,
  querySelector: () => null,
  querySelectorAll: () => [],
  createElement: (tag) => makeElement(tag),
  addEventListener: () => {},
  removeEventListener: () => {},
  createTextNode: (text) => ({ textContent: text }),
}

// ── 假 localStorage ───────────────────────────────────────────────────
const store = new Map([['dsh-mobile.debug', '1'], ...CONSENT])
const localStorageStub = {
  getItem: (key) => store.get(key) ?? null,
  setItem: (key, value) => void store.set(key, String(value)),
  removeItem: (key) => void store.delete(key),
  clear: () => store.clear(),
}

// ── 假 WebSocket：只求"不崩"，本脚本不验证隧道 ────────────────────────
class DeadSocket {
  constructor() {
    this.readyState = 0
    this.binaryType = 'blob'
  }
  send() {}
  close() {}
  addEventListener() {}
  removeEventListener() {}
}

const sandbox = {
  console, // 真 console：抛错时会连栈一起打出来，正是我们要看的
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
  setInterval,
  clearInterval,
  atob: (value) => Buffer.from(value, 'base64').toString('binary'),
  btoa: (value) => Buffer.from(value, 'binary').toString('base64'),
  location: {
    origin: 'https://10.34.221.181:3443',
    protocol: 'https:',
    host: '10.34.221.181:3443',
    pathname: PATHNAME,
    search: SEARCH,
    href: 'https://10.34.221.181:3443' + PATHNAME + SEARCH,
  },
  document: documentStub,
  localStorage: localStorageStub,
  history: { replaceState: () => {}, pushState: () => {} },
  navigator: {
    userAgent: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129 Mobile Safari/537.36',
    vibrate: () => true,
    // serviceWorker 故意不给：真实手机会有，但它属于"隧道/通知"层，
    // 本脚本只关心引导层的执行路径，给了反而会把异步噪声引进来。
  },
  Notification: { permission: 'granted', requestPermission: async () => 'granted' },
  WebSocket: DeadSocket,
  fetch: async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }),
  MutationObserver: class {
    observe() {}
    disconnect() {}
  },
  innerWidth: 412,
  innerHeight: 915,
  isSecureContext: true,
  matchMedia: () => ({ matches: true, addEventListener: () => {}, removeEventListener: () => {} }),
  addEventListener: () => {},
  removeEventListener: () => {},
  performance: globalThis.performance,
}
sandbox.globalThis = sandbox
sandbox.window = sandbox
sandbox.self = sandbox
sandbox.top = sandbox
sandbox.parent = sandbox

// ── 跑 ────────────────────────────────────────────────────────────────
console.log(`── 文件：${bootFile}`)
console.log(`── 复现：${PATHNAME}${SEARCH}  readyState=${READY_STATE}  同意记录=${CONSENT.length === 0 ? '(空)' : CONSENT.map(([k, v]) => k.replace('dsh-mobile.deviceEnabled.', '') + '=' + v).join(' ')}`)
console.log('─'.repeat(72))
try {
  runInNewContext(bootSource, sandbox, { filename: 'boot.js' })
} catch (error) {
  console.log('!! 顶层抛出：' + (error && error.stack ? error.stack : error))
}

await new Promise((resolve) => setTimeout(resolve, SETTLED_MS))

const box = registry.get('dshm-upload-debug')
console.log(box ? box.textContent.trim() : '(调试框根本没被创建)')
console.log('─'.repeat(72))
console.log(`调试框元素：${box ? '已创建' : '不存在'}`)
process.exit(0)
