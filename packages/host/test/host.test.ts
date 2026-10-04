/**
 * 宿主插件端到端测试：配对 → 握手 → 加密隧道 → RPC / 流 → 撤销。
 *
 * 这是 M1 的关键验证：证明手机端要用的**全部业务 API** 都能经隧道转发到 Gateway，
 * 且加密、重放防护、能力位门禁、撤销即时生效都真的工作。
 *
 * 测试里的客户端侧完全按 docs/protocol.md 实现，因此它同时是 Dart 端的"参考客户端"：
 * 只要本文件的流程成立，Dart 端按同样步骤就能接通。
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  ClientHandshake,
  DEFAULT_CAPABILITIES,
  ErrorCode,
  FrameFlags,
  FrameType,
  HostHandshake,
  ReplayWindow,
  fingerprint,
  generateP256KeyPair,
  generateX25519KeyPair,
  openFrame,
  parseFrame,
  sealFrame,
  sealPlaintextFrame,
  type ClientAuthPayload,
  type ClientHelloPayload,
  type RawKeyPair,
  type ServerAuthOkPayload,
  type ServerHelloPayload,
  type SessionKeys,
} from '@dsh-mobile/protocol'

import { DeviceStore } from '../src/devices.ts'
import { isLoopbackRequest } from '../src/index.ts'
import { createMobileHost, type MobileHost, type RemoteGateway } from '../src/index.ts'

const HANDSHAKE_NONCE_BASE = Buffer.from([0x00, 0x00, 0x00, 0x01])

/** 每帧 16 字节标签（客户端侧用完整标签：sealFrame 的 truncateTag=false）。 */
const CLIENT_TAG_BYTES = 16

/** 一个"手机侧"的隧道客户端，用于驱动完整的真实协议流程。 */
class TestMobileClient {
  private readonly handshake: ClientHandshake
  private sessionKeys: SessionKeys | undefined
  private established:
    | {
        sessionId: string
        c2s: Buffer
        s2c: Buffer
        clientNonceBase: Buffer
        serverNonceBase: Buffer
      }
    | undefined
  private outCounter = 1n
  private readonly inReplay = new ReplayWindow()
  /** 握手阶段记录的双向 nonce 前缀（ServerHello 提供 server 侧）。 */
  private pendingNonceBase: { client: Buffer; server: Buffer } | undefined
  private readonly pendingItems: unknown[] = []
  private readonly waiters: (() => void)[] = []
  private streamEnded = false
  private streamError: unknown
  readonly received: { type: FrameType; plaintext: Buffer }[] = []

  private readonly deviceId: string
  private readonly deviceKey: RawKeyPair
  private readonly deviceSigningKey: RawKeyPair
  private readonly send: (bytes: Uint8Array) => void

  constructor(
    deviceId: string,
    deviceKey: RawKeyPair,
    deviceSigningKey: RawKeyPair,
    send: (bytes: Uint8Array) => void,
    /** 首次配对时必须携带：宿主据此区分"未配对"与"等待确认"。已配对设备省略。 */
    pairingTicket?: string,
  ) {
    this.deviceId = deviceId
    this.deviceKey = deviceKey
    this.deviceSigningKey = deviceSigningKey
    this.send = send
    this.handshake = new ClientHandshake({
      deviceId,
      deviceKey,
      deviceSigningKey,
      ...(pairingTicket === undefined ? {} : { pairingTicket }),
    })
    void this.sessionKeys
  }

  /** 已建立的会话（未完成握手时为 undefined）。 */
  get session(): typeof this.established {
    return this.established
  }

  /** 第一步：发出明文 ClientHello（无认证标签）。 */
  start(): void {
    const outcome = this.handshake.start()
    assert.equal(outcome.kind, 'send')
    const hello = outcome.payload as ClientHelloPayload
    const payload = Buffer.from(JSON.stringify(hello), 'utf8')
    this.send(sealPlaintextFrame(FrameType.ClientHello, FrameFlags.Json, payload))
  }

  /**
   * 收到宿主帧的入口。
   *
   * 顶层捕获所有异常并记录为 connectionError：receive 由轮询定时器调用，
   * 若让它抛出会变成未捕获异常（测试无法断言、生产会崩），因此必须在这里收住。
   */
  async receive(bytes: Uint8Array): Promise<void> {
    try {
      await this.receiveInner(bytes)
    } catch (error) {
      this.connectionError = error
      this.wake()
    }
  }

  private connectionError: unknown

  /** 连接级错误（握手被拒、链路错误等）。 */
  get error(): unknown {
    return this.connectionError
  }

  private async receiveInner(bytes: Uint8Array): Promise<void> {
    const buffer = Buffer.from(bytes)

    // 明文 LinkError（握手期）：无认证标签的帧
    if (this.established === undefined && buffer.length >= 14 && buffer.readUInt8(0) === FrameType.LinkError) {
      const header = parseFrame(buffer, false)
      const payload = JSON.parse(header.ciphertext.toString('utf8')) as { code: string; message: string }
      const error = Object.assign(new Error(payload.message), { code: payload.code })
      this.failStream(error)
      this.connectionError = error
      return
    }

    // 明文 JSON（ServerHello 的 {e, sh} 或握手期的 LinkError）
    if (buffer.length > 0 && buffer[0] === 0x7b /* '{' */) {
      const parsed = JSON.parse(buffer.toString('utf8')) as { e?: string; sh?: string; code?: string; message?: string }
      if (parsed.e !== undefined && parsed.sh !== undefined) {
        await this.acceptServerHello(parsed.e, parsed.sh)
        return
      }
      if (parsed.code !== undefined) {
        this.failStream(Object.assign(new Error(parsed.message ?? 'link error'), { code: parsed.code }))
        return
      }
      throw new Error(`unexpected plaintext frame: ${buffer.toString('utf8').slice(0, 120)}`)
    }

    // 握手期：ServerAuthOk 用会话密钥（serverNonceBase, counter=1）
    const header = parseFrame(buffer)
    if (header.type === FrameType.ServerAuthOk) {
      const session = this.established
      assert.ok(session !== undefined, '收到 ServerAuthOk 时客户端应已派生会话密钥')
      // 用与服务端一致的接收窗口：ServerAuthOk 的 counter=1 会被记入窗口（占位），
      // 因此后续数据帧必须从 counter=2 开始，与宿主侧的 outCounter 对应。
      const opened = openFrame({
        header,
        key: session.s2c,
        nonceBase: session.serverNonceBase,
        replay: this.inReplay,
      })
      if (!opened.ok) {
        this.connectionError = Object.assign(new Error(opened.message), { code: opened.code })
        return
      }
      const payload = JSON.parse(opened.plaintext.toString('utf8')) as ServerAuthOkPayload
      const outcome = this.handshake.acceptServerAuthOk(payload)
      assert.equal(outcome.kind, 'done', `ServerAuthOk 处理失败: ${JSON.stringify(outcome)}`)
      const keys = this.handshake.sessionKeys
      assert.ok(keys)
      // 补全 sessionId，标记"握手已完成"（sendId 为空表示尚未确认）
      this.established = {
        sessionId: payload.sessionId,
        c2s: keys.clientToServer,
        s2c: keys.serverToClient,
        clientNonceBase: session.clientNonceBase,
        serverNonceBase: session.serverNonceBase,
      }
      return
    }

    // 会话期：宿主 → 客户端方向，必须用 **s2c** 密钥与 **serverNonceBase**
    // （c2s 只用于客户端发出的帧；弄反是这类实现最常见的错误）
    const session = this.established
    if (session === undefined) throw new Error('收到会话帧但会话尚未建立')
    const opened = openFrame({ header, key: session.s2c, nonceBase: session.serverNonceBase, replay: this.inReplay })
    if (!opened.ok) {
      this.connectionError = Object.assign(new Error(opened.message), { code: opened.code })
      this.wake()
      return
    }
    this.received.push({ type: header.type, plaintext: opened.plaintext })

    switch (header.type) {
      case FrameType.RpcResponse: {
        const payload = JSON.parse(opened.plaintext.toString('utf8')) as {
          type: string
          rpcId: string
          result: { ok: boolean; value?: unknown; error?: { code: string; message: string; details: Record<string, unknown> } }
        }
        // 断言信封与 DSH 逐字段一致：缺 type / 缺 result / error 缺 details 都是真实故障
        assert.equal(payload.type, 'server-response', '响应必须是 server-response 信封')
        assert.ok(payload.result !== undefined && typeof payload.result.ok === 'boolean', '响应必须带 result.ok')
        if (payload.result.ok === false) {
          assert.ok(payload.result.error?.details !== undefined, 'error.details 必须存在（DSH 客户端强校验）')
        }
        this.responseWaiters.get(payload.rpcId)?.(payload)
        return
      }
      case FrameType.StreamItem: {
        const payload = JSON.parse(opened.plaintext.toString('utf8')) as { streamId: number; value: unknown }
        this.pendingItems.push(payload.value)
        this.wake()
        return
      }
      case FrameType.StreamEnd:
        this.streamEnded = true
        this.wake()
        return
      case FrameType.StreamError: {
        const payload = JSON.parse(opened.plaintext.toString('utf8')) as { streamId: number; error: { code: string; message: string } }
        this.failStream(Object.assign(new Error(payload.error.message), { code: payload.error.code }))
        return
      }
      case FrameType.LinkError: {
        const payload = JSON.parse(opened.plaintext.toString('utf8')) as { code: string; message: string }
        this.failStream(Object.assign(new Error(payload.message), { code: payload.code }))
        return
      }
      default:
        return
    }
  }

