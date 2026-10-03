/**
 * 独立服务：不用 DSH，直接把手机接进 Codex。
 *
 * ## 它和 DSH 插件的关系
 *
 * 两者用的是**同一套宿主核心**（`createMobileHost`：配对页、设备库、能力位、
 * E2E 隧道、`/mobile/codex` 页面与 `mobile/codex/*` 端点），差别只在装配：
 *
 *   · DSH 插件：路由挂在 DSH 的 webServer 上，业务调用转发给 DSH 的 Typert 网关；
 *   · 独立服务：自己起一个 loopback HTTP 服务当"内部目标"，再由
 *     `createLanListener` 把它暴露到局域网（明文 + TLS），**没有任何 DSH 依赖**。
 *
 * ## 为什么默认要"从 DSH 插件目录搬一份身份与设备库"
 *
 * 手机端钉的是**宿主指纹**、存的是**自己的设备私钥**，宿主这边认的是
 * `host-identity.json`（签名私钥）与 `devices.json`（已登记设备）。
 * 只要这两份东西是同一份，**手机不需要重新配对**；
 * 顺手把 `tls/` 也搬过来，则手机上装过的自签 CA 也继续有效 ✓。
 * 拷贝（而不是共用）是为了避免两个进程同时写同一份 `devices.json` ✓。
 */

import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { createServer, type Server, type ServerResponse } from 'node:http'
import type { IncomingMessage } from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Duplex } from 'node:stream'

import { createMobileHost, DEFAULT_CONFIG, type MobileHostService, type RemoteGateway } from '../index.ts'
import { DeviceStore } from '../devices.ts'
import { loadOrCreateHostIdentity } from '../cordis.ts'
import { createLanListener, type LanListener } from '../lan-listener.ts'
import { detectLanIp, isAddressPresent, listLanCandidates } from '../lan.ts'
import { createTlsManager, type TlsManager } from '../tls-cert.ts'

/** 手机入口路径：独立服务没有 DSH 外壳，直接进 Codex 页。 */
export const STANDALONE_ENTRY_PATH = '/mobile/codex'

/** 默认监听（刻意避开 DSH 插件的 3081/3443，两边可以同时跑）。 */
export const DEFAULT_STANDALONE_PLAIN = '0.0.0.0:3082'
export const DEFAULT_STANDALONE_TLS = '0.0.0.0:3444'

/** 默认数据目录（身份 / 设备库 / 审计 / 自签证书）。 */
export function defaultStandaloneDataDir(home: string = homedir()): string {
  return join(home, '.codex-mobile')
}

export interface StandaloneHostOptions {
  readonly dataDir: string
  readonly plain?: string
  readonly tls?: string
  /** 是否启用明文监听（默认 true；关掉就只留 HTTPS）。 */
  readonly plainEnabled?: boolean
  readonly hostName?: string
  /** DSH 插件的数据目录；存在且目标目录为空时会**拷贝**过来（身份/设备/证书不丢）。 */
  readonly migrateFrom?: string
  readonly logger?: { readonly log: (message: string) => void; readonly warn: (message: string) => void }
  /** Codex CLI / CODEX_HOME（透传给 CodexBridge；省略时用其默认值）。 */
  readonly codexCli?: string
  readonly codexArgs?: readonly string[]
  readonly codexHome?: string
}

export interface StandaloneHost {
  readonly service: MobileHostService
  readonly dataDir: string
  readonly internalPort: number
  readonly plainPort: number | undefined
  readonly tlsPort: number | undefined
  /** 手机应当访问的地址（HTTPS 优先，带上入口路径）。 */
  phoneUrls(): string[]
  /** 电脑上打开配对页的地址（loopback 明文）。 */
  desktopUrls(): string[]
  /** 迁移是否真的发生了（供 CLI 打印）。 */
  readonly migrated: boolean
  close(): Promise<void>
}

/** 从 DSH 插件目录搬一份身份/设备/证书（只在目标还没有身份时做，幂等）。 */
function migrateDataDirectory(dataDir: string, source: string | undefined, log: (m: string) => void): boolean {
  if (source === undefined || source.length === 0) return false
  if (existsSync(join(dataDir, 'host-identity.json'))) return false
  if (!existsSync(join(source, 'host-identity.json'))) return false
  mkdirSync(dataDir, { recursive: true })
  for (const name of ['host-identity.json', 'devices.json', 'audit.json', 'tls']) {
    const from = join(source, name)
    if (!existsSync(from)) continue
    cpSync(from, join(dataDir, name), { recursive: true })
  }
  log(`已从 ${source} 拷贝身份/设备库/证书到 ${dataDir}（手机无需重新配对）`)
  return true
}

/** 从 `0.0.0.0:3082` 这样的配置串里取端口（绑定的即时状态可能还没就绪，用它兜底）。 */
function portOfAddress(address: string | undefined): number | undefined {
  if (address === undefined) return undefined
  const index = address.lastIndexOf(':')
  if (index < 0) return undefined
  const port = Number(address.slice(index + 1))
  return Number.isInteger(port) && port > 0 ? port : undefined
}

