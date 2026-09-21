#!/usr/bin/env node
/**
 * dsh-mobile 中继 —— 把手机与电脑配到一起，然后**盲转发**字节。
 *
 * ## 它是什么，不是什么
 *
 * 电脑主动外拨一条常驻连接到这里（因此电脑**不需要任何入站端口**，CGNAT 后也能用）；
 * 手机也连到这里；本服务按房间把两条连接接起来，之后**只转发字节，不解析、不落盘**。
 *
 * **它不是信任锚。** 手机与电脑之间的端到端加密（X25519 + ECDSA P-256 + HKDF +
 * AES-256-GCM）与设备配对完全由两端自己完成，中继看不到任何明文，也无法冒充任何一方。
 * 本服务能做的最坏事情是**拒绝服务**——不是窃取内容。
 *
 * 房间号 = **宿主公钥指纹**（与配对时人工核对的是同一个）。它是公开信息
 * （配对票据里就有），**不承担凭据作用**，只用于把两条连接配到一起。
 *
 * ## 认证
 *
 * 只有 `/attach`（电脑侧）需要凭据，而且**不在 URL 里**：
 * 连接建立后电脑必须在 `--attach-token-timeout`（默认 5 秒）内把共享密钥
 * 作为**第一条消息**发来，否则被关闭。这样 token 不会出现在 URL、访问日志或
 * 反向代理日志里。
 *
 * 手机侧不需要凭据：它的准入由电脑在隧道握手时判定（设备签名 + 电脑端人工确认）。
 * 未配对的设备即使连上本服务，也建立不了隧道。
 *
 * ## 用法
 *
 *   node scripts/relay.mjs --listen 0.0.0.0:4300 --token <共享密钥>
 *   # 生产（真实域名证书）：
 *   node scripts/relay.mjs --tls-listen 0.0.0.0:4301 --cert /path/fullchain.pem \
 *     --key /path/privkey.pem --token <共享密钥>
 *
 * 依赖：`packages/host/lib/websocket.js`（自包含，仅用 node:crypto）。
 * 部署到服务器时把这两个文件放一起即可。
 */

import { createServer as createHttpServer } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { acceptWebSocket } from '../packages/host/lib/websocket.js'

const here = dirname(fileURLToPath(import.meta.url))

/** 解析 `host:port`。 */
function splitHostPort(value, flag) {
  const at = value.lastIndexOf(':')
  if (at <= 0) throw new Error(`${flag} 需要形如 host:port，收到 ${value}`)
  return { host: value.slice(0, at), port: Number(value.slice(at + 1)) }
}

