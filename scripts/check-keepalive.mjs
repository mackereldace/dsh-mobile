#!/usr/bin/env node
/**
 * **壳侧前台服务保活**里那段纯逻辑的电脑端验收（保活轮 ✓）。
 *
 * ## 它守的是什么
 *
 * 用户报的缺陷是**"退出 App 就断联"**✗（原话 ✓）—— 根因有两条，都在壳侧 ✓：
 *   ① 按返回时壳在"没有可返回的东西"那一支直接 `finish()` ✗ ⇒ Activity 销毁
 *      ⇒ **WebView 连同隧道一起拆掉** ✗（进程还在、通知还挂着，但页面已经没了 ✓ = 假活 ✗）；
 *   ② 退到后台之后页面里的 `setInterval` 会被限流 ✓ ⇒ 心跳与轮询停摆 ✓。
 * 方案（`25-壳侧保活与通知-勘察与方案.md` §4.2 B′ ✓，加密与协议**零重写** ✓）：
 * **前台服务（`specialUse`）+ 根返回改 `moveTaskToBack(true)` + 原生时钟用
 * `evaluateJavascript` 驱动网页已有的心跳/轮询** ✓。
 *
 * ## 为什么"能真跑的那部分"要单独拆出来 ✗
 *
 * 真机行为**本机验不了** ✗ —— 没有真机 ✗、`android.jar` 是 **stub** ✓
 * （`Service` / `NotificationManager` / `Handler` 这些类在里面只有签名、没有实现 ✓，
 *  JVM 上根本跑不起来 ✗）。但"保活"这件事里有一大半**只取决于纯逻辑** ✓：
 * 两个节拍常量 ✓ / 注入给网页的那条表达式 ✓ / 网页上报状态的解析 ✓。
 * ⇒ 拆成**零 android 依赖**的 `native/android/java/dev/dshm/shell/KeepAlivePolicy.java` ✓
 * （与 `PairLink` / `PreviewFit` / `MobileUrl` / `PinStore` 同一个套路 ✓），
 * 由本脚本用 `javac --release 11` 编到 JVM 上、连同 `KeepAlivePolicyTest.java` 一起**真跑一遍** ✓ ——
 * 这是"节拍算得对不对、表达式拼得对不对"在电脑上唯一能拿到的**执行级**证据 ✓。
 *
 * ## 与 `scripts/check-apk.mjs` 的分工 ✓（口径与它文件头 :38-40 一致 ✓）
 *
 * 本脚本管"**它算得对不对**"✓；那个脚本管"**这段代码到底在不在 APK 里**"✓
 * （`KeepAlivePolicy` / `KeepAliveService` / `moveTaskToBack` / 注入入口 ✓）。
 * **两者都在 ✓ 才叫"这一段验过了"** ✓ —— 只有这边绿 ⇒ 可能"算得对但压根没打进包"✗；
 * 只有那边绿 ⇒ 可能"打进去了但算错了"✗。
 *
 * ★ 它**不**碰 APK ✗、不需要手机 ✗、不需要联网 ✗、**不改任何文件** ✓
 *   （只往临时目录写 `.class` ✓，跑完就删 ✓）。
 * ★ 编译用的是**仓库里那份**原文 ✓ —— 不是副本、不是重写 ✓
 *   （副本会"测试通过但壳里是另一份代码"✗ —— 那种假绿比没有测试更糟 ✗）。
 *
 * ## 并行安全（★ 这是本脚本与 `check-pin-store.mjs` 唯一的形状差别 ✗）
 *
 * 写 `KeepAlivePolicy.java` 的实现单与本脚本**并行** ✓ ⇒ 它可能还没落地 ✓。
 * 那时本脚本**明确说一句话就退出** ✓（`exit 2` ✓）—— **不抛一堆栈** ✗：
 * 栈是"脚本坏了"的信号 ✓，而"文件还没写完"是**排期**的信号 ✗，两者必须分得开 ✓。
 *
 * 用法：`node scripts/check-keepalive.mjs`
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const sourceDir = join(repoRoot, 'native', 'android', 'java')
const testDir = join(repoRoot, 'native', 'android', 'test')
/**
 * ★ 路径与 `scripts/build-apk.mjs` 的源码清单一致 ✓（`native/android/java/**` 与
 *   `native/android/test/**` ✓）—— 包名与目录结构必须对得上 ✓，否则 `javac` 会报
 *   "class KeepAlivePolicy is public, should be declared in a file named …" ✓。
 */
const sources = [
  join(sourceDir, 'dev', 'dshm', 'shell', 'KeepAlivePolicy.java'),
  join(testDir, 'dev', 'dshm', 'shell', 'KeepAlivePolicyTest.java'),
]

/**
 * ★★ 文件没齐 ⇒ **一句话 + `exit 2`** ✓（见文件头"并行安全" ✓）。
 * ★ `exit 2` 与 `check-pin-store.mjs` 的 `javac` 失败同一个码 ✓ —— 都是"跑不了"✓，
 *   而不是"断言红了"✗（后者是 `exit 1` ✓）。
 */
const missingSources = sources.filter((path) => !existsSync(path))
if (missingSources.length > 0) {
  console.error('[check-keepalive] 还不能跑：实现单的文件还没落地 ✗')
  for (const path of missingSources) console.error(`  - 缺 ${path}`)
  console.error('  KeepAlivePolicy.java 还没落地，等实现单交单后再跑（"它在不在包里"归 scripts/check-apk.mjs ✓）。')
  process.exit(2)
}

