/**
 * 自签 TLS 材料的**纯逻辑 + 落地管理**（从 `scripts/make-cert.mjs` 抽出来的那一半）。
 *
 * ## 为什么抽成宿主侧模块
 *
 * 生成证书这件事原先**只存在于一个脚本里**（`scripts/make-cert.mjs`），于是：
 *   · 插件首启时**没有证书可用**——必须先跑一次脚本（换机 7 步里的第 2 步）；
 *   · 脚本是一份**手写的 ASN.1 DER**（零依赖，本项目刻意不引 `selfsigned`/`node-forge`），
 *     逻辑只能手抄，抄漏一处就是"证书看起来正常、某个扩展静默失效"。
 * 抽到插件里之后：**首启缺就生成、有就复用**，脚本退回成一个薄薄的 CLI（打印与退出码），
 * 两份实现的风险彻底消失（与 `build-lib.mjs` 那条"lib 必须由 src 生成"同一个道理）。
 *
 * ## 为什么"不依赖 SAN"（这是刻意的设计，不是遗漏）
 *
 * 原生外壳（`native/android`）用的是**内嵌 CA 固定**：它对本机站点复验链时看的是
 * "签发者是不是我内置的那张 CA"，**不看 SAN**（见 `09-原生外壳方案.md`）。
 * 所以换 IP 不必重签、手机上的信任也不会作废——这正是"长期 CA + 短期叶子"要买到的东西。
 *
 * SAN 仍然**尽力写**（IP + 本机 hostname）：它只对**浏览器**那一半有用
 * （Chrome 对 `https://<IP>` 仍要求 SAN 命中，否则即使 CA 已装进系统信任库也报
 * `ERR_CERT_COMMON_NAME_INVALID`）。`start-lan.sh` 原先也在做同一件事
 * （`--print --cert` 里 grep 当前 IP，不在就重签叶子）——现在这套判据只有一处实现。
 *
 * ## 失败**绝不静默**
 *
 * 证书生成失败（目录不可写、磁盘满、时钟异常）时 `ensureTlsMaterial` **不抛错**，
 * 而是返回 `ok: false` + `error`，由调用方写进 `/mobile/manifest` 与
 * `/mobile/admin/selfcheck`。理由：插件加载期抛错会把整个 DSH 带下去，
 * 而"没有证书"只是一条明确可恢复的降级——它必须**被说出来**，而不是变成
 * "手机打开一片白"这种查不出原因的症状。
 */

import { createPrivateKey, generateKeyPairSync, randomBytes, sign, X509Certificate } from 'node:crypto'
import type { KeyObject } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { localHostNames } from './lan-trust.ts'

// ── 极简 ASN.1 DER 编码 ─────────────────────────────────────────────────
// DER 核心是"标签 + 长度 + 内容"；长度 <128 用单字节，否则长形式。

function derLength(length: number): Buffer {
  if (length < 0x80) return Buffer.from([length])
  const bytes: number[] = []
  let rest = length
  while (rest > 0) {
    bytes.unshift(rest & 0xff)
    rest >>= 8
  }
  return Buffer.from([0x80 | bytes.length, ...bytes])
}

function tlv(tag: number, content: Buffer | number[]): Buffer {
  const body = Buffer.isBuffer(content) ? content : Buffer.from(content)
  return Buffer.concat([Buffer.from([tag]), derLength(body.length), body])
}

