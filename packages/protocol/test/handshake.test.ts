/**
 * 握手与帧加解密的端到端测试。
 *
 * 这些测试同时充当"跨端契约"的活文档：Dart 端必须能通过这些相同的断言。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  ClientHandshake,
  HostHandshake,
  type HandshakeOutcome,
  type HostDeviceCredentials,
} from '../src/handshake.ts'
import {
  constantTimeEqual,
  derToRawSignature,
  fingerprint,
  formatFingerprint,
  fromB64,
  generateP256KeyPair,
  generateX25519KeyPair,
  openFrame,
  openServerHello,
  parseFrame,
  rawToDerSignature,
  ReplayWindow,
  sealFrame,
  sealServerHello,
  signRaw,
  toB64,
  verifyRaw,
} from '../src/crypto.ts'
import {
  AUTH_TAG_BYTES,
  DEFAULT_CAPABILITIES,
  ErrorCode,
  FrameFlags,
  FrameType,
  type ClientHelloPayload,
  type ClientAuthPayload,
  type ServerAuthOkPayload,
  type ServerHelloPayload,
} from '../src/wire.ts'

const HANDSHAKE_NONCE = Buffer.from([0, 0, 0, 1])

function mustSend(outcome: HandshakeOutcome): unknown {
  assert.equal(outcome.kind, 'send', `expected send, got ${outcome.kind}`)
  return outcome.kind === 'send' ? outcome.payload : undefined
}

function mustDone(outcome: HandshakeOutcome) {
  assert.equal(outcome.kind, 'done', `expected done, got ${outcome.kind}: ${JSON.stringify(outcome)}`)
  if (outcome.kind !== 'done') throw new Error('unreachable')
  return outcome.session
}

/** 一趟完整握手，返回双方会话。可注入篡改点以测试失败路径。 */
async function runHandshake(options: {
  tamperSignature?: boolean
  tamperConfirm?: boolean
  pinHostKey?: boolean
  requestedCapabilities?: Partial<typeof DEFAULT_CAPABILITIES>
  grantCapabilities?: HostDeviceCredentials['capabilities']
} = {}) {
  const hostSigning = generateP256KeyPair()
  const deviceKey = generateX25519KeyPair()
  const deviceSigning = generateP256KeyPair()
  const deviceId = 'dev-test-0001'
  const hostId = 'host-test-0001'

  const credentials: HostDeviceCredentials = {
    deviceId,
    devicePublicKey: deviceKey.publicKey,
    deviceSigningKey: deviceSigning.publicKey,
    fingerprint: fingerprint(deviceSigning.publicKey),
    capabilities: options.grantCapabilities ?? DEFAULT_CAPABILITIES,
    authorization: 'persistent',
  }

  const host = new HostHandshake({
    hostId,
    hostSigningKey: hostSigning,
    resolveDevice: (hello: ClientHelloPayload) => (hello.deviceId === deviceId ? credentials : undefined),
  })
  const client = new ClientHandshake({
    deviceId,
    deviceKey,
    deviceSigningKey: deviceSigning,
    ...(options.requestedCapabilities === undefined ? {} : { requestedCapabilities: options.requestedCapabilities }),
    ...(options.pinHostKey === true ? { pinnedHostSigningKey: hostSigning.publicKey } : {}),
  })

  // 1. ClientHello（明文）
  const clientHello = mustSend(client.start()) as ClientHelloPayload

  // 2. ServerHello（K_hs 保护）
  const serverHelloOutcome = await host.acceptClientHello(clientHello)
  let serverHello = mustSend(serverHelloOutcome) as ServerHelloPayload
  if (options.tamperSignature === true) {
    const sig = fromB64(serverHello.signature)
    sig[0] = (sig[0] ?? 0) ^ 0xff
    serverHello = { ...serverHello, signature: toB64(sig) }
  }
  const hostHsKey = host.handshakeKey()
  const sealedServerHello = sealServerHello({
    handshakeKey: hostHsKey,
    serverEphemeralPublicKey: serverHello.ephemeralPublicKey,
    payload: serverHello,
  })

  // 真实客户端流程：从明文可见的临时公钥自行派生 K_hs → 解密密文 → 校验签名。
  const opened = openServerHello({ sealed: sealedServerHello, ephemeralPrivateKey: client.ephemeralKeys.privateKey })
  if (!opened.ok) throw new Error(`客户端应能解开 ServerHello：${opened.message}`)
  assert.equal(opened.ok, true)
  const decryptedServerHello = opened.payload as ServerHelloPayload
  assert.ok(constantTimeEqual(hostHsKey, opened.handshakeKey), 'K_hs 两端必须一致')

  // 3. ClientAuth
  const clientAuthOutcome = client.acceptServerHello(decryptedServerHello)
  if (options.tamperSignature === true) {
    assert.equal(clientAuthOutcome.kind, 'fail', '篡改宿主签名必须导致握手失败')
    assert.equal(clientAuthOutcome.kind === 'fail' ? clientAuthOutcome.code : '', ErrorCode.HandshakeSignature)
    return { failed: true as const }
  }
  let clientAuth = mustSend(clientAuthOutcome) as ClientAuthPayload

  const clientKeys = client.sessionKeys
  assert.ok(clientKeys, '客户端应已派生会话密钥')

  if (options.tamperConfirm === true) {
    const mac = fromB64(clientAuth.confirm)
    mac[0] = (mac[0] ?? 0) ^ 0xff
    clientAuth = { ...clientAuth, confirm: toB64(mac) }
  }

  // 协议规定：ClientAuth 用 K_hs 保护（此时宿主还不知道客户端的 nonce 前缀，
  // 无法用会话密钥解帧）。客户端侧的 K_hs 与宿主一致，已在上方断言。
  const sealedClientAuth = sealFrame({
    key: hostHsKey,
    nonceBase: HANDSHAKE_NONCE,
    type: FrameType.ClientAuth,
    flags: FrameFlags.Json,
    counter: 2n,
    payload: Buffer.from(JSON.stringify(clientAuth)),
    truncateTag: false,
  })

  const hostOpened = openFrame({
    header: parseFrame(sealedClientAuth.bytes),
    key: hostHsKey,
    nonceBase: HANDSHAKE_NONCE,
    replay: new ReplayWindow(),
  })
  assert.equal(hostOpened.ok, true, '宿主应能解开 ClientAuth')
  const decryptedClientAuth = JSON.parse(hostOpened.ok ? hostOpened.plaintext.toString('utf8') : '{}') as ClientAuthPayload

  // 4. ServerAuthOk
  const authOkOutcome = host.acceptClientAuth(decryptedClientAuth)
  if (options.tamperConfirm === true) {
    assert.equal(authOkOutcome.kind, 'fail', '篡改客户端确认 MAC 必须导致握手失败')
    assert.equal(authOkOutcome.kind === 'fail' ? authOkOutcome.code : '', ErrorCode.HandshakeConfirm)
    return { failed: true as const }
  }
  const authOk = mustSend(authOkOutcome) as ServerAuthOkPayload

  const pending = host.pending()
  const sealedAuthOk = sealFrame({
    key: pending.keys.serverToClient,
    nonceBase: fromB64(authOk.serverNonceBase),
    type: FrameType.ServerAuthOk,
    flags: FrameFlags.Json,
    counter: 1n,
    payload: Buffer.from(JSON.stringify(authOk)),
    truncateTag: false,
  })

  const clientOpened = openFrame({
    header: parseFrame(sealedAuthOk.bytes),
    key: clientKeys.serverToClient,
    nonceBase: fromB64(authOk.serverNonceBase),
    replay: new ReplayWindow(),
  })
  if (!clientOpened.ok) throw new Error(`客户端应能解开 ServerAuthOk：${clientOpened.message}`)
  assert.equal(clientOpened.ok, true)
  const decryptedAuthOk = JSON.parse(clientOpened.plaintext.toString('utf8')) as ServerAuthOkPayload

  const clientSession = mustDone(client.acceptServerAuthOk(decryptedAuthOk))
  const hostSession = host.complete()

  return {
    failed: false as const,
    clientSession,
    hostSession,
    hostSigning,
    deviceKey,
    credentials,
  }
}