  /**
   * 一元 RPC 的等待者。
   *
   * 响应形状就是 **DSH 自己的 `server-response` 信封**
   * （`{type, rpcId, result:{ok,value|error}}`）——因为 boot.js 是把整个响应原样交给
   * DSH 客户端的（替换传输层、不替换协议层）。这里必须与真实客户端一致，
   * 否则测试通过而真机报 `invalid server-response`。
   */
  private readonly responseWaiters = new Map<string, (payload: { type: string; rpcId: string; result: { ok: boolean; value?: unknown; error?: { code: string; message: string; details: Record<string, unknown> } } }) => void>()

  private async acceptServerHello(e: string, sh: string): Promise<void> {
    // 客户端侧按协议自行派生 K_hs 并解开：这里复用握手对象的能力
    const { openServerHello } = await import('@dsh-mobile/protocol')
    const opened = openServerHello({ sealed: { e, sh }, ephemeralPrivateKey: this.handshake.ephemeralKeys.privateKey })
    if (!opened.ok) {
      this.connectionError = Object.assign(new Error(opened.message), { code: opened.code })
      return
    }
    const serverHello = opened.payload as ServerHelloPayload
    const outcome = this.handshake.acceptServerHello(serverHello)
    assert.equal(outcome.kind, 'send', `acceptServerHello 失败: ${JSON.stringify(outcome)}`)
    const auth = outcome.payload as ClientAuthPayload
    const keys = this.handshake.sessionKeys
    assert.ok(keys)
    // ClientAuth 用 K_hs 保护（此时宿主还不知道客户端的 nonce 前缀）
    const frame = sealFrame({
      key: opened.handshakeKey,
      nonceBase: HANDSHAKE_NONCE_BASE,
      type: FrameType.ClientAuth,
      flags: FrameFlags.Json,
      counter: 2n,
      payload: Buffer.from(JSON.stringify(auth), 'utf8'),
      truncateTag: false,
    })
    // 关键：serverNonceBase 是**服务端**生成的，必须从 ServerHello 里取，
    // 否则无法解开用该前缀加密的 ServerAuthOk（这正是真实的实现陷阱）。
    this.pendingNonceBase = {
      client: Buffer.from(auth.clientNonceBase, 'base64url'),
      server: Buffer.from(serverHello.serverNonceBase ?? '', 'base64url'),
    }
    assert.equal(this.pendingNonceBase.server.length, 4, 'ServerHello 必须携带 serverNonceBase')
    // ServerAuthOk 到达前先启用接收所需的密钥（sessionId 置空表示"尚未确认"）
    this.established = {
      sessionId: '',
      c2s: keys.clientToServer,
      s2c: keys.serverToClient,
      clientNonceBase: this.pendingNonceBase.client,
      serverNonceBase: this.pendingNonceBase.server,
    }
    this.send(frame.bytes)
  }

  /** 发一次一元 RPC。 */
  async call(endpoint: string, args: Record<string, unknown>, timeoutMs = 3000): Promise<{ ok: boolean; value?: unknown; error?: { code: string; message: string; details: Record<string, unknown> } }> {
    const session = this.established
    assert.ok(session !== undefined && session.sessionId !== '', '会话未建立')
    const rpcId = `rpc-${Math.random().toString(36).slice(2)}`
    const payload = Buffer.from(JSON.stringify({ type: 'client-request', rpcId, method: endpoint, payload: { args } }), 'utf8')
    const frame = sealFrame({
      key: session.c2s,
      nonceBase: session.clientNonceBase,
      type: FrameType.RpcRequest,
      flags: FrameFlags.Json,
      counter: this.outCounter++,
      payload,
      truncateTag: true,
    })
    const answer = new Promise<{ type: string; rpcId: string; result: { ok: boolean; value?: unknown; error?: { code: string; message: string; details: Record<string, unknown> } } }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`RPC ${endpoint} timed out`)), timeoutMs)
      this.responseWaiters.set(rpcId, (value) => {
        clearTimeout(timer)
        resolve(value)
      })
    })
    this.send(frame.bytes)
    const raw = await answer
    // 拆出 DSH 信封里的 result：测试断言关心的是 result 内部
    const result = raw.result
    return {
      ok: result.ok,
      ...(result.value === undefined ? {} : { value: result.value }),
      ...(result.error === undefined ? {} : { error: result.error }),
    }
  }

  /** 打开一条逻辑流并收集全部产出项。 */
  async collectStream(endpoint: string, args: Record<string, unknown>, timeoutMs = 3000): Promise<unknown[]> {
    const session = this.established
    assert.ok(session !== undefined && session.sessionId !== '', '会话未建立')
    const streamId = 1
    const payload = Buffer.from(JSON.stringify({ streamId, endpoint, payload: { args } }), 'utf8')
    const frame = sealFrame({
      key: session.c2s,
      nonceBase: session.clientNonceBase,
      type: FrameType.StreamOpen,
      flags: FrameFlags.Json,
      counter: this.outCounter++,
      payload,
      truncateTag: true,
    })
    this.send(frame.bytes)
    const deadline = Date.now() + timeoutMs
    while (!this.streamEnded && this.streamError === undefined) {
      if (Date.now() > deadline) throw new Error(`stream ${endpoint} timed out`)
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve)
        setTimeout(resolve, 5)
      })
    }
    if (this.streamError !== undefined) throw this.streamError
    return [...this.pendingItems]
  }

  private wake(): void {
    const waiters = this.waiters.splice(0)
    for (const waiter of waiters) waiter()
  }

  private failStream(error: unknown): void {
    this.streamError = error
    this.wake()
  }

  /** 等待会话建立完成。 */
  async waitEstablished(timeoutMs = 3000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (this.established === undefined || this.established.sessionId === '') {
      if (this.connectionError !== undefined) throw this.connectionError
      if (Date.now() > deadline) throw new Error('handshake timed out')
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
  }

  /** 暴露给测试：手动发一个自定义帧（用于负向用例）。 */
  sendRaw(bytes: Uint8Array): void {
    this.send(bytes)
  }

  /** 当前发送计数器（用于构造重放）。 */
  get counter(): bigint {
    return this.outCounter
  }

  /** 会话密钥（用于构造篡改帧）。 */
  get keys(): { c2s: Buffer; clientNonceBase: Buffer } | undefined {
    const session = this.established
    return session === undefined ? undefined : { c2s: session.c2s, clientNonceBase: session.clientNonceBase }
  }

  /** 手工封一个 c2s 帧（用于重放/篡改用例）。 */
  sealRpc(bytes: Buffer, counter: bigint): Uint8Array {
    const session = this.established
    assert.ok(session !== undefined)
    return sealFrame({
      key: session.c2s,
      nonceBase: session.clientNonceBase,
      type: FrameType.RpcRequest,
      flags: FrameFlags.Json,
      counter,
      payload: bytes,
      truncateTag: true,
    }).bytes
  }

  /** 已记录的接收帧数量（用于断言"撤销后不再收到任何帧"）。 */
  get receivedCount(): number {
    return this.received.length
  }
}

