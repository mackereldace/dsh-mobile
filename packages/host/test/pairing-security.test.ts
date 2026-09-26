/**
 * 配对/准入边界的安全回归（评估文档 `14-项目评估与整改清单.md` T2 / T3 / T6）。
 *
 * 三张卡各对应一个**已核实的具体缺口**，本文件把它们钉成可执行断言：
 *  - **T2**：6 位配对码改用 CSPRNG；`/mobile/p/<码>` 换票据加失败限速；票据一次性语义。
 *  - **T3**：中继**回源**通道漏掉了 `/mobile/device/*`，而回源落 `127.0.0.1` 会被
 *    `isLoopbackRequest` 判成"人在电脑前" ⇒ 同局域网/中继上的人能指挥别人的手机。
 *  - **T6**：`handleUpgrade` 没有 Host/Origin 栅栏（`handleHttp` 有），准入不对称。
 *
 * ## 为什么单开一个文件而不是塞进 host.test.ts
 *
 * 这是**边界安全**的回归，关注点是"哪些请求应当被拒"，与 host.test.ts 的
 * "完整协议链路能不能跑通"是两件事；分开放，红的时候一眼知道红在哪一类。
 * （同时 host.test.ts 正由并行任务改动，新文件互不干扰。）
 */

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Duplex } from 'node:stream'
import { test } from 'node:test'

import { fingerprint, generateP256KeyPair } from '@dsh-mobile/protocol'

import { DeviceStore } from '../src/devices.ts'
import { createMobileHost, isRefusedRelayBackhaulPath, type MobileHost } from '../src/index.ts'
import { acceptWebSocket, type WebSocketConnection } from '../src/websocket.ts'

// ─────────────────────────────── 测试脚手架 ───────────────────────────────

interface HostEnv {
  readonly host: MobileHost
  readonly dir: string
  cleanup(): void
}

