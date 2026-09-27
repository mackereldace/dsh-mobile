/**
 * 配对票据里的**宿主 CA 指纹**（C2 · `工程设计/16-插件封装-第一阶段.md` §4.2 第 3 条）。
 *
 * ## 这个字段是干什么的（一句话）
 *
 * APK 从 C2 起**不再**把某台电脑的 CA 打进包里（那等于"一机一包"），
 * 于是壳第一次连一台没见过的电脑时，`onReceivedSslError` 里那张证书必然验不过。
 * 这时壳要回答一个问题：**"我从这台电脑取回的 CA，是不是用户期望的那一台？"**
 * 答案必须来自**带外**通道 —— 二维码/配对链接是"用户在电脑屏幕上看到、手机扫到"的，
 * 中间人改不了它。本文件验的就是"这条带外数据真的带上了宿主 CA 的指纹"。
 *
 * ★ 反面（本文件**不**验）：壳拿到指纹之后怎么比、什么时候 `proceed()` ——
 *   那是 `MainActivity.tofuTrustOnce` 的事，**只能在真机/代码评审里看**。
 *   这里只管"宿主有没有把它送出去"（送不出去 ⇒ 手机上只能退回"用户自己看"，
 *   而那条路正是被省略就会退化成"盲信第一次"的那一步）。
 *
 * ## 为什么单开一个文件（而不是塞进 host.test.ts / pairing-security.test.ts）
 *
 * 与 `pairing-security.test.ts` 同一个理由：host.test.ts 正由并行任务改动，
 * 新文件互不干扰；而且"票据字段与带外通道"是一件事，红的时候一眼知道红在哪。
 *
 * ## 三条断言各自防什么
 *
 * 1. **注入了证书管理器** ⇒ 票据、二维码深链、**6 位短码**那条载荷、manifest
 *    这**四条**路上的指纹必须是**同一个值** ✓ —— 少任何一条，手机上"扫到的"
 *    与"屏幕上看到的"就可能不是同一串 ✓，而人眼核对就失去意义 ✗；
 * 2. **没注入 / 证书坏了** ⇒ 这个键**不许出现在票据里**（不是 `undefined` ✗）——
 *    否则旧手机/旧宿主的形状被悄悄改掉 ✓，而"可选字段"的全部意义就是**形状不变** ✓；
 * 3. **不带这个字段的票据仍然合法** ✓（类型上 `?` ✓、运行时 JSON 往返保持"没有这个键" ✓）——
 *    这就是"旧宿主 + 新手机"与"新宿主 + 老手机"两条路都还能走 ✓。
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { generateP256KeyPair, type MobileManifest, type PairingTicket } from '@dsh-mobile/protocol'

import { DeviceStore } from '../src/devices.ts'
import { createMobileHost, type MobileHost } from '../src/index.ts'
import type { TlsManager, TlsStatus } from '../src/tls-cert.ts'

// ─────────────────────────────── 测试脚手架 ───────────────────────────────

/**
 * ★ 为什么这里要绕一道类型别名（而不是直接 `ticket.caFingerprint` ✗）：
 *
 * `@dsh-mobile/protocol` 这个包名解析到的是**构建产物** `packages/protocol/lib/index.d.ts`
 * （见它的 `package.json` 的 `exports.types` ✓，而 `lib/` 是 gitignore 的 ✓）——
 * 也就是说**类型的新鲜度取决于上一次 `npm run build`** ✓。
 * 本文件在"刚改完 `wire.ts`、还没重新构建"的那一刻也必须能过 `tsc` ✓
 * （子智能体被明令禁止跑 `npm run build` ✓ —— 那是主线的收尾动作 ✓），
 * 所以这里把那个可选字段用**交集类型**取出来 ✓：lib 里有没有它都能编译 ✓，
 * 运行时读到的当然还是真实字段 ✓。
 */
type TicketWithCa = PairingTicket & { caFingerprint?: string }
type ManifestWithTls = MobileManifest & { tls?: { ok?: boolean; caFingerprint?: string } }

/** 读票据里那个可选字段（读不到 = 旧宿主 ⇒ 壳退回"要用户明确确认"那条降级路）。 */
const caOf = (ticket: PairingTicket): string | undefined => (ticket as TicketWithCa).caFingerprint
/** 读 manifest 里的 tls 段（配对页显示给人看的那一串就是它）。 */
const manifestTls = (host: MobileHost): ManifestWithTls['tls'] => (host.manifest() as ManifestWithTls).tls

