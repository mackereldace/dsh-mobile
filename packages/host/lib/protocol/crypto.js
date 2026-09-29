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
import { createCipheriv, createDecipheriv, createHash, createHmac, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, sign as ecSign, timingSafeEqual, verify as ecVerify, } from 'node:crypto';
import { AUTH_TAG_BYTES, ErrorCode, FRAME_HEADER_BYTES, FrameFlags, FrameType, MAX_FRAME_BYTES } from "./wire.js";
/** 32 字节密钥/公钥的 base64url 编解码。 */
export function toB64(bytes) {
    return Buffer.from(bytes).toString('base64url');
}
export function fromB64(text) {
    return Buffer.from(text, 'base64url');
}
/**
 * 从 SPKI DER 中取出 X25519 的 32 字节原始公钥。
 * Node 的 DER 尾部即原始公钥，跨端（Dart/Keystore）统一使用这 32 字节。
 */
function rawPublicKey(publicKey) {
    const der = publicKey.export({ type: 'spki', format: 'der' });
    return der.subarray(der.length - 32);
}
/** 把 32 字节原始 X25519 公钥包成 Node KeyObject。 */
export function x25519PublicKeyFromRaw(raw) {
    if (raw.length !== 32)
        throw new Error(`x25519 public key must be 32 bytes, got ${raw.length}`);
    const der = Buffer.concat([Buffer.from('302a300506032b656e032100', 'hex'), Buffer.from(raw)]);
    return createPublicKey({ key: der, format: 'der', type: 'spki' });
}
/**
 * 把 65 字节未压缩 P-256 公钥（0x04‖X32‖Y32）包成 Node KeyObject。
 * P-256 的 SPKI DER 前缀固定 26 字节，因此可以直接拼接。
 */
export function p256PublicKeyFromRaw(raw) {
    if (raw.length !== 65 || raw[0] !== 0x04) {
        throw new Error(`p256 public key must be 65 bytes starting with 0x04, got ${raw.length} bytes`);
    }
    const der = Buffer.concat([Buffer.from('3059301306072a8648ce3d020106082a8648ce3d030107034200', 'hex'), Buffer.from(raw)]);
    return createPublicKey({ key: der, format: 'der', type: 'spki' });
}
/** 从 SPKI DER 中取出未压缩 P-256 公钥（65 字节）。 */
function rawP256PublicKey(publicKey) {
    const der = publicKey.export({ type: 'spki', format: 'der' });
    return der.subarray(der.length - 65);
}
/** 生成 X25519 长期密钥对（设备或宿主身份；用于 ECDH）。 */
export function generateX25519KeyPair() {
    const { privateKey, publicKey } = generateKeyPairSync('x25519');
    return { publicKey: toB64(rawPublicKey(publicKey)), privateKey };
}
/** 生成 P-256 长期密钥对（宿主身份签名与设备签名，见文件头说明）。 */
export function generateP256KeyPair() {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    return { publicKey: toB64(rawP256PublicKey(publicKey)), privateKey };
}
/** 公钥指纹：SHA-256 原始公钥的前 16 字节，大写 hex 分组显示用（线格式为连续 hex）。 */
export function fingerprint(rawPublicKeyB64) {
    const digest = createHash('sha256').update(fromB64(rawPublicKeyB64)).digest();
    return digest.subarray(0, 16).toString('hex');
}
/** 把指纹格式化成人类可比对的 4 组形式：`A1B2-C3D4-E5F6-0718-293A-4B5C-6D7E-8F90`。 */
export function formatFingerprint(hex) {
    return (hex.match(/.{1,4}/g) ?? []).join('-').toUpperCase();
}
/** X25519 ECDH：返回 32 字节共享密钥。 */
export function ecdh(privateKey, peerPublicKeyB64) {
    return diffieHellman({ privateKey, publicKey: x25519PublicKeyFromRaw(fromB64(peerPublicKeyB64)) });
}
/**
 * ECDSA P-256 + SHA-256 签名，输出 **raw 64 字节（r‖s）**。
 *
 * 为什么必须转成 raw：Node 的 `crypto.sign` 对 EC 密钥默认输出 DER 编码（约 70~72 字节），
 * 而 WebCrypto 与 Dart 都使用 raw r‖s。两种格式混用会导致"签名永远验不过"，
 * 且极难排查（长度不同这一线索很容易被忽略）。因此这里统一转 raw。
 */