/**
 * 启动独立服务。
 *
 * 返回之后：局域网上的明文/TLS 两个监听已经就绪，`phoneUrls()` 可直接给用户。
 */
export async function startStandaloneHost(options: StandaloneHostOptions): Promise<StandaloneHost> {
  const log = options.logger?.log ?? ((message: string) => console.log(message))
  const warn = options.logger?.warn ?? ((message: string) => console.warn(message))
  const dataDir = options.dataDir
  mkdirSync(dataDir, { recursive: true })
  const migrated = migrateDataDirectory(dataDir, options.migrateFrom, log)

  /**
   * ★ 声明必须在 `createTlsManager` **之前**：`tls.ensure()` 会**同步**调用 `onResult`，
   *   而回调里要 `listener?.refreshTls()`。写在后边就是 TDZ ——
   *   "Cannot access 'listener' before initialization"（cordis.ts 里记过同款坑 ✓）。
   */
  let listener: LanListener | undefined
  const tls: TlsManager = createTlsManager({
    directory: join(dataDir, 'tls'),
    addresses: () => listLanCandidates().map((candidate) => candidate.address),
    onResult: (status) => {
      if (status.ok) log(`自签 TLS 就绪：CA=${status.caFingerprint ?? '?'}${status.createdCa ? '（新建）' : '（复用）'} 目录=${status.directory}`)
      else warn(`自签 TLS 不可用：${status.error ?? '未知原因'}（目录：${status.directory}）`)
      const reload = listener?.refreshTls()
      if (reload?.error !== undefined) warn(`TLS 证书热更新失败：${reload.error}`)
    },
  })
  tls.ensure()

  const store = new DeviceStore({ directory: dataDir })
  const identity = loadOrCreateHostIdentity({
    directory: dataDir,
    ...(options.hostName === undefined ? {} : { hostName: options.hostName }),
  })

  // ── 内部 loopback HTTP 服务：真正的路由都在这里，局域网监听只是它的门面 ──
  let handleHttp: ((req: IncomingMessage, res: ServerResponse) => boolean) | undefined
  let handleUpgrade: ((req: IncomingMessage, socket: Duplex) => void) | undefined
  const server: Server = createServer((req, res) => {
    if (handleHttp?.(req, res) === true) return
    res.writeHead(404, { 'content-type': 'application/json; charset=utf-8', 'x-codex-host': 'standalone' })
    res.end(JSON.stringify({ code: 'codex-host/not-found', message: '这个独立服务只提供 /mobile/* 与 /mobile/codex' }))
  })
  server.on('upgrade', (req, socket) => {
    if (handleUpgrade === undefined) {
      socket.destroy()
      return
    }
    handleUpgrade(req, socket)
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('内部监听没有拿到端口')
  const internalPort = address.port

  // ── 局域网暴露 ─────────────────────────────────────────────────────
  listener = createLanListener({
    enabled: true,
    ...(options.plainEnabled === false ? {} : { plain: options.plain ?? DEFAULT_STANDALONE_PLAIN }),
    tls: options.tls ?? DEFAULT_STANDALONE_TLS,
    target: { host: '127.0.0.1', port: internalPort },
    tlsPaths: tls.paths,
    logger: { info: (message) => log(message), warn: (message) => warn(message) },
  })

  /** 从监听器现状里取某类绑定的端口（没有/没在听 ⇒ undefined）。 */
  const boundPort = (kind: 'plain' | 'tls'): number | undefined =>
    listener?.status().bindings.find((binding) => binding.kind === kind && binding.listening)?.port

  const lanIp = detectLanIp()
  let cachedLanIp = lanIp
  /**
   * 端口优先取**真实绑定**结果；绑定还没写进状态时退回配置串里那个端口。
   * 为什么必须有兜底：`listener.start()` 之后的头几十毫秒里，status 里可能还没有 binding，
   * 于是打印出来的手机地址会**丢掉端口**（`https://10.34.255.229/mobile/codex` ✗）——
   * 用户照着填必然连不上。
   */
  const tlsPort = boundPort('tls') ?? portOfAddress(options.tls ?? DEFAULT_STANDALONE_TLS)
  const plainPort =
    options.plainEnabled === false ? undefined : boundPort('plain') ?? portOfAddress(options.plain ?? DEFAULT_STANDALONE_PLAIN)
  /**
   * 配对页上"手机地址"那一行直接读 `manifest.phoneBaseUrl`（见 pairing-page 的说明），
   * 不配就会显示"（宿主未配置手机地址…）"✗ —— 独立服务必须自己算出来：
   * 就是局域网 IP + HTTPS 端口（手机侧还必须能从它推出 `wss://…/mobile/ws` ✓）。
   */
  const phoneBaseUrl =
    tlsPort === undefined ? undefined : `https://${cachedLanIp ?? detectLanIp() ?? '127.0.0.1'}:${tlsPort}`
  const endpoints = (): string[] => {
    if (cachedLanIp !== undefined && !isAddressPresent(cachedLanIp)) {
      const next = detectLanIp()
      if (next !== undefined && next !== cachedLanIp) {
        log(`局域网地址已变化：${cachedLanIp} → ${next}`)
        cachedLanIp = next
      }
    }
    if (cachedLanIp === undefined) cachedLanIp = detectLanIp()
    const host = cachedLanIp ?? '127.0.0.1'
    const list: string[] = []
    if (tlsPort !== undefined) list.push(`https://${host}:${tlsPort}`)
    if (plainPort !== undefined) list.push(`http://${host}:${plainPort}`)
    return list.length > 0 ? list : [`https://${host}`]
  }

  /**
   * 独立服务没有 DSH 网关：任何非 `mobile/*` 端点都应当明确失败，
   * 而不是静默返回空（"点了没反应"是本项目零容忍的失败形态）。
   */
  const gateway: RemoteGateway = {
    async invoke(request) {
      throw Object.assign(new Error(`独立服务没有 DSH 网关（${request.namespace}/${request.method}）`), { code: 'codex-host/no-gateway' })
    },
    async stream(request) {
      throw Object.assign(new Error(`独立服务没有 DSH 网关（${request.namespace}/${request.method}）`), { code: 'codex-host/no-gateway' })
    },
  }

  /**
   * boot.js 的定位（★ 2026-09-30 实测踩到：从**源码**直接跑时它不在旁边，
   * 于是 `/mobile/boot.js` 404 ⇒ 页面上 `__DSH_MOBILE_BOOT__` 压根不存在 ⇒
   * 用户看到的是"boot.js 没有装上隧道"这种**指错方向**的提示 ✗）。
   *
   * 两个候选在同一相对深度上都能命中（源码在 `packages/host/src`、构建产物在 `packages/host/lib`）：
   *   ① 构建产物旁边的 `boot.js`（`lib/boot.js`，线上路径 ✓）；
   *   ② 仓库源码 `packages/client/src/boot.js`（开发/冒烟时用 ✓）。
   */
  const bootScriptCandidates = [
    join(import.meta.dirname ?? '', 'boot.js'),
    join(import.meta.dirname ?? '', '..', '..', 'client', 'src', 'boot.js'),
  ]
  const bootScriptPath = bootScriptCandidates.find((candidate) => existsSync(candidate))
  if (bootScriptPath === undefined) {
    warn(`找不到 boot.js（试过：${bootScriptCandidates.join(' / ')}）—— 手机页面将装不上传输层`)
  }
  /**
   * Codex 侧参数：宿主核心是在 `getCodexBridge()` 里读 `DSH_MOBILE_CODEX_*` 环境变量，
   * 独立服务不另造一套装配，直接在这些变量还没被读过之前写进本进程环境 ✓。
   */
  if (options.codexCli !== undefined) process.env['DSH_MOBILE_CODEX_CLI'] = options.codexCli
  if (options.codexArgs !== undefined) process.env['DSH_MOBILE_CODEX_ARGS'] = JSON.stringify(options.codexArgs)
  if (options.codexHome !== undefined) process.env['DSH_MOBILE_CODEX_HOME'] = options.codexHome
  // 手机新建的会话默认落在用户主目录（服务自己的 cwd 是仓库目录，不适合当工作区）
  if (process.env['DSH_MOBILE_CODEX_CWD'] === undefined || process.env['DSH_MOBILE_CODEX_CWD'].length === 0) {
    process.env['DSH_MOBILE_CODEX_CWD'] = homedir()
  }

  const service = createMobileHost({
    config: { ...DEFAULT_CONFIG },
    store,
    identity,
    gateway,
    endpoints,
    selfPort: internalPort,
    ...(phoneBaseUrl === undefined ? {} : { phoneBaseUrl }),
    ...(bootScriptPath === undefined
      ? {}
      : {
          bootScript: () => {
            const source = readFileSync(bootScriptPath, 'utf8')
            return { source, sha256: createHash('sha256').update(source).digest('hex') }
          },
        }),
    entryPath: STANDALONE_ENTRY_PATH,
    // 原版配对页/APK 的脚步都落在 /mobile/app 上（见 options.appShellAlias 的说明）
    appShellAlias: true,
    dshVersion: 'standalone',
    tls,
    listener,
  })
  handleHttp = (req, res) => service.handleHttp(req, res)
  handleUpgrade = (req, socket) => service.handleUpgrade(req, socket)
  listener.start()

  return {
    service,
    dataDir,
    internalPort,
    plainPort,
    tlsPort,
    migrated,
    phoneUrls() {
      return endpoints().map((base) => `${base}${STANDALONE_ENTRY_PATH}`)
    },
    desktopUrls() {
      const port = plainPort
      return port === undefined ? [] : [`http://127.0.0.1:${port}/mobile`]
    },
    async close() {
      try {
        listener?.dispose()
      } catch {
        /* 忽略 */
      }
      service.stopCodexBridge()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}
