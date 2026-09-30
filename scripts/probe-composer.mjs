#!/usr/bin/env node
/**
 * 探针：把某个 DSH 实例的**输入区（composer）**按三样并排量出来 ——
 * DOM 结构 / 几何（getBoundingClientRect）/ 计算样式（getComputedStyle）。
 *
 * ## 为什么需要它（用户的要求是"照字面读"的）
 *
 * 用户原话：**"输入框要保 0.15 风格"** ✓ —— 也就是 0.17 那台实例上的输入区，
 * 看起来要和 0.15 不一样了，他要**0.15 那个样子** ✓。
 *
 * 但"样子不一样"不能靠猜 ✗。本项目已经因为"盲改 CSS"连吃四次回归
 * （见 `ui-preview.mjs` 头注释），所以这里先**把两版的输入区量成两份 JSON** ✓，
 * 再让 diff 告诉我"到底哪几个值变了" ✓ —— 然后只针对**变了的**那几个值写最小 CSS ✓。
 *
 * ## 为什么不用"两个进程各起一套完整手机栈"
 *
 * 输入区是 **DSH 自己**渲染的 ✓（不是我们画的）—— 我们只在 `boot.js` 里叠样式 ✓。
 * 所以"两版差在哪"这个问题，在 DSH 自己的页面上量就够了 ✓：
 * 同一套测量代码、同一个视口、同一个状态（新对话 ✓），**唯一变量就是 DSH 版本** ✓。
 *
 * ★ 这里**不注入 `boot.js`** ✗（那是产品页面的事 ✓）—— 本探针量的是**上游**；
 *   我们叠的样式由另一条断言守（见 `check-mobile-layout.mjs`）✓。
 *
 * ## 纪律（与仓库里其它套件同一套）
 *
 * - **只读** ✓：不写任何 profile、不改任何状态、不装任何东西；
 * - Chrome 用自己的**临时 profile** ✓，收尾**只按自己的 profile 路径**回收 ✓
 *   （绝不按端口或进程名杀 —— 会误伤用户正开着的 Chrome ✗）；
 * - 早退点全部走 `finally` ✓（这套东西任何一个 await 卡住都会一直挂着 ✗）。
 *
 * ## 用法
 *
 * ```bash
 * node scripts/probe-composer.mjs --url http://127.0.0.1:3751 --token <t> --label dsh015
 * node scripts/probe-composer.mjs --url http://127.0.0.1:3741 --token <t> --label dsh017
 * # 两份 JSON 落在 --out（默认 /tmp/composer-probe/），再 diff：
 * node scripts/probe-composer.mjs --diff /tmp/composer-probe/dsh015.json /tmp/composer-probe/dsh017.json
 * ```
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { snapshotChromeClones, sweepChromeClones, removeQuietly } from './chrome-clone-guard.mjs'

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

const argv = process.argv.slice(2)
const flag = (name, fallback) => {
  const bare = name.replace(/^--?/, '')
  const index = argv.findIndex((arg) => arg === name || arg === bare)
  return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : fallback
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* ─────────────────────────── diff 模式 ─────────────────────────── */

if (argv.includes('--diff')) {
  const at = argv.indexOf('--diff')
  const [, left, right] = argv.slice(at)
  if (!left || !right) {
    console.error('用法：--diff <左边.json> <右边.json>')
    process.exit(2)
  }
  process.exit(diffMode(resolve(left), resolve(right)))
}

function flatten(node, prefix = '', out = new Map()) {
  for (const [key, value] of Object.entries(node ?? {})) {
    const path = prefix === '' ? key : `${prefix}.${key}`
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) flatten(value, path, out)
    else out.set(path, Array.isArray(value) ? JSON.stringify(value) : value)
  }
  return out
}

/** 一个节点的简短身份 ✓ —— diff 里要能认出"这是哪一层/哪个元素"✓。 */
function describe(node) {
  const classes = (node.classes ?? []).join('.')
  const slotsAttr = (node.slots ?? []).length ? ` [${(node.slots ?? []).join(' ')}]` : ''
  const text = node.innerText ? ` "${node.innerText}"` : ''
  return `<${node.tag}${classes ? '.' + classes : ''}>${slotsAttr}${text}`
}

