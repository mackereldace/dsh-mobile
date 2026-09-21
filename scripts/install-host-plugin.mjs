#!/usr/bin/env node
/**
 * 把 dsh-mobile 的宿主插件安装进 DSH 的 web profile。
 *
 * 为什么需要这个脚本（而不是 `pnpm add`）：
 *   profile 用 `nodeLinker: hoisted`，插件必须**同时**满足两个条件才能在运行时被加载：
 *     1. 包本身出现在 `$DSH_HOME/profiles/web/node_modules/` 下；
 *     2. 其依赖 `@dsh-mobile/protocol` 也在同一层（hoisted 布局下 Node 逐级向上查找）。
 *   直接用 pnpm 从本地路径安装会把 workspace 链接进去，虽然开发时方便，
 *   但一旦中间目录被移动或删除，DSH 就会在生产启动时加载失败。
 *   因此这里**复制**构建产物，让 profile 自包含。
 *
 * 同时它会幂等地维护 `cordis.patch.yml` 中的一条 insert 条目，并做真实加载校验。
 *
 * 用法：
 *   node scripts/install-host-plugin.mjs            # 安装（默认 profile=web）
 *   node scripts/install-host-plugin.mjs --uninstall
 *   node scripts/install-host-plugin.mjs --profile web --dsh-home ~/.dsh
 */

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bootStamp, buildBootPayload } from './boot-payload.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = dirname(here)

