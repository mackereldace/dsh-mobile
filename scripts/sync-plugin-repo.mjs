#!/usr/bin/env node
/**
 * 把本仓的产物同步到**插件仓**（`dsh-mobile-plugin`）并推上去，最后**从远端核对**。
 *
 * ## 为什么要有这个脚本（第一阶段第 2 项）
 *
 * 插件仓里那份 `lib/` 是"实际在跑的产物"的快照 —— 它**不是**从源码重建的
 * （HEAD 曾经编译不过；现已隔离 Codex 修好，但仍以产物为准，见插件仓 README）。
 * 在这之前，同步靠我**手动** `cp` + `git worktree` + 手打推送命令 ⇒
 * 忘一次，用户就会装到旧包。已经吃过两次亏：
 *   · 一次是**内联 protocol 漏改写**（子目录里的裸引用没被改），
 *     用户装机时报"protocol 这包不存在"；
 *   · 一次是会话清单路由的产物**没提交**，重启也白搭。
 * ⇒ 这一步必须是**一条命令**，而且**自带核对**（不看本地，问远端）。
 *
 * ## 纪律（都是本仓踩出来的）
 *
 * · 推送一律**显式走代理**（校园网会把 github.com 的证书换掉，直连必失败）；
 * · **不写**任何 git 配置、**不用** `sslVerify=false`（只在这一条命令上带 `-c`）；
 * · 回收**只按自己的 worktree 路径**（绝不按端口或名字杀东西）；
 * · 结束时**从远端 fetch 回来核对**：产物里不许有裸引用 `@dsh-mobile/protocol`，
 *   且关键入口（`__dshmSetHosts` / `__dshmForgetHost`）在 `lib/boot.js` 里必须有。
 *
 * 用法：
 *   node scripts/sync-plugin-repo.mjs            # 同步并推送
 *   node scripts/sync-plugin-repo.mjs --check    # 只看有没有差异，不推送
 */
import { execFileSync } from 'node:child_process'
import { existsSync, cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
const REMOTE = 'https://github.com/mackereldace/dsh-mobile-plugin.git'
const PROXY = 'http://127.0.0.1:7892'
const checkOnly = process.argv.includes('--check')

/** 所有 git 调用都带上这一条（只在命令上带，绝不写进配置）。 */
const git = (args, cwd = repo) =>
  execFileSync('git', ['-c', `http.proxy=${PROXY}`, ...args], {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    // ★ 必须放大缓冲：`lib/boot.js` 有 1 MB 以上，默认 1 MB 会直接 ENOBUFS
    //   （症状是一坨看不懂的报错，里面还夹着巨长的数组 —— 我就是这么撞上的）
    maxBuffer: 64 * 1024 * 1024,
  }).toString()

const hostLib = join(repo, 'packages', 'host', 'lib')
if (!existsSync(hostLib)) {
  console.error('✗ 没有产物 packages/host/lib —— 先跑 npm run build')
  process.exit(2)
}

const work = mkdtempSync(join(tmpdir(), 'dshm-plugin-sync-'))
try {
  console.log('[sync] 取远端当前状态…')
  git(['fetch', '--quiet', REMOTE, 'main'])
  const tip = git(['rev-parse', 'FETCH_HEAD']).trim()
  console.log(`[sync] 远端 tip = ${tip.slice(0, 8)}`)

  git(['worktree', 'add', '--detach', '--quiet', work, tip])
  // 只同步产物（插件仓里的 src/test 是随产物一起留档的，也一并更新）
  for (const dir of ['lib', 'src', 'test', 'assets']) {
    rmSync(join(work, dir), { recursive: true, force: true })
    cpSync(join(repo, 'packages', 'host', dir), join(work, dir), { recursive: true })
  }
  git(['add', '-A'], work)
  const dirty = git(['status', '--porcelain'], work).trim()
  if (dirty.length === 0) {
    console.log('[sync] 产物与远端一致，无需推送 ✓')
  } else if (checkOnly) {
    console.log('[sync] --check：有差异未推送：')
    console.log(dirty.split('\n').slice(0, 12).map((line) => '  ' + line).join('\n'))
  } else {
    execFileSync('git', ['-c', 'user.name=dsh-mobile', '-c', 'user.email=noreply@example.com',
      'commit', '--quiet', '-m', 'chore: 同步宿主产物'], { cwd: work, stdio: 'inherit' })
    git(['push', '--quiet', REMOTE, 'HEAD:main'], work)
    console.log('[sync] 已推送')
  }
} finally {
  try { git(['worktree', 'remove', '--force', work]) } catch { rmSync(work, { recursive: true, force: true }) }
}

// ── 从远端核对（不看本地）──
git(['fetch', '--quiet', REMOTE, 'main'])
const remoteTip = git(['rev-parse', 'FETCH_HEAD']).trim()
const readRemote = (file) => git(['show', `FETCH_HEAD:${file}`])
const bare = readRemote('lib/codex/codex-bridge.js')
const boot = readRemote('lib/boot.js')
const problems = []
if (bare.includes("'@dsh-mobile/protocol'")) problems.push('产物里还有裸引用 @dsh-mobile/protocol')
for (const entry of ['__dshmSetHosts', '__dshmForgetHost']) {
  if (!boot.includes(entry)) problems.push(`lib/boot.js 里缺 ${entry}`)
}
console.log(`[sync] 远端 = ${remoteTip.slice(0, 8)}`)
if (problems.length > 0) {
  console.error('[sync] ✗ 核对不通过：')
  for (const problem of problems) console.error('  · ' + problem)
  process.exit(1)
}
console.log('[sync] ✓ 核对通过（无裸引用；boot.js 两个入口都在）')
