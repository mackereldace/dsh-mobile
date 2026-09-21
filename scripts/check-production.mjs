#!/usr/bin/env node
/**
 * 生产环境自检：一条命令回答"现在到底好不好、缺什么"。
 *
 * ## 为什么需要它
 *
 * 这个项目里有三类改动，**生效方式各不相同**，混在一起时症状几乎一样：
 *
 * | 改动 | 生效方式 |
 * |---|---|
 * | 客户端（`boot.js`） | **刷新页面**即可（每次请求读盘） |
 * | 宿主模块（`packages/host/lib`） | **必须重启 DSH**，且要先重新安装 |
 * | 配置（`cordis.patch.yml`） | 重启 DSH 后生效 |
 *
 * 于是"我明明改了怎么没效果"「到底是没生效还是坏了」变成最常见、
 * 也最难自证的困惑。这个脚本把三类都查一遍并**分别标注**，
 * 让人一眼看出该刷新、该重启、还是该排查。
 *
 * ## 用法
 *
 *   node scripts/check-production.mjs                     # 用 ~/.dsh 与默认端口
 *   node scripts/check-production.mjs --dsh-home <路径> --port 3080 --proxy 3081 --phone-ip 10.33.129.145
 *
 * 退出码：全部通过为 0，否则为 1（可直接用在 CI 或 `&&` 链里）。
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const argv = process.argv.slice(2)
const flag = (name, fallback) => {
  const index = argv.indexOf(`--${name}`)
  return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : fallback
}

const DSH_HOME = flag('dsh-home', join(homedir(), '.dsh'))
const PROFILE = flag('profile', 'web')
const PORT = Number(flag('port', '3080'))
const PROXY = Number(flag('proxy', '3081'))
const PHONE_IP = flag('phone-ip', '10.33.129.145')
/**
 * ★ 局域网 IP **动态探测**（round 115 修）。
 *
 * 原先写死 `10.34.221.181` ✗ —— 那台机器换过一次 DHCP 地址，于是这一项
 * 表现为"手机身份访问 manifest 不可达"✗，看起来像功能坏了，其实只是脚本里的
 * 旧地址 ✗（交接文档第五节第 10 条记的正是这个坑 ✓）。
 */
const LAN_IP = flag('lan-ip', (await import(join(dirname(fileURLToPath(import.meta.url)), 'detect-lan-ip.mjs'))).detectLanIp() ?? '127.0.0.1')

/** 宿主侧能力清单，与 `packages/host/src/index.ts` 的 HOST_FEATURES 对应。 */
const EXPECTED_FEATURES = ['files.write', 'relay.dialer', 'relay.backhaul', 'pairing.ticketFallback']

const problems = []
const notes = []
const row = (ok, label, detail) => {
  console.log(`  ${ok === undefined ? '·' : ok ? '✓' : '✗'} ${label}${detail === undefined ? '' : `  [${detail}]`}`)
  if (ok === false) problems.push(label)
  if (ok === undefined) notes.push(`${label}${detail === undefined ? '' : `：${detail}`}`)
}

const get = async (url, init) => {
  try {
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) })
    // 图标要按**字节**看（签名/IHDR），所以额外留一份 Buffer ✓
    const buffer = Buffer.from(await response.clone().arrayBuffer())
    return { status: response.status, body: await response.text(), buffer }
  } catch (error) {
    return { status: 0, body: '', buffer: Buffer.alloc(0), error: String(error?.cause?.code ?? error?.message ?? error) }
  }
}

console.log(`[自检] DSH_HOME=${DSH_HOME}  profile=${PROFILE}  DSH=127.0.0.1:${PORT}\n`)

