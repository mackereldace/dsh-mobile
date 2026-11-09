#!/usr/bin/env node
/**
 * **文件面板 / 文档预览的性能探针**（把「卡」拆成「网络」与「渲染」两笔账）。
 *
 * ## 为什么要它
 *
 * 用户真机反馈："手机访问右侧文件夹、预览文档都有明显的卡顿，不知道是网络还是渲染。"
 * 这两件事在手机上**症状一样**（点了之后一段时间没反应），但修法完全不同：
 *   · **网络**：每一跳 RPC 一个 RTT、payload 多大、有没有串行等两次；
 *   · **渲染**：主线程被一段同步 JS + 布局挡住多久、DOM 节点多少。
 * 没有测量就只能猜（本项目为"盲改"付过 4 次回归的学费，见 SKILL.md 的 UI 走查那段）。
 *
 * ## 怎么把两笔账分开
 *
 * 1. 用 `preview-mobile-integration.mjs` 那套**真实 boot.js + 真实聊天页 + 受控 RPC**
 *    （不连 DSH、不碰生产）：`mobile/files/list` 与 `mobile/files/read` 的**数据由本脚本造**，
 *    于是"目录项数 / 文件大小"是可控变量；
 * 2. 在页面里给 `mobile/files/*` 注入**可配的固定延迟**（模拟 RTT）⇒
 *    `响应到达 → 行/正文出现` 那段就只剩**渲染**；
 * 3. Chrome 的 `Emulation.setCPUThrottlingRate` 把 CPU 降速（4×/6× ≈ 中端安卓）——
 *    桌面测出来的 50ms，在手机上是 200–300ms，不降速就会得出"不卡"的错误结论。
 *
 * ## 判据（打印什么）
 *
 * 每个场景一行：`等待=网络+解析` / `渲染=响应到首帧` / `长任务` / `布局` / `样式` / `节点`。
 * 长任务（>50ms）是最接近"用户感觉到的卡"的量：它期间手指、动画、点击**全都不走**。
 *
 * 用法：
 *   node scripts/perf-files-panel.mjs                     # 默认 1×/4×/6× CPU
 *   node scripts/perf-files-panel.mjs --cpu 6             # 只跑一档
 *   node scripts/perf-files-panel.mjs --rtt 120           # 所有场景加 120ms 模拟 RTT
 *   node scripts/perf-files-panel.mjs --real 10-交接文档.md # 用真实文件当预览内容
 *   node scripts/perf-files-panel.mjs --json /tmp/perf.json
 *
 * ★ 它**只读**：不开生产 DSH、不改任何 profile、不写 `packages/*`。
 *   临时 profile 目录按自己的路径回收（与 chrome-clone-guard 同一条纪律）。
 */

import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const root = resolve(here, '..')
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const argv = process.argv.slice(2)
const flag = (name, fallback) => {
  const bare = name.replace(/^--?/, '')
  const index = argv.findIndex((arg) => arg === name || arg === bare)
  return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : fallback
}
const CPU_RATES = String(flag('--cpu', '1,4,6')).split(',').map((value) => Number(value)).filter((value) => value > 0)
const RTT = Number(flag('--rtt', '0'))
const REAL_FILE = flag('--real', '')
const JSON_OUT = flag('--json', '')
const MOBILE_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36'

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

/** 起一个无头 Chrome，返回 `{ base, kill }`；调试端口用 0 交给 Chrome 自己挑（避免撞端口）。 */
async function launchChrome() {
  const profile = mkdtempSync(join(tmpdir(), 'perf-files-'))
  const child = spawn(
    CHROME,
    [
      '--headless=new',
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--ignore-certificate-errors',
      '--hide-scrollbars',
      '--window-size=412,915',
      'about:blank',
    ],
    { stdio: 'ignore', detached: true },
  )
  const portFile = join(profile, 'DevToolsActivePort')
  let base = ''
  for (let i = 0; i < 100; i++) {
    try {
      const line = readFileSync(portFile, 'utf8').split('\n')[0].trim()
      if (line !== '') {
        base = `http://127.0.0.1:${line}`
        break
      }
    } catch (error) {
      void error
    }
    await sleep(100)
  }
  if (base === '') throw new Error('Chrome 没有起来（DevToolsActivePort 没出现）')
  return {
    base,
    kill: () => {
      try {
        process.kill(-child.pid)
      } catch (error) {
        void error
      }
      // ★ 只删**自己这个** profile（按路径）；绝不按端口/名字杀 Chrome（会误伤用户开着的窗口）。
      try {
        rmSync(profile, { recursive: true, force: true })
      } catch (error) {
        void error
      }
    },
  }
}

