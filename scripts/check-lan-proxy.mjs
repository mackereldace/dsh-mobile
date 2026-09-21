#!/usr/bin/env node
/**
 * 局域网代理的行为验收：**每个 HTTP 请求都必须带上真实来源**。
 *
 * ## 为什么需要这个脚本（两个真 bug 的教训）
 *
 * 代理靠注入 `x-forwarded-for` 让宿主区分"电脑本机"与"局域网手机"。
 * 它踩过两个叠加的坑，而且**都只在真实浏览器里才暴露**：
 *
 * 1. **每个连接只注入一次**：浏览器会在同一条 keep-alive 连接上连发多个请求，
 *    于是只有第一个带来源、后续全部不带 —— 表现为 `/mobile` 判定正确（手机），
 *    但它随后的 `/mobile/pair/pending` 却被按"电脑本机"放行，
 *    配对页于**把手机显示成电脑端控制台**。curl 每次新建连接，所以一直是对的。
 * 2. **块内头不完整就静默放弃注入**：TCP 分片不由我们决定，于是注入时有时无，
 *    表现为间歇性错误判定。
 *
 * 因此这里用"**复用同一连接**发多个请求"的方式验证——这正是浏览器与 curl 的关键差别。
 *
 * 用法：node scripts/check-lan-proxy.mjs [--port 3081] [--host 10.34.221.181]
 * 前置：代理已在监听（scripts/lan-proxy.mjs），且后端 DSH 在跑。
 */

import { Agent, request } from 'node:http'

const args = process.argv.slice(2)
const readFlag = (name, fallback) => {
  const index = args.indexOf(name)
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback
}
const PORT = Number(readFlag('--port', '3081'))
const HOST = readFlag('--host', undefined)

/** 选出本机局域网地址（复用共享探测模块）。 */
async function resolveHost() {
  if (HOST !== undefined) return HOST
  const module = await import('./detect-lan-ip.mjs')
  const detected = module.detectLanIp()
  if (detected === undefined) {
    console.error('[check-lan-proxy] 未探测到局域网地址，请用 --host 显式指定')
    process.exit(1)
  }
  return detected
}

const target = await resolveHost()
// ⚠️ 关键：keepAlive + maxSockets:1 强制**所有请求复用同一条连接**，模拟浏览器行为
const agent = new Agent({ keepAlive: true, maxSockets: 1 })

const get = (path) =>
  new Promise((resolve) => {
    const req = request(
      {
        host: target,
        port: PORT,
        path,
        agent,
        headers: {
          // 用接近真实浏览器的头（较大，容易触发分片）
          'User-Agent':
            'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
          'Accept-Language': 'zh-CN,zh;q=0.9',
          'Accept-Encoding': 'gzip, deflate',
          Connection: 'keep-alive',
          'Upgrade-Insecure-Requests': '1',
        },
      },
      (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }))
      },
    )
    req.on('error', (error) => resolve({ status: 0, body: String(error.message) }))
    req.end()
  })

const problems = []
const check = (ok, label, detail) => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail === undefined ? '' : `（${detail}）`}`)
  if (!ok) problems.push(label)
}

console.log(`[check-lan-proxy] 经代理 http://${target}:${PORT}（复用同一条连接）`)

// ① 页面本身可达
const page = await get('/mobile')
check(page.status === 200, 'GET /mobile 返回 200', `HTTP ${page.status}`)

// ② 管理端点必须被识别为"非本机"→ 403
//    若代理没注入来源，这里会是 200（=被当成电脑本机），正是那个 bug 的表现
for (const path of ['/mobile/pair/pending', '/mobile/devices']) {
  const res = await get(path)
  check(res.status === 403, `${path} 被识别为非本机（403）`, `HTTP ${res.status}`)
}

// ③ 连续多个请求都必须一致（防"只有第一个请求带来源"）
const repeat = await Promise.all([0, 1, 2].map(() => get('/mobile/pair/pending')))
check(
  repeat.every((r) => r.status === 403),
  '同一连接上连续 3 个请求均被识别为非本机',
  repeat.map((r) => r.status).join(','),
)

agent.destroy()

if (problems.length > 0) {
  console.error(`\n[check-lan-proxy] 未通过 ${problems.length} 项：`)
  for (const problem of problems) console.error(`  - ${problem}`)
  console.error(
    '\n  最可能的原因：代理按"每个连接只注入一次"实现，遇到 keep-alive 复用连接时就漏注入。\n' +
      '  注意这个 bug 会以**两种相反的面貌**出现，取决于 TCP 分片：\n' +
      '    · 该带来源的请求没带上 → 管理端点 200（被当成电脑本机，手机看到电脑端控制台）\n' +
      '    · 不该带来源的请求带上了 → /mobile 也变 403\n' +
      '  两种都在本脚本的断言范围内（/mobile 必须 200，管理端点必须 403）。',
  )
  process.exit(1)
}
console.log('\n[check-lan-proxy] 通过：每个请求都携带真实来源 ✓')
