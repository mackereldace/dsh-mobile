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
import { confirmMac, constantTimeEqual, deriveKey, deriveSessionKeys, ecdh, fingerprint, fromB64, generateX25519KeyPair, randomBytesOf, signRaw, toB64, transcriptHash, verifyRaw, HkdfLabel, } from "./crypto.js";
import { ErrorCode, PROTOCOL_VERSION, } from "./wire.js";
/** 握手阶段的固定 nonce 前缀。每次握手使用全新的临时密钥，因此固定前缀是安全的。 */
const HANDSHAKE_NONCE_PREFIX = Buffer.from([0x00, 0x00, 0x00, 0x01]);
/** 会话标识：transcript 哈希前 16 字节 hex。 */
function sessionIdOf(transcript) {
    return transcript.subarray(0, 16).toString('hex');
}
/** 计算 transcript 哈希（两端必须传入完全相同的字段顺序）。 */
function buildTranscript(input) {
    return transcriptHash([
        String(PROTOCOL_VERSION),
        input.clientNonce,
        input.serverNonce,
        input.clientEphemeral,
        input.serverEphemeral,
        input.deviceId,
        input.hostId,
    ]);
}
// ────────────────────────────── 客户端侧 ──────────────────────────────
/** 客户端握手状态机。每一步只接受唯一合法的下一帧。 */
export class ClientHandshake {
    options;
    ephemeral;
    clientNonce;
    clientNonceBase;
    hello;
    serverHello;
    sharedSecret;
    keys;
    transcript;
    state = 'init';
    failure;
    constructor(options) {
        this.options = options;
        this.ephemeral = generateX25519KeyPair();
        this.clientNonce = toB64(randomBytesOf(32));
        this.clientNonceBase = randomBytesOf(4);
    }
    /** 生成第一帧（ClientHello，明文）。 */
    start() {
        if (this.state !== 'init')
            return this.fail(ErrorCode.HandshakeMalformed, 'handshake already started');
        const payload = {
            protocolVersion: PROTOCOL_VERSION,
            deviceId: this.options.deviceId,
            ephemeralPublicKey: this.ephemeral.publicKey,
            clientNonce: this.clientNonce,
            ...(this.options.pairingTicket === undefined ? {} : { pairingTicket: this.options.pairingTicket }),
            ...(this.options.requestedCapabilities === undefined ? {} : { requestedCapabilities: this.options.requestedCapabilities }),
        };
        this.hello = payload;
        this.state = 'hello-sent';
        return { kind: 'send', payload };
    }
    /** 持有本次握手的临时密钥对（握手帧加解密用）。 */
    get ephemeralKeys() {
        return this.ephemeral;
    }
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
    noteServerEphemeralKey(ephemeralPublicKey) {
        this.serverHello = { ...(this.serverHello ?? {}), ephemeralPublicKey };
    }
    handshakeKey() {
        const serverHello = this.serverHello;
        const shared = this.sharedSecret ?? (serverHello?.ephemeralPublicKey === undefined ? undefined : ecdh(this.ephemeral.privateKey, serverHello.ephemeralPublicKey));
        if (shared === undefined)
            throw new Error('handshake not started: server ephemeral key is required to derive the handshake key');
        return deriveKey(shared, Buffer.alloc(0), HkdfLabel.Handshake);
    }
    /** 会话密钥（在 acceptServerHello 成功后可用）。 */
    get sessionKeys() {
        return this.keys;
    }
    /** 处理 ServerHello（已由调用方解密）。返回下一帧（ClientAuth）。 */
    acceptServerHello(payload) {
        if (this.state !== 'hello-sent')
            return this.fail(ErrorCode.HandshakeMalformed, `unexpected ServerHello in state ${this.state}`);
        const hello = this.hello;
        if (hello === undefined)
            return this.fail(ErrorCode.HandshakeMalformed, 'missing ClientHello');
        if (payload.protocolVersion !== PROTOCOL_VERSION) {
            return this.fail(ErrorCode.ProtocolVersion, `host speaks protocol ${payload.protocolVersion}, client speaks ${PROTOCOL_VERSION}`);
        }
        // TOFU：已知宿主身份时，指纹必须一致
        if (this.options.pinnedHostSigningKey !== undefined && this.options.pinnedHostSigningKey !== payload.hostSigningKey) {
            return this.fail(ErrorCode.HandshakeSignature, `host identity key changed: pinned ${fingerprint(this.options.pinnedHostSigningKey)}, got ${payload.hostFingerprint}`);
        }
        if (fingerprint(payload.hostSigningKey) !== payload.hostFingerprint) {
            return this.fail(ErrorCode.HandshakeSignature, 'host fingerprint does not match its signing key');
        }
        this.serverHello = payload;
        this.sharedSecret = ecdh(this.ephemeral.privateKey, payload.ephemeralPublicKey);
        this.transcript = buildTranscript({
            clientNonce: hello.clientNonce,
            serverNonce: payload.serverNonce,
            clientEphemeral: hello.ephemeralPublicKey,
            serverEphemeral: payload.ephemeralPublicKey,
            deviceId: hello.deviceId,
            hostId: payload.hostId,
        });
        const signature = fromB64(payload.signature);
        if (!verifyRaw(payload.hostSigningKey, this.transcript, signature)) {
            return this.fail(ErrorCode.HandshakeSignature, 'host signature over the handshake transcript is invalid');
        }
        this.keys = deriveSessionKeys(this.sharedSecret, this.transcript);
        const auth = {
            signature: toB64(signRaw(this.options.deviceSigningKey.privateKey, this.transcript)),
            confirm: toB64(confirmMac(this.keys.confirmClient, this.transcript)),
            clientNonceBase: toB64(this.clientNonceBase),
        };
        this.state = 'authenticating';
        return { kind: 'send', payload: auth };
    }
    /** 处理 ServerAuthOk（已解密）。验 MAC 后握手完成。 */
    acceptServerAuthOk(payload) {
        if (this.state !== 'authenticating')
            return this.fail(ErrorCode.HandshakeMalformed, `unexpected ServerAuthOk in state ${this.state}`);
        const keys = this.keys;
        const transcript = this.transcript;
        if (keys === undefined || transcript === undefined)
            return this.fail(ErrorCode.HandshakeMalformed, 'session keys missing');
        const hello = this.hello;
        const serverHello = this.serverHello;
        if (hello === undefined || serverHello === undefined)
            return this.fail(ErrorCode.HandshakeMalformed, 'handshake context missing');
        if (!constantTimeEqual(fromB64(payload.confirm), confirmMac(keys.confirmServer, transcript))) {
            return this.fail(ErrorCode.HandshakeConfirm, 'host confirmation MAC does not match');
        }
        const expectedSessionId = sessionIdOf(transcript);
        if (payload.sessionId !== expectedSessionId) {
            return this.fail(ErrorCode.HandshakeConfirm, `host session id ${payload.sessionId} does not match derived ${expectedSessionId}`);
        }
        if (payload.authorization === 'revoked') {
            return this.fail(ErrorCode.DeviceRevoked, 'host reported this device as revoked');
        }
        // serverNonceBase 必须与 ServerHello 一致：不一致说明握手被拼装过
        const announcedNonceBase = this.serverHello?.serverNonceBase;
        if (announcedNonceBase !== undefined && announcedNonceBase !== payload.serverNonceBase) {
            return this.fail(ErrorCode.HandshakeConfirm, 'serverNonceBase differs between ServerHello and ServerAuthOk');
        }
        const hostId = serverHello.hostId;
        const hostFingerprint = serverHello.hostFingerprint;
        if (hostId === undefined || hostFingerprint === undefined) {
            return this.fail(ErrorCode.HandshakeMalformed, 'ServerHello is missing host identity fields');
        }
        this.state = 'done';
        return {
            kind: 'done',
            session: {
                sessionId: payload.sessionId,
                deviceId: hello.deviceId,
                hostId,
                peerFingerprint: hostFingerprint,
                keys,
                clientNonceBase: this.clientNonceBase,
                serverNonceBase: fromB64(payload.serverNonceBase),
                capabilities: payload.capabilities,
                authorization: payload.authorization,
            },
        };
    }
    fail(code, message) {
        this.state = 'failed';
        this.failure = { code, message };
        return { kind: 'fail', code, message };
    }
    /** 失败原因（若有）。 */
    get error() {
        return this.failure;
    }
}
// ────────────────────────────── 宿主侧 ──────────────────────────────
/** 宿主侧握手状态机。 */
export class HostHandshake {
    options;
    ephemeral;
    serverNonce;
    serverNonceBase;
    hello;
    credentials;
    sharedSecret;
    keys;
    transcript;
    state = 'init';
    failure;
    constructor(options) {
        this.options = options;
        this.ephemeral = generateX25519KeyPair();
        this.serverNonce = toB64(randomBytesOf(32));
        this.serverNonceBase = randomBytesOf(4);
    }
    /** 处理 ClientHello（明文）。返回 ServerHello 载荷（调用方需用 handshakeKey 加密封装）。 */
    async acceptClientHello(payload) {
        if (this.state !== 'init')
            return this.fail(ErrorCode.HandshakeMalformed, `unexpected ClientHello in state ${this.state}`);
        if (payload.protocolVersion !== PROTOCOL_VERSION) {
            return this.fail(ErrorCode.ProtocolVersion, `client speaks protocol ${payload.protocolVersion}, host speaks ${PROTOCOL_VERSION}`);
        }
        if (typeof payload.deviceId !== 'string' || payload.deviceId.length === 0) {
            return this.fail(ErrorCode.HandshakeMalformed, 'missing deviceId');
        }
        if (typeof payload.ephemeralPublicKey !== 'string' || typeof payload.clientNonce !== 'string') {
            return this.fail(ErrorCode.HandshakeMalformed, 'missing ephemeral key or nonce');
        }
        const credentials = await this.options.resolveDevice(payload);
        if (credentials === undefined) {
            return this.fail(payload.pairingTicket === undefined ? ErrorCode.DeviceUnknown : ErrorCode.PairingPending, 'device is not paired with this host');
        }
        if (credentials.deviceId !== payload.deviceId) {
            return this.fail(ErrorCode.DeviceUnknown, 'resolved credentials do not match the presented device id');
        }
        this.hello = payload;
        this.credentials = credentials;
        this.sharedSecret = ecdh(this.ephemeral.privateKey, payload.ephemeralPublicKey);
        this.transcript = buildTranscript({
            clientNonce: payload.clientNonce,
            serverNonce: this.serverNonce,
            clientEphemeral: payload.ephemeralPublicKey,
            serverEphemeral: this.ephemeral.publicKey,
            deviceId: payload.deviceId,
            hostId: this.options.hostId,
        });
        const requested = payload.requestedCapabilities;
        const granted = this.options.grantCapabilities === undefined
            ? credentials.capabilities
            : this.options.grantCapabilities(requested, credentials);
        this.state = 'hello-received';
        const serverHello = {
            protocolVersion: PROTOCOL_VERSION,
            hostId: this.options.hostId,
            ephemeralPublicKey: this.ephemeral.publicKey,
            serverNonce: this.serverNonce,
            // 提前下发：客户端需要它来解开紧随其后的 ServerAuthOk
            serverNonceBase: toB64(this.serverNonceBase),
            hostSigningKey: this.options.hostSigningKey.publicKey,
            hostFingerprint: fingerprint(this.options.hostSigningKey.publicKey),
            signature: toB64(signRaw(this.options.hostSigningKey.privateKey, this.transcript)),
        };
        // granted 暂存于 credentials 的副本上，供 ServerAuthOk 使用
        this.granted = granted;
        return { kind: "send", payload: serverHello };
    }
    granted;
    /** 握手阶段的 AEAD 密钥（保护 ServerHello）。派生规则与客户端完全一致。 */
    handshakeKey() {
        const ss = this.sharedSecret;
        if (ss === undefined)
            throw new Error('handshake not started');
        return deriveKey(ss, Buffer.alloc(0), HkdfLabel.Handshake);
    }
    /** 处理 ClientAuth（已解密）。验签 + 验 MAC，返回 ServerAuthOk 载荷。 */
    acceptClientAuth(payload) {
        if (this.state !== 'hello-received')
            return this.fail(ErrorCode.HandshakeMalformed, `unexpected ClientAuth in state ${this.state}`);
        const credentials = this.credentials;
        const transcript = this.transcript;
        const ss = this.sharedSecret;
        const hello = this.hello;
        if (credentials === undefined || transcript === undefined || ss === undefined || hello === undefined) {
            return this.fail(ErrorCode.HandshakeMalformed, 'handshake context missing');
        }
        if (credentials.authorization === 'revoked') {
            return this.fail(ErrorCode.DeviceRevoked, 'device authorization has been revoked');
        }
        if (!verifyRaw(credentials.deviceSigningKey, transcript, fromB64(payload.signature))) {
            return this.fail(ErrorCode.HandshakeSignature, 'device signature over the handshake transcript is invalid');
        }
        // 指纹以**签名公钥**为准（协议约定）：它才是设备身份凭证。
        if (fingerprint(credentials.deviceSigningKey) !== credentials.fingerprint) {
            return this.fail(ErrorCode.DeviceUnknown, 'stored device fingerprint does not match its signing key');
        }
        this.keys = deriveSessionKeys(ss, transcript);
        const expected = confirmMac(this.keys.confirmClient, transcript);
        if (!constantTimeEqual(fromB64(payload.confirm), expected)) {
            return this.fail(ErrorCode.HandshakeConfirm, 'client confirmation MAC does not match');
        }
        let clientNonceBase;
        try {
            clientNonceBase = fromB64(payload.clientNonceBase);
        }
        catch {
            return this.fail(ErrorCode.HandshakeMalformed, 'invalid clientNonceBase');
        }
        if (clientNonceBase.length !== 4)
            return this.fail(ErrorCode.HandshakeMalformed, 'clientNonceBase must be 4 bytes');
        this.clientNonceBase = clientNonceBase;
        this.state = 'authenticated';
        const sessionId = sessionIdOf(transcript);
        const authOk = {
            deviceId: hello.deviceId,
            sessionId,
            capabilities: this.granted ?? credentials.capabilities,
            authorization: credentials.authorization,
            idleTimeoutMs: this.options.idleTimeoutMs ?? 300_000,
            serverNonceBase: toB64(this.serverNonceBase),
            confirm: toB64(confirmMac(this.keys.confirmServer, transcript)),
        };
        return { kind: "send", payload: authOk };
    }
    /** 客户端方向 nonce 前缀（收到 ClientAuth 后可用）。 */
    clientNonceBase;
    /** 排障用：宿主实际用于验签的设备指纹（未收到 ClientHello 时为空）。 */
    get storedFingerprint() {
        return this.credentials?.fingerprint;
    }
    /**
     * 已认证但尚未 complete 的会话视图。
     * 用途：宿主需要用会话密钥（serverToClient）保护 ServerAuthOk 这一帧。
     */
    pending() {
        return this.buildSession();
    }
    /** 握手完成：移交会话。调用方在成功发送 ServerAuthOk 之后调用。 */
    complete() {
        this.state = 'done';
        return this.buildSession();
    }
    /** 会话视图构造：仅在认证完成之后可调用。 */
    buildSession() {
        const keys = this.keys;
        const transcript = this.transcript;
        const hello = this.hello;
        const credentials = this.credentials;
        if (keys === undefined ||
            transcript === undefined ||
            hello === undefined ||
            credentials === undefined ||
            this.clientNonceBase === undefined) {
            throw new Error('handshake is not authenticated');
        }
        return {
            sessionId: sessionIdOf(transcript),
            deviceId: hello.deviceId,
            hostId: this.options.hostId,
            peerFingerprint: credentials.fingerprint,
            keys,
            clientNonceBase: this.clientNonceBase,
            serverNonceBase: this.serverNonceBase,
            capabilities: this.granted ?? credentials.capabilities,
            authorization: credentials.authorization,
        };
    }
    fail(code, message) {
        this.state = 'failed';
        this.failure = { code, message };
        return { kind: 'fail', code, message };
    }
    get error() {
        return this.failure;
    }
}
/** 握手帧的固定 nonce 前缀（导出以便测试与 Dart 端对齐）。 */
export const HANDSHAKE_NONCE_BASE = HANDSHAKE_NONCE_PREFIX;
//# sourceMappingURL=handshake.js.map