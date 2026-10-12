#!/usr/bin/env node
/**
 * Local contract-fixture preview of the new native mobile chat page.
 * Serves ONLY allowlisted source assets from this repository; replaces only the
 * page's /mobile/boot.js script URL. No proxy, live DSH, browser, CDP, or build.
 * Mainline owns starting/stopping this server and any CUA visual inspection.
 */
import { createServer } from 'node:http'
import { readFile, realpath } from 'node:fs/promises'
import { dirname, join, relative, isAbsolute } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
export const projectRoot = dirname(scriptDir)
const assetRoot = join(projectRoot, 'packages/host/assets/dsh-chat')
const fixtureRoot = join(scriptDir, 'fixtures/chat-native')
export const scenes = Object.freeze(['welcome', 'chat', 'running', 'trace', 'question', 'approval', 'history'])
const productAssets = Object.freeze({
  'app.js': 'text/javascript; charset=utf-8',
  'ui.js': 'text/javascript; charset=utf-8',
  'poller.js': 'text/javascript; charset=utf-8',
  'projection.js': 'text/javascript; charset=utf-8',
  'conversation.js': 'text/javascript; charset=utf-8',
  'trace.js': 'text/javascript; charset=utf-8',
  'composer.js': 'text/javascript; charset=utf-8',
  'navigation.js': 'text/javascript; charset=utf-8',
  'stats.js': 'text/javascript; charset=utf-8',
  'shell.js': 'text/javascript; charset=utf-8',
  'management.js': 'text/javascript; charset=utf-8',
  'management.css': 'text/css; charset=utf-8',
  'theme.css': 'text/css; charset=utf-8',
  'file-panel.css': 'text/css; charset=utf-8',
  'native.css': 'text/css; charset=utf-8',
  'native-tokens.css': 'text/css; charset=utf-8',
  'whale.svg': 'image/svg+xml',
})

async function readProjectAsset(name) {
  // Even an allowlisted filename must not resolve through a symlink outside this project.
  const resolved = await realpath(join(assetRoot, name))
  const rel = relative(projectRoot, resolved)
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('预览资源越过项目边界')
  return readFile(resolved)
}
export async function fixtureBootSource() {
  const parts = await Promise.all(['data.js', 'image-data.js', 'boot.js'].map(name => readFile(join(fixtureRoot, name), 'utf8')))
  return parts.join('\n;\n')
}
export async function fixturePageSource() {
  const original = (await readProjectAsset('page.html')).toString('utf8')
  const needle = 'src="/mobile/boot.js"'
  if (original.split(needle).length !== 2) throw new Error('page.html 应恰好包含一个 /mobile/boot.js 引用')
  return original.replace(needle, 'src="/mobile/chat/fixtureboot.js"')
}
export function createPreviewHandler() {
  return async (req, res) => {
    const headers = {
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'self'",
      'X-DSH-Preview': 'contract-fixture-not-live-dsh',
    }
    function reply(status, body, contentType = 'text/plain; charset=utf-8') {
      const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body)
      res.writeHead(status, { ...headers, 'Content-Type': contentType, 'Content-Length': bytes.length })
      res.end(req.method === 'HEAD' ? undefined : bytes)
    }
    try {
      if (!['GET', 'HEAD'].includes(req.method)) { reply(405, '合约夹具仅提供静态资源'); return }
      const host = req.headers.host || ''
      if (!/^127\.0\.0\.1:\d+$/.test(host) || Number(host.slice(host.lastIndexOf(':') + 1)) !== req.socket.localPort) {
        reply(400, '合约夹具只接受其 127.0.0.1 本地来源'); return
      }
      const url = new URL(req.url || '/', 'http://' + host)
      const path = url.pathname
      if (path === '/mobile/chat' || path === '/mobile/chat/') {
        const scene = url.searchParams.get('scene') || 'chat'
        if (!scenes.includes(scene)) { reply(400, '未知夹具场景：' + scene); return }
        const theme = url.searchParams.get('theme') || 'dark'
        if (!['dark', 'light'].includes(theme)) { reply(400, '未知夹具主题：' + theme); return }
        reply(200, await fixturePageSource(), 'text/html; charset=utf-8'); return
      }
      if (path === '/mobile/chat/fixtureboot.js') {
        reply(200, await fixtureBootSource(), 'text/javascript; charset=utf-8'); return
      }
      const name = path.startsWith('/mobile/chat/') ? path.slice('/mobile/chat/'.length) : ''
      if (Object.hasOwn(productAssets, name)) {
        reply(200, await readProjectAsset(name), productAssets[name]); return
      }
      reply(404, '合约夹具未提供此资源；没有代理或实际 DSH 通道')
    } catch (error) {
      reply(500, '合约夹具资源错误：' + String(error.message || error))
    }
  }
}
export async function startPreview(scene = 'chat') {
  if (!scenes.includes(scene)) throw new Error('未知夹具场景：' + scene)
  // Check entry resources before listening. Assets are reread per request so mainline edits remain visible.
  await Promise.all([fixturePageSource(), fixtureBootSource()])
  const server = createServer(createPreviewHandler())
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve() })
  })
  const address = server.address()
  const url = 'http://127.0.0.1:' + address.port + '/mobile/chat?scene=' + scene + '&theme=dark'
  return { server, url, scene }
}
async function main() {
  const args = process.argv.slice(2)
  if (args.includes('--help')) {
    console.log('用法：node scripts/preview-chat-native.mjs [--scene welcome|chat|running|trace|question|approval|history]')
    console.log('纯 Node 合约校验：node scripts/preview-chat-native.mjs --check')
    console.log('只监听 127.0.0.1 的系统临时端口；本地合约夹具，不连接实际 DSH。')
    return
  }
  if (args.length === 1 && args[0] === '--check') {
    const { runChecks } = await import('./fixtures/chat-native/schema-check.mjs')
    await runChecks()
    return
  }
  let scene = 'chat'
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--scene' && args[i + 1]) scene = args[++i]
    else if (args[i].startsWith('--scene=')) scene = args[i].slice('--scene='.length)
    else throw new Error('未知参数：' + args[i] + '；端口固定为系统临时端口，不能指定实际服务端口')
  }
  const { server, url } = await startPreview(scene)
  console.log('【合约夹具预览 · 非实际 DSH 会话】')
  console.log(url)
  console.log('场景：' + scenes.join(' / ') + '；修改 URL 的 scene 切换。')
  console.log('主题：theme=dark（默认）/ light；只改变该夹具页面。')
  console.log('服务只读取本项目新会话页资源。Ctrl+C 停止；没有生产代理、DSH 实例或浏览器进程。')
  let closing = false
  const stop = () => {
    if (closing) return
    closing = true
    server.close(() => { process.exitCode = 0 })
    server.closeIdleConnections()
  }
  process.once('SIGINT', stop); process.once('SIGTERM', stop)
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch(error => { console.error('合约夹具预览失败：' + String(error.message || error)); process.exitCode = 1 })
}
