#!/usr/bin/env node
/**
 * **原生首页数据层**（`HomeModel`）的电脑端验收。
 *
 * ## 它验什么、为什么必须有
 *
 * 用户 2026-10-03 报的 bug 是：
 * 「同一台电脑被算成两台 —— 我们当前用的 Agent 和这台电脑上其他没有在用的 Agent 算成了两台」。
 * 它的根因是**纯数据归并**（旧口径按主机名字符串分组，而"当前那条"没有指纹），
 * 所以**能在电脑上钉死** —— 而那正是真机上最难看出真因的一类。
 *
 * 做法与 `check-pair-link.mjs` 同一套：把仓库里那份**原样的**
 * `native/android/java/dev/dshm/shell/HomeModel.java`（零 android 依赖）
 * 用 `javac --release 11` 编到 JVM 上，连同 `HomeModelTest.java` **真跑一遍**。
 *
 * ★ 它**不**碰 APK（那是 `check-apk.mjs` 的活）、**不**需要手机、**不**需要联网、
 * 也**不**需要跑起来的 DSH 实例（探测结果由测试自己造）。
 *
 * 用法：`node scripts/check-home-model.mjs`
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { HOME_SOURCES, homeTest, sourceDir, testDir } from './lib/home-sources.mjs'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = mkdtempSync(join(tmpdir(), 'dshm-home-model-'))

const fail = (message) => {
  console.error(`[check-home-model] 错误：${message}`)
  process.exit(2)
}

/** 编译用的是**仓库里那份**原文 —— 不是副本、不是重写（副本会"测试过了但壳里是另一份代码"✗）。 */
const sources = [
  ...HOME_SOURCES,
]

const testClasses = [
  'dev.dshm.shell.HomeModelTest',
  'dev.dshm.shell.HomeManifestTest',
  'dev.dshm.shell.HomeLoaderTest',
  'dev.dshm.shell.HomeStoreTest',
  'dev.dshm.shell.HomePinSourceTest',
  'dev.dshm.shell.HomeEntryTest',
  'dev.dshm.shell.HomeControllerTest',
  'dev.dshm.shell.HomeAnimTest',
  'dev.dshm.shell.HomeLabelsTest',
  'dev.dshm.shell.HomeShotTest',
  'dev.dshm.shell.ChatSessionsTest',
]

/**
 * ★★ 测试源码路径**从类名派生** ✗ —— 而不是再写一份路径清单 ✓：
 *   我那次"把源文件清单收成一份"的重构里 ✓，一不小心把**测试**那一份从 javac 调用里弄丢了 ✓
 *   ⇒ 编译只编了生产代码 ✓ ⇒ 跑的时候"找不到主类 HomeModelTest" ✓
 *   （★ 症状很有欺骗性：编译那行还写着"✓ 已编译 … + 十份测试" ✓ —— 那句是我手写的标签 ✗，
 *    它跟真正编了什么**没有任何关系** ✓）。
 *   ⇒ 现在路径由 `testClasses` 推出来 ✓ ⇒ 两者要飘就一起飘 ✓。
 */
const testSources = testClasses.map((name) => homeTest(name.slice(name.lastIndexOf('.') + 1) + '.java'))

try {
  execFileSync('javac', ['--release', '11', '-d', outDir, ...sources, ...testSources], { stdio: ['ignore', 'pipe', 'pipe'] })
  console.log(`[check-home-model] 已编译 ✓（${sources.length} 个源文件 + ${testSources.length} 份测试 ✓）`)
  console.log('[check-home-model] 跑断言（下面每一条都是**真的执行**了壳里那段代码）：')
} catch (error) {
  fail(`javac 失败：\n${String(error?.stdout ?? '').slice(-2000)}\n${String(error?.stderr ?? '').slice(-2000)}`)
}

let code = 0
try {
  for (const className of testClasses) {
    const output = execFileSync('java', ['-cp', outDir, className], {
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
    })
    process.stdout.write(output)
  }
} catch (error) {
  process.stdout.write(String(error?.stdout ?? ''))
  const stderr = String(error?.stderr ?? '')
  if (stderr.trim() !== '') process.stderr.write(stderr)
  code = typeof error?.status === 'number' ? error.status : 1
} finally {
  rmSync(outDir, { recursive: true, force: true })
}

process.exit(code)
