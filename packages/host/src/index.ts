/**
 * @dsh-mobile/host —— 电脑端 DSH 插件。
 *
 * 职责：
 *  1. 配对：一次性码 + 二维码 payload；手机提交设备公钥，电脑端人工确认后登记。
 *  2. 设备注册表：授权模式（一次/长期/撤销）、能力位、审计。
 *  3. 隧道：在 `/mobile/ws` 上跑端到端加密会话（见 tunnel.ts）。
 *  4. 代理：把隧道内的 RPC / 流式调用转发给 DSH 的 Typert Gateway，
 *     从而复用**全部**既有业务 API（会话、工作区、文件、设置、凭据、skill、权限、上下文用量）。
 *  5. 管理端点：/mobile/manifest、/mobile/pair/*、/mobile/devices/*。
 *
 * 安全边界：
 *  - 业务调用只在**已建立加密会话**之后才被转发，隧道外的 HTTP 一律不碰业务 API。
 *  - 设备管理与配对确认端点只接受 loopback 请求（必须站在电脑前操作）。
 *  - 能力位"请求 ∩ 已授予 ∩ 宿主上限"三重收窄，写操作与 shell 默认关闭。
 */

import { execFileSync } from 'node:child_process'
import type { KeyObject } from 'node:crypto'
import { randomBytes, randomInt } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { dirname, join } from 'node:path'
import type { Duplex } from 'node:stream'
import { fileURLToPath } from 'node:url'

import {
  DEFAULT_CAPABILITIES,
  ErrorCode,
  PROTOCOL_VERSION,
  TUNNEL_PATH,
  fingerprint,
  wireError,
  type ClientHelloPayload,
  type DeviceCapabilities,
  type DeviceRecord,
  type HostDeviceCredentials,
  type MobileManifest,
  type PairClaimRequest,
  type PairClaimResponse,
  type PairStatusResponse,
  type PairingTicket,
} from '@dsh-mobile/protocol'

import { DeviceStore, type AuditEntry } from './devices.ts'
import { imageMimeOf, resolveWallpaper, wallpaperSize } from './wallpaper.ts'
import {
  DeviceCallQueue,
  DEVICE_CAPABILITIES,
  selectDeliveryTargets,
  type DeviceCapability,
} from './device-calls.ts'
import { CodexBridge, handleCodexEndpoint } from './codex/codex-bridge.ts'
import { CODEX_PAGE_HTML, CODEX_PAGE_PATH, CODEX_PAGE_SCRIPT_PATH } from './codex/codex-page.ts'
import {
  deriveLanTrust,
  isIpLiteralHostname,
  localMachineName,
  matchesDerivedTrust,
  type LanTrustSnapshot,
  type NetworkInterfacesReader,
} from './lan-trust.ts'
import { probeDshFrontend, type DshFrontendProbe } from './dsh-probe.ts'
/**
 * ★ 运行时磁盘资源（会话页 HTML 与 css/js ✓、codex 页脚本 ✓）的路径解析 ✓ ——
 *   收敛到 `host-assets.ts` **一处** ✓（2026-10-05 ✓）。
 *   原先这里与下面 codex 那处各写一份候选路径字面量 ✗
 *   ⇒ 只能靠「真起宿主 + 真发请求」才验得到 ✓，而**「装到 profile 之后还在不在」
 *     谁也没验** ✗（用户那条 `mobile/internal` 就是这么溜到手机上的 ✓）。
 */
import { hostAssetCandidates, readHostAsset, resolveHostAsset } from './host-assets.ts'
import { unavailableLanListenerStatus, type LanListenerStatus } from './lan-listener.ts'
import type { TlsManager, TlsStatus } from './tls-cert.ts'
import { PAIRING_PAGE_HTML } from './pairing-page.ts'
import { TunnelSession } from './tunnel.ts'
import { listOpenInAppTargets, openInApp } from './open-in-app.ts'
import { READ_CHUNK_BYTES, listDirectory, makeDirectory, pasteInto, readChunk, removePath, renamePath, summarize, writeChunk } from './workspace-files.ts'
import { buildWebAppManifest, iconPng } from './app-icons.ts'
import { DEFAULT_MAX_MESSAGE_BYTES, acceptWebSocket, type WebSocketConnection } from './websocket.ts'

/**
 * 宿主侧能力清单（每次新增宿主能力都要在这里加一项）。
 *
 * 自检脚本用它判断"当前进程跑的是哪一版"——宿主模块改动需要重启才生效，
 * 而"没生效"与"生效了但坏了"的症状常常一样，必须先区分开。
 */
/** 局域网自签环境的根证书（公开信息，用于手机装一次 CA）。 */
const CA_CERT_PEM = `-----BEGIN CERTIFICATE-----
MIIBrDCCAVOgAwIBAgIUAoTzRp0hzHVggBQTEwsfF+LCJCMwCgYIKoZIzj0EAwIw
MzEcMBoGA1UEAwwTZHNoLW1vYmlsZSBMb2NhbCBDQTETMBEGA1UECgwKZHNoLW1v
YmlsZTAeFw0yNjA5MTgxNDA0MDVaFw0zNjA5MTUxNDA0MDVaMDMxHDAaBgNVBAMM
E2RzaC1tb2JpbGUgTG9jYWwgQ0ExEzARBgNVBAoMCmRzaC1tb2JpbGUwWTATBgcq
hkjOPQIBBggqhkjOPQMBBwNCAATdI5d+rsNPTfdKiXd5hj/R3yJ9Wjt+2z2iDyn6
REH7P4zSDO92tE2YjtgZrpkexh4Fhwwq1QB4s+RZW+o2uhi8o0UwQzASBgNVHRMB
Af8ECDAGAQH/AgEAMA4GA1UdDwEB/wQEAwIBBjAdBgNVHQ4EFgQU1/uuiQ0tiY5X
X+RNDGCLfaZJB0AwCgYIKoZIzj0EAwIDRwAwRAIgJoG+QclIiUzS80SkZalCv8r5
7ltg8CHnJgBB+7BqXLMCIDM3BkkvAlFWAeL4rMyNWSGPyNeASeaTWR/qw/3LwYr4
-----END CERTIFICATE-----`

const HOST_FEATURES = [
  'files.write', // 手机→电脑的文件上传（分块写入）
  'relay.dialer', // 中继外拨（电脑主动拨出，不需要入站端口）
  'relay.backhaul', // 中继页面回源
  'pairing.ticketFallback', // 票据失效时回退到已配对设备
  /**
   * ★ 插件封装第一阶段（2026-09-27，见 `16-插件封装-第一阶段.md`）：下面四条是**本轮新加**的
   * 宿主能力。`scripts/check-production.mjs` 的 `EXPECTED_FEATURES` **必须同步** ✓ ——
   * 只改一处会让 `check:prod` 变红 ✗，或让新能力没人盯着 ✗（两处一起改是这条约定的全部意义 ✓）。
   */
  'trust.autoDerive', // 信任判据按**当时网卡**现算（不再要求手传 IP）
  'tls.selfSign', // 首启缺证书就自签（10 年 CA；叶子按需重签）
  'admin.devicesRemove', // 正式删除设备记录（内存表 + devices.json 同时更新，不用重启）
  'admin.selfcheck', // 一条请求自检：证书 / 端口 / 信任推导 / 设备数 / DSH 前端探针
  /**
   * ★ C1（把 TLS/明文监听搬进插件，2026-09-27）：插件自己起局域网监听，
   * 不再依赖外置第三进程 `scripts/lan-proxy.mjs`。**默认关闭**（`listener.enabled`），
   * 现状见自检的 `listener` 段。`scripts/check-production.mjs` 的 `EXPECTED_FEATURES`
   * **必须同步**（两处一起改是这条约定的全部意义）。
   */
  'listener.plugin',
] as const

/** 插件配置。 */
/**
 * ★★ 按**网关自己的签名**调 `openWireStream` ✓ —— 这是 2026-09-28 Windows 实机那场
 * "手机永远正在重连中"的**真正根因** ✓。
 *
 * ## 为什么必须按 arity 分派（不能只写死一种 ✗）
 *
 * `dsh-api-gateway` 的签名**跨版本变过** ✓：
 * ```
 * 0.1.5-rc.1 : async openWireStream(endpoint, payload, signal) { … }
 * 0.1.7-rc.2 : async openWireStream(endpoint, payload, uplink, peer, signal, control) {
 *                if (endpoint === REMOTE_EVENT_STREAM_ENDPOINT) {   // ← "$events"
 *                  releaseUplink(uplink); return this.openRemoteEvents(payload, signal)
 *                } …
 *              }
 * ```
 * 插件原先**写死 3 个参数** ✓ ⇒ 在 0.1.7 上 `signal` 落进 `uplink` 位、
 * 真 `signal` 是 `undefined` ⇒ `$events` 那一支 `AbortSignal.any([undefined, …])` **当场抛** ✗
 * ⇒ **实时事件流永远建不起来** ✓。
 *
 * ★ 为什么这条极难查 ✗✗：**一元 RPC 全部正常** ✓（它们走 `remoteRequest`、`undefined`
 * 会被静默省略 ✓）⇒ 页面能渲染、能配对、`connectedDevices` 也正常 ✓，
 * **只有侧栏一直「重新连接中」** ✓。实机审计里 115 次 `$events` **全失败** ✓，
 * 原因都是同一句 `signals[0] is not of type AbortSignal` ✓。
 *
 * ★ 判据用 `Function.length`（**声明了几个形参** ✓）而不是版本号字符串 ✓ ——
 *   版本号要读 package.json（可能被打包改变 ✗），arity 就在函数自己身上 ✓。
 *   `uplink` / `peer` 传 `undefined` 与网关**自己的进程内载体**完全一致 ✓
 *   （它就这么转：`(e, p, u, pe, s) => this.openWireStream(e, p, u, pe, s, new AbortController())` ✓）。
 */
export function callOpenWireStream(
  gateway: { readonly openWireStream?: (endpoint: string, payload: unknown, ...rest: unknown[]) => Promise<AsyncIterable<unknown>> },
  endpoint: string,
  payload: unknown,
  signal: AbortSignal,
): Promise<AsyncIterable<unknown>> {
  const open = gateway.openWireStream
  if (typeof open !== 'function') throw new TypeError('gateway.openWireStream 不存在')
  /**
   * ★★ **必须带着 `this` 调** ✗✗（2026-09-28 本地 0.1.7 实例上真复现过 ✓）：
   *   网关那份实现里是 `this.openRemoteEvents(payload, signal)` ✓ ⇒ 一旦把方法**取出来存变量**
   *   再裸调 ✓，`this` 就没了 ⇒ 报 `Cannot read properties of undefined (reading 'openRemoteEvents')` ✗
   *   （我先写成 `const open = …; open(...)` ✗ ⇒ 就是这个错 ✓）。
   *   ★ 原来的代码是对的（`options.gateway.openWireStream(...)` **方法调用** ✓）——
   *   是我为了抽函数把它改坏的 ✓。所以这里统一用 `.call(gateway, …)` ✓。
   */
  // ≥5 个形参 ⇒ 新版六参签名（signal 在第 5 位、第 6 位要一个 AbortController ✓）
  if (open.length >= 5) return open.call(gateway, endpoint, payload, undefined, undefined, signal, new AbortController())
  // 否则按老三参（signal 在第 3 位 ✓）
  return open.call(gateway, endpoint, payload, signal)
}

export interface MobileHostConfig {
  enabled: boolean
  /** 配对码有效期（毫秒）。 */
  pairingTtlMs: number
  /** 电脑端是否必须人工确认设备指纹。 */
  requireHostConfirm: boolean
  /** 审计保留条数。 */
  auditLimit: number
  /** 单条消息上限（字节）。 */
  maxMessageBytes: number
  /** 空闲超时（毫秒），写入 ServerAuthOk 供客户端参考。 */
  idleTimeoutMs: number
  /** 是否允许"此设备一律允许"（长期授权）。 */
  allowPersistentAuthorization: boolean
  /**
   * 中继地址（如 `wss://relay.example.com/attach`）。
   *
   * 配置后电脑会**主动外拨**并保持若干条空闲连接 —— 这是"不需要任何入站端口、
   * CGNAT 后也能用"的关键：DSH 只绑 loopback，电脑通常在 NAT 后面，
   * 让手机连进来要端口映射；反过来让电脑拨出去就没有这个问题。
   */
  relayUrl?: string
  /** `/attach` 的共享密钥。作为**首条消息**发送，不进 URL（避免落进访问日志）。 */
  relayToken?: string
  /** 维持多少条空闲中继连接（默认 2：手机与平板各一条）。 */
  relayPoolSize?: number
  /** 回源通道地址；省略时由 `relayUrl` 把 `/attach` 换成 `/attach-http` 推导。 */
  relayHttpUrl?: string
  /**
   * 信任推导里**本机 hostname** 那半边是否放行（默认 true）。
   *
   * 只有 IP 字面量那半边是"不可能被 rebinding 借用"的（见 `lan-trust.ts` 的长注释）；
   * hostname 那半边是**精确匹配**本机名，够安全但不是零风险，因此留一个收紧的开关：
   * 关掉之后只剩回环 ∪ 静态列表 ∪ 本机 IP 字面量，代价是用机器名访问会 403。
   */
  trustLocalNames: boolean
}

export const DEFAULT_CONFIG: MobileHostConfig = {
  enabled: true,
  pairingTtlMs: 5 * 60 * 1000,
  requireHostConfirm: true,
  auditLimit: 2000,
  maxMessageBytes: DEFAULT_MAX_MESSAGE_BYTES,
  idleTimeoutMs: 300_000,
  allowPersistentAuthorization: true,
  trustLocalNames: true,
}

/**
 * 宿主身份签名密钥的结构面。
 * 只声明本插件真正用到的字段，避免绑死具体实现（Node KeyObject 结构上满足它）。
 */
/**
 * ★★ 缩略图那两个函数**在这里 import** ✗ —— 而不是文件顶部 ✓。
 *   理由与 `mobile/dsh/*` 当初用动态 import 完全一样 ✓：
 *   **顶部那一段正被别的单改着** ✓，插进去就会把两单搅进同一次提交 ✓。
 *   `import` 出现在模块顶层**任何位置**语义都一样（会被提升 ✓）——
 *   放在这个"两面都是已提交代码"的空档里 ✓，它就是一个能单独提交的 hunk ✓。
 */
import { captureShot, createNodeShotRunner, explainCaptureFailure } from './desktop-shot.ts'

/** 截屏用的 runner ✓（无状态 ✓，建一次就够 ✓）。 */
const shotRunner = createNodeShotRunner()

export interface SigningKeyLike {
  readonly publicKey: string
  /**
   * Node 的 KeyObject 私钥（仅存在于本进程内存）。
   *
   * 类型必须与协议包的 `RawKeyPair` 一致：`TunnelSession.hostSigningKey` 就是它，
   * 握手时用它给 ServerAuthOk 签名。写成 `unknown` 会在装配会话处直接编译失败。
   */
  readonly privateKey: KeyObject
}

/** 宿主身份。 */
export interface HostIdentity {
  readonly hostId: string
  readonly hostName: string
  readonly signingKey: SigningKeyLike
}

/**
 * DSH Typert Gateway 的最小接口。
 *
 * 刻意只声明本插件用到的两个方法：
 *  1. 便于用假实现做端到端测试；
 *  2. 避免把插件绑死在具体 gateway 版本上（DSH 升级时只需这两个方法不变）。
 * 参数形状与 DSH 的 `remoteRequest()` 完全一致：endpoint 形如 `session/create`。
 */
export interface RemoteGateway {
  invoke(request: {
    readonly namespace: string
    readonly method: string
    readonly args: Readonly<Record<string, unknown>>
    readonly signal?: AbortSignal
  }): Promise<unknown>
  stream(request: {
    readonly namespace: string
    readonly method: string
    readonly args: Readonly<Record<string, unknown>>
    readonly signal?: AbortSignal
  }): Promise<AsyncIterable<unknown>>
  /**
   * 流式调用的**传输层入口**（DSH 自己的 HTTP mux 与 WebSocket mux 都用它）。
   *
   * 为什么不直接用 `stream()`：客户端会打开一个特殊端点 **`$events`**
   * （不带命名空间斜杠），它由 `openWireStream` 内部特判并转给 `openRemoteEvents`——
   * 那是 DSH 的实时事件通道，**会话历史与连接状态都靠它**。
   * 而 `stream()` 走的是 `namespace/method` 解析，遇到 `$events` 会直接抛
   * `invalid Remote endpoint "$events"`。
   *
   * 症状具有很强误导性：一元调用全部正常、界面能渲染，只是**永远显示"重连中"、
   * 看不到任何会话历史**——因为承载事件的那条流从未建立。
   */
  /**
   * ★★ 这个方法的**签名跨 DSH 版本不一样** ✗（2026-09-28 Windows 实机定因 ✓）：
   *   · DSH **0.1.5-rc.1**（本机）：`(endpoint, payload, signal)` —— 3 个 ✓
   *   · DSH **0.1.7-rc.2**（Windows 实机）：`(endpoint, payload, uplink, peer, signal, control)` —— 6 个 ✓
   * 所以这里写成"前两个固定、其余任意" ✓（两种都类型通过 ✓，具体怎么调见 `callOpenWireStream` ✓）。
   */
  openWireStream?(endpoint: string, payload: unknown, ...rest: unknown[]): Promise<AsyncIterable<unknown>>
}

/** 设备管理更新入参。 */
export interface DeviceUpdate {
  authorization?: 'once' | 'persistent' | 'revoked'
  capabilities?: Partial<DeviceCapabilities>
  expiresAt?: string | null
}

/**
 * 自检报告（`GET /mobile/admin/selfcheck`）。
 *
 * ## 为什么要有它
 *
 * 现在的"现在到底好不好、缺什么"要靠 `scripts/check-production.mjs` 在电脑上跑一整套脚本，
 * 而症状常常出现在**手机那一侧**（打不开、连不上），人在电脑前根本不知道该看哪一项。
 * 这条路由把关键判据收成**一次请求**：证书在不在（指纹）、监听端口、信任判据的**当前**推导结果、
 * `devices.json` 条数、以及 DSH 前端关键锚点的命中率。
 *
 * ★ 纪律：**拿不到就写"未知"，不许编**。所以 `dshFrontend.status` 允许是 `'unknown'`，
 *   而 `tls.available === false` 表示本部署根本没注入证书管理器（不是"证书坏了"）。
 */
export interface MobileSelfcheck {
  /** 总判据：证书可用 且 DSH 前端探针没有"全不命中"。`unknown` 不算失败（不编也不误报）。 */
  readonly ok: boolean
  readonly checkedAt: string
  /**
   * ★ 第 50 轮（第二阶段取证通道）：最近几条宿主诊断（标签 + 摘要，已截断限量）。
   *   为什么需要它 ✗：选择卡的事件类型名只能靠真机取证 ✓，
   *   而诊断原先只进审计（`/mobile/audit` 是 **LOCAL_ONLY** ⇒ 手机读不到 ✗），
   *   桌面端又没有可看的日志 ✗ ⇒ 手机上**没有任何出口** ✓。
   *   这里复用**现成的**自检页 ✓（用户已经能从手机/局域网打开过它 ✓）。
   * ★ 纪律：诊断里**不许出现票据/密钥原文**（沿用 PairLink.redact 那条规矩）。
   */
  readonly diagnostics?: ReadonlyArray<{ readonly tag: string; readonly detail: string }>
  /** 端侧队列积压（只读计数）：一直涨 ⇒ 手机没在取（见自检页里的说明）。 */
  readonly deviceQueue?: { readonly pending: number }
  /**
   * ★ 第 74 轮：**这台电脑上的插件与 APK 是哪一版** ✓ ——
   *   专门用来消灭"验了旧的"这种白费：用户验之前先看一眼这里，
   *   就知道电脑端有没有更新到最新（而不是等验完发现不对再回头查 ✓）。
   *   · `boot`：注入脚本里的构建戳（形如 BUILD-… ✓，与手机上看到的一致 ✓）；
   *   · `apk`：插件旁边那份 APK 的字节数与修改时间 ✓（没有就如实说没有 ✓）。
   */
  readonly assets?: {
    readonly boot: string
    readonly apk: { readonly bytes: number; readonly modifiedAt: string } | null
  }
  readonly host: { readonly hostId: string; readonly hostName: string; readonly hostFingerprint: string }
  readonly tls: {
    /** 本部署有没有注入证书管理器（`cordis.ts` 注入；纯协议测试里没有）。 */
    readonly available: boolean
    readonly ok: boolean
    readonly directory: string
    readonly createdCa: boolean
    readonly createdServer: boolean
    readonly resignedServer: boolean
    readonly caFingerprint?: string
    readonly serverFingerprint?: string
    readonly serverSubjectAltName?: string
    readonly caNotAfter?: string
    readonly serverNotAfter?: string
    /** 证书生成/读取失败的原因（**必须被说出来**，不许静默）。 */
    readonly error?: string
  }
  readonly listen: {
    /** 本机 DSH 的监听端口（回源通道用它做环回请求）。 */
    readonly dshPort: number | null
    readonly phoneBaseUrl: string | null
    readonly endpoints: readonly string[]
  }
  readonly trust: {
    /** 网卡是否真的取到了；false ⇒ 只剩静态列表可用。 */
    readonly derived: boolean
    readonly localAddresses: readonly string[]
    readonly hostnames: readonly string[]
    /** 本机 hostname 那半边是否放行（`MobileHostConfig.trustLocalNames`）。 */
    readonly localNamesEnabled: boolean
    readonly staticHosts: readonly string[]
    /** 中继 authority（写进信任集合的那两条）。 */
    readonly relay: readonly string[]
  }
  readonly devices: { readonly count: number; readonly connected: number; readonly revoked: number }
  readonly dshFrontend: DshFrontendProbe
  /**
   * 局域网监听现状（C1）。
   *
   * 为什么值得单独一段：手机打不开时，问题可能落在**三层**里的任何一层——
   * 插件没起监听（`available:false` / `enabled:false`）、起了但端口被占
   * （`bindings[].code === 'EADDRINUSE'`，还带"可能上次的 lan-proxy 还活着"的提示）、
   * 或者监听正常但 `x-forwarded-for` 注入没生效（⇒ 手机被当成"人在电脑前"，
   * 这是**权限提升**且毫无症状，所以把它作为一项显式报出来）。
   */
  readonly listener: LanListenerStatus
  /** 人话版的"缺什么"（自检输出直接可读；空数组 = 没发现问题）。 */
  readonly warnings: readonly string[]
}

/** 插件对外暴露的服务面。 */
export interface MobileHostService {
  /**
   * 写一条**诊断性审计**（供插件内部的可选功能上报"我这一环有没有被触发"）。
   *
   * 为什么需要：像"审批推送"这种挂在 DSH 事件上的功能，**没被触发**与**触发了但没用**
   * 是两种完全不同的问题，而它们从外部看起来一模一样（都是"手机上没收到"）✗。
   * 落一条审计之后，用 `curl /mobile/audit` 就能把两者分开 ✓。
   */
  recordDiagnostic(tag: string, detail: string): void
  /**
   * 按 6 位配对码取出"给手机用的配对载荷"（base64url(UTF-8 JSON)）。
   * 返回 undefined 表示码不存在、已用过或已过期。
   *
   * ★ 必须声明在**这个基接口**上：`MobileHost extends MobileHostService`，
   *   只在实现对象里多写一个成员会得到 "does not exist in type 'MobileHostService'" ✓
   *   （本项目已经栽过一次，注释就写在这一段附近）。
   */
  pairingPayloadForCode(code: string): string | undefined

  /**
   * agent 工具（`phone_notify`）的注册结果。
   *
   * 为什么要暴露它：注册发生在**异步**的动态 import 之后，且失败时只打一行警告
   * （刻意如此——绝不能让插件加载失败）。于是"到底注册上没有"在重启后**无从确认**。
   * 把结果写在服务上，`/mobile/debug` 与生产自检就能回答这个问题。
   * `'pending'` 表示还没跑到（插件刚加载完的那一瞬间）。
   */
  agentToolStatus(): 'pending' | 'registered' | 'skipped' | 'failed'
  /** 由 cordis.ts 调用：记录 agent 工具的注册结果。 */
  setAgentToolStatus(status: 'registered' | 'skipped' | 'failed'): void

  /**
   * 发起一次端侧请求（电脑 → 手机）。
   *
   * **唯一入口**：HTTP 路由 `/mobile/device/call` 与（将来的）agent 工具都走它，
   * 于是"发给谁、能力是否已启用"的判定只有一处，两边不会走偏。
   *
   * ★ 目标语义（第 90 轮定稿 ✓）：`deviceId` 不给 ⇒ **所有"可用且已启用该能力"的设备** ✓
   * （不再看"此刻谁连着本机"✗ —— 那会让"手机切到另一台电脑"时的提权通知丢掉 ✗）。
   */
  deviceCall(
    capability: string,
    text: string,
    deviceId?: string,
    /** ★ 第二阶段缺口二：这条请求该落到哪个会话（可选；通知点击时用）。 */
    sessionId?: string,
    /** ★ 2026-10-05：系统通知的标题（可选；形如 `Mac-mini-2024 需要你确认`）。 */
    title?: string,
  ): { ok: true; id: string } | { ok: false; reason: string }

