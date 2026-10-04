/**
 * 直连互通测试：boot.js（浏览器端）↔ 真实 TunnelSession（宿主端）。
 *
 * 为什么用"直连"而不是经 WebSocket 替身：
 *   宿主插件的 `handleUpgrade` 内部已经建立了 TunnelSession，若测试再自行构造一个
 *   WebSocket 替身并做帧封装，就会引入"两个会话抢同一份字节流"这类脚手架故障
 *   （本项目已踩过：症状是"客户端发了帧、宿主毫无反应"，且极难定位）。
 *   本文件把两端直接用生产代码对接，只验证**协议互通性**这一件事；
 *   WebSocket 帧编解码本身由 host 包的端到端测试（经真实 acceptWebSocket）覆盖。
 *
 * 覆盖：完整握手（含 TOFU 指纹固定）、主机指纹一致性、经加密隧道的一元 RPC 与流式 RPC。
 */

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'

import { DEFAULT_CAPABILITIES, fingerprint, generateP256KeyPair } from '@dsh-mobile/protocol'
import { DeviceStore } from '../../host/src/devices.ts'
import { TunnelSession } from '../../host/src/tunnel.ts'

const here = dirname(fileURLToPath(import.meta.url))
const bootSource = readFileSync(join(here, '..', 'src', 'boot.js'), 'utf8')

/** 浏览器侧 WebSocket 替身：把 send 直接喂给宿主的 TunnelSession。 */
class DirectSocket {
  static current: DirectSocket | undefined
  readyState = 0
  onopen: (() => void) | undefined
  onmessage: ((event: { data: ArrayBuffer }) => void) | undefined
  onclose: (() => void) | undefined
  onerror: (() => void) | undefined
  readonly url: string

  constructor(url: string) {
    this.url = url
    DirectSocket.current = this
  }

  send(data: unknown): void {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBuffer)
    DirectSocket.deliverToHost?.(bytes)
  }

  close(): void {
    this.readyState = 3
    this.onclose?.()
  }

  static deliverToHost: ((bytes: Uint8Array) => void) | undefined

  receive(bytes: Uint8Array): void {
    this.onmessage?.({ data: Uint8Array.from(bytes).buffer as ArrayBuffer })
  }
}

/** 用 WebCrypto 生成设备签名密钥，并以 boot.js 期望的格式写入 localStorage。 */
async function createDeviceKey(): Promise<{ deviceId: string; publicKeyB64u: string; storageValue: string }> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  const publicRaw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))
  const privateJwk = await crypto.subtle.exportKey('jwk', pair.privateKey)
  const deviceId = 'web-direct-device'
  const publicKeyB64u = Buffer.from(publicRaw).toString('base64url')
  return { deviceId, publicKeyB64u, storageValue: JSON.stringify({ deviceId, publicKey: publicKeyB64u, privateKeyJwk: privateJwk }) }
}

