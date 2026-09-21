#!/usr/bin/env node
/**
 * 局域网 TCP 代理：让手机能访问只绑定在 loopback 的 DSH。
 *
 * ## 为什么需要它
 *
 * `dsh web --host 0.0.0.0` 被**刻意禁用**：
 *   `error: --host 0.0.0.0 is intentionally not supported yet for safety:
 *    it would expose remote code execution to the network`
 *
 * 这个理由完全正确——DSH 的 agent 手里有 bash 与文件写权限，把 GUI 直接开到网络上
 * 等于把电脑控制权交出去。但它也意味着"手机在同一局域网访问电脑"这条需求
 * 不能靠改 DSH 的绑定来完成。本代理是那条受控通道：
 *
 *  - 只转发 TCP，不解析、不修改任何内容；
 *  - **保留原始 Host 头**（TCP 层转发天然保留），这样 DSH 的 Host/Origin 信任栅栏
 *    与 cookie 的 authority 绑定看到的都是手机实际使用的 authority，不会出现
 *    "cookie 绑了 A、手机在用 B"的错配；
 *  - 代理自身不做访问控制——**访问控制仍由 DSH 的 `--trusted-host` 与
 *    本插件的 Host 栅栏、设备密钥认证共同承担**。
 *
 * ## 用法
 *
 * 终端 A（电脑上，DSH）：
 *   dsh web --trusted-host <电脑局域网IP>:<代理端口>
 * 终端 B（电脑上，本代理）：
 *   node scripts/lan-proxy.mjs --listen 0.0.0.0:3081 --target 127.0.0.1:3080
 *
 * 手机浏览器打开：http://<电脑局域网IP>:<代理端口>/
 *
 * ## 为什么还要 HTTPS（**不是可选优化**）
 *
 * 手机访问 `http://<局域网IP>:...` 时页面**不是安全上下文**：实测
 * `window.isSecureContext === false`、`typeof crypto.subtle === 'undefined'`。
 * 而本项目的安全模型完全建立在 WebCrypto 上（P-256 设备密钥、X25519 协商、AES-GCM），
 * 于是手机上只看到一句 `Cannot read properties of undefined (reading 'generateKey')`。
 *
 * 浏览器的规则很硬：只有 `https://`（或 `http://localhost`）才是安全上下文。
 * 所以手机侧必须走 HTTPS；证书用 `scripts/make-cert.mjs` 生成的自签证书，
 * 手机上接受一次警告即可（所有同类局域网工具的通行做法）。
 *
 * 于是本代理同时提供两个监听：
 *   - 明文端口（默认 3081）：给电脑本机/调试用，保留兼容；
 *   - TLS 端口（`--tls-listen`，如 0.0.0.0:3443）：**手机用这个**，
 *     它让页面成为安全上下文，WebCrypto 才可用。
 *
 * ⚠️ 只在可信局域网使用。不要把代理端口暴露到公网——公网接入属于 M4，
 *    届时需要真正的端到端隧道与中继，而不是 TCP 转发。
 */

import { existsSync, readFileSync } from 'node:fs'
import { createServer, connect } from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createServer as createTlsServer } from 'node:tls'

function parseArgs(argv) {
  const out = {
    listen: '0.0.0.0:3081',
    target: '127.0.0.1:3080',
    tlsListen: undefined,
    cert: undefined,
    key: undefined,
  }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--listen') out.listen = argv[++i]
    else if (argv[i] === '--target') out.target = argv[++i]
    else if (argv[i] === '--tls-listen') out.tlsListen = argv[++i]
    else if (argv[i] === '--cert') out.cert = argv[++i]
    else if (argv[i] === '--key') out.key = argv[++i]
    else if (argv[i] === '--help' || argv[i] === '-h') {
      console.log(
        '用法: node scripts/lan-proxy.mjs [--listen 0.0.0.0:3081] [--target 127.0.0.1:3080]\n' +
          '                              [--tls-listen 0.0.0.0:3443 --cert <pem> --key <pem>]\n' +
          '\n' +
          '  手机必须用 --tls-listen 那个端口：普通 HTTP 下页面不是安全上下文，\n' +
          '  crypto.subtle 不存在，配对与隧道都无法工作（详见脚本内说明）。',
      )
      process.exit(0)
    }
  }
  return out
}

