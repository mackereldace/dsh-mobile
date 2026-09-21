#!/usr/bin/env node
/**
 * 校验配对页构建产物：HTML 结构与内联脚本语法。
 *
 * ## 为什么需要这个脚本
 *
 * 配对页的 HTML 以模板字面量形式嵌进 TypeScript。生成过程中若发生**转义丢失**
 * （例如 `\s` 被当作转义序列吃掉），页面里的正则会变成非法语法，
 * 于是**整段内联脚本不执行**——页面停在"正在加载…"，但 HTML 本身完全正常、
 * HTTP 200、结构元素齐全。人工很难一眼看出问题。
 *
 * 本项目真实踩过这个坑，因此把校验固定成可执行的一步：
 * 它在**构建产物**上工作（而不是源 HTML），所以能抓住生成/编译环节的任何破坏。
 *
 * 运行：node scripts/check-pairing-page.mjs
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = dirname(here)

const problems = []

/** 1) 构建产物存在且可被 Node 导入。 */
let html
try {
  const module = await import(join(repoRoot, 'packages', 'host', 'lib', 'pairing-page.js'))
  html = module.PAIRING_PAGE_HTML
} catch (error) {
  console.error(
    `[check-pairing-page] 无法导入构建产物：${error instanceof Error ? error.message : String(error)}\n` +
      '  请先运行：node scripts/gen-pairing-page.mjs && npx tsc -p packages/host/tsconfig.build.json',
  )
  process.exit(1)
}

if (typeof html !== 'string' || html.length === 0) {
  console.error('[check-pairing-page] PAIRING_PAGE_HTML 不是非空字符串')
  process.exit(1)
}

/** 2) 结构完整性。 */
const requiredMarkers = [
  ['<!doctype html>', '文档类型'],
  ['</html>', '文档结尾'],
  ['id="desktop"', '电脑侧容器'],
  ['id="phone"', '手机侧容器'],
  ['id="crash"', '屏上错误提示容器'],
  ['/mobile/pair/claim', 'claim 端点'],
]
for (const [marker, label] of requiredMarkers) {
  if (!html.includes(marker)) problems.push(`缺少${label}（${marker}）`)
}

/** 3) 内联脚本必须能通过语法解析——这是最关键的一条。 */
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1])
// 启动入口可能在任何一段内联脚本里（当前是第二段）
if (!scripts.some((code) => code.includes('boot().catch'))) {
  problems.push('未找到启动入口 boot().catch')
}
if (!scripts.some((code) => code.includes("addEventListener('error'"))) {
  problems.push('未找到错误捕获（屏上提示将不可用）')
}

if (scripts.length === 0) {
  problems.push('没有找到任何内联脚本')
} else {
  scripts.forEach((code, index) => {
    try {
      new vm.Script(code)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      problems.push(`第 ${index + 1} 段内联脚本语法错误：${message}`)
      // 把出错位置附近的代码打出来，便于直接定位
      const lineMatch = /:(\d+)/.exec(message)
      if (lineMatch !== null) {
        const lines = code.split('\n')
        const line = Number(lineMatch[1])
        const from = Math.max(0, line - 4)
        const to = Math.min(lines.length, line + 3)
        console.error('  出错位置附近：')
        for (let i = from; i < to; i++) {
          console.error(`    ${String(i + 1).padStart(4)} | ${lines[i]}`)
        }
      }
    }
  })
}

/** 4) 转义是否残留（模板字面量被"过度"转义也会出错）。 */
if (html.includes('\\${')) problems.push('存在未还原的 ${ 转义')
if (/\\\\(?![\s\S])/.test(html)) problems.push('存在悬空反斜杠')

/**
 * 5) 关键正则必须完好。
 *
 * 为什么单靠"语法能过"不够：把 `\s` 吃掉后得到 `s*`，那仍然是**合法**正则，
 * 语法校验不会报错，但语义已经错了（机型识别失效）。因此对转义敏感的字面量做显式断言。
 */
const escapeSensitiveLiterals = [
  ['[^;]*;\\s*([^)]+)\\)', '机型识别正则（反斜杠 \\s / \\) 必须保留）'],
  ['\\((iPhone|iPad)', 'iPad/iPhone 识别正则'],
]
for (const [literal, label] of escapeSensitiveLiterals) {
  if (!html.includes(literal)) problems.push(`关键字面量被破坏：${label}`)
}

