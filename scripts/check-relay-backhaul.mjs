#!/usr/bin/env node
/**
 * 中继的**页面回源（backhaul）验收**。
 *
 * ## 它管什么
 *
 * 手机远程时页面本身也得有来源（`/mobile/app`、`/assets/*`、`/plugins/*`），
 * 而中继只是纯字节转发器：看不懂隧道、也没有手机的密钥，塞不进那条加密会话。
 * 所以电脑另开一条普通（TLS）通道 `/attach-http`，中继把请求描述成 JSON 发过去、
 * 把响应原样回给浏览器。**这一节就是验这条回路。**
 *
 * ## 为什么用"假电脑"而不是真 DSH
 *
 * 这里要验的是**中继这一侧**的路由与转发（前缀解析、房间选择、请求体与响应体的
 * 完整性、逐跳头过滤），而不是 DSH 的 HTTP 语义。用一个只会照指令作答的假回源端，
 * 能把"中继错了"与"电脑错了"彻底分开——这正是前面几轮反复吃过的教训。
 *
 * ## 沿用不藏假设的做法
 *
 * 断言只看**整体字节**，不假设分片方式；**空输入必须判失败**。
 * 响应体特意做到 1 MB 量级（真实资源就是这个尺寸），覆盖 base64 往返。
 *
 * 用法：node scripts/check-relay-backhaul.mjs
 */

import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env['RELAY_BACKHAUL_PORT'] ?? 4333)
const TOKEN = 'relay-backhaul-token'
const ROOM_A = 'd'.repeat(31) + '1'
const ROOM_B = 'e'.repeat(31) + '2'
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const relay = spawn(process.execPath, [join(here, 'relay.mjs'), '--listen', `127.0.0.1:${PORT}`, '--token', TOKEN], {
  stdio: ['ignore', 'pipe', 'pipe'],
  cwd: here,
})
let relayLog = ''
relay.stdout.on('data', (chunk) => (relayLog += chunk))
relay.stderr.on('data', (chunk) => (relayLog += chunk))
let relayExited

const problems = []
const ok = (condition, label, detail) => {
  console.log(`  ${condition ? '✓' : '✗'} ${label}${detail === undefined ? '' : `（${detail}）`}`)
  if (!condition) problems.push(label)
}

/** 假的"电脑"：接上回源通道，收到请求描述就按固定规则作答。 */
function fakeBackhaul(room, tag) {
  const socket = new WebSocket(`ws://127.0.0.1:${PORT}/attach-http?room=${room}`)
  // ★ 必须设 binaryType：Node 内置 WebSocket 默认把二进制帧给成 **Blob**，
  //   而中继发的请求描述是字节（Buffer），不设就会在 Buffer.from(blob) 上抛。
  //   同一个坑这已经是第三次咬人（生产 dialer、我的旧探针、这里），
  //   所以规矩是：**构造 WebSocket 之后立刻设 binaryType**。
  socket.binaryType = 'arraybuffer'
  const state = { socket, opened: false, descriptors: [] }
  socket.addEventListener('open', () => {
    state.opened = true
    socket.send(TOKEN)
  })
  socket.addEventListener('message', (event) => {
    const data = event.data
    const text =
      typeof data === 'string'
        ? data
        : data instanceof ArrayBuffer
          ? Buffer.from(data).toString('utf8')
          : Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8')
    const descriptor = JSON.parse(text)
    state.descriptors.push(descriptor)
    // 回一个 1 MB 的响应体（真实资源就是这个量级），内容由 tag 与路径决定
    const payload = Buffer.alloc(1024 * 1024)
    payload.write(`${tag}:${descriptor.path}`, 0, 'utf8')
    for (let i = 64; i < payload.length; i++) payload[i] = (i * 13 + tag.charCodeAt(0)) & 0xff
    socket.send(
      JSON.stringify({
        id: descriptor.id,
        status: 200,
        headers: {
          'content-type': 'application/octet-stream',
          'x-served-by': tag,
          // 逐跳头塞入**可辨识的标记值**：这样"有没有被过滤掉"才是可判定的。
          // 不能直接断言响应里 connection 为空 —— Node 的 HTTP 服务器自己会加
          // `Connection: keep-alive`（正常的 HTTP/1.1 行为），那与"透传"无关。
          connection: 'x-hop-marker',
          'keep-alive': 'x-ka-marker',
          'transfer-encoding': 'x-te-marker',
        },
        body: payload.toString('base64'),
      }),
    )
  })
  return state
}

const get = async (path, init) => {
  try {
    const response = await fetch(`http://127.0.0.1:${PORT}${path}`, { ...init, signal: AbortSignal.timeout(15_000) })
    const buffer = Buffer.from(await response.arrayBuffer())
    return { status: response.status, headers: response.headers, body: buffer }
  } catch (error) {
    return { status: 0, headers: new Headers(), body: Buffer.alloc(0), error: String(error?.cause?.code ?? error?.message ?? error) }
  }
}

