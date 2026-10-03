/**
 * Cordis 插件入口：把 @dsh-mobile/host 挂进 DSH 的 web profile。
 *
 * 关键点是"只用官方扩展点"：
 *  - `ctx.webServer.register / registerUpgrade`：挂 HTTP 与 WebSocket 路由；
 *  - `ctx.webServer.tapIndex`：往 index.html 注入 shim 脚本，使其**先于**应用 bundle 执行
 *    （这是 Flutter WebView 无法保证"启动前注入"的唯一可靠解法）；
 *  - `ctx.typertGateway.invoke / stream`：把隧道内的调用转给 DSH 既有业务 API，
 *    因此会话/工作区/文件/设置/凭据/skill/权限/上下文用量全部无需重写。
 *
 * 宿主身份（用于 TOFU 固定）持久化在 `$DSH_HOME/storages/dsh-mobile/host-identity.json`，
 * 私钥**只存本机**；换机或删文件会导致已配对手机的指纹校验失败（这是刻意的安全性质）。
 */

import { createHash, createPrivateKey } from 'node:crypto'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { Context } from '@deepseek-ai/cordis'
// 类型侧导入：这两行没有运行时开销，作用是加载 DSH 包的 `declare module` 声明合并，
// 让 ctx.webServer / ctx.typertGateway 在本插件里类型可见。
import type {} from '@deepseek-ai/dsh-api-gateway'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { generateP256KeyPair } from '@dsh-mobile/protocol'

import { DeviceStore } from './devices.ts'
import { resolveDshRuntimeVersion } from './dsh-version.ts'
import { detectLanIp, isAddressPresent, listLanCandidates } from './lan.ts'
import { createLanListener, DEFAULT_PLAIN_LISTEN, DEFAULT_TLS_LISTEN, type LanListener } from './lan-listener.ts'
import { resolveMachineConfig } from './machine-config.ts'
import {
  handleSetupRequest,
  readCurrentConfig,
  resolveProfilePatchPath,
  SETUP_PAGE_PATH,
  SETUP_PATH,
} from './setup-config.ts'
import { createTlsManager } from './tls-cert.ts'
import {
  createMobileHost,
  DEFAULT_CONFIG,
  isLoopbackRequest,
  type HostIdentity,
  type MobileHost,
  type MobileHostConfig,
  type RemoteGateway,
} from './index.ts'

/** Cordis 插件名（与包名一致，便于排障）。 */
export const name = 'mobile-host'

/** 依赖的宿主服务。缺失时 Cordis 不会激活本插件，而不是让它在半可用状态下报错。 */
export const inject = ['webServer', 'typertGateway']

/** 插件配置（与 MobileHostConfig 一致，另加 dshHome 覆盖）。 */
export interface Config extends Partial<MobileHostConfig> {
  /** DSH home 目录；省略时跟随 `$DSH_HOME` 与 `~/.dsh`。 */
  dshHome?: string
  /** 对外声明的主机名（仅用于展示）。 */
  hostName?: string
  /** 允许授予的最大能力位。默认仅有只读能力。 */
  capabilityCeiling?: {
    fsRead?: boolean
    fsWrite?: boolean
    fsShell?: boolean
    phoneFs?: boolean
    phoneControl?: boolean
  }
  /** 是否往 index.html 注入 shim（默认开启）。 */
  injectShim?: boolean
  /**
   * 要读写的 profile 名（默认**从插件自身的位置推断**，见 `setup-config.ts`）。
   *
   * ★ 一般不用配：插件装在 `<DSH_HOME>/profiles/<profile>/node_modules/` 下，
   *   位置本身就说明了 profile ✓（写死 `web` 会让 `--profile headless` 那类部署被写到别的 profile ✗）。
   *   这里只是"布局不认识"时的显式覆盖 ✓。
   */
  profile?: string
  /** 客户端 boot 脚本路径；省略时尝试从插件包内的 lib/boot.js 读取。 */
  bootScriptPath?: string
  /**
   * 本部署额外服务的 authority（局域网地址），例如 `['10.0.0.5:3080']`。
   * 必须与手机实际访问的 authority 一致，否则 /mobile 路由会以 403 拒绝。
   */
  trustedHosts?: string[]
  /**
   * 写进配对码的对外基地址，例如 `http://10.0.0.5:3081`。
   *
   * 为什么必须可配：DSH 只绑 loopback，局域网访问要经本机代理，
   * 因此**手机能到的是代理端口，而不是 DSH 端口**。若配对码里嵌的是自动探测到的
   * `http://<ip>:<DSH端口>`，手机会照着连——连不上（那个端口只对回环开放）。
   * 安装脚本会用 `--trusted-host` 的值自动填好这一项。
   */
  publicBaseUrl?: string
  /**
   * **额外的**手机访问基地址（非局域网：自建中继、覆盖网、IPv6 等）。
   *
   * 会随配对票据的 `endpoints` 一起下发给手机，成为它的**候选端点**之一。
   * 手机侧不需要为新增端点改代码——它按顺序逐个尝试（见客户端 `deriveTunnelUrls`）。
   * 例：`['https://relay.example.com']`。
   */
  extraEndpoints?: string[]
  /**
   * **手机**应访问的基地址（HTTPS），如 `https://10.34.221.181:3443`。
   *
   * 手机侧必须 HTTPS：普通 HTTP 页面不是安全上下文，`crypto.subtle` 不存在，
   * 配对与隧道都无法工作。安装脚本会用 `--phone-base-url` 写入。
   */
  phoneBaseUrl?: string
  /**
   * 插件自带的局域网监听（C1：把 `scripts/lan-proxy.mjs` 搬进插件）。
   *
   * ★ **默认关闭**（`enabled` 缺省 = false）⇒ 老部署行为**一字不变**：手机入口仍由
   * 外置的 `scripts/lan-proxy.mjs` 提供。只有显式写 `enabled: true` 才会在插件进程里
   * 起明文（默认 `0.0.0.0:3081`）与 TLS（默认 `0.0.0.0:3443`）监听。
   *
   * 监听失败**只警告不抛错**（手机入口不可用 ≠ DSH 挂掉），现状见
   * `/mobile/admin/selfcheck` 的 `listener` 段（含端口冲突原因与 `x-forwarded-for` 注入状态）。
   */
  listener?: {
    enabled?: boolean
    plain?: string
    tls?: string
  }
}

/** 解析 DSH home。 */
function resolveDshHome(explicit?: string): string {
  if (explicit !== undefined && explicit.length > 0) return explicit
  const fromEnv = process.env['DSH_HOME']
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv
  const home = process.env['HOME'] ?? process.env['USERPROFILE'] ?? '.'
  return join(home, '.dsh')
}

/**
 * 载入或创建宿主身份。
 *
 * 私钥以 JSON 存于本机（DSH home 的 storages 目录，权限 0600）。
 * 不引入额外加密：这个文件与 DSH 自己的 `.credentials.yaml` 同级别，
 * 若攻击者能读它，早已能读走模型 API Key，加密它并不提升实际安全性。
 */