/**
 * 6) 配对页与 boot.js 的 `?pair=` 载荷形状必须一致（**真实往返**验证）。
 *
 * 为什么单靠字符串包含不够：两端各自"看起来都对"，但形状不匹配时
 * （页传裸 ticket 串、boot.js 却按 base64url(JSON) 解）只在**真机**上才暴露——
 * 页面正常跳转、GUI 正常打开，只是拿不到 hostFingerprint 而连不上，
 * 现场表现是"手机一直连不上电脑"，极难定位。本项目真实踩过。
 *
 * 做法：把两端的编解码函数各自抓出来，在同一个 vm 上下文里真跑一次往返，
 * 断言解码结果与原始 ticket 逐字段相等。
 */
const pageScript = scripts.join('\n')
const bootPath = join(repoRoot, 'packages', 'client', 'src', 'boot.js')
let bootSource
try {
  bootSource = readFileSync(bootPath, 'utf8')
} catch (error) {
  problems.push(`无法读取 boot.js（${bootPath}）：${error instanceof Error ? error.message : String(error)}`)
}

if (typeof bootSource === 'string') {
  /**
   * 抓取一个函数声明（含函数体）。
   *
   * 收尾缩进必须按**起始缩进**动态推得：这些函数嵌在 IIFE/回调里，
   * 缩进是 6 空格而不是 2 空格，写死 `\n  }` 会一个都匹配不到。
   */
  const grab = (source, name) => {
    const pattern = new RegExp(`( *)function ${name}\\s*\\([^)]*\\)\\s*\\{`)
    const match = pattern.exec(source)
    if (match === null) return undefined
    const indent = match[1]
    const end = source.indexOf(`\n${indent}}`, match.index)
    return end === -1 ? undefined : source.slice(match.index, end + indent.length + 2)
  }

  const pieces = [
    grab(pageScript, 'encodeTicketPayload'),
    grab(pageScript, 'b64u'),
    grab(bootSource, 'unb64u'),
    grab(bootSource, 'fromUtf8'),
  ]
  if (pieces.some((piece) => piece === undefined)) {
    problems.push('往返校验缺少函数片段：' + ['encodeTicketPayload', 'b64u', 'unb64u', 'fromUtf8'].filter((_, i) => pieces[i] === undefined).join(', '))
  } else {
    const sandbox = { TextEncoder, TextDecoder, atob, btoa, encodeTicketPayload: undefined }
    vm.createContext(sandbox)
    vm.runInContext(pieces.join('\n'), sandbox)
    const ticket = {
      v: 1,
      hostId: 'host-中文-id',
      hostFingerprint: 'ABCD-EF01-2345-6789-ABCD-EF01-2345-6789',
      code: '123456',
      ticket: 'tkt_9x8y7z',
      endpoints: ['http://10.34.221.181:3081'],
      protocolVersion: 1,
      expiresAt: '2026-12-31T00:00:00.000Z',
    }
    const encoded = sandbox.encodeTicketPayload(ticket)
    if (typeof encoded !== 'string' || encoded.length === 0) {
      problems.push('encodeTicketPayload 没有返回字符串')
    } else {
      if (!/^[A-Za-z0-9_-]+$/.test(encoded)) problems.push('encodeTicketPayload 输出不是 base64url（含 +/= 等字符）')
      const decoded = JSON.parse(sandbox.fromUtf8(sandbox.unb64u(encoded)))
      for (const key of Object.keys(ticket)) {
        const same = JSON.stringify(decoded[key]) === JSON.stringify(ticket[key])
        if (!same) problems.push(`?pair= 往返丢失/篡改字段 ${key}：${JSON.stringify(decoded[key])}`)
      }
      if (decoded.hostFingerprint !== ticket.hostFingerprint) {
        problems.push('?pair= 往返后 hostFingerprint 不一致（手机将无法固定宿主身份）')
      }
    }
  }

  // 跳转必须使用编码结果，而不是裸 ticket 串；且必须走插件外壳 /mobile/app
  if (!/location\.href\s*=\s*'\/mobile\/app\?pair='\s*\+\s*encodeURIComponent\(encoded\)/.test(pageScript)) {
    problems.push(
      "跳转未使用 encodeTicketPayload 的结果（应为 location.href = '/mobile/app?pair=' + encodeURIComponent(encoded)）",
    )
  }
  if (/\/\?pair='\s*\+\s*encodeURIComponent\(ticket\.ticket\)/.test(pageScript)) {
    problems.push('跳转仍在使用裸 ticket.ticket 拼 ?pair=（形状与 boot.js 不符）')
  }
  // 进入界面按钮也必须走 /mobile/app
  if (!pageScript.includes("location.href = '/mobile/app'")) {
    problems.push("「打开 DSH 界面」未使用 /mobile/app")
  }
  // ★ 红线：任何跳转都不得落到 `/`（DSH 的 token/cookie 认证唯一入口）
  if (/location\.href\s*=\s*'\/\?/.test(pageScript) || /location\.href\s*=\s*'\/'/.test(pageScript)) {
    problems.push('页面存在跳转到 `/` 的代码：DSH 的根路径是认证入口，手机侧不应引导到那里')
  }
}

