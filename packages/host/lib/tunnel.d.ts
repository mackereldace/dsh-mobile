/**
 * 隧道会话：一次 WebSocket 连接上的完整状态机。
 *
 * 帧的阶段与密钥使用（**这是最容易实现错的地方，Dart 端必须逐条对齐**）：
 *
 *   阶段 1（明文）     ClientHello     明文 JSON，counter=1（占位，不参与 AEAD）
 *   阶段 2（K_hs）     ClientAuth      K_hs 保护，nonceBase=00000001，counter=2
 *   阶段 2'（K_s2c）   ServerHello     ServerHello 的 sh 帧：nonceBase=00000001，counter=1
 *   阶段 2'（K_s2c）   ServerAuthOk    K_s2c 保护，nonceBase=serverNonceBase，counter=1
 *   阶段 3（会话密钥） 之后所有帧       各自方向的 nonceBase，counter 从 1 开始单调递增
 *
 * 注意 ServerAuthOk 用**会话密钥**（serverNonceBase、counter=1）：
 * 此时两端的会话密钥已派生完成，客户端也已经用 serverNonceBase 建好接收窗口。
 * 这样"会话密钥的第一个使用"就是 ServerAuthOk，客户端一旦解开它即证明密钥一致。
 */
import { type ClientHelloPayload, type WireError } from './protocol/index.js';
import { type EstablishedSession, type HostDeviceCredentials } from './protocol/index.js';
import type { RawKeyPair } from './protocol/index.js';
/** 会话在生命周期中对外暴露的状态。 */
export type TunnelState = 'awaiting-hello' | 'handshaking' | 'established' | 'closed';
/** 隧道向宿主上层暴露的回调。 */
export interface TunnelDelegate {
    /** 按 ClientHello 解析设备凭据；未配对返回 undefined。 */
    resolveDevice(hello: ClientHelloPayload): HostDeviceCredentials | undefined | Promise<HostDeviceCredentials | undefined>;
    /** 执行一次一元 RPC。 */
    invoke(request: {
        readonly endpoint: string;
        readonly payload: unknown;
    }, signal: AbortSignal): Promise<unknown>;
    /** 打开一条逻辑流。 */
    openStream(request: {
        readonly endpoint: string;
        readonly payload: unknown;
    }, signal: AbortSignal): AsyncIterable<unknown>;
    /** 会话建立后回调（用于审计与"已连接设备"展示）。 */
    onEstablished?(session: EstablishedSession): void;
    /** 会话关闭回调（无论正常还是异常）。 */
    onClosed?(session: EstablishedSession | undefined, reason: string): void;
}
/** 上行发送器：把一帧字节写到 WebSocket。返回 false 表示通道已关闭。 */
export type FrameSink = (bytes: Uint8Array) => boolean | Promise<boolean>;
/**
 * 单连接隧道会话。
 *
 * 用法：`new TunnelSession(delegate, sink)` → `receive(bytes)` → `close(reason)`。
 * 本类是纯状态机，不接触 WebSocket API，便于单测（直接把两条会话对接即可）。
 */
export declare class TunnelSession {
    private readonly delegate;
    private readonly sink;
    private state;
    private handshake;
    private session;
    private outCounter;
    private readonly inReplay;
    private readonly streams;
    private readonly mux;
    private pendingQueue;
    private closeReason;
    /** 建立后用于发送方向的会话视图（握手刚完成、尚未 complete 时也要能发 ServerAuthOk）。 */
    private sendKeys;
    private debugLabel;
    constructor(delegate: TunnelDelegate, sink: FrameSink, debugLabel?: string);
    /** 当前状态。 */
    get currentState(): TunnelState;
    /** 已建立的会话（未完成握手时为 undefined）。 */
    get established(): EstablishedSession | undefined;
    /**
     * 接收一帧原始字节。
     *
     * 内部用 Promise 串行化：握手与数据帧的处理都含 await，若不串行化，
     * 同一连接上的后续帧会在前帧未处理完时并发进入，导致计数器错乱。
     */
    receive(bytes: Uint8Array): void;
    /** 关闭会话：中止全部上游流，回调断开。 */
    close(reason: string): void;
    /** 关闭原因（测试与审计用）。 */
    get closedBy(): string | undefined;
    /**
     * 链路级失败的结构化记录（测试、审计与排障用）。
     * 保留 code 而不只是 message，便于排障时区分"版本不符"与"未配对"这类不同原因。
     */
    get failure(): {
        code: string;
        message: string;
    } | undefined;
    private failureInfo;
    private handleFrame;
    private acceptHello;
    private acceptAuth;
    /**
     * 用会话密钥封装一帧。
     * @param advance - 是否递增发出计数器（ServerAuthOk 需要手动控制占位，故传 false）。
     */
    private sealSessionFrame;
    /** 处理已解密的数据帧。 */
    private dispatch;
    /**
     * 一元 RPC：把网关结果包成 **DSH 自己的 `server-response` 信封**。
     *
     * ## 为什么形状必须与 DSH 逐字段一致（真实故障）
     *
     * 客户端 `boot.js` 是**把整个响应原样**交给 DSH 客户端的（它替换的是传输层，
     * 不是协议层），因此客户端期望看到的就是 DSH 自己的信封：
     *
     * ```
     * { type: 'server-response', rpcId, result: { ok: true, value } }
     * { type: 'server-response', rpcId, result: { ok: false, error: { code, message, details } } }
     * ```
     *
     * 早期这里发的是 `{ rpcId, ok, value }`——**少一层 `result`、少 `type`**。
     * 后果是 DSH 抛 `connection: invalid server-response envelope`，
     * 而这些调用恰恰是界面启动必需的那几个（插件清单、凭据、预设），
     * 于是表现为"界面能打开但面板报错/功能不可用"，且报错文案完全指向不了传输层。
     */
    private handleRpc;
    private startStream;
    private pumpStream;
    private sendError;
    /** 用会话密钥发送一帧（计数器自动递增）。 */
    private sendFrame;
    /** 链路级失败：发 LinkError 后关闭连接。 */
    private fail;
    /** 宿主身份（由宿主插件在构造后注入）。 */
    hostId: string;
    hostSigningKey: RawKeyPair;
}
/** 把任意异常转成可跨线的错误对象。 */
export declare function toWire(error: unknown): WireError;
//# sourceMappingURL=tunnel.d.ts.map