try {
  let ready = false
  for (let i = 0; i < 40; i++) {
    await sleep(250)
    try {
      if ((await fetch(`http://127.0.0.1:${PORT}/healthz`)).ok) {
        ready = true
        break
      }
    } catch {
      /* 还没起来 */
    }
  }
  if (!ready) problems.push('中继未就绪')

  // 两个房间各接一个假回源端（用于验证"按房间选机器"）
  const backhaulA = fakeBackhaul(ROOM_A, 'A')
  const backhaulB = fakeBackhaul(ROOM_B, 'B')
  await sleep(600)
  ok(backhaulA.opened && backhaulB.opened, '两个房间的回源通道都已认证')

  console.log('\n【按房间选机器：/r/<room>/ 前缀】')
  const viaPrefix = await get(`/r/${ROOM_A}/mobile/app?x=1&y=2`)
  ok(viaPrefix.status === 200, '带前缀的请求回源成功', `HTTP ${viaPrefix.status}${viaPrefix.error ? ` ${viaPrefix.error}` : ''}`)
  ok(backhaulA.descriptors.length === 1 && backhaulB.descriptors.length === 0, '只发给了该房间的电脑（另一台没收到）')
  const descriptorA = backhaulA.descriptors[0]
  ok(descriptorA?.path === '/mobile/app?x=1&y=2', '前缀被剥掉、查询串完整保留', descriptorA?.path)
  ok(descriptorA?.method === 'GET', '方法正确传递', descriptorA?.method)

  console.log('\n【响应体完整性（1 MB 级，覆盖 base64 往返）】')
  const expectedHead = Buffer.from(`A:/mobile/app?x=1&y=2`, 'utf8')
  ok(viaPrefix.body.length === 1024 * 1024, '响应体长度正确', `${viaPrefix.body.length} 字节`)
  ok(viaPrefix.body.subarray(0, expectedHead.length).equals(expectedHead), '响应体开头内容正确（未错位）')
  let bodyOk = true
  for (let i = 64; i < viaPrefix.body.length; i += 4093) {
    if (viaPrefix.body[i] !== ((i * 13 + 'A'.charCodeAt(0)) & 0xff)) {
      bodyOk = false
      break
    }
  }
  ok(bodyOk, '响应体逐段内容一致（抽样比对）')
  ok(viaPrefix.headers.get('x-served-by') === 'A', '自定义响应头透传', viaPrefix.headers.get('x-served-by') ?? '无')
  const headerDump = [...viaPrefix.headers.entries()].map(([k, v]) => `${k}: ${v}`).join(' | ')
  ok(
    !/x-hop-marker|x-ka-marker|x-te-marker/.test(headerDump),
    '宿主发来的逐跳头没有被透传（connection / keep-alive / transfer-encoding）',
    /x-hop-marker|x-ka-marker|x-te-marker/.test(headerDump) ? '❌ 有透传' : '已过滤',
  )

  console.log('\n【请求体完整性：POST 不得丢字节】')
  const postBody = Buffer.alloc(256 * 1024)
  for (let i = 0; i < postBody.length; i++) postBody[i] = (i * 7) & 0xff
  postBody[0] = 0 // 显式含 0x00
  postBody[1] = 0xff // 与 0xFF
  const posted = await get(`/r/${ROOM_A}/mobile/upload`, { method: 'POST', body: postBody })
  await sleep(300)
  const postDescriptor = backhaulA.descriptors.find((d) => d.method === 'POST')
  const receivedBody = postDescriptor === undefined ? Buffer.alloc(0) : Buffer.from(postDescriptor.body, 'base64')
  ok(posted.status === 200, 'POST 回源成功', `HTTP ${posted.status}`)
  ok(receivedBody.length === postBody.length, 'POST 体长度一致', `${receivedBody.length} / ${postBody.length}`)
  ok(receivedBody.equals(postBody), 'POST 体逐字节一致（含 0x00 与 0xFF）')

  console.log('\n【房间选择必须明确，不能靠猜】')
  const noBackhaul = await get(`/r/${'f'.repeat(32)}/mobile/app`)
  ok(noBackhaul.status === 503, '指定了没有回源端的房间 → 503（不挂起）', `HTTP ${noBackhaul.status}`)
  const ambiguous = await get('/mobile/app')
  ok(ambiguous.status === 503, '多台电脑都有回源、又没写前缀 → 503（不猜）', `HTTP ${ambiguous.status}`)

  console.log('\n【回源端失联后不得继续假装可用】')
  backhaulA.socket.close()
  await sleep(600)
  const afterClose = await get(`/r/${ROOM_A}/mobile/app`)
  ok(afterClose.status === 503, '回源端断开后返回 503', `HTTP ${afterClose.status}`)

  if (relayExited !== undefined) problems.push(`中继中途退出：${relayExited}`)
} finally {
  relay.kill('SIGTERM')
  await sleep(600)
  const tail = relayLog
    .split('\n')
    .filter((line) => line.length > 0 && !/回源 (→|←)/.test(line))
    .slice(-4)
  if (tail.length > 0) console.log(`\n  中继日志：${tail.join(' | ')}`)
}

relay.on('exit', (code, signal) => {
  relayExited = `code=${code} signal=${signal}`
})

if (problems.length > 0) {
  console.error(`\n[check-relay-backhaul] 未通过 ${problems.length} 项：`)
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}
console.log('\n[check-relay-backhaul] 通过：按房间路由正确、请求与响应字节完整、不确定性情况明确拒绝 ✓')
