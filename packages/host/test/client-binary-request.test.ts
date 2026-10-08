/**
 * 手机 → 宿主的反向二进制契约：完整 boot.js 在 VM 真跑，真实握手、加密帧和宿主分发。
 * 网络替身只传原始字节，不替换 rpc、sendFrame、onMessage 或宿主编解码。
 * 本组 7 条：编码回退应恰好红 5 条，宿主解码回退应恰好红 4 条。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'

import {
  BYTES_TAG, DEFAULT_CAPABILITIES, FrameType, ReplayWindow,
  decodeBinary, encodeBinary, fingerprint, generateP256KeyPair, openFrame, parseFrame,
} from '@dsh-mobile/protocol'
import { TunnelSession } from '../src/tunnel.ts'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const bootSource = readFileSync(join(repo, 'packages/client/src/boot.js'), 'utf8')
const EXPECTED_MIN_CHECKS = 7
assert.equal((bootSource.match(/var BYTES_TAG = '([^']+)'/) ?? [])[1], BYTES_TAG)

interface PhoneTunnel {
  sessionId?: string
  rpc(endpoint: string, payload: unknown, rpcId?: string): Promise<{
    type: string; rpcId: string; result: { ok: boolean; value: unknown }
  }>
  stopKeepalive(): void
  clearReconnectTimer(): void
}
interface World {
  tunnel: PhoneTunnel
  lastRequest(): { endpoint: string; payload: unknown }
  wireRequest(): { type: string; rpcId: string; method: string; payload: unknown }
}

async function waitFor<T>(probe: () => T | undefined): Promise<T> {
  const deadline = Date.now() + 3000
  for (;;) {
    const value = probe()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error('生产隧道握手超时')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

async function createWorld(t: TestContext): Promise<World> {
  const hostKey = generateP256KeyPair()
  const devicePair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  const publicKey = Buffer.from(await crypto.subtle.exportKey('raw', devicePair.publicKey)).toString('base64url')
  const privateKeyJwk = await crypto.subtle.exportKey('jwk', devicePair.privateKey)
  const deviceId = 'binary-request-device'
  const hostFingerprint = fingerprint(hostKey.publicKey)
  const store = new Map<string, string>([
    ['dsh-mobile.device-key', JSON.stringify({ deviceId, publicKey, privateKeyJwk })],
    ['dsh-mobile.host', JSON.stringify({
      baseUrl: 'https://binary.example', tunnelUrl: 'wss://binary.example/mobile/ws',
      pinnedHostFingerprint: hostFingerprint,
    })],
  ])
  const sockets: BinarySocket[] = []
  const timers = new Set<ReturnType<typeof setTimeout>>()
  const errors: unknown[][] = []
  let invoked: { endpoint: string; payload: unknown } | undefined
  let tunnel: PhoneTunnel | undefined

  class BinarySocket {
    readyState = 0
    binaryType = 'blob'
    onopen?: () => void
    onmessage?: (event: { data: ArrayBuffer }) => void
    onclose?: () => void
    onerror?: () => void
    readonly sent: Uint8Array[] = []
    readonly host: TunnelSession
    constructor(_url: string) {
      sockets.push(this)
      this.host = new TunnelSession({
        resolveDevice: () => ({
          deviceId, devicePublicKey: '', deviceSigningKey: publicKey,
          fingerprint: fingerprint(publicKey), capabilities: { ...DEFAULT_CAPABILITIES },
          authorization: 'persistent',
        }),
        invoke: async (request) => {
          invoked = request
          return { ok: true, value: request.payload }
        },
        openStream: () => (async function* () {})(),
      }, (bytes) => {
        const copy = Uint8Array.from(bytes)
        this.onmessage?.({ data: copy.buffer })
        return true
      })
      this.host.hostId = 'binary-request-host'
      this.host.hostSigningKey = hostKey
      timers.add(setTimeout(() => { this.readyState = 1; this.onopen?.() }, 0))
    }
    send(data: unknown): void {
      const bytes = new Uint8Array(data as ArrayBuffer)
      this.sent.push(bytes)
      this.host.receive(bytes)
    }
    close(): void { this.readyState = 3; this.onclose?.() }
  }

  t.after(() => {
    tunnel?.clearReconnectTimer()
    tunnel?.stopKeepalive()
    for (const socket of sockets) {
      socket.readyState = 3
      socket.host.close('test completed')
    }
    for (const timer of timers) clearTimeout(timer)
  })
  const sandbox: Record<string, unknown> = {
    console: { info() {}, warn() {}, log() {}, error: (...args: unknown[]) => errors.push(args) },
    crypto, TextEncoder, TextDecoder, Response, URL, URLSearchParams, Blob,
    setTimeout: (callback: () => void, delay: number) => {
      const timer = setTimeout(callback, delay)
      timers.add(timer)
      return timer
    },
    clearTimeout, setInterval: () => 0, clearInterval() {},
    atob: (value: string) => Buffer.from(value, 'base64').toString('binary'),
    btoa: (value: string) => Buffer.from(value, 'binary').toString('base64'),
    location: {
      origin: 'https://binary.example', protocol: 'https:', host: 'binary.example',
      pathname: '/', search: '', href: 'https://binary.example/',
    },
    document: {
      body: { dataset: {}, appendChild() {} }, head: { appendChild() {} },
      getElementById: () => null, createElement: () => ({ addEventListener() {}, dataset: {} }),
      addEventListener() {}, querySelector: () => null,
    },
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, String(value)) },
      removeItem: (key: string) => { store.delete(key) },
    },
    history: { replaceState() {} }, WebSocket: BinarySocket,
    innerWidth: 1440, innerHeight: 900, isSecureContext: true,
  }
  sandbox['globalThis'] = sandbox
  sandbox['window'] = sandbox
  runInNewContext(bootSource, sandbox, { filename: 'boot.js' })
  tunnel = (sandbox['__DSH_MOBILE_BOOT__'] as { tunnel?: PhoneTunnel })?.tunnel
  assert.ok(tunnel, '完整 boot.js 必须创建生产隧道')
  await waitFor(() => tunnel?.sessionId)
  assert.equal(errors.length, 0, `VM 启动及握手异常：${String(errors[0])}`)
  return {
    tunnel,
    lastRequest() {
      assert.ok(invoked, '请求必须真实到达宿主 delegate')
      return invoked
    },
    wireRequest() {
      const socket = sockets[0]
      assert.ok(socket)
      const bytes = socket.sent.findLast((frame) => frame[0] === FrameType.RpcRequest)
      assert.ok(bytes, '必须发出真正的 RpcRequest 加密帧')
      const established = socket.host.established
      assert.ok(established)
      const opened = openFrame({
        header: parseFrame(Buffer.from(bytes)), key: established.keys.clientToServer,
        nonceBase: established.clientNonceBase, replay: new ReplayWindow(),
      })
      assert.ok(opened.ok, '上行帧必须能用真实会话密钥解开')
      return JSON.parse(opened.plaintext.toString('utf8'))
    },
  }
}

/** 跨 VM realm 断言类型与全量字节；不拿 JSON 或摘要代替完整比较。 */
function sameBytes(actual: unknown, expected: Uint8Array | ArrayBuffer): void {
  assert.ok(ArrayBuffer.isView(actual), '必须还原为字节视图')
  assert.equal(Object.prototype.toString.call(actual), '[object Uint8Array]')
  const bytes = actual as Uint8Array
  const wanted = expected instanceof ArrayBuffer ? new Uint8Array(expected) : expected
  assert.deepEqual(Array.from(bytes), Array.from(wanted))
}