const der = {
  seq: (...parts: Buffer[]): Buffer => tlv(0x30, Buffer.concat(parts)),
  set: (...parts: Buffer[]): Buffer => tlv(0x31, Buffer.concat(parts)),
  oid: (dotted: string): Buffer => {
    const parts = dotted.split('.').map(Number)
    const first = 40 * (parts[0] ?? 0) + (parts[1] ?? 0)
    const rest: number[] = []
    for (const value of parts.slice(2)) {
      const chunk: number[] = []
      let v = value
      do {
        chunk.unshift(v & 0x7f)
        v >>= 7
      } while (v > 0)
      for (let i = 0; i < chunk.length - 1; i++) chunk[i] = (chunk[i] ?? 0) | 0x80
      rest.push(...chunk)
    }
    return tlv(0x06, Buffer.from([first, ...rest]))
  },
  int: (value: number): Buffer => {
    const bytes: number[] = []
    let v = value
    do {
      bytes.unshift(v & 0xff)
      v >>= 8
    } while (v > 0)
    if (((bytes[0] ?? 0) & 0x80) !== 0) bytes.unshift(0)
    return tlv(0x02, Buffer.from(bytes))
  },
  bool: (value: boolean): Buffer => tlv(0x01, Buffer.from([value ? 0xff : 0x00])),
  octet: (content: Buffer): Buffer => tlv(0x04, content),
  /** BIT STRING：首字节 = 末尾未使用位数 */
  bit: (content: Buffer, unusedBits = 0): Buffer => tlv(0x03, Buffer.concat([Buffer.from([unusedBits]), content])),
  utf8: (text: string): Buffer => tlv(0x0c, Buffer.from(text, 'utf8')),
  /**
   * DNS 名（GeneralName 的 dNSName = [2] 隐式 IA5String → 原始标签 `0x82`）。
   *
   * ⚠️ 这里**不能**用 IA5String 的通用标签 `0x16`：实测那样写会让**整个 SAN 失效**
   * （openssl 显示成一串乱码、Node 的 `X509Certificate.subjectAltName` 直接变 undefined），
   * 而证书其它部分看起来完全正常——极其难查。
   */
  dnsName: (text: string): Buffer => tlv(0x82, Buffer.from(text, 'ascii')),
  utc: (date: Date): Buffer =>
    tlv(0x17, Buffer.from(`${date.toISOString().replace(/[-:T]/g, '').slice(2, 14)}Z`, 'ascii')),
  /**
   * 显式上下文标签（**构造形式**，0xA0 | n）。
   *
   * 用错形式会直接报 `explicit tag not constructed`：DER 里"显式包装"
   * （如 version 的 [0]、extensions 的 [3]）必须用 constructed 位。
   */
  explicit: (tagNumber: number, content: Buffer): Buffer => tlv(0xa0 | tagNumber, content),
  /** [7] IP 地址（RFC 5280 的 GeneralName 形式：隐式标签 7 + 4 字节） */
  ip: (address: string): Buffer => tlv(0x87, Buffer.from(address.split('.').map(Number))),
  /** Extension ::= SEQUENCE { extnID, critical BOOLEAN DEFAULT FALSE, extnValue OCTET STRING } */
  ext: (oid: string, critical: boolean, value: Buffer): Buffer =>
    der.seq(der.oid(oid), ...(critical ? [der.bool(true)] : []), der.octet(value)),
}

const OID = {
  atCommonName: '2.5.4.3',
  ecdsaWithSha256: '1.2.840.10045.4.3.2',
  basicConstraints: '2.5.29.19',
  keyUsage: '2.5.29.15',
  extKeyUsage: '2.5.29.37',
  subjectAltName: '2.5.29.17',
  serverAuth: '1.3.6.1.5.5.7.3.1',
} as const

/** X.509 Name（只写 CN——够用，且安卓装 CA 时认的就是它）。 */
function name(commonName: string): Buffer {
  return der.seq(der.set(der.seq(der.oid(OID.atCommonName), der.utf8(commonName))))
}

/** `buildCert` 的入参。 */
interface BuildCertOptions {
  readonly commonName: string
  readonly issuerName: string
  /** 签名者私钥：自签时 == 被签发者私钥，由 CA 签发时是 **CA 的**私钥。 */
  readonly signerKey: KeyObject
  /** 被签发者的公钥（由它算出 SPKI 写进证书）。 */
  readonly publicKey: KeyObject
  readonly ip: string
  readonly dnsNames: readonly string[]
  readonly days: number
  readonly isCa: boolean
}

/**
 * 造一张证书（自签，或由给定 CA 签发）。
 *
 * `keyUsage` 的 BIT STRING 里 bit0 是**最高位**：
 *   · 服务器证书：digitalSignature(0) + keyEncipherment(2) → 0xA0，3 位有效 → 5 位未用；
 *   · CA：keyCertSign(5) + cRLSign(6) → 0x06，7 位有效 → 1 位未用
 *     （安卓把 CA 装进信任库时**会检查 keyCertSign**，少了它装不上）。
 */
