/**
 * dsh-mobile 线协议：帧格式、消息类型、错误码与协议版本。
 *
 * 这是三端（Node 宿主插件 / 浏览器客户端插件 / Flutter 外壳）共享的唯一权威定义。
 * 任何改动都必须先进本文件，并由 integrator 批准（见 docs/protocol.md 的变更流程）。
 *
 * 传输：WebSocket 二进制帧，路径 /mobile/ws。
 * 加密：X25519 ECDH → HKDF-SHA256 → AES-256-GCM，逐帧封装，方向分离。
 */
/** 当前协议版本。不兼容改动必须递增，并在 docs/protocol.md 记录迁移说明。 */
export declare const PROTOCOL_VERSION = 1;
/** 隧道 WebSocket 路径（精确路径，由 ctx.webServer.registerUpgrade 注册）。 */
export declare const TUNNEL_PATH = "/mobile/ws";
/**
 * 单帧上限 32 MiB（含头与认证标签）。
 *
 * 为什么从 1 MiB 抬高：DSH 的 `session/follow` 开场快照会把整段历史放在**一个**流项里，
 * 实测一个 54 轮的会话就有 1.47 MB，于是手机端长会话直接报
 * `payload … exceeds MAX_FRAME_BYTES`，历史打不开——功能性的硬阻塞。
 * DSH 自己的 Web 客户端走普通 HTTP，没有这个限制，所以隧道不该成为更紧的那道约束。
 *
 * ★ 这仍是**权宜之计**：真正的解法是分片（把大消息拆成多帧再重组），
 *   这样上限只受内存约束、且单帧延迟可控。当前实现留了有限但足够大的护栏，
 *   既容纳真实会话，又不让一个畸形长度字段引发荒谬的分配。
 */
export declare const MAX_FRAME_BYTES: number;
/** 单条消息明文上限（留出帧头与认证标签的余量）。 */
export declare const MAX_PAYLOAD_BYTES: number;
/** 帧头长度：type(1) + flags(1) + payloadLen(4) + counter(8) = 14 字节。 */
export declare const FRAME_HEADER_BYTES = 14;
/** AES-GCM 认证标签截断长度。 */
export declare const AUTH_TAG_BYTES = 16;
/** 握手阶段使用的 AES-GCM 全标签长度（握手帧不允许截断）。 */
export declare const HANDSHAKE_TAG_BYTES = 16;
/** 第一帧的计数器值（0 保留给"握手完成"确认帧）。 */
export declare const FIRST_COUNTER = 1;
/** 心跳间隔（毫秒）。宿主在空闲时按此间隔发送 ping。 */
export declare const HEARTBEAT_INTERVAL_MS = 20000;
/** 连续未收到 pong 多少次判定链路失效。 */
export declare const HEARTBEAT_MISS_LIMIT = 3;
/**
 * 帧类型。0x0* 为握手与链路控制（明文或握手密钥保护），0x1* 为业务数据（会话密钥保护）。
 */
/**
 * 帧类型。0x0* 为握手与链路控制（明文或握手密钥保护），0x2* 为业务数据（会话密钥保护）。
 *
 * 刻意使用 `as const` 对象而非 TS `enum`：Node 的类型擦除模式（--experimental-strip-types）
 * 不支持 enum，而本项目坚持"源码可直接运行"，不把构建链变成硬依赖。
 */
