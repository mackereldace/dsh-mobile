/**
 * 局域网监听（C1）的回归：从 `scripts/lan-proxy.mjs` 搬进插件的转发器与监听器。
 *
 * ## 为什么单开一个文件（这里的坏法都"没有症状"）
 *
 *   1. ★★ **漏掉 `x-forwarded-for` 注入** ⇒ 插件自己起的监听 socket 对端恒为回环
 *      ⇒ 局域网手机被判成"人在电脑前" ⇒ 配对码生成/配对确认/设备管理/端侧控制
 *      （`LOCAL_ONLY` 全家）在局域网可达 = **权限提升**，而且界面上完全看不出异常。
 *      所以这里有一条**变异可验**的用例：把注入去掉，`isLoopbackRequest` 立刻返回 true。
 *   2. **漏掉 IPv6 伴随监听** ⇒ 蜂窝网 IPv6 直连失效而局域网照常 ⇒ 极难发现。
 *   3. **端口冲突时自动换端口** ⇒ 手机上的地址变了 ⇒ "本来能连，重启一下就连不上"。
 *   4. **监听失败抛错** ⇒ 手机入口的小毛病把整个 DSH 带下去。
 *   5. **证书热更新缺失** ⇒ 重签叶子后必须重启 DSH（与 A/B 两轮"不用重启"的精神相悖）。
 *
 * ## 纪律：单测用**假 socket / 假 server**，不去起真端口
 *
 * 转发状态机（分片、keep-alive、正文透传、上游未就绪排队）全部用假 socket 驱动；
 * 监听部分用假 server 记录 `listen(...)` 参数（端口、host、`ipv6Only`）与
 * `setSecureContext(...)` 调用。TLS 材料用**临时目录里的真文件**（写文件不是占端口）。
 */

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import type { IncomingMessage } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { generateP256KeyPair } from '@dsh-mobile/protocol'

import { DeviceStore } from '../src/devices.ts'
import { isLoopbackRequest, createMobileHost } from '../src/index.ts'
import {
  createConnectionForwarder,
  createLanListener,
  injectForwardedFor,
  parseEndpoint,
  unavailableLanListenerStatus,
  type LanListener,
  type LanSocket,
  type ListenerServer,
} from '../src/lan-listener.ts'
import { createTlsManager, tlsPaths } from '../src/tls-cert.ts'

// ─────────────────────────────── 假 socket ───────────────────────────────

/** 一条假 socket：能 `feed` 数据、记录被写入的字节、能被销毁（emit 'close' 一次）。 */
class FakeSocket {
  remoteAddress: string | undefined
  readonly written: Buffer[] = []
  readonly pipedTo: FakeSocket[] = []
  destroyed = false
  private readonly emitter = new EventEmitter()

  constructor(remoteAddress?: string) {
    this.remoteAddress = remoteAddress
  }

  on(event: string, listener: (...args: never[]) => void): this {
    this.emitter.on(event, listener as (...args: unknown[]) => void)
    return this
  }

  write(chunk: Buffer): boolean {
    this.written.push(Buffer.from(chunk))
    return true
  }

  pipe(destination: FakeSocket): FakeSocket {
    this.pipedTo.push(destination)
    return destination
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.emitter.emit('close')
  }

  emit(event: string, ...args: unknown[]): void {
    this.emitter.emit(event, ...args)
  }

  /** 驱动 `clientSocket.on('data', ...)`。 */
  feed(chunk: string | Buffer): void {
    this.emitter.emit('data', Buffer.from(chunk))
  }

  /** 上游写进来的全部字节（latin1，便于逐字节比对）。 */
  text(): string {
    return Buffer.concat(this.written).toString('latin1')
  }
}

interface Forwarding {
  readonly client: FakeSocket
  readonly upstream: FakeSocket
  readonly forwarder: ReturnType<typeof createConnectionForwarder>
  readonly upstreamErrors: Error[]
}