function buildCert(options: BuildCertOptions): { certPem: string; keyPem: string } {
  const notBefore = new Date(Date.now() - 24 * 60 * 60 * 1000) // 回拨一天，容忍手机时钟偏差
  const notAfter = new Date(Date.now() + options.days * 24 * 60 * 60 * 1000)
  const serial = randomBytes(8).readUInt32BE(0) & 0x7fffffff
  const algorithm = der.seq(der.oid(OID.ecdsaWithSha256)) // 无参数（ECDSA 的 AlgorithmIdentifier 不带 NULL）
  const spki = options.publicKey.export({ type: 'spki', format: 'der' })
  const keyUsage = options.isCa ? der.bit(Buffer.from([0x06]), 1) : der.bit(Buffer.from([0xa0]), 5)
  const san = der.seq(der.ip(options.ip), ...options.dnsNames.map((d) => der.dnsName(d)))
  const extensions = der.explicit(
    3,
    der.seq(
      der.ext(OID.basicConstraints, true, der.seq(der.bool(options.isCa))),
      der.ext(OID.keyUsage, true, keyUsage),
      ...(options.isCa ? [] : [der.ext(OID.extKeyUsage, false, der.seq(der.oid(OID.serverAuth)))]),
      ...(options.isCa ? [] : [der.ext(OID.subjectAltName, false, san)]),
    ),
  )

  const tbs = der.seq(
    der.explicit(0, der.int(2)), // version v3（显式 [0]，构造形式）
    der.int(serial),
    algorithm,
    name(options.issuerName), // issuer（自签时 == subject）
    der.seq(der.utc(notBefore), der.utc(notAfter)),
    name(options.commonName), // subject
    spki,
    extensions,
  )

  // 注：这里**必须**用 options.signerKey 而不是 options.publicKey——由 CA 签发时
  // 签名者是 CA 的私钥，而公钥是被签发者的（两者不是一对，这正是签发的含义）。
  const signature = sign('sha256', tbs, options.signerKey)
  const certificate = der.seq(tbs, algorithm, der.bit(signature))
  const certPem = `-----BEGIN CERTIFICATE-----\n${certificate
    .toString('base64')
    .replace(/(.{64})/g, '$1\n')
    .trim()}\n-----END CERTIFICATE-----\n`
  return { certPem, keyPem: '' }
}

/**
 * 导出私钥 PEM。
 *
 * 为什么需要一层壳：`KeyObject.export({ format: 'pem' })` 的返回类型是
 * `string | Buffer`（TS 不会按 `format` 收窄），直接赋值给 `string` 会编译失败。
 * 这里收一次窄，三处调用就都不用各自 `as` 了。
 */
function exportKeyPem(privateKey: KeyObject): string {
  return privateKey.export({ type: 'pkcs8', format: 'pem' }) as string
}

/** 生成一张自签证书（CA:TRUE——历史形态，保留给测试与一次性场景）。 */
export function makeSelfSignedCert(
  options: { ip?: string; dns?: readonly string[]; days?: number; commonName?: string } = {},
): { certPem: string; keyPem: string } {
  const days = options.days ?? 825
  const ip = options.ip ?? '127.0.0.1'
  const dnsNames = options.dns ?? ['localhost']
  const commonName = options.commonName ?? ip
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const keyPem = exportKeyPem(privateKey)
  const built = buildCert({
    commonName,
    issuerName: commonName,
    signerKey: privateKey,
    publicKey,
    ip,
    dnsNames,
    days,
    isCa: true,
  })
  return { certPem: built.certPem, keyPem }
}

/** 长期本机 CA：CA:TRUE、keyCertSign（安卓装信任库时必须）。默认 10 年。 */
export function makeCaCert(options: { commonName?: string; days?: number } = {}): { certPem: string; keyPem: string } {
  const commonName = options.commonName ?? 'dsh-mobile local CA'
  const days = options.days ?? 3650
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const keyPem = exportKeyPem(privateKey)
  const built = buildCert({
    commonName,
    issuerName: commonName,
    signerKey: privateKey,
    publicKey,
    ip: '127.0.0.1',
    dnsNames: ['localhost'],
    days,
    isCa: true,
  })
  return { certPem: built.certPem, keyPem }
}

/** 由 CA 签发的服务器证书（IP/DNS 尽力写进 SAN；壳不看 SAN，浏览器看）。 */
export function makeSignedCert(options: {
  caCertPem: string
  caKeyPem: string
  ip: string
  dns?: readonly string[]
  days?: number
}): { certPem: string; keyPem: string } {
  const caKey = createPrivateKey(options.caKeyPem)
  /**
   * ★ issuer 字段要的是 CA 的**名字值**，不是 Node 格式化后的整串——
   *   `X509Certificate.subject` 已经是 `CN=dsh-mobile local CA`，再交给 `name()` 拼一次
   *   就变成 `CN=CN=dsh-mobile local CA`，于是**叶子证书的 issuer 与 CA 的 subject 不相等**
   *   → 客户端验链直接失败（本轮真生成了这么一张，靠打印"签发者"那一行才看出来）。
   */
  const caSubjectText = new X509Certificate(options.caCertPem).subject
  const caCnLine = caSubjectText
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.startsWith('CN='))
  const caName = caCnLine === undefined ? caSubjectText.split('\n').join(', ') : caCnLine.slice(3)
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const keyPem = exportKeyPem(privateKey)
  const built = buildCert({
    commonName: options.ip,
    issuerName: caName,
    signerKey: caKey,
    publicKey,
    ip: options.ip,
    dnsNames: options.dns ?? ['localhost'],
    days: options.days ?? 825,
    isCa: false,
  })
  return { certPem: built.certPem, keyPem }
}

