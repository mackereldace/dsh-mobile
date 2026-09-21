#!/usr/bin/env node
/**
 * 生成局域网用的自签证书（零依赖，手写 ASN.1 DER）+ 一个零依赖的 HTTPS 反代。
 *
 * ## 为什么必须上 HTTPS（这不是可选优化，是硬约束）
 *
 * 手机浏览器打开 `http://<局域网IP>:3081/...` 时页面**不是安全上下文**：
 * 实测 `window.isSecureContext === false`、`typeof crypto.subtle === 'undefined'`
 * （`crypto.getRandomValues` 倒是可用）。而本项目整个安全模型都建立在 WebCrypto 上
 * （P-256 设备密钥、X25519 协商、AES-GCM 加解密），于是手机上只看到一句
 * `Cannot read properties of undefined (reading 'generateKey')`。
 *
 * 浏览器的规则很硬：只有 `https://`（或 `http://localhost`）才是安全上下文。
 * 因此局域网 IP 的唯一出路是 HTTPS；自签证书需要用户在手机上接受一次警告
 * —— 这是所有同类局域网工具的通行做法。
 *
 * ## 为什么手写 DER 而不引依赖
 *
 * Node 只给签名原语，没有证书构造 API。可选：引 `selfsigned`/`node-forge`，或调 `openssl`。
 * 本项目至今**零运行时依赖**（协议包两端共用，浏览器端 boot.js 更是零依赖脚本），
 * 为一张开发用证书破坏这个性质不划算；DER 的长度前缀与结构都很小，可以自持并测试
 * （`--print` 会用 Node 的 X509Certificate + openssl 双向校验）。
 *
 * ## 证书内容（已按 RFC 5280 标准结构）
 *
 * - 自签、`basicConstraints: CA:TRUE`、有效期 825 天（Apple 上限）；
 * - `keyUsage`: digitalSignature | keyEncipherment；`extendedKeyUsage`: serverAuth；
 * - `subjectAltName` 同时写 **IP 与 DNS**（手机用 IP 或主机名访问都能过）。
 *
 * 用法：
 *   node scripts/make-cert.mjs --ip 10.34.221.181 [--out-dir <目录>]
 *   node scripts/make-cert.mjs --print --cert <cert.pem>
 */

import { createPrivateKey, generateKeyPairSync, randomBytes, sign, X509Certificate } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// ── 极简 ASN.1 DER 编码 ─────────────────────────────────────────────────
// DER 核心是"标签 + 长度 + 内容"；长度 <128 用单字节，否则长形式。

function derLength(length) {
  if (length < 0x80) return Buffer.from([length])
  const bytes = []
  let rest = length
  while (rest > 0) {
    bytes.unshift(rest & 0xff)
    rest >>= 8
  }
  return Buffer.from([0x80 | bytes.length, ...bytes])
}

function tlv(tag, content) {
  const body = Buffer.isBuffer(content) ? content : Buffer.from(content)
  return Buffer.concat([Buffer.from([tag]), derLength(body.length), body])
}

const der = {
  seq: (...parts) => tlv(0x30, Buffer.concat(parts)),
  set: (...parts) => tlv(0x31, Buffer.concat(parts)),
  oid: (dotted) => {
    const parts = dotted.split('.').map(Number)
    const first = 40 * parts[0] + (parts[1] ?? 0)
    const rest = []
    for (const value of parts.slice(2)) {
      const chunk = []
      let v = value
      do {
        chunk.unshift(v & 0x7f)
        v >>= 7
      } while (v > 0)
      for (let i = 0; i < chunk.length - 1; i++) chunk[i] |= 0x80
      rest.push(...chunk)
    }
    return tlv(0x06, Buffer.from([first, ...rest]))
  },
  null: () => tlv(0x05, Buffer.alloc(0)),
  int: (value) => {
    const bytes = []
    let v = value
    do {
      bytes.unshift(v & 0xff)
      v >>= 8
    } while (v > 0)
    if ((bytes[0] & 0x80) !== 0) bytes.unshift(0)
    return tlv(0x02, Buffer.from(bytes))
  },
  bool: (value) => tlv(0x01, Buffer.from([value ? 0xff : 0x00])),
  octet: (content) => tlv(0x04, content),
  /** BIT STRING：首字节 = 末尾未使用位数 */
  bit: (content, unusedBits = 0) => tlv(0x03, Buffer.concat([Buffer.from([unusedBits]), content])),
  utf8: (text) => tlv(0x0c, Buffer.from(text, 'utf8')),
  /**
   * DNS 名（GeneralName 的 dNSName = [2] 隐式 IA5String → 原始标签 `0x82`）。
   *
   * ⚠️ 这里**不能**用 IA5String 的通用标签 `0x16`：实测那样写会让**整个 SAN 失效**
   * （openssl 显示成一串乱码、Node 的 `X509Certificate.subjectAltName` 直接变 undefined），
   * 而证书其它部分看起来完全正常——极其难查。已由 `makeSelfSignedCert` 的自检兜住。
   */
  dnsName: (text) => tlv(0x82, Buffer.from(text, 'ascii')),
  utc: (date) => tlv(0x17, Buffer.from(date.toISOString().replace(/[-:T]/g, '').slice(2, 14) + 'Z', 'ascii')),
  /**
   * 显式上下文标签（**构造形式**，0xA0 | n）。
   *
   * 用错形式会直接报 `explicit tag not constructed`：DER 里"显式包装"
   * （如 version 的 [0]、extensions 的 [3]）必须用 constructed 位。
   */
  explicit: (tagNumber, content) => tlv(0xa0 | tagNumber, content),
  /** 隐式上下文标签（原始形式，0x80 | n）——用于本身就是原始类型的 GeneralName.IP */
  ctxPrimitive: (tagNumber, content) => tlv(0x80 | tagNumber, content),
  /** [7] IP 地址（RFC 5280 的 GeneralName 形式：隐式标签 7 + 4 字节） */
  ip: (address) => tlv(0x87, Buffer.from(address.split('.').map(Number))),
  /** Extension ::= SEQUENCE { extnID, critical BOOLEAN DEFAULT FALSE, extnValue OCTET STRING } */
  ext: (oid, critical, value) =>
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
}

