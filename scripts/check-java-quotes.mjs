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
const roots = [join(repoRoot, 'native', 'android', 'java'), join(repoRoot, 'native', 'android', 'test')]

const isCjk = (ch) => ch !== '' && /[\u3400-\u9fff\uf900-\ufaff]/.test(ch)

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
if (SELF_TEST.length < 4) {
  console.log('✗ 自检样例少于 4 条 —— 有人删了体检项 ✗')
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
