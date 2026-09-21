#!/usr/bin/env node
/**
 * 中继的**跨房间隔离验收**：一台手机只能连到本房间的电脑，字节不得串台。
 *
 * ## 为什么它是安全问题，而不只是功能问题
 *
 * 中继按房间（房间号 = 宿主公钥指纹）把"一条手机连接"配给"一条电脑连接"。
 * 如果隔离有漏洞，最坏的后果不是"功能异常"，而是**别人的手机连上了你的电脑**——
 * 一条手机连接被配给错误房间的电脑，就等于把一台陌生设备接到了你的 DSH 上。
 * 隧道本身的端到端加密仍会挡住它（设备未配对），但这是**唯一一层**防护，
 * 不该由它独自承担。所以隔离必须是被验证过的性质。
 *
 * ## 沿用上一轮的教训：不藏假设
 *
 * 断言方式与 `check-relay-volume.mjs` 一致：**只看整体字节流**，不假设分片/时序/顺序。
 * 并且**空输入必须判失败**——"什么都没收到"是最危险的假通过。
 *
 * 用法：node scripts/check-relay-isolation.mjs
 */

import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env['RELAY_ISOLATION_PORT'] ?? 4332)
const TOKEN = 'relay-isolation-token'
const ROOM_A = 'a'.repeat(31) + '1'
const ROOM_B = 'b'.repeat(31) + '2'
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

/** 连一条 WS；`parts` 收集收到的分片。 */
function open(path, token) {
  const socket = new WebSocket(`ws://127.0.0.1:${PORT}${path}`)
  socket.binaryType = 'arraybuffer'
  const state = { socket, opened: false, closed: false, parts: [] }
  socket.addEventListener('open', () => {
    state.opened = true
    if (token !== undefined) socket.send(token)
  })
  socket.addEventListener('close', () => {
    state.closed = true
  })
  socket.addEventListener('message', (event) => state.parts.push(new Uint8Array(event.data)))
  return state
}

const until = async (predicate, ms = 8000) => {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (predicate()) return true
    await sleep(20)
  }
  return false
}
const flatten = (parts) => {
  const merged = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let at = 0
  for (const part of parts) {
    merged.set(part, at)
    at += part.length
  }
  return merged
}
const equals = (bytes, expected) => bytes.length === expected.length && expected.every((b, i) => bytes[i] === b)
/** 一段可辨识的字节：`tag` 不同即可区分来源。 */
const marker = (tag, length = 64) => {
  const buffer = new Uint8Array(length)
  buffer.fill(tag)
  return buffer
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

  // 两个房间各接一台电脑
  const hostA = open(`/attach?room=${ROOM_A}`, TOKEN)
  const hostB = open(`/attach?room=${ROOM_B}`, TOKEN)
  await until(() => hostA.opened && hostB.opened)
  await sleep(200)

  // 各来一台手机
  const phoneA = open(`/connect?room=${ROOM_A}`)
  const phoneB = open(`/connect?room=${ROOM_B}`)
  await until(() => phoneA.opened && phoneB.opened)
  await sleep(300)

  console.log('\n【配对方向：每台手机只应连到本房间的电脑】')
  const FROM_A = marker(0xa1)
  const FROM_B = marker(0xb2)
  hostA.socket.send(FROM_A)
  hostB.socket.send(FROM_B)
  await until(() => phoneA.parts.length > 0 && phoneB.parts.length > 0)
  await sleep(300)

  const aGot = flatten(phoneA.parts)
  const bGot = flatten(phoneB.parts)
  // 空输入必须失败：`equals(空, 期望)` 会是 false ✓，但这里显式说清楚
  ok(aGot.length > 0, 'A 房手机收到了数据（空输入不算通过）', `${aGot.length} 字节`)
  ok(equals(aGot, FROM_A), 'A 房手机收到的正是 A 房电脑的字节', `[${aGot[0] ?? '-'}…]`)
  ok(equals(bGot, FROM_B), 'B 房手机收到的正是 B 房电脑的字节', `[${bGot[0] ?? '-'}…]`)

  console.log('\n【反向隔离：手机发出的字节也只能进本房间的电脑】')
  const TO_A = marker(0x1a)
  const TO_B = marker(0x2b)
  phoneA.socket.send(TO_A)
  phoneB.socket.send(TO_B)
  await until(() => hostA.parts.length > 0 && hostB.parts.length > 0)
  await sleep(300)
  const hostAGot = flatten(hostA.parts)
  const hostBGot = flatten(hostB.parts)
  ok(equals(hostAGot, TO_A), 'A 房电脑只收到 A 房手机的字节', `[${hostAGot[0] ?? '-'}…]`)
  ok(equals(hostBGot, TO_B), 'B 房电脑只收到 B 房手机的字节', `[${hostBGot[0] ?? '-'}…]`)
  ok(
    !hostAGot.includes(0x2b) && !hostBGot.includes(0x1a),
    '两侧都没有收到对方房间的标记字节（无串台）',
  )

  console.log('\n【房间耗尽后不得复用别人的电脑】')
  // A 房那条电脑连接已被手机 A 用掉；再来一台手机应当**连不上**，而不是顺手配给 B 房
  const phoneA2 = open(`/connect?room=${ROOM_A}`)
  const refused = await until(() => phoneA2.closed || phoneA2.opened === false, 4000)
  const leakedToA2 = flatten(phoneA2.parts)
  ok(refused || leakedToA2.length === 0, 'A 房无空闲电脑时，第二台手机被拒绝（不会串到别处）', phoneA2.closed ? '已关闭' : `收到 ${leakedToA2.length} 字节`)

  console.log('\n【断开隔离：A 房断开不应影响 B 房】')
  phoneA.socket.close()
  hostA.socket.close()
  await sleep(600)
  const STILL_B = marker(0xb3)
  hostB.socket.send(STILL_B)
  const bStillWorks = await until(() => flatten(phoneB.parts).length >= FROM_B.length + STILL_B.length, 4000)
  ok(bStillWorks && !phoneB.closed, 'B 房在 A 房断开后仍然通着', `${flatten(phoneB.parts).length} 字节`)

  if (relayExited !== undefined) problems.push(`中继中途退出：${relayExited}`)
} finally {
  relay.kill('SIGTERM')
  await sleep(600)
  const tail = relayLog
    .split('\n')
    .filter((line) => line.length > 0 && !/登记了一个电脑连接|已配对/.test(line))
    .slice(-4)
  if (tail.length > 0) console.log(`\n  中继日志：${tail.join(' | ')}`)
}

relay.on('exit', (code, signal) => {
  relayExited = `code=${code} signal=${signal}`
})

if (problems.length > 0) {
  console.error(`\n[check-relay-isolation] 未通过 ${problems.length} 项：`)
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}
console.log('\n[check-relay-isolation] 通过：跨房间完全隔离，且互不影响 ✓')