function name(commonName) {
  return der.seq(der.set(der.seq(der.oid(OID.atCommonName), der.utf8(commonName))))
}

/**
 * 生成自签证书。
 * @param {{ ip?: string, dns?: string[], days?: number, commonName?: string }} [options]
 * @returns {{ certPem: string, keyPem: string, san: string[] }}
 */
/**
 * 造一张证书（自签，或由给定 CA 签发 ✓）。
 *
 * ★ 为什么要支持"由 CA 签发"：见文件末尾 CLI 的长注释 ✓ ——
 *   自签的单张证书**每次换 IP 都要重签** ✗，而重签后手机上的信任**立刻作废** ✗，
 *   直接后果就是用户遇到的"**Chrome 不再提供安装**"（WebAPK 铸造要求证书有效 ✓）。
 *   拆成"长期 CA + 短期叶子"之后，手机只需装一次 CA ✓，以后换 IP 重签**不影响信任** ✓。
 */
function buildCert({ commonName, issuerName, signerKey, publicKey, keyPem, ip, dnsNames, days, isCa }) {
  const notBefore = new Date(Date.now() - 24 * 60 * 60 * 1000) // 回拨一天，容忍手机时钟偏差
  const notAfter = new Date(Date.now() + days * 24 * 60 * 60 * 1000)
  const serial = randomBytes(8).readUInt32BE(0) & 0x7fffffff
  const algorithm = der.seq(der.oid(OID.ecdsaWithSha256)) // 无参数（ECDSA 的 AlgorithmIdentifier 不带 NULL）
  const spki = publicKey.export({ type: 'spki', format: 'der' })

  /**
   * keyUsage BIT STRING（DER 里 bit0 是**最高位** ✓）：
   *   · 服务器证书：digitalSignature(0) + keyEncipherment(2) → 0b1010_0000 = 0xA0，3 位有效 → 5 位未用 ✓
   *   · CA：keyCertSign(5) + cRLSign(6) → 0b0000_0110 = 0x06，7 位有效 → 1 位未用 ✓
   *   （手机/安卓把 CA 证书装进信任库时**会检查 keyCertSign** ✗ —— 少了它装不上 ✓）
   */
  const keyUsage = isCa ? der.bit(Buffer.from([0x06]), 1) : der.bit(Buffer.from([0xa0]), 5)

  const san = der.seq(der.ip(ip), ...dnsNames.map((d) => der.dnsName(d)))
  const extensions = der.explicit(
    3,
    der.seq(
      der.ext(OID.basicConstraints, true, der.seq(der.bool(isCa))), // CA:TRUE / CA:FALSE
      der.ext(OID.keyUsage, true, keyUsage),
      ...(isCa ? [] : [der.ext(OID.extKeyUsage, false, der.seq(der.oid(OID.serverAuth)))]),
      ...(isCa ? [] : [der.ext(OID.subjectAltName, false, san)]),
    ),
  )

  const tbs = der.seq(
    der.explicit(0, der.int(2)), // version v3（显式 [0]，构造形式）
    der.int(serial),
    algorithm,
    name(issuerName), // issuer（自签时 == subject ✓）
    der.seq(der.utc(notBefore), der.utc(notAfter)),
    name(commonName), // subject
    spki,
    extensions,
  )

  const signature = sign('sha256', tbs, signerKey)
  const certificate = der.seq(tbs, algorithm, der.bit(signature))
  const certPem = `-----BEGIN CERTIFICATE-----\n${certificate
    .toString('base64')
    .replace(/(.{64})/g, '$1\n')
    .trim()}\n-----END CERTIFICATE-----\n`
  return { certPem, keyPem }
}