  readonly store: DeviceStore
  createPairing(): { ticket: PairingTicket; qrPayload: string; expiresAt: string }
  /** 列出待确认的配对（供电脑端界面展示指纹并确认）。 */
  listPendingPairings(): {
    code: string
    state: string
    deviceId?: string
    name?: string
    fingerprint?: string
    model?: string
    platform?: string
  }[]
  confirmPairing(code: string, deviceId: string, approve: boolean): boolean
  listDevices(): DeviceRecord[]
  updateDevice(deviceId: string, update: DeviceUpdate): DeviceRecord | undefined
  revokeDevice(deviceId: string): boolean
  /**
   * **彻底删除**一条设备记录（不是撤销）。
   *
   * 与 `revokeDevice` 分开：撤销保留记录（审计可追溯、界面能显示"已撤销"），
   * 删除是把条目从 `devices.json` 里抹掉 —— 这正是过去只能"改文件 + 立刻重启"才能做到的事
   * （`DeviceStore` 只在构造时 `load()`、之后整表覆盖写回，手改文件会被下一次 `touch()` 写回）。
   * 删除同样**立刻断开**该设备的在线隧道，否则"删了还能用"直到它自己断线。
   */
  removeDevice(deviceId: string): boolean
  /** 批量删除所有**已撤销**的记录；返回删除条数。 */
  removeRevokedDevices(): number
  listAudit(options?: { deviceId?: string; since?: string; limit?: number }): AuditEntry[]
  connectedCount(): number
  manifest(): MobileManifest
  connectedSession(deviceId: string): TunnelSession | undefined
  /**
   * 自检（`GET /mobile/admin/selfcheck`）的**纯数据**部分。
   * 与 HTTP 路由分开，是为了让"现在到底好不好"这件事可以被单测直接断言。
   */
  selfcheck(): MobileSelfcheck
}

/** 完整宿主对象（服务面 + HTTP/upgrade 处理）。 */
export interface MobileHost extends MobileHostService {
  /**
   * 手机端应用外壳（index.html + ETag）。
   *
   * 存在的原因见实现处的长注释：DSH 的 `/` 有 token/cookie 鉴权，手机拿不到，
   * 于是配对成功后仍进不去界面。返回 undefined 表示本部署未注入前端静态服务。
   */
  getAppShell(): { html: string; etag: string } | undefined
  handleUpgrade(req: IncomingMessage, socket: Duplex): void
  /** 返回 true 表示本插件已处理该请求。 */
  handleHttp(req: IncomingMessage, res: ServerResponse): boolean
  /** 停止中继外拨（进程退出/插件卸载时调用）。 */
  stopRelayDialer(): void
  /** 停止中继回源通道。 */
  stopRelayHttpBackhaul(): void
  /** 停止 Codex 宿主桥（懒启动过才需要）。 */
  stopCodexBridge(): void
}

/** 内部：待确认的配对。 */
interface PendingPairing {
  readonly ticket: PairingTicket
  state: 'open' | 'claimed' | 'approved' | 'rejected' | 'expired'
  claim?: PairClaimRequest
  deviceToken?: string
}

/** 端点解析：'session/create' → {namespace:'session', method:'create'}。 */
function parseEndpoint(endpoint: string): { namespace: string; method: string } {
  const segments = endpoint.split('/')
  if (segments.length !== 2 || segments[0] === '' || segments[1] === '') {
    throw Object.assign(new Error(`invalid Remote endpoint ${JSON.stringify(endpoint)}`), {
      code: ErrorCode.HandshakeMalformed,
    })
  }
  return { namespace: segments[0]!, method: segments[1]! }
}

/**
 * 创建宿主插件主体。
 * 与 Cordis 解耦：返回纯对象，由 cordis.ts 把它挂到 ctx 与路由上，便于无 DSH 环境下完整测试。
 */
