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

async function setup(options: { pinnedMismatch?: boolean; revoke?: boolean; attachment?: Uint8Array } = {}) {
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
        /**
         * ★ 第 126 轮：`attachment` 一给，桩就返回**DSH 网关那种形状**
         *   （`encodeRpcResult` ✓：字节换成 `null` 占位 + 收进附件表 ✓，
         *   见 `dsh-api-gateway/lib/index.js:1120` ✓）—— 让端到端测试能真的走一遍
         *   「宿主编码 → 隧道 → 客户端解码 → 交 multipart Response」✓。
         */
        if (options.attachment !== undefined) {
          return { ok: true, value: { data: null }, attachments: [{ path: ['data'], bytes: options.attachment }] }
        }
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
    /**
     * ★ 第 126 轮：交付 multipart 需要这两个 ✓（Node 与浏览器同规范 ✓；注入的是**外层那一个** ✓，
     *   于是测试里 `instanceof Blob` 不会因跨 realm 假掉 ✓）。
     */
    FormData,
    Blob,
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

/**
 * ★★★ 第 126 轮：「帧 → multipart `Response` → 还原」的**纯函数级**断言（不需要浏览器）。
 *
 * 为什么在这儿测 ✗：`buildBinaryResponse` 是 boot.js 里的纯函数 ✓，唯一的外部依赖是
 * `FormData` / `Blob` / `Response`（沙箱里注入的就是 Node 自己那三个 ✓，与浏览器同规范 ✓）。
 * 于是「帧里的字节 → 交出去的响应 → 按附件表取回原字节」这一整段能在电脑上跑 ✓，
 * 不必等真机 ✗（真机只能回答「报错还在不在」✗，分不出是哪一段错 ✓）。
 *
 * 四条断言正好是 DSH 的 `parseBinaryResponse`（`client.js:1240`）要的四个条件 ✓：
 *   ① `content-type` 以 `multipart/form-data` 开头 ✓（它按这个分流 ✓）；
 *   ② `metadata` 分片是**字符串**且能过 `parseConnectionResponse`（type / rpcId / result.ok ✓）；
 *   ③ 附件表在**信封顶层** ✓、三项逐字为 `{path, codec:'bytes', part}` ✓；
 *   ④ 落点是 **`null` 占位** ✓，`bytes-<n>` 是 Blob 且字节**逐字节相等** ✓（含 250..255 ✓）。
 */
test('★★ 带附件表的帧 ⇒ 交一枚真正的 multipart Response（字节活着到还原那一刻）', async () => {
  const env = await setup()
  try {
    const internals = env.sandbox['__DSH_MOBILE_INTERNALS__'] as {
      buildBinaryResponse: (response: unknown) => Response | undefined
    }
    assert.equal(typeof internals.buildBinaryResponse, 'function', 'boot.js 应把交付函数暴露给测试')

    const bytes = new Uint8Array([0, 1, 2, 3, 250, 251, 252, 253, 254, 255])
    const frame = {
      type: 'server-response',
      rpcId: 'rpc-multipart-1',
      result: { ok: true, value: { data: null }, attachments: [{ path: ['data'], bytes }] },
    }
    const response = internals.buildBinaryResponse(frame)
    assert.ok(response !== undefined, '有附件表就必须交 multipart（不许退回 JSON）')
    assert.match(String(response.headers.get('content-type')), /^multipart\/form-data;/, 'DSH 按这个 content-type 分流')

    const form = await response.formData()
    const metadata = JSON.parse(String(form.get('metadata'))) as {
      type: string
      rpcId: string
      result: { ok: boolean; value: { data: unknown } }
      attachments: Array<{ path: unknown; codec: string; part: string }>
    }
    assert.equal(metadata.type, 'server-response', 'parseConnectionResponse 要求 type 逐字一致')
    assert.equal(metadata.rpcId, 'rpc-multipart-1', 'rpcId 必须回传（DSH 要校验它相等）')
    assert.equal(metadata.result.ok, true)
    // ★ 附件表在**信封顶层**（DSH 读的是 envelope.attachments），不在 result 里
    assert.equal(
      JSON.stringify(metadata.attachments),
      JSON.stringify([{ path: ['data'], codec: 'bytes', part: 'bytes-0' }]),
    )
    // ★ 占位必须是 null（DSH 的硬校验：不是 null 就抛 invalid binary response placeholder）
    assert.equal(metadata.result.value.data, null)

    const part = form.get('bytes-0')
    assert.ok(part instanceof Blob, 'bytes-0 必须是一个 Blob')
    const restored = new Uint8Array(await part.arrayBuffer())
    assert.equal(
      JSON.stringify(Array.from(restored)),
      JSON.stringify(Array.from(bytes)),
      '字节必须逐字节相等（含 250..255 这类高字节）',
    )

    // 没有附件表的帧 ⇒ 不许改行为（仍返回 undefined，调用方退回 JSON ✓）
    assert.equal(
      internals.buildBinaryResponse({ type: 'server-response', rpcId: 'r', result: { ok: true, value: { a: 1 } } }),
      undefined,
      '没有附件表时必须返回 undefined',
    )

    /**
     * ★★ 两套还原**共存**时不许打架（这是修完 multipart 之后最容易回归的一处 ✗）：
     *   帧处理器那套「内存里装回」可能已经把 `value.data` 填成 `Uint8Array` ✓，
     *   而 DSH 的硬校验**只认 `null`** ✓ ⇒ 交付这套必须把它**写回 `null`** ✓，
     *   字节则从附件表的 `bytes` 取 ✓（不是从被填过的那棵树里取 ✓）。
     */
    const filledFrame = {
      type: 'server-response',
      rpcId: 'rpc-multipart-2',
      result: { ok: true, value: { data: Uint8Array.from(bytes) }, attachments: [{ path: ['data'], bytes }] },
    }
    const filled = internals.buildBinaryResponse(filledFrame)
    assert.ok(filled !== undefined, '占位被填过的帧同样要交 multipart')
    const filledForm = await filled.formData()
    const filledMeta = JSON.parse(String(filledForm.get('metadata'))) as { result: { value: { data: unknown } } }
    assert.equal(filledMeta.result.value.data, null, '内存那套已经填过时，交付这套必须把它写回 null 占位')
    const filledPart = filledForm.get('bytes-0')
    assert.ok(filledPart instanceof Blob, 'bytes-0 必须仍是一个 Blob')
    assert.equal(
      JSON.stringify(Array.from(new Uint8Array(await filledPart.arrayBuffer()))),
      JSON.stringify(Array.from(bytes)),
      '字节必须从附件表取，而不是从被填过的那棵树取',
    )
  } finally {
    env.cleanup()
  }
})

/**
 * ★★★ 第 126 轮：**整条链**的端到端断言 —— 宿主编码 → 隧道帧 → 客户端解码 →
 *   传输层交出的响应。
 *
 * 为什么还要这一条（纯函数那条不够 ✗）：纯函数那条只证明「给它一帧，它交得对」✓，
 *   证明不了**传输层真的会在那儿交** ✗ —— 我把它改成 `if (false) return …`（永不交 ✓）
 *   时，纯函数那条与位置那条**都是绿的** ✓（变异验证当场抓出来的假闸 ✓）。
 *   这一条从 `__DSH_TRANSPORT__.fetch` 进去，所以「没交」它一定红 ✓。
 */
test('★★ 整条链：带附件表的帧 ⇒ 传输层交出 multipart Response ⇒ 字节逐字节回来', async () => {
  const attachment = new Uint8Array([0, 1, 2, 3, 250, 251, 252, 253, 254, 255])
  const env = await setup({ attachment })
  try {
    env.socket.readyState = 1
    env.socket.onopen?.()
    const boot = env.sandbox['__DSH_MOBILE_BOOT__'] as { lastError?: string; tunnel?: { sessionId?: string } }
    const deadline = Date.now() + 5000
    while (boot.tunnel?.sessionId === undefined && boot.lastError === undefined && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    assert.ok(boot.tunnel?.sessionId !== undefined, `握手应先完成：${String(boot.lastError)}`)

    const transport = env.sandbox['__DSH_TRANSPORT__'] as {
      fetch: (input: string, init: { method: string; body: string }) => Promise<Response>
    }
    const response = await transport.fetch('api/workspaceFiles/readBytes', {
      method: 'POST',
      body: JSON.stringify({
        type: 'client-request',
        rpcId: 'rpc-att-1',
        method: 'workspaceFiles/readBytes',
        payload: { args: {} },
      }),
    })
    assert.match(
      String(response.headers.get('content-type')),
      /^multipart\/form-data;/,
      'DSH 只按这个 content-type 分流 ⇒ 交 JSON 就等于没修',
    )
    const form = await response.formData()
    const metadata = JSON.parse(String(form.get('metadata'))) as {
      type: string
      rpcId: string
      result: { ok: boolean; value: { data: unknown } }
      attachments: Array<{ path: unknown; codec: string; part: string }>
    }
    assert.equal(metadata.type, 'server-response')
    assert.equal(metadata.rpcId, 'rpc-att-1', 'rpcId 必须回传（DSH 要校验相等）')
    assert.equal(JSON.stringify(metadata.attachments), JSON.stringify([{ path: ['data'], codec: 'bytes', part: 'bytes-0' }]))
    assert.equal(metadata.result.value.data, null, '占位必须原样留 null（DSH 会自己装回去）')

    const part = form.get('bytes-0')
    assert.ok(part instanceof Blob, 'bytes-0 必须是一个 Blob')
    const restored = new Uint8Array(await part.arrayBuffer())
    assert.equal(
      JSON.stringify(Array.from(restored)),
      JSON.stringify(Array.from(attachment)),
      '经宿主编码 + 隧道 + 客户端解码之后，字节必须逐字节回来',
    )
  } finally {
    env.cleanup()
  }
})