export function makeSelfSignedCert(options = {}) {
  const days = options.days ?? 825
  const ip = options.ip ?? '127.0.0.1'
  const dnsNames = options.dns ?? ['localhost']
  const commonName = options.commonName ?? ip

  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const keyPem = privateKey.export({ type: 'pkcs8', format: 'pem' })
  return buildCert({
    commonName,
    issuerName: commonName,
    signerKey: privateKey,
    publicKey,
    keyPem,
    ip,
    dnsNames,
    days,
    isCa: true,
  })
}

/** CA：长期有效、CA:TRUE、keyCertSign（安卓装信任库时必须 ✓）。 */
export function makeCaCert({ commonName = 'dsh-mobile local CA', days = 3650 } = {}) {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const keyPem = privateKey.export({ type: 'pkcs8', format: 'pem' })
  return buildCert({
    commonName,
    issuerName: commonName,
    signerKey: privateKey,
    publicKey,
    keyPem,
    ip: '127.0.0.1',
    dnsNames: ['localhost'],
    days,
    isCa: true,
  })
}

/** 由 CA 签发的服务器证书（IP/DNS 写在 SAN 里 ✓）。 */
export function makeSignedCert({ caCertPem, caKeyPem, ip, dns = ['localhost'], days = 825 }) {
  const caKey = createPrivateKey(caKeyPem)
  /**
   * ★ issuer 字段要的是 CA 的**名字值** ✓，不是 Node 格式化后的整串 ✗ ——
   *   `X509Certificate.subject` 已经是 `CN=dsh-mobile local CA` ✓，
   *   再交给 `name()` 拼一次就变成 `CN=CN=dsh-mobile local CA` ✗，
   *   于是**叶子证书的 issuer 与 CA 的 subject 不相等** ✓ → 客户端验链直接失败 ✗
   *   （本轮真生成了这么一张 ✓，靠打印"签发者"那一行看出来的 ✓）。所以要剥掉 `CN=` ✓。
   */
  const caSubjectText = new X509Certificate(caCertPem).subject
  const caCnLine = caSubjectText
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.startsWith('CN='))
  const caName = caCnLine === undefined ? caSubjectText.split('\n').join(', ') : caCnLine.slice(3)
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const keyPem = privateKey.export({ type: 'pkcs8', format: 'pem' })
  return buildCert({
    commonName: ip,
    issuerName: caName,
    signerKey: caKey,
    publicKey,
    keyPem,
    ip,
    dnsNames: dns,
    days,
    isCa: false,
  })
}

// ── CLI ────────────────────────────────────────────────────────────────
const isDirectRun = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href

