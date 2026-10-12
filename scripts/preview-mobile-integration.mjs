#!/usr/bin/env node
/** Isolated product-page preview: production boot, files, shell and UI; controlled RPC only. */
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { dirname, join, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { RUNTIME_ASSETS } from './lib/runtime-assets.mjs'
import { fixtureBootSource } from './preview-chat-native.mjs'
const root = dirname(dirname(fileURLToPath(import.meta.url)))
const scripts = join(root, 'scripts/fixtures/mobile-integration')
const assetRoot = process.env['DSHM_MOBILE_ASSETS'] || join(root, 'packages/host/assets/dsh-chat')
const allow = new Set(RUNTIME_ASSETS.filter(name => name.startsWith('dsh-chat/')).map(name => name.slice(9)))
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' }
export async function startMobileIntegration() {
  const server = createServer(async (req, res) => {
    const reply = (status, value, type = 'text/plain') => { res.writeHead(status, { 'Content-Type': type + '; charset=utf-8', 'Cache-Control': 'no-store', 'X-DSH-Preview': 'production-boot-controlled-rpc' }); res.end(value) }
    try {
      if (req.method !== 'GET') { reply(405, '仅提供隔离验收资源'); return }
      const url = new URL(req.url, 'http://127.0.0.1'), path = url.pathname
      if (path === '/mobile/boot.js') { reply(200, await readFile(join(root, 'packages/client/src/boot.js')), 'text/javascript'); return }
      if (path === '/fixture/transport.js') {
        reply(200, 'globalThis.__INTEGRATION_PRODUCTION_BOOT__=globalThis.__DSH_MOBILE_BOOT__;\n' + await fixtureBootSource() + '\n' + await readFile(join(scripts, 'transport.js'), 'utf8'), 'text/javascript'); return
      }
      if (path === '/fixture/check.js') { reply(200, await readFile(join(scripts, 'check.js')), 'text/javascript'); return }
      if (path === '/mobile/chat' || path === '/mobile/chat/') {
        let html = await readFile(join(assetRoot, 'page.html'), 'utf8')
        html = html.replace('<script type="module" src="/mobile/chat/app.js">', '<script src="/fixture/transport.js"></script>\n<script type="module" src="/mobile/chat/app.js">')
        html = html.replace('</body>', '<script type="module" src="/fixture/check.js"></script></body>')
        reply(200, html, 'text/html'); return
      }
      if (path === '/mobile/codex') {
        const { CODEX_PAGE_HTML } = await import('../packages/host/src/codex/codex-page.ts')
        reply(200, CODEX_PAGE_HTML.replace('<script src="/mobile/codex/ui.js">', '<script src="/fixture/transport.js"></script><script src="/mobile/codex/ui.js">').replace('</body>', '<script type="module" src="/fixture/check.js"></script></body>'), 'text/html'); return
      }
      if (path === '/mobile/codex/ui.js') { reply(200, await readFile(join(root, 'packages/host/lib/assets/codex/ui.js')), 'text/javascript'); return }
      const name = path.startsWith('/mobile/chat/') ? path.slice(13) : ''
      if (allow.has(name)) { reply(200, await readFile(join(assetRoot, name)), types[extname(name)]); return }
      reply(404, '隔离验收未提供此资源')
    } catch (reason) { reply(500, reason.message) }
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  return { server, url: 'http://127.0.0.1:' + server.address().port + '/mobile/chat?mobile=1&scene=history&theme=dark' }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const preview = await startMobileIntegration(); console.log(preview.url)
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => preview.server.close(() => process.exit(0)))
}
