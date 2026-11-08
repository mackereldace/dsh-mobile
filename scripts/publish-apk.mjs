#!/usr/bin/env node
/**
 * 把**当前 APK 构建**推到 GitHub，并且**从远端核对字节**。
 *
 * ## 为什么需要这一步（2026-11-08 用户要求）
 *
 * 用户原话：「把目前我们的 apk 构建推到 github，并且写进项目约束，以后 apk 更新也要推」✓
 *
 * 在这之前 APK 只有两条路到手机上：局域网 `/mobile/app.apk` ✓、DSH「投送台」✓ ——
 * 两条都要求**电脑开着、在同一网络** ✓。GitHub 那条是**离线也拿得到**的备份 ✓，
 * 也是唯一一条**能追溯"这个包到底是哪次构建"**的路 ✓（版本名里带 `BUILD-<时间戳>` ✓）。
 *
 * ## 为什么不是 `git add dist/*.apk`
 *
 * 主仓 `dist/` 与 `*.apk` 是**忽略**的 ✓（`.gitignore:12,37` ✓）——
 * 二进制不进源码历史 ✓（每次都重签，diff 毫无意义 ✓、仓库会膨胀 ✓）。
 * 所以分两层：
 *   · **生成仓** `dsh-mobile-plugin` 的 `lib/dsh-mobile.apk` ✓ —— 由
 *     `scripts/sync-plugin-repo.mjs` 自动提交+推送 ✓（插件仓是生成物 ✓）；
 *   · **发布版（Release）** 挂在主仓 ✓ —— 固定资产名 `dsh-mobile.apk` ✓，
 *     于是这条链接**永远**指向最新一版 ✓：
 *     `https://github.com/mackereldace/dsh-mobile/releases/latest/download/dsh-mobile.apk`
 *
 * ## 纪律（沿用本仓踩出来的）
 *
 * · **不写**任何 git 配置；代理只按 `PLUGIN_SYNC_PROXY`（交给 sync 脚本处理）✓
 * · 令牌**只从**环境变量或 macOS 钥匙串读 ✓ —— 绝不写进文件、绝不打印 ✓
 * · 发布前要求**本地 HEAD 已推到远端** ✓ —— 否则 release 指向的提交在 GitHub 上不存在 ✓
 * · 结束**下载回来算 sha256** ✓ —— 不信"上传成功"的 200 ✓
 *
 * 用法：
 *   node scripts/publish-apk.mjs                 # 同步插件仓 + 发 Release + 核对
 *   node scripts/publish-apk.mjs --skip-sync     # 插件仓已经同步过（只发 Release）
 *   node scripts/publish-apk.mjs --dry-run       # 只打印将要做什么
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const skipSync = argv.includes('--skip-sync')
const dryRun = argv.includes('--dry-run')
/** 固定资产名 ⇒ `/releases/latest/download/<这个名字>` 永远是"最新那版" ✓ */
const ASSET_NAME = 'dsh-mobile.apk'
const RELEASE_REPO = 'mackereldace/dsh-mobile'