export declare const FrameType: {
    /** 客户端 → 宿主：发起握手，携带设备标识、临时公钥、可选配对票据。（明文） */
    readonly ClientHello: 1;
    /** 宿主 → 客户端：握手应答，携带宿主标识、临时公钥、对 transcript 的签名。（K_hs 保护） */
    readonly ServerHello: 2;
    /** 客户端 → 宿主：会话密钥确认 + 设备签名证明。（K_hs 保护） */
    readonly ClientAuth: 3;
    /** 宿主 → 客户端：认证通过，附带授权结果与协商参数。（K_s2c 保护） */
    readonly ServerAuthOk: 4;
    readonly Ping: 16;
    readonly Pong: 17;
    /** 链路级错误：认证失败、版本不符、被撤销、限流等。收到即应关闭。 */
    readonly LinkError: 18;
    /** 宿主主动撤销本设备：连接必须立即终止且不得自动重连。 */
    readonly Revoked: 19;
    /** 请求重新认证（主密钥轮换后）。 */
    readonly ReauthRequired: 20;
    /** 一元 RPC：请求。 */
    readonly RpcRequest: 32;
    /** 一元 RPC：响应。 */
    readonly RpcResponse: 33;
    /** 逻辑流：打开。 */
    readonly StreamOpen: 34;
    /** 逻辑流：一个产出项。 */
    readonly StreamItem: 35;
    /** 逻辑流：宿主侧主动结束。 */
    readonly StreamEnd: 36;
    /** 逻辑流：失败。 */
    readonly StreamError: 37;
    /** 逻辑流：客户端取消。 */
    readonly StreamCancel: 38;
    /** 上传：开始，携带文件名、MIME、总长度、目标会话。 */
    readonly UploadStart: 64;
    /** 上传：数据块。 */
    readonly UploadChunk: 65;
    /** 上传：结束，宿主返回回执。 */
    readonly UploadEnd: 66;
    /** 上传：客户端取消。 */
    readonly UploadCancel: 67;
};
/** 帧类型取值联合。 */
export type FrameType = (typeof FrameType)[keyof typeof FrameType];
/** 帧标志位。 */
export declare const FrameFlags: {
    readonly None: 0;
    /** 该帧的 payload 是 UTF-8 JSON 文本（否则为原始二进制）。 */
    readonly Json: 1;
    /** 发送方要求接收方对该帧回一个确认（用于上传流控）。 */
    readonly Ack: 2;
    /** 该帧是响应/结束帧（流控与统计用）。 */
    readonly Final: 4;
};
/**
 * 帧标志。刻意是 `number` 而不是字面量联合：标志是**位或组合**（如 Json | Final），
 * 字面量联合会把合法的组合排除在类型之外。
 */
export type FrameFlags = number;
/** 流标识：低 31 位为编号，最高位区分发起方（0=客户端发起，1=宿主发起）。 */
export declare const STREAM_INITIATOR_HOST = 2147483648;
export declare const STREAM_ID_MASK = 2147483647;
/** 保留的流编号：一元 RPC 与链路控制使用。 */
export declare const CONTROL_STREAM_ID = 0;
/** 稳定错误码。客户端必须按码分支，不得匹配 message 文本。 */
export declare const ErrorCode: {
    /** 协议版本不兼容。 */
    readonly ProtocolVersion: "mobile/protocol-version";
    /** 握手消息格式非法或字段缺失。 */
    readonly HandshakeMalformed: "mobile/handshake-malformed";
    /** 签名验证失败（transcript 被篡改或密钥不符）。 */
    readonly HandshakeSignature: "mobile/handshake-signature";
    /** 会话密钥确认失败（MAC 不符）。 */
    readonly HandshakeConfirm: "mobile/handshake-confirm";
    /** 设备未配对。 */
    readonly DeviceUnknown: "mobile/device-unknown";
    /** 设备已被撤销。 */
    readonly DeviceRevoked: "mobile/device-revoked";
    /** 设备的长期授权已过期，需要重新配对。 */
    readonly DeviceExpired: "mobile/device-expired";
    /** 配对票据无效或已过期。 */
    readonly PairingTicketInvalid: "mobile/pairing-ticket-invalid";
    /** 配对仍在等待电脑端人工确认。 */
    readonly PairingPending: "mobile/pairing-pending";
    /** 配对被电脑端拒绝。 */
    readonly PairingRejected: "mobile/pairing-rejected";
    /** 该设备缺少执行此操作所需的能力位。 */
    readonly CapabilityDenied: "mobile/capability-denied";
    /** 帧计数器重放或超出滑动窗口。 */
    readonly ReplayDetected: "mobile/replay-detected";
    /** 解密失败（密文被篡改）。 */
    readonly DecryptFailed: "mobile/decrypt-failed";
    /** 请求体超过限制。 */
    readonly PayloadTooLarge: "mobile/payload-too-large";
    /** 并发流或未确认窗口超限。 */
    readonly Backpressure: "mobile/backpressure";
    /** 宿主内部错误。 */
    readonly Internal: "mobile/internal";
};
export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];
/** 设备能力位。默认新建设备只有 Chat 与 FsRead。 */
export interface DeviceCapabilities {
    /** 只读浏览 workspace 与文件。 */
    fsRead: boolean;
    /** 在 workspace 根内写入文件。 */
    fsWrite: boolean;
    /** 在电脑上执行 shell 命令（高危，默认关闭）。 */
    fsShell: boolean;
    /** 浏览手机侧目录（M3，需手机当场放行）。 */
    phoneFs: boolean;
    /** 由电脑 agent 控制手机（M5，需无障碍 + 生物识别）。 */
    phoneControl: boolean;
}
/** 新建配对设备的默认能力位：能对话、能看文件，不能写、不能执行。 */
export declare const DEFAULT_CAPABILITIES: DeviceCapabilities;
/** 全部能力位开启（仅用于电脑端本机自用或调试）。 */
export declare const FULL_CAPABILITIES: DeviceCapabilities;
/** 授权模式。 */
export type AuthorizationMode = 
/** 仅本次连接有效，断开即失效。 */
'once'
/** 长期有效，直到显式撤销（"此设备一律允许"）。 */
 | 'persistent'
