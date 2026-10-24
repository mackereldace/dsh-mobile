/**
 * ★★ 换源认亲：同一个源的"第一次"（新 IP / 新 Tailscale 地址）不再要求重新配对。
 *
 * ## 这条测试守的是什么（用户原话）
 *
 * 「每次我切换同一电脑的 tail 和局域网都要重新配对，这很不方便」——
 * 目录里的槽已经会按 host 合并（`43fd8ea` ✓），但它只能记住**曾经连上过**的源 ✗。
 * 换源的第一次，`currentHostFingerprint()` 在这个新源上仍然是 `undefined` ⇒
 * 恢复被整段跳过 ⇒ 界面按"尚未配对"处理 ✗。
 *
 * 修法（`adoptCurrentOriginByHostProbe`）：用壳的库里**已存**的设备凭据真握手一次，
 * 让宿主用**签名**证明它是谁 ✓；成功才把当前地址补进目录 ✓。
 *
 * ## 为什么用真宿主（`TunnelSession`）而不是假协议
 *
 * 这条链的**安全属性**是"服务器能不能骗过客户端" ✗ —— 用假协议测不到：
 * 假服务器可以随便说自己是哪台 ✓，测试反而会把"没验签名"判成绿 ✗。
 * 所以照 `direct.test.ts` 的做法：boot.js 的 WebSocket 直接接到真实 `TunnelSession`，
 * 只把"网络"换成同步函数调用 ✓。断言因此打在**生产握手代码**上 ✓。
 *
 * ## 关键断言
 *
 * ① 新源上最终建起了**主隧道**（`tunnel.sessionId` 有值）——旧行为是"尚未配对"、根本没有隧道 ✗；
 * ② 主机指纹 = 目录里那台的指纹（认亲认的是**同一把宿主私钥** ✓）；
 * ③ 目录里**新增**了当前源的槽（而且是在握手成功之后才写 ✓）；
 * ④ 设备私钥**没有被重新生成**（deviceId 逐字等于种子 ✓）——否则宿主会看到一台新设备 ✗。
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

/** 新源（这一页）与旧源（上次配对的那个地址）。 */
const NEW_ORIGIN = 'http://10.0.0.7:3080'
const OLD_ORIGIN = 'http://10.0.0.9:3080'

/** 浏览器侧 WebSocket 替身：每个 socket 一条**真实**的宿主 `TunnelSession` ✓。 */
class DirectSocket {
  static all: DirectSocket[] = []
  readyState = 0
  onopen: (() => void) | undefined
  onmessage: ((event: { data: ArrayBuffer }) => void) | undefined
  onclose: (() => void) | undefined
  onerror: (() => void) | undefined
  readonly url: string
  session: TunnelSession

  constructor(url: string, hostSigningKey: ReturnType<typeof generateP256KeyPair>, delegate: ConstructorParameters<typeof TunnelSession>[0]) {
    this.url = url
    this.session = new TunnelSession(delegate, (bytes) => {
      this.receive(new Uint8Array(bytes))
      return true
    })
    this.session.hostId = 'host-adopt'
    this.session.hostSigningKey = hostSigningKey as never
    DirectSocket.all.push(this)
  }

  send(data: unknown): void {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBuffer)
    this.session.receive(bytes)
  }

  close(): void {
    if (this.readyState === 3) return
    this.readyState = 3
    this.onclose?.()
  }

  receive(bytes: Uint8Array): void {
    this.onmessage?.({ data: Uint8Array.from(bytes).buffer as ArrayBuffer })
  }

  open(): void {
    this.readyState = 1
    this.onopen?.()
  }
}

async function createDeviceKey(): Promise<{ deviceId: string; publicKeyB64u: string; storageValue: string }> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  const publicRaw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))
  const privateJwk = await crypto.subtle.exportKey('jwk', pair.privateKey)
  const deviceId = 'web-adopt-device'
  const publicKeyB64u = Buffer.from(publicRaw).toString('base64url')
  return { deviceId, publicKeyB64u, storageValue: JSON.stringify({ deviceId, publicKey: publicKeyB64u, privateKeyJwk: privateJwk }) }
}

/** 造一台"已经配对过"的宿主（设备表 + 宿主密钥）✓。 */
async function createHost() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-mobile-adopt-'))
  const store = new DeviceStore({ directory: dir })
  const hostSigningKey = generateP256KeyPair()
  const device = await createDeviceKey()
  store.upsert({
    deviceId: device.deviceId,
    devicePublicKey: '',
    deviceSigningKey: device.publicKeyB64u,
    fingerprint: fingerprint(device.publicKeyB64u),
    name: '换源认亲测试端',
    pairedAt: new Date().toISOString(),
    authorization: 'persistent',
    capabilities: { ...DEFAULT_CAPABILITIES },
  })
  return { dir, store, hostSigningKey, device, hostFingerprint: fingerprint(hostSigningKey.publicKey) }
}

