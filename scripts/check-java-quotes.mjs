#!/usr/bin/env node
/**
 * ★ 机械守卫：Java 源码里**一行出现奇数个双引号** ⇒ 可疑（几乎总是"中文句子中间夹了半角引号"✗）。
 *
 * ## 为什么值得单开一条（而且值得放在 CI/一键全验里）
 *
 * 这个错我已经犯过**至少五次** ✓：写断言名时顺手用了半角 `"` ✓ ⇒
 * `check("★ 说它是"当前"那台", …)` ⇒ **javac 当场报一堆"需要 ')'"** ✓。
 * 症状不隐蔽 ✓，但**每次都要等编译**才发现 ✓，而且我每次都"知道了"却照样再犯 ✓。
 * ⇒ 与其再道歉一次，不如让机器一眼看出来 ✓。
 *
 * ★ 只查**奇数个**（成对的内层引号是合法的转义场景 ✓ 会正常配对 ✓；真正漏掉的是奇数 ✓）。
 * ★ 拼字符串的长行（`"a" + "b"` ✓）会天然成对 ✓，不会误报 ✓。
 *
 * 用法：`node scripts/check-java-quotes.mjs`
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const roots = [join(repoRoot, 'native', 'android', 'java'), join(repoRoot, 'native', 'android', 'test')]

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
      if (line.trim().startsWith('*') || line.trim().startsWith('//') || line.trim().startsWith('/*')) continue
      /**
       * ★ 数**真正未转义**的双引号 ✗ —— 逐字符扫 ✓，不用正则 ✓
       *   （正则里 `\\"` / `\\\\` 的转义层数一层就够呛 ✓，我第一版就是这么写歪的 ✓：
       *    先是误报 9 处 ✓，改成"先剥转义"又漏 ✓ —— 一个会误报的守卫等于没有守卫 ✓）。
       *   规则：遇到反斜杠 ⇒ 连同下一个字符一起吃 ✓（那是一个转义对，不参与计数 ✓）。
       */
      let count = 0
      for (let at = 0; at < line.length; at += 1) {
        const ch = line[at]
        if (ch === '\\') {
          at += 1 // ★ 吃掉被转义的那个字符 ✓
          continue
        }
        if (ch === "'") {
          // ★ 字符字面量整段跳过 ✗ —— `case '"': out.append("\\\"");` 是**合法**的 ✓，
          //   但里面那个引号会让计数变奇数 ✓（我第一版就把它当可疑报了 ✓：会误报的守卫等于没有守卫 ✓）
          while (at + 1 < line.length && line[at + 1] !== "'") {
            at += line[at + 1] === '\\' ? 2 : 1
          }
          at += 1
          continue
        }
        if (ch === '"') count += 1
      }
      /**
       * ★★ 再加一条**收窄**：这一行**必须含中文** ✗ ——
       *   剩下那几处奇数引号全是**合法的**（JS 片段跨行拼接：`"...tick('"` ✓ / `+ json(name) + "','" +` ✓）；
       *   而我实际犯的错**全是**"中文句子里夹了半角引号" ✓。
       *   ⇒ 加这一条，误报从 5 处降到 **0** ✓，而该抓的一个不漏 ✓
       *   （一个会误报的守卫，人会直接忽略它 ✓ —— 那它就等于不存在 ✓）。
       */
      const hasCjk = /[\u4e00-\u9fff]/.test(line)
      if (count % 2 === 1 && hasCjk) {
        suspicious += 1
        console.log(`✗ ${path.replace(repoRoot + '/', '')}:${i + 1}：这一行有 ${count} 个双引号（奇数）且含中文 ⇒ 多半是中文里夹了半角引号 ✗`)
        console.log(`    ${line.trim().slice(0, 120)}`)
      }
    }
  }
}

console.log(`\n── check-java-quotes ──────────────────────────`)
console.log(`扫了 ${scanned} 个 .java 文件，可疑行 ${suspicious} 处`)
if (suspicious > 0) {
  console.log('★ 改法：把句子里的半角引号换成「」（与既有测试里的写法一致 ✓）')
  process.exit(1)
}
console.log('✓ 没有奇数引号的行 ✓')