/** 建一条"客户端 → 转发器 → 上游"的假链路（**不起真端口**）。 */
function makeForwarding(options: { remoteAddress?: string; connectBeforeReady?: boolean } = {}): Forwarding {
  const upstream = new FakeSocket()
  const upstreamErrors: Error[] = []
  const forwarder = createConnectionForwarder({
    target: { host: '127.0.0.1', port: 3080 },
    connect: () => upstream as unknown as LanSocket,
    onUpstreamError: (error) => upstreamErrors.push(error),
  })
  const client = new FakeSocket(options.remoteAddress)
  forwarder.handle(client as unknown as LanSocket)
  if (options.connectBeforeReady !== true) upstream.emit('connect')
  return { client, upstream, forwarder, upstreamErrors }
}

/** 一个完整的 HTTP/1.1 请求头。 */
function getRequest(path = '/mobile/pair/code', host = '10.0.0.7:3443'): string {
  return `GET ${path} HTTP/1.1\r\nHost: ${host}\r\nUser-Agent: 假浏览器\r\nAccept: */*\r\n\r\n`
}

/** 把转发后的字节还原成一个最小 `IncomingMessage`（只填 `isLoopbackRequest` 用到的两处）。 */
function requestFromBytes(bytes: Buffer): IncomingMessage {
  const text = bytes.toString('latin1')
  const headerEnd = text.indexOf('\r\n\r\n')
  const headerBlock = headerEnd < 0 ? text : text.slice(0, headerEnd)
  const lines = headerBlock.split('\r\n').slice(1)
  const headers: Record<string, string> = {}
  for (const line of lines) {
    const index = line.indexOf(':')
    if (index < 0) continue
    const name = line.slice(0, index).trim().toLowerCase()
    const value = line.slice(index + 1).trim()
    headers[name] = headers[name] === undefined ? value : `${headers[name]}, ${value}`
  }
  // socket 对端恒为回环：这正是"必须注入 x-forwarded-for"的原因
  return { headers, socket: { remoteAddress: '127.0.0.1' } } as unknown as IncomingMessage
}

/** 走一遍真实转发器，拿到上游收到的字节（`isLoopbackRequest` 的输入）。 */
function forwardedBytes(remoteAddress: string, request = getRequest()): Buffer {
  const link = makeForwarding({ remoteAddress })
  link.client.feed(request)
  return Buffer.concat(link.upstream.written)
}

// ─────────────────────────────── 假 server ───────────────────────────────

interface FakeServer {
  readonly server: ListenerServer
  readonly listenCalls: Array<{ port: number; host: string; ipv6Only?: boolean }>
  readonly secureContexts: Array<{ cert: Buffer; key: Buffer }>
  readonly closed: () => number
}

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`simulated ${code}`), { code })
}

/**
 * 一个假监听器：不 bind 真端口，只记录 `listen(...)` 参数，并按需异步报错/就绪。
 *
 * `listen` 里用 `queueMicrotask`（而不是同步回调）：真 `server.listen` 的 listening
 * 回调也是异步的，同步就绪会让"启动后立刻读状态"这类断言失去意义。
 */
function makeFakeServer(options: { failWith?: NodeJS.ErrnoException } = {}): FakeServer {
  const emitter = new EventEmitter()
  const listenCalls: FakeServer['listenCalls'] = []
  const secureContexts: FakeServer['secureContexts'] = []
  let closed = 0
  const server: ListenerServer = {
    on(event: string, listener: (...args: never[]) => void) {
      emitter.on(event, listener as (...args: unknown[]) => void)
      return server
    },
    listen(opts, callback) {
      listenCalls.push({
        port: opts.port,
        host: opts.host,
        ...(opts.ipv6Only === undefined ? {} : { ipv6Only: opts.ipv6Only }),
      })
      if (options.failWith !== undefined) queueMicrotask(() => emitter.emit('error', options.failWith))
      else queueMicrotask(() => callback())
      return server
    },
    close(callback) {
      closed += 1
      callback?.()
      return server
    },
    setSecureContext(context) {
      secureContexts.push({ cert: Buffer.from(context.cert), key: Buffer.from(context.key) })
      return undefined
    },
  }
  return { server, listenCalls, secureContexts, closed: () => closed }
}

/** 等一轮微任务/宏任务，让假 server 的异步"就绪/报错"落地。 */
function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

/** 临时目录里的 TLS 材料（真文件；写文件不是占端口）。 */
function tempTlsPaths(): { dir: string; paths: ReturnType<typeof tlsPaths>; write(cert: string, key: string): void } {
  const dir = mkdtempSync(join(tmpdir(), 'dshm-listener-tls-'))
  const paths = tlsPaths(dir)
  return {
    dir,
    paths,
    write(cert, key) {
      writeFileSync(paths.serverCert, cert)
      writeFileSync(paths.serverKey, key)
    },
  }
}