export function loadOrCreateHostIdentity(options: { directory: string; hostName?: string }): HostIdentity {
  const file = join(options.directory, 'host-identity.json')
  mkdirSync(dirname(file), { recursive: true })
  const existing = readJson<{ hostId?: string; hostName?: string; publicKey?: string; privateKeyPem?: string }>(file)
  if (existing?.hostId !== undefined && existing.publicKey !== undefined && existing.privateKeyPem !== undefined) {
    return {
      hostId: existing.hostId,
      hostName: existing.hostName ?? options.hostName ?? 'DeepSeek Harness',
      signingKey: {
        publicKey: existing.publicKey,
        privateKey: createPrivateKey({ key: existing.privateKeyPem, format: 'pem', type: 'pkcs8' }),
      },
    }
  }

  const pair = generateP256KeyPair()
  const privateKeyPem = (pair.privateKey as { export(config: { type: 'pkcs8'; format: 'pem' }): string }).export({
    type: 'pkcs8',
    format: 'pem',
  })
  const hostId = `host-${(pair.publicKey as string).slice(0, 12)}`
  const identity = {
    hostId,
    hostName: options.hostName ?? 'DeepSeek Harness',
    publicKey: pair.publicKey,
    privateKeyPem,
  }
  writeFileSync(file, `${JSON.stringify(identity, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  return { hostId, hostName: identity.hostName, signingKey: { publicKey: pair.publicKey, privateKey: pair.privateKey } }
}

function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T
  } catch {
    return undefined
  }
}

/**
 * 计算本机可用的连接地址（写入配对码，供手机选择）。
 *
 * ## 为什么不"激活时采样一次"
 *
 * 早期版本在插件启动时采样一次网络接口（与 DSH web 自身一致），代价是**换网络就得重启**：
 * 换了 Wi-Fi 或 DHCP 续租换了地址后，配对码里仍嵌着旧地址，手机照着连必然失败。
 *
 * 现在把顺序反过来：**只要缓存的地址仍存在于某个网卡上就沿用**（稳定、不会每次生成都变），
 * 一旦它消失了就立刻改用重新探测的地址。这样常见的网络变化不再需要重启 DSH。
 *
 * 探测走 `detectLanIp()`（与 `scripts/detect-lan-ip.mjs` 同一套排序规则），
 * 它会排除 169.254/16 这类自分配地址——正是本机 `en0` 上那个"奇怪的 IP"。
 */
function sampleEndpoints(port: number): string[] {
  const live = detectLanIp()
  if (live !== undefined) return [`http://${live}:${port}`]

  // 探测不到（例如全是自分配地址或只有回环）：退化到回环，至少配对码可用
  return [`http://127.0.0.1:${port}`]
}

/**
 * 带缓存的端点解析器：地址仍在网卡上就沿用，消失则重新探测。
 *
 * 之所以要缓存：同一个局域网地址在多次生成配对码之间不应跳变（用户可能已经
 * 把上一个链接发出去了）。之所以要失效：换网络后必须立刻纠正。
 */
function createEndpointResolver(
  logger: { info?: (message: string) => void } | undefined,
  port: number,
  configured: string | undefined,
  /**
   * 额外端点（非局域网：中继地址等）。
   *
   * 为什么放在配置里而不是写死代码：部署形态（自建中继 / 覆盖网 / IPv6 直连）
   * 会变，而**手机侧不需要跟着改**——它拿到的是一份候选列表，逐个试。
   * 这些地址会随配对票据的 `endpoints` 一起下发给手机。
   */
  extra: readonly string[] = [],
) {
  let cached = configured ?? detectLanIp()
  if (configured !== undefined) return () => [configured, ...extra]
  return (): string[] => {
    if (configured !== undefined) return [configured, ...extra]
    const previous = cached
    if (previous !== undefined && !isAddressPresent(previous)) {
      const reDetected = detectLanIp()
      if (reDetected !== undefined && reDetected !== previous) {
        logger?.info?.(`[mobile-host] 局域网地址已变化：${previous} → ${reDetected}（配对码将使用新地址）`)
        cached = reDetected
      }
    }
    if (cached === undefined) cached = detectLanIp()
    const primary = cached === undefined ? `http://127.0.0.1:${port}` : `http://${cached}:${port}`
    return [primary, ...extra]
  }
}

/** 前端包名（唯一来源：三条路都在解析它 ✓，别在别处再写一遍 ✗）。 */
const FRONTEND_PACKAGE = '@deepseek-ai/dsh-web-frontend'

/** 一次"从某个锚找 DSH 前端"的尝试（★ 排障信息：用户要看到试了哪几条、各自栽在哪 ✓）。 */
export interface DistIndexAttempt {
  /** 这条路的人话名字（日志与 503 文案都会原样显示 ✓）。 */
  readonly label: string
  /** 这条路的锚（安装锚路径 / `argv[1]` / 模块 URL）；本次运行拿不到时是 `'(没有这个锚)'` ✓。 */
  readonly anchor: string
  /** 这条成不成功。 */
  readonly ok: boolean
  /** 失败时是**原因** ✓、成功时是解析到的 `dist/index.html` ✓。 */
  readonly detail: string
}

/** 前端定位器：`resolve()` 给路径，`problem()` 给"为什么没有"（★ 绝不静默 ✗）。 */
export interface DistIndexResolver {
  /**
   * 解析 DSH 前端的 `dist/index.html`。
   *
   * @returns 解析到**且文件确实存在**时是绝对路径 ✓；否则 `undefined` ✓ ——
   *          但那一定伴随 `problem()` 里一句能念的原因 ✗（不许"返回 undefined 就完事" ✗）。
   */
  resolve(): string | undefined
  /** 最近一次 `resolve()` 失败的原因（成功时为 `undefined`）✓ —— `/mobile/app` 的 503 文案用它 ✓。 */
  problem(): string | undefined
  /** 最近一次成功时用的锚（诊断用：到底是哪条路救回来的 ✓）。 */
  anchor(): string | undefined
  /** 最近一次尝试的逐条记录（排障与用例用 ✓）。 */
  attempts(): readonly DistIndexAttempt[]
}

/** `createDistIndexResolver` 的输入（三个锚都可注入 ⇒ 三种安装形态都能在单测里验 ✓）。 */
export interface DistIndexResolverOptions {
  /** ① 运行中 DSH 的安装锚（`ctx.get('profileContext')?.installAnchor` ✓，见 `readProfileContextInstallAnchor`）。 */
  installAnchor?: string | undefined
  /** ② 正在运行的进程入口（`process.argv[1]` ✓）。 */
  processEntry?: string | undefined
  /** ③ 插件自身的模块地址（`import.meta.url` ✓）。 */
  moduleUrl?: string | undefined
  /** 文件存在性判据（单测注入点；默认 `existsSync` ✓）。 */
  exists?: ((path: string) => boolean) | undefined
  /** 日志出口（默认 `console.log` / `console.warn` ✓）。 */
  logger?: { log?: ((message: string) => void) | undefined; warn?: ((message: string) => void) | undefined } | undefined
}

/** 锚必须是**非空字符串**才算数 ✓（拿 `''` 去 createRequire 只会得到另一种静默 ✗）。 */
function usableAnchor(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length === 0 ? undefined : trimmed
}

/**
 * 把解析异常压成**一行**。
 *
 * 为什么必须压 ✗：`require.resolve` 的 `Cannot find module` 自带一段 `Require stack:`（多行 ✓），
 * 而这句话要进 503 响应体与一行日志 —— 带换行会让两边都变得没法念 ✗。
 *
 * ★ 还要**掐掉** `Require stack` 那一段 ✓：它列的正是我们的锚本身（紧邻前面已经写了"锚：…"✓），
 *   留着只会让这句话长一倍、把真正的信息（错误码 + 找不到哪个包）淹掉 ✗。
 */
function describeResolutionError(error: unknown): string {
  const code = (error as { code?: unknown } | undefined)?.code
  const message = error instanceof Error ? error.message : String(error)
  const withoutStack = message.split('Require stack:')[0] ?? message
  const oneLine = withoutStack
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join(' ')
  return typeof code === 'string' && !oneLine.includes(code) ? `${code}: ${oneLine}` : oneLine
}

/**
 * 定位 DSH 前端 `dist/index.html`。
 *
 * ## ★★ 2026-09-30 修：锚必须落在"**运行中那套 DSH**"上，不许落在插件自己身上 ✗
 *
 * 旧实现只有一条路：`createRequire(import.meta.url)` —— 即**从插件自己的模块位置**解析
 * `@deepseek-ai/dsh-web-frontend` ✓。它在**拷贝安装**（插件实体在
 * `<DSH_HOME>/profiles/<profile>/node_modules/@dsh-mobile/host/` 里，生产就是这种 ✓）下是对的 ✓，
 * 但在**本地路径 / `link:` 安装**（pnpm 建软链；桌面 UI 装本地路径必然如此 ✓）下**必然失败** ✗：
 * `import.meta.url` 指向的是**仓库**（`…/dsh-mobile/packages/host/lib/cordis.js` ✓），
 * 从仓库解析前端包必然失败 ⇒ 返回 `undefined` ⇒ 手机端只看到一句"应用外壳不可用"，
 * 而**日志里没有任何原因** ✗（真机现场：DSH 桌面版 0.2.0-rc.2、profile=`desktop`、
 * `link:/…/dsh-mobile/packages/host` ⇒ `http://127.0.0.1:19387/mobile` 报外壳不可用 ✗）。
 *
 * 这与今天刚修过的 `resolveProfilePatchPath`（见 `setup-config.ts`）是**同一个病** ✓：
 * "从插件自身位置推断环境"在软链安装下必错 ✗。那里的处方是"**显式传参 + 拿不准就报错**"✓，
 * 这里照**同一个形状**来 ✓（不新造第二套机制 ✗）：
 *
 * | 顺序 | 锚 | 为什么是它 |
 * |---|---|---|
 * | ① | `ctx.get('profileContext').installAnchor` | DSH 自己挂上来的**安装锚** = 运行中那套 DSH 的 `package.json` ✓（`readProfileContextInstallAnchor` 有依据 ✓） |
 * | ② | `process.argv[1]` | 正在运行的进程入口（`dsh` 的 `bin.js` / 桌面版 host 入口 ✓）⇒ 从它旁边必然上溯得到安装目录 ✓ |
 * | ③ | `import.meta.url` | **拷贝安装**下它是对的 ⇒ 必须保留 ✓（软链安装下会被 ① 或 ② 抢先 ✓） |
 *
 * ## 依据（读类型/实现，不猜 ✗）
 *
 * · `@deepseek-ai/dsh-app-boot` 的 `ProfileModuleFallbackOptions.installAnchor`
 *   （`lib/types/profile.d.ts:95-102`）：**"Absolute package.json path of the running dsh installation."** ✓
 *   —— 同一个锚也是 `resolveBundleDir(binName, packageName, installAnchor, profileDir)` 的**第一**锚 ✓，
 *   顺序是契约原话："The installation-first order is the contract that `@deepseek-ai/dsh-base`
 *   (and every other in-box bundle) always comes from the same installation as the running dsh,
 *   never from a profile-local copy." ✓ ⇒ 前端也该**先**从安装解析 ✓（它必须与运行中的服务端同版本 ✓）。
 * · 桌面版 0.2.0-rc.2 的 profile-boot 就是把它挂在 ctx 上的（真机现场那套 ✓）：
 *   `hostCtx.provide('profileContext', { …, installAnchor: options.resolvedProfile?.installAnchor ?? INSTALL_ANCHOR, … })`
 *   而 `INSTALL_ANCHOR = fileURLToPath(new URL('../package.json', import.meta.url))` ✓。
 * · DSH 自己的 README（打包进 `@deepseek-ai/dsh` 的那份 ✓）原话：
 *   "A resolved application profile supplies its own **installation anchor** for runtime package resolution" ✓。
 *
 * ## 绝不静默（本次一并修的 ✗）
 *
 * 三条路都失败时：
 *   1. **打一行能念的日志** ✓（`[dsh-mobile]` 前缀，列出三条路各自的失败原因 ✓，且**只在结论变化时**打一次——
 *      每个请求打一遍会把日志刷爆 ✗）；
 *   2. 把这行原因**留在解析器上** ✓ ⇒ `/mobile/app` 的 503 文案带上它
 *      （`…（未找到 DSH 前端 dist/index.html：<原因>）` ✓）。
 *
 * ## 行为不变的部分（别弄坏 ✗）
 *
 * · 解析成功 ⇒ 与原实现**同一条路径** ✓（`join(dirname(manifest), 'dist', 'index.html')` ✓）；
 * · 解析不到 ⇒ 插件**照常工作** ✓（只是手机端拿不到外壳 ✓），返回 `undefined` 而不是抛错 ✓。
 * · 唯一新增的判据是"**文件得真的在**"✓：解析到前端包但 `dist/index.html` 缺失时按失败处理
 *   （并说清是哪个文件缺 ✓）—— 原先那种情况下 `getAppShell()` 一样拿不到外壳（`statSync` 会抛 ✓），
 *   所以行为等价，只是**从静默变成有原因** ✓。
 */
export function createDistIndexResolver(options: DistIndexResolverOptions = {}): DistIndexResolver {
  const exists = options.exists ?? existsSync
  const log = options.logger?.log ?? ((message: string): void => console.log(message))
  const warn = options.logger?.warn ?? ((message: string): void => console.warn(message))
  /**
   * ★ 三条路，**顺序即契约**：先"运行中那套 DSH"（①②），最后才退到"插件自己"（③）✓。
   * ⚠️ 每条都带 `label`：失败时用户看到的是"试了哪几条、各自栽在哪" ✓，不是一句"没找到" ✗。
   */
  const sources: ReadonlyArray<{ label: string; anchor: string | undefined }> = [
    {
      label: "运行中 DSH 的安装锚（ctx.get('profileContext').installAnchor）",
      anchor: usableAnchor(options.installAnchor),
    },
    { label: '正在运行的进程入口（process.argv[1]）', anchor: usableAnchor(options.processEntry) },
    {
      label: '插件自身位置（import.meta.url；**拷贝安装**下这条路是对的）',
      anchor: usableAnchor(options.moduleUrl),
    },
  ]
  let latestAttempts: DistIndexAttempt[] = []
  let latestProblem: string | undefined
  let latestAnchor: string | undefined
  /** 上一次**打过日志的结论**（成功给路径、失败给原因）：只在它变了时再打一行 ✓。 */
  let loggedKey: string | undefined

  const resolve = (): string | undefined => {
    const attempts: DistIndexAttempt[] = []
    let path: string | undefined
    let anchor: string | undefined
    for (const source of sources) {
      if (source.anchor === undefined) {
        // 这条锚**本次运行里根本不存在**（老 DSH 没有 profileContext / 进程没有脚本入口 ✓）。
        // 也要记一条 ✗：否则用户看到"两条路都失败"，却不知道本来还有第三条 ✓。
        attempts.push({
          label: source.label,
          anchor: '(没有这个锚)',
          ok: false,
          detail: '本次运行拿不到这个锚（老版本 DSH 不提供 profileContext，或进程没有脚本入口）',
        })
        continue
      }
      let manifest: string
      try {
        // 与 DSH 自己的 `resolveDistIndex()`（dsh-web-app）**同一个解析方式** ✓：以锚为基准
        // `require.resolve` 包的 package.json（前端包的 exports 里有 `./package.json` ✓）。
        manifest = createRequire(source.anchor).resolve(`${FRONTEND_PACKAGE}/package.json`)
      } catch (error) {
        attempts.push({ label: source.label, anchor: source.anchor, ok: false, detail: describeResolutionError(error) })
        continue
      }
      const candidate = join(dirname(manifest), 'dist', 'index.html')
      if (!exists(candidate)) {
        attempts.push({
          label: source.label,
          anchor: source.anchor,
          ok: false,
          detail: `解析到了前端包（${manifest}）但它旁边没有 ${candidate}`,
        })
        continue
      }
      attempts.push({ label: source.label, anchor: source.anchor, ok: true, detail: candidate })
      path = candidate
      anchor = source.anchor
      break
    }
    latestAttempts = attempts
    latestAnchor = anchor
    latestProblem =
      path === undefined
        ? `试了 ${attempts.length} 条路都没解析到 ${FRONTEND_PACKAGE}：` +
          attempts
            .map((item, index) => `${index + 1}) ${item.label}（锚：${item.anchor}）⇒ ${item.detail}`)
            .join('；')
        : undefined
    const key = path === undefined ? `fail:${latestProblem ?? ''}` : `ok:${path}`
    if (key !== loggedKey) {
      loggedKey = key
      if (path === undefined) {
        warn(
          `[dsh-mobile] ★ 定位 DSH 前端失败（手机端拿不到应用外壳 dist/index.html；插件其余功能照常）：${latestProblem ?? ''}`,
        )
      } else {
        log(`[dsh-mobile] DSH 前端 dist/index.html = ${path}（锚：${anchor ?? '?'}）`)
      }
    }
    return path
  }

  return {
    resolve,
    problem: () => latestProblem,
    anchor: () => latestAnchor,
    attempts: () => latestAttempts,
  }
}

/**
 * `/mobile/app` 那句"外壳不可用"的 503 文案（★ **必须带上原因** ✗）。
 *
 * 为什么单拎出来 ✗：它现在要被用例逐字钉住 ✓（"解析失败时用户到底看到什么"是本次修复的验收之一 ✓），
 * 而原先那句话里**只有"不可用"、没有任何原因** ✗ —— 用户与排障者都无从下手 ✓。
 *
 * @param problem `DistIndexResolver.problem()` 的返回值 ✓。`undefined` 只在"解析到了但读不出来"
 *                （例如权限 / 读盘竞态）时出现 —— 那时 `index.ts` 的 `getAppShell()` 已经把具体错误
 *                记进设备审计（`store.record(...)` ✓ 不静默 ✓），所以这里保持原样不加尾巴 ✓。
 */
export function appShellUnavailableBody(problem: string | undefined): string {
  const tail = problem === undefined ? '' : `：${problem}`
  return `dsh-mobile: 应用外壳不可用（未找到 DSH 前端 dist/index.html${tail}）\n`
}

/**
 * 读 DSH **实际**的监听端口。
 *
 * ## 从哪读（别猜 ✗）
 *
 * `@deepseek-ai/dsh-host-webserver` 的 `WebServer` 类型上就有两个 getter
 * （`lib/types/index.d.ts`）：`get port(): number`（**实际**监听值 —— `config.port` 为 0 时
 * 是系统分配的那个 ✓）与 `get host(): '127.0.0.1' | '0.0.0.0'`。
 * 这里只读 `port` ✓：URL 里一律写 `127.0.0.1` ✓ ——
 * 本机配置页的闸门看的是 **socket 是不是回环** ✓，所以链接必须是回环地址才能打开 ✓，
 * 而 `host` 是 `0.0.0.0` 时用它拼出来的地址反而不保证这一点 ✗。
 *
 * ## 读不到就返回 undefined（**绝不猜 3080** ✗）
 *
 * 3080 只是生产部署的习惯端口 ✓（`--port 0` / 换端口都合法 ✓）。
 * 猜错的代价是"启动日志给了一条打不开的链接"✗ ⇒ 宁可退化成只打路径 ✓。
 */
export function readWebServerPort(webServer: unknown): number | undefined {
  const value = (webServer as { port?: unknown } | undefined)?.port
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

/**
 * "还没配置手机接入"那行启动提示（★ 只在真的没配置时才打，别刷屏 ✗）。
 *
 * 两副面孔：
 *   · 读得到端口 ⇒ 给出**完整可点**的链接 ✓（终端会把 URL 变成可点链接 ✓）；
 *   · 读不到端口 ⇒ 只给路径 ✓，并**如实说明**为什么 ✓
 *     （"读不到 DSH 的监听端口"），让用户自己在 DSH 页面地址后面接上 ✓。
 */
export function setupStartupHint(port: number | undefined): string {
  const head = '[dsh-mobile] 还没配置手机接入 ⇒ '
  const tail = ' 配一次（即时生效，不用重启 DSH）'
  if (port === undefined) {
    return `${head}读不到 DSH 的监听端口 ⇒ 在你打开 DSH 页面的地址后面加上 ${SETUP_PAGE_PATH}${tail}`
  }
  return `${head}在本机浏览器打开 http://127.0.0.1:${port}${SETUP_PAGE_PATH}${tail}`
}

/**
 * ★★ 取本次运行的 profile 名（唯一来源：DSH 自己挂上来的 `profileContext` 服务 ✓）。
 *
 * ## 为什么这样取（先读现成的，不自创 API ✗）
 *
 * `ctx.get('profileContext')?.name` —— **DSH 自己的 bundle patch 就是这么判的**：
 * `dsh-web-app/cordis.patch.yml` 里 `disabled: !!js "ctx.get('profileContext')?.name !== 'desktop'"` ✓。
 * 该服务在 `dsh-app-boot` 的 `boot()` 里由 `prepare(ctx)` **先** `provide`、
 * 之后**才**挂载插件树 ⇒ 本插件 `apply()` 跑时它一定已经在 ✓。
 *
 * ## 为什么这么防御 ✗
 *
 * · 用 `?.` 调 `get`（与下面 `ctx.get('tools')` 同一写法 ✓）：`ctx.get` 在**不认识的服务名**上
 *   返回 `undefined`（不抛 ✓），但 `profileContext` 是 DSH 的服务、不是本插件 `inject` 的依赖 ✗ ——
 *   老版本 DSH / 非 profile 启动下它可能不存在 ✓，那时**安静地**返回 undefined 即可 ✓
 *   （由调用方走 `config.profile` → 模块地址反推 → 明确报错 ✓，绝不猜一个默认值 ✗）。
 * · 抛错也**吞掉**：插件的加载失败会把整个 DSH 带下去 ✗，而"认不出 profile"只是
 *   接入配置这一条路由不可用 ✓（那条路由会明确报错 ✓，见 `resolveProfilePatchPath`）。
 * · 名字必须是**非空字符串**才算数 ✓（拿一个 `{}` 或空串去拼路径＝另一种静默 ✗）。
 */
export function readProfileContextName(ctx: Context): string | undefined {
  try {
    const profileContext = (ctx as unknown as { get?: (name: string) => unknown }).get?.('profileContext')
    if (typeof profileContext !== 'object' || profileContext === null) return undefined
    const name = (profileContext as { name?: unknown }).name
    if (typeof name !== 'string') return undefined
    const trimmed = name.trim()
    return trimmed.length === 0 ? undefined : trimmed
  } catch {
    return undefined
  }
}

/**
 * ★★ 取"**运行中那套 DSH** 的安装锚"（`profileContext.installAnchor` ✓）——
 * 前端定位的第 ① 条路（见 `createDistIndexResolver` 的表格 ✓）。
 *
 * ## 字段名从哪儿来（读实现与类型，**不猜** ✗）
 *
 * 桌面版 0.2.0-rc.2（真机现场那套）的 profile-boot 里，`provide('profileContext', …)` 给的对象是：
 * `{ name, packageManager?, dir, patchPath, installAnchor, startedBundles, cwd, home, overlays, … }`
 * —— 其中 `installAnchor: options.resolvedProfile?.installAnchor ?? INSTALL_ANCHOR`，
 * 而 `INSTALL_ANCHOR = fileURLToPath(new URL('../package.json', import.meta.url))` ✓
 * ⇒ 它是**运行中那套 DSH 的 `package.json` 绝对路径** ✓。
 *
 * 同一个锚在 `@deepseek-ai/dsh-app-boot` 的类型里也这么定义（`lib/types/profile.d.ts:95-102` ✓）：
 * "**Absolute package.json path of the running dsh installation.**" ✓ ——
 * 它正是"运行时包解析的安装锚"（README 原话："A resolved application profile supplies its own
 * installation anchor for runtime package resolution" ✓）。
 *
 * ## 防御写法与 `readProfileContextName` **完全一致** ✓（同一个服务、同一套理由，不另起一套 ✗）
 *
 * · `ctx.get` 在**不认识的服务名**上返回 `undefined`（不抛 ✓）：老版本 DSH（例如 0.1.5-rc.1）
 *   根本没有 `profileContext` 服务 ✗ ⇒ 这里安静地返回 `undefined` ✓，由调用方退到下一条锚 ✓；
 * · 抛错也吞掉：锚取不到只是"少一条路" ✓，绝不该把整个插件（进而整个 DSH）带下去 ✗；
 * · 值必须是**非空字符串**才算数 ✓（拿 `{}` / `''` 去 `createRequire` 只会得到另一种静默 ✗）。
 */
export function readProfileContextInstallAnchor(ctx: Context): string | undefined {
  try {
    const profileContext = (ctx as unknown as { get?: (name: string) => unknown }).get?.('profileContext')
    if (typeof profileContext !== 'object' || profileContext === null) return undefined
    return usableAnchor((profileContext as { installAnchor?: unknown }).installAnchor)
  } catch {
    return undefined
  }
}

/** 插件主体。 */
export function apply(ctx: Context, config: Config = {}): void {
  const dshHome = resolveDshHome(config.dshHome)
  const dataDirectory = join(dshHome, 'storages', 'dsh-mobile')

  /**
   * ★★★ 2026-10-04：**机器专属配置的推导** ✓ —— 为的是让"从 GitHub 装完就能用"成立 ✓。
   *
   * 起因：我们的包是 bundle ✓ ⇒ 装完那一行会自动并进配置 ✓，但那一行**只有 id 与 name** ✗
   * ⇒ `trustedHosts` / `publicBaseUrl` / `phoneBaseUrl` 得由部署方手填 ✓
   * ⇒ 少填的现象是"**插件在跑、手机连不上**"✗（像插件坏了 ✓，很难猜到原因 ✓）。
   * ⇒ 这里按**这台机器的实际地址**把缺的补上 ✓，并且**每一处补了什么都说出来** ✓
   *   （出问题时用户能念出那一行 ✓）。
   * ★ 三条纪律见 `machine-config.ts`：**只补缺** ✓ / **探测不到就不补、绝不编** ✗ / **说出来** ✓。
   */
  const machine = resolveMachineConfig(config, {
    candidates: listLanCandidates(),
    defaultPlain: DEFAULT_PLAIN_LISTEN,
    defaultTls: DEFAULT_TLS_LISTEN,
  })
  for (const line of machine.derived) {
    console.log(`[dsh-mobile] ${line}（如果这不是你要的，就在插件 config 里显式写好它）`)
  }

  /**
   * 局域网监听器（C1）：**默认关闭**，只有 `config.listener.enabled === true` 才起监听。
   *
   * 用 `let` 而不是 `const`：证书管理器的 `onResult` 回调需要引用它，而回调是在
   * `tls.ensure()` 里同步触发的——那时监听器还没建（首次 ensure 也**不需要**热更新，
   * 因为 `start()` 会直接读盘上的最新文件）。之后任何一次 `ensure()` 重签了叶子，
   * 回调就会通过 `refreshTls()` 按 mtime 变化把新证书推进已建立的 TLS 监听。
   */
  let listener: LanListener | undefined

  /**
   * ── 自签证书：**首启缺就生成、有就复用**（B1）───────────────────────────
   *
   * 为什么放在加载期（而不是等第一次 HTTPS 请求）：证书"有没有、对不对"是
   * 一整条链路（手机装 CA、浏览器不报证书错、`/mobile/trust.crt` 能下载）的前提，
   * 让它**在启动那一刻就有结论**，比等到用户手机上打不开再回头查便宜得多。
   *
   * ★ 失败**只警告、不抛错**：插件加载失败会把整个 DSH 带下去，而"没有证书"
   *   只是一条明确可恢复的降级。失败原因会同时出现在：
   *   `/mobile/manifest` 的 `tls.error` 与 `/mobile/admin/selfcheck` 的 `tls.error`
   *   ——**绝不静默**（这是本条的验收要求之一）。
   *
   * ★ 生成位置与 DSH_HOME 绑定：不再写死 `~/.dsh`（`/mobile/trust.crt` 原先写死过，
   *   临时 DSH_HOME / 多 profile 都读不到自己的证书）。
   */
  const tls = createTlsManager({
    directory: join(dataDirectory, 'tls'),
    // 每次 ensure 按**当时**网卡现算 ⇒ 换网后重签叶子时 SAN 才是新的
    addresses: () => listLanCandidates().map((candidate) => candidate.address),
    onResult: (status) => {
      if (status.ok) {
        console.log(
          `[dsh-mobile] 自签 TLS 就绪：CA=${status.caFingerprint ?? '?'}` +
            `${status.createdCa ? '（**新建**，手机需重装一次根证书）' : '（复用）'}` +
            `${status.resignedServer ? '；服务器证书已按当前地址重签（手机信任不受影响）' : ''}` +
            ` 目录=${status.directory}`,
        )
      } else {
        console.warn(
          `[dsh-mobile] 自签 TLS **不可用**（其余功能不受影响，但手机端 HTTPS 会失败）：` +
            `${status.error ?? '未知原因'}（目录：${status.directory}）`,
        )
      }
      /**
       * ★ 证书热更新（C1-6）：重签叶子后**不必重启 DSH**。
       *
       * 只在文件 mtime/size 真的变了时 `setSecureContext(...)`（详见 `lan-listener.ts`）；
       * 失败只记一行警告——证书热更新失败不该把插件加载带下去。
       */
      const reload = listener?.refreshTls()
      if (reload?.error !== undefined) {
        console.warn(`[dsh-mobile] TLS 证书热更新失败（监听仍用旧证书）：${reload.error}`)
      }
    },
  })
  tls.ensure()

  const store = new DeviceStore({
    directory: dataDirectory,
    ...(config.auditLimit === undefined ? {} : { auditLimit: config.auditLimit }),
  })
  const identity = loadOrCreateHostIdentity({
    directory: dataDirectory,
    ...(config.hostName === undefined ? {} : { hostName: config.hostName }),
  })

  // 端口来自 webServer 的实际监听值（支持 --port 0 由系统分配）
  const port = (ctx.webServer as unknown as { port?: number }).port ?? 3080
  const endpoints = createEndpointResolver(
    ctx.logger as unknown as { info?: (message: string) => void } | undefined,
    port,
    machine.publicBaseUrl,
    machine.extraEndpoints.filter((url) => typeof url === 'string' && url.length > 0),
  )

  const gateway = ctx.typertGateway as unknown as RemoteGateway

  /**
   * ── 局域网监听（C1）：按配置起明文 / TLS 监听 ──────────────────────────
   *
   * ★ **默认关闭**：`config.listener?.enabled !== true` 时一行都不做 ⇒ 老部署行为不变。
   * ★ 转发目标是 DSH **自己的 loopback 端口**（`127.0.0.1:${port}`）：这是"面向全量管线"
   *   的关键——`/assets/*`、`/plugins/*`、`/api/*` 全都靠它透传给 DSH（见 lan-listener.ts 头注释）。
   * ★ 监听失败只警告不抛错：手机入口不可用 ≠ DSH 挂掉。
   */
  listener = createLanListener({
    enabled: machine.listener.enabled,
    plain: machine.listener.plain,
    tls: machine.listener.tls,
    target: { host: '127.0.0.1', port },
    tlsPaths: tls.paths,
    logger: { info: (message) => console.log(message), warn: (message) => console.warn(message) },
  })
  listener.start()

  // 复用 DSH 自己的 trustedHosts 配置：插件无法读取 Connection 的私有配置，
  // 因此让部署方在插件配置里显式声明（install 脚本会打印出该加什么）。
  const trustedHosts = machine.trustedHosts

  // 注入脚本：内容来自客户端插件包的构建产物；缺失时插件仍可用（只是手机浏览器页不会被注入）
  // 必须用 fileURLToPath：仓库/安装路径可能含非 ASCII 字符，URL.pathname 会返回
  // 百分号编码后的路径，existsSync 会失败——表现为 boot.js 静默消失、手机端无 shim。
  const bootScriptPath = config.bootScriptPath ?? join(dirname(fileURLToPath(import.meta.url)), 'boot.js')
  const bootScript =
    existsSync(bootScriptPath)
      ? () => {
          const source = readFileSync(bootScriptPath, 'utf8')
          return { source, sha256: createHash('sha256').update(source).digest('hex') }
        }
      : undefined

  /**
   * ★★ DSH 前端定位器（2026-09-30 修 ✗）：锚在**运行中那套 DSH** 上，不是插件自己 ✗。
   *
   * 三个锚**在这里一次取齐**、由 `resolve()` 每次现算 ✓：
   *   ① `profileContext.installAnchor`（运行中那套 DSH 的 `package.json` ✓）；
   *   ② `process.argv[1]`（正在运行的进程入口 ✓）；
   *   ③ `import.meta.url`（插件自己 —— **拷贝安装**下这条路是对的 ✓，软链下会被 ①② 抢先 ✓）。
   *
   * 传进 `createMobileHost` 的是**函数**（不是算好的路径）⇒ `getAppShell()` 每次请求现算 ✓：
   * 前端升级 / 安装位置变化都不必重启（与原先的行为一致 ✓）。
   * 日志只在**结论变化**时打一行 ✓（见 `createDistIndexResolver`），
   * 失败原因则留在 `distResolver.problem()` 上供 503 文案使用 ✓（绝不静默 ✗）。
   */
  const distResolver = createDistIndexResolver({
    installAnchor: readProfileContextInstallAnchor(ctx),
    processEntry: process.argv[1],
    moduleUrl: import.meta.url,
    logger: { log: (message) => console.log(message), warn: (message) => console.warn(message) },
  })

  const mobileHost = createMobileHost({
    config: { ...DEFAULT_CONFIG, ...config },
    store,
    identity,
    gateway,
    endpoints,
    // 回源通道要用端口做环回请求（复用插件自己的 HTTP 路由，不另写一套）
    selfPort: port,
    // 真实运行时版本（诊断字段）。**不要**再写死任何具体版本 ✗：
    // 原先是 `process.env['DSH_VERSION'] ?? '0.1.5-rc.1'`，而 DSH 从不设置
    // `DSH_VERSION`（全包 grep 命中 0 次）→ 升级后手机会永远报旧版本（见 dsh-version.ts）。
    dshVersion: resolveDshRuntimeVersion({
      dshHome,
      /**
       * ★ `exactOptionalPropertyTypes: true` ✗ —— 所以**不能**直接把 `string | undefined`
       *   赋给可选属性 ✓（我第一次就是这么写的，`npm run build` 当场报 TS2379 ✓）。
       *   按本项目既有写法用**条件展开** ✓：没这个字段时就不放这个键 ✓。
       */
      ...((process as unknown as { resourcesPath?: string }).resourcesPath === undefined
        ? {}
        : { resourcesPath: (process as unknown as { resourcesPath?: string }).resourcesPath as string }),
      /**
       * ★★ 把宿主进程的 Electron resources 目录传进去 ✗ ——
       *   于是版本探测**先**读正在跑的那个 app 里那份 `dsh/package.json` ✓
       *   （2026-10-04：用户报"明明是 0.2.0 桌面版却显示 0.1.5-rc.2"✓ ——
       *    因为原先那条路在桌面版里**根本解析不到** ✓，读到的是进程启动时的旧值 ✓；
       *    重启之后还会退化成 `unknown` ✗。见 `dsh-version.ts` 的模块说明 ✓。）
       * ★ 非 Electron 环境（独立服务 / 本仓库跑测试 ✓）里它是 undefined ✓ ⇒ 自动跳过 ✓。
       */
    }),
    ...(bootScript === undefined ? {} : { bootScript }),
    trustedHosts,
    ...(machine.phoneBaseUrl === undefined ? {} : { phoneBaseUrl: machine.phoneBaseUrl }),
    // 传**函数**而不是路径：前端升级 / 安装位置变化不必重启插件（与原先一致 ✓）
    distIndex: () => distResolver.resolve(),
    renderIndex: (html) => ctx.webServer.renderIndex(html),
    // 自签证书管理器：manifest / 自检 / `/mobile/trust.crt` 都从它取（见上面的长注释）
    tls,
    // 局域网监听器（C1）：自检的 `listener` 段读它（默认关闭时是"未启用"，不是故障）
    listener,
    ...(config.capabilityCeiling === undefined
      ? {}
      : {
          capabilityCeiling: {
            fsRead: config.capabilityCeiling.fsRead ?? true,
            fsWrite: config.capabilityCeiling.fsWrite ?? false,
            fsShell: config.capabilityCeiling.fsShell ?? false,
            phoneFs: config.capabilityCeiling.phoneFs ?? false,
            phoneControl: config.capabilityCeiling.phoneControl ?? false,
          },
        }),
  })

  /**
   * 把端侧通道暴露给 agent：注册 `phone_notify` 工具。
   *
   * ## 为什么用动态 import + try/catch
   *
   * 注册工具是**新增的可选能力**，而插件加载失败会**弄坏一切**（手机整条链路都靠它）。
   * 两者的代价完全不对等，所以这里刻意做到"最坏情况只是少一个工具"：
   *   · 动态 import：即便某个环境解析不到 `@deepseek-ai/dsh-tools`，也只是一个 rejected promise；
   *   · try/catch：`ctx.tools` 不存在、或工具表不接受这次注册，都只打一行警告；
   *   · 工具内部**只调 `mobileHost.deviceCall`**，不重复判定"发给谁/能力是否启用"。
   *
   * ## agent 侧看到什么
   *
   * 工具名 `phone_notify`：给手机发一条系统通知（手机需先在端侧通道里允许 `notify`）。
   * 失败时把**原因**返回给 agent（而不是抛错），让 agent 能自己决定要不要换方式。
   */
  // 模块名用**变量**拼出来：`@deepseek-ai/dsh-tools` 是我们这个包之外的依赖，
  // 编译期解析不到它的类型（仓库里没有它），但**运行期能解析**（实测：插件安装位置
  // 能上溯到 DSH 的全局 node_modules）。写成变量既避免 tsc 报"找不到模块"，
  // 也如实表达了"这是个运行期才确定的依赖"——比 @ts-ignore 干净。
  const TOOLS_MODULE = '@deepseek-ai/dsh-tools'
  /**
   * 审批推送到手机（M2 的核心）。
   *
   * ## 为什么它值得做
   *
   * agent 需要你确认时，原先**只有坐在电脑前才知道** —— 你一离开，它就卡在那里等。
   * 而"电脑 → 手机"的通道我已经建好并验证过了（`show` / `notify` + agent 工具），
   * 所以这件事不需要新协议，只需要**在审批发生时往手机推一条**。
   *
   * ## 事件从哪来
   *
   * DSH 的审批在 `dsh-user-approval` 里发出：`session.append('approval/asked', { id, toolName, callId?, reason? })`
   * —— 它挂在**会话事件**上（不是普通的 Cordis 事件）。所以这里**两条订阅通道都试**
   * （`ctx.on(...)` 与 `ctx.events.on(...)`），并且把"实际用上了哪条"记进日志：
   * 不同 DSH 版本可能只提供其中一条，静默不生效是最难查的形态（本项目吃过多次亏）。
   *
   * ## 三条纪律
   *
   * 1. **绝不影响审批本身**：整段包在 try/catch 里，推送失败只是少一条通知；
   * 2. **失败要看得见**：注册成功/失败都打一行（`[dsh-mobile]` 前缀）；
   * 3. **没开通知就退成横幅**：先试 `notify`（能在后台提醒 ✓），
   *    用户没启用就退 `show`（页面可见时也能看到 ✓）；两个都没开就安静地不做 ✗。
   */
  function installApprovalPush(): void {
    const notify = (payload: unknown): void => {
      try {
        const record = (payload ?? {}) as { toolName?: unknown; reason?: unknown; title?: unknown; summary?: unknown }
        const tool = String(record.toolName ?? record.title ?? '').trim()
        const reason = String(record.reason ?? record.summary ?? '').trim()
        const text =
          '电脑上的 agent 需要你确认' + (tool.length > 0 ? '：' + tool : '') + (reason.length > 0 ? '（' + reason.slice(0, 120) + '）' : '')
        // ★ 先**落审计**再推送：这样"钩子到底有没有被触发"有据可查 ✓
        //   （原先只打 console —— 而 DSH 可能跑在后台终端里，用户看不到 ✗；
        //    于是"审批没通知"到底是"钩子没响"还是"通知发不出"完全分不清 ✗）
        try {
          mobileHost.recordDiagnostic('approval-push', text.slice(0, 80))
        } catch (error) {
          void error
        }
        // 先通知（后台也能提醒），没启用就退成页面横幅
        const first = mobileHost.deviceCall('notify', text)
        if (!first.ok) mobileHost.deviceCall('show', text)
      } catch (error) {
        console.warn('[dsh-mobile] 审批推送失败（不影响审批本身）：', error)
      }
    }

    const channels: Array<[string, (() => void) | undefined]> = []
    try {
      const anyCtx = ctx as unknown as {
        on?: (name: string, handler: (...args: unknown[]) => void) => unknown
        events?: { on?: (name: string, handler: (...args: unknown[]) => void) => unknown }
      }
      if (typeof anyCtx.on === 'function') {
        // ★ 正确的观察方式是 `session/event`（DSH 自己的宿主插件都这么写：
        //   dsh-agent-instructions / dsh-agent-loop / dsh-agent-presets ✓✓），
        //   而不是我原先猜的 `approval/asked` ✗ —— Cordis 对未知事件名**静默接受**，
        //   所以"注册成功"却永不触发（真实现象：手机上永远收不到审批通知 ✗）。
        //   审批在会话日志里是 `approval/asked` ✓，于是这里按事件类型过滤 ✓。
        const onSessionEvent = (_session: unknown, event: unknown): void => {
          const record = (event ?? {}) as { type?: unknown; data?: { toolName?: unknown; reason?: unknown } }
          const kind = String(record.type ?? '')
          // ★ 先把**每一个**会话事件记进审计（截断）—— 这一步是为了分开两种可能：
          //   "审批根本没发生" ✗ 与 "事件到了但我过滤的条件不对" ✗。
          //   只看"有没有推送"，这两种在外部完全一样（都是"手机没收到"）✗。
          try {
            mobileHost.recordDiagnostic('session-event', kind.slice(0, 60) || '(no-type)')
          } catch (error) {
            void error
          }
          if (kind !== 'approval/asked') return
          notify(record.data ?? {})
        }
        anyCtx.on('session/event', onSessionEvent)
        channels.push(['ctx.on(session/event)', undefined])
      }
      // 兼容另外两个可能的事件名（不同 DSH 版本暴露的名字不一样；
      // 多订一个的代价只是"可能多推一条"，而漏订的代价是"功能完全不工作" ✗）
      if (typeof anyCtx.on === 'function') {
        anyCtx.on('approval/asked', notify)
        anyCtx.on('approval/request', notify)
      }
    } catch (error) {
      console.warn('[dsh-mobile] 审批推送订阅失败（其余功能不受影响）：', error)
    }
    if (channels.length === 0) {
      console.warn('[dsh-mobile] 审批推送**未挂载**：当前 DSH 未提供可用的会话事件订阅通道')
    } else {
      console.log(`[dsh-mobile] 审批推送已挂载（通道：${channels.map(([name]) => name).join(' + ')}）`)
    }
  }

  void import(TOOLS_MODULE)
    .then((module) => {
      const defineTool = (module as { defineTool?: (options: unknown) => unknown }).defineTool
      // ★ 用 `ctx.get('tools')` 而**不是** `ctx.tools`，也不往 `inject` 里加它：
      //   `ctx.tools` 需要先在 `inject` 里声明；而声明一个"某个 DSH 版本可能没有"的服务，
      //   会让插件在那种环境下**根本无法激活**——那比"少一个工具"严重得多。
      //   `ctx.get()` 取不到就返回 undefined，失败**留在原地**（仍被下面的 catch 兜住）。
      const tools = (ctx as unknown as { get?: (name: string) => { register?: (tool: unknown) => void } | undefined }).get?.(
        'tools',
      )
      if (typeof defineTool !== 'function' || tools?.register === undefined) {
        console.warn('[dsh-mobile] 当前 DSH 未提供工具注册能力，phone_notify 未注册（其余功能不受影响）')
        mobileHost.setAgentToolStatus('skipped')
        return
      }
      tools.register(
        defineTool({
          name: 'phone_notify',
          description:
            '给已配对的手机发一条系统通知（手机需先在 DSH 移动端允许 notify 能力）。' +
            '适用于需要用户离开电脑时也能看到的提醒；失败会返回原因。',
          parameters: {
            text: { type: 'string', required: true, description: '通知正文（会显示在手机通知栏）' },
          },
          output: {
            schema: {
              type: 'object',
              additionalProperties: false,
              properties: {
                ok: { type: 'boolean', required: true },
                id: { type: 'string' },
                reason: { type: 'string' },
              },
            },
            render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value) }],
          },
          async execute(args: { text?: string }) {
            const outcome = mobileHost.deviceCall('notify', String(args?.text ?? ''))
            return outcome.ok ? { ok: true, id: outcome.id } : { ok: false, reason: outcome.reason }
          },
        }),
      )
      // ★ 通用端侧动作工具。`phone_notify` 保留（文档与验收都在用它），
      //   但它只能发通知；而端侧通道现在有 5 个能力（提醒 / 通知 / 剪贴板 / 震动 / 打开链接），
      //   一个一个做成工具会让工具表迅速膨胀，所以给一个带 `capability` 的通用入口。
      //   能力名与白名单由宿主 `deviceCall` 校验，未知能力会**带着可用清单**返回原因 ✓。
      tools.register(
        defineTool({
          name: 'phone_send',
          description:
            '对已配对的手机执行一个端侧动作。capability 取值：' +
            'show=页面横幅（不需要权限）、notify=系统通知（需通知权限）、' +
            'clipboard=把 text 放进手机剪贴板、vibrate=让手机震动（text 是毫秒数）、' +
            'open=把 text 当作链接推到手机上（用户在横幅里点一下才打开，浏览器不允许无手势开新窗口）。' +
            '手机需先在移动端逐项允许该能力，否则返回原因而不是抛错。',
          parameters: {
            capability: { type: 'string', required: true, description: 'show | notify | clipboard | vibrate | open' },
            text: { type: 'string', required: true, description: '内容：文本 / 毫秒数 / 链接' },
          },
          output: {
            schema: {
              type: 'object',
              additionalProperties: false,
              properties: {
                ok: { type: 'boolean', required: true },
                id: { type: 'string' },
                reason: { type: 'string' },
              },
            },
            render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value) }],
          },
          async execute(args: { capability?: string; text?: string }) {
            const outcome = mobileHost.deviceCall(String(args?.capability ?? ''), String(args?.text ?? ''))
            return outcome.ok ? { ok: true, id: outcome.id } : { ok: false, reason: outcome.reason }
          },
        }),
      )
      mobileHost.setAgentToolStatus('registered')
      console.log('[dsh-mobile] 已注册 agent 工具：phone_notify / phone_send（端侧动作，5 个能力）')
    })
    .catch((error: unknown) => {
      console.warn('[dsh-mobile] 注册 phone_notify 失败（其余功能不受影响）：', error)
      mobileHost.setAgentToolStatus('failed')
    })

  // 审批推送到手机（与工具注册无关，独立挂载；失败只影响这一条通知）
  installApprovalPush()

  // 1) HTTP 路由（/mobile/*）。用前缀路由一次接管，插件内部再细分，
  //    避免与 DSH 自身的精确路由争夺 /api 之类的关键路径。
  const disposeHttp = ctx.webServer.register({
    kind: 'prefix',
    path: '/mobile',
    handler: (req, res) => {
      if (!mobileHost.handleHttp(req, res)) {
        res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ code: 'mobile/not-found', message: `unknown mobile path ${req.url ?? ''}` }))
      }
    },
  })

  // 2) WebSocket 升级路由（精确路径由插件内部判定）
  const disposeUpgrade = ctx.webServer.registerUpgrade({
    path: '/mobile/ws',
    handler: (req, socket) => mobileHost.handleUpgrade(req, socket),
  })

  // 3) 往 index.html 注入 shim：必须**先于**应用 bundle 执行，
  //    这样 __DSH_TRANSPORT__ / __DSH_MOBILE__ 才能在 dsh-client-connection 读取之前就位。
  const shimTag = '<script src="/mobile/boot.js" data-dsh-mobile="1"></script>'
  const disposeInject =
    config.injectShim === false
      ? undefined
      : ctx.webServer.tapIndex((html) => html.replace('<head>', `<head>\n    ${shimTag}`))

  /**
   * 4) 手机端应用外壳：挂在**本插件自己的前缀** `/mobile/app` 下。
   *
   * 为什么必须由插件来服务：DSH 的 `/` 要求 launch token 或绑定 authority 的 cookie，
   * 手机两者都没有 → 401 → "配对成功但界面进不去"。
   * DSH 的鉴权只挡这一个壳页面：`/assets/*`、`/plugins/*` 是静态 fallback（无鉴权），
   * 业务调用走本插件隧道的设备密钥闸门。
   *
   * ## 为什么绝不能挂在 `/` 上（真实事故）
   *
   * 早期版本注册的是 `{ kind: 'prefix', path: '/' }`，并在非移动标记时自行返回 401，
   * 注释里写"交回 DSH"——**这个意图在 API 上无法表达**：
   * `dsh-host-webserver` 的分发是「最长前缀胜出 + 命中即 return」，`register()` 没有 `next()`，
   * 被命中的 handler 独占响应生命周期。而 `dsh web` 打印的**唯一认证入口 URL** 其 pathname
   * 恰好就是 `/`（`authenticatedUrl()` 强制 `pathname='/'` + `?token=`），
   * 于是 token 兑换（`authorizeIndex`，位于 frontend-static 的 fallback 里）**永不执行**，
   * cookie 永远铸造不出来 → **任何浏览器、任何 authority 打开都是 401 死循环**，
   * 连提示语让你"reopen"的那条 URL 自己都打不开。
   *
   * 更糟的是我当时复用了与核心**逐字相同**的 401 文案，导致"谁发的 401"无法从响应区分，
   * 把排查方向引向了凭证与重装。
   *
   * 因此本路由必须满足两条红线：
   *  - 路径落在 `/mobile` 前缀内（最长前缀胜出，天然不碰任何核心路由）；
   *  - **不改变 pathname `/` 的路由归属**（由 scripts/e2e-pairing.mjs 的不变量断言守住）。
   */
  let shellCache: { etag: string; body: Buffer } | undefined
  const disposeShell = ctx.webServer.register({
    kind: 'prefix',
    path: '/mobile/app',
    handler: (req, res) => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
      // 路径本身就是标记；仍接受 ?mobile=1 作为兼容（旧链接/已收藏地址不至于失效）
      if (url.pathname !== '/mobile/app' && url.pathname !== '/mobile/app/') {
        res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ code: 'mobile/not-found', message: `unknown mobile path ${req.url ?? ''}` }))
        return
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { allow: 'GET, HEAD' })
        res.end()
        return
      }
      const shell = mobileHost.getAppShell()
      if (shell === undefined) {
        res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
        /**
         * ★★ 文案里**必须带上原因** ✗（2026-09-30 修）：原先只有一句"外壳不可用"，
         * 于是真机上（软链安装 ⇒ 前端定位必然失败 ✗）用户与日志**都没有任何线索** ✗。
         * 原因由 `distResolver` 记着（试了哪几条路、各自栽在哪 ✓，见 `createDistIndexResolver`）。
         */
        res.end(appShellUnavailableBody(distResolver.problem()))
        return
      }
      // 按 ETag 缓存渲染结果：renderIndex 会跑全部注入，没必要每个请求都做一遍
      if (shellCache?.etag !== shell.etag) {
        shellCache = { etag: shell.etag, body: Buffer.from(shell.html, 'utf8') }
      }
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        // no-store：外壳里带着本次启动的启动参数与注入，缓存住会让升级后的前端拿不到新资源
        'cache-control': 'no-store, must-revalidate',
        etag: shell.etag,
        'x-content-type-options': 'nosniff',
        // 自带可区分的标记：万一将来这里还要发错误码，也能一眼看出是谁发的
        'x-dsh-mobile': 'app-shell',
      })
      res.end(req.method === 'HEAD' ? undefined : shellCache.body)
    },
  })

  /**
   * 5) ★★ 本机接入配置：`GET /mobile/setup`（读）/ `POST /mobile/setup`（写）。
   *
   * ## 为什么需要它（官方插件管理那条路的最后一块拼图）
   *
   * `dsh plugin --profile web add 'github:…#path:/packages/host'` 只给**插件行**，
   * 不给**机器专属配置** ✓（局域网 IP、端口、`phoneBaseUrl` 每台机器都不一样 ✓）——
   * 于是装完 `listener.enabled=false`（默认 ✓）⇒ **手机连不上** ✗。
   * 自研安装器 `scripts/install-host-plugin.mjs` 能自动推导并写入，但**它在仓库里** ✗：
   * 一个纯走官方安装的用户（电脑上没有仓库）跑不了它 ✗。
   *
   * ⇒ 界面放在**电脑上的 DSH 页面**里 ✓，不是手机 ✓ ——
   *   手机在配对之前**根本连不上** ✗（监听默认关着 ⇒ 手机没有入口 ✗，是鸡生蛋问题 ✓），
   *   而电脑上的 DSH 页面是**本地**的 ✓ ⇒ 不需要监听 ✓，那条路本来就是通的 ✓。
   *
   * ## 闸门（★ 安全，别省）
   *
   * 这条路由**能改宿主配置** ✗ ⇒ 只允许**本机**访问 ✓：
   * 判据就是 `index.ts` 里 `POST /mobile/device/call` 那道闸用的**同一个**
   * `isLoopbackRequest`（看 socket 与 `x-forwarded-for` ✓）—— 这里只是把它传进去，
   * **不自创第二套** ✗（处理器在 `setup-config.ts`，见那里的注释）。
   *
   * ## 路由归属
   *
   * `dsh-host-webserver` 的分发是「exact 命中 → 最长前缀胜出 → 命中即 return」，
   * 所以这条 `/mobile/setup` 比本插件那条 `/mobile` 前缀更长 ⇒ 只有这一条路径会被它接走 ✓，
   * 其余 `/mobile/*` 一字不动 ✓。
   */
  /**
   * ★★ 本次运行的是**哪个 profile** —— 必须**显式**取到，绝不猜（2026-09-30 修 ✗）。
   *
   * ## 为什么不能靠"从插件自己的模块路径反推"
   *
   * 软链安装（pnpm 的 `link:`；桌面 UI 装**本地路径**必然建软链 ✓）下，插件的真实路径是
   * **仓库**（`…/dsh-mobile/packages/host/lib/cordis.js` ✓）—— 路径里没有 `profiles/<名字>` ✗
   * ⇒ 反推必然失败。旧实现此时**静默退回 `web`** ✗，而 `web` 通常正是用户**日常在用**的那套
   * 配置 ✗ ⇒ 桌面版（profile = `desktop`）页面上点一下"保存"，改的是另一套配置，**不报错** ✗。
   * 真机实测就是这个症状：`/mobile/setup/page` → 200 ✓，而 `profilePath` 指向 `profiles/web/…` ✗。
   *
   * ## 名字从哪儿来（先读现成的，不自创 API ✗）
   *
   * DSH 把当前 profile 作为服务 `profileContext` 挂上来（`dsh-app-boot` 的
   * `boot()` 里 `prepare(ctx)` 先 `provide('profileContext', …)`、**再**挂载插件树 ✓ ⇒
   * 本插件 `apply()` 跑的时候它一定已经在 ✓），形状是
   * `{ name, dir, patchPath, installAnchor, … }` ✓ —— **DSH 自己的 bundle patch 就是这么用的**：
   * `dsh-web-app/cordis.patch.yml` 里 `disabled: !!js "ctx.get('profileContext')?.name !== 'desktop'"` ✓。
   * 所以这里用**同一个**取值方式 ✓，不新增任何 DSH 侧 API ✗。
   *
   * ## 优先级
   *
   * `profileContext.name`（**运行时真相** ✓）> `config.profile`（插件配置里的显式覆盖 ✓，
   * 老 DSH 没有 `profileContext` 时仍可用 ✓）> 从模块地址反推（老布局兜底 ✓）。
   * 三者都没有 ⇒ `resolveProfilePatchPath` 抛错 ✓（下面接住，明确报错、绝不猜 ✗）。
   */
  const contextProfile = readProfileContextName(ctx)
  if (config.profile !== undefined && contextProfile !== undefined && config.profile !== contextProfile) {
    // ★ 不一致也**不静默** ✓：以运行中的为准（配置里那个多半是上一次留下的 ✗）。
    console.warn(
      `[mobile-host] 配置里的 profile='${config.profile}' 与本次运行的 profile='${contextProfile}' 不一致 ⇒ ` +
        `以**运行中的**为准（${config.profile} 大概率是上次留下的，用它就会改掉另一套配置）`,
    )
  }
  /** profile 的 `cordis.patch.yml`；`undefined` = 认不出来（**明确报错**，见下面的注册处 ✓）。 */
  let setupPatchFile: string | undefined
  let setupPatchProblem: string | undefined
  try {
    setupPatchFile = resolveProfilePatchPath({
      dshHome,
      profile: contextProfile ?? config.profile,
      moduleUrl: import.meta.url,
    })
  } catch (error) {
    setupPatchProblem = error instanceof Error ? error.message : String(error)
    console.warn(`[mobile-host] ★ 认不出这是哪个 profile：${setupPatchProblem}`)
  }

  const disposeSetup = ctx.webServer.register({
    kind: 'prefix',
    path: SETUP_PATH,
    handler: (req, res) => {
      /**
       * ★ 先过插件自己那道**信任栅栏**（Host / Origin / `sec-fetch-site`）——
       *   与 `/mobile/*` 其它路由**同一道**（`index.ts` 的 `handleHttp` 里那句
       *   "栅栏必须在任何路由分发之前"）✓。`/mobile/setup` 不是它认识的路由 ⇒
       *   栅栏放行后它返回 `false`，控制权落到下面 ✓；不放行时它已经替我们把 403 发了 ✓。
       *
       * ⚠️ 为什么这道栅栏在这条路由上**必须有** ✗：我们的本机闸门看的是 **socket**
       *   （`isLoopbackRequest` ✓），而**任何一个网页**都能让浏览器去请求
       *   `http://127.0.0.1:3080/mobile/setup` —— 那时 socket 就是回环 ✓。
       *   拦住它的是栅栏里的 "Origin 必须与 Host 同源" 那条 ✓
       *   （恶意页面的 Origin 是它自己的域名 ⇒ 403 ✓），以及 Host 判据对 DNS rebinding 的拦截 ✓。
       *   少了它，随便一个网站就能改这台机器的宿主配置 ✗。
       */
      if (mobileHost.handleHttp(req, res)) return
      handleSetupRequest(req, res, {
        /**
         * ★★ 这两项一起给 ✓：路径**就是那个 profile 的** ✓；认不出来时
         *   `patchFile === undefined` ⇔ 处理器返回 500 + `patchFileProblem` 那句人话 ✗
         *   —— 它**不会**退到某个默认 profile 去读写 ✓（本次修的就是那个 ✗）。
         */
        patchFile: setupPatchFile,
        patchFileProblem: setupPatchProblem,
        // ★ 仅本机：全项目只有这一个判据（index.ts 的 isLoopbackRequest）
        isLocalRequest: isLoopbackRequest,
        io: {
          log: (message) => console.log(`[mobile-host] ${message}`),
          warn: (message) => console.warn(`[mobile-host] 警告：${message}`),
        },
      })
    },
  })

  ctx.effect(() => () => {
    disposeHttp()
    disposeUpgrade()
    disposeInject?.()
    disposeShell()
    disposeSetup()
    /**
     * ★ 监听器与插件同生命周期（C1-2 的落点）：DSH 停 ⇒ 手机入口停，
     * 不会再像外置 `lan-proxy.mjs` 那样留下占着端口的孤儿进程。
     * 挂进的是**现有那个** `ctx.effect`（不是新加一个）——多一个 effect 就多一处漏清理。
     */
    listener?.dispose()
    // Codex 宿主桥：懒启动过才需要收；内部会先把待裁决的审批按"取消"应答掉，
    // 不留一个悬着的 app-server 子进程，也不留一个永远等不到的审批 ✓。
    mobileHost.stopCodexBridge()
  })

  ctx.logger?.info?.(
    `[mobile-host] 已启用：设备管理 GET /mobile/devices，配对码 POST /mobile/pair/code，` +
      `本机接入配置 GET/POST ${SETUP_PATH}（仅 loopback，写在 ` +
      `${setupPatchFile ?? '（★ 认不出这是哪个 profile ⇒ 这条路由会明确报错，不会猜一个默认 profile）'}），` +
      `配置页 GET ${SETUP_PAGE_PATH}，` +
      `隧道 ${'/mobile/ws'}，身份指纹见 /mobile/manifest（协议版本 1）`,
  )

  /**
   * 6) ★★ 启动日志里那一行"还没配置"的提示（用户点一下就能去配，不用敲 curl ✓）。
   *
   * ## 什么算"没配置"
   *
   * 就是 `readCurrentConfig(setupPatchFile) === null` ✓ —— 与 `GET /mobile/setup` 的
   * `configured` **同一个判据** ✓（profile 里**没有**我们写的机器专属配置块 ✓）。
   * ⚠️ 刻意**不**看 `listener.enabled` ✗：外置 `lan-proxy.mjs` 那类部署本来就是
   *   `enabled=false` 而手机照样能用 ✓ ⇒ 那也算"配过了"，再提示就是刷屏 ✗。
   *
   * ## 为什么打 console.log 而不是 ctx.logger.info ✗
   *
   * 本文件里其它"给人看的下一步提示"（TLS 就绪 / agent 工具已注册 ✓）都走 console.log，
   * 而终端会把 URL 变成**可点链接** ✓ —— 这正是这一行的用途 ✓。
   *
   * ⚠️ 认不出 profile 时（`setupPatchFile === undefined`）**不打**这一行 ✗：
   *   没有 profile 就没有可写的文件，让用户去点一张必然 500 的页面是误导 ✓
   *   （上面已经打过一行 console.warn 把原因说清了 ✓ —— 不静默 ✓）。
   */
  if (setupPatchFile !== undefined && readCurrentConfig(setupPatchFile) === null) {
    console.log(setupStartupHint(readWebServerPort(ctx.webServer)))
  }
}
