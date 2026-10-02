#!/usr/bin/env node
/**
 * 会话页与缩略图那两条路由 —— **用真 HTTP 打一遍** ✓（进程内起宿主，不碰运行中的生产实例 ✓）。
 *
 * ## 为什么值得单开一条
 *
 * 这两条路由的毛病**全是"没有症状"的那一类** ✗：
 *   · 路由忘了注册 ⇒ 404 ✓（手机上表现为"页面打不开"✓，但电脑上看不出为什么 ✓）；
 *   · 页面里漏了 `<script src="/mobile/boot.js">` ⇒ **页面能打开、永远连不上** ✗
 *     （我第一版就漏了 ✓ —— 靠"照抄 Codex 页"才发现 ✓）；
 *   · CSP 写错 ⇒ 样式/脚本被浏览器挡掉 ✓（打开是一片白 ✓）；
 *   · 缩略图那条失败路径 ⇒ 回一句系统原文 ✓（用户看不懂去哪儿开权限 ✓）。
 * 这些都**只能在"真发一次请求"里现形** ✓ —— 单测打不到它们 ✓。
 *
 * ## 怎么起
 *
 * 用 `startStandaloneHost` ✓（**不依赖 DSH** ✓），只绑 `127.0.0.1:0` ✓
 * ⇒ **不占公网端口、不碰生产实例** ✓；数据目录用临时目录 ✓。
 *
 * 用法：`node scripts/check-host-routes.mjs`
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { startStandaloneHost } from '../packages/host/src/standalone.ts'

/**
 * ★ 先探一个**空闲端口** ✗ —— 我第一版写 `plain: '127.0.0.1:0'`（让系统挑 ✓），
 *   可宿主回报的是**配置串里那个端口** ⇒ 0 ⇒ `plainPort` 是 `undefined` ✓、
 *   于是 `http://127.0.0.1:undefined/...` 当场炸 ✓。
 *   （"让系统挑端口"这条路，只有在**回报真实端口**时才走得通 ✓。）
 */
const freePort = () =>
  new Promise((resolve, reject) => {
    const probe = createServer()
    probe.on('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port
      probe.close(() => resolve(port))
    })
  })

let checks = 0
let failed = 0
const check = (name, ok, detail) => {
  checks += 1
  if (ok) console.log(`  ✓ ${name}`)
  else {
    failed += 1
    console.log(`  ✗ ${name}${detail === undefined ? '' : `（${detail}）`}`)
  }
}

const dataDir = mkdtempSync(join(tmpdir(), 'dshm-routes-'))
const quiet = { log: () => {}, warn: () => {} }

const plainPort = await freePort()
const tlsPort = await freePort()
const host = await startStandaloneHost({
  dataDir,
  plain: `127.0.0.1:${plainPort}`,
  tls: `127.0.0.1:${tlsPort}`,
  plainEnabled: true,
  logger: quiet,
})
const base = `http://127.0.0.1:${host.plainPort}`
console.log(`[check-host-routes] 宿主已在回环起来：${base}（数据目录 ${dataDir} ✓）`)

/** 发一次请求 ✓（连响应头一起收下 ✓）。 */
async function get(path) {
  const response = await fetch(`${base}${path}`, { redirect: 'manual' })
  const body = await response.text()
  return { status: response.status, headers: response.headers, body }
}

try {
  console.log('\n── 会话页（/mobile/chat）──')
  const page = await get('/mobile/chat')
  check('页面回 200', page.status === 200, String(page.status))
  check('是 HTML', (page.headers.get('content-type') ?? '').includes('text/html'))
  check('★★ 页面里带着 boot.js（少了它：能打开、永远连不上 ✗）', page.body.includes('/mobile/boot.js'))
  check('★ 带着"只装隧道、不装 DSH 外壳"那句标记（否则手机上会长出两层顶栏 ✓）', page.body.includes('__DSH_MOBILE_NO_SHELL__'))
  check('带着我们的样式与脚本（同一份 theme.css ✓）', page.body.includes('/mobile/chat/theme.css') && page.body.includes('/mobile/chat/app.js'))
  check('CSP 里放开了 wss:（隧道要它 ✓）', (page.headers.get('content-security-policy') ?? '').includes('wss:'))
  check('不缓存（工具界面 ✓）', (page.headers.get('cache-control') ?? '').includes('no-store'))

  console.log('\n── 资源（/mobile/chat/*）──')
  const css = await get('/mobile/chat/theme.css')
  check('样式回 200 且类型是 css', css.status === 200 && (css.headers.get('content-type') ?? '').includes('text/css'))
  check('★ 样式里真有那套浅/暗变量（不是空文件 ✓）', css.body.includes('--ink') && css.body.includes('prefers-color-scheme'))
  const app = await get('/mobile/chat/app.js')
  check('脚本回 200 且类型是 js', app.status === 200 && (app.headers.get('content-type') ?? '').includes('javascript'))
  check('★ 脚本里真去问宿主要数据（不是空壳 ✓）', app.body.includes('mobile/dsh/sessions'))
  const miss = await get('/mobile/chat/nope.js')
  check('★ 不认识的资源 ⇒ 404（不是把别的文件发出去 ✗）', miss.status === 404, String(miss.status))

  console.log('\n── 缩略图（/mobile/desktop/shot）──')
  const shot = await get('/mobile/desktop/shot')
  /**
   * ★★ 这一条**本机必然是失败**（没给屏幕录制权限 ✓）——而这正是要验的 ✓：
   *   失败要回 502 + **人话** ✓，而不是 200 加一张空图 ✓，也不是把系统原文扔出来 ✓。
   */
  check('没权限时回 502（不是 200 加一张空图 ✗）', shot.status === 502, String(shot.status))
  check('★★ 失败说明是**人话**（提到去哪儿开权限 ✓）', shot.body.includes('屏幕录制') && shot.body.includes('隐私与安全性'), shot.body.slice(0, 120))
  check('★ 不是把系统原文直接扔出来', !shot.body.includes('could not create image'))
} finally {
  await host.close()
  rmSync(dataDir, { recursive: true, force: true })
}

console.log(`\n通过 ${checks - failed} 项，失败 ${failed} 项（共 ${checks} 项）`)
if (failed > 0) process.exit(1)
