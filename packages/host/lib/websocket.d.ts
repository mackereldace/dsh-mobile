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
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
/** WebSocket 操作码。 */
export declare const OpCode: {
    readonly Continuation: 0;
    readonly Text: 1;
    readonly Binary: 2;
    readonly Close: 8;
    readonly Ping: 9;
    readonly Pong: 10;
};
/**
 * 默认单条消息上限 40 MiB——必须**大于**隧道单帧上限（见 protocol 的 MAX_FRAME_BYTES）。
 *
 * 这条护栏若小于帧上限，它会先拦下大消息，排查时看到的却是另一个错误码，
 * 很容易误判成协议解析问题。两者要一起改。
 */
export declare const DEFAULT_MAX_MESSAGE_BYTES: number;
/** 连接状态。 */
export type SocketState = 'open' | 'closing' | 'closed';
/** WebSocket 连接的门面。 */
export interface WebSocketConnection {
    readonly state: SocketState;
    /** 发送一个二进制帧。返回 false 表示连接已关闭。 */
    send(bytes: Uint8Array): boolean;
    /** 主动关闭（发送关闭帧后销毁 socket）。 */
    close(code?: number, reason?: string): void;
    /** 注册消息处理器（收到完整的一条消息时调用）。 */
    onMessage(handler: (data: Buffer) => void): void;
    /** 注册关闭处理器（幂等，只会调用一次）。 */
    onClose(handler: () => void): void;
    /** 注册错误处理器。 */
    onError(handler: (error: Error) => void): void;
}
/**
 * 完成 RFC6455 握手并接管已升级的 socket。
 * @param socket - 由 `server.on('upgrade')` 交出的原始 socket。
 * @param req - 同一个升级请求（用于取 Sec-WebSocket-Key）。
 * @param options - 上限与回调。
 * @returns 连接对象；握手非法时返回 undefined（调用方应直接 destroy socket）。
 */
export declare function acceptWebSocket(socket: Duplex, req: IncomingMessage, options?: {
    readonly maxMessageBytes?: number;
}): WebSocketConnection | undefined;
/** 已解码的一帧。 */
export interface DecodedFrame {
    readonly fin: boolean;
    readonly opcode: number;
    readonly payload: Buffer;
    /** 本帧占用的总字节数（含头与掩码）。 */
    readonly consumed: number;
}
/**
 * 尝试从缓冲区解码一帧；数据不足时返回 undefined（等待更多字节）。
 * 导出以便单测直接验证解析逻辑。
 */
export declare function tryDecodeFrame(buffer: Buffer): DecodedFrame | undefined;
/** 编码服务端帧头（服务端不掩码）。 */
export declare function encodeFrameHeader(opcode: number, length: number): Buffer;
//# sourceMappingURL=websocket.d.ts.map