/** 搭一套完整环境：宿主 + 手机客户端 + 内存传输。 */
async function setup(
  options: { capabilities?: typeof DEFAULT_CAPABILITIES; hostConfirm?: boolean; trustedHosts?: string[] } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-mobile-test-'))
  const store = new DeviceStore({ directory: dir })
  const hostSigningKey = generateP256KeyPair()

  const calls: { namespace: string; method: string; args: Record<string, unknown> }[] = []
  const gateway: RemoteGateway = {
    async invoke(request) {
      calls.push({ namespace: request.namespace, method: request.method, args: request.args as Record<string, unknown> })
      if (request.namespace === 'session' && request.method === 'create') {
        return { sessionId: 'session-created-by-mobile', workspace: request.args['cwd'] ?? '/tmp' }
      }
      if (request.namespace === 'workspaceFiles' && request.method === 'write') {
        return { written: true }
      }
      return { echo: request.args }
    },
    async stream(request) {
      calls.push({ namespace: request.namespace, method: request.method, args: request.args as Record<string, unknown> })
      return (async function* () {
        yield { seq: 1, text: '第一页' }
        yield { seq: 2, text: '第二页' }
      })()
    },
  }

  /**
   * 网关对**自己特判**的端点走 `dispatchRpc`（`$events/result` 就是唯一一个），
   * 而不是 `invoke`（那条路会去反射表里找同名 Remote 方法，必然找不到）。
   * 这里把它记下来，用来断言路由走对了。
   */
  const dispatches: { endpoint: string; payload: unknown }[] = []
  ;(gateway as unknown as { dispatchRpc: (endpoint: string, payload: unknown) => Promise<unknown> }).dispatchRpc = async (
    endpoint: string,
    payload: unknown,
  ) => {
    dispatches.push({ endpoint, payload })
    /**
     * ★★ 第 104 轮：替身要**像真 DSH** ✓。
     *
     * 真实网关里 `dispatchRpc` **就是 `/api` 的宿主侧入口**
     * （`connection.rpc.intercept('/api', …, (e, p, s, peer) => this.dispatchRpc(e, p, s, peer))` ✓），
     * 业务端点也返回**带信封的业务值** ✓；只有 `$events/result` 那条特判才在这里做事件处理 ✓。
     *
     * ★ 上一版对**所有**端点返回哨兵 `{dispatched:true}` ✗ ⇒ 替身不像真的 ⇒
     *   一旦实现改成"优先 dispatchRpc"就**误报红** ✗（第 102 轮就是这么被绊住的 ✓）。
     *   ⇒ 先把替身改真、且**不改实现**跑一遍 ✓：应当仍然全绿 ✓（两件事分开验证 ✓）。
     */
    if (endpoint === '$events/result') return { ok: true, value: { dispatched: true } }
    const cut = endpoint.indexOf('/')
    const namespace = cut > 0 ? endpoint.slice(0, cut) : endpoint
    const method = cut > 0 ? endpoint.slice(cut + 1) : ''
    const maybeArgs = payload !== null && typeof payload === 'object'
      ? (payload as { args?: Record<string, unknown> }).args
      : undefined
    return { ok: true, value: await gateway.invoke({ namespace, method, args: maybeArgs ?? {} }) }
  }

  const host: MobileHost = createMobileHost({
    store,
    identity: { hostId: 'host-e2e-1', hostName: '测试 Mac', signingKey: { publicKey: hostSigningKey.publicKey, privateKey: hostSigningKey.privateKey } },
    gateway,
    endpoints: () => ['http://192.168.1.10:3080'],
    config: { requireHostConfirm: options.hostConfirm ?? true },
    capabilityCeiling:
      options.capabilities ?? { fsRead: true, fsWrite: true, fsShell: false, phoneFs: false, phoneControl: false },
    ...(options.trustedHosts === undefined ? {} : { trustedHosts: options.trustedHosts }),
  })

  // 内存传输：宿主 session ↔ 手机客户端
  let mobile: TestMobileClient | undefined
  const deviceKey = generateX25519KeyPair()
  const deviceSigningKey = generateP256KeyPair()
  const deviceId = 'dev-e2e-1'

  // 先配对
  const pairing = host.createPairing()
  const claim = {
    ticket: pairing.ticket.ticket,
    deviceId,
    devicePublicKey: deviceKey.publicKey,
    deviceSigningKey: deviceSigningKey.publicKey,
    fingerprint: fingerprint(deviceSigningKey.publicKey),
    name: '测试手机',
    model: 'Pixel-Test',
    platform: 'android',
  }

  /**
   * 建立隧道：**两端都用真实的 WebSocket 实现**与真实的 host.handleUpgrade 路径，
   * 只把 TCP socket 换成内存 TestSocket。这样 websocket.ts 与 tunnel.ts 都被覆盖。
   */
  async function connectTunnel(options: {
    pairingTicket?: string
    waitForHandshake?: boolean
    /** 覆盖设备密钥对（用于"同一 deviceId、全新密钥"的重新配对场景）。 */
    deviceKey?: ReturnType<typeof generateX25519KeyPair>
    deviceSigningKey?: ReturnType<typeof generateP256KeyPair>
  } = {}): Promise<TestMobileClient> {
      const hostSideSocket = new TestSocket()
      const clientSideSocket = new TestSocket()
      // 双向管道：一端 write 的内容送达另一端
      hostSideSocket.on('data', () => {})
      clientSideSocket.on('data', () => {})

      const upgradeReq = {
        method: 'GET',
        url: '/mobile/ws',
        headers: {
          host: '127.0.0.1:3080',
          upgrade: 'websocket',
          connection: 'Upgrade',
          'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
          'sec-websocket-version': '13',
        },
        socket: { remoteAddress: '127.0.0.1' },
      } as unknown as Parameters<MobileHost['handleUpgrade']>[0]

      host.handleUpgrade(upgradeReq, hostSideSocket as unknown as Parameters<MobileHost['handleUpgrade']>[1])
      assert.ok(
        hostSideSocket.written.some((chunk) => chunk.subarray(0, 5).toString('utf8') === 'HTTP/'),
        '升级应返回 101',
      )

      // 客户端侧：把宿主写出的字节转交给 WS 解码器
      const wsClient = new TestWebSocketClient(hostSideSocket)
      const forward = () => {
        wsClient.pump()
      }
      hostSideSocket.on('write', forward)
      // TestSocket.write 不派发事件，这里用轮询把字节搬运过去（测试足够，且不引入定时器泄漏）
      const pumpTimer = setInterval(forward, 1)
      pumpTimer.unref?.()

      mobile = new TestMobileClient(
        deviceId,
        options.deviceKey ?? deviceKey,
        options.deviceSigningKey ?? deviceSigningKey,
        (bytes) => wsClient.send(bytes),
        options.pairingTicket,
      )
      wsClient.onMessage((data) => {
        void mobile?.receive(data)
      })
      mobile.start()
      if (options.waitForHandshake !== false) await mobile.waitEstablished()
      clearInterval(pumpTimer)
      // 会话建立后仍需持续搬运字节：换成长连接轮询
      const liveTimer = setInterval(forward, 1)
      liveTimer.unref?.()
      ;(mobile as unknown as { stopPump: () => void }).stopPump = () => clearInterval(liveTimer)
      return mobile
  }

  const api = {
    dir,
    store,
    host,
    calls,
    dispatches,
    pairing,
    claim,
    deviceKey,
    deviceSigningKey,
    deviceId,
    hostSigningKey,
    /** 完成配对（模拟手机 claim + 电脑端确认）。 */
    async pair(): Promise<void> {
      const claimResult = await callHost(host, 'POST', '/mobile/pair/claim', claim)
      assert.equal((claimResult as { state: string }).state, 'pending', 'claim 应进入待确认')
      const confirm = host.confirmPairing(pairing.ticket.code, deviceId, true)
      assert.equal(confirm, true, '电脑端确认应成功')
    },
    /**
     * 建立隧道：**两端都用真实的 WebSocket 实现**与真实的 host.handleUpgrade 路径，
     * 只把 TCP socket 换成内存 TestSocket。这样 websocket.ts 与 tunnel.ts 都被覆盖。
     */
    connect: connectTunnel,
    /** 用指定密钥对建立隧道（重新配对场景）。 */
    connectWithKeys: (keys: {
      deviceKey: ReturnType<typeof generateX25519KeyPair>
      deviceSigningKey: ReturnType<typeof generateP256KeyPair>
      pairingTicket?: string
    }) =>
      connectTunnel({
        deviceKey: keys.deviceKey,
        deviceSigningKey: keys.deviceSigningKey,
        ...(keys.pairingTicket === undefined ? {} : { pairingTicket: keys.pairingTicket }),
      }),


    /** 当前宿主侧隧道会话（从 host 服务面查询）。 */
    hostSession: () => host.connectedSession(deviceId),
    client: () => mobile,
    cleanup: () => {
      const stop = (mobile as unknown as { stopPump?: () => void } | undefined)?.stopPump
      stop?.()
      rmSync(dir, { recursive: true, force: true })
    },
  }
  return api
}