/** 解析命令行参数。 */
function parseArgs(argv) {
  const out = {
    profile: 'web',
    // ⚠️ **故意不读 `process.env.DSH_HOME`**：DSH 运行时会在环境里设 `DSH_HOME=~/.dsh`，
    //    于是任何"顺手读一下环境变量"的脚本都会指向**生产**。本项目为此真实出过两次事故
    //    （生产配置被写成测试端口、手机 403）。家目录只能由 `--dsh-home` 显式给出。
    dshHome: undefined,
    uninstall: false,
    skipVerify: false,
    trustedHosts: [],
    phoneBaseUrl: undefined,
    // 中继相关：这些**不是**每次安装都该重算的（不像 trustedHosts 随地址变），
    // 所以没给就沿用现有配置里的值——见 patchBlock 上方的长注释。
    relayUrl: undefined,
    relayToken: undefined,
    relayHttpUrl: undefined,
    relayPoolSize: undefined,
    extraEndpoints: [],
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--uninstall') out.uninstall = true
    else if (arg === '--skip-verify') out.skipVerify = true
    else if (arg === '--trusted-host') out.trustedHosts.push(argv[++i])
    else if (arg === '--clear-trusted-hosts') out.trustedHosts = []
    else if (arg === '--profile') out.profile = argv[++i]
    else if (arg === '--dsh-home') out.dshHome = argv[++i]
    else if (arg === '--phone-base-url') out.phoneBaseUrl = argv[++i]
    else if (arg === '--relay-url') out.relayUrl = argv[++i]
    else if (arg === '--relay-token') out.relayToken = argv[++i]
    else if (arg === '--relay-http-url') out.relayHttpUrl = argv[++i]
    else if (arg === '--relay-pool-size') out.relayPoolSize = argv[++i]
    else if (arg === '--extra-endpoint') out.extraEndpoints.push(argv[++i])
    else if (arg === '--help' || arg === '-h') {
      console.log(
        '用法: node scripts/install-host-plugin.mjs [--profile web] [--dsh-home ~/.dsh] ' +
          '[--trusted-host <authority>]... [--phone-base-url https://<ip>:<tls端口>] ' +
          '[--uninstall] [--skip-verify]',
      )
      process.exit(0)
    }
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
/**
 * **必须显式指定家目录**（`--dsh-home` 或 `DSH_HOME`），没有默认值。
 *
 * ## 为什么把默认值去掉
 *
 * 这个脚本会**覆盖式**重写 `cordis.patch.yml`。原先它默认写 `~/.dsh`（通常是生产），
 * 于是一旦任何调用链没把家目录传对，它就会**直接改掉生产配置**——而配置是热加载的，
 * 线上几秒内开始 403，用户那边表现为"手机突然连不上了"。
 *
 * 本项目真的发生过两次（一次布局验收之后、一次我在测防护时）。第二次之后我放弃了
 * "靠比对路径来判断是不是默认家目录"的做法——那道闸没能拦住，而且**它本身没法安全地测试**
 * （要测它就得拿真生产配置当靶子）。
 *
 * 改成"没有默认值"就同时解决了两件事：
 *   · 漏传 = 直接拒绝运行（拒绝不写盘，所以这道闸**可以安全测试**）；
 *   · 想写哪儿必须写出来，配置来源一目了然。
 *
 * 合法调用方 `restart-lan.sh` 本来就一直显式传 `--dsh-home`。
 */
if (typeof args.dshHome !== 'string' || args.dshHome.length === 0) {
  console.error(
    '[install-host] 必须显式指定家目录：--dsh-home <路径>。\n' +
      '  本脚本会覆盖式重写该家目录下的 cordis.patch.yml，因此**故意不提供默认值**，\n' +
      '  以免某条调用链漏传时把生产配置改掉（真实事故，发生过两次）。\n' +
      '  维护这台电脑的配置：bash scripts/restart-lan.sh\n' +
      '  验收/测试请用专用目录：--dsh-home /tmp/xxx',
  )
  process.exit(2)
}

const profileDir = join(args.dshHome, 'profiles', args.profile)
const profileModules = join(profileDir, 'node_modules')
const patchFile = join(profileDir, 'cordis.patch.yml')

/**
 * 需要安装的包：插件本体、协议依赖，以及**预览桥**。
 *
 * 桥（`@dsh-mobile/bridge`）是 round 99 新增的 ✓：DSH 的文档预览能力在它的依赖注入
 * 容器里 ✗，而我们的注入脚本拿不到 `ctx` ✓ —— DSH 的模块加载器要求
 * 客户端 bundle 的注册**与宿主声明的 graph 行匹配** ✓，
 * 所以必须作为一个正式插件被声明（下面 patchBlock 里的第二个 insert ✓）。
 */
const PACKAGES = [
  { name: '@dsh-mobile/protocol', source: join(repoRoot, 'packages', 'protocol') },
  { name: '@dsh-mobile/host', source: join(repoRoot, 'packages', 'host') },
  { name: '@dsh-mobile/bridge', source: join(repoRoot, 'packages', 'bridge') },
]

/** patch 条目的标记注释：用于幂等识别我们插入的块。 */
const MARKER_START = '# >>> dsh-mobile host plugin (managed by scripts/install-host-plugin.mjs) >>>'
const MARKER_END = '# <<< dsh-mobile host plugin <<<'

/**
 * 生成 patch 块。
 * `trustedHosts` 必须与手机实际访问的 authority 一致：本插件注册的 /mobile 路由
 * 不受 DSH 的 /api 信任栅栏保护，因此它自己校验 Host/Origin（见 index.ts 的说明）。
 */
/**
 * 从**现有** cordis.patch.yml 里读回中继相关的键。
 *
 * ## 为什么必须这么做（这是被同一类 bug 咬第三次之后加的）
 *
 * 这个脚本写 patch 是**覆盖式**的：它按本次参数重新生成整个配置块。
 * 对 `trustedHosts` / `publicBaseUrl` / `phoneBaseUrl` 这是对的——它们本来就该
 * 随局域网地址重算。但中继那几项（`relayUrl` / `relayToken` / `extraEndpoints` …）
 * **与本次地址无关**，一旦被覆盖就等于：
 *
 *   > 用户配好中继 → 某天跑了一次 `restart-lan.sh` → 中继配置被抹掉 → **远程访问静默失效**。
 *
 * 前两次同类事故是 `3443` 与 `phoneBaseUrl` 被抹掉（手机"一直重连中"）。
 * 所以这里改成**保留式合并**：现有配置里的中继键一律沿用，除非命令行显式覆盖。
 */
function readPreservedKeys(patchFile) {
  const preserved = { extraEndpoints: [], trustedHosts: [] }
  let text = ''
  try {
    text = readFileSync(patchFile, 'utf8')
  } catch {
    return preserved
  }
  const scalar = (key) => {
    const match = new RegExp(`^\\s+${key}:\\s*'?([^'\\n]+)'?\\s*$`, 'm').exec(text)
    return match?.[1]?.trim()
  }
  // ★ 已有的受信 authority 也读出来。
  //   踩过两次的坑：`--trusted-host` 不给就是空数组，而 patchBlock 是**覆盖式**写入 ——
  //   于是「不带参数跑一次安装」会把 TLS authority 与 phoneBaseUrl 一起抹掉，
  //   手机侧立刻 403（配置是热加载的，破坏是即时的）。第二次是我自己踩的。
  //
  //   列表必须**逐行**解析。第一版写成一条正则 `(?:\s+-\s*'?[^'\n]+?'?)+`，
  //   懒量词配上可选引号，重复组吃一个字符就收工 —— 只抓到第一条，
  //   "沿用"于是变成"删掉后两条"，手机入口照样 403（护栏本身有 bug）。
  const patchLines = text.split('\n')
  for (let i = 0; i < patchLines.length; i++) {
    if (!/^\s+trustedHosts:\s*$/.test(patchLines[i])) continue
    for (let j = i + 1; j < patchLines.length; j++) {
      const item = /^\s+-\s*'?([^'\n]+?)'?\s*$/.exec(patchLines[j])
      if (item === null) break
      preserved.trustedHosts.push(item[1].trim())
    }
    break
  }
  preserved.phoneBaseUrl = scalar('phoneBaseUrl')
  preserved.relayUrl = scalar('relayUrl')
  preserved.relayToken = scalar('relayToken')
  preserved.relayHttpUrl = scalar('relayHttpUrl')
  preserved.relayPoolSize = scalar('relayPoolSize')
  const listMatch = /^\s+extraEndpoints:\s*\n((?:\s+-\s*'?[^'\n]+'?\s*\n?)+)/m.exec(text)
  if (listMatch !== null) {
    for (const line of listMatch[1].split('\n')) {
      const item = /^\s+-\s*'?([^'\n]+?)'?\s*$/.exec(line)
      if (item !== null) preserved.extraEndpoints.push(item[1].trim())
    }
  }
  return preserved
}

