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
export const PROTOCOL_VERSION = 1;
/** 隧道 WebSocket 路径（精确路径，由 ctx.webServer.registerUpgrade 注册）。 */
export const TUNNEL_PATH = '/mobile/ws';
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
export const MAX_FRAME_BYTES = 32 * 1024 * 1024;
/** 单条消息明文上限（留出帧头与认证标签的余量）。 */
export const MAX_PAYLOAD_BYTES = 28 * 1024 * 1024;
/** 帧头长度：type(1) + flags(1) + payloadLen(4) + counter(8) = 14 字节。 */
export const FRAME_HEADER_BYTES = 14;
/** AES-GCM 认证标签截断长度。 */
export const AUTH_TAG_BYTES = 16;
/** 握手阶段使用的 AES-GCM 全标签长度（握手帧不允许截断）。 */
export const HANDSHAKE_TAG_BYTES = 16;
/** 第一帧的计数器值（0 保留给"握手完成"确认帧）。 */
export const FIRST_COUNTER = 1;
/** 心跳间隔（毫秒）。宿主在空闲时按此间隔发送 ping。 */
export const HEARTBEAT_INTERVAL_MS = 20_000;
/** 连续未收到 pong 多少次判定链路失效。 */
export const HEARTBEAT_MISS_LIMIT = 3;
/**
 * 帧类型。0x0* 为握手与链路控制（明文或握手密钥保护），0x1* 为业务数据（会话密钥保护）。
 */
/**
 * 帧类型。0x0* 为握手与链路控制（明文或握手密钥保护），0x2* 为业务数据（会话密钥保护）。
 *
 * 刻意使用 `as const` 对象而非 TS `enum`：Node 的类型擦除模式（--experimental-strip-types）
 * 不支持 enum，而本项目坚持"源码可直接运行"，不把构建链变成硬依赖。
 */
export const FrameType = {
    // ── 握手（0x01-0x0F）─────────────────────────────────────────────
    /** 客户端 → 宿主：发起握手，携带设备标识、临时公钥、可选配对票据。（明文） */
    ClientHello: 0x01,
    /** 宿主 → 客户端：握手应答，携带宿主标识、临时公钥、对 transcript 的签名。（K_hs 保护） */
    ServerHello: 0x02,
    /** 客户端 → 宿主：会话密钥确认 + 设备签名证明。（K_hs 保护） */
    ClientAuth: 0x03,
    /** 宿主 → 客户端：认证通过，附带授权结果与协商参数。（K_s2c 保护） */
    ServerAuthOk: 0x04,
    // ── 链路控制（0x10-0x1F）─────────────────────────────────────────
    Ping: 0x10,
    Pong: 0x11,
    /** 链路级错误：认证失败、版本不符、被撤销、限流等。收到即应关闭。 */
    LinkError: 0x12,
    /** 宿主主动撤销本设备：连接必须立即终止且不得自动重连。 */
    Revoked: 0x13,
    /** 请求重新认证（主密钥轮换后）。 */
    ReauthRequired: 0x14,
    // ── 业务数据（0x20-0x3F）─────────────────────────────────────────
    /** 一元 RPC：请求。 */
    RpcRequest: 0x20,
    /** 一元 RPC：响应。 */
    RpcResponse: 0x21,
    /** 逻辑流：打开。 */
    StreamOpen: 0x22,
    /** 逻辑流：一个产出项。 */
    StreamItem: 0x23,
    /** 逻辑流：宿主侧主动结束。 */
    StreamEnd: 0x24,
    /** 逻辑流：失败。 */
    StreamError: 0x25,
    /** 逻辑流：客户端取消。 */
    StreamCancel: 0x26,
    // ── 附件分块上传（0x40-0x4F）─────────────────────────────────────
    /** 上传：开始，携带文件名、MIME、总长度、目标会话。 */
    UploadStart: 0x40,
    /** 上传：数据块。 */
    UploadChunk: 0x41,
    /** 上传：结束，宿主返回回执。 */
    UploadEnd: 0x42,
    /** 上传：客户端取消。 */
    UploadCancel: 0x43,
};
/** 帧标志位。 */
export const FrameFlags = {
    None: 0x00,
    /** 该帧的 payload 是 UTF-8 JSON 文本（否则为原始二进制）。 */
    Json: 0x01,
    /** 发送方要求接收方对该帧回一个确认（用于上传流控）。 */
    Ack: 0x02,
    /** 该帧是响应/结束帧（流控与统计用）。 */
    Final: 0x04,
};
/** 流标识：低 31 位为编号，最高位区分发起方（0=客户端发起，1=宿主发起）。 */
export const STREAM_INITIATOR_HOST = 0x8000_0000;
export const STREAM_ID_MASK = 0x7fff_ffff;
/** 保留的流编号：一元 RPC 与链路控制使用。 */
export const CONTROL_STREAM_ID = 0;
/** 稳定错误码。客户端必须按码分支，不得匹配 message 文本。 */
export const ErrorCode = {
    /** 协议版本不兼容。 */
    ProtocolVersion: 'mobile/protocol-version',
    /** 握手消息格式非法或字段缺失。 */
    HandshakeMalformed: 'mobile/handshake-malformed',
    /** 签名验证失败（transcript 被篡改或密钥不符）。 */
    HandshakeSignature: 'mobile/handshake-signature',
    /** 会话密钥确认失败（MAC 不符）。 */
    HandshakeConfirm: 'mobile/handshake-confirm',
    /** 设备未配对。 */
    DeviceUnknown: 'mobile/device-unknown',
    /** 设备已被撤销。 */
    DeviceRevoked: 'mobile/device-revoked',
    /** 设备的长期授权已过期，需要重新配对。 */
    DeviceExpired: 'mobile/device-expired',
    /** 配对票据无效或已过期。 */
    PairingTicketInvalid: 'mobile/pairing-ticket-invalid',
    /** 配对仍在等待电脑端人工确认。 */
    PairingPending: 'mobile/pairing-pending',
    /** 配对被电脑端拒绝。 */
    PairingRejected: 'mobile/pairing-rejected',
    /** 该设备缺少执行此操作所需的能力位。 */
    CapabilityDenied: 'mobile/capability-denied',
    /** 帧计数器重放或超出滑动窗口。 */
    ReplayDetected: 'mobile/replay-detected',
    /** 解密失败（密文被篡改）。 */
    DecryptFailed: 'mobile/decrypt-failed',
    /** 请求体超过限制。 */
    PayloadTooLarge: 'mobile/payload-too-large',
    /** 并发流或未确认窗口超限。 */
    Backpressure: 'mobile/backpressure',
    /** 宿主内部错误。 */
    Internal: 'mobile/internal',
};
/** 新建配对设备的默认能力位：能对话、能看文件，不能写、不能执行。 */
export const DEFAULT_CAPABILITIES = {
    fsRead: true,
    fsWrite: false,
    fsShell: false,
    phoneFs: false,
    phoneControl: false,
};
/** 全部能力位开启（仅用于电脑端本机自用或调试）。 */
export const FULL_CAPABILITIES = {
    fsRead: true,
    fsWrite: true,
    fsShell: true,
    phoneFs: true,
    phoneControl: true,
};
/** 生成稳定错误对象的辅助函数（避免各端手写不一致）。 */
export function wireError(code, message, details) {
    // `details` **必须始终存在**（哪怕是空对象）：DSH 的客户端协议校验要求
    // `error.details` 是 record，缺字段会抛 `invalid server-response failure`，
    // 而这句报错完全看不出是"少了 details"。宁可多一个空对象。
    return { code, message, details: details ?? {} };
}
//# sourceMappingURL=wire.js.map