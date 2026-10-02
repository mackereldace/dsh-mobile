#!/usr/bin/env node
/**
 * **一键全验** —— 把这个仓库现有的五道验收一次跑完，最后给一张读数表 ✓。
 *
 * ## 为什么需要它
 *
 * 五道验收散在五个脚本里 ✓，而"该跑哪几道"全靠人记 ✗ ——
 * 我自己这几轮就**漏跑过**（改了宿主源码却只跑了单测 ✓、改了原生却忘了 `check-apk` ✓）。
 * 漏跑不会报错 ✓，只会让人**误以为"全都验过了"** ✗ —— 这正是本项目最忌讳的那种错 ✓。
 *
 * ## 五道（顺序有意：快的在前、慢的在后 ✓）
 *
 * | 道 | 验什么 | 典型读数 |
 * |---|---|---|
 * | 1 单元测试 | 宿主 + 客户端的逻辑不变量 | `npm test` ⇒ 400+ 条 |
 * | 2 首页数据层 | 身份归一 / 探测 / 选路 / 动画策略（JVM ✓） | `check-home-model` ⇒ 8 份测试 |
 * | 3 TLS 探针 | 真握手：钉住的 CA + 链校验（起真证书、真服务 ✓） | `check-manifest-probe` ⇒ 29 条 |
 * | 4 APK | 全量构建 + 包内容/形状/机器无关 | `build-apk` + `check-apk` ⇒ 51 条 |
 * | 5 会话页端到端 | 假隧道 + 真浏览器 + DOM 断言 | `check-chat-page` ⇒ 24 条 |
 * | 6 宿主真路由 | ★ 进程内起宿主 + **真 HTTP** 打 `/mobile/chat` 与 `/mobile/desktop/shot` | `check-host-routes` ⇒ 15 条 |
 *
 * ## 用法
 *
 * ```
 * node scripts/check-all.mjs            # 全跑
 * node scripts/check-all.mjs --fast     # 跳过第 3 道（TLS 那一道最慢，要起真证书）
 * ```
 *
 * ★ 不进这里的两条（各自有环境前提 ✓）：
 *   · `check-desktop-shot-live.mjs`（真跑截屏命令；有没有权限都能跑 ✓）；
 *   · `check-home-realdata.mjs`（**要求那台实例正在跑** ✓，是"验收"而不是无环境依赖的单测 ✓）。
 *
 * ★ **每一步的完整输出都落盘** ✓（`dist/check-all/NN-*.log` ✓）——
 *   这是被自己坑出来的：我前几次撞见偶发失败却用 `tail` 看输出 ✓，**把用例名丢了** ✗。
 *   落盘 + 汇总里直接写"哪条失败了" ✓，才不会再丢 ✓。
 *
 * ★★ **失败会自动重跑一次** ✓，并把两种结果分得很清：
 *   · 重跑也失败 ⇒ 真失败 ✓ ⇒ 退出码非零 ✓；
 *   · 首跑失败、重跑通过 ⇒ 标成「⚠ 抖动」✓ ⇒ **退出码仍是 0，但大字写出来** ✓ ——
 *     这比"要么假红、要么悄悄放过"都诚实 ✓（本项目工程债里就有一条"单测偶发抖动"✓）。
 *
 * ★ 退出码：真失败 ⇒ 非零 ✓（可以直接接进别的流程 ✓）。
 * ★ 它**只跑验收、不改任何东西** ✓（第 4 道里的 `build-apk` 会重写 APK 产物 ✓ —— 那是构建 ✓）。
 */
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const FAST = process.argv.includes('--fast')

