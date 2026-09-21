/**
 * 对**真实运行中的 DSH** 做端到端验收。
 *
 * 这是显式运行的脚本（不在 `node --test` 套件里），因为它要启动一个真实的
 * `dsh web` 子进程并与之做完整握手。
 *
 * 为什么单独成脚本而不是测试用例：把"启动子进程 + 真实 WebSocket + 框架的事件循环"
 * 三者混在一起时，曾出现握手在测试框架内失败、而同样的客户端逻辑在独立脚本里稳定通过的情况。
 * 与其让套件里留一个不稳定的红点，不如把这条验收做成可复现、可读日志的显式步骤。
 *
 * 运行：node --experimental-strip-types scripts/live-verify.ts
 * 前置：node scripts/install-host-plugin.mjs（插件需已安装进 DSH profile）
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { explainMissingDsh, resolveDsh } from './resolve-dsh.mjs'

import {
  ClientHandshake,
  ErrorCode,
  FrameFlags,
  FrameType,
  ReplayWindow,
  fingerprint,
  generateP256KeyPair,
  generateX25519KeyPair,
  openFrame,
  openServerHello,
  parseFrame,
  sealFrame,
  sealPlaintextFrame,
  type ClientAuthPayload,
  type ServerHelloPayload,
} from '../packages/protocol/src/index.ts'

const PORT = 3300 + Math.floor(Math.random() * 2000)
const BASE = `http://127.0.0.1:${PORT}`

function log(message: string): void {
  console.log(`[live-verify] ${message}`)
}

function fail(message: string): never {
  console.error(`[live-verify] 失败：${message}`)
  process.exit(1)
}

/** 启动一个真实的 dsh web 子进程并等待它就绪。 */
async function startDsh(): Promise<{ child: ChildProcess; token: string; dir: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-mobile-live-'))
  // dsh 是全局安装；解析逻辑与 start-lan.sh 共用同一个模块（resolve-dsh.mjs），
  // 避免两处各自演化——历史上只修了 shell 脚本，验证脚本就在同样环境下挂掉过。
  const dshBin = resolveDsh()
  if (dshBin === undefined) fail(explainMissingDsh('live-verify'))

  const child = spawn(dshBin, ['web', '--port', String(PORT), '--no-open'], {
    cwd: dir,
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout?.on('data', (chunk: Buffer) => {
    output += chunk.toString('utf8')
  })
  child.stderr?.on('data', (chunk: Buffer) => {
    output += chunk.toString('utf8')
  })

  const deadline = Date.now() + 90_000
  let token: string | undefined
  while (token === undefined && Date.now() < deadline) {
    const match = /token=([A-Za-z0-9_-]+)/.exec(output)
    if (match !== null) token = match[1]
    else if (child.exitCode !== null) fail(`dsh web 提前退出（code=${child.exitCode}）：\n${output.slice(-2000)}`)
    else await new Promise((resolve) => setTimeout(resolve, 200))
  }
  if (token === undefined) fail(`等待 dsh web 启动超时：\n${output.slice(-2000)}`)
  return { child, token, dir }
}

async function post(path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
  const response = await fetch(`${BASE}${path}`, {
    method: 'POST',
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  })
  const text = await response.text()
  let json: unknown = text
  try {
    json = JSON.parse(text) as unknown
  } catch {
    /* 保留原始文本 */
  }
  return { status: response.status, json }
}

const dsh = await startDsh()
log(`dsh web 已启动（端口 ${PORT}）`)

try {
  // ── 1. 插件已加载：manifest 可用 ────────────────────────────────────
  const manifestResponse = await fetch(`${BASE}/mobile/manifest`)
  if (manifestResponse.status !== 200) {
    // 404 几乎总是"插件没装进这个 profile"，而不是插件本身坏了。
    // 直接给出可执行的下一步，避免被误读成协议失败。
    const dshHome = process.env['DSH_HOME'] ?? '(默认 ~/.dsh)'
    fail(
      `/mobile/manifest 应返回 200，实际 ${manifestResponse.status}\n` +
        `  DSH_HOME=${dshHome}\n` +
        '  若为 404：说明该 profile 未安装宿主插件。请先运行\n' +
        '    node scripts/install-host-plugin.mjs --dsh-home <同上> --trusted-host <局域网authority>\n' +
        '  注意：验证请用**专用** DSH_HOME，不要指向正在使用的 profile——\n' +
        '  本脚本会创建配对、授权并撤销设备，会写进该 profile 的设备库与审计。',
    )
  }
  const manifest = (await manifestResponse.json()) as { protocolVersion: number; hostFingerprint: string }
  if (manifest.protocolVersion !== 1) fail(`协议版本应为 1，实际 ${manifest.protocolVersion}`)
  log(`插件已加载，主机指纹 ${manifest.hostFingerprint.slice(0, 16)}…`)

  // ── 2. boot.js 可服务且已注入 index.html，且先于模块加载器 ────────────
  const bootResponse = await fetch(`${BASE}/mobile/boot.js`)
  if (bootResponse.status !== 200) fail(`/mobile/boot.js 应返回 200，实际 ${bootResponse.status}`)
  const bootSource = await bootResponse.text()
  if (!bootSource.includes('__DSH_TRANSPORT__')) fail('boot.js 应安装传输层')

  const indexWithCookie = await fetch(`${BASE}/?token=${dsh.token}`, { redirect: 'manual' })
  const cookie = indexWithCookie.headers.get('set-cookie') ?? ''
  if (!cookie.includes('dsh-auth-')) fail('根路径应换取浏览器 cookie')
  const index = await fetch(`${BASE}/`, { headers: { cookie: cookie.split(';')[0]! } })
  const html = await index.text()
  const bootIndex = html.indexOf('/mobile/boot.js')
  const loaderIndex = html.indexOf('__ModuleLoader__')
  if (bootIndex < 0) fail('boot.js 未被注入 index.html')
  if (loaderIndex >= 0 && bootIndex > loaderIndex) fail('boot.js 必须出现在模块加载器之前')
  log('boot.js 已被服务并先于模块加载器注入 index.html')

  // ── 3. 配对 ────────────────────────────────────────────────────────
  const pairing = (await post('/mobile/pair/code')).json as { ticket: { code: string; ticket: string } }
  const deviceKey = generateX25519KeyPair()
  const deviceSigningKey = generateP256KeyPair()
  const deviceId = 'live-verify-device'
  const claim = (await post('/mobile/pair/claim', {
    ticket: pairing.ticket.ticket,
    deviceId,
    deviceSigningKey: deviceSigningKey.publicKey,
    fingerprint: fingerprint(deviceSigningKey.publicKey),
    name: 'live-verify',
  })).json as { state: string }
  if (claim.state !== 'pending') fail(`claim 后应等待电脑端确认，实际 ${claim.state}`)
  const confirm = await post('/mobile/pair/confirm', { code: pairing.ticket.code, deviceId, approve: true })
  if (confirm.status !== 200) fail(`电脑端确认应成功，实际 ${confirm.status}`)
  log(`配对完成（配对码 ${pairing.ticket.code}）`)

  // ── 4. 隧道握手 ────────────────────────────────────────────────────
  const socket = new WebSocket(`ws://127.0.0.1:${PORT}/mobile/ws`)
  socket.binaryType = 'arraybuffer'
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve())
    socket.addEventListener('error', () => reject(new Error('WebSocket 连接失败')))
    setTimeout(() => reject(new Error('WebSocket 连接超时')), 10_000)
  })

  const handshake = new ClientHandshake({ deviceId, deviceKey, deviceSigningKey, pairingTicket: pairing.ticket.ticket })
  let session: { s2c: Buffer; c2s: Buffer; serverNonceBase: Buffer; clientNonceBase: Buffer; sessionId: string } | undefined
  let outCounter = 1n
  const pending = new Map<string, (value: { ok: boolean; value?: unknown; error?: { code: string; message: string } }) => void>()
  // 接收方向的重放窗口必须**跨帧持久**：每帧新建窗口会让最高计数复位，
  // 于是第二帧（counter=2）会被判为"超出窗口"而拒绝——握手永远完不成。
  const inReplay = new ReplayWindow(2048)
  const established = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('握手超时')), 20_000)
    socket.addEventListener('message', (event) => {
      void (async () => {
        const bytes = new Uint8Array(event.data as ArrayBuffer)
        if (bytes[0] === 0x7b /* '{' */) {
          const opened = openServerHello({
            sealed: JSON.parse(Buffer.from(bytes).toString('utf8')) as { e: string; sh: string },
            ephemeralPrivateKey: handshake.ephemeralKeys.privateKey,
          })
          if (!opened.ok) {
            clearTimeout(timer)
            reject(new Error(`无法解开 ServerHello：${opened.message}`))
            return
          }
          const serverHello = opened.payload as ServerHelloPayload
          const outcome = handshake.acceptServerHello(serverHello)
          if (outcome.kind !== 'send') {
            clearTimeout(timer)
            reject(new Error(`acceptServerHello 失败：${JSON.stringify(outcome)}`))
            return
          }
          const auth = outcome.payload as ClientAuthPayload
          const keys = handshake.sessionKeys
          if (keys === undefined) {
            clearTimeout(timer)
            reject(new Error('会话密钥缺失'))
            return
          }
          session = {
            s2c: keys.serverToClient,
            c2s: keys.clientToServer,
            serverNonceBase: Buffer.from(serverHello.serverNonceBase, 'base64url'),
            clientNonceBase: Buffer.from(auth.clientNonceBase, 'base64url'),
            sessionId: '',
          }
          socket.send(
            sealFrame({
              key: opened.handshakeKey,
              nonceBase: Buffer.from([0, 0, 0, 1]),
              type: FrameType.ClientAuth,
              flags: FrameFlags.Json,
              counter: 2n,
              payload: Buffer.from(JSON.stringify(auth), 'utf8'),
              truncateTag: false,
            }).bytes,
          )
          return
        }
        if (session === undefined) {
          console.log(`[live-verify] 会话未建立就收到帧 0x${(bytes[0] ?? 0).toString(16)} 长度 ${bytes.length}`)
          return
        }
        const header = parseFrame(bytes)
        const opened = openFrame({ header, key: session.s2c, nonceBase: session.serverNonceBase, replay: inReplay })
        if (!opened.ok) {
          console.log(`[live-verify] 帧解密失败 type=0x${header.type.toString(16)} counter=${header.counter} code=${opened.code}`)
          if (header.type === FrameType.ServerAuthOk) {
            clearTimeout(timer)
            reject(new Error(`无法解开 ServerAuthOk：${opened.message}`))
          }
          return
        }
        const payload = JSON.parse(opened.plaintext.toString('utf8')) as Record<string, unknown>
        if (header.type === FrameType.ServerAuthOk) {
          const result = handshake.acceptServerAuthOk(payload as never)
          if (result.kind !== 'done') {
            clearTimeout(timer)
            reject(new Error(`ServerAuthOk 处理失败：${JSON.stringify(result)}`))
            return
          }
          session = { ...session, sessionId: String(payload['sessionId']) }
          clearTimeout(timer)
          resolve()
          return
        }
        if (header.type === FrameType.RpcResponse) {
          const waiter = pending.get(String(payload['rpcId']))
          pending.delete(String(payload['rpcId']))
          waiter?.(payload as never)
        }
      })()
    })
  })

  socket.send(
    sealPlaintextFrame(FrameType.ClientHello, FrameFlags.Json, Buffer.from(JSON.stringify(handshake.start().payload), 'utf8')),
  )
  await established
  log(`隧道握手成功，会话标识 ${session!.sessionId}`)

  /** 经隧道调用一次真实业务 API。 */
  async function call(endpoint: string, args: Record<string, unknown>): Promise<{ ok: boolean; value?: unknown; error?: { code: string; message: string } }> {
    const rpcId = `live-${Math.random().toString(36).slice(2)}`
    const message = { type: 'client-request', rpcId, method: endpoint, payload: { args } }
    const answer = new Promise<{ ok: boolean; value?: unknown; error?: { code: string; message: string } }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`RPC ${endpoint} 超时`)), 20_000)
      pending.set(rpcId, (value) => {
        clearTimeout(timer)
        resolve(value)
      })
    })
    socket.send(
      sealFrame({
        key: session!.c2s,
        nonceBase: session!.clientNonceBase,
        type: FrameType.RpcRequest,
        flags: FrameFlags.Json,
        counter: outCounter++,
        payload: Buffer.from(JSON.stringify(message), 'utf8'),
        truncateTag: true,
      }).bytes,
    )
    return answer
  }

  // ── 5. 真实业务 API ────────────────────────────────────────────────
  // 注意参数形状：Typert Remote 的单参方法把整个参数包在名为 request 的字段里
  // （descriptor 严格校验，字段名不符会返回 gateway/arguments-invalid）。
  const created = await call('session/create', { request: { cwd: '/tmp' } })
  if (!created.ok) fail(`session/create 应成功：${JSON.stringify(created)}`)
  const sessionValue = created.value as { sessionId?: string }
  if (typeof sessionValue.sessionId !== 'string' || sessionValue.sessionId.length === 0) {
    fail(`应返回真实的 DSH 会话标识，实际 ${JSON.stringify(created.value)}`)
  }
  log(`真实业务调用成功：session/create → ${sessionValue.sessionId}`)

  // 再调用另一个 namespace 的真实端点，确认隧道能承载跨 namespace 的调用。
  // 参数名由 descriptor 决定，且**可选参数带前导下划线**（`_request` 而非 `request`）——
  // 名字不符会得到 gateway/arguments-invalid 并明确指出缺哪个、多哪个。
  const sessions = await call('session/list', { _request: {} })
  if (!sessions.ok) fail(`session/list 应成功：${JSON.stringify(sessions)}`)
  const items = (sessions.value as { items?: unknown[] }).items
  if (!Array.isArray(items)) fail(`session/list 应返回 items 数组，实际 ${JSON.stringify(sessions.value)}`)
  log(`真实业务调用成功：session/list（返回 ${items.length} 条会话）`)

  const denied = await call('workspaceFiles/write', {
    request: { sessionId: sessionValue.sessionId, path: 'x.txt', content: 'x' },
  })
  if (denied.ok) fail('未授予 fsWrite 时写操作必须被拒绝')
  if (denied.error?.code !== ErrorCode.CapabilityDenied) fail(`应返回能力位拒绝，实际 ${JSON.stringify(denied.error)}`)
  log('能力位门禁生效：未授予 fsWrite 的写操作被拒绝')

  // ── 6. 撤销设备：隧道立即断开 ──────────────────────────────────────
  const devicesBefore = (await (await fetch(`${BASE}/mobile/devices`)).json()) as { connected: number }
  if (devicesBefore.connected !== 1) fail(`应有 1 台设备在线，实际 ${devicesBefore.connected}`)

  const revoked = await post('/mobile/devices/revoke', { deviceId })
  if (revoked.status !== 200) fail(`撤销应成功，实际 ${revoked.status}`)

  const deadline = Date.now() + 8000
  while (socket.readyState !== 3 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100))
  if (socket.readyState !== 3) fail('撤销后隧道应立即断开')
  log('撤销设备后隧道已立即断开')

  log('')
  log('全部验收项通过 ✓')
  socket.close()
} finally {
  dsh.child.kill('SIGTERM')
  rmSync(dsh.dir, { recursive: true, force: true })
}