// ── 落地管理 ───────────────────────────────────────────────────────────

/** TLS 材料在磁盘上的四个文件。 */
export interface TlsPaths {
  readonly directory: string
  readonly caCert: string
  readonly caKey: string
  readonly serverCert: string
  readonly serverKey: string
}

/** 证书状态（**每一次调用都重新算**，供 manifest / 自检读取）。 */
export interface TlsStatus {
  /** 四个文件是否齐备且可解析。 */
  readonly ok: boolean
  readonly directory: string
  readonly paths: TlsPaths
  /** 本次调用是否新建了 CA / 服务器证书 / 重签了叶子。 */
  readonly createdCa: boolean
  readonly createdServer: boolean
  readonly resignedServer: boolean
  readonly caFingerprint?: string
  readonly serverFingerprint?: string
  readonly serverSubjectAltName?: string
  readonly caNotAfter?: string
  readonly serverNotAfter?: string
  /** ok=false 时的原因（**必须被说出来**，不许静默）。 */
  readonly error?: string
  readonly checkedAt: string
}

/** 由目录推出四个文件路径（**唯一一处**拼文件名的地方）。 */
export function tlsPaths(directory: string): TlsPaths {
  return {
    directory,
    caCert: join(directory, 'lan-ca.pem'),
    caKey: join(directory, 'lan-ca-key.pem'),
    serverCert: join(directory, 'lan-cert.pem'),
    serverKey: join(directory, 'lan-key.pem'),
  }
}

/** 证书指纹（SHA-256，冒号十六进制）——与安卓 `check-apk` 里比对的是同一种写法。 */
function certFingerprint(certPem: string): string | undefined {
  try {
    return new X509Certificate(certPem).fingerprint256
  } catch {
    return undefined
  }
}

/**
 * 现有服务器证书的 SAN 是否**覆盖全部**要写的地址与名字。
 *
 * ★ 必须用 `every`（全部覆盖）而不是 `some`（任一覆盖）：`dnsNames` 里永远有
 *   `localhost`，用 `some` 的话"IP 变了"这件事会被 `localhost` 一直遮住 ⇒
 *   换网之后永远不重签，浏览器报证书名不匹配而自检说"一切正常"。
 *   （这条正是第一版写错、被 `tls-cert.test.ts` 里"地址变了"那条用例抓住的。）
 */
function sanCovers(certPem: string, addresses: readonly string[], dnsNames: readonly string[]): boolean {
  let san: string | undefined
  try {
    san = new X509Certificate(certPem).subjectAltName
  } catch {
    return false
  }
  if (san === undefined) return false
  const covers = (value: string): boolean => {
    if (value === '') return true
    // IP 与 DNS 用各自的 GeneralName 前缀判，避免"DNS 名里恰好含这段数字"这类误判
    const isIp = value.includes(':') || /^\d{1,3}(\.\d{1,3}){3}$/.test(value)
    return isIp ? san!.includes(`IP Address:${value}`) : san!.includes(`DNS:${value}`)
  }
  return addresses.every(covers) && dnsNames.every(covers)
}

/**
 * 现有叶子是不是**由这张 CA 签发**的（真验签，不是比名字）。
 *
 * ★ 为什么不能用 issuer/subject 文本比较：CN 是个常量（`dsh-mobile local CA`），
 *   重新生成一张 CA 之后它的 subject **文本一模一样** ⇒ 文本比较会给出"还是一对"的
 *   错误结论，于是拿着旧叶子去配新 CA、服务出去的链验不过，而自检说"正常"。
 *   `X509Certificate.verify(ca.publicKey)` 用公钥真验一次签名，这才是"是不是一对"。
 */
