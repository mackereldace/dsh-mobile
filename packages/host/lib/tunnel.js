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
import { DEFAULT_CAPABILITIES, ErrorCode, FrameFlags, FrameType, wireError, } from './protocol/index.js';
import { openFrame, parseFrame, ReplayWindow, sealFrame, sealPlaintextFrame, } from './protocol/index.js';
import { encodeBinary, HostHandshake } from './protocol/index.js';
/** 握手帧的固定 nonce 前缀（与协议文档一致）。 */
const HANDSHAKE_NONCE_BASE = Buffer.from([0x00, 0x00, 0x00, 0x01]);
/**
 * 单连接隧道会话。
 *
 * 用法：`new TunnelSession(delegate, sink)` → `receive(bytes)` → `close(reason)`。
 * 本类是纯状态机，不接触 WebSocket API，便于单测（直接把两条会话对接即可）。
 */
export class TunnelSession {
    delegate;
    sink;
    state = 'awaiting-hello';
    handshake;
    session;
    outCounter = 1n;
    inReplay = new ReplayWindow();
    streams = new Map();
    mux = { nextStreamId: 1 };
    pendingQueue = Promise.resolve();
    closeReason;
    /** 建立后用于发送方向的会话视图（握手刚完成、尚未 complete 时也要能发 ServerAuthOk）。 */
    sendKeys;
    debugLabel;
    constructor(delegate, sink, debugLabel = 'tunnel') {
        this.delegate = delegate;
        this.sink = sink;
        this.debugLabel = debugLabel;
    }
    /** 当前状态。 */
    get currentState() {
        return this.state;
    }
    /** 已建立的会话（未完成握手时为 undefined）。 */
    get established() {
        return this.session;
    }
    /**
     * 接收一帧原始字节。
     *
     * 内部用 Promise 串行化：握手与数据帧的处理都含 await，若不串行化，
     * 同一连接上的后续帧会在前帧未处理完时并发进入，导致计数器错乱。
     */
    receive(bytes) {
        // 串行化：握手与数据帧的处理都含 await，若不串行化，同一连接上的后续帧
        // 会在前帧未处理完时并发进入，导致计数器与状态错乱。
        this.pendingQueue = this.pendingQueue.then(() => this.handleFrame(bytes), () => this.handleFrame(bytes));
        // 兜底：handleFrame 内部虽已捕获主要错误，但任何漏网异常都必须可见，
        // 否则会表现为"帧收到了却没处理"，排障时毫无线索。
        this.pendingQueue.catch((error) => {
            console.error('[mobile-host] 处理隧道帧时发生未捕获异常：', error);
        });
    }
    /** 关闭会话：中止全部上游流，回调断开。 */
    close(reason) {
        if (this.state === 'closed')
            return;
        this.state = 'closed';
        this.closeReason = reason;
        for (const [id, stream] of this.streams) {
            this.streams.delete(id);
            stream.controller.abort(new Error(reason));
        }
        this.delegate.onClosed?.(this.session, reason);
    }
    /** 关闭原因（测试与审计用）。 */
    get closedBy() {
        return this.closeReason;
    }
    /**
     * 链路级失败的结构化记录（测试、审计与排障用）。
     * 保留 code 而不只是 message，便于排障时区分"版本不符"与"未配对"这类不同原因。
     */
    get failure() {
        return this.failureInfo;
    }
    failureInfo;
    async handleFrame(bytes) {
        if (this.state === 'closed')
            return;
        // ── 阶段 1：明文 ClientHello（无认证标签，payloadLen 即明文长度）──────
        if (this.state === 'awaiting-hello') {
            let header;
            try {
                header = parseFrame(bytes, false);
            }
            catch (error) {
                await this.fail(ErrorCode.HandshakeMalformed, `malformed ClientHello frame: ${String(error)}`);
                return;
            }
            if (header.type !== FrameType.ClientHello) {
                await this.fail(ErrorCode.HandshakeMalformed, `expected ClientHello, got frame type ${header.type}`);
                return;
            }
            let hello;
            try {
                hello = JSON.parse(header.ciphertext.toString('utf8'));
            }
            catch {
                await this.fail(ErrorCode.HandshakeMalformed, 'ClientHello is not valid JSON');
                return;
            }
            await this.acceptHello(hello);
            return;
        }
        let header;
        try {
            header = parseFrame(bytes);
        }
        catch (error) {
            await this.fail(ErrorCode.HandshakeMalformed, `malformed frame: ${String(error)}`);
            return;
        }
        // ── 阶段 2：ClientAuth（K_hs 保护）────────────────────────────────
        if (this.state === 'handshaking') {
            const handshake = this.handshake;
            if (handshake === undefined) {
                await this.fail(ErrorCode.Internal, 'handshake state lost');
                return;
            }
            if (header.type !== FrameType.ClientAuth) {
                await this.fail(ErrorCode.HandshakeMalformed, `expected ClientAuth, got frame type ${header.type}`);
                return;
            }
            const opened = openFrame({
                header,
                key: handshake.handshakeKey(),
                nonceBase: HANDSHAKE_NONCE_BASE,
                replay: new ReplayWindow(), // 握手只有一帧，独立窗口
            });
            if (!opened.ok) {
                await this.fail(opened.code, opened.message);
                return;
            }
            let auth;
            try {
                auth = JSON.parse(opened.plaintext.toString('utf8'));
            }
            catch (error) {
                // 解密成功却解析不出 JSON，说明帧内容与密钥不匹配（或两端版本不同）。
                // 把明文摘要打出来，比只回一句"不是 JSON"有用得多。
                console.error('[mobile-host] ClientAuth 不是合法 JSON：', error, '明文摘要=', opened.plaintext.subarray(0, 80).toString('utf8'));
                await this.fail(ErrorCode.HandshakeMalformed, 'ClientAuth is not valid JSON');
                return;
            }
            await this.acceptAuth(auth);
            return;
        }
        // ── 阶段 3：会话密钥保护 ─────────────────────────────────────────
        const session = this.session;
        if (session === undefined) {
            await this.fail(ErrorCode.Internal, 'session state lost');
            return;
        }
        const opened = openFrame({
            header,
            key: session.keys.clientToServer,
            nonceBase: session.clientNonceBase,
            replay: this.inReplay,
        });
        if (!opened.ok) {
            await this.fail(opened.code, opened.message);
            return;
        }
        await this.dispatch(header.type, opened.plaintext);
    }
    async acceptHello(hello) {
        const handshake = new HostHandshake({
            hostId: this.hostId,
            hostSigningKey: this.hostSigningKey,
            resolveDevice: (payload) => this.delegate.resolveDevice(payload),
        });
        this.handshake = handshake;
        /**
         * 设备解析可能**抛错**而不是返回 undefined——例如票据仍在等待电脑端确认
         * （`PairingPending`）、票据过期、或重新配对时票据与设备不匹配。
         *
         * 必须在这里把它转成明确的错误帧。曾经漏了这一步：异常一路冒泡到 `receive()` 的兜底 catch，
         * 被记成"未捕获异常"后**既不发错误帧也不关连接**——客户端只能干等自己的 15 秒连接超时，
         * 手机上表现为"配对时一直卡住"，而宿主日志里只有一行泛泛的未捕获异常。
         * 这种"沉默的拒绝"比明确报错难排查得多。
         */
        let outcome;
        try {
            outcome = await handshake.acceptClientHello(hello);
        }
        catch (error) {
            const code = typeof error?.code === 'string'
                ? error.code
                : ErrorCode.HandshakeMalformed;
            await this.fail(code, error instanceof Error ? error.message : String(error));
            return;
        }
        if (outcome.kind !== 'send') {
            await this.fail(outcome.kind === 'fail' ? outcome.code : ErrorCode.Internal, outcome.kind === 'fail' ? outcome.message : 'handshake failed');
            return;
        }
        const serverHello = outcome.payload;
        // ServerHello 的两层封装：临时公钥明文前置 + K_hs 保护的帧
        const sealed = sealServerHelloFrame(handshake.handshakeKey(), serverHello);
        this.state = 'handshaking';
        const ok = await this.sink(Buffer.from(JSON.stringify(sealed), 'utf8'));
        if (!ok)
            this.close('sink closed while sending ServerHello');
    }
    async acceptAuth(auth) {
        const handshake = this.handshake;
        if (handshake === undefined) {
            await this.fail(ErrorCode.Internal, 'handshake state lost');
            return;
        }
        if (process.env['DSH_MOBILE_SIG_DEBUG'] === '1') {
            console.log(`[sig] 认证前：宿主存储指纹=${String(handshake.storedFingerprint)}`);
        }
        // 密码学层的异常必须在此显式捕获：否则它会逃进 Promise 链，
        // 表现为"帧收到了、认证却没发生"，排障时毫无线索。
        let outcome;
        try {
            outcome = handshake.acceptClientAuth(auth);
        }
        catch (error) {
            console.error('[mobile-host] acceptClientAuth 抛出异常：', error);
            await this.fail(ErrorCode.HandshakeConfirm, `acceptClientAuth threw: ${error instanceof Error ? error.message : String(error)}`);
            return;
        }
        if (outcome.kind !== 'send') {
            await this.fail(outcome.kind === 'fail' ? outcome.code : ErrorCode.Internal, outcome.kind === 'fail' ? outcome.message : 'authentication failed');
            return;
        }
        const authOk = outcome.payload;
        // 顺序很关键：
        //  1) 先建立会话并在**发送任何会话帧之前**设好 sendKeys（否则 sealSessionFrame 取不到密钥）；
        //  2) ServerAuthOk 占用 counter=1 且不递增（它自身就是会话密钥的第一次使用）；
        //  3) 随后把 outCounter 定为 2，使第一个数据帧从 2 开始。
        // 客户端会同理把 counter=1 记入接收窗口。两端对这一"占位"必须一致，
        // 否则第一个数据帧会被对方判为重放。
        this.session = handshake.complete();
        this.sendKeys = this.session;
        this.outCounter = 1n;
        const frame = await this.sealSessionFrame(FrameType.ServerAuthOk, FrameFlags.Json | FrameFlags.Final, Buffer.from(JSON.stringify(authOk), 'utf8'), { advance: false });
        this.outCounter = 2n;
        this.state = 'established';
        this.delegate.onEstablished?.(this.session);
        const ok = await this.sink(frame);
        if (!ok)
            this.close('sink closed while sending ServerAuthOk');
    }
    /**
     * 用会话密钥封装一帧。
     * @param advance - 是否递增发出计数器（ServerAuthOk 需要手动控制占位，故传 false）。
     */
    async sealSessionFrame(type, flags, payload, options = {}) {
        const session = this.sendKeys;
        if (session === undefined)
            throw new Error('session keys are not available');
        const counter = this.outCounter;
        if (options.advance !== false)
            this.outCounter += 1n;
        const frame = sealFrame({
            key: session.keys.serverToClient,
            nonceBase: session.serverNonceBase,
            type,
            flags,
            counter,
            payload,
            truncateTag: true,
        });
        return frame.bytes;
    }
    /** 处理已解密的数据帧。 */
    async dispatch(type, plaintext) {
        switch (type) {
            case FrameType.Ping: {
                await this.sendFrame(FrameType.Pong, FrameFlags.None, Buffer.alloc(0));
                return;
            }
            case FrameType.Pong:
                return;
            case FrameType.RpcRequest: {
                const request = parseJson(plaintext);
                if (request === undefined) {
                    await this.sendError(ErrorCode.HandshakeMalformed, 'RpcRequest is not valid JSON');
                    return;
                }
                await this.handleRpc(request);
                return;
            }
            case FrameType.StreamOpen: {
                const request = parseJson(plaintext);
                if (request === undefined) {
                    await this.sendError(ErrorCode.HandshakeMalformed, 'StreamOpen is not valid JSON');
                    return;
                }
                this.startStream(request);
                return;
            }
            case FrameType.StreamCancel: {
                const cancel = parseJson(plaintext);
                if (cancel === undefined)
                    return;
                const stream = this.streams.get(cancel.streamId);
                if (stream === undefined)
                    return;
                this.streams.delete(cancel.streamId);
                stream.controller.abort(new Error('client cancelled the stream'));
                return;
            }
            case FrameType.LinkError: {
                this.close('client reported a link error');
                return;
            }
            default:
                // 客户端发来宿主方向专属的帧类型，属于协议误用
                await this.sendError(ErrorCode.HandshakeMalformed, `unexpected frame type ${type} from client`);
        }
    }
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
    async handleRpc(request) {
        const controller = new AbortController();
        try {
            const value = await this.delegate.invoke({ endpoint: request.method, payload: request.payload }, controller.signal);
            await this.sendFrame(FrameType.RpcResponse, FrameFlags.Json | FrameFlags.Final, Buffer.from(
            /**
             * ★ 第一阶段第 3 项：值里若有二进制（例如 workspaceFiles/readBytes 的字节），
             *   发出前先打标成 `{$dshmBytes: base64}` ✓，客户端解码后还原成 Uint8Array ✓。
             * ★ 只影响我们这条隧道（桌面端不走它）✓；对不认识标记的一端，
             *   行为与今天一样（本来就是 JSON 化）⇒ 不会更糟 ✓。
             * ★★ 2026-10-04 补记：这一个调用点**曾经漏掉过**（只有 import、没有调用 ✓），
             *   而"两端齐"是在契约断言（client-binary-sync.test.ts）加进来之后才被证伪的 ✗
             *   —— 那是"我说了但没做"，机器比人可靠 ✓。
             */
            JSON.stringify({
                type: 'server-response',
                rpcId: request.rpcId,
                /**
                 * ★★★ 隧道：`result` **就是 delegate 返回的那个信封** ✓（可能含 `attachments` ✓）。
                 *   不再套一层 `{ok:true,value}` ✗（"层数"错今天栽过多次 ✓）。
                 */
                result: encodeBinary(value),
            }), 'utf8'));
        }
        catch (error) {
            const wire = toWire(error);
            await this.sendFrame(FrameType.RpcResponse, FrameFlags.Json | FrameFlags.Final, Buffer.from(JSON.stringify({ type: 'server-response', rpcId: request.rpcId, result: { ok: false, error: wire } }), 'utf8'));
        }
    }
    startStream(request) {
        if (this.streams.has(request.streamId)) {
            void this.sendFrame(FrameType.StreamError, FrameFlags.Json | FrameFlags.Final, Buffer.from(JSON.stringify({ streamId: request.streamId, error: wireError(ErrorCode.HandshakeMalformed, `stream ${request.streamId} is already open`) }), 'utf8'));
            return;
        }
        const controller = new AbortController();
        this.streams.set(request.streamId, { controller });
        void this.pumpStream(request, controller);
    }
    async pumpStream(request, controller) {
        try {
            const source = this.delegate.openStream({ endpoint: request.endpoint, payload: request.payload }, controller.signal);
            for await (const value of source) {
                if (controller.signal.aborted)
                    break;
                await this.sendFrame(FrameType.StreamItem, FrameFlags.Json, Buffer.from(JSON.stringify({ streamId: request.streamId, value: encodeBinary(value) }), 'utf8'));
            }
            if (!controller.signal.aborted) {
                await this.sendFrame(FrameType.StreamEnd, FrameFlags.Json | FrameFlags.Final, Buffer.from(JSON.stringify({ streamId: request.streamId }), 'utf8'));
            }
        }
        catch (error) {
            // 把失败原因打到 stderr：手机上"看不到历史/发不出消息"，而审计里只有一句 "failed"，
            // 排查时没有任何线索。这里保留完整错误（含 tool 抛出的原始文案）。
            console.error(`[mobile-host] 流 ${request.endpoint} 失败：`, error instanceof Error ? `${error.name}: ${error.message}` : String(error));
            if (!controller.signal.aborted) {
                await this.sendFrame(FrameType.StreamError, FrameFlags.Json | FrameFlags.Final, Buffer.from(JSON.stringify({ streamId: request.streamId, error: toWire(error) }), 'utf8'));
            }
        }
        finally {
            this.streams.delete(request.streamId);
        }
    }
    async sendError(code, message) {
        await this.sendFrame(FrameType.LinkError, FrameFlags.Json, Buffer.from(JSON.stringify(wireError(code, message)), 'utf8'));
    }
    /** 用会话密钥发送一帧（计数器自动递增）。 */
    async sendFrame(type, flags, payload) {
        if (this.sendKeys === undefined || this.state === 'closed')
            return;
        await this.sink(await this.sealSessionFrame(type, flags, payload));
    }
    /** 链路级失败：发 LinkError 后关闭连接。 */
    async fail(code, message) {
        this.failureInfo = { code, message };
        // 握手未完成时还没有会话密钥，只能发未加密的 LinkError（客户端按"明文可读的控制帧"处理）
        const session = this.sendKeys;
        if (session !== undefined) {
            await this.sendError(code, message);
        }
        else {
            // 握手未完成：用明文控制帧告知失败原因（客户端按 hasTag=false 解析）
            const payload = Buffer.from(JSON.stringify(wireError(code, message)), 'utf8');
            await this.sink(sealPlaintextFrame(FrameType.LinkError, FrameFlags.Json, payload));
        }
        this.close(`${code}: ${message}`);
    }
    /** 宿主身份（由宿主插件在构造后注入）。 */
    // 说明：这两个字段必须在 acceptHello 之前设置，因此用 public 可变字段而非构造参数，
    // 以便宿主插件在创建会话时先拿到握手所需身份。
    hostId = '';
    hostSigningKey;
}
/** 封装 ServerHello：`{e, sh}`，e 为明文临时公钥，sh 为 K_hs 保护的帧。 */
function sealServerHelloFrame(handshakeKey, serverHello) {
    const frame = sealFrame({
        key: handshakeKey,
        nonceBase: HANDSHAKE_NONCE_BASE,
        type: FrameType.ServerHello,
        flags: FrameFlags.Json,
        counter: 1n,
        payload: Buffer.from(JSON.stringify(serverHello), 'utf8'),
        truncateTag: false,
    });
    return { e: serverHello.ephemeralPublicKey, sh: frame.bytes.toString('base64url') };
}
function parseJson(buffer) {
    try {
        return JSON.parse(buffer.toString('utf8'));
    }
    catch {
        return undefined;
    }
}
/** 把任意异常转成可跨线的错误对象。 */
export function toWire(error) {
    if (typeof error === 'object' && error !== null) {
        const record = error;
        const code = typeof record.code === 'string' ? record.code : ErrorCode.Internal;
        const message = typeof record.message === 'string' ? record.message : String(error);
        const details = typeof record.details === 'object' && record.details !== null && !Array.isArray(record.details)
            ? record.details
            : undefined;
        // 与 wireError 同理：details 必须始终是对象（DSH 的客户端校验要求）
        return { code, message, details: details ?? {} };
    }
    return { code: ErrorCode.Internal, message: String(error), details: {} };
}
//# sourceMappingURL=tunnel.js.map