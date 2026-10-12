#!/usr/bin/env node
/** Dedicated headless browser and isolated fixture; never attaches to a user's existing browser. */
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startMobileIntegration } from './preview-mobile-integration.mjs'
const preview = await startMobileIntegration(), dir = await mkdtemp(join(tmpdir(), 'dsh-mobile-browser-'))
const browser = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', '--user-data-dir=' + dir, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] })
let stderr = ''; browser.stderr.on('data', chunk => { stderr += chunk.toString() })
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
let ws, serial = 0; const pending = new Map(), reports = []
try {
  let port
  for (let i = 0; i < 150; i++) { try { port = Number((await readFile(join(dir, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); break } catch { if (browser.exitCode !== null) throw new Error('Chrome exited: ' + stderr.slice(-1500)); await pause(50) } }
  if (!port) throw new Error('Dedicated browser did not start: ' + stderr.slice(-1500))
  const pages = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json(), page = pages.find(page => page.type === 'page')
  ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }) })
  ws.addEventListener('message', event => { const data = JSON.parse(event.data); const callback = pending.get(data.id); if (callback) { pending.delete(data.id); data.error ? callback.reject(new Error(data.error.message)) : callback.resolve(data.result) } })
  const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++serial; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })) })
  await send('Page.enable'); await send('Runtime.enable')
  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 2 })
  const evaluate = async expression => (await send('Runtime.evaluate', { expression, returnByValue: true })).result?.value
  const touchDrag = async (x, y, toX) => {
    await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 81 }] })
    for (let step = 1; step <= 3; step++) { await pause(25); await send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + (toX - x) * step / 3, y, id: 81 }] }) }
    await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await pause(350)
  }
  const matrix = process.env['DSHM_MOBILE_SMOKE'] ? [[412, 915, 'dark', 'dsh']] : [[412,915,'dark','dsh'],[390,844,'dark','dsh'],[360,800,'dark','dsh'],[412,915,'light','dsh'],[390,844,'light','dsh'],[360,800,'light','dsh'],[390,844,'dark','codex']]
  for (const [width, height, theme, backend] of matrix) {
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: true, screenWidth: width, screenHeight: height })
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }] })
    const url = new URL(preview.url); if (backend === 'codex') url.pathname = '/mobile/codex'; url.searchParams.set('viewport', width + 'x' + height); url.searchParams.set('theme', theme)
    await send('Page.navigate', { url: url.toString() })
    let report
    for (let i = 0; i < 400; i++) {
      const result = await send('Runtime.evaluate', { expression: "document.querySelector('#mobile-integration-result')?.getAttribute('data-result')", returnByValue: true })
      if (result.result?.value) { report = JSON.parse(decodeURIComponent(result.result.value)); break } await pause(50)
    }
    if (!report) { const result = await send('Runtime.evaluate', { expression: 'document.body.innerText', returnByValue: true }); throw new Error('Browser check timed out: ' + String(result.result?.value).slice(0, 1200)) }
    const label = backend + '-' + width + 'x' + height + '-' + theme
    if (backend === 'dsh' && report.errors.length === 0) {
      const add = (label, pass) => { report.checks.push({ label, pass: Boolean(pass) }); if (!pass) report.ok = false }
      const y = await evaluate("document.querySelector('main').getBoundingClientRect().top + 180")
      await touchDrag(width / 2, y, width / 2 + 100)
      add('真实触摸从中央右滑打开主侧栏', await evaluate("document.body.getAttribute('data-dsh-mobile-drawer') === 'open'"))
      report.evidence.nativeTouchTarget = await evaluate("(() => { const rows = []; for (let node = document.elementFromPoint(200," + y + "); node && rows.length < 12; node = node.parentElement) { const style = getComputedStyle(node); rows.push({ tag: node.tagName, class: node.className, width: node.clientWidth, scrollWidth: node.scrollWidth, overflowX: style.overflowX, touchAction: style.touchAction }); } return rows; })()")
      await touchDrag(200, y, 50)
      add('真实触摸反向关闭主侧栏', await evaluate("document.body.getAttribute('data-dsh-mobile-drawer') !== 'open'"))
      await touchDrag(width / 2, y, width / 2 - 100)
      add('真实触摸从中央左滑打开文件面板', await evaluate("document.body.getAttribute('data-dshm-files') === 'open'"))
      await touchDrag(width - 160, y, width - 20)
      add('真实触摸反向关闭文件面板', await evaluate("document.body.getAttribute('data-dshm-files') !== 'open'"))
      await evaluate("(() => { const node = document.createElement('pre'); node.id = 'native-swipe-code-check'; node.style.cssText = 'position:fixed;top:180px;left:32px;width:220px;overflow-x:auto;white-space:pre;z-index:50'; node.textContent = 'wide_code_column_'.repeat(100); document.querySelector('main').appendChild(node); })()")
      const codeBox = await evaluate("(() => { const box = document.querySelector('#native-swipe-code-check').getBoundingClientRect(); return { x: box.left + box.width * .75, y: box.top + box.height / 2 }; })()")
      await touchDrag(codeBox.x, codeBox.y, codeBox.x - 120)
      report.evidence.nativeCodeScroll = await evaluate("({ left: document.querySelector('#native-swipe-code-check').scrollLeft, drawer: document.body.getAttribute('data-dsh-mobile-drawer'), files: document.body.getAttribute('data-dshm-files') })")
      add('真实触摸横滚代码且不打开侧栏', await evaluate("document.querySelector('#native-swipe-code-check').scrollLeft > 0 && document.body.getAttribute('data-dsh-mobile-drawer') !== 'open' && document.body.getAttribute('data-dshm-files') !== 'open'"))
      await evaluate("document.querySelector('#native-swipe-code-check').remove()")
    }
    const screenshot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }); await writeFile(join(dir, label + '.png'), Buffer.from(screenshot.data, 'base64'))
    const minimum = backend === 'codex' ? 6 : 48
    if (report.checks.length < minimum) { report.ok = false; report.errors.push('断言数低于最低要求 ' + minimum) }
    reports.push({ label, ...report }); console.log(label + ': ' + report.checks.filter(check => check.pass).length + '/' + report.checks.length + (report.ok ? ' PASS' : ' FAIL ' + [...report.errors, ...report.checks.filter(check => !check.pass).map(check => check.label)].join('; ')))
    if (!report.ok) break
    if (backend === 'dsh' && process.env['DSHM_CAPTURE_STATISTICS'] === '1') {
      for (const kind of ['context', 'turns', 'tokens']) {
        await send('Runtime.evaluate', { expression: "document.querySelector('#input').click(); document.querySelector('[data-cell=" + kind + "]').click()" })
        const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }); await writeFile(join(dir, label + '-stats-' + kind + '.png'), Buffer.from(shot.data, 'base64'))
      }
    }
  }
  await writeFile(join(dir, 'report.json'), JSON.stringify({ reports, directory: dir }, null, 2))
  console.log('Browser evidence: ' + dir); if (reports.some(report => !report.ok)) process.exitCode = 1
} finally {
  ws?.close(); browser.kill('SIGTERM'); await new Promise(resolve => preview.server.close(resolve))
}