export function signRaw(privateKey, message) {
    const der = ecSign('sha256', Buffer.from(message), privateKey);
    return derToRawSignature(der);
}
/** ECDSA P-256 验签。接受 raw 64 字节签名；任何异常都视为验签失败，不向上抛。 */
export function verifyRaw(publicKeyB64, message, signature) {
    try {
        if (signature.length !== 64)
            return false;
        const der = rawToDerSignature(Buffer.from(signature));
        return ecVerify('sha256', Buffer.from(message), p256PublicKeyFromRaw(fromB64(publicKeyB64)), der);
    }
    catch {
        return false;
    }
}
/** DER `SEQUENCE{INTEGER r, INTEGER s}` → raw 64 字节（r‖s，各左补零到 32）。 */
export function derToRawSignature(der) {
    const buf = Buffer.from(der);
    let offset = 0;
    if (buf[offset] !== 0x30)
        throw new Error('invalid DER signature: missing SEQUENCE');
    offset += 1;
    const seqLen = buf[offset];
    offset += 1;
    if (seqLen > 0x80)
        offset += seqLen - 0x80; // 长形式长度（P-256 不会用到，但保持健壮）
    const readInteger = () => {
        if (buf[offset] !== 0x02)
            throw new Error('invalid DER signature: missing INTEGER');
        offset += 1;
        const len = buf[offset];
        offset += 1;
        const value = buf.subarray(offset, offset + len);
        offset += len;
        // 去掉符号填充零
        let start = 0;
        while (start < value.length - 1 && value[start] === 0x00)
            start++;
        const trimmed = value.subarray(start);
        if (trimmed.length > 32)
            throw new Error('invalid DER signature: integer too large');
        return Buffer.concat([Buffer.alloc(32 - trimmed.length), trimmed]);
    };
    const r = readInteger();
    const sPart = readInteger();
    return Buffer.concat([r, sPart]);
}
/** raw 64 字节（r‖s） → DER。 */
export function rawToDerSignature(raw) {
    if (raw.length !== 64)
        throw new Error(`raw signature must be 64 bytes, got ${raw.length}`);
    const encodeInteger = (value) => {
        let start = 0;
        while (start < value.length - 1 && value[start] === 0x00)
            start++;
        const trimmed = value.subarray(start);
        // 最高位为 1 时需要补一个 0x00，否则会被当成负数
        const needsPad = (trimmed[0] & 0x80) !== 0;
        const body = needsPad ? Buffer.concat([Buffer.from([0x00]), trimmed]) : trimmed;
        return Buffer.concat([Buffer.from([0x02, body.length]), body]);
    };
    const r = encodeInteger(Buffer.from(raw.subarray(0, 32)));
    const sPart = encodeInteger(Buffer.from(raw.subarray(32, 64)));
    const body = Buffer.concat([r, sPart]);
    return Buffer.concat([Buffer.from([0x30, body.length]), body]);
}
/** 域分离标签。不同用途的派生必须使用不同标签，防止密钥复用。 */
export const HkdfLabel = {
    ClientToServer: 'dsh-mobile/v1/c2s',
    ServerToClient: 'dsh-mobile/v1/s2c',
    ConfirmClient: 'dsh-mobile/v1/confirm-client',
    ConfirmServer: 'dsh-mobile/v1/confirm-server',
    UploadChunk: 'dsh-mobile/v1/upload',
    /** 握手阶段（保护 ServerHello）。 */
    Handshake: 'dsh-mobile/v1/hs',
};
/** HKDF-SHA256 派生 32 字节密钥。 */
export function deriveKey(ikm, salt, label) {
    return Buffer.from(hkdfSync('sha256', Buffer.from(ikm), Buffer.from(salt), Buffer.from(label), 32));
}
/**
 * 从共享密钥与 transcript 派生全部会话密钥。
 * @param sharedSecret - X25519 ECDH 输出。
 * @param transcriptHash - 握手 transcript 的 SHA-256（32 字节），作为 HKDF salt 绑定上下文。
 */