export function createMobileHost(options: {
  readonly config?: Partial<MobileHostConfig>
  readonly store: DeviceStore
  readonly identity: HostIdentity
  readonly gateway: RemoteGateway
  /** 可用连接地址（用于二维码 payload 与 manifest）。 */
  readonly endpoints: () => string[]
  /** 本机 DSH 的监听端口（回源通道要用它做环回请求）。 */
  readonly selfPort?: number
  /** 允许授予的最大能力位；未列出的位一律拒绝（能力最小化）。默认与 DEFAULT_CAPABILITIES 相同。 */
  readonly capabilityCeiling?: DeviceCapabilities
  /**
   * 注入脚本（`/mobile/boot.js`）。
   * 由客户端插件包提供内容，宿主只负责以正确的 Content-Type 与完整性哈希提供它。
   * 省略时不提供该路由（适配器仍可只做协议层自测）。
   */
  readonly bootScript?: () => { readonly source: string; readonly sha256: string }
  /**
   * 本部署额外服务的 authority（与 DSH 的 `trustedHosts` 同义）。
   *
   * 用途：本插件注册的 `/mobile/*` 路由**不受** DSH 的 `/api` 信任栅栏保护
   * （那道栅栏只覆盖 Connection 自己认领的路径），因此必须自己校验 Host/Origin。
   * 局域网访问时把手机实际使用的 authority 传进来（例如 `10.34.221.181:3081`），
   * 否则插件会以 403 拒绝——这是刻意的：宁可报错并给出 `--trusted-host` 提示，
   * 也不要静默接受任意 Host（那等于打开 DNS rebinding 与跨站请求的门）。
   */
  readonly trustedHosts?: readonly string[]
  /**
   * **手机**应当访问的基地址（如 `https://10.34.221.181:3443`）。
   *
   * 为什么与 `publicBaseUrl` 分开：手机侧必须走 HTTPS（普通 HTTP 页面不是安全上下文，
   * `crypto.subtle` 不存在，配对与隧道都无法工作），而电脑侧仍走明文 loopback。
   * 两者的 scheme 与端口都不同，用一个字段表达不了。
   *
   * 由适配器从配置透传；配对页据此显示手机地址，避免页面自己猜端口。
   */
  readonly phoneBaseUrl?: string
  /**
   * 手机配对成功后应该落到的**入口路径**（默认 `/mobile/app` = DSH 外壳）。
   *
   * 独立服务（standalone.ts）把它设成 `/mobile/codex` —— 那里没有 DSH 前端，
   * 手机必须直接落到 Codex 页面；否则配对完成后会打开一个 503 的外壳路径。
   */
  readonly entryPath?: string
  /**
   * 是否把入口页面**同时**发在 `/mobile/app` 上（默认 false = 只有 DSH 插件会用那条路径）。
   *
   * ★ 为什么独立服务需要它（2026-09-30 用户实测）：原版配对页的二维码是
   *   `dshmobile://pair?d=…`，**APK 扫完固定落到 `<基地址>/mobile/app?pair=…`**
   *   （见 native/android 的 `PairLink.APP_PATH` ✓）；配对页自己的"手机侧"提交后
   *   也是跳到 `/mobile/app?pair=…` ✓。独立服务没有 DSH 外壳 ⇒ 那条路原本 404 ⇒
   *   整个"原版配对体验"都用不了 ✗。开了这个别名之后，两条路发的是**同一个页面** ✓。
   */
  readonly appShellAlias?: boolean
  /**
   * DSH 前端 index.html 的绝对路径（由适配器提供，宿主不猜路径）。
   * 用于给手机端提供应用外壳。
   */
  readonly distIndex?: () => string | undefined
  /**
   * DSH 的 index 渲染器（`ctx.webServer.renderIndex`）。
   * 手机端外壳必须走同一个渲染管线，否则会漏掉插件注入（包括本插件的 boot.js）。
   */
  readonly renderIndex?: (html: string) => string
  readonly clientBundleVersion?: string
  readonly dshVersion?: string
  /**
   * 网卡取值函数（默认 `os.networkInterfaces`）。
   *
   * 只为**可测**而存在：信任判据必须"每次请求按当时网卡现算"，而这件事只有在
   * 能把网卡换掉的前提下才验得了（单测里塞一个可变函数，先后两次调用得到不同结论）。
   */
  readonly networkInterfaces?: NetworkInterfacesReader
  /** 本机 hostname 取值函数（默认 `os.hostname`）；同样只为可测。 */
  readonly hostname?: () => string
  /**
   * 自签证书管理器（由 `cordis.ts` 建好注入）。
   *
   * 省略时：manifest 里的 `tls` 标成不可用、自检标成 `available: false`、`/mobile/trust.crt`
   * 退回"读不到就说清楚"的 404——**绝不让缺证书变成一句静默**。
   */
  readonly tls?: TlsManager
  /**
   * 局域网监听器（由 `cordis.ts` 按 `listener.enabled` 建好注入；C1）。
   *
   * 省略时自检的 `listener` 段是"本部署未注入"（`available:false`），
   * 且**不算失败**——老部署的手机入口由外置 `lan-proxy.mjs` 提供，那是最常见形态。
   */
  readonly listener?: { status(): LanListenerStatus }
}): MobileHost {
  const config: MobileHostConfig = { ...DEFAULT_CONFIG, ...options.config }
  const store = options.store
  const ceiling: DeviceCapabilities = options.capabilityCeiling ?? DEFAULT_CAPABILITIES
  const pendingByCode = new Map<string, PendingPairing>()
  const pendingByTicket = new Map<string, PendingPairing>()
  const sessions = new Map<string, TunnelSession>()
  /** 端侧请求队列（电脑 → 手机；见 device-calls.ts 的四条不变量）。 */
  const deviceCalls = new DeviceCallQueue()

  /**
   * ── 信任判据（本插件那道闸）─────────────────────────────────────────────
   *
   * 判据 = 回环（调用方单独判）∪ 静态列表 ∪ **自推导的本机地址/主机名**。
   * 静态列表由调用方给（含 `phoneBaseUrl` 与中继 authority —— 它们本就是
   * "部署方声明过的 authority"，与 `trustedHosts` 同类）。
   *
   * ★ 为什么是**函数**而不是启动时算好的常量：换 Wi-Fi / 插网线 / VPN 起来 /
   *   Tailscale 掉线都会改变本机地址，启动时算一次就等于"换网必须重启 DSH"。
   *   这里每次 `handleHttp` / `handleUpgrade` 重新推一遍（见 `lan-trust.ts` 的长注释：
   *   判据的宽严与"为什么只有 IP 字面量才比本机 IP"都写在那里）。
   *
   * ★ 推导失败（拿不到网卡）时 `deriveLanTrust` 返回空地址 + `derived: false`
   *   ⇒ 实际效果是**退回静态列表**，即比平常更严。方向刻意选这一侧。
   */
  function trustSnapshot(): LanTrustSnapshot {
    return deriveLanTrust({
      ...(options.networkInterfaces === undefined ? {} : { networkInterfaces: options.networkInterfaces }),
      ...(options.hostname === undefined ? {} : { hostname: options.hostname }),
    })
  }

  /** 一个 authority 是否落在"静态 ∪ 自推导"里（回环由调用方先判）。 */
  function isTrustedAuthority(
    authority: ParsedAuthority,
    staticHosts: readonly string[],
    snapshot: LanTrustSnapshot,
  ): boolean {
    if (matchesTrusted(authority, staticHosts)) return true
    // 收紧开关：关掉本机 hostname 那半边之后，只剩 IP 字面量能靠推导进来
    if (config.trustLocalNames === false && !isIpLiteralHostname(authority.hostname)) return false
    return matchesDerivedTrust(authority, snapshot)
  }

  /** 中继的两条 authority（写进信任集合用的那一份，与 upgrade 路径保持一致）。 */
  function relayAuthorities(): string[] {
    const out: string[] = []
    for (const relayEndpoint of [config.relayUrl, config.relayHttpUrl]) {
      if (typeof relayEndpoint === 'string' && relayEndpoint.length > 0) out.push(relayEndpoint)
    }
    return out
  }

  /**
   * `/mobile/admin/*` 的来源判据。
   *
   * ★ 与栅栏的区别必须说清：栅栏放行**回环 hostname**（`localhost` / `127.0.0.1`）时
   *   **不看 socket 来源**——它是防 rebinding / 防跨站的判据，不是身份。局域网客户端
   *   完全可以发 `Host: localhost` 过栅栏。所以这里第一件事是判 `isLoopbackRequest(req)`
   *   （socket 是否为回环；只有 socket 确实回环才采信 `x-forwarded-for`），
   *   而**不能**用 `isLoopbackHostname(authority.hostname)` 顶替。
   */
  function isAdminSourceTrusted(req: IncomingMessage, authority: ParsedAuthority, snapshot: LanTrustSnapshot): boolean {
    /**
     * ★★ 2026-09-27 **用户拍板：这两条管理路由只允许本机（loopback）** ✓。
     *
     * 原先这里是"loopback ∪ 受信 authority（复用 A 的自推导判据）"，代价写在下面的历史注释里：
     * 局域网里任何人拿**本机真实 IP** 就能 `POST /mobile/admin/devices/remove` 清空设备表
     * （DoS：把所有人踢回重新配对；不是提权 —— 删记录不新增设备、不授予能力位，
     * 重新配对仍要电脑端生成配对码并人工确认指纹）。
     *
     * 用户明确选择**收紧**：设备清理只在电脑本机上做（手机不再提供"一键清设备"）。
     * ⇒ 判据只剩 `isLoopbackRequest(req)`（看 socket 与 `x-forwarded-for`，**不看 Host 长什么样**）
     * —— 与文件里其它 `LOCAL_ONLY` 的判据同一把尺子 ✓。
     *
     * ★ 为什么不干脆复用外面那道栅栏：栅栏放行**回环 hostname**（`localhost` / `127.0.0.1`）时
     *   并不看 socket 来源（那是为了兼容反代与 DNS rebinding 的判据）⇒ 一个局域网客户端
     *   完全可以发 `Host: localhost` 过栅栏 ✗。所以这里必须另判 socket 来源 ✓。
     *
     * `authority` / `snapshot` 保留在签名里是为了让调用点与审计仍能拿到完整上下文 ✓
     * （将来若要做"只允许某台已配对设备"的隧道内端点，判据也挂在这一层旁边 ✓）。
     */
    void authority
    void snapshot
    return isLoopbackRequest(req)
  }

  /** 清理过期配对。 */
  function purgeExpired(now = Date.now()): void {
    for (const [code, entry] of pendingByCode) {
      const expires = Date.parse(entry.ticket.expiresAt)
      if ((entry.state === 'open' || entry.state === 'claimed') && expires <= now) {
        entry.state = 'expired'
        pendingByTicket.delete(entry.ticket.ticket)
      }
      // 终结态保留 60 秒供手机轮询结果
      if (entry.state !== 'open' && entry.state !== 'claimed' && expires + 60_000 <= now) {
        pendingByCode.delete(code)
        pendingByTicket.delete(entry.ticket.ticket)
      }
    }
  }

  /**
   * ── 短码配对（`/mobile/p/<6 位码>`）的**猜码限速**（T2）──────────────────
   *
   * ## 为什么必须限速
   *
   * 6 位码只有 90 万个取值，而配对码默认只活 5 分钟。这条"码 → 票据"的路此前**完全不限速**，
   * 于是同一个局域网（或经中继回源）上的人可以在有效期内把 90 万种可能都试一遍，
   * 拿到票据后就能以"待确认设备"的身份出现在电脑端的待确认列表里。人工比对指纹仍是最后一道闸，
   * 但让攻击者免费站到那道闸前本身就不该被允许。
   *
   * ## 判据：只记失败 + 短窗口 + 冷却
   *
   * - 60 秒窗口内失败 10 次 ⇒ 冷却 5 分钟（= 配对码默认有效期，足以让本次配对作废）；
   * - 成功一次即**整桶清零** —— 用户在手机上敲错两次之后正常输入，不该继续被惩罚；
   * - 只对"码无效 / 已过期"计数，命中时不计数（限速针对猜码，不针对正常配对）。
   *
   * ## 来源键为什么这样取
   *
   * 规则与 `isLoopbackRequest` 一致：socket 是回环、且带 `x-forwarded-for`（局域网代理注入的
   * 真实来源）时才采信该头的第一段，否则按 socket 地址。这样局域网里每台设备各自一个计数桶，
   * 一台设备狂试不会连坐别的设备；同时直连的非回环客户端**无法**靠伪造该头换桶。
   *
   * ## 已知代价（写清楚，别当成没这回事）
   *
   * 经**中继回源**来的请求，socket 恒为回环，且回源通道会主动剥掉 `x-forwarded-for`
   * （防伪造，见 `startRelayHttpBackhaul`）⇒ 这些请求**共用同一个桶**：远程的恶意猜码
   * 会让同一条中继上的正常配对也一起进入冷却。在"能区分来源"与"限速真的有效"之间，
   * 这里选偏安全的一侧 —— 配对本就要人在电脑前人工确认，冷却 5 分钟只是重新生成一个码。
   */
  const CODE_GUESS_WINDOW_MS = 60_000
  const CODE_GUESS_MAX_FAILURES = 10
  const CODE_GUESS_COOLDOWN_MS = 5 * 60_000
  /** 每个来源一个桶；`blockedUntil` 为 0 表示未在冷却中。 */
  const codeGuessBuckets = new Map<string, { failures: number; windowStart: number; blockedUntil: number }>()

  /** 取"猜码"的来源键（采信 `x-forwarded-for` 的条件同 `isLoopbackRequest`）。 */
  function pairingSourceKey(req: IncomingMessage): string {
    const raw = req.socket.remoteAddress ?? ''
    const normalized = raw.startsWith('::ffff:') ? raw.slice(7) : raw
    const socketIsLoopback = normalized === '::1' || normalized === '127.0.0.1' || normalized.startsWith('127.')
    const forwarded = req.headers['x-forwarded-for']
    if (socketIsLoopback && typeof forwarded === 'string' && forwarded.length > 0) {
      const first = forwarded.split(',')[0]?.trim() ?? ''
      if (first.length > 0) return first.startsWith('::ffff:') ? first.slice(7) : first
    }
    return normalized.length > 0 ? normalized : 'unknown'
  }

  /** 该来源还剩多少毫秒冷却；0 表示可以继续尝试。 */
  function pairingGuessCooldownMs(req: IncomingMessage, now: number): number {
    const bucket = codeGuessBuckets.get(pairingSourceKey(req))
    if (bucket === undefined) return 0
    return bucket.blockedUntil > now ? bucket.blockedUntil - now : 0
  }

  /** 记一次猜码失败；达到阈值即让整桶进入冷却（并**留一条**日志 + 审计）。 */
  function notePairingGuessFailure(req: IncomingMessage, now: number): void {
    const key = pairingSourceKey(req)
    const bucket = codeGuessBuckets.get(key)
    if (bucket === undefined || now - bucket.windowStart > CODE_GUESS_WINDOW_MS) {
      codeGuessBuckets.set(key, { failures: 1, windowStart: now, blockedUntil: 0 })
    } else {
      bucket.failures += 1
      if (bucket.failures >= CODE_GUESS_MAX_FAILURES) {
        bucket.failures = 0
        bucket.windowStart = now
        bucket.blockedUntil = now + CODE_GUESS_COOLDOWN_MS
        // 冷却**只记一次**（不是每个被挡的请求都记）：否则猜码本身就能把审计刷满，
        // 把真正的历史挤掉——那等于攻击者顺手毁了取证材料。
        console.warn(`[dsh-mobile] 短码配对猜码过多：来源 ${key} 已冷却 ${CODE_GUESS_COOLDOWN_MS / 1000} 秒`)
        store.record({
          deviceId: '(host)',
          kind: 'deny',
          detail: `短码配对猜码过多，来源 ${key} 已冷却 ${CODE_GUESS_COOLDOWN_MS / 1000} 秒`,
          ok: false,
        })
      }
    }
    // 无界增长防护：只在桶数异常多时清理"窗口已过且不在冷却"的桶
    if (codeGuessBuckets.size > 1024) {
      for (const [bucketKey, entry] of codeGuessBuckets) {
        if (entry.blockedUntil <= now && now - entry.windowStart > CODE_GUESS_WINDOW_MS) codeGuessBuckets.delete(bucketKey)
      }
    }
  }

  /** 猜码成功：整桶清零。 */
  function notePairingGuessSuccess(req: IncomingMessage): void {
    codeGuessBuckets.delete(pairingSourceKey(req))
  }

  /** 能力位收窄：请求 ∩ 已授予 ∩ 宿主上限。缺省按"不请求"处理，避免静默放权。 */
  function narrowCapabilities(
    requested: Partial<DeviceCapabilities> | undefined,
    granted: DeviceCapabilities,
  ): DeviceCapabilities {
    const out: DeviceCapabilities = { ...DEFAULT_CAPABILITIES }
    for (const key of Object.keys(DEFAULT_CAPABILITIES) as (keyof DeviceCapabilities)[]) {
      // 基础只读能力（fsRead）默认随设备授予，其余必须显式请求且三重允许
      const wanted = requested === undefined ? key === 'fsRead' : requested[key] === true
      out[key] = Boolean(granted[key] && ceiling[key] && wanted)
    }
    return out
  }

  /** 把隧道内的 RPC 载荷转成 Gateway 调用参数（与 DSH 的 remoteRequest 语义一致）。 */
  function toGatewayArgs(
    endpoint: string,
    payload: unknown,
    signal: AbortSignal,
  ): { namespace: string; method: string; args: Readonly<Record<string, unknown>>; signal: AbortSignal } {
    const { namespace, method } = parseEndpoint(endpoint)
    if (typeof payload !== 'object' || payload === null) {
      throw Object.assign(new Error('Remote payload must be a plain object'), { code: ErrorCode.HandshakeMalformed })
    }
    const record = payload as Record<string, unknown>
    if (!Object.hasOwn(record, 'args') || Object.keys(record).length !== 1) {
      throw Object.assign(new Error('Remote payload must contain exactly one args field'), {
        code: ErrorCode.HandshakeMalformed,
      })
    }
    const args = record['args']
    if (typeof args !== 'object' || args === null || Array.isArray(args)) {
      throw Object.assign(new Error('Remote args must be a plain object'), { code: ErrorCode.HandshakeMalformed })
    }
    return { namespace, method, args: args as Record<string, unknown>, signal }
  }

  /**
   * 能力位 → 命名空间门禁。
   * 只读命名空间对已配对设备开放；写操作与 shell 需要对应能力位。
   */
  /**
   * 能力位门禁：**默认放行只读，只拦需要额外授权的能力**。
   *
   * ## 为什么不是"白名单优先、其余默认拒绝"（真实事故）
   *
   * 早期实现是"只有列在只读名单里的命名空间才放行，其它一律拒绝"。看起来很安全，
   * 实际把 **DSH 前端自己启动时必需的命名空间**也拒了——审计里留下的是：
   *
   * ```
   * deny | namespace agentPresets is not enabled for mobile devices
   * deny | namespace dynamicCordisRunner is not enabled for mobile devices
   * deny | namespace credentials is not enabled for mobile devices
   * ```
   *
   * 后果极具误导性：手机上界面起不来、或加载出来了但**任何操作都无效**，
   * 而隧道是通的、设备是已授权的、日志里也没有"连接失败"——因为失败的是业务调用，
   * 不是连接。用户看到的是"操作不了"，根本无从判断是权限被拦。
   *
   * ## 正确的边界
   *
   * 能力位要管的是**"这台设备能不能写文件、执行命令、反向控制手机"**，
   * 而不是逐个列举客户端会用到哪些命名空间——后者必然跟不上上游变化，
   * 而且客户端的启动路径会随版本变动，枚举法注定失效。
   *
   * 因此：**默认放行**（DSH 自身的会话权限/审批机制仍然生效），
   * 只对**明确的写/执行/反向控制操作**要求对应能力位。
   * 真正的授权边界由 DSH 的权限预设与审批承担，不该由本插件重复实现一遍。
   */
  /**
   * 把一元调用送进网关，走**与 DSH 自己连接层相同**的入口。
   *
   * ## 为什么不是直接 `gateway.invoke()`
   *
   * DSH 的连接层是这么接的（`dsh-api-gateway` 的 apply）：
   *
   * ```js
   * connectionCtx.connection.rpc.intercept('/api',
   *   (endpoint) => this.claimsEndpoint(endpoint),
   *   (endpoint, payload, signal) => this.dispatchRpc(endpoint, payload, signal))
   * ```
   *
   * 也就是说，凡是网关**自己认领**的端点，都从 `dispatchRpc` 进。而 `$events/result`
   * 恰恰不在反射表里 —— 它只在 `dispatchRpc` 里被特判（`claimsEndpoint` 对它直接
   * `return true`）。我原先一律调 `gateway.invoke()`，它会把 `$events/result`
   * 当成普通 Remote 方法去反射表里查找，于是**必然抛错**。
   *
   * 症状极具误导性：手机上点「允许」，电脑侧那次调用每次都失败，而审批最终由宿主的
   * 兜底决定 —— 表现就是"选择回不到电脑"。而审计里因为 `finally` 的写法还把失败
   * 记成了成功，把我往"传输没问题"的方向带偏了一轮。
   *
   * `dispatchRpc` 返回的是标准信封 `{ok, value}` / `{ok:false, error}`，
   * 所以这里把它还原成"成功给值、失败抛错"，与其余端点的语义保持一致。
   */
  async function invokeGatewayEndpoint(
    gateway: RemoteGateway,
    endpoint: string,
    payload: unknown,
    signal: AbortSignal,
  ): Promise<unknown> {
    // 网关特判的端点：它们不是反射出来的 Remote 方法，只能走 dispatchRpc。
    // 目前只有 `$events/result`（转发事件的回答）。名单写死是有意的 ——
    // 它对应 DSH 里唯一一处 `claimsEndpoint` 的无条件 `return true`。
    if (endpoint === '$events/result') {
      const dispatch = gateway as unknown as {
        dispatchRpc?: (
          endpoint: string,
          payload: unknown,
          signal: AbortSignal,
        ) => Promise<{ ok: true; value: unknown } | { ok: false; error: { code?: string; message?: string; details?: unknown } }>
      }
      if (typeof dispatch.dispatchRpc !== 'function') {
        throw Object.assign(new Error('当前 DSH 未提供 gateway.dispatchRpc，无法回传转发事件的结果'), {
          code: ErrorCode.CapabilityDenied,
        })
      }
      const envelope = await dispatch.dispatchRpc(endpoint, payload, signal)
      if (envelope.ok === true) return envelope.value
      const failure = envelope.error ?? {}
      throw Object.assign(new Error(String(failure.message ?? 'gateway rejected the call')), {
        code: typeof failure.code === 'string' ? failure.code : ErrorCode.CapabilityDenied,
        details: failure.details,
      })
    }
    return gateway.invoke(toGatewayArgs(endpoint, payload, signal))
  }

  /**
   * ★★ **只给隧道用** 的取数入口 ✓：返回**整个信封**（含 `attachments` ✓，字节在那里 ✓）。
   *
   * ★★★ 与 `invokeGatewayEndpoint` 的关系（这是我上次弄挂聊天记录的地方 ✗）：
   *   `invokeGatewayEndpoint` **必须保持原样**（返回 `gateway.invoke(...)` = 信封 ✓）——
   *   聊天桥的 `unwrap()` 就是按信封写的 ✓，改它 ⇒ 会话清单/聊天记录整条挂 ✗。
   *   所以本函数**另起一个**入口 ✓，只服务隧道那条路 ✓。
   */
  async function invokeGatewayEnvelope(
    gateway: RemoteGateway,
    endpoint: string,
    payload: unknown,
    signal: AbortSignal,
  ): Promise<{ readonly envelope: unknown }> {
    const dispatch = gateway as unknown as {
      dispatchRpc?: (endpoint: string, payload: unknown, signal: AbortSignal) => Promise<unknown>
    }
    if (typeof dispatch.dispatchRpc === 'function') {
      /**
       * ★ 宿主侧 RPC 入口（`connection.rpc.intercept('/api', …)` 用的就是它 ✓）：
       *   它返回的才是**带附件表的信封** ✓（`encodeRpcResult` 在那里把字节换成 null 占位 + 收进 attachments ✓）。
       * ★ `dispatchRpc` **失败不抛**、返回 `{ok:false,error}` ✗ ⇒ 这里转成 throw ✓。
       */
      const raw = await dispatch.dispatchRpc(endpoint, payload, signal)
      if (raw !== null && typeof raw === 'object' && (raw as { ok?: unknown }).ok === false) {
        const failure = (raw as { error?: { code?: unknown; message?: unknown } }).error ?? {}
        throw Object.assign(new Error(String(failure.message ?? '网关拒绝了这次调用')), {
          code: typeof failure.code === 'string' ? failure.code : ErrorCode.Internal,
        })
      }
      return { envelope: raw }
    }
    // ★ 旧 DSH 没有 dispatchRpc ⇒ 回退老路（拿不到附件表，但**行为与今天完全一致** ✓，不回退就会更糟 ✗）
    store.record({ deviceId: '(host)', kind: 'rpc', target: endpoint, detail: 'entry=invoke-fallback', ok: true })
    return { envelope: await gateway.invoke(toGatewayArgs(endpoint, payload, signal)) }
  }

  function capabilityCheck(device: DeviceRecord, endpoint: string): { ok: true } | { ok: false; code: string; message: string } {
    /** 显式规则：命中即要求对应能力位（未命中则放行）。 */
    const required: Record<string, keyof DeviceCapabilities> = {
      // 文件写：把工作区里的文件改掉
      'workspaceFiles/write': 'fsWrite',
      'workspaceFiles/remove': 'fsWrite',
      'workspaceFiles/mkdir': 'fsWrite',
      'workspaceFiles/rename': 'fsWrite',
      'workspaceFiles/move': 'fsWrite',
      // 工作区本身的增删
      'workspace/create': 'fsWrite',
      'workspace/remove': 'fsWrite',
      // 任意命令执行
      'mobile/shell': 'fsShell',
      // 反向控制（M5）：手机的文件与控制权
      'phone/files': 'phoneFs',
      'phone/control': 'phoneControl',
    }

    let need = required[endpoint]

    // 前缀规则：workspaceFiles 下的**未知**写类操作也按 fsWrite 处理，
    // 避免上游新增一个 `workspaceFiles/xxx-write` 就绕过门禁。
    if (need === undefined && endpoint.startsWith('workspaceFiles/')) {
      const action = endpoint.slice('workspaceFiles/'.length)
      if (/^(write|remove|delete|mkdir|rename|move|copy|upload|save)/.test(action)) need = 'fsWrite'
    }

    if (need !== undefined && !device.capabilities[need]) {
      return {
        ok: false,
        code: ErrorCode.CapabilityDenied,
        message: `device lacks capability ${need} for ${endpoint}`,
      }
    }
    return { ok: true }
  }

  /**
   * 把一条 WebSocket 连接装配成隧道会话。
   *
   * 这里是**会话的接线处**：设备解析用 `resolveDeviceForHandshake`（票据优先），
   * 业务调用先过 `capabilityCheck` 授权，再转发给 DSH 的 Typert 网关。
   */
  /**
   * 在一条**已建立的连接**上跑一个隧道会话。
   *
   * 参数刻意泛化成「发一个字节数组 + 对端关闭时通知我」两件事：
   * `TunnelSession` 本来就只依赖这两件事，与传输无关。于是同一条会话逻辑
   * 既能接入站的 WebSocket（手机连进来），也能接**出站**的连接（电脑拨到中继）——
   * 握手、设备认证、能力门禁、审计全部照旧，一行都不用改。
   */
  function createTunnelSession(send: (bytes: Uint8Array) => boolean, onClosed: () => void): TunnelSession {
    const resolveEstablishedDevice = (): DeviceRecord | undefined => {
      const established = session.established
      return established === undefined ? undefined : store.get(established.deviceId)
    }

    // ⚠️ 必须是 `let` + 先声明后赋值，**不能**写成 `const session = new TunnelSession(...)`：
    //    委托里的闭包会在**构造期间**读 `session`，用 const 会触发 TDZ
    //    （"Cannot access 'session' before initialization"），
    //    而这个异常发生在 WebSocket 的 open 回调里，没人 catch —— socket 半开着、
    //    中继等到认证超时。真实踩过。
    let session: TunnelSession
    session = new TunnelSession(
      {
        resolveDevice: (hello) => {
          const resolved = resolveDeviceForHandshake(hello)
          if (process.env['DSH_MOBILE_SIG_DEBUG'] === '1' && resolved !== undefined) {
            console.log(
              `[sig] 宿主解析到的设备：id=${resolved.deviceId} 签名公钥前 24 字符=${resolved.deviceSigningKey.slice(0, 24)} 长度=${resolved.deviceSigningKey.length} 指纹=${resolved.fingerprint}`,
            )
          }
          return resolved
        },
        invoke: async (request, signal) => {
          const device = resolveEstablishedDevice()
          if (device === undefined) {
            throw Object.assign(new Error('session has no bound device'), { code: ErrorCode.DeviceUnknown })
          }
          // 插件自有的隧道内端点在能力门禁**之前**处理：它们不是 DSH 的命名空间，
          // 门禁不认识它们；设备身份已由上面的 resolveEstablishedDevice 保证。
          const local = await invokeLocalEndpoint(request.endpoint, request.payload, signal, device)
          if (local !== undefined) {
            store.record({ deviceId: device.deviceId, kind: 'rpc', target: request.endpoint, detail: 'local', ok: true })
            // ★ 本地端点返回的是**值** ⇒ 包成信封（= 改动前 tunnel 那层包法 ✓，形状不变 ✓）
            return { ok: true, value: local }
          }
          const gate = capabilityCheck(device, request.endpoint)
          if (!gate.ok) {
            store.record({ deviceId: device.deviceId, kind: 'deny', target: request.endpoint, detail: gate.message, ok: false })
            throw Object.assign(new Error(gate.message), { code: gate.code })
          }
          const started = Date.now()
          try {
            // ★ 隧道要的是**信封**（含 attachments ✓）——走只给隧道用的那个入口 ✓，
            //   而 `invokeGatewayEndpoint` **一个字没动** ✓（聊天桥依赖它的契约 ✓）。
            const value = (await invokeGatewayEnvelope(options.gateway, request.endpoint, request.payload, signal)).envelope
            /**
             * ★★★ 只读诊断（再次加回 ✓）：回答"信封里到底有没有 attachments"。
             *   · 不改任何逻辑 ✓；结果出现在自检页 diagnostics 里（tag=attachments-probe ✓）。
             *   · 三种读数对应三种结论 ✗：n=0 ⇒ 有附件表但是空的；n>0 ⇒ **有字节**（那就是客户端没装上）；
             *     none ⇒ 这条路上根本没有附件表（入口还是不对 ✓）。
             */
            try {
              const probeList = (value as { readonly attachments?: unknown } | null | undefined)?.attachments
              store.record({
                deviceId: device.deviceId,
                kind: 'rpc',
                target: request.endpoint,
                detail: 'attachments-probe n=' + (Object.prototype.toString.call(probeList) === '[object Array]' ? String((probeList as unknown[]).length) : 'none'),
                ok: true,
              })
            } catch (error) {
              void error
            }
            // ★ 成功才记 ok:true。原先这里写成 `finally { … ok: true }`，于是**每一次失败**
            //   都会额外留下一条 `12ms / ok:true` —— 审计里看到的是成对的
            //   `failed` + `12ms(ok)`，一眼看过去像"重试后成功"，实际是同一个失败被记了两次。
            //   我据此判断错过一次（"24 次 $events/result 都成功了"），所以这条必须修。
            store.record({
              deviceId: device.deviceId,
              kind: 'rpc',
              target: request.endpoint,
              detail: `${Date.now() - started}ms`,
              ok: true,
            })
            return value
          } catch (error) {
            // ★ 失败要带**原因**。原先只记 `failed` 两个字，于是"端点不存在""参数形状不对"
            //   "服务不可用"在审计里完全一样，只能靠猜（`$events/result` 那个 bug 就是这么绕远的）。
            const message = error instanceof Error ? error.message : String(error)
            store.record({
              deviceId: device.deviceId,
              kind: 'rpc',
              target: request.endpoint,
              detail: `failed: ${message.slice(0, 160)}`,
              ok: false,
            })
            throw error
          }
        },
        openStream: (request, signal) => {
          const device = resolveEstablishedDevice()
          if (device === undefined) {
            throw Object.assign(new Error('session has no bound device'), { code: ErrorCode.DeviceUnknown })
          }
          const gate = capabilityCheck(device, request.endpoint)
          if (!gate.ok) {
            // 流式调用此前**没有审计**：一旦被门禁拒绝，手机上表现为"发送无反应"，
            // 而审计里什么都看不到——排查时完全无从下手。这里补上。
            store.record({ deviceId: device.deviceId, kind: 'deny', target: request.endpoint, detail: gate.message, ok: false })
            throw Object.assign(new Error(gate.message), { code: gate.code })
          }
          return {
            async *[Symbol.asyncIterator]() {
              const started = Date.now()
              try {
                const iterable = await openGatewayStream(request.endpoint, request.payload, signal)
                yield* iterable
                // 流正常结束才记成功：否则"流被拒/中断"会伪装成成功，掩盖真实故障
                store.record({ deviceId: device.deviceId, kind: 'stream', target: request.endpoint, detail: `${Date.now() - started}ms`, ok: true })
              } catch (error) {
                // 记录**原因**而不只是 "failed"：只写 failed 时，
                // 手机上"操作无效"而审计里看不出任何线索（本项目真实踩过）
                const reason = error instanceof Error ? error.message : String(error)
                store.record({ deviceId: device.deviceId, kind: 'stream', target: request.endpoint, detail: `failed: ${reason}`, ok: false })
                throw error
              }
            },
          }
        },
        onEstablished: (established) => {
          sessions.set(established.deviceId, session)
          store.touch(established.deviceId)
          store.record({
            deviceId: established.deviceId,
            kind: 'connect',
            detail: `session=${established.sessionId} authorization=${established.authorization}`,
            ok: true,
          })
        },
        onClosed: () => {
          const device = resolveEstablishedDevice()
          if (device !== undefined) {
            sessions.delete(device.deviceId)
            store.record({ deviceId: device.deviceId, kind: 'disconnect', detail: 'tunnel closed', ok: true })
          }
          onClosed()
        },
      },
      send,
    )
    // 宿主身份必须在 acceptHello 之前注入（握手要用它签名）
    session.hostId = options.identity.hostId
    session.hostSigningKey = options.identity.signingKey
    return session
  }

  /** 入站路径：手机连进来的那条 WebSocket 上跑一个会话。 */
  function attachSession(connection: WebSocketConnection): void {
    const session = createTunnelSession(
      (bytes) => connection.send(bytes),
      () => connection.close(),
    )
    connection.onMessage((data) => session.receive(data))
    connection.onClose(() => session.close('socket closed'))
  }

  /**
   * 中继外拨：主动拨出去，并**保持若干条空闲连接**。
   *
   * 为什么是"池"而不是一条：中继按房间把**一条手机连接**配给**一条电脑连接**，
   * 配对后这条连接就被"用掉"了（一个 TunnelSession 只服务一个设备）。
   * 所以要保持空闲条数，手机（以及第二台设备）来了才有得配，用完即补。
   *
   * 失败重连用固定 3 秒间隔而不是指数退避：中继重启是**预期事件**（升级/运维），
   * 早一点补上连接，用户体验就是"手机自动恢复"而不是"等半分钟"。
   * 每次只有一个定时器、且只在连接关闭后才会排下一次，所以不会堆积。
   */
  function startRelayDialer(): () => void {
    const url = config.relayUrl
    if (typeof url !== 'string' || url.length === 0) return () => {}
    const configured = Number(config.relayPoolSize)
    const poolSize = Math.max(1, Math.min(8, Number.isFinite(configured) ? configured : 2))
    const room = fingerprint(options.identity.signingKey.publicKey)
    const endpoint = `${url}${url.includes('?') ? '&' : '?'}room=${encodeURIComponent(room)}`
    const live = new Set<WebSocket>()
    let stopped = false

    const dial = (): void => {
      if (stopped) return
      let socket: WebSocket
      try {
        socket = new WebSocket(endpoint)
      } catch (error) {
        console.error('[dsh-mobile] 中继地址无法解析，已停用外拨：', error)
        return
      }
      socket.binaryType = 'arraybuffer'
      live.add(socket)
      let session: TunnelSession | undefined

      socket.addEventListener('open', () => {
        // 整个 open 处理都要兜底：这里的异常没人接，会留下一条"半开"的连接——
        // 中继那边表现为"电脑连上了却不发密钥"，极难定位（真实踩过）。
        try {
          // 共享密钥走**首条消息**：不进 URL，也就不会进中继的访问日志与反代日志
          socket.send(config.relayToken ?? '')
          session = createTunnelSession(
          (bytes) => {
            try {
              socket.send(bytes)
              return true
            } catch {
              return false
            }
          },
            () => {
              try {
                socket.close()
              } catch {
                /* 可能已关闭 */
              }
            },
          )
          console.log(`[dsh-mobile] 中继连接已建立（房间 ${room}）`)
        } catch (error) {
          console.error('[dsh-mobile] 中继连接建立失败：', error)
          try {
            socket.close()
          } catch {
            /* 忽略 */
          }
        }
      })

      socket.addEventListener('message', (event) => {
        // token 认证阶段中继不该发数据；会话建立后一律投递给会话
        if (session === undefined) return
        const data = event.data as ArrayBuffer | ArrayBufferView
        if (data instanceof ArrayBuffer) session.receive(new Uint8Array(data))
        else if (ArrayBuffer.isView(data)) {
          session.receive(new Uint8Array(data.buffer, data.byteOffset, data.byteLength))
        }
      })

      const retire = (): void => {
        live.delete(socket)
        session?.close('relay socket closed')
        if (!stopped) setTimeout(dial, 3000)
      }
      socket.addEventListener('close', retire)
      // error 之后必然会来 close，统一在 close 里补连接，避免重复排定时器
      socket.addEventListener('error', () => {
        console.warn('[dsh-mobile] 中继连接出错，将重试')
      })
    }

    for (let index = 0; index < poolSize; index++) dial()
    console.log(`[dsh-mobile] 中继外拨已启动：${url}（房间 ${room}，空闲池 ${poolSize}）`)
    return () => {
      stopped = true
      for (const socket of live) {
        try {
          socket.close()
        } catch {
          /* 忽略 */
        }
      }
    }
  }

  /**
   * 握手时解析设备。
   *
   * **优先级很重要：有效的配对票据高于已有的设备记录。**
   *
   * 为什么：设备可能用同一个 deviceId 重新配对——手机浏览器清空存储、App 重装、
   * Flutter 端换了 Keystore 密钥，都会得到"同一个 id、新的公钥"。
   * 若先查注册表，宿主会拿**旧公钥**去验新设备的签名，结果是
   * `mobile/handshake-signature`——一个看起来像"被攻击"、实际只是"该更新记录了"的报错。
   * 而配对票据是用户刚刚在电脑端**人工确认过**的凭据，它才是当前有效的那一份。
   */
  function resolveDeviceForHandshake(hello: ClientHelloPayload): HostDeviceCredentials | undefined {
    // 1) 携带票据时以票据为准（首次配对 / 重新配对）——但**票据不可用不等于设备不可用**。
    //
    //    票据是一次性的：首次握手成功后被消费，或超时后作废。而手机上的页面很可能
    //    仍带着 `?pair=<ticket>`（配对后的重载、用户收藏的链接、隧道断开后的重连都会），
    //    于是重连时送来的是一张**过期票据**。早期这里直接抛错，症状就是
    //    **"隧道断开后一直重连失败，必须重新配对"**——而设备其实一直好好地配对在那儿。
    //
    //    所以：票据类错误**先尝试回退到设备注册表**；只有当设备也不可用时，
    //    才把原来的票据错误抛出去（这样"新设备等待电脑确认"的行为完全不变）。
    if (hello.pairingTicket !== undefined) {
      try {
        return resolveByTicket(hello)
      } catch (error) {
        const code = (error as { code?: string }).code
        const ticketProblem =
          code === ErrorCode.PairingTicketInvalid || code === ErrorCode.PairingPending || code === ErrorCode.PairingRejected
        const usable = ticketProblem ? store.resolveUsable(hello.deviceId) : { ok: false as const, reason: 'unknown' as const }
        if (!ticketProblem || !usable.ok) throw error
        const device = usable.device
        store.record({
          deviceId: device.deviceId,
          kind: 'connect',
          detail: '票据已失效，按已配对设备继续（无需重新配对）',
          ok: true,
        })
        return {
          deviceId: device.deviceId,
          devicePublicKey: device.devicePublicKey,
          deviceSigningKey: device.deviceSigningKey,
          fingerprint: device.fingerprint,
          capabilities: narrowCapabilities(hello.requestedCapabilities, device.capabilities),
          authorization: device.authorization,
        }
      }
    }

    // 2) 无票据：走设备注册表
    const usable = store.resolveUsable(hello.deviceId)
    if (usable.ok) {
      const device = usable.device
      return {
        deviceId: device.deviceId,
        devicePublicKey: device.devicePublicKey,
        deviceSigningKey: device.deviceSigningKey,
        fingerprint: device.fingerprint,
        capabilities: narrowCapabilities(hello.requestedCapabilities, device.capabilities),
        authorization: device.authorization,
      }
    }
    if (usable.reason === 'revoked') {
      store.record({ deviceId: hello.deviceId, kind: 'deny', detail: '已撤销设备尝试连接', ok: false })
      return undefined
    }
    if (usable.reason === 'expired') {
      store.record({ deviceId: hello.deviceId, kind: 'deny', detail: '设备授权已过期', ok: false })
      return undefined
    }
    return undefined
  }

  /**
   * 把一条 **claim** 登记成设备记录（幂等 ✓ —— 允许时登记一次、握手成功时再登记一次 ✓）。
   *
   * ## ★ 为什么"点允许"这一刻就要登记（本轮修的那条路）
   *
   * 原先是**只有握手成功**（`resolveByTicket`）才 `store.upsert` ✗。于是电脑端点了
   * 「允许此设备」之后发生的是：
   *   · 「待确认设备」里那一行**消失了** ✓（state 变 `approved` ✓，而配对页只渲染
   *     `claimed`/`open` ✓）—— 看起来像"已经处理好了"✓；
   *   · 「已授权设备」列表**仍然是空的** ✗（设备还没握手 ⇒ 从没登记过 ✓）。
   * 用户看到的就是"允许以后不出现新的已授权设备"✗，而**真正**的原因（手机那边握手没成功）
   * 在这块界面上**一点痕迹都没有** ✗✗ —— 两个问题叠在一起，现象完全不可分辨 ✗。
   *
   * 现在"允许"这一步就把设备登记下来 ✓：
   *   · 列表**立刻**可见 ✓、可撤销 ✓、审计可追溯 ✓；
   *   · 手机真正连上来时 `resolveByTicket` 再登记一次（幂等 ✓，并补上 `lastSeenAt` ✓）。
   *
   * ## 指纹仍然是人工比对的那一把
   * 登记用的 `deviceSigningKey` / `fingerprint` 就是 claim 里提交、并在电脑端**显示给人比对**
   * 的那一份 ✓ —— 登记时刻提前，不改变"比对的是谁" ✓。
   *
   * 重新配对时保留电脑端原先授予的能力位（理由同 `resolveByTicket` ✓）。
   */
  function registerClaimedDevice(
    claim: PairClaimRequest,
    kind: 'pair' | 'authorize',
    detail: string,
  ): DeviceRecord {
    const previous = store.get(claim.deviceId)
    const record: DeviceRecord = {
      deviceId: claim.deviceId,
      devicePublicKey: claim.devicePublicKey ?? '',
      deviceSigningKey: claim.deviceSigningKey,
      fingerprint: claim.fingerprint,
      name: claim.name,
      ...(claim.model === undefined ? {} : { model: claim.model }),
      ...(claim.platform === undefined ? {} : { platform: claim.platform }),
      pairedAt: previous?.pairedAt ?? new Date().toISOString(),
      authorization: 'persistent',
      capabilities: previous?.capabilities ?? { ...DEFAULT_CAPABILITIES },
    }
    store.upsert(record)
    store.record({ deviceId: claim.deviceId, kind, detail, ok: true })
    return record
  }

  /** 按配对票据解析设备（含首次登记与重新配对时更新公钥）。 */
  function resolveByTicket(hello: ClientHelloPayload): HostDeviceCredentials {
    {
      const entry = pendingByTicket.get(hello.pairingTicket!)
      if (entry === undefined) {
        throw Object.assign(new Error('pairing ticket is invalid or expired'), { code: ErrorCode.PairingTicketInvalid })
      }
      if (entry.state === 'open' || entry.state === 'claimed') {
        throw Object.assign(new Error('pairing is awaiting confirmation on the host'), { code: ErrorCode.PairingPending })
      }
      if (entry.state === 'rejected' || entry.state === 'expired') {
        throw Object.assign(new Error('pairing was rejected on the host'), { code: ErrorCode.PairingRejected })
      }
      const claim = entry.claim
      if (claim === undefined || claim.deviceId !== hello.deviceId) {
        throw Object.assign(new Error('pairing ticket does not belong to this device'), {
          code: ErrorCode.PairingTicketInvalid,
        })
      }
      // 重新配对时保留电脑端原先授予的能力位：设备换了密钥不等于用户同意放宽/收紧权限，
      // 静默重置会让已授予的 fsWrite 等权限莫名消失（或反向地悄悄放权）。
      const record = registerClaimedDevice(
        claim,
        'pair',
        store.get(claim.deviceId) === undefined ? '配对完成并完成首次连接' : '重新配对：已更新设备公钥，保留原有授权',
      )
      pendingByTicket.delete(entry.ticket.ticket)
      return {
        deviceId: record.deviceId,
        devicePublicKey: record.devicePublicKey,
        deviceSigningKey: record.deviceSigningKey,
        fingerprint: record.fingerprint,
        capabilities: narrowCapabilities(hello.requestedCapabilities, record.capabilities),
        authorization: 'persistent',
      }
    }
  }

  /**
   * 发起一次端侧请求。成功返回请求 id；失败返回**原因字符串**而不是抛错——
   * 调用方（HTTP 路由 / agent 工具）都要把原因讲给用户或 agent 听。
   *
   * ★ 第 90 轮（真机 bug）：**目标不再按"此刻谁连着本机"来选** ✗✗。
   *
   * 改之前这里是这样挑目标的：
   * ```
   * const online = [...sessions.keys()]
   * const target = deviceId ?? (online.length === 1 ? online[0]! : undefined)
   * ```
   * 于是**手机切到另一台电脑**时（它到本机的隧道就断了 ✓，审计里 connect/disconnect
   * 与"切电脑"逐次对上 ✓）`online` 为空 ⇒ 直接回"目前没有设备在线"✗ ⇒
   * 提权通知**根本没入队**（真机审计：同一次提权只有 `approval-push` ✓、
   * 没有配套的 `mobile/device/call` ✗）⇒ 手机永远收不到 ✗。
   *
   * 现在：**选目标只看"设备可用 + 启用了这个能力"**（判定收在纯函数
   * `selectDeliveryTargets` 里 ✓），不指定 deviceId 时写给**所有**这样的设备 ✓；
   * 不在线只意味着"到它下次来取时才送达" ✓，而不是丢掉 ✗。
   * ★ "当前连接"这个概念**没有**被拆掉 ✗：它照旧存在于 `sessions` / 会话页那条链上 ✓，
   *   只是**不再参与"发给谁"的判定** ✓。
   */
  function deviceCall(
    capability: string,
    text: string,
    deviceId?: string,
    sessionId?: string,
    /**
     * ★ 2026-10-05：系统通知的标题（可选 ✓，只有 `notify` 用得上 ✓）。
     *   排在最后 ⇒ 既有调用（HTTP 路由 / agent 工具）一处都不用改 ✓，
     *   不传就是"手机按旧标题显示"✓（行为同今天 ✓）。
     */
    title?: string,
  ): { ok: true; id: string } | { ok: false; reason: string } {
    if (!DEVICE_CAPABILITIES.includes(capability as DeviceCapability)) {
      return { ok: false, reason: `未知的端侧能力：${capability}` }
    }
    /**
     * ★ 这里只**收集事实**（谁配对过、谁可用、谁启用了这个能力、此刻在不在线 ✓），
     *   判定本身一行都不在 ✗ —— 它收在 `selectDeliveryTargets` 里（可断言、可变异验证 ✓）。
     * ★ 用 `store.list()` 而**不是** `sessions` 是关键 ✗✗：**已配对但此刻没连着**的设备
     *   必须在候选里 ✓，否则老 bug 会原样复现 ✗。
     */
    const online = new Set(sessions.keys())
    const selection = selectDeliveryTargets(
      deviceId,
      capability,
      store.list().map((device) => ({
        deviceId: device.deviceId,
        online: online.has(device.deviceId),
        usable: store.resolveUsable(device.deviceId).ok,
        enabled: deviceCalls.isEnabled(device.deviceId, capability),
      })),
    )
    if (!selection.ok) {
      // ★ 失败要看得见 ✗：否则"没送到"在审计里只剩一条 `approval-push`，
      //   "没入队"与"入队了但没人取"分不清（用户这次实测就卡在这一点上 ✓）。
      store.record({
        deviceId: deviceId ?? '(host)',
        kind: 'deny',
        target: 'mobile/device/call',
        detail: selection.reason,
        ok: false,
      })
      return { ok: false, reason: selection.reason }
    }
    const ids: string[] = []
    for (const target of selection.targets) {
      try {
        const call = deviceCalls.enqueue(
          target,
          capability as DeviceCapability,
          String(text ?? '').slice(0, 500),
          sessionId,
          // ★ 标题也夹在同一道上限里（它比正文短得多，但形状上不留"无限长"的口子 ✗）
          title === undefined ? undefined : String(title).slice(0, 120),
        )
        store.record({ deviceId: target, kind: 'rpc', target: 'mobile/device/call', detail: capability, ok: true })
        ids.push(call.id)
      } catch (error) {
        // 单台入队失败不影响其它目标（例如它正好在这一瞬间把能力停用了 ✓）
        store.record({
          deviceId: target,
          kind: 'deny',
          target: 'mobile/device/call',
          detail: (error as Error).message,
          ok: false,
        })
      }
    }
    const first = ids[0]
    if (first === undefined) return { ok: false, reason: '没有任何设备接受这次请求（能力可能刚被停用）' }
    // ★ 只回第一个 id（调用方按它查结果 ✓）：广播时其余设备各自的 id 暂不对外暴露 ✗
    //   —— 见交付报告的「不确定的 / 没做的」那一段。
    return { ok: true, id: first }
  }

  /** agent 工具注册结果（由 cordis.ts 在注册完成后写入）。 */
  let agentTool: 'pending' | 'registered' | 'skipped' | 'failed' = 'pending'

  function revokeDevice(deviceId: string): boolean {
    const device = store.get(deviceId)
    if (device === undefined) return false
    store.revoke(deviceId)
    const session = sessions.get(deviceId)
    if (session !== undefined) {
      sessions.delete(deviceId)
      // 立即断开：撤销必须即时生效，不能等下次心跳
      session.close('device revoked by the host')
    }
    store.record({ deviceId, kind: 'revoke', detail: '设备已撤销，隧道已断开', ok: true })
    return true
  }

  /**
   * **彻底删除**一条设备记录（`/mobile/admin/devices/remove` 的唯一实现）。
   *
   * ## 为什么必须有这条正式路由
   *
   * `DeviceStore` 只在构造时 `load()` 一次，之后每次写都是**整张内存表覆盖文件**
   * （`persist()` 写 `[...this.devices.values()]`）。于是"改 `devices.json` 再重启"
   * 是过去唯一的清设备办法——手改文件会被下一次 `touch()` 原样写回，
   * 这是项目文档里反复警告、也反复被踩的一条纪律。走 `store.remove()` 就绕开了它：
   * 内存表与被删的文件**同时**更新，不需要重启。
   *
   * ## 为什么删除要连隧道一起断
   *
   * 与撤销同理：记录没了但**已建立的加密会话还在**，等于"删了还能用，直到它自己断线"。
   * 撤销路径早就这么做（`revokeDevice`），删除没有理由更松。
   */
  function removeDevice(deviceId: string): boolean {
    const existed = store.remove(deviceId)
    if (!existed) return false
    const session = sessions.get(deviceId)
    if (session !== undefined) {
      sessions.delete(deviceId)
      session.close('device removed by the host')
    }
    store.record({ deviceId, kind: 'remove', detail: '设备记录已删除，隧道已断开', ok: true })
    return true
  }

  /** 批量删除所有已撤销记录（`?revoked=1`）。返回删除条数。 */
  function removeRevokedDevices(): number {
    let removed = 0
    // 先取快照再删：`list()` 返回深拷贝，删除过程中不会边遍历边改
    for (const device of store.list()) {
      if (device.authorization !== 'revoked') continue
      if (removeDevice(device.deviceId)) removed += 1
    }
    return removed
  }

  const service: MobileHostService = {
    store,

    createPairing() {
      purgeExpired()
      /**
       * 6 位配对码必须来自**密码学随机源**（T2 / 评估 §3②）。
       *
       * 原先是 `Math.floor(100000 + Math.random() * 900000)`：`Math.random` 不是 CSPRNG，
       * 状态可被观测/预测，而配对码是**唯一**把手机接入这台电脑的短凭据。
       *
       * 用 `randomInt(100000, 1_000_000)`：区间上界**排他**（所以写 1000000 而不是 999999），
       * 实现用拒绝采样，**不存在取模偏差**；取值范围是 [100000, 999999]，恰好 90 万个。
       */
      const code = String(randomInt(100000, 1_000_000))
      const ticketKey = randomTicket()
      const expiresAt = new Date(Date.now() + config.pairingTtlMs).toISOString()
      /**
       * ★ C2：票据顺带带上宿主 TLS 证书（本机 CA）的指纹 —— **可选字段**
       * （`PairingTicket.caFingerprint?`，理由与"为什么必须可选"写在 `wire.ts` 那一段）。
       *
       * 它只服务一件事：原生外壳**第一次**连这台电脑时要做 **TOFU** ——
       * 二维码/配对链接是**带外**通道（用户在电脑屏幕上看到、手机扫到），
       * 所以壳可以拿"从这台电脑取回的 CA 指纹"与"票据里这个值"比对，
       * 一致才落盘并放行，**不需要人眼读十六进制**。
       *
       * ⚠️ 拿不到就**不写这个键**（而不是写 `undefined`）：没注入证书管理器
       * （`options.tls === undefined`）或证书坏了时，票据形状与加字段**之前逐字段相同**
       * ⇒ 旧手机 / 旧宿主那条路一个字都不变。壳那边拿不到它也**不会**"盲信第一次"，
       * 而是退回"把指纹显示给用户、要用户明确确认"（见 `16` §4.2 第 3 条）。
       */
      const caFingerprint = options.tls?.status().caFingerprint
      const ticket: PairingTicket = {
        v: 1,
        hostId: options.identity.hostId,
        hostFingerprint: fingerprint(options.identity.signingKey.publicKey),
        code,
        ticket: ticketKey,
        /**
         * ★★★ 2026-10-04 真机逼出来的（用户："首页扫码连不上，体验会差"✗ + "它会收集配对页 3081 这个端口"✗）：
         *   票据的端点原先 = `publicBaseUrl`（**明文 http** ✗，它是给电脑浏览器用的 ✓）+ `extraEndpoints` ✓。
         *   而**手机 App 是 https-only** ✓（禁明文 ✓）⇒ 手机拿到的**第一条候选连 TLS 都开始不了** ✗
         *   ⇒ 不弹"信任这台电脑"框 ✓ ⇒ 退回旧候选 ⇒ 用户看到"配对失败 / 重连"、也不出新卡片 ✓✓
         *   （三件事同一个原因 ✓，用户实测：手动输入 `https://…:3443/mobile` 就会弹框 ✓）。
         * ⇒ 票据（**只给手机看** ✓）里**只放 https** ✓，明文那条不再下发 ✓。
         * ★ 兜底：万一这台机器**没开 TLS**（一台 https 端点都没有 ✓）⇒ 保持原样 ✓，
         *   绝不把列表清空 ✗（那会让手机一条候选都没有 ✓）。
         */
        endpoints: (() => {
          const all = [...options.endpoints()]
          const https = all.filter((url) => url.startsWith('https://'))
          return https.length > 0 ? https : all
        })(),
        protocolVersion: PROTOCOL_VERSION,
        expiresAt,
        ...(caFingerprint === undefined ? {} : { caFingerprint }),
      }
      const entry: PendingPairing = { ticket, state: 'open' }
      pendingByCode.set(code, entry)
      pendingByTicket.set(ticketKey, entry)
      store.record({ deviceId: '(host)', kind: 'pair-code', detail: `配对码 ${code}，有效期至 ${expiresAt}`, ok: true })
      return {
        ticket,
        qrPayload: `dshmobile://pair?d=${Buffer.from(JSON.stringify(ticket), 'utf8').toString('base64url')}`,
        expiresAt,
      }
    },

    listPendingPairings() {
      purgeExpired()
      return [...pendingByCode.entries()].map(([code, entry]) => ({
        code,
        state: entry.state,
        ...(entry.claim === undefined
          ? {}
          : {
              deviceId: entry.claim.deviceId,
              name: entry.claim.name,
              fingerprint: entry.claim.fingerprint,
              ...(entry.claim.model === undefined ? {} : { model: entry.claim.model }),
              ...(entry.claim.platform === undefined ? {} : { platform: entry.claim.platform }),
            }),
      }))
    },

    confirmPairing(code, deviceId, approve) {
      purgeExpired()
      const entry = pendingByCode.get(code)
      if (entry === undefined || entry.claim === undefined || entry.claim.deviceId !== deviceId) return false
      entry.state = approve ? 'approved' : 'rejected'
      /**
       * ★ 点「允许此设备」= **真的**把设备登记为已授权 ✓（本轮修的那条路 ✓）。
       *
       * 原先这里只改内存里的 pending state ✗ ⇒ 列表要等手机握手成功才出现 ✗，
       * 于是"允许了却什么都没发生"（用户原话："允许以后不出现新的已授权设备"✓）。
       * 登记与握手成功走**同一个** `registerClaimedDevice` ✓（一个概念一套实现 ✓）。
       */
      if (approve) {
        registerClaimedDevice(entry.claim, 'authorize', '电脑端已允许：设备已登记为已授权（等待手机完成握手）')
      }
      store.record({
        deviceId,
        kind: 'pair-confirm',
        detail: approve ? '电脑端已确认设备指纹' : '电脑端拒绝配对',
        ok: approve,
      })
      return true
    },

    listDevices: () => store.list(),

    updateDevice(deviceId, update) {
      if (update.authorization === 'persistent' && !config.allowPersistentAuthorization) {
        throw Object.assign(new Error('persistent authorization is disabled by configuration'), {
          code: ErrorCode.CapabilityDenied,
        })
      }
      if (update.capabilities !== undefined) {
        for (const [key, value] of Object.entries(update.capabilities)) {
          if (value === true && ceiling[key as keyof DeviceCapabilities] !== true) {
            throw Object.assign(new Error(`capability ${key} exceeds the host ceiling`), {
              code: ErrorCode.CapabilityDenied,
            })
          }
        }
      }
      const result = store.updateAuthorization(deviceId, {
        ...(update.authorization === undefined ? {} : { authorization: update.authorization }),
        ...(update.capabilities === undefined ? {} : { capabilities: update.capabilities }),
        ...(update.expiresAt === undefined ? {} : { expiresAt: update.expiresAt }),
      })
      if (result !== undefined) {
        store.record({
          deviceId,
          kind: update.authorization === 'revoked' ? 'revoke' : 'authorize',
          detail: `authorization=${result.authorization} capabilities=${JSON.stringify(result.capabilities)}`,
          ok: true,
        })
        if (result.authorization === 'revoked') revokeDevice(deviceId)
      }
      return result
    },

    deviceCall,
    recordDiagnostic: (tag: string, detail: string) => {
      store.record({ deviceId: '(host)', kind: 'rpc', target: tag, detail, ok: true })
    },
    agentToolStatus: () => agentTool,
    /** 由 cordis.ts 调用：把 agent 工具的注册结果记下来（见接口注释）。 */
    setAgentToolStatus: (status: 'registered' | 'skipped' | 'failed') => {
      agentTool = status
    },
    revokeDevice,
    removeDevice,
    removeRevokedDevices,
    listAudit: (auditOptions) => store.listAudit(auditOptions),
    /**
     * 按 **6 位配对码**取出"给手机用的配对载荷"（base64url(UTF-8 JSON)）。
     *
     * 这是**短码配对入口**的核心：手机只需要在浏览器里打开
     * `/mobile/p/<6 位码>`，宿主把码换成票据并跳到应用外壳 ——
     * 于是"配对"这件事不再要求用户把一条 `dshmobile://pair?d=…` 深链
     * 复制粘贴进输入框 ✓（浏览器根本打不开那种深链，这是最初的真实抱怨）。
     *
     * 编码形状必须与 `?pair=` 的约定**逐字节一致**（见 pairing-page.ts 的
     * `encodeTicketPayload` 与 boot.js 的 `readUrlConfig`）：
     * 整个 ticket 对象的 base64url，少一层或换个字段手机就解析失败 ✓。
     */
    pairingPayloadForCode: (code: string): string | undefined => {
      const pairing = pendingByCode.get(String(code).trim())
      if (pairing === undefined) return undefined
      if (pairing.state !== 'open') return undefined
      return Buffer.from(JSON.stringify(pairing.ticket), 'utf8').toString('base64url')
    },
    connectedCount: () => sessions.size,
    connectedSession: (deviceId) => sessions.get(deviceId),

    manifest(): MobileManifest {
      // 说明：manifest 是手机/诊断读取的公开信息，手机基地址本就不算机密（它就在二维码里）
      /**
       * ★ 这里多出两个 `MobileManifest` 里没有的字段（`tls` / `dshFrontend`）。
       *
       * 为什么可以有：当初本阶段**不许改 `packages/protocol`**（交接纪律），而
       * "证书生成失败必须明说"（B1）与"DSH 前端漂移要在 manifest 里提示不兼容"（doc 15 §4.2）
       * 都要求 manifest 带上这两条状态。做法是返回一个**结构上兼容** MobileManifest 的更大对象
       * —— TS 允许，JSON 多两个键，手机端旧代码读到多余字段直接忽略。
       * 字段名刻意加前缀式命名（`tls` / `dshFrontend`），避免将来与 DSH 官方加的字段撞名。
       *
       * ★ 更正（本轮）：`machineName` 已经**正式进了** `MobileManifest` 协议
       *   （`packages/protocol/src/wire.ts` ✓，可选字段 ✓），不再走"结构兼容"这条旁路 ✓。
       *   上面两条仍然是旁路（它们带的是本部署的实现状态 ✓，不是协议字段 ✓）。
       */
      const tls = options.tls?.status()
      const probe = probeDshFrontend(options.distIndex?.())
      /**
       * ★ 机器名（`machineName` ✓，可选字段 ✓）。
       *
       * 取值**只有一个口**：`localMachineName()` ✓（`lan-trust.ts` 里那套
       * `os.hostname()` 处理 ✓，与信任推导 / 证书 SAN 用的是同一个名字 ✓）——
       * 可注入的 `options.hostname` 走同一条路 ✓，测试才演得了"拿不到机器名"✓。
       * 拿不到 ⇒ 空串 ⇒ 下面**省略这个键** ✓（写 `undefined` 会让形状凭空多一个键 ✗）。
       */
      const machineName = localMachineName(options.hostname?.())
      const manifest: MobileManifest & {
        tls?: {
          ok: boolean
          directory: string
          caFingerprint?: string
          error?: string
        }
        dshFrontend?: { status: DshFrontendProbe['status']; hits: number; total: number }
      } = {
        protocolVersion: PROTOCOL_VERSION,
        hostId: options.identity.hostId,
        hostFingerprint: fingerprint(options.identity.signingKey.publicKey),
        hostName: options.identity.hostName,
        // ★ 可选：拿不到机器名就**不出现这个键** ✓（见上面 localMachineName 的说明 ✓）
        ...(machineName === '' ? {} : { machineName }),
        shimUrl: '/mobile/boot.js',
        shimSha256: options.bootScript?.().sha256 ?? '',
        clientBundleVersion: options.clientBundleVersion ?? '0.1.0',
        dshVersion: options.dshVersion ?? 'unknown',
        ...(options.phoneBaseUrl === undefined || options.phoneBaseUrl.length === 0
          ? {}
          : { phoneBaseUrl: options.phoneBaseUrl }),
        features: { pairing: config.enabled, ephemeralKey: true, internet: false, phoneControl: false },
        tls:
          tls === undefined
            ? // 没注入证书管理器：明确说"没有"，而不是省掉这个键（省掉会被读成"没问题"）
              { ok: false, directory: '(未注入)', error: '本部署未注入证书管理器（cordis.ts 未启用）' }
            : {
                ok: tls.ok,
                directory: tls.directory,
                ...(tls.caFingerprint === undefined ? {} : { caFingerprint: tls.caFingerprint }),
                ...(tls.error === undefined ? {} : { error: tls.error }),
              },
        dshFrontend: { status: probe.status, hits: probe.hits, total: probe.total },
      }
      return manifest
    },

    /**
     * 自检的纯数据部分（HTTP 路由见 `handleAdminHttp`）。
     *
     * 刻意**不做**任何"可能失败但不影响判定"的事：全部用已有函数取现成值，
     * 拿不到就留 `undefined`/`unknown`。这里出的数字必须是真的。
     */
    selfcheck(): MobileSelfcheck {
      const tlsStatus = options.tls?.status()
      const snapshot = trustSnapshot()
      const devices = store.list()
      const probe = probeDshFrontend(options.distIndex?.())
      const relay = relayAuthorities()
      const listener = options.listener?.status() ?? unavailableLanListenerStatus()
      const warnings: string[] = []

      if (tlsStatus === undefined) {
        warnings.push('未注入证书管理器：本部署无法自签证书（manifest.tls.ok=false）')
      } else if (!tlsStatus.ok) {
        warnings.push(`自签证书不可用：${tlsStatus.error ?? '未知原因'}（手机端将无法建立 HTTPS 信任）`)
      } else if (tlsStatus.createdCa) {
        warnings.push('本次**新建**了 CA：手机需要重新安装一次根证书，旧信任已作废')
      }
      if (!snapshot.derived) {
        warnings.push(`网卡推导失败（${snapshot.error ?? '未知原因'}）⇒ 信任集合已退回静态列表（比平常更严）`)
      } else if (snapshot.addresses.length === 0) {
        warnings.push('本机没有非内部 IPv4：局域网手机只能靠静态 trustedHosts 或 hostname 进入')
      }
      if (probe.status === 'missing') {
        warnings.push(`DSH 前端关键锚点 0/${probe.total} 命中：这一版 DSH 可能不兼容（手机端会半坏）`)
      } else if (probe.status === 'partial') {
        const missed = probe.items.filter((item) => !item.found).map((item) => item.name)
        warnings.push(`DSH 前端锚点命中 ${probe.hits}/${probe.total}：缺 ${missed.join('、')}`)
      } else if (probe.status === 'unknown') {
        warnings.push('DSH 前端无法探测（拿不到产物）⇒ 兼容性**未知**')
      }

      /**
       * ── 局域网监听（C1）────────────────────────────────────────────────
       * 三种形态要分得开：**没启用**（默认，老部署）／**启用且就绪**／**启用但没起来**。
       * 后者的原因（端口被占、证书缺失）由 `listener.warnings` 原样带出来，
       * 自检里直接就有人话结论，不必再去翻终端日志。
       */
      for (const warning of listener.warnings) warnings.push(`局域网监听：${warning}`)
      if (listener.available && listener.enabled && !listener.ok) {
        warnings.push('局域网监听**未就绪**：手机入口不可用（DSH 本身不受影响；原因见上面那条）')
      }
      if (!listener.forwardedForInjection) {
        /**
         * ★ 这条几乎不可能出现（注入恒为开启），写在这里是为了"被关掉"时**必然**报警：
         * 关掉注入 ⇒ 局域网手机被判成"人在电脑前" ⇒ 配对码生成/配对确认/设备管理/端侧控制
         * （`LOCAL_ONLY` 全家）在局域网可达，而且**没有任何症状**。
         */
        warnings.push('★ x-forwarded-for 注入被关闭：局域网手机将被判成"人在电脑前"（LOCAL_ONLY 端点会被提权可达）')
      }

      return {
        // 总判据：证书可用、前端探针没有"全不命中"、且已启用的局域网监听确实在听
        // （unknown 不算失败——不编，也不误报；监听未启用更不算失败，那是老部署的常态）
        ok: (tlsStatus?.ok ?? false) && probe.status !== 'missing' && listener.ok,
        checkedAt: new Date().toISOString(),
        /**
         * ★ 第 53 轮：把**端侧队列的积压**也挂出来 ✓ —— 它是"通知到底有没有送到手机"
         *   最直接的一条信号 ✓：
         *   · `pending` 一直是 0 ⇒ 手机在取、也在回报 ✓（链是通的 ✓）；
         *   · `pending` 一直涨 ⇒ 手机**根本没取**（后台受限 / 页面没跑 / 隧道断 ✓）
         *     —— 这一步把"没推"与"推了没人取"当场分开 ✓，而这两种在外部看起来一样 ✗。
         * ★ 只读计数，不带任何内容 ✓（内容会含工具名与原因，不必出现在这一页 ✓）。
         */
        ...(() => {
          try {
            return { deviceQueue: { pending: deviceCalls.pendingCount() } }
          } catch (error) {
            void error
            return {}
          }
        })(),
        ...(() => {
          /**
           * ★ 第 74 轮：把"这台电脑装的插件与 APK 是哪一版"念出来 ✓ ——
           *   用户验之前先看这里一眼，就知道电脑端是不是新的 ✓（消灭"验了旧的"那种白费 ✓）。
           */
          try {
            let boot = ''
            try {
              // boot.js 就在产物旁边（构建时拷进 lib/）⇒ 直接按模块位置取，不依赖配置类型
              const bootPath = join(dirname(fileURLToPath(import.meta.url)), 'boot.js')
              const text = readFileSync(bootPath, 'utf8')
              const stamp = text.match(/BUILD-[0-9]+/)
              boot = stamp === null ? '' : stamp[0]
            } catch (error) {
              void error
            }
            let apk: { bytes: number; modifiedAt: string } | null = null
            try {
              const apkPath = join(dirname(fileURLToPath(import.meta.url)), 'dsh-mobile.apk')
              const stat = statSync(apkPath)
              apk = { bytes: stat.size, modifiedAt: stat.mtime.toISOString() }
            } catch (error) {
              void error
            }
            return { assets: { boot, apk } }
          } catch (error) {
            void error
            return {}
          }
        })(),
        ...(() => {
          try {
            const entries = store.listAudit({ limit: 40 })
            const list = Array.isArray(entries) ? entries : []
            const diagnostics = list
              .map((entry: unknown) => {
                const record = (entry ?? {}) as { target?: unknown; detail?: unknown }
                return {
                  tag: String(record.target ?? '').slice(0, 60),
                  detail: String(record.detail ?? '').slice(0, 160),
                }
              })
              .filter((item) => item.tag.length > 0)
            return diagnostics.length === 0 ? {} : { diagnostics }
          } catch (error) {
            void error
            return {}
          }
        })(),
        host: {
          hostId: options.identity.hostId,
          hostName: options.identity.hostName,
          hostFingerprint: fingerprint(options.identity.signingKey.publicKey),
        },
        tls:
          tlsStatus === undefined
            ? { available: false, ok: false, directory: '(未注入)', createdCa: false, createdServer: false, resignedServer: false }
            : {
                available: true,
                ok: tlsStatus.ok,
                directory: tlsStatus.directory,
                createdCa: tlsStatus.createdCa,
                createdServer: tlsStatus.createdServer,
                resignedServer: tlsStatus.resignedServer,
                // exactOptionalPropertyTypes：可选字段不能显式写 undefined，只能条件展开
                ...(tlsStatus.caFingerprint === undefined ? {} : { caFingerprint: tlsStatus.caFingerprint }),
                ...(tlsStatus.serverFingerprint === undefined ? {} : { serverFingerprint: tlsStatus.serverFingerprint }),
                ...(tlsStatus.serverSubjectAltName === undefined
                  ? {}
                  : { serverSubjectAltName: tlsStatus.serverSubjectAltName }),
                ...(tlsStatus.caNotAfter === undefined ? {} : { caNotAfter: tlsStatus.caNotAfter }),
                ...(tlsStatus.serverNotAfter === undefined ? {} : { serverNotAfter: tlsStatus.serverNotAfter }),
                ...(tlsStatus.error === undefined ? {} : { error: tlsStatus.error }),
              },
        listen: {
          dshPort: options.selfPort ?? null,
          phoneBaseUrl: options.phoneBaseUrl && options.phoneBaseUrl.length > 0 ? options.phoneBaseUrl : null,
          endpoints: options.endpoints(),
        },
        trust: {
          derived: snapshot.derived,
          localAddresses: snapshot.addresses,
          hostnames: snapshot.hostnames,
          localNamesEnabled: config.trustLocalNames !== false,
          staticHosts: [...(options.trustedHosts ?? [])],
          relay,
        },
        devices: {
          count: devices.length,
          connected: sessions.size,
          revoked: devices.filter((device) => device.authorization === 'revoked').length,
        },
        dshFrontend: probe,
        listener,
        warnings,
      }
    },
  }

  /** 配对与管理端点的 HTTP 处理（仅 loopback）。 */
  async function handlePairHttp(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    purgeExpired()

    if (req.method === 'POST' && url.pathname === '/mobile/pair/code') {
      respondJson(res, 200, service.createPairing())
      return
    }

    if (req.method === 'POST' && url.pathname === '/mobile/pair/claim') {
      const body = await readJsonBody<PairClaimRequest>(req)
      if (body === undefined) {
        respondJson(res, 400, wireError(ErrorCode.HandshakeMalformed, 'invalid claim body'))
        return
      }
      if (typeof body.ticket !== 'string' || typeof body.deviceId !== 'string' || typeof body.deviceSigningKey !== 'string') {
        respondJson(res, 400, wireError(ErrorCode.HandshakeMalformed, 'claim is missing required fields'))
        return
      }
      const entry = pendingByTicket.get(body.ticket)
      if (entry === undefined || Date.parse(entry.ticket.expiresAt) <= Date.now()) {
        respondJson(res, 200, { state: 'expired' } satisfies PairClaimResponse)
        return
      }
      if (entry.state !== 'open') {
        const state = entry.state === 'approved' ? 'approved' : entry.state === 'rejected' ? 'rejected' : 'pending'
        respondJson(res, 200, { state } satisfies PairClaimResponse)
        return
      }
      // 指纹必须与**签名公钥**自洽，否则拒绝登记（防止提交不匹配的指纹骗过人工比对）
      if (body.deviceSigningKey === undefined || fingerprint(body.deviceSigningKey) !== body.fingerprint) {
        store.record({ deviceId: body.deviceId, kind: 'deny', detail: 'claim 指纹与公钥不匹配', ok: false })
        respondJson(res, 400, wireError(ErrorCode.HandshakeMalformed, 'fingerprint does not match deviceSigningKey'))
        return
      }
      entry.claim = body
      entry.state = 'claimed'
      store.record({ deviceId: body.deviceId, kind: 'pair-claim', detail: `${body.name} ${body.model ?? ''}`.trim(), ok: true })
      respondJson(res, 200, { state: config.requireHostConfirm ? 'pending' : 'approved' } satisfies PairClaimResponse)
      return
    }

    if (req.method === 'GET' && url.pathname === '/mobile/pair/status') {
      const code = url.searchParams.get('code') ?? ''
      const entry = pendingByCode.get(code)
      if (entry === undefined) {
        respondJson(res, 200, { state: 'expired' } satisfies PairStatusResponse)
        return
      }
      if (entry.state === 'approved' && entry.deviceToken === undefined) {
        entry.deviceToken = randomTicket()
      }
      const device = entry.claim === undefined ? undefined : store.get(entry.claim.deviceId)
      // open 与 claimed 对外都呈现为 pending（手机只关心"还要不要等"）
      const publicState = entry.state === 'open' || entry.state === 'claimed' ? 'pending' : entry.state
      respondJson(res, 200, {
        state: publicState,
        ...(entry.deviceToken === undefined ? {} : { deviceToken: entry.deviceToken }),
        ...(device === undefined ? {} : { capabilities: device.capabilities }),
      } satisfies PairStatusResponse)
      return
    }

    if (req.method === 'POST' && url.pathname === '/mobile/pair/confirm') {
      const body = await readJsonBody<{ code: string; deviceId: string; approve: boolean }>(req)
      if (body === undefined) {
        respondJson(res, 400, wireError(ErrorCode.HandshakeMalformed, 'invalid confirm body'))
        return
      }
      const ok = service.confirmPairing(body.code, body.deviceId, body.approve === true)
      respondJson(res, ok ? 200 : 404, ok ? { state: body.approve ? 'approved' : 'rejected' } : wireError(ErrorCode.PairingTicketInvalid, 'no matching pending pairing'))
      return
    }

    if (req.method === 'GET' && url.pathname === '/mobile/pair/pending') {
      respondJson(res, 200, { pairings: service.listPendingPairings() })
      return
    }

    if (req.method === 'GET' && url.pathname === '/mobile/devices') {
      respondJson(res, 200, { devices: service.listDevices(), connected: service.connectedCount() })
      return
    }

    if (req.method === 'POST' && url.pathname === '/mobile/devices/update') {
      const body = await readJsonBody<{ deviceId: string; update: DeviceUpdate }>(req)
      if (body === undefined) {
        respondJson(res, 400, wireError(ErrorCode.HandshakeMalformed, 'invalid update body'))
        return
      }
      try {
        const device = service.updateDevice(body.deviceId, body.update ?? {})
        respondJson(res, device === undefined ? 404 : 200, device ?? wireError(ErrorCode.DeviceUnknown, 'unknown device'))
      } catch (error) {
        respondJson(res, 403, wireError((error as { code?: string }).code ?? ErrorCode.CapabilityDenied, String((error as Error).message)))
      }
      return
    }

    if (req.method === 'POST' && url.pathname === '/mobile/devices/revoke') {
      const body = await readJsonBody<{ deviceId: string }>(req)
      const ok = body !== undefined && service.revokeDevice(body.deviceId)
      respondJson(res, ok ? 200 : 404, { revoked: ok })
      return
    }

    /**
     * 电脑侧发起一次端侧请求（让手机做一件事）。
     *
     * 只能从**电脑本机**调用（见 LOCAL_ONLY 名单）——否则同局域网的人就能指挥别人的手机。
     * 目标设备可以显式指定 `deviceId`；不给时就发给**所有**"可用且已启用该能力"的设备 ✓
     * （★ 第 90 轮更正 ✗：原先写的是"不给时要求恰好一台**在线**"✓，
     *   那正是"手机切到另一台电脑就收不到提权通知"的根因 —— 判定见 `deviceCall` ✓）。
     * 发给谁始终是确定的 ✓：集合由"已配对 + 可用 + 已授权该能力"唯一决定 ✓，
     * 与"此刻谁连着本机"无关 ✓。
     */
    if (req.method === 'POST' && url.pathname === '/mobile/device/call') {
      const body = await readJsonBody<{ deviceId?: string; capability?: string; text?: string }>(req)
      if (body === undefined) {
        respondJson(res, 400, wireError(ErrorCode.CapabilityDenied, 'invalid body'))
        return
      }
      // 判定逻辑只有一处：HTTP 与（将来的）agent 工具共用 service.deviceCall
      const outcome = service.deviceCall(String(body.capability ?? 'show'), String(body.text ?? ''), body.deviceId)
      if (!outcome.ok) {
        respondJson(res, 403, wireError(ErrorCode.CapabilityDenied, outcome.reason))
        return
      }
      respondJson(res, 200, { id: outcome.id, capability: String(body.capability ?? 'show'), delivered: false })
      return
    }

    /** 电脑侧查看端侧请求的状态与结果。 */
    if (req.method === 'GET' && url.pathname === '/mobile/device/status') {
      const id = url.searchParams.get('id')
      respondJson(res, 200, {
        pending: deviceCalls.pendingCount(),
        capabilities: DEVICE_CAPABILITIES,
        enabled: Object.fromEntries([...sessions.keys()].map((deviceId) => [deviceId, deviceCalls.listEnabled(deviceId)])),
        ...(id === null ? {} : { result: deviceCalls.getResult(id) ?? null }),
      })
      return
    }

    if (req.method === 'GET' && url.pathname === '/mobile/audit') {
      respondJson(res, 200, {
        entries: service.listAudit({
          ...(url.searchParams.get('deviceId') === null ? {} : { deviceId: url.searchParams.get('deviceId')! }),
          ...(url.searchParams.get('limit') === null ? {} : { limit: Number(url.searchParams.get('limit')) }),
        }),
      })
      return
    }

    respondJson(res, 404, wireError(ErrorCode.Internal, `unknown mobile endpoint ${url.pathname}`))
  }

  /**
   * 管理员端点的 HTTP 处理（`/mobile/admin/*`）。
   *
   * 授权**不在这里**判——它在 `handleHttp` 的栅栏之后、分发之前用
   * `isAdminSourceTrusted` 判完了（那里才有 `req` 与 authority 的完整上下文）。
   * 这里只做"参数怎么解释、返回什么"。
   */
  async function handleAdminHttp(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    /**
     * 自检：一条请求回答"现在到底好不好、缺什么"。
     *
     * 只读：不写文件、不改内存状态（`probeDshFrontend` 只读产物文本且有 60 秒缓存）。
     * 数字全部来自现算；拿不到的写 `unknown`/`available:false`，**不编**。
     */
    if (req.method === 'GET' && url.pathname === '/mobile/admin/selfcheck') {
      respondJson(res, 200, service.selfcheck())
      return
    }

    /**
     * 清设备：`POST /mobile/admin/devices/remove`
     *   · `{"deviceId":"..."}` —— 删一台；
     *   · `?revoked=1`         —— 批量删所有已撤销的记录。
     *
     * 走 `DeviceStore.remove()`（内存表 + 文件同时更新）⇒ **不需要重启 DSH**，
     * 这正是从前"改文件 + 立刻重启"那条纪律要防的坑。
     */
    if (req.method === 'POST' && url.pathname === '/mobile/admin/devices/remove') {
      if (url.searchParams.get('revoked') === '1') {
        const removed = service.removeRevokedDevices()
        store.record({
          deviceId: '(host)',
          kind: 'remove',
          target: url.pathname,
          detail: `批量清理已撤销设备：删除 ${removed} 条`,
          ok: true,
        })
        respondJson(res, 200, { removed })
        return
      }
      const body = await readJsonBody<{ deviceId?: string }>(req)
      const deviceId = typeof body?.deviceId === 'string' ? body.deviceId.trim() : ''
      if (deviceId === '') {
        // 参数错与"没权限"分开报：前者是调用方写错了（400），后者是 403（权限），
        // 混成一个码会让"到底该修哪儿"变成猜。
        respondJson(res, 400, wireError(ErrorCode.HandshakeMalformed, 'deviceId is required, or use ?revoked=1 to purge revoked devices'))
        return
      }
      const removed = service.removeDevice(deviceId)
      if (!removed) {
        // 审计要能回答"他试过删谁、删掉了没有"——删不到也记一条（ok:false）。
        store.record({ deviceId, kind: 'remove', target: url.pathname, detail: '设备不存在，未删除', ok: false })
      }
      respondJson(res, removed ? 200 : 404, { removed, deviceId })
      return
    }

    respondJson(res, 404, wireError(ErrorCode.Internal, `unknown mobile admin endpoint ${url.pathname}`))
  }

  /**
   * 打开一条网关流。
   *
   * 优先用 `openWireStream`——它是 DSH 自己的流式传输入口，能正确处理特殊端点 **`$events`**
   * （实时事件通道，会话历史与连接状态都依赖它）。缺失时才退回 `stream()`，
   * 而 `stream()` 只能处理 `namespace/method` 形式的端点。
   */
  async function openGatewayStream(
    endpoint: string,
    payload: unknown,
    signal: AbortSignal,
  ): Promise<AsyncIterable<unknown>> {
    if (typeof options.gateway.openWireStream === 'function') {
      return callOpenWireStream(options.gateway, endpoint, payload, signal)
    }
    return options.gateway.stream(toGatewayArgs(endpoint, payload, signal))
  }

  /**
   * 读 DSH 的工作区根目录——"在电脑上打开"的**允许范围**。
   *
   * 数据来自 DSH 自己的 `workspace/follow` 第一帧（baseline），不额外维护一份配置：
   * 用户在 GUI 里加/删工作区，这里自动跟随。
   *
   * ★ 取不到时返回**空数组**（失败即拒绝）。绝不能退化成"允许任意目录"——
   * 那会让一个被授权的设备可以打开电脑上的任何路径。
   */
  async function listWorkspaceRoots(signal: AbortSignal): Promise<readonly string[]> {
    try {
      const stream = await openGatewayStream('workspace/follow', { args: {} }, signal)
      for await (const frame of stream) {
        const value = frame as {
          readonly type?: string
          readonly value?: { readonly items?: readonly { readonly path?: unknown }[] }
        }
        if (value.type === 'baseline') {
          const items = value.value?.items ?? []
          return items
            .map((item) => item.path)
            .filter((path): path is string => typeof path === 'string' && path.length > 0)
        }
        break
      }
    } catch (error) {
      console.warn('[dsh-mobile] 读取工作区列表失败，将拒绝本次打开请求：', error)
    }
    return []
  }

  /** 从 typert 信封里取业务参数（`{args:{...}}`）。 */
  function readLocalArgs(payload: unknown): Record<string, unknown> {
    const envelope = payload as { readonly args?: Record<string, unknown> } | undefined
    const args = envelope?.args
    return args !== null && typeof args === 'object' ? args : {}
  }

  /**
   * Codex 宿主桥（懒启动）。
   *
   * ★ 为什么懒启动：Codex CLI 不是每台机器都有、也不是每个人都在用 ✓。
   *   第一次真正收到 `mobile/codex/*` 调用时才 spawn `codex app-server`
   *   （stdio，见 codex-bridge.ts 的模块说明）；没人用就一个进程都不多 ✓。
   *
   * ★ 环境变量（都可选，默认值见 codex-bridge.ts）：
   *   `DSH_MOBILE_CODEX_CLI`  —— CLI 路径（默认 macOS 官方包位置，再退回 PATH 里的 `codex`）
   *   `DSH_MOBILE_CODEX_HOME` —— CODEX_HOME（默认沿用本进程的 `CODEX_HOME`，再退回 `~/.codex`）
   *   `DSH_MOBILE_CODEX_ARGS` —— JSON 字符串数组，作为 CLI 参数（默认 `["app-server"]`）。
   *   `DSH_MOBILE_CODEX_CWD`  —— 手机新建会话时的默认工作目录（缺省交给 app-server 自己决定）
   *   最后一条是**测试钩子**：e2e（scripts/e2e-pairing.mjs --codex-page）用它把"CLI"指向
   *   假 app-server（test/fixtures/fake-codex-app-server.mjs），从而不依赖真 Codex ✓。
   */
  let codexBridge: CodexBridge | undefined
  function getCodexBridge(): CodexBridge {
    if (codexBridge === undefined) {
      const cliPath = process.env['DSH_MOBILE_CODEX_CLI']
      const codexHome = process.env['DSH_MOBILE_CODEX_HOME']
      const rawArgs = process.env['DSH_MOBILE_CODEX_ARGS']
      const defaultCwd = process.env['DSH_MOBILE_CODEX_CWD']
      let cliArgs: string[] | undefined
      if (rawArgs !== undefined && rawArgs.length > 0) {
        try {
          const parsed: unknown = JSON.parse(rawArgs)
          if (Array.isArray(parsed) && parsed.every((item) => typeof item === 'string')) cliArgs = parsed as string[]
        } catch {
          // 解析失败就按默认走（[app-server]），不因为一个测试钩子把插件搞挂 ✗
        }
      }
      codexBridge = new CodexBridge({
        ...(cliPath === undefined || cliPath.length === 0 ? {} : { cliPath }),
        ...(codexHome === undefined || codexHome.length === 0 ? {} : { codexHome }),
        ...(cliArgs === undefined ? {} : { cliArgs }),
        ...(defaultCwd === undefined || defaultCwd.length === 0 ? {} : { defaultCwd }),
      })
    }
    return codexBridge
  }

  /**
   * 处理**插件自有**的隧道内端点（`mobile/` 前缀）。
   *
   * 为什么放在隧道委派而不是 HTTP 路由：这些都是"在电脑上做事"的动作，
   * 放 HTTP 就等于任何能连到代理的局域网设备都能触发（插件的信任栅栏只校验
   * authority，不校验是谁）。走隧道则天然要求设备认证——未配对的连接没有这条通路。
   *
   * @returns undefined 表示不是本地端点，调用方应交给 DSH 网关。
   */
  async function invokeLocalEndpoint(
    endpoint: string,
    payload: unknown,
    signal: AbortSignal,
    device: DeviceRecord,
  ): Promise<unknown | undefined> {
    if (!endpoint.startsWith('mobile/')) return undefined

    // ── 会话页数据面（我们自己的页面用它承载 DSH 的输出）──────────────────
    // 与 `mobile/codex/*` 同一个位置与理由：它不是 DSH 命名空间的端点，
    // 设备身份已由隧道握手保证；桥的职责见 dsh-chat-bridge.ts（认 DSH 的形状只在那一个文件里）。
    if (endpoint.startsWith('mobile/dsh/')) {
      // ★ 这里用**动态 import** ✗ 而不是文件顶部的静态 import ✓ ——
      //   顶部那一段是**别的单正在改的地方** ✗，插进去就会把两单搅在同一次提交里 ✓。
      //   动态 import 只加载一次（模块系统自己缓存 ✓），代价可以忽略 ✓。
      const { handleDshChatEndpoint } = await import('./dsh-chat-bridge.ts')
      return handleDshChatEndpoint(
        {
          call: (target, payload, bridgeSignal) =>
            invokeGatewayEndpoint(options.gateway, target, payload, bridgeSignal ?? signal),
        },
        endpoint,
        payload,
        signal,
      )
    }

    if (endpoint === 'mobile/openInApp/apps') {
      return listOpenInAppTargets()
    }

    if (endpoint === 'mobile/openInApp/open') {
      const args = readLocalArgs(payload)
      const roots = await listWorkspaceRoots(signal)
      if (roots.length === 0) {
        throw Object.assign(new Error('电脑上还没有工作区，无法打开目录'), {
          code: ErrorCode.CapabilityDenied,
        })
      }
      return openInApp(
        typeof args['app'] === 'string' ? args['app'] : '',
        typeof args['path'] === 'string' ? args['path'] : '',
        args['action'] === 'reveal' ? 'reveal' : 'open',
        roots,
      )
    }

    // ── Codex 宿主桥 ──────────────────────────────────────────────────
    // 与 DSH 无关的一组端点：宿主直接连 Codex app-server（stdio），手机用它们
    // 列会话 / 发消息 / 收增量 / 裁决审批（协议与安全默认见 codex-bridge.ts）。
    // 放在能力门禁之前：与其它 `mobile/*` 一样，它不属于 DSH 命名空间，
    // 设备身份已由隧道握手保证；Codex 自己的审批则由桥逐条展示给手机 ✓。
    if (endpoint.startsWith('mobile/codex/')) {
      return handleCodexEndpoint(getCodexBridge(), endpoint, payload)
    }

    // ── 工作区文件管理 ───────────────────────────────────────────────
    // 全部要求路径落在工作区根之内（见 workspace-files.ts 的安全说明）。
    // 这些端点在 DSH 里**不存在**（它的 workspaceFiles/* 只有读操作），由插件自己实现。
    // ── 端侧请求（电脑 → 手机）的三条手机侧端点 ─────────────────────────
    //
    // 方向是"手机主动来取"：完全复用现有 RPC 通道，**不需要新增协议**。
    // 能力的启用/停用**只能由手机端发起**——电脑无法自行打开某项能力。
    //
    // ⚠️ 必须放在 `mobile/files/` 那个块**之外**：早先把它们写进了那个 switch 里，
    //    而外层是 `if (endpoint.startsWith('mobile/files/'))`，于是 `mobile/device/*`
    //    永远走不到，直接落到能力门禁被拒——测试里表现为 `ok: false`，
    //    而错误信息完全指不到这里。
    if (endpoint.startsWith('mobile/device/')) {
      const args = readLocalArgs(payload)
      switch (endpoint) {
        case 'mobile/device/enable':
          return {
            capabilities: deviceCalls.setEnabled(
              device.deviceId,
              String(args['capability'] ?? ''),
              args['enabled'] !== false,
            ),
          }
        /**
         * 手机**自己**解除配对（安全规范 §7："撤销即时生效"）。
         *
         * 为什么必须由手机发起：在此之前只有电脑端的 `/mobile/devices/revoke` ——
         * 也就是"想解除配对，得先回到电脑前"，而这条路径最常见的动因恰恰是
         * "手机丢了/要换机/怀疑被配对"，那时候人不一定在电脑前。
         *
         * 语义是**单向**的：这台设备立刻失效（隧道关闭、长期密钥作废），
         * 而电脑侧的设备记录保留为 `revoked`（审计可追溯，与电脑端撤销一致）。
         * 手机端清掉本地凭据后回到配对页 —— 想重新配对，必须再用电脑确认一次指纹，
         * 所以"手机自己撤销"**不会被用来悄悄换一个信任根**。
         */
        case 'mobile/device/unpair': {
          const revoked = revokeDevice(device.deviceId)
          store.record({
            deviceId: device.deviceId,
            kind: 'rpc',
            target: 'mobile/device/unpair',
            detail: revoked ? 'self-revoked by phone' : 'device record not found',
            ok: revoked,
          })
          return { revoked }
        }
        case 'mobile/device/pending':
          return {
            calls: deviceCalls.takePending(device.deviceId),
            capabilities: DEVICE_CAPABILITIES,
            // ★ 这台设备**当前**已启用的能力（内存态）。手机端拿它跟自己的
            //   localStorage 对账：DSH 重启后电脑侧会忘事，端侧据此补报一次。
            enabled: deviceCalls.listEnabled(device.deviceId),
          }
        case 'mobile/device/result':
          return deviceCalls.recordResult(
            device.deviceId,
            String(args['id'] ?? ''),
            args['ok'] === true,
            String(args['detail'] ?? ''),
          )
        default:
          return undefined
      }
    }

    if (endpoint.startsWith('mobile/files/')) {
      const args = readLocalArgs(payload)
      const roots = await listWorkspaceRoots(signal)
      if (roots.length === 0) {
        throw Object.assign(new Error('电脑上还没有工作区'), { code: ErrorCode.CapabilityDenied })
      }
      const path = typeof args['path'] === 'string' ? args['path'] : ''
      switch (endpoint) {
        case 'mobile/files/list':
          return listDirectory(path, roots)
        case 'mobile/files/summarize':
          return summarize(path, roots)
        case 'mobile/files/mkdir':
          return makeDirectory(path, roots)
        case 'mobile/files/rename': {
          const name = typeof args['name'] === 'string' ? args['name'] : ''
          if (name.length === 0 || name.includes('/') || name === '.' || name === '..') {
            throw Object.assign(new Error('新名称不合法'), { code: ErrorCode.Internal })
          }
          return renamePath(path, join(dirname(path), name), roots)
        }
        case 'mobile/files/remove':
          return removePath(path, args['recursive'] === true, roots)
        case 'mobile/files/paste': {
          const raw = Array.isArray(args['sources']) ? (args['sources'] as unknown[]) : []
          const sources = raw.filter((item): item is string => typeof item === 'string')
          const target = typeof args['target'] === 'string' ? args['target'] : ''
          return pasteInto(sources, target, args['mode'] === 'move' ? 'move' : 'copy', roots)
        }
        case 'mobile/files/write':
          return writeChunk(
            path,
            typeof args['offset'] === 'number' ? args['offset'] : 0,
            typeof args['data'] === 'string' ? args['data'] : '',
            args['truncate'] === true,
            roots,
          )
        case 'mobile/files/read':
          return readChunk(
            path,
            typeof args['offset'] === 'number' ? args['offset'] : 0,
            typeof args['length'] === 'number' ? args['length'] : READ_CHUNK_BYTES,
            roots,
          )
        default:
          throw Object.assign(new Error(`unknown mobile endpoint ${endpoint}`), { code: ErrorCode.Internal })
      }
    }

    throw Object.assign(new Error(`unknown mobile endpoint ${endpoint}`), { code: ErrorCode.Internal })
  }

  /**
   * 中继的 **HTTP 回源通道**。
   *
   * ## 为什么需要单独一条通道
   *
   * 手机远程时，不只是隧道要通，**页面本身**也要有来源（`/mobile/app`、`/assets/*`、
   * `/plugins/*`）。而中继是**纯字节转发器**：它既看不懂我们的隧道协议，也不可能把
   * HTTP 请求塞进某台手机那条已加密的会话里（它没有密钥）。所以另开一条
   * **电脑 → 中继** 的普通（TLS）通道专门做回源：
   * 中继把请求描述成一行 JSON 发来，这里用**环回请求**打到插件自己的 HTTP 路由上
   * （复用真实路由，不另写一套），再把响应原样回给中继。
   *
   * ## 安全边界（重要）
   *
   * 环回请求会被插件的信任栅栏判成"人在电脑前"，于是 `LOCAL_ONLY` 那些端点
   * （配对码、配对确认、设备管理、审计、诊断）**本来只对回环开放，经这条通道就会变成可达**。
   * 因此这里**显式拒绝**它们——这条通道的暴露面必须与"同局域网的人直接访问代理"**等价**，
   * 不能更大。
   */
  function startRelayHttpBackhaul(): () => void {
    const base = config.relayUrl
    if (typeof base !== 'string' || base.length === 0) return () => {}
    const configuredUrl = config.relayHttpUrl
    const url =
      typeof configuredUrl === 'string' && configuredUrl.length > 0
        ? configuredUrl
        : base.includes('/attach')
          ? base.replace('/attach', '/attach-http')
          : `${base.replace(/\/$/, '')}/attach-http`
    const room = fingerprint(options.identity.signingKey.publicKey)
    const endpoint = `${url}${url.includes('?') ? '&' : '?'}room=${encodeURIComponent(room)}`
    const selfPort = options.selfPort ?? 3080

    /** 经中继回源时**必须拒绝**的路径（判据与理由见模块级 `isRefusedRelayBackhaulPath`）。 */
    const isRefused = isRefusedRelayBackhaulPath

    let socket: WebSocket | undefined
    let stopped = false

    const reply = (payload: Record<string, unknown>): void => {
      try {
        socket?.send(JSON.stringify(payload))
      } catch {
        /* 通道已断，中继侧会超时 */
      }
    }

    const handleRequest = async (text: string): Promise<void> => {
      let request: { id?: unknown; method?: unknown; path?: unknown; headers?: unknown; body?: unknown }
      try {
        request = JSON.parse(text) as typeof request
      } catch {
        return
      }
      const id = typeof request.id === 'string' ? request.id : ''
      const method = typeof request.method === 'string' ? request.method : 'GET'
      const rawPath = typeof request.path === 'string' ? request.path : '/'
      const pathname = rawPath.split('?')[0] ?? rawPath
      if (isRefused(pathname)) {
        reply({ id, status: 403, headers: { 'content-type': 'text/plain; charset=utf-8' }, body: Buffer.from('refused by host policy\n', 'utf8').toString('base64') })
        return
      }
      const headers = new Headers()
      if (request.headers !== null && typeof request.headers === 'object') {
        for (const [key, value] of Object.entries(request.headers as Record<string, unknown>)) {
          if (typeof value !== 'string') continue
          // 逐跳头与 x-forwarded-for 一律不带：后者会改变插件的栅栏判定
          if (/^(host|connection|keep-alive|upgrade|sec-websocket|content-length|transfer-encoding|x-forwarded-for)$/i.test(key)) continue
          headers.set(key, value)
        }
      }
      // ★ Origin 必须与下面 fetch 发出的 Host 一致。
      //   插件有一条 anti-CSRF 检查："Origin does not match Host" —— 它假设请求是**浏览器直连**。
      //   经回源时浏览器发的是中继的 Origin，而我们的环回 fetch 带的是本机 Host，
      //   于是配对请求会被 403（真实踩过，且错误体只在把响应体记下来之后才看得见）。
      //   这条路径的准入门槛是中继 token + 上面的显式拒绝名单，所以这里把 Origin 归一化是本机 authority。
      const origin = `http://127.0.0.1:${selfPort}`
      if (headers.has('origin')) headers.set('origin', origin)
      if (headers.has('referer')) headers.set('referer', `${origin}/`)

      try {
        const body =
          typeof request.body === 'string' && request.body.length > 0 ? Buffer.from(request.body, 'base64') : undefined
        const response = await fetch(`http://127.0.0.1:${selfPort}${rawPath}`, {
          method,
          headers,
          ...(body === undefined ? {} : { body }),
        })
        const bytes = Buffer.from(await response.arrayBuffer())
        const out: Record<string, string> = {}
        response.headers.forEach((value, key) => {
          out[key] = value
        })
        reply({ id, status: response.status, headers: out, body: bytes.toString('base64') })
      } catch (error) {
        reply({
          id,
          status: 502,
          headers: { 'content-type': 'text/plain; charset=utf-8' },
          body: Buffer.from(`host backhaul failed: ${String(error)}\n`, 'utf8').toString('base64'),
        })
      }
    }

    const dial = (): void => {
      if (stopped) return
      let next: WebSocket
      try {
        next = new WebSocket(endpoint)
      } catch (error) {
        console.error('[dsh-mobile] 回源地址无法解析，已停用：', error)
        return
      }
      socket = next
      // ★ 必须设 binaryType：Node 内置 WebSocket 默认把二进制帧给成 **Blob**，
      //   而下面的处理只认 ArrayBuffer/View —— 不设的话中继发来的请求会被**静默丢弃**，
      //   表现成中继侧"回源超时"（真实踩过）。
      next.binaryType = 'arraybuffer'
      next.addEventListener('open', () => {
        try {
          next.send(config.relayToken ?? '')
        } catch (error) {
          console.error('[dsh-mobile] 回源认证消息发送失败：', error)
        }
      })
      next.addEventListener('message', (event) => {
        const data = event.data
        const text =
          typeof data === 'string'
            ? data
            : data instanceof ArrayBuffer
              ? Buffer.from(data).toString('utf8')
              : ArrayBuffer.isView(data)
                ? Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8')
                : ''
        if (text.length > 0) void handleRequest(text)
      })
      next.addEventListener('close', () => {
        if (socket === next) socket = undefined
        if (!stopped) setTimeout(dial, 3000)
      })
      next.addEventListener('error', () => {
        console.warn('[dsh-mobile] 回源通道出错，将重试')
      })
    }

    dial()
    console.log(`[dsh-mobile] 中继回源通道已启动：${url}（房间 ${room}）`)
    return () => {
      stopped = true
      try {
        socket?.close()
      } catch {
        /* 忽略 */
      }
    }
  }

  // 中继外拨（只在配了 relayUrl 时启用）：让手机离开局域网也能连进来
  const stopRelayDialer = startRelayDialer()
  const stopRelayHttpBackhaul = startRelayHttpBackhaul()

  return {
    ...service,
    /** 停止中继外拨（进程退出/插件卸载时调用）。 */
    stopRelayDialer,
    /** 停止中继回源通道。 */
    stopRelayHttpBackhaul,

    /** 停止 Codex 宿主桥（懒启动过才需要；进程退出/插件卸载时调用）。 */
    stopCodexBridge() {
      codexBridge?.dispose()
      codexBridge = undefined
    },

    handleUpgrade(req, socket) {
      /**
       * ★ base 用**常量**，不拿 `Host` 头去拼 —— 这里只需要 `pathname`。
       *
       * 为什么不能拼 Host：`new URL('/mobile/ws', 'http://' + req.headers.host)` 在畸形 Host
       * （空串、`user:pass@x`、含空格等）上会**直接抛 TypeError**，而这个异常是从 upgrade
       * 处理器里抛出去的 ⇒ 变成进程级未捕获异常，准入检查反倒成了一条 DoS 面。
       * Host 的信任判定在下面用 `parseAuthority` 显式做（它自己 try/catch，返回 undefined）。
       */
      const url = new URL(req.url ?? '/', 'http://localhost')
      if (url.pathname !== TUNNEL_PATH) {
        socket.destroy()
        return
      }

      /**
       * ── Host / Origin 栅栏（T6：与 `handleHttp` 对齐）──────────────────────
       *
       * ## 为什么升级路径也要栅栏
       *
       * `handleHttp` 有这道栅栏，`handleUpgrade` 却**完全没有** —— 同一台电脑上两条准入
       * 路径判据不一致：能挡住 `/mobile/manifest` 的跨源请求，却挡不住 `/mobile/ws` 的升级。
       * 浏览器对 WebSocket **不做同源限制**（接不接受由服务端决定），所以恶意页面可以把
       * `ws://<内网地址>:<端口>/mobile/ws` 当跳板（DNS rebinding）：隧道本身仍要求设备密钥，
       * 但"谁能站到握手面前"不该比 HTTP 侧更宽。
       *
       * ## 判据（宽严必须与真机对齐）
       *
       * - **没有 Origin ⇒ 放行**（保持既有行为）：原生壳 / 非浏览器客户端本来就不发 Origin，
       *   而 DNS rebinding **只可能来自浏览器** —— 浏览器一定会发 Origin。
       *   一刀切要求 Origin 会把真机壳挡在门外（卡片明确警告过这一点）。
       * - **有 Origin ⇒ 必须"本机受信"**：
       *   ① 请求 Host 必须是回环或受信 authority（与 `handleHttp` 完全一致）——
       *      否则 `Host: evil.example.com`（解析到本机）这种经典 rebinding 仍然成立；
       *   ② Origin 必须与请求 Host **同 hostname 且同端口**（分别比较，理由见 handleHttp），
       *      或者 Origin 本身就在受信集合里（保留反代场景：浏览器 Origin 是域名、
       *      Host 被反代改写成回环地址）。
       * - 受信集合 = 部署方声明的 `trustedHosts` ∪ `phoneBaseUrl` ∪ **中继 authority**。
       *   把 `phoneBaseUrl` 算进来，是因为它就是"手机该访问的那个 authority"（见 manifest）；
       *   只配了它、没配 trustedHosts 的部署不该因此连不上隧道。
       *   ★ 中继 authority 必须算进来（T6 实测踩到）：手机远程时**应用外壳本身就是经中继回源
       *   下发的**，页面的 Origin 是**中继**；而 boot.js 的候选端点回退会让它带着这个 Origin
       *   去连局域网端点（`check-relay-e2e` 的"配对走局域网"阶段正是这条）。
       *   中继地址来自部署配置（`relayUrl` / `relayHttpUrl`），不是攻击者可控的来源；
       *   不把它算进来，结果是**正常手机被误伤**（实测：所有候选端点都连不上），
       *   而不是挡住了攻击者 —— 这正是卡片警告的那类误伤。
       *
       * 拒绝时**必须留日志**：这条路径的失败在手机侧只表现为"隧道连不上"，
       * 不记日志就完全查不出是栅栏拒的 —— 那是本项目最难排查的一类症状。
       * （这里只 `console.warn` 而不写审计：升级请求可以被任意跨源页面大量触发，
       * 每条都落审计等于给攻击者一个刷掉历史的开关。）
       */
      const originHeader = req.headers.origin
      if (typeof originHeader === 'string' && originHeader.length > 0) {
        const refuse = (reason: string): void => {
          console.warn(
            `[dsh-mobile] 拒绝 WebSocket 升级：${reason}（Host=${req.headers.host ?? '(无)'} Origin=${originHeader}）`,
          )
          try {
            socket.write('HTTP/1.1 403 Forbidden\r\nconnection: close\r\ncontent-length: 0\r\n\r\n')
          } catch {
            /* socket 可能已经断开 */
          }
          socket.destroy()
        }

        const trustedUpgradeHosts = [...(options.trustedHosts ?? [])]
        if (options.phoneBaseUrl !== undefined && options.phoneBaseUrl.length > 0) {
          trustedUpgradeHosts.push(options.phoneBaseUrl)
        }
        trustedUpgradeHosts.push(...relayAuthorities())

        const authority = parseAuthority(req.headers.host)
        if (authority === undefined) {
          refuse('Host 头缺失或无法解析')
          return
        }
        /**
         * ★ 信任判据含**自推导**（本机非内部 IPv4 / 本机 hostname）——与 `handleHttp`
         *   用同一个 `isTrustedAuthority`，两条准入路径的宽严从此不会走偏。
         *   为什么升级路径更需要它：手机壳连的是 `wss://<局域网IP>:<代理端口>/mobile/ws`，
         *   而那个 IP 正是"本机网卡上的地址"，不推导就得靠人手把它写进 `trustedHosts`。
         */
        const upgradeTrust = trustSnapshot()
        if (!isLoopbackHostname(authority.hostname) && !isTrustedAuthority(authority, trustedUpgradeHosts, upgradeTrust)) {
          refuse(`Host ${req.headers.host} 不在回环或受信集合内`)
          return
        }
        const originUrl = parseAuthority(originHeader)
        const sameAsHost =
          originUrl !== undefined && originUrl.hostname === authority.hostname && originUrl.port === authority.port
        /**
         * ★ Origin 这条腿**刻意不用自推导**，只认"部署方声明过的 authority"
         *   （`trustedHosts` ∪ `phoneBaseUrl` ∪ 中继）——两条理由：
         *
         *   ① **端口是 Origin 判据的一部分**。自推导给的是"本机地址"、不含端口；
         *      而"同一个主机名、不同端口"就是**跨源**（`packages/host/test/pairing-security.test.ts`
         *      的 T6 ⑤ 明确钉着这条：`Origin: https://<本机IP>:9999` 必须拒绝）。
         *      本机 IP 上任何别的服务（又一个本地 web 应用）都能凭它拿到的名字去开我们的隧道，
         *      那就把"同源"这件事让掉了。
         *   ② **真机并不需要它**：手机页面与隧道端点通常**同源**
         *      （`https://<ip>:3443/mobile/app` → `wss://<ip>:3443/mobile/ws`，
         *      或明文代理 3081 那条同理），`sameAsHost` 就已经放行；
         *      真正"Origin 与 Host 不同源"的场景是**反代/中继**，那里的 Origin 是
         *      **部署方声明过的** authority，本来就在静态集合里。
         *
         *   所以这里保留原来的 `matchesTrusted`：Host 腿放宽（干掉手传 IP），
         *   Origin 腿不跟着放宽（安全不倒退）。
         */
        if (!sameAsHost && !(originUrl !== undefined && matchesTrusted(originUrl, trustedUpgradeHosts))) {
          refuse(`Origin ${originHeader} 与 Host 不同源、也不在受信集合内`)
          return
        }
      }

      const connection = acceptWebSocket(socket, req, { maxMessageBytes: config.maxMessageBytes })
      if (connection === undefined) {
        socket.destroy()
        return
      }
      attachSession(connection)
    },

    /**
     * 应用外壳（手机端 DSH 界面）。
     *
     * ## 为什么需要它
     *
     * DSH 的 `/` 由 client-connection 的 authorizeIndex 把关：只有带 launch token
     * 或已换取 authority 绑定的 HttpOnly cookie 的浏览器才能拿到 index.html。
     * 手机上这两个都没有（token 只打印在电脑终端；cookie 绑定电脑的 authority），
     * 于是手机打开 `http://<局域网IP>:<代理端口>/` 会拿到 **401**——
     * 表现就是"配对成功了，但界面进不去"。
     *
     * 注意范围：DSH 的鉴权**只挡这一个壳页面**。`/assets/*`、`/plugins/*` 由静态
     * fallback 提供，本就不需要鉴权；业务调用（`/api/*`）走本插件的隧道，
     * 由**设备密钥**把关，根本不经 DSH 的 cookie 栅栏。
     *
     * 因此本插件补上这一块：把同一个 index.html（含 DSH 的全部注入）交给手机，
     * 并加 `<base href="/">` 让相对路径解析与 DSH 原生一致（DSH 自己也这么做）。
     * 界面本身不含机密——真正的门禁是隧道握手与能力位。
     *
     * 外壳挂在插件自己的前缀 `/mobile/app` 下（**绝不能挂在 `/`**：那是 DSH 的
     * token/cookie 认证唯一入口，抢占它会让任何浏览器都 401 死循环——真实事故，
     * 详见 cordis.ts 中该路由的长注释）。
     */
    getAppShell(): { html: string; etag: string } | undefined {
      const distIndex = options.distIndex?.()
      const renderIndex = options.renderIndex
      // 没有 dist 或没有渲染器就没有外壳：宁可明确不可用，也不要给手机一份
      // 缺少插件注入（尤其是 boot.js）的 index.html——那会表现为"界面能开但连不上"。
      if (distIndex === undefined || renderIndex === undefined) return undefined
      try {
        const stat = statSync(distIndex)
        // ETag 用「大小 + mtime」：前端升级后自动失效，无需重启插件
        const etag = `"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`
        const raw = readFileSync(distIndex, 'utf8')
        // renderIndex 会应用 DSH 注册的全部注入（含本插件的 boot.js），
        // 保证手机与电脑拿到同一份外壳；<base> 的处理与 DSH 一致，否则相对资源会 404。
        /**
         * PWA：「添加到主屏幕」。
         *
         * ★ 只注入**手机外壳**这一份 HTML（桌面端 `/` 那份原样不动 ✓）——
         *   这正是"给手机加的东西必须在手机表面生效"那条规矩的又一处落点
         *   （当年 `boot.js` 漏了表面判断，电脑端也长出了手机顶栏 ✗）。
         *
         * 标签本身就够用：manifest 给名字/图标/独立窗口，`theme-color` 让状态栏同色，
         * `apple-*` 那几条是 iOS 的等价物（iOS 不看 manifest 的 display ✗）。
         */
        const pwaTags = [
          '<link rel="manifest" href="/mobile/manifest.webmanifest">',
          '<meta name="theme-color" content="#0f1115">',
          '<link rel="apple-touch-icon" href="/mobile/icon-192.png">',
          '<meta name="apple-mobile-web-app-capable" content="yes">',
          '<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">',
          '<meta name="apple-mobile-web-app-title" content="DSH">',
        ].join('')
        const html = renderIndex(raw)
          /**
           * ★ 先**摘掉 DSH 自带的那份 manifest**，再插我们那份 —— 顺序不能反 ✗。
           *
           * 为什么必须顶掉：Chrome 只用**第一个** `link[rel=manifest]` ✓，
           * 而 DSH 那份是给桌面用的：
           *   · `start_url: "/"` → 手机上装到主屏幕后打开的是 **DSH 的 token/cookie 入口**，
           *     在手机上只会 **401 死循环** ✗（同一个坑写在 `cordis.ts` 的长注释里）；
           *   · 图标只有 `favicon.svg`（`sizes: "any"`）→ Chrome 可安装性要求 **PNG 192/512** ✗。
           * 实测（`Page.getAppManifest`）：不摘的话 Chrome 解析到的就是 DSH 那份 ✓。
           */
          .replace(/<link[^>]+rel=["']?manifest["']?[^>]*>/gi, '')
          /**
           * ★ 补 `viewport-fit=cover` ✓ —— 在**宿主侧**改（客户端改不动 ✗）。
           *
           * 为什么必须有它：手机 App（APK）用 targetSdk 35 ✓ 会被系统**强制 edge-to-edge** ✓，
           * 而没有 viewport-fit=cover 时 `env(safe-area-inset-top)` **恒为 0** ✗ →
           * DSH 自带预览那薄薄一行头部会顶到状态栏下面 ✓ → **全屏时点不到** ✓
           * （用户反馈的第一条 ✗）。
           * 为什么放这儿：App 外壳的 HTML 由 DSH 的 renderIndex 产出 ✓，
           * 只有我们这层能拿到最终字符串 ✓；boot.js 里那份运行时补写留着当双保险 ✓。
           */
          .replace(/(<meta[^>]*name=["']viewport["'][^>]*content=["'][^"']*)["']/i, (match, head) =>
            head.includes('viewport-fit') ? match : `${head},viewport-fit=cover"`,
          )
          .replace(/<head(?:\s[^>]*)?>/i, (open) => `${open}<base href="/">${pwaTags}`)
        return { html, etag }
      } catch (error) {
        store.record({
          deviceId: '(host)',
          kind: 'capability',
          detail: `应用外壳不可用：${error instanceof Error ? error.message : String(error)}`,
          ok: false,
        })
        return undefined
      }
    },

    handleHttp(req, res) {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
      if (!url.pathname.startsWith('/mobile')) return false
      // ── Host / Origin 信任栅栏（**必须在任何路由分发之前**）──────────────
      //
      // 为什么本插件必须自己做这件事：DSH 的 `/api` 信任栅栏（拒绝非 loopback 且不在
      // trustedHosts 里的 Host）只覆盖 Connection 自己认领的 `/api` 路由，
      // **不会**保护插件注册的路径。
      //
      // 栅栏的位置至关重要：它曾经被放在 manifest / 配对页 / boot.js 三个路由**之后**，
      // 而那三个分支各自 `return true`，于是栅栏对它们**从未执行**——
      // 表现为"跨源 Origin 全被放行"，而单独测配对端点时又是好的（那里栅栏确实生效），
      // 因此极易误判为"栅栏没问题"。现在的顺序是先栅栏、后分发。
      //
      // 规则与 DSH 的栅栏保持一致：
      //  - Host 必须能解析，且是 loopback 或落在受信集合里
      //    （带端口精确匹配，不带端口匹配任意端口）；
      //  - 若附带 Origin，必须与该 Host **同 hostname 且同端口**；
      //  - `sec-fetch-site: cross-site` 一律拒绝。
      // 这些检查防御 DNS rebinding 与跨站请求，**不建立身份**——身份由设备密钥负责。
      //
      // ★ 受信集合 = 静态 `trustedHosts` ∪ **自推导的本机地址/主机名**（见 `isTrustedAuthority`）。
      //   推导是**每次请求现算**的（`trustSnapshot()` 就在下面这一行里），
      //   这样换 Wi-Fi / 插网线 / VPN 起来都不用重启 DSH —— 这正是"手传 IP 不再必要"的落点。
      const authority = parseAuthority(req.headers.host)
      if (authority === undefined) {
        respondJson(res, 403, wireError(ErrorCode.CapabilityDenied, 'missing or malformed Host header'))
        return true
      }
      const httpTrust = trustSnapshot()
      if (!isLoopbackHostname(authority.hostname) && !isTrustedAuthority(authority, options.trustedHosts ?? [], httpTrust)) {
        respondJson(
          res,
          403,
          wireError(
            ErrorCode.CapabilityDenied,
            // 提示语更新：现在只有"名字/外部地址"才需要人工声明；本机 IP 与主机名已自动生效
            `Host ${req.headers.host} is not allowed; it is neither loopback, nor a local address/hostname of this machine, nor in trustedHosts (add it with --trusted-host ${req.headers.host} if it really is yours)`,
          ),
        )
        return true
      }
      const originHeader = req.headers.origin
      if (typeof originHeader === 'string' && originHeader.length > 0) {
        const originUrl = parseAuthority(originHeader)
        // 必须**分别比较 hostname 与 port**，不能拿拼接后的字符串比较：
        // `URL.host` 对某些输入不一定带上端口，曾出现不同 authority 的 `host`
        // 被判相等、跨源被放行的结果。
        if (originUrl === undefined || originUrl.hostname !== authority.hostname || originUrl.port !== authority.port) {
          respondJson(res, 403, wireError(ErrorCode.CapabilityDenied, 'Origin does not match Host'))
          return true
        }
      }
      if (req.headers['sec-fetch-site'] === 'cross-site') {
        respondJson(res, 403, wireError(ErrorCode.CapabilityDenied, 'cross-site request rejected'))
        return true
      }

      /**
       * ── 管理员路由（`/mobile/admin/*`）────────────────────────────────────
       *
       * ## 为什么单开一个命名空间
       *
       * 清设备过去**没有正式路由**：只能改 `devices.json` 再立刻重启 DSH
       * （`DeviceStore` 只在构造时 `load()`，手改的条目会被下一次 `touch()` 原样写回）。
       * 现在 `POST /mobile/admin/devices/remove` 走 `DeviceStore.remove()`，
       * 内存表与文件同时更新，**不需要重启**。
       *
       * ## 授权判据（与 A 的信任判据**同一套**）
       *
       *   `isLoopbackRequest(req)` **或** 该请求的 authority 落在受信集合里
       *   （静态 `trustedHosts` ∪ 中继 ∪ `phoneBaseUrl` ∪ 自推导的本机地址/主机名）。
       *
       * ★ 为什么不能直接复用"已经过了栅栏"这件事：栅栏放行**回环 hostname**（`localhost` /
       *   `127.0.0.1`）时并不看 socket 来源——那是为了兼容反代与 DNS rebinding 的判据。
       *   一个局域网客户端完全可以发 `Host: localhost` 过栅栏。所以这里必须**另判**
       *   `isLoopbackRequest`（看 socket 与 `x-forwarded-for`），而不是看 Host 长什么样。
       *
       * ## ★ 已知代价（写清楚，别当成没这回事）
       *
       * 自推导把"本机非内部 IPv4"也算作受信之后，**同一个局域网里的人**用
       * `https://<本机IP>:<端口>/mobile/admin/devices/remove` 也能删设备记录。
       * 这是"复用 A 的判据"的直接结果，收益是换网/换机不再需要手配；
       * 代价是**局域网内的一次 DoS**（把所有人踢回重新配对），而**不是**权限提升：
       * 删记录不会新增设备、不会授予任何能力位，重新配对仍需电脑端生成配对码（loopback）
       * 并人工确认指纹。若要把这半边收紧，关掉本机 hostname 只是第一步，
       * 真正的做法是给这条路由单独要求 loopback（把它放回 `LOCAL_ONLY`）——
       * 那会牺牲"从手机上一键清设备"，所以本阶段按方案原文保留，
       * 并把这一条列进 `16-插件封装-第一阶段.md` 的"会误伤真机/收紧建议"。
       */
      if (url.pathname.startsWith('/mobile/admin/')) {
        if (!isAdminSourceTrusted(req, authority, httpTrust)) {
          // ★ 拒绝时**不泄露设备信息**：不回显条数、不回显 deviceId 是否存在、不回显清单。
          //   审计要落一条（这是"谁在敲门"的唯一痕迹），但详情里同样不带设备信息。
          store.record({
            deviceId: '(host)',
            kind: 'deny',
            target: url.pathname,
            detail: `管理员路由拒绝：来源不是 loopback 也不在受信集合（Host=${req.headers.host ?? '(无)'}）`,
            ok: false,
          })
          respondJson(res, 403, wireError(ErrorCode.CapabilityDenied, 'admin endpoints are only available from the host machine or a trusted authority'))
          return true
        }
        void handleAdminHttp(req, res, url).catch((error: unknown) => {
          respondJson(res, 500, wireError(ErrorCode.Internal, String((error as Error)?.message ?? error)))
        })
        return true
      }

      /**
       * 诊断端点：把"宿主实际看到的东西"摊开。
       *
       * 为什么需要：手机端的症状（显示了电脑端页面、操作无效）在服务端**看起来一切正常**，
       * 于是双方各说各话、排查全靠猜。这里直接回答三个关键问题：
       * 从哪个地址来的、被判定成什么角色、以及服务端认为手机该访问哪里。
       */
      /**
       * 根证书下载（`/mobile/ca.crt`）—— 供手机**装一次 CA**，从此本机站点被系统信任。
       *
       * ## 为什么需要它
       *
       * 局域网用的是自签证书，Chrome 因此判定站点"不可信"并**禁用 Service Worker**，
       * 于是系统通知这条路根本走不通（真实现象：`SecurityError: An SSL certificate error`）。
       * 把根证书装进手机后，站点变成可信 ✓ → SW 可注册 ✓ → 通知权限可申请 ✓。
       *
       * 证书内容**不是机密**（公钥而已 ✓），所以直接内嵌在这里，不走文件系统查询，
       * 也就不会因为路径问题读不到 ✓。**私钥 `ca-key.pem` 留在电脑上，绝不出网** ✓。
       */
      if (req.method === 'GET' && (url.pathname === '/mobile/ca.crt' || url.pathname === '/mobile/ca.pem')) {
        const body = Buffer.from(CA_CERT_PEM, 'utf8')
        res.writeHead(200, {
          'content-type': 'application/x-x509-ca-cert',
          'content-length': String(body.length),
          'content-disposition': 'attachment; filename="dsh-mobile-ca.crt"',
          'cache-control': 'no-store, must-revalidate',
        })
        res.end(body)
        return true
      }

      /**
       * 由插件自己发 `boot.js`，**并显式禁止缓存**。
       *
       * ## 为什么必须由我们发
       *
       * 这个文件原先走 DSH 的静态管线（页面里注入 `<script src="/mobile/boot.js">`），
       * 而实测它的响应**没有任何缓存头**（`cache-control` / `etag` / `last-modified` 全无）。
       * 没有缓存头时浏览器会**自行启发式缓存** —— 于是手机上很可能一直跑**旧副本**，
       * 表现为"我明明改了、手机却没反应"（这一串问题的共同嫌疑：
       * 调试框不出现、Service Worker 不注册、通知修复不生效）。
       *
       * 本项目在**配对页**上已经吃过一次同样的亏（改了页面手机还看旧的，排查方向被带偏），
       * 当时立的规矩就是"工具页面必须 `no-store`" —— 这次的教训是：
       * **客户端脚本同理**，凡是"手机要按它行事"的文件都不能被缓存。
       *
       * 内容取自插件自身安装目录下的 `boot.js`（与本文件同级），因此永远与源码一致。
       */
      if (req.method === 'GET' && (url.pathname === '/mobile/boot.js' || url.pathname === '/mobile/boot.js.map')) {
        const file = url.pathname.endsWith('.map') ? 'boot.js.map' : 'boot.js'
        /**
         * ★ 2026-09-30 修：这一段**读不到文件时也必须往下走** ✗。
         *   原先 catch 里只 `console.warn`，然后**照样 `return true`** ⇒ 响应永远不写 ⇒
         *   请求挂到浏览器超时（`curl` 里就是 `000`）✗，而页面表现是"界面能开、boot.js 像没装"——
         *   排查方向被彻底带偏（独立服务从源码跑时必现：`packages/host/src/boot.js` 并不存在）。
         *   现在只有**真的写成功**才 return true；否则交给下面那段 `options.bootScript` 兜底 ✓。
         */
        let served = false
        try {
          const bytes = readFileSync(new URL(`./${file}`, import.meta.url))
          res.writeHead(200, {
            'content-type': file.endsWith('.map') ? 'application/json; charset=utf-8' : 'application/javascript; charset=utf-8',
            'content-length': String(bytes.length),
            'cache-control': 'no-store, must-revalidate',
            pragma: 'no-cache',
          })
          res.end(bytes)
          served = true
        } catch (error) {
          // 读不到就交给后面的静态管线（不要因为一个脚本把整页弄挂）
          console.warn('[dsh-mobile] 无法读取 boot.js，交回静态管线：', error)
        }
        if (served) return true
      }

      /**
       * Service Worker（用于**系统通知**）。
       *
       * 为什么必须有它：**Android 版 Chrome 不支持 `new Notification()`**
       * （抛 `TypeError: Illegal constructor`），而且它要求站点已注册 SW
       * 才会给出通知权限 —— 所以没有这个文件，"手机通知栏通知"这件事根本做不到
       * （真实现象：点「允许通知」连权限询问框都不弹，随后每次都退回页面横幅）。
       *
       * SW 脚本必须是**同源 URL**（不能用 blob/data ✗），所以由插件自己发一份；
       * 内容刻意保持最小：只做 showNotification 与点击聚焦。
       */
      if (req.method === 'GET' && url.pathname === '/mobile/sw.js') {
        const swSource = `self.addEventListener('install', () => self.skipWaiting());
// ★ 空 fetch 处理器：Chrome 的"可安装"清单要求 SW 有 fetch 监听，
//   但这里**刻意什么都不做**（绝不 respondWith）—— 一旦拦截请求，
//   就可能把"改了脚本手机上还跑旧版"那类坑引进来 ✗（配对页上踩过一次）。
self.addEventListener('fetch', () => {});
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    for (const client of list) if ('focus' in client) return client.focus();
    return undefined;
  }));
});
self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.kind !== 'notify') return;
  // 显示成功/失败都**回执给页面**：手机上没有控制台，"通知到底有没有被系统接受"
  // 只能靠这条回执来判断（真实现象：页面说"已 postMessage"，然后就没了下文 ✗）。
  event.waitUntil(
    self.registration
      .showNotification(String(data.title || 'DSH'), {
        body: String(data.body || ''),
        tag: 'dsh-mobile-device',
        renotify: true,
      })
      .then(() => self.clients.matchAll({ type: 'window', includeUncontrolled: true }))
      .then((list) => {
        for (const client of list) client.postMessage({ kind: 'notify-ok' });
      })
      .catch((error) =>
        self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
          for (const client of list) client.postMessage({ kind: 'notify-fail', message: String(error) });
        }),
      ),
  );
});
`
        const body = Buffer.from(swSource, 'utf8')
        res.writeHead(200, {
          'content-type': 'application/javascript; charset=utf-8',
          'content-length': String(body.length),
          // SW 必须**不被缓存**，否则改了脚本手机上还跑旧版（本项目在配对页上吃过这个亏）
          'cache-control': 'no-store, must-revalidate',
          'service-worker-allowed': '/',
        })
        res.end(body)
        return true
      }

      /**
       * PWA 的三条资源：web app manifest 与两张图标（另加一张 maskable）。
       *
       * 图标是**在代码里画出来**的（见 `app-icons.ts` 顶部注释：为什么不塞 png 进仓库）✓。
       * 尺寸必须齐 192 与 512 —— Chrome 的"可安装"清单里这是硬条件 ✓。
       */
      if (req.method === 'GET' && url.pathname === '/mobile/manifest.webmanifest') {
        const body = Buffer.from(JSON.stringify(buildWebAppManifest(), null, 2), 'utf8')
        res.writeHead(200, {
          'content-type': 'application/manifest+json; charset=utf-8',
          'content-length': String(body.length),
          'cache-control': 'no-store, must-revalidate',
        })
        res.end(body)
        return true
      }
      /**
       * 本机 CA 的下载入口 ✓ —— **手机上装一次**，以后换 IP 重签叶子也不影响信任 ✓。
       *
       * 为什么需要它：Chrome 在"证书无效"的源上**拒绝提供安装** ✓（WebAPK 铸造要求有效证书 ✓），
       * 用户的原话是"因为证书失效，Google 不提供 app 下载了"✗。
       * 证书结构改成"长期 CA + 由它签发的叶子"之后 ✓（见 scripts/make-cert.mjs ✓），
       * 手机只要把这张 CA 装进信任库一次 ✓，以后 IP 变化就不会再打断安装 ✓。
       *
       * 用 `application/x-x509-ca-cert` ✓ —— 安卓/Chrome 见到这个类型会直接引导安装 ✓。
       */
      if (req.method === 'GET' && url.pathname === '/mobile/trust.crt') {
        /**
         * ★ 路径不再写死 `homedir()/.dsh/...`，而是问证书管理器（`options.tls`）。
         *
         * 原先写死有两处坏：① `DSH_HOME` 不是 `~/.dsh` 时永远读不到（临时 DSH_HOME、
         * 多 profile、换机都会踩）；② 证书现在由**插件自己生成**（见 `tls-cert.ts`），
         * 路径只有那一处知道。写死就等于把"插件生成"与"手机下载"两条路各写一份。
         */
        const caPem = options.tls?.readCaPem()
        if (caPem !== undefined) {
          const body = Buffer.from(caPem, 'utf8')
          res.writeHead(200, {
            'content-type': 'application/x-x509-ca-cert',
            'content-length': String(body.length),
            'content-disposition': 'attachment; filename="dsh-mobile-ca.crt"',
            'cache-control': 'no-store',
          })
          res.end(body)
        } else {
          const status = options.tls?.status()
          const hint =
            '还没有本机 CA。\n' +
            (status === undefined
              ? '本部署未注入证书管理器（cordis.ts 未启用）。\n'
              : `证书目录：${status.directory}\n${status.ok ? '' : `原因：${status.error ?? '未知'}\n`}`) +
            '插件首启会自动生成；也可以手工跑一次：\n' +
            '  node scripts/make-cert.mjs --ip <当前局域网IP>\n' +
            '（它会同时生成 CA 与由它签发的服务器证书）\n'
          res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
          res.end(hint)
        }
        return true
      }

      /**
       * 原生外壳 APK 的下载入口 ✓（`node scripts/build-apk.mjs` 产出 ✓，
       * 安装脚本会把它复制到本插件目录下 ✓ —— 与 boot.js 同一个套路 ✓）。
       *
       * 为什么要这条路：手机装 PWA 卡在 Google 的 WebAPK 铸造上 ✗（我们改不了 ✓），
       * 而 APK 是**本地安装** ✓、不经过 Google ✓ —— 让手机从这台电脑直接下 ✓，
       * 连数据线都不用插 ✓。
       */
      if (req.method === 'GET' && url.pathname === '/mobile/app.apk') {
        try {
          const apk = readFileSync(new URL('./dsh-mobile.apk', import.meta.url))
          res.writeHead(200, {
            'content-type': 'application/vnd.android.package-archive',
            'content-length': String(apk.length),
            'content-disposition': 'attachment; filename="dsh-mobile.apk"',
            'cache-control': 'no-store, must-revalidate',
          })
          res.end(apk)
        } catch (error) {
          res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
          res.end(
            '这台电脑还没有构建 APK ✓\n' +
              '先在电脑上跑：node scripts/build-apk.mjs\n' +
              '然后重新安装插件（install-host-plugin.mjs）即可 ✓\n',
          )
        }
        return true
      }

      if (req.method === 'GET' && url.pathname.startsWith('/mobile/icon-')) {
        const name = url.pathname.slice('/mobile/'.length)
        const table: Record<string, { size: number; maskable: boolean }> = {
          'icon-192.png': { size: 192, maskable: false },
          'icon-512.png': { size: 512, maskable: false },
          'icon-maskable-512.png': { size: 512, maskable: true },
        }
        const spec = table[name]
        if (spec !== undefined) {
          const body = iconPng(spec.size, { maskable: spec.maskable })
          res.writeHead(200, {
            'content-type': 'image/png',
            'content-length': String(body.length),
            // 图标是纯函数产物、内容不会变；但为了"改了立刻生效"，缓存给短一点
            'cache-control': 'public, max-age=600',
          })
          // 这里的路由都在 `req.method === 'GET'` 分支内，所以直接发（不必再判 HEAD ✓，
          // 上一版写了 `req.method === 'HEAD'`，tsc 直接报"两个类型没有交集" ✗）
          res.end(body)
          return true
        }
      }

      if (req.method === 'GET' && url.pathname === '/mobile/debug') {
        const authority = parseAuthority(req.headers.host)
        const socketAddress = req.socket.remoteAddress ?? ''
        const forwarded = req.headers['x-forwarded-for']
        const diagnosis = {
          host: req.headers.host ?? null,
          hostIsLoopback: authority === undefined ? null : isLoopbackHostname(authority.hostname),
          socketRemoteAddress: socketAddress,
          forwardedFor: typeof forwarded === 'string' ? forwarded : null,
          // 角色判定结果：true = 当成"电脑本机"（会显示配对控制台）
          treatedAsHostMachine: isLoopbackRequest(req),
          role: isLoopbackRequest(req) ? 'desktop' : 'phone',
          phoneBaseUrl: options.phoneBaseUrl ?? null,
          configuredEndpoints: [...options.endpoints()],
          trustedHosts: [...(options.trustedHosts ?? [])],
          connectedDevices: sessions.size,
          /**
           * 本插件**实际在跑**的能力清单。
           *
           * 为什么要有它：宿主侧代码改动**必须重启 DSH 才生效**（模块不像 boot.js 那样每次读盘），
           * 于是"我明明改了，怎么没效果"是这里最容易发生、也最难自证的困惑。
           * 把能力清单打出来，自检脚本一比对就知道"是没生效"还是"生效了但坏了"——
           * 这两种情况的排查方向完全相反。
           */
          features: HOST_FEATURES,
          // agent 工具的**运行时**注册结果（不是静态声明）：'registered' 才算真的可用
          agentTool: service.agentToolStatus(),
        }
        // 默认返回 JSON（便于我用 curl 核对）；带 ?html=1 时返回**页面上可见**的诊断页——
        // 手机上没有控制台，让用户"打开一个地址并截图"是唯一可行的取证方式。
        // 页面上同时跑一遍客户端侧检查（安全上下文 / crypto.subtle / 本地配对配置），
        // 因为"服务端判定正常"与"客户端用不了"可以同时成立，必须两边都看到。
        if (url.searchParams.get('html') === '1') {
          const html = `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<!--
  ★ viewport-fit=cover 是**安全区能生效的前提** ✓ —— 少了它 env(safe-area-inset-*)
  恒为 0 ✗。手机 App（APK）用 targetSdk 35 ✓ 会被系统**强制 edge-to-edge** ✓，
  于是 DSH 自带的预览头部（很薄的一行 ✓）会顶到状态栏下面 ✓ → **点不到** ✓
  （用户原话："全屏时会跑到上面状态栏，导致不能点击" ✗）。
  加上它之后，我们的 CSS 才有办法给那块让出安全区 ✓（见 boot.js 的 safe-area 规则 ✓）。
  ★★ 注意：这段注释在**模板字符串**里 ✓ —— 里面**绝不能出现反引号** ✗（会提前闭合 ✓）。
-->
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>DSH Mobile 诊断</title>
<style>
 body{font:15px/1.6 -apple-system,system-ui,sans-serif;margin:0;padding:16px;background:#0f1115;color:#e6e6e6}
 h1{font-size:18px;margin:0 0 12px} h2{font-size:15px;margin:18px 0 6px;color:#8ab4f8}
 table{border-collapse:collapse;width:100%;font-size:13px} td{padding:4px 6px;border-bottom:1px solid #262a33;vertical-align:top}
 td:first-child{color:#9aa0a6;white-space:nowrap;width:44%}
 .ok{color:#7ee787;font-weight:600} .bad{color:#ff7b72;font-weight:600}
 code{font-size:12px;word-break:break-all;color:#d2a8ff}
 .box{background:#161a22;border-radius:8px;padding:10px;margin-top:8px}
</style></head><body>
<h1>DSH Mobile 诊断</h1>
<div class="box"><b>服务端判定</b><table id="srv"></table></div>
<div class="box"><b>这台手机（浏览器侧）</b><table id="cli"></table></div>
<div class="box"><b>本地已存的配对配置</b><div id="store" style="font-size:12px;word-break:break-all"></div></div>
<div class="box"><b>最近捕获的错误（第一条最重要）</b><ol id="errs" style="margin:6px 0 0 18px;padding:0;font-size:12px;color:#ffb4a2"></ol></div>
<div class="box"><b>隧道状态序列（最近 40 条，最新在最下）</b><pre id="seq" style="font-size:11px;white-space:pre-wrap;word-break:break-all;margin:6px 0 0;color:#c9d1d9"></pre></div>
<div class="box"><b>最后一帧</b><div id="prev" style="font-size:12px;word-break:break-all"></div></div>
<div class="box"><b>帧解析错误（若有）</b><div id="frameerr" style="font-size:12px;word-break:break-all"></div></div>
<p style="color:#9aa0a6;font-size:12px;margin-top:14px">把这一屏截图发给开发者即可定位问题。</p>
<script>
var S=${JSON.stringify(diagnosis)};
var srv=document.getElementById('srv');
for (var k in S) { var tr=document.createElement('tr'); var a=document.createElement('td'); a.textContent=k;
  var b=document.createElement('td'); b.textContent=JSON.stringify(S[k]);
  if (k==='role') b.className = S[k]==='phone' ? 'ok' : 'bad';
  tr.appendChild(a); tr.appendChild(b); srv.appendChild(tr); }
function row(t,label,value,cls){var tr=document.createElement('tr');var a=document.createElement('td');a.textContent=label;
  var b=document.createElement('td');b.textContent=value;if(cls)b.className=cls;tr.appendChild(a);tr.appendChild(b);t.appendChild(tr);}
var cli=document.getElementById('cli');
row(cli,'当前地址', location.href);
row(cli,'安全上下文 isSecureContext', String(window.isSecureContext), window.isSecureContext?'ok':'bad');
row(cli,'crypto.subtle', typeof (window.crypto&&window.crypto.subtle), (window.crypto&&window.crypto.subtle)?'ok':'bad');
row(cli,'能否生成设备密钥','检测中…');
if (window.crypto && window.crypto.subtle) {
  window.crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify'])
    .then(function(){row(cli,'能否生成设备密钥','成功',null);var t=cli.rows[3];t.cells[1].textContent='成功';t.cells[1].className='ok';})
    .catch(function(e){var t=cli.rows[3];t.cells[1].textContent='失败: '+e.message;t.cells[3]&&0;t.cells[1].className='bad';});
} else { var t=cli.rows[3]; t.cells[1].textContent='不可用（非安全上下文）'; t.cells[1].className='bad'; }
row(cli,'是否装了加密隧道', String(!!globalThis.__DSH_TRANSPORT__));
row(cli,'隧道当前状态', globalThis.__DSH_MOBILE_BOOT__ ? String(globalThis.__DSH_MOBILE_BOOT__.state()) : '（本页不是 DSH 界面，正常）');
// ── 本地已存的配对配置（★ P1a：读要带指纹优先 ✗ 见下）────────────────────────
var storeBox=document.getElementById('store');
storeBox.textContent='（读取中…）';
function diagLocal(key){ try { return localStorage.getItem(key) } catch (e) { return null } }
// 基名 host 配置里的宿主指纹（坏 JSON / 缺字段 ⇒ undefined，绝不抛）
function diagOwnerFingerprint(raw){ if (typeof raw!=='string'||raw.length===0) return undefined;
  try { var v=JSON.parse(raw).pinnedHostFingerprint; return (typeof v==='string'&&v.length>0)?v:undefined } catch (e) { return undefined } }
/**
 * ★★ 带指纹优先、基名兜底 ✓ —— 与 boot.js 的 readIdentityKeyValue、配对页的
 *   readIdentityRaw **同一口径** ✓（键名改了，读者必须跟着改 ✓；见 §4.1ai ✓）。
 * ★ 一个身份都没有 ⇒ 写「未知」✓ —— **绝不**写成「（空 —— 尚未配对）」✗：
 *   读不到只能说明"本浏览器里没读到" ✓，说明不了"没配对" ✗（身份可能在壳里 ✓）。
 *   本项目明文纪律：**拿不到就写未知、不许编** ✓。
 */
function diagShowStore(fingerprint){
  var scoped=(typeof fingerprint==='string'&&fingerprint.length>0)?('dsh-mobile.host:'+fingerprint):null;
  var raw=null, source=null;
  if (scoped!==null) { raw=diagLocal(scoped); if (raw!==null) source=scoped; }
  if (raw===null) {
    // 基名兜底：**归属必须可证**（基名配置里的指纹 == 本机指纹）才敢用 ✗
    var legacy=diagLocal('dsh-mobile.host');
    if (legacy!==null && scoped!==null && diagOwnerFingerprint(legacy)===fingerprint) { raw=legacy; source='dsh-mobile.host（基名兜底，指纹已核对）'; }
    else if (legacy!==null && scoped===null) { raw=legacy; source='dsh-mobile.host（基名；拿不到本机指纹 ⇒ 归属未核对）'; }
  }
  if (raw===null) { storeBox.textContent='未知 —— 本浏览器里没有读到这台电脑的身份（拿不到就写未知，绝不编结论）'; return }
  storeBox.textContent='来源：'+source+'\\n'+raw;
}
fetch('/mobile/manifest',{headers:{'accept':'application/json'}})
  .then(function(r){ return r.ok ? r.json() : null })
  .then(function(m){ diagShowStore(m && typeof m.hostFingerprint==='string' ? m.hostFingerprint : null) })
  .catch(function(){ diagShowStore(null) });
// 上一页（DSH 界面）留下的痕迹：boot.js 会把隧道状态与最后错误写在这里
var prev=null; try { prev=localStorage.getItem('dsh-mobile.lastTunnel') } catch(e){}
document.getElementById('prev').textContent = prev === null ? '（无 —— 还没进过 DSH 界面）' : prev;
// 帧解析错误（偶发）：把现场带出来，便于定位"帧长不匹配"
var frameErr = null; try { frameErr = localStorage.getItem('dsh-mobile.lastFrameError') } catch (e) {}
document.getElementById('frameerr').textContent = frameErr === null ? '（无）' : frameErr;
// 状态**序列**（环形缓冲）：单看最后一帧只能看到 disconnected，看不出"连上→断开→重连"的过程
var log=[]; try { log=JSON.parse(localStorage.getItem('dsh-mobile.tunnelLog')||'[]') } catch(e){}
var box=document.getElementById('seq');
if (!Array.isArray(log) || log.length===0) { box.textContent='（无记录）'; }
else {
  var lines=log.map(function(e){
    var t=(e.at||'').slice(11,19);
    return t+'  '+String(e.state)+(e.error?('  err='+String(e.error).slice(0,80)):'')+(e.attempt?('  attempt='+e.attempt):'');
  });
  box.textContent=lines.join('\\n');
}
// 捕获本页脚本错误（若有）
var errs=document.getElementById('errs');
function addErr(t){ var li=document.createElement('li'); li.textContent=String(t).slice(0,200); errs.appendChild(li); }
window.addEventListener('error', function(e){ addErr('error: ' + e.message + ' @' + (e.filename||'').split('/').pop() + ':' + e.lineno) });
window.addEventListener('unhandledrejection', function(e){ addErr('rejection: ' + ((e.reason && e.reason.message) || e.reason)) });
</script></body></html>`
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
          res.end(html)
          return true
        }
        respondJson(res, 200, diagnosis)
        return true
      }

      /**
       * 会话页：我们自己的页面（承载 DSH 输出的那一层 ✓）。
       * 与 Codex 页同样是"工具界面"⇒ 彻底不缓存 ✓；CSP 放开内联样式与同源脚本 ✓，
       * 隧道是 wss: 同源升级，因此 connect-src 里显式带上 wss: ✓。
       */
      // 会话页（我们自己的页面 ✓）：HTML 与 css/js 都是 **assets/dsh-chat/ 下的真文件** ✓
      //（HTML 也放文件里，是 codex 页那条教训的延伸：模板字符串转义会把脚本截断 ✗）
      const chatAssets: Record<string, string> = {
        'page.html': 'page.html',
        'theme.css': 'theme.css',
        'app.js': 'app.js',
        'ui.js': 'ui.js',
        'poller.js': 'poller.js',
      }
      /**
       * ★★ 这里必须显式标类型 ✗ —— `npm test` 是**擦类型**跑的 ✓、从不做类型检查 ✓，
       *   所以"单测全绿"**从来不等于**类型对 ✓（2026-10-04：第一次真正跑 `npm run build`，
       *   它当场在本文件报出三处我写的错 ✓ —— 见下面 `ErrorCode.NotFound` 那处 ✓）。
       */
      const chatAsset = (name: string): Buffer | undefined => {
        const relative: string | undefined = Object.prototype.hasOwnProperty.call(chatAssets, name)
          ? chatAssets[name]
          : undefined
        if (relative === undefined) return undefined
        /**
         * ★★ 路径解析收敛到 `host-assets.ts` **一处** ✓（2026-10-05）——
         *   原先这里是一对内联字面量候选 ✓，与 codex 那处各写一遍 ✗。
         *   它**相对插件自身** ✓、与 cwd 无关 ✓，现在还能被单测在
         *   **任意 cwd** 下钉住 ✓（`test/runtime-assets.test.ts` ✓）。
         *
         * ★ 但要说清病根 ✗：用户那条 `mobile/internal`
         *   （「会话页 HTML 未找到（assets/dsh-chat/page.html）」✓）
         *   **不是这段解析写错了** ✗ —— 是这个文件**从来没被装进 profile** ✗
         *   （构建与安装两处都补了 ✓：`scripts/lib/runtime-assets.mjs` ✓）。
         */
        return readHostAsset(join('dsh-chat', relative))
      }
      if (req.method === 'GET' && (url.pathname === '/mobile/chat' || url.pathname === '/mobile/chat/')) {
        const page = chatAsset('page.html')
        if (page === undefined) {
          respondJson(res, 404, wireError(ErrorCode.Internal, '会话页 HTML 未找到（assets/dsh-chat/page.html）'))
          return true
        }
        const body = page
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'content-length': String(body.length),
          'cache-control': 'no-store, must-revalidate',
          pragma: 'no-cache',
          'content-security-policy':
            "default-src 'none'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self' wss:; img-src 'self' data:",
          'referrer-policy': 'no-referrer',
          'x-content-type-options': 'nosniff',
          'x-dsh-mobile': 'dsh-chat-page',
        })
        res.end(body)
        return true
      }

      /**
       * ★★ 桌面缩略图：手机首页那张小图 ✓（用户 2026-10-03 选的是"真截图"✓）。
       *
       * ★ 这个处理函数**不是 async** ✗（同一个处理链里的路由都不是 ✓）——
       *   而截屏是异步的 ✓ ⇒ 这里**不 await** ✗：**先认领请求**（`return true` ✓），
       *   等 Promise 落地时**再写响应** ✓。认领后必须保证一定写回去 ✗，
       *   否则手机会一直等到自己的超时 ✓（`ShotFetch` 那边 6 秒 ✓）。
       *
       * ★ 失败时回 502 + **人话** ✓（`explainCaptureFailure` ✓ 把
       *   "could not create image from display" 翻成"去哪儿开权限"✓）——
       *   手机上那张卡就会如实说"截不到图"✓，而不是白着 ✓。
       */
      /**
       * ★★★ 第一阶段第 6 项（用户："首页那个缩略图，你要用桌面，而不是实际的截图"）：
       *   返回这台电脑的**桌面壁纸** ✓ —— 不是截屏 ✓。
       *   读不到就 502 + **人话** ✓（手机上那张卡会如实说为什么 ✓），
       *   **绝不退回截屏** ✗（否则等于把用户否掉的东西又漏出去 ✓）。
       * ★ 上限 8 MB：壁纸通常是几 MB 的图 ✓，超过就当读不出来 ✓（不把内存吃光 ✗）。
       */
      if (req.method === 'GET' && url.pathname === '/mobile/desktop/wallpaper') {
        const found = resolveWallpaper(process.platform, (command, args, timeoutMs) => {
          try {
            const stdout = execFileSync(command, args, { timeout: timeoutMs, encoding: 'utf8' })
            return { ok: true, stdout: String(stdout) }
          } catch (error) {
            return { ok: false, stdout: '', reason: error instanceof Error ? error.message : String(error) }
          }
        })
        const mime = found.ok && found.path !== undefined ? imageMimeOf(found.path) : undefined
        const size = found.ok && found.path !== undefined ? wallpaperSize(found.path) : undefined
        if (!found.ok || found.path === undefined || mime === undefined
            || size === undefined || size > 8 * 1024 * 1024) {
          const why = !found.ok
            ? (found.reason ?? '读不到这台电脑的桌面壁纸')
            : (mime === undefined ? '这个壁纸的格式认不出来' : '这个壁纸太大或读不出来')
          console.warn('[dsh-mobile] 壁纸不可用：' + why)
          respondJson(res, 502, wireError(ErrorCode.Internal, why))
          return true
        }
        res.writeHead(200, {
          'content-type': mime,
          'content-length': String(size),
          'cache-control': 'no-store, must-revalidate',
          pragma: 'no-cache',
          'x-dsh-mobile': 'desktop-wallpaper',
        })
        res.end(readFileSync(found.path))
        return true
      }

      if (req.method === 'GET' && url.pathname === '/mobile/desktop/shot') {
        captureShot({ runner: shotRunner, now: () => Date.now() })
          .then((shot) => {
            res.writeHead(200, {
              'content-type': 'image/png',
              'content-length': String(shot.bytes.length),
              'cache-control': 'no-store, must-revalidate',
              pragma: 'no-cache',
              'x-dsh-mobile': 'desktop-shot',
            })
            res.end(shot.bytes)
          })
          .catch((error: unknown) => {
            const message = error instanceof Error ? error.message : explainCaptureFailure(String(error), 1)
            // ★ 日志走 `console.warn` ✓（这个文件里没有 `Log` 这个符号 ✗ ——
            //   我第一版凭空写了 `Log.warn` ✓，而 TS 的类型擦除**不会**替我抓它 ✓，
            //   它会变成一个运行时 ReferenceError ✓：截图失败时反而把处理链炸掉 ✗）
            console.warn('[dsh-mobile] 截图失败：' + message)
            respondJson(res, 502, wireError(ErrorCode.Internal, message))
          })
        return true
      }

      /**
       * 会话页的样式与脚本：**从磁盘的真文件发出去** ✓
       * （理由见 dsh-chat-page.ts：模板字符串转义把脚本截断过一次又一次 ✗）。
       */
      /**
       * ★★★ **会话清单**（只读 JSON ✓）—— 给**原生「会话」标签**用 ✓（2026-10-04 用户选 (a) ✓）。
       *
       * ## 为什么需要它 ✗（原生侧说不了隧道 RPC ✓）
       *
       * 会话清单原本只有一条路：网页层 `rpc('mobile/dsh/sessions')` ✓ ——
       * 那是**隧道 RPC** ✓（要做设备握手 + 加密帧 ✓），Java 侧说不了 ✗。
       * ⇒ 在这边开一条**只读**的 HTTP 路由 ✓，内部调**同一个桥** ✓
       *   （`dsh-chat-bridge.ts` ✓ —— "认 DSH 的形状"仍然只在那一个文件里 ✓）。
       *
       * ★ **只读** ✗：只列清单 ✓，不发消息、不建会话 ✓（写操作继续走网页层那条路 ✓）。
       * ★ 必须放在下面 `/mobile/chat/` **之前** ✗ —— 否则会被那条静态路由先截走 ✓。
       */
      if (req.method === 'GET' && url.pathname === '/mobile/chat/sessions') {
        /**
         * ★★ 这里**不能** `await` / 不能 `import(...)` 直接取 ✗ ——
         *   这个 HTTP handler **不是 async** ✓（2026-10-04 我又在这堵墙上撞了一次 ✓，
         *   上一次是截图路由 ✓，写法就照那次 ✓：**先领下请求、异步把响应写回去** ✓）。
         *   ★ 也**不写内联类型注解** ✗（`.then` 的参数由推断给出 ✓ ——
         *     strip-types 的加载器对内联注解挑得很 ✓）。
         */
        void import('./dsh-chat-bridge.ts')
          .then((bridge) =>
            bridge.handleDshChatEndpoint(
              {
                call: (target, payload) =>
                  /**
                   * ★ 这个 `call` 是**桥**要的形状 ✓（第三个参数是可选的中止信号 ✓）；
                   *   而 `invokeGatewayEndpoint` 的第 4 个参数**不是可选**的 ✗
                   *   ⇒ 给它一个**永不自作主张中止**的 controller.signal ✓
                   *   （这条路由是一次性只读请求 ✓，本来就没人会中途取消它 ✓）。
                   */
                  invokeGatewayEndpoint(options.gateway, target, payload, new AbortController().signal),
              },
              'mobile/dsh/sessions',
              {},
              undefined,
            ),
          )
          .then((body) => {
            respondJson(res, 200, body)
          })
          .catch((error) => {
            const message = error instanceof Error ? error.message : String(error)
            console.warn('[dsh-mobile] 会话清单拿不到：' + message)
            respondJson(res, 502, wireError(ErrorCode.Internal, '拿不到会话清单：' + message))
          })
        return true
      }

      if (req.method === 'GET' && url.pathname.startsWith('/mobile/chat/')) {
        const name = url.pathname.slice('/mobile/chat/'.length)
        const asset = name === 'page.html' ? undefined : chatAsset(name)
        if (asset === undefined) {
          /**
           * ★★ `ErrorCode.NotFound` **不存在** ✗ —— 我凭想象写的 ✓（协议里只有下面这些 ✓）。
           *   它不只是类型错：运行时会拿到 `undefined` ✓ ⇒ `wireError(undefined, …)` ✓
           *   ⇒ 手机上收到的错误码是个空洞 ✓（**又一个"看不出来"的静默错** ✓）。
           *   ⇒ 用真实存在的 `Internal` ✓（HTTP 层已经用 404 表达了"没有这个资源"✓）。
           */
          respondJson(res, 404, wireError(ErrorCode.Internal, `会话页没有这个资源：${name}`))
          return true
        }
        const body = asset
        const type = name.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8'
        res.writeHead(200, {
          'content-type': type,
          'content-length': String(body.length),
          'cache-control': 'no-store, must-revalidate',
          pragma: 'no-cache',
        })
        res.end(body)
        return true
      }

      if (req.method === 'GET' && url.pathname === '/mobile/manifest') {
        respondJson(res, 200, service.manifest())
        return true
      }

      // 配对页：电脑打开是配对控制台，手机打开是配对入口。
      // 它自身通过 /mobile/pair/* 等端点工作，因此同样受上面的信任栅栏保护。
      if (req.method === 'GET' && (url.pathname === '/mobile' || url.pathname === '/mobile/')) {
        /**
         * 入口路径可配置（默认 `/mobile/app`）：
         * 独立服务没有 DSH 外壳，配对完必须落到 `/mobile/codex` ✓。
         * 页面里那两处 `/mobile/app` 就是"配对完成后去哪"（自动跳转 + 手动链接），
         * 其余出现只是注释；因此做一次整体替换即可，且**只在非默认值时才做** ✓。
         */
        const entryPath = options.entryPath !== undefined && options.entryPath.length > 0 ? options.entryPath : '/mobile/app'
        const pairingHtml = entryPath === '/mobile/app' ? PAIRING_PAGE_HTML : PAIRING_PAGE_HTML.split('/mobile/app').join(entryPath)
        const body = Buffer.from(pairingHtml, 'utf8')
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'content-length': String(body.length),
          // 配对页是工具界面，**必须彻底不缓存**：
          // 用 no-cache 时浏览器仍可能命中旧副本，导致"插件已修复但页面还是坏的"
          // （本项目真实发生过：用户看到的是修复前的旧页面，排查方向被带偏）。
          'cache-control': 'no-store, must-revalidate',
          pragma: 'no-cache',
          // 同源脚本与样式全部内联，因此收紧 CSP 不会破坏它
          'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:",
          'referrer-policy': 'no-referrer',
          'x-content-type-options': 'nosniff',
        })
        res.end(body)
        return true
      }

      // Codex 独立页面：不经 DSH 前端，直接用同一条隧道（见 codex-page.ts 的模块说明）。
      // 与配对页同样是"工具界面"⇒ 彻底不缓存；CSP 放开内联脚本与同源 boot.js，
      // 隧道是 wss: 同源升级，因此 connect-src 里显式带上 wss:（'self' 在部分浏览器上
      // 不覆盖 ws/wss 的 scheme 升级，宁可写全 ✓）。
      const codexPagePaths = new Set([CODEX_PAGE_PATH, `${CODEX_PAGE_PATH}/`])
      if (options.appShellAlias === true) {
        // 原版配对链路（APK 扫码 / 配对页跳转）都落在 /mobile/app 上 ⇒ 这里发同一份页面。
        codexPagePaths.add('/mobile/app')
        codexPagePaths.add('/mobile/app/')
      }
      if (req.method === 'GET' && codexPagePaths.has(url.pathname)) {
        const body = Buffer.from(CODEX_PAGE_HTML, 'utf8')
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'content-length': String(body.length),
          'cache-control': 'no-store, must-revalidate',
          pragma: 'no-cache',
          'content-security-policy':
            "default-src 'none'; style-src 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self' wss:; img-src 'self' data:",
          'referrer-policy': 'no-referrer',
          'x-content-type-options': 'nosniff',
          'x-dsh-mobile': 'codex-page',
        })
        res.end(body)
        return true
      }

      /**
       * Codex 页面的客户端脚本：**从磁盘的真文件发出去**（assets/codex/ui.js）。
       * 为什么是文件而不是内联字符串：模板字符串转义把脚本截断过一次又一次 ✗（见 codex-page.ts 的说明）。
       */
      if (req.method === 'GET' && url.pathname === CODEX_PAGE_SCRIPT_PATH) {
        /**
         * ★ 与上面会话页**同一份**解析实现 ✓（2026-10-05 收敛 ✓）——
         *   这里原先自己写了一份一样的候选数组 ✗。
         *   ★ 它同样**只**从磁盘读 ✓ ⇒ 「assets 装没装出去」这件事对 codex 页一样致命 ✗
         *     （codex/ 那棵树也在 `scripts/lib/runtime-assets.mjs` 的清单里 ✓）。
         */
        const found = resolveHostAsset('codex/ui.js')
        if (found === undefined) {
          respondJson(res, 404, wireError(ErrorCode.Internal, `codex ui.js 未找到（试过 ${hostAssetCandidates('codex/ui.js').join(' / ')}）`))
          return true
        }
        const body = readFileSync(found)
        res.writeHead(200, {
          'content-type': 'text/javascript; charset=utf-8',
          'content-length': String(body.length),
          'cache-control': 'no-store, must-revalidate',
          pragma: 'no-cache',
        })
        res.end(body)
        return true
      }

      // 注入脚本：内容公开（前端代码本就是公开产物），但必须能被缓存校验。
      // 用 immutable 缓存会让升级后旧脚本残留，因此只给短缓存 + ETag。
      if (req.method === 'GET' && url.pathname === '/mobile/boot.js') {
        const script = options.bootScript?.()
        if (script === undefined) {
          respondJson(res, 404, wireError(ErrorCode.Internal, 'boot script is not installed'))
          return true
        }
        const body = Buffer.from(script.source, 'utf8')
        res.writeHead(200, {
          'content-type': 'text/javascript; charset=utf-8',
          'content-length': String(body.length),
          // **no-store 而不是 no-cache**：no-cache 允许浏览器先复用本地副本再后台校验，
          // 曾导致"服务端已更新、手机却还在跑旧 boot.js"——修复无法送达，看起来像"没修好"。
          // boot.js 只有几十 KB，每次重取的成本远低于"跑着旧代码"的排查代价。
          'cache-control': 'no-store, must-revalidate',
          pragma: 'no-cache',
          etag: `"${script.sha256}"`,
        })
        res.end(body)
        return true
      }

      /**
       * 配对与设备端点分成两类，**信任范围与分发是两件独立的事**：
       *
       * - `LOCAL_ONLY`：必须"人在电脑前"。生成配对码、确认配对、看设备列表/审计，
       *   都涉及授权决策，只能在本机操作。
       * - `PAIRING`：手机必须能调用的配对流程端点。`claim` 尤其关键——
       *   宿主需要设备公钥才能在电脑端展示指纹供人工比对。
       *
       * 早期把这两类混成一个 `isManagement` 判断，既用它决定"要不要查本机"、
       * 又用它决定"要不要分发"，于是修好一边就坏另一边：
       *   · 全归为管理端点 → 手机 claim 被 403；
       *   · 全部移出管理端点 → claim 落到 404（没人分发）。
       * 现在两者分开判定，两个问题同时消失。
       */
      const LOCAL_ONLY = new Set([
        '/mobile/pair/code',
        '/mobile/pair/confirm',
        '/mobile/pair/pending',
        // 状态查询只凭 6 位配对码即可调用，若对局域网开放就等于可枚举
        // （而手机并不需要它：设计上手机靠"重试隧道"判断是否已获允许）。
        '/mobile/pair/status',
        // 端侧请求：让手机做事**只能从电脑本机发起**（否则同局域网的人就能指挥别人的手机）
        '/mobile/device/call',
        '/mobile/device/status',
      ])
      const PAIRING = new Set(['/mobile/pair/claim'])

      const isDevices = url.pathname.startsWith('/mobile/devices')
      const isAudit = url.pathname.startsWith('/mobile/audit')

      if (isDevices || isAudit || LOCAL_ONLY.has(url.pathname)) {
        if (!isLoopbackRequest(req)) {
          respondJson(
            res,
            403,
            wireError(ErrorCode.CapabilityDenied, 'device management is only available from the host machine'),
          )
          return true
        }
        void handlePairHttp(req, res, url).catch((error: unknown) => {
          respondJson(res, 500, wireError(ErrorCode.Internal, String((error as Error)?.message ?? error)))
        })
        return true
      }

    /**
     * 短码配对入口：`GET /mobile/p/<6 位码>` → 302 到应用外壳并带上票据。
     *
     * 为什么值得单独做一条路由：二维码里编的是 `dshmobile://pair?d=…` 深链，
     * **浏览器打不开**（那是给原生外壳用的 scheme）✗ —— 于是手机侧唯一的办法
     * 是把那条长链复制粘贴进 `/mobile` 页的输入框 ✓。
     * 而 6 位码本来就显示在电脑屏幕上、且要和手机对照，用户**照着敲 6 个数字**
     * 比复制一条长链自然得多 ✓。
     *
     * 放在 `/mobile` 前缀下（而不是更短的 `/m/p`）：这条前缀已经在插件的
     * 信任栅栏与路由表里，不引入新的前缀注册（少一处可能和 DSH 抢路径的地方）。
     */
      const shortMatch = /^\/mobile\/p\/([0-9]{6})$/.exec(url.pathname)
      if (req.method === 'GET' && shortMatch !== null) {
        /**
         * 猜码限速（T2）：**先看冷却，再查码**。
         *
         * 顺序很重要：冷却期内连"这个码对不对"都不回答（429 而不是 404），
         * 否则限速只压低了请求频率，码空间照样能被枚举完（90 万个取值并不大）。
         */
        const cooldownMs = pairingGuessCooldownMs(req, Date.now())
        if (cooldownMs > 0) {
          const retryAfter = String(Math.ceil(cooldownMs / 1000))
          res.writeHead(429, {
            'content-type': 'text/html; charset=utf-8',
            'cache-control': 'no-store',
            'retry-after': retryAfter,
          })
          res.end(
            '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">' +
              '<body style="font:16px/1.7 -apple-system,system-ui;padding:24px;background:#15171a;color:#e8eaed">' +
              '<h3>尝试次数过多</h3><p>输入错误的配对码次数过多，请稍后再试，或在电脑上重新生成一个配对码。</p></body>',
          )
          return true
        }
        const payload = service.pairingPayloadForCode(shortMatch[1] ?? '')
        if (payload === undefined) {
          // 只对"码无效/已过期"计一次失败；命中时走下面的清零分支
          notePairingGuessFailure(req, Date.now())
          res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' })
          res.end(
          '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">' +
            '<body style="font:16px/1.7 -apple-system,system-ui;padding:24px;background:#15171a;color:#e8eaed">' +
            '<h3>配对码无效或已过期</h3><p>请在电脑上重新生成配对码，再输入那 6 位数字。</p></body>',
        )
          return true
        }
        notePairingGuessSuccess(req)
        const entryPath = options.entryPath !== undefined && options.entryPath.length > 0 ? options.entryPath : '/mobile/app'
        res.writeHead(302, { location: entryPath + '?pair=' + encodeURIComponent(payload), 'cache-control': 'no-store' })
        res.end()
        return true
      }

      if (PAIRING.has(url.pathname)) {
        // 手机可调用：信任栅栏已在前面校验过 Host/Origin，这里不再要求本机。
        // 方法必须显式校验：否则错误的动词会一路落到末尾的 404，
        // 让"端点存在但方法不对"看起来像"端点不存在"（误导排障）。
        if (req.method !== 'POST') {
          respondJson(res, 405, wireError(ErrorCode.HandshakeMalformed, `${url.pathname} requires POST`))
          return true
        }
        void handlePairHttp(req, res, url).catch((error: unknown) => {
          respondJson(res, 500, wireError(ErrorCode.Internal, String((error as Error)?.message ?? error)))
        })
        return true
      }

      return false
    },
  }
}

