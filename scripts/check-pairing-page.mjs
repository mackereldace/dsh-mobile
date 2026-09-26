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
 * ## 二维码（第 10 节 ✓）
 *
 * 配对页从 round 起要自己画二维码 ✓（在这之前，手机侧那个「扫码配对」**无码可扫** ✗）。
 * 二维码最阴险的一点是：**内容错了它照样是一张漂亮的二维码** ✓ ——
 * 编码器被截断、载荷被改一个字符、纠错等级被换、模块矩阵被转置，
 * 页面上完全看不出来 ✗，只有**手机**扫出来才知道不对 ✗。
 *
 * 所以这一节不是"有个 canvas 就算过" ✗，而是三条一起：
 *   a) 页面里那段编码器与 `packages/host/assets/` 里 vendored 的那份**逐字节相同** ✓；
 *   b) 页面**真的在用它** ✓（用接口返回的 `qrPayload` 原文 ✓，不自己拼链接 ✓）；
 *   c) ★ **黄金样本**：对固定载荷，模块矩阵逐位等于离线算好的期望值 ✓
 *      （sha256 固化在这里 ✓，期望值由独立实现交叉验证过 ✓，见
 *      `packages/host/assets/qrcode-generator.README.md` ✓）。
 *
 * 运行：node scripts/check-pairing-page.mjs
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import {
  QR_VENDOR_BEGIN,
  QR_VENDOR_END,
  QR_VENDOR_PATH,
  QR_VENDOR_PLACEHOLDER,
  extractQrVendor,
  qrVendorInlineSource,
  sha256Hex,
} from './qr-vendor.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = dirname(here)

/**
 * 二维码黄金样本（**离线算好、逐位固化** ✓）。
 *
 * 载荷是**固定字面量** ✓：黄金样本的全部意义就是"同一个输入永远得到同一个输出" ✓，
 * 因此绝不能在这里现场拼一个（那就变成自己和自己比 ✗）。
 * 第 1 条与宿主 `createPairing()` 产出的形状完全一致 ✓（页面下方还会解一遍 base64url ✓）。
 */
const QR_GOLDEN_LEVEL = 'M'
const QR_GOLDEN = [
  {
    label: '宿主真实载荷（341 字符，版本 14）',
    payload:
      'dshmobile://pair?d=eyJ2IjoxLCJob3N0SWQiOiJob3N0LTNmMmE5MSIsImhvc3RGaW5nZXJwcmludCI6IkFCQ0QtRUYwMS0yMzQ1LTY3ODktQUJDRC1FRjAxLTIzNDUtNjc4OSIsImNvZGUiOiIxMjM0NTYiLCJ0aWNrZXQiOiJ0a3RfOXg4eTd6OXg4eTd6OXg4eTd6IiwiZW5kcG9pbnRzIjpbImh0dHA6Ly8xMC4zNC4yMjEuMTgxOjMwODEiXSwicHJvdG9jb2xWZXJzaW9uIjoxLCJleHBpcmVzQXQiOiIyMDI2LTEyLTMxVDAwOjAwOjAwLjAwMFoifQ',
    modules: 73,
    sha256: 'ece62dfb054d8a3cfbab07b4142708a9ea942df2f1087a6b53b85c9aa543b05d',
    ticket: {
      v: 1,
      hostId: 'host-3f2a91',
      hostFingerprint: 'ABCD-EF01-2345-6789-ABCD-EF01-2345-6789',
      code: '123456',
      ticket: 'tkt_9x8y7z9x8y7z9x8y7z',
      endpoints: ['http://10.34.221.181:3081'],
      protocolVersion: 1,
      expiresAt: '2026-12-31T00:00:00.000Z',
    },
  },
  {
    label: '短路径载荷（24 字符，版本 2）',
    payload: 'dshmobile://pair?d=SHORT',
    modules: 25,
    sha256: 'da65700bf16df6e20c525c731142e59f2b9b73a925139a7a00d7ea80ac460153',
  },
]

const problems = []

