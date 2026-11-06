#!/usr/bin/env node
/**
 * 把本仓的产物同步到**插件仓**（`dsh-mobile-plugin`）并推上去，最后**从远端核对**。
 *
 * ## 为什么要有这个脚本（第一阶段第 2 项）
 *
 * 插件仓里那份 `lib/` 是"实际在跑的产物"的快照 —— 它**不是**从源码重建的
 * （以产物为准，见插件仓 README）。
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
import { existsSync, cpSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { verifyPublishedArtifacts } from './lib/publish-checks.mjs'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
const REMOTE = 'https://github.com/mackereldace/dsh-mobile-plugin.git'
/**
 * 代理：显式 `PLUGIN_SYNC_PROXY` 优先；未设置时读 macOS 系统代理（HTTPS/HTTP），
 * 兜底旧的 7892。`off` 表示直连。2026-11-04：代理端口从 7892 变成系统代理 7890，
 * 写死端口会让"明明挂了代理"仍然失败 ✗。
 */
function detectProxy() {
  if (process.env.PLUGIN_SYNC_PROXY !== undefined) return process.env.PLUGIN_SYNC_PROXY
  try {
    const out = execFileSync('scutil', ['--proxy'], { encoding: 'utf8' })
    const host = out.match(/HTTPSProxy\s*:\s*(\S+)/)?.[1] ?? out.match(/HTTPProxy\s*:\s*(\S+)/)?.[1]
    const port = out.match(/HTTPSPort\s*:\s*(\d+)/)?.[1] ?? out.match(/HTTPPort\s*:\s*(\d+)/)?.[1]
    if (host !== undefined && port !== undefined) return `http://${host}:${port}`
  } catch {
    /* 非 macOS 或 scutil 不可用 */
  }
  return 'http://127.0.0.1:7892'
}
const PROXY = detectProxy()
const checkOnly = process.argv.includes('--check')

/** 所有 git 调用都带上这一条（只在命令上带，绝不写进配置）。 */
/** 访问远端失败时给一条能行动的提示（而不是一坨 Node Buffer 栈）。 */
function fetchRemote() {
  try {
    git(['fetch', '--quiet', REMOTE, 'main'])
  } catch (error) {
    const detail = String(error.stderr || error.message || '')
      .replace(/\u0000/g, '')
      .split('\n')
      .filter((line) => line.trim() !== '')
      .slice(-5)
      .join('\n  ')
    console.error('[sync] ✗ 无法读取远端插件仓。')
    console.error(`  代理：${PROXY || '（禁用）'}（用 PLUGIN_SYNC_PROXY 覆盖；设为 off 可禁用）`)
    console.error(`  ${detail.slice(0, 800)}`)
    process.exit(1)
  }
}

const git = (args, cwd = repo) =>
  execFileSync('git', [...(PROXY && PROXY !== 'off' ? ['-c', `http.proxy=${PROXY}`] : []), ...args], {
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
  fetchRemote()
  const tip = git(['rev-parse', 'FETCH_HEAD']).trim()
  console.log(`[sync] 远端 tip = ${tip.slice(0, 8)}`)

  git(['worktree', 'add', '--detach', '--quiet', work, tip])
  /**
   * ★★ 2026-11-04：插件仓整体变为**生成物**（用户拍板"只维护主仓"）✓。
   *   除了构建产物 `lib`，源码留档 `src/test`、构建脚本 `scripts`、运行资源 `assets`
   *   也一起同步；顶层 `package.json` / `tsconfig*.json` / `cordis.patch.yml` 同理 ✓。
   *   `README.md` 的唯一源是主仓 `packages/host/README.release.md`（带"生成物"横幅）✓。
   */
  for (const dir of ['lib', 'src', 'test', 'scripts', 'assets']) {
    rmSync(join(work, dir), { recursive: true, force: true })
    cpSync(join(repo, 'packages', 'host', dir), join(work, dir), { recursive: true })
  }
  for (const file of ['package.json', 'tsconfig.json', 'tsconfig.build.json', 'cordis.patch.yml']) {
    cpSync(join(repo, 'packages', 'host', file), join(work, file), { force: true })
  }
  cpSync(join(repo, 'packages', 'host', 'README.release.md'), join(work, 'README.md'), { force: true })
  git(['add', '-A'], work)
  const dirty = git(['status', '--porcelain'], work).trim()
  if (dirty.length === 0) {
    console.log('[sync] 产物与远端一致，无需推送 ✓')
  } else if (checkOnly) {
    console.log('[sync] --check：有差异未推送：')
    console.log(dirty.split('\n').slice(0, 12).map((line) => '  ' + line).join('\n'))
    process.exitCode = 1
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
fetchRemote()
const remoteTip = git(['rev-parse', 'FETCH_HEAD']).trim()
const readRemote = (file) => git(['show', `FETCH_HEAD:${file}`])
/**
 * ★★★ 七道判据**只有一份实现** ✗ —— 在 `lib/publish-checks.mjs` 里 ✓，
 *   由 `packages/host/test/publish-checks.test.ts` 用"好样本 + 坏样本"逐条验过 ✓。
 *   原先它们是内联在这里的 ⇒ 只有被想起来的那条验过、其余可能是假的 ✓
 *   （第 76 轮就出现过一道假闸）✓ —— 靠运气守的门不算守门 ✗。
 */
const hostApkPath = join(hostLib, 'dsh-mobile.apk')
let remoteApkSize = Number.NaN
let localApkSize = Number.NaN
try {
  const apkBlob = git(['rev-parse', 'FETCH_HEAD:lib/dsh-mobile.apk']).trim()
  remoteApkSize = Number(git(['cat-file', '-s', apkBlob]).trim())
} catch (error) {
  void error
}
if (existsSync(hostApkPath)) localApkSize = statSync(hostApkPath).size

const problems = verifyPublishedArtifacts({
  // ★ 上一版我把 `const boot = readRemote(...)` 一起删掉了 ⇒ ReferenceError: boot is not defined
  //   （替换整段时最容易漏的就是"这段里其实还定义了别的东西"✗）⇒ 这里显式读。
  boot: readRemote('lib/boot.js'),
  tunnel: readRemote('lib/tunnel.js'),
  index: readRemote('lib/index.js'),
  remoteApkSize,
  localApkSize,
})
/**
 * ★ 生成物完整性：远端 package.json 的版本必须等于主仓；README 必须带"生成物"横幅。
 *   旧版只手抄 lib，这两项没人管 ⇒ 插件仓 README 一直是手写、版本靠记 ✓。
 */
try {
  const remotePkg = JSON.parse(readRemote('package.json'))
  const localPkg = JSON.parse(readFileSync(join(repo, 'packages', 'host', 'package.json'), 'utf8'))
  if (remotePkg.version !== localPkg.version) problems.push(`package.json 版本：远端 ${remotePkg.version} ≠ 本地 ${localPkg.version}`)
} catch (error) {
  problems.push(`package.json 读取失败：${error.message}`)
}
try {
  if (!readRemote('README.md').includes('本仓库是生成物')) problems.push('README.md 缺少"本仓库是生成物"横幅')
} catch (error) {
  problems.push(`README.md 读取失败：${error.message}`)
}

console.log(`[sync] 远端 = ${remoteTip.slice(0, 8)}`)
if (problems.length > 0) {
  console.error('[sync] ✗ 核对不通过：')
  for (const problem of problems) console.error('  · ' + problem)
  process.exit(1)
}
console.log('[sync] ✓ 核对通过（无裸引用；boot.js 两个入口都在；二进制通道两端都在产物里）')