function patchBlock(trustedHosts, preserved) {
  // 配对码里要嵌"手机能访问到的地址"：DSH 只绑 loopback，手机走的是代理端口，
  // 因此把首个受信 authority 直接作为 publicBaseUrl（形如 http://<ip>:<代理端口>）。
  const publicBaseUrl = trustedHosts.length > 0 ? `http://${trustedHosts[0]}` : undefined
  const lines = []
  if (trustedHosts.length > 0) {
    lines.push('        trustedHosts:')
    for (const entry of trustedHosts) lines.push(`          - '${entry}'`)
  }
  if (publicBaseUrl !== undefined) lines.push(`        publicBaseUrl: '${publicBaseUrl}'`)
  // 手机侧必须 HTTPS（安全上下文 / WebCrypto 前提），端口与明文端口不同，单独一项
  const phoneBaseUrl = args.phoneBaseUrl ?? preserved?.phoneBaseUrl
  if (phoneBaseUrl !== undefined) lines.push(`        phoneBaseUrl: '${phoneBaseUrl}'`)
  // 中继：命令行优先，其次沿用现有配置（见 readPreservedKeys 的说明）
  const relayUrl = args.relayUrl ?? preserved?.relayUrl
  const relayToken = args.relayToken ?? preserved?.relayToken
  const relayHttpUrl = args.relayHttpUrl ?? preserved?.relayHttpUrl
  const relayPoolSize = args.relayPoolSize ?? preserved?.relayPoolSize
  const extraEndpoints = args.extraEndpoints.length > 0 ? args.extraEndpoints : (preserved?.extraEndpoints ?? [])
  if (extraEndpoints.length > 0) {
    lines.push('        extraEndpoints:')
    for (const entry of extraEndpoints) lines.push(`          - '${entry}'`)
  }
  if (relayUrl !== undefined) lines.push(`        relayUrl: '${relayUrl}'`)
  if (relayToken !== undefined) lines.push(`        relayToken: '${relayToken}'`)
  if (relayHttpUrl !== undefined) lines.push(`        relayHttpUrl: '${relayHttpUrl}'`)
  if (relayPoolSize !== undefined) lines.push(`        relayPoolSize: ${relayPoolSize}`)
  const config = lines.length === 0 ? '' : `\n      config:\n${lines.join('\n')}`
  return `${MARKER_START}
# 手机端接入：/mobile/ws 加密隧道、配对与设备管理端点，并往 index.html 注入 boot.js。
# 这条 insert 位于所有 bundle 层之后，因此 webServer / typertGateway 均已就绪。
- insert:
    - id: mobile-host
      name: '@dsh-mobile/host'${config}
    # 预览桥（round 99）：把 DSH 自带的文档预览（KaTeX / PDF / 图片）暴露给手机外壳。
    # 它**必须**在这里被声明 ✓ —— DSH 的客户端 bundle 注册要求"与 graph 行匹配" ✓，
    # 只在页面里 load 是无效的 ✗（见 packages/bridge/lib/client.js 的说明）。
    - id: mobile-preview-bridge
      name: '@dsh-mobile/bridge'
${MARKER_END}
`
}

