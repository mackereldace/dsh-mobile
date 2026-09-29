/**
 * 逻辑流多路复用（/api/remote.mux 的等价实现）。
 *
 * DSH 的 Gateway 流协议是 WebSocket 上的极简 JSON mux：
 *   客户端 → 宿主： {type:'open', streamId, endpoint, payload} | {type:'cancel', streamId}
 *   宿主 → 客户端： {type:'item', streamId, value?} | {type:'error', streamId, error} | {type:'end', streamId}
 *
 * 本模块在**隧道之上**重建同一套语义，使 `__DSH_TRANSPORT__.openStream` 能直接对接
 * `ctx.remote.*` 的全部流式方法（会话历史、工作区投影、文件变更观察等），无需改动 DSH。
 *
 * 设计要点：
 *  - 与传输无关：`MuxEndpoint` 只暴露 send/事件，便于用内存管道做单测。
 *  - 有界背压：单流未确认窗口与并发流数都有上限，超限返回背压错误而不是无限缓冲。
 *  - 取消传播：客户端 cancel 与 AbortSignal 都会通知对端终止上游迭代。
 *  - 帧/流编号由发起方分配，响应必须回带同一编号，编号复用前必须已结束。
 */
import { type WireError } from './wire.ts';
/** 单流未确认产出项上限（背压阈值）。 */
export declare const DEFAULT_STREAM_WINDOW = 64;
/** 同时打开的逻辑流上限。 */
export declare const DEFAULT_MAX_STREAMS = 32;
/** 一条流在宿主侧的产出源。 */
export type StreamSource = (signal: AbortSignal) => AsyncIterable<unknown>;
/** 客户端侧打开流的选项。 */
export interface OpenStreamOptions {
    readonly signal?: AbortSignal;
    /** 客户端分配的逻辑流编号；省略时自动分配。 */
    readonly streamId?: number;
}
/** 宿主侧收到的打开请求。 */
export interface HostStreamRequest {
    readonly streamId: number;
    readonly endpoint: string;
    readonly payload: unknown;
}
/**
 * 多路复用对端（宿主侧与客户端侧共用同一份实现，行为对称）。
 *
 * `send` 返回一个可在需要时等待的排空承诺：发送方必须 `await` 它，
 * 背压就自然由底层传输（WebSocket 写缓冲）承担，mux 层不需要自己造流控窗口。
 * 若实现方不需要背压（如内存通道），直接返回 `true` 即可。
 */
export interface MuxEndpoint {
    /** 发送一条 mux 消息给对端。false 表示通道已关闭；Promise 表示需要等待排空。 */
    send(message: MuxMessage): boolean | Promise<boolean>;
}
/** 线上 mux 消息（与 DSH Gateway 的 JSON 结构保持一致）。 */
export type MuxMessage = {
    readonly type: 'open';
    readonly streamId: number;
    readonly endpoint: string;
    readonly payload: unknown;
} | {
    readonly type: 'cancel';
    readonly streamId: number;
} | {
    readonly type: 'item';
    readonly streamId: number;
    readonly value?: unknown;
} | {
    readonly type: 'error';
    readonly streamId: number;
    readonly error: WireError;
} | {
    readonly type: 'end';
    readonly streamId: number;
};
/** 打开一个逻辑流的结果。 */
export interface MuxStream extends AsyncIterable<unknown> {
    readonly streamId: number;
    /** 客户端主动取消。幂等。 */
    cancel(reason?: string): void;
}
/**
 * 客户端侧 mux：把 `openStream` 调用变成逻辑流。
 *
 * 用法：`const stream = mux.open('session/history', payload, { signal })`，
 * 然后 `for await (const value of stream) { ... }`。
 */
export declare class ClientMux {
    private readonly endpoint;
    private readonly nextId;
    private readonly active;
    private closed;
    constructor(endpoint: MuxEndpoint);
    /** 是否仍有活动流。 */
    get activeCount(): number;
    /** 打开一条逻辑流。 */
    open(endpoint: string, payload: unknown, options?: OpenStreamOptions): MuxStream;
    /** 处理来自宿主的 mux 消息。 */
    receive(message: MuxMessage): void;
    /** 通道断开：所有活动流以可重试的错误结束。 */
    close(reason?: string): void;
}
/**
 * 宿主侧 mux：把逻辑流请求接到真正的产出源上。
 *
 * 用法：
 * ```ts
 * const mux = new HostMux(endpoint, {
 *   open: (endpoint, payload, signal) => dispatcher.open(endpoint, payload, signal),
 * })
 * mux.receive(message)
 * ```
 */
export declare class HostMux {
    private readonly endpoint;
    private readonly openSource;
    private readonly streams;
    /**
     * 已占用但尚未落到 streams 的流编号。
     * 必要性：open 消息的处理要 `await` 发送，期间同一个 streamId 可能被重复 open；
     * 若只查 streams 会漏判，导致两条逻辑流共用编号、产出项串流。
     */
    private readonly claimed;
    private readonly maxStreams;
    private closed;
    constructor(endpoint: MuxEndpoint, options: {
        /** 按 endpoint 名字解析出真正的产出源。抛错会被转成 StreamError。 */
        readonly open: (endpoint: string, payload: unknown, signal: AbortSignal) => AsyncIterable<unknown>;
        readonly maxStreams?: number;
    });
    /** 当前活动流数量。 */
    get activeCount(): number;
    /** 处理来自客户端的 mux 消息。 */
    receive(message: MuxMessage): void;
    /** 启动一条流。调用方必须已同步占位（claimed.add）。 */
    private startStream;
    private runStream;
    /** 通道断开：中止所有上游迭代，避免泄漏。 */
    close(reason?: string): void;
}
/** 把任意异常转成可跨线的错误对象。 */
export declare function toWireError(error: unknown): WireError;
/** 内存双工通道：无需真实 WebSocket 即可把两个 mux 对接（单测与嵌入场景用）。 */
export declare function createDuplexChannel(): {
    readonly hostEndpoint: MuxEndpoint;
    readonly clientEndpoint: MuxEndpoint;
    bind(host: (message: MuxMessage) => void, client: (message: MuxMessage) => void): void;
};
//# sourceMappingURL=mux.d.ts.map