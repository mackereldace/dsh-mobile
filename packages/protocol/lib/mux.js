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
import { ErrorCode, STREAM_ID_MASK, wireError } from "./wire.js";
/** 单流未确认产出项上限（背压阈值）。 */
export const DEFAULT_STREAM_WINDOW = 64;
/** 同时打开的逻辑流上限。 */
export const DEFAULT_MAX_STREAMS = 32;
/**
 * 客户端侧 mux：把 `openStream` 调用变成逻辑流。
 *
 * 用法：`const stream = mux.open('session/history', payload, { signal })`，
 * 然后 `for await (const value of stream) { ... }`。
 */
export class ClientMux {
    endpoint;
    nextId = { value: 1 };
    active = new Map();
    closed = false;
    constructor(endpoint) {
        this.endpoint = endpoint;
    }
    /** 是否仍有活动流。 */
    get activeCount() {
        return this.active.size;
    }
    /** 打开一条逻辑流。 */
    open(endpoint, payload, options = {}) {
        if (this.closed)
            throw new Error('mux is closed');
        const streamId = options.streamId ?? this.nextId.value++;
        if (streamId > STREAM_ID_MASK)
            throw new Error('stream ids exhausted');
        if (this.active.has(streamId))
            throw new Error(`stream ${streamId} is already open`);
        const state = new ClientStreamState(streamId, options.signal);
        this.active.set(streamId, state);
        // 取消必须真正发到对端：否则宿主侧的上游迭代会泄漏（长轮询/文件观察会一直挂着）。
        state.cancelRequested = () => {
            if (!this.active.delete(streamId))
                return;
            this.endpoint.send({ type: 'cancel', streamId });
        };
        const sent = this.endpoint.send({ type: 'open', streamId, endpoint, payload });
        const handleClosed = (ok) => {
            if (ok)
                return;
            this.active.delete(streamId);
            state.fail(wireError(ErrorCode.Internal, 'tunnel is closed'));
        };
        if (typeof sent === 'boolean')
            handleClosed(sent);
        else
            void sent.then(handleClosed, () => handleClosed(false));
        return state.stream;
    }
    /** 处理来自宿主的 mux 消息。 */
    receive(message) {
        const state = this.active.get(message.streamId);
        if (state === undefined)
            return;
        switch (message.type) {
            case 'item':
                state.push(message.value);
                return;
            case 'end':
                this.active.delete(message.streamId);
                state.finish();
                return;
            case 'error':
                this.active.delete(message.streamId);
                state.fail(message.error);
                return;
            case 'open':
            case 'cancel':
                // 客户端不接收 open/cancel（方向不对称），忽略以防协议误用
                return;
        }
    }
    /** 通道断开：所有活动流以可重试的错误结束。 */
    close(reason = 'tunnel closed') {
        this.closed = true;
        for (const [id, state] of this.active) {
            this.active.delete(id);
            state.fail(wireError(ErrorCode.Internal, reason));
        }
    }
}
/** 单条客户端流的状态机。 */
class ClientStreamState {
    stream;
    queue = [];
    waiter;
    done = false;
    failure;
    externalSignal;
    constructor(streamId, externalSignal) {
        this.externalSignal = externalSignal;
        this.onExternalAbort = () => this.cancel('client aborted');
        externalSignal?.addEventListener('abort', this.onExternalAbort, { once: true });
        const self = this;
        this.stream = {
            streamId,
            cancel: (reason) => this.cancelRequested?.(reason ?? 'client cancelled'),
            [Symbol.asyncIterator]() {
                return {
                    async next() {
                        for (;;) {
                            if (self.queue.length > 0)
                                return { done: false, value: self.queue.shift() };
                            if (self.failure !== undefined) {
                                self.cleanup();
                                throw Object.assign(new Error(self.failure.message), { code: self.failure.code, details: self.failure.details });
                            }
                            if (self.done) {
                                self.cleanup();
                                return { done: true, value: undefined };
                            }
                            await new Promise((resolve) => {
                                self.waiter = resolve;
                            });
                        }
                    },
                    async return() {
                        self.cancelRequested?.('client stopped iterating');
                        self.cleanup();
                        return { done: true, value: undefined };
                    },
                };
            },
        };
    }
    /** 外部 AbortSignal 的监听器（需要稳定引用才能在 cleanup 时移除）。 */
    onExternalAbort;
    /** 由 Mux 注入的取消回调（实际发送 cancel 消息）。 */
    cancelRequested;
    cleanup() {
        this.externalSignal?.removeEventListener('abort', this.onExternalAbort);
    }
    cancel(reason) {
        this.cancelRequested?.(reason);
    }
    push(value) {
        if (this.done || this.failure !== undefined)
            return;
        this.queue.push(value);
        this.wake();
    }
    finish() {
        this.done = true;
        this.wake();
    }
    fail(error) {
        this.failure = error;
        this.wake();
    }
    wake() {
        const waiter = this.waiter;
        this.waiter = undefined;
        waiter?.();
    }
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
export class HostMux {
    endpoint;
    openSource;
    streams = new Map();
    /**
     * 已占用但尚未落到 streams 的流编号。
     * 必要性：open 消息的处理要 `await` 发送，期间同一个 streamId 可能被重复 open；
     * 若只查 streams 会漏判，导致两条逻辑流共用编号、产出项串流。
     */
    claimed = new Set();
    maxStreams;
    closed = false;
    constructor(endpoint, options) {
        this.endpoint = endpoint;
        this.maxStreams = options.maxStreams ?? DEFAULT_MAX_STREAMS;
        this.openSource = (request, signal) => options.open(request.endpoint, request.payload, signal);
    }
    /** 当前活动流数量。 */
    get activeCount() {
        return this.streams.size;
    }
    /** 处理来自客户端的 mux 消息。 */
    receive(message) {
        if (this.closed)
            return;
        switch (message.type) {
            case 'open': {
                const streamId = message.streamId;
                if (this.streams.has(streamId) || this.claimed.has(streamId)) {
                    void this.endpoint.send({
                        type: 'error',
                        streamId,
                        error: wireError(ErrorCode.HandshakeMalformed, `stream ${streamId} is already open`),
                    });
                    return;
                }
                // 同步占位，必须在任何 await 之前，否则并发 open 会撞编号
                this.claimed.add(streamId);
                void this.startStream({ streamId, endpoint: message.endpoint, payload: message.payload });
                return;
            }
            case 'cancel': {
                const state = this.streams.get(message.streamId);
                if (state === undefined)
                    return;
                state.cancelled = true;
                state.controller.abort(new Error('client cancelled the stream'));
                this.streams.delete(message.streamId);
                return;
            }
            case 'item':
            case 'end':
            case 'error':
                // 宿主不接收这些方向的消息
                return;
        }
    }
    /** 启动一条流。调用方必须已同步占位（claimed.add）。 */
    async startStream(request) {
        try {
            await this.runStream(request);
        }
        finally {
            this.claimed.delete(request.streamId);
        }
    }
    async runStream(request) {
        if (this.streams.size >= this.maxStreams) {
            await this.endpoint.send({
                type: 'error',
                streamId: request.streamId,
                error: wireError(ErrorCode.Backpressure, `too many active streams (limit ${this.maxStreams})`),
            });
            return;
        }
        const controller = new AbortController();
        const state = { request, controller, cancelled: false };
        this.streams.set(request.streamId, state);
        try {
            const source = this.openSource(request, controller.signal);
            for await (const value of source) {
                if (controller.signal.aborted)
                    break;
                // 背压：await 传输层的排空承诺，不造 mux 层自己的窗口。
                await this.endpoint.send({ type: 'item', streamId: request.streamId, value });
                if (controller.signal.aborted)
                    break;
            }
            if (!controller.signal.aborted)
                await this.endpoint.send({ type: 'end', streamId: request.streamId });
        }
        catch (error) {
            if (!controller.signal.aborted) {
                await this.endpoint.send({ type: 'error', streamId: request.streamId, error: toWireError(error) });
            }
        }
        finally {
            this.streams.delete(request.streamId);
        }
    }
    /** 通道断开：中止所有上游迭代，避免泄漏。 */
    close(reason = 'tunnel closed') {
        this.closed = true;
        for (const [id, state] of this.streams) {
            this.streams.delete(id);
            state.controller.abort(new Error(reason));
        }
        this.claimed.clear();
    }
}
/** 把任意异常转成可跨线的错误对象。 */
export function toWireError(error) {
    if (typeof error === 'object' && error !== null) {
        const record = error;
        const code = typeof record.code === 'string' ? record.code : ErrorCode.Internal;
        const message = typeof record.message === 'string' ? record.message : String(error);
        const details = typeof record.details === 'object' && record.details !== null && !Array.isArray(record.details)
            ? record.details
            : undefined;
        return details === undefined ? { code, message } : { code, message, details };
    }
    return { code: ErrorCode.Internal, message: String(error) };
}
/** 内存双工通道：无需真实 WebSocket 即可把两个 mux 对接（单测与嵌入场景用）。 */
export function createDuplexChannel() {
    let hostReceive;
    let clientReceive;
    return {
        hostEndpoint: {
            send: (message) => {
                queueMicrotask(() => clientReceive?.(message));
                return true;
            },
        },
        clientEndpoint: {
            send: (message) => {
                queueMicrotask(() => hostReceive?.(message));
                return true;
            },
        },
        bind(host, client) {
            hostReceive = host;
            clientReceive = client;
        },
    };
}
//# sourceMappingURL=mux.js.map