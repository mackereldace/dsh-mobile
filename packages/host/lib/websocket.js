/**
 * 最小 WebSocket 服务端实现（RFC6455 子集）。
 *
 * 为什么要自己写：M1 的隧道只需要文本/二进制帧与关闭帧，引入 `ws` 会给宿主插件增加
 * 一个需要随 DSH profile 一起安装的运行时依赖，而 profile 的 pnpm 安装对树外依赖更敏感。
 * 这里只实现协议必需的部分，并明确标注未支持的能力，避免"看起来支持其实不支持"。
 *
 * 支持：
 *  - 握手校验（Sec-WebSocket-Key → Accept）
 *  - 文本帧（0x1）、二进制帧（0x2）、关闭帧（0x8）、Ping（0x9）、Pong（0xA）
 *  - 客户端掩码解码、分片重组（continuation 帧）
 *  - 单帧与累计消息大小上限
 *
 * 不支持（M1 不需要，代码中显式拒绝而非静默忽略）：
 *  - permessage-deflate 压缩扩展
 *  - 服务端掩码（协议不允许）
 *  - 子协议协商
 */
import { createHash } from 'node:crypto';
/** WebSocket 操作码。 */
export const OpCode = {
    Continuation: 0x0,
    Text: 0x1,
    Binary: 0x2,
    Close: 0x8,
    Ping: 0x9,
    Pong: 0xa,
};
/**
 * 默认单条消息上限 40 MiB——必须**大于**隧道单帧上限（见 protocol 的 MAX_FRAME_BYTES）。
 *
 * 这条护栏若小于帧上限，它会先拦下大消息，排查时看到的却是另一个错误码，
 * 很容易误判成协议解析问题。两者要一起改。
 */
export const DEFAULT_MAX_MESSAGE_BYTES = 40 * 1024 * 1024;
/**
 * 完成 RFC6455 握手并接管已升级的 socket。
 * @param socket - 由 `server.on('upgrade')` 交出的原始 socket。
 * @param req - 同一个升级请求（用于取 Sec-WebSocket-Key）。
 * @param options - 上限与回调。
 * @returns 连接对象；握手非法时返回 undefined（调用方应直接 destroy socket）。
 */