test('完整握手：双方派生出一致的会话密钥与会话标识', async () => {
  const result = await runHandshake({ pinHostKey: true })
  assert.equal(result.failed, false)
  if (result.failed) return

  assert.equal(result.clientSession.sessionId, result.hostSession.sessionId)
  assert.equal(result.clientSession.deviceId, result.hostSession.deviceId)
  assert.equal(result.clientSession.hostId, result.hostSession.hostId)

  // 密钥一致性：客户端"发"用 clientToServer，宿主"收"用同一把
  for (const dir of ['clientToServer', 'serverToClient', 'confirmClient', 'confirmServer'] as const) {
    assert.ok(
      constantTimeEqual(result.clientSession.keys[dir], result.hostSession.keys[dir]),
      `${dir} 两端必须一致`,
    )
  }
  // 方向分离：两个方向的密钥必须不同
  assert.ok(!constantTimeEqual(result.clientSession.keys.clientToServer, result.clientSession.keys.serverToClient))
  // nonce 前缀交换正确
  assert.ok(constantTimeEqual(result.clientSession.serverNonceBase, result.hostSession.serverNonceBase))
  assert.ok(constantTimeEqual(result.clientSession.clientNonceBase, result.hostSession.clientNonceBase))

  // 会话密钥与会话标识绑定：不同连接必须得到不同 sessionId
  const second = await runHandshake({ pinHostKey: true })
  if (!second.failed) assert.notEqual(second.clientSession.sessionId, result.clientSession.sessionId)
})