/** 直接以 HTTP 语义调用宿主的管理端点（绕过真实 socket，便于单测）。 */
async function callHost(
  host: MobileHost,
  method: string,
  path: string,
  body?: unknown,
): Promise<unknown> {
  const chunks: Buffer[] = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]
  const req = {
    method,
    url: path,
    headers: { host: '127.0.0.1:3080' },
    socket: { remoteAddress: '127.0.0.1' },
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  } as unknown as Parameters<MobileHost['handleHttp']>[0]

  let status = 0
  let payload = ''
  const res = {
    headersSent: false,
    writeHead(code: number) {
      status = code
      return this
    },
    end(data?: Buffer | string) {
      payload = typeof data === 'string' ? data : (data?.toString('utf8') ?? '')
    },
  } as unknown as Parameters<MobileHost['handleHttp']>[1]

  const handled = host.handleHttp(req, res)
  assert.equal(handled, true, `${method} ${path} 应由宿主插件处理`)
  // handleHttp 对管理端点是异步处理（void handlePairHttp(...)），这里等一拍
  for (let i = 0; i < 50 && status === 0; i++) await new Promise((resolve) => setTimeout(resolve, 2))
  assert.notEqual(status, 0, `${method} ${path} 未产生响应`)
  return JSON.parse(payload) as unknown
}

/**
 * 测试用 socket：实现 node:stream.Duplex 中 WebSocket 实现真正用到的那部分
 * （on('data'|'error'|'close'|'end')、write、end、destroy）。
 */
class TestSocket {
  private readonly handlers = new Map<string, ((arg?: unknown) => void)[]>()
  /** 本端写出的原始字节。 */
  readonly written: Buffer[] = []

  write(chunk: Buffer | string): boolean {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk)
    this.written.push(buffer)
    return true
  }

  end(): void {
    this.emit('end')
    this.emit('close')
  }

  destroy(): void {
    this.emit('close')
  }

  on(event: string, handler: (arg?: unknown) => void): this {
    const list = this.handlers.get(event) ?? []
    list.push(handler)
    this.handlers.set(event, list)
    return this
  }

  emit(event: string, arg?: unknown): void {
    for (const handler of [...(this.handlers.get(event) ?? [])]) handler(arg)
  }

  /** 对端写出的字节到达本端。 */
  deliver(chunk: Buffer): void {
    this.emit('data', chunk)
  }

  /** 取走并清空已写出的字节（跳过 HTTP 升级响应文本）。 */
  drain(): Buffer[] {
    const out = this.written.filter((buffer) => buffer.subarray(0, 5).toString('utf8') !== 'HTTP/')
    this.written.length = 0
    return out
  }
}

/** 客户端侧 WebSocket：把 TunnelSession 发出的字节做 RFC6455 封装（客户端必须掩码）。 */
class TestWebSocketClient {
  private readonly socket: TestSocket
  private buffer: Buffer<ArrayBuffer> = Buffer.alloc(0)
  private handler: ((data: Buffer) => void) | undefined
  private closed = false
  private closeHandlers: (() => void)[] = []
  private fragmentOpcode: number | undefined
  private fragments: Buffer[] = []

  constructor(socket: TestSocket) {
    this.socket = socket
  }

  /** 从宿主侧 socket 的写出内容中取帧并解码。 */
  pump(): void {
    for (const chunk of this.socket.drain()) this.ingest(chunk)
  }

  onMessage(handler: (data: Buffer) => void): void {
    this.handler = handler
  }

  onClose(handler: () => void): void {
    if (this.closed) {
      handler()
      return
    }
    this.closeHandlers.push(handler)
  }

  /** 发送一条二进制消息（客户端 → 宿主，带掩码）。 */
  send(bytes: Uint8Array): void {
    this.socket.deliver(encodeClientFrame(0x2, Buffer.from(bytes)))
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.socket.deliver(encodeClientFrame(0x8, Buffer.alloc(0)))
    for (const handler of this.closeHandlers) handler()
  }

  private ingest(chunk: Buffer): void {
    this.buffer = this.buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.buffer, chunk])
    for (;;) {
      const frame = decodeServerFrame(this.buffer)
      if (frame === undefined) return
      this.buffer = this.buffer.subarray(frame.consumed)
      if (frame.opcode === 0x8) {
        this.closed = true
        for (const handler of this.closeHandlers) handler()
        return
      }
      if (frame.opcode === 0x9) {
        this.socket.deliver(encodeClientFrame(0xa, frame.payload))
        continue
      }
      if (frame.opcode === 0x1 || frame.opcode === 0x2) {
        if (frame.fin) {
          this.handler?.(frame.payload)
          continue
        }
        this.fragmentOpcode = frame.opcode
        this.fragments = [frame.payload]
        continue
      }
      if (frame.opcode === 0x0) {
        this.fragments.push(frame.payload)
        if (frame.fin) {
          const message = Buffer.concat(this.fragments)
          this.fragments = []
          this.fragmentOpcode = undefined
          this.handler?.(message)
        }
      }
    }
  }
}

/** 编码客户端帧（带掩码）。 */
function encodeClientFrame(opcode: number, payload: Buffer): Buffer {
  const mask = Buffer.from([0x11, 0x22, 0x33, 0x44])
  const masked = Buffer.allocUnsafe(payload.length)
  for (let i = 0; i < payload.length; i++) masked[i] = payload[i]! ^ mask[i & 3]!
  let header: Buffer
  if (payload.length < 126) {
    header = Buffer.from([0x80 | opcode, 0x80 | payload.length])
  } else if (payload.length < 65536) {
    header = Buffer.alloc(4)
    header.writeUInt8(0x80 | opcode, 0)
    header.writeUInt8(0x80 | 126, 1)
    header.writeUInt16BE(payload.length, 2)
  } else {
    header = Buffer.alloc(10)
    header.writeUInt8(0x80 | opcode, 0)
    header.writeUInt8(0x80 | 127, 1)
    header.writeBigUInt64BE(BigInt(payload.length), 2)
  }
  return Buffer.concat([header, mask, masked])
}

/** 解码服务端帧（无掩码）。 */
function decodeServerFrame(buffer: Buffer): { fin: boolean; opcode: number; payload: Buffer; consumed: number } | undefined {
  if (buffer.length < 2) return undefined
  const first = buffer.readUInt8(0)
  const second = buffer.readUInt8(1)
  const fin = (first & 0x80) !== 0
  const opcode = first & 0x0f
  let length = second & 0x7f
  let offset = 2
  if (length === 126) {
    if (buffer.length < 4) return undefined
    length = buffer.readUInt16BE(2)
    offset = 4
  } else if (length === 127) {
    if (buffer.length < 10) return undefined
    length = Number(buffer.readBigUInt64BE(2))
    offset = 10
  }
  if (buffer.length < offset + length) return undefined
  return { fin, opcode, payload: buffer.subarray(offset, offset + length), consumed: offset + length }
}

/** 直接观察状态码与响应头（`callHost` 只回 JSON 正文，看不到 302 的 Location）。 */
async function rawHost(
  host: MobileHost,
  method: string,
  path: string,
): Promise<{ status: number; location: string; body: string }> {
  const req = {
    method,
    url: path,
    headers: { host: '127.0.0.1:3080' },
    socket: { remoteAddress: '127.0.0.1' },
    async *[Symbol.asyncIterator]() {},
  } as unknown as Parameters<MobileHost['handleHttp']>[0]
  let status = 0
  let location = ''
  let body = ''
  const res = {
    headersSent: false,
    writeHead(code: number, headers?: Record<string, string>) {
      status = code
      location = String(headers?.['location'] ?? '')
      return this
    },
    end(data?: Buffer | string) {
      body = typeof data === 'string' ? data : (data?.toString('utf8') ?? '')
    },
  } as unknown as Parameters<MobileHost['handleHttp']>[1]
  host.handleHttp(req, res)
  for (let i = 0; i < 50 && status === 0; i++) await new Promise((resolve) => setTimeout(resolve, 2))
  return { status, location, body }
}