/**
 * ★★ **语义配对键** ✓ —— 结构位置配对在"新版往输入区里插了控件"时**必然错位** ✗
 *   （0.15 → 0.17/0.2.0 就插了「访问模式」，先序序号从插入点起全体挪一格 ✓）。
 *
 * 类名是 CSS Modules 的哈希 ✓（`uV2eYG_card` → `yhfFVG_card` → 每版都变 ✗），
 * 但 **`_` 之后那一半是模块自己的键名** ✓（`card` / `primary` / `seat` / `trigger`…），
 * 上游改样式不会改它 ✓ ⇒ 拿它当身份比拿哈希当身份稳得多 ✓。
 *
 * ★ 深度**不进键** ✗ —— 0.2.0 把两个控件多包了一层 `standardControls` ✓，
 *   带上深度就会让同一个按钮在两边算成两个键 ✓（第一版就是这样漏掉了 trigger / primary ✓）。
 * ★ 裸节点（没有模块键名、也没有 data-* 的 `<svg>`/`<path>`）必须**带上父节点的键** ✗ ——
 *   只按"深度 + 标签"配会把**不同分支**的两个 svg 配成一对 ✓
 *   （第一版把 0.15 加号键的图标和 0.2.0 发送键的箭头配在了一起，读出一个假差异 ✓）。
 */
function semanticGroups(payload) {
  const groups = new Map()
  /** 深度 → 该深度的键 ✓（裸节点也用**合成后的键**往下传 ⇒ 孙节点还能区分 ✓）。 */
  const keyAt = []
  for (const node of payload.subtree ?? []) {
    const suffixes = (node.classes ?? [])
      .map((c) => c.slice(c.lastIndexOf('_') + 1))
      .sort()
      .join('.')
    const slots = (node.slots ?? []).join(',')
    const named = suffixes !== '' || slots !== '' || node.id !== null
    const self = `${node.tag}|${suffixes}|${slots}`
    keyAt.length = node.depth
    const key = named ? self : `${keyAt[node.depth - 1] ?? ''}>${self}`
    keyAt[node.depth] = key
    // 同一父下同键的兄弟（多个裸 svg / 多个 trigger）按出现顺序配 ✓
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(node)
  }
  return groups
}

/**
 * 把一份探针结果摊平成"可对齐的键 → 值"✓。
 *
 * ★ 为什么要**按位置对齐** ✗：两版的类名是 CSS Modules 的哈希（`_composer_1a2b3` 这种 ✓），
 *   **同名不保证同元素** ✗ —— 所以不能按类名配对 ✓。这里按**结构位置**配对 ✓
 *   （祖先链按层号 ✓、子树按先序序号 ✓），并在输出里把两边的身份并排打出来 ✓ ——
 *   一旦结构真的错位了，身份那一列会**一眼看出来** ✓（而不是悄悄比错东西 ✗）。
 */
function slots(payload) {
  const out = new Map()
  for (const node of payload.chain ?? []) {
    for (const [key, value] of flatten(node.computed, `链[${node.depth}].`)) out.set(key, value)
  }
  for (const node of payload.subtree ?? []) {
    for (const [key, value] of flatten(node.computed, `树[${node.index}].`)) out.set(key, value)
  }
  return out
}

function shapeOf(payload, kind) {
  return (payload[kind] ?? []).map(describe)
}

/**
 * 只报"两边不一样"的键 ✓ —— 并且按"是不是数值"分开列 ✓。
 * 数值差给绝对值 ✓（例如 `padding: 12px → 8px（-4）`），比只看字符串直观得多 ✓。
 */