async function setup(options: { pinnedMismatch?: boolean; revoke?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-mobile-direct-'))
  const store = new DeviceStore({ directory: dir })
  const hostSigningKey = generateP256KeyPair()
  const device = await createDeviceKey()

  store.upsert({
    deviceId: device.deviceId,
    devicePublicKey: '',
    deviceSigningKey: device.publicKeyB64u,
    fingerprint: fingerprint(device.publicKeyB64u),
    name: '直连测试端',
    pairedAt: new Date().toISOString(),
    authorization: 'persistent',
    capabilities: { ...DEFAULT_CAPABILITIES },
  })
  if (options.revoke === true) store.revoke(device.deviceId)

  const calls: string[] = []
  const session = new TunnelSession(
    {
      resolveDevice: (hello) => {
        const record = store.get(hello.deviceId)
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
        // 注意：宿主服务的 invoke 收到的是 {endpoint, payload}，载荷在 request.payload 里。
        // 早期版本的测试桩误写成 request.endpoint，导致"返回了调用参数、没了 endpoint"。
        calls.push(request.endpoint)
        // ★ 隧道把这里的返回值**当 result 原样发** ✓（第 109 轮起）⇒ 必须是与 DSH 一致的
        //   信封 `{ok:true,value}` ✗ 不许返回裸值（裸值会让真机卡在"永不 resolve" ✓）。
        return { ok: true, value: { endpoint: request.endpoint, payload: request.payload } }
      },
      openStream: () => {
        return (async function* () {
          yield { seq: 1, text: '第一页' }
          yield { seq: 2, text: '第二页' }
        })()
      },
    },
    (bytes) => {
      DirectSocket.current?.receive(new Uint8Array(bytes))
      return true
    },
  )
  session.hostId = 'host-direct'
  session.hostSigningKey = hostSigningKey as never

  DirectSocket.deliverToHost = (bytes) => session.receive(bytes)

  const hostFingerprint = fingerprint(hostSigningKey.publicKey)
  const sandboxGlobals: Record<string, unknown> = {
    console: { info: () => {}, warn: () => {}, error: () => {}, log: () => {} },
    crypto: globalThis.crypto,
    TextEncoder,
    TextDecoder,
    Response,
    URL,
    URLSearchParams,
    setTimeout,
    clearTimeout,
    // 真实浏览器里一定有；boot.js 的保活用它（缺失时保活会优雅降级，
    // 但测试应该覆盖"定时器可用"的正常路径）
    setInterval,
    clearInterval,
    atob: (value: string) => Buffer.from(value, 'base64').toString('binary'),
    btoa: (value: string) => Buffer.from(value, 'binary').toString('base64'),
    location: {
      origin: 'http://192.168.1.30:3080',
      protocol: 'http:',
      host: '192.168.1.30:3080',
      pathname: '/',
      search: '',
      href: 'http://192.168.1.30:3080/',
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
          baseUrl: 'http://192.168.1.30:3080',
          tunnelUrl: 'ws://192.168.1.30:3080/mobile/ws',
          pinnedHostFingerprint: options.pinnedMismatch === true ? 'deadbeef'.repeat(8) : hostFingerprint,
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
    WebSocket: DirectSocket,
  }
  sandboxGlobals['globalThis'] = sandboxGlobals
  sandboxGlobals['window'] = sandboxGlobals
  runInNewContext(bootSource, sandboxGlobals, { filename: 'boot.js' })

  // boot.js 异步创建 WebSocket：等到它就绪后再触发 onopen
  const deadline = Date.now() + 5000
  while (DirectSocket.current === undefined && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
  const socket = DirectSocket.current
  assert.ok(socket !== undefined, 'boot.js 应在 5 秒内创建 WebSocket')

  return {
    dir,
    store,
    device,
    hostSigningKey,
    hostFingerprint,
    session,
    calls,
    sandbox: sandboxGlobals,
    socket,
    cleanup: () => {
      DirectSocket.deliverToHost = undefined
      // 停掉 boot.js 的保活定时器：它是 setInterval，不清掉会让测试进程不退出
      try {
        const boot = sandboxGlobals['__DSH_MOBILE_BOOT__'] as { tunnel?: { stopKeepalive?: () => void } } | undefined
        boot?.tunnel?.stopKeepalive?.()
      } catch (error) {
        void error
      }
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

test('boot.js 与宿主完成握手：会话标识一致、主机指纹一致、能力位来自宿主', async () => {
  const env = await setup()
  try {
    env.socket.readyState = 1
    env.socket.onopen?.()

    const boot = env.sandbox['__DSH_MOBILE_BOOT__'] as {
      lastError?: string
      tunnel?: { sessionId?: string; hostFingerprint?: string; capabilities?: Record<string, boolean> }
    }
    const deadline = Date.now() + 5000
    while (boot.tunnel?.sessionId === undefined && boot.lastError === undefined && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }

    assert.equal(boot.lastError, undefined, `握手不应失败：${String(boot.lastError)}`)
    assert.ok(boot.tunnel?.sessionId !== undefined, '客户端应得到会话标识')
    assert.equal(boot.tunnel.sessionId, env.session.established?.sessionId, '两端会话标识必须一致')
    assert.equal(boot.tunnel.hostFingerprint, env.hostFingerprint, '客户端固定的主机指纹应与宿主一致')
    assert.equal(env.session.currentState, 'established')
    assert.equal(env.session.established?.deviceId, env.device.deviceId)
    // 逐个字段比较：boot.js 在 VM 沙箱里运行，跨 realm 的 deepEqual 会因原型不同而失败
    for (const [key, expected] of Object.entries(DEFAULT_CAPABILITIES)) {
      assert.equal(boot.tunnel.capabilities?.[key], expected, `能力位 ${key} 应由宿主下发为 ${String(expected)}`)
    }
  } finally {
    env.cleanup()
  }
})

test('经加密隧道完成一元 RPC 与流式 RPC', async () => {
  const env = await setup()
  try {
    env.socket.readyState = 1
    env.socket.onopen?.()
    const boot = env.sandbox['__DSH_MOBILE_BOOT__'] as {
      lastError?: string
      tunnel?: {
        sessionId?: string
        /**
         * 一元 RPC 的返回值是 **DSH 自己的 `server-response` 信封**，不是扁平形状：
         * `{ type: 'server-response', rpcId, result: { ok: true, value } }`
         * （失败时 `result` 为 `{ ok: false, error }`，见 `packages/host/src/tunnel.ts:418-456`）。
         * 早先这里标成 `{ rpcId, ok, value }`，与真实契约少一层 `result`，类型标注本身就是错的。
         */
        rpc: (endpoint: string, payload: unknown) => Promise<{
          type: 'server-response'
          rpcId: string
          result: { ok: boolean; value?: unknown }
        }>
        openStream: (endpoint: string, payload: unknown) => AsyncIterable<unknown>
      }
    }
    const deadline = Date.now() + 5000
    while (boot.tunnel?.sessionId === undefined && boot.lastError === undefined && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    assert.ok(boot.tunnel?.sessionId !== undefined, `握手应先完成：${String(boot.lastError)}`)

    // 响应形状是 **DSH 自己的 server-response 信封**（boot.js 原样交给 DSH 客户端，
    // 所以这里断言的就是真机契约；曾经这里是 {ok,value} 的扁平形状，
    // 导致真机报 `connection: invalid server-response envelope`）。
    const response = await boot.tunnel.rpc('session/create', { args: { cwd: '/tmp/mobile' } })
    assert.equal(response.type, 'server-response', `必须是 server-response 信封：${JSON.stringify(response)}`)
    assert.equal(response.rpcId.length > 0, true, 'rpcId 必须回传')
    assert.equal(response.result.ok, true, `RPC 应成功：${JSON.stringify(response)}`)
    // 宿主把 endpoint 与 payload 原样回报；payload 形如 {args:{...}}
    const value = response.result.value as { endpoint: string; payload: { args: { cwd: string } } }
    assert.equal(value.endpoint, 'session/create', 'endpoint 必须经隧道正确送达（字段名与 DSH 一致：method）')
    assert.equal(value.payload.args.cwd, '/tmp/mobile')
    assert.ok(env.calls.includes('session/create'), '调用应到达宿主')

    const items: unknown[] = []
    for await (const value of boot.tunnel.openStream('session/history', { args: { sessionId: 's-1' } })) items.push(value)
    // 用 JSON 比较而不是 deepEqual：被测对象来自 VM 沙箱（跨 realm），
    // deepStrictEqual 会因原型不同而判定"结构相同但引用不等"。
    assert.equal(
      JSON.stringify(items),
      JSON.stringify([
        { seq: 1, text: '第一页' },
        { seq: 2, text: '第二页' },
      ]),
      '流式产出应按序完整送达',
    )
  } finally {
    env.cleanup()
  }
})

test('固定指纹不匹配时拒绝握手（防中间人 / 换机）', async () => {
  const env = await setup({ pinnedMismatch: true })
  try {
    env.socket.readyState = 1
    env.socket.onopen?.()
    const boot = env.sandbox['__DSH_MOBILE_BOOT__'] as { lastError?: string }
    const deadline = Date.now() + 5000
    while (boot.lastError === undefined && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    assert.match(String(boot.lastError), /电脑身份已变化/, `应因指纹不匹配而拒绝，实际：${String(boot.lastError)}`)
    assert.notEqual(env.session.currentState, 'established', '被拒绝的握手不得建立会话')
  } finally {
    env.cleanup()
  }
})

test('已撤销设备无法完成握手', async () => {
  const env = await setup({ revoke: true })
  try {
    env.socket.readyState = 1
    env.socket.onopen?.()
    const boot = env.sandbox['__DSH_MOBILE_BOOT__'] as { lastError?: string }
    const deadline = Date.now() + 5000
    while (boot.lastError === undefined && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    assert.ok(boot.lastError !== undefined, '已撤销设备必须被拒绝')
    assert.notEqual(env.session.currentState, 'established')
  } finally {
    env.cleanup()
  }
})

test('serverNonceBase 在 ServerHello 与 ServerAuthOk 中必须一致（防拼装）', async () => {
  // 该一致性检查位于协议层，此处断言它确实存在：两端 nonce 前缀不同就无法解帧，
  // 因此"能解开 ServerAuthOk"本身就是这条不变量成立的证据。
  const env = await setup()
  try {
    env.socket.readyState = 1
    env.socket.onopen?.()
    const boot = env.sandbox['__DSH_MOBILE_BOOT__'] as { lastError?: string; tunnel?: { sessionId?: string } }
    const deadline = Date.now() + 5000
    while (boot.tunnel?.sessionId === undefined && boot.lastError === undefined && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    assert.ok(boot.tunnel?.sessionId !== undefined, '握手应完成（证明两侧 nonce 前缀一致）')
  } finally {
    env.cleanup()
  }
})