export function deriveSessionKeys(sharedSecret, transcriptHash) {
    return {
        clientToServer: deriveKey(sharedSecret, transcriptHash, HkdfLabel.ClientToServer),
        serverToClient: deriveKey(sharedSecret, transcriptHash, HkdfLabel.ServerToClient),
        confirmClient: deriveKey(sharedSecret, transcriptHash, HkdfLabel.ConfirmClient),
        confirmServer: deriveKey(sharedSecret, transcriptHash, HkdfLabel.ConfirmServer),
    };
}
/** 会话确认 MAC：HMAC-SHA256(key, transcriptHash) 前 16 字节。 */
export function confirmMac(key, transcriptHash) {
    return createHmac('sha256', Buffer.from(key)).update(Buffer.from(transcriptHash)).digest().subarray(0, 16);
}
/** 常量时间比较，用于 MAC/签名等敏感比较。 */
export function constantTimeEqual(a, b) {
    if (a.length !== b.length)
        return false;
    return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
/**
 * 握手 transcript 的规范化编码：每个字段以 4 字节大端长度前缀拼接。
 * 目的：让"字段边界"进入签名范围，避免拼接歧义攻击。
 */
export function encodeTranscript(fields) {
    const parts = [];
    for (const field of fields) {
        const bytes = typeof field === 'string' ? Buffer.from(field, 'utf8') : Buffer.from(field);
        const len = Buffer.alloc(4);
        len.writeUInt32BE(bytes.length, 0);
        parts.push(len, bytes);
    }
    return Buffer.concat(parts);
}
/** 计算 transcript 哈希（SHA-256）。 */
export function transcriptHash(fields) {
    return createHash('sha256').update(encodeTranscript(fields)).digest();
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
export function sealFrame(options) {
    const { key, nonceBase, type, flags, counter, payload } = options;
    if (nonceBase.length !== 4)
        throw new Error('nonceBase must be 4 bytes');
    const plaintext = Buffer.from(payload);
    if (plaintext.length > MAX_FRAME_BYTES)
        throw new Error(`payload ${plaintext.length} exceeds MAX_FRAME_BYTES`);
    const counterBytes = Buffer.alloc(8);
    counterBytes.writeBigUInt64BE(counter, 0);
    const nonce = Buffer.concat([Buffer.from(nonceBase), counterBytes]);
    const cipher = createCipheriv('aes-256-gcm', Buffer.from(key), nonce);
    cipher.setAAD(counterBytes);
    const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    const header = Buffer.alloc(FRAME_HEADER_BYTES);
    header.writeUInt8(type, 0);
    header.writeUInt8(flags, 1);
    header.writeUInt32BE(body.length + tag.length, 2);
    counterBytes.copy(header, 6);
    return { type, flags, counter, bytes: Buffer.concat([header, body, tag]) };
}
/**
 * 解析帧头，不触碰密钥。长度异常直接抛错。
 *
 * @param hasTag - 该帧是否带认证标签。
 *   密文帧（AEAD 保护）必须为 true；**明文控制帧**（ClientHello 与握手期的 LinkError）
 *   为 false，此时 `payloadLen` 就是明文长度，`tag` 为空。
 *   把这一点做成显式参数而不是猜测，是为了让"帧长不匹配"这类错误早失败、且报错信息准确。
 */
export function parseFrame(bytes, hasTag = true) {
    const buf = Buffer.from(bytes);
    const minimum = FRAME_HEADER_BYTES + (hasTag ? AUTH_TAG_BYTES : 0);
    if (buf.length < minimum)
        throw new Error(`frame too short: ${buf.length} < ${minimum}`);
    const type = buf.readUInt8(0);
    const flags = buf.readUInt8(1);
    const payloadLen = buf.readUInt32BE(2);
    if (hasTag && payloadLen < AUTH_TAG_BYTES)
        throw new Error(`frame payload too short: ${payloadLen}`);
    if (FRAME_HEADER_BYTES + payloadLen !== buf.length) {
        throw new Error(`frame length mismatch: header says ${FRAME_HEADER_BYTES + payloadLen}, got ${buf.length}`);
    }
    if (buf.length > MAX_FRAME_BYTES)
        throw new Error(`frame exceeds MAX_FRAME_BYTES: ${buf.length}`);
    const counter = buf.readBigUInt64BE(6);
    const body = buf.subarray(FRAME_HEADER_BYTES);
    if (!hasTag)
        return { type, flags, counter, ciphertext: body, tag: Buffer.alloc(0) };
    // 标签长度固定 16 字节（见 sealFrame 的说明）
    const tagLen = 16;
    const tag = body.subarray(body.length - tagLen);
    const ciphertext = body.subarray(0, body.length - tagLen);
    return { type, flags, counter, ciphertext, tag };
}
/** 封装一个**明文**控制帧（仅 ClientHello 与握手期 LinkError 使用）。 */
export function sealPlaintextFrame(type, flags, payload, counter = 1n) {
    const body = Buffer.from(payload);
    const header = Buffer.alloc(FRAME_HEADER_BYTES);
    header.writeUInt8(type, 0);
    header.writeUInt8(flags, 1);
    header.writeUInt32BE(body.length, 2);
    header.writeBigUInt64BE(counter, 6);
    return Buffer.concat([header, body]);
}
/**
 * 解开一帧。同时做 AEAD 认证与重放检查。
 * @param replay - 该方向的重放窗口；解开成功时会在内部记录该 counter。
 */
export function openFrame(options) {
    const { header, key, nonceBase, replay } = options;
    const replayCheck = replay.check(header.counter);
    if (!replayCheck.ok) {
        return { ok: false, code: replayCheck.code, message: replayCheck.message };
    }
    const counterBytes = Buffer.alloc(8);
    counterBytes.writeBigUInt64BE(header.counter, 0);
    const nonce = Buffer.concat([Buffer.from(nonceBase), counterBytes]);
    try {
        const decipher = createDecipheriv('aes-256-gcm', Buffer.from(key), nonce);
        decipher.setAAD(counterBytes);
        decipher.setAuthTag(header.tag);
        const plaintext = Buffer.concat([decipher.update(header.ciphertext), decipher.final()]);
        replay.accept(header.counter);
        return { ok: true, plaintext };
    }
    catch {
        return { ok: false, code: ErrorCode.DecryptFailed, message: 'frame authentication failed' };
    }
}
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
export class ReplayWindow {
    highest = 0n;
    windowSize;
    /** 位图：bit i 对应 counter = lowest + i。容量 2×windowSize+1。 */
    bitmap;
    capacity;
    /** 当前位图最低位对应的 counter。 */
    lowest = 0n;
    started = false;
    constructor(windowSize = 1024) {
        if (!Number.isSafeInteger(windowSize) || windowSize < 1)
            throw new Error('windowSize must be a positive integer');
        this.windowSize = BigInt(windowSize);
        this.capacity = windowSize * 2 + 1;
        this.bitmap = new Uint8Array((this.capacity + 7) >> 3);
    }
    /** counter → 位图下标；-1 表示不可表示。 */
    bitIndex(counter) {
        const offset = counter - this.lowest;
        if (offset < 0n || offset >= BigInt(this.capacity))
            return -1;
        return Number(offset);
    }
    isSet(index) {
        return (this.bitmap[index >> 3] & (1 << (index & 7))) !== 0;
    }
    set(index) {
        this.bitmap[index >> 3] |= 1 << (index & 7);
    }
    /** 位图整体左移 shift 位（丢弃低位、补零高位）。 */
    slide(shift) {
        if (shift <= 0)
            return;
        if (shift >= this.capacity) {
            this.bitmap.fill(0);
            return;
        }
        const byteShift = shift >> 3;
        const bitShift = shift & 7;
        const next = new Uint8Array(this.bitmap.length);
        for (let i = this.bitmap.length - 1; i >= 0; i--) {
            const lowByte = i - byteShift >= 0 ? this.bitmap[i - byteShift] : 0;
            const carryByte = bitShift > 0 && i - byteShift - 1 >= 0 ? this.bitmap[i - byteShift - 1] : 0;
            next[i] = bitShift === 0 ? lowByte : ((lowByte << bitShift) | (carryByte >>> (8 - bitShift))) & 0xff;
        }
        this.bitmap = next;
        this.lowest += BigInt(shift);
    }
    /** 预检查：不改变窗口状态。 */
    check(counter) {
        if (counter <= 0n) {
            return { ok: false, code: ErrorCode.ReplayDetected, message: `counter ${counter} is reserved` };
        }
        if (!this.started)
            return { ok: true };
        if (counter > this.highest + this.windowSize) {
            return {
                ok: false,
                code: ErrorCode.ReplayDetected,
                message: `counter ${counter} is beyond the window (highest ${this.highest}, window ${this.windowSize})`,
            };
        }
        if (counter < this.highest - this.windowSize) {
            return { ok: false, code: ErrorCode.ReplayDetected, message: `counter ${counter} is too old (highest ${this.highest})` };
        }
        const index = this.bitIndex(counter);
        // 落入接受区间却不可表示，说明位图需要先按 highest 对齐；此时按"未见过"处理更安全，
        // 因为 accept() 会先滑动位图再落位。
        if (index >= 0 && this.isSet(index)) {
            return { ok: false, code: ErrorCode.ReplayDetected, message: `counter ${counter} already seen` };
        }
        return { ok: true };
    }
    /** 认证成功后提交该 counter。调用前应已通过 check()。 */
    accept(counter) {
        if (!this.started) {
            this.started = true;
            this.highest = counter;
            this.lowest = counter;
            this.set(0);
            return;
        }
        // 位图需要容纳 counter：必要时左移到以 counter - capacity + 1 为最低位
        const neededLowest = counter - BigInt(this.capacity - 1);
        if (neededLowest > this.lowest)
            this.slide(Number(neededLowest - this.lowest));
        const index = this.bitIndex(counter);
        if (index >= 0)
            this.set(index);
        if (counter > this.highest)
            this.highest = counter;
    }
    /** 当前已接受的最大 counter（测试与调试用）。 */
    get top() {
        return this.highest;
    }
}
/** 生成随机字节（nonce、nonceBase、票据等）。 */
export function randomBytesOf(length) {
    return randomBytes(length);
}
/** ServerHello 帧的固定 nonce 前缀（只有一帧，因此固定值安全）。 */
export const SERVER_HELLO_NONCE_BASE = Buffer.from([0x00, 0x00, 0x00, 0x01]);
/** 封装 ServerHello（宿主侧）。 */
export function sealServerHello(options) {
    const sealed = sealFrame({
        key: options.handshakeKey,
        nonceBase: SERVER_HELLO_NONCE_BASE,
        type: 0x02,
        flags: 0x01,
        counter: 1n,
        payload: Buffer.from(JSON.stringify(options.payload), 'utf8'),
        truncateTag: false,
    });
    return { e: options.serverEphemeralPublicKey, sh: sealed.bytes.toString('base64url') };
}
/** 解开 ServerHello（客户端侧）：先用明文临时公钥派生 K_hs，再解密密文。 */
export function openServerHello(options) {
    let shared;
    try {
        shared = diffieHellman({
            privateKey: options.ephemeralPrivateKey,
            publicKey: x25519PublicKeyFromRaw(fromB64(options.sealed.e)),
        });
    }
    catch {
        return { ok: false, code: ErrorCode.HandshakeMalformed, message: 'ServerHello carries an invalid ephemeral public key' };
    }
    const key = deriveKey(shared, Buffer.alloc(0), HkdfLabel.Handshake);
    let header;
    try {
        header = parseFrame(fromB64(options.sealed.sh));
    }
    catch (error) {
        return { ok: false, code: ErrorCode.HandshakeMalformed, message: `malformed ServerHello frame: ${String(error)}` };
    }
    const opened = openFrame({ header, key, nonceBase: SERVER_HELLO_NONCE_BASE, replay: new ReplayWindow() });
    if (!opened.ok)
        return { ok: false, code: opened.code, message: opened.message };
    try {
        return { ok: true, payload: JSON.parse(opened.plaintext.toString('utf8')), handshakeKey: key };
    }
    catch {
        return { ok: false, code: ErrorCode.HandshakeMalformed, message: 'ServerHello payload is not valid JSON' };
    }
}
//# sourceMappingURL=crypto.js.map