/** 造一个带（或不带）监听器的宿主，只为读 `selfcheck()` 的 `listener` 段。 */
function makeSelfcheckHost(listener?: LanListener): { report(): ReturnType<ReturnType<typeof createMobileHost>['selfcheck']>; cleanup(): void } {
  const root = mkdtempSync(join(tmpdir(), 'dshm-listener-selfcheck-'))
  const directory = join(root, 'storages', 'dsh-mobile')
  const store = new DeviceStore({ directory })
  const signingKey = generateP256KeyPair()
  const tls = createTlsManager({ directory: join(directory, 'tls'), addresses: () => ['10.9.9.9'] })
  tls.ensure()
  const host = createMobileHost({
    store,
    identity: {
      hostId: 'host-listener-test',
      hostName: '测试机',
      signingKey: { publicKey: signingKey.publicKey, privateKey: signingKey.privateKey },
    },
    gateway: {
      async invoke() {
        return {}
      },
      async stream() {
        return (async function* (): AsyncIterable<unknown> {})()
      },
    },
    endpoints: () => ['http://10.9.9.9:3081'],
    tls,
    ...(listener === undefined ? {} : { listener }),
  })
  return { report: () => host.selfcheck(), cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

// ─────────────────────────── parseEndpoint ───────────────────────────

describe('parseEndpoint：host:port 的解析（失败给原因，不退出进程）', () => {
  it('IPv4 与带方括号的 IPv6 都认（方括号必须去掉，否则 listen 解析失败）', () => {
    assert.deepEqual(parseEndpoint('0.0.0.0:3081', 'listener.plain'), { ok: true, endpoint: { host: '0.0.0.0', port: 3081 } })
    assert.deepEqual(parseEndpoint('[::]:3443', 'listener.tls'), { ok: true, endpoint: { host: '::', port: 3443 } })
    assert.deepEqual(parseEndpoint('127.0.0.1:3080', 'target'), { ok: true, endpoint: { host: '127.0.0.1', port: 3080 } })
  })

  it('非法形态返回原因（插件里只降级这一条监听，绝不 process.exit）', () => {
    for (const bad of ['3080', '0.0.0.0:0', '0.0.0.0:70000', '0.0.0.0:abc', ':3081']) {
      const result = parseEndpoint(bad, 'listener.plain')
      assert.equal(result.ok, false, `${bad} 应被拒绝`)
      if (!result.ok) assert.ok(result.error.length > 0, `${bad} 必须给出原因`)
    }
  })
})

// ─────────────────────── injectForwardedFor（纯函数） ───────────────────────

describe('injectForwardedFor：把真实来源注入请求头（★ 权限提升的那一处）', () => {
  it('注入到请求头末尾，原始字节一字不改', () => {
    const head = Buffer.from(getRequest(), 'latin1')
    const injected = injectForwardedFor(head, '10.0.0.7')
    const text = injected.toString('latin1')
    assert.ok(text.includes('\r\nx-forwarded-for: 10.0.0.7\r\n\r\n'))
    assert.equal(text.replace('\r\nx-forwarded-for: 10.0.0.7', ''), head.toString('latin1'))
    assert.equal(injected.length, head.length + '\r\nx-forwarded-for: 10.0.0.7'.length)
  })

  it('已有 x-forwarded-for（任意大小写）⇒ 原样返回，不重复注入、不覆盖', () => {
    const head = Buffer.from(`GET / HTTP/1.1\r\nHost: h\r\nX-Forwarded-For: 8.8.8.8\r\n\r\n`, 'latin1')
    assert.equal(injectForwardedFor(head, '10.0.0.7'), head)
  })

  it('请求头不完整 / 没有来源地址 ⇒ 原样返回（这就是"静默放弃注入"，必须由调用方攒齐）', () => {
    const partial = Buffer.from('GET / HTTP/1.1\r\nHost: h\r\n', 'latin1')
    assert.equal(injectForwardedFor(partial, '10.0.0.7'), partial)
    const head = Buffer.from(getRequest(), 'latin1')
    assert.equal(injectForwardedFor(head, undefined), head)
    assert.equal(injectForwardedFor(head, ''), head)
  })
})

// ─────────────────── 转发器：分片 / keep-alive / 正文 ───────────────────

describe('转发器：每个请求头收齐就注入一次（两次真 bug 的记录）', () => {
  it('分片到达的请求头：攒齐后才注入（块内没有 \\r\\n\\r\\n 时不许静默放弃）', () => {
    const link = makeForwarding({ remoteAddress: '10.0.0.7' })
    const request = getRequest()
    const cut = 24
    link.client.feed(request.slice(0, cut))
    assert.equal(link.upstream.written.length, 0, '请求头没收齐就不该转发（否则注入会被静默放弃）')
    link.client.feed(request.slice(cut))
    assert.ok(link.upstream.text().includes('x-forwarded-for: 10.0.0.7'))
    assert.ok(link.upstream.text().startsWith('GET /mobile/pair/code HTTP/1.1'))
  })

  it('keep-alive：同一条连接上的第二个请求同样注入（曾经只有第一个带来源）', () => {
    const link = makeForwarding({ remoteAddress: '10.0.0.7' })
    link.client.feed(getRequest('/mobile/app'))
    link.client.feed(getRequest('/mobile/pair/pending'))
    const text = link.upstream.text()
    const injected = text.match(/x-forwarded-for: 10\.0\.0\.7/g) ?? []
    assert.equal(injected.length, 2, '两个请求都必须带来源（否则第二个请求会被判成"人在电脑前"）')
    assert.ok(text.includes('/mobile/app'))
    assert.ok(text.includes('/mobile/pair/pending'))
  })

  it('正文按原样透传：POST body 逐字节不变，也不会被重复注入', () => {
    const link = makeForwarding({ remoteAddress: '10.0.0.7' })
    const body = '{"deviceId":"demo-device","n":1}'
    const request =
      `POST /mobile/pair/claim HTTP/1.1\r\nHost: 10.0.0.7:3443\r\nContent-Type: application/json\r\n` +
      `Content-Length: ${body.length}\r\n\r\n${body}`
    link.client.feed(request)
    const expected = request.replace('\r\n\r\n', '\r\nx-forwarded-for: 10.0.0.7\r\n\r\n')
    assert.equal(link.upstream.text(), expected)
  })

  it('上游未就绪时到达的数据先入队（不丢包），就绪后按原顺序发出', () => {
    const link = makeForwarding({ remoteAddress: '10.0.0.7', connectBeforeReady: true })
    link.client.feed(getRequest())
    assert.equal(link.upstream.written.length, 0, '上游还没连上就不该写（会被丢）')
    link.upstream.emit('connect')
    assert.ok(link.upstream.text().includes('x-forwarded-for: 10.0.0.7'))
  })

  it('上游连接失败 ⇒ 两端都销毁、原因上报、不抛错', () => {
    const link = makeForwarding({ remoteAddress: '10.0.0.7' })
    link.upstream.emit('error', new Error('ECONNREFUSED 127.0.0.1:3080'))
    assert.equal(link.upstreamErrors.length, 1)
    assert.equal(link.client.destroyed, true)
    assert.equal(link.upstream.destroyed, true)
  })

  it('客户端断开 ⇒ 上游一起收（不留半条连接）', () => {
    const link = makeForwarding({ remoteAddress: '10.0.0.7' })
    link.client.destroy()
    assert.equal(link.upstream.destroyed, true)
  })
})

// ─────────── ★★ 变异可验：去掉注入 ⇒ 局域网来源拿不到 LOCAL_ONLY ───────────

describe('★★ x-forwarded-for 与 LOCAL_ONLY：去掉注入 ⇒ 本组必红', () => {
  it('局域网来源经本插件监听后仍被判成"手机"（对照：没有注入就会被判成"人在电脑前"）', () => {
    const raw = Buffer.from(getRequest(), 'latin1')
    const forwarded = forwardedBytes('10.0.0.7')

    // ① 宿主看到的 socket 对端恒为回环（监听器与 DSH 同机），真实来源只能靠注入的头表达
    assert.equal(requestFromBytes(forwarded).socket.remoteAddress, '127.0.0.1')
    // ⇒ 局域网来源**不是**"人在电脑前"：LOCAL_ONLY（配对码/配对确认/设备管理/端侧控制）拒绝。
    //    这一条就是变异哨兵：去掉注入（`forward(joined)`）它立刻变成 true ⇒ 红。
    assert.equal(
      isLoopbackRequest(requestFromBytes(forwarded)),
      false,
      '去掉 x-forwarded-for 注入 ⇒ 局域网来源被当成"人在电脑前"（LOCAL_ONLY 全家可达）= 权限提升',
    )

    // ② 注入确实发生了（跟着上一条一起保证"注入的内容是真实来源"）
    assert.ok(forwarded.toString('latin1').includes('x-forwarded-for: 10.0.0.7'))

    // ③ 对照：这一段就是"去掉注入"之后的样子 —— 同一个请求会被判成"人在电脑前"（权限提升）
    assert.equal(raw.toString('latin1').includes('x-forwarded-for'), false)
    assert.equal(
      isLoopbackRequest(requestFromBytes(raw)),
      true,
      '没有注入 ⇒ 局域网来源被当成"人在电脑前"（LOCAL_ONLY 全家可达）——这正是必须钉死的行为',
    )
  })

  it('本机回环来源注入 127.0.0.1 后仍是"人在电脑前"（注入不误伤电脑本机）', () => {
    assert.equal(isLoopbackRequest(requestFromBytes(forwardedBytes('127.0.0.1'))), true)
    assert.equal(isLoopbackRequest(requestFromBytes(forwardedBytes('::1'))), true)
  })

  it('客户端自带 x-forwarded-for ⇒ 不覆盖（只保证"本插件不注入"这件事有据可依）', () => {
    const link = makeForwarding({ remoteAddress: '10.0.0.7' })
    link.client.feed('GET / HTTP/1.1\r\nHost: h\r\nX-Forwarded-For: 8.8.8.8\r\n\r\n')
    const text = link.upstream.text()
    assert.equal((text.match(/x-forwarded-for:/gi) ?? []).length, 1)
    assert.ok(text.includes('X-Forwarded-For: 8.8.8.8'))
  })
})

// ─────────────────── 监听器：默认关闭 / IPv6 / 端口冲突 ───────────────────

describe('createLanListener：默认关闭、IPv6 伴随、端口冲突不换端口、失败不抛错', () => {
  it('默认关闭（enabled:false）⇒ 一个监听都不建：老部署行为一字不变', () => {
    let created = 0
    const logs: string[] = []
    const listener = createLanListener({
      enabled: false,
      target: { host: '127.0.0.1', port: 3080 },
      createTcpServer: () => {
        created += 1
        return makeFakeServer().server
      },
      createTlsServer: () => {
        created += 1
        return makeFakeServer().server
      },
      logger: { info: (message) => logs.push(message) },
    })
    const status = listener.start()
    assert.equal(created, 0)
    assert.equal(status.enabled, false)
    assert.equal(status.bindings.length, 0)
    assert.equal(status.ok, true, '"没开"不是失败（否则老部署会全员报警）')
    assert.ok(logs.some((line) => line.includes('未启用')))
  })

  it('enabled:true + 0.0.0.0 ⇒ IPv4 与 IPv6 伴随都在听（漏了 IPv6 = 蜂窝网直连失效且无症状）', async () => {
    const material = tempTlsPaths()
    const created: FakeServer[] = []
    try {
      material.write('CERT', 'KEY')
      const listener = createLanListener({
        enabled: true,
        plain: '0.0.0.0:3081',
        tls: '0.0.0.0:3443',
        target: { host: '127.0.0.1', port: 3080 },
        tlsPaths: material.paths,
        createTcpServer: () => {
          const fake = makeFakeServer()
          created.push(fake)
          return fake.server
        },
        createTlsServer: () => {
          const fake = makeFakeServer()
          created.push(fake)
          return fake.server
        },
      })
      const started = listener.start()
      await settle()
      assert.deepEqual(
        created.map((fake) => fake.listenCalls),
        [
          [{ port: 3081, host: '0.0.0.0' }],
          [{ port: 3081, host: '::', ipv6Only: true }],
          [{ port: 3443, host: '0.0.0.0' }],
          [{ port: 3443, host: '::', ipv6Only: true }],
        ],
      )
      const status = listener.status()
      assert.equal(started.tlsLoaded, true)
      assert.equal(status.ok, true)
      assert.equal(status.bindings.length, 4)
      assert.equal(status.bindings.every((binding) => binding.listening), true)
      assert.deepEqual(
        status.bindings.map((binding) => `${binding.kind}:${binding.host}:${binding.port}`),
        ['plain:0.0.0.0:3081', 'plain::::3081', 'tls:0.0.0.0:3443', 'tls::::3443'],
      )
      assert.equal(status.forwardedForInjection, true)
    } finally {
      rmSync(material.dir, { recursive: true, force: true })
    }
  })

  it('端口冲突（EADDRINUSE）⇒ 只警告、**不换端口**，并点明"可能上次的 lan-proxy 还活着"', async () => {
    const warnings: string[] = []
    const tcpServers: FakeServer[] = []
    const listener = createLanListener({
      enabled: true,
      plain: '0.0.0.0:3081',
      target: { host: '127.0.0.1', port: 3080 },
      // 第一个（IPv4）失败，第二个（IPv6 伴随）正常 —— 与"老 lan-proxy 还在"的真实现象一致
      createTcpServer: () => {
        const fake = makeFakeServer(tcpServers.length === 0 ? { failWith: errno('EADDRINUSE') } : {})
        tcpServers.push(fake)
        return fake.server
      },
      logger: { warn: (message) => warnings.push(message), info: () => {} },
    })
    listener.start()
    await settle()
    // ★ 必须重新取一次：`start()` 返回的是"那一刻"的快照，而假 server 的就绪/报错回调是异步的
    const status = listener.status()
    assert.equal(status.ok, false, '端口被占 ⇒ 手机入口不可用，自检必须报出来')
    const plainBinding = status.bindings.find((binding) => binding.kind === 'plain' && !binding.ipv6)
    assert.equal(plainBinding?.listening, false)
    assert.equal(plainBinding?.code, 'EADDRINUSE')
    assert.ok(plainBinding?.hint?.includes('lan-proxy'), '提示必须点明"可能上一次的 lan-proxy 还活着"')
    assert.ok(plainBinding?.hint?.includes('不会自动换端口'))
    assert.ok(warnings.some((line) => line.includes('lan-proxy')))
    // ★ 只有一次 3081 的 IPv4 尝试 + 一次 IPv6 伴随；**没有**换端口重试
    assert.deepEqual(
      tcpServers.map((fake) => fake.listenCalls.map((call) => call.port)),
      [[3081], [3081]],
    )
    assert.deepEqual(
      status.warnings.some((line) => line.includes('lan-proxy')),
      true,
    )
  })

  it('缺少 TLS 证书 ⇒ HTTPS 不起但明文照起（降级且说得清，不抛错）', async () => {
    const tcpServers: FakeServer[] = []
    const listener = createLanListener({
      enabled: true,
      plain: '127.0.0.1:3081',
      tls: '0.0.0.0:3443',
      target: { host: '127.0.0.1', port: 3080 },
      // 指向不存在的文件：读不到材料
      tlsPaths: tlsPaths(join(tmpdir(), 'dshm-listener-missing-tls-does-not-exist')),
      createTcpServer: () => {
        const fake = makeFakeServer()
        tcpServers.push(fake)
        return fake.server
      },
      logger: { warn: () => {}, info: () => {} },
    })
    listener.start()
    await settle()
    // ★ 重新取快照：假 server 的就绪回调是异步的
    const settled = listener.status()
    assert.equal(settled.tlsLoaded, false)
    const plainBinding = settled.bindings.find((binding) => binding.kind === 'plain')
    assert.equal(plainBinding?.listening, true, '明文监听不该被证书问题连坐')
    const tlsBinding = settled.bindings.find((binding) => binding.kind === 'tls')
    assert.equal(tlsBinding?.listening, false)
    assert.ok(tlsBinding?.error?.includes('读不到 TLS 证书'))
    assert.equal(settled.ok, false)
    assert.ok(settled.warnings.some((line) => line.includes('读不到 TLS 证书')))
    assert.equal(listener.refreshTls().reloaded, false, '没有 TLS 监听时热更新是空操作')
  })

  it('IPv6 伴随监听失败只降级：IPv4（局域网）照常 ok，不把手机入口判死', async () => {
    const tcpServers: FakeServer[] = []
    const listener = createLanListener({
      enabled: true,
      plain: '0.0.0.0:3081',
      target: { host: '127.0.0.1', port: 3080 },
      createTcpServer: () => {
        const fake = makeFakeServer(tcpServers.length === 1 ? { failWith: errno('EAFNOSUPPORT') } : {})
        tcpServers.push(fake)
        return fake.server
      },
      logger: { warn: () => {}, info: () => {} },
    })
    listener.start()
    await settle()
    const status = listener.status()
    assert.equal(status.ok, true, 'IPv6 起不来不该让局域网入口判死')
    assert.equal(status.bindings.find((binding) => !binding.ipv6)?.listening, true)
    assert.equal(status.bindings.find((binding) => binding.ipv6)?.listening, false)
    assert.ok(status.warnings.some((line) => line.includes('IPv6 伴随监听')))
  })

  it('dispose() 关掉全部监听（含 IPv6 伴随）：不再留占端口的孤儿', async () => {
    const material = tempTlsPaths()
    const created: FakeServer[] = []
    try {
      material.write('CERT', 'KEY')
      const listener = createLanListener({
        enabled: true,
        plain: '0.0.0.0:3081',
        tls: '0.0.0.0:3443',
        target: { host: '127.0.0.1', port: 3080 },
        tlsPaths: material.paths,
        createTcpServer: () => {
          const fake = makeFakeServer()
          created.push(fake)
          return fake.server
        },
        createTlsServer: () => {
          const fake = makeFakeServer()
          created.push(fake)
          return fake.server
        },
        logger: { warn: () => {}, info: () => {} },
      })
      listener.start()
      await settle()
      assert.equal(created.length, 4)
      listener.dispose()
      assert.deepEqual(created.map((fake) => fake.closed()), [1, 1, 1, 1])
    } finally {
      rmSync(material.dir, { recursive: true, force: true })
    }
  })
})

// ─────────────────────────── 证书热更新（C1-6） ───────────────────────────

describe('证书热更新：重签叶子后不必重启 DSH', () => {
  it('叶子文件变了（mtime/size）⇒ 对已建立的 TLS 监听 setSecureContext 新证书', async () => {
    const material = tempTlsPaths()
    const tlsServers: FakeServer[] = []
    const logs: string[] = []
    try {
      material.write('CERT-1', 'KEY-1')
      const listener = createLanListener({
        enabled: true,
        plain: '127.0.0.1:3081',
        tls: '0.0.0.0:3443',
        target: { host: '127.0.0.1', port: 3080 },
        tlsPaths: material.paths,
        createTcpServer: () => makeFakeServer().server,
        createTlsServer: () => {
          const fake = makeFakeServer()
          tlsServers.push(fake)
          return fake.server
        },
        logger: { info: (message) => logs.push(message), warn: () => {} },
      })
      listener.start()
      await settle()
      assert.equal(tlsServers.length, 2, 'IPv4 + IPv6 两个 TLS 监听都要热更新')
      assert.equal(tlsServers[0]?.secureContexts.length, 0, '刚起监听时不该重复 setSecureContext')

      // 模拟 ensureTlsMaterial 用同一张 CA 重签叶子（地址变了）
      material.write('CERT-2-RESIGNED', 'KEY-2-RESIGNED')
      const reload = listener.refreshTls()
      assert.equal(reload.reloaded, true)
      for (const fake of tlsServers) {
        assert.equal(fake.secureContexts.length, 1)
        assert.equal(fake.secureContexts[0]?.cert.toString('utf8'), 'CERT-2-RESIGNED')
        assert.equal(fake.secureContexts[0]?.key.toString('utf8'), 'KEY-2-RESIGNED')
      }
      const status = listener.status()
      assert.equal(status.tlsReloads, 1)
      assert.equal(typeof status.tlsLastReloadAt, 'string')
      assert.ok(logs.some((line) => line.includes('热更新')))
    } finally {
      rmSync(material.dir, { recursive: true, force: true })
    }
  })

  it('文件没变 ⇒ 不重载（避免每次 ensure 都无谓地换上下文）', async () => {
    const material = tempTlsPaths()
    const tlsServers: FakeServer[] = []
    try {
      material.write('CERT-1', 'KEY-1')
      const listener = createLanListener({
        enabled: true,
        plain: '127.0.0.1:3081',
        tls: '0.0.0.0:3443',
        target: { host: '127.0.0.1', port: 3080 },
        tlsPaths: material.paths,
        createTcpServer: () => makeFakeServer().server,
        createTlsServer: () => {
          const fake = makeFakeServer()
          tlsServers.push(fake)
          return fake.server
        },
        logger: { info: () => {}, warn: () => {} },
      })
      listener.start()
      await settle()
      assert.equal(listener.refreshTls().reloaded, false)
      assert.equal(listener.refreshTls().reloaded, false)
      assert.equal(tlsServers[0]?.secureContexts.length, 0)
      assert.equal(listener.status().tlsReloads, 0)
    } finally {
      rmSync(material.dir, { recursive: true, force: true })
    }
  })

  it('没启用监听 / 没配 TLS ⇒ refreshTls 是空操作（不报错、不改状态）', () => {
    const disabled = createLanListener({ enabled: false, target: { host: '127.0.0.1', port: 3080 } })
    disabled.start()
    assert.deepEqual(disabled.refreshTls(), { reloaded: false })
    const missing = unavailableLanListenerStatus()
    assert.equal(missing.tlsLoaded, false)
    assert.equal(missing.forwardedForInjection, true)
  })
})

// ───────────────────── 自检里的 listener 段（宿主级纯数据） ─────────────────────

describe('自检的 listener 段：三层问题分得开（没开 / 就绪 / 坏了）', () => {
  it('未注入监听器 ⇒ available:false 且不算失败（老部署的手机入口在外置代理里）', () => {
    const env = makeSelfcheckHost()
    try {
      const report = env.report()
      assert.equal(report.listener.available, false)
      assert.equal(report.listener.enabled, false)
      assert.equal(report.listener.ok, true)
      assert.equal(report.ok, true, '监听没注入不该把自检判成失败')
      assert.deepEqual(report.listener.bindings, [])
      assert.equal(report.warnings.some((warning) => warning.includes('局域网监听')), false)
    } finally {
      env.cleanup()
    }
  })

  it('启用且就绪 ⇒ 自检报出绑定与 x-forwarded-for 注入状态', async () => {
    const listener = createLanListener({
      enabled: true,
      plain: '127.0.0.1:3081',
      target: { host: '127.0.0.1', port: 3080 },
      createTcpServer: () => makeFakeServer().server,
      logger: { info: () => {}, warn: () => {} },
    })
    listener.start()
    await settle()
    const env = makeSelfcheckHost(listener)
    try {
      const report = env.report()
      assert.equal(report.listener.available, true)
      assert.equal(report.listener.enabled, true)
      assert.equal(report.listener.ok, true)
      assert.equal(report.listener.forwardedForInjection, true)
      assert.deepEqual(
        report.listener.bindings.map((binding) => `${binding.kind}:${binding.address}`),
        ['plain:127.0.0.1:3081'],
      )
      assert.equal(report.ok, true)
    } finally {
      env.cleanup()
      listener.dispose()
    }
  })

  it('★ 端口被占 ⇒ 自检 ok=false 且 warnings 点明"可能上次的 lan-proxy 还活着"', async () => {
    const listener = createLanListener({
      enabled: true,
      plain: '127.0.0.1:3081',
      target: { host: '127.0.0.1', port: 3080 },
      createTcpServer: () => makeFakeServer({ failWith: errno('EADDRINUSE') }).server,
      logger: { info: () => {}, warn: () => {} },
    })
    listener.start()
    await settle()
    const env = makeSelfcheckHost(listener)
    try {
      const report = env.report()
      assert.equal(report.listener.ok, false)
      assert.equal(report.ok, false, '手机入口不可用必须让自检变红（但 DSH 本身照常跑）')
      assert.equal(report.listener.bindings[0]?.code, 'EADDRINUSE')
      assert.equal(
        report.warnings.some((warning) => warning.includes('lan-proxy')),
        true,
      )
      assert.equal(
        report.warnings.some((warning) => warning.includes('局域网监听')),
        true,
      )
    } finally {
      env.cleanup()
      listener.dispose()
    }
  })
})