/**
 * 7) 手机端必须能解析宿主真实生成的扫码链接。
 *
 * 为什么单独测这个：`parseLink` 曾把 10 字符的前缀 `dshmobile:` 写成 `slice(0, 11)` 去比较，
 * 比较恒为假——语法合法、单测（当时没有）也发现不了，但手机端**永远**配不上对。
 * 这里用宿主真实的载荷格式跑一遍页面自己的解析器。
 */
{
  const grab = (source, name) => {
    const pattern = new RegExp(`( *)function ${name}\\s*\\([^)]*\\)\\s*\\{`)
    const match = pattern.exec(source)
    if (match === null) return undefined
    const end = source.indexOf(`\n${match[1]}}`, match.index)
    return end === -1 ? undefined : source.slice(match.index, end + match[1].length + 2)
  }
  const parseLink = grab(pageScript, 'parseLink')
  if (parseLink === undefined) {
    problems.push('未找到 parseLink（手机端解析入口）')
  } else {
    const sandbox = { TextDecoder, URLSearchParams, atob }
    vm.createContext(sandbox)
    vm.runInContext(parseLink, sandbox)
    const ticket = {
      v: 1,
      hostId: 'h',
      hostFingerprint: 'ABCDEF0123456789ABCDEF0123456789',
      code: '123456',
      ticket: 'tkt_1',
      endpoints: ['http://10.34.221.181:3081'],
      protocolVersion: 1,
      expiresAt: '2026-12-31T00:00:00.000Z',
    }
    // 与宿主 `dshmobile://pair?d=<base64url(JSON)>` 完全一致的形状
    const link = `dshmobile://pair?d=${Buffer.from(JSON.stringify(ticket), 'utf8').toString('base64url')}`
    let parsed
    try {
      parsed = sandbox.parseLink(link)
    } catch (error) {
      problems.push(`手机端无法解析宿主真实格式的配对链接：${error instanceof Error ? error.message : String(error)}`)
    }
    if (parsed !== undefined) {
      for (const key of ['ticket', 'code', 'hostFingerprint']) {
        if (parsed[key] !== ticket[key]) problems.push(`parseLink 解析出的 ${key} 不正确：${JSON.stringify(parsed[key])}`)
      }
      if (JSON.stringify(parsed.endpoints) !== JSON.stringify(ticket.endpoints)) {
        problems.push('parseLink 解析出的 endpoints 不正确')
      }
    }
    if (typeof sandbox.parseLink === 'function') {
      let rejected = false
      try {
        sandbox.parseLink('http://example.com/?d=abc')
      } catch {
        rejected = true
      }
      if (!rejected) problems.push('parseLink 接受了非 dshmobile: 的链接（前缀校验失效）')
    }
  }
}

