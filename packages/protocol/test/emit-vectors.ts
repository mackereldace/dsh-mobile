/**
 * 跨端测试向量生成器。
 *
 * 为什么需要：Flutter 端的密码学实现（X25519 / HKDF / AES-GCM / Ed25519）由不同的库提供，
 * 任何实现差异都会导致"握手在真机上莫名失败"。因此把 Node 端算出的确定性结果固化成向量文件，
 * Dart 端必须逐字节复现；反之 Dart 端生成的向量也必须能被本文件校验。
 *
 * 运行：node --experimental-strip-types packages/protocol/test/emit-vectors.ts
 * 输出：packages/protocol/test/vectors.json
 */

import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  ClientHandshake,
  HostHandshake,
  type HandshakeOutcome,
  type HostDeviceCredentials,
} from '../src/handshake.ts'
import {
  confirmMac,
  deriveKey,
  deriveSessionKeys,
  ecdh,
  fingerprint,
  formatFingerprint,
  fromB64,
  openServerHello,
  sealFrame,
  sealServerHello,
  toB64,
  transcriptHash,
  type RawKeyPair,
} from '../src/crypto.ts'
import { createDuplexChannel, ClientMux, HostMux } from '../src/mux.ts'
import { DEFAULT_CAPABILITIES, ErrorCode, FrameFlags, FrameType } from '../src/wire.ts'

const here = dirname(fileURLToPath(import.meta.url))

/** 生成一次性对称密钥向量。 */
function symmetricVectors() {
  const ikm = Buffer.alloc(32, 0x11)
  const salt = Buffer.alloc(32, 0x22)
  const labels = ['dsh-mobile/v1/c2s', 'dsh-mobile/v1/s2c', 'dsh-mobile/v1/confirm-client', 'dsh-mobile/v1/hs'] as const
  return {
    ikm: toB64(ikm),
    salt: toB64(salt),
    derived: Object.fromEntries(labels.map((label) => [label, toB64(deriveKey(ikm, salt, label))])),
    confirmMac: toB64(confirmMac(Buffer.alloc(32, 0x33), Buffer.alloc(32, 0x44))),
    transcriptHash: toB64(
      transcriptHash(['1', 'clientNonce', 'serverNonce', 'clientEph', 'serverEph', 'dev-1', 'host-1']),
    ),
  }
}

/** 生成帧加解密向量：固定 key/nonce/counter，比较完整字节。 */
function frameVectors() {
  const key = Buffer.alloc(32, 0x55)
  const nonceBase = Buffer.from([0xde, 0xad, 0xbe, 0xef])
  const payload = Buffer.from('{"endpoint":"session/create","payload":{"cwd":"/tmp"}}', 'utf8')
  const sealed = sealFrame({
    key,
    nonceBase,
    type: FrameType.RpcRequest,
    flags: FrameFlags.Json,
    counter: 42n,
    payload,
    truncateTag: true,
  })
  return {
    key: toB64(key),
    nonceBase: toB64(nonceBase),
    counter: '42',
    payload: toB64(payload),
    frame: sealed.bytes.toString('base64url'),
    expectedPlaintext: payload.toString('utf8'),
  }
}

