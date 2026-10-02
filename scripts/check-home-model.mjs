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

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const sourceDir = join(repoRoot, 'native', 'android', 'java')
const testDir = join(repoRoot, 'native', 'android', 'test')
const outDir = mkdtempSync(join(tmpdir(), 'dshm-home-model-'))

const fail = (message) => {
  console.error(`[check-home-model] 错误：${message}`)
  process.exit(2)
}

/** 编译用的是**仓库里那份**原文 —— 不是副本、不是重写（副本会"测试过了但壳里是另一份代码"✗）。 */
const sources = [
  join(sourceDir, 'dev', 'dshm', 'shell', 'HomeModel.java'),
  join(sourceDir, 'dev', 'dshm', 'shell', 'HomeManifest.java'),
  join(sourceDir, 'dev', 'dshm', 'shell', 'ManifestProbe.java'),
  join(sourceDir, 'dev', 'dshm', 'shell', 'HomeLoader.java'),
  join(testDir, 'dev', 'dshm', 'shell', 'HomeModelTest.java'),
  join(testDir, 'dev', 'dshm', 'shell', 'HomeManifestTest.java'),
  join(testDir, 'dev', 'dshm', 'shell', 'HomeLoaderTest.java'),
]

const testClasses = ['dev.dshm.shell.HomeModelTest', 'dev.dshm.shell.HomeManifestTest', 'dev.dshm.shell.HomeLoaderTest']

try {
  execFileSync('javac', ['--release', '11', '-d', outDir, ...sources], { stdio: ['ignore', 'pipe', 'pipe'] })
  console.log(`[check-home-model] 已编译 ✓（${sources.length} 个源文件：HomeModel + HomeManifest + ManifestProbe + HomeLoader + 三份测试）`)
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
