/**
 * 管理员路由与信任栅栏的**来源判据**（第一阶段 A + B2 + B3）。
 *
 * ## 为什么单开一个文件
 *
 * 这里测的三件事全是"没有症状"的那一类：
 *   · 信任栅栏收紧了 → 手机被 403（有症状，但会被误当成"产品坏了"）；
 *   · 信任栅栏放宽了 → 没有任何症状（安全问题）；
 *   · 清设备路由的**授权判据写错**（比如把 `Host: localhost` 当成"人在电脑前"）
 *     → 同样没有任何症状，但局域网里任何人都能清空设备表。
 * 所以逐条钉死，并且**故意**包含"伪造回环 Host + 非回环 socket"这个组合。
 *
 * ★ 同时把一条**已知代价**钉成断言（`…来自受信 authority` 那条）：
 *   自推导把本机非内部 IPv4 算作受信之后，局域网里用真实 IP 也能调管理路由。
 *   这是方案原文要求的"只允许 loopback 或已受信 authority（复用 A 的判据）"的直接结果；
 *   它不是权限提升（删记录不新增设备、不授予能力），但确实是一次局域网 DoS。
 *   把它写成断言，是为了将来有人收紧时**必须显式改这里**，而不是悄悄改掉。
 */

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { DEFAULT_CAPABILITIES, fingerprint, generateP256KeyPair } from '@dsh-mobile/protocol'

import { DeviceStore } from '../src/devices.ts'
import { createMobileHost, type MobileHost, type MobileSelfcheck } from '../src/index.ts'
import { createTlsManager, type TlsManager } from '../src/tls-cert.ts'

// ─────────────────────────────── 测试脚手架 ───────────────────────────────

/** 造一份"像 DSH 前端"的最小产物树（供探针扫描；不依赖本机真的装了 DSH）。 */
function makeFrontendFixture(root: string): string {
  const dist = join(root, 'dsh-web-frontend', 'dist')
  mkdirSync(join(dist, 'assets'), { recursive: true })
  writeFileSync(join(dist, 'index.html'), '<title>x — DeepSeek Harness</title>')
  writeFileSync(
    join(dist, 'assets', 'app.js'),
    [
      'centerCol',
      'sidebarCol',
      'rightbarCol',
      'collapsedContent',
      '打开侧边栏',
      '打开侧栏',
      'titleRow',
      'sessionRow',
      'projectRow',
      'composer',
      '轨迹时间线',
      '轨迹工具栏',
      '时间线概览',
      'settings.action',
    ].join(' '),
  )
  // 探针只在"兄弟目录看起来像 DSH 包目录"时才扫 client bundle，这里放 5 个占位满足形状
  for (const name of ['dsh-client-ui-layout', 'dsh-client-ui-chat', 'dsh-client-ui-sidebar', 'dsh-client-ui-workspace', 'dsh-web-app']) {
    mkdirSync(join(root, name, 'lib'), { recursive: true })
  }
  return join(dist, 'index.html')
}

function deviceRecord(deviceId: string, authorization: 'persistent' | 'revoked' = 'persistent') {
  const keyPair = generateP256KeyPair()
  return {
    deviceId,
    devicePublicKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    deviceSigningKey: keyPair.publicKey,
    fingerprint: fingerprint(keyPair.publicKey),
    name: `测试设备 ${deviceId}`,
    pairedAt: new Date().toISOString(),
    authorization,
    capabilities: { ...DEFAULT_CAPABILITIES },
  } as const
}

interface Env {
  readonly host: MobileHost
  readonly store: DeviceStore
  readonly tls: TlsManager
  readonly dir: string
  readonly root: string
  /** 可变的"网卡表"——用来演"换网后立刻生效"。 */
  setAddresses(addresses: readonly string[]): void
  /** 让网卡取值函数开始抛错（演"推导失败"）。 */
  breakNetworkInterfaces(): void
  cleanup(): void
}

