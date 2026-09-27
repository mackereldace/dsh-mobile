#!/usr/bin/env node
/**
 * 生成局域网用的自签证书（**CLI 薄壳**）+ 一个零依赖的 HTTPS 反代（见 `lan-proxy.mjs`）。
 *
 * ## ★ 本文件现在是"打印与退出码"，逻辑全在宿主插件里
 *
 * 原先这里手写 ASN.1 DER、并独占"生成 CA + 服务器证书"这件事，于是插件首启**没有证书可用**
 * （换机 7 步的第 2 步必须手跑这个脚本），而同一套判据在插件与脚本里各有一份。
 * 现在纯逻辑抽到了 `packages/host/src/tls-cert.ts`（插件首启缺就生成、有就复用），
 * 这里只负责：
 *   1. 解析 `--ip` / `--out-dir` / `--print` 这几个参数（命令行形状**保持不变**，
 *      `start-lan.sh` / `ui-preview.mjs` / `check-mobile-layout.mjs` 不用改）；
 *   2. 打印人看的结论（证书路径、SAN、CA 有效期、推荐地址）；
 *   3. 用退出码表达成败。
 *
 * 文件名与四个产物文件名也**保持不变**（`lan-ca.pem` / `lan-ca-key.pem` /
 * `lan-cert.pem` / `lan-key.pem`）——部署链路、`check-apk.mjs`、`lan-proxy.mjs` 都按它找。
 *
 * ## 为什么必须上 HTTPS（这不是可选优化，是硬约束）
 *
 * 手机浏览器打开 `http://<局域网IP>:3081/...` 时页面**不是安全上下文**：
 * 实测 `window.isSecureContext === false`、`typeof crypto.subtle === 'undefined'`。
 * 而本项目整个安全模型都建立在 WebCrypto 上（P-256 设备密钥、X25519 协商、AES-GCM），
 * 于是手机上只看到一句 `Cannot read properties of undefined (reading 'generateKey')`。
 * 浏览器的规则很硬：只有 `https://`（或 `http://localhost`）才是安全上下文。
 *
 * ## 为什么手写 DER 而不引依赖
 *
 * Node 只给签名原语，没有证书构造 API。本项目至今**零运行时依赖**，
 * 为一张开发用证书破坏这个性质不划算；DER 的长度前缀与结构都很小，可以自持。
 * （实现与它踩过的坑——比如 SAN 的 dNSName 必须用隐式标签 `0x82`——
 * 都搬到了 `packages/host/src/tls-cert.ts`，注释一并跟着走。）
 *
 * ## 证书结构：长期 CA + 由它签发的服务器证书
 *
 * 拆成两层是为了让"换 IP 不必作废手机上的信任"：手机只要装一次 CA，
 * 以后重签叶子不影响信任（否则就是用户遇到的"Google 不再提供安装"）。
 * **CA 文件一旦存在就复用**，`--ip` 只影响新签的那张服务器证书。
 *
 * 用法：
 *   node scripts/make-cert.mjs --ip 10.34.221.181 [--out-dir <目录>]
 *   node scripts/make-cert.mjs --print --cert <cert.pem>
 */

import { X509Certificate } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

// 纯逻辑的唯一来源：宿主插件侧模块（`scripts/build-lib.mjs` 会把它编进 `packages/host/lib`）。
// 这里既 import（CLI 用）又 re-export（保持旧的 `import { makeCaCert } from '.../make-cert.mjs'` 可用）。
import { ensureTlsMaterial } from '../packages/host/src/tls-cert.ts'
import { localHostNames } from '../packages/host/src/lan-trust.ts'

export { makeCaCert, makeSelfSignedCert, makeSignedCert, ensureTlsMaterial, tlsPaths } from '../packages/host/src/tls-cert.ts'

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
   * ★ SAN 里必须写**真正的机器名** —— 这是"地址不随 IP 变"的关键。
   *
   * PWA 的启动地址在**安装那一刻就固定**了，所以唯一的解法是**用一个不随 IP 变的地址去装**：
   * `<hostname>.local`（macOS 自带 mDNS 广播，安卓 12+ 的解析器也认）。
   * `dsh.local` 保留在名单里（将来若真的广播它，证书这边已经就绪）。
   *
   * macOS 的 `os.hostname()` **本身就带 `.local`**（实测 `Mac-mini-2024.local`），
   * 所以先取裸名再统一拼——这一步与信任判据共用 `localHostNames()`，
   * **证书里写了什么名字，闸门就放行什么名字**（两处不一致会表现为"证书认、闸门不认"）。
   */
  const names = localHostNames(hostname())
  const bareName = names[0] ?? 'localhost'
  const dnsNames = [...new Set(['localhost', 'dsh.local', ...names])]
  const status = ensureTlsMaterial({ directory: outDir, addresses: [ip], dnsNames })
  if (!status.ok) {
    console.error(`[make-cert] 生成失败：${status.error ?? '未知原因'}`)
    console.error(`  目录：${outDir}`)
    process.exit(1)
  }

  const parsed = new X509Certificate(readFileSync(status.paths.serverCert))
  const caParsed = new X509Certificate(readFileSync(status.paths.caCert))
  console.log(`[make-cert] 已就绪服务器证书（CN=${ip}，由本机 CA 签发）`)
  console.log(`  证书    ：${status.paths.serverCert}`)
  console.log(`  私钥    ：${status.paths.serverKey}（权限 600）`)
  console.log(`  SAN     ：${parsed.subjectAltName}`)
  console.log(`  签发者  ：${parsed.issuer.replace(/\n/g, ' ')}`)
  console.log(
    `  CA      ：${status.paths.caCert}${
      status.createdCa ? '（**新建** ✓ 需要在手机上装一次 ✓）' : '（复用已有的 ✓ 手机上的信任不受影响 ✓）'
    }`,
  )
  console.log(`  CA 有效期至：${caParsed.validTo}`)
  console.log(`  服务器证书：${status.createdServer ? '新签' : status.resignedServer ? '按当前地址重签' : '复用（SAN 已覆盖当前地址）'}`)
  console.log(`  推荐地址：https://${bareName}.local:3443/mobile/app  ← 用**机器名**安装，IP 变了也不会失效 ✓`)
  console.log(`  手机上装 CA：https://${ip}:3443/mobile/trust.crt  ← 装一次，以后换 IP 不用再装 ✓`)
  console.log(`  自检    ：解析通过 ✓（SAN 含 ${ip} ✓；CA=${caParsed.ca ? 'TRUE ✓' : 'FALSE ✗'}）`)
}
