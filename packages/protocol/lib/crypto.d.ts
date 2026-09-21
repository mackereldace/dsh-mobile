/**
 * 密码学原语：密钥生成、指纹、HKDF 派生、AEAD 逐帧加解密、签名与重放窗口。
 *
 * 全部基于 Node 内置 crypto，不引入第三方依赖。Primitive 的跨端对应关系见 docs/protocol.md：
 *   X25519 ECDH      → WebCrypto / Dart: package:cryptography / 平台通道(Keystore)
 *   ECDSA P-256 签名 → WebCrypto / Dart: package:cryptography / 平台通道(Keystore)
 *   HKDF-SHA256      → 三端原生
 *   AES-256-GCM      → 三端原生
 *
 * 为什么签名用 **ECDSA P-256 而不是 Ed25519**（这是一个会决定可行性的选择）：
 * 浏览器 WebCrypto 至今不支持 Ed25519（Chrome 未实现，Safari 17+/Firefox 130+ 才支持），
 * 而"手机浏览器作为客户端"必须能验证宿主身份签名——否则中间人可以冒充电脑。
 * ECDSA/ECDH P-256 在 WebCrypto、Dart `package:cryptography`、Android Keystore 三处都是原生能力，
 * 因此成为唯一能同时满足"三端一致 + 浏览器可用 + 可硬件保护"的选择。
 *
 * 线格式约定：公钥用 **未压缩点 raw 65 字节**（0x04‖X32‖Y32），签名用 **raw 64 字节**（r32‖s32）。
 * 刻意不用 DER：WebCrypto 原生输出即 raw，Dart 也可直接产出 raw，避免两端 DER 编解码差异。
 */
import { type KeyObject } from 'node:crypto';
import { FrameFlags, FrameType } from './wire.ts';
/** 32 字节密钥/公钥的 base64url 编解码。 */
export declare function toB64(bytes: Uint8Array): string;
export declare function fromB64(text: string): Buffer;
/** 把 32 字节原始 X25519 公钥包成 Node KeyObject。 */
export declare function x25519PublicKeyFromRaw(raw: Uint8Array): KeyObject;
/**
 * 把 65 字节未压缩 P-256 公钥（0x04‖X32‖Y32）包成 Node KeyObject。
 * P-256 的 SPKI DER 前缀固定 26 字节，因此可以直接拼接。
 */
export declare function p256PublicKeyFromRaw(raw: Uint8Array): KeyObject;
/** 长期身份密钥对的线格式表示。 */
export interface RawKeyPair {
    /** 32 字节原始公钥，base64url。 */
    readonly publicKey: string;
    /** 对应的 Node KeyObject 私钥（仅存在于本进程内存）。 */
    readonly privateKey: KeyObject;
}
/** 生成 X25519 长期密钥对（设备或宿主身份；用于 ECDH）。 */
export declare function generateX25519KeyPair(): RawKeyPair;
/** 生成 P-256 长期密钥对（宿主身份签名与设备签名，见文件头说明）。 */
export declare function generateP256KeyPair(): RawKeyPair;
/** 公钥指纹：SHA-256 原始公钥的前 16 字节，大写 hex 分组显示用（线格式为连续 hex）。 */
export declare function fingerprint(rawPublicKeyB64: string): string;
/** 把指纹格式化成人类可比对的 4 组形式：`A1B2-C3D4-E5F6-0718-293A-4B5C-6D7E-8F90`。 */
export declare function formatFingerprint(hex: string): string;
/** X25519 ECDH：返回 32 字节共享密钥。 */
export declare function ecdh(privateKey: KeyObject, peerPublicKeyB64: string): Buffer;
/**
 * ECDSA P-256 + SHA-256 签名，输出 **raw 64 字节（r‖s）**。
 *
 * 为什么必须转成 raw：Node 的 `crypto.sign` 对 EC 密钥默认输出 DER 编码（约 70~72 字节），
 * 而 WebCrypto 与 Dart 都使用 raw r‖s。两种格式混用会导致"签名永远验不过"，
 * 且极难排查（长度不同这一线索很容易被忽略）。因此这里统一转 raw。
 */