// ────────────────────────────── 辅助 ──────────────────────────────

/** 规范化后的 authority。 */
export interface ParsedAuthority {
  readonly hostname: string
  /** 显式写出的端口；未写则为空串。 */
  readonly port: string
  /** hostname 或 hostname:port，用于同源比较。 */
  readonly host: string
}

/**
 * 解析 Host 或 Origin 头为规范化 authority；不可解析时返回 undefined。
 *
 * 两种输入形态必须都能处理：
 *  - `Host`：裸 authority，如 `10.0.0.5:3081`
 *  - `Origin`：**带 scheme** 的完整源，如 `http://10.0.0.5:3081`
 *
 * 早期实现无条件拼 `http://`，于是 `Origin` 变成 `http://http://10.0.0.5:3081`，
 * 解析出的 hostname 是字面量 `http`——结果**任何带 Origin 的浏览器请求都被判为跨源**
 * 并返回 403。症状是"配对页按钮点了没反应/报 Origin does not match Host"，
 * 而且不带 Origin 的 curl 测试一切正常，极易误判。
 */
export function parseAuthority(value: string | undefined): ParsedAuthority | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined
  try {
    const url = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(value) ? new URL(value) : new URL(`http://${value}`)
    if (url.hostname === '' || url.username !== '' || url.password !== '') return undefined
    return {
      hostname: url.hostname,
      port: url.port,
      host: url.port === '' ? url.hostname : `${url.hostname}:${url.port}`,
    }
  } catch {
    return undefined
  }
}