/** 建一个只依赖内存/临时目录的宿主（不碰生产 `~/.dsh`，不起真实端口）。 */
function makeHost(
  options: {
    trustedHosts?: readonly string[]
    phoneBaseUrl?: string
    selfPort?: number
    relay?: { attachUrl: string; attachHttpUrl: string; token: string }
  } = {},
): HostEnv {
  const dir = mkdtempSync(join(tmpdir(), 'dshm-pairsec-'))
  const store = new DeviceStore({ directory: dir })
  const signingKey = generateP256KeyPair()
  const host: MobileHost = createMobileHost({
    store,
    identity: {
      hostId: 'host-pairing-security',
      hostName: '测试 Mac',
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
    endpoints: () => ['http://127.0.0.1:3080'],
    ...(options.selfPort === undefined ? {} : { selfPort: options.selfPort }),
    ...(options.trustedHosts === undefined ? {} : { trustedHosts: options.trustedHosts }),
    ...(options.phoneBaseUrl === undefined ? {} : { phoneBaseUrl: options.phoneBaseUrl }),
    ...(options.relay === undefined
      ? {}
      : {
          config: {
            relayUrl: options.relay.attachUrl,
            relayHttpUrl: options.relay.attachHttpUrl,
            relayToken: options.relay.token,
            relayPoolSize: 1,
          },
        }),
  })
  return {
    host,
    dir,
    cleanup: () => {
      host.stopRelayDialer()
      host.stopRelayHttpBackhaul()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

interface HttpResult {
  readonly status: number
  readonly headers: Record<string, string>
  readonly body: string
}

/**
 * 以 HTTP 语义直接驱动 `handleHttp`（绕过真实 socket）。
 * 与 host.test.ts 的 `callHost` 同一思路，但额外把响应头带出来（短码入口要看 Location / Retry-After）。
 */
async function httpCall(
  host: MobileHost,
  method: string,
  path: string,
  options: { remoteAddress?: string; headers?: Record<string, string>; body?: unknown } = {},
): Promise<HttpResult> {
  const chunks = options.body === undefined ? [] : [Buffer.from(JSON.stringify(options.body), 'utf8')]
  const req = {
    method,
    url: path,
    headers: { host: '127.0.0.1:3080', ...(options.headers ?? {}) },
    socket: { remoteAddress: options.remoteAddress ?? '127.0.0.1' },
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  } as unknown as Parameters<MobileHost['handleHttp']>[0]

  let result: { status: number; headers: Record<string, string>; body: string } | undefined
  const res = {
    headersSent: false,
    writeHead(code: number, headers?: Record<string, string>) {
      result = { status: code, headers: headers ?? {}, body: '' }
      return this
    },
    end(data?: Buffer | string) {
      if (result !== undefined) result.body = typeof data === 'string' ? data : (data?.toString('utf8') ?? '')
    },
  } as unknown as Parameters<MobileHost['handleHttp']>[1]

  assert.equal(host.handleHttp(req, res), true, `${method} ${path} 应由宿主插件处理`)
  // 管理端点走的是 `void handlePairHttp(...)`（异步），这里等它一拍
  for (let i = 0; i < 200 && result === undefined; i++) await new Promise((resolve) => setTimeout(resolve, 2))
  assert.notEqual(result, undefined, `${method} ${path} 未产生响应`)
  return result as HttpResult
}

/** 生成一次配对，返回 6 位码与票据。 */
async function createPairing(env: HostEnv): Promise<{ code: string; ticket: string }> {
  const created = await httpCall(env.host, 'POST', '/mobile/pair/code', { body: {} })
  assert.equal(created.status, 200, '生成配对码应成功')
  const parsed = JSON.parse(created.body) as { ticket: { code: string; ticket: string } }
  return { code: parsed.ticket.code, ticket: parsed.ticket.ticket }
}

/** 用票据提交一次设备 claim。 */
function claimTicket(env: HostEnv, ticket: string, deviceId: string, signingPublicKey: string): Promise<HttpResult> {
  return httpCall(env.host, 'POST', '/mobile/pair/claim', {
    headers: { 'content-type': 'application/json' },
    body: {
      ticket,
      deviceId,
      deviceSigningKey: signingPublicKey,
      fingerprint: fingerprint(signingPublicKey),
      name: `测试设备 ${deviceId}`,
      platform: 'android',
    },
  })
}

// ─────────────────────────────── T2：配对码 ───────────────────────────────

test('T2 配对码来自密码学随机源（源码里不再有 Math.random，区间恰好 90 万）', () => {
  const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
  // 只看代码行：注释里为了讲清"为什么改"必须写出旧写法（含 `Math.random`）
  const codeLines = source
    .split('\n')
    .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
    .join('\n')
  assert.equal(/Math\.random/.test(codeLines), false, '安全值不得再用 Math.random（非 CSPRNG）')
  assert.match(
    source,
    /randomInt\(\s*100000,\s*1_000_000\s*\)/,
    '配对码必须用 node:crypto 的 randomInt(100000, 1000000)：上界排他、无取模偏差',
  )

  // 行为面：产出的码必须是 6 位、落在 [100000, 999999]
  const env = makeHost()
  try {
    const codes = new Set<string>()
    for (let i = 0; i < 300; i++) {
      const ticket = env.host.createPairing()
      assert.match(ticket.ticket.code, /^[0-9]{6}$/, '配对码必须是 6 位数字')
      const value = Number(ticket.ticket.code)
      assert.ok(value >= 100000 && value <= 999999, `配对码越界：${ticket.ticket.code}`)
      codes.add(ticket.ticket.code)
    }
    assert.ok(codes.size > 250, `300 次生成应有足够分散度（去重后 ${codes.size}）`)
  } finally {
    env.cleanup()
  }
})

test('T2 短码换票据：窗口内失败 10 次后进入冷却（429 + Retry-After），且按来源分桶不连坐', async () => {
  const env = makeHost()
  try {
    for (let i = 0; i < 10; i++) {
      const res = await httpCall(env.host, 'GET', '/mobile/p/000000', { remoteAddress: '10.0.0.9' })
      assert.equal(res.status, 404, `第 ${i + 1} 次无效码应为 404（码空间可枚举正是要挡的）`)
    }
    const limited = await httpCall(env.host, 'GET', '/mobile/p/000000', { remoteAddress: '10.0.0.9' })
    assert.equal(limited.status, 429, '同一来源超过失败阈值后必须进入冷却')
    assert.ok(
      Number(limited.headers['retry-after'] ?? '0') > 0,
      '429 必须带可解析的 Retry-After（否则客户端只能瞎猜）',
    )

    // 另一个来源不受影响：限速按来源计数，一台设备狂试不得把别人一起挡在门外
    const other = await httpCall(env.host, 'GET', '/mobile/p/000000', { remoteAddress: '10.0.0.10' })
    assert.equal(other.status, 404, '别的来源不该被同一个桶连坐')
  } finally {
    env.cleanup()
  }
})

test('T2 短码换票据：成功即清零；码被 claim 之后不再换出票据（用过即废）', async () => {
  const env = makeHost()
  try {
    // 先手误两次，再用正确的码 —— 成功应把整桶清零
    await httpCall(env.host, 'GET', '/mobile/p/111111', { remoteAddress: '10.0.0.12' })
    await httpCall(env.host, 'GET', '/mobile/p/111111', { remoteAddress: '10.0.0.12' })

    const pairing = await createPairing(env)
    const good = await httpCall(env.host, 'GET', `/mobile/p/${pairing.code}`, { remoteAddress: '10.0.0.12' })
    assert.equal(good.status, 302, '有效短码应 302 到应用外壳')
    assert.match(good.headers['location'] ?? '', /^\/mobile\/app\?pair=/, '必须把票据带在 Location 上')

    // 若前面两次失败没有被"成功即清零"，这里第 8 次就会撞上冷却（2 + 8 = 10）⇒ 本断言证明清零生效
    for (let i = 0; i < 9; i++) {
      const res = await httpCall(env.host, 'GET', '/mobile/p/222222', { remoteAddress: '10.0.0.12' })
      assert.equal(res.status, 404, '成功之后计数必须清零（否则正常用户的手误会越攒越多）')
    }

    // 手机拿票据去 claim；此后这个码不得再换出票据。
    // ★ 用一个**全新的来源**做最后一步：上面的限速探针已经把 10.0.0.12 的桶推到阈值边缘，
    //   混在一起会让"404（码已用）"与"429（被限速）"无法区分。
    const payload = decodeURIComponent((good.headers['location'] ?? '').replace('/mobile/app?pair=', ''))
    const ticket = (JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { ticket: string }).ticket
    const claimed = await claimTicket(env, ticket, 'dev-single-use', generateP256KeyPair().publicKey)
    assert.equal(claimed.status, 200, 'claim 应被接受')
    assert.equal((JSON.parse(claimed.body) as { state: string }).state, 'pending', '默认要求电脑端人工确认')

    const again = await httpCall(env.host, 'GET', `/mobile/p/${pairing.code}`, { remoteAddress: '10.0.0.13' })
    assert.equal(again.status, 404, '码被 claim 后不得再换出票据（用过即废）')
  } finally {
    env.cleanup()
  }
})

test('T2 配对票据不能被第二个设备重复 claim（claim 层的一次性语义）', async () => {
  const env = makeHost()
  try {
    const pairing = await createPairing(env)
    const first = await claimTicket(env, pairing.ticket, 'dev-first', generateP256KeyPair().publicKey)
    assert.equal(first.status, 200)
    // 同一张票据换一台设备再来一次：只应回放当前状态，不得覆盖已登记的 claim
    const second = await claimTicket(env, pairing.ticket, 'dev-second', generateP256KeyPair().publicKey)
    assert.equal(second.status, 200, '重复 claim 返回当前状态而不是报错（手机轮询依赖这一点）')
    const pending = env.host.listPendingPairings().find((entry) => entry.code === pairing.code)
    assert.equal(pending?.deviceId, 'dev-first', '票据不得被第二个设备用来改写 claim')
  } finally {
    env.cleanup()
  }
})

// ─────────────────────── T3：中继回源绕过 LOCAL_ONLY ───────────────────────

test('T3 回源拒绝名单覆盖整个 /mobile/device/*，且不误伤手机要用的路径', () => {
  // 必须拒绝：端侧控制（本次评估发现漏网的两条就在这里）
  for (const path of ['/mobile/device/call', '/mobile/device/status', '/mobile/device/whatever-added-later']) {
    assert.equal(isRefusedRelayBackhaulPath(path), true, `${path} 必须被回源拒绝（否则等于绕过 LOCAL_ONLY）`)
  }
  // 已有名单不能被改坏
  for (const path of [
    '/mobile/devices',
    '/mobile/devices/update',
    '/mobile/audit',
    '/mobile/debug',
    '/mobile/pair/code',
    '/mobile/pair/confirm',
    '/mobile/pair/pending',
    '/mobile/pair/status',
  ]) {
    assert.equal(isRefusedRelayBackhaulPath(path), true, `${path} 必须继续被回源拒绝`)
  }
  // 手机经中继正常用到的路径：一条都不能误拒（"误伤真机"只有真机才看得出来）
  for (const path of [
    '/mobile/app',
    '/mobile/boot.js',
    '/mobile/boot.js.map',
    '/mobile/sw.js',
    '/mobile/manifest',
    '/mobile/manifest.webmanifest',
    '/mobile/icon-192.png',
    '/mobile/ca.crt',
    '/mobile/trust.crt',
    '/mobile/app.apk',
    '/mobile/pair/claim',
    '/assets/index-abc123.js',
    '/plugins/@dsh-mobile/bridge/client.js',
  ]) {
    assert.equal(isRefusedRelayBackhaulPath(path), false, `${path} 是手机要用的路径，不能被误拒`)
  }
})

/** 假中继：只实现回源通道需要的握手/首条 token/请求-应答。
 *
 *  - 电脑会主动拨到 `/attach`（外拨池，本用例不用）与 `/attach-http`（回源，本用例用）；
 *  - 收到 token 后即可向电脑发一条 `{id, method, path, headers, body}` 的请求行；
 *  - 断言的是**电脑回的应答**，因此覆盖的是真实回源通道的完整判定与 fetch 环节。
 */
interface FakeRelay {
  readonly attachUrl: string
  readonly attachHttpUrl: string
  waitForBackhaul(): Promise<void>
  ask(path: string, init?: { method?: string; body?: string }): Promise<{ status: number; body: string }>
  close(): Promise<void>
}

function startFakeRelay(): Promise<FakeRelay> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    const sockets = new Set<Duplex>()
    const waiters = new Map<string, (reply: { status: number; body: string }) => void>()
    let nextId = 0
    let sendToHost: ((text: string) => void) | undefined
    let markReady: (() => void) | undefined
    const ready = new Promise<void>((r) => {
      markReady = r
    })

    server.on('upgrade', (req, socket) => {
      sockets.add(socket)
      socket.on('close', () => sockets.delete(socket))
      const connection: WebSocketConnection | undefined = acceptWebSocket(socket, req, {})
      if (connection === undefined) {
        socket.destroy()
        return
      }
      const isBackhaul = (req.url ?? '').includes('attach-http')
      let authenticated = false
      connection.onMessage((data: Buffer) => {
        const text = data.toString('utf8')
        if (!authenticated) {
          // 首条消息是共享密钥（中继用；测试不校验内容，只用它标记"通道已就绪"）
          authenticated = true
          if (isBackhaul) {
            sendToHost = (payload: string) => {
              connection.send(Buffer.from(payload, 'utf8'))
            }
            markReady?.()
          }
          return
        }
        let message: { id?: unknown; status?: unknown; body?: unknown }
        try {
          message = JSON.parse(text) as typeof message
        } catch {
          return
        }
        if (typeof message.id !== 'string') return
        const waiter = waiters.get(message.id)
        if (waiter === undefined) return
        waiters.delete(message.id)
        waiter({
          status: typeof message.status === 'number' ? message.status : 0,
          body: typeof message.body === 'string' ? Buffer.from(message.body, 'base64').toString('utf8') : '',
        })
      })
    })

    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        reject(new Error('假中继未能拿到监听端口'))
        return
      }
      const port = address.port
      resolve({
        attachUrl: `ws://127.0.0.1:${port}/attach`,
        attachHttpUrl: `ws://127.0.0.1:${port}/attach-http`,
        waitForBackhaul: () => ready,
        ask: async (path, init) => {
          await ready
          const send = sendToHost
          if (send === undefined) throw new Error('回源通道尚未建立')
          const id = `req-${++nextId}`
          const reply = new Promise<{ status: number; body: string }>((resolveReply, rejectReply) => {
            waiters.set(id, resolveReply)
            const timer = setTimeout(() => {
              if (waiters.delete(id)) rejectReply(new Error(`回源请求超时：${path}`))
            }, 5000)
            timer.unref?.()
          })
          send(
            JSON.stringify({
              id,
              method: init?.method ?? 'GET',
              path,
              headers: {},
              ...(init?.body === undefined ? {} : { body: Buffer.from(init.body, 'utf8').toString('base64') }),
            }),
          )
          return reply
        },
        close: async () => {
          for (const socket of sockets) socket.destroy()
          await new Promise<void>((done) => server.close(() => done()))
        },
      })
    })
  })
}