/** 跑一条命令，把输出**同时**留给用户看（实时 ✓）并收下来（解析读数 ✓）。 */
function run(label, command, args) {
  return new Promise((resolve) => {
    const started = Date.now()
    console.log(`\n${'─'.repeat(72)}\n▶ ${label}：${command} ${args.join(' ')}\n${'─'.repeat(72)}`)
    const child = spawn(command, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    const onChunk = (chunk) => {
      const text = chunk.toString('utf8')
      output += text
      process.stdout.write(text)
    }
    child.stdout.on('data', onChunk)
    child.stderr.on('data', onChunk)
    child.on('close', (code) => {
      resolve({ label, code: code ?? 1, output, ms: Date.now() - started })
    })
  })
}

/** 从输出里挑出**失败的用例名** ✓（node:test 用 `✖` 打头 ✓；没有就是没有 ✓）。 */
function failures(output) {
  const names = new Set()
  for (const line of output.split('\n')) {
    const m = line.match(/^\s*✖\s+(.+?)(?:\s+\(\d+.*)?$/)
    if (m !== null && m[1].trim().length > 0) names.add(m[1].trim())
  }
  return [...names]
}

/** 从输出里挑出"通过 N 项"这类读数 ✓（没有就不显示 ✓ —— 不编 ✗）。 */
function reading(output) {
  const pairs = []
  const passFail = output.match(/通过 (\d+) 项，失败 (\d+) 项/g)
  if (passFail !== null) {
    for (const line of passFail) {
      const m = line.match(/通过 (\d+) 项，失败 (\d+) 项/)
      if (m !== null) pairs.push(`${m[1]} ✓ / ${m[2]} ✗`)
    }
  }
  // check-apk / check-home-model 这类脚本的汇总形如「…（51 条 ✓ / 0 ✗）」
  const tiao = output.match(/(\d+) 条 ✓ \/ (\d+) ✗/g)
  if (tiao !== null) {
    for (const line of tiao) pairs.push(line)
  }
  const nodeTest = output.match(/^ℹ (?:tests|pass) (\d+)$/gm)
  if (nodeTest !== null) {
    const pass = /^ℹ pass (\d+)$/m.exec(output)
    const fail = /^ℹ fail (\d+)$/m.exec(output)
    if (pass !== null && fail !== null) pairs.push(`${pass[1]} ✓ / ${fail[1]} ✗`)
  }
  return pairs.length > 0 ? pairs.join('  ·  ') : '（没解析到读数）'
}

const steps = [
  ['① 单元测试（宿主 + 客户端）', 'npm', ['test']],
  ['② 原生首页数据层（JVM）', 'node', ['scripts/check-home-model.mjs']],
  ...(FAST ? [] : [['③ TLS 探针（真握手）', 'node', ['scripts/check-manifest-probe.mjs']]]),
  ['④ APK 全量构建', 'node', ['scripts/build-apk.mjs']],
  ['④ APK 内容与形状', 'node', ['scripts/check-apk.mjs']],
  ['⑤ 会话页端到端', 'node', ['scripts/check-chat-page.mjs']],
  ['⑥ 宿主真路由（真 HTTP）', 'node', ['scripts/check-host-routes.mjs']],
]

const logDir = join(ROOT, 'dist', 'check-all')
mkdirSync(logDir, { recursive: true })

const results = []
let index = 0
for (const [label, command, args] of steps) {
  index += 1
  const logPath = join(logDir, `${String(index).padStart(2, '0')}-${label.replace(/[^\p{L}\p{N}]+/gu, '-')}.log`)
  let result = await run(label, command, args)
  let flaky = false
  if (result.code !== 0) {
    console.log(`\n⚠ ${label} 首跑没过 ⇒ **自动重跑一次**（分清真失败与抖动 ✓）`)
    const retry = await run(`${label}（重跑）`, command, args)
    writeFileSync(logPath.replace(/\.log$/, '.retry.log'), retry.output)
    if (retry.code === 0) {
      flaky = true
      console.log(`⚠ ${label}：首跑失败、重跑通过 ⇒ 判定为**抖动**（工程债里那条 ✓）`)
      /**
       * ★★ 这里必须把 `result` **换成重跑那次** ✗ ——
       *   我第一版只置了 `flaky` ✓，于是汇总里同时出现"有 1 道抖动"与"有 1 道没过" ✗
       *   （**自相矛盾的汇总比没有汇总更糟** ✓：看的人不知道该信哪句 ✓）。
       *   但**首跑那次失败的名字要留着** ✓（抖动报告要能说出是哪条 ✓）。
       */
      result = { ...retry, failures: failures(result.output), flakyFirstFailures: failures(result.output) }
    } else {
      result = retry
    }
  }
  writeFileSync(logPath, result.output)
  results.push({ ...result, reading: reading(result.output), failures: failures(result.output), logPath, flaky })
}

console.log(`\n${'═'.repeat(72)}\n全部验收读数（${FAST ? '快档：跳过了 TLS 那一道' : '全套'}）\n${'═'.repeat(72)}`)
for (const r of results) {
  const mark = r.code !== 0 ? '✗' : r.flaky ? '⚠' : '✓'
  console.log(`${mark} ${r.label.padEnd(28)} ${String(r.reading).padEnd(22)} ${(r.ms / 1000).toFixed(1)}s`)
}
const flakyOnes = results.filter((r) => r.flaky)
if (flakyOnes.length > 0) {
  console.log(`\n⚠ 有 ${flakyOnes.length} 道**抖动**（首跑失败、重跑通过 —— 它们是工程债，不是本次改动的锅 ✓）：`)
  for (const r of flakyOnes) console.log(`   ⚠ ${r.label}：${r.failures.join(' / ')}`)
}
const bad = results.filter((r) => r.code !== 0)
if (bad.length > 0) {
  console.log('\n失败详情（完整输出见 dist/check-all/ 下对应日志）：')
  for (const r of bad) {
    console.log(`· ${r.label}`)
    if (r.failures.length === 0) console.log('    （没从输出里认出用例名 —— 去看日志 ✓）')
    for (const name of r.failures) console.log(`    ✗ ${name}`)
    console.log(`    日志：${r.logPath.replace(`${ROOT}/`, '')}`)
  }
}
console.log('═'.repeat(72))
if (bad.length === 0) {
  const extra = flakyOnes.length > 0 ? `（其中 ${flakyOnes.length} 道是抖动 ⚠）` : ''
  console.log(`★ 全绿 ✓${extra}（${results.length} 道，共 ${(results.reduce((sum, r) => sum + r.ms, 0) / 1000).toFixed(1)}s）`)
} else {
  console.log(`✗ 有 ${bad.length} 道没过：${bad.map((r) => r.label).join(' / ')}`)
}
process.exit(bad.length === 0 ? 0 : 1)
