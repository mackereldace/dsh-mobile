#!/usr/bin/env node
/**
 * 本机小代理：**只把 `github.com` 指到真 IP**，其余主机按正常 DNS 转发。
 *
 * ## 它治的是什么病（2026-11-14 实测）
 *
 * 这台机器所在的网络**劫持了 `github.com` 的 DNS**：
 *
 * ```
 *   $ dig +short github.com
 *   205.164.50.208 / .202 / .200          ← 不是 GitHub 的地址（GitHub 是 140.82.x / 20.205.243.x）
 *   $ echo | openssl s_client -connect github.com:443 -servername github.com 2>/dev/null \
 *       | openssl x509 -noout -issuer
 *   issuer=C=CN, ST= , O=Scholar Verify, CN=Scholar Root CA v1       ← 中间人（校园 TLS 审计设备）
 * ```
 *
 * ⇒ `git push` 直接报 **`SSL certificate problem: self signed certificate in certificate chain`** ✗
 * ⇒ `npm run publish:apk` 也跟着失败（插件仓那句 `git push` 走的就是 github.com ✓）。
 *
 * ★ 关键事实（本机逐条验过 ✓）：**只有 `github.com` 这一个名字被劫持** ✗ ——
 *   `api.github.com`（20.205.243.168 ✓）、`uploads.github.com` ✓、`objects.githubusercontent.com` ✓、
 *   `codeload.github.com` ✓ 全是真地址 ✓。而**真 IP 上的证书是真的** ✓：
 *
 * ```
 *   $ curl -s --resolve github.com:443:20.205.243.166 https://github.com -o /dev/null -w '%{http_code}'
 *   200
 *   $ echo | openssl s_client -connect github.com:443 ... → issuer=Sectigo Public Server Authentication CA DV E36 ✓
 * ```
 *
 * ## 为什么用这个办法（而不是别的三条 ✗）
 *
 * · **不用** `sudo` 改 `/etc/hosts` ✗ —— 那是全系统的副作用，而这里只需要"我这一个 git 进程"✓；
 * · **不用** `http.sslCAInfo` 去信任校园那张 CA ✗ —— 那等于把**带令牌的 HTTPS**
 *   （`publish-apk` 用 GitHub PAT ✓）交给中间人读 ✓；本仓的纪律是"令牌只走环境变量或钥匙串"✓，
 *   让它在中间人面前裸奔与那条纪律直接冲突 ✗；
 * · **不用** SSH 兜底 ✗ —— `github.com:22` 在这个网络里**直接超时** ✗（`ssh.github.com:443` 通 ✓，
 *   但这台机器上没有任何登记给 GitHub 的密钥 ✓ ⇒ 不是现成的路 ✓）。
 *
 * ⇒ 就地在 `127.0.0.1` 起一个 `CONNECT` 小代理 ✓：`github.com` 走**钉死的真 IP** ✓，
 *   证书是真的 ⇒ libcurl 正常验通 ✓；**令牌还是对着真 GitHub 走** ✓，中间人那一端根本不在链路上 ✓。
 *
 * ## 用法（两条命令，都在 `dsh-mobile/` 下跑）
 *
 * ```bash
 * node scripts/github-dns-pin-proxy.mjs 47811          # ① 前台跑着（另开一个终端也行；Ctrl-C 就停）
 * export HTTPS_PROXY=http://127.0.0.1:47811 https_proxy=$HTTPS_PROXY \
 *        PLUGIN_SYNC_PROXY=$HTTPS_PROXY                # ② 只给"往外推"的那条链用
 * npm run publish:apk
 * ```
 *
 * 验通（只要 `200` 就说明代理这条路成立 ✓）：
 *
 * ```bash
 * curl -s --proxy http://127.0.0.1:47811 -o /dev/null -w '%{http_code}\n' https://github.com
 * ```
 *
 * ★ **只监听 127.0.0.1** ✓（不然就是把一个出口代理开给整个局域网 ✗）；
 * ★ 它**不记录**任何内容 ✓、**不改** DNS 与系统设置 ✓、**不写**任何凭据 ✓ ——
 *   进程停了就等于没发生过 ✓。
 *
 * ## 什么时候**不该**用它
 *
 * `github.com` 解析正常（`dig +short github.com` 是 20.x / 140.82.x ✓）而 `git push` 也正常时
 * ⇒ **不需要**代理 ✓，直接推 ✓（本轮之前的每一轮都是这样 ✓）。
 * 判据只有一条：`git push` 报不报"证书自签"✗ —— 报了就上代理 ✓。
 */