function leafSignedBy(leafPem: string, caPem: string): boolean {
  if (leafPem === '') return false
  try {
    const leaf = new X509Certificate(leafPem)
    const ca = new X509Certificate(caPem)
    return leaf.verify(ca.publicKey)
  } catch {
    return false
  }
}

/** 现有叶子是否已过期（`verify()` 只看签名、不看有效期，所以必须单独判）。 */
function leafExpired(leafPem: string, now = Date.now()): boolean {
  try {
    const leaf = new X509Certificate(leafPem)
    return Date.parse(leaf.validTo) <= now
  } catch {
    return true
  }
}

/** 一次 `ensureTlsMaterial` 的入参。 */
export interface EnsureTlsOptions {
  readonly directory: string
  /** 服务器证书 SAN 要写的地址（通常是本机非内部 IPv4）；缺失则只写 hostname。 */
  readonly addresses?: readonly string[]
  /** SAN 要写的 DNS 名；缺失时用本机 hostname + localhost + dsh.local。 */
  readonly dnsNames?: readonly string[]
  readonly caDays?: number
  readonly serverDays?: number
}

/**
 * **缺就生成、有就复用**（幂等；可在每次启动时调用）。
 *
 * 复用的粒度：
 *   · CA（`lan-ca.pem` / `lan-ca-key.pem`）：**一旦存在就永不重生成**——
 *     换 CA 等于把手机上已经建立的信任作废一次（这是"Google 突然不提供安装"的根因）；
 *   · 服务器证书：存在且 SAN 覆盖到当前地址/名字时复用；否则**用同一张 CA 重签叶子**
 *     （手机信任不受影响，只是浏览器侧的 SAN 重新对齐）。
 *     这一条与 `start-lan.sh` 里原有的行为一致，只是把判据收到一处。
 *
 * 任何异常都收敛成 `ok: false` + `error`，**不抛错**（理由见文件头）。
 */
export function ensureTlsMaterial(options: EnsureTlsOptions): TlsStatus {
  const paths = tlsPaths(options.directory)
  const addresses = (options.addresses ?? []).filter((value) => value.length > 0)
  const dnsNames = options.dnsNames ?? [...localHostNames(), 'localhost', 'dsh.local']
  const base = { directory: options.directory, paths, checkedAt: new Date().toISOString() }
  let createdCa = false
  let createdServer = false
  let resignedServer = false

  try {
    mkdirSync(options.directory, { recursive: true })

    let caCertPem: string
    let caKeyPem: string
    /**
     * 复用前必须**解析得动**才叫"有 CA"。
     *
     * 文件存在但内容坏了（写盘被打断、被手工替换、被截断）时若直接复用，
     * 就会拿着一段非证书文本去签叶子 —— 那一步会抛错，整条 ensure 变成 `ok:false`，
     * 而自检只会说"证书不可用"，不说"文件坏了、重生成即可"。
     * 这里把"坏 CA"归到"缺 CA"那一侧：**重生成**（`createdCa: true` 会被报出来，
     * cordis 的日志与自检都会说"新建了 CA，手机需重装一次根证书"——不静默）。
     */
    const caUsable =
      existsSync(paths.caCert) && existsSync(paths.caKey) && parseCertPem(safeRead(paths.caCert)) !== undefined
    if (caUsable) {
      caCertPem = readFileSync(paths.caCert, 'utf8')
      caKeyPem = readFileSync(paths.caKey, 'utf8')
    } else {
      const ca = makeCaCert(options.caDays === undefined ? {} : { days: options.caDays })
      caCertPem = ca.certPem
      caKeyPem = ca.keyPem
      writeFileSync(paths.caCert, caCertPem, { mode: 0o644 })
      writeFileSync(paths.caKey, caKeyPem, { mode: 0o600 })
      createdCa = true
    }

    /**
     * 什么时候需要（重新）签叶子：
     *   ① 文件缺一个 → 必须签；
     *   ② SAN **不是全部覆盖**当前地址/名字 → 浏览器会报证书名不匹配
     *      （壳不看 SAN，但没必要放着；必须"全部覆盖"而不是"任一覆盖"，
     *      否则 `localhost` 会一直遮住"IP 变了"这件事）；
     *   ③ **现有叶子不是由现在这张 CA 签发**（真验签）→ 链已经断了
     *      （手工换过 CA、或半截文件），此时"文件都在"是假象，served 出去的链验不过；
     *   ④ 叶子已过期 → 重签（`verify()` 只看签名、不看有效期）。
     * ②③④ 都只重签叶子，**CA 不动** ⇒ 手机上已建立的信任不受影响。
     */
    const existingLeaf = safeRead(paths.serverCert)
    const needSign =
      !existsSync(paths.serverCert) ||
      !existsSync(paths.serverKey) ||
      !leafSignedBy(existingLeaf, caCertPem) ||
      leafExpired(existingLeaf) ||
      !sanCovers(existingLeaf, addresses, dnsNames)
    if (needSign) {
      const existed = existsSync(paths.serverCert) && existsSync(paths.serverKey)
      const leafIp = addresses[0] ?? '127.0.0.1'
      const leaf = makeSignedCert({
        caCertPem,
        caKeyPem,
        ip: leafIp,
        dns: dnsNames,
        ...(options.serverDays === undefined ? {} : { days: options.serverDays }),
      })
      writeFileSync(paths.serverCert, leaf.certPem, { mode: 0o644 })
      writeFileSync(paths.serverKey, leaf.keyPem, { mode: 0o600 })
      createdServer = !existed
      resignedServer = existed
    }

    const caPem = readFileSync(paths.caCert, 'utf8')
    const serverPem = readFileSync(paths.serverCert, 'utf8')
    const parsedCa = new X509Certificate(caPem)
    const parsedServer = new X509Certificate(serverPem)
    return {
      ok: true,
      ...base,
      createdCa,
      createdServer,
      resignedServer,
      caFingerprint: certFingerprint(caPem) ?? parsedCa.fingerprint256,
      serverFingerprint: certFingerprint(serverPem) ?? parsedServer.fingerprint256,
      ...(parsedServer.subjectAltName === undefined ? {} : { serverSubjectAltName: parsedServer.subjectAltName }),
      caNotAfter: parsedCa.validTo,
      serverNotAfter: parsedServer.validTo,
    }
  } catch (error) {
    return {
      ok: false,
      ...base,
      createdCa,
      createdServer,
      resignedServer,
      error: error instanceof Error ? `${error.message}` : String(error),
    }
  }
}

