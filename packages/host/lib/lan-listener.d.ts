/**
 * 局域网监听（明文 3081 / TLS 3443）—— 从 `scripts/lan-proxy.mjs` 搬进插件（C1）。
 *
 * ## 为什么必须是"裸 TCP + TLS 终结"的转发器，而不是第二个 HTTP 服务器
 *
 * `https.createServer((req, res) => mobileHost.handleHttp(req, res))` 是**不够**的：
 * 手机外壳挂在 `/mobile/app` 并带 `<base href="/">`，页面随后要请求 `/assets/*`、
 * `/plugins/*`（DSH 的静态管线）以及 `/api/*`（DSH 自己的路由）。这些**都不在**
 * `mobileHost.handleHttp` 里，只挂插件 handler 会让手机"页面能开、样式与插件全 404"。
 * ⇒ 监听器必须是**面向 DSH 全量管线的转发**（与 `lan-proxy.mjs` 同语义），
 * 而不是第二个只认 `/mobile` 的 HTTP 服务器。照搬裸 TCP + TLS 终结的另一个好处：
 * WebSocket 升级天然透传（`/mobile/ws` 与 DSH 自己的 WS 都不需要额外代码）。
 *
 * ## ★★ 最危险的一处：`x-forwarded-for` 注入（权限提升）
 *
 * `isLoopbackRequest` 只看"**socket 是回环** + 头里第一段是回环"。而插件自己起的
 * 监听 socket 的对端**恒为回环**（监听器与 DSH 在同一台机器上）⇒ 若不注入该头，
 * **所有局域网手机都会被判成"人在电脑前"**，于是配对码生成 / 配对确认 / 设备管理 /
 * 端侧控制（`LOCAL_ONLY` 全家）在局域网可达 —— 这是权限提升，不是"界面显示错了"。
 * 所以下面 `injectForwardedFor` 与"攒齐请求头再注入"的两段注释是从 `lan-proxy.mjs`
 * **一字不改**搬过来的（那是两次真 bug 的记录），并有**变异可验**的测试
 * （`packages/host/test/lan-listener.test.ts`：去掉注入 ⇒ 局域网来源拿不到 `LOCAL_ONLY`）。
 *
 * ## 默认关闭
 *
 * `listener.enabled` 默认 `false` ⇒ **老部署行为一字不变**（手机入口仍由外置
 * `scripts/lan-proxy.mjs` 提供）。监听失败只警告、不抛错：手机入口不可用 ≠ DSH 挂掉。
 */
import type { TlsPaths } from './tls-cert.ts';
/** 默认明文监听（与 `lan-proxy.mjs` 的 `--listen` 默认值一致）。 */
export declare const DEFAULT_PLAIN_LISTEN = "0.0.0.0:3081";
/** 默认 TLS 监听（与 `lan-proxy.mjs` 的 `--tls-listen` 惯例一致）。 */
export declare const DEFAULT_TLS_LISTEN = "0.0.0.0:3443";
/**
 * ★ `x-forwarded-for` 注入是否开启。
 *
 * 恒为 `true`（转发器不会、也不该有"不注入"的模式）；自检把它报出来，
 * 是为了让"注入被静默关掉"这件事在 `/mobile/admin/selfcheck` 里一眼可见。
 */
export declare const FORWARDED_FOR_INJECTION = true;
/** host:port。 */
export interface Endpoint {
    readonly host: string;
    readonly port: number;
}
/** `parseEndpoint` 的结果（**不 `process.exit`**：插件里失败只降级，绝不把 DSH 带下去）。 */
export type ParseEndpointResult = {
    readonly ok: true;
    readonly endpoint: Endpoint;
} | {
    readonly ok: false;
    readonly error: string;
};
/**
 * 解析 `host:port`（**不抛错、不退出**）。
 *
 * 与 `scripts/lan-proxy.mjs` 的 `splitHostPort` 同一套规则，但把 `process.exit(1)`
 * 换成"返回原因"——插件里的非法配置只应让这一条监听不可用（自检里说清楚）。
 */
export declare function parseEndpoint(value: string, label: string): ParseEndpointResult;
/**
 * 把客户端真实地址注入 `x-forwarded-for`（仅处理本次连接的第一个 HTTP 请求头）。
 *
 * 为什么必须做：TCP 转发后，DSH 看到的对端地址永远是 `127.0.0.1`，
 * 于是它无法区分"电脑本机的浏览器"与"局域网里的手机"——后果是手机被当成 loopback，
 * 拿到电脑版界面、并且能调用只应本机可用的管理端点。
 *
 * 宿主侧只在请求确实来自 loopback 时才信任这个头，因此不影响伪造防护。
 */
export declare function injectForwardedFor(head: Buffer, remoteAddress: string | undefined): Buffer;
/**
 * 转发逻辑真正用到的 socket 面。
 *
 * 刻意只声明用得到的成员：真 `net.Socket` / `tls.TLSSocket` 结构上满足它，
 * 单测则可以用**假 socket** 驱动整条状态机（**不去起真端口**）。
 */