// ── ① 配置（最容易在"手改/脚本重写"中出错的一层）
console.log('【配置】')
const patchPath = join(DSH_HOME, 'profiles', PROFILE, 'cordis.patch.yml')
if (!existsSync(patchPath)) {
  row(false, '配置文件存在', patchPath)
} else {
  const text = readFileSync(patchPath, 'utf8')
  const authorities = [...text.matchAll(/^\s+-\s*'([^']+)'\s*$/gm)].map((m) => m[1])
  const phoneBaseUrl = /phoneBaseUrl:\s*'([^']+)'/.exec(text)?.[1]
  const relayUrl = /relayUrl:\s*'([^']+)'/.exec(text)?.[1]
  row(authorities.length > 0, 'trustedHosts 已配置', authorities.join(', ') || '空')
  // 预览实例（ui-preview）会临时并入自己的端口；若它被强杀，就会留下这些残留
  const stray = authorities.filter((a) => /:(377\d|365\d)$/.test(a))
  row(stray.length === 0, '没有预览/测试端口残留', stray.length === 0 ? '干净' : stray.join(', '))
  row(/^https:\/\//.test(phoneBaseUrl ?? ''), 'phoneBaseUrl 是 HTTPS（手机需要安全上下文）', phoneBaseUrl ?? '未配置')
  row(true, relayUrl === undefined ? '未配置中继（局域网模式）' : `中继：${relayUrl}`, relayUrl === undefined ? '—' : '已配置')
  row(text.includes('relayToken') || relayUrl === undefined, 'relayToken 与 relayUrl 同时存在', text.includes('relayToken') ? '是' : '否')
}

// ── ② 服务可达性（回环 = 电脑本机视角）
console.log('\n【服务（电脑视角）】')
const loop = await get(`http://127.0.0.1:${PORT}/mobile/manifest`)
let loopJson
try {
  loopJson = JSON.parse(loop.body)
} catch {
  loopJson = undefined
}
row(loop.status === 200 && loopJson !== undefined, '回环 manifest 可达', `HTTP ${loop.status}`)

// ── ③ 手机身份（关键：必须**非回环**来源才会走手机的判定分支）
console.log('\n【服务（手机身份，模拟 x-forwarded-for）】')
// 这里必须容忍**自签证书**：局域网用的就是自签的，Node 的 fetch 会直接拒绝
// （DEPTH_ZERO_SELF_SIGNED_CERT），而手机上浏览器是可以继续访问的。
// 所以用 curl -k —— 与平时手工核对用的是同一条命令，避免"脚本说不行、人肉说行"。
const phoneStatus = (() => {
  try {
    return execFileSync(
      'curl',
      ['-sk', '-o', '/dev/null', '-w', '%{http_code}', '-m', '10', '-H', `x-forwarded-for: ${PHONE_IP}`, `https://${LAN_IP}:3443/mobile/manifest`],
      { encoding: 'utf8' },
    ).trim()
  } catch (error) {
    return `curl 失败：${String(error?.message ?? error).slice(0, 60)}`
  }
})()
row(phoneStatus === '200', '手机身份访问 manifest 可达（栅栏放行）', `HTTP ${phoneStatus}`)

const debugRaw = await get(`http://127.0.0.1:${PORT}/mobile/debug`)
let debug
try {
  debug = JSON.parse(debugRaw.body)
} catch {
  debug = undefined
}
if (debug === undefined) {
  row(false, '诊断端点可达', `HTTP ${debugRaw.status}`)
} else {
  row(Array.isArray(debug.trustedHosts) && debug.trustedHosts.length > 0, '诊断端点报告 trustedHosts', (debug.trustedHosts ?? []).join(', '))
  notes.push(`客户端应使用的地址：${debug.phoneBaseUrl ?? '（未配置）'}`)
}

// ── ④ 客户端资源（改完刷新即可生效）
console.log('\n【客户端资源（刷新即生效）】')
const boot = await get(`http://127.0.0.1:${PORT}/mobile/boot.js`)
row(boot.status === 200 && boot.body.length > 10_000, 'boot.js 可取到', `${boot.body.length} 字节`)
row(/installFileUploadHook/.test(boot.body), 'boot.js 含附件上传钩子（手机可发照片）')
row(/__DSH_MOBILE_BOOT__/.test(boot.body), 'boot.js 含诊断入口（__DSH_MOBILE_BOOT__）')
/**
 * PWA 自证诊断（round 82）：手机上点「安装」出问题时，唯一的取证手段是
 * `?debug=1` 调试框里那几行 `[pwa]`。**断言线上那份 boot.js 真的带着它** ✓
 * —— 只断言仓库里有这段是不够的：本项目不止一次出现过"仓库改了、线上还是旧的" ✗。
 */
/**
 * 公式渲染器（round 97）：宿主必须把 Temml 作为静态资源发出来 ✓，
 * 否则手机上的 md 预览只能显示原样 TeX ✗。这里同时断言"取得到"与"是 JS" ✓。
 */
row(/\[pwa\] 打开方式=/.test(boot.body) && /\[pwa\] 可安装信号=/.test(boot.body),
  'boot.js 含 PWA 自证诊断（?debug=1 时把"在哪一页/装成没装成/Chrome 认不认可"写进调试框）')