/** 读文件，失败返回空串（只在"判断 SAN 覆盖"这种尽力而为的路径上用）。 */
function safeRead(file: string): string {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

/** 解析 PEM；解析不了返回 undefined（**不抛错**——调用方要的是"能不能用"这个判断）。 */
function parseCertPem(pem: string): X509Certificate | undefined {
  if (pem === '') return undefined
  try {
    return new X509Certificate(pem)
  } catch {
    return undefined
  }
}

/** 证书管理器的对外面（由 `cordis.ts` 建一个、注入给宿主）。 */
export interface TlsManager {
  readonly paths: TlsPaths
  /** 跑一次"缺就生成、有就复用"，返回并记住结果。 */
  ensure(): TlsStatus
  /** 读上一次的结果；还没跑过则先跑一次。 */
  status(): TlsStatus
  /** 读 CA 的 PEM（`/mobile/trust.crt` 用）；读不到返回 undefined。 */
  readCaPem(): string | undefined
}

/** 建一个证书管理器。`addresses`/`dnsNames` 传函数 ⇒ **每次 ensure 都按当时网卡现算**。 */
export function createTlsManager(options: {
  readonly directory: string
  readonly addresses?: () => readonly string[]
  readonly dnsNames?: () => readonly string[]
  readonly caDays?: number
  readonly serverDays?: number
  readonly onResult?: (status: TlsStatus) => void
}): TlsManager {
  const paths = tlsPaths(options.directory)
  let last: TlsStatus | undefined
  const run = (): TlsStatus => {
    const status = ensureTlsMaterial({
      directory: options.directory,
      ...(options.addresses === undefined ? {} : { addresses: safeCall(options.addresses) }),
      ...(options.dnsNames === undefined ? {} : { dnsNames: safeCall(options.dnsNames) }),
      ...(options.caDays === undefined ? {} : { caDays: options.caDays }),
      ...(options.serverDays === undefined ? {} : { serverDays: options.serverDays }),
    })
    last = status
    options.onResult?.(status)
    return status
  }
  return {
    paths,
    ensure: run,
    status: () => last ?? run(),
    readCaPem: () => {
      const pem = safeRead(paths.caCert)
      return pem === '' ? undefined : pem
    },
  }
}

/** 调用一个"取值函数"，抛错就当没取到（推导失败必须降级而不是把插件带下去）。 */
function safeCall<T>(fn: () => readonly T[]): readonly T[] {
  try {
    return fn()
  } catch {
    return []
  }
}