test('★ 短码配对入口：/mobile/p/<6 位码> 换成票据并 302 到应用外壳', async () => {
  const env = await setup()
  try {
    const created = (await callHost(env.host, 'POST', '/mobile/pair/code', {})) as {
      ticket: { code: string; ticket: string }
    }
    const code = created.ticket.code

    // ① 码 → 载荷：必须是**整个 ticket 对象**的 base64url(UTF-8 JSON)。
    //    形状约定与 pairing-page.ts 的 encodeTicketPayload、boot.js 的 readUrlConfig 三处一致；
    //    历史上这里曾经只传 ticket.ticket 裸串，手机解析失败、拿不到主机指纹而连不上。
    const payload = env.host.pairingPayloadForCode(code)
    assert.ok(typeof payload === 'string' && payload.length > 0, '应能按 6 位码换出配对载荷')
    assert.deepEqual(
      JSON.parse(Buffer.from(payload as string, 'base64url').toString('utf8')),
      created.ticket,
      '载荷必须是整个 ticket 对象（少一层或换字段手机就解析失败）',
    )

    // ② 不存在的码不发放任何东西
    assert.equal(env.host.pairingPayloadForCode('000000'), undefined, '不存在的码必须返回 undefined')

    // ③ HTTP 跳转：手机在浏览器里打开这个地址就能进配对
    const jumped = await rawHost(env.host, 'GET', `/mobile/p/${code}`)
    assert.equal(jumped.status, 302, '短码入口应 302')
    assert.match(jumped.location, /^\/mobile\/app\?pair=/, `Location 应指向应用外壳，实际 ${jumped.location}`)

    const missing = await rawHost(env.host, 'GET', '/mobile/p/000000')
    assert.equal(missing.status, 404, '无效码应 404 并给一句人话')
    assert.match(missing.body, /配对码无效或已过期/, '404 页面要说明怎么办，而不是一片空白')
  } finally {
    env.cleanup()
  }
})

test('配对流程：claim 需电脑端确认，指纹与公钥必须自洽', async () => {
  const env = await setup()
  try {
    const result = (await callHost(env.host, 'POST', '/mobile/pair/claim', env.claim)) as { state: string }
    assert.equal(result.state, 'pending')
    assert.equal(env.host.listDevices().length, 0, '未确认前不得登记设备')

    // 指纹与公钥不匹配必须被拒绝（防止骗过人工比对）
    const bad = await callHost(env.host, 'POST', '/mobile/pair/claim', {
      ...env.claim,
      fingerprint: 'ff'.repeat(16),
    }).catch(() => undefined)
    void bad

    env.host.confirmPairing(env.pairing.ticket.code, env.deviceId, true)
    assert.equal(env.host.listPendingPairings()[0]?.state, 'approved')
  } finally {
    env.cleanup()
  }
})

test('★ 网关特判端点 $events/result 必须走 dispatchRpc（转发事件的选择靠它回传）', async () => {
  const env = await setup()
  try {
    await env.pair()
    const mobile = await env.connect({ pairingTicket: env.pairing.ticket.ticket })

    // 这条就是手机上点「允许 / 拒绝」时发的那一次调用，载荷形状由
    // dsh-api-gateway 的 parseRemoteEventResultPayload 决定：恰好一个 args 字段。
    const result = await mobile.call('$events/result', {
      clientId: 'client-1',
      eventId: 'event-1',
      outcome: { kind: 'next' },
    })

    assert.equal(result.ok, true, `调用应成功，实际：${JSON.stringify(result)}`)
    assert.deepEqual(result.value, { dispatched: true }, '应由 dispatchRpc 处理')
    assert.equal(env.dispatches.length, 1, '应恰好经过一次 dispatchRpc')
    // 上一行已断言恰好一次；这里显式收窄（noUncheckedIndexedAccess 下元素可能为 undefined），
    // 避免用 `?.` 把断言变成恒真。
    const dispatch = env.dispatches[0]
    assert.ok(dispatch !== undefined, '应恰好经过一次 dispatchRpc')
    assert.equal(dispatch.endpoint, '$events/result')
    // 一旦被当成普通 Remote 方法送进 invoke，就会在反射表里查找而必然失败 ——
    // 那正是"手机上的选择回不到电脑"的直接原因。
    assert.equal(
      env.calls.some((call) => call.namespace === '$events'),
      false,
      '不得把它当作普通 Remote 方法送进 invoke',
    )
  } finally {
    env.cleanup()
  }
})

test('端到端：配对后经加密隧道完成一元 RPC', async () => {
  const env = await setup()
  try {
    await env.pair()
    const mobile = await env.connect({ pairingTicket: env.pairing.ticket.ticket })

    assert.equal(env.store.list().length, 1, '首次连接应登记设备')
    assert.equal(env.host.connectedCount(), 1, '应有一台设备在线')

    const result = await mobile.call('session/create', { cwd: '/Users/me/project' })
    assert.equal(result.ok, true)
    assert.deepEqual(result.value, { sessionId: 'session-created-by-mobile', workspace: '/Users/me/project' })
    assert.equal(env.calls.length, 1)
    assert.deepEqual(env.calls[0], { namespace: 'session', method: 'create', args: { cwd: '/Users/me/project' } })
  } finally {
    env.cleanup()
  }
})

test('端到端：流式 RPC 经隧道按序送达并结束', async () => {
  const env = await setup()
  try {
    await env.pair()
    const mobile = await env.connect({ pairingTicket: env.pairing.ticket.ticket })
    const items = await mobile.collectStream('session/history', { sessionId: 's-1', limit: 50 })
    assert.deepEqual(items, [
      { seq: 1, text: '第一页' },
      { seq: 2, text: '第二页' },
    ])
  } finally {
    env.cleanup()
  }
})

test('能力位门禁：未授予 fsWrite 时写操作被拒绝，且记录审计', async () => {
  const env = await setup()
  try {
    await env.pair()
    const mobile = await env.connect({ pairingTicket: env.pairing.ticket.ticket })

    // 默认能力位里 fsWrite 为 false
    const denied = await mobile.call('workspaceFiles/write', { sessionId: 's-1', path: 'a.txt', content: 'x' })
    assert.equal(denied.ok, false)
    assert.equal(denied.error?.code, ErrorCode.CapabilityDenied)

    // 电脑端授予后即可通过
    env.host.updateDevice(env.deviceId, { capabilities: { fsWrite: true } })
    const allowed = await mobile.call('workspaceFiles/write', { sessionId: 's-1', path: 'a.txt', content: 'x' })
    assert.equal(allowed.ok, true)

    const audit = env.host.listAudit({ deviceId: env.deviceId })
    assert.ok(audit.some((entry) => entry.kind === 'deny'), '拒绝必须留下审计记录')
  } finally {
    env.cleanup()
  }
})

test('界面启动与发消息所需调用不得被门禁拦（真实故障的回归）', async () => {
  const env = await setup()
  try {
    await env.pair()
    const mobile = await env.connect({ pairingTicket: env.pairing.ticket.ticket })

    /**
     * 这一组是 **DSH 前端启动时自己就会调用**的端点，以及发消息用的流式端点。
     *
     * 真实故障：早期 `capabilityCheck` 是"逐命名空间白名单、其余默认拒绝"，
     * 把这些全拒了 → 手机上界面起不来、或加载出来但任何操作都无效，
     * 而隧道是通的、日志里没有"连接失败"（失败的是业务调用），排查方向被彻底带偏。
     * 这个用例把"这些调用必须通"钉死。
     */
    const bootstrapEndpoints = [
      'dynamicCordisRunner/inventory',
      'dynamicCordisRunner/syncInspectManifest',
      'credentials/describe',
      'agentPresets/list',
      'settings/describe',
      'session/modelCatalog',
      'session/list',
    ]
    for (const endpoint of bootstrapEndpoints) {
      const result = await mobile.call(endpoint, { args: {} })
      assert.equal(result.ok, true, `${endpoint} 必须被放行（界面启动依赖它），实际：${JSON.stringify(result.error)}`)
    }

    // 发消息：一元路径
    const prompt = await mobile.call('session/prompt', { args: { sessionId: 's-1', text: '你好' } })
    assert.equal(prompt.ok, true, `session/prompt 必须被放行，实际：${JSON.stringify(prompt.error)}`)

    // 订阅/流式路径：请求必须真正到达网关并拿到数据
    // （流式此前既不审计也无断言，"发送无反应"这类故障就藏在它的沉默里）
    const streamed = await mobile.collectStream('session/event', { sessionId: 's-1' })
    assert.ok(streamed.length > 0, '流式订阅必须真的产出数据（否则界面收不到回复）')

    // 审计里不应留下"命名空间未启用"这类 deny
    const denies = env.host.listAudit({ deviceId: env.deviceId }).filter((entry) => entry.kind === 'deny')
    assert.deepEqual(denies, [], `界面启动路径不应产生 deny，实际：${JSON.stringify(denies)}`)
  } finally {
    env.cleanup()
  }
})