function log(message) {
  console.log(`[install-host] ${message}`)
}

function fail(message) {
  console.error(`[install-host] 错误：${message}`)
  process.exit(1)
}

/** 检查前置条件：profile 存在、构建产物存在。 */
function preflight() {
  if (!existsSync(profileDir)) {
    fail(
      `找不到 profile 目录：${profileDir}\n` +
        `        请先用该 profile 启动一次 DSH（例如 \`dsh web\`），让它自动初始化。`,
    )
  }
  for (const pkg of PACKAGES) {
    const lib = join(pkg.source, 'lib')
    if (!existsSync(join(lib, 'index.js'))) {
      fail(
        `缺少构建产物：${lib}\n` +
          `        请先运行：pnpm --filter ${pkg.name} run build`,
      )
    }
  }
}

/** 复制包到 profile 的 node_modules（hoisted 布局：直接放在顶层）。 */
function installPackages() {
  mkdirSync(profileModules, { recursive: true })
  for (const pkg of PACKAGES) {
    const destination = join(profileModules, pkg.name)
    rmSync(destination, { recursive: true, force: true })
    mkdirSync(destination, { recursive: true })
    // 只复制运行时需要的文件：lib 与 package.json。
    // 刻意不复制 src 与测试，避免把开发期文件带进生产 profile。
    cpSync(join(pkg.source, 'lib'), join(destination, 'lib'), { recursive: true })
    cpSync(join(pkg.source, 'package.json'), join(destination, 'package.json'))
    log(`已安装 ${pkg.name} → ${destination}`)
  }

  // 浏览器端 boot.js：由宿主插件通过 tapIndex 注入 index.html，必须随宿主一起安装。
  // 它位于 client 包（浏览器侧产物），但由 host 包提供 HTTP 服务，
  // 因此安装时把它复制到 host 的 lib 目录下——cordis.ts 默认就在那里找它。
  const bootSource = join(repoRoot, 'packages', 'client', 'src', 'boot.js')
  const bootDestination = join(profileModules, '@dsh-mobile', 'host', 'lib', 'boot.js')
  if (!existsSync(bootSource)) fail(`缺少 boot.js：${bootSource}`)
  /**
   * ★ 安装时同样要跑**全部**载荷变换：构建戳 ✓ + **公式渲染器内联副本** ✓
   *   （都只在 `scripts/boot-payload.mjs` 实现 ✓，这里只管调用 ✓）。
   *
   * 两个坑都踩过：
   *   1. 早先直接 `cpSync` 源文件 → 占位符原样上线，调试框显示 `__DSHM_BOOT_STAMP__` ✗；
   *   2. round 98 只把"Temml 内联"加在 `build-lib.mjs` 里 ✗ → **手机上那份没有副本** ✓，
   *      公式仍按原样 TeX 显示，而验收脚本（装的是 lib ✓）全绿 ✗✓ —— 极难查 ✓。
   */
  const installStamp = bootStamp()
  const bootCode = buildBootPayload(readFileSync(bootSource, 'utf8'), { stamp: installStamp })
  writeFileSync(bootDestination, bootCode)
  /**
   * 原生外壳 APK ✓：`dist/dsh-mobile.apk` → 插件目录（宿主路由 `/mobile/app.apk` 读它 ✓）。
   * 没构建就跳过 ✓（只提示一句 ✓，不让安装失败 ✗ —— 外壳是可选增强 ✓）。
   */
  const apkSource = join(repoRoot, 'dist', 'dsh-mobile.apk')
  const apkTarget = join(profileModules, '@dsh-mobile', 'host', 'lib', 'dsh-mobile.apk')
  let apkNote = '未构建（跑 node scripts/build-apk.mjs 后重装即可）'
  if (existsSync(apkSource)) {
    cpSync(apkSource, apkTarget)
    apkNote = `已安装（${Math.round(readFileSync(apkSource).length / 1024)} KB ✓）`
  }

  const hasTemml = bootCode.includes('TEMML_INLINE_GZIP_BASE64 = "')
  log(`已安装 boot.js → ${bootDestination}（戳 ${installStamp}，${hasTemml ? '含公式渲染器 ✓' : '⚠ 不含公式渲染器（公式将按原样显示）'}）`)
  log(`原生外壳 APK：${apkNote}（手机可直接下 /mobile/app.apk ✓）`)
}

