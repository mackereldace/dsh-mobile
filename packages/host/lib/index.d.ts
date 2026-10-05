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
import type { KeyObject } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { type DeviceCapabilities, type DeviceRecord, type MobileManifest, type PairingTicket } from './protocol/index.js';
import { DeviceStore, type AuditEntry } from './devices.ts';
import { type NetworkInterfacesReader } from './lan-trust.ts';
import { type DshFrontendProbe } from './dsh-probe.ts';
import { type LanListenerStatus } from './lan-listener.ts';
import type { TlsManager } from './tls-cert.ts';
import { TunnelSession } from './tunnel.ts';
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
export declare function callOpenWireStream(gateway: {
    readonly openWireStream?: (endpoint: string, payload: unknown, ...rest: unknown[]) => Promise<AsyncIterable<unknown>>;
}, endpoint: string, payload: unknown, signal: AbortSignal): Promise<AsyncIterable<unknown>>;
export interface MobileHostConfig {
    enabled: boolean;
    /** 配对码有效期（毫秒）。 */
    pairingTtlMs: number;
    /** 电脑端是否必须人工确认设备指纹。 */
    requireHostConfirm: boolean;
    /** 审计保留条数。 */
    auditLimit: number;
    /** 单条消息上限（字节）。 */
    maxMessageBytes: number;
    /** 空闲超时（毫秒），写入 ServerAuthOk 供客户端参考。 */
    idleTimeoutMs: number;
    /** 是否允许"此设备一律允许"（长期授权）。 */
    allowPersistentAuthorization: boolean;
    /**
     * 中继地址（如 `wss://relay.example.com/attach`）。
     *
     * 配置后电脑会**主动外拨**并保持若干条空闲连接 —— 这是"不需要任何入站端口、
     * CGNAT 后也能用"的关键：DSH 只绑 loopback，电脑通常在 NAT 后面，
     * 让手机连进来要端口映射；反过来让电脑拨出去就没有这个问题。
     */
    relayUrl?: string;
    /** `/attach` 的共享密钥。作为**首条消息**发送，不进 URL（避免落进访问日志）。 */
    relayToken?: string;
    /** 维持多少条空闲中继连接（默认 2：手机与平板各一条）。 */
    relayPoolSize?: number;
    /** 回源通道地址；省略时由 `relayUrl` 把 `/attach` 换成 `/attach-http` 推导。 */
    relayHttpUrl?: string;
    /**
     * 信任推导里**本机 hostname** 那半边是否放行（默认 true）。
     *
     * 只有 IP 字面量那半边是"不可能被 rebinding 借用"的（见 `lan-trust.ts` 的长注释）；
     * hostname 那半边是**精确匹配**本机名，够安全但不是零风险，因此留一个收紧的开关：
     * 关掉之后只剩回环 ∪ 静态列表 ∪ 本机 IP 字面量，代价是用机器名访问会 403。
     */
    trustLocalNames: boolean;
}
export declare const DEFAULT_CONFIG: MobileHostConfig;
export interface SigningKeyLike {
    readonly publicKey: string;
    /**
     * Node 的 KeyObject 私钥（仅存在于本进程内存）。
     *
     * 类型必须与协议包的 `RawKeyPair` 一致：`TunnelSession.hostSigningKey` 就是它，
     * 握手时用它给 ServerAuthOk 签名。写成 `unknown` 会在装配会话处直接编译失败。
     */
    readonly privateKey: KeyObject;
}
/** 宿主身份。 */
export interface HostIdentity {
    readonly hostId: string;
    readonly hostName: string;
    readonly signingKey: SigningKeyLike;
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
        readonly namespace: string;
        readonly method: string;
        readonly args: Readonly<Record<string, unknown>>;
        readonly signal?: AbortSignal;
    }): Promise<unknown>;
    stream(request: {
        readonly namespace: string;
        readonly method: string;
        readonly args: Readonly<Record<string, unknown>>;
        readonly signal?: AbortSignal;
    }): Promise<AsyncIterable<unknown>>;
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
    openWireStream?(endpoint: string, payload: unknown, ...rest: unknown[]): Promise<AsyncIterable<unknown>>;
}
/** 设备管理更新入参。 */
export interface DeviceUpdate {
    authorization?: 'once' | 'persistent' | 'revoked';
    capabilities?: Partial<DeviceCapabilities>;
    expiresAt?: string | null;
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
    readonly ok: boolean;
    readonly checkedAt: string;
    /**
     * ★ 第 50 轮（第二阶段取证通道）：最近几条宿主诊断（标签 + 摘要，已截断限量）。
     *   为什么需要它 ✗：选择卡的事件类型名只能靠真机取证 ✓，
     *   而诊断原先只进审计（`/mobile/audit` 是 **LOCAL_ONLY** ⇒ 手机读不到 ✗），
     *   桌面端又没有可看的日志 ✗ ⇒ 手机上**没有任何出口** ✓。
     *   这里复用**现成的**自检页 ✓（用户已经能从手机/局域网打开过它 ✓）。
     * ★ 纪律：诊断里**不许出现票据/密钥原文**（沿用 PairLink.redact 那条规矩）。
     */
    readonly diagnostics?: ReadonlyArray<{
        readonly tag: string;
        readonly detail: string;
    }>;
    /** 端侧队列积压（只读计数）：一直涨 ⇒ 手机没在取（见自检页里的说明）。 */
    readonly deviceQueue?: {
        readonly pending: number;
    };
    /**
     * ★ 第 74 轮：**这台电脑上的插件与 APK 是哪一版** ✓ ——
     *   专门用来消灭"验了旧的"这种白费：用户验之前先看一眼这里，
     *   就知道电脑端有没有更新到最新（而不是等验完发现不对再回头查 ✓）。
     *   · `boot`：注入脚本里的构建戳（形如 BUILD-… ✓，与手机上看到的一致 ✓）；
     *   · `apk`：插件旁边那份 APK 的字节数与修改时间 ✓（没有就如实说没有 ✓）。
     */
    readonly assets?: {
        readonly boot: string;
        readonly apk: {
            readonly bytes: number;
            readonly modifiedAt: string;
        } | null;
    };
    readonly host: {
        readonly hostId: string;
        readonly hostName: string;
        readonly hostFingerprint: string;
    };
    readonly tls: {
        /** 本部署有没有注入证书管理器（`cordis.ts` 注入；纯协议测试里没有）。 */
        readonly available: boolean;
        readonly ok: boolean;
        readonly directory: string;
        readonly createdCa: boolean;
        readonly createdServer: boolean;
        readonly resignedServer: boolean;
        readonly caFingerprint?: string;
        readonly serverFingerprint?: string;
        readonly serverSubjectAltName?: string;
        readonly caNotAfter?: string;
        readonly serverNotAfter?: string;
        /** 证书生成/读取失败的原因（**必须被说出来**，不许静默）。 */
        readonly error?: string;
    };
    readonly listen: {
        /** 本机 DSH 的监听端口（回源通道用它做环回请求）。 */
        readonly dshPort: number | null;
        readonly phoneBaseUrl: string | null;
        readonly endpoints: readonly string[];
    };
    readonly trust: {
        /** 网卡是否真的取到了；false ⇒ 只剩静态列表可用。 */
        readonly derived: boolean;
        readonly localAddresses: readonly string[];
        readonly hostnames: readonly string[];
        /** 本机 hostname 那半边是否放行（`MobileHostConfig.trustLocalNames`）。 */
        readonly localNamesEnabled: boolean;
        readonly staticHosts: readonly string[];
        /** 中继 authority（写进信任集合的那两条）。 */
        readonly relay: readonly string[];
    };
    readonly devices: {
        readonly count: number;
        readonly connected: number;
        readonly revoked: number;
    };
    readonly dshFrontend: DshFrontendProbe;
    /**
     * 局域网监听现状（C1）。
     *
     * 为什么值得单独一段：手机打不开时，问题可能落在**三层**里的任何一层——
     * 插件没起监听（`available:false` / `enabled:false`）、起了但端口被占
     * （`bindings[].code === 'EADDRINUSE'`，还带"可能上次的 lan-proxy 还活着"的提示）、
     * 或者监听正常但 `x-forwarded-for` 注入没生效（⇒ 手机被当成"人在电脑前"，
     * 这是**权限提升**且毫无症状，所以把它作为一项显式报出来）。
     */
    readonly listener: LanListenerStatus;
    /** 人话版的"缺什么"（自检输出直接可读；空数组 = 没发现问题）。 */
    readonly warnings: readonly string[];
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
    recordDiagnostic(tag: string, detail: string): void;
    /**
     * 按 6 位配对码取出"给手机用的配对载荷"（base64url(UTF-8 JSON)）。
     * 返回 undefined 表示码不存在、已用过或已过期。
     *
     * ★ 必须声明在**这个基接口**上：`MobileHost extends MobileHostService`，
     *   只在实现对象里多写一个成员会得到 "does not exist in type 'MobileHostService'" ✓
     *   （本项目已经栽过一次，注释就写在这一段附近）。
     */
    pairingPayloadForCode(code: string): string | undefined;
    /**
     * agent 工具（`phone_notify`）的注册结果。
     *
     * 为什么要暴露它：注册发生在**异步**的动态 import 之后，且失败时只打一行警告
     * （刻意如此——绝不能让插件加载失败）。于是"到底注册上没有"在重启后**无从确认**。
     * 把结果写在服务上，`/mobile/debug` 与生产自检就能回答这个问题。
     * `'pending'` 表示还没跑到（插件刚加载完的那一瞬间）。
     */
    agentToolStatus(): 'pending' | 'registered' | 'skipped' | 'failed';
    /** 由 cordis.ts 调用：记录 agent 工具的注册结果。 */
    setAgentToolStatus(status: 'registered' | 'skipped' | 'failed'): void;
    /**
     * 发起一次端侧请求（电脑 → 手机）。
     *
     * **唯一入口**：HTTP 路由 `/mobile/device/call` 与（将来的）agent 工具都走它，
     * 于是"发给谁、能力是否已启用"的判定只有一处，两边不会走偏。
     *
     * ★ 目标语义（第 90 轮定稿 ✓）：`deviceId` 不给 ⇒ **所有"可用且已启用该能力"的设备** ✓
     * （不再看"此刻谁连着本机"✗ —— 那会让"手机切到另一台电脑"时的提权通知丢掉 ✗）。
     */
    deviceCall(capability: string, text: string, deviceId?: string, 
    /** ★ 第二阶段缺口二：这条请求该落到哪个会话（可选；通知点击时用）。 */
    sessionId?: string): {
        ok: true;
        id: string;
    } | {
        ok: false;
        reason: string;
    };
    readonly store: DeviceStore;
    createPairing(): {
        ticket: PairingTicket;
        qrPayload: string;
        expiresAt: string;
    };
    /** 列出待确认的配对（供电脑端界面展示指纹并确认）。 */
    listPendingPairings(): {
        code: string;
        state: string;
        deviceId?: string;
        name?: string;
        fingerprint?: string;
        model?: string;
        platform?: string;
    }[];
    confirmPairing(code: string, deviceId: string, approve: boolean): boolean;
    listDevices(): DeviceRecord[];
    updateDevice(deviceId: string, update: DeviceUpdate): DeviceRecord | undefined;
    revokeDevice(deviceId: string): boolean;
    /**
     * **彻底删除**一条设备记录（不是撤销）。
     *
     * 与 `revokeDevice` 分开：撤销保留记录（审计可追溯、界面能显示"已撤销"），
     * 删除是把条目从 `devices.json` 里抹掉 —— 这正是过去只能"改文件 + 立刻重启"才能做到的事
     * （`DeviceStore` 只在构造时 `load()`、之后整表覆盖写回，手改文件会被下一次 `touch()` 写回）。
     * 删除同样**立刻断开**该设备的在线隧道，否则"删了还能用"直到它自己断线。
     */
    removeDevice(deviceId: string): boolean;
    /** 批量删除所有**已撤销**的记录；返回删除条数。 */
    removeRevokedDevices(): number;
    listAudit(options?: {
        deviceId?: string;
        since?: string;
        limit?: number;
    }): AuditEntry[];
    connectedCount(): number;
    manifest(): MobileManifest;
    connectedSession(deviceId: string): TunnelSession | undefined;
    /**
     * 自检（`GET /mobile/admin/selfcheck`）的**纯数据**部分。
     * 与 HTTP 路由分开，是为了让"现在到底好不好"这件事可以被单测直接断言。
     */
    selfcheck(): MobileSelfcheck;
}
/** 完整宿主对象（服务面 + HTTP/upgrade 处理）。 */
export interface MobileHost extends MobileHostService {
    /**
     * 手机端应用外壳（index.html + ETag）。
     *
     * 存在的原因见实现处的长注释：DSH 的 `/` 有 token/cookie 鉴权，手机拿不到，
     * 于是配对成功后仍进不去界面。返回 undefined 表示本部署未注入前端静态服务。
     */
    getAppShell(): {
        html: string;
        etag: string;
    } | undefined;
    handleUpgrade(req: IncomingMessage, socket: Duplex): void;
    /** 返回 true 表示本插件已处理该请求。 */
    handleHttp(req: IncomingMessage, res: ServerResponse): boolean;
    /** 停止中继外拨（进程退出/插件卸载时调用）。 */
    stopRelayDialer(): void;
    /** 停止中继回源通道。 */
    stopRelayHttpBackhaul(): void;
    /** 停止 Codex 宿主桥（懒启动过才需要）。 */
    stopCodexBridge(): void;
}
/**
 * 创建宿主插件主体。
 * 与 Cordis 解耦：返回纯对象，由 cordis.ts 把它挂到 ctx 与路由上，便于无 DSH 环境下完整测试。
 */