const log = (message) => console.log(`[publish] ${message}`)
const die = (message) => {
  console.error(`[publish] ✗ ${message}`)
  process.exit(1)
}
const run = (cmd, args, options = {}) =>
  execFileSync(cmd, args, { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', ...options })
const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex')

// ── ① 找当前 APK：两份必须**字节一致**（否则说明构建只写了一半 ✓）
const distApk = join(repo, 'dist', 'dsh-mobile.apk')
const hostApk = join(repo, 'packages', 'host', 'lib', 'dsh-mobile.apk')
const candidates = [distApk, hostApk].filter((path) => existsSync(path))
if (candidates.length === 0) die(`没找到 APK 产物（${distApk}）。先跑 node scripts/build-apk.mjs ✓`)
const buffers = new Map(candidates.map((path) => [path, readFileSync(path)]))
const hashes = new Set([...buffers.values()].map(sha256))
if (hashes.size > 1) {
  die(
    '两份 APK 不一致（dist 与 packages/host/lib）⇒ 构建只同步了一半，' +
      '重跑 node scripts/build-apk.mjs 再发布 ✓',
  )
}
const apk = buffers.get(candidates[0])
const apkSha = [...hashes][0]
const apkPath = candidates[0]
log(`APK：${apkPath}（${(apk.length / 1024).toFixed(1)} KB ✓，sha256 ${apkSha.slice(0, 12)}… ✓）`)

// ── ② 版本名（壳里那句 `--version-name 0.1.0+BUILD-…` ✓）—— 发布的身份就是它
function sdkRoot() {
  return process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT ?? join(homedir(), 'Library', 'Android', 'sdk')
}
function readVersionName(path) {
  const tools = join(sdkRoot(), 'build-tools')
  if (!existsSync(tools)) return undefined
  const versions = readdirSync(tools)
    .filter((name) => existsSync(join(tools, name, 'aapt')))
    .sort((a, b) => Number(b.split('.')[0]) - Number(a.split('.')[0]) || b.localeCompare(a))
  for (const version of versions) {
    try {
      const dump = run(join(tools, version, 'aapt'), ['dump', 'badging', path])
      const found = dump.match(/versionName='([^']+)'/)
      if (found !== undefined) return found[1]
    } catch {
      /* 这个版本的 aapt 读不动就换下一个 */
    }
  }
  return undefined
}
const versionName = readVersionName(apkPath)
const stamp = versionName?.match(/BUILD-\d+/)?.[0]
/**
 * ★ 取不到就**降级**到文件时间戳 ✓，但**明说** —— 不许悄悄发一个"没有身份"的包 ✓。
 */
const identity =
  stamp ??
  'BUILD-' +
    new Date(statSync(apkPath).mtimeMs).toISOString().replace(/[-:T]/g, '').slice(4, 14)
if (stamp === undefined) log(`⚠ 版本名里没读到 BUILD 戳，按文件时间降级为 ${identity}`)
const tag = `apk-${identity}`
log(`版本名：${versionName ?? '（未知）'} ⇒ 标签 ${tag} ✓`)

// ── ③ 插件仓（生成物）先同步并推送 ✓ —— 让 `lib/dsh-mobile.apk` 与发布版一致
if (skipSync) {
  log('--skip-sync：跳过插件仓同步 ✓')
} else if (dryRun) {
  log('--dry-run：将执行 node scripts/sync-plugin-repo.mjs ✓')
} else {
  log('同步并推送插件仓 …')
  run(process.execPath, [join(repo, 'scripts', 'sync-plugin-repo.mjs')], { stdio: 'inherit' })
}

// ── ④ 发布要求：本地 HEAD 必须已经在远端 ✓（否则 tag 指向不存在的提交 ✓）
const git = (args) => run('git', args).trim()
git(['fetch', '--quiet', 'origin', 'main'])
const head = git(['rev-parse', 'HEAD'])
const remoteHead = git(['rev-parse', 'origin/main'])
if (head !== remoteHead) {
  die(`本地 HEAD（${head.slice(0, 8)}）≠ origin/main（${remoteHead.slice(0, 8)}）⇒ 先把源码推上去 ✓`)
}

// ── ⑤ 令牌：环境变量优先，其次 macOS 钥匙串；**绝不打印** ✓
function readToken() {
  for (const name of ['GH_TOKEN', 'GITHUB_TOKEN']) {
    const value = process.env[name]
    if (value !== undefined && value.trim() !== '') return value.trim()
  }
  try {
    const out = execFileSync('git', ['credential-osxkeychain', 'get'], {
      input: 'protocol=https\nhost=github.com\n\n',
      encoding: 'utf8',
    })
    return out.match(/^password=(.+)$/m)?.[1]?.trim()
  } catch {
    return undefined
  }
}
const token = readToken()
/** 允许 404（"还没这条"是正常态）时用 `allow404` ✓ —— 其余非 2xx 一律当场停 ✓ */
const request = async (url, options = {}, allow404 = false) => {
  const response = await fetch(url, {
    ...options,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'x-github-api-version': '2022-11-28',
      'user-agent': 'dsh-mobile-publish-apk',
      ...(options.headers ?? {}),
    },
  })
  if (allow404 && response.status === 404) return undefined
  if (!response.ok) {
    const detail = await response.text()
    die(`GitHub API ${options.method ?? 'GET'} ${url} ⇒ ${response.status}：${detail.slice(0, 300)}`)
  }
  return response
}
const api = (path, options = {}) => request(`https://api.github.com${path}`, options)

if (dryRun) {
  log(`--dry-run：将向 ${RELEASE_REPO} 创建/更新 Release ${tag}，资产 ${ASSET_NAME} ✓`)
  process.exit(0)
}
if (token === undefined) die('没有 GitHub 令牌：设 GH_TOKEN，或在钥匙串里存 github.com 的 https 凭证 ✓')