test('T3 经中继回源的 /mobile/device/call 与 /mobile/device/status 被拒（不落到环回 fetch）', async () => {
  const relay = await startFakeRelay()
  const originalFetch = globalThis.fetch
  const fetched: string[] = []
  // 回源命中时会真的 fetch 自己的环回端口；测试里换成探针，既能证明"被拒的没被转发"，
  // 又能给"正常路径仍被转发"一个正向对照。
  globalThis.fetch = (async (input: string | URL | Request) => {
    fetched.push(String(input))
    return new Response('shell', { status: 200, headers: { 'content-type': 'text/html' } })
  }) as typeof globalThis.fetch

  const env = makeHost({
    selfPort: 4599,
    relay: { attachUrl: relay.attachUrl, attachHttpUrl: relay.attachHttpUrl, token: 'pairing-security-token' },
  })
  try {
    await relay.waitForBackhaul()

    const call = await relay.ask('/mobile/device/call', {
      method: 'POST',
      body: JSON.stringify({ capability: 'vibrate', text: '600' }),
    })
    assert.equal(
      call.status,
      403,
      '经回源发起的端侧控制必须被拒 —— 否则同局域网/中继上的人就能指挥别人的手机',
    )

    const status = await relay.ask('/mobile/device/status')
    assert.equal(status.status, 403, '端侧状态也不得经回源暴露（它列出了在线设备与结果）')

    assert.deepEqual(fetched, [], '被拒的路径绝不能被环回 fetch 打到真实路由上（否则拒绝发生在事实之后）')

    // 正向对照：手机正常用到的路径必须仍被转发，否则"堵漏"会变成"把手机弄断线"
    const shell = await relay.ask('/mobile/app')
    assert.equal(shell.status, 200, '页面路径必须仍能经回源取到')
    assert.equal(shell.body, 'shell')
    assert.equal(fetched.length, 1, '手机路径应当被转发一次')
    assert.match(fetched[0] ?? '', /^http:\/\/127\.0\.0\.1:4599\/mobile\/app$/)
  } finally {
    globalThis.fetch = originalFetch
    env.cleanup()
    await relay.close()
  }
})