function makeHost(options: { trustedHosts?: readonly string[]; distIndex?: string; phoneBaseUrl?: string; relay?: boolean } = {}): Env {
  const root = mkdtempSync(join(tmpdir(), 'dshm-admin-'))
  const dir = join(root, 'storages', 'dsh-mobile')
  const store = new DeviceStore({ directory: dir })
  const signingKey = generateP256KeyPair()
  let addresses: readonly string[] = ['10.9.9.9']
  let broken = false
  const tls = createTlsManager({ directory: join(dir, 'tls'), addresses: () => [...addresses] })
  // 与 cordis.ts 一致：**插件加载期**就 ensure 一次（"首启缺就生成、有就复用"）
  tls.ensure()
  const host = createMobileHost({
    store,
    identity: {
      hostId: 'host-admin-test',
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
    endpoints: () => ['http://10.9.9.9:3081'],
    selfPort: 3080,
    // 探针语料指向**夹具**而不是本机真实 DSH（测试不该依赖机器上装了什么）
    distIndex: () => options.distIndex,
    tls,
    hostname: () => 'Mac-mini-2024.local',
    networkInterfaces: () => {
      if (broken) throw new Error('simulated os.networkInterfaces failure')
      return { en0: addresses.map((address) => ({ address, family: 'IPv4', internal: false })) }
    },
    ...(options.trustedHosts === undefined ? {} : { trustedHosts: options.trustedHosts }),
    ...(options.phoneBaseUrl === undefined ? {} : { phoneBaseUrl: options.phoneBaseUrl }),
    ...(options.relay === true
      ? { config: { relayUrl: 'wss://relay.example.com/attach', relayHttpUrl: 'https://relay.example.com/attach-http' } }
      : {}),
  })
  return {
    host,
    store,
    tls,
    dir,
    root,
    setAddresses: (next) => {
      addresses = [...next]
    },
    breakNetworkInterfaces: () => {
      broken = true
    },
    cleanup: () => {
      host.stopRelayDialer()
      host.stopRelayHttpBackhaul()
      rmSync(root, { recursive: true, force: true })
    },
  }
}

interface HttpResult {
  readonly status: number
  readonly body: string
}

/** 以 HTTP 语义直接驱动 `handleHttp`（与 pairing-security.test.ts 同一思路）。 */
async function httpCall(
  host: MobileHost,
  method: string,
  path: string,
  options: { remoteAddress?: string; host?: string; body?: unknown } = {},
): Promise<HttpResult> {
  const chunks = options.body === undefined ? [] : [Buffer.from(JSON.stringify(options.body), 'utf8')]
  const req = {
    method,
    url: path,
    headers: { host: options.host ?? '127.0.0.1:3080' },
    socket: { remoteAddress: options.remoteAddress ?? '127.0.0.1' },
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  } as unknown as Parameters<MobileHost['handleHttp']>[0]

  let result: { status: number; body: string } | undefined
  const res = {
    headersSent: false,
    writeHead(code: number) {
      result = { status: code, body: '' }
      return this
    },
    end(data?: Buffer | string) {
      if (result !== undefined) result.body = typeof data === 'string' ? data : (data?.toString('utf8') ?? '')
    },
  } as unknown as Parameters<MobileHost['handleHttp']>[1]

  assert.equal(host.handleHttp(req, res), true, `${method} ${path} 应由宿主插件处理`)
  for (let i = 0; i < 200 && result === undefined; i++) await new Promise((resolve) => setTimeout(resolve, 2))
  assert.notEqual(result, undefined, `${method} ${path} 未产生响应`)
  return result as HttpResult
}

// ─────────────────────── A：栅栏按"当时网卡"现算 ───────────────────────

test('A 本机 IP 与 hostname 自动受信：manifest 不再需要手传 IP', async () => {
  const env = makeHost({ distIndex: makeFrontendFixture(mkdtempSync(join(tmpdir(), 'dshm-fe-'))) })
  try {
    // 局域网客户端用本机 IP 访问：以前必须写进 trustedHosts，现在自动放行
    assert.equal((await httpCall(env.host, 'GET', '/mobile/manifest', { host: '10.9.9.9:3081', remoteAddress: '10.0.0.7' })).status, 200)
    // 机器名（裸名与 .local 两种写法）同样放行——证书 SAN 里写的就是它们
    assert.equal((await httpCall(env.host, 'GET', '/mobile/manifest', { host: 'mac-mini-2024.local:3081' })).status, 200)
    assert.equal((await httpCall(env.host, 'GET', '/mobile/manifest', { host: 'Mac-mini-2024:3081' })).status, 200)
  } finally {
    env.cleanup()
  }
})

test('A 外部地址与伪造域名一律拒绝（含"名字里含本机 IP"与通配 DNS 写法）', async () => {
  const env = makeHost()
  try {
    for (const bad of [
      '8.8.8.8:3081',
      '172.16.0.1:3081',
      'evil.example.com:3081',
      '10.9.9.9.nip.io:3081', // 这个名字**确实**解析到本机 IP，但 Host 是名字 ⇒ 必须拒
      '10.9.9.9.evil.com:3081',
      'mac-mini-2024.local.evil.com:3081',
      'evil-mac-mini-2024.local:3081',
    ]) {
      const result = await httpCall(env.host, 'GET', '/mobile/manifest', { host: bad, remoteAddress: '10.0.0.7' })
      assert.equal(result.status, 403, `必须拒绝 Host=${bad}`)
    }
  } finally {
    env.cleanup()
  }
})

test('A 换网后**立刻**生效（同一个宿主对象，不重启）', async () => {
  const env = makeHost()
  try {
    assert.equal((await httpCall(env.host, 'GET', '/mobile/manifest', { host: '192.168.31.88:3081' })).status, 403)
    env.setAddresses(['192.168.31.88'])
    assert.equal(
      (await httpCall(env.host, 'GET', '/mobile/manifest', { host: '192.168.31.88:3081' })).status,
      200,
      '新地址必须立刻生效',
    )
    assert.equal(
      (await httpCall(env.host, 'GET', '/mobile/manifest', { host: '10.9.9.9:3081' })).status,
      403,
      '旧地址必须立刻失效',
    )
  } finally {
    env.cleanup()
  }
})

test('A 推导失败时退回静态列表（不放开闸门）', async () => {
  const env = makeHost({ trustedHosts: ['10.9.9.9:3081'] })
  try {
    env.breakNetworkInterfaces()
    // 静态列表里的照旧放行
    assert.equal((await httpCall(env.host, 'GET', '/mobile/manifest', { host: '10.9.9.9:3081' })).status, 200)
    // 本机另一个 IP（不在静态列表里）不再被推导放行
    assert.equal((await httpCall(env.host, 'GET', '/mobile/manifest', { host: '100.64.1.2:3081' })).status, 403)
    // hostname 那半边与网卡无关，照旧生效
    assert.equal((await httpCall(env.host, 'GET', '/mobile/manifest', { host: 'mac-mini-2024.local:3081' })).status, 200)
  } finally {
    env.cleanup()
  }
})

test('A 收紧开关：trustLocalNames=false 之后只剩 IP 字面量', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dshm-admin-'))
  const store = new DeviceStore({ directory: join(root, 'store') })
  const signingKey = generateP256KeyPair()
  const host = createMobileHost({
    config: { trustLocalNames: false },
    store,
    identity: { hostId: 'h', hostName: 'h', signingKey: { publicKey: signingKey.publicKey, privateKey: signingKey.privateKey } },
    gateway: {
      async invoke() {
        return {}
      },
      async stream() {
        return (async function* (): AsyncIterable<unknown> {})()
      },
    },
    endpoints: () => [],
    hostname: () => 'Mac-mini-2024.local',
    networkInterfaces: () => ({ en0: [{ address: '10.9.9.9', family: 'IPv4', internal: false }] }),
  })
  try {
    assert.equal((await httpCall(host, 'GET', '/mobile/manifest', { host: '10.9.9.9:3081' })).status, 200)
    assert.equal((await httpCall(host, 'GET', '/mobile/manifest', { host: 'mac-mini-2024.local:3081' })).status, 403)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ─────────────────────── B2：清设备的正式路由 ───────────────────────

test('B2 loopback 删除设备：内存表与 devices.json **同时**更新（不需要重启）', async () => {
  const env = makeHost()
  try {
    env.store.upsert(deviceRecord('dev-a'))
    env.store.upsert(deviceRecord('dev-b'))
    assert.equal(env.store.list().length, 2)

    const result = await httpCall(env.host, 'POST', '/mobile/admin/devices/remove', { body: { deviceId: 'dev-a' } })
    assert.equal(result.status, 200)
    assert.deepEqual(JSON.parse(result.body), { removed: true, deviceId: 'dev-a' })
    // 内存表
    assert.equal(env.store.get('dev-a'), undefined)
    // 磁盘（这正是"改文件 + 立刻重启"那条老路的替代品：文件里的条目也没了）
    const onDisk = JSON.parse(readFileSync(join(env.dir, 'devices.json'), 'utf8')) as { devices: { deviceId: string }[] }
    assert.deepEqual(
      onDisk.devices.map((device) => device.deviceId),
      ['dev-b'],
    )
    // 审计要留下痕迹
    const audit = env.store.listAudit()
    assert.equal(audit.some((entry) => entry.kind === 'remove' && entry.deviceId === 'dev-a' && entry.ok), true)
  } finally {
    env.cleanup()
  }
})

test('B2 ?revoked=1 只清已撤销的；不存在的 id 返回 404；缺参数 400', async () => {
  const env = makeHost()
  try {
    env.store.upsert(deviceRecord('keep'))
    env.store.upsert(deviceRecord('gone-1', 'revoked'))
    env.store.upsert(deviceRecord('gone-2', 'revoked'))

    const bulk = await httpCall(env.host, 'POST', '/mobile/admin/devices/remove?revoked=1', { body: {} })
    assert.equal(bulk.status, 200)
    assert.deepEqual(JSON.parse(bulk.body), { removed: 2 })
    assert.deepEqual(
      env.store.list().map((device) => device.deviceId),
      ['keep'],
    )

    const missing = await httpCall(env.host, 'POST', '/mobile/admin/devices/remove', { body: { deviceId: 'nope' } })
    assert.equal(missing.status, 404)
    assert.deepEqual(JSON.parse(missing.body), { removed: false, deviceId: 'nope' })

    const noParam = await httpCall(env.host, 'POST', '/mobile/admin/devices/remove', { body: {} })
    assert.equal(noParam.status, 400)

    const wrongMethod = await httpCall(env.host, 'GET', '/mobile/admin/devices/remove')
    assert.equal(wrongMethod.status, 404)
  } finally {
    env.cleanup()
  }
})

test('B2 伪造回环 Host + 非回环 socket ⇒ 403，且**不泄露设备信息**，并记审计', async () => {
  const env = makeHost()
  try {
    env.store.upsert(deviceRecord('secret-device'))
    const result = await httpCall(env.host, 'POST', '/mobile/admin/devices/remove?revoked=1', {
      host: 'localhost:3080', // 栅栏放行回环 hostname —— 但它**不是身份**
      remoteAddress: '10.0.0.7', // 真实来源是局域网
      body: {},
    })
    assert.equal(result.status, 403)
    // 拒绝响应里不许出现设备 id、条数、清单
    assert.equal(result.body.includes('secret-device'), false)
    assert.equal(result.body.includes('devices'), false, '拒绝响应不得回显设备清单字段')
    // 设备一个都不能少
    assert.equal(env.store.get('secret-device') !== undefined, true)
    // 审计要留下"有人在敲门"
    const audit = env.store.listAudit()
    assert.equal(
      audit.some((entry) => entry.kind === 'deny' && entry.target === '/mobile/admin/devices/remove'),
      true,
    )
  } finally {
    env.cleanup()
  }
})

test('B2 ★收紧后：局域网用**本机真实 IP** 也**调不到**管理路由（只允许 loopback）', async () => {
  const env = makeHost()
  try {
    env.store.upsert(deviceRecord('dev-lan'))
    const result = await httpCall(env.host, 'POST', '/mobile/admin/devices/remove', {
      host: '10.9.9.9:3081', // 本机网卡上的地址 ⇒ 会被 A 的推导判为"受信 authority"
      remoteAddress: '10.0.0.7', // 但来源是局域网 ⇒ 管理路由必须拒绝
      body: { deviceId: 'dev-lan' },
    })
    /**
     * ★ 2026-09-27 用户拍板**收紧**：管理路由（`/mobile/admin/*`）只允许本机。
     * 实现是 `isAdminSourceTrusted` 里只剩 `isLoopbackRequest(req)` ✓。
     * ★ 这条断言与**实现**是配套的：收紧/放宽任何一侧都要同时改另一侧
     *   （见 `16-插件封装-第一阶段.md` 的边界清单 ✓）。
     */
    assert.equal(result.status, 403)
    assert.notEqual(env.store.get('dev-lan'), undefined, '设备记录必须原样还在')
  } finally {
    env.cleanup()
  }
})

// ─────────────────────── B3：自检路由 ───────────────────────

test('B3 自检把"现在到底好不好、缺什么"一次说完（数字全是真的）', async () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'dshm-fe-'))
  const env = makeHost({ distIndex: makeFrontendFixture(fixtureRoot), phoneBaseUrl: 'https://10.9.9.9:3443', relay: true })
  try {
    // makeHost 已在"加载期"ensure 过一次（新建了 CA）。这里再 ensure 一次 =
    // 模拟"插件重启、CA 早就存在"的生产常态 ⇒ createdCa 变 false，不该再有新建 CA 的告警。
    env.tls.ensure()
    env.store.upsert(deviceRecord('one'))
    env.store.upsert(deviceRecord('two', 'revoked'))

    const result = await httpCall(env.host, 'GET', '/mobile/admin/selfcheck', { host: '10.9.9.9:3081' })
    assert.equal(result.status, 200)
    const report = JSON.parse(result.body) as MobileSelfcheck

    assert.equal(report.ok, true, `应为良好：${JSON.stringify(report.warnings)}`)
    assert.deepEqual(report.warnings, [])
    // 证书：真的生成了，且指纹是 SHA-256 形态
    assert.equal(report.tls.available, true)
    assert.equal(report.tls.ok, true)
    assert.equal(report.tls.createdCa, false, 'CA 已存在 ⇒ 不该报"新建"')
    assert.match(report.tls.caFingerprint ?? '', /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/)
    assert.equal(existsSync(join(env.dir, 'tls', 'lan-ca.pem')), true)
    assert.equal(report.tls.directory, join(env.dir, 'tls'))
    // 监听端口
    assert.equal(report.listen.dshPort, 3080)
    assert.equal(report.listen.phoneBaseUrl, 'https://10.9.9.9:3443')
    // 信任判据的**当前**推导结果
    assert.equal(report.trust.derived, true)
    assert.deepEqual(report.trust.localAddresses, ['10.9.9.9'])
    assert.deepEqual(report.trust.hostnames, ['mac-mini-2024', 'mac-mini-2024.local'])
    assert.deepEqual(report.trust.relay, ['wss://relay.example.com/attach', 'https://relay.example.com/attach-http'])
    // 设备条数：2 台（其中 1 台已撤销）
    assert.deepEqual(report.devices, { count: 2, connected: 0, revoked: 1 })
    // DSH 前端探针：夹具里 9 条锚点全在
    assert.equal(report.dshFrontend.status, 'ok')
    assert.equal(report.dshFrontend.hits, report.dshFrontend.total)
    assert.equal(report.dshFrontend.hits, 9)
    assert.equal(report.host.hostId, 'host-admin-test')
  } finally {
    env.cleanup()
    rmSync(fixtureRoot, { recursive: true, force: true })
  }
})