/** WHATWG 归一化下的 loopback 判定（与 DSH 的栅栏同语义）。 */
function isLoopbackHostname(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '[::1]' || hostname === '::1') return true
  const parts = hostname.split('.')
  return parts.length === 4 && parts[0] === '127' && parts.every((part) => /^\d{1,3}$/.test(part))
}

/** Host 是否匹配某个 trustedHosts 条目（带端口精确匹配，不带端口匹配任意端口）。 */
export function matchesTrusted(authority: ParsedAuthority, trustedHosts: readonly string[]): boolean {
  for (const entry of trustedHosts) {
    const parsed = parseAuthority(entry)
    if (parsed === undefined) continue
    if (parsed.port === '') {
      if (parsed.hostname === authority.hostname) return true
    } else if (parsed.host === authority.host) {
      return true
    }
  }
  return false
}

/** 经回源必须拒绝的精确路径。 */
const RELAY_BACKHAUL_REFUSED_EXACT = new Set([
  '/mobile/pair/code',
  '/mobile/pair/confirm',
  '/mobile/pair/pending',
  '/mobile/pair/status',
])

/** 经回源必须拒绝的路径前缀。 */
const RELAY_BACKHAUL_REFUSED_PREFIX = ['/mobile/devices', '/mobile/audit', '/mobile/debug', '/mobile/device']