test('会话密钥可双向往返加解密业务帧', async () => {
  const result = await runHandshake()
  assert.equal(result.failed, false)
  if (result.failed) return

  const c2sReplay = new ReplayWindow()
  const s2cReplay = new ReplayWindow()
  const payload = Buffer.from(JSON.stringify({ endpoint: 'session/create', payload: { cwd: '/tmp' } }))

  const frame = sealFrame({
    key: result.clientSession.keys.clientToServer,
    nonceBase: result.clientSession.clientNonceBase,
    type: FrameType.RpcRequest,
    flags: FrameFlags.Json,
    counter: 1n,
    payload,
    truncateTag: true,
  })
  const opened = openFrame({
    header: parseFrame(frame.bytes),
    key: result.hostSession.keys.clientToServer,
    nonceBase: result.hostSession.clientNonceBase,
    replay: c2sReplay,
  })
  assert.equal(opened.ok, true)
  assert.deepEqual(opened.ok ? JSON.parse(opened.plaintext.toString('utf8')) : null, JSON.parse(payload.toString('utf8')))

  // 反向
  const back = sealFrame({
    key: result.hostSession.keys.serverToClient,
    nonceBase: result.hostSession.serverNonceBase,
    type: FrameType.RpcResponse,
    flags: FrameFlags.Json,
    counter: 1n,
    payload: Buffer.from(JSON.stringify({ rpcId: 'r1', ok: true, value: { sessionId: 's1' } })),
    truncateTag: true,
  })
  const backOpened = openFrame({
    header: parseFrame(back.bytes),
    key: result.clientSession.keys.serverToClient,
    nonceBase: result.clientSession.serverNonceBase,
    replay: s2cReplay,
  })
  if (!backOpened.ok) throw new Error(`客户端应能解开响应帧：${backOpened.message}`)
  assert.equal(backOpened.ok, true)
})

test('重放同一帧必须被拒绝', async () => {
  const result = await runHandshake()
  assert.equal(result.failed, false)
  if (result.failed) return

  const replay = new ReplayWindow()
  const frame = sealFrame({
    key: result.hostSession.keys.clientToServer,
    nonceBase: result.hostSession.clientNonceBase,
    type: FrameType.RpcRequest,
    flags: FrameFlags.Json,
    counter: 5n,
    payload: Buffer.from('{"a":1}'),
    truncateTag: true,
  })
  const header = parseFrame(frame.bytes)

  const first = openFrame({ header, key: result.hostSession.keys.clientToServer, nonceBase: result.hostSession.clientNonceBase, replay })
  assert.equal(first.ok, true)
  const second = openFrame({ header, key: result.hostSession.keys.clientToServer, nonceBase: result.hostSession.clientNonceBase, replay })
  assert.equal(second.ok, false)
  if (second.ok) throw new Error('unreachable')
  assert.equal(second.code, ErrorCode.ReplayDetected)
})

test('重放窗口允许窗口内重排，拒绝窗口外与超前', () => {
  const replay = new ReplayWindow(16)
  assert.equal(replay.check(1n).ok, true)
  replay.accept(1n)
  assert.equal(replay.check(2n).ok, true)
  replay.accept(2n)
  assert.equal(replay.check(3n).ok, true)
  replay.accept(3n)
  // 重排：1、2 已用过，3 用过；这里用一个未用过但更小的值不可能（无空洞），
  // 因此改测窗口边界行为
  assert.equal(replay.check(1000n).ok, false, '远超窗口的 counter 必须拒绝')
  assert.equal(replay.check(0n).ok, false, 'counter 0 保留，必须拒绝')
  assert.equal(replay.check(-1n).ok, false, '负 counter 必须拒绝')

  const far = new ReplayWindow(16)
  far.accept(100n)
  // 窗口：上界 recv+16、下界 recv-16（含端点）
  assert.equal(far.check(116n).ok, true, '恰好落在上界的值应接受')
  assert.equal(far.check(117n).ok, false, '超出上界必须拒绝（防注入超前帧）')
  assert.equal(far.check(84n).ok, true, '恰好落在下界的值应接受')
  assert.equal(far.check(83n).ok, false, '过旧的值必须拒绝')
  assert.equal(far.check(100n).ok, false, '已接受过的值必须拒绝')
  assert.equal(far.check(0n).ok, false, 'counter 0 保留，必须拒绝')
})