/** 更新 cordis.patch.yml（幂等：先删旧块再追加）。 */
function updatePatch() {
  const original = existsSync(patchFile) ? readFileSync(patchFile, 'utf8') : '[]\n'
  const base = normalizeBase(removeBlock(original))
  // 保留式合并：中继相关键从现有配置读回（见 readPreservedKeys 的长注释）
  const preserved = readPreservedKeys(patchFile)
  if (preserved.relayUrl !== undefined && args.relayUrl === undefined) {
    log(`保留现有中继配置：${preserved.relayUrl}（如要更换请显式传 --relay-url）`)
  }
  // ★ 空参数**沿用**已有受信列表（而不是覆盖成空）。
  //   显式清空要用 `--clear-trusted-hosts`，那是刻意行为，与「忘了带参数」必须分开。
  let trustedHosts = args.trustedHosts
  let reusedTrustedHosts = false
  if (trustedHosts.length === 0 && preserved.trustedHosts.length > 0) {
    trustedHosts = preserved.trustedHosts
    reusedTrustedHosts = true
    log(`未提供 --trusted-host，沿用已有 ${trustedHosts.length} 条受信 authority（避免抹掉手机入口）`)
  }
  writeFileSync(patchFile, `${base}${patchBlock(trustedHosts, preserved)}`, 'utf8')
  // ★ 写完立刻自检：原有的 authority 一条都不能少。
  //   少了就是手机入口 403，而配置热加载意味着**破坏是即时的**——
  //   宁可在这里报错退出，也不要静默地把线上入口关掉。
  {
    const written = readFileSync(patchFile, 'utf8')
    // ★ 只在**沿用**路径上自检。显式传了新 authority 时，旧地址本来就该被换掉
    //   （那正是"地址跟着变"的正确行为，测试里有一条专门守它）——
    //   第一版没区分这两种情况，于是把"换地址"误判成"丢配置"，直接 fail 退出。
    const lost = reusedTrustedHosts ? preserved.trustedHosts.filter((host) => !written.includes(host)) : []
    if (lost.length > 0) fail(`配置自检失败：沿用路径下丢失受信 authority ${lost.join('、')}`)
  }
  log(`已更新 ${patchFile}`)
}

/**
 * 把 patch 文件的既有内容规范化成"可以安全追加一个列表项"的基底。
 *
 * 关键点：DSH 首次生成的 patch 文件内容是空列表字面量 `[]`。
 * 若把我们的 `- insert:` 直接追加在 `[]` 之后，YAML 会变成两个顶层节点而解析失败
 * （安装脚本自身在更新后立刻做 YAML 解析校验，正是为了拦住这种错误）。
 * 因此空列表必须被替换掉，而不是被追加。
 */
