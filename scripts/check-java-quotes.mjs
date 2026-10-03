#!/usr/bin/env node
/**
 * ★ 机器守卫：专抓"**中文句子里夹了半角引号**" ✗（Java 里就是把字符串截断 ⇒ javac 报一串"需要 ')'"）。
 *
 * ## 为什么值得单开一条
 *
 * 这个错我犯过**至少六次** ✓，每次都要等编译才发现 ✓，而且我每次都"知道了"却照样再犯 ✓
 * ⇒ 与其再道歉一次，不如让机器一眼看出来 ✓。
 *
 * ## ★★ 判据：一个双引号，**两侧都是中文** ⇒ 几乎必然是它
 *
 * ★ 为什么不用"奇数个引号"✗（我第一版就是）：
 *   我的错**大多是成对的** ✓ —— 比如 `变"未知"✗` ⇒ 一行里引号数是**偶数** ✓
 *   ⇒ 奇数判据**抓不到它** ✓（2026-10-04 就是它漏过了 ✓，直到 javac 报错 ✓）。
 * ★ 而"两侧都是中文"很锐利 ✓：字符串**定界**那个引号，另一侧总是
 *   `(` `,` `)` `★` 这类非中文 ✓ ⇒ 不误报 ✓。
 *
 * ## ★★ 守卫自己也要被验（`--self-test`）
 *
 * 一个"悄悄失效的守卫"比没有守卫更糟 ✗（它会让人以为"这条已经有人看着了"✓）
 * ⇒ 每次运行都先跑三条内置样例 ✓；样例不过 ⇒ 直接红 ✓。
 *
 * 用法：`node scripts/check-java-quotes.mjs`（加 `--self-test` 只看体检结果 ✓）
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..')
/**
 * ★★ 2026-10-04 扩到**我实际会写错的语言** ✗ ——
 *   这条病（中文里夹半角引号）原先只查 Java ✓，可我当天在 **Python 的 heredoc 里又犯了** ✓
 *   （`"关掉 App 再打开它"` 写在双引号字符串里 ⇒ Python 语法错 ⇒ **整段编辑没落盘** ✓）。
 *   ★ heredoc 是内存里的东西、扫不到 ✗ ⇒ 能扫的是**落盘的脚本** ✓；
 *     真正的纪律是"**任何语言里，中文句子里一律用「」**"✓（本仓既有写法 ✓）。
 */
/**
 * ★★ 2026-10-04：**试过扩到 .py / .mjs，然后撤回了** ✗ ——
 *   扩完立刻报 **228 处** ✓，而绝大多数是**合法的**（JS 模板串里用引号强调中文 ✓）。
 *   ⇒ **一个报 228 次的守卫等于没有守卫** ✓（这条教训我自己写过 ✗，又亲手犯了一次 ✓）。
 *   真正致命的只有 **Java**（字符串定界符就是半角引号 ✓，中文里夹一个 ⇒ 当场截断 ✓）。
 *   ★ 其他语言（Python / JS）的规矩不靠扫描 ✓，靠纪律：**中文句子里一律写「」** ✓
 *     （写进 skill 与本文件头 ✓）。
 */
const roots = [join(repoRoot, 'native', 'android', 'java'), join(repoRoot, 'native', 'android', 'test')]

/**
 * ★★ "两侧"的判据：中日韩文字 **或全角标点** ✓。
 *   ★ 2026-10-04 补全角标点 ✗：我写了一句 `（"它们确实是存在的"✗` ✓ ——
 *   那个引号左边是全角括号 `（`（U+FF08 ✓，**不在** CJK 区 ✓）⇒ 旧判据**静默漏掉**了它 ✗，
 *   直到 javac 报错 ✓ ⇒ 守卫漏报比误报更糟 ✓（它会让人以为"这条有人看着"✓）。
 */
const isCjk = (ch) => ch !== '' && /[\u3000-\u303f\u3400-\u9fff\uf900-\ufaff\uff00-\uffef]/.test(ch)

/** 这一行里有没有"两侧都是中文"的双引号 ✓（逐字符扫，避开正则转义地狱 ✓）。 */
function scanLine(line) {
  for (let at = 0; at < line.length; at += 1) {
    const ch = line[at]
    if (ch === '\\') {
      at += 1 // ★ 吃掉被转义的那个字符 ✓（`\"` 不算一个引号 ✓）
      continue
    }
    if (ch !== '"') continue
    const before = at > 0 ? line[at - 1] : ''
    const after = at + 1 < line.length ? line[at + 1] : ''
    if (isCjk(before) && isCjk(after)) return true
  }
  return false
}

/** ★ 体检样例：必须抓到的 ✓ / 不许误报的 ✓。 */
const SELF_TEST = [
  { line: 'check("★ 说它是"未知"那台", x);', mustFlag: true, why: '中文里夹了成对的半角引号（2026-10-04 真实犯过 ✓）' },
  { line: 'check("★ 说它是「未知」那台", x);', mustFlag: false, why: '正确的写法（用「」✓）' },
  { line: 'String js = "…tick(\\\'" + name + "\\\')…";', mustFlag: false, why: 'JS 片段跨行拼接（合法的奇数引号 ✓）' },
  { line: "case '\"': out.append(\"\\\\\\\"\"); break;", mustFlag: false, why: '字符字面量（合法的引号 ✓）' },
  // ★ 漏报过的那种形状 ✓（引号左边是**全角括号**，不是汉字 ✓）
  { line: 'check("（"它们确实是存在的"✗）", x);', mustFlag: true, why: '全角括号旁边的半角引号（2026-10-04 真漏过 ✓）' },
]

let selfTestFailures = 0
for (const sample of SELF_TEST) {
  const got = scanLine(sample.line)
  if (got !== sample.mustFlag) {
    selfTestFailures += 1
    console.log(`✗ 守卫自检没过：${sample.why}`)
    console.log(`    样例：${sample.line}`)
    console.log(`    期望 ${sample.mustFlag ? '抓到' : '放过'}，实际 ${got ? '抓到' : '放过'} ✗`)
  }
}
if (SELF_TEST.length < 5) {
  console.log('✗ 自检样例少于 5 条 —— 有人删了体检项 ✗')
  selfTestFailures += 1
}
console.log(`守卫自检：${SELF_TEST.length - selfTestFailures} ✓ / ${selfTestFailures} ✗（共 ${SELF_TEST.length} 条样例 ✓）`)
if (process.argv.includes('--self-test')) process.exit(selfTestFailures === 0 ? 0 : 1)

/** 递归收所有 .java ✓。 */
function collect(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) collect(path, out)
    else if (name.endsWith('.java')) out.push(path)
  }
  return out
}

let suspicious = 0
let scanned = 0
for (const root of roots) {
  for (const path of collect(root)) {
    scanned += 1
    const lines = readFileSync(path, 'utf8').split('\n')
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i]
      const trimmed = line.trim()
      if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) continue
      if (scanLine(line)) {
        suspicious += 1
        console.log(`✗ ${path.replace(repoRoot + '/', '')}:${i + 1}：中文里夹了半角引号 ✗`)
        console.log(`    ${trimmed.slice(0, 120)}`)
      }
    }
  }
}

console.log(`\n── check-java-quotes ──────────────────────────`)
console.log(`扫了 ${scanned} 个 .java 文件，可疑行 ${suspicious} 处`)
if (suspicious > 0 || selfTestFailures > 0) {
  console.log('★ 改法：把句子里的半角引号换成「」（与既有测试里的写法一致 ✓）')
  process.exit(1)
}
console.log('✓ 没有可疑行 ✓，守卫自检也过了 ✓')
