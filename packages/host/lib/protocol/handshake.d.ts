/**
 * 握手状态机：一次性密码本式的严格线性流程，客户端与宿主各自持有半边。
 *
 * 流程（C=客户端/手机，S=宿主/电脑）：
 *
 *   C → S  ClientHello   {protocolVersion, deviceId, ephemeralPublicKey, clientNonce, pairingTicket?}
 *          ↓ 双方各自 ECDH(clientEph, serverEph)
 *          ↓ 双方各自推导 K_hs = HKDF(ss, transcriptHash(CH‖SH), 'hs')
 *   S → C  ServerHello   [K_hs 保护] {hostId, ephemeralPublicKey, serverNonce, hostSigningKey,
 *                                     hostFingerprint, signature=ECDSA-P256(hostKey, transcriptHash)}
 *          ↓ 客户端验签（必须通过，否则中止）
 *          ↓ 双方各自推导 K_c2s / K_s2c / K_confirmC / K_confirmS
 *   C → S  ClientAuth    [K_c2s 保护] {signature=ECDSA-P256(deviceKey, transcriptHash),
 *                                     confirm=MAC(K_confirmC, transcriptHash), clientNonceBase}
 *          ↓ 宿主验签 + 验 MAC，失败即拒绝
 *   S → C  ServerAuthOk  [K_s2c 保护] {deviceId, sessionId, capabilities, authorization,
 *                                     idleTimeoutMs, serverNonceBase,
 *                                     confirm=MAC(K_confirmS, transcriptHash)}
 *          ↓ 客户端验 MAC，握手完成
 *
 * transcript = 规范化编码的 [协议版本, 客户端 nonce, 宿主 nonce, 客户端临时公钥,
 *             宿主临时公钥, 设备标识, 宿主标识]；两侧对同一字节序列签名与验签。
 *
 * 安全性质：
 *  - 前向保密：临时密钥每次连接重新生成，长期密钥只用于签名。
 *  - 双向认证：客户端验宿主签名（防中间人/防伪造宿主），宿主验设备签名（防伪造设备）。
 *  - 密钥确认：双向 MAC 证明双方确实派生出同一会话密钥。
 */