// ────────────────────────── T6：WS 升级的准入 ──────────────────────────

/** `acceptWebSocket` / `MinimalWebSocket` 真正用到的那部分 Duplex。 */
class FakeSocket {
  readonly written: Buffer[] = []
  destroyed = false
  private readonly handlers = new Map<string, ((...args: unknown[]) => void)[]>()

  write(chunk: Buffer | string): boolean {
    this.written.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk))
    return true
  }

  end(): void {}

  destroy(): void {
    this.destroyed = true
  }

  on(event: string, handler: (...args: unknown[]) => void): this {
    const list = this.handlers.get(event) ?? []
    list.push(handler)
    this.handlers.set(event, list)
    return this
  }
}

function upgradeRequest(headers: Record<string, string>): Parameters<MobileHost['handleUpgrade']>[0] {
  return {
    method: 'GET',
    url: '/mobile/ws',
    headers: {
      upgrade: 'websocket',
      connection: 'Upgrade',
      'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
      'sec-websocket-version': '13',
      ...headers,
    },
    socket: { remoteAddress: '10.34.255.229' },
  } as unknown as Parameters<MobileHost['handleUpgrade']>[0]
}

function writtenText(socket: FakeSocket): string {
  return socket.written.map((chunk) => chunk.toString('utf8')).join('')
}