/**
 * 8) boot.js 必须能在 `<head>` 里同步执行（它正是被注入到 head 的）。
 *
 * 真实事故：boot.js 在 document.head/body 还不存在时直接 appendChild 样式，
 * 抛异常后**连带中断了同一函数里后面的隧道建立**——表现是"界面能打开但一直连不上"。
 * 单测覆盖不到（没有 DOM），浏览器里才看得见，所以在这里做静态把关。
 */
{
  const bootPath = join(repoRoot, 'packages', 'client', 'src', 'boot.js')
  let boot = ''
  try {
    boot = readFileSync(bootPath, 'utf8')
  } catch (error) {
    problems.push(`无法读取 boot.js：${error instanceof Error ? error.message : String(error)}`)
  }
  if (boot.length > 0) {
    // 只拒绝**无守卫**的直接使用：在 <head> 里同步执行时 body/head 可能是 null。
    // 允许的写法是在挂载前判空（例如 `if (document.body === null) ... else document.body.appendChild(...)`），
    // 因此这里检查"同一个函数体内是否出现过 null 判断"。
    if (/document\.(head|body)\.appendChild/.test(boot)) {
      const guarded = /document\.body === null/.test(boot) && /document\.head \?\? document\.documentElement/.test(boot)
      if (!guarded) {
        problems.push('boot.js 直接对 document.head/body 调 appendChild 且没有判空守卫（<head> 中同步执行时它们是 null）')
      }
    }
    if (!boot.includes('ensureDomRoot')) {
      problems.push('boot.js 缺少 ensureDomRoot（DOM 挂载点解析）')
    }
    if (!/try \{\s*\n\s*installMobileStyles\(\)/.test(boot)) {
      problems.push('installMobileStyles 未被 try 隔离：样式失败会中断隧道建立')
    }
    if (!boot.includes('installPlaceholderTransport')) {
      problems.push('boot.js 缺少同步占位传输层：DSH 可能在隧道就绪前就读取 __DSH_TRANSPORT__')
    }
    if (!boot.includes("'/mobile/app'")) {
      problems.push("boot.js 的 isMobileSurface 未识别外壳路径 '/mobile/app'")
    }
  }
}

/**
 * 9) ★ 红线：插件不得改变 pathname `/` 的路由归属。
 *
 * 真实事故（毁灭级）：插件注册了 `{ kind:'prefix', path:'/' }` 想给手机提供应用外壳。
 * 但 `dsh-host-webserver` 的分发是「最长前缀胜出 + 命中即 return」，`register()` 没有 `next()`，
 * 而 `dsh web` 打印的**唯一认证入口 URL** 其 pathname 恰好是 `/`（`?token=`）——
 * token 兑换（位于 frontend-static 的 fallback 里）因此永不执行、cookie 永远铸造不出来：
 * **任何浏览器、任何 authority 打开都是 401 死循环**，连提示语里让你 reopen 的那条 URL 自己都打不开。
 *
 * 这条断言若一开始就存在，安装脚本跑完的那一刻就会拦下它。
 */
{
  for (const relative of ['packages/host/src/cordis.ts', 'packages/host/src/index.ts']) {
    let source = ''
    try {
      source = readFileSync(join(repoRoot, relative), 'utf8')
    } catch (error) {
      problems.push(`无法读取 ${relative}：${error instanceof Error ? error.message : String(error)}`)
      continue
    }
    // 只看真正提交给 webServer.register 的 path 字面量（代码里没有裸 register( 的其他用法）
    for (const match of source.matchAll(/webServer\.register\(\{[\s\S]{0,400}?path:\s*'([^']*)'/g)) {
      if (match[1] === '/') {
        problems.push(
          `${relative}: 注册了 path:'/' 路由——会抢占 DSH 的根路径（token/cookie 认证唯一入口），` +
            '导致任何浏览器 401 死循环；外壳必须挂在 /mobile/* 前缀下',
        )
      }
    }
    if (/webServer\.registerFallback\s*\(/.test(source)) {
      problems.push(`${relative}: 调用了 registerFallback——该座位已被 frontend-static 占用，再注册会 throw`)
    }
    // 复用核心的 401 文案会让"谁发的 401"无法从响应区分（本次事故的排查障碍）
    if (source.includes('dsh web authentication required')) {
      problems.push(`${relative}: 复用了核心的 401 文案——响应将无法区分来源，会把排查方向引向基础设施`)
    }
  }
}

if (problems.length > 0) {
  console.error('[check-pairing-page] 校验未通过：')
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}

console.log(
  `[check-pairing-page] 通过：HTML ${html.length} 字符，内联脚本 ${scripts.length} 段，` +
    `结构标记 ${requiredMarkers.length} 项齐全`,
)