/**
 * 中继回源通道**必须拒绝**的路径（T3 / 评估 §3②）。
 *
 * ## 这条判据为什么存在
 *
 * 回源通道是把中继送来的请求用**环回 fetch** 打到插件自己的 HTTP 路由上（复用真实路由，不另写一套），
 * 于是 `isLoopbackRequest` 会把它们判成"人在电脑前"—— `LOCAL_ONLY` 那些端点（配对码、配对确认、
 * 设备管理、审计、诊断、**端侧控制**）本来只对回环开放，经这条通道就会变成可达。
 * 回源的暴露面必须与"同局域网的人直接访问代理"**等价**，不能更大。
 *
 * ## 为什么选"补拒绝名单"而不是"默认拒绝 + 白名单"（评估给的两个选项里选①）
 *
 * 白名单看起来更稳，但回源通道同时要送**页面本身**：`/mobile/app`、`/mobile/boot.js`、
 * `/mobile/sw.js`、`/assets/*`、`/plugins/*`……其中后两类根本不是本插件的路由
 * （`handleHttp` 直接 `return false` 交给 DSH 的静态管线），数量随上游版本变化。
 * 白名单漏一条，症状是**手机整页打不开**（只有真机看得见），而这正是卡片警告的"误伤正常手机"。
 * 拒绝名单只列"明确不该经回源暴露"的端点；它漏了会退化成"暴露面比局域网大"（安全问题），
 * 但不会把手机弄断线。两者都不完美，这里把风险放在**可枚举、可回归测试**的一侧。
 *
 * ## 为什么用前缀 `/mobile/device` 而不是再补两条精确路径
 *
 * 评估发现漏网的正是 `/mobile/device/call` 与 `/mobile/device/status` **两条**，
 * 而漏网的原因恰恰是"按精确路径逐条维护名单"。整个 `/mobile/device/*` 命名空间的语义就是
 * "电脑 → 手机"的端侧控制，**没有任何一条**应该经回源暴露；用前缀可以从结构上避免
 * "以后再加一条又忘了补名单"。手机侧也不需要这些 HTTP 路径：它走的是**隧道内**的
 * `mobile/device/*` RPC（见 `invokeLocalEndpoint`），与这里判的 HTTP 路径不是一回事。
 */