test('篡改后的密文无法通过认证', async () => {
  const result = await runHandshake()
  assert.equal(result.failed, false)
  if (result.failed) return

  const frame = sealFrame({
    key: result.hostSession.keys.clientToServer,
    nonceBase: result.hostSession.clientNonceBase,
    type: FrameType.RpcRequest,
    flags: FrameFlags.Json,
    counter: 7n,
    payload: Buffer.from('{"endpoint":"session/create"}'),
    truncateTag: true,
  })
  const tamperAt = frame.bytes.length - AUTH_TAG_BYTES - 1
  frame.bytes[tamperAt] = (frame.bytes[tamperAt] ?? 0) ^ 0x01
  const opened = openFrame({
    header: parseFrame(frame.bytes),
    key: result.hostSession.keys.clientToServer,
    nonceBase: result.hostSession.clientNonceBase,
    replay: new ReplayWindow(),
  })
  assert.equal(opened.ok, false)
  assert.equal(opened.ok ? '' : opened.code, ErrorCode.DecryptFailed)
})

test('伪造宿主签名会被客户端拒绝（防中间人）', async () => {
  const result = await runHandshake({ tamperSignature: true })
  assert.equal(result.failed, true)
})

test('宿主身份密钥变化会被已固定指纹的客户端拒绝（TOFU）', async () => {
  // 先正常配对一次以获得固定指纹
  const first = await runHandshake({ pinHostKey: true })
  assert.equal(first.failed, false)
  if (first.failed) return

  // 换一对宿主密钥，但客户端仍固定旧指纹
  const hostSigning = generateP256KeyPair()
  const deviceKey = generateX25519KeyPair()
  const deviceSigning = generateP256KeyPair()
  const deviceId = 'dev-test-0001'
  const credentials: HostDeviceCredentials = {
    deviceId,
    devicePublicKey: deviceKey.publicKey,
    deviceSigningKey: deviceSigning.publicKey,
    fingerprint: fingerprint(deviceSigning.publicKey),
    capabilities: DEFAULT_CAPABILITIES,
    authorization: 'persistent',
  }
  const host = new HostHandshake({
    hostId: 'host-test-0001',
    hostSigningKey: hostSigning,
    resolveDevice: () => credentials,
  })
  const client = new ClientHandshake({
    deviceId,
    deviceKey,
    deviceSigningKey: deviceSigning,
    pinnedHostSigningKey: first.hostSigning.publicKey,
  })
  const hello = mustSend(client.start()) as ClientHelloPayload
  const serverHello = mustSend(await host.acceptClientHello(hello)) as ServerHelloPayload
  const outcome = client.acceptServerHello(serverHello)
  assert.equal(outcome.kind, 'fail')
  assert.equal(outcome.kind === 'fail' ? outcome.code : '', ErrorCode.HandshakeSignature)
})

test('未知设备与未配对票据被拒绝', async () => {
  const hostSigning = generateP256KeyPair()
  const deviceKey = generateX25519KeyPair()
  const deviceSigning = generateP256KeyPair()

  const host = new HostHandshake({
    hostId: 'host-x',
    hostSigningKey: hostSigning,
    resolveDevice: () => undefined,
  })
  const client = new ClientHandshake({ deviceId: 'dev-unknown', deviceKey, deviceSigningKey: deviceSigning })
  const hello = mustSend(client.start()) as ClientHelloPayload
  const outcome = await host.acceptClientHello(hello)
  assert.equal(outcome.kind, 'fail')
  assert.equal(outcome.kind === 'fail' ? outcome.code : '', ErrorCode.DeviceUnknown)

  // 带票据时应报告"等待人工确认"而不是"未知设备"
  const host2 = new HostHandshake({ hostId: 'host-x', hostSigningKey: hostSigning, resolveDevice: () => undefined })
  const client2 = new ClientHandshake({
    deviceId: 'dev-new',
    deviceKey,
    deviceSigningKey: deviceSigning,
    pairingTicket: 'ticket-abc',
  })
  const hello2 = mustSend(client2.start()) as ClientHelloPayload
  const outcome2 = await host2.acceptClientHello(hello2)
  assert.equal(outcome2.kind === 'fail' ? outcome2.code : '', ErrorCode.PairingPending)
})