// ── ④b PWA：「添加到主屏幕」的三条资源（宿主侧 → **重启后才生效**）
//
// 为什么放在"宿主侧"这一组：manifest 与图标是插件自己发的新路由 ✓，
// 重启前访问会走静态管线 → 404（那不是故障，是"改了还没重启"✓，
// 与 §从这里开始 里那句"重启前会有 ✗，那都是等你重启"一致）。
console.log('\n【PWA（添加到主屏幕；宿主侧 → 重启后生效）】')
const webmanifest = await get(`http://127.0.0.1:${PORT}/mobile/manifest.webmanifest`)
let manifestJson = null
try {
  manifestJson = JSON.parse(webmanifest.body)
} catch {
  manifestJson = null
}
row(
  webmanifest.status === 200 && manifestJson !== null && manifestJson.start_url === '/mobile/app',
  'web app manifest 可取到且 start_url 指向手机外壳',
  webmanifest.status === 200 ? `start_url=${manifestJson?.start_url ?? '(解析失败)'}` : `HTTP ${webmanifest.status}（重启后生效）`,
)
const iconSizes = []
for (const [name, size] of [
  ['icon-192.png', 192],
  ['icon-512.png', 512],
  ['icon-maskable-512.png', 512],
]) {
  const icon = await get(`http://127.0.0.1:${PORT}/mobile/${name}`)
  // PNG 是二进制，必须按 Buffer 看（按文本读会得到乱码 ✗）
  const bytes = icon.buffer
  const isPng = bytes.length > 24 && bytes.subarray(0, 8).toString('hex') === '89504e470d0a1a0a'
  // IHDR 固定偏移：8 签名 + 4 长度 + 4 类型 → 16 起是宽、20 起是高 ✓
  const width = isPng ? bytes.readUInt32BE(16) : 0
  const height = isPng ? bytes.readUInt32BE(20) : 0
  const ok = icon.status === 200 && isPng && width === size && height === size
  if (ok) iconSizes.push(`${name}=${width}x${height}`)
  row(ok, `图标 ${name} 是合法 PNG 且尺寸正确`, ok ? `${width}x${height}，${bytes.length} 字节` : `HTTP ${icon.status}（重启后生效）`)
}

// ── ⑤ 宿主能力（改完**必须重启**才生效）
console.log('\n【宿主能力（改动后必须重启 DSH）】')
const features = Array.isArray(debug?.features) ? debug.features : []
if (features.length === 0) {
  row(
    false,
    '当前进程报告的宿主能力',
    '未报告 = 跑的是**旧版**宿主代码。这不是故障，是"改了还没重启"——重新安装并重启 DSH 后这一项会变成 ✓',
  )
} else {
  for (const name of EXPECTED_FEATURES) {
    row(features.includes(name), `宿主能力：${name}`, features.includes(name) ? '在运行' : '缺失（该版本未包含）')
  }
  const extra = features.filter((f) => !EXPECTED_FEATURES.includes(f))
  if (extra.length > 0) notes.push(`宿主还报告了：${extra.join(', ')}`)
  // agent 工具的**运行时**注册结果（不是静态声明）：这是"agent 能否指挥手机"的唯一可信信号
  const agentTool = debug.agentTool
  row(
    agentTool === 'registered',
    'agent 工具 phone_notify 已注册（agent 可直接给手机发通知）',
    agentTool === 'registered'
      ? 'registered'
      : `${String(agentTool)}——检查启动日志里 [dsh-mobile] 的那一行（skipped/failed 都不影响其余功能）`,
  )
}