test('B3 自检拿不到 DSH 产物时报"未知"，不编命中率', async () => {
  const env = makeHost()
  try {
    const result = await httpCall(env.host, 'GET', '/mobile/admin/selfcheck')
    const report = JSON.parse(result.body) as MobileSelfcheck
    assert.equal(report.dshFrontend.status, 'unknown')
    assert.equal(report.dshFrontend.hits, 0)
    assert.equal(report.dshFrontend.items.every((item) => item.found === false), true)
    assert.match(report.dshFrontend.note ?? '', /无法探测|拿不到/)
    // unknown 不算失败：证书没问题就仍然是 ok:true（不编，也不误报）
    assert.equal(report.ok, true)
    assert.equal(
      report.warnings.some((warning) => warning.includes('未知')),
      true,
    )
  } finally {
    env.cleanup()
  }
})

test('B3 自检里的信任推导随网卡变化（同一进程内换网）', async () => {
  const env = makeHost()
  try {
    const before = JSON.parse((await httpCall(env.host, 'GET', '/mobile/admin/selfcheck')).body) as MobileSelfcheck
    assert.deepEqual(before.trust.localAddresses, ['10.9.9.9'])
    env.setAddresses(['10.9.9.9', '100.64.1.2'])
    const after = JSON.parse((await httpCall(env.host, 'GET', '/mobile/admin/selfcheck')).body) as MobileSelfcheck
    assert.deepEqual(after.trust.localAddresses, ['10.9.9.9', '100.64.1.2'])
  } finally {
    env.cleanup()
  }
})

