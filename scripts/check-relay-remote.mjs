#!/usr/bin/env node
/**
 * 中继的**远程冒烟验收**：对任意中继地址跑一遍关键断言。
 *
 * 与 `check-relay-e2e.mjs` 的分工：
 *   · `check-relay-e2e.mjs` 是**本机全链路**验收（起中继 + DSH + 无头浏览器，验到"隧道与业务数据"）；
 *   · 本脚本只依赖一个 URL，用于**部署到真实服务器之后**的第一轮确认——
 *     "域名解析对吗、证书可信吗、回源通吗、暴露面有没有变大"。
 *
 * 特别地：**证书不可信时脚本会直接失败**——手机浏览器需要可信证书才有 `crypto.subtle`，
 * 而自签证书在手机上会一直报警告。这条约束太容易被忽略，所以让它变成一条断言。
 *
 * 用法：
 *   node scripts/check-relay-remote.mjs --url https://relay.example.com
 */

const argv = process.argv.slice(2)
const urlIndex = argv.indexOf('--url')
const base = urlIndex >= 0 ? argv[urlIndex + 1] : undefined

if (base === undefined) {
  console.error('用法: node scripts/check-relay-remote.mjs --url https://relay.example.com')
  process.exit(2)
}

const problems = []
const check = (ok, label, detail) => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail === undefined ? '' : `（${detail}）`}`)
  if (!ok) problems.push(label)
}

/** 带超时的 fetch；证书问题会在这里抛出。 */
const get = async (path, init) => {
  try {
    const response = await fetch(new URL(path, base), { ...init, signal: AbortSignal.timeout(15_000) })
    const body = await response.text()
    return { status: response.status, body }
  } catch (error) {
    return { status: 0, body: '', error: String(error?.cause?.code ?? error?.message ?? error) }
  }
}

console.log(`[check-relay-remote] 目标：${base}\n`)

// ① 连通性 + 证书
const health = await get('/healthz')
if (health.status === 0) {
  check(false, '能连上中继且**证书可信**（手机浏览器需要可信证书才有 crypto.subtle）', health.error)
} else {
  check(health.status === 200, '健康检查可达', `HTTP ${health.status}`)
  let parsed
  try {
    parsed = JSON.parse(health.body)
  } catch {
    parsed = undefined
  }
  check(parsed?.ok === true, '健康检查返回 ok', parsed === undefined ? '响应不是 JSON' : JSON.stringify(parsed).slice(0, 120))
  check((parsed?.backhauls ?? 0) >= 1, '电脑的回源通道已连上（否则页面无法下发）', `backhauls=${parsed?.backhauls ?? 0}`)
  // 用"是否出现 32 位十六进制"判定，而不是搜子串 room——
  // `/healthz` 里本来就有 `rooms` 这个**计数**，子串判定会误报（写这条时踩过）。
  check(
    typeof parsed === 'object' && !/[0-9a-f]{32}/.test(health.body),
    '健康检查不泄漏房间号（宿主指纹是 32 位十六进制）',
    '不含',
  )
}

// ② 页面与外壳
const shell = await get('/mobile/app')
check(shell.status === 200 && /boot\.js/.test(shell.body), '应用外壳可达（含 boot.js 注入）', `HTTP ${shell.status}`)
const manifest = await get('/mobile/manifest')
check(manifest.status === 200 && /hostFingerprint/.test(manifest.body), 'manifest 可达（手机靠它取宿主指纹）', `HTTP ${manifest.status}`)

// ③ 暴露面：必须与"同局域网的人直接访问代理"等价，不能更大
const devices = await get('/mobile/devices')
check(devices.status === 403, '设备管理端点被拒（远程不能管理设备）', `HTTP ${devices.status}`)
const pairCode = await get('/mobile/pair/code', { method: 'POST' })
check(pairCode.status === 403, '生成配对码端点被拒（必须人在电脑前）', `HTTP ${pairCode.status}`)
const audit = await get('/mobile/audit')
check(audit.status === 403, '审计端点被拒', `HTTP ${audit.status}`)

if (problems.length > 0) {
  console.error(`\n[check-relay-remote] 未通过 ${problems.length} 项：`)
  for (const p of problems) console.error(`  - ${p}`)
  process.exit(1)
}
console.log('\n[check-relay-remote] 通过：中继可达、证书可信、回源正常、暴露面未扩大 ✓')