/** 已撤销。 */
 | 'revoked';
/** 设备记录（宿主持久化）。 */
export interface DeviceRecord {
    /** 设备标识，由手机生成（UUID v4），全局唯一。 */
    readonly deviceId: string;
    /** 设备密钥协商公钥（X25519，base64url，32 字节），用于 ECDH。 */
    readonly devicePublicKey: string;
    /** 设备签名公钥（ECDSA P-256 未压缩点，base64url，65 字节），用于证明持有设备私钥。 */
    readonly deviceSigningKey: string;
    /** 公钥指纹（X25519 公钥 SHA-256 的前 16 字节 hex），用于人工比对。 */
    readonly fingerprint: string;
    /** 用户可改的显示名。 */
    readonly name: string;
    /** 手机上报的机型信息，仅用于显示。 */
    readonly model?: string;
    readonly platform?: string;
    /** 配对完成时间（ISO 8601）。 */
    readonly pairedAt: string;
    /** 最近一次成功连接时间（ISO 8601）。 */
    readonly lastSeenAt?: string;
    readonly authorization: AuthorizationMode;
    readonly capabilities: DeviceCapabilities;
    /**
     * ★ 2026-10-05：**端侧能力**（电脑 → 手机：`show` / `notify` / `clipboard` /
     * `vibrate` / `open`，见 `device-calls.ts` 的 `DEVICE_CAPABILITIES`）的**逐项允许记录**——
     * 只放手机点过「允许」的那些 ✓，没记录过的一律仍按「不允许」处理 ✓。
     *
     * ## 为什么必须落盘
     *
     * 授权原先只活在宿主**内存**里（`DeviceCallQueue.enabled`）⇒ DSH 一重启就清空 ✗。
     * 手机侧虽然会拿自己的 localStorage 跟宿主对账、缺什么补报什么 ✓，
     * 但那要求「手机**此刻连着这台电脑**」✗ —— 用户实测的那个窄窗口恰恰是
     * **宿主刚重启 + 手机切到了另一台电脑**：补报发给了另一台 ✓，本机永远是空的 ✗
     * ⇒ 提权推送被判 `not enabled` ⇒ **静默丢掉** ✗。
     *
     * ★ 与 `capabilities` 是**两套不同的东西**，别合并 ✗：`capabilities` 管的是
     *   「手机能对电脑做什么」（`fsRead` / `fsShell`…），本字段管的是
     *   「电脑能指挥这台手机做什么」 —— 授权方向相反，判据各自独立 ✓。
     *
     * ★ 语义上**默认全禁**：缺省（老 `devices.json` 里没有这个键）⇒ 空 ⇒ 什么都不允许 ✓。
     */
    readonly deviceCallGrants?: readonly string[];
    /** 授权到期时间（ISO 8601），缺省为永不过期。 */
    readonly expiresAt?: string;
}
/** 握手第一帧的载荷。 */
export interface ClientHelloPayload {
    protocolVersion: number;
    deviceId: string;
    /** 本次连接的临时 X25519 公钥（base64url，32 字节）。 */
    ephemeralPublicKey: string;
    /** 首次配对时携带的票据；已配对设备省略。 */
    pairingTicket?: string;
    /** 客户端随机数（base64url，32 字节），参与 transcript。 */
    clientNonce: string;
    /** 客户端希望请求的能力位；宿主可按策略下调。 */
    requestedCapabilities?: Partial<DeviceCapabilities>;
}
/** 握手第二帧的载荷。 */
export interface ServerHelloPayload {
    protocolVersion: number;
    hostId: string;
    ephemeralPublicKey: string;
    serverNonce: string;
    /**
     * 宿主 → 客户端方向的 nonce 前缀（base64url，4 字节）。
     * 由宿主在握手开始时随机生成并在此下发，使客户端能在收到 ServerAuthOk 之前
     * 就建立接收窗口——ServerAuthOk 本身就用这个前缀加密。
     * 与 ServerAuthOk 中的同名字段必须一致，客户端应校验（不一致即拒绝）。
     */
    serverNonceBase: string;
    /** 宿主长期身份**签名**公钥（ECDSA P-256 未压缩点，base64url，65 字节），用于 TOFU 固定。 */
    hostSigningKey: string;
    /** 宿主标识公钥指纹。 */
    hostFingerprint: string;
    /** 对 transcript 的 ECDSA P-256 签名（raw r‖s，base64url，64 字节）。 */
    signature: string;
    /** 配对票据的状态（首次配对时宿主在此告知是否仍需人工确认）。 */
    pairingState?: 'claimed' | 'pending' | 'approved' | 'rejected';
}
/** 握手第三帧的载荷（用会话密钥加密）。 */
export interface ClientAuthPayload {
    /** 对 transcript 的 ECDSA P-256 签名（raw r‖s，base64url，64 字节），证明持有设备签名私钥。 */
    signature: string;
    /** 会话确认 MAC：HMAC-SHA256(confirmClient, transcriptHash) 前 16 字节，base64url。 */
    confirm: string;
    /** 客户端 → 宿主方向的 nonce 前缀（base64url，4 字节），由客户端随机生成。 */
    clientNonceBase: string;
}
/** 握手第四帧的载荷（用会话密钥加密）。 */
export interface ServerAuthOkPayload {
    deviceId: string;
    /** 会话标识：transcript 哈希前 16 字节的 hex，两端可独立推导并互相校验。 */
    sessionId: string;
    /** 宿主最终授予的能力位（可能低于请求值）。 */
    capabilities: DeviceCapabilities;
    authorization: AuthorizationMode;
    /** 宿主配置的会话空闲超时（毫秒）。 */
    idleTimeoutMs: number;
    /** 宿主 → 客户端方向的 nonce 前缀（base64url，4 字节），由宿主随机生成。 */
    serverNonceBase: string;
    /** 会话确认 MAC：HMAC-SHA256(confirmServer, transcriptHash) 前 16 字节，base64url。 */
    confirm: string;
}
/**
 * 一元 RPC 请求帧的载荷。
 *
 * **与 DSH 的 `client-request` 信封逐字段一致**（含 `type` 与 `method`），
 * 这样同一份信封既能经我们的隧道传输，也能被 DSH 既有的连接层直接理解；
 * 两端不需要各自做一次字段改名——改名正是"endpoint 静默变 undefined"那类错误
 * 的温床（曾按 `endpoint` 解析 DSH 用 `method` 承载的字段，导致 endpoint 丢失）。
 */