export function isRefusedRelayBackhaulPath(path: string): boolean {
  return RELAY_BACKHAUL_REFUSED_EXACT.has(path) || RELAY_BACKHAUL_REFUSED_PREFIX.some((prefix) => path.startsWith(prefix))
}

/** 生成高熵随机票据（base64url，32 字节）。 */
function randomTicket(): string {
  return randomBytes(32).toString('base64url')
}

/** 判断请求是否来自本机（loopback）。设备管理端点依赖此判断。 */
export function isLoopbackRequest(req: IncomingMessage): boolean {
  const address = req.socket.remoteAddress ?? ''
  const normalized = address.startsWith('::ffff:') ? address.slice(7) : address
  const socketIsLoopback = normalized === '::1' || normalized === '127.0.0.1' || normalized.startsWith('127.')

  // 局域网代理转发时，socket 对端永远是 loopback，真实来源只能由代理注入的头表达。
  // 只在 socket 确实是 loopback 时才信任该头——否则一个直连的局域网客户端
  // 就能靠伪造 x-forwarded-for: 127.0.0.1 把自己伪装成"人在电脑前"。
  const forwarded = req.headers['x-forwarded-for']
  if (socketIsLoopback && typeof forwarded === 'string' && forwarded.length > 0) {
    const first = forwarded.split(',')[0]?.trim() ?? ''
    if (first.length > 0) {
      const candidate = first.startsWith('::ffff:') ? first.slice(7) : first
      return candidate === '::1' || candidate === '127.0.0.1' || candidate.startsWith('127.')
    }
  }

  return socketIsLoopback
}

function respondJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) return
  const payload = Buffer.from(JSON.stringify(body), 'utf8')
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': String(payload.length) })
  res.end(payload)
}

async function readJsonBody<T>(req: IncomingMessage, limit = 64 * 1024): Promise<T | undefined> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > limit) return undefined
    chunks.push(buffer)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T
  } catch {
    return undefined
  }
}