export declare function signRaw(privateKey: KeyObject, message: Uint8Array): Buffer;
/** ECDSA P-256 验签。接受 raw 64 字节签名；任何异常都视为验签失败，不向上抛。 */
export declare function verifyRaw(publicKeyB64: string, message: Uint8Array, signature: Uint8Array): boolean;
/** DER `SEQUENCE{INTEGER r, INTEGER s}` → raw 64 字节（r‖s，各左补零到 32）。 */
export declare function derToRawSignature(der: Uint8Array): Buffer;
/** raw 64 字节（r‖s） → DER。 */
export declare function rawToDerSignature(raw: Uint8Array): Buffer;
/** 域分离标签。不同用途的派生必须使用不同标签，防止密钥复用。 */
export declare const HkdfLabel: {
    readonly ClientToServer: "dsh-mobile/v1/c2s";
    readonly ServerToClient: "dsh-mobile/v1/s2c";
    readonly ConfirmClient: "dsh-mobile/v1/confirm-client";
    readonly ConfirmServer: "dsh-mobile/v1/confirm-server";
    readonly UploadChunk: "dsh-mobile/v1/upload";
    /** 握手阶段（保护 ServerHello）。 */
    readonly Handshake: "dsh-mobile/v1/hs";
};
/** HKDF-SHA256 派生 32 字节密钥。 */
export declare function deriveKey(ikm: Uint8Array, salt: Uint8Array, label: string): Buffer;
/** 会话密钥材料：两个方向的 AEAD 密钥与两个方向的确认 MAC 密钥。 */
export interface SessionKeys {
    readonly clientToServer: Buffer;
    readonly serverToClient: Buffer;
    readonly confirmClient: Buffer;
    readonly confirmServer: Buffer;
}
/**
 * 从共享密钥与 transcript 派生全部会话密钥。
 * @param sharedSecret - X25519 ECDH 输出。
 * @param transcriptHash - 握手 transcript 的 SHA-256（32 字节），作为 HKDF salt 绑定上下文。
 */
export declare function deriveSessionKeys(sharedSecret: Uint8Array, transcriptHash: Uint8Array): SessionKeys;
/** 会话确认 MAC：HMAC-SHA256(key, transcriptHash) 前 16 字节。 */
export declare function confirmMac(key: Uint8Array, transcriptHash: Uint8Array): Buffer;
/** 常量时间比较，用于 MAC/签名等敏感比较。 */
export declare function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean;
/**
 * 握手 transcript 的规范化编码：每个字段以 4 字节大端长度前缀拼接。
 * 目的：让"字段边界"进入签名范围，避免拼接歧义攻击。
 */
export declare function encodeTranscript(fields: readonly (string | Uint8Array)[]): Buffer;
/** 计算 transcript 哈希（SHA-256）。 */
export declare function transcriptHash(fields: readonly (string | Uint8Array)[]): Buffer;
/** 已封装的帧。 */
export interface EncodedFrame {
    readonly type: FrameType;
    readonly flags: FrameFlags;
    readonly counter: bigint;
    /** 完整字节：头 + 密文 + 标签。 */
    readonly bytes: Buffer;
}
/**
 * 封装一帧。
 * 头部 14 字节：type(1) flags(1) payloadLen(4) counter(8)，均为大端。
 * 明文为 payload；counter 以 8 字节大端前缀参与 AEAD 认证。
 * @param key - 该方向的 AEAD 密钥。
 * @param nonceBase - 会话开始时随机生成的 4 字节 nonce 前缀。
 * @param truncateTag - **已废弃**，保留仅为兼容调用点；标签一律使用完整 16 字节。
 *   曾尝试用 8 字节短标签省开销，但"标签长度"变成一个需要两端猜的参数：
 *   Node 端写 8 字节而解析硬编码 16 字节，浏览器端 WebCrypto 又只接受 16 字节，
 *   一处不一致就表现为"帧认证失败"。8 字节的收益不值得这类风险，故统一为 16 字节。
 */
export declare function sealFrame(options: {
    readonly key: Uint8Array;
    readonly nonceBase: Uint8Array;
    readonly type: FrameType;
    readonly flags: FrameFlags;
    readonly counter: bigint;
    readonly payload: Uint8Array;
    readonly truncateTag?: boolean;
}): EncodedFrame;
/** 解析出的帧。 */
export interface ParsedFrameHeader {
    readonly type: FrameType;
    readonly flags: FrameFlags;
    readonly counter: bigint;
    readonly ciphertext: Buffer;
    readonly tag: Buffer;
}
/**
 * 解析帧头，不触碰密钥。长度异常直接抛错。
 *
 * @param hasTag - 该帧是否带认证标签。
 *   密文帧（AEAD 保护）必须为 true；**明文控制帧**（ClientHello 与握手期的 LinkError）
 *   为 false，此时 `payloadLen` 就是明文长度，`tag` 为空。
 *   把这一点做成显式参数而不是猜测，是为了让"帧长不匹配"这类错误早失败、且报错信息准确。
 */