const outDir = mkdtempSync(join(tmpdir(), 'dshm-keepalive-'))
let code = 0
/**
 * ★★ 结构上的两个讲究（都不是风格问题 ✗）：
 *   ① **全程不调用 `process.exit()`** ✓ —— `process.exit()` 会**跳过 `finally`** ✗
 *      ⇒ 编译失败那条路上临时目录就漏在 `/tmp` 里了 ✓（"自带清理"必须覆盖**每一条**退出路径 ✓）；
 *   ② 于是退出码只在最后 `process.exit(code)` 一处决定 ✓：`2` = 跑不了（编译不过 ✓）、
 *      `1` = 断言红了（或测试自己失手 ✓）、`0` = 真跑通了 ✓ —— 三种情形分得开 ✓。
 */
try {
  let compiled = false
  try {
    execFileSync('javac', ['--release', '11', '-d', outDir, ...sources], { stdio: ['ignore', 'pipe', 'pipe'] })
    compiled = true
    console.log(`[check-keepalive] KeepAlivePolicy.java + KeepAlivePolicyTest.java 已编译 ✓（${sources.length} 个源文件，用的是仓库里那份原文 ✓）`)
    console.log('[check-keepalive] 跑断言（下面每一条都是**真的执行**了壳里那段纯逻辑 ✓）：')
  } catch (error) {
    console.error(
      `[check-keepalive] javac 失败：\n${String(error?.stdout ?? '').slice(-2000)}\n${String(error?.stderr ?? '').slice(-2000)}`,
    )
    code = 2
  }

  if (compiled) {
    let output = ''
    try {
      output = execFileSync('java', ['-cp', outDir, 'dev.dshm.shell.KeepAlivePolicyTest'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        encoding: 'utf8',
      })
      process.stdout.write(output)
    } catch (error) {
      // 断言失败时 java 退出码是 1 ✓ —— 测试自己的输出在 stdout 上 ✓，照原样打出来 ✓
      output = String(error?.stdout ?? '')
      process.stdout.write(output)
      const stderr = String(error?.stderr ?? '')
      if (stderr.trim() !== '') process.stderr.write(stderr)
      code = typeof error?.status === 'number' ? error.status : 1
    }

    /**
     * ★ 读数按 `✓` / `✗` 行数报 ✓（与仓库其它 check 脚本同一个口径 ✓ ——
     *   见 `PreviewFitTest` / `PinStoreTest` 里那个 `check()` 的输出形状 ✓）。
     * ★ 这里**不**写死"至少 N 条"✗：断言条数下界该由**测试自己**守 ✓
     *   （`PairLinkTest` / `PreviewFitTest` 里都有一个自己的 `EXPECTED_MIN_CHECKS` ✓）——
     *   本脚本是**陌生的**那一侧 ✓，硬编码一个猜来的数只会制造假红 ✗。
     */
    const okChecks = (output.match(/^\s*✓/gm) ?? []).length
    const badChecks = (output.match(/^\s*✗/gm) ?? []).length
    /**
     * ★ 两条**兜底**（都是"测试自己失手"的情形 ✓，与产品行为无关 ✓）：
     *   · **一条 ✓ 都没有** ⇒ 这不算通过 ✗：测试可能被清空、`main` 可能什么都没跑 ✓，
     *     而"更短的全绿"与"全都验过了"长得一模一样 ✗（本项目的 `EXPECTED_MIN_CHECKS`
     *     就是被同一类事故逼出来的 ✓）；
     *   · **有 ✗ 但 java 退出码是 0** ⇒ 以 ✗ 为准 ✓：那说明测试自己的计数/退出码坏了 ✓，
     *     这时**绝不能**因为退出码是 0 就报绿 ✗（假绿比红更糟 ✓）。
     */
    if (okChecks === 0) {
      console.error(
        `\n[check-keepalive] 一条断言都没跑 ✗ —— 没有从测试输出里读到任何 \`✓\` 行（共 ${badChecks} 条 \`✗\`）。` +
          '\n  这不是通过 ✓：KeepAlivePolicyTest 必须照仓库里其它测试的形状，每条断言打印一行 `  ✓ 标签（读数）` / `  ✗ …` ✓。',
      )
      code = code === 0 ? 1 : code
    } else if (badChecks > 0 && code === 0) {
      console.error(`\n[check-keepalive] 测试报了 ${badChecks} 条 ✗ 却以 0 退出 ✗ —— 以 ✗ 为准 ✓（测试自己的计数坏了 ✓）。`)
      code = 1
    }

    if (code === 0) {
      console.log(
        `\n[check-keepalive] 通过：KeepAlivePolicy 的纯逻辑 ${okChecks} 条 ✓ / 0 ✗（★ 只证明"算得对" ✓ —— "它在不在 APK 里"归 node scripts/check-apk.mjs ✓）`,
      )
    } else if (okChecks === 0) {
      // 这一支**故意**不写"未通过 0 项"✗ —— 读起来像"没问题"✓，而它恰恰是最坏的一种 ✓
      console.log('\n[check-keepalive] 未通过：**一条断言都没跑** ✗（原因见上面那行 ✓ —— 别把它读成"全绿"✗）')
    } else {
      console.log(`\n[check-keepalive] 未通过 ${badChecks} 项 ✗（共 ${okChecks + badChecks} 条）`)
    }
  }
} finally {
  // ★ 自带清理 ✓（成功 / 断言失败 / 编译不过 —— 每一条路径都会走到这里 ✓）
  rmSync(outDir, { recursive: true, force: true })
}

process.exit(code)