function splitHostPort(value, label) {
  const index = value.lastIndexOf(':')
  if (index <= 0) {
    console.error(`[lan-proxy] 无法解析 ${label}：${value}（应为 host:port）`)
    process.exit(1)
  }
  let host = value.slice(0, index)
  // IPv6 字面量写作 `[::]` / `[2001:db8::1]`：必须去掉方括号，否则 listen 会解析失败
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1)
  const port = Number(value.slice(index + 1))
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    console.error(`[lan-proxy] ${label} 的端口非法：${value}`)
    process.exit(1)
  }
  return { host, port }
}

const args = parseArgs(process.argv.slice(2))
const listen = splitHostPort(args.listen, '--listen')
const tlsListen = args.tlsListen === undefined ? undefined : splitHostPort(args.tlsListen, '--tls-listen')
// 证书默认放在 DSH 的数据目录下（与设备库同级），可用 --cert/--key 覆盖
const tlsDirectory = join(homedir(), '.dsh', 'storages', 'dsh-mobile', 'tls')
const certPath = args.cert ?? join(tlsDirectory, 'lan-cert.pem')
const keyPath = args.key ?? join(tlsDirectory, 'lan-key.pem')
const target = splitHostPort(args.target, '--target')

/**
 * 把客户端真实地址注入 `x-forwarded-for`（仅处理本次连接的第一个 HTTP 请求头）。
 *
 * 为什么必须做：TCP 转发后，DSH 看到的对端地址永远是 `127.0.0.1`，
 * 于是它无法区分"电脑本机的浏览器"与"局域网里的手机"——后果是手机被当成 loopback，
 * 拿到电脑版界面、并且能调用只应本机可用的管理端点。
 *
 * 宿主侧只在请求确实来自 loopback 时才信任这个头，因此不影响伪造防护。
 */
function injectForwardedFor(head, remoteAddress) {
  if (remoteAddress === undefined || remoteAddress === '') return head
  const text = head.toString('latin1')
  const headerEnd = text.indexOf('\r\n\r\n')
  if (headerEnd < 0) return head
  const headerBlock = text.slice(0, headerEnd)
  if (/^x-forwarded-for:/im.test(headerBlock)) return head
  return Buffer.from(headerBlock + `\r\nx-forwarded-for: ${remoteAddress}` + text.slice(headerEnd), 'latin1')
}