export declare function parseFrame(bytes: Uint8Array, hasTag?: boolean): ParsedFrameHeader;
/** 封装一个**明文**控制帧（仅 ClientHello 与握手期 LinkError 使用）。 */
export declare function sealPlaintextFrame(type: FrameType, flags: FrameFlags, payload: Uint8Array, counter?: bigint): Buffer;
/** 解密结果：成功返回明文，失败返回稳定的错误码（不抛异常，便于统一处理）。 */
export type OpenResult = {
    readonly ok: true;
    readonly plaintext: Buffer;
} | {
    readonly ok: false;
    readonly code: string;
    readonly message: string;
};
/**
 * 解开一帧。同时做 AEAD 认证与重放检查。
 * @param replay - 该方向的重放窗口；解开成功时会在内部记录该 counter。
 */
export declare function openFrame(options: {
    readonly header: ParsedFrameHeader;
    readonly key: Uint8Array;
    readonly nonceBase: Uint8Array;
    readonly replay: ReplayWindow;
}): OpenResult;
/** 重放窗口的检查结果。 */
export type ReplayCheck = {
    readonly ok: true;
} | {
    readonly ok: false;
    readonly code: string;
    readonly message: string;
};
/**
 * 反重放滑动窗口（位图实现，内存恒定）。
 *
 * 语义（Dart 端必须逐条对齐，这是协议级约束）：
 *  - 接受区域为闭区间 `[highest - windowSize, highest + windowSize]`，其中 highest 为已接受的最大 counter。
 *  - 落在接受区域内且位图未标记 → 接受（允许一定程度的乱序/重排）。
 *  - 位图已标记 → 判定重放。
 *  - 高于 `highest + windowSize` → 拒绝（可能是注入的超前帧，避免攻击者用大 counter 把窗口推飞）。
 *  - 低于 `highest - windowSize` → 拒绝（过旧，无法再判定是否重放，只能拒绝）。
 *  - counter 0 保留（握手前的占位），任何情况下拒绝。
 *
 * 注意：窗口以**已接受的最大值**为锚点而不是"最大连续值"。协议要求发送方严格递增，
 * 因此正常路径下两者等价；乱序仅在网络重排或显式重试时发生，且被窗口大小约束。
 */
export declare class ReplayWindow {
    private highest;
    private readonly windowSize;
    /** 位图：bit i 对应 counter = lowest + i。容量 2×windowSize+1。 */
    private bitmap;
    private readonly capacity;
    /** 当前位图最低位对应的 counter。 */
    private lowest;
    private started;
    constructor(windowSize?: number);
    /** counter → 位图下标；-1 表示不可表示。 */
    private bitIndex;
    private isSet;
    private set;
    /** 位图整体左移 shift 位（丢弃低位、补零高位）。 */
    private slide;
    /** 预检查：不改变窗口状态。 */
    check(counter: bigint): ReplayCheck;
    /** 认证成功后提交该 counter。调用前应已通过 check()。 */
    accept(counter: bigint): void;
    /** 当前已接受的最大 counter（测试与调试用）。 */
    get top(): bigint;
}
/** 生成随机字节（nonce、nonceBase、票据等）。 */
export declare function randomBytesOf(length: number): Buffer;
/**
 * ServerHello 的线上封装：`{e: <临时公钥明文 base64url>, sh: <K_hs 保护的帧 base64url>}`。
 *
 * 为什么必须这样分层：K_hs 由临时 ECDH 共享密钥派生，而共享密钥需要服务端的临时公钥。
 * 若把临时公钥也加密进 ServerHello，客户端将无法算出解密所需的密钥——循环依赖。
 * 因此协议强制规定：临时公钥明文前置（它本就是公开值，泄露不损失任何机密性），
 * 其余字段（serverNonce、hostId、hostSigningKey、hostFingerprint、signature）
 * 全部进入 K_hs 保护的密文。Dart 端必须完全一致地实现本函数。
 */
export interface SealedServerHello {
    /** 服务端临时 X25519 公钥（base64url，32 字节），明文。 */
    readonly e: string;
    /** K_hs 保护的 ServerHello 帧（base64url）。 */
    readonly sh: string;
}
/** ServerHello 帧的固定 nonce 前缀（只有一帧，因此固定值安全）。 */
export declare const SERVER_HELLO_NONCE_BASE: Buffer<ArrayBuffer>;
/** 封装 ServerHello（宿主侧）。 */
export declare function sealServerHello(options: {
    readonly handshakeKey: Uint8Array;
    readonly serverEphemeralPublicKey: string;
    readonly payload: unknown;
}): SealedServerHello;
/** 解开 ServerHello（客户端侧）：先用明文临时公钥派生 K_hs，再解密密文。 */
export declare function openServerHello(options: {
    readonly sealed: SealedServerHello;
    readonly ephemeralPrivateKey: KeyObject;
}): {
    readonly ok: true;
    readonly payload: unknown;
    readonly handshakeKey: Buffer;
} | {
    readonly ok: false;
    readonly code: string;
    readonly message: string;
};
//# sourceMappingURL=crypto.d.ts.map