// ── ⑥ 创建或复用 Release ✓（同一构建重发 ⇒ 覆盖同名资产，不产生第二条 ✓）
const body =
  `APK 构建 ${identity}（版本名 ${versionName ?? '未知'}）\n\n` +
  `- sha256：\`${apkSha}\`\n` +
  `- 大小：${apk.length} 字节\n` +
  `- 源码：主仓 \`${head.slice(0, 8)}\`；生成仓同步为 \`lib/dsh-mobile.apk\`\n\n` +
  `手机直接点：https://github.com/${RELEASE_REPO}/releases/latest/download/${ASSET_NAME}`
let release
const existing = await request(
  `https://api.github.com/repos/${RELEASE_REPO}/releases/tags/${tag}`,
  {},
  true,
)
if (existing !== undefined) {
  release = await existing.json()
  log(`Release ${tag} 已存在（id ${release.id}）⇒ 覆盖同名资产 ✓`)
  for (const asset of release.assets ?? []) {
    if (asset.name !== ASSET_NAME) continue
    await api(`/repos/${RELEASE_REPO}/releases/assets/${asset.id}`, { method: 'DELETE' })
    log(`已删除旧资产 ${asset.name} ✓`)
  }
} else {
  release = await (
    await api(`/repos/${RELEASE_REPO}/releases`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        tag_name: tag,
        target_commitish: head,
        name: `APK ${identity}`,
        body,
      }),
    })
  ).json()
  log(`已创建 Release ${tag}（id ${release.id}）✓`)
}

// ── ⑦ 上传资产 ⇒ 再**下载回来**核对 sha256 ✓（不信 200 ✓）
/**
 * ★ 2026-11-08 实测：`uploads.github.com` 偶发 `ECONNRESET` ✓（同一条命令前一次成功、
 *   后一次失败 ✓）—— 这是**链路**问题、不是我们的请求有问题 ✓。
 *   所以上传/下载都**重试三次** ✓；仍失败再用 `curl` 兜底 ✓（curl 会走系统代理 ✓）。
 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function withRetry(label, action) {
  let last
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await action()
    } catch (error) {
      last = error
      log(`⚠ ${label} 第 ${attempt}/3 次失败：${error.message} ⇒ ${attempt === 3 ? '换 curl' : '重试'}`)
      if (attempt < 3) await sleep(1500 * attempt)
    }
  }
  throw last
}

const uploadUrl = `https://uploads.github.com/repos/${RELEASE_REPO}/releases/${release.id}/assets?name=${ASSET_NAME}`
let uploaded
try {
  uploaded = await withRetry('上传资产', async () =>
    (await request(uploadUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/vnd.android.package-archive' },
      body: apk,
    })).json(),
  )
} catch {
  log('改用 curl 上传 ✓')
  /**
   * ★ 令牌**不进 argv** ✓（`ps` 看得到 ✓）—— 写进 0600 的临时配置文件，
   *   用完立刻删目录 ✓；配置里也不回显 ✓。
   */
  const configDir = mkdtempSync(join(tmpdir(), 'dshm-publish-'))
  const configFile = join(configDir, 'curl.cfg')
  try {
    writeFileSync(configFile, `header = "authorization: Bearer ${token}"\nheader = "user-agent: dsh-mobile-publish-apk"\n`, {
      mode: 0o600,
    })
    uploaded = JSON.parse(
      run('curl', [
        '-sS',
        '--fail-with-body',
        '--retry', '3',
        '-X', 'POST',
        '-K', configFile,
        '-H', 'content-type: application/vnd.android.package-archive',
        '--data-binary', `@${apkPath}`,
        uploadUrl,
      ]),
    )
  } finally {
    rmSync(configDir, { recursive: true, force: true })
  }
}
log(`已上传 ${ASSET_NAME}（${uploaded.size} 字节）✓`)

const downloaded = Buffer.from(
  await withRetry('下载核对', async () =>
    (
      await request(`https://api.github.com/repos/${RELEASE_REPO}/releases/assets/${uploaded.id}`, {
        headers: { accept: 'application/octet-stream' },
      })
    ).arrayBuffer(),
  ),
)
const downloadedSha = sha256(downloaded)
if (downloadedSha !== apkSha) die(`远端字节不一致：${downloadedSha} ≠ ${apkSha} ✓`)
log(`远端核对通过 ✓  sha256 ${downloadedSha.slice(0, 12)}… ⇄ 本地一致 ✓`)

const latestUrl = `https://github.com/${RELEASE_REPO}/releases/latest/download/${ASSET_NAME}`
const releaseUrl = `https://github.com/${RELEASE_REPO}/releases/tag/${tag}`
log(`完成 ✓  固定下载链接：${latestUrl}  ✓  本版页面：${releaseUrl}`)