function normalizeBase(text) {
  // 去掉纯注释行与空白，判断是否等价于空列表
  const meaningful = text
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n')
    .trim()
  if (meaningful === '' || meaningful === '[]') {
    // 保留用户原有注释（若有），丢掉 `[]` 字面量
    const comments = text
      .split('\n')
      .filter((line) => line.trimStart().startsWith('#'))
      .join('\n')
    return comments.length === 0 ? '' : `${comments}\n`
  }
  return `${text.trimEnd()}\n`
}

function removeBlock(text) {
  const start = text.indexOf(MARKER_START)
  if (start < 0) return text
  const end = text.indexOf(MARKER_END)
  if (end < 0) return text.slice(0, start)
  return text.slice(0, start) + text.slice(end + MARKER_END.length + 1)
}

function uninstall() {
  for (const pkg of PACKAGES) {
    rmSync(join(profileModules, pkg.name), { recursive: true, force: true })
    log(`已移除 ${pkg.name}`)
  }
  if (existsSync(patchFile)) {
    const text = readFileSync(patchFile, 'utf8')
    const cleaned = removeBlock(text).trim()
    writeFileSync(patchFile, cleaned.length === 0 ? '[]\n' : `${cleaned}\n`, 'utf8')
    log(`已从 ${patchFile} 移除插件条目`)
  }
  log('卸载完成。重启 DSH web 后生效。')
}

/**
 * 真实加载校验：用 profile 的解析上下文导入插件，确认 name/inject/apply 齐备。
 *
 * 为什么必须做这一步：`pnpm add` 成功、文件存在，都不代表 DSH 运行时的动态 import
 * 能找到它（hoisted 布局、ESM 解析、依赖缺失都可能让它在启动时才炸）。
 */
async function verify() {
  const entry = join(profileModules, '@dsh-mobile/host', 'lib', 'cordis.js')
  if (!existsSync(entry)) fail(`校验失败：${entry} 不存在`)
  const loaded = await import(`file://${entry}`)
  const plugin = loaded.default ?? loaded
  if (typeof plugin.apply !== 'function') fail('校验失败：插件没有导出 apply 函数')
  if (typeof plugin.name !== 'string' || plugin.name.length === 0) fail('校验失败：插件没有导出 name')
  log(`校验通过：name=${plugin.name} inject=${JSON.stringify(plugin.inject ?? [])}`)

  // 校验 patch 文件能被 YAML 解析（避免安装完 DSH 启动即失败）
  const { load } = await import('js-yaml')
  const parsed = load(readFileSync(patchFile, 'utf8'))
  if (!Array.isArray(parsed)) fail('校验失败：cordis.patch.yml 顶层不是数组')
  const found = parsed.some(
    (row) => row !== null && typeof row === 'object' && Array.isArray(row.insert) && row.insert.some((e) => e?.name === '@dsh-mobile/host'),
  )
  if (!found) fail('校验失败：cordis.patch.yml 中找不到 mobile-host 条目')
  log('校验通过：cordis.patch.yml 可解析且包含 mobile-host 条目')
}

async function main() {
  if (args.uninstall) {
    uninstall()
    return
  }
  preflight()
  installPackages()
  updatePatch()
  if (!args.skipVerify) await verify()
  log('')
  log('安装完成。下一步：')
  log(`  1. 重启 DSH web（当前进程不会自动加载新插件）`)
  log(`  2. 打开 http://127.0.0.1:3080/mobile/manifest 应返回 JSON（含 protocolVersion 与主机指纹）`)
  log(`  3. POST /mobile/pair/code 生成配对码，然后在手机上用 dsh-mobile 扫码`)
  log('')
  log('注意：局域网访问需要 DSH 绑定所有网卡并声明可信主机，例如：')
  log('  dsh web --host 0.0.0.0 --trusted-host <电脑局域网IP>')
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error))
})
