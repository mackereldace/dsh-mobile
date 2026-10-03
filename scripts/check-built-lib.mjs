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
import { startStandaloneHost } from '/Volumes/Data/workspace/工程设计/dsh-mobile/packages/host/lib/codex/standalone.js'
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
/**
 * ★★★ 会话清单那条**只读路由** ✓（2026-10-04 用户选 (a) 之后加的 ✓）——
 *   它是"原生「会话」标签"的数据来源 ✓，而**只有重启 DSH 之后才会存在** ✓
 *   ⇒ 必须在这里先验明白 ✓，否则用户重启完才发现白跑 ✗。
 * ★ 独立服务没有 DSH 网关 ✓ ⇒ 正确行为是 **502 + 一句人话**（不是 404 ✓、不是异常原文 ✗）。
 */
const sessionsRoute = await get('/mobile/chat/sessions')
const sessionsOk = sessionsRoute.s === 502 && sessionsRoute.t.includes('拿不到会话清单')
console.log('会话清单:', sessionsRoute.s, sessionsOk ? '路由在 + 说人话 ✓' : `✗ 期望 502 且说人话，实际：${sessionsRoute.t.slice(0, 120)}`)
if (!sessionsOk) process.exitCode = 1

/** ★ 再确认一次"旧网页首页"那两处入口真的不在产物里 ✗（重启后才该消失 ✓）。 */
const bootRes = await fetch(base + '/mobile/boot.js')
const bootText = await bootRes.text()
/**
 * ★★ 判据要盯**那颗按钮的构造代码** ✗，不是那七个字 ✓ ——
 *   我第一版用 `includes('电脑与智能体')` ✓，可**我的注释里也写着这七个字** ✓
 *   ⇒ 假红了一次 ✗（"检查自己的判据"这件事，和写断言一样容易想当然 ✓）。
 *   按钮的三个特征（改掉任意一个都算撤掉了 ✓）：
 *   `data-dshm-action` + `open-home` 一起出现 ✗ / 文本赋值 `textContent = '电脑与智能体'` ✗。
 */
const homeButtonGone = !(bootText.includes("'open-home'") && bootText.includes("'电脑与智能体'"))
const homeTextGone = !bootText.includes("textContent = '电脑与智能体'")
console.log('旧网页首页入口:', homeButtonGone && homeTextGone
  ? '产物里没有那颗按钮 ✓'
  : '✗ 产物里还在（重启后手机上仍会看到那颗按钮 ✗）')
if (!(homeButtonGone && homeTextGone)) process.exitCode = 1

await host.close()
process.exit(page.s === 200 && css.s === 200 && shot.s === 502 ? 0 : 1)