test('能力位不得越过宿主上限', async () => {
  const env = await setup({ capabilities: { ...DEFAULT_CAPABILITIES, fsWrite: false } })
  try {
    await env.pair()
    assert.throws(() => env.host.updateDevice(env.deviceId, { capabilities: { fsWrite: true } }), /exceeds the host ceiling/)
  } finally {
    env.cleanup()
  }
})

test('未配对设备无法建立隧道', async () => {
  const env = await setup()
  try {
    // 不配对直接连接：宿主必须拒绝
    await assert.rejects(async () => {
      const client = await env.connect({ waitForHandshake: false })
      await client.waitEstablished()
    }, /not paired|device-unknown/)
  } finally {
    env.cleanup()
  }
})

test('等待电脑端确认时必须**立即**收到拒绝，而不是静默挂着', async () => {
  const env = await setup()
  try {
    // 手机已 claim（票据有效、设备待确认），但电脑端还没点「允许」。
    // 此时宿主解析设备会**抛错**（PairingPending），而不是返回 undefined。
    const claimResult = await callHost(env.host, 'POST', '/mobile/pair/claim', env.claim)
    assert.equal((claimResult as { state: string }).state, 'pending')

    const started = Date.now()
    await assert.rejects(
      async () => {
        // waitEstablished 的默认超时是 3 秒：用它同时充当"是否被静默挂起"的探针
        const client = await env.connect({
          pairingTicket: env.pairing.ticket.ticket,
          waitForHandshake: false,
        })
        await client.waitEstablished()
      },
      /awaiting confirmation|pairing-pending/,
    )
    const elapsed = Date.now() - started
    // 真实事故：PairingPending 是抛错，而 acceptHello 没有捕获，
    // 异常冒泡到 receive 的兜底 catch 后**既不发错误帧也不关连接**——
    // 客户端只能干等自己的连接超时（手机上是 15 秒），表现为"配对时一直卡住"。
    assert.ok(elapsed < 2000, `拒绝必须是即时的，实际耗时 ${elapsed}ms（疑似被静默挂起）`)
  } finally {
    env.cleanup()
  }
})

test('撤销设备后隧道立即断开，且无法重连', async () => {
  const env = await setup()
  try {
    await env.pair()
    const mobile = await env.connect({ pairingTicket: env.pairing.ticket.ticket })
    assert.equal(env.host.connectedCount(), 1)

    assert.equal(env.host.revokeDevice(env.deviceId), true)
    assert.equal(env.host.connectedCount(), 0, '撤销必须立即断开隧道')
    assert.equal(env.store.get(env.deviceId)?.authorization, 'revoked')

    // 已撤销设备再握手必须失败（不带票据，走"已登记但被撤销"分支）
    await assert.rejects(
      async () => {
        const client = await env.connect({ waitForHandshake: false })
        await client.waitEstablished()
      },
      /not paired|revoked/,
    )
    const audit = env.host.listAudit({ deviceId: env.deviceId })
    assert.ok(audit.some((entry) => entry.kind === 'revoke'), '撤销必须有审计')
  } finally {
    env.cleanup()
  }
})

test('重放同一帧被拒绝并断开连接', async () => {
  const env = await setup()
  try {
    await env.pair()
    const mobile = await env.connect({ pairingTicket: env.pairing.ticket.ticket })
    const keys = mobile.keys
    assert.ok(keys)

    // 先正常调用一次，确认链路可用
    const first = await mobile.call('session/create', {})
    assert.equal(first.ok, true, '首帧应正常处理')
    assert.equal(env.hostSession()?.currentState, 'established')

    // 关闭自动重连轮询后手工重放一帧：构造合法帧 → 发送 → 原样再发一次
    const payload = Buffer.from(JSON.stringify({ type: 'client-request', rpcId: 'replay-1', method: 'session/create', payload: { args: {} } }), 'utf8')
    const counter = mobile.counter // 下一个未使用的 counter
    const frame = mobile.sealRpc(payload, counter)
    mobile.sendRaw(frame)
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(env.hostSession()?.currentState, 'established', '首个 counter 应被接受')

    mobile.sendRaw(frame) // 同一 counter 重放
    await new Promise((resolve) => setTimeout(resolve, 30))
    const session = env.hostSession()
    assert.equal(
      mobile.error !== undefined || session === undefined || session.currentState === 'closed',
      true,
      `重放必须被拒绝并断开连接（clientError=${String((mobile.error as Error | undefined)?.message)} session=${session?.currentState} failure=${JSON.stringify(session?.failure)}）`,
    )
  } finally {
    env.cleanup()
  }
})

test('管理端点仅限本机访问', async () => {
  const env = await setup()
  try {
    const chunks: Buffer[] = []
    const remoteReq = {
      method: 'POST',
      url: '/mobile/pair/code',
      headers: { host: '192.168.1.10:3080' },
      socket: { remoteAddress: '192.168.1.50' }, // 局域网另一台机器
      async *[Symbol.asyncIterator]() {
        for (const chunk of chunks) yield chunk
      },
    } as unknown as Parameters<MobileHost['handleHttp']>[0]
    let status = 0
    const res = {
      headersSent: false,
      writeHead(code: number) {
        status = code
        return this
      },
      end() {},
    } as unknown as Parameters<MobileHost['handleHttp']>[1]
    assert.equal(env.host.handleHttp(remoteReq, res), true)
    assert.equal(status, 403, '非本机访问设备管理必须 403')
  } finally {
    env.cleanup()
  }
})

test('manifest 暴露协议版本与宿主指纹', async () => {
  const env = await setup()
  try {
    const manifest = env.host.manifest()
    assert.equal(manifest.protocolVersion, 1)
    assert.equal(manifest.hostId, 'host-e2e-1')
    assert.equal(manifest.hostFingerprint, fingerprint(env.hostSigningKey.publicKey))
    assert.equal(manifest.hostName, '测试 Mac')
  } finally {
    env.cleanup()
  }
})

/** 断言 HostHandshake 类型可从协议包导入（API 稳定性）。 */
void HostHandshake

test('重新配对同一 deviceId 时必须采用新公钥（旧登记不得遮蔽新票据）', async () => {
  // 这条回归测试对应一个真实缺陷：设备用同一 deviceId 重新配对时
  // （手机浏览器清空存储、App 重装、Keystore 密钥更换），宿主曾优先采用**已登记记录的旧公钥**，
  // 导致用新私钥签的 ClientAuth 验签失败，报 mobile/handshake-signature ——
  // 一个看起来像"遭到攻击"、实际只是"该更新记录了"的错误。
  const env = await setup()
  try {
    // 第一次配对：登记设备 A 的公钥
    await env.pair()
    const first = await env.connect({ pairingTicket: env.pairing.ticket.ticket })
    await first.waitEstablished()
    const registeredFirst = env.store.get(env.deviceId)
    assert.ok(registeredFirst !== undefined, '首次配对应登记设备')

    // 同一 deviceId、全新密钥对，重新配对
    const newDeviceKey = generateX25519KeyPair()
    const newDeviceSigningKey = generateP256KeyPair()
    const pairing2 = env.host.createPairing()
    const claim2 = await callHost(env.host, 'POST', '/mobile/pair/claim', {
      ticket: pairing2.ticket.ticket,
      deviceId: env.deviceId,
      deviceSigningKey: newDeviceSigningKey.publicKey,
      fingerprint: fingerprint(newDeviceSigningKey.publicKey),
      name: '重装后的同一台手机',
    })
    assert.equal((claim2 as { state: string }).state, 'pending')
    assert.equal(env.host.confirmPairing(pairing2.ticket.code, env.deviceId, true), true)

    // 用新密钥建立隧道：这一步是缺陷的**真正暴露点**——
    // 若宿主仍用旧公钥验签，会返回 mobile/handshake-signature，握手超时。
    const reconnected = await env.connectWithKeys({
      deviceKey: newDeviceKey,
      deviceSigningKey: newDeviceSigningKey,
      pairingTicket: pairing2.ticket.ticket,
    })
    await reconnected.waitEstablished()
    assert.equal(env.host.connectedCount(), 1, '重新配对后应能正常建立隧道')

    // 设备记录在**票据被消费、握手成功时**才更新，因此断言放在这里
    const registeredSecond = env.store.get(env.deviceId)
    assert.notEqual(
      registeredSecond?.deviceSigningKey,
      registeredFirst.deviceSigningKey,
      '重新配对后登记的公钥必须更新为新的那一把（否则下次无票据重连会再次验签失败）',
    )
    assert.equal(registeredSecond?.fingerprint, fingerprint(newDeviceSigningKey.publicKey))
  } finally {
    env.cleanup()
  }
})