test('B3 自检与管理路由都在栅栏之内：外部 Host 一律 403', async () => {
  const env = makeHost()
  try {
    assert.equal((await httpCall(env.host, 'GET', '/mobile/admin/selfcheck', { host: 'evil.example.com:3443' })).status, 403)
    assert.equal(
      (await httpCall(env.host, 'POST', '/mobile/admin/devices/remove', { host: '8.8.8.8:3443', body: {} })).status,
      403,
    )
  } finally {
    env.cleanup()
  }
})

// ─────────────────────── manifest 里的证书状态 ───────────────────────

test('B1 证书生成失败会在 manifest 里明说（不是静默）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dshm-admin-'))
  const store = new DeviceStore({ directory: join(root, 'store') })
  const signingKey = generateP256KeyPair()
  // 目录位置被一个**文件**占住 ⇒ ensure 必然失败
  const blocker = join(root, 'blocker')
  writeFileSync(blocker, 'x')
  const tls = createTlsManager({ directory: join(blocker, 'tls') })
  const host = createMobileHost({
    store,
    identity: { hostId: 'h', hostName: 'h', signingKey: { publicKey: signingKey.publicKey, privateKey: signingKey.privateKey } },
    gateway: {
      async invoke() {
        return {}
      },
      async stream() {
        return (async function* (): AsyncIterable<unknown> {})()
      },
    },
    endpoints: () => [],
    tls,
  })
  try {
    const manifest = JSON.parse((await httpCall(host, 'GET', '/mobile/manifest')).body) as {
      tls?: { ok: boolean; error?: string }
    }
    assert.equal(manifest.tls?.ok, false)
    assert.equal(typeof manifest.tls?.error === 'string' && (manifest.tls?.error?.length ?? 0) > 0, true)
    const report = JSON.parse((await httpCall(host, 'GET', '/mobile/admin/selfcheck')).body) as MobileSelfcheck
    assert.equal(report.tls.available, true)
    assert.equal(report.tls.ok, false)
    assert.equal(report.ok, false)
    assert.equal(
      report.warnings.some((warning) => warning.includes('自签证书不可用')),
      true,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