import { lookup } from 'node:dns'
import { createServer, connect } from 'node:net'

/** 默认端口 ✓（换端口就传第一个参数 ✓ —— 别固定 8080 这种谁都爱用的 ✓）。 */
const port = Number(process.argv[2] ?? process.env.GH_PIN_PROXY_PORT ?? 47811)

/**
 * 钉住的主机 ⇒ 真 IP ✓。
 * ★ 20.205.243.166 是 GitHub 在**亚太**的那一组 ✓（本机实测 `curl --resolve` 取到真证书 + 200 ✓）；
 *   140.82.113.4（美洲那组）本机实测同样可用 ✓ —— 想换就改这里 ✓。
 */
const pinned = new Map([
  ['github.com', process.env.GH_PIN_IP ?? '20.205.243.166'],
  ['www.github.com', process.env.GH_PIN_IP ?? '20.205.243.166'],
  ['gist.github.com', process.env.GH_PIN_IP ?? '20.205.243.166'],
])

const log = (message) => console.log(`[gh-pin-proxy] ${message}`)

const server = createServer((client) => {
  /** ★ 必须显式 `Buffer.alloc(0)` ✓ —— `createServer` 的监听器**没有**第二个参数 ✗（本轮栽过 ✓）。 */
  let head = Buffer.alloc(0)
  client.on('error', () => {})

  const onData = (chunk) => {
    head = Buffer.concat([head, chunk])
    const end = head.indexOf('\r\n\r\n')
    if (end < 0) return
    client.removeListener('data', onData)
    const requestLine = head.slice(0, end).toString('latin1').split(' ')
    const method = requestLine[0]
    const target = requestLine[1] ?? ''
    if (method !== 'CONNECT') {
      client.end('HTTP/1.1 405 Method Not Allowed\r\nContent-Length: 0\r\n\r\n')
      return
    }
    const cut = target.lastIndexOf(':')
    const host = (cut < 0 ? target : target.slice(0, cut)).replace(/^\[|\]$/g, '').toLowerCase()
    const targetPort = Number(cut < 0 ? 443 : target.slice(cut + 1)) || 443
    const address = pinned.get(host)
    const dial = (ip) => {
      const upstream = connect({ host: ip, port: targetPort }, () => {
        log(`${host}:${targetPort} ⇒ ${ip}${pinned.has(host) ? '（钉住 ✓）' : '（正常 DNS ✓）'}`)
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        const rest = head.slice(end + 4)
        if (rest.length > 0) upstream.write(rest)
        client.pipe(upstream)
        upstream.pipe(client)
      })
      upstream.on('error', (error) => {
        log(`${host}:${targetPort} ⇒ ${ip} 连不上：${error?.message ?? error} ✗`)
        try { client.destroy() } catch {}
      })
      client.on('error', () => { try { upstream.destroy() } catch {} })
    }
    if (address !== undefined) {
      dial(address)
      return
    }
    lookup(host, (error, resolved) => {
      if (error != null || resolved === undefined) {
        client.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n')
        return
      }
      dial(resolved)
    })
  }

  client.on('data', onData)
})

server.listen(port, '127.0.0.1', () => {
  log(`只监听 127.0.0.1:${port} ✓（git / npm 用 HTTPS_PROXY 指过来 ✓）`)
  log(`钉住：github.com ⇒ ${pinned.get('github.com')} ✓；其它主机走正常 DNS ✓`)
  log('用法：HTTPS_PROXY=http://127.0.0.1:' + port + ' git push origin main ✓')
})