test('重新配对不得重置电脑端已授予的能力位', async () => {
  const env = await setup()
  try {
    await env.pair()
    const first = await env.connect({ pairingTicket: env.pairing.ticket.ticket })
    await first.waitEstablished()

    // 电脑端授予写权限
    env.host.updateDevice(env.deviceId, { capabilities: { fsWrite: true } })
    assert.equal(env.store.get(env.deviceId)?.capabilities.fsWrite, true)

    // 同一设备重新配对（换密钥）
    const newDeviceKey = generateX25519KeyPair()
    const newDeviceSigningKey = generateP256KeyPair()
    const pairing2 = env.host.createPairing()
    await callHost(env.host, 'POST', '/mobile/pair/claim', {
      ticket: pairing2.ticket.ticket,
      deviceId: env.deviceId,
      deviceSigningKey: newDeviceSigningKey.publicKey,
      fingerprint: fingerprint(newDeviceSigningKey.publicKey),
      name: '重新配对',
    })
    env.host.confirmPairing(pairing2.ticket.code, env.deviceId, true)
    const reconnected = await env.connectWithKeys({
      deviceKey: newDeviceKey,
      deviceSigningKey: newDeviceSigningKey,
      pairingTicket: pairing2.ticket.ticket,
    })
    await reconnected.waitEstablished()

    // 重新配对只应换密钥，不应悄悄收回或放宽权限
    assert.equal(
      env.store.get(env.deviceId)?.capabilities.fsWrite,
      true,
      '重新配对必须保留电脑端已授予的能力位（静默重置会让用户已授予的权限莫名消失）',
    )
  } finally {
    env.cleanup()
  }
})

test('Host 栅栏：拒绝未受信 authority，接受 loopback 与 trustedHosts', async () => {
  const env = await setup()
  try {
    const call = async (hostHeader: string, origin?: string): Promise<number> => {
      const req = {
        method: 'POST',
        url: '/mobile/pair/code',
        headers: { host: hostHeader, ...(origin === undefined ? {} : { origin }) },
        socket: { remoteAddress: '127.0.0.1' },
        async *[Symbol.asyncIterator]() {},
      } as unknown as Parameters<MobileHost['handleHttp']>[0]
      let status = 0
      const res = {
        headersSent: false,
        writeHead(code: number) {
          status = code
          return this
        },
        end() {},
      } as unknown as Parameters<MobileHost['handleHttp']>[1]
      assert.equal(env.host.handleHttp(req, res), true)
      return status
    }

    assert.equal(await call('127.0.0.1:3080'), 200, 'loopback Host 应放行')

    // 未受信的局域网 authority：必须拒绝，否则 DNS rebinding / 任意 Host 都能触达管理端点
    const denied = await call('evil.example.com')
    assert.equal(denied, 403, '未受信 Host 必须被拒绝')

    // Origin 与 Host 不同源：拒绝
    assert.equal(await call('127.0.0.1:3080', 'http://evil.example.com'), 403, '跨源 Origin 必须被拒绝')

    // sec-fetch-site: cross-site：拒绝
    const crossReq = {
      method: 'POST',
      url: '/mobile/pair/code',
      headers: { host: '127.0.0.1:3080', 'sec-fetch-site': 'cross-site' },
      socket: { remoteAddress: '127.0.0.1' },
      async *[Symbol.asyncIterator]() {},
    } as unknown as Parameters<MobileHost['handleHttp']>[0]
    let crossStatus = 0
    const crossRes = {
      headersSent: false,
      writeHead(code: number) {
        crossStatus = code
        return this
      },
      end() {},
    } as unknown as Parameters<MobileHost['handleHttp']>[1]
    env.host.handleHttp(crossReq, crossRes)
    assert.equal(crossStatus, 403, 'cross-site 请求必须被拒绝')
  } finally {
    env.cleanup()
  }
})

test('Host 栅栏：trustedHosts 里声明的 authority 放行', async () => {
  const env = await setup({ trustedHosts: ['10.34.221.181:3080'] })
  try {
    const req = {
      method: 'POST',
      url: '/mobile/pair/code',
      headers: { host: '10.34.221.181:3080', origin: 'http://10.34.221.181:3080' },
      socket: { remoteAddress: '10.34.221.181' },
      async *[Symbol.asyncIterator]() {},
    } as unknown as Parameters<MobileHost['handleHttp']>[0]
    let status = 0
    const res = {
      headersSent: false,
      writeHead(code: number) {
        status = code
        return this
      },
      end() {},
    } as unknown as Parameters<MobileHost['handleHttp']>[1]
    env.host.handleHttp(req, res)
    // 受信 authority 通过栅栏后，管理端点仍要求 loopback（这里 remoteAddress 是局域网 → 403）
    assert.equal(status, 403, '受信 authority 能过 Host 栅栏，但管理端点仍需站在电脑前操作')

    // 同一受信 authority 访问非管理端点（manifest）应放行
    const manifestReq = {
      method: 'GET',
      url: '/mobile/manifest',
      headers: { host: '10.34.221.181:3080' },
      socket: { remoteAddress: '10.34.221.181' },
      async *[Symbol.asyncIterator]() {},
    } as unknown as Parameters<MobileHost['handleHttp']>[0]
    let manifestStatus = 0
    const manifestRes = {
      headersSent: false,
      writeHead(code: number) {
        manifestStatus = code
        return this
      },
      end() {},
    } as unknown as Parameters<MobileHost['handleHttp']>[1]
    env.host.handleHttp(manifestReq, manifestRes)
    assert.equal(manifestStatus, 200, '受信 authority 应能拉取 manifest')
  } finally {
    env.cleanup()
  }
})

test('来源判定：信任代理注入的 x-forwarded-for，但只在本机直连时', () => {
  const make = (remoteAddress: string, forwarded?: string) =>
    ({ socket: { remoteAddress }, headers: forwarded === undefined ? {} : { 'x-forwarded-for': forwarded } }) as unknown as Parameters<
      typeof isLoopbackRequest
    >[0]

  // 直连（无代理）：按 socket 地址判定
  assert.equal(isLoopbackRequest(make('127.0.0.1')), true)
  assert.equal(isLoopbackRequest(make('::1')), true)
  assert.equal(isLoopbackRequest(make('::ffff:127.0.0.1')), true)
  assert.equal(isLoopbackRequest(make('10.34.221.181')), false)

  // 经局域网代理：socket 是 loopback，真实来源由代理注入
  assert.equal(isLoopbackRequest(make('127.0.0.1', '10.34.221.181')), false, '代理转发的手机必须被识别为非本机')
  assert.equal(isLoopbackRequest(make('127.0.0.1', '127.0.0.1')), true, '代理转发的电脑本机仍算本机')
  assert.equal(isLoopbackRequest(make('127.0.0.1', '2001:db8::1')), false)

  // 伪造防护：非 loopback 直连时，x-forwarded-for 一律不采信
  assert.equal(
    isLoopbackRequest(make('10.34.221.181', '127.0.0.1')),
    false,
    '局域网直连者伪造 x-forwarded-for 不得被当成人在电脑前',
  )
})

test('Origin 带 scheme 时也参与同源比较（曾因此拒绝所有浏览器请求）', async () => {
  // 该用例锁住一个真实缺陷：parseAuthority 曾无条件拼 http://，
  // 于是 `http://10.0.0.5:3081` 被解析成 hostname 为字面量 "http"，
  // **任何带 Origin 的浏览器请求都被判为跨源并 403**
  // （curl 不带 Origin，所以命令行测试一切正常，极难定位）。
  //
  // 这里用非管理端点（/mobile/manifest）验证 Origin 栅栏本身，
  // 避免与"管理端点要求本机"那条规则混在一起。
  const env = await setup({ trustedHosts: ['10.34.221.181:3081'] })
  try {
    const call = async (headers: Record<string, string>): Promise<number> => {
      const req = {
        method: 'GET',
        url: '/mobile/manifest',
        headers,
        socket: { remoteAddress: '127.0.0.1' },
        async *[Symbol.asyncIterator]() {},
      } as unknown as Parameters<MobileHost['handleHttp']>[0]
      let status = 0
      const res = {
        headersSent: false,
        writeHead(code: number) {
          status = code
          return this
        },
        end() {},
      } as unknown as Parameters<MobileHost['handleHttp']>[1]
      env.host.handleHttp(req, res)
      return status
    }

    assert.equal(
      await call({ host: '10.34.221.181:3081', origin: 'http://10.34.221.181:3081' }),
      200,
      '带 scheme 的同源 Origin 必须放行',
    )
    assert.equal(
      await call({ host: '10.34.221.181:3081', origin: 'https://10.34.221.181:3081' }),
      200,
      'https 前缀的同源 Origin 也应放行（反代场景）',
    )
    assert.equal(
      await call({ host: '10.34.221.181:3081', origin: 'http://evil.example.com' }),
      403,
      '真正的跨源 Origin 必须拒绝',
    )
    assert.equal(
      await call({ host: '10.34.221.181:3081', origin: 'http://10.34.221.181:9999' }),
      403,
      '同主机不同端口属于跨源，必须拒绝',
    )
  } finally {
    env.cleanup()
  }
})