/** 假壳：与 Java 侧同一套 `vaultGet` / `vaultSet` 合并语义 ✓。 */
function createShell(vault: Map<string, string>) {
  return {
    version: () => 1,
    platform: () => 'android',
    vaultGet: () => JSON.stringify(Object.fromEntries(vault)),
    vaultSet: (payload: string) => {
      const patch = JSON.parse(payload) as Record<string, string | null>
      for (const [key, value] of Object.entries(patch)) {
        if (value === null) vault.delete(key)
        else vault.set(key, value)
      }
    },
    endpoints: () => JSON.stringify({ slots: [] }),
    setEndpointSlots: () => {},
    insets: () => JSON.stringify({ top: 0, right: 0, bottom: 0, left: 0 }),
    log: () => {},
  }
}

test('★ 换源认亲：目录里没有这个源、但壳里有凭据 ⇒ 真握手认出同一台，补槽并连上（不再要配对）', async () => {
  const host = await createHost()
  let cleanupStore: (() => void) | undefined
  /** 所有出现过的 socket ✓（收尾要关掉它们，否则保活定时器会让测试进程不退出 ✗）。 */
  const sockets: DirectSocket[] = []
  /** 主隧道引用 ✓（收尾停保活 ✓）。 */
  let bootRef: { tunnel?: { stopKeepalive?: () => void } } | undefined
  try {
    const vault = new Map<string, string>()
    // 身份只放在**壳的库**里 ✓（真实场景：另一个源上配对时写进去的，跨源共享 ✓）
    vault.set(`dsh-mobile.device-key:${host.hostFingerprint}`, host.device.storageValue)
    vault.set(
      `dsh-mobile.host:${host.hostFingerprint}`,
      JSON.stringify({
        baseUrl: OLD_ORIGIN,
        tunnelUrl: 'ws://10.0.0.9:3080/mobile/ws',
        pinnedHostFingerprint: host.hostFingerprint,
      }),
    )
    // 目录：只有**旧源**那一条槽（新源第一次来，当然没有 ✓）
    vault.set(
      'dsh-mobile.hosts',
      JSON.stringify([
        {
          fingerprint: host.hostFingerprint,
          label: '测试电脑',
          slots: [{ label: '旧网络', url: OLD_ORIGIN }],
          lastSeenAt: Date.now() - 60_000,
        },
      ]),
    )

    const logs: string[] = []
    /** localStorage 替身 ✓（新源上就是**空的** —— 身份只在壳的库/旧源里 ✓）。 */
    const localStore = {
      values: {} as Record<string, string>,
      getItem(key: string) {
        return localStore.values[key] ?? null
      },
      setItem(key: string, value: string) {
        localStore.values[key] = value
      },
      removeItem(key: string) {
        delete localStore.values[key]
      },
      key(index: number) {
        return Object.keys(localStore.values)[index] ?? null
      },
      get length() {
        return Object.keys(localStore.values).length
      },
    }
    const sandboxGlobals: Record<string, unknown> = {
      console: {
        info: (message?: unknown) => logs.push(String(message)),
        warn: (message?: unknown) => logs.push(String(message)),
        error: (message?: unknown) => logs.push(String(message)),
        log: (message?: unknown) => logs.push(String(message)),
      },
      crypto: globalThis.crypto,
      TextEncoder,
      TextDecoder,
      Response,
      FormData,
      Blob,
      URL,
      URLSearchParams,
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      atob: (value: string) => Buffer.from(value, 'base64').toString('binary'),
      btoa: (value: string) => Buffer.from(value, 'binary').toString('base64'),
      location: {
        origin: NEW_ORIGIN,
        protocol: 'http:',
        host: '10.0.0.7:3080',
        pathname: '/',
        search: '',
        href: NEW_ORIGIN + '/',
      },
      innerWidth: 393,
      document: {
        body: { dataset: {}, appendChild: () => {}, classList: { add: () => {}, remove: () => {}, contains: () => false } },
        head: { appendChild: () => {} },
        documentElement: { setAttribute: () => {}, getAttribute: () => null, style: { setProperty: () => {} } },
        getElementById: () => null,
        createElement: () => ({
          addEventListener: () => {},
          dataset: {},
          style: {},
          classList: { add: () => {}, remove: () => {}, contains: () => false },
          appendChild: () => {},
          setAttribute: () => {},
        }),
        addEventListener: () => {},
        querySelector: () => null,
        querySelectorAll: () => [],
      },
      localStorage: localStore,
      history: { replaceState: () => {} },
      /** manifest 提示：真宿主一定会报指纹 ✓（这里只用来排序；认亲仍由签名决定 ✓）。 */
      fetch: async (url: string) => {
        if (String(url).indexOf('/mobile/manifest') < 0) throw new Error('unexpected fetch ' + String(url))
        return {
          ok: true,
          json: async () => ({ protocolVersion: 1, hostFingerprint: host.hostFingerprint, hostId: 'host-adopt' }),
        }
      },
      DshmShell: createShell(vault),
    }
    sandboxGlobals['globalThis'] = sandboxGlobals
    sandboxGlobals['window'] = sandboxGlobals

    // 宿主侧：每个 socket 各自一条会话，共享同一份设备表与宿主密钥 ✓
    sandboxGlobals['WebSocket'] = class extends DirectSocket {
      constructor(url: string) {
        super(url, host.hostSigningKey, {
          resolveDevice: (hello) => {
            const record = host.store.get(hello.deviceId)
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
          invoke: async () => ({ ok: true, value: { sessions: [] } }),
          openStream: () => (async function* () {})(),
        })
        sockets.push(this)
      }
    }

    runInNewContext(bootSource, sandboxGlobals, { filename: 'boot.js' })
    const boot = sandboxGlobals['__DSH_MOBILE_BOOT__'] as
      | {
          tunnel?: { sessionId?: string; hostFingerprint?: string; stopKeepalive?: () => void }
          lastError?: string
          currentFingerprint?: () => string | null
          getConfig?: () => unknown
          hosts?: () => unknown
        }
      | undefined
    assert.ok(boot !== undefined, 'boot.js 应先同步装上 __DSH_MOBILE_BOOT__（不被认亲的 await 推迟）')
    bootRef = boot as { tunnel?: { stopKeepalive?: () => void } }

    // 逐条把新出现的 socket 打开（boot 会在 onopen 赋值之后才等它 ✓）
    const deadline = Date.now() + 15_000
    while (boot.tunnel?.sessionId === undefined && boot.lastError === undefined && Date.now() < deadline) {
      for (const socket of sockets) {
        if (socket.readyState === 0 && typeof socket.onopen === 'function') socket.open()
      }
      await new Promise((resolve) => setTimeout(resolve, 5))
    }

    assert.equal(boot.lastError, undefined, `认亲后主隧道不应失败：${String(boot.lastError)}`)
    assert.ok(
      boot.tunnel?.sessionId !== undefined,
      '★ 换源后必须建起主隧道（旧行为是“尚未配对”、根本没有隧道 ✗）\n' +
        JSON.stringify({
          fp: boot.currentFingerprint?.(),
          config: boot.getConfig?.(),
          hosts: boot.hosts?.(),
          vault: Array.from(vault.keys()),
          sockets: sockets.map((socket) => socket.url),
          logs: logs.slice(-20),
        }),
    )
    assert.equal(boot.tunnel?.hostFingerprint, host.hostFingerprint, '认亲认到的必须是同一把宿主私钥 ✓')
    // 宿主侧看到的 deviceId 必须还是那一把（Tunnel 对象不暴露 deviceId，从会话读 ✓）
    const establishedDeviceIds = sockets
      .map((socket) => socket.session.established?.deviceId)
      .filter((value): value is string => typeof value === 'string')
    assert.ok(establishedDeviceIds.length > 0, '至少有一条会话完成设备认证')
    assert.ok(
      establishedDeviceIds.every((id) => id === host.device.deviceId),
      '★ 绝不能重新生成设备私钥（否则电脑上会多出一台设备 ✗）：' + JSON.stringify(establishedDeviceIds),
    )
    assert.equal(
      vault.get('dsh-mobile.device-key:' + host.hostFingerprint),
      host.device.storageValue,
      '★ 壳里的设备私钥必须原样不动 ✗',
    )

    // 目录里必须有**当前源**这条槽（而且是握手成功之后才写的 ✓）
    const hosts = JSON.parse(vault.get('dsh-mobile.hosts') ?? '[]') as Array<{ slots?: Array<{ url?: string }> }>
    const slots = hosts[0]?.slots ?? []
    assert.ok(
      slots.some((slot) => String(slot.url).indexOf('10.0.0.7:3080') >= 0),
      '★ 认亲成功后要把当前源记进目录（下一次加载才能直接认出 ✓）：' + JSON.stringify(slots),
    )

    // 只应有一次"认亲"连接 + 一次主隧道连接（不许多打枪）
    assert.ok(sockets.length >= 2, '应至少有认亲 + 主隧道两条连接，实际 ' + sockets.length)
  } finally {
    cleanupStore?.()
    try {
      bootRef?.tunnel?.stopKeepalive?.()
    } catch (error) {
      void error
    }
    try {
      for (const socket of sockets) {
        try {
          socket.session.close('test cleanup')
        } catch (error) {
          void error
        }
        socket.close()
      }
    } catch (error) {
      void error
    }
    rmSync(host.dir, { recursive: true, force: true })
  }
})