/** 打开一个页面并接上 CDP。 */
async function openPage(base, url) {
  const response = await fetch(`${base}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })
  const target = await response.json()
  const socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((done, fail) => {
    socket.onopen = done
    socket.onerror = () => fail(new Error('CDP WebSocket 连不上'))
  })
  let seq = 0
  const pending = new Map()
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data)
    if (message.id === undefined) return
    const slot = pending.get(message.id)
    pending.delete(message.id)
    if (slot === undefined) return
    if (message.error !== undefined) slot.fail(new Error(JSON.stringify(message.error)))
    else slot.done(message.result)
  }
  const send = (method, params = {}) =>
    new Promise((done, fail) => {
      const id = ++seq
      pending.set(id, { done, fail })
      socket.send(JSON.stringify({ id, method, params }))
    })
  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (result.exceptionDetails !== undefined) {
      throw new Error(result.exceptionDetails.exception?.description ?? JSON.stringify(result.exceptionDetails))
    }
    return result.result.value
  }
  await send('Page.enable')
  await send('Runtime.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: 412, height: 915, deviceScaleFactor: 2.75, mobile: true })
  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
  await send('Emulation.setUserAgentOverride', { userAgent: MOBILE_UA })
  await send('Page.navigate', { url })
  return { send, evaluate, close: () => socket.close() }
}

/**
 * 页面里的测量器（只注入一次）。
 *
 * 它做的三件事：
 *   · 把 `mobile/files/{list,read}` **接管**成受控数据（目录项数 / 文件字节 / 固定延迟）；
 *   · 记录 `请求发出 / 响应到达 / 首帧` 三个时刻 ⇒ 网络与渲染分别算得出来；
 *   · 用 `PerformanceObserver('longtask')` 收**长任务**（>50ms 的同步阻塞，就是"卡"）。
 */
const PAGE_HARNESS = `
globalThis.__PERF__ = (() => {
  const state = { marks: {}, longTasks: [], pendingImageB64: '', realB64: '', realSize: 0 }
  const mark = (name, at) => { state.marks[name] = at === undefined ? performance.now() : at }
  const observer = () => {
    state.longTasks = []
    try { globalThis.__LTO__?.disconnect() } catch (error) { void error }
    globalThis.__LTO__ = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) state.longTasks.push(Math.round(entry.duration))
    })
    try { globalThis.__LTO__.observe({ type: 'longtask', buffered: false }) } catch (error) { void error }
  }
  const frame = () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))
  const waitUntil = async (test, timeout = 60000) => {
    const started = performance.now()
    while (performance.now() - started < timeout) {
      if (test()) return performance.now() - started
      await new Promise((done) => requestAnimationFrame(done))
    }
    return -1
  }
  const mdUnit = '# 标题\\n\\n这是**加粗**、\\u0060代码\\u0060、以及 x_1^2。\\n\\n- 项目一\\n- 项目二\\n\\n\\u0060\\u0060\\u0060js\\nconst a = 1\\n\\u0060\\u0060\\u0060\\n\\n| a | b |\\n|---|---|\\n| 1 | 2 |\\n\\n'
  const makeMarkdown = (kb) => {
    const bytes = new TextEncoder().encode(mdUnit.repeat(Math.max(1, Math.round((kb * 1024) / 100))))
    let b64 = ''
    // 32766 = 3 的整数倍 ⇒ 每段 btoa 都独立成立（不是 3 的倍数会在段边界丢字节，atob 直接报错）
    for (let i = 0; i < bytes.length; i += 32766) b64 += btoa(String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + 32766, bytes.length))))
    return { b64, size: bytes.length }
  }
  const makeEntries = (count, extra) => {
    const entries = extra === undefined ? [] : extra.slice()
    for (let i = 0; i < count; i++) {
      entries.push(i % 6 === 0
        ? { name: 'directory-' + i, type: 'directory', size: 0 }
        : { name: 'file-' + i + '.md', type: 'file', size: 2345 })
    }
    return entries
  }
  const install = (options) => {
    state.calls = []
    const api = globalThis.__DSH_MOBILE_BOOT__
    if (api.__perfPatched !== true) {
      api.__perfOriginalRpc = api.tunnel.rpc.bind(api.tunnel)
      api.tunnel.rpc = async (method, payload) => {
        const args = (payload && payload.args) || {}
        // ★ 记调用时刻（断言"打开面板那两条请求是不是并发发出"要它 ✓）
        if (state.calls !== undefined) state.calls.push({ method: method, at: Math.round(performance.now()) })
        if (method === 'mobile/files/list') {
          mark('listRequested')
          if (state.rtt > 0) await new Promise((done) => setTimeout(done, state.rtt))
          mark('listArrived')
          return { result: { ok: true, value: { path: args.path, parent: null, entries: state.entries } } }
        }
        if (method === 'mobile/files/read') {
          mark('readRequested')
          const wanted = state.payload
          if (state.rtt > 0) await new Promise((done) => setTimeout(done, state.rtt))
          mark('readArrived')
          // ★ 只回**一段**：真宿主也是按 ≤1MiB 分块回的；这里刻意不做多块，参数才可控。
          return { result: { ok: true, value: { path: args.path, data: wanted.b64, offset: 0, eof: true, size: wanted.size } } }
        }
        return api.__perfOriginalRpc(method, payload)
      }
      /**
       * workspace/follow 走的是**流**（openStream），不是一元 RPC ✗ ——
       * 打开面板的第一跳就是它。不裹它，--rtt 就只延迟了第二跳，
       * 「打开面板」那一行会**系统性少算一个 RTT**（错得刚好让人以为网络没事）。
       */
      api.__perfOriginalOpenStream = api.tunnel.openStream.bind(api.tunnel)
      api.tunnel.openStream = (method, payload) => {
        const stream = api.__perfOriginalOpenStream(method, payload)
        if (method !== 'workspace/follow' || state.rtt <= 0) return stream
        mark('workspaceStreamOpened')
        return {
          [Symbol.asyncIterator]: () => {
            const inner = stream[Symbol.asyncIterator]()
            return {
              next: async () => {
                await new Promise((done) => setTimeout(done, state.rtt))
                return inner.next()
              },
              return: async () => (typeof inner.return === 'function' ? inner.return() : { done: true }),
            }
          },
        }
      }
      api.__perfPatched = true
    }
    state.entries = options.entries
    state.payload = options.payload
    state.rtt = options.rtt
  }
  const openPanel = async () => {
    const shell = globalThis.__DSH_MOBILE_BOOT__.shell
    if (document.body.dataset.dshmFiles === 'open') {
      shell?.closeFiles?.()
      await sleepish(420)
    }
    return true
  }
  const sleepish = (ms) => new Promise((done) => setTimeout(done, ms))
  /** 点文件夹键 → 看到工作区列表（或上次记住的目录）。返回"点击到首屏出现"的毫秒数。 */
  const openAndEnter = async () => {
    await openPanel()
    mark('tapOpen')
    const frames = []
    let last = performance.now()
    const sampler = () => { const now = performance.now(); frames.push(Math.round(now - last)); last = now; if (sampling) requestAnimationFrame(sampler) }
    let sampling = true
    requestAnimationFrame(sampler)
    document.querySelector('#files').click()
    const first = await waitUntil(() => document.querySelector('#dsh-mobile-sheet-body .dshm-ws, #dsh-mobile-sheet-body .dshm-file') !== null, 15000)
    mark('panelFirstPaint')
    await sleepish(320)
    sampling = false
    const workspaces = document.querySelectorAll('#dsh-mobile-sheet-body .dshm-ws')
    if (workspaces.length > 0) {
      mark('tapWorkspace')
      workspaces[0].click()
      await waitUntil(() => document.querySelector('#dsh-mobile-sheet-body .dshm-file') !== null, 20000)
      mark('rowsFirstPaint')
    } else {
      mark('tapWorkspace')
      mark('rowsFirstPaint')
    }
    await frame()
    mark('rowsFrame')
    return {
      open: Math.round((state.marks.panelFirstPaint || 0) - state.marks.tapOpen),
      rows: Math.round((state.marks.rowsFrame || 0) - state.marks.rowsFirstPaint),
      rowsTotal: Math.round((state.marks.rowsFrame || 0) - state.marks.tapWorkspace),
      listNetwork: Math.round((state.marks.listArrived || 0) - state.marks.listRequested),
      rowCount: document.querySelectorAll('#dsh-mobile-sheet-body .dshm-file').length,
      frameGaps: frames.filter((value) => value > 0),
    }
  }
  const tapEntry = async (name, selector) => {
    const rows = [...document.querySelectorAll('#dsh-mobile-sheet-body .dshm-file-head')]
    const row = rows.find((element) => element.textContent.includes(name))
    if (row === undefined) throw new Error('列表里找不到 ' + name)
    mark('tapPreview')
    row.click()
    const waited = await waitUntil(() => document.querySelector(selector) !== null || document.querySelector('.dshm-preview-fallback') !== null, 120000)
    mark('previewFirstPaint')
    await frame()
    mark('previewFrame')
    return {
      wait: Math.round(waited),
      network: Math.round((state.marks.readArrived || 0) - state.marks.readRequested),
      render: Math.round((state.marks.previewFirstPaint || 0) - (state.marks.readArrived || state.marks.previewFirstPaint || 0)),
      frame: Math.round((state.marks.previewFrame || 0) - (state.marks.previewFirstPaint || 0)),
      nodes: (document.querySelector(selector)?.querySelectorAll('*').length) ?? 0,
      meta: document.querySelector('.dshm-preview-meta')?.textContent ?? '',
      fallback: document.querySelector('.dshm-preview-fallback')?.textContent ?? '',
      longTasks: state.longTasks.slice(),
      scroll: await (async () => {
        const host = document.querySelector('#dsh-mobile-sheet-body')
        if (host === null) return null
        const gaps = []
        let last = performance.now()
        await new Promise((done) => {
          let i = 0
          const step = () => {
            const now = performance.now()
            gaps.push(now - last)
            last = now
            host.scrollTop += 80
            if (++i < 40) requestAnimationFrame(step)
            else done()
          }
          requestAnimationFrame(step)
        })
        const sorted = gaps.slice(3).sort((a, b) => a - b)
        return { median: Math.round(sorted[sorted.length >> 1] ?? 0), max: Math.round(sorted[sorted.length - 1] ?? 0) }
      })(),
    }
  }
  return {
    state,
    observer,
    install,
    openAndEnter,
    tapEntry,
    makeMarkdown,
    makeEntries,
    sleepish,
    waitUntil,
    setPayload: (payload) => { state.payload = payload },
    /** 纯渲染对照：把同一条 markdown 直接交给页面里的渲染器（不经网络、不建预览屏）。 */
    renderOnly: async (b64) => {
      const bytes = Uint8Array.from(atob(b64), (char) => char.charCodeAt(0))
      const text = new TextDecoder('utf-8').decode(bytes)
      const api = globalThis.__DSH_MOBILE_BOOT__
      const host = document.createElement('div')
      host.className = 'dshm-md'
      document.body.appendChild(host)
      observer()
      const started = performance.now()
      api.shell.renderMarkdownInto(host, text)
      const built = performance.now()
      await frame()
      const painted = performance.now()
      const out = { build: Math.round(built - started), layout: Math.round(painted - built), nodes: host.querySelectorAll('*').length, longTasks: state.longTasks.slice() }
      host.remove()
      return out
    },
  }
})();
'ok'
`

async function main() {
  const integration = await import('./preview-mobile-integration.mjs')
  const server = await integration.startMobileIntegration()
  const chrome = await launchChrome()
  const page = await openPage(chrome.base, server.url)
  const results = []
  try {
    for (let i = 0; i < 200; i++) {
      if (await page.evaluate(`Boolean(globalThis.__DSH_MOBILE_BOOT__?.tunnel && document.querySelector('#files'))`)) break
      await sleep(100)
    }
    await page.evaluate(PAGE_HARNESS)
    await page.send('Performance.enable')

    const realText = REAL_FILE === '' ? null : (() => {
      const bytes = readFileSync(resolve(process.cwd(), REAL_FILE)).subarray(0, 200 * 1024)
      return { b64: Buffer.from(bytes.toString('utf8'), 'utf8').toString('base64'), size: Buffer.byteLength(bytes.toString('utf8')) }
    })()
    if (realText !== null) {
      await page.evaluate(`globalThis.__PERF__.state.realB64 = ${JSON.stringify(realText.b64)}; globalThis.__PERF__.state.realSize = ${realText.size}; 'ok'`)
    }
    // 一张真的 PNG（3MB 级）用来量图片预览那一笔账：这里只要有能解码的图，重复拼成大约 3MB 即可。
    const pngPath = join(root, 'docs/ui')
    let imageB64 = ''
    try {
      const names = readdirSync(pngPath).filter((name) => name.endsWith('.png')).sort()
      if (names.length > 0) imageB64 = readFileSync(join(pngPath, names[names.length - 1])).toString('base64')
    } catch (error) {
      void error
    }

    const metricsNow = async () => Object.fromEntries((await page.send('Performance.getMetrics')).metrics.map((item) => [item.name, item.value]))

    /**
     * `--assert`：**把这一轮的行为钉成断言**（测量模式只是打印，不改判据 ✓）。
     *
     * 钉四条（都是这一轮真的改过、而且能观测得到的）：
     *   ① **打开面板不再串行等两跳**：`openInApp/apps` 的请求时刻必须**早于**工作区返回
     *      （旧实现是 `await` 完第一跳才发第二跳 ⇒ 这条断言当场红 ✓，变异验证见交接文档）；
     *   ② **200 KB markdown 首屏只画一片 + 底部有「继续显示」**（不分片 ⇒ 没有那个按钮 ✗）；
     *   ③ 点一次「继续显示」⇒ 分片数 +1（且不再重画第一片 ✓）；
     *   ④ **小文档（≤ 首屏预算）一次画完、不出现「继续显示」**（别把小的也拆了 ✓）；
     *   ⑤ 6× CPU 下**最长长任务 < 400 ms**（分片前实测 855 ms ⇒ 这条会红 ✓）。
     */
    if (argv.includes('--assert')) {
      await page.send('Emulation.setCPUThrottlingRate', { rate: 6 })
      const results = []
      const record = (label, ok, detail) => {
        results.push({ label, ok, detail })
        console.log(`${ok ? '✓' : '✗'} ${label}${detail === undefined ? '' : '｜' + detail}`)
      }
      const bigPayload = await page.evaluate(`globalThis.__PERF__.makeMarkdown(200)`)
      const smallPayload = await page.evaluate(`globalThis.__PERF__.makeMarkdown(8)`)
      const entries = await page.evaluate(`globalThis.__PERF__.makeEntries(20)`)
      // ① 并发：两条请求的先后
      await page.evaluate(`globalThis.__PERF__.install(${JSON.stringify({ entries, payload: bigPayload, rtt: 120 })}); globalThis.__PERF__.observer(); 'ok'`)
      await page.evaluate(`globalThis.__PERF__.openAndEnter()`)
      const calls = await page.evaluate(`globalThis.__PERF__.state.calls.map((call) => call.method)`)
      const appsAt = calls.indexOf('mobile/openInApp/apps')
      const listAt = calls.indexOf('mobile/files/list')
      record(
        '① 打开面板时「打开方式」与工作区列表**并发**发出（不再等第一跳回来）',
        appsAt >= 0 && listAt > appsAt,
        `apps@${appsAt}｜list@${listAt}｜顺序=${JSON.stringify(calls.slice(0, 4))}`,
      )
      // ②③④⑤ 预览
      await page.evaluate(`globalThis.__PERF__.install(${JSON.stringify({ entries, payload: bigPayload, rtt: 0 })}); globalThis.__PERF__.observer(); 'ok'`)
      const first = await page.evaluate(`(async () => {
        await globalThis.__PERF__.openAndEnter()
        const preview = await globalThis.__PERF__.tapEntry('file-1', '.dshm-md, .dshm-preview-text')
        return {
          parts: document.querySelectorAll('[data-dshm-md-part]').length,
          footer: Boolean(document.querySelector('[data-dshm-preview-more]')),
          progress: document.querySelector('[data-dshm-preview-progress]')?.textContent ?? '',
          longTasks: preview.longTasks,
        }
      })()`)
      record('② 200 KB markdown 首屏只画 1 片且给出「继续显示」', first.parts === 1 && first.footer === true, `分片=${first.parts}｜进度=${first.progress}`)
      const second = await page.evaluate(`(async () => {
        document.querySelector('[data-dshm-preview-next]')?.click()
        await new Promise((done) => setTimeout(done, 400))
        return {
          parts: document.querySelectorAll('[data-dshm-md-part]').length,
          progress: document.querySelector('[data-dshm-preview-progress]')?.textContent ?? '',
        }
      })()`)
      record('③ 点「继续显示」⇒ 追加一片（第一片不重画）', second.parts === first.parts + 1, `分片 ${first.parts}→${second.parts}｜进度=${second.progress}`)
      record(
        '⑤ 6× CPU 下最长长任务 < 400 ms（分片前实测 855 ms）',
        Math.max(0, ...(first.longTasks ?? []), 0) < 400,
        `长任务=${JSON.stringify(first.longTasks)}`,
      )
      await page.evaluate(`globalThis.__PERF__.install(${JSON.stringify({ entries, payload: smallPayload, rtt: 0 })}); 'ok'`)
      const small = await page.evaluate(`(async () => {
        await globalThis.__PERF__.openAndEnter()
        await globalThis.__PERF__.tapEntry('file-1', '.dshm-md, .dshm-preview-text')
        return { footer: Boolean(document.querySelector('[data-dshm-preview-more]')), parts: document.querySelectorAll('[data-dshm-md-part]').length }
      })()`)
      record('④ 小文档（8 KB）一次画完，不出现「继续显示」', small.footer === false && small.parts === 1, `分片=${small.parts}`)
      const failed = results.filter((item) => item.ok !== true)
      console.log(`\n${results.length - failed.length}/${results.length} 条通过`)
      if (failed.length > 0) process.exitCode = 1
      if (JSON_OUT !== '') writeFileSync(JSON_OUT, JSON.stringify({ when: new Date().toISOString(), mode: 'assert', results }, null, 2))
      return
    }

    const scenarios = [
      { id: 'panel-open-500', label: '打开面板 + 进 500 项目录', entries: 500 },
      { id: 'list-5000', label: '进 5000 项目录（只渲染 200 行）', entries: 5000 },
      { id: 'md-20k', label: '预览 markdown 20 KB', entries: 20, md: 20 },
      { id: 'md-100k', label: '预览 markdown 100 KB', entries: 20, md: 100 },
      { id: 'md-200k', label: '预览 markdown 200 KB（宿主上限）', entries: 20, md: 200 },
    ]
    if (realText !== null) scenarios.push({ id: 'md-real', label: `预览真实文件前 200 KB（${REAL_FILE}）`, entries: 20, real: true })

    for (const rate of CPU_RATES) {
      await page.send('Emulation.setCPUThrottlingRate', { rate })
      for (const scenario of scenarios) {
        const payload = scenario.real === true
          ? (await page.evaluate(`({ b64: globalThis.__PERF__.state.realB64, size: globalThis.__PERF__.state.realSize })`))
          : scenario.md === undefined
            ? { b64: '', size: 0 }
            : await page.evaluate(`globalThis.__PERF__.makeMarkdown(${scenario.md})`)
        const entries = await page.evaluate(`globalThis.__PERF__.makeEntries(${scenario.entries})`)
        await page.evaluate(`globalThis.__PERF__.install(${JSON.stringify({ entries, payload, rtt: RTT })}); globalThis.__PERF__.observer(); 'ok'`)
        const before = await metricsNow()
        const raw = await page.evaluate(`(async () => {
          const listing = await globalThis.__PERF__.openAndEnter()
          const out = { listing }
          if (${scenario.md !== undefined || scenario.real === true}) {
            const file = out.listing.rowCount > 0 ? [...document.querySelectorAll('#dsh-mobile-sheet-body .dshm-file-head')].map((el) => el.textContent) : []
            const name = file.find((text) => text.includes(scenarioName())) || file[0]
            out.preview = await globalThis.__PERF__.tapEntry(${JSON.stringify(scenario.real === true ? 'doc' : 'file-1')}, '.dshm-md, .dshm-preview-text')
          }
          function scenarioName() { return ${JSON.stringify(scenario.real === true ? 'doc' : 'file-1')} }
          return out
        })()`)
        const after = await metricsNow()
        const delta = (key) => Math.round((after[key] - before[key]) * 1000)
        const row = {
          cpu: rate,
          id: scenario.id,
          label: scenario.label,
          rtt: RTT,
          ...raw,
          task: delta('TaskDuration'),
          script: delta('ScriptDuration'),
          layout: delta('LayoutDuration'),
          style: delta('RecalcStyleDuration'),
          nodes: after.Nodes,
          heapMB: Math.round((after.JSHeapUsedSize / 1048576) * 10) / 10,
        }
        results.push(row)
        const preview = row.preview
        console.log(
          `CPU ${rate}× | ${scenario.label}\n` +
            `   打开面板 ${row.listing.open}ms（列表 RPC ${row.listing.listNetwork}ms）· 进目录 ${row.listing.rowsTotal}ms · 行数 ${row.listing.rowCount}\n` +
            (preview === undefined || preview === null
              ? ''
              : `   预览：等待 ${preview.wait}ms（RPC ${preview.network}ms）· 渲染 ${preview.render}ms · 长任务 ${JSON.stringify(preview.longTasks)} · 节点 ${preview.nodes} · 滚动中位 ${preview.scroll?.median}ms/max ${preview.scroll?.max}ms\n`) +
            `   主线程：task ${row.task}ms · script ${row.script}ms · layout ${row.layout}ms · style ${row.style}ms · 整页节点 ${row.nodes}\n`,
        )
        if (preview?.fallback) console.log(`   ⚠️ 预览失败：${preview.fallback}`)
        if (imageB64 !== '' && scenario.id === 'md-20k') {
          // 图片单独一次（同一个 CPU 档）：走同一条 read 通路，但量的是 atob + 解码 + 绘制
          const imageEntries = await page.evaluate(`globalThis.__PERF__.makeEntries(6, [{ name: 'photo.png', type: 'file', size: ${Math.round((imageB64.length * 3) / 4)} }])`)
          await page.evaluate(`globalThis.__PERF__.install(${JSON.stringify({ entries: imageEntries, payload: { b64: '', size: 0 }, rtt: RTT })}); globalThis.__PERF__.setPayload({ b64: ${JSON.stringify(imageB64)}, size: ${Math.round((imageB64.length * 3) / 4)} }); globalThis.__PERF__.observer(); 'ok'`)
          const beforeImage = await metricsNow()
          const image = await page.evaluate(`(async () => {
            await globalThis.__PERF__.openAndEnter()
            return globalThis.__PERF__.tapEntry('photo', '.dshm-preview-image')
          })()`)
          const afterImage = await metricsNow()
          const imageRow = {
            cpu: rate,
            id: 'image',
            label: `预览图片（${Math.round((imageB64.length * 3) / 4 / 1024)} KB）`,
            rtt: RTT,
            preview: image,
            task: Math.round((afterImage.TaskDuration - beforeImage.TaskDuration) * 1000),
            layout: Math.round((afterImage.LayoutDuration - beforeImage.LayoutDuration) * 1000),
            style: Math.round((afterImage.RecalcStyleDuration - beforeImage.RecalcStyleDuration) * 1000),
            nodes: afterImage.Nodes,
            heapMB: Math.round((afterImage.JSHeapUsedSize / 1048576) * 10) / 10,
          }
          results.push(imageRow)
          console.log(`CPU ${rate}× | ${imageRow.label}\n   预览：等待 ${image.wait}ms（RPC ${image.network}ms）· 渲染 ${image.render}ms · 长任务 ${JSON.stringify(image.longTasks)} · ${image.meta}`)
          if (image.fallback) console.log(`   ⚠️ 预览失败：${image.fallback}`)
        }
      }
    }
    if (JSON_OUT !== '') {
      writeFileSync(JSON_OUT, JSON.stringify({ when: new Date().toISOString(), rtt: RTT, real: REAL_FILE, results }, null, 2))
      console.log(`\n明细已写到 ${JSON_OUT}`)
    }
  } finally {
    page.close()
    chrome.kill()
    await new Promise((done) => server.server.close(done))
  }
}

await main()