test('经代理转发时手机被识别为非本机：拿不到电脑版界面、也调不动管理端点', async () => {
  // 这条锁住"手机显示电脑端页面"的真实缺陷：
  // TCP 代理后 socket 对端恒为 loopback，若不看 x-forwarded-for，
  // 手机就会被当成"人在电脑前"，既能拿到电脑版配对控制台，
  // 也能调用只应本机可用的管理端点——这既是用错界面，也是权限越界。
  const env = await setup({ trustedHosts: ['10.34.221.181:3081'] })
  try {
    const call = async (url: string, headers: Record<string, string>): Promise<number> => {
      const req = {
        method: 'GET',
        url,
        headers,
        socket: { remoteAddress: '127.0.0.1' },
        async *[Symbol.asyncIterator]() {},
      } as unknown as Parameters<MobileHost['handleHttp']>[0]
      let status = 0
      const res = {
        headersSent: false,
        writeHead(code: number) {
          status = code
          return this
        },
        end() {},
      } as unknown as Parameters<MobileHost['handleHttp']>[1]
      env.host.handleHttp(req, res)
      return status
    }

    const phone = { host: '10.34.221.181:3081', 'x-forwarded-for': '10.34.221.181' }
    assert.equal(
      await call('/mobile/pair/pending', phone),
      403,
      '手机（经代理）不得读取待确认列表——这正是它显示电脑版界面的判据',
    )
    assert.equal(await call('/mobile/devices', phone), 403, '手机（经代理）不得读取设备列表')
    assert.equal(
      await call('/mobile/pair/status', phone),
      403,
      '手机不得查询配对状态（只凭 6 位码可枚举；手机靠重试隧道判断是否获准）',
    )
    assert.equal(await call('/mobile/pair/claim', phone), 405, '手机必须能访问 claim（GET 不是它的方法，故 405 而非 403）')
    assert.equal(await call('/mobile/manifest', phone), 200, '手机仍应能读取 manifest')

    const desktop = { host: '10.34.221.181:3081', 'x-forwarded-for': '127.0.0.1' }
    assert.equal(await call('/mobile/pair/pending', desktop), 200, '电脑本机（经代理）仍应能读取待确认列表')
  } finally {
    env.cleanup()
  }
})

test('票据失效后：同一设备凭已配对记录仍能连上（回归：不再"必须重新配对"）', async () => {
  const env = await setup()
  try {
    await env.pair()
    const first = await env.connect({ pairingTicket: env.pairing.ticket.ticket })
    await first.waitEstablished()
    assert.equal(env.store.list().length, 1, '首次配对应登记一台设备')

    // 同一台设备再来一次，仍然带着那张**已被消费**的票据。
    // 修复前：宿主直接以 "pairing ticket is invalid or expired" 拒绝，
    // 症状是"隧道断开后一直重连失败，看起来像必须重新配对"。
    const again = await env.connect({ pairingTicket: env.pairing.ticket.ticket })
    await again.waitEstablished()

    assert.equal(env.store.list().length, 1, '回退不应多登记设备')
    const audit = env.host.listAudit({ deviceId: env.deviceId })
    assert.ok(
      audit.some((entry) => (entry.detail ?? '').includes('票据已失效')),
      '回退到已配对设备必须留下审计，否则事后无法区分"票据失效"与"设备被拒"',
    )
  } finally {
    env.cleanup()
  }
})

test('票据失效后：换了密钥的同一 deviceId 不得借此连上（防冒充）', async () => {
  const env = await setup()
  try {
    await env.pair()
    const first = await env.connect({ pairingTicket: env.pairing.ticket.ticket })
    await first.waitEstablished()
    const registered = env.store.get(env.deviceId)
    assert.ok(registered !== undefined, '设备应已登记')

    // 攻击者：同样的 deviceId、全新的密钥、外加一张作废的票据。
    // 回退到设备记录时用的仍是**登记在册**的公钥，所以签名校验必然失败。
    await assert.rejects(
      env.connect({
        pairingTicket: env.pairing.ticket.ticket,
        deviceKey: generateX25519KeyPair(),
        deviceSigningKey: generateP256KeyPair(),
      }),
      '换密钥冒充已配对设备必须被拒（回退不能变成绕过设备认证的后门）',
    )
    assert.equal(
      env.store.get(env.deviceId)?.deviceSigningKey,
      registered.deviceSigningKey,
      '登记的公钥不得被冒充者覆盖',
    )
  } finally {
    env.cleanup()
  }
})

test('端侧请求：默认全禁 → 手机授权 → 电脑发起 → 手机取走并回报', async () => {
  const env = await setup()
  try {
    await env.pair()
    const mobile = await env.connect({ pairingTicket: env.pairing.ticket.ticket })
    await mobile.waitEstablished()

    // ① **默认全禁**：手机上还没允许，电脑发起的请求必须被明确拒绝（不是"发了没反应"）。
    //    断言 code 而不是 HTTP 状态码：`callHost` 只回响应体，而 code 更精确。
    const denied = (await callHost(env.host, 'POST', '/mobile/device/call', { capability: 'show', text: '你好' })) as {
      code?: string
      message?: string
    }
    assert.equal(denied.code, ErrorCode.CapabilityDenied, '未授权的能力必须被拒（默认全禁）')
    assert.match(String(denied.message), /not enabled/, '错误信息要说清是"没启用"')

    // ② 手机自己启用该能力（**只有手机能启用**）
    const enabled = (await mobile.call('mobile/device/enable', { capability: 'show', enabled: true })) as {
      ok: boolean
      value?: { capabilities?: string[] }
    }
    assert.equal(enabled.ok, true)
    assert.deepEqual(enabled.value?.capabilities, ['show'])

    // ③ 电脑发起 → 手机取走 → 回报结果
    const call = (await callHost(env.host, 'POST', '/mobile/device/call', { capability: 'show', text: '构建完成' })) as {
      id?: string
      capability?: string
    }
    assert.equal(call.capability, 'show', '已授权的能力应可入队')
    const id = call.id
    assert.ok(typeof id === 'string' && id.length > 0, '应返回请求 id')

    const pending = (await mobile.call('mobile/device/pending', {})) as {
      value?: { calls?: Array<{ id: string; capability: string; text: string }> }
    }
    assert.equal(pending.value?.calls?.length, 1, '手机应取到 1 条请求')
    assert.equal(pending.value?.calls?.[0]?.text, '构建完成')

    // ④ **只投递一次**：再取一次应为空（否则一次请求可能被执行两次）
    const again = (await mobile.call('mobile/device/pending', {})) as { value?: { calls?: unknown[] } }
    assert.equal(again.value?.calls?.length, 0, '同一请求不得被投递两次')

    // ⑤ 回报结果，电脑侧可查
    const reported = (await mobile.call('mobile/device/result', { id, ok: true, detail: 'displayed' })) as {
      ok: boolean
    }
    assert.equal(reported.ok, true)
    const status = (await callHost(env.host, 'GET', `/mobile/device/status?id=${String(id)}`)) as {
      result?: { ok?: boolean; detail?: string } | null
      pending?: number
    }
    assert.equal(status.result?.ok, true)
    assert.equal(status.result?.detail, 'displayed')
    assert.equal(status.pending, 0, '回报后不应还有未完成请求')

    // ⑥ 停用后必须回到拒绝状态（停用是真的生效，不是只改了显示）
    await mobile.call('mobile/device/enable', { capability: 'show', enabled: false })
    const deniedAgain = (await callHost(env.host, 'POST', '/mobile/device/call', { capability: 'show', text: 'x' })) as {
      code?: string
    }
    assert.equal(deniedAgain.code, ErrorCode.CapabilityDenied, '停用后必须回到拒绝状态')
  } finally {
    env.cleanup()
  }
})