test('协议版本不匹配时双方都明确拒绝', async () => {
  const hostSigning = generateP256KeyPair()
  const deviceKey = generateX25519KeyPair()
  const deviceSigning = generateP256KeyPair()
  const host = new HostHandshake({ hostId: 'h', hostSigningKey: hostSigning, resolveDevice: () => undefined })
  const outcome = await host.acceptClientHello({
    protocolVersion: 999,
    deviceId: 'dev',
    ephemeralPublicKey: deviceKey.publicKey,
    clientNonce: toB64(Buffer.alloc(32, 1)),
  })
  assert.equal(outcome.kind === 'fail' ? outcome.code : '', ErrorCode.ProtocolVersion)
})

test('篡改客户端确认 MAC 会被宿主拒绝', async () => {
  const result = await runHandshake({ tamperConfirm: true })
  assert.equal(result.failed, true)
})

test('请求的能力位不会超过宿主策略（能力下调）', async () => {
  const result = await runHandshake({
    requestedCapabilities: { fsRead: true, fsWrite: true, fsShell: true },
    grantCapabilities: { fsRead: true, fsWrite: false, fsShell: false, phoneFs: false, phoneControl: false },
  })
  assert.equal(result.failed, false)
  if (result.failed) return
  assert.equal(result.clientSession.capabilities.fsWrite, false)
  assert.equal(result.clientSession.capabilities.fsShell, false)
  assert.equal(result.hostSession.capabilities.fsWrite, false)
})

test('指纹格式化稳定（人工比对用）', () => {
  const key = generateX25519KeyPair()
  const fp = fingerprint(key.publicKey)
  assert.equal(fp.length, 32)
  const formatted = formatFingerprint(fp)
  assert.match(formatted, /^[0-9A-F]{4}(-[0-9A-F]{4})+$/)
  assert.equal(formatted.replace(/-/g, '').toLowerCase(), fp)
})

// ─────────────────── ECDSA P-256 签名格式（DER ↔ raw）───────────────────
// 为什么必须单独测：浏览器 WebCrypto 与 Dart 都用 raw 64 字节（r‖s），
// 而 Node 的 crypto.sign 对 EC 密钥默认输出 DER。两端格式不一致会导致
// "签名永远验不过"，且长度差异这一线索很容易被忽略。

test('签名输出为 raw 64 字节，且能被自身验签', () => {
  const key = generateP256KeyPair()
  const message = Buffer.from('dsh-mobile transcript', 'utf8')
  const signature = signRaw(key.privateKey, message)
  assert.equal(signature.length, 64, '签名必须是 raw r‖s 共 64 字节')
  assert.equal(verifyRaw(key.publicKey, message, signature), true)
  assert.equal(verifyRaw(key.publicKey, Buffer.from('tampered', 'utf8'), signature), false, '篡改消息必须验签失败')
})

test('DER ↔ raw 签名互转可往返', () => {
  const key = generateP256KeyPair()
  for (let i = 0; i < 32; i++) {
    const message = Buffer.from(`msg-${i}`, 'utf8')
    const raw = signRaw(key.privateKey, message)
    const der = rawToDerSignature(raw)
    const back = derToRawSignature(der)
    assert.equal(back.length, 64)
    assert.ok(back.equals(raw), `第 ${i} 次往返必须完全一致`)
    // 用 Node 原生 DER 验签路径校验转换正确性
    assert.equal(verifyRaw(key.publicKey, message, back), true)
  }
})

test('公钥是 65 字节未压缩点，指纹稳定', () => {
  const key = generateP256KeyPair()
  const raw = fromB64(key.publicKey)
  assert.equal(raw.length, 65, 'P-256 未压缩公钥必须是 65 字节')
  assert.equal(raw[0], 0x04, '未压缩点必须以 0x04 开头')
  assert.equal(fingerprint(key.publicKey).length, 32)
})

test('拒绝长度错误的签名（防止 DER/raw 混用被静默接受）', () => {
  const key = generateP256KeyPair()
  const message = Buffer.from('m', 'utf8')
  const raw = signRaw(key.privateKey, message)
  // DER 形式约 70~72 字节：必须被判为无效，而不是"勉强验证"
  const der = rawToDerSignature(raw)
  assert.notEqual(der.length, 64)
  assert.equal(verifyRaw(key.publicKey, message, der), false)
  assert.equal(verifyRaw(key.publicKey, message, raw.subarray(0, 63)), false)
})