function diffMode(leftPath, rightPath) {
  const left = JSON.parse(readFileSync(leftPath, 'utf8'))
  const right = JSON.parse(readFileSync(rightPath, 'utf8'))
  const l = slots(left)
  const r = slots(right)
  const keys = [...new Set([...l.keys(), ...r.keys()])].sort()
  const changed = []
  for (const key of keys) {
    const a = l.get(key)
    const b = r.get(key)
    if (JSON.stringify(a) === JSON.stringify(b)) continue
    changed.push({ key, left: a, right: b })
  }
  console.log(`# 输入区差异：${left.label} → ${right.label}`)
  console.log(`#   左 ${leftPath}`)
  console.log(`#   右 ${rightPath}`)
  console.log(`# 视口 ${left.viewport.width}x${left.viewport.height} ／ ${right.viewport.width}x${right.viewport.height}`)
  console.log(
    `# 输入区 ${left.chain[0].rect.w}x${left.chain[0].rect.h} ／ ${right.chain[0].rect.w}x${right.chain[0].rect.h}` +
      `   祖先链 ${left.chain.length}／${right.chain.length} 层   子树 ${left.subtree.length}／${right.subtree.length} 节点`,
  )

  /** 结构对齐体检 ✓ —— 层数/节点数不同时先看这里，别看样式 ✗。 */
  const shaped = []
  for (const kind of ['chain', 'subtree']) {
    const a = shapeOf(left, kind)
    const b = shapeOf(right, kind)
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      if (a[i] !== b[i]) shaped.push({ kind, i, left: a[i] ?? '(无)', right: b[i] ?? '(无)' })
    }
  }
  console.log(`\n## ★ 要害部件（按语义命名，不受插入影响 ✓）`)
  const partNames = ['card', 'input']
  for (const name of partNames) {
    const a = left.parts?.[name]
    const b = right.parts?.[name]
    if (!a || !b) {
      console.log(`  ${name}: ${left.label}=${a ? '有' : '无'} / ${right.label}=${b ? '有' : '无'}`)
      continue
    }
    const fa = flatten(a.computed ?? {}, '')
    const fb = flatten(b.computed ?? {}, '')
    const keys2 = [...new Set([...fa.keys(), ...fb.keys()])].sort()
    const rows = keys2.filter((k) => JSON.stringify(fa.get(k)) !== JSON.stringify(fb.get(k)))
    console.log(
      `  ${name}  ${left.label} ${a.rect.w}x${a.rect.h} ／ ${right.label} ${b.rect.w}x${b.rect.h}` +
        `   几何差 ${b.rect.w - a.rect.w}x${b.rect.h - a.rect.h}  样式差 ${rows.length} 项`,
    )
    if (a.placeholder !== undefined || b.placeholder !== undefined) {
      console.log(`      占位文案  ${left.label}: ${JSON.stringify(a.placeholder)}`)
      console.log(`                ${right.label}: ${JSON.stringify(b.placeholder)}`)
    }
    for (const k of rows) console.log(`      ${k}: ${fa.get(k)} → ${fb.get(k)}`)
  }

  const btnA = left.parts?.buttons ?? []
  const btnB = right.parts?.buttons ?? []
  console.log(`\n  按钮：${left.label} ${btnA.length} 个 ／ ${right.label} ${btnB.length} 个`)
  const maxBtn = Math.max(btnA.length, btnB.length)
  for (let i = 0; i < maxBtn; i++) {
    const a = btnA[i]
    const b = btnB[i]
    const fmt = (x) => (x ? `${x.name} ${x.rect.w}x${x.rect.h} r=${x.computed.borderTopLeftRadius} bg=${x.computed.backgroundColor}` : '(无)')
    console.log(`    [${i}] ${left.label}: ${fmt(a)}`)
    console.log(`        ${right.label}: ${fmt(b)}`)
    // 名字不同的那一对多半是**换了文案/换了部件** ✓（例如 0.15 的「指令 + 添加附件」在 0.17+ 合成一个 ✓）
    if (a && b && a.name !== b.name) {
      console.log(`        ★ 名称不同 ⇒ 这一对多半不是同一个部件，别按序号当同一件比 ✗`)
    }
  }

  console.log(`\n## 结构对齐（不一致 ${shaped.length} 处）`)
  if (shaped.length === 0) console.log('  两侧结构逐一对应 ✓')
  for (const s of shaped) {
    console.log(`  ${s.kind}[${s.i}]\n      ${left.label}: ${s.left}\n      ${right.label}: ${s.right}`)
  }

  console.log(`\n## ★ 语义配对（类名去哈希后同名 ⇒ 同一个部件 ✓；**不受插入影响** ✓）`)
  {
    const gl = semanticGroups(left)
    const gr = semanticGroups(right)
    const onlyLeft = [...gl.keys()].filter((k) => !gr.has(k))
    const onlyRight = [...gr.keys()].filter((k) => !gl.has(k))
    const both = [...gl.keys()].filter((k) => gr.has(k))
    console.log(
      `  同名部件 ${both.length} 个 ／ 只在 ${left.label} 有 ${onlyLeft.length} 个 ／ 只在 ${right.label} 有 ${onlyRight.length} 个`,
    )
    let styleDiff = 0
    for (const key of both) {
      const la = gl.get(key)
      const ra = gr.get(key)
      const n = Math.min(la.length, ra.length)
      for (let i = 0; i < n; i++) {
        const a = la[i]
        const b = ra[i]
        const fa = flatten(a.computed ?? {}, '')
        const fb = flatten(b.computed ?? {}, '')
        const rows = [...new Set([...fa.keys(), ...fb.keys()])]
          .sort()
          .filter((k) => JSON.stringify(fa.get(k)) !== JSON.stringify(fb.get(k)))
        const textDiff = (a.innerText ?? '') !== (b.innerText ?? '') ? ` 文案 ${JSON.stringify(a.innerText ?? '')} → ${JSON.stringify(b.innerText ?? '')}` : ''
        if (rows.length === 0 && textDiff === '') continue
        styleDiff += rows.length
        const name = key.split('|')[2] || key
        console.log(
          `  ── ${name}  ${left.label} ${a.rect.w}x${a.rect.h} ／ ${right.label} ${b.rect.w}x${b.rect.h}${textDiff}`,
        )
        for (const k of rows) console.log(`        ${k}: ${fa.get(k)} → ${fb.get(k)}`)
      }
    }
    console.log(`  语义配对上的样式差合计 ${styleDiff} 项`)
    for (const k of onlyLeft) console.log(`  ✗ 只在 ${left.label} 有：${describe(gl.get(k)[0])}`)
    for (const k of onlyRight) console.log(`  ✗ 只在 ${right.label} 有：${describe(gr.get(k)[0])}`)
  }

  console.log(`\n## 样式差异（按**结构位置**配对 —— 插了控件就会错位 ✗，只作参考；共 ${keys.length} 个键，**${changed.length} 个不同**）`)
  for (const c of changed) {
    console.log(`  ${c.key}\n      ${left.label}: ${c.left}\n      ${right.label}: ${c.right}`)
  }
  return 0
}

