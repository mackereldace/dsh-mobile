#!/usr/bin/env node
/**
 * ★★ 打**构建产物**（`packages/host/lib/` ✓），而不是源码 ✓ ——
 *   因为**部署真正跑的是 lib** ✗：源码对、产物没跟上 ⇒ 用户看到的东西没变 ✓
 *   （本项目最经典的那种"改了但没生效" ✓）。
 *
 * 验三件事：
 * · `/mobile/chat` 回 200 且**带着 boot.js** ✓（少了它：页面能开、永远连不上 ✗）；
 * · `/mobile/chat/theme.css` 回 200 且真有浅/暗变量 ✓（不是空文件 ✓）；
 * · `/mobile/desktop/shot` 在本机（没屏幕录制权限 ✓）回 **502 + 人话** ✓
 *   —— 这条顺带证明"权限失败被翻译过" ✓（不是把系统原文扔出来 ✓）。
 *
 * 前提：先 `npm run build` ✓（否则打的是旧产物，而它可能正好是对的 ✗ ⇒ 这条检查会假绿 ✓）。
 * 用法：`node scripts/check-built-lib.mjs`
 */
import { createServer } from 'node:net'
import { startStandaloneHost } from '/Volumes/Data/workspace/工程设计/dsh-mobile/packages/host/lib/standalone.js'
const free = () => new Promise((r) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)) }) })
const plain = await free(), tls = await free()
const host = await startStandaloneHost({ dataDir: '/tmp/dshm-lib-routes', plain: `127.0.0.1:${plain}`, tls: `127.0.0.1:${tls}`, logger: { log() {}, warn() {} } })
const base = `http://127.0.0.1:${host.plainPort ?? plain}`
const get = async (p) => { const r = await fetch(base + p); return { s: r.status, t: await r.text() } }
const page = await get('/mobile/chat')
const css = await get('/mobile/chat/theme.css')
const shot = await get('/mobile/desktop/shot')
console.log('页面  :', page.s, page.t.includes('/mobile/boot.js') ? '含 boot.js ✓' : '✗ 缺 boot.js')
console.log('样式  :', css.s, css.t.includes('--ink') ? '含浅/暗变量 ✓' : '✗')
console.log('缩略图:', shot.s, shot.t.includes('屏幕录制') ? '人话报错（本机没权限）✓' : shot.t.slice(0, 80))
await host.close()
process.exit(page.s === 200 && css.s === 200 && shot.s === 502 ? 0 : 1)
