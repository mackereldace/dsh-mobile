#!/usr/bin/env node
/**
 * 核对**发给用户的那个 zip**（`dist/share/dsh-mobile-host.zip`）里装的是不是最新产物。
 *
 * ## 为什么需要它（今天反复出现的坑）
 *
 * zip 是我**手工**打包的（`prepare-npm` + `zip`）✗ ⇒ 完全可能装着一份旧 `lib/` ✓，
 * 而用户拿到手"更新"完发现问题照旧 ⇒ 又白验一轮 ✓（今天已经因为"产物旧"
 * 白验/误判过三次：宿主没编码、协议内联漏改写、APK 是旧的 ✗）。
 *
 * ## 做法
 *
 * 解到临时目录 ⇒ 把它当作"远端产物"喂给**同一份**七道判据
 * （`lib/publish-checks.mjs` ✓ —— 判据只有一份实现 ✓）。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { verifyPublishedArtifacts } from './lib/publish-checks.mjs'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
const zip = join(repo, 'dist', 'share', 'dsh-mobile-host.zip')
if (!existsSync(zip)) {
  console.error('✗ 没有 dist/share/dsh-mobile-host.zip（先跑 node scripts/prepare-npm.mjs 再打包）')
  process.exit(2)
}

const work = mkdtempSync(join(tmpdir(), 'dshm-handout-'))
try {
  execFileSync('unzip', ['-q', zip, '-d', work], { stdio: 'inherit' })
  const root = join(work, 'dsh-mobile-host')
  const read = (rel) => readFileSync(join(root, rel), 'utf8')
  const localApk = join(repo, 'packages', 'host', 'lib', 'dsh-mobile.apk')
  const problems = verifyPublishedArtifacts({
    boot: read('lib/boot.js'),
    tunnel: read('lib/tunnel.js'),
    index: read('lib/index.js'),
    codexBridge: read('lib/codex/codex-bridge.js'),
    remoteApkSize: statSync(join(root, 'lib', 'dsh-mobile.apk')).size,
    localApkSize: existsSync(localApk) ? statSync(localApk).size : -1,
  })
  if (problems.length > 0) {
    console.error('✗ 发给用户的 zip 不合格：')
    for (const problem of problems) console.error('  · ' + problem)
    process.exit(1)
  }
  console.log(`✓ 发给用户的 zip 合格（${Math.round(statSync(zip).size / 1024)} KB，七道判据全过）`)
} finally {
  rmSync(work, { recursive: true, force: true })
}