/** 第 10 节的结论（给最后的汇总行用 ✓；块作用域里的变量外面看不见 ✓）。 */
let qrInlineChars = null
let qrInlineSha = null

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
  // ★ 二维码容器：手机「扫码配对」扫的就是它 ✓（缺了它页面照样正常，只是无码可扫 ✗）
  ['id="qr-box"', '二维码容器'],
  ['id="qr"', '二维码画布'],
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
    /**
     * 手机外壳/样式的安装必须被 `try` 隔离 ✓（样式失败不能把同一函数里后面的隧道建立一起带崩 ✗）。
     *
     * ★ 这里曾经**只**认 `installMobileStyles` ✗ —— 而那个函数**从来没有存在过** ✓
     *   （`git show HEAD` 里也是 0 次 ✗）：某一轮把样式安装改名成 `installShell` 之后，
     *   这条断言就一直报红 ✓（"函数找不到"被当成了"没被 try 隔离"✗）。
     *   现在按**名字 + 结构**两条一起判 ✓：
     *     · 先找安装函数是谁（兼容旧名 ✓）；
     *     · 再取它**第一个调用点**（跳过 `function ...` 声明行 ✓），
     *       往上找**第一行真正的代码**（空行与注释都不算 ✓）⇒ 必须是 `try {` ✓。
     *   于是它**不是**"永远为真"✗：谁把 `try` 拆掉 / 把调用挪出 try / 又改一次名，
     *   这条都会立刻变红 ✓（改名的代价只是回来补上名字 ✓，不会静默放过 ✗）。
     */
    const installerName = /function (installShell|installMobileStyles)\s*\(/.exec(boot)?.[1]
    if (installerName === undefined) {
      problems.push('boot.js 里找不到手机外壳/样式安装函数（installShell）：样式是否已被整体移除？')
    } else {
      const lines = boot.split('\n')
      const callLine = lines.findIndex(
        (line) => !/^\s*function\b/.test(line) && new RegExp(`(^|[^A-Za-z0-9_])${installerName}\\(`).test(line),
      )
      let previousCode = '(找不到调用点)'
      for (let i = callLine - 1; i >= 0 && callLine >= 0; i--) {
        const trimmed = lines[i].trim()
        if (trimmed === '' || trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue
        previousCode = trimmed
        break
      }
      if (callLine < 0 || !/^try\s*\{$/.test(previousCode)) {
        problems.push(
          `${installerName} 未被 try 隔离（调用点上一行真正的代码是「${previousCode.slice(0, 40)}」）：样式失败会中断隧道建立`,
        )
      }
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

/**
 * 10) ★ 二维码：编码器**真的进了页面** ✓、页面**真的在用它** ✓、**它编出来的东西是对的** ✓。
 *
 * 见文件头的说明：二维码"内容全错也照样好看" ✗，所以这一节必须做到
 * "与仓库源码逐字节相同 + 黄金样本逐位相同"才算过 ✓。
 */
{
  /** 抓一个函数声明（含函数体）——与第 6 节同一套规则（收尾缩进按起始缩进推 ✓）。 */
  const grab = (source, name) => {
    const pattern = new RegExp(`( *)function ${name}\\s*\\([^)]*\\)\\s*\\{`)
    const match = pattern.exec(source)
    if (match === null) return undefined
    const end = source.indexOf(`\n${match[1]}}`, match.index)
    return end === -1 ? undefined : source.slice(match.index, end + match[1].length + 2)
  }

  // ── 10a) 页面里那段编码器与仓库里 vendored 的那份**逐字节相同** ✓ ──
  let vendorPinned
  try {
    vendorPinned = qrVendorInlineSource()
  } catch (error) {
    problems.push(`无法读取 vendored 二维码编码器（${QR_VENDOR_PATH}）：${error instanceof Error ? error.message : String(error)}`)
  }
  const vendorInline = extractQrVendor(html)
  if (vendorInline !== undefined) {
    qrInlineChars = vendorInline.length
    qrInlineSha = sha256Hex(vendorInline)
  }
  if (vendorInline === undefined) {
    problems.push(`页面里找不到二维码编码器（${QR_VENDOR_BEGIN} 与 ${QR_VENDOR_END} 之间那段）：scripts/gen-pairing-page.mjs 是不是没跑过？`)
  } else if (vendorPinned !== undefined) {
    if (vendorInline !== vendorPinned) {
      problems.push(
        '页面内联的二维码编码器与 packages/host/assets/qrcode-generator-2.0.4.js 不一致：' +
          `页面 ${vendorInline.length} 字符 / sha256 ${sha256Hex(vendorInline).slice(0, 16)}…，` +
          `仓库 ${vendorPinned.length} 字符 / sha256 ${sha256Hex(vendorPinned).slice(0, 16)}…`,
      )
    }
    if (html.includes(QR_VENDOR_PLACEHOLDER)) {
      problems.push('页面里仍残留二维码占位符——编码器事实上没有被注入（内联脚本会直接语法错误）')
    }
  }

  /**
   * 10a-2) ★ 产物是否与"源 HTML + 当前编码器"同步 ✓。
   *
   * 真实风险：有人改了 `pairing-page.html` 却**没跑** `gen-pairing-page.mjs` ✓，
   * 于是构建产物里还是旧 HTML ✓ —— 而下面所有二维码断言**照样全绿** ✗
   * （旧 HTML 也是自洽的 ✓），只有人工打开页面才会发现改动没生效 ✗。
   * 因此产物头部带了两个 sha256 戳 ✓，这里逐个对 ✓。
   */
  if (vendorPinned !== undefined) {
    let artifactText = ''
    try {
      artifactText = readFileSync(join(repoRoot, 'packages', 'host', 'lib', 'pairing-page.js'), 'utf8')
    } catch (error) {
      problems.push(`无法读取构建产物源码（packages/host/lib/pairing-page.js）：${error instanceof Error ? error.message : String(error)}`)
    }
    if (artifactText.length > 0) {
      const sourceStamp = /源 HTML sha256：([0-9a-f]{64})/.exec(artifactText)?.[1]
      const vendorStamp = /内联编码器 sha256：([0-9a-f]{64})/.exec(artifactText)?.[1]
      if (sourceStamp === undefined || vendorStamp === undefined) {
        problems.push('构建产物缺少"源 HTML / 编码器"的 sha256 戳——请重新跑 node scripts/gen-pairing-page.mjs')
      } else {
        try {
          const currentSource = sha256Hex(readFileSync(join(repoRoot, 'packages', 'host', 'src', 'pairing-page.html'), 'utf8'))
          if (sourceStamp !== currentSource) {
            problems.push('pairing-page.html 改过却没重新生成：产物里是旧的 HTML（跑 node scripts/gen-pairing-page.mjs）')
          }
        } catch (error) {
          problems.push(`无法读取源 HTML：${error instanceof Error ? error.message : String(error)}`)
        }
        if (vendorStamp !== sha256Hex(vendorPinned)) {
          problems.push('内联的二维码编码器与当前 vendored 源码不同步——重新跑 node scripts/gen-pairing-page.mjs')
        }
      }
    }
  }

  // ── 10b) 页面**真的在用它**（不是"只放了个容器/按钮" ✗）──
  const levelMatch = /var QR_ERROR_CORRECTION = '([LMQH])'/.exec(pageScript)
  const level = levelMatch === null ? undefined : levelMatch[1]
  if (level === undefined) {
    problems.push('找不到 QR_ERROR_CORRECTION（二维码纠错等级常量）')
  } else if (level !== QR_GOLDEN_LEVEL) {
    problems.push(`二维码纠错等级是 ${level}，黄金样本是按 ${QR_GOLDEN_LEVEL} 固化的——改等级必须连黄金样本一起重算`)
  }
  if (!pageScript.includes('qrcode(0, QR_ERROR_CORRECTION)')) {
    problems.push('renderQr 没有用 qrcode(0, ...)（typeNumber=0 = 自动选最小版本）')
  }
  if (!pageScript.includes('qr.addData(payload)')) problems.push('renderQr 没有把载荷交给 qr.addData')
  if (!pageScript.includes('qr.make()')) problems.push('renderQr 没有调用 qr.make()')
  // ★ 载荷必须**原样**取自接口 ✓
  if (!pageScript.includes('renderQr(created.qrPayload)')) {
    problems.push('generatePairing 没有拿接口返回的 qrPayload 去渲染（二维码可能用的是页面自己拼的字符串）')
  }
  if (pageScript.includes("'dshmobile://pair?d='")) {
    problems.push('页面里出现了自己拼的 dshmobile://pair?d=... —— 必须原样使用接口返回的 qrPayload 原文')
  }
  if (!pageScript.includes("stringToBytesFuncs['UTF-8']")) {
    problems.push('页面没有装官方的 UTF-8 覆盖（qrcode.stringToBytes）——非 ASCII 载荷会静默编错')
  }

  // ── 10c) 渲染要求：静区 ≥ 4 模块、黑白高对比、先铺白底（黄金样本测不到这些 ✓）──
  const quietMatch = /var QR_QUIET_MODULES = (\d+)/.exec(pageScript)
  const quiet = quietMatch === null ? NaN : Number(quietMatch[1])
  if (!(quiet >= 4)) {
    problems.push(`二维码静区不足 4 个模块（QR_QUIET_MODULES = ${quietMatch === null ? '找不到' : quietMatch[1]}）——没有静区会扫不出来`)
  }
  const renderQrSource = grab(pageScript, 'renderQr')
  if (renderQrSource === undefined) {
    problems.push('找不到 renderQr（二维码渲染函数）')
  } else {
    if (!renderQrSource.includes('QR_QUIET_MODULES')) problems.push('renderQr 没用 QR_QUIET_MODULES（静区可能没画进去）')
    const whiteAt = renderQrSource.indexOf("'#ffffff'")
    const blackAt = renderQrSource.indexOf("'#000000'")
    if (whiteAt === -1 || blackAt === -1) {
      problems.push('renderQr 没有同时使用纯白底与纯黑模块（二维码必须黑白高对比，不许用主题色）')
    } else if (whiteAt > blackAt) {
      problems.push('renderQr 把纯黑模块画在纯白底之前（深色主题下静区会被吃掉）')
    }
    if (!renderQrSource.includes('getContext')) problems.push('renderQr 没走 canvas（本页选定的渲染方式，见该函数注释）')
    if (!/fillRect\(0, 0, side, side\)/.test(renderQrSource)) {
      problems.push('renderQr 没有先把整张画布铺成白色（静区必须被烘进位图）')
    }
  }
  // 过期/失败必须把码撤掉并给出文案 ✗ 不许留一张过期的码在那儿 ✗
  if (!pageScript.includes('function clearQr(')) problems.push('没有 clearQr（过期/失败时二维码撤不掉，会留一张过期的码在屏幕上）')
  if (!pageScript.includes('checkPairingExpiry')) problems.push('没有过期检查（过期的二维码会一直留在屏幕上）')

  // ── 10e) ★ 手机侧那颗「扫码配对」必须**真的接在壳的桥上**（round 152）────────
  //
  // 起因（用户报的）：**手机上点「扫码配对」什么都不发生** ✗。
  // 查下来这段 `scanQr()` 当时只往页面里写一句"请用手机相机扫描…" ✓ ——
  // 既不打开任何扫码界面、页面上也没有任何能调起的桥 ✗（壳里明明有 ScanActivity ✓，
  // 却只长在「电脑地址」框上 ✗）。于是这颗按钮看着像功能、实际是个摆设 ✗。
  //
  // ★ 为什么必须**按"它调了什么"判** ✗：这种失败在源码里看着"挺正常" ✓
  //   （有 handler ✓、点了也有文案 ✓、页面结构一个字不缺 ✓）——
  //   只有"它到底调没调到 `DshmShell.scanPair`"能把它和真能扫码区分开 ✓。
  // ★ 第二条盯**降级**：纯浏览器里没有桥 ✓，必须**如实说**（不许假装能扫 ✗、
  //   也不许点了抛错 ✗）；旧 APK 同理 ✓（`typeof ... !== 'function'` ✓）。
  const scanQrSource = grab(pageScript, 'scanQr')
  if (scanQrSource === undefined) {
    problems.push('找不到 scanQr（手机侧那颗「扫码配对」按钮的处理器）')
  } else {
    if (!scanQrSource.includes('scanPair')) {
      problems.push('scanQr 没有调用壳的桥 scanPair —— 手机侧「扫码配对」会退化成"点了没反应"')
    }
    if (!scanQrSource.includes('DshmShell')) {
      problems.push('scanQr 没有先探测 DshmShell（纯浏览器里会直接抛错）')
    }
    if (!/typeof\s+[A-Za-z0-9_$.]*scanPair\s*!==\s*'function'/.test(scanQrSource)) {
      problems.push("scanQr 没有判「旧壳没有这条桥」（typeof scanPair !== 'function'）——装旧 APK 的用户点了会抛错")
    }
    if (!scanQrSource.includes('没有相机扫码能力')) {
      problems.push('scanQr 没有"没有壳时"的那句如实话术（会把浏览器里的用户引到一个不存在的功能上）')
    }
  }
  // 二维码必须挂在**电脑侧**控制台里（手机侧扫自己的屏幕没有意义 ✗）
  if (!(html.indexOf('id="qr-box"') > html.indexOf('id="desktop"'))) {
    problems.push('二维码容器不在电脑侧控制台（id="desktop"）里——它只该出现在电脑屏幕上')
  }

  // ── 10d) ★ 黄金样本：固定载荷 ⇒ 固定模块矩阵（离线算好、逐位固化）──
  if (vendorInline !== undefined) {
    const sandbox = {}
    vm.createContext(sandbox)
    let encoderReady = false
    try {
      vm.runInContext(vendorInline, sandbox, { filename: 'pairing-page-inline-qrcode-generator.js' })
      if (typeof sandbox.qrcode !== 'function') throw new Error('内联之后 qrcode 不是函数')
      vm.runInContext("qrcode.stringToBytes = qrcode.stringToBytesFuncs['UTF-8']", sandbox)
      // 只借页面里那份编码器做"取矩阵"这件事 ✓（不含任何断言逻辑 ✓）
      vm.runInContext(
        [
          'function goldenMatrix(payload, level) {',
          '  var qr = qrcode(0, level)',
          '  qr.addData(payload)',
          '  qr.make()',
          '  var n = qr.getModuleCount()',
          '  var rows = []',
          '  for (var r = 0; r < n; r++) {',
          '    var line = ""',
          '    for (var c = 0; c < n; c++) line += qr.isDark(r, c) ? "1" : "0"',
          '    rows.push(line)',
          '  }',
          '  return { count: n, rows: rows }',
          '}',
        ].join('\n'),
        sandbox,
      )
      encoderReady = true
    } catch (error) {
      problems.push(`页面里的二维码编码器在本机跑不起来：${error instanceof Error ? error.message : String(error)}`)
    }

    if (encoderReady) {
      const finder = ['1111111', '1000001', '1011101', '1011101', '1011101', '1000001', '1111111']
      for (const golden of QR_GOLDEN) {
        let matrix
        try {
          matrix = sandbox.goldenMatrix(golden.payload, level === undefined ? QR_GOLDEN_LEVEL : level)
        } catch (error) {
          problems.push(`${golden.label}：编码失败（${error instanceof Error ? error.message : String(error)}）`)
          continue
        }
        const count = matrix.count
        const rows = matrix.rows
        const digest = sha256Hex(`${count}\n${rows.join('\n')}`)
        if (count !== golden.modules) problems.push(`${golden.label}：模块数 ${count} ≠ 黄金样本 ${golden.modules}`)
        if (digest !== golden.sha256) {
          problems.push(`${golden.label}：模块矩阵 sha256 ${digest} ≠ 黄金样本 ${golden.sha256}（编码器或载荷被动过）`)
        }
        // 结构自检：矩阵被整体转置/取反/截断时先红这两条，便于一眼定位 ✓
        const at = (r, c) => rows[r][c]
        const finderAt = (r0, c0) => {
          for (let r = 0; r < 7; r++) for (let c = 0; c < 7; c++) if (at(r0 + r, c0 + c) !== finder[r][c]) return false
          return true
        }
        if (!finderAt(0, 0) || !finderAt(0, count - 7) || !finderAt(count - 7, 0)) {
          problems.push(`${golden.label}：三个定位图形（finder）不完整——矩阵可能被转置/取反/截断`)
        }
        let timingOk = true
        for (let i = 8; i <= count - 9; i++) {
          const want = i % 2 === 0 ? '1' : '0'
          if (at(6, i) !== want || at(i, 6) !== want) timingOk = false
        }
        if (!timingOk) problems.push(`${golden.label}：定时图形（第 6 行/列）不交替——矩阵不对`)
        const version = (count - 17) / 4
        if (!Number.isInteger(version) || version < 1 || version > 40) {
          problems.push(`${golden.label}：模块数 ${count} 不是合法版本`)
        } else if (at(4 * version + 9, 8) !== '1') {
          problems.push(`${golden.label}：规范固定的"暗模块"不在 (${4 * version + 9}, 8)——矩阵不对`)
        }
      }

      // 黄金样本自己也要与宿主 createPairing() 的形状一致 ✓
      const withTicket = QR_GOLDEN.find((entry) => entry.ticket !== undefined)
      if (withTicket !== undefined) {
        const encoded = withTicket.payload.slice('dshmobile://pair?d='.length)
        let decoded
        try {
          decoded = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))
        } catch (error) {
          problems.push(`黄金样本载荷解不出 base64url(JSON)：${error instanceof Error ? error.message : String(error)}`)
        }
        if (decoded !== undefined) {
          for (const key of Object.keys(withTicket.ticket)) {
            if (JSON.stringify(decoded[key]) !== JSON.stringify(withTicket.ticket[key])) {
              problems.push(`黄金样本载荷的 ${key} 与宿主的配对票据形状不一致（黄金样本本身过期了）`)
            }
          }
        }
      }

      /**
       * 显示尺寸：按页面自己的算法（取"能塞进内容区"的最大整数 scale ✓）算一遍 ✓，
       * 断言 ≥ 200px ✓ —— 这是"手机扫得到"的一个**可离线证**的下限 ✓。
       * 用页面里的兜底宽度 420px 算（真机上内容区通常更宽 ✓）⇒ 结论是保守的 ✓。
       */
      const maxSideMatch = /var QR_MAX_SIDE_PX = (\d+)/.exec(pageScript)
      const maxSide = maxSideMatch === null ? 480 : Number(maxSideMatch[1])
      for (const golden of QR_GOLDEN) {
        const total = golden.modules + quiet * 2
        const available = Math.min(420, maxSide)
        const side = total * Math.max(2, Math.min(8, Math.floor(available / total)))
        if (!(side >= 200)) {
          problems.push(`${golden.label}：按页面算法显示边长只有 ${side}px（要求 ≥ 200px），手机可能扫不到`)
        }
      }
    }
  }
}

/**
 * 11) ★ 页面零外部请求 ✓（自家路由除外 ✓）。
 *
 * 为什么单独查这一条：一旦有人把编码器换成 CDN 外链 ✗，
 * 开发机（有外网）上一切正常 ✓，本机/局域网（无外网）打开时二维码直接没了 ✗ ——
 * 又是一次"环境相关、看着都对"的失败 ✓。内联在这里是**要求** ✓，不是优化 ✗。
 */
{
  const externalPatterns = [
    [/<script[^>]*\ssrc=/i, '外部脚本（script src）'],
    [/<link[^>]+href="https?:/i, '外链样式/资源（link href 指向 http(s)）'],
    [/@import\s+(url\()?['"]?https?:/i, 'CSS @import 外链'],
    [/url\(\s*['"]?https?:\/\//i, 'CSS url() 外链'],
    [/<img[^>]*\ssrc="https?:/i, '外部图片（img src）'],
  ]
  for (const [pattern, label] of externalPatterns) {
    if (pattern.test(html)) problems.push(`页面引用了${label}——配对页要求零外部请求（不许 CDN）`)
  }
}

if (problems.length > 0) {
  console.error('[check-pairing-page] 校验未通过：')
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}

console.log(
  `[check-pairing-page] 通过：HTML ${html.length} 字符，内联脚本 ${scripts.length} 段，` +
    `结构标记 ${requiredMarkers.length} 项齐全；` +
    `二维码：内联编码器 ${qrInlineChars === null ? '缺失' : `${qrInlineChars} 字符`}` +
    `（sha256 ${qrInlineSha === null ? '—' : `${qrInlineSha.slice(0, 16)}…`}），` +
    `黄金样本 ${QR_GOLDEN.length} 组（${QR_GOLDEN.map((g) => `${g.modules}×${g.modules}`).join(' / ')}，纠错 ${QR_GOLDEN_LEVEL}）`,
)