export interface LanSocket {
    readonly remoteAddress?: string | undefined;
    on(event: 'data', listener: (chunk: Buffer) => void): unknown;
    on(event: 'error', listener: (error: Error) => void): unknown;
    on(event: 'close', listener: () => void): unknown;
    on(event: 'connect', listener: () => void): unknown;
    write(chunk: Buffer): unknown;
    pipe(destination: any): unknown;
    destroy(): unknown;
}
/** 一条连接的转发器（明文与 TLS 监听共用）。 */
export interface ConnectionForwarder {
    /** 处理一条客户端连接。 */
    handle(socket: LanSocket): void;
    /** 已接受并进入转发的连接数（把"没人连"与"连了但转发失败"分开）。 */
    count(): number;
}
/** 建一个转发器。`connect` 只为可测而可注入（默认 `node:net` 的 `connect`）。 */
export declare function createConnectionForwarder(options: {
    readonly target: Endpoint;
    readonly connect?: (port: number, host: string) => LanSocket;
    readonly onUpstreamError?: (error: Error) => void;
}): ConnectionForwarder;
/** 监听器只需要这几个成员（真 `net.Server` / `tls.Server` 结构上满足）。 */
export interface ListenerServer {
    on(event: 'error', listener: (error: NodeJS.ErrnoException) => void): unknown;
    on(event: 'close', listener: () => void): unknown;
    listen(options: {
        port: number;
        host: string;
        ipv6Only?: boolean;
    }, callback: () => void): unknown;
    close(callback?: (error?: Error) => void): unknown;
    setSecureContext?(context: {
        cert: Buffer;
        key: Buffer;
    }): unknown;
}
/** 日志出口（默认 console；单测注入假 logger 断言"失败被说出来"）。 */
export interface ListenerLogger {
    info?(message: string): void;
    warn?(message: string): void;
}
/** 一条监听绑定在自检里的样子。 */
export interface LanListenerBinding {
    readonly kind: 'plain' | 'tls';
    /** 配置里写的原值，例如 `0.0.0.0:3081`（排障时最想看到的就是它）。 */
    readonly address: string;
    readonly host: string;
    readonly port: number;
    /** true = IPv6 伴随监听（`::`，`ipv6Only`），失败只降级不影响局域网。 */
    readonly ipv6: boolean;
    readonly listening: boolean;
    readonly error?: string;
    readonly code?: string;
    /** 人话版处置建议（端口冲突时点明"可能上一次的 lan-proxy 还活着"）。 */
    readonly hint?: string;
}
/** 监听器现状（写进 `/mobile/admin/selfcheck` 的 `listener` 段）。 */
export interface LanListenerStatus {
    /** 本部署有没有注入监听器（false ⇒ 未启用；自检用来区分"没开"与"开了但坏了"）。 */
    readonly available: boolean;
    /** 配置是否启用（默认 false ⇒ 老部署行为不变）。 */
    readonly enabled: boolean;
    /** 启用时：所有非 IPv6 绑定都在听。未启用恒为 true（"没开"不是失败）。 */
    readonly ok: boolean;
    readonly target: string;
    /** ★ `x-forwarded-for` 注入是否开启（关掉 = 局域网手机被当成"人在电脑前"）。 */
    readonly forwardedForInjection: boolean;
    /** TLS 材料是否已加载进监听器。 */
    readonly tlsLoaded: boolean;
    /** 证书热更新次数与最近一次时间。 */
    readonly tlsReloads: number;
    readonly tlsLastReloadAt?: string;
    /** 已转发连接数。 */
    readonly connections: number;
    readonly bindings: readonly LanListenerBinding[];
    /** 人话版问题清单（自检直接拼接；空数组 = 没发现问题）。 */
    readonly warnings: readonly string[];
}
/** 未注入监听器时的状态（纯逻辑测试 / 老部署都会走到这里）。 */
export declare function unavailableLanListenerStatus(): LanListenerStatus;
/** 监听器对外面。 */
export interface LanListener {
    /** 按配置起监听。**失败只记录、不抛错**（手机入口不可用 ≠ DSH 挂掉）。 */
    start(): LanListenerStatus;
    /** 读现状（取现成值，不产生副作用）。 */
    status(): LanListenerStatus;
    /**
     * 证书热更新：叶子文件 **mtime/size 变了**才 `setSecureContext(...)`。
     *
     * 为什么必须热更新：`ensureTlsMaterial` 会在地址变化时**用同一张 CA 重签叶子**，
     * 若监听器仍拿着旧的 cert/key，手机上就会因为 SAN 不匹配而报证书错——
     * 而"重签之后必须重启 DSH"与 A/B 两轮的"不用重启"精神相悖。
     */
    refreshTls(): {
        reloaded: boolean;
        error?: string;
    };
    /** 关停全部监听器（挂进 `cordis.ts` 现有那个 `ctx.effect` 的清理函数）。 */
    dispose(): void;
}
/** 建一个局域网监听器（默认关闭：`enabled` 必须显式为 true 才起监听）。 */
export declare function createLanListener(options: {
    readonly enabled: boolean;
    readonly plain?: string;
    readonly tls?: string;
    /** 转发目标（DSH 自己监听的 loopback 地址）。 */
    readonly target: Endpoint;
    /** 证书/私钥文件（`tls-cert.ts` 的 `tlsPaths()`）；省略 ⇒ 不起 TLS 监听。 */
    readonly tlsPaths?: TlsPaths;
    readonly logger?: ListenerLogger;
    /** 只为可测：server 工厂（默认 `node:net` / `node:tls`）。 */
    readonly createTcpServer?: (handler: (socket: LanSocket) => void) => ListenerServer;
    readonly createTlsServer?: (context: {
        cert: Buffer;
        key: Buffer;
    }, handler: (socket: LanSocket) => void) => ListenerServer;
    readonly connect?: (port: number, host: string) => LanSocket;
}): LanListener;
//# sourceMappingURL=lan-listener.d.ts.map