/* ─────────────────────────── 测量模式 ─────────────────────────── */

const URL_BASE = flag('--url', '')
const TOKEN = flag('--token', '')
const LABEL = flag('--label', 'probe')
const OUT = resolve(flag('--out', join(tmpdir(), 'composer-probe')))
const WIDTH = Number(flag('--width', '390'))
const HEIGHT = Number(flag('--height', '844'))
const HEADLESS = flag('--headless', 'new')
/**
 * 首启遮罩的按钮文案（逗号分隔 ✓，按顺序试 ✓）。
 *
 * ★ 为什么必须有这个 ✗：全新 `DSH_HOME` 打开界面会先弹一层**挡住整页**的首启对话框 ✓
 *   （0.15 是「内测声明 ⇒ 继续」✓、0.17 是「添加一个 API Key ⇒ 稍后配置」✓）——
 *   不点掉它，量到的就是"被遮罩压着的输入区"✗（第一版就栽在这 ✓，截图里只有遮罩 ✓）。
 * ★ 一律选**最不粘人**的那个按钮 ✗（「稍后配置」而不是「保存并继续」✓）——
 *   本探针**只读** ✓，绝不替用户配置任何东西 ✓。
 */
const DISMISS = (flag('--dismiss', '继续,稍后配置,我知道了') ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter((s) => s !== '')
/**
 * 追加到地址上的查询串（例如 `mobile=1` ✓）。
 *
 * ★★ 为什么非有它不可 ✗ —— 这是本探针**第二次**栽在同一类"表面不对"上 ✓：
 *   整块移动端外壳（`installShell` ✓，我们叠给手机的全部 CSS 都在里面 ✓）
 *   只在 `isShellSurface()` 为真时装 ✓，而它要求：
 *     · 路径是 `/mobile/app` ✓，**或**
 *     · 查询里有 `mobile=1` ✓，**或**
 *     · `isMobileSurface() && innerWidth < 1024` ✓ ——
 *       前者又要求"这台设备在本源里已经配对过"✓（`readStoredHost() !== undefined` ✓）。
 *   我第一版量的是 `/?token=…`（**没配对** ✓）⇒ 三个条件全不成立 ⇒
 *   `installShell` 压根没跑 ⇒ 页面里 `data-dshm-*` 一个都没有 ✗、
 *   我们那几条 composer 规则也不在 ✓ —— 于是"改了 CSS、读数一个字没变"✗。
 *   ⇒ 量手机表面**必须**显式带上 `mobile=1` ✓（无头环境里没法真配对 ✓）。
 */
const QUERY = flag('--query', '')
/**
 * 额外注入一份 CSS 再量 ✓（默认不注入 ✓）。
 *
 * ★ 用途：验证"**某条规则真的能赢**" ✓ —— 有些状态在无头环境里到不了
 *   （例如 `/mobile/app` 上没配对 ⇒ 输入卡片压根不渲染 ✓，
 *    可它偏偏是「圆角 22 vs 28」那条规则唯一的作用对象 ✗）。
 *   这时就把**产物里那份原文**（从 `/mobile/boot.js` 抽出来的 ✓，不是手抄的 ✗）
 *   注进一个卡片确实存在的页面（`/?token=…` ✓）再量一次 ✓ ——
 *   规则能不能赢、赢了之后等于几 ✓，一次就定案 ✓。
 *   ★ 这**不是**在替产品注入 ✗：产品那条路已由"壳表面上的 chip 圆角 / 发送键底色"
 *     两条实测证明打通 ✓（见交接文档）；这里只补最后一条的**取值** ✓。
 */
const INJECT = flag('--inject', '')
if (INJECT !== '' && !existsSync(INJECT)) {
  console.error(`--inject 指向的文件不存在：${INJECT}`)
  process.exit(2)
}

if (URL_BASE === '') {
  console.error('缺少 --url（例如 http://127.0.0.1:3751）')
  process.exit(2)
}
if (!existsSync(CHROME)) {
  console.error(`找不到 Chrome：${CHROME}`)
  process.exit(2)
}

mkdirSync(OUT, { recursive: true })
const profileDir = mkdtempSync(join(tmpdir(), 'probe-composer-'))
const cloneSnapshot = snapshotChromeClones()
let chrome
let ws

/** 页面侧要跑的采集代码。写成字符串是为了 `Runtime.evaluate` 直接吃 ✓。 */
const COLLECT = String.raw`
(() => {
  const round = (n) => Math.round(n * 100) / 100
  const rect = (el) => {
    const r = el.getBoundingClientRect()
    return { x: round(r.x), y: round(r.y), w: round(r.width), h: round(r.height) }
  }
  /** 我们要的那一族计算样式：凡是"看起来会不一样"的都收进来 ✓（宁可多收，diff 会筛）。 */
  const STYLE_KEYS = [
    'display', 'position', 'boxSizing', 'flexDirection', 'flexWrap', 'alignItems', 'justifyContent',
    'gap', 'rowGap', 'columnGap', 'gridTemplateColumns',
    'width', 'height', 'minWidth', 'minHeight', 'maxWidth', 'maxHeight',
    'marginTop', 'marginRight', 'marginBottom', 'marginLeft',
    'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
    'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
    'borderTopLeftRadius', 'borderTopRightRadius', 'borderBottomLeftRadius', 'borderBottomRightRadius',
    'borderTopColor', 'borderBottomColor', 'borderLeftColor', 'borderRightColor',
    'backgroundColor', 'backgroundImage', 'color', 'opacity', 'boxShadow',
    'fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'textAlign',
    'overflowX', 'overflowY', 'zIndex', 'transform', 'transition',
  ]
  const styles = (el) => {
    const cs = getComputedStyle(el)
    const out = {}
    for (const key of STYLE_KEYS) out[key] = cs[key]
    return out
  }
  /** 一个节点的"身份"：够我在两份 JSON 之间对上同一个元素 ✓。 */
  const identify = (el, index) => ({
    index,
    tag: el.tagName.toLowerCase(),
    id: el.id || null,
    classes: [...el.classList],
    slots: [...el.attributes].filter((a) => a.name.startsWith('data-')).map((a) => a.name + '=' + a.value),
    role: el.getAttribute('role'),
    text: (el.childElementCount === 0 ? (el.textContent || '').trim().slice(0, 40) : null),
    /** ★ 整个控件的可见文字 ✓ —— 用来判"这个部件**有没有文字**"（决定某条样式该不该保 ✓）。 */
    innerText: (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 60),
    rect: rect(el),
    computed: styles(el),
  })

  /**
   * 定位输入区。
   *
   * 三条钩子按"稳 → 不稳"排 ✓：
   *   1. DSH 给的插槽标记 data-slot="conversation.composer.dock" ✓（最稳，语义化的 ✓）；
   *      ★ 这一段注释**不许出现反引号** ✗ —— 整块是 String.raw 模板，
   *        一个反引号就会让它**提前闭合** ✓（交接文档 §五记着这个坑 ✓）。
   *   2. 类名含 composer（CSS Modules 的哈希会变，但名字那半通常留着 ✓）；
   *   3. 兜底：包着 textarea / contenteditable 的那个最外层 ✓。
   */
  const slot = document.querySelector('[data-slot="conversation.composer.dock"]')
  const byClass = [...document.querySelectorAll('[class*="composer" i]')]
  const editable = document.querySelector('textarea, [contenteditable="true"]')
  let root = slot || null
  if (!root && byClass.length) {
    // 取"最外层且真的包着输入控件"的那一个 ✓ —— 内层还有好几层 composer*
    const withEditable = byClass.filter((el) => el.querySelector('textarea, [contenteditable="true"]'))
    root = withEditable.length ? withEditable[0] : byClass[0]
  }
  if (!root && editable) {
    let el = editable
    for (let i = 0; i < 8 && el.parentElement; i++) el = el.parentElement
    root = el
  }
  if (!root) return { ok: false, reason: '找不到输入区（没有 data-slot / composer* / 输入控件）', url: location.href }

  /** 祖先链：从输入区根一直到 body ✓ —— 让位、限高、内边距这些常发生在中间层 ✓。 */
  const chain = []
  let el = root
  for (let depth = 0; el && depth < 14; depth++) {
    chain.push({ depth, ...identify(el, depth) })
    el = el.parentElement
  }

  /** 子树：输入区里面画了什么 ✓（输入卡片 / 左侧加号 / 右侧发送 / 下面那行统计 ✓）。 */
  const subtree = []
  const walk = (node, depth) => {
    /**
     * ★ 深度上限 14（原为 8 ✗）：8 层只到 trailing 那一层 ⇒ **发送键 / 两个 trigger
     *   （访问模式、选择模型）压根没被收进来** ✗ ⇒ 语义配对漏掉的就是"最该看的那几个控件" ✓。
     *   输入区整体只有十几层 ✓（祖先链上限也是 14 ✓），放到 14 就能把卡片里的控件收全 ✓。
     *   ★ 本段属于 String.raw 模板 ⇒ **一个反引号都不能出现** ✗（本轮又栽了一次 ✓）。
     */
    if (depth > 14) return
    subtree.push({ depth, ...identify(node, subtree.length) })
    for (const child of node.children) walk(child, depth + 1)
  }
  walk(root, 0)

  /**
   * ★★ 按**语义命名**把要害部件单独摘出来 ✓ —— 这才是能直接拿来写 CSS 的那份数据 ✓。
   *
   * 为什么不能只靠上面那份"先序子树"✗：0.17 往输入区里**插了新控件**
   * （模式钮、模型选择器 ✓）⇒ 先序序号从插入点起**全体错位** ✗ ⇒
   * 按位置配对会把 A 的样式和 B 的样式比在一起 ✗（第一版就是这样，diff 出来一片假差异 ✓）。
   * 按"角色 + 标签"命名就不受插入影响 ✓。
   */
  const label = (el) =>
    (el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('data-testid') ||
      (el.textContent || '').trim() || el.tagName.toLowerCase()).slice(0, 30)

  /** 输入卡片 = 从输入控件往上找**第一个画了盒子**的祖先 ✓（有底色或有边框 ✓）。 */
  const inputEl = root.querySelector('textarea, [contenteditable="true"]')
  let card = null
  if (inputEl) {
    let el = inputEl
    for (let i = 0; i < 6 && el && el !== root.parentElement; i++) {
      const cs = getComputedStyle(el)
      const bg = cs.backgroundColor
      const hasBg = bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent'
      const hasBorder = parseFloat(cs.borderTopWidth) > 0 || parseFloat(cs.borderLeftWidth) > 0
      if (hasBg || hasBorder) {
        card = el
        break
      }
      el = el.parentElement
    }
    if (!card) card = inputEl.parentElement
  }

  const parts = {}
  if (card) parts.card = { ...identify(card, 0), where: '输入卡片（输入控件的画盒祖先）' }
  if (inputEl) {
    parts.input = { ...identify(inputEl, 0), where: '真正的输入控件' }
    parts.input.placeholder = inputEl.getAttribute('placeholder') || inputEl.getAttribute('data-placeholder') || null
  }
  /** 输入区里所有按钮 ✓ —— 带标签，插入了新按钮也认得出谁是谁 ✓。 */
  parts.buttons = [...root.querySelectorAll('button, [role="button"]')]
    .filter((el) => el.offsetParent !== null)
    .map((el, i) => ({ index: i, name: label(el), ...identify(el, i) }))

  return {
    ok: true,
    url: location.href,
    userAgent: navigator.userAgent,
    viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
    /**
     * ★★ 这次读数**带不带 boot.js** ✓ —— 不写清楚就会量出一个假差异 ✗。
     * （★ 本段属于上面那个 String.raw 模板 ⇒ **一个反引号都不能出现** ✗ —— 我在这同一条上栽了两次 ✓。）
     *
     * 真实踩过 ✓：拿"全新 DSH_HOME 的 0.15 实例"（**没装插件** ⇒ /mobile/boot.js 返回 404 ✓）
     * 去比"装了插件的 0.17 实例" ✓ ⇒ 两边的变量不止"DSH 版本"一个 ✗ ——
     * 我们还往一边叠了整套移动端 CSS ✓。**要比就得两边都装** ✓。
     */
    boot: {
      script: !!document.querySelector('script[data-dsh-mobile="1"]'),
      statsBar: !!document.getElementById('dshm-stats'),
      topHeader: !!document.querySelector('[data-dshm-topheader]'),
      /**
       * ★ 自检：我们那条规则**到底有没有进到页面里** ✓。
       * 症状是"改了 boot.js、也重新装了、读数却一个字没变"✓ ——
       * 这时要能一眼分清是「规则没进去」还是「进去了但没赢」✗，别再猜 ✓。
       */
      styleTags: document.querySelectorAll('style').length,
      tagsWithComposerRule: [...document.querySelectorAll('style')].filter((t) =>
        (t.textContent || '').includes('data-composer-card'),
      ).length,
      /**
       * ★★ 后缀选择器**能命中多宽** ✓ —— 我们那几条覆盖用的是"只认下划线之后那半截"的写法 ✓
       *   （例如 [class*="_primary"] 这类 ✓），好处是不怕上游换哈希 ✓，
       *   代价是**可能命中计划外的元素** ✗ ⇒ 这里把整页的命中数按"按钮 / 非按钮"分开数 ✓，
       *   并在按钮那栏带上类名 ✓ —— "只命中那一个按钮"这件事要能被读数证明 ✓，不靠推 ✓。
       *   ★ 本段属于 String.raw 模板 ⇒ **反引号一个都不能有** ✗（本轮又栽了一次 ✓）。
       */
      suffixHits: (() => {
        const keys = ['_primary', '_workspace', '_seat', '_trigger', '_card']
        const out = {}
        for (const key of keys) {
          const all = [...document.querySelectorAll('[class*="' + key + '"]')]
          const buttons = all.filter((el) => el.tagName === 'BUTTON')
          out[key] = {
            全部: all.length,
            按钮: buttons.length,
            按钮类名: buttons.slice(0, 8).map((el) => [...el.classList].join('.')),
          }
        }
        return out
      })(),
      htmlAttrs: [...document.documentElement.attributes].map((a) => a.name),
      build: (() => {
        const found = [...document.querySelectorAll('style')].map((t) => (t.textContent || '').match(/BUILD-\d+/)?.[0])
        return found.filter(Boolean)[0] ?? null
      })(),
    },
    /**
     * ★ 遮罩体检 ✓ —— 有它在，下面所有读数都不可信 ✗（第一版就是被首启弹窗污染的 ✓）。
     * 判据：有 role=dialog / aria-modal，或者盖住视口大半的固定层 ✓。
     */
    blockingOverlay: (() => {
      const candidates = [...document.querySelectorAll('[role="dialog"], [aria-modal="true"]')]
        .filter((el) => el.offsetParent !== null)
      for (const el of candidates) {
        const r = el.getBoundingClientRect()
        if (r.width * r.height > innerWidth * innerHeight * 0.25) {
          return { kind: 'dialog', text: (el.textContent || '').trim().slice(0, 60), rect: rect(el) }
        }
      }
      return null
    })(),
    /** 命中的是三条钩子里的哪一条 ✓ —— 换版本后钩子失效时要能一眼看出来 ✓。 */
    hook: slot ? 'data-slot' : (byClass.length ? 'class*=composer' : 'editable-ancestor'),
    rootClasses: [...root.classList],
    /** 页面顶层容器，用来判断"是不是整页布局也变了" ✓。 */
    shell: (() => {
      const first = document.body.firstElementChild
      return first ? { tag: first.tagName.toLowerCase(), classes: [...first.classList], rect: rect(first) } : null
    })(),
    chain,
    subtree,
    parts,
  }
})()
`

async function main() {
  const port = 9800 + Math.floor(Math.random() * 150)
  chrome = spawn(
    CHROME,
    [
      `--headless=${HEADLESS}`,
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--disable-gpu',
      '--hide-scrollbars',
      'about:blank',
    ],
    { stdio: 'ignore', detached: true },
  )

  let target
  for (let i = 0; i < 80 && target === undefined; i++) {
    await sleep(250)
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      target = list.find((t) => t.type === 'page')
    } catch {
      /* 还没起来 */
    }
  }
  if (target === undefined) throw new Error('Chrome 未就绪')

  ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    ws.onopen = res
    ws.onerror = rej
  })
  let id = 0
  const pending = new Map()
  const consoleLines = []
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data)
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message)
      pending.delete(message.id)
    }
    if (message.method === 'Runtime.consoleAPICalled') {
      consoleLines.push(
        `${message.params.type}: ${(message.params.args ?? []).map((a) => a.value ?? a.description ?? '').join(' ')}`,
      )
    }
  }
  const send = (method, params = {}) =>
    new Promise((resolveSend, rejectSend) => {
      const messageId = ++id
      const timer = setTimeout(() => {
        pending.delete(messageId)
        rejectSend(new Error(`CDP 超时：${method}`))
      }, 30_000)
      pending.set(messageId, (message) => {
        clearTimeout(timer)
        if (message.error) rejectSend(new Error(`${method}: ${JSON.stringify(message.error)}`))
        else resolveSend(message.result)
      })
      ws.send(JSON.stringify({ id: messageId, method, params }))
    })

  await send('Page.enable')
  await send('Runtime.enable')
  /** 手机形态 ✓ —— 与手机同宽，让 DSH 走它那套窄屏分支 ✓。 */
  await send('Emulation.setDeviceMetricsOverride', {
    width: WIDTH,
    height: HEIGHT,
    deviceScaleFactor: 2,
    mobile: true,
  })
  await send('Emulation.setUserAgentOverride', {
    userAgent:
      'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
  })

  const params = []
  if (TOKEN !== '') params.push(`token=${encodeURIComponent(TOKEN)}`)
  if (QUERY !== '') params.push(QUERY.replace(/^\?/, ''))
  const url = params.length === 0 ? URL_BASE : `${URL_BASE}/?${params.join('&')}`
  await send('Page.navigate', { url })

  if (INJECT !== '') {
    const css = readFileSync(INJECT, 'utf8')
    const applied = await send('Runtime.evaluate', {
      expression: `(() => {
        const el = document.createElement('style')
        el.setAttribute('data-probe-inject', '1')
        el.textContent = ${JSON.stringify(css)}
        document.head.appendChild(el)
        return el.textContent.length
      })()`,
      returnByValue: true,
    })
    console.log(`  已注入 ${INJECT}（${applied?.result?.value ?? 0} 字符）`)
  }

  /**
   * 先把首启遮罩点掉 ✓ —— 只在**真的有匹配按钮**时点 ✓，
   * 点完把文案记进 JSON ✓（这样"读数是不是被遮罩污染过"在报告里是**可证**的 ✓）。
   */
  const pressed = []
  const clickLabel = (label) => `(() => {
    const target = ${JSON.stringify(label)}
    const nodes = [...document.querySelectorAll('button, [role="button"], a')]
    const hit = nodes.find((el) => (el.textContent || '').trim() === target && el.offsetParent !== null)
    if (!hit) return null
    hit.click()
    return target
  })()`
  for (let round = 0; round < 6; round++) {
    await sleep(900)
    for (const label of DISMISS) {
      const result = await send('Runtime.evaluate', { expression: clickLabel(label), returnByValue: true })
      if (result?.result?.value) {
        pressed.push(result.result.value)
        break
      }
    }
  }

  /** 等输入区出现 ✓ —— 冷启动要拉前端 bundle，给足预算 ✓。 */
  let collected = null
  for (let i = 0; i < 60; i++) {
    await sleep(500)
    const result = await send('Runtime.evaluate', { expression: COLLECT, returnByValue: true, awaitPromise: false })
    const value = result?.result?.value
    if (value?.ok) {
      collected = value
      break
    }
    collected = value ?? collected
  }
  /** 再稳一下：字体/动画落地后尺寸才是最终的 ✓。 */
  await sleep(1200)
  const settled = await send('Runtime.evaluate', { expression: COLLECT, returnByValue: true, awaitPromise: false })
  if (settled?.result?.value?.ok) collected = settled.result.value

  if (collected === null) {
    console.error('采集失败：没有拿到任何结果')
    process.exitCode = 1
    return
  }
  if (!collected.ok) {
    console.error(`采集失败：${collected.reason}`)
    process.exitCode = 1
    return
  }

  const shot = await send('Page.captureScreenshot', { format: 'png' })
  const png = join(OUT, `${LABEL}.png`)
  writeFileSync(png, Buffer.from(shot.data, 'base64'))

  /**
   * ★ 再来一张**只框住输入区**的放大图 ✓ —— 逐像素看差异靠它 ✓。
   *
   * 为什么值得单独存一张 ✗：整页图里输入区只占一小块 ✓，圆角差 6px 这种在整页图上
   * **根本看不出来** ✗（而它正是"风格变没变"的全部 ✓）。放大 3 倍框住它 ✓，
   * 两版并排一眼就能定案 ✓。
   */
  const box = collected.chain[0].rect
  const pad = 10
  const clip = {
    x: Math.max(0, box.x - pad),
    y: Math.max(0, box.y - pad),
    width: box.w + pad * 2,
    height: box.h + pad * 2,
    scale: 3,
  }
  const zoom = await send('Page.captureScreenshot', { format: 'png', clip })
  const zoomPng = join(OUT, `${LABEL}-composer.png`)
  writeFileSync(zoomPng, Buffer.from(zoom.data, 'base64'))

  const payload = {
    label: LABEL,
    baseUrl: URL_BASE,
    probedAt: new Date().toISOString(),
    viewport: { width: WIDTH, height: HEIGHT },
    dismissed: pressed,
    ...collected,
    consoleLines,
  }
  const json = join(OUT, `${LABEL}.json`)
  writeFileSync(json, JSON.stringify(payload, null, 2))

  if (collected.blockingOverlay) {
    console.error(`✗ ${LABEL}：还有遮罩挡着（${collected.blockingOverlay.text}）—— 读数不可信`)
    console.error(`  用 --dismiss 把它的按钮文案指出来再跑一次`)
    process.exitCode = 1
    return
  }

  console.log(`✓ ${LABEL}：钩子=${collected.hook}  输入区 ${collected.chain[0].rect.w}x${collected.chain[0].rect.h}`)
  console.log(`  子树 ${collected.subtree.length} 个节点 / 祖先链 ${collected.chain.length} 层`)
  console.log(
    `  boot.js：${collected.boot.script ? '已注入 ✓' : '**没注入** ✗'}  状态栏=${collected.boot.statsBar ? '有' : '无'}  顶栏=${collected.boot.topHeader ? '有' : '无'}`,
  )
  if (pressed.length) console.log(`  已点掉首启遮罩：${pressed.join('、')}`)
  console.log(`  JSON  ${json}`)
  console.log(`  截图  ${png}`)
  console.log(`  放大  ${zoomPng}`)
}

try {
  await main()
} finally {
  try {
    ws?.close()
  } catch {
    /* 关不掉就算了 */
  }
  if (chrome?.pid) {
    try {
      process.kill(-chrome.pid, 'SIGKILL')
    } catch {
      try {
        chrome.kill('SIGKILL')
      } catch {
        /* 已经没了 */
      }
    }
  }
  removeQuietly(profileDir)
  /** 只回收**本次新增**的 code_sign_clone ✓（见 chrome-clone-guard.mjs）✓。 */
  sweepChromeClones(cloneSnapshot)
}