/** 连接处理：明文与 TLS 监听共用（TLS 只是先解密，之后的字节流完全一样）。 */
function handleConnection(clientSocket) {
  const clientAddress = clientSocket.remoteAddress
  const upstream = connect(target.port, target.host)

  /**
   * 上游尚未连接时到达的数据先排队——不排队会丢包（客户端可能先发数据）。
   *
   * ## 为什么必须"攒到请求头完整"再注入（真 bug）
   *
   * 早期实现只对**第一个数据块**调用注入，而 `injectForwardedFor` 在块内找不到
   * `\r\n\r\n` 时会**原样返回**——也就是"静默放弃注入"。
   * 而 TCP 分片不由我们决定：curl 一次 write 发出完整头（注入成功），
   * 浏览器可能把 400+ 字节的请求头拆成两块（第一块不完整 → 注入失败）。
   * 后果极其隐蔽：**同一个代理，curl 得到正确判定，浏览器却拿到电脑端页面**，
   * 而且代理日志完全正常（它只是"没注入"而已）。
   *
   * 现在改成按字节累积：请求头不完整就继续攒（设上限防止恶意无头请求占内存），
   * 攒齐后注入再转发。注入语义不变（仍然只在 socket 对端是 loopback 时才做）。
   */
  /**
   * 上游尚未连接时到达的数据先排队——不排队会丢包（客户端可能先发数据）。
   *
   * ## 为什么必须"每个请求都注入"（两个真 bug 叠加）
   *
   * 早期实现是"**每个连接**只对第一个数据块注入一次"（`headerInjected` 标志）。
   * 这在 keep-alive 下完全错误：浏览器会在**同一条连接**上连发多个请求，
   * 只有第一个带来源、后续全部不带。实测到的现象极具迷惑性：
   * `/mobile` 判定正确（手机），但它随后的 `/mobile/pair/pending` 却按"电脑本机"放行——
   * 于是配对页把手机显示成**电脑端控制台**。curl 每次新建连接，所以它一直是对的，
   * 只有真实浏览器才暴露（这正是 e2e 用真 Chrome 的价值）。
   *
   * 第二个 bug：注入函数在"块内找不到完整请求头"时**静默放弃注入**。
   * 而 TCP 分片不由我们决定（浏览器可能把 400+ 字节的头拆成两块），
   * 于是注入时有时无，表现为**间歇性**错误判定。
   *
   * 现在按字节流累积：每个请求头收齐就注入一次，注入后立即重置状态以迎接同连接上的
   * 下一个请求。正文（POST body）在 `headerDone` 状态下原样透传，不会被误认为新头。
   */
  const pendingChunks = []
  let headerChunks = []
  let headerBytes = 0
  /** 当前是否处于"请求头已转发、正文透传中"的状态。 */
  let headerDone = false
  /** 上游连接是否就绪；未就绪时到达的数据先入队（见上面 pendingChunks 的说明）。 */
  let upstreamReady = false
  /** 请求头累积上限：正常请求头不过几 KB，超过就原样放行，避免被无头请求撑爆内存。 */
  const HEADER_LIMIT = 64 * 1024

  /** 转发一段字节（上游未就绪时先入队）。 */
  const forward = (bytes) => {
    if (upstreamReady) upstream.write(bytes)
    else pendingChunks.push(bytes)
  }

  clientSocket.on('data', (chunk) => {
    let remaining = chunk

    while (remaining.length > 0) {
      // 正文透传阶段：直到出现"下一个请求的起始行"才回到请求头阶段
      if (headerDone) {
        const next = remaining.indexOf('\r\n')
        if (next < 0) {
          forward(remaining)
          return
        }
        const firstLine = remaining.subarray(0, next).toString('latin1')
        if (!/^[A-Z]{3,10} \S+ HTTP\/1\.[01]$/.test(firstLine)) {
          // 不是请求行 → 仍属上一个请求的正文，原样透传
          forward(remaining)
          return
        }
        // 是新的请求（keep-alive 复用连接）→ 重新进入请求头累积
        headerDone = false
        headerChunks = []
        headerBytes = 0
      }

      headerChunks.push(remaining)
      headerBytes += remaining.length
      const joined = Buffer.concat(headerChunks, headerBytes)
      const headerEnd = joined.indexOf('\r\n\r\n')

      if (headerEnd < 0) {
        if (headerBytes < HEADER_LIMIT) return // 头未收齐，继续攒
        // 超限：原样放行并进入透传（避免被无头请求撑爆内存）
        headerDone = true
        forward(joined)
        return
      }

      // 收齐：注入后转发（注入语义不变，只在 socket 对端是 loopback 时做）
      forward(injectForwardedFor(joined, clientAddress))
      headerDone = true
      return
    }
  })

  upstream.on('connect', () => {
    upstreamReady = true
    for (const chunk of pendingChunks.splice(0)) upstream.write(chunk)
    upstream.pipe(clientSocket)
  })

  const teardown = () => {
    clientSocket.destroy()
    upstream.destroy()
  }
  clientSocket.on('error', teardown)
  upstream.on('error', (error) => {
    console.error(`[lan-proxy] 连接 ${target.host}:${target.port} 失败：${error.message}`)
    teardown()
  })
  clientSocket.on('close', teardown)
  upstream.on('close', teardown)
}

/** 所有监听器（关停时要一起收）。 */
const listeners = []

/** 建一个监听器并登记。 */
function listenOn(kind, options, port, host, onReady) {
  const server = kind === 'tls' ? createTlsServer(options, handleConnection) : createServer(handleConnection)
  server.on('error', (error) => {
    console.error(`[lan-proxy] 监听 ${host}:${port}（${kind}）失败：${error.message}`)
    process.exit(1)
  })
  server.listen(port, host, () => {
    listeners.push(server)
    onReady()
  })
  return server
}

/** 关停全部监听器。 */
function closeAll(done) {
  let pending = listeners.length
  if (pending === 0) return done()
  for (const server of listeners) {
    server.close(() => {
      pending -= 1
      if (pending === 0) done()
    })
  }
}

/**
 * 在 IPv4 监听之外**再补一个 IPv6 监听**（公网 IPv6 直连用）。
 *
 * ## 为什么需要它
 *
 * 代理原先只绑 `0.0.0.0`，于是**只认 IPv4**：手机在蜂窝网上拿到的往往是 IPv6 地址，
 * 即使电脑有公网 IPv6 也连不进来。而 IPv6 直连是"不需要服务器、不需要域名"的
 * 远程通路——M4 里排在第一级，比中继更省事，值得让它真的能用。
 *
 * ## 为什么不是简单改成绑 `::`
 *
 * `::` 在多数系统上是双栈（同时收 IPv4），但**少数环境 IPv6 被禁用**，那样会直接起不来，
 * 把本来能用的局域网也弄坏。所以保留原有 IPv4 绑定不动，**额外**加一个 `ipv6Only` 的
 * IPv6 监听：两者互不冲突，IPv6 不可用时只打一行提示，局域网照旧。
 */