export declare function createMobileHost(options: {
    readonly config?: Partial<MobileHostConfig>;
    readonly store: DeviceStore;
    readonly identity: HostIdentity;
    readonly gateway: RemoteGateway;
    /** 可用连接地址（用于二维码 payload 与 manifest）。 */
    readonly endpoints: () => string[];
    /** 本机 DSH 的监听端口（回源通道要用它做环回请求）。 */
    readonly selfPort?: number;
    /** 允许授予的最大能力位；未列出的位一律拒绝（能力最小化）。默认与 DEFAULT_CAPABILITIES 相同。 */
    readonly capabilityCeiling?: DeviceCapabilities;
    /**
     * 注入脚本（`/mobile/boot.js`）。
     * 由客户端插件包提供内容，宿主只负责以正确的 Content-Type 与完整性哈希提供它。
     * 省略时不提供该路由（适配器仍可只做协议层自测）。
     */
    readonly bootScript?: () => {
        readonly source: string;
        readonly sha256: string;
    };
    /**
     * 本部署额外服务的 authority（与 DSH 的 `trustedHosts` 同义）。
     *
     * 用途：本插件注册的 `/mobile/*` 路由**不受** DSH 的 `/api` 信任栅栏保护
     * （那道栅栏只覆盖 Connection 自己认领的路径），因此必须自己校验 Host/Origin。
     * 局域网访问时把手机实际使用的 authority 传进来（例如 `10.34.221.181:3081`），
     * 否则插件会以 403 拒绝——这是刻意的：宁可报错并给出 `--trusted-host` 提示，
     * 也不要静默接受任意 Host（那等于打开 DNS rebinding 与跨站请求的门）。
     */
    readonly trustedHosts?: readonly string[];
    /**
     * **手机**应当访问的基地址（如 `https://10.34.221.181:3443`）。
     *
     * 为什么与 `publicBaseUrl` 分开：手机侧必须走 HTTPS（普通 HTTP 页面不是安全上下文，
     * `crypto.subtle` 不存在，配对与隧道都无法工作），而电脑侧仍走明文 loopback。
     * 两者的 scheme 与端口都不同，用一个字段表达不了。
     *
     * 由适配器从配置透传；配对页据此显示手机地址，避免页面自己猜端口。
     */
    readonly phoneBaseUrl?: string;
    /**
     * 手机配对成功后应该落到的**入口路径**（默认 `/mobile/app` = DSH 外壳）。
     *
     * 独立服务（standalone.ts）把它设成 `/mobile/codex` —— 那里没有 DSH 前端，
     * 手机必须直接落到 Codex 页面；否则配对完成后会打开一个 503 的外壳路径。
     */
    readonly entryPath?: string;
    /**
     * 是否把入口页面**同时**发在 `/mobile/app` 上（默认 false = 只有 DSH 插件会用那条路径）。
     *
     * ★ 为什么独立服务需要它（2026-09-30 用户实测）：原版配对页的二维码是
     *   `dshmobile://pair?d=…`，**APK 扫完固定落到 `<基地址>/mobile/app?pair=…`**
     *   （见 native/android 的 `PairLink.APP_PATH` ✓）；配对页自己的"手机侧"提交后
     *   也是跳到 `/mobile/app?pair=…` ✓。独立服务没有 DSH 外壳 ⇒ 那条路原本 404 ⇒
     *   整个"原版配对体验"都用不了 ✗。开了这个别名之后，两条路发的是**同一个页面** ✓。
     */
    readonly appShellAlias?: boolean;
    /**
     * DSH 前端 index.html 的绝对路径（由适配器提供，宿主不猜路径）。
     * 用于给手机端提供应用外壳。
     */
    readonly distIndex?: () => string | undefined;
    /**
     * DSH 的 index 渲染器（`ctx.webServer.renderIndex`）。
     * 手机端外壳必须走同一个渲染管线，否则会漏掉插件注入（包括本插件的 boot.js）。
     */
    readonly renderIndex?: (html: string) => string;
    readonly clientBundleVersion?: string;
    readonly dshVersion?: string;
    /**
     * 网卡取值函数（默认 `os.networkInterfaces`）。
     *
     * 只为**可测**而存在：信任判据必须"每次请求按当时网卡现算"，而这件事只有在
     * 能把网卡换掉的前提下才验得了（单测里塞一个可变函数，先后两次调用得到不同结论）。
     */
    readonly networkInterfaces?: NetworkInterfacesReader;
    /** 本机 hostname 取值函数（默认 `os.hostname`）；同样只为可测。 */
    readonly hostname?: () => string;
    /**
     * 自签证书管理器（由 `cordis.ts` 建好注入）。
     *
     * 省略时：manifest 里的 `tls` 标成不可用、自检标成 `available: false`、`/mobile/trust.crt`
     * 退回"读不到就说清楚"的 404——**绝不让缺证书变成一句静默**。
     */
    readonly tls?: TlsManager;
    /**
     * 局域网监听器（由 `cordis.ts` 按 `listener.enabled` 建好注入；C1）。
     *
     * 省略时自检的 `listener` 段是"本部署未注入"（`available:false`），
     * 且**不算失败**——老部署的手机入口由外置 `lan-proxy.mjs` 提供，那是最常见形态。
     */
    readonly listener?: {
        status(): LanListenerStatus;
    };
}): MobileHost;
/** 规范化后的 authority。 */
export interface ParsedAuthority {
    readonly hostname: string;
    /** 显式写出的端口；未写则为空串。 */
    readonly port: string;
    /** hostname 或 hostname:port，用于同源比较。 */
    readonly host: string;
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
export declare function parseAuthority(value: string | undefined): ParsedAuthority | undefined;
/** Host 是否匹配某个 trustedHosts 条目（带端口精确匹配，不带端口匹配任意端口）。 */
export declare function matchesTrusted(authority: ParsedAuthority, trustedHosts: readonly string[]): boolean;
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
export declare function isRefusedRelayBackhaulPath(path: string): boolean;
/** 判断请求是否来自本机（loopback）。设备管理端点依赖此判断。 */
export declare function isLoopbackRequest(req: IncomingMessage): boolean;
//# sourceMappingURL=index.d.ts.map