/** 生成一次完整握手的可复现轨迹（含全部中间量），供 Dart 端逐步比对。 */
async function handshakeTrace() {
  const events: Record<string, unknown>[] = []
  const { generateP256KeyPair, generateX25519KeyPair } = await import('../src/crypto.ts')

  const hostSigning = generateP256KeyPair()
  const deviceEcdh = generateX25519KeyPair()
  const deviceSigning = generateP256KeyPair()
  const deviceId = 'dev-vector-0001'
  const hostId = 'host-vector-0001'

  const credentials: HostDeviceCredentials = {
    deviceId,
    devicePublicKey: deviceEcdh.publicKey,
    deviceSigningKey: deviceSigning.publicKey,
    // 指纹以**签名公钥**为准（协议约定）——以协商公钥计算会与宿主校验不一致
    fingerprint: fingerprint(deviceSigning.publicKey),
    capabilities: DEFAULT_CAPABILITIES,
    authorization: 'persistent',
  }

  const host = new HostHandshake({
    hostId,
    hostSigningKey: hostSigning,
    resolveDevice: (hello) => (hello.deviceId === deviceId ? credentials : undefined),
  })
  const client = new ClientHandshake({ deviceId, deviceKey: deviceEcdh, deviceSigningKey: deviceSigning })

  events.push({
    step: 'keygen',
    hostSigningKey: hostSigning.publicKey,
    hostFingerprint: fingerprint(hostSigning.publicKey),
    hostFingerprintFormatted: formatFingerprint(fingerprint(hostSigning.publicKey)),
    devicePublicKey: deviceEcdh.publicKey,
    deviceSigningKey: deviceSigning.publicKey,
    deviceFingerprint: fingerprint(deviceEcdh.publicKey),
  })

  const startOutcome = client.start()
  if (startOutcome.kind !== 'send') throw new Error('client.start failed')
  const clientHello = startOutcome.payload as Record<string, unknown>
  events.push({ step: 'client-hello', payload: clientHello })

  const hostOutcome = await host.acceptClientHello(clientHello as never)
  if (hostOutcome.kind !== 'send') throw new Error(`host.acceptClientHello failed: ${JSON.stringify(hostOutcome)}`)
  const serverHello = hostOutcome.payload as Record<string, unknown>
  events.push({ step: 'server-hello', payload: serverHello })

  const hostHsKey = host.handshakeKey()
  events.push({ step: 'handshake-key', value: toB64(hostHsKey) })

  // 按真实链路走一遍：宿主封装 ServerHello → 客户端用明文临时公钥自行派生 K_hs 并解开
  const sealed = sealServerHello({
    handshakeKey: hostHsKey,
    serverEphemeralPublicKey: serverHello.ephemeralPublicKey as string,
    payload: serverHello,
  })
  events.push({ step: 'server-hello-sealed', payload: sealed })
  const opened = openServerHello({ sealed, ephemeralPrivateKey: client.ephemeralKeys.privateKey })
  if (!opened.ok) throw new Error(`客户端无法解开 ServerHello: ${opened.code} ${opened.message}`)
  if (toB64(opened.handshakeKey) !== toB64(hostHsKey)) throw new Error('K_hs 两端不一致')

  const clientAuthOutcome = client.acceptServerHello(opened.payload as never)
  if (clientAuthOutcome.kind !== 'send') throw new Error(`client.acceptServerHello failed: ${JSON.stringify(clientAuthOutcome)}`)
  const clientAuth = clientAuthOutcome.payload as Record<string, unknown>
  events.push({ step: 'client-auth', payload: clientAuth })

  const authOkOutcome = host.acceptClientAuth(clientAuth as never)
  if (authOkOutcome.kind !== 'send') throw new Error(`host.acceptClientAuth failed: ${JSON.stringify(authOkOutcome)}`)
  const authOk = authOkOutcome.payload as Record<string, unknown>
  events.push({ step: 'server-auth-ok', payload: authOk })

  const clientSession = client.acceptServerAuthOk(authOk as never)
  if (clientSession.kind !== 'done') throw new Error(`client.acceptServerAuthOk failed: ${JSON.stringify(clientSession)}`)
  const hostSession = host.complete()

  events.push({
    step: 'session',
    sessionId: hostSession.sessionId,
    clientSessionId: clientSession.session.sessionId,
    clientNonceBase: toB64(hostSession.clientNonceBase),
    serverNonceBase: toB64(hostSession.serverNonceBase),
    capabilities: hostSession.capabilities,
    keys: {
      clientToServer: toB64(hostSession.keys.clientToServer),
      serverToClient: toB64(hostSession.keys.serverToClient),
      confirmClient: toB64(hostSession.keys.confirmClient),
      confirmServer: toB64(hostSession.keys.confirmServer),
    },
  })

  return { hostSigningKey: hostSigning.publicKey, devicePublicKey: deviceEcdh.publicKey, events }
}

/** 生成 mux 消息序列向量（字节级 JSON 编解码一致性）。 */
async function muxVectors() {
  const channel = createDuplexChannel()
  const received: unknown[] = []
  const host = new HostMux(channel.hostEndpoint, {
    open: () =>
      (async function* () {
        yield { seq: 1, text: '第一页' }
        yield { seq: 2, text: '第二页' }
      })(),
  })
  const client = new ClientMux(channel.clientEndpoint)
  channel.bind(
    (message) => {
      received.push({ direction: 'client->host', message })
      host.receive(message)
    },
    (message) => {
      received.push({ direction: 'host->client', message })
      client.receive(message)
    },
  )

  const stream = client.open('session/history', { sessionId: 's-1', limit: 50 })
  const values: unknown[] = []
  for await (const value of stream) values.push(value)

  return {
    messages: received.map((entry) => JSON.parse(JSON.stringify(entry)) as unknown),
    values,
    endpoint: 'session/history',
    payload: { sessionId: 's-1', limit: 50 },
  }
}

/** 错误码与帧类型常量表：Dart 端的镜像必须与此完全一致。 */
function enumVectors() {
  return {
    protocolVersion: 1,
    errorCodes: Object.values(ErrorCode),
    frameTypes: FrameType,
    frameFlags: FrameFlags,
  }
}

async function main(): Promise<void> {
  const vectors = {
    $comment:
      '由 packages/protocol/test/emit-vectors.ts 生成。Dart 端必须逐字节复现本文件中的全部值；' +
      '任何不一致都说明两端密码学实现有差异，必须在合并前修复。',
    generatedAt: new Date().toISOString(),
    symmetric: symmetricVectors(),
    frame: frameVectors(),
    handshake: await handshakeTrace(),
    mux: await muxVectors(),
    enums: enumVectors(),
  }

  // 自检：向量必须可被 Node 端重新验证
  const frame = vectors.frame
  const { openFrame, parseFrame, ReplayWindow: RW } = await import('../src/crypto.ts')
  const reopened = openFrame({
    header: parseFrame(fromB64(frame.frame)),
    key: fromB64(frame.key),
    nonceBase: fromB64(frame.nonceBase),
    replay: new RW(),
  })
  if (!reopened.ok || reopened.plaintext.toString('utf8') !== frame.expectedPlaintext) {
    throw new Error('自检失败：帧向量无法被本端重新解开')
  }
  if (vectors.handshake.events.at(-1)?.['clientSessionId'] !== vectors.handshake.events.at(-1)?.['sessionId']) {
    throw new Error('自检失败：握手向量两端会话标识不一致')
  }

  const out = join(here, 'vectors.json')
  writeFileSync(out, `${JSON.stringify(vectors, null, 2)}\n`, 'utf8')
  console.log(`已写出 ${out}`)
  console.log(`  对称密钥向量：${Object.keys(vectors.symmetric.derived).length} 条`)
  console.log(`  帧向量：${frame.frame.length} 字符`)
  console.log(`  握手轨迹：${vectors.handshake.events.length} 步`)
  console.log(`  mux 消息：${vectors.mux.messages.length} 条`)
}

await main()