function listenOnIpv6Companion(kind, options, port, host) {
  if (host !== '0.0.0.0') return
  const server = kind === 'tls' ? createTlsServer(options, handleConnection) : createServer(handleConnection)
  server.on('error', (error) => {
    console.warn(`[lan-proxy] IPv6 监听未启用（${error.code ?? error.message}）——局域网不受影响`)
  })
  server.listen({ port, host: '::', ipv6Only: true }, () => {
    listeners.push(server)
    console.log(`[lan-proxy] IPv6 监听：[::]:${port}（公网 IPv6 直连用）`)
  })
}

listenOnIpv6Companion('tcp', {}, listen.port, listen.host)

listenOn('tcp', {}, listen.port, listen.host, () => {
  console.log(`[lan-proxy] 明文监听：${listen.host}:${listen.port} → ${target.host}:${target.port}`)
  console.log(`[lan-proxy] 该端口的 authority 需被信任：dsh web --trusted-host <电脑局域网IP>:${listen.port}`)
})

if (tlsListen !== undefined) {
  if (!existsSync(certPath) || !existsSync(keyPath)) {
    console.error(
      `[lan-proxy] 缺少 TLS 证书，无法启动 HTTPS 监听：\n  证书 ${certPath}\n  私钥 ${keyPath}\n` +
        '  生成：node scripts/make-cert.mjs --ip <电脑局域网IP>',
    )
    process.exit(1)
  }
  // HTTPS 也补一个 IPv6 伴随监听：手机在蜂窝网（IPv6）上直连时走这里
  listenOnIpv6Companion(
    'tls',
    { cert: readFileSync(certPath), key: readFileSync(keyPath) },
    tlsListen.port,
    tlsListen.host,
  )
  listenOn(
    'tls',
    { cert: readFileSync(certPath), key: readFileSync(keyPath) },
    tlsListen.port,
    tlsListen.host,
    () => {
      console.log(`[lan-proxy] HTTPS 监听：${tlsListen.host}:${tlsListen.port}（自签证书，手机需接受一次警告）`)
      console.log(`[lan-proxy]   ★ 手机请访问：https://<电脑局域网IP>:${tlsListen.port}/mobile`)
      console.log(`[lan-proxy]   ★ 该 authority 也需被信任：dsh web --trusted-host <电脑局域网IP>:${tlsListen.port}`)
      console.log('[lan-proxy] 为什么必须 HTTPS：普通 HTTP 下页面不是安全上下文，crypto.subtle 不存在。')
    },
  )
} else {
  console.log('[lan-proxy] 未启用 HTTPS 监听（--tls-listen）。手机侧将因缺少 crypto.subtle 而无法配对。')
}

startWatchdog()

/**
 * 看门狗：DSH 退出后自动退出。
 *
 * 为什么需要：代理是后台进程，DSH 结束时它不会自动消亡，会**变成孤儿继续占着端口**。
 * 下次启动就会看到"端口被占用（PID 未知进程）"，而用户并不知道那是上一次的代理——
 * 本项目真实踩过这个坑（脚本当时只把 dsh 视为可自动停止的对象，于是陷入死循环）。
 *
 * 判据：连续多次无法与目标端口建立 TCP 连接，即认为 DSH 已不在。
 * 连续失败才判定，避免 DSH 重启瞬间误退。
 */
function startWatchdog() {
  const INTERVAL_MS = 5000
  const FAIL_LIMIT = 3
  let failures = 0
  const timer = setInterval(() => {
    const probe = connect(target.port, target.host)
    probe.on('connect', () => {
      failures = 0
      probe.destroy()
    })
    probe.on('error', () => {
      failures += 1
      if (failures >= FAIL_LIMIT) {
        console.log(`[lan-proxy] 目标 ${target.host}:${target.port} 连续 ${failures} 次不可达，判定 DSH 已退出，代理自动关闭。`)
        clearInterval(timer)
        closeAll(() => process.exit(0))
      }
    })
  }, INTERVAL_MS)
  timer.unref?.()
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log('\n[lan-proxy] 正在关闭…')
    closeAll(() => process.exit(0))
  })
}
