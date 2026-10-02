#!/usr/bin/env node
/**
 * 把**会话页骨架**（`packages/host/assets/dsh-chat/dev.html`）渲染成图（浅/暗各一张 ✓）。
 *
 * 为什么要有它：这一页是**我们自己的页面**（未来装 DSH 的输出 ✓），改观感时
 * "先让自己看得见"是硬要求 ✓ —— 本项目吃过四次"盲改 CSS ⇒ 连引回归"的亏 ✓。
 *
 * ## 三个已经踩过的坑（都写在这儿，别再重走）
 *
 * 1. **必须用 HTTP 起，不能 file://** ✗：Chrome 会以 CORS 名义**拦掉 ES module 的 import** ✓
 *    ⇒ 页面静态部分照常渲染、脚本**静默不跑** ✓（看起来就像"没有数据"✗，最难查的一类 ✓）；
 * 2. **Chrome 截完图不退出** ✗ ⇒ 这里**等到文件出现就杀** ✓（不 `await` 它自己退 ✓）；
 * 3. **本机文件沙箱里必须 `--no-sandbox`** ✗（否则 Chrome 自己的 macOS sandbox 起不来、
 *    GPU 进程直接 FATAL ✓）。
 *
 * 用法：
 *   node docs/native/shot-chat.mjs                    # 正常态（浅/暗各一张）
 *   node docs/native/shot-chat.mjs --state error      # 某种状态屏（empty/loading/error/offline/send-fail）
 *   node docs/native/shot-chat.mjs --out /tmp         # 指定输出目录
 */
import { execFileSync, spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const HERE = dirname(fileURLToPath(import.meta.url))
const ASSETS = join(HERE, '..', '..', 'packages', 'host', 'assets', 'dsh-chat')
const outDir = (() => {
  const at = process.argv.indexOf('--out')
  return at >= 0 ? process.argv[at + 1] : HERE
})()
/** `--state=empty|loading|error|offline` ⇒ 渲染那个状态屏（文件名带上前缀 ✓）。 */
const stateArg = (() => {
  const at = process.argv.indexOf('--state')
  return at >= 0 ? String(process.argv[at + 1] ?? '') : ''
})()
const prefix = stateArg.length > 0 ? `chat-state-${stateArg}` : 'chat-mock'
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' }

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const server = createServer((req, res) => {
  const name = (req.url ?? '/').split('?')[0].replace(/^\//, '') || 'dev.html'
  if (name.includes('..')) {
    res.writeHead(403).end('no')
    return
  }
  try {
    const body = readFileSync(join(ASSETS, name))
    res.writeHead(200, { 'content-type': MIME[extname(name)] ?? 'application/octet-stream', 'cache-control': 'no-store' })
    res.end(body)
  } catch (error) {
    res.writeHead(404).end('not found')
  }
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
console.log(`[shot-chat] 本地服务 http://127.0.0.1:${port}/ ✓（file:// 会被 CORS 拦掉 module ✓）`)

const profile = mkdtempSync(join(tmpdir(), 'dshm-chat-shot-'))
const sweep = () => {
  try {
    execFileSync('pkill', ['-f', `--user-data-dir=${profile}`], { stdio: 'ignore' })
  } catch (error) {
    void error
  }
}
try {
  for (const theme of ['light', 'dark']) {
    const out = join(outDir, `${prefix}-${theme}.png`)
    rmSync(out, { force: true })
    const chrome = spawn(
      CHROME,
      [
        '--headless=new', '--no-sandbox', '--disable-gpu', `--user-data-dir=${profile}`,
        '--no-first-run', '--no-default-browser-check', '--hide-scrollbars',
        '--force-device-scale-factor=3', '--window-size=400,869', '--virtual-time-budget=3000',
        `--screenshot=${out}`,
        `http://127.0.0.1:${port}/dev.html?theme=${theme}${stateArg.length > 0 ? `&state=${stateArg}` : ''}`,
      ],
      { stdio: 'ignore' },
    )
    let ok = false
    for (let i = 0; i < 120; i += 1) {
      await sleep(150)
      try {
        if (statSync(out).size > 1000) {
          ok = true
          break
        }
      } catch (error) {
        void error
      }
    }
    chrome.kill('SIGKILL')
    sweep()
    if (!ok) throw new Error(`${theme} 那张没生成：${out}`)
    console.log(`✓ ${out}（${Math.round(statSync(out).size / 1024)} KB）`)
  }
} finally {
  sweep()
  rmSync(profile, { recursive: true, force: true })
  server.close()
}