/** 命令行参数。 */
function parseArgs(argv) {
  const out = {
    listen: '0.0.0.0:4300',
    tlsListen: undefined,
    cert: undefined,
    key: undefined,
    token: process.env['DSH_RELAY_TOKEN'],
    attachTokenTimeoutMs: 5000,
    idleTimeoutMs: 10 * 60 * 1000,
    maxRooms: 64,
    maxHostsPerRoom: 4,
    maxPerIp: 8,
    quiet: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--listen') out.listen = argv[++i]
    else if (arg === '--tls-listen') out.tlsListen = argv[++i]
    else if (arg === '--cert') out.cert = argv[++i]
    else if (arg === '--key') out.key = argv[++i]
    else if (arg === '--token') out.token = argv[++i]
    else if (arg === '--attach-token-timeout') out.attachTokenTimeoutMs = Number(argv[++i])
    else if (arg === '--idle-timeout') out.idleTimeoutMs = Number(argv[++i])
    else if (arg === '--max-rooms') out.maxRooms = Number(argv[++i])
    else if (arg === '--max-hosts-per-room') out.maxHostsPerRoom = Number(argv[++i])
    else if (arg === '--max-per-ip') out.maxPerIp = Number(argv[++i])
    else if (arg === '--quiet') out.quiet = true
    else if (arg === '-h' || arg === '--help') {
      console.log(
        '用法: node scripts/relay.mjs [--listen 0.0.0.0:4300] [--tls-listen 0.0.0.0:4301]\n' +
          '         [--cert <pem>] [--key <pem>] [--token <共享密钥>]\n' +
          '         [--attach-token-timeout 5000] [--idle-timeout 600000]\n' +
          '         [--max-rooms 64] [--max-hosts-per-room 4] [--max-per-ip 8] [--quiet]',
      )
      process.exit(0)
    }
  }
  if (typeof out.token !== 'string' || out.token.length === 0) {
    console.error('[relay] 必须提供 --token 或环境变量 DSH_RELAY_TOKEN（防止陌生人占用房间）')
    process.exit(2)
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
void here

/**
 * 只用计数的可观测性——**刻意不记录房间号以外的任何标识**，
 * 因为房间号本身也是公开信息（宿主公钥指纹）。
 */
const stats = { attached: 0, connected: 0, paired: 0, bytes: 0, rejected: 0, closed: 0 }

/**
 * 房间表：room → { hosts: 等待配对的电脑连接, http: 回源通道 }。
 *
 * `http` 是**另一条**电脑→中继的连接，专门用于"页面回源"：
 * 中继是纯字节转发器，看不懂隧道协议，也无法把 HTTP 请求塞进某台手机的加密会话，
 * 所以由电脑另开一条通道，中继把请求描述成 JSON 发过去、把响应原样回给浏览器。
 */
const rooms = new Map()
/** 待回源的请求：id → resolve。 */
const pendingHttp = new Map()
let nextHttpId = 0
/** 每 IP 的活跃连接数。 */
const perIp = new Map()

const log = (...parts) => {
  if (!args.quiet) console.log('[relay]', ...parts)
}

/** 取房间（不存在则创建，受 --max-rooms 限制）。 */
function roomFor(room, create) {
  let entry = rooms.get(room)
  if (entry === undefined) {
    if (!create) return undefined
    if (rooms.size >= args.maxRooms) return undefined
    entry = { hosts: [] }
    rooms.set(room, entry)
  }
  return entry
}

/**
 * 把一对连接接起来：之后**逐帧盲转发**。
 *
 * 刻意不做任何协议解析——中继看不懂、也不该看懂里面是什么。
 * 唯一做的事是计数与在任一侧关闭时关掉另一侧。
 */
function pair(host, phone, room) {
  stats.paired += 1
  log(`房间 ${room} 已配对（当前 ${rooms.size} 个房间）`)

  const link = (from, to) => {
    from.onMessage((data) => {
      stats.bytes += data.length
      to.send(data)
    })
    from.onClose(() => {
      stats.closed += 1
      try {
        to.close(1001, 'peer closed')
      } catch {
        /* 对端可能已关闭 */
      }
    })
    from.onError(() => {
      try {
        to.close(1011, 'peer error')
      } catch {
        /* 忽略 */
      }
    })
  }
  link(host, phone)
  link(phone, host)
}

/** 处理一次 upgrade。 */
function handleUpgrade(req, socket, head) {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'relay.invalid'}`)
  const address = req.socket.remoteAddress ?? 'unknown'
  const current = perIp.get(address) ?? 0
  if (current >= args.maxPerIp) {
    stats.rejected += 1
    socket.destroy()
    return
  }
  perIp.set(address, current + 1)

  const room = url.searchParams.get('room') ?? ''
  if (room.length === 0) {
    stats.rejected += 1
    socket.destroy()
    perIp.set(address, Math.max(0, (perIp.get(address) ?? 1) - 1))
    return
  }

  if (url.pathname === '/attach') {
    const connection = acceptWebSocket(socket, req)
    if (connection === undefined) {
      stats.rejected += 1
      return
    }
    stats.attached += 1
    let authenticated = false
    // 共享密钥必须是第一条消息：不进 URL、不进访问日志
    const tokenTimer = setTimeout(() => {
      if (!authenticated) {
        // 认证失败必须留下原因，否则运维只能看到"电脑连不上中继"而无从下手。
        // 只记长度与来源，**绝不记密钥内容**。
        log(`房间 ${room} 的 attach 在 ${args.attachTokenTimeoutMs}ms 内没发来密钥，关闭`)
        connection.close(1008, 'attach token required')
      }
    }, args.attachTokenTimeoutMs)
    connection.onMessage((data) => {
      if (authenticated) return // 配对前电脑不该发数据；配对后由 pair() 接管
      if (data.toString('utf8') !== args.token) {
        stats.rejected += 1
        clearTimeout(tokenTimer)
        // 只报"收到多少字节"，不报内容——既能定位（空 vs 不匹配），又不泄漏密钥
        log(`房间 ${room} 的 attach 密钥不匹配（收到 ${data.length} 字节），关闭`)
        connection.close(1008, 'bad attach token')
        return
      }
      authenticated = true
      clearTimeout(tokenTimer)
      const entry = roomFor(room, true)
      if (entry === undefined || entry.hosts.length >= args.maxHostsPerRoom) {
        stats.rejected += 1
        connection.close(1013, 'room full')
        return
      }
      entry.hosts.push(connection)
      log(`房间 ${room} 登记了一个电脑连接（空闲 ${entry.hosts.length}）`)
      // 空出来的槽位由电脑侧补：配对成功后本连接会被消费掉
      connection.onClose(() => {
        const index = entry.hosts.indexOf(connection)
        if (index >= 0) entry.hosts.splice(index, 1)
        perIp.set(address, Math.max(0, (perIp.get(address) ?? 1) - 1))
        if (entry.hosts.length === 0) rooms.delete(room)
      })
    })
    return
  }

  if (url.pathname === '/attach-http') {
    const connection = acceptWebSocket(socket, req)
    if (connection === undefined) {
      stats.rejected += 1
      return
    }
    let authenticated = false
    const tokenTimer = setTimeout(() => {
      if (!authenticated) {
        log(`房间 ${room} 的回源通道在 ${args.attachTokenTimeoutMs}ms 内没发来密钥，关闭`)
        connection.close(1008, 'attach token required')
      }
    }, args.attachTokenTimeoutMs)
    connection.onMessage((data) => {
      if (!authenticated) {
        if (data.toString('utf8') !== args.token) {
          stats.rejected += 1
          clearTimeout(tokenTimer)
          log(`房间 ${room} 的回源通道密钥不匹配，关闭`)
          connection.close(1008, 'bad attach token')
          return
        }
        authenticated = true
        clearTimeout(tokenTimer)
        const entry = roomFor(room, true)
        if (entry === undefined) {
          connection.close(1013, 'too many rooms')
          return
        }
        entry.http = connection
        log(`房间 ${room} 的回源通道已就绪`)
        connection.onClose(() => {
          if (entry.http === connection) entry.http = undefined
          if (entry.hosts.length === 0 && entry.http === undefined) rooms.delete(room)
        })
        return
      }
      // 回源响应：{id, status, headers, body}
      let reply
      try {
        reply = JSON.parse(data.toString('utf8'))
      } catch {
        return
      }
      const resolver = pendingHttp.get(reply.id)
      if (resolver !== undefined) {
        pendingHttp.delete(reply.id)
        resolver(reply)
      }
    })
    return
  }

  // `/mobile/ws` 是 **`/connect` 的别名**。
  //
  // 为什么需要：手机侧的候选端点是从**页面来源**推导的（`wss://<relay>/mobile/ws`），
  // 而中继原本只认 `/connect?room=`，于是那一候选永远失败——远程时局域网候选又不可达，
  // 结果就是"页面能打开但隧道连不上"。让中继认这个路径，手机侧一行都不用改。
  if (url.pathname === '/connect' || url.pathname === '/mobile/ws' || /^\/r\/[0-9a-fA-F]{8,64}\/mobile\/ws$/.test(url.pathname)) {
    // 房间号来源三选一：查询串（/connect?room=）、路径前缀（/r/<room>/mobile/ws）、
    // 或者"当前唯一在服的房间"（单机部署下手机不需要知道房间号）。
    const prefixMatch = /^\/r\/([0-9a-fA-F]{8,64})\//.exec(url.pathname)
    const effectiveRoom =
      room.length > 0
        ? room
        : prefixMatch !== null
          ? (prefixMatch[1] ?? '')
          : ([...rooms.entries()].filter(([, e]) => e.hosts.length > 0)[0]?.[0] ?? '')
    const entry = effectiveRoom.length === 0 ? undefined : roomFor(effectiveRoom, false)
    const host = entry === undefined ? undefined : entry.hosts.shift()
    if (host === undefined) {
      // 直接拒绝 upgrade：手机侧表现为连接失败，候选回退会去试下一个端点
      stats.rejected += 1
      socket.destroy()
      perIp.set(address, Math.max(0, (perIp.get(address) ?? 1) - 1))
      return
    }
    const connection = acceptWebSocket(socket, req)
    if (connection === undefined) {
      stats.rejected += 1
      return
    }
    stats.connected += 1
    connection.onClose(() => {
      perIp.set(address, Math.max(0, (perIp.get(address) ?? 1) - 1))
    })
    pair(host, connection, effectiveRoom)
    return
  }

  stats.rejected += 1
  socket.destroy()
  perIp.set(address, Math.max(0, (perIp.get(address) ?? 1) - 1))
}

/** HTTP 面：只暴露计数，不含任何标识。 */
function handleRequest(req, res) {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'relay.invalid'}`)
  if (url.pathname === '/healthz') {
    const body = JSON.stringify({
      ok: true,
      rooms: rooms.size,
      idleHosts: [...rooms.values()].reduce((sum, entry) => sum + entry.hosts.length, 0),
      backhauls: [...rooms.values()].filter((entry) => entry.http !== undefined).length,
      ...stats,
      uptimeSeconds: Math.round(process.uptime()),
    })
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(body)
    return
  }
  // 其余路径一律**回源到电脑**：手机远程时要拿的不只是 /mobile/*，
  // 还有外壳引用的 /assets/*、/plugins/* 等，所以不逐一列举路径，统一转发。
  void proxyToHost(req, res).catch((error) => {
    stats.rejected += 1
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
    res.end(`relay: ${String(error)}\n`)
  })
}

/**
 * 选一个房间来回源。
 *
 * 单机部署（绝大多数情况）下房间里只有一个，直接用；多机时用 `/r/<room>/...` 前缀指定。
 * @returns `{ room, path }`，或 undefined 表示无法确定。
 */
function pickRoomForRequest(pathname) {
  const match = /^\/r\/([0-9a-fA-F]{8,64})(\/.*)?$/.exec(pathname)
  if (match !== null) return { room: match[1], path: match[2] === undefined || match[2] === '' ? '/' : match[2] }
  const serving = [...rooms.entries()].filter(([, entry]) => entry.http !== undefined)
  if (serving.length !== 1) return undefined
  const [room] = serving[0]
  return { room, path: pathname }
}

/** 把一个 HTTP 请求经回源通道发给电脑，并把响应写回浏览器。 */
function proxyToHost(req, res) {
  return new Promise((resolve) => {
    const target = pickRoomForRequest(new URL(req.url ?? '/', 'http://relay.invalid').pathname)
    if (target === undefined) {
      res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('relay: no machine is attached for this path\n')
      resolve()
      return
    }
    const entry = rooms.get(target.room)
    if (entry === undefined || entry.http === undefined) {
      res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('relay: backhaul is offline\n')
      resolve()
      return
    }
    const chunks = []
    // 回源请求/响应都留一行日志（**只记方法与状态码、字节数，不记内容**）。
    // 没有这行日志时，"页面能取到但某个 POST 不生效"这类问题在中继侧完全看不见。
    log(`回源 → ${req.method ?? 'GET'} ${target.path}${req.url && req.url.includes('?') ? '?…' : ''}`)
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      const query = (req.url ?? '/').includes('?') ? (req.url ?? '').slice((req.url ?? '').indexOf('?')) : ''
      // 只保留一条前缀时把 /r/<room> 去掉，其余原样（含查询串）
      const suffix = query
      const path = target.path + suffix
      const id = `h${(nextHttpId += 1)}`
      const timer = setTimeout(() => {
        log(`回源 ← 超时 ${target.path}`)
        pendingHttp.delete(id)
        if (!res.headersSent) res.writeHead(504, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('relay: backhaul timeout\n')
        resolve()
      }, 20_000)
      pendingHttp.set(id, (reply) => {
        clearTimeout(timer)
        // 逐跳头不能透传：长度由我们重算，编码方式由 Node 决定
        const headers = {}
        for (const [key, value] of Object.entries(reply.headers ?? {})) {
          if (/^(connection|keep-alive|transfer-encoding|content-encoding|content-length)$/i.test(key)) continue
          headers[key] = value
        }
        // 非 2xx 时把**错误体**记下来（截断 160 字符）：中继侧看不到原因时，
        // "页面能开、某个 POST 403"这类问题完全无从下手。错误体是短 JSON，不含用户数据。
        const bodyBytes = typeof reply.body === 'string' ? Buffer.from(reply.body, 'base64') : Buffer.alloc(0)
        const asError = typeof reply.status === 'number' && reply.status >= 400
        log(
          `回源 ← ${String(reply.status)} ${target.path}（${bodyBytes.length} 字节）` +
            (asError && bodyBytes.length > 0 ? ` 体=${bodyBytes.toString('utf8').slice(0, 160)}` : ''),
        )
        res.writeHead(typeof reply.status === 'number' ? reply.status : 502, headers)
        res.end(typeof reply.body === 'string' && reply.body.length > 0 ? Buffer.from(reply.body, 'base64') : undefined)
        resolve()
      })
      try {
        // 必须发**字节**：本仓库的最小 WS 实现 send() 收的是 Uint8Array/Buffer，
        // 直接传字符串是不可靠的。
        entry.http.send(
          Buffer.from(
            JSON.stringify({
              id,
              method: req.method ?? 'GET',
              path,
              headers: req.headers,
              body: chunks.length === 0 ? '' : Buffer.concat(chunks).toString('base64'),
            }),
            'utf8',
          ),
        )
      } catch (error) {
        clearTimeout(timer)
        pendingHttp.delete(id)
        res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
        res.end(`relay: ${String(error)}\n`)
        resolve()
      }
    })
  })
}

const servers = []
const plain = createHttpServer(handleRequest)
plain.on('upgrade', handleUpgrade)
const listen = splitHostPort(args.listen, '--listen')
servers.push(plain)
plain.listen(listen.port, listen.host, () => {
  log(`明文监听 ${listen.host}:${listen.port} → /attach、/connect、/healthz`)
})

if (args.tlsListen !== undefined) {
  if (args.cert === undefined || args.key === undefined) {
    console.error('[relay] 指定了 --tls-listen 就必须同时给 --cert 与 --key')
    process.exit(2)
  }
  const secure = createHttpsServer(
    { cert: readFileSync(args.cert), key: readFileSync(args.key) },
    handleRequest,
  )
  secure.on('upgrade', handleUpgrade)
  const tls = splitHostPort(args.tlsListen, '--tls-listen')
  servers.push(secure)
  secure.listen(tls.port, tls.host, () => {
    log(`TLS 监听 ${tls.host}:${tls.port}（手机与电脑在生产环境都应走这个）`)
  })
}

// 空闲连接回收：电脑侧会自己补连接，但没人连的手机 socket 不该一直挂着
const idleTimer = setInterval(() => {
  for (const [room, entry] of rooms) {
    if (entry.hosts.length === 0) rooms.delete(room)
  }
}, 60_000)
idleTimer.unref?.()

process.on('SIGTERM', () => {
  log('收到 SIGTERM，正在关闭…')
  for (const server of servers) server.close()
  process.exit(0)
})
void join