// ── ⑥ 端侧通道：各设备已启用的能力（"为什么手机收不到通知"的第一现场）
{
  const status = await get(`http://127.0.0.1:${PORT}/mobile/device/status`)
  let parsed
  try {
    parsed = JSON.parse(status.body)
  } catch {
    parsed = undefined
  }
  if (status.status === 200 && parsed !== undefined) {
    console.log('\n【端侧通道（电脑 → 手机）】')
    const enabled = parsed.enabled ?? {}
    const devices = Object.keys(enabled)
    if (devices.length === 0) {
      row(undefined, '当前没有在线设备（手机连上后再看这里）')
    } else {
      for (const deviceId of devices) {
        const capabilities = enabled[deviceId] ?? []
        row(
          capabilities.length > 0,
          `设备 ${deviceId.slice(0, 16)}… 已允许的能力`,
          capabilities.length > 0 ? capabilities.join(', ') : '无（手机上还没点「允许」，或曾点过「不用」）',
        )
      }
      // 能力的**可选项**来自宿主；某个设备没启用它，通常是用户在手机上答过"不用"
      notes.push(`宿主持有的端侧能力：${(parsed.capabilities ?? []).join(', ')}`)
      notes.push(
        '要重新征询：在手机浏览器控制台执行 localStorage.clear()（或只删 dsh-mobile.deviceAsk.* 与 dsh-mobile.deviceEnabled.*），刷新页面即可再问一次',
      )
    }
  } else {
    // ★ 不要静默跳过：这个端点不存在**本身就是信息**（宿主还是旧版）。
    //   "什么都不打印"最容易被误读成"这项没问题"——本项目为此吃过好几次亏。
    row(
      undefined,
      '端侧通道状态暂不可查',
      status.status === 0 ? status.error ?? '请求失败' : `HTTP ${status.status}——宿主是旧版（重启 DSH 后可见）`,
    )
  }
}

// ── ⑦ 中继（如果配了）
const relayUrl = existsSync(patchPath) ? /relayUrl:\s*'([^']+)'/.exec(readFileSync(patchPath, 'utf8'))?.[1] : undefined
if (relayUrl !== undefined) {
  console.log('\n【中继】')
  const httpBase = String(relayUrl).replace(/^ws/, 'http').replace(/\/attach.*$/, '')
  const health = await get(`${httpBase}/healthz`)
  let healthJson
  try {
    healthJson = JSON.parse(health.body)
  } catch {
    healthJson = undefined
  }
  row(health.status === 200 && healthJson?.ok === true, '中继健康检查可达', health.status === 0 ? health.error : `HTTP ${health.status}`)
  if (healthJson !== undefined) {
    const backhauls = healthJson.backhauls ?? 0
    const idleHosts = healthJson.idleHosts ?? 0
    row(backhauls >= 1, '电脑的回源通道已连上（否则页面无法远程下发）', `backhauls=${backhauls}`)
    row(idleHosts >= 1, '有已认证的空闲隧道连接（手机可连）', `idleHosts=${idleHosts}`)
    // 分情况给出**下一步该做什么**：这几个 ✗ 的原因完全不同，
    // 只说"没连上"等于把排查成本转嫁给用户（而这正是部署后最可能遇到的情形）。
    if (backhauls < 1 || idleHosts < 1) {
      console.log('  怎么办：')
      console.log('    · 中继通了但电脑没挂上 → 确认这份配置里的 relayUrl / relayToken 与实际部署一致，')
      console.log('      并且**改配置后重启过 DSH**（配置是热加载的，但外拨连接是启动时建立的）。')
      console.log('    · 刚重启完 → 等 3~5 秒（外拨失败后每 3 秒重试一次），再跑一次本命令。')
      console.log('    · 一直不上 → 在电脑上看 DSH 日志里 [dsh-mobile] 的中继相关行；')
      console.log('      中继侧则看 journalctl -u dsh-mobile-relay。')
    }
  } else {
    // 连不上：三种原因（域名/证书/服务）的处理完全不同，分开说
    console.log('  怎么办：')
    console.log(`    · 先在电脑上直接试：curl -v ${httpBase}/healthz（看是 DNS、证书还是连接被拒）`)
    console.log('    · DNS：域名 A 记录是否已指向 VPS（dig +short <域名>）')
    console.log('    · 证书：Let\'s Encrypt 是否签下来了（ssh <vps> \'ls /etc/letsencrypt/live/\'）')
    console.log('    · 服务：ssh <vps> \'systemctl status dsh-mobile-relay --no-pager\'')
  }
}

// ── 结论
console.log('\n【结论】')
if (notes.length > 0) {
  console.log('  供参考：')
  for (const note of notes) console.log(`    · ${note}`)
}
if (problems.length === 0) {
  console.log('  全部通过 ✓')
  process.exit(0)
}
console.log(`  未通过 ${problems.length} 项：`)
for (const problem of problems) console.log(`    ✗ ${problem}`)
console.log('\n  提示：客户端问题→刷新页面；宿主能力缺失→先 npm run build 再重启；配置问题→用 install-host-plugin 重写而不是手改。')
process.exit(1)