test('T6 WS 升级：伪造 Origin 被拒（403、不建会话），合法/无 Origin 照旧放行', () => {
  const env = makeHost({ trustedHosts: ['10.34.255.229:3443'], phoneBaseUrl: 'https://10.34.255.229:3443' })
  try {
    const upgrade = (headers: Record<string, string>): FakeSocket => {
      const socket = new FakeSocket()
      env.host.handleUpgrade(upgradeRequest(headers), socket as unknown as Duplex)
      return socket
    }

    // ① DNS rebinding 形态：Host 与 Origin 都是攻击者的域名 ⇒ 必须拒绝
    const forged = upgrade({ host: 'evil.example.com', origin: 'http://evil.example.com' })
    assert.equal(forged.destroyed, true, '伪造 Origin 的升级必须被拒（destroy socket）')
    assert.match(writtenText(forged), /^HTTP\/1\.1 403/, '必须回 403，而不是 101')
    assert.equal(env.host.connectedCount(), 0, '被拒的升级不得建立任何隧道会话')

    // ② 真机形态：Android WebView 从页面同源发起，Host 与 Origin 都是受信 authority
    const legit = upgrade({ host: '10.34.255.229:3443', origin: 'https://10.34.255.229:3443' })
    assert.equal(legit.destroyed, false, '合法 Origin 不得被拒')
    assert.match(writtenText(legit), /^HTTP\/1\.1 101/, '合法 Origin 必须完成 101 升级')

    // ③ 原生壳 / 非浏览器客户端：不带 Origin ⇒ 按既有策略放行（一刀切会挡死真机）
    const native = upgrade({ host: '10.34.255.229:3443' })
    assert.equal(native.destroyed, false, '无 Origin 的原生客户端不得被拒')
    assert.match(writtenText(native), /^HTTP\/1\.1 101/, '无 Origin 的升级必须照旧放行')

    // ④ Host 受信但 Origin 是别处的恶意站点 ⇒ 仍然拒绝
    const cross = upgrade({ host: '10.34.255.229:3443', origin: 'https://evil.example.com' })
    assert.equal(cross.destroyed, true, 'Host 受信不等于可以接受任意 Origin')

    // ⑤ Origin 与 Host 同主机但不同端口 = 跨源 ⇒ 拒绝
    const wrongPort = upgrade({ host: '10.34.255.229:3443', origin: 'https://10.34.255.229:9999' })
    assert.equal(wrongPort.destroyed, true, '同主机不同端口属于跨源，必须拒绝')

    // ⑥ Host 缺失或畸形 ⇒ 拒绝（与 handleHttp 的判据一致）
    const badHost = upgrade({ host: 'not a host', origin: 'http://not a host' })
    assert.equal(badHost.destroyed, true, 'Host 畸形时必须拒绝')
  } finally {
    env.cleanup()
  }
})