import { type RawKeyPair, type SessionKeys } from './crypto.ts';
import { type ClientAuthPayload, type ClientHelloPayload, type AuthorizationMode, type DeviceCapabilities, type ServerAuthOkPayload, type ServerHelloPayload } from './wire.ts';
/** 握手每一步的产出。 */
export type HandshakeOutcome = 
/** 需要向对端发送一帧（帧类型由调用方按角色决定）。 */
{
    readonly kind: 'send';
    readonly payload: unknown;
} | {
    readonly kind: 'done';
    readonly session: EstablishedSession;
} | {
    readonly kind: 'fail';
    readonly code: string;
    readonly message: string;
};
/** 握手成功后移交会话层的信息。 */
export interface EstablishedSession {
    /** 稳定会话标识（transcript 哈希前 16 字节 hex）。 */
    readonly sessionId: string;
    readonly deviceId: string;
    readonly hostId: string;
    /** 设备公钥指纹（宿主侧为设备指纹，客户端侧为宿主指纹）。 */
    readonly peerFingerprint: string;
    readonly keys: SessionKeys;
    /** 客户端 → 宿主方向的 nonce 前缀。 */
    readonly clientNonceBase: Buffer;
    /** 宿主 → 客户端方向的 nonce 前缀。 */
    readonly serverNonceBase: Buffer;
    /** 宿主授予的能力位与授权模式（客户端侧由 ServerAuthOk 带回）。 */
    readonly capabilities: DeviceCapabilities;
    /**
     * 生效的授权模式。运行时不应出现 'revoked'：宿主在解析设备凭据时就会拒绝已撤销设备，
     * 客户端也只接受 'once' | 'persistent'（收到 'revoked' 视为宿主配置错误）。
     */
    readonly authorization: AuthorizationMode;
}
/** 宿主侧握手需要的设备凭据（已配对设备的公钥，或首次配对的临时信任）。 */
export interface HostDeviceCredentials {
    readonly deviceId: string;
    readonly devicePublicKey: string;
    readonly deviceSigningKey: string;
    readonly fingerprint: string;
    readonly capabilities: DeviceCapabilities;
    /**
     * 仅 'once' | 'persistent'：调用方（设备注册表）必须已经把 'revoked' 与过期的设备挡在外面。
     * 把这一约束放在类型上，是为了让"撤销设备"在握手入口就失败，而不是走到授权判断才失败。
     */
    readonly authorization: AuthorizationMode;
}
/** 宿主侧握手启动参数。 */
export interface HostHandshakeOptions {
    readonly hostId: string;
    readonly hostSigningKey: RawKeyPair;
    /** 依据 ClientHello 解析设备凭据；返回 undefined 表示未知设备。 */
    readonly resolveDevice: (hello: ClientHelloPayload) => HostDeviceCredentials | undefined | Promise<HostDeviceCredentials | undefined>;
    /** 允许客户端请求的能力与已授予能力的交集策略。 */
    readonly grantCapabilities?: (requested: Partial<DeviceCapabilities> | undefined, credentials: HostDeviceCredentials) => DeviceCapabilities;
    readonly idleTimeoutMs?: number;
}
/** 客户端侧握手启动参数。 */
export interface ClientHandshakeOptions {
    readonly deviceId: string;
    /** 设备 X25519 密钥（ECDH）。 */
    readonly deviceKey: RawKeyPair;
    /** 设备 ECDSA P-256 签名密钥。 */
    readonly deviceSigningKey: RawKeyPair;
    /** 首次配对时携带的票据。 */
    readonly pairingTicket?: string;
    readonly requestedCapabilities?: Partial<DeviceCapabilities>;
    /** 已知的宿主身份公钥（TOFU 固定）；首次配对时省略。 */
    readonly pinnedHostSigningKey?: string;
}
/** 客户端握手状态机。每一步只接受唯一合法的下一帧。 */
export declare class ClientHandshake {
    private readonly options;
    private readonly ephemeral;
    private readonly clientNonce;
    private readonly clientNonceBase;
    private hello?;
    private serverHello?;
    private sharedSecret?;
    private keys?;
    private transcript?;
    private state;
    private failure?;
    constructor(options: ClientHandshakeOptions);
    /** 生成第一帧（ClientHello，明文）。 */
    start(): HandshakeOutcome;
    /** 持有本次握手的临时密钥对（握手帧加解密用）。 */
    get ephemeralKeys(): RawKeyPair;
    /**
     * 握手阶段的 AEAD 密钥（用于解开 ServerHello）。
     *
     * 关键设计约束：K_hs 必须在 ServerHello 的内容可知之前就能算出来，因此它**只**依赖
     * 临时 ECDH 共享密钥，不把服务端临时公钥/服务端 nonce/宿主标识纳入 transcript
     * （否则形成"要解开 ServerHello 先要知道 ServerHello 内容"的循环依赖）。
     *
     * 代价与补偿：K_hs 本身不绑定双方身份。这不需要额外补偿——会话密钥
     * （K_c2s/K_s2c/K_confirm*）以**完整** transcript（含两端的 nonce、临时公钥、
     * 设备标识、宿主标识）为 HKDF salt，且双向确认 MAC 覆盖同一 transcript。
     * 攻击者若篡改 ServerHello 中的临时公钥、nonce 或宿主标识，会话密钥将两端不一致，
     * 在 ClientAuth 的确认 MAC 处必然失败。因此"解开 ServerHello"只保证机密性，
     * 完整性由后续确认步骤保证。
     */
    /**
     * 记录服务端临时公钥（ServerHello 的**明文可读部分**）。
     *
     * 为什么必须有这一步：K_hs 由临时 ECDH 共享密钥派生，而共享密钥需要服务端临时公钥。
     * ServerHello 只对"内容"做机密性保护，其临时公钥字段必须在解密前就可读，
     * 否则形成循环依赖。因此协议规定：ServerHello 帧的载荷按
     * `{ephemeralPublicKey, sealed}` 形式承载——临时公钥明文前置，其余字段用 K_hs 加密。
     * 本条规则是跨端强约束，Dart 端必须一致实现（见 docs/protocol.md）。
     */
    noteServerEphemeralKey(ephemeralPublicKey: string): void;
    handshakeKey(): Buffer;
    /** 会话密钥（在 acceptServerHello 成功后可用）。 */
    get sessionKeys(): SessionKeys | undefined;
    /** 处理 ServerHello（已由调用方解密）。返回下一帧（ClientAuth）。 */
    acceptServerHello(payload: ServerHelloPayload): HandshakeOutcome;
    /** 处理 ServerAuthOk（已解密）。验 MAC 后握手完成。 */
    acceptServerAuthOk(payload: ServerAuthOkPayload): HandshakeOutcome;
    private fail;
    /** 失败原因（若有）。 */
    get error(): {
        code: string;
        message: string;
    } | undefined;
}
/** 宿主侧握手状态机。 */
export declare class HostHandshake {
    private readonly options;
    private readonly ephemeral;
    private readonly serverNonce;
    private readonly serverNonceBase;
    private hello?;
    private credentials?;
    private sharedSecret?;
    private keys?;
    private transcript?;
    private state;
    private failure?;
    constructor(options: HostHandshakeOptions);
    /** 处理 ClientHello（明文）。返回 ServerHello 载荷（调用方需用 handshakeKey 加密封装）。 */
    acceptClientHello(payload: ClientHelloPayload): Promise<HandshakeOutcome>;
    private granted?;
    /** 握手阶段的 AEAD 密钥（保护 ServerHello）。派生规则与客户端完全一致。 */
    handshakeKey(): Buffer;
    /** 处理 ClientAuth（已解密）。验签 + 验 MAC，返回 ServerAuthOk 载荷。 */
    acceptClientAuth(payload: ClientAuthPayload): HandshakeOutcome;
    /** 客户端方向 nonce 前缀（收到 ClientAuth 后可用）。 */
    private clientNonceBase?;
    /** 排障用：宿主实际用于验签的设备指纹（未收到 ClientHello 时为空）。 */
    get storedFingerprint(): string | undefined;
    /**
     * 已认证但尚未 complete 的会话视图。
     * 用途：宿主需要用会话密钥（serverToClient）保护 ServerAuthOk 这一帧。
     */
    pending(): EstablishedSession;
    /** 握手完成：移交会话。调用方在成功发送 ServerAuthOk 之后调用。 */
    complete(): EstablishedSession;
    /** 会话视图构造：仅在认证完成之后可调用。 */
    private buildSession;
    private fail;
    get error(): {
        code: string;
        message: string;
    } | undefined;
}
/** 握手帧的固定 nonce 前缀（导出以便测试与 Dart 端对齐）。 */
export declare const HANDSHAKE_NONCE_BASE: Buffer<ArrayBuffer>;
//# sourceMappingURL=handshake.d.ts.map