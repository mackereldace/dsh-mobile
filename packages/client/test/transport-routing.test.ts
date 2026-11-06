/**
 * 主传输（`__DSH_TRANSPORT__.fetch`）的路由判据：**哪些请求走隧道、哪些交还原生**。
 *
 * ## 为什么要有它（2026-11-05 真机事故，代价一整轮）
 *
 * 为了修「`plugins/events`（SSE，没有 RPC 信封）被当成信封」这个问题，第一版判据写成了
 * 「**路径**必须以 `/api/` 开头才算 RPC」✗。而 DSH 的连接层发的是**相对地址**：
 *
 * ```js
 * // dsh-client-connection/lib/client.browser.js → createWebConnectionRpc
 * await send(`${channel}/${endpoint}`.slice(1), { … })   // ⇒ 'api/session/list'（无前导斜杠）
 * ```
 *
 * `new URL('api/session/list', location.href)` 的基准是 `/mobile/app` ⇒ 解析成
 * **`/mobile/api/session/list`** ⇒ 前缀不是 `/api/` ⇒ 被当成"非 RPC"交还原生 fetch ⇒
 * 页面绕开加密隧道、直接对 DSH 的鉴权栅栏发请求 ⇒ **401/403**。
 * 真机现象（用户原话）：**「无法选择新建对话，显示 403」+「左侧边栏每一项都点不开」**
 * ——因为 `session/list` / `session/create` / `session/prompt` **一条都没进隧道** ✗。
 *
 * 现在的判据只看**信封里有没有 `method` 字符串**（与 0.2.1 完全一致 ✓），
 * 与 URL 形状彻底解耦。这个文件把三种真实形状钉死：
 *   ① 有信封（相对地址）⇒ 必须进隧道；
 *   ② 没有 body（`plugins/events` 的 SSE GET）⇒ 必须交还原生；
 *   ③ 有 body 但不是信封（`{}`）⇒ 必须交还原生。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const BOOT = readFileSync(join(here, '..', 'src', 'boot.js'), 'utf8')

/** 切出主传输那一段（`globalThis.__DSH_TRANSPORT__ = { … }` 到那次赋值的结束大括号 ✓）。 */
function transportBlock(): string {
  const start = BOOT.indexOf('globalThis.__DSH_TRANSPORT__ = {')
  assert.ok(start >= 0, 'boot.js 里找不到主传输（__DSH_TRANSPORT__ ✓）')
  const ownsAt = BOOT.indexOf('ownsHost: true,', start)
  assert.ok(ownsAt > start, '主传输里找不到 ownsHost ✓')
  const closeAt = BOOT.indexOf('\n    }\n', ownsAt)
  assert.ok(closeAt > ownsAt, '主传输那个对象的结束大括号应当能在第 4 列找到 ✓')
  return BOOT.slice(start, closeAt + 6)
}

interface Call {
  kind: 'tunnel' | 'native'
  method?: string
  rpcId?: string
}

/** 把主传输装进一个假环境（隧道 / 原生 fetch 都换成本地记录器 ✓）。 */
function buildTransport(): { fetch(input: unknown, init?: unknown): Promise<unknown>; calls: Call[] } {
  const source = [
    'var calls = []',
    'var fakeGlobal = { fetch: function (input, init) { calls.push({ kind: "native" }); return Promise.resolve({ native: true }) } }',
    'var globalThis = fakeGlobal',
    'var tunnel = { rpc: function (method, payload, rpcId) { calls.push({ kind: "tunnel", method: method, rpcId: rpcId }); return Promise.resolve({ rpcId: rpcId, result: { ok: true, value: 1 } }) } }',
    'var buildBinaryResponse = function () { return undefined }',
    'var debugBoxLine = function () {}',
    'var fromUtf8 = function (bytes) { return String.fromCharCode.apply(null, bytes) }',
    transportBlock(),
    'return { transport: fakeGlobal.__DSH_TRANSPORT__, calls: calls }',
  ].join('\n')
  const factory = new Function(source) as () => {
    transport: { fetch(input: unknown, init?: unknown): Promise<unknown> }
    calls: Call[]
  }
  const world = factory()
  return { fetch: world.transport.fetch, calls: world.calls }
}

const rpcBody = (method: string, rpcId = 'r1'): string =>
  JSON.stringify({ type: 'client-request', rpcId, method: method, payload: { args: {} } })

test('★★ 相对地址 + 有信封 ⇒ 必须走隧道（真机那次 403/侧栏点不动的正解）', async () => {
  const { fetch, calls } = buildTransport()
  await fetch('api/session/list', { method: 'POST', body: rpcBody('session/list', 'r7') })
  assert.deepEqual(calls, [{ kind: 'tunnel', method: 'session/list', rpcId: 'r7' }], '★ 相对地址也必须进隧道')
})

test('★ 绝对地址 + 有信封 ⇒ 走隧道', async () => {
  const { fetch, calls } = buildTransport()
  await fetch('/api/session/create', { method: 'POST', body: rpcBody('session/create') })
  assert.equal(calls.length, 1)
  assert.equal(calls[0]?.kind, 'tunnel')
  assert.equal(calls[0]?.method, 'session/create')
})

test('★★ 没有 body 的 GET（`plugins/events` 的 SSE）⇒ 交还原生，绝不进隧道', async () => {
  const { fetch, calls } = buildTransport()
  await fetch('plugins/events', { method: 'GET' })
  assert.deepEqual(calls, [{ kind: 'native' }], '★ 没有信封的请求一个字节都不许进隧道')
})

test('★ 有 body 但不是信封 ⇒ 交还原生（别把 `{}` 当成 RPC）', async () => {
  const { fetch, calls } = buildTransport()
  await fetch('/api/session/list', { method: 'POST', body: '{}' })
  assert.deepEqual(calls, [{ kind: 'native' }])
})

test('★★ 判据不许再看 URL 前缀或 `location`（那次事故的形状，源码级反例）', () => {
  // ★ 只看**可执行行**（注释里会出现"`location.href`"这个词 ✓ —— 那是解释，不是代码 ✗）
  const block = transportBlock()
    .split('\n')
    .filter((line) => {
      const text = line.trim()
      return !(text.startsWith('*') || text.startsWith('/*') || text.startsWith('//'))
    })
    .join('\n')
  assert.ok(
    !block.includes("indexOf('/api/')") && !block.includes('path.pathname'),
    '★ 主传输里不许再出现"按 URL 路径判 RPC"——DSH 传的是相对地址，一按路径就全打回原生 ✗',
  )
  assert.ok(!block.includes('location.href'), '★ 也不许拿 `location.href` 当解析基准（会解析成 /mobile/api/… ✗）')
  assert.ok(block.includes("typeof envelope.method !== 'string'"), '★ 判据只认信封里的 method ✓')
})