test('T6 WS 升级：Origin 是部署方声明的 phoneBaseUrl 时放行（反代/中继场景）', () => {
  const env = makeHost({ trustedHosts: [], phoneBaseUrl: 'https://10.34.255.229:3443' })
  try {
    const socket = new FakeSocket()
    // 反代场景：Host 被改写成回环，Origin 仍是手机声明的 authority
    env.host.handleUpgrade(
      upgradeRequest({ host: '127.0.0.1:3080', origin: 'https://10.34.255.229:3443' }),
      socket as unknown as Duplex,
    )
    assert.equal(socket.destroyed, false, 'phoneBaseUrl 声明的 authority 必须被接受（否则真机连不上）')
    assert.match(writtenText(socket), /^HTTP\/1\.1 101/, '应当完成升级')
  } finally {
    env.cleanup()
  }
})

/**
 * 回归：**页面经中继下发时不能被误伤**（T6 首轮实现真踩到了，靠 `check-relay-e2e` 抓住）。
 *
 * 手机远程时应用外壳由中继回源提供 ⇒ 页面 Origin 是**中继**；而 boot.js 的候选端点回退
 * 会让它带着这个 Origin 去连局域网端点（`check-relay-e2e` 的"配对走局域网"阶段）。
 * 首轮栅栏只认 trustedHosts ∪ phoneBaseUrl，于是把这条**正常路径**拒了 ——
 * 真机表现是"所有候选端点都连不上"。修法是把部署方配置的中继 authority 也算进受信集合。
 */
