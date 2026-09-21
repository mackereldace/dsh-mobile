#!/usr/bin/env node
/**
 * 中继的**突发流量验收**：不丢帧、不乱序、逐字节一致。
 *
 * ## 为什么单独一个脚本
 *
 * 中继是唯一**直接面向公网**的组件。它一旦在突发流量下丢帧或错位，
 * 表现是"手机上偶发卡住 / 消息缺一段"——最难查的一类问题，而且只在真实使用时出现。
 * 所以这个性质值得一个**能单独跑、结果确定**的验收，而不是塞进大脚本里当一节。
 *
 * ## 关键设计：不假设消息边界
 *
 * 之前我把它写进 `check-relay.mjs` 时，是按"每帧 8 KiB 切片"去还原接收缓冲的——
 * 那是**对投递方式的假设**（一帧一次投递、不合并）。结果同一份代码两次运行结果不一致，
 * 而我又无法判断是"中继丢帧"还是"我的假设错了"。
 *
 * 这里改为**只看总量与整体字节流**：把所有收到的分片按顺序拼起来，
 * 与"按顺序拼接的期望字节流"逐字节比对。**无论对端怎么分片/合并都能判定**，
 * 而且空输入下必然失败（不会出现"没收到也算通过"的空洞断言）。
 *
 * ## 顺带记录投递形态
 *
 * 输出里会打印"消息数"与"单条长度"，因此它同时回答了
 * "内置 WebSocket 是逐帧投递还是会把多帧合并"这个问题。
 *
 * 用法：node scripts/check-relay-volume.mjs
 */

import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env['RELAY_VOLUME_PORT'] ?? 4331)
const TOKEN = 'relay-volume-token'
const ROOM = 'c'.repeat(32)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 每一档：帧数 × 单帧字节。逐档加压，直到约 6.5 MB。 */
const CASES = [
  [1, 8 * 1024],
  [10, 8 * 1024],
  [120, 8 * 1024],
  [400, 16 * 1024],
]

const relay = spawn(process.execPath, [join(here, 'relay.mjs'), '--listen', `127.0.0.1:${PORT}`, '--token', TOKEN], {
  stdio: ['ignore', 'pipe', 'pipe'],
  cwd: here,
})
let relayLog = ''
relay.stdout.on('data', (chunk) => (relayLog += chunk))
relay.stderr.on('data', (chunk) => (relayLog += chunk))

/** 连一条 WS 并收集收到的分片。 */
function open(path, token) {
  const socket = new WebSocket(`ws://127.0.0.1:${PORT}${path}`)
  socket.binaryType = 'arraybuffer'
  const state = { socket, opened: false, parts: [] }
  socket.addEventListener('open', () => {
    state.opened = true
    if (token !== undefined) socket.send(token)
  })
  socket.addEventListener('message', (event) => state.parts.push(new Uint8Array(event.data)))
  return state
}

const until = async (predicate, ms = 20_000) => {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (predicate()) return true
    await sleep(20)
  }
  return false
}
const totalBytes = (parts) => parts.reduce((sum, part) => sum + part.length, 0)

/** 造第 f 帧的期望内容：前两字节是帧号，其余按确定性公式。 */
function frameBytes(f, size) {
  const buffer = new Uint8Array(size)
  buffer[0] = f & 0xff
  buffer[1] = (f >> 8) & 0xff
  for (let j = 2; j < size; j++) buffer[j] = (f * 31 + j * 7) & 0xff
  return buffer
}

const problems = []
let relayExited

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

  for (const [frames, size] of CASES) {
    const host = open(`/attach?room=${ROOM}`, TOKEN)
    await until(() => host.opened)
    await sleep(150)
    const phone = open(`/connect?room=${ROOM}`)
    await until(() => phone.opened)
    await sleep(150)

    const expected = []
    for (let f = 0; f < frames; f++) expected.push(frameBytes(f, size))
    const expectedTotal = frames * size
    for (const buffer of expected) host.socket.send(buffer)

    const arrived = await until(() => totalBytes(phone.parts) >= expectedTotal)
    const got = new Uint8Array(totalBytes(phone.parts))
    let at = 0
    for (const part of phone.parts) {
      got.set(part, at)
      at += part.length
    }
    const want = new Uint8Array(expectedTotal)
    at = 0
    for (const buffer of expected) {
      want.set(buffer, at)
      at += buffer.length
    }
    // 空输入必须判失败：`got.length === 0` 时任何"逐字节一致"都是空洞的
    let firstDiff = -1
    for (let i = 0; i < Math.min(got.length, want.length); i++) {
      if (got[i] !== want[i]) {
        firstDiff = i
        break
      }
    }
    const identical = got.length === expectedTotal && firstDiff < 0 && arrived
    const lengths = [...new Set(phone.parts.map((p) => p.length))]
    console.log(
      `  帧数=${String(frames).padStart(3)} 每帧=${size} 期望=${expectedTotal} 收到=${got.length} ` +
        `消息数=${phone.parts.length} 单条长度=${lengths.slice(0, 3).join('/')}${lengths.length > 3 ? '…' : ''} ` +
        `一致=${identical ? '是' : `否${firstDiff >= 0 ? `@${firstDiff}` : ''}`}`,
    )
    if (!identical) problems.push(`${frames}×${size} 字节流不一致`)

    phone.socket.close()
    host.socket.close()
    await sleep(250)
  }
  // 中继若中途崩掉，上面任何"一致"都不可信
  if (relayExited !== undefined) problems.push(`中继中途退出：${relayExited}`)
} finally {
  relay.kill('SIGTERM')
  await sleep(600)
  const tail = relayLog
    .split('\n')
    .filter((line) => line.length > 0 && !/登记了一个电脑连接|已配对/.test(line))
    .slice(-4)
  if (tail.length > 0) console.log(`  中继日志：${tail.join(' | ')}`)
}

relay.on('exit', (code, signal) => {
  relayExited = `code=${code} signal=${signal}`
})

if (problems.length > 0) {
  console.error(`\n[check-relay-volume] 未通过 ${problems.length} 项：`)
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}
console.log('\n[check-relay-volume] 通过：突发流量下不丢帧、不乱序、逐字节一致 ✓')