export interface RpcRequestPayload {
    /** 固定为 'client-request'，与 DSH 一致。 */
    type: 'client-request';
    /** 关联标识，由客户端生成，响应必须原样回传。 */
    rpcId: string;
    /** DSH 的 Typert endpoint，如 "session/create"（DSH 侧字段名为 method）。 */
    method: string;
    /** 业务入参，形如 `{args: {...}}`（与 DSH gateway 的 remoteRequest 要求一致）。 */
    payload: unknown;
}
export interface RpcResponsePayload {
    rpcId: string;
    ok: boolean;
    /** ok 为 true 时的业务结果。 */
    value?: unknown;
    /** ok 为 false 时的错误对象。 */
    error?: WireError;
}
export interface StreamOpenPayload {
    /** 客户端分配的逻辑流编号（不含发起方位）。 */
    streamId: number;
    endpoint: string;
    payload: unknown;
}
export interface StreamFramePayload {
    streamId: number;
    value?: unknown;
    error?: WireError;
}
/** 可跨线的错误对象。 */
export interface WireError {
    readonly code: string;
    readonly message: string;
    readonly details?: Record<string, unknown>;
}
export interface UploadStartPayload {
    uploadId: string;
    sessionId: string;
    name: string;
    mimeType: string;
    totalBytes: number;
}
export interface UploadChunkPayload {
    uploadId: string;
    offset: number;
    /** base64url 编码的分块字节。 */
    data: string;
}
export interface UploadEndPayload {
    uploadId: string;
    sha256: string;
}
export interface UploadReceiptPayload {
    uploadId: string;
    /** DSH 的暂存凭证，用于后续 prompt。 */
    receiptId: string;
    bytes: number;
}
/** 配对票据（二维码内嵌内容）。 */
export interface PairingTicket {
    /** 票据版本，固定 1。 */
    v: 1;
    /** 宿主标识。 */
    hostId: string;
    /** 宿主长期身份公钥指纹（base64url 或 hex），用于带外校验。 */
    hostFingerprint: string;
    /** 一次性配对码（6 位数字，供人工核对）。 */
    code: string;
    /** 票据密钥（base64url，32 字节），claim 时作为凭证。 */
    ticket: string;
    /** 候选连接地址列表（局域网 IP、IPv6、主机名）。 */
    endpoints: string[];
    /** 协议版本，便于提前拒绝不兼容客户端。 */
    protocolVersion: number;
    /** 过期时间（ISO 8601）。 */
    expiresAt: string;
    /**
     * 宿主 TLS 证书（本机 CA）的 SHA-256 指纹，冒号十六进制（与
     * `X509Certificate.fingerprint256` / `tls.status().caFingerprint` 同一种写法）。
     *
     * ## 为什么它必须**可选**（`?`）
     *
     * 这是给原生外壳做 **TOFU**（首次连接时确认宿主 CA）用的**带外**凭据：
     * 二维码/配对链接是"用户在电脑屏幕上看到、手机扫到"的通道，中间人改不了它。
     * 壳在未验证的 TLS 连接上取回宿主的 CA 后，用这里的指纹比对 ⇒ 不用人眼读十六进制。
     *
     * 省略它是**合法**的，而且必须继续合法：
     *   - **旧宿主**（本字段引入之前构建的插件）根本不写它 ⇒ 旧 APK 与旧宿主照旧工作；
     *   - **旧手机**（没有 TOFU 分支的 APK）忽略未知字段 ⇒ 一个字节都不受影响；
     *   - 壳拿不到它时**不降级成"盲信第一次"**，而是退回"把指纹显示给用户、要用户明确确认"。
     * 所以它是**加法**：谁都不因为它而必须改（见方案 `16` §4.2 第 3 条）。
     */
    caFingerprint?: string;
}
/** 配对通道的 claim 请求。 */
export interface PairClaimRequest {
    ticket: string;
    deviceId: string;
    /** X25519 密钥协商公钥（base64url，32 字节）。 */
    devicePublicKey: string;
    /** ECDSA P-256 签名公钥（未压缩点，base64url，65 字节）。 */
    deviceSigningKey: string;
    fingerprint: string;
    name: string;
    model?: string;
    platform?: string;
}
/** 配对通道的 claim 响应。 */
export interface PairClaimResponse {
    state: 'pending' | 'approved' | 'rejected' | 'expired';
    /** 电脑端确认后下发的设备令牌；state 为 approved 时存在。 */
    deviceToken?: string;
}
/** 配对状态查询响应。 */
export interface PairStatusResponse {
    state: 'pending' | 'approved' | 'rejected' | 'expired';
    deviceToken?: string;
    /** 宿主已授予的能力位。 */
    capabilities?: DeviceCapabilities;
}
/** 前端/外壳能力协商清单（GET /mobile/manifest）。 */
export interface MobileManifest {
    /**
     * 手机应当访问的基地址（如 `https://10.34.221.181:3443`）。
     *
     * 手机必须走 HTTPS：普通 HTTP 页面不是安全上下文，浏览器不提供 `crypto.subtle`，
     * 于是配对与加密隧道都无法工作。配对页据此显示手机地址，不去猜端口。
     */
    phoneBaseUrl?: string;
    protocolVersion: number;
    hostId: string;
    hostFingerprint: string;
    hostName: string;
    /**
     * 本机**机器名**（形如 `Mac-mini-2024.local`）—— ★ **可选** ✓。
     *
     * 与 `hostName` 不是一回事：`hostName` 是 DSH 里那台宿主的**显示名**
     * （用户可改 ✓），而这条是 `os.hostname()` 报出来的机器名 ✓
     * （手机端"按槽认源、给宿主补名字"时用它 ✓）。
     *
     * ★ **拿不到就不写这个键** ✗（绝不写 `undefined` 占位 ✓）：
     *   旧客户端读到多余键会直接忽略 ✓，但多一个 `undefined` 会让
     *   "没有" 与 "有但为空" 分不开 ✗ —— 那正是"静默失败"的温床 ✓。
     */
    machineName?: string;
    /** shim 脚本地址与完整性哈希，外壳可校验。 */
    shimUrl: string;
    shimSha256: string;
    /** 客户端插件 bundle 版本，便于提示"请更新"。 */
    clientBundleVersion: string;
    /** 宿主端 DSH 版本，仅用于展示与排障。 */
    dshVersion: string;
    /** 宿主声明的能力位（如是否允许公网、是否启用临时 key）。 */
    features: {
        pairing: boolean;
        ephemeralKey: boolean;
        internet: boolean;
        phoneControl: boolean;
    };
}
/** 生成稳定错误对象的辅助函数（避免各端手写不一致）。 */
export declare function wireError(code: ErrorCodeValue | string, message: string, details?: Record<string, unknown>): WireError;
//# sourceMappingURL=wire.d.ts.map