test('T6 WS 升级：中继下发的页面回退连局域网端点必须放行，但任意 Origin 仍被拒', async () => {
  const relay = await startFakeRelay()
  const env = makeHost({
    trustedHosts: ['10.34.255.229:3651', '10.34.255.229:3652'],
    relay: { attachUrl: relay.attachUrl, attachHttpUrl: relay.attachHttpUrl, token: 't6-relay-origin' },
  })
  try {
    // `ws://127.0.0.1:<port>/attach-http` → 页面实际是 `http://127.0.0.1:<port>/...`
    const relayOrigin = relay.attachHttpUrl.replace(/^ws/, 'http')

    const fromRelay = new FakeSocket()
    env.host.handleUpgrade(
      upgradeRequest({ host: '10.34.255.229:3651', origin: relayOrigin }),
      fromRelay as unknown as Duplex,
    )
    assert.equal(fromRelay.destroyed, false, '中继下发的页面回退连局域网端点不得被拒（误伤真机）')
    assert.match(writtenText(fromRelay), /^HTTP\/1\.1 101/, '应当完成升级')

    // 受信集合扩容**不能**变成"任意 Origin 都放行"
    const evil = new FakeSocket()
    env.host.handleUpgrade(
      upgradeRequest({ host: '10.34.255.229:3651', origin: 'https://evil.example.com' }),
      evil as unknown as Duplex,
    )
    assert.equal(evil.destroyed, true, '不在受信集合里的 Origin 必须继续被拒')

    // Host 不受信时，哪怕 Origin 受信也必须拒（DNS rebinding 靠 Host 栅栏挡住）
    const badHost = new FakeSocket()
    env.host.handleUpgrade(
      upgradeRequest({ host: 'evil.example.com', origin: relayOrigin }),
      badHost as unknown as Duplex,
    )
    assert.equal(badHost.destroyed, true, 'Host 不受信时即便 Origin 受信也必须拒绝')
  } finally {
    env.cleanup()
    await relay.close()
  }
})