/** 一张**假的** CA 指纹（形状与 Node 的 `X509Certificate.fingerprint256` 一致：冒号十六进制）。 */
const FAKE_CA_FINGERPRINT =
  'AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:' +
  'AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89'

/**
 * 一个只做"字符串搬运"的假证书管理器 ✓ —— `createPairing()` 只读
 * `status().caFingerprint` 这一个字符串 ✓，**不解析 PEM** ✓，
 * 所以这里不需要真证书 ✓（真证书那条路由 `tls-cert.test.ts` 管 ✓）。
 */
function fakeTls(caFingerprint: string | undefined): TlsManager {
  const status = (): TlsStatus =>
    ({
      ok: caFingerprint !== undefined,
      directory: '/tmp/dshm-fake-tls',
      paths: {
        directory: '/tmp/dshm-fake-tls',
        caCert: '/tmp/dshm-fake-tls/lan-ca.pem',
        caKey: '/tmp/dshm-fake-tls/lan-ca-key.pem',
        serverCert: '/tmp/dshm-fake-tls/lan-cert.pem',
        serverKey: '/tmp/dshm-fake-tls/lan-key.pem',
      },
      createdCa: false,
      createdServer: false,
      resignedServer: false,
      checkedAt: new Date().toISOString(),
      ...(caFingerprint === undefined ? { error: '证书坏了（本用例要的就是"没有指纹"这一态）' } : { caFingerprint }),
    }) as TlsStatus
  return {
    paths: status().paths,
    ensure: status,
    status,
    readCaPem: () => undefined,
  }
}

interface HostEnv {
  readonly host: MobileHost
  cleanup(): void
}