if (isDirectRun) {
  const argv = process.argv.slice(2)
  const flag = (name, fallback) => {
    const index = argv.indexOf(name)
    return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : fallback
  }

  if (argv.includes('--print')) {
    const certPath = flag('--cert', undefined)
    if (certPath === undefined) {
      console.error('用法：node scripts/make-cert.mjs --print --cert <cert.pem>')
      process.exit(2)
    }
    const parsed = new X509Certificate(readFileSync(certPath))
    console.log('subject    :', parsed.subject.replace(/\n/g, ' '))
    console.log('subjectAlt :', parsed.subjectAltName)
    console.log('validFrom  :', parsed.validFrom)
    console.log('validTo    :', parsed.validTo)
    console.log('CA         :', parsed.ca)
    process.exit(0)
  }

  const ip = flag('--ip', undefined)
  const outDir = flag('--out-dir', join(homedir(), '.dsh', 'storages', 'dsh-mobile', 'tls'))
  if (ip === undefined) {
    console.error('用法：node scripts/make-cert.mjs --ip <局域网IP> [--out-dir <目录>]')
    process.exit(2)
  }

  /**
   * ★ SAN 里必须写**真正的机器名** ✓ —— 这是"地址不随 IP 变"的关键 ✓。
   *
   * 用户反馈："电脑重启，电脑 IP 会变，导致手机下载的浏览器版 app 无法打开" ✗。
   * PWA 的启动地址在**安装那一刻就固定**了 ✗（改不了 ✓），所以唯一的解法是
   * **用一个不随 IP 变的地址去装** ✓ —— 那就是机器名的 mDNS 名字
   * `<hostname>.local` ✓（macOS 自带广播 ✓，安卓 12+ 的解析器也认 ✓）。
   *
   * `dsh.local` 以前写在这里 ✗ —— 但**没有任何东西广播它** ✓，解析不了 ✓，等于白写 ✓。
   * 现在同时写：`localhost` ✓、机器名 ✓、`<机器名>.local` ✓、以及保留 `dsh.local` ✓
   * （将来若用 mDNS 广播它，证书这边就已经就绪 ✓）。
   */
  const host = hostname()
  /**
   * ★ macOS 的 `os.hostname()` **本身就带 `.local`** ✓（实测 `Mac-mini-2024.local` ✓）——
   *   直接拼 `.local` 会得到 `Mac-mini-2024.local.local` ✗。先取裸名再统一拼 ✓。
   */
  const bare = host.replace(/\.local$/i, '')
  const dnsNames = [...new Set(['localhost', 'dsh.local', bare, `${bare}.local`])]

  /**
   * ★★ 证书拆成两层：**长期本机 CA** + **由它签发的服务器证书** ✓。
   *
   * 为什么必须这么拆（用户真实反馈 ✓）：
   *   "现在应该是因为证书失效的问题，Google 不提供 app 下载了" ✗ ——
   *   原来是一张**自签**证书 ✓，IP 一变就得重签 ✓，重签后**手机上的信任立刻作废** ✗。
   *   而 Chrome 在"证书无效"的源上**拒绝提供安装** ✓（WebAPK 铸造要求有效证书 ✓）→
   *   表现就是"装了半天的 App 突然不能装了" ✓。
   *   拆成 CA + 叶子之后 ✓：**手机只要装一次 CA** ✓，以后换 IP 重签叶子
   *   **不影响信任** ✓ → 换网络再也不用重新装 App ✓。
   *
   * CA 文件（`lan-ca.pem` / `lan-ca-key.pem`）**一旦存在就复用** ✓ ——
   * 千万别每次重签都换 CA ✗，那等于把手机上的信任又作废一次 ✓。
   */
  const caCertPath = join(outDir, 'lan-ca.pem')
  const caKeyPath = join(outDir, 'lan-ca-key.pem')
  mkdirSync(outDir, { recursive: true })
  let caCertPem
  let caKeyPem
  let caReused = true
  if (existsSync(caCertPath) && existsSync(caKeyPath)) {
    caCertPem = readFileSync(caCertPath, 'utf8')
    caKeyPem = readFileSync(caKeyPath, 'utf8')
  } else {
    caReused = false
    const ca = makeCaCert()
    caCertPem = ca.certPem
    caKeyPem = ca.keyPem
    writeFileSync(caCertPath, caCertPem, { mode: 0o644 })
    writeFileSync(caKeyPath, caKeyPem, { mode: 0o600 })
  }

  const { certPem, keyPem } = makeSignedCert({ caCertPem, caKeyPem, ip, dns: dnsNames })
  const certPath = join(outDir, 'lan-cert.pem')
  const keyPath = join(outDir, 'lan-key.pem')
  writeFileSync(certPath, certPem, { mode: 0o644 })
  writeFileSync(keyPath, keyPem, { mode: 0o600 })

  const parsed = new X509Certificate(certPem)
  const caParsed = new X509Certificate(caCertPem)
  console.log(`[make-cert] 已签发服务器证书（CN=${ip}，由本机 CA 签发）`)
  console.log(`  证书    ：${certPath}`)
  console.log(`  私钥    ：${keyPath}（权限 600）`)
  console.log(`  SAN     ：${parsed.subjectAltName}`)
  console.log(`  签发者  ：${parsed.issuer.replace(/\n/g, ' ')}`)
  console.log(`  CA      ：${caCertPath}${caReused ? '（复用已有的 ✓ 手机上的信任不受影响 ✓）' : '（**新建** ✓ 需要在手机上装一次 ✓）'}`)
  console.log(`  CA 有效期至：${caParsed.validTo}`)
  console.log(`  推荐地址：https://${bare}.local:3443/mobile/app  ← 用**机器名**安装，IP 变了也不会失效 ✓`)
  console.log(`  手机上装 CA：https://${ip}:3443/mobile/trust.crt  ← 装一次，以后换 IP 不用再装 ✓`)
  console.log(`  自检    ：解析通过 ✓（SAN 含 ${ip} ✓；CA=${caParsed.ca ? 'TRUE ✓' : 'FALSE ✗'}）`)
  void fileURLToPath
}
