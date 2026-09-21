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
import { type DeviceCapabilities, type DeviceRecord, type MobileManifest, type PairingTicket } from '@dsh-mobile/protocol';
import { DeviceStore, type AuditEntry } from './devices.ts';
import { TunnelSession } from './tunnel.ts';
/** 插件配置。 */
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
}
export declare const DEFAULT_CONFIG: MobileHostConfig;
/**
 * 宿主身份签名密钥的结构面。
 * 只声明本插件真正用到的字段，避免绑死具体实现（Node KeyObject 结构上满足它）。
 */
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
    openWireStream?(endpoint: string, payload: unknown, signal: AbortSignal): Promise<AsyncIterable<unknown>>;
}
/** 设备管理更新入参。 */
export interface DeviceUpdate {
    authorization?: 'once' | 'persistent' | 'revoked';
    capabilities?: Partial<DeviceCapabilities>;
    expiresAt?: string | null;
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
     */
    deviceCall(capability: string, text: string, deviceId?: string): {
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
    listAudit(options?: {
        deviceId?: string;
        since?: string;
        limit?: number;
    }): AuditEntry[];
    connectedCount(): number;
    manifest(): MobileManifest;
    connectedSession(deviceId: string): TunnelSession | undefined;
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
/** 判断请求是否来自本机（loopback）。设备管理端点依赖此判断。 */
export declare function isLoopbackRequest(req: IncomingMessage): boolean;
//# sourceMappingURL=index.d.ts.map