/** 建一个只依赖临时目录的宿主（不碰生产 `~/.dsh`，不起真实端口）。 */
function makeHost(tls?: TlsManager): HostEnv {
  const dir = mkdtempSync(join(tmpdir(), 'dshm-ticket-ca-'))
  const store = new DeviceStore({ directory: dir })
  const signingKey = generateP256KeyPair()
  const host = createMobileHost({
    store,
    identity: {
      hostId: 'host-ticket-ca',
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
    ...(tls === undefined ? {} : { tls }),
  })
  return { host, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

/** 解 `dshmobile://pair?d=<base64url(JSON)>`（与壳里 `PairLink.ticketJsonOf` 同一件事）。 */
function decodeQrPayload(qrPayload: string): PairingTicket {
  assert.ok(qrPayload.startsWith('dshmobile://pair?d='), `深链形状不对：${qrPayload.slice(0, 40)}`)
  const token = qrPayload.slice('dshmobile://pair?d='.length)
  return JSON.parse(Buffer.from(token, 'base64url').toString('utf8')) as PairingTicket
}

/** 解 6 位短码那条路给手机用的载荷（`/mobile/p/<码>` ⇒ `base64url(ticket JSON)`）。 */
function decodePairingPayload(payload: string): PairingTicket {
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as PairingTicket
}

// ─────────────────────────────── 用例 ───────────────────────────────

test('注入了证书管理器：票据 / 二维码 / 短码载荷 / manifest 四条路上的 CA 指纹是同一个值', () => {
  const env = makeHost(fakeTls(FAKE_CA_FINGERPRINT))
  try {
    const pairing = env.host.createPairing()
    assert.equal(
      caOf(pairing.ticket),
      FAKE_CA_FINGERPRINT,
      '票据里必须带上 tls.status().caFingerprint（壳要靠它做带外比对）',
    )
    assert.equal(
      caOf(decodeQrPayload(pairing.qrPayload)),
      FAKE_CA_FINGERPRINT,
      '二维码深链里也必须有（手机扫码那条路读的就是它）',
    )
    /**
     * ★ 6 位短码那条路（`/mobile/p/<码>`）走的是 `pairingPayloadForCode` ——
     * 它是**另一条**把票据送到手机的路（浏览器开短码链接 ⇒ 宿主换票据 ⇒ 跳外壳）。
     * 两条路送的是同一张票据 ✓，所以必须都带指纹 ✓：只带上一条的话，
     * "扫码进来的"与"输短码进来的"在手机上会是两种行为 ✓（一个自动比对、一个弹框问人 ✓）。
     */
    const payload = env.host.pairingPayloadForCode(pairing.ticket.code)
    assert.notEqual(payload, undefined, '短码应当能换到配对载荷')
    assert.equal(
      caOf(decodePairingPayload(payload as string)),
      FAKE_CA_FINGERPRINT,
      '6 位短码那条载荷里也必须有（否则输短码配对的用户拿不到带外指纹）',
    )
    /**
     * ★ manifest 里的那一条 —— 它就是**配对页显示给人看的那一串**
     * （`pairing-page.html` 的 showCaFingerprint / renderCaTrust 读 `manifest.tls.caFingerprint`）。
     * 它与票据里那一串"同一个来源、同一个值" ✓ 是"人眼核对"能成立的前提 ✓：
     * 两处不一致的话，用户照着屏幕比对就会得出"指纹不符、可能有人在中间冒充"的**错误结论** ✓。
     */
    assert.equal(
      manifestTls(env.host)?.caFingerprint,
      FAKE_CA_FINGERPRINT,
      'manifest.tls.caFingerprint（配对页显示给人看的那一串）必须与票据里那个一致',
    )
  } finally {
    env.cleanup()
  }
})

test('没有注入证书管理器（或证书坏了）：票据里**没有**这个键 —— 形状与加字段之前逐字段相同', () => {
  const env = makeHost()
  try {
    const pairing = env.host.createPairing()
    assert.equal(
      'caFingerprint' in pairing.ticket,
      false,
      '拿不到指纹时**不许写这个键**（写 undefined 会把 JSON 形状改掉，旧宿主/旧手机那条路就不再是"逐字段相同"）',
    )
    assert.equal(
      JSON.stringify(pairing.ticket).includes('caFingerprint'),
      false,
      '序列化之后的 JSON 里也不该出现这个键名',
    )
    // 其余字段一个都不能少（这条防的是"加字段时手滑删了别的"）
    assert.deepEqual(
      Object.keys(pairing.ticket).sort(),
      ['code', 'endpoints', 'expiresAt', 'hostFingerprint', 'hostId', 'protocolVersion', 'ticket', 'v'].sort(),
      '票据字段集合必须与 C2 之前完全一致',
    )
  } finally {
    env.cleanup()
  }
})

test('证书坏了（status().caFingerprint === undefined）：同样不写这个键', () => {
  const env = makeHost(fakeTls(undefined))
  try {
    const pairing = env.host.createPairing()
    assert.equal('caFingerprint' in pairing.ticket, false, '证书坏掉时也不许塞一个空串/undefined 进去')
    assert.equal(manifestTls(env.host)?.caFingerprint, undefined, 'manifest 那边同样只报事实')
  } finally {
    env.cleanup()
  }
})

test('旧形状的票据（不带 caFingerprint）仍然合法：可选字段的两种形状都能原样往返', () => {
  const legacy: PairingTicket = {
    v: 1,
    hostId: 'host-legacy',
    hostFingerprint: 'ABCD-EF01-2345-6789',
    code: '123456',
    ticket: 'tkt_legacy',
    endpoints: ['https://192.168.1.10:3443'],
    protocolVersion: 1,
    expiresAt: '2026-12-31T00:00:00.000Z',
  }
  // 旧形状：JSON 往返之后**还是**没有这个键（旧宿主 ⇒ 壳走"要用户明确确认"那条降级路）
  const legacyRoundTrip = JSON.parse(JSON.stringify(legacy)) as PairingTicket
  assert.equal('caFingerprint' in legacyRoundTrip, false, '可选字段省略之后不许被 JSON 往返凭空补出来')
  assert.deepEqual(legacyRoundTrip, legacy, '旧形状逐字段不变（旧手机/旧宿主一个字都不用改）')

  // 新形状：带指纹的票据往返之后指纹**逐字符**不变（比对是字符串比较，差一个字符就是"不一致"）
  const withCa = { ...legacy, caFingerprint: FAKE_CA_FINGERPRINT } as PairingTicket
  const withCaRoundTrip = JSON.parse(JSON.stringify(withCa)) as PairingTicket
  assert.equal(caOf(withCaRoundTrip), FAKE_CA_FINGERPRINT, '指纹必须原样往返')
})