// 固定条数下界，避免新契约被意外遗漏。
const cases: Array<[string, (t: TestContext) => Promise<void>]> = [
  ['普通请求保留信封、DSH rpcId 和业务值，源对象不变', async (t) => {
    const world = await createWorld(t)
    const source = { text: '普通请求', n: 1.5, yes: true, no: false, nil: null, list: [1, 'x', null] }
    const response = await world.tunnel.rpc('mobile/dsh/upload', source, 'dsh-original-id')
    assert.equal(response.type, 'server-response')
    assert.equal(response.rpcId, 'dsh-original-id')
    assert.equal(response.result.ok, true)
    assert.deepEqual(world.lastRequest(), { endpoint: 'mobile/dsh/upload', payload: source })
    assert.deepEqual(world.wireRequest(), {
      type: 'client-request', rpcId: 'dsh-original-id', method: 'mobile/dsh/upload', payload: source,
    })
    assert.equal(source.list[2], null)
  }],
  ['浏览器实际加密帧编码与 protocol.encodeBinary 逐字段一致', async (t) => {
    const world = await createWorld(t)
    const source = { images: [{ data: new Uint8Array([0, 1, 127, 128, 255]) }], deep: { bytes: new Uint8Array([9]).buffer } }
    await world.tunnel.rpc('binary/echo', source, 'wire-contract')
    const encoded = world.wireRequest().payload
    assert.deepEqual(encoded, encodeBinary(source))
    assert.deepEqual(decodeBinary(encoded), sourceToBytes(source))
    assert.ok(source.images[0]?.data instanceof Uint8Array)
  }],
  ['图片数组完整往返，宿主与手机收到的每张图片都是原始 Uint8Array', async (t) => {
    const world = await createWorld(t)
    const source = { images: [
      { name: '图片.png', data: new Uint8Array([137, 80, 78, 71, 0, 255]) },
      { name: 'photo.jpg', data: new Uint8Array([255, 216, 255, 224, 0, 127, 255, 217]) },
    ] }
    const response = await world.tunnel.rpc('mobile/dsh/upload', source)
    const host = world.lastRequest().payload as typeof source
    const phone = response.result.value as typeof source
    for (let i = 0; i < source.images.length; i++) {
      sameBytes(host.images[i]?.data, source.images[i]!.data)
      sameBytes(phone.images[i]?.data, source.images[i]!.data)
      assert.equal(phone.images[i]?.name, source.images[i]?.name)
    }
  }],
  ['嵌套对象、非零偏移视图、ArrayBuffer 和 Buffer 完整往返，不编码底层额外字节', async (t) => {
    const world = await createWorld(t)
    const backing = new Uint8Array([91, 92, 0, 255, 128, 93])
    const view = backing.subarray(2, 5)
    const source = { nest: { items: [{ view }, { raw: new Uint8Array([8, 7, 0, 6]).buffer }, { buffer: Buffer.from([5, 0, 255]) }] } }
    const response = await world.tunnel.rpc('binary/echo', source)
    for (const payload of [world.lastRequest().payload, response.result.value] as Array<typeof source>) {
      sameBytes(payload.nest.items[0]?.view, view)
      sameBytes(payload.nest.items[1]?.raw, source.nest.items[1]!.raw!)
      sameBytes(payload.nest.items[2]?.buffer, source.nest.items[2]!.buffer!)
    }
    assert.deepEqual(Array.from(backing), [91, 92, 0, 255, 128, 93])
    assert.equal(source.nest.items[0]?.view, view)
    assert.ok(source.nest.items[1]?.raw instanceof ArrayBuffer)
  }],
  ['空字节数组与空 ArrayBuffer 保留 Uint8Array 类型，普通空数组保持数组', async (t) => {
    const world = await createWorld(t)
    const source = { bytes: new Uint8Array(0), raw: new ArrayBuffer(0), list: [] }
    const response = await world.tunnel.rpc('binary/echo', source)
    for (const payload of [world.lastRequest().payload, response.result.value] as Array<typeof source>) {
      sameBytes(payload.bytes, source.bytes)
      sameBytes(payload.raw, source.raw)
      assert.ok(Array.isArray(payload.list))
      assert.equal(payload.list.length, 0)
    }
  }],
  ['320 KiB 图片逐字节往返，无截断、无 base64 参数栈溢出', async (t) => {
    const world = await createWorld(t)
    const data = Uint8Array.from({ length: 320 * 1024 }, (_, i) => (i * 71 + 13) % 256)
    const response = await world.tunnel.rpc('mobile/dsh/upload', { data })
    sameBytes((world.lastRequest().payload as { data: Uint8Array }).data, data)
    sameBytes((response.result.value as { data: Uint8Array }).data, data)
    assert.equal(data.length, 320 * 1024)
  }],
  ['同名标签带额外字段保持普通业务对象，非字节业务值不变', async (t) => {
    const world = await createWorld(t)
    const source = { looksLike: { [BYTES_TAG]: 'AAEC', extra: 1 }, list: [false, null, '数据', 3.25] }
    const response = await world.tunnel.rpc('binary/echo', source)
    assert.deepEqual(world.lastRequest().payload, source)
    assert.equal(JSON.stringify(response.result.value), JSON.stringify(source))
    assert.deepEqual(world.wireRequest().payload, source)
  }],
]

function sourceToBytes(source: unknown): unknown {
  return decodeBinary(encodeBinary(source))
}

assert.equal(cases.length, EXPECTED_MIN_CHECKS)
for (const [name, run] of cases) test('反向二进制：' + name, run)