export function acceptWebSocket(socket, req, options = {}) {
    const key = req.headers['sec-websocket-key'];
    if (typeof key !== 'string' || key.length === 0)
        return undefined;
    const version = req.headers['sec-websocket-version'];
    if (version !== undefined && version !== '13')
        return undefined;
    // 扩展协商：本实现支持零个扩展，因此**不在 101 响应里回任何 Sec-WebSocket-Extensions**。
    // 按 RFC6455 §9.1，这就是"拒绝该扩展但继续握手"，对端随即按未压缩通信。
    //
    // 这里曾经对任何 sec-websocket-extensions 都回 400 关闭连接，后果是：
    // curl（不发该头）能连上，而 Node/undici 的内置 WebSocket 与多数浏览器
    // （默认请求 permessage-deflate）全部连不上，客户端只看到 code=1006，
    // 极易被误判为网络或路径问题。**绝不能因为对端请求扩展就拒绝连接。**
    const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`);
    return new MinimalWebSocket(socket, options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES);
}
/** 实现主体。 */
class MinimalWebSocket {
    socket;
    maxMessageBytes;
    buffer = Buffer.alloc(0);
    fragments = [];
    fragmentOpcode;
    messageHandler;
    closeHandlers = [];
    errorHandler;
    _state = 'open';
    closeEmitted = false;
    constructor(socket, maxMessageBytes) {
        this.socket = socket;
        this.maxMessageBytes = maxMessageBytes;
        socket.on('data', (chunk) => this.ingest(chunk));
        socket.on('error', (error) => {
            this.errorHandler?.(error);
            this.finish();
        });
        socket.on('close', () => this.finish());
        socket.on('end', () => this.finish());
    }
    get state() {
        return this._state;
    }
    send(bytes) {
        if (this._state !== 'open')
            return false;
        const payload = Buffer.from(bytes);
        const header = encodeFrameHeader(OpCode.Binary, payload.length);
        return this.socket.write(Buffer.concat([header, payload]));
    }
    close(code = 1000, reason = '') {
        if (this._state !== 'open')
            return;
        this._state = 'closing';
        const reasonBytes = Buffer.from(reason, 'utf8');
        const payload = Buffer.alloc(2 + reasonBytes.length);
        payload.writeUInt16BE(code, 0);
        reasonBytes.copy(payload, 2);
        try {
            this.socket.write(Buffer.concat([encodeFrameHeader(OpCode.Close, payload.length), payload]));
        }
        catch {
            // 对端已断开时 write 可能抛错，忽略：下面统一销毁
        }
        this.socket.end();
        this.finish();
    }
    onMessage(handler) {
        this.messageHandler = handler;
    }
    onClose(handler) {
        if (this.closeEmitted) {
            handler();
            return;
        }
        this.closeHandlers.push(handler);
    }
    onError(handler) {
        this.errorHandler = handler;
    }
    finish() {
        if (this.closeEmitted)
            return;
        this.closeEmitted = true;
        this._state = 'closed';
        const handlers = this.closeHandlers;
        this.closeHandlers = [];
        for (const handler of handlers) {
            try {
                handler();
            }
            catch {
                // 关闭回调不得影响连接清理
            }
        }
    }
    /**
     * 增量解析：把已到达的字节追加到缓冲区并尽可能多地消费完整帧。
     *
     * 注意：解析或投递中的任何异常都必须在这里被收住。这个方法运行在 socket 的 'data'
     * 事件里，异常逃逸会变成未捕获异常——在生产中等于让畸形帧把宿主进程打崩。
     * 因此统一转成协议错误并关闭连接。
     */
    ingest(chunk) {
        this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
        try {
            for (;;) {
                // 把上限传进解码器：声明长度超限的帧必须在 `ingest` 拼缓冲之前就被拒绝。
                const frame = tryDecodeFrame(this.buffer, this.maxMessageBytes);
                if (frame === undefined) {
                    return;
                }
                this.buffer = this.buffer.subarray(frame.consumed);
                this.deliver(frame);
                if (this._state === 'closed')
                    return;
            }
        }
        catch (error) {
            this.protocolError(error instanceof Error ? error.message : String(error));
            return;
        }
    }
    deliver(frame) {
        switch (frame.opcode) {
            case OpCode.Ping:
                this.writeControl(OpCode.Pong, frame.payload);
                return;
            case OpCode.Pong:
                return;
            case OpCode.Close:
                this._state = 'closing';
                this.writeControl(OpCode.Close, frame.payload.subarray(0, 2));
                this.socket.end();
                this.finish();
                return;
            case OpCode.Text:
            case OpCode.Binary: {
                if (frame.fin) {
                    if (frame.payload.length > this.maxMessageBytes) {
                        this.protocolError('message too large');
                        return;
                    }
                    this.invokeHandler(frame.payload);
                    return;
                }
                this.fragmentOpcode = frame.opcode;
                this.fragments = [frame.payload];
                return;
            }
            case OpCode.Continuation: {
                if (this.fragmentOpcode === undefined) {
                    this.protocolError('continuation frame without an initial frame');
                    return;
                }
                this.fragments.push(frame.payload);
                const total = this.fragments.reduce((sum, part) => sum + part.length, 0);
                if (total > this.maxMessageBytes) {
                    this.protocolError('fragmented message too large');
                    return;
                }
                if (frame.fin) {
                    const message = Buffer.concat(this.fragments);
                    this.fragments = [];
                    this.fragmentOpcode = undefined;
                    this.invokeHandler(message);
                }
                return;
            }
            default:
                this.protocolError(`unsupported opcode ${frame.opcode}`);
        }
    }
    /** 调用消息处理器并隔离其异常：处理器的 bug 不应表现为连接层崩溃。 */
    invokeHandler(payload) {
        try {
            this.messageHandler?.(payload);
        }
        catch (error) {
            // 处理器异常绝不能静默：它是同步抛出时唯一会被丢掉的东西
            // （异步路径有各自的 catch），排障时若看不到它，会误判为"帧没送到"。
            console.error('[mobile-host] WebSocket 消息处理器抛出异常：', error);
            this.errorHandler?.(error instanceof Error ? error : new Error(String(error)));
        }
    }
    writeControl(opcode, payload) {
        if (this._state === 'closed')
            return;
        try {
            this.socket.write(Buffer.concat([encodeFrameHeader(opcode, payload.length), payload]));
        }
        catch {
            // 忽略：连接即将关闭
        }
    }
    /** 协议错误：按 RFC 要求关闭连接（1002）。 */
    protocolError(reason) {
        this.errorHandler?.(new Error(`websocket protocol error: ${reason}`));
        this.close(1002, reason);
    }
}
/**
 * 尝试从缓冲区解码一帧；数据不足时返回 undefined（等待更多字节）。
 * 导出以便单测直接验证解析逻辑。
 *
 * @param buffer - 已到达的字节。
 * @param maxBytes - 单帧声明长度的上限（通常传 `maxMessageBytes`）。**在等待剩余字节之前**就先比对，
 *   否则一个"声明 4 GiB 却慢慢发"的帧会让 `ingest` 的缓冲区无限拼接（见下方注释）。
 */
export function tryDecodeFrame(buffer, maxBytes) {
    if (buffer.length < 2)
        return undefined;
    const first = buffer.readUInt8(0);
    const second = buffer.readUInt8(1);
    const fin = (first & 0x80) !== 0;
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    let length = second & 0x7f;
    let offset = 2;
    if (length === 126) {
        if (buffer.length < offset + 2)
            return undefined;
        length = buffer.readUInt16BE(offset);
        offset += 2;
    }
    else if (length === 127) {
        if (buffer.length < offset + 8)
            return undefined;
        const big = buffer.readBigUInt64BE(offset);
        if (big > BigInt(Number.MAX_SAFE_INTEGER))
            throw new Error('websocket frame length overflows');
        length = Number(big);
        offset += 8;
    }
    // ★ 预检：**先读声明长度、先比上限**，然后才去等 / 分配载荷缓冲。
    // 修复前这里没有任何上限比对，`ingest` 会在 `buffer.length < offset + length` 处一直
    // `Buffer.concat` 等下去——对端只要声明 40 MiB 以上（甚至逼近 MAX_SAFE_INTEGER）再慢慢发，
    // 就能把宿主内存拖大。单帧长度本身就不可能超过单条消息上限，所以在这里拒绝不误伤正常帧。
    if (maxBytes !== undefined && length > maxBytes) {
        throw new Error(`websocket frame length ${length} exceeds limit ${maxBytes}`);
    }
    // 控制帧必须 ≤125 字节且不可分片（RFC6455 §5.5）
    if (opcode >= 0x8 && (length > 125 || !fin))
        throw new Error('invalid websocket control frame');
    let mask;
    if (masked) {
        if (buffer.length < offset + 4)
            return undefined;
        mask = buffer.subarray(offset, offset + 4);
        offset += 4;
    }
    if (buffer.length < offset + length)
        return undefined;
    const raw = buffer.subarray(offset, offset + length);
    const payload = mask === undefined ? Buffer.from(raw) : applyMask(raw, mask);
    return { fin, opcode, payload, consumed: offset + length };
}
function applyMask(payload, mask) {
    const out = Buffer.allocUnsafe(payload.length);
    for (let i = 0; i < payload.length; i++)
        out[i] = payload[i] ^ mask[i & 3];
    return out;
}
/** 编码服务端帧头（服务端不掩码）。 */
export function encodeFrameHeader(opcode, length) {
    if (length < 126) {
        return Buffer.from([0x80 | opcode, length]);
    }
    if (length < 65536) {
        const header = Buffer.alloc(4);
        header.writeUInt8(0x80 | opcode, 0);
        header.writeUInt8(126, 1);
        header.writeUInt16BE(length, 2);
        return header;
    }
    const header = Buffer.alloc(10);
    header.writeUInt8(0x80 | opcode, 0);
    header.writeUInt8(127, 1);
    header.writeBigUInt64BE(BigInt(length), 2);
    return header;
}
//# sourceMappingURL